#!/usr/bin/env node
// Look check (slice 5): screenshots of fixed spots on a stage for each condition and screen size,
// placed the way the original engine's look matrix placed its cameras, so the two can be compared
// like for like: the car goes onto the road at progress s (m), moving at --kmh along it, and the
// shot is taken --wait seconds later with the HUD hidden. Optionally measures frame times there.
//
//   node tools/check/look.mjs [--stage finland] [--conds afternoon,morning,sunset,night,fog]
//        [--spots start:62,crest:759] [--sizes 1200x675,3840x1600] [--kmh 25] [--wait 2.2]
//        [--params "post=0"] [--perf 5] [--webgl] [--out shots/look] [--tag name]
//        [--url http://localhost:4173/backroad-rally/] [--chrome /path/to/chrome]
//
// Files: <out>/<tag><stage>_<cond>_<spot>_<w>x<h>.png. --perf N holds the spot for N seconds
// after the shot and prints mean / p95 / p99 / max frame time (launch Chrome without vsync, e.g.
// CHROME_ARGS="... --disable-gpu-vsync --disable-frame-rate-limit", to see the real cost).
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
const conds = arg('--conds', 'afternoon').split(',');
const spots = arg('--spots', 'start:62,crest:759').split(',').map((s) => {
  const [name, at, lat = '0'] = s.split(':');
  return { name, s: Number(at), lat: Number(lat) };
});
const sizes = arg('--sizes', '1200x675').split(',').map((s) => s.split('x').map(Number));
const kmh = Number(arg('--kmh', '25'));
const wait = Number(arg('--wait', '2.2'));
const extra = arg('--params', '');
const perfSeconds = Number(arg('--perf', '0'));
const out = arg('--out', 'shots/look');
const tag = arg('--tag', '');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});

const stat = (v) => {
  v = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return `mean ${mean.toFixed(2)} p95 ${at(0.95).toFixed(2)} p99 ${at(0.99).toFixed(2)} max ${v[v.length - 1].toFixed(2)}`;
};

let failed = false;
for (const [w, h] of sizes) {
  for (const cond of conds) {
    const q = new URLSearchParams({ stage, cond, hud: '0' });
    if (argv.includes('--webgl')) q.set('webgl', '');
    let url = `${base}?${q}`;
    if (extra) url += `&${extra}`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
    await page.goto(url);
    try {
      // the flow holds the car (handbrake) until "go": wait for it so the car can roll like the reference
      await page.waitForFunction(() => window.__br?.level?.run?.phase === 'running', null, { timeout: 90000 });
    } catch {
      console.log(`${cond} ${w}x${h}: never reached the running phase\n${errors.join('\n')}`);
      await page.screenshot({ path: join(out, `${tag}${stage}_${cond}_fail_${w}x${h}.png`) });
      await page.close();
      failed = true;
      continue;
    }
    const gpu = await page.evaluate(() => window.__br.gpu ?? '');
    for (const spot of spots) {
      await page.evaluate(([s, lat, kmh]) => {
        const { vehicle, sim, level, chase } = window.__br;
        const pose = level.tracker.road.pose(s, level.tracker.sign, lat);
        pose.position.y += 0.4;
        vehicle.teleport(pose.position, pose.yawDeg);
        const yaw = (-pose.yawDeg * Math.PI) / 180;
        const v = kmh / 3.6;
        // UE yaw about Z (X toward Y) is three rotation.y = -yaw: forward is (cos, 0, -sin) of that
        vehicle.body.setLinvel({ x: Math.cos(yaw) * v, y: 0, z: -Math.sin(yaw) * v }, true);
        for (const wh of vehicle.wheels) wh.omega = v / vehicle.t.wheelRadius;
        sim.snap();
        level.tracker.reset();
        chase.snapped = false;
      }, [spot.s, spot.lat, kmh]);
      await page.waitForTimeout(wait * 1000);
      const file = join(out, `${tag}${stage}_${cond}_${spot.name}_${w}x${h}.png`);
      await page.screenshot({ path: file });
      let line = `${cond.padEnd(9)} ${spot.name.padEnd(8)} ${w}x${h} -> ${file}`;
      if (perfSeconds) {
        await page.evaluate(() => window.__br.perf.reset());
        await page.waitForTimeout(perfSeconds * 1000);
        const frames = await page.evaluate(() => window.__br.perf.frames.slice(5));
        line += `\n    frame ${stat(frames.map((f) => f.dt))} ms (${frames.length} frames) | submit ${stat(frames.map((f) => f.render))}` +
          ` | calls ${Math.round(frames.reduce((a, f) => a + f.calls, 0) / frames.length)}`;
        const gpu = frames.map((f) => f.gpu).filter((g) => g > 0);
        if (gpu.length) line += `\n    gpu ${stat(gpu)} ms`;
      }
      console.log(line);
    }
    if (gpu) console.log(`    gpu: ${gpu}`);
    if (errors.length) console.log(`    console:\n    ${errors.join('\n    ')}`);
    await page.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
