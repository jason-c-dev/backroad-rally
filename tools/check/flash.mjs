#!/usr/bin/env node
// The first seconds of a stage as a player sees them: a headed Chrome at the screen's size (a throw-away profile, no GPU
// flags: what a desktop browser does), the page's own frame trace and the compositor's frames (a CDP screencast).
// Prints the auto quality changes, the hitches after the loading curtain lifts and any "blank" frame: a screencast
// frame where more than --blank of the pixels show the page background (#f1ede7 or #1b1916) instead of the stage.
//
//   node tools/check/flash.mjs [--url http://localhost:4173/backroad-rally/] [--params "stage=finland&autopilot=120&fps=60"]
//        [--seconds 25] [--size 1600x1000] [--dpr 1.6] [--blank 0.6] [--out shots/flash] [--rtx] [--webgpu] [--keep]
//
// --rtx starts Chrome as an X11 client on the NVIDIA GPU (the wiki's "Desktop Chrome on a hybrid-graphics laptop"
// command), --webgpu adds the WebGPU flags (headed Wayland Chrome on the integrated GPU has no hardware WebGPU).
// --keep keeps the screencast JPEGs. Needs ImageMagick (`magick`) for the pixel test.
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
const query = arg('--params', 'stage=finland&autopilot=120&fps=60');
const seconds = Number(arg('--seconds', '25'));
const blankShare = Number(arg('--blank', '0.6'));
const out = arg('--out', 'shots/flash');
const rtx = argv.includes('--rtx');
const webgpu = argv.includes('--webgpu');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
const frames = join(out, 'frames');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const env = { ...process.env };
for (const k of ['__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__EGL_VENDOR_LIBRARY_FILENAMES', '__VK_LAYER_NV_optimus']) delete env[k];
const args = [];
if (rtx) {
  Object.assign(env, { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only' });
  args.push('--ozone-platform=x11', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE', '--enable-unsafe-webgpu');
} else {
  args.push('--ozone-platform=wayland');
  if (webgpu) args.push('--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE');
}
const browser = await chromium.launch({ executablePath, env, headless: false, args });

// Hyprland drops a fullscreen toggle of the test window while the page loads (and ignores --kiosk and the page's own
// request), so the page gets the screen's size by emulation: the same pixels to draw as a fullscreen window
let screenSize = { width: 1600, height: 1000, scale: 1.6 };
try {
  const m = JSON.parse(execSync('hyprctl monitors -j').toString())[0];
  screenSize = { width: Math.round(m.width / m.scale), height: Math.round(m.height / m.scale), scale: m.scale };
} catch {}
const [vw, vh] = (arg('--size', '') || `${screenSize.width}x${screenSize.height}`).split('x').map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: Number(arg('--dpr', screenSize.scale)) });
const errors = [];
let dawnFlood = 0;
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (/ImportMemory|SharedImage/i.test(m.text())) dawnFlood++;
  else errors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));
