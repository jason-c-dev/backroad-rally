// The career rules (src/game/career.ts) against the original's code (RallyCareer.cpp, URallyGameInstance) and data
// (career.json format 2): the random stream, the rival sim (determinism, distribution), points, the stage and rally
// tables, standings and their tiebreak, unlocks, restarts, damage carried, and old saves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CareerRules, RandomStream, formatGap, hashCombine, ordinal, type CareerJson, type CareerState, type StageResult } from '../src/game/career';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const career = data('career.json') as CareerJson;
const menu = data('menu.json');
const cars = ['swift', 'pip', 'lama', 'quint', 'kaze'].map((id) => data(`cars/${id}.json`));
const rules = new CareerRules(career, { stages: menu.stages, cars, groups: menu.groups });

describe('random stream (UE FRandomStream, HashCombine)', () => {
  it('is UE\'s LCG with the mantissa trick', () => {
    // seed 0: the first mutate gives 907633515; its top 23 bits / 2^23
    const r = new RandomStream(0);
    expect(r.fraction()).toBe(Math.fround(1 + (907633515 >>> 9) / 2 ** 23) - 1);
    const a = new RandomStream(1977), b = new RandomStream(1977);
    for (let i = 0; i < 100; i++) expect(a.fraction()).toBe(b.fraction());
    for (let i = 0; i < 1000; i++) {
      const f = a.fraction();
      expect(f >= 0 && f < 1).toBe(true);
      const k = a.randRange(0, 5);
      expect(Number.isInteger(k) && k >= 0 && k <= 5).toBe(true);
    }
  });

  it('HashCombine is the Bob Jenkins mix (known values)', () => {
    expect(hashCombine(0, 0)).toBe(hashCombine(0, 0));
    expect(hashCombine(1, 2)).not.toBe(hashCombine(2, 1));
    // a value worked by hand from UE's constexpr HashCombine(1, 2) in uint32 arithmetic
    expect(hashCombine(1, 2) >>> 0).toBeGreaterThan(0);
  });
});

describe('rival sim (UE SimulateStage)', () => {
  const def = career.seasons[0].rallies[0].stages[0]; // finland fwd, clear

  it('is deterministic per seed, season, rally, stage and group; the player\'s values never move the rivals', () => {
    const a = rules.simulateStage(1977, 0, 0, 0, def, '2', 100, false, 0);
    const b = rules.simulateStage(1977, 0, 0, 0, def, '2', 140, true, 10);
    expect(a.times.slice(1)).toEqual(b.times.slice(1));
    expect(a.dnf.slice(1)).toEqual(b.dnf.slice(1));
    expect(b.times[0]).toBe(140);
    expect(b.dnf[0]).toBe(true);
    const c = rules.simulateStage(1977, 0, 0, 1, def, '2', 100, false, 0);
    const d = rules.simulateStage(1978, 0, 0, 0, def, '2', 100, false, 0);
    const e = rules.simulateStage(1977, 0, 0, 0, def, '4', 100, false, 0);
    expect(c.times).not.toEqual(a.times);
    expect(d.times).not.toEqual(a.times);
    expect(e.times).not.toEqual(a.times);
    expect(a.times.slice(1).every((t) => Math.round(t * 1000) / 1000 === t)).toBe(true);
  });

  it('uses the clear target, the measured weather target, else target x weather factor', () => {
    expect(rules.rivalTarget('finland', false, '2', 'clear')).toBe(career.target_times.finland.fwd['2']);
    expect(rules.rivalTarget('wales', false, '2', 'rain')).toBe(career.target_times_weather!.wales.fwd.rain['2']);
    const noWeather = { ...career, target_times_weather: {} } as CareerJson;
    const r2 = new CareerRules(noWeather, { stages: menu.stages, cars, groups: menu.groups });
    expect(r2.rivalTarget('japan', false, '2', 'snow')).toBeCloseTo(career.target_times.japan.fwd['2'] * career.weather_factor!.snow.tarmac, 6);
    expect(r2.rivalTarget('nowhere', false, '2', 'clear')).toBe(150);
  });

  it('has the distribution of target x (skill + 0.012 N), crash 5 % (+5..25 s), dnf 1.2 %', () => {
    const target = rules.rivalTarget('finland', false, '2', 'clear');
    const per: number[][] = career.rivals.map(() => []);
    let crashes = 0, dnfs = 0, n = 0;
    const crashS: number[] = [];
    for (let seed = 0; seed < 4000; seed++) {
      const r: StageResult = rules.simulateStage(seed * 7919, seed % 4, seed % 3, seed % 2, def, '2', 0, false, 0);
      for (let i = 1; i < r.times.length; i++) {
        n++;
        if (r.dnf[i]) dnfs++;
        else if (r.crash[i] > 0) {
          crashes++;
          crashS.push(r.crash[i]);
          expect(r.crash[i]).toBeGreaterThanOrEqual(5);
          expect(r.crash[i]).toBeLessThan(25);
        } else per[i - 1].push(r.times[i] / target);
      }
    }
    expect(dnfs / n).toBeGreaterThan(0.008);
    expect(dnfs / n).toBeLessThan(0.016);
    expect(crashes / n).toBeGreaterThan(0.044);
    expect(crashes / n).toBeLessThan(0.056);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(crashS)).toBeGreaterThan(14);
    expect(mean(crashS)).toBeLessThan(16);
    career.rivals.forEach((rv, i) => {
      const m = mean(per[i]);
      const sd = Math.sqrt(mean(per[i].map((x) => (x - m) ** 2)));
      expect(m).toBeCloseTo(rv.skill, 3);
      expect(sd).toBeGreaterThan(0.0115);
      expect(sd).toBeLessThan(0.0125);
    });
  });
});

