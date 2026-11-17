// Builds the wildlife the web client draws: a white-tailed deer, a feral hog (also drawn 1.8x as the
// boar), an American alligator and a dog, each one small skinned, animated GLB.
//
//   client/models/animals/<name>.glb   one skinned mesh, clips `idle`, `walk`, `run`, `death` (+ extras)
//
// Sources (see client/models/animals/CREDITS.md):
//   deer, dog  Quaternius "Ultimate Animated Animal Pack" (CC0), Deer.glb and ShibaInu.glb, as kept in
//              github.com/trebeljahr/quaternius-showcase  public/glb/animals_pack/
//   hog        Microsoft Rocketbox avatar library (MIT), github.com/microsoft/Microsoft-Rocketbox
//              Assets/Animals/Pig_Pink_01/Export/Pig_Pink_01.fbx + Textures/Pig_pink_color.tga.
//              It comes rigged but without clips: idle, walk, run and death are keyframed here.
//   gator      no usable free alligator could be had, so it is modelled and animated here (lofted
//              body, scutes, jaw, sprawled legs, vertex colours), released with the project.
//
// Every output is in metres, feet on y = 0, facing +Z, centred on x/z (measured in the first frame of
// `idle`), with one material: the Quaternius colour materials are baked into vertex colours and their
// primitives joined, so each animal is one draw call.
//
// Usage: node tools/build_animals.mjs <folder holding Deer.glb, ShibaInu.glb, Pig_Pink_01.fbx, Pig_pink_color.tga> [names]
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, joinPrimitives, resample, quantize, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build_animals.mjs <source folder> [deer,hog,gator,dog]'); process.exit(1); }
const only = process.argv[3]?.split(',');
const out = new URL('../client/models/animals/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// Node has no FileReader (GLTFExporter's binary path) or createImageBitmap (GLTFLoader's textures).
globalThis.FileReader ??= class {
  readAsArrayBuffer(b) { b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); this.onload?.({ target: this }); }); }
  readAsDataURL(b) { b.arrayBuffer().then((r) => { this.result = `data:${b.type || 'application/octet-stream'};base64,${Buffer.from(r).toString('base64')}`; this.onloadend?.(); this.onload?.({ target: this }); }); }
};
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async (blob) => {
  const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data, close() {} };
};
THREE.TextureLoader.prototype.load = () => new THREE.Texture();   // the FBX's textures are read by hand
const arrayBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const lin = (hex) => new THREE.Color(hex);   // sRGB hex -> linear working colour

const ANIMALS = {
  deer: async () => fromQuaternius('Deer.glb', {
    clips: { Idle: 'idle', Walk: 'walk', Gallop: 'run', Death: 'death', Eating: 'eat' },
    // white-tailed deer: tan-brown coat, white belly, throat and inner legs, dark hooves
    colours: { Main: 0x8d6a47, Main_Light: 0xe6e0d2, Main_Dark: 0x5e4733, Hooves: 0x2a2420, Eye_Lighter: 0x6e5039, Eye_Black: 0x0b0a09, Eye_White: 0x8f8a80 },
    size: { y: 1.5 },   // ears 1.5 m, shoulder ~1.0 m
  }),
  dog: async () => fromQuaternius('ShibaInu.glb', {
    clips: { Idle: 'idle', Walk: 'walk', Gallop: 'run', Death: 'death', Attack: 'attack' },
    // a brown farm dog: brown coat, tan muzzle/chest/legs
    colours: { Main: 0x76502f, Main_Light: 0xc9a77c, Black: 0x1c1714, Eyes_White: 0x8a857c, Eyes_Pupil: 0x120d0a, Eyes_Black: 0x0a0908 },
    size: { y: 0.7 },   // ears 0.7 m, shoulder ~0.5 m
  }),
  hog: async () => buildHog(),
  gator: async () => buildGator(),
};

for (const [name, make] of Object.entries(ANIMALS)) {
  if (only && !only.includes(name)) continue;
  const { doc, size, scale } = await make();
  await finish(doc, size, scale);
  await io.write(path.join(out, `${name}.glb`), doc);
}
for (const name of Object.keys(ANIMALS)) if (!only || only.includes(name)) await report(name);

// ---- Quaternius (deer, dog) ----------------------------------------------------------------------
async function fromQuaternius(file, { clips, colours, size }) {
  const doc = await io.read(path.join(src, file));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) {
    const bare = a.getName().replace(/^.*\|/, '');
    if (clips[bare]) a.setName(clips[bare]); else dropAnim(a);
  }
  // Flat colour materials -> one vertex-coloured material, so the primitives join into one draw.
  const mat = doc.createMaterial('fur').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial(), name = m?.getName() ?? '';
    const c = colours[name] !== undefined ? lin(colours[name]).toArray() : (m?.getBaseColorFactor().slice(0, 3) ?? [1, 1, 1]);
    if (colours[name] === undefined) console.warn(`  ${file}: material ${name} keeps its colour`);
    const n = p.getAttribute('POSITION').getCount(), arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set(c, i * 3);
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(arr).setBuffer(root.listBuffers()[0]));
    for (const s of p.listSemantics()) if (/^TEXCOORD/.test(s)) p.setAttribute(s, null);
    p.setMaterial(mat);
  }
  // join() leaves skinned meshes alone; their parts share one skin here, so join them by hand.
  for (const mesh of root.listMeshes()) {
    const prims = mesh.listPrimitives();
    if (prims.length < 2) continue;
    const one = joinPrimitives(prims);
    for (const p of prims) { mesh.removePrimitive(p); p.dispose(); }
    mesh.addPrimitive(one);
  }
  await doc.transform(prune(), weld(), prune());
  return { doc, size };
}

