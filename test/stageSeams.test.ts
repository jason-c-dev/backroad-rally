// The terrain tiles meet without a crack (issue #36). The stage GLB quantizes each tile over its own bounds, so the
// two copies of a vertex on the edge between two tiles decode up to 2 cm apart, and the background showed through
// as a thin light line along the tile edge (down the middle of the finland start straight). src/world/seams.ts
// welds the copies at load: here the GLBs are decoded as the game does (int16 / 32767 x scale + offset, in world
// space, float32) and every open-edge vertex that has a copy in another mesh must then be exactly that copy.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { weldSeams, type SeamPart } from '../src/world/seams';

const STAGES = ['finland', 'japan', 'alps', 'wales', 'arizona', 'vermont'];
const NEAR = 0.03; // m: closer than this, two edge vertices of different meshes are copies of one vertex

interface Part extends SeamPart {
  index: Uint32Array;
  name: string;
}

/** The terrain meshes in world space, as stage.ts bakes them (the backdrop has no neighbours and stays out). */
async function decode(id: string): Promise<Part[]> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(readFileSync(new URL(`../public/assets/stages/${id}.glb`, import.meta.url))));
  const parts: Part[] = [];
  doc.getRoot().listNodes().forEach((node, n) => {
    const mesh = node.getMesh();
    if (!mesh || node.getName().includes('Backdrop')) return;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION')!;
      const pos = new Float32Array(a.getCount() * 3);
      const e: number[] = [];
      for (let i = 0; i < a.getCount(); i++) {
        a.getElement(i, e);
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = m[k] * e[0] + m[4 + k] * e[1] + m[8 + k] * e[2] + m[12 + k];
      }
      parts.push({ pos, node: n, index: Uint32Array.from(prim.getIndices()!.getArray()!), name: node.getName() });
    }
  });
  return parts;
}

/** Open-edge vertices of each node, and how many have a copy in another node at 0 distance / within NEAR but apart. */
function seamGaps(parts: Part[]) {
  const byNode = new Map<number, Part[]>();
  for (const p of parts) (byNode.get(p.node) ?? byNode.set(p.node, []).get(p.node)!).push(p);
  const pts: { node: number; x: number; y: number; z: number }[] = [];
  for (const [node, ps] of byNode) {
    const edges = new Map<string, { n: number; v: number[][] }>();
    for (const p of ps) {
      const v = (i: number) => [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]];
      for (let f = 0; f < p.index.length; f += 3) {
        for (let k = 0; k < 3; k++) {
          const a = v(p.index[f + k]), b = v(p.index[f + ((k + 1) % 3)]);
          const ka = a.join(), kb = b.join();
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const e = edges.get(key) ?? { n: 0, v: [a, b] };
          e.n++;
          edges.set(key, e);
        }
      }
    }
    const seen = new Set<string>();
    for (const e of edges.values()) {
      if (e.n !== 1) continue;
      for (const [x, y, z] of e.v) if (!seen.has(`${x},${y},${z}`)) seen.add(`${x},${y},${z}`) && pts.push({ node, x, y, z });
    }
  }
  const cell = (v: number) => Math.floor(v / NEAR);
  const grid = new Map<string, typeof pts>();
  for (const q of pts) (grid.get(`${cell(q.x)},${cell(q.z)}`) ?? grid.set(`${cell(q.x)},${cell(q.z)}`, []).get(`${cell(q.x)},${cell(q.z)}`)!).push(q);
  let shared = 0, apart = 0;
  const off: number[][] = [];
  for (const q of pts) {
    let best = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of grid.get(`${cell(q.x) + a},${cell(q.z) + b}`) ?? []) {
        if (o.node !== q.node) best = Math.min(best, Math.max(Math.abs(o.x - q.x), Math.abs(o.y - q.y), Math.abs(o.z - q.z)));
      }
    }
    if (best === 0) shared++;
    else if (best < NEAR) {
      apart++;
      if (off.length < 5) off.push([q.x, q.y, q.z]);
    }
  }
  return { shared, apart, off };
}

describe.each(STAGES)('stage %s terrain', (id) => {
  it('has cracks as converted, and none after weldSeams', async () => {
    const parts = await decode(id);
    const before = seamGaps(parts);
    expect(before.apart).toBeGreaterThan(1000); // the per-tile grids: copies apart
    const t0 = performance.now();
    const r = weldSeams(parts);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    console.info(`${id}: ${r.moved} vertices welded, largest move ${(r.maxMove * 100).toFixed(1)} cm, ${ms.toFixed(0)} ms`);
    expect(r.maxMove).toBeLessThan(NEAR);
    const after = seamGaps(parts);
    expect(after.apart, JSON.stringify(after.off)).toBe(0);
    expect(after.shared).toBeGreaterThanOrEqual(before.shared + before.apart);
  });
});
