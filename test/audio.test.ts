import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CALIBRATION_DB, attenuate, crossfade, dbToLin, finalGain, groupGain, musicDuckTarget, stepDuck, voiceGain, type MixJson } from '../src/audio/mix';
import { Blowoff, EngineSound, limiterEnv, rng, turboWhistle, type EngineInput, type EngineLayerSpec } from '../src/audio/engineModel';
import { surfaceMix } from '../src/audio/surfaceModel';
import { menuPlaylist, stagePlaylist } from '../src/audio/music';
import type { AudioManifest } from '../src/audio/system';

const mix = JSON.parse(readFileSync('public/audio/mix.json', 'utf8')) as MixJson;
const manifest = JSON.parse(readFileSync('public/audio/manifest.json', 'utf8')) as AudioManifest;
const tuning = JSON.parse(readFileSync('public/data/cars_tuning.json', 'utf8')) as Record<string, { engine?: { max_rpm: number; idle_rpm: number } }>;

const layersOf = (car: string): EngineLayerSpec[] =>
  Object.values(manifest.sounds).filter((e) => e.kind === 'engine' && e.car === car).map((e) => ({ ref: e.ref_rpm!, off: e.layer === 'off' }));
const spec = (car: string) => ({ car, idleRpm: 1000, maxRpm: 7500 });
const wheels = (lat = 0, long = 0, contact = true) =>
  [true, true, true, true].map((_, i) => ({ inContact: contact, latSlipCms: lat, longSlipCms: long, driven: i >= 2 }));
const input = (o: Partial<EngineInput> = {}): EngineInput => ({ throttle: 0, simRpm: 1000, gear: 2, forwardKmh: 60, airTime: 0, wheels: wheels(), ...o });
const run = (e: EngineSound, secs: number, inp: EngineInput | ((t: number) => EngineInput), dt = 1 / 60) => {
  for (let t = 0; t < secs; t += dt) e.update(dt, typeof inp === 'function' ? inp(t) : inp);
};

describe('mix maths', () => {
  it('final = level x 10^(db/20) x group x user, clamped to max_volume', () => {
    expect(finalGain(1, 0, 0.9, 1, 3.5)).toBeCloseTo(0.9);
    expect(finalGain(0.5, -6, 0.5, 0.5, 3.5)).toBeCloseTo(0.5 * dbToLin(-6) * 0.25);
    expect(finalGain(2, 9.4, 0.9, 1, 3.5)).toBe(3.5);
    // the voice's share times the group node's gain is the same product
    for (const [l, db, g, u] of [[1, 0, 0.9, 1], [0.7, -4, 0.8, 0.6], [2, 9.4, 0.9, 1]]) {
      expect(voiceGain(l, db, g * u, 3.5) * g * u).toBeCloseTo(finalGain(l, db, g, u, 3.5));
    }
  });

  it('the calibration is one measured music trim, small, on top of the spec groups', () => {
    expect(CALIBRATION_DB).toEqual({ music: 3.5 });
    expect(groupGain(mix, 'music', 1)).toBeCloseTo(0.5 * dbToLin(3.5));
    expect(groupGain(mix, 'engine', 0.5)).toBeCloseTo(0.45);
  });

  it('groups are the spec values', () => {
    expect(mix.groups).toEqual({ engine: 0.9, surface: 0.5, sfx: 0.9, ui: 0.7, music: 0.5, ambience: 0.6, crowd: 0.8, weather: 0.6 });
  });

  it('crossfades at equal power between neighbours', () => {
    const refs = [1000, 2500, 4000, 5500, 7000];
    expect(crossfade(refs, 500)).toEqual([1, 0, 0, 0, 0]);
    expect(crossfade(refs, 9000)).toEqual([0, 0, 0, 0, 1]);
    for (const rpm of [1200, 3000, 4750, 6999]) {
      const w = crossfade(refs, rpm);
      expect(w.reduce((a, x) => a + x * x, 0)).toBeCloseTo(1);
      expect(w.filter((x) => x > 0).length).toBeLessThanOrEqual(2);
    }
    const mid = crossfade(refs, 4750);
    expect(mid[2]).toBeCloseTo(Math.SQRT1_2);
    expect(mid[3]).toBeCloseTo(Math.SQRT1_2);
  });

  it('attenuates like a natural falloff to db_at_max', () => {
    const a = mix.attenuation.world;
    expect(attenuate(3, a)).toBe(1);
    expect(attenuate(6, a)).toBe(1);
    expect(attenuate(66 - 1e-6, a)).toBeCloseTo(dbToLin(-48), 4);
    expect(attenuate(70, a)).toBe(0);
    expect(attenuate(20, a)).toBeLessThan(attenuate(10, a));
  });

  it('ducks the music 1 dB at full throttle and high revs only', () => {
    const d = mix.stage.music_duck;
    expect(musicDuckTarget(d, 1, 0.9)).toBeCloseTo(1);
    expect(musicDuckTarget(d, 0.5, 0.9)).toBe(0);
    expect(musicDuckTarget(d, 1, 0.5)).toBe(0);
    let x = 0;
    for (let i = 0; i < 24; i++) x = stepDuck(x, 1, d, 1 / 60);
    expect(x).toBeCloseTo(24 / 60 / d.attack_s);
    for (let i = 0; i < 120; i++) x = stepDuck(x, 0, d, 1 / 60);
    expect(x).toBe(0);
  });
});

