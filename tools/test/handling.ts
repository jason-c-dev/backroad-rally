// Headless handling tests: a port of the UE build's RallyTestComponent (handoff §11, testtrack.json).
// Same manoeuvres, scripted drivers and pass bands; the car is src/sim/vehicle.ts on Rapier.
//
//   npx tsx tools/test/handling.ts [--cars swift,pip|all] [--kinds feel|all|corner,brake,...]
//                                  [--surfaces tarmac,gravel] [--ue <ue_feel.txt>] [--csv out.csv] [--quiet]
//
// Prints one line per job in the UE format ("<car> <kind> <surface> <result> PASS|FAIL|info"), then a
// summary. With --ue, the UE build's line for the same job is printed under each result.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { createWorld, initPhysics, PHYSICS_DT } from '../../src/sim/physics';
import { buildTestTrackPhysics } from '../../src/sim/testTrackPhysics';
import { loadCarTuning } from '../../src/sim/tuning';
import { TYRE, Vehicle, noInput, type DriverInput } from '../../src/sim/vehicle';
import { createArcade } from '../../src/sim/arcade';
import type { TestTrack } from '../../src/data';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = (f: string) => JSON.parse(readFileSync(join(repo, 'public', 'data', f), 'utf8'));
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};

type Json = Record<string, any>;
const track = data('testtrack.json') as TestTrack & Json;
const tuningJson = data('cars_tuning.json');
const ALL_CARS = ['swift', 'pip', 'lama', 'quint', 'kaze'];
const DROP_M = 0.4;
const DT = PHYSICS_DT;
const noArcade = process.argv.includes('--no-arcade');
const trace = process.argv.includes('--trace');

// ---------------------------------------------------------------- helpers (UE math)
const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
const norm = (a: number) => {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
};
const num = (o: Json | undefined, k: string, d: number) => (o && typeof o[k] === 'number' ? o[k] : d);
interface V2 { x: number; y: number }
const fwd2 = (yaw: number): V2 => ({ x: Math.cos(yaw * DEG), y: Math.sin(yaw * DEG) });
const right2 = (yaw: number): V2 => ({ x: -Math.sin(yaw * DEG), y: Math.cos(yaw * DEG) });
const dot2 = (a: V2, b: V2) => a.x * b.x + a.y * b.y;
const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const yawOf = (v: V2) => Math.atan2(v.y, v.x) / DEG;

// ---------------------------------------------------------------- poses (UE RallyTestComponent::LoadTrack)
interface Pose { p: V2; yaw: number }
const poses: Record<string, Pose> = {};
const padCenters: Record<string, V2> = {};
const stripLengths: Record<string, number> = {};
for (const s of track.strips) {
  const d = fwd2(s.yaw);
  poses[s.name] = { p: { x: s.start[0] + d.x * 15, y: s.start[1] + d.y * 15 }, yaw: s.yaw };
  stripLengths[s.name] = s.length_m;
}
for (const p of track.pads) {
  poses[p.name] = { p: { x: p.center[0] - p.size_m * 0.5 + 12, y: p.center[1] }, yaw: 0 };
  padCenters[p.name] = { x: p.center[0], y: p.center[1] };
}
const circleR = num(track.tests as Json, 'circle_radius_m', 40);
const handbrakeEntryKmh = num(track.tests as Json, 'handbrake_entry_kmh', 60);
const targets: Json = track.targets;

// ---------------------------------------------------------------- jobs
interface Job { car: string; kind: string; surface: string; param: number; ta: number }

function expandJobs(cars: string[], kinds: string[], surfaces: string[]): Job[] {
  const jobs: Job[] = [];
  for (const car of cars) {
    const carJson = data(`cars/${car}.json`);
    const nGears = loadCarTuning(tuningJson, carJson, car).gearRatios.length;
    for (const k of kinds) {
      for (const s of surfaces) {
        if (k === 'coast') {
          jobs.push({ car, kind: k, surface: s, param: 60, ta: -1 }, { car, kind: k, surface: s, param: 100, ta: -1 });
        } else if (k === 'hairpin' || k.startsWith('hairpin_')) {
          ['good', 'early', 'long', 'none'].forEach((n, v) => {
            if (k === 'hairpin' || k === `hairpin_${n}`) jobs.push({ car, kind: 'hairpin', surface: s, param: v, ta: -1 });
          });
        } else if (k === 'powerslide' || k.startsWith('powerslide_')) {
          const all = ['hold', 'off', 'part', 'full'];
          const params = [0, 1, 3, 2];
          for (const m of [1, 0]) {
            all.forEach((n, v) => {
              if (k === 'powerslide' || k === `powerslide_${n}`) jobs.push({ car, kind: 'powerslide', surface: s, param: params[v], ta: m });
            });
          }
        } else if (k.startsWith('highspeedtap') || k.startsWith('lanechange')) {
          const tap = k.startsWith('highspeedtap');
          const base = tap ? 'highspeedtap' : 'lanechange';
          const modes: number[] = [];
          if (k === base || k === `${base}_on`) modes.push(1);
          if (k === base || k === `${base}_off`) modes.push(0);
          const params = [0];
          if (tap) for (let g = 3; g <= Math.min(5, nGears); g++) params.push(-g);
          for (const m of modes) for (const p of params) jobs.push({ car, kind: base, surface: s, param: p, ta: m });
        } else if (k === 'reverse') {
          if (s === surfaces[0]) jobs.push({ car, kind: k, surface: s, param: 0, ta: -1 });
        } else {
          const entry = k === 'tap' ? 80 : k === 'flick' ? 100 : k === 'power' ? 50 : k === 'brake' ? 100 : 0;
          jobs.push({ car, kind: k, surface: s, param: entry, ta: -1 });
        }
      }
    }
  }
  return jobs;
}

