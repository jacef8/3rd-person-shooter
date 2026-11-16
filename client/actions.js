// What a person looks like while doing something that takes a while: the pose (people.js poseAction)
// and the thing in their hands. Seen by everyone: your own actions from your own progress bar, other
// players' from the snapshot (`act`, `ap`).
//
//   pry      kneeling with a crowbar: lockers, crates, supply drops, base break-ins, disarming a mine
//   plant    driving a claim flag into the ground
//   flare    a burning flare held up overhead for the helicopter
//   tablet   working a hacking tablet: terminals, locks, data hacks, hotwiring
//   revive   kneeling over someone with a medkit
//   hammer   building, upgrading, rebuilding, gathering
//   cook     kneeling, stirring a pan
//   fish     a rod out over the water
// Hand targets are in the person's own space: +Z ahead, +X to their left, metres above the soles.
import * as THREE from 'three';
import { poseAction } from '/people.js';

/** Which pose each timed action uses (the server's hack kinds, plus the flare gesture). */
export const ACT_POSE = {
  breakbox: 'pry', crate: 'pry', drop: 'pry', hotcrate: 'pry', raid: 'pry', disarm: 'pry',
  claim: 'plant', claimBuilding: 'plant',
  flare: 'flare', hotflare: 'flare',
  terminal: 'tablet', door: 'tablet', gatehack: 'tablet', datahack: 'tablet', hotwire: 'tablet',
  revive: 'revive',
  upgrade: 'hammer', rebuild: 'hammer', harvest: 'hammer',
  cook: 'cook', fish: 'fish',
};

const S = Math.sin, PI = Math.PI;
const POSES = {
  // Two hands on the bar, levering: a few short heaves, then a big one.
  pry: { kneel: true, lean: 0.45, look: 0.25,
    R: (t) => { const h = Math.max(0, S(t * 4.2)) ** 2; return [-0.12, 0.42 + 0.12 * h, 0.5 - 0.05 * h]; },
    L: (t) => { const h = Math.max(0, S(t * 4.2)) ** 2; return [0.06, 0.36 + 0.1 * h, 0.58 - 0.04 * h]; } },
  // Both hands high on the pole, pushing it down; it sinks as the claim goes in.
  plant: { lean: 0.25, look: 0.2,
    R: (t, p) => [-0.03, 1.12 - 0.36 * p - 0.03 * Math.abs(S(t * 5)), 0.42],
    L: (t, p) => [0.03, 0.9 - 0.36 * p - 0.03 * Math.abs(S(t * 5)), 0.42] },
  // Right arm straight up with the flare, waving it slowly side to side; left hand at the hip.
  flare: { elbowUp: true, look: -0.35,
    R: (t) => [-0.2 + 0.12 * S(t * 3), 2.15, 0.12],
    L: () => [0.24, 0.92, 0.05] },
  // Tablet held at the chest, thumbs tapping.
  tablet: { lean: 0.1, look: 0.45,
    R: (t) => [-0.1, 1.08 + 0.012 * Math.max(0, S(t * 11)), 0.32],
    L: (t) => [0.1, 1.08 + 0.012 * Math.max(0, S(t * 9 + 1)), 0.32] },
  // Kneeling, both hands pressing on the person in front: steady compressions.
  revive: { kneel: true, lean: 0.55, look: 0.35,
    R: (t) => { const c = Math.max(0, S(t * 9)); return [-0.04, 0.38 - 0.06 * c, 0.55]; },
    L: (t) => { const c = Math.max(0, S(t * 9)); return [0.04, 0.4 - 0.06 * c, 0.55]; } },
  // Hammer swings in the right hand; the left steadies the work.
  hammer: { lean: 0.3, look: 0.3,
    R: (t) => { const a = (t * 2.2) % 1, up = a < 0.65 ? a / 0.65 : 1 - (a - 0.65) / 0.35; return [-0.2, 1.08 + 0.36 * up, 0.46 - 0.12 * up]; },
    L: () => [0.1, 1.0, 0.52] },
  // Kneeling at the fire, stirring.
  cook: { kneel: true, lean: 0.35, look: 0.3,
    R: (t) => [-0.08 + 0.07 * S(t * 3.5), 0.48, 0.5 + 0.07 * Math.cos(t * 3.5)],
    L: () => [0.14, 0.45, 0.5] },
  // Rod out ahead, the tip twitching now and then.
  fish: { look: 0.05,
    R: (t) => [-0.08, 1.05 + 0.03 * Math.max(0, S(t * 1.7)) ** 8, 0.38],
    L: () => [0.04, 1.12, 0.52] },
};

