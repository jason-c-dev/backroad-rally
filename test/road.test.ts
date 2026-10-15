import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Road, RoadTracker, type RoadData } from '../src/sim/road';

// a straight road along +x (UE +X), 2 m samples, 4 m half width
function straight(n = 101): RoadData {
  const d: RoadData = { p: [], half_width: [], s: [], surface: [], surfaces: ['gravel'] };
  for (let i = 0; i < n; i++) {
    d.p.push(i * 2, 0, 0);
    d.half_width.push(4);
    d.s.push(i * 2);
    d.surface.push(0);
  }
  return d;
}

// a hairpin: out along +x, a half circle (radius 10) to the right (+z), back along -x
function hairpin(): RoadData {
  const d: RoadData = { p: [], half_width: [], s: [], surface: [], surfaces: ['gravel'] };
  let s = 0;
  const push = (x: number, z: number) => {
    if (d.p.length) s += Math.hypot(x - d.p[d.p.length - 3], z - d.p[d.p.length - 1]);
    d.p.push(x, 0, z);
    d.half_width.push(3);
    d.s.push(s);
    d.surface.push(0);
  };
  for (let x = 0; x <= 60; x += 2) push(x, 0);
  for (let a = 1; a < 16; a++) push(60 + 10 * Math.sin((a / 16) * Math.PI), 10 - 10 * Math.cos((a / 16) * Math.PI));
  for (let x = 60; x >= 0; x -= 2) push(x, 20);
  return d;
}

describe('road', () => {
  it('projects onto the centreline with lateral + to the right', () => {
    const r = new Road(straight());
    const p = r.project(new Vector3(51, 0.5, 2.5));
    expect(p.s).toBeCloseTo(51, 5);
    expect(p.lateral).toBeCloseTo(2.5, 5); // +z is the right of +x
    expect(p.height).toBeCloseTo(0.5, 5);
  });

  it('poses the car on the road facing the travel direction', () => {
    const r = new Road(straight());
    const fwd = r.pose(20, 1);
    expect(fwd.position.x).toBeCloseTo(20);
    expect(fwd.yawDeg).toBeCloseTo(0);
    const rev = r.pose(20, -1, 1);
    expect(Math.abs(rev.yawDeg)).toBeCloseTo(180);
    expect(rev.position.z).toBeCloseTo(-1); // right of -x is -z
  });

  it('keeps hairpin legs apart by searching near the previous index', () => {
    const r = new Road(hairpin());
    const t = new RoadTracker(r, 0, r.s[r.n - 1]);
    // drive the outbound leg; the return leg is only 20 m away
    for (let x = 0; x <= 50; x += 1) t.update(new Vector3(x, 0, 2), 1 / 60);
    expect(t.proj!.s).toBeCloseTo(50, 0);
    // a cold projection would happily pick the nearer leg
    expect(Math.abs(r.project(new Vector3(50, 0, 11)).lateral)).toBeLessThan(10);
  });

  it('detects the finish crossing inside the corridor only', () => {
    const r = new Road(straight());
    const t = new RoadTracker(r, 10, 150);
    for (let x = 140; x <= 152; x += 0.5) t.update(new Vector3(x, 0, 0), 1 / 60);
    expect(t.crossedFinish).toBe(true);
    const t2 = new RoadTracker(r, 10, 150);
    for (let x = 140; x <= 152; x += 0.5) t2.update(new Vector3(x, 0, 30), 1 / 60);
    expect(t2.crossedFinish).toBe(false);
  });

  it('resets off-road after the grace, a few metres back', () => {
    const r = new Road(straight());
    const t = new RoadTracker(r, 10, 150);
    t.update(new Vector3(80, 0, 0), 1 / 60);
    let out: string | null = null;
    for (let i = 0; i < 30 && !out; i++) out = t.update(new Vector3(80, 0, 20), 1 / 60);
    expect(out).toBe('offroad');
    const pose = t.resetPose(new Vector3(80, 0, 20));
    expect(pose.position.x).toBeCloseTo(76, 0);
    expect(pose.position.z).toBeCloseTo(0, 5);
  });

  it('starts the car 6 m behind the start line', () => {
    const r = new Road(straight());
    expect(new RoadTracker(r, 10, 150).startPose().position.x).toBeCloseTo(4);
    expect(new RoadTracker(r, 150, 10).startPose().position.x).toBeCloseTo(156);
  });
});
