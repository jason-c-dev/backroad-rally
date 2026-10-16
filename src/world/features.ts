// A stage's location features (UE AStageActor::LoadFeatures / UpdateFeatures, stage_runtime.json
// `features`): fords, the wooden-bridge spans, the canyon rock fade and the covered bridge's shadow.
//
//   fords       stage.json `fords` (s range, water height). While the car is in one (s within 2 m, within
//               the road + 4 m, wheels below water + wheel_depth, faster than min_kmh) it gets a horizontal
//               drag of drag_per_s x velocity (an acceleration, mass independent), spray (the dust pool, so
//               it stays soft) and a splash sound (carEvents' `waterAt` -> the `splash` event -> audio).
//   bridges     unique stage meshes listed in bridge_meshes: the road's s span inside their bounds (+0.5 m,
//               +3 m up), for the covered bridge's shadow (and the rumble, which audio computes the same way).
//   rock fade   rock_fade_zones.<stage>: s ranges where the uniform RockFade ramps to 1 over rock_fade_ramp_m,
//               so the canyon walls (terrain Rock slot) dither out between the camera and the car.
//   fade meshes fade_meshes (the covered bridge) cast no shadow while the car is under them.
import * as THREE from 'three/webgpu';
import type { Stage } from './stage';
import type { Vehicle } from '../sim/vehicle';
import type { Projection } from '../sim/road';
import type { Pool } from '../fx/pool';
import { hexLinear, type Rng } from '../fx/config';
import { U } from '../look/uniforms';

export interface FeaturesJson {
  bridge_meshes?: string[];
  ford?: {
    wheel_depth_cm?: number; min_kmh?: number; drag_per_s?: number; spray_color?: string; spray_opacity?: number;
    spray_per_s?: number; entry_puffs?: number; spray_size_cm?: [number, number];
  };
  rock_fade_zones?: Record<string, [number, number][]>;
  rock_fade_ramp_m?: number;
  fade_meshes?: string[];
  fade_mesh_shadow_margin_m?: number;
  water?: Record<string, Record<string, string | number | number[]>>;
  white_tint?: Record<string, string[]>;
  far_no_shadow?: Record<string, string[]>;
}

export class StageFeatures {
  readonly fords: { s0: number; s1: number; water: number }[];
  readonly bridges: [number, number][] = [];
  readonly rockZones: [number, number][];
  /** The car is in a ford's water (and fast enough to splash): the water's height, else null. */
  water: number | null = null;
  /** Fords entered (checks). */
  fordEntries = 0;
  /** Weather: frozen fords have no drag and no splash (slice 8 sets it). */
  frozen = false;
  private sprayTimer = 0;
  private wasIn = false;
  private shadowOff = false;
  private readonly cfg: Required<NonNullable<FeaturesJson['ford']>>;
  private readonly sprayColour: THREE.Color;

  constructor(readonly stage: Stage, readonly f: FeaturesJson) {
    const id = stage.json.id;
    this.fords = stage.json.fords ?? [];
    this.rockZones = f.rock_fade_zones?.[id] ?? [];
    const c = f.ford ?? {};
    this.cfg = {
      wheel_depth_cm: c.wheel_depth_cm ?? 10, min_kmh: c.min_kmh ?? 8, drag_per_s: c.drag_per_s ?? 0.35,
      spray_color: c.spray_color ?? '#C9D6D8', spray_opacity: c.spray_opacity ?? 0.75, spray_per_s: c.spray_per_s ?? 40,
      entry_puffs: c.entry_puffs ?? 28, spray_size_cm: c.spray_size_cm ?? [25, 55],
    };
    this.sprayColour = hexLinear(this.cfg.spray_color);
    // bridge spans: road samples inside a listed unique mesh's bounds, grown 0.5 m sideways and 3 m up
    const road = stage.road;
    for (const name of f.bridge_meshes ?? []) {
      const node = stage.group.getObjectByName(name);
      if (!node) continue;
      const box = new THREE.Box3().setFromObject(node).expandByVector(new THREE.Vector3(0.5, 3, 0.5));
      let lo = Infinity, hi = -Infinity;
      const p = new THREE.Vector3();
      for (let i = 0; i < road.n; i++) {
        if (box.containsPoint(p.set(road.x[i], road.y[i], road.z[i]))) {
          lo = Math.min(lo, road.s[i]);
          hi = Math.max(hi, road.s[i]);
        }
      }
      if (hi > lo) this.bridges.push([lo, hi]);
    }
    U.rockFade.value = 0;
  }

  onBridge(s: number, margin = 0): boolean {
    return this.bridges.some(([a, b]) => s >= a - margin && s <= b + margin);
  }

