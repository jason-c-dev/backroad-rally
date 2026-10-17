// The ghosts (handoff §11.3): the ghost of the best run (the original's ARallyGhost) and the rival ghosts
// (ARallyRivalGhosts). Both read the run and the car and never write to them: the sim is untouched.
//
// Best run (quick stage and time attack, setting "ghost of best run"): every run is recorded at 15 Hz (position,
// rotation, front-wheel steer, stage progress, interpolated to exact sample times); a new best time keeps the run as
// the ghost of its best-time key (src/game/ghostStore.ts) and races the next restart. Playback: Catmull-Rom position,
// slerped rotation, no smoothing over a jump of more than 15 m (a recover); #7FA8E6 at 0.4, fading near the player
// and the camera, and out 0.6 s after its own finish. The HUD's delta = this run's clock minus the ghost's time at the
// same progress, 5 times a second, from 25 m on.
//
// Rivals: one reference line per stage and direction (public/data/rival_lines), played on each rival's own clock. A
// rival's pace over the line is 1 + a smooth ±4.5 % blend of random nodes every 300 m, scaled so it crosses the line
// on its simulated time; a crash stops it for the crash seconds at a random spot, a dnf stops it and fades it out.
// Each rival keeps a slot across the road (±120 cm) plus a 35 cm weave, kept inside the road. The live position
// ("p3 / 10") counts the rivals whose time at the player's progress is under the player's time + penalties, 5 times
// a second, holding a change for 0.5 s; at the finish it is the results' exact classification.
import * as THREE from 'three/webgpu';
import type { CarData } from '../data';
import { loadCar, load } from '../data';
import { pos as uePos, rot as ueRot } from '../ue';
import type { Road } from '../sim/road';
import {
  type GhostSample, type Quat, fromBase64, indexAtProgress, maxProgress, quatToRotator, rotatorToQuat, sampleTrack, slerp, unpack,
} from './ghostCodec';
import { CareerRules, RandomStream, hashCombine, hashStr, type StageResult } from './career';
import { ghostMaterial, ghostMesh } from './ghostVisual';
import { loadGhost, saveGhost } from './ghostStore';

const DEG = Math.PI / 180;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** hud.json "ghost". */
export interface GhostCfg {
  sample_hz: number;
  opacity: number;
  color: string;
  glow: number;
  near_player_cm: [number, number];
  near_camera_cm: [number, number];
  update_hz: number;
  delta_min_progress_m: number;
}

/** hud.json "rival_ghosts". */
export interface RivalCfg {
  opacity: number;
  glow: number;
  tint_mix: number;
  trim_color: string;
  tints: string[];
  near_player_cm: [number, number];
  near_camera_cm: [number, number];
  max_distance_m: number;
  pace_sector_m: number;
  pace_amp: number;
  lateral_spread_m: number;
  lateral_wave_m: number;
  lateral_wave_period_m: [number, number];
  edge_margin_cm: number;
  finish_fade_s: [number, number];
  dnf_fade_s: number;
  label: { font: number; dot: number; z_cm: number; fade_m: [number, number]; near_player_m: [number, number] };
  position: { font: number; prefix: string; update_hz: number; hold_s: number };
  quick_default: number;
}

/** What the ghosts read of the run each frame. */
export interface RunView {
  phase: 'intro' | 'countdown' | 'running' | 'finished' | 'results';
  /** Stage clock (s) and the time in the current phase (s). */
  clock: number;
  t: number;
  penalties: number;
  dnf: boolean;
}

// ------------------------------------------------------------------ three <-> UE

const euler = new THREE.Euler();
/** A car pose (three) -> a sample (UE cm and rotator). */
export function sampleOf(p: THREE.Vector3, q: THREE.Quaternion, steerDeg: number, progressM: number, out: GhostSample): GhostSample {
  out.x = p.x * 100;
  out.y = p.z * 100;
  out.z = p.y * 100;
  euler.setFromQuaternion(q, 'YZX');
  out.roll = euler.x / DEG;
  out.yaw = -euler.y / DEG;
  out.pitch = euler.z / DEG;
  out.steer = steerDeg;
  out.progress = progressM;
  return out;
}

