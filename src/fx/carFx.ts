// The car's ground effects, ported from the original's URallyCarFxComponent (TickDust, TickSkids,
// TickLanding, ImpactSparks) with fx.json's values: dust per wheel by speed and slip, gravel chips
// while sliding, grass flecks off the road, skid marks, the dust ring of a landing and the sparks of
// a crash. It only reads the vehicle; nothing here reaches the simulation.
import * as THREE from 'three/webgpu';
import type { Color } from 'three';
import type { Vehicle } from '../sim/vehicle';
import type { Surface } from '../sim/tuning';
import { hexLinear, hexList, lerp, ramp, type FxJson, type Rng } from './config';
import type { Pool } from './pool';
import type { SkidMarks } from './skids';

const CM = 0.01;

export interface CarFxPools {
  dust: Pool;
  chip: Pool;
  spark: Pool;
}

export class CarFx {
  /** Emission multiplier (quality tier). */
  scale = 1;
  /** Condition colour multiplier (fx.json condition_tint) and night (0/1). */
  tint = new THREE.Color(1, 1, 1);
  night = 0;
  private dustAcc = [0, 0, 0, 0];
  private chipAcc = [0, 0, 0, 0];
  private skidActive = [false, false, false, false];
  private skidLast = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private colours = new Map<string, Color[]>();
  private c = new THREE.Color();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(private cfg: FxJson, private pools: CarFxPools, private skids: SkidMarks, private rng: Rng, private wheelWidth: number) {}

  private cols(key: string, v: string[] | string | undefined): Color[] {
    let c = this.colours.get(key);
    if (!c) this.colours.set(key, (c = hexList(v)));
    return c;
  }

  /** After a teleport (reset, recover, restart): no mark or trail across the jump. */
  resetTrails(): void {
    this.dustAcc.fill(0);
    this.chipAcc.fill(0);
    this.skidActive.fill(false);
  }

  update(veh: Vehicle, dt: number, now: number, handbrake: boolean): void {
    if (dt <= 0) return;
    const p = veh.position;
    const jump = Math.max(8, veh.velocity.length() * dt * 4);
    if (p.distanceToSquared(this.lastPos) > jump * jump) this.resetTrails();
    this.lastPos.copy(p);
    this.dust(veh, dt);
    this.marks(veh, now, handbrake);
  }

