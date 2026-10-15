// The stage HUD for now: timer top right (penalty pop below it), vertical progress bar on the
// left, speed bottom right, gear bottom centre, and a centre card for the intro, countdown and
// results. Lowercase, tabular digits; hud.json sizes and the full layout come with game flow.
import { formatTime, type StageRun } from '../game/stageRun';

export class StageHud {
  private root: HTMLElement;
  private timer: HTMLElement;
  private pen: HTMLElement;
  private bar: HTMLElement;
  private speed: HTMLElement;
  private gear: HTMLElement;
  private card: HTMLElement;
  private dip: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'stage-hud';
    this.root.innerHTML = `
      <div class="hud-timer"><span class="t">0:00.000</span><span class="pen"></span></div>
      <div class="hud-progress"><div class="fill"></div></div>
      <div class="hud-speed"><span class="v">0</span><span class="u">km/h</span></div>
      <div class="hud-gear">1</div>
      <div class="hud-card"></div>
      <div class="hud-dip"></div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.timer = q('.hud-timer .t');
    this.pen = q('.hud-timer .pen');
    this.bar = q('.hud-progress .fill');
    this.speed = q('.hud-speed .v');
    this.gear = q('.hud-gear');
    this.card = q('.hud-card');
    this.dip = q('.hud-dip');
  }

  update(run: StageRun, info: { stageName: string; direction: string; kmh: number; gear: number; progress: number }): void {
    this.timer.textContent = formatTime(run.total);
    this.pen.textContent = run.sincePenalty < 2 ? '+5.000' : run.penalties > 0 ? `+${run.penalties.toFixed(3)}` : '';
    this.pen.classList.toggle('pop', run.sincePenalty < 2);
    this.bar.style.height = `${(info.progress * 100).toFixed(1)}%`;
    this.speed.textContent = String(Math.round(Math.abs(info.kmh)));
    this.gear.textContent = info.gear < 0 ? 'r' : info.gear === 0 ? 'n' : String(info.gear);
    let card = '';
    if (run.phase === 'intro') card = `<div class="big">${info.stageName}</div><div>${info.direction}</div>`;
    else if (run.callout) card = `<div class="huge">${run.callout}</div>`;
    else if (run.phase === 'results') {
      card = run.dnf
        ? `<div class="big">did not finish</div><div>enter to restart</div>`
        : `<div class="big">${formatTime(run.total)}</div><div>${run.recovers ? `${formatTime(run.clock)} + ${run.penalties.toFixed(0)} s penalties · ` : ''}enter to restart</div>`;
    }
    if (this.card.innerHTML !== card) this.card.innerHTML = card;
    this.card.style.display = card ? '' : 'none';
    this.dip.style.opacity = run.sincePenalty < 0.5 ? String(1 - run.sincePenalty / 0.5) : '0';
  }
}
