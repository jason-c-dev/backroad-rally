// The arcade layers (handoff §5.3), ported from UE RallyCar.cpp in its tick order:
// handbrake -> power slide + traction control -> steering assists -> wheel friction -> arcade forces
// (yaw helpers, stability / ESC, handbrake catch, rolling drag, air levelling) -> auto recover and
// the last good pose. All yaw terms are yaw accelerations (deg/s^2, + = right).
import { Vector3 } from 'three';
import { clamp, interpConstantTo, lerp, ramp, type ArcadeLayer, type Vehicle } from './vehicle';

const DEG = Math.PI / 180;
const WORLD_UP = new Vector3(0, 1, 0);

export interface GoodPose {
  position: Vector3;
  yawDeg: number;
  time: number;
}

/** A stage can supply the reset point (road projection, slice 4); otherwise the last good pose. */
export type ResetFinder = (v: Vehicle) => { position: Vector3; yawDeg: number } | null;

export class Arcade implements ArcadeLayer {
  stabilityAssist: number;
  countersteerAssist: number;
  autoRecover = true;
  findReset: ResetFinder | null = null;
  onRecovered: ((manual: boolean) => void) | null = null;

  // handbrake (core-6)
  handbrakeHold = 0;
  handbrakeSinceRelease = 10;
  hbStabilityScale = 1;
  hbCountersteerScale = 1;
  // power slide + traction control (core-13 / 14)
  private rearSpinSmoothed = 0;
  private frontSpinSmoothed = 0;
  private powerCountersteer = false;
  private pwStabilityScale = 1;
  private pwCountersteerScale = 1;
  private tcSpinScale = 1;
  private tcCap = 1;
  // debug readouts
  dbgStabYaw = 0;
  dbgCountersteer = 0;
  // recover
  private upsideDownTime = 0;
  private stuckTime = 0;
  private goodPoseTimer = 0;
  readonly goodPoses: GoodPose[] = [];
  time = 0;
  private lastRecoverTime = -10;

  constructor(v: Vehicle) {
    this.stabilityAssist = v.t.arcade.stability_default;
    this.countersteerAssist = v.t.arcade.countersteer_default;
  }

  // ---------------------------------------------------------------- before steering
  beforeSteering(v: Vehicle, dt: number): void {
    this.time += dt;
    this.updateHandbrake(v, dt);
    this.updatePowerSlide(v, dt);
  }

  private updateHandbrake(v: Vehicle, dt: number): void {
    const A = v.a;
    const In = v.input;
    const active = In.handbrake && v.speedKmh > A.handbrake_min_kmh && v.wheelsInContact >= 2;
    if (In.handbrake) {
      this.handbrakeHold += dt;
      this.handbrakeSinceRelease = 0;
    } else {
      this.handbrakeHold = 0;
      this.handbrakeSinceRelease += dt;
    }
    const rate = active ? 1 / Math.max(0.01, A.handbrake_grip_in_s) : 1 / Math.max(0.01, A.handbrake_grip_out_s);
    v.handbrakeEngage = interpConstantTo(v.handbrakeEngage, active ? 1 : 0, dt, rate);
    const relax = (held: number, ret: number) =>
      this.handbrakeSinceRelease <= 0 ? held : lerp(held, 1, clamp(this.handbrakeSinceRelease / Math.max(0.01, ret), 0, 1));
    this.hbStabilityScale = relax(A.handbrake_stability_scale, A.handbrake_stability_return_s);
    this.hbCountersteerScale = relax(A.handbrake_countersteer_scale, A.handbrake_countersteer_return_s);
  }

