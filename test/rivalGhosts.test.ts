// The rival ghosts (src/game/ghosts.ts) against the original's ARallyRivalGhosts: the time warp crosses the line on the
// simulated time, a crash stops the ghost for its seconds, a dnf stops it; the lateral slot stays on the road; the
// quick-stage picks; the live position agrees with the results table.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CareerRules, type CareerJson } from '../src/game/career';
import { fromBase64, indexAtProgress, maxProgress, unpack } from '../src/game/ghostCodec';
import { buildWarp, careerRivals, quickRivals, refTimeAt, rivalTimeAtIndex, type RefLine, type RivalCfg } from '../src/game/ghosts';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const career = data('career.json') as CareerJson;
const menu = data('menu.json');
const cars = ['swift', 'pip', 'lama', 'quint', 'kaze'].map((id) => data(`cars/${id}.json`));
const rules = new CareerRules(career, { stages: menu.stages, cars, groups: menu.groups });
const cfg = data('hud.json').rival_ghosts as RivalCfg;

async function line(key: string): Promise<RefLine> {
  const j = data(`rival_lines/${key}.json`);
  const s = (await unpack(fromBase64(j.packed)!, j.raw_bytes, j.num))!;
  const n = s.length;
  return {
    stage: j.stage, rev: j.dir === 'rev', car: j.car, hz: j.hz, finishTime: j.time, runLengthM: j.run_length_m, s, maxProg: maxProgress(s),
    rx: new Float32Array(n).fill(0), rz: new Float32Array(n).fill(1), lat: new Float32Array(n), half: new Float32Array(n).fill(3.5),
  };
}

/** The rival's clock when it reaches the run length (the finish line). */
const crossing = (L: RefLine, w: ReturnType<typeof buildWarp>) => rivalTimeAtIndex(w, indexAtProgress(L.maxProg, L.runLengthM - 0.01));

describe('rival ghosts: the time warp (UE BuildWarp)', () => {
  it('crosses the finish on the simulated time, whatever the pace profile', async () => {
    const L = await line('finland_fwd');
    for (const [driver, time] of [[1, 104.2], [5, 109.6], [9, 116.9]]) {
      const w = buildWarp(L, cfg, { driver, name: '', time, dnf: false, crash: 0 }, 0, 9);
      expect(Math.abs(crossing(L, w) - time)).toBeLessThan(0.02);
      // the pace wanders ±4.5 % around the line's own (sector to sector)
      const rates: number[] = [];
      for (let i = 30; i < L.s.length - 30; i += 15) rates.push((w.tau[i + 15] - w.tau[i]) / 1);
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      expect(Math.max(...rates) / mean).toBeLessThan(1.1);
      expect(Math.min(...rates) / mean).toBeGreaterThan(0.9);
    }
  });

  it('a crash stops the ghost for the crash seconds mid-stage and still finishes on time; a dnf stops it for good', async () => {
    const L = await line('alps_rev');
    const w = buildWarp(L, cfg, { driver: 3, name: '', time: 140, dnf: false, crash: 12 }, 1, 9);
    expect(w.stopTau).toBeGreaterThan(0);
    expect(w.stopLen).toBe(12);
    expect(Math.abs(crossing(L, w) - 140)).toBeLessThan(0.02);
    // stopped: the reference time holds for 12 s
    expect(refTimeAt(w, w.stopTau + 1, L.hz)).toBeCloseTo(refTimeAt(w, w.stopTau + 11, L.hz), 5);
    expect(refTimeAt(w, w.stopTau + 13, L.hz)).toBeGreaterThan(refTimeAt(w, w.stopTau + 11, L.hz));
    const d = buildWarp(L, cfg, { driver: 4, name: '', time: 130, dnf: true, crash: 0 }, 2, 9);
    expect(d.retireTau).toBeGreaterThan(0);
    expect(d.retireProg).toBeLessThan(L.runLengthM);
    expect(refTimeAt(d, d.retireTau + 50, L.hz)).toBeCloseTo(refTimeAt(d, d.retireTau, L.hz), 5);
  });

  it('keeps every ghost in its slot (±120 cm plus a 35 cm weave) inside the road', async () => {
    const L = await line('wales_fwd');
    const offs = Array.from({ length: 9 }, (_, k) => buildWarp(L, cfg, { driver: k + 1, name: '', time: 110, dnf: false, crash: 0 }, k, 9).off);
    for (const o of offs) {
      for (let i = 0; i < o.length; i++) expect(Math.abs(L.lat[i] + o[i])).toBeLessThanOrEqual(3.5 - 1.2 + 1e-3);
    }
    const mid = Math.floor(L.s.length / 2);
    const at = offs.map((o) => o[mid]);
    expect(Math.max(...at) - Math.min(...at)).toBeGreaterThan(1.6); // spread across the road
    expect(Math.max(...at.map(Math.abs))).toBeLessThanOrEqual(1.2 + 0.35 + 1e-3);
  });

  it('is the same for the same rival, stage and direction (no re-roll on a restart)', async () => {
    const L = await line('japan_fwd');
    const a = buildWarp(L, cfg, { driver: 2, name: '', time: 120, dnf: false, crash: 0 }, 3, 9);
    const b = buildWarp(L, cfg, { driver: 2, name: '', time: 120, dnf: false, crash: 0 }, 3, 9);
    expect(a.tau).toEqual(b.tau);
    expect(a.off).toEqual(b.off);
  });
});

