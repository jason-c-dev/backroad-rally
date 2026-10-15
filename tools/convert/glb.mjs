#!/usr/bin/env node
// Compress GLBs from the Blender exporters for the web (handoff §14a budget).
//
//   node tools/convert/glb.mjs <in.glb> [out.glb] [--keep-normals]
//
// Flat-shaded, untextured meshes: the per-face normals are dropped (the materials flat-shade
// from screen-space derivatives), identical vertices are welded, attributes quantized
// (KHR_mesh_quantization) and the buffers meshopt-compressed (EXT_meshopt_compression).
// Positions keep 14 bits: about 1.5 cm on a 256 m terrain tile, well under a car's tyre.
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, quantize, weld, prune } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { statSync } from 'node:fs';

const [input, outArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keepNormals = process.argv.includes('--keep-normals');
if (!input) {
  console.error('usage: node tools/convert/glb.mjs <in.glb> [out.glb] [--keep-normals]');
  process.exit(1);
}
const output = outArg ?? input;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});
const before = statSync(input).size;
const doc = await io.read(input);
if (!keepNormals) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const n = prim.getAttribute('NORMAL');
      if (n) {
        prim.setAttribute('NORMAL', null);
        if (n.listParents().length <= 1) n.dispose();
      }
    }
  }
}
await doc.transform(
  // materials stay apart: their names are the surface slots (Gravel, Tarmac, ...) even when they look alike
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }),
  weld(),
  prune(),
  quantize({ quantizePosition: 14, quantizeColor: 8, quantizeNormal: 10 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(output, doc);
const after = statSync(output).size;
console.log(`${input} -> ${output}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
