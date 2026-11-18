// People: realistic rigged, skinned characters (Mixamo: three SWAT officers and three civilians)
// driven by a full set of rifle animations (8-way walk, run and crouch-walk, sprint, aiming idle,
// crouching idle). Every Mixamo character shares one skeleton, so the clips are loaded once and
// drive anyone. See client/models/people/CREDITS.md and tools/build_people.mjs.
//
// What plays: one locomotion clip at a time for the way the person is really moving (the nearest of
// eight directions, the hips turned the last few degrees toward it), cross-faded as that changes,
// all kept in step on one stride phase; walk, jog or sprint by speed; the crouching set when
// crouched. Done here in code on top: looking up and down (the spine follows the aim), sitting in a
// ride (the hips drop and the legs bend to keep the feet planted, by IK), and both hands on whatever
// gun is held (arm IK to the grip and the handguard), so reloads and recoil move the hands too.
import * as THREE from 'three';
import { GLTFLoader } from '/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '/addons/utils/SkeletonUtils.js';

export const OUTFITS = ['swat1', 'swat2', 'swat3', 'james', 'liza', 'remy'];
const loader = new GLTFLoader();
const files = new Map();
const load = (name) => { if (!files.has(name)) files.set(name, loader.loadAsync(`/models/people/${name}.glb`)); return files.get(name); };

let CLIPS = null;
const clipsReady = load('anims').then((g) => { CLIPS = {}; for (const c of g.animations) CLIPS[c.name] = c; });
/** Start fetching the clips and the usual outfits early. */
export function preloadPeople(list = ['swat1']) { for (const n of list) load(n).catch(() => {}); return clipsReady; }

const DIRS = ['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'];   // counter-clockwise from ahead, 45° apart
const GAITS = ['walk', 'run', 'cwalk'];
const IDLES = ['aim', 'hold', 'idle', 'crouch'];
// Metres covered in one cycle of each gait's clip: the clip plays as fast as the person moves.
const STRIDE = { walk: 2.0, run: 2.8, sprint: 3.8, cwalk: 2.0 };
// The old bone names the rest of the game uses (slung guns hang off "Chest", the holster off "UpperLegR").
const ALIAS = { Root: 'Hips', Body: 'Hips', Abdomen: 'Spine', Chest: 'Spine2', Neck: 'Neck', Head: 'Head',
  UpperLegL: 'LeftUpLeg', UpperLegR: 'RightUpLeg', LowerLegL: 'LeftLeg', LowerLegR: 'RightLeg', FootL: 'LeftFoot', FootR: 'RightFoot',
  UpperArmL: 'LeftArm', UpperArmR: 'RightArm', LowerArmL: 'LeftForeArm', LowerArmR: 'RightForeArm', WristL: 'LeftHand', WristR: 'RightHand' };

/**
 * Put a person in `holder` (a Group whose +Z is forward, feet at y = 0). `opts`: { onReady(rig),
 * onFail() }. Resolves to the rig.
 */
export function attachPerson(holder, outfit, opts = {}) {
  return Promise.all([load(outfit), clipsReady]).then(([gltf]) => {
    if (holder.userData.disposed) return null;
    const model = cloneSkinned(gltf.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material.clone();
      m.metalness = 0; m.roughness = Math.max(m.roughness, 0.7);   // no environment map out here: shiny reads as black
      // A little lift (from the texture itself), so dark gear isn't a silhouette with the sun behind it.
      if (m.map) { m.emissiveMap = m.map; m.emissive.setScalar(0.16); }
      if (opts.dye != null && m.map && !/hair|lash|head/i.test(m.name)) dyeClothes(m, opts.dye);
      o.material = m;
      o.castShadow = true;
      o.frustumCulled = true;
    });
    holder.add(model);
    const rig = setupRig(holder, model);
    opts.onReady?.(rig);
    return rig;
  }).catch((e) => { console.warn('person', outfit, e); opts.onFail?.(); return null; });
}

/**
 * Clothes in a colour of your choosing (the wardrobe): every texel that isn't skin takes the colour,
 * keeping the texture's light and shade (folds, straps, pockets). Skin is told apart by its hue: warm,
 * red over green over blue, not grey and not too strong. Hair and faces are other materials, left be.
 */
