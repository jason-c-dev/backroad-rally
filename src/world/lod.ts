// Cheaper levels of detail for the vegetation, built at load time from the full mesh (no extra
// assets). The foliage of every tree and shrub is made of single-triangle chips (a spruce has ~800,
// a birch ~3600). A lower level keeps an evenly spread subset of the chips and scales each kept chip
// about its own centre so the canopy covers about as much as before: the silhouette and colour
// survive, the triangle count drops 3-50×. Trunks and branches (the Flat slot) keep their biggest
// pieces. The same geometry serves as the cheap shadow caster.
import * as THREE from 'three/webgpu';

/** Union-find islands of an indexed (or not) triangle list: island id per triangle. */
export function islands(index: ArrayLike<number> | null, vertexCount: number, triCount: number): Uint32Array {
  const parent = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const v = (k: number) => (index ? index[k] : k);
  for (let t = 0; t < triCount; t++) {
    const a = find(v(t * 3));
    parent[find(v(t * 3 + 1))] = a;
    parent[find(v(t * 3 + 2))] = a;
  }
  const out = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) out[t] = find(v(t * 3));
  return out;
}

/** 10-bit Morton code of a point in a box (spreads a subset evenly when taken in this order). */
function morton(x: number, y: number, z: number): number {
  const part = (n: number) => {
    n = Math.min(1023, Math.max(0, Math.floor(n * 1023)));
    n = (n | (n << 16)) & 0x030000ff;
    n = (n | (n << 8)) & 0x0300f00f;
    n = (n | (n << 4)) & 0x030c30c3;
    n = (n | (n << 2)) & 0x09249249;
    return n;
  };
  return part(x) | (part(y) << 1) | (part(z) << 2);
}

interface Piece {
  tris: number[];
  centre: THREE.Vector3;
  area: number;
}

function pieces(g: THREE.BufferGeometry): Piece[] {
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const tc = (index ? index.count : pos.count) / 3;
  const id = islands(index ? (index.array as ArrayLike<number>) : null, pos.count, tc);
  const byId = new Map<number, Piece>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const vi = (k: number) => (index ? index.getX(k) : k);
  for (let t = 0; t < tc; t++) {
    let p = byId.get(id[t]);
    if (!p) byId.set(id[t], (p = { tris: [], centre: new THREE.Vector3(), area: 0 }));
    p.tris.push(t);
    a.fromBufferAttribute(pos, vi(t * 3));
    b.fromBufferAttribute(pos, vi(t * 3 + 1));
    c.fromBufferAttribute(pos, vi(t * 3 + 2));
    const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    p.area += area;
    p.centre.addScaledVector(a.add(b).add(c), area / 3);
  }
  for (const p of byId.values()) p.centre.multiplyScalar(1 / Math.max(p.area, 1e-12));
  return [...byId.values()];
}

/** A new geometry with only the given pieces, each scaled by `scale` about its centre. */
function build(g: THREE.BufferGeometry, keep: Piece[], scale: number): THREE.BufferGeometry {
  const index = g.getIndex();
  const vi = (k: number) => (index ? index.getX(k) : k);
  const names = Object.keys(g.attributes);
  const src = names.map((n) => g.getAttribute(n));
  const tris = keep.reduce((n, p) => n + p.tris.length, 0);
  const out = names.map((_, i) => new Float32Array(tris * 3 * src[i].itemSize));
  const v = new THREE.Vector3();
  let w = 0;
  for (const p of keep) {
    for (const t of p.tris) {
      for (let k = 0; k < 3; k++, w++) {
        const s = vi(t * 3 + k);
        names.forEach((n, i) => {
          const a = src[i], size = a.itemSize;
          if (n === 'position') {
            v.fromBufferAttribute(a, s).sub(p.centre).multiplyScalar(scale).add(p.centre);
            out[i].set([v.x, v.y, v.z], w * 3);
          } else {
            for (let c = 0; c < size; c++) out[i][w * size + c] = a.getComponent(s, c);
          }
        });
      }
    }
  }
  const r = new THREE.BufferGeometry();
  names.forEach((n, i) => r.setAttribute(n, new THREE.BufferAttribute(out[i], src[i].itemSize)));
  r.computeBoundingSphere();
  return r;
}

/**
 * Foliage chips: keep about `target` triangles, evenly spread (every n-th chip in Morton order), each
 * scaled by sqrt(chips / kept) so the total area stays the same.
 */
export function thinFoliage(g: THREE.BufferGeometry, target: number): THREE.BufferGeometry {
  const ps = pieces(g);
  const tris = ps.reduce((n, p) => n + p.tris.length, 0);
  if (tris <= target * 1.15) return g;
  g.computeBoundingBox();
  const box = g.boundingBox!, size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
  const order = ps.map((p) => ({ p, m: morton((p.centre.x - box.min.x) / size.x, (p.centre.y - box.min.y) / size.y, (p.centre.z - box.min.z) / size.z) }))
    .sort((a, b) => a.m - b.m).map((o) => o.p);
  const step = tris / target;
  const keep: Piece[] = [];
  for (let f = step / 2; f < order.length; f += step) keep.push(order[Math.floor(f)]);
  const keptArea = keep.reduce((n, p) => n + p.area, 0), area = ps.reduce((n, p) => n + p.area, 0);
  return build(g, keep, Math.sqrt(area / Math.max(keptArea, 1e-9)));
}

