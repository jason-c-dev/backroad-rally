// The player car's sound (UE URallyCarAudioComponent): engine layers, the limiter, turbo whistle and
// blow-off, tyre roll and skids. Reads the vehicle each frame; never writes to it.
//
// The limiter's cuts (15-24 a second) are scheduled on the audio clock rather than sampled per frame:
// each cut is a value curve on the engine bus gain (the volume dip) and on a shared detune source
// wired into every layer (the rpm dip), so it stays even at any frame rate.
import type { Vehicle } from '../sim/vehicle';
import { events } from '../game/events';
import { Blowoff, EngineSound, limiterEnv, turboWhistle, type EngineLayerSpec } from './engineModel';
import { surfaceMix } from './surfaceModel';
import type { AudioSystem, Loop } from './system';
import { Vector3 } from 'three';

const CURVE_POINTS = 24;

export class CarAudio {
  readonly engine: EngineSound;
  private layers: Loop[] = [];
  private readonly bus: GainNode;
  private readonly detune: ConstantSourceNode;
  private turbo: Loop | null = null;
  private readonly blowoff = new Blowoff();
  private readonly roll: { gravel: Loop; tarmac: Loop; skidGravel: Loop; skidTarmac: Loop };
  private limiterOrigin = -1;
  private scheduledUntil = 0;
  private popsSeen = 0;
  private readonly exhaust = new Vector3();
  /** Engine voice level of the last frame (engine volume x limiter), for the readout. */
  level = 0;
  /** The weather turns the dry roll down (weather.json audio.dry_surface_scale: rain 0.6, snow 0.35). */
  dryScale = 1;
  /** Audio-clock times of the last limiter cuts scheduled (tools/check/audio.mjs reads the rate), and skips. */
  readonly cutLog: number[] = [];
  cutSkips = 0;

  static sounds(sys: AudioSystem, car: string): string[] {
    const m = sys.mix;
    return [
      ...Object.entries(sys.manifest.sounds).filter(([, e]) => e.kind === 'engine' && e.car === car).map(([n]) => n),
      'A_Turbo_Whistle', 'A_Turbo_Blowoff', m.surfaces.gravel_loop, m.surfaces.tarmac_loop, m.skid.gravel_loop, m.skid.tarmac_loop,
      ...sys.family('A_Backfire'),
    ];
  }

  constructor(readonly sys: AudioSystem, readonly vehicle: Vehicle, readonly car: string, seed = 1) {
    const ctx = sys.ctx;
    this.bus = ctx.createGain();
    this.bus.connect(sys.groups.engine);
    this.detune = ctx.createConstantSource();
    this.detune.offset.value = 0;
    this.detune.start();
    const specs: (EngineLayerSpec & { name: string })[] = Object.entries(sys.manifest.sounds)
      .filter(([, e]) => e.kind === 'engine' && e.car === car)
      .map(([name, e]) => ({ name, ref: e.ref_rpm ?? 1000, off: e.layer === 'off' }))
      .sort((a, b) => a.ref - b.ref);
    const t = vehicle.t;
    this.engine = new EngineSound(sys.mix.engine, { car, idleRpm: t.idleRpm, maxRpm: t.maxRpm }, specs, mulberry(seed));
    // EngineSound sorts its layers the same way (ascending ref, stable), so indices line up
    this.layers = specs.map((s) => sys.loop(s.name, 'engine', { out: this.bus, detune: this.detune }));
    if (t.turbo.enabled) this.turbo = sys.loop('A_Turbo_Whistle', 'engine', { out: this.bus });
    const m = sys.mix;
    this.roll = {
      gravel: sys.loop(m.surfaces.gravel_loop, 'surface'),
      tarmac: sys.loop(m.surfaces.tarmac_loop, 'surface'),
      skidGravel: sys.loop(m.skid.gravel_loop, 'surface'),
      skidTarmac: sys.loop(m.skid.tarmac_loop, 'surface'),
    };
  }

