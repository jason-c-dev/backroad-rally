// Exhaust pops and flames, ported from the original's TickExhaust / EmitPop with fx.json `exhaust`:
// a pop sequence on a quick lift-off at revs, on hard upshifts and on downshifts off throttle, and
// the turbo cars' anti-lag crackle for a while after a lift. Every pop emits a `backfire` event
// (audio) and, when effects are on, flames and sparks at each pipe. Reads the car, never writes it.
import * as THREE from 'three/webgpu';
import type { Vehicle } from '../sim/vehicle';
import { events } from '../game/events';
import { hexList, type FxJson, type Rng } from './config';
import type { Pool } from './pool';

const CM = 0.01;
type Ex = Record<string, number | number[] | string | string[]>;

export class Exhaust {
  /** Draw flames and sparks (events fire either way). */
  visible = true;
  pops = 0;
  antilagPops = 0;
  private ex: Ex;
  private popScale: number;
  private extraPops: number;
  private antilag: boolean;
  private pipes: THREE.Vector3[];
  private flameCols;
  private sparkCol;
  private popCooldown = 0;
  private sequenceCooldown = 0;
  private antilagCooldown = 0;
  private throttleHigh = 0;
  private prevThrottle = 0;
  private prevGear = 1;
  private pending = 0;
  private popTimer = 0;
  private liftTimer = -1;
  private antilagTimer = 0;
  private at = new THREE.Vector3();
  private back = new THREE.Vector3();
  private u = new THREE.Vector3();

  constructor(cfg: FxJson, carId: string, exhaustPosCm: number[][] | undefined, lengthM: number,
    private flames: Pool, private sparks: Pool, private rng: Rng) {
    this.ex = cfg.exhaust;
    const car = cfg.cars[carId] ?? {};
    this.popScale = car.backfire_scale ?? 1;
    this.extraPops = this.popScale > 1.05 ? 1 : 0;
    this.antilag = !!car.antilag;
    // car-local UE cm (X forward, Y right, Z up) -> three metres (x forward, y up, z right)
    const pipes = exhaustPosCm?.length ? exhaustPosCm : [[(-lengthM * 100) / 2, 40, 25]];
    this.pipes = pipes.map((p) => new THREE.Vector3(p[0] * CM, p[2] * CM, p[1] * CM));
    this.flameCols = hexList(this.ex.flame_colors as string[]);
    this.sparkCol = hexList(this.ex.spark_color as string)[0];
  }

  private n(k: string, d: number): number {
    const v = this.ex[k];
    return typeof v === 'number' ? v : d;
  }
  private r(k: string, lo: number, hi: number): number {
    return this.rng.pick(this.ex[k] as [number, number] | undefined, lo, hi);
  }

  /** Once a frame: `pos`/`rot` = the drawn car pose. */
  update(veh: Vehicle, dt: number, pos: THREE.Vector3, rot: THREE.Quaternion): void {
    if (dt <= 0) return;
    const t = veh.t, rng = this.rng;
    const rpm01 = veh.rpm / Math.max(1, t.maxRpm);
    const throttle = veh.input.throttle;
    const gear = veh.gear;
    this.popCooldown = Math.max(0, this.popCooldown - dt);
    this.sequenceCooldown = Math.max(0, this.sequenceCooldown - dt);
    this.throttleHigh = throttle > this.n('lift_from_throttle', 0.7) ? 0 : this.throttleHigh + dt;
    const liftTo = this.n('lift_to_throttle', 0.2);
    const lift = this.prevThrottle > liftTo && throttle <= liftTo && this.throttleHigh < this.n('lift_window_s', 0.25);
    this.antilagCooldown = Math.max(0, this.antilagCooldown - dt);
    if (lift) {
      if (this.antilagCooldown <= 0) {
        this.liftTimer = 0; // opens an anti-lag window (at most one per antilag_cooldown_s)
        this.antilagCooldown = this.n('antilag_cooldown_s', 2.5);
      }
      if (this.sequenceCooldown <= 0 && rpm01 > this.n('lift_rpm_norm', 0.6) && rng.next() < this.n('lift_chance', 0.75) * this.popScale) {
        this.sequenceCooldown = this.n('sequence_cooldown_s', 1.5);
        this.pending += rng.int(this.n('pops_min', 1), this.n('pops_max', 3) + this.extraPops);
        this.popTimer = rng.range(0.02, 0.08);
      }
    } else if (this.liftTimer >= 0) {
      this.liftTimer += dt;
    }
    if (gear > this.prevGear && this.prevGear >= 1 && this.sequenceCooldown <= 0 && rpm01 > this.n('upshift_rpm_norm', 0.8)
      && rng.next() < this.n('upshift_chance', 0.4) * this.popScale) {
      // hard upshift
      this.sequenceCooldown = this.n('sequence_cooldown_s', 1.5);
      this.pending += 1 + this.extraPops;
      this.popTimer = 0.03;
    } else if (gear < this.prevGear && gear >= 1 && throttle < 0.5 && this.sequenceCooldown <= 0 && rpm01 > this.n('downshift_rpm_norm', 0.5)
      && rng.next() < this.n('downshift_chance', 0) * this.popScale) {
      // downshift off throttle
      this.sequenceCooldown = this.n('downshift_cooldown_s', 0.8);
      this.pending += rng.int(1, 2 + this.extraPops);
      this.popTimer = rng.range(0.05, 0.12);
    }
    this.prevGear = gear;
    this.prevThrottle = throttle;

    if (this.pending > 0 && this.popCooldown <= 0) {
      this.popTimer -= dt;
      if (this.popTimer <= 0) {
        this.pending--;
        this.popTimer = this.r('pop_gap_s', 0.07, 0.16);
        this.backfire(veh, Math.min(Math.max(rpm01 + 0.2, 0.5), 1.2), false, pos, rot);
      }
    }
    // anti-lag (turbo cars): crackle while off throttle at revs, for a while after each lift
    if (this.antilag && throttle < 0.2 && this.liftTimer >= 0 && this.liftTimer < this.n('antilag_window_s', 1.4)
      && rpm01 > this.n('antilag_rpm_norm', 0.4) && veh.speedKmh > 20) {
      this.antilagTimer -= dt;
      if (this.antilagTimer <= 0) {
        this.antilagTimer = 1 / Math.max(0.5, this.r('antilag_rate_hz', 5, 10));
        this.backfire(veh, rng.range(0.5, 0.9), true, pos, rot);
      }
    }
  }

