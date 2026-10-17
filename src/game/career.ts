// The career (handoff §11.2; the original's RallyCareer.cpp + URallyGameInstance): career.json format 2, four seasons
// (groups 2 / 4 / b / a), four rallies of two stages each (forward, then reverse), the condition and weather fixed per
// stage. Pure rules and state here; the menus (src/menu/careerScreens.ts) and the stage page (src/main.ts) drive it.
//
//   service      at each rally start (full repair); damage carries between a rally's stages
//   restarts     3 per season; a restart after the result was saved puts the stage back (snapshot)
//   auto-save    after every stage (the caller writes the save)
//   rival sim    9 rivals, time = target x (skill + 0.012 N(0,1)), crash 5 % (+5..25 s), dnf 1.2 %, seeded by the
//                career seed, season, rally, stage and group, so a restart never re-rolls the rivals
//   targets      target_times[stage][dir][group] in clear weather; target_times_weather[stage][dir][weather][group]
//                where measured, else target x weather_factor[weather][surface]
//   points       25-18-15-12-10-8-6-4-2-1; a dnf scores nothing
//   standings    points, then the better best finish, then the lower driver index (the player is driver 0)
//   unlocks      a finished season unlocks the next group and its cars; a season podium unlocks the bonus livery
//                of every car driven that season
//
// The random stream is a port of UE's FRandomStream (an LCG) and HashCombine; the original hashed the group's FName,
// which depends on the engine's name table, so the group is hashed here with FNV-1a. Any deterministic stream would
// do; this one keeps the original's structure.

// ------------------------------------------------------------------ data (career.json)

export interface CareerStageDef {
  stage: string;
  variant: string;
  condition: string;
  weather?: string;
}

export interface CareerRallyDef {
  name: string;
  location: string;
  stages: CareerStageDef[];
}

export interface CareerSeasonDef {
  group: string;
  name: string;
  era: string;
  year: number;
  cars: string[];
  unlock_group: string;
  unlock_cars: string[];
  rallies: CareerRallyDef[];
}

export interface RivalDef {
  name: string;
  nation: string;
  skill: number;
}

export interface CareerJson {
  format: number;
  points: number[];
  restarts_per_season: number;
  damage_level: number;
  start_groups: string[];
  start_cars: string[];
  rival_sim: { noise_sigma: number; crash_chance: number; crash_s: [number, number]; dnf_chance: number };
  rivals: RivalDef[];
  target_times: Record<string, Record<string, Record<string, number>>>;
  target_times_weather?: Record<string, Record<string, Record<string, Record<string, number>>>>;
  weather_factor?: Record<string, Record<string, number>>;
  seasons: CareerSeasonDef[];
}

/** What the rules need beyond career.json: the menus' stage list (surface, km), the cars, the group names. */
export interface CareerWorld {
  stages: { id: string; name: string; location: string; surface: string; km_fwd: number; km_rev: number }[];
  cars: { id: string; name: string; group: string; liveries: { name: string; bonus?: boolean }[] }[];
  groups: { id: string; name: string; era?: string }[];
  /** weather.json stage defaults: the weather of a career stage without its own. */
  defaultWeather?: (stage: string, reverse: boolean) => string;
}

// ------------------------------------------------------------------ the random stream (UE FRandomStream)

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