function dyeClothes(m, hex) {
  const dye = { value: new THREE.Color(hex) };
  m.emissiveMap = null;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDye = dye;
    sh.fragmentShader = 'uniform vec3 uDye;\n' + sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 c = diffuseColor.rgb, g = sqrt(c);   // (judged near how it looks on screen)
          float mx = max(g.r, max(g.g, g.b)), mn = min(g.r, min(g.g, g.b));
          float sat = (mx - mn) / max(mx, 1e-4);
          float warm = step(g.b, g.g) * step(g.g, g.r) * smoothstep(0.14, 0.24, sat) * (1.0 - smoothstep(0.82, 0.92, sat)) * smoothstep(0.12, 0.22, mx);
          float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
          vec3 dyed = uDye * (0.3 + 1.2 * l);
          diffuseColor.rgb = mix(dyed, c, warm);
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance = diffuseColor.rgb * 0.16;');
  };
  m.customProgramCacheKey = () => 'dye';
}

// Scratch objects (no garbage in the frame loop).
const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _t = V(), _d = V(), _p = V(), _x = V(), _up = V().set(0, 1, 0), _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

function setupRig(holder, model) {
  const B = {};
  model.traverse((o) => { if (o.isBone) B[o.name.replace(/^mixamorig:?/, '')] = o; });
  for (const [old, now] of Object.entries(ALIAS)) if (B[now]) B[old] = B[now];
  // The bones this file moves by hand go back to their rest pose every frame before the clips play
  // (a clip that doesn't key a bone would otherwise leave last frame's change on it to pile up).
  const rest = [];
  for (const n of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'])
    if (B[n]) rest.push([B[n], B[n].position.clone(), B[n].quaternion.clone()]);
  const mixer = new THREE.AnimationMixer(model);
  const acts = {};
  const act = (name) => { const c = CLIPS[name]; if (!c) return; const a = mixer.clipAction(c); a.play(); a.timeScale = 0; a.setEffectiveWeight(0); acts[name] = a; };
  for (const g of GAITS) for (const d of DIRS) act(`${g}_${d}`);
  for (const n of [...IDLES, 'sprint']) act(n);
  // Size: 1.78 m standing, the soles at y = 0.
  acts.aim.setEffectiveWeight(1);
  mixer.update(0);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const h = box.max.y - box.min.y;
  if (h > 0.5 && h < 5) model.scale.multiplyScalar(1.78 / h);
  holder.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(model, true);
  model.position.y -= box2.min.y - holder.getWorldPosition(_a).y;
  holder.updateMatrixWorld(true);
  // Leg and arm chains, and where the foot / hand sits in its lower bone (for the IK).
  const tip = (lower, end) => lower.worldToLocal(end.getWorldPosition(V()));
  const legs = ['Left', 'Right'].map((s) => ({ up: B[`${s}UpLeg`], lo: B[`${s}Leg`], foot: B[`${s}Foot`], tip: tip(B[`${s}Leg`], B[`${s}Foot`]) }));
  const arms = ['Right', 'Left'].map((s) => ({ up: B[`${s}Arm`], lo: B[`${s}ForeArm`], wrist: B[`${s}Hand`], tip: B[`${s}Hand`].position.clone() }));
  // How each hand sits on a rifle pointing straight ahead (from the aiming clip), relative to the body.
  const rootQ = holder.getWorldQuaternion(new THREE.Quaternion()).invert();
  const hands = arms.map((a) => rootQ.clone().multiply(a.wrist.getWorldQuaternion(new THREE.Quaternion())));
  acts.aim.setEffectiveWeight(0);
  for (const m of model.children) m.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingSphere(); o.boundingSphere.radius *= 1.8; } });
  return { model, mixer, B, acts, legs, arms, rest, hands, t: Math.random() * 10, phase: 0, ck: 0, sk: 0, ak: 0, w: {}, skip: 0, cur: 'aim' };
}

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
  const { acts, B } = rig;
  // Far away: animate less often.
  rig.skip += dt;
  if (st.detail < 0.35 && rig.skip < 0.05) return st.detail >= 0.2;
  dt = rig.skip; rig.skip = 0;
  rig.t += dt;
  const ease = Math.min(1, dt * 10);
  rig.ck += ((st.crouch ? 1 : 0) - rig.ck) * ease;
  rig.sk += ((st.seated ? 1 : 0) - rig.sk) * Math.min(1, dt * 14);
  rig.ak += ((st.armed ? 1 : 0) - rig.ak) * ease;
  const s = st.seated ? 0 : st.speed;
  const moving = s > (rig.cur.includes('_') || rig.cur === 'sprint' ? 0.25 : 0.45);   // a little hysteresis on starting and stopping
  // Which of the eight directions (a little hysteresis so it doesn't flicker on the lines between).
  const ang = Math.atan2(st.side, st.fwd), D = Math.PI / 4;
  if (moving) {
    let k = ((Math.round(ang / D) % 8) + 8) % 8;
    const prev = rig.dir ?? k, off = Math.atan2(Math.sin(ang - prev * D), Math.cos(ang - prev * D));
    if (Math.abs(off) < D / 2 + 0.14) k = prev;
    rig.dir = k;
  }
  const dir = rig.dir ?? 0;
  // The hips turn the rest of the way toward where you're really going; the chest keeps facing the aim.
  // Which clip: crouch-walk, walk, jog or sprint by speed; standing still, aiming or just holding.
  const crouch = st.crouch && !st.seated;
  // (one switch point, with room either side, so a run starting or easing off changes clip once)
  let gait = crouch ? 'cwalk' : s < (rig.gait === 'run' || rig.gait === 'sprint' ? 2.6 : 3.1) ? 'walk' : 'run';
  // Straight ahead: a walk, then the rifle jog for a part-way push, then the upright run (the sprint
  // clip at your pace) for the stick all the way and a sprint. So each pace looks like what it is.
  const fast = s > (rig.gait === 'sprint' ? 5.0 : 5.6);
  const want = !moving ? (crouch ? 'crouch' : !st.armed ? 'idle' : st.aiming ? 'aim' : 'hold')   // standing tall unless aiming or shooting
    : gait === 'run' && fast && (DIRS[dir] === 'f' || DIRS[dir] === 'fl' || DIRS[dir] === 'fr') ? 'sprint' : `${gait}_${DIRS[dir]}`;
  if (want === 'sprint') gait = 'sprint';
  rig.gait = gait; rig.cur = want;
  // (the run straight ahead also covers the diagonals ahead: the hips turn the whole way toward them)
  const hipT = !moving ? 0 : want === 'sprint' ? Math.max(-0.85, Math.min(0.85, ang)) : Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(ang - dir * D), Math.cos(ang - dir * D))));
  rig.hy = (rig.hy || 0) + (hipT - (rig.hy || 0)) * Math.min(1, dt * 8);
  // One stride phase for every locomotion clip, so changing direction or speed keeps the feet in step.
  // (a longer stride the faster you go, as a runner's is)
  if (moving) rig.phase = (rig.phase + dt * s / (gait === 'sprint' ? 2.9 + 0.17 * s : STRIDE[gait])) % 1;
  const w = rig.w, fade = Math.min(1, dt * 9);
  for (const [n, a] of Object.entries(acts)) {
    const target = n === want ? 1 : 0;
    const wn = w[n] = (w[n] ?? 0) + (target - (w[n] ?? 0)) * fade;
    a.setEffectiveWeight(wn < 0.002 ? 0 : wn);
    if (wn < 0.002) continue;
    const dur = a.getClip().duration;
    a.time = n.includes('_') || n === 'sprint' ? rig.phase * dur : rig.t % dur;
  }
  for (const [bone, p, q] of rig.rest) { bone.position.copy(p); bone.quaternion.copy(q); }
  rig.mixer.update(0);
  holder.updateMatrixWorld(true);
  if (st.detail < 0.2) return false;   // a long way off: the clips are enough

  // Hips toward the way you're going: the whole lower body (feet included) turns, the chest turns back.
  if (Math.abs(rig.hy) > 0.003) {
    _q.setFromAxisAngle(_up, rig.hy); turnWorld(B.Hips, _q);
    _q.setFromAxisAngle(_up, -rig.hy * 0.9); turnWorld(B.Spine, _q);
  }
  const right = _x.set(-1, 0, 0).transformDirection(holder.matrixWorld).clone();
  const fwd = V().set(0, 0, 1).transformDirection(holder.matrixWorld);
  // Sitting in a ride: the hips drop, the feet go forward, the legs bend to suit.
  if (rig.sk > 0.01) {
    const drop = 0.42 * rig.sk;
    const hips = B.Hips;
    hips.getWorldPosition(_a);
    _b.copy(_a); _b.y -= drop;
    hips.parent.worldToLocal(_b); hips.parent.worldToLocal(_a);
    hips.position.add(_b.sub(_a));
    hips.updateMatrixWorld(true);
    for (const lg of rig.legs) {
      const foot = lg.foot.getWorldPosition(V()).addScaledVector(fwd, 0.42 * rig.sk); foot.y += 0.05 * rig.sk + drop;
      const knee = lg.lo.getWorldPosition(V()).addScaledVector(fwd, 1.6); knee.y += 0.6;
      ik2(lg.up, lg.lo, lg.tip, foot, knee);
    }
  }
  // The spine follows the aim.
  const pitch = Math.max(-1.1, Math.min(1.1, st.pitch || 0)) * rig.ak;
  if (Math.abs(pitch) > 0.002) for (const [bone, share] of [[B.Spine, 0.25], [B.Spine1, 0.3], [B.Spine2, 0.3], [B.Neck, 0.15]]) { _q.setFromAxisAngle(right, pitch * share); turnWorld(bone, _q); }   // (about the right-hand side: + tips the chest up)
  return true;
}

