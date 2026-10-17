// The save (src/game/save.ts): load, save, migrate, and damaged saves that must never stop the game.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_VERSION, bestKey, defaultSave, isCarUnlocked, isLiveryUnlocked, loadSave, migrateSave, recordBest, unlockAll, writeSave } from '../src/game/save';

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

const START = { groups: ['2'], cars: ['swift', 'pip'] };
const KEY = 'backroad-rally.save';

describe('save', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with the career start unlocks and no best times', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const s = loadSave(START);
    expect(s).toEqual(defaultSave(START));
    expect(s.version).toBe(SAVE_VERSION);
    expect(isCarUnlocked(s, 'swift')).toBe(true);
    expect(isCarUnlocked(s, 'lama')).toBe(false);
    expect(s.career).toBeNull();
  });

  it('keeps a best time per mode, stage, direction, car and weather', () => {
    const st = fakeStorage();
    vi.stubGlobal('localStorage', st);
    const s = loadSave(START);
    const k = bestKey('quick', 'finland', false, 'swift', 'clear');
    expect(k).toBe('quick:finland:fwd:swift:clear');
    expect(bestKey('attack', 'wales', true, 'pip', 'rain')).toBe('attack:wales:rev:pip:rain');
    expect(recordBest(s, k, 112.5, 'swift', '2026-10-16')).toEqual({ prev: 0, newBest: true });
    expect(recordBest(s, k, 113, 'swift')).toEqual({ prev: 112.5, newBest: false });
    expect(recordBest(s, k, 110.25, 'swift', '2026-10-17')).toEqual({ prev: 112.5, newBest: true });
    writeSave(s);
    const back = loadSave(START);
    expect(back.best[k]).toEqual({ time: 110.25, car: 'swift', date: '2026-10-17' });
    expect(JSON.parse(st.map.get(KEY)!).version).toBe(SAVE_VERSION);
  });

  it('falls back to the defaults for a missing, unreadable or damaged save', () => {
    const st = fakeStorage();
    vi.stubGlobal('localStorage', st);
    st.map.set(KEY, '{not json');
    expect(loadSave(START)).toEqual(defaultSave(START));
    st.map.set(KEY, '[1,2,3]');
    expect(loadSave(START)).toEqual(defaultSave(START));
    st.map.set(KEY, 'null');
    expect(loadSave(START)).toEqual(defaultSave(START));
    vi.stubGlobal('localStorage', fakeStorage(true));
    expect(loadSave(START)).toEqual(defaultSave(START));
    expect(() => writeSave(defaultSave(START))).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(loadSave(START)).toEqual(defaultSave(START));
  });

  it('keeps the valid part of a damaged save and drops the rest', () => {
    const s = migrateSave({
      version: 1,
      best: {
        'quick:finland:fwd:swift:clear': { time: 111, car: 'swift', date: '2026-10-16' },
        'quick:finland:fwd:pip:clear': { time: -4, car: 'pip' }, // impossible time
        'quick:japan:rev:kaze:snow': { time: 'fast' }, // wrong type
        'not a key': { time: 100, car: 'swift' },
        'attack:alps:fwd:quint:snow': { time: 200 }, // the car comes from the key
      },
      unlocks: { groups: ['4', 7, null], cars: ['lama', '../../etc', 'lama'], liveries: 'all' },
      career: [1, 2],
    }, START);
    expect(Object.keys(s.best).sort()).toEqual(['attack:alps:fwd:quint:snow', 'quick:finland:fwd:swift:clear']);
    expect(s.best['attack:alps:fwd:quint:snow']).toEqual({ time: 200, car: 'quint', date: '' });
    expect(s.unlocks.groups).toEqual(['2', '4']);
    expect(s.unlocks.cars).toEqual(['swift', 'pip', 'lama']);
    expect(s.unlocks.liveries).toEqual([]);
    expect(s.career).toBeNull();
  });

  it('migrates a version 0 save (bare numbers, unlockedCars) and reads a newer version as far as it can', () => {
    const v0 = migrateSave({ bestTimes: { 'quick:wales:fwd:pip:rain': 130.5 }, unlockedCars: ['quint'], bonusLiveries: ['swift'] }, START);
    expect(v0.version).toBe(SAVE_VERSION);
    expect(v0.best['quick:wales:fwd:pip:rain']).toEqual({ time: 130.5, car: 'pip', date: '' });
    expect(v0.unlocks.cars).toEqual(['swift', 'pip', 'quint']);
    expect(v0.unlocks.liveries).toEqual(['swift']);
    const future = migrateSave({ version: 9, best: { 'quick:japan:fwd:kaze:clear': { time: 99, car: 'kaze', date: 'x' } }, newThing: {}, career: { season: 2 } }, START);
    expect(future.version).toBe(SAVE_VERSION);
    expect(future.best['quick:japan:fwd:kaze:clear'].time).toBe(99);
    expect(future.career).toEqual({ season: 2 });
  });

  it('locks only bonus liveries until their car is unlocked; unlockAll opens everything', () => {
    const s = defaultSave(START);
    expect(isLiveryUnlocked(s, 'swift', false)).toBe(true);
    expect(isLiveryUnlocked(s, 'swift', true)).toBe(false);
    unlockAll(s, ['swift', 'pip', 'lama', 'quint', 'kaze'], ['2', '4', 'b', 'a']);
    expect(isCarUnlocked(s, 'kaze')).toBe(true);
    expect(isLiveryUnlocked(s, 'swift', true)).toBe(true);
    expect(s.unlocks.groups).toEqual(['2', '4', 'b', 'a']);
  });
});
