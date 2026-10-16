// Breakables (the original's AStageActor SpawnBreakables / UpdateBreakables / BreakBreakable /
// TickBreakableSims, with fx.json `breakables` and stage_runtime.json `breakable_radius_cm`): the
// stage's breakable table (finland: roadside bushes, junipers and marker posts). They have no
// colliders, as in the original: a proximity test once a frame breaks whatever the car passes over.
//
//   burst  (shrubs, ferns): the bush is gone until a restart and its leaves scatter (chip pool)
//   fly    (markers, barriers, segments): knocked over, it tumbles, bounces and settles lying down
//
// Each break emits a `breakable` event (audio plays the original's sound for it). Nothing here
// touches the car: it drives through them exactly as it did before.
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Stage } from './stage';
import { hexList, Rng, type Range } from '../fx/config';
import type { Spawn } from '../fx/pool';
import { propMaterials } from '../look/materials';
import { events } from '../game/events';

const CM = 0.01;

interface KindCfg {
  reaction?: 'fly' | 'burst';
  inherit?: number; up_cms?: Range; spin_dps?: Range; rest_lift_cm?: number;
  pieces?: number; piece_height_cm?: number; piece_size_cm?: Range; piece_life_s?: Range; piece_drag?: number;
  piece_gravity?: number; piece_up_cms?: Range; colors?: string[];
  sound?: string; sound_volume?: number; sound_pitch?: Range;
}

export interface BreakablesJson {
  categories: Record<string, KindCfg>;
  meshes: Record<string, { colors?: string[] }>;
}

interface Item {
  id: number; // instance id in the stage's table
  mesh: string;
  category: string;
  pos: THREE.Vector3;
  rotY: number;
  scale: number;
  radius: number;
  broken: boolean;
}

interface Flyer {
  item: Item;
  obj: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  restLift: number;
  timer: number;
  settling: boolean;
}

export class Breakables {
  readonly group = new THREE.Group();
  readonly items: Item[] = [];
  broken = 0;
  private grid = new Map<string, number[]>();
  private flyers: Flyer[] = [];
  private rng = new Rng(4711);
  private mats = propMaterials();
  private lastPhase = '';
  private q = new THREE.Quaternion();
  private m = new THREE.Matrix4();

  constructor(private stage: Stage, private cfg: BreakablesJson, radiiCm: Record<string, number>,
    private rapier: typeof RAPIER, private world: RAPIER.World, private emit: ((s: Spawn) => void) | null) {
    this.group.name = 'breakables';
    const F = stage.json.bin.floats_per_instance, bin = stage.bin;
    for (const [mesh, [offset, count]] of Object.entries(stage.json.bin.breakables ?? {})) {
      const category = stage.catalog[mesh]?.category ?? 'default';
      const radius = (radiiCm[category] ?? radiiCm.default ?? 150) * CM;
      for (let i = offset; i < offset + count; i++) {
        const item: Item = {
          id: i, mesh, category, pos: new THREE.Vector3(bin[i * F], bin[i * F + 1], bin[i * F + 2]),
          rotY: bin[i * F + 3], scale: bin[i * F + 4], radius, broken: false,
        };
        const k = this.items.push(item) - 1;
        const key = cell(item.pos.x, item.pos.z);
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push(k);
      }
    }
  }

