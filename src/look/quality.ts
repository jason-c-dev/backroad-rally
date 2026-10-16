// Quality tiers: everything the look trades for frame time, in one place. Measured on a laptop's
// integrated GPU (WebGL2, which is what desktop Chrome draws with on a hybrid laptop) and on its
// discrete GPU (README, Performance): the vegetation dominated (trees were ~90% of the triangles),
// then the sun's shadow cascades; the post chain is a few milliseconds even at 3840×1600.
import type { PostQuality } from './post';
import type { LodSettings } from '../world/stage';

export interface Quality extends PostQuality {
  /** Sun shadow map size per cascade (px) and range (view depth, m). */
  shadowMap: number;
  shadowFar: number;
  /** Vegetation levels of detail and shadow casters (stage.ts). */
  lod: LodSettings;
}

export const QUALITY: Record<string, Quality> = {
  high: {
    ao: 0.5, aoSamples: 16, dofTaps: 16, bloom: true, msaa: 4, cascades: 3, nightCascades: 3, headlightShadows: true,
    shadowMap: 2048, shadowFar: 160, scale: 1, postFog: false,
    lod: { cuts: [110, 240, 330], blend: 0.1, shadowNear: 0, shadowFar: 1, shadowCut: 90, shadowRange: 260, grassShadows: true, groundDraw: 1, cheapFoliage: false },
  },
  medium: {
    ao: 0.5, aoSamples: 8, dofTaps: 12, bloom: true, msaa: 0, cascades: 2, nightCascades: 1, headlightShadows: true,
    shadowMap: 2048, shadowFar: 160, scale: 1, postFog: false,
    lod: { cuts: [70, 160, 250], blend: 0.1, shadowNear: 1, shadowFar: 2, shadowCut: 70, shadowRange: 220, grassShadows: false, groundDraw: 1, cheapFoliage: false },
  },
  low: {
    ao: 0, aoSamples: 8, dofTaps: 8, bloom: false, msaa: 0, cascades: 1, nightCascades: 1, headlightShadows: false,
    shadowMap: 1536, shadowFar: 130, scale: 1, postFog: true,
    lod: { cuts: [50, 120, 200], blend: 0.1, shadowNear: 2, shadowFar: 2, shadowCut: 0, shadowRange: 180, grassShadows: false, groundDraw: 0.75, cheapFoliage: true },
  },
};

export const TIERS = Object.keys(QUALITY);
