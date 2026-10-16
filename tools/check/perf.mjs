#!/usr/bin/env node
// Frame-time benchmark: drive a stage with the autopilot at real time in headless Chrome and print one
// row per configuration: the GPU the page landed on, the quality tier and scale in use, real
// (vsync'd) frame times and the GPU time from timer queries.
//
//   node tools/check/perf.mjs [--gpu igpu|dgpu] [--sizes 1920x1080,3840x1600] [--seconds 45]
//        [--configs "quality=auto;quality=low&ao=0"] [--webgpu] [--warm 4] [--stage finland] [--car swift]
//        [--spots 62,759,1500] [--hold 3] [--uncapped] [--headed] [--no-prewarm] [--out shots/perf] [--url http://localhost:4173/backroad-rally/] [--chrome /path/to/chrome]
//
// --gpu igpu (default) launches Chrome the way a desktop browser on a hybrid laptop renders: ANGLE on
// EGL with no vendor override, which lands on the integrated GPU. --gpu dgpu adds the NVIDIA PRIME /
// EGL vendor variables (headless only: a headed browser can't present from it on Wayland).
// Each config is a URL query added to `stage=finland&autopilot=120&gputime` (+ `webgl` unless --webgpu).
// The first --warm seconds of the drive are skipped (load, countdown, auto quality settling) unless the
// config pins a quality, in which case only the countdown is skipped. Serve dist/ under /backroad-rally/.
// --spots parks the car (stopped) at these road positions (m) instead of driving, --hold seconds at
// each, and prints the GPU and frame times per spot: the same views for every config, for ablations.
// --uncapped turns vsync off: frame time is then the GPU-bound cost. Use it to compare configs (on an
// integrated GPU the vsync'd timer queries under-read: frames missed 60 with 11 ms of measured GPU
// time); report vsync'd numbers.
// --headed opens a normal fullscreen Chrome window on the desktop (Wayland, a throw-away profile, no
// GPU flags: what a player's browser does) and measures at the screen's size; --sizes is ignored.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const gpu = arg('--gpu', 'igpu');
const sizes = arg('--sizes', '1920x1080').split(',').map((s) => s.split('x').map(Number));
const seconds = Number(arg('--seconds', '45'));
const warm = Number(arg('--warm', '4'));
const configs = arg('--configs', 'quality=auto').split(';').map((s) => s.trim());
const spots = arg('--spots', '').split(',').filter(Boolean).map(Number);
const hold = Number(arg('--hold', '3'));
const out = arg('--out', 'shots/perf');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const env = { ...process.env };
for (const k of ['__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__EGL_VENDOR_LIBRARY_FILENAMES', '__VK_LAYER_NV_optimus']) delete env[k];
if (gpu === 'dgpu') {
  Object.assign(env, {
    __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia', __VK_LAYER_NV_optimus: 'NVIDIA_only',
    __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json',
  });
}
const webgpu = argv.includes('--webgpu');
const headed = argv.includes('--headed');
const launch = () => chromium.launch({
  executablePath, env, headless: !headed,
  args: headed ? ['--ozone-platform=wayland', ...(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])] : [...(process.env.CHROME_ARGS ?? (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist'
    : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist')).split(' '),
  ...(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
});
let browser = await launch();
let opened = 0;

const stat = (v) => {
  v = [...v].sort((a, b) => a - b);
  if (!v.length) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const at = (q) => +v[Math.min(v.length - 1, Math.floor(v.length * q))].toFixed(2);
  return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: +v[v.length - 1].toFixed(2) };
};

/**
 * Headed on Hyprland: a tiling compositor ignores --start-fullscreen and the page's fullscreen
 * request, so ask it to fullscreen the test browser's own window (found by its throw-away profile).
 */
async function fullscreen() {
  try {
    const clients = JSON.parse(execSync('hyprctl clients -j').toString());
    for (const c of clients) {
      if (c.fullscreen) continue;
      const cmd = readFileSync(`/proc/${c.pid}/cmdline`, 'utf8');
      // the browser Playwright launched (Hyprland's Lua dispatchers)
      if (process.env.FS_DEBUG) console.log(`fs: ${c.class} ${c.fullscreen} ${cmd.includes("--remote-debugging-pipe")}`);
      if (cmd.includes("--remote-debugging-pipe")) execSync(`hyprctl dispatch 'hl.dsp.window.fullscreen({ mode = "fullscreen", window = "address:${c.address}" })'`);
    }
  } catch (e) {
    console.log(`fullscreen: ${e}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// one throw-away drive first: the first page in a fresh browser runs far slower (driver and ANGLE
// program caches, GPU clocks ramping) and would make whichever config comes first look bad
if (!argv.includes('--no-prewarm') && !headed) {
  const page = await browser.newPage(headed ? { viewport: null } : { viewport: { width: sizes[0][0], height: sizes[0][1] } });
  await page.goto(`${base}?stage=${arg('--stage', 'finland')}&autopilot=120${webgpu ? '' : '&webgl'}`);
  if (headed) await fullscreen();
  await page.waitForFunction(() => window.__br?.level?.run, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(12000);
  await page.close();
}

const rows = [];
let renderer = '';
for (const [w, h] of headed ? [['screen', '']] : sizes) {
  for (const cfg of configs) {
    const q = new URLSearchParams({ stage: arg('--stage', 'finland'), car: arg('--car', 'swift'), autopilot: '120', gputime: '' });
    if (!webgpu) q.set('webgl', '');
    if (spots.length) q.delete('autopilot');
    for (const [k, v] of new URLSearchParams(cfg)) q.set(k, v);
    // headed: a fresh browser (one window) per config, so the fullscreen toggle can't carry over
    if (headed && opened++) {
      await browser.close();
      browser = await launch();
    }
    const page = await browser.newPage(headed ? { viewport: null } : { viewport: { width: w, height: h } });
    const errors = [];
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}?${q}`.replace(/=(&|$)/g, '$1'));
    if (headed) await fullscreen();
    try {
      await page.waitForFunction(() => window.__br?.level?.run, null, { timeout: 120000 });
    } catch {
      console.log(`${w}x${h} ${cfg}: no stage after 120 s\n${errors.join('\n')}`);
      await page.close();
      continue;
    }
    if (spots.length) {
      // parked, not driven: wait for the start (the flow holds the car until then)
      await page.waitForFunction(() => window.__br.level.run.phase === 'running', null, { timeout: 90000 }).catch(() => {});
      if (q.get('quality') === 'auto') await page.waitForTimeout(warm * 1000);
      const per = [];
      for (const s of spots) {
        await page.evaluate((s) => {
          const { vehicle, sim, level, chase } = window.__br;
          const pose = level.tracker.road.pose(s, level.tracker.sign, 0);
          pose.position.y += 0.4;
          vehicle.teleport(pose.position, pose.yawDeg);
          sim.snap();
          level.tracker.reset();
          chase.snapped = false;
        }, s);
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.__br.perf.reset());
        await page.waitForTimeout(hold * 1000);
        const f = await page.evaluate(() => window.__br.perf.frames.slice());
        const g = stat(f.map((x) => x.gpu).filter((x) => x > 0)), d = stat(f.map((x) => x.dt));
        per.push(`${s}: gpu ${g.mean}/${g.p95} dt ${d.mean} cpu ${stat(f.map((x) => x.render + x.inst + x.step)).mean} ${Math.round(stat(f.map((x) => x.tris)).mean / 1000)}k ${Math.round(stat(f.map((x) => x.calls)).mean)}c`);
      }
      renderer = await page.evaluate(() => window.__br.gpu); console.log(`${w}x${h} ${cfg.padEnd(28)} ${per.join(' | ')}`);
      await page.close();
      continue;
    }
    const pinned = /(^|&)quality=(?!auto)/.test(cfg);
    await page.waitForTimeout((pinned ? 3 : warm) * 1000);
    await page.evaluate(() => window.__br.perf.reset());
    await page.waitForTimeout(seconds * 1000);
    const r = await page.evaluate(() => {
      const br = window.__br;
      return { frames: br.perf.frames.slice(), gpuName: br.gpu, tier: br.look.qualityName, scale: br.look.scale ?? 1,
        changes: br.auto?.log ?? [], canvas: [br.renderer.domElement.width, br.renderer.domElement.height], win: [innerWidth, innerHeight, devicePixelRatio] };
    });
    renderer = r.gpuName;
    const f = r.frames;
    const row = {
      size: headed ? r.win.join('x') : `${w}x${h}`, cfg, gpu: r.gpuName, tier: r.tier, scale: r.scale, canvas: r.canvas.join('x'), frames: f.length,
      dt: stat(f.map((x) => x.dt)), gpuMs: stat(f.map((x) => x.gpu).filter((x) => x > 0)),
      cpu: stat(f.map((x) => x.render + x.inst + x.step)), submit: stat(f.map((x) => x.render)).mean, inst: stat(f.map((x) => x.inst)).mean,
      physics: stat(f.map((x) => x.step)).mean, over25: f.filter((x) => x.dt > 25).length,
      tris: Math.round(stat(f.map((x) => x.tris)).mean / 1000) + 'k', calls: Math.round(stat(f.map((x) => x.calls)).mean),
      changes: r.changes, errors: errors.filter((e) => !/GPU stall due to ReadPixels|GL_CLOSE_PATH|WebGL: too many/.test(e)).slice(0, 5),
    };
    rows.push(row);
    console.log(`${row.size} ${cfg.padEnd(28)} tier ${row.tier}${row.scale !== 1 ? `@${row.scale}` : ''}  ` +
      `dt mean ${row.dt.mean} p99 ${row.dt.p99} max ${row.dt.max} >25ms ${row.over25}/${row.frames}  ` +
      `gpu mean ${row.gpuMs.mean} p95 ${row.gpuMs.p95}  cpu ${row.cpu.mean} (submit ${row.submit} inst ${row.inst} physics ${row.physics})  ${row.tris} tris ${row.calls} calls` +
      (row.changes.length ? `  auto: ${row.changes.join(' | ')}` : '') + (row.errors.length ? `\n  ${row.errors.join('\n  ')}` : ''));
    await page.close();
  }
}
console.log(`renderer: ${renderer}`);
writeFileSync(join(out, `perf-${gpu}-${Date.now()}.json`), JSON.stringify({ renderer, rows }, null, 1));
await browser.close();
