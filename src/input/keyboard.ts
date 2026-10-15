// Keyboard state for slice 1 (handoff §5.4). Steering ramps toward the key target at
// 2.5/s and returns at 5/s; the speed-soft keys and the gamepad arrive with the vehicle.
export class Keyboard {
  private down = new Set<string>();
  private pressed = new Set<string>();
  steer = 0;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True once per key press; call once per frame. */
  tapped(code: string): boolean {
    return this.pressed.has(code);
  }

  get throttle(): number {
    return this.held('KeyW', 'ArrowUp') ? 1 : 0;
  }

  get brake(): number {
    return this.held('KeyS', 'ArrowDown') ? 1 : 0;
  }

  get handbrake(): boolean {
    return this.held('Space');
  }

  update(dt: number): void {
    const target = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const returning = target === 0 || Math.sign(target) !== Math.sign(this.steer);
    const rate = returning ? 5 : 2.5;
    const d = target - this.steer;
    this.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
