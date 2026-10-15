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
import { posM, yaw } from './ue';
import { createWorld, initPhysics } from './sim/physics';
import { buildTestTrackPhysics } from './sim/testTrackPhysics';
import { loadCarTuning } from './sim/tuning';
import { Vehicle, type DriverInput, type SurfaceQuery } from './sim/vehicle';
import { Simulation } from './sim/simulation';
import { createArcade } from './sim/arcade';
import { DEFAULT_RULES, RoadTracker } from './sim/road';
import { StageRun, DEFAULT_FLOW, type FlowConfig } from './game/stageRun';
import { Autopilot, DEFAULT_AUTOPILOT } from './game/autopilot';

const params = new URLSearchParams(location.search);
/** Headless runs: ?timescale=4 runs the game (physics, flow, camera) four times faster than the clock. */
const timeScale = Math.min(Math.max(Number(params.get('timescale') ?? 1) || 1, 0.1), 16);

/** Per-frame costs for tools/check (ms): read through window.__br.perf. */
const perf = {
  frames: [] as { dt: number; step: number; inst: number; render: number; calls: number; tris: number; visible: number }[],
  reset() {
    this.frames.length = 0;
  },
};

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

  // WebGPU with its built-in WebGL2 fallback; ?webgl forces the fallback for testing.
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is gone from WebGPURenderer (it warns and falls back)
  await renderer.init();
  app.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';

  const carId = params.get('car') ?? 'swift';
  const stageId = params.get('stage') ?? 'finland';
  const reverse = params.get('dir') === 'reverse';
  const [camCfg, car, tuningJson, rapier] = await Promise.all([
    load<CameraData>('camera.json'),
    loadCar(carId),
    load<Record<string, unknown>>('cars_tuning.json'),
    initPhysics(),
  ]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#B6C7D5');
  const world = createWorld(rapier);

  // sun and sky (the look slice brings conditions.json)
  const sun = new THREE.DirectionalLight(new THREE.Color(1, 0.94, 0.86), 3.2);
  const sunPitch = (-50 * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.cos(sunPitch), 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw(125));
  sunDir.y = Math.sin(sunPitch);
  sunDir.normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -60;
  sc.right = sc.top = 60;
  sc.near = 1;
  sc.far = 400;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#D8E4F0', '#5A6E48', 1.1));

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
  // build every pipeline now rather than mid-run (the loading curtain will cover this)
  const stageOf = (level as { stage?: Stage }).stage;
  if (stageOf) {
    const t0 = performance.now();
    stageOf.warmup(() => renderer.render(scene, chase.camera));
    stageOf.timings.warmup = performance.now() - t0;
  }
  const controls = new Controls();
  const hud = new FrameHud(document.body, backend);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
  });

  // read-only handle for tools/check (headless runs)
  (window as unknown as { __br: object }).__br = { vehicle, chase, model, sim, level, renderer, perf, backend, carId };

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
    sun.target.position.copy(sim.renderPos);
    sun.position.copy(sim.renderPos).addScaledVector(sunDir, -200);

    const gear = vehicle.gear < 0 ? 'r' : String(vehicle.gear);
    hud.extra = `${car.name} · ${level.info()} · ${Math.abs(vehicle.forwardSpeedKmh).toFixed(0)} km/h · gear ${gear}` +
      ` · traction assist ${vehicle.tractionAssist ? 'on' : 'off'} · camera ${chase.presetName} · ${controls.device}` +
      `\nw s a d drive · space handbrake · r recover · t traction assist · c camera · l livery · enter restart`;
    const r0 = performance.now();
    renderer.render(scene, chase.camera);
    const info = renderer.info.render as unknown as { drawCalls: number; triangles: number };
    perf.frames.push({ dt: frameDt, step: sim.lastStepMs, inst: level.instMs ?? 0, render: performance.now() - r0,
      calls: info.drawCalls, tris: info.triangles, visible: level.visible?.() ?? 0 });
    if (perf.frames.length > 100000) perf.frames.splice(0, 50000);
    const c = renderer.domElement;
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
  scene.fog = new THREE.Fog('#B6C7D5', 250, 1400);
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
      stage.updateInstances(camera);
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

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="fatal">${String(e)}</pre>`);
});
