import './style.css';
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { load, loadCar, type CameraData, type TestTrack } from './data';
import { buildTestStrip } from './world/testStrip';
import { Stage, type CatalogEntry, type StageRuntimeJson } from './world/stage';
import { loadCarModel } from './car/carModel';
import { ChaseCamera } from './camera/chaseCamera';
import { Controls } from './input/controls';
import { FrameHud } from './hud/frameHud';
import { StageHud } from './hud/stageHud';
import { posM } from './ue';
import { createWorld, initPhysics } from './sim/physics';
import { buildTestTrackPhysics } from './sim/testTrackPhysics';
import { loadCarTuning } from './sim/tuning';
import { Vehicle, type DriverInput, type SurfaceQuery } from './sim/vehicle';
import { Simulation } from './sim/simulation';
import { createArcade } from './sim/arcade';
import { DEFAULT_RULES, RoadTracker } from './sim/road';
import { StageRun, DEFAULT_FLOW, type FlowConfig } from './game/stageRun';
import { Autopilot, DEFAULT_AUTOPILOT } from './game/autopilot';
import { Look } from './look/look';
import { CONDITIONS, pickCondition, type ConditionsJson } from './look/conditions';
import { QUALITY } from './look/quality';
import { AutoQuality, LADDER, initialRung } from './look/autoQuality';

const params = new URLSearchParams(location.search);
/** Headless runs: ?timescale=4 runs the game (physics, flow, camera) four times faster than the clock. */
const timeScale = Math.min(Math.max(Number(params.get('timescale') ?? 1) || 1, 0.1), 16);

/** Per-frame costs for tools/check (ms): read through window.__br.perf. */
const perf = {
  frames: [] as { dt: number; step: number; inst: number; render: number; calls: number; tris: number; visible: number; gpu: number }[],
  /** GPU time of the last resolved frame (ms), with ?gputime (timer queries; may be unavailable). */
  gpu: 0,
  reset() {
    this.frames.length = 0;
  },
};

interface DofJson {
  fstop: number;
  ref_distance_cm: number;
  focus_offset_cm: number;
  post?: { DepthOfFieldSensorWidth?: number };
  by_weather?: Record<string, { fstop_scale?: number; focus_offset_cm?: number }>;
}

/** What the game loop needs from the place it drives in: the test bench or a stage. */
interface Level {
  surfaceAt: SurfaceQuery;
  spawn(): { position: THREE.Vector3; yawDeg: number };
  /** Once per frame after the physics: restart, instances, the HUD. */
  frame?(dt: number, camera: THREE.Vector3): void;
  /** Before every physics step: tracking, off-road resets, the stage flow (intro, countdown, finish), autopilot. */
  step?(dt: number, input: DriverInput): DriverInput;
  info(): string;
  /** Last updateInstances cost (ms) and the visible instance count, for the perf readout. */
  instMs?: number;
  visible?(): number;
}

