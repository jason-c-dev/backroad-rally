// Car tuning from cars_tuning.json: `defaults` deep-merged with `cars.<id>` (UE RallyData::LoadCarTuning).
// Values stay in the JSON's units except where a field name says otherwise; the vehicle converts.
// Traction assist on = the arcade block again with arcade.traction_assist merged over it.

export type Drivetrain = 'RWD' | 'FWD' | 'AWD';
export type Surface = 'tarmac' | 'gravel' | 'dirt' | 'grass' | 'rock' | 'water' | 'snow' | 'none';

export interface AxleTuning {
  friction: number;
  cornering_stiffness: number;
  side_slip: number;
  brake_torque: number;
  handbrake_torque: number;
  susp_max_raise_cm: number;
  susp_max_drop_cm: number;
  spring_rate: number;
  spring_preload: number;
  damping_ratio: number;
  wheel_load_ratio: number;
  rollbar_scaling: number;
}

export interface SurfaceTuning {
  grip_scale: number;
  rolling_drag: number;
  power_scale: number;
}

/** The arcade layers (UE FRallyArcadeTuning), keyed by the JSON names. */
export const ARCADE_DEFAULTS = {
  stability_default: 1, countersteer_default: 1,
  steer_yaw_accel: 60, steer_yaw_peak_kmh: 40, steer_yaw_fade_kmh: 140, steer_yaw_high_speed_scale: 0.3,
  stability_slip_start_deg: 12, stability_slip_full_deg: 35, stability_yaw_damping: 3, stability_max_slip_deg: 55,
  stability_restore_accel: 12,
  countersteer_gain: 0.7, countersteer_slip_start_deg: 6, countersteer_min_kmh: 15,
  handbrake_rear_grip: 0.55, handbrake_yaw_accel: 90, handbrake_min_kmh: 10, handbrake_yaw_full_kmh: 35,
  handbrake_yaw_fade_kmh: 110, handbrake_yaw_high_speed_scale: 0.5, handbrake_grip_in_s: 0.06, handbrake_grip_out_s: 0.12,
  handbrake_stability_scale: 0, handbrake_stability_return_s: 0.8, handbrake_countersteer_scale: 0,
  handbrake_countersteer_return_s: 0.35, handbrake_catch_damping: 3, handbrake_catch_s: 0.6,
  power_slip_start_cms: 150, power_slip_full_cms: 500, power_throttle_start: 0.5, power_throttle_full: 0.9,
  power_steer_start: 0.05, power_steer_full: 0.25, power_body_slip_start_deg: 3, power_body_slip_full_deg: 10,
  power_min_kmh: 12, power_full_kmh: 30, power_fade_kmh: 130, power_high_speed_scale: 0.5,
  power_in_s: 0.15, power_out_s: 0.3, power_rear_grip: 1, power_yaw_accel: 0, power_stability_scale: 1,
  power_countersteer_scale: 1, power_awd_scale: 1, power_front_grip: 1, power_slip_ratio_start: 0,
  power_slip_ratio_full: 0, power_fade_start_kmh: -1, power_gear_full: 99, power_gear_zero: 100,
  power_steer_start_deg: 0, power_steer_full_deg: 0, power_countersteer_cancels: 0, power_spin_smooth_s: 0,
  tc_enabled: 0, tc_low_gear: 2, tc_spin_low_cms: 500, tc_spin_high_cms: 80, tc_spin_ratio: 0, tc_cut_rate: 4,
  tc_recover_rate: 2, tc_min_throttle: 0.35, tc_share_straight: 1.15, tc_share_corner: 0,
  tc_corner_yaw_start_dps: 5, tc_corner_yaw_full_dps: 25,
  esc_yaw_gain: 0, esc_min_kmh: 45, esc_full_kmh: 75, esc_wheelbase_m: 2.45, esc_grip_g: 1.1, esc_margin_dps: 3,
  digital_soft_start_kmh: 0, digital_soft_full_kmh: 0, digital_max_high_speed: 1, digital_rate_high_speed: 1,
  air_angular_damping: 2, air_level_strength: 6, ground_angular_damping: 0.2,
  auto_recover_s: 3, stuck_speed_kmh: 2, recover_drop_cm: 60, reverse_delay_s: 0.4, reverse_hold_kmh: 3.6,
};
export type ArcadeTuning = typeof ARCADE_DEFAULTS;

export interface CarTuning {
  id: string;
  name: string;
  massKg: number;
  /** UE cm (X forward, Y right, Z up), relative to the body's base centre of mass. */
  comOffsetCm: [number, number, number];
  /** UE axes: X roll, Y pitch, Z yaw. */
  inertiaScale: [number, number, number];
  dragCoefficient: number;
  downforceCoefficient: number;
  frontalWidthCm: number;
  frontalHeightCm: number;
  maxTorqueNm: number;
  maxRpm: number;
  idleRpm: number;
  /** [rpm / max rpm, share of max torque] */
  torqueCurve: [number, number][];
  engineBrake: number;
  turbo: { enabled: boolean; lag_s: number; share: number; min_rpm_norm: number };
  gearRatios: number[];
  reverseRatio: number;
  redlineTopSpeedKmh: number;
  shiftUpRpmNorm: number;
  shiftDownRpmNorm: number;
  shiftTime: number;
  efficiency: number;
  finalDrive: number;
  drivetrain: Drivetrain;
  /** Rear share of the drive torque on AWD (Chaos FrontRearSplit: > 0.5 = more to the rear). */
  frontRearSplit: number;
  steering: {
    max_angle_deg: number;
    high_speed_ratio: number;
    high_speed_kmh: number;
    lock_half_kmh: number;
    rate: number;
    return_rate: number;
    rate_digital: number;
    return_rate_digital: number;
    analog_exponent: number;
    countersteer_headroom_deg: number;
  };
  front: AxleTuning;
  rear: AxleTuning;
  arcade: ArcadeTuning;
  arcadeAssist: ArcadeTuning;
  surfaces: Partial<Record<Surface, SurfaceTuning>>;
  /** From cars/<id>.json (the mesh): metres. */
  wheelRadius: number;
  wheelWidth: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  length: number;
  width: number;
  height: number;
}

