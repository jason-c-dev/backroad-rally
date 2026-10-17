import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * A content hash for every file in public/ (data, stage and car GLBs, audio), built into the bundle as
 * __PUBLIC_HASHES__ and added to each runtime fetch as `?v=<hash>` (src/data.ts publicUrl). GitHub Pages caches every
 * file for 10 minutes; the page itself is checked again on a reload, its bundle is content-hashed by Vite, and so a
 * changed data file gets a new URL on the next reload while unchanged files stay cached. Dev serves without hashes.
 */
function publicHashes(dir = 'public'): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 10);
    }
  };
  walk(dir);
  return out;
}

/**
 * GitHub Pages compresses text only. The GLBs (meshopt-compressed geometry) still shrink by a quarter to a third under
 * gzip, the cars by 80%: the build replaces each dist/**\/*.glb with a .glb.gz that src/data.ts loadGlb unpacks.
 */
function gzipGlbs(): Plugin {
  let outDir = 'dist';
  return {
    name: 'gzip-glbs',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.glb')) {
            writeFileSync(`${p}.gz`, gzipSync(readFileSync(p), { level: 9 }));
            unlinkSync(p);
          }
        }
      };
      walk(outDir);
    },
  };
}

// GitHub Pages serves the site at /backroad-rally/; dev serves it at /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/backroad-rally/' : '/',
  define: { __PUBLIC_HASHES__: JSON.stringify(command === 'build' ? publicHashes() : {}), __GLB_GZ__: JSON.stringify(command === 'build') },
  plugins: [gzipGlbs()],
  build: {
    // the physics engine (its WebAssembly inlined, ~4 MB) and three.js in chunks of their own: they change only with
    // a dependency update, so a redeploy of the game's code leaves them in the browser's cache
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
}));
