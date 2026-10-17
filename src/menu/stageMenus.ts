// The menus over a stage run (the original's ARallyHUD panels): the loading curtain and card, the pause menu
// (resume, restart, recover +5 s, settings, quit), the settings and the results (time, penalties, total, best,
// new best; restart / choose another stage / main menu). Esc or the gamepad's Start pauses; while a panel is open
// the menu reads the keys and the car doesn't.
import { formatTime } from '../game/stageRun';
import { formatGap, ordinal, type TableRow } from '../game/career';
import { MenuController, Row, controlsHint, el, firstPad, label, panel, setScale, spacer, table, u, type Screen } from './ui';
import { settingsScreen, type SettingsHost } from './settingsPanel';

export interface CurtainCfg {
  warmup_min_s: number;
  warmup_max_s: number;
  warmup_frame_ms: number;
  warmup_stable_frames: number;
  curtain_fade_s: number;
}

export interface ResultsInfo {
  /** "finland · harjunkulma · forward" */
  sub: string;
  dnf: boolean;
  reason: string;
  clock: number;
  penalties: number;
  recovers: number;
  total: number;
  /** Quick stage / time attack, not a retirement: the best-time line. */
  best: { prev: number; newBest: boolean } | null;
  /** Career: the stage's classification with the rivals, the rally's so far, which stage of how many. */
  career?: { stageRows: TableRow[]; rallyRows: TableRow[]; index: number; count: number; rallyOver: boolean } | null;
  /** Quick stage / time attack: the rival ghosts that raced, with the player (names, times, dnf, driver index). */
  rivals?: { name: string; time: number; dnf: boolean; driver: number }[] | null;
}

export interface StageMenuHooks {
  /** "harjunkulma · finland · forward" for the pause panel. */
  sub: string;
  controls: [string, string, string][];
  /** quick / attack get "choose another stage"; the career continues; development pages only restart and the main menu. */
  mode: 'quick' | 'attack' | 'career' | 'dev';
  /** Career: restarts left this season (a restart uses one; none left = the row is locked). */
  restartsLeft?: () => number;
  restartsTotal?: number;
  /** Career: the next stage, or the rally's results. */
  careerContinue?: () => void;
  canPause(): boolean;
  onPause(paused: boolean): void;
  restart(): void;
  recover(): void;
  quit(screen: 'title' | 'stageselect' | 'career'): void;
  settings: SettingsHost;
}

export class StageMenus {
  readonly root: HTMLElement;
  readonly ctl: MenuController;
  private curtainEl: HTMLElement;
  private loadingEl: HTMLElement;
  /** 'pause' and 'settings' pause the run; 'results' doesn't (the run has ended). */
  open: 'pause' | 'settings' | 'results' | null = null;
  /** The curtain: 1 while the stage warms up, then fading; ready once it is gone. */
  curtain = 1;
  ready = false;
  private warm = 0;
  private stable = 0;
  private fading = false;
  private startPrev = false;

  constructor(private h: StageMenuHooks, private cfg: CurtainCfg) {
    // keys first, before the menu controller's listener: Esc opens the pause menu without the controller
    // taking the same press as "back"
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !e.repeat && !this.open && this.ready && this.h.canPause()) {
        this.pause();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
    this.root = el('div', 'menu-root centred', document.body);
    const content = el('div', 'content', this.root);
    this.curtainEl = el('div', 'curtain', this.root);
    this.loadingEl = el('div', 'loading', this.root);
    this.ctl = new MenuController(content);
    setScale(this.root);
    addEventListener('resize', () => setScale(this.root));
  }

  get paused(): boolean {
    return this.open === 'pause' || this.open === 'settings';
  }

  showCard(card: HTMLElement): void {
    this.loadingEl.replaceChildren(card);
  }

