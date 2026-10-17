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
// Weather (slice 8, the original's RallyWeather material functions): in rain the ground darkens and gets
// glossier (roads x0.5, ground x0.78); in snow faces turn white by how much they face up (normal y 0.5 -> 0.78
// with a 3 m noise on the edge), roads take a packed-snow colour and lakes freeze. Only built when the
// stage loads in rain or snow (`materialWeather`), so clear weather pays nothing for it.
//
// Instances share one material per slot: an InstancedBufferGeometry with inst_a = (x, y, z, scale)
// and inst_b = (rotY, fade, hue shift deg, value delta) placed by positionNode (see stage.ts).
// Fades are alpha-tested against interleaved gradient noise (never blended) and skipped in the
// shadow pass, as in the original.
import * as THREE from 'three/webgpu';
import {
  Fn, abs, attribute, bool, cameraFar, cameraNear, cameraViewMatrix, cos, dot, float, floor, fract, frameId,
  interleavedGradientNoise, sign, length, materialColor, max, min, mix, normalLocal, normalWorldGeometry, perspectiveDepthToViewZ, positionLocal, positionView,
  positionWorld, pow, saturate, screenCoordinate, sin, smoothstep, step, time, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl';
import { U, type Tinted } from './uniforms';

type N = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/**
 * The weather the materials are built for (main.ts sets it before the stage and the car load). Clear
 * builds no weather code; rain and snow read the shared uniforms (U.wet, U.snow, ...) the look sets.
 */
export const materialWeather: { kind: 'clear' | 'rain' | 'snow' } = { kind: 'clear' };
const weatherOn = () => materialWeather.kind !== 'clear';

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

/**
 * A grazing animal (UE AStageActor::UpdateIdlers): a slow nod, head down and back up (pitch about the mesh origin,
 * graze = max(0, sin(phase))), a little side-to-side yaw and a breathing bob; phase and rate from the instance
 * position (the original drew them from its random stream). Local space: x forward, y up, z right.
 */
const grazed = (local: V3): V3 => {
  const ip = instA().xyz;
  const h = fract(sin(dot(vec2(ip.x, ip.z), vec2(12.9898, 78.233))).mul(43758.5453));
  const hz = mix(U.idle.z, U.idle.w, fract(h.mul(7.13)));
  const ph = time.mul(hz).mul(6.2831853).add(h.mul(6.2831853));
  const graze = max(sin(ph), 0);
  const pitch = U.idle.x.mul(graze).negate(); // nose down
  const yaw = U.idle.x.mul(0.4).mul(sin(ph.mul(0.5)));
  const cp = cos(pitch), sp = sin(pitch);
  // pitch about z (x toward -y for a negative angle), then the small yaw about y
  const v = vec3(local.x.mul(cp).sub(local.y.mul(sp)), local.x.mul(sp).add(local.y.mul(cp)), local.z);
  return rotY(v as unknown as V3, yaw).add(vec3(0, U.idle.y.mul(sin(ph.mul(2))).div(instA().w), 0)) as V3;
};

/** Dither: keep the pixel where the noise is in [lo, hi) (alpha test, never blend). */
const dithered = (hi: N, lo?: N) => {
  const offset = float(frameId).mod(8).mul(5.588238).mul(U.ditherAnimate);
  const n = interleavedGradientNoise(screenCoordinate.xy.add(offset));
  return lo ? n.lessThan(hi).and(n.greaterThanEqual(lo)) : n.lessThan(hi);
};

/**
 * The per-instance fade band (stage.ts fadeBand): 2·round(lo·1023) + hi, so a plain fade f is [0, f)
 * and two levels of detail cross-fade by splitting the noise range between them. Decoded per vertex.
 */
const fadeBand = (): [N, N] => {
  const v = instB().y;
  const q = v.mul(0.5).floor();
  return [v.sub(q.mul(2)).toVarying('v_fadeHi') as unknown as N, q.div(1023).toVarying('v_fadeLo') as unknown as N];
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

// ---------------------------------------------------------------- weather (slice 8)

const hash2 = (c: V2): N => fract(sin(dot(c, vec2(127.1, 311.7))).mul(43758.5453)) as N;

/** Value noise in 3 m cells of the world's ground plane, as the original's material (Pn = frac(p / 60 m) x 20). */
function noise3m(p: V3): N {
  const pn = fract(vec2(p.x, p.z).div(60)).mul(20);
  const cell = floor(pn);
  const f = fract(pn);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash2(cell), b = hash2(cell.add(vec2(1, 0))), c = hash2(cell.add(vec2(0, 1))), d = hash2(cell.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) as N;
}

/** Weather kinds of the original: 0 terrain (grass, rock), 1 road, 2 flat props, 3 foliage. */
type WeatherKind = 0 | 1 | 2 | 3;

/**
 * Snow cover and wet darkening on a graded colour, and the roughness to match (WEATHER_COLOUR_HLSL and
 * WEATHER_ROUGH_HLSL). `up` = the world normal's up component, `p` = the world position.
 */
function weatherSurface(C: V3, R: N, kind: WeatherKind, up: N, p: V3): { colour: V3; rough: N } {
  const SP = U.snowParams, SR = U.snowRoadColor, WP = U.wetParams;
  const nz = noise3m(p);
  const lo = SP.x.add(nz.sub(0.5).mul(SP.z));
  const upCover = saturate(up.sub(lo).div(max(SP.y.sub(SP.x), 0.01)));
  const cover0 = kind === 1 ? SR.w.mul(nz.mul(0.08).add(0.92)) : kind === 3 ? upCover.mul(SP.w) : upCover;
  const cover = saturate(cover0.mul(U.snow));
  const dark = kind === 1 ? WP.x : kind === 0 ? WP.y : float(0.85);
  const wet = saturate(U.wet);
  const c = C.mul(mix(float(1), dark, wet));
  const base = kind === 1 ? SR.xyz.mul(nz.mul(0.12).add(0.94)) : U.snowColor.mul(nz.mul(0.06).add(0.97));
  // drifts on steeper faces take a slightly darker, bluer white; flat open snow is the brightest
  const flat01 = saturate(up.sub(0.62).div(0.33));
  const snowc = base.mul(mix(vec3(0.8, 0.85, 0.95), vec3(1), flat01)).mul(nz.mul(0.05).add(0.95));
  const wr = kind === 1 ? WP.z : kind === 0 ? WP.w : float(kind === 2 ? 0.4 : 0.5);
  const r = mix(R, min(R, wr), wet);
  return { colour: mix(c, snowc, cover) as V3, rough: mix(r, float(0.8), cover) as N };
}

/** Apply the weather to a material whose colour is `colour` and roughness `rough` (flat shading: the face normal). */
function withWeather(m: THREE.NodeMaterial, colour: V3, rough: number, kind: WeatherKind): void {
  if (!weatherOn()) return;
  const w = weatherSurface(colour, float(rough), kind, normalWorldGeometry.y as unknown as N, positionWorld as unknown as V3);
  m.colorNode = w.colour;
  (m as THREE.MeshStandardNodeMaterial).roughnessNode = w.rough;
}

/**
 * Frozen lakes in snow (ICE_COLOUR_HLSL): pale cyan ice with lighter cracks (Voronoi cell edges, 3.5 m
 * cells), darker clear ice and snow-dusted patches; returns the colour, opacity and roughness blends.
 */
function iceLayer(C: V3, op: N, R: N): { colour: V3; opacity: N; rough: N } {
  const p = positionWorld;
  const pn = fract(vec2(p.x, p.z).div(70)).mul(20);
  const g = floor(pn), fp = fract(pn);
  let d1: N = float(8), d2: N = float(8);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const o = vec2(i, j);
      const go = g.add(o);
      const h = fract(sin(vec2(dot(go, vec2(127.1, 311.7)), dot(go, vec2(269.5, 183.3)))).mul(43758.5453));
      const dd = length(o.add(h).sub(fp)) as N;
      // keep the two nearest distances (branch-free)
      d2 = min(d2, max(d1, dd)) as N;
      d1 = min(d1, dd) as N;
    }
  }
  const crack = float(1).sub(smoothstep(0.015, 0.06, d2.sub(d1)));
  const q = pn.mul(0.23);
  const c0 = floor(q), f0 = fract(q), u0 = f0.mul(f0).mul(f0.mul(-2).add(3));
  const h = (c: V2) => fract(sin(dot(c, vec2(12.9898, 78.233))).mul(43758.5453));
  const patchy = mix(mix(h(c0), h(c0.add(vec2(1, 0))), u0.x), mix(h(c0.add(vec2(0, 1))), h(c0.add(vec2(1, 1))), u0.x), u0.y);
  const F = saturate(U.snow);
  let ice = vec3(0.56, 0.74, 0.82).mul(mix(float(0.82), float(1.06), patchy)) as V3;
  ice = mix(ice, vec3(0.3, 0.47, 0.58), smoothstep(0.62, 0.8, patchy).mul(0.55)) as V3;
  ice = mix(ice, vec3(0.74, 0.8, 0.88), smoothstep(0.32, 0.12, patchy).mul(0.75)) as V3;
  ice = mix(ice, vec3(0.86, 0.93, 0.97), crack.mul(0.85)) as V3;
  return { colour: mix(C, ice, F) as V3, opacity: mix(op, float(1), F) as N, rough: mix(R, mix(float(0.22), float(0.5), crack), F) as N };
}

