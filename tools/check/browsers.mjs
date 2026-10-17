#!/usr/bin/env node
// Browser matrix: the title, then a quick stage driven by the autopilot for --seconds, in one browser setup; prints
// the backend and GPU the page landed on, the auto quality tier, the frame rate and frame-time spread, console errors,
// and saves a screenshot of each screen.
//
//   node tools/check/browsers.mjs --browser chrome|chrome-webgpu|chrome-rtx|chrome-rtx-webgl|firefox
//        [--url http://localhost:4173/backroad-rally/] [--stage finland] [--seconds 30] [--size 1600x968] [--out shots/browsers]
//
// chrome: a headed Chrome as a player runs it (Wayland, no flags: WebGL2 on the integrated GPU). chrome-webgpu: the
// same with WebGPU switched on. chrome-rtx(-webgl): Chrome as an X11 client on the NVIDIA GPU (the wiki's "Desktop
// Chrome on a hybrid-graphics laptop" command), WebGPU or ?webgl. firefox: Playwright's Firefox build (install it with
// PLAYWRIGHT_BROWSERS_PATH=<dir> npx playwright-core install firefox, and keep the variable set), headed.
import { chromium, firefox } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const which = arg('--browser', 'chrome');
const stage = arg('--stage', 'finland');
const seconds = Number(arg('--seconds', '30'));
const [vw, vh] = arg('--size', '1600x968').split('x').map(Number);
const out = arg('--out', 'shots/browsers');
mkdirSync(out, { recursive: true });

const env = { ...process.env };
for (const k of ['__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__EGL_VENDOR_LIBRARY_FILENAMES', '__VK_LAYER_NV_optimus']) delete env[k];
let browser;
let query = '';
const chrome = '/usr/bin/google-chrome-stable';
if (which === 'firefox') browser = await firefox.launch({ headless: false, env });
else if (which.startsWith('chrome-rtx')) {
  Object.assign(env, { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' });
  browser = await chromium.launch({ executablePath: chrome, headless: false, env,
    args: ['--ozone-platform=x11', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE', '--enable-unsafe-webgpu'] });
  if (which === 'chrome-rtx-webgl') query = 'webgl';
} else {
  browser = await chromium.launch({ executablePath: chrome, headless: false, env,
    args: ['--ozone-platform=wayland', ...(which === 'chrome-webgpu' ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE'] : [])] });
}
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const errors = [];
let dawn = 0;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/ImportMemory|SharedImage/i.test(m.text())) dawn++;
  else errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
const q = (extra) => [query, extra].filter(Boolean).join('&');

// the title
let t0 = Date.now();
await page.goto(`${base}?${q('')}`);
await page.waitForFunction(() => window.__br?.ready, null, { timeout: 180000 });
const titleS = (Date.now() - t0) / 1000;
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, `${which}_title.png`) });
const titleInfo = await page.evaluate(() => ({ gpu: window.__br.gpu, backend: window.__br.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
  tier: window.__br.look.qualityName, scale: window.__br.look.scale }));
// a quick stage, the robot driving
t0 = Date.now();
await page.goto(`${base}?${q(`mode=quick&stage=${stage}&car=swift&cond=stage&weather=stage&autopilot=120&fps=60`)}`);
await page.waitForFunction(() => window.__br?.ready && window.__br.level?.run, null, { timeout: 180000 });
const stageS = (Date.now() - t0) / 1000;
await page.waitForTimeout(3000);
await page.evaluate(() => window.__br.perf.reset?.());
await page.waitForTimeout(seconds * 1000);
// the frame statistics first: a screenshot stalls the page for a frame or two
const r = await page.evaluate(() => {
  const br = window.__br;
  const f = br.perf.frames.map((x) => x.dt).sort((a, b) => a - b);
  const at = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
  return { gpu: br.gpu, backend: br.backend, tier: br.look.qualityName, scale: br.look.scale, log: br.auto?.log ?? [], n: f.length,
    mean: f.reduce((a, b) => a + b, 0) / f.length, p50: at(0.5), p99: at(0.99), max: f[f.length - 1], over25: f.filter((x) => x > 25).length,
    phase: br.level.run.phase, s: br.level.tracker?.proj?.s };
});
await page.screenshot({ path: join(out, `${which}_stage.png`) });
await browser.close();
console.log(`${which}: title ${titleS.toFixed(1)} s (${titleInfo.backend}, ${titleInfo.tier}${titleInfo.scale < 1 ? `@${titleInfo.scale}` : ''}); stage ${stageS.toFixed(1)} s`);
console.log(`  gpu: ${r.gpu} (${r.backend}); auto: ${r.tier}${r.scale < 1 ? `@${r.scale}` : ''} [${r.log.join(' | ')}]`);
console.log(`  ${r.n} frames in ${seconds} s: ${(1000 / r.mean).toFixed(1)} fps, dt p50 ${r.p50?.toFixed(1)} p99 ${r.p99?.toFixed(1)} max ${r.max?.toFixed(0)} ms, ${r.over25} over 25 ms; run ${r.phase} at s=${Math.round(r.s ?? 0)}`);
console.log(`  console errors: ${errors.length ? [...new Set(errors)].slice(0, 6).join(' || ') : 'none'}${dawn ? ` (+${dawn} Dawn ImportMemory/SharedImage lines)` : ''}`);