describe('engine layers', () => {
  it('every car has on and off sets; lama adds 8500', () => {
    for (const car of ['swift', 'pip', 'lama', 'quint', 'kaze']) {
      const l = layersOf(car);
      expect(l.filter((x) => !x.off).map((x) => x.ref).sort((a, b) => a - b)).toEqual(car === 'lama' ? [1000, 2500, 4000, 5500, 7000, 8500] : [1000, 2500, 4000, 5500, 7000]);
      expect(Math.min(...l.filter((x) => x.off).map((x) => x.ref))).toBe(2500);
    }
  });

  it('weights on layers x sqrt(load) and off layers (with idle) x sqrt(1 - load) x off_level', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'), rng(1));
    // hold the sound rpm at 4750 (sim 4750 / 1.12) and the load at 0.25
    run(e, 3, (t) => input({ throttle: 0.25, simRpm: 4750 / 1.12, forwardKmh: 80 + t * 0 }));
    expect(e.rpm).toBeCloseTo(4750, -1);
    expect(e.load).toBeCloseTo(0.25, 3);
    const byRef = (ref: number, off: boolean) => e.weights[e.layers.findIndex((l) => l.ref === ref && l.off === off)];
    const [c, s] = crossfade([1000, 2500, 4000, 5500, 7000], e.rpm).slice(2, 4);
    expect(byRef(4000, false)).toBeCloseTo(c * Math.sqrt(0.25), 3);
    expect(byRef(5500, false)).toBeCloseTo(s * Math.sqrt(0.25), 3);
    expect(byRef(4000, true)).toBeCloseTo(c * Math.sqrt(0.75) * 0.8, 3);
    expect(byRef(5500, true)).toBeCloseTo(s * Math.sqrt(0.75) * 0.8, 3);
    expect(byRef(1000, false)).toBe(0);
    // at idle the off set is the 1000 on-layer: it plays on both sides of the load
    const idle = new EngineSound(mix.engine, spec('swift'), layersOf('swift'), rng(1));
    run(idle, 2, input({ throttle: 0, simRpm: 800, forwardKmh: 0, gear: 1 }));
    // (idle 1000 x 1.12 = 1120: just past the 1000 layer toward the 2500 off-layer)
    expect(idle.weights[idle.layers.findIndex((l) => l.ref === 1000)]).toBeCloseTo(0.8 * Math.cos((120 / 1500) * (Math.PI / 2)), 4);
    // pitch = rpm / ref, clamped 0.5..2
    expect(e.pitch[e.layers.findIndex((l) => l.ref === 4000 && !l.off)]).toBeCloseTo(e.rpm / 4000, 3);
    expect(e.pitch[e.layers.findIndex((l) => l.ref === 1000)]).toBe(2);
  });

  it('smooths the load with attack 10/s and release 6/s', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    e.update(0.1, input({ throttle: 1, simRpm: 3000 }));
    expect(e.load).toBeCloseTo(1 - Math.exp(-1), 5);
    const l0 = e.load;
    e.update(0.1, input({ throttle: 0, simRpm: 3000 }));
    expect(e.load).toBeCloseTo(l0 * Math.exp(-0.6), 5);
  });
});

