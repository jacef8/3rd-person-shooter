// Procedural weapon models built from gunsmith parts. The same builder is used for the gun in each
// character's hands and for the rotating (and explodable) preview in the gunsmith.
import * as THREE from 'three';
import { PAINTS, DEFAULT_PARTS } from '/shared/items.js';

const SIZE = {
  //          receiver len, barrel len, height
  sidearm: [0.20, 0.06, 0.10],
  smg:     [0.32, 0.14, 0.11],
  carbine: [0.40, 0.30, 0.11],
  shotgun: [0.42, 0.36, 0.12],
  dmr:     [0.46, 0.42, 0.11],
  lmg:     [0.52, 0.38, 0.14],
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

export function gunKey(gun) { return gun ? JSON.stringify([gun.a || gun.archetype, gun.parts, gun.paint]) : ''; }
