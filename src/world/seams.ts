// Closing the cracks between terrain tiles (issue #36: a thin light line down the middle of the road).
//
// The stage GLB holds one mesh per 256 m terrain tile. Its converter (tools/convert/glb.mjs) quantizes each mesh
// over its own bounds, so each tile has its own position grid: the two copies of a vertex on the edge between two
// tiles decode up to 2 cm apart, and the background (the fog colour) shows through the gap. Where a road runs along
// a tile edge (the finland start straight runs on one), that is a light line down the centre of the road.
//
// At load, after the colliders are built (so the physics, and the pinned autopilot times, do not change), the copies
// of each edge vertex in the other tiles and bridges take the first copy's value. Together with world-space
// positions (stage.ts bakes the tile transforms), every copy is then the same float on the GPU and the edge is closed.

/** One terrain mesh part: its world positions (x, y, z), and the node it belongs to (copies in one node are left alone). */
export interface SeamPart {
  pos: Float32Array;
  node: number;
}

/**
 * Copies of a vertex in different nodes, closer than `tol` on each axis, take one value (the first copy's). Every
 * vertex is looked at: the tile edges follow the terrain's triangles and zigzag up to ~30 m about the 256 m lines.
 * A spatial hash on `tol` cells in x and z, in typed arrays (no allocation per vertex): ~400k vertices a stage.
 * Returns the number of vertices moved and the largest move (m).
 */
export function weldSeams(parts: SeamPart[], tol = 0.03): { moved: number; maxMove: number } {
  let n = 0;
  for (const p of parts) n += p.pos.length / 3;
  // the first copies, in insertion order: part, index into its pos array; chained per cell
  const vPart = new Int32Array(n), vIdx = new Int32Array(n), vNext = new Int32Array(n);
  let count = 0;
  let size = 1;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const slotX = new Int32Array(size), slotZ = new Int32Array(size), slotHead = new Int32Array(size).fill(-1);
  const slotOf = (cx: number, cz: number, create: boolean): number => {
    let h = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & mask;
    for (;;) {
      if (slotHead[h] < 0) {
        if (!create) return -1;
        slotX[h] = cx;
        slotZ[h] = cz;
        return h;
      }
      if (slotX[h] === cx && slotZ[h] === cz) return h;
      h = (h + 1) & mask;
    }
  };
  let moved = 0, maxMove = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const { pos, node } = parts[pi];
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const cx = Math.floor(x / tol), cz = Math.floor(z / tol);
      let hit = -1;
      for (let a = -1; a <= 1 && hit < 0; a++) {
        for (let b = -1; b <= 1 && hit < 0; b++) {
          const s = slotOf(cx + a, cz + b, false);
          for (let v = s < 0 ? -1 : slotHead[s]; v >= 0; v = vNext[v]) {
            const q = parts[vPart[v]];
            if (q.node === node) continue;
            const j = vIdx[v];
            if (Math.abs(q.pos[j] - x) < tol && Math.abs(q.pos[j + 1] - y) < tol && Math.abs(q.pos[j + 2] - z) < tol) {
              hit = v;
              break;
            }
          }
        }
      }
      if (hit >= 0) {
        const q = parts[vPart[hit]].pos, j = vIdx[hit];
        if (q[j] !== x || q[j + 1] !== y || q[j + 2] !== z) {
          maxMove = Math.max(maxMove, Math.hypot(q[j] - x, q[j + 1] - y, q[j + 2] - z));
          pos[i] = q[j];
          pos[i + 1] = q[j + 1];
          pos[i + 2] = q[j + 2];
          moved++;
        }
        continue; // a copy: the first one stands for it
      }
      const s = slotOf(cx, cz, true);
      vPart[count] = pi;
      vIdx[count] = i;
      vNext[count] = slotHead[s];
      slotHead[s] = count++;
    }
  }
  return { moved, maxMove };
}
