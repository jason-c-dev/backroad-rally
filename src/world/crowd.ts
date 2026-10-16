// Spectators (handoff §10; the original's AStageActor SpawnCrowds / UpdateCrowd / React with fx.json
// `crowd` and stage_runtime.json `crowd`): the stage's crowd groups placed off the road, tinted
// pawn figures that hop when the car comes by fast, shy away from it, and react as a group:
//
//   cheer      a fast pass within 25 m (or a jump landing within 40 m), per group every 10 s
//   nearMiss   the closest point of a pass within 5.2 m above 50 km/h: the group hops higher
//   gasp       the car within 3.3 m above 25 km/h: they duck and step back
//   groan      a crash of 18 km/h or more within 45 m of a group, while the stage runs
//   applause   the group nearest the finish (150 m) when the stage is finished
//
// Each reaction is a `crowdReaction` event (audio listens). Like the original, spectators have no
// colliders: the car drives through a figure that didn't step away in time.
// Drawing: one instanced mesh per figure variant, distance-faded like the stage's instances.
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Stage } from './stage';
import type { FxJson } from '../fx/config';
import { hexLinear, Rng } from '../fx/config';
import { crowdMaterial } from '../fx/materials';
import { events, type CrowdReactionKind } from '../game/events';
import { interpConstantTo } from '../sim/vehicle';

const CM = 0.01;

export interface CrowdRuntime {
  seed: number;
  meshes: string[];
  min_road_edge_cm: number;
  yaw_jitter_deg: number;
  palette: string[];
}

interface Spectator {
  x: number; y: number; z: number; rotY: number; scale: number; tint: THREE.Color;
  variant: number; group: number; phase: number;
  active: boolean; excite: number; shyX: number; shyZ: number; flinch: number; boost: number;
}

interface Group {
  centre: THREE.Vector3; s: number; count: number;
  cheerCd: number; nearMissCd: number; gaspCd: number; groanCd: number;
  minDist: number; passMin: number; passKmh: number; gasped: boolean; passOver: boolean;
}

interface Variant {
  meshes: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>[];
  a: THREE.InstancedBufferAttribute; // x, y, z, scale
  b: THREE.InstancedBufferAttribute; // rotY, fade, height scale
  c: THREE.InstancedBufferAttribute; // tint
  ids: number[];
}

/** Stage-local car state the crowd reacts to (once a frame). */
export interface CrowdCar {
  position: THREE.Vector3;
  kmh: number;
  /** No wheel on the ground. */
  airborne: boolean;
}

export class Crowd {
  readonly group = new THREE.Group();
  readonly spectators: Spectator[] = [];
  readonly groups: Group[] = [];
  /** Reactions so far, by kind (checks). */
  readonly counts: Record<CrowdReactionKind, number> = { cheer: 0, nearMiss: 0, gasp: 0, groan: 0, applause: 0 };
  skipped = 0;
  maxHop = 0;
  private variants: Variant[] = [];
  private time = 0;
  private carAir = 0;
  private running = false;
  private finishedSeen = false;
  private lastPhase = '';
  private band: [number, number];
  private off: () => void;

