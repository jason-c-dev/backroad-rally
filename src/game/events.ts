// Game events: a tiny typed emitter between the simulation / stage flow and what only watches it
// (effects, audio). Emitting never feeds back into the sim: listeners read the payload and nothing
// they do reaches the physics. Positions are three metres (x, y up, z), speeds km/h unless named.
//
//   import { events } from './game/events';
//   const off = events.on('landing', (e) => ...);  off();   // or events.off('landing', fn)
//
// Who emits what (src/game/carEvents.ts unless noted):
//   landing        the car touches down after >= 0.3 s with every wheel off the ground
//   impact         a hit on something that isn't the ground under the wheels (merged over 0.2 s)
//   backfire       an exhaust pop or anti-lag crackle (src/fx/exhaust.ts, the same rules as the original)
//   splash         driving into or through a ford (stages that have one)
//   crowdReaction  spectators react (src/world/crowd.ts): cheer, near miss, gasp, groan, applause
//   breakable      the car drove through a bush or knocked over a post (src/world/breakables.ts)
//   damage         a hit damaged the car (src/game/damage.ts): which part took most, how much, the new total
//   countdown, go, finish, penalty   the stage flow (src/game/stageRun.ts)
import type { Vector3 } from 'three';
import type { Surface } from '../sim/tuning';

export type CrowdReactionKind = 'cheer' | 'nearMiss' | 'gasp' | 'groan' | 'applause';

export interface GameEvents {
  /** Touch-down after a jump. `speed` = car speed (km/h), `fallSpeed` = peak downward speed in the air (m/s),
   * `strength` = fallSpeed / 7 m/s clamped to 0.3..1.5 (the original's landing intensity). */
  landing: { speed: number; airTime: number; fallSpeed: number; strength: number; surface: Surface; pos: Vector3 };
  /** A crash: `speed` = the body's velocity change (km/h), `hard` = speed >= 30 km/h (the original's hard-impact sound). */
  impact: { speed: number; hard: boolean; pos: Vector3; normal: Vector3 };
  /** Spectators react; `pos` = the crowd group's centre (or the car for a finish with nobody near). */
  crowdReaction: { kind: CrowdReactionKind; pos: Vector3; intensity: number; count: number };
  /** One exhaust pop: `intensity` 0.5..1.2, `antilag` = a turbo car's crackle off throttle (quieter). */
  backfire: { pos: Vector3; intensity: number; antilag: boolean };
  /** Water: `entry` on driving in, then at most every 0.8 s while in it. */
  splash: { pos: Vector3; speed: number; entry: boolean };
  /** The car broke a roadside breakable (src/world/breakables.ts): `reaction` burst (a bush: leaves scatter) or fly
   * (a post knocked over); `sound`, `volume`, `pitch` = the original's choice for it (fx.json breakables). */
  breakable: { pos: Vector3; mesh: string; category: string; reaction: 'burst' | 'fly'; speed: number; sound: string; volume: number; pitch: number };
  /** A committed hit damaged the car (src/game/damage.ts). `part` = the part that took the largest share, `amount` =
   * overall damage added (0..1), `total` = the new overall value, `parts` = every part (front, rear, left, right, engine,
   * suspension), `kmh` = the hit's velocity change, `stage` 0 clean .. 3 fire, 4 terminal. */
  damage: { part: string; amount: number; total: number; parts: number[]; kmh: number; terminal: boolean; stage: number };
  // stage flow (src/game/stageRun.ts)
  /** A countdown digit appears (3, 2, 1). */
  countdown: { n: number };
  /** The start: the clock runs. */
  go: Record<string, never>;
  /** Over the finish line (`dnf` false), or the run retired (`dnf` true, `reason` why: terminal damage, left the
   * stage, time cap). Either way the car coasts to a stop and the results follow. */
  finish: { dnf: boolean; time: number; reason: string };
  /** A reset or recover cost `seconds` (+5 s). */
  penalty: { seconds: number; total: number };
}

type Listener<T> = (e: T) => void;

export class Emitter<E> {
  private map = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(name: K, fn: Listener<E[K]>): () => void {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => this.off(name, fn);
  }

  off<K extends keyof E>(name: K, fn: Listener<E[K]>): void {
    this.map.get(name)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof E>(name: K, e: E[K]): void {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<E[K]>)(e);
      } catch (err) {
        // a listener's bug must not stop the game loop (or the other listeners)
        console.error(`event ${String(name)}:`, err);
      }
    }
  }

  /** Listener count (tests). */
  count(name: keyof E): number {
    return this.map.get(name)?.size ?? 0;
  }
}

/** The game's one event bus. */
export const events = new Emitter<GameEvents>();
