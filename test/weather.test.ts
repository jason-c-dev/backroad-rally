// Weather (slice 8): the choice, the merged definition, the look ops, the arcade multipliers, the original's
// random stream (ice patches and puddles land where the original put them), the car's weather grip and the
// weather surface sounds.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  UeRandomStream, applyLook, arcadeScale, iceWeightAt, icePatches, nextWeather, pickWeather, puddleSites, ueHashCombine, ueStringHash,
  weatherDef, type RoadForWeather, type WeatherJson,
} from '../src/game/weather';
import { resolveCondition, type ConditionsJson } from '../src/look/conditions';
import { mainSurfaceUe } from '../src/game/autopilot';
import { weatherSurfaceLevels } from '../src/audio/weatherAudio';
import type { MixJson } from '../src/audio/mix';
import type { StageJson } from '../src/world/stage';

const json = <T>(f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')) as T;
const W = json<WeatherJson>('data/weather.json');
const C = json<ConditionsJson>('data/conditions.json');
const mix = json<MixJson>('audio/mix.json');

/** The placement view of a converted stage (no bridges: japan and alps have none in the road's way). */
function roadOf(id: string): { road: RoadForWeather; st: StageJson; halfWidth: (s: number) => number } {
  const st = json<StageJson>(`data/stages/${id}.json`);
  const r = st.road as StageJson['road'] & { y_cm: number[] };
  const S = r.s;
  const at = (s: number) => {
    let lo = 0, hi = S.length - 1;
    if (s <= S[0]) return 0;
    if (s >= S[hi]) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (S[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  };
  const fords = st.fords ?? [];
  return {
    st,
    halfWidth: (s) => r.half_width[at(s)],
    road: {
      s: S, y: r.y_cm.map((y) => y / 100), surfaceAt: (s) => r.surfaces[r.surface[at(s)]],
      inFord: (s, m) => fords.some((f) => s >= f.s0 - m && s <= f.s1 + m), onBridge: () => false,
    },
  };
}

describe('choosing the weather', () => {
  it('takes ?weather=, the stage default, the stored choice, then clear', () => {
    expect(pickWeather(W, 'rain', 'finland', false)).toBe('rain');
    expect(pickWeather(W, 'stage', 'alps', false)).toBe('snow');
    expect(pickWeather(W, 'stage', 'alps', true)).toBe('clear');
    expect(pickWeather(W, 'stage', 'wales', false)).toBe('rain');
    expect(pickWeather(W, 'stage', 'vermont', true)).toBe('rain');
    expect(pickWeather(W, null, 'finland', false, 'snow')).toBe('snow');
    expect(pickWeather(W, null, 'alps', false, 'stage')).toBe('snow');
    expect(pickWeather(W, 'fog', 'finland', false)).toBe('clear');
    expect(pickWeather(W, null, 'finland', false)).toBe('clear');
  });
  it('cycles clear -> rain -> snow -> clear', () => {
    expect(nextWeather(W, 'clear')).toBe('rain');
    expect(nextWeather(W, 'rain')).toBe('snow');
    expect(nextWeather(W, 'snow')).toBe('clear');
  });
  it('merges defaults with the weather: grip, arcade multipliers in the tuning names', () => {
    const rain = weatherDef(W, 'rain'), snow = weatherDef(W, 'snow'), clear = weatherDef(W, 'clear');
    expect(rain.grip).toMatchObject({ tarmac: 0.7, gravel: 0.86, grass: 0.73, dirt: 0.8, rock: 0.75, snow: 1 });
    expect(snow.grip).toMatchObject({ tarmac: 0.45, gravel: 0.69, grass: 0.64 });
    expect(Object.values(clear.grip).every((g) => g === 1)).toBe(true);
    expect(arcadeScale(rain)).toEqual({ handbrake_yaw_accel: 1.8, countersteer_gain: 1.1 });
    expect(arcadeScale(snow)).toEqual({ handbrake_yaw_accel: 2.6, handbrake_rear_grip: 0.85, countersteer_gain: 1.15 });
    expect(snow.ice?.grip).toBe(0.3);
    expect(snow.hide_categories).toEqual(['grass', 'flower']);
    expect(snow.audio.muffle_hz).toBe(3500);
    expect(clear.audio.dry_surface_scale).toBe(1);
  });
});

describe('the look ops (RallyWeather::ApplyLook)', () => {
  it('scales, adds and sets on top of the condition, then the condition-only block', () => {
    const base = resolveCondition(C, 'afternoon', 'finland');
    const rain = resolveCondition(C, 'afternoon', 'finland', weatherDef(W, 'rain'));
    expect(rain.sun.intensity).toBeCloseTo(base.sun.intensity * 0.1);
    expect(rain.fog.density).toBeCloseTo(base.fog.density * 2);
    expect(rain.post.exposureBias).toBeCloseTo(base.post.exposureBias + 0.3);
    expect(rain.post.whiteTemp).toBeCloseTo(base.post.whiteTemp - 250);
    expect(rain.sun.sourceAngle).toBe(25);
    expect(rain.mpc.wet).toBe(1);
    expect(rain.mpc.snow).toBe(0);
    const night = resolveCondition(C, 'night', 'finland', weatherDef(W, 'rain'));
    expect(night.mpc.precipLight).toBeCloseTo(0.07);
    expect(night.sun.intensity).toBeCloseTo(resolveCondition(C, 'night', 'finland').sun.intensity * 0.1 * 8);
  });
  it('scales an rgb(a) array by a scalar without touching the 4th value', () => {
    const c = applyLook({ mpc: { TintFoliage: [1, 1, 1, 0.5], Wind: 2 } }, { ...weatherDef(W, 'clear'), look: { scale: { mpc: { TintFoliage: 0.5, Wind: [3] } } } }, 'afternoon');
    expect((c.mpc as Record<string, unknown>).TintFoliage).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect((c.mpc as Record<string, unknown>).Wind).toBe(2); // an array op on a number does nothing
  });
  it('turns a "#hex" colour into linear rgb when scaling it', () => {
    const c = applyLook({ x: { c: '#FFFFFF' } }, { ...weatherDef(W, 'clear'), look: { scale: { x: { c: 0.5 } } } }, 'afternoon');
    expect((c.x as Record<string, unknown>).c).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe("the original's random stream", () => {
  it('hashes strings and combines hashes like the original engine', () => {
    // FCrc::Strihash_DEPRECATED is case-insensitive
    expect(ueStringHash('japan')).toBe(ueStringHash('JAPAN'));
    expect(ueHashCombine(0, 0)).not.toBe(0);
  });
  it('makes fractions in [0, 1) from a 32-bit LCG', () => {
    const r = new UeRandomStream(31);
    for (let i = 0; i < 1000; i++) {
      const f = r.fraction();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
  it("places snow's ice patches where the original did (its logs)", () => {
    const ice = weatherDef(W, 'snow').ice!;
    const fmt = (p: [number, number][]) => p.map(([a, b]) => `${Math.round(a)}-${Math.round(b)}`).join(' ');
    for (const [id, want] of [
      ['japan', '517-542 734-762 1054-1072 1203-1221 1534-1559 1878-1899 2683-2703'],
      ['alps', '270-299 458-483 1188-1215 1503-1524 1717-1733 1942-1966 2215-2237'],
      ['finland', ''],
    ] as const) {
      const { road, st } = roadOf(id);
      const v = st.variants.forward;
      expect(fmt(icePatches(ice, id, v.start_s, v.finish_s, road))).toBe(want);
    }
  });
  it("places rain's puddles in the dips where the original did (japan, alps)", () => {
    const pud = weatherDef(W, 'rain').road_decals!.puddles!;
    for (const [id, want] of [
      ['japan', '203 304 530 757 877 1579 2103 2238 2456 2638 2712 2769 3011'],
      ['alps', '126 201 550 666 703 820 1069 1371 1707 2234 2935 3066'],
    ] as const) {
      const { road, halfWidth } = roadOf(id);
      expect(puddleSites(pud, id, road, halfWidth).map((p) => Math.round(p.s)).join(' ')).toBe(want);
    }
  });
  it('weighs the ice with soft ends', () => {
    const p: [number, number][] = [[100, 120]];
    expect(iceWeightAt(p, 110)).toBe(1);
    expect(iceWeightAt(p, 100)).toBeCloseTo(0.5);
    expect(iceWeightAt(p, 98)).toBeCloseTo(1 / 6);
    expect(iceWeightAt(p, 96)).toBe(0);
    expect(iceWeightAt(p, 90)).toBe(0);
  });
});

describe('weather in the car and its sound', () => {
  it("picks the main surface like the original (the first to reach the count wins a tie; 'none' in the air)", () => {
    const w = (s: string[], c = true) => ({ wheels: s.map((surface) => ({ inContact: c, surface })) }) as unknown as Parameters<typeof mainSurfaceUe>[0];
    expect(mainSurfaceUe(w(['gravel', 'tarmac', 'tarmac', 'gravel']))).toBe('tarmac');
    expect(mainSurfaceUe(w(['gravel', 'gravel', 'tarmac', 'tarmac']))).toBe('gravel');
    expect(mainSurfaceUe(w(['gravel', 'gravel', 'gravel', 'gravel'], false))).toBe('none');
  });
  it('weights the weather surface loops by the wheels on each surface and by speed', () => {
    const snow = weatherDef(W, 'snow').audio;
    const wheels = ['tarmac', 'tarmac', 'gravel', 'grass'].map((surface) => ({ inContact: true, surface }));
    const lv = weatherSurfaceLevels(mix, snow, wheels, 200);
    const vol = (s: string) => (mix.surfaces[s] as { volume: number }).volume;
    expect(lv.get('A_Surf_Slush_Loop')).toBeCloseTo(2 * vol('tarmac') * 0.25);
    expect(lv.get('A_Surf_Snow_Loop')).toBeCloseTo((vol('gravel') + vol('grass')) * 0.25);
    expect(weatherSurfaceLevels(mix, snow, wheels, 0).get('A_Surf_Snow_Loop')).toBe(0);
  });
});
