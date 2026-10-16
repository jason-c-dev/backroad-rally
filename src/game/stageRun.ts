// One run of a stage (handoff §11.1, stage_runtime.json flow): intro card, 3-2-1 countdown (a
// jump start is allowed, the clock starts on "go"), running, a short coast after the finish line,
// results. Off-road resets and recovers cost +5 s each. No splits, by design.
import type { DriverInput } from '../sim/vehicle';
import type { RoadTracker } from '../sim/road';
import { events } from './events';

export type Phase = 'intro' | 'countdown' | 'running' | 'finished' | 'results';

export interface FlowConfig {
  intro_s: number;
  restart_intro_s: number;
  countdown_step_s: number;
  go_display_s: number;
  finished_coast_s: number;
  finished_coast_brake: number;
  time_cap_s: number;
  lost_dnf_s: number;
  recover_penalty_s: number;
}

export const DEFAULT_FLOW: FlowConfig = {
  intro_s: 2.5, restart_intro_s: 0.8, countdown_step_s: 1, go_display_s: 1, finished_coast_s: 3,
  finished_coast_brake: 0.25, time_cap_s: 3599.999, lost_dnf_s: 4, recover_penalty_s: 5,
};

export class StageRun {
  phase: Phase = 'intro';
  /** Time in the current phase (s). */
  t = 0;
  /** Stage clock from "go" (s), penalties not included. */
  clock = 0;
  penalties = 0;
  recovers = 0;
  dnf = false;
  /** Seconds since the last penalty (for the HUD pop), Infinity if none. */
  sincePenalty = Infinity;
  private lostTime = 0;
  private lastDigit = 0;

  constructor(readonly tracker: RoadTracker, readonly flow: FlowConfig = DEFAULT_FLOW, restart = false) {
    this.introS = restart ? flow.restart_intro_s : flow.intro_s;
  }
  private introS: number;

  get total(): number {
    return Math.min(this.clock + this.penalties, this.flow.time_cap_s);
  }

  /** Countdown digit (3, 2, 1), 'go' for go_display_s after the start, or null. */
  get callout(): string | null {
    if (this.phase === 'countdown') return String(3 - Math.floor(this.t / this.flow.countdown_step_s));
    if (this.phase === 'running' && this.clock < this.flow.go_display_s) return 'go';
    return null;
  }

  penalty(): void {
    this.penalties += this.flow.recover_penalty_s;
    this.recovers++;
    this.sincePenalty = 0;
    events.emit('penalty', { seconds: this.flow.recover_penalty_s, total: this.penalties });
  }

  /** Advance the flow; returns the input the car actually gets. */
  update(dt: number, driver: DriverInput, outsideBounds: boolean): DriverInput {
    this.t += dt;
    this.sincePenalty += dt;
    const f = this.flow;
    switch (this.phase) {
      case 'intro':
        if (this.t >= this.introS) this.enter('countdown');
        return { throttle: 0, brake: 0, steer: driver.steer, digitalSteer: driver.digitalSteer, handbrake: true };
      case 'countdown': {
        const n = 3 - Math.floor(this.t / f.countdown_step_s);
        if (n !== this.lastDigit && n >= 1) events.emit('countdown', { n: (this.lastDigit = n) });
        if (this.t >= 3 * f.countdown_step_s) this.enter('running');
        return driver; // jump start allowed; the clock waits for "go"
      }
      case 'running':
        this.clock += dt;
        this.lostTime = outsideBounds ? this.lostTime + dt : 0;
        if (this.lostTime > f.lost_dnf_s || this.clock + this.penalties >= f.time_cap_s) {
          this.dnf = true;
          this.enter('results');
        } else if (this.tracker.crossedFinish) {
          this.enter('finished');
        }
        return driver;
      case 'finished':
        if (this.t >= f.finished_coast_s) this.enter('results');
        return { throttle: 0, brake: f.finished_coast_brake, steer: driver.steer, digitalSteer: driver.digitalSteer, handbrake: false };
      case 'results':
        // the handbrake holds it: brake held at a standstill would select reverse
        return { throttle: 0, brake: 0, steer: 0, digitalSteer: false, handbrake: true };
    }
  }

  private enter(p: Phase): void {
    this.phase = p;
    this.t = 0;
    // the flow's sound cues (audio listens; nothing here feeds back into the run)
    if (p === 'running') events.emit('go', {});
    if (p === 'finished' || (p === 'results' && this.dnf)) events.emit('finish', { dnf: this.dnf, time: this.total });
  }
}

/** m:ss.mmm with tabular digits in mind. */
export function formatTime(s: number): string {
  const ms = Math.round(s * 1000);
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
