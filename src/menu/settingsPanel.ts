// The settings screen (the original's SRallySettings), shared by the menus and the pause menu. Every change
// applies at once and is saved at once (src/settings.ts). Three pages: the game and the HUD (the original's
// page 1), sound (every mix group: the original had four volume rows; the port shows all of them) and
// display & graphics (page 2).
import { FPS_LIMITS, GAME_DEFAULTS, HUD_DEFAULTS, DISPLAY_DEFAULTS, QUALITY_CHOICES, type DisplaySettings, type GameSettings, type HudSettings, type UserVolumes, type VolumeGroup } from '../settings';
import { MenuController, Row, el, label, panel, spacer, u, type OptionSpec, type Screen } from './ui';

export interface SettingsHost {
  /** camera.json preset names and the default preset; the preset's own vertical FOV. */
  cameraNames: string[];
  defaultCamera: number;
  presetFov(preset: number): number;
  game: GameSettings;
  display: DisplaySettings;
  hud: HudSettings;
  volumes: UserVolumes;
  /** Apply and save a section after a change. */
  applyGame(): void;
  applyDisplay(): void;
  applyHud(): void;
  applyVolumes(): void;
  /** The display row: window or fullscreen (needs the key or click that changed it). */
  isFullscreen(): boolean;
  setFullscreen(on: boolean): void;
}

type Page = 'main' | 'sound' | 'display';

const pct = (v: number) => (v <= 0.001 ? 'off' : `${Math.round(v * 100)}%`);
const step = (v: number, dir: number, s: number, lo: number, hi: number) => Math.min(Math.max(Math.round((v + dir * s) / s) * s, lo), hi);
const cycle = <T>(list: readonly T[], cur: T, dir: number): T => list[(((list.indexOf(cur) + dir) % list.length) + list.length) % list.length];

const DRAW_NAMES = ['near', 'medium', 'far', 'max'];
/** The draw distance "(default)" level: far (the game's default, x2 the base fade bands). */
const DRAW_DEFAULT = 2;

const SOUND_ROWS: [string, VolumeGroup | 'master'][] = [
  ['master volume', 'master'], ['music', 'music'], ['effects', 'sfx'], ['engine', 'engine'], ['tyres and surface', 'surface'],
  ['crowd', 'crowd'], ['ambience', 'ambience'], ['weather', 'weather'], ['interface', 'ui'],
];

