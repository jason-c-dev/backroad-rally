// Car damage, ported from the original's URallyDamageComponent (damage.json; handoff §5.5). A hit's
// size is the body's velocity change, the contact impulse over the car's mass (km/h); hits within
// 0.2 s merge into one, sized by the largest. Ground contacts while upright (landings, scrapes) never
// damage. Each hit adds ((kmh - 15) / 85)^2 x level; one hit of 110 km/h or more wrecks the car, and a
// total of 1 is terminal (did not finish).
//
//   light (grime)  ->  medium (smoke, 0.35)  ->  heavy (fire, 0.7)  ->  1 = terminal
//
// Effects (all from the overall value): engine torque x (1 - 0.3 damage) (x 0.15 once terminal) and a
// steering pull of 0.05 damage^1.5 toward the side the first real hit decided; paint grime. The six
// parts (front, rear, left, right, engine, suspension) only colour the HUD's warning lights.
//
// Levels as the original's modes set them: 1 career (the default here), 0.5 quick stage, 0 time attack
// (off: hits still spark and sound, nothing is damaged). damage.json's own level_scale (0.6) was its
// free-drive value. `?damage=0|0.5|1` picks one until game modes exist (slice 9).
import { events } from './events';

export const PARTS = ['front', 'rear', 'left', 'right', 'engine', 'suspension'] as const;
export type Part = (typeof PARTS)[number];

export interface DamageJson {
  min_kmh: number;
  exponent: number;
  level_scale: number;
  sound_min_kmh: number;
  merge_window_s: number;
  ground_normal_z: number;
  light_from: number;
  smoke_from: number;
  fire_from: number;
  torque_loss: number;
  terminal_torque_scale: number;
  steer_pull_max: number;
  grime_per_damage: number;
  dust_grime_per_s: number;
  dust_grime_max: number;
  dirt_color: string;
  ref_hit_kmh: number;
  terminal_single_hit_kmh: number;
  parts: { gain: number; sharpness: number; engine_share: number; suspension_share: number; half_size_cm: number[] };
}

export const DEFAULT_DAMAGE: DamageJson = {
  min_kmh: 15, exponent: 2, level_scale: 0.6, sound_min_kmh: 6, merge_window_s: 0.2, ground_normal_z: 0.7,
  light_from: 0.08, smoke_from: 0.35, fire_from: 0.7, torque_loss: 0.3, terminal_torque_scale: 0.15, steer_pull_max: 0.05,
  grime_per_damage: 0.8, dust_grime_per_s: 0.004, dust_grime_max: 0.25, dirt_color: '#3B3128', ref_hit_kmh: 100,
  terminal_single_hit_kmh: 110, parts: { gain: 2.2, sharpness: 2, engine_share: 0.35, suspension_share: 0.45, half_size_cm: [210, 85, 70] },
};

/** The car's size and engine end, for where a hit lands (car.json length/width, fx.json engine_pos_cm). */
export interface DamageCar {
  lengthCm: number;
  widthCm: number;
  /** Engine x in the car frame (cm, + = front). */
  engineXCm: number;
}

/**
 * One contact with the body: `kmh` = impulse / mass, `x`/`y` = the contact point in the car frame (cm,
 * x forward, y right), `ny` = the contact normal's car-frame right component (pointing from what was
 * hit toward the car), `ground` = a ground contact while upright (ignored).
 */
export interface Hit {
  kmh: number;
  x: number;
  y: number;
  ny: number;
  ground: boolean;
  what?: string;
}

export class Damage {
  /** Off = hits are still counted (sparks, sounds come from the impact events) but never damage. */
  enabled = true;
  /** The mode's damage multiplier (1 career, 0.5 quick stage). */
  level = 1;
  /** 0..1 overall. */
  value = 0;
  terminal = false;
  /** Cosmetic dust build-up (0..dust_grime_max). */
  dustGrime = 0;
  /** Per part 0..1, PARTS order. */
  readonly parts = [0, 0, 0, 0, 0, 0];
  /** Sim time of the last change (the HUD pulses a light that changed). */
  lastChange = -100;
  impacts = 0;
  lastImpactKmh = 0;
  maxImpactKmh = 0;
  /** Which way a bent suspension pulls (+1 right, -1 left): the first real hit decides. */
  pullSide = 1;
  /** Sim time (s), advanced by tick(). */
  time = 0;
  /** Called once when the car becomes terminal (the stage flow retires the run). */
  onTerminal: (() => void) | null = null;
  private pending: Hit | null = null;
  private pendingT = 0;

