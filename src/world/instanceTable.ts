// The stage instance table written by tools/convert/stage.mjs, decoded once at load (no three.js here,
// so tests read the shipped files with it).

/** The instance table (tools/convert/stage.mjs): "q16" = quantized struct-of-arrays, gzipped; else raw Float32. */
export interface InstanceTableJson {
  format?: 'q16';
  gzip?: boolean;
  count?: number;
  origin?: number[];
  extent?: number[];
  scale?: number[];
  floats_per_instance: number;
  /** mesh -> [first instance, count]; "<mesh>~<k>" = the mesh with white_tint palette entry k. */
  instances: Record<string, [number, number]>;
  breakables: Record<string, [number, number]>;
}

/** The instance table as six floats per instance [x, y, z, rotY, scale, tint] (three metres, radians). */
export async function decodeInstances(t: InstanceTableJson, data: ArrayBuffer): Promise<Float32Array> {
  if (t.gzip) data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (t.format !== 'q16') return new Float32Array(data);
  const n = t.count!, o = t.origin!, e = t.extent!, sc = t.scale!;
  const u = new Uint16Array(data, 0, n * 5);
  const tint = new Uint8Array(data, n * 10, n);
  const out = new Float32Array(n * 6);
  const k16 = 1 / 65535;
  for (let i = 0; i < n; i++) {
    out[i * 6] = o[0] + u[i] * k16 * e[0];
    out[i * 6 + 1] = o[1] + u[n + i] * k16 * e[1];
    out[i * 6 + 2] = o[2] + u[2 * n + i] * k16 * e[2];
    out[i * 6 + 3] = (u[3 * n + i] / 65536) * 2 * Math.PI - Math.PI;
    out[i * 6 + 4] = sc[0] + u[4 * n + i] * k16 * (sc[1] - sc[0]);
    out[i * 6 + 5] = tint[i] / 255;
  }
  return out;
}