// ---- Rocketbox pig -> feral hog --------------------------------------------------------------------
async function buildHog() {
  const raw = fs.readFileSync(path.join(src, 'Pig_Pink_01.fbx'));
  const group = new FBXLoader().parse(arrayBuf(raw), '');
  group.getObjectByName('pig_Footsteps')?.removeFromParent();
  const mesh = group.getObjectByProperty('type', 'SkinnedMesh');
  mesh.material = new THREE.MeshStandardMaterial({ name: 'hog', roughness: 0.92, metalness: 0 });
  group.name = 'hog'; mesh.name = 'hog';
  group.updateMatrixWorld(true);
  const B = (n) => group.getObjectByName(`pig_${n}`);
  const rig = makeRig(group, mesh);
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const root = group.getObjectByName('Bip01');
  // Legs (pig's left is +X, front +Z, units cm). About world X, + swings the lower end backwards.
  const legs = {
    LH: { up: B('L_Thigh'), mid: B('L_Calf'), low: B('L_Foot'), hind: true },
    RH: { up: B('R_Thigh'), mid: B('R_Calf'), low: B('R_Foot'), hind: true },
    LF: { up: B('L_UpperArm'), mid: B('L_Forearm'), low: B('L_Hand') },
    RF: { up: B('R_UpperArm'), mid: B('R_Forearm'), low: B('R_Hand') },
  };
  const step = (pose, leg, p, A, duty, F) => {
    p = ((p % 1) + 1) % 1;
    let swing, lift = 0;
    if (p < duty) swing = A * (-1 + 2 * p / duty);
    else { const u = (p - duty) / (1 - duty); swing = A * Math.cos(Math.PI * u); lift = Math.sin(Math.PI * u); }
    pose.rot(leg.up, X, swing);
    if (leg.hind) { pose.rot(leg.mid, X, 0.6 * F * lift); pose.rot(leg.low, X, -1.0 * F * lift); }
    else { pose.rot(leg.mid, X, -0.4 * F * lift); pose.rot(leg.low, X, 1.0 * F * lift); }
  };
  const TAU = Math.PI * 2;
  const clips = [
    rig.clip('idle', 4, true, (pose, t) => {
      const w = TAU * t / 4;
      pose.rot(B('Spine1'), X, 0.012 * Math.sin(w * 3));
      pose.rot(B('Head'), Y, 0.14 * Math.sin(w)); pose.rot(B('Head'), X, 0.06 * Math.sin(w * 2) + 0.04);
      pose.rot(B('Xtra_Mouth'), X, 0.05 * Math.max(0, Math.sin(w * 4)));
      pose.rot(B('Ear_L'), X, 0.25 * Math.max(0, Math.sin(w * 2 + 1)) ** 4); pose.rot(B('Ear_R'), X, 0.25 * Math.max(0, Math.sin(w * 2 + 2.5)) ** 4);
      pose.rot(B('Tail'), Y, 0.35 * Math.sin(w * 4));
    }),
    rig.clip('walk', 0.8, true, (pose, t) => {
      const p = t / 0.8, w = TAU * p;
      step(pose, legs.LH, p, 0.3, 0.62, 0.55); step(pose, legs.LF, p + 0.25, 0.3, 0.62, 0.55);
      step(pose, legs.RH, p + 0.5, 0.3, 0.62, 0.55); step(pose, legs.RF, p + 0.75, 0.3, 0.62, 0.55);
      pose.move(root, new THREE.Vector3(0, -0.8 * Math.cos(2 * w), 0));
      pose.rot(root, Z, 0.03 * Math.sin(w));
      pose.rot(B('Head'), X, 0.05 * Math.sin(2 * w)); pose.rot(B('Head'), Y, 0.04 * Math.sin(w));
      pose.rot(B('Tail'), Y, 0.3 * Math.sin(w));
    }),
    rig.clip('run', 0.45, true, (pose, t) => {
      const p = t / 0.45, w = TAU * p;
      step(pose, legs.LH, p, 0.55, 0.42, 0.9); step(pose, legs.RH, p + 0.1, 0.55, 0.42, 0.9);
      step(pose, legs.LF, p + 0.5, 0.55, 0.42, 0.9); step(pose, legs.RF, p + 0.6, 0.55, 0.42, 0.9);
      pose.move(root, new THREE.Vector3(0, 2.5 * Math.sin(w + 1.2), 0));
      pose.rot(root, X, 0.07 * Math.sin(w));
      pose.rot(B('Spine1'), X, -0.06 * Math.sin(w));
      pose.rot(B('Head'), X, -0.05 * Math.sin(w) + 0.06);
      pose.rot(B('Ear_L'), X, -0.3); pose.rot(B('Ear_R'), X, -0.3);
      pose.rot(B('Tail'), X, -0.4);
    }),
    rig.clip('death', 1.6, false, (pose, t) => {
      const buckle = smooth(t / 0.25), roll = smooth((t - 0.15) / 0.5), kick = t > 0.6 ? Math.sin((t - 0.6) * 14) * Math.exp(-(t - 0.6) * 3.5) : 0;
      pose.rot(root, Z, roll * Math.PI / 2);   // onto its right side
      for (const [k, leg] of Object.entries(legs)) {
        const f = buckle * (1 - roll);
        if (leg.hind) { pose.rot(leg.mid, X, 0.4 * f); pose.rot(leg.low, X, -0.7 * f); } else { pose.rot(leg.mid, X, -0.3 * f); pose.rot(leg.low, X, 0.9 * f); }
        pose.rot(leg.up, X, (leg.hind ? 0.25 : -0.25) * roll + 0.35 * kick * (k[0] === 'L' ? 1 : -0.6));
      }
      pose.rot(B('Head'), X, 0.25 * buckle - 0.15 * roll);
      pose.rot(B('Xtra_Mouth'), X, 0.12 * roll);
      pose.rot(B('Tail'), X, 0.3 * roll);
    }, { ground: true }),
  ];
  // The colour map, from pink farm pig to a dark, grizzled feral hog.
  const tga = new TGALoader().parse(arrayBuf(fs.readFileSync(path.join(src, 'Pig_pink_color.tga'))));
  const px = Buffer.from(tga.data.buffer, tga.data.byteOffset, tga.data.byteLength);
  const small = await sharp(px, { raw: { width: tga.width, height: tga.height, channels: 4 } }).removeAlpha().resize(512, 512).raw().toBuffer();
  let mean = 0, cnt = 0;   // over the painted skin, not the black gaps between UV islands
  for (let i = 0; i < small.length; i += 3) { const l = small[i] * 0.3 + small[i + 1] * 0.59 + small[i + 2] * 0.11; if (l > 40) { mean += l; cnt++; } }
  mean /= cnt;
  const base = [52, 43, 37], recol = Buffer.alloc(small.length);
  for (let i = 0; i < small.length; i += 3) {
    const l = (small[i] * 0.3 + small[i + 1] * 0.59 + small[i + 2] * 0.11) / mean;
    const k = Math.pow(Math.max(0, l), 1.6);
    for (let c = 0; c < 3; c++) recol[i + c] = Math.max(0, Math.min(255, Math.round(base[c] * k)));
  }
  // three's FBX UVs have v up; glTF's have v down: flip the image instead of the UVs.
  const jpeg = await sharp(recol, { raw: { width: 512, height: 512, channels: 3 } }).flip().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const doc = await exportThree(group, clips);
  const tex = doc.createTexture('hog').setImage(new Uint8Array(jpeg)).setMimeType('image/jpeg');
  for (const m of doc.getRoot().listMaterials()) m.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.92).setMetallicFactor(0);
  return { doc, scale: 0.01 };   // centimetres -> metres: 0.73 m tall, 1.36 m long
}

