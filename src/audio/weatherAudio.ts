// Weather sound (slice 8; the original's URallyAudioSubsystem::UpdateWeatherAudio and the weather part of
// URallyCarAudioComponent). weather.json `audio`:
//
//   car_loop        rain on the car body: a 2D loop in the `weather` group (0.6 in the mix)
//   surface_loops   a loop per surface under the wheels (rain: a wet hiss everywhere; snow: crunch on the
//                   loose surfaces, slush on tarmac), weighted by the share of wheels on each surface and
//                   by speed, in the `surface` group
//   dry_surface_scale, ambience, muffle_hz / muffle_groups are applied by CarAudio, StageAudio and
//   AudioSystem.setMuffle (see index.ts).
import type { Vehicle } from '../sim/vehicle';
import type { WeatherAudioJson } from '../game/weather';
import { ramp, type MixJson } from './mix';
import type { AudioSystem, Loop } from './system';

/** The weather surface loops' levels by sound: the share of wheels on each surface (pure, unit-tested). */
export function weatherSurfaceLevels(mix: MixJson, audio: WeatherAudioJson, wheels: readonly { inContact: boolean; surface: string }[], kmh: number): Map<string, number> {
  const out = new Map<string, number>();
  const loops = audio.surface_loops ?? {};
  const sf = mix.surfaces;
  const speed01 = ramp(kmh, sf.speed_min_kmh ?? 3, sf.speed_full_kmh ?? 110);
  const k = (audio.surface_loop_volume ?? 1) * speed01;
  for (const name of new Set(Object.values(loops))) out.set(name, 0);
  for (const w of wheels) {
    const name = w.inContact ? loops[w.surface] : undefined;
    if (!name) continue;
    // the surface's own volume (0.6 when the mix has none), a quarter per wheel
    const vol = (mix.surfaces[w.surface] as { volume?: number } | undefined)?.volume ?? 0.6;
    out.set(name, (out.get(name) ?? 0) + vol * 0.25 * k);
  }
  return out;
}

export class WeatherAudio {
  private carLoop: Loop | null = null;
  private surfaces = new Map<string, Loop>();

  static sounds(audio: WeatherAudioJson | null): string[] {
    if (!audio) return [];
    return [...new Set([audio.car_loop, audio.ambience, ...Object.values(audio.surface_loops ?? {})].filter((n): n is string => !!n))];
  }

  constructor(readonly sys: AudioSystem, readonly vehicle: Vehicle, readonly audio: WeatherAudioJson) {
    if (audio.car_loop) this.carLoop = sys.loop(audio.car_loop, 'weather');
    for (const name of new Set(Object.values(audio.surface_loops ?? {}))) this.surfaces.set(name, sys.loop(name, 'surface'));
  }

  update(dt: number): void {
    const v = this.vehicle;
    this.carLoop?.set(this.audio.car_loop_volume ?? 1, 1, dt, 0.3);
    const levels = weatherSurfaceLevels(this.sys.mix, this.audio, v.wheels, v.speedKmh);
    const speed01 = ramp(v.speedKmh, this.sys.mix.surfaces.speed_min_kmh ?? 3, this.sys.mix.surfaces.speed_full_kmh ?? 110);
    for (const [name, loop] of this.surfaces) loop.set(levels.get(name) ?? 0, 0.9 + 0.2 * speed01, dt);
  }
}
