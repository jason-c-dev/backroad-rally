#!/usr/bin/env node
// Cache-busting check: build twice into a temporary folder, the second time with one public file changed (a space
// appended, then restored), and compare the `?v=` hashes the two bundles carry. The changed file must get a new
// hash, every other file must keep its own, and the index.html must point at a new bundle.
//
//   node tools/check/cachebust.mjs [--file data/fx.json] [--out /tmp/dir]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const file = arg('--file', 'data/fx.json');
const out = arg('--out', mkdtempSync(join(tmpdir(), 'cachebust-')));
const src = join('public', file);

const build = (dir) => {
  execFileSync('npx', ['vite', 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'error'], { stdio: 'inherit' });
  const js = readdirSync(join(dir, 'assets')).filter((f) => /^index-.*\.js$/.test(f));
  const bundle = readFileSync(join(dir, 'assets', js[0]), 'utf8');
  // the define is an object literal: "data/fx.json":`0123456789` (the minifier picks the quotes)
  const hashes = Object.fromEntries([...bundle.matchAll(/["'`]((?:data|assets|audio|fonts)\/[^"'`]+)["'`]:["'`]([0-9a-f]{10})["'`]/g)].map((m) => [m[1], m[2]]));
  return { js: js[0], hashes };
};

const original = readFileSync(src);
let a, b;
try {
  a = build(join(out, 'a'));
  writeFileSync(src, Buffer.concat([original, Buffer.from(' ')]));
  b = build(join(out, 'b'));
} finally {
  writeFileSync(src, original);
}
const changed = Object.keys(a.hashes).filter((k) => a.hashes[k] !== b.hashes[k]);
console.log(`files hashed: ${Object.keys(a.hashes).length}`);
console.log(`${file}: ${a.hashes[file]} -> ${b.hashes[file]}`);
console.log(`bundle: ${a.js} -> ${b.js}`);
console.log(`files whose hash changed: ${changed.join(', ') || 'none'}`);
const ok = a.hashes[file] && a.hashes[file] !== b.hashes[file] && changed.length === 1 && a.js !== b.js;
console.log(ok ? 'PASS: the changed file gets a new URL, the rest keep theirs' : 'FAIL');
rmSync(out, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
