import './style.css';
import * as THREE from 'three/webgpu';
import { load, loadCar, type CameraData, type TestTrack } from './data';
import { buildTestStrip } from './world/testStrip';
import { loadCarModel } from './car/carModel';
import { PlaceholderDrive } from './car/placeholderDrive';
import { ChaseCamera } from './camera/chaseCamera';
import { Keyboard } from './input/keyboard';
import { FrameHud } from './hud/frameHud';
import { cm, kmh, posM, yaw } from './ue';

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

  const [track, camCfg, car] = await Promise.all([
    load<TestTrack>('testtrack.json'),
    load<CameraData>('camera.json'),
    loadCar(params.get('car') ?? 'swift'),
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

  const strip = track.strips[0];
  const drive = new PlaceholderDrive(cm(car.wheelbase_cm));
  posM([strip.start[0] + 30, strip.start[1], 0], drive.position);
  drive.heading = yaw(strip.yaw);
  drive.update(0, 0, 0, 0);

  const chase = new ChaseCamera(camCfg, innerWidth / innerHeight);
  const keys = new Keyboard();
  const hud = new FrameHud(document.body, backend);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
  });

  // read-only handle for tools/check (headless runs)
  (window as unknown as { __br: object }).__br = { drive, chase, model };

  let liveryIndex = 0;
  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    keys.update(dt);
    if (keys.tapped('KeyC')) chase.cycle();
    if (keys.tapped('KeyL')) model.setLivery(car.liveries[(liveryIndex = (liveryIndex + 1) % car.liveries.length)]);
    drive.update(dt, keys.throttle, keys.brake, keys.steer);
    keys.endFrame();

    model.root.position.copy(drive.position);
    model.root.rotation.y = drive.heading;
    model.pose(drive.steerAngle, (drive.speed * dt) / model.wheelRadius);

    chase.update(dt, drive);
    sun.target.position.copy(drive.position);
    sun.position.copy(drive.position).addScaledVector(sunDir, -150);

    hud.extra = `${car.name} · ${kmh(Math.abs(drive.speed)).toFixed(0)} km/h · camera ${chase.presetName}` +
      ` · w s a d drive · c camera · l livery`;
    renderer.render(scene, chase.camera);
    const c = renderer.domElement;
    hud.frame(now, c.width, c.height);
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="fatal">${String(e)}</pre>`);
});
