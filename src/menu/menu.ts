// The menus (the original's SRallyMenu): title -> career hub / quick stage / time attack / settings; garage (car,
// livery, spec sheet, bio; locked cars and liveries from the save) -> stage select (stage, direction, time of day,
// weather, best time) -> the loading card -> the stage (a page load). The career (src/game/career.ts): the hub
// (season, standing, restarts, the rallies and their stages), the garage with the season's cars -> the rally's
// stages; after a rally: rally results -> standings -> the unlock card at a season's end.
// The backdrop is the live diorama (src/menu/diorama.ts); this file only builds the panels and asks the
// diorama for the car, the view, the lock look, the time of day and the location.
import { formatTime } from '../game/stageRun';
import { bestKey, isCarUnlocked, isLiveryUnlocked, writeSave, type SaveData } from '../game/save';
import { formatGap, isRev, ordinal, type CareerRules, type CareerState } from '../game/career';
import { saveRunSettings, loadRunSettings, readSection, type RunSettings } from '../settings';
import { CAR_IDS, careerRules, garageCar, groupName, km, lockLine, locationOf, stageCondition, stageMeta, stageWeather, type MenuData } from './data';
import { flagSvg } from './flags';
import { menuQuery, playQuery, putMusic, type MenuState, type PlayMode, type PlaySetup } from './nav';
import { settingsScreen, type SettingsHost } from './settingsPanel';
import { busy, handOff, setBusyText, takeBoot } from './busy';
import { MenuController, Row, controlsHint, el, esc, label, onRefresh, panel, pt, setScale, spacer, table, u, type Screen } from './ui';

export interface MenuDiorama {
  showCar(car: string, livery: number): void;
  setView(view: 'title' | 'garage'): void;
  /** A locked car or livery: blurred, under a turning padlock. */
  setLocked(on: boolean): void;
  setCondition(name: string): void;
  /** The backdrop this screen wants; a different location or weather swaps it (a page load, behind the curtain). */
  want(location: string, weather: string | null, condition: string | null): void;
  /** 0..1 curtain over the diorama (it warms up behind it). */
  readonly curtain: number;
}

export interface MenuMusic {
  title(): string;
  skip(dir: number): void;
}

const CONDITIONS = ['morning', 'afternoon', 'sunset', 'night', 'fog'];
const WEATHERS = ['clear', 'rain', 'snow'];
/** UE FixedPanelWidth: the garage and stage select never change width while scrolling. */
const FIXED_W = 676;

export class Menu {
  readonly root: HTMLElement;
  readonly ctl: MenuController;
  private curtainEl: HTMLElement;
  private hintsEl: HTMLElement;
  private musicEl: HTMLElement;
  private loadingEl: HTMLElement;
  /** The loading indicator on the curtain (src/menu/busy.ts). */
  private busyEl: HTMLElement;
  screen = 'title';
  flow: PlayMode | 'career' = 'quick';
  carIndex = 0;
  livery = 0;
  stageIndex = 0;
  reverse = false;
  /** 0 = the stage's own, else conditions[i - 1] / weathers[i - 1] (UE ConditionIndex, WeatherIndex). */
  condIndex = 0;
  weatherIndex = 0;
  private settingsReturn = 'title';
  private lockAlertAt = -1e9;
  private lockAlertRow = '';
  private garageInit = false;
  private run: RunSettings;
  music: MenuMusic | null = null;
  readonly rules: CareerRules;
  /** The career in the save (null until one starts). */
  career: CareerState | null;
  /** Career: screens still to show after a rally; the standings screen came from the rally (not the hub). */
  private pending: string[] = [];
  private fromRally = false;

  constructor(readonly data: MenuData, readonly save: SaveData, readonly diorama: MenuDiorama, readonly host: SettingsHost,
    readonly params: URLSearchParams, state: MenuState | null) {
    this.root = el('div', 'menu-root', document.body);
    this.curtainEl = el('div', 'curtain', this.root);
    this.busyEl = busy(this.curtainEl, 'loading', takeBoot());
    const content = el('div', 'content', this.root);
    this.hintsEl = el('div', 'hints', this.root);
    this.musicEl = el('div', 'music', this.root);
    this.loadingEl = el('div', 'loading', this.root);
    this.loadingEl.style.display = 'none';
    this.ctl = new MenuController(content);
    this.ctl.active = true;
    this.ctl.onSong = (dir) => this.music?.skip(dir);
    this.rules = careerRules(data);
    this.career = this.rules.load(save.career);
    this.pending = state?.pending?.filter((x) => ['rallyresults', 'standings', 'unlock'].includes(x)) ?? [];
    this.fromRally = this.pending.length > 0;
    setScale(this.root);
    addEventListener('resize', () => setScale(this.root));

    // the last picks (UE settings save), or the state the last page left (a backdrop swap, back from a stage)
    this.run = loadRunSettings();
    const storedWeather = readSection<RunSettings>('run')?.weather; // never picked: the stage's own
    const r = this.run;
    const car = state?.car ?? r.car;
    this.carIndex = Math.max(0, CAR_IDS.indexOf(car));
    this.livery = state?.livery ?? r.livery;
    this.stageIndex = Math.max(0, data.menu.stages.findIndex((s) => s.id === (state?.stage ?? r.stage)));
    this.reverse = state?.reverse ?? r.reverse;
    const cond = state?.cond ?? r.condition;
    this.condIndex = CONDITIONS.indexOf(cond) + 1;
    const w = state?.weather ?? (storedWeather ? r.weather : 'stage');
    this.weatherIndex = WEATHERS.indexOf(w) + 1;
    if (state) {
      this.flow = state.flow;
      this.settingsReturn = state.settingsReturn ?? 'title';
      this.garageInit = true;
    }
    // locked picks fall back to the first car (UE BuildGarage)
    if (!this.carUnlocked()) {
      this.carIndex = 0;
      this.livery = 0;
    }
    if (this.livery >= this.car.liveries.length) this.livery = 0;
    this.show(state?.screen ?? 'title', state?.focus);
  }

