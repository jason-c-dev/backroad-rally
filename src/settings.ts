// The player's settings, kept in the browser (localStorage, one key per section: backroad-rally.<section>).
// One store for everything the settings screen shows (src/menu/settingsPanel.ts): the HUD, the game (camera,
// assists, ghosts), the display (quality, frame-rate limit, render resolution, draw distance) and the audio
// volumes (src/audio/system.ts). Storage can be missing or blocked (private windows, tests): every read and
// write is guarded, and the defaults always work.
//
//   hud      { v: 2, units: 'kmh' | 'mph', speedo: 'number' | 'dial', size: 80..130 (%), debug: boolean }
//   game     { camera: -1 | 0..3, fov: 0 | 30..56, stability: 0..1, countersteer: 0..1, tractionAssist, ghost, rivalGhosts: 0 | 3 | 99 }
//   display  { quality: 'auto' | 'low' | 'medium' | 'high', fpsLimit: 0 | 30 | 60 | 120 | 144, renderScale: 0 | 50..100, drawDistance: -1 | 0..3 }
//   audio    { master, muted, groups: { engine, surface, sfx, ui, music, ambience, crowd, weather } }
//   run      { weather, condition, stage, reverse, car, livery }   (the last picks in the garage and stage select; key J)
//
// The save (best times, unlocks, the career) is separate: src/game/save.ts, key backroad-rally.save.
// URL options override a section for one page load without saving it (?units=mph, ?speedo=dial, ?hud=110);
// changing a setting in the game (the settings screen, keys U, I, T, C, F3, the audio panel) saves it.

const PREFIX = 'backroad-rally.';

/** Read a stored section (null when missing, unreadable or storage is blocked). */
export function readSection<T>(name: string): Partial<T> | null {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + name);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<T>) : null;
  } catch {
    return null;
  }
}

/** Store a section (silently not stored when storage is blocked). */
export function writeSection(name: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + name, JSON.stringify(value));
  } catch {
    // not stored: fine
  }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// ------------------------------------------------------------------ hud

export type SpeedUnits = 'kmh' | 'mph';
export type Speedo = 'number' | 'dial';

export interface HudSettings {
  units: SpeedUnits;
  speedo: Speedo;
  /** HUD size, 80..130 (%), on top of hud.json's own scale. */
  size: number;
  /** The debug frame-time panel (top left; F3). Off for players. */
  debug: boolean;
}

export const HUD_DEFAULTS: HudSettings = { units: 'kmh', speedo: 'number', size: 100, debug: false };
/** Section version: 2 = the debug panel defaults off (v1 saved debug: true with every U or I press). */
const HUD_VERSION = 2;

const clampSize = (n: number) => Math.round(clamp(n, 80, 130));

/** Stored HUD settings over the defaults, then the URL's for this page load. */
export function loadHudSettings(params?: URLSearchParams): HudSettings {
  const s = { ...HUD_DEFAULTS };
  const stored = readSection<HudSettings & { v: number }>('hud');
  if (stored) {
    if (stored.units === 'kmh' || stored.units === 'mph') s.units = stored.units;
    if (stored.speedo === 'number' || stored.speedo === 'dial') s.speedo = stored.speedo;
    if (isNum(stored.size)) s.size = clampSize(stored.size);
    // a v1 section carries the old default (on): only a v2 choice counts
    if (typeof stored.debug === 'boolean' && (stored.v ?? 1) >= HUD_VERSION) s.debug = stored.debug;
  }
  if (params) {
    const u = params.get('units');
    if (u === 'kmh' || u === 'mph') s.units = u;
    const sp = params.get('speedo');
    if (sp === 'number' || sp === 'dial') s.speedo = sp;
    const h = Number(params.get('hud'));
    if (params.has('hud') && h > 0 && Number.isFinite(h)) s.size = clampSize(h); // ?hud=0 hides the overlays instead
  }
  return s;
}

export function saveHudSettings(s: HudSettings): void {
  writeSection('hud', { v: HUD_VERSION, units: s.units, speedo: s.speedo, size: s.size, debug: s.debug });
}

// ------------------------------------------------------------------ game

/**
 * Camera, assists and ghosts (UE FRallySettings). The assists scale the car's own defaults (cars_tuning.json
 * arcade stability_default / countersteer_default), so 100% is the tuned car and the handling tests' car.
 */
export interface GameSettings {
  /** camera.json preset index (near, default, far, top); -1 = the file's default. */
  camera: number;
  /** Vertical field of view (degrees, 30..56); 0 = the preset's own. */
  fov: number;
  stability: number;
  countersteer: number;
  tractionAssist: boolean;
  /** Ghost of the best run (quick stage, time attack): slice 10 draws it. */
  ghost: boolean;
  /** Rival ghosts: 0 off, 3, 99 all (slice 10). */
  rivalGhosts: number;
}

export const GAME_DEFAULTS: GameSettings = { camera: -1, fov: 0, stability: 1, countersteer: 1, tractionAssist: true, ghost: true, rivalGhosts: 3 };