const qbuf: { a: Quat; b: Quat } = { a: [0, 0, 0, 1], b: [0, 0, 0, 1] };
const eul = new THREE.Euler();
/** A sample -> a three position and quaternion. */
function place(s: GhostSample, p: THREE.Vector3, q: THREE.Quaternion): void {
  uePos([s.x, s.y, s.z], p);
  q.setFromEuler(ueRot(s.yaw, s.pitch, s.roll, eul));
}

function lerpSample(a: GhostSample, b: GhostSample, t: number, q: { a: Quat; b: Quat }): GhostSample {
  // positions and scalars straight, rotation slerped (the original: Lerp, Slerp)
  const out = { ...a };
  for (const k of ['x', 'y', 'z', 'steer', 'progress'] as const) out[k] = a[k] + (b[k] - a[k]) * t;
  const r = quatToRotator(slerp(rotatorToQuat(a.yaw, a.pitch, a.roll, q.a), rotatorToQuat(b.yaw, b.pitch, b.roll, q.b), t));
  out.yaw = r[0];
  out.pitch = r[1];
  out.roll = r[2];
  return out;
}

// ------------------------------------------------------------------ the best run

export class BestGhost {
  /** This run's recording. */
  rec: GhostSample[] = [];
  private prev: GhostSample | null = null;
  private prevT = 0;
  recTime = 0;
  private track: GhostSample[] | null = null;
  private maxProg: Float32Array = new Float32Array(0);
  private hz = 15;
  /** The ghost's own stage time (s) and car. */
  time = 0;
  car = '';
  /** Stored size of the loaded or last saved ghost (bytes in localStorage). */
  bytes = 0;
  mesh: THREE.Mesh | null = null;
  private meshCar = '';
  /** HUD: this run minus the ghost at the same progress (s); null = none to show. */
  delta: number | null = null;
  private deltaValid = false;
  private deltaTimer = 0;
  enabled = true;
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s: GhostSample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, progress: 0 };

  constructor(readonly cfg: GhostCfg, private scene: THREE.Scene) {}

  get hasGhost(): boolean {
    return !!this.track && this.track.length > 1;
  }

  /** Loads the stored ghost of `key` (none: no ghost). */
  async load(key: string): Promise<boolean> {
    const g = await loadGhost(key);
    if (!g) return false;
    await this.use(g.samples, g.meta.hz, g.meta.time, g.meta.car);
    this.bytes = g.bytes;
    return true;
  }

  /** Plays a track (a stored ghost, this run's recording, a reference line in development). */
  async use(samples: GhostSample[], hz: number, time: number, car: string): Promise<void> {
    this.track = samples;
    this.hz = hz;
    this.time = time;
    this.maxProg = maxProgress(samples);
    this.car = car;
    if (!this.mesh || this.meshCar !== car) {
      const data = await loadCar(car).catch(() => loadCar('swift'));
      const m = await ghostMesh(data, { kind: 'solid', color: this.cfg.color });
      if (this.mesh) {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
      }
      this.mesh = m;
      this.meshCar = car;
      m.userData.ghostGlow = this.cfg.glow;
      this.scene.add(m);
    }
  }

  /** A run starts (a restart): the recording clears; the delta waits for 25 m. */
  beginRun(): void {
    this.rec = [];
    this.prev = null;
    this.recTime = 0;
    this.delta = null;
    this.deltaValid = false;
    this.deltaTimer = 0;
  }

  /** Each physics step while running: one sample per 1/Hz of stage time, interpolated between steps. */
  record(clock: number, now: GhostSample): void {
    const hz = this.cfg.sample_hz;
    if (!this.prev) {
      this.prev = { ...now };
      this.prevT = clock;
    }
    while (this.rec.length / hz <= clock + 1e-4) {
      const t = this.rec.length / hz;
      const a = clock > this.prevT ? Math.min(Math.max((t - this.prevT) / (clock - this.prevT), 0), 1) : 1;
      this.rec.push(lerpSample(this.prev, now, a, qbuf));
    }
    Object.assign(this.prev, now);
    this.prevT = clock;
    this.recTime = clock;
  }

  /** A new best time: this run is the ghost from now on (also for the next restart), and it is stored. */
  async keep(key: string, time: number, total: number, car: string, livery: number): Promise<number> {
    if (this.rec.length < 2) return 0;
    const samples = this.rec;
    await this.use(samples, this.cfg.sample_hz, time, car);
    this.bytes = await saveGhost(key, samples, { time, total, car, livery, hz: this.cfg.sample_hz });
    return this.bytes;
  }

  /** Per frame: place and fade the ghost, and the delta 5 times a second. */
  frame(dt: number, run: RunView, player: THREE.Vector3, camera: THREE.Vector3, progressM: number): void {
    const show = this.enabled && this.hasGhost && run.phase !== 'results';
    const T = run.phase === 'running' ? run.clock : run.phase === 'finished' ? run.clock + run.t : 0;
    this.updateVisual(T, show, player, camera);
    if (run.phase !== 'running' || !show) {
      // the last delta stays up at the finish
      this.deltaValid = this.deltaValid && run.phase === 'finished' && show;
      if (!this.deltaValid) this.delta = null;
      return;
    }
    this.deltaTimer -= dt;
    if (this.deltaTimer <= 0) {
      this.deltaTimer = 1 / this.cfg.update_hz;
      const mp = this.maxProg;
      if (mp.length >= 2 && progressM >= this.cfg.delta_min_progress_m && progressM <= mp[mp.length - 1]) {
        // the first ghost sample at or past the player's progress (running max: a recover can step back)
        const ghostT = indexAtProgress(mp, progressM) / this.hz;
        this.delta = run.clock - ghostT;
        this.deltaValid = true;
      }
    }
    if (!this.deltaValid) this.delta = null;
  }

  private updateVisual(T: number, show: boolean, player: THREE.Vector3, camera: THREE.Vector3): void {
    const m = this.mesh;
    if (!m) return;
    if (!show || !this.track || !sampleTrack(this.track, this.hz, T, this.s, qbuf)) {
      m.visible = false;
      return;
    }
    place(this.s, this.p, this.q);
    let a = this.cfg.opacity;
    a *= smoothstep(this.cfg.near_player_cm[0] / 100, this.cfg.near_player_cm[1] / 100, this.p.distanceTo(player));
    a *= smoothstep(this.cfg.near_camera_cm[0] / 100, this.cfg.near_camera_cm[1] / 100, this.p.distanceTo(camera));
    a *= 1 - Math.min(Math.max((T - this.time) / 0.6, 0), 1);
    m.visible = a >= 0.02;
    m.userData.ghostOpacity = a;
    m.position.copy(this.p);
    m.quaternion.copy(this.q);
  }
}

