// Exponential height fog (handoff §8): density falls off with height above a fog height that
// follows the car, nothing within the start distance, and a directional in-scatter toward the sun
// (strong at sunset). A port of the original engine's height-fog line integral, as a scene fogNode.
import * as THREE from 'three/webgpu';
import { Fn, abs, cameraPosition, dot, exp2, float, length, max, min, output, positionWorld, pow, saturate, select, uniform, vec4 } from 'three/tsl';

export const fogU = {
  density: uniform(0.003), // per metre
  falloff: uniform(0.008), // per metre
  start: uniform(45),
  height: uniform(0), // world y of the fog's reference height (the car + offset)
  minTransmittance: uniform(0), // 1 − max opacity
  color: uniform(new THREE.Color(0.6, 0.68, 0.8)),
  dirColor: uniform(new THREE.Color(0, 0, 0)),
  dirExponent: uniform(6),
  dirStart: uniform(60),
  toSun: uniform(new THREE.Vector3(0, 1, 0)),
};

/** Transmittance (x) and the fog colour to add (yzw), per vertex: fog changes slowly across a
 * triangle, and per pixel it cost 2.5 ms on an integrated GPU at 1080p. */
const fogTerms = Fn(() => {
  const ray = positionWorld.sub(cameraPosition);
  const len = max(length(ray), 1e-3);
  const dir = ray.div(len);
  // skip the first `start` metres: the integral begins where the ray leaves that sphere
  const excl = min(fogU.start, len);
  const rayLength = len.sub(excl);
  const startY = cameraPosition.y.add(dir.y.mul(excl));
  const rayDy = dir.y.mul(rayLength);
  const origin = fogU.density.mul(exp2(max(fogU.falloff.mul(startY.sub(fogU.height)), -127).negate()));
  const f = max(fogU.falloff.mul(rayDy), -127);
  const ln2 = Math.LN2;
  const integral = select(abs(f).greaterThan(1e-4), float(1).sub(exp2(f.negate())).div(f), float(ln2).sub(f.mul(0.5 * ln2 * ln2)));
  const shared = origin.mul(integral);
  const transmittance = max(saturate(exp2(shared.mul(rayLength).negate())), fogU.minTransmittance);
  const dirLight = pow(saturate(dot(dir, fogU.toSun)), fogU.dirExponent);
  const dirFactor = saturate(exp2(shared.mul(max(len.sub(fogU.dirStart), 0)).negate()));
  const dirIn = fogU.dirColor.mul(dirLight).mul(float(1).sub(dirFactor));
  const fogColour = fogU.color.mul(float(1).sub(transmittance)).add(dirIn);
  return vec4(transmittance, fogColour);
});

export const heightFog = Fn(() => {
  const f = fogTerms().toVarying('v_fog');
  return vec4(output.rgb.mul(f.x).add(f.yzw), output.a);
});
