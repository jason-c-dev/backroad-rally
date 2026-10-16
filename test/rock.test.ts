// Roadside rocks are solid (UE: box from the mesh bounds, boulders from the mesh): the car driven
// into one at 40 km/h stops against it without being thrown up or snagged, and can reverse away.
// Uses the real catalog entries and car tuning; the rock meshes are stood in by their bounds
// (measured from env_finland.glb), which is all the colliders read.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { createWorld, initPhysics, PHYSICS_DT } from '../src/sim/physics';
import { loadCarTuning } from '../src/sim/tuning';
import { Vehicle, noInput } from '../src/sim/vehicle';
import { createArcade } from '../src/sim/arcade';
import { instanceColliderDescs } from '../src/world/colliders';
import type { CatalogEntry } from '../src/world/stage';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const catalog = data('env_catalog.json') as Record<string, CatalogEntry>;
const tuningJson = data('cars_tuning.json');

/** Local bounds (three metres: x forward, y up, z right) of the rock meshes in env_finland.glb. */
const BOUNDS: Record<string, [number[], number[]]> = {
  SM_Rock_A: [[-0.516, -0.06, -0.403], [0.513, 0.468, 0.419]],
  SM_Rock_B: [[-0.712, -0.096, -0.5], [0.689, 0.868, 0.411]],
  SM_Boulder_A: [[-1.29, -0.228, -1.116], [1.173, 1.709, 1.075]],
};
/** A stand-in mesh: the eight corners of the bounds (a boulder's hull becomes that box). */
function standIn(mesh: string) {
  const [a, b] = BOUNDS[mesh];
  const p: number[] = [];
  for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) p.push(x, y, z);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return [{ geometry: g }];
}

async function crash(carId: string, mesh: string, scale: number, yawDeg: number) {
  const rapier = await initPhysics();
  const world = createWorld(rapier);
  world.createCollider(rapier.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1, 0).setFriction(0.8));
  const cat = catalog[mesh];
  const rock = { x: 20, z: 0 };
  const descs = instanceColliderDescs(rapier, cat, standIn(mesh), rock.x, 0, rock.z, (yawDeg * Math.PI) / 180, scale);
  for (const d of descs) world.createCollider(d);
  const carJson = data(`cars/${carId}.json`);
  const car = new Vehicle(rapier, world, loadCarTuning(tuningJson, carJson, carId), () => 'gravel', carJson.wheel_pos_cm);
  car.arcade = createArcade(car);
  car.teleport(new Vector3(6, 0.3, 0), 0);
  for (let i = 0; i < 30; i++) {
    car.step(PHYSICS_DT);
    world.step();
  }
  car.launch(40 / 3.6);
  let t = 0, impactKmh = 0, hitT = -1, stopT = -1, maxVy = 0, minUp = 1, maxX = 0;
  const drive = (input: ReturnType<typeof noInput>) => {
    car.input = input;
    car.step(PHYSICS_DT);
    world.step();
    t += PHYSICS_DT;
  };
  while (t < 5) {
    const kmh = car.forwardSpeedKmh;
    drive({ ...noInput(), throttle: Math.min(1, Math.max(0, 0.1 * (40 - kmh) + 0.3)) });
    const sp = car.speedKmh;
    if (hitT < 0 && t > 0.2 && sp < 25) hitT = t;
    if (hitT < 0) impactKmh = sp;
    if (hitT >= 0 && stopT < 0 && sp < 3) stopT = t;
    if (hitT >= 0) maxVy = Math.max(maxVy, car.velocity.y);
    minUp = Math.min(minUp, car.up.y);
    maxX = Math.max(maxX, car.position.x);
    if (hitT >= 0 && t > hitT + 2) break;
  }
  // brake held at a stop selects reverse: it must back away, not hang on an edge
  let reverseKmh = 0;
  for (let i = 0; i < 3 / PHYSICS_DT; i++) {
    drive({ ...noInput(), brake: 1 });
    reverseKmh = Math.min(reverseKmh, car.forwardSpeedKmh);
  }
  return { descs: descs.length, impactKmh, hitT, stopT, maxVy, minUp, maxX, reverseKmh, rock };
}

describe('roadside rocks', () => {
  it('give the rocks a collider from the mesh bounds (the catalog has none for them)', async () => {
    const rapier = await initPhysics();
    for (const mesh of ['SM_Rock_A', 'SM_Rock_B', 'SM_Rock_C']) {
      expect(catalog[mesh].collision).toBe('box');
      expect(catalog[mesh].bounds_min_cm).toBeUndefined();
    }
    const [d] = instanceColliderDescs(rapier, catalog.SM_Rock_B, standIn('SM_Rock_B'), 1, 2, 3, Math.PI / 2, 1.2);
    expect(d.shape.type).toBe(rapier.ShapeType.Cuboid);
    const half = (d.shape as InstanceType<typeof rapier.Cuboid>).halfExtents;
    expect(half.x).toBeCloseTo(((0.689 + 0.712) / 2) * 1.2, 3);
    expect(half.y).toBeCloseTo(((0.868 + 0.096) / 2) * 1.2, 3);
    // the box centre turns with the instance yaw: local +x (0.0115 m off) ends up along -z
    expect(d.translation.y).toBeCloseTo(2 + ((0.868 - 0.096) / 2) * 1.2, 3);
  });

  for (const [carId, mesh, scale, yaw] of [['swift', 'SM_Rock_B', 1.0, 30], ['kaze', 'SM_Rock_A', 1.3, 0], ['pip', 'SM_Boulder_A', 1.0, 70]] as const) {
    it(`stop the ${carId} hitting ${mesh} at 40 km/h`, async () => {
      const r = await crash(carId, mesh, scale, yaw);
      expect(r.descs).toBe(1);
      expect(r.impactKmh).toBeGreaterThan(35);
      expect(r.hitT).toBeGreaterThan(0);
      expect(r.stopT - r.hitT).toBeLessThan(1); // stopped within a second of the hit
      expect(r.maxX).toBeLessThan(r.rock.x); // never past the rock's centre
      expect(r.maxVy).toBeLessThan(1.5); // not thrown up
      expect(r.minUp).toBeGreaterThan(0.85); // stays on its wheels
      expect(r.reverseKmh).toBeLessThan(-5); // backs away
    });
  }
});
