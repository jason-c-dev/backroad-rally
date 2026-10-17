// The audio hub (UE URallyAudioSubsystem): one AudioContext, a GainNode per mix group under a master,
// the user's volumes (localStorage), the decoded sounds, looping voices and one-shots.
// Browser rules: the context is made suspended and resumes on the first key or click; M mutes; the
// context suspends while the tab is hidden.
import { GROUPS, attenuate, clamp, groupGain, voiceGain, type Attenuation, type Group, type MixJson } from './mix';

export interface SoundEntry {
  kind: 'engine' | 'sfx' | 'ui';
  loop: boolean;
  ch: number;
  dur: number;
  db: number;
  lufs: number | null;
  /** Loop window inside the padded file (s). */
  ls?: number;
  le?: number;
  car?: string;
  ref_rpm?: number;
  layer?: 'on' | 'off';
  idle?: boolean;
  location?: string;
}

export interface MusicEntry {
  title: string;
  tags: string[];
  dur: number;
  db: number;
  /** Integrated loudness of the track (LUFS), measured by the converter. */
  lufs: number | null;
}

export interface AudioManifest {
  pad: number;
  sounds: Record<string, SoundEntry>;
  music: Record<string, MusicEntry>;
}

export { loadVolumes, saveVolumes, type UserVolumes } from '../settings';
import { loadVolumes, saveVolumes, type UserVolumes } from '../settings';

/** Where the listener is (on the car, like UE's listener override) and which way is right on screen. */
export interface Listener {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

export interface PlayOpts {
  /** World position (three metres) for a 3D one-shot: distance attenuation and pan from the listener. */
  pos?: { x: number; y: number; z: number };
  att?: Attenuation;
  /** Audio-clock start time (default now). */
  when?: number;
}

/**
 * Make a decoded loop window [a, b) wrap without a step. The file carries the loop's own tail before a
 * (tools/convert/audio.mjs pads it), so the k samples before b and the k before a are the same source
 * samples with different coding error; crossfading the first into the second makes sample b-1 the
 * sample just before a, and the wrap b-1 -> a is as smooth as anywhere else in the loop.
 */
export function sealLoop(d: Float32Array, a: number, b: number, k = 256): void {
  const n = Math.min(k, a, b - a);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    d[b - n + i] = d[b - n + i] * (1 - t) + d[a - n + i] * t;
  }
}

const SMOOTH = 0.015; // s: time constant of per-frame gain and rate changes (no zipper noise)

export class AudioSystem {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  /** A safety limiter after the master: only peaks above -2 dBFS (backfires over a loud mix) touch it. */
  readonly out: DynamicsCompressorNode;
  readonly groups = {} as Record<Group, GainNode>;
  readonly buffers = new Map<string, AudioBuffer>();
  readonly volumes: UserVolumes;
  format: 'opus' | 'm4a';
  readonly listener: Listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  hidden = false;
  private oneShots = 0;
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  onUnlock: (() => void) | null = null;

  constructor(readonly manifest: AudioManifest, readonly mix: MixJson, readonly base: string, opts: { sampleRate?: number } = {}) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive', ...(opts.sampleRate ? { sampleRate: opts.sampleRate } : {}) });
    this.master = this.ctx.createGain();
    this.out = this.ctx.createDynamicsCompressor();
    this.out.threshold.value = -2;
    this.out.knee.value = 0;
    this.out.ratio.value = 20;
    this.out.attack.value = 0.001;
    this.out.release.value = 0.1;
    this.master.connect(this.out).connect(this.ctx.destination);
    for (const g of GROUPS) {
      const n = this.ctx.createGain();
      n.connect(this.master);
      this.groups[g] = n;
    }
    this.volumes = loadVolumes();
    const probe = document.createElement('audio');
    this.format = probe.canPlayType('audio/ogg; codecs="opus"') ? 'opus' : 'm4a';
    this.applyVolumes(true);
    document.addEventListener('visibilitychange', () => this.setHidden(document.hidden));
    // the browser may also start it without our gesture (autoplay allowed for the site)
    this.ctx.addEventListener('statechange', () => {
      if (this.ctx.state === 'running' && !this.hidden) {
        this.wasRunning = true;
        this.onUnlock?.();
      }
    });
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Resume on a user gesture (call from a key or pointer handler). */
  unlock(): void {
    if (this.hidden || this.ctx.state === 'closed') return;
    void this.ctx.resume().then(() => {
      this.wasRunning = true;
      this.onUnlock?.();
    });
  }

