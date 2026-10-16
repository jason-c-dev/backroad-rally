// Mix maths (handoff §12, audio_mix.json). Pure: no Web Audio here, so it is unit-tested.
//   final volume = level x 10^(volume_db / 20) x groups.<group> x user.<group>, clamped to max_volume
// The group x user part lives on the group's GainNode (so a slider moves sounds already playing);
// the voice carries level x 10^(db/20), clamped so the product never passes max_volume.

export const GROUPS = ['engine', 'surface', 'sfx', 'ui', 'music', 'ambience', 'crowd', 'weather'] as const;
export type Group = (typeof GROUPS)[number];

export interface Attenuation {
  inner_cm: number;
  falloff_cm: number;
  db_at_max: number;
}

/** The parts of audio_mix.json the game reads (tools/convert/audio.mjs copies it, comments dropped). */
export interface MixJson {
  master: number;
  max_volume: number;
  silence: number;
  groups: Record<Group, number>;
  attenuation: { world: Attenuation; crowd: Attenuation };
  engine: EngineMixJson;
  turbo: { whistle_volume: number; pitch_min: number; pitch_max: number; blowoff_min_boost: number; blowoff_volume: number };
  surfaces: Record<string, unknown> & { speed_min_kmh: number; speed_full_kmh: number; pitch_speed_span: number; gravel_loop: string; tarmac_loop: string };
  skid: { gravel_loop: string; tarmac_loop: string; start_cms: number; full_cms: number; volume: number };
  events: {
    backfire_volume: number; backfire_volume_min: number; backfire_volume_max: number; backfire_pitch_min: number; backfire_pitch_max: number;
    impact_hard_kmh: number; impact_ref_kmh: number; impact_volume: number; landing_volume: number; reset_volume: number;
  };
  stage: {
    ambience: Record<string, string>;
    bridge: { sound: string; volume: number; pitch_min: number; pitch_span: number };
    location_oneshots: Record<string, { sounds: string; range_cm: number; gap_s: [number, number]; volume: number }>;
    ambience_volume: number;
    crowd_loop_volume: number;
    crowd_loop_range_cm: number;
    cheer_volume: number;
    cheer_min_gap_s: number;
    crowd_reactions: Record<string, { sounds: string[]; volume: number; min_gap_s: number }>;
    countdown_volume: number;
    finish_volume: number;
    music_in_stage: boolean;
    music_volume: number;
    day_mood: string;
    music_duck: { db: number; throttle_from: number; throttle_full: number; rpm_from: number; rpm_full: number; attack_s: number; release_s: number };
  };
  menu: { music_volume: number; tags: string[] };
}

export type EngineMixJson = Record<string, number> & { cars?: Record<string, Record<string, number>> };

/**
 * Web-side calibration on top of audio_mix.json, dB per group, solved from measurements rather than
 * nudged (the UE mix swung three times when single volumes were nudged). Targets, relative to the
 * engine group at full throttle, K-weighted (BS.1770) loudness, tools/check/audio.mjs prints them:
 *   music -4 dB +-1.5 (handoff §12: the engine about 4 dB over the music), surface -18..-10, ambience -24..-16.
 * The music is taken at its track's integrated loudness through its gain path: a 40 s window of a song
 * reads +-1 dB off it. Measured on finland, 5 cars x 40 s of autopilot: with audio_mix.json as is the
 * engine sat +7.5 dB over the music (mean; UE's "+4" was computed from volume multipliers, not the
 * signal), surface -15.5 and ambience -18 were on target. So the music gets +3.5 dB and nothing else
 * moves: engine over music +2.9 (swift, the quietest engine) .. +4.4, mean +4.0.
 * Re-measure after changing any asset, gain or curve: npm run build && node tools/check/audio.mjs.
 */
export const CALIBRATION_DB: Partial<Record<Group, number>> = { music: 3.5 };

export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -180);
export const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 0 at start, 1 at full (a step at start when full <= start), like UE's Ramp. */
export function ramp(x: number, start: number, full: number): number {
  return full > start ? clamp((x - start) / (full - start), 0, 1) : x >= start ? 1 : 0;
}

/** Exponential approach at `rate` per second (frame-rate independent). */
export function smooth(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Move toward target by at most speed x dt (UE FInterpConstantTo). */
export function approach(cur: number, target: number, dt: number, speed: number): number {
  const d = target - cur;
  const step = speed * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

/** A group's gain: audio_mix.json groups.<g> x the calibration x the user's slider. */
export function groupGain(mix: Pick<MixJson, 'groups'>, g: Group, user: number): number {
  return (mix.groups[g] ?? 1) * dbToLin(CALIBRATION_DB[g] ?? 0) * user;
}

/** The whole chain for one voice: level x 10^(db/20) x group x user, clamped to maxVolume. */
export function finalGain(level: number, db: number, group: number, user: number, maxVolume: number): number {
  return clamp(level * dbToLin(db) * group * user, 0, maxVolume);
}

/** The voice's own share of finalGain (what its GainNode gets; the group node carries group x user). */
export function voiceGain(level: number, db: number, groupTimesUser: number, maxVolume: number): number {
  const v = Math.max(0, level * dbToLin(db));
  return groupTimesUser > 0 ? Math.min(v, maxVolume / groupTimesUser) : v;
}

/** Equal-power crossfade weights over ascending reference points: two neighbours share cos/sin. */
export function crossfade(refs: readonly number[], x: number, out: number[] = []): number[] {
  out.length = refs.length;
  out.fill(0);
  if (!refs.length) return out;
  if (x <= refs[0]) {
    out[0] = 1;
    return out;
  }
  if (x >= refs[refs.length - 1]) {
    out[refs.length - 1] = 1;
    return out;
  }
  for (let k = 0; k + 1 < refs.length; k++) {
    if (x >= refs[k] && x < refs[k + 1]) {
      const t = (x - refs[k]) / Math.max(1, refs[k + 1] - refs[k]);
      out[k] = Math.cos((t * Math.PI) / 2);
      out[k + 1] = Math.sin((t * Math.PI) / 2);
      break;
    }
  }
  return out;
}

/**
 * Distance gain like UE's NaturalSound attenuation: 1 inside the inner radius, then falling with the
 * log of the distance to db_at_max at inner + falloff, silent past it.
 */
export function attenuate(distM: number, a: Attenuation): number {
  const inner = a.inner_cm / 100;
  const end = inner + a.falloff_cm / 100;
  if (distM <= inner) return 1;
  if (distM >= end) return 0;
  return dbToLin((a.db_at_max * Math.log(distM / inner)) / Math.log(end / inner));
}

/** Per-car engine key with the default from engine.<key> (audio_mix.json engine.cars.<id>.<key>). */
export function carNum(en: EngineMixJson, car: string, key: string, def: number): number {
  const c = en.cars?.[car]?.[key];
  if (typeof c === 'number') return c;
  const v = en[key];
  return typeof v === 'number' ? v : def;
}

/** The in-stage music duck (dB, >= 0): full depth at full throttle and high revs. */
export function musicDuckTarget(d: MixJson['stage']['music_duck'], throttle: number, rpm01: number): number {
  return d.db * ramp(throttle, d.throttle_from, d.throttle_full) * ramp(rpm01, d.rpm_from, d.rpm_full);
}

/** Step the duck toward its target at full depth per attack_s (rising) or release_s (falling). */
export function stepDuck(cur: number, target: number, d: MixJson['stage']['music_duck'], dt: number): number {
  const secs = target > cur ? d.attack_s : d.release_s;
  return approach(cur, target, dt, d.db / Math.max(0.05, secs));
}
