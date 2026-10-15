#!/usr/bin/env node
// Copy the engine-neutral game data from the UE project into public/data/.
//
//   node tools/convert/data.mjs [--ue ../BackroadRally]     (or set BR_UE_ROOT)
//
// The JSON stays in UE units and axes (cm, X forward, Y right, Z up); src/ue.ts converts
// at load time. Comment keys (any key starting with "_") are dropped: they are design
// notes, not data. Output is minified.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argi = process.argv.indexOf('--ue');
const ue = resolve(argi > 0 ? process.argv[argi + 1] : process.env.BR_UE_ROOT ?? join(repo, '..', 'BackroadRally'));
const src = join(ue, 'Content', 'Data');
const out = join(repo, 'public', 'data');

if (!existsSync(src)) {
  console.error(`UE data not found: ${src} (pass --ue or set BR_UE_ROOT)`);
  process.exit(1);
}

// Grows slice by slice.
const FILES = [
  'testtrack.json',
  'camera.json',
  'cars_tuning.json',
  'input.json',
  'env_catalog.json',
  'stage_runtime.json',
  ...['swift', 'pip', 'lama', 'quint', 'kaze'].map((id) => `cars/${id}.json`),
];

// Public names must stay our own (the repo is public). Overrides for source names that
// refer to a real company, by file and path so the old name never appears here.
const OVERRIDES = { 'cars/kaze.json': { 'liveries.1.name': 'rally white' } };

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, strip(x)]));
  }
  return v;
}

function override(data, file) {
  for (const [path, value] of Object.entries(OVERRIDES[file] ?? {})) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], data)[last] = value;
  }
  return data;
}

let total = 0;
for (const f of FILES) {
  const data = override(strip(JSON.parse(readFileSync(join(src, f), 'utf8'))), f);
  const text = JSON.stringify(data);
  mkdirSync(dirname(join(out, f)), { recursive: true });
  writeFileSync(join(out, f), text + '\n');
  total += text.length;
  console.log(`${f.padEnd(22)} ${text.length} B`);
}
console.log(`${FILES.length} files, ${total} B -> public/data/`);