  constructor(readonly cfg: DamageJson = DEFAULT_DAMAGE, readonly car: DamageCar = { lengthCm: 420, widthCm: 170, engineXCm: 134 }) {}

  /** 0 clean, 1 light (grime), 2 medium (smoke), 3 heavy (fire), 4 terminal. */
  get stage(): number {
    const c = this.cfg, d = this.value;
    return this.terminal ? 4 : d >= c.fire_from ? 3 : d >= c.smoke_from ? 2 : d >= c.light_from ? 1 : 0;
  }

  /** Engine torque multiplier (exactly 1 while undamaged). */
  get torqueScale(): number {
    if (this.terminal) return this.cfg.terminal_torque_scale;
    return this.value > 0 ? 1 - this.cfg.torque_loss * this.value : 1;
  }

  /** Added to the applied steer (-1..1), + = right (exactly 0 while undamaged). */
  get steerPull(): number {
    return this.value > 0 ? this.cfg.steer_pull_max * this.value ** 1.5 * this.pullSide : 0;
  }

  /** How far the paint is lerped toward the dirt colour (0..0.95). */
  get grime(): number {
    return Math.min(Math.max(Math.max(this.dustGrime, this.value * this.cfg.grime_per_damage), 0), 0.95);
  }

  /** A contact this step (call it for every body contact; it filters and merges like the original). */
  hit(h: Hit): void {
    if (h.ground || h.kmh < this.cfg.sound_min_kmh) return;
    if (!this.pending || h.kmh > this.pending.kmh) {
      const first = !this.pending;
      this.pending = { ...h };
      if (first) this.pendingT = 0;
    }
  }

  /**
   * Advance by dt (s). `kmh` and `loose` (on gravel, dirt, grass or snow) drive the cosmetic dust grime.
   * Returns the committed impact (km/h) if one closed this tick.
   */
  tick(dt: number, kmh = 0, loose = false): number | null {
    this.time += dt;
    let committed: number | null = null;
    if (this.pending) {
      this.pendingT += dt;
      if (this.pendingT >= this.cfg.merge_window_s) committed = this.commit();
    }
    const c = this.cfg;
    if (c.dust_grime_per_s > 0 && this.dustGrime < c.dust_grime_max && kmh > 30 && loose) {
      this.dustGrime = Math.min(c.dust_grime_max, this.dustGrime + c.dust_grime_per_s * dt);
    }
    return committed;
  }

  /** Damage a hit of `kmh` adds at this level (before the terminal rule). */
  static added(cfg: DamageJson, kmh: number, level: number): number {
    if (kmh <= cfg.min_kmh) return 0;
    return ((kmh - cfg.min_kmh) / Math.max(1, cfg.ref_hit_kmh - cfg.min_kmh)) ** cfg.exponent * level;
  }

  private commit(): number {
    const h = this.pending!;
    this.pending = null;
    this.impacts++;
    this.lastImpactKmh = h.kmh;
    this.maxImpactKmh = Math.max(this.maxImpactKmh, h.kmh);
    if (this.enabled && !this.terminal && h.kmh > this.cfg.min_kmh) {
      let added = Damage.added(this.cfg, h.kmh, this.level);
      // the first real hit decides which way a bent suspension pulls
      if (this.value < 0.05) this.pullSide = h.ny >= 0 ? 1 : -1;
      // one very fast hit wrecks a car (the original's terminal-speed threshold)
      if (h.kmh >= this.cfg.terminal_single_hit_kmh) added = 1;
      this.add(added, this.partWeightsAt(h.x, h.y), h.kmh);
    }
    return h.kmh;
  }