/** Where the chest is, in the holder's own space (the gun hangs off it). */
export function chestAt(holder, rig, out) {
  rig.B.Spine2.getWorldPosition(out);
  return holder.worldToLocal(out);
}

/** Both hands onto the held gun: right on the grip, left on the handguard (or on `leftTo`, say the
 *  magazine during a reload). The clips already close the fingers round a rifle. */
export function handsOnGun(holder, rig, gun, leftTo = null) {
  if (!gun || rig.ak < 0.5 || !gun.userData.grip) return;
  gun.updateWorldMatrix(true, false);
  const right = V().set(-1, 0, 0).transformDirection(holder.matrixWorld), fwd = V().set(0, 0, 1).transformDirection(holder.matrixWorld);
  const gq = gun.getWorldQuaternion(new THREE.Quaternion());
  const back = V().set(0, 0, -1).transformDirection(gun.matrixWorld), gdown = V().set(0, -1, 0).transformDirection(gun.matrixWorld);
  const grip = gun.localToWorld(gun.userData.grip.clone()).addScaledVector(back, 0.05).addScaledVector(gdown, 0.03);
  // A pistol: the left hand wraps round the right on the grip (there's no handguard to hold).
  const pistol = gun.userData.archetype === 'sidearm';
  const fore = leftTo ? leftTo.clone() : pistol ? grip.clone().addScaledVector(right, -0.045).addScaledVector(gdown, 0.015).addScaledVector(back, -0.01)
    : gun.localToWorld((gun.userData.fore || gun.userData.grip).clone()).addScaledVector(gdown, 0.04);
  const down = V().set(0, -1, 0);
  const [R, L] = rig.arms;
  ik2(R.up, R.lo, R.tip, grip, grip.clone().addScaledVector(right, 0.6).addScaledVector(down, 0.8).addScaledVector(fwd, -0.3));
  setWorldQuat(R.wrist, gq.clone().multiply(rig.hands[0]));
  ik2(L.up, L.lo, L.tip, fore, fore.clone().addScaledVector(right, -0.7).addScaledVector(down, 0.9));
  setWorldQuat(L.wrist, gq.clone().multiply(rig.hands[1]));
}
export const CURL = { r: 0, l: 0 };

