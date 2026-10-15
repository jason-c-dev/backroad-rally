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

  advance(frameDt: number, input: DriverInput): void {
    this.acc = Math.min(this.acc + frameDt, PHYSICS_DT * MAX_STEPS_PER_FRAME);
    const v = this.vehicle;
    while (this.acc >= PHYSICS_DT) {
      this.prevPos.copy(v.position);
      this.prevRot.copy(v.quaternion);
      v.input = input;
      v.step(PHYSICS_DT);
      this.world.step();
      v.readBody();
      this.acc -= PHYSICS_DT;
      this.steps++;
    }
    const alpha = this.acc / PHYSICS_DT;
    this.renderPos.lerpVectors(this.prevPos, v.position, alpha);
    this.renderRot.slerpQuaternions(this.prevRot, v.quaternion, alpha);
  }
}