// ---------------------------------------------------------------- one job
class Run {
  car!: Vehicle;
  world!: RAPIER.World;
  phase = 0;
  t = 0;
  startLoc!: V2;
  startYaw = 0;
  result = '';
  done = false;
  csv = '';
  // accumulators (UE member names)
  T100 = -1; T150 = -1; VMax = 0; HeldKmh = 0; HeldTimer = 0; FailTimer = 0; MaxSlip = 0; PeakYawRate = 0;
  YawTravel = 0; PeakSlipSigned = 0; CalmTimer = 0; BalanceSum = 0; BalanceN = 0; RecoverT = -1;
  traceT = 0; PrevYaw = 0; Spun = false; TargetKmh = 25; history: [number, number][] = []; prevVel: Vector3 | null = null;
  EntryKmh = 0; BrakeStart: V2 = { x: 0, y: 0 }; BrakeEntryKmh = 0;
  // hairpin
  Hp: Json = {}; HpRadiusM = 13; HpHalfWidthM = 4; HpArcStart: V2 = { x: 0, y: 0 };
  HpPullT = -1; HpReleaseT = -1; HpExitT = -1; HpOffRoadT = -1; HpHoldYaw = 0; HpErrAtTurnIn = 0; HpMaxInside = 0;
  HpMaxOutside = 0; HpMaxHeadErr = 0; HpExitErr = 0; HpErrAtPull = 0; HpMinKmh = 1000; HpOffSide = '';
  // powerslide
  Ps: Json = {}; PsSteadySlip = 0; PsSteadyYaw = 0; PsSteer = 0; PsSteadyKmh = 0; PsSlipSum = 0; PsYawSum = 0;
  PsSteerSum = 0; PsKmhSum = 0; PsN = 0; PsGear = 0; PsActN = 0; PsPeakSlip = 0; PsPeakYaw = 0; PsActYawSum = 0;
  PsMaxStrength = 0; PsMaxSpin = 0; PsMaxUnder = 0;
  // keyed
  Kd: Json = {}; KdKeys: [number, number][] = []; KdLastKeyT = 0; KdSettleT = -1; KdMaxYaw = 0; KdMaxStr = 0;
  KdMaxSpin = 0; KdStraightSpin = 0; KdHalfPeak = 0; KdLastPeak = 0; KdMaxPeakGrowth = 0; KdLateralM = 0; KdMaxPw = 0;
  KdSign = 0; KdSwings = 0; KdGear = 0; KdPeakN = 0; KdTargetKmh = 100; KdGrowing = false;

  constructor(public job: Job, public rapier: typeof RAPIER, public ps: PsMemory) {}

  goal(key: string, d: number): number {
    if (this.job.ta === 0) {
      const off = targets.ta_off as Json;
      if (off && typeof off[key] === 'number') return off[key];
    }
    return num(targets, key, d);
  }
  verdict(ok: boolean) {
    return ok ? 'PASS' : 'FAIL';
  }

  begin(): void {
    const j = this.job;
    const carJson = data(`cars/${j.car}.json`);
    const tuning = loadCarTuning(tuningJson, carJson, j.car);
    this.world = createWorld(this.rapier);
    const surf = buildTestTrackPhysics(this.rapier, this.world, track);
    this.car = new Vehicle(this.rapier, this.world, tuning, surf, carJson.wheel_pos_cm);
    if (!noArcade) this.car.arcade = createArcade(this.car);
    const pad = `pad_${j.surface}`;
    let pose: Pose;
    if (j.kind === 'accel' || j.kind === 'brake') {
      pose = poses[`strip_${j.surface}`];
    } else if (j.kind === 'corner') {
      const c = padCenters[pad];
      pose = { p: { x: c.x, y: c.y - circleR }, yaw: 0 };
    } else if (j.kind === 'powerslide') {
      this.Ps = track.powerslide as Json;
      const c = padCenters[pad];
      pose = { p: { x: c.x, y: c.y - num(this.Ps, 'radius_m', 25) }, yaw: 0 };
      const key = j.car + j.surface;
      if (key !== this.ps.key) Object.assign(this.ps, { key, holdGain: 0, holdYawRatio: 0, offGain: 0, offYawRatio: 0, partGain: 0 });
    } else if (j.kind === 'highspeedtap' || j.kind === 'lanechange') {
      this.Kd = (track as Json)[j.kind];
      pose = poses[`strip_${j.surface}`];
      this.KdKeys = (this.Kd.keys ?? [[0, 1], [0.15, 0]]) as [number, number][];
      this.KdLastKeyT = this.KdKeys[this.KdKeys.length - 1][0];
    } else {
      pose = poses[pad];
    }
    this.startLoc = pose.p;
    this.startYaw = pose.yaw;
    if (j.kind === 'hairpin') {
      this.Hp = track.hairpin as Json;
      this.HpRadiusM = num(this.Hp, 'radius_m', 13);
      this.HpHalfWidthM = num(this.Hp, 'half_width_m', 4);
      const f = fwd2(this.startYaw);
      const a = num(this.Hp, 'approach_m', 60);
      this.HpArcStart = { x: this.startLoc.x + f.x * a, y: this.startLoc.y + f.y * a };
    }
    this.car.teleport(new Vector3(pose.p.x, DROP_M, pose.p.y), pose.yaw);
    if (j.ta >= 0) this.car.setTractionAssist(j.ta > 0);
    if ((j.kind === 'highspeedtap' || j.kind === 'lanechange') && j.param <= 0) {
      let kmh = num(this.Kd, 'speed_kmh', 100);
      const g = Math.round(-j.param);
      const tu = this.car.t;
      if (g > 0 && g <= tu.gearRatios.length) {
        const rpm = tu.maxRpm * num(this.Kd, 'gear_rpm_norm', 0.72);
        kmh = rpm / (tu.gearRatios[g - 1] * tu.finalDrive) / 60 * 2 * Math.PI * tu.wheelRadius * 3.6;
      }
      this.KdTargetKmh = kmh;
    }
  }

  // car readouts in UE terms
  get loc(): V2 {
    return { x: this.car.position.x, y: this.car.position.z };
  }
  get yaw() {
    return this.car.yawDeg;
  }
  get kmh() {
    return this.car.forwardSpeedKmh;
  }

  holdLineSteer(start: V2, lineYaw: number): number {
    const lat = dot2(sub2(this.loc, start), right2(lineYaw));
    const head = norm(this.yaw - lineYaw);
    return clamp(-(0.12 * lat + 0.05 * head), -0.6, 0.6);
  }

  launch(kmh: number): void {
    this.car.launch(kmh / 3.6);
  }