/** Taking a hit: the chest knocked back and twisted to one side (`k` 0…1…0 over the flinch). */
export function flinch(holder, rig, k, side = 1) {
  if (k <= 0.001) return;
  const { B } = rig;
  const right = V().set(-1, 0, 0).transformDirection(holder.matrixWorld);
  _q.setFromAxisAngle(right, -0.22 * k); turnWorld(B.Spine1, _q);
  _q.setFromAxisAngle(_up, 0.18 * k * side); turnWorld(B.Spine2, _q);
  _q.setFromAxisAngle(right, -0.12 * k); turnWorld(B.Neck, _q);
}

/** Hands on a steering wheel, handlebars or reins: right hand to `R`, left to `L` (world points),
 *  elbows bent down and out. */
export function handsOnBars(holder, rig, R, L) {
  holder.updateMatrixWorld(true);
  const right = V().set(-1, 0, 0).transformDirection(holder.matrixWorld), down = V().set(0, -1, 0), back = V().set(0, 0, -1).transformDirection(holder.matrixWorld);
  const [AR, AL] = rig.arms;
  ik2(AR.up, AR.lo, AR.tip, R, R.clone().addScaledVector(right, 0.7).addScaledVector(down, 0.8).addScaledVector(back, 0.4));
  ik2(AL.up, AL.lo, AL.tip, L, L.clone().addScaledVector(right, -0.7).addScaledVector(down, 0.8).addScaledVector(back, 0.4));
}

