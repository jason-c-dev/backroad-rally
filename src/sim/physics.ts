// Rapier: the single-threaded -compat build (GitHub Pages can't send the headers threaded WASM
// needs, handoff §14a). One world per stage or test run, stepped at a fixed 120 Hz.
import RAPIER from '@dimforge/rapier3d-compat';

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

let ready: Promise<typeof RAPIER> | null = null;

export function initPhysics(): Promise<typeof RAPIER> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

export function createWorld(rapier: typeof RAPIER): RAPIER.World {
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYSICS_DT;
  return world;
}
