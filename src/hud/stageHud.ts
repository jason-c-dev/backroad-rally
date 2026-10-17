// The in-stage HUD, ported from the original's ARallyHUD and its instruments (RallyHudWidgets) with
// hud.json's sizes, colours and anchors: a DOM/CSS overlay over the canvas (cheaper than drawing it).
//
//   top right     timer (stage time, tabular digits in a fixed-width panel), then stacked under it the
//                 live position and ghost delta (slots for slice 10, hidden until fed), the +5.0 s
//                 penalty pop, "penalties +x s" and the best time (slice 10)
//   left          the vertical stage progress line, start at the bottom, the car's marker on it
//   bottom left   damage warning lights, 2 x 3 (front, rear, engine / left, right, suspension):
//                 off, flashing yellow (minor), yellow, flashing red (major), red (broken)
//   bottom centre the gear gate, an H pattern with the current gear lit (r red)
//   bottom right  speed as a number or a dial, km/h or mph
//   centre        intro card, 3-2-1-go (the results and pause panels are the menus': src/menu/stageMenus.ts)
//
// Every size is in Slate units at 1080p: CSS px = units x hud.json scale (1.1) x the "hud size" setting
// (80-130%) x the shortest window side / 1080 (UE's DPI rule). A few of the original's sizes ignore
// the hud size (the progress line, the penalty lines, the cards): those use the DPI factor alone.
import type { StageRun } from '../game/stageRun';
import { formatTime } from '../game/stageRun';
import { PARTS } from '../game/damage';
import type { HudSettings } from '../settings';
import { warningIconUrl } from './warningIcons';

export interface HudJson {
  scale: number;
  colors: Record<'ink' | 'paper' | 'accent' | 'good' | 'warn' | 'bad', string>;
  timer: { margin: number[]; font: number; pad: number[]; template: string };
  speed: {
    margin: number[]; number_font: number; number_template: string; units_font: number; dial_radius: number; dial_arc_width: number;
    dial_sweep_deg: number; dial_max_kmh: number; dial_max_mph: number; major_kmh: number; major_mph: number; dial_number_font: number; dial_units_font: number;
  };
  gear: { offset: number[]; cell_w: number; cell_h: number; pad: number; knob_margin: number; line: number; knob: number; font: number; min_slots: number };
  damage: {
    offset: number[]; layout: string[][]; cell: number; cell_gap: number; pad: number; icon_scale: number; minor_from: number; damaged_from: number;
    major_from: number; broken_from: number; flash_hz: number; pulse_s: number; off: string; outline_alpha: number; lit_lens_mix: number;
    lit_rim: number; lens: string; plate: string; yellow: string; red: string; show_when_clean: boolean;
  };
}

export interface HudInfo {
  stageName: string;
  /** "finland · 3.1 km · forward" */
  subtitle: string;
  /** Speed (km/h, unsigned). */
  kmh: number;
  /** -1 reverse, 0 neutral, 1.. forward. */
  gear: number;
  gears: number;
  progress: number;
  /** null = damage off (time attack): the lights hide. */
  damage: { parts: readonly number[]; terminal: boolean } | null;
}

/** Fed by later slices (position against rival ghosts, the ghost delta, the best time); hidden while null. */
export interface HudFeed {
  position: string | null;
  ghostDelta: number | null;
  best: string | null;
}

// the original's own Slate colours (linear in UE, shown here in sRGB) where hud.json has none
const UE_INK = '#27272b'; // FLinearColor(0.02, 0.02, 0.025): progress fill, dial digits, gate lines
const UE_ACCENT = '#ef6145'; // FLinearColor(0.86, 0.12, 0.06): penalty pop, dnf, progress marker, reverse
const GO_GREEN = '#b2f9b2'; // FLinearColor(0.45, 0.95, 0.45)