// ---- props: one small set per person, shared geometry and materials.
const M = (o) => new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.2, ...o });
const MAT = {
  steel: M({ color: 0x3a3f45, metalness: 0.6, roughness: 0.4 }), red: M({ color: 0xc0262d }), white: M({ color: 0xf2f2f2 }),
  wood: M({ color: 0x7a5432, roughness: 0.8 }), olive: M({ color: 0x4f5a3a, metalness: 0.4 }), dark: M({ color: 0x1d2024 }),
  flag: M({ color: 0xff7a1a, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 }),
  flareBody: M({ color: 0xb01818, emissive: 0x400000 }),
  flame: new THREE.MeshBasicMaterial({ color: 0xffd0b0 }),
  screen: new THREE.MeshBasicMaterial({ color: 0x4fd1c5 }),
  line: new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.6 }),
};
const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
const rod = (r, len, m) => { const g = new THREE.CylinderGeometry(r, r, len, 8); g.translate(0, len / 2, 0); return new THREE.Mesh(g, m); };
const glowTex = (() => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,240,220,1)'); gr.addColorStop(0.25, 'rgba(255,80,40,0.9)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function makeProps() {
  const P = {};
  // Crowbar: a bar with a bent claw at the far end.
  // (origin at the hands: the bar runs back past them and forward into the locker's seam)
  P.crowbar = new THREE.Group();
  const bar = rod(0.017, 0.66, MAT.steel); bar.position.z = -0.4; bar.rotation.x = PI / 2; P.crowbar.add(bar);
  const claw = rod(0.017, 0.09, MAT.steel); claw.position.z = 0.26; claw.rotation.x = PI * 0.8; P.crowbar.add(claw);
  // The locker being pried open, its lid hinged at the back.
  P.locker = new THREE.Group();
  P.locker.add(at(box(0.46, 0.26, 0.32, MAT.olive), 0, 0.13, 0));
  P.lid = new THREE.Group(); P.lid.position.set(0, 0.26, -0.16);
  P.lid.add(at(box(0.47, 0.04, 0.33, MAT.olive), 0, 0.02, 0.165));
  P.locker.add(P.lid);
  // Claim flag: pole and an orange flag that ripples.
  P.flag = new THREE.Group();
  P.flag.add(rod(0.018, 1.7, MAT.wood));
  const cloth = new THREE.PlaneGeometry(0.55, 0.36, 8, 1); cloth.translate(0.29, 0, 0);
  P.cloth = new THREE.Mesh(cloth, MAT.flag); P.cloth.position.y = 1.5; P.flag.add(P.cloth);
  P.clothBase = cloth.attributes.position.array.slice();
  // Flare: a red stick, a white-hot tip and a flickering glow (no light: adding one recompiles every material).
  P.flare = new THREE.Group();
  P.flare.add(rod(0.016, 0.24, MAT.flareBody));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 6), MAT.flame); tip.position.y = 0.25; P.flare.add(tip);
  if (glowTex) { P.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); P.glow.position.y = 0.27; P.flare.add(P.glow); }
  // Hacking tablet, screen up toward the face.
  P.tablet = new THREE.Group();
  P.tablet.add(box(0.24, 0.016, 0.16, MAT.dark));
  const scr = box(0.2, 0.004, 0.12, MAT.screen); scr.position.y = 0.01; P.tablet.add(scr);
  // Medkit beside the person being revived.
  P.medkit = new THREE.Group();
  P.medkit.add(at(box(0.32, 0.12, 0.22, MAT.red), 0, 0.06, 0));
  P.medkit.add(at(box(0.06, 0.005, 0.16, MAT.white), 0, 0.123, 0));
  P.medkit.add(at(box(0.16, 0.005, 0.06, MAT.white), 0, 0.123, 0));
  // Hammer: handle and head.
  P.hammer = new THREE.Group();
  P.hammer.add(rod(0.02, 0.42, MAT.wood));
  const head = box(0.16, 0.065, 0.065, MAT.steel); head.position.y = 0.4; P.hammer.add(head);
  // Pan for cooking.
  P.pan = new THREE.Group();
  const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.05, 14), MAT.dark); pan.position.y = 0.04; P.pan.add(pan);
  const handle = box(0.03, 0.02, 0.2, MAT.dark); handle.position.set(0, 0.06, -0.2); P.pan.add(handle);
  // Fishing rod and line.
  P.rod = new THREE.Group();
  const pole = rod(0.009, 2.1, MAT.dark); pole.rotation.x = PI / 2 - 0.55; P.rod.add(pole);
  P.rodTip = new THREE.Object3D(); P.rodTip.position.set(0, 2.1 * Math.cos(PI / 2 - 0.55), 2.1 * Math.sin(PI / 2 - 0.55)); P.rod.add(P.rodTip);
  P.lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  P.line = new THREE.Line(P.lineGeo, MAT.line); P.line.frustumCulled = false;
  for (const k of ['crowbar', 'locker', 'flag', 'flare', 'tablet', 'medkit', 'hammer', 'pan', 'rod', 'line']) { P[k].visible = false; P[k].traverse((o) => { if (o.isMesh) o.castShadow = true; }); }
  return P;
}
const PROPS_OF = { pry: ['crowbar'], plant: ['flag'], flare: ['flare'], tablet: ['tablet'], revive: ['medkit'], hammer: ['hammer'], cook: ['pan'], fish: ['rod', 'line'] };

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
/** Put a prop at a hand, turned with the person (yaw) plus its own tilt. */
function inHand(holder, prop, hand, rx, ry = 0, rz = 0) {
  holder.worldToLocal(_v.copy(hand));
  prop.position.copy(_v);
  prop.rotation.set(rx, ry, rz);
}

