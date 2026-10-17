// Page flow. The game is two kinds of page load: the menus (title, garage, stage select ...) over the live
// diorama, and a stage run. Going from one to the other is a fresh page load (the stage switch of slice 7):
// the old stage's GPU buffers, colliders and sounds all go with the page, so nothing has to be freed by hand.
//
//   menu   no stage options in the URL (the default page load), or ?menu=<screen>
//   play   ?mode=quick|attack&stage=..&dir=..&car=..&livery=..&cond=..&weather=..   (from the stage select)
//   dev    ?stage=, ?car= or ?autopilot= without ?mode: straight into the stage, as before the menus
//
// What the menus need across a page load (the screen to open, the picks, the music track) goes in
// sessionStorage, never in the save.

export type PlayMode = 'quick' | 'attack';

export interface PlaySetup {
  mode: PlayMode;
  stage: string;
  reverse: boolean;
  car: string;
  livery: number;
  /** 'stage' = the stage's own for the direction. */
  cond: string;
  weather: string;
}

/** Development and check options kept when the page moves between the menus and a stage. */
const STICKY = ['webgl', 'gputime', 'audio', 'quality', 'scale', 'upscale', 'post', 'fx', 'crowd', 'draw', 'unlockall', 'fps'];

export type PageKind = 'menu' | 'play' | 'dev';

export function pageKind(p: URLSearchParams): PageKind {
  if (p.has('menu')) return 'menu';
  if (p.get('mode') === 'quick' || p.get('mode') === 'attack') return 'play';
  if (p.has('stage') || p.has('car') || p.has('autopilot') || p.has('dir')) return 'dev';
  return 'menu';
}

const ID = /^[a-z]{1,20}$/;

/** The run a ?mode= page drives (null when the URL isn't one). */
export function parsePlay(p: URLSearchParams): PlaySetup | null {
  const mode = p.get('mode');
  if (mode !== 'quick' && mode !== 'attack') return null;
  const stage = p.get('stage') ?? 'finland';
  const car = p.get('car') ?? 'swift';
  return {
    mode,
    stage: ID.test(stage) ? stage : 'finland',
    reverse: p.get('dir') === 'reverse',
    car: ID.test(car) ? car : 'swift',
    livery: Math.max(0, Math.min(31, Math.round(Number(p.get('livery') ?? 0) || 0))),
    cond: p.get('cond') ?? 'stage',
    weather: p.get('weather') ?? 'stage',
  };
}

function sticky(from: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of STICKY) {
    const v = from.get(k);
    if (v !== null) q.set(k, v);
  }
  return q;
}

/** The query (with its "?") of a stage run. */
export function playQuery(s: PlaySetup, from: URLSearchParams = new URLSearchParams()): string {
  const q = new URLSearchParams({ mode: s.mode, stage: s.stage });
  if (s.reverse) q.set('dir', 'reverse');
  q.set('car', s.car);
  if (s.livery) q.set('livery', String(s.livery));
  q.set('cond', s.cond);
  q.set('weather', s.weather);
  for (const [k, v] of sticky(from)) q.set(k, v);
  return `?${q}`;
}

/** The query of the menus ('' when no option is kept). */
export function menuQuery(from: URLSearchParams = new URLSearchParams()): string {
  const q = sticky(from).toString();
  return q ? `?${q}` : '';
}

// ------------------------------------------------------------------ state across page loads

/** What the menus pick up after a page load: the screen and the picks (stage select, garage). */
export interface MenuState {
  screen: string;
  flow: PlayMode | 'career';
  car?: string;
  livery?: number;
  stage?: string;
  reverse?: boolean;
  cond?: string;
  weather?: string;
  /** The settings screen's return screen and page. */
  settingsReturn?: string;
  /** Focused row index on the screen (a backdrop swap reloads the page mid-scroll). */
  focus?: number;
}

const KEY = 'backroad-rally.nav';
const MUSIC_KEY = 'backroad-rally.music';

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function putMenuState(s: MenuState): void {
  try {
    session()?.setItem(KEY, JSON.stringify(s));
  } catch {
    // fine: the menus open on the title
  }
}

/** The state left by the last page (read once: cleared). */
export function takeMenuState(): MenuState | null {
  try {
    const st = session();
    const raw = st?.getItem(KEY);
    st?.removeItem(KEY);
    const v = raw ? (JSON.parse(raw) as MenuState) : null;
    return v && typeof v === 'object' && typeof v.screen === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The menu music's track and position, so a backdrop swap (a page load) doesn't restart the song. */
export interface MusicResume {
  track: string;
  time: number;
}

export function putMusic(m: MusicResume | null): void {
  try {
    if (m) session()?.setItem(MUSIC_KEY, JSON.stringify(m));
    else session()?.removeItem(MUSIC_KEY);
  } catch {
    // fine
  }
}

export function takeMusic(): MusicResume | null {
  try {
    const st = session();
    const raw = st?.getItem(MUSIC_KEY);
    st?.removeItem(MUSIC_KEY);
    const v = raw ? (JSON.parse(raw) as MusicResume) : null;
    return v && typeof v.track === 'string' && typeof v.time === 'number' ? v : null;
  } catch {
    return null;
  }
}
