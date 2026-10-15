// Conditions (conditions.json, handoff §8): a condition is `defaults` deep-merged with
// `conditions.<name>`, then with `stage_overrides.<stage>.<name>`. This module resolves one and
// turns it into plain numbers in three's units: directions in three axes, colours linear, fog per
// metre. Colours in the file: "#hex" is sRGB (decoded to linear), arrays are linear already.
import * as THREE from 'three/webgpu';

type Json = Record<string, unknown>;

export interface ConditionsJson {
  default_condition: string;
  stage_defaults: Record<string, { fwd: string; rev: string }>;
  defaults: Json;
  conditions: Record<string, Json>;
  stage_overrides: Record<string, Record<string, Json>>;
}

export const CONDITIONS = ['morning', 'afternoon', 'sunset', 'night', 'fog'] as const;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; anything else (numbers, strings, arrays) replaces. */
export function deepMerge(a: Json, b: Json | undefined): Json {
  if (!b) return a;
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Json, v) : v;
  return out;
}

/** "#RRGGBB" (sRGB) or [r, g, b(, a)] (linear) -> linear rgb. */
export function colour(v: unknown, fallback: [number, number, number] = [1, 1, 1]): THREE.Color {
  if (typeof v === 'string') return new THREE.Color().setStyle(v, THREE.SRGBColorSpace); // working space is linear
  if (Array.isArray(v)) return new THREE.Color(v[0], v[1], v[2]);
  return new THREE.Color(...fallback);
}

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const vec4 = (v: unknown, d = [1, 1, 1, 1]) => (Array.isArray(v) ? [0, 1, 2, 3].map((i) => num(v[i], d[i])) : d);

/** Direction the light travels, three axes, from a UE rotator's pitch and yaw (deg). */
export function lightDir(pitchDeg: number, yawDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = (pitchDeg * Math.PI) / 180, y = (yawDeg * Math.PI) / 180;
  // UE forward (cos p cos y, cos p sin y, sin p) with UE (X, Y, Z) -> three (X, Z, Y)
  return out.set(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)).normalize();
}

/**
 * White balance like the original's WhiteTemp: the picture is corrected as if lit by a light of
 * this temperature, so values above 6500 K warm it and below cool it. Returns a linear rgb gain
 * with unit luminance. Planckian colour from Tanner Helland's fit.
 */
export function whiteBalance(kelvin: number): THREE.Color {
  const bb = (k: number) => {
    const t = k / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return new THREE.Color().setRGB(...([r, g, b].map((c) => Math.min(Math.max(c, 0), 255) / 255) as [number, number, number]), THREE.SRGBColorSpace);
  };
  const ref = bb(6500), at = bb(kelvin);
  const gain = new THREE.Color(ref.r / at.r, ref.g / at.g, ref.b / at.b);
  const l = 0.2126 * gain.r + 0.7152 * gain.g + 0.0722 * gain.b;
  return gain.multiplyScalar(1 / l);
}

export interface Condition {
  name: string;
  sun: { dir: THREE.Vector3; color: THREE.Color; intensity: number; sourceAngle: number };
  sky: { color: THREE.Color; intensity: number; lower: THREE.Color };
  fog: {
    density: number; // per metre (the file's FogDensity is per 1000 cm)
    falloff: number; // per metre
    start: number; // m
    heightOffset: number; // m above the car
    followSpeed: number;
    maxOpacity: number;
    inscatter: THREE.Color;
    dirInscatter: THREE.Color;
    dirExponent: number;
    dirStart: number; // m
  };
  post: {
    exposureBias: number;
    toneCurve: number;
    bloom: number;
    bloomThreshold: number;
    vignette: number;
    grain: number;
    aoIntensity: number;
    aoRadius: number; // m
    saturation: THREE.Vector3;
    contrast: number;
    whiteTemp: number;
    gainShadows: THREE.Vector3;
    offsetShadows: THREE.Vector3;
    tint: THREE.Color;
  };
  mpc: {
    skyColor: THREE.Color;
    nightGlow: number;
    wind: number;
    tints: Record<string, number[]>;
  };
  headlights: null | {
    pitch: number;
    yawOut: number;
    forward: number; // m
    shadowLights: number;
    intensity: number; // cd
    color: THREE.Color;
    inner: number; // deg
    outer: number; // deg
    range: number; // m
  };
}