  tick(): void {
    const c = this.car;
    this.t += DT;
    let input: DriverInput = noInput();
    if (this.phase === 0) {
      input.handbrake = true;
      if (this.t > 1.2) {
        this.phase = 1;
        this.t = 0;
      }
    } else {
      const k = this.job.kind;
      input = k === 'accel' ? this.tickAccel() : k === 'corner' ? this.tickCorner()
        : k === 'handbrake' || k === 'lockturn' ? this.tickHandbrake() : k === 'reverse' ? this.tickReverse()
        : k === 'brake' ? this.tickBrake() : k === 'hairpin' ? this.tickHairpin()
        : k === 'powerslide' ? this.tickPowerSlide() : k === 'highspeedtap' || k === 'lanechange' ? this.tickKeyed()
        : this.tickManoeuvre();
    }
    if (this.done) return;
    if (trace && this.phase > 0 && (this.traceT += DT) >= 0.1 - 1e-9) {
      this.traceT = 0;
      const a = c.arcade as { dbgStabYaw?: number; dbgCountersteer?: number } | null;
      console.log(`  ph${this.phase} t=${this.t.toFixed(2)} kmh=${this.kmh.toFixed(1)} g${c.gear} rpm=${c.rpm.toFixed(0)} in=${input.throttle.toFixed(2)}/${input.brake.toFixed(2)}/${input.steer.toFixed(2)}${input.handbrake ? '/hb' : ''} ` +
        `sm=${c.smoothedSteer.toFixed(2)} app=${c.appliedSteer.toFixed(2)} slip=${c.bodySlipDeg.toFixed(1)} yaw=${c.yawRateDeg.toFixed(1)} pw=${c.powerSlide.toFixed(2)} str=${c.powerStrength.toFixed(2)} ` +
        `rspin=${c.rearSpinCms.toFixed(0)} fspin=${c.frontSpinCms.toFixed(0)} tc=${c.tcScale.toFixed(2)} share=${c.estimateRearDriveShare(input.throttle).toFixed(2)} stab=${(a?.dbgStabYaw ?? 0).toFixed(0)} cs=${(a?.dbgCountersteer ?? 0).toFixed(2)} ` +
        `wheels=${c.wheels.map((w) => `${w.slipAngleDeg.toFixed(0)}/${w.longSlipCms.toFixed(0)}`).join(' ')}`);
    }
    c.input = input;
    c.step(DT);
    this.world.step();
  }

  finish(res: string): void {
    this.result = res;
    this.done = true;
  }

  // ---------------------------------------------------------------- brake
  tickBrake(): DriverInput {
    const In = noInput();
    In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
    const kmh = this.kmh;
    if (this.phase === 1) {
      if (this.t <= DT * 1.5) this.launch(this.job.param);
      In.throttle = clamp(0.1 * (this.job.param - kmh) + 0.3, 0, 1);
      if (this.t > 1.5) {
        this.phase = 2;
        this.t = 0;
        this.BrakeStart = this.loc;
        this.BrakeEntryKmh = kmh;
      }
      return In;
    }
    In.brake = 1;
    this.MaxSlip = Math.max(this.MaxSlip, Math.abs(this.car.bodySlipDeg));
    if (kmh > 1 && this.t < 20) return In;
    const l = this.loc;
    const raw = Math.hypot(l.x - this.BrakeStart.x, l.y - this.BrakeStart.y);
    const dist = raw * (this.job.param / Math.max(10, this.BrakeEntryKmh)) ** 2;
    const lo = this.goal(`brake_${this.job.surface}_min_m`, -1);
    const hi = this.goal(`brake_${this.job.surface}_max_m`, -1);
    const v = lo < 0 || hi < 0 ? 'info' : this.verdict(dist >= lo && dist <= hi && this.MaxSlip < this.goal('spin_slip_deg', 75));
    this.finish(`dist100=${dist.toFixed(1)}m (raw ${raw.toFixed(1)}m from ${this.BrakeEntryKmh.toFixed(0)}kmh) time=${this.t.toFixed(2)}s max_slip=${this.MaxSlip.toFixed(1)} band=[${lo},${hi}] ${v}`);
    return In;
  }

  // ---------------------------------------------------------------- accel
  tickAccel(): DriverInput {
    const In = noInput();
    In.throttle = 1;
    In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
    const kmh = this.kmh;
    const T = this.t;
    this.VMax = Math.max(this.VMax, kmh);
    if (this.T100 < 0 && kmh >= 100) this.T100 = T;
    if (this.T150 < 0 && kmh >= 150) this.T150 = T;
    const h = this.history;
    if (!h.length || T - h[h.length - 1][0] >= 0.5) h.push([T, kmh]);
    let gain = 100;
    for (let i = h.length - 1; i >= 0; i--) {
      if (T - h[i][0] >= 4) {
        gain = kmh - h[i][1];
        break;
      }
    }
    const dist = dot2(sub2(this.loc, this.startLoc), fwd2(this.startYaw));
    const out = dist > stripLengths[`strip_${this.job.surface}`] - 250;
    if (out || T > 70 || (T > 10 && gain < 0.4)) {
      this.finish(`t100=${this.T100.toFixed(2)}s t150=${this.T150.toFixed(2)}s vmax=${this.VMax.toFixed(1)}kmh dist=${dist.toFixed(0)}m time=${T.toFixed(1)}s end=${out ? 'strip_end' : T > 70 ? 'timeout' : 'plateau'}`);
    }
    return In;
  }