const SVG = 'http://www.w3.org/2000/svg';
/** Slate font sizes are points: px = size x 96 / 72. */
const PT = 96 / 72;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function svgEl(tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement {
  const e = document.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** hex '#RRGGBB' or '#RRGGBBAA' -> [r, g, b, a 0..1] */
function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) / 255 : 1];
}
const css = (c: [number, number, number, number]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3].toFixed(3)})`;
const mix = (a: [number, number, number, number], b: [number, number, number, number], t: number): [number, number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];

/** UE FMath::FInterpTo / VInterpTo: move by the distance x clamp(dt x speed). */
const interp = (cur: number, target: number, dt: number, speed: number) => cur + (target - cur) * Math.min(Math.max(dt * speed, 0), 1);

export class StageHud {
  readonly root: HTMLElement;
  feed: HudFeed = { position: null, ghostDelta: null, best: null };
  /** A menu panel is up (pause, settings): the instruments hide, as on the results (src/menu/stageMenus.ts). */
  panelOpen = false;
  private s: HudSettings;
  private timer: HTMLElement;
  private posEl: HTMLElement;
  private ghostEl: HTMLElement;
  private ghostVal: HTMLElement;
  private pop: HTMLElement;
  private pens: HTMLElement;
  private best: HTMLElement;
  private barFill: HTMLElement;
  private barMark: HTMLElement;
  private speedNum: HTMLElement;
  private speedVal: HTMLElement;
  private speedUnits: HTMLElement;
  private dialBox: HTMLElement;
  private dial!: { fill: SVGElement; needle: SVGElement; num: SVGElement; units: SVGElement; R: number; O: number; Ra: number; max: number };
  private dialShown = 0;
  private dialKey = '';
  private gate: HTMLElement;
  private gateSvg!: { svg: SVGElement; knob: SVGElement; knobLabel: SVGElement; slot: (g: number) => [number, number]; gears: number };
  private knob: [number, number] = [-1, -1];
  private lights: HTMLElement;
  private cells: { cell: HTMLElement; icon: HTMLElement; part: number; state: number; changed: number }[] = [];
  private card: HTMLElement;
  private countdown: HTMLElement;
  private results: HTMLElement;
  private dip: HTMLElement;
  private last = 0;
  private cardKey = '';
  private yellow: [number, number, number, number];
  private red: [number, number, number, number];
  private lens: [number, number, number, number];

  constructor(parent: HTMLElement, private cfg: HudJson, settings: HudSettings) {
    this.s = { ...settings };
    const c = cfg.colors;
    const D = cfg.damage;
    this.yellow = rgba(D.yellow);
    this.red = rgba(D.red);
    this.lens = rgba(D.lens);
    const root = (this.root = el('div', ''));
    root.id = 'stage-hud';
    root.style.setProperty('--ink', c.ink);
    root.style.setProperty('--paper', c.paper);
    root.style.setProperty('--accent', c.accent);
    root.style.setProperty('--ue-ink', UE_INK);
    root.style.setProperty('--ue-accent', UE_ACCENT);
    root.style.setProperty('--go', GO_GREEN);
    root.style.setProperty('--plate', css(rgba(D.plate)));
    root.style.setProperty('--lens', css(this.lens));
    parent.appendChild(root);

    // ---- timer column (top right)
    const T = cfg.timer;
    const col = el('div', 'hud-timer', root);
    col.style.cssText = `top: calc(var(--u) * ${T.margin[1]}); right: calc(var(--u) * ${T.margin[0]})`;
    const panel = el('div', 'panel mono', col);
    panel.style.cssText = `padding: calc(var(--u) * ${T.pad[1]}) calc(var(--u) * ${T.pad[0]}); font-size: calc(var(--uf) * ${T.font})`;
    el('span', 'tpl', panel, T.template);
    this.timer = el('span', 'val', panel, '0:00.000');
    this.posEl = el('div', 'pos mono outlined', col);
    const g = el('div', 'ghost', col);
    el('span', 'label outlined', g, 'ghost');
    const gv = el('div', 'panel mono', g);
    el('span', 'tpl', gv, '+00.00');
    this.ghostVal = el('span', 'val', gv);
    this.ghostEl = g;
    this.pop = el('div', 'pop mono outlined', col, '+5.0 s');
    this.pens = el('div', 'pens mono outlined', col);
    this.best = el('div', 'best mono outlined', col);

    // ---- progress line (left)
    const bar = el('div', 'hud-progress', root);
    el('div', 'shadow', bar);
    el('div', 'track', bar);
    el('div', 'tick top', bar);
    el('div', 'tick bottom', bar);
    this.barFill = el('div', 'fill', bar);
    this.barMark = el('div', 'mark', bar);

    // ---- damage warning lights (bottom left)
    this.lights = el('div', 'hud-lights', root);
    this.lights.style.cssText = `left: calc(var(--u) * ${D.offset[0]}); bottom: calc(var(--u) * ${D.offset[1]}); padding: calc(var(--u) * ${D.pad});` +
      ` gap: calc(var(--u) * ${D.cell_gap}); border-radius: calc(var(--u) * ${D.pad + 2}); grid-template-columns: repeat(${Math.max(...D.layout.map((r) => r.length))}, calc(var(--u) * ${D.cell}))`;
    for (const row of D.layout) {
      for (const name of row) {
        const part = PARTS.indexOf(name as (typeof PARTS)[number]);
        if (part < 0) continue;
        const cell = el('div', 'light', this.lights);
        cell.style.cssText = `width: calc(var(--u) * ${D.cell}); height: calc(var(--u) * ${D.cell}); border-radius: calc(var(--u) * ${D.cell * 0.22})`;
        const icon = el('div', 'icon', cell);
        icon.style.cssText = `width: ${D.icon_scale * 100}%; height: ${D.icon_scale * 100}%`;
        icon.dataset.on = warningIconUrl(PARTS[part], true);
        icon.dataset.off = warningIconUrl(PARTS[part], false);
        this.cells.push({ cell, icon, part, state: -1, changed: -100 });
      }
    }

    // ---- gear gate (bottom centre)
    this.gate = el('div', 'hud-gear', root);
    this.gate.style.bottom = `calc(var(--u) * ${cfg.gear.offset[1]})`;

    // ---- speed (bottom right): number or dial
    const S = cfg.speed;
    const sp = el('div', 'hud-speed', root);
    sp.style.cssText = `right: calc(var(--u) * ${S.margin[0]}); bottom: calc(var(--u) * ${S.margin[1]})`;
    this.speedNum = el('div', 'number', sp);
    const num = el('div', 'mono outlined big', this.speedNum);
    num.style.fontSize = `calc(var(--uf) * ${S.number_font})`;
    el('span', 'tpl', num, S.number_template);
    this.speedVal = el('span', 'val', num, '0');
    this.speedUnits = el('div', 'units outlined', this.speedNum, 'km/h');
    this.speedUnits.style.cssText = `font-size: calc(var(--uf) * ${S.units_font}); padding: 0 0 calc(var(--u) * 8) calc(var(--u) * 6); min-width: 2.6em`;
    this.dialBox = el('div', 'dial', sp);

    // ---- centre: intro card, countdown, results; the white dip of a reset
    this.card = el('div', 'hud-card', root);
    this.countdown = el('div', 'hud-count', root);
    this.results = el('div', 'hud-results', root);
    this.dip = el('div', 'hud-dip', root);

    this.apply(settings);
  }

  get settings(): HudSettings {
    return { ...this.s };
  }

  /** Units, speed display and size changed (keys, URL, later the settings screen). */
  apply(s: HudSettings): void {
    this.s = { ...s };
    this.speedUnits.textContent = s.units === 'mph' ? 'mph' : 'km/h';
    this.speedNum.style.display = s.speedo === 'dial' ? 'none' : '';
    this.dialBox.style.display = s.speedo === 'dial' ? '' : 'none';
    this.dialKey = ''; // rebuild the dial's ticks for the units
    this.resize();
  }

  /** The window changed: the HUD's unit (px per Slate unit) follows the shortest side, like UE's DPI scale. */
  resize(w = innerWidth, h = innerHeight): void {
    const dpi = Math.min(w, h) / 1080;
    const u = dpi * this.cfg.scale * (this.s.size / 100);
    this.root.style.setProperty('--d', `${dpi}px`);
    this.root.style.setProperty('--u', `${u}px`);
    this.root.style.setProperty('--df', `${dpi * PT}px`);
    this.root.style.setProperty('--uf', `${u * PT}px`);
  }

  update(run: StageRun, info: HudInfo, now = performance.now() / 1000): void {
    const dt = this.last ? Math.min(Math.max(now - this.last, 0), 0.1) : 0;
    this.last = now;
    const phase = run.phase;
    const results = phase === 'results';
    this.root.classList.toggle('panel-open', results || this.panelOpen);

    // timer: stage time; the penalties are listed under it
    this.timer.textContent = formatTime(Math.min(run.clock, run.flow.time_cap_s));
    this.posEl.textContent = this.feed.position ?? '';
    this.posEl.style.display = this.feed.position ? '' : 'none';
    const gd = this.feed.ghostDelta;
    this.ghostEl.style.display = gd !== null && phase !== 'intro' && phase !== 'countdown' ? '' : 'none';
    if (gd !== null) {
      const d = Math.round(gd * 100) / 100; // rounded first, so a tiny lead never reads -0.00
      this.ghostVal.textContent = `${d >= 0 ? '+' : '-'}${Math.min(Math.abs(d), 99.99).toFixed(2)}`;
      this.ghostVal.style.color = gd <= -0.005 ? '#2E9E45' : '#D9301C';
    }
    const age = run.sincePenalty;
    // the original's tabular text gives a space a digit's width: a figure space here
    this.pop.textContent = `+${run.flow.recover_penalty_s.toFixed(1)}\u2007s`;
    this.pop.style.display = age < 2.3 ? '' : 'none';
    this.pop.style.opacity = String(age < 1.5 ? 1 : Math.min(Math.max(1 - (age - 1.5) / 0.8, 0), 1));
    this.pens.textContent = run.recovers > 0 ? `penalties\u2007+${run.penalties.toFixed(1)}\u2007s` : '';
    this.pens.style.display = run.recovers > 0 ? '' : 'none';
    this.best.textContent = this.feed.best ?? '';
    this.best.style.display = this.feed.best ? '' : 'none';

    // progress
    const p = Math.min(Math.max(info.progress, 0), 1);
    this.barFill.style.height = `calc(var(--d) * ${(404 * p).toFixed(2)})`;
    this.barMark.style.bottom = `calc(var(--d) * ${(8 + 404 * p).toFixed(2)})`;

    // speed
    const v = this.s.units === 'mph' ? info.kmh * 0.621371 : info.kmh;
    if (this.s.speedo === 'dial') this.updateDial(v, dt);
    else this.speedVal.textContent = String(Math.round(Math.abs(v)));

    // gear: after the finish or a retirement the coast's standstill reverse must not read as r
    let gear = info.gear;
    if (gear < 0 && (phase === 'finished' || results)) gear = 0;
    this.updateGate(gear, info.gears, dt);

    // damage lights
    this.updateLights(info.damage, now);

    // intro card, countdown, results
    let card = '';
    if (phase === 'intro' || phase === 'countdown') card = `<div class="name">${esc(info.stageName.toLowerCase())}</div><div class="sub">${esc(info.subtitle)}</div>`;
    if (card !== this.cardKey) {
      this.cardKey = card;
      this.card.innerHTML = card;
    }
    this.card.style.display = card && !results && !this.panelOpen ? '' : 'none';
    const cd = run.callout;
    this.countdown.textContent = cd ?? '';
    this.countdown.style.display = cd ? '' : 'none';
    this.countdown.style.color = cd === 'go' ? 'var(--go)' : '#fff';
    // the results panel is the menus' (src/menu/stageMenus.ts): restart, choose another stage, main menu
    this.results.style.display = 'none';
    this.dip.style.opacity = age < 0.6 ? String(0.92 * (1 - age / 0.6)) : '0';
  }

  private updateLights(damage: HudInfo['damage'], now: number): void {
    const D = this.cfg.damage;
    this.lights.style.display = damage ? '' : 'none';
    if (!damage) return;
    const flashOn = (now * D.flash_hz) % 1 < 0.5;
    for (const c of this.cells) {
      const d = damage.parts[c.part] ?? 0;
      const st = damage.terminal ? 4 : d >= D.broken_from ? 4 : d >= D.major_from ? 3 : d >= D.damaged_from ? 2 : d >= D.minor_from ? 1 : 0;
      if (st !== c.state) {
        if (c.state >= 0) c.changed = now;
        c.state = st;
      }
      const lit = st === 2 || st === 4 || ((st === 1 || st === 3) && flashOn);
      const on = st >= 3 ? this.red : this.yellow;
      // a short pulse when a light changes
      const age = now - c.changed;
      const grow = 1 + 0.18 * (D.pulse_s > 0 && age < D.pulse_s ? Math.sin((age / D.pulse_s) * Math.PI) : 0);
      const key = `${lit ? 1 : 0}${st >= 3 ? 'r' : 'y'}`;
      if (c.cell.dataset.k !== key) {
        c.cell.dataset.k = key;
        if (lit) {
          c.cell.style.background = css([...mix(this.lens, on, D.lit_lens_mix).slice(0, 3), 1] as [number, number, number, number]);
          c.cell.style.boxShadow = `inset 0 0 0 calc(var(--u) * ${D.lit_rim}) ${css(on)}`;
          c.icon.style.background = css(on);
        } else {
          c.cell.style.background = 'var(--lens)';
          c.cell.style.boxShadow = 'none';
          c.icon.style.background = css([255, 255, 255, D.outline_alpha]);
        }
        const url = lit ? c.icon.dataset.on! : c.icon.dataset.off!;
        c.icon.style.maskImage = url;
        c.icon.style.webkitMaskImage = url;
      }
      c.icon.style.transform = grow !== 1 ? `scale(${grow.toFixed(3)})` : '';
    }
  }

  // ------------------------------------------------------------------ gear gate (SRallyGearGate)
  private buildGate(gears: number): void {
    const G = this.cfg.gear;
    const slots = Math.max(G.min_slots, gears);
    const cols = 1 + Math.floor((slots + 1) / 2); // r + one column per pair of gears
    const pad = Math.max(G.pad, G.knob * 0.5 + 1 + G.knob_margin);
    const W = 2 * pad + (cols - 1) * G.cell_w, H = 2 * pad + 2 * G.cell_h;
    const top = pad, bottom = pad + 2 * G.cell_h, mid = pad + G.cell_h;
    const slot = (g: number): [number, number] =>
      g === 0 ? [pad + (cols - 1) * G.cell_w * 0.5, mid] : g < 0 ? [pad, top] : [pad + (1 + Math.floor((g - 1) / 2)) * G.cell_w, g % 2 === 1 ? top : bottom];
    this.gate.textContent = '';
    this.gate.style.width = `calc(var(--u) * ${W})`;
    this.gate.style.height = `calc(var(--u) * ${H})`;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: '100%' });
    this.gate.appendChild(svg);
    const line = 'rgba(39,39,43,0.35)', off = 'rgba(39,39,43,0.22)';
    svgEl('line', { x1: pad, y1: mid, x2: pad + (cols - 1) * G.cell_w, y2: mid, stroke: line, 'stroke-width': G.line }, svg);
    for (let c = 0; c < cols; c++) {
      const x = pad + c * G.cell_w;
      const up = c === 0 ? -1 : 2 * c - 1, down = c === 0 ? 0 : 2 * c;
      svgEl('line', { x1: x, y1: top, x2: x, y2: mid, stroke: up > gears ? off : line, 'stroke-width': G.line }, svg);
      if (down > 0 && down <= slots) svgEl('line', { x1: x, y1: mid, x2: x, y2: bottom, stroke: down > gears ? off : line, 'stroke-width': G.line }, svg);
    }
    for (let g = -1; g <= slots; g++) {
      if (g === 0) continue;
      const [x, y] = slot(g);
      svgEl('circle', { cx: x, cy: y, r: G.knob * 0.5, fill: '#fff' }, svg);
      const t = svgEl('text', { x, y, class: 'label', 'font-size': G.font * PT, fill: g <= gears ? 'rgba(39,39,43,0.75)' : off }, svg);
      t.textContent = g < 0 ? 'r' : String(g);
    }
    const knob = svgEl('circle', { r: G.knob * 0.5 + 1, fill: 'var(--ink)' }, svg);
    const knobLabel = svgEl('text', { class: 'label', 'font-size': G.font * PT, fill: '#faf9f4' }, svg);
    this.gateSvg = { svg, knob, knobLabel, slot, gears };
    this.knob = [-1, -1];
  }

  private updateGate(gear: number, gears: number, dt: number): void {
    if (!this.gateSvg || this.gateSvg.gears !== gears) this.buildGate(gears);
    const { knob, knobLabel, slot } = this.gateSvg;
    const target = slot(gear);
    if (this.knob[0] < 0) this.knob = [...target];
    // knob eases toward the slot along the straight line (fast: a shift takes ~0.1 s)
    this.knob[0] = interp(this.knob[0], target[0], dt, 22);
    this.knob[1] = interp(this.knob[1], target[1], dt, 22);
    knob.setAttribute('cx', this.knob[0].toFixed(2));
    knob.setAttribute('cy', this.knob[1].toFixed(2));
    knob.setAttribute('fill', gear < 0 ? UE_ACCENT : 'var(--ink)');
    const near = Math.hypot(this.knob[0] - target[0], this.knob[1] - target[1]) < this.cfg.gear.knob * 0.3;
    knobLabel.textContent = gear !== 0 && near ? (gear < 0 ? 'r' : String(gear)) : '';
    knobLabel.setAttribute('x', this.knob[0].toFixed(2));
    knobLabel.setAttribute('y', this.knob[1].toFixed(2));
  }

  // ------------------------------------------------------------------ dial (SRallySpeedDial)
  private buildDial(): void {
    const S = this.cfg.speed;
    const mph = this.s.units === 'mph';
    const max = Math.max(10, mph ? S.dial_max_mph : S.dial_max_kmh);
    const major = Math.max(5, mph ? S.major_mph : S.major_kmh);
    const R = S.dial_radius, aw = S.dial_arc_width, sweep = S.dial_sweep_deg;
    const size = 2 * R + 4, O = size / 2, K = R / 66;
    const Ra = R - aw * 0.5 - 7 * K;
    this.dialBox.textContent = '';
    this.dialBox.style.width = this.dialBox.style.height = `calc(var(--u) * ${size})`;
    const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: '100%', height: '100%' });
    this.dialBox.appendChild(svg);
    svgEl('circle', { cx: O, cy: O, r: R + 1.5, fill: 'rgba(0,0,0,0.18)' }, svg);
    svgEl('circle', { cx: O, cy: O, r: R, fill: 'var(--paper)' }, svg);
    svgEl('path', { d: arcPath(O, Ra, sweep, 0, 1), fill: 'none', stroke: 'rgba(39,39,43,0.18)', 'stroke-width': aw }, svg);
    const fill = svgEl('path', { d: '', fill: 'none', stroke: 'var(--ink)', 'stroke-width': aw }, svg);
    for (let s = 0; s <= max + 0.01; s += major * 0.5) {
      const isMajor = Math.abs(s % major) < 0.01;
      const f = s / max;
      const r0 = Ra - aw * 0.5 - 3 * K, r1 = r0 - (isMajor ? 7 : 3.5) * K;
      const [x0, y0] = at(O, r0, sweep, f), [x1, y1] = at(O, r1, sweep, f);
      svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'rgba(39,39,43,0.55)', 'stroke-width': isMajor ? 2 : 1.2 }, svg);
    }
    const needle = svgEl('line', { stroke: 'var(--accent)', 'stroke-width': 3 * K }, svg);
    const num = svgEl('text', { x: O, y: O + R * 0.1, class: 'dial-num', 'font-size': S.dial_number_font * PT, fill: UE_INK }, svg);
    const units = svgEl('text', { x: O, y: O + R * 0.52, class: 'dial-units', 'font-size': S.dial_units_font * PT, fill: 'rgba(39,39,43,0.6)' }, svg);
    units.textContent = mph ? 'mph' : 'km/h';
    this.dial = { fill, needle, num, units, R, O, Ra, max };
  }

  private updateDial(v: number, dt: number): void {
    const key = `${this.s.units}`;
    if (key !== this.dialKey || !this.dial) {
      this.dialKey = key;
      this.buildDial();
    }
    const { fill, needle, num, R, O, Ra, max } = this.dial;
    const S = this.cfg.speed;
    v = Math.max(0, Math.abs(v));
    // the needle eases toward the speed so it doesn't twitch with the wheel-speed noise
    this.dialShown = dt > 0 ? interp(this.dialShown, v, dt, 14) : v;
    const f = Math.min(Math.max(this.dialShown / max, 0), 1);
    fill.setAttribute('d', f > 0.002 ? arcPath(O, Ra, S.dial_sweep_deg, 0, f) : '');
    const [tx, ty] = at(O, Ra + S.dial_arc_width * 0.5, S.dial_sweep_deg, f);
    const [bx, by] = at(O, R * 0.3, S.dial_sweep_deg, f);
    needle.setAttribute('x1', bx.toFixed(2));
    needle.setAttribute('y1', by.toFixed(2));
    needle.setAttribute('x2', tx.toFixed(2));
    needle.setAttribute('y2', ty.toFixed(2));
    num.textContent = String(Math.round(v));
  }
}

/** A point on the dial at `frac` of the sweep (0 = lower left, 1 = lower right), radius r. */
function at(O: number, r: number, sweep: number, frac: number): [number, number] {
  const a = ((90 + sweep * 0.5 - sweep * frac) * Math.PI) / 180;
  return [O + r * Math.cos(a), O - r * Math.sin(a)];
}

function arcPath(O: number, r: number, sweep: number, f0: number, f1: number): string {
  const [x0, y0] = at(O, r, sweep, f0), [x1, y1] = at(O, r, sweep, f1);
  const large = sweep * (f1 - f0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
