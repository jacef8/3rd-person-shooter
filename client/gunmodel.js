// Procedural weapon models built from gunsmith parts. The same builder is used for the gun in each
// character's hands and for the rotating (and explodable) preview in the gunsmith.
import * as THREE from 'three';
import { GLTFLoader } from '/addons/loaders/GLTFLoader.js';
import { PAINTS, DEFAULT_PARTS } from '/shared/items.js';

// Real gun models (Quaternius "Ultimate Guns", CC0; client/models/guns/CREDITS.md). Each archetype has
// a base gun; the gunsmith's optics, muzzle devices and underbarrel parts go on it at its own rail,
// bore and handguard. Measured off each model (fractions of its length from the back and of its
// height from the bottom): where the hand grips it, the handguard, the bore, the top rail, the
// magazine. len: real length in metres. Until they've loaded, the old built-from-boxes guns show.
const REAL = {
  carbine: { file: 'carbine', len: 0.84, grip: [0.317, 0.45], fore: [0.65, 0.69], bore: 0.76, rail: 0.855, optic: 0.40, mag: [0.475, 0.25] },
  smg:     { file: 'smg', len: 0.62, grip: [0.425, 0.44], fore: [0.78, 0.66], bore: 0.78, rail: 0.93, optic: 0.63, mag: [0.65, 0.23] },
  dmr:     { file: 'dmr', len: 1.1, grip: [0.30, 0.52], fore: [0.55, 0.68], bore: 0.85, rail: 0.91, optic: 0.41, mag: [0.334, 0.48] },   // a wood-stocked hunting rifle
  shotgun: { file: 'shotgun', len: 1.0, grip: [0.31, 0.44], fore: [0.70, 0.55], bore: 0.84, rail: 0.91, optic: 0.425, mag: [0.5, 0.6] },
  lmg:     { file: 'lmg', len: 0.98, grip: [0.067, 0.32], fore: [0.517, 0.6], bore: 0.70, rail: 0.82, optic: 0.25, mag: [0.27, 0.19] },
  sidearm: { file: 'sidearm', len: 0.19, grip: [0.18, 0.38], fore: [0.24, 0.3], bore: 0.94, rail: 0.99, optic: 0.5, mag: [0.18, 0.2] },
};
// Real guns inside a class (shared/data/arsenal.json "models"): their own model and measurements.
const REAL_MODEL = {
  ak47:   { file: 'ak47', len: 0.88, grip: [0.30, 0.46], fore: [0.68, 0.75], bore: 0.90, rail: 0.97, optic: 0.44, mag: [0.46, 0.34] },   // wood furniture
  mini14: { file: 'mini14', len: 0.95, grip: [0.30, 0.52], fore: [0.55, 0.68], bore: 0.85, rail: 0.91, optic: 0.41, mag: [0.334, 0.48] },   // synthetic stock
};
const realOf = (a, m) => REAL_MODEL[m] || REAL[a];
const PARTS3D = ['scope1', 'scope2', 'scope3', 'silencer', 'silencerShort', 'grip'];
const realScenes = {};
let realReady = false;
const loader = new GLTFLoader();
/** Fetch the real gun models (small, ~0.6 MB together). Resolves once they're in. */
export const gunModelsReady = Promise.all([...new Set([...Object.values(REAL), ...Object.values(REAL_MODEL)].map((r) => r.file)), ...PARTS3D].map((n) =>
  loader.loadAsync(`/models/guns/${n}.glb`).then((g) => { realScenes[n] = g.scene; })))
  .then(() => { realReady = true; }).catch((e) => console.warn('gun models', e));
/** A copy of a loaded model turned to lie along +Z (its muzzle / front at +Z), `len` metres long, with
 *  its bounding box from (−w/2, 0, 0) to (w/2, h, len) before `at` moves it. Returns [object, height]. */
function fitAlongZ(name, len) {
  const src = realScenes[name].clone();
  const holder = new THREE.Group();
  src.rotation.y = -Math.PI / 2;   // the pack's guns point along +X
  holder.add(src);
  holder.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(holder), size = b.getSize(new THREE.Vector3());
  const k = len / size.z;
  src.scale.setScalar(k);
  holder.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(holder);
  src.position.set(-(b2.min.x + b2.max.x) / 2, -b2.min.y, -b2.min.z);
  holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); } });
  return [holder, size.y * k];
}

const SIZE = {
  //          receiver len, barrel len, height
  sidearm: [0.20, 0.06, 0.10],
  smg:     [0.32, 0.14, 0.11],
  carbine: [0.40, 0.30, 0.11],
  shotgun: [0.42, 0.36, 0.12],
  dmr:     [0.46, 0.42, 0.11],
  lmg:     [0.52, 0.38, 0.14],
  launcher: [0.9, 0.1, 0.16],
};

