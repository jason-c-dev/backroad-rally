// The stage road: the centreline sampled every 2 m, with progress `s` along it (handoff §6, UE
// AStageActor). There are no checkpoints: progress is the car projected onto the centreline.
// Positions are three metres (x, y up, z); "right" is the side to the right of the travel direction.
import { Vector3 } from 'three';

export interface RoadData {
  /** Flat [x, y, z, ...] in three metres. */
  p: number[];
  half_width: number[];
  s: number[];
  surface: number[];
  surfaces: string[];
}

export interface Projection {
  s: number;
  /** Metres to the right of the centreline (for the stage's forward direction of the samples). */
  lateral: number;
  halfWidth: number;
  /** Car height over the road (m). */
  height: number;
  index: number;
}

const WINDOW = 25; // samples around the previous index: hairpin legs never swap
const GRID = 50; // m

export class Road {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly s: Float64Array;
  readonly halfWidth: Float64Array;
  /** Unit direction of the centreline (x, z) at each sample. */
  readonly dx: Float64Array;
  readonly dz: Float64Array;
  private grid = new Map<string, number[]>();

  constructor(d: RoadData) {
    const n = (this.n = d.s.length);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = Float64Array.from(d.s);
    this.halfWidth = Float64Array.from(d.half_width);
    this.dx = new Float64Array(n);
    this.dz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = d.p[i * 3];
      this.y[i] = d.p[i * 3 + 1];
      this.z[i] = d.p[i * 3 + 2];
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
      const ddx = this.x[c] - this.x[a], ddz = this.z[c] - this.z[a];
      const l = Math.hypot(ddx, ddz) || 1;
      this.dx[i] = ddx / l;
      this.dz[i] = ddz / l;
      const k = this.cell(this.x[i], this.z[i]);
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, (list = []));
      list.push(i);
    }
  }

  private cell(x: number, z: number): string {
    return `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
  }

  get length(): number {
    return this.s[this.n - 1] - this.s[0];
  }

  /** Horizontal distance from a point to the nearest centreline sample (m). */
  distanceTo(x: number, z: number): number {
    let best = Infinity;
    const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const i of this.grid.get(`${cx + a},${cz + b}`) ?? []) {
          best = Math.min(best, (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2);
        }
      }
    }
    return best < Infinity ? Math.sqrt(best) : GRID * 2;
  }

  /** Nearest point on the centreline: within ±25 samples of `hint` when given (UE ProjectToRoad). */
  project(p: Vector3, hint = -1): Projection {
    const dist = (i: number) => (this.x[i] - p.x) ** 2 + (this.z[i] - p.z) ** 2 + (this.y[i] - p.y) ** 2;
    let best = -1;
    let bestD = Infinity;
    if (hint >= 0 && hint < this.n) {
      for (let i = Math.max(0, hint - WINDOW); i <= Math.min(this.n - 1, hint + WINDOW); i++) {
        const d = dist(i);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    } else {
      const cx = Math.floor(p.x / GRID), cz = Math.floor(p.z / GRID);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          for (const i of this.grid.get(`${cx + a},${cz + b}`) ?? []) {
            const d = dist(i);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      if (best < 0) {
        for (let i = 0; i < this.n; i++) {
          const d = dist(i);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    // refine on the neighbouring segment the point projects onto
    const seg = (a: number, b: number) => {
      const abx = this.x[b] - this.x[a], abz = this.z[b] - this.z[a];
      const t = Math.min(Math.max(((p.x - this.x[a]) * abx + (p.z - this.z[a]) * abz) / Math.max(1e-6, abx * abx + abz * abz), 0), 1);
      const qx = this.x[a] + abx * t, qz = this.z[a] + abz * t;
      return { t, d: (p.x - qx) ** 2 + (p.z - qz) ** 2 };
    };
    let a = Math.max(0, best - 1), b = a + 1;
    let r = seg(a, b);
    if (best + 1 < this.n) {
      const r2 = seg(best, best + 1);
      if (r2.d < r.d || best === 0) {
        a = best;
        b = best + 1;
        r = r2;
      }
    }
    const t = r.t;
    const px = this.x[a] + (this.x[b] - this.x[a]) * t;
    const py = this.y[a] + (this.y[b] - this.y[a]) * t;
    const pz = this.z[a] + (this.z[b] - this.z[a]) * t;
    const ddx = this.x[b] - this.x[a], ddz = this.z[b] - this.z[a];
    const l = Math.hypot(ddx, ddz) || 1;
    // right of the sample direction (x, z): (-dz, dx)
    const lateral = ((p.x - px) * -ddz + (p.z - pz) * ddx) / l;
    return {
      s: this.s[a] + (this.s[b] - this.s[a]) * t,
      lateral,
      halfWidth: this.halfWidth[a] + (this.halfWidth[b] - this.halfWidth[a]) * t,
      height: p.y - py,
      index: t < 0.5 ? a : b,
    };
  }

  /** Centreline point at progress s (clamped to the ends). */
  sampleAt(s: number): { p: Vector3; dx: number; dz: number; halfWidth: number } {
    const S = this.s;
    if (s <= S[0]) return { p: new Vector3(this.x[0], this.y[0], this.z[0]), dx: this.dx[0], dz: this.dz[0], halfWidth: this.halfWidth[0] };
    const last = this.n - 1;
    if (s >= S[last]) return { p: new Vector3(this.x[last], this.y[last], this.z[last]), dx: this.dx[last], dz: this.dz[last], halfWidth: this.halfWidth[last] };
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = (s - S[lo]) / Math.max(1e-6, S[hi] - S[lo]);
    let dx = this.dx[lo] + (this.dx[hi] - this.dx[lo]) * a;
    let dz = this.dz[lo] + (this.dz[hi] - this.dz[lo]) * a;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    return {
      p: new Vector3(this.x[lo] + (this.x[hi] - this.x[lo]) * a, this.y[lo] + (this.y[hi] - this.y[lo]) * a, this.z[lo] + (this.z[hi] - this.z[lo]) * a),
      dx, dz,
      halfWidth: this.halfWidth[lo] + (this.halfWidth[hi] - this.halfWidth[lo]) * a,
    };
  }

  /** A pose on the road at s, facing the travel direction (sign +1 forward, -1 reverse), `lateral` m to its right. */
  pose(s: number, sign: number, lateral = 0, crown = 0.05): { position: Vector3; yawDeg: number } {
    const q = this.sampleAt(s);
    const tx = q.dx * sign, tz = q.dz * sign;
    const position = q.p.clone().add(new Vector3(-tz * lateral, crown, tx * lateral));
    // UE yaw: atan2(Y, X) = atan2(three z, three x)
    return { position, yawDeg: (Math.atan2(tz, tx) * 180) / Math.PI };
  }
}

export interface StageRules {
  corridor: number; // m beyond the road edge
  offroadGrace: number; // s
  resetBack: number; // m behind the projection
  carStartBack: number; // m behind the start line
  belowRoad: number; // m under the road counts as off-road
}

export const DEFAULT_RULES: StageRules = { corridor: 12, offroadGrace: 0.4, resetBack: 4, carStartBack: 6, belowRoad: 15 };

/** The car's progress, finish line and off-road timer on a stage (UE AStageActor::UpdateCar). */
export class RoadTracker {
  proj: Projection | null = null;
  offRoad = false;
  offRoadTime = 0;
  crossedFinish = false;

  constructor(readonly road: Road, readonly startS: number, readonly finishS: number, readonly rules = DEFAULT_RULES) {}

  get sign(): number {
    return this.finishS >= this.startS ? 1 : -1;
  }

  reset(): void {
    this.proj = null;
    this.offRoad = false;
    this.offRoadTime = 0;
    this.crossedFinish = false;
  }

  startPose(): { position: Vector3; yawDeg: number } {
    return this.road.pose(this.startS - this.sign * this.rules.carStartBack, this.sign);
  }

  /** 0..1 along start -> finish. */
  get progress(): number {
    if (!this.proj) return 0;
    return Math.min(Math.max((this.proj.s - this.startS) / (this.finishS - this.startS), 0), 1);
  }

  /** Track the car; returns 'offroad' when the grace runs out (the caller resets the car). */
  update(p: Vector3, dt: number): 'offroad' | null {
    const prev = this.proj;
    const cur = (this.proj = this.road.project(p, prev ? prev.index : -1));
    const inCorridor = Math.abs(cur.lateral) <= cur.halfWidth + this.rules.corridor;
    const sign = this.sign;
    if (prev && !this.crossedFinish && Math.abs(cur.s - prev.s) < 30 && inCorridor
      && (prev.s - this.finishS) * sign < 0 && (cur.s - this.finishS) * sign >= 0) {
      this.crossedFinish = true;
    }
    this.offRoad = !inCorridor || cur.height < -this.rules.belowRoad;
    this.offRoadTime = this.offRoad ? this.offRoadTime + dt : 0;
    if (this.offRoadTime > this.rules.offroadGrace) {
      this.offRoadTime = 0;
      return 'offroad';
    }
    return null;
  }

  /** Where to put the car back: on the road a few metres behind where it left (UE FindResetPose). */
  resetPose(p: Vector3): { position: Vector3; yawDeg: number } {
    const proj = this.proj ?? this.road.project(p);
    const lo = Math.min(this.startS, this.finishS) - 30, hi = Math.max(this.startS, this.finishS) + 30;
    const s = Math.min(Math.max(proj.s - this.sign * this.rules.resetBack, Math.max(lo, this.road.s[0])), Math.min(hi, this.road.s[this.road.n - 1]));
    const pose = this.road.pose(s, this.sign);
    this.proj = this.road.project(pose.position, proj.index);
    this.offRoadTime = 0;
    this.offRoad = false;
    return pose;
  }
}