  private backfire(veh: Vehicle, intensity: number, antilag: boolean, pos: THREE.Vector3, rot: THREE.Quaternion): void {
    if (antilag) this.antilagPops++;
    else this.pops++;
    this.popCooldown = 0.04;
    const back = this.back.set(-1, 0, 0).applyQuaternion(rot);
    const at = this.at.copy(this.pipes[0]).applyQuaternion(rot).add(pos).addScaledVector(back, 0.15);
    this.own = true;
    events.emit('backfire', { pos: at.clone(), intensity, antilag });
    this.own = false;
    if (this.visible) this.emitPop(veh, intensity, antilag, pos, rot);
  }

  /**
   * Pops that someone else raised (the engine audio's rev-limiter pops, src/audio): draw their flames
   * too, so each pop has one sound and one flame. Called from the backfire listener (Fx).
   */
  external(veh: Vehicle, intensity: number, antilag: boolean, pos: THREE.Vector3, rot: THREE.Quaternion): void {
    if (this.own || !this.visible) return;
    this.limiterPops++;
    this.back.set(-1, 0, 0).applyQuaternion(rot);
    this.emitPop(veh, intensity, antilag, pos, rot);
  }
  private own = false;
  limiterPops = 0;

  private emitPop(veh: Vehicle, intensity: number, antilag: boolean, pos: THREE.Vector3, rot: THREE.Quaternion): void {
    const rng = this.rng, V = veh.velocity, back = this.back;
    for (const pipe of this.pipes) {
      const at = this.at.copy(pipe).applyQuaternion(rot).add(pos).addScaledVector(back, 0.15);
      const flames = Math.round(this.n(antilag ? 'antilag_flames' : 'flames', antilag ? 4 : 3) * intensity);
      for (let k = 0; k < Math.max(1, flames); k++) {
        const u = rng.unit(this.u);
        const s = rng.range(3, 7);
        const size = this.r('flame_size_cm', 18, 30) * intensity * CM;
        const c = this.flameCols[rng.int(0, this.flameCols.length - 1)];
        const e = this.n('flame_emissive', 30);
        this.flames.emit({
          x: at.x + back.x * k * 0.12, y: at.y + back.y * k * 0.12, z: at.z + back.z * k * 0.12,
          vx: V.x + back.x * s + u.x * 0.6, vy: V.y + back.y * s + u.y * 0.6, vz: V.z + back.z * s + u.z * 0.6,
          life: this.r('flame_life_s', 0.08, 0.16) * (antilag ? 1.4 : 1),
          size0: size, size1: size * 0.4, stretch: 1.8,
          r: c.r, g: c.g, b: c.b, emissive: e, emissiveDecay: e * 4, drag: 6, fadeIn: 0.01, fadeOutStart: 0.4,
        });
      }
      const sparks = Math.round(this.n('sparks', 6) * intensity);
      for (let k = 0; k < sparks; k++) {
        const u = rng.unit(this.u);
        const d = u.set(back.x + u.x * 0.6, back.y + u.y * 0.6, back.z + u.z * 0.6).normalize().multiplyScalar(rng.range(3, 8));
        const size = rng.range(3, 5) * CM;
        this.sparks.emit({
          x: at.x, y: at.y, z: at.z,
          vx: V.x * 0.8 + d.x, vy: V.y * 0.8 + d.y + 1.5, vz: V.z * 0.8 + d.z,
          life: rng.range(0.2, 0.45), size0: size, size1: size, stretch: 4,
          r: this.sparkCol.r, g: this.sparkCol.g, b: this.sparkCol.b, emissive: this.n('spark_emissive', 40),
          drag: 1, gravity: 9.8, fadeIn: 0.01, fadeOutStart: 0.6,
        });
      }
    }
  }
}