describe('sound-side rpm', () => {
  it('runs at sim x 1.12, leads a rising rpm, smooths faster up than down', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(e, 2, input({ throttle: 0.5, simRpm: 4000 }));
    expect(e.rpm).toBeCloseTo(4480, 0);
    // rising 2000 rpm/s: the target leads by 0.08 s x 2000 = 160 rpm
    let sim = 4000;
    run(e, 1, () => input({ throttle: 0.5, simRpm: (sim += 2000 / 60) }));
    expect(e.rpm - sim * 1.12).toBeGreaterThan(100);
    expect(e.rpm - sim * 1.12).toBeLessThan(170);
    // a step up settles by 45/s, a step down by 25/s
    const up = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(up, 1, input({ throttle: 0.5, simRpm: 3000 }));
    up.update(0.02, input({ throttle: 0.5, simRpm: 3000 }));
    up.update(0.02, input({ throttle: 0.5, simRpm: 5000 }));
    const upFrac = (up.rpm - 3360) / (5600 + 0 - 3360);
    const dn = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(dn, 1, input({ throttle: 0.5, simRpm: 5000 }));
    dn.update(0.02, input({ throttle: 0.5, simRpm: 3000 }));
    const dnFrac = (5600 - dn.rpm) / (5600 - 3360);
    expect(upFrac).toBeGreaterThan(dnFrac);
    expect(dnFrac).toBeCloseTo(1 - Math.exp(-25 * 0.02), 2);
  });

  it('blips +1400 rpm over 0.22 s on a downshift', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(e, 2, input({ throttle: 0, simRpm: 3000, gear: 3 }));
    const base = e.rpm;
    let peak = 0;
    run(e, 0.3, input({ throttle: 0, simRpm: 3000, gear: 2 }), 1 / 120);
    // measure while the blip runs
    const f = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(f, 2, input({ throttle: 0, simRpm: 3000, gear: 3 }), 1 / 120);
    for (let t = 0; t < 0.3; t += 1 / 120) {
      f.update(1 / 120, input({ throttle: 0, simRpm: 3000, gear: 2 }));
      peak = Math.max(peak, f.rpm - base);
    }
    expect(peak).toBeGreaterThan(700); // 1400 at the sine's top, smoothed by 45/s
    expect(peak).toBeLessThan(1400);
    expect(f.rpm - base).toBeLessThan(150); // over after 0.22 s and the smoothing
  });

  it('caps at max x 1.12 x rev_cap', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(e, 2, input({ throttle: 0.3, simRpm: 20000 }));
    expect(e.rpm).toBeLessThanOrEqual(7500 * 1.12 * 1.08 + 1e-6);
  });
});

