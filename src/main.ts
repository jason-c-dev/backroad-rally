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
import {
  loadDisplaySettings, loadGameSettings, loadHudSettings, loadRunSettings, loadVolumes, saveDisplaySettings, saveGameSettings, saveHudSettings,
  saveRunSettings, saveVolumes, type HudSettings,
} from './settings';
import { posM } from './ue';
import { createWorld, initPhysics } from './sim/physics';
import { buildTestTrackPhysics } from './sim/testTrackPhysics';
import { loadCarTuning } from './sim/tuning';
import { Vehicle, type DriverInput, type SurfaceQuery } from './sim/vehicle';
import { Simulation } from './sim/simulation';
import { createArcade } from './sim/arcade';
import { DEFAULT_RULES, RoadTracker } from './sim/road';
import { StageRun, DEFAULT_FLOW, formatTime, type FlowConfig } from './game/stageRun';
import { Autopilot, DEFAULT_AUTOPILOT } from './game/autopilot';
import { Look } from './look/look';
import { CONDITIONS, pickCondition, type ConditionsJson } from './look/conditions';
import { QUALITY } from './look/quality';
import { AUTO_DEFAULTS, AutoQuality, initialRung, rememberRung, rememberedRung } from './look/autoQuality';
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
// weather (slice 8)
import { arcadeScale, iceWeightAt, nextWeather, pickWeather, weatherDef, type WeatherDef, type WeatherJson } from './game/weather';
import { materialWeather } from './look/materials';
import { Precipitation } from './fx/precip';
import type { RoadMarks } from './fx/roadMarks';
import { deepMerge } from './sim/tuning';
// game flow (slice 9)
import { FrameLimiter, buildRoadMarks, createRenderer, dofOptions, gpuName, lookOverrides, type DofJson } from './boot';
import { pageKind, parsePlay, putMenuState, type PlaySetup } from './menu/nav';
import { careerRules, loadMenuData, stageMeta } from './menu/data';
import { careerLine, loadingCard, menuHref } from './menu/menu';
import { GETTING_READY, nextPaint } from './menu/busy';
import { playQuery } from './menu/nav';
import { StageMenus, type ResultsInfo } from './menu/stageMenus';
import type { SettingsHost } from './menu/settingsPanel';
import { bestKey, loadSave, recordBest, writeSave } from './game/save';
import type { AudioHandle } from './audio';
// career and ghosts (slice 10)
import { clone, isRev, type CareerState, type StageResult } from './game/career';
import { BestGhost, RivalGhosts, careerRivals, loadRefLine, quickRivals, sampleOf, type GhostCfg, type RivalCfg, type RivalPick } from './game/ghosts';
import type { GhostSample } from './game/ghostCodec';
import { loadCar as loadCarData } from './data';
import type { CarData } from './data';

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
  /** Restart the run on the next frame (Enter, the pause menu, the results). */
  restart?(): void;
  /** What the HUD shows of the damage (null = off), and the condition for the intro card. */
  damageView?(): HudInfo['damage'];
  condition?(): string;
  /** The stage HUD (stages only). */
  hud?: StageHud;
  /** Snow's ice patches (s ranges, m) and the road marks (stages only). */
  ice?: [number, number][];
  marks?: RoadMarks | null;
}

async function main() {
  // ?hud=0 hides every overlay (look comparisons)
  if (params.get('hud') === '0') document.body.classList.add('no-hud');
  const kind = pageKind(params);
  if (kind === 'menu') {
    const { runMenu } = await import('./menu/menuPage');
    await runMenu(params);
    return;
  }
  await runStage(kind === 'play' ? parsePlay(params) : null);
}

/**
 * A stage run: from the stage select (?mode=quick|attack&..., `play`), or a development URL (?stage=, ?car=,
 * ?autopilot=: `play` null) that skips the menus as before.
 */
