import './style.css';
import * as THREE from 'three/webgpu';
import { load, loadCar, type CameraData, type TestTrack } from './data';
import { buildTestStrip } from './world/testStrip';
import { loadCarModel } from './car/carModel';
import { ChaseCamera } from './camera/chaseCamera';
import { Controls } from './input/controls';
import { FrameHud } from './hud/frameHud';
import { posM, yaw } from './ue';
import { createWorld, initPhysics } from './sim/physics';
import { buildTestTrackPhysics } from './sim/testTrackPhysics';
import { loadCarTuning } from './sim/tuning';
import { Vehicle } from './sim/vehicle';
import { Simulation } from './sim/simulation';
import { createArcade } from './sim/arcade';

const params = new URLSearchParams(location.search);

async function main() {
  const app = document.getElementById('app')!;

  // WebGPU with its built-in WebGL2 fallback; ?webgl forces the fallback for testing.
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();
  app.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';

  const carId = params.get('car') ?? 'swift';
  const [track, camCfg, car, tuningJson, rapier] = await Promise.all([
    load<TestTrack>('testtrack.json'),
    load<CameraData>('camera.json'),
    loadCar(carId),
    load<Record<string, unknown>>('cars_tuning.json'),
    initPhysics(),
  ]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#B6C7D5');
  scene.add(buildTestStrip(track));

  // Sun from testtrack.json (UE rotator: the direction the light travels).
  const sun = new THREE.DirectionalLight(new THREE.Color(...track.sun.color), 3.2);
  const pitch = (track.sun.pitch * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.cos(pitch), 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw(track.sun.yaw));
  sunDir.y = Math.sin(pitch);
  sunDir.normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -45;
  sc.right = sc.top = 45;
  sc.near = 1;
  sc.far = 300;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#D8E4F0', '#5A6E48', 1.1));

  const model = await loadCarModel(car);
  scene.add(model.root);

  // physics: the test bench's ground and the car
  const world = createWorld(rapier);
  const surfaceAt = buildTestTrackPhysics(rapier, world, track);
  const tuning = loadCarTuning(tuningJson, car as unknown as Record<string, unknown>, carId);
  const vehicle = new Vehicle(rapier, world, tuning, surfaceAt, car.wheel_pos_cm);
  const arcade = createArcade(vehicle);
  vehicle.arcade = arcade;
  const strip = track.strips[0];
  const spawn = () => {
    vehicle.teleport(posM([strip.start[0] + 15, strip.start[1], 0.4]), strip.yaw);
    sim.snap();
  };
  const sim = new Simulation(world, vehicle);
  spawn();

  const chase = new ChaseCamera(camCfg, innerWidth / innerHeight);
  const controls = new Controls();
  const hud = new FrameHud(document.body, backend);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
  });

  // read-only handle for tools/check (headless runs)
  (window as unknown as { __br: object }).__br = { vehicle, chase, model, sim };

  let liveryIndex = 0;
  let last = performance.now();
  const camState = { position: sim.renderPos, forward: new THREE.Vector3(), velocity: vehicle.velocity };
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    const { input, actions } = controls.poll();
    if (actions.has('camera')) chase.cycle();
    if (actions.has('livery')) model.setLivery(car.liveries[(liveryIndex = (liveryIndex + 1) % car.liveries.length)]);
    if (actions.has('recover') && arcade.recover(vehicle, true)) sim.snap();
    if (actions.has('assist')) vehicle.setTractionAssist(!vehicle.tractionAssist);
    sim.advance(dt, input);

    model.root.position.copy(sim.renderPos);
    model.root.quaternion.copy(sim.renderRot);
    model.pose((vehicle.wheelAngleDeg * Math.PI) / 180, vehicle.wheels);

    camState.forward.set(1, 0, 0).applyQuaternion(sim.renderRot);
    chase.update(dt, camState);
    sun.target.position.copy(sim.renderPos);
    sun.position.copy(sim.renderPos).addScaledVector(sunDir, -150);

    const gear = vehicle.gear < 0 ? 'r' : String(vehicle.gear);
    hud.extra = `${car.name} · ${Math.abs(vehicle.forwardSpeedKmh).toFixed(0)} km/h · gear ${gear} · ${vehicle.rpm.toFixed(0)} rpm` +
      ` · traction assist ${vehicle.tractionAssist ? 'on' : 'off'} · camera ${chase.presetName} · ${controls.device}` +
      `\nw s a d drive · space handbrake · r recover · t traction assist · c camera · l livery`;
    renderer.render(scene, chase.camera);
    const c = renderer.domElement;
    hud.frame(now, c.width, c.height);
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="fatal">${String(e)}</pre>`);
});
