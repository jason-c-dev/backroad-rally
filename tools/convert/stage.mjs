#!/usr/bin/env node
// Convert a stage from the UE project's Content/Data/stages/<id>.json (handoff §4.2) into
//   public/data/stages/<id>.json: road, variants, features, fords, water, crowds, tiles, bounds (three metres)
//   public/data/stages/<id>.bin:  the instance table, quantized and gzipped (format below)
// and print the env meshes the stage needs (for tools/blender/export_env_glb.py).
//
//   node tools/convert/stage.mjs finland [--ue ../BackroadRally]
//
// Axes: UE (X, Y, Z) cm -> three (X/100, Z/100, Y/100); UE yaw (deg) -> three rotation.y = -rad.
//
// Instance table (bin.format "q16"): n instances as struct-of-arrays, little-endian, then gzip:
//   x, y, z  uint16 over [origin, origin + extent] (x and z ~5 cm steps on a 3 km stage)
//   rotY     uint16 over [-pi, pi)
//   scale    uint16 over [scale[0], scale[1]]
//   tint     uint8  over [0, 1]
// src/world/stage.ts decodes it to six floats per instance [x, y, z, rotY, scale, tint].
// 11 bytes an instance before gzip instead of 24 as Float32.
//
// Also applied here, as the original did at load (stage_runtime.json features):
// - thin.<stage>: drop (1 - keep) of some categories' or meshes' instances beyond beyond_cm of the road
//   (deterministic per stage and mesh); they were never drawn there, so they're never shipped here.
// - white_tint.<mesh>: pure-white vertices take a per-instance colour (cows, sheep). Each instance gets a
//   palette entry here and is listed under "<mesh>~<k>"; the runtime builds one tinted copy of the mesh per k.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const ui = args.indexOf('--ue');
const ue = resolve(ui >= 0 ? args[ui + 1] : process.env.BR_UE_ROOT ?? join(repo, '..', 'BackroadRally'));
const src = join(ue, 'Content', 'Data');
if (!id || !existsSync(join(src, 'stages', `${id}.json`))) {
  console.error(`usage: node tools/convert/stage.mjs <stage id> [--ue <path>] (no stage file under ${src}/stages)`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(join(src, 'stages', `${id}.json`), 'utf8'));
const runtime = JSON.parse(readFileSync(join(src, 'stage_runtime.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(src, 'env_catalog.json'), 'utf8'));
const features = runtime.features ?? {};

const r2 = (v) => Math.round(v * 100) / 100;
const pos = (p) => [r2(p[0] / 100), r2((p[2] ?? 0) / 100), r2(p[1] / 100)];
const rotY = (yawDeg) => (-yawDeg * Math.PI) / 180;

// road: struct of arrays
const surfaces = [];
const road = { p: [], half_width: [], s: [], surface: [], surfaces };
for (const c of d.centreline) {
  road.p.push(...pos(c.p));
  road.half_width.push(r2(c.half_width / 100));
  road.s.push(r2(c.s));
  let k = surfaces.indexOf(c.surface);
  if (k < 0) k = surfaces.push(c.surface) - 1;
  road.surface.push(k);
}

// distance from the centreline (cm, 2D, to the nearest sample: they are 2 m apart), on a 50 m grid
const GRID = 5000;
const grid = new Map();
d.centreline.forEach((c, i) => {
  const k = `${Math.floor(c.p[0] / GRID)},${Math.floor(c.p[1] / GRID)}`;
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
});
const roadDistCm = (x, y) => {
  let best = Infinity;
  const cx = Math.floor(x / GRID), cy = Math.floor(y / GRID);
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      for (const i of grid.get(`${cx + a},${cy + b}`) ?? []) {
        const p = d.centreline[i].p;
        best = Math.min(best, (p[0] - x) ** 2 + (p[1] - y) ** 2);
      }
    }
  }
  return Math.sqrt(best);
};

// deterministic per stage and mesh (any PRNG will do: the original's stream isn't reproducible here)
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const thinCfg = features.thin?.[id];
const thinFor = (mesh) => {
  const m = thinCfg?.meshes?.[mesh];
  if (m) return { beyond: m.beyond_cm ?? 0, keep: m.keep ?? 1 };
  if (thinCfg?.categories?.includes(catalog[mesh]?.category)) return { beyond: thinCfg.beyond_cm ?? 4000, keep: thinCfg.keep ?? 1 };
  return null;
};

// instances and breakables: one table
const rows = [];
const index = {};
const thinned = {};
const pack = (group, scenery) => {
  const out = {};
  for (const [mesh, list] of Object.entries(group ?? {})) {
    const thin = scenery ? thinFor(mesh) : null;
    const roll = rng(hash(`${id}/${mesh}/thin`));
    const kept = [];
    for (const i of list) {
      if (i.length < 5) continue;
      const r = roll();
      if (thin && r > thin.keep && roadDistCm(i[0], i[1]) > thin.beyond) continue;
      kept.push(i);
    }
    if (thin) thinned[mesh] = list.length - kept.length;
    const palette = scenery ? features.white_tint?.[mesh] : null;
    if (palette?.length) {
      // one table per palette entry: "<mesh>~<k>"
      const pick = rng(hash(`${id}/${mesh}/tint`));
      const byK = palette.map(() => []);
      for (const i of kept) byK[Math.min(palette.length - 1, Math.floor(pick() * palette.length))].push(i);
      byK.forEach((l, k) => {
        if (!l.length) return;
        out[`${mesh}~${k}`] = [rows.length, l.length];
        rows.push(...l);
      });
    } else {
      out[mesh] = [rows.length, kept.length];
      rows.push(...kept);
    }
  }
  return out;
};
index.instances = pack(d.instances, true);
index.breakables = pack(d.breakables, false);

// quantize
const n = rows.length;
const f = rows.map((i) => [i[0] / 100, (i[2] ?? 0) / 100, i[1] / 100, rotY(i[3]), i[4], i.length > 5 ? i[5] : 0.5]);
const minOf = (k) => f.reduce((m, r) => Math.min(m, r[k]), Infinity);
const maxOf = (k) => f.reduce((m, r) => Math.max(m, r[k]), -Infinity);
const lo = [0, 1, 2].map(minOf);
const hi = [0, 1, 2].map(maxOf);
const origin = lo.map((v) => Math.floor(v) - 1);
const extent = hi.map((v, k) => Math.ceil(v) + 1 - origin[k]);
const sLo = minOf(4), sHi = maxOf(4);
const scale = [Math.floor(sLo * 100) / 100, Math.max(Math.ceil(sHi * 100) / 100, Math.floor(sLo * 100) / 100 + 0.01)];
const buf = Buffer.alloc(n * 11);
const q16 = (v, a, span) => Math.max(0, Math.min(65535, Math.round(((v - a) / span) * 65535)));
const wrapPi = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};
for (let k = 0; k < n; k++) {
  const r = f[k];
  buf.writeUInt16LE(q16(r[0], origin[0], extent[0]), 2 * k);
  buf.writeUInt16LE(q16(r[1], origin[1], extent[1]), 2 * (n + k));
  buf.writeUInt16LE(q16(r[2], origin[2], extent[2]), 2 * (2 * n + k));
  buf.writeUInt16LE(Math.round(((wrapPi(r[3]) + Math.PI) / (2 * Math.PI)) * 65536) & 0xffff, 2 * (3 * n + k));
  buf.writeUInt16LE(q16(r[4], scale[0], scale[1] - scale[0]), 2 * (4 * n + k));
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round(r[5] * 255))), 10 * n + k);
}
const gz = gzipSync(buf, { level: 9 });