async function runStage(play: PlaySetup | null) {
  // the loading card first (UE: the stage level shows the menu's card while it warms up)
  const menuData = await loadMenuData().catch(() => null);
  const startUnlocks = menuData ? { groups: menuData.career.start_groups, cars: menuData.career.start_cars } : undefined;
  // --- career ---
  // the career's next stage comes from the save, not the URL (src/game/career.ts): service at a rally's start, the
  // car checked against the season, then the save is written and kept as the snapshot a restart goes back to
  const rules = menuData ? careerRules(menuData) : null;
  let career: CareerState | null = null;
  let careerSnapshot: CareerState | null = null;
  let careerDef: ReturnType<NonNullable<typeof rules>['startStage']> = null;
  if (play?.mode === 'career') {
    const sv = rules ? loadSave(startUnlocks) : null;
    career = sv && rules ? rules.load(sv.career) : null;
    careerDef = career && rules ? rules.startStage(career) : null;
    if (!sv || !career || !careerDef || !rules) {
      putMenuState({ screen: 'career', flow: 'career' });
      location.assign(menuHref(params));
      return;
    }
    sv.career = career as unknown as Record<string, unknown>;
    writeSave(sv);
    careerSnapshot = clone(career);
    play = { ...play, stage: careerDef.stage, reverse: isRev(careerDef.variant), car: career.car, livery: career.livery, cond: careerDef.condition, weather: rules.stageWeather(careerDef) };
  }
  // --- /career ---
  const carId = play?.car ?? params.get('car') ?? 'swift';
  const stageId = play?.stage ?? params.get('stage') ?? 'finland';
  const reverse = play ? play.reverse : params.get('dir') === 'reverse';
  // start the small files the run reads later now, beside the stage's big ones (they were fetched one after another)
  for (const f of ['fx.json', 'damage.json', 'hud.json', `rival_lines/${stageId}_${reverse ? 'rev' : 'fwd'}.json`]) void load(f).catch(() => {});
  const gameSettings = loadGameSettings();
  const display = loadDisplaySettings();
  const hudSettings = loadHudSettings(params);
  const runCfg = await load<StageRuntimeJson & { flow: FlowConfig & Record<string, number> }>('stage_runtime.json');
  const flowCfg = { ...DEFAULT_FLOW, warmup_min_s: 1.5, warmup_max_s: 6, warmup_frame_ms: 25, warmup_stable_frames: 45, curtain_fade_s: 0.6, ...runCfg.flow };
  const meta = menuData ? stageMeta(menuData, stageId) : undefined;
  const subPause = [meta?.name ?? stageId, meta?.location ?? '', reverse ? 'reverse' : 'forward'].filter(Boolean).join('  ·  ');
  const subResults = [meta?.location ?? '', meta?.name ?? stageId, reverse ? 'reverse' : 'forward'].filter(Boolean).join('  ·  ');

  // late-bound pieces the menus act on
  let level: Level | undefined;
  let paused = false;
  let audio: AudioHandle | null = null;
  const actions = { restart: () => {}, recover: () => {}, applyGame: () => {}, applyDisplay: () => {}, applyHud: () => {} };
  const volumes = loadVolumes();
  const settingsHost: SettingsHost = {
    cameraNames: [], defaultCamera: 1, presetFov: () => 40,
    game: gameSettings, display, hud: hudSettings, volumes,
    applyGame: () => {
      saveGameSettings(gameSettings);
      actions.applyGame();
    },
    applyDisplay: () => {
      saveDisplaySettings(display);
      actions.applyDisplay();
    },
    applyHud: () => {
      saveHudSettings(hudSettings);
      actions.applyHud();
    },
    applyVolumes: () => {
      if (audio) {
        Object.assign(audio.sys.volumes, volumes);
        audio.sys.applyVolumes(false, true);
      } else saveVolumes(volumes);
    },
    isFullscreen: () => !!document.fullscreenElement,
    setFullscreen: (on) => void (on ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.())?.catch?.(() => {}),
  };
  const quitTo = (screen: 'title' | 'stageselect' | 'career') => {
    putMenuState({
      screen, flow: play?.mode ?? 'quick', car: carId, livery: play?.livery ?? 0, stage: stageId, reverse,
      cond: play?.cond ?? 'stage', weather: play?.weather ?? 'stage',
    });
    menus.leave();
    void nextPaint().then(() => location.assign(menuHref(params)));
  };
  const careerHooks = { continue: () => {} };
  const menus = new StageMenus({
    sub: subPause,
    controls: menuData?.menu.controls ?? [],
    mode: play?.mode ?? 'dev',
    restartsLeft: () => career?.restartsLeft ?? 99,
    restartsTotal: rules?.restartsPerSeason,
    careerContinue: () => careerHooks.continue(),
    canPause: () => {
      const run = (level as { run?: StageRun } | undefined)?.run;
      return !!run && run.phase !== 'results';
    },
    onPause: (p) => {
      paused = p;
      level?.hud && (level.hud.panelOpen = p);
      audio?.sys.setPaused(p);
    },
    restart: () => actions.restart(),
    recover: () => actions.recover(),
    quit: quitTo,
    settings: settingsHost,
  }, flowCfg);
  if (menuData) {
    menus.showCard(loadingCard(menuData, play ?? {
      mode: 'quick', stage: stageId, reverse, car: carId, livery: 0, cond: params.get('cond') ?? 'afternoon', weather: params.get('weather') ?? 'clear',
    }, career && rules ? careerLine(rules, career) : undefined));
    if (!play) (menus.root.querySelector('.loading .card > :nth-child(3)') as HTMLElement | null)?.replaceChildren('development');
  }
  menus.setBusy('loading stage');

  // quality: ?quality=<tier> pins it for a visit, else the setting (auto = adaptive, autoQuality.ts)
  const qParam = params.get('quality');
  const pinnedByUrl = !!qParam && qParam !== 'auto' && !!QUALITY[qParam];
  const wantAuto = () => !pinnedByUrl && (qParam === 'auto' || display.quality === 'auto');
  const { renderer, backend } = await createRenderer(params, params.has('gputime') || wantAuto());
  document.body.classList.toggle('no-debug', !hudSettings.debug);

  const [camCfg, car, tuningJson, rapier, conditions, weatherJson] = await Promise.all([
    load<CameraData & { dof: DofJson }>('camera.json'),
    loadCar(carId),
    load<Record<string, unknown>>('cars_tuning.json'),
    initPhysics(),
    load<ConditionsJson>('conditions.json'),
    load<WeatherJson>('weather.json'),
  ]);
  settingsHost.cameraNames = camCfg.presets.map((p) => p.name);
  settingsHost.defaultCamera = camCfg.default_preset;
  settingsHost.presetFov = (i) => camCfg.presets[i]?.fov_v_deg ?? 40;
  // the weather (slice 8): the stage select's pick (stage = the stage's own), else ?weather=, else the stored choice (key J)
  const runSettings = loadRunSettings();
  const weatherName = pickWeather(weatherJson, play ? play.weather : params.get('weather'), stageId, reverse, play ? null : runSettings.weather);
  const weather = weatherDef(weatherJson, weatherName);
  const clearWeather = weatherName === 'clear';
  // the materials build the weather code only in rain or snow (before the stage and the car load)
  materialWeather.kind = weatherName;

  const scene = new THREE.Scene();
  const world = createWorld(rapier);

  const hudRoot = document.body;
  let vehicle!: Vehicle;
  let sim!: Simulation;
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
    level = await buildStageLevel(stageId, reverse, rapier, world, scene, () => vehicle, () => sim, hudRoot, hudSettings, weather);
  }

  const model = await loadCarModel(car);
  scene.add(model.root);
  const liveryParam = play?.livery ?? Number(params.get('livery') ?? 0);
  let liveryIndex = Math.min(Math.max(Math.round(liveryParam) || 0, 0), car.liveries.length - 1);
  if (liveryIndex) model.setLivery(car.liveries[liveryIndex]);
  const tuning = loadCarTuning(tuningJson, car as unknown as Record<string, unknown>, carId);
  vehicle = new Vehicle(rapier, world, tuning, level.surfaceAt, car.wheel_pos_cm);
  const arcade = createArcade(vehicle);
  vehicle.arcade = arcade;
  // weather grip per surface, the arcade multipliers (handbrake yaw x1.8 in rain), snow's ice patches; clear
  // weather leaves the car untouched
  if (!clearWeather) {
    const tracker = (level as { tracker?: RoadTracker }).tracker;
    const patches = level.ice ?? [];
    const edge = weather.ice?.edge_m ?? 3;
    const ice = tracker && patches.length ? {
      grip: weather.ice?.grip ?? 0.3,
      // UE GetIceAt: the road projection near the car's, within the road (+1 m), soft patch ends
      at: (p: THREE.Vector3) => {
        const q = tracker.road.project(p, tracker.proj?.index ?? -1);
        return Math.abs(q.lateral) > q.halfWidth + 1 ? 0 : iceWeightAt(patches, q.s, edge);
      },
    } : null;
    vehicle.applyWeather(weather.grip, arcadeScale(weather), ice);
  }
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
  // the settings' camera, field of view and assists (UE ApplySettingsToCar): the assists scale the car's own
  // defaults, so 100% is the tuned car
  actions.applyGame = () => {
    chase.setPreset(gameSettings.camera);
    chase.fovOverride = gameSettings.fov;
    arcade.stabilityAssist = vehicle.t.arcade.stability_default * gameSettings.stability;
    arcade.countersteerAssist = vehicle.t.arcade.countersteer_default * gameSettings.countersteer;
    if (vehicle.tractionAssist !== gameSettings.tractionAssist) vehicle.setTractionAssist(gameSettings.tractionAssist);
  };
  actions.applyGame();

  // the look (slice 5): conditions, fog, shadows, post. ?cond=morning|afternoon|sunset|night|fog (or stage),
  // ?post=0 (P toggles), ?quality=auto|high|medium|low, ?scale=0.5..1 (render scale)
  const gpu = gpuName(renderer);
  /** Render scale pinned by ?scale= (a visit) or the render resolution setting; null = auto's ladder (or 1). */
  const pinnedScale = () => (params.has('scale') ? Math.min(Math.max(Number(params.get('scale')) || 1, 0.25), 1) : display.renderScale > 0 ? display.renderScale / 100 : null);
  /** The frame-rate limit: the setting, ?fps= for a visit; headless runs (autopilot, timescale) run uncapped. */
  const limiter = new FrameLimiter();
  const fpsLimit = () => (params.has('fps') ? Number(params.get('fps')) || 0 : params.has('autopilot') || timeScale !== 1 ? 0 : display.fpsLimit);
  /** Auto quality counts a frame as missed past one interval of the cap (a 30 fps cap isn't a miss at 33 ms). */
  const autoOpts = () => ({ ...AUTO_DEFAULTS, missMs: Math.max(AUTO_DEFAULTS.missMs, limiter.fps > 0 ? (1000 / limiter.fps) * 1.2 : 0) });
  limiter.fps = fpsLimit();
  // auto quality starts where the last visit to this stage settled (same GPU and screen), else from a guess; it
  // settles behind the loading curtain (?autostart=<rung> forces the start, for checks)
  const autoPixels = innerWidth * innerHeight * renderer.getPixelRatio() ** 2;
  const autoKey = `${innerWidth}x${innerHeight}@${renderer.getPixelRatio().toFixed(2)}`;
  const remembered = params.has('autostart') ? null : rememberedRung(gpu, autoKey, `stage:${stageId}`);
  const autoStart = params.has('autostart') ? Number(params.get('autostart')) : remembered ?? initialRung(gpu, autoPixels);
  // a remembered tier held here before: one clean window confirms it (two for a guess)
  let auto = wantAuto() ? new AutoQuality(autoStart, { ...autoOpts(), settleGood: remembered !== null ? 1 : 2 }) : null;
  const pinnedTier = () => (pinnedByUrl ? qParam! : display.quality === 'auto' ? 'high' : display.quality);
  let condIndex = Math.max(0, CONDITIONS.indexOf(pickCondition(conditions, play ? play.cond : params.get('cond'), stageId, reverse) as (typeof CONDITIONS)[number]));
  const look = new Look(renderer, scene, chase.camera, conditions, {
    stage: stageId,
    condition: CONDITIONS[condIndex],
    quality: auto ? auto.current.tier : pinnedTier(),
    scale: pinnedScale() ?? (auto ? auto.current.scale : 1),
    upscale: params.get('upscale') === 'fsr' ? 'fsr' : 'browser',
    post: params.get('post') !== '0',
    override: lookOverrides(params),
    dof: dofOptions(camCfg.dof, params),
    weather: clearWeather ? null : weather,
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
  // draw distance: ?draw=near|medium|far|max or a multiplier for a visit, else the setting (default far, x2)
  const applyDraw = () => {
    if (!stageLevel) return;
    const draw = params.get('draw');
    const names = ['near', 'medium', 'far', 'max'];
    const scale = runCfg.draw_distance.scale.default;
    if (draw) stageLevel.drawDistance = names.includes(draw) ? scale[names.indexOf(draw)] : Number(draw) || stageLevel.drawDistance;
    else stageLevel.drawDistance = scale[display.drawDistance < 0 ? 2 : display.drawDistance] ?? 2;
  };
  applyDraw();
  // the display settings, at once: quality (auto or a tier), render resolution, draw distance, frame-rate limit
  actions.applyDisplay = () => {
    limiter.fps = fpsLimit();
    if (wantAuto()) {
      // switched to auto in the settings: it settles while the menu is open, then plays on
      if (!auto) auto = new AutoQuality(initialRung(gpu, innerWidth * innerHeight * (renderer.getPixelRatio() / Math.max(look.scale, 0.01)) ** 2), autoOpts());
      look.setQuality(auto.current.tier, pinnedScale() ?? auto.current.scale);
    } else {
      auto = null;
      look.setQuality(pinnedTier(), pinnedScale() ?? 1);
    }
    applyDraw();
  };
  // dev keys: P post on/off, K next condition
  addEventListener('keydown', (e) => {
    if (menus.open) return;
    if (e.code === 'KeyP') look.setPost(!look.post.enabled);
    if (e.code === 'KeyK') look.setCondition(CONDITIONS[(condIndex = (condIndex + 1) % CONDITIONS.length)]);
  });
  // --- fx ---
  // effects (src/fx), spectators (src/world/crowd.ts), breakables (src/world/breakables.ts) and the car's game events (src/game/carEvents.ts).
  // They hook the level's per-step and per-frame calls and only read the car: the sim runs unchanged.
  // ?fx=0 draws no effects (events still fire), ?crowd=0 places no spectators.
  // the weather's effects over fx.json (rain: less dust, darker chips; snow: white powder, white tyre tracks)
  const fxBase = await load<FxJson>('fx.json');
  const fxCfg = (clearWeather || !weather.fx ? fxBase : deepMerge(fxBase as unknown as Record<string, unknown>, weather.fx)) as unknown as FxJson;
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
  // rain streaks or snow flakes around the camera, and the rain's splashes (src/fx/precip.ts)
  const precip = weather.precip && (weather.precip.count ?? 0) > 0 && fx.enabled ? new Precipitation(weather.precip, world, rapier, vehicle.body) : null;
  if (precip) scene.add(precip.mesh);
  /** Share of the precipitation drawn per tier (perf budget, see docs/reference.md). */
  const PRECIP_SCALE: Record<string, number> = { high: 1, medium: 1, low: 1 };
  const lookOnQuality = look.onQuality;
  look.onQuality = (q, name) => {
    lookOnQuality?.(q, name);
    fx.setQuality(name);
    if (precip) precip.scale = PRECIP_SCALE[name] ?? 1;
  };
  fx.setQuality(look.qualityName);
  if (precip) precip.scale = PRECIP_SCALE[look.qualityName] ?? 1;
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
  const precipFwd = new THREE.Vector3();
  const levelFrame = level.frame?.bind(level);
  level.frame = (dt, cameraPos) => {
    levelFrame?.(dt, cameraPos);
    features?.frame(dt, vehicle, (level as { tracker?: RoadTracker }).tracker?.proj ?? null, fx.enabled ? fx.pools.dust : null, sprayRng);
    fx.update(dt, vehicle, sim.renderPos, sim.renderRot, look);
    precip?.update(dt, sim.renderPos, precipFwd.set(1, 0, 0).applyQuaternion(sim.renderRot), vehicle.velocity, cameraPos, fx.enabled ? fx.pools.puff : null);
    const run = (level as { run?: { phase: string; dnf: boolean } }).run;
    // a retired run coasts like a finish but gets no applause (the original's NotifyFinish skips a DNF)
    const crowdPhase = run?.dnf && run.phase === 'finished' ? 'retired' : run?.phase ?? 'running';
    crowd?.update(dt, { position: vehicle.position, kmh: vehicle.speedKmh, airborne: vehicle.wheelsInContact === 0 },
      crowdPhase, cameraPos, stageLevel?.drawDistance ?? 2);
    breakables?.update(dt, vehicle, run?.phase ?? 'running');
  };
  (window as unknown as { __fx: object }).__fx = { fx, crowd, breakables, carEvents, events: fxEvents, precip };
  // --- /fx ---
  // --- damage ---
  // src/game/damage.ts: the body's contact impulses (src/game/contacts.ts, read before every physics step) make
  // hits; damage costs torque and pulls the steering, dirties the paint, smokes and burns (src/fx/damageFx.ts),
  // and terminal damage retires the run. ?damage=0|0.5|1 = the level; from the menus quick stage is half
  // (menu.json quick_damage_level) and time attack has none, as in the original.
  const damageCfg = await load<DamageJson>('damage.json');
  const damageLevel = play
    ? (play.mode === 'attack' ? 0 : play.mode === 'career' ? rules?.damageLevel ?? 1 : menuData?.menu.quick_damage_level ?? 0.5)
    : params.has('damage') ? Math.min(Math.max(Number(params.get('damage')) || 0, 0), 1) : 1;
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
  // career: the damage carried from the rally's previous stage (the stage start's, also after a restart)
  const carried = () => {
    if (career && career.carriedDamage > 0) damage.carry(career.carriedDamage, career.carriedParts);
  };
  carried();
  level.onRestart = () => {
    damage.repair();
    carried();
  };
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
  // --- ghosts ---
  // src/game/ghosts.ts: the ghost of the best run (quick stage, time attack; setting "ghost of best run") and the rival
  // ghosts (career: all unless the setting is off; quick stage and time attack: the setting off / 3 / all). They read
  // the run and the car, never write. Development: ?rivals=<n> sets the count in any mode, ?devghost=1 races the
  // stage's reference line as the best ghost (perf checks).
  const tracker = (level as { tracker?: RoadTracker }).tracker ?? null;
  const runLength = tracker ? Math.abs(tracker.finishS - tracker.startS) : 0;
  const progressM = () => (tracker ? tracker.progress * runLength : 0);
  const hudJson = await load<{ ghost: GhostCfg; rival_ghosts: RivalCfg }>('hud.json');
  const timeKey = play && play.mode !== 'career' ? bestKey(play.mode, stageId, reverse, carId, weatherName) : '';
  const bestGhost = timeKey || params.has('devghost') ? new BestGhost(hudJson.ghost, scene) : null;
  const rivals = stageLevel ? new RivalGhosts(hudJson.rival_ghosts, scene) : null;
  const carGroup = (car as { group?: string }).group ?? '2';
  const rivalCount = () => (params.has('rivals') ? Math.max(0, Math.min(99, Number(params.get('rivals')) || 0))
    : !play ? 0 : play.mode === 'career' ? (gameSettings.rivalGhosts === 0 ? 0 : 99) : gameSettings.rivalGhosts);
  const refLine = rivals && stageLevel ? await loadRefLine(stageId, reverse, stageLevel.road) : null;
  /** The rivals' cars: the season's in the career, else the cars of the player's group. */
  const rivalCarData: CarData[] = await Promise.all((career && rules ? rules.season(career)?.cars ?? [carId]
    : (menuData?.cars.filter((c) => c.group === carGroup).map((c) => c.id) ?? [carId])).map((id) => loadCarData(id)));
  /** This stage's rival times: the career's rival sim (the same call the result makes), else the quick-stage picks. */
  const careerStage = (): StageResult | null => career && rules && careerDef
    ? rules.simulateStage(career.seed, career.season, career.rally, career.stage, careerDef, rules.season(career)!.group, 0, false, 0) : null;
  const pickRivals = (): RivalPick[] => {
    const n = rivalCount();
    if (!rules || n <= 0) return [];
    const cs = careerStage();
    if (cs) return careerRivals(rules, cs).slice(0, n);
    const best = timeKey ? save?.best[timeKey]?.time ?? 0 : 0;
    return quickRivals(rules, stageId, reverse, carGroup, weatherName, n, best);
  };
  let save = menuData ? loadSave(startUnlocks) : null;
  const setupRivals = () => rivals?.setup(refLine, pickRivals(), rivalCarData) ?? Promise.resolve();
  await setupRivals();
  if (bestGhost) {
    bestGhost.enabled = gameSettings.ghost || params.has('devghost');
    if (params.has('devghost') && refLine) await bestGhost.use(refLine.s, refLine.hz, refLine.finishTime, refLine.car);
    else if (timeKey) await bestGhost.load(timeKey);
  }
  if (rivals && level.hud) rivals.attachLabels(level.hud.root);
  // the setting "ghost of best run" applies at once; "rival ghosts" at the next start (UE BeginRun)
  const applyGameBase = actions.applyGame;
  actions.applyGame = () => {
    applyGameBase();
    if (bestGhost) bestGhost.enabled = gameSettings.ghost || params.has('devghost');
  };
  const ghostSample: GhostSample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, progress: 0 };
  const ghostStep = level.step?.bind(level);
  level.step = (dt, input) => {
    const out = ghostStep ? ghostStep(dt, input) : input;
    const run = (level as { run?: StageRun }).run;
    // every physics step while running: the best ghost's recording (15 Hz samples interpolated between steps)
    if (bestGhost && run?.phase === 'running') bestGhost.record(run.clock, sampleOf(vehicle.position, vehicle.quaternion, vehicle.wheelAngleDeg, progressM(), ghostSample));
    return out;
  };
  const ghostRestart = level.onRestart;
  level.onRestart = () => {
    ghostRestart?.();
    bestGhost?.beginRun();
    rivals?.beginRun();
    // quick stage and time attack pick again (a new best time moves the picks); the career's rivals never re-roll
    if (rivals && !career) void setupRivals();
  };
  bestGhost?.beginRun();
  rivals?.beginRun();
  // --- /ghosts ---
  // the shaders build next, a second or more with the main thread busy: the indicator says so first
  menus.setBusy(GETTING_READY);
  await nextPaint();
  // place the camera, then build every pipeline now rather than mid-run (the loading curtain covers this)
  chase.update(0, { position: sim.renderPos, forward: new THREE.Vector3(1, 0, 0).applyQuaternion(sim.renderRot), velocity: vehicle.velocity });
  look.update(0, sim.renderPos, innerWidth, innerHeight);
  const stageOf = (level as { stage?: Stage }).stage;
  const t0 = performance.now();
  /** Draw everything once (the stage's out-of-view meshes, effect pools, ghosts): every pipeline of this tier built. */
  const warmAll = () => {
    // the ghosts' one shader is built now too: drawn (invisible, 0.1 % of their pixels) in front of the camera
    rivals?.warm(true, sim.renderPos);
    if (bestGhost?.mesh) {
      bestGhost.mesh.visible = true;
      bestGhost.mesh.position.copy(sim.renderPos);
      bestGhost.mesh.userData.ghostOpacity = 0.001;
    }
    fx.warmup();
    crowd?.warmup();
    if (stageOf) stageOf.warmup(() => look.render());
    else look.render();
    rivals?.warm(false, sim.renderPos);
    if (bestGhost?.mesh) bestGhost.mesh.visible = false;
  };
  warmAll();
  /** The tier warmAll last built for: auto quality settling on another one draws everything again, behind the curtain. */
  let warmedTier = look.qualityName;
  if (stageOf) stageOf.timings.warmup = performance.now() - t0;
  const controls = new Controls();
  const hud = new FrameHud(document.body, backend);
  level.condition = () => look.cond?.name ?? '';
  // HUD keys: U km/h or mph, I number or dial, F3 the debug panel (saved: src/settings.ts)
  actions.applyHud = () => {
    level.hud?.apply(hudSettings);
    document.body.classList.toggle('no-debug', !hudSettings.debug);
  };
  const setHud = (change: Partial<HudSettings>) => {
    Object.assign(hudSettings, change);
    saveHudSettings(hudSettings);
    actions.applyHud();
  };
  // development keys (slice 7, 8): N next stage (shift+N previous), B the other direction, J the next weather: a fresh
  // page load, so the old stage's GPU buffers, colliders and sounds all go with it
  addEventListener('keydown', (e) => {
    if (e.repeat || menus.open || e.code !== 'KeyJ') return;
    const next = nextWeather(weatherJson, weatherName);
    saveRunSettings({ ...loadRunSettings(), weather: next });
    const q = new URLSearchParams(location.search);
    q.set('weather', next);
    location.search = q.toString();
  });
  addEventListener('keydown', (e) => {
    if (e.repeat || menus.open || (e.code !== 'KeyN' && e.code !== 'KeyB')) return;
    const q = new URLSearchParams(location.search);
    if (e.code === 'KeyN') {
      const i = STAGES.indexOf(stageId as (typeof STAGES)[number]);
      q.set('stage', STAGES[(i + (e.shiftKey ? STAGES.length - 1 : 1) + (i < 0 ? 1 : 0)) % STAGES.length]);
    } else if (reverse) q.delete('dir');
    else q.set('dir', 'reverse');
    location.search = q.toString();
  });
  addEventListener('keydown', (e) => {
    if (e.repeat || menus.open) return;
    if (e.code === 'KeyU') setHud({ units: hudSettings.units === 'mph' ? 'kmh' : 'mph' });
    if (e.code === 'KeyI') setHud({ speedo: hudSettings.speedo === 'dial' ? 'number' : 'dial' });
    if (e.code === 'F3') {
      e.preventDefault();
      setHud({ debug: !hudSettings.debug });
    }
    // Enter restarts the stage (outside the menus, once the curtain is gone)
    if (e.code === 'Enter' && menus.ready) actions.restart();
  });

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight);
    chase.camera.aspect = innerWidth / innerHeight;
    chase.camera.updateProjectionMatrix();
    level.hud?.resize();
  };
  addEventListener('resize', onResize);
  onResize(); // the window may have changed while the stage loaded (going fullscreen, for one)

  // restart and recover from the menus. Career: a restart uses one of the season's (none left: refused); after the
  // result was saved it puts the stage back as it was (the snapshot), so the rivals' times stay
  let careerCommitted = false;
  actions.restart = () => {
    if (career && rules) {
      if (!rules.restart(career, careerCommitted ? careerSnapshot : null)) return;
      careerCommitted = false;
      careerSnapshot = clone(career); // the stage start again, with this restart counted
      const sv = loadSave(startUnlocks);
      sv.career = career as unknown as Record<string, unknown>;
      writeSave(sv);
    }
    level.restart?.();
  };
  actions.recover = () => {
    if (arcade.recover(vehicle, true)) sim.snap();
  };
  // quick stage and time attack keep the best time per stage, direction, car and weather (src/game/save.ts); a new
  // best keeps the run as the ghost of that key (src/game/ghostStore.ts) and races the next restart
  let lastResult: ResultsInfo['best'] = null;
  fxEvents.on('finish', (e) => {
    lastResult = null;
    if (!play || !timeKey || e.dnf) return;
    const fresh = loadSave(startUnlocks);
    lastResult = recordBest(fresh, timeKey, e.time, carId);
    if (lastResult.newBest) {
      writeSave(fresh);
      save = fresh;
      const run = (level as { run?: StageRun }).run;
      if (bestGhost && run) void bestGhost.keep(timeKey, run.clock, e.time, carId, liveryIndex).then((bytes) => console.info(`ghost saved: ${timeKey}, ${bytes} B`));
    }
  });
  // career: the result is saved once the run reaches the results (the rival sim, damage carried, the next stage)
  let careerInfo: ResultsInfo['career'] = null;
  const commitCareer = (run: StageRun) => {
    if (!career || !rules || careerCommitted) return;
    const r = rules.stageResult(career, run.total, run.penalties, run.dnf, damage.value, [...damage.parts]);
    if (!r) return;
    careerCommitted = true;
    const sv = loadSave(startUnlocks);
    sv.career = career as unknown as Record<string, unknown>;
    writeSave(sv);
    careerInfo = { stageRows: rules.stageTable(r.result), rallyRows: rules.rallyTable(career.rallyStages), index: r.index, count: r.count, rallyOver: rules.isRallyOver(career) };
  };
  // continue: the rally's next stage (a page load), or its results in the menus (rally results, standings, unlock card)
  careerHooks.continue = () => {
    if (!career || !rules) return;
    const sv = loadSave(startUnlocks);
    if (rules.isRallyOver(career)) {
      const pending = rules.finalizeRally(career, sv.unlocks);
      sv.career = career as unknown as Record<string, unknown>;
      writeSave(sv);
      putMenuState({ screen: pending[0] ?? 'career', flow: 'career', pending });
      menus.leave();
      void nextPaint().then(() => location.assign(menuHref(params)));
      return;
    }
    const def = rules.startStage(career);
    sv.career = career as unknown as Record<string, unknown>;
    writeSave(sv);
    if (!def) return quitTo('career');
    const next: PlaySetup = { mode: 'career', stage: def.stage, reverse: isRev(def.variant), car: career.car, livery: career.livery,
      cond: def.condition, weather: rules.stageWeather(def) };
    // the next stage's loading card comes down over this one and stays through the page load
    menus.leave(menuData ? loadingCard(menuData, next, careerLine(rules, career)) : undefined);
    void nextPaint().then(() => location.assign(`${location.pathname}${playQuery(next, params)}`));
  };

  // read-only handle for tools/check (headless runs)
  const br = { vehicle, chase, model, sim, level, renderer, perf, backend, carId, look, gpu, auto, damage, contacts, menus, ready: false, paused: false,
    bestGhost, rivals, get career() {
      return career;
    }, timeKey,
    weather: { name: weatherName, def: weather, ice: level.ice ?? [], marks: level.marks ?? null, precip } };
  (window as unknown as { __br: object }).__br = br;

  // --- audio ---
  // sound (src/audio): engine, tyres, world, music. It reads the game every frame and never writes to it.
  // M mute, V volume panel, . and , skip the music; ?audio=0 turns it off (loaded as its own chunk).
  void import('./audio').then(({ startAudio }) => startAudio({
    vehicle, carId, stageId, reverse, camera: chase.camera, params,
    level: level as unknown as Parameters<typeof startAudio>[0]['level'],
    isNight: () => look.cond?.name === 'night',
    weather: clearWeather ? null : weather.audio,
  })).then((h) => {
    audio = h;
    if (h && paused) h.sys.setPaused(true);
  }).catch((e) => console.error('audio:', e));
  // --- /audio ---

  let last = performance.now();
  let resultsShown = false;
  const camState = { position: sim.renderPos, forward: new THREE.Vector3(), velocity: vehicle.velocity };
  renderer.setAnimationLoop((now: number) => {
    if (!limiter.due(now)) return;
    const frameDt = now - last;
    const realDt = Math.min(frameDt / 1000, 0.1);
    last = now;
    // the curtain holds the run (no physics steps) until the stage draws steadily and auto quality has settled
    // (it picks the tier behind the curtain, so the player sees no step), then fades
    if (auto && !auto.playing && auto.settled && look.qualityName !== warmedTier && !menus.fading) {
      warmAll();
      warmedTier = look.qualityName;
    }
    const ready = menus.frame(realDt, frameDt, !!auto && (!auto.settled || look.qualityName !== warmedTier));
    if (auto && !auto.playing && (menus.fading || paused)) {
      auto.play();
      if (!params.has('autostart')) rememberRung(gpu, autoKey, `stage:${stageId}`, auto.rung);
    }
    br.ready = ready;
    br.paused = paused;
    const running = ready && !paused;
    const dt = running ? realDt * timeScale : 0;

    const { input, actions: pressed } = controls.poll();
    if (running) {
      if (pressed.has('camera')) chase.cycle();
      if (pressed.has('livery')) model.setLivery(car.liveries[(liveryIndex = (liveryIndex + 1) % car.liveries.length)]);
      if (pressed.has('recover') && arcade.recover(vehicle, true)) sim.snap();
      if (pressed.has('assist')) vehicle.setTractionAssist(!vehicle.tractionAssist);
      sim.advance(dt, input, level.step);
    }
    level.frame?.(dt, chase.camera.position);
    // the results panel opens once the run has coasted to a stop (the menus' rows: restart, another stage, the menu)
    const run = (level as { run?: StageRun }).run;
    if (run?.phase === 'results' && !resultsShown) {
      resultsShown = true;
      level.hud && (level.hud.panelOpen = false);
      careerInfo = null;
      commitCareer(run);
      // quick stage / time attack: the rival ghosts that raced, with you (UE ResultRows)
      const rivalRows = !career && rivals?.rivals.length
        ? [{ name: 'you', time: run.total, dnf: run.dnf, driver: 0 }, ...rivals.rivals.map((r) => ({ name: r.name, time: r.time, dnf: r.dnf, driver: r.driver }))] : null;
      menus.showResults({ sub: subResults, dnf: run.dnf, reason: run.dnfReason, clock: run.clock, penalties: run.penalties, recovers: run.recovers,
        total: run.total, best: play && play.mode !== 'career' ? lastResult : null, career: careerInfo, rivals: rivalRows });
      // headless career runs (tools/check/career.mjs): carry on by themselves
      if (career && params.has('autocontinue')) setTimeout(() => careerHooks.continue(), 1500);
    } else if (run && run.phase !== 'results' && resultsShown) {
      resultsShown = false;
      menus.hideResults();
    }

    model.root.position.copy(sim.renderPos);
    model.root.quaternion.copy(sim.renderRot);
    model.pose((vehicle.wheelAngleDeg * Math.PI) / 180, vehicle.wheels);
    model.setGrime(damage.grime, damageCfg.dirt_color);

    camState.forward.set(1, 0, 0).applyQuaternion(sim.renderRot);
    chase.update(dt, camState);
    // the ghosts after the camera (their fades read it), then the HUD's slots: position, ghost delta, best time
    if (run) {
      const pm = progressM();
      bestGhost?.frame(dt, run, sim.renderPos, chase.camera.position, pm);
      rivals?.frame(dt, run, run.total, pm, sim.renderPos, chase.camera.position);
      if (level.hud) {
        const b = timeKey ? save?.best[timeKey]?.time ?? 0 : 0;
        level.hud.feed = {
          position: rivals?.positionText ?? null,
          ghostDelta: bestGhost?.delta ?? null,
          best: timeKey ? (b > 0 ? `best ${formatTime(b)}` : 'no best time yet') : null,
        };
      }
      rivals?.drawLabels(chase.camera, innerWidth, innerHeight, paused || run.phase === 'results' || !ready);
    }
    // auto quality before drawing: a new render scale resizes (and so clears) the canvas, and drawing in the same
    // frame means the compositor never shows it empty
    if (auto) {
      const r = auto.frame(frameDt, perf.gpu);
      if (r !== null) look.setQuality(r.tier, pinnedScale() ?? r.scale);
      br.auto = auto;
    }
    const c = renderer.domElement;
    look.update(dt, sim.renderPos, c.width, c.height);

    const gear = vehicle.gear < 0 ? 'r' : String(vehicle.gear);
    hud.extra = `${car.name} · ${level.info()} · ${Math.abs(vehicle.forwardSpeedKmh).toFixed(0)} km/h · gear ${gear}` +
      ` · traction assist ${vehicle.tractionAssist ? 'on' : 'off'} · camera ${chase.presetName} · ${controls.device}` +
      ` · damage ${damage.enabled ? `${(damage.value * 100).toFixed(0)}%${damage.terminal ? ' (wrecked)' : ''}` : 'off'}` +
      `\n${look.cond.name} · ${weatherName} · post ${look.post.enabled ? 'on' : 'off'} · quality ${look.qualityName}` +
      `${look.scale < 1 ? ` ${Math.round(look.scale * 100)}%` : ''}${auto ? ' (auto)' : ''}${limiter.fps > 0 ? ` · cap ${limiter.fps}` : ''}` +
      `\nw s a d drive · space handbrake · r recover · esc pause · t traction assist · c camera · l livery · enter restart · k time of day · p post` +
      ` · u km/h or mph · i speed dial · f3 this panel · n next stage · b direction · j weather`;
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
    if (perf.frames.length > 100000) perf.frames.splice(0, 50000);
    hud.frame(now, c.width, c.height);
  });
}

