import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { pos, posM, rot, yaw, yawDir } from '../src/ue';

const close = (a: Vector3, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 6);
  expect(a.y).toBeCloseTo(b[1], 6);
  expect(a.z).toBeCloseTo(b[2], 6);
};

describe('ue.ts', () => {
  it('maps cm positions to metres with Y up', () => {
    close(pos([120, -65.5, 29]), [1.2, 0.29, -0.655]);
    close(posM([10, -300, 2]), [10, 2, -300]);
  });

  it('yaw +90 (a right turn) points UE X at UE Y', () => {
    const fwd = new Vector3(1, 0, 0).applyEuler(rot(90));
    close(fwd, [0, 0, 1]); // UE +Y = three +Z
    expect(yaw(90)).toBeCloseTo(-Math.PI / 2);
    close(yawDir(90), [0, 0, 1]);
  });

  it('pitch + is nose up, roll + is right side down', () => {
    close(new Vector3(1, 0, 0).applyEuler(rot(0, 90)), [0, 1, 0]);
    close(new Vector3(0, 0, 1).applyEuler(rot(0, 0, 90)), [0, -1, 0]);
  });

  it('matches UE rotator order (yaw after pitch)', () => {
    // UE: yaw 90, pitch 45 -> forward = (0, cos45, sin45) in UE = three (0, sin45, cos45)
    const s = Math.SQRT1_2;
    close(new Vector3(1, 0, 0).applyEuler(rot(90, 45)), [0, s, s]);
  });
});
