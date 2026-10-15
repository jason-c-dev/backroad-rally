// The car: a raycast vehicle on a Rapier rigid body (handoff §5, UE RallyCar).
//
// Axes are three.js metres, Y up; the car's local frame is +X forward, +Y up, +Z right. Readouts
// that the arcade layers and the tests use keep UE's sign conventions: steer, body slip and yaw
// rate are positive to the right, yaw is degrees with + turning right.
//
// Each physics step (fixed, 120 Hz): wheel rays and suspension, the driver's steering, drive and
// brake torques, tyre forces (a combined-slip friction circle, so wheelspin eats side grip), wheel
// spin integrated semi-implicitly, aero; then the world steps. The arcade layers (slice 3) plug in
// through `ArcadeLayer`.
import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { SURFACE_FRICTION, torqueShare, type ArcadeTuning, type AxleTuning, type CarTuning, type Surface } from './tuning';

export interface DriverInput {
  throttle: number;
  brake: number;
  /** -1 left .. 1 right */
  steer: number;
  /** Keyboard steering: the digital ramp (UE bDigitalSteer). */
  digitalSteer: boolean;
  handbrake: boolean;
}

export const noInput = (): DriverInput => ({ throttle: 0, brake: 0, steer: 0, digitalSteer: false, handbrake: false });

/** Surface under a wheel: from the collider (and triangle) the wheel ray hit. */
export type SurfaceQuery = (collider: RAPIER.Collider, featureId: number | undefined, point: Vector3) => Surface;

export interface WheelState {
  inContact: boolean;
  surface: Surface;
  contactPoint: Vector3;
  normal: Vector3;
  /** Suspension compression from the rest position (m, + = compressed). */
  compression: number;
  /** Spring + damper force along the suspension (N). */
  load: number;
  /** Angular velocity (rad/s, + = rolling forward) and accumulated angle for the mesh. */
  omega: number;
  angle: number;
  /** Contact-patch slip, UE units for the ported logic: cm/s. Lat + = sliding right. */
  latSlipCms: number;
  /** |omega| r - |v along|: + = wheelspin, - = locking. */
  longSlipCms: number;
  /** Tyre slip angle (deg). */
  slipAngleDeg: number;
  groundSpeedCms: number;
  /** Friction multiplier from the arcade layers (handbrake, power slide); 1 without them. */
  arcadeGrip: number;
}

/** Hooks the arcade layers (slice 3) provide; each runs at the point UE's RallyCar::Tick does. */
export interface ArcadeLayer {
  /** Handbrake, power slide and traction control: after body kinematics, before steering. */
  beforeSteering(v: Vehicle, dt: number): void;
  /** Steering assists on top of the driver's smoothed, lock-limited steer. Returns the applied steer. */
  assistSteer(v: Vehicle, steer: number): number;
  /** Per-wheel friction multiplier (handbrake / power slide). */
  wheelGrip(v: Vehicle, i: number): number;
  /** Turbo is core; arcade forces (yaw helpers, stability, drag, air control) after the tyres. */
  applyForces(v: Vehicle, dt: number): void;
  /** Auto recover and last good pose, after forces. */
  afterForces(v: Vehicle, dt: number): void;
}

const G = 9.81;
const DEG = Math.PI / 180;
const AIR_DENSITY = 1.225;
/**
 * Tyre and chassis constants, tuned against the testtrack.json bands (tools/test/handling.ts can
 * override them: --tyre key=value). UE's grip came from Chaos' tyre model; gripScale makes surface
 * friction x axle friction land on the measured UE numbers (tarmac ~1.1 g, gravel ~0.95 g).
 */
