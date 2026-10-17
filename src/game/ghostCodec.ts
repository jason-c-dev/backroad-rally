// The ghost codec (handoff §11.3; the original's ARallyGhost::Pack / Unpack), shared by the best-run ghost and the
// rival reference lines (public/data/rival_lines/*.json). Ported byte for byte so the original's files load:
//
//   struct of arrays, little-endian, each channel delta-coded against the previous sample:
//     pos x, y, z      int32, centimetres (UE axes)          3 x N x 4 B
//     yaw, pitch, roll int16, 65536/360 units per degree,    3 x N x 2 B   (wrapping: the deltas wrap too)
//     steer            int8, 0.5 degree, NOT delta-coded         N x 1 B
//     progress         int32, decimetres                         N x 4 B
//   = 23 B per sample raw, then zlib (RFC 1950), then base64 in JSON. A `packed` whose length equals `raw_bytes`
//   is the raw data (the original's fallback when compression fails).
//
// Samples stay in UE units here (cm, degrees, UE rotator); src/game/ghost.ts converts for drawing.

export interface GhostSample {
  /** UE centimetres (X forward, Y right, Z up). */
  x: number;
  y: number;
  z: number;
  /** UE rotator, degrees. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Front-wheel steer, degrees (+ = right). */
  steer: number;
  /** Stage progress, metres from the start line. */
  progress: number;
}

export const BYTES_PER_SAMPLE = 3 * 4 + 3 * 2 + 1 + 4;
const ROT_QUANT = 65536 / 360;

/** UE FMath::RoundToInt: floor(x + 0.5) (Math.round is the same for every finite x). */
const roundToInt = (v: number) => Math.floor(v + 0.5);

/** UE FRotator::NormalizeAxis: (-180, 180]. */
export function normalizeAxis(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  if (a > 180) a -= 360;
  return a;
}

/** UE QuantAngle: (int16)(uint16)(int32)round(normalized deg x 65536/360). */
export function quantAngle(deg: number): number {
  return (roundToInt(normalizeAxis(deg) * ROT_QUANT) << 16) >> 16;
}

export const angleOf = (q: number): number => q / ROT_QUANT;

/** The raw (uncompressed) struct-of-arrays bytes of a track. */
export function packRaw(samples: readonly GhostSample[]): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(n * BYTES_PER_SAMPLE);
  const v = new DataView(buf);
  let o = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    let last = 0;
    for (const s of samples) {
      const q = roundToInt(s[axis]);
      v.setInt32(o, (q - last) | 0, true);
      o += 4;
      last = q;
    }
  }
  for (const axis of ['yaw', 'pitch', 'roll'] as const) {
    let last = 0;
    for (const s of samples) {
      const q = quantAngle(s[axis]);
      v.setInt16(o, ((q - last) << 16) >> 16, true);
      o += 2;
      last = q;
    }
  }
  for (const s of samples) {
    v.setInt8(o, Math.min(Math.max(roundToInt(s.steer * 2), -127), 127));
    o += 1;
  }
  let last = 0;
  for (const s of samples) {
    const q = roundToInt(s.progress * 10);
    v.setInt32(o, (q - last) | 0, true);
    o += 4;
    last = q;
  }
  return new Uint8Array(buf);
}