  // ------------------------------------------------------------------ picks

  get car() {
    return this.data.cars[this.carIndex] ?? this.data.cars[0];
  }
  get stage() {
    return this.data.menu.stages[this.stageIndex] ?? this.data.menu.stages[0];
  }
  private carUnlocked(): boolean {
    return isCarUnlocked(this.save, this.car.id);
  }
  private liveryUnlocked(): boolean {
    return isLiveryUnlocked(this.save, this.car.id, !!this.car.liveries[this.livery]?.bonus);
  }
  get condName(): string {
    return this.condIndex > 0 ? CONDITIONS[this.condIndex - 1] : stageCondition(this.data, this.stage.id, this.reverse);
  }
  get weatherName(): string {
    return this.weatherIndex > 0 ? WEATHERS[this.weatherIndex - 1] : stageWeather(this.data, this.stage.id, this.reverse);
  }

  /** What a page load needs to come back to this screen. */
  state(focus = this.ctl.index): MenuState {
    return {
      screen: this.screen, flow: this.flow, car: this.car.id, livery: this.livery, stage: this.stage.id, reverse: this.reverse,
      cond: this.condIndex > 0 ? CONDITIONS[this.condIndex - 1] : 'stage', weather: this.weatherIndex > 0 ? WEATHERS[this.weatherIndex - 1] : 'stage',
      settingsReturn: this.settingsReturn, focus, pending: this.pending.length ? [...this.pending] : undefined,
    };
  }

  // ------------------------------------------------------------------ screens

  show(screen: string, focus?: number): void {
    this.screen = screen;
    let s: Screen;
    if (screen === 'career') s = this.careerScreen();
    else if (screen === 'confirmnew') s = this.confirmNewScreen();
    else if (screen === 'rallyresults' && this.career?.last) s = this.rallyResultsScreen();
    else if (screen === 'standings' && this.career) s = this.standingsScreen();
    else if (screen === 'unlock' && this.career?.last) s = this.unlockScreen();
    else if (screen === 'garage') s = this.garageScreen();
    else if (screen === 'stageselect') s = this.stageScreen();
    else if (screen === 'settings') s = settingsScreen(this.ctl, this.host, () => this.show(this.settingsReturn));
    else {
      this.screen = 'title';
      s = this.titleScreen();
    }
    if (focus !== undefined) s.focus = focus;
    this.ctl.show(s);
    this.updateDiorama();
    const options = this.screen === 'garage' || this.screen === 'stageselect' || this.screen === 'settings';
    this.hintsEl.textContent = options
      ? 'up / down or wheel choose  ·  left / right or click ‹ › change  ·  enter select  ·  esc back  ·  . next song'
      : 'up / down or wheel choose  ·  enter or click select  ·  esc back  ·  . next song';
  }

  private item(parent: Element, rows: Row[], text: string, onPress: () => void, extra: Partial<ConstructorParameters<typeof Row>[2]> = {}): Row {
    const w = el('div', '', parent);
    w.style.padding = `${u(2)} 0`;
    const r = new Row(this.ctl, w, { text, onPress, ...extra });
    rows.push(r);
    return r;
  }

  private titleScreen(): Screen {
    const p = panel('title', [40, 56, 40, 40]);
    const t = label(p, 'backroad rally', 76, 300);
    t.style.paddingLeft = u(18);
    t.style.lineHeight = '1.15';
    const sub = label(p, 'a little rally on the back roads', 19, 400, true);
    sub.style.padding = `0 0 ${u(40)} ${u(22)}`;
    const rows: Row[] = [];
    this.item(p, rows, 'career', () => {
      this.flow = 'career';
      this.show('career');
    });
    this.item(p, rows, 'quick stage', () => this.toGarage('quick'));
    this.item(p, rows, 'time attack', () => this.toGarage('attack'));
    this.item(p, rows, 'settings', () => {
      this.settingsReturn = 'title';
      this.show('settings');
    });
    return { el: p, rows };
  }