  constructor(stage: Stage, private cfg: FxJson['crowd'], rt: CrowdRuntime, reverse: boolean,
    rapier: typeof RAPIER, world: RAPIER.World) {
    this.group.name = 'crowd';
    const cull = stage.runtime.cull.spectator ?? stage.runtime.cull.default;
    this.band = [cull[0] / 100, cull[1] / 100];
    const rng = new Rng((rt.seed ?? 7) + hash(stage.json.id));
    const palette = (rt.palette?.length ? rt.palette : ['#334D99']).map((h) => hexLinear(h));
    const minEdge = (rt.min_road_edge_cm ?? 200) * CM;
    const jitter = ((rt.yaw_jitter_deg ?? 30) * Math.PI) / 180;
    const meshes = (rt.meshes?.length ? rt.meshes : ['SM_Spectator_A', 'SM_Spectator_B', 'SM_Spectator_C']).slice(0, 8);
    const road = stage.road;
    const L = new THREE.Vector3();
    const wanted = reverse ? 'reverse' : 'forward';
    for (const c of stage.json.crowds ?? []) {
      const which = (c.variants ?? 'both').toLowerCase();
      if (which !== 'both' && which !== wanted) continue;
      const centre = new THREE.Vector3(c.p[0], c.p[1], c.p[2]);
      const near = road.project(centre, -1);
      const gi = this.groups.length;
      this.groups.push({ centre, s: near.s, count: 0, cheerCd: 0, nearMissCd: 0, gaspCd: 0, groanCd: 0, minDist: 1e9, passMin: 1e9, passKmh: 0, gasped: false, passOver: false });
      for (let k = 0; k < c.count; k++) {
        let ok = false;
        for (let t = 0; t < 12 && !ok; t++) {
          const r = c.radius * Math.sqrt(rng.next());
          const a = rng.next() * Math.PI * 2;
          L.set(centre.x + Math.cos(a) * r, centre.y, centre.z + Math.sin(a) * r);
          const p = road.project(L, near.index);
          ok = Math.abs(p.lateral) > p.halfWidth + minEdge;
        }
        if (!ok) {
          this.skipped++;
          continue;
        }
        // stand on the ground
        const hit = world.castRay(new rapier.Ray({ x: L.x, y: L.y + 30, z: L.z }, { x: 0, y: -1, z: 0 }), 90, true);
        const y = hit ? L.y + 30 - hit.timeOfImpact : L.y;
        // face the road (UE yaw of the direction to the road, ± jitter; three rotY = −yaw)
        const p = road.project(L.setY(y), near.index);
        const q = road.sampleAt(p.s).p;
        const yaw = Math.atan2(q.z - L.z, q.x - L.x) + rng.range(-jitter, jitter);
        const variant = rng.int(0, meshes.length - 1);
        const tint = palette[rng.int(0, palette.length - 1)];
        this.spectators.push({
          x: L.x, y, z: L.z, rotY: -yaw, scale: rng.range(0.92, 1.08), tint, variant, group: gi, phase: 0,
          active: false, excite: 0, shyX: 0, shyZ: 0, flinch: 0, boost: 0,
        });
        this.groups[gi].count++;
      }
    }
    for (const s of this.spectators) s.phase = rng.next() * Math.PI * 2;

    const mat = crowdMaterial();
    meshes.forEach((name, vi) => {
      const parts = stage.envParts(name);
      const ids = this.spectators.flatMap((s, i) => (s.variant === vi ? [i] : []));
      const cap = Math.max(1, ids.length);
      const attr = () => {
        const x = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
        x.setUsage(THREE.DynamicDrawUsage);
        return x;
      };
      const v: Variant = { meshes: [], a: attr(), b: attr(), c: attr(), ids };
      for (const part of parts ?? []) {
        const g = new THREE.InstancedBufferGeometry();
        g.index = part.geometry.index;
        for (const [k, at] of Object.entries(part.geometry.attributes)) g.setAttribute(k, at);
        g.setAttribute('cr_a', v.a);
        g.setAttribute('cr_b', v.b);
        g.setAttribute('cr_c', v.c);
        g.instanceCount = 0;
        const m = new THREE.Mesh(g, mat);
        m.name = `crowd_${name}`;
        m.frustumCulled = false; // spread along the whole stage; compacted to the visible ones every frame
        m.castShadow = stage.catalog[name]?.shadow ?? true;
        m.receiveShadow = true;
        m.visible = false;
        this.group.add(m);
        v.meshes.push(m);
      }
      this.variants.push(v);
    });
    this.off = events.on('impact', (e) => {
      if (this.running) this.notifyImpact(e.pos, e.speed);
    });
  }

  dispose(): void {
    this.off();
  }

  /** Back to rest (stage restart). */
  reset(): void {
    for (const s of this.spectators) {
      s.active = false;
      s.excite = s.shyX = s.shyZ = s.flinch = s.boost = 0;
    }
    for (const g of this.groups) {
      g.cheerCd = g.nearMissCd = g.gaspCd = g.groanCd = 0;
      g.passMin = 1e9;
      g.gasped = g.passOver = false;
    }
    this.carAir = 0;
    this.finishedSeen = false;
  }

