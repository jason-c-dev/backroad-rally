// Stage and world sound (UE URallyAudioSubsystem::TickStage, HandleCrowdReact, TickLocationSounds):
// the ambience bed (day or night), the crowd loop at the nearest spectator group, the wooden-bridge
// rumble, the flow cues (countdown, go, finish, penalty), crowd reactions, impacts, landings, splashes,
// backfires, the reset whoosh, and the in-stage music with its duck. Listens to src/game/events.ts.
import { Vector3 } from 'three';
import type { Vehicle } from '../sim/vehicle';
import type { Road, RoadTracker } from '../sim/road';
import { events, type CrowdReactionKind } from '../game/events';
import { clamp, musicDuckTarget, smooth, stepDuck } from './mix';
import { MusicPlayer, stagePlaylist } from './music';
import type { AudioSystem, Loop } from './system';

export interface CrowdGroup {
  p: number[];
  count: number;
  variants: string;
}

export interface StageAudioOpts {
  stageId: string;
  location: string;
  reverse: boolean;
  vehicle: Vehicle;
  crowds: CrowdGroup[];
  road: Road | null;
  tracker: RoadTracker | null;
  /** s ranges (m) of the wooden bridge decks. */
  bridges: [number, number][];
  phase(): string;
  isNight(): boolean;
}

const REACTION_KEY: Record<CrowdReactionKind, string> = { cheer: 'cheer', nearMiss: 'near_miss', gasp: 'gasp', groan: 'groan', applause: 'applause' };

export class StageAudio {
  private ambience: Loop | null = null;
  private ambienceName = '';
  private oldAmbience: Loop[] = [];
  private crowdLoop: Loop;
  private crowdPan: StereoPannerNode;
  private bridge: Loop;
  private rumble = 0;
  readonly music: MusicPlayer;
  private night = false;
  private cooldowns = new Map<string, number>();
  private lastWhoosh = -1;
  private readonly lastPos = new Vector3();
  private hasLast = false;
  private offs: (() => void)[] = [];
  private familyCache = new Map<string, string>();

  static sounds(sys: AudioSystem, o: Pick<StageAudioOpts, 'stageId'>): string[] {
    const m = sys.mix;
    const st = m.stage;
    const reactions = Object.values(st.crowd_reactions).flatMap((r) => r.sounds.flatMap((p) => sys.family(p)));
    return [
      st.ambience[o.stageId] ?? st.ambience.default, st.ambience.night, 'A_Crowd_Loop', st.bridge.sound,
      'A_Countdown_Beep', 'A_Countdown_Go', 'A_Finish_Chime', 'A_Reset_Whoosh',
      ...reactions, ...sys.family('A_Impact_Hard'), ...sys.family('A_Impact_Soft'), ...sys.family('A_Land'),
      ...sys.family('A_Water_Splash'),
    ];
  }

  constructor(readonly sys: AudioSystem, readonly o: StageAudioOpts) {
    const ctx = sys.ctx;
    this.crowdPan = ctx.createStereoPanner();
    this.crowdPan.connect(sys.groups.crowd);
    this.crowdLoop = sys.loop('A_Crowd_Loop', 'crowd', { out: this.crowdPan });
    this.bridge = sys.loop(sys.mix.stage.bridge.sound, 'surface');
    this.music = new MusicPlayer(sys);
    this.music.volume = sys.mix.stage.music_volume ?? 1;
    this.night = o.isNight();
    this.music.setPlaylist(stagePlaylist(sys.manifest.music, o.location, this.night, sys.mix.stage.day_mood));
    this.listen();
  }

  private gap(key: string, secs: number, force = false): boolean {
    const now = this.sys.ctx.currentTime;
    if (!force && (this.cooldowns.get(key) ?? -1e9) > now) return false;
    this.cooldowns.set(key, now + secs);
    return true;
  }

  private listen(): void {
    const sys = this.sys;
    const m = sys.mix;
    const ev = m.events;
    const st = m.stage;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    this.offs.push(
      events.on('countdown', () => sys.play('A_Countdown_Beep', 'ui', st.countdown_volume ?? 1)),
      events.on('go', () => sys.play('A_Countdown_Go', 'ui', st.countdown_volume ?? 1)),
      events.on('finish', (e) => {
        if (!e.dnf) sys.play('A_Finish_Chime', 'ui', st.finish_volume ?? 1);
      }),
      events.on('penalty', () => this.whoosh()),
      events.on('impact', (e) => {
        const vol = (ev.impact_volume ?? 1) * clamp(e.speed / (ev.impact_ref_kmh ?? 60), 0.25, 1.3);
        sys.playRandom(e.speed >= (ev.impact_hard_kmh ?? 30) ? 'A_Impact_Hard' : 'A_Impact_Soft', 'sfx', vol, rand(0.92, 1.08));
      }),
      events.on('landing', (e) => sys.playRandom('A_Land', 'sfx', (ev.landing_volume ?? 0.9) * clamp(e.strength, 0.3, 1.3), rand(0.92, 1.06))),
      events.on('backfire', (e) => {
        const i = e.intensity * (e.antilag ? 0.75 : 1);
        const v = (ev.backfire_volume ?? 0.9) * clamp(i, 0.3, 1.3) * rand(ev.backfire_volume_min ?? 1, ev.backfire_volume_max ?? 1);
        sys.playRandom('A_Backfire', 'engine', v, rand(ev.backfire_pitch_min ?? 0.9, ev.backfire_pitch_max ?? 1.12));
      }),
      events.on('splash', (e) => {
        if (this.gap('splash', 0.3)) sys.playRandom('A_Water_Splash', 'sfx', clamp(e.speed / 40, 0.5, 1.2), rand(0.93, 1.07), { pos: e.pos });
      }),
      events.on('crowdReaction', (e) => {
        const key = REACTION_KEY[e.kind] ?? 'cheer';
        const cfg = st.crowd_reactions[key] ?? { sounds: ['A_Crowd_Cheer'], volume: st.cheer_volume ?? 1, min_gap_s: 1.5 };
        // the pass cheer may cut its gap short for a big moment (a jump landing, intensity > 1.3)
        if (!this.gap(key, cfg.min_gap_s ?? 1.5, key === 'cheer' && e.intensity > 1.3)) return;
        const fam = this.family(key, cfg.sounds);
        sys.playRandom(fam, 'crowd', (cfg.volume ?? 1) * clamp(e.intensity, 0.3, 2), rand(0.95, 1.05), { pos: e.pos, att: m.attenuation.crowd });
      }),
    );
  }

