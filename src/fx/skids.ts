// Skid marks (handoff §10; the original's AddSkidSegment): a ring buffer of quads, one draw. A new
// segment overwrites the oldest; its spawn time rides along as an attribute and the shader fades it
// by age, so nothing on the CPU touches old marks. Only the slots written this frame are uploaded.
import * as THREE from 'three/webgpu';
import type { Color } from 'three';

export class SkidMarks {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  /** Segments placed since the start (for checks). */
  placed = 0;
  private next = 0;
  private count = 0;
  private attrs: THREE.InstancedBufferAttribute[];
  /** Slots written since the last upload: [first, n). */
  private dirtyFrom = -1;
  private dirtyN = 0;

  constructor(readonly capacity: number, material: THREE.Material, private lift: number) {
    const g = new THREE.InstancedBufferGeometry();
    // unit quad in x (along) and z (across), facing +y
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]), 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.attrs = ['sk_a', 'sk_b', 'sk_c', 'sk_d'].map((name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    });
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'fx_skids';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // before the dust (both are blended): marks lie under it
    this.mesh.renderOrder = -1;
  }

  /** A mark from a to b on a surface with this normal (all three metres), `width` m wide. */
  add(a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3, width: number, color: Color, opacity: number, now: number): void {
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    // along the segment, flattened onto the surface
    const nd = dx * normal.x + dy * normal.y + dz * normal.z;
    dx -= normal.x * nd; dy -= normal.y * nd; dz -= normal.z * nd;
    const l = Math.hypot(dx, dy, dz) || 1;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    const [A, B, C, D] = this.attrs.map((x) => x.array as Float32Array);
    const k = i * 4;
    A[k] = (a.x + b.x) / 2 + normal.x * this.lift;
    A[k + 1] = (a.y + b.y) / 2 + normal.y * this.lift;
    A[k + 2] = (a.z + b.z) / 2 + normal.z * this.lift;
    A[k + 3] = len + width * 0.15; // overlap a little so joints don't show gaps on curves
    B[k] = dx / l; B[k + 1] = dy / l; B[k + 2] = dz / l; B[k + 3] = width;
    C[k] = normal.x; C[k + 1] = normal.y; C[k + 2] = normal.z; C[k + 3] = now;
    D[k] = color.r; D[k + 1] = color.g; D[k + 2] = color.b; D[k + 3] = Math.min(Math.max(opacity, 0), 1);
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = i;
      this.dirtyN = 0;
    }
    this.dirtyN = Math.min(this.dirtyN + 1, this.capacity);
    this.placed++;
  }

  /** Draw one (zero-sized) quad on the next render: its pipeline is built during loading. */
  warm(): void {
    this.mesh.geometry.instanceCount = 1;
    this.mesh.visible = true;
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
    this.dirtyFrom = -1;
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /** Upload what changed (two ranges when the ring wrapped). */
  update(): void {
    if (this.dirtyFrom >= 0) {
      const first = this.dirtyFrom, n = this.dirtyN;
      const end = first + n;
      for (const at of this.attrs) {
        at.clearUpdateRanges();
        at.addUpdateRange(first * 4, Math.min(end, this.capacity) * 4 - first * 4);
        if (end > this.capacity) at.addUpdateRange(0, (end - this.capacity) * 4);
        at.needsUpdate = true;
      }
      this.dirtyFrom = -1;
    }
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }
}