  /** Once a frame: the car breaks what it passes over; knocked-over posts tumble; a restart restores them. */
  update(dt: number, car: { position: THREE.Vector3; velocity: THREE.Vector3; body?: RAPIER.RigidBody } | null, phase: string): void {
    if (phase === 'intro' && this.lastPhase !== 'intro') this.reset();
    this.lastPhase = phase;
    if (car && car.velocity.lengthSq() > 1.5 * 1.5) {
      const L = car.position;
      const cx = Math.floor(L.x / 10), cz = Math.floor(L.z / 10);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const k of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            const b = this.items[k];
            if (b.broken || (b.pos.x - L.x) ** 2 + (b.pos.z - L.z) ** 2 > b.radius * b.radius || Math.abs(b.pos.y - L.y) > 4) continue;
            this.break(b, car.velocity);
          }
        }
      }
    }
    this.sim(dt, car?.body);
  }

  private kind(b: Item): KindCfg {
    return this.cfg.categories?.[b.category] ?? {};
  }

  private break(b: Item, carV: THREE.Vector3): void {
    b.broken = true;
    this.broken++;
    const K = this.kind(b), rng = this.rng;
    const reaction = K.reaction ?? (['shrub', 'flower', 'grass'].includes(b.category) ? 'burst' : 'fly');
    const dir = new THREE.Vector3(carV.x, 0, carV.z).normalize();
    const colours = hexList(this.cfg.meshes?.[b.mesh]?.colors ?? K.colors ?? ['#1A330D']);
    const pieces = K.pieces ?? (reaction === 'burst' ? 60 : 10);
    const emitPieces = (count: number, lo: number, hi: number, inherit: number) => {
      if (!this.emit) return;
      const h = b.scale * (K.piece_height_cm ?? 60) * CM;
      for (let i = 0; i < count; i++) {
        const out = new THREE.Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize().addScaledVector(dir, 0.8).normalize();
        const s = rng.range(lo, hi) * CM, up = rng.pick(K.piece_up_cms, 250, 650) * CM, size = rng.pick(K.piece_size_cm, 10, 22) * CM;
        const c = colours[rng.int(0, colours.length - 1)];
        this.emit({
          x: b.pos.x + rng.range(-40, 40) * CM, y: b.pos.y + rng.range(0.2, 1) * h, z: b.pos.z + rng.range(-40, 40) * CM,
          vx: out.x * s + carV.x * inherit, vy: up + carV.y * inherit, vz: out.z * s + carV.z * inherit,
          life: rng.pick(K.piece_life_s, 2.5, 4), size0: size, size1: size, r: c.r, g: c.g, b: c.b,
          drag: K.piece_drag ?? 1.4, gravity: (K.piece_gravity ?? 700) * CM, spin: rng.range(300, 900),
          floorY: b.pos.y + 2 * CM, fadeIn: 0.01, fadeOutStart: 0.75,
        });
      }
    };
    // the drawn instance goes either way; a flyer is drawn on its own until the restart
    this.stage.hiddenInstances[b.id] = 1;
    this.stage.instancesChanged();
    if (reaction === 'burst') {
      emitPieces(pieces, 150, 450, 0.25);
    } else {
      const parts = this.stage.envParts(b.mesh) ?? [];
      const obj = new THREE.Group();
      for (const p of parts) {
        const mesh = new THREE.Mesh(p.geometry, this.mats[p.slot] ?? this.mats.Flat);
        mesh.castShadow = mesh.receiveShadow = true;
        obj.add(mesh);
      }
      obj.scale.setScalar(b.scale);
      this.group.add(obj);
      const inherit = K.inherit ?? 0.75;
      const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir.lengthSq() ? dir : new THREE.Vector3(1, 0, 0));
      const u = rng.unit(new THREE.Vector3());
      axis.addScaledVector(u, 0.35).normalize();
      this.flyers.push({
        item: b, obj, pos: b.pos.clone(),
        vel: carV.clone().multiplyScalar(inherit).add(new THREE.Vector3(rng.range(-1, 1) * 1.5, rng.pick(K.up_cms, 300, 600) * CM, rng.range(-1, 1) * 1.5)),
        rot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotY),
        axis, spin: (rng.pick(K.spin_dps, 400, 900) * Math.PI) / 180, restLift: (K.rest_lift_cm ?? 8) * CM, timer: 0, settling: false,
      });
      emitPieces(pieces, 100, 350, 0.3);
    }
    const speed = carV.length();
    events.emit('breakable', {
      pos: b.pos.clone(), mesh: b.mesh, category: b.category, reaction, speed: speed * 3.6,
      sound: K.sound ?? 'A_Impact_Soft',
      volume: (K.sound_volume ?? 0.7) * Math.min(Math.max(speed / 25, 0.4), 1),
      pitch: rng.pick(K.sound_pitch, 0.95, 1.1),
    });
  }

  /** Knocked-over posts: tumble, bounce, then lie down keeping their heading (the original's TickBreakableSims). */
  private sim(dt: number, carBody?: RAPIER.RigidBody): void {
    for (let k = this.flyers.length - 1; k >= 0; k--) {
      const f = this.flyers[k];
      f.timer += dt;
      f.vel.y -= 9.8 * dt;
      f.vel.multiplyScalar(Math.max(0, 1 - 0.3 * dt));
      f.pos.addScaledVector(f.vel, dt);
      if (!f.settling) f.rot.premultiply(this.q.setFromAxisAngle(f.axis, f.spin * dt));
      const hit = this.world.castRay(new this.rapier.Ray({ x: f.pos.x, y: f.pos.y + 5, z: f.pos.z }, { x: 0, y: -1, z: 0 }), 30, true,
        undefined, undefined, undefined, carBody);
      const ground = hit ? f.pos.y + 5 - hit.timeOfImpact : f.item.pos.y;
      let onGround = false;
      if (f.pos.y <= ground + f.restLift) {
        f.pos.y = ground + f.restLift;
        onGround = true;
        if (f.vel.y < -1.2) {
          f.vel.y = -f.vel.y * 0.3;
          f.vel.x *= 0.55;
          f.vel.z *= 0.55;
          f.spin *= 0.5;
        } else {
          f.vel.y = Math.max(0, f.vel.y);
          const keep = Math.max(0, 1 - 5 * dt);
          f.vel.x *= keep;
          f.vel.z *= keep;
        }
      }
      if (onGround && (f.vel.length() < 0.8 || f.timer > 4)) f.settling = true;
      let done = false;
      if (f.settling) {
        // lie down: the post's up axis goes horizontal (keeping its heading), its forward axis points up
        const horiz = new THREE.Vector3(0, 1, 0).applyQuaternion(f.rot).setY(0);
        if (horiz.lengthSq() < 1e-6) horiz.set(1, 0, 0).applyQuaternion(f.rot).setY(0);
        horiz.normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const target = new THREE.Quaternion().setFromRotationMatrix(this.m.makeBasis(up, horiz, new THREE.Vector3().crossVectors(up, horiz)));
        f.rot.slerp(target, Math.min(1, 8 * dt));
        f.vel.multiplyScalar(Math.max(0, 1 - 8 * dt));
        done = f.rot.angleTo(target) < 0.02 || f.timer > 7;
      }
      f.obj.position.copy(f.pos);
      f.obj.quaternion.copy(f.rot);
      if (done) this.flyers.splice(k, 1);
    }
  }

  /** Everything back where it stood (a restart). */
  reset(): void {
    for (const b of this.items) {
      if (b.broken) this.stage.hiddenInstances[b.id] = 0;
      b.broken = false;
    }
    this.flyers.length = 0;
    this.group.clear();
    this.broken = 0;
    this.stage.instancesChanged();
  }
}

const cell = (x: number, z: number) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
