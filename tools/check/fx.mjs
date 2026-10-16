#!/usr/bin/env node
// Effects check (slice 6): drive scenes on a stage in headless Chrome, screenshot them and print what
// the effects and the game events did (live particles, skid segments, pops, landings, impacts, crowd
// reactions) plus console errors.
//
//   node tools/check/fx.mjs [--scenes straight,slide,skids,landing,crowd,crash] [--size 1920x800]
//        [--gpu igpu|dgpu] [--webgpu] [--car swift] [--cond afternoon] [--params "quality=high"]
//        [--out shots/fx] [--tag name] [--noshot] [--url http://localhost:4173/backroad-rally/] [--chrome /path/to/chrome]
//
// Scenes (finland's road positions):
//   straight  the robot at 120 km/h down the spruce straight (s 300-420): the dust trail
//   slide     a handbrake slide at ~90 km/h on the straight: dust, chips, skid marks
//   skids     the marks the slide left, the car stopped beside them
//   landing   the robot over the big crest jump (s 759): the landing ring; the crowds there react
//   crowd     the start village (s 60-70) at the start: the spectators
//   bush/post drive through a roadside bush (leaves scatter) / knock over a marker post
//   crash     into the trees beside the road at ~70 km/h: impact sparks, dust and a groan if near a crowd
// Serve dist/ under /backroad-rally/ first (README).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const scenes = arg('--scenes', 'straight,slide,skids,landing,crowd,crash').split(',');
const [w, h] = arg('--size', '1920x800').split('x').map(Number);
const out = arg('--out', 'shots/fx');
const tag = arg('--tag', `${w}x${h}`);
const webgpu = argv.includes('--webgpu');
const gpu = arg('--gpu', 'igpu');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const env = { ...process.env };
if (gpu === 'dgpu') {
  Object.assign(env, {
    __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only',
    __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json',
  });
}
const browser = await chromium.launch({
  executablePath, env,
  args: (process.env.CHROME_ARGS ?? (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist'
    : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist')).split(' '),
});

async function open(extra) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('console', (m) => (m.type() === 'error' || /WGSL|pipeline creation failed/.test(m.text())) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const q = new URLSearchParams({ stage: 'finland', car: arg('--car', 'swift'), cond: arg('--cond', 'afternoon'), hud: '0' });
  if (!webgpu) q.set('webgl', '');
  for (const [k, v] of new URLSearchParams(arg('--params', ''))) q.set(k, v);
  for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
  await page.goto(`${base}?${q}`.replace(/=(&|$)/g, '$1'));
  await page.waitForFunction(() => window.__br?.level?.run && window.__fx, null, { timeout: 120000 });
  // a log of every game event
  await page.evaluate(() => {
    window.__evlog = [];
    for (const k of ['landing', 'impact', 'crowdReaction', 'backfire', 'splash', 'breakable']) {
      window.__fx.events.on(k, (e) => window.__evlog.push({ k, t: performance.now(), kind: e.kind, speed: e.speed, intensity: e.intensity }));
    }
  });
  await page.waitForFunction(() => window.__br.level.run.phase === 'running', null, { timeout: 60000 });
  return { page, errors };
}

/** Put the car on the road at s (m), `lat` m right of the centreline, moving at kmh. */
const place = (page, s, kmh = 0, lat = 0, turn = 0) => page.evaluate(([s, kmh, lat, turn]) => {
  const { vehicle, sim, level, chase } = window.__br;
  const pose = level.tracker.road.pose(s, level.tracker.sign, lat);
  pose.position.y += 0.4;
  vehicle.teleport(pose.position, pose.yawDeg + turn);
  if (kmh) vehicle.launch(kmh / 3.6);
  sim.snap();
  level.tracker.reset();
  chase.snapped = false;
}, [s, kmh, lat, turn]);

const report = async (page, name) => {
  const r = await page.evaluate(() => {
    const { fx, crowd, carEvents } = window.__fx;
    const ev = {};
    for (const e of window.__evlog) ev[e.k === 'crowdReaction' ? `crowd:${e.kind}` : e.k] = (ev[e.k === 'crowdReaction' ? `crowd:${e.kind}` : e.k] ?? 0) + 1;
    const { vehicle } = window.__br;
    return { stats: fx.stats(), ev, kmh: vehicle.speedKmh.toFixed(0), maxDv: carEvents.maxDv.toFixed(2), hop: crowd?.maxHop.toFixed(2),
      tier: window.__br.look.qualityName, surfaces: vehicle.wheels.map((x) => x.surface).join('/'),
      impacts: window.__evlog.filter((e) => e.k === 'impact').map((e) => e.speed.toFixed(0)).join(',') };
  });
  console.log(`${name.padEnd(9)} ${r.kmh} km/h ${r.surfaces} tier ${r.tier} | fx ${JSON.stringify(r.stats)} | events ${JSON.stringify(r.ev)}` +
    ` | maxDv ${r.maxDv} m/s${r.impacts ? ` impacts ${r.impacts} km/h` : ''}${r.hop ? ` hop ${r.hop} m` : ''}`);
};

const shot = async (page, name) => {
  if (argv.includes('--noshot')) return; // headless WebGPU can't read its canvas back (wiki gotchas)
  const path = join(out, `fx_${name}_${tag}.png`);
  await page.screenshot({ path });
  console.log(`  -> ${path}`);
};

const keys = async (page, down, ms) => {
  for (const k of down) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of down) await page.keyboard.up(k);
};

for (const scene of scenes) {
  if (scene === 'straight') {
    const { page, errors } = await open('autopilot=120');
    await place(page, 300, 100);
    await page.waitForTimeout(3500);
    await shot(page, 'straight');
    await report(page, 'straight');
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  } else if (scene === 'slide' || scene === 'skids') {
    if (scene === 'skids' && scenes.includes('slide')) continue; // the slide scene shoots both
    const { page, errors } = await open('');
    await place(page, 330, 95);
    await keys(page, ['KeyW'], 400);
    // a handbrake flick to the right, caught with opposite lock, then the brakes
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    await page.keyboard.down('Space');
    await page.waitForTimeout(450);
    await page.keyboard.up('Space');
    await page.waitForTimeout(150);
    await shot(page, 'slide');
    await report(page, 'slide');
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyW');
    await keys(page, ['KeyA'], 350);
    await keys(page, ['KeyS'], 1500);
    // back on the road beside the marks, stopped, and let the camera settle
    await place(page, 352, 0, -2.5);
    await page.waitForTimeout(1500);
    await shot(page, 'skids');
    await report(page, 'skids');
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  } else if (scene === 'landing') {
    const { page, errors } = await open('autopilot=120');
    await place(page, 690, 110);
    // shoot just after the touch-down
    await page.waitForFunction(() => window.__fx.carEvents.landings > 0, null, { timeout: 20000 }).catch(() => console.log('  no landing'));
    await page.waitForTimeout(350);
    await shot(page, 'landing');
    await report(page, 'landing');
    await page.waitForTimeout(2500);
    await report(page, 'landing+');
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  } else if (scene === 'crowd') {
    const { page, errors } = await open('autopilot=120');
    // passing the start village's two groups (s 66 and 70) at ~70 km/h
    await place(page, 20, 70);
    await page.waitForTimeout(2100);
    await shot(page, 'crowd');
    await report(page, 'crowd');
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  } else if (scene === 'bush' || scene === 'post') {
    const { page, errors } = await open('');
    // aim at a breakable by the road (a bush, or a marker post) from 14 m back at 50 km/h
    const what = await page.evaluate((cat) => {
      const { breakables } = window.__fx;
      const { level, vehicle, sim, chase } = window.__br;
      const road = level.tracker.road;
      const near = breakables.items.filter((b) => b.category === cat && road.distanceTo(b.pos.x, b.pos.z) < 7)
        .sort((a, b) => road.project(a.pos).s - road.project(b.pos).s);
      const b = near.find((x) => road.project(x.pos).s > 200) ?? near[0];
      const p = road.project(b.pos);
      const from = road.pose(p.s - 14, level.tracker.sign, 0).position;
      const yaw = Math.atan2(b.pos.z - from.z, b.pos.x - from.x) * 180 / Math.PI;
      from.y += 0.4;
      vehicle.teleport(from, yaw);
      vehicle.launch(50 / 3.6);
      sim.snap();
      level.tracker.reset();
      chase.snapped = false;
      return `${b.mesh} at s ${p.s.toFixed(0)}, ${(road.distanceTo(b.pos.x, b.pos.z)).toFixed(1)} m from the centreline`;
    }, scene === 'bush' ? 'shrub' : 'marker');
    console.log(`  ${what}`);
    await keys(page, ['KeyW'], 1150);
    await shot(page, scene);
    await report(page, scene);
    await keys(page, ['KeyS'], 2500);
    await page.waitForTimeout(3000);
    const n = await page.evaluate(() => {
      const { breakables } = window.__fx;
      return { broken: breakables.broken, lying: breakables.group.children.map((o) => `${o.position.toArray().map((v) => v.toFixed(1))} up.y ${(new o.up.constructor(0, 1, 0)).applyQuaternion(o.quaternion).y.toFixed(2)}`) };
    });
    console.log(`  broken ${n.broken}; knocked over: ${n.lying.join(' | ') || '-'}`);
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  } else if (scene === 'crash') {
    const { page, errors } = await open('');
    // off the road into the spruces at the straight, near no crowd; then at the crest crowd
    await place(page, 380, 70, 0, 50);
    await keys(page, ['KeyW'], 1500);
    await page.waitForTimeout(300);
    await shot(page, 'crash');
    await report(page, 'crash');
    if (errors.length) console.log(`  errors: ${errors.slice(0, 5).join('\n  ')}`);
    await page.close();
  }
}
await browser.close();
