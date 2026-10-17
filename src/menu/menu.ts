// The menus (the original's SRallyMenu): title -> career (a card until slice 10) / quick stage / time attack /
// settings; garage (car, livery, spec sheet, bio; locked cars and liveries from the save) -> stage select
// (stage, direction, time of day, weather, best time) -> the loading card -> the stage (a page load).
// The backdrop is the live diorama (src/menu/diorama.ts); this file only builds the panels and asks the
// diorama for the car, the view, the lock look, the time of day and the location.
import { formatTime } from '../game/stageRun';
import { bestKey, isCarUnlocked, isLiveryUnlocked, type SaveData } from '../game/save';
import { saveRunSettings, loadRunSettings, readSection, type RunSettings } from '../settings';
import { CAR_IDS, garageCar, groupName, km, lockLine, locationOf, stageCondition, stageMeta, stageWeather, type MenuData } from './data';
import { flagSvg } from './flags';
import { menuQuery, playQuery, putMusic, type MenuState, type PlayMode, type PlaySetup } from './nav';
import { settingsScreen, type SettingsHost } from './settingsPanel';
import { MenuController, Row, controlsHint, el, esc, label, onRefresh, panel, pt, setScale, spacer, u, type Screen } from './ui';

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

  constructor(readonly data: MenuData, readonly save: SaveData, readonly diorama: MenuDiorama, readonly host: SettingsHost,
    readonly params: URLSearchParams, state: MenuState | null) {
    this.root = el('div', 'menu-root', document.body);
    this.curtainEl = el('div', 'curtain', this.root);
    const content = el('div', 'content', this.root);
    this.hintsEl = el('div', 'hints', this.root);
    this.musicEl = el('div', 'music', this.root);
    this.loadingEl = el('div', 'loading', this.root);
    this.loadingEl.style.display = 'none';
    this.ctl = new MenuController(content);
    this.ctl.active = true;
    this.ctl.onSong = (dir) => this.music?.skip(dir);
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
      settingsReturn: this.settingsReturn, focus,
    };
  }

  // ------------------------------------------------------------------ screens

  show(screen: string, focus?: number): void {
    this.screen = screen;
    let s: Screen;
    if (screen === 'career') s = this.careerScreen();
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

  /** The career hub waits for slice 10: what it will be, and a way back. */
  private careerScreen(): Screen {
    const p = panel('career');
    const box = el('div', '', p);
    box.style.paddingLeft = u(20);
    label(box, 'career', 34, 600).style.paddingBottom = u(6);
    const n = this.data.career.seasons.length;
    const rallies = (this.data.career as unknown as { seasons: { rallies?: unknown[] }[] }).seasons[0]?.rallies?.length ?? 4;
    const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    label(box, `${words[n] ?? n} seasons, from the sixties to the nineties.`, 19);
    label(box, `${words[rallies] ?? rallies} rallies a season, two stages a rally, nine rivals.`, 19);
    label(box, 'finish a season to unlock the next group and its cars.', 19);
    label(box, 'a podium finish earns that car\'s bonus livery.', 19);
    spacer(box, 22);
    const card = el('div', 'soon', box);
    card.style.cssText = `border-left: ${u(4)} solid var(--m-accent); padding: ${u(8)} ${u(16)}; background: rgba(39,39,43,0.06)`;
    label(card, 'coming next', 20, 600);
    label(card, 'the career arrives in the next update (slice 10).\nquick stage and time attack are open now.', 17, 400, true);
    spacer(p, 26);
    const rows: Row[] = [];
    this.item(p, rows, 'quick stage', () => this.toGarage('quick'));
    this.item(p, rows, 'back', () => this.show('title'));
    return { el: p, rows, onBack: () => this.show('title') };
  }

  private garageScreen(): Screen {
    if (!this.garageInit) {
      // start on the car in use (the last pick), unless it's locked
      this.garageInit = true;
      this.carIndex = Math.max(0, CAR_IDS.indexOf(this.run.car));
      this.livery = this.run.livery;
      if (!this.carUnlocked()) {
        this.carIndex = 0;
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
      const n = this.data.cars.length;
      this.carIndex = (this.carIndex + d + n) % n;
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
    if (ss) d.want(locationOf(this.data, this.stage.id), this.weatherName, this.condName);
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
    setTimeout(() => location.assign(`${location.pathname}${playQuery(setup, this.params)}`), 200);
  }

  showLoading(setup: PlaySetup): void {
    this.loadingEl.replaceChildren(loadingCard(this.data, setup));
    this.loadingEl.style.display = '';
    this.hintsEl.style.display = this.musicEl.style.display = 'none';
  }

  /** Per frame: the curtain, the live values, the gamepad, now playing. */
  frame(): void {
    const a = this.diorama.curtain;
    this.curtainEl.style.opacity = a.toFixed(3);
    this.curtainEl.style.display = a > 0.001 ? '' : 'none';
    this.ctl.frame();
    const t = this.music?.title() ?? '';
    const m = t ? `now playing  ·  ${t.toLowerCase()}` : '';
    if (this.musicEl.textContent !== m) this.musicEl.textContent = m;
  }
}

/** The loading card (UE LoadingCard): stage name, the line, mode and car, "loading", the controls. */
export function loadingCard(data: MenuData, s: PlaySetup): HTMLElement {
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
  line(`${s.mode === 'attack' ? 'time attack' : 'quick stage'}  ·  ${car?.name ?? s.car}`, 17, 400, true, 28);
  line('loading', 16, 500, true, 44);
  const c = controlsHint(box, data.menu.controls, 15, true);
  c.style.paddingTop = u(40);
  return box;
}

/** The menus' own query when leaving a stage (keeps the development options). */
export const menuHref = (params: URLSearchParams) => `${location.pathname}${menuQuery(params)}`;

export { esc };
