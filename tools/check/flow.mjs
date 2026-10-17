#!/usr/bin/env node
// The game flow, end to end (slice 9): title -> garage -> stage select -> loading card -> the stage -> pause ->
// settings (three pages) -> results -> back to the menus, in headless Chrome. Saves a screenshot of every screen and
// prints the console errors and the page's state at each step.
//
//   node tools/check/flow.mjs [--url http://localhost:4173/backroad-rally/] [--size 1920x1080] [--out shots/flow]
//        [--input keys|pad|mouse] [--webgpu] [--headed] [--noshot] [--tag name] [--params "quality=low"] [--chrome /path/to/chrome]
//
// --input pad drives every menu with a fake standard gamepad (navigator.getGamepads is replaced in the page);
// mouse clicks the rows. WebGL2 by default; headless WebGPU can't take screenshots (see docs/reference.md): use
// --webgpu --noshot to walk it and check the console, or --headed for pictures.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const [w, h] = arg('--size', '1920x1080').split('x').map(Number);
const out = arg('--out', 'shots/flow');
const input = arg('--input', 'keys');
const webgpu = process.argv.includes('--webgpu');
const headed = process.argv.includes('--headed');
const noshot = process.argv.includes('--noshot');
const tag = arg('--tag', `${input}_${webgpu ? 'webgpu' : 'webgl'}_${w}x${h}`);
const extra = arg('--params', '');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  headless: !headed,
  args: (process.env.CHROME_ARGS ?? (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist'
    : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist')).split(' ').filter(Boolean),
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
// a fake standard gamepad the steps press buttons on (index: A 0, B 1, start 9, d-pad 12-15)
await page.addInitScript(() => {
  const pad = { id: 'fake pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad;
  navigator.getGamepads = () => (window.__padOn ? [pad] : []);
});

const q = (p) => `${base}${p ? `?${p}` : ''}`;
const sticky = [webgpu ? '' : 'webgl', extra].filter(Boolean).join('&');
const shots = [];
const wait = (ms) => page.waitForTimeout(ms);
async function shot(name) {
  const file = noshot ? '(no shot)' : join(out, `${tag}_${name}.png`);
  if (!noshot) {
    await page.screenshot({ path: file });
    shots.push(file);
  }
  const s = await page.evaluate(() => {
    const b = window.__br;
    const m = b?.menu;
    return m?.screen ? `menu ${m.screen} row ${m.ctl.index} car ${m.car?.id} stage ${m.stage?.id}`
      : b?.level?.run ? `stage ${b.level.run.phase} clock ${b.level.run.clock.toFixed(2)} paused ${b.paused} panel ${b.menus?.open}` : '?';
  }).catch(() => '?');
  console.log(`${name.padEnd(22)} ${s.padEnd(60)} ${file}`);
}
async function ready(timeout = 90000) {
  await page.waitForFunction(() => window.__br?.ready === true, null, { timeout });
}
async function press(key, times = 1) {
  for (let i = 0; i < times; i++) {
    if (input === 'pad') {
      const btn = { ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15, Enter: 0, Escape: key === 'Escape' && (await inStage()) ? 9 : 1 }[key];
      if (btn === undefined) await page.keyboard.press(key);
      else {
        await page.evaluate((b) => {
          window.__padOn = true;
          window.__pad.buttons[b].pressed = true;
          window.__pad.buttons[b].value = 1;
        }, btn);
        await wait(120);
        await page.evaluate((b) => {
          window.__pad.buttons[b].pressed = false;
          window.__pad.buttons[b].value = 0;
        }, btn);
      }
    } else await page.keyboard.press(key);
    await wait(160);
  }
}
async function inStage() {
  return page.evaluate(() => !!window.__br?.level?.run && !window.__br?.menus?.open);
}
/** Choose a row by its text: keys/pad walk to it, mouse clicks it. */
async function choose(text) {
  if (input === 'mouse') {
    const box = await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('.menu-root .row')].filter((r) => r.offsetParent);
      const r = rows.find((x) => x.querySelector('.text')?.textContent.trim() === t);
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: b.left + 40, y: b.top + b.height / 2 };
    }, text);
    if (!box) throw new Error(`no row "${text}"`);
    await page.mouse.move(box.x - 5, box.y);
    await page.mouse.move(box.x, box.y, { steps: 3 });
    await page.mouse.click(box.x, box.y);
    await wait(250);
    return;
  }
  const idx = await page.evaluate((t) => {
    const c = window.__br?.menu?.ctl ?? window.__br?.menus?.ctl;
    const rows = c?.screen?.rows ?? [];
    return { want: rows.findIndex((r) => (typeof r.spec.text === 'function' ? r.spec.text() : r.spec.text) === t), at: c?.index ?? 0 };
  }, text);
  if (idx.want < 0) throw new Error(`no row "${text}"`);
  const d = idx.want - idx.at;
  await press(d > 0 ? 'ArrowDown' : 'ArrowUp', Math.abs(d));
  await press('Enter');
}
/** Step an option row (keys/pad: left/right; mouse: click the value, right click for -1). */
async function adjust(text, dir, times = 1) {
  if (input === 'mouse') {
    for (let i = 0; i < times; i++) {
      const box = await page.evaluate((t) => {
        const rows = [...document.querySelectorAll('.menu-root .row')].filter((r) => r.offsetParent);
        const r = rows.find((x) => x.querySelector('.text')?.textContent.trim() === t);
        const v = r?.querySelector('.value')?.getBoundingClientRect();
        return v ? { x: v.left + v.width / 2, y: v.top + v.height / 2 } : null;
      }, text);
      if (!box) throw new Error(`no option "${text}"`);
      await page.mouse.move(box.x, box.y, { steps: 2 });
      await page.mouse.click(box.x, box.y, { button: dir > 0 ? 'left' : 'right' });
      await wait(200);
    }
    return;
  }
  const idx = await page.evaluate((t) => {
    const c = window.__br?.menu?.ctl ?? window.__br?.menus?.ctl;
    const rows = c?.screen?.rows ?? [];
    return { want: rows.findIndex((r) => (typeof r.spec.text === 'function' ? r.spec.text() : r.spec.text) === t), at: c?.index ?? 0 };
  }, text);
  if (idx.want < 0) throw new Error(`no option "${text}"`);
  const d = idx.want - idx.at;
  await press(d > 0 ? 'ArrowDown' : 'ArrowUp', Math.abs(d));
  await press(dir > 0 ? 'ArrowRight' : 'ArrowLeft', times);
}