// ---------------------------------------------------------------- builders
type Props = ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0];
const foliageMaterial = (name: string): THREE.MeshStandardNodeMaterial => standard(name, { roughness: 0.9, side: THREE.DoubleSide });

/**
 * A diffuse-only copy of a foliage material (low quality): the physical lighting model cost an
 * integrated GPU ~3 ms on canopies at 3840×1600. Without the faint specular of a 0.9-rough surface
 * conifers read a little brighter and more saturated.
 */
function lambertCopy(m: THREE.NodeMaterial): THREE.NodeMaterial {
  const l = new THREE.MeshLambertNodeMaterial({ side: m.side });
  for (const k of ['positionNode', 'castShadowPositionNode', 'colorNode', 'normalNode', 'maskNode', 'maskShadowNode', 'receivedShadowNode', 'roughnessNode'] as const) {
    (l as unknown as Record<string, unknown>)[k] = (m as unknown as Record<string, unknown>)[k];
  }
  l.name = `${m.name}Lambert`;
  return l;
}
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

  const flat = standard('Flat', { roughness: 0.85, flatShading: true });
  flat.positionNode = placed();
  flat.colorNode = grade(shifted(), U.tint.Flat);
  withWeather(flat, flat.colorNode as V3, 0.85, 2);
  flat.maskNode = dithered(...fadeBand());
  flat.maskShadowNode = bool(true);

  const foliage = foliageMaterial('Foliage');
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
  if (weatherOn()) {
    // canopy tops (the file's normals, as the original's vertex normal): per vertex, foliage is the most numerous
    // geometry and its chips are small
    const w = weatherSurface(foliage.colorNode as V3, float(0.9), 3, nWorld.y as unknown as N, positionWorld as unknown as V3);
    foliage.colorNode = w.colour.toVarying('v_weatherColour') as unknown as V3;
    foliage.roughnessNode = w.rough.toVarying('v_weatherRough') as unknown as N;
  }
  // (decided per vertex: a chip is flat, and per pixel this cost 2.4 ms on an integrated GPU)
  const nView = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz;
  const facing = nView.mul(sign(dot(nView, positionView.negate()).add(1e-4)));
  if (!OFF.has('normal')) foliage.normalNode = facing.toVarying('v_foliageNormal').normalize();
  const [hi, lo] = fadeBand();
  foliage.maskNode = OFF.has('occ') ? dithered(hi, lo) : dithered(float(1).sub(occluder(5.2, 0.85)).mul(hi), lo);
  foliage.maskShadowNode = bool(true);
  // canopies (more than 1.5 m above the instance base) take only part of their shadow: thin chips
  // shadow each other and the original's GI lit canopy interiors; ground cover keeps full shadows
  const height = positionLocal.y.mul(instA().w).toVarying('v_foliageHeight');
  const canopy = smoothstep(1.0, 2.0, height);
  if (!OFF.has('canopy')) foliage.receivedShadowNode = Fn(([shadow]: [V3]) => mix(shadow, vec3(1), canopy.mul(U.canopyLight))) as unknown as () => THREE.Node;

  const g = glow('Glow', vertexRgb());
  g.positionNode = placed();
  g.maskNode = dithered(...fadeBand());
  g.maskShadowNode = bool(true);
  // far vegetation levels (stage.ts, beyond 90 m): no sway (it is off there anyway) and no see-through
  // test, which saves vertex and pixel work on the most numerous triangles
  const far = foliageMaterial('FoliageFar');
  far.positionNode = p;
  far.castShadowPositionNode = p;
  far.colorNode = foliage.colorNode;
  if (foliage.roughnessNode) far.roughnessNode = foliage.roughnessNode;
  if (foliage.normalNode) far.normalNode = foliage.normalNode;
  far.maskNode = dithered(hi, lo);
  far.maskShadowNode = bool(true);
  far.receivedShadowNode = foliage.receivedShadowNode;
  if (OFF.has('lit')) foliage.lights = far.lights = false;
  if (OFF.has('mask')) flat.maskNode = foliage.maskNode = g.maskNode = far.maskNode = null;
  // fade meshes (the covered bridge): Flat with the see-through toward the car, radius 8 m
  const flatFade = standard('FlatFade', { roughness: 0.85, flatShading: true });
  flatFade.positionNode = placed();
  flatFade.colorNode = flat.colorNode;
  if (flat.roughnessNode) flatFade.roughnessNode = flat.roughnessNode;
  flatFade.maskNode = OFF.has('occ') ? flat.maskNode : dithered(float(1).sub(occluder(8, 0.85)).mul(fadeBand()[0]), fadeBand()[1]);
  flatFade.maskShadowNode = bool(true);
  // grazing animals (features.idle): Flat with the nod and bob (shadows follow)
  const flatIdle = standard('FlatIdle', { roughness: 0.85, flatShading: true });
  flatIdle.positionNode = placed(grazed(positionLocal as unknown as V3));
  flatIdle.colorNode = flat.colorNode;
  if (flat.roughnessNode) flatIdle.roughnessNode = flat.roughnessNode;
  flatIdle.maskNode = flat.maskNode;
  flatIdle.maskShadowNode = bool(true);
  const out: Record<string, THREE.Material> = {
    Flat: flat, FlatFade: flatFade, FlatIdle: flatIdle, Foliage: foliage, FoliageFar: far, Glow: g,
    // diffuse-only foliage for low quality (stage.ts setLod swaps them in)
    FoliageL: lambertCopy(foliage), FoliageFarL: lambertCopy(far),
  };
  // solid twins: the same materials without the dither test, for instances that are fully in view and
  // away from the car (stage.ts picks per instance). A shader that can discard loses the GPU's early
  // depth test for the whole draw; dropping every discard saved 2.5-4.5 ms on canopies on an
  // integrated GPU at 3840×1600.
  for (const [k, m] of Object.entries(out)) {
    const t = (m as THREE.NodeMaterial).clone() as THREE.NodeMaterial;
    t.maskNode = null;
    t.name = `${m.name}Solid`;
    out[`${k}!`] = t;
  }
  return out;
}

