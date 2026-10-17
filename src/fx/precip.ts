// Rain streaks and snow flakes around the camera, and rain splashes on the ground (slice 8; the original's
// URallyPrecipComponent and M_RallyPrecip). weather.json `precip`:
//
// - `count` particles live in one world-anchored box (64 x 64 x 44 m) that wraps around a centre between the
//   car and the camera (40% of the way to the camera). Each particle falls from a fixed seed at its own
//   velocity; the vertex shader moves and wraps it, so the CPU does nothing per particle and per frame
//   (the original moved them on the CPU). Streaks are thin boxes along their velocity; flakes small
//   faceted balls that sway.
// - Unlit, blended: colour x (PrecipLight + HeadlightBoost inside the car's headlight cone), faded out
//   within near_fade_cm of the camera so nothing fills the lens.
// - Splashes: `splash.rate` a second, from a ray down onto whatever is under a random point around the car
//   (a little ahead of it), into the effects' puff pool.
// - `scale` (quality tier) draws fewer particles: the first count x scale of the same seeds.
import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  Fn, abs, attribute, cameraPosition, cos, cross, dot, float, floor, length, normalize, positionLocal, positionWorld, select, sin,
  smoothstep, step, uniform, vec3,
} from 'three/tsl';
import type { PrecipJson } from '../game/weather';
import { U } from '../look/uniforms';
import { Rng, hexLinear } from './config';
import type { Pool } from './pool';

type N = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** Precipitation uniforms: the wrap centre, the time, and the car's forward for the headlight cone. */
const pU = {
  centre: uniform(new THREE.Vector3()),
  box: uniform(new THREE.Vector3(64, 44, 64)),
  time: uniform(0),
  carFwd: uniform(new THREE.Vector3(1, 0, 0)),
  boost: uniform(3),
  range: uniform(35),
  near: uniform(14),
};

/** A unit streak (a thin box along +x, length 1) or a flake (an icosahedron of radius 0.5). */
function baseGeometry(snow: boolean): THREE.BufferGeometry {
  if (snow) return new THREE.IcosahedronGeometry(0.5, 0); // already non-indexed
  const g = new THREE.BoxGeometry(1, 1, 1);
  return g.toNonIndexed();
}

export class Precipitation {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicNodeMaterial>;
  readonly type: 'rain' | 'snow';
  readonly count: number;
  private splashAcc = 0;
  private readonly rng = new Rng(9173);
  private readonly towardCamera: number;
  private readonly splashColour: THREE.Color | null;
  private time = 0;
  splashes = 0;

