// The menu UI kit (the original's RallyUI / SRallyItem, Slate): a DOM overlay shared by the menus, the pause
// menu, the results and the settings. Lowercase Inter on soft paper panels; the highlighted row is drawn
// inverted with a thin red bar. Sizes are Slate units at 1080p (CSS: calc(var(--d) * n)), fonts Slate points
// (calc(var(--f) * n), 4/3 px per point), both scaled by the shortest window side / 1080 like UE's DPI rule.
//
// Input, as in the original: keyboard (up / down choose, left / right change, enter or space select, esc back,
// . next song), mouse (hover highlights, click selects, click the value or ‹ › to change, right click steps
// back, hold an arrow to repeat, the wheel moves the highlight) and gamepad (d-pad or left stick, A select,
// B back, right shoulder next song). One highlighted row is shared by all three.

export interface UiSounds {
  click(): void;
  confirm(): void;
  back(): void;
  /** A refused press (a locked car or livery): a low double "bonk". */
  blocked(): void;
}

/** The sounds the rows play; the audio sets these once it has loaded (silent until then). */
export const uiSounds: UiSounds = { click() {}, confirm() {}, back() {}, blocked() {} };

type Text = string | (() => string);
const txt = (t: Text): string => (typeof t === 'function' ? t() : t);

export interface ItemSpec {
  text: Text;
  onPress: () => void;
  /** Drawn faded; a press plays the back sound and does nothing (UE Locked). */
  locked?: () => boolean;
  /** A press is refused: the row shakes and flashes, `onBlocked` runs instead (UE Blocked). */
  blocked?: () => boolean;
  onBlocked?: () => void;
  /** Font size (pt) and minimum width (units). */
  size?: number;
  minWidth?: number;
  /** No confirm sound (the press plays its own). */
  silent?: boolean;
}

export interface OptionSpec {
  text: Text;
  value: () => string;
  onAdjust: (dir: number) => void;
  /** A small red pill after the label ("locked"); '' = none. */
  badge?: () => string;
  /** Faded and not adjustable (a setting that waits for a later slice). */
  disabled?: () => boolean;
  /** Shake and flash the row from this time (performance.now() ms), when another row was refused because of it. */
  alertAt?: () => number;
  size?: number;
  minWidth?: number;
  valueWidth?: number;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: Element | null, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Slate units and points as CSS. */
export const u = (n: number) => `calc(var(--d) * ${n})`;
export const pt = (n: number) => `calc(var(--f) * ${n})`;

/** A text block: size in points, weight 300..600, soft = the half-ink colour. */
export function label(parent: Element, text: Text, size = 18, weight = 400, soft = false, cls = ''): HTMLElement {
  const e = el('div', `lbl${soft ? ' soft' : ''}${cls ? ` ${cls}` : ''}`, parent);
  e.style.fontSize = pt(size);
  e.style.fontWeight = String(weight);
  const set = () => {
    const t = txt(text);
    if (e.textContent !== t) e.textContent = t;
  };
  set();
  if (typeof text === 'function') building.add(set);
  return e;
}

export function spacer(parent: Element, h: number): HTMLElement {
  const e = el('div', 'spacer', parent);
  e.style.height = u(h);
  return e;
}

/**
 * Things to refresh while their panel is on screen (values that follow the game). A screen's builder adds to
 * `building`; showing the screen makes that set the live one.
 */
let live = new Set<() => void>();
let building = new Set<() => void>();

/** Run `fn` on every refresh while the screen being built is up. */
export function onRefresh(fn: () => void): void {
  building.add(fn);
}

const CHEVRON = (dir: number) =>
  `<svg viewBox="0 0 10 10" aria-hidden="true"><polyline points="${dir < 0 ? '6.4,2.6 3.6,5 6.4,7.4' : '3.6,2.6 6.4,5 3.6,7.4'}" /></svg>`;

const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;

export class Row {
  readonly el: HTMLElement;
  readonly option: boolean;
  private valueEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private textEl: HTMLElement;
  private lastAlert = -1e9;
  private repeat = 0;