// ---- Alligator, modelled here --------------------------------------------------------------------
function buildGator() {
  const group = new THREE.Group();
  group.name = 'gator';
  const bones = {}, world = {};
  const bone = (name, parent, x, y, z) => {
    const b = new THREE.Bone(); b.name = name; world[name] = new THREE.Vector3(x, y, z);
    if (parent) { b.position.copy(world[name]).sub(world[parent]); bones[parent].add(b); } else { b.position.copy(world[name]); group.add(b); }
    bones[name] = b; return b;
  };
  // Spine forward from the root, tail backward; legs off the chest and hips. All rest rotations identity.
  bone('root', null, 0, 0.19, 0);
  bone('chest', 'root', 0, 0.19, 0.22); bone('shoulders', 'chest', 0, 0.19, 0.5); bone('neck', 'shoulders', 0, 0.18, 0.74);
  bone('head', 'neck', 0, 0.15, 0.84); bone('jaw', 'head', 0, 0.1, 0.8);
  bone('hips', 'root', 0, 0.19, -0.3); bone('tail1', 'hips', 0, 0.19, -0.55); bone('tail2', 'tail1', 0, 0.19, -0.8);
  bone('tail3', 'tail2', 0, 0.18, -1.05); bone('tail4', 'tail3', 0, 0.17, -1.28); bone('tail5', 'tail4', 0, 0.165, -1.48);
  const LEG = { F: { body: 'shoulders', at: [0.19, 0.17, 0.52], knee: [0.35, 0.13, 0.5], ankle: [0.37, 0.035, 0.54], toe: [0.41, 0.012, 0.65] },
                H: { body: 'hips', at: [0.17, 0.18, -0.36], knee: [0.36, 0.15, -0.32], ankle: [0.39, 0.035, -0.4], toe: [0.44, 0.012, -0.28] } };
  for (const s of [1, -1]) for (const [k, L] of Object.entries(LEG)) {
    const side = s > 0 ? 'L' : 'R';
    bone(`upper${k}_${side}`, L.body, s * L.at[0], L.at[1], L.at[2]);
    bone(`lower${k}_${side}`, `upper${k}_${side}`, s * L.knee[0], L.knee[1], L.knee[2]);
    bone(`foot${k}_${side}`, `lower${k}_${side}`, s * L.ankle[0], L.ankle[1], L.ankle[2]);
  }
  const names = Object.keys(bones), bi = Object.fromEntries(names.map((n, i) => [n, i]));
  const pos = [], col = [], idx = [], sk = [], sw = [];
  const vert = (p, c, w) => { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); const e = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 4); const tot = e.reduce((a, [, v]) => a + v, 0); for (let i = 0; i < 4; i++) { sk.push(e[i] ? bi[e[i][0]] : 0); sw.push(e[i] ? e[i][1] / tot : 0); } return pos.length / 3 - 1; };
  const C = { back: lin(0x2b2f22), ridge: lin(0x1d1f17), flank: lin(0x434531), belly: lin(0xcfc6a2), lip: lin(0xd9d1b2), mouth: lin(0xb89a86), eye: lin(0xa89a3a), claw: lin(0x2a2620) };
  // Spine weights: blend between the centres of the stretches each bone moves.
  const chain = [[0.92, 'head'], [0.76, 'neck'], [0.62, 'shoulders'], [0.36, 'chest'], [0.0, 'root'], [-0.42, 'hips'], [-0.67, 'tail1'], [-0.92, 'tail2'], [-1.16, 'tail3'], [-1.38, 'tail4'], [-1.56, 'tail5']];
  const spineW = (z) => {
    if (z >= chain[0][0]) return { head: 1 };
    for (let i = 0; i < chain.length - 1; i++) if (z <= chain[i][0] && z >= chain[i + 1][0]) { const u = (chain[i][0] - z) / (chain[i][0] - chain[i + 1][0]); return { [chain[i][1]]: 1 - u, [chain[i + 1][1]]: u }; }
    return { tail5: 1 };
  };
  // Cross-sections: z, half width, top, bottom (metres).
  const lerpTable = (T, z) => { if (z >= T[0][0]) return T[0].slice(1); for (let i = 0; i < T.length - 1; i++) if (z <= T[i][0] && z >= T[i + 1][0]) { const u = (T[i][0] - z) / (T[i][0] - T[i + 1][0]); return T[i].slice(1).map((v, k) => v + (T[i + 1][k + 1] - v) * u); } return T[T.length - 1].slice(1); };
  const BODY = [[1.32, 0.05, 0.115, 0.08], [1.28, 0.07, 0.13, 0.08], [1.15, 0.085, 0.148, 0.085], [1.0, 0.105, 0.172, 0.09], [0.9, 0.13, 0.21, 0.095], [0.82, 0.155, 0.235, 0.07],
    [0.72, 0.18, 0.27, 0.05], [0.55, 0.23, 0.31, 0.05], [0.3, 0.27, 0.33, 0.05], [0.05, 0.285, 0.34, 0.05], [-0.2, 0.26, 0.33, 0.06], [-0.4, 0.2, 0.31, 0.08],
    [-0.6, 0.15, 0.29, 0.1], [-0.85, 0.11, 0.27, 0.11], [-1.1, 0.08, 0.25, 0.12], [-1.35, 0.052, 0.22, 0.13], [-1.58, 0.022, 0.19, 0.14], [-1.62, 0.006, 0.168, 0.155]];
  const JAW = [[1.315, 0.05, 0.079, 0.058], [1.28, 0.066, 0.08, 0.046], [1.15, 0.08, 0.084, 0.04], [1.0, 0.098, 0.088, 0.034], [0.88, 0.12, 0.092, 0.034], [0.78, 0.125, 0.095, 0.04]];
  const N = 16;
  const loft = (T, z0, z1, dz, kind) => {
    const rings = [];
    let ring = 0;
    for (let z = z0; z >= z1 - 1e-6; z -= dz, ring++) {
      const [hw, top, bot] = lerpTable(T, z), mid = bot + 0.42 * (top - bot), r = [];
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
        const e = 2 / 2.8, x = hw * Math.sign(s) * Math.abs(s) ** e;
        let y = c >= 0 ? mid + (top - mid) * Math.abs(c) ** e : mid - (mid - bot) * Math.abs(c) ** e;
        let colr = c > 0.55 ? C.back : c > -0.25 ? C.flank : C.belly;
        if (kind === 'body') {
          const tailZ = z < -0.55, odd = ring % 2 === 1;
          if (z < 0.75 && z > -0.55 && c > 0.5 && odd) { y += 0.014; colr = C.ridge; }                       // scute rows
          if (tailZ && c > 0.85 && odd) { y += 0.035 * Math.min(1, (-0.5 - z) * 2); colr = C.ridge; }       // tail crest
          if (z > 0.84 && c < -0.75) colr = C.mouth;                                                        // roof of the mouth
          else if (z > 0.84 && c < -0.35 && c > -0.6) colr = C.lip;                                         // teeth line
          if (z > 0.85 && z < 0.95 && c > 0.5 && Math.abs(s) > 0.3) { y += 0.025; colr = C.back; }          // eye bosses
          if (z > 1.26 && c > 0.6) y += 0.01;                                                               // nostrils
        } else {
          if (c > 0.75) colr = C.mouth; else if (c > 0.5) colr = C.lip; else if (c > -0.5) colr = C.flank;
        }
        const w = kind === 'jaw' ? { jaw: 1 } : spineW(z);
        r.push(vert(new THREE.Vector3(x, y, z), colr, w));
      }
      rings.push(r);
    }
    for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < N; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % N], c2 = rings[i + 1][k], d = rings[i + 1][(k + 1) % N];
      idx.push(a, c2, b, b, c2, d);
    }
    for (const [r, flip] of [[rings[0], false], [rings[rings.length - 1], true]]) {   // caps
      const p = new THREE.Vector3(); for (const i of r) p.add(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])); p.divideScalar(r.length);
      const ci = vert(p, new THREE.Color(col[r[0] * 3], col[r[0] * 3 + 1], col[r[0] * 3 + 2]), kind === 'jaw' ? { jaw: 1 } : spineW(p.z));
      for (let k = 0; k < N; k++) flip ? idx.push(ci, r[k], r[(k + 1) % N]) : idx.push(ci, r[(k + 1) % N], r[k]);
    }
  };
  loft(BODY, 1.32, -1.62, 0.04, 'body');
  loft(JAW, 1.315, 0.78, 0.05, 'jaw');
  // Eyes: small domes on the bosses.
  for (const s of [1, -1]) {
    const c0 = new THREE.Vector3(s * 0.078, 0.2, 0.9), r = 0.022, base = pos.length / 3;
    const pts = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -0.6, 0]];
    for (const p of pts) vert(c0.clone().add(new THREE.Vector3(p[0] * r, p[1] * r * 0.8, p[2] * r * 1.2)), C.eye, { head: 1 });
    for (const [a, b, c] of [[0, 3, 1], [0, 1, 4], [0, 4, 2], [0, 2, 3], [5, 1, 3], [5, 4, 1], [5, 2, 4], [5, 3, 2]]) idx.push(base + a, base + b, base + c);
  }
  // Legs: tapered tubes shoulder -> elbow -> wrist, and a fan of toes.
  const tube = (p0, p1, r0, r1, w0, w1, sides = 7) => {
    const dir = new THREE.Vector3().subVectors(p1, p0).normalize(), u = new THREE.Vector3(0, 1, 0).cross(dir); if (u.lengthSq() < 1e-4) u.set(1, 0, 0); u.normalize(); const v = new THREE.Vector3().crossVectors(dir, u);
    const a = [], b = [];
    for (let k = 0; k < sides; k++) { const t = (k / sides) * Math.PI * 2, o = u.clone().multiplyScalar(Math.cos(t)).add(v.clone().multiplyScalar(Math.sin(t))); const shade = o.y > 0.3 ? C.back : o.y < -0.3 ? C.belly : C.flank;
      a.push(vert(p0.clone().addScaledVector(o, r0), shade, w0)); b.push(vert(p1.clone().addScaledVector(o, r1), shade, w1)); }
    for (let k = 0; k < sides; k++) { const k1 = (k + 1) % sides; idx.push(a[k], b[k], a[k1], a[k1], b[k], b[k1]); }
    const ca = vert(p0, C.flank, w0), cb = vert(p1, C.flank, w1);
    for (let k = 0; k < sides; k++) { const k1 = (k + 1) % sides; idx.push(ca, a[k1], a[k], cb, b[k], b[k1]); }
  };
  for (const s of [1, -1]) for (const [k, L] of Object.entries(LEG)) {
    const side = s > 0 ? 'L' : 'R', V = (p) => new THREE.Vector3(s * p[0], p[1], p[2]);
    const up = `upper${k}_${side}`, lo = `lower${k}_${side}`, ft = `foot${k}_${side}`;
    const big = k === 'H' ? 1.15 : 1;
    tube(V(L.at).add(new THREE.Vector3(-s * 0.06, 0, 0)), V(L.knee), 0.065 * big, 0.045 * big, { [up]: 1 }, { [up]: 0.6, [lo]: 0.4 });
    tube(V(L.knee), V(L.ankle), 0.045 * big, 0.033 * big, { [lo]: 1 }, { [lo]: 0.7, [ft]: 0.3 });
    // foot: a flat fan of toes from the ankle
    const ank = V(L.ankle), toe = V(L.toe), fwd = new THREE.Vector3().subVectors(toe, ank).setY(0).normalize();
    const nT = k === 'F' ? 5 : 4, spread = 0.75;
    for (let i = 0; i < nT; i++) {
      const ang = (i / (nT - 1) - 0.5) * spread, d = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      const len = new THREE.Vector3().subVectors(toe, ank).length() * (1 - 0.25 * Math.abs(i / (nT - 1) - 0.5) * 2) * big;
      const tip = ank.clone().addScaledVector(d, len).setY(0.008);
      tube(ank.clone().addScaledVector(d, 0.02).setY(0.025), tip, 0.018 * big, 0.008, { [ft]: 1 }, { [ft]: 1 }, 4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sk, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ name: 'hide', vertexColors: true, roughness: 0.8, metalness: 0 }));
  mesh.name = 'gator';
  group.add(mesh);
  group.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(names.map((n) => bones[n])));
  const rig = makeRig(group, mesh);
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), TAU = Math.PI * 2;
  const spine = ['chest', 'shoulders', 'neck', 'head'], tail = ['hips', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5'];
  // Sprawled legs: about Y swings a leg fore/aft, about Z lifts it (signs mirror per side).
  const leg = (pose, k, side, p, A, duty, lift, ext) => {
    const s = side === 'L' ? 1 : -1;
    p = ((p % 1) + 1) % 1;
    let sw, up = 0;
    if (p < duty) sw = -A + 2 * A * p / duty; else { const u = (p - duty) / (1 - duty); sw = A * Math.cos(Math.PI * u); up = Math.sin(Math.PI * u); }
    const U = bones[`upper${k}_${side}`], Lo = bones[`lower${k}_${side}`], F = bones[`foot${k}_${side}`];
    pose.rot(U, Y, s * sw);                               // + moves the foot back
    pose.rot(U, Z, -s * (ext - lift * up));               // ext pushes the body up, lift raises the foot
    pose.rot(Lo, Z, s * (ext - lift * up * 0.5));          // keep the shin near vertical
    pose.rot(F, Z, -s * lift * up * 0.5);
    pose.rot(F, Y, -s * sw * 0.6);                        // toes keep pointing forwards
  };
  const undulate = (pose, w, amp) => {
    const sAmp = [0.04, 0.05, -0.05, -0.05], tAmp = [0.06, 0.12, 0.16, 0.19, 0.22, 0.26];
    spine.forEach((b, i) => pose.rot(bones[b], Y, amp * sAmp[i] * Math.sin(w - i * 0.3)));
    tail.forEach((b, i) => pose.rot(bones[b], Y, amp * tAmp[i] * Math.sin(w + Math.PI - (i + 1) * 0.55)));
  };
  const clips = [
    rig.clip('idle', 5, true, (pose, t) => {
      const w = TAU * t / 5;
      pose.rot(bones.chest, X, -0.012 * Math.sin(w * 2));
      tail.forEach((b, i) => pose.rot(bones[b], Y, 0.05 * (i + 1) / 3 * Math.sin(w - i * 0.5)));
      pose.rot(bones.neck, X, -0.04 * Math.max(0, Math.sin(w)));
      pose.rot(bones.head, Y, 0.05 * Math.sin(w));
      pose.rot(bones.jaw, X, 0.03 * Math.max(0, Math.sin(w * 2 - 1)) ** 2);
    }),
    rig.clip('walk', 1.4, true, (pose, t) => {
      const p = t / 1.4, w = TAU * p;
      leg(pose, 'F', 'L', p, 0.4, 0.65, 0.3, 0.3); leg(pose, 'H', 'R', p, 0.4, 0.65, 0.3, 0.3);
      leg(pose, 'F', 'R', p + 0.5, 0.4, 0.65, 0.3, 0.3); leg(pose, 'H', 'L', p + 0.5, 0.4, 0.65, 0.3, 0.3);
      undulate(pose, w, 1);
      pose.move(bones.root, new THREE.Vector3(0, 0.05 + 0.006 * Math.cos(2 * w), 0));   // high walk: belly off the ground
      pose.rot(bones.root, Z, 0.02 * Math.sin(w));
    }),
    rig.clip('run', 0.6, true, (pose, t) => {
      const p = t / 0.6, w = TAU * p;
      leg(pose, 'F', 'L', p, 0.6, 0.55, 0.45, 0.42); leg(pose, 'H', 'R', p, 0.6, 0.55, 0.45, 0.42);
      leg(pose, 'F', 'R', p + 0.5, 0.6, 0.55, 0.45, 0.42); leg(pose, 'H', 'L', p + 0.5, 0.6, 0.55, 0.45, 0.42);
      undulate(pose, w, 1.6);
      pose.move(bones.root, new THREE.Vector3(0, 0.07 + 0.012 * Math.cos(2 * w), 0));
      pose.rot(bones.root, Z, 0.035 * Math.sin(w));
      pose.rot(bones.neck, X, -0.05);
    }),
    rig.clip('attack', 0.9, false, (pose, t) => {
      const open = t < 0.22 ? smooth(t / 0.22) : 1 - smooth((t - 0.22) / 0.1), lunge = Math.sin(Math.PI * Math.min(1, t / 0.6)) * (t < 0.6 ? 1 : 0);
      pose.rot(bones.jaw, X, 0.42 * open);
      pose.rot(bones.chest, X, -0.06 * open); pose.rot(bones.neck, X, -0.25 * open); pose.rot(bones.head, X, -0.18 * open + 0.06 * lunge);
      pose.move(bones.root, new THREE.Vector3(0, 0.03 * lunge, 0.18 * lunge));
      pose.rot(bones.tail2, Y, 0.15 * lunge); pose.rot(bones.tail4, Y, -0.2 * lunge);
    }),
    rig.clip('death', 1.6, false, (pose, t) => {
      const roll = smooth((t - 0.1) / 0.9), thrash = t < 0.9 ? Math.sin(t * 18) * (1 - t / 0.9) : 0;
      pose.rot(bones.root, Z, roll * Math.PI);   // belly up
      tail.forEach((b, i) => pose.rot(bones[b], Y, 0.25 * thrash * (i + 1) / 4 + 0.05 * roll * i));
      pose.rot(bones.neck, Y, 0.2 * thrash);
      pose.rot(bones.jaw, X, 0.15 * roll);
      for (const side of ['L', 'R']) for (const k of ['F', 'H']) { const s = side === 'L' ? 1 : -1; pose.rot(bones[`upper${k}_${side}`], Z, s * (0.35 * roll + 0.9 * Math.sin(Math.PI * roll))); pose.rot(bones[`lower${k}_${side}`], Z, -s * 0.5 * roll); }
    }, { ground: true }),
  ];
  return exportThree(group, clips).then((doc) => ({ doc, scale: 1 }));
}

