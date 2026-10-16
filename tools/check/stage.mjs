#!/usr/bin/env node
// Run a whole stage headless with the autopilot (src/game/autopilot.ts) and report the time per
// car and direction, the resets, spins, the surfaces under the wheels, and frame costs.
//
//   node tools/check/stage.mjs [--stage finland] [--cars swift,pip,lama,quint,kaze] [--dirs fwd,rev]
//        [--kmh 120] [--minturn 0.3] [--keys 0|1|2] [--timescale 4] [--size 1280x534] [--webgl]
//        [--shots 0.25,0.5,0.75] [--perf] [--seconds N] [--draw 2] [--out dir]
//        [--cond afternoon] [--params "post=0"] [--url http://localhost:4173/backroad-rally/] [--chrome /path/to/chrome]
//
// --perf runs at real time (timescale 1) and prints frame-time statistics: mean, p95, p99 and worst
// frame, physics, updateInstances and render-submit costs, draw calls and visible instances.
// --seconds stops a run early (wall seconds). Serve dist/ under /backroad-rally/ first (README).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const stageId = arg('--stage', 'finland');
const cars = arg('--cars', 'swift').split(',');
const dirs = arg('--dirs', 'fwd,rev').split(',');
const perfMode = has('--perf');
const timescale = perfMode ? 1 : Number(arg('--timescale', '4'));
const kmh = arg('--kmh', '120');
const minturn = arg('--minturn', '0.3');
const keys = arg('--keys', '0');
const [w, h] = arg('--size', perfMode ? '1920x800' : '1280x534').split('x').map(Number);
const shots = arg('--shots', '').split(',').filter(Boolean).map(Number);
const seconds = Number(arg('--seconds', '0'));
const draw = arg('--draw', '');
const out = arg('--out', 'shots/stage');
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const rows = [];
for (const car of cars) {
  for (const dir of dirs) {
    const q = new URLSearchParams({ stage: stageId, car, autopilot: kmh, minturn, apkeys: keys, timescale: String(timescale) });
    if (dir === 'rev') q.set('dir', 'reverse');
    if (has('--webgl')) q.set('webgl', '');
    if (draw) q.set('draw', draw);
    if (arg('--cond', '')) q.set('cond', arg('--cond', ''));
    for (const [k, v] of new URLSearchParams(arg('--params', ''))) q.set(k, v);
    const url = `${base}?${q}`;
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      if (m.type() === 'warning') errors.push(`warning: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
    const t0 = Date.now();
    await page.goto(url);
    try {
      await page.waitForFunction(() => window.__br?.level?.run, null, { timeout: 60000 });
    } catch {
      console.log(`${car} ${dir}: no stage after 60 s\n${errors.join('\n')}`);
      await page.screenshot({ path: join(out, `${car}-${dir}-fail.png`) });
      await page.close();
      continue;
    }
    const loadMs = Date.now() - t0;
    const timings = await page.evaluate(() => window.__br.level.stage.timings);
    // in-page sampler: surfaces under the wheels by where the car is across the road, resets, frames
    await page.evaluate(() => {
      const br = window.__br;
      const S = (window.__samples = { road: {}, verge: {}, out: {}, resets: [], lastPen: 0, minS: Infinity, maxS: -Infinity });
      br.perf.reset();
      setInterval(() => {
        const { level, vehicle } = br;
        const p = level.tracker.proj;
        if (!p || level.run.phase !== 'running') return;
        S.minS = Math.min(S.minS, p.s);
        S.maxS = Math.max(S.maxS, p.s);
        const edge = Math.abs(p.lateral) - p.halfWidth;
        // one wheel's surface against that wheel's own lateral offset would be finer; the body is enough here
        const bin = edge < -1 ? S.road : edge > 1.5 && edge < 8 ? S.verge : edge >= 8 ? S.out : null;
        if (bin) for (const wh of vehicle.wheels) if (wh.inContact) bin[wh.surface] = (bin[wh.surface] ?? 0) + 1;
        if (level.run.penalties !== S.lastPen) {
          S.lastPen = level.run.penalties;
          S.resets.push({ s: Math.round(p.s), kmh: Math.round(vehicle.forwardSpeedKmh), clock: +level.run.clock.toFixed(1) });
        }
      }, 25);
    });
    const shotsLeft = [...shots].sort((a, b) => a - b);
    const read = () => page.evaluate(() => {
        const { level, autopilot } = { level: window.__br.level, autopilot: window.__br.level.autopilot };
        const r = level.run;
        const d = window.__br.damage;
        return { phase: r.phase, clock: r.clock, total: r.total, pen: r.penalties, rec: r.recovers, dnf: r.dnf, reason: r.dnfReason,
          progress: level.tracker.progress, spins: autopilot?.spins ?? 0, maxSlip: autopilot?.maxSlip ?? 0,
          damage: d ? { value: +d.value.toFixed(3), impacts: d.impacts, maxKmh: +d.maxImpactKmh.toFixed(1), terminal: d.terminal } : null };
    });
    let state;
    for (;;) {
      await page.waitForTimeout(perfMode ? 1000 : 250);
      state = await read();
      while (shotsLeft.length && state.progress >= shotsLeft[0]) {
        const f = shotsLeft.shift();
        await page.screenshot({ path: join(out, `${car}-${dir}-${w}x${h}-p${Math.round(f * 100)}.png`) });
      }
      if (state.phase === 'results' || state.phase === 'finished') break;
      if (seconds && Date.now() - t0 - loadMs > seconds * 1000) break;
      if (Date.now() - t0 > 30 * 60000) break;
    }
    if (state.phase === 'finished') {
      await page.waitForFunction(() => window.__br.level.run.phase === 'results', null, { timeout: 30000 }).catch(() => {});
      state = await read();
    }
    if (has('--results-shot')) await page.screenshot({ path: join(out, `${car}-${dir}-${w}x${h}-results.png`) });
    const samples = await page.evaluate(() => window.__samples);
    const frames = await page.evaluate(() => window.__br.perf.frames.slice(30)); // skip warm-up
    const wall = (Date.now() - t0 - loadMs) / 1000;
    const row = {
      car, dir, time: state.clock, total: state.total, penalties: state.pen, recovers: state.rec, dnf: state.dnf, reason: state.reason,
      damage: state.damage, progress: +state.progress.toFixed(3),
      finished: state.phase === 'results' && !state.dnf, spins: state.spins, maxSlip: Math.round(state.maxSlip),
      resets: samples.resets, surfaces: { road: samples.road, verge: samples.verge, out: samples.out },
      sRange: [Math.round(samples.minS), Math.round(samples.maxS)], loadMs, timings, wall: Math.round(wall),
      errors,
    };
    if (frames.length) {
      const stat = (k) => {
        const v = frames.map((f) => f[k]).sort((a, b) => a - b);
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        return { mean: +mean.toFixed(2), p95: +v[Math.floor(v.length * 0.95)].toFixed(2), p99: +v[Math.floor(v.length * 0.99)].toFixed(2), max: +v[v.length - 1].toFixed(2) };
      };
      row.frames = frames.length;
      row.perf = { dt: stat('dt'), step: stat('step'), inst: stat('inst'), render: stat('render'), calls: stat('calls'), tris: stat('tris'), visible: stat('visible') };
      if (frames.some((f) => f.gpu > 0)) row.perf.gpu = stat('gpu'); // with --params gputime
      row.spikes = frames.filter((f) => f.dt > 25).length;
    }
    rows.push(row);
    console.log(`${car.padEnd(6)} ${dir} ${row.finished ? fmt(row.time) : state.phase === 'results' ? `DNF (${state.reason} at ${(state.progress * 100).toFixed(0)}%)` : `(${state.phase} ${(state.progress * 100).toFixed(0)}%)`}` +
      ` damage ${JSON.stringify(row.damage)}` +
      ` total ${fmt(row.total)} pen ${row.penalties} spins ${row.spins} maxslip ${row.maxSlip}` +
      ` resets ${JSON.stringify(row.resets)} wall ${row.wall}s load ${loadMs}ms`);
    console.log(`  surfaces ${JSON.stringify(row.surfaces)}`);
    console.log(`  build ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])))}`);
    if (row.perf) console.log(`  perf ${row.frames} frames, ${row.spikes} over 25 ms ${JSON.stringify(row.perf)}`);
    if (errors.length) console.log(`  ERRORS\n  ${errors.join('\n  ')}`);
    await page.close();
  }
}
writeFileSync(join(out, `stage-${perfMode ? 'perf' : 'run'}-${Date.now()}.json`), JSON.stringify(rows, null, 1));
await browser.close();
