import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { Emitter, events } from '../src/game/events';
import { CarEvents } from '../src/game/carEvents';
import { Pool, chipGeometry, icosphere } from '../src/fx/pool';
import { SkidMarks } from '../src/fx/skids';
import { Exhaust } from '../src/fx/exhaust';
import { CarFx } from '../src/fx/carFx';
import { Rng, hexLinear, ramp, type FxJson } from '../src/fx/config';
import type { Vehicle } from '../src/sim/vehicle';

const cfg = JSON.parse(readFileSync(new URL('../public/data/fx.json', import.meta.url), 'utf8')) as FxJson;
const mat = new THREE.MeshBasicNodeMaterial();

/** The parts of a Vehicle the effects and the events read. */
function fakeVehicle(): Vehicle {
  const wheel = (x: number, z: number) => ({
    inContact: true, surface: 'gravel', contactPoint: new THREE.Vector3(x, 0, z), normal: new THREE.Vector3(0, 1, 0),
    compression: 0, load: 0, omega: 0, angle: 0, latSlipCms: 0, longSlipCms: 0, slipAngleDeg: 0, groundSpeedCms: 0, arcadeGrip: 1,
  });
  const v = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), forward: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0), wheels: [wheel(1.2, -0.7), wheel(1.2, 0.7), wheel(-1.2, -0.7), wheel(-1.2, 0.7)],
    wheelsInContact: 4, rpm: 1000, gear: 1, input: { throttle: 0, brake: 0, steer: 0, digitalSteer: false, handbrake: false },
    t: { maxRpm: 7000 },
    get speedKmh() {
      return v.velocity.length() * 3.6;
    },
  };
  return v as unknown as Vehicle;
}

describe('events', () => {
  it('delivers to listeners, unsubscribes, and survives a throwing listener', () => {
    const e = new Emitter<{ a: { n: number } }>();
    const got: number[] = [];
    const off = e.on('a', (x) => got.push(x.n));
    e.on('a', () => {
      throw new Error('listener bug');
    });
    const err = console.error;
    console.error = () => {};
    e.emit('a', { n: 1 });
    console.error = err;
    off();
    e.emit('a', { n: 2 });
    expect(got).toEqual([1]);
    expect(e.count('a')).toBe(1);
  });
});

describe('fx config', () => {
  it('ramps like the original FxRamp', () => {
    expect(ramp(12, 12, 110)).toBe(0);
    expect(ramp(61, 12, 110)).toBeCloseTo(0.5);
    expect(ramp(200, 12, 110)).toBe(1);
    expect(ramp(5, 5, 5)).toBe(1); // a step when full <= start
  });
  it('decodes sRGB hex to linear', () => {
    const c = hexLinear('#D9B98F');
    expect(c.r).toBeCloseTo(0.693, 2);
    expect(c.b).toBeCloseTo(0.275, 2);
  });
  it('has the pool sizes of the spec', () => {
    expect(Object.fromEntries(Object.entries(cfg.pools).map(([k, v]) => [k, v.size]))).toEqual({ puff: 512, chip: 1536, spark: 384, flame: 256, dust: 3072 });
  });
});

