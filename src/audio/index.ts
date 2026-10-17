// Audio entry point (slice 6b, handoff §12): one call from main.ts. Loads the manifest and the mix,
// decodes the sounds this car and stage use, and runs its own per-frame update on requestAnimationFrame
// (it only reads the game's state). Keys: M mute, V volume panel, . and , skip the music.
// URL: ?audio=0 turns it off; ?audiorec adds measurement taps (tools/check/audio.mjs).
import * as THREE from 'three';
import type { Vehicle } from '../sim/vehicle';
import type { RoadTracker } from '../sim/road';
import type { Stage } from '../world/stage';
import { load } from '../data';
import type { MixJson } from './mix';
import { AudioSystem, type AudioManifest } from './system';
import { CarAudio } from './carAudio';
import { StageAudio, bridgeSpans } from './stageAudio';
import { AudioUi } from './ui';
import { startRecorder, type Recording } from './recorder';
import { events } from '../game/events';
import type { WeatherAudioJson } from '../game/weather';
import { WeatherAudio } from './weatherAudio';

export interface AudioOpts {
  vehicle: Vehicle;
  carId: string;
  stageId: string;
  reverse: boolean;
  /** The level object from main.ts: a stage level has stage, tracker and run. */
  level: { stage?: Stage; tracker?: RoadTracker; run?: { phase: string } };
  camera: THREE.Camera;
  isNight(): boolean;
  params: URLSearchParams;
  /** The weather's sound (weather.json audio); null or clear = none. */
  weather?: WeatherAudioJson | null;
}

export interface AudioHandle {
  sys: AudioSystem;
  car: CarAudio;
  stage: StageAudio;
  weather: WeatherAudio | null;
  ui: AudioUi;
  rec: Recording | null;
}

export async function startAudio(o: AudioOpts): Promise<AudioHandle | null> {
  if (o.params.get('audio') === '0' || !('AudioContext' in window || 'webkitAudioContext' in window)) return null;
  const base = import.meta.env.BASE_URL;
  const get = <T>(f: string) => fetch(`${base}audio/${f}`).then((r) => {
    if (!r.ok) throw new Error(`audio/${f}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });
  const [manifest, mix, runtime] = await Promise.all([
    get<AudioManifest>('manifest.json'),
    get<MixJson>('mix.json'),
    load<{ features?: { bridge_meshes?: string[] } }>('stage_runtime.json'),
  ]);
  const recording = o.params.has('audiorec');
  const sys = new AudioSystem(manifest, mix, base, recording ? { sampleRate: 48000 } : {});
  const ui = new AudioUi(sys);

  const st = o.level.stage;
  let bridges: [number, number][] = [];
  if (st) {
    const boxes = (runtime.features?.bridge_meshes ?? [])
      .map((n) => st.group.getObjectByName(n))
      .filter((n): n is THREE.Object3D => !!n)
      .map((n) => new THREE.Box3().setFromObject(n));
    bridges = bridgeSpans(st.road, boxes);
  }
  const car = new CarAudio(sys, o.vehicle, o.carId);
  // weather: the dry roll turned down, its own loops, its ambience bed and (snow) the low-pass on some groups
  const wa = o.weather ?? null;
  car.dryScale = wa?.dry_surface_scale ?? 1;
  const weatherAmbience = wa?.ambience ? { sound: wa.ambience, volume: wa.ambience_volume ?? 1 } : null;
  const weather = wa ? new WeatherAudio(sys, o.vehicle, wa) : null;
  sys.setMuffle(wa?.muffle_hz ?? 0, wa?.muffle_groups ?? []);
  const stage = new StageAudio(sys, {
    stageId: o.stageId,
    location: st?.json.location ?? o.stageId,
    reverse: o.reverse,
    vehicle: o.vehicle,
    crowds: st?.json.crowds ?? [],
    road: st?.road ?? null,
    tracker: o.level.tracker ?? null,
    bridges,
    animals: st?.animals ?? [],
    phase: () => o.level.run?.phase ?? 'running',
    isNight: o.isNight,
    weatherAmbience,
  });
  stage.music.onTrack = (title) => ui.show(`♪ ${title}`);
  void sys.loadAll([...CarAudio.sounds(sys, o.carId), ...StageAudio.sounds(sys, { stageId: o.stageId, weatherAmbience }), ...WeatherAudio.sounds(wa)]);

  // the context resumes on the first key or click (and the music starts then)
  sys.onUnlock = () => stage.music.start();
  const unlock = () => {
    if (!sys.running) sys.unlock();
    else if (!stage.music.wantPlay) stage.music.start(); // its play() was refused before a gesture
  };
  addEventListener('keydown', unlock, true);
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', (e) => {
    if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code === 'KeyM') ui.setMuted(!sys.volumes.muted);
    if (e.code === 'KeyV') ui.togglePanel();
    if (e.code === 'Period') stage.music.step(1);
    if (e.code === 'Comma') stage.music.step(-1);
  });

  const handle: AudioHandle = { sys, car, stage, weather, ui, rec: null };
  if (recording) {
    const v = o.vehicle;
    const log: string[] = [];
    const at = (k: string) => () => log.push(`${k}@${sys.ctx.currentTime.toFixed(2)}`);
    for (const k of ['backfire', 'impact', 'landing', 'splash', 'crowdReaction', 'countdown', 'go', 'finish', 'penalty'] as const) events.on(k, at(k));
    handle.rec = await startRecorder(sys, () => ({
      t: sys.ctx.currentTime, kmh: v.forwardSpeedKmh, throttle: v.input.throttle, gear: v.gear, simRpm: v.rpm,
      rpm: car.engine.rpm, rpmDip: car.engine.rpmDipped, limiter: car.engine.limiter, cuts: car.engine.limiterCuts, pops: car.engine.limiterPops,
      free: car.engine.freeBlend, load: car.engine.load, duck: stage.music.duckDb, phase: o.level.run?.phase ?? '', air: v.airTime,
      music: stage.music.title, events: log.splice(0).join(' '),
      musicTrack: (() => {
        const m = stage.music.trackLoudness;
        return m ? m.lufs + m.gainDb : -99;
      })(),
    }));
  }
  (window as unknown as { __brAudio: AudioHandle }).__brAudio = handle;

  const LISTENER_HEIGHT_M = 1.5;
  const right = new THREE.Vector3();
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    // UE overrides the listener to the car, 1.5 m up (RallyPlayerController SetAudioListenerOverride);
    // the camera is 34-55 m back on its arm, which put every 3D sound (crowds above all) 25-35 dB down.
    // Pan still follows the camera, so left on screen is left in the ears.
    const L = sys.listener;
    const cam = o.camera;
    const p = o.vehicle.position;
    L.x = p.x;
    L.y = p.y + LISTENER_HEIGHT_M;
    L.z = p.z;
    right.setFromMatrixColumn(cam.matrixWorld, 0);
    L.rx = right.x;
    L.rz = right.z;
    if (dt > 0) {
      car.update(dt);
      stage.update(dt);
      weather?.update(dt);
    }
    ui.frame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return handle;
}
