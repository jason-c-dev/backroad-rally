// Post-processing (handoff §8) with three's TSL render pipeline, so it runs on WebGPU and WebGL2:
//
//   scene (HDR, MSAA) -> tilt-shift DOF (depth CoC, half-res gather) -> AO (GTAO, half res)
//   -> exposure + bloom -> grade (white balance, tint, saturation, contrast, shadow gain/offset)
//   -> ACES (blended by the tone-curve amount) -> vignette + grain -> sRGB
//
// The original ran DOF and bloom ahead of its tonemapper and graded inside it; this keeps that
// order. Every stage has a quality knob; `enabled = false` renders the scene straight to the
// canvas with ACES at the same exposure, for comparison (?post=0, key P).
import * as THREE from 'three/webgpu';
import {
  Fn, abs, dot, exp, float, frameId, log2, max, min, mix, pass, perspectiveDepthToViewZ, pow, rand, rtt, step,
  saturate, smoothstep, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';

type N = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

export interface PostQuality {
  /** GTAO: 0 = off, else the resolution scale (0.5 = half). */
  ao: number;
  aoSamples: number;
  /** DOF gather taps (0 = off). */
  dofTaps: number;
  bloom: boolean;
  /** MSAA samples of the scene pass. */
  msaa: number;
  /** Sun shadow cascades (1-3). */
  cascades: number;
  /** Sun (moon) cascades when the look is built for a night condition: its shadows are faint. */
  nightCascades: number;
  /** Night: let a headlight cast shadows (the condition says how many). */
  headlightShadows: boolean;
}

/**
 * Presets. Measured on the RTX 5070 Ti laptop GPU (WebGL2, finland forward, autopilot, GPU timer):
 * high holds 60 fps at 1920×1080 (8.3 ms GPU) but not at 3840×1600 (13.6 ms mean, 17.8 ms p95);
 * medium holds 3840×1600 (10.2 ms mean, 13.9 ms p95). `pickQuality` chooses by pixel count.
 */
export const QUALITY: Record<string, PostQuality> = {
  low: { ao: 0, aoSamples: 8, dofTaps: 0, bloom: false, msaa: 0, cascades: 1, nightCascades: 1, headlightShadows: false },
  medium: { ao: 0.5, aoSamples: 8, dofTaps: 12, bloom: true, msaa: 0, cascades: 2, nightCascades: 1, headlightShadows: true },
  high: { ao: 0.5, aoSamples: 16, dofTaps: 16, bloom: true, msaa: 4, cascades: 3, nightCascades: 3, headlightShadows: true },
};

/** ?quality=auto (the default): high up to about 2560×1440 drawn pixels, medium above. */
export function pickQuality(asked: string | null, drawnPixels: number): string {
  if (asked && asked !== 'auto' && QUALITY[asked]) return asked;
  return drawnPixels > 2560 * 1440 * 1.1 ? 'medium' : 'high';
}

export const postU = {
  exposure: uniform(1),
  toneCurve: uniform(0.75),
  aoIntensity: uniform(0.45),
  whiteBalance: uniform(new THREE.Color(1, 1, 1)),
  tint: uniform(new THREE.Color(1, 1, 1)),
  saturation: uniform(new THREE.Vector3(1, 1, 1)),
  contrast: uniform(1),
  gainShadows: uniform(new THREE.Vector3(1, 1, 1)),
  offsetShadows: uniform(new THREE.Vector3(0, 0, 0)),
  vignette: uniform(0.3),
  grain: uniform(0.08),
  aspect: uniform(16 / 9),
  // tilt-shift: CoC radius (px) = k·|d − focus|/d, at most maxCoc; set every frame from the camera
  focus: uniform(40),
  cocK: uniform(0),
  maxCoc: uniform(16),
  invSize: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)),
  near: uniform(0.5),
  far: uniform(4000),
};

const BLOOM_SCALE = 0.27;

// ---- the original engine's filmic tonemapper (defaults: slope 0.88, toe 0.55, shoulder 0.26,
// black clip 0, white clip 0.04), applied per channel in ACES AP1 after the grade, blended with the
// untouched colour by the tone-curve amount. Linear sRGB (D65) <-> AP1 (D60, Bradford).
const SRGB_TO_AP1 = [[0.6131324224, 0.3395380158, 0.0474166960], [0.0701243808, 0.9163940113, 0.0134515240], [0.0205876575, 0.1095745716, 0.8697854040]];
const AP1_TO_SRGB = [[1.7048586763, -0.6217160219, -0.0832993717], [-0.1300768242, 1.1407357748, -0.0105598017], [-0.0239640729, -0.1289755083, 1.1530140189]];
const AP1_Y = vec3(0.2722287168, 0.6740817658, 0.0536895174);
const mul3 = (m: number[][], c: V3): V3 => vec3(dot(vec3(...m[0]), c), dot(vec3(...m[1]), c), dot(vec3(...m[2]), c)) as V3;
const FILM = (() => {
  const slope = 0.88, toe = 0.55, shoulder = 0.26, black = 0, white = 0.04;
  const toeScale = 1 + black - toe, shoulderScale = 1 + white - shoulder;
  const bt = (0.18 + black) / toeScale - 1;
  const toeMatch = Math.log10(0.18) - 0.5 * Math.log((1 + bt) / (1 - bt)) * (toeScale / slope);
  const straightMatch = (1 - toe) / slope - toeMatch;
  const shoulderMatch = shoulder / slope - straightMatch;
  return { slope, black, white, toeScale, shoulderScale, toeMatch, straightMatch, shoulderMatch };
})();

