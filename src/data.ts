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

/** Content hashes of the files in public/ (vite.config.ts; empty in dev and outside Vite). */
declare const __PUBLIC_HASHES__: Record<string, string> | undefined;
const HASHES: Record<string, string> = typeof __PUBLIC_HASHES__ === 'object' && __PUBLIC_HASHES__ ? __PUBLIC_HASHES__ : {};

/**
 * The URL of a file in public/ (path relative to it, e.g. `data/fx.json`), with its content hash as `?v=`: a
 * redeploy that changes the file changes the URL, so the browser's cached copy (GitHub Pages: 10 minutes) can't be
 * served in its place, and an unchanged file keeps its cache.
 */
export function publicUrl(path: string, base: string = import.meta.env.BASE_URL): string {
  const h = HASHES[path];
  return `${base}${path}${h ? `?v=${h}` : ''}`;
}

/**
 * The build gzips every GLB (vite.config.ts): GitHub Pages compresses text only, and meshopt-compressed geometry still
 * shrinks by a quarter to a third under gzip (cars by 80%). The file is fetched as `.glb.gz` and unpacked here.
 */
declare const __GLB_GZ__: boolean | undefined;
const GLB_GZ = typeof __GLB_GZ__ === 'boolean' && __GLB_GZ__;

/** The URL a GLB in public/ is fetched from (with `.gz` in a build). */
export const glbUrl = (path: string) => (GLB_GZ ? `${publicUrl(path)}`.replace(/\.glb(\?|$)/, '.glb.gz$1') : publicUrl(path));

/** Load a GLB from public/ (e.g. `assets/cars/swift.glb`) with this loader: unpacked from gzip in a build. */
export async function loadGlb<T>(loader: { loadAsync(url: string): Promise<T>; parseAsync(data: ArrayBuffer, path: string): Promise<T> }, path: string): Promise<T> {
  if (!GLB_GZ) return loader.loadAsync(publicUrl(path));
  const r = await fetch(glbUrl(path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  let data = await r.arrayBuffer();
  // still gzip (the usual case: served as application/gzip), unless a server sent it with Content-Encoding: gzip
  const b = new Uint8Array(data, 0, 2);
  if (b[0] === 0x1f && b[1] === 0x8b) data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return loader.parseAsync(data, '');
}

const cache = new Map<string, Promise<unknown>>();
const prefetched = new Set<string>();

/**
 * Download a file in public/ into the browser's HTTP cache without using it (low priority; errors ignored): what the
 * next page will need, fetched while this one waits for the player. Same URL as publicUrl, so the next page's own
 * fetch is a cache hit.
 */
export function prefetch(path: string): void {
  if (prefetched.has(path)) return;
  prefetched.add(path);
  void fetch(path.endsWith('.glb') ? glbUrl(path) : publicUrl(path), { priority: 'low' } as RequestInit).then((r) => r.arrayBuffer()).catch(() => {});
}

export function load<T>(file: string): Promise<T> {
  let p = cache.get(file);
  if (!p) {
    p = fetch(publicUrl(`data/${file}`)).then((r) => {
      if (!r.ok) throw new Error(`data/${file}: HTTP ${r.status}`);
      return r.json();
    });
    cache.set(file, p);
  }
  return p as Promise<T>;
}

export const loadCar = (id: string) => load<CarData>(`cars/${id}.json`);

