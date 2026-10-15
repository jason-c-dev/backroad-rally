import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCarTuning, torqueShare } from '../src/sim/tuning';

const d = (f: string) => JSON.parse(readFileSync(`public/data/${f}`, 'utf8'));
const tuning = d('cars_tuning.json');

describe('car tuning', () => {
  it('deep-merges defaults with the car block', () => {
    const t = loadCarTuning(tuning, d('cars/swift.json'), 'swift');
    expect(t.massKg).toBe(870);
    expect(t.rear.friction).toBe(1.36);
    expect(t.rear.brake_torque).toBe(1800); // from defaults
    expect(t.drivetrain).toBe('RWD');
  });

  it('builds the traction-assist arcade block over the plain one', () => {
    const t = loadCarTuning(tuning, d('cars/swift.json'), 'swift');
    expect(t.arcade.tc_enabled).toBe(0);
    expect(t.arcadeAssist.tc_enabled).toBe(1);
    expect(t.arcadeAssist.power_rear_grip).toBe(0.78); // car's traction_assist override
    expect(t.arcadeAssist.steer_yaw_accel).toBe(t.arcade.steer_yaw_accel);
  });

  it('computes the final drive from the redline top speed', () => {
    const t = loadCarTuning(tuning, d('cars/swift.json'), 'swift');
    const wheelRpm = 160 / 3.6 / (2 * Math.PI * 0.29) * 60;
    expect(t.finalDrive).toBeCloseTo(7500 / wheelRpm / 1.0, 6);
  });

  it('reads the torque curve piecewise', () => {
    const t = loadCarTuning(tuning, d('cars/swift.json'), 'swift');
    expect(torqueShare(t, 0)).toBeCloseTo(0.55);
    expect(torqueShare(t, 0.75)).toBeCloseTo(1.0);
    expect(torqueShare(t, 0.65)).toBeCloseTo(0.975);
  });
});
