// The engine's sound, minus the Web Audio (handoff §12; UE RallyCarAudio.cpp, audio_mix.json engine).
// Pure and deterministic for a given rng, so the layer weights, the sound-side rpm and the limiter
// are unit-tested. Everything here is sound side only: it reads the vehicle and never writes to it.
//
// Sound-side rpm: sim rpm x rev_scale (1.12), plus rev_lead_s x the rising rate, plus a downshift blip
// (+rev_blip_rpm as a sine over rev_blip_s), smoothed (rpm_attack up, rpm_smooth down), capped at
// max x rev_scale x rev_cap. Free revving: wheelspin on throttle, air time or a launch let the engine
// run free toward the limiter (sideways slip counts only x0.3 from 50 to 100 km/h: core-14, "wheelspin
// you can hear but isn't there"). Limiter: at max x rev_scale x limiter_norm with throttle >= 0.6 the
// ignition cuts limiter_hz times a second; each cut dips the revs and the volume over limiter_duty of
// the cycle, with limiter_pop_chance of an exhaust pop. Layers: on-throttle loops x sqrt(load),
// off-throttle loops (plus the idle on-loop) x sqrt(1 - load) x off_level, equal-power by ref rpm.
import { carNum, clamp, crossfade, lerp, ramp, smooth, type EngineMixJson } from './mix';

export interface EngineLayerSpec {
  ref: number;
  off: boolean;
}

export interface EngineWheel {
  inContact: boolean;
  latSlipCms: number;
  longSlipCms: number;
  driven: boolean;
}

export interface EngineInput {
  throttle: number;
  simRpm: number;
  gear: number;
  /** Signed speed along the nose (km/h). */
  forwardKmh: number;
  airTime: number;
  wheels: readonly EngineWheel[];
}

export interface EngineSpec {
  car: string;
  idleRpm: number;
  maxRpm: number;
}

/** Limiter envelope at a cut's phase (0..1 of the cycle): a sine bump over the duty, 0 after. */
export function limiterEnv(phase: number, duty: number): number {
  const d = clamp(duty, 0.1, 0.9);
  const p = phase - Math.floor(phase);
  return p < d ? Math.sin((Math.PI * p) / d) : 0;
}

/** A small seeded rng (mulberry32) so tests and recordings are repeatable. */
export function rng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LimiterCut {
  /** Seconds after the limiter's clock origin. */
  t: number;
  pop: boolean;
}

export class EngineSound {
  readonly layers: readonly EngineLayerSpec[];
  /** Per layer, this frame: gain (before the engine volume) and playback rate. */
  readonly weights: number[];
  readonly pitch: number[];
  load = 0;
  /** Sound rpm for the layers: smoothed, free-revving blended in, capped at the limiter while it runs. */
  rpm = 0;
  /** rpm with this frame's limiter dip (the frame-rate view of what the audio graph schedules). */
  rpmDipped = 0;
  rpm01 = 0;
  /** Engine volume without the limiter dip (volume_min + volume_load x load + volume_rpm x rpm01). */
  volume = 0;
  freeBlend = 0;
  freeRpm = 0;
  slip = 0;
  limiter = false;
  /** Limiter envelope of this frame (0..1) and its phase (cycles since the limiter engaged). */
  limiterEnv = 0;
  limiterPhase = 0;
  limiterCuts = 0;
  limiterPops = 0;
  readonly limitRpm: number;
  readonly idleSound: number;
  readonly maxSound: number;

  private smoothed = 0;
  private prevRaw = 0;
  private prevGear = 0;
  private blipLeft = 0;
  private popCooldown = 0;
  private readonly onIdx: number[] = [];
  private readonly offIdx: number[] = [];
  private readonly onRefs: number[] = [];
  private readonly offRefs: number[] = [];
  private readonly w: number[] = [];

  constructor(readonly en: EngineMixJson, readonly spec: EngineSpec, layers: readonly EngineLayerSpec[], readonly random: () => number = Math.random) {
    this.layers = [...layers].sort((a, b) => a.ref - b.ref);
    this.weights = this.layers.map(() => 0);
    this.pitch = this.layers.map(() => 1);
    this.layers.forEach((l, i) => {
      if (!l.off) {
        this.onIdx.push(i);
        this.onRefs.push(l.ref);
      }
    });
    // the off set: the off layers plus the idle on-layer (there is no _Off at 1000 rpm)
    this.layers.forEach((l, i) => {
      if (l.off || i === this.onIdx[0]) {
        this.offIdx.push(i);
        this.offRefs.push(l.ref);
      }
    });
    const revScale = this.num('rev_scale', 1);
    this.limitRpm = spec.maxRpm * revScale * this.num('limiter_norm', 1.05);
    this.idleSound = spec.idleRpm * revScale;
    this.maxSound = spec.maxRpm * revScale;
  }

