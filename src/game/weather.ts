// Weather (slice 8, handoff §5.2 and §8): clear, rain or snow, an axis next to the time of day. The data is
// the original's weather.json (public/data/weather.json): a weather is `defaults` deep-merged with
// `weathers.<name>`. This module holds the parts that are plain data and maths, so they are unit-tested:
//
//   pickWeather   ?weather=clear|rain|snow, or `stage` for the stage's own weather (alps forward: snow)
//   weatherDef    the merged definition of a weather
//   applyLook     the weather's look ops (set / scale / add, then by_condition.<condition>) on a condition
//   arcadeScale   arcade_scale (C++ names: HandbrakeYawAccel) -> multipliers on the arcade tuning's JSON names
//   icePatches    snow's ice patches on the tarmac, placed with the original's own random stream, so a stage
//                 has the same patches as the original, every run
//   puddleSites   rain's puddles: the road's dips, plus a few seeded ones (also the original's stream)
//
// Who applies what (main.ts): the car takes the grip, the arcade scales and the ice (sim/vehicle.ts); the look
// the colours, fog and the wet/snow blends (look/); the stage hides grass and flowers in snow and freezes the
// fords; fx/precip.ts draws the rain and snow; fx/roadMarks.ts the puddles, ruts and ice; audio/ the sounds.
import { deepMerge } from '../sim/tuning';

type Json = Record<string, unknown>;

export const WEATHERS = ['clear', 'rain', 'snow'] as const;
export type WeatherName = (typeof WEATHERS)[number];

export interface WeatherJson {
  default_weather: string;
  order: string[];
  stage_defaults: Record<string, { fwd: string; rev: string }>;
  defaults: Json;
  weathers: Record<string, Json>;
}

export interface IceJson {
  surfaces: string[];
  per_km: number;
  length_m: [number, number];
  grip: number;
  edge_m: number;
  keep_clear_m: number;
  seed: number;
  decal_width_scale?: number;
}

export interface PuddleJson {
  window_m: number;
  min_depth_cm: number;
  min_gap_m: number;
  length_m: [number, number];
  width_scale: number;
  max: number;
  extra_per_km: number;
  seed: number;
}

export interface PrecipJson {
  type: 'rain' | 'snow';
  count: number;
  box_m: [number, number, number];
  toward_camera: number;
  fall_cms: [number, number];
  wind_cms: [number, number, number];
  sway_cms?: number;
  length_cm?: [number, number];
  width_cm?: number;
  size_cm?: [number, number];
  colors: string[];
  opacity: [number, number];
  near_fade_cm: number;
  headlight_boost: number;
  headlight_range_cm: number;
  splash?: {
    rate: number; radius_m: number; ahead_m: number; size0_cm: [number, number]; size1_cm: [number, number];
    life_s: [number, number]; color: string; opacity: number;
  };
}

export interface WeatherAudioJson {
  ambience?: string;
  ambience_volume?: number;
  car_loop?: string;
  car_loop_volume?: number;
  surface_loops?: Record<string, string>;
  surface_loop_volume?: number;
  dry_surface_scale: number;
  muffle_hz: number;
  muffle_groups?: string[];
}

/** A weather as the game uses it: `defaults` deep-merged with `weathers.<name>`. */
export interface WeatherDef {
  name: WeatherName;
  label: string;
  /** Multiplier on the clear-weather friction, per surface (1 when missing). */
  grip: Record<string, number>;
  /** Multipliers on the arcade tuning (the original's C++ field names). */
  arcade_scale: Record<string, number>;
  ice?: IceJson;
  look?: Json;
  /** The material blends (MPC_Rally in the original): Wet, Snow, PrecipLight, SnowColor, ... */
  mpc: Json;
  precip?: PrecipJson;
  road_decals?: { puddles?: PuddleJson; ruts?: { segment_m: [number, number]; width_cm: number } };
  fx?: Json;
  audio: WeatherAudioJson;
  hide_categories?: string[];
  fords_frozen?: boolean;
}

const isName = (w: string | null | undefined): w is WeatherName => !!w && (WEATHERS as readonly string[]).includes(w);

/**
 * The weather to use: ?weather=<name>; ?weather=stage = the original's stage default for the direction
 * (alps forward snow, wales forward rain, vermont reverse rain, else clear); anything else = the stored
 * choice, else the file's default (clear).
 */
