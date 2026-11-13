// Streams the 8 km world around the player in chunks. Each chunk merges all of its static boxes
// into a couple of draw calls (and instances its trees), and chunks beyond view range are freed,
// so the GPU only ever holds a few hundred metres of city — fine even on a phone.
import * as THREE from 'three';

const CHUNK = 160;
const COLORS = {
  building: [0.62, 0.6, 0.57], warehouse: [0.5, 0.47, 0.42], farmhouse: [0.72, 0.66, 0.55], barn: [0.55, 0.22, 0.18],
  housewall: [0.54, 0.43, 0.32], ownwall: [0.31, 0.54, 0.35], crate: [1.0, 0.54, 0.16], cover: [0.61, 0.61, 0.58],
  rock: [0.48, 0.48, 0.46], border: [0.17, 0.18, 0.2], car: [0.45, 0.2, 0.2], adobe: [0.78, 0.62, 0.45],
  boulder: [0.44, 0.42, 0.4], cactus: [0.3, 0.5, 0.25], cavewall: [0.38, 0.36, 0.34], caveroof: [0.4, 0.38, 0.35],
  rockwall: [0.62, 0.5, 0.38], logwall: [0.36, 0.25, 0.16], plankwall: [0.55, 0.42, 0.28], jetty: [0.5, 0.38, 0.25],
};
const GROUND = {
  plains: [0.36, 0.45, 0.25], forest: [0.21, 0.32, 0.16], desert: [0.78, 0.67, 0.45], mountain: [0.45, 0.43, 0.4],
  snow: [0.9, 0.91, 0.94], sand: [0.8, 0.74, 0.55], mud: [0.33, 0.3, 0.24], road: [0.24, 0.25, 0.26], town: [0.3, 0.31, 0.33],
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
export function pushBox(buf, b, color, tile) {
  const { minX, minZ, maxX, maxZ } = b;
  const y0 = b.y0 || 0, h = y0 + b.h;
  const faces = [
    // normal, 4 corners (counter-clockwise from outside), uv size
    [[1, 0, 0], [[maxX, y0, maxZ], [maxX, y0, minZ], [maxX, h, minZ], [maxX, h, maxZ]], maxZ - minZ],
    [[-1, 0, 0], [[minX, y0, minZ], [minX, y0, maxZ], [minX, h, maxZ], [minX, h, minZ]], maxZ - minZ],
    [[0, 0, 1], [[minX, y0, maxZ], [maxX, y0, maxZ], [maxX, h, maxZ], [minX, h, maxZ]], maxX - minX],
    [[0, 0, -1], [[maxX, y0, minZ], [minX, y0, minZ], [minX, h, minZ], [maxX, h, minZ]], maxX - minX],
    [[0, 1, 0], [[minX, h, maxZ], [maxX, h, maxZ], [maxX, h, minZ], [minX, h, minZ]], 0],
    [[0, -1, 0], [[minX, y0, minZ], [maxX, y0, minZ], [maxX, y0, maxZ], [minX, y0, maxZ]], 0],
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
        else buf.uv.push(((i === 1 || i === 2) ? width : 0) / tile, (y > y0 ? b.h : 0) / tile);
      }
    });
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
export function toGeometry(buf) {
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
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x1f3a24, roughness: 1 });

  // Water surface (sea and lakes) at y = 0.
  const water = new THREE.Mesh(new THREE.PlaneGeometry(map.size + 2000, map.size + 2000), new THREE.MeshStandardMaterial({ color: 0x2f6b8a, transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.1 }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0;
  scene.add(water);
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2d4f25, roughness: 1, flatShading: true });
  const roadSegs = map.roads;
  const terrain = map.terrain;

  /** Ground colour from biome, height and roads/towns. */
  function groundColor(x, z, h) {
    for (const t of map.towns) { const r = t.rect; if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return GROUND.town; }
    for (const r of roadSegs) {
      const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2));
      const px = r.x1 + dx * t - x, pz = r.z1 + dz * t - z;
      if (px * px + pz * pz < 36) return GROUND.road;
    }
    if (h < -0.3) return GROUND.mud;
    if (h < 1.4) return GROUND.sand;
    const b = terrain.biome(x, z);
    const c = [0, 0, 0];
    for (const k of ['plains', 'forest', 'desert', 'mountain']) for (let i = 0; i < 3; i++) c[i] += GROUND[k][i] * b[k];
    if (b.sea > 0) for (let i = 0; i < 3; i++) c[i] += GROUND.sand[i] * b.sea;
    if (h > 95) { const s = Math.min(1, (h - 95) / 20); for (let i = 0; i < 3; i++) c[i] = c[i] * (1 - s) + GROUND.snow[i] * s; }
    return c;
  }
  function buildTerrain(x0, z0) {
    const STEP = 8, N = CHUNK / STEP;
    const pos = [], col = [], idx = [];
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = x0 + i * STEP, z = z0 + j * STEP;
      const h = terrain.height(x, z);
      pos.push(x, h, z);
      const c = groundColor(x, z, h);
      const v = 0.94 + (((i * 7 + j * 13) % 5) / 40);
      col.push(c[0] * v, c[1] * v, c[2] * v);
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, terrainMat);
    m.receiveShadow = true;
    return m;
  }

  function buildChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const list = map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK).filter((b) => {
      const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2;
      return mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK;
    });
    const tex = { pos: [], nor: [], col: [], uv: [], idx: [] };
    const plain = { pos: [], nor: [], col: [], idx: [] };
    const trees = [], pines = [], canopies = [];
    for (const b of list) {
      if (b.type === 'terminal') continue;            // drawn separately (their state changes)
      if (b.type === 'tree') { trees.push(b); continue; }
      if (b.type === 'pine') { pines.push(b); continue; }
      if (b.type === 'canopy') { canopies.push(b); continue; }
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
    group.add(buildTerrain(x0, z0));
    if (tex.idx.length) { const m = new THREE.Mesh(toGeometry(tex), texturedMat); m.castShadow = m.receiveShadow = true; group.add(m); }
    if (plain.idx.length) { const m = new THREE.Mesh(toGeometry(plain), plainMat); m.castShadow = m.receiveShadow = true; group.add(m); }
    const forest = (list, crownMaterial, wide) => {
      if (!list.length) return;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMaterial, list.length);
      const m = new THREE.Matrix4();
      list.forEach((t, i) => {
        const x = (t.minX + t.maxX) / 2, z = (t.minZ + t.maxZ) / 2, y = t.y0 || 0, h = t.h;
        m.makeScale(1, h * 0.45, 1).setPosition(x, y, z);
        trunks.setMatrixAt(i, m);
        const w = wide + (t.id % 5) * 0.25;
        m.makeScale(w, h * 0.75, w).setPosition(x, y + h * 0.28, z);
        crowns.setMatrixAt(i, m);
      });
      trunks.castShadow = crowns.castShadow = !mobile;
      group.add(trunks, crowns);
    };
    forest(trees, crownMat, 2.2);
    forest(pines, pineMat, 1.4);
    for (const c of canopies) {
      const m = new THREE.Mesh(canopyGeo, canopyMat);
      m.position.set((c.minX + c.maxX) / 2, c.y0 + c.h / 2, (c.minZ + c.maxZ) / 2);
      m.scale.set((c.maxX - c.minX) / 2, c.h / 2, (c.maxZ - c.minZ) / 2);
      m.castShadow = true;
      group.add(m);
    }
    scene.add(group);
    return group;
  }
  function dispose(group) {
    scene.remove(group);
    group.traverse((o) => { if (o.geometry && o.geometry !== trunkGeo && o.geometry !== crownGeo && o.geometry !== canopyGeo) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
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
        if (chunks.has(k) || built >= (chunks.size < 4 ? 9 : 2)) continue;    // spread chunk building over frames
        const [cx, cz] = k.split(',').map(Number);
        chunks.set(k, buildChunk(cx, cz));
        built++;
      }
      for (const [k, g] of chunks) if (!want.has(k)) { dispose(g); chunks.delete(k); }
    },
    get chunkCount() { return chunks.size; },
  };
}