  num(key: string, def: number): number {
    return carNum(this.en, this.spec.car, key, def);
  }

  /** Advance one frame (cuts that fall in it are counted and roll for a pop: see limiterPops). */
  update(dt: number, inp: EngineInput): void {
    if (dt <= 0) return;
    const en = this.en;
    const N = (k: string, d: number) => this.num(k, d);
    const throttle = clamp(inp.throttle, 0, 1);
    this.load = smooth(this.load, throttle, throttle > this.load ? N('load_attack', 10) : N('load_release', 6), dt);

    // sim rpm -> the sound's rpm
    const phys = Math.max(this.spec.idleRpm, inp.simRpm);
    const revScale = N('rev_scale', 1);
    const rate = this.prevRaw > 0 ? (phys - this.prevRaw) / dt : 0;
    this.prevRaw = phys;
    const blipS = N('rev_blip_s', 0);
    if (inp.gear >= 1 && this.prevGear > inp.gear && blipS > 0) this.blipLeft = blipS;
    this.prevGear = inp.gear;
    let blip = 0;
    if (this.blipLeft > 0) {
      this.blipLeft = Math.max(0, this.blipLeft - dt);
      blip = N('rev_blip_rpm', 0) * Math.sin(Math.PI * (1 - this.blipLeft / blipS));
    }
    const raw = clamp(phys * revScale + Math.max(0, rate) * N('rev_lead_s', 0) + blip,
      this.spec.idleRpm, this.spec.maxRpm * revScale * N('rev_cap', 1.08));
    const down = N('rpm_smooth', 25);
    this.smoothed = this.smoothed <= 0 ? raw : smooth(this.smoothed, raw, raw > this.smoothed ? N('rpm_attack', down) : down, dt);

    // free revving: driven-wheel slip on throttle, air time, a launch
    const kmh = Math.abs(inp.forwardKmh);
    const latW = lerp(1, N('free_lateral_high_speed', 1), ramp(kmh, N('free_lateral_fade_start_kmh', 50), N('free_lateral_fade_full_kmh', 100)));
    let slipSum = 0;
    let driven = 0;
    for (const w of inp.wheels) {
      if (!w.driven) continue;
      driven++;
      if (w.inContact) slipSum += Math.abs(w.latSlipCms) * latW + Math.max(0, w.longSlipCms);
    }
    this.slip = driven ? slipSum / driven : 0;
    const slipF = ramp(this.slip, N('free_slip_start_cms', 250), N('free_slip_full_cms', 900))
      * ramp(throttle, N('free_throttle_min', 0.35), N('free_throttle_full', 0.8));
    const airF = ramp(inp.airTime, N('free_air_start_s', 0.08), N('free_air_full_s', 0.22));
    const launchF = N('free_launch_level', 0) * ramp(throttle, 0.5, 0.9)
      * (1 - ramp(kmh, N('free_launch_full_kmh', 6), N('free_launch_end_kmh', 22)));
    const want = Math.max(slipF, airF, inp.gear >= 1 ? launchF : 0) * (inp.gear !== 0 ? 1 : 0);
    this.freeBlend = smooth(this.freeBlend, want, want > this.freeBlend ? N('free_blend_attack', 14) : N('free_blend_release', 4), dt);
    if (this.freeBlend < 0.01) {
      this.freeRpm = this.smoothed; // in step with the loaded engine until it lets go
    } else {
      const target = lerp(this.idleSound * 1.3, this.limitRpm * 1.03, throttle);
      const step = (target > this.freeRpm ? N('free_rise_rpm_s', 14000) : N('free_fall_rpm_s', 8000)) * dt;
      this.freeRpm = Math.abs(target - this.freeRpm) <= step ? target : this.freeRpm + Math.sign(target - this.freeRpm) * step;
    }
    let rpm = lerp(this.smoothed, Math.max(this.freeRpm, this.idleSound), clamp(this.freeBlend, 0, 1));

    // the limiter (hysteresis: it lets go 3% lower than it engages)
    this.popCooldown = Math.max(0, this.popCooldown - dt);
    const onNorm = N('limiter_on_norm', 0.99);
    const wantLimit = throttle >= N('limiter_throttle_min', 0.6) && rpm >= this.limitRpm * (this.limiter ? onNorm - 0.03 : onNorm);
    if (wantLimit && !this.limiter) this.limiterPhase = 0;
    this.limiter = wantLimit;
    this.limiterEnv = 0;
    let dipped = rpm;
    if (this.limiter) {
      const old = this.limiterPhase;
      this.limiterPhase += N('limiter_hz', 18) * dt;
      this.limiterEnv = limiterEnv(this.limiterPhase, N('limiter_duty', 0.45));
      const cuts = Math.floor(this.limiterPhase) - Math.floor(old) + (old === 0 ? 1 : 0);
      for (let i = 0; i < cuts; i++) this.cut();
      rpm = Math.min(rpm, this.limitRpm);
      dipped = rpm - N('limiter_drop_rpm', 450) * this.limiterEnv;
    }
    this.rpm = rpm;
    this.rpmDipped = dipped;

    // layer weights and pitches
    const onGain = Math.sqrt(clamp(this.load, 0, 1));
    const offGain = Math.sqrt(clamp(1 - this.load, 0, 1)) * (en.off_level ?? 0.8);
    this.weights.fill(0);
    crossfade(this.onRefs, rpm, this.w).forEach((x, k) => (this.weights[this.onIdx[k]] += x * onGain));
    crossfade(this.offRefs, rpm, this.w).forEach((x, k) => (this.weights[this.offIdx[k]] += x * offGain));
    const pMin = N('pitch_min', 0.5);
    const pMax = N('pitch_max', 2);
    this.layers.forEach((l, i) => (this.pitch[i] = clamp(rpm / Math.max(1, l.ref), pMin, pMax)));
    this.rpm01 = Math.min(1, rpm / Math.max(1, this.maxSound));
    this.volume = N('volume', 1) * (N('volume_min', 0.7) + N('volume_load', 0.2) * this.load + N('volume_rpm', 0.15) * this.rpm01);
  }