// the page's own frames (every rAF callback, epoch ms) and every canvas size change, from the first script on
await page.addInitScript(() => {
  const w = window;
  w.__flash = { raf: [], sizes: [] };
  const loop = (t) => {
    w.__flash.raf.push(performance.timeOrigin + t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    get() {
      return d.get.call(this);
    },
    set(v) {
      if (v !== d.get.call(this) && this.parentElement?.id === 'app') w.__flash.sizes.push([performance.timeOrigin + performance.now(), v]);
      d.set.call(this, v);
    },
  });
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
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 300, everyNthFrame: 1 });
const t0 = Date.now();
await page.goto(`${base}?${query}`);
// note when the curtain is gone (the run may start): epoch ms
await page.waitForFunction(() => window.__br?.ready, null, { timeout: 120000, polling: 'raf' }).catch(() => {});
const readyAt = await page.evaluate(() => (window.__br?.ready ? performance.timeOrigin + performance.now() : 0));
// every pipeline built after the curtain (a shader compiled mid-run is a hitch): which material on which mesh
await page.evaluate(() => {
  const br = window.__br;
  const P = br?.renderer?._pipelines;
  window.__flash.programs = [];
  if (!P?.getForRender) return;
  const count = () => (P.programs?.vertex?.size ?? 0) + (P.programs?.fragment?.size ?? 0);
  const orig = P.getForRender.bind(P);
  P.getForRender = (ro, ...rest) => {
    const n = count();
    const r = orig(ro, ...rest);
    if (count() !== n) window.__flash.programs.push(`${ro.material?.name || ro.material?.type} on ${ro.object?.name || ro.object?.type}`);
    return r;
  };
});
await page.waitForTimeout(seconds * 1000);
await cdp.send('Page.stopScreencast').catch(() => {});
const r = await page.evaluate(() => {
  const br = window.__br;
  return {
    flash: window.__flash, gpu: br.gpu, backend: br.backend ?? (br.renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2'), tier: br.look.qualityName, scale: br.look.scale, log: br.auto?.log ?? [], windows: br.auto?.windows ?? [],
    frames: br.perf?.frames.map((f) => f.dt) ?? [], win: [innerWidth, innerHeight, devicePixelRatio], canvas: [br.renderer.domElement.width, br.renderer.domElement.height],
    trace: br.autoTrace ?? null,
  };
});
await browser.close();

// the pixel test: the share of each screencast frame close to either page background (one magick call: every frame
// shrunk to 160x100 raw RGB, compared here)
const after = shots.map((t, i) => [t, i]).filter(([t]) => readyAt && t > readyAt + 100);
const blanks = [];
const BG = [[0xf1, 0xed, 0xe7], [0x1b, 0x19, 0x16]];
for (let k = 0; k < after.length; k += 400) {
  const part = after.slice(k, k + 400);
  const raw = execFileSync('magick', [...part.map(([, i]) => join(frames, `${String(i).padStart(5, '0')}.jpg`)), '-resize', '160x100!', '-depth', '8', 'rgb:-'],
    { maxBuffer: 1 << 30 });
  const n = 160 * 100;
  part.forEach(([t, i], j) => {
    let hit = 0;
    for (let p = 0; p < n; p++) {
      const o = (j * n + p) * 3;
      if (BG.some((c) => Math.abs(raw[o] - c[0]) < 16 && Math.abs(raw[o + 1] - c[1]) < 16 && Math.abs(raw[o + 2] - c[2]) < 16)) hit++;
    }
    if (hit / n > blankShare) blanks.push(`${((t - readyAt) / 1000).toFixed(2)}s frame ${i} ${((hit / n) * 100).toFixed(0)}%`);
  });
}
const raf = r.flash.raf;
const gapsAfter = [];
for (let i = 1; i < raf.length; i++) if (raf[i - 1] > readyAt && raf[i] - raf[i - 1] > 50) gapsAfter.push(`${((raf[i - 1] - readyAt) / 1000).toFixed(2)}s +${(raf[i] - raf[i - 1]).toFixed(0)} ms`);
const sizesAfter = r.flash.sizes.filter(([t]) => t > readyAt).map(([t, v]) => `${((t - readyAt) / 1000).toFixed(2)}s w=${v}`);
const sizesBefore = r.flash.sizes.filter(([t]) => t <= readyAt).length;
console.log(`gpu: ${r.gpu} (${r.backend}); window ${r.win.join('x')}; canvas ${r.canvas.join('x')}; final ${r.tier}${r.scale < 1 ? `@${r.scale}` : ''}`);
console.log(`curtain lifted at ${readyAt ? ((readyAt - t0) / 1000).toFixed(2) : '-'} s after goto; ${shots.length} screencast frames, ${after.length} after the curtain`);
console.log(`auto: ${r.log.join(' | ') || 'no changes'}`);
if (argv.includes("--windows")) console.log(`windows [t, rung, scale, mean, missed, gpu p90]: ${r.windows.map((w) => JSON.stringify(w)).join(" ")}`);
console.log(`canvas resizes: ${sizesBefore} under the curtain, after: ${sizesAfter.join(', ') || 'none'}`);
console.log(`programs built after the curtain: ${r.flash.programs?.length ? r.flash.programs.join(', ') : 'none'}`);
console.log(`page frame gaps > 50 ms after the curtain: ${gapsAfter.length ? gapsAfter.join(', ') : 'none'}`);
const dts = r.frames;
if (dts.length) console.log(`game frames: ${dts.length}, max dt ${Math.max(...dts).toFixed(0)} ms (whole run incl. warm-up)`);
console.log(`blank frames after the curtain (> ${blankShare * 100}% background): ${blanks.length ? blanks.join(', ') : 'none'}`);
if (dawnFlood) console.log(`(Dawn ImportMemory/SharedImage console lines: ${dawnFlood})`);
if (errors.length) console.log(`console:\n  ${[...new Set(errors)].slice(0, 10).join('\n  ')}`);
writeFileSync(join(out, `flash-${Date.now()}.json`), JSON.stringify({ query, readyAt, t0, shots, blanks, gapsAfter, sizesAfter, ...r }, null, 0));
if (!argv.includes('--keep')) rmSync(frames, { recursive: true, force: true });