export const TYRE = {
  gripScale: 0.82,
  /** Longitudinal peak over the lateral one (traction and braking at the peak; a locked wheel slides at 1). */
  longPeak: 1,
  /**
   * Slip angle at the peak (deg), times (400 / cornering_stiffness)^corneringExponent. Chaos'
   * cornering stiffness doesn't carry over: any exponent above 0 made the low-stiffness AWD rears
   * oversteer at speed and planted the lama, the opposite of the UE cars. Passing range 5.0-6.0.
   */
  slipAnglePeakDeg: 5.5,
  corneringExponent: 0,
  /** Slip ratio at the peak. */
  slipRatioPeak: 0.12,
  /** Normalised slip past the peak over which the force falls to its sliding value. */
  slideFalloff: 2,
  slipRefSpeed: 3, // m/s: slip-ratio denominator floor (standstill)
  slipAngleRefSpeed: 1.5,
  rollingResistance: 0.012, // share of the load
  suspensionHz: 1.8, // natural frequency per corner; Chaos' spring rates don't map 1:1 (handoff §5.1)
  bumpStopRate: 8, // x the spring rate past full compression
  wheelInertia: 0.8, // kg m^2 per wheel (tyre + rim + hub + brake)
  engineInertia: 0.05, // kg m^2, reflected through the gearing to the driven wheels
  /** Chaos wheel traction control: drive torque cap over what the tyre passes on. */
  wheelTcMargin: 0.3,
  /** Slip ratio where the wheel traction control starts to take the margin back. */
  wheelTcSlip: 0.1,
};
const COM_BASE_HEIGHT = 0.62; // m above the ground: UE com_offset_cm z is relative to this
const BODY_CLEARANCE = 0.22; // chassis collider bottom above the ground at rest

export const ramp = (x: number, start: number, full: number) =>
  full > start ? Math.min(Math.max((x - start) / (full - start), 0), 1) : x >= start ? 1 : 0;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