  private toGarage(flow: PlayMode): void {
    this.flow = flow;
    this.garageInit = false;
    this.show('garage');
  }

  // ------------------------------------------------------------------ career (UE BuildCareer, BuildRallyResults ...)

  private saveCareer(): void {
    this.save.career = this.career as unknown as Record<string, unknown>;
    writeSave(this.save);
  }

  /** The career hub: the season, the standing, the restarts, the rallies and their stages; start, standings, new. */
  private careerScreen(): Screen {
    const R = this.rules, c = this.career;
    const p = panel('career');
    const box = el('div', '', p);
    box.style.paddingLeft = u(20);
    label(box, 'career', 34, 600).style.paddingBottom = u(6);
    const rows: Row[] = [];
    const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const word = (n: number) => words[n] ?? String(n);
    const back = () => this.show('title');
    if (!c?.active) {
      const s0 = R.seasons[0];
      label(box, `${word(R.seasons.length)} seasons, from the sixties to the nineties.`, 19);
      label(box, `${word(s0?.rallies.length ?? 0)} rallies a season, ${word(s0?.rallies[0]?.stages.length ?? 0)} stages a rally, ${word(R.rivals.length)} rivals.`, 19);
      label(box, 'finish a season to unlock the next group and its cars.', 19);
      label(box, 'a podium finish earns that car\'s bonus livery.', 19);
      spacer(p, 30);
      this.item(p, rows, 'start career', () => {
        this.career = R.newCareer(this.career);
        this.saveCareer();
        this.show('career');
      });
      this.item(p, rows, 'back', back);
      return { el: p, rows, onBack: back };
    }
    if (c.complete) {
      const l = label(box, 'career complete. every group is yours.', 20, 500);
      l.style.paddingTop = u(6);
      for (const so of c.seasons) {
        label(box, `${R.groupName(so.group)}  ·  ${ordinal(so.position)}  ·  ${so.points} pts${so.restartsUsed === 0 ? '  ·  no restarts' : ''}`, 18);
      }
      spacer(p, 30);
      this.item(p, rows, 'new career', () => this.show('confirmnew'));
      this.item(p, rows, 'back', back);
      return { el: p, rows, onBack: back };
    }
    const season = R.season(c);
    if (!season) {
      this.item(p, rows, 'back', back);
      return { el: p, rows, onBack: back };
    }
    label(box, `${season.name}  ·  ${season.era}  ·  season ${c.season + 1} of ${R.seasons.length}`, 20, 500);
    const standings = R.standingsTable(c);
    const me = standings.findIndex((r) => r.driver === 0) + 1;
    const standing = c.seasonRallies.length === 0 ? 'no points yet' : `${c.seasonPoints[0] ?? 0} pts  ·  ${ordinal(me)} in the standings`;
    label(box, `${standing}  ·  restarts left ${c.restartsLeft} of ${R.restartsPerSeason}`, 17, 400, true).style.paddingTop = u(2);
    spacer(box, 16);
    const over = R.isRallyOver(c);
    season.rallies.forEach((rally, r) => {
      let status = '';
      if (r < c.seasonRallies.length) {
        const o = c.seasonRallies[r];
        status = o.dnf[0] ? 'dnf  ·  0 pts' : `${ordinal(o.order.indexOf(0) + 1)}  ·  ${o.points[0] ?? 0} pts`;
      } else if (r === c.rally) status = over ? 'finished, results pending' : c.stage === 0 ? 'next' : `stage ${c.stage + 1} of ${rally.stages.length} next`;
      const head = el('div', '', box);
      head.style.cssText = `display:flex;align-items:center;padding-top:${u(6)}`;
      const flag = el('div', '', head);
      flag.style.cssText = `width:${u(21)};height:${u(14)};margin-right:${u(8)};flex:none`;
      flag.innerHTML = flagSvg(this.data.menu.flags[R.stageMeta(rally.stages[0]?.stage ?? '')?.location ?? ''] ?? '');
      const t = label(head, `${rally.name}${status ? `   —   ${status}` : ''}`, 19, r === c.rally ? 600 : 400, r !== c.rally);
      t.style.whiteSpace = 'pre';
      for (const sd of rally.stages) {
        const m = R.stageMeta(sd.stage);
        const rev = isRev(sd.variant);
        const line = label(box, `${m?.name ?? sd.stage}  ·  ${rev ? 'reverse' : 'forward'}  ·  ${(m ? (rev ? m.km_rev : m.km_fwd) : 3).toFixed(1)} km  ·  ${sd.condition}  ·  ${R.stageWeather(sd)}`, 16, 400, true);
        line.style.paddingLeft = u(29);
      }
    });
    spacer(p, 26);
    const rally = R.rallyDef(c);
    if (over) {
      this.item(p, rows, 'rally results', () => {
        this.pending = R.finalizeRally(c, this.save.unlocks);
        this.saveCareer();
        this.nextPending(true);
      });
    } else if (rally && c.stage === 0) {
      this.item(p, rows, `start rally: ${rally.name}`, () => {
        this.flow = 'career';
        this.garageInit = false;
        this.show('garage');
      });
    } else if (rally) {
      this.item(p, rows, `next stage: ${c.stage + 1} of ${rally.stages.length}`, () => this.startCareerStage());
    }
    if (c.seasonRallies.length > 0) {
      this.item(p, rows, 'standings', () => {
        this.fromRally = false;
        this.show('standings');
      });
    }
    this.item(p, rows, 'new career', () => this.show('confirmnew'));
    this.item(p, rows, 'back', back);
    return { el: p, rows, onBack: back };
  }