  // ---------------------------------------------------------------- corner
  tickCorner(): DriverInput {
    const c = this.car;
    const center = padCenters[`pad_${this.job.surface}`];
    const R = circleR;
    const P = this.loc;
    const rel = sub2(P, center);
    const dist = Math.hypot(rel.x, rel.y);
    const phi = Math.atan2(rel.y, rel.x);
    const kmh = this.kmh;
    const look = Math.max(8, (kmh / 3.6) * 0.5);
    const phiT = phi + look / R;
    const target = { x: center.x + Math.cos(phiT) * R, y: center.y + Math.sin(phiT) * R };
    const alpha = norm(yawOf(sub2(target, P)) - this.yaw) * DEG;
    const deltaDeg = Math.atan((2 * 2.5 * Math.sin(alpha)) / look) / DEG + 1.5 * (dist - R);
    const limit = c.steerLockScale(c.speedKmh);
    this.TargetKmh = Math.min(30 + 1.5 * this.t, 170);
    const In = noInput();
    In.steer = clamp(deltaDeg / Math.max(1, c.t.steering.max_angle_deg * limit), -1, 1);
    const err = this.TargetKmh - kmh;
    In.throttle = clamp(0.08 * err + 0.3, 0, 1);
    if (err < -6) {
      In.throttle = 0;
      In.brake = 0.3;
    }
    const errM = Math.abs(dist - R);
    this.MaxSlip = Math.max(this.MaxSlip, Math.abs(c.bodySlipDeg));
    // measured lateral acceleration across the path (g), averaged over 1 s windows on the circle
    const vel = c.velocity.clone();
    let aLat = 0;
    if (this.prevVel) {
      const acc = vel.clone().sub(this.prevVel).divideScalar(DT);
      const vd = new Vector3(vel.x, 0, vel.z).normalize();
      aLat = Math.abs(vd.x * acc.z - vd.z * acc.x) / 9.81;
    }
    this.prevVel = vel;
    this.history.push([this.t, aLat]);
    while (this.history.length && this.t - this.history[0][0] > 1) this.history.shift();
    this.HeldTimer = errM < 4 && this.t > 3 ? this.HeldTimer + DT : 0;
    if (this.HeldTimer > 1) {
      this.HeldKmh = Math.max(this.HeldKmh, kmh);
      const avg = this.history.reduce((a, b) => a + b[1], 0) / Math.max(1, this.history.length);
      if (avg > this.PeakYawRate) {
        this.PeakYawRate = avg;
        const w = c.wheels;
        this.BalanceSum = 0.5 * (Math.abs(w[0].slipAngleDeg) + Math.abs(w[1].slipAngleDeg)) - 0.5 * (Math.abs(w[2].slipAngleDeg) + Math.abs(w[3].slipAngleDeg));
        this.BalanceN = 1;
      }
    }
    this.FailTimer = errM > 8 ? this.FailTimer + DT : 0;
    if (this.FailTimer > 1 || this.t > 110 || this.TargetKmh >= 170) {
      const v = this.HeldKmh / 3.6;
      const v2r = (v * v) / (R * 9.81);
      const s = this.job.surface;
      const lo = this.goal(`${s}_lat_g_min`, s === 'tarmac' ? 0.97 : 0.82);
      const hi = this.goal(`${s}_lat_g_max`, s === 'tarmac' ? 1.13 : 0.98);
      this.finish(`held=${this.HeldKmh.toFixed(1)}kmh on R${R}m lat=${this.PeakYawRate.toFixed(2)}g v2r=${v2r.toFixed(2)}g maxslip=${this.MaxSlip.toFixed(0)}deg balance=${(this.BalanceN ? this.BalanceSum : 0).toFixed(1)}deg end=${this.FailTimer > 1 ? 'left_line' : 'limit'} ${this.verdict(this.PeakYawRate >= lo && this.PeakYawRate <= hi)}`);
    }
    return In;
  }

  // ---------------------------------------------------------------- handbrake / lockturn
  tickHandbrake(): DriverInput {
    const hb = this.job.kind === 'handbrake';
    const In = noInput();
    if (this.phase === 1) {
      In.throttle = 1;
      In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
      if (this.kmh >= handbrakeEntryKmh || this.t > 20) {
        this.phase = 2;
        this.t = 0;
        this.EntryKmh = this.kmh;
        this.PrevYaw = this.yaw;
      }
      return In;
    }
    In.steer = this.t < 0.8 ? 1 : 0.5;
    In.handbrake = hb && this.t < 0.8;
    In.throttle = this.t < 0.8 ? 0 : 0.5;
    const y = this.yaw;
    this.YawTravel += norm(y - this.PrevYaw);
    this.PrevYaw = y;
    this.PeakYawRate = Math.max(this.PeakYawRate, Math.abs(this.car.yawRateDeg));
    this.MaxSlip = Math.max(this.MaxSlip, Math.abs(this.car.bodySlipDeg));
    if (this.t >= 1 && this.HeldTimer === 0) {
      this.HeldTimer = this.YawTravel;
      this.HeldKmh = this.car.speedKmh;
    }
    if (this.t >= 2) {
      const pass = !hb || Math.abs(this.HeldTimer) >= this.goal('handbrake_min_rot_1s_deg', 55);
      this.finish(`entry=${this.EntryKmh.toFixed(0)}kmh peak_yaw=${this.PeakYawRate.toFixed(0)}deg/s rot_1s=${this.HeldTimer.toFixed(0)}deg rot_2s=${this.YawTravel.toFixed(0)}deg maxslip=${this.MaxSlip.toFixed(0)}deg speed_1s=${this.HeldKmh.toFixed(0)}kmh exit=${this.car.speedKmh.toFixed(0)}kmh ${hb ? this.verdict(pass) : 'info'}`);
    }
    return In;
  }

  // ---------------------------------------------------------------- coast / tap / flick / power
  tickManoeuvre(): DriverInput {
    const c = this.car;
    const In = noInput();
    const kmh = this.kmh;
    if (this.phase === 1) {
      if (this.t <= DT * 1.5) this.launch(this.job.param);
      In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
      In.throttle = clamp(0.1 * (this.job.param - kmh) + 0.3, 0, 1);
      if (this.t > 1.5) {
        this.phase = 2;
        this.t = 0;
        this.EntryKmh = kmh;
        this.PrevYaw = this.yaw;
      }
      return In;
    }
    const slip = c.bodySlipDeg;
    const yawRate = c.yawRateDeg;
    const K = this.job.kind;
    let duration = 3;
    if (K === 'coast') {
      In.steer = this.goal('coast_steer', 0.2);
    } else if (K === 'tap') {
      In.steer = this.t < 0.15 ? 1 : 0;
      In.digitalSteer = true;
    } else if (K === 'flick') {
      duration = 4;
      if (this.t < 0.6) {
        In.steer = 1;
      } else {
        In.steer = clamp(slip / 10 - yawRate / 90, -1, 1);
        In.throttle = 0.3;
        const calm = Math.abs(slip) < 6 && Math.abs(yawRate) < 15;
        this.CalmTimer = calm ? this.CalmTimer + DT : 0;
        if (this.RecoverT < 0 && this.CalmTimer >= 0.2) this.RecoverT = this.t - 0.6 - 0.2;
      }
    } else {
      duration = 2.5;
      In.steer = 0.5;
      In.throttle = 1;
    }
    const y = this.yaw;
    this.YawTravel += norm(y - this.PrevYaw);
    this.PrevYaw = y;
    this.PeakYawRate = Math.max(this.PeakYawRate, Math.abs(yawRate));
    if (Math.abs(slip) > this.MaxSlip) {
      this.MaxSlip = Math.abs(slip);
      this.PeakSlipSigned = slip;
    }
    this.Spun ||= this.MaxSlip > this.goal('spin_slip_deg', 75);
    if (this.t < duration) return In;
    let v: string;
    if (K === 'coast') v = this.verdict(!this.Spun && this.MaxSlip <= this.goal('coast_max_slip_deg', 8));
    else if (K === 'tap') v = this.verdict(!this.Spun && this.MaxSlip <= this.goal('tap_max_slip_deg', 12));
    else if (K === 'flick') {
      const minSlip = this.goal(`flick_min_slip_deg_${this.job.car}`, this.goal('flick_min_slip_deg', 8));
      v = this.verdict(!this.Spun && this.RecoverT >= 0 && this.RecoverT <= this.goal('flick_recover_s', 1.5) && this.MaxSlip >= minSlip);
    } else {
      const rwd = c.t.drivetrain === 'RWD';
      const maxBand = this.goal(`power_rwd_max_slip_deg_${this.job.surface}`, this.goal('power_rwd_max_slip_deg', 50));
      const spinFails = this.Spun && maxBand < this.goal('spin_slip_deg', 75);
      v = spinFails ? this.verdict(false) : rwd ? this.verdict(this.MaxSlip >= this.goal('power_rwd_min_slip_deg', 10) && this.MaxSlip <= maxBand) : 'info';
    }
    this.finish(`entry=${this.EntryKmh.toFixed(0)}kmh maxslip=${this.MaxSlip.toFixed(0)}deg peak_yaw=${this.PeakYawRate.toFixed(0)}deg/s rot=${this.YawTravel.toFixed(0)}deg recover=${this.RecoverT.toFixed(2)}s spun=${this.Spun ? 1 : 0} exit=${c.speedKmh.toFixed(0)}kmh wheel=${c.wheelAngleDeg.toFixed(1)}deg ${v}`);
    return In;
  }

