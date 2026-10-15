// Slice 1 only: a kinematic bicycle model so the camera and wheels have something to
// follow. No physics, no grip. Slice 2 replaces it with the raycast vehicle (handoff §5).
import * as THREE from 'three/webgpu';
import { ms } from '../ue';

export class PlaceholderDrive {
  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(1, 0, 0);
  readonly velocity = new THREE.Vector3();
  heading = 0; // three rotation.y
  speed = 0; // m/s along the nose, < 0 reversing
  steerAngle = 0; // front wheel angle, rad, + = right

  constructor(
    private wheelbase: number,
    private topSpeed = ms(160),
  ) {}

  update(dt: number, throttle: number, brake: number, steer: number): void {
    const accel = throttle * 6 - brake * (this.speed > 0.5 ? 12 : 4) - 0.02 * this.speed * Math.abs(this.speed);
    this.speed = Math.min(Math.max(this.speed + accel * dt, -ms(25)), this.topSpeed);
    if (!throttle && !brake && Math.abs(this.speed) < 0.3) this.speed = 0;

    // speed-sensitive lock (handoff §5.3): 38 deg max, 14.3 deg at 100 km/h
    const v = Math.abs(this.speed) * 3.6;
    const lock = (38 * Math.PI) / 180 * (0.22 + 0.78 / (1 + (v / 50) ** 2));
    this.steerAngle = steer * lock;

    // a right turn (UE yaw +) is three rotation.y -
    // no tyres here, so cap the turn at about 1 g of lateral acceleration
    let yawRate = (this.speed * Math.tan(this.steerAngle)) / this.wheelbase;
    const cap = 9.81 / Math.max(Math.abs(this.speed), 1);
    yawRate = Math.min(Math.max(yawRate, -cap), cap);
    this.heading -= yawRate * dt;
    this.forward.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
    this.velocity.copy(this.forward).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);
  }
}