export class RandomStream {
  seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  private mutate(): void {
    this.seed = (Math.imul(this.seed, 196314165) + 907633515) >>> 0;
  }
  /** [0, 1): the mantissa bits of the next seed, exactly as UE's GetFraction. */
  fraction(): number {
    this.mutate();
    U32[0] = 0x3f800000 | (this.seed >>> 9);
    return F32[0] - 1;
  }
  frandRange(min: number, max: number): number {
    return min + (max - min) * this.fraction();
  }
  /** Integer in [min, max] (UE RandRange). */
  randRange(min: number, max: number): number {
    const range = max - min + 1;
    return min + (range > 0 ? Math.trunc(this.fraction() * range) : 0);
  }
  /** Box-Muller normal, as the original draws it (u1 clamped above 1e-6). */
  normal(): number {
    const u1 = Math.max(1e-6, this.fraction());
    const u2 = this.fraction();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

/** UE HashCombine (uint32). */
export function hashCombine(a: number, c: number): number {
  let A = a >>> 0, B = 0x9e3779b9, C = c >>> 0;
  A = (A + B) >>> 0;
  A = (A - B) >>> 0; A = (A - C) >>> 0; A = (A ^ (C >>> 13)) >>> 0;
  B = (B - C) >>> 0; B = (B - A) >>> 0; B = (B ^ (A << 8)) >>> 0;
  C = (C - A) >>> 0; C = (C - B) >>> 0; C = (C ^ (B >>> 13)) >>> 0;
  A = (A - B) >>> 0; A = (A - C) >>> 0; A = (A ^ (C >>> 12)) >>> 0;
  B = (B - C) >>> 0; B = (B - A) >>> 0; B = (B ^ (A << 16)) >>> 0;
  C = (C - A) >>> 0; C = (C - B) >>> 0; C = (C ^ (B >>> 5)) >>> 0;
  A = (A - B) >>> 0; A = (A - C) >>> 0; A = (A ^ (C >>> 3)) >>> 0;
  B = (B - C) >>> 0; B = (B - A) >>> 0; B = (B ^ (A << 10)) >>> 0;
  C = (C - A) >>> 0; C = (C - B) >>> 0; C = (C ^ (B >>> 15)) >>> 0;
  return C;
}

/** A string's hash (FNV-1a): the port's stand-in for GetTypeHash(FName). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

// ------------------------------------------------------------------ results

/** One stage of a career rally: every driver's time (index 0 = the player, 1..9 = the rivals). */
export interface StageResult {
  /** Stage time with penalties (s); meaningless where dnf is set. */
  times: number[];
  dnf: boolean[];
  /** A rival's crash delay this stage (s, 0 = clean). */
  crash: number[];
  pen: number;
  stage: string;
  rev: boolean;
  cond: string;
  weather: string;
}

/** A finished rally: the classification and the points. */
export interface RallyOutcome {
  /** Driver indices in finishing order (dnf last). */
  order: number[];
  totals: number[];
  dnf: boolean[];
  points: number[];
  car: string;
  rally: number;
}

export interface SeasonOutcome {
  group: string;
  /** 1-based. */
  position: number;
  points: number;
  restartsUsed: number;
}

/** One row of a results table (stage, rally, standings). */
export interface TableRow {
  driver: number;
  position: number;
  name: string;
  /** Stage or rally time (s); in standings the best finish. */
  time: number;
  gap: number;
  dnf: boolean;
  crash: number;
  points: number;
}

/** What the menus show after a rally (the original's LastRally*, LastStandings, LastSeason, LastUnlocks). */
export interface LastRally {
  rallyName: string;
  seasonName: string;
  location: string;
  car: string;
  livery: number;
  rows: TableRow[];
  standings: TableRow[];
  /** "after 2 of 4 rallies" when not complete. */
  ralliesDone: number;
  ralliesTotal: number;
  seasonComplete: boolean;
  season: SeasonOutcome | null;
  /** "group 4", "la lama", 'bonus livery: the swift "..."'. */
  unlocks: string[];
  unlockCars: string[];
  careerComplete: boolean;
}

/** The career in progress (the original's FRallyCareerState), kept in the save's career slot. */
export interface CareerState {
  /** career.json format the career was made with. */
  format: number;
  active: boolean;
  complete: boolean;
  season: number;
  rally: number;
  /** The next stage to drive in the rally. */
  stage: number;
  restartsLeft: number;
  restartsUsed: number;
  car: string;
  livery: number;
  /** Damage 0..1 carried from the rally's previous stage, and per part (damage.ts PARTS order). */
  carriedDamage: number;
  carriedParts: number[];
  rallyStages: StageResult[];
  seasonRallies: RallyOutcome[];
  seasonPoints: number[];
  seasonCars: string[];
  seasons: SeasonOutcome[];
  /** Rival-sim seed, fixed per career (a new career adds 7919). */
  seed: number;
  /** The last finished rally, for the result screens. */
  last: LastRally | null;
}

// ------------------------------------------------------------------ the rules

export class CareerRules {
  readonly points: number[];
  readonly restartsPerSeason: number;
  readonly damageLevel: number;
  readonly sim: CareerJson['rival_sim'];

  constructor(readonly json: CareerJson, readonly world: CareerWorld) {
    this.points = json.points?.length ? json.points : [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
    this.restartsPerSeason = json.restarts_per_season ?? 3;
    this.damageLevel = json.damage_level ?? 1;
    const sim: Partial<CareerJson['rival_sim']> = json.rival_sim ?? {};
    this.sim = { noise_sigma: sim.noise_sigma ?? 0.012, crash_chance: sim.crash_chance ?? 0.05, crash_s: sim.crash_s ?? [5, 25], dnf_chance: sim.dnf_chance ?? 0.01 };
  }

  get seasons(): CareerSeasonDef[] {
    return this.json.seasons;
  }
  get rivals(): RivalDef[] {
    return this.json.rivals;
  }
  get fieldSize(): number {
    return this.rivals.length + 1;
  }
  get format(): number {
    return this.json.format ?? 1;
  }

  driverName(i: number): string {
    return i === 0 ? 'you' : this.rivals[i - 1]?.name ?? 'rival';
  }
  stageMeta(id: string) {
    return this.world.stages.find((s) => s.id === id);
  }
  carName(id: string): string {
    return this.world.cars.find((c) => c.id === id)?.name ?? id;
  }
  carGroup(id: string): string {
    return this.world.cars.find((c) => c.id === id)?.group ?? '2';
  }
  groupName(id: string): string {
    return this.world.groups.find((g) => g.id === id)?.name ?? `group ${id}`;
  }
  stageWeather(d: CareerStageDef): string {
    return d.weather || this.world.defaultWeather?.(d.stage, isRev(d.variant)) || 'clear';
  }

  /** Clear-weather target (target_times; 150 s per 3 km without one). */
  targetTime(stage: string, rev: boolean, group: string): number {
    const t = this.json.target_times?.[stage]?.[rev ? 'rev' : 'fwd']?.[group];
    if (typeof t === 'number') return t;
    const m = this.stageMeta(stage);
    return (150 * (m ? (rev ? m.km_rev : m.km_fwd) : 3)) / 3;
  }

  weatherFactor(weather: string, stage: string): number {
    const surface = (this.stageMeta(stage)?.surface ?? 'gravel').toLowerCase();
    return this.json.weather_factor?.[weather]?.[surface] ?? 1;
  }

  /** The rivals' reference time in a weather (UE RivalTarget). */
  rivalTarget(stage: string, rev: boolean, group: string, weather: string): number {
    if (weather && weather !== 'clear') {
      const t = this.json.target_times_weather?.[stage]?.[rev ? 'rev' : 'fwd']?.[weather]?.[group];
      if (typeof t === 'number') return t;
    }
    return this.targetTime(stage, rev, group) * this.weatherFactor(weather, stage);
  }

  /** Rival times for one career stage; the player's time and dnf go into index 0 (UE SimulateStage). */
  simulateStage(seed: number, season: number, rally: number, stageIndex: number, def: CareerStageDef, group: string,
    playerTime: number, playerDnf: boolean, playerPen: number): StageResult {
    const n = this.fieldSize;
    const weather = this.stageWeather(def);
    const rev = isRev(def.variant);
    const r: StageResult = {
      times: new Array(n).fill(0), dnf: new Array(n).fill(false), crash: new Array(n).fill(0), pen: playerPen,
      stage: def.stage, rev, cond: def.condition, weather,
    };
    r.times[0] = playerTime;
    r.dnf[0] = playerDnf;
    const target = this.rivalTarget(def.stage, rev, group, weather);
    const rng = new RandomStream(hashCombine(hashCombine(seed >>> 0, (season * 100 + rally * 10 + stageIndex) >>> 0), hashStr(group)));
    const S = this.sim;
    for (let i = 1; i < n; i++) {
      const normal = rng.normal();
      let t = target * (this.rivals[i - 1].skill + S.noise_sigma * normal);
      const roll = rng.fraction();
      if (roll < S.dnf_chance) r.dnf[i] = true;
      else if (roll < S.dnf_chance + S.crash_chance) {
        r.crash[i] = rng.frandRange(S.crash_s[0], S.crash_s[1]);
        t += r.crash[i];
      }
      r.times[i] = Math.round(t * 1000) / 1000;
    }
    return r;
  }

  /** Stage classification: finishers by time, then the dnfs (the player last among them). */
  stageTable(r: StageResult): TableRow[] {
    const rows: TableRow[] = r.times.map((time, i) => ({
      driver: i, position: 0, name: this.driverName(i), time, gap: 0, dnf: !!r.dnf[i], crash: r.crash[i] ?? 0, points: 0,
    }));
    rows.sort((a, b) => {
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      if (a.dnf) return b.driver - a.driver;
      // UE's sort compares times only; ties keep no defined order there: the rival first, as the live position does
      return a.time - b.time || b.driver - a.driver;
    });
    const lead = rows.length && !rows[0].dnf ? rows[0].time : 0;
    rows.forEach((row, i) => {
      row.position = i + 1;
      row.gap = row.dnf ? 0 : row.time - lead;
    });
    return rows;
  }

  /** Rally classification over the stages so far (a dnf in any stage is a dnf). */
  rallyTable(stages: StageResult[]): TableRow[] {
    const n = this.fieldSize;
    const sum: StageResult = { times: new Array(n).fill(0), dnf: new Array(n).fill(false), crash: new Array(n).fill(0), pen: 0, stage: '', rev: false, cond: '', weather: '' };
    for (const s of stages) {
      for (let i = 0; i < n && i < s.times.length; i++) {
        sum.times[i] += s.times[i];
        sum.dnf[i] = sum.dnf[i] || !!s.dnf[i];
        sum.crash[i] += s.crash[i] ?? 0;
      }
    }
    return this.stageTable(sum);
  }

  makeOutcome(stages: StageResult[], car: string, rally: number): RallyOutcome {
    const n = this.fieldSize;
    const o: RallyOutcome = { order: [], totals: new Array(n).fill(0), dnf: new Array(n).fill(false), points: new Array(n).fill(0), car, rally };
    for (const row of this.rallyTable(stages)) {
      o.order.push(row.driver);
      o.totals[row.driver] = row.time;
      o.dnf[row.driver] = row.dnf;
      o.points[row.driver] = !row.dnf ? this.points[row.position - 1] ?? 0 : 0;
    }
    return o;
  }

  /** Season standings: points, then the better best finish, then the lower driver index. */
  standingsTable(c: Pick<CareerState, 'seasonRallies' | 'seasonPoints'>): TableRow[] {
    const n = this.fieldSize;
    const best = new Array(n).fill(99);
    for (const o of c.seasonRallies) o.order.forEach((d, p) => d < n && (best[d] = Math.min(best[d], p + 1)));
    const rows: TableRow[] = Array.from({ length: n }, (_, i) => ({
      driver: i, position: 0, name: this.driverName(i), time: best[i], gap: 0, dnf: false, crash: 0, points: c.seasonPoints[i] ?? 0,
    }));
    rows.sort((a, b) => b.points - a.points || a.time - b.time || a.driver - b.driver);
    rows.forEach((r, i) => (r.position = i + 1));
    return rows;
  }

  // ------------------------------------------------------------------ the career state

  fresh(seed = 1977): CareerState {
    return {
      format: this.format, active: false, complete: false, season: 0, rally: 0, stage: 0, restartsLeft: this.restartsPerSeason, restartsUsed: 0,
      car: '', livery: 0, carriedDamage: 0, carriedParts: [], rallyStages: [], seasonRallies: [], seasonPoints: new Array(this.fieldSize).fill(0),
      seasonCars: [], seasons: [], seed, last: null,
    };
  }

  /** A new career (the seed moves on, so a new career gets new rivals' luck); unlocks and best times stay. */
  newCareer(old: CareerState | null): CareerState {
    const c = this.fresh(((old?.seed ?? 1977) + 7919) | 0);
    c.active = true;
    c.car = this.seasons[0]?.cars[0] ?? '';
    return c;
  }

  season(c: CareerState): CareerSeasonDef | undefined {
    return this.seasons[c.season];
  }
  rallyDef(c: CareerState): CareerRallyDef | undefined {
    return this.season(c)?.rallies[c.rally];
  }
  stageDef(c: CareerState): CareerStageDef | undefined {
    return this.rallyDef(c)?.stages[c.stage];
  }

  /** The current rally has no stage left to drive (all driven, or the player retired): its results are due. */
  isRallyOver(c: CareerState): boolean {
    const r = this.rallyDef(c);
    if (!r) return false;
    return c.stage >= r.stages.length || c.rallyStages.some((s) => s.dnf[0]);
  }

  /**
   * The next stage starts (UE StartCareerStage): service at the rally start, the car checked against the season.
   * Returns the stage, or null when there's none to drive.
   */
  startStage(c: CareerState): CareerStageDef | null {
    const season = this.season(c);
    const def = this.stageDef(c);
    if (!c.active || !season || !def || this.isRallyOver(c)) return null;
    if (c.stage === 0) {
      c.carriedDamage = 0;
      c.carriedParts = [];
      c.rallyStages = [];
    }
    if (!c.car || !season.cars.includes(c.car)) c.car = season.cars[0] ?? 'swift';
    return def;
  }

  /** A stage result (UE OnStageResult): the rival sim, the stage added, damage carried, the next stage. */
  stageResult(c: CareerState, total: number, pen: number, dnf: boolean, damage: number, parts: number[]): { result: StageResult; index: number; count: number } | null {
    const season = this.season(c), rally = this.rallyDef(c), def = this.stageDef(c);
    if (!season || !rally || !def) return null;
    const r = this.simulateStage(c.seed, c.season, c.rally, c.stage, def, season.group, total, dnf, pen);
    c.rallyStages.push(r);
    c.carriedDamage = dnf ? 0 : Math.min(Math.max(damage, 0), 0.99);
    c.carriedParts = dnf ? [] : parts.map((p) => Math.min(Math.max(p, 0), 1));
    const index = c.stage;
    c.stage++;
    return { result: r, index, count: rally.stages.length };
  }

  /** Uses a restart (none left: false). `snapshot` = the career at the stage start, when its result was already saved. */
  restart(c: CareerState, snapshot: CareerState | null): boolean {
    if (c.restartsLeft <= 0) return false;
    if (snapshot) Object.assign(c, clone(snapshot));
    c.restartsLeft--;
    c.restartsUsed++;
    return true;
  }

  /**
   * Points, standings, the next rally; the season's end after its last rally (UE FinalizeRally + FinalizeSeason).
   * Returns the screens to show: rally results, standings, and the unlock card at a season's end.
   */
  finalizeRally(c: CareerState, unlocks: { groups: string[]; cars: string[]; liveries: string[] }): string[] {
    const season = this.season(c), rally = this.rallyDef(c);
    if (!season || !rally) return [];
    const n = this.fieldSize;
    if (c.seasonPoints.length !== n) c.seasonPoints = Array.from({ length: n }, (_, i) => c.seasonPoints[i] ?? 0);
    const out = this.makeOutcome(c.rallyStages, c.car, c.rally);
    const rows = this.rallyTable(c.rallyStages);
    for (const r of rows) r.points = out.points[r.driver] ?? 0;
    const lastStage = rally.stages[rally.stages.length - 1];
    for (let i = 0; i < n; i++) c.seasonPoints[i] += out.points[i];
    c.seasonRallies.push(out);
    if (!c.seasonCars.includes(c.car)) c.seasonCars.push(c.car);
    c.last = {
      rallyName: rally.name, seasonName: season.name, location: this.stageMeta(lastStage?.stage ?? '')?.location ?? lastStage?.stage ?? '',
      car: c.car, livery: c.livery, rows, standings: this.standingsTable(c), ralliesDone: c.seasonRallies.length, ralliesTotal: season.rallies.length,
      seasonComplete: false, season: null, unlocks: [], unlockCars: [], careerComplete: false,
    };
    const screens = ['rallyresults', 'standings'];
    c.rally++;
    c.stage = 0;
    c.rallyStages = [];
    c.carriedDamage = 0;
    c.carriedParts = [];
    if (c.rally >= season.rallies.length) {
      this.finalizeSeason(c, season, unlocks);
      screens.push('unlock');
    }
    return screens;
  }

  private finalizeSeason(c: CareerState, season: CareerSeasonDef, unlocks: { groups: string[]; cars: string[]; liveries: string[] }): void {
    const rows = this.standingsTable(c);
    const pos = rows.findIndex((r) => r.driver === 0) + 1;
    const outcome: SeasonOutcome = { group: season.group, position: pos, points: c.seasonPoints[0] ?? 0, restartsUsed: c.restartsUsed };
    c.seasons.push(outcome);
    const last = c.last!;
    last.seasonComplete = true;
    last.season = outcome;
    // finishing (any position) unlocks the next group and its cars; a podium the bonus livery of every car driven
    if (season.unlock_group && !unlocks.groups.includes(season.unlock_group)) {
      unlocks.groups.push(season.unlock_group);
      last.unlocks.push(this.groupName(season.unlock_group));
    }
    for (const car of season.unlock_cars ?? []) {
      if (!unlocks.cars.includes(car)) {
        unlocks.cars.push(car);
        last.unlocks.push(this.carName(car));
        last.unlockCars.push(car);
      }
    }
    if (pos <= 3) {
      for (const car of c.seasonCars) {
        if (unlocks.liveries.includes(car)) continue;
        unlocks.liveries.push(car);
        const spec = this.world.cars.find((x) => x.id === car);
        const bonus = spec?.liveries.find((l) => l.bonus);
        last.unlocks.push(`bonus livery: ${this.carName(car)} "${bonus?.name ?? 'bonus'}"`);
        if (!last.unlockCars.includes(car)) last.unlockCars.push(car);
      }
    }
    c.season++;
    c.rally = 0;
    c.stage = 0;
    c.seasonPoints = new Array(this.fieldSize).fill(0);
    c.seasonRallies = [];
    c.seasonCars = [];
    c.restartsLeft = this.restartsPerSeason;
    c.restartsUsed = 0;
    c.livery = 0;
    if (c.season >= this.seasons.length) {
      c.complete = true;
      c.car = '';
      last.careerComplete = true;
    } else c.car = this.seasons[c.season].cars[0] ?? '';
  }

  /**
   * A stored career -> a valid one (or null). A career from another career.json format restarts its season in
   * progress at rally 1, unless it is still in its first rally and that rally is the same in the new list
   * (UE MigrateCareer); finished seasons, unlocks, best times and the seed stay.
   */
  load(raw: unknown): CareerState | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Partial<CareerState>;
    const c = this.fresh(int(o.seed, 1977));
    c.active = !!o.active;
    c.complete = !!o.complete;
    c.season = clampInt(o.season, 0, this.seasons.length);
    c.rally = clampInt(o.rally, 0, 99);
    c.stage = clampInt(o.stage, 0, 99);
    c.restartsLeft = clampInt(o.restartsLeft, 0, this.restartsPerSeason, this.restartsPerSeason);
    c.restartsUsed = clampInt(o.restartsUsed, 0, 999);
    c.car = typeof o.car === 'string' ? o.car : '';
    c.livery = clampInt(o.livery, 0, 31);
    c.carriedDamage = Math.min(Math.max(num(o.carriedDamage, 0), 0), 0.99);
    c.carriedParts = Array.isArray(o.carriedParts) ? o.carriedParts.filter(isNum).slice(0, 6) : [];
    const n = this.fieldSize;
    const okStage = (s: StageResult) => s && Array.isArray(s.times) && s.times.length === n && Array.isArray(s.dnf) && typeof s.stage === 'string';
    const okRally = (r: RallyOutcome) => r && Array.isArray(r.order) && Array.isArray(r.points) && r.points.length === n;
    c.rallyStages = Array.isArray(o.rallyStages) ? o.rallyStages.filter(okStage).map((s) => ({ ...s, crash: Array.isArray(s.crash) ? s.crash : new Array(n).fill(0) })) : [];
    c.seasonRallies = Array.isArray(o.seasonRallies) ? o.seasonRallies.filter(okRally) : [];
    c.seasonPoints = Array.isArray(o.seasonPoints) && o.seasonPoints.length === n && o.seasonPoints.every(isNum) ? [...o.seasonPoints] : new Array(n).fill(0);
    c.seasonCars = Array.isArray(o.seasonCars) ? o.seasonCars.filter((x): x is string => typeof x === 'string') : [];
    c.seasons = Array.isArray(o.seasons) ? o.seasons.filter((s) => s && typeof s.group === 'string' && isNum(s.position)) : [];
    c.last = o.last && typeof o.last === 'object' && Array.isArray(o.last.rows) ? o.last : null;
    c.format = int(o.format, 0);
    if (c.season >= this.seasons.length && c.active) c.complete = true;
    if (c.format !== this.format) this.migrate(c);
    // a damaged rally index (a shorter list): back to its first stage
    if (c.active && !c.complete && !this.rallyDef(c)) {
      c.rally = Math.min(c.rally, Math.max(0, (this.season(c)?.rallies.length ?? 1) - 1));
      c.stage = 0;
      c.rallyStages = [];
    }
    return c;
  }

  private migrate(c: CareerState): void {
    const s0 = this.season(c)?.rallies[0];
    let keep = c.active && !c.complete && c.rally === 0 && c.seasonRallies.length === 0 && !!s0;
    if (keep && s0) {
      keep = c.rallyStages.length <= s0.stages.length && c.stage === c.rallyStages.length
        && c.rallyStages.every((r, i) => r.stage === s0.stages[i].stage && r.rev === isRev(s0.stages[i].variant));
    }
    if (!keep && c.active && !c.complete) {
      c.season = Math.min(Math.max(c.season, 0), Math.max(0, this.seasons.length - 1));
      c.rally = 0;
      c.stage = 0;
      c.restartsLeft = this.restartsPerSeason;
      c.restartsUsed = 0;
      c.carriedDamage = 0;
      c.carriedParts = [];
      c.rallyStages = [];
      c.seasonRallies = [];
      c.seasonPoints = new Array(this.fieldSize).fill(0);
      c.seasonCars = [];
      c.car = this.season(c)?.cars[0] ?? '';
      c.livery = 0;
    }
    c.format = this.format;
  }
}

export const isRev = (variant: string) => /^rev/i.test(variant ?? '');
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, d: number) => (isNum(v) ? v : d);
const int = (v: unknown, d: number) => (isNum(v) ? Math.trunc(v) : d);
const clampInt = (v: unknown, lo: number, hi: number, d = lo) => Math.min(Math.max(int(v, d), lo), hi);
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ------------------------------------------------------------------ formats (RallyFormat)

/** +s.mmm, or +m:ss.mmm from a minute. */
export function formatGap(s: number): string {
  if (s < 60) return `+${Math.max(0, s).toFixed(3)}`;
  const ms = Math.floor(s * 1000 + 0.5);
  return `+${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

export function ordinal(n: number): string {
  const m100 = n % 100;
  const suffix = m100 >= 11 && m100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}
