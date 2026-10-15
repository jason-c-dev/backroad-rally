// Fixed-step physics for the game loop: steps the world at 120 Hz however long the frame was, and
// gives the renderer the car's pose interpolated between the last two steps (handoff §3).
import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { PHYSICS_DT } from './physics';
import type { DriverInput, Vehicle } from './vehicle';

const MAX_STEPS_PER_FRAME = 8; // past this the game slows down instead of spiralling

export class Simulation {
  private acc = 0;
  private prevPos = new Vector3();
  private prevRot = new Quaternion();
  /** Interpolated pose for rendering. */
  readonly renderPos = new Vector3();
  readonly renderRot = new Quaternion();
  steps = 0;
  /** Past this many steps per frame the game slows down instead of spiralling (headless runs raise it). */
  maxSteps = MAX_STEPS_PER_FRAME;
  /** Wall time of the last frame's physics steps (ms), for the perf readout. */
  lastStepMs = 0;

  constructor(readonly world: RAPIER.World, readonly vehicle: Vehicle) {
    this.snap();
  }

  /** After a teleport: no interpolation from the old pose. */
  snap(): void {
    this.vehicle.readBody();
    this.prevPos.copy(this.vehicle.position);
    this.prevRot.copy(this.vehicle.quaternion);
    this.renderPos.copy(this.prevPos);
    this.renderRot.copy(this.prevRot);
    this.acc = 0;
  }

  /**
   * Run the fixed steps due this frame. `perStep`, when given, is called before every step with the
   * step's dt and returns the input for it (the stage flow, tracking and the autopilot live there).
   */
  advance(frameDt: number, input: DriverInput, perStep?: (dt: number, input: DriverInput) => DriverInput): void {
    this.acc = Math.min(this.acc + frameDt, PHYSICS_DT * this.maxSteps);
    const v = this.vehicle;
    const t0 = performance.now();
    while (this.acc >= PHYSICS_DT) {
      this.prevPos.copy(v.position);
      this.prevRot.copy(v.quaternion);
      v.input = perStep ? perStep(PHYSICS_DT, input) : input;
      v.step(PHYSICS_DT);
      this.world.step();
      v.readBody();
      this.acc = Math.max(0, this.acc - PHYSICS_DT); // a teleport in perStep snaps acc to 0
      this.steps++;
    }
    this.lastStepMs = performance.now() - t0;
    const alpha = this.acc / PHYSICS_DT;
    this.renderPos.lerpVectors(this.prevPos, v.position, alpha);
    this.renderRot.slerpQuaternions(this.prevRot, v.quaternion, alpha);
  }
}
