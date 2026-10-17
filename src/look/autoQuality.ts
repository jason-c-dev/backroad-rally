// Adaptive quality (?quality=auto, the default): start from a guess based on the GPU and the screen (or what the
// last visit settled on), then watch real frame times (and the GPU timer where the browser has one).
//
// Two phases, because a tier change rebuilds shaders and shadow maps (a hitch of 0.1-2 s) and a canvas resize
// clears the picture:
// - **settling**, behind the loading curtain: walk the ladder of tiers and render scales until the stage holds
//   60 fps; the curtain waits for `settled`. The player never sees a step.
// - **play**, once the curtain lifts: only the render scale moves (a canvas resize, no shader to build), down on
//   sustained misses and up with clear GPU headroom; the tier stays.
// Pure logic: the caller feeds it frames and applies what it returns.

/** One rung: a quality tier and a render scale (1 = native pixels). Index 0 is the best. */
export interface Rung {
  tier: string;
  scale: number;
}

export const LADDER: Rung[] = [
  { tier: 'high', scale: 1 },
  { tier: 'medium', scale: 1 },
  { tier: 'low', scale: 1 },
  { tier: 'low', scale: 0.85 },
  { tier: 'low', scale: 0.7 },
  { tier: 'low', scale: 0.55 },
];

/** The render scales play may move between (any tier). */
export const SCALES = [1, 0.85, 0.7, 0.55];

export interface AutoOptions {
  /** Frame time that counts as a miss (ms): above one 60 Hz interval with some slack. */
  missMs: number;
  /**
   * Settling (behind the curtain): window length (s), the quiet time at the start and after each change (s), how
   * many clean windows in a row (missed share under settleClean) settle it, and how many marginal ones in a row (between
   * settleClean and missShare) step down anyway: a rung that only just holds behind the curtain would have to shrink
   * its render scale in play.
   */
  settleWindow: number;
  settleQuiet: number;
  settleGood: number;
  settleClean: number;
  settleMarginal: number;
  /**
   * Where the browser has a GPU timer, a clean settling window also needs its GPU time's 90th percentile under this
   * share of the frame interval: the curtain shows the start line, and driving costs more than that view (an
   * integrated GPU at 15 ms on the start line ran 21-27 ms in the forest).
   */
  settleGpuShare: number;
  /** During play: window (s), and how many bad windows in a row step down. */
  playWindow: number;
  badWindows: number;
  /** A window is bad if more than this share of its time went to missed frames (a 1 s spike isn't). */
  missShare: number;
  /** After a change in play, ignore this long (s). */
  cooldown: number;
  /** Step up only if the GPU time's 90th percentile stayed under this (ms) for upFor seconds (play: scale only). */
  upGpuMs: number;
  upFor: number;
}

export const AUTO_DEFAULTS: AutoOptions = {
  missMs: 20, settleWindow: 0.75, settleQuiet: 0.5, settleGood: 2, settleClean: 0.1, settleMarginal: 2, settleGpuShare: 0.75, playWindow: 3, badWindows: 2,
  missShare: 0.33, cooldown: 2.5, upGpuMs: 8.5, upFor: 20,
};

/**
 * The first guess from the renderer string (WEBGL_debug_renderer_info or the WebGPU adapter info)
 * and the drawn pixels: discrete GPUs start high (medium above ~1440p), integrated and unknown ones
 * lower, software rasterizers at the bottom.
 */
export function initialRung(gpu: string, pixels: number): number {
  const big = pixels > 2560 * 1440 * 1.1;
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) return LADDER.length - 1;
  if (/nvidia|geforce|quadro|rtx|radeon rx|radeon pro|arc\(tm\) a\d|arc a\d/i.test(gpu)) return big ? 1 : 0;
  if (/intel|iris|uhd|apple|mali|adreno|powervr|radeon\(tm\)|vega \d+ graphics/i.test(gpu)) return big ? 4 : 2;
  return big ? 2 : 1;
}