  /**
   * Once a frame: `phase` is the stage flow's (groans only while it runs, applause on the finish),
   * `camera` the view position for the distance fade, `draw` the stage's draw-distance multiplier.
   */
  update(dt: number, car: CrowdCar | null, phase: string, camera: THREE.Vector3, draw: number): void {
    // a restart (back to the intro card) puts everyone back at rest
    if (phase === 'intro' && this.lastPhase !== 'intro') this.reset();
    this.lastPhase = phase;
    this.running = phase === 'running';
    if (phase === 'finished' && !this.finishedSeen && car) {
      this.finishedSeen = true;
      this.notifyFinish(car.position);
    } else if (phase !== 'finished' && phase !== 'results') {
      this.finishedSeen = false;
    }
    this.animate(dt, car);
    this.draw(camera, draw);
  }

  // ------------------------------------------------------------------ behaviour (UE UpdateCrowd)
  private animate(dt: number, car: CrowdCar | null): void {
    const C = this.cfg, R = C.reactions;
    this.time += dt;
    for (const g of this.groups) {
      g.cheerCd = Math.max(0, g.cheerCd - dt);
      g.nearMissCd = Math.max(0, g.nearMissCd - dt);
      g.gaspCd = Math.max(0, g.gaspCd - dt);
      g.groanCd = Math.max(0, g.groanCd - dt);
      g.minDist = 1e9;
    }
    if (!this.spectators.length) return;
    const reactR = C.react_radius_cm * CM, reactKmh = C.react_min_kmh;
    const shyR = C.shy_radius_cm * CM, shyDist = C.shy_distance_cm * CM, shySpeed = C.shy_speed_cms * CM, returnSpeed = C.return_speed_cms * CM;
    const nearMiss = R.near_miss_cm * CM, gasp = R.gasp_cm * CM;
    let kmh = 0, air = false, landed = false;
    const cx = car?.position.x ?? 0, cz = car?.position.z ?? 0;
    if (car) {
      kmh = car.kmh;
      const prev = this.carAir;
      this.carAir = car.airborne ? this.carAir + dt : 0;
      air = this.carAir > 0.25;
      landed = prev > 0.4 && this.carAir === 0;
    }
    for (const s of this.spectators) {
      const d = car ? Math.hypot(s.x - cx, s.z - cz) : 1e9;
      // wake spectators near the car
      if (car && kmh > reactKmh && d < reactR) s.active = true;
      if (!s.active) continue;
      const g = this.groups[s.group];
      g.minDist = Math.min(g.minDist, d);
      const nearCar = car && d < reactR && kmh > reactKmh;
      s.flinch = Math.max(0, s.flinch - dt);
      s.boost = Math.max(0, s.boost - dt);
      const target = s.boost > 0 ? 1 + R.boost_hop : nearCar ? 1 + (air ? C.jump_bonus : 0) : 0;
      s.excite = interpConstantTo(s.excite, target, dt, target > s.excite ? C.excite_rise : C.excite_decay);
      // shy away from a car that comes very close
      let tx = 0, tz = 0;
      const ax = s.x - cx, az = s.z - cz, al = Math.hypot(ax, az) || 1;
      if (car && d < shyR) {
        const m = Math.min(shyDist * (1 - d / shyR) * 1.6, shyDist);
        tx = (ax / al) * m;
        tz = (az / al) * m;
      }
      if (s.flinch > 0 && car) {
        // gasp: step further away
        const m = Math.max(Math.hypot(tx, tz), shyDist * 0.6) * R.flinch_shy_scale;
        tx = (ax / al) * m;
        tz = (az / al) * m;
      }
      const speed = tx * tx + tz * tz > s.shyX * s.shyX + s.shyZ * s.shyZ ? shySpeed : returnSpeed;
      const dx = tx - s.shyX, dz = tz - s.shyZ, dl = Math.hypot(dx, dz), step = speed * dt;
      if (dl <= step) {
        s.shyX = tx;
        s.shyZ = tz;
      } else {
        s.shyX += (dx / dl) * step;
        s.shyZ += (dz / dl) * step;
      }
      if (s.excite <= 0 && Math.hypot(s.shyX, s.shyZ) < 0.005 && s.flinch <= 0 && s.boost <= 0) {
        s.active = false;
        s.shyX = s.shyZ = 0;
      }
    }

    if (car) {
      // near miss (cheer at the closest point of a fast close pass) and gasp (very close, at once)
      this.groups.forEach((g, gi) => {
        if (g.minDist < nearMiss * 1.5 && !g.passOver) {
          if (g.minDist < g.passMin) {
            g.passMin = g.minDist;
            g.passKmh = kmh;
          }
          if (g.minDist < gasp && kmh > R.gasp_min_kmh && !g.gasped && g.gaspCd <= 0) {
            g.gasped = true;
            g.gaspCd = R.gasp_cooldown_s;
            g.cheerCd = Math.max(g.cheerCd, C.cheer_cooldown_s * 0.5);
            this.stir(gi, R.flinch_s, -1, true);
            this.react(gi, 'gasp', Math.min(Math.max(kmh / 80, 0.6), 1.4));
          }
          // the pass is over once the car moves away again
          if (g.minDist > g.passMin + 1.5) {
            if (!g.gasped && g.passMin < nearMiss && g.passKmh > R.near_miss_min_kmh && g.nearMissCd <= 0) {
              const close = 1 - Math.min(Math.max((g.passMin - gasp) / Math.max(0.01, nearMiss - gasp), 0), 1);
              g.nearMissCd = R.near_miss_cooldown_s;
              g.cheerCd = Math.max(g.cheerCd, C.cheer_cooldown_s);
              this.stir(gi, -1, R.near_miss_hop_s, false);
              this.react(gi, 'nearMiss', Math.min(Math.max(g.passKmh / 100, 0.6), 1.4) * (0.8 + 0.4 * close));
            }
            g.passOver = true;
          }
        } else if (g.minDist >= nearMiss * 1.5) {
          g.passMin = 1e9;
          g.gasped = false;
          g.passOver = false;
        }
      });
      // cheers per group: a fast pass close by, or a jump landing near them
      const cheerR = C.cheer_radius_cm * CM, jumpR = C.jump_radius_cm * CM;
      this.groups.forEach((g, gi) => {
        const d = Math.hypot(g.centre.x - cx, g.centre.z - cz);
        if (d > Math.max(cheerR, jumpR)) return;
        let intensity = 0;
        if (landed && kmh > C.cheer_min_kmh && g.cheerCd < C.cheer_cooldown_s * 0.5) intensity = 1 + C.jump_bonus;
        else if (d < cheerR && kmh > C.cheer_min_kmh && g.cheerCd <= 0) {
          intensity = Math.min(Math.max(kmh / 120, 0.4), 1.2) * Math.min(Math.max(g.count / 15, 0.5), 1.3);
        }
        if (intensity > 0) {
          g.cheerCd = C.cheer_cooldown_s;
          this.react(gi, 'cheer', intensity);
        }
      });
    }
  }