  update(dt: number): void {
    const v = this.vehicle;
    const sys = this.sys;
    const en = this.engine;
    const throttle = v.input.throttle;
    en.update(dt, {
      throttle,
      simRpm: v.rpm,
      gear: v.gear,
      forwardKmh: v.forwardSpeedKmh,
      airTime: v.airTime,
      wheels: v.wheels.map((w, i) => ({ inContact: w.inContact, latSlipCms: w.latSlipCms, longSlipCms: w.longSlipCms, driven: v.defs[i].driven })),
    });
    this.scheduleLimiter();
    for (let i = 0; i < this.layers.length; i++) this.layers[i].set(en.weights[i] * en.volume, en.pitch[i], dt, 0.012);
    this.level = en.volume;

    // limiter pops: an exhaust pop (fx draws the flame, the backfire listener plays it)
    while (this.popsSeen < en.limiterPops) {
      this.popsSeen++;
      this.exhaust.copy(v.forward).multiplyScalar(-2).add(v.position);
      events.emit('backfire', { pos: this.exhaust.clone(), intensity: 0.55 + Math.random() * 0.35, antilag: en.antilagPop() });
    }

    // turbo
    const tu = sys.mix.turbo;
    if (this.turbo) {
      const w = turboWhistle(tu, v.turboBoost, en.rpm01);
      this.turbo.set(w.level, w.pitch, dt);
      const fire = this.blowoff.update(dt, throttle, v.turboBoost, tu.blowoff_min_boost);
      if (fire > 0) sys.play('A_Turbo_Blowoff', 'engine', tu.blowoff_volume * fire, 0.95 + Math.random() * 0.13);
    }

    // tyres
    const s = surfaceMix(sys.mix, v.wheels, v.speedKmh);
    this.roll.gravel.set(s.rollGravel * this.dryScale, s.pitchGravel, dt);
    this.roll.tarmac.set(s.rollTarmac * this.dryScale, s.pitchTarmac, dt);
    this.roll.skidGravel.set(s.skidGravel, s.skidPitchGravel, dt);
    this.roll.skidTarmac.set(s.skidTarmac, s.skidPitchTarmac, dt);
  }

  /** Cuts on the audio clock: a volume dip on the bus and an rpm dip (cents) on every layer. */
  private scheduleLimiter(): void {
    const en = this.engine;
    const ctx = this.sys.ctx;
    const now = ctx.currentTime;
    const g = this.bus.gain;
    const d = this.detune.offset;
    if (!en.limiter) {
      if (this.limiterOrigin >= 0) {
        this.limiterOrigin = -1;
        g.cancelScheduledValues(now);
        d.cancelScheduledValues(now);
        g.setTargetAtTime(1, now, 0.005);
        d.setTargetAtTime(0, now, 0.005);
      }
      return;
    }
    if (this.limiterOrigin < 0) {
      this.limiterOrigin = this.scheduledUntil = now;
    }
    const hz = en.num('limiter_hz', 18);
    const duty = Math.min(Math.max(en.num('limiter_duty', 0.45), 0.1), 0.9);
    const len = duty / hz;
    const drop = en.num('limiter_drop_rpm', 450);
    const horizon = now + 0.1;
    for (const t of en.cutTimes(this.limiterOrigin, this.scheduledUntil, horizon)) {
      const vol = new Float32Array(CURVE_POINTS);
      const cents = new Float32Array(CURVE_POINTS);
      for (let k = 0; k < CURVE_POINTS; k++) {
        const e = limiterEnv((k / (CURVE_POINTS - 1)) * duty, duty);
        vol[k] = en.limiterVolume(e);
        cents[k] = 1200 * Math.log2(Math.max(0.5, 1 - (drop * e) / Math.max(1, en.rpm)));
      }
      const at = Math.max(t, now + 0.002);
      try {
        g.setValueCurveAtTime(vol, at, len);
        d.setValueCurveAtTime(cents, at, len);
        this.cutLog.push(at);
        if (this.cutLog.length > 512) this.cutLog.splice(0, 256);
      } catch {
        // overlapped a curve still running (a frame hitch): skip this cut
        this.cutSkips++;
      }
    }
    this.scheduledUntil = horizon;
  }

  dispose(): void {
    for (const l of this.layers) l.dispose();
    this.turbo?.dispose();
    for (const l of Object.values(this.roll)) l.dispose();
    this.detune.stop();
    this.bus.disconnect();
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
