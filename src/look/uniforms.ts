// The shared look uniforms: the web counterpart of the original's material parameter collection.
// Every material reads them; the condition (conditions.json) and the camera write them.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

/** Surfaces with a per-condition grade: [r, g, b] multiplier and saturation. */
export const TINTED = ['Grass', 'Gravel', 'Tarmac', 'Dirt', 'Rock', 'Water', 'Foliage', 'Flat'] as const;
export type Tinted = (typeof TINTED)[number];

const tint = () => uniform(new THREE.Vector4(1, 1, 1, 1));

export const U = {
  /** 0 by day .. 1 at night: lit windows and car lamps. */
  nightGlow: uniform(0),
  /** Foliage sway scale. */
  wind: uniform(1),
  /** Per-surface grade, [r, g, b, saturation], linear. */
  tint: Object.fromEntries(TINTED.map((k) => [k, tint()])) as Record<Tinted, ReturnType<typeof tint>>,
  /** Sky colour of the condition (linear): what wet roads would reflect; also the clear colour. */
  skyColor: uniform(new THREE.Color(0.26, 0.32, 0.42)),
  /** The occluder fade aims from the camera at the car (+0.8 m): both in world metres, set every frame. */
  carPos: uniform(new THREE.Vector3()),
  camPos: uniform(new THREE.Vector3(0, 1000, 0)),
  /** Foliage beyond this camera distance doesn't sway (m). */
  swayRange: uniform(90),
  /** Weather blends (slice 8): kept here so the materials have one home for them. */
  wet: uniform(0),
  snow: uniform(0),
  /** Rock occluder fade (canyon walls; 0 on stages without them). */
  rockFade: uniform(0),
  /** How much sun reaches inside tree canopies that the shadow map says are shadowed (0..1). */
  canopyLight: uniform(0.75),
  /** 1 = dithered fades move with the frame (interleaved gradient noise + frame offset), 0 = fixed. */
  ditherAnimate: uniform(1),
};
