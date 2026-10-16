// CPU-simulated particle pools drawn as one instanced mesh each (handoff §10; the original's
// ARallyFxManager). A pool has a fixed capacity and recycles its oldest particle when full. Every
// frame the live particles are moved, then compacted to the front of four per-instance attributes
// and only that front is uploaded: one draw per pool, however many are alive.
//
//   fx_a = (x, y, z, size)          size in metres (the meshes have radius 0.5: size = diameter)
//   fx_q = rotation quaternion
//   fx_c = (r, g, b, opacity)       linear colour; opacity already faded in and out
//   fx_e = (emissive, stretch, 0, 0) stretch scales local x (sparks and flames stretch along their velocity)
import * as THREE from 'three/webgpu';
import type { Rng } from './config';

/** One particle to spawn (the original's FRallyParticleSpawn, in metres). */
export interface Spawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size0: number;
  size1: number;
  stretch?: number;
  r: number; g: number; b: number;
  opacity?: number;
  emissive?: number;
  emissiveDecay?: number;
  drag?: number;
  gravity?: number;
  /** Particles falling below this height stop and lie flat (chips). */
  floorY?: number;
  /** Spin, degrees per second. */
  spin?: number;
  fadeIn?: number;
  fadeOutStart?: number;
}

// CPU state, one stride per particle
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, QX = 6, QY = 7, QZ = 8, QW = 9, AX = 10, AY = 11, AZ = 12,
  SPIN = 13, AGE = 14, LIFE = 15, S0 = 16, S1 = 17, STRETCH = 18, R = 19, G = 20, B = 21, OP = 22, EM = 23, EMD = 24,
  DRAG = 25, GRAV = 26, FLOOR = 27, FIN = 28, FOUT = 29, STRIDE = 30;

export class Pool {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  readonly capacity: number;
  alive = 0;
  /** Particles spawned since the pool was made (for checks). */
  spawned = 0;
  private st: Float32Array;
  private live: Uint8Array;
  private landed: Uint8Array;
  private next = 0;
  private a: THREE.InstancedBufferAttribute;
  private q: THREE.InstancedBufferAttribute;
  private c: THREE.InstancedBufferAttribute;
  private e: THREE.InstancedBufferAttribute;
  private tmp = { x: 0, y: 0, z: 0 };

  constructor(readonly name: string, capacity: number, geometry: THREE.BufferGeometry, material: THREE.Material, private rng: Rng) {
    this.capacity = capacity;
    this.st = new Float32Array(capacity * STRIDE);
    this.live = new Uint8Array(capacity);
    this.landed = new Uint8Array(capacity);
    const g = new THREE.InstancedBufferGeometry();
    g.index = geometry.index;
    for (const [k, v] of Object.entries(geometry.attributes)) g.setAttribute(k, v);
    const attr = () => {
      const x = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      x.setUsage(THREE.DynamicDrawUsage);
      return x;
    };
    g.setAttribute('fx_a', (this.a = attr()));
    g.setAttribute('fx_q', (this.q = attr()));
    g.setAttribute('fx_c', (this.c = attr()));
    g.setAttribute('fx_e', (this.e = attr()));
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = `fx_${name}`;
    // the particles stay near the car and move every frame: no bounds to keep up to date
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  emit(s: Spawn): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const o = i * STRIDE, st = this.st, rng = this.rng;
    st[o + PX] = s.x; st[o + PY] = s.y; st[o + PZ] = s.z;
    st[o + VX] = s.vx; st[o + VY] = s.vy; st[o + VZ] = s.vz;
    // random orientation (uniform unit quaternion) and spin axis
    const u1 = rng.next(), u2 = rng.next() * Math.PI * 2, u3 = rng.next() * Math.PI * 2;
    const r1 = Math.sqrt(1 - u1), r2 = Math.sqrt(u1);
    st[o + QX] = r1 * Math.sin(u2); st[o + QY] = r1 * Math.cos(u2); st[o + QZ] = r2 * Math.sin(u3); st[o + QW] = r2 * Math.cos(u3);
    const ax = rng.unit(this.tmp);
    st[o + AX] = ax.x; st[o + AY] = ax.y; st[o + AZ] = ax.z;
    st[o + SPIN] = ((s.spin ?? 0) * Math.PI) / 180;
    st[o + AGE] = 0;
    st[o + LIFE] = Math.max(0.02, s.life);
    st[o + S0] = s.size0; st[o + S1] = s.size1;
    st[o + STRETCH] = s.stretch ?? 1;
    st[o + R] = s.r; st[o + G] = s.g; st[o + B] = s.b;
    st[o + OP] = s.opacity ?? 1;
    st[o + EM] = s.emissive ?? 0;
    st[o + EMD] = s.emissiveDecay ?? 0;
    st[o + DRAG] = s.drag ?? 0;
    st[o + GRAV] = s.gravity ?? 0;
    st[o + FLOOR] = s.floorY ?? -1e9;
    st[o + FIN] = Math.max(0.001, s.fadeIn ?? 0.001);
    st[o + FOUT] = Math.min(Math.max(s.fadeOutStart ?? 0.999, 0), 0.999);
    this.live[i] = 1;
    this.landed[i] = 0;
    this.spawned++;
  }