// ------------------------------------------------------------------ rivals

/** A stage x direction reference line with the road frame at each sample. */
export interface RefLine {
  stage: string;
  rev: boolean;
  car: string;
  hz: number;
  /** The recorded run's official time (the line runs on a little past the finish). */
  finishTime: number;
  runLengthM: number;
  s: GhostSample[];
  maxProg: Float32Array;
  /** Road right (three x, z), the line's lateral offset (m) and the road's half width (m) at each sample. */
  rx: Float32Array;
  rz: Float32Array;
  lat: Float32Array;
  half: Float32Array;
}

export async function loadRefLine(stage: string, rev: boolean, road: Road | null): Promise<RefLine | null> {
  type J = { car: string; time: number; run_length_m: number; hz: number; num: number; raw_bytes: number; packed: string };
  const j = await load<J>(`rival_lines/${stage}_${rev ? 'rev' : 'fwd'}.json`).catch(() => null);
  if (!j) return null;
  const bytes = fromBase64(j.packed);
  const s = bytes ? await unpack(bytes, j.raw_bytes, j.num) : null;
  if (!s || s.length < 2) return null;
  const n = s.length;
  const line: RefLine = {
    stage, rev, car: j.car, hz: Math.max(1, j.hz || 15), finishTime: j.time ?? (n - 1) / 15, runLengthM: j.run_length_m ?? 0, s,
    maxProg: maxProgress(s), rx: new Float32Array(n), rz: new Float32Array(n), lat: new Float32Array(n), half: new Float32Array(n),
  };
  const p = new THREE.Vector3();
  let hint = -1;
  for (let i = 0; i < n; i++) {
    if (road) {
      uePos([s[i].x, s[i].y, s[i].z], p);
      const q = road.project(p, hint);
      hint = q.index;
      line.rx[i] = -road.dz[q.index];
      line.rz[i] = road.dx[q.index];
      line.lat[i] = q.lateral;
      line.half[i] = q.halfWidth;
    } else {
      line.rx[i] = -Math.sin(s[i].yaw * DEG);
      line.rz[i] = Math.cos(s[i].yaw * DEG);
      line.half[i] = 3.5;
    }
  }
  return line;
}