  constructor(readonly menu: MenuController, parent: Element, readonly spec: ItemSpec | OptionSpec) {
    this.option = 'onAdjust' in spec;
    const size = spec.size ?? (this.option ? 22 : 24);
    const minW = spec.minWidth ?? (this.option ? 640 : 380);
    const row = (this.el = el('div', `row${this.option ? ' opt' : ''}`, parent));
    row.style.minWidth = u(minW);
    row.style.fontSize = pt(size);
    const bar = el('div', 'bar', row);
    bar.style.width = u(4);
    const inner = el('div', 'inner', row);
    inner.style.padding = this.option ? `${u(4)} ${u(8)} ${u(4)} ${u(16)}` : `${u(8)} ${u(20)} ${u(8)} ${u(16)}`;
    const lab = el('div', 'label', inner);
    this.textEl = el('span', 'text', lab);
    if (this.option) {
      const o = spec as OptionSpec;
      this.badgeEl = el('span', 'badge', lab);
      const arrow = size * 1.45;
      const mk = (dir: number) => {
        const a = el('div', 'arrow', inner, CHEVRON(dir));
        a.style.width = a.style.height = u(arrow);
        if (dir < 0) a.style.marginLeft = u(24);
        a.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.focusMe();
          a.classList.add('down');
          this.adjust(dir);
          clearTimeout(this.repeat);
          const tick = (delay: number) => {
            this.repeat = window.setTimeout(() => {
              if (!a.classList.contains('down')) return;
              if (a.matches(':hover')) this.adjust(dir);
              tick(REPEAT_EVERY);
            }, delay);
          };
          tick(REPEAT_DELAY);
          const up = () => {
            a.classList.remove('down');
            clearTimeout(this.repeat);
            removeEventListener('mouseup', up);
          };
          addEventListener('mouseup', up);
        });
        a.addEventListener('click', (e) => e.stopPropagation());
        a.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        return a;
      };
      mk(-1);
      this.valueEl = el('div', 'value', inner);
      this.valueEl.style.width = u(o.valueWidth ?? 300);
      mk(1);
      this.valueEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.focusMe();
        this.adjust(1);
      });
    }
    row.addEventListener('mousemove', (e) => {
      if (menu.cursorMoved(e)) this.focusMe(true);
    });
    row.addEventListener('click', () => {
      this.focusMe();
      if (!this.option) this.press();
    });
    // right click: an option steps back (anywhere on the row)
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.option) return;
      this.focusMe();
      this.adjust(-1);
    });
    this.refresh();
  }

  private focusMe(byHover = false): void {
    this.menu.focusRow(this, byHover ? 'mouse' : 'set');
  }

  get disabled(): boolean {
    return this.option && !!(this.spec as OptionSpec).disabled?.();
  }

  setFocused(on: boolean): void {
    this.el.classList.toggle('focus', on);
  }

  refresh(): void {
    const t = txt(this.spec.text);
    if (this.textEl.textContent !== t) this.textEl.textContent = t;
    if (this.option) {
      const o = this.spec as OptionSpec;
      const v = o.value();
      if (this.valueEl!.textContent !== v) this.valueEl!.textContent = v;
      const b = o.badge?.() ?? '';
      if (this.badgeEl!.textContent !== b) this.badgeEl!.textContent = b;
      this.badgeEl!.style.display = b ? '' : 'none';
      this.el.classList.toggle('disabled', !!o.disabled?.());
      const at = o.alertAt?.() ?? -1e9;
      if (at > this.lastAlert && performance.now() - at < 300) {
        this.lastAlert = at;
        this.alert();
      }
    } else {
      this.el.classList.toggle('locked', !!(this.spec as ItemSpec).locked?.());
    }
  }

  /** The refusal: shake sideways and flash red for 0.55 s. */
  alert(): void {
    this.el.animate(
      Array.from({ length: 12 }, (_, i) => ({ transform: `translateX(${(Math.sin(i * 1.6) * 7 * (1 - i / 11)).toFixed(2)}px)` })),
      { duration: 550, easing: 'linear' },
    );
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
  }

  press(): void {
    if (this.option) {
      this.adjust(1);
      return;
    }
    const s = this.spec as ItemSpec;
    this.el.classList.remove('pressed');
    void this.el.offsetWidth;
    this.el.classList.add('pressed');
    if (s.blocked?.()) {
      uiSounds.blocked();
      this.alert();
      s.onBlocked?.();
      return;
    }
    if (s.locked?.()) {
      uiSounds.back();
      return;
    }
    if (!s.silent) uiSounds.confirm();
    s.onPress();
  }

  adjust(dir: number): void {
    if (!this.option || this.disabled) {
      if (this.disabled) uiSounds.back();
      return;
    }
    uiSounds.click();
    (this.spec as OptionSpec).onAdjust(dir);
    const v = this.valueEl!;
    v.classList.remove('stepped');
    void v.offsetWidth;
    v.classList.add('stepped');
    this.menu.refresh();
  }
}

