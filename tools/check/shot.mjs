#!/usr/bin/env node
// Drive the game in headless Chrome and save screenshots (slice check, handoff §13).
//
//   node tools/check/shot.mjs [--url http://localhost:4173/backroad-rally/] [--out shots]
//                             [--size 1920x800] [--webgl] [--chrome /path/to/chrome]
//
// Takes a shot at rest, then after driving (W held, then W+D), then after C (camera).
// Prints the frame-time HUD and any console errors.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
let url = arg('--url', 'http://localhost:4173/backroad-rally/');
if (process.argv.includes('--webgl')) url += (url.includes('?') ? '&' : '?') + 'webgl';
const out = arg('--out', 'shots');
const [w, h] = arg('--size', '1920x800').split('x').map(Number);
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: (process.env.CHROME_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --ignore-gpu-blocklist').split(' '),
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.goto(url);
try {
  await page.waitForSelector('#frame-hud:not(:empty)', { timeout: 30000 });
} catch (e) {
  console.log(`no HUD after 30 s: ${await page.textContent('body')}\n${errors.join('\n')}`);
  await page.screenshot({ path: join(out, 'fail.png') });
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(1500);
const tag = `${w}x${h}`;
const hud = async () => {
  console.log('HUD', (await page.textContent('#frame-hud')).replace('\n', ' | '));
  const st = await page.evaluate(() => {
    const { drive: d, chase: c } = window.__br;
    const f = (v) => [v.x, v.y, v.z].map((n) => n.toFixed(1)).join(',');
    return `car (${f(d.position)}) heading ${((d.heading * 180) / Math.PI).toFixed(0)} deg, camera (${f(c.camera.position)})`;
  });
  console.log('STATE', st);
};
await hud();
await page.screenshot({ path: join(out, `${tag}-1-rest.png`) });

await page.keyboard.down('KeyW');
await page.waitForTimeout(4000);
await page.screenshot({ path: join(out, `${tag}-2-straight.png`) });
await hud();
await page.keyboard.down('KeyD');
await page.waitForTimeout(1200);
await page.screenshot({ path: join(out, `${tag}-3-turn.png`) });
await page.keyboard.up('KeyD');
await page.keyboard.up('KeyW');
await page.keyboard.press('KeyC');
await page.waitForTimeout(800);
await page.screenshot({ path: join(out, `${tag}-4-camera-far.png`) });
await hud();
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no console errors');
await browser.close();