// ---- Keyframing helpers ------------------------------------------------------------------------------
/** Procedural clips for a three.js skinned rig. Rotations are given about axes of the model's frame at
 *  rest (X left, Y up, Z forward) and applied in each bone's own frame, so they follow the parent. */
function makeRig(group, mesh) {
  group.updateMatrixWorld(true);
  const bones = []; group.traverse((o) => { if (o.isBone) bones.push(o); });   // the skin may leave out the root
  const rest = new Map(bones.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone(), wq: b.getWorldQuaternion(new THREE.Quaternion()) }]));
  const groundY = () => {   // lowest skinned vertex in the current pose
    group.updateMatrixWorld(true);
    const v = new THREE.Vector3(), pos = mesh.geometry.attributes.position; let m = Infinity;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); mesh.applyBoneTransform(i, v); v.applyMatrix4(mesh.matrixWorld); if (v.y < m) m = v.y; }
    return m;
  };
  const clip = (name, dur, loop, fn, { ground = false, fps = 30 } = {}) => {
    const n = Math.round(dur * fps) + 1, times = new Float32Array(n);
    const q = new Map(bones.map((b) => [b, new Float32Array(n * 4)])), p = new Map();
    const _q = new THREE.Quaternion(), _a = new THREE.Vector3();
    for (let f = 0; f < n; f++) {
      const t = Math.min(dur, f / fps); times[f] = t;
      for (const b of bones) { b.quaternion.copy(rest.get(b).q); b.position.copy(rest.get(b).p); }
      const moved = new Set();
      const pose = {
        rot(b, axis, ang) { if (!b || !ang) return; _a.copy(axis).applyQuaternion(rest.get(b).wq.clone().invert()); b.quaternion.multiply(_q.setFromAxisAngle(_a, ang)); },
        move(b, d) { if (!b) return; const par = b.parent.getWorldQuaternion(new THREE.Quaternion()).invert(); b.position.add(d.clone().applyQuaternion(par)); moved.add(b); },
      };
      fn(pose, loop ? t % dur : t);
      const root = bones[0];
      if (ground) { root.position.y -= groundY() / root.parent.getWorldScale(new THREE.Vector3()).y; moved.add(root); }
      for (const b of bones) b.quaternion.toArray(q.get(b), f * 4);
      for (const b of moved) if (!p.has(b)) { const arr = new Float32Array(n * 3); for (let k = 0; k < n; k++) rest.get(b).p.toArray(arr, k * 3); p.set(b, arr); }
      for (const [b, arr] of p) b.position.toArray(arr, f * 3);
    }
    // bones moved only in some frames: fill the others with rest
    const tracks = [];
    for (const b of bones) {
      const arr = q.get(b); let still = true; for (let f = 1; f < n && still; f++) for (let k = 0; k < 4; k++) if (Math.abs(arr[f * 4 + k] - arr[k]) > 1e-5) { still = false; break; }
      if (!still || b === bones[0]) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, arr));
    }
    for (const [b, arr] of p) tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, arr));
    for (const b of bones) { b.quaternion.copy(rest.get(b).q); b.position.copy(rest.get(b).p); }
    group.updateMatrixWorld(true);
    return new THREE.AnimationClip(name, dur, tracks);
  };
  return { clip };
}
function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