async function main() {
  const app = document.getElementById('app')!;

  // WebGPU with its built-in WebGL2 fallback; ?webgl forces the fallback for testing. Both ask for the
  // fast GPU: WebGPU through the adapter request, WebGL2 through a context made here (three's fallback
  // doesn't pass powerPreference on). Browsers may ignore it: desktop Chrome on Linux renders on the
  // GPU it runs on, which on a hybrid laptop is the integrated one.
  const autoQuality = !params.has('quality') || params.get('quality') === 'auto' || !QUALITY[params.get('quality')!];
  const gpuAdapter = !params.has('webgl') && 'gpu' in navigator
    ? await (navigator as unknown as { gpu: { requestAdapter(o: object): Promise<unknown> } }).gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
    : null;
  const forceWebGL = !gpuAdapter;
  const canvas = document.createElement('canvas');
  const context = forceWebGL
    ? canvas.getContext('webgl2', { powerPreference: 'high-performance', antialias: true, alpha: true, depth: true, stencil: false }) ?? undefined
    : undefined;
  const renderer = new THREE.WebGPURenderer({
    canvas, context, antialias: true, forceWebGL, powerPreference: 'high-performance',
    // GPU timer queries: auto quality uses them to see headroom; ?gputime reports them
    trackTimestamp: params.has('gputime') || autoQuality,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is gone from WebGPURenderer (it warns and falls back)
  await renderer.init();
  app.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  // ?hud=0 hides every overlay (look comparisons)
  if (params.get('hud') === '0') document.body.classList.add('no-hud');

  const carId = params.get('car') ?? 'swift';
  const stageId = params.get('stage') ?? 'finland';
  const reverse = params.get('dir') === 'reverse';
  const [camCfg, car, tuningJson, rapier, conditions] = await Promise.all([
    load<CameraData & { dof: DofJson }>('camera.json'),
    loadCar(carId),
    load<Record<string, unknown>>('cars_tuning.json'),
    initPhysics(),
    load<ConditionsJson>('conditions.json'),
  ]);

  const scene = new THREE.Scene();
  const world = createWorld(rapier);

  const hudRoot = document.body;
  let vehicle!: Vehicle;
  let sim!: Simulation;
  let level: Level;
  if (stageId === 'test') {
    const track = await load<TestTrack>('testtrack.json');
    scene.add(buildTestStrip(track));
    const strip = track.strips[0];
    level = {
      surfaceAt: buildTestTrackPhysics(rapier, world, track),
      spawn: () => ({ position: posM([strip.start[0] + 15, strip.start[1], 0.4]), yawDeg: strip.yaw }),
      info: () => 'test bench',
    };
  } else {
    level = await buildStageLevel(stageId, reverse, rapier, world, scene, () => vehicle, () => sim, hudRoot);
  }

  const model = await loadCarModel(car);
  scene.add(model.root);
  const tuning = loadCarTuning(tuningJson, car as unknown as Record<string, unknown>, carId);
  vehicle = new Vehicle(rapier, world, tuning, level.surfaceAt, car.wheel_pos_cm);
  const arcade = createArcade(vehicle);
  vehicle.arcade = arcade;
  sim = new Simulation(world, vehicle);
  sim.maxSteps = Math.ceil(8 * Math.max(1, timeScale));
  const spawn = () => {
    const p = level.spawn();
    vehicle.teleport(p.position.clone().add(new THREE.Vector3(0, 0.3, 0)), p.yawDeg);
    sim.snap();
  };
  spawn();
  (level as { attach?: (a: typeof arcade, respawn: () => void) => void }).attach?.(arcade, spawn);

  const chase = new ChaseCamera(camCfg, innerWidth / innerHeight);

  // the look (slice 5): conditions, fog, shadows, post. ?cond=morning|afternoon|sunset|night|fog (or stage),
  // ?post=0 (P toggles), ?quality=auto|high|medium|low, ?scale=0.5..1 (render scale)
  const dof = camCfg.dof;
  // quality: pinned by ?quality=<tier>, else adaptive (autoQuality.ts) from a guess by GPU and pixels
  const gpu = gpuName(renderer);
  const scaleParam = params.has('scale') ? Math.min(Math.max(Number(params.get('scale')) || 1, 0.25), 1) : null;
  const auto = autoQuality ? new AutoQuality(initialRung(gpu, innerWidth * innerHeight * renderer.getPixelRatio() ** 2)) : null;
  const autoRung = auto ? auto.rung : null;
  let condIndex = Math.max(0, CONDITIONS.indexOf(pickCondition(conditions, params.get('cond'), stageId, reverse) as (typeof CONDITIONS)[number]));
  const look = new Look(renderer, scene, chase.camera, conditions, {
    stage: stageId,
    condition: CONDITIONS[condIndex],
    quality: autoRung !== null ? LADDER[autoRung].tier : params.get('quality')!,
    scale: scaleParam ?? (autoRung !== null ? LADDER[autoRung].scale : 1),
    upscale: params.get('upscale') === 'fsr' ? 'fsr' : 'browser',
    post: params.get('post') !== '0',
    override: Object.fromEntries(([['ao', 'ao'], ['aosamples', 'aoSamples'], ['dof', 'dofTaps'], ['msaa', 'msaa'], ['bloom', 'bloom'], ['cascades', 'cascades'], ['hlshadow', 'headlightShadows'], ['shadowmap', 'shadowMap'], ['shadowfar', 'shadowFar']] as const)
      .filter(([k]) => params.has(k)).map(([k, key]) => [key, key === 'bloom' || key === 'headlightShadows' ? params.get(k) !== '0' : Number(params.get(k))])),
    dof: {
      fstop: dof.fstop, refDistance: dof.ref_distance_cm / 100, focusOffset: dof.focus_offset_cm / 100,
      clearFocusOffset: (dof.by_weather?.clear?.focus_offset_cm ?? dof.focus_offset_cm) / 100,
      clearFstopScale: dof.by_weather?.clear?.fstop_scale ?? 1, sensorWidth: (dof.post?.DepthOfFieldSensorWidth ?? 36) / 1000,
      scale: Number(params.get('dofscale') ?? 1) || 1,
    },
  }, { root: model.root, headlightPosCm: (car as unknown as { headlight_pos_cm: number[][] }).headlight_pos_cm });
  look.setCondition(CONDITIONS[condIndex]);
  // the stage's vegetation detail and shadow casters follow the tier
  const stageLevel = (level as { stage?: Stage }).stage;
  // dev: ?lodcuts=50,120,200 moves the vegetation level switches, ?shadowrange=180 the shadow casters' reach
  const lodCuts = params.get('lodcuts')?.split(',').map(Number);
  look.onQuality = (q) => {
    if (lodCuts?.length) q.lod.cuts = lodCuts;
    if (params.has('shadowrange')) q.lod.shadowRange = Number(params.get('shadowrange'));
    if (params.has('lodblend')) q.lod.blend = Number(params.get('lodblend'));
    stageLevel?.setLod(q.lod);
  };
  look.onQuality(look.quality, look.qualityName);
  // dev keys: P post on/off, K next condition
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') look.setPost(!look.post.enabled);
    if (e.code === 'KeyK') look.setCondition(CONDITIONS[(condIndex = (condIndex + 1) % CONDITIONS.length)]);
  });
  // place the camera, then build every pipeline now rather than mid-run (the loading curtain will cover this)
  chase.update(0, { position: sim.renderPos, forward: new THREE.Vector3(1, 0, 0).applyQuaternion(sim.renderRot), velocity: vehicle.velocity });
  look.update(0, sim.renderPos, innerWidth, innerHeight);
  const stageOf = (level as { stage?: Stage }).stage;
  const t0 = performance.now();
  if (stageOf) stageOf.warmup(() => look.render());
  else look.render();
  if (stageOf) stageOf.timings.warmup = performance.now() - t0;
  const controls = new Controls();
  const hud = new FrameHud(document.body, backend);

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
  };
  addEventListener('resize', onResize);
  onResize(); // the window may have changed while the stage loaded (going fullscreen, for one)

  // read-only handle for tools/check (headless runs)
  (window as unknown as { __br: object }).__br = { vehicle, chase, model, sim, level, renderer, perf, backend, carId, look, gpu, auto };

  let liveryIndex = 0;
  let last = performance.now();
  const camState = { position: sim.renderPos, forward: new THREE.Vector3(), velocity: vehicle.velocity };
  renderer.setAnimationLoop((now: number) => {
    const frameDt = now - last;
    const dt = Math.min(frameDt / 1000, 0.1) * timeScale;
    last = now;

    const { input, actions } = controls.poll();
    if (actions.has('camera')) chase.cycle();
    if (actions.has('livery')) model.setLivery(car.liveries[(liveryIndex = (liveryIndex + 1) % car.liveries.length)]);
    if (actions.has('recover') && arcade.recover(vehicle, true)) sim.snap();
    if (actions.has('assist')) vehicle.setTractionAssist(!vehicle.tractionAssist);
    sim.advance(dt, input, level.step);
    level.frame?.(dt, chase.camera.position);

    model.root.position.copy(sim.renderPos);
    model.root.quaternion.copy(sim.renderRot);
    model.pose((vehicle.wheelAngleDeg * Math.PI) / 180, vehicle.wheels);

    camState.forward.set(1, 0, 0).applyQuaternion(sim.renderRot);
    chase.update(dt, camState);
    const c = renderer.domElement;
    look.update(dt, sim.renderPos, c.width, c.height);

    const gear = vehicle.gear < 0 ? 'r' : String(vehicle.gear);
    hud.extra = `${car.name} · ${level.info()} · ${Math.abs(vehicle.forwardSpeedKmh).toFixed(0)} km/h · gear ${gear}` +
      ` · traction assist ${vehicle.tractionAssist ? 'on' : 'off'} · camera ${chase.presetName} · ${controls.device}` +
      `\n${look.cond.name} · post ${look.post.enabled ? 'on' : 'off'} · quality ${look.qualityName}` +
      `${look.scale < 1 ? ` ${Math.round(look.scale * 100)}%` : ''}${auto ? ' (auto)' : ''}` +
      `\nw s a d drive · space handbrake · r recover · t traction assist · c camera · l livery · enter restart · k time of day · p post`;
    const r0 = performance.now();
    look.render();
    const info = renderer.info.render as unknown as { drawCalls: number; triangles: number };
    perf.frames.push({ dt: frameDt, step: sim.lastStepMs, inst: level.instMs ?? 0, render: performance.now() - r0,
      calls: info.drawCalls, tris: info.triangles, visible: level.visible?.() ?? 0, gpu: perf.gpu });
    if (params.has('gputime') || auto) {
      void renderer.resolveTimestampsAsync('render').then((ms) => {
        if (typeof ms === 'number' && ms > 0) perf.gpu = ms;
      });
    }
    if (auto) {
      const r = auto.frame(frameDt, perf.gpu);
      if (r !== null) look.setQuality(LADDER[r].tier, scaleParam ?? LADDER[r].scale);
    }
    if (perf.frames.length > 100000) perf.frames.splice(0, 50000);
    hud.frame(now, c.width, c.height);
  });
}

