#!/usr/bin/env node
// Convert the UE project's audio into web assets (public/audio/).
//
//   node tools/convert/audio.mjs [--ue ../BackroadRally] [--only A_Engine_Lama] [--no-music]
//                                                        (or set BR_UE_ROOT)
//
// Reads Content/Data/audio.json (the manifest) and audio_mix.json, and the WAVs in Audio/Export.
//   * engine, SFX and UI sounds -> <name>.opus (Ogg Opus) + <name>.m4a (AAC-LC, for browsers that
//     can't decode Opus), decoded into AudioBuffers up front by the game;
//   * music (the menu tracks and the tracks tagged for this slice's stages) -> <name>.opus only,
//     streamed through an <audio> element.
// Loudness: the UE pipeline already normalised every WAV (SFX and UI -16 LUFS, music -18 LUFS,
// engine layers by the synth's own rpm curve) and the manifest's volume_db is the mix on top, so no
// gain is applied here; the integrated loudness is measured and written to the manifest (lufs).
// Loops: the encoders don't know a file wraps, so a seam would click after a lossy round trip. Each
// loop is encoded with PAD samples of wrap-around on both sides (tail before the head, head after
// the tail) and the manifest gives the loop window (ls..le, seconds); any window of the loop's length
// inside the padded file is seamless, so codec delays up to PAD (AAC priming, Opus pre-skip) don't matter.
// All tags are stripped (-map_metadata -1, bitexact). Never reads Audio/Source/*_rejected/.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const ue = resolve(arg('--ue', process.env.BR_UE_ROOT ?? join(repo, '..', 'BackroadRally')));
const exportDir = join(ue, 'Audio', 'Export');
const dataDir = join(ue, 'Content', 'Data');
const out = join(repo, 'public', 'audio');
const only = arg('--only', '');
const withMusic = !process.argv.includes('--no-music');

if (!existsSync(exportDir) || !existsSync(join(dataDir, 'audio.json'))) {
  console.error(`UE audio not found under ${ue} (pass --ue or set BR_UE_ROOT)`);
  process.exit(1);
}

/** Music this slice ships: location-free menu and night tracks, and the stages built so far. */
const MUSIC_LOCATIONS = ['finland'];
const SR = 48000;
const PAD = 4800; // 0.1 s of wrap-around on each side of a loop
const BITRATE = {
  opus: { 1: '64k', 2: '96k' },
  m4a: { 1: '80k', 2: '128k' },
  music: '84k', // VBR: lands at ~96 kbps on these mixes
};
const STRIP = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'];

/** Drop comment keys ("_doc..."): design notes, and they name people. */
function stripDocs(v) {
  if (Array.isArray(v)) return v.map(stripDocs);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripDocs(x)]));
  }
  return v;
}

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV`);
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.rate !== SR) throw new Error(`${path}: want 16-bit PCM at ${SR} Hz`);
  const pcm = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
  return { channels: fmt.channels, frames: pcm.length / fmt.channels, pcm };
}

/** The loop with PAD frames of wrap-around on each side. */
function padLoop({ channels, frames, pcm }) {
  const outp = new Int16Array((frames + 2 * PAD) * channels);
  for (let i = 0; i < frames + 2 * PAD; i++) {
    const src = (((i - PAD) % frames) + frames) % frames;
    for (let c = 0; c < channels; c++) outp[i * channels + c] = pcm[src * channels + c];
  }
  return outp;
}

/** Seam jump of the source loop over its 99th-percentile sample step (<= 1: no worse than the loop's own edges). */
function seamRatio({ channels, frames, pcm }) {
  const steps = new Float64Array(frames - 1);
  for (let i = 1; i < frames; i++) steps[i - 1] = Math.abs(pcm[i * channels] - pcm[(i - 1) * channels]);
  steps.sort();
  const p99 = steps[Math.floor(steps.length * 0.99)] || 1;
  return Math.abs(pcm[0] - pcm[(frames - 1) * channels]) / p99;
}

function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${r.stderr}`);
  return r;
}

function lufs(path) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split('Summary:').pop() ?? '');
  return m ? Number(m[1]) : null;
}

