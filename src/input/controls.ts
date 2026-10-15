// Keyboard and gamepad -> the driver's input (handoff §5.4, input.json). Steering smoothing lives
// in the car (digital ramp for keys, response curve for the stick), so this only reads devices.
//
// | action            | keyboard        | gamepad (standard mapping) |
// | throttle / brake  | W S / up down   | RT / LT                    |
// | steer             | A D / left right| left stick, deadzone 0.08  |
// | handbrake         | Space           | L1                         |
// | recover           | R               | Y                          |
// | camera            | C               | X                          |
// | pause             | Esc             | Start                      |
import type { DriverInput } from '../sim/vehicle';

const DEADZONE = 0.08;
const PAD = { a: 0, b: 1, x: 2, y: 3, l1: 4, r1: 5, l2: 6, r2: 7, back: 8, start: 9 };

export type Action = 'camera' | 'recover' | 'pause' | 'livery' | 'assist';

export class Controls {
  private down = new Set<string>();
  private pressed = new Set<Action>();
  private padPrev: boolean[] = [];
  /** 'keys' or 'pad': whichever was used last. */
  device: 'keys' | 'pad' = 'keys';

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      this.device = 'keys';
      this.down.add(e.code);
      if (!e.repeat) {
        const a = KEY_ACTIONS[e.code];
        if (a) this.pressed.add(a);
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Poll once per frame: the driver's input, plus actions pressed since the last poll. */
  poll(): { input: DriverInput; actions: Set<Action> } {
    const keys: DriverInput = {
      throttle: this.held('KeyW', 'ArrowUp') ? 1 : 0,
      brake: this.held('KeyS', 'ArrowDown') ? 1 : 0,
      steer: (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0),
      digitalSteer: true,
      handbrake: this.held('Space'),
    };
    let input = keys;
    const pad = this.gamepad();
    if (pad) {
      const b = (i: number) => pad.buttons[i]?.value ?? 0;
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      const x = pad.axes[0] ?? 0;
      const steer = Math.abs(x) < DEADZONE ? 0 : Math.sign(x) * (Math.abs(x) - DEADZONE) / (1 - DEADZONE);
      const padInput: DriverInput = {
        throttle: b(PAD.r2),
        brake: b(PAD.l2),
        steer,
        digitalSteer: false,
        handbrake: pressed(PAD.l1),
      };
      const active = padInput.throttle > 0.05 || padInput.brake > 0.05 || padInput.steer !== 0 || padInput.handbrake;
      if (active) this.device = 'pad';
      if (this.device === 'pad') input = padInput;
      // edge-triggered buttons
      for (const [btn, action] of [[PAD.x, 'camera'], [PAD.y, 'recover'], [PAD.start, 'pause'], [PAD.back, 'livery']] as const) {
        const now = pressed(btn);
        if (now && !this.padPrev[btn]) {
          this.pressed.add(action);
          this.device = 'pad';
        }
        this.padPrev[btn] = now;
      }
    }
    const actions = new Set(this.pressed);
    this.pressed.clear();
    return { input, actions };
  }

  private gamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected && p.mapping === 'standard') return p;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }
}

const KEY_ACTIONS: Record<string, Action> = {
  KeyC: 'camera',
  KeyR: 'recover',
  Escape: 'pause',
  KeyL: 'livery',
  KeyT: 'assist',
};
