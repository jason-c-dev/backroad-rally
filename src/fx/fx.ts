// The effects (handoff §10, slice 6): the original's ARallyFxManager pools and URallyCarFxComponent
// in one object. Five pools (dust 3072, puff 512, chip 1536, spark 384, flame 256: fx.json), each one
// instanced draw; skid marks in a ring of 6144 quads; exhaust pops. main.ts makes one, calls update()
// once a frame after the physics, and setQuality() when the look's tier changes.
//
//   ?fx=0     no effect drawing at all (events still fire): for measuring what the effects cost
import * as THREE from 'three/webgpu';
import type { Vehicle } from '../sim/vehicle';
import { events } from '../game/events';
import { FX_QUALITY, Rng, type FxJson, type FxQuality } from './config';
import { Pool, chipGeometry, icosphere, sparkGeometry } from './pool';
import { SkidMarks } from './skids';
import { CarFx } from './carFx';
import { Exhaust } from './exhaust';
import { DamageFx, type DamageState } from './damageFx';
import { dustMaterial, fxU, glowMaterial, skidMaterial, solidMaterial } from './materials';

export interface FxCar {
  id: string;
  exhaust_pos_cm?: number[][];
  wheel_width_cm: number;
  length_cm: number;
}

/** What the effects read from the look each frame (look.ts Look). */
export interface FxLook {
  sun: THREE.DirectionalLight;
  sky: THREE.HemisphereLight;
  cond: { name: string; headlights: unknown };
}

export class Fx {
  readonly group = new THREE.Group();
  readonly pools: Record<'dust' | 'puff' | 'chip' | 'spark' | 'flame', Pool>;
  readonly skids: SkidMarks;
  readonly car: CarFx;
  readonly exhaust: Exhaust;
  /** Smoke and fire from a damaged engine (src/fx/damageFx.ts); fed by `damageState`. */
  readonly damage: DamageFx;
  damageState: DamageState | null = null;
  enabled = true;
  quality: FxQuality = FX_QUALITY.high;
  /** Dust light = (sun × sunK + sky × skyK) / π: the original lit its dust without direction (see materials.ts);
   * the factors are fitted to its afternoon screenshots (dust over the sunlit gravel road). */
  readonly light = { sunK: 0.25, skyK: 0.5 };
  /** Game time (s): the skid marks' clock. */
  time = 0;
  private qualityName = '';
  private offs: (() => void)[] = [];
  private veh: Vehicle | null = null;
  private pose: { pos: THREE.Vector3; rot: THREE.Quaternion } | null = null;