  private confirmNewScreen(): Screen {
    const p = panel('confirmnew');
    const box = el('div', '', p);
    box.style.paddingLeft = u(20);
    label(box, 'new career', 34, 600).style.paddingBottom = u(8);
    label(box, 'start over from group 2? the current career is lost.', 19);
    label(box, 'unlocked groups, cars, liveries and best times are kept.', 17, 400, true).style.padding = `${u(2)} 0 ${u(28)}`;
    const rows: Row[] = [];
    this.item(p, rows, 'no, keep my career', () => this.show('career'));
    this.item(p, rows, 'yes, start over', () => {
      this.career = this.rules.newCareer(this.career);
      this.saveCareer();
      this.show('career');
    });
    return { el: p, rows, onBack: () => this.show('career') };
  }

  /** After a rally: the next of the pending screens, else the hub (UE NextPending). */
  private nextPending(first = false): void {
    if (!first && this.pending[0] === this.screen) this.pending.shift();
    if (this.pending.length) {
      this.fromRally = true;
      this.flow = 'career';
      this.show(this.pending[0]);
      return;
    }
    this.fromRally = false;
    this.flow = 'career';
    this.show('career');
  }

  private resultPanel(sub: string, title: string, extra?: string): { p: HTMLElement; box: HTMLElement } {
    const p = panel(title);
    const box = el('div', '', p);
    box.style.paddingLeft = u(20);
    label(box, sub, 17, 400, true);
    label(box, title, 34, 600).style.paddingBottom = u(extra ? 2 : 18);
    if (extra) label(box, extra, 17, 400, true).style.paddingBottom = u(18);
    return { p, box };
  }

  private rallyResultsScreen(): Screen {
    const L = this.career!.last!;
    const { p } = this.resultPanel(L.seasonName, `${L.rallyName}  ·  results`, `your car: ${this.rules.carName(L.car)}`);
    const t = el('div', '', p);
    t.style.padding = `0 0 ${u(24)} ${u(8)}`;
    table(t, [{ title: 'pos', width: 56 }, { title: 'driver', width: 230 }, { title: 'total', width: 130, right: true }, { title: 'gap', width: 130, right: true },
      { title: 'pts', width: 70, right: true }],
    L.rows.map((r) => [String(r.position), r.name, r.dnf ? 'dnf' : formatTime(r.time), r.dnf || r.position === 1 ? '' : formatGap(r.gap), String(r.points)]),
    L.rows.map((r) => r.driver === 0));
    const rows: Row[] = [];
    this.item(p, rows, 'continue', () => this.nextPending());
    return { el: p, rows, onBack: () => this.nextPending() };
  }

  private standingsScreen(): Screen {
    const c = this.career!, R = this.rules, L = c.last;
    const fromRally = this.fromRally && !!L;
    const rowsT = fromRally ? L!.standings : R.standingsTable(c);
    const season = R.season(c);
    const sub = fromRally
      ? (L!.seasonComplete ? `${L!.seasonName}  ·  final standings` : `${L!.seasonName}  ·  after ${L!.ralliesDone} of ${L!.ralliesTotal} rallies`)
      : season ? `${season.name}  ·  after ${c.seasonRallies.length} of ${season.rallies.length} rallies` : '';
    const { p } = this.resultPanel(sub, 'season standings');
    const t = el('div', '', p);
    t.style.padding = `0 0 ${u(24)} ${u(8)}`;
    table(t, [{ title: 'pos', width: 56 }, { title: 'driver', width: 260 }, { title: 'points', width: 100, right: true }],
      rowsT.map((r) => [String(r.position), r.name, String(r.points)]), rowsT.map((r) => r.driver === 0));
    const rows: Row[] = [];
    const go = () => (fromRally ? this.nextPending() : this.show('career'));
    this.item(p, rows, 'continue', go);
    return { el: p, rows, onBack: go };
  }