  /**
   * Once a frame: the curtain stays until warmup_stable_frames frames in a row are under warmup_frame_ms (at
   * least warmup_min_s, at most warmup_max_s), then fades over curtain_fade_s. Returns true once the run may go.
   */
  frame(dt: number, frameMs: number): boolean {
    const c = this.cfg;
    if (!this.fading) {
      this.warm += dt;
      this.stable = frameMs < c.warmup_frame_ms ? this.stable + 1 : 0;
      if ((this.warm >= c.warmup_min_s && this.stable >= c.warmup_stable_frames) || this.warm >= c.warmup_max_s) this.fading = true;
    } else if (this.curtain > 0) {
      this.curtain = Math.max(0, this.curtain - dt / Math.max(c.curtain_fade_s, 0.01));
      if (this.curtain === 0) this.ready = true;
    }
    const a = this.curtain.toFixed(3);
    if (this.curtainEl.style.opacity !== a) {
      this.curtainEl.style.opacity = this.loadingEl.style.opacity = a;
      const show = this.curtain > 0 ? '' : 'none';
      this.curtainEl.style.display = this.loadingEl.style.display = show;
    }
    // the gamepad's Start pauses (and resumes: the menu's own Start)
    const pad = firstPad();
    const start = !!pad?.buttons[9]?.pressed;
    if (start && !this.startPrev && !this.open && this.ready && this.h.canPause()) {
      this.pause();
      this.ctl.syncPad();
    }
    this.startPrev = start;
    this.ctl.frame();
    return this.ready;
  }

  // ------------------------------------------------------------------ pause

  pause(): void {
    this.open = 'pause';
    this.h.onPause(true);
    this.ctl.active = true;
    this.ctl.onStart = () => this.resume();
    this.ctl.show(this.pauseScreen());
  }

  resume(): void {
    this.close();
    this.h.onPause(false);
  }

  private close(): void {
    this.open = null;
    this.ctl.active = false;
    this.ctl.onStart = null;
    this.ctl.clear();
    this.startPrev = !!firstPad()?.buttons[9]?.pressed;
  }

  private pauseScreen(): Screen {
    const p = panel('pause', [36, 44], 0.9);
    const head = el('div', '', p);
    head.style.paddingLeft = u(20);
    label(head, 'paused', 40, 600);
    label(head, this.h.sub, 18, 400, true).style.paddingTop = u(2);
    const career = this.h.mode === 'career';
    if (career) label(head, `career  ·  restarts left ${this.restartsLeft()} of ${this.h.restartsTotal ?? 3}`, 18, 400, true).style.paddingTop = u(2);
    spacer(p, 24);
    const rows: Row[] = [];
    const add = (text: string, fn: () => void, locked?: () => boolean) => {
      const w = el('div', '', p);
      w.style.padding = `${u(2)} 0`;
      rows.push(new Row(this.ctl, w, { text, onPress: fn, minWidth: 420, locked }));
    };
    add('resume', () => this.resume());
    add(career ? `restart stage  (${this.restartsLeft()} left)` : 'restart stage', () => {
      this.resume();
      this.h.restart();
    }, career ? () => this.restartsLeft() <= 0 : undefined);
    add('recover car  (+5 s)', () => {
      this.resume();
      this.h.recover();
    });
    add('settings', () => {
      this.open = 'settings';
      this.ctl.show(settingsScreen(this.ctl, this.h.settings, () => {
        this.open = 'pause';
        this.ctl.show({ ...this.pauseScreen(), focus: 3 });
      }));
    });
    add(career ? 'quit to career' : 'quit to menu', () => this.h.quit(career ? 'career' : 'title'));
    if (career) label(p, 'quitting keeps the career at this stage', 15, 400, true).style.padding = `${u(16)} 0 0 ${u(20)}`;
    const c = controlsHint(p, this.h.controls, 14);
    c.style.paddingTop = u(22);
    return { el: p, rows, onBack: () => this.resume() };
  }

  private restartsLeft(): number {
    return this.h.restartsLeft?.() ?? 99;
  }

  // ------------------------------------------------------------------ results