/** UE FMath::FInterpConstantTo */
export function interpConstantTo(cur: number, target: number, dt: number, speed: number): number {
  const d = target - cur;
  const step = speed * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

interface WheelDef {
  key: 'fl' | 'fr' | 'rl' | 'rr';
  front: boolean;
  left: boolean;
  axle: AxleTuning;
  /** Local wheel centre at rest (three metres). */
  rest: Vector3;
  raise: number;
  drop: number;
  k: number;
  c: number;
  staticLoad: number;
  driven: boolean;
  /** Share of the drive torque this wheel gets. */
  driveShare: number;
}

export class Vehicle {
  readonly t: CarTuning;
  readonly body: RAPIER.RigidBody;
  readonly wheels: WheelState[] = [];
  readonly defs: WheelDef[] = [];
  input: DriverInput = noInput();
  arcade: ArcadeLayer | null = null;
  /** Arcade tuning in force (traction assist picks arcade or arcadeAssist). */
  a: ArcadeTuning;
  tractionAssist = true;
  /** Weather grip per surface (slice 8). */
  weatherGrip: Partial<Record<Surface, number>> = {};

  // drivetrain
  gear = 1;
  rpm = 0;
  shiftTimer = 0;
  private sinceShift = 10;
  turboBoost = 0;
  appliedMaxTorque: number;
  standstillBrakeTime = 0;

  // steering (UE UpdateSteering)
  smoothedSteer = 0;
  appliedSteer = 0;
  /** Front wheel angle (deg, + = right). */
  wheelAngleDeg = 0;

  // body kinematics (UE UpdateBodyKinematics), refreshed each step
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly velocity = new Vector3();
  readonly angularVelocity = new Vector3();
  readonly forward = new Vector3(1, 0, 0);
  readonly up = new Vector3(0, 1, 0);
  readonly right = new Vector3(0, 0, 1);
  forwardSpeed = 0; // m/s along the nose
  bodySlipDeg = 0;
  yawRateDeg = 0; // UE sign: + = turning right
  wheelsInContact = 0;
  airTime = 0;

  // arcade readouts (set by the arcade layers; zero without them)
  powerSlide = 0;
  powerStrength = 0;
  powerUnder = 0;
  rearSpinCms = 0;
  frontSpinCms = 0;
  tcScale = 1;
  handbrakeEngage = 0;

  private world: RAPIER.World;
  private rapier: typeof RAPIER;
  private surfaceAt: SurfaceQuery;
  private prevCompression = [0, 0, 0, 0];
  private hadContact = [false, false, false, false];
  private comLocal = new Vector3();

  constructor(rapier: typeof RAPIER, world: RAPIER.World, tuning: CarTuning, surfaceAt: SurfaceQuery,
    wheelPosCm: Record<'fl' | 'fr' | 'rl' | 'rr', [number, number, number]>) {
    this.rapier = rapier;
    this.world = world;
    this.t = tuning;
    this.surfaceAt = surfaceAt;
    this.a = tuning.arcadeAssist;
    this.appliedMaxTorque = tuning.maxTorqueNm;
    const t = tuning;

    // centre of mass and corner loads
    this.comLocal.set(t.comOffsetCm[0] / 100, COM_BASE_HEIGHT + t.comOffsetCm[2] / 100, t.comOffsetCm[1] / 100);
    const xf = wheelPosCm.fl[0] / 100;
    const xr = wheelPosCm.rl[0] / 100;
    const frontShare = clamp((this.comLocal.x - xr) / (xf - xr), 0.2, 0.8);

    const nDriven = t.drivetrain === 'AWD' ? 4 : 2;
    for (const key of ['fl', 'fr', 'rl', 'rr'] as const) {
      const front = key[0] === 'f';
      const axle = front ? t.front : t.rear;
      const p = wheelPosCm[key];
      const corner = (t.massKg * (front ? frontShare : 1 - frontShare)) / 2;
      const k = corner * (2 * Math.PI * TYRE.suspensionHz) ** 2;
      const driven = t.drivetrain === 'AWD' || (t.drivetrain === 'FWD') === front;
      const driveShare = !driven ? 0 : nDriven === 2 ? 0.5 : (front ? 1 - t.frontRearSplit : t.frontRearSplit) / 2;
      this.defs.push({
        key, front, left: key[1] === 'l', axle,
        rest: new Vector3(p[0] / 100, t.wheelRadius, p[1] / 100),
        raise: axle.susp_max_raise_cm / 100,
        drop: axle.susp_max_drop_cm / 100,
        k,
        c: 2 * axle.damping_ratio * Math.sqrt(k * corner),
        staticLoad: corner * G,
        driven,
        driveShare,
      });
      this.wheels.push({
        inContact: false, surface: 'none', contactPoint: new Vector3(), normal: new Vector3(0, 1, 0),
        compression: 0, load: 0, omega: 0, angle: 0, latSlipCms: 0, longSlipCms: 0, slipAngleDeg: 0,
        groundSpeedCms: 0, arcadeGrip: 1,
      });
    }

    // body: chassis box collider (mass from the tuning, not the box), inertia from the car's envelope
    const desc = rapier.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true);
    this.body = world.createRigidBody(desc);
    const h = t.height - BODY_CLEARANCE;
    const col = rapier.ColliderDesc.cuboid(t.length / 2 * 0.95, h / 2 * 0.9, t.width / 2 * 0.95)
      .setTranslation(0, BODY_CLEARANCE + h / 2, 0)
      .setDensity(0)
      .setFriction(0.4)
      .setRestitution(0.1);
    world.createCollider(col, this.body);
    const m = t.massKg;
    const [sRoll, sPitch, sYaw] = t.inertiaScale;
    const L = t.length * 0.9, W = t.width * 0.9, H = t.height * 0.8;
    const inertia = { x: (m / 12) * (H * H + W * W) * sRoll, y: (m / 12) * (L * L + W * W) * sYaw, z: (m / 12) * (L * L + H * H) * sPitch };
    this.body.setAdditionalMassProperties(m, this.comLocal, inertia, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setAngularDamping(this.a.ground_angular_damping);
    this.body.setLinearDamping(0);
  }

  setTractionAssist(on: boolean): void {
    this.tractionAssist = on;
    this.a = on ? this.t.arcadeAssist : this.t.arcade;
  }

  // ---------------------------------------------------------------- readouts (UE names)
  get speedKmh(): number {
    return this.velocity.length() * 3.6;
  }
  get forwardSpeedKmh(): number {
    return this.forwardSpeed * 3.6;
  }
  /** UE yaw (deg): + = turned right of +X. */
  get yawDeg(): number {
    return Math.atan2(this.forward.z, this.forward.x) / DEG;
  }
  get driven(): { front: boolean; rear: boolean } {
    return { front: this.t.drivetrain !== 'RWD', rear: this.t.drivetrain !== 'FWD' };
  }

  /** Speed-sensitive steering lock (share of max angle). */
  steerLockScale(kmh: number): number {
    const s = this.t.steering;
    if (s.lock_half_kmh > 0) {
      const x = kmh / s.lock_half_kmh;
      return s.high_speed_ratio + (1 - s.high_speed_ratio) / (1 + x * x);
    }
    return lerp(1, s.high_speed_ratio, clamp(kmh / Math.max(1, s.high_speed_kmh), 0, 1));
  }

  // ---------------------------------------------------------------- placement
  /** Place the car stopped, wheels at rest, at a three position with a UE yaw (deg). */
  teleport(pos: Vector3, yawDeg: number): void {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -yawDeg * DEG);
    this.body.setTranslation(pos, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) w.omega = 0;
    this.hadContact.fill(false);
    this.smoothedSteer = this.appliedSteer = 0;
    this.gear = 1;
    this.shiftTimer = 0;
    this.standstillBrakeTime = 0;
    this.turboBoost = 0;
    this.readBody();
  }

  /** Set the body velocity along the nose (tests launch the car at speed) and spin the wheels to match. */
  launch(speedMs: number): void {
    this.readBody();
    const v = this.forward.clone().multiplyScalar(speedMs);
    this.body.setLinvel(v, true);
    for (const w of this.wheels) w.omega = speedMs / this.t.wheelRadius;
    this.readBody();
  }

  // ---------------------------------------------------------------- step
  /** Everything before the world steps. */
  step(dt: number): void {
    this.readBody();
    this.updateWheels(dt);
    if (this.gear > 0) this.lastDriveGear = this.gear;
    this.arcade?.beforeSteering(this, dt);
    this.updateSteering(dt);
    const { throttle, brake, handbrake } = this.standstillBrake(dt);
    this.updateGearbox(dt, throttle, brake);
    this.updateTurbo(dt);
    this.applyWheelForces(dt, throttle, brake, handbrake);
    this.applyAero();
    this.airTime = this.wheelsInContact === 0 ? this.airTime + dt : 0;
    this.arcade?.applyForces(this, dt);
    this.arcade?.afterForces(this, dt);
  }

  lastDriveGear = 1;

  readBody(): void {
    const tr = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.position.set(tr.x, tr.y, tr.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(lv.x, lv.y, lv.z);
    this.angularVelocity.set(av.x, av.y, av.z);
    this.forward.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.right.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.forwardSpeed = this.velocity.dot(this.forward);
    const lat = this.velocity.dot(this.right);
    this.bodySlipDeg = Math.abs(this.forwardSpeed) > 0.5 || Math.abs(lat) > 0.5
      ? Math.atan2(lat, Math.abs(this.forwardSpeed)) / DEG : 0;
    // three: + rotation about up turns left; UE + yaw rate turns right
    this.yawRateDeg = -this.angularVelocity.dot(this.up) / DEG;
  }

  private tmp = new Vector3();
  private tmp2 = new Vector3();

  /** World velocity of a world point on the body. */
  pointVelocity(p: Vector3, out = new Vector3()): Vector3 {
    const com = this.body.worldCom();
    this.tmp.set(p.x - com.x, p.y - com.y, p.z - com.z);
    return out.copy(this.angularVelocity).cross(this.tmp).add(this.velocity);
  }

  private updateWheels(dt: number): void {
    const R = this.t.wheelRadius;
    const down = this.tmp2.copy(this.up).negate();
    this.wheelsInContact = 0;
    for (let i = 0; i < 4; i++) {
      const d = this.defs[i];
      const w = this.wheels[i];
      // ray from the wheel centre at full compression, down the suspension axis
      const top = new Vector3().copy(d.rest).addScaledVector(new Vector3(0, 1, 0), d.raise)
        .applyQuaternion(this.quaternion).add(this.position);
      const len = d.raise + d.drop + R;
      const ray = new this.rapier.Ray(top, down);
      const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, this.body);
      if (!hit) {
        w.inContact = false;
        w.surface = 'none';
        w.compression = -d.drop;
        w.load = 0;
        this.hadContact[i] = false;
        continue;
      }
      const e = hit.timeOfImpact - R; // travel down from full compression
      w.inContact = true;
      w.compression = d.raise - e;
      w.contactPoint.copy(top).addScaledVector(down, hit.timeOfImpact);
      w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      w.surface = this.surfaceAt(hit.collider, (hit as { featureId?: number }).featureId, w.contactPoint);
      this.wheelsInContact++;
    }
    // springs, dampers, rollbars
    for (let i = 0; i < 4; i++) {
      const d = this.defs[i];
      const w = this.wheels[i];
      if (!w.inContact) continue;
      const prev = this.hadContact[i] ? this.prevCompression[i] : w.compression;
      const vel = (w.compression - prev) / dt;
      let f = d.staticLoad + d.k * w.compression + d.c * vel;
      if (w.compression > d.raise) f += d.k * TYRE.bumpStopRate * (w.compression - d.raise);
      const other = this.wheels[i ^ 1];
      if (other.inContact) f += d.axle.rollbar_scaling * d.k * (w.compression - other.compression);
      w.load = Math.max(0, f);
      this.prevCompression[i] = w.compression;
      this.hadContact[i] = true;
    }
  }

  /** UE UpdateSteering: rate-limited driver steer, speed-sensitive lock, then the assists. */
  private updateSteering(dt: number): void {
    const t = this.t;
    const s = t.steering;
    const a = this.a;
    const kmh = this.speedKmh;
    const In = this.input;
    let target = clamp(In.steer, -1, 1);
    if (!In.digitalSteer && s.analog_exponent !== 1) target = Math.sign(target) * Math.abs(target) ** s.analog_exponent;
    let rateScale = 1;
    if (In.digitalSteer && a.digital_soft_full_kmh > 0) {
      const w = ramp(kmh, a.digital_soft_start_kmh, a.digital_soft_full_kmh);
      target *= lerp(1, a.digital_max_high_speed, w);
      rateScale = lerp(1, a.digital_rate_high_speed, w);
    }
    const returning = Math.abs(target) < Math.abs(this.smoothedSteer) || target * this.smoothedSteer < 0;
    const rate = In.digitalSteer
      ? (returning ? s.return_rate_digital : s.rate_digital * rateScale)
      : (returning ? s.return_rate : s.rate);
    this.smoothedSteer = interpConstantTo(this.smoothedSteer, target, dt, rate);

    // less lock at speed; while sliding, counter-steer may open up to the slip angle (+ headroom)
    let limit = this.steerLockScale(kmh);
    if (this.smoothedSteer * this.bodySlipDeg > 0 && s.max_angle_deg > 1 && this.wheelsInContact >= 2) {
      limit = Math.max(limit, Math.min(1, (Math.abs(this.bodySlipDeg) + s.countersteer_headroom_deg) / s.max_angle_deg));
    }
    let steer = this.smoothedSteer * limit;
    if (this.arcade) steer = this.arcade.assistSteer(this, steer);
    this.appliedSteer = clamp(steer + this.damageSteerPull, -1, 1);
    this.wheelAngleDeg = this.appliedSteer * s.max_angle_deg;
  }

  damageSteerPull = 0;
  damageTorqueScale = 1;

  /** Brake held at a standstill means reverse, after a short hold (UE Tick). */
  private standstillBrake(dt: number): { throttle: number; brake: number; handbrake: boolean } {
    const In = this.input;
    let throttle = In.throttle * this.tcScale; // traction control (1 unless the arcade layer cuts it)
    let brake = In.brake;
    let handbrake = In.handbrake;
    if (In.brake > 0 && In.throttle <= 0 && this.gear >= 0 && Math.abs(this.forwardSpeedKmh) < this.a.reverse_hold_kmh) {
      this.standstillBrakeTime += dt;
      if (this.standstillBrakeTime < this.a.reverse_delay_s) {
        brake = 0;
        handbrake = true;
      } else if (this.gear > 0) {
        this.gear = -1; // Chaos auto reverse
        this.shiftTimer = 0;
      }
    } else {
      this.standstillBrakeTime = 0;
    }
    // in reverse the pedals swap (Chaos bReverseAsBrake / bThrottleAsBrake)
    if (this.gear < 0) {
      if (In.throttle > 0 && this.forwardSpeedKmh > -this.a.reverse_hold_kmh) {
        this.gear = 1;
      } else {
        const b = brake;
        brake = throttle;
        throttle = b;
      }
    }
    return { throttle, brake, handbrake };
  }

  private drivenOmega(): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (this.defs[i].driven) {
        sum += this.wheels[i].omega;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  gearRatio(g = this.gear): number {
    return g > 0 ? this.t.gearRatios[g - 1] : g < 0 ? -this.t.reverseRatio : 0;
  }

  private updateGearbox(dt: number, _throttle: number, _brake: number): void {
    const t = this.t;
    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = this.gearRatio();
    const wheelRpm = (Math.abs(this.drivenOmega()) * 60) / (2 * Math.PI);
    this.rpm = Math.max(t.idleRpm, wheelRpm * Math.abs(ratio) * t.finalDrive);
    // shift on road speed, not on the driven wheels: wheelspin must not upshift out of a slide
    // (UE core-13), and a downshift must not land above the upshift point (no hunting)
    this.sinceShift += dt;
    if (this.gear > 0 && this.shiftTimer === 0 && this.wheelsInContact >= 2) {
      const roadRpm = (g: number) => ((Math.abs(this.forwardSpeed) / t.wheelRadius) * 60 / (2 * Math.PI)) * t.gearRatios[g - 1] * t.finalDrive;
      const norm = roadRpm(this.gear) / t.maxRpm;
      if (norm > t.shiftUpRpmNorm && this.gear < t.gearRatios.length) {
        this.gear++;
        this.shiftTimer = t.shiftTime;
        this.sinceShift = 0;
      } else if (norm < t.shiftDownRpmNorm && this.gear > 1 && this.sinceShift > 0.5
        && roadRpm(this.gear - 1) / t.maxRpm < t.shiftUpRpmNorm * 0.95) {
        this.gear--;
        this.shiftTimer = t.shiftTime;
        this.sinceShift = 0;
      }
    }
  }

  private updateTurbo(dt: number): void {
    const t = this.t;
    let torque = t.maxTorqueNm;
    if (t.turbo.enabled) {
      const target = this.input.throttle > 0.5 && this.rpm / t.maxRpm > t.turbo.min_rpm_norm ? 1 : 0;
      const tau = target > this.turboBoost ? t.turbo.lag_s : t.turbo.lag_s * 0.4;
      this.turboBoost += (target - this.turboBoost) * (1 - Math.exp(-dt / Math.max(0.01, tau)));
      torque = t.maxTorqueNm * (1 - t.turbo.share + t.turbo.share * this.turboBoost);
    }
    this.appliedMaxTorque = torque * this.damageTorqueScale;
  }

  /** Engine torque at the crank for this throttle (N m; < 0 = engine braking handled separately). */
  engineTorque(throttle: number): number {
    const t = this.t;
    if (this.shiftTimer > 0 || this.gear === 0 || throttle <= 0) return 0;
    if (this.rpm >= t.maxRpm) return 0; // limiter
    return throttle * torqueShare(t, this.rpm / t.maxRpm) * this.appliedMaxTorque;
  }

  /** Friction coefficient for wheel i on its surface, before the arcade multipliers. */
  surfaceGrip(i: number): number {
    const w = this.wheels[i];
    const s = this.t.surfaces[w.surface];
    return SURFACE_FRICTION[w.surface] * this.defs[i].axle.friction * (s?.grip_scale ?? 1)
      * (this.weatherGrip[w.surface] ?? 1) * TYRE.gripScale;
  }

  private fx = new Vector3();
  private fwdW = new Vector3();
  private rightW = new Vector3();
  private centre = new Vector3();
  private pv = new Vector3();

  private applyWheelForces(dt: number, throttle: number, brake: number, handbrake: boolean): void {
    const t = this.t;
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);
    const R = t.wheelRadius;
    const ratio = this.gearRatio();
    const crank = this.engineTorque(throttle);
    const reflected = TYRE.engineInertia * (ratio * t.finalDrive) ** 2;
    const engineBraking = throttle <= 0.02 && this.gear !== 0 && this.shiftTimer === 0;
    const steerRad = this.wheelAngleDeg * DEG;
    const cs = Math.cos(steerRad), sn = Math.sin(steerRad);

    for (let i = 0; i < 4; i++) {
      const d = this.defs[i];
      const w = this.wheels[i];
      const inertia = TYRE.wheelInertia + (d.driven ? reflected * d.driveShare : 0);
      // torques on the wheel
      let driveT = d.driven ? crank * ratio * t.finalDrive * t.efficiency * d.driveShare : 0;
      // the limiter per driven wheel: with open differentials one spinning wheel would otherwise
      // run far past it while the engine reads the average
      if (driveT !== 0 && (Math.abs(w.omega) * Math.abs(ratio) * t.finalDrive * 60) / (2 * Math.PI) >= t.maxRpm) driveT = 0;
      let brakeT = brake * d.axle.brake_torque;
      if (handbrake && !d.front) brakeT += d.axle.handbrake_torque;
      if (engineBraking && d.driven) brakeT += t.engineBrake * this.rpm;
      if (w.inContact) brakeT += TYRE.rollingResistance * w.load * R;

      if (!w.inContact) {
        // free wheel: drive and brakes only
        let om = w.omega + (dt * driveT) / inertia;
        const db = (dt * brakeT) / inertia;
        om = Math.abs(om) <= db ? 0 : om - Math.sign(om) * db;
        w.omega = om;
        w.latSlipCms = w.longSlipCms = w.slipAngleDeg = w.groundSpeedCms = 0;
        w.angle += w.omega * dt;
        continue;
      }

      // contact frame: the wheel's heading projected on the ground
      const n = w.normal;
      const fwdLocal = d.front ? this.tmp.set(cs, 0, sn) : this.tmp.set(1, 0, 0);
      this.fwdW.copy(fwdLocal).applyQuaternion(this.quaternion);
      this.fwdW.addScaledVector(n, -this.fwdW.dot(n)).normalize();
      this.rightW.copy(this.fwdW).cross(n).normalize();
      this.centre.copy(w.contactPoint).addScaledVector(n, R);
      const v = this.pointVelocity(this.centre, this.pv);
      const vLong = v.dot(this.fwdW);
      const vLat = v.dot(this.rightW);

      const mu = this.surfaceGrip(i) * (this.arcade ? this.arcade.wheelGrip(this, i) : 1);
      w.arcadeGrip = this.arcade ? this.arcade.wheelGrip(this, i) : 1;
      const fz = lerp(d.staticLoad, w.load, d.axle.wheel_load_ratio);
      const fMax = mu * Math.max(0, fz);

      // longitudinal: semi-implicit wheel spin against a linear tyre, then the combined-slip limit
      const vRef = Math.max(Math.abs(vLong), TYRE.slipRefSpeed);
      const fMaxLong = fMax * TYRE.longPeak;
      // Chaos' per-wheel traction control (axle traction_control): the wheel gets what its tyre
      // passes on plus a margin that shrinks as the wheel's slip ratio grows past wheelTcSlip, and
      // turns into a deficit by twice that: wheelspin holds at a few tens of percent
      if (d.axle.traction_control && driveT !== 0) {
        const kappa = Math.max(0, w.longSlipCms / 100) / vRef;
        const k0 = TYRE.wheelTcSlip;
        const excess = TYRE.wheelTcMargin * clamp(1 - (kappa - k0) / k0, -1, 1);
        const cap = fMaxLong * R * Math.max(0, 1 + excess);
        if (Math.abs(driveT) > cap) driveT = Math.sign(driveT) * cap;
      }
      const cLong = fMaxLong / (TYRE.slipRatioPeak * vRef); // N per m/s of slip
      // fx === null: linear tyre, solved implicitly; else the saturated tyre force, held constant.
      // The brake (Coulomb) opposes the way the wheel would turn without it; if it would carry the
      // wheel through zero, it holds the wheel instead.
      const solve = (om0: number, fx: number | null): number => {
        const step = (brakeTorque: number) => fx === null
          ? (om0 + (dt * (driveT - brakeTorque)) / inertia + (dt * cLong * vLong * R) / inertia) / (1 + (dt * cLong * R * R) / inertia)
          : om0 + (dt * (driveT - brakeTorque - fx * R)) / inertia;
        const free = step(0);
        if (brakeT <= 0) return free;
        const sgn = Math.sign(free);
        if (sgn === 0) return 0;
        const braked = step(sgn * brakeT);
        return braked * sgn <= 0 ? 0 : braked;
      };
      let om = solve(w.omega, null);
      // combined slip
      const alphaPeak = TYRE.slipAnglePeakDeg * (400 / Math.max(50, d.axle.cornering_stiffness)) ** TYRE.corneringExponent;
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), TYRE.slipAngleRefSpeed));
      // How hard the drive or the brake asks the tyre to push, relative to its longitudinal peak.
      // Chaos clips the force the wheel *asks for* to the grip, so a spinning or locked wheel keeps
      // a share of side grip; past the peak, the longitudinal slip that sets the force direction is
      // capped at this demand.
      const demand = Math.max(1, (Math.abs(driveT) + brakeT) / R / Math.max(1, fMaxLong));
      const forces = (omega: number) => {
        let sx = (omega * R - vLong) / vRef / TYRE.slipRatioPeak;
        if (Math.abs(sx) > demand) sx = Math.sign(sx) * demand;
        const sy = Math.tan(slipAngle) / Math.tan(alphaPeak * DEG);
        const s = Math.hypot(sx, sy);
        if (s < 1e-6) return { fx: 0, fy: 0, s };
        // a friction ellipse (longPeak along the wheel); past the peak the tyre slides: sideways
        // it falls off to side_slip, along the wheel to the base friction
        const k = s <= 1 ? 0 : clamp((s - 1) / TYRE.slideFalloff, 0, 1);
        const fLong = s <= 1 ? s : lerp(1, 1 / TYRE.longPeak, k);
        const fLat = s <= 1 ? s : lerp(1, d.axle.side_slip, k);
        return { fx: (fMaxLong * fLong * sx) / s, fy: (-fMax * fLat * sy) / s, s };
      };
      let F = forces(om);
      if (F.s > 1) {
        // saturated: spin the wheel against the force the tyre can actually give
        om = solve(w.omega, F.fx);
        F = forces(om);
      }
      // low-speed: never push past stopping the patch this step
      const corner = d.staticLoad / G;
      const latCap = (corner * Math.abs(vLat)) / dt;
      if (Math.abs(F.fy) > latCap) F.fy = Math.sign(F.fy) * latCap;
      w.omega = om;
      w.angle += om * dt;

      // readouts for the arcade layers, FX and audio (UE cm/s)
      w.slipAngleDeg = slipAngle / DEG;
      w.latSlipCms = vLat * 100;
      w.longSlipCms = (Math.abs(om) * R - Math.abs(vLong)) * 100;
      w.groundSpeedCms = v.length() * 100;

      // forces at the wheel centre (UE bLegacyWheelFrictionPosition: steadier than at the patch)
      this.fx.copy(this.up).multiplyScalar(w.load)
        .addScaledVector(this.fwdW, F.fx)
        .addScaledVector(this.rightW, F.fy);
      body.addForceAtPoint(this.fx, this.centre, true);
    }
  }

  private applyAero(): void {
    const t = this.t;
    const v = this.velocity;
    const speed = v.length();
    if (speed < 0.1) return;
    const area = (t.frontalWidthCm / 100) * (t.frontalHeightCm / 100);
    const q = 0.5 * AIR_DENSITY * speed * speed * area;
    this.fx.copy(v).multiplyScalar((-q * t.dragCoefficient) / speed);
    this.body.addForce(this.fx, true);
    if (this.wheelsInContact > 0) {
      this.fx.copy(this.up).multiplyScalar(-q * t.downforceCoefficient);
      this.body.addForce(this.fx, true);
    }
  }

  /** UE AddTorqueInDegrees(..., bAccelChange): a yaw acceleration (deg/s^2, + = right) about the car's up. */
  addYawAccel(degPerS2: number, dt: number): void {
    const av = this.body.angvel();
    const d = -degPerS2 * DEG * dt;
    this.body.setAngvel({ x: av.x + this.up.x * d, y: av.y + this.up.y * d, z: av.z + this.up.z * d }, true);
  }

  /** An angular acceleration (rad/s^2) about a world axis, applied as a velocity change. */
  addAngularAccel(axis: Vector3, radPerS2: number, dt: number): void {
    const av = this.body.angvel();
    const d = radPerS2 * dt;
    this.body.setAngvel({ x: av.x + axis.x * d, y: av.y + axis.y * d, z: av.z + axis.z * d }, true);
  }

  /** A linear acceleration (m/s^2) as a velocity change. */
  addAccel(a: Vector3, dt: number): void {
    const lv = this.body.linvel();
    this.body.setLinvel({ x: lv.x + a.x * dt, y: lv.y + a.y * dt, z: lv.z + a.z * dt }, true);
  }

  /** Drive share of the rears vs their grip at this throttle (UE EstimateRearDriveShare); 0 = can't tell. */
  estimateRearDriveShare(throttle: number): number {
    const t = this.t;
    if (this.gear <= 0 || t.drivetrain === 'FWD') return 0;
    const share = torqueShare(t, clamp(this.rpm / t.maxRpm, 0, 1));
    const rearShare = t.drivetrain === 'AWD' ? clamp(t.frontRearSplit, 0, 1) : 1;
    const wheelT = share * this.appliedMaxTorque * throttle * t.gearRatios[this.gear - 1] * t.finalDrive * t.efficiency * rearShare * 0.5;
    const driveN = wheelT / Math.max(0.05, t.wheelRadius);
    let grip = 0;
    let n = 0;
    for (let i = 2; i < 4; i++) {
      const w = this.wheels[i];
      if (w.inContact) {
        // UE: spring force x the physical material's friction x the wheel's friction multiplier
        // (no TYRE.gripScale: the traction-control shares in cars_tuning.json are in those units)
        grip += (w.load * this.surfaceGrip(i) * w.arcadeGrip) / TYRE.gripScale;
        n++;
      }
    }
    return n > 0 && grip > 1 ? driveN / (grip / n) : 0;
  }
}
