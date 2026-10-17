#!/usr/bin/env node
// Every wait between screens, as a player sees it: the first load to the title, a car change in the garage, another
// location in the stage select (a page load), start a stage, restart, quit to the menu, and (--career) the career's
// "next stage". For each: how long from the press until the scene shows, how much of that the loading indicator
// (`.busy`, src/menu/busy.ts) was on screen, how long the screen was blank (only the curtain colour), and the phases.
//
//   node tools/check/transitions.mjs [--url http://localhost:4173/backroad-rally/] [--size 1920x1080] [--webgpu]
//        [--headed] [--career] [--net 20] [--out shots/transitions] [--keep] [--shots] [--params "..."]
//
// The page logs its state (curtain, card, indicator, ready) through an exposed binding at every frame and every
// 50 ms, across page loads; a CDP screencast (every frame) gives the pixels, also between two pages. --headed runs a
// Wayland Chrome at the screen's size (as flash.mjs). --shots saves a screenshot of each transition while the
// indicator shows. --net <Mbit/s> emulates a home connection (20 ms latency), so the first car change in the garage
// waits for the model's download (the menu prefetches the cars 1 s after the title shows). --keep keeps the screencast JPEGs. Needs ImageMagick (`magick`) for the pixel test.
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const webgpu = argv.includes('--webgpu');
const headed = argv.includes('--headed');
const career = argv.includes('--career');
const out = arg('--out', 'shots/transitions');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
const frames = join(out, 'frames');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

let size = arg('--size', '1920x1080');
let dpr = 1;
const env = { ...process.env };
let args;
if (headed) {
  args = ['--ozone-platform=wayland'];
  if (webgpu) args.push('--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE');
  try {
    const m = JSON.parse(execSync('hyprctl monitors -j').toString())[0];
    if (!argv.includes('--size')) size = `${Math.round(m.width / m.scale)}x${Math.round(m.height / m.scale)}`;
    dpr = m.scale;
  } catch {}
} else {
  args = (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist'
    : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist').split(' ');
}
const [w, h] = size.split('x').map(Number);
const browser = await chromium.launch({ executablePath, env, headless: !headed, args });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/ImportMemory|SharedImage/i.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

// the page's state over time (epoch ms), from every document
const log = [];
const navs = [];
await page.exposeBinding('__tl', (_src, s) => log.push(s));
page.on('framenavigated', (f) => f === page.mainFrame() && navs.push(Date.now()));
await page.addInitScript(() => {
  let last = '';
  const vis = (e) => {
    if (!e || !e.getClientRects().length) return 0;
    let o = 1;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= Number(cs.opacity);
    }
    return o;
  };
  const sample = () => {
    const br = window.__br;
    const curtain = Math.max(0, ...[...document.querySelectorAll('.menu-root .curtain')].map(vis));
    const card = Math.max(0, ...[...document.querySelectorAll('.menu-root .loading')].map((e) => (e.querySelector('.card') ? vis(e) : 0)));
    const busy = Math.max(0, ...[...document.querySelectorAll('.busy')].map(vis));
    const s = {
      ui: !!document.querySelector('.menu-root'), panel: !!document.querySelector('.menu-root .content .panel'),
      curtain: Math.round(curtain * 10) / 10, card: card > 0.5, busy: busy > 0.3, ready: !!br?.ready,
      car: br?.car?.id ?? null, loc: br?.loaded?.location ?? null, run: br?.level?.run ? br.level.run.phase : null,
      busyText: [...document.querySelectorAll('.busy')].filter((e) => vis(e) > 0.3).map((e) => e.textContent.trim()).join(' | '),
    };
    const k = JSON.stringify(s);
    if (k !== last) {
      last = k;
      window.__tl?.({ t: Date.now(), url: location.search, ...s });
    }
  };
  const loop = () => {
    sample();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(sample, 50);
});

await page.goto('about:blank');
const cdp = await page.context().newCDPSession(page);
const shots = [];
cdp.on('Page.screencastFrame', (f) => {
  const i = shots.length;
  writeFileSync(join(frames, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
  shots.push(f.metadata.timestamp * 1000);
  void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
if (arg('--net', '')) {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (Number(arg('--net', '20')) * 1e6) / 8, uploadThroughput: (5 * 1e6) / 8 });
}
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });

const wait = (ms) => page.waitForTimeout(ms);
const press = async (key, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await wait(160);
  }
};
const rowsOf = () => page.evaluate(() => {
  const c = window.__br?.menu?.ctl ?? window.__br?.menus?.ctl;
  return { rows: (c?.screen?.rows ?? []).map((r) => String(typeof r.spec.text === 'function' ? r.spec.text() : r.spec.text)), at: c?.index ?? 0 };
});
/** Walk to the row (text or regexp); `act` presses Enter (or the given key) as the timed action. */
async function goRow(text) {
  const { rows, at } = await rowsOf();
  const want = rows.findIndex((r) => (text instanceof RegExp ? text.test(r) : r === text));
  if (want < 0) throw new Error(`no row ${text} in [${rows.join(', ')}]`);
  await press(want > at ? 'ArrowDown' : 'ArrowUp', Math.abs(want - at));
}
const transitions = [];
const shotFiles = [];
/** Time one transition: `act` starts it, `done` (in the page) ends it. */
async function measure(name, act, done, timeout = 120000) {
  const t0 = Date.now();
  await act();
  let shotTaken = false;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (argv.includes('--shots') && !shotTaken && log.length && log[log.length - 1].t >= t0 && log[log.length - 1].busy) {
      shotTaken = true;
      const file = join(out, `${name.replace(/\W+/g, '_')}.png`);
      await page.screenshot({ path: file }).then(() => shotFiles.push(file)).catch(() => {});
    }
    const ok = await page.evaluate(done).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`${name}: timed out`);
    await wait(30);
  }
  const t1 = Date.now();
  transitions.push({ name, t0, t1 });
  console.log(`${name}: ${((t1 - t0) / 1000).toFixed(2)} s`);
  await wait(600);
}
const settled = () => window.__br?.ready === true;