  showResults(r: ResultsInfo): void {
    this.open = 'results';
    this.ctl.active = true;
    this.ctl.onStart = null;
    const p = panel('results', [36, 44], 0.9);
    const head = el('div', '', p);
    head.style.paddingLeft = u(20);
    label(head, r.sub, 18, 400, true);
    const title = label(head, r.dnf ? `dnf  ·  ${r.reason || 'retired'}` : 'stage complete', 40, 600);
    title.style.paddingBottom = u(4);
    if (r.dnf) title.classList.add('accent');
    label(head, r.dnf ? 'did not finish: classified last'
      : `time ${formatTime(r.clock)}   ·   penalties +${r.penalties.toFixed(1)} s (${r.recovers})   ·   total ${formatTime(r.total)}`, 20, 500, false, 'tnum');
    const C = r.career;
    if (C) {
      // the stage with the rivals (UE BuildResults, career): pos, driver, stage, gap, rally total from stage 2, crash note
      const pos = C.stageRows.findIndex((x) => x.driver === 0) + 1;
      const rpos = C.rallyRows.findIndex((x) => x.driver === 0) + 1;
      label(head, `stage ${C.index + 1} of ${C.count}  ·  stage ${ordinal(pos)}  ·  rally ${ordinal(rpos)}`, 18, 400, true).style.padding = `${u(2)} 0 ${u(14)}`;
      const multi = C.index > 0;
      const cols = [{ title: 'pos', width: 52 }, { title: 'driver', width: 210 }, { title: 'stage', width: 120, right: true }, { title: 'gap', width: 110, right: true }];
      if (multi) cols.push({ title: 'rally total', width: 140, right: true });
      cols.push({ title: '', width: 140 });
      const cells = C.stageRows.map((x) => {
        const rr = C.rallyRows.find((y) => y.driver === x.driver);
        const row = [String(x.position), x.name, x.dnf ? 'dnf' : formatTime(x.time), x.dnf || x.position === 1 ? '' : formatGap(x.gap)];
        if (multi) row.push(rr ? (rr.dnf ? 'dnf' : formatTime(rr.time)) : '');
        row.push(x.crash > 0 ? `\u00a0\u00a0\u00a0crash +${Math.round(x.crash)} s` : ''); // after a gap (UE: left-aligned past the column)
        return row;
      });
      const t = el('div', '', p);
      t.style.padding = `0 0 ${u(18)} ${u(8)}`;
      table(t, cols, cells, C.stageRows.map((x) => x.driver === 0), 17);
    } else if (r.best && !r.dnf) {
      const b = r.best;
      const faster = b.prev > 0 ? formatTime(b.prev - r.total).replace(/^0:/, '') : '';
      const line = b.newBest ? (b.prev > 0 ? `new best time  ·  ${faster} faster` : 'new best time')
        : `best ${formatTime(b.prev)}  ·  +${formatTime(r.total - b.prev).replace(/^0:/, '')} off`;
      const l = label(head, line, 20, 600, false, 'tnum');
      l.style.padding = `${u(6)} 0 ${u(r.rivals?.length ? 8 : 18)}`;
      if (b.newBest) l.classList.add('accent');
    } else spacer(p, 18);
    if (!C && r.rivals?.length) {
      // the rival ghosts that raced, classified like the career's table (a tie goes to the rival): the order they crossed the line
      const order = [...r.rivals].sort((a, b) => (a.dnf !== b.dnf ? (a.dnf ? 1 : -1) : a.time !== b.time ? a.time - b.time : b.driver - a.driver));
      const lead = order.length && !order[0].dnf ? order[0].time : 0;
      const t = el('div', '', p);
      t.style.padding = `0 0 ${u(14)} ${u(8)}`;
      table(t, [{ title: 'pos', width: 52 }, { title: 'driver', width: 210 }, { title: 'stage', width: 120, right: true }, { title: 'gap', width: 110, right: true }],
        order.map((x, k) => [String(k + 1), x.name, x.dnf ? 'dnf' : formatTime(x.time), x.dnf || k === 0 ? '' : formatGap(x.time - lead)]),
        order.map((x) => x.driver === 0), order.length > 6 ? 15 : 17);
    }
    const rows: Row[] = [];
    const add = (text: string, fn: () => void, locked?: () => boolean) => {
      const w = el('div', '', p);
      w.style.padding = `${u(2)} 0`;
      rows.push(new Row(this.ctl, w, { text, onPress: fn, minWidth: 420, locked }));
    };
    const restart = () => {
      this.close();
      this.h.restart();
    };
    if (this.h.mode === 'career') {
      add(C?.rallyOver ? 'continue  ·  rally results' : 'continue  ·  next stage', () => this.h.careerContinue?.());
      add(`restart stage  (${this.restartsLeft()} left)`, restart, () => this.restartsLeft() <= 0);
      add('quit to career', () => this.h.quit('career'));
    } else {
      add('restart stage', restart);
      if (this.h.mode !== 'dev') add('choose another stage', () => this.h.quit('stageselect'));
      add('main menu', () => this.h.quit('title'));
    }
    this.ctl.show({ el: p, rows });
    this.ctl.syncPad();
  }

  /** The results went away (a restart from a key). */
  hideResults(): void {
    if (this.open === 'results') this.close();
  }
}
