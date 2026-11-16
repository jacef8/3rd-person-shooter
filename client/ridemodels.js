// Low-poly models of the rides (cars, trucks, bikes, horses...), and of the abandoned cars and the
// RVs, buses, box trucks and houseboats people live in. Used by the game (main.js) for rides you can
// drive, and by the world view for the wrecks and vehicle homes that are part of the map.
import * as THREE from 'three';
import { BOATS } from '/shared/boats.js';

// Shared bits for the ride models (built once, reused by every ride).
const RIDE_MAT = {
  tire: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.4, metalness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x24323d, roughness: 0.15, metalness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.7 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.25, metalness: 0.8 }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0x806a40, roughness: 0.3 }),
  tail: new THREE.MeshStandardMaterial({ color: 0xb01818, emissive: 0x400606, roughness: 0.3 }),
  leather: new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 }),
};
/** A low-poly model of each kind of ride, in its paint colour. Wheels spin, horses' legs walk. */
export function buildRideModel(type, color) {
  const def = BOATS[type], g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: color || def.colors?.[0] || 0x888888, roughness: 0.45, metalness: type === 'horse' ? 0 : 0.35 });
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const wheels = [], legs = [];
  /** A wheel at (x, y=r, z): a tyre with a hub, on a pivot that spins. */
  const wheel = (x, z, r, w = 0.22, thin = false) => {
    const pivot = new THREE.Group(); pivot.position.set(x, r, z); body.add(pivot);
    if (thin) { const t = new THREE.Mesh(new THREE.TorusGeometry(r - 0.03, 0.035, 6, 18), RIDE_MAT.tire); t.rotation.y = Math.PI / 2; pivot.add(t);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 6), RIDE_MAT.rim); hub.rotation.z = Math.PI / 2; pivot.add(hub);
      for (let i = 0; i < 3; i++) { const sp = new THREE.Mesh(boxG(0.01, (r - 0.05) * 2, 0.012), RIDE_MAT.rim); sp.rotation.x = (i * Math.PI) / 3; pivot.add(sp); }
    } else {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 14), RIDE_MAT.tire); t.rotation.z = Math.PI / 2; pivot.add(t);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10), RIDE_MAT.rim); hub.rotation.z = Math.PI / 2; pivot.add(hub);
      const mark = new THREE.Mesh(boxG(w + 0.03, r * 0.9, 0.05), RIDE_MAT.dark); pivot.add(mark);   // so you can see it turn
    }
    wheels.push({ pivot, r });
    return pivot;
  };
  const L = def.len, W = def.wid;
  if (type === 'car') {
    add(boxG(W, 0.55, L), paint, 0, 0.6, 0);
    const cab = add(boxG(W * 0.86, 0.5, L * 0.48), RIDE_MAT.glass, 0, 1.12, -0.25);
    add(boxG(W * 0.88, 0.06, L * 0.46), paint, 0, 1.39, -0.25);
    void cab;
    for (const s of [-1, 1]) { add(boxG(0.3, 0.12, 0.05), RIDE_MAT.head, s * W * 0.32, 0.72, L / 2 + 0.01); add(boxG(0.3, 0.12, 0.05), RIDE_MAT.tail, s * W * 0.32, 0.72, -L / 2 - 0.01); }
    add(boxG(W + 0.04, 0.14, 0.12), RIDE_MAT.dark, 0, 0.4, L / 2); add(boxG(W + 0.04, 0.14, 0.12), RIDE_MAT.dark, 0, 0.4, -L / 2);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.08), e * L * 0.32, 0.33);
  } else if (type === 'pickup') {
    add(boxG(W, 0.6, L), paint, 0, 0.85, 0);
    add(boxG(W * 0.96, 0.62, 1.7), paint, 0, 1.45, 0.75);
    add(boxG(W * 0.97, 0.42, 0.06), RIDE_MAT.glass, 0, 1.5, 1.61);
    for (const s of [-1, 1]) add(boxG(0.06, 0.4, 1.4), RIDE_MAT.glass, s * W * 0.485, 1.5, 0.8);
    for (const s of [-1, 1]) add(boxG(0.08, 0.35, L * 0.42), paint, s * (W / 2 - 0.04), 1.32, -L * 0.27);
    add(boxG(W, 0.35, 0.08), paint, 0, 1.32, -L / 2 + 0.04);
    for (const s of [-1, 1]) { add(boxG(0.32, 0.14, 0.05), RIDE_MAT.head, s * W * 0.32, 0.98, L / 2 + 0.01); add(boxG(0.14, 0.3, 0.05), RIDE_MAT.tail, s * W * 0.44, 1.2, -L / 2 - 0.01); }
    add(boxG(W + 0.06, 0.18, 0.14), RIDE_MAT.chrome, 0, 0.6, L / 2);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.1), e * L * 0.32, 0.42, 0.28);
  } else if (type === 'motorcycle' || type === 'dirtbike') {
    const dirt = type === 'dirtbike', r = dirt ? 0.36 : 0.32;
    wheel(0, L / 2 - r, r, 0.12); wheel(0, -L / 2 + r, r, 0.14);
    add(boxG(0.18, 0.22, L * 0.55), RIDE_MAT.dark, 0, r + 0.25, 0);
    add(boxG(0.32, 0.22, 0.5), paint, 0, r + 0.42, 0.25);   // tank
    add(boxG(0.28, 0.1, 0.6), RIDE_MAT.dark, 0, r + 0.48, -0.25);   // seat
    add(boxG(0.7, 0.04, 0.04), RIDE_MAT.chrome, 0, r + 0.72, L / 2 - r - 0.05);   // bars
    const fork = add(boxG(0.05, 0.6, 0.05), RIDE_MAT.chrome, 0, r + 0.3, L / 2 - r - 0.05); fork.rotation.x = -0.35;
    if (dirt) { add(boxG(0.22, 0.04, 0.5), paint, 0, r * 2 + 0.05, L / 2 - r); add(boxG(0.22, 0.04, 0.6), paint, 0, r * 2 + 0.1, -L / 2 + r + 0.2); }
    else { add(boxG(0.1, 0.1, 0.6), RIDE_MAT.chrome, 0.16, r * 0.8, -0.35); add(boxG(0.18, 0.1, 0.05), RIDE_MAT.head, 0, r + 0.62, L / 2 - 0.25); }
  } else if (type === 'atv') {
    add(boxG(0.9, 0.3, 1.5), paint, 0, 0.62, 0);
    add(boxG(1.15, 0.08, 0.45), paint, 0, 0.82, 0.7); add(boxG(1.15, 0.08, 0.45), paint, 0, 0.82, -0.7);   // fenders
    add(boxG(0.36, 0.14, 0.6), RIDE_MAT.dark, 0, 0.84, -0.1);
    add(boxG(0.8, 0.04, 0.04), RIDE_MAT.chrome, 0, 1.05, 0.5);
    add(boxG(0.9, 0.04, 0.4), RIDE_MAT.dark, 0, 0.95, 0.85); add(boxG(0.9, 0.04, 0.4), RIDE_MAT.dark, 0, 0.95, -0.85);   // racks
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * 0.5, e * 0.68, 0.3, 0.25);
  } else if (type === 'golfcart') {
    add(boxG(W, 0.22, L), paint, 0, 0.36, 0);
    add(boxG(W * 0.95, 0.5, 0.55), paint, 0, 0.6, 0.85);   // nose
    add(boxG(W * 0.9, 0.14, 0.55), RIDE_MAT.dark, 0, 0.62, -0.05);   // bench
    add(boxG(W * 0.9, 0.5, 0.1), RIDE_MAT.dark, 0, 0.92, -0.32);
    add(boxG(W * 1.02, 0.06, L * 0.82), RIDE_MAT.chrome, 0, 1.75, 0.05);   // roof
    for (const s of [-1, 1]) for (const e of [0.75, -0.6]) add(boxG(0.04, 1.3, 0.04), RIDE_MAT.chrome, s * W * 0.45, 1.12, e);
    add(boxG(W * 0.8, 0.5, 0.04), RIDE_MAT.glass, 0, 1.45, 0.76);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.08), e * L * 0.34, 0.2, 0.16);
  } else if (type === 'bicycle') {
    wheel(0, 0.52, 0.34, 0.04, true); wheel(0, -0.52, 0.34, 0.04, true);
    const bar = (x1, y1, z1, x2, y2, z2) => { const len = Math.hypot(y2 - y1, z2 - z1); const m = add(boxG(0.035, len, 0.035), paint, 0, (y1 + y2) / 2, (z1 + z2) / 2); m.rotation.x = Math.atan2(z2 - z1, y2 - y1); void x1; void x2; return m; };
    bar(0, 0.34, -0.52, 0, 0.8, -0.12); bar(0, 0.34, 0, 0, 0.8, -0.12); bar(0, 0.8, -0.12, 0, 0.82, 0.38); bar(0, 0.34, 0, 0, 0.82, 0.38); bar(0, 0.34, 0.52, 0, 0.92, 0.42);
    add(boxG(0.16, 0.05, 0.26), RIDE_MAT.dark, 0, 0.86, -0.16);
    add(boxG(0.55, 0.03, 0.03), RIDE_MAT.dark, 0, 0.98, 0.42);
  } else if (type === 'skateboard') {
    add(boxG(0.22, 0.025, 0.82), paint, 0, 0.1, 0);
    add(boxG(0.2, 0.004, 0.78), RIDE_MAT.dark, 0, 0.114, 0);
    for (const e of [-1, 1]) { add(boxG(0.18, 0.03, 0.05), RIDE_MAT.chrome, 0, 0.07, e * 0.27); for (const s of [-1, 1]) wheel(s * 0.09, e * 0.27, 0.035, 0.03); }
  } else if (type === 'tractor') {
    wheel(-0.85, -0.85, 0.78, 0.42); wheel(0.85, -0.85, 0.78, 0.42); wheel(-0.72, 1.15, 0.42, 0.24); wheel(0.72, 1.15, 0.42, 0.24);
    add(boxG(0.75, 0.75, 2.0), paint, 0, 1.05, 0.55);   // engine hood
    add(boxG(0.95, 0.5, 0.9), paint, 0, 0.95, -0.7);
    add(boxG(0.5, 0.12, 0.45), RIDE_MAT.dark, 0, 1.3, -0.65);   // seat
    add(boxG(0.5, 0.45, 0.08), RIDE_MAT.dark, 0, 1.55, -0.88);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), RIDE_MAT.dark, 0.25, 1.85, 1.0);   // exhaust
    for (const s of [-1, 1]) for (const e of [-1.05, -0.25]) add(boxG(0.05, 1.3, 0.05), RIDE_MAT.dark, s * 0.6, 2.0, e);   // rollover frame
    add(boxG(1.3, 0.06, 1.0), paint, 0, 2.62, -0.65);   // canopy
    for (const s of [-1, 1]) add(boxG(0.5, 0.08, 1.0), paint, s * 0.85, 1.6, -0.85);   // fenders
    add(boxG(0.5, 0.06, 0.04), RIDE_MAT.head, 0, 1.2, 1.56);
  } else if (type === 'horse') {
    const coat = paint, mane = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.9 });
    const trunk = add(new THREE.SphereGeometry(0.5, 14, 10), coat, 0, 1.3, 0); trunk.scale.set(0.82, 0.85, 1.75);
    const neck = add(new THREE.CylinderGeometry(0.17, 0.27, 0.95, 10), coat, 0, 1.75, 0.82); neck.rotation.x = 0.65;
    const head = add(new THREE.BoxGeometry(0.24, 0.26, 0.6), coat, 0, 2.05, 1.25); head.rotation.x = 0.55;
    add(boxG(0.06, 0.5, 0.75), mane, 0, 1.92, 0.7).rotation.x = 0.65;
    for (const s of [-1, 1]) add(boxG(0.05, 0.14, 0.05), coat, s * 0.08, 2.32, 1.08);   // ears
    const tail = add(new THREE.CylinderGeometry(0.06, 0.1, 0.75, 6), mane, 0, 1.15, -0.95); tail.rotation.x = -0.45;
    add(boxG(0.66, 0.14, 0.7), RIDE_MAT.leather, 0, 1.73, -0.05);   // saddle
    for (const s of [-1, 1]) add(boxG(0.06, 0.4, 0.5), RIDE_MAT.leather, s * 0.42, 1.38, -0.35);   // saddlebags
    for (const [x, z] of [[-0.2, 0.62], [0.2, 0.62], [-0.2, -0.62], [0.2, -0.62]]) {
      const hip = new THREE.Group(); hip.position.set(x, 1.15, z); body.add(hip);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.6, 7), coat); upper.position.y = -0.3; hip.add(upper);
      const knee = new THREE.Group(); knee.position.y = -0.6; hip.add(knee);
      const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 6), coat); lower.position.y = -0.25; knee.add(lower);
      const hoof = new THREE.Mesh(boxG(0.1, 0.06, 0.12), mane); hoof.position.y = -0.52; knee.add(hoof);
      legs.push({ hip, knee, front: z > 0, side: x });
    }
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.rotation.order = 'YXZ';
  g.userData = { body, wheels, legs, gait: 0, lean: 0 };
  return g;
}