  constructor(readonly cfg: PrecipJson, private readonly world: RAPIER.World | null, private readonly rapier: typeof RAPIER | null,
    private readonly exclude: RAPIER.RigidBody | null) {
    const snow = (this.type = cfg.type) === 'snow';
    const n = (this.count = Math.min(Math.max(Math.round(cfg.count ?? 0), 0), 20000));
    this.towardCamera = cfg.toward_camera ?? 0.4;
    const [bx, by, bz] = cfg.box_m ?? [64, 64, 44];
    // UE box (X, Y, Z) -> three (x, z, y)
    pU.box.value.set(bx, bz, by);
    pU.near.value = (cfg.near_fade_cm ?? 1200) / 100;
    pU.boost.value = cfg.headlight_boost ?? 2.5;
    pU.range.value = (cfg.headlight_range_cm ?? 3500) / 100;
    const rng = new Rng(snow ? 4242 : 9173);
    const seed = new Float32Array(n * 4); // x, y, z (m, inside the box), phase
    const vel = new Float32Array(n * 4); // vx, vy, vz (m/s), sway Hz
    const look = new Float32Array(n * 4); // r, g, b, opacity
    const dims = new Float32Array(n * 2); // length, width (m)
    const wind = cfg.wind_cms ?? [0, 0, 0];
    const cols = (cfg.colors?.length ? cfg.colors : ['#FFFFFF']).map((h) => hexLinear(h));
    const pick = (r: [number, number] | number | undefined, lo: number, hi: number) => rng.pick(r, lo, hi);
    for (let i = 0; i < n; i++) {
      seed[i * 4] = rng.next() * bx;
      seed[i * 4 + 2] = rng.next() * by;
      seed[i * 4 + 1] = rng.next() * bz;
      const fall = pick(cfg.fall_cms, 1500, 1900) / 100;
      const gust = rng.range(0.7, 1.3);
      // UE wind (X, Y) -> three (x, z)
      vel[i * 4] = (wind[0] / 100) * gust;
      vel[i * 4 + 2] = (wind[1] / 100) * gust;
      vel[i * 4 + 1] = -fall;
      const size = snow ? pick(cfg.size_cm, 7, 12) / 100 : (cfg.width_cm ?? 4) / 100;
      dims[i * 2] = snow ? size : pick(cfg.length_cm, 90, 160) / 100;
      dims[i * 2 + 1] = size;
      seed[i * 4 + 3] = rng.range(0, Math.PI * 2);
      vel[i * 4 + 3] = rng.range(0.25, 0.7);
      const c = cols[rng.int(0, cols.length - 1)];
      look[i * 4] = c.r;
      look[i * 4 + 1] = c.g;
      look[i * 4 + 2] = c.b;
      look[i * 4 + 3] = pick(cfg.opacity, 0.3, 0.5);
    }
    const base = baseGeometry(snow);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('p_seed', new THREE.InstancedBufferAttribute(seed, 4));
    g.setAttribute('p_vel', new THREE.InstancedBufferAttribute(vel, 4));
    g.setAttribute('p_look', new THREE.InstancedBufferAttribute(look, 4));
    g.setAttribute('p_dims', new THREE.InstancedBufferAttribute(dims, 2));
    g.instanceCount = n;
    base.dispose();
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    m.name = snow ? 'PrecipSnow' : 'PrecipRain';
    const sway = (cfg.sway_cms ?? 0) / 100;
    m.positionNode = Fn(() => {
      const s = attribute('p_seed', 'vec4') as unknown as V4;
      const v = attribute('p_vel', 'vec4') as unknown as V4;
      const d = attribute('p_dims', 'vec2') as unknown as THREE.Node<'vec2'>;
      const t = pU.time;
      const p = s.xyz.add(v.xyz.mul(t));
      // wrap the world-anchored particle into the box around the centre (UE: Rel -= Box * floor(Rel / Box + 0.5))
      let rel = p.sub(pU.centre) as V3;
      rel = rel.sub(pU.box.mul(floor(rel.div(pU.box).add(0.5)))) as V3;
      if (snow && sway > 0) {
        const w = v.w.mul(Math.PI * 2);
        const ph = w.mul(t).add(s.w);
        const amp = float(sway).div(w);
        rel = rel.add(vec3(sin(ph).mul(amp), 0, cos(ph.mul(0.8)).mul(amp))) as V3;
      }
      const centre = pU.centre.add(rel);
      const local = positionLocal as unknown as V3;
      if (snow) return centre.add(local.mul(d.x)) as V3;
      // a streak along its velocity: x = along, then two axes across
      const fwd = normalize(v.xyz);
      const ref = select(abs(fwd.y).greaterThan(0.95), vec3(1, 0, 0), vec3(0, 1, 0));
      const side = normalize(cross(fwd, ref));
      const up = cross(side, fwd);
      return centre.add(fwd.mul(local.x.mul(d.x))).add(side.mul(local.z.mul(d.y))).add(up.mul(local.y.mul(d.y))) as V3;
    })();
    const lookA = attribute('p_look', 'vec4') as unknown as V4;
    // inside the car's headlight cone: brighter (PRECIP_HLSL; the original does this by day too, where
    // it reads as the streaks ahead of the car catching the light)
    const light = Fn(() => {
      const dd = positionWorld.sub(U.carPos);
      const along = dot(dd, pU.carFwd);
      const lat = length(dd.sub(pU.carFwd.mul(along)));
      const cone = step(0, along).mul(float(1).sub(smoothstep(along.mul(0.28), along.mul(0.45).add(1.5), lat)))
        .mul(float(1).sub(smoothstep(pU.range.mul(0.6), pU.range, along)));
      return U.precipLight.add(pU.boost.mul(cone)) as N;
    })();
    m.colorNode = lookA.xyz.mul(light);
    const near = smoothstep(pU.near.mul(0.5), pU.near, length(positionWorld.sub(cameraPosition)));
    m.opacityNode = lookA.w.mul(near);
    const mesh = (this.mesh = new THREE.Mesh(g, m));
    mesh.name = m.name;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    this.splashColour = cfg.splash ? hexLinear(cfg.splash.color ?? '#C0C7CC') : null;
  }

  /** Draw a share of the particles (quality tiers): the first count x scale of the same seeds. */
  set scale(k: number) {
    this.mesh.geometry.instanceCount = Math.max(0, Math.round(this.count * Math.min(Math.max(k, 0), 1)));
  }

  /**
   * Once a frame: the wrap centre between the car and the camera, the time, the headlight cone, and the
   * splashes (into `puff`, the effects' puff pool) around the car.
   */
  update(dt: number, car: THREE.Vector3, carForward: THREE.Vector3, carVelocity: THREE.Vector3, camera: THREE.Vector3,
    puff: Pool | null): void {
    this.time = (this.time + dt) % 3600;
    pU.time.value = this.time;
    pU.centre.value.copy(car).lerp(camera, this.towardCamera);
    pU.carFwd.value.copy(carForward);
    const S = this.cfg.splash;
    if (!S || !puff || !this.world || !this.rapier || !this.splashColour) return;
    this.splashAcc = Math.min(this.splashAcc + S.rate * dt, 4);
    const R = S.radius_m ?? 20;
    const vx = carVelocity.x, vz = carVelocity.z, vl = Math.hypot(vx, vz);
    const ahead = vl > 0.01 ? (S.ahead_m ?? 6) / vl : 0;
    const rng = this.rng;
    let budget = 12;
    while (this.splashAcc >= 1 && budget-- > 0) {
      this.splashAcc -= 1;
      const x = car.x + vx * ahead + rng.range(-1, 1) * R;
      const z = car.z + vz * ahead + rng.range(-1, 1) * R;
      const from = { x, y: car.y + 15, z };
      const hit = this.world.castRayAndGetNormal(new this.rapier.Ray(from, { x: 0, y: -1, z: 0 }), 40, true, undefined, undefined, undefined, this.exclude ?? undefined);
      if (!hit || hit.normal.y < 0.5) continue;
      const y = from.y - hit.timeOfImpact;
      const size0 = rng.pick(S.size0_cm, 8, 14) / 100;
      puff.emit({
        x, y: y + 0.04, z, vx: 0, vy: 1.2, vz: 0,
        life: rng.pick(S.life_s, 0.18, 0.3), size0, size1: rng.pick(S.size1_cm, 26, 44) / 100,
        r: this.splashColour.r, g: this.splashColour.g, b: this.splashColour.b, opacity: S.opacity ?? 0.5,
        drag: 4, gravity: 4, fadeIn: 0.05, fadeOutStart: 0.3,
      });
      this.splashes++;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
