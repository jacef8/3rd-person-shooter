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

const [charDir, clipDir, mode] = process.argv.slice(2);   // mode 'clips': rebuild only anims.glb
if (!charDir || !clipDir) { console.error('usage: node tools/build_people.mjs <characters dir> <clips dir>'); process.exit(1); }
const out = new URL('../client/models/people/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---- Characters --------------------------------------------------------------------------------
const PEOPLE = { swat1: 'swat-1', swat2: 'swat-2', swat3: 'swat-3', james: 'james', liza: 'liza', remy: 'remy' };
const TRIS = 22000;   // about what a phone can draw a couple of dozen of
await MeshoptSimplifier.ready;
for (const [name, file] of Object.entries(mode === 'clips' ? {} : PEOPLE)) {
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
THREE.TextureLoader.prototype.load = () => new THREE.Texture();   // (the T-pose file carries a mesh; its textures aren't needed)
const readFbx = (file) => { const raw = fs.readFileSync(file); return fbx.parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), ''); };
const anims = new Document();
const buf = anims.createBuffer();
const scene = anims.createScene('clips');
const nodes = new Map();
const node = (bone) => { if (!nodes.has(bone)) { const n = anims.createNode(bone); scene.addChild(n); nodes.set(bone, n); } return nodes.get(bone); };

// Retargeting. The clips were made on another copy of the Mixamo rig whose bones rest at slightly
// different angles (up to ~30° on the feet and forearms), so their raw local rotations bend our
// people's knees and twist their arms. Instead, for every frame: how far each bone has turned in the
// world from the clip rig's T-pose is applied to our rig's T-pose, and turned back into a local
// rotation. The hips' height is scaled to our rig.
const bare = (n) => n.replace(/^mixamorig:?/, '');
// Our rig (every character shares it): rebuilt as three.js objects from a character file, at rest (T-pose).
const tdoc = await io.read(path.join(charDir, 'swat-1.glb'));
const tgt = {}, tgtObj = new Map();
const build = (n, parent) => {
  const o = new THREE.Object3D();
  o.position.fromArray(n.getTranslation()); o.quaternion.fromArray(n.getRotation()); o.scale.fromArray(n.getScale());
  parent.add(o); tgtObj.set(n, o);
  if (n.getName().startsWith('mixamorig')) tgt[bare(n.getName())] = { o, node: n.getName().replace(':', '') };
  for (const c of n.listChildren()) build(c, o);
};
const tRoot = new THREE.Object3D();
for (const n of tdoc.getRoot().listScenes()[0].listChildren()) build(n, tRoot);
tRoot.updateMatrixWorld(true);
const order = [];   // parents before children
(function walk(o) { for (const c of o.children) { const b = Object.entries(tgt).find(([, v]) => v.o === c); if (b) order.push(b[0]); walk(c); } })(tRoot);
const WtT = {}, PtT = new THREE.Vector3();
for (const b of order) WtT[b] = tgt[b].o.getWorldQuaternion(new THREE.Quaternion());
tgt.Hips.o.getWorldPosition(PtT);
const hipsParentInv = tgt.Hips.o.parent.matrixWorld.clone().invert(), hipsParentQ = tgt.Hips.o.parent.getWorldQuaternion(new THREE.Quaternion());
// The clip rig in its T-pose.
const poseOf = (obj, clip, t) => {
  const mixer = new THREE.AnimationMixer(obj); mixer.clipAction(clip).play(); mixer.setTime(t); obj.updateMatrixWorld(true);
  const bones = {}; obj.traverse((o) => { if (o.isBone) bones[bare(o.name)] = o; });
  return bones;
};
const tposeObj = readFbx(path.join(clipDir, 'TPose.fbx'));
const sT = poseOf(tposeObj, tposeObj.animations[0], 0);
const WsT = {}; for (const b of order) if (sT[b]) WsT[b] = sT[b].getWorldQuaternion(new THREE.Quaternion());
const PsT = sT.Hips.getWorldPosition(new THREE.Vector3());
const hipK = PtT.y / PsT.y;   // our hips' height over the clip rig's
console.log('retarget: hips', PsT.y.toFixed(1), '->', PtT.y.toFixed(3), 'bones', Object.keys(WsT).length);

const FPS = 30;
const _w = new THREE.Quaternion(), _d = new THREE.Quaternion(), _p = new THREE.Vector3();
for (const [name, file] of Object.entries(CLIPS)) {
  const obj = readFbx(path.join(clipDir, `${file}.fbx`)), clip = obj.animations[0];
  const mixer = new THREE.AnimationMixer(obj); mixer.clipAction(clip).play();
  const bones = {}; obj.traverse((o) => { if (o.isBone) bones[bare(o.name)] = o; });
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1), times = new Float32Array(n);
  const rot = {}; for (const b of order) if (WsT[b] && bones[b]) rot[b] = new Float32Array(n * 4);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / FPS); times[i] = t;
    mixer.setTime(t); obj.updateMatrixWorld(true);
    const Wt = {};
    for (const b of order) {
      if (!rot[b]) continue;
      bones[b].getWorldQuaternion(_w);
      _d.copy(_w).multiply(_d.copy(WsT[b]).invert());            // how far it's turned from the T-pose…
      _d.copy(_w).multiply(WsT[b].clone().invert());
      Wt[b] = _d.clone().multiply(WtT[b]);                       // …applied to ours
      const parent = tgt[b].o.parent, pb = Object.keys(tgt).find((k) => tgt[k].o === parent);
      const pq = pb && Wt[pb] ? Wt[pb] : (pb ? WtT[pb] : hipsParentQ);
      pq.clone().invert().multiply(Wt[b]).toArray(rot[b], i * 4);
    }
    bones.Hips.getWorldPosition(_p);
    _p.sub(PsT).multiplyScalar(hipK).add(PtT).applyMatrix4(hipsParentInv).toArray(pos, i * 3);
  }
  const anim = anims.createAnimation(name);
  const input = anims.createAccessor().setType('SCALAR').setArray(times).setBuffer(buf);
  const chan = (bone, pathName, arr, type) => {
    const sampler = anims.createAnimationSampler().setInput(input).setOutput(anims.createAccessor().setType(type).setArray(arr).setBuffer(buf)).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(anims.createAnimationChannel().setTargetNode(node(bone)).setTargetPath(pathName).setSampler(sampler));
  };
  for (const [b, arr] of Object.entries(rot)) chan(tgt[b].node, 'rotation', arr, 'VEC4');
  chan(tgt.Hips.node, 'translation', pos, 'VEC3');
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
