// Builds the people the web client draws: realistic Mixamo characters (three SWAT officers and three
// civilians) and a full set of rifle animations (8-way walk, run and crouch-walk, sprint, aiming idle).
// Every Mixamo character shares one skeleton, so the clips are packed once and drive anyone.
//
//   client/models/people/<name>.glb   mesh and skin only, textures shrunk to JPEG, fewer triangles
//   client/models/people/anims.glb    the clips, keyed by bone name
//
// Sources (see client/models/people/CREDITS.md):
//   characters: github.com/MaxiGarcia13/conter-strai  assets/glb/characters/{soldiers,civilians}
//   clips:      github.com/chetansinghsajwan/unity-titanfall  Assets/Charcters/Animations/Locomotions
// Usage: node tools/build_people.mjs <folder of character .glb> <folder of clip .fbx>
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify, textureCompress, resample, quantize } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const [charDir, clipDir] = process.argv.slice(2);
if (!charDir || !clipDir) { console.error('usage: node tools/build_people.mjs <characters dir> <clips dir>'); process.exit(1); }
const out = new URL('../client/models/people/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---- Characters --------------------------------------------------------------------------------
const PEOPLE = { swat1: 'swat-1', swat2: 'swat-2', swat3: 'swat-3', james: 'james', liza: 'liza', remy: 'remy' };
const TRIS = 22000;   // about what a phone can draw a couple of dozen of
await MeshoptSimplifier.ready;
for (const [name, file] of Object.entries(PEOPLE)) {
  const doc = await io.read(path.join(charDir, `${file}.glb`));
  for (const a of doc.getRoot().listAnimations()) dropAnim(a);
  // Hair and eyelashes are cut-outs: keep their alpha (PNG); everything else goes to JPEG.
  const cutout = new Set();
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getAlphaMode() === 'BLEND') { m.setAlphaMode('MASK'); m.setAlphaCutoff(0.4); m.setDoubleSided(true); const t = m.getBaseColorTexture(); if (t) cutout.add(t); }
    m.setMetallicFactor(0);   // no environment map out here: metal reads as black
  }
  const tris = () => doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() || 0) / 3, 0), 0);
  const before = tris();
  await doc.transform(prune(), dedup(), weld());
  if (before > TRIS) await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: TRIS / before, error: 0.004, lockBorder: true }));
  for (const t of doc.getRoot().listTextures()) {
    const slots = doc.getGraph().listParentEdges(t).map((e) => e.getName());
    const colour = slots.some((s) => /baseColor/.test(s));
    const size = colour ? 1024 : 512;
    const img = sharp(Buffer.from(t.getImage())).resize(size, size, { fit: 'inside', withoutEnlargement: true });
    if (cutout.has(t)) { t.setImage(new Uint8Array(await img.png({ palette: true, quality: 85 }).toBuffer())); t.setMimeType('image/png'); t.setURI(t.getURI().replace(/\.\w+$/, '.png')); }
    else { t.setImage(new Uint8Array(await img.flatten({ background: '#808080' }).jpeg({ quality: colour ? 84 : 88, mozjpeg: true }).toBuffer())); t.setMimeType('image/jpeg'); t.setURI(t.getURI().replace(/\.\w+$/, '.jpg')); }
  }
  await doc.transform(prune(), quantize({ quantizeNormal: 10, quantizePosition: 14, quantizeTexcoord: 12 }));
  await io.write(path.join(out, `${name}.glb`), doc);
  console.log(name.padEnd(6), `${before} -> ${tris()} triangles,`, (fs.statSync(path.join(out, `${name}.glb`)).size / 1e6).toFixed(2), 'MB');
}

// ---- Clips -------------------------------------------------------------------------------------
// Game name -> source file. The Mixamo files are in centimetres, Y up, in place (no root motion).
const DIRS = { f: 'Forward', b: 'Backward', l: 'Left', r: 'Right', fl: 'Forward Left', fr: 'Forward Right', bl: 'Backward Left', br: 'Backward Right' };
const CLIPS = { aim: 'Stand Idle Rifle Aim Center', hold: 'Stand Idle Rifle', idle: 'Stand Idle', sprint: 'Stand Sprint Forward Rifle', crouch: 'Crouch Idle Rifle' };
for (const [k, d] of Object.entries(DIRS)) {
  CLIPS[`walk_${k}`] = `Stand Walk ${d} Rifle`;
  CLIPS[`run_${k}`] = `Stand Run ${d} Rifle`;
  CLIPS[`cwalk_${k}`] = `Crouch Walk ${d === 'Right' ? 'RIght' : d} Rifle`;
}
const fbx = new FBXLoader();
const anims = new Document();
const buf = anims.createBuffer();
const scene = anims.createScene('clips');
const nodes = new Map();
const node = (bone) => { if (!nodes.has(bone)) { const n = anims.createNode(bone); scene.addChild(n); nodes.set(bone, n); } return nodes.get(bone); };
// The characters' armature is turned +90° about X (Blender's Z-up), so the hips' clip keys are turned back.
const toZUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), q = new THREE.Quaternion();
for (const [name, file] of Object.entries(CLIPS)) {
  const raw = fs.readFileSync(path.join(clipDir, `${file}.fbx`));
  const clip = fbx.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '').animations[0];
  const anim = anims.createAnimation(name);
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.'), bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    const hips = bone === 'mixamorigHips';
    // Only the hips move; every other bone keeps its own length (characters differ in build).
    if (prop === 'scale' || (prop === 'position' && !hips)) continue;
    const v = Float32Array.from(t.values);
    if (hips && prop === 'quaternion') for (let i = 0; i < v.length; i += 4) { q.fromArray(v, i).premultiply(toZUp); q.toArray(v, i); }
    if (hips && prop === 'position') for (let i = 0; i < v.length; i += 3) { const y = v[i + 1], z = v[i + 2]; v[i + 1] = z; v[i + 2] = -y; }
    const input = anims.createAccessor().setType('SCALAR').setArray(Float32Array.from(t.times)).setBuffer(buf);
    const output = anims.createAccessor().setType(prop === 'quaternion' ? 'VEC4' : 'VEC3').setArray(v).setBuffer(buf);
    const sampler = anims.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(anims.createAnimationChannel().setTargetNode(node(bone)).setTargetPath(prop === 'quaternion' ? 'rotation' : 'translation').setSampler(sampler));
  }
}
await anims.transform(resample({ tolerance: 1e-4 }), prune({ keepLeaves: true }));
await io.write(path.join(out, 'anims.glb'), anims);
console.log('anims', Object.keys(CLIPS).length, 'clips,', (fs.statSync(path.join(out, 'anims.glb')).size / 1e6).toFixed(2), 'MB');

/** Remove an animation and the keyframe data under it. */
function dropAnim(a) {
  for (const s of a.listSamplers()) { s.getInput()?.dispose(); s.getOutput()?.dispose(); s.dispose(); }
  for (const c of a.listChannels()) c.dispose();
  a.dispose();
}