  private unlockScreen(): Screen {
    const L = this.career!.last!, S = L.season;
    const p = panel('unlock');
    const box = el('div', '', p);
    box.style.paddingLeft = u(20);
    label(box, L.seasonName, 17, 400, true);
    label(box, 'season complete', 40, 600).style.paddingBottom = u(6);
    if (S) {
      label(box, `you finished ${ordinal(S.position)} in ${this.rules.groupName(S.group)} with ${S.points} points`, 20, 500);
      label(box, S.restartsUsed === 0 ? 'no restarts used' : `${S.restartsUsed} restart${S.restartsUsed === 1 ? '' : 's'} used`, 17, 400, true).style.padding = `${u(2)} 0 ${u(22)}`;
    }
    if (!L.unlocks.length) label(box, 'nothing new to unlock this time', 19);
    for (const x of L.unlocks) label(box, `unlocked  ·  ${x}`, 22, 600).style.paddingTop = u(2);
    if (L.careerComplete) label(box, 'that was the last season: career complete', 19, 500).style.paddingTop = u(16);
    spacer(p, 28);
    const rows: Row[] = [];
    this.item(p, rows, 'continue', () => this.nextPending());
    return { el: p, rows, onBack: () => this.nextPending() };
  }

  /** The career's next stage: service at the rally start, the save written, the loading card, the stage page. */
  private startCareerStage(): void {
    const c = this.career, R = this.rules;
    const def = c ? R.startStage(c) : null;
    if (!c || !def) return;
    this.saveCareer();
    const setup: PlaySetup = {
      mode: 'career', stage: def.stage, reverse: isRev(def.variant), car: c.car, livery: c.livery, cond: def.condition, weather: R.stageWeather(def),
    };
    this.showLoading(setup);
    this.ctl.active = false;
    putMusic(null);
    setTimeout(() => {
      this.handOff();
      location.assign(`${location.pathname}${playQuery(setup, this.params)}`);
    }, 200);
  }

  /** The cars the garage offers: the season's in the career, else all. */
  private garageCars(): string[] {
    if (this.flow === 'career') {
      const s = this.career ? this.rules.season(this.career) : undefined;
      if (s?.cars.length) return s.cars;
    }
    return CAR_IDS;
  }

