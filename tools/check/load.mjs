#!/usr/bin/env node
// Load time on a home connection: a cold cache, the network throttled (CDP emulation, default 20 Mbit/s down, 20 ms),
// audio held until a gesture as in a normal browser. Opens the title (time until its curtain lifts), then, like the
// stage select, starts a quick stage in the same tab (time until the curtain lifts and until the countdown), and
// prints bytes and requests for each part, the biggest downloads and any URL fetched twice.
//
//   node tools/check/load.mjs [--url http://localhost:4173/backroad-rally/] [--mbit 20] [--latency 20]
//        [--stage wales] [--menu-wait 0] [--again] [--webgpu] [--json out.json]
//
// --menu-wait s stays on the title that long before starting the stage (a player looking at the menus: the time a
// preload gets). Headless Chrome with the hardware WebGL2 flags (?webgl) unless --webgpu.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const mbit = Number(arg('--mbit', '20'));
const latency = Number(arg('--latency', '20'));
const stage = arg('--stage', 'wales');
const menuWait = Number(arg('--menu-wait', '0'));
const webgpu = argv.includes('--webgpu');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');

const browser = await chromium.launch({
  executablePath,
  // a normal browser holds audio until the first key or click (Playwright's default lets it play at once)
  ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'],
  args: [...(webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist' : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist').split(' '),
    '--autoplay-policy=user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: (mbit * 1e6) / 8, uploadThroughput: (5 * 1e6) / 8 });
const reqs = new Map(); // requestId -> { url, bytes, fromCache, phase, start, end }
let phase = 'title';
cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, bytes: 0, cache: false, phase, start: e.timestamp, end: 0 }));
cdp.on('Network.requestServedFromCache', (e) => reqs.get(e.requestId) && (reqs.get(e.requestId).cache = true));
cdp.on('Network.responseReceived', (e) => {
  const r = reqs.get(e.requestId);
  if (r && (e.response.fromDiskCache || e.response.fromMemoryCache || e.response.fromPrefetchCache)) r.cache = true;
});
cdp.on('Network.loadingFinished', (e) => {
  const r = reqs.get(e.requestId);
  if (r) {
    r.bytes = e.encodedDataLength;
    r.end = e.timestamp;
  }
});
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const q = webgpu ? '' : 'webgl';
const t0 = Date.now();
await page.goto(`${base}?${q}`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__br?.ready, null, { timeout: 180000, polling: 100 });
const title = (Date.now() - t0) / 1000;
if (menuWait > 0) await page.waitForTimeout(menuWait * 1000);
phase = 'stage';
const t1 = Date.now();
await page.evaluate((u) => location.assign(u), `${base}?mode=quick&stage=${stage}&car=swift&cond=stage&weather=stage${q ? `&${q}` : ''}`);
await page.waitForFunction(() => window.__br?.ready && window.__br?.level?.run, null, { timeout: 180000, polling: 100 });
const stageReady = (Date.now() - t1) / 1000;
await page.waitForFunction(() => window.__br.level.run.phase !== 'intro', null, { timeout: 60000, polling: 50 });
const countdown = (Date.now() - t1) / 1000;
const timings = await page.evaluate(() => {
  const t = window.__br.level.stage?.timings ?? {};
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)]));
});
const autoLog = await page.evaluate(() => window.__br.auto?.log ?? []);
// --again: the same visit again in the same tab (a returning player: the HTTP cache and the remembered quality)
let again = '';
if (argv.includes('--again')) {
  phase = 'again';
  const t2 = Date.now();
  await page.evaluate((u) => location.assign(u), `${base}?${q}`);
  await page.waitForFunction(() => window.__br?.ready && !window.__br?.level, null, { timeout: 180000, polling: 100 });
  const title2 = (Date.now() - t2) / 1000;
  const t3 = Date.now();
  await page.evaluate((u) => location.assign(u), `${base}?mode=quick&stage=${stage}&car=swift&cond=stage&weather=stage${q ? `&${q}` : ''}`);
  await page.waitForFunction(() => window.__br?.ready && window.__br?.level?.run, null, { timeout: 180000, polling: 100 });
  const stage2 = (Date.now() - t3) / 1000;
  again = `again (cached, remembered quality): title ${title2.toFixed(1)} s, stage curtain up ${stage2.toFixed(1)} s`;
}
await browser.close();

const sum = (ph) => {
  const rs = [...reqs.values()].filter((r) => r.phase === ph);
  const net = rs.filter((r) => !r.cache && r.bytes > 0);
  return { requests: rs.length, network: net.length, cached: rs.filter((r) => r.cache).length, mb: +(net.reduce((a, r) => a + r.bytes, 0) / 1e6).toFixed(2) };
};
const short = (u) => u.replace(base, '').replace(/^\.?\//, '');
const top = [...reqs.values()].filter((r) => !r.cache).sort((a, b) => b.bytes - a.bytes).slice(0, 12)
  .map((r) => `${r.phase.padEnd(5)} ${(r.bytes / 1e6).toFixed(2).padStart(6)} MB  ${short(r.url)}`);
const seen = new Map();
for (const r of reqs.values()) if (!r.cache && r.bytes > 0 && !r.url.startsWith('data:')) seen.set(r.url, (seen.get(r.url) ?? 0) + 1);
const dup = [...seen].filter(([, n]) => n > 1).map(([u, n]) => `${short(u)} x${n}`);
const res = { mbit, latency, stage, title, stageReady, countdown, titleNet: sum('title'), stageNet: sum('stage'), top, dup, errors: [...new Set(errors)].slice(0, 8) };
console.log(`${mbit} Mbit/s, ${latency} ms: title ${title.toFixed(1)} s | quick stage (${stage}): curtain up ${stageReady.toFixed(1)} s, countdown ${countdown.toFixed(1)} s`);
if (again) console.log(`${again}; ${JSON.stringify(sum('again'))}`);
console.log(`stage build (ms): ${JSON.stringify(timings)}; auto: ${autoLog.join(' | ')}`);
console.log(`title: ${JSON.stringify(res.titleNet)}\nstage: ${JSON.stringify(res.stageNet)}`);
console.log(`biggest downloads:\n  ${top.join('\n  ')}`);
console.log(`fetched twice: ${dup.join(', ') || 'none'}`);
if (res.errors.length) console.log(`console errors:\n  ${res.errors.join('\n  ')}`);
if (arg('--json', '')) writeFileSync(arg('--json', ''), JSON.stringify({ ...res, reqs: [...reqs.values()] }, null, 1));
