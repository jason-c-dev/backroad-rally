// Audio overlays: "press any key for sound" until the context runs, the now-playing toast, and the
// volume panel (V): master, mute (M) and a slider per mix group, kept in localStorage, with the
// credits line. Styles are injected here so the audio stays in its own folder.
import { GROUPS } from './mix';
import type { AudioSystem } from './system';

export const CREDITS = 'sound effects and music generated with ElevenLabs · engine and UI sounds synthesised';

const CSS = `
#audio-ui { position: fixed; inset: 0; pointer-events: none; font: 12px/1.4 Inter, system-ui, sans-serif; color: #fff; z-index: 20; }
#audio-ui .hint { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px;
  background: rgba(0,0,0,.45); text-align: center; white-space: nowrap; }
#audio-ui .hint small, #audio-ui .credits { display: block; opacity: .65; font-size: 10px; }
#audio-ui .toast { position: absolute; left: 18px; bottom: 18px; padding: 5px 10px; border-radius: 6px; background: rgba(0,0,0,.45);
  opacity: 0; transition: opacity .6s; }
#audio-ui .toast.on { opacity: 1; }
#audio-ui .panel { position: absolute; right: 18px; bottom: 60px; width: 230px; padding: 10px 12px; border-radius: 8px;
  background: rgba(0,0,0,.6); pointer-events: auto; display: none; }
#audio-ui .panel.on { display: block; }
#audio-ui .panel label { display: grid; grid-template-columns: 70px 1fr 30px; align-items: center; gap: 6px; margin: 2px 0; }
#audio-ui .panel input[type=range] { width: 100%; }
#audio-ui .panel .row { display: flex; justify-content: space-between; margin-bottom: 6px; }
#audio-ui .panel .credits { margin-top: 8px; }
body.no-hud #audio-ui { display: none; }
`;

export class AudioUi {
  private root: HTMLElement;
  private hint: HTMLElement;
  private toast: HTMLElement;
  private panel: HTMLElement;
  private toastTimer = 0;

  constructor(readonly sys: AudioSystem) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'audio-ui';
    this.root.innerHTML = `
      <div class="hint">press any key for sound<small>${CREDITS}</small></div>
      <div class="toast"></div>
      <div class="panel">
        <div class="row"><b>sound</b><label style="display:flex;gap:4px;margin:0"><input type="checkbox" class="mute"> mute (m)</label></div>
        ${['master', ...GROUPS].map((g) => `<label>${g}<input type="range" min="0" max="100" data-g="${g}"><span></span></label>`).join('')}
        <div class="credits">${CREDITS}. music: . next, , previous</div>
      </div>`;
    document.body.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.hint = q('.hint');
    this.toast = q('.toast');
    this.panel = q('.panel');
    const mute = q('.mute') as HTMLInputElement;
    mute.addEventListener('change', () => this.setMuted(mute.checked));
    for (const el of this.root.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      el.addEventListener('input', () => {
        const g = el.dataset.g!;
        const v = Number(el.value) / 100;
        if (g === 'master') sys.volumes.master = v;
        else sys.volumes.groups[g as (typeof GROUPS)[number]] = v;
        sys.applyVolumes(false, true);
        this.sync();
      });
      // keep the game's keys working while a slider has focus
      el.addEventListener('keydown', (e) => e.code.startsWith('Arrow') || el.blur());
    }
    this.sync();
  }

  setMuted(m: boolean): void {
    this.sys.volumes.muted = m;
    this.sys.applyVolumes(false, true);
    this.sync();
    this.show(m ? 'sound off (m)' : 'sound on');
  }

  togglePanel(): void {
    this.panel.classList.toggle('on');
  }

  private sync(): void {
    const v = this.sys.volumes;
    (this.root.querySelector('.mute') as HTMLInputElement).checked = v.muted;
    for (const el of this.root.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      const g = el.dataset.g!;
      const x = g === 'master' ? v.master : v.groups[g as (typeof GROUPS)[number]];
      el.value = String(Math.round(x * 100));
      (el.nextElementSibling as HTMLElement).textContent = String(Math.round(x * 100));
    }
  }

  /** Per frame: the hint stays until the context runs. */
  frame(): void {
    const show = !this.sys.running && !this.sys.hidden;
    if (this.hint.style.display !== (show ? '' : 'none')) this.hint.style.display = show ? '' : 'none';
  }

  show(text: string, secs = 3): void {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('on'), secs * 1000);
  }
}