  // ------------------------------------------------------------------ dust, chips, flecks
  private dust(veh: Vehicle, dt: number): void {
    const D = this.cfg.dust, chips = this.cfg.chips, flecks = this.cfg.flecks, rng = this.rng;
    const kmh = veh.speedKmh;
    const V = veh.velocity, F = veh.forward, R = veh.right;
    const scale = this.scale;
    for (let i = 0; i < 4 && i < veh.wheels.length; i++) {
      const w = veh.wheels[i];
      if (!w.inContact) continue;
      const surface = w.surface;
      const slip = Math.abs(w.latSlipCms) + Math.max(0, Math.abs(w.longSlipCms) - 150);
      const slip01 = ramp(slip, D.slip_start_cms, D.slip_full_cms);
      const cp = w.contactPoint;

      // ---- dust puffs
      const S = D.surfaces[surface];
      if (S) {
        const speed01 = ramp(kmh, S.min_kmh ?? D.min_kmh, D.full_kmh);
        const slipOnly = S.slip_only ?? 0;
        const intensity = lerp(speed01, speed01 * slip01, slipOnly) * (1 + D.slip_boost * slip01);
        this.dustAcc[i] += S.rate * D.rate_scale * intensity * scale * dt;
        const cols = this.cols(`dust:${surface}`, S.color);
        while (this.dustAcc[i] >= 1) {
          this.dustAcc[i] -= 1;
          const back = rng.range(10, 60) * CM;
          const col = cols[rng.int(0, cols.length - 1)];
          const rise = rng.pick(D.rise_cms, 40, 110) * CM;
          const sx = rng.range(-1, 1), sz = rng.range(-1, 1);
          this.pools.dust.emit({
            x: cp.x - F.x * back + rng.range(-25, 25) * CM,
            y: cp.y - F.y * back + D.lift_cm * CM,
            z: cp.z - F.z * back + rng.range(-25, 25) * CM,
            vx: V.x * D.inherit + sx * D.spread_cms * CM,
            vy: V.y * D.inherit + rise,
            vz: V.z * D.inherit + sz * D.spread_cms * CM,
            life: rng.pick(S.life_s, 1.4, 2.6) * lerp(0.7, 1, intensity),
            size0: rng.pick(S.size0_cm, 60, 110) * D.size_scale * CM,
            size1: rng.pick(S.size1_cm, 240, 420) * lerp(0.6, 1, intensity) * D.size_scale * CM,
            r: col.r * this.tint.r, g: col.g * this.tint.g, b: col.b * this.tint.b,
            opacity: S.opacity,
            emissive: D.night_emissive * this.night,
            drag: D.drag,
            gravity: 0,
            spin: rng.range(-40, 40),
            fadeIn: 0.06,
            fadeOutStart: D.fade_out_start,
          });
        }
      }

      // ---- gravel chips (sliding / wheelspin) and grass flecks (off the road at speed)
      const chipS = chips.surfaces[surface];
      const fleckS = chipS ? undefined : flecks.surfaces[surface];
      const src = chipS ?? fleckS;
      let rate = 0;
      if (chipS) rate = chipS.rate * slip01 * ramp(kmh, 8, 40);
      else if (fleckS) rate = fleckS.rate * ramp(kmh, flecks.min_kmh, flecks.full_kmh) * (1 + slip01);
      this.chipAcc[i] += rate * scale * dt;
      if (src && this.chipAcc[i] >= 1) {
        const cols = this.cols(`chip:${surface}`, src.colors);
        // flung back along the slide: against the contact-patch slip, plus the wheel's backward spray
        const side = -Math.sign(w.latSlipCms) * Math.min(1, Math.abs(w.latSlipCms) / 400);
        const sd = this.dir.set(R.x * side - F.x, R.y * side - F.y, R.z * side - F.z).normalize();
        while (this.chipAcc[i] >= 1) {
          this.chipAcc[i] -= 1;
          const u = rng.unit(this.v2);
          const spread = this.v.set(sd.x + u.x * 0.45, sd.y + u.y * 0.45, sd.z + u.z * 0.45).normalize().multiplyScalar(rng.pick(src.speed_cms, 350, 900) * CM);
          const col = cols[rng.int(0, cols.length - 1)];
          const size = rng.pick(src.size_cm, 7, 14) * CM;
          this.pools.chip.emit({
            x: cp.x + rng.range(-15, 15) * CM, y: cp.y + 8 * CM, z: cp.z + rng.range(-15, 15) * CM,
            // horizontal spread (three y is up), plus the upward flick
            vx: V.x * 0.45 + spread.x, vy: V.y * 0.45 + rng.pick(src.up_cms, 200, 550) * CM, vz: V.z * 0.45 + spread.z,
            life: rng.pick(src.life_s, 0.9, 1.6),
            size0: size, size1: size,
            r: col.r * this.tint.r, g: col.g * this.tint.g, b: col.b * this.tint.b,
            emissive: chips.night_emissive * this.night,
            drag: 0.6,
            gravity: 9.8,
            spin: rng.range(400, 1200),
            floorY: cp.y + 1 * CM,
            fadeIn: 0.01,
            fadeOutStart: 0.7,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------ skid marks
  private marks(veh: Vehicle, now: number, handbrake: boolean): void {
    const K = this.cfg.skid;
    const seg = K.segment_cm * CM;
    const kmh = veh.speedKmh;
    const width = this.wheelWidth * K.width_scale;
    for (let i = 0; i < 4 && i < veh.wheels.length; i++) {
      const w = veh.wheels[i];
      const S = K.surfaces[w.surface];
      let mark = 0;
      if (w.inContact && S && kmh > K.min_kmh) {
        mark = Math.max(ramp(Math.abs(w.latSlipCms), K.lat_start_cms, K.lat_full_cms), ramp(Math.abs(w.longSlipCms), K.long_start_cms, K.long_full_cms));
        if (handbrake && i >= 2) mark = Math.max(mark, K.handbrake_mark);
        mark = Math.max(mark, S.always ?? 0);
        mark *= S.strength ?? 1;
      }
      // hysteresis: a running mark continues down to half the start threshold (no dashed marks)
      if (mark < K.min_mark * (this.skidActive[i] ? 0.5 : 1)) {
        this.skidActive[i] = false;
        continue;
      }
      const P = w.contactPoint;
      if (!this.skidActive[i]) {
        this.skidActive[i] = true;
        this.skidLast[i].copy(P);
        continue;
      }
      if (P.distanceToSquared(this.skidLast[i]) < seg * seg) continue;
      const col = this.cols(`skid:${w.surface}`, S!.color)[0];
      this.skids.add(this.skidLast[i], P, w.normal, width, col, S!.opacity * lerp(0.55, 1, mark), now);
      this.skidLast[i].copy(P);
    }
  }

  // ------------------------------------------------------------------ landing ring, impact sparks
  /** The dust ring of a landing (the original's TickLanding), `strength` = fall speed / 7 m/s, 0.3..1.5. */
  landing(veh: Vehicle, strength: number, surface: Surface): void {
    const L = this.cfg.landing, D = this.cfg.dust, rng = this.rng;
    const S = D.surfaces[surface];
    const count = Math.round(L.count * D.rate_scale * strength * ((S?.slip_only ?? 0) > 0.5 ? 0.4 : 1) * this.scale);
    const cols = this.cols(`dust:${surface}`, S?.color ?? '#8C8073');
    const C = veh.position, V = veh.velocity;
    for (let k = 0; k < count; k++) {
      const a = (2 * Math.PI * (k + rng.next() * 0.5)) / Math.max(1, count);
      // UE's ring direction (cos, sin) in its X/Y plane -> three x/z
      const dx = Math.cos(a), dz = Math.sin(a);
      const sp = rng.pick(L.speed_cms, 250, 500) * CM;
      const col = cols[rng.int(0, cols.length - 1)];
      this.pools.dust.emit({
        x: C.x + dx * L.ring_cm * CM, y: C.y - 25 * CM, z: C.z + dz * L.ring_cm * CM,
        vx: dx * sp + V.x * 0.3, vy: V.y * 0.3 + 60 * CM, vz: dz * sp + V.z * 0.3,
        life: rng.pick(L.life_s, 1.2, 2.2),
        size0: rng.pick(L.size0_cm, 80, 130) * D.size_scale * CM,
        size1: rng.pick(L.size1_cm, 260, 380) * D.size_scale * CM,
        r: col.r * this.tint.r, g: col.g * this.tint.g, b: col.b * this.tint.b,
        opacity: S?.opacity ?? 0.8,
        emissive: D.night_emissive * this.night,
        drag: 2,
        fadeIn: 0.05,
        fadeOutStart: 0.3,
      });
    }
  }

  /** Sparks and a puff of debris dust where the car hit something (the original's ImpactSparks). */
  impact(veh: Vehicle, pos: THREE.Vector3, normal: THREE.Vector3, kmh: number): void {
    const I = this.cfg.impact_sparks, rng = this.rng;
    const count = Math.min(Math.max(Math.round(kmh * I.per_kmh), I.min), I.max);
    const col = this.cols('impact', I.color)[0];
    const V = veh.velocity;
    for (let k = 0; k < count; k++) {
      const u = rng.unit(this.v2);
      const d = this.v.set(normal.x + u.x * 0.9, normal.y + u.y * 0.9 + 0.4, normal.z + u.z * 0.9).normalize().multiplyScalar(rng.range(4, 12));
      const size = rng.range(3, 6) * CM;
      this.pools.spark.emit({
        x: pos.x + normal.x * 0.1, y: pos.y + normal.y * 0.1, z: pos.z + normal.z * 0.1,
        vx: d.x + V.x * 0.3, vy: d.y + V.y * 0.3, vz: d.z + V.z * 0.3,
        life: rng.range(0.25, 0.7), size0: size, size1: size, stretch: 4,
        r: col.r, g: col.g, b: col.b, emissive: I.emissive, drag: 1, gravity: 9.8, floorY: pos.y - 0.8, fadeIn: 0.01, fadeOutStart: 0.6,
      });
    }
    const puffs = Math.min(Math.max(Math.round(kmh / 15), 1), 6);
    const dc = this.c.copy(hexLinear(I.dust_color)).multiply(this.tint);
    for (let k = 0; k < puffs; k++) {
      const u = rng.unit(this.v2);
      const s = rng.range(1, 3);
      this.pools.dust.emit({
        x: pos.x + u.x * 0.4, y: pos.y + u.y * 0.4, z: pos.z + u.z * 0.4,
        vx: normal.x * s, vy: normal.y * s + 0.8, vz: normal.z * s,
        life: rng.range(1, 1.8), size0: 0.6, size1: rng.range(1.8, 2.8),
        r: dc.r, g: dc.g, b: dc.b, opacity: 0.8, drag: 2, fadeOutStart: 0.35,
      });
    }
  }
}