/**
 * Doing something with your hands instead of holding the gun: kneeling at a locker, driving in a claim
 * flag, a flare held up, working a tablet, reviving someone, hammering, fishing. `pose` (actions.js):
 * { kneel, lean, R(t, p), L(t, p) } where R and L give each hand's target in the holder's own space
 * (+Z ahead, +X to the left, metres above the soles), t is seconds into it and p how far along (0 … 1).
 * Call after animatePerson (with crouch set for a kneeling pose). Returns the two hands' world points.
 */
export function poseAction(holder, rig, pose, t, p) {
  const { B } = rig;
  holder.updateMatrixWorld(true);
  const right = V().set(-1, 0, 0).transformDirection(holder.matrixWorld), fwd = V().set(0, 0, 1).transformDirection(holder.matrixWorld);
  const down = V().set(0, -1, 0);
  const at = (x, y, z) => holder.localToWorld(V().set(x, y, z));
  if (pose.kneel) {
    // Down on the right knee: the hips lower, the right shin flat behind, the left foot planted ahead.
    const hips = B.Hips;
    hips.getWorldPosition(_a);
    const want = holder.localToWorld(V().set(0, 0.62, 0.02));
    _b.copy(_a); _b.y = Math.min(_a.y, want.y);
    hips.parent.worldToLocal(_b); hips.parent.worldToLocal(_a);
    hips.position.add(_b.sub(_a));
    hips.updateMatrixWorld(true);
    const [L, R] = rig.legs;
    ik2(R.up, R.lo, R.tip, at(-0.11, 0.1, -0.42), at(-0.12, 0.05, 1.5));     // right knee on the ground
    ik2(L.up, L.lo, L.tip, at(0.13, 0.08, 0.32), at(0.14, 1.2, 1.6));        // left knee up
  }
  if (pose.lean) for (const [bone, share] of [[B.Spine, 0.35], [B.Spine1, 0.35], [B.Spine2, 0.3]]) { _q.setFromAxisAngle(right, -pose.lean * share); turnWorld(bone, _q); }
  if (pose.look) { _q.setFromAxisAngle(right, -pose.look); turnWorld(B.Neck, _q); }
  const [AR, AL] = rig.arms;
  const r = pose.R(t, p), l = pose.L(t, p);
  const rw = at(...r), lw = at(...l);
  ik2(AR.up, AR.lo, AR.tip, rw, rw.clone().addScaledVector(right, 0.7).addScaledVector(down, pose.elbowUp ? -0.6 : 0.8).addScaledVector(fwd, -0.3));
  ik2(AL.up, AL.lo, AL.tip, lw, lw.clone().addScaledVector(right, -0.7).addScaledVector(down, pose.elbowUp ? -0.2 : 0.8).addScaledVector(fwd, -0.3));
  return [AR.wrist.getWorldPosition(V()), AL.wrist.getWorldPosition(V())];
}
