#!/usr/bin/env node
// HUD and damage screenshots: loads a stage once, waits for the run to start, then for each shot sets
// the window size, the HUD settings (units, speed display, size), the car's damage and speed, and saves
// a screenshot. Prints the HUD boxes (for overlap checks) and any console errors.
//
//   node tools/check/hud.mjs [--url http://localhost:4173/backroad-rally/] [--out shots/hud] [--webgl]
//        [--params "car=swift&cond=afternoon"] [--at 62] [--shots spec.json] [--chrome /path/to/chrome]
//
// spec.json: [{ "tag": "num-kmh", "size": "1920x800", "hud": { "units": "kmh", "speedo": "number", "size": 100 },
//   "kmh": 80, "damage": { "value": 0.4, "parts": [0.1, 0, 0, 0, 0.5, 0], "terminal": false }, "wait": 800,
//   "camera": 0 }]  (every key optional; damage is set straight on the model, so smoke and fire follow it)
// Without --shots a default set runs: number and dial, km/h and mph, lights at yellow and red, sizes 80 and 130.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const out = arg('--out', 'shots/hud');
const at = Number(arg('--at', '62'));
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const DEFAULT = [
  { tag: 'num-kmh-clean', hud: { units: 'kmh', speedo: 'number', size: 100 }, kmh: 80, damage: { value: 0, parts: [0, 0, 0, 0, 0, 0] } },
  { tag: 'num-mph-yellow', hud: { units: 'mph', speedo: 'number' }, kmh: 80, damage: { value: 0.12, parts: [0.03, 0, 0, 0.2, 0.05, 0] } },
  { tag: 'dial-kmh-red', hud: { units: 'kmh', speedo: 'dial' }, kmh: 55, damage: { value: 0.5, parts: [0.9, 0, 0.5, 0, 0.3, 0.2] } },
  { tag: 'dial-mph', hud: { units: 'mph', speedo: 'dial' }, kmh: 100, damage: { value: 0.2, parts: [0.2, 0.03, 0, 0, 0.1, 0] } },
  { tag: 'num-80', hud: { units: 'kmh', speedo: 'number', size: 80 }, kmh: 80, damage: { value: 0.12, parts: [0.03, 0.5, 0, 0.2, 0.05, 0] } },
  { tag: 'num-130', hud: { units: 'kmh', speedo: 'number', size: 130 }, kmh: 80, damage: { value: 0.12, parts: [0.03, 0.5, 0, 0.2, 0.05, 0] } },
  { tag: 'dial-130', hud: { units: 'kmh', speedo: 'dial', size: 130 }, kmh: 120, damage: { value: 0.12, parts: [0.03, 0.5, 0, 0.2, 0.05, 0] } },
];
const shots = argv.includes('--shots') ? JSON.parse(readFileSync(arg('--shots'), 'utf8')) : DEFAULT;

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});
const q = new URLSearchParams(arg('--params', ''));
if (argv.includes('--webgl')) q.set('webgl', '');
const [w0, h0] = (shots[0].size ?? '1920x800').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: w0, height: h0 } });
const errors = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.goto(`${base}?${q}`);
await page.waitForFunction(() => window.__br?.level?.run?.phase === 'running', null, { timeout: 90000 });
console.log('backend', await page.evaluate(() => `${window.__br.backend} ${window.__br.gpu}`));

let size = `${w0}x${h0}`;
for (const s of shots) {
  if (s.size && s.size !== size) {
    size = s.size;
    const [w, h] = size.split('x').map(Number);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < (s.camera ?? 0); i++) await page.keyboard.press('KeyC');
  await page.evaluate((s) => {
    const { vehicle, sim, level, chase, damage } = window.__br;
    if (s.hud) level.hud.apply({ ...level.hud.settings, ...s.hud });
    const d = s.damage ?? {};
    if (d.value !== undefined) damage.value = d.value;
    if (d.parts) d.parts.forEach((p, i) => (damage.parts[i] = p));
    damage.terminal = !!d.terminal;
    const pose = level.tracker.road.pose(s.at, level.tracker.sign, s.lateral ?? 0);
    pose.position.y += 0.3;
    vehicle.teleport(pose.position, pose.yawDeg);
    vehicle.launch((s.kmh ?? 0) / 3.6);
    sim.snap();
    chase.snapped = false;
  }, { ...s, at: s.at ?? at });
  // hold the speed while the camera settles (the HUD reads the live car)
  const t0 = Date.now();
  while (Date.now() - t0 < (s.wait ?? 1200)) {
    await page.evaluate((kmh) => {
      const v = window.__br.vehicle;
      if (kmh && Math.abs(v.forwardSpeedKmh - kmh) > 3) v.launch(kmh / 3.6);
    }, s.kmh ?? 0);
    await page.waitForTimeout(100);
  }
  await page.screenshot({ path: join(out, `${s.tag}-${size}.png`) });
  const boxes = await page.evaluate(() => {
    const r = {};
    for (const k of ['hud-timer', 'hud-progress', 'hud-lights', 'hud-gear', 'hud-speed']) {
      const e = document.querySelector(`#stage-hud .${k}`);
      if (!e) continue;
      const b = e.getBoundingClientRect();
      r[k] = [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)];
    }
    return r;
  });
  const [w, h] = size.split('x').map(Number);
  const names = Object.keys(boxes);
  const issues = [];
  for (const [k, [l, t, r, b]] of Object.entries(boxes)) if (l < 0 || t < 0 || r > w || b > h) issues.push(`${k} clipped`);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = boxes[names[i]], b = boxes[names[j]];
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) issues.push(`${names[i]} overlaps ${names[j]}`);
    }
  }
  console.log(`${s.tag} ${size} ${JSON.stringify(boxes)}${issues.length ? ` ISSUES ${issues.join(', ')}` : ''}`);
}
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no console errors');
await browser.close();
