// Damage (src/game/damage.ts, a port of the original's URallyDamageComponent with damage.json) and the
// body contact impulses that feed it (src/game/contacts.ts). The maths first, then the car driven into
// a rock at 30, 60 and 110 km/h in Rapier, headless.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createWorld, initPhysics, PHYSICS_DT } from '../src/sim/physics';
import { loadCarTuning } from '../src/sim/tuning';
import { Vehicle, noInput } from '../src/sim/vehicle';
import { createArcade } from '../src/sim/arcade';
import { Damage, PARTS, type DamageJson, type Hit } from '../src/game/damage';
import { BodyContacts } from '../src/game/contacts';
import { events } from '../src/game/events';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const cfg = data('damage.json') as DamageJson;
const tuningJson = data('cars_tuning.json');
const swift = { lengthCm: 428, widthCm: 169, engineXCm: 140 };

const hit = (kmh: number, x = 214, y = 0, ny = 0, ground = false): Hit => ({ kmh, x, y, ny, ground });
/** One hit, merged and committed. */
function once(d: Damage, h: Hit): void {
  d.hit(h);
  for (let i = 0; i < 30; i++) d.tick(PHYSICS_DT);
}

describe('damage maths (damage.json)', () => {
  it('adds ((kmh - 15) / 85)^2 x level per hit', () => {
    expect(Damage.added(cfg, 15, 1)).toBe(0);
    expect(Damage.added(cfg, 60, 1)).toBeCloseTo((45 / 85) ** 2, 6);
    expect(Damage.added(cfg, 100, 0.6)).toBeCloseTo(0.6, 6);
    for (const [kmh, level] of [[30, 1], [60, 0.5], [90, 1]] as const) {
      const d = new Damage(cfg, swift);
      d.level = level;
      once(d, hit(kmh));
      expect(d.value).toBeCloseTo(((kmh - 15) / 85) ** 2 * level, 6);
      expect(d.terminal).toBe(false);
    }
  });

  it('merges hits within 0.2 s into the largest, and ignores the ground and small knocks', () => {
    const d = new Damage(cfg, swift);
    d.hit(hit(40));
    d.tick(0.05);
    d.hit(hit(55));
    d.tick(0.05);
    d.hit(hit(30));
    for (let i = 0; i < 20; i++) d.tick(0.01);
    expect(d.impacts).toBe(1);
    expect(d.lastImpactKmh).toBe(55);
    expect(d.value).toBeCloseTo((40 / 85) ** 2, 6);
    once(d, hit(80, 0, 0, 0, true)); // a landing
    once(d, hit(5)); // below sound_min_kmh
    expect(d.impacts).toBe(1);
    once(d, hit(12)); // counted, but under min_kmh: no damage
    expect(d.impacts).toBe(2);
    expect(d.value).toBeCloseTo((40 / 85) ** 2, 6);
  });

  it('is terminal at a total of 1 or one hit of 110 km/h', () => {
    const a = new Damage(cfg, swift);
    let dnf = 0;
    a.onTerminal = () => dnf++;
    once(a, hit(110));
    expect(a.terminal).toBe(true);
    expect(a.value).toBe(1);
    expect(a.stage).toBe(4);
    expect(dnf).toBe(1);
    const b = new Damage(cfg, swift);
    once(b, hit(60));
    expect(b.stage).toBe(1); // 0.28: grime
    once(b, hit(60));
    expect(b.stage).toBe(2); // 0.56: smoke
    once(b, hit(60));
    expect(b.stage).toBe(3); // 0.84: fire
    expect(b.terminal).toBe(false);
    once(b, hit(60));
    expect(b.terminal).toBe(true); // 1.12, clamped to 1
  });

  it('applies torque loss, a steering pull toward the first hit, grime', () => {
    const d = new Damage(cfg, swift);
    expect(d.torqueScale).toBe(1);
    expect(d.steerPull).toBe(0);
    once(d, hit(60, 0, -80, -1)); // the left side, pushed toward the left
    const v = (45 / 85) ** 2;
    expect(d.torqueScale).toBeCloseTo(1 - 0.3 * v, 6);
    expect(d.steerPull).toBeCloseTo(-0.05 * v ** 1.5, 6);
    expect(d.grime).toBeCloseTo(0.8 * v, 6);
    once(d, hit(60, 0, 80, 1)); // a later hit on the other side doesn't change the pull's side
    expect(d.steerPull).toBeLessThan(0);
    d.add(1);
    expect(d.terminal).toBe(true);
    expect(d.torqueScale).toBe(cfg.terminal_torque_scale);
  });

  it('spreads a hit over the parts nearest it', () => {
    const d = new Damage(cfg, swift);
    const front = d.partWeightsAt(214, 0);
    expect(front[0]).toBeGreaterThan(0.5);
    expect(front[4]).toBeCloseTo(0.35, 6); // the engine is at the front
    expect(front[1]).toBe(0);
    const rearLeft = d.partWeightsAt(-200, -80);
    expect(rearLeft[1]).toBeGreaterThan(0);
    expect(rearLeft[2]).toBeGreaterThan(0);
    expect(rearLeft[4]).toBe(0);
    expect(rearLeft[5]).toBeGreaterThan(0.3);
    for (const w of [front, rearLeft, d.partWeightsAt(0, 0)]) expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // the side that took the hit fills gain x faster than the overall value
    const seen: string[] = [];
    const off = events.on('damage', (e) => seen.push(`${e.part} ${e.total.toFixed(3)}`));
    once(d, hit(60, 214, 0));
    off();
    expect(d.parts[0]).toBeCloseTo(Math.min(1, d.value * cfg.parts.gain), 6);
    expect(d.parts[1]).toBe(0);
    expect(seen).toEqual([`front ${d.value.toFixed(3)}`]);
    expect(PARTS.length).toBe(6);
  });

  it('does nothing when off (time attack), and repairs', () => {
    const d = new Damage(cfg, swift);
    d.enabled = false;
    once(d, hit(120));
    expect(d.impacts).toBe(1);
    expect(d.value).toBe(0);
    expect(d.terminal).toBe(false);
    d.enabled = true;
    once(d, hit(120));
    expect(d.terminal).toBe(true);
    d.repair();
    expect(d.value).toBe(0);
    expect(d.terminal).toBe(false);
    expect(d.parts.every((p) => p === 0)).toBe(true);
  });
});

