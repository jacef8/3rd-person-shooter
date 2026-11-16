// Builds the real vehicle models the web client draws, from Microsoft's Remix 3D models (CC0) as kept
// in the Ethereal / IR Engine open asset kit (github.com/ir-engine/ir-engine-assets-basic, assets/cars
// and assets/animals; see client/models/vehicles/CREDITS.md).
//
// Each source is turned into a light file the game can draw dozens of: specular-glossiness materials
// converted to metal-roughness (what three.js reads), vertices welded, triangles cut to a budget,
// textures shrunk to JPEG, everything flattened into one node and centred: length along +Z (the
// front at +Z), the wheels on y = 0, in metres. The game scales each to the ride it stands in for.
//
// Usage: node tools/build_vehicles.mjs <folder holding PickupTruck.glb, Sedan.glb, ...>
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify, metalRough, flatten, join, quantize, getBounds, transformMesh, normals } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build_vehicles.mjs <source folder>'); process.exit(1); }
const out = new URL('../client/models/vehicles/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// name -> [source file, triangle budget, which way the source's front points: '+z', '-z', '+x' or '-x']
const MODELS = {
  sedan: ['Sedan', 9000, '+z'],
  suv: ['SUV', 9000, '+z'],
  classic: ['RavenRancherBlue', 8000, '+z'],
  pickup: ['PickupTruck', 9000, '+z'],
  motorcycle: ['Motorcycle', 7000, '+z'],
  bus: ['PublicBus', 9000, '+z'],
};
const only = process.argv[3]?.split(',');
await MeshoptSimplifier.ready;
for (const [name, [file, budget, front]] of Object.entries(MODELS)) {
  if (only && !only.includes(name)) continue;
  const doc = await io.read(path.join(src, `${file}.glb`));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) a.dispose();
  await doc.transform(metalRough(), flatten(), dedup());
  // Bake every node's transform into its mesh, so the whole vehicle is one set of vertices in one space.
  const scene = root.listScenes()[0];
  for (const n of root.listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const mat = n.getWorldMatrix();
    const copy = m.listParents().filter((p) => p.propertyType === 'Node').length > 1 ? m.clone() : m;
    transformMesh(copy, mat);
    n.setMesh(copy).setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
  await doc.transform(join({ keepNamed: false }), weld(), prune());
  const tris = () => root.listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() || p.getAttribute('POSITION').getCount()) / 3, 0), 0);
  const before = tris();
  if (before > budget) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: budget / before, error: 0.05, lockBorder: false }));
  // Hard-edged models don't weld (each face keeps its own normal), so they barely simplify: drop the
  // normals, weld by position and UV, simplify, and work the normals out again.
  if (tris() > budget * 1.4) {
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('NORMAL', null);
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: budget / tris(), error: 0.05, lockBorder: false }), normals({ overwrite: true }));
  }
  // Length along +Z with the front at +Z, wheels on y = 0, centred, in metres (a car is ~4.5 m).
  const b = getBounds(scene), size = [0, 1, 2].map((i) => b.max[i] - b.min[i]), c = [0, 1, 2].map((i) => (b.max[i] + b.min[i]) / 2);
  const yaw = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 }[front];
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const longest = Math.max(size[0], size[2]);
  const k = 1 / longest;   // unit length: the game scales to each ride's real size
  // matrix (column-major): scale, then translate to centre/floor, then turn about Y
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -b.min[1], -c[2], 1];
  const S = [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
  const R = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const mul = (A, B) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) for (let i = 0; i < 4; i++) o[col * 4 + r] += A[i * 4 + r] * B[col * 4 + i]; return o; };
  const M = mul(R, mul(S, T));
  for (const m of root.listMeshes()) transformMesh(m, M);
  // Textures: colour 1024 px, the rest 512 px, all JPEG (cut-outs keep PNG).
  for (const t of root.listTextures()) {
    const slots = doc.getGraph().listParentEdges(t).map((e) => e.getName());
    const colour = slots.some((s) => /baseColor/.test(s));
    const mats = doc.getGraph().listParentEdges(t).map((e) => e.getParent()).filter((p) => p.propertyType === 'Material');
    const cut = colour && mats.some((m) => m.getAlphaMode() !== 'OPAQUE');
    const img = sharp(Buffer.from(t.getImage())).resize(colour ? 1024 : 512, colour ? 1024 : 512, { fit: 'inside', withoutEnlargement: true });
    if (cut) { t.setImage(new Uint8Array(await img.png({ palette: true }).toBuffer())); t.setMimeType('image/png'); }
    else { t.setImage(new Uint8Array(await img.flatten({ background: '#808080' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer())); t.setMimeType('image/jpeg'); }
    t.setURI('');
  }
  for (const m of root.listMaterials()) { m.setDoubleSided(false); if (m.getMetallicFactor() > 0.6 && !m.getMetallicRoughnessTexture()) m.setMetallicFactor(0.6); }
  await doc.transform(prune(), dedup(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  await io.write(path.join(out, `${name}.glb`), doc);
  const nb = getBounds(root.listScenes()[0]);
  console.log(name.padEnd(10), `${before} -> ${tris()} triangles`, (fs.statSync(path.join(out, `${name}.glb`)).size / 1e6).toFixed(2), 'MB', 'size', [0, 1, 2].map((i) => (nb.max[i] - nb.min[i]).toFixed(2)).join('x'), 'source', size.map((v) => v.toFixed(2)).join('x'));
}