export interface Screen {
  /** The panel element (built by the screen). */
  el: HTMLElement;
  rows: Row[];
  /** Esc / B. */
  onBack?: () => void;
  /** Row to highlight first (default 0). */
  focus?: number;
}

/**
 * One menu surface: a container element, the screen on it and the highlighted row. Several controllers can
 * exist (the menus, the pause menu); only the active one reads input.
 */
export class MenuController {
  screen: Screen | null = null;
  index = 0;
  active = false;
  onSong: ((dir: number) => void) | null = null;
  /** Gamepad Start (the stage pauses with it); null = acts as select. */
  onStart: (() => void) | null = null;
  private builtAt = { x: -1, y: -1 };
  private moved = false;
  private padPrev: boolean[] = [];
  private padHold = { dir: '', since: 0, next: 0 };
  /** Last pointer position (the rows under a resting cursor don't take the highlight). */
  static pointer = { x: -1, y: -1 };

  constructor(readonly container: HTMLElement) {
    addEventListener('keydown', (e) => this.onKey(e));
    container.addEventListener('wheel', (e) => {
      if (!this.active || !this.screen) return;
      e.preventDefault();
      this.moved = true;
      this.step(e.deltaY < 0 ? -1 : 1, true);
    }, { passive: false });
  }

  /** Put a screen up (replacing the last one) and highlight its first (or chosen) row. */
  show(screen: Screen): void {
    live = building;
    building = new Set();
    this.container.replaceChildren(screen.el);
    this.screen = screen;
    this.builtAt = { ...MenuController.pointer };
    this.moved = false;
    this.index = Math.min(Math.max(screen.focus ?? 0, 0), Math.max(screen.rows.length - 1, 0));
    for (const [i, r] of screen.rows.entries()) r.setFocused(i === this.index);
    this.refresh();
  }

  clear(): void {
    live = new Set();
    building = new Set();
    this.container.replaceChildren();
    this.screen = null;
  }

  cursorMoved(e: MouseEvent): boolean {
    if (!this.moved && Math.hypot(e.clientX - this.builtAt.x, e.clientY - this.builtAt.y) > 2) this.moved = true;
    return this.moved;
  }

  focusRow(row: Row, cause: 'mouse' | 'set'): void {
    const i = this.screen?.rows.indexOf(row) ?? -1;
    if (i < 0 || i === this.index) return;
    this.setIndex(i, cause === 'mouse');
  }

  private setIndex(i: number, sound: boolean): void {
    const rows = this.screen!.rows;
    rows[this.index]?.setFocused(false);
    this.index = i;
    rows[i].setFocused(true);
    if (sound) uiSounds.click();
  }

  get row(): Row | null {
    return this.screen?.rows[this.index] ?? null;
  }

  step(d: number, sound = true): void {
    const rows = this.screen?.rows;
    if (!rows?.length) return;
    const i = Math.min(Math.max(this.index + d, 0), rows.length - 1);
    if (i !== this.index) this.setIndex(i, sound);
  }

  back(): void {
    if (this.screen?.onBack) {
      uiSounds.back();
      this.screen.onBack();
    }
  }