  constructor(scene: THREE.Scene, readonly cfg: FxJson, car: FxCar, opts: { enabled?: boolean } = {}) {
    this.group.name = 'fx';
    this.enabled = opts.enabled ?? true;
    const rng = new Rng(98765);
    const size = (k: keyof FxJson['pools'], d: number) => Math.min(Math.max(cfg.pools?.[k]?.size ?? d, 16), 8192);
    const solid = solidMaterial(false);
    const glow = glowMaterial();
    const dust = dustMaterial({ softDepth: true, stipple: true });
    this.pools = {
      dust: new Pool('dust', size('dust', 3072), icosphere(1, 0.05, rng, true), dust, rng),
      // the puff pool keeps the rain splashes (slice 8); built now so the budget is measured with it
      puff: new Pool('puff', size('puff', 512), icosphere(1, 0.12, rng, false), solid, rng),
      chip: new Pool('chip', size('chip', 1536), chipGeometry(), solid, rng),
      spark: new Pool('spark', size('spark', 384), sparkGeometry(), glow, rng),
      flame: new Pool('flame', size('flame', 256), icosphere(0, 0.18, rng, false), glow, rng),
    };
    this.pools.chip.mesh.castShadow = !!cfg.pools?.chip?.shadow;
    // after the scene's opaque and before its other blended things (the marks go first, at -1)
    this.pools.dust.mesh.renderOrder = 1;
    this.skids = new SkidMarks(Math.max(64, cfg.skid.max_segments), skidMaterial(false), cfg.skid.lift_cm / 100);
    fxU.holdS.value = cfg.skid.hold_s;
    fxU.fadeS.value = cfg.skid.fade_s;
    this.group.add(this.skids.mesh, ...Object.values(this.pools).map((p) => p.mesh));
    scene.add(this.group);
    this.group.visible = this.enabled;

    this.car = new CarFx(cfg, { dust: this.pools.dust, chip: this.pools.chip, spark: this.pools.spark }, this.skids, rng, car.wheel_width_cm / 100);
    this.exhaust = new Exhaust(cfg, car.id, car.exhaust_pos_cm, car.length_cm / 100, this.pools.flame, this.pools.spark, rng);
    this.exhaust.visible = this.enabled;
    this.damage = new DamageFx(cfg, car.id, car.length_cm, this.pools.dust, this.pools.flame, rng);
    this.offs.push(
      events.on('landing', (e) => {
        if (this.enabled && this.veh) this.car.landing(this.veh, e.strength, e.surface);
      }),
      events.on('backfire', (e) => {
        if (this.enabled && this.veh && this.pose) this.exhaust.external(this.veh, e.intensity, e.antilag, this.pose.pos, this.pose.rot);
      }),
      events.on('impact', (e) => {
        if (this.enabled && this.veh) this.car.impact(this.veh, e.pos, e.normal, e.speed);
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
  }

  /** The look's tier changed: fewer particles or cheaper materials where that pays (config.ts FX_QUALITY). */
  setQuality(name: string): void {
    if (name === this.qualityName) return;
    this.qualityName = name;
    const q = (this.quality = FX_QUALITY[name] ?? FX_QUALITY.high);
    this.car.scale = this.damage.scale = q.emission;
    const cheap = name === 'low';
    const old = new Set([this.pools.chip.mesh.material, this.pools.dust.mesh.material, this.skids.mesh.material]);
    const solid = solidMaterial(cheap);
    this.pools.chip.mesh.material = this.pools.puff.mesh.material = solid;
    this.pools.chip.mesh.castShadow = q.chipShadows && !!this.cfg.pools?.chip?.shadow;
    this.pools.dust.mesh.material = dustMaterial({ softDepth: q.softDepth, stipple: q.stipple });
    this.skids.mesh.material = skidMaterial(cheap);
    for (const m of old) m.dispose();
  }

  /** Once a frame, after the physics: `pos`/`rot` = the drawn car pose. */
  update(dt: number, veh: Vehicle, pos: THREE.Vector3, rot: THREE.Quaternion, look: FxLook): void {
    this.veh = veh;
    this.pose = { pos, rot };
    this.time += dt;
    fxU.now.value = this.time;
    // condition: colour multiplier, night, and the dust's light
    const tint = this.cfg.condition_tint?.[look.cond.name] ?? [1, 1, 1];
    this.car.tint.setRGB(tint[0], tint[1], tint[2]);
    this.car.night = look.cond.headlights ? 1 : 0;
    const L = fxU.light.value as THREE.Color;
    L.copy(look.sun.color).multiplyScalar(look.sun.intensity * this.light.sunK)
      .add(new THREE.Color().copy(look.sky.color).add(look.sky.groundColor).multiplyScalar(0.5 * look.sky.intensity * this.light.skyK))
      .multiplyScalar(1 / Math.PI);
    this.exhaust.update(veh, dt, pos, rot);
    if (!this.enabled) return;
    this.car.update(veh, dt, this.time, veh.input.handbrake);
    if (this.damageState) this.damage.update(dt, this.damageState, pos, rot, veh.velocity);
    for (const p of Object.values(this.pools)) p.update(dt);
    this.skids.update();
  }

  /** Make every effect draw once on the next render (pipelines built while loading, not at the first dust). */
  warmup(): void {
    if (!this.enabled) return;
    for (const p of Object.values(this.pools)) p.warm();
    this.skids.warm();
  }

  /** Live particles per pool and skid segments placed (checks). */
  stats(): Record<string, number> {
    return {
      ...Object.fromEntries(Object.entries(this.pools).map(([k, p]) => [k, p.alive])),
      dustSpawned: this.pools.dust.spawned, chipSpawned: this.pools.chip.spawned,
      skids: this.skids.placed, smoke: this.damage.smokeEmitted, fire: this.damage.fireEmitted, pops: this.exhaust.pops, antilag: this.exhaust.antilagPops, limiterPops: this.exhaust.limiterPops,
    };
  }
}