describe('pool', () => {
  it('compacts live particles, recycles the oldest when full, and uploads only the front', () => {
    const p = new Pool('t', 4, icosphere(1, 0.05, new Rng(1), true), mat, new Rng(2));
    for (let i = 0; i < 6; i++) p.emit({ x: i, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: i < 5 ? 1 : 0.1, size0: 1, size1: 2, r: 1, g: 1, b: 1 });
    p.update(0.05);
    expect(p.alive).toBe(4);
    expect(p.mesh.geometry.instanceCount).toBe(4);
    const a = p.mesh.geometry.getAttribute('fx_a') as THREE.InstancedBufferAttribute;
    expect(a.updateRanges).toEqual([{ start: 0, count: 16 }]);
    // slots 0 and 1 were recycled by particles 4 and 5 (x = 4, 5)
    expect([...a.array].filter((_, k) => k % 4 === 0).sort()).toEqual([2, 3, 4, 5]);
    p.update(0.1); // the 0.1 s one dies
    expect(p.alive).toBe(3);
  });
  it('grows size from size0 to size1 and fades out', () => {
    const p = new Pool('t', 2, chipGeometry(), mat, new Rng(3));
    p.emit({ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 3, r: 1, g: 1, b: 1, opacity: 0.5, fadeIn: 0.01, fadeOutStart: 0.5 });
    p.update(0.75);
    const a = p.mesh.geometry.getAttribute('fx_a').array, c = p.mesh.geometry.getAttribute('fx_c').array;
    expect(a[3]).toBeCloseTo(1 + 2 * (1 - 0.25 * 0.25)); // ease-out growth
    expect(c[3]).toBeCloseTo(0.5 * 0.5); // half way through the fade-out
  });
  it('lands particles on their floor and stops them', () => {
    const p = new Pool('t', 1, chipGeometry(), mat, new Rng(4));
    p.emit({ x: 0, y: 0.5, z: 0, vx: 1, vy: 0, vz: 0, life: 5, size0: 0.1, size1: 0.1, r: 1, g: 1, b: 1, gravity: 9.8, floorY: 0 });
    for (let i = 0; i < 120; i++) p.update(1 / 60);
    const a = p.mesh.geometry.getAttribute('fx_a').array;
    expect(a[1]).toBe(0);
    const x = a[0];
    p.update(0.5);
    expect(a[0]).toBe(x);
  });
});

describe('skid marks', () => {
  it('writes a ring and uploads only what changed, in two ranges when it wraps', () => {
    const s = new SkidMarks(4, mat, 0.025);
    const n = new THREE.Vector3(0, 1, 0), col = new THREE.Color(0.1, 0.1, 0.1);
    for (let i = 0; i < 3; i++) s.add(new THREE.Vector3(i, 0, 0), new THREE.Vector3(i + 0.35, 0, 0), n, 0.2, col, 0.6, i);
    s.update();
    const at = s.mesh.geometry.getAttribute('sk_a') as THREE.InstancedBufferAttribute;
    expect(at.updateRanges).toEqual([{ start: 0, count: 12 }]);
    for (let i = 3; i < 6; i++) s.add(new THREE.Vector3(i, 0, 0), new THREE.Vector3(i + 0.35, 0, 0), n, 0.2, col, 0.6, i);
    s.update();
    expect(at.updateRanges).toEqual([{ start: 12, count: 4 }, { start: 0, count: 8 }]);
    expect(s.mesh.geometry.instanceCount).toBe(4);
    // lifted 2.5 cm along the normal, spawn time in sk_c.w
    expect(at.array[1]).toBeCloseTo(0.025);
    expect(s.mesh.geometry.getAttribute('sk_c').array[3]).toBe(4);
  });
});