  private updatePowerSlide(v: Vehicle, dt: number): void {
    const A = v.a;
    const t = v.t;
    const In = v.input;
    const rearDriven = t.drivetrain !== 'FWD';
    const frontDriven = t.drivetrain !== 'RWD';
    const meanSpin = (first: number) => {
      let sum = 0, n = 0;
      for (let i = first; i < first + 2; i++) {
        const w = v.wheels[i];
        if (w.inContact) {
          sum += Math.max(0, w.longSlipCms);
          n++;
        }
      }
      return n ? sum / n : 0;
    };
    v.rearSpinCms = rearDriven ? meanSpin(2) : 0;
    v.frontSpinCms = frontDriven ? meanSpin(0) : 0;

    const kmh = v.speedKmh;
    const gear = v.gear;
    const fwdCms = v.forwardSpeed * 100;
    const valid = v.wheelsInContact >= 3 && fwdCms > 0 && v.handbrakeEngage < 0.5 && gear > 0;
    const throttleW = ramp(In.throttle, A.power_throttle_start, A.power_throttle_full);
    const sm = v.smoothedSteer;
    const countersteer = Math.abs(sm) > 0.02
      && ((sm * v.bodySlipDeg > 0 && Math.abs(v.bodySlipDeg) > 3) || (sm * v.yawRateDeg < 0 && Math.abs(v.yawRateDeg) > 5));
    this.powerCountersteer = countersteer;
    const cancel = A.power_countersteer_cancels > 0.5 && countersteer;
    const steerW = A.power_steer_full_deg > 0
      ? ramp(Math.abs(sm) * v.steerLockScale(kmh) * t.steering.max_angle_deg, A.power_steer_start_deg, A.power_steer_full_deg)
      : ramp(Math.abs(sm), A.power_steer_start, A.power_steer_full);
    const cornerW = cancel ? 0 : Math.max(steerW, ramp(Math.abs(v.bodySlipDeg), A.power_body_slip_start_deg, A.power_body_slip_full_deg));
    const fadeStart = A.power_fade_start_kmh >= 0 ? A.power_fade_start_kmh : A.power_full_kmh;
    const speedW = ramp(kmh, A.power_min_kmh, A.power_full_kmh) * lerp(1, A.power_high_speed_scale, ramp(kmh, fadeStart, A.power_fade_kmh));
    const gearW = 1 - ramp(gear, A.power_gear_full, A.power_gear_zero);
    const common = valid ? throttleW * cornerW * speedW * gearW : 0;
    const groundCms = Math.abs(fwdCms);
    const spinStart = A.power_slip_start_cms + A.power_slip_ratio_start * groundCms;
    const spinFull = Math.max(spinStart + 1, A.power_slip_full_cms + A.power_slip_ratio_full * groundCms);

    // traction control by gear (traction assist)
    if (A.tc_enabled > 0.5 && rearDriven && v.wheelsInContact >= 3 && gear > 0 && In.throttle > 0) {
      const highGear = gear > A.tc_low_gear;
      const allowed = Math.max(10, (highGear ? A.tc_spin_high_cms : A.tc_spin_low_cms) + A.tc_spin_ratio * groundCms);
      if (v.rearSpinCms > allowed) {
        this.tcSpinScale = Math.max(A.tc_min_throttle, this.tcSpinScale - A.tc_cut_rate * dt * Math.min(2, (v.rearSpinCms - allowed) / allowed));
      } else {
        this.tcSpinScale = Math.min(1, this.tcSpinScale + A.tc_recover_rate * dt);
      }
      let cap = 1;
      if (highGear && A.tc_share_corner > 0) {
        const wheelDeg = Math.abs(sm) * v.steerLockScale(kmh) * t.steering.max_angle_deg;
        const cornerT = Math.max(ramp(Math.abs(v.yawRateDeg), A.tc_corner_yaw_start_dps, A.tc_corner_yaw_full_dps),
          ramp(Math.abs(v.bodySlipDeg), 1, 5), ramp(wheelDeg, 1, 4));
        const share = v.estimateRearDriveShare(In.throttle);
        const maxShare = lerp(A.tc_share_straight, A.tc_share_corner, cornerT);
        cap = share > maxShare ? Math.max(A.tc_min_throttle, maxShare / share) : 1;
      }
      this.tcCap = cap < this.tcCap ? cap : Math.min(cap, this.tcCap + A.tc_recover_rate * dt);
      v.tcScale = Math.min(this.tcSpinScale, this.tcCap);
    } else {
      const s = A.tc_enabled > 0.5 ? Math.min(1, v.tcScale + A.tc_recover_rate * dt) : 1;
      this.tcSpinScale = this.tcCap = v.tcScale = s;
    }

    const smooth = (state: number, raw: number) => {
      const tau = raw > state ? 0.03 : A.power_spin_smooth_s;
      return A.power_spin_smooth_s > 0 ? state + (raw - state) * (1 - Math.exp(-dt / tau)) : raw;
    };
    this.rearSpinSmoothed = smooth(this.rearSpinSmoothed, v.rearSpinCms);
    this.frontSpinSmoothed = smooth(this.frontSpinSmoothed, v.frontSpinCms);
    const target = rearDriven ? common * ramp(this.rearSpinSmoothed, spinStart, spinFull) : 0;
    const rate = 1 / Math.max(0.01, target > v.powerSlide ? A.power_in_s : A.power_out_s);
    v.powerSlide = interpConstantTo(v.powerSlide, target, dt, rate);

    const driveW = t.drivetrain === 'RWD' ? 1 : t.drivetrain === 'AWD' ? clamp(t.frontRearSplit * A.power_awd_scale, 0, 1) : 0;
    let surfaceW = 0, n = 0;
    for (let i = 2; i < 4; i++) {
      const w = v.wheels[i];
      if (w.inContact) {
        surfaceW += t.surfaces[w.surface]?.power_scale ?? 1;
        n++;
      }
    }
    surfaceW = n ? surfaceW / n : 1;
    v.powerStrength = clamp(v.powerSlide * driveW * surfaceW, 0, 1.5);

    const underTarget = t.drivetrain === 'FWD' ? common * ramp(this.frontSpinSmoothed, spinStart, spinFull) : 0;
    const uRate = 1 / Math.max(0.01, underTarget > v.powerUnder ? A.power_in_s : A.power_out_s);
    v.powerUnder = interpConstantTo(v.powerUnder, underTarget, dt, uRate);

    const assistW = clamp(v.powerStrength, 0, 1);
    this.pwStabilityScale = lerp(1, A.power_stability_scale, assistW);
    this.pwCountersteerScale = lerp(1, A.power_countersteer_scale, assistW);
  }

