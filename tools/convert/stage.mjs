#!/usr/bin/env node
// Convert a stage from the UE project's Content/Data/stages/<id>.json (handoff §4.2) into
//   public/data/stages/<id>.json: road, variants, features, crowds, tiles, bounds (three metres)
//   public/data/stages/<id>.bin:  instances as Float32 [x, y, z, rotY, scale, tint] per instance
// and print the env meshes the stage needs (for tools/blender/export_env_glb.py).
//
//   node tools/convert/stage.mjs finland [--ue ../BackroadRally]
//
// Axes: UE (X, Y, Z) cm -> three (X/100, Z/100, Y/100); UE yaw (deg) -> three rotation.y = -rad.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// instances and breakables into one binary, 6 floats each
const floats = [];
const index = {};
const pack = (group) => {
  const out = {};
  for (const [mesh, list] of Object.entries(group ?? {})) {
    out[mesh] = [floats.length / 6, list.length];
    for (const i of list) {
      const p = pos(i);
      floats.push(p[0], p[1], p[2], rotY(i[3]), i[4], i.length > 5 ? i[5] : 0.5);
    }
  }
  return out;
};
index.instances = pack(d.instances);
index.breakables = pack(d.breakables);

const crowdMeshes = runtime.crowd?.meshes ?? [];
const gantries = runtime.gantries ?? {};
const env = new Set([...Object.keys(d.instances ?? {}), ...Object.keys(d.breakables ?? {}), ...crowdMeshes,
  ...(gantries.start ? [gantries.start] : []), ...(gantries.finish ? [gantries.finish] : [])]);

const out = {
  id: d.id,
  name: d.name,
  location: d.location,
  surface: d.surface,
  length_m: d.length_m,
  road,
  variants: d.variants,
  features: (d.features ?? []).map((f) => ({ ...f, p: f.p ? pos(f.p) : undefined })),
  crowds: (d.crowds ?? []).map((c) => ({ ...c, p: pos(c.p), rotY: rotY(c.yaw ?? 0), radius: c.radius / 100 })),
  tiles: d.tiles.map((t) => ({ mesh: t.mesh, p: pos(t.pos) })),
  unique_meshes: (d.unique_meshes ?? []).map((u) => ({ mesh: u.mesh, p: pos(u.pos), rotY: rotY(u.yaw ?? 0), collision: u.collision ?? 'complex' })),
  water_level: d.water_level_cm != null ? r2(d.water_level_cm / 100) : null,
  bounds: d.bounds_cm ? [pos(d.bounds_cm[0]), pos(d.bounds_cm[1])] : null,
  stats: d.stats,
  bin: { floats_per_instance: 6, ...index },
  env_meshes: [...env].sort(),
};
const dir = join(repo, 'public', 'data', 'stages');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${id}.json`), JSON.stringify(out));
writeFileSync(join(dir, `${id}.bin`), Buffer.from(new Float32Array(floats).buffer));
const n = floats.length / 6;
console.log(`${id}: ${d.centreline.length} road samples, ${n} instances, ${out.env_meshes.length} env meshes`);
console.log(`  json ${(JSON.stringify(out).length / 1e3).toFixed(0)} kB, bin ${(floats.length * 4 / 1e6).toFixed(2)} MB`);
console.log(`ENV ${out.env_meshes.join(',')}`);