try {
  // 1. the first visit: a fresh profile, a cold cache
  await measure('first load -> title', () => page.goto(`${base}?${webgpu ? '' : 'webgl'}${arg('--params', '') ? `&${arg('--params', '')}` : ''}`), settled);
  // 2. the garage at once, before the menu prefetches the cars (1 s after the curtain): another car's model loads
  await goRow('quick stage');
  await page.keyboard.press('Enter');
  await wait(150);
  await goRow('car');
  await measure('garage: car change (pip, first)', () => page.keyboard.press('ArrowRight'), () => window.__br?.car?.id === 'pip');
  await wait(2500);
  await measure('garage: car change (swift)', () => press('ArrowLeft'), () => window.__br?.car?.id === 'swift');
  await measure('garage: livery change', () => press('ArrowDown').then(() => press('ArrowRight')), () => true);
  await press('ArrowLeft');
  // 3. the stage select: another location (a page load behind the curtain)
  await goRow('choose stage');
  await press('Enter');
  await wait(600);
  await goRow('stage');
  const loc0 = await page.evaluate(() => window.__br.loaded.location);
  await measure('stage select: location change', () => press('ArrowRight'),
    `window.__br?.loaded?.location && window.__br.loaded.location !== ${JSON.stringify(loc0)} && window.__br.ready === true`);
  await goRow('weather');
  const w0 = await page.evaluate(() => window.__br.loaded.weather);
  await measure('stage select: weather change', () => press('ArrowRight', 3),
    `window.__br?.loaded?.weather && window.__br.loaded.weather !== ${JSON.stringify(w0)} && window.__br.ready === true`);
  // 4. start the stage
  await goRow('start');
  await measure('stage select -> stage', () => press('Enter'), () => !!window.__br?.level?.run && window.__br.ready === true);
  await page.waitForFunction(() => window.__br.level.run.phase === 'running', null, { timeout: 60000 });
  // 5. restart (in place)
  await measure('restart', () => press('Enter'), () => window.__br.level.run.phase === 'intro' && window.__br.ready === true);
  // 6. quit to the menu
  await wait(1500);
  await press('Escape');
  await wait(300);
  await goRow(/^quit/);
  await measure('quit to menu', () => press('Enter'), () => !!window.__br?.menu && window.__br.ready === true);
  if (career) {
    // 7. the career: start, finish stage 1 (teleport to the line), "next stage"
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.goto(`${base}?${webgpu ? '' : 'webgl&'}unlockall`);
    await page.waitForFunction(settled, null, { timeout: 120000 });
    await goRow('career');
    await press('Enter');
    await wait(500);
    await goRow(/^(start career|start rally: .*)$/);
    await press('Enter');
    await wait(500);
    for (let i = 0; i < 3; i++) {
      const { rows } = await rowsOf();
      const r = rows.find((x) => /^(yes.*|start new career|start rally.*|start rally: .*)$/.test(x));
      if (!r) break;
      await goRow(r);
      if (/^start rally/.test(r) && (await page.evaluate(() => window.__br?.menu?.screen)) === 'garage') {
        await measure('career: garage -> stage 1', () => press('Enter'), () => !!window.__br?.level?.run && window.__br.ready === true);
        break;
      }
      await press('Enter');
      await wait(500);
    }
    await page.waitForFunction(() => window.__br?.level?.run?.phase === 'running', null, { timeout: 60000 });
    await page.evaluate(() => {
      const { vehicle, sim, level } = window.__br;
      const t = level.tracker;
      const pose = t.road.pose(t.finishS - t.sign * 40, t.sign);
      pose.position.y += 0.4;
      vehicle.teleport(pose.position, pose.yawDeg);
      const yaw = (-pose.yawDeg * Math.PI) / 180;
      const v = 60 / 3.6;
      vehicle.body.setLinvel({ x: Math.cos(yaw) * v, y: 0, z: -Math.sin(yaw) * v }, true);
      for (const wh of vehicle.wheels) wh.omega = v / vehicle.t.wheelRadius;
      sim.snap();
      t.reset();
    });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__br.menus.open === 'results', null, { timeout: 60000 });
    await page.keyboard.up('KeyW');
    await wait(800);
    await goRow(/^(next stage|continue).*/);
    // done on the next page (a document that started after the press)
    await measure('career: next stage', () => press('Enter'), `performance.timeOrigin > ${Date.now()} && !!window.__br?.level?.run && window.__br.ready === true`);
  }
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  process.exitCode = 1;
}
await wait(300);
await cdp.send('Page.stopScreencast').catch(() => {});
await browser.close();

