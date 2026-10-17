// The weather's marks on the road (slice 8; the original's AStageActor road decals and M_RoadDecal):
//
//   puddles  rain: dark, glossy blobs in the road's dips (game/weather.ts puddleSites) that reflect the
//            condition's sky colour toward their middle, broken by slow ripples
//   ruts     snow: two darker wheel tracks along the whole road, 0.5 m each side of the centreline
//   ice      snow: blue-grey glossy blobs over each ice patch (game/weather.ts icePatches)
//
// The original projected deferred decals onto the terrain. Here each mark is a small grid of quads draped on
// the ground under the road (one ray down per vertex, at load) and lifted 3 cm, all in one mesh and one
// draw. The material is lit like the ground: colour, roughness and the blob or rut mask per pixel.
import * as THREE from 'three/webgpu';
import { attribute, float, floor, fract, length, max, mix, positionWorld, sin, smoothstep, time, vec2, dot, abs, select } from 'three/tsl';
import type { Road } from '../sim/road';
import type { Puddle } from '../game/weather';
import { U } from '../look/uniforms';

type N = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V4 = THREE.Node<'vec4'>;

/** Ground height under a world point (x, z), or null: a ray down onto the stage. */
export type GroundAt = (x: number, z: number, fromY: number) => number | null;

/** The original's decal looks (make_weather_materials.py MI_Decal_*): colour (linear), opacity, roughness, sky reflection. */
const LOOKS = {
  puddle: { colour: [0.045, 0.05, 0.055], opacity: 0.8, rough: 0.06, sky: 1, pattern: 0 },
  ice: { colour: [0.22, 0.29, 0.4], opacity: 0.7, rough: 0.04, sky: 0, pattern: 0 },
  rut: { colour: [0.33, 0.33, 0.35], opacity: 0.55, rough: 0.65, sky: 0, pattern: 1 },
} as const;
type Kind = keyof typeof LOOKS;

const LIFT = 0.03;

export class RoadMarks {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  readonly counts = { puddles: 0, ice: 0, ruts: 0 };
  private pos: number[] = [];
  private uv: number[] = [];
  private look: number[] = []; // r, g, b, opacity
  private extra: number[] = []; // roughness, sky reflection, pattern
  private index: number[] = [];

  constructor(private readonly road: Road, private readonly ground: GroundAt) {
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.name = 'RoadMarks';
    const look = attribute('m_look', 'vec4') as unknown as V4;
    const extra = attribute('m_extra', 'vec3') as unknown as THREE.Node<'vec3'>;
    const uvA = attribute('m_uv', 'vec2') as unknown as V2;
    // Pn: 1 m cells of the ground plane (the original: frac(p / 40 m) x 40)
    const pn = fract(vec2(positionWorld.x, positionWorld.z).div(40)).mul(40);
    const cell = floor(pn);
    const f = fract(pn);
    const s = f.mul(f).mul(f.mul(-2).add(3));
    const h = (c: V2) => fract(sin(dot(c, vec2(127.1, 311.7))).mul(43758.5453));
    const n = mix(mix(h(cell), h(cell.add(vec2(1, 0))), s.x), mix(h(cell.add(vec2(0, 1))), h(cell.add(vec2(1, 1))), s.x), s.y);
    const q = uvA.mul(2).sub(1);
    // pattern 0: a soft blob with a noisy edge; 1: two ruts along u at v = +-0.42, ends faded
    const e = abs(q);
    const r = length(max(e.sub(vec2(0.2, 0.05)), 0).div(vec2(0.8, 0.95)));
    const blob = float(1).sub(smoothstep(n.sub(0.5).mul(0.35).add(0.25), 0.95, r.add(n.sub(0.5).mul(0.3))));
    const v = abs(q.y);
    const rut = float(1).sub(smoothstep(0.065, 0.13, abs(v.sub(0.42)))).mul(float(1).sub(smoothstep(0.8, 1, abs(q.x)))).mul(n.mul(0.5).add(0.75));
    const mask = select(extra.z.greaterThan(0.5), rut, blob);
    m.colorNode = look.xyz;
    m.roughnessNode = extra.x;
    m.opacityNode = mask.mul(look.w).clamp(0, 1) as N;
    // puddles: the sky's colour toward the middle, with slow drifting ripples
    const core = float(1).sub(smoothstep(0.05, 0.8, r));
    const p = pn.mul(3).add(vec2(time.mul(0.35), time.mul(0.21)));
    const rip = sin(p.x.mul(2.1).add(sin(p.y.mul(1.7)))).mul(0.25).add(sin(p.y.mul(2.7).sub(time.mul(1.3))).mul(0.25)).add(0.5);
    m.emissiveNode = U.skyColor.mul(extra.y).mul(core).mul(mix(float(0.7), float(1.1), rip));
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    this.mesh.name = 'RoadMarks';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    // after the ground, before the dust and the precipitation
    this.mesh.renderOrder = -2;
  }

