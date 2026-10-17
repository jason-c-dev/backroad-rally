#!/usr/bin/env node
// Drive into roadside rocks and check they stop the car (headless Chrome, the real stage).
//
//   node tools/check/rock.mjs [--stage finland] [--car swift] [--kmh 40] [--meshes SM_Rock_B,SM_Boulder_A]
//        [--per 2] [--size 1280x534] [--webgl] [--out shots/rock] [--url http://localhost:4173/backroad-rally/]
//
// Picks the biggest rocks of each mesh a little off the road edge, puts the car 14 m before one,
// aimed at it, at --kmh, and holds that speed with the throttle. Passes when the car stops against
// the rock (under 3 km/h within 2 s), isn't thrown up (vertical speed under 1.5 m/s), stays upright and doesn't end up past
// it, and stops at this rock (its nose within reach of it); then it reverses away (not snagged). Saves a screenshot of the car stopped at each rock.
// Exit code 1 on any failure. Serve dist/ under /backroad-rally/ first (README).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const stage = arg('--stage', 'finland');
const car = arg('--car', 'swift');
const kmh = Number(arg('--kmh', '40'));
const meshes = arg('--meshes', 'SM_Rock_A,SM_Rock_B,SM_Rock_C,SM_Boulder_A').split(',');
const per = Number(arg('--per', '2'));
const [w, h] = arg('--size', '1280x534').split('x').map(Number);
const out = arg('--out', 'shots/rock');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const CAR_HALF = 2.0; // m, nose to centre (the cars are 3.5-4.3 m long)

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});
const q = new URLSearchParams({ stage, car, crowd: '0' });
if (argv.includes('--webgl')) q.set('webgl', '');
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}?${q}`);
await page.waitForSelector('#frame-hud:not(:empty)', { timeout: 60000, state: 'attached' });
await page.waitForFunction(() => window.__br?.level?.run?.phase === 'running', null, { timeout: 30000 });

// the rocks to try: biggest first, 1-6 m outside the road edge, with a clear run at them from 14 m
// back along the road (rays at bumper height reach this rock first), and a collider found by the ray
const targets = await page.evaluate(([meshes, per]) => {
  const { level, vehicle } = window.__br;
  const st = level.stage;
  const F = st.json.bin.floats_per_instance;
  const bin = st.bin;
  const world = vehicle.world, rapier = vehicle.rapier;
  const ray = (from, dir, len) => world.castRay(new rapier.Ray(from, dir), len, true, undefined, undefined, undefined, vehicle.body);
  const picked = [];
  for (const mesh of meshes) {
    const r = st.json.bin.instances[mesh];
    if (!r) continue;
    const cand = [];
    for (let i = r[0]; i < r[0] + r[1]; i++) {
      const p = { x: bin[i * F], y: bin[i * F + 1], z: bin[i * F + 2] };
      const pr = st.road.project(p);
      const edge = Math.abs(pr.lateral) - pr.halfWidth;
      if (edge > 1 && edge < 6 && Math.abs(pr.height) < 2) cand.push({ i, p, s: pr.s, lateral: pr.lateral, edge, scale: bin[i * F + 4] });
    }
    cand.sort((a, b) => b.scale - a.scale);
    let n = 0;
    for (const c of cand) {
      if (n >= per) break;
      const back = st.road.sampleAt(c.s - 14 * level.tracker.sign);
      const l = Math.hypot(back.dx, back.dz) || 1;
      const start = { x: back.p.x - (back.dz / l) * c.lateral, y: back.p.y, z: back.p.z + (back.dx / l) * c.lateral };
      const ground = ray({ x: start.x, y: start.y + 20, z: start.z }, { x: 0, y: -1, z: 0 }, 40);
      if (!ground) continue;
      start.y += 20 - ground.timeOfImpact;
      const dx = c.p.x - start.x, dz = c.p.z - start.z, al = Math.hypot(dx, dz);
      const reach = (st.catalog[mesh].radius_cm / 100) * c.scale;
      // three rays (centre and the car's corners) toward the rock, 25 cm over the ground
      let clear = true, centre = null;
      for (const off of [0, -0.8, 0.8]) {
        const from = { x: start.x - (dz / al) * off, y: start.y + 0.25, z: start.z + (dx / al) * off };
        const hit = ray(from, { x: dx / al, y: (c.p.y - start.y) / al, z: dz / al }, al + 2);
        if (off === 0) centre = hit;
        if (hit && hit.timeOfImpact < al - reach - 0.3) clear = false;
      }
      if (!clear) continue;
      picked.push({ mesh, ...c, start, yaw: (Math.atan2(dz, dx) * 180) / Math.PI, rockAt: al, reach,
        collider: !!centre && centre.timeOfImpact < al + 0.2 });
      n++;
    }
  }
  return { picked, counts: st.instanceColliders };
}, [meshes, per]);
console.log(`instance colliders by category ${JSON.stringify(targets.counts)}`);

let failed = 0;
for (const [k, t] of targets.picked.entries()) {
  const res = await page.evaluate(async ([t, kmh]) => {
    const { level, vehicle, sim, chase } = window.__br;
    const start = { ...t.start, y: t.start.y + 0.3 };
    const yaw = t.yaw;
    vehicle.arcade.autoRecover = false; // holding the throttle against a rock would count as stuck
    vehicle.teleport(start, yaw);
    vehicle.launch(kmh / 3.6);
    sim.snap();
    level.tracker.reset();
    chase.snapped = false;
    const t0 = performance.now();
    const y0 = vehicle.position.y;
    let maxRise = 0, maxVy = 0, minUp = 1, hitAt = -1, stoppedAt = -1, impactKmh = 0, minDist = 1e9;
    level.__rockBase ??= level.step;
    const prev = level.__rockBase;
    level.step = (dt, input) => {
      const o = prev(dt, input);
      const v = vehicle;
      const k = v.forwardSpeedKmh;
      o.throttle = Math.min(1, Math.max(0, 0.1 * (kmh - k) + 0.3));
      o.brake = 0;
      o.steer = 0;
      o.handbrake = false;
      o.digitalSteer = false;
      return o;
    };
    const sample = () => {
      const v = vehicle;
      const d = Math.hypot(v.position.x - t.p.x, v.position.z - t.p.z);
      minDist = Math.min(minDist, d);
      maxRise = Math.max(maxRise, v.position.y - y0);
      if (performance.now() - t0 > 300) maxVy = Math.max(maxVy, v.velocity.y);
      minUp = Math.min(minUp, v.up.y);
      const sp = v.speedKmh;
      if (hitAt < 0 && sp < kmh * 0.6 && performance.now() - t0 > 300) {
        hitAt = performance.now() - t0;
      }
      if (hitAt < 0) impactKmh = sp;
      if (hitAt >= 0 && stoppedAt < 0 && sp < 3) stoppedAt = performance.now() - t0;
    };
    while (performance.now() - t0 < 4000 && !(hitAt >= 0 && performance.now() - t0 > hitAt + 2500)) {
      sample();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const atRock = { speed: vehicle.speedKmh, pos: { ...vehicle.position } };
    // past the rock? compare the car's progress along the approach with the rock's
    const ax = t.p.x - start.x, az = t.p.z - start.z, al = Math.hypot(ax, az);
    const along = ((vehicle.position.x - start.x) * ax + (vehicle.position.z - start.z) * az) / al;
    return { impactKmh, hitAt, stoppedAt, maxRise, maxVy, minUp, minDist, along, rockAt: al, atRock };
  }, [t, kmh]);
  const shot = join(out, `rock-${k}-${t.mesh}.png`);
  await page.screenshot({ path: shot });
  // back away: brake held at a stop selects reverse
  const rev = await page.evaluate(async () => {
    const { level, vehicle } = window.__br;
    const prev = level.__rockBase;
    let t0 = performance.now(), minFwd = 0;
    level.step = (dt, input) => {
      const o = prev(dt, input);
      o.throttle = 0;
      o.brake = 1;
      o.steer = 0;
      o.handbrake = false;
      return o;
    };
    while (performance.now() - t0 < 3000) {
      minFwd = Math.min(minFwd, vehicle.forwardSpeedKmh);
      await new Promise((r) => requestAnimationFrame(r));
    }
    level.step = prev;
    vehicle.arcade.autoRecover = true;
    return { reverseKmh: minFwd };
  });
  const ok = t.collider && res.hitAt >= 0 && res.stoppedAt >= 0 && res.stoppedAt - res.hitAt < 2000 && res.maxVy < 1.5
    && res.minUp > 0.8 && res.along < res.rockAt && res.rockAt - res.along < CAR_HALF + t.reach + 0.6 && rev.reverseKmh < -3;
  if (!ok) failed++;
  console.log(`${t.mesh} #${t.i} s=${t.s.toFixed(0)} edge=${t.edge.toFixed(1)}m scale=${t.scale.toFixed(2)} collider=${t.collider} `
    + `impact=${res.impactKmh.toFixed(0)}kmh stop_after=${res.stoppedAt >= 0 ? ((res.stoppedAt - res.hitAt) / 1000).toFixed(2) + 's' : 'never'} `
    + `rise=${res.maxRise.toFixed(2)}m max_vy=${res.maxVy.toFixed(2)}m/s min_up=${res.minUp.toFixed(2)} gap=${(res.rockAt - res.along).toFixed(2)}m `
    + `speed_at_rock=${res.atRock.speed.toFixed(1)}kmh reverse=${rev.reverseKmh.toFixed(1)}kmh ${ok ? 'PASS' : 'FAIL'} -> ${shot}`);
}
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no console errors');
await browser.close();
process.exit(failed ? 1 : 0);