describe('free revving', () => {
  const settle = (car: string, inp: EngineInput) => {
    const e = new EngineSound(mix.engine, spec(car), layersOf(car), rng(3));
    run(e, 1.5, inp);
    return e;
  };

  it('wheelspin on throttle sends the revs to the limiter', () => {
    const e = settle('swift', input({ throttle: 1, simRpm: 4000, forwardKmh: 40, wheels: wheels(0, 900) }));
    expect(e.freeBlend).toBeGreaterThan(0.95);
    expect(e.limiter).toBe(true);
    expect(e.rpm).toBeCloseTo(e.limitRpm, 0);
  });

  it('air time flares the revs; a lift in the air lets them drop', () => {
    const e = settle('swift', input({ throttle: 1, simRpm: 5000, forwardKmh: 90, airTime: 0.5, wheels: wheels(0, 0, false) }));
    expect(e.freeBlend).toBeGreaterThan(0.95);
    expect(e.rpm).toBeGreaterThan(5000 * 1.12 + 1000);
    run(e, 1, input({ throttle: 0, simRpm: 5000, forwardKmh: 90, airTime: 1.5, wheels: wheels(0, 0, false) }));
    expect(e.rpm).toBeLessThan(e.idleSound * 1.3 + 600);
  });

  it('core-14: a sideways slide at speed is not wheelspin', () => {
    // 350 cm/s sideways on the driven wheels: free at 30 km/h, held at 120 km/h (x0.3 = 105 < 200 start)
    const slow = settle('swift', input({ throttle: 1, simRpm: 3000, forwardKmh: 30, wheels: wheels(550, 0) }));
    const fast = settle('swift', input({ throttle: 1, simRpm: 6000, forwardKmh: 120, wheels: wheels(550, 0) }));
    expect(slow.slip).toBeCloseTo(550, 0);
    expect(slow.freeBlend).toBeGreaterThan(0.9);
    expect(fast.slip).toBeCloseTo(550 * 0.3, 0);
    expect(fast.freeBlend).toBeLessThan(0.01);
    // wheelspin along the wheel always counts in full
    const spin = settle('swift', input({ throttle: 1, simRpm: 6000, forwardKmh: 120, wheels: wheels(0, 550) }));
    expect(spin.freeBlend).toBeGreaterThan(0.9);
  });

  it('launch: full throttle from a standstill flares to 0.8', () => {
    const e = settle('swift', input({ throttle: 1, simRpm: 1500, forwardKmh: 2, gear: 1 }));
    expect(e.freeBlend).toBeCloseTo(0.8, 1);
  });
});

describe('limiter', () => {
  it('the envelope is a sine over the duty, then off', () => {
    expect(limiterEnv(0, 0.45)).toBe(0);
    expect(limiterEnv(0.225, 0.45)).toBeCloseTo(1);
    expect(limiterEnv(0.5, 0.45)).toBe(0);
    expect(limiterEnv(3.225, 0.45)).toBeCloseTo(1);
  });

  it('cuts 18 times a second, dips 450 rpm and 45 % volume, pops ~15 % of the cuts (lama)', () => {
    const e = new EngineSound(mix.engine, spec('lama'), layersOf('lama'), rng(7));
    const inp = input({ throttle: 1, simRpm: 9000, forwardKmh: 150, gear: 6 });
    run(e, 0.5, inp, 1 / 240);
    expect(e.limiter).toBe(true);
    const cuts0 = e.limiterCuts;
    let minDip = Infinity;
    let maxDip = 0;
    run(e, 0, inp);
    for (let t = 0; t < 1; t += 1 / 960) {
      e.update(1 / 960, inp);
      minDip = Math.min(minDip, e.rpmDipped - e.rpm);
      maxDip = Math.max(maxDip, e.limiterEnv);
    }
    expect(e.limiterCuts - cuts0).toBeGreaterThanOrEqual(17);
    expect(e.limiterCuts - cuts0).toBeLessThanOrEqual(19);
    expect(minDip).toBeCloseTo(-450, -1);
    expect(e.limiterVolume(maxDip)).toBeCloseTo(0.55, 2);
    // pop rate over a long run: 18 % chance for lama (its override), a 0.2 s cooldown
    const p = new EngineSound(mix.engine, spec('lama'), layersOf('lama'), rng(11));
    run(p, 60, inp, 1 / 120);
    const rate = p.limiterPops / p.limiterCuts;
    expect(rate).toBeGreaterThan(0.08);
    expect(rate).toBeLessThan(0.2);
  });

  it('per-car settings: kaze 24 Hz, pip 15 Hz', () => {
    const cuts = (car: string) => {
      const e = new EngineSound(mix.engine, spec(car), layersOf(car), rng(1));
      return e.cutTimes(0, 0, 1).length;
    };
    expect(cuts('kaze')).toBe(24);
    expect(cuts('pip')).toBe(15);
    expect(cuts('swift')).toBe(17);
  });

  it('needs throttle >= 0.6 and lets go below 96 %', () => {
    const e = new EngineSound(mix.engine, spec('swift'), layersOf('swift'));
    run(e, 1, input({ throttle: 0.5, simRpm: 9000 }));
    expect(e.limiter).toBe(false);
    run(e, 0.5, input({ throttle: 1, simRpm: 9000 }));
    expect(e.limiter).toBe(true);
    run(e, 1, input({ throttle: 1, simRpm: 5000 }));
    expect(e.limiter).toBe(false);
  });

  it('lama limits at its real max rpm', () => {
    const max = tuning.lama?.engine?.max_rpm;
    if (!max) return;
    const e = new EngineSound(mix.engine, { car: 'lama', idleRpm: 1000, maxRpm: max }, layersOf('lama'));
    expect(e.limitRpm).toBeCloseTo(max * 1.12 * 1.05);
  });
});