async function exportThree(object, animations) {
  const glb = await new GLTFExporter().parseAsync(object, { binary: true, animations, onlyVisible: false });
  return io.readBinary(new Uint8Array(glb));
}

// ---- Shared finishing: size, floor, centre, compress ---------------------------------------------
async function finish(doc, size, scale) {
  const root = doc.getRoot();
  await doc.transform(resample({ tolerance: 1e-4 }), prune({ keepLeaves: true }));
  for (const m of root.listMaterials()) { m.setDoubleSided(false); m.setMetallicFactor(0); }
  // Measure the first frame of idle as three.js poses it.
  let box = await measure(doc);
  let s = scale ?? 1;
  if (size?.y) s = size.y / (box.max.y - box.min.y);
  bake(doc, s, new THREE.Vector3());
  box = await measure(doc);
  const c = box.getCenter(new THREE.Vector3());
  bake(doc, 1, new THREE.Vector3(-c.x, -box.min.y, -c.z));
  await doc.transform(prune(), dedup(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8 }));
}

/** Uniformly scale everything by s (translations, vertices, inverse bind matrices, translation keys),
 *  then shift the scene's top-level nodes by `offset`. */
function bake(doc, s, offset) {
  const root = doc.getRoot(), scene = root.listScenes()[0], top = new Set(scene.listChildren());
  if (s !== 1) {
    for (const n of root.listNodes()) n.setTranslation(n.getTranslation().map((v) => v * s));
    const done = new Set();
    for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
      const a = p.getAttribute('POSITION'); if (done.has(a)) continue; done.add(a);
      const arr = a.getArray().slice(); for (let i = 0; i < arr.length; i++) arr[i] *= s; a.setArray(arr);
      for (const t of p.listTargets()) { const ta = t.getAttribute('POSITION'); if (ta && !done.has(ta)) { done.add(ta); const r = ta.getArray().slice(); for (let i = 0; i < r.length; i++) r[i] *= s; ta.setArray(r); } }
    }
    for (const sk of root.listSkins()) { const ibm = sk.getInverseBindMatrices(); if (!ibm || done.has(ibm)) continue; done.add(ibm); const arr = ibm.getArray().slice(); for (let i = 0; i < arr.length; i += 16) { arr[i + 12] *= s; arr[i + 13] *= s; arr[i + 14] *= s; } ibm.setArray(arr); }
    for (const a of root.listAnimations()) for (const ch of a.listChannels()) if (ch.getTargetPath() === 'translation') { const o = ch.getSampler().getOutput(); if (done.has(o)) continue; done.add(o); const arr = o.getArray().slice(); for (let i = 0; i < arr.length; i++) arr[i] *= s; o.setArray(arr); }
  }
  if (offset.lengthSq() > 0) {
    for (const n of top) n.setTranslation(n.getTranslation().map((v, i) => v + offset.getComponent(i)));
    const done = new Set();
    for (const a of root.listAnimations()) for (const ch of a.listChannels()) if (ch.getTargetPath() === 'translation' && top.has(ch.getTargetNode())) { const o = ch.getSampler().getOutput(); if (done.has(o)) continue; done.add(o); const arr = o.getArray().slice(); for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) arr[i + k] += offset.getComponent(k); o.setArray(arr); }
  }
}

