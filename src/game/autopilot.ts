// The robot driver (UE RallyPlayerController::UpdateAutoPilot, handoff §13 slice 7): pure pursuit on
// the centreline, slowing for the turn coming up. Used by tools/check/stage.mjs to run and time a
// whole stage headless (`?autopilot=120`), and handy to watch a stage without driving it.
//
// - look-ahead clamp(v * 0.8 s, 9, 32 m); steer = heading error / 18 deg;
// - target speed = kmh * clamp(1 - turn / 110 deg, minTurn, 1), where turn is the largest heading
//   change of the road 10..60 m ahead;
// - eases the throttle once a power slide builds (UE core-13);
// - keys 1 / 2: drives like a keyboard player (1 taps toward the steer it wants, 2 holds the key).
import type { Road, RoadTracker } from '../sim/road';
import type { DriverInput, Vehicle } from '../sim/vehicle';

export interface AutopilotOptions {
  kmh: number;
  /** Floor of the turn slow-down factor (UE AutoPilotMinTurnScale, 0.3). */
  minTurn: number;
  /** 0 analog, 1 a decent keyboard player, 2 a heavy-handed one. */
  keys: 0 | 1 | 2;
  /** Keyboard robot: how often it decides to press or release a key (s). */
  keyPeriod: number;
}

export const DEFAULT_AUTOPILOT: AutopilotOptions = { kmh: 120, minTurn: 0.3, keys: 0, keyPeriod: 0.1 };

const POWER_THROTTLE = 0.35;
const POWER_LIFT_FROM = 0.05;
const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export class Autopilot {
  maxSlip = 0;
  spins = 0;
  private spinning = false;
  private keyTimer = 0;
  private key = 0;
  /** The last decision, for traces: target speed (km/h), turn ahead (deg), heading error (deg). */
  last = { vmax: 0, turn: 0, err: 0 };

  constructor(readonly road: Road, readonly tracker: RoadTracker, readonly opts: AutopilotOptions = DEFAULT_AUTOPILOT) {}

  /** Spin and slip statistics while running (UE counts a spin past 45 deg, re-armed under 15). */
  observe(v: Vehicle): void {
    if (Math.abs(v.forwardSpeedKmh) <= 20 || v.wheelsInContact < 2) return;
    const slip = Math.abs(v.bodySlipDeg);
    this.maxSlip = Math.max(this.maxSlip, slip);
    if (slip > 45 && !this.spinning) this.spins++;
    this.spinning = slip > 45 ? true : slip < 15 ? false : this.spinning;
  }

  drive(v: Vehicle, dt: number, analogExponent: number): DriverInput {
    const sign = this.tracker.sign;
    const s = this.tracker.proj?.s ?? this.road.project(v.position).s;
    const kmh = Math.abs(v.forwardSpeedKmh);
    const look = Math.min(Math.max((kmh / 3.6) * 0.8, 9), 32);
    const target = this.road.pose(s + sign * look, sign).position;
    const yawNow = this.road.pose(s, sign).yawDeg;
    let turn = 0;
    for (let ahead = 10; ahead <= 60.1; ahead += 10) {
      turn = Math.max(turn, Math.abs(norm180(this.road.pose(s + sign * ahead, sign).yawDeg - yawNow)));
    }
    const vmax = this.opts.kmh * Math.min(Math.max(1 - turn / 110, this.opts.minTurn), 1);
    const desired = (Math.atan2(target.z - v.position.z, target.x - v.position.x) * 180) / Math.PI;
    const err = norm180(desired - v.yawDeg);
    let steer = Math.min(Math.max(err / 18, -1), 1);
    this.last = { vmax, turn, err };
    if (this.opts.keys) {
      const want = Math.sign(steer) * Math.abs(steer) ** analogExponent;
      this.keyTimer -= dt;
      if (this.keyTimer <= 0) {
        this.keyTimer += Math.max(0.02, this.opts.keyPeriod);
        const sm = v.smoothedSteer;
        if (this.opts.keys === 2) {
          if (this.key !== 0 && want * this.key < 0.05) this.key = 0;
          if (this.key === 0 && Math.abs(want) > 0.15) this.key = want > 0 ? 1 : -1;
        } else {
          this.key = Math.abs(want) < 0.03 ? 0 : want * sm <= 0 || Math.abs(sm) < Math.abs(want) ? (want > 0 ? 1 : -1) : 0;
        }
      }
      return {
        steer: this.key, digitalSteer: true, handbrake: false,
        throttle: kmh < vmax ? 1 : 0,
        brake: kmh > vmax + 8 && kmh > 15 ? 1 : 0,
      };
    }
    const lift = Math.min(Math.max((Math.max(v.powerStrength, v.powerUnder) - POWER_LIFT_FROM) / 0.3, 0), 1);
    steer = Math.min(Math.max(steer, -1), 1);
    return {
      steer, digitalSteer: false, handbrake: false,
      throttle: kmh < vmax ? 1 - (1 - POWER_THROTTLE) * lift : 0,
      brake: kmh > vmax + 8 && kmh > 15 ? Math.min(Math.max((kmh - vmax) / 25, 0.2), 1) : 0,
    };
  }
}
