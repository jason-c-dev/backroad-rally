// The look of a stage (handoff §8): one object that owns the lights, the fog, the shared material
// uniforms and the post pipeline, set up from a condition of conditions.json and updated once a
// frame from the car and the camera.
import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { CONDITIONS, resolveCondition, whiteBalance, type Condition, type ConditionsJson } from './conditions';
import { fogU, heightFog } from './fog';
import { Post, postU, type DofConfig } from './post';
import { QUALITY, type Quality } from './quality';
import { U, TINTED } from './uniforms';
import { interpTo } from '../camera/chaseCamera';
import type { WeatherDef } from '../game/weather';

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
/**
 * Per-weather factors on top of the condition's (slice 8), fitted the same way against the original's rain
 * and snow screenshots of the same spots (rain: finland, vermont, japan by day, finland and wales at night;
 * snow: finland, arizona, wales by day, alps and vermont in the morning, finland and alps at sunset and at
 * night): exposure, sky-light intensity, how far the sky light's colour goes toward grey (1 = grey), and a
 * colour tint on the picture. Its captured sky lit overcast rain brighter, and lit snow's shadows less and
 * less blue, than a hemisphere light scaled by the file's numbers; its tone curve also took the blue out of
 * near-white snow. `default` serves the conditions without their own entry.
 */
type WeatherCalib = { exposure: number; sky: number; skyGrey: number; tint?: [number, number, number] };
const WEATHER_CALIB: Record<string, Record<string, WeatherCalib>> = {
  rain: {
    default: { exposure: 1.45, sky: 0.85, skyGrey: 0, tint: [0.97, 1, 1.05] },
    night: { exposure: 0.85, sky: 1, skyGrey: 0, tint: [1.08, 0.98, 0.92] },
  },
  snow: {
    default: { exposure: 0.85, sky: 0.25, skyGrey: 1, tint: [1.07, 0.985, 0.93] },
    morning: { exposure: 0.7, sky: 0.25, skyGrey: 0.7, tint: [1.1, 0.98, 0.88] },
    sunset: { exposure: 1, sky: 1.5, skyGrey: 0, tint: [1.05, 0.98, 1.04] },
    night: { exposure: 0.7, sky: 0.5, skyGrey: 0 },
  },
};
/** Dev: ?wcal=exposure,sky,grey overrides the weather calibration (fitting it against screenshots). */
const WCAL = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('wcal')?.split(',').map(Number) ?? null;
/** Shadow cascades: split depths (m from the camera) for the high chase camera, which sees ground from ~28 m. */
const CASCADES = [52, 85, 160];

export interface LookOptions {
  stage: string;
  /** Quality tier (quality.ts) and render scale to start with; setQuality changes them. */
  quality: string;
  scale?: number;
  /**
   * How a render scale below 1 reaches the screen: 'browser' draws a smaller canvas and lets the
   * page compositor stretch it (free); 'fsr' renders small inside the post chain and upscales with
   * FSR 1 (sharper, but three full-resolution passes: ~3 ms at 3840×1600 on an integrated GPU).
   */
  upscale?: 'browser' | 'fsr';
  post: boolean;
  /** The condition the look starts in (night builds with the quality's night cascades). */
  condition: string;
  /** Overrides of every tier (?ao=, ?dof=, ?bloom=, ?msaa=, ?cascades= with 0 = no sun shadows,
   * ?shadowmap=, ?shadowfar=). */
  override?: Partial<Quality>;
  dof: Omit<DofConfig, 'clear' | 'scale'> & { scale?: number };
  /** The weather on top of the condition (weather.json; null or clear = the plain condition). */
  weather?: WeatherDef | null;
}

export class Look {
  /** The sun (rebuilt with its cascades when the quality changes). */
  sun!: THREE.DirectionalLight;
  readonly sky = new THREE.HemisphereLight();
  post!: Post;
  quality!: Quality;
  qualityName = '';
  /** Called after every quality change (the stage takes the vegetation settings from it). */
  onQuality?: (q: Quality, name: string) => void;
  /** The uniform sets, for tools/check and tuning from the console. */
  readonly uniforms = { U, postU, fogU };
  /** Calibration against the original (exposure scale, sky scale): see setCondition. */
  readonly calib = { exposure: EXPOSURE_SCALE, sky: SKY_SCALE };
  cond!: Condition;
  private headlights: THREE.SpotLight[] = [];
  private csm!: CSMShadowNode;
  private fogHeight: number | null = null;
  private lastFov = 0;
  private lastAspect = 0;
  private tmp = new THREE.Vector3();