  private setHidden(h: boolean): void {
    this.hidden = h;
    if (h) void this.ctx.suspend();
    else if (this.unlockedOnce) void this.ctx.resume();
  }

  get unlockedOnce(): boolean {
    return this.wasRunning || this.ctx.state === 'running';
  }
  wasRunning = false;

  groupGain(g: Group): number {
    return groupGain(this.mix, g, this.volumes.groups[g]);
  }

  /**
   * The weather's muffling (snow: 3500 Hz on crowd, sfx and surface): a one-pole low-pass after each listed
   * group, like the original's per-sound low-pass filter (UE FInterpolatedLPF: b1 = exp(-2 pi fc / fs)).
   */
  setMuffle(hz: number, groups: readonly string[]): void {
    for (const [g, f] of this.muffles) {
      this.groups[g].disconnect(f);
      f.disconnect();
      this.groups[g].connect(this.master);
    }
    this.muffles.clear();
    if (!(hz > 0)) return;
    const b1 = Math.exp((-2 * Math.PI * Math.min(hz, this.ctx.sampleRate / 2)) / this.ctx.sampleRate);
    for (const g of groups) {
      if (!(GROUPS as readonly string[]).includes(g)) continue;
      const f = this.ctx.createIIRFilter([1 - b1], [1, -b1]);
      const node = this.groups[g as Group];
      node.disconnect(this.master);
      node.connect(f).connect(this.master);
      this.muffles.set(g as Group, f);
    }
  }
  readonly muffles = new Map<Group, IIRFilterNode>();

  /** The game is paused (src/main.ts): every group but ui and music is silent. */
  paused = false;
  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    this.applyVolumes();
  }
  /** Push the user's volumes to the group and master nodes (and save them). */
  applyVolumes(instant = false, save = false): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => (instant ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, 0.03));
    // paused: only the interface and the music keep sounding (UE SetPause; the UI sounds play while paused)
    for (const g of GROUPS) set(this.groups[g].gain, this.paused && g !== 'ui' && g !== 'music' ? 0 : this.groupGain(g));
    set(this.master.gain, this.volumes.muted ? 0 : this.volumes.master * (this.mix.master ?? 1));
    if (save) saveVolumes(this.volumes);
  }

  url(name: string, ext: string): string {
    return `${this.base}audio/${name}.${ext}`;
  }

  /** Fetch and decode one sound (Opus, or AAC when this browser can't decode Opus). */
  load(name: string): Promise<AudioBuffer | null> {
    let p = this.loading.get(name);
    if (p) return p;
    p = (async () => {
      if (!this.manifest.sounds[name]) return null;
      for (const ext of this.format === 'opus' ? ['opus', 'm4a'] : ['m4a']) {
        try {
          const r = await fetch(this.url(name, ext));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
          const e = this.manifest.sounds[name];
          if (e.loop && e.ls !== undefined && e.le !== undefined) {
            for (let c = 0; c < buf.numberOfChannels; c++) sealLoop(buf.getChannelData(c), Math.round(e.ls * buf.sampleRate), Math.round(e.le * buf.sampleRate));
          }
          this.buffers.set(name, buf);
          return buf;
        } catch (e) {
          if (ext === 'opus') {
            console.warn(`audio: ${name}.opus didn't decode (${String(e)}); using AAC`);
            this.format = 'm4a';
          } else console.warn(`audio: ${name}: ${String(e)}`);
        }
      }
      return null;
    })();
    this.loading.set(name, p);
    return p;
  }

  loadAll(names: Iterable<string>): Promise<unknown> {
    return Promise.all([...new Set(names)].map((n) => this.load(n)));
  }

  /** Members of a family: A_Crowd_Cheer -> A_Crowd_Cheer_01..n (loops left out). */
  family(prefix: string): string[] {
    const out = Object.keys(this.manifest.sounds).filter((k) => k.startsWith(`${prefix}_`) && !k.endsWith('_Loop'));
    return out.length ? out : this.manifest.sounds[prefix] ? [prefix] : [];
  }

  loop(name: string, group: Group, opts: { detune?: AudioNode; out?: AudioNode } = {}): Loop {
    return new Loop(this, name, group, opts.out ?? this.groups[group], opts.detune);
  }

  /** Gain and pan for a 3D source at pos (relative to the listener). */
  spatial(pos: { x: number; y: number; z: number }, att: Attenuation): { gain: number; pan: number; dist: number } {
    const L = this.listener;
    const dx = pos.x - L.x;
    const dy = pos.y - L.y;
    const dz = pos.z - L.z;
    const dist = Math.hypot(dx, dy, dz);
    const flat = Math.hypot(dx, dz) || 1;
    return { gain: attenuate(dist, att), pan: clamp(((dx * L.rx + dz * L.rz) / flat) * 0.7, -0.7, 0.7), dist };
  }

  /** A one-shot: level x volume_db on its group (clamped to max_volume), optionally 3D. */
  play(name: string, group: Group, level: number, pitch = 1, opts: PlayOpts = {}): AudioBufferSourceNode | null {
    const buf = this.buffers.get(name);
    const e = this.manifest.sounds[name];
    if (!buf || !e || level <= 0 || !this.running || this.oneShots >= 32) return null;
    let gain = voiceGain(level, e.db, this.groupGain(group), this.mix.max_volume ?? 3.5);
    let pan = 0;
    if (opts.pos) {
      const s = this.spatial(opts.pos, opts.att ?? this.mix.attenuation.world);
      gain *= s.gain;
      pan = s.pan;
    }
    if (gain <= (this.mix.silence ?? 0.003)) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clamp(pitch, 0.2, 4);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.groups[group]);
    } else g.connect(this.groups[group]);
    this.oneShots++;
    src.onended = () => {
      this.oneShots--;
      g.disconnect();
    };
    src.start(opts.when ?? 0);
    return src;
  }

  playRandom(prefix: string, group: Group, level: number, pitch = 1, opts: PlayOpts = {}): AudioBufferSourceNode | null {
    const f = this.family(prefix);
    return f.length ? this.play(f[Math.floor(Math.random() * f.length)], group, level, pitch, opts) : null;
  }
}