describe('turbo', () => {
  it('whistle ~ boost^1.5, blow-off on a quick lift with boost', () => {
    expect(turboWhistle(mix.turbo, 0, 0.5).level).toBe(0);
    expect(turboWhistle(mix.turbo, 1, 1).level).toBeCloseTo(1);
    expect(turboWhistle(mix.turbo, 0.25, 0).level).toBeCloseTo(0.125);
    const b = new Blowoff();
    expect(b.update(0.016, 1, 0.9, 0.5)).toBe(0);
    expect(b.update(0.016, 0, 0.9, 0.5)).toBeCloseTo(0.9);
    b.update(0.016, 1, 0.9, 0.5);
    expect(b.update(0.016, 0, 0.9, 0.5)).toBe(0); // 0.8 s cooldown
  });
});

describe('tyres', () => {
  const w = (surface: string, lat = 0, long = 0) => ({ inContact: true, surface, latSlipCms: lat, longSlipCms: long });
  it('roll weighted per wheel by surface and by speed', () => {
    const g = surfaceMix(mix, [w('gravel'), w('gravel'), w('gravel'), w('gravel')], 110);
    expect(g.rollGravel).toBeCloseTo(1);
    expect(g.rollTarmac).toBe(0);
    const half = surfaceMix(mix, [w('gravel'), w('gravel'), w('tarmac'), w('tarmac')], 56.5);
    expect(half.rollGravel).toBeCloseTo(0.25, 2);
    expect(half.rollTarmac).toBeCloseTo(0.25, 2);
    expect(surfaceMix(mix, [w('gravel')], 2).rollGravel).toBe(0);
    // grass rolls on the gravel loop, quieter and lower
    const grass = surfaceMix(mix, [w('grass'), w('grass'), w('grass'), w('grass')], 110);
    expect(grass.rollGravel).toBeCloseTo(0.5);
    expect(grass.pitchGravel).toBeCloseTo(0.7 * 1.175);
  });

  it('skids from 150 to 650 cm/s of slip', () => {
    const at = (lat: number) => surfaceMix(mix, [w('gravel', lat), w('gravel', lat), w('gravel', lat), w('gravel', lat)], 80).skidGravel;
    expect(at(150)).toBe(0);
    expect(at(400)).toBeCloseTo(0.5);
    expect(at(650)).toBeCloseTo(1);
    expect(at(2000)).toBeCloseTo(1);
  });
});

describe('music playlists', () => {
  it('finland: stage tracks by day, its night track plus location-free night tracks at night', () => {
    const day = stagePlaylist(manifest.music, 'finland', false);
    expect(day).toEqual(['M_Music_16_FrostSprint', 'M_Music_17_CrestJumper']);
    const night = stagePlaylist(manifest.music, 'finland', true);
    expect(night).toEqual(['M_Music_05_NightStage', 'M_Music_14_LakeNight']);
    const menu = menuPlaylist(manifest.music, mix.menu.tags);
    expect(menu).toContain('M_Music_01_SunsetRoad');
    expect(menu).toContain('M_Music_06_BirchRush');
    expect(menu).not.toContain('M_Music_16_FrostSprint');
  });
});