  /** First family in the list with any members (the cheers stand in for the rest). */
  private family(key: string, prefixes: string[]): string {
    let f = this.familyCache.get(key);
    if (!f) {
      f = prefixes.find((p) => this.sys.family(p).some((n) => this.sys.buffers.has(n))) ?? 'A_Crowd_Cheer';
      this.familyCache.set(key, f);
    }
    return f;
  }

  private whoosh(): void {
    const now = this.sys.ctx.currentTime;
    if (now - this.lastWhoosh < 0.5) return;
    this.lastWhoosh = now;
    this.sys.play('A_Reset_Whoosh', 'ui', this.sys.mix.events.reset_volume ?? 1);
  }

  update(dt: number): void {
    const sys = this.sys;
    const st = sys.mix.stage;
    const v = this.o.vehicle;
    const p = v.position;

    // a teleport (recover, off-road reset, restart) whooshes
    if (this.hasLast && p.distanceTo(this.lastPos) > 4 + v.velocity.length() * dt * 3) this.whoosh();
    this.lastPos.copy(p);
    this.hasLast = true;

    // ambience: the stage's bed, or the night bed
    const night = this.o.isNight();
    const want = night ? st.ambience.night : st.ambience[this.o.stageId] ?? st.ambience.default;
    if (want !== this.ambienceName) {
      if (this.ambience) this.oldAmbience.push(this.ambience);
      this.ambienceName = want;
      this.ambience = sys.loop(want, 'ambience');
    }
    this.ambience?.set(st.ambience_volume ?? 1, 1, dt, 0.5);
    this.oldAmbience = this.oldAmbience.filter((l) => {
      l.set(0, 1, dt, 0.5); // a 1.5 s fade-out
      if (!l.playing) l.dispose();
      return l.playing;
    });

    // crowd loop at the nearest group the car is within range of, 3D from the listener
    let best: CrowdGroup | null = null;
    let bestD = Infinity;
    for (const c of this.o.crowds) {
      if (c.variants !== 'both' && c.variants !== (this.o.reverse ? 'reverse' : 'forward')) continue;
      const d = Math.hypot(c.p[0] - p.x, c.p[1] - p.y, c.p[2] - p.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    let crowd = 0;
    if (best && bestD < (st.crowd_loop_range_cm ?? 12000) / 100) {
      const s = sys.spatial({ x: best.p[0], y: best.p[1], z: best.p[2] }, sys.mix.attenuation.crowd);
      crowd = (st.crowd_loop_volume ?? 1) * clamp(best.count / 15, 0.5, 1.4) * s.gain;
      this.crowdPan.pan.setTargetAtTime(s.pan, sys.ctx.currentTime, 0.1);
    }
    this.crowdLoop.set(crowd, 1, dt, 0.1);

    // wooden bridge rumble, by speed while on the deck
    const proj = this.o.tracker?.proj;
    const on = !!proj && Math.abs(proj.height) < 1.5 && this.o.bridges.some(([a, b]) => proj.s >= a && proj.s <= b);
    const target = on ? clamp(v.speedKmh / 60, 0, 1) : 0;
    this.rumble = smooth(this.rumble, target, 12, dt);
    const br = st.bridge;
    this.bridge.set(this.rumble * (br.volume ?? 1), (br.pitch_min ?? 0.85) + this.rumble * (br.pitch_span ?? 0.3), dt);

    // music: day/night playlist, the duck at full throttle and high revs while running
    if (night !== this.night) {
      this.night = night;
      this.music.setPlaylist(stagePlaylist(sys.manifest.music, this.o.location, night, st.day_mood));
    }
    const duck = st.music_duck;
    const tgt = this.o.phase() === 'running' ? musicDuckTarget(duck, v.input.throttle, v.rpm / Math.max(1, v.t.maxRpm)) : 0;
    this.music.duckDb = stepDuck(this.music.duckDb, tgt, duck, dt);
    this.music.update();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}

/** s spans of a bridge: road samples inside the deck's bounding box (x, z), merged. */
export function bridgeSpans(road: Road, boxes: { min: { x: number; z: number }; max: { x: number; z: number } }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const b of boxes) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < road.n; i++) {
      if (road.x[i] >= b.min.x && road.x[i] <= b.max.x && road.z[i] >= b.min.z && road.z[i] <= b.max.z) {
        lo = Math.min(lo, road.s[i]);
        hi = Math.max(hi, road.s[i]);
      }
    }
    if (lo <= hi) out.push([lo, hi]);
  }
  return out;
}