  // ---------------------------------------------------------------- steering
  /** Counter-steer assist: point the front wheels along the velocity when the car slides (UE UpdateSteering). */
  assistSteer(v: Vehicle, steer: number): number {
    const A = v.a;
    const maxDeg = v.t.steering.max_angle_deg;
    const cs = this.countersteerAssist * this.hbCountersteerScale * this.pwCountersteerScale;
    this.dbgCountersteer = 0;
    if (cs > 0 && v.wheelsInContact >= 2 && v.forwardSpeed > 0 && v.speedKmh > A.countersteer_min_kmh) {
      const absSlip = Math.abs(v.bodySlipDeg);
      const w = ramp(absSlip, A.countersteer_slip_start_deg, A.countersteer_slip_start_deg * 2);
      if (w > 0 && maxDeg > 1) {
        const assist = (Math.sign(v.bodySlipDeg) * Math.min(absSlip, maxDeg) * A.countersteer_gain * cs * w) / maxDeg;
        this.dbgCountersteer = assist;
        if (steer * assist >= 0) steer = Math.abs(assist) > Math.abs(steer) ? assist : steer;
        else steer = steer + assist;
      }
    }
    return steer;
  }

  // ---------------------------------------------------------------- wheel friction
  wheelGrip(v: Vehicle, i: number): number {
    const A = v.a;
    if (i < 2) return lerp(1, A.power_front_grip, v.powerUnder);
    const hb = lerp(1, A.handbrake_rear_grip, v.handbrakeEngage);
    const pw = Math.max(0.2, lerp(1, A.power_rear_grip, v.powerStrength));
    return hb * pw;
  }