  // ---------------------------------------------------------------- reverse
  tickReverse(): DriverInput {
    const In = noInput();
    In.brake = 1;
    if (this.RecoverT < 0 && (this.car.gear < 0 || this.kmh < -0.5)) this.RecoverT = this.t;
    if (this.t >= 2) {
      const pass = this.RecoverT >= this.goal('reverse_min_delay_s', 0.3) && this.RecoverT <= 1.2;
      this.finish(`reverse_after=${this.RecoverT.toFixed(2)}s speed=${this.kmh.toFixed(1)}kmh ${this.verdict(pass)}`);
    }
    return In;
  }

  // ---------------------------------------------------------------- hairpin
  hpLocate(p: V2): { s: number; lat: number; tangentYaw: number } {
    const f = fwd2(this.startYaw);
    const r = fwd2(this.startYaw + 90);
    const d = sub2(p, this.HpArcStart);
    const X = dot2(d, f);
    const Y = dot2(d, r);
    const R = this.HpRadiusM;
    if (X <= 0 && Y < R) return { s: X, lat: Y, tangentYaw: this.startYaw };
    if (X <= 0) return { s: Math.PI * R - X, lat: 2 * R - Y, tangentYaw: this.startYaw + 180 };
    const vx = X, vy = Y - R;
    const phi = clamp(Math.atan2(vx, -vy), 0, Math.PI);
    return { s: phi * R, lat: R - Math.hypot(vx, vy), tangentYaw: this.startYaw + phi / DEG };
  }
  hpOnApproach(p: V2): boolean {
    const d = sub2(p, this.HpArcStart);
    return dot2(d, fwd2(this.startYaw)) <= 0 && dot2(d, fwd2(this.startYaw + 90)) < this.HpRadiusM;
  }
  hpWorld(s: number): V2 {
    const f = fwd2(this.startYaw);
    const r = fwd2(this.startYaw + 90);
    const R = this.HpRadiusM;
    let X: number, Y: number;
    if (s <= 0) {
      X = s;
      Y = 0;
    } else if (s <= Math.PI * R) {
      X = R * Math.sin(s / R);
      Y = R - R * Math.cos(s / R);
    } else {
      X = -(s - Math.PI * R);
      Y = 2 * R;
    }
    return { x: this.HpArcStart.x + f.x * X + r.x * Y, y: this.HpArcStart.y + f.y * X + r.y * Y };
  }

