// The stage and car materials (handoff §8), ported from the original's material graph: untextured,
// vertex colour, flat-shaded, graded per surface and condition through the shared uniforms (U).
//
//   Flat     props, trunks, buildings: per-instance hue / value shift, roughness 0.85
//   Foliage  two-sided, sway in the vertex shader (weight = sway attribute², off beyond 90 m),
//            canopy normals from the file, occluder fade toward the car
//   Ground   terrain slots: per-slot roughness and grade
//   Water    shore colour by depth over 4.5 m, opacity 0.55 -> 0.96
//   Glow     windows and lamps: dark glass by day, lit by NightGlow
//
// Instances share one material per slot: an InstancedBufferGeometry with inst_a = (x, y, z, scale)
// and inst_b = (rotY, fade, hue shift deg, value delta) placed by positionNode (see stage.ts).
// Fades are alpha-tested against interleaved gradient noise (never blended) and skipped in the
// shadow pass, as in the original.
import * as THREE from 'three/webgpu';
import {
  Fn, abs, attribute, bool, cameraFar, cameraNear, cameraViewMatrix, cos, dot, float, fract, frameId,
  interleavedGradientNoise, sign, length, materialColor, max, min, mix, normalLocal, perspectiveDepthToViewZ, positionLocal, positionView,
  positionWorld, pow, saturate, screenCoordinate, sin, smoothstep, step, time, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl';
import { U, type Tinted } from './uniforms';

type N = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** Dev bisecting (?lookoff=hsv,occ,sway,normal,water,canopy): turn shader features off to measure them. */
const OFF = new Set((typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('lookoff') ?? '').split(','));

// ---------------------------------------------------------------- colour
const LUMA = vec3(0.2126, 0.7152, 0.0722);

export const srgbToLinear = (c: V3): V3 =>
  mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(0.04045, c)) as V3;

/** Per-instance hue (deg) and value (×(1+d)) shift on the vertex value, then decoded like the original. */
const hsvShift = Fn(([raw, hueDeg, val]: [V3, N, N]) => {
  const c = saturate(raw);
  const K = vec4(0, -1 / 3, 2 / 3, -1);
  const p = mix(vec4(c.b, c.g, K.w, K.z), vec4(c.g, c.b, K.x, K.y), step(c.b, c.g));
  const q = mix(vec4(p.x, p.y, p.w, c.r), vec4(c.r, p.y, p.z, p.x), step(p.x, c.r));
  const d = q.x.sub(min(q.w, q.y));
  const e = float(1e-10);
  const h = fract(abs(q.z.add(q.w.sub(q.y).div(d.mul(6).add(e)))).add(hueDeg.div(360)));
  const s = d.div(q.x.add(e));
  const v = saturate(q.x.mul(val.add(1)));
  const rgb = saturate(abs(fract(vec3(h).add(vec3(1, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1));
  return srgbToLinear(mix(vec3(1), rgb, s).mul(v));
});

/** Per-condition surface grade: rgb × tint.rgb, saturation tint.a (linear). */
export const grade = (c: V3, t: V4): V3 => max(mix(vec3(dot(c, LUMA)), c, t.w).mul(t.xyz), 0) as V3;

/**
 * The vertex colour as the original showed it. The GLB holds the palette already linear (Blender
 * decodes its sRGB byte colours on export), and the original's materials decoded the value they read
 * once more; measured on its screenshots, the lit result matches albedo^2.2 for road, dirt and grass
 * alike. That second decode is a large part of its saturated, darker look, so it is kept here
 * (with the exposure calibrated to match), not "fixed".
 */
const vertexRaw = () => attribute('color', 'vec3') as unknown as V3;
// decoded per vertex (it depends only on vertex data): a pow per pixel cost ~1 ms at 3840×1600
const vertexRgb = () => srgbToLinear(saturate(vertexRaw())).toVarying() as unknown as V3;

// ---------------------------------------------------------------- instances
const instA = () => attribute('inst_a', 'vec4') as unknown as V4;
const instB = () => attribute('inst_b', 'vec4') as unknown as V4;
const rotY = (v: V3, a: N): V3 => {
  const c = cos(a), s = sin(a);
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
};
const placed = (local: V3 = positionLocal as unknown as V3): V3 => rotY(local.mul(instA().w), instB().x).add(instA().xyz) as V3;

/** Wind sway (UE SwayAmplitude 14 cm, frequency 1.7): phases from the instance and vertex positions. */
const sway = (p: V3): V3 => {
  const a = attribute('sway', 'float') as unknown as N;
  const ip = instA().xyz;
  const obj = fract(vec2(ip.x, ip.z).div(37));
  const pos = fract(vec2(p.x, p.z).div(23));
  const ph = dot(obj, vec2(6.2831, 4.1));
  const ph2 = dot(pos, vec2(6.2831, 6.2831));
  const t = time.mul(1.7);
  const s1 = sin(t.add(ph).add(ph2.mul(0.35)));
  const s2 = sin(t.mul(2.3).add(ph.mul(1.7)).add(ph2));
  // the main camera, not cameraPosition: shadow passes must sway the same way
  const near = step(length(ip.sub(U.camPos)), U.swayRange);
  const w = a.mul(a).mul(0.14).mul(U.wind).mul(near);
  return vec3(s1.mul(0.85).add(s2.mul(0.25)), 0, s2.mul(0.55).sub(s1.mul(0.2))).mul(w) as V3;
};

/** Dither: keep the pixel where the noise is below the visibility (alpha test, never blend). */
const dithered = (vis: N) => {
  const offset = float(frameId).mod(8).mul(5.588238).mul(U.ditherAnimate);
  return interleavedGradientNoise(screenCoordinate.xy.add(offset)).lessThan(vis);
};

/**
 * Occluder fade: how much a pixel lies inside the capsule from the camera to the car (0..strength).
 * t = P·D/|D|², Q = P − D·sat(t), r = radius·lerp(nearScale, 1, t), inside = 1 − smoothstep(0.55r, r, |Q|)
 * between t 0.02 and endT.
 */
export const occluder = (radius: number, strength: N | number, nearScale = 1.6, endT = 0.93): N => {
  const P = positionWorld.sub(U.camPos);
  const D = U.carPos.sub(U.camPos);
  const t = dot(P, D).div(max(dot(D, D), 1e-4));
  const tc = saturate(t);
  const Q = P.sub(D.mul(tc));
  const r = float(radius).mul(mix(float(nearScale), float(1), tc));
  const inside = float(1).sub(smoothstep(r.mul(0.55), r, length(Q))).mul(step(0.02, t)).mul(step(t, endT));
  return inside.mul(strength) as N;
};

// ---------------------------------------------------------------- builders
type Props = ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0];
const standard = (name: string, props: Props) => {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, ...props });
  m.name = name;
  return m;
};

