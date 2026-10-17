// What both kinds of page (the menus' diorama and a stage run) set up the same way: the renderer, the
// weather's road marks, the look's options from camera.json, and the frame-rate limit.
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Stage } from './world/stage';
import type { StageFeatures } from './world/features';
import { icePatches, puddleSites, type RoadForWeather, type WeatherDef } from './game/weather';
import { RoadMarks } from './fx/roadMarks';

/**
 * WebGPU with its built-in WebGL2 fallback; ?webgl forces the fallback for testing. Both ask for the fast GPU:
 * WebGPU through the adapter request, WebGL2 through a context made here (three's fallback doesn't pass
 * powerPreference on). Browsers may ignore it: desktop Chrome on Linux renders on the GPU it runs on, which on a
 * hybrid laptop is the integrated one.
 */
export async function createRenderer(params: URLSearchParams, trackTimestamp: boolean): Promise<{ renderer: THREE.WebGPURenderer; backend: 'webgpu' | 'webgl2' }> {
  const gpuAdapter = !params.has('webgl') && 'gpu' in navigator
    ? await (navigator as unknown as { gpu: { requestAdapter(o: object): Promise<unknown> } }).gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
    : null;
  // a software WebGPU adapter (SwiftShader: Chrome with WebGPU switched on, on an integrated GPU it can't use for it)
  // ran the game at 2-6 fps, where WebGL2 on the same machine gets the hardware and 60: use WebGL2 then
  const info = (gpuAdapter as { info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null);
  const software = !!info && (!!info.isFallbackAdapter || !!info.info?.isFallbackAdapter
    || /swiftshader|llvmpipe|software/i.test(`${info.info?.vendor ?? ''} ${info.info?.architecture ?? ''} ${info.info?.description ?? ''}`));
  const forceWebGL = !gpuAdapter || software;
  const canvas = document.createElement('canvas');
  const context = forceWebGL
    ? canvas.getContext('webgl2', { powerPreference: 'high-performance', antialias: true, alpha: true, depth: true, stencil: false }) ?? undefined
    : undefined;
  const renderer = new THREE.WebGPURenderer({ canvas, context, antialias: true, forceWebGL, powerPreference: 'high-performance', trackTimestamp });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is gone from WebGPURenderer (it warns and falls back)
  await renderer.init();
  document.getElementById('app')!.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  return { renderer, backend };
}

/** The GPU the page landed on (hybrid laptops: headless Chrome picks the integrated one unless told). */
export function gpuName(renderer: THREE.WebGPURenderer): string {
  type Info = { vendor?: string; architecture?: string; device?: string; description?: string };
  const b = renderer.backend as { gl?: WebGL2RenderingContext; adapter?: { info?: Info }; device?: { adapterInfo?: Info } };
  if (b.gl) {
    const ext = b.gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(b.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
  }
  // three keeps no adapter; the device has its info (Chrome: "nvidia blackwell", "google swiftshader")
  const i = b.adapter?.info ?? b.device?.adapterInfo;
  const name = i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : '';
  return name ? `webgpu ${name}` : 'webgpu';
}

/** The tilt-shift options of the look from camera.json dof. */
export interface DofJson {
  fstop: number;
  ref_distance_cm: number;
  focus_offset_cm: number;
  post?: { DepthOfFieldSensorWidth?: number };
  by_weather?: Record<string, { fstop_scale?: number; focus_offset_cm?: number }>;
}

export function dofOptions(dof: DofJson, params: URLSearchParams) {
  return {
    fstop: dof.fstop, refDistance: dof.ref_distance_cm / 100, focusOffset: dof.focus_offset_cm / 100,
    clearFocusOffset: (dof.by_weather?.clear?.focus_offset_cm ?? dof.focus_offset_cm) / 100,
    clearFstopScale: dof.by_weather?.clear?.fstop_scale ?? 1, sensorWidth: (dof.post?.DepthOfFieldSensorWidth ?? 36) / 1000,
    scale: Number(params.get('dofscale') ?? 1) || 1,
  };
}

/** Per-effect overrides of the quality tier from the URL (?ao= ?dof= ?msaa= ...). */
export function lookOverrides(params: URLSearchParams) {
  return Object.fromEntries(([['ao', 'ao'], ['aosamples', 'aoSamples'], ['dof', 'dofTaps'], ['msaa', 'msaa'], ['bloom', 'bloom'], ['cascades', 'cascades'], ['hlshadow', 'headlightShadows'], ['shadowmap', 'shadowMap'], ['shadowfar', 'shadowFar']] as const)
    .filter(([k]) => params.has(k)).map(([k, key]) => [key, key === 'bloom' || key === 'headlightShadows' ? params.get(k) !== '0' : Number(params.get(k))]));
}

/**
 * The weather's road marks (snow's ice patches and ruts, rain's puddles), placed by the original's rules and
 * random stream (src/game/weather.ts). Also returns the ice patches (s ranges) for the car's grip.
 */
export function buildRoadMarks(id: string, stage: Stage, features: StageFeatures, weather: WeatherDef, rapier: typeof RAPIER, world: RAPIER.World,
  scene: THREE.Scene): { ice: [number, number][]; marks: RoadMarks | null } {
  const rj = stage.json.road as typeof stage.json.road & { y_cm?: number[] };
  const fords = stage.json.fords ?? [];
  const roadW: RoadForWeather = {
    s: stage.road.s,
    y: rj.y_cm ? rj.y_cm.map((y) => y / 100) : stage.road.y,
    surfaceAt: (s) => {
      const S = stage.road.s;
      let lo = 0, hi = S.length - 1;
      if (s <= S[0]) lo = 0;
      else if (s >= S[hi]) lo = hi;
      else {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (S[mid] <= s) lo = mid;
          else hi = mid;
        }
      }
      return rj.surfaces[rj.surface[lo]];
    },
    inFord: (s, m) => fords.some((f) => s >= f.s0 - m && s <= f.s1 + m),
    onBridge: (s, m) => features.onBridge(s, m),
  };
  const fwd = stage.json.variants.forward;
  const ice = weather.ice ? icePatches(weather.ice, id, fwd.start_s, fwd.finish_s, roadW) : [];
  const decals = weather.road_decals;
  let marks: RoadMarks | null = null;
  if (ice.length || decals?.puddles || decals?.ruts) {
    const down = { x: 0, y: -1, z: 0 };
    marks = new RoadMarks(stage.road, (x, z, fromY) => {
      const hit = world.castRay(new rapier.Ray({ x, y: fromY, z }, down), 6, true, undefined, undefined, undefined, undefined, (c) => stage.isTerrain(c));
      return hit ? fromY - hit.timeOfImpact : null;
    });
    if (decals?.puddles) marks.puddles(puddleSites(decals.puddles, id, roadW, (s) => stage.road.sampleAt(s).halfWidth));
    if (ice.length) marks.ice(ice, weather.ice?.decal_width_scale ?? 0.9);
    if (decals?.ruts) marks.ruts(decals.ruts.segment_m ?? [3, 8], (decals.ruts.width_cm ?? 240) / 100, (s) => roadW.inFord(s, 6) || roadW.onBridge(s, 2));
    marks.build();
    scene.add(marks.mesh);
  }
  return { ice, marks };
}

/**
 * The frame-rate limit (settings: 30 / 60 / 120 / 144 / uncapped). The loop runs on requestAnimationFrame at the
 * display's rate; a capped loop skips the callbacks that come too early. 2 ms of slack keeps a 60 cap on a 60 Hz
 * display from dropping frames to jitter; after a stall it re-syncs instead of catching up.
 */
export class FrameLimiter {
  private next = 0;
  constructor(public fps = 0) {}

  /** True when this callback should draw a frame. */
  due(now: number): boolean {
    if (!(this.fps > 0)) return true;
    const iv = 1000 / this.fps;
    if (this.next === 0 || now - this.next > iv * 2) this.next = now;
    if (now < this.next - 2) return false;
    this.next += iv;
    return true;
  }
}
