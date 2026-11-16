// Builds the people the web client draws, from Quaternius's "Ultimate Modular Men" pack (CC0:
// https://quaternius.com/packs/ultimatemodularcharacters.html, also on poly.pizza). Every outfit in
// the pack shares one skeleton and one set of 24 animations, so:
//   client/models/people/<outfit>.glb  the mesh and skin only (animations stripped)
//   client/models/people/anims.glb     the skeleton and the clips the game plays, once
// Usage: node tools/build_characters.mjs <folder holding Swat.glb, Farmer.glb, ...>
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup, resample, quantize } from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build_characters.mjs <source folder>'); process.exit(1); }
const out = new URL('../client/models/people/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const OUTFITS = { swat: 'Swat', worker: 'Worker', farmer: 'Farmer', punk: 'Punk', adventurer: 'Adventurer', casual: 'Casual_Character', beach: 'Beach_Character' };
const CLIPS = ['Idle', 'Idle_Gun', 'Idle_Gun_Pointing', 'Idle_Gun_Shoot', 'Idle_Neutral', 'Walk', 'Run', 'Run_Back', 'Run_Left', 'Run_Right', 'Run_Shoot', 'Death', 'HitRecieve', 'Interact', 'Wave', 'Roll'];

/** Remove an animation and the keyframe data under it (prune leaves orphaned accessors behind). */
function dropAnim(a) {
  for (const s of a.listSamplers()) { s.getInput()?.dispose(); s.getOutput()?.dispose(); s.dispose(); }
  for (const c of a.listChannels()) c.dispose();
  a.dispose();
}
for (const [name, file] of Object.entries(OUTFITS)) {
  const doc = await io.read(path.join(src, `${file}.glb`));
  for (const a of doc.getRoot().listAnimations()) dropAnim(a);
  await doc.transform(prune(), dedup(), quantize({ quantizeNormal: 10, quantizePosition: 14 }));
  await io.write(path.join(out, `${name}.glb`), doc);
  console.log(name, fs.statSync(path.join(out, `${name}.glb`)).size);
}
// The clips: from the Swat file, meshes and skins dropped, names without the "CharacterArmature|" prefix.
const doc = await io.read(path.join(src, 'Swat.glb'));
for (const n of doc.getRoot().listNodes()) { n.setMesh(null); n.setSkin(null); }
for (const s of doc.getRoot().listSkins()) s.dispose();
for (const a of doc.getRoot().listAnimations()) {
  const short = a.getName().replace(/^.*\|/, '');
  if (!CLIPS.includes(short)) dropAnim(a); else a.setName(short);
}
await doc.transform(prune(), resample({ tolerance: 1e-4 }), dedup());
await io.write(path.join(out, 'anims.glb'), doc);
console.log('anims', fs.statSync(path.join(out, 'anims.glb')).size);
