// Slice 9: the page flow (src/menu/nav.ts), the settings sections (src/settings.ts), the frame-rate limit
// (src/boot.ts FrameLimiter) and the menus' data lookups (src/menu/data.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { pageKind, parsePlay, playQuery, menuQuery, putMenuState, takeMenuState } from '../src/menu/nav';
import {
  DISPLAY_DEFAULTS, GAME_DEFAULTS, HUD_DEFAULTS, loadDisplaySettings, loadGameSettings, loadHudSettings, loadRunSettings, loadVolumes, saveHudSettings,
} from '../src/settings';
import { FrameLimiter } from '../src/boot';
import { dioramaConfig, lockLine, type MenuData, type MenuJson } from '../src/menu/data';

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

describe('page flow', () => {
  afterEach(() => vi.unstubAllGlobals());
  const P = (s: string) => new URLSearchParams(s);

  it('opens the menus by default and keeps the development URLs going straight to a stage', () => {
    expect(pageKind(P(''))).toBe('menu');
    expect(pageKind(P('webgl&quality=low'))).toBe('menu');
    expect(pageKind(P('menu=garage&stage=japan'))).toBe('menu');
    expect(pageKind(P('autopilot=120'))).toBe('dev');
    expect(pageKind(P('stage=alps'))).toBe('dev');
    expect(pageKind(P('car=pip'))).toBe('dev');
    expect(pageKind(P('mode=quick&stage=wales'))).toBe('play');
    expect(pageKind(P('mode=other&stage=wales'))).toBe('dev');
  });

  it('round-trips a run through the URL and keeps only the development options', () => {
    const setup = { mode: 'attack' as const, stage: 'vermont', reverse: true, car: 'kaze', livery: 3, cond: 'night', weather: 'rain' };
    const q = playQuery(setup, P('webgl&quality=low&autopilot=120&menu=x'));
    expect(q).toContain('webgl=');
    expect(q).toContain('quality=low');
    expect(q).not.toContain('autopilot');
    // a headless career run keeps the robot across pages, and the menus' URL stays a menu page
    const auto = P('autocontinue=1&autopilot=120&timescale=4&menu=career');
    expect(playQuery(setup, auto)).toContain('autopilot=120');
    expect(pageKind(P(menuQuery(auto).slice(1)))).toBe('menu');
    expect(parsePlay(P(q.slice(1)))).toEqual(setup);
    expect(parsePlay(P('mode=quick'))).toEqual({ mode: 'quick', stage: 'finland', reverse: false, car: 'swift', livery: 0, cond: 'stage', weather: 'stage' });
    expect(parsePlay(P('mode=quick&stage=../x&car=<b>&livery=99'))).toMatchObject({ stage: 'finland', car: 'swift', livery: 31 });
    expect(parsePlay(P('stage=finland'))).toBeNull();
    expect(menuQuery(P('stage=finland&mode=quick'))).toBe('');
    expect(menuQuery(P('webgl&scale=0.7'))).toBe('?webgl=&scale=0.7');
  });

  it('hands the menu state to the next page once', () => {
    vi.stubGlobal('sessionStorage', fakeStorage());
    putMenuState({ screen: 'stageselect', flow: 'quick', stage: 'japan', focus: 2 });
    expect(takeMenuState()).toEqual({ screen: 'stageselect', flow: 'quick', stage: 'japan', focus: 2 });
    expect(takeMenuState()).toBeNull();
  });
});