function encode(raw, channels, dest, codec, bitrate) {
  const input = ['-f', 's16le', '-ar', String(SR), '-ac', String(channels), '-i', 'pipe:0'];
  const enc = codec === 'opus'
    ? ['-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-compression_level', '10', '-application', 'audio', '-f', 'ogg']
    : ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', '-f', 'mp4'];
  ffmpeg([...input, ...enc, ...STRIP, dest], Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
}

const manifest = JSON.parse(readFileSync(join(dataDir, 'audio.json'), 'utf8'));
const mix = stripDocs(JSON.parse(readFileSync(join(dataDir, 'audio_mix.json'), 'utf8')));
// The port's own changes on top of the original mix. Crowds: the original's 0.8 sat ~18 dB under the
// engine once the listener moved to the car; raised ~5 dB on playtest (2026-10-16).
mix.groups.crowd = 1.4;
mkdirSync(out, { recursive: true });

const sounds = {};
// --no-music keeps the music already converted
const previous = existsSync(join(out, 'manifest.json')) ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) : {};
const music = withMusic ? {} : (previous.music ?? {});
const sizes = { opus: 0, m4a: 0, music: 0 };
const bytesOf = (p) => statSync(p).size;
for (const [name, e] of Object.entries(manifest)) {
  if (name.startsWith('_') || e.kind === 'doc') continue;
  if (only && !name.startsWith(only)) continue;
  const wavPath = join(exportDir, `${name}.wav`);
  if (!existsSync(wavPath)) {
    console.warn(`missing ${wavPath}`);
    continue;
  }
  if (e.kind === 'music') {
    const tags = e.tags ?? [];
    const isLocation = (t) => !['menu', 'night', 'stage', 'calm'].includes(t);
    const loc = tags.filter(isLocation);
    const ship = loc.length === 0 ? tags.includes('menu') || tags.includes('night') : loc.some((l) => MUSIC_LOCATIONS.includes(l));
    if (!withMusic || !ship) continue;
    const wav = readWav(wavPath);
    const dest = join(out, `${name}.opus`);
    encode(wav.pcm, wav.channels, dest, 'opus', BITRATE.music);
    sizes.music += bytesOf(dest);
    music[name] = { title: e.title, tags, dur: +(wav.frames / SR).toFixed(3), db: e.volume_db ?? 0, lufs: lufs(wavPath) };
    console.log(`music ${name} ${(bytesOf(dest) / 1e6).toFixed(2)} MB`);
    continue;
  }
  const wav = readWav(wavPath);
  const entry = {
    kind: e.kind,
    loop: !!e.loop,
    ch: wav.channels,
    dur: +(wav.frames / SR).toFixed(5),
    db: e.volume_db ?? 0,
    lufs: lufs(wavPath),
  };
  for (const k of ['car', 'ref_rpm', 'layer', 'idle', 'location']) if (e[k] !== undefined) entry[k] = e[k];
  let raw = wav.pcm;
  if (e.loop) {
    raw = padLoop(wav);
    entry.ls = PAD / SR;
    entry.le = (PAD + wav.frames) / SR;
    entry.seam = +seamRatio(wav).toFixed(2);
  }
  for (const codec of ['opus', 'm4a']) {
    const dest = join(out, `${name}.${codec}`);
    encode(raw, wav.channels, dest, codec, BITRATE[codec][wav.channels]);
    sizes[codec] += bytesOf(dest);
  }
  sounds[name] = entry;
}

if (!only) {
  // anything left from an earlier run that isn't in the manifest any more
  const keep = new Set([...Object.keys(sounds).flatMap((n) => [`${n}.opus`, `${n}.m4a`]), ...Object.keys(music).map((n) => `${n}.opus`), 'manifest.json', 'mix.json']);
  for (const f of readdirSync(out)) if (!keep.has(f)) rmSync(join(out, f));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ pad: PAD / SR, sounds, music }));
  writeFileSync(join(out, 'mix.json'), JSON.stringify(mix));
}

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const loops = Object.entries(sounds).filter(([, e]) => e.loop);
console.log(`${Object.keys(sounds).length} sounds (${loops.length} loops), ${Object.keys(music).length} music tracks`);
console.log(`sounds: opus ${mb(sizes.opus)}, m4a ${mb(sizes.m4a)}; music (opus): ${mb(sizes.music)}`);
const rough = loops.filter(([, e]) => e.seam > 1.5).map(([n, e]) => `${n} ${e.seam}`);
if (rough.length) console.log(`source loops with a rough seam (jump / mean step): ${rough.join(', ')}`);