/** Raw bytes -> samples (null when the size is wrong for `n`). */
export function unpackRaw(raw: Uint8Array, n: number): GhostSample[] | null {
  if (n <= 0 || raw.length !== n * BYTES_PER_SAMPLE) return null;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: GhostSample[] = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, progress: 0 }));
  let o = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc = (acc + v.getInt32(o, true)) | 0;
      o += 4;
      out[i][axis] = acc;
    }
  }
  for (const axis of ['yaw', 'pitch', 'roll'] as const) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc = ((acc + v.getInt16(o, true)) << 16) >> 16;
      o += 2;
      out[i][axis] = angleOf(acc);
    }
  }
  for (let i = 0; i < n; i++) {
    out[i].steer = v.getInt8(o) * 0.5;
    o += 1;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc + v.getInt32(o, true)) | 0;
    o += 4;
    out[i].progress = acc * 0.1;
  }
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** zlib (RFC 1950: the original's NAME_Zlib), the browser's own CompressionStream('deflate'). */
export const zlib = (raw: Uint8Array) => pipe(raw, new CompressionStream('deflate'));
export const unzlib = (packed: Uint8Array) => pipe(packed, new DecompressionStream('deflate'));

export interface PackedTrack {
  packed: Uint8Array;
  rawBytes: number;
  num: number;
}

/** Samples -> zlib-packed bytes (raw when compression fails or doesn't shrink it: rawBytes == packed length). */
export async function pack(samples: readonly GhostSample[]): Promise<PackedTrack> {
  const raw = packRaw(samples);
  let packed = raw;
  try {
    const z = await zlib(raw);
    if (z.length < raw.length) packed = z;
  } catch {
    // keep it raw
  }
  return { packed, rawBytes: raw.length, num: samples.length };
}

/** Packed bytes -> samples; null when it doesn't decode to exactly `num` samples. */
export async function unpack(packed: Uint8Array, rawBytes: number, num: number): Promise<GhostSample[] | null> {
  if (num <= 0 || rawBytes !== num * BYTES_PER_SAMPLE) return null;
  let raw: Uint8Array;
  if (packed.length === rawBytes) raw = packed;
  else {
    try {
      raw = await unzlib(packed);
    } catch {
      return null;
    }
  }
  return unpackRaw(raw, num);
}

// ------------------------------------------------------------------ base64 (the JSON and the save carry it)

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ playback (ARallyGhost::SampleTrack)

const JUMP_CM = 1500;

/**
 * The track at time t (s): Catmull-Rom on position (15 Hz straight segments cut the corners), except across a
 * jump of more than 15 m (a recover or a reset: it snaps at the half), slerped rotation, lerped steer and progress.
 * Rotation comes back as a UE rotator; `out` is reused.
 */
export function sampleTrack(track: readonly GhostSample[], hz: number, t: number, out: GhostSample, q?: { a: Quat; b: Quat }): boolean {
  const n = track.length;
  if (n < 2) return false;
  const f = Math.max(0, t) * hz;
  const i1 = Math.min(Math.max(Math.floor(f), 0), n - 1);
  const i2 = Math.min(i1 + 1, n - 1);
  const i0 = Math.max(i1 - 1, 0);
  const i3 = Math.min(i2 + 1, n - 1);
  const a = Math.min(Math.max(f - i1, 0), 1);
  const s1 = track[i1], s2 = track[i2];
  const dx = s1.x - s2.x, dy = s1.y - s2.y, dz = s1.z - s2.z;
  if (dx * dx + dy * dy + dz * dz < JUMP_CM * JUMP_CM) {
    const p0 = track[i0], p3 = track[i3];
    const a2 = a * a, a3 = a2 * a;
    for (const k of ['x', 'y', 'z'] as const) {
      out[k] = 0.5 * (2 * s1[k] + (-p0[k] + s2[k]) * a + (2 * p0[k] - 5 * s1[k] + 4 * s2[k] - p3[k]) * a2 + (-p0[k] + 3 * s1[k] - 3 * s2[k] + p3[k]) * a3);
    }
  } else {
    const s = a < 0.5 ? s1 : s2;
    out.x = s.x;
    out.y = s.y;
    out.z = s.z;
  }
  const qa = rotatorToQuat(s1.yaw, s1.pitch, s1.roll, q?.a);
  const qb = rotatorToQuat(s2.yaw, s2.pitch, s2.roll, q?.b);
  slerp(qa, qb, a);
  const r = quatToRotator(qa);
  out.yaw = r[0];
  out.pitch = r[1];
  out.roll = r[2];
  out.steer = s1.steer + (s2.steer - s1.steer) * a;
  out.progress = s1.progress + (s2.progress - s1.progress) * a;
  return true;
}

// UE's FRotator <-> FQuat (left-handed, Z up), so slerps run in the original's own space.
export type Quat = [number, number, number, number];
const D2R = Math.PI / 180;

export function rotatorToQuat(yaw: number, pitch: number, roll: number, out: Quat = [0, 0, 0, 1]): Quat {
  const sp = Math.sin(pitch * D2R * 0.5), cp = Math.cos(pitch * D2R * 0.5);
  const sy = Math.sin(yaw * D2R * 0.5), cy = Math.cos(yaw * D2R * 0.5);
  const sr = Math.sin(roll * D2R * 0.5), cr = Math.cos(roll * D2R * 0.5);
  out[0] = cr * sp * sy - sr * cp * cy;
  out[1] = -cr * sp * cy - sr * cp * sy;
  out[2] = cr * cp * sy - sr * sp * cy;
  out[3] = cr * cp * cy + sr * sp * sy;
  return out;
}

export function quatToRotator(q: Quat): [number, number, number] {
  const [X, Y, Z, W] = q;
  const singularity = Z * X - W * Y;
  const yawY = 2 * (W * Z + X * Y);
  const yawX = 1 - 2 * (Y * Y + Z * Z);
  const yaw = Math.atan2(yawY, yawX) / D2R;
  const T = 0.4999995;
  if (singularity < -T) return [yaw, -90, normalizeAxis(-yaw - 2 * Math.atan2(X, W) / D2R)];
  if (singularity > T) return [yaw, 90, normalizeAxis(yaw - 2 * Math.atan2(X, W) / D2R)];
  const pitch = Math.asin(Math.min(Math.max(2 * singularity, -1), 1)) / D2R;
  const roll = Math.atan2(-2 * (W * X + Y * Z), 1 - 2 * (X * X + Y * Y)) / D2R;
  return [yaw, pitch, roll];
}

/** a = slerp(a, b, t), shortest path. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = cos < 0 ? -1 : 1;
  cos *= sign;
  let ka: number, kb: number;
  if (cos > 0.9999) {
    ka = 1 - t;
    kb = t * sign;
  } else {
    const om = Math.acos(cos), so = Math.sin(om);
    ka = Math.sin((1 - t) * om) / so;
    kb = (Math.sin(t * om) / so) * sign;
  }
  for (let i = 0; i < 4; i++) a[i] = a[i] * ka + b[i] * kb;
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  for (let i = 0; i < 4; i++) a[i] /= l;
  return a;
}

/** Running maximum of progress (a recover can step back), for "time at this progress" lookups. */
export function maxProgress(track: readonly GhostSample[]): Float32Array {
  const m = new Float32Array(track.length);
  let v = 0;
  for (let i = 0; i < track.length; i++) m[i] = v = Math.max(v, track[i].progress);
  return m;
}

/** Fractional sample index at a progress (m) (FRallyRefLine::IndexAtProgress). */
export function indexAtProgress(maxProg: ArrayLike<number>, p: number): number {
  const n = maxProg.length;
  if (n < 2 || p <= maxProg[0]) return 0;
  if (p >= maxProg[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (maxProg[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const p0 = maxProg[i - 1], p1 = maxProg[i];
  const a = p1 > p0 ? Math.min(Math.max((p - p0) / (p1 - p0), 0), 1) : 1;
  return i - 1 + a;
}
