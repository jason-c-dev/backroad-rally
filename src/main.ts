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
import { StageHud, type HudInfo, type HudJson } from './hud/stageHud';
import { loadHudSettings, saveHudSettings, type HudSettings } from './settings';
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
// fx (slice 6)
import { Fx } from './fx/fx';
import type { FxJson } from './fx/config';
import { CarEvents } from './game/carEvents';
import { Crowd, type CrowdRuntime } from './world/crowd';
import { Breakables, type BreakablesJson } from './world/breakables';
import { events as fxEvents } from './game/events';
// damage (slice 6c)
import { Damage, type DamageJson, type Hit } from './game/damage';
import { BodyContacts } from './game/contacts';
import { mainSurface } from './game/carEvents';
import { StageFeatures } from './world/features';
import { Rng } from './fx/config';

const params = new URLSearchParams(location.search);
/** The stages in the original's order (?stage=<id>, N cycles them). */
const STAGES = ['finland', 'japan', 'alps', 'wales', 'arizona', 'vermont'] as const;
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
  /** Called when the stage restarts (Enter): repair the car. */
  onRestart?(): void;
  /** What the HUD shows of the damage (null = off), and the condition for the intro card. */
  damageView?(): HudInfo['damage'];
  condition?(): string;
  /** The stage HUD (stages only). */
  hud?: StageHud;
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
  // ?hud=0 hides every overlay (look comparisons); ?hud=80..130 is the HUD size (src/settings.ts)
  if (params.get('hud') === '0') document.body.classList.add('no-hud');
  const hudSettings = loadHudSettings(params);
  document.body.classList.toggle('no-debug', !hudSettings.debug);

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
    level = await buildStageLevel(stageId, reverse, rapier, world, scene, () => vehicle, () => sim, hudRoot, hudSettings);
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
  // --- fx ---
  // effects (src/fx), spectators (src/world/crowd.ts), breakables (src/world/breakables.ts) and the car's game events (src/game/carEvents.ts).
  // They hook the level's per-step and per-frame calls and only read the car: the sim runs unchanged.
  // ?fx=0 draws no effects (events still fire), ?crowd=0 places no spectators.
  const fxCfg = await load<FxJson>('fx.json');
  const fx = new Fx(scene, fxCfg, { ...(car as unknown as { exhaust_pos_cm?: number[][]; wheel_width_cm: number; length_cm: number }), id: carId },
    { enabled: params.get('fx') !== '0' });
  const carEvents = new CarEvents();
  const crowd = stageLevel && params.get('crowd') !== '0'
    ? new Crowd(stageLevel, fxCfg.crowd, (stageLevel.runtime as unknown as { crowd: CrowdRuntime }).crowd, reverse, rapier, world) : null;
  if (crowd) scene.add(crowd.group);
  // roadside bushes and posts the car drives through (no colliders, like the original)
  const breakables = stageLevel ? new Breakables(stageLevel, (fxCfg as unknown as { breakables: BreakablesJson }).breakables,
    (stageLevel.runtime as unknown as { breakable_radius_cm: Record<string, number> }).breakable_radius_cm ?? {}, rapier, world,
    fx.enabled ? (p) => fx.pools.chip.emit(p) : null) : null;
  if (breakables) scene.add(breakables.group);
  const lookOnQuality = look.onQuality;
  look.onQuality = (q, name) => {
    lookOnQuality?.(q, name);
    fx.setQuality(name);
  };
  fx.setQuality(look.qualityName);
  const levelStep = level.step?.bind(level);
  level.step = (dt, input) => {
    const out = levelStep ? levelStep(dt, input) : input;
    carEvents.step(vehicle, dt);
    return out;
  };
  // fords: the splash event (audio) reads the water under the car, the spray goes into the dust pool
  const features = (level as { features?: StageFeatures }).features ?? null;
  if (features) carEvents.waterAt = () => features.water;
  const sprayRng = new Rng(2024);
  const levelFrame = level.frame?.bind(level);
  level.frame = (dt, cameraPos) => {
    levelFrame?.(dt, cameraPos);
    features?.frame(dt, vehicle, (level as { tracker?: RoadTracker }).tracker?.proj ?? null, fx.enabled ? fx.pools.dust : null, sprayRng);
    fx.update(dt, vehicle, sim.renderPos, sim.renderRot, look);
    const run = (level as { run?: { phase: string; dnf: boolean } }).run;
    // a retired run coasts like a finish but gets no applause (the original's NotifyFinish skips a DNF)
    const crowdPhase = run?.dnf && run.phase === 'finished' ? 'retired' : run?.phase ?? 'running';
    crowd?.update(dt, { position: vehicle.position, kmh: vehicle.speedKmh, airborne: vehicle.wheelsInContact === 0 },
      crowdPhase, cameraPos, stageLevel?.drawDistance ?? 2);
    breakables?.update(dt, vehicle, run?.phase ?? 'running');
  };
  fx.warmup();
  crowd?.warmup();
  (window as unknown as { __fx: object }).__fx = { fx, crowd, breakables, carEvents, events: fxEvents };
  // --- /fx ---
  // --- damage ---
  // src/game/damage.ts: the body's contact impulses (src/game/contacts.ts, read before every physics step) make
  // hits; damage costs torque and pulls the steering, dirties the paint, smokes and burns (src/fx/damageFx.ts),
  // and terminal damage retires the run. ?damage=0|0.5|1 = the level (0 off, as in time attack; default 1).
  const damageCfg = await load<DamageJson>('damage.json');
  const damageLevel = params.has('damage') ? Math.min(Math.max(Number(params.get('damage')) || 0, 0), 1) : 1;
  const damage = new Damage(damageCfg, {
    lengthCm: car.length_cm, widthCm: car.width_cm,
    engineXCm: fxCfg.cars[carId]?.engine_pos_cm?.[0] ?? car.length_cm * 0.32,
  });
  damage.enabled = damageLevel > 0;
  damage.level = damageLevel;
  const contacts = new BodyContacts(world, vehicle, damageCfg.ground_normal_z);
  const hits: Hit[] = [];
  const LOOSE = new Set(['gravel', 'dirt', 'grass', 'snow']);
  damage.onTerminal = () => (level as { run?: { retire(r: string): void } }).run?.retire('terminal damage');
  const damageStep = level.step?.bind(level);
  level.step = (dt, input) => {
    const out = damageStep ? damageStep(dt, input) : input;
    for (const h of contacts.read(hits)) damage.hit(h);
    damage.tick(dt, vehicle.speedKmh, LOOSE.has(mainSurface(vehicle)));
    // exactly 1 and 0 while undamaged (and always with ?damage=0): the sim is untouched
    vehicle.damageTorqueScale = damage.torqueScale;
    vehicle.damageSteerPull = damage.steerPull;
    return out;
  };
  // development: ?startdamage=0.8 starts the first run that damaged (smoke from 0.35, fire from 0.7; checks and perf)
  if (params.has('startdamage')) damage.add(Math.min(Math.max(Number(params.get('startdamage')) || 0, 0), 0.99));
  level.onRestart = () => damage.repair();
  level.damageView = () => (damage.enabled ? { parts: damage.parts, terminal: damage.terminal } : null);
  fx.damageState = {
    get value() {
      return damage.value;
    },
    get terminal() {
      return damage.terminal;
    },
    smokeFrom: damageCfg.smoke_from,
    fireFrom: damageCfg.fire_from,
  };
  // --- /damage ---
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
  level.condition = () => look.cond?.name ?? '';
  // HUD keys: U km/h or mph, I number or dial, F3 the debug panel (saved: src/settings.ts)
  const setHud = (change: Partial<HudSettings>) => {
    const now = { ...(level.hud?.settings ?? hudSettings), ...change };
    Object.assign(hudSettings, now);
    level.hud?.apply(now);
    document.body.classList.toggle('no-debug', !now.debug);
    saveHudSettings({ ...loadHudSettings(), ...change });
  };
  // stages until the stage select (slice 9): N next stage (shift+N previous), B the other direction.
  // A fresh page load, so the old stage's GPU buffers, colliders and sounds all go with it.
  addEventListener('keydown', (e) => {
    if (e.repeat || (e.code !== 'KeyN' && e.code !== 'KeyB')) return;
    const q = new URLSearchParams(location.search);
    if (e.code === 'KeyN') {
      const i = STAGES.indexOf(stageId as (typeof STAGES)[number]);
      q.set('stage', STAGES[(i + (e.shiftKey ? STAGES.length - 1 : 1) + (i < 0 ? 1 : 0)) % STAGES.length]);
    } else if (reverse) q.delete('dir');
    else q.set('dir', 'reverse');
    location.search = q.toString();
  });
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyU') setHud({ units: hudSettings.units === 'mph' ? 'kmh' : 'mph' });
    if (e.code === 'KeyI') setHud({ speedo: hudSettings.speedo === 'dial' ? 'number' : 'dial' });
    if (e.code === 'F3') {
      e.preventDefault();
      setHud({ debug: !hudSettings.debug });
    }
  });

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
    level.hud?.resize();
  };
  addEventListener('resize', onResize);
  onResize(); // the window may have changed while the stage loaded (going fullscreen, for one)

  // read-only handle for tools/check (headless runs)
  (window as unknown as { __br: object }).__br = { vehicle, chase, model, sim, level, renderer, perf, backend, carId, look, gpu, auto, damage, contacts };

  // --- audio ---
  // sound (src/audio): engine, tyres, world, music. It reads the game every frame and never writes to it.
  // M mute, V volume panel, . and , skip the music; ?audio=0 turns it off (loaded as its own chunk).
  void import('./audio').then(({ startAudio }) => startAudio({
    vehicle, carId, stageId, reverse, camera: chase.camera, params,
    level: level as unknown as Parameters<typeof startAudio>[0]['level'],
    isNight: () => look.cond?.name === 'night',
  })).catch((e) => console.error('audio:', e));
  // --- /audio ---

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
    model.setGrime(damage.grime, damageCfg.dirt_color);

    camState.forward.set(1, 0, 0).applyQuaternion(sim.renderRot);
    chase.update(dt, camState);
    const c = renderer.domElement;
    look.update(dt, sim.renderPos, c.width, c.height);

    const gear = vehicle.gear < 0 ? 'r' : String(vehicle.gear);
    hud.extra = `${car.name} · ${level.info()} · ${Math.abs(vehicle.forwardSpeedKmh).toFixed(0)} km/h · gear ${gear}` +
      ` · traction assist ${vehicle.tractionAssist ? 'on' : 'off'} · camera ${chase.presetName} · ${controls.device}` +
      ` · damage ${damage.enabled ? `${(damage.value * 100).toFixed(0)}%${damage.terminal ? ' (wrecked)' : ''}` : 'off'}` +
      `\n${look.cond.name} · post ${look.post.enabled ? 'on' : 'off'} · quality ${look.qualityName}` +
      `${look.scale < 1 ? ` ${Math.round(look.scale * 100)}%` : ''}${auto ? ' (auto)' : ''}` +
      `\nw s a d drive · space handbrake · r recover · t traction assist · c camera · l livery · enter restart · k time of day · p post` +
      ` · u km/h or mph · i speed dial · f3 this panel · n next stage · b direction`;
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
  getVehicle: () => Vehicle, getSim: () => Simulation, hudRoot: HTMLElement, hudSettings: HudSettings): Promise<Level> {
  const [catalog, runtime, hudJson] = await Promise.all([
    load<Record<string, CatalogEntry>>('env_catalog.json'),
    load<StageRuntimeJson & { flow: FlowConfig }>('stage_runtime.json'),
    load<HudJson>('hud.json'),
  ]);
  const stage = await Stage.load(id, catalog, runtime, rapier, world);
  // draw distance: ?draw=near|medium|far|max or a multiplier (default far, x2)
  const draw = params.get('draw');
  const named = ['near', 'medium', 'far', 'max'].indexOf(draw ?? '');
  if (draw) stage.drawDistance = named >= 0 ? runtime.draw_distance.scale.default[named] : Number(draw) || stage.drawDistance;
  scene.add(stage.group);
  for (const c of params.get('hide')?.split(',') ?? []) stage.hidden.add(c);
  if (params.get('occtest') === '0') stage.occluderReach = -1e9; // dev: no see-through test (measuring)
  // fords, bridges, the canyon rock fade, the covered bridge's shadow (src/world/features.ts)
  const features = new StageFeatures(stage, runtime.features ?? {});
  const v = stage.json.variants[reverse ? 'reverse' : 'forward'];
  const rules = {
    ...DEFAULT_RULES,
    corridor: runtime.corridor_cm / 100,
    offroadGrace: runtime.offroad_grace_s,
    resetBack: runtime.reset_back_m,
    carStartBack: runtime.car_start_back_m,
  };
  const tracker = new RoadTracker(stage.road, v.start_s, v.finish_s, rules);
  const lengthKm = Math.abs(v.finish_s - v.start_s) / 1000;
  stage.addGantries(v.start_s, v.finish_s, tracker.sign, rapier, world);
  stage.updateInstances(tracker.startPose().position, true);
  const flow = { ...DEFAULT_FLOW, ...runtime.flow };
  let run = new StageRun(tracker, flow);
  const hud = new StageHud(hudRoot, hudJson, hudSettings);
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
    hud,
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
      features.step(veh, tracker.proj, dt);
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
        level.onRestart?.();
      }
      const t0 = performance.now();
      stage.updateInstances(camera, false, veh.position);
      level.instMs = performance.now() - t0;
      const cond = level.condition?.() ?? '';
      // the original's display gear: a car rolling forward through a shift shows the gear it left
      const gear = veh.gear === 0 && veh.forwardSpeed > 1 ? veh.lastDriveGear : veh.gear;
      hud.update(run, {
        stageName: stage.json.name,
        subtitle: [stage.json.location.toLowerCase(), `${lengthKm.toFixed(1)} km`, reverse ? 'reverse' : 'forward', cond].filter(Boolean).join(' · '),
        kmh: Math.abs(veh.forwardSpeedKmh),
        gear,
        gears: veh.t.gearRatios.length,
        progress: tracker.progress,
        damage: level.damageView ? level.damageView() : null,
      });
    },
    info: () => `${id} s=${tracker.proj?.s.toFixed(0) ?? '-'} · ${stage.stats.visible} inst${ap ? ' · autopilot' : ''}`,
    visible: () => stage.stats.visible,
  };
  Object.assign(level, { tracker, stage, autopilot: ap, features });
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