const metal = (color = 0x1e1f21) => new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.45 });
const glass = (color = 0x3fa9ff, emissive = 0x0b3a66) => new THREE.MeshStandardMaterial({ color, emissive, metalness: 0.2, roughness: 0.1 });

function box(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
function cyl(r, len, mat, r2 = r) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 14), mat);
  m.rotation.x = Math.PI / 2;          // lie along +Z
  return m;
}
/** A tube sight: body, a flared front bell, a lens, and turrets if it's a proper scope. */
function scope(len, r, bell, lens = glass(), turrets = false) {
  const grp = new THREE.Group();
  grp.add(cyl(r, len, metal()));
  const front = cyl(bell, len * 0.22, metal(), r); front.position.z = len / 2 + len * 0.11; grp.add(front);
  const eye = cyl(r * 1.15, len * 0.16, metal()); eye.position.z = -len / 2 - len * 0.08; grp.add(eye);
  const l = cyl(bell * 0.96, 0.004, lens); l.position.z = len / 2 + len * 0.22; grp.add(l);
  if (turrets) { const t = box(0.022, 0.03, 0.022, metal()); t.position.y = r + 0.012; const s = box(0.03, 0.022, 0.022, metal()); s.position.x = r + 0.012; grp.add(t, s); }
  for (const z of [-len * 0.28, len * 0.28]) { const ring = box(r * 2.5, r * 1.6, 0.016, metal()); ring.position.set(0, -r * 0.8, z); grp.add(ring); }
  return grp;
}

// Patterned skins are small generated textures; plain ones are just a colour.
const skins = new Map();
function skinMaterial(id) {
  const p = PAINTS[id] || PAINTS.factory;
  if (!p.pattern) return new THREE.MeshStandardMaterial({ color: p.color, roughness: id === 'moonshine' ? 0.25 : 0.55, metalness: id === 'moonshine' ? 0.8 : 0.25 });
  let tex = skins.get(id);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    let seed = 7 + id.length * 31 + id.charCodeAt(0);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle = p.color; g.fillRect(0, 0, 64, 64);
    const inks = [p.color2, p.color3].filter(Boolean);
    if (p.pattern === 'stripes') {
      g.strokeStyle = p.color2; g.lineCap = 'round';
      for (let i = 0; i < 9; i++) { g.lineWidth = 2 + rnd() * 5; const y = rnd() * 80 - 8; g.beginPath(); g.moveTo(-4, y); g.bezierCurveTo(20, y + rnd() * 16 - 8, 44, y + rnd() * 16 - 8, 68, y + rnd() * 20 - 4); g.stroke(); }
    } else if (p.pattern === 'digital') {
      for (let i = 0; i < 90; i++) { g.fillStyle = inks[i % inks.length]; g.fillRect(Math.floor(rnd() * 16) * 4, Math.floor(rnd() * 16) * 4, 4 * (1 + Math.floor(rnd() * 3)), 4 * (1 + Math.floor(rnd() * 2))); }
    } else if (p.pattern === 'scales') {
      g.strokeStyle = p.color2; g.lineWidth = 2;
      for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) { g.beginPath(); g.arc(x * 8 + (y % 2 ? 4 : 0), y * 8, 5, 0, Math.PI); g.stroke(); }
    } else {
      for (let i = 0; i < 26; i++) { g.fillStyle = inks[i % inks.length]; g.beginPath(); g.ellipse(rnd() * 64, rnd() * 64, 4 + rnd() * 9, 3 + rnd() * 6, rnd() * 3, 0, Math.PI * 2); g.fill(); }
    }
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    skins.set(id, tex);
  }
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.2 });
}
const AMMO_TIP = { ball: 0xb87333, hollow: 0xd9d9d9, ap: 0x1a1a1a, subsonic: 0x3b6ea8, matchAmmo: 0x3f9a4a, overpressure: 0xc0392b };

/**
 * Build a gun model pointing along +Z, origin at the pistol grip.
 * Each part mesh carries userData.explode: the direction it flies out in the exploded view.
 */
