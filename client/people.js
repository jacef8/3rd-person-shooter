// People: real rigged, skinned characters with blended animations, in place of the old
// hand-built ones. The models and clips are Quaternius's "Ultimate Modular Men" (CC0; see
// client/models/people/CREDITS.md and tools/build_characters.mjs). Every outfit shares one
// skeleton, so the clips are loaded once and drive anyone.
//
// What plays: the legs blend idle, walk, run, run back and strafe left/right by how fast and which
// way the person is really moving (all kept in step); the upper body holds a gun (or swings the
// arms when there's none). On top of that, done here in code because the pack has no clips for
// them: crouching and sitting (the hips drop and the legs bend to keep the feet planted, by IK),
// looking up and down (the spine follows the aim), and both hands on whatever gun is held (arm IK
// to the grip and the handguard), so reloads and recoil move the hands too.
import * as THREE from 'three';
import { GLTFLoader } from '/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '/addons/utils/SkeletonUtils.js';

export const OUTFITS = ['swat', 'worker', 'farmer', 'punk', 'adventurer', 'casual', 'beach'];
const loader = new GLTFLoader();
const files = new Map();
const load = (name) => { if (!files.has(name)) files.set(name, loader.loadAsync(`/models/people/${name}.glb`)); return files.get(name); };

// Bone names as three.js has them (glTF names with the dots taken out: "Foot.L" -> "FootL").
const LOWER = new Set(['Body', 'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR', 'FootL', 'FootR', 'PTL', 'PTR', 'Root']);
let CLIPS = null;
const clipsReady = load('anims').then((g) => {
  CLIPS = {};
  for (const c of g.animations) {
    const bone = (t) => t.name.slice(0, t.name.lastIndexOf('.'));
    CLIPS[c.name] = {
      full: c,
      lower: new THREE.AnimationClip(`${c.name}_lo`, c.duration, c.tracks.filter((t) => LOWER.has(bone(t)))),
      upper: new THREE.AnimationClip(`${c.name}_up`, c.duration, c.tracks.filter((t) => !LOWER.has(bone(t)))),
    };
  }
});
/** Start fetching the clips and the usual outfits early (they're small). */
export function preloadPeople(list = ['swat']) { for (const n of list) load(n).catch(() => {}); return clipsReady; }

const LOCO = ['Walk', 'Run', 'Run_Back', 'Run_Left', 'Run_Right'];
const IDLES = ['Idle_Gun', 'Idle_Neutral'];
const UPPER = ['Idle_Gun_Pointing', 'Idle_Neutral', ...LOCO];

/**
 * Put a person in `holder` (a Group whose +Z is forward, feet at y = 0). `opts`: { skin, tint:
 * { materialName: hex }, onReady(rig), onFail() }. Resolves to the rig.
 */
export function attachPerson(holder, outfit, opts = {}) {
  return Promise.all([load(outfit), clipsReady]).then(([gltf]) => {
    if (holder.userData.disposed) return null;
    const model = cloneSkinned(gltf.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material.clone();
      m.metalness = 0; m.roughness = 0.82;   // no environment map out here: metal reads as black
      const want = opts.tint?.[m.name] ?? (m.name === 'Skin' ? opts.skin : undefined);
      if (want !== undefined) m.color.setHex(want);
      m.emissive.copy(m.color).multiplyScalar(0.18);   // a little lift, so dark gear isn't a silhouette with the sun behind it
      o.material = m;
      o.castShadow = true;
    });
    holder.add(model);
    const rig = setupRig(holder, model);
    opts.onReady?.(rig);
    return rig;
  }).catch((e) => { console.warn('person', outfit, e); opts.onFail?.(); return null; });
}

// Scratch objects (no garbage in the frame loop).
const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _t = V(), _d = V(), _p = V(), _x = V(), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