  /**
   * One mark centred on the road at s: `length` along it, `width` across, `lateral` m right of the centreline
   * (in the road's sample direction). Draped every ~1 m along and over `across` columns.
   */
  private add(kind: Kind, s: number, length: number, width: number, lateral = 0, across = 4): void {
    const L = LOOKS[kind];
    const steps = Math.max(1, Math.ceil(length));
    const base = this.pos.length / 3;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const q = this.road.sampleAt(s + (u - 0.5) * length);
      for (let j = 0; j <= across; j++) {
        const v = j / across;
        const off = lateral + (v - 0.5) * width;
        // right of the sample direction (x, z): (-dz, dx)
        const x = q.p.x - q.dz * off, z = q.p.z + q.dx * off;
        const y = this.ground(x, z, q.p.y + 2) ?? q.p.y;
        this.pos.push(x, y + LIFT, z);
        this.uv.push(u, v);
        this.look.push(L.colour[0], L.colour[1], L.colour[2], L.opacity);
        this.extra.push(L.rough, L.sky, L.pattern);
      }
    }
    const row = across + 1;
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < across; j++) {
        const a = base + i * row + j, b = a + row;
        this.index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }

  puddles(list: readonly Puddle[]): void {
    for (const p of list) this.add('puddle', p.s, p.length, p.width, p.lateral);
    this.counts.puddles += list.length;
  }

  /** Ice blobs over each patch: one every ~6 m, 1.35x as long as the step so they overlap, 0.9 of the road wide. */
  ice(patches: readonly [number, number][], widthScale = 0.9): void {
    for (const [a, b] of patches) {
      const n = Math.max(1, Math.ceil((b - a) / 6));
      const step = (b - a) / n;
      for (let k = 0; k < n; k++) {
        const s = a + step * (k + 0.5);
        this.add('ice', s, step * 1.35, this.road.sampleAt(s).halfWidth * 2 * widthScale);
        this.counts.ice++;
      }
    }
  }

  /**
   * Snow ruts along the whole road, `width` m wide, segment by segment (3-8 m: shorter in bends, as the
   * original), skipping fords and bridges. Each segment fades at its ends and overlaps the next by 20%.
   */
  ruts(segment: [number, number], width: number, skip: (s: number) => boolean): void {
    const S = this.road.s;
    const s1 = S[S.length - 1];
    let s = S[0];
    const [minL, maxL] = segment;
    while (s < s1 - 1) {
      let len = maxL;
      const d0 = this.road.sampleAt(s);
      while (len > minL) {
        const d1 = this.road.sampleAt(s + len);
        const ang = Math.abs(Math.atan2(d0.dx * d1.dz - d0.dz * d1.dx, d0.dx * d1.dx + d0.dz * d1.dz)) * 180 / Math.PI;
        if (ang < 7) break;
        len = Math.max(minL, len * 0.75);
      }
      len = Math.min(len, s1 - s);
      if (!skip(s + len * 0.5)) {
        this.add('rut', s + len * 0.5, len * 1.2, width, 0, 2);
        this.counts.ruts++;
      }
      s += len;
    }
  }

  /** Upload what was added (call once after the marks are placed). */
  build(): void {
    const g = this.mesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('m_uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('m_look', new THREE.Float32BufferAttribute(this.look, 4));
    g.setAttribute('m_extra', new THREE.Float32BufferAttribute(this.extra, 3));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    // flat-ish quads lit from above: an up normal is close enough and keeps the shading even
    const nrm = new Float32Array(this.pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    this.mesh.visible = this.index.length > 0;
    this.pos = this.uv = this.look = this.extra = this.index = [];
  }
}