  /**
   * Before every physics step: the ford's drag on the car. `proj` is the car's road projection.
   * Returns the water height while the car wades (for carEvents' splash), else null.
   */
  step(veh: Vehicle, proj: Projection | null, dt: number): number | null {
    let water: number | null = null;
    if (proj && !this.frozen) {
      // the bottom of the car: the wheels' contact points (else ~half a metre under the body)
      let y = 0, n = 0;
      for (const w of veh.wheels) if (w.inContact) {
        y += w.contactPoint.y;
        n++;
      }
      const bottom = n ? y / n : veh.position.y - 0.5;
      for (const f of this.fords) {
        if (proj.s >= f.s0 - 2 && proj.s <= f.s1 + 2 && Math.abs(proj.lateral) < proj.halfWidth + 4 && bottom < f.water + this.cfg.wheel_depth_cm / 100) {
          water = f.water;
        }
      }
    }
    const kmh = veh.speedKmh;
    const wading = water !== null && kmh > this.cfg.min_kmh;
    if (wading) {
      // UE AddForce(-H * drag_per_s, accel change): a horizontal deceleration of drag_per_s x speed
      const v = veh.velocity, m = veh.body.mass();
      const k = -this.cfg.drag_per_s * m * dt;
      veh.body.applyImpulse({ x: v.x * k, y: 0, z: v.z * k }, true);
    }
    this.water = wading ? water : null;
    return wading ? water : null;
  }

  /** Once a frame: spray while wading, the rock fade and the covered bridge's shadow. */
  frame(dt: number, veh: Vehicle, proj: Projection | null, dust: Pool | null, rng: Rng): void {
    // rock fade by the car's s, ramped over rock_fade_ramp_m
    let fade = 0;
    if (proj) {
      const ramp = Math.max(1, this.f.rock_fade_ramp_m ?? 20);
      for (const [a, b] of this.rockZones) fade = Math.max(fade, Math.min(Math.max(Math.min(proj.s - a, b - proj.s) / ramp, 0), 1));
    }
    if (Math.abs(fade - U.rockFade.value) > 0.002) U.rockFade.value = fade;
    // the covered bridge casts no shadow while the car is under it (its roof already dithers out)
    const margin = this.f.fade_mesh_shadow_margin_m ?? 6;
    const off = !!proj && margin >= 0 && this.onBridge(proj.s, margin) && Math.abs(proj.lateral) < proj.halfWidth + 3;
    if (off !== this.shadowOff) {
      this.shadowOff = off;
      this.stage.setFadeMeshShadows(!off);
    }
    // spray
    const inWater = this.water !== null;
    if (inWater && dust) {
      const kmh = veh.speedKmh;
      const speedK = Math.min(Math.max(kmh / 70, 0.2), 1.4);
      if (!this.wasIn) {
        this.fordEntries++;
        this.spray(veh, dust, rng, this.cfg.entry_puffs, 1.5, speedK);
      }
      this.sprayTimer += dt * this.cfg.spray_per_s * speedK;
      const n = Math.floor(this.sprayTimer);
      this.sprayTimer -= n;
      this.spray(veh, dust, rng, n, 1, speedK);
    }
    this.wasIn = inWater;
  }

  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private spray(veh: Vehicle, dust: Pool, rng: Rng, count: number, scale: number, speedK: number): void {
    const water = this.water!;
    const q = veh.body.rotation();
    const rot = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    // car frame: +x forward, +z right (the vehicle's three-axes convention)
    this.fwd.set(1, 0, 0).applyQuaternion(rot).setY(0).normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    const p = veh.position, v = veh.velocity;
    const [s0, s1] = this.cfg.spray_size_cm;
    for (let i = 0; i < count; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      const along = rng.range(-1.3, 1.3), out = rng.range(0.7, 1.1);
      const sv = rng.range(1.5, 4.5) * speedK * scale, carry = rng.range(0.15, 0.45);
      const size = rng.range(s0, s1) * 0.01 * scale;
      dust.emit({
        x: p.x + this.fwd.x * along + this.right.x * side * out, y: water + 0.05, z: p.z + this.fwd.z * along + this.right.z * side * out,
        vx: this.right.x * side * sv + v.x * carry, vy: rng.range(2.5, 6.5) * speedK * scale, vz: this.right.z * side * sv + v.z * carry,
        life: rng.range(0.5, 1.0), size0: size, size1: size * rng.range(1.8, 2.6),
        r: this.sprayColour.r, g: this.sprayColour.g, b: this.sprayColour.b, opacity: this.cfg.spray_opacity,
        drag: 1.6, gravity: 9.8, floorY: water, fadeIn: 0.02, fadeOutStart: 0.45,
      });
    }
  }
}
