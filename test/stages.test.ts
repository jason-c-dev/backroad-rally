// The six converted stages (tools/convert/stage.mjs): every instance table decodes to its count, lies
// on the stage, uses meshes the catalog and the stage's env GLB list know, and the location features
// the runtime reads are there (the wales ford, white-tinted animals, thinned trees).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeInstances } from '../src/world/instanceTable';
import type { StageJson, CatalogEntry } from '../src/world/stage';

const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
const json = <T>(f: string) => JSON.parse(readFileSync(pub(f), 'utf8')) as T;
const catalog = json<Record<string, CatalogEntry>>('data/env_catalog.json');
const runtime = json<{ features: { white_tint: Record<string, string[]> } }>('data/stage_runtime.json');
const STAGES = ['finland', 'japan', 'alps', 'wales', 'arizona', 'vermont'];

describe.each(STAGES)('stage %s', (id) => {
  const st = json<StageJson>(`data/stages/${id}.json`);
  it('decodes the instance table onto the stage', async () => {
    const buf = readFileSync(pub(`data/stages/${id}.bin`));
    const bin = await decodeInstances(st.bin, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(bin.length).toBe(st.bin.count! * 6);
    const [lo, hi] = st.bounds!;
    for (let i = 0; i < bin.length; i += 6) {
      expect(bin[i]).toBeGreaterThan(lo[0] - 300);
      expect(bin[i]).toBeLessThan(hi[0] + 300);
      expect(bin[i + 2]).toBeGreaterThan(lo[2] - 300);
      expect(bin[i + 2]).toBeLessThan(hi[2] + 300);
      expect(Math.abs(bin[i + 3])).toBeLessThanOrEqual(Math.PI + 1e-6);
      expect(bin[i + 4]).toBeGreaterThan(0);
    }
    const tables = [...Object.values(st.bin.instances), ...Object.values(st.bin.breakables)];
    expect(tables.reduce((n, [, c]) => n + c, 0)).toBe(st.bin.count);
  });
  it('knows every mesh it places', () => {
    for (const key of [...Object.keys(st.bin.instances), ...Object.keys(st.bin.breakables)]) {
      const [mesh, k] = key.split('~');
      expect(catalog[mesh], mesh).toBeDefined();
      expect(st.env_meshes).toContain(mesh);
      if (k !== undefined) expect(runtime.features.white_tint[mesh]?.[Number(k)], key).toBeDefined();
    }
  });
});

describe('location features', () => {
  it('wales has its ford on the road, under water', () => {
    const st = json<StageJson>('data/stages/wales.json');
    expect(st.fords).toHaveLength(1);
    const f = st.fords![0];
    expect(f.s1).toBeGreaterThan(f.s0);
    // the road dips below the water surface inside the ford
    const i = st.road.s.findIndex((s) => s >= (f.s0 + f.s1) / 2);
    expect(st.road.p[i * 3 + 1]).toBeLessThan(f.water + 0.1);
  });
  it('cows and sheep take their coat colours', () => {
    expect(Object.keys(json<StageJson>('data/stages/alps.json').bin.instances).filter((k) => k.startsWith('SM_Cow_A~')).length).toBeGreaterThan(2);
    expect(Object.keys(json<StageJson>('data/stages/wales.json').bin.instances).filter((k) => k.startsWith('SM_Sheep_A~')).length).toBeGreaterThan(2);
  });
});