  /** Draw one (zero-sized) instance on the next render, so its pipeline is built during loading. */
  warm(): void {
    this.mesh.geometry.instanceCount = 1;
    this.mesh.visible = true;
  }

  clear(): void {
    this.live.fill(0);
    this.alive = 0;
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /** Move every live particle by dt (the original's TickPool), then write and upload the compacted front. */
  update(dt: number): void {
    const st = this.st, live = this.live, landed = this.landed;
    const A = this.a.array as Float32Array, Q = this.q.array as Float32Array, C = this.c.array as Float32Array, E = this.e.array as Float32Array;
    let k = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!live[i]) continue;
      const o = i * STRIDE;
      const age = (st[o + AGE] += dt);
      if (age >= st[o + LIFE]) {
        live[i] = 0;
        continue;
      }
      if (!landed[i]) {
        const damp = Math.max(0, 1 - st[o + DRAG] * dt);
        st[o + VX] *= damp; st[o + VY] *= damp; st[o + VZ] *= damp;
        st[o + VY] -= st[o + GRAV] * dt;
        st[o + PX] += st[o + VX] * dt; st[o + PY] += st[o + VY] * dt; st[o + PZ] += st[o + VZ] * dt;
        const w = st[o + SPIN] * dt;
        if (w !== 0) {
          // q = rotation(axis, w) * q
          const h = w * 0.5, s = Math.sin(h);
          const bx = st[o + AX] * s, by = st[o + AY] * s, bz = st[o + AZ] * s, bw = Math.cos(h);
          const qx = st[o + QX], qy = st[o + QY], qz = st[o + QZ], qw = st[o + QW];
          st[o + QX] = bw * qx + bx * qw + by * qz - bz * qy;
          st[o + QY] = bw * qy - bx * qz + by * qw + bz * qx;
          st[o + QZ] = bw * qz + bx * qy - by * qx + bz * qw;
          st[o + QW] = bw * qw - bx * qx - by * qy - bz * qz;
        }
        if (st[o + PY] < st[o + FLOOR] && st[o + VY] < 0) {
          // lie flat on the ground, turned about the vertical
          st[o + PY] = st[o + FLOOR];
          st[o + VX] = st[o + VY] = st[o + VZ] = 0;
          landed[i] = 1;
          const h = st[o + AX] * Math.PI * 0.5;
          st[o + QX] = 0; st[o + QY] = Math.sin(h); st[o + QZ] = 0; st[o + QW] = Math.cos(h);
        }
      }
      st[o + EM] = Math.max(0, st[o + EM] - st[o + EMD] * dt);
      const a = age / st[o + LIFE];
      const size = st[o + S0] + (st[o + S1] - st[o + S0]) * (1 - (1 - a) * (1 - a));
      const fadeIn = Math.min(a / st[o + FIN], 1);
      const fadeOut = 1 - Math.min(Math.max((a - st[o + FOUT]) / (1 - st[o + FOUT]), 0), 1);
      let stretch = 1;
      const k4 = k * 4;
      const vx = st[o + VX], vy = st[o + VY], vz = st[o + VZ];
      const v2 = vx * vx + vy * vy + vz * vz;
      if (st[o + STRETCH] > 1.001 && !landed[i] && v2 > 1e-4) {
        // local +x along the velocity (shortest arc from (1, 0, 0))
        stretch = st[o + STRETCH];
        const l = Math.sqrt(v2), dx = vx / l, dy = vy / l, dz = vz / l;
        if (dx < -0.99999) {
          Q[k4] = 0; Q[k4 + 1] = 1; Q[k4 + 2] = 0; Q[k4 + 3] = 0;
        } else {
          const qw = 1 + dx, n = Math.sqrt(qw * qw + dz * dz + dy * dy);
          Q[k4] = 0; Q[k4 + 1] = -dz / n; Q[k4 + 2] = dy / n; Q[k4 + 3] = qw / n;
        }
      } else {
        Q[k4] = st[o + QX]; Q[k4 + 1] = st[o + QY]; Q[k4 + 2] = st[o + QZ]; Q[k4 + 3] = st[o + QW];
      }
      A[k4] = st[o + PX]; A[k4 + 1] = st[o + PY]; A[k4 + 2] = st[o + PZ]; A[k4 + 3] = size;
      C[k4] = st[o + R]; C[k4 + 1] = st[o + G]; C[k4 + 2] = st[o + B]; C[k4 + 3] = st[o + OP] * fadeIn * fadeOut;
      E[k4] = st[o + EM]; E[k4 + 1] = stretch; E[k4 + 2] = 0; E[k4 + 3] = 0;
      k++;
    }
    this.alive = k;
    if (k) {
      for (const at of [this.a, this.q, this.c, this.e]) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, k * 4);
        at.needsUpdate = true;
      }
    }
    this.mesh.geometry.instanceCount = k;
    this.mesh.visible = k > 0;
  }
}

