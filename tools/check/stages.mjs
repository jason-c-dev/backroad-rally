#!/usr/bin/env node
// Load every stage (and direction, condition) and report what came up: console errors, load and build
// times, instances, colliders, features (fords, bridges, rock fade zones), and a screenshot at the start.
//
//   node tools/check/stages.mjs [--stages finland,japan,alps,wales,arizona,vermont] [--dirs fwd,rev]
//        [--conds stage] [--weathers clear,rain,snow] [--webgl] [--size 1280x534] [--wait 3] [--params "..."] [--out shots/stages]
//        [--headed] [--url http://localhost:4173/backroad-rally/] [--chrome /path/to/chrome]
//
// WebGPU: headless Chrome can't screenshot it (and on some laptops loses the device); --headed opens a
// normal window, e.g. CHROME_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE
// --ozone-platform=wayland" without --webgl.
// Exit code 1 if any page logged an error. Serve dist/ under /backroad-rally/ first (README).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const stages = arg('--stages', 'finland,japan,alps,wales,arizona,vermont').split(',');
const dirs = arg('--dirs', 'fwd').split(',');
const conds = arg('--conds', '').split(',');
const weathers = arg('--weathers', '').split(',');
const [w, h] = arg('--size', '1280x534').split('x').map(Number);
const wait = Number(arg('--wait', '3'));
const out = arg('--out', 'shots/stages');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  headless: !argv.includes('--headed'),
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});
let bad = 0;
for (const stage of stages) {
  for (const dir of dirs) {
    for (const cond of conds) for (const weather of weathers) {
      const q = new URLSearchParams({ stage });
      if (weather) q.set('weather', weather);
      if (dir === 'rev') q.set('dir', 'reverse');
      if (cond) q.set('cond', cond);
      if (argv.includes('--webgl')) q.set('webgl', '');
      for (const [k, v] of new URLSearchParams(arg('--params', ''))) q.set(k, v);
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || (m.type() === 'warning' && !/GPU stall|Automatic fallback/.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
      const t0 = Date.now();
      await page.goto(`${base}?${q}`);
      const ok = await page.waitForFunction(() => window.__br?.level?.run || document.getElementById('fatal'), null, { timeout: 90000 })
        .then(() => page.evaluate(() => !!window.__br?.level?.run)).catch(() => false);
      const loadMs = Date.now() - t0;
      if (ok) await page.waitForFunction(() => window.__br?.ready, null, { timeout: 30000 }).catch(() => {}); // the loading curtain
      await page.waitForTimeout(wait * 1000);
      const info = ok ? await page.evaluate(() => {
        const br = window.__br, st = br.level.stage, f = br.level.features;
        return {
          backend: br.backend, gpu: br.gpu, cond: br.look.cond.name, quality: br.look.qualityName,
          instances: st.stats.instances, colliders: st.stats.colliders, groups: st.stats.groups, instanceColliders: st.instanceColliders,
          timings: Object.fromEntries(Object.entries(st.timings).map(([k, v]) => [k, Math.round(v)])),
          fords: f?.fords.length ?? 0, bridges: f?.bridges.map(([a, b]) => [Math.round(a), Math.round(b)]), rockZones: f?.rockZones,
          animals: st.animals.length, programs: br.renderer._pipelines?.programs?.vertex?.size,
          weather: br.weather ? { name: br.weather.name, ice: br.weather.ice.map(([a, b]) => `${Math.round(a)}-${Math.round(b)}`).join(' '),
            marks: br.weather.marks?.counts, precip: br.weather.precip?.count ?? 0, hidden: [...st.hidden] } : null,
        };
      }) : null;
      const tagW = weather ? `-${weather}` : '';
      const file = join(out, `${stage}-${dir}${cond ? `-${cond}` : ''}${tagW}-${w}x${h}.png`);
      await page.screenshot({ path: file }).catch((e) => errors.push(`screenshot: ${e.message.split('\n')[0]}`));
      if (!ok || errors.length) bad++;
      console.log(`${stage} ${dir}${cond ? ` ${cond}` : ''}${weather ? ` ${weather}` : ''}: ${ok ? 'ok' : 'FAILED'} load ${loadMs} ms ${JSON.stringify(info)}`);
      if (errors.length) console.log(`  ERRORS\n  ${errors.slice(0, 12).join('\n  ')}`);
      await page.close();
    }
  }
}
await browser.close();
process.exit(bad ? 1 : 0);