export function buildGunModel(gun) {
  const g = new THREE.Group();
  if (!gun) return g;
  const parts = { ...DEFAULT_PARTS, ...(gun.parts || {}) };
  const a = gun.a || gun.archetype;
  if (a === 'launcher') {
    // A shoulder-fired tube: flared at the back, a grip and a fold-up sight, a rocket nose showing.
    const olive = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.7 });
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 14), olive);
    tube.rotation.x = Math.PI / 2; tube.position.z = 0.25; g.add(tube);
    const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.085, 0.14, 14, 1, true), olive);
    flare.rotation.x = -Math.PI / 2; flare.position.z = -0.3; g.add(flare);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 12), new THREE.MeshStandardMaterial({ color: 0x7a7d6a, metalness: 0.4 }));
    nose.rotation.x = Math.PI / 2; nose.position.z = 0.82; g.add(nose);
    const gripL = box(0.04, 0.13, 0.05, metal(0x1e1f21)); gripL.position.set(0, -0.11, 0.05); g.add(gripL);
    const sight = box(0.03, 0.08, 0.04, metal(0x1e1f21)); sight.position.set(0.05, 0.08, 0.35); g.add(sight);
    g.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.userData.explode = new THREE.Vector3(); c.userData.home = c.position.clone(); } });
    Object.assign(g.userData, { muzzle: new THREE.Vector3(0, 0, 0.9), back: new THREE.Vector3(0, 0, -0.38), eject: null, mag: null, archetype: a, grip: new THREE.Vector3(0, -0.15, 0.05), fore: new THREE.Vector3(0, -0.07, 0.38) });
    return g;
  }
  if (realReady && REAL[a]) return buildRealGun(g, gun, a, parts);   // (gun.m: which real gun, for classes with several)
  const [L, B, H] = SIZE[a] || SIZE.carbine;
  const paint = skinMaterial(gun.paint);
  const add = (mesh, explode = [0, 0, 0], slot = 'body') => {
    mesh.traverse((c) => { if (c.isMesh) c.castShadow = true; });
    mesh.userData.explode = new THREE.Vector3(...explode);
    mesh.userData.slot = slot;
    mesh.userData.home = mesh.position.clone();
    g.add(mesh);
    return mesh;
  };
  /** Add a part built at its final position. */
  const place = (mesh, explode, slot) => add(mesh, explode, slot);
  const front = L * 0.65;   // receiver spans z in [-L*0.35, L*0.65]

  // Receiver + grip + trigger guard.
  const rec = box(0.06, H, L, paint);
  rec.position.set(0, 0, L * 0.15);
  place(rec);
  const grip = box(0.05, 0.13, 0.06, paint);
  grip.position.set(0, -H / 2 - 0.05, -0.02); grip.rotation.x = -0.25;
  place(grip, [0, -0.05, 0]);
  const TRIG = { stdTrigger: 0x1e1f21, matchTrig: 0xd6b34a, hairTrig: 0xff4a2a, dutyTrig: 0x6f7780, binaryTrig: 0x39c0d6, tunedTrig: 0x9a6ad6 };
  const guard = box(0.015, 0.03, 0.07, metal(TRIG[parts.trigger] ?? TRIG.stdTrigger));
  guard.position.set(0, -H / 2 - 0.015, 0.06);
  place(guard, [0, -0.03, 0], 'trigger');

  // Barrel.
  const blen = B * ({ shortBarrel: 0.6, longBarrel: 1.45, matchBarrel: 1.15, hardBarrel: 1.3, heavyBarrel: 1.1 }[parts.barrel] || 1);
  const bthick = { matchBarrel: 0.024, heavyBarrel: 0.03, hardBarrel: 0.022 }[parts.barrel] || 0.018;
  const barrel = cyl(a === 'shotgun' ? 0.026 : bthick, blen, metal(parts.barrel === 'hardBarrel' ? 0x2c3238 : 0x1e1f21));
  barrel.position.set(0, H * 0.15, front + blen / 2);
  place(barrel, [0, 0, 0.12], 'barrel');
  // Forearm (long guns): the handguard around the barrel.
  if (a !== 'sidearm' && blen > 0.1) {
    const flen = Math.min(blen * 0.7, 0.3);
    const fore = new THREE.Group();
    const F = {
      stdForearm: () => fore.add(box(0.07, H * 0.8, flen, paint)),
      slimRail: () => fore.add(box(0.05, H * 0.62, flen * 1.1, paint)),
      quadRail: () => { fore.add(box(0.075, H * 0.85, flen, paint)); for (const [x, y] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const rail = box(x ? 0.012 : 0.03, y ? 0.012 : 0.03, flen * 0.95, metal()); rail.position.set(x * 0.043, y * H * 0.46, 0); fore.add(rail); } },
      carbonRail: () => { fore.add(box(0.06, H * 0.7, flen * 1.05, metal(0x15171a))); for (let k = -2; k <= 2; k++) { const slot = box(0.064, H * 0.16, flen * 0.1, metal(0x3a3f45)); slot.position.z = k * flen * 0.19; fore.add(slot); } },
      opRail: () => { fore.add(box(0.062, H * 0.74, flen * 1.05, paint)); const top = box(0.03, 0.012, flen, metal()); top.position.y = H * 0.4; fore.add(top); },
    };
    (F[parts.forearm] || F.stdForearm)();
    fore.position.set(0, 0, front + flen / 2);
    place(fore, [0.14, 0, 0.04], 'forearm');
  }
  const tip = front + blen;

  // Muzzle.
  const muzzle = {
    compensator: () => cyl(0.026, 0.06, metal()),
    suppressor: () => cyl(0.032, 0.22, metal()),
    intSup: () => cyl(0.03, 0.18, metal(0x2c3238)),
    brake: () => box(0.055, 0.04, 0.07, metal()),
    choke: () => cyl(0.034, 0.05, metal(), 0.028),
  }[parts.muzzle];
  if (muzzle) {
    const m = muzzle();
    const len = parts.muzzle === 'suppressor' ? 0.22 : parts.muzzle === 'intSup' ? 0.18 : 0.06;
    m.position.set(0, H * 0.15, tip + len / 2);
    place(m, [0, 0, 0.18], 'muzzle');
  }

  // Sight.
  const top = H / 2;
  const at = (grp, y, z) => { grp.position.set(0, top + y, z); return grp; };
  const optic = {
    iron: () => { const s = box(0.01, 0.03, 0.01, metal()); s.position.set(0, top + 0.015, front - 0.02); return s; },
    tritium: () => { const grp = new THREE.Group(); const post = box(0.01, 0.03, 0.01, metal()); const dot = box(0.012, 0.008, 0.004, new THREE.MeshBasicMaterial({ color: 0x7dff7a })); dot.position.set(0, 0.012, -0.007); const rear = box(0.03, 0.022, 0.01, metal()); rear.position.z = -L * 0.5; grp.add(post, dot, rear); return at(grp, 0.015, front - 0.02); },
    reflex: () => { const grp = new THREE.Group(); const base = box(0.04, 0.02, 0.05, metal()); const lens = box(0.035, 0.035, 0.005, glass()); lens.position.y = 0.025; grp.add(base, lens); return at(grp, 0.01, L * 0.2); },
    holo: () => { const grp = new THREE.Group(); const body = box(0.05, 0.05, 0.09, metal()); const lens = box(0.04, 0.035, 0.004, glass()); lens.position.set(0, 0.005, 0.047); grp.add(body, lens); return at(grp, 0.025, L * 0.2); },
    prism: () => at(scope(0.09, 0.024, 0.026), 0.04, L * 0.18),
    fieldOptic: () => { const grp = new THREE.Group(); const body = box(0.05, 0.05, 0.08, metal()); const lens = box(0.04, 0.035, 0.004, glass()); lens.position.set(0, 0.005, 0.042); const mag = cyl(0.022, 0.07, metal()); mag.position.set(0, 0.002, -0.09); grp.add(body, lens, mag); return at(grp, 0.025, L * 0.24); },
    acog: () => at(scope(0.13, 0.022, 0.025), 0.04, L * 0.15),
    lpvo: () => at(scope(0.2, 0.019, 0.026, glass(), true), 0.045, L * 0.15),
    marksman: () => at(scope(0.22, 0.02, 0.03, glass(), true), 0.048, L * 0.15),
    spotter: () => { const grp = scope(0.19, 0.021, 0.029, glass(0x46d1a0, 0x0b4a36), true); const rf = box(0.03, 0.02, 0.05, metal(0x2c3238)); rf.position.set(0.035, 0.02, 0.02); const eye = box(0.012, 0.012, 0.004, new THREE.MeshBasicMaterial({ color: 0xff3030 })); eye.position.set(0.035, 0.02, 0.047); grp.add(rf, eye); return at(grp, 0.046, L * 0.15); },
    thermal: () => { const grp = new THREE.Group(); const body = box(0.06, 0.06, 0.16, metal(0x24282c)); const lens = cyl(0.026, 0.006, glass(0xff8a2a, 0x7a2a00)); lens.position.z = 0.083; const eye = cyl(0.02, 0.03, metal()); eye.position.z = -0.095; grp.add(body, lens, eye); return at(grp, 0.036, L * 0.15); },
    sniper: () => at(scope(0.26, 0.02, 0.03, glass(), true), 0.05, L * 0.15),
    long12: () => at(scope(0.33, 0.022, 0.038, glass(0x9ad0ff, 0x1a4a7a), true), 0.056, L * 0.13),
  }[parts.optic];
  if (optic) place(optic(), [0, 0.16, 0], 'optic');

  // Underbarrel.
  const ux = front + Math.min(blen * 0.5, 0.15);
  const under = {
    vgrip: () => { const m = box(0.035, 0.1, 0.035, paint); m.position.set(0, -H / 2 - 0.05, ux); return m; },
    agrip: () => { const m = box(0.035, 0.05, 0.09, paint); m.position.set(0, -H / 2 - 0.02, ux); m.rotation.x = 0.5; return m; },
    fieldGrip: () => { const m = box(0.038, 0.085, 0.04, metal(0x2c3238)); m.position.set(0, -H / 2 - 0.042, ux); m.rotation.x = 0.18; return m; },
    handStop: () => { const m = box(0.03, 0.03, 0.035, paint); m.position.set(0, -H / 2 - 0.015, ux); return m; },
    railWeight: () => { const m = box(0.04, 0.03, Math.max(0.05, blen * 0.8), metal(0x3a3f45)); m.position.set(0, -H / 2 + 0.0, front + Math.max(0.05, blen * 0.8) / 2); return m; },
    thumbRest: () => { const m = box(0.02, 0.02, 0.05, paint); m.position.set(0.04, 0.01, front - 0.04); return m; },
    laser: () => { const grp = new THREE.Group(); const m = box(0.03, 0.03, 0.06, metal()); const dot = box(0.012, 0.012, 0.004, new THREE.MeshBasicMaterial({ color: 0xff2020 })); dot.position.z = 0.031; grp.add(m, dot); grp.position.set(0.045, 0, ux); return grp; },
    bipod: () => { const grp = new THREE.Group(); for (const s of [-1, 1]) { const leg = box(0.012, 0.16, 0.012, metal()); leg.position.set(s * 0.03, -0.08, 0); leg.rotation.z = s * 0.25; grp.add(leg); } grp.position.set(0, -H / 2, front + blen * 0.6); return grp; },
  }[parts.underbarrel];
  if (under) place(under(), [0, -0.12, 0.04], 'underbarrel');

  // Magazine.
  const magLen = a === 'lmg' ? 0.1 : 0.14;
  const MAG = {
    stdMag: () => box(0.035, magLen, 0.05, metal()),
    extMag: () => box(0.035, magLen * 1.5, 0.055, metal()),
    lightMag: () => box(0.033, magLen * 0.9, 0.048, new THREE.MeshStandardMaterial({ color: 0x6b5a3a, roughness: 0.8 })),
    fastMag: () => { const grp = new THREE.Group(); const m1 = box(0.035, magLen * 0.9, 0.05, metal()); const tab = box(0.01, 0.02, 0.04, new THREE.MeshStandardMaterial({ color: 0xd04020 })); tab.position.y = -magLen * 0.45; grp.add(m1, tab); return grp; },
    coupledMag: () => { const grp = new THREE.Group(); const m1 = box(0.035, magLen, 0.05, metal()); const m2 = m1.clone(); m2.position.set(0.04, 0.02, 0); const tape = box(0.082, 0.02, 0.054, new THREE.MeshStandardMaterial({ color: 0x4d5e3a })); tape.position.set(0.02, 0, 0); grp.add(m1, m2, tape); return grp; },
    drum: () => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 18), metal()); m.rotation.z = Math.PI / 2; return m; },
    beltBox: () => { const grp = new THREE.Group(); const b = box(0.09, 0.11, 0.12, new THREE.MeshStandardMaterial({ color: 0x4b5a3a, roughness: 0.8 })); const belt = box(0.02, 0.03, 0.05, metal(0xb87333)); belt.position.set(0, 0.07, 0); grp.add(b, belt); return grp; },
  };
  const mag = (MAG[parts.magazine] || MAG.stdMag)();
  const magY = parts.magazine === 'drum' ? -H / 2 - 0.06 : parts.magazine === 'beltBox' ? -H / 2 - 0.06 : parts.magazine === 'extMag' ? -H / 2 - magLen * 0.7 : -H / 2 - magLen / 2;
  if (a === 'shotgun') mag.visible = parts.magazine !== 'stdMag';
  mag.position.set(0, magY, L * 0.3);
  place(mag, [0, -0.16, 0], 'magazine');
  // Ammunition: one round, hidden in the action until the gun is pulled apart.
  const round = new THREE.Group();
  const kase = cyl(0.008, 0.035, metal(0xb8963a)); const bullet = cyl(0.008, 0.016, metal(AMMO_TIP[parts.ammo] ?? AMMO_TIP.ball), 0.003); bullet.position.z = 0.025;
  round.add(kase, bullet);
  round.position.set(0, H * 0.1, L * 0.3);
  place(round, [-0.14, 0.06, 0], 'ammo');

  // Stock.
  const back = -L * 0.35;
  const STOCK = {
    stdStock: () => { const m = box(0.045, 0.1, 0.22, paint); m.position.set(0, -0.015, back - 0.11); return m; },
    lightStock: () => { const grp = new THREE.Group(); for (const y of [0.03, -0.05]) { const r = box(0.015, 0.015, 0.22, metal()); r.position.y = y; grp.add(r); } const pad = box(0.04, 0.11, 0.02, paint); pad.position.set(0, -0.01, -0.11); grp.add(pad); grp.position.set(0, 0, back - 0.11); return grp; },
    heavyStock: () => { const m = box(0.06, 0.13, 0.26, paint); m.position.set(0, -0.02, back - 0.13); return m; },
    foldStock: () => { const grp = new THREE.Group(); const arm = box(0.014, 0.02, 0.2, metal()); arm.position.y = 0.02; const pad = box(0.04, 0.1, 0.02, paint); pad.position.set(0, -0.01, -0.1); const hinge = box(0.03, 0.04, 0.02, metal()); hinge.position.z = 0.1; grp.add(arm, pad, hinge); grp.position.set(0, 0, back - 0.1); return grp; },
    precisionStock: () => { const grp = new THREE.Group(); const body = box(0.045, 0.1, 0.24, paint); const cheek = box(0.05, 0.03, 0.12, metal(0x2c3238)); cheek.position.set(0, 0.065, 0.02); const pad = box(0.05, 0.13, 0.02, metal()); pad.position.set(0, -0.01, -0.13); grp.add(body, cheek, pad); grp.position.set(0, -0.015, back - 0.12); return grp; },
    bufferStock: () => { const grp = new THREE.Group(); const tube = cyl(0.018, 0.2, metal()); const pad = box(0.045, 0.11, 0.05, paint); pad.position.set(0, -0.02, -0.11); grp.add(tube, pad); grp.position.set(0, 0.01, back - 0.1); return grp; },
    braceKit: () => { const grp = new THREE.Group(); const arm = box(0.02, 0.02, 0.16, metal()); const fin = box(0.012, 0.09, 0.06, paint); fin.position.set(0, -0.02, -0.08); grp.add(arm, fin); grp.position.set(0, 0.01, back - 0.08); return grp; },
    pdwStock: () => { const grp = new THREE.Group(); for (const x of [-0.022, 0.022]) { const rod = box(0.008, 0.008, 0.16, metal()); rod.position.x = x; grp.add(rod); } const pad = box(0.05, 0.07, 0.014, metal()); pad.position.z = -0.08; grp.add(pad); grp.position.set(0, 0.01, back - 0.08); return grp; },
  };
  const hasStock = parts.stock !== 'noStock' && (a !== 'sidearm' || parts.stock === 'braceKit' || parts.stock === 'pdwStock');
  if (hasStock) place((STOCK[parts.stock] || STOCK.stdStock)(), [0, 0, -0.16], 'stock');
  // For the shot and reload effects: where the flash comes out, where the empties fly from, the mag.
  const mlen = parts.muzzle === 'suppressor' ? 0.22 : parts.muzzle === 'intSup' ? 0.18 : muzzle ? 0.06 : 0;
  // Where the hands go: the right on the pistol grip, the left on the handguard (or, on a pistol,
  // cupping the right).
  const foreZ = a === 'sidearm' || blen <= 0.1 ? 0.02 : front + Math.min(blen * 0.7, 0.3) * 0.55;
  Object.assign(g.userData, { muzzle: new THREE.Vector3(0, H * 0.15, tip + mlen + 0.02), eject: new THREE.Vector3(-0.04, H * 0.3, L * 0.22), mag, archetype: a,
    grip: new THREE.Vector3(0, -H / 2 - 0.06, -0.03), fore: a === 'sidearm' ? new THREE.Vector3(0.035, -H / 2 - 0.07, 0.0) : new THREE.Vector3(0, -H * 0.45, foreZ),
    suppressed: parts.muzzle === 'suppressor' || parts.muzzle === 'intSup' });
  return g;
}