/** A rock-sized box (1.4 x 0.9 x 1.4 m) 20 m ahead on flat ground; the swift launched at `kmh` and held there. */
async function crash(kmh: number, level = 1, carId = 'swift') {
  const rapier = await initPhysics();
  const world = createWorld(rapier);
  world.createCollider(rapier.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(0.8));
  world.createCollider(rapier.ColliderDesc.cuboid(0.7, 0.45, 0.7).setTranslation(20, 0.45, 0).setFriction(0.6));
  const carJson = data(`cars/${carId}.json`);
  const car = new Vehicle(rapier, world, loadCarTuning(tuningJson, carJson, carId), () => 'gravel', carJson.wheel_pos_cm);
  car.arcade = createArcade(car);
  car.teleport(new Vector3(20 - 0.7 - 2.14 - Math.max(6, kmh / 3.6 * 0.6), 0.3, 0), 0);
  for (let i = 0; i < 30; i++) {
    car.step(PHYSICS_DT);
    world.step();
  }
  car.launch(kmh / 3.6);
  const contacts = new BodyContacts(world, car);
  const damage = new Damage(cfg, { lengthCm: carJson.length_cm, widthCm: carJson.width_cm, engineXCm: 140 });
  damage.level = level;
  let approach = 0, terminalAt = -1, pull = 0;
  const hits: Hit[] = [];
  const seen: Hit[] = [];
  for (let t = 0; t < 2; t += PHYSICS_DT) {
    car.readBody();
    for (const h of contacts.read(hits)) {
      damage.hit(h);
      if (!h.ground && h.kmh > 6) seen.push({ ...h });
    }
    damage.tick(PHYSICS_DT, car.speedKmh, true);
    if (damage.terminal && terminalAt < 0) terminalAt = t;
    if (!damage.impacts && !seen.length) approach = car.forwardSpeedKmh;
    car.damageTorqueScale = damage.torqueScale;
    car.damageSteerPull = pull = damage.steerPull;
    const fwd = car.forwardSpeedKmh;
    car.input = { ...noInput(), throttle: damage.impacts ? 0 : Math.min(1, Math.max(0, 0.1 * (kmh - fwd) + 0.3)) };
    car.step(PHYSICS_DT);
    world.step();
  }
  return { approach, damage, seen, terminalAt, pull, maxKmh: contacts.maxKmh };
}

describe('crashing into a rock (Rapier contact impulses)', () => {
  for (const kmh of [30, 60, 110]) {
    it(`at ${kmh} km/h`, async () => {
      const r = await crash(kmh);
      const d = r.damage;
      // the hit is the velocity change: a head-on stop against a rock is about the approach speed
      expect(r.approach).toBeGreaterThan(kmh - 3);
      expect(d.impacts).toBe(1);
      expect(d.lastImpactKmh).toBeGreaterThan(r.approach * 0.85);
      expect(d.lastImpactKmh).toBeLessThan(r.approach * 1.25);
      // where: the front, the engine with it
      expect(d.parts[0]).toBeGreaterThan(0);
      expect(d.parts[1]).toBe(0);
      expect(d.parts[4]).toBeGreaterThan(0);
      if (kmh >= 110) {
        expect(d.terminal).toBe(true);
        expect(r.terminalAt).toBeGreaterThan(0);
      } else {
        expect(d.terminal).toBe(false);
        expect(d.value).toBeCloseTo(Damage.added(cfg, d.lastImpactKmh, 1), 6);
      }
      if (kmh === 30) expect(d.value).toBeLessThan(0.1);
      if (kmh === 60) expect(d.value).toBeGreaterThan(0.2);
    });
  }

  it('reads nothing while the car just drives (the ground under the wheels is not a hit)', async () => {
    const rapier = await initPhysics();
    const world = createWorld(rapier);
    world.createCollider(rapier.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(0.8));
    const carJson = data('cars/kaze.json');
    const car = new Vehicle(rapier, world, loadCarTuning(tuningJson, carJson, 'kaze'), () => 'gravel', carJson.wheel_pos_cm);
    car.arcade = createArcade(car);
    car.teleport(new Vector3(-300, 0.3, 0), 0);
    const contacts = new BodyContacts(world, car);
    let n = 0;
    for (let t = 0; t < 6; t += PHYSICS_DT) {
      car.readBody();
      n += contacts.read().filter((h) => !h.ground && h.kmh > 6).length;
      car.input = { ...noInput(), throttle: 1, steer: t > 3 ? 0.6 : 0 };
      car.step(PHYSICS_DT);
      world.step();
    }
    expect(n).toBe(0);
  });
});
