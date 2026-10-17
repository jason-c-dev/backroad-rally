// The ghost codec (src/game/ghostCodec.ts): every shipped rival line decodes, re-encodes to the same raw bytes,
// and a recorded run round-trips bit-exactly through zlib and base64.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_SAMPLE, type GhostSample, fromBase64, indexAtProgress, maxProgress, pack, packRaw, quantAngle, quatToRotator, rotatorToQuat,
  sampleTrack, toBase64, unpack, unpackRaw, unzlib,
} from '../src/game/ghostCodec';

const DATA = new URL('../public/data/rival_lines/', import.meta.url);
const STAGES = ['finland', 'japan', 'alps', 'wales', 'arizona', 'vermont'];
const index = JSON.parse(readFileSync(new URL('index.json', DATA), 'utf8')) as Record<string, { car: string; time: number; samples: number }>;

interface Line { stage: string; dir: string; car: string; time: number; run_length_m: number; hz: number; num: number; raw_bytes: number; packed: string }
const line = (key: string) => JSON.parse(readFileSync(new URL(`${key}.json`, DATA), 'utf8')) as Line;

describe('ghost codec: the shipped rival lines', () => {
  for (const stage of STAGES) {
    for (const dir of ['fwd', 'rev']) {
      const key = `${stage}_${dir}`;
      it(`${key} decodes and re-encodes bit-exactly`, async () => {
        const j = line(key);
        expect(j.raw_bytes).toBe(j.num * BYTES_PER_SAMPLE);
        // index.json is the record of which car drove each line
        expect(j.car).toBe(index[key].car);
        expect(j.num).toBe(index[key].samples);
        const packed = fromBase64(j.packed)!;
        const raw = await unzlib(packed);
        expect(raw.length).toBe(j.raw_bytes);
        const s = (await unpack(packed, j.raw_bytes, j.num))!;
        expect(s.length).toBe(j.num);
        // the decoded samples encode back to the same bytes
        expect(Buffer.from(packRaw(s)).equals(Buffer.from(raw))).toBe(true);
        // a sane line: starts near progress 0, reaches the run length about at the recorded time, 15 Hz
        expect(j.hz).toBe(15);
        expect(s[0].progress).toBeLessThan(5);
        const mp = maxProgress(s);
        expect(mp[mp.length - 1]).toBeGreaterThanOrEqual(j.run_length_m - 1);
        const crossT = indexAtProgress(mp, j.run_length_m - 0.01) / j.hz; // progress holds at the run length past the line
        expect(Math.abs(crossT - j.time)).toBeLessThan(0.15);
        // no teleports in a clean reference run
        let maxStep = 0;
        for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y));
        expect(maxStep).toBeLessThan(1500);
      });
    }
  }
});

/** A made-up run: a curving road, wrapping yaw, a recover jump and steer past the int8 range. */
function recorded(n = 1500): GhostSample[] {
  const out: GhostSample[] = [];
  let x = 12345.6, y = -54321.2, yaw = 170;
  for (let i = 0; i < n; i++) {
    yaw += 0.9 * Math.sin(i / 40);
    x += 250 * Math.cos((yaw * Math.PI) / 180) / 15;
    y += 250 * Math.sin((yaw * Math.PI) / 180) / 15;
    if (i === 700) x -= 2600; // a recover: back 26 m
    out.push({ x, y, z: 3000 + 40 * Math.sin(i / 90), yaw, pitch: 3 * Math.sin(i / 17), roll: -2 * Math.cos(i / 23), steer: 70 * Math.sin(i / 30), progress: i * 1.66 });
  }
  return out;
}

describe('ghost codec: a recorded run', () => {
  it('quantises like the original (cm, 1/182 deg wrapping, 0.5 deg steer clamped, dm)', () => {
    expect(quantAngle(180)).toBe(-32768);
    expect(quantAngle(-180)).toBe(-32768);
    expect(quantAngle(359.99)).toBe(quantAngle(-0.01));
    expect(quantAngle(90)).toBe(16384);
    const s = unpackRaw(packRaw([{ x: 1.5, y: -1.5, z: 0.49, yaw: 190, pitch: 0, roll: 0, steer: 80, progress: 12.34 }]), 1)![0];
    expect([s.x, s.y, s.z]).toEqual([2, -1, 0]);
    expect(s.yaw).toBeCloseTo(-170, 2);
    expect(s.steer).toBe(63.5);
    expect(s.progress).toBeCloseTo(12.3, 5);
  });

  it('round-trips through zlib and base64 bit-exactly, at about 23 B raw per sample', async () => {
    const run = recorded();
    const p = await pack(run);
    expect(p.rawBytes).toBe(run.length * 23);
    expect(p.packed.length).toBeLessThan(p.rawBytes / 2);
    const back = (await unpack(fromBase64(toBase64(p.packed))!, p.rawBytes, p.num))!;
    // decoding is the quantisation: a second pass is the identity, byte for byte
    expect(Buffer.from(packRaw(back)).equals(Buffer.from(packRaw(run)))).toBe(true);
    const again = (await unpack((await pack(back)).packed, p.rawBytes, p.num))!;
    expect(again).toEqual(back);
    for (let i = 0; i < run.length; i += 97) {
      expect(Math.abs(back[i].x - run[i].x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(back[i].progress - run[i].progress)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('reads a raw track (packed length == raw_bytes) and refuses a wrong size', async () => {
    const run = recorded(10);
    const raw = packRaw(run);
    expect(await unpack(raw, raw.length, 10)).toEqual(unpackRaw(raw, 10));
    expect(await unpack(raw, raw.length, 11)).toBeNull();
    expect(await unpack(new Uint8Array([1, 2, 3]), raw.length, 10)).toBeNull();
  });

  it('plays back Catmull-Rom, but snaps across a jump over 15 m', () => {
    const run = unpackRaw(packRaw(recorded()), 1500)!;
    const out = { ...run[0] };
    sampleTrack(run, 15, 100 / 15, out);
    expect(out.x).toBeCloseTo(run[100].x, 3);
    sampleTrack(run, 15, 100.5 / 15, out);
    const mid = (run[100].x + run[101].x) / 2;
    expect(Math.abs(out.x - mid)).toBeLessThan(5);
    // the recover between samples 699 and 700: no curve through the jump
    sampleTrack(run, 15, 699.4 / 15, out);
    expect(out.x).toBe(run[699].x);
    sampleTrack(run, 15, 699.6 / 15, out);
    expect(out.x).toBe(run[700].x);
  });

  it('converts rotators like UE (quat and back)', () => {
    for (const r of [[10, 20, 30], [-170, 5, -3], [179, -45, 60]]) {
      const back = quatToRotator(rotatorToQuat(r[0], r[1], r[2]));
      back.forEach((v, i) => expect(v).toBeCloseTo(r[i], 4));
    }
  });
});