/** Single placed props (the start and finish arches). */
export function propMaterials(): Record<string, THREE.Material> {
  const flat = standard('Flat', { roughness: 0.85, flatShading: true });
  flat.colorNode = grade(vertexRgb(), U.tint.Flat);
  withWeather(flat, flat.colorNode as V3, 0.85, 2);
  const foliage = standard('Foliage', { roughness: 0.9, side: THREE.DoubleSide });
  foliage.colorNode = grade(vertexRgb(), U.tint.Foliage);
  if (weatherOn()) {
    const w = weatherSurface(foliage.colorNode as V3, float(0.9), 3, normalWorldGeometry.y as unknown as N, positionWorld as unknown as V3);
    foliage.colorNode = w.colour;
    foliage.roughnessNode = w.rough;
  }
  return { Flat: flat, Foliage: foliage, Glow: glow('Glow', vertexRgb()) };
}

/** Terrain slots: roughness per slot (the original's ground instances) and the condition's grade. */
const GROUND: Record<string, [number, Tinted | null]> = {
  Grass: [0.95, 'Grass'], Gravel: [0.9, 'Gravel'], Tarmac: [0.75, 'Tarmac'], Line: [0.7, null],
  Dirt: [0.95, 'Dirt'], Rock: [0.9, 'Rock'], Snow: [0.7, null], Flat: [0.85, 'Flat'],
};

