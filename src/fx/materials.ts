// Effect materials, ported from the original's FX materials (make_fx_materials.py):
//
//   dust   soft translucent puffs: opacity sat(a·1.8·smoothstep(N·V)^2.4), fine round dots in the outer
//          band (cells fixed to the puff) that fade in between 16 and 26 m from the camera, and a 0.6 m
//          soft depth fade where a puff meets the ground. Lit without direction (a flat light level
//          from the sun and sky, like the original's volumetric non-directional translucency) plus its
//          fill emissive.
//   solid  chips and flecks: lit, flat-shaded, two-sided, faded by a dither (alpha test, never blended).
//   glow   flames and sparks: emissive (20-40, so bloom picks them up), dithered fade.
//   skid   skid-mark quads: lit, blended, aged in the shader (hold, then fade).
//   crowd  spectators: the stage's flat material with the per-instance tint on white vertices.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, bool, cameraFar, cameraNear, cameraPosition, cos, cross, dot, float, floor, fract, frameId, fwidth,
  interleavedGradientNoise, length, max, min, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionLocal, positionView,
  positionWorld, pow, saturate, screenCoordinate, sin, smoothstep, step, uniform, vec3, viewportDepthTexture,
} from 'three/tsl';
import { U } from '../look/uniforms';
import { grade, srgbToLinear } from '../look/materials';

type N = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** Shared effect uniforms (set every frame by Fx). */
export const fxU = {
  /** Light on the non-directional dust (linear rgb): from the sun and the sky of the condition. */
  light: uniform(new THREE.Color(1, 1, 1)),
  /** Game time (s) for the skid-mark age. */
  now: uniform(0),
  holdS: uniform(25),
  fadeS: uniform(12),
  /** Stipple (dots) strength and its fade-in distances (m from the camera). */
  stipple: uniform(1),
  stippleNear: uniform(16),
  stippleFar: uniform(26),
  /** Soft depth fade distance (m). */
  depthFade: uniform(0.6),
};

const fxA = () => attribute('fx_a', 'vec4') as unknown as V4;
const fxQ = () => attribute('fx_q', 'vec4') as unknown as V4;
const fxC = () => attribute('fx_c', 'vec4') as unknown as V4;
const fxE = () => attribute('fx_e', 'vec4') as unknown as V4;

/** Rotate v by the unit quaternion q. */
const qrot = (v: V3, q: V4): V3 => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2)) as V3;

/** Particle placement: local (radius 0.5) × size (× stretch along x), rotated, moved. */
const placed = (): V3 => {
  const a = fxA(), e = fxE();
  return qrot((positionLocal as unknown as V3).mul(vec3(a.w.mul(e.y), a.w, a.w)), fxQ()).add(a.xyz) as V3;
};

/** The original's emissive term: E + Fill·(1 − 0.7·NightGlow) + NightEmissive·NightGlow. */
const emissiveTerm = (fill: number, nightE = 0.08): N =>
  fxE().x.add(float(fill).mul(float(1).sub(U.nightGlow.mul(0.7)))).add(U.nightGlow.mul(nightE)) as N;

/** Keep the pixel where the interleaved gradient noise is below a (animated like the stage's dithers). */
const dither = (a: N) => {
  const offset = float(frameId).mod(8).mul(5.588238).mul(U.ditherAnimate);
  return interleavedGradientNoise(screenCoordinate.xy.add(offset)).lessThan(a.mul(0.999));
};

export interface DustOptions {
  softDepth: boolean;
  stipple: boolean;
}

/** Soft translucent dust (pool "dust": wheel dust, landing rings, impact dust). */
export function dustMaterial(o: DustOptions): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.name = `FxDust${o.softDepth ? '' : 'Hard'}`;
  m.positionNode = placed();
  const c = fxC();
  m.colorNode = c.rgb.mul((fxU.light as unknown as V3).add(emissiveTerm(0.65)));
  m.opacityNode = Fn(() => {
    const a = saturate(c.w);
    // facing on the smooth sphere: its normal is the direction from the puff's centre
    const centre = fxA().xyz.toVarying('v_dustCentre') as unknown as V3;
    const N = normalize(positionWorld.sub(centre));
    const V = normalize(cameraPosition.sub(positionWorld));
    const facing = saturate(dot(N, V));
    const body = pow(smoothstep(0, 1, facing), 2.4);
    const soft = saturate(a.mul(1.8).mul(body));
    let out: N = soft as N;
    if (o.stipple) {
      // fine round dots fixed to the puff (cells of 0.03 in its local units), only in the outer band
      const D = positionView.z.negate();
      const s = fxU.stipple.mul(smoothstep(fxU.stippleNear, fxU.stippleFar, D));
      const L = (positionGeometry as unknown as V3).toVarying('v_dustLocal') as unknown as V3;
      const p = L.div(0.03);
      const cell = floor(p);
      const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
      const jit = vec3(fract(h.mul(13.1)), fract(h.mul(71.7)), fract(h.mul(31.3))).sub(0.5);
      const r = length(fract(p).sub(0.5).sub(jit.mul(0.35)));
      const w = max(fwidth(r), 0.02);
      const dotm = float(1).sub(smoothstep(float(0.3).sub(w), float(0.3).add(w), r)).mul(step(h, saturate(a.mul(1.6).add(0.15))));
      const edge = float(1).sub(smoothstep(0.55 * 0.4, 0.55, facing));
      const stip = max(soft.mul(0.3), dotm.mul(saturate(a.mul(1.5))).mul(smoothstep(0, 0.25, facing)));
      out = saturate(mix(soft, stip, edge.mul(s))) as N;
    }
    if (o.softDepth) {
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
      out = out.mul(saturate(positionView.z.sub(sceneZ).div(fxU.depthFade))) as N;
    }
    return out;
  })();
  return m;
}