/**
 * One frame of an action for one person (`g`, the character holder with its rig). `kind`: the server's
 * action kind, or null when idle. `p`: how far along (0 … 1). Returns true while posed (keep the gun away).
 */
export function updateAction(g, kind, p, dt, extra = {}) {
  const u = g.userData;
  const pose = kind && POSES[ACT_POSE[kind]];
  if (!u.props && pose) { u.props = makeProps(); for (const k of Object.keys(u.props)) if (u.props[k]?.isObject3D && k !== 'line' && !u.props[k].parent) g.add(u.props[k]); if (g.parent) g.parent.add(u.props.line); }
  const P = u.props;
  if (P) {
    const show = pose ? new Set(PROPS_OF[ACT_POSE[kind]]) : new Set();
    if (kind === 'breakbox') show.add('locker');
    for (const k of ['crowbar', 'locker', 'flag', 'flare', 'tablet', 'medkit', 'hammer', 'pan', 'rod', 'line']) P[k].visible = show.has(k);
    if (!pose) { u.actT = 0; u.actKind = null; return false; }
  }
  if (!pose || !u.rig) return false;
  if (u.actKind !== kind) { u.actKind = kind; u.actT = 0; }
  u.actT += dt;
  const t = u.actT;
  const [R, L] = poseAction(g, u.rig, pose, t, p);
  const name = ACT_POSE[kind];
  if (name === 'pry') {
    // The bar from between the hands, down and forward into the locker's seam.
    holder2(g, R, L, _w);
    P.crowbar.position.copy(_w);
    const heave = Math.max(0, S(t * 4.2)) ** 2;
    P.crowbar.rotation.set(1.0 - 0.3 * heave, 0, 0);
    P.locker.position.set(0, 0, 0.72);
    P.locker.rotation.set(0, 0, 0);
    P.lid.rotation.x = p > 0.9 ? -Math.min(1.9, (p - 0.9) * 20) : -0.04 * heave;
  } else if (name === 'plant') {
    P.flag.position.set(0, -0.38 * p, 0.42);
    const a = P.cloth.geometry.attributes.position, base = P.clothBase;
    for (let i = 0; i < a.count; i++) { const x = base[i * 3]; a.array[i * 3 + 2] = Math.sin(x * 9 - t * 6) * 0.04 * x * 2; }
    a.needsUpdate = true;
  } else if (name === 'flare') {
    inHand(g, P.flare, R, 0.15, 0, 0);
    const flick = 0.75 + 0.25 * S(t * 37) * S(t * 23);
    if (P.glow) { const s = 0.5 + 0.2 * flick; P.glow.scale.set(s, s, s); }
  } else if (name === 'tablet') {
    holder2(g, R, L, _w); _w.y += 0.02; _w.z += 0.02;
    P.tablet.position.copy(_w);
    P.tablet.rotation.set(-0.7, 0, 0);
  } else if (name === 'revive') {
    P.medkit.position.set(0.38, 0, 0.42);
    P.medkit.rotation.set(0, 0.4, 0);
  } else if (name === 'hammer') {
    const a = (t * 2.2) % 1, up = a < 0.65 ? a / 0.65 : 1 - (a - 0.65) / 0.35;
    inHand(g, P.hammer, R, 0.9 + 1.0 * up, 0, 0.25);
  } else if (name === 'cook') {
    holder2(g, L, L, _w);
    P.pan.position.set(_w.x - 0.05, Math.max(0.02, _w.y - 0.12), _w.z + 0.05);
  } else if (name === 'fish') {
    holder2(g, R, L, _w);
    P.rod.position.copy(_w);
    P.rod.rotation.set(0, 0, 0);
    // The line hangs from the tip down to the water a little way out.
    g.updateMatrixWorld(true);
    P.rodTip.getWorldPosition(_v);
    const end = _w.set(_v.x, (extra.water ?? (g.position.y - 0.8)), _v.z);
    const arr = P.lineGeo.attributes.position.array;
    arr[0] = _v.x; arr[1] = _v.y; arr[2] = _v.z; arr[3] = end.x; arr[4] = end.y; arr[5] = end.z;
    P.lineGeo.attributes.position.needsUpdate = true;
  }
  return true;
}
/** The point midway between two hands, in the holder's space. */
function holder2(g, a, b, out) {
  out.copy(a).add(b).multiplyScalar(0.5);
  return g.worldToLocal(out);
}
/** Free a person's props (the line lives in the scene, not the holder). */
export function disposeActionProps(g) {
  const P = g.userData.props;
  if (P?.line?.parent) P.line.parent.remove(P.line);
}
