// Game data loader: the JSON in public/data/ is the UE project's Content/Data, copied by
// tools/convert/data.mjs. It stays in UE units; convert with ue.ts when you use it.

export interface CameraPreset {
  name: string;
  arm_m: number;
  pitch_deg: number;
  fov_v_deg: number;
  pivot_ahead_m: number;
  look_ahead_s: number;
  look_ahead_max_m: number;
}

export interface CameraData {
  default_preset: number;
  presets: CameraPreset[];
  yaw_follow_min_kmh: number;
  yaw_follow_speed: number;
  yaw_velocity_weight: number;
  position_lag_speed: number;
  height_damping: number;
  speed_ref_kmh: number;
  speed_fov_add_deg: number;
  speed_pitch_add_deg: number;
  speed_arm_scale: number;
  speed_smoothing: number;
}

export interface Livery {
  name: string;
  paint1: string;
  paint2: string;
  paint3: string;
  rim: string;
}

export interface CarData {
  id: string;
  name: string;
  group: string;
  length_cm: number;
  width_cm: number;
  wheelbase_cm: number;
  wheel_radius_cm: number;
  wheel_pos_cm: Record<'fl' | 'fr' | 'rl' | 'rr', [number, number, number]>;
  liveries: Livery[];
}

export interface TestTrack {
  ground: { size_m: number; center: [number, number] };
  strips: { name: string; surface: string; start: [number, number]; yaw: number; length_m: number; width_m: number }[];
  pads: { name: string; surface: string; center: [number, number]; size_m: number }[];
  tests: { circle_radius_m: number };
  sun: { pitch: number; yaw: number; color: [number, number, number] };
}

const cache = new Map<string, Promise<unknown>>();

export function load<T>(file: string): Promise<T> {
  let p = cache.get(file);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/${file}`).then((r) => {
      if (!r.ok) throw new Error(`data/${file}: HTTP ${r.status}`);
      return r.json();
    });
    cache.set(file, p);
  }
  return p as Promise<T>;
}

export const loadCar = (id: string) => load<CarData>(`cars/${id}.json`);

export const assetUrl = (path: string) => `${import.meta.env.BASE_URL}assets/${path}`;