const crowdMeshes = runtime.crowd?.meshes ?? [];
const gantries = runtime.gantries ?? {};
const base = (k) => k.split('~')[0];
const env = new Set([...Object.keys(index.instances).map(base), ...Object.keys(index.breakables), ...crowdMeshes,
  ...(gantries.start ? [gantries.start] : []), ...(gantries.finish ? [gantries.finish] : [])]);

const out = {
  id: d.id,
  name: d.name,
  location: d.location,
  surface: d.surface,
  length_m: d.length_m,
  road,
  variants: d.variants,
  features: (d.features ?? []).map((ft) => ({ ...ft, p: ft.p ? pos(ft.p) : undefined })),
  crowds: (d.crowds ?? []).map((c) => ({ ...c, p: pos(c.p), rotY: rotY(c.yaw ?? 0), radius: c.radius / 100 })),
  tiles: d.tiles.map((t) => ({ mesh: t.mesh, p: pos(t.pos) })),
  unique_meshes: (d.unique_meshes ?? []).map((u) => ({ mesh: u.mesh, p: pos(u.pos), rotY: rotY(u.yaw ?? 0), collision: u.collision ?? 'complex' })),
  water_level: d.water_level_cm != null ? r2(d.water_level_cm / 100) : null,
  water_bodies: (d.water_bodies ?? []).map((w) => ({ name: w.name, level: r2(w.level_cm / 100) })),
  // fords: the road's s range and the water surface (m); the water has no collider, the car wades (drag)
  fords: (d.fords ?? []).map((fd) => ({ s0: fd.s0, s1: fd.s1, water: r2(fd.water_cm / 100), p: fd.p ? pos(fd.p) : undefined })),
  bounds: d.bounds_cm ? [pos(d.bounds_cm[0]), pos(d.bounds_cm[1])] : null,
  stats: d.stats,
  notes: d.notes,
  bin: { format: 'q16', gzip: true, count: n, origin, extent, scale, floats_per_instance: 6, ...index },
  env_meshes: [...env].sort(),
};
const dir = join(repo, 'public', 'data', 'stages');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${id}.json`), JSON.stringify(out));
writeFileSync(join(dir, `${id}.bin`), gz);
console.log(`${id}: ${d.centreline.length} road samples, ${n} instances, ${out.env_meshes.length} env meshes, ${out.fords.length} fords`);
if (Object.keys(thinned).length) console.log(`  thinned ${JSON.stringify(thinned)}`);
console.log(`  json ${(JSON.stringify(out).length / 1e3).toFixed(0)} kB, bin ${(gz.length / 1e6).toFixed(2)} MB (${(n * 24 / 1e6).toFixed(2)} MB as float32)`);
console.log(`ENV ${out.env_meshes.join(',')}`);