/**
 * A looping voice (UE MakeLoop / SetLoop): set(level, pitch) every frame; it stops after 0.25 s below
 * the silence floor and restarts somewhere inside the loop when it is heard again, so layers that
 * start together don't phase.
 */
export class Loop {
  readonly entry: SoundEntry | undefined;
  readonly gain: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private silentFor = 0;
  /** Last voice gain set (for the level readout). */
  level = 0;

  constructor(readonly sys: AudioSystem, readonly name: string, readonly group: Group, out: AudioNode, readonly detune?: AudioNode) {
    this.entry = sys.manifest.sounds[name];
    this.gain = sys.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);
  }

  get playing(): boolean {
    return !!this.src;
  }

  set(level: number, pitch: number, dt: number, smoothing = SMOOTH): void {
    const sys = this.sys;
    const e = this.entry;
    const buf = sys.buffers.get(this.name);
    if (!e || !buf) return;
    const gu = sys.groupGain(this.group);
    const v = voiceGain(level, e.db, gu, sys.mix.max_volume ?? 3.5);
    const t = sys.ctx.currentTime;
    this.level = v;
    if (v * Math.max(gu, 1e-3) <= (sys.mix.silence ?? 0.003) || !sys.running) {
      this.silentFor += dt;
      this.gain.gain.setTargetAtTime(0, t, smoothing);
      // stop once the fade has run out (5 time constants), at least 0.25 s like UE
      if (this.src && this.silentFor > Math.max(0.25, smoothing * 5)) this.stop();
      return;
    }
    this.silentFor = 0;
    if (!this.src) {
      const src = sys.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const ls = e.ls ?? 0;
      const le = e.le ?? buf.duration;
      src.loopStart = ls;
      src.loopEnd = le;
      src.playbackRate.value = clamp(pitch, 0.2, 4);
      src.connect(this.gain);
      if (this.detune) this.detune.connect(src.detune);
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(0, t);
      src.start(t, ls + Math.random() * (le - ls) * 0.9);
      this.src = src;
    }
    this.gain.gain.setTargetAtTime(v, t, smoothing);
    this.src.playbackRate.setTargetAtTime(clamp(pitch, 0.2, 4), t, smoothing);
  }

  stop(): void {
    if (!this.src) return;
    try {
      this.src.stop();
    } catch {
      // already stopped
    }
    this.src.disconnect();
    if (this.detune) {
      try {
        this.detune.disconnect(this.src.detune);
      } catch {
        // not connected
      }
    }
    this.src = null;
  }

  dispose(): void {
    this.stop();
    this.gain.disconnect();
  }
}
