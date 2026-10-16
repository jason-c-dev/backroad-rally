import { describe, expect, it } from 'vitest';
import { AutoQuality, LADDER, initialRung } from '../src/look/autoQuality';

/** Feed `seconds` of frames of `dt` ms (GPU `gpu` ms); returns every switch made. */
function run(a: AutoQuality, seconds: number, dt: number | ((rung: number) => number), gpu = 0): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds * 1000;) {
    const d = typeof dt === 'number' ? dt : dt(a.rung);
    t += d;
    const r = a.frame(d, gpu);
    if (r !== null) out.push(r);
  }
  return out;
}

describe('auto quality', () => {
  it('guesses from the GPU and the screen', () => {
    expect(initialRung('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU, OpenGL 4.5)', 1920 * 1080)).toBe(0);
    expect(initialRung('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU, OpenGL 4.5)', 3840 * 1600)).toBe(1);
    expect(initialRung('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL ES 3.2)', 1920 * 1080)).toBe(2);
    expect(initialRung('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL ES 3.2)', 3840 * 1600)).toBe(4);
    expect(initialRung('Google SwiftShader', 1920 * 1080)).toBe(LADDER.length - 1);
    expect(initialRung('webgl2', 1920 * 1080)).toBe(1);
  });

  it('stays put at 60 fps', () => {
    const a = new AutoQuality(0);
    expect(run(a, 60, 16.67, 9)).toEqual([]);
  });

  it('settles fast while starting, then holds', () => {
    const a = new AutoQuality(0);
    // 33 ms on the top two rungs, 60 fps from the third
    const sw = run(a, 30, (r) => (r < 2 ? 33 : 16.67));
    expect(sw).toEqual([1, 2]);
    expect(a.rung).toBe(2);
    expect(a.log.length).toBe(2);
  });

  it('steps down in play only on sustained misses', () => {
    const a = new AutoQuality(2);
    run(a, 15, 16.67); // settled
    // a 1.5 s heavy patch: no change, wherever the windows fall
    expect(run(a, 1.5, 25)).toEqual([]);
    expect(run(a, 6, 16.67)).toEqual([]);
    // sustained: one step
    expect(run(a, 7, 25).length).toBe(1);
    expect(a.rung).toBe(3);
  });

  it('steps up only with GPU headroom and never back into a failed rung', () => {
    const a = new AutoQuality(1);
    // vsync-locked but plenty of GPU headroom: up to the top after the hold time
    expect(run(a, 40, 16.67, 4)).toEqual([0]);
    const b = new AutoQuality(0);
    run(b, 5, 30); // rung 0 fails while settling
    expect(b.rung).toBe(1);
    expect(run(b, 120, 16.67, 4)).toEqual([]); // never retries rung 0
    // no GPU timer: never steps up
    const c = new AutoQuality(2);
    expect(run(c, 120, 16.67, 0)).toEqual([]);
  });
});