/** Chips and flecks: lit, flat, two-sided; `cheap` = diffuse-only (low quality). */
export function solidMaterial(cheap: boolean): THREE.NodeMaterial {
  const props = { side: THREE.DoubleSide, flatShading: true };
  const m = cheap ? new THREE.MeshLambertNodeMaterial(props) : new THREE.MeshStandardNodeMaterial({ ...props, roughness: 0.95, metalness: 0 });
  m.name = cheap ? 'FxSolidLambert' : 'FxSolid';
  m.positionNode = placed();
  const c = fxC();
  m.colorNode = c.rgb;
  (m as THREE.MeshStandardNodeMaterial).emissiveNode = c.rgb.mul(emissiveTerm(0.12)); // NodeMaterial reads it for Lambert too
  m.maskNode = dither(c.w as unknown as N);
  m.maskShadowNode = bool(true);
  return m;
}

/** Flames and sparks: the colour × the emissive (20-40), faded by a dither. */
export function glowMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'FxGlow';
  m.positionNode = placed();
  const c = fxC();
  m.colorNode = c.rgb.mul((fxU.light as unknown as V3).add(emissiveTerm(0.12)));
  m.maskNode = dither(c.w as unknown as N);
  return m;
}

/**
 * Skid marks: a unit quad (x along the segment, z across) placed per instance:
 *   sk_a = (mid x, y, z, length), sk_b = (along x, y, z, width), sk_c = (normal x, y, z, spawn time),
 *   sk_d = (r, g, b, opacity). Opacity holds for holdS, then fades over fadeS.
 * Blended, and drawn with a strict depth test: where two segments overlap (they overlap a little on
 * purpose, so curves leave no gaps) the second one fails the test instead of darkening the joint.
 */
export function skidMaterial(cheap: boolean): THREE.NodeMaterial {
  const props = { transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
  const m = cheap ? new THREE.MeshLambertNodeMaterial(props) : new THREE.MeshStandardNodeMaterial({ ...props, roughness: 0.85, metalness: 0 });
  m.name = cheap ? 'FxSkidLambert' : 'FxSkid';
  m.depthFunc = THREE.LessDepth;
  m.flatShading = true;
  const a = attribute('sk_a', 'vec4') as unknown as V4;
  const b = attribute('sk_b', 'vec4') as unknown as V4;
  const n = attribute('sk_c', 'vec4') as unknown as V4;
  const d = attribute('sk_d', 'vec4') as unknown as V4;
  const p = positionLocal as unknown as V3;
  const across = normalize(cross(b.xyz, n.xyz));
  m.positionNode = a.xyz.add(b.xyz.mul(p.x.mul(a.w))).add(across.mul(p.z.mul(b.w)));
  m.colorNode = d.rgb;
  const age = fxU.now.sub(n.w);
  const op = d.w.mul(float(1).sub(saturate(age.sub(fxU.holdS).div(max(fxU.fadeS, 0.01))))).toVarying('v_skidOp') as unknown as N;
  m.opacityNode = op;
  m.alphaTest = 0.004; // aged-out quads leave no depth behind
  return m;
}

/**
 * Spectators: cr_a = (x, y, z, scale), cr_b = (rotY, fade, height scale, 0), cr_c = (tint r, g, b, 0).
 * White vertices (the body) take the tint, the rest keep their colour (decoded like the stage's).
 */
export function crowdMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, flatShading: true });
  m.name = 'Crowd';
  const a = attribute('cr_a', 'vec4') as unknown as V4;
  const b = attribute('cr_b', 'vec4') as unknown as V4;
  const t = attribute('cr_c', 'vec4') as unknown as V4;
  const l = (positionLocal as unknown as V3).mul(vec3(a.w, a.w.mul(b.z), a.w));
  const c = cos(b.x), s = sin(b.x);
  m.positionNode = vec3(l.x.mul(c).add(l.z.mul(s)), l.y, l.z.mul(c).sub(l.x.mul(s))).add(a.xyz);
  const raw = attribute('color', 'vec3') as unknown as V3;
  const isWhite = step(0.98, min(raw.x, min(raw.y, raw.z)));
  const lin = srgbToLinear(saturate(raw));
  m.colorNode = grade(mix(lin, t.rgb, isWhite).toVarying('v_crowdColour') as unknown as V3, U.tint.Flat);
  m.maskNode = dither(b.y.toVarying('v_crowdFade') as unknown as N);
  m.maskShadowNode = bool(true);
  return m;
}

/** The same without the fade test (spectators fully in view: early depth test). */
export function crowdSolid(m: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  const s = m.clone() as THREE.MeshStandardNodeMaterial;
  s.maskNode = null;
  s.name = 'CrowdSolid';
  return s;
}

