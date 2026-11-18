// Real places you can see on the ground (the map's labels say where they are; this is what's there):
//   - Town signs: the green road signs where each road comes into a town. Bristol and Blountstown are
//     cities, so theirs say CITY LIMIT; the unincorporated communities (Hosford, Telogia, Lake Mystic...)
//     get their name alone, the way Florida signs them. One on the right of each way in, facing you.
//   - Veterans Memorial Park, Bristol (10561 NW Theo Jacobs Way, behind the Veterans Memorial Civic
//     Center): its sign, the flag, a picnic pavilion and tables, and the loop of the Veterans Memorial
//     Railroad with its little engine.
//   - Torreya State Park: the brown state park sign at the road in (the park's ranger station is part
//     of the map: shared/world.js).
// Decoration only: none of it is solid or changes the map. Built once, at the start.
import * as THREE from 'three';
import { project } from '/shared/geography.js';

const M = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });
const MAT = {
  post: M(0x8a8f96, { metalness: 0.5, roughness: 0.45 }), back: M(0x9aa0a6, { metalness: 0.4, roughness: 0.5 }),
  wood: M(0x6b4a2e, { roughness: 0.9 }), roof: M(0x5a2f22, { roughness: 0.8 }), white: M(0xe9e6df),
  rail: M(0x3a3a3c, { metalness: 0.5, roughness: 0.5 }), ties: M(0x4a3626, { roughness: 0.95 }),
  loco: M(0x1d1f22, { metalness: 0.3, roughness: 0.5 }), red: M(0xa8261e, { roughness: 0.55 }), brass: M(0xc7a046, { metalness: 0.6, roughness: 0.35 }),
};
const BOX = new THREE.BoxGeometry(1, 1, 1), CYL = new THREE.CylinderGeometry(1, 1, 1, 12);