export function pickWeather(json: WeatherJson, asked: string | null, stage: string, reverse: boolean, stored?: string | null): WeatherName {
  if (isName(asked) && json.weathers[asked]) return asked;
  if (asked === 'stage') {
    const d = json.stage_defaults[stage]?.[reverse ? 'rev' : 'fwd'];
    if (isName(d)) return d;
  }
  if (stored === 'stage') return pickWeather(json, 'stage', stage, reverse);
  if (isName(stored) && json.weathers[stored]) return stored;
  return isName(json.default_weather) ? json.default_weather : 'clear';
}

/** The next weather in the menu order (the key J). */
export function nextWeather(json: WeatherJson, w: WeatherName): WeatherName {
  const order = (json.order?.length ? json.order : WEATHERS).filter(isName);
  return order[(order.indexOf(w) + 1) % order.length] ?? 'clear';
}

export function weatherDef(json: WeatherJson, name: WeatherName): WeatherDef {
  const w = json.weathers[name] ?? json.weathers[json.default_weather] ?? {};
  const d = deepMerge(json.defaults, w) as unknown as WeatherDef;
  return { ...d, name, grip: d.grip ?? {}, arcade_scale: d.arcade_scale ?? {}, mpc: d.mpc ?? {}, audio: { ...d.audio, dry_surface_scale: d.audio?.dry_surface_scale ?? 1, muffle_hz: d.audio?.muffle_hz ?? 0 } };
}

/** Grip multiplier of a weather for a surface (1 when missing, like RallyWeather::Grip). */
export const weatherGrip = (def: WeatherDef, surface: string): number => def.grip[surface] ?? 1;

// ---------------------------------------------------------------- look ops (RallyWeather::ApplyLook)

/** sRGB "#RRGGBB" -> linear [r, g, b, 1] (URallyData::HexToLinear). */
function hexToLinear(hex: string): number[] {
  const n = parseInt(hex.slice(1, 7), 16);
  const dec = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [dec((n >> 16) & 255), dec((n >> 8) & 255), dec(n & 255), 1];
}

/** One op on one value: numbers, arrays (a scalar on rgb(a) leaves the 4th alone) and "#hex" colours. */
function opValue(base: unknown, op: unknown, add: boolean): unknown {
  const apply = (b: number, o: number) => (add ? b + o : b * o);
  if (typeof base === 'number') return typeof op === 'number' ? apply(base, op) : undefined;
  let vals: number[];
  if (Array.isArray(base)) vals = base.map(Number);
  else if (typeof base === 'string' && base.startsWith('#')) vals = hexToLinear(base);
  else return undefined;
  return vals.map((v, i) => {
    if (typeof op === 'number') return i < 3 || vals.length < 4 ? apply(v, op) : v;
    if (Array.isArray(op) && i < op.length) return apply(v, Number(op[i]));
    return v;
  });
}

