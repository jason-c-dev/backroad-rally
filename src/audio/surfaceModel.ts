// Tyre noise (UE RallyCarAudio.cpp, audio_mix.json surfaces / skid): a gravel and a tarmac roll loop
// weighted by the share of wheels on each kind of surface and by speed, and the two skid loops by the
// contact-patch slip (start_cms..full_cms). Pure, so it is unit-tested.
import { ramp, type MixJson } from './mix';

export interface SurfaceWheel {
  inContact: boolean;
  surface: string;
  latSlipCms: number;
  longSlipCms: number;
}

export interface SurfaceMix {
  rollGravel: number;
  rollTarmac: number;
  pitchGravel: number;
  pitchTarmac: number;
  skidGravel: number;
  skidTarmac: number;
  skidPitchGravel: number;
  skidPitchTarmac: number;
}

interface SurfaceDef {
  loop: string;
  volume: number;
  pitch: number;
  skid: number;
}

export function surfaceDef(mix: MixJson, surface: string): SurfaceDef {
  const s = (mix.surfaces[surface === 'none' ? 'other' : surface] ?? mix.surfaces.other) as Partial<SurfaceDef> | undefined;
  return { loop: s?.loop ?? 'gravel', volume: s?.volume ?? 0, pitch: s?.pitch ?? 1, skid: s?.skid ?? 1 };
}

export function surfaceMix(mix: MixJson, wheels: readonly SurfaceWheel[], kmh: number): SurfaceMix {
  const sf = mix.surfaces;
  const sk = mix.skid;
  const speed01 = ramp(kmh, sf.speed_min_kmh ?? 3, sf.speed_full_kmh ?? 110);
  let rollG = 0;
  let rollT = 0;
  let pitchG = 0;
  let pitchT = 0;
  let skidG = 0;
  let skidT = 0;
  for (const w of wheels) {
    if (!w.inContact) continue;
    const d = surfaceDef(mix, w.surface);
    const tarmac = d.loop === 'tarmac';
    const vol = d.volume * 0.25;
    const slip = ramp(Math.abs(w.latSlipCms) + Math.max(0, Math.abs(w.longSlipCms) - 150), sk.start_cms, sk.full_cms) * d.skid * 0.25;
    if (tarmac) {
      rollT += vol;
      pitchT += d.pitch * vol;
      skidT += slip;
    } else {
      rollG += vol;
      pitchG += d.pitch * vol;
      skidG += slip;
    }
  }
  const span = sf.pitch_speed_span ?? 0.35;
  const pitch = (pv: number, v: number) => (v > 0 ? pv / v : 1) * (1 - span * 0.5 + span * speed01);
  const skidSpeed = ramp(kmh, 5, 30);
  return {
    rollGravel: rollG * speed01,
    rollTarmac: rollT * speed01,
    pitchGravel: pitch(pitchG, rollG),
    pitchTarmac: pitch(pitchT, rollT),
    skidGravel: sk.volume * skidG * skidSpeed,
    skidTarmac: sk.volume * skidT * skidSpeed,
    skidPitchGravel: 0.9 + 0.2 * speed01,
    skidPitchTarmac: 0.95 + 0.1 * speed01,
  };
}