/** A road sign's face: a colour, a white border, one or two lines of white text. */
function signFace(lines, bg, w = 1024, h = 448) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff'; g.lineWidth = 14; g.beginPath(); g.roundRect(18, 18, w - 36, h - 36, 26); g.stroke();
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const rows = lines.length, step = (h - 80) / rows;
  lines.forEach(([text, px], i) => {
    let size = px;
    g.font = `700 ${size}px "Highway Gothic", "Roadgeek 2005 Series D", Archivo, Arial, sans-serif`;
    while (g.measureText(text).width > w - 120 && size > 30) { size -= 4; g.font = `700 ${size}px Archivo, Arial, sans-serif`; }
    g.fillText(text, w / 2, 40 + step * (i + 0.5));
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function createPlaces(scene, map, ground) {
  const root = new THREE.Group(); root.name = 'places';
  scene.add(root);
  const part = (geo, mat, x, y, z, sx, sy, sz, parent = root) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = true; parent.add(m); return m; };
  const solidNear = (x, z, r) => map.grid.near(x, z, r).some((b) => !b.gone && b.type !== 'tree' && b.type !== 'pine' && b.type !== 'scrub' && x + r > b.minX && x - r < b.maxX && z + r > b.minZ && z - r < b.maxZ);
  const places = [];   // { name, x, z, r }: for "where you are"

  /** A sign on two posts, its face toward `face` (radians, like rotation.y), the panel's bottom `lift` up. */
  function roadSign(x, z, face, tex, w, h, lift = 1.9) {
    const g = new THREE.Group(); g.position.set(x, ground(x, z), z); g.rotation.y = face; root.add(g);
    for (const s of [-1, 1]) part(CYL, MAT.post, s * w * 0.32, (lift + h) / 2, -0.06, 0.05, lift + h, 0.05, g);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
    panel.position.set(0, lift + h / 2, 0.01); g.add(panel);
    part(BOX, MAT.back, 0, lift + h / 2, -0.02, w, h, 0.04, g);
    return g;
  }

  // ---- town signs: where each road comes in to a town
  const CITY = new Set(['Bristol', 'Blountstown']);
  const RADIUS = { Bristol: 1250, Blountstown: 1400 };
  const towns = [...map.towns.map((t) => ({ name: t.name, x: t.x, z: t.z })), ...(map.communities || []).map((c) => ({ name: c.name, x: c.x, z: c.z }))];
  const faces = new Map();
  const faceFor = (name) => {
    if (!faces.has(name)) faces.set(name, CITY.has(name) ? signFace([[name.toUpperCase(), 190], ['CITY LIMIT', 120]], '#00653a') : signFace([[name.toUpperCase(), 210]], '#00653a', 1024, 300));
    return faces.get(name);
  };
  const placed = [];
  for (const t of towns) {
    const R = RADIUS[t.name] || 600;
    for (const r of map.roadsNear(t.x, t.z, R + 60)) {
      if (r.dirt || !(r.hw || ['trunk', 'primary', 'secondary', 'tertiary'].includes(r.cls))) continue;
      const d1 = Math.hypot(r.x1 - t.x, r.z1 - t.z), d2 = Math.hypot(r.x2 - t.x, r.z2 - t.z);
      if ((d1 - R) * (d2 - R) >= 0) continue;   // doesn't cross the edge of town
      const k = (R - d1) / (d2 - d1), cx = r.x1 + (r.x2 - r.x1) * k, cz = r.z1 + (r.z2 - r.z1) * k;
      // Coming in: from the end outside toward the end inside.
      const out = d1 > d2 ? [r.x1, r.z1] : [r.x2, r.z2], inn = d1 > d2 ? [r.x2, r.z2] : [r.x1, r.z1];
      const len = Math.hypot(inn[0] - out[0], inn[1] - out[1]) || 1, ux = (inn[0] - out[0]) / len, uz = (inn[1] - out[1]) / len;
      if (placed.some((p) => p.name === t.name && Math.hypot(p.x - cx, p.z - cz) < 150)) continue;
      const off = (r.width || 8) / 2 + 2.2, sx = cx - uz * off, sz = cz + ux * off;   // on your right as you come in
      if (Math.abs(sx) > map.half - 30 || Math.abs(sz) > map.half - 30 || solidNear(sx, sz, 1) || ground(sx, sz) < 0.3) continue;
      const city = CITY.has(t.name);
      roadSign(sx, sz, Math.atan2(-ux, -uz), faceFor(t.name), city ? 3.4 : 3.0, city ? 1.5 : 0.9);
      placed.push({ name: t.name, x: cx, z: cz });
    }
  }

  // ---- parks
  const nearestRoad = (x, z, r) => {
    let best = null, bd = Infinity;
    for (const s of map.roadsNear(x, z, r)) {
      if (s.dirt) continue;
      const dx = s.x2 - s.x1, dz = s.z2 - s.z1, l2 = dx * dx + dz * dz || 1, k = Math.max(0, Math.min(1, ((x - s.x1) * dx + (z - s.z1) * dz) / l2));
      const px = s.x1 + dx * k, pz = s.z1 + dz * k, d = Math.hypot(px - x, pz - z);
      if (d < bd) { bd = d; best = { s, px, pz, d }; }
    }
    return best;
  };
  /** A park's sign beside the road nearest (x, z), facing the road. */
  const parkSign = (x, z, tex, w, h) => {
    const n = nearestRoad(x, z, 400);
    if (!n) return;
    const ax = x - n.px, az = z - n.pz, l = Math.hypot(ax, az) || 1;
    const off = (n.s.width || 8) / 2 + 3, sx = n.px + ax / l * off, sz = n.pz + az / l * off;
    const g = new THREE.Group(); g.position.set(sx, ground(sx, sz), sz); g.rotation.y = Math.atan2(-ax / l, -az / l); root.add(g);
    for (const s of [-1, 1]) part(BOX, MAT.wood, s * (w / 2 + 0.1), 0.9, 0, 0.22, 1.8, 0.22, g);   // wooden uprights
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    panel.position.set(0, 0.55 + h / 2, 0.08); g.add(panel);
    part(BOX, MAT.wood, 0, 0.55 + h / 2, 0, w + 0.1, h + 0.1, 0.14, g);
  };

  // Torreya State Park: its sign at the road in.
  const torreya = (map.landmarks || []).find((l) => /Torreya/.test(l.name));
  if (torreya) {
    parkSign(torreya.x, torreya.z, signFace([['TORREYA', 200], ['STATE PARK', 130], ['Florida State Parks', 70]], '#6b4423', 1024, 560), 3.6, 2.0);
    places.push({ name: 'Torreya State Park', x: torreya.x, z: torreya.z, r: 220 });
  }

  // Veterans Memorial Park, Bristol: south of NW Theo Jacobs Way, behind the civic center.
  {
    const c = project(30.4214, -84.9789, map.size);
    if (Math.abs(c.x) < map.half && Math.abs(c.z) < map.half) {
      places.push({ name: 'Veterans Memorial Park', x: c.x, z: c.z, r: 130 });
      parkSign(c.x - 40, c.z - 40, signFace([['VETERANS MEMORIAL', 150], ['PARK', 150], ['Veterans Memorial Railroad', 64]], '#1e4d2b', 1024, 560), 3.6, 2.0);
      const at = (dx, dz, r) => { const x = c.x + dx, z = c.z + dz; return solidNear(x, z, r) ? null : { x, z, y: ground(x, z) }; };
      // The flag.
      { const p = at(-30, -30, 1);
        if (p) {
          part(CYL, MAT.white, p.x, p.y + 6, p.z, 0.07, 12, 0.07);
          const fc = document.createElement('canvas'); fc.width = 380; fc.height = 200; const g = fc.getContext('2d');
          for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#ffffff' : '#b22234'; g.fillRect(0, i * 200 / 13, 380, 200 / 13 + 1); }
          g.fillStyle = '#3c3b6e'; g.fillRect(0, 0, 152, 108);
          g.fillStyle = '#ffffff'; for (let r = 0; r < 9; r++) for (let k = 0; k < (r % 2 ? 5 : 6); k++) { g.beginPath(); g.arc(13 + k * 25 + (r % 2 ? 12 : 0), 7 + r * 11.5, 3, 0, 7); g.fill(); }
          const ft = new THREE.CanvasTexture(fc); ft.colorSpace = THREE.SRGBColorSpace;
          const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.0), new THREE.MeshStandardMaterial({ map: ft, side: THREE.DoubleSide, roughness: 0.8 }));
          flag.position.set(p.x + 0.97, p.y + 11.3, p.z); root.add(flag);
        } }
      // The picnic pavilion and its tables.
      { const p = at(0, -10, 6);
        if (p) {
          for (const [a, b] of [[-4.5, -3], [4.5, -3], [-4.5, 3], [4.5, 3]]) part(BOX, MAT.wood, p.x + a, p.y + 1.5, p.z + b, 0.25, 3, 0.25);
          const roof = part(BOX, MAT.roof, p.x, p.y + 3.25, p.z, 10.4, 0.25, 7.4); roof.receiveShadow = true;
          part(BOX, MAT.roof, p.x, p.y + 3.7, p.z, 8, 0.6, 5);   // the roof's raised middle
          for (const [a, b] of [[-2.4, -1.3], [2.4, -1.3], [-2.4, 1.3], [2.4, 1.3]]) {
            const x = p.x + a, z = p.z + b, y = p.y;
            part(BOX, MAT.wood, x, y + 0.75, z, 1.9, 0.07, 0.8);   // top
            for (const s of [-1, 1]) part(BOX, MAT.wood, x, y + 0.45, z + s * 0.62, 1.9, 0.05, 0.28);   // benches
            for (const s of [-1, 1]) part(BOX, MAT.wood, x + s * 0.75, y + 0.37, z, 0.08, 0.74, 1.4);   // legs
          }
        } }
      // The railroad: a loop of track and the little engine and its cars on it.
      { const p = at(20, 25, 2);
        if (p) {
          const A = 32, B = 16, n = 90;   // an oval, A by B metres across the halves
          const tie = new THREE.InstancedMesh(BOX, MAT.ties, n), rail = new THREE.InstancedMesh(BOX, MAT.rail, n * 2);
          const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2, x = p.x + Math.cos(a) * A, z = p.z + Math.sin(a) * B, y = ground(x, z);
            const tx = -Math.sin(a) * A, tz = Math.cos(a) * B, yaw = Math.atan2(tx, tz), seg = (Math.PI * 2 / n) * Math.hypot(tx, tz);
            q.setFromAxisAngle(up, yaw);
            tie.setMatrixAt(i, m4.compose(new THREE.Vector3(x, y + 0.04, z), q, new THREE.Vector3(1.0, 0.08, 0.18)));
            for (const [k, s] of [[0, -0.32], [1, 0.32]]) rail.setMatrixAt(i * 2 + k, m4.compose(new THREE.Vector3(x + Math.cos(yaw) * s, y + 0.12, z - Math.sin(yaw) * s), q, new THREE.Vector3(0.06, 0.08, seg * 1.02)));
          }
          tie.receiveShadow = true; root.add(tie, rail);
          // The engine and two open riding cars, at the near side of the loop.
          const a0 = Math.PI * 0.5, train = new THREE.Group();
          const ex = p.x + Math.cos(a0) * A, ez = p.z + Math.sin(a0) * B;
          train.position.set(ex, ground(ex, ez) + 0.2, ez); train.rotation.y = Math.atan2(-Math.sin(a0) * A, Math.cos(a0) * B); root.add(train);
          part(BOX, MAT.loco, 0, 0.45, 0, 0.7, 0.5, 2.2, train);   // frame and boiler base
          const boiler = part(CYL, MAT.loco, 0, 0.95, 0.35, 0.33, 1.5, 0.33, train); boiler.rotation.x = Math.PI / 2;
          part(CYL, MAT.loco, 0, 1.45, 0.95, 0.12, 0.5, 0.12, train);   // smokestack
          part(CYL, MAT.brass, 0, 1.33, 0.25, 0.1, 0.25, 0.1, train);   // the dome
          part(BOX, MAT.red, 0, 1.1, -0.75, 0.8, 0.9, 0.8, train);      // the cab
          part(BOX, MAT.loco, 0, 1.6, -0.75, 0.95, 0.08, 1.0, train);   // its roof
          for (const s of [-1, 1]) for (const k of [-0.7, 0, 0.7]) { const w = part(CYL, MAT.red, s * 0.38, 0.25, k, 0.22, 0.08, 0.22, train); w.rotation.z = Math.PI / 2; }
          for (let i = 1; i <= 2; i++) {   // riding cars behind
            const zc = -1.2 - i * 2.1;
            part(BOX, MAT.red, 0, 0.5, zc, 0.75, 0.35, 1.8, train);
            part(BOX, MAT.wood, 0, 0.72, zc, 0.55, 0.06, 1.6, train);   // the bench
          }
        } }
    }
  }

  return {
    /** The park you're in, if any (for "where you are"). */
    placeAt(x, z) { for (const p of places) if (Math.hypot(x - p.x, z - p.z) < p.r) return p.name; return ''; },
    signs: placed,
  };
}