/** Trunks and branches: the biggest pieces that make up `share` of the area (at least `minTris`). */
export function thinSolid(g: THREE.BufferGeometry, share: number, minTris = 24): THREE.BufferGeometry {
  const ps = pieces(g).sort((a, b) => b.area - a.area);
  const tris = ps.reduce((n, p) => n + p.tris.length, 0);
  if (tris <= minTris) return g;
  const total = ps.reduce((n, p) => n + p.area, 0);
  const keep: Piece[] = [];
  let acc = 0, kept = 0;
  for (const p of ps) {
    if (acc >= total * share && kept >= minTris) break;
    keep.push(p);
    acc += p.area;
    kept += p.tris.length;
  }
  return build(g, keep, 1);
}

/**
 * The per-instance fade is a band [lo, hi) of the dither noise in which the pixel is kept, packed in
 * one float as 2·round(lo·1023) + hi: plain fades are [0, f), and two levels cross-fade by splitting
 * [0, 1) between them, so together they cover every pixel once (materials.ts decodes it).
 */
export const fadeBand = (lo: number, hi: number) => 2 * Math.round(lo * 1023) + hi;

/** Decode fadeBand (what the material does, per vertex). */
export const fadeBandDecode = (v: number): [number, number] => {
  const q = Math.floor(v * 0.5);
  return [q / 1023, v - q * 2];
};

/**
 * Share of the foliage chips kept per level (level 0 is the full mesh), and the fewest kept. A spruce
 * (~800 chips) becomes ~280, ~80 and ~20; a birch (~3600 tiny chips) ~1250, ~360 and ~90. Fewer,
 * bigger chips read as flat triangles from the high camera at 60-100 m (a birch at 300 chips did), so
 * the coarse levels are for far away only. On an integrated GPU the far trees' triangle count, not
 * their pixels, was the cost: tiny triangles keep the rasterizer busy whatever the resolution.
 */
export const LOD_FOLIAGE_SHARE = [1, 0.35, 0.1, 0.025];
export const LOD_FOLIAGE_MIN = [0, 48, 32, 12];
/** Share of the trunk and branch area kept per level. */
export const LOD_SOLID_SHARE = [1, 1, 0.7, 0.5];

/** From this level on, the trunk is merged into the foliage: one draw call instead of two. */
export const LOD_MERGE_FROM = 2;

/** Non-indexed copy with the given attributes; `normal` is made from the faces when missing. */
function soup(g: THREE.BufferGeometry, names: string[]): THREE.BufferGeometry {
  const s = g.index ? g.toNonIndexed() : g.clone();
  if (!s.getAttribute('normal')) s.computeVertexNormals(); // non-indexed: face normals
  for (const n of Object.keys(s.attributes)) if (!names.includes(n)) s.deleteAttribute(n);
  return s;
}

/** Append geometries that have the same attributes (non-indexed). */
export function mergeSoups(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = Object.keys(gs[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = gs[0].getAttribute(n).itemSize;
    const arr = new Float32Array(gs.reduce((k, g) => k + g.getAttribute(n).count * size, 0));
    let o = 0;
    for (const g of gs) {
      const a = g.getAttribute(n);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) arr[o++] = a.getComponent(i, c);
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

/** One part (the foliage slot) holding every part's triangles: a single draw per level, e.g. for shadows. */
export function mergeParts<P extends { geometry: THREE.BufferGeometry; slot: string }>(parts: P[]): P[] {
  const foliage = parts.find((p) => p.slot === 'Foliage');
  if (!foliage || parts.length < 2) return parts;
  const names = ['position', 'normal', 'color', 'sway'];
  return [{ ...foliage, geometry: mergeSoups(parts.map((p) => soup(p.geometry, names))) }];
}

/** The levels of a mesh's parts: [full, mid, far, farthest]. */
export function vegetationLods<P extends { geometry: THREE.BufferGeometry; slot: string }>(parts: P[]): P[][] {
  const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  return LOD_FOLIAGE_SHARE.map((share, level) => {
    if (level === 0) return parts;
    const thinned = parts.map((p) => ({
      ...p,
      geometry: p.slot === 'Foliage' ? thinFoliage(p.geometry, Math.max(LOD_FOLIAGE_MIN[level], Math.round(tris(p.geometry) * share)))
        : LOD_SOLID_SHARE[level] < 1 ? thinSolid(p.geometry, LOD_SOLID_SHARE[level]) : p.geometry,
    }));
    // far away a trunk is a few pixels: draw it with the foliage material (two-sided, face normals)
    return level < LOD_MERGE_FROM ? thinned : mergeParts(thinned);
  });
}
