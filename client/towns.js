// Town life: the real businesses' signs on their buildings, gas stations with their canopies, pumps and
// road signs, customers' cars parked out front, and along the streets of every built-up area street
// lights, parked cars and fire hydrants. Decoration only: none of it is solid or changes the map, so
// it can't move anyone's home or change the game. Built a cell at a time around you.
//
// The businesses are real (data/real/businesses.json, from Overture's places data): their names in
// their usual colours, no logos.
import * as THREE from 'three';
import { project } from '/shared/geography.js';
import { COVER } from '/shared/terrain.js';
import { buildRideModel } from '/ridemodels.js';

const CELL = 160, RANGE = 420;
// Colours for well-known names (background, text, a stripe), else by kind of business.
const BRANDS = [
  [/dollar general/i, '#ffd200', '#111111', null],
  [/family dollar/i, '#e8601c', '#ffffff', null],
  [/dollar tree/i, '#1f7a3a', '#ffffff', null],
  [/piggly/i, '#d3202f', '#ffffff', null],
  [/chevron/i, '#ffffff', '#0b4ea2', '#d3202f'],
  [/\bbp\b/i, '#0f8a3c', '#ffe200', null],
  [/exxon/i, '#ffffff', '#d3202f', '#0b4ea2'],
  [/shell/i, '#ffd200', '#d3202f', null],
  [/subway/i, '#0a7a3c', '#ffc600', null],
  [/ace hardware/i, '#d3202f', '#ffffff', null],
  [/hardee|mcdonald|burger|wendy|kfc|pizza|sonic|taco/i, '#c8102e', '#ffd200', null],
  [/bank|credit union/i, '#14325c', '#ffffff', null],
  [/sheriff|police|courthouse|city hall|county|emergency|fire/i, '#203a2a', '#f2e6c8', null],
];
const BY_KIND = [
  [/restaurant|food|cafe|coffee|diner|bar|grill|bakery|sandwich|pizza|bbq/i, '#6b1d1d', '#ffe8c2'],
  [/gas|fuel|convenience/i, '#1d2b4f', '#ffffff'],
  [/grocery|market|store|shop|boutique|discount|pharmacy|drug/i, '#22303f', '#ffffff'],
  [/auto|tire|repair|mechanic|parts/i, '#2a2a2a', '#ffcf3a'],
  [/salon|beauty|spa|nail|hair|barber/i, '#5a2050', '#ffffff'],
  [/hotel|motel|inn|lodge/i, '#24325a', '#ffe7a8'],
];
const styleOf = (name, cat) => {
  for (const [re, bg, fg, stripe] of BRANDS) if (re.test(name)) return { bg, fg, stripe };
  for (const [re, bg, fg] of BY_KIND) if (re.test(cat)) return { bg, fg, stripe: null };
  return { bg: '#1d2430', fg: '#ffffff', stripe: null };
};
const isGas = (cat, name) => /gas_station|fueling/.test(cat) || /chevron|exxon|\bbp\b|shell|marathon|texaco|citgo|sunoco/i.test(name);
const wantsParking = (cat) => /store|grocery|market|restaurant|food|sandwich|gas|fuel|pharmacy|bank|hardware|auto|shop|discount|motel|cafe/i.test(cat);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** A sign face (canvas texture) with the name fitted to it. */
function signTexture(name, st, sub = '') {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = st.bg; g.fillRect(0, 0, 1024, 256);
  if (st.stripe) { g.fillStyle = st.stripe; g.fillRect(0, 214, 1024, 42); }
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 10; g.strokeRect(5, 5, 1014, 246);
  g.fillStyle = st.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const text = name.replace(/\s+-\s+.*$/, '').toUpperCase();
  let size = 150;
  g.font = `800 ${size}px Archivo, "Arial Black", sans-serif`;
  while (g.measureText(text).width > 940 && size > 40) { size -= 6; g.font = `800 ${size}px Archivo, "Arial Black", sans-serif`; }
  g.fillText(text, 512, sub ? 108 : 124, 960);
  if (sub) { g.font = '700 48px Archivo, Arial, sans-serif'; g.fillText(sub, 512, 196, 960); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

// Shared parts.
const M = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
const MAT = {
  pole: M(0x4a4d52, { metalness: 0.4, roughness: 0.5 }), lamp: M(0xfff4d6, { emissive: 0x443a22, roughness: 0.3 }),
  hydrant: M(0xc8231e, { roughness: 0.5 }), canopy: M(0xf2f2f0, { roughness: 0.5 }), post: M(0xd8d8d8, { metalness: 0.3 }),
  island: M(0xb8b4ac), pump: M(0x2d2f33, { roughness: 0.5 }), dark: M(0x222428),
};
const GEO = {
  pole: new THREE.CylinderGeometry(0.09, 0.12, 7.5, 8).translate(0, 3.75, 0),
  arm: new THREE.BoxGeometry(0.08, 0.08, 1.8).translate(0, 7.4, 0.85),
  lamp: new THREE.BoxGeometry(0.35, 0.14, 0.6).translate(0, 7.3, 1.7),
  hydrant: new THREE.CylinderGeometry(0.16, 0.2, 0.75, 10).translate(0, 0.375, 0),
  box: new THREE.BoxGeometry(1, 1, 1),
};
for (const g of Object.values(GEO)) g.userData.shared = true;
const FRESH = [0xb8b8bc, 0x1d1d20, 0x8a1c1c, 0x2a4a7a, 0xe8e8e8, 0x5a5f66, 0x6b4a2a, 0x24482e];

export function createTownDressing(scene, map, rows, ground) {
  const size = map.size;
  // Businesses on the map, by cell.
  const biz = new Map();
  for (const r of rows || []) {
    const [lat, lon, cat, name] = r;
    const p = project(lat, lon, size);
    if (Math.abs(p.x) > size / 2 || Math.abs(p.z) > size / 2) continue;
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    if (!biz.has(k)) biz.set(k, []);
    biz.get(k).push({ x: p.x, z: p.z, cat, name });
  }
  const cells = new Map();
  const isBuilding = (b) => /^(building|civic|warehouse|barn|home|farmhouse|housewall)$/.test(b.type) && b.h > 2;
  const frameOf = (b) => b.ang != null ? { cx: b.cx, cz: b.cz, hw: b.hw, hd: b.hd, ca: b.ca ?? Math.cos(b.ang), sa: b.sa ?? Math.sin(b.ang) }
    : { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, hw: (b.maxX - b.minX) / 2, hd: (b.maxZ - b.minZ) / 2, ca: 1, sa: 0 };
  const solidAt = (x, z, pad = 0.6) => map.grid.near(x, z, 6).some((b) => b.h > 1 && x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad);
  const nearestRoad = (x, z, R = 120) => {
    let best = null;
    for (const r of map.roadsNear(x, z, R)) {
      const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2));
      const qx = r.x1 + dx * t, qz = r.z1 + dz * t, d = Math.hypot(qx - x, qz - z);
      if (!best || d < best.d) best = { d, x: qx, z: qz, r };
    }
    return best;
  };
  const roadClear = (x, z, gap) => { const n = nearestRoad(x, z, 30); return !n || n.d > (n.r.width || 8) / 2 + gap; };
  const inTown = (x, z) => (map.terrain.hasCover ? map.terrain.cover(x, z) === COVER.town : map.towns.some((t) => x > t.rect.minX && x < t.rect.maxX && z > t.rect.minZ && z < t.rect.maxZ));

  function buildCell(cx, cz) {
    const grp = new THREE.Group(), mats = [], lights = [], hydrants = [];
    const add = (o) => { grp.add(o); return o; };
    let cars = 0;
    const park = (x, z, yaw, seed) => {
      if (cars >= 16 || solidAt(x, z, 1.2)) return;
      const car = buildRideModel(seed % 4 === 0 ? 'pickup' : 'car', FRESH[seed % FRESH.length]);
      car.position.set(x, ground(x, z), z); car.rotation.y = yaw;
      add(car); cars++;
    };
    // ---- businesses: a sign on the building, facing the road (or on a post if it has no building)
    for (const bz of biz.get(`${cx},${cz}`) || []) {
      const st = styleOf(bz.name, bz.cat), gas = isGas(bz.cat, bz.name), seed = hash(bz.name);
      let bld = null, bd = 32;
      for (const b of map.grid.near(bz.x, bz.z, 40)) {
        if (!isBuilding(b)) continue;
        const f = frameOf(b), lx = (bz.x - f.cx) * f.ca + (bz.z - f.cz) * f.sa, lz = -(bz.x - f.cx) * f.sa + (bz.z - f.cz) * f.ca;
        const d = Math.hypot(Math.max(0, Math.abs(lx) - f.hw), Math.max(0, Math.abs(lz) - f.hd));
        if (d < bd) { bd = d; bld = b; }
      }
      const road = nearestRoad(bz.x, bz.z, 150);
      if (!bld) {
        // A sign on a post by the road.
        const tex = signTexture(bz.name, st); const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }); mats.push(m);
        const sx = road ? bz.x + (road.x - bz.x) * 0.3 : bz.x, sz = road ? bz.z + (road.z - bz.z) * 0.3 : bz.z, y = ground(sx, sz);
        const pole = add(new THREE.Mesh(GEO.box, MAT.pole)); pole.scale.set(0.15, 4, 0.15); pole.position.set(sx, y + 2, sz);
        const s = add(new THREE.Mesh(GEO.box, [MAT.dark, MAT.dark, MAT.dark, MAT.dark, m, m])); s.scale.set(3.2, 0.8, 0.15); s.position.set(sx, y + 4.2, sz);
        if (road) s.rotation.y = Math.atan2(road.x - sx, road.z - sz);
        continue;
      }
      const f = frameOf(bld), top = (bld.y0 || 0) + bld.h;
      // Which wall faces the road: the building's own axes, the one pointing most at it.
      const tx = road ? road.x - f.cx : 0, tz = road ? road.z - f.cz : 1;
      const faces = [[f.ca, f.sa, f.hw, f.hd], [-f.ca, -f.sa, f.hw, f.hd], [-f.sa, f.ca, f.hd, f.hw], [f.sa, -f.ca, f.hd, f.hw]];
      const [nx, nz, out, along] = faces.reduce((a, b) => (b[0] * tx + b[1] * tz > a[0] * tx + a[1] * tz ? b : a));
      const ux = -nz, uz = nx;   // along the wall
      const w = Math.max(2.4, Math.min(along * 2 * 0.8, 1.8 + bz.name.length * 0.32, 12)), hgt = Math.min(1.7, w / 3.6);
      const tex = signTexture(bz.name, st);
      const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }); mats.push(m);
      const sign = add(new THREE.Mesh(GEO.box, [MAT.dark, MAT.dark, MAT.dark, MAT.dark, m, MAT.dark]));
      sign.scale.set(w, hgt, 0.18);
      const sy = Math.max((bld.y0 || 0) + 2.6, Math.min(top - hgt / 2 - 0.25, (bld.y0 || 0) + 4.4));
      sign.position.set(f.cx + nx * (out + 0.12), sy, f.cz + nz * (out + 0.12));
      sign.rotation.y = Math.atan2(nx, nz);
      // Out front: a gas station's canopy and pumps, or a few customers' cars.
      const fx = f.cx + nx * out, fz = f.cz + nz * out;
      if (gas) {
        const gx = fx + nx * 10, gz = fz + nz * 10, gy = ground(gx, gz);
        if (!solidAt(gx, gz, 2) && roadClear(gx, gz, 3)) {
          const can = new THREE.Group(); can.position.set(gx, gy, gz); can.rotation.y = Math.atan2(nx, nz); add(can);
          const roof = new THREE.Mesh(GEO.box, MAT.canopy); roof.scale.set(13, 0.7, 8); roof.position.y = 5.1; can.add(roof);
          const band = new THREE.Mesh(GEO.box, M(new THREE.Color(st.stripe || st.bg).getHex(), { roughness: 0.5 })); band.scale.set(13.05, 0.32, 8.05); band.position.y = 5.0; can.add(band);
          for (const [px, pz] of [[-4.5, -2.5], [4.5, -2.5], [-4.5, 2.5], [4.5, 2.5]]) { const p = new THREE.Mesh(GEO.box, MAT.post); p.scale.set(0.35, 4.8, 0.35); p.position.set(px, 2.4, pz); can.add(p); }
          for (const px of [-3, 3]) {
            const isl = new THREE.Mesh(GEO.box, MAT.island); isl.scale.set(1.1, 0.25, 4.2); isl.position.set(px, 0.12, 0); can.add(isl);
            for (const pz of [-1.1, 1.1]) { const pu = new THREE.Mesh(GEO.box, MAT.pump); pu.scale.set(0.6, 1.6, 0.5); pu.position.set(px, 1.05, pz); can.add(pu); }
          }
          can.traverse((o) => { if (o.isMesh) o.castShadow = true; });
          if (seed % 3) park(gx + ux * 1.6, gz + uz * 1.6, Math.atan2(nx, nz) + Math.PI / 2, seed);
        }
        // The tall sign by the road.
        if (road) {
          const px = road.x + (fx - road.x) * Math.min(1, ((road.r.width || 8) / 2 + 3) / Math.max(1, road.d)), pz = road.z + (fz - road.z) * Math.min(1, ((road.r.width || 8) / 2 + 3) / Math.max(1, road.d));
          if (!solidAt(px, pz, 0.8)) {
            const py = ground(px, pz), pt = signTexture(bz.name, st, 'REGULAR  ·  DIESEL'), pm = new THREE.MeshStandardMaterial({ map: pt, roughness: 0.6, emissive: 0xffffff, emissiveMap: pt, emissiveIntensity: 0.3 }); mats.push(pm);
            const pole = add(new THREE.Mesh(GEO.box, MAT.pole)); pole.scale.set(0.3, 6.5, 0.3); pole.position.set(px, py + 3.25, pz);
            const s = add(new THREE.Mesh(GEO.box, [MAT.dark, MAT.dark, MAT.dark, MAT.dark, pm, pm])); s.scale.set(3.6, 1.6, 0.3); s.position.set(px, py + 6.8, pz);
            s.rotation.y = Math.atan2(road.r.x2 - road.r.x1, road.r.z2 - road.r.z1) + Math.PI / 2;
          }
        }
      } else if (wantsParking(bz.cat)) {
        const n = 2 + (seed % 3);
        for (let k = 0; k < n; k++) {
          const off = (k - (n - 1) / 2) * 3.0 + ((seed >> 4) % 3 - 1) * 0.6;
          if (Math.abs(off) > along + 2) continue;
          const px = fx + nx * 5.5 + ux * off, pz = fz + nz * 5.5 + uz * off;
          if (roadClear(px, pz, 1.5)) park(px, pz, Math.atan2(-nx, -nz) + ((seed >> k) % 2 ? Math.PI : 0) * 0, seed + k * 7);
        }
      }
    }
    // ---- streets in built-up areas: lights, cars at the curb, hydrants
    const x0 = cx * CELL, z0 = cz * CELL;
    for (const r of map.roadsNear(x0 + CELL / 2, z0 + CELL / 2, CELL * 0.75)) {
      if (r.dirt) continue;
      const mx = (r.x1 + r.x2) / 2, mz = (r.z1 + r.z2) / 2;
      if (mx < x0 || mx >= x0 + CELL || mz < z0 || mz >= z0 + CELL || !inTown(mx, mz)) continue;
      const dx = r.x2 - r.x1, dz = r.z2 - r.z1, len = Math.hypot(dx, dz);
      if (len < 6) continue;
      const ux = dx / len, uz = dz / len, nx = -uz, nz = ux, half = (r.width || 8) / 2, seed = hash(`${Math.round(r.x1)},${Math.round(r.z1)}`);
      for (let t = 6 + (seed % 20), k = 0; t < len - 3; t += 34, k++) {
        const s = k % 2 ? 1 : -1, px = r.x1 + ux * t + nx * s * (half + 1.3), pz = r.z1 + uz * t + nz * s * (half + 1.3);
        if (!solidAt(px, pz) && map.terrain.height(px, pz) > 0.3) lights.push([px, pz, Math.atan2(-nx * s, -nz * s)]);
      }
      for (let t = 20 + (seed % 40); t < len - 3; t += 85) {
        const px = r.x1 + ux * t + nx * (half + 2.2), pz = r.z1 + uz * t + nz * (half + 2.2);
        if (!solidAt(px, pz)) hydrants.push([px, pz]);
      }
      if (!r.hw) for (let t = 5, k = 0; t < len - 4; t += 7, k++) {
        if ((seed >> (k % 24)) % 5) continue;   // about one curb space in five taken
        const s = (seed >> (k % 13)) % 2 ? 1 : -1, px = r.x1 + ux * t + nx * s * (half + 1.1), pz = r.z1 + uz * t + nz * s * (half + 1.1);
        park(px, pz, Math.atan2(ux, uz) + (s > 0 ? 0 : Math.PI), seed + k);
      }
    }
    if (lights.length) {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      for (const [geo, mat] of [[GEO.pole, MAT.pole], [GEO.arm, MAT.pole], [GEO.lamp, MAT.lamp]]) {
        const im = new THREE.InstancedMesh(geo, mat, lights.length);
        lights.forEach(([x, z, yaw], i) => { q.setFromAxisAngle(up, yaw); im.setMatrixAt(i, m4.compose(new THREE.Vector3(x, ground(x, z), z), q, one)); });
        im.castShadow = geo === GEO.pole; add(im);
      }
    }
    if (hydrants.length) {
      const im = new THREE.InstancedMesh(GEO.hydrant, MAT.hydrant, hydrants.length), m4 = new THREE.Matrix4();
      hydrants.forEach(([x, z], i) => im.setMatrixAt(i, m4.makeTranslation(x, ground(x, z), z))); add(im);
    }
    grp.userData.mats = mats;
    scene.add(grp);
    return grp;
  }
  function dispose(grp) {
    scene.remove(grp);
    for (const m of grp.userData.mats) { m.map?.dispose(); m.dispose(); }
    grp.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  return {
    /** Build what's near (a cell per call at most) and drop what's far. */
    update(px, pz) {
      const ci = Math.floor(px / CELL), cj = Math.floor(pz / CELL), n = Math.ceil(RANGE / CELL);
      let built = false;
      for (let r = 0; r <= n && !built; r++) for (let i = ci - r; i <= ci + r && !built; i++) for (let j = cj - r; j <= cj + r && !built; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        const k = `${i},${j}`;
        if (cells.has(k)) continue;
        cells.set(k, buildCell(i, j)); built = true;
      }
      for (const [k, g] of cells) {
        const [i, j] = k.split(',').map(Number);
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) > n + 1) { dispose(g); cells.delete(k); }
      }
    },
    /** For night: how bright the street lamps and signs glow (0..1). */
    setGlow(k) { MAT.lamp.emissive.setRGB(0.27 + k * 0.73, 0.23 + k * 0.6, 0.13 + k * 0.35); for (const g of cells.values()) for (const m of g.userData.mats) m.emissiveIntensity = 0.25 + k * 0.75; },
  };
}