export interface RivalPick {
  driver: number;
  name: string;
  /** Simulated stage time (s), crash included. */
  time: number;
  dnf: boolean;
  crash: number;
}

/**
 * Who races in quick stage and time attack (UE PickRivals): every rival gets a time from the rivals' target for
 * the player's group and the weather (seeded per stage, direction, group and weather; no crashes), then `count` of
 * them: around the best time, the closest faster two thirds and the closest slower rest; without a best time, an
 * even spread over the middle of the field.
 */
export function quickRivals(rules: CareerRules, stage: string, rev: boolean, group: string, weather: string, count: number, best: number): RivalPick[] {
  const target = rules.rivalTarget(stage, rev, group, weather);
  const rng = new RandomStream(hashCombine(hashCombine(hashStr(stage), rev ? 7 : 3), hashCombine(hashStr(group), hashStr(weather))));
  let picks: RivalPick[] = rules.rivals.map((r, i) => {
    const t = target * (r.skill + rules.sim.noise_sigma * rng.normal());
    return { driver: i + 1, name: r.name, time: Math.round(t * 1000) / 1000, dnf: false, crash: 0 };
  });
  if (count < picks.length) {
    const sorted = [...picks].sort((a, b) => a.time - b.time);
    const chosen: RivalPick[] = [];
    if (best > 0) {
      const faster = sorted.filter((x) => x.time < best).reverse(); // closest faster first
      const slower = sorted.filter((x) => x.time >= best);
      let nf = Math.min(faster.length, Math.ceil((count * 2) / 3));
      const ns = Math.min(slower.length, count - nf);
      nf = Math.min(faster.length, count - ns);
      chosen.push(...faster.slice(0, nf), ...slower.slice(0, ns));
    } else {
      for (let i = 0; i < count; i++) {
        const idx = Math.min(Math.max(Math.round(((i + 1) * (sorted.length - 1)) / (count + 1)), 0), sorted.length - 1);
        if (!chosen.some((x) => x.driver === sorted[idx].driver)) chosen.push(sorted[idx]);
      }
    }
    for (const x of sorted) if (chosen.length < count && !chosen.some((y) => y.driver === x.driver)) chosen.push(x);
    picks = chosen.sort((a, b) => a.driver - b.driver);
  }
  return picks;
}

/** Career: the rivals of the current stage, from the same rival sim the results use (so they agree). */
export function careerRivals(rules: CareerRules, r: StageResult): RivalPick[] {
  return r.times.slice(1).map((t, i) => ({ driver: i + 1, name: rules.driverName(i + 1), time: t, dnf: !!r.dnf[i + 1], crash: r.crash[i + 1] ?? 0 }));
}

export interface RivalRun extends RivalPick {
  car: string;
  livery: number;
  tint: string;
  /** Drive clock at each reference sample (crash pause excluded). */
  tau: Float32Array;
  /** Lateral offset (m) at each sample. */
  off: Float32Array;
  stopTau: number;
  stopLen: number;
  retireTau: number;
  retireProg: number;
  mesh: THREE.Mesh | null;
  pos: THREE.Vector3;
  shown: boolean;
  labelAlpha: number;
}