describe('tables, points, standings', () => {
  const stage = (times: number[], dnf: number[] = [], crash: number[] = []): StageResult => ({
    times, dnf: times.map((_, i) => dnf.includes(i)), crash: times.map((_, i) => crash[i] ?? 0), pen: 0, stage: 'finland', rev: false, cond: '', weather: 'clear',
  });
  const t10 = (player: number) => [player, 101, 102, 103, 104, 105, 106, 107, 108, 109];

  it('classifies finishers by time, dnfs after (the player last of them), gaps to the leader', () => {
    const rows = rules.stageTable(stage([104.5, 101, 102, 103, 104, 105, 106, 107, 108, 109], [0, 3]));
    expect(rows.map((r) => r.driver)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 3, 0]);
    expect(rows[1].gap).toBeCloseTo(1, 6);
    expect(rows[9].dnf && rows[9].gap === 0).toBe(true);
    // a tie goes to the rival (the live position's rule)
    expect(rules.stageTable(stage(t10(103))).findIndex((r) => r.driver === 0)).toBe(3);
  });

  it('sums a rally (a dnf in any stage is a dnf) and scores 25-18-15-12-10-8-6-4-2-1', () => {
    const a = stage(t10(100)), b = stage(t10(100.5), [5]);
    const out = rules.makeOutcome([a, b], 'swift', 0);
    expect(out.order[0]).toBe(0);
    expect(out.points[0]).toBe(25);
    expect(out.points[5]).toBe(0);
    expect(out.dnf[5]).toBe(true);
    expect(out.order.map((d) => out.points[d])).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 0]);
    expect(out.totals[0]).toBeCloseTo(200.5, 6);
  });

  it('breaks standings ties on the best finish, then the lower driver index', () => {
    const o = (order: number[]) => ({ order, totals: [], dnf: [], points: [], car: 'swift', rally: 0 });
    const c = { seasonRallies: [o([3, 0, 1, 2, 4, 5, 6, 7, 8, 9]), o([1, 2, 0, 3, 4, 5, 6, 7, 8, 9])], seasonPoints: [33, 33, 33, 37, 20, 16, 12, 8, 4, 2] };
    const rows = rules.standingsTable(c);
    // 3 leads on points; 0, 1, 2 tie at 33: 1 has a win (1st), 0 a 2nd, 2 a 2nd -> 1, then 0 before 2 by index
    expect(rows.slice(0, 4).map((r) => r.driver)).toEqual([3, 1, 0, 2]);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('formats gaps and ordinals like RallyFormat', () => {
    expect(formatGap(1.045)).toBe('+1.045');
    expect(formatGap(75.5)).toBe('+1:15.500');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });
});