/**
 * Terrain options per stage: `rockFade` gives the Rock slot the canyon see-through (arizona: the walls
 * dither out between the camera and the car while U.rockFade is up, radius 4.5 m); `water` is the stage's
 * water look (stage_runtime.json features.water.<stage>: ShoreColor "#hex", ShoreFadeCm, ShoreOpacity,
 * DeepOpacity, Tint [r, g, b] linear).
 */
export interface TerrainOptions {
  rockFade?: boolean;
  water?: Record<string, string | number | number[]>;
}

export function terrainMaterials(opts: TerrainOptions = {}): Record<string, THREE.Material> {
  const out: Record<string, THREE.Material> = {};
  for (const [slot, [roughness, tint]] of Object.entries(GROUND)) {
    const m = standard(slot, { roughness, flatShading: true });
    m.colorNode = tint ? grade(vertexRgb(), U.tint[tint]) : vertexRgb();
    // the original's weather kind from the slot: grass and rock are terrain, the road surfaces road, Flat a prop
    withWeather(m, m.colorNode as V3, roughness, slot === 'Grass' || slot === 'Rock' || slot === 'Snow' ? 0 : slot === 'Flat' ? 2 : 1);
    if (slot === 'Rock' && opts.rockFade && !OFF.has('occ')) {
      m.maskNode = dithered(float(1).sub(occluder(4.5, U.rockFade)));
      m.maskShadowNode = bool(true);
    }
    out[slot] = m;
  }
  out.Water = OFF.has('water') ? standard('Water', { roughness: 0.18, transparent: true, opacity: 0.8 }) : water(opts.water);
  return out;
}