type Json = Record<string, unknown>;

export function deepMerge(base: Json, over: Json | undefined): Json {
  if (!over) return { ...base };
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? deepMerge(b as Json, v as Json)
      : v;
  }
  return out;
}

function readArcade(src: Json | undefined, into: ArcadeTuning): ArcadeTuning {
  const out = { ...into };
  for (const k of Object.keys(out) as (keyof ArcadeTuning)[]) {
    const v = src?.[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** cars_tuning.json + cars/<id>.json -> the car's tuning. */
export function loadCarTuning(tuningJson: Json, carJson: Json, id: string): CarTuning {
  const cars = tuningJson.cars as Record<string, Json>;
  if (!cars[id]) throw new Error(`no tuning for car '${id}'`);
  const c = deepMerge(tuningJson.defaults as Json, cars[id]);
  const body = c.body as Json;
  const engine = c.engine as Json;
  const gearbox = c.gearbox as Json;
  const arcadeJson = c.arcade as Json;
  const arcade = readArcade(arcadeJson, ARCADE_DEFAULTS);
  const t: CarTuning = {
    id,
    name: (c.name as string) ?? id,
    massKg: body.mass_kg as number,
    comOffsetCm: body.com_offset_cm as [number, number, number],
    inertiaScale: body.inertia_scale as [number, number, number],
    dragCoefficient: body.drag_coefficient as number,
    downforceCoefficient: body.downforce_coefficient as number,
    frontalWidthCm: body.frontal_width_cm as number,
    frontalHeightCm: body.frontal_height_cm as number,
    maxTorqueNm: engine.max_torque_nm as number,
    maxRpm: engine.max_rpm as number,
    idleRpm: engine.idle_rpm as number,
    torqueCurve: engine.torque_curve as [number, number][],
    engineBrake: engine.engine_brake as number,
    turbo: engine.turbo as CarTuning['turbo'],
    gearRatios: gearbox.ratios as number[],
    reverseRatio: gearbox.reverse as number,
    redlineTopSpeedKmh: gearbox.redline_top_speed_kmh as number,
    shiftUpRpmNorm: gearbox.shift_up_rpm_norm as number,
    shiftDownRpmNorm: gearbox.shift_down_rpm_norm as number,
    shiftTime: gearbox.shift_time_s as number,
    efficiency: gearbox.efficiency as number,
    finalDrive: (gearbox.final_drive as number) ?? 0,
    drivetrain: (c.drivetrain as Json).type as Drivetrain,
    frontRearSplit: (c.drivetrain as Json).front_rear_split as number,
    steering: c.steering as CarTuning['steering'],
    front: c.front as unknown as AxleTuning,
    rear: c.rear as unknown as AxleTuning,
    arcade,
    arcadeAssist: readArcade(arcadeJson?.traction_assist as Json, arcade),
    surfaces: tuningJson.surfaces as CarTuning['surfaces'],
    wheelRadius: (carJson.wheel_radius_cm as number) / 100,
    wheelWidth: (carJson.wheel_width_cm as number) / 100,
    wheelbase: (carJson.wheelbase_cm as number) / 100,
    trackFront: (carJson.track_front_cm as number) / 100,
    trackRear: (carJson.track_rear_cm as number) / 100,
    length: (carJson.length_cm as number) / 100,
    width: (carJson.width_cm as number) / 100,
    height: (carJson.height_cm as number) / 100,
  };
  if (!(t.finalDrive > 0)) {
    // final drive from the redline top speed (UE ApplyTuningToComponents)
    const wheelRpmAtTop = t.redlineTopSpeedKmh / 3.6 / (2 * Math.PI * t.wheelRadius) * 60;
    t.finalDrive = t.maxRpm / Math.max(1, wheelRpmAtTop) / Math.max(0.1, t.gearRatios[t.gearRatios.length - 1]);
  }
  return t;
}

/** Torque curve share at rpm / max rpm (piecewise linear). */
export function torqueShare(t: CarTuning, rpmNorm: number): number {
  const c = t.torqueCurve;
  if (rpmNorm <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpmNorm <= c[i][0]) {
      const [x0, y0] = c[i - 1];
      const [x1, y1] = c[i];
      return y0 + (y1 - y0) * (x1 > x0 ? (rpmNorm - x0) / (x1 - x0) : 1);
    }
  }
  return c[c.length - 1][1];
}

/** Base friction of each surface (UE physical materials, Scripts/make_physmats.py). */
export const SURFACE_FRICTION: Record<Surface, number> = {
  tarmac: 1.0, gravel: 0.72, dirt: 0.65, grass: 0.55, rock: 0.85, water: 0.35, snow: 0.72, none: 1.0,
};