/** Icosphere of radius 0.5, subdivided `subdiv` times, with a deterministic lumpy jitter (the original's puff). */
export function icosphere(subdiv: number, jitter: number, rng: Rng, smooth: boolean): THREE.BufferGeometry {
  const X = 0.525731112119133606, Z = 0.850650808352039932;
  let v: number[][] = [[-X, 0, Z], [X, 0, Z], [-X, 0, -Z], [X, 0, -Z], [0, Z, X], [0, Z, -X], [0, -Z, X], [0, -Z, -X], [Z, X, 0], [-Z, X, 0], [Z, -X, 0], [-Z, -X, 0]];
  let t = [0, 4, 1, 0, 9, 4, 9, 5, 4, 4, 5, 8, 4, 8, 1, 8, 10, 1, 8, 3, 10, 5, 3, 8, 5, 2, 3, 2, 7, 3, 7, 10, 3, 7, 6, 10, 7, 11, 6, 11, 0, 6, 0, 1, 6, 6, 1, 10, 9, 0, 11, 9, 11, 2, 9, 2, 5, 7, 2, 11];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mid.get(key);
      if (i === undefined) {
        const p = [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2, (v[a][2] + v[b][2]) / 2];
        const l = Math.hypot(p[0], p[1], p[2]);
        v.push([p[0] / l, p[1] / l, p[2] / l]);
        mid.set(key, (i = v.length - 1));
      }
      return i;
    };
    const nt: number[] = [];
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i], b = t[i + 1], c = t[i + 2];
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nt.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    t = nt;
  }
  v = v.map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    const r = 0.5 * (1 + rng.range(-jitter, jitter));
    return [(p[0] / l) * r, (p[1] / l) * r, (p[2] / l) * r];
  });
  const g = new THREE.BufferGeometry();
  if (smooth) {
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v.flat()), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(v.flatMap((p) => {
      const l = Math.hypot(p[0], p[1], p[2]);
      return [p[0] / l, p[1] / l, p[2] / l];
    })), 3));
    g.setIndex(t);
  } else {
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(t.flatMap((i) => v[i])), 3));
  }
  return fixWinding(g);
}

/** Make every triangle face away from the mesh's centre (three's front faces are counter-clockwise). */
function fixWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : p.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), ctr = new THREE.Vector3();
  const get = (k: number) => (idx ? idx.getX(k) : k);
  for (let k = 0; k < n; k += 3) {
    a.fromBufferAttribute(p, get(k));
    b.fromBufferAttribute(p, get(k + 1));
    c.fromBufferAttribute(p, get(k + 2));
    nrm.subVectors(b, a).cross(c.clone().sub(a));
    ctr.copy(a).add(b).add(c);
    if (nrm.dot(ctr) < 0) {
      if (idx) {
        const t = idx.getX(k + 1);
        idx.setX(k + 1, idx.getX(k + 2));
        idx.setX(k + 2, t);
      } else {
        for (let j = 0; j < 3; j++) {
          const t = p.getComponent(k + 1, j);
          p.setComponent(k + 1, j, p.getComponent(k + 2, j));
          p.setComponent(k + 2, j, t);
        }
      }
    }
  }
  return g;
}

/** The chip: one flat triangle (lies in the horizontal plane at rest). */
export function chipGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0.6, 0, 0, -0.3, 0, -0.52, -0.3, 0, 0.52]), 3));
  return g;
}

/** The spark: a thin box along x. */
export function sparkGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.24, 0.24);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}
