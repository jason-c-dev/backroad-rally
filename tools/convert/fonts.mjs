#!/usr/bin/env node
// Copy the HUD's Inter faces (OFL 1.1) from the UE project into public/fonts/ as WOFF2, with the licence.
//
//   node tools/convert/fonts.mjs [--ue ../BackroadRally]     (or set BR_UE_ROOT; needs woff2_compress)
//
// woff2_compress writes next to its input, so the TTFs are copied to a temporary folder first:
// nothing is ever written inside the UE project.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argi = process.argv.indexOf('--ue');
const ue = resolve(argi > 0 ? process.argv[argi + 1] : process.env.BR_UE_ROOT ?? join(repo, '..', 'BackroadRally'));
const src = join(ue, 'Content', 'Rally', 'UI', 'Fonts');
const out = join(repo, 'public', 'fonts');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'br-fonts-'));
try {
  for (const face of ['Inter-Regular', 'Inter-SemiBold']) {
    copyFileSync(join(src, `${face}.ttf`), join(tmp, `${face}.ttf`));
    execFileSync('woff2_compress', [join(tmp, `${face}.ttf`)], { stdio: 'ignore' });
    copyFileSync(join(tmp, `${face}.woff2`), join(out, `${face}.woff2`));
    console.log(`${face}.woff2 ${statSync(join(out, `${face}.woff2`)).size} B`);
  }
  copyFileSync(join(src, 'OFL.txt'), join(out, 'OFL.txt'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