function setupRig(holder, model) {
  const B = {};
  model.traverse((o) => { if (o.isBone) B[o.name] = o; });
  // The bones this file moves by hand go back to their rest pose every frame before the clips play
  // (a clip that doesn't key a bone would otherwise leave last frame's change on it to pile up).
  const rest = [];
  const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
  const fingers = ['R', 'L'].map((s) => FINGERS.map((f) => [1, 2, 3].map((k) => B[`${f}${k}${s}`]).filter(Boolean)));
  for (const n of ['Root', 'Body', 'FootL', 'FootR', 'PTL', 'PTR', 'Abdomen', 'Chest', 'Neck', 'UpperLegL', 'UpperLegR', 'LowerLegL', 'LowerLegR', 'UpperArmL', 'UpperArmR', 'LowerArmL', 'LowerArmR', 'WristL', 'WristR'])
    if (B[n]) rest.push([B[n], B[n].position.clone(), B[n].quaternion.clone()]);
  for (const hand of fingers) for (const chain of hand) for (const b of chain) rest.push([b, b.position.clone(), b.quaternion.clone()]);
  const mixer = new THREE.AnimationMixer(model);
  const act = (clip) => { const a = mixer.clipAction(clip); a.play(); a.timeScale = 0; a.setEffectiveWeight(0); return a; };
  const lo = {}, up = {};
  for (const n of [...LOCO, ...IDLES]) lo[n] = act(CLIPS[n].lower);
  for (const n of UPPER) up[n] = act(CLIPS[n].upper);
  // Size: the pack's people are ~1.8 m already; scale to 1.78 m with the soles at y = 0.
  lo.Idle_Gun.setEffectiveWeight(1); up.Idle_Gun_Pointing.setEffectiveWeight(1);
  mixer.update(0);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const h = box.max.y - box.min.y;
  if (h > 0.5 && h < 5) { model.scale.multiplyScalar(1.78 / h); }
  holder.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(model, true);
  model.position.y -= box2.min.y - holder.getWorldPosition(_a).y;
  holder.updateMatrixWorld(true);
  // Leg and arm chain lengths, and where the foot / wrist sits in its lower bone (for the IK).
  const tip = (lower, end) => lower.worldToLocal(end.getWorldPosition(V()));
  const legs = ['L', 'R'].map((s) => ({ up: B[`UpperLeg${s}`], lo: B[`LowerLeg${s}`], foot: B[`Foot${s}`], tip: tip(B[`LowerLeg${s}`], B[`Foot${s}`]) }));
  const arms = ['R', 'L'].map((s) => ({ up: B[`UpperArm${s}`], lo: B[`LowerArm${s}`], wrist: B[`Wrist${s}`], tip: B[`Wrist${s}`].position.clone() }));
  // How the right hand sits holding a gun that points straight ahead (from the pointing clip),
  // relative to the body; the left hand is its mirror image.
  const rootQ = holder.getWorldQuaternion(V4());
  const handR = rootQ.clone().invert().multiply(B.WristR.getWorldQuaternion(V4()));
  const handL = new THREE.Quaternion(handR.x, -handR.y, -handR.z, handR.w);
  for (const m of model.children) m.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingSphere(); o.boundingSphere.radius *= 1.8; } });
  return { model, mixer, B, lo, up, legs, arms, rest, fingers, hands: [handR, handL], t: Math.random() * 10, phase: 0, ck: 0, sk: 0, ak: 0, w: {}, skip: 0 };
}
function V4() { return new THREE.Quaternion(); }

/** Hang `obj` from a bone so it keeps the place it has now in the holder (anchors for slung guns). */
export function hangFrom(rig, boneName, holder, charPos) {
  const bone = rig.B[boneName];
  const anchor = new THREE.Object3D();
  holder.updateMatrixWorld(true);
  _m.copy(bone.matrixWorld).invert().multiply(holder.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(charPos[0], charPos[1], charPos[2]));
  _m.decompose(anchor.position, anchor.quaternion, anchor.scale);
  bone.add(anchor);
  return anchor;
}

