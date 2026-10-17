// The save (UE URallySaveGame): one versioned object in localStorage (backroad-rally.save, through the
// settings store's guarded read and write). It holds what the game earns, not what the player sets:
//
//   best     best total time (penalties included) per mode, stage, direction, car and weather
//            ("quick:finland:fwd:swift:clear"), with the car and the date
//   unlocks  groups, cars and the cars whose bonus livery is unlocked (start: career.json start_groups,
//            start_cars; a finished season adds more: slice 10)
//   career   the career slot (slice 10), null until a career starts
//
// A save that is missing, unreadable, from an older version or damaged loads as the defaults plus whatever
// of it is still valid: a bad save never stops the game. A save from a newer version keeps its known fields.
import { readSection, writeSection } from '../settings';

export const SAVE_VERSION = 1;
const SECTION = 'save';

export type Mode = 'quick' | 'attack' | 'career';

export interface BestEntry {
  /** Total time (s), penalties included. */
  time: number;
  car: string;
  /** ISO date of the run. */
  date: string;
}

export interface Unlocks {
  groups: string[];
  cars: string[];
  /** Cars whose bonus livery (cars/<id>.json liveries[].bonus) is unlocked. */
  liveries: string[];
}

export interface SaveData {
  version: number;
  best: Record<string, BestEntry>;
  unlocks: Unlocks;
  /** The career slot for slice 10 (career.json format, season, rally, stage, results ...). */
  career: Record<string, unknown> | null;
}

/** What a fresh save unlocks (career.json start_groups, start_cars). */
export interface StartUnlocks {
  groups: string[];
  cars: string[];
}

export const DEFAULT_START: StartUnlocks = { groups: ['2'], cars: ['swift', 'pip'] };

export function defaultSave(start: StartUnlocks = DEFAULT_START): SaveData {
  return { version: SAVE_VERSION, best: {}, unlocks: { groups: [...start.groups], cars: [...start.cars], liveries: [] }, career: null };
}

/** The best-time key (UE BestKey by group; the port keys by car, so each car keeps its own best). */
export function bestKey(mode: Mode, stage: string, reverse: boolean, car: string, weather: string): string {
  return `${mode === 'attack' ? 'attack' : mode === 'career' ? 'career' : 'quick'}:${stage}:${reverse ? 'rev' : 'fwd'}:${car}:${weather}`;
}

const KEY_RE = /^(quick|attack|career):[a-z]+:(fwd|rev):[a-z0-9]+:[a-z]+$/;
const ID_RE = /^[a-z0-9]{1,20}$/;
const TIME_CAP = 3599.999;

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))] : [];

function bestEntry(v: unknown, key: string): BestEntry | null {
  // version 0 (a bare number per key) and version 1 ({ time, car, date })
  const o = typeof v === 'number' ? { time: v } : v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o) return null;
  const time = o.time;
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0 || time > TIME_CAP) return null;
  const car = typeof o.car === 'string' && ID_RE.test(o.car) ? o.car : key.split(':')[3];
  const date = typeof o.date === 'string' && o.date.length <= 40 ? o.date : '';
  return { time, car, date };
}

/**
 * Any stored value -> a valid save. Missing or not an object: the defaults. Older versions: migrated (v0 had
 * no version, `bestTimes` as bare numbers and `unlockedCars`). Every field is checked on its own, so one bad
 * field costs only that field. The start unlocks are always kept.
 */
export function migrateSave(raw: unknown, start: StartUnlocks = DEFAULT_START): SaveData {
  const s = defaultSave(start);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 0;
  const bestIn = (version === 0 ? o.bestTimes ?? o.best : o.best) as unknown;
  if (bestIn && typeof bestIn === 'object' && !Array.isArray(bestIn)) {
    for (const [k, v] of Object.entries(bestIn as Record<string, unknown>)) {
      if (!KEY_RE.test(k)) continue;
      const e = bestEntry(v, k);
      if (e) s.best[k] = e;
    }
  }
  const u = (version === 0 ? { groups: o.unlockedGroups, cars: o.unlockedCars, liveries: o.bonusLiveries } : o.unlocks) as Record<string, unknown> | undefined;
  if (u && typeof u === 'object') {
    s.unlocks.groups = [...new Set([...s.unlocks.groups, ...ids(u.groups)])];
    s.unlocks.cars = [...new Set([...s.unlocks.cars, ...ids(u.cars)])];
    s.unlocks.liveries = ids(u.liveries);
  }
  if (o.career && typeof o.career === 'object' && !Array.isArray(o.career)) s.career = o.career as Record<string, unknown>;
  // a newer version's save is read as far as this version understands it, and written back as this version
  return s;
}

export function loadSave(start: StartUnlocks = DEFAULT_START): SaveData {
  return migrateSave(readSection<SaveData>(SECTION), start);
}

export function writeSave(s: SaveData): void {
  writeSection(SECTION, { ...s, version: SAVE_VERSION });
}

/** Record a finished run; returns the previous best (0 = none) and whether this one is the new best. */
export function recordBest(s: SaveData, key: string, time: number, car: string, date = new Date().toISOString().slice(0, 10)): { prev: number; newBest: boolean } {
  const prev = s.best[key]?.time ?? 0;
  const newBest = Number.isFinite(time) && time > 0 && (prev <= 0 || time < prev);
  if (newBest) s.best[key] = { time: Math.min(time, TIME_CAP), car, date };
  return { prev, newBest };
}

export const isCarUnlocked = (s: SaveData, car: string): boolean => s.unlocks.cars.includes(car);

/** A livery is locked only when it is the car's bonus livery and that car's bonus isn't unlocked. */
export const isLiveryUnlocked = (s: SaveData, car: string, bonus: boolean): boolean => !bonus || s.unlocks.liveries.includes(car);

/** Development (?unlockall): every car and bonus livery. */
export function unlockAll(s: SaveData, cars: string[], groups: string[]): void {
  s.unlocks.cars = [...new Set([...s.unlocks.cars, ...cars])];
  s.unlocks.groups = [...new Set([...s.unlocks.groups, ...groups])];
  s.unlocks.liveries = [...new Set([...s.unlocks.liveries, ...cars])];
}