  tickHairpin(): DriverInput {
    const c = this.car;
    const names = ['good', 'early', 'long', 'none'];
    const variant = clamp(Math.trunc(this.job.param), 0, 3);
    const vName = names[variant];
    const carCfg = (this.Hp.cars ?? {})[this.job.car] as Json | undefined;
    const vCfg = (carCfg?.[vName] ?? (this.Hp.variants ?? {})[vName]) as Json | undefined;
    const entryKmh = num(carCfg, 'entry_kmh', num(this.Hp, 'entry_kmh', 45));
    const leadM = num(vCfg, 'lead_m', 3);
    const holdS = num(vCfg, 'hold_s', 0.5);
    const pullSteer = num(vCfg, 'steer', 1);
    const offM = this.HpHalfWidthM + num(this.Hp, 'verge_m', 1.5);
    const exitS = Math.PI * this.HpRadiusM + num(this.Hp, 'exit_m', 25);
    const kmh = this.kmh;
    const P = this.hpLocate(this.loc);
    const y = this.yaw;
    const headErr = norm(y - P.tangentYaw);
    const In = noInput();
    const pursuit = (want: number) => {
      const look = Math.max(6, (kmh / 3.6) * 0.45);
      const target = this.hpWorld(Math.max(P.s, -1000) + look);
      const alpha = norm(yawOf(sub2(target, this.loc)) - y) * DEG;
      const deltaDeg = Math.atan((2 * 2.5 * Math.sin(alpha)) / look) / DEG;
      const limit = c.steerLockScale(c.speedKmh);
      In.steer = clamp(deltaDeg / Math.max(1, c.t.steering.max_angle_deg * limit), -1, 1);
      const err = want - kmh;
      In.throttle = clamp(0.08 * err + 0.3, 0, 1);
      In.throttle *= clamp(1 - (Math.abs(c.bodySlipDeg) - 15) / 35, 0.15, 1);
      if (err < -8) {
        In.throttle = 0;
        In.brake = clamp(-err * 0.03, 0, 0.6);
      }
    };
    if (this.phase === 1) {
      if (this.t <= DT * 1.5) this.launch(entryKmh);
      In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
      In.throttle = clamp(0.1 * (entryKmh - kmh) + 0.3, 0, 1);
      const trigger = variant === 3 ? num(this.Hp, 'none_pursuit_from_m', 12) : leadM;
      if (P.s >= -trigger || this.t > 12) {
        this.phase = 2;
        this.t = 0;
        this.EntryKmh = kmh;
        this.PrevYaw = y;
        this.HpPullT = 0;
        this.HpErrAtPull = headErr;
      }
      return In;
    }
    const pulling = variant !== 3 && this.t < holdS;
    if (pulling) {
      In.steer = pullSteer;
      In.handbrake = true;
      In.throttle = 0;
      this.HpHoldYaw += norm(y - this.PrevYaw);
    } else {
      if (this.HpReleaseT < 0) this.HpReleaseT = this.t;
      const want = P.s < Math.PI * this.HpRadiusM ? num(this.Hp, 'arc_kmh', 35) : num(this.Hp, 'exit_kmh', 60);
      pursuit(Math.abs(headErr) > 100 ? 0 : want);
    }
    this.PrevYaw = y;
    if (this.hpOnApproach(this.loc)) this.HpErrAtTurnIn = Math.max(this.HpErrAtTurnIn, headErr);
    this.HpMaxInside = Math.max(this.HpMaxInside, P.lat);
    this.HpMaxOutside = Math.max(this.HpMaxOutside, -P.lat);
    this.HpMaxHeadErr = Math.max(this.HpMaxHeadErr, Math.abs(headErr));
    this.HpMinKmh = Math.min(this.HpMinKmh, c.speedKmh);
    this.MaxSlip = Math.max(this.MaxSlip, Math.abs(c.bodySlipDeg));
    this.PeakYawRate = Math.max(this.PeakYawRate, Math.abs(c.yawRateDeg));
    if (this.HpOffRoadT < 0 && Math.abs(P.lat) > offM) {
      this.HpOffRoadT = this.t;
      this.HpOffSide = P.lat > 0 ? 'inside' : 'outside';
    }
    if (this.HpExitT < 0 && P.s >= exitS) {
      this.HpExitT = this.t;
      this.HpExitErr = headErr;
    }
    const timeout = num(this.Hp, 'timeout_s', 9);
    const done = this.HpExitT >= 0 || this.t > timeout || (variant === 2 && this.t > holdS + 0.5);
    if (!done) return In;
    let v: string;
    if (variant === 0) {
      v = this.verdict(this.HpExitT >= 0 && this.HpOffRoadT < 0 && this.HpMaxHeadErr <= this.goal('hairpin_good_max_head_err_deg', 100)
        && Math.abs(this.HpExitErr) <= this.goal('hairpin_exit_err_deg', 30));
    } else if (variant === 1) {
      v = this.verdict(this.HpErrAtTurnIn >= this.goal('hairpin_early_point_in_deg', 30) || this.HpOffSide === 'inside');
    } else if (variant === 2) {
      v = this.verdict(this.HpHoldYaw >= this.goal('hairpin_long_min_yaw_deg', 150));
    } else v = 'info';
    const sgn = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(0);
    this.finish(`entry=${this.EntryKmh.toFixed(0)}kmh lead=${(variant === 3 ? 0 : leadM).toFixed(1)}m hold=${(variant === 3 ? 0 : holdS).toFixed(2)}s hold_yaw=${this.HpHoldYaw.toFixed(0)}deg err_pull=${sgn(this.HpErrAtPull)}deg err_before_turnin=${sgn(this.HpErrAtTurnIn)}deg max_head_err=${this.HpMaxHeadErr.toFixed(0)}deg inside=${this.HpMaxInside.toFixed(1)}m outside=${this.HpMaxOutside.toFixed(1)}m off=${this.HpOffRoadT >= 0 ? `${this.HpOffSide}@${this.HpOffRoadT.toFixed(1)}s` : 'no'} exit=${this.HpExitT >= 0 ? this.HpExitT.toFixed(1) + 's' : 'no'} exit_err=${sgn(this.HpExitErr)}deg min_kmh=${this.HpMinKmh.toFixed(0)} maxslip=${this.MaxSlip.toFixed(0)}deg peak_yaw=${this.PeakYawRate.toFixed(0)}deg/s ${v}`);
    return In;
  }