describe('car effects', () => {
  const pools = () => ({
    dust: new Pool('dust', 3072, icosphere(1, 0.05, new Rng(1), true), mat, new Rng(5)),
    chip: new Pool('chip', 1536, chipGeometry(), mat, new Rng(6)),
    spark: new Pool('spark', 384, chipGeometry(), mat, new Rng(7)),
  });
  it('raises dust on gravel from 12 km/h, more with slip, and chips only when sliding', () => {
    const v = fakeVehicle();
    const P = pools(), skids = new SkidMarks(64, mat, 0.025);
    const fx = new CarFx(cfg, P, skids, new Rng(8), 0.19);
    v.velocity.set(10 / 3.6, 0, 0); // 10 km/h: below the dust threshold
    fx.update(v, 1, 0, false);
    expect(P.dust.spawned).toBe(0);
    v.velocity.set(100 / 3.6, 0, 0);
    fx.update(v, 1, 0, false);
    const straight = P.dust.spawned;
    // 4 wheels x 16/s x rate_scale 2.4 x speed ramp 0.89 ~ 137 a second
    expect(straight).toBeGreaterThan(120);
    expect(straight).toBeLessThan(150);
    expect(P.chip.spawned).toBe(0);
    for (const w of v.wheels) w.latSlipCms = 700;
    fx.update(v, 1, 0, false);
    expect(P.dust.spawned - straight).toBeGreaterThan(straight * 2); // x (1 + 1.3)
    expect(P.chip.spawned).toBeGreaterThan(150);
  });
  it('lays skid marks while sliding, 35 cm per segment, and none across a teleport', () => {
    const v = fakeVehicle();
    const skids = new SkidMarks(256, mat, 0.025);
    const fx = new CarFx(cfg, pools(), skids, new Rng(9), 0.19);
    v.velocity.set(20, 0, 0);
    for (const w of v.wheels) w.latSlipCms = 600;
    for (let i = 0; i < 20; i++) {
      v.position.x += 0.2;
      for (const w of v.wheels) w.contactPoint.x += 0.2;
      fx.update(v, 0.01, i * 0.01, false);
    }
    // 4 wheels over 4 m (the first frame starts each mark) -> ~10 segments each
    expect(skids.placed).toBeGreaterThanOrEqual(36);
    expect(skids.placed).toBeLessThanOrEqual(44);
    const before = skids.placed;
    v.position.x += 100;
    for (const w of v.wheels) w.contactPoint.x += 100;
    fx.update(v, 0.01, 1, false);
    expect(skids.placed).toBe(before);
  });
});

describe('car events', () => {
  it('emits a landing after 0.3 s in the air, not after a hop', () => {
    const v = fakeVehicle();
    const ce = new CarEvents();
    const got: number[] = [];
    const off = events.on('landing', (e) => got.push(e.airTime));
    const dt = 1 / 120;
    ce.step(v, dt);
    const fly = (s: number) => {
      v.wheelsInContact = 0;
      for (let t = 0; t < s; t += dt) {
        v.velocity.y -= 9.81 * dt;
        ce.step(v, dt);
      }
      v.wheelsInContact = 4;
      v.velocity.y = 0;
      ce.step(v, dt);
    };
    fly(0.2);
    fly(0.6);
    off();
    expect(got.length).toBe(1);
    expect(got[0]).toBeGreaterThan(0.55);
  });
  it('emits one merged impact for a crash, none for a landing or a teleport', () => {
    const v = fakeVehicle();
    const ce = new CarEvents();
    const got: { speed: number; hard: boolean }[] = [];
    const off = events.on('impact', (e) => got.push(e));
    const dt = 1 / 120;
    v.velocity.set(20, 0, 0);
    ce.step(v, dt);
    // a fall, then a hard landing: the ground stops it by pushing the car up
    for (let i = 0; i < 70; i++) {
      v.velocity.y -= 9.81 * dt;
      ce.step(v, dt);
    }
    v.velocity.y = 0;
    for (let i = 0; i < 40; i++) ce.step(v, dt);
    expect(got.length).toBe(0);
    // a tree: 20 m/s to 2 m/s over three steps
    for (const s of [10, 4, 2]) {
      v.velocity.x = s;
      ce.step(v, dt);
    }
    for (let i = 0; i < 40; i++) ce.step(v, dt);
    expect(got.length).toBe(1);
    expect(got[0].speed).toBeCloseTo(10 * 3.6, 0); // the largest single change
    expect(got[0].hard).toBe(true);
    // a teleport that stops the car
    v.position.x += 50;
    v.velocity.set(0, 0, 0);
    for (let i = 0; i < 40; i++) ce.step(v, dt);
    off();
    expect(got.length).toBe(1);
  });
});

