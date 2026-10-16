// Damage smoke and fire from the engine, ported from the original's URallyCarFxComponent::TickDamage
// with fx.json `damage_fx`: smoke into the dust pool from damage.json smoke_from (more, bigger and
// darker as the damage grows), flames into the flame pool from fire_from (and once the car is wrecked).
// The original also hung a flickering point light over the fire; here the flames are emissive and the
// bloom carries them, because a light added mid-run recompiles every material in three.js and costs
// every pixel on an integrated GPU. Reads the car and the damage, never writes them.
import * as THREE from 'three/webgpu';
import type { Color } from 'three';
import { hexLinear, hexList, lerp, type FxJson, type Rng } from './config';
import type { Pool } from './pool';

const CM = 0.01;

export interface DamageFxConfig {
  smoke_rate_min: number;
  smoke_rate_max: number;
  smoke_light: string;
  smoke_dark: string;
  smoke_rise_cms: [number, number];
  smoke_life_s: [number, number];
  fire_rate: number;
  fire_colors: string[];
  fire_life_s: [number, number];
  fire_size_cm: [number, number];
  fire_emissive: number;
  smoke_opacity_light: number;
  smoke_opacity_heavy: number;
  smoke_spread_cms: number;
}

/** What the effect reads from the damage model (src/game/damage.ts). */
export interface DamageState {
  value: number;
  terminal: boolean;
  smokeFrom: number;
  fireFrom: number;
}

export class DamageFx {
  /** Emission multiplier (quality tier). */
  scale = 1;
  smokeEmitted = 0;
  fireEmitted = 0;
  private cfg: DamageFxConfig;
  private engine: THREE.Vector3;
  private light: Color;
  private dark: Color;
  private fireCols: Color[];
  private smokeAcc = 0;
  private fireAcc = 0;
  private at = new THREE.Vector3();
  private u = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(fx: FxJson, carId: string, lengthCm: number, private smoke: Pool, private flame: Pool, private rng: Rng) {
    this.cfg = (fx as unknown as { damage_fx: DamageFxConfig }).damage_fx;
    // UE car frame cm (x forward, y right, z up) -> three local metres (x forward, y up, z right)
    const e = fx.cars[carId]?.engine_pos_cm ?? [lengthCm * 0.32, 0, 75];
    this.engine = new THREE.Vector3(e[0] * CM, e[2] * CM, e[1] * CM);
    this.light = hexLinear(this.cfg.smoke_light);
    this.dark = hexLinear(this.cfg.smoke_dark);
    this.fireCols = hexList(this.cfg.fire_colors);
  }

  /** Once a frame: `pos`/`rot` = the drawn car pose, `vel` = the car's velocity (m/s). */
  update(dt: number, d: DamageState, pos: THREE.Vector3, rot: THREE.Quaternion, vel: THREE.Vector3): void {
    const smoke = d.value >= d.smokeFrom;
    const fire = d.value >= d.fireFrom || d.terminal;
    if (!smoke || dt <= 0) {
      this.smokeAcc = this.fireAcc = 0;
      return;
    }
    const C = this.cfg, rng = this.rng;
    const engine = this.at.copy(this.engine).applyQuaternion(rot).add(pos);
    const heavy = Math.min(Math.max((d.value - d.smokeFrom) / Math.max(0.01, 1 - d.smokeFrom), 0), 1);
    this.smokeAcc += lerp(C.smoke_rate_min, C.smoke_rate_max, heavy) * this.scale * dt;
    const col = this.c.copy(this.light).lerp(this.dark, heavy);
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const u = rng.unit(this.u);
      const rise = rng.pick(C.smoke_rise_cms, 120, 220) * CM;
      const sx = rng.range(-1, 1), sz = rng.range(-1, 1);
      const spread = C.smoke_spread_cms * CM;
      this.smoke.emit({
        x: engine.x + u.x * 0.2, y: engine.y + u.y * 0.2, z: engine.z + u.z * 0.2,
        vx: vel.x * 0.55 + u.x * 0.4 + sx * spread,
        vy: vel.y * 0.55 + rise + u.y * 0.4,
        vz: vel.z * 0.55 + u.z * 0.4 + sz * spread,
        life: rng.pick(C.smoke_life_s, 1.8, 3.2),
        size0: lerp(30, 60, heavy) * CM,
        size1: lerp(140, 300, heavy) * rng.range(0.8, 1.2) * CM,
        r: col.r, g: col.g, b: col.b,
        opacity: lerp(C.smoke_opacity_light, C.smoke_opacity_heavy, heavy),
        drag: 1.8,
        gravity: 0,
        spin: rng.range(-60, 60),
        fadeIn: 0.1,
        fadeOutStart: 0.4,
      });
      this.smokeEmitted++;
    }
    if (!fire) {
      this.fireAcc = 0;
      return;
    }
    this.fireAcc += C.fire_rate * this.scale * dt;
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      // a box around the engine: UE (±35, ±35, -5..15) cm in its x, y, z
      const ox = rng.range(-35, 35) * CM, oz = rng.range(-35, 35) * CM, oy = rng.range(-5, 15) * CM;
      const p = this.u.set(ox, oy, oz).applyQuaternion(rot);
      const size = rng.pick(C.fire_size_cm, 25, 55) * CM;
      const fc = this.fireCols[rng.int(0, this.fireCols.length - 1)];
      this.flame.emit({
        x: engine.x + p.x, y: engine.y + p.y, z: engine.z + p.z,
        vx: vel.x * 0.85, vy: vel.y * 0.85 + rng.range(120, 260) * CM, vz: vel.z * 0.85,
        life: rng.pick(C.fire_life_s, 0.25, 0.5),
        size0: size, size1: size * 0.3,
        r: fc.r, g: fc.g, b: fc.b,
        emissive: C.fire_emissive,
        emissiveDecay: C.fire_emissive * 1.5,
        drag: 2.5,
        spin: rng.range(-200, 200),
        fadeIn: 0.05,
        fadeOutStart: 0.5,
      });
      this.fireEmitted++;
    }
  }
}
