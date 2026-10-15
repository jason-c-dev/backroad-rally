// The look of a stage (handoff §8): one object that owns the lights, the fog, the shared material
// uniforms and the post pipeline, set up from a condition of conditions.json and updated once a
// frame from the car and the camera.
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { CONDITIONS, resolveCondition, whiteBalance, type Condition, type ConditionsJson } from './conditions';
import { fogU, heightFog } from './fog';
import { Post, QUALITY, postU, type DofConfig, type PostQuality } from './post';
import { U, TINTED } from './uniforms';
import { interpTo } from '../camera/chaseCamera';

/** Manual exposure is 2^bias × this: calibrated on the original's afternoon screenshots (road, dirt, grass). */
const EXPOSURE_SCALE = 0.92;
/** Sky light intensity -> hemisphere intensity: calibrated so shadowed dirt matches the original. */
const SKY_SCALE = 0.5;
/**
 * Per-condition exposure and sky-fill factors on top of those, measured against the original's
 * screenshots of the same spots (it lit with a captured sky whose brightness changed with the time
 * of day, which conditions.json doesn't carry). Unknown conditions use 1.
 */
const CONDITION_CALIB: Record<string, { exposure: number; sky: number }> = {
  morning: { exposure: 1.08, sky: 1 },
  afternoon: { exposure: 1, sky: 1 },
  sunset: { exposure: 1.3, sky: 1.6 },
  night: { exposure: 0.85, sky: 1 },
  fog: { exposure: 1.15, sky: 1 },
};
/** Shadow cascades: split depths (m from the camera) for the high chase camera, which sees ground from ~28 m. */
const CASCADES = [52, 85, 160];

export interface LookOptions {
  stage: string;
  quality: string;
  post: boolean;
  shadowMap: number;
  /** The condition the look starts in (night builds with the quality's night cascades). */
  condition: string;
  /** Sun shadow range (view depth, m). */
  shadowFar?: number;
  /** Overrides of the quality preset (?ao=, ?dof=, ?bloom=, ?msaa=, ?cascades= with 0 = no sun shadows). */
  override?: Partial<PostQuality>;
  dof: Omit<DofConfig, 'clear' | 'scale'> & { scale?: number };
}