/** The condition to use: ?cond=<name>, else the conditions.json default (afternoon). */
export function pickCondition(json: ConditionsJson, asked: string | null, stage: string, reverse: boolean): string {
  if (asked && json.conditions[asked]) return asked;
  // ?cond=stage: the original's per-stage choice (finland forward runs at sunset, reverse in the afternoon)
  if (asked === 'stage' && json.stage_defaults[stage]) return json.stage_defaults[stage][reverse ? 'rev' : 'fwd'];
  return json.default_condition;
}

export function resolveCondition(json: ConditionsJson, name: string, stage: string): Condition {
  let c = deepMerge(json.defaults, json.conditions[name]);
  c = deepMerge(c, json.stage_overrides[stage]?.[name]);
  const sun = c.sun as Json, sunP = (sun.props ?? {}) as Json;
  const sky = ((c.sky_light as Json)?.props ?? {}) as Json;
  const fog = (c.fog as Json) ?? {}, fp = (fog.props ?? {}) as Json;
  const post = (c.post ?? {}) as Json;
  const mpc = (c.mpc ?? {}) as Json;
  const hl = c.headlights as Json | undefined;
  const hp = (hl?.props ?? {}) as Json;
  const sat = post.ColorSaturation;
  return {
    name,
    sun: {
      dir: lightDir(num(sun.pitch, -35), num(sun.yaw, 120)),
      color: colour(sunP.LightColor),
      intensity: num(sunP.Intensity, 8),
      sourceAngle: num(sunP.LightSourceAngle, 4),
    },
    sky: { color: colour(sky.LightColor), intensity: num(sky.Intensity, 1.6), lower: colour(sky.LowerHemisphereColor, [0.12, 0.14, 0.1]) },
    fog: {
      density: num(fp.FogDensity, 0.03) / 10,
      falloff: num(fp.FogHeightFalloff, 0.2) / 10,
      start: num(fp.StartDistance, 0) / 100,
      heightOffset: num(fog.height_offset_cm, 0) / 100,
      followSpeed: num(fog.follow_speed, 0.6),
      maxOpacity: num(fp.FogMaxOpacity, 1),
      inscatter: colour(fp.FogInscatteringLuminance, [0.6, 0.68, 0.8]),
      dirInscatter: colour(fp.DirectionalInscatteringLuminance, [0, 0, 0]),
      dirExponent: num(fp.DirectionalInscatteringExponent, 4),
      dirStart: num(fp.DirectionalInscatteringStartDistance, 10000) / 100,
    },
    post: {
      exposureBias: num(post.AutoExposureBias, 0),
      toneCurve: num(post.ToneCurveAmount, 1),
      bloom: num(post.BloomIntensity, 0.675),
      bloomThreshold: num(post.BloomThreshold, -1),
      vignette: num(post.VignetteIntensity, 0.4),
      grain: num(post.FilmGrainIntensity, 0),
      aoIntensity: num(post.AmbientOcclusionIntensity, 0.5),
      aoRadius: num(post.AmbientOcclusionRadius, 200) / 100,
      saturation: Array.isArray(sat) ? new THREE.Vector3(sat[0], sat[1], sat[2]) : new THREE.Vector3().setScalar(num(sat, 1)),
      contrast: num(post.ColorContrast, 1),
      whiteTemp: num(post.WhiteTemp, 6500),
      gainShadows: new THREE.Vector3(...vec4(post.ColorGainShadows).slice(0, 3)),
      offsetShadows: new THREE.Vector3(...vec4(post.ColorOffsetShadows, [0, 0, 0, 0]).slice(0, 3)),
      tint: colour(post.SceneColorTint),
    },
    mpc: {
      skyColor: colour(mpc.SkyColor, [0.5, 0.6, 0.75]),
      nightGlow: num(mpc.NightGlow, 0),
      wind: num(mpc.Wind, 1),
      tints: Object.fromEntries(Object.entries(mpc).filter(([k]) => k.startsWith('Tint')).map(([k, v]) => [k.slice(4), vec4(v)])),
    },
    headlights: hl?.on ? {
      pitch: num(hl.pitch_deg, 0),
      yawOut: num(hl.yaw_out_deg, 0),
      forward: num(hl.forward_cm, 0) / 100,
      shadowLights: num(hl.shadow_lights, 1),
      intensity: num(hp.Intensity, 400),
      color: colour(hp.LightColor),
      inner: num(hp.InnerConeAngle, 10),
      outer: num(hp.OuterConeAngle, 24),
      range: num(hp.AttenuationRadius, 5500) / 100,
    } : null,
  };
}
