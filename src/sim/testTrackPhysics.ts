// The test bench's ground for physics: one flat box, with the surface under a wheel looked up
// from the strip and pad rectangles in testtrack.json (UE metres, X forward, Y right).
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vector3 } from 'three';
import type { TestTrack } from '../data';
import type { SurfaceQuery } from './vehicle';
import type { Surface } from './tuning';

export function buildTestTrackPhysics(rapier: typeof RAPIER, world: RAPIER.World, t: TestTrack): SurfaceQuery {
  const half = t.ground.size_m / 2;
  world.createCollider(
    rapier.ColliderDesc.cuboid(half, 1, half).setTranslation(t.ground.center[0], -1, t.ground.center[1]).setFriction(0.8),
  );
  return (_c, _f, p) => testTrackSurface(t, p);
}

/** Surface at a three point (x = UE X, z = UE Y). */
export function testTrackSurface(t: TestTrack, p: Vector3): Surface {
  const x = p.x;
  const y = p.z;
  for (const s of t.strips) {
    const r = (s.yaw * Math.PI) / 180;
    const dx = x - s.start[0];
    const dy = y - s.start[1];
    const along = dx * Math.cos(r) + dy * Math.sin(r);
    const across = -dx * Math.sin(r) + dy * Math.cos(r);
    if (along >= 0 && along <= s.length_m && Math.abs(across) <= s.width_m / 2) return s.surface as Surface;
  }
  for (const pad of t.pads) {
    if (Math.abs(x - pad.center[0]) <= pad.size_m / 2 && Math.abs(y - pad.center[1]) <= pad.size_m / 2) {
      return pad.surface as Surface;
    }
  }
  return 'grass';
}