/** Turn a bone so that, in the world, it rotates by quaternion q (about its own origin). */
function turnWorld(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  _q2.copy(_pq).invert().multiply(q).multiply(_pq);
  bone.quaternion.premultiply(_q2);
  bone.updateMatrixWorld(true);
}
/** Two-bone IK: bend upper `a` and lower `b` so b's tip (`tipLocal`, in b's space) reaches `target`, the joint bending toward `pole`. */
function ik2(a, b, tipLocal, target, pole) {
  a.getWorldPosition(_a); b.getWorldPosition(_b); _c.copy(tipLocal); b.localToWorld(_c);
  const la = _a.distanceTo(_b), lb = _b.distanceTo(_c);
  _d.subVectors(target, _a);
  const dist = Math.max(Math.abs(la - lb) + 1e-4, Math.min(la + lb - 1e-4, _d.length()));
  _d.normalize();
  _p.subVectors(pole, _a); _p.addScaledVector(_d, -_p.dot(_d));
  if (_p.lengthSq() < 1e-8) return;
  _p.normalize();
  const cosA = Math.max(-1, Math.min(1, (la * la + dist * dist - lb * lb) / (2 * la * dist)));
  _t.copy(_a).addScaledVector(_d, la * cosA).addScaledVector(_p, la * Math.sqrt(1 - cosA * cosA));   // where the knee/elbow should go
  _x.subVectors(_b, _a).normalize(); _q.setFromUnitVectors(_x, _t.sub(_a).normalize()); turnWorld(a, _q);
  b.getWorldPosition(_b); _c.copy(tipLocal); b.localToWorld(_c);
  _t.copy(_a).addScaledVector(_d, dist);
  _x.subVectors(_c, _b).normalize(); _q.setFromUnitVectors(_x, _t.sub(_b).normalize()); turnWorld(b, _q);
}
/** Set a bone's world rotation. */
function setWorldQuat(bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * One frame for one person. `st`: { speed, fwd, side (m/s, along the facing and to its left),
 * crouch, seated, armed, pitch, detail (0 far … 1 near) }. Returns whether the fine work (IK) is on.
 */
export function animatePerson(holder, rig, st, dt) {
  const { lo, up, B } = rig;
  // Far away: animate less often.
  rig.skip += dt;
  if (st.detail < 0.35 && rig.skip < 0.05) return st.detail >= 0.2;
  dt = rig.skip; rig.skip = 0;
  rig.t += dt;
  const ease = Math.min(1, dt * 10);
  rig.ck += ((st.crouch ? 1 : 0) - rig.ck) * ease;
  rig.sk += ((st.seated ? 1 : 0) - rig.sk) * Math.min(1, dt * 14);
  rig.ak += ((st.armed ? 1 : 0) - rig.ak) * ease;
  // Legs: which way and how fast. Everything moving shares one stride phase so feet stay in step.
  const s = st.seated ? 0 : st.speed;
  const moveK = smooth(0.25, 1.1, s), runK = smooth(2.0, 2.4, s);   // walk or run, not a mix of the two
  // One direction clip at a time (forward, back, strafe left or right: mixing two at once tangles the
  // legs, their steps don't line up); the hips turn toward where you're really going, the chest keeps
  // facing the aim. A little hysteresis so the clip doesn't flicker on the 60° lines.
  const ang = Math.atan2(st.side, st.fwd), D = Math.PI / 180;
  if (moveK > 0.05) {
    const lim = (sec) => (sec === 'f' ? 60 : sec === 'b' ? 120 : 0) * D;
    const deg = Math.abs(ang), cur = rig.sector || 'f', h = 8 * D;
    let sec = deg < 60 * D ? 'f' : deg > 120 * D ? 'b' : ang > 0 ? 'l' : 'r';
    if (cur === 'f' && deg < lim('f') + h) sec = 'f';
    else if (cur === 'b' && deg > lim('b') - h) sec = 'b';
    else if ((cur === 'l' || cur === 'r') && deg > 60 * D - h && deg < 120 * D + h && Math.sign(ang) === (cur === 'l' ? 1 : -1)) sec = cur;
    rig.sector = sec;
  }
  const sec = rig.sector || 'f';
  const aim = { f: 0, l: Math.PI / 2, r: -Math.PI / 2, b: Math.PI }[sec];
  let hipT = Math.atan2(Math.sin(ang - aim), Math.cos(ang - aim)) * moveK;
  hipT = Math.max(-1.0, Math.min(1.0, hipT));
  rig.hy = (rig.hy || 0) + (hipT - (rig.hy || 0)) * Math.min(1, dt * 8);
  const want = { Walk: 0, Run: 0, Run_Back: 0, Run_Left: 0, Run_Right: 0 };
  if (sec === 'f') { want.Walk = moveK * (1 - runK); want.Run = moveK * runK; }
  else want[{ b: 'Run_Back', l: 'Run_Left', r: 'Run_Right' }[sec]] = moveK;
  rig.phase = (rig.phase + dt * (s < 1.6 ? s / 1.5 : s / (2.4 + 0.25 * s))) % 1;
  const idleW = 1 - moveK;
  const w = rig.w;
  for (const n of LOCO) { w[n] = (w[n] ?? 0) + (want[n] - (w[n] ?? 0)) * Math.min(1, dt * 14); lo[n].setEffectiveWeight(w[n]); lo[n].time = rig.phase * lo[n].getClip().duration; }
  lo.Idle_Gun.setEffectiveWeight(idleW * rig.ak); lo.Idle_Neutral.setEffectiveWeight(idleW * (1 - rig.ak));
  for (const n of IDLES) lo[n].time = rig.t % lo[n].getClip().duration;
  // Upper body: holding a gun, or arms swinging with the legs.
  up.Idle_Gun_Pointing.setEffectiveWeight(rig.ak); up.Idle_Gun_Pointing.time = rig.t % up.Idle_Gun_Pointing.getClip().duration;
  up.Idle_Neutral.setEffectiveWeight(idleW * (1 - rig.ak)); up.Idle_Neutral.time = lo.Idle_Neutral.time;
  for (const n of LOCO) { up[n].setEffectiveWeight(w[n] * (1 - rig.ak)); up[n].time = lo[n].time; }
  for (const [bone, p, q] of rig.rest) { bone.position.copy(p); bone.quaternion.copy(q); }
  rig.mixer.update(0);
  holder.updateMatrixWorld(true);
  if (st.detail < 0.2) return false;   // a long way off: the clips are enough

  // Hips toward the way you're going: the whole lower body (feet included) turns, the chest turns back.
  if (Math.abs(rig.hy) > 0.003 && !st.seated) {
    const up = V().set(0, 1, 0);
    _q.setFromAxisAngle(up, rig.hy); turnWorld(B.Root, _q);
    _q.setFromAxisAngle(up, -rig.hy * 0.85); turnWorld(B.Abdomen, _q);
  }
  // In code: the hips drop to crouch or sit, the feet stay put (or go forward to sit), the legs bend to suit.
  const right = _x.set(-1, 0, 0).transformDirection(holder.matrixWorld).clone();
  const fwd = V().set(0, 0, 1).transformDirection(holder.matrixWorld);
  const drop = 0.36 * rig.ck + 0.42 * rig.sk;
  if (drop > 0.002) {
    const body = B.Body;
    body.getWorldPosition(_a);
    _b.copy(_a).addScaledVector(fwd, -0.06 * rig.ck); _b.y -= drop;
    body.parent.worldToLocal(_b); body.parent.worldToLocal(_a);
    body.position.add(_b.sub(_a));
    body.updateMatrixWorld(true);
    if (rig.sk > 0.01) for (const lg of rig.legs) {
      lg.foot.getWorldPosition(_a); _b.copy(_a).addScaledVector(fwd, 0.42 * rig.sk); _b.y += 0.05 * rig.sk;
      lg.foot.parent.worldToLocal(_b); lg.foot.parent.worldToLocal(_a); lg.foot.position.add(_b.sub(_a)); lg.foot.updateMatrixWorld(true);
    }
  }
  // Every frame the shins are brought to the feet. The pack's feet are their own bones; blending the
  // run, strafe and walk clips (or just playing them) lets a foot drift off the end of its shin, which
  // looks like a broken ankle. The knee keeps the bend the clip gave it (further forward when crouched).
  const bendFwd = 0.4 + 1.6 * Math.max(rig.ck, rig.sk);
  for (const lg of rig.legs) {
    const knee = lg.lo.getWorldPosition(V()).addScaledVector(fwd, bendFwd);
    if (rig.ck > 0.01 || rig.sk > 0.01) knee.y += 0.6 * Math.max(rig.ck, rig.sk);
    ik2(lg.up, lg.lo, lg.tip, lg.foot.getWorldPosition(V()), knee);
  }
  // The spine follows the aim (and leans in a little when crouched).
  const pitch = Math.max(-1.1, Math.min(1.1, st.pitch || 0)) * rig.ak;
  const lean = 0.18 * rig.ck;
  for (const [bone, share] of [[B.Abdomen, 0.2], [B.Chest, 0.35], [B.Neck, 0.3]]) { _q.setFromAxisAngle(right, -pitch * share + lean * (bone === B.Neck ? -1 : 0.5)); turnWorld(bone, _q); }
  return true;
}

/** Where the chest is, in the holder's own space (the gun hangs off it). */
export function chestAt(holder, rig, out) {
  rig.B.Chest.getWorldPosition(out);
  return holder.worldToLocal(out);
}

/** Both hands onto the held gun: right on the grip, left on the handguard (or on `leftTo`, say the
 *  magazine during a reload). */
export function handsOnGun(holder, rig, gun, leftTo = null) {
  if (!gun || rig.ak < 0.5 || !gun.userData.grip) return;
  gun.updateWorldMatrix(true, false);
  const right = V().set(-1, 0, 0).transformDirection(holder.matrixWorld), fwd = V().set(0, 0, 1).transformDirection(holder.matrixWorld);
  const gq = gun.getWorldQuaternion(V4());
  const back = V().set(0, 0, -1).transformDirection(gun.matrixWorld), gdown = V().set(0, -1, 0).transformDirection(gun.matrixWorld);
  const grip = gun.localToWorld(gun.userData.grip.clone()).addScaledVector(back, 0.05).addScaledVector(gdown, 0.02);
  const fore = leftTo ? leftTo.clone() : gun.localToWorld((gun.userData.fore || gun.userData.grip).clone()).addScaledVector(gdown, 0.03);
  const down = V().set(0, -1, 0);
  const [R, L] = rig.arms;
  ik2(R.up, R.lo, R.tip, grip, grip.clone().addScaledVector(right, 0.6).addScaledVector(down, 0.8).addScaledVector(fwd, -0.3));
  setWorldQuat(R.wrist, gq.clone().multiply(rig.hands[0]));
  ik2(L.up, L.lo, L.tip, fore, fore.clone().addScaledVector(right, -0.7).addScaledVector(down, 0.9));
  setWorldQuat(L.wrist, gq.clone().multiply(rig.hands[1]));
  // Fingers closed round the grip and the handguard.
  const gx = V().set(1, 0, 0).transformDirection(gun.matrixWorld);
  curl(rig.fingers[0], gx, CURL.r); curl(rig.fingers[1], gx, CURL.l);
}
export const CURL = { r: 0.9, l: 0.9 };
function curl(hand, axis, angle) {
  for (const chain of hand) for (const b of chain) { _q.setFromAxisAngle(axis, angle); turnWorld(b, _q); }
}
