#!/usr/bin/env node
// Gaps in the ground: with ?seamtest the page paints the background magenta and keeps the fog off it, so a crack
// in the terrain (the background showing through between two meshes) is one loud colour. This script looks at
// the menus' backdrop while the orbit camera goes round the car (title and garage views), and at a few moments of a
// stage with the chase camera (the autopilot drives), and counts the magenta pixels in each frame.
//
//   node tools/check/seam.mjs [--url http://localhost:4173/backroad-rally/] [--size 1920x1080] [--dpr 1]
//        [--quality low,medium,high] [--yaws 12] [--menu 1|0] [--stages finland,japan] [--dirs fwd,rev]
//        [--samples 8] [--cond stage] [--weather stage] [--webgpu] [--headed] [--params "post=0"]
//        [--out shots/seam] [--keep 2] [--look] [--chrome /path/to/chrome]
//
// WebGL2 by default. --webgpu switches WebGPU on; it needs --headed: headless WebGPU has no valid canvas texture (the
// Dawn canvas import fails), so its frames come out blank. Each label names the backend the page really used (headed
// Wayland Chrome on an integrated GPU may have no WebGPU and fall back to WebGL2; on a hybrid laptop set
// CHROME_ARGS and the NVIDIA offload variables as tools/check/browsers.mjs chrome-rtx does). --keep N saves the N frames with the most magenta (and
// their masks: crack pixels white, open sky grey) for each configuration. The page writes exact magenta
// (255, 0, 255) where the depth is at the far plane, after every filter, so only empty pixels count (purple
// flowers don't). Thin patches (at most 3 px thick, not next to open sky) are cracks; the
// rest is sky seen between trees or over a hill, which is not a fault. A crack thinner than a pixel that MSAA (high on WebGL2) blends with the road is not counted: read
// the saved frames.
// --look leaves ?seamtest off: the same views as the game draws them, for screenshots (the counts mean nothing).
// Needs ImageMagick (`magick`) to read the frames. Prints one line per configuration and a summary; exits 1 when any frame had a crack pixel.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const [w, h] = arg('--size', '1920x1080').split('x').map(Number);
const dpr = Number(arg('--dpr', '1'));
const tiers = arg('--quality', 'low,medium,high').split(',').filter(Boolean);
const yaws = Number(arg('--yaws', '12'));
const doMenu = arg('--menu', '1') !== '0';
const stages = arg('--stages', '').split(',').filter(Boolean);
const dirs = arg('--dirs', 'fwd,rev').split(',').filter(Boolean);
const samples = Number(arg('--samples', '8'));
const cond = arg('--cond', 'stage');
const weather = arg('--weather', 'stage');
const webgpu = has('--webgpu');
const headed = has('--headed');
if (webgpu && !headed) {
  console.error('--webgpu needs --headed (headless WebGPU frames are blank)');
  process.exit(2);
}
const extra = arg('--params', '');
const out = arg('--out', 'shots/seam');
const keep = Number(arg('--keep', '2'));
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const env = { ...process.env };
const args = process.env.CHROME_ARGS?.split(' ').filter(Boolean)
  ?? (headed
    ? ['--ozone-platform=wayland', ...(webgpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE'] : [])]
    : webgpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist']
      : ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist']);
const browser = await chromium.launch({ executablePath, headless: !headed, args, env });
/** The backend the page landed on (a browser without WebGPU falls back to WebGL2). */
const backendOf = (page) => page.evaluate(() => (window.__br?.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2'));
const sizeTag = `${w * dpr}x${h * dpr}`;

/** One frame: a screenshot. */
async function grab(page) {
  return page.screenshot();
}

/**
 * Magenta pixels, split by shape: a crack is a thin line (each 8-connected patch at most 3 px thick on average,
 * its area over its longest side); open sky between trees or over a hill is a thick patch and is not a fault.
 */
async function count(png) {
  const W = png.readUInt32BE(16), H = png.readUInt32BE(20); // the PNG header
  const data = execFileSync('magick', ['png:-', '-alpha', 'off', '-depth', '8', 'rgb:-'], { input: png, maxBuffer: W * H * 3 + 1024 });
  const info = { width: W, height: H };
  const mag = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < mag.length; i += 3, p++) if (data[i] >= 250 && data[i + 1] <= 6 && data[i + 2] >= 250) mag[p] = 1;
  const mask = Buffer.alloc(W * H);
  const seen = new Uint8Array(W * H);
  let crack = 0, sky = 0;
  const stack = [];
  const patches = [];
  const R = Math.max(6, Math.round(W / 160)); // the dithered fringe of the canopy against the sky (12 px at 1920)
  const skyNear = new Uint8Array(W * H); // 2: within R px of open sky, 1: within 2R
  for (let p0 = 0; p0 < mag.length; p0++) {
    if (!mag[p0] || seen[p0]) continue;
    const patch = [];
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    seen[p0] = 1;
    stack.push(p0);
    while (stack.length) {
      const p = stack.pop();
      patch.push(p);
      const x = p % W, y = (p - x) / W;
      x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mag[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const long = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    const thin = patch.length / long <= 3;
    const edgeBit = patch.length < 8 && (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1);
    patches.push({ patch, thin: thin && !edgeBit, long });
    if (!thin) {
      for (const p of patch) {
        const x = p % W, y = (p - x) / W;
        for (let dy = -2 * R; dy <= 2 * R; dy++) for (let dx = -2 * R; dx <= 2 * R; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) skyNear[ny * W + nx] = Math.max(skyNear[ny * W + nx], Math.abs(dx) <= R && Math.abs(dy) <= R ? 2 : 1);
        }
      }
    }
  }
  // a crack: a thin patch away from open sky (the dithered edge of a canopy against the sky breaks into small thin
  // bits: none within R px, no specks of 1-2 px within 2R) and not a speck on the frame's edge (the same, where the
  // sky leaves the frame)
  for (const { patch, thin, long } of patches) {
    const isCrack = thin && !patch.some((p) => skyNear[p] === 2 || (patch.length <= 2 && skyNear[p] === 1));
    if (isCrack) crack += patch.length;
    else sky += patch.length;
    for (const p of patch) mask[p] = isCrack ? 255 : 80;
  }
  return { n: crack, sky, mask, info };
}

const rows = [];
async function frames(page, label, steps) {
  const counts = [];
  const best = [];
  let skyMax = 0;
  for (const [name, step] of steps) {
    await step();
    const png = await grab(page);
    const c = await count(png);
    counts.push(c.n);
    best.push({ name, n: c.n, png, c });
    skyMax = Math.max(skyMax, c.sky);
  }
  best.sort((a, b) => b.n - a.n);
  const saved = [];
  for (const f of best.slice(0, keep)) {
    const file = join(out, `${label}_${f.name}.png`);
    writeFileSync(file, f.png);
    if (f.n > 0 || f.c.sky > 0) {
      execFileSync('magick', ['-size', `${f.c.info.width}x${f.c.info.height}`, '-depth', '8', 'gray:-', file.replace(/\.png$/, '_mask.png')], { input: f.c.mask });
    }
    saved.push(file);
  }
  const hit = counts.filter((x) => x > 0).length;
  const row = { label, frames: counts.length, withMagenta: hit, max: Math.max(...counts), total: counts.reduce((a, b) => a + b, 0), skyMax };
  rows.push(row);
  console.log(`${label.padEnd(44)} frames ${row.frames}  with cracks ${row.withMagenta}  crack px max ${row.max} total ${row.total}  (open sky px max ${row.skyMax})   ${saved.join(' ')}`);
}

function query(p) {
  const q = new URLSearchParams(p);
  if (!has('--look')) q.set('seamtest', '');
  if (!webgpu) q.set('webgl', '');
  for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
  return `${base}?${q}`.replace(/=(&|$)/g, '$1');
}

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !/ImportMemory|SharedImage/i.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, ctx, errors };
}

for (const tier of tiers) {
  if (doMenu) {
    const { page, ctx, errors } = await newPage();
    await page.goto(query({ menu: '', quality: tier }));
    await page.waitForFunction(() => window.__br?.ready === true, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const orbitSteps = () => Array.from({ length: yaws }, (_, i) => [`yaw${String(Math.round((360 * i) / yaws)).padStart(3, '0')}`, async () => {
      await page.evaluate((y) => {
        const o = window.__br.orbit;
        o.turnDegS = 0;
        o.yaw = y;
      }, (360 * i) / yaws);
      await page.waitForTimeout(400); // the depth of field and auto exposure settle
    }]);
    const backendTag = await backendOf(page);
    await frames(page, `menu-title_${tier}_${backendTag}_${sizeTag}`, orbitSteps());
    // the garage: the closer orbit (title -> quick stage)
    const d = await page.evaluate(() => {
      const c = window.__br.menu.ctl;
      const want = c.screen.rows.findIndex((r) => (typeof r.spec.text === 'function' ? r.spec.text() : r.spec.text) === 'quick stage');
      return want - c.index;
    });
    for (let i = 0; i < Math.abs(d); i++) {
      await page.keyboard.press(d > 0 ? 'ArrowDown' : 'ArrowUp');
      await page.waitForTimeout(160);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__br?.menu?.screen === 'garage', null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    await frames(page, `menu-garage_${tier}_${backendTag}_${sizeTag}`, orbitSteps());
    if (errors.length) console.log(`  console errors: ${errors.slice(0, 5).join(' | ')}`);
    await ctx.close();
  }
  for (const stage of stages) {
    for (const dir of dirs) {
      const { page, ctx, errors } = await newPage();
      const p = { stage, car: 'swift', autopilot: '120', timescale: '3', quality: tier };
      if (dir === 'rev') p.dir = 'reverse';
      if (cond !== 'stage') p.cond = cond;
      if (weather !== 'stage') p.weather = weather;
      await page.goto(query(p));
      await page.waitForFunction(() => window.__br?.ready && window.__br.level?.run, null, { timeout: 120000 });
      await page.waitForFunction(() => window.__br.level.run.phase === 'running', null, { timeout: 90000 }).catch(() => {});
      const wx = weather === 'stage' ? '' : `-${weather}`;
      const cx = cond === 'stage' ? '' : `-${cond}`;
      const backendTag = await backendOf(page);
      await frames(page, `${stage}-${dir}${cx}${wx}_${tier}_${backendTag}_${sizeTag}`, Array.from({ length: samples }, (_, i) => [`t${String(i).padStart(2, '0')}`, async () => {
        await page.waitForTimeout(i === 0 ? 500 : 2500);
      }]));
      if (errors.length) console.log(`  console errors: ${errors.slice(0, 5).join(' | ')}`);
      await ctx.close();
    }
  }
}
await browser.close();
const bad = rows.filter((r) => r.withMagenta > 0);
console.log(`\n${rows.length} configurations, ${rows.reduce((a, r) => a + r.frames, 0)} frames; ${bad.length} with crack pixels`);
process.exit(bad.length ? 1 : 0);
