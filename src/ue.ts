// UE data -> three.js, converted at load time only (handoff §2). Game code never sees cm.
//
// UE: centimetres, left-handed, X forward, Y right, Z up; yaw + turns X toward Y (right).
// three: metres, right-handed, Y up. Mapping: UE (X, Y, Z) -> three (X, Z, Y), so UE
// forward is three +X and UE right is three +Z.
import { Euler, Vector3 } from 'three/webgpu';

const DEG = Math.PI / 180;

/** UE position in centimetres -> three metres. */
export function pos(cm: ArrayLike<number>, out = new Vector3()): Vector3 {
  return out.set(cm[0] / 100, (cm[2] ?? 0) / 100, cm[1] / 100);
}

/** UE-axis position already in metres (testtrack.json) -> three metres. */
export function posM(m: ArrayLike<number>, out = new Vector3()): Vector3 {
  return out.set(m[0], m[2] ?? 0, m[1]);
}

/** UE yaw in degrees -> three rotation.y in radians. */
export function yaw(deg: number): number {
  return -deg * DEG;
}

/**
 * UE rotator (degrees) -> three Euler. UE applies roll, then pitch, then yaw
 * (R = Ryaw * Rpitch * Rroll); mirrored into three: yaw about Y negated, pitch about Z
 * (+ = nose up), roll about X (+ = right side down), order 'YZX'.
 */
export function rot(yawDeg: number, pitchDeg = 0, rollDeg = 0, out = new Euler()): Euler {
  return out.set(rollDeg * DEG, -yawDeg * DEG, pitchDeg * DEG, 'YZX');
}

/** Horizontal unit vector for a UE yaw (degrees). */
export function yawDir(deg: number, out = new Vector3()): Vector3 {
  return out.set(Math.cos(deg * DEG), 0, Math.sin(deg * DEG));
}

export const cm = (v: number) => v / 100;
export const kmh = (ms: number) => ms * 3.6;
export const ms = (kmhValue: number) => kmhValue / 3.6;
