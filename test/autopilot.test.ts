import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Road, RoadTracker, type RoadData } from '../src/sim/road';
import { Autopilot, DEFAULT_AUTOPILOT } from '../src/game/autopilot';
import type { Vehicle } from '../src/sim/vehicle';

// out along +x for 100 m, then a 90 degree right-hander (radius 20) toward +z
function corner(): RoadData {
  const d: RoadData = { p: [], half_width: [], s: [], surface: [], surfaces: ['gravel'] };
  let s = 0;
  const push = (x: number, z: number) => {
    if (d.p.length) s += Math.hypot(x - d.p[d.p.length - 3], z - d.p[d.p.length - 1]);
    d.p.push(x, 0, z);
    d.half_width.push(3.5);
    d.s.push(s);
    d.surface.push(0);
  };
  for (let x = 0; x <= 100; x += 2) push(x, 0);
  for (let a = 1; a <= 16; a++) push(100 + 20 * Math.sin((a / 32) * Math.PI), 20 - 20 * Math.cos((a / 32) * Math.PI));
  for (let z = 22; z <= 120; z += 2) push(120, z);
  return d;
}

/** Just what the autopilot reads from the car. */
function car(x: number, z: number, yawDeg: number, kmh: number): Vehicle {
  return {
    position: new Vector3(x, 0, z), yawDeg, forwardSpeedKmh: kmh, bodySlipDeg: 0, wheelsInContact: 4,
    powerStrength: 0, powerUnder: 0, smoothedSteer: 0,
    wheels: [0, 1, 2, 3].map(() => ({ inContact: true, surface: 'gravel' })), weatherGrip: {},
  } as unknown as Vehicle;
}

describe('autopilot', () => {
  const road = new Road(corner());
  const tracker = new RoadTracker(road, 0, road.length);

  it('steers back toward the centreline (+ = right)', () => {
    const ap = new Autopilot(road, tracker);
    const left = car(20, -2, 0, 60); // left of the line, heading along it
    tracker.update(left.position, 0);
    expect(ap.drive(left, 1 / 120, 1).steer).toBeGreaterThan(0);
    tracker.reset();
    const right = car(20, 2, 0, 60);
    tracker.update(right.position, 0);
    expect(ap.drive(right, 1 / 120, 1).steer).toBeLessThan(0);
  });

  it('slows for the corner ahead and floors it on the straight', () => {
    const ap = new Autopilot(road, tracker, DEFAULT_AUTOPILOT);
    tracker.reset();
    const early = car(10, 0, 0, 100);
    tracker.update(early.position, 0);
    expect(ap.drive(early, 1 / 120, 1).throttle).toBe(1);
    expect(ap.last.vmax).toBe(120);
    tracker.reset();
    const late = car(80, 0, 0, 100); // 20 m before a 90 degree turn
    tracker.update(late.position, 0);
    const input = ap.drive(late, 1 / 120, 1);
    expect(ap.last.turn).toBeGreaterThan(80);
    expect(ap.last.vmax).toBeCloseTo(120 * DEFAULT_AUTOPILOT.minTurn, 0);
    expect(input.throttle).toBe(0);
    expect(input.brake).toBeGreaterThan(0.2);
  });
});

describe('autopilot in weather', () => {
  it('drives at sqrt(weather grip) of its speed on the surface under most wheels', () => {
    // on the straight, far enough from the corner that the longer look-ahead (60 m / grip) doesn't reach it
    const road = new Road(corner());
    const tracker = new RoadTracker(road, 0, 300);
    const ap = new Autopilot(road, tracker, { ...DEFAULT_AUTOPILOT, kmh: 120 });
    const v = car(2, 0, 0, 60);
    tracker.update(v.position, 1 / 120);
    ap.drive(v, 1 / 120, 1);
    const clear = ap.last.vmax;
    (v as unknown as { weatherGrip: Record<string, number> }).weatherGrip = { gravel: 0.64 };
    ap.drive(v, 1 / 120, 1);
    expect(ap.last.vmax).toBeCloseTo(clear * 0.8);
  });
});