describe('rival ghosts: who races (UE PickRivals)', () => {
  it('quick stage: 3 = the 2 closest faster rivals and the closest slower one; all = nine', () => {
    const all = quickRivals(rules, 'finland', false, '2', 'clear', 99, 0);
    expect(all.map((r) => r.driver)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const sorted = [...all].sort((a, b) => a.time - b.time);
    const best = (sorted[4].time + sorted[5].time) / 2;
    const three = quickRivals(rules, 'finland', false, '2', 'clear', 3, best);
    const want = [sorted[3], sorted[4], sorted[5]].map((r) => r.driver).sort((a, b) => a - b);
    expect(three.map((r) => r.driver)).toEqual(want);
    // no best time yet: spread over the middle of the field
    const mid = quickRivals(rules, 'finland', false, '2', 'clear', 3, 0);
    expect(mid.length).toBe(3);
    expect(new Set(mid.map((r) => r.driver)).size).toBe(3);
    // faster than everyone: the three closest slower
    const fast = quickRivals(rules, 'finland', false, '2', 'clear', 3, 1);
    expect(fast.map((r) => r.driver).sort()).toEqual(sorted.slice(0, 3).map((r) => r.driver).sort());
    // deterministic per stage, direction, group and weather
    expect(quickRivals(rules, 'finland', false, '2', 'clear', 99, 0)).toEqual(all);
    expect(quickRivals(rules, 'finland', true, '2', 'clear', 99, 0)).not.toEqual(all);
  });

  it('career: the same times as the results (the rival sim), so the live position matches the table', async () => {
    const def = career.seasons[0].rallies[0].stages[0];
    const sim = rules.simulateStage(1234, 0, 0, 0, def, '2', 0, false, 0);
    const picks = careerRivals(rules, sim);
    expect(picks.map((p) => p.time)).toEqual(sim.times.slice(1));
    // the finish rule (UE UpdatePosition, finished): rivals not retired with a time <= yours are ahead
    for (const mine of [90, sim.times[3], 105, 112, 200]) {
      const ahead = picks.filter((r) => !r.dnf && r.time <= mine).length;
      const table = rules.stageTable({ ...rules.simulateStage(1234, 0, 0, 0, def, '2', mine, false, 0) });
      expect(table.findIndex((r) => r.driver === 0) + 1).toBe(ahead + 1);
    }
  });
});