async function buildStageLevel(id: string, reverse: boolean, rapier: typeof RAPIER, world: RAPIER.World, scene: THREE.Scene,
  getVehicle: () => Vehicle, getSim: () => Simulation, hudRoot: HTMLElement, hudSettings: HudSettings, weather: WeatherDef): Promise<Level> {
  const [catalog, runtime, hudJson] = await Promise.all([
    load<Record<string, CatalogEntry>>('env_catalog.json'),
    load<StageRuntimeJson & { flow: FlowConfig }>('stage_runtime.json'),
    load<HudJson>('hud.json'),
  ]);
  const stage = await Stage.load(id, catalog, runtime, rapier, world);
  scene.add(stage.group);
  for (const c of params.get('hide')?.split(',') ?? []) stage.hidden.add(c);
  if (params.get('occtest') === '0') stage.occluderReach = -1e9; // dev: no see-through test (measuring)
  // fords, bridges, the canyon rock fade, the covered bridge's shadow (src/world/features.ts)
  const features = new StageFeatures(stage, runtime.features ?? {});
  const v = stage.json.variants[reverse ? 'reverse' : 'forward'];
  // weather: snow hides the grass tufts and flower specks and freezes the fords; its ice patches and rain's
  // puddles are placed by the original's rules and random stream (src/game/weather.ts)
  for (const c of weather.hide_categories ?? []) stage.hidden.add(c);
  features.frozen = !!weather.fords_frozen;
  const { ice, marks } = buildRoadMarks(id, stage, features, weather, rapier, world, scene);
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
    restart() {
      restartKey = true;
    },
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
        subtitle: [stage.json.location.toLowerCase(), `${lengthKm.toFixed(1)} km`, reverse ? 'reverse' : 'forward', cond,
          weather.name !== 'clear' ? weather.label : ''].filter(Boolean).join(' · '),
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
  Object.assign(level, { tracker, stage, autopilot: ap, features, ice, marks });
  return level;
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre id="fatal">${String(e)}</pre>`);
});

