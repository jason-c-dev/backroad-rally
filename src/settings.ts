// The player's settings, kept in the browser (localStorage, one key per section: backroad-rally.<section>).
// One store for everything the settings screen (slice 9) will show: the audio volumes (src/audio/system.ts)
// and the HUD options here. Storage can be missing or blocked (private windows, tests): every read and
// write is guarded, and the defaults always work.
//
//   hud    { units: 'kmh' | 'mph', speedo: 'number' | 'dial', size: 80..130 (%), debug: boolean }
//   audio  { master, muted, groups: { engine, surface, sfx, ui, music, ambience, crowd, weather } }
//
// URL options override a section for one page load without saving it (?units=mph, ?speedo=dial, ?hud=110);
// changing a setting in the game (keys U and I, the audio panel) saves it.

const PREFIX = 'backroad-rally.';

/** Read a stored section (null when missing, unreadable or storage is blocked). */
export function readSection<T>(name: string): Partial<T> | null {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + name);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Partial<T>) : null;
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

export type SpeedUnits = 'kmh' | 'mph';
export type Speedo = 'number' | 'dial';

export interface HudSettings {
  units: SpeedUnits;
  speedo: Speedo;
  /** HUD size, 80..130 (%), on top of hud.json's own scale. */
  size: number;
  /** The debug frame-time panel (top left; F3). */
  debug: boolean;
}

export const HUD_DEFAULTS: HudSettings = { units: 'kmh', speedo: 'number', size: 100, debug: true };

const clampSize = (n: number) => Math.round(Math.min(Math.max(n, 80), 130));

/** Stored HUD settings over the defaults, then the URL's for this page load. */
export function loadHudSettings(params?: URLSearchParams): HudSettings {
  const s = { ...HUD_DEFAULTS };
  const stored = readSection<HudSettings>('hud');
  if (stored) {
    if (stored.units === 'kmh' || stored.units === 'mph') s.units = stored.units;
    if (stored.speedo === 'number' || stored.speedo === 'dial') s.speedo = stored.speedo;
    if (typeof stored.size === 'number' && Number.isFinite(stored.size)) s.size = clampSize(stored.size);
    if (typeof stored.debug === 'boolean') s.debug = stored.debug;
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
  writeSection('hud', s);
}
