// Streams the 8 km world around the player in chunks. Each chunk merges all of its static boxes
// into a couple of draw calls (and instances its trees), and chunks beyond view range are freed,
// so the GPU only ever holds a few hundred metres of city — fine even on a phone.
import * as THREE from 'three';

const CHUNK = 160;
const COLORS = {
  building: [0.62, 0.6, 0.57], warehouse: [0.5, 0.47, 0.42], farmhouse: [0.72, 0.66, 0.55], barn: [0.55, 0.22, 0.18],
  housewall: [0.54, 0.43, 0.32], ownwall: [0.31, 0.54, 0.35], crate: [1.0, 0.54, 0.16], cover: [0.61, 0.61, 0.58],
  rock: [0.48, 0.48, 0.46], border: [0.17, 0.18, 0.2], car: [0.45, 0.2, 0.2],
};
const CAR_COLORS = [[0.48, 0.13, 0.13], [0.16, 0.25, 0.42], [0.27, 0.27, 0.27], [0.73, 0.71, 0.6], [0.18, 0.35, 0.23]];

function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#5a6672'; g.fillRect(10, 14, 44, 30);
  g.fillStyle = '#c9c9c9'; g.fillRect(10, 44, 44, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#56653f'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${70 + v},${86 + v},${50 + v / 2})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Append a box (no bottom face) to flat geometry arrays. */
function pushBox(buf, b, color, tile) {
  const { minX, minZ, maxX, maxZ, h } = b;
  const faces = [
    // normal, 4 corners (counter-clockwise from outside), uv size
    [[1, 0, 0], [[maxX, 0, maxZ], [maxX, 0, minZ], [maxX, h, minZ], [maxX, h, maxZ]], maxZ - minZ],
    [[-1, 0, 0], [[minX, 0, minZ], [minX, 0, maxZ], [minX, h, maxZ], [minX, h, minZ]], maxZ - minZ],
    [[0, 0, 1], [[minX, 0, maxZ], [maxX, 0, maxZ], [maxX, h, maxZ], [minX, h, maxZ]], maxX - minX],
    [[0, 0, -1], [[maxX, 0, minZ], [minX, 0, minZ], [minX, h, minZ], [maxX, h, minZ]], maxX - minX],
    [[0, 1, 0], [[minX, h, maxZ], [maxX, h, maxZ], [maxX, h, minZ], [minX, h, minZ]], 0],
  ];
  for (const [n, corners, width] of faces) {
    const base = buf.pos.length / 3;
    const top = n[1] === 1;
    corners.forEach(([x, y, z], i) => {
      buf.pos.push(x, y, z);
      buf.nor.push(...n);
      const shade = top ? 0.85 : 1;
      buf.col.push(color[0] * shade, color[1] * shade, color[2] * shade);
      if (buf.uv) {
        if (!tile || top) buf.uv.push(0.02, 0.02);   // a plain wall pixel of the window texture
        else buf.uv.push(((i === 1 || i === 2) ? width : 0) / tile, (y > 0 ? h : 0) / tile);
      }
    });
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
function toGeometry(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  if (buf.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}

export function createWorldView(scene, map, { viewRange = 300, mobile = false } = {}) {
  const chunks = new Map();
  let ownHouseId = null;
  const texturedMat = new THREE.MeshStandardMaterial({ map: windowTexture(), vertexColors: true, roughness: 0.9 });
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.ConeGeometry(1, 1, 7);
  crownGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f5129, roughness: 1 });

  // Ground, town pads and roads (static, built once).
  const groundTex = groundTexture();
  groundTex.repeat.set(map.size / 24, map.size / 24);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.size + 400, map.size + 400), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const flat = { pos: [], nor: [], col: [], idx: [] };
  const quad = (pts, y, c) => {
    const base = flat.pos.length / 3;
    for (const [x, z] of pts) { flat.pos.push(x, y, z); flat.nor.push(0, 1, 0); flat.col.push(...c); }
    flat.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (const r of map.roads) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l = Math.hypot(dx, dz);
    const nx = -dz / l * 4, nz = dx / l * 4;
    quad([[r.x1 + nx, r.z1 + nz], [r.x2 + nx, r.z2 + nz], [r.x2 - nx, r.z2 - nz], [r.x1 - nx, r.z1 - nz]], 0.02, [0.24, 0.25, 0.26]);
  }
  for (const t of map.towns) {
    const q = t.rect;
    quad([[q.minX, q.minZ], [q.maxX, q.minZ], [q.maxX, q.maxZ], [q.minX, q.maxZ]], 0.03, [0.26, 0.27, 0.29]);
  }
  const flats = new THREE.Mesh(toGeometry(flat), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 }));
  flats.receiveShadow = true;
  scene.add(flats);

  function buildChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const list = map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK).filter((b) => {
      const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
      return mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK;
    });
    const tex = { pos: [], nor: [], col: [], uv: [], idx: [] };
    const plain = { pos: [], nor: [], col: [], idx: [] };
    const trees = [];
    for (const b of list) {
      if (b.type === 'terminal') continue;            // drawn separately (their state changes)
      if (b.type === 'tree') { trees.push(b); continue; }
      const v = ((b.id * 2654435761) >>> 0) / 4294967296;
      if (b.type === 'building') {
        const c = COLORS.building;
        pushBox(tex, b, [c[0] + (v - 0.5) * 0.15, c[1] + (v - 0.5) * 0.12, c[2] + (v - 0.5) * 0.1], 4);
      } else {
        let c = COLORS[b.type] || COLORS.cover;
        if (b.type === 'car') c = CAR_COLORS[b.id % CAR_COLORS.length];
        if (b.type === 'housewall' && b.houseId === ownHouseId) c = COLORS.ownwall;
        pushBox(plain, b, c, 0);
      }
    }
    const group = new THREE.Group();
    if (tex.idx.length) { const m = new THREE.Mesh(toGeometry(tex), texturedMat); m.castShadow = m.receiveShadow = true; group.add(m); }
    if (plain.idx.length) { const m = new THREE.Mesh(toGeometry(plain), plainMat); m.castShadow = m.receiveShadow = true; group.add(m); }
    if (trees.length) {
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
      const m = new THREE.Matrix4();
      trees.forEach((t, i) => {
        const x = (t.minX + t.maxX) / 2, z = (t.minZ + t.maxZ) / 2;
        m.makeScale(1, t.h * 0.45, 1).setPosition(x, 0, z);
        trunks.setMatrixAt(i, m);
        m.makeScale(2.2 + (t.id % 5) * 0.25, t.h * 0.75, 2.2 + (t.id % 5) * 0.25).setPosition(x, t.h * 0.28, z);
        crowns.setMatrixAt(i, m);
      });
      trunks.castShadow = crowns.castShadow = !mobile;
      group.add(trunks, crowns);
    }
    scene.add(group);
    return group;
  }
  function dispose(group) {
    scene.remove(group);
    group.traverse((o) => { if (o.geometry && o.geometry !== trunkGeo && o.geometry !== crownGeo) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
  }

  return {
    setOwnHouse(id) {
      if (id === ownHouseId) return;
      ownHouseId = id;
      for (const g of chunks.values()) dispose(g);
      chunks.clear();
    },
    update(px, pz) {
      const r = Math.ceil(viewRange / CHUNK);
      const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
      const want = new Set();
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        const cx = ccx + i, cz = ccz + j;
        // Distance from the player to the nearest point of the chunk.
        const nx = Math.max(cx * CHUNK, Math.min(px, (cx + 1) * CHUNK)), nz = Math.max(cz * CHUNK, Math.min(pz, (cz + 1) * CHUNK));
        if (Math.hypot(nx - px, nz - pz) > viewRange) continue;
        want.add(`${cx},${cz}`);
      }
      let built = 0;
      for (const k of want) {
        if (chunks.has(k) || built >= 3) continue;    // spread chunk building over frames
        const [cx, cz] = k.split(',').map(Number);
        chunks.set(k, buildChunk(cx, cz));
        built++;
      }
      for (const [k, g] of chunks) if (!want.has(k)) { dispose(g); chunks.delete(k); }
    },
    get chunkCount() { return chunks.size; },
  };
}
