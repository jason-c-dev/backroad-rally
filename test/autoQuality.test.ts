import { describe, expect, it } from 'vitest';
import { AutoQuality, LADDER, initialRung, type Rung } from '../src/look/autoQuality';

/** Feed `seconds` of frames of `dt` ms (GPU `gpu` ms); returns every switch made. */
function run(a: AutoQuality, seconds: number, dt: number | ((a: AutoQuality) => number), gpu = 0): Rung[] {
  const out: Rung[] = [];
  for (let t = 0; t < seconds * 1000;) {
    const d = typeof dt === 'number' ? dt : dt(a);
    t += d;
    const r = a.frame(d, gpu);
    if (r !== null) out.push(r);
  }
  return out;
}
const names = (rs: Rung[]) => rs.map((r) => `${r.tier}@${r.scale}`);

describe('auto quality', () => {
  it('guesses from the GPU and the screen', () => {
    expect(initialRung('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU, OpenGL 4.5)', 1920 * 1080)).toBe(0);
    expect(initialRung('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU, OpenGL 4.5)', 3840 * 1600)).toBe(1);
    expect(initialRung('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL ES 3.2)', 1920 * 1080)).toBe(2);
    expect(initialRung('ANGLE (Intel, Mesa Intel(R) Graphics, OpenGL ES 3.2)', 3840 * 1600)).toBe(4);
    expect(initialRung('Google SwiftShader', 1920 * 1080)).toBe(LADDER.length - 1);
    expect(initialRung('webgl2', 1920 * 1080)).toBe(1);
  });

  it('stays put at 60 fps and is settled after two clean windows', () => {
    const a = new AutoQuality(0);
    expect(a.settled).toBe(false);
    expect(run(a, 1.9, 16.67, 9)).toEqual([]);
    expect(a.settled).toBe(false);
    expect(run(a, 1, 16.67, 9)).toEqual([]);
    expect(a.settled).toBe(true);
    a.play();
    expect(run(a, 60, 16.67, 9)).toEqual([]);
  });

  it('ignores a jittery frame clock at a steady 60 fps (Firefox)', () => {
    const a = new AutoQuality(2);
    let i = 0;
    expect(run(a, 4, () => (i++ % 2 ? 21 : 12.4), 0)).toEqual([]);
    expect(a.settled).toBe(true);
  });

  it('walks the ladder while settling, behind the curtain', () => {
    const a = new AutoQuality(0);
    // 33 ms on the top two rungs, 60 fps from the third
    const sw = run(a, 8, (q) => (q.rung < 2 ? 33 : 16.67));
    expect(names(sw)).toEqual(['medium@1', 'low@1']);
    expect(a.settled).toBe(true);
    expect(a.rung).toBe(2);
  });

  it('steps down from a rung that only just holds', () => {
    const a = new AutoQuality(1);
    // a frame in five misses (~20% of the time): not bad, not clean
    let i = 0;
    const sw = run(a, 6, (q) => (q.rung === 1 && i++ % 5 === 0 ? 25 : 16.67));
    expect(names(sw)).toEqual(['low@1']);
    expect(a.settled).toBe(true);
  });

  it('steps down from a rung without GPU headroom, even when frames hold', () => {
    const a = new AutoQuality(1);
    // vsync-locked at 60 but the GPU at 15 ms of 16.7: driving will cost more than the start line
    const sw = run(a, 2.5, 16.67, 15);
    expect(names(sw)).toEqual(['low@1']);
    const b = new AutoQuality(1);
    expect(run(b, 6, 16.67, 9)).toEqual([]);
    expect(b.settled).toBe(true);
  });

  it('is not settled while it is still stepping', () => {
    const a = new AutoQuality(0);
    run(a, 2, 33);
    expect(a.rung).toBe(1);
    expect(a.settled).toBe(false);
  });

  it('only moves the render scale once playing, on sustained misses', () => {
    const a = new AutoQuality(1);
    run(a, 3, 16.67);
    a.play();
    run(a, 5, 16.67);
    // a 1.5 s heavy patch: no change, wherever the windows fall
    expect(run(a, 1.5, 25)).toEqual([]);
    expect(run(a, 6, 16.67)).toEqual([]);
    // sustained: the scale steps, the tier stays
    const sw = run(a, 7, 25);
    expect(names(sw)).toEqual(['medium@0.85']);
    expect(a.current).toEqual({ tier: 'medium', scale: 0.85 });
    // and on down to the smallest scale, never another tier
    const more = run(a, 60, 25);
    expect(names(more)).toEqual(['medium@0.7', 'medium@0.55']);
    expect(run(a, 30, 25)).toEqual([]);
  });

  it('steps the scale back up only with GPU headroom and never into a scale that failed', () => {
    const a = new AutoQuality(4); // low@70%
    run(a, 2, 16.67);
    a.play();
    expect(names(run(a, 40, 16.67, 4))).toEqual(['low@0.85']);
    expect(names(run(a, 40, 16.67, 4))).toEqual(['low@1']);
    // the tier never steps up in play
    expect(run(a, 120, 16.67, 4)).toEqual([]);
    const b = new AutoQuality(2);
    run(b, 2, 16.67);
    b.play();
    run(b, 10, 30); // 100% fails in play
    expect(b.current.scale).toBe(0.85);
    expect(run(b, 120, 16.67, 4)).toEqual([]); // never retries 100%
    // no GPU timer: never steps up
    const c = new AutoQuality(4);
    run(c, 2, 16.67);
    c.play();
    expect(run(c, 120, 16.67, 0)).toEqual([]);
  });
});
