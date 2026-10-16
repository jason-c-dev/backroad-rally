#!/usr/bin/env node
// Audio checks (slice 6b).
//
//   node tools/check/audio.mjs --loops                  decode every converted loop (Opus and AAC) and check
//                                                       the loop window: seamless wrap, lined up with the source
//   node tools/check/audio.mjs [--cars swift,pip] [--secs 40] [--out dir] [--params "cond=night"]
//                                                       record a headless autopilot run of each car through the
//                                                       measurement taps (?audiorec) and analyse it
//
// The recording mode serves dist/ itself on port 4183 (run `npm run build` first), presses a key so the
// AudioContext starts the way a player's would, and saves <out>/<car>.wav (and .opus). It prints, per car:
// the mix table (K-weighted loudness per group at full throttle, relative to the engine), engine over
// music, loudness and peak of the master, clicks (outliers of the second difference) and the limiter
// (cuts, pops, and the envelope's period during the cuts).
// Chrome: CHROME_PATH, CHROME_ARGS (default: GPU through ANGLE/EGL, headless).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const audioDir = join(repo, 'public', 'audio');
const manifest = JSON.parse(readFileSync(join(audioDir, 'manifest.json'), 'utf8'));

function decode(path, rate = 48000) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(rate), '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${path}: ${r.stderr}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}

function readWavMono(path) {
  const b = readFileSync(path);
  const d = b.indexOf('data');
  const ch = b.readUInt16LE(22);
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + d + 8, b.byteOffset + d + 8 + b.readUInt32LE(d + 4)));
  const out = new Float32Array(pcm.length / ch);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += pcm[i * ch + c];
    out[i] = s / ch / 32768;
  }
  return out;
}

const pct = (arr, p) => {
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

// ------------------------------------------------------------------ loops (offline)
/** Same as sealLoop in src/audio/system.ts. */
function seal(d, a, b, k = 256) {
  const n = Math.min(k, a, b - a);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    d[b - n + i] = d[b - n + i] * (1 - t) + d[a - n + i] * t;
  }
}

function checkLoops() {
  const ue = resolve(process.env.BR_UE_ROOT ?? join(repo, '..', 'BackroadRally'));
  const rows = [];
  for (const [name, e] of Object.entries(manifest.sounds)) {
    if (!e.loop) continue;
    const src = readWavMono(join(ue, 'Audio', 'Export', `${name}.wav`));
    for (const ext of ['opus', 'm4a']) {
      const x = Float32Array.from(decode(join(audioDir, `${name}.${ext}`)));
      const a = Math.round(e.ls * 48000);
      const b = Math.round(e.le * 48000);
      seal(x, a, b); // what the game does after decoding (src/audio/system.ts sealLoop)
      const len = b - a;
      // the wrap step against the loop's own step distribution
      const steps = [];
      for (let i = a + 1; i < b; i++) steps.push(Math.abs(x[i] - x[i - 1]));
      const p99 = pct(steps, 0.99) || 1e-9;
      const wrap = Math.abs(x[a] - x[b - 1]) / p99;
      // alignment: best lag of the decoded window against the source (codec delay / priming)
      let best = 0;
      let bestC = -Infinity;
      for (let lag = -60; lag <= 60; lag += 1) {
        let c = 0;
        for (let i = 0; i < len; i += 2) c += x[a + lag + i] * src[i];
        if (c > bestC) {
          bestC = c;
          best = lag;
        }
      }
      // the error of the lossy round trip over the window, in dB under the signal
      let err = 0;
      let sig = 0;
      for (let i = 0; i < len; i++) {
        const s = src[i % src.length];
        const d = x[a + best + i] - s;
        err += d * d;
        sig += s * s;
      }
      rows.push({ name, ext, wrap, lag: best, snr: 10 * Math.log10(sig / Math.max(err, 1e-12)), len, srcLen: src.length });
    }
  }
  const bad = rows.filter((r) => r.wrap > 1.5 || r.len !== r.srcLen);
  for (const ext of ['opus', 'm4a']) {
    const r = rows.filter((x) => x.ext === ext);
    console.log(`${ext}: ${r.length} loops; wrap step / p99 step: max ${Math.max(...r.map((x) => x.wrap)).toFixed(2)}, median ${pct(r.map((x) => x.wrap), 0.5).toFixed(2)};` +
      ` codec offset ${Math.min(...r.map((x) => x.lag))}..${Math.max(...r.map((x) => x.lag))} samples (pad ${manifest.pad * 48000});` +
      ` round-trip SNR median ${pct(r.map((x) => x.snr), 0.5).toFixed(1)} dB, worst ${Math.min(...r.map((x) => x.snr)).toFixed(1)} dB (${r.sort((p, q) => p.snr - q.snr)[0].name})`);
  }
  if (bad.length) console.log(`ROUGH: ${bad.map((r) => `${r.name}.${r.ext} wrap ${r.wrap.toFixed(2)} len ${r.len}/${r.srcLen}`).join(', ')}`);
  else console.log('all loop windows wrap within their own step range and match the source length');
}

