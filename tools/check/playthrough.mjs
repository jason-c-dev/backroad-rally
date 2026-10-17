#!/usr/bin/env node
// The run actions a player uses, on one quick stage with rival ghosts, headless (slice 11): the countdown, driving
// (the autopilot), recover (R: +5 s), restart (Enter: the rivals must stay on the grid through the intro), pause
// (Esc) and resume, then a DNF (terminal damage) and its results. A screenshot and a state line at each step.
//
//   node tools/check/playthrough.mjs [--url http://localhost:4173/backroad-rally/] [--stage wales] [--size 1600x900]
//        [--params "weather=rain"] [--out shots/playthrough] [--webgpu]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const stage = arg('--stage', 'wales');
const [w, h] = arg('--size', '1600x900').split('x').map(Number);
const out = arg('--out', 'shots/playthrough');
const extra = arg('--params', '');
const webgpu = argv.includes('--webgpu');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable'),
  args: (process.env.CHROME_ARGS ?? (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist' : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist')).split(' '),
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/ImportMemory|SharedImage/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const state = () => page.evaluate(() => {
  const br = window.__br, run = br.level.run;
  const shown = br.rivals?.rivals.filter((r) => r.mesh?.visible).length ?? 0;
  return `${run.phase} clock ${run.clock.toFixed(2)} pen ${run.penalties} recovers ${run.recovers} dnf ${run.dnf}${run.dnfReason ? ` (${run.dnfReason})` : ''}` +
    ` rivals ${br.rivals?.rivals.length ?? 0} (${shown} drawn) paused ${br.paused} s=${Math.round(br.level.tracker?.proj?.s ?? 0)} damage ${(br.damage.value * 100).toFixed(0)}%`;
});
let n = 0;
const shot = async (name) => {
  const file = join(out, `${String(++n).padStart(2, '0')}_${name}.png`);
  if (!webgpu) await page.screenshot({ path: file });
  console.log(`${name.padEnd(14)} ${await state()}  ${webgpu ? '' : file}`);
};
const q = [`mode=quick&stage=${stage}&car=swift&cond=stage&weather=stage&rivals=3&autopilot=110`, webgpu ? '' : 'webgl', extra].filter(Boolean).join('&');
await page.goto(`${base}?${q}`);
await page.waitForFunction(() => window.__br?.ready && window.__br.level?.run, null, { timeout: 180000 });
await page.waitForFunction(() => window.__br.level.run.phase === 'countdown', null, { timeout: 30000 });
await shot('countdown');
await page.waitForFunction(() => window.__br.level.run.clock > 8, null, { timeout: 60000 });
await shot('driving');
// recover (+5 s)
await page.keyboard.press('KeyR');
await page.waitForTimeout(1200);
await shot('recovered');
// restart: the intro again, with the rivals on the grid at once (they re-pick in the background)
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
await shot('restart_intro');
const missing = await page.evaluate(async () => {
  // sample the intro every frame: how many frames had no rival mesh at all
  let none = 0, frames = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 1500 && window.__br.level.run.phase !== 'running') {
    await new Promise((r) => requestAnimationFrame(r));
    frames++;
    if (!(window.__br.rivals?.rivals ?? []).some((r) => r.mesh)) none++;
  }
  return `${none} of ${frames} intro frames without rival meshes`;
});
console.log(`restart: ${missing}`);
await page.waitForFunction(() => window.__br.level.run.phase === 'running' && window.__br.level.run.clock > 3, null, { timeout: 60000 });
// pause and resume
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const c0 = await page.evaluate(() => window.__br.level.run.clock);
await page.waitForTimeout(1000);
const c1 = await page.evaluate(() => window.__br.level.run.clock);
await shot('paused');
console.log(`pause: clock ${c0.toFixed(3)} -> ${c1.toFixed(3)} (${c0 === c1 ? 'frozen' : 'MOVED'})`);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await shot('resumed');
// DNF: the car wrecked (terminal damage retires the run), then the results
await page.evaluate(() => window.__br.damage.add(1));
await page.waitForFunction(() => window.__br.level.run.phase === 'results', null, { timeout: 30000 });
await page.waitForTimeout(800);
await shot('dnf_results');
console.log(errors.length ? `console errors:\n  ${[...new Set(errors)].slice(0, 8).join('\n  ')}` : 'no console errors');
await browser.close();
