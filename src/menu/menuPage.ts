// The menus' page (the original's L_MainMenu + ARallyMenuGameMode): the menu panels (src/menu/menu.ts) over a live
// diorama: a stage (menu.json diorama.locations: the location the player is about to drive) with the picked car
// parked on the road, handbrake on, and the turntable camera circling it. The stage loads behind a curtain while
// the menu is already usable; the curtain lifts once the diorama draws steadily.
//
// The car, its livery, the view, the lock look and the time of day change in place. Another location or weather
// needs another stage build: the curtain rises and the page loads again with the menu's state (sessionStorage), as
// the original rebuilt its diorama behind its curtain (debounced, so scrolling through stages builds only the last).
// Light on purpose: no crowd, no effects, no engine sound.
import * as THREE from 'three/webgpu';
import { load, loadCar, type CameraData } from '../data';
import { Stage, type CatalogEntry, type StageRuntimeJson } from '../world/stage';
import { StageFeatures } from '../world/features';
import { loadCarModel, type CarModel } from '../car/carModel';
import { initPhysics, createWorld } from '../sim/physics';
import { loadCarTuning } from '../sim/tuning';
import { Vehicle, type DriverInput } from '../sim/vehicle';
import { Simulation } from '../sim/simulation';
import { createArcade } from '../sim/arcade';
import { Look } from '../look/look';
import { CONDITIONS, type ConditionsJson } from '../look/conditions';
import { QUALITY } from '../look/quality';
import { AUTO_DEFAULTS, AutoQuality, LADDER, initialRung } from '../look/autoQuality';
import { materialWeather } from '../look/materials';
import { pickWeather, weatherDef, type WeatherJson } from '../game/weather';
import { Precipitation } from '../fx/precip';
import { FrameLimiter, buildRoadMarks, createRenderer, dofOptions, gpuName, lookOverrides, type DofJson } from '../boot';
import { OrbitCamera } from '../camera/orbitCamera';
import { loadSave, unlockAll, writeSave } from '../game/save';
import {
  loadDisplaySettings, loadGameSettings, loadHudSettings, loadRunSettings, loadVolumes, saveDisplaySettings, saveGameSettings, saveHudSettings, saveVolumes,
} from '../settings';
import { CAR_IDS, dioramaConfig, loadMenuData, locationOf, type CarInfo } from './data';
import { Menu, menuHref, type MenuDiorama } from './menu';
import { putMenuState, takeMenuState } from './nav';
import { Padlock } from './padlock';
import type { SettingsHost } from './settingsPanel';

const HANDBRAKE: DriverInput = { throttle: 0, brake: 0, steer: 0, digitalSteer: false, handbrake: true };