const name = (r: Rung) => `${r.tier}${r.scale < 1 ? `@${Math.round(r.scale * 100)}%` : ''}`;

export class AutoQuality {
  /** The ladder position while settling (play keeps it and moves the scale only). */
  rung: number;
  /** Changes so far, for the HUD and tools/check: "3.1s high>medium (mean 21.0 ms, 40% missed)". */
  readonly log: string[] = [];
  /** The last measured windows, for tools/check: [t s, rung, scale, mean ms, missed share, GPU p90 ms or 0]. */
  readonly windows: number[][] = [];
  /** Play has started (the curtain lifted): the tier is fixed from here. */
  playing = false;
  private scale: number;
  private failed = new Set<number>();
  private failedScale = new Set<number>();
  private t = 0; // seconds measured
  private quietUntil = 0;
  private win: number[] = [];
  private winStart = 0;
  private bad = 0;
  private good = 0; // clean windows in a row at the current rung (settling)
  private marginal = 0; // marginal windows in a row (settling)
  private gpu: number[] = [];
  private gpuStart = 0;
  private prevDt = 0;

  constructor(start: number, private o: AutoOptions = AUTO_DEFAULTS) {
    this.rung = Math.min(Math.max(start, 0), LADDER.length - 1);
    this.scale = LADDER[this.rung].scale;
    this.quietUntil = o.settleQuiet;
  }

  get current(): Rung {
    return { tier: LADDER[this.rung].tier, scale: this.scale };
  }

  /** Settling has seen a full window at the current rung that held (the curtain may lift). */
  get settled(): boolean {
    return this.playing || this.good >= this.o.settleGood || this.rung === LADDER.length - 1;
  }