describe('exhaust', () => {
  it('pops on a quick lift-off at revs and emits backfire events', () => {
    const v = fakeVehicle();
    const flames = new Pool('flame', 256, chipGeometry(), mat, new Rng(10));
    const sparks = new Pool('spark', 384, chipGeometry(), mat, new Rng(11));
    const ex = new Exhaust(cfg, 'kaze', [[-220, 45, 24]], 4.2, flames, sparks, new Rng(12));
    const got: boolean[] = [];
    const off = events.on('backfire', (e) => got.push(e.antilag));
    const pos = new THREE.Vector3(), rot = new THREE.Quaternion();
    v.rpm = 6500;
    v.velocity.set(25, 0, 0);
    // several lifts (the chance per lift is 0.85 x backfire_scale)
    for (let lift = 0; lift < 6; lift++) {
      v.input.throttle = 1;
      for (let i = 0; i < 30; i++) ex.update(v, 1 / 60, pos, rot);
      v.input.throttle = 0;
      for (let i = 0; i < 120; i++) ex.update(v, 1 / 60, pos, rot);
    }
    off();
    expect(got.filter((a) => !a).length).toBeGreaterThan(3);
    expect(got.some((a) => a)).toBe(true); // kaze has anti-lag
    expect(flames.spawned).toBeGreaterThan(0);
    expect(sparks.spawned).toBeGreaterThan(0);
  });
});

describe('breakables', async () => {
  const { Breakables } = await import('../src/world/breakables');
  // two breakables on a fake stage: a bush at x 10 and a marker post at x 20 (six floats per instance)
  const fakeStage = () => {
    const bin = new Float32Array([10, 0, 0, 0, 1, 0.5, 20, 0, 0, 0, 1, 0.5]);
    const box = new THREE.BoxGeometry(0.2, 1, 0.2);
    let changed = 0;
    return {
      json: { bin: { floats_per_instance: 6, breakables: { SM_Bush_A: [0, 1], SM_MarkerPost_BW: [1, 1] } } },
      bin, catalog: { SM_Bush_A: { category: 'shrub' }, SM_MarkerPost_BW: { category: 'marker' } },
      hiddenInstances: new Uint8Array(2),
      instancesChanged: () => changed++,
      envParts: () => [{ geometry: box, slot: 'Flat' }],
      get changed() {
        return changed;
      },
    };
  };
  const rapier = { Ray: class { constructor(public o: object, public d: object) {} } };
  const world = { castRay: () => null };
  it('bursts a bush, knocks a post over, emits events, and a restart puts them back', () => {
    const stage = fakeStage();
    const pieces: number[] = [];
    const br = new Breakables(stage as never, (cfg as unknown as { breakables: never }).breakables,
      { default: 150, shrub: 170, marker: 130 }, rapier as never, world as never, () => pieces.push(1));
    const got: string[] = [];
    const off = events.on('breakable', (e) => got.push(`${e.mesh}:${e.reaction}`));
    const car = { position: new THREE.Vector3(0, 0, 1), velocity: new THREE.Vector3(15, 0, 0) };
    br.update(1 / 60, car, 'running');
    expect(br.broken).toBe(0);
    car.position.set(9.5, 0, 1); // within the shrub's 1.7 m
    br.update(1 / 60, car, 'running');
    expect(got).toEqual(['SM_Bush_A:burst']);
    expect(stage.hiddenInstances[0]).toBe(1);
    expect(pieces.length).toBe(140); // fx.json shrub pieces
    car.position.set(20.5, 0, 0.5);
    br.update(1 / 60, car, 'running');
    expect(got[1]).toBe('SM_MarkerPost_BW:fly');
    expect(br.group.children.length).toBe(1);
    // it tumbles and comes to rest lying down (ground at y 0 when no ray hits)
    for (let i = 0; i < 600; i++) br.update(1 / 60, null, 'running');
    const post = br.group.children[0];
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(post.quaternion).y).toBeLessThan(0.1);
    expect(post.position.y).toBeCloseTo(0.08, 2); // rest lift 8 cm
    br.update(1 / 60, null, 'intro');
    off();
    expect([...stage.hiddenInstances]).toEqual([0, 0]);
    expect(br.group.children.length).toBe(0);
  });
});