async function buildStageLevel(id: string, reverse: boolean, rapier: typeof RAPIER, world: RAPIER.World, scene: THREE.Scene,
  getVehicle: () => Vehicle, getSim: () => Simulation, hudRoot: HTMLElement): Promise<Level> {
  const [catalog, runtime] = await Promise.all([
    load<Record<string, CatalogEntry>>('env_catalog.json'),
    load<StageRuntimeJson & { flow: FlowConfig }>('stage_runtime.json'),
  ]);
  const stage = await Stage.load(id, catalog, runtime, rapier, world);
  // draw distance: ?draw=near|medium|far|max or a multiplier (default far, x2)
  const draw = params.get('draw');
  const named = ['near', 'medium', 'far', 'max'].indexOf(draw ?? '');
  if (draw) stage.drawDistance = named >= 0 ? runtime.draw_distance.scale.default[named] : Number(draw) || stage.drawDistance;
  scene.add(stage.group);
  for (const c of params.get('hide')?.split(',') ?? []) stage.hidden.add(c);
  if (params.get('occtest') === '0') stage.occluderReach = -1e9; // dev: no see-through test (measuring)
  const v = stage.json.variants[reverse ? 'reverse' : 'forward'];
  const rules = {
    ...DEFAULT_RULES,
    corridor: runtime.corridor_cm / 100,
    offroadGrace: runtime.offroad_grace_s,
    resetBack: runtime.reset_back_m,
    carStartBack: runtime.car_start_back_m,
  };
  const tracker = new RoadTracker(stage.road, v.start_s, v.finish_s, rules);
  stage.addGantries(v.start_s, v.finish_s, tracker.sign, rapier, world);
  stage.updateInstances(tracker.startPose().position, true);
  const flow = { ...DEFAULT_FLOW, ...runtime.flow };
  let run = new StageRun(tracker, flow);
  const hud = new StageHud(hudRoot);
  const bounds = stage.json.bounds;
  let restartKey = false;
  addEventListener('keydown', (e) => {
    if (e.code === 'Enter') restartKey = true;
  });
  let respawn = () => {};
  const ap = params.has('autopilot') ? new Autopilot(stage.road, tracker, {
    ...DEFAULT_AUTOPILOT,
    kmh: Number(params.get('autopilot')) || DEFAULT_AUTOPILOT.kmh,
    minTurn: Number(params.get('minturn') ?? DEFAULT_AUTOPILOT.minTurn),
    keys: (Number(params.get('apkeys') ?? 0) as 0 | 1 | 2),
  }) : null;

  const level: Level & { attach(a: ReturnType<typeof createArcade>, respawn: () => void): void; readonly run: StageRun } = {
    get run() {
      return run;
    },
    surfaceAt: stage.surfaceAt,
    spawn: () => tracker.startPose(),
    attach(arcade, rs) {
      respawn = rs;
      // recovers go back onto the road a few metres behind, +5 s
      arcade.findReset = (veh) => tracker.resetPose(veh.position);
      arcade.onRecovered = () => {
        if (run.phase === 'running') run.penalty();
      };
    },
    step(dt, input) {
      const veh = getVehicle();
      if (tracker.update(veh.position, dt) === 'offroad' && run.phase !== 'results') {
        // off the road for the grace time: back on the road, stopped, +5 s, white dip
        const pose = tracker.resetPose(veh.position);
        veh.teleport(pose.position.clone().add(new THREE.Vector3(0, 0.6, 0)), pose.yawDeg);
        getSim().snap();
        if (run.phase === 'running') run.penalty();
      }
      const p = veh.position;
      const outside = !!bounds && (p.x < bounds[0][0] - 50 || p.x > bounds[1][0] + 50 || p.z < bounds[0][2] - 50 || p.z > bounds[1][2] + 50);
      if (ap) {
        // the robot never jump-starts: the flow owns the input outside the running phase
        if (run.phase === 'running') ap.observe(veh);
        input = run.phase === 'running' ? ap.drive(veh, dt, veh.t.steering.analog_exponent) : { ...input, throttle: 0, brake: 0, steer: 0 };
      }
      return run.update(dt, input, outside);
    },
    frame(_dt, camera) {
      const veh = getVehicle();
      if (restartKey) {
        restartKey = false;
        tracker.reset();
        run = new StageRun(tracker, flow, true);
        respawn();
      }
      const t0 = performance.now();
      stage.updateInstances(camera, false, veh.position);
      level.instMs = performance.now() - t0;
      hud.update(run, {
        stageName: stage.json.name,
        direction: `${stage.json.location} · ${reverse ? 'reverse' : 'forward'}`,
        kmh: veh.forwardSpeedKmh,
        gear: veh.gear,
        progress: tracker.progress,
      });
    },
    info: () => `${id} s=${tracker.proj?.s.toFixed(0) ?? '-'} · ${stage.stats.visible} inst${ap ? ' · autopilot' : ''}`,
    visible: () => stage.stats.visible,
  };
  Object.assign(level, { tracker, stage, autopilot: ap });
  return level;
}

/** The GPU the page landed on (hybrid laptops: headless Chrome picks the integrated one unless told). */
function gpuName(renderer: THREE.WebGPURenderer): string {
  const b = renderer.backend as { gl?: WebGL2RenderingContext; adapter?: { info?: { vendor?: string; architecture?: string; description?: string } } };
  if (b.gl) {
    const ext = b.gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(b.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl2';
  }
  const i = b.adapter?.info;
  return i ? [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') : 'webgpu';
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="fatal">${String(e)}</pre>`);
});
