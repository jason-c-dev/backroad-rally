// Music (UE StartPlaylist / PlayNextMusic): streamed through one <audio> element and a
// MediaElementAudioSourceNode on the music group, never decoded whole. Playlists from the manifest
// tags (location ids, and the moods menu / stage / calm / night). Skip with . and , (next, previous).
import { clamp, dbToLin, voiceGain } from './mix';
import type { AudioSystem, MusicEntry } from './system';

const MOODS = new Set(['menu', 'night', 'stage', 'calm']);

/** The in-stage playlist: a day stage plays its location's `mood` tracks, a night stage its location's night tracks plus location-free night tracks. */
export function stagePlaylist(music: Record<string, MusicEntry>, location: string, night: boolean, mood = 'stage'): string[] {
  const loc = location.toLowerCase();
  const tracks = (f: (tags: string[]) => boolean) => Object.keys(music).filter((k) => f(music[k].tags.map((t) => t.toLowerCase()))).sort();
  const otherLocation = (tags: string[]) => tags.some((t) => !MOODS.has(t) && t !== loc);
  let list: string[] = [];
  if (night && tracks((t) => t.includes('night') && t.includes(loc)).length) {
    list = tracks((t) => t.includes('night') && !otherLocation(t) && !t.includes('menu'));
  }
  if (!list.length && loc) list = tracks((t) => t.includes(loc) && t.includes(mood) && !t.includes('night'));
  if (!list.length && loc) list = tracks((t) => t.includes(loc) && !t.includes('night'));
  if (!list.length && loc) list = tracks((t) => t.includes(loc));
  if (!list.length) list = tracks(() => true);
  return list;
}

/** The menu playlist: tracks with any of `tags` (menu + calm), never stage or night tracks. */
export function menuPlaylist(music: Record<string, MusicEntry>, tags: string[]): string[] {
  return Object.keys(music).filter((k) => {
    const t = music[k].tags;
    return !t.includes('night') && !t.includes('stage') && t.some((x) => tags.includes(x));
  }).sort();
}

export class MusicPlayer {
  readonly el: HTMLAudioElement;
  private readonly fade: GainNode;
  private readonly gain: GainNode;
  playlist: string[] = [];
  index = -1;
  /** Volume key multiplier (stage.music_volume or menu.music_volume) and the duck (dB, >= 0). */
  volume = 1;
  duckDb = 0;
  onTrack: ((title: string) => void) | null = null;
  wantPlay = false;
  readonly available: boolean;

  constructor(readonly sys: AudioSystem) {
    const ctx = sys.ctx;
    this.el = document.createElement('audio');
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    // Ogg Opus only (no AAC copy of the music, to keep the site lean): browsers without Opus play no music
    this.available = !!this.el.canPlayType('audio/ogg; codecs="opus"');
    this.fade = ctx.createGain();
    this.gain = ctx.createGain();
    ctx.createMediaElementSource(this.el).connect(this.fade).connect(this.gain).connect(sys.groups.music);
    this.el.addEventListener('ended', () => this.step(1));
    this.el.addEventListener('error', () => {
      if (this.wantPlay) setTimeout(() => this.step(1), 1000);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.el.pause();
      else if (this.wantPlay && sys.running) void this.el.play().catch(() => {});
    });
  }

  get title(): string {
    const n = this.playlist[this.index];
    return n ? this.sys.manifest.music[n]?.title ?? n : '';
  }

  setPlaylist(list: string[]): void {
    if (list.join() === this.playlist.join()) return;
    this.playlist = list;
    this.index = list.length ? Math.floor(Math.random() * list.length) - 1 : -1;
    if (this.wantPlay) this.step(1);
  }

  start(): void {
    if (!this.available || this.wantPlay) return;
    this.wantPlay = true;
    this.step(1);
  }

  /** Next (+1) or previous (-1) track, with a 2 s fade-in. */
  step(dir: 1 | -1): void {
    if (!this.available || !this.playlist.length) return;
    this.wantPlay = true;
    const n = this.playlist.length;
    this.index = (((this.index + dir) % n) + n) % n;
    const name = this.playlist[this.index];
    this.el.src = this.sys.url(name, 'opus');
    const t = this.sys.ctx.currentTime;
    this.fade.gain.cancelScheduledValues(t);
    this.fade.gain.setValueAtTime(0, t);
    this.fade.gain.linearRampToValueAtTime(1, t + 2);
    void this.el.play().catch(() => {
      // not allowed yet (no gesture): the unlock handler calls start() again
      this.wantPlay = false;
    });
    this.onTrack?.(this.title);
  }

  /** Per frame: volume x the duck on the music group (UE clamps the music at 4, not max_volume). */
  update(): void {
    const name = this.playlist[this.index];
    const db = name ? this.sys.manifest.music[name]?.db ?? 0 : 0;
    const v = voiceGain(this.volume * dbToLin(-this.duckDb), db, this.sys.groupGain('music'), 4);
    this.gain.gain.setTargetAtTime(clamp(v, 0, 4), this.sys.ctx.currentTime, 0.05);
  }

  /** Current voice gain (for the level readout). */
  get level(): number {
    return this.gain.gain.value * this.fade.gain.value;
  }

  /** Integrated loudness of the playing track (LUFS) and the dB its path adds now (voice x fade x group). */
  get trackLoudness(): { lufs: number; gainDb: number } | null {
    const e = this.sys.manifest.music[this.playlist[this.index]];
    const g = this.level * this.sys.groupGain('music');
    return e?.lufs != null && g > 0 && !this.el.paused ? { lufs: e.lufs, gainDb: 20 * Math.log10(g) } : null;
  }
}