/** An abandoned car or pickup by the road: faded paint, sat low on flat tyres, a little skewed. */
export function buildWreck(seed) {
  const type = seed % 3 === 0 ? 'pickup' : 'car';
  const FADED = [0x6e4b35, 0x5d5f5a, 0x7d6a4c, 0x48525a, 0x6b3a2e, 0x8a8577];
  const g = buildRideModel(type, FADED[seed % FADED.length]);
  g.traverse((o) => { if (o.isMesh && o.material?.color && o.material !== RIDE_MAT.tire) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.8); o.material.roughness = 0.95; o.material.metalness = 0.1; } });
  g.userData.body.position.y = -0.12;
  g.userData.body.rotation.z = ((seed % 7) - 3) * 0.012;
  return g;
}

/** The vehicles people live in: an RV, a school bus, a box truck, a houseboat. Built to the size of
 *  the claimable box (`len` along +Z, `wid`, `h`); the lockable door at the back is drawn by the game. */
export function buildHomeVehicle(vtype, len, wid, h, color) {
  const g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
  const trim = new THREE.MeshStandardMaterial({ color: vtype === 'bus' ? 0x1a1a1a : 0x7a5a3a, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); body.add(m); return m; };
  const box = (w, hh, d) => new THREE.BoxGeometry(w, hh, d);
  const wheel = (x, z, r) => { const t = add(new THREE.CylinderGeometry(r, r, 0.3, 14), RIDE_MAT.tire, x, r, z); t.rotation.z = Math.PI / 2; const hub = add(new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.32, 10), RIDE_MAT.rim, x, r, z); hub.rotation.z = Math.PI / 2; };
  const windows = (y, hh, z0, z1, n, inset = 0.02) => {
    const step = (z1 - z0) / n;
    for (const s of [-1, 1]) for (let k = 0; k < n; k++) add(box(0.04, hh, step * 0.72), RIDE_MAT.glass, s * (wid / 2 + inset), y, z0 + step * (k + 0.5));
  };
  if (vtype === 'houseboat') {
    add(box(wid, 0.8, len), new THREE.MeshStandardMaterial({ color: 0x3d4a52, roughness: 0.6 }), 0, 0.3, 0);   // hull
    add(box(wid * 0.82, h - 1.0, len * 0.66), white, 0, 0.7 + (h - 1.0) / 2, -len * 0.08);   // cabin
    add(box(wid * 0.9, 0.12, len * 0.72), paint, 0, h - 0.24, -len * 0.08);   // roof
    windows(1.6, 0.7, -len * 0.38, len * 0.22, 4);
    for (const s of [-1, 1]) add(box(0.05, 0.8, len * 0.96), RIDE_MAT.chrome, s * (wid / 2 - 0.05), 1.1, 0);   // rails
  } else {
    const r = vtype === 'bus' ? 0.52 : 0.46, floor = r * 1.15;
    const bodyH = h - floor;
    if (vtype === 'truck') {
      const cab = Math.min(2.2, len * 0.3);
      add(box(wid, bodyH * 0.72, cab), paint, 0, floor + bodyH * 0.36, len / 2 - cab / 2);   // cab
      add(box(wid * 0.92, bodyH * 0.3, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.55, len / 2 + 0.01);
      add(box(wid, bodyH, len - cab - 0.2), white, 0, floor + bodyH / 2, -cab / 2 - 0.1);   // the box
      add(box(wid + 0.02, 0.25, len - cab - 0.2), paint, 0, floor + bodyH * 0.25, -cab / 2 - 0.1);   // stripe
    } else {
      add(box(wid, bodyH, len), vtype === 'bus' ? paint : white, 0, floor + bodyH / 2, 0);
      if (vtype === 'bus') {
        add(box(wid * 0.9, bodyH * 0.45, 1.2), paint, 0, floor + bodyH * 0.22, len / 2 + 0.6);   // the hood
        for (const y of [floor + bodyH * 0.35, floor + bodyH * 0.18]) add(box(wid + 0.03, 0.08, len), trim, 0, y, 0);   // black rub rails
        windows(floor + bodyH * 0.68, bodyH * 0.32, -len / 2 + 0.6, len / 2 - 1.2, 8);
        add(box(wid * 0.86, bodyH * 0.34, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.7, len / 2 + 0.01);
      } else {   // RV: a stripe down each side, a few windows, a cab-over front, an air conditioner on top
        add(box(wid + 0.02, 0.3, len), trim, 0, floor + bodyH * 0.42, 0);
        add(box(wid + 0.02, 0.1, len), paint, 0, floor + bodyH * 0.55, 0);
        windows(floor + bodyH * 0.72, bodyH * 0.22, -len / 2 + 1.0, len / 2 - 2.2, 3);
        add(box(wid * 0.96, bodyH * 0.3, 1.2), white, 0, floor + bodyH * 0.82, len / 2 + 0.4);   // cab-over
        add(box(wid * 0.9, bodyH * 0.32, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.48, len / 2 + 0.01);
        add(box(0.9, 0.3, 1.0), white, 0, h + 0.15, -len * 0.1);
      }
    }
    for (const s of [-1, 1]) for (const z of [len / 2 - 1.5, -len / 2 + 1.6]) wheel(s * (wid / 2 - 0.15), z, r);
    if (vtype !== 'truck') for (const s of [-1, 1]) add(box(0.1, 0.12, 0.3), RIDE_MAT.head, s * wid * 0.35, floor + 0.35, len / 2 + (vtype === 'bus' ? 1.21 : 0.01));
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