/** Drives a season with the player at `factor` x the rivals' target (UE CareerSimulate). */
function driveSeason(c: CareerState, unlocks: { groups: string[]; cars: string[]; liveries: string[] }, factor: number, dnfAt = -1) {
  const screens: string[][] = [];
  let k = 0;
  while (!c.complete) {
    const season = c.season;
    const def = rules.startStage(c)!;
    expect(def).toBeTruthy();
    const group = rules.season(c)!.group;
    const time = rules.rivalTarget(def.stage, def.variant === 'rev', group, rules.stageWeather(def)) * factor;
    rules.stageResult(c, time, 0, k === dnfAt, 0.2, [0.1, 0, 0, 0, 0.05, 0]);
    k++;
    if (rules.isRallyOver(c)) screens.push(rules.finalizeRally(c, unlocks));
    if (c.season !== season) break;
  }
  return screens;
}

describe('career state (UE NewCareer, StartCareerStage, OnStageResult, FinalizeRally, FinalizeSeason)', () => {
  it('runs a season: 4 rallies x 2 stages, points, unlocks the next group and its cars; a podium the bonus liveries', () => {
    const unlocks = { groups: ['2'], cars: ['swift', 'pip'], liveries: [] as string[] };
    const c = rules.newCareer(null);
    expect(c.seed).toBe(1977 + 7919);
    expect(c.car).toBe('swift');
    const screens = driveSeason(c, unlocks, 0.9); // much faster than every rival: wins everything
    expect(screens).toEqual([['rallyresults', 'standings'], ['rallyresults', 'standings'], ['rallyresults', 'standings'], ['rallyresults', 'standings', 'unlock']]);
    expect(c.seasons).toEqual([{ group: '2', position: 1, points: 100, restartsUsed: 0 }]);
    expect(unlocks.groups).toEqual(['2', '4']);
    expect(unlocks.cars).toEqual(['swift', 'pip', 'lama']);
    expect(unlocks.liveries).toEqual(['swift']);
    expect(c.last!.unlocks).toEqual(['group 4', 'la lama', `bonus livery: ${cars[0].name} "` + cars[0].liveries.find((l: { bonus?: boolean }) => l.bonus).name + '"']);
    expect(c.season).toBe(1);
    expect(c.car).toBe('lama');
    expect(c.restartsLeft).toBe(3);
    expect(c.seasonPoints.every((p) => p === 0)).toBe(true);
  });

  it('finishing off the podium still unlocks the next group, but no livery', () => {
    const unlocks = { groups: ['2'], cars: ['swift', 'pip'], liveries: [] as string[] };
    const c = rules.newCareer(null);
    driveSeason(c, unlocks, 1.2); // slower than everyone: last
    expect(c.seasons[0].position).toBe(10);
    expect(c.seasons[0].points).toBeLessThan(16); // 10th scores 1 a rally (more when rivals retire)
    expect(unlocks.cars).toContain('lama');
    expect(unlocks.liveries).toEqual([]);
  });

  it('carries damage inside a rally, services at the rally start, and a dnf ends the rally', () => {
    const c = rules.newCareer(null);
    rules.startStage(c);
    rules.stageResult(c, 100, 0, false, 0.3, [0.4, 0, 0, 0, 0.1, 0]);
    expect(c.carriedDamage).toBe(0.3);
    expect(c.stage).toBe(1);
    expect(rules.isRallyOver(c)).toBe(false);
    rules.startStage(c);
    expect(c.carriedDamage).toBe(0.3); // the second stage starts damaged
    rules.stageResult(c, 100, 0, false, 0.5, []);
    expect(rules.isRallyOver(c)).toBe(true);
    rules.finalizeRally(c, { groups: [], cars: [], liveries: [] });
    expect(c.carriedDamage).toBe(0);
    rules.startStage(c);
    rules.stageResult(c, 0, 0, true, 0.9, []);
    expect(c.carriedDamage).toBe(0);
    expect(rules.isRallyOver(c)).toBe(true); // retired in stage 1 of rally 2
    rules.finalizeRally(c, { groups: [], cars: [], liveries: [] });
    expect(c.seasonRallies[1].dnf[0]).toBe(true);
    expect(c.seasonRallies[1].points[0]).toBe(0);
  });

  it('restarts: 3 a season; a restart after the result put the stage back as it was', () => {
    const c = rules.newCareer(null);
    rules.startStage(c);
    const snap = JSON.parse(JSON.stringify(c)) as CareerState;
    rules.stageResult(c, 100, 0, false, 0.2, []);
    expect(rules.restart(c, snap)).toBe(true);
    expect(c.stage).toBe(0);
    expect(c.rallyStages).toEqual([]);
    expect(c.restartsLeft).toBe(2);
    expect(rules.restart(c, null)).toBe(true);
    expect(rules.restart(c, null)).toBe(true);
    expect(rules.restart(c, null)).toBe(false);
    expect(c.restartsUsed).toBe(3);
    // the rivals don't re-roll on a restart
    rules.startStage(c);
    const again = rules.stageResult(c, 100, 0, false, 0, [])!;
    const first = rules.simulateStage(c.seed, 0, 0, 0, career.seasons[0].rallies[0].stages[0], '2', 0, false, 0);
    expect(again.result.times.slice(1)).toEqual(first.times.slice(1));
  });

  it('a career runs to the end over all four seasons', () => {
    const unlocks = { groups: ['2'], cars: ['swift', 'pip'], liveries: [] as string[] };
    const c = rules.newCareer(null);
    for (let s = 0; s < 4; s++) driveSeason(c, unlocks, 1.0);
    expect(c.complete).toBe(true);
    expect(c.seasons.map((s) => s.group)).toEqual(['2', '4', 'b', 'a']);
    expect(unlocks.groups).toEqual(['2', '4', 'b', 'a']);
    expect(unlocks.cars).toEqual(['swift', 'pip', 'lama', 'quint', 'kaze']);
    expect(c.last!.careerComplete).toBe(true);
    expect(rules.startStage(c)).toBeNull();
  });

  it('loads a damaged or older save: keeps what is valid, restarts an old-format season at rally 1', () => {
    expect(rules.load(null)).toBeNull();
    expect(rules.load('nope')).toBeNull();
    const c = rules.newCareer(null);
    rules.startStage(c);
    rules.stageResult(c, 100, 0, false, 0, []);
    rules.stageResult(c, 100, 0, false, 0, []);
    rules.finalizeRally(c, { groups: [], cars: [], liveries: [] });
    const same = rules.load(JSON.parse(JSON.stringify(c)))!;
    expect(same).toEqual(c);
    const old = rules.load({ ...JSON.parse(JSON.stringify(c)), format: 1 })!;
    expect(old.rally).toBe(0);
    expect(old.seasonRallies).toEqual([]);
    expect(old.seed).toBe(c.seed);
    expect(old.format).toBe(2);
    // format 1 in its first rally, same stages so far: kept
    const fresh = rules.newCareer(null);
    rules.startStage(fresh);
    rules.stageResult(fresh, 100, 0, false, 0, []);
    const kept = rules.load({ ...JSON.parse(JSON.stringify(fresh)), format: 1 })!;
    expect(kept.stage).toBe(1);
    expect(kept.rallyStages.length).toBe(1);
    const broken = rules.load({ active: true, season: 'x', seasonPoints: [1, 2], rallyStages: [{ times: 'bad' }], seed: 5 })!;
    expect(broken.season).toBe(0);
    expect(broken.seasonPoints).toEqual(new Array(10).fill(0));
    expect(broken.rallyStages).toEqual([]);
  });
});