export class Look {
  readonly sun = new THREE.DirectionalLight();
  readonly sky = new THREE.HemisphereLight();
  readonly post: Post;
  readonly quality: PostQuality;
  readonly qualityName: string;
  /** The uniform sets, for tools/check and tuning from the console. */
  readonly uniforms = { U, postU, fogU };
  /** Calibration against the original (exposure scale, sky scale): see setCondition. */
  readonly calib = { exposure: EXPOSURE_SCALE, sky: SKY_SCALE };
  cond!: Condition;
  private headlights: THREE.SpotLight[] = [];
  private csm: CSMShadowNode;
  private fogHeight: number | null = null;
  private lastFov = 0;
  private lastAspect = 0;
  private tmp = new THREE.Vector3();

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera,
    private json: ConditionsJson, private opts: LookOptions, private car: { root: THREE.Object3D; headlightPosCm: number[][] }) {
    this.qualityName = QUALITY[opts.quality] ? opts.quality : 'high';
    this.quality = { ...QUALITY[this.qualityName], ...opts.override };
    const sun = this.sun;
    const night = !!resolveCondition(json, opts.condition, opts.stage).headlights;
    const cascades = night && opts.override?.cascades === undefined ? Math.min(this.quality.cascades, this.quality.nightCascades) : this.quality.cascades;
    sun.castShadow = cascades > 0;
    // fewer cascades keep the far ones (the near one is only for crisper shadows around the car)
    const far = opts.shadowFar ?? CASCADES[CASCADES.length - 1];
    const splits = CASCADES.slice(CASCADES.length - Math.max(1, Math.min(cascades, 3))).map((d) => (d * far) / CASCADES[CASCADES.length - 1]);
    sun.shadow.mapSize.set(opts.shadowMap, opts.shadowMap);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.csm = new CSMShadowNode(sun, {
      cascades: splits.length, maxFar: far, mode: 'custom', lightMargin: 80,
      customSplitsCallback: (_n: number, _near: number, far: number, out: number[]) => {
        for (const d of splits) out.push(Math.min(d / far, 1));
      },
    });
    sun.shadow.shadowNode = this.csm;
    scene.add(sun, sun.target, this.sky);
    if (!new URLSearchParams(location.search).get('lookoff')?.includes('fog')) scene.fogNode = heightFog();
    this.post = new Post(renderer, scene, camera, this.quality);
    this.setPost(opts.post);
  }

  get conditionNames(): readonly string[] {
    return CONDITIONS;
  }

  setPost(on: boolean): void {
    this.post.enabled = on;
    // with post the pipeline tone-maps itself; without it the renderer does ACES at the same exposure
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setCondition(name: string): void {
    const c = (this.cond = resolveCondition(this.json, name, this.opts.stage));
    // sun and sky
    this.sun.color.copy(c.sun.color);
    this.sun.intensity = c.sun.intensity;
    this.sun.shadow.radius = Math.max(1, c.sun.sourceAngle / 2);
    // the original's sky light captured the sky itself (orange at sunset, blue at night): tint the
    // light colour by the hue of the condition's fog in-scatter, normalised to unit luminance
    const sc = c.fog.inscatter, lum = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b;
    this.sky.color.copy(c.sky.color).multiply(sc.clone().multiplyScalar(1 / Math.max(lum, 1e-4)));
    this.sky.groundColor.copy(c.sky.lower).multiply(c.sky.color);
    const cc = CONDITION_CALIB[name] ?? { exposure: 1, sky: 1 };
    this.sky.intensity = c.sky.intensity * this.calib.sky * cc.sky;
    // shared material uniforms
    U.nightGlow.value = c.mpc.nightGlow;
    U.wind.value = c.mpc.wind;
    U.skyColor.value.copy(c.mpc.skyColor);
    for (const k of TINTED) {
      const t = c.mpc.tints[k] ?? [1, 1, 1, 1];
      U.tint[k].value.set(t[0], t[1], t[2], t[3]);
    }
    // fog
    const f = c.fog;
    fogU.density.value = f.density;
    fogU.falloff.value = f.falloff;
    fogU.start.value = f.start;
    fogU.minTransmittance.value = 1 - f.maxOpacity;
    fogU.color.value.copy(f.inscatter);
    fogU.dirColor.value.copy(f.dirInscatter);
    fogU.dirExponent.value = f.dirExponent;
    fogU.dirStart.value = f.dirStart;
    fogU.toSun.value.copy(c.sun.dir).negate();
    this.scene.background = f.inscatter.clone().multiplyScalar(1);
    // post
    const p = c.post;
    postU.exposure.value = Math.pow(2, p.exposureBias) * this.calib.exposure * cc.exposure;
    postU.toneCurve.value = p.toneCurve;
    postU.aoIntensity.value = p.aoIntensity;
    postU.whiteBalance.value.copy(whiteBalance(p.whiteTemp));
    postU.tint.value.copy(p.tint);
    postU.saturation.value.copy(p.saturation);
    postU.contrast.value = p.contrast;
    postU.gainShadows.value.copy(p.gainShadows);
    postU.offsetShadows.value.copy(p.offsetShadows);
    postU.vignette.value = p.vignette;
    postU.grain.value = p.grain;
    this.post.setBloom(p.bloom, p.bloomThreshold);
    this.setHeadlights(c);
  }

  /** Night: two spot lights at the car's headlamps (cone 10°/24°, 55 m), the first casting shadows. */
  private setHeadlights(c: Condition): void {
    for (const l of this.headlights) {
      l.parent?.remove(l.target, l);
      l.dispose();
    }
    this.headlights = [];
    const h = c.headlights;
    if (!h) return;
    const [x, y, z] = this.car.headlightPosCm[0];
    for (const side of [1, -1]) {
      const l = new THREE.SpotLight(h.color, h.intensity, h.range, (h.outer * Math.PI) / 180, 1 - h.inner / h.outer, 2);
      // car-local: UE (X fwd, Y right, Z up) cm -> three (x, y up, z right) m, mirrored across the centreline
      l.position.set(x / 100 + h.forward, z / 100, (side * y) / 100);
      const yawOut = (Math.sign(side * (y || 1)) * h.yawOut * Math.PI) / 180; // outward, toward the lamp's side
      const pitch = (h.pitch * Math.PI) / 180;
      l.target.position.copy(l.position).add(new THREE.Vector3(Math.cos(pitch) * Math.cos(yawOut), Math.sin(pitch), Math.cos(pitch) * Math.sin(yawOut)).multiplyScalar(10));
      if (this.quality.headlightShadows && this.headlights.length < h.shadowLights) {
        l.castShadow = true;
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.bias = -0.0005;
        l.shadow.camera.near = 0.3;
      }
      this.car.root.add(l, l.target);
      this.headlights.push(l);
    }
  }

  /** Once a frame, after the camera moved: occluder fade, fog height, sun shadows, DOF focus. */
  update(dt: number, carPos: THREE.Vector3, width: number, height: number): void {
    const cam = this.camera;
    U.carPos.value.copy(carPos).y += 0.8;
    U.camPos.value.copy(cam.position);
    // fog height follows the car (smoothed), so hills keep one look
    const target = carPos.y + this.cond.fog.heightOffset;
    this.fogHeight = this.fogHeight === null ? target : interpTo(this.fogHeight, target, dt, this.cond.fog.followSpeed);
    fogU.height.value = this.fogHeight;
    // the sun's direction only (the cascades place themselves around the camera)
    this.sun.target.position.copy(carPos);
    this.sun.position.copy(carPos).addScaledVector(this.cond.sun.dir, -200);
    if (Math.abs(cam.fov - this.lastFov) > 0.05 || cam.aspect !== this.lastAspect) {
      this.lastFov = cam.fov;
      this.lastAspect = cam.aspect;
      if (this.csm.camera) this.csm.updateFrustums();
    }
    // tilt-shift focus: the car's depth along the view direction
    const viewDepth = this.tmp.copy(carPos).setY(carPos.y + 0.6).sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3()));
    this.post.update(width, height, viewDepth, { ...this.opts.dof, clear: true, scale: this.opts.dof.scale ?? 1 });
  }

  render(): void {
    this.post.render();
  }
}