  // ---------------------------------------------------------------- forces
  applyForces(v: Vehicle, dt: number): void {
    const A = v.a;
    const kmh = v.speedKmh;
    const fwdCms = v.forwardSpeed * 100;
    const grounded = v.wheelsInContact >= 2;
    if (grounded) {
      v.body.setAngularDamping(A.ground_angular_damping);
      let yaw = 0;
      // steering yaw helper: rotation in hairpins without needing huge grip
      if (Math.abs(fwdCms) > 100) {
        const rise = clamp(kmh / Math.max(1, A.steer_yaw_peak_kmh), 0, 1);
        const fade = lerp(1, A.steer_yaw_high_speed_scale, ramp(kmh, A.steer_yaw_peak_kmh, A.steer_yaw_fade_kmh));
        yaw += v.appliedSteer * A.steer_yaw_accel * rise * fade * Math.sign(fwdCms);
      }
      if (v.powerStrength > 0 && A.power_yaw_accel !== 0) {
        let dir = clamp(v.smoothedSteer / Math.max(0.01, A.power_steer_full), -1, 1);
        if (A.power_countersteer_cancels > 0.5 && this.powerCountersteer) dir = 0;
        yaw += dir * A.power_yaw_accel * v.powerStrength;
      }
      if (v.handbrakeEngage > 0) {
        const rise = ramp(kmh, A.handbrake_min_kmh, A.handbrake_yaw_full_kmh);
        const fade = lerp(1, A.handbrake_yaw_high_speed_scale, ramp(kmh, A.handbrake_yaw_full_kmh, A.handbrake_yaw_fade_kmh));
        // signed by the gear, not the speed: past 90 deg of slip the car travels backwards
        yaw += v.smoothedSteer * A.handbrake_yaw_accel * rise * fade * v.handbrakeEngage * (v.gear < 0 ? -1 : 1);
      }
      // stability assist: damp yaw that grows the slide, pull the nose back past the max slip angle
      const stab = this.stabilityAssist * this.hbStabilityScale * this.pwStabilityScale;
      const before = yaw;
      if (stab > 0 && fwdCms > 500) {
        const absSlip = Math.abs(v.bodySlipDeg);
        const w = ramp(absSlip, A.stability_slip_start_deg, A.stability_slip_full_deg);
        if (w > 0 && v.yawRateDeg * v.bodySlipDeg < 0) yaw += -stab * w * A.stability_yaw_damping * v.yawRateDeg;
        if (absSlip > A.stability_max_slip_deg) {
          yaw += stab * Math.sign(v.bodySlipDeg) * (absSlip - A.stability_max_slip_deg) * A.stability_restore_accel;
        }
        // yaw-rate assist (traction assist): hold the yaw near what the front wheels ask for at speed
        if (A.esc_yaw_gain > 0) {
          const escW = ramp(kmh, A.esc_min_kmh, A.esc_full_kmh);
          if (escW > 0) {
            const escV = Math.abs(fwdCms) / 100;
            const wheelRad = v.appliedSteer * v.t.steering.max_angle_deg * DEG;
            const wanted = (escV * Math.tan(wheelRad)) / Math.max(1, A.esc_wheelbase_m) / DEG;
            const limit = (A.esc_grip_g * 9.81) / Math.max(1, escV) / DEG;
            const excess = v.yawRateDeg - clamp(wanted, -limit, limit);
            if (excess * v.yawRateDeg > 0 && Math.abs(excess) > A.esc_margin_dps) {
              yaw += -stab * escW * A.esc_yaw_gain * (excess - Math.sign(excess) * A.esc_margin_dps);
            }
          }
        }
        this.dbgStabYaw = yaw - before;
      } else {
        this.dbgStabYaw = 0;
      }
      // handbrake released: damp rotation that still grows the slide for a moment
      if (A.handbrake_catch_damping > 0 && this.handbrakeSinceRelease > 0 && this.handbrakeSinceRelease < A.handbrake_catch_s
        && kmh > 3 && v.yawRateDeg * v.bodySlipDeg < 0) {
        const fade = 1 - this.handbrakeSinceRelease / Math.max(0.01, A.handbrake_catch_s);
        yaw += -A.handbrake_catch_damping * fade * v.yawRateDeg;
      }
      if (Math.abs(yaw) > 1e-6) v.addYawAccel(yaw, dt);

      // per-surface rolling drag (grass and water bog the car down)
      const speed = v.velocity.length();
      if (speed > 0.1) {
        let drag = 0;
        for (const w of v.wheels) if (w.inContact) drag += (v.t.surfaces[w.surface]?.rolling_drag ?? 0) * 0.25;
        if (drag > 0) {
          const scale = Math.min(1, speed / 20);
          v.addAccel(v.velocity.clone().normalize().multiplyScalar(-drag * scale), dt);
        }
      }
    } else {
      // airborne: damp tumbling and level the car so it lands on its wheels
      v.body.setAngularDamping(A.air_angular_damping);
      const axis = new Vector3().crossVectors(v.up, WORLD_UP);
      const sin = axis.length();
      if (sin > 0.01 && v.up.y > -0.2) {
        const angleDeg = Math.asin(Math.min(1, sin)) / DEG;
        v.addAngularAccel(axis.divideScalar(sin), angleDeg * A.air_level_strength * DEG, dt);
      }
      v.addYawAccel(v.appliedSteer * A.steer_yaw_accel * 0.3, dt);
    }
  }