if (process.argv.includes('--loops')) {
  checkLoops();
  process.exit(0);
}

// ------------------------------------------------------------------ recording
const PORT = 4183;
const dist = join(repo, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ not built: npm run build');
  process.exit(1);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname).replace(/^\/backroad-rally\//, '/');
  if (p.endsWith('/')) p += 'index.html';
  const file = join(dist, p);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  const body = readFileSync(file);
  // ranges, for the <audio> element's streaming
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  if (range) {
    const a = Number(range[1]);
    const b = range[2] ? Number(range[2]) : body.length - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': b - a + 1 });
    res.end(body.subarray(a, b + 1));
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
    res.end(body);
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const cars = arg('--cars', 'swift,pip,lama,quint,kaze').split(',');
const secs = Number(arg('--secs', '40'));
const out = arg('--out', 'audio-check');
const extra = arg('--params', '');
const jumpAt = Number(arg('--jump-at', '-1'));
const solo = arg('--solo', ''); // only this group (the user volumes in localStorage), to find where a sound comes from
mkdirSync(out, { recursive: true });
const executablePath = arg('--chrome', process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable');
const tuning = JSON.parse(readFileSync(join(repo, 'public', 'data', 'cars_tuning.json'), 'utf8'));

const browser = await chromium.launch({
  executablePath,
  // Playwright passes --autoplay-policy=no-user-gesture-required by default: drop it, the key must start the sound
  ignoreDefaultArgs: ['--autoplay-policy=no-user-gesture-required'],
  args: [...(process.env.CHROME_ARGS ?? '--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist').split(' '), '--autoplay-policy=user-gesture-required'],
});
const db = (p) => (p > 1e-12 ? -0.691 + 10 * Math.log10(p) : -99);
const results = [];
try {
  for (const car of cars) {
    const page = await browser.newPage({ viewport: { width: 960, height: 400 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
    const url = `http://127.0.0.1:${PORT}/backroad-rally/?car=${car}&autopilot=120&audiorec&quality=low&scale=0.5${extra ? `&${extra}` : ''}`;
    if (solo) {
      await page.addInitScript((g) => {
        const groups = Object.fromEntries(['engine', 'surface', 'sfx', 'ui', 'music', 'ambience', 'crowd', 'weather'].map((k) => [k, k === g ? 1 : 0]));
        localStorage.setItem('backroad-rally.audio', JSON.stringify({ master: 0.8, muted: false, groups }));
      }, solo);
    }
    await page.goto(url);
    await page.waitForFunction(() => window.__brAudio?.rec, null, { timeout: 60000 });
    // headless Chrome doesn't hold audio back before a gesture (any autoplay flag): put the context in the
    // state a browser starts it in, so the key below goes through the game's own resume path
    await page.evaluate(() => window.__brAudio.sys.ctx.suspend());
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => ({ state: window.__brAudio.sys.ctx.state, hint: getComputedStyle(document.querySelector('#audio-ui .hint')).display }));
    await page.keyboard.press('ShiftLeft'); // a key the game doesn't use: the context resumes on it
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ state: window.__brAudio.sys.ctx.state, rate: window.__brAudio.sys.ctx.sampleRate, format: window.__brAudio.sys.format,
      hint: getComputedStyle(document.querySelector('#audio-ui .hint')).display, buffers: window.__brAudio.sys.buffers.size }));
    // the recording started with the page: drop what came before the key
    const skip = await page.evaluate(() => window.__brAudio.rec.pcm.length);
    if (jumpAt > 0 && jumpAt < secs) {
      // once, lift the car 6 m: air time on throttle must free-rev it into the limiter (core-11)
      await page.waitForTimeout(jumpAt * 1000);
      await page.evaluate(() => {
        const { vehicle: v, sim } = window.__br;
        v.teleport(v.position.clone().setY(v.position.y + 6), v.yawDeg);
        v.launch(25);
        sim.snap();
      });
      await page.waitForTimeout((secs - jumpAt) * 1000);
    } else await page.waitForTimeout(secs * 1000);
    const data = await page.evaluate((skip) => {
      const r = window.__brAudio.rec;
      const b64 = (chunks) => {
        const pcm = chunks.slice(skip);
        const n = pcm.reduce((a, c) => a + c.length, 0);
        const i16 = new Int16Array(n);
        let o = 0;
        for (const c of pcm) for (let i = 0; i < c.length; i++) i16[o++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
        const bytes = new Uint8Array(i16.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      };
      return {
        b64: b64(r.pcm), b64fx: b64(r.pcmFx), rate: r.rate, block: r.block,
        groups: Object.fromEntries(Object.entries(r.groups).map(([k, v]) => [k, v.slice(skip)])),
        peaks: Object.fromEntries(Object.entries(r.peaks).map(([k, v]) => [k, v.slice(skip)])),
        state: r.state.slice(skip),
        cutLog: [...window.__brAudio.car.cutLog], cutSkips: window.__brAudio.car.cutSkips,
      };
    }, skip);
    await page.close();
    const wav = join(out, `${car}.wav`);
    const wavFx = join(out, `${car}-nomusic.wav`);
    writeWav(wav, Buffer.from(data.b64, 'base64'), data.rate);
    writeWav(wavFx, Buffer.from(data.b64fx, 'base64'), data.rate);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '128k', '-map_metadata', '-1', join(out, `${car}.opus`)]);
    results.push(analyse(car, data, wav, wavFx, { before, after, errors }));
  }
} finally {
  await browser.close();
  server.close();
}

function writeWav(path, pcm, rate) {
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + pcm.length, 4);
    hdr.write('WAVEfmt ', 8);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(2, 22);
    hdr.writeUInt32LE(rate, 24);
    hdr.writeUInt32LE(rate * 4, 28);
    hdr.writeUInt16LE(4, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(pcm.length, 40);
    writeFileSync(path, Buffer.concat([hdr, pcm]));
}

function analyse(car, data, wav, wavFx, ctx) {
  const st = data.state;
  const max = tuning[car]?.engine?.max_rpm ?? 7500;
  const n = st.length;
  // group power per block, 400 ms momentary windows (4 blocks)
  const G = Object.keys(data.groups);
  const mom = (g, i) => {
    const a = data.groups[g];
    let s = 0;
    let k = 0;
    for (let j = Math.max(0, i - 3); j <= i; j++, k++) s += a[j] ?? 0;
    return s / k;
  };
  const sel = (f) => st.map((s, i) => [s, i]).filter(([s]) => f(s)).map(([, i]) => i);
  const mean = (g, idx) => (idx.length ? idx.reduce((a, i) => a + mom(g, i), 0) / idx.length : 0);
  const running = (s) => s.phase === 'running' && s.kmh > 20;
  const full = sel((s) => running(s) && s.throttle >= 0.95);
  const fullHigh = sel((s) => running(s) && s.throttle >= 0.95 && s.simRpm / max >= 0.75);
  const lift = sel((s) => running(s) && s.throttle <= 0.1);
  const table = {};
  for (const g of G) table[g] = { full: db(mean(g, full)), fullHigh: db(mean(g, fullHigh)), lift: db(mean(g, lift)), all: db(mean(g, st.map((_, i) => i))) };
  // clicks: |second difference| far above its local level (5 ms windows, against the median of 0.2 s around)
  // clicks on everything but the music (its drums are transients by design)
  const x = readWavMono(wavFx);
  const W = 240;
  const nw = Math.floor(x.length / W);
  const rms = new Float64Array(nw);
  const maxd = new Float64Array(nw);
  for (let w = 0; w < nw; w++) {
    let s = 0;
    let m = 0;
    for (let i = w * W + 2; i < (w + 1) * W; i++) {
      const d = x[i] - 2 * x[i - 1] + x[i - 2];
      s += d * d;
      m = Math.max(m, Math.abs(d));
    }
    rms[w] = Math.sqrt(s / W);
    maxd[w] = m;
  }
  // event times on the recording's clock (each state row is sampled at the end of its block)
  const t0 = (st[0]?.t ?? 0) - data.block / data.rate;
  const evts = st.flatMap((s) => String(s.events ?? '').split(' ').filter(Boolean).map((e) => {
    const [k, t] = e.split('@');
    return { k, t: Number(t) - t0 };
  }));
  const clicks = [];
  for (let w = 20; w < nw - 20; w++) {
    const local = pct(Array.from(rms.subarray(w - 20, w + 20)), 0.5);
    if (maxd[w] > 12 * local && maxd[w] > 0.02) {
      const t = (w * W) / data.rate;
      // a backfire, landing, impact or splash is a transient by design: say which
      const near = evts.find((e) => ['backfire', 'landing', 'impact', 'splash', 'countdown', 'go', 'penalty'].includes(e.k) && t >= e.t - 0.12 && t <= e.t + 0.25);
      const blk = st[Math.min(st.length - 1, Math.floor((t * data.rate) / data.block))] ?? {};
      // the gravel roll recording has ~5 stone crunches a second of its own: audible gravel counts as content
      const bi = Math.min(st.length - 1, Math.floor((t * data.rate) / data.block));
      const gravel = db(data.groups.surface[bi] ?? 0) > db(data.groups.nomusic[bi] ?? 0) - 20;
      clicks.push({ t: +t.toFixed(2), cause: near ? near.k : blk.limiter ? 'limiter' : gravel ? 'gravel' : '?',
        at: `${blk.phase} ${Number(blk.kmh).toFixed(0)} km/h g${blk.gear} thr ${Number(blk.throttle).toFixed(2)} rpm ${Number(blk.rpm).toFixed(0)} free ${Number(blk.free).toFixed(2)} air ${Number(blk.air).toFixed(2)}`,
        size: +maxd[w].toFixed(3), local: +local.toFixed(4) });
    }
  }
  // limiter: share of blocks, cuts, pops, and the dominant period of the master's envelope while limiting
  const lim = sel((s) => s.limiter);
  const last = st[n - 1] ?? {};
  let period = null;
  if (lim.length >= 6) {
    // longest run of limiter blocks
    let bestA = 0;
    let bestL = 0;
    for (let i = 0, a = 0; i <= lim.length; i++) {
      if (i === lim.length || (i > 0 && lim[i] !== lim[i - 1] + 1)) {
        if (i - a > bestL) {
          bestL = i - a;
          bestA = lim[a];
        }
        a = i;
      }
    }
    const a0 = bestA * data.block;
    const len = Math.min(bestL * data.block, data.rate);
    const env = [];
    const E = 48; // 1 ms
    for (let i = a0; i + E <= a0 + len; i += E) {
      let s = 0;
      for (let j = i; j < i + E; j++) s += x[j] * x[j];
      env.push(Math.sqrt(s / E));
    }
    const m = env.reduce((a, b) => a + b, 0) / env.length;
    const ac = (lag) => {
      let c = 0;
      for (let i = 0; i + lag < env.length; i++) c += (env[i] - m) * (env[i + lag] - m);
      return c;
    };
    let best = -Infinity;
    let bestLag = 0;
    for (let lag = 30; lag <= 80 && lag < env.length / 2; lag++) { // 30..80 ms: the cars' 12.5..33 Hz
      const c = ac(lag);
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    if (bestLag) {
      // parabolic peak between the bins
      const [l, c, r] = [ac(bestLag - 1), best, ac(bestLag + 1)];
      const d = l - 2 * c + r;
      period = ((bestLag + (d ? (0.5 * (l - r)) / d : 0)) * E) / data.rate;
    }
  }
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const sum = r.stderr.split('Summary:').pop() ?? '';
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1];
  const peak = /Peak:\s+(-?[\d.inf]+) dBFS/.exec(sum)?.[1];
  const music = [...new Set(st.map((s) => s.music).filter(Boolean))];
  // the music at the track's integrated loudness through its gain path (a 40 s window of a song is
  // +-1 dB off its whole-track loudness; this isn't)
  const trackAt = (idx) => {
    const v = idx.map((i) => st[i].musicTrack).filter((x) => x > -90);
    return v.length ? 10 * Math.log10(v.reduce((a, x) => a + 10 ** (x / 10), 0) / v.length) : -99;
  };
  const musicTrack = { full: trackAt(full), fullHigh: trackAt(fullHigh) };
  const counts = {};
  for (const e of evts) counts[e.k] = (counts[e.k] ?? 0) + 1;
  // the scheduled cuts: intervals inside a limiter run (gaps over 0.1 s start a new run)
  const iv = data.cutLog.slice(1).map((t, i) => t - data.cutLog[i]).filter((d) => d < 0.1);
  const cutHz = iv.length ? 1 / pct(iv, 0.5) : null;
  const res = { car, ctx, blocks: n, counts, musicTrack, cutHz, cutSkips: data.cutSkips, cutIvRange: iv.length ? [Math.min(...iv), Math.max(...iv)] : null, full: full.length, fullHigh: fullHigh.length, table, clicks, limiterShare: lim.length / Math.max(1, n),
    cuts: last.cuts, pops: last.pops, period, I, peak, music, maxKmh: Math.max(...st.map((s) => s.kmh)) };
  print(res);
  res.state = st;
  return res;
}

function print(r) {
  const f = (v) => (v <= -98 ? '   -  ' : v.toFixed(1).padStart(6));
  console.log(`\n== ${r.car}: context ${r.ctx.before.state} -> ${r.ctx.after.state} after a key (hint ${r.ctx.before.hint} -> ${r.ctx.after.hint}),` +
    ` ${r.ctx.after.rate} Hz, ${r.ctx.after.format}, ${r.ctx.after.buffers} buffers; ${(r.blocks * 0.1013).toFixed(0)} s recorded, top ${r.maxKmh.toFixed(0)} km/h`);
  console.log(`   master ${r.I} LUFS integrated, true peak ${r.peak} dBFS; music: ${r.music.join(', ') || 'none'}`);
  console.log(`   group      full thr  rel.eng | full+high rel.eng | lift   | whole run  (LUFS, K-weighted, 400 ms; ${r.full}/${r.fullHigh} blocks)`);
  const e = r.table.engine;
  for (const [g, v] of Object.entries(r.table)) {
    if (g === 'master') continue;
    console.log(`   ${g.padEnd(9)} ${f(v.full)}  ${f(v.full - e.full)} | ${f(v.fullHigh)}  ${f(v.fullHigh - e.fullHigh)} | ${f(v.lift)} | ${f(v.all)}`);
  }
  const m = r.table.master;
  console.log(`   master    ${f(m.full)}          | ${f(m.fullHigh)}          | ${f(m.lift)} | ${f(m.all)}`);
  console.log(`   engine over music: ${(e.full - r.table.music.full).toFixed(1)} dB at full throttle, ${(e.fullHigh - r.table.music.fullHigh).toFixed(1)} dB at full throttle and high revs (target +4)`);
  console.log(`   engine over music (whole-track loudness): ${(e.full - r.musicTrack.full).toFixed(1)} dB at full throttle, ${(e.fullHigh - r.musicTrack.fullHigh).toFixed(1)} dB with high revs`);
  // targets relative to the engine at full throttle (src/audio/mix.ts CALIBRATION_DB has the why)
  const T = { music: [-5.5, -2.5], surface: [-18, -10], ambience: [-24, -16] };
  console.log(`   targets: ${Object.entries(T).map(([g, [lo, hi]]) => {
    const rel = (g === 'music' ? r.musicTrack.full : r.table[g].full) - e.full;
    return `${g} ${rel.toFixed(1)} in [${lo}, ${hi}] ${rel >= lo && rel <= hi ? 'ok' : 'MISS'}`;
  }).join(', ')}`);
  console.log(`   limiter: ${(r.limiterShare * 100).toFixed(1)} % of the run, ${r.cuts} cuts, ${r.pops} pops; scheduled cuts ${r.cutHz ? `${r.cutHz.toFixed(2)} Hz (intervals ${r.cutIvRange.map((x) => (x * 1000).toFixed(1)).join('..')} ms)` : '-'}, ${r.cutSkips} skipped;` +
    ` heard envelope period ${r.period ? `${(r.period * 1000).toFixed(0)} ms (${(1 / r.period).toFixed(1)} Hz)` : '-'}`);
  const odd = r.clicks.filter((c) => c.cause === '?');
  console.log(`   events: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`   transients (2nd-difference outliers): ${r.clicks.length}, unexplained ${odd.length}${r.clicks.length ? `: ${r.clicks.slice(0, 16).map((c) => `${c.t}${c.cause === '?' ? ' ?' : ` ${c.cause}`}`).join(', ')}` : ''}`);
  for (const c of odd.slice(0, 6)) console.log(`     ? ${c.t} s: ${c.at} (2nd diff ${c.size} vs local rms ${c.local})`);
  if (r.ctx.errors.length) console.log(`   console errors: ${r.ctx.errors.join(' | ')}`);
}

writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
