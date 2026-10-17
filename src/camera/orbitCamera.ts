// The menus' turntable camera (UE URallyCameraComponent::SetOrbit, menu.json diorama.views): it circles the parked
// car slowly (turn_deg_s), looks along its orbit direction from dist_m away at `pitch`, and is shifted shift_cm to
// the left so the car sits right of the menu panel. The distance follows the car's length (fit_length_cm,
// 0.8-1.25x), so a short pip and a long kaze fill the frame alike.
import * as THREE from 'three/webgpu';
import type { OrbitView } from '../menu/data';

const DEG = Math.PI / 180;

export class OrbitCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Orbit angle (degrees, UE yaw relative to the car). */
  yaw: number;
  view: OrbitView;
  fit = 1;
  private target = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(view: OrbitView, startYaw: number, aspect: number, public turnDegS = 5) {
    this.view = view;
    this.yaw = startYaw;
    this.camera = new THREE.PerspectiveCamera(view.fov_v, aspect, 0.5, 4000);
  }

  /** The car's length (cm) against menu.json's fit length. */
  fitTo(lengthCm: number, fitLengthCm: number): void {
    this.fit = fitLengthCm > 0 ? Math.min(Math.max(lengthCm / fitLengthCm, 0.8), 1.25) : 1;
  }

  /** carYawDeg: the car's heading as a UE yaw (atan2 of three z over x). */
  update(dt: number, carPos: THREE.Vector3, carYawDeg: number): void {
    this.yaw = (this.yaw + this.turnDegS * dt) % 360;
    const v = this.view;
    const y = (carYawDeg + this.yaw + 180) * DEG;
    const p = v.pitch * DEG;
    // UE FRotator(pitch, yaw).Vector() -> three (x, z up -> y, y -> z)
    this.dir.set(Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y));
    this.target.copy(carPos).y += 0.6;
    const dist = v.dist_m * this.fit;
    const shift = v.shift_cm / 100;
    // UE right axis of the rotation (-sin yaw, cos yaw) -> three (x, z)
    this.camera.position.copy(this.target).addScaledVector(this.dir, -dist);
    this.camera.position.x -= -Math.sin(y) * shift;
    this.camera.position.z -= Math.cos(y) * shift;
    this.camera.lookAt(this.camera.position.clone().add(this.dir));
    if (Math.abs(this.camera.fov - v.fov_v) > 1e-4) {
      this.camera.fov = v.fov_v;
      this.camera.updateProjectionMatrix();
    }
  }
}