export function loadGameSettings(): GameSettings {
  const s = { ...GAME_DEFAULTS };
  const g = readSection<GameSettings>('game');
  if (g) {
    if (isNum(g.camera)) s.camera = Math.round(clamp(g.camera, -1, 9));
    if (isNum(g.fov)) s.fov = g.fov <= 1 ? 0 : clamp(g.fov, 30, 56);
    if (isNum(g.stability)) s.stability = clamp(g.stability, 0, 1);
    if (isNum(g.countersteer)) s.countersteer = clamp(g.countersteer, 0, 1);
    if (typeof g.tractionAssist === 'boolean') s.tractionAssist = g.tractionAssist;
    if (typeof g.ghost === 'boolean') s.ghost = g.ghost;
    if (g.rivalGhosts === 0 || g.rivalGhosts === 3 || g.rivalGhosts === 99) s.rivalGhosts = g.rivalGhosts;
  }
  return s;
}

export function saveGameSettings(s: GameSettings): void {
  writeSection('game', s);
}

// ------------------------------------------------------------------ display

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';
export const QUALITY_CHOICES: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];
export const FPS_LIMITS = [30, 60, 120, 144, 0] as const;

export interface DisplaySettings {
  /** auto = the adaptive ladder (src/look/autoQuality.ts); the original's "epic" is our high. */
  quality: QualitySetting;
  /** Frame-rate limit (fps); 0 = uncapped (the display's refresh rate). */
  fpsLimit: number;
  /** Render resolution (% of the window); 0 = auto (follows the auto quality ladder, else 100%). */
  renderScale: number;
  /** Draw distance for trees, shrubs and plants: 0 near, 1 medium, 2 far, 3 max; -1 = the default (far). */
  drawDistance: number;
}

export const DISPLAY_DEFAULTS: DisplaySettings = { quality: 'auto', fpsLimit: 60, renderScale: 0, drawDistance: -1 };

export function loadDisplaySettings(): DisplaySettings {
  const s = { ...DISPLAY_DEFAULTS };
  const d = readSection<DisplaySettings>('display');
  if (d) {
    if ((QUALITY_CHOICES as readonly string[]).includes(d.quality as string)) s.quality = d.quality!;
    if ((FPS_LIMITS as readonly number[]).includes(d.fpsLimit as number)) s.fpsLimit = d.fpsLimit!;
    if (isNum(d.renderScale)) s.renderScale = d.renderScale <= 0 ? 0 : Math.round(clamp(d.renderScale, 50, 100) / 5) * 5;
    if (isNum(d.drawDistance)) s.drawDistance = Math.round(clamp(d.drawDistance, -1, 3));
  }
  return s;
}

export function saveDisplaySettings(s: DisplaySettings): void {
  writeSection('display', s);
}

// ------------------------------------------------------------------ audio volumes

/** The mix groups the player can set (src/audio/mix.ts GROUPS, the same list). */
export const VOLUME_GROUPS = ['engine', 'surface', 'sfx', 'ui', 'music', 'ambience', 'crowd', 'weather'] as const;
export type VolumeGroup = (typeof VOLUME_GROUPS)[number];

export interface UserVolumes {
  master: number;
  muted: boolean;
  groups: Record<VolumeGroup, number>;
}

/** The volumes (section 'audio'): the audio system's and the settings screen's. */
export function loadVolumes(): UserVolumes {
  const v: UserVolumes = { master: 0.8, muted: false, groups: Object.fromEntries(VOLUME_GROUPS.map((g) => [g, 1])) as Record<VolumeGroup, number> };
  const s = readSection<UserVolumes>('audio');
  if (s) {
    if (isNum(s.master)) v.master = clamp(s.master, 0, 1);
    if (typeof s.muted === 'boolean') v.muted = s.muted;
    for (const g of VOLUME_GROUPS) if (isNum(s.groups?.[g])) v.groups[g] = clamp(s.groups[g], 0, 1);
  }
  return v;
}

export function saveVolumes(v: UserVolumes): void {
  writeSection('audio', v);
}

// ------------------------------------------------------------------ run (last picks)

/**
 * The last picks of the garage and the stage select (UE URallySettingsSave LastCar / LastStage / ...): the menus
 * start on them. `weather` and `condition` are 'stage' for the stage's own (the stage select's "(default)").
 * ?weather= overrides the weather for one page load; the key J cycles it (and saves it).
 */
export interface RunSettings {
  weather: 'clear' | 'rain' | 'snow' | 'stage';
  condition: string;
  stage: string;
  reverse: boolean;
  car: string;
  livery: number;
}

export const RUN_DEFAULTS: RunSettings = { weather: 'clear', condition: 'stage', stage: '', reverse: false, car: '', livery: 0 };

const WEATHER_CHOICES = ['clear', 'rain', 'snow', 'stage'] as const;
const CONDITION_CHOICES = ['stage', 'morning', 'afternoon', 'sunset', 'night', 'fog'];

export function loadRunSettings(): RunSettings {
  const s = { ...RUN_DEFAULTS };
  const r = readSection<RunSettings>('run');
  if (r) {
    if ((WEATHER_CHOICES as readonly string[]).includes(r.weather as string)) s.weather = r.weather!;
    if (CONDITION_CHOICES.includes(r.condition as string)) s.condition = r.condition!;
    if (typeof r.stage === 'string' && /^[a-z]{1,20}$/.test(r.stage)) s.stage = r.stage;
    if (typeof r.reverse === 'boolean') s.reverse = r.reverse;
    if (typeof r.car === 'string' && /^[a-z]{1,20}$/.test(r.car)) s.car = r.car;
    if (isNum(r.livery)) s.livery = Math.round(clamp(r.livery, 0, 31));
  }
  return s;
}

export function saveRunSettings(s: RunSettings): void {
  writeSection('run', s);
}
