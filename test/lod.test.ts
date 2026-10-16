import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { fadeBand, fadeBandDecode, islands, thinFoliage, thinSolid } from '../src/world/lod';

// n separate single-triangle chips on a 10 m grid, like the trees' foliage
function chips(n: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 20) * 0.5, y = Math.floor(i / 20) * 0.5, z = (i * 7919) % 13 * 0.1;
    pos.push(x, y, z, x + 0.2, y, z, x, y + 0.2, z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 1));
  return g;
}
const area = (g: THREE.BufferGeometry) => {
  const p = g.getAttribute('position'), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let s = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1).sub(a);
    c.fromBufferAttribute(p, i + 2).sub(a);
    s += b.cross(c).length() / 2;
  }
  return s;
};

describe('vegetation levels of detail', () => {
  it('finds islands', () => {
    // two triangles sharing an edge, one alone
    const id = islands([0, 1, 2, 1, 2, 3, 4, 5, 6], 7, 3);
    expect(id[0]).toBe(id[1]);
    expect(id[2]).not.toBe(id[0]);
  });

  it('keeps about the target number of chips and the canopy area', () => {
    const g = chips(800);
    const t = thinFoliage(g, 100);
    const tris = t.getAttribute('position').count / 3;
    expect(tris).toBeGreaterThanOrEqual(95);
    expect(tris).toBeLessThanOrEqual(105);
    expect(area(t)).toBeCloseTo(area(g), 3);
    expect(t.getAttribute('sway').count).toBe(tris * 3);
  });

  it('leaves small meshes alone', () => {
    const g = chips(50);
    expect(thinFoliage(g, 64)).toBe(g);
    expect(thinSolid(g, 0.5, 60)).toBe(g);
  });

  it('packs fade bands that cross-fade without gaps', () => {
    for (const t of [0, 0.25, 0.5, 0.999, 1]) {
      const q = Math.round(t * 1023) / 1023;
      const [lo0, hi0] = fadeBandDecode(fadeBand(0, 1 - q));
      const [lo1, hi1] = fadeBandDecode(fadeBand(1 - q, 1));
      expect(lo0).toBe(0);
      expect(hi0).toBeCloseTo(lo1, 6);
      expect(hi1).toBe(1);
    }
    expect(fadeBandDecode(fadeBand(0, 0.3))).toEqual([0, expect.closeTo(0.3, 6)]);
  });
});