/** Lakes and streams: graded vertex colour × Tint in deep water, the shore colour where it is shallow (scene depth over ShoreFadeCm). */
function water(p: TerrainOptions['water'] = {}) {
  const m = standard('Water', { roughness: 0.18, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const shoreHex = typeof p.ShoreColor === 'string' ? p.ShoreColor : null;
  const shore = shoreHex ? new THREE.Color(shoreHex) : new THREE.Color(0.45, 0.72, 0.75);
  const t = Array.isArray(p.Tint) ? (p.Tint as number[]) : [1, 1, 1];
  const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
  const depth = saturate(positionView.z.sub(sceneZ).div(num('ShoreFadeCm', 450) / 100));
  m.colorNode = mix(vec3(shore.r, shore.g, shore.b), grade(vertexRgb(), U.tint.Water).mul(vec3(t[0], t[1], t[2])), depth);
  m.opacityNode = mix(float(num('ShoreOpacity', 0.55)), float(num('DeepOpacity', 0.96)), depth);
  if (materialWeather.kind === 'snow') {
    // lakes (and fords) freeze over in snow
    const ice = iceLayer(m.colorNode as V3, m.opacityNode as N, float(0.18));
    m.colorNode = ice.colour;
    m.opacityNode = ice.opacity;
    m.roughnessNode = ice.rough;
  }
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
  if (materialWeather.kind === 'rain' && slot !== 'Tyre') {
    // wet sheen (CAR_WET_HLSL): a glossier body, and droplet glints in 3.5 cm cells of the car's own space
    const w = saturate(U.wet);
    const cell = floor(positionLocal.div(0.035));
    const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const drop = step(0.9, h).mul(w);
    m.roughnessNode = mix(mix(float(roughness), float(roughness * 0.35), w), float(0.03), drop);
  }
  return m;
}