/** Rival clock -> reference time (s) (FRallyRivalRun::RefTimeAt). */
export function refTimeAt(r: Pick<RivalRun, 'tau' | 'stopTau' | 'stopLen' | 'retireTau'>, rivalT: number, hz: number): number {
  let d = Math.max(0, rivalT);
  if (r.stopTau >= 0 && d > r.stopTau) d = d < r.stopTau + r.stopLen ? r.stopTau : d - r.stopLen;
  if (r.retireTau >= 0) d = Math.min(d, r.retireTau);
  const tau = r.tau, n = tau.length;
  if (n < 2) return 0;
  if (d >= tau[n - 1]) {
    const rate = (tau[n - 1] - tau[n - 2]) * hz;
    return (n - 1) / hz + (d - tau[n - 1]) / Math.max(0.1, rate);
  }
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tau[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = tau[i] > tau[i - 1] ? Math.min(Math.max((d - tau[i - 1]) / (tau[i] - tau[i - 1]), 0), 1) : 1;
  return (i - 1 + a) / hz;
}

/** Rival time when it reaches a fractional reference index, the crash pause included (RivalTimeAtIndex). */
export function rivalTimeAtIndex(r: Pick<RivalRun, 'tau' | 'stopTau' | 'stopLen'>, index: number): number {
  const tau = r.tau;
  if (tau.length < 2) return 0;
  const i = Math.min(Math.max(Math.floor(index), 0), tau.length - 2);
  const a = Math.min(Math.max(index - i, 0), 1);
  let t = tau[i] + (tau[i + 1] - tau[i]) * a;
  if (r.stopTau >= 0 && t > r.stopTau) t += r.stopLen;
  return t;
}

/** The time warp, crash or retirement spot and lateral offsets of one rival (UE BuildWarp). */
export function buildWarp(line: RefLine, cfg: RivalCfg, pick: RivalPick, slot: number, count: number): Pick<RivalRun, 'tau' | 'off' | 'stopTau' | 'stopLen' | 'retireTau' | 'retireProg'> {
  const n = line.s.length, hz = line.hz;
  const mp = line.maxProg;
  const len = Math.max(1, mp[n - 1]);
  const rng = new RandomStream(hashCombine(hashCombine(hashStr(line.stage), line.rev ? 1 : 0), (pick.driver * 7919 + 1201) >>> 0));
  const sector = Math.max(50, cfg.pace_sector_m);
  const amp = Math.min(Math.max(cfg.pace_amp, 0), 0.3);
  const K = Math.ceil(len / sector) + 2;
  const node: number[] = [];
  for (let k = 0; k < K; k++) node.push(rng.frandRange(-1, 1) * amp);
  const pace = (p: number) => {
    const x = Math.min(Math.max(p / sector, 0), K - 1 - 0.001);
    const i = Math.floor(x);
    const a = 0.5 - 0.5 * Math.cos(Math.PI * (x - i));
    return 1 + node[i] + (node[i + 1] - node[i]) * a;
  };
  const tau = new Float32Array(n);
  for (let i = 1; i < n; i++) tau[i] = tau[i - 1] + pace(0.5 * (mp[i - 1] + mp[i])) / hz;
  const fIdx = Math.min(Math.max(line.finishTime * hz, 1), n - 1);
  const fi = Math.min(Math.floor(fIdx), n - 2);
  const tauFinish = tau[fi] + (tau[fi + 1] - tau[fi]) * (fIdx - fi);
  const drive = Math.max(1, pick.time - pick.crash);
  const scale = drive / Math.max(0.1, tauFinish);
  for (let i = 0; i < n; i++) tau[i] *= scale;
  // crash pause / retirement spot (both drawn every time, so the stream stays the same)
  const crashU = rng.frandRange(0.2, 0.85);
  const dnfU = rng.frandRange(0.15, 0.9);
  const w = { tau, off: new Float32Array(n), stopTau: -1, stopLen: 0, retireTau: -1, retireProg: 1e9 };
  if (pick.dnf) {
    w.retireTau = rivalTimeAtIndex(w, indexAtProgress(mp, dnfU * len));
    w.retireProg = dnfU * len;
  } else if (pick.crash > 0) {
    w.stopTau = rivalTimeAtIndex(w, indexAtProgress(mp, crashU * len));
    w.stopLen = pick.crash;
  }
  // lateral: a slot across the road plus a slow wave, kept inside the road (metres)
  const spread = cfg.lateral_spread_m, wave = cfg.lateral_wave_m, margin = cfg.edge_margin_cm / 100;
  const base = count > 1 ? ((slot + 0.5) / count - 0.5) * 2 * spread : 0;
  const period = rng.frandRange(Math.max(20, cfg.lateral_wave_period_m[0]), Math.max(cfg.lateral_wave_period_m[0], cfg.lateral_wave_period_m[1]));
  const phase = rng.frandRange(0, 2 * Math.PI);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const want = base + wave * Math.sin((2 * Math.PI * mp[i]) / period + phase);
    const room = Math.max(0, line.half[i] - margin);
    raw[i] = Math.min(Math.max(line.lat[i] + want, -room), room) - line.lat[i];
  }
  // smooth the clamps (a narrow bridge pulls the cars in gently): two box passes, 25 samples wide
  let src = raw;
  const W = 12;
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Float32Array(n);
    let sum = 0, cnt = 0;
    for (let i = -W; i < n; i++) {
      if (i + W < n) {
        sum += src[i + W];
        cnt++;
      }
      if (i - W - 1 >= 0) {
        sum -= src[i - W - 1];
        cnt--;
      }
      if (i >= 0) dst[i] = cnt > 0 ? sum / cnt : 0;
    }
    src = dst;
  }
  w.off = src;
  return w;
}