  /** The curtain lifts: from now on only the render scale moves. */
  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.log.push(`${this.t.toFixed(1)}s play at ${name(this.current)}`);
    this.resetWindows(this.o.cooldown);
  }

  /**
   * One displayed frame: its wall time (ms) and, if known, the GPU time of a recent frame (ms, 0 =
   * unknown). Returns the rung to switch to (tier and scale), else null.
   */
  frame(dtMs: number, gpuMs = 0): Rung | null {
    // a hidden tab, a breakpoint or a shader build: not a performance signal
    if (dtMs > 250 || dtMs <= 0) return null;
    // judged on the mean of this frame and the one before: Firefox's frame clock jitters (14 / 20 ms pairs at a
    // steady 60 fps), which read as a third of the time in missed frames; a real missed frame (33 ms) still counts
    const raw = dtMs;
    dtMs = this.prevDt > 0 ? (dtMs + this.prevDt) / 2 : dtMs;
    this.prevDt = raw;
    this.t += raw / 1000;
    if (this.t < this.quietUntil) {
      this.resetWindows(0);
      return null;
    }
    this.win.push(dtMs);
    if (gpuMs > 0) this.gpu.push(gpuMs);
    const len = this.playing ? this.o.playWindow : this.o.settleWindow;
    let next: Rung | null = null;
    if (this.t - this.winStart >= len) {
      const n = this.win.length;
      const total = this.win.reduce((a, b) => a + b, 0);
      const mean = total / n;
      const missed = this.win.filter((d) => d > this.o.missMs).reduce((a, b) => a + b, 0) / total;
      this.win.length = 0;
      this.winStart = this.t;
      const wg = this.gpu.slice(-n).sort((x, y) => x - y);
      const gpuP90 = wg.length > n / 2 ? wg[Math.floor(wg.length * 0.9)] : 0;
      this.windows.push([+this.t.toFixed(2), this.rung, this.scale, +mean.toFixed(2), +missed.toFixed(3), +gpuP90.toFixed(2)]);
      if (this.windows.length > 60) this.windows.shift();
      const isBad = missed > this.o.missShare;
      const gpuTight = gpuP90 > (this.o.missMs / 1.2) * this.o.settleGpuShare;
      const clean = missed < this.o.settleClean && !gpuTight;
      this.bad = isBad ? this.bad + 1 : 0;
      this.good = clean ? this.good + 1 : 0;
      this.marginal = !clean && !isBad ? this.marginal + 1 : 0;
      const why = `mean ${mean.toFixed(1)} ms, ${(missed * 100).toFixed(0)}% of the time in missed frames${gpuP90 ? `, GPU p90 ${gpuP90.toFixed(1)} ms` : ''}`;
      if (!this.playing) {
        if ((isBad || this.marginal >= this.o.settleMarginal) && this.rung < LADDER.length - 1) {
          this.failed.add(this.rung);
          next = this.change(this.rung + 1, LADDER[this.rung + 1].scale, why, this.o.settleQuiet);
        }
      } else if (isBad && this.bad >= this.o.badWindows) {
        const k = SCALES.indexOf(this.scale);
        if (k >= 0 && k < SCALES.length - 1) {
          this.failedScale.add(this.scale);
          next = this.change(this.rung, SCALES[k + 1], why, this.o.cooldown);
        }
      }
    }
    // play: a smaller scale steps back up with a long run of clear GPU headroom, never into a scale that failed
    if (next === null && this.playing && this.t - this.gpuStart >= this.o.upFor) {
      const g = [...this.gpu].sort((a, b) => a - b);
      const p90 = g.length ? g[Math.floor(g.length * 0.9)] : Infinity;
      this.gpu.length = 0;
      this.gpuStart = this.t;
      const k = SCALES.indexOf(this.scale);
      if (g.length > 100 && p90 < this.o.upGpuMs && k > 0 && !this.failedScale.has(SCALES[k - 1]) && this.bad === 0) {
        next = this.change(this.rung, SCALES[k - 1], `GPU p90 ${p90.toFixed(1)} ms`, this.o.cooldown);
      }
    }
    return next;
  }

  /** The rungs that failed while settling (for remembering a visit's result). */
  hasFailed(rung: number): boolean {
    return this.failed.has(rung);
  }

  private resetWindows(quiet: number): void {
    if (quiet > 0) this.quietUntil = this.t + quiet;
    this.win.length = 0;
    this.winStart = this.t;
    this.gpu.length = 0;
    this.gpuStart = this.t;
  }

  private change(rung: number, scale: number, why: string, quiet: number): Rung {
    const a = this.current;
    this.rung = rung;
    this.scale = scale;
    this.bad = 0;
    this.good = 0;
    this.marginal = 0;
    this.log.push(`${this.t.toFixed(1)}s ${name(a)}>${name(this.current)} (${why})`);
    this.resetWindows(quiet);
    return this.current;
  }
}

/**
 * What the last visit settled on, per GPU, window size and scene (the menus' diorama or a stage), in localStorage:
 * the next load starts there, so the curtain lifts without a step. Kept for a day: after that a load starts from
 * the guess again, so a GPU that was slow for a while (on battery, say) gets its higher tier back.
 */
const MEMORY_KEY = 'backroad-rally.autoquality';
const MEMORY_DAYS = 1;

export function rememberedRung(gpu: string, screen: string, scene: string): number | null {
  try {
    const m = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Record<string, { rung: number; at: number }>;
    const e = m[`${gpu}|${screen}|${scene}`];
    if (!e || !Number.isInteger(e.rung) || Date.now() - e.at > MEMORY_DAYS * 864e5) return null;
    return Math.min(Math.max(e.rung, 0), LADDER.length - 1);
  } catch {
    return null;
  }
}

export function rememberRung(gpu: string, screen: string, scene: string, rung: number): void {
  try {
    const m = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Record<string, { rung: number; at: number }>;
    m[`${gpu}|${screen}|${scene}`] = { rung, at: Date.now() };
    // a few screens and GPUs at most; drop the oldest beyond 24 entries
    const keys = Object.keys(m).sort((a, b) => m[b].at - m[a].at);
    for (const k of keys.slice(24)) delete m[k];
    localStorage.setItem(MEMORY_KEY, JSON.stringify(m));
  } catch {
    // storage full or blocked: the next visit settles again
  }
}