  // ---------------------------------------------------------------- recover
  afterForces(v: Vehicle, dt: number): void {
    this.updateAutoRecover(v, dt);
    this.trackLastGoodPose(v, dt);
  }

  private updateAutoRecover(v: Vehicle, dt: number): void {
    if (!this.autoRecover) {
      this.upsideDownTime = this.stuckTime = 0;
      return;
    }
    const A = v.a;
    const In = v.input;
    this.upsideDownTime = v.up.y < 0.3 ? this.upsideDownTime + dt : 0;
    const trying = (In.throttle > 0.5 || In.brake > 0.5) && !In.handbrake;
    this.stuckTime = trying && v.speedKmh < A.stuck_speed_kmh ? this.stuckTime + dt : 0;
    if (this.upsideDownTime > A.auto_recover_s || this.stuckTime > A.auto_recover_s) this.recover(v, false);
  }

  private trackLastGoodPose(v: Vehicle, dt: number): void {
    this.goodPoseTimer += dt;
    if (this.goodPoseTimer < 0.25) return;
    this.goodPoseTimer = 0;
    if (v.wheelsInContact < 4 || v.up.y < 0.8 || v.speedKmh < 8 || v.forwardSpeed < 0) return;
    for (const w of v.wheels) {
      if (w.surface !== 'tarmac' && w.surface !== 'gravel' && w.surface !== 'dirt' && w.surface !== 'snow') return;
    }
    const vel = v.velocity;
    this.goodPoses.push({ position: v.position.clone(), yawDeg: Math.atan2(vel.z, vel.x) / DEG, time: this.time });
    if (this.goodPoses.length > 40) this.goodPoses.shift();
  }

  /** Reset to the stage's reset point or the last good pose >= 1.5 s old, +60 cm, stopped, 1st gear. */
  recover(v: Vehicle, manual: boolean): boolean {
    if (this.time - this.lastRecoverTime < 1) return false; // one reset (and one penalty) per incident
    let pose = this.findReset?.(v) ?? null;
    if (!pose) {
      for (let i = this.goodPoses.length - 1; i >= 0; i--) {
        if (this.time - this.goodPoses[i].time >= 1.5) {
          pose = { position: this.goodPoses[i].position.clone(), yawDeg: this.goodPoses[i].yawDeg };
          break;
        }
      }
    }
    pose ??= { position: v.position.clone(), yawDeg: v.yawDeg };
    pose.position.y += v.a.recover_drop_cm / 100;
    this.lastRecoverTime = this.time;
    v.teleport(pose.position, pose.yawDeg);
    this.upsideDownTime = this.stuckTime = 0;
    this.goodPoses.length = 0;
    this.onRecovered?.(manual);
    return true;
  }
}

export function createArcade(v: Vehicle): Arcade {
  return new Arcade(v);
}
