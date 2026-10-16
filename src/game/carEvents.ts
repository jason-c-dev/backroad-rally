// Watches the car once per physics step and emits the game events that come from its motion
// (events.ts): landings, impacts and ford splashes. It reads the vehicle and never writes it, so
// the simulation runs exactly as it would without it (the autopilot times are the check).
//
// Impacts: the web build has no contact callbacks, so a hit is read from the body's velocity: the
// change over one step, minus gravity, is far larger than tyres can make (they top out near 0.1 m/s
// per 1/120 s step) when the car hits something. As in the original, changes that push the car up
// while it is upright are the ground (landings, kerbs), not crashes, and hits within 0.2 s merge into
// one impact whose size is the largest velocity change (km/h).
import { Vector3 } from 'three';
import type { Vehicle } from '../sim/vehicle';
import type { Surface } from '../sim/tuning';
import { events } from './events';

export interface CarEventsConfig {
  /** Landing: at least this long with no wheel on the ground (s); fall speed giving strength 1 (m/s). */
  minAirS: number;
  refFallMs: number;
  /** Impact: per-step velocity change that counts as a hit (m/s), merge window (s), hard from (km/h). */
  hitDvMs: number;
  mergeS: number;
  hardKmh: number;
  /** Below this the hit is too small to report (km/h): the original's sound_min_kmh. */
  minKmh: number;
  /** Ground: a velocity change pointing up more than this (cos) while the car is upright. */
  groundUp: number;
  /** Fords: below this speed no splash (km/h); gap between splashes while in the water (s). */
  splashMinKmh: number;
  splashGapS: number;
}

export const DEFAULT_CAR_EVENTS: CarEventsConfig = {
  minAirS: 0.3, refFallMs: 7, hitDvMs: 0.35, mergeS: 0.2, hardKmh: 30, minKmh: 6, groundUp: 0.7, splashMinKmh: 8, splashGapS: 0.8,
};

const GRAVITY = -9.81;

export class CarEvents {
  landings = 0;
  impacts = 0;
  splashes = 0;
  /** Largest per-step velocity change seen that wasn't the ground (m/s), for tuning hitDvMs. */
  maxDv = 0;
  /** Water surface height under the car, or null (fords; set by the level). */
  waterAt: ((p: Vector3) => number | null) | null = null;
  private air = 0;
  private maxFall = 0;
  private prevV = new Vector3();
  private prevP = new Vector3(1e9, 0, 0);
  private dv = new Vector3();
  private pending = false;
  private pendingT = 0;
  private pendingKmh = 0;
  private pendingPos = new Vector3();
  private pendingNormal = new Vector3();
  private inWater = false;
  private splashGap = 0;

  constructor(private cfg: CarEventsConfig = DEFAULT_CAR_EVENTS) {}

  /** Once per physics step (before it), with the state the last step left. */
  step(veh: Vehicle, dt: number): void {
    const v = veh.velocity, p = veh.position;
    // a teleport (reset, recover, restart) is not a crash
    const jump = Math.max(4, v.length() * dt * 6);
    const teleported = p.distanceToSquared(this.prevP) > jump * jump;
    if (!teleported) {
      this.landing(veh, dt);
      this.impact(veh, dt);
      this.splash(veh, dt);
    } else {
      this.air = 0;
      this.maxFall = 0;
      this.pending = false;
      this.inWater = false;
    }
    this.prevV.copy(v);
    this.prevP.copy(p);
  }

  private landing(veh: Vehicle, dt: number): void {
    if (veh.wheelsInContact === 0) {
      this.air += dt;
      this.maxFall = Math.max(this.maxFall, -veh.velocity.y);
      return;
    }
    const air = this.air, fall = this.maxFall;
    this.air = 0;
    this.maxFall = 0;
    if (air < this.cfg.minAirS) return;
    this.landings++;
    events.emit('landing', {
      speed: veh.speedKmh, airTime: air, fallSpeed: fall, strength: Math.min(Math.max(fall / this.cfg.refFallMs, 0.3), 1.5),
      surface: mainSurface(veh), pos: veh.position.clone(),
    });
  }

  private impact(veh: Vehicle, dt: number): void {
    const d = this.dv.copy(veh.velocity).sub(this.prevV);
    d.y -= GRAVITY * dt;
    const size = d.length();
    const ground = size > 0 && d.y / size > this.cfg.groundUp && veh.up.y > 0.5;
    if (!ground) this.maxDv = Math.max(this.maxDv, size);
    if (!ground && size > this.cfg.hitDvMs) {
      const kmh = size * 3.6;
      if (!this.pending || kmh > this.pendingKmh) {
        this.pendingKmh = kmh;
        // where: the side of the car the push came from (the original had the contact point)
        const n = this.pendingNormal.copy(d).normalize();
        this.pendingPos.copy(veh.position).addScaledVector(n, -1.2);
        this.pendingPos.y = veh.position.y + 0.4;
      }
      if (!this.pending) {
        this.pending = true;
        this.pendingT = 0;
      }
    }
    if (this.pending) {
      this.pendingT += dt;
      if (this.pendingT >= this.cfg.mergeS) {
        this.pending = false;
        if (this.pendingKmh >= this.cfg.minKmh) {
          this.impacts++;
          events.emit('impact', {
            speed: this.pendingKmh, hard: this.pendingKmh >= this.cfg.hardKmh, pos: this.pendingPos.clone(), normal: this.pendingNormal.clone(),
          });
        }
      }
    }
  }

  private splash(veh: Vehicle, dt: number): void {
    this.splashGap = Math.max(0, this.splashGap - dt);
    const water = this.waterAt?.(veh.position) ?? null;
    const kmh = veh.speedKmh;
    const now = water !== null && kmh > this.cfg.splashMinKmh;
    if (now && (!this.inWater || this.splashGap <= 0)) {
      this.splashes++;
      events.emit('splash', { pos: veh.position.clone().setY(water!), speed: kmh, entry: !this.inWater });
      this.splashGap = this.cfg.splashGapS;
    }
    this.inWater = now;
  }
}

/** The surface under most wheels in contact (the original's GetMainSurface). */
export function mainSurface(veh: Vehicle): Surface {
  const n = new Map<Surface, number>();
  for (const w of veh.wheels) if (w.inContact) n.set(w.surface, (n.get(w.surface) ?? 0) + 1);
  let best: Surface = 'gravel', most = 0;
  for (const [s, k] of n) {
    if (k > most) {
      most = k;
      best = s;
    }
  }
  return best;
}