async function load(buf) {
  return new Promise((res, rej) => new GLTFLoader().parse(arrayBuf(Buffer.from(buf)), '', res, rej));
}
async function measure(doc, clipName = 'idle') {
  const gltf = await load(await io.writeBinary(doc));
  return posedBox(gltf, clipName, 0);
}
function posedBox(gltf, clipName, t) {
  const clip = gltf.animations.find((a) => a.name === clipName);
  if (clip) { const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(clip).play(); mixer.setTime(t); }
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3(), v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); if (o.isSkinnedMesh) o.applyBoneTransform(i, v); v.applyMatrix4(o.matrixWorld); box.expandByPoint(v); }
  });
  return box;
}

/** Load the written file back with three.js's GLTFLoader and print what the game will get. */
async function report(name) {
  const file = path.join(out, `${name}.glb`), bytes = fs.readFileSync(file);
  const gltf = await load(bytes);
  let tris = 0, skinned = 0, roots = new Set();
  gltf.scene.traverse((o) => { if (o.isMesh) { tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; if (o.isSkinnedMesh) { skinned++; roots.add(o.skeleton.bones.find((b) => !b.parent?.isBone)?.name); } } });
  const box = posedBox(gltf, 'idle', 0), sz = box.getSize(new THREE.Vector3());
  console.log(`${name.padEnd(6)} ${(bytes.length / 1024).toFixed(0)} KB, ${tris} triangles, ${skinned} skinned mesh, root bone ${[...roots].join(',')}`);
  console.log(`       size ${sz.x.toFixed(2)} x ${sz.y.toFixed(2)} x ${sz.z.toFixed(2)} m (w x h x l), min y ${box.min.y.toFixed(3)}, centre x ${((box.min.x + box.max.x) / 2).toFixed(3)} z ${((box.min.z + box.max.z) / 2).toFixed(3)}`);
  console.log(`       clips ${gltf.animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s`).join(', ')}`);
}

/** Remove an animation (its keyframes may share accessors, so prune() frees them). */
function dropAnim(a) {
  for (const c of a.listChannels()) c.dispose();
  for (const s of a.listSamplers()) s.dispose();
  a.dispose();   // its keyframe accessors go with the next prune()
}