  /** Volume multiplier of the limiter at envelope e (1 - limiter_volume_dip x e). */
  limiterVolume(e: number): number {
    return 1 - this.num('limiter_volume_dip', 0.45) * e;
  }

  /** One ignition cut: counted, with a chance of a pop (cooldown limiter_pop_cooldown_s). */
  cut(): boolean {
    this.limiterCuts++;
    if (this.popCooldown <= 0 && this.random() < this.num('limiter_pop_chance', 0.15)) {
      this.popCooldown = this.num('limiter_pop_cooldown_s', 0.2);
      this.limiterPops++;
      return true;
    }
    return false;
  }

  /** Whether a pop is anti-lag (half of them on cars with limiter_antilag). */
  antilagPop(): boolean {
    return this.num('limiter_antilag', 0) > 0.5 && this.random() < 0.5;
  }

  /** The cut times in [from, to) of a limiter clock that started at `origin` (s): one per 1/limiter_hz. */
  cutTimes(origin: number, from: number, to: number): number[] {
    const period = 1 / Math.max(1, this.num('limiter_hz', 18));
    const out: number[] = [];
    for (let k = Math.max(0, Math.ceil((from - origin) / period - 1e-9)); origin + k * period < to; k++) out.push(origin + k * period);
    return out;
  }
}

/** Turbo whistle level and pitch for a boost (0..1) and rpm01 (UE: boost^1.5; lerp(pitch) x (0.85 + 0.3 rpm01)). */
export function turboWhistle(t: { whistle_volume: number; pitch_min: number; pitch_max: number }, boost: number, rpm01: number) {
  const b = clamp(boost, 0, 1);
  return { level: t.whistle_volume * Math.pow(b, 1.5), pitch: lerp(t.pitch_min, t.pitch_max, b) * (0.85 + 0.3 * rpm01) };
}

/** A blow-off: a quick lift (throttle from > 0.5 to < 0.2) with boost above blowoff_min_boost, 0.8 s apart. */
export class Blowoff {
  private prevThrottle = 0;
  private prevBoost = 0;
  private cooldown = 0;

  update(dt: number, throttle: number, boost: number, minBoost: number): number {
    this.cooldown = Math.max(0, this.cooldown - dt);
    let fire = 0;
    if (this.prevThrottle > 0.5 && throttle < 0.2 && this.prevBoost > minBoost && this.cooldown <= 0) {
      fire = this.prevBoost;
      this.cooldown = 0.8;
    }
    this.prevThrottle = throttle;
    this.prevBoost = boost;
    return fire;
  }
}
