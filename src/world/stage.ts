// A stage built from data (handoff §6): terrain tiles with trimesh colliders that know the surface
// of every triangle, ~125k vegetation and prop instances chunked by 256 m tile and faded in by
// distance (never popped), colliders for the instances near the road, and the start and finish
// gantries. Nothing is baked: tools/convert/stage.mjs and the Blender exporters make the inputs.
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { assetUrl } from '../data';
import { Road, type RoadData } from '../sim/road';
import type { SurfaceQuery } from '../sim/vehicle';
import type { Surface } from '../sim/tuning';
import { instanceMaterials, propMaterials, terrainMaterials } from '../look/materials';
import { fadeBand, mergeParts, vegetationLods } from './lod';

export interface StageJson {
  id: string;
  name: string;
  location: string;
  surface: string;
  length_m: number;
  road: RoadData;
  variants: { forward: { start_s: number; finish_s: number }; reverse: { start_s: number; finish_s: number } };
  features: { n: number; s: number; name: string; p?: number[] }[];
  crowds: { p: number[]; rotY: number; radius: number; count: number; variants: string; s: number }[];
  tiles: { mesh: string; p: number[] }[];
  unique_meshes: { mesh: string; p: number[]; rotY: number; collision: string }[];
  water_level: number | null;
  bounds: [number[], number[]] | null;
  bin: { floats_per_instance: number; instances: Record<string, [number, number]>; breakables: Record<string, [number, number]> };
  env_meshes: string[];
}

export interface CatalogEntry {
  category: string;
  collision: 'none' | 'capsule' | 'box' | 'complex';
  collision_radius_cm: number;
  height_cm: number;
  radius_cm: number;
  bounds_min_cm?: number[];
  bounds_max_cm?: number[];
  collision_boxes_cm?: { center: number[]; half: number[] }[];
  shadow: boolean;
  sway: boolean;
  tintable: boolean;
  tint_value?: number;
  tint_hue_deg?: number;
}

export interface StageRuntimeJson {
  corridor_cm: number;
  offroad_grace_s: number;
  reset_back_m: number;
  car_start_back_m: number;
  collision_near_road_cm: number;
  cull: Record<string, [number, number]>;
  gantries: { start: string; finish: string; leg_offset_cm: number };
  draw_distance: { scale: { default: number[] } };
}

const CHUNK = 256; // m: one terrain tile
const SLOT_SURFACE: Record<string, Surface> = {
  Grass: 'grass', Gravel: 'gravel', Tarmac: 'tarmac', Line: 'tarmac', Dirt: 'dirt', Rock: 'rock',
  Water: 'water', Snow: 'snow', Flat: 'tarmac',
};

const slotName = (m: THREE.Material) => m.name.replace(/\.\d+$/, '');

/**
 * Materials for the slots (src/look/materials.ts). Instances are plain meshes on an
 * InstancedBufferGeometry with two per-instance attributes, inst_a = (x, y, z, scale) and
 * inst_b = (rotY, fade, hue shift deg, value delta), placed by the material's positionNode;
 * `fade` (0..1, written each update) dithers them in. Not InstancedMesh: three keeps up to 1024
 * instance matrices in a uniform block named after the node, so every chunk compiled its own
 * vertex program (2200 programs, 8-45 s of hitches).
 */
function makeMaterials() {
  return { tiles: terrainMaterials(), instances: instanceMaterials(), props: propMaterials() };
}

/** COLOR_0 is RGBA (alpha = sway weight on vegetation): keep RGB as the colour, alpha as `sway`. */
function splitColour(g: THREE.BufferGeometry): void {
  const c = g.getAttribute('color');
  if (!c || c.itemSize !== 4) return;
  const rgb = new Float32Array(c.count * 3);
  const sway = new Float32Array(c.count);
  for (let i = 0; i < c.count; i++) {
    rgb[i * 3] = c.getX(i);
    rgb[i * 3 + 1] = c.getY(i);
    rgb[i * 3 + 2] = c.getZ(i);
    sway[i] = c.getW(i);
  }
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  g.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
}