  private react(group: number, kind: CrowdReactionKind, intensity: number, at?: THREE.Vector3): void {
    const g = this.groups[group];
    this.counts[kind]++;
    events.emit('crowdReaction', { kind, pos: (g?.centre ?? at ?? new THREE.Vector3()).clone(), intensity, count: g?.count ?? 0 });
  }

  /** Wake a whole group: flinch (s), hop boost (s), or calm them (a gasp or a groan stops the hopping). */
  private stir(group: number, flinchS: number, boostS: number, calm: boolean): void {
    for (const s of this.spectators) {
      if (s.group !== group) continue;
      s.active = true;
      if (flinchS >= 0) s.flinch = Math.max(s.flinch, flinchS);
      if (boostS >= 0) s.boost = Math.max(s.boost, boostS);
      if (calm) s.excite = s.boost = 0;
    }
  }

  /** A crash near a group: they groan (the original's NotifyCarImpact). */
  notifyImpact(pos: THREE.Vector3, kmh: number): void {
    const R = this.cfg.reactions;
    if (kmh < R.groan_min_kmh) return;
    let best = -1, bestD = R.groan_radius_cm * CM;
    this.groups.forEach((g, gi) => {
      const d = Math.hypot(g.centre.x - pos.x, g.centre.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = gi;
      }
    });
    if (best < 0 || this.groups[best].groanCd > 0) return;
    const g = this.groups[best];
    g.groanCd = R.groan_cooldown_s;
    g.cheerCd = Math.max(g.cheerCd, 3); // nobody cheers a crash
    this.stir(best, R.groan_flinch_s, -1, true);
    this.react(best, 'groan', Math.min(Math.max(kmh / 50, 0.6), 1.5));
  }

