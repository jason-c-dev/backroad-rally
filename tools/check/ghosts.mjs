#!/usr/bin/env node
// The ghosts on a stage (slice 10), headless: a stage run with the rival ghosts and/or the best-run ghost, driven by
// the autopilot; screenshots at the given clock times and a state line each (the live position, the ghost delta,
// which ghosts show, their opacity), then the results panel. Also checks that no shader compiles after the curtain.
//
//   node tools/check/ghosts.mjs [--url http://localhost:4173/backroad-rally/] [--params "mode=quick&stage=finland&car=swift&rivals=9&devghost=1"]
//        [--at 4,10,25] [--size 1920x1080] [--out shots/ghosts] [--tag name] [--webgpu] [--headed] [--results] [--timescale 1] [--noshot]
//        [--again]   after the results, load the page again (the stored best ghost races) and take the shots again
//        [--career]  a fresh career in the save first (with --params "mode=career")
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg('--url', 'http://localhost:4173/backroad-rally/');
const webgpu = process.argv.includes('--webgpu');
const headed = process.argv.includes('--headed');
const noshot = process.argv.includes('--noshot'); // headless WebGPU can't take screenshots (Dawn's canvas import)
const extra = arg('--params', 'mode=quick&stage=finland&car=swift&weather=clear&cond=afternoon&rivals=9&devghost=1');
const ts = Number(arg('--timescale', '1'));
const url = `${base}?${extra}&autopilot=${arg('--kmh', '120')}&minturn=0.3${ts !== 1 ? `&timescale=${ts}` : ''}${webgpu ? '' : '&webgl'}`;
const at = arg('--at', '4,10,25').split(',').map(Number);
const out = arg('--out', 'shots/ghosts');
const tag = arg('--tag', 'ghosts');
const [w, h] = arg('--size', '1920x1080').split('x').map(Number);
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
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  if (/ghost saved/.test(m.text())) console.log('PAGE', m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
if (process.argv.includes('--career')) {
  // --career: a fresh career at its first stage (use --params "mode=career"): the page takes the stage from the save
  await page.addInitScript(() => {
    if (!localStorage.getItem('backroad-rally.save')) {
      localStorage.setItem('backroad-rally.save', JSON.stringify({ version: 1, best: {}, unlocks: { groups: ['2'], cars: ['swift', 'pip'], liveries: [] },
        career: { format: 2, active: true, season: 0, rally: 0, stage: 0, restartsLeft: 3, seed: 9896, car: 'swift', livery: 0 } }));
    }
  });
}
await page.goto(url);
await page.waitForFunction(() => window.__br?.ready, null, { timeout: 60000 });
// shader programs after the curtain: none may be added by the ghosts showing up
const programs = () => page.evaluate(() => {
  const r = window.__br.renderer;
  return r.info?.programs?.length ?? r._pipelines?.pipelines?.size ?? r._pipelines?.caches?.size ?? -1;
});
const p0 = await programs();
const state = () => page.evaluate(() => {
  const b = window.__br;
  const run = b.level.run;
  const rv = b.rivals;
  const shown = rv ? rv.rivals.filter((r) => r.shown).map((r) => `${r.name.split(' ')[0]}:${r.mesh.userData.ghostOpacity.toFixed(2)}`) : [];
  const g = b.bestGhost;
  return `t=${run.clock.toFixed(1)} ${run.phase} pos=${rv?.positionText ?? '-'} delta=${g?.delta?.toFixed(2) ?? '-'} best=${g?.mesh?.visible ? g.mesh.userData.ghostOpacity.toFixed(2) : 'hidden'} `
    + `rivals shown ${shown.length}/${rv?.rivals.length ?? 0} [${shown.join(' ')}] hud="${document.querySelector('#stage-hud .hud-timer')?.innerText.replace(/\n/g, ' | ')}"`;
});
for (const t of at) {
  await page.waitForFunction((t) => window.__br.level.run.clock >= t || window.__br.level.run.phase === 'results', t, { timeout: 400000 });
  console.log(await state());
  if (!noshot) await page.screenshot({ path: join(out, `${tag}_t${t}.png`) });
}
console.log(`shader programs: ${p0} at the curtain, ${await programs()} now`);
if (process.argv.includes('--results')) {
  await page.waitForFunction(() => window.__br.level.run.phase === 'results', null, { timeout: 600000 });
  await page.waitForTimeout(800);
  console.log(await state());
  if (!noshot) await page.screenshot({ path: join(out, `${tag}_results.png`) });
}
if (process.argv.includes('--again')) {
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('backroad-rally.ghost.')).map((k) => `${k} ${localStorage.getItem(k).length} B`));
  console.log('stored ghosts:', stored.join(', ') || 'none');
  await page.goto(url.replace('&timescale=', '&was='));
  await page.waitForFunction(() => window.__br?.ready, null, { timeout: 60000 });
  for (const t of at) {
    await page.waitForFunction((t) => window.__br.level.run.clock >= t || window.__br.level.run.phase === 'results', t, { timeout: 400000 });
    console.log('again', await state());
    if (!noshot) await page.screenshot({ path: join(out, `${tag}_again_t${t}.png`) });
  }
}
// headless WebGPU: Dawn can't import the canvas texture on this box (the known ImportMemory errors, docs/reference.md)
const KNOWN = /ImportMemory|Invalid Texture|Invalid CommandBuffer|allocation size .* is smaller than the image/;
const known = errors.filter((e) => KNOWN.test(e)), other = [...new Set(errors.filter((e) => !KNOWN.test(e)))];
if (known.length) console.log(`known headless WebGPU canvas errors: ${known.length}`);
console.log(other.length ? `ERRORS\n${other.join('\n')}` : 'no other console errors');
await browser.close();