  /** Refresh the live values (once a frame while shown, and after every change). */
  refresh(): void {
    for (const r of this.screen?.rows ?? []) r.refresh();
    for (const f of live) f();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || !this.screen) return;
    const c = e.code;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
    let used = true;
    if (c === 'ArrowUp' || c === 'KeyW') this.step(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') this.step(1);
    else if (c === 'ArrowLeft' || c === 'KeyA') this.row?.adjust(-1);
    else if (c === 'ArrowRight' || c === 'KeyD') this.row?.adjust(1);
    else if ((c === 'Enter' || c === 'NumpadEnter' || c === 'Space') && !e.repeat) this.row?.press();
    else if ((c === 'Escape' || c === 'Backspace') && !e.repeat) this.back();
    else if ((c === 'Period' || c === 'Comma') && !e.repeat && this.onSong) this.onSong(c === 'Period' ? 1 : -1);
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  /** Once a frame: the gamepad (polled; browsers fire no events for it) and the live values. */
  frame(now = performance.now()): void {
    if (!this.active || !this.screen) return;
    this.refresh();
    const pad = firstPad();
    if (!pad) return;
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => {
      const on = b(i);
      const was = this.padPrev[i];
      this.padPrev[i] = on;
      return on && !was;
    };
    if (edge(0)) this.row?.press();
    if (edge(1)) this.back();
    if (edge(9)) {
      if (this.onStart) this.onStart();
      else this.row?.press();
    }
    if (edge(5) && this.onSong) this.onSong(1);
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    const dir = b(12) || ay < -0.5 ? 'up' : b(13) || ay > 0.5 ? 'down' : b(14) || ax < -0.5 ? 'left' : b(15) || ax > 0.5 ? 'right' : '';
    const h = this.padHold;
    if (dir !== h.dir) {
      h.dir = dir;
      h.since = now;
      h.next = now + REPEAT_DELAY;
      if (dir) this.padMove(dir);
    } else if (dir && now >= h.next) {
      h.next = now + REPEAT_EVERY;
      this.padMove(dir);
    }
  }

  /** Forget held buttons (a screen opened by a button press must not see the same press). */
  syncPad(): void {
    const pad = firstPad();
    if (pad) this.padPrev = pad.buttons.map((x) => x.pressed);
  }

  private padMove(dir: string): void {
    if (dir === 'up') this.step(-1);
    else if (dir === 'down') this.step(1);
    else this.row?.adjust(dir === 'left' ? -1 : 1);
  }
}

export function firstPad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

addEventListener('mousemove', (e) => {
  MenuController.pointer.x = e.clientX;
  MenuController.pointer.y = e.clientY;
}, { passive: true });

/** A soft paper panel; padding in units [top/bottom, left/right] or [t, r, b, l]. */
export function panel(cls = '', pad: number[] = [36, 44], alpha?: number): HTMLElement {
  const p = el('div', `panel ${cls}`);
  p.style.padding = pad.map(u).join(' ');
  if (alpha !== undefined) p.style.setProperty('--panel-a', String(alpha));
  return p;
}

/** The DPI rule: Slate units and points follow the shortest window side. */
export function setScale(root: HTMLElement, w = innerWidth, h = innerHeight): void {
  const d = Math.min(w, h) / 1080;
  root.style.setProperty('--d', `${d}px`);
  root.style.setProperty('--f', `${(d * 4) / 3}px`);
}

/** A table (stage results): a header row, then the rows; the player's row inverted. Right columns use tabular digits. */
export function table(parent: Element, cols: { title: string; width: number; right?: boolean }[], rows: string[][], hi: boolean[], size = 18): HTMLElement {
  const t = el('div', 'table', parent);
  const line = (cells: string[], head: boolean, h: boolean) => {
    const r = el('div', `trow${head ? ' head' : ''}${h ? ' hi' : ''}`, t);
    r.style.padding = `${u(head ? 2 : 4)} ${u(12)}`;
    r.style.fontSize = pt(head ? size * 0.8 : size);
    cols.forEach((c, i) => {
      const cell = el('div', `cell${c.right ? ' right' : ''}`, r);
      cell.style.width = u(c.width);
      cell.textContent = (head ? c.title : cells[i] ?? '').toLowerCase();
    });
  };
  line([], true, false);
  rows.forEach((r, i) => line(r, false, !!hi[i]));
  return t;
}

/** The driving controls (menu.json controls: action, keyboard, gamepad), as the loading card and pause show them. */
export function controlsHint(parent: Element, controls: [string, string, string][], size = 15, centre = false): HTMLElement {
  const box = el('div', `controls${centre ? ' centre' : ''}`, parent);
  for (const [a, k, p] of controls) {
    const r = el('div', 'crow', box);
    r.style.fontSize = pt(size);
    const l = el('div', 'act', r, esc(a.toLowerCase()));
    l.style.width = u(size * 11);
    const v = el('div', 'keys', r, `${esc(k.toLowerCase())}&nbsp;&nbsp;·&nbsp;&nbsp;${esc(p.toLowerCase())}`);
    v.style.width = u(size * 16);
    v.style.paddingLeft = u(size);
  }
  return box;
}