function filmic(linear: V3): V3 {
  const F = FILM;
  let w = max(mul3(SRGB_TO_AP1, linear), 0) as V3;
  // grade: saturation, contrast (around 0.18), shadow gain and offset
  w = max(mix(vec3(dot(w, AP1_Y)), w, postU.saturation), 0) as V3;
  w = pow(w.div(0.18).add(1e-6), vec3(postU.contrast)).mul(0.18) as V3;
  const shadows = float(1).sub(smoothstep(0, 0.09, dot(w, AP1_Y)));
  w = mix(w, w.mul(postU.gainShadows).add(postU.offsetShadows), shadows) as V3;
  const graded = w;
  // film curve
  w = mix(vec3(dot(w, AP1_Y)), w, 0.96) as V3;
  const lc = log2(max(w, 1e-10)).mul(Math.LOG10E / Math.LOG2E) as V3; // log10
  const straight = lc.add(F.straightMatch).mul(F.slope);
  const toeC = vec3(-F.black).add(float(2 * F.toeScale).div(exp(lc.sub(F.toeMatch).mul((-2 * F.slope) / F.toeScale)).add(1)));
  const shoulderC = vec3(1 + F.white).sub(float(2 * F.shoulderScale).div(exp(lc.sub(F.shoulderMatch).mul((2 * F.slope) / F.shoulderScale)).add(1)));
  const toeSel = mix(straight, toeC, step(lc, vec3(F.toeMatch))); // toe below its match point
  const shSel = mix(straight, shoulderC, step(vec3(F.shoulderMatch), lc)); // shoulder above its match point
  let t = saturate(lc.sub(F.toeMatch).div(F.shoulderMatch - F.toeMatch)) as V3;
  if (F.shoulderMatch < F.toeMatch) t = vec3(1).sub(t) as V3;
  t = vec3(3).sub(t.mul(2)).mul(t).mul(t) as V3;
  let tone = mix(toeSel, shSel, t) as V3;
  tone = max(mix(vec3(dot(tone, AP1_Y)), tone, 0.93), 0) as V3;
  const out = mix(graded, tone, postU.toneCurve) as V3;
  return saturate(mul3(AP1_TO_SRGB, out)) as V3;
}