interface LabelEl {
  el: HTMLElement;
  name: HTMLElement;
  w: number;
  h: number;
}

export class RivalGhosts {
  rivals: RivalRun[] = [];
  line: RefLine | null = null;
  status = '';
  /** Live position (1-based) and the field (rivals + 1); valid = the HUD shows it. */
  shownPos = 0;
  posValid = false;
  private candidate = 0;
  private held = 0;
  private timer = 0;
  private labelsEl: HTMLElement | null = null;
  private labels = new Map<number, LabelEl>();
  private readonly s: GhostSample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, progress: 0 };
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();

  constructor(readonly cfg: RivalCfg, private scene: THREE.Scene) {}

  get fieldSize(): number {
    return this.rivals.length + 1;
  }

  /** Builds the rivals for a run: their warp, offsets and ghost cars (shared with the last run where they match). */
  private setupGen = 0;

  async setup(line: RefLine | null, picks: RivalPick[], cars: CarData[]): Promise<void> {
    const gen = ++this.setupGen;
    if (!line || !picks.length || !cars.length) {
      for (const r of this.rivals) this.drop(r);
      this.rivals = [];
      this.line = line;
      this.status = !line ? 'no reference line: no rival ghosts' : 'off';
      return;
    }
    const cfg = this.cfg;
    // lateral slots shuffled per stage, so neighbours on the road aren't neighbours in pace
    const slots = picks.map((_, i) => i);
    const srng = new RandomStream(hashCombine(hashStr(line.stage), line.rev ? 11 : 5));
    for (let i = slots.length - 1; i > 0; i--) {
      const j = srng.randRange(0, i);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    // the new field is built aside and swapped in at the end: a restart's re-pick (quick stage, time attack) keeps the
    // old ghosts on the grid until the new meshes exist, instead of an empty intro while they load
    const next: RivalRun[] = [];
    const reuse = new Map<RivalRun, RivalRun>(); // new -> old run whose mesh it takes over
    for (let k = 0; k < picks.length; k++) {
      const p = picks[k];
      const car = cars[(p.driver - 1) % cars.length];
      const plain = car.liveries.filter((l) => !(l as { bonus?: boolean }).bonus);
      const livery = Math.floor((p.driver - 1) / cars.length) % Math.max(1, plain.length);
      const tint = cfg.tints[(p.driver - 1) % cfg.tints.length] ?? '#F0A23A';
      const r: RivalRun = {
        ...p, car: car.id, livery, tint, ...buildWarp(line, cfg, p, slots[k], picks.length), mesh: null, pos: new THREE.Vector3(), shown: false, labelAlpha: 0,
      };
      const same = this.rivals.find((o) => o.mesh && o.driver === r.driver && o.car === r.car && o.livery === r.livery && ![...reuse.values()].includes(o));
      if (same) reuse.set(r, same);
      else {
        r.mesh = await ghostMesh(car, { kind: 'livery', livery: plain[livery] ?? car.liveries[0], tint, tintMix: cfg.tint_mix, trim: cfg.trim_color });
        r.mesh.userData.ghostGlow = cfg.glow;
        this.scene.add(r.mesh);
      }
      next.push(r);
    }
    // a newer setup started meanwhile (two restarts in a row): this one is stale
    if (gen !== this.setupGen) {
      for (const r of next) if (!reuse.has(r)) this.drop(r);
      return;
    }
    const old = this.rivals;
    for (const [r, o] of reuse) {
      r.mesh = o.mesh;
      o.mesh = null;
    }
    this.rivals = next;
    this.line = line;
    for (const r of old) this.drop(r);
    this.status = `${this.rivals.length} rivals on ${line.stage}_${line.rev ? 'rev' : 'fwd'}`;
  }

  private drop(r: RivalRun): void {
    if (!r.mesh) return;
    this.scene.remove(r.mesh);
    r.mesh.geometry.dispose();
    r.mesh = null;
  }

  /** A run starts: the position resets. */
  beginRun(): void {
    this.shownPos = 0;
    this.candidate = 0;
    this.held = 0;
    this.timer = 0;
    this.posValid = false;
  }

  /** Warm the shader: every ghost drawn (invisible) for the loading curtain's frames. */
  warm(on: boolean, at: THREE.Vector3): void {
    for (const r of this.rivals) {
      if (!r.mesh) continue;
      r.mesh.visible = on;
      if (on) {
        r.mesh.position.copy(at);
        r.mesh.userData.ghostOpacity = 0.001;
      }
    }
  }

  frame(dt: number, run: RunView, total: number, progressM: number, player: THREE.Vector3, camera: THREE.Vector3): void {
    const line = this.line;
    if (!line || !this.rivals.length) {
      this.posValid = false;
      return;
    }
    const show = run.phase !== 'results';
    const T = run.phase === 'running' ? run.clock : run.phase === 'finished' ? run.clock + run.t : 0;
    for (const r of this.rivals) this.updateRival(r, T, show, player, camera);
    this.updatePosition(dt, run, total, progressM);
  }

  private updateRival(r: RivalRun, T: number, show: boolean, player: THREE.Vector3, camera: THREE.Vector3): void {
    const line = this.line!, cfg = this.cfg, m = r.mesh;
    const hide = () => {
      if (m) m.visible = false;
      r.shown = false;
      r.labelAlpha = 0;
    };
    const refT = refTimeAt(r, T, line.hz);
    if (!show || !m || !sampleTrack(line.s, line.hz, refT, this.s, qbuf)) return hide();
    const f = Math.min(Math.max(refT * line.hz, 0), line.s.length - 1);
    const i = Math.min(Math.floor(f), line.s.length - 2);
    const a = f - i;
    const off = r.off[i] + (r.off[i + 1] - r.off[i]) * a;
    let rx = line.rx[i] + (line.rx[i + 1] - line.rx[i]) * a, rz = line.rz[i] + (line.rz[i + 1] - line.rz[i]) * a;
    const l = Math.hypot(rx, rz) || 1;
    rx /= l;
    rz /= l;
    place(this.s, r.pos, this.q);
    r.pos.x += rx * off;
    r.pos.z += rz * off;
    let alpha = cfg.opacity;
    const pd = r.pos.distanceTo(player), cd = r.pos.distanceTo(camera);
    alpha *= smoothstep(cfg.near_player_cm[0] / 100, cfg.near_player_cm[1] / 100, pd);
    alpha *= smoothstep(cfg.near_camera_cm[0] / 100, cfg.near_camera_cm[1] / 100, cd);
    alpha *= 1 - smoothstep(cfg.max_distance_m * 0.8, cfg.max_distance_m, cd);
    const end = r.dnf ? r.retireTau : r.time;
    alpha *= r.dnf ? 1 - Math.min(Math.max((T - end) / cfg.dnf_fade_s, 0), 1) : 1 - smoothstep(end + cfg.finish_fade_s[0], end + cfg.finish_fade_s[1], T);
    if (alpha < 0.02) return hide();
    m.visible = true;
    r.shown = true;
    m.userData.ghostOpacity = alpha;
    m.position.copy(r.pos);
    m.quaternion.copy(this.q);
    const L = cfg.label;
    r.labelAlpha = Math.min(Math.max(alpha / Math.max(0.01, cfg.opacity), 0), 1) * (1 - smoothstep(L.fade_m[0], L.fade_m[1], cd)) * smoothstep(L.near_player_m[0], L.near_player_m[1], pd);
  }

  private updatePosition(dt: number, run: RunView, total: number, progressM: number): void {
    const P = this.cfg.position;
    if (run.phase === 'finished' || run.phase === 'results') {
      // the exact classification (the results' rule; a tie goes to the rival)
      let ahead = 0;
      for (const r of this.rivals) ahead += !r.dnf && (run.dnf || r.time <= total) ? 1 : 0;
      this.shownPos = ahead + 1;
      this.posValid = true;
      return;
    }
    if (run.phase !== 'running' || progressM < 25) {
      this.posValid = false;
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / Math.max(1, P.update_hz);
    const idx = indexAtProgress(this.line!.maxProg, progressM);
    let ahead = 0;
    for (const r of this.rivals) {
      if (r.dnf && progressM > r.retireProg) continue;
      ahead += rivalTimeAtIndex(r, idx) < total ? 1 : 0;
    }
    const cand = ahead + 1;
    if (this.shownPos === 0 || !this.posValid) {
      this.shownPos = cand;
      this.held = 0;
    } else if (cand !== this.shownPos) {
      // held a moment before it changes: side by side it doesn't flicker
      this.held = cand === this.candidate ? this.held + 1 / P.update_hz : 1 / P.update_hz;
      if (this.held >= P.hold_s - 1e-6) {
        this.shownPos = cand;
        this.held = 0;
      }
    } else this.held = 0;
    this.candidate = cand;
    this.posValid = true;
  }

  get positionText(): string | null {
    return this.posValid && this.rivals.length ? `${this.cfg.position.prefix}${this.shownPos} / ${this.fieldSize}` : null;
  }

  // ------------------------------------------------------------------ name labels (SRallyGhostLabels)

  /** The labels' layer (under the HUD's instruments). */
  attachLabels(parent: HTMLElement): void {
    const e = document.createElement('div');
    e.className = 'ghost-labels';
    parent.prepend(e);
    this.labelsEl = e;
  }

  private label(r: RivalRun): LabelEl {
    let l = this.labels.get(r.driver);
    if (!l) {
      const el = document.createElement('div');
      el.className = 'ghost-label outlined';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = r.tint;
      const name = document.createElement('span');
      name.textContent = r.name;
      el.append(dot, name);
      this.labelsEl!.appendChild(el);
      l = { el, name, w: 0, h: 0 };
      this.labels.set(r.driver, l);
    }
    return l;
  }

  /** Per frame after the camera moved: project the labels, the clearest first; one that would overlap steps up a line (3 at most) or waits. */
  drawLabels(camera: THREE.Camera, width: number, height: number, hidden: boolean): void {
    if (!this.labelsEl) return;
    const zUp = this.cfg.label.z_cm / 100;
    const list = hidden ? [] : this.rivals.filter((r) => r.shown && r.labelAlpha >= 0.02).sort((a, b) => b.labelAlpha - a.labelAlpha);
    const placed: [number, number, number, number][] = [];
    const used = new Set<number>();
    for (const r of list) {
      this.v.copy(r.pos);
      this.v.y += zUp;
      this.v.project(camera);
      if (this.v.z > 1 || this.v.z < -1) continue;
      const x = (this.v.x * 0.5 + 0.5) * width, y = (-this.v.y * 0.5 + 0.5) * height;
      const l = this.label(r);
      if (!l.w) {
        l.w = l.el.offsetWidth;
        l.h = l.el.offsetHeight;
      }
      let left = Math.round(x - l.w / 2), top = Math.round(y - l.h);
      let free = false;
      for (let step = 0; step < 4 && !free; step++) {
        const t = top - step * (l.h + 1);
        const rect: [number, number, number, number] = [left - 2, t, left + l.w + 2, t + l.h];
        free = !placed.some((p) => p[0] < rect[2] && rect[0] < p[2] && p[1] < rect[3] && rect[1] < p[3]);
        if (free) {
          top = t;
          placed.push(rect);
        }
      }
      if (!free || left > width || top > height || left + l.w < 0 || top + l.h < 0) continue;
      used.add(r.driver);
      l.el.style.transform = `translate(${left}px, ${top}px)`;
      l.el.style.opacity = r.labelAlpha.toFixed(3);
      l.el.style.display = '';
    }
    for (const [d, l] of this.labels) if (!used.has(d) && l.el.style.display !== 'none') l.el.style.display = 'none';
  }

  /** The HUD size changed: measure the labels again. */
  relayout(): void {
    for (const l of this.labels.values()) l.w = l.h = 0;
  }
}

/** Shared-material warm-up for both kinds of ghost (one pipeline). */
export const ghostShader = ghostMaterial;
