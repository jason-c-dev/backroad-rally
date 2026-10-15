// Frame-time HUD: fps, mean and worst frame time over the last second (spikes matter
// more than the average; handoff §9), the backend and the canvas size.
export class FrameHud {
  private el: HTMLElement;
  private times: number[] = [];
  private last = 0;
  private shown = 0;
  extra = '';

  constructor(parent: HTMLElement, private backend: string) {
    this.el = document.createElement('div');
    this.el.id = 'frame-hud';
    parent.appendChild(this.el);
  }

  frame(now: number, w: number, h: number): void {
    if (this.last) this.times.push(now - this.last);
    this.last = now;
    let sum = 0;
    while (this.times.length) {
      sum = this.times.reduce((a, b) => a + b, 0);
      if (sum <= 1000 || this.times.length < 2) break;
      this.times.shift();
    }
    if (now - this.shown < 250 || !this.times.length) return;
    this.shown = now;
    const n = this.times.length;
    const mean = sum / n;
    const worst = Math.max(...this.times);
    this.el.textContent =
      `${this.backend} · ${(1000 / mean).toFixed(0)} fps · ${mean.toFixed(1)} ms · max ${worst.toFixed(1)} ms` +
      ` · ${w}×${h} (${(w / h).toFixed(2)}:1)` +
      (this.extra ? `\n${this.extra}` : '');
  }
}
