// The high chase camera (handoff §7, camera.json, UE RallyCameraComponent). Works in
// three axes and metres; the angles are UE degrees (pitch < 0 looks down).
import * as THREE from 'three/webgpu';
import type { CameraData } from '../data';
import { kmh } from '../ue';

/** UE FMath::FInterpTo. */
export function interpTo(cur: number, target: number, dt: number, speed: number): number {
  if (speed <= 0) return target;
  return cur + (target - cur) * Math.min(Math.max(dt * speed, 0), 1);
}

function interpAngle(cur: number, target: number, dt: number, speed: number): number {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + d * Math.min(Math.max(dt * speed, 0), 1);
}

export interface CarState {
  position: THREE.Vector3;
  /** Horizontal unit vector the nose points along. */
  forward: THREE.Vector3;
  velocity: THREE.Vector3;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  preset: number;
  private heading = 0; // angle of the camera's horizontal look direction: atan2(z, x)
  private alpha = 0; // smoothed speed effect, v / speed_ref
  private aim = new THREE.Vector3();
  private snapped = false;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(private cfg: CameraData, aspect: number) {
    this.preset = cfg.default_preset;
    this.camera = new THREE.PerspectiveCamera(cfg.presets[this.preset].fov_v_deg, aspect, 0.5, 4000);
  }

  get presetName(): string {
    return this.cfg.presets[this.preset].name;
  }

  cycle(): void {
    this.preset = (this.preset + 1) % this.cfg.presets.length;
  }

  /** The settings' camera row (-1 = camera.json's default preset). */
  setPreset(i: number): void {
    this.preset = i >= 0 && i < this.cfg.presets.length ? i : this.cfg.default_preset;
  }

  /** The settings' field of view (vertical degrees; 0 = the preset's own). */
  fovOverride = 0;

  update(dt: number, car: CarState): void {
    const c = this.cfg;
    const p = c.presets[this.preset];
    const vel = this.tmp.set(car.velocity.x, 0, car.velocity.z);
    const speed = vel.length();
    const forwardMoving = vel.dot(car.forward) > 0;

    // yaw: follow mostly the velocity above the threshold, else the nose
    const dir = this.tmp2.copy(car.forward);
    if (kmh(speed) > c.yaw_follow_min_kmh && forwardMoving) {
      dir.multiplyScalar(1 - c.yaw_velocity_weight).addScaledVector(vel, c.yaw_velocity_weight / speed).normalize();
    }
    const targetHeading = Math.atan2(dir.z, dir.x);

    const alphaTarget = Math.min(kmh(speed) / c.speed_ref_kmh, 1);
    if (!this.snapped) {
      this.heading = targetHeading;
      this.alpha = alphaTarget;
    } else {
      this.heading = interpAngle(this.heading, targetHeading, dt, c.yaw_follow_speed);
      this.alpha = interpTo(this.alpha, alphaTarget, dt, c.speed_smoothing);
    }

    const hx = Math.cos(this.heading);
    const hz = Math.sin(this.heading);

    // aim point: pivot ahead along the camera yaw plus a capped velocity look-ahead
    const look = vel.multiplyScalar(p.look_ahead_s);
    if (look.length() > p.look_ahead_max_m) look.setLength(p.look_ahead_max_m);
    const ax = car.position.x + hx * p.pivot_ahead_m + look.x;
    const ay = car.position.y;
    const az = car.position.z + hz * p.pivot_ahead_m + look.z;
    if (!this.snapped) {
      this.aim.set(ax, ay, az);
      this.snapped = true;
    } else {
      this.aim.x = interpTo(this.aim.x, ax, dt, c.position_lag_speed);
      this.aim.z = interpTo(this.aim.z, az, dt, c.position_lag_speed);
      this.aim.y = interpTo(this.aim.y, ay, dt, c.height_damping);
    }

    const a = this.alpha;
    const arm = p.arm_m * (1 + c.speed_arm_scale * a);
    const pitch = ((p.pitch_deg + c.speed_pitch_add_deg * a) * Math.PI) / 180;
    const cp = Math.cos(pitch);
    // camera sits back along the look direction (which points down for pitch < 0)
    this.camera.position.set(this.aim.x - hx * cp * arm, this.aim.y - Math.sin(pitch) * arm, this.aim.z - hz * cp * arm);
    this.camera.lookAt(this.aim);

    const fov = (this.fovOverride > 1 ? this.fovOverride : p.fov_v_deg) + c.speed_fov_add_deg * a;
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