describe('settings sections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults the debug panel off, also over an old (v1) section that saved it on', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    expect(HUD_DEFAULTS.debug).toBe(false);
    s.map.set('backroad-rally.hud', JSON.stringify({ units: 'mph', speedo: 'number', size: 100, debug: true }));
    expect(loadHudSettings()).toMatchObject({ units: 'mph', debug: false });
    saveHudSettings({ ...HUD_DEFAULTS, debug: true });
    expect(loadHudSettings().debug).toBe(true); // a choice made with F3 now sticks
  });

  it('reads the game, display, run and volume sections with clamps and defaults', () => {
    const s = fakeStorage();
    vi.stubGlobal('localStorage', s);
    expect(loadGameSettings()).toEqual(GAME_DEFAULTS);
    expect(loadDisplaySettings()).toEqual(DISPLAY_DEFAULTS);
    expect(DISPLAY_DEFAULTS.fpsLimit).toBe(60);
    s.map.set('backroad-rally.game', JSON.stringify({ camera: 3, fov: 90, stability: 2, countersteer: -1, tractionAssist: false, rivalGhosts: 5 }));
    expect(loadGameSettings()).toEqual({ ...GAME_DEFAULTS, camera: 3, fov: 56, stability: 1, countersteer: 0, tractionAssist: false });
    s.map.set('backroad-rally.display', JSON.stringify({ quality: 'epic', fpsLimit: 75, renderScale: 63, drawDistance: 9 }));
    expect(loadDisplaySettings()).toEqual({ ...DISPLAY_DEFAULTS, renderScale: 65, drawDistance: 3 });
    s.map.set('backroad-rally.display', JSON.stringify({ quality: 'low', fpsLimit: 0, renderScale: 0, drawDistance: -1 }));
    expect(loadDisplaySettings()).toEqual({ quality: 'low', fpsLimit: 0, renderScale: 0, drawDistance: -1 });
    s.map.set('backroad-rally.run', JSON.stringify({ weather: 'stage', condition: 'night', stage: 'wales', reverse: true, car: 'lama', livery: 2 }));
    expect(loadRunSettings()).toEqual({ weather: 'stage', condition: 'night', stage: 'wales', reverse: true, car: 'lama', livery: 2 });
    s.map.set('backroad-rally.audio', JSON.stringify({ master: 3, groups: { crowd: 0.4, ui: 'x' } }));
    const v = loadVolumes();
    expect(v.master).toBe(1);
    expect(v.groups.crowd).toBe(0.4);
    expect(v.groups.ui).toBe(1);
  });
});

describe('frame-rate limit', () => {
  /** Frames drawn in one second of callbacks at `hz` with a cap of `fps` (with a little jitter). */
  const drawn = (hz: number, fps: number) => {
    const l = new FrameLimiter(fps);
    let n = 0;
    for (let i = 1; i <= hz; i++) if (l.due(1000 + (i * 1000) / hz + Math.sin(i * 7) * 0.4)) n++;
    return n;
  };

  it('holds the cap on faster displays and never drops frames on a matching one', () => {
    expect(drawn(60, 60)).toBe(60);
    expect(drawn(120, 60)).toBeGreaterThanOrEqual(59);
    expect(drawn(120, 60)).toBeLessThanOrEqual(61);
    expect(Math.abs(drawn(144, 60) - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(drawn(144, 30) - 30)).toBeLessThanOrEqual(1);
    expect(drawn(144, 144)).toBe(144);
    expect(drawn(144, 0)).toBe(144);
  });

  it('re-syncs after a stall instead of catching up', () => {
    const l = new FrameLimiter(60);
    expect(l.due(1000)).toBe(true);
    expect(l.due(1500)).toBe(true); // half a second later: draw now
    expect(l.due(1505)).toBe(false); // not again 5 ms later
  });
});

describe('menu data', () => {
  const menu = JSON.parse(readFileSync('public/data/menu.json', 'utf8')) as MenuJson;
  const career = JSON.parse(readFileSync('public/data/career.json', 'utf8'));

  it('merges a location over the diorama defaults', () => {
    expect(dioramaConfig(menu, 'alps')).toMatchObject({ stage: 'alps', s: 1889, condition: 'morning', weather: 'snow', start_yaw: 145 });
    expect(dioramaConfig(menu, 'finland')).toMatchObject({ stage: 'finland', s: 140, condition: 'sunset', lateral_m: 0 });
    expect(dioramaConfig(menu, 'nowhere').stage).toBe(menu.diorama.stage);
  });

  it('names the season that unlocks a car', () => {
    const d = { menu, career } as unknown as MenuData;
    expect(lockLine(d, 'lama', true)).toBe('locked: finish the group 2 season of the career to unlock it.');
    expect(lockLine(d, 'kaze', true)).toBe('locked: finish the group b season of the career to unlock it.');
    expect(lockLine(d, 'swift', false)).toContain('locked livery');
  });
});