  private garageScreen(): Screen {
    if (!this.garageInit) {
      // start on the car in use (the career's rally car, else the last pick), unless it's locked
      this.garageInit = true;
      const career = this.flow === 'career' && this.career;
      const want = career ? career.car : this.run.car;
      this.carIndex = Math.max(0, CAR_IDS.indexOf(this.garageCars().includes(want) ? want : this.garageCars()[0]));
      this.livery = career ? career.livery : this.run.livery;
      if (!this.carUnlocked()) {
        this.carIndex = Math.max(0, CAR_IDS.indexOf(this.garageCars()[0]));
        this.livery = 0;
      }
      if (this.livery >= this.car.liveries.length) this.livery = 0;
    }
    const p = panel('garage');
    const box = el('div', '', p);
    box.style.width = u(FIXED_W);
    const pad = (e: HTMLElement, b = 0, t = 0) => {
      e.style.padding = `${u(t)} 0 ${u(b)} ${u(20)}`;
      return e;
    };
    pad(label(box, `garage  ·  ${this.flow === 'attack' ? 'time attack' : this.flow === 'career' ? 'career' : 'quick stage'}`, 17, 400, true), 2);
    pad(label(box, () => this.car.name, 40, 600, false, 'ell'));
    pad(label(box, () => `${groupName(this.data, this.car.group)}  ·  ${garageCar(this.data, this.car.id)?.era ?? ''}`, 18, 500, true), 14);
    // the lock line keeps its two lines of space when nothing is locked, so the panel never changes size
    const lockBox = pad(el('div', '', box), 10);
    const lock = el('div', 'accent', lockBox);
    lock.style.cssText = `width:${u(600)};height:${u(46)};font-size:${pt(17)};font-weight:500;white-space:normal`;
    const specs: [string, (g: NonNullable<ReturnType<typeof garageCar>>) => string][] = [
      ['power', (g) => g.power], ['engine', (g) => g.engine], ['drivetrain', (g) => g.drivetrain], ['gearbox', (g) => g.gears], ['weight', (g) => g.weight],
    ];
    for (const [name, get] of specs) {
      const r = pad(el('div', '', box), 0, 1);
      r.style.display = 'flex';
      const n = label(r, name, 18, 400, true);
      n.style.width = u(150);
      label(r, () => {
        const g = garageCar(this.data, this.car.id);
        return g ? get(g) : '';
      }, 18, 500);
    }
    const bio = pad(el('div', '', box), 22, 12);
    const bioText = label(bio, () => garageCar(this.data, this.car.id)?.bio ?? '', 17, 400);
    bioText.style.cssText += `;width:${u(560)};height:${u(92)};white-space:normal`;
    const rows: Row[] = [];
    const opt = (text: string, value: () => string, onAdjust: (d: number) => void, badge: () => string, row: string) => {
      const w = el('div', '', box);
      w.style.padding = `${u(1)} 0`;
      rows.push(new Row(this.ctl, w, { text, value, onAdjust, badge, size: 22, minWidth: 640, valueWidth: 300,
        alertAt: () => (this.lockAlertRow === row ? this.lockAlertAt : -1e9) }));
    };
    opt('car', () => this.car.name, (d) => {
      const list = this.garageCars();
      const n = list.length;
      const i = Math.max(0, list.indexOf(this.car.id));
      this.carIndex = Math.max(0, CAR_IDS.indexOf(list[(i + d + n) % n]));
      this.livery = 0;
      this.updateDiorama();
    }, () => (this.carUnlocked() ? '' : 'locked'), 'car');
    opt('livery', () => {
      const l = this.car.liveries[this.livery];
      return l ? `${l.name}${l.bonus && this.liveryUnlocked() ? '  (bonus)' : ''}` : '';
    }, (d) => {
      const n = this.car.liveries.length;
      this.livery = (this.livery + d + n) % n;
      this.updateDiorama();
    }, () => (this.carUnlocked() && !this.liveryUnlocked() ? 'locked' : ''), 'livery');
    spacer(box, 18);
    const blocked = () => !this.carUnlocked() || !this.liveryUnlocked();
    this.item(box, rows, this.flow === 'career' ? 'start rally' : 'choose stage', () => {
      if (this.flow === 'career') {
        // the rally's car and livery (UE: RallyCar, RallyLivery), then its first stage
        if (this.career) {
          this.career.car = this.car.id;
          this.career.livery = this.livery;
        }
        this.startCareerStage();
        return;
      }
      this.remember();
      this.show('stageselect');
    }, {
      minWidth: 640,
      blocked,
      onBlocked: () => {
        this.lockAlertAt = performance.now();
        this.lockAlertRow = this.carUnlocked() ? 'livery' : 'car';
      },
    });
    this.item(box, rows, 'back', () => this.show(this.flow === 'career' ? 'career' : 'title'), { minWidth: 640 });
    // the lock line follows the picks; a refused start adds "pick an unlocked ... to continue"
    const refreshLock = () => {
      const carLocked = !this.carUnlocked();
      const locked = carLocked || !this.liveryUnlocked();
      lock.style.visibility = locked ? 'visible' : 'hidden';
      if (!locked) return;
      const recent = performance.now() - this.lockAlertAt < 3000;
      const t = (recent ? (carLocked ? 'pick an unlocked car to continue.  ' : 'pick an unlocked livery to continue.  ') : '') + lockLine(this.data, this.car.id, carLocked);
      if (lock.textContent !== t) lock.textContent = t;
      lock.style.color = performance.now() - this.lockAlertAt < 1200 ? '#a52a14' : '';
    };
    refreshLock();
    onRefresh(refreshLock);
    return { el: p, rows, onBack: () => this.show(this.flow === 'career' ? 'career' : 'title') };
  }

  /** The garage pick becomes the last car (UE LastCar / LastLivery). */
  private remember(): void {
    this.run = { ...loadRunSettings(), car: this.car.id, livery: this.livery };
    saveRunSettings(this.run);
  }

