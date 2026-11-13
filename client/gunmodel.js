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

const metal = () => new THREE.MeshStandardMaterial({ color: 0x1e1f21, metalness: 0.6, roughness: 0.45 });
const glass = () => new THREE.MeshStandardMaterial({ color: 0x3fa9ff, emissive: 0x0b3a66, metalness: 0.2, roughness: 0.1 });

function box(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
function cyl(r, len, mat, r2 = r) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 14), mat);
  m.rotation.x = Math.PI / 2;          // lie along +Z
  return m;
}

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
  const paint = new THREE.MeshStandardMaterial({ color: PAINTS[gun.paint]?.color || PAINTS.factory.color, roughness: 0.55, metalness: 0.25 });
  const add = (mesh, explode = [0, 0, 0], slot = 'body') => {
    mesh.castShadow = true;
    mesh.userData.explode = new THREE.Vector3(...explode);
    mesh.userData.slot = slot;
    mesh.userData.home = mesh.position.clone();
    g.add(mesh);
    return mesh;
  };
  const front = L * 0.65;   // receiver spans z in [-L*0.35, L*0.65]

  // Receiver + grip + trigger guard.
  const rec = add(box(0.06, H, L, paint));
  rec.position.set(0, 0, L * 0.15);
  rec.userData.home = rec.position.clone();
  const grip = add(box(0.05, 0.13, 0.06, paint), [0, -0.05, 0]);
  grip.position.set(0, -H / 2 - 0.05, -0.02); grip.rotation.x = -0.25; grip.userData.home = grip.position.clone();
  const guard = add(box(0.015, 0.03, 0.07, metal()), [0, -0.03, 0], 'trigger');
  guard.position.set(0, -H / 2 - 0.015, 0.06); guard.userData.home = guard.position.clone();
  if (parts.trigger !== 'stdTrigger') guard.material.color.set(parts.trigger === 'hairTrig' ? 0xff4a2a : 0xd6b34a);

  // Barrel.
  const blen = B * ({ shortBarrel: 0.6, longBarrel: 1.45, matchBarrel: 1.15 }[parts.barrel] || 1);
  const bthick = parts.barrel === 'matchBarrel' ? 0.024 : 0.018;
  const barrel = add(cyl(a === 'shotgun' ? 0.026 : bthick, blen, metal()), [0, 0, 0.12], 'barrel');
  barrel.position.set(0, H * 0.15, front + blen / 2); barrel.userData.home = barrel.position.clone();
  if (a !== 'sidearm' && blen > 0.1) {
    const hand = add(box(0.07, H * 0.8, Math.min(blen * 0.7, 0.3), paint), [0, 0, 0.06], 'barrel');
    hand.position.set(0, 0, front + Math.min(blen * 0.7, 0.3) / 2); hand.userData.home = hand.position.clone();
  }
  const tip = front + blen;

  // Muzzle.
  const muzzle = {
    compensator: () => cyl(0.026, 0.06, metal()),
    suppressor: () => cyl(0.032, 0.22, metal()),
    brake: () => box(0.055, 0.04, 0.07, metal()),
    choke: () => cyl(0.034, 0.05, metal(), 0.028),
  }[parts.muzzle];
  if (muzzle) {
    const m = add(muzzle(), [0, 0, 0.18], 'muzzle');
    const len = parts.muzzle === 'suppressor' ? 0.22 : 0.06;
    m.position.set(0, H * 0.15, tip + len / 2); m.userData.home = m.position.clone();
  }

  // Optic.
  const top = H / 2;
  const optic = {
    iron: () => { const s = box(0.01, 0.03, 0.01, metal()); s.position.set(0, top + 0.015, front - 0.02); return s; },
    reflex: () => { const grp = new THREE.Group(); const base = box(0.04, 0.02, 0.05, metal()); const lens = box(0.035, 0.035, 0.005, glass()); lens.position.y = 0.025; grp.add(base, lens); grp.position.set(0, top + 0.01, L * 0.2); return grp; },
    holo: () => { const grp = new THREE.Group(); const body = box(0.05, 0.05, 0.09, metal()); const lens = box(0.04, 0.035, 0.004, glass()); lens.position.set(0, 0.005, 0.047); grp.add(body, lens); grp.position.set(0, top + 0.025, L * 0.2); return grp; },
    acog: () => { const grp = new THREE.Group(); const tube = cyl(0.022, 0.14, metal()); const lens = cyl(0.023, 0.005, glass()); lens.position.z = 0.072; grp.add(tube, lens); grp.position.set(0, top + 0.04, L * 0.15); return grp; },
    sniper: () => { const grp = new THREE.Group(); const tube = cyl(0.02, 0.26, metal()); const bell1 = cyl(0.03, 0.06, metal(), 0.02); bell1.position.z = 0.14; const bell2 = cyl(0.025, 0.05, metal()); bell2.position.z = -0.12; const lens = cyl(0.03, 0.005, glass()); lens.position.z = 0.172; grp.add(tube, bell1, bell2, lens); grp.position.set(0, top + 0.05, L * 0.15); return grp; },
  }[parts.optic];
  if (optic) {
    const o = optic();
    o.traverse((c) => { c.castShadow = true; });
    o.userData = { explode: new THREE.Vector3(0, 0.16, 0), slot: 'optic', home: o.position.clone() };
    g.add(o);
  }

  // Underbarrel.
  const ux = front + Math.min(blen * 0.5, 0.15);
  const under = {
    vgrip: () => { const m = box(0.035, 0.1, 0.035, paint); m.position.set(0, -H / 2 - 0.05, ux); return m; },
    agrip: () => { const m = box(0.035, 0.05, 0.09, paint); m.position.set(0, -H / 2 - 0.02, ux); m.rotation.x = 0.5; return m; },
    laser: () => { const grp = new THREE.Group(); const m = box(0.03, 0.03, 0.06, metal()); const dot = box(0.012, 0.012, 0.004, new THREE.MeshBasicMaterial({ color: 0xff2020 })); dot.position.z = 0.031; grp.add(m, dot); grp.position.set(0.045, 0, ux); return grp; },
    bipod: () => { const grp = new THREE.Group(); for (const s of [-1, 1]) { const leg = box(0.012, 0.16, 0.012, metal()); leg.position.set(s * 0.03, -0.08, 0); leg.rotation.z = s * 0.25; grp.add(leg); } grp.position.set(0, -H / 2, front + blen * 0.6); return grp; },
  }[parts.underbarrel];
  if (under) {
    const u = under();
    u.userData = { explode: new THREE.Vector3(0, -0.12, 0.04), slot: 'underbarrel', home: u.position.clone() };
    g.add(u);
  }

  // Magazine.
  const magLen = a === 'lmg' ? 0.1 : 0.14;
  const mag = {
    stdMag: () => box(0.035, magLen, 0.05, metal()),
    extMag: () => box(0.035, magLen * 1.5, 0.055, metal()),
    fastMag: () => { const grp = new THREE.Group(); const m1 = box(0.035, magLen * 0.9, 0.05, metal()); const m2 = m1.clone(); m2.position.x = 0.04; const tab = box(0.01, 0.02, 0.04, new THREE.MeshStandardMaterial({ color: 0xd04020 })); tab.position.y = -magLen * 0.45; grp.add(m1, m2, tab); return grp; },
    drum: () => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 18), metal()); m.rotation.z = Math.PI / 2; return m; },
  }[parts.magazine]();
  const magY = parts.magazine === 'drum' ? -H / 2 - 0.06 : parts.magazine === 'extMag' ? -H / 2 - magLen * 0.7 : -H / 2 - magLen / 2;
  if (a === 'shotgun') mag.visible = parts.magazine !== 'stdMag';
  mag.position.set(0, magY, L * 0.3);
  mag.userData = { explode: new THREE.Vector3(0, -0.16, 0), slot: 'magazine', home: mag.position.clone() };
  g.add(mag);

  // Stock.
  if (a !== 'sidearm' && parts.stock !== 'noStock') {
    const back = -L * 0.35;
    const stock = {
      stdStock: () => { const m = box(0.045, 0.1, 0.22, paint); m.position.set(0, -0.015, back - 0.11); return m; },
      lightStock: () => { const grp = new THREE.Group(); for (const y of [0.03, -0.05]) { const r = box(0.015, 0.015, 0.22, metal()); r.position.y = y; grp.add(r); } const pad = box(0.04, 0.11, 0.02, paint); pad.position.set(0, -0.01, -0.11); grp.add(pad); grp.position.set(0, 0, back - 0.11); return grp; },
      heavyStock: () => { const m = box(0.06, 0.13, 0.26, paint); m.position.set(0, -0.02, back - 0.13); return m; },
    }[parts.stock]();
    stock.userData = { explode: new THREE.Vector3(0, 0, -0.16), slot: 'stock', home: stock.position.clone() };
    g.add(stock);
  }
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