/** A gun from its real model, with the gunsmith's parts on it. Same frame and anchors as the built
 *  ones: +Z forward, the pistol grip near the origin. */
function buildRealGun(g, gun, a, parts) {
  const R = realOf(a, gun.m || gun.model);
  const [body, H] = fitAlongZ(R.file, R.len);
  const L = R.len;
  // Put the hand's place on the grip where the old guns had it, so the hands and the aim line up.
  const gripAt = new THREE.Vector3(0, R.grip[1] * H, R.grip[0] * L);
  const shift = new THREE.Vector3(0, -0.115, -0.03).sub(gripAt);
  body.position.copy(shift);
  const P = (fz, fy, dx = 0) => new THREE.Vector3(dx, fy * H, fz * L).add(shift);   // a point on the model
  // Paint: the main body colour takes the skin (plain black keeps the model's own colours).
  if (gun.paint && gun.paint !== 'factory') {
    const skin = skinMaterial(gun.paint);
    body.traverse((o) => { if (o.isMesh && /^(Main|Black)$/.test(o.material.name)) o.material = skin; });
  }
  const add = (mesh, explode = [0, 0, 0], slot = 'body') => {
    mesh.traverse((c) => { if (c.isMesh) c.castShadow = true; });
    mesh.userData.explode = new THREE.Vector3(...explode);
    mesh.userData.slot = slot;
    mesh.userData.home = mesh.position.clone();
    g.add(mesh);
    return mesh;
  };
  add(body);
  const railY = R.rail * H + shift.y, boreY = R.bore * H + shift.y, opticZ = R.optic * L + shift.z, tipZ = L + shift.z;
  const foreZ = R.fore[0] * L + shift.z, foreY = R.fore[1] * H + shift.y;
  // Optics: the real scopes for the magnified ones, the built sights for the rest (iron = the gun's own).
  const realScope = { acog: ['scope3', 0.17], lpvo: ['scope1', 0.24], marksman: ['scope2', 0.27], spotter: ['scope2', 0.25], sniper: ['scope1', 0.3], long12: ['scope2', 0.36] }[parts.optic];
  if (realScope) {
    const [sc, sh] = fitAlongZ(realScope[0], realScope[1]);
    sc.position.set(0, railY - sh * 0.12, opticZ - realScope[1] / 2);
    add(sc, [0, 0.16, 0], 'optic');
  } else if (parts.optic && parts.optic !== 'iron') {
    const top = railY;
    const at = (grp, y, z) => { grp.position.set(0, top + y, z); return grp; };
    const optic = {
      tritium: () => { const grp = new THREE.Group(); const dot = box(0.012, 0.008, 0.004, new THREE.MeshBasicMaterial({ color: 0x7dff7a })); grp.add(dot); return at(grp, 0.01, tipZ - 0.06); },
      reflex: () => { const k = a === 'sidearm' ? 0.6 : 1, grp = new THREE.Group(); const base = box(0.035 * k, 0.018 * k, 0.045 * k, metal()); const lens = box(0.032 * k, 0.026 * k, 0.005, glass()); lens.position.y = 0.02 * k; grp.add(base, lens); return at(grp, 0.009 * k, opticZ); },
      holo: () => { const grp = new THREE.Group(); const b = box(0.045, 0.045, 0.085, metal()); const lens = box(0.038, 0.032, 0.004, glass()); lens.position.set(0, 0.004, 0.044); grp.add(b, lens); return at(grp, 0.022, opticZ); },
      prism: () => at(scope(0.09, 0.022, 0.025), 0.035, opticZ),
      fieldOptic: () => { const grp = new THREE.Group(); const b = box(0.045, 0.045, 0.075, metal()); const lens = box(0.038, 0.032, 0.004, glass()); lens.position.set(0, 0.004, 0.039); grp.add(b, lens); return at(grp, 0.022, opticZ); },
      thermal: () => { const grp = new THREE.Group(); const b = box(0.055, 0.055, 0.15, metal(0x24282c)); const lens = cyl(0.024, 0.006, glass(0xff8a2a, 0x7a2a00)); lens.position.z = 0.078; grp.add(b, lens); return at(grp, 0.03, opticZ); },
    }[parts.optic];
    if (optic) add(optic(), [0, 0.16, 0], 'optic');
  }
  // Muzzle devices on the bore.
  const MUZ = { suppressor: ['silencer', 0.2], intSup: ['silencerShort', 0.12] }[parts.muzzle];
  let mlen = 0;
  if (MUZ) {
    const [m] = fitAlongZ(MUZ[0], MUZ[1]);
    const mh = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3()).y;
    m.position.set(0, boreY - mh / 2, tipZ - 0.005);
    add(m, [0, 0, 0.18], 'muzzle');
    mlen = MUZ[1];
  } else if (parts.muzzle && parts.muzzle !== 'bareMuzzle') {
    const build = { compensator: () => cyl(0.02, 0.05, metal()), brake: () => box(0.045, 0.034, 0.06, metal()), choke: () => cyl(0.028, 0.045, metal(), 0.022) }[parts.muzzle];
    if (build) { const m = build(); mlen = 0.05; m.position.set(0, boreY, tipZ + 0.025); add(m, [0, 0, 0.18], 'muzzle'); }
  }
  // Underbarrel, under the handguard.
  const underY = foreY - 0.02;
  if (parts.underbarrel === 'vgrip' || parts.underbarrel === 'fieldGrip') {
    const [gp, gh] = fitAlongZ('grip', 0.035);
    gp.scale.multiplyScalar(1); gp.rotation.x = 0; gp.position.set(0, underY - gh, foreZ - 0.017);
    add(gp, [0, -0.12, 0.04], 'underbarrel');
  } else if (parts.underbarrel === 'bipod') {
    // Two folding legs splayed out under the barrel, near the muzzle.
    const grp = new THREE.Group(), legMat = metal(0x2a2c2f);
    const clamp = box(0.03, 0.02, 0.03, legMat); grp.add(clamp);
    for (const sx of [-1, 1]) { const leg = cyl(0.006, 0.17, legMat); leg.rotation.set(Math.PI / 2 - 0.15, 0, sx * 0.3); leg.position.set(sx * 0.026, -0.08, 0.012); grp.add(leg); }
    grp.position.set(0, boreY - 0.02, tipZ - Math.min(0.25, L * 0.3));
    add(grp, [0, -0.12, 0.04], 'underbarrel');
  } else if (parts.underbarrel && parts.underbarrel !== 'noUnder') {
    const build = {
      agrip: () => { const m = box(0.03, 0.045, 0.08, metal(0x2c3238)); m.rotation.x = 0.5; return m; },
      handStop: () => box(0.026, 0.026, 0.03, metal(0x2c3238)),
      railWeight: () => box(0.035, 0.026, 0.12, metal(0x3a3f45)),
      thumbRest: () => box(0.018, 0.018, 0.045, metal(0x2c3238)),
      laser: () => { const grp = new THREE.Group(); const m = box(0.026, 0.026, 0.055, metal()); const dot = box(0.01, 0.01, 0.004, new THREE.MeshBasicMaterial({ color: 0xff2020 })); dot.position.z = 0.029; grp.add(m, dot); grp.position.x = 0.03; return grp; },
    }[parts.underbarrel];
    if (build) { const m = build(); m.position.y += underY - 0.015; m.position.z += foreZ; add(m, [0, -0.12, 0.04], 'underbarrel'); }
  }
  // Bigger magazines hang off the gun's own.
  const magAt = P(R.mag[0], R.mag[1]);
  const magHolder = new THREE.Object3D(); magHolder.position.copy(magAt);
  if (parts.magazine === 'drum') { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.05, 18), metal()); m.rotation.z = Math.PI / 2; magHolder.add(m); }
  else if (parts.magazine === 'beltBox') { const b = box(0.08, 0.1, 0.11, new THREE.MeshStandardMaterial({ color: 0x4b5a3a, roughness: 0.8 })); b.position.y = -0.02; magHolder.add(b); }
  else if (parts.magazine === 'extMag') { const m = box(0.032, 0.07, 0.05, metal()); m.position.y = -0.07; magHolder.add(m); }
  add(magHolder, [0, -0.16, 0], 'magazine');
  // One round, hidden inside until the gun is pulled apart.
  const round = new THREE.Group();
  const kase = cyl(0.008, 0.035, metal(0xb8963a)); const bullet = cyl(0.008, 0.016, metal(AMMO_TIP[parts.ammo] ?? AMMO_TIP.ball), 0.003); bullet.position.z = 0.025;
  round.add(kase, bullet); round.position.copy(P(R.mag[0], R.bore - 0.05));
  add(round, [-0.14, 0.06, 0], 'ammo');
  Object.assign(g.userData, {
    muzzle: new THREE.Vector3(0, boreY, tipZ + mlen + 0.02), eject: new THREE.Vector3(-0.04, railY - 0.02, opticZ), mag: magHolder, archetype: a,
    grip: new THREE.Vector3(0, -0.115, -0.03), fore: a === 'sidearm' ? new THREE.Vector3(0.03, -0.13, 0.0) : P(R.fore[0], R.fore[1]),
    suppressed: parts.muzzle === 'suppressor' || parts.muzzle === 'intSup', real: true,
  });
  return g;
}

/** Animate parts toward their exploded (t=1) or assembled (t=0) positions. */
export function setExplode(g, t, highlightSlot = null) {
  for (const c of g.children) {
    const { home, explode, slot } = c.userData;
    if (!home) continue;
    c.position.copy(home).addScaledVector(explode, t);
    c.traverse((m) => {
      if (!m.material || !m.material.emissive) return;
      if (slot === highlightSlot && !m.userData.hl) { m.userData.hl = m.material.emissive.getHex(); m.material.emissive.set(0x663300); }
      if (slot !== highlightSlot && m.userData.hl !== undefined) { m.material.emissive.setHex(m.userData.hl); delete m.userData.hl; }
    });
  }
}

export function gunKey(gun) { return gun ? JSON.stringify([gun.a || gun.archetype, gun.m || gun.model || '', gun.parts, gun.paint, realReady]) : ''; }
/** Whether the real models are in (part of any cache key for a built gun, so they rebuild once they are). */
export function gunsReal() { return realReady; }