  /** The stage is finished: the group nearest the car applauds (or a distant applause at the car). */
  notifyFinish(pos: THREE.Vector3): void {
    const R = this.cfg.reactions;
    let best = -1, bestD = R.applause_radius_cm * CM;
    this.groups.forEach((g, gi) => {
      const d = Math.hypot(g.centre.x - pos.x, g.centre.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = gi;
      }
    });
    if (best >= 0) {
      this.stir(best, -1, R.applause_hop_s, false);
      this.react(best, 'applause', 1);
    } else {
      this.counts.applause++;
      events.emit('crowdReaction', { kind: 'applause', pos: pos.clone(), intensity: R.applause_far_intensity, count: 0 });
    }
  }

  // ------------------------------------------------------------------ drawing
  private draw(camera: THREE.Vector3, mul: number): void {
    const start = this.band[0] * mul, end = this.band[1] * mul, end2 = end * end;
    const hop = this.cfg.hop_height_cm * CM, hz = this.cfg.hop_hz, crouchMax = this.cfg.reactions.flinch_crouch;
    for (const v of this.variants) {
      const A = v.a.array as Float32Array, B = v.b.array as Float32Array, Cc = v.c.array as Float32Array;
      let k = 0;
      for (const i of v.ids) {
        const s = this.spectators[i];
        const dx = s.x - camera.x, dy = s.y - camera.y, dz = s.z - camera.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= end2) continue;
        const d = Math.sqrt(d2);
        const f = d <= start ? 1 : 1 - (d - start) / (end - start);
        let y = s.y, sy = 1, ox = 0, oz = 0;
        if (s.active) {
          const wave = Math.max(0, Math.sin(2 * Math.PI * hz * this.time + s.phase));
          const h = hop * s.excite * wave;
          this.maxHop = Math.max(this.maxHop, h);
          y += h;
          ox = s.shyX;
          oz = s.shyZ;
          // a little stretch at the top of the hop; duck while flinching
          const crouch = s.flinch > 0 ? crouchMax * Math.min(1, s.flinch * 4) : 0;
          sy = 1 + 0.06 * s.excite * wave - crouch;
        }
        const o = k * 4;
        A[o] = s.x + ox; A[o + 1] = y; A[o + 2] = s.z + oz; A[o + 3] = s.scale;
        B[o] = s.rotY; B[o + 1] = f; B[o + 2] = sy; B[o + 3] = 0;
        Cc[o] = s.tint.r; Cc[o + 1] = s.tint.g; Cc[o + 2] = s.tint.b; Cc[o + 3] = 0;
        k++;
      }
      if (k) {
        for (const at of [v.a, v.b, v.c]) {
          at.clearUpdateRanges();
          at.addUpdateRange(0, k * 4);
          at.needsUpdate = true;
        }
      }
      for (const m of v.meshes) {
        m.geometry.instanceCount = k;
        m.visible = k > 0;
      }
    }
  }

  /** Draw every variant once with culling off (pipeline warm-up during loading). */
  warmup(): void {
    for (const v of this.variants) for (const m of v.meshes) {
      m.geometry.instanceCount = Math.min(1, v.ids.length);
      m.visible = v.ids.length > 0;
    }
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