  private stageScreen(): Screen {
    const p = panel('stageselect');
    const box = el('div', '', p);
    box.style.width = u(FIXED_W);
    const pad = (e: HTMLElement, b = 0) => {
      e.style.padding = `0 0 ${u(b)} ${u(20)}`;
      return e;
    };
    pad(label(box, this.flow === 'attack' ? 'time attack  ·  no damage' : 'quick stage', 17, 400, true), 2);
    const head = pad(el('div', '', box));
    head.style.cssText += ';display:flex;align-items:center';
    const flag = el('div', '', head);
    flag.style.cssText = `width:${u(42)};height:${u(28)};margin:${u(4)} ${u(14)} 0 0;flex:none`;
    let flagCode = '';
    const name = label(head, () => {
      const code = this.data.menu.flags[this.stage.location];
      if (code !== flagCode) {
        flagCode = code;
        flag.innerHTML = flagSvg(code);
        flag.style.display = code ? '' : 'none';
      }
      return this.stage.name;
    }, 40, 600, false, 'ell');
    name.style.flex = '1';
    pad(label(box, () => `${this.stage.location}  ·  ${km(this.stage, this.reverse).toFixed(1)} km  ·  ${this.stage.surface}`, 18, 500, true, 'ell'));
    pad(label(box, () => {
      const defC = stageCondition(this.data, this.stage.id, this.reverse);
      const defW = stageWeather(this.data, this.stage.id, this.reverse);
      const c = this.condName, w = this.weatherName;
      return `${c}  ·  ${w}${c !== defC || w !== defW ? `    (stage default: ${defC}  ·  ${defW})` : ''}`;
    }, 18, 500, true, 'ell'), 4);
    pad(label(box, () => {
      const key = bestKey(this.flow === 'attack' ? 'attack' : 'quick', this.stage.id, this.reverse, this.car.id, this.weatherName);
      const b = this.save.best[key];
      return `best (${this.car.name}, ${this.weatherName})  ·  ${b ? formatTime(b.time) : 'none yet'}`;
    }, 18, 400, false, 'ell tnum'), 22);
    const rows: Row[] = [];
    const opt = (text: string, value: () => string, onAdjust: (d: number) => void) => {
      const w = el('div', '', box);
      w.style.padding = `${u(1)} 0`;
      rows.push(new Row(this.ctl, w, { text, value, onAdjust, size: 22, minWidth: 640, valueWidth: 300 }));
    };
    opt('stage', () => this.stage.name, (d) => {
      const n = this.data.menu.stages.length;
      this.stageIndex = (this.stageIndex + d + n) % n;
      this.updateDiorama();
    });
    opt('direction', () => (this.reverse ? 'reverse' : 'forward'), () => {
      this.reverse = !this.reverse;
      this.updateDiorama();
    });
    opt('time of day', () => (this.condIndex === 0 ? `${this.condName}  (default)` : this.condName), (d) => {
      const n = CONDITIONS.length + 1;
      this.condIndex = (this.condIndex + d + n) % n;
      this.updateDiorama();
    });
    opt('weather', () => (this.weatherIndex === 0 ? `${this.weatherName}  (default)` : this.weatherName), (d) => {
      const n = WEATHERS.length + 1;
      this.weatherIndex = (this.weatherIndex + d + n) % n;
      this.updateDiorama();
    });
    spacer(box, 18);
    this.item(box, rows, 'start', () => this.start(), { minWidth: 640 });
    this.item(box, rows, 'back', () => this.show('garage'), { minWidth: 640 });
    return { el: p, rows, onBack: () => this.show('garage') };
  }

  // ------------------------------------------------------------------ the backdrop

  private updateDiorama(): void {
    const d = this.diorama;
    const garage = this.screen === 'garage';
    const ss = this.screen === 'stageselect';
    d.showCar(this.car.id, this.livery);
    d.setView(garage ? 'garage' : 'title');
    d.setLocked(garage && (!this.carUnlocked() || !this.liveryUnlocked()));
    // the backdrop shows where you are about to drive: the picked stage, the career's next rally; after a rally its own
    // location on the results, standings and unlock card (UE DioramaLocation)
    const careerNext = (): string => {
      const c = this.career, r = c ? this.rules.rallyDef(c) : undefined;
      if (!c?.active || c.complete || !r?.stages.length) return '';
      return locationOf(this.data, r.stages[Math.min(c.stage, r.stages.length - 1)].stage);
    };
    const after = this.screen === 'rallyresults' || this.screen === 'unlock' || (this.screen === 'standings' && this.fromRally);
    if (after && this.career?.last?.location) d.want(this.career.last.location, null, null);
    else if (this.flow === 'career' && ['career', 'garage', 'confirmnew', 'standings'].includes(this.screen) && careerNext()) d.want(careerNext(), null, null);
    else if (ss) d.want(locationOf(this.data, this.stage.id), this.weatherName, this.condName);
    else if (this.screen === 'title') d.want(locationOf(this.data, this.run.stage || this.data.menu.diorama.location), null, null);
    else d.want('', null, null); // keep what is on screen
  }

  // ------------------------------------------------------------------ start a run

  private start(): void {
    const setup: PlaySetup = {
      mode: this.flow === 'attack' ? 'attack' : 'quick',
      stage: this.stage.id,
      reverse: this.reverse,
      car: this.car.id,
      livery: this.livery,
      cond: this.condIndex > 0 ? CONDITIONS[this.condIndex - 1] : 'stage',
      weather: this.weatherIndex > 0 ? WEATHERS[this.weatherIndex - 1] : 'stage',
    };
    // the last picks (UE LastStage, LastCondition, LastWeather): the stage select opens on them next time
    this.run = { ...loadRunSettings(), stage: setup.stage, reverse: setup.reverse, condition: setup.cond, weather: setup.weather as RunSettings['weather'], car: setup.car, livery: setup.livery };
    saveRunSettings(this.run);
    this.showLoading(setup);
    this.ctl.active = false;
    putMusic(null);
    // let the card draw before the page goes
    setTimeout(() => {
      this.handOff();
      location.assign(`${location.pathname}${playQuery(setup, this.params)}`);
    }, 200);
  }

  /** What the curtain's indicator says ("loading", or the GETTING_READY phrases). */
  setBusy(text: string | readonly string[]): void {
    setBusyText(this.busyEl, text);
  }

  /** The page goes: the next one starts with this curtain and card on screen (src/menu/busy.ts). */
  handOff(): void {
    handOff(this.root);
  }

