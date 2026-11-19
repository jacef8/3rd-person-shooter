// Low-detail copies of the vehicle models (client/models/vehicles/<name>_lo.glb), for phones and for
// anything not close by: the same shape cut to about 1,800 triangles. Also takes the IOR and
// specular extensions off the full models (three.js reads those as its most expensive material,
// for a difference nobody can see on a car at game distance).
//
// Usage: node tools/build_vehicle_lods.mjs [names]   (after tools/build_vehicles.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, weld, simplify, quantize, prune, dedup, normals } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const dir = new URL('../client/models/vehicles/', import.meta.url).pathname;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const LO = 1800;
const names = process.argv[2]?.split(',') || fs.readdirSync(dir).filter((f) => f.endsWith('.glb') && !f.endsWith('_lo.glb') && f !== 'tractor.glb').map((f) => f.slice(0, -4));   // (the tractor is light already)
await MeshoptSimplifier.ready;
const tris = (root) => root.listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() || p.getAttribute('POSITION').getCount()) / 3, 0), 0);
const plain = (doc) => { for (const e of doc.getRoot().listExtensionsUsed()) if (/KHR_materials_(ior|specular)/.test(e.extensionName)) e.dispose(); };
for (const name of names) {
  const file = path.join(dir, `${name}.glb`);
  // The full model, made plain.
  const full = await io.read(file);
  plain(full);
  await io.write(file, full);
  // The low one.
  const doc = await io.read(file), root = doc.getRoot(), before = tris(root);
  await doc.transform(dequantize(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, LO / before), error: 0.02, lockBorder: false }));
  if (tris(root) > LO * 1.4) {   // hard edges keep it from welding: drop normals, weld by position, cut, remake
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('NORMAL', null);
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: LO / tris(root), error: 0.04, lockBorder: false }), normals({ overwrite: true }));
  }
  await doc.transform(prune(), dedup(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  await io.write(path.join(dir, `${name}_lo.glb`), doc);
  console.log(name.padEnd(11), `${before} -> ${tris(root)} triangles`, (fs.statSync(path.join(dir, `${name}_lo.glb`)).size / 1e3).toFixed(0), 'KB');
}