/** One mesh (one level of detail) of a chunk: a mesh per material slot, sharing the instance attributes. */
interface Level {
  parts: THREE.Mesh<THREE.InstancedBufferGeometry>[];
  a: THREE.InstancedBufferAttribute; // x, y, z, scale
  b: THREE.InstancedBufferAttribute; // rotY, fade band (see fadeBand), hue shift (deg), value delta
  k: number; // instances written this update
  /** The same level with materials that never discard (no fade, not near the car): early depth test. */
  solid: Level | null;
}

interface InstanceGroup {
  mesh: string;
  category: string;
  start: number; // fade band, m
  end: number;
  sphere: THREE.Sphere; // bounds of every instance in the chunk: per-camera culling and the range test
  ids: Uint32Array; // instance ids in the stage's instance table
  /** Drawn levels: [full] or, for vegetation, [full, mid, far] (cross-faded by distance, see `lod`). */
  levels: Level[];
  /** Vegetation only: the same levels on layer 1, which only shadow cameras see (cheap casters). */
  shadow: Level[];
  /** Every level, solid twins and shadow levels included (uploads, visibility, warm-up). */
  all: Level[];
  /** Reach of the mesh from its pivot at scale 1 (m): the occluder test. */
  reach: number;
}

/**
 * Level of detail and shadow casters for vegetation (trees and shrubs), set by the quality tier.
 * Distances are from the camera in metres and don't scale with the draw distance.
 */
export interface LodSettings {
  /** Where levels 1, 2 and 3 take over; each switch dithers over the last `blend` share of the distance. */
  cuts: number[];
  blend: number;
  /** Shadow casters: the level used within `shadowCut` and beyond it, up to `shadowRange` (0 = none). */
  shadowNear: number;
  shadowFar: number;
  shadowCut: number;
  shadowRange: number;
  /** Whether grass that the catalog lets cast shadows (tall grass) does: thousands of small casters. */
  grassShadows: boolean;
  /** Ground cover (grass, flowers, ferns) draw distance, relative to the stage's draw distance. */
  groundDraw: number;
  /** Diffuse-only foliage (materials.ts lambertCopy). */
  cheapFoliage: boolean;
}

export const DEFAULT_LOD: LodSettings = { cuts: [90, 200, 300], blend: 0.2, shadowNear: 0, shadowFar: 1, shadowCut: 80, shadowRange: 240, grassShadows: true,
  groundDraw: 1, cheapFoliage: false };
const GROUND_COVER = new Set(['grass', 'flower', 'fern']);
/** Levels from this one on use the far foliage material (no sway, no see-through test): beyond 90 m. */
const FAR_LEVEL = 2;

/** Categories that get levels of detail and shadow proxies (when they have a foliage slot). */
const LOD_CATEGORIES = new Set(['tree', 'shrub']);


export class Stage {
  readonly group = new THREE.Group();
  readonly road: Road;
  surfaceAt!: SurfaceQuery;
  private groups: InstanceGroup[] = [];
  private hue!: Float32Array; // per-instance hue shift (deg) and value delta (×(1+d)), from the catalog's tint ranges
  private val!: Float32Array;
  // collider handle -> surface. One trimesh per tile and surface: Rapier 0.21's ray casts report
  // Face(0) for every trimesh hit, not the triangle index, so a per-triangle table can't be used.
  private colliderSurface = new Map<number, Surface>();
  private envGeoms = new Map<string, { geometry: THREE.BufferGeometry; slot: string }[]>();
  /** Draw distance multiplier (setting: near / medium / far / max = 1 / 1.5 / 2 / 3). */
  drawDistance = 2;
  /** Instance categories not drawn (dev: ?hide=tree,grass for measuring their cost). */
  hidden = new Set<string>();
  /** Radius (m) around the camera-to-car line inside which foliage may dither (materials.ts occluder). */
  occluderReach = 8.5;
  /** Vegetation levels of detail and shadow casters (the quality tier sets it with setLod). */
  lod: LodSettings = { ...DEFAULT_LOD };

