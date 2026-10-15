// The handling test bench from testtrack.json as flat ground: grass, the tarmac and gravel
// strips with distance posts every 100 m (red every 500 m), and the two pads with their
// R40 circle markers. The loop road comes later.
import * as THREE from 'three/webgpu';
import type { TestTrack } from '../data';
import { posM, yaw, yawDir } from '../ue';

// Placeholder surface colours from the GDD palette until the look slice brings the
// per-condition tints.
const SURFACE: Record<string, string> = {
  grass: '#649E55',
  tarmac: '#A09F9A',
  gravel: '#D9CDBE',
};

function flat(w: number, l: number, colour: string, roughness = 0.9) {
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colour, roughness }));
  m.receiveShadow = true;
  return m;
}

export function buildTestStrip(t: TestTrack): THREE.Group {
  const root = new THREE.Group();
  root.name = 'testtrack';

  const ground = flat(t.ground.size_m, t.ground.size_m, SURFACE.grass, 1);
  posM([t.ground.center[0], t.ground.center[1], 0], ground.position);
  root.add(ground);

  const postGeo = new THREE.BoxGeometry(0.25, 1.2, 0.25);
  postGeo.translate(0, 0.6, 0);
  const white = new THREE.MeshStandardMaterial({ color: '#F2F0E6', roughness: 0.7 });
  const red = new THREE.MeshStandardMaterial({ color: '#DB1F0F', roughness: 0.7 });
  const post = (x: number, y: number, mat: THREE.Material, scale = 1) => {
    const p = new THREE.Mesh(postGeo, mat);
    posM([x, y, 0], p.position);
    p.scale.setScalar(scale);
    p.castShadow = true;
    root.add(p);
  };

  for (const s of t.strips) {
    const road = flat(s.length_m, s.width_m, SURFACE[s.surface] ?? '#888888', s.surface === 'tarmac' ? 0.8 : 0.95);
    const dir = yawDir(s.yaw);
    // dir is in three axes; strip start is UE metres
    road.position.copy(posM([s.start[0], s.start[1], 0.02])).addScaledVector(dir, s.length_m / 2);
    road.rotation.y = yaw(s.yaw);
    road.name = s.name;
    root.add(road);
    const rad = (s.yaw * Math.PI) / 180;
    for (let d = 0; d <= s.length_m; d += 100) {
      const x = s.start[0] + Math.cos(rad) * d;
      const y = s.start[1] + Math.sin(rad) * d;
      post(x, y - s.width_m / 2 - 1, d % 500 ? white : red);
    }
  }

  for (const p of t.pads) {
    const pad = flat(p.size_m, p.size_m, SURFACE[p.surface] ?? '#888888');
    posM([p.center[0], p.center[1], 0.02], pad.position);
    pad.name = p.name;
    root.add(pad);
    const r = t.tests.circle_radius_m;
    for (let k = 0; k < 16; k++) {
      const a = (2 * Math.PI * (k + 0.5)) / 16;
      post(p.center[0] + Math.cos(a) * r, p.center[1] + Math.sin(a) * r, red, 0.6);
    }
  }
  return root;
}
