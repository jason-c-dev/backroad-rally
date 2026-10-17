#!/usr/bin/env node
// A whole career season, headless (slice 10): a fresh profile opens the menus with ?autocontinue, which starts a
// career and presses on through it (src/menu/menu.ts autoStep; the stage page continues by itself), while the
// autopilot drives every stage faster than the clock. Prints each stage's result and the rally tables, the standings,
// the unlocks and the save at the end; screenshots of every screen it passes.
//
//   node tools/check/career.mjs [--url http://localhost:4173/backroad-rally/] [--timescale 4] [--kmh 120] [--seasons 1]
//        [--rallies n] [--out shots/career] [--size 1920x1080] [--webgpu] [--noshot] [--minutes 40]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const webgpu = process.argv.includes('--webgpu');
const noshot = process.argv.includes('--noshot');
const seasons = Number(arg('--seasons', '1'));
const rallies = Number(arg('--rallies', '0')); // stop after this many rallies instead (0 = the season)
const out = arg('--out', 'shots/career');
const [w, h] = arg('--size', '1920x1080').split('x').map(Number);
const deadline = Date.now() + Number(arg('--minutes', '40')) * 60000;
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });
const url = `${base}?menu=1&autocontinue=1&autopilot=${arg('--kmh', '120')}&minturn=0.3&timescale=${arg('--timescale', '4')}${webgpu ? '' : '&webgl'}`
  + `${arg('--params', '') ? `&${arg('--params', '')}` : ''}`;

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? (webgpu ? '--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist'
    : '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist')).split(' ').filter(Boolean),
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.goto(url);

const seen = new Set();
let shotN = 0;
const shot = async (name) => {
  if (noshot) return;
  const f = join(out, `${String(++shotN).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: f }).catch(() => {});
};
const read = () => page.evaluate(() => {
  const b = window.__br;
  const save = JSON.parse(localStorage.getItem('backroad-rally.save') ?? 'null');
  const c = save?.career ?? null;
  const menu = b?.menu;
  const run = b?.level?.run;
  return {
    url: location.search, menuScreen: menu?.screen ?? null, ready: menu ? b.curtain < 0.01 : !!b?.ready,
    phase: run?.phase ?? null, clock: run?.clock ?? 0, total: run?.total ?? 0, dnf: run?.dnf ?? false, stage: b?.level?.stage?.json?.id ?? null,
    career: c && { season: c.season, rally: c.rally, stage: c.stage, restartsLeft: c.restartsLeft, complete: c.complete, points: c.seasonPoints?.[0], seasons: c.seasons, last: c.last ? {
      rallyName: c.last.rallyName, rows: c.last.rows.map((r) => `${r.position} ${r.name} ${r.dnf ? 'dnf' : r.time.toFixed(3)} ${r.points}`),
      standings: c.last.standings.map((r) => `${r.position} ${r.name} ${r.points}`), unlocks: c.last.unlocks, seasonComplete: c.last.seasonComplete } : null },
    unlocks: save?.unlocks, saveBytes: (localStorage.getItem('backroad-rally.save') ?? '').length,
  };
}).catch(() => null);

let lastLog = '';
let stages = 0;
for (;;) {
  if (Date.now() > deadline) {
    console.log('TIMEOUT');
    break;
  }
  await page.waitForTimeout(700);
  const s = await read();
  if (!s) continue;
  const key = s.menuScreen ? `menu:${s.menuScreen}:${s.career?.season}:${s.career?.rally}:${s.career?.stage}` : `stage:${s.stage}:${s.phase === 'results' ? 'results' : 'run'}:${s.career?.rally}:${s.career?.stage}`;
  if (key !== lastLog) {
    lastLog = key;
    if (s.menuScreen) console.log(`menu ${s.menuScreen}  career s${s.career?.season} r${s.career?.rally} st${s.career?.stage} restarts ${s.career?.restartsLeft} pts ${s.career?.points}`);
    else if (s.phase === 'results') {
      stages++;
      console.log(`  stage ${s.stage} ${s.url.match(/dir=reverse/) ? 'rev' : 'fwd'} ${s.url.match(/weather=(\w+)/)?.[1]}: ${s.dnf ? 'dnf' : s.total.toFixed(3)}`);
    }
  }
  if (s.menuScreen && s.ready !== false && !seen.has(key)) {
    seen.add(key);
    await page.waitForTimeout(500);
    await shot(`${s.menuScreen}_s${s.career?.season}r${s.career?.rally}`);
    if (s.menuScreen === 'rallyresults') console.log(`  ${s.career.last.rallyName}: ${s.career.last.rows.join(' | ')}`);
    if (s.menuScreen === 'standings') console.log(`  standings: ${s.career.last.standings.join(' | ')}`);
    if (s.menuScreen === 'unlock') console.log(`  unlocks: ${s.career.last.unlocks.join(', ') || 'none'}`);
  }
  if (!s.menuScreen && s.phase === 'results' && !seen.has(key)) {
    seen.add(key);
    await page.waitForTimeout(300);
    await shot(`results_${s.stage}_r${s.career?.rally}st${s.career?.stage}`);
  }
  const doneRallies = rallies > 0 && s.menuScreen === 'career' && s.career && s.career.rally >= rallies && s.career.stage === 0;
  if (doneRallies || (s.menuScreen === 'career' && s.career && s.career.season >= seasons && s.career.rally === 0 && s.career.stage === 0)) {
    console.log(`season done: ${JSON.stringify(s.career.seasons)}`);
    console.log(`unlocks: ${JSON.stringify(s.unlocks)}; save ${s.saveBytes} B; ${stages} stages`);
    await page.waitForTimeout(1500);
    await shot('hub_after');
    writeFileSync(join(out, 'save.json'), await page.evaluate(() => localStorage.getItem('backroad-rally.save')));
    break;
  }
}
// headless WebGPU: Dawn can't import the canvas texture on this box (the known ImportMemory errors, docs/reference.md)
const KNOWN = /ImportMemory|Invalid Texture|Invalid CommandBuffer|allocation size .* is smaller than the image/;
const known = errors.filter((e) => KNOWN.test(e)), other = [...new Set(errors.filter((e) => !KNOWN.test(e)))];
if (known.length) console.log(`known headless WebGPU canvas errors: ${known.length}`);
console.log(other.length ? `ERRORS\n${other.join('\n')}` : 'no other console errors');
await browser.close();