  setLod(l: LodSettings): void {
    this.lod = l;
    for (const g of this.groups) {
      for (const lv of g.all) {
        for (const im of lv.parts) {
          if (g.category === 'grass' && this.catalog[g.mesh]?.shadow && !im.layers.isEnabled(1)) im.castShadow = l.grassShadows;
          // foliage slots swap between the physical and the diffuse-only material
          const key = im.userData.mat as string | undefined;
          if (key?.startsWith('Foliage')) {
            const solid = key.endsWith('!'), base = key.replace('!', '');
            im.material = this.mats[`${base}${l.cheapFoliage ? 'L' : ''}${solid ? '!' : ''}`] ?? im.material;
          }
        }
      }
    }
    this.updateInstances(this.lastUpdate, true);
  }
  stats = { instances: 0, visible: 0, drawn: 0, colliders: 0, groups: 0 };
  /** Load and build costs (ms): fetch + decode, terrain meshes, Rapier colliders (tiles, instances), instances. */
  timings = { fetch: 0, terrain: 0, tileColliders: 0, instances: 0, instanceColliders: 0, warmup: 0 };

  private constructor(readonly json: StageJson, readonly bin: Float32Array, readonly catalog: Record<string, CatalogEntry>,
    readonly runtime: StageRuntimeJson) {
    this.road = new Road(json.road);
    this.group.name = `stage_${json.id}`;
  }

