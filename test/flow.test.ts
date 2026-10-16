// The stage flow's retirement (src/game/stageRun.ts: terminal damage, lost, time cap, as the original's
// DeclareDNF) and the settings store (src/settings.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StageRun, DEFAULT_FLOW } from '../src/game/stageRun';
import type { RoadTracker } from '../src/sim/road';
import { noInput } from '../src/sim/vehicle';
import { events } from '../src/game/events';
import { HUD_DEFAULTS, loadHudSettings, readSection, saveHudSettings, writeSection } from '../src/settings';

const tracker = { crossedFinish: false } as unknown as RoadTracker;

function toRunning(run: StageRun): void {
  for (let i = 0; i < 1200 && run.phase !== 'running'; i++) run.update(1 / 120, noInput(), false);
}

describe('stage flow: retiring', () => {
  it('coasts to a stop and then shows the results, with the reason', () => {
    const run = new StageRun(tracker, DEFAULT_FLOW);
    toRunning(run);
    for (let i = 0; i < 120; i++) run.update(1 / 120, noInput(), false);
    const seen: { dnf: boolean; reason: string }[] = [];
    const off = events.on('finish', (e) => seen.push({ dnf: e.dnf, reason: e.reason }));
    run.retire('terminal damage');
    run.retire('left the stage'); // only the first counts
    expect(run.phase).toBe('finished');
    expect(run.dnf).toBe(true);
    expect(run.dnfReason).toBe('terminal damage');
    const clock = run.clock;
    // the coast brakes, the clock is stopped
    const out = run.update(1 / 120, { ...noInput(), throttle: 1 }, false);
    expect(out.throttle).toBe(0);
    expect(out.brake).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) run.update(1 / 120, noInput(), false);
    expect(run.phase).toBe('results');
    expect(run.clock).toBe(clock);
    off();
    expect(seen).toEqual([{ dnf: true, reason: 'terminal damage' }]);
  });

  it('retires a car lost outside the stage', () => {
    const run = new StageRun(tracker, DEFAULT_FLOW);
    toRunning(run);
    for (let i = 0; i < 121 * DEFAULT_FLOW.lost_dnf_s; i++) run.update(1 / 120, noInput(), true);
    expect(run.dnf).toBe(true);
    expect(run.dnfReason).toBe('left the stage');
    expect(run.phase).toBe('finished');
  });

  it('never turns results into a retirement', () => {
    const run = new StageRun(tracker, DEFAULT_FLOW);
    run.phase = 'results';
    run.retire('terminal damage');
    expect(run.dnf).toBe(false);
  });
});

/** A Map-backed localStorage for the store tests. */
function fakeStorage(fail = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (fail) throw new Error('blocked');
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (fail) throw new Error('blocked');
      m.set(k, v);
    },
    map: m,
  };
}

describe('settings store', () => {
  const use = (s: unknown) => vi.stubGlobal('localStorage', s);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps one key per section and survives blocked storage', () => {
    const s = fakeStorage();
    use(s);
    expect(loadHudSettings()).toEqual(HUD_DEFAULTS);
    saveHudSettings({ ...HUD_DEFAULTS, units: 'mph', speedo: 'dial', size: 125 });
    expect(JSON.parse(s.map.get('backroad-rally.hud')!)).toMatchObject({ units: 'mph', speedo: 'dial', size: 125 });
    expect(loadHudSettings()).toMatchObject({ units: 'mph', speedo: 'dial', size: 125 });
    writeSection('audio', { master: 0.5 });
    expect(readSection<{ master: number }>('audio')?.master).toBe(0.5);
    s.map.set('backroad-rally.hud', '{not json');
    expect(loadHudSettings()).toEqual(HUD_DEFAULTS);
    use(fakeStorage(true));
    expect(loadHudSettings()).toEqual(HUD_DEFAULTS);
    expect(() => saveHudSettings(HUD_DEFAULTS)).not.toThrow();
    use(undefined);
    expect(loadHudSettings()).toEqual(HUD_DEFAULTS);
  });

  it('lets the URL override a visit, clamped, without saving', () => {
    const s = fakeStorage();
    use(s);
    saveHudSettings({ ...HUD_DEFAULTS, size: 90 });
    const v = loadHudSettings(new URLSearchParams('units=mph&speedo=dial&hud=200'));
    expect(v).toMatchObject({ units: 'mph', speedo: 'dial', size: 130 });
    expect(loadHudSettings(new URLSearchParams('hud=0')).size).toBe(90); // ?hud=0 hides the HUD instead
    expect(loadHudSettings(new URLSearchParams('hud=50&units=furlongs')).size).toBe(80);
    expect(loadHudSettings().units).toBe('kmh');
  });
});