/** Golden-angle spiral in the unit disc. */
function spiral(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const r = Math.sqrt((i + 0.5) / n), a = i * 2.39996323;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

export class Post {
  readonly pipeline: THREE.RenderPipeline;
  enabled = true;
  private aoNode: ReturnType<typeof ao> | null = null;
  private bloomNode: ReturnType<typeof bloom> | null = null;

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera,
    readonly quality: PostQuality) {
    // WebGPU keeps a multisampled depth texture unresolved, and GTAO and the DOF can't sample one
    // (WGSL has no textureGather on texture_depth_multisampled_2d): there the scene pass runs
    // without MSAA and FXAA smooths the edges at the end instead
    const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    const needsDepth = quality.ao > 0 || quality.dofTaps > 0;
    const msaa = webgpu && needsDepth ? 0 : quality.msaa;
    const scenePass = pass(scene, camera, { samples: msaa });
    const colour = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const viewDepth = (d: N): N => perspectiveDepthToViewZ(d, postU.near, postU.far).negate() as N;
    const coc = (d: N): N => min(postU.cocK.mul(abs(d.sub(postU.focus))).div(max(d, 0.1)), postU.maxCoc) as N;

    // ---- tilt-shift DOF: gather at half resolution; a tap counts if its own CoC reaches the centre
    // (so the sharp car doesn't smear into the blurred ground around it)
    let hdr: V3 = colour.rgb as unknown as V3;
    if (quality.dofTaps > 0) {
      const taps = spiral(quality.dofTaps);
      const gather = Fn(() => {
        const c = uv() as unknown as V2;
        const r = coc(viewDepth(depth.sample(c).r as unknown as N));
        const acc = colour.sample(c).rgb.toVar();
        const wsum = float(1).toVar();
        for (const [x, y] of taps) {
          const dist = Math.hypot(x, y);
          const t = c.add(vec2(x, y).mul(r).mul(postU.invSize));
          const rt = coc(viewDepth(depth.sample(t).r as unknown as N));
          const w = saturate(rt.sub(r.mul(dist)).add(1));
          acc.addAssign(colour.sample(t).rgb.mul(w));
          wsum.addAssign(w);
        }
        return vec4(acc.div(wsum), r);
      });
      const blurred = rtt(gather(), null, null, { resolutionScale: 0.5, type: THREE.HalfFloatType });
      const r = coc(viewDepth(depth.r as unknown as N));
      hdr = mix(hdr, blurred.rgb, smoothstep(0.6, 2.0, r)) as V3;
    }

    // ---- ambient occlusion (strong, 2.5 m)
    if (quality.ao > 0) {
      const a = ao(depth, null as unknown as THREE.Node, camera); // normals from depth (flat-shaded scene)
      a.resolutionScale = quality.ao;
      a.samples.value = quality.aoSamples;
      a.radius.value = 2.5;
      a.thickness.value = 1;
      this.aoNode = a;
      hdr = hdr.mul(mix(float(1), a.getTextureNode().r, postU.aoIntensity)) as V3;
    }

    // ---- exposure and bloom (threshold in exposed units, like the original)
    let c: V3 = hdr.mul(postU.exposure) as V3;
    if (quality.bloom) {
      const b = bloom(vec4(colour.rgb.mul(postU.exposure), 1), 0.55, 0.4, 1);
      this.bloomNode = b;
      c = c.add(b.rgb) as V3;
    }

    // ---- grade and tone curve in ACES AP1, like the original's tonemapper
    c = filmic(c.mul(postU.whiteBalance).mul(postU.tint) as V3);

    // ---- vignette, grain
    const p = (uv() as unknown as V2).sub(0.5).mul(2).mul(vec2(postU.aspect, 1)).div(postU.aspect).mul(postU.vignette.mul(2));
    const v = float(1).div(dot(p, p).add(1));
    c = c.mul(v.mul(v)) as V3;
    const n = rand((uv() as unknown as V2).add(vec2(float(frameId).mod(64).mul(0.137), 0))).sub(0.5);
    c = c.mul(float(1).add(n.mul(postU.grain))) as V3;

    let out: THREE.Node = vec4(saturate(c), 1);
    if (msaa === 0) out = fxaa(out as THREE.Node<'vec4'>); // FXAA wherever the scene pass has no MSAA
    this.pipeline = new THREE.RenderPipeline(renderer, out as THREE.Node<'vec4'>);
    // the pipeline's own output transform encodes sRGB; the tone mapping is done above
    this.pipeline.outputColorTransform = true;
  }

  /** Strength and threshold for the condition (the original: 0.55 / 1, sunset 0.8). */
  setBloom(strength: number, threshold: number): void {
    if (!this.bloomNode) return;
    // three's bloom adds five mips weighted 1 .. 0.2 (about 3× the strength); the original's
    // bloom weights sum to about 0.8 of its intensity
    this.bloomNode.strength.value = strength * BLOOM_SCALE;
    this.bloomNode.threshold.value = Math.max(threshold, 0);
    this.bloomNode.smoothWidth.value = 0.1;
  }

  get bloom() {
    return this.bloomNode;
  }

  /** Per frame: camera depth range, the screen size and the tilt-shift focus from the car's view depth. */
  update(width: number, height: number, carViewDepth: number, dof: DofConfig): void {
    const cam = this.camera;
    postU.near.value = cam.near;
    postU.far.value = cam.far;
    postU.aspect.value = width / height;
    postU.invSize.value.set(1 / width, 1 / height);
    // focus at the car's view depth (+0.6 m up) plus 2 m, 12 m in clear weather; f-stop
    // 0.4·(40 m / distance), ×3 in clear; a 400 mm sensor across the horizontal field of view.
    const clear = dof.clear;
    const S = carViewDepth + (clear ? dof.clearFocusOffset : dof.focusOffset);
    const fstop = dof.fstop * (dof.refDistance / Math.max(carViewDepth, 1)) * (clear ? dof.clearFstopScale : 1);
    const hfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect);
    const f = dof.sensorWidth / 2 / Math.tan(hfov / 2); // focal length, m
    const aperture = f / fstop;
    // thin lens: CoC diameter on the sensor = A·f·|d − S| / (d·(S − f)); as a radius in pixels, scaled by
    // `dof.scale` (calibrated by eye against the original's screenshots)
    postU.focus.value = S;
    postU.cocK.value = ((aperture * f) / Math.max(S - f, 0.1)) / dof.sensorWidth * width * 0.5 * dof.scale;
    postU.maxCoc.value = 0.025 * width;
  }

  render(): void {
    if (this.enabled) {
      this.pipeline.render();
    } else {
      this.renderer.toneMappingExposure = postU.exposure.value;
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** On a resize or condition change the pipeline is fine; AO and bloom read the drawing buffer size. */
  get aoEnabled(): boolean {
    return !!this.aoNode;
  }
}

export interface DofConfig {
  clear: boolean;
  fstop: number;
  refDistance: number; // m
  focusOffset: number; // m
  clearFocusOffset: number;
  clearFstopScale: number;
  sensorWidth: number; // m
  scale: number;
}