  // ---------------------------------------------------------------- powerslide
  tickPowerSlide(): DriverInput {
    const c = this.car;
    const cfg = this.Ps;
    const variant = Math.round(this.job.param); // 0 hold, 1 off, 2 full, 3 part
    const radius = num(cfg, 'radius_m', 25);
    const speed = num(cfg, 'speed_kmh', 40);
    const settle = num(cfg, 'settle_s', 4);
    const action = num(cfg, 'action_s', 1.2);
    const catchS = num(cfg, 'catch_s', 3);
    const kmh = this.kmh;
    const slip = c.bodySlipDeg;
    const yawRate = c.yawRateDeg;
    const In = noInput();
    if (this.phase === 1) {
      if (this.t <= DT * 1.5) this.launch(speed);
      const center = padCenters[`pad_${this.job.surface}`];
      const P = this.loc;
      const rel = sub2(P, center);
      const phi = Math.atan2(rel.y, rel.x);
      const look = Math.max(7, (kmh / 3.6) * 0.5);
      const phiT = phi + look / radius;
      const target = { x: center.x + Math.cos(phiT) * radius, y: center.y + Math.sin(phiT) * radius };
      const alpha = norm(yawOf(sub2(target, P)) - this.yaw) * DEG;
      const deltaDeg = Math.atan((2 * 2.5 * Math.sin(alpha)) / look) / DEG + 1.5 * (Math.hypot(rel.x, rel.y) - radius);
      const limit = c.steerLockScale(c.speedKmh);
      In.steer = clamp(deltaDeg / Math.max(1, c.t.steering.max_angle_deg * limit), -1, 1);
      In.throttle = clamp(0.08 * (speed - kmh) + 0.25, 0, 1);
      if (this.t > settle - 0.6) {
        this.PsSlipSum += Math.abs(slip);
        this.PsYawSum += yawRate;
        this.PsSteerSum += In.steer;
        this.PsKmhSum += kmh;
        this.PsN++;
      }
      if (this.t >= settle) {
        const n = Math.max(1, this.PsN);
        this.PsSteadySlip = this.PsSlipSum / n;
        this.PsSteadyYaw = this.PsYawSum / n;
        this.PsSteer = this.PsSteerSum / n;
        this.PsSteadyKmh = this.PsKmhSum / n;
        this.PsGear = c.gear;
        this.PsPeakSlip = Math.abs(slip);
        this.PsPeakYaw = yawRate;
        this.phase = 2;
        this.t = 0;
      }
    } else if (this.phase === 2) {
      In.steer = this.PsSteer;
      In.throttle = variant === 0 ? clamp(0.08 * (this.PsSteadyKmh - kmh) + 0.25, 0, 1) : variant === 1 ? 0
        : variant === 3 ? num(cfg, 'part_throttle', 0.7) : 1;
      this.PsPeakSlip = Math.max(this.PsPeakSlip, Math.abs(slip));
      this.PsPeakYaw = Math.max(this.PsPeakYaw, yawRate);
      this.PsActYawSum += yawRate;
      this.PsActN++;
      this.PsMaxStrength = Math.max(this.PsMaxStrength, c.powerStrength);
      this.PsMaxUnder = Math.max(this.PsMaxUnder, c.powerUnder);
      this.PsMaxSpin = Math.max(this.PsMaxSpin, Math.max(c.rearSpinCms, c.frontSpinCms));
      this.MaxSlip = Math.max(this.MaxSlip, Math.abs(slip));
      if (this.t >= action) {
        this.phase = 3;
        this.t = 0;
        this.PeakSlipSigned = slip;
      }
    } else {
      In.steer = clamp(slip / 10 - yawRate / 90, -1, 1);
      In.throttle = 0.5;
      this.MaxSlip = Math.max(this.MaxSlip, Math.abs(slip));
      const calm = Math.abs(slip) < 6 && Math.abs(yawRate) < 15;
      this.CalmTimer = calm ? this.CalmTimer + DT : 0;
      if (this.RecoverT < 0 && this.CalmTimer >= 0.2) this.RecoverT = this.t - 0.2;
    }
    this.Spun ||= this.MaxSlip > this.goal('spin_slip_deg', 75);
    if (this.phase < 3 || this.t < catchS) return In;

    const gain = this.PsPeakSlip - this.PsSteadySlip;
    const actYaw = this.PsActN > 0 ? this.PsActYawSum / this.PsActN : 0;
    const yawRatio = this.PsSteadyYaw > 1 ? actYaw / this.PsSteadyYaw : 0;
    const peakYawRatio = this.PsSteadyYaw > 1 ? this.PsPeakYaw / this.PsSteadyYaw : 0;
    let v = 'info';
    let cmp = '';
    const m = this.ps;
    if (variant === 0) {
      m.holdGain = gain;
      m.holdYawRatio = yawRatio;
    } else if (variant === 1) {
      m.offGain = gain;
      m.offYawRatio = yawRatio;
    } else if (variant === 3) {
      m.partGain = gain;
    } else {
      const D = c.t.drivetrain;
      const pre = `powerslide_${D.toLowerCase()}_`;
      const G = (key: string, d: number) => this.goal(`${pre}${key}_${this.job.surface}`, this.goal(pre + key, d));
      const caught = !this.Spun && this.RecoverT >= 0 && this.RecoverT <= G('recover_s', 2.5);
      let pass = caught && this.PsPeakSlip <= G('max_slip_deg', 60);
      if (D === 'FWD') {
        pass = pass && gain - m.holdGain <= G('max_gain_deg', 3) && yawRatio <= G('max_yaw_ratio', 1.1);
      } else {
        pass = pass && gain - m.holdGain >= G('min_gain_deg', 5) && yawRatio >= G('min_yaw_ratio', 1)
          && m.partGain <= gain + this.goal('powerslide_progressive_tol_deg', 1.5);
      }
      v = this.verdict(pass);
      cmp = ` vs_hold: gain${gain - m.holdGain >= 0 ? '+' : ''}${(gain - m.holdGain).toFixed(1)}deg yaw x${(m.holdYawRatio > 0 ? yawRatio / m.holdYawRatio : 0).toFixed(2)} | hold gain=${m.holdGain.toFixed(1)} yaw x${m.holdYawRatio.toFixed(2)} | off gain=${m.offGain.toFixed(1)} yaw x${m.offYawRatio.toFixed(2)} | part gain=${m.partGain.toFixed(1)}`;
    }
    this.finish(`steady=${this.PsSteadyKmh.toFixed(0)}kmh g${this.PsGear} slip=${this.PsSteadySlip.toFixed(1)} yaw=${this.PsSteadyYaw.toFixed(0)}deg/s steer=${this.PsSteer.toFixed(2)} | peak slip=${this.PsPeakSlip.toFixed(1)}deg gain=${gain >= 0 ? '+' : ''}${gain.toFixed(1)} yaw mean x${yawRatio.toFixed(2)} peak x${peakYawRatio.toFixed(2)} | pw=${this.PsMaxStrength.toFixed(2)} spin=${this.PsMaxSpin.toFixed(0)}cms under=${this.PsMaxUnder.toFixed(2)} | catch=${this.RecoverT.toFixed(2)}s spun=${this.Spun ? 1 : 0} exit=${c.speedKmh.toFixed(0)}kmh${cmp} ${v}`);
    return In;
  }