export async function runMenu(params: URLSearchParams): Promise<void> {
  const data = await loadMenuData();
  const start = { groups: data.career.start_groups, cars: data.career.start_cars };
  const save = loadSave(start);
  if (params.has('unlockall')) {
    // development: every car and bonus livery (the career unlocks them: slice 10)
    unlockAll(save, CAR_IDS, data.menu.groups.map((g) => g.id));
    writeSave(save);
  }
  const state = takeMenuState();
  const dio = data.menu.diorama;
  const display = loadDisplaySettings();
  const game = loadGameSettings();
  const hud = loadHudSettings(params);
  const volumes = loadVolumes();
  let audio: Awaited<ReturnType<typeof import('../audio').startMenuAudio>> = null;
  let applyDisplay = () => {};
  const host: SettingsHost = {
    cameraNames: ['near', 'default', 'far', 'top'], defaultCamera: 1, presetFov: () => 40,
    game, display, hud, volumes,
    applyGame: () => saveGameSettings(game),
    applyDisplay: () => {
      saveDisplaySettings(display);
      applyDisplay();
    },
    applyHud: () => saveHudSettings(hud),
    applyVolumes: () => {
      if (audio) {
        Object.assign(audio.sys.volumes, volumes);
        audio.sys.applyVolumes(false, true);
      } else saveVolumes(volumes);
    },
    isFullscreen: () => !!document.fullscreenElement,
    setFullscreen: (on) => void (on ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.())?.catch?.(() => {}),
  };
  void load<CameraData>('camera.json').then((c) => {
    host.cameraNames = c.presets.map((p) => p.name);
    host.defaultCamera = c.default_preset;
    host.presetFov = (i) => c.presets[i]?.fov_v_deg ?? 40;
  });

  // ---------------------------------------------------------------- the diorama's state, before it exists
  const run = loadRunSettings();
  const initialLocation = locationOf(data, run.stage || dio.location);
  let loaded: { location: string; weather: string; condition: string } | null = null;
  let first: { location: string; weather: string | null; condition: string | null } | null = null;
  let pending: { location: string; weather: string } | null = null;
  let pendingSince = 0;
  let curtain = 1;
  let carWant = { car: '', livery: 0 };
  let view: 'title' | 'garage' = 'title';
  let locked = false;
  let conditionWant: string | null = null;
  // set once the stage is up
  let api: { showCar(car: string, livery: number): void; setCondition(name: string): void } | null = null;

  const weatherFor = (location: string, w: string | null) => w ?? dioramaConfig(data.menu, location).weather ?? 'clear';
  const diorama: MenuDiorama = {
    showCar(car, livery) {
      carWant = { car, livery };
      api?.showCar(car, livery);
    },
    setView(v) {
      view = v;
    },
    setLocked(on) {
      locked = on;
    },
    setCondition(name) {
      conditionWant = name;
      api?.setCondition(name);
    },
    want(location, weather, condition) {
      if (!loaded) {
        // the first request picks what to build ('' = the last stage's location)
        if (!first || location) first = { location: location || initialLocation, weather, condition };
        return;
      }
      const loc = location || loaded.location;
      const w = location ? weatherFor(loc, weather) : loaded.weather;
      if (loc !== loaded.location || w !== loaded.weather) {
        if (!pending || pending.location !== loc || pending.weather !== w) pendingSince = performance.now();
        pending = { location: loc, weather: w };
      } else pending = null;
      const c = condition ?? dioramaConfig(data.menu, loaded.location).condition;
      diorama.setCondition(c);
    },
    get curtain() {
      return curtain;
    },
  };

  const menu = new Menu(data, save, diorama, host, params, state);
  const uiLoop = () => {
    menu.frame();
    requestAnimationFrame(uiLoop);
  };
  requestAnimationFrame(uiLoop);
  void import('../audio').then(({ startMenuAudio }) => startMenuAudio(params)).then((h) => {
    audio = h;
    if (h) menu.music = { title: () => (h.music.wantPlay && h.sys.running ? h.music.title : ''), skip: (d) => h.music.step(d > 0 ? 1 : -1) };
  }).catch((e) => console.error('audio:', e));

  // ---------------------------------------------------------------- build the diorama
  const want = first ?? { location: initialLocation, weather: null, condition: null };
  const cfg = dioramaConfig(data.menu, want.location);
  const stageId = cfg.stage;
  const weatherJson = await load<WeatherJson>('weather.json');
  const weatherName = pickWeather(weatherJson, weatherFor(want.location, want.weather), stageId, cfg.reverse);
  const weather = weatherDef(weatherJson, weatherName);
  materialWeather.kind = weatherName;
  const condition = want.condition ?? cfg.condition;
  loaded = { location: want.location, weather: weatherName, condition };

  const qParam = params.get('quality');
  const pinnedByUrl = !!qParam && qParam !== 'auto' && !!QUALITY[qParam];
  const wantAuto = () => !pinnedByUrl && (qParam === 'auto' || display.quality === 'auto');
  const { renderer } = await createRenderer(params, params.has('gputime') || wantAuto());
  const [camCfg, catalog, runtime, conditions, rapier, tuningJson] = await Promise.all([
    load<CameraData & { dof: DofJson }>('camera.json'),
    load<Record<string, CatalogEntry>>('env_catalog.json'),
    load<StageRuntimeJson>('stage_runtime.json'),
    load<ConditionsJson>('conditions.json'),
    initPhysics(),
    load<Record<string, unknown>>('cars_tuning.json'),
  ]);
  const scene = new THREE.Scene();
  const world = createWorld(rapier);
  const stage = await Stage.load(stageId, catalog, runtime, rapier, world);
  scene.add(stage.group);
  for (const c of weather.hide_categories ?? []) stage.hidden.add(c);
  const features = new StageFeatures(stage, runtime.features ?? {});
  features.frozen = !!weather.fords_frozen;
  buildRoadMarks(stageId, stage, features, weather, rapier, world, scene);
  const applyDraw = () => {
    const scale = runtime.draw_distance.scale.default;
    stage.drawDistance = scale[display.drawDistance < 0 ? 2 : display.drawDistance] ?? 2;
  };
  applyDraw();

  // the parked car: a real car on the road with the handbrake on (UE: not possessed, silent)
  const sign = cfg.reverse ? -1 : 1;
  const pose = stage.road.pose(cfg.s, sign, cfg.lateral_m);
  const yawDeg = pose.yawDeg + cfg.yaw_offset;
  const orbit = new OrbitCamera(dio.views.title, cfg.start_yaw, innerWidth / innerHeight, dio.turn_deg_s);
  let car: { id: string; info: CarInfo; model: CarModel; vehicle: Vehicle; sim: Simulation } | null = null;
  let carToken = 0;
  const lockCfg = dio.locked;
  const padlock = new Padlock(lockCfg);
  padlock.forceWebGL = !(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  padlock.fallbackScene = scene;

  const placeCar = async (id: string, livery: number) => {
    const token = ++carToken;
    const info = (await loadCar(id)) as CarInfo;
    const model = await loadCarModel(info);
    if (token !== carToken) return;
    model.setLivery(info.liveries[Math.min(livery, info.liveries.length - 1)]);
    if (car) {
      world.removeRigidBody(car.vehicle.body);
      scene.remove(car.model.root);
    }
    const tuning = loadCarTuning(tuningJson, info as unknown as Record<string, unknown>, id);
    const vehicle = new Vehicle(rapier, world, tuning, stage.surfaceAt, info.wheel_pos_cm);
    vehicle.arcade = createArcade(vehicle);
    const sim = new Simulation(world, vehicle);
    sim.maxSteps = 240;
    vehicle.teleport(pose.position.clone().add(new THREE.Vector3(0, 0.4, 0)), yawDeg);
    sim.snap();
    sim.advance(1.5, HANDBRAKE); // settle on its springs before it shows
    scene.add(model.root);
    car = { id, info, model, vehicle, sim };
    orbit.fitTo(info.length_cm, dio.views.fit_length_cm);
    syncModel();
    padlock.placeOver(model.root);
    look?.setCar({ root: model.root, headlightPosCm: (info as unknown as { headlight_pos_cm: number[][] }).headlight_pos_cm });
  };
  const syncModel = () => {
    if (!car) return;
    car.model.root.position.copy(car.sim.renderPos);
    car.model.root.quaternion.copy(car.sim.renderRot);
    car.model.pose(0, car.vehicle.wheels);
  };
  let look: Look | null = null;
  await placeCar(carWant.car || CAR_IDS[0], carWant.livery);

  const gpu = gpuName(renderer);
  const pinnedScale = () => (params.has('scale') ? Math.min(Math.max(Number(params.get('scale')) || 1, 0.25), 1) : display.renderScale > 0 ? display.renderScale / 100 : null);
  const limiter = new FrameLimiter();
  const fpsLimit = () => (params.has('fps') ? Number(params.get('fps')) || 0 : display.fpsLimit);
  limiter.fps = fpsLimit();
  const autoOpts = () => ({ ...AUTO_DEFAULTS, missMs: Math.max(AUTO_DEFAULTS.missMs, limiter.fps > 0 ? (1000 / limiter.fps) * 1.2 : 0) });
  let auto = wantAuto() ? new AutoQuality(initialRung(gpu, innerWidth * innerHeight * renderer.getPixelRatio() ** 2), autoOpts()) : null;
  const pinnedTier = () => (pinnedByUrl ? qParam! : display.quality === 'auto' ? 'high' : display.quality);
  const night = dio.look?.any?.by_condition?.night?.scale?.headlights?.props;
  const firstCar = car!;
  look = new Look(renderer, scene, orbit.camera, conditions, {
    stage: stageId,
    condition: CONDITIONS.includes(condition as (typeof CONDITIONS)[number]) ? condition : 'afternoon',
    quality: auto ? LADDER[auto.rung].tier : pinnedTier(),
    scale: pinnedScale() ?? (auto ? LADDER[auto.rung].scale : 1),
    upscale: 'browser',
    post: params.get('post') !== '0',
    override: lookOverrides(params),
    dof: dofOptions(camCfg.dof, params),
    weather: weatherName === 'clear' ? null : weather,
    headlightScale: { intensity: night?.Intensity ?? 1, range: night?.AttenuationRadius ?? 1 },
  }, { root: firstCar.model.root, headlightPosCm: (firstCar.info as unknown as { headlight_pos_cm: number[][] }).headlight_pos_cm });
  const lk = look;
  lk.setCondition(loaded.condition);
  lk.dofOverride = { fstop: 8, past: 0 };
  lk.onQuality = (q) => stage.setLod(q.lod);
  lk.onQuality(lk.quality, lk.qualityName);
  applyDisplay = () => {
    limiter.fps = fpsLimit();
    if (wantAuto()) {
      if (!auto) auto = new AutoQuality(initialRung(gpu, innerWidth * innerHeight * (renderer.getPixelRatio() / Math.max(lk.scale, 0.01)) ** 2), autoOpts());
      lk.setQuality(LADDER[auto.rung].tier, pinnedScale() ?? LADDER[auto.rung].scale);
    } else {
      auto = null;
      lk.setQuality(pinnedTier(), pinnedScale() ?? 1);
    }
    applyDraw();
  };
  const precip = weather.precip && (weather.precip.count ?? 0) > 0 && params.get('fx') !== '0'
    ? new Precipitation(weather.precip, world, rapier, firstCar.vehicle.body) : null;
  if (precip) scene.add(precip.mesh);

  api = {
    showCar: (id, livery) => {
      if (car && car.id === id) car.model.setLivery(car.info.liveries[Math.min(livery, car.info.liveries.length - 1)]);
      else void placeCar(id, livery);
    },
    setCondition: (name) => {
      if (CONDITIONS.includes(name as (typeof CONDITIONS)[number]) && lk.cond?.name !== name) lk.setCondition(name);
    },
  };
  const currentCar = (): { id: string } | null => car;
  if (carWant.car && carWant.car !== currentCar()?.id) api.showCar(carWant.car, carWant.livery);
  if (conditionWant) api.setCondition(conditionWant);

  // warm up: place the camera, build the pipelines behind the curtain
  const carYaw = () => {
    const f = new THREE.Vector3(1, 0, 0).applyQuaternion(car!.sim.renderRot);
    return (Math.atan2(f.z, f.x) * 180) / Math.PI;
  };
  orbit.update(0, car!.sim.renderPos, carYaw());
  stage.updateInstances(orbit.camera.position, true, car!.sim.renderPos);
  lk.update(0, car!.sim.renderPos, innerWidth, innerHeight);
  stage.warmup(() => lk.render());

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    orbit.camera.aspect = innerWidth / innerHeight;
    orbit.camera.updateProjectionMatrix();
  };
  addEventListener('resize', onResize);
  onResize();

  const br = { menu, renderer, look: lk, orbit, stage, save, get car() {
    return car;
  }, get curtain() {
    return curtain;
  }, get auto() {
    return auto;
  }, gpu, ready: false, loaded, padlock };
  (window as unknown as { __br: object }).__br = br;

  let last = performance.now();
  let warm = 0;
  let stable = 0;
  let fading = false;
  let blurK = 0;
  let gpuMs = 0;
  renderer.setAnimationLoop((now: number) => {
    if (!limiter.due(now)) return;
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 0.1);
    last = now;
    // the curtain (UE: hold until 15 steady frames after 0.8 s, at most 5 s; fade 0.8 s; a swap raises it in 0.3 s)
    if (pending) {
      curtain = Math.min(1, curtain + dt / 0.3);
      if (curtain >= 1 && now - pendingSince >= dio.swap_debounce_s * 1000) {
        putMenuState(menu.state());
        location.replace(menuHref(params));
        pending = null;
        renderer.setAnimationLoop(null);
        return;
      }
    } else if (!fading) {
      warm += dt;
      stable = frameMs < 40 ? stable + 1 : 0;
      if ((warm > 0.8 && stable >= 15) || warm > 5) fading = true;
    } else curtain = Math.max(0, curtain - dt / 0.8);
    br.ready = curtain === 0;

    const c = car!;
    c.sim.advance(dt, HANDBRAKE);
    syncModel();
    const v = view === 'garage' ? dio.views.garage : dio.views.title;
    orbit.view = v;
    orbit.update(dt, c.sim.renderPos, carYaw());
    // a locked car or livery: out of focus (focus pulled focus_past_cm behind it at fstop), the padlock sharp over it
    blurK = Math.min(Math.max(blurK + (locked ? dt : -dt) / 0.35, 0), 1);
    const k = blurK * blurK * (3 - 2 * blurK);
    lk.dofOverride = { fstop: 8 + (lockCfg.fstop - 8) * k, past: (lockCfg.focus_past_cm / 100) * k };
    padlock.visible = locked && curtain < 0.5;
    padlock.update(dt);
    stage.updateInstances(orbit.camera.position, false, c.sim.renderPos);
    precip?.update(dt, c.sim.renderPos, new THREE.Vector3(1, 0, 0).applyQuaternion(c.sim.renderRot), c.vehicle.velocity, orbit.camera.position, null);
    const cv = renderer.domElement;
    lk.update(dt, c.sim.renderPos, cv.width, cv.height);
    lk.render();
    padlock.render(orbit.camera);
    if (auto) {
      void renderer.resolveTimestampsAsync('render').then((ms) => {
        if (typeof ms === 'number' && ms > 0) gpuMs = ms;
      });
      const r = auto.frame(frameMs, gpuMs);
      if (r !== null) lk.setQuality(LADDER[r].tier, pinnedScale() ?? LADDER[r].scale);
    }
  });
}