  static async load(id: string, catalog: Record<string, CatalogEntry>, runtime: StageRuntimeJson,
    rapier: typeof RAPIER, world: RAPIER.World): Promise<Stage> {
    const base = import.meta.env.BASE_URL;
    const t0 = performance.now();
    const [json, bin, stageGltf, envGltf] = await Promise.all([
      fetch(`${base}data/stages/${id}.json`).then((r) => r.json() as Promise<StageJson>),
      fetch(`${base}data/stages/${id}.bin`).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b)),
      loader().loadAsync(assetUrl(`stages/${id}.glb`)),
      loader().loadAsync(assetUrl(`env/env_${id}.glb`)),
    ]);
    const stage = new Stage(json, bin, catalog, runtime);
    const t1 = performance.now();
    stage.timings.fetch = t1 - t0;
    const mats = makeMaterials();
    stage.buildTerrain(stageGltf.scene, mats.tiles, rapier, world);
    const t2 = performance.now();
    stage.timings.terrain = t2 - t1;
    stage.collectEnv(envGltf.scene);
    stage.buildInstances(mats.instances, rapier, world);
    stage.timings.instances = performance.now() - t2;
    return stage;
  }

  // ---------------------------------------------------------------- terrain
  private buildTerrain(scene: THREE.Group, mats: Record<string, THREE.Material>, rapier: typeof RAPIER, world: RAPIER.World): void {
    const colliding = new Set([...this.json.tiles.map((t) => t.mesh),
      ...this.json.unique_meshes.filter((u) => u.collision !== 'none').map((u) => u.mesh)]);
    scene.updateMatrixWorld(true);
    const nodes = [...scene.children];
    for (const node of nodes) {
      const parts: THREE.Mesh[] = [];
      node.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh);
      });
      // colliders: one trimesh per surface of the node (water has none: the ford is drag, not a floor)
      if (colliding.has(node.name)) {
        const bySurface = new Map<Surface, { verts: number[]; idx: number[] }>();
        const v = new THREE.Vector3();
        for (const m of parts) {
          const slot = slotName(m.material as THREE.Material);
          if (slot === 'Water') continue;
          const surface = SLOT_SURFACE[slot] ?? 'grass';
          let acc = bySurface.get(surface);
          if (!acc) bySurface.set(surface, (acc = { verts: [], idx: [] }));
          const pos = m.geometry.getAttribute('position');
          const base = acc.verts.length / 3;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
            acc.verts.push(v.x, v.y, v.z);
          }
          const index = m.geometry.getIndex();
          const n = index ? index.count : pos.count;
          for (let k = 0; k < n; k++) acc.idx.push(base + (index ? index.getX(k) : k));
        }
        for (const [surface, { verts, idx }] of bySurface) {
          if (!idx.length) continue;
          const tc = performance.now();
          const col = world.createCollider(rapier.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setFriction(0.8));
          this.timings.tileColliders += performance.now() - tc;
          this.colliderSurface.set(col.handle, surface);
          this.stats.colliders++;
        }
      }
      for (const m of parts) {
        splitColour(m.geometry);
        m.material = mats[slotName(m.material as THREE.Material)] ?? mats.Flat;
        m.receiveShadow = true;
        m.castShadow = !node.name.includes('Backdrop');
      }
    }
    this.group.add(...nodes);
    // anything else the wheels touch (instance colliders, gantries) counts as grass, like UE's default
    this.surfaceAt = (collider) => this.colliderSurface.get(collider.handle) ?? 'grass';
  }

  // ---------------------------------------------------------------- instances
  private collectEnv(scene: THREE.Group): void {
    scene.updateMatrixWorld(true);
    for (const node of scene.children) {
      const parts: { geometry: THREE.BufferGeometry; slot: string }[] = [];
      node.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // bake the node transform (quantization scale/offset) into the geometry: instances are placed at
        // the origin. Quantized positions are normalized int16, so go to float first (no clamping).
        const g = m.geometry.clone();
        const pos = g.getAttribute('position');
        const f = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          f[i * 3] = pos.getX(i);
          f[i * 3 + 1] = pos.getY(i);
          f[i * 3 + 2] = pos.getZ(i);
        }
        g.setAttribute('position', new THREE.BufferAttribute(f, 3));
        const nrm = g.getAttribute('normal');
        if (nrm) {
          // foliage keeps its canopy normals (quantized): float them too, applyMatrix4 renormalizes
          const nf = new Float32Array(nrm.count * 3);
          for (let i = 0; i < nrm.count; i++) {
            nf[i * 3] = nrm.getX(i);
            nf[i * 3 + 1] = nrm.getY(i);
            nf[i * 3 + 2] = nrm.getZ(i);
          }
          g.setAttribute('normal', new THREE.BufferAttribute(nf, 3));
        }
        g.applyMatrix4(m.matrixWorld);
        splitColour(g);
        if (!g.getAttribute('sway')) g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(pos.count), 1));
        g.computeBoundingSphere();
        parts.push({ geometry: g, slot: slotName(m.material as THREE.Material) });
      });
      this.envGeoms.set(node.name, parts);
    }
  }

  private bandFor(category: string): [number, number] {
    const c = this.runtime.cull[category] ?? this.runtime.cull.default;
    return [c[0] / 100, c[1] / 100];
  }

  private mats: Record<string, THREE.Material> = {};

  private buildInstances(mats: Record<string, THREE.Material>, rapier: typeof RAPIER, world: RAPIER.World): void {
    this.mats = mats;
    const F = this.json.bin.floats_per_instance;
    const bin = this.bin;
    const n = bin.length / F;
    this.stats.instances = n;
    this.hue = new Float32Array(n);
    this.val = new Float32Array(n);
    const p = new THREE.Vector3();
    const nearRoad = this.runtime.collision_near_road_cm / 100;
    // two tables that share mesh names (SM_Bush_A is scenery and, near the road, a breakable): walk
    // both. Merging them as one object let the breakables replace every scenery bush and juniper.
    const tables = [
      ...Object.entries(this.json.bin.instances).map(([mesh, r]) => [mesh, r, false] as const),
      ...Object.entries(this.json.bin.breakables).map(([mesh, r]) => [mesh, r, true] as const),
    ];
    for (const [mesh, [offset, count], breakable] of tables) {
      const cat = this.catalog[mesh];
      const parts = this.envGeoms.get(mesh);
      if (!cat || !parts) {
        console.warn(`stage ${this.json.id}: no mesh or catalog entry for ${mesh}`);
        continue;
      }
      // tint: hue = (t − 0.5)·2·tint_hue_deg, value = (t − 0.5)·2·tint_value, t from the instance table
      for (let i = offset; i < offset + count; i++) {
        const t = cat.tintable ? (bin[i * F + 5] - 0.5) * 2 : 0;
        this.hue[i] = t * (cat.tint_hue_deg ?? 0);
        this.val[i] = t * (cat.tint_value ?? 0);
      }
      // chunk by terrain tile
      const chunks = new Map<string, number[]>();
      for (let i = offset; i < offset + count; i++) {
        const key = `${Math.floor(bin[i * F] / CHUNK)},${Math.floor(bin[i * F + 2] / CHUNK)}`;
        let list = chunks.get(key);
        if (!list) chunks.set(key, (list = []));
        list.push(i);
      }
      const [start, end] = this.bandFor(cat.category);
      // vegetation: three levels of detail and the same as shadow-only casters (lod.ts)
      const lodded = LOD_CATEGORIES.has(cat.category) && parts.some((pt) => pt.slot === 'Foliage');
      const levelParts = lodded ? this.lodParts(mesh, parts) : [parts];
      // reach of the mesh from its pivot (base centre)
      const meshRadius = Math.max(...levelParts.flat().map((pt) => (pt.geometry.boundingSphere?.center.length() ?? 0) + (pt.geometry.boundingSphere?.radius ?? 1)));
      for (const [key, ids] of chunks) {
        const box = new THREE.Box3();
        let maxScale = 0;
        for (const i of ids) {
          box.expandByPoint(p.set(bin[i * F], bin[i * F + 1], bin[i * F + 2]));
          maxScale = Math.max(maxScale, bin[i * F + 4]);
        }
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        sphere.radius += meshRadius * maxScale;
        const cap = ids.length;
        const level = (lp: typeof parts, n: number, shadowOnly: boolean, solid = false): Level => {
          const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
          a.setUsage(THREE.DynamicDrawUsage);
          const b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
          b.setUsage(THREE.DynamicDrawUsage);
          const meshes = lp.map((part) => {
            const g = new THREE.InstancedBufferGeometry();
            g.index = part.geometry.index;
            for (const [name, attr] of Object.entries(part.geometry.attributes)) g.setAttribute(name, attr);
            g.setAttribute('inst_a', a);
            g.setAttribute('inst_b', b);
            g.instanceCount = 0;
            // three culls the chunk per camera (main and shadow) with this sphere; the instances move
            // inside it as they are compacted, so it is set once and never recomputed
            g.boundingSphere = sphere;
            const slot = part.slot === 'Foliage' && lodded && n >= FAR_LEVEL ? 'FoliageFar' : part.slot;
            const matKey = mats[slot] ? `${slot}${solid ? '!' : ''}` : `Flat${solid ? '!' : ''}`;
            const im = new THREE.Mesh(g, mats[matKey]);
            im.userData.mat = matKey;
            im.visible = false;
            // vegetation casts through its shadow-only proxies (layer 1), never with the drawn levels
            im.castShadow = shadowOnly || (cat.shadow && !lodded);
            im.receiveShadow = !shadowOnly;
            if (shadowOnly) im.layers.set(1);
            im.name = `${mesh}@${key}${lodded ? (shadowOnly ? `:shadow${n}` : `:lod${n}`) : ''}${solid ? '!' : ''}`;
            this.group.add(im);
            return im;
          });
          // solid twins only where they pay: big alpha-tested canopies (grass is cheap to draw either way,
          // and every twin is another draw call per chunk)
          // (and only on the near levels: far trees are small on screen, their twins were just draw calls)
          return { parts: meshes, a, b, k: 0, solid: shadowOnly || solid || !lodded || n >= FAR_LEVEL ? null : level(lp, n, false, true) };
        };
        const levels = levelParts.map((lp, n) => level(lp, n, false));
        // shadow casters: trunk and foliage in one mesh per level (one draw per cascade instead of two)
        const shadow = lodded && cat.shadow ? levelParts.map((lp, n) => level(this.mergedParts(mesh, n, lp), n, true)) : [];
        this.groups.push({
          mesh, category: cat.category, start, end, sphere, ids: Uint32Array.from(ids), levels, shadow,
          all: [...levels.flatMap((l) => (l.solid ? [l, l.solid] : [l])), ...shadow], reach: meshRadius,
        });
      }
      // colliders for instances near the road (breakables come apart instead, in a later slice)
      // Meshes that are also breakables (bushes, junipers) get no colliders at all, scenery included: that
      // is what slice 4 shipped (the merge bug hid them), kept so the look slice leaves the sim untouched.
      // Whether scenery bushes by the road should block the car is a handling question for later.
      if (cat.collision !== 'none' && !breakable && !(mesh in this.json.bin.breakables)) {
        const tc = performance.now();
        for (let i = offset; i < offset + count; i++) {
          const x = bin[i * F], y = bin[i * F + 1], z = bin[i * F + 2];
          if (this.road.distanceTo(x, z) > nearRoad) continue;
          this.addInstanceCollider(rapier, world, cat, parts, x, y, z, bin[i * F + 3], bin[i * F + 4]);
        }
        this.timings.instanceColliders += performance.now() - tc;
      }
    }
    this.stats.groups = this.groups.length;
  }

  private lodCache = new Map<string, { geometry: THREE.BufferGeometry; slot: string }[][]>();
  /** The levels of detail of an env mesh, built once (lod.ts). */
  private lodParts(mesh: string, parts: { geometry: THREE.BufferGeometry; slot: string }[]) {
    let l = this.lodCache.get(mesh);
    if (!l) this.lodCache.set(mesh, (l = vegetationLods(parts)));
    return l;
  }

  private mergedCache = new Map<string, { geometry: THREE.BufferGeometry; slot: string }[]>();
  private mergedParts(mesh: string, n: number, parts: { geometry: THREE.BufferGeometry; slot: string }[]) {
    const k = `${mesh}:${n}`;
    let m = this.mergedCache.get(k);
    if (!m) this.mergedCache.set(k, (m = mergeParts(parts)));
    return m;
  }

  /** Triangles per level of an env mesh (for tools/check). */
  lodTriangles(): Record<string, number[]> {
    const tri = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    return Object.fromEntries([...this.lodCache].map(([m, l]) => [m, l.map((parts) => parts.reduce((n, p) => n + tri(p.geometry), 0))]));
  }

  private addInstanceCollider(rapier: typeof RAPIER, world: RAPIER.World, cat: CatalogEntry,
    parts: { geometry: THREE.BufferGeometry }[], x: number, y: number, z: number, rotY: number, s: number): void {
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    const at = (local: THREE.Vector3) => local.multiplyScalar(s).applyQuaternion(rot).add(new THREE.Vector3(x, y, z));
    const add = (desc: RAPIER.ColliderDesc, centre: THREE.Vector3) => {
      world.createCollider(desc.setTranslation(centre.x, centre.y, centre.z).setRotation(rot).setFriction(0.6));
      this.stats.colliders++;
    };
    if (cat.collision === 'capsule') {
      const r = (cat.collision_radius_cm / 100) * s;
      const h = (cat.height_cm / 100) * s;
      add(rapier.ColliderDesc.capsule(Math.max(0.01, h / 2 - r), r), at(new THREE.Vector3(0, cat.height_cm / 200, 0)));
    } else if (cat.collision === 'box') {
      // UE local cm (X forward, Y right, Z up) -> three local m (x, z, y)
      const boxes = cat.collision_boxes_cm ?? (cat.bounds_min_cm && cat.bounds_max_cm ? [{
        center: cat.bounds_min_cm.map((v, k) => (v + cat.bounds_max_cm![k]) / 2),
        half: cat.bounds_min_cm.map((v, k) => (cat.bounds_max_cm![k] - v) / 2),
      }] : []);
      for (const b of boxes) {
        add(rapier.ColliderDesc.cuboid((b.half[0] / 100) * s, (b.half[2] / 100) * s, (b.half[1] / 100) * s),
          at(new THREE.Vector3(b.center[0] / 100, b.center[2] / 100, b.center[1] / 100)));
      }
    } else if (cat.collision === 'complex') {
      const pts: number[] = [];
      const v = new THREE.Vector3();
      for (const pt of parts) {
        const pos = pt.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).multiplyScalar(s);
          pts.push(v.x, v.y, v.z);
        }
      }
      const desc = rapier.ColliderDesc.convexHull(new Float32Array(pts));
      if (desc) add(desc, new THREE.Vector3(x, y, z));
    }
  }

  /**
   * Draw every chunk mesh once (one instance each, unculled) so the renderer builds all its
   * pipelines and uploads every buffer during loading, not when a chunk first comes into view
   * (those builds were 60-380 ms hitches while driving).
   */
  warmup(render: () => void): void {
    for (const g of this.groups) {
      for (const l of g.all) {
        this.writeInstance(l, 0, g.ids[0], 1);
        l.a.needsUpdate = l.b.needsUpdate = true;
        for (const im of l.parts) {
          im.geometry.instanceCount = 1;
          im.visible = true;
          im.frustumCulled = false;
        }
      }
    }
    render();
    for (const g of this.groups) {
      for (const l of g.all) for (const im of l.parts) im.frustumCulled = true;
    }
    this.updateInstances(this.lastUpdate, true);
  }

  // ---------------------------------------------------------------- per frame
  private writeInstance(l: Level, k: number, i: number, fade: number): void {
    const F = this.json.bin.floats_per_instance;
    const bin = this.bin;
    const A = l.a.array as Float32Array, B = l.b.array as Float32Array;
    A[k * 4] = bin[i * F];
    A[k * 4 + 1] = bin[i * F + 1];
    A[k * 4 + 2] = bin[i * F + 2];
    A[k * 4 + 3] = bin[i * F + 4];
    B[k * 4] = bin[i * F + 3];
    B[k * 4 + 1] = fade;
    B[k * 4 + 2] = this.hue[i];
    B[k * 4 + 3] = this.val[i];
  }

  private lastUpdate = new THREE.Vector3(1e9, 0, 0);
  private lastCar = new THREE.Vector3(1e9, 0, 0);

  /**
   * Compact each chunk's visible instances by distance from the camera, with the fade over the band.
   * Instances fully in view and away from `car` (the see-through capsule from the camera to the car,
   * materials.ts occluder) go to the solid twins, which never discard.
   */
  updateInstances(camera: THREE.Vector3, force = false, car?: THREE.Vector3): void {
    if (!force && camera.distanceToSquared(this.lastUpdate) < 0.25) return;
    this.lastUpdate.copy(camera);
    if (car) this.lastCar.copy(car);
    const cx = this.lastCar.x - camera.x, cy = this.lastCar.y + 0.8 - camera.y, cz = this.lastCar.z - camera.z;
    const cl2 = Math.max(cx * cx + cy * cy + cz * cz, 1e-4);
    const F = this.json.bin.floats_per_instance;
    const bin = this.bin;
    const mul = this.drawDistance;
    const lod = this.lod;
    const cuts = lod.cuts, blend = lod.blend;
    const shadowRange2 = lod.shadowRange * lod.shadowRange, shadowCut2 = lod.shadowCut * lod.shadowCut;
    let visible = 0, drawn = 0;
    for (const g of this.groups) {
      const m = GROUND_COVER.has(g.category) ? mul * lod.groundDraw : mul;
      const start = g.start * m, end = g.end * m;
      const dc = g.sphere.distanceToPoint(camera);
      for (const l of g.all) l.k = 0;
      const L = g.levels;
      if (dc < end && !this.hidden.has(g.category)) {
        const end2 = end * end;
        for (let j = 0; j < g.ids.length; j++) {
          const i = g.ids[j];
          const dx = bin[i * F] - camera.x, dy = bin[i * F + 1] - camera.y, dz = bin[i * F + 2] - camera.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= end2) continue;
          const d = Math.sqrt(d2);
          const f = d <= start ? 1 : 1 - (d - start) / (end - start);
          visible++;
          // inside the capsule from the camera to the car (radius up to 8.3 m, plus the mesh's reach)?
          const tc = Math.min(Math.max((dx * cx + dy * cy + dz * cz) / cl2, 0), 1);
          const ex = dx - cx * tc, ey = dy - cy * tc, ez = dz - cz * tc, r = this.occluderReach + g.reach * bin[i * F + 4];
          const near = r > 0 && ex * ex + ey * ey + ez * ez < r * r;
          if (L.length === 1) {
            const l = f >= 1 && !near && L[0].solid ? L[0].solid : L[0];
            this.writeInstance(l, l.k++, i, f);
          } else {
            // level by distance; inside a switch's blend zone the two levels split the dither between them
            let n = 0;
            while (n < L.length - 1 && n < cuts.length && d >= cuts[n]) n++;
            const hi = n < L.length - 1 && n < cuts.length ? cuts[n] : Infinity, lo = hi * (1 - blend);
            if (d > lo && hi < Infinity) {
              const t = Math.round(((d - lo) / (hi - lo)) * 1023) / 1023; // share of the next level
              if (1 - t > 0) this.writeInstance(L[n], L[n].k++, i, fadeBand(0, Math.min(1 - t, f)));
              if (f > 1 - t) this.writeInstance(L[n + 1], L[n + 1].k++, i, fadeBand(1 - t, f));
            } else {
              const l = (f >= 1 && !near && L[n].solid) || L[n];
              this.writeInstance(l, l.k++, i, f);
            }
          }
          if (g.shadow.length && d2 < shadowRange2) {
            const s = g.shadow[d2 < shadowCut2 ? lod.shadowNear : lod.shadowFar];
            this.writeInstance(s, s.k++, i, 1);
          }
        }
      }
      for (const l of g.all) {
        if (l.k) {
          // upload only the compacted front of each buffer
          for (const a of [l.a, l.b]) {
            a.clearUpdateRanges();
            a.addUpdateRange(0, l.k * 4);
            a.needsUpdate = true;
          }
        }
        for (const im of l.parts) {
          im.geometry.instanceCount = l.k;
          im.visible = l.k > 0;
        }
        drawn += l.k;
      }
    }
    this.stats.visible = visible;
    this.stats.drawn = drawn;
  }

  // ---------------------------------------------------------------- gantries
  /** Start and finish arches at the road (front toward the approaching car), legs on the ground. */
  addGantries(startS: number, finishS: number, sign: number, rapier: typeof RAPIER, world: RAPIER.World,
    propMats: Record<string, THREE.Material> = makeMaterials().props): void {
    const g = this.runtime.gantries;
    const legOffset = g.leg_offset_cm / 100;
    const place = (mesh: string, s: number) => {
      const parts = this.envGeoms.get(mesh);
      const cat = this.catalog[mesh];
      if (!parts || !cat) return;
      const pose = this.road.pose(s, sign, 0, 0);
      const yaw = ((pose.yawDeg + 180) * Math.PI) / 180;
      const rotY = -yaw;
      const right = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw)); // UE right of the arch's yaw
      let y = pose.position.y;
      for (const side of [1, -1]) {
        const probe = pose.position.clone().addScaledVector(right, side * legOffset);
        const hit = world.castRay(new rapier.Ray({ x: probe.x, y: probe.y + 30, z: probe.z }, { x: 0, y: -1, z: 0 }), 90, true);
        if (hit) y = Math.min(y, probe.y + 30 - hit.timeOfImpact);
      }
      y -= 0.05;
      const root = new THREE.Group();
      root.name = mesh;
      root.position.set(pose.position.x, y, pose.position.z);
      root.rotation.y = rotY;
      for (const part of parts) {
        const geom = part.geometry.clone();
        const m = new THREE.Mesh(geom, propMats[part.slot] ?? propMats.Flat);
        m.castShadow = true;
        m.receiveShadow = true;
        root.add(m);
      }
      this.group.add(root);
      if (cat.collision !== 'none') this.addInstanceCollider(rapier, world, cat, parts, root.position.x, y, root.position.z, rotY, 1);
    };
    place(g.start, startS);
    place(g.finish, finishS);
  }
}

let gltfLoader: GLTFLoader | null = null;
function loader(): GLTFLoader {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return gltfLoader;
}