  // ---------------------------------------------------------------- highspeedtap / lanechange
  tickKeyed(): DriverInput {
    const c = this.car;
    const cfg = this.Kd;
    const holdS = num(cfg, 'hold_s', 1.5);
    const flatS = num(cfg, 'flat_s', 0.6);
    const durS = num(cfg, 'duration_s', 4);
    const swingMin = num(cfg, 'swing_min_dps', 8);
    const kmh = this.kmh;
    const slip = c.bodySlipDeg;
    const yawRate = c.yawRateDeg;
    const In = noInput();
    if (this.phase === 1) {
      if (this.t <= DT * 1.5) this.launch(this.KdTargetKmh);
      In.steer = this.holdLineSteer(this.startLoc, this.startYaw);
      In.throttle = this.t < holdS ? clamp(0.1 * (this.KdTargetKmh - kmh) + 0.3, 0, 1) : 1;
      if (this.t > holdS) this.KdStraightSpin = Math.max(this.KdStraightSpin, c.rearSpinCms);
      if (this.t > holdS + flatS) {
        this.phase = 2;
        this.t = 0;
        this.EntryKmh = kmh;
        this.KdGear = c.gear;
      }
    } else {
      let steer = 0;
      for (const [kt, ks] of this.KdKeys) if (this.t >= kt) steer = ks;
      In.steer = steer;
      In.digitalSteer = true;
      In.throttle = 1;
      this.MaxSlip = Math.max(this.MaxSlip, Math.abs(slip));
      this.KdMaxYaw = Math.max(this.KdMaxYaw, Math.abs(yawRate));
      this.KdMaxStr = Math.max(this.KdMaxStr, c.powerStrength);
      this.KdMaxPw = Math.max(this.KdMaxPw, c.powerSlide);
      this.KdMaxSpin = Math.max(this.KdMaxSpin, c.rearSpinCms);
      this.KdLateralM = dot2(sub2(this.loc, this.startLoc), right2(this.startYaw));
      if (this.t > this.KdLastKeyT) {
        const sign = yawRate > swingMin ? 1 : yawRate < -swingMin ? -1 : 0;
        if (sign !== 0 && sign !== this.KdSign) {
          if (this.KdSign !== 0) {
            this.KdSwings++;
            if (this.KdPeakN > 0 && this.KdHalfPeak > this.KdLastPeak * 1.1 && this.KdHalfPeak > 15) this.KdGrowing = true;
            if (this.KdPeakN > 0) this.KdMaxPeakGrowth = Math.max(this.KdMaxPeakGrowth, this.KdHalfPeak / Math.max(1, this.KdLastPeak));
            this.KdLastPeak = this.KdHalfPeak;
            this.KdPeakN++;
          }
          this.KdSign = sign;
          this.KdHalfPeak = 0;
        }
        this.KdHalfPeak = Math.max(this.KdHalfPeak, Math.abs(yawRate));
        const calm = Math.abs(slip) < num(cfg, 'settle_slip_deg', 3) && Math.abs(yawRate) < num(cfg, 'settle_yaw_dps', 8);
        this.CalmTimer = calm ? this.CalmTimer + DT : 0;
        if (this.KdSettleT < 0 && this.CalmTimer >= 0.3) this.KdSettleT = this.t - this.KdLastKeyT - 0.3;
        if (!calm && this.KdSettleT >= 0 && Math.abs(slip) > 6) this.KdSettleT = -1;
      }
    }
    this.Spun ||= this.MaxSlip > this.goal('spin_slip_deg', 75);
    if (this.phase < 2 || this.t < durS) return In;
    const pre = `${this.job.kind}_`;
    const G = (key: string, d: number) => this.goal(`${pre}${key}_${this.job.surface}`, this.goal(pre + key, d));
    const settled = G('require_settle', 1) < 0.5 || (this.KdSettleT >= 0 && this.KdSettleT <= G('settle_s', 1.5));
    const pass = !this.Spun && this.MaxSlip <= G('max_slip_deg', 8) && settled && this.KdSwings <= Math.trunc(G('max_swings', 2))
      && !this.KdGrowing && this.KdMaxSpin <= G('max_spin_cms', 1e6);
    this.finish(`entry=${this.EntryKmh.toFixed(0)}kmh g${this.KdGear} straight_spin=${this.KdStraightSpin.toFixed(0)}cms | maxslip=${this.MaxSlip.toFixed(1)}deg maxyaw=${this.KdMaxYaw.toFixed(0)}deg/s pw=${this.KdMaxPw.toFixed(2)} str=${this.KdMaxStr.toFixed(2)} spin=${this.KdMaxSpin.toFixed(0)}cms swings=${this.KdSwings} growth=x${this.KdMaxPeakGrowth.toFixed(2)}${this.KdGrowing ? ' GROWING' : ''} settle=${this.KdSettleT.toFixed(2)}s lat=${this.KdLateralM.toFixed(1)}m spun=${this.Spun ? 1 : 0} exit=${c.speedKmh.toFixed(0)}kmh ${this.verdict(pass)}`);
    return In;
  }
}

interface PsMemory { key: string; holdGain: number; holdYawRatio: number; offGain: number; offYawRatio: number; partGain: number }

function kindName(j: Job): string {
  const hp = ['good', 'early', 'long', 'none'];
  let k = j.kind;
  if (j.kind === 'coast') k = `coast${j.param}`;
  else if (j.kind === 'hairpin') k = `hairpin_${hp[clamp(Math.trunc(j.param), 0, 3)]}`;
  else if (j.kind === 'powerslide') k = `powerslide_${j.param < 0.5 ? 'hold' : j.param < 1.5 ? 'off' : j.param < 2.5 ? 'full' : 'part'}`;
  else if (j.kind === 'highspeedtap' && j.param < 0) k = `highspeedtap_g${Math.round(-j.param)}`;
  return j.ta === 0 ? `${k}_ta0` : k;
}

// ---------------------------------------------------------------- main
async function main() {
  // --tyre key=value[,key=value]: override the tyre constants for a tuning sweep
  for (const kv of (arg('--tyre', '') ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in TYRE)) throw new Error(`unknown tyre constant ${k}`);
    (TYRE as Record<string, number>)[k] = Number(v);
  }
  const cars = (arg('--cars', 'all')!).split(',').flatMap((c) => (c === 'all' ? ALL_CARS : [c]));
  const kindsArg = arg('--kinds', 'all')!;
  const kinds = kindsArg === 'all'
    ? ['accel', 'corner', 'handbrake', 'lockturn', 'coast', 'tap', 'flick', 'power', 'reverse', 'hairpin', 'brake', 'powerslide', 'highspeedtap', 'lanechange']
    : kindsArg === 'feel'
      ? ['corner', 'handbrake', 'coast', 'tap', 'flick', 'power', 'reverse', 'hairpin', 'brake', 'powerslide', 'highspeedtap', 'lanechange']
      : kindsArg.split(',');
  const surfaces = (arg('--surfaces', 'tarmac,gravel')!).split(',');
  const quiet = process.argv.includes('--quiet');
  const uePath = arg('--ue');
  const ue = new Map<string, string>();
  if (uePath && existsSync(uePath)) {
    for (const line of readFileSync(uePath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^(\S+) (\S+) (\S+) (.*)$/);
      if (m) ue.set(`${m[1]} ${m[2]} ${m[3]}`, m[4]);
    }
  }
  const rapier = await initPhysics();
  const jobs = expandJobs(cars, kinds, surfaces);
  const ps: PsMemory = { key: '', holdGain: 0, holdYawRatio: 0, offGain: 0, offYawRatio: 0, partGain: 0 };
  const lines: string[] = [];
  let pass = 0, fail = 0;
  const failed: string[] = [];
  const t0 = performance.now();
  for (const job of jobs) {
    const run = new Run(job, rapier, ps);
    run.begin();
    let steps = 0;
    while (!run.done && steps < 120 * 150) {
      run.tick();
      steps++;
    }
    if (!run.done) run.finish('timeout FAIL');
    run.world.free();
    const key = `${job.car} ${kindName(job)} ${job.surface}`;
    const line = `${key} ${run.result}`;
    lines.push(line);
    if (line.endsWith('PASS')) pass++;
    else if (line.endsWith('FAIL')) {
      fail++;
      failed.push(key);
    }
    if (!quiet || line.endsWith('FAIL')) {
      console.log(line);
      if (ue.has(key)) console.log(`   ue: ${ue.get(key)}`);
    }
  }
  console.log(`\n${jobs.length} jobs, ${pass} pass, ${fail} fail, ${jobs.length - pass - fail} info (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  if (failed.length) console.log(`failed: ${failed.join(', ')}`);
  const csv = arg('--csv');
  if (csv) writeFileSync(csv, lines.join('\n') + '\n');
  process.exitCode = fail ? 1 : 0;
}

main();