/** Windows and lamps: dark glass by day, the vertex colour lit ×8 at night. */
function glow(name: string, colour: V3) {
  const m = standard(name, { roughness: 0.2, flatShading: true });
  m.colorNode = mix(vec3(0.025, 0.032, 0.04), colour.mul(0.25), U.nightGlow);
  m.emissiveNode = colour.mul(8).mul(U.nightGlow);
  return m;
}

/** Instanced props and vegetation (one material per slot for every chunk of the stage). */
export function instanceMaterials(): Record<string, THREE.Material> {
  const shifted = () => OFF.has('hsv') ? vertexRgb() : (hsvShift(vertexRaw(), instB().z, instB().w) as unknown as V3).toVarying() as unknown as V3; // per vertex
  const fade = () => instB().y as unknown as N;

  const flat = standard('Flat', { roughness: 0.85, flatShading: true });
  flat.positionNode = placed();
  flat.colorNode = grade(shifted(), U.tint.Flat);
  flat.maskNode = dithered(fade());
  flat.maskShadowNode = bool(true);

  const foliage = standard('Foliage', { roughness: 0.9, side: THREE.DoubleSide });
  const p = placed();
  foliage.positionNode = OFF.has('sway') ? p : p.add(sway(p));
  // shadow passes skip the sway: a 14 cm tip movement is invisible in a shadow from the chase camera,
  // and the vertex work runs once per cascade over every tree
  foliage.castShadowPositionNode = p;
  foliage.colorNode = grade(shifted(), U.tint.Foliage);
  // normals from the file, turned with the instance, then turned toward the viewer: canopy blobs carry
  // outward sphere normals, but spruce and pine chips are flat with half their normals pointing down,
  // which from the high camera left the conifers black. A two-sided material shows each chip's lit side.
  const nWorld = rotY(normalLocal as unknown as V3, instB().x);
  // (decided per vertex: a chip is flat, and per pixel this cost 2.4 ms on an integrated GPU)
  const nView = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz;
  const facing = nView.mul(sign(dot(nView, positionView.negate()).add(1e-4)));
  if (!OFF.has('normal')) foliage.normalNode = facing.toVarying('v_foliageNormal').normalize();
  foliage.maskNode = OFF.has('occ') ? dithered(fade()) : dithered(float(1).sub(occluder(5.2, 0.85)).mul(fade()));
  foliage.maskShadowNode = bool(true);
  // canopies (more than 1.5 m above the instance base) take only part of their shadow: thin chips
  // shadow each other and the original's GI lit canopy interiors; ground cover keeps full shadows
  const height = positionLocal.y.mul(instA().w).toVarying('v_foliageHeight');
  const canopy = smoothstep(1.0, 2.0, height);
  if (!OFF.has('canopy')) foliage.receivedShadowNode = Fn(([shadow]: [V3]) => mix(shadow, vec3(1), canopy.mul(U.canopyLight))) as unknown as () => THREE.Node;

  const g = glow('Glow', vertexRgb());
  g.positionNode = placed();
  g.maskNode = dithered(fade());
  g.maskShadowNode = bool(true);
  return { Flat: flat, Foliage: foliage, Glow: g };
}

