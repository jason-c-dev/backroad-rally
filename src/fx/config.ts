// fx.json (the original's FX tuning, copied by tools/convert/data.mjs) and small helpers shared by
// the effects. The JSON stays in UE units (cm, cm/s, s); the code converts where it uses a value.
import { Color } from 'three';

export type Range = [number, number];

export interface DustSurface {
  rate: number;
  min_kmh?: number;
  slip_only?: number;
  color: string[] | string;
  size0_cm: Range;
  size1_cm: Range;
  life_s: Range;
  opacity: number;
}

export interface ChipSurface {
  rate: number;
  colors: string[];
  size_cm: Range;
  speed_cms: Range;
  up_cms: Range;
  life_s: Range;
}

export interface FxJson {
  pools: Record<'puff' | 'chip' | 'spark' | 'flame' | 'dust', { size: number; shadow: boolean }>;
  condition_tint: Record<string, [number, number, number]>;
  dust: {
    rate_scale: number; size_scale: number; min_kmh: number; full_kmh: number; slip_start_cms: number; slip_full_cms: number;
    slip_boost: number; inherit: number; spread_cms: number; rise_cms: Range; drag: number; lift_cm: number;
    fade_out_start: number; night_emissive: number; surfaces: Record<string, DustSurface>;
  };
  chips: { night_emissive: number; surfaces: Record<string, ChipSurface> };
  flecks: { min_kmh: number; full_kmh: number; surfaces: Record<string, ChipSurface> };
  landing: { min_air_s: number; ref_fall_cms: number; count: number; ring_cm: number; speed_cms: Range; life_s: Range; size0_cm: Range; size1_cm: Range };
  skid: {
    max_segments: number; segment_cm: number; width_scale: number; lift_cm: number; min_kmh: number; min_mark: number;
    lat_start_cms: number; lat_full_cms: number; long_start_cms: number; long_full_cms: number; handbrake_mark: number;
    hold_s: number; fade_s: number; surfaces: Record<string, { color: string; opacity: number; always?: number; strength?: number }>;
  };
  exhaust: Record<string, number | number[] | string | string[]>;
  impact_sparks: { per_kmh: number; min: number; max: number; color: string; emissive: number; dust_color: string };
  cars: Record<string, { engine_pos_cm?: number[]; backfire_scale?: number; antilag?: boolean }>;
  crowd: {
    react_radius_cm: number; react_min_kmh: number; hop_height_cm: number; hop_hz: number; excite_rise: number; excite_decay: number;
    jump_bonus: number; jump_radius_cm: number; shy_radius_cm: number; shy_distance_cm: number; shy_speed_cms: number;
    return_speed_cms: number; cheer_radius_cm: number; cheer_min_kmh: number; cheer_cooldown_s: number;
    reactions: {
      near_miss_cm: number; near_miss_min_kmh: number; near_miss_cooldown_s: number; near_miss_hop_s: number; boost_hop: number;
      gasp_cm: number; gasp_min_kmh: number; gasp_cooldown_s: number; flinch_s: number; flinch_shy_scale: number; flinch_crouch: number;
      groan_min_kmh: number; groan_radius_cm: number; groan_cooldown_s: number; groan_flinch_s: number;
      applause_radius_cm: number; applause_hop_s: number; applause_far_intensity: number;
    };
  };
}

/** sRGB hex ("#D9B98F") -> linear colour, like the original's HexToLinear. */
export function hexLinear(hex: string, out = new Color()): Color {
  return out.setStyle(hex.startsWith('#') ? hex : `#${hex}`); // three decodes sRGB to its linear working space
}

export const hexList = (v: string[] | string | undefined, fallback = '#808080'): Color[] =>
  (Array.isArray(v) ? v : v ? [v] : [fallback]).map((h) => hexLinear(h));

/** The original's FxRamp: 0 at start, 1 at full (a step when full <= start). */
export const ramp = (x: number, start: number, full: number) =>
  full > start ? Math.min(Math.max((x - start) / (full - start), 0), 1) : x >= start ? 1 : 0;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/**
 * A small seeded generator (mulberry32) for the effects. Never Math.random: a seeded stream keeps
 * screenshots repeatable, and nothing here may touch the simulation's own state.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** [lo, hi] from a JSON range (or a single number). */
  pick(r: Range | number | undefined, lo: number, hi: number): number {
    if (Array.isArray(r)) return this.range(r[0], r[1]);
    if (typeof r === 'number') return r;
    return this.range(lo, hi);
  }
  /** Integer in [a, b]. */
  int(a: number, b: number): number {
    return a + Math.min(Math.floor(this.next() * (b - a + 1)), b - a);
  }
  /** Uniform random unit vector, written into o (x, y, z). */
  unit<T extends { x: number; y: number; z: number }>(o: T): T {
    const z = this.range(-1, 1), a = this.next() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    o.x = r * Math.cos(a);
    o.y = z;
    o.z = r * Math.sin(a);
    return o;
  }
}

/** Effect quality per look tier: emission scale (fewer particles), soft depth on the dust, chip shadows. */
export interface FxQuality {
  emission: number;
  softDepth: boolean;
  chipShadows: boolean;
  stipple: boolean;
}

export const FX_QUALITY: Record<string, FxQuality> = {
  high: { emission: 1, softDepth: true, chipShadows: true, stipple: true },
  medium: { emission: 1, softDepth: true, chipShadows: false, stipple: true },
  low: { emission: 1, softDepth: false, chipShadows: false, stipple: true },
};