  showLoading(setup: PlaySetup): void {
    this.loadingEl.replaceChildren(loadingCard(this.data, setup, setup.mode === 'career' && this.career ? careerLine(this.rules, this.career) : undefined));
    // a stage page loads next: a wait of seconds, so the indicator shows at once
    this.loadingEl.querySelector('.busy')?.classList.add('now');
    this.loadingEl.style.display = '';
    this.hintsEl.style.display = this.musicEl.style.display = 'none';
  }

  private autoAt = 0;
  /**
   * Headless career runs (?autocontinue, tools/check/career.mjs): every 1.5 s once the backdrop is up, press on
   * through the career (result screens, the hub's next action, the garage's start); stops at the end of a season.
   */
  private autoStep(): void {
    if (!this.params.has('autocontinue')) return;
    if (this.diorama.curtain > 0.01) {
      this.autoAt = performance.now() + 2000; // a moment on screen once the backdrop is up (the check's screenshots)
      return;
    }
    if (performance.now() < this.autoAt) return;
    this.autoAt = performance.now() + 1500;
    const rows = this.ctl.screen?.rows ?? [];
    const press = (re: RegExp) => rows.find((r) => re.test(String(typeof r.spec.text === 'function' ? r.spec.text() : r.spec.text)))?.press();
    if (this.screen === 'title') press(/^career$/);
    else if (['rallyresults', 'standings', 'unlock'].includes(this.screen)) press(/^continue$/);
    else if (this.screen === 'garage' && this.flow === 'career') press(/^start rally$/);
    else if (this.screen === 'career' && !(this.career?.last?.seasonComplete && this.career.rally === 0 && this.career.stage === 0)) {
      press(/^(start career|rally results|start rally: .*|next stage: .*)$/);
    }
  }

  /** Per frame: the curtain, the live values, the gamepad, now playing. */
  frame(): void {
    this.autoStep();
    const a = this.diorama.curtain;
    this.curtainEl.style.opacity = a.toFixed(3);
    this.curtainEl.style.display = a > 0.001 ? '' : 'none';
    // shown at once after a hand-off; a later curtain (another backdrop) waits the usual moment
    if (a === 0 && this.busyEl.classList.contains('now')) this.busyEl.classList.remove('now');
    // the indicator halfway between the panel's right edge and the screen's
    const r = a > 0.001 ? this.ctl.screen?.el.getBoundingClientRect() : null;
    if (r?.width) {
      const x = `${Math.round(Math.min((r.right + innerWidth) / 2, innerWidth - this.busyEl.offsetWidth / 2 - 16))}px`;
      if (this.busyEl.style.left !== x) this.busyEl.style.left = x;
    }
    this.ctl.frame();
    const t = this.music?.title() ?? '';
    const m = t ? `now playing  ·  ${t.toLowerCase()}` : '';
    if (this.musicEl.textContent !== m) this.musicEl.textContent = m;
  }
}

/** The loading card's mode line in the career: "career · group 2 · rally finland · stage 1 of 2 · the swift mk1". */
export function careerLine(R: CareerRules, c: CareerState): string {
  const season = R.season(c), rally = R.rallyDef(c);
  return `career  ·  ${season?.name ?? ''}  ·  ${rally?.name ?? ''}  ·  stage ${c.stage + 1} of ${rally?.stages.length ?? 2}  ·  ${R.carName(c.car)}`;
}

/** The loading card (UE LoadingCard): stage name, the line, mode and car, the loading indicator, the controls. */
export function loadingCard(data: MenuData, s: PlaySetup, modeLine?: string): HTMLElement {
  const meta = stageMeta(data, s.stage);
  const cond = s.cond === 'stage' || !CONDITIONS.includes(s.cond) ? stageCondition(data, s.stage, s.reverse) : s.cond;
  const weather = s.weather === 'stage' || !WEATHERS.includes(s.weather) ? stageWeather(data, s.stage, s.reverse) : s.weather;
  const car = data.cars.find((c) => c.id === s.car);
  const box = el('div', 'card');
  const line = (text: string, size: number, weight: number, soft: boolean, top: number) => {
    const e = label(box, text, size, weight, soft);
    e.style.paddingTop = u(top);
    return e;
  };
  line(meta?.name ?? s.stage, 64, 300, false, 0);
  line([meta?.location ?? s.stage, `${km(meta, s.reverse).toFixed(1)} km`, s.reverse ? 'reverse' : 'forward', cond, weather].join('  ·  '), 22, 400, false, 10);
  line(modeLine ?? `${s.mode === 'attack' ? 'time attack' : 'quick stage'}  ·  ${car?.name ?? s.car}`, 17, 400, true, 28);
  busy(box, 'loading stage').style.paddingTop = u(44);
  const c = controlsHint(box, data.menu.controls, 15, true);
  c.style.paddingTop = u(40);
  return box;
}

/** The menus' own query when leaving a stage (keeps the development options). */
export const menuHref = (params: URLSearchParams) => `${location.pathname}${menuQuery(params)}`;

export { esc };