/** Single placed props (the start and finish arches). */
export function propMaterials(): Record<string, THREE.Material> {
  const flat = standard('Flat', { roughness: 0.85, flatShading: true });
  flat.colorNode = grade(vertexRgb(), U.tint.Flat);
  const foliage = standard('Foliage', { roughness: 0.9, side: THREE.DoubleSide });
  foliage.colorNode = grade(vertexRgb(), U.tint.Foliage);
  return { Flat: flat, Foliage: foliage, Glow: glow('Glow', vertexRgb()) };
}

/** Terrain slots: roughness per slot (the original's ground instances) and the condition's grade. */
const GROUND: Record<string, [number, Tinted | null]> = {
  Grass: [0.95, 'Grass'], Gravel: [0.9, 'Gravel'], Tarmac: [0.75, 'Tarmac'], Line: [0.7, null],
  Dirt: [0.95, 'Dirt'], Rock: [0.9, 'Rock'], Snow: [0.7, null], Flat: [0.85, 'Flat'],
};

export function terrainMaterials(): Record<string, THREE.Material> {
  const out: Record<string, THREE.Material> = {};
  for (const [slot, [roughness, tint]] of Object.entries(GROUND)) {
    const m = standard(slot, { roughness, flatShading: true });
    m.colorNode = tint ? grade(vertexRgb(), U.tint[tint]) : vertexRgb();
    out[slot] = m;
  }
  out.Water = OFF.has('water') ? standard('Water', { roughness: 0.18, transparent: true, opacity: 0.8 }) : water();
  return out;
}

/** Lakes: graded vertex colour in deep water, shore colour where it is shallow (scene depth over 4.5 m). */
function water() {
  const m = standard('Water', { roughness: 0.18, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
  const depth = saturate(positionView.z.sub(sceneZ).div(4.5));
  m.colorNode = mix(vec3(0.45, 0.72, 0.75), grade(vertexRgb(), U.tint.Water), depth);
  m.opacityNode = mix(float(0.55), float(0.96), depth);
  return m;
}

// ---------------------------------------------------------------- cars
/** slot -> roughness, metalness, emissive by day, emissive at night (× NightGlow). */
const CAR: Record<string, [number, number, number, number]> = {
  Paint1: [0.32, 0, 0, 0], Paint2: [0.32, 0, 0, 0], Paint3: [0.32, 0, 0, 0], Glass: [0.08, 0, 0, 0],
  Trim: [0.75, 0, 0, 0], Chrome: [0.22, 1, 0, 0], LightFront: [0.2, 0, 0.15, 25], LightRear: [0.3, 0, 0.05, 12],
  Tyre: [0.92, 0, 0, 0], Rim: [0.4, 0.35, 0, 0],
};

/** A car slot: vertex colour × the material colour (the livery on white Paint/Rim vertices). */
export function carMaterial(slot: string): THREE.MeshStandardNodeMaterial {
  const [roughness, metalness, day, night] = CAR[slot] ?? [0.6, 0, 0, 0];
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness });
  m.name = slot;
  m.colorNode = vertexRgb().mul(materialColor.rgb);
  if (day || night) m.emissiveNode = vertexRgb().mul(U.nightGlow.mul(night).add(day));
  return m;
}