  /** Adds damage directly (carried damage, tests). Without weights it spreads evenly over the parts. */
  add(amount: number, weights: number[] = PARTS.map(() => 1 / PARTS.length), kmh = 0): void {
    if (this.terminal) return;
    const before = this.value;
    this.value = Math.min(Math.max(this.value + Math.max(0, amount), 0), 1);
    if (this.value >= 1) this.terminal = true;
    this.addToParts(this.value - before + (this.terminal ? 1 : 0), weights);
    this.lastChange = this.time;
    let most = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[most]) most = i;
    events.emit('damage', {
      part: PARTS[most], amount: this.value - before, total: this.value, parts: [...this.parts], kmh, terminal: this.terminal, stage: this.stage,
    });
    if (this.terminal) this.onTerminal?.();
  }

  /** Part weights (sum 1) for a hit at (x forward, y right) in the car frame, cm. */
  partWeightsAt(xCm: number, yCm: number): number[] {
    const P = this.cfg.parts;
    const halfX = this.car.lengthCm > 100 ? this.car.lengthCm * 0.5 : P.half_size_cm[0];
    const halfY = this.car.widthCm > 50 ? this.car.widthCm * 0.5 : P.half_size_cm[1];
    const X = clamp(xCm / Math.max(1, halfX), -1, 1);
    const Y = clamp(yCm / Math.max(1, halfY), -1, 1);
    const side = (v: number) => Math.max(0, v) ** P.sharpness;
    let front = side(X), rear = side(-X), left = side(-Y), right = side(Y);
    let sum = front + rear + left + right;
    if (sum < 1e-3) {
      front = rear = left = right = 0.25; // dead centre (a roof hit): everywhere a little
      sum = 1;
    }
    // the engine takes a share of hits at its end of the car; the suspension of hits near a wheel (corners, sides)
    const engineEnd = this.car.engineXCm >= 0 ? 1 : -1;
    const engineW = P.engine_share * clamp(X * engineEnd, 0, 1);
    const corner = clamp(Math.abs(Y), 0, 1) * clamp(Math.abs(X) * 1.4, 0, 1);
    const suspW = P.suspension_share * clamp(corner + 0.35 * Math.abs(Y), 0, 1);
    const body = Math.max(0, 1 - engineW - suspW);
    return [(body * front) / sum, (body * rear) / sum, (body * left) / sum, (body * right) / sum, engineW, suspW];
  }

  private addToParts(amount: number, w: number[]): void {
    // the most-hit body side takes the full amount x gain; engine and suspension their share of it (at most as much)
    let peak = 0;
    for (let i = 0; i <= 3; i++) peak = Math.max(peak, w[i] ?? 0);
    if (peak <= 0) for (const x of w) peak = Math.max(peak, x);
    if (peak <= 0) return;
    for (let i = 0; i < this.parts.length; i++) {
      this.parts[i] = clamp(this.parts[i] + amount * this.cfg.parts.gain * Math.min(1, (w[i] ?? 0) / peak), 0, 1);
    }
  }

  /**
   * Career: the damage carried from the rally's previous stage (UE AddDamage + SetParts), set quietly (no hit
   * event, no sound). Without parts it spreads evenly. Not terminal: the carry is capped at 0.99.
   */
  carry(value: number, parts: readonly number[] = []): void {
    this.value = Math.min(Math.max(value, 0), 0.99);
    this.terminal = false;
    if (parts.length === this.parts.length) this.parts.forEach((_, i) => (this.parts[i] = Math.min(Math.max(parts[i], 0), 1)));
    else this.parts.fill(Math.min(1, this.value * this.cfg.parts.gain));
    this.lastChange = -100;
  }

  /** Back to new (stage restart). */
  repair(): void {
    this.value = 0;
    this.terminal = false;
    this.dustGrime = 0;
    this.parts.fill(0);
    this.lastChange = -100;
    this.pending = null;
    this.impacts = 0;
    this.lastImpactKmh = this.maxImpactKmh = 0;
    this.pullSide = 1;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