  constructor(private renderer: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera,
    private json: ConditionsJson, private opts: LookOptions, private car: { root: THREE.Object3D; headlightPosCm: number[][] }) {
    scene.add(this.sky);
    this.fogOff = !!new URLSearchParams(location.search).get('lookoff')?.includes('fog');
    this.basePixelRatio = renderer.getPixelRatio();
    this.setQuality(opts.quality, opts.scale ?? 1);
    this.setPost(opts.post);
  }

  private fogOff = false;
  private basePixelRatio = 1;
  private vertexFog = heightFog();

  /** Per-vertex fog in the materials unless the post chain does it per pixel (and is on). */
  private placeFog(): void {
    const want = this.fogOff || (this.quality.postFog && this.post.enabled) ? null : this.vertexFog;
    if (this.scene.fogNode !== want) this.scene.fogNode = want;
  }

  /** Render scale in use (1 = native pixels). */
  get scale(): number {
    return this.quality.scale;
  }

  /**
   * Switch the quality tier and render scale: rebuilds the sun's cascades and the post chain. Shaders
   * that change (another cascade count, other post effects) compile on the next frame, a hitch of a
   * fraction of a second, so callers do this rarely (auto quality settles in the first seconds).
   */
  setQuality(name: string, scale = 1): void {
    // only the render scale changes (browser upscale): resize the canvas, nothing to rebuild or compile
    if (this.quality && name === this.qualityName && this.opts.upscale !== 'fsr') {
      this.quality.scale = scale;
      this.renderer.setPixelRatio(this.basePixelRatio * scale);
      return;
    }
    this.qualityName = QUALITY[name] ? name : 'high';
    const q = (this.quality = { ...QUALITY[this.qualityName], ...this.opts.override, scale });
    q.lod = { ...q.lod };
    const old = this.sun;
    if (old) {
      this.scene.remove(old, old.target);
      for (const n of (this.csm as unknown as { _shadowNodes?: { dispose(): void }[] })._shadowNodes ?? []) n.dispose();
      this.csm.dispose();
      old.dispose();
    }
    const sun = (this.sun = new THREE.DirectionalLight());
    const night = !!resolveCondition(this.json, this.cond?.name ?? this.opts.condition, this.opts.stage, this.opts.weather).headlights;
    const cascades = night && this.opts.override?.cascades === undefined ? Math.min(q.cascades, q.nightCascades) : q.cascades;
    sun.castShadow = cascades > 0;
    // no sun shadows: no vegetation shadow casters either
    if (!sun.castShadow && !q.headlightShadows) q.lod.shadowRange = 0;
    // fewer cascades keep the far ones (the near one is only for crisper shadows around the car)
    const far = q.shadowFar;
    const splits = CASCADES.slice(CASCADES.length - Math.max(1, Math.min(cascades, 3))).map((d) => (d * far) / CASCADES[CASCADES.length - 1]);
    sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    // layer 1 holds shadow-only casters (cheap vegetation proxies, stage.ts): the cascades (cloned from
    // this shadow) see them, the main camera doesn't
    sun.shadow.camera.layers.enable(1);
    this.csm = new CSMShadowNode(sun, {
      cascades: splits.length, maxFar: far, mode: 'custom', lightMargin: 80,
      customSplitsCallback: (_n: number, _near: number, far: number, out: number[]) => {
        for (const d of splits) out.push(Math.min(d / far, 1));
      },
    });
    sun.shadow.shadowNode = this.csm;
    this.scene.add(sun, sun.target);
    this.lastFov = 0; // the new cascades need their frustums
    const postOn = this.post?.enabled ?? true;
    this.post?.dispose();
    // render scale: a smaller canvas the compositor stretches, or FSR inside the chain
    const fsr = this.opts.upscale === 'fsr';
    const ratio = this.basePixelRatio * (fsr ? 1 : q.scale);
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-6) this.renderer.setPixelRatio(ratio);
    this.post = new Post(this.renderer, this.scene, this.camera, { ...q, scale: fsr ? q.scale : 1, postFog: q.postFog && !this.fogOff });
    this.post.enabled = postOn;
    this.placeFog();
    if (this.cond) this.setCondition(this.cond.name);
    this.onQuality?.(q, this.qualityName);
  }

  get conditionNames(): readonly string[] {
    return CONDITIONS;
  }

  setPost(on: boolean): void {
    this.post.enabled = on;
    this.placeFog();
    // with post the pipeline tone-maps itself; without it the renderer does ACES at the same exposure
    this.renderer.toneMapping = on ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  }

  setCondition(name: string): void {
    const c = (this.cond = resolveCondition(this.json, name, this.opts.stage, this.opts.weather));
    // sun and sky
    this.sun.color.copy(c.sun.color);
    this.sun.intensity = c.sun.intensity;
    // (rain's overcast sun has a 25° source: capped, its shadows are faint at a tenth of the light anyway)
    this.sun.shadow.radius = Math.min(Math.max(1, c.sun.sourceAngle / 2), 6);
    // the original's sky light captured the sky itself (orange at sunset, blue at night): tint the
    // light colour by the hue of the condition's fog in-scatter, normalised to unit luminance
    const sc = c.fog.inscatter, lum = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b;
    this.sky.color.copy(c.sky.color).multiply(sc.clone().multiplyScalar(1 / Math.max(lum, 1e-4)));
    this.sky.groundColor.copy(c.sky.lower).multiply(c.sky.color);
    const cc = CONDITION_CALIB[name] ?? { exposure: 1, sky: 1 };
    const wt = WEATHER_CALIB[this.opts.weather?.name ?? ''];
    const wc: WeatherCalib = WCAL && wt ? { exposure: WCAL[0] ?? 1, sky: WCAL[1] ?? 1, skyGrey: WCAL[2] ?? 0 }
      : wt?.[name] ?? wt?.default ?? { exposure: 1, sky: 1, skyGrey: 0 };
    if (wc.skyGrey) {
      const sl = 0.2126 * this.sky.color.r + 0.7152 * this.sky.color.g + 0.0722 * this.sky.color.b;
      this.sky.color.lerp(new THREE.Color(sl, sl, sl), wc.skyGrey);
    }
    this.sky.intensity = c.sky.intensity * this.calib.sky * cc.sky * wc.sky;
    // shared material uniforms
    U.nightGlow.value = c.mpc.nightGlow;
    U.wind.value = c.mpc.wind;
    U.skyColor.value.copy(c.mpc.skyColor);
    // weather blends (slice 8): the materials only build the weather code in rain or snow
    const m = c.mpc;
    U.wet.value = m.wet;
    U.snow.value = m.snow;
    U.precipLight.value = m.precipLight;
    U.snowColor.value.set(m.snowColor[0], m.snowColor[1], m.snowColor[2]);
    U.snowRoadColor.value.set(m.snowRoadColor[0], m.snowRoadColor[1], m.snowRoadColor[2], m.snowRoadColor[3]);
    U.snowParams.value.set(m.snowParams[0], m.snowParams[1], m.snowParams[2], m.snowParams[3]);
    U.wetParams.value.set(m.wetParams[0], m.wetParams[1], m.wetParams[2], m.wetParams[3]);
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
    postU.exposure.value = Math.pow(2, p.exposureBias) * this.calib.exposure * cc.exposure * wc.exposure;
    postU.toneCurve.value = p.toneCurve;
    postU.aoIntensity.value = p.aoIntensity;
    postU.whiteBalance.value.copy(whiteBalance(p.whiteTemp));
    postU.tint.value.copy(p.tint);
    if (wc.tint) postU.tint.value.multiply(new THREE.Color(...wc.tint));
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
        l.shadow.camera.layers.enable(1); // vegetation casts through its shadow-only proxies
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
    // the tilt-shift is stronger in rain and snow (camera.json dof.by_weather has only clear)
    const clear = !this.opts.weather || this.opts.weather.name === 'clear';
    this.post.update(width, height, viewDepth, { ...this.opts.dof, clear, scale: this.opts.dof.scale ?? 1 });
  }

  render(): void {
    this.post.render();
  }
}