const t0 = Date.now();
try {
  // a clean profile: no save, no settings
  await page.goto(q(sticky));
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(q(sticky));
  await ready();
  await wait(800);
  await shot('01_title');
  await choose('quick stage');
  await wait(600);
  await shot('02_garage');
  await adjust('car', 1, 2); // la lama: locked in a fresh save
  await wait(1500);
  await shot('03_garage_locked');
  await choose('choose stage'); // refused: shakes, the bonk
  await wait(200);
  await shot('04_garage_refused');
  await adjust('car', -1, 2);
  await wait(800);
  await choose('choose stage');
  await wait(600);
  await shot('05_stageselect');
  await adjust('time of day', 1, 4); // night, live
  await wait(1200);
  await shot('06_stageselect_night');
  await adjust('time of day', -1, 4);
  // another location: the curtain rises and the page loads again with the menu's state
  await adjust('stage', 1, 3);
  await wait(500);
  await page.waitForFunction(() => window.__br?.menu?.screen === 'stageselect' && window.__br?.loaded?.location === 'wales', null, { timeout: 60000 });
  await ready();
  await wait(800);
  await shot('07_stageselect_wales');
  await adjust('stage', -1, 3);
  await page.waitForFunction(() => window.__br?.loaded?.location === 'finland', null, { timeout: 60000 });
  await ready();
  await wait(300);
  await choose('start');
  await wait(150);
  await shot('08_loading');
  await page.waitForFunction(() => !!window.__br?.level?.run, null, { timeout: 90000 });
  await shot('09_curtain');
  await ready();
  await wait(1200);
  await shot('10_intro');
  const fr = await page.evaluate(() => {
    const f = window.__br.perf.frames.slice(-120);
    return { fps: f.length ? 1000 / (f.reduce((a, x) => a + x.dt, 0) / f.length) : 0, backend: window.__br.backend, gpu: window.__br.gpu };
  });
  console.log(`stage: ${fr.backend} ${fr.gpu} ${fr.fps.toFixed(1)} fps`);
  await page.waitForFunction(() => window.__br.level.run.phase === 'running', null, { timeout: 90000 });
  await page.keyboard.down('KeyW');
  await wait(2500);
  await page.keyboard.up('KeyW');
  await press('Escape');
  await wait(400);
  const clockA = await page.evaluate(() => window.__br.level.run.clock);
  await shot('11_pause');
  await wait(1500);
  const clockB = await page.evaluate(() => window.__br.level.run.clock);
  console.log(`paused clock ${clockA.toFixed(3)} -> ${clockB.toFixed(3)} (${clockA === clockB ? 'frozen' : 'MOVED'})`);
  await choose('settings');
  await wait(400);
  await shot('12_settings');
  await adjust('field of view', 1, 2);
  await choose('sound  ›');
  await wait(300);
  await shot('13_settings_sound');
  await press('Escape');
  await wait(300);
  await choose('display & graphics  ›');
  await wait(300);
  await shot('14_settings_display');
  await adjust('frame-rate limit', 1, 1);
  await press('Escape');
  await wait(200);
  await press('Escape'); // back to pause
  await wait(200);
  await choose('resume');
  await wait(500);
  const fov = await page.evaluate(() => ({ fov: window.__br.chase.fovOverride, set: JSON.parse(localStorage.getItem('backroad-rally.game') ?? '{}').fov }));
  console.log(`settings applied: fov override ${fov.fov}, saved ${fov.set}`);
  // to the finish: put the car 40 m before the line at speed
  await page.evaluate(() => {
    const { vehicle, sim, level } = window.__br;
    const t = level.tracker;
    const s = t.finishS - t.sign * 40;
    const pose = t.road.pose(s, t.sign);
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
  await page.waitForFunction(() => window.__br.level.run.phase !== 'running', null, { timeout: 30000 }).catch(() => {});
  await page.keyboard.up('KeyW');
  await page.waitForFunction(() => window.__br.menus.open === 'results', null, { timeout: 30000 });
  await wait(600);
  await shot('15_results');
  await choose('choose another stage');
  await page.waitForFunction(() => window.__br?.menu?.screen === 'stageselect', null, { timeout: 60000 });
  await ready();
  await wait(600);
  await shot('16_stageselect_best');
  await press('Escape');
  await wait(300);
  await press('Escape');
  await wait(400);
  await shot('17_title_again');
  await choose('career');
  await wait(400);
  await shot('18_career_soon');
  console.log(`flow done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.log(`FAILED: ${e.message}`);
  await shot('fail').catch(() => {});
  process.exitCode = 1;
}
console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
await browser.close();
