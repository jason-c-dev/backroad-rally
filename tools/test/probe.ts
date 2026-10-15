// Drive one car with a fixed input and print its state: a quick look inside the vehicle model.
//   npx tsx tools/test/probe.ts [car] [throttle] [steer] [seconds] [surface x,y]
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { createWorld, initPhysics, PHYSICS_DT } from '../../src/sim/physics';
import { buildTestTrackPhysics } from '../../src/sim/testTrackPhysics';
import { loadCarTuning } from '../../src/sim/tuning';
import { Vehicle, noInput } from '../../src/sim/vehicle';
import { createArcade } from '../../src/sim/arcade';

const d = (f: string) => JSON.parse(readFileSync(`public/data/${f}`, 'utf8'));
const [car = 'swift', thr = '1', st = '0', secs = '8'] = process.argv.slice(2);
const rapier = await initPhysics();
const world = createWorld(rapier);
const surf = buildTestTrackPhysics(rapier, world, d('testtrack.json'));
const cj = d(`cars/${car}.json`);
const v = new Vehicle(rapier, world, loadCarTuning(d('cars_tuning.json'), cj, car), surf, cj.wheel_pos_cm);
if (!process.argv.includes('--no-arcade')) v.arcade = createArcade(v);
v.teleport(new Vector3(15, 0.4, -300), 0);
let t = 0;
for (let i = 0; i < Number(secs) * 120; i++) {
  v.input = { ...noInput(), throttle: t > 1 ? Number(thr) : 0, steer: t > 1 ? Number(st) : 0, handbrake: t <= 1 };
  v.step(PHYSICS_DT);
  world.step();
  t += PHYSICS_DT;
  if (i % 30 === 0) {
    const w = v.wheels;
    console.log(`t=${t.toFixed(2)} kmh=${v.forwardSpeedKmh.toFixed(1)} y=${v.position.y.toFixed(3)} g=${v.gear} rpm=${v.rpm.toFixed(0)} slip=${v.bodySlipDeg.toFixed(1)} yaw=${v.yawRateDeg.toFixed(1)} ` +
      w.map((x) => `[${x.inContact ? 'c' : '-'} ${x.surface[0]} L${x.load.toFixed(0)} cmp${(x.compression * 100).toFixed(1)} om${x.omega.toFixed(1)} ls${x.longSlipCms.toFixed(0)}]`).join(' '));
  }
}
