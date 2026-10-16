// Adaptive quality (?quality=auto, the default): start from a guess based on the GPU and the screen,
// then watch real frame times (and the GPU timer where the browser has one) and walk a ladder of
// settings until the game holds 60 fps. Steps down fast while settling (the first seconds), then
// only on sustained misses; steps up rarely, only with clear GPU headroom, and never back into a
// rung that already failed. Pure logic: the caller feeds it frames and applies what it returns.

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

export interface AutoOptions {
  /** Frame time that counts as a miss (ms): above one 60 Hz interval with some slack. */
  missMs: number;
  /** Settling: window length (s) and how long it lasts (s from the first measured frame). */
  settleWindow: number;
  settleFor: number;
  /** During play: window (s), and how many bad windows in a row step down. */
  playWindow: number;
  badWindows: number;
  /** A window is bad if more than this share of its time went to missed frames (a 1 s spike isn't). */
  missShare: number;
  /** After any change, ignore this long (s): the switch itself hitches while shaders build. */
  cooldown: number;
  /** Step up only if the GPU time's 90th percentile stayed under this (ms) for upFor seconds. */
  upGpuMs: number;
  upFor: number;
}

export const AUTO_DEFAULTS: AutoOptions = {
  missMs: 20, settleWindow: 1.5, settleFor: 10, playWindow: 3, badWindows: 2,
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

export class AutoQuality {
  rung: number;
  /** Changes so far, for the HUD and tools/check: "12.3s high>medium (mean 21.0 ms, 40% missed)". */
  readonly log: string[] = [];
  private failed = new Set<number>();
  private t = 0; // seconds measured
  private quietUntil = 0;
  private win: number[] = [];
  private winStart = 0;
  private bad = 0;
  private gpu: number[] = [];
  private gpuStart = 0;

  constructor(start: number, private o: AutoOptions = AUTO_DEFAULTS) {
    this.rung = Math.min(Math.max(start, 0), LADDER.length - 1);
    this.quietUntil = o.cooldown;
  }

  get current(): Rung {
    return LADDER[this.rung];
  }

  /**
   * One displayed frame: its wall time (ms) and, if known, the GPU time of a recent frame (ms, 0 =
   * unknown). Returns the new rung index when the caller should switch, else null.
   */
  frame(dtMs: number, gpuMs = 0): number | null {
    // a hidden tab or a breakpoint: not a performance signal
    if (dtMs > 250 || dtMs <= 0) return null;
    this.t += dtMs / 1000;
    if (this.t < this.quietUntil) {
      this.win.length = 0;
      this.winStart = this.t;
      this.gpu.length = 0;
      this.gpuStart = this.t;
      return null;
    }
    this.win.push(dtMs);
    if (gpuMs > 0) this.gpu.push(gpuMs);
    const settling = this.t < this.o.settleFor;
    const len = settling ? this.o.settleWindow : this.o.playWindow;
    let next: number | null = null;
    if (this.t - this.winStart >= len) {
      const n = this.win.length;
      const total = this.win.reduce((a, b) => a + b, 0);
      const mean = total / n;
      const missed = this.win.filter((d) => d > this.o.missMs).reduce((a, b) => a + b, 0) / total;
      this.win.length = 0;
      this.winStart = this.t;
      const isBad = missed > this.o.missShare;
      this.bad = isBad ? this.bad + 1 : 0;
      if (isBad && (settling || this.bad >= this.o.badWindows) && this.rung < LADDER.length - 1) {
        next = this.change(this.rung + 1, `mean ${mean.toFixed(1)} ms, ${(missed * 100).toFixed(0)}% of the time in missed frames`);
        this.failed.add(this.rung - 1);
      }
    }
    // step up: only with the GPU timer, a long run of clear headroom, and not into a rung that failed
    if (next === null && this.t - this.gpuStart >= this.o.upFor) {
      const g = [...this.gpu].sort((a, b) => a - b);
      const p90 = g.length ? g[Math.floor(g.length * 0.9)] : Infinity;
      this.gpu.length = 0;
      this.gpuStart = this.t;
      if (g.length > 100 && p90 < this.o.upGpuMs && this.rung > 0 && !this.failed.has(this.rung - 1) && this.bad === 0) {
        next = this.change(this.rung - 1, `GPU p90 ${p90.toFixed(1)} ms`);
      }
    }
    return next;
  }

  private change(to: number, why: string): number {
    const a = LADDER[this.rung], b = LADDER[to];
    const name = (r: Rung) => `${r.tier}${r.scale < 1 ? `@${Math.round(r.scale * 100)}%` : ''}`;
    this.log.push(`${this.t.toFixed(1)}s ${name(a)}>${name(b)} (${why})`);
    this.rung = to;
    this.bad = 0;
    this.quietUntil = this.t + this.o.cooldown;
    this.gpu.length = 0;
    this.gpuStart = this.t;
    return to;
  }
}