export function settingsScreen(menu: MenuController, host: SettingsHost, onClose: () => void, page: Page = 'main', focusRow?: string): Screen {
  const p = panel('settings', [36, 44], 0.8);
  const h = el('div', 'heading', p);
  h.style.padding = `0 0 ${u(22)} ${u(20)}`;
  label(h, page === 'main' ? 'settings' : page === 'sound' ? 'sound' : 'display & graphics', 34, 600);
  const list = el('div', 'list', p);
  const rows: Row[] = [];
  const opt = (spec: Omit<OptionSpec, 'size' | 'minWidth' | 'valueWidth'>) => {
    const w = el('div', '', list);
    w.style.padding = `${u(1)} 0`;
    rows.push(new Row(menu, w, { ...spec, size: 21, minWidth: 600, valueWidth: 180 }));
  };
  const item = (text: string, onPress: () => void, top = 1) => {
    const w = el('div', '', list);
    w.style.padding = `${u(top)} 0 ${u(1)}`;
    rows.push(new Row(menu, w, { text, onPress, size: 21, minWidth: 600 }));
  };
  const go = (to: Page, focus?: string) => menu.show(settingsScreen(menu, host, onClose, to, focus));
  const g = host.game, d = host.display, hud = host.hud, v = host.volumes;
  let hint = '';

  if (page === 'main') {
    const cam = () => (g.camera >= 0 && g.camera < host.cameraNames.length ? g.camera : host.defaultCamera);
    opt({ text: 'camera', value: () => host.cameraNames[cam()] ?? 'default', onAdjust: (dir) => {
      const n = Math.max(1, host.cameraNames.length);
      g.camera = (cam() + dir + n) % n;
      host.applyGame();
    } });
    opt({ text: 'field of view', value: () => `${Math.round(g.fov > 1 ? g.fov : host.presetFov(cam()))}°`, onAdjust: (dir) => {
      g.fov = step(g.fov > 1 ? g.fov : host.presetFov(cam()), dir, 2, 30, 56);
      host.applyGame();
    } });
    opt({ text: 'stability assist', value: () => pct(g.stability), onAdjust: (dir) => {
      g.stability = step(g.stability, dir, 0.25, 0, 1);
      host.applyGame();
    } });
    opt({ text: 'counter-steer assist', value: () => pct(g.countersteer), onAdjust: (dir) => {
      g.countersteer = step(g.countersteer, dir, 0.25, 0, 1);
      host.applyGame();
    } });
    opt({ text: 'traction assist', value: () => (g.tractionAssist ? 'on' : 'off'), onAdjust: () => {
      g.tractionAssist = !g.tractionAssist;
      host.applyGame();
    } });
    item('sound  ›', () => go('sound'));
    opt({ text: 'speed units', value: () => (hud.units === 'mph' ? 'mph' : 'km/h'), onAdjust: () => {
      hud.units = hud.units === 'mph' ? 'kmh' : 'mph';
      host.applyHud();
    } });
    opt({ text: 'speed display', value: () => hud.speedo, onAdjust: () => {
      hud.speedo = hud.speedo === 'dial' ? 'number' : 'dial';
      host.applyHud();
    } });
    opt({ text: 'hud size', value: () => `${hud.size}%`, onAdjust: (dir) => {
      hud.size = step(hud.size, dir, 10, 80, 130);
      host.applyHud();
    } });
    opt({ text: 'ghost of best run', value: () => (g.ghost ? 'on' : 'off'), onAdjust: () => {
      g.ghost = !g.ghost;
      host.applyGame();
    } });
    // rival ghosts: off / 3 / all (quick stage and time attack; the career races all of them unless off)
    opt({ text: 'rival ghosts', value: () => (g.rivalGhosts <= 0 ? 'off' : g.rivalGhosts >= 99 ? 'all' : '3'), onAdjust: (dir) => {
      const v = [0, 3, 99];
      g.rivalGhosts = v[(v.indexOf(g.rivalGhosts) + (dir < 0 ? 2 : 1)) % 3];
      host.applyGame();
    } });
    item('display & graphics  ›', () => go('display'));
    item('reset to defaults', () => {
      Object.assign(g, GAME_DEFAULTS);
      Object.assign(d, DISPLAY_DEFAULTS);
      Object.assign(hud, { ...HUD_DEFAULTS, debug: hud.debug });
      host.applyGame();
      host.applyDisplay();
      host.applyHud();
    }, 18);
    item('back', onClose);
    hint = 'left / right or click ‹ › to change  ·  changes apply at once\ntraction assist: on tames wheelspin at speed, off lets the tail slide\nrival ghosts: the career races all of them unless off; quick stage the 3 nearest your best';
  } else if (page === 'sound') {
    for (const [name, key] of SOUND_ROWS) {
      opt({ text: name, value: () => pct(key === 'master' ? v.master : v.groups[key]), onAdjust: (dir) => {
        if (key === 'master') v.master = step(v.master, dir, 0.1, 0, 1);
        else v.groups[key] = step(v.groups[key], dir, 0.1, 0, 1);
        host.applyVolumes();
      } });
    }
    opt({ text: 'sound', value: () => (v.muted ? 'muted' : 'on'), onAdjust: () => {
      v.muted = !v.muted;
      host.applyVolumes();
    } });
    item('‹  back to settings', () => go('main', 'sound'), 18);
    hint = 'each group on top of the master volume  ·  m mutes  ·  . next song';
  } else {
    opt({ text: 'display', value: () => (host.isFullscreen() ? 'fullscreen' : 'window'), onAdjust: () => host.setFullscreen(!host.isFullscreen()) });
    opt({ text: 'graphics quality', value: () => d.quality, onAdjust: (dir) => {
      d.quality = cycle(QUALITY_CHOICES, d.quality, dir);
      host.applyDisplay();
    } });
    opt({ text: 'frame-rate limit', value: () => (d.fpsLimit <= 0 ? 'uncapped' : `${d.fpsLimit} fps`), onAdjust: (dir) => {
      const i = Math.max(0, (FPS_LIMITS as readonly number[]).indexOf(d.fpsLimit));
      d.fpsLimit = FPS_LIMITS[Math.min(Math.max(i + dir, 0), FPS_LIMITS.length - 1)];
      host.applyDisplay();
    } });
    opt({ text: 'render resolution', value: () => (d.renderScale <= 0 ? 'auto' : `${d.renderScale}%`), onAdjust: (dir) => {
      // auto, then 100% down to 50% in steps of 5
      const cur = d.renderScale <= 0 ? 105 : d.renderScale;
      const next = cur - dir * 5;
      d.renderScale = next > 100 ? 0 : Math.max(50, next);
      host.applyDisplay();
    } });
    opt({ text: 'draw distance', value: () => (d.drawDistance < 0 ? `${DRAW_NAMES[DRAW_DEFAULT]} (default)` : DRAW_NAMES[d.drawDistance]), onAdjust: (dir) => {
      const cur = d.drawDistance < 0 ? DRAW_DEFAULT : d.drawDistance;
      d.drawDistance = Math.min(Math.max(cur + dir, 0), 3);
      host.applyDisplay();
    } });
    item('‹  back to settings', () => go('main', 'display'), 18);
    hint = 'graphics quality: auto picks the highest that holds 60 fps (the original\'s epic is high)\nframe-rate limit: a cap your GPU always holds runs smoothest\nrender resolution: draws fewer pixels and the browser stretches them\ndraw distance: how far trees and plants show; farther costs frame rate\nrender resolution and draw distance are separate knobs';
  }
  spacer(p, 22);
  const hl = label(p, hint, 15, 400, true);
  hl.style.paddingLeft = u(20);
  // back on the main page the highlight returns to the row that opened the sub page
  const focus = focusRow === 'sound' ? rows.findIndex((r) => r.spec.text === 'sound  ›') : focusRow === 'display' ? rows.findIndex((r) => r.spec.text === 'display & graphics  ›') : 0;
  return {
    el: p,
    rows,
    focus: Math.max(0, focus),
    onBack: page === 'main' ? onClose : () => go('main', page),
  };
}