// the pixel test: a frame is blank when nearly all of it is the curtain colour (#f1ede7)
const blank = new Array(shots.length).fill(false);
for (let k = 0; k < shots.length; k += 300) {
  const idx = shots.slice(k, k + 300).map((_, j) => k + j);
  const raw = execFileSync('magick', [...idx.map((i) => join(frames, `${String(i).padStart(5, '0')}.jpg`)), '-resize', '320x200!', '-depth', '8', 'rgb:-'],
    { maxBuffer: 1 << 30 });
  const n = 320 * 200;
  idx.forEach((i, j) => {
    let hit = 0;
    for (let p = 0; p < n; p++) {
      const o = (j * n + p) * 3;
      if (Math.abs(raw[o] - 0xf1) < 6 && Math.abs(raw[o + 1] - 0xed) < 6 && Math.abs(raw[o + 2] - 0xe7) < 6) hit++;
    }
    blank[i] = hit / n > 0.998;
  });
}

// the phases of each transition: what the screen shows from the press until the scene is up
const fmt = (ms) => `${(ms / 1000).toFixed(2)}`;
const rows = [];
for (const tr of transitions) {
  const pts = new Set([tr.t0, tr.t1]);
  for (const s of log) if (s.t > tr.t0 && s.t < tr.t1) pts.add(s.t);
  for (const t of shots) if (t > tr.t0 && t < tr.t1) pts.add(t);
  for (const t of navs) if (t > tr.t0 && t < tr.t1) pts.add(t);
  const ts = [...pts].sort((a, b) => a - b);
  const stateAt = (t) => {
    let s = null;
    for (const x of log) if (x.t <= t) s = x;
    const nav = navs.filter((n) => n <= t).pop() ?? 0;
    let f = -1;
    for (let i = 0; i < shots.length && shots[i] <= t; i++) f = i;
    const isBlank = f >= 0 && blank[f];
    if (s && nav > s.t) return isBlank ? 'blank' : 'old page'; // a new document, not yet logging
    if (!s) return isBlank ? 'blank' : 'old page';
    // the indicator is small and soft: a frame of nearly only the curtain colour may still show it
    if (isBlank && !s.busy) return 'blank';
    if (s.busy) return s.card ? 'card + indicator' : s.panel && s.curtain > 0.5 ? 'menu + curtain + indicator' : s.curtain > 0.5 ? 'curtain + indicator' : 'scene + indicator';
    if (s.card) return 'card';
    if (s.curtain > 0.5) return s.panel ? 'menu + curtain' : 'curtain';
    if (!s.ui) return 'page, no ui';
    return 'scene';
  };
  const phases = [];
  let busyMs = 0, blankMs = 0;
  for (let i = 0; i < ts.length - 1; i++) {
    const st = stateAt(ts[i]);
    const d = ts[i + 1] - ts[i];
    if (st.includes('indicator')) busyMs += d;
    if (st === 'blank') blankMs += d;
    const p = phases[phases.length - 1];
    if (p && p.st === st) p.ms += d;
    else phases.push({ st, ms: d });
  }
  const total = tr.t1 - tr.t0;
  const firstBusy = log.find((s) => s.t >= tr.t0 && s.t <= tr.t1 && s.busy);
  const texts = [...new Set(log.filter((s) => s.t >= tr.t0 && s.t <= tr.t1 && s.busyText).map((s) => s.busyText))];
  rows.push({ name: tr.name, total, busyMs, blankMs, uncovered: total - busyMs, firstBusy: firstBusy ? firstBusy.t - tr.t0 : null, texts,
    phases: phases.filter((p) => p.ms >= 40).map((p) => `${p.st} ${fmt(p.ms)}`).join(' > ') });
}
console.log('\n| transition | wait (s) | indicator (s) | blank (s) | no sign of progress (s) | indicator after (ms) | what shows |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.name} | ${fmt(r.total)} | ${fmt(r.busyMs)} | ${fmt(r.blankMs)} | ${fmt(r.uncovered)} | ${r.firstBusy ?? '-'} | ${r.phases} |`);
}
for (const r of rows) if (r.texts.length) console.log(`${r.name}: indicator texts: ${r.texts.join(' / ')}`);
if (shotFiles.length) console.log(`screenshots:\n  ${shotFiles.join('\n  ')}`);
console.log(errors.length ? `console errors:\n  ${[...new Set(errors)].slice(0, 12).join('\n  ')}` : 'no console errors');
writeFileSync(join(out, `transitions-${Date.now()}.json`), JSON.stringify({ transitions, rows, log, navs, shots, blank }, null, 0));
if (!argv.includes('--keep')) rmSync(frames, { recursive: true, force: true });
