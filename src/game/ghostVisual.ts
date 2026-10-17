// The ghost cars' look (the original's M_Ghost on a car mesh): a see-through car, dithered (alpha-tested against
// interleaved gradient noise, never blended), lit, with a little glow; no shadow, no collision.
//
// Every ghost (the best run, up to nine rivals) is ONE mesh with ONE shared material: the car's parts are merged
// into one geometry in its rest pose (the wheels don't turn: the original's rival ghosts drew a static pose too),
// its colours baked per vertex (`gcolor`, linear), and the opacity and glow are per-object uniforms. So the ghosts
// cost one draw each and one shader in all, which src/main.ts warms during loading: no compile mid-run.
import * as THREE from 'three/webgpu';
import { attribute, float, frameId, interleavedGradientNoise, screenCoordinate, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarData, Livery } from '../data';
import { loadCarModel } from '../car/carModel';
import { U } from '../look/uniforms';

export const PAINT_SLOTS = ['Paint1', 'Paint2', 'Paint3', 'Rim'] as const;

/** What colours a ghost: one colour for all of it (the best run), or a livery tinted per rival with a dark trim. */
export type GhostColours =
  | { kind: 'solid'; color: string }
  | { kind: 'livery'; livery: Livery; tint: string; tintMix: number; trim: string };

let material: THREE.MeshStandardNodeMaterial | null = null;

/** The one ghost material: colour per vertex, opacity and glow per object (userData.ghostOpacity, ghostGlow). */
export function ghostMaterial(): THREE.MeshStandardNodeMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
  m.name = 'Ghost';
  const opacity = uniform(0).onObjectUpdate(({ object }) => (object?.userData.ghostOpacity as number | undefined) ?? 0);
  const glow = uniform(0).onObjectUpdate(({ object }) => (object?.userData.ghostGlow as number | undefined) ?? 0);
  const c = attribute('gcolor', 'vec3') as unknown as THREE.Node<'vec3'>;
  m.colorNode = c;
  // the glow lifts it a little off the ground at night too (UE M_Ghost "Glow")
  m.emissiveNode = c.mul(glow).mul(vec3(0.6).add(U.nightGlow.mul(0.4)));
  const offset = float(frameId).mod(8).mul(5.588238).mul(U.ditherAnimate);
  m.maskNode = interleavedGradientNoise(screenCoordinate.xy.add(offset)).lessThan(opacity);
  m.flatShading = true;
  material = m;
  return m;
}

const tmp = new THREE.Color();
/** sRGB -> linear on a 0..1 value (the car material decodes its vertex colours once more, materials.ts). */
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/**
 * A hex colour as the ghost material wants it: decoded sRGB -> linear twice, like every vertex colour in the look
 * (the original decoded its vertex colours twice; materials.ts keeps that, and the car's paint follows it). Decoded
 * once, the ghosts came out pale and whitish over bright gravel, the best ghost's blue faint.
 */
const toLinear = (hex: string) => {
  const c = new THREE.Color().set(hex); // three's Color.set decodes sRGB hex to linear (once)
  return c.setRGB(decode(c.r), decode(c.g), decode(c.b));
};


/** A car's geometry merged into one, rest pose, in the car's own space (metres; +X forward). Cached per car. */
const carGeo = new Map<string, Promise<{ geo: THREE.BufferGeometry; slots: string[]; ranges: number[] }>>();

function mergedCar(car: CarData): Promise<{ geo: THREE.BufferGeometry; slots: string[]; ranges: number[] }> {
  let p = carGeo.get(car.id);
  if (!p) {
    p = loadCarModel(car).then((model) => {
      model.root.updateMatrixWorld(true);
      const parts: THREE.BufferGeometry[] = [];
      const slots: string[] = [];
      model.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = new THREE.BufferGeometry();
        const src = mesh.geometry;
        // float positions (a quantized GLB attribute can't take the node transform in place)
        const pos = src.getAttribute('position');
        const n = pos.count;
        const xyz = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          xyz[i * 3] = pos.getX(i);
          xyz[i * 3 + 1] = pos.getY(i);
          xyz[i * 3 + 2] = pos.getZ(i);
        }
        g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
        const col = src.getAttribute('color');
        const rgb = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          rgb[i * 3] = col ? col.getX(i) : 1;
          rgb[i * 3 + 1] = col ? col.getY(i) : 1;
          rgb[i * 3 + 2] = col ? col.getZ(i) : 1;
        }
        g.setAttribute('vcolor', new THREE.BufferAttribute(rgb, 3));
        if (src.index) g.setIndex(src.index.clone());
        g.applyMatrix4(mesh.matrixWorld);
        parts.push(g.index ? g.toNonIndexed() : g);
        slots.push((mesh.material as THREE.Material).name);
        (mesh.material as THREE.Material).dispose();
      });
      const ranges = parts.map((g) => g.getAttribute('position').count);
      const geo = mergeGeometries(parts, false)!;
      for (const g of parts) g.dispose();
      return { geo, slots, ranges };
    });
    carGeo.set(car.id, p);
  }
  return p;
}

/** A ghost car mesh with its own colours (shares the car's positions). Hidden until placed. */
export async function ghostMesh(car: CarData, colours: GhostColours): Promise<THREE.Mesh> {
  const { geo, slots, ranges } = await mergedCar(car);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.getAttribute('position'));
  const v = geo.getAttribute('vcolor');
  const out = new Float32Array(v.count * 3);
  const paint: Record<string, THREE.Color> = {};
  let trim = new THREE.Color(1, 1, 1);
  if (colours.kind === 'solid') trim = toLinear(colours.color);
  else {
    const tint = toLinear(colours.tint);
    const L = colours.livery;
    const lv: Record<string, string> = { Paint1: L.paint1, Paint2: L.paint2, Paint3: L.paint3, Rim: L.rim };
    for (const s of PAINT_SLOTS) paint[s] = toLinear(lv[s]).lerp(tint, colours.tintMix);
    trim = toLinear(colours.trim).lerp(tint, colours.tintMix);
  }
  let k = 0;
  slots.forEach((slot, si) => {
    const p = paint[slot];
    for (let i = 0; i < ranges[si]; i++, k++) {
      if (colours.kind === 'solid') tmp.copy(trim);
      else if (p) tmp.setRGB(decode(v.getX(k)), decode(v.getY(k)), decode(v.getZ(k))).multiply(p); // paint vertices are white
      else tmp.copy(trim);
      out[k * 3] = tmp.r;
      out[k * 3 + 1] = tmp.g;
      out[k * 3 + 2] = tmp.b;
    }
  });
  g.setAttribute('gcolor', new THREE.BufferAttribute(out, 3));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, ghostMaterial());
  mesh.name = `ghost_${car.id}`;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.visible = false;
  mesh.userData.ghostOpacity = 0;
  mesh.userData.ghostGlow = 0;
  return mesh;
}