function applyOps(target: Json, ops: Json | undefined, add: boolean): Json {
  const out: Json = { ...target };
  if (!ops) return out;
  for (const [k, v] of Object.entries(ops)) {
    if (k.startsWith('_') || v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const child = out[k];
      if (child && typeof child === 'object' && !Array.isArray(child)) out[k] = applyOps(child as Json, v as Json, add);
      continue;
    }
    const r = opValue(out[k], v, add);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

function applyBlock(c: Json, block: Json | undefined): Json {
  if (!block) return c;
  if (block.set) c = deepMerge(c, block.set as Json);
  c = applyOps(c, block.scale as Json | undefined, false);
  return applyOps(c, block.add as Json | undefined, true);
}

/**
 * A condition config (conditions.json, merged) with the weather on top: its `mpc` merged in, then the
 * look's set / scale / add, then look.by_condition.<condition> the same way.
 */
export function applyLook(condition: Json, def: WeatherDef, conditionName: string): Json {
  let c = deepMerge(condition, { mpc: def.mpc });
  const look = def.look as Json | undefined;
  c = applyBlock(c, look);
  return applyBlock(c, (look?.by_condition as Record<string, Json> | undefined)?.[conditionName]);
}

/** arcade_scale with the C++ names (HandbrakeYawAccel) as the tuning's JSON names (handbrake_yaw_accel). */
export function arcadeScale(def: WeatherDef): Record<string, number> {
  return Object.fromEntries(Object.entries(def.arcade_scale).map(([k, v]) => [k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(), v]));
}

// ---------------------------------------------------------------- the original's random stream

/** FCrc::CRCTable_DEPRECATED: the MSB-first CRC-32 table (polynomial 0x04C11DB7). */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** GetTypeHash(FString): FCrc::Strihash_DEPRECATED over the upper-cased UTF-16 code units. */
export function ueStringHash(s: string): number {
  let h = 0;
  for (const ch of s.toUpperCase()) {
    const c = ch.charCodeAt(0);
    h = ((h >>> 8) & 0x00ffffff) ^ CRC[(h ^ (c & 0xff)) & 0xff];
    h = ((h >>> 8) & 0x00ffffff) ^ CRC[(h ^ (c >>> 8)) & 0xff];
  }
  return h >>> 0;
}

/** HashCombine (Bob Jenkins' mix, as the original's engine has it). */
export function ueHashCombine(a: number, c: number): number {
  let b = 0x9e3779b9;
  a = (a + b) >>> 0;
  a = (a - b) >>> 0; a = (a - c) >>> 0; a = (a ^ (c >>> 13)) >>> 0;
  b = (b - c) >>> 0; b = (b - a) >>> 0; b = (b ^ (a << 8)) >>> 0;
  c = (c - a) >>> 0; c = (c - b) >>> 0; c = (c ^ (b >>> 13)) >>> 0;
  a = (a - b) >>> 0; a = (a - c) >>> 0; a = (a ^ (c >>> 12)) >>> 0;
  b = (b - c) >>> 0; b = (b - a) >>> 0; b = (b ^ (a << 16)) >>> 0;
  c = (c - a) >>> 0; c = (c - b) >>> 0; c = (c ^ (b >>> 5)) >>> 0;
  a = (a - b) >>> 0; a = (a - c) >>> 0; a = (a ^ (c >>> 3)) >>> 0;
  b = (b - c) >>> 0; b = (b - a) >>> 0; b = (b ^ (a << 10)) >>> 0;
  c = (c - a) >>> 0; c = (c - b) >>> 0; c = (c ^ (b >>> 15)) >>> 0;
  return c;
}

/** FRandomStream: a 32-bit LCG; fractions from the top 23 bits as a float in [0, 1). Float maths like the original. */
export class UeRandomStream {
  private seed: number;
  private readonly f = new Float32Array(1);
  private readonly u = new Uint32Array(this.f.buffer);
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  fraction(): number {
    this.seed = (Math.imul(this.seed, 196314165) + 907633515) >>> 0;
    this.u[0] = 0x3f800000 | (this.seed >>> 9);
    return Math.fround(this.f[0] - 1);
  }
  /** FRandRange(lo, hi) in float maths. */
  range(lo: number, hi: number): number {
    const f = Math.fround;
    return f(f(lo) + f(f(f(hi) - f(lo)) * this.fraction()));
  }
}

/** What the placement needs from a stage (s in metres along the road). */
export interface RoadForWeather {
  /** First and last centreline s, and the sample spacing. */
  s: ArrayLike<number>;
  /** Centreline height (m) per sample. */
  y: ArrayLike<number>;
  /** Surface name of the sample at or before s (SampleAtS). */
  surfaceAt(s: number): string;
  inFord(s: number, margin: number): boolean;
  onBridge(s: number, margin: number): boolean;
}

/**
 * Snow's ice patches on the road (AStageActor::ApplyWeather): `per_km` over the stage between the start and
 * finish less `keep_clear_m` at each end, `length_m` long, only where the start, middle and end of the patch
 * are on a listed surface, 60 m apart, never in a ford or on a bridge. Seeded by the stage id: the same
 * patches every run, and the same as the original's (japan 517-542 m, ...).
 */
export function icePatches(ice: IceJson, stageId: string, startS: number, finishS: number, road: RoadForWeather): [number, number][] {
  const f = Math.fround;
  const keep = ice.keep_clear_m ?? 150;
  const lo = f(f(Math.min(startS, finishS)) + f(keep));
  const hi = f(f(Math.max(startS, finishS)) - f(keep));
  const want = Math.round(f(f(f(ice.per_km ?? 2.5) * f(Math.max(0, f(hi - lo)))) / 1000));
  const r = new UeRandomStream(ueHashCombine(ueStringHash(stageId), (ice.seed ?? 31) >>> 0));
  const surfaces = new Set(ice.surfaces ?? []);
  const ok = (s: number) => surfaces.size === 0 || surfaces.has(road.surfaceAt(s));
  const out: [number, number][] = [];
  const [l0, l1] = ice.length_m ?? [14, 30];
  for (let tr = 0; tr < want * 20 && out.length < want && hi > lo; tr++) {
    const len = r.range(l0, l1);
    const a = r.range(lo, f(hi - len));
    let good = surfaces.size === 0 || (ok(a) && ok(f(a + len)) && ok(f(a + f(len * 0.5))));
    for (const p of out) good &&= a > p[1] + 60 || a + len < p[0] - 60;
    for (let q = a; q <= a + len && good; q = f(q + 2)) good = !road.inFord(q, 10) && !road.onBridge(q, 5);
    if (good) out.push([a, f(a + len)]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Ice weight 0..1 at road progress s: 1 inside a patch, ramping over `edge` m at each end (GetIceAt). */
export function iceWeightAt(patches: readonly [number, number][], s: number, edge = 3): number {
  const e = Math.max(0.1, edge);
  let w = 0;
  for (const [a, b] of patches) {
    if (s > a - e && s < b + e) w = Math.max(w, Math.min(Math.max(Math.min(s - (a - e), b + e - s) / (2 * e), 0), 1));
  }
  return w;
}

export interface Puddle {
  s: number;
  /** Length along the road and width across it (m), and the offset from the centreline (m, + = right). */
  length: number;
  width: number;
  lateral: number;
}

/**
 * Rain's puddles (AStageActor::ApplyWeather): every local low point of the centreline (within window_m) at
 * least min_depth_cm under the mean of the window's ends, then extra_per_km seeded ones (smaller), all
 * min_gap_m apart and never in a ford or on a bridge. `halfWidth(s)` is the road's half width (m).
 */
export function puddleSites(p: PuddleJson, stageId: string, road: RoadForWeather, halfWidth: (s: number) => number): Puddle[] {
  const S = road.s, Y = road.y, n = S.length;
  const s0 = S[0], s1 = S[n - 1];
  const w = Math.max(2, Math.round((p.window_m * 0.5) / Math.max(0.5, (s1 - s0) / n)));
  const r = new UeRandomStream(ueHashCombine(ueStringHash(stageId), (p.seed ?? 17) >>> 0));
  const placed: number[] = [];
  const out: Puddle[] = [];
  const far = (s: number) => placed.every((q) => Math.abs(q - s) >= p.min_gap_m);
  for (let i = w; i < n - w && placed.length < p.max; i++) {
    const z = Y[i];
    let min = true;
    for (let j = i - w; j <= i + w && min; j++) min = Y[j] >= z;
    const depthCm = (0.5 * (Y[i - w] + Y[i + w]) - z) * 100;
    if (min && depthCm >= p.min_depth_cm && far(S[i]) && !road.inFord(S[i], 12) && !road.onBridge(S[i], 4)) {
      placed.push(S[i]);
      const len = r.range(p.length_m[0], p.length_m[1]);
      const hw = halfWidth(S[i]);
      out.push({ s: S[i], length: len, width: hw * 2 * p.width_scale, lateral: r.range(-0.25, 0.25) * hw });
    }
  }
  const extra = Math.round((p.extra_per_km * (s1 - s0)) / 1000);
  for (let k = 0, tr = 0; k < extra && tr < extra * 10 && placed.length < p.max; tr++) {
    const s = r.range(s0 + 20, s1 - 20);
    if (!far(s) || road.inFord(s, 12) || road.onBridge(s, 4)) continue;
    k++;
    placed.push(s);
    const len = r.range(p.length_m[0], p.length_m[1]) * 0.6;
    const hw = halfWidth(s);
    out.push({ s, length: len, width: hw * 2 * p.width_scale * 0.6, lateral: r.range(-0.4, 0.4) * hw });
  }
  return out.sort((a, b) => a.s - b.s);
}
