// Shared world definition + geometry helpers. Runs in both Node (server) and the browser (client).
//
// The world is generated deterministically from (seed, size). The server and every client run the
// same generator, so the multi-megabyte map never goes over the network: the server only sends the
// seed and size and the client rebuilds the identical world. Generation therefore only uses
// + - * / and the seeded RNG (no Math.sin etc., which can differ between JS engines).

export const DEFAULT_WORLD_SIZE = 8000;   // 8 x 8 km, the size of PUBG's Erangel / Miramar
export const PLAYER_RADIUS = 0.45;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.2;
export const STAND_EYE = 1.6;
export const CROUCH_EYE = 1.05;
export const WALK_SPEED = 4.5;
export const SPRINT_SPEED = 7.0;
export const CROUCH_SPEED = 2.4;
export const INTERACT_RANGE = 2.4;

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ spatial index
/**
 * Uniform grid over the XZ plane. Every query that used to scan all boxes (movement collision,
 * line of sight, shots, camera collision, minimap) goes through this, which is what makes an
 * 8 km world with ~10k solid objects cheap.
 */
export class SpatialGrid {
  constructor(half, cell = 32) {
    this.half = half;
    this.cell = cell;
    this.n = Math.ceil((half * 2) / cell) + 2;
    this.cells = new Map();
    this.stamps = new Uint32Array(0);
    this.stamp = 0;
  }
  ci(v) { return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.half) / this.cell))); }
  insert(b) {
    if (b.id >= this.stamps.length) { const s = new Uint32Array(Math.max(b.id + 1, this.stamps.length * 2)); s.set(this.stamps); this.stamps = s; }
    for (let ix = this.ci(b.minX); ix <= this.ci(b.maxX); ix++) {
      for (let iz = this.ci(b.minZ); iz <= this.ci(b.maxZ); iz++) {
        const k = ix * 65536 + iz;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(b);
      }
    }
  }
  /** Boxes overlapping the rectangle. */
  rect(minX, minZ, maxX, maxZ, out = []) {
    const s = ++this.stamp;
    for (let ix = this.ci(minX); ix <= this.ci(maxX); ix++) {
      for (let iz = this.ci(minZ); iz <= this.ci(maxZ); iz++) {
        const list = this.cells.get(ix * 65536 + iz);
        if (!list) continue;
        for (const b of list) {
          if (this.stamps[b.id] === s) continue;
          this.stamps[b.id] = s;
          if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) out.push(b);
        }
      }
    }
    return out;
  }
  near(x, z, r, out = []) { return this.rect(x - r, z - r, x + r, z + r, out); }
  /** Boxes in the grid cells a ray passes through (2D DDA), up to maxDist. */
  ray(ox, oz, dx, dz, maxDist, out = []) {
    const s = ++this.stamp;
    const c = this.cell;
    let ix = this.ci(ox), iz = this.ci(oz);
    const len = Math.hypot(dx, dz);
    const visit = () => {
      const list = this.cells.get(ix * 65536 + iz);
      if (!list) return;
      for (const b of list) if (this.stamps[b.id] !== s) { this.stamps[b.id] = s; out.push(b); }
    };
    if (len < 1e-9) { visit(); return out; }
    const ux = dx / len, uz = dz / len;
    const stepX = ux > 0 ? 1 : -1, stepZ = uz > 0 ? 1 : -1;
    const bx = (ix + (ux > 0 ? 1 : 0)) * c - this.half, bz = (iz + (uz > 0 ? 1 : 0)) * c - this.half;
    let tMaxX = Math.abs(ux) < 1e-9 ? Infinity : (bx - ox) / ux;
    let tMaxZ = Math.abs(uz) < 1e-9 ? Infinity : (bz - oz) / uz;
    const tDX = Math.abs(ux) < 1e-9 ? Infinity : c / Math.abs(ux);
    const tDZ = Math.abs(uz) < 1e-9 ? Infinity : c / Math.abs(uz);
    const flat = maxDist * len;   // maxDist is along the 3D direction; this bounds the XZ travel
    for (let guard = 0; guard < 4096; guard++) {
      visit();
      const t = Math.min(tMaxX, tMaxZ);
      if (t > flat) break;
      if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDX; } else { iz += stepZ; tMaxZ += tDZ; }
      if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) break;
    }
    return out;
  }
}

// ------------------------------------------------------------------ generation
const BLOCK = 30, STREET = 12, PITCH = BLOCK + STREET;
const SYL_A = ['Ash', 'Bram', 'Cold', 'Dun', 'East', 'Fen', 'Grey', 'Hol', 'Iron', 'Kings', 'Lark', 'Mill', 'North', 'Oak', 'Pine', 'Red', 'Stone', 'Thorn', 'West', 'Wolf'];
const SYL_B = ['ford', 'field', 'haven', 'ridge', 'wick', 'gate', 'moor', 'brook', 'ton', 'crest', 'hollow', 'port'];

/**
 * Procedural open world: dozens of towns joined by roads, with farms, forests, rocks and
 * abandoned cars in the countryside between them. Towns hold stash houses, a Contact (the NPC who
 * hands out contracts), hackable terminals, parks and, in industrial towns, warehouses.
 */
export function generateMap(seed = 1337, size = DEFAULT_WORLD_SIZE) {
  const rand = mulberry32(seed);
  const half = size / 2;
  const boxes = [];
  const houses = [];
  const lootSpawns = [];
  const terminals = [];
  const contacts = [];
  const towns = [];
  const roads = [];
  const campSites = [];
  const landingZones = [];
  const rects = [];   // occupied areas for countryside placement

  const box = (minX, minZ, maxX, maxZ, h, type = 'building', extra = {}) => {
    const b = { id: boxes.length, minX, minZ, maxX, maxZ, h, type, ...extra };
    boxes.push(b);
    return b;
  };
  const freeRect = (minX, minZ, maxX, maxZ, pad = 0) =>
    minX > -half + 20 && maxX < half - 20 && minZ > -half + 20 && maxZ < half - 20 &&
    !rects.some((r) => maxX + pad > r.minX && minX - pad < r.maxX && maxZ + pad > r.minZ && minZ - pad < r.maxZ);

  // ---- towns on a jittered grid
  const CELL = size >= 2000 ? 1000 : size / 2;
  const cellsPerSide = Math.max(1, Math.round(size / CELL));
  const townCells = [];
  for (let i = 0; i < cellsPerSide; i++) for (let j = 0; j < cellsPerSide; j++) townCells.push([i, j]);
  for (const [i, j] of townCells) {
    const isCity = rand() < 0.08;
    if (!isCity && rand() > 0.58 && !(i === 0 && j === 0)) continue;
    const blocks = isCity ? 8 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 4);
    const span = blocks * PITCH - STREET;
    const cx = -half + (i + 0.5) * CELL + (rand() - 0.5) * (CELL - span - 120);
    const cz = -half + (j + 0.5) * CELL + (rand() - 0.5) * (CELL - span - 120);
    let name = '';
    for (let tries = 0; tries < 30 && (!name || towns.some((o) => o.name === name)); tries++) name = SYL_A[Math.floor(rand() * SYL_A.length)] + SYL_B[Math.floor(rand() * SYL_B.length)];
    const industrial = rand() < 0.3;
    const t = { id: towns.length, name, x: cx, z: cz, blocks, span, city: isCity, industrial };
    t.rect = { minX: cx - span / 2 - STREET, minZ: cz - span / 2 - STREET, maxX: cx + span / 2 + STREET, maxZ: cz + span / 2 + STREET };
    if (!freeRect(t.rect.minX, t.rect.minZ, t.rect.maxX, t.rect.maxZ, 60)) continue;
    rects.push(t.rect);
    towns.push(t);
    buildTown(t);
  }

  function buildTown(t) {
    const n = t.blocks;
    const x0t = t.x - t.span / 2, z0t = t.z - t.span / 2;
    const centre = Math.floor(n / 2);
    const cells = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (!(i === centre && j === centre)) cells.push([i, j]);
    for (let k = cells.length - 1; k > 0; k--) { const r = Math.floor(rand() * (k + 1)); [cells[k], cells[r]] = [cells[r], cells[k]]; }
    const houseCount = t.city ? 6 : n >= 5 ? 3 : 2;
    const parkCount = Math.max(1, Math.floor(n * n * 0.1));
    const kinds = new Map();
    cells.forEach(([i, j], idx) => kinds.set(`${i},${j}`, idx < houseCount ? 'house' : idx < houseCount + parkCount ? 'park' : t.industrial && rand() < 0.45 ? 'industrial' : 'buildings'));
    kinds.set(`${centre},${centre}`, 'plaza');

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x0 = x0t + i * PITCH, z0 = z0t + j * PITCH, x1 = x0 + BLOCK, z1 = z0 + BLOCK;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const kind = kinds.get(`${i},${j}`);
        if (kind === 'house') {
          const hs = 6, w = 0.4, h = 3.2, gap = 1.8;
          const id = houses.length;
          box(cx - hs, cz - hs, cx + hs, cz - hs + w, h, 'housewall', { houseId: id });
          box(cx - hs, cz - hs, cx - hs + w, cz + hs, h, 'housewall', { houseId: id });
          box(cx + hs - w, cz - hs, cx + hs, cz + hs, h, 'housewall', { houseId: id });
          box(cx - hs, cz + hs - w, cx - gap / 2, cz + hs, h, 'housewall', { houseId: id });
          box(cx + gap / 2, cz + hs - w, cx + hs, cz + hs, h, 'housewall', { houseId: id });
          box(cx - 0.7, cz - 3.5, cx + 0.7, cz - 2.7, 0.9, 'crate', { houseId: id });
          houses.push({
            id, townId: t.id, x: cx, z: cz, crate: { x: cx, z: cz - 3.1 },
            door: { minX: cx - gap / 2, minZ: cz + hs - w, maxX: cx + gap / 2, maxZ: cz + hs, h: 2.6 },
          });
          box(x0 + 2, z1 - 4, x0 + 5, z1 - 3.4, 1.1, 'cover');
          box(x1 - 5, z1 - 4, x1 - 2, z1 - 3.4, 1.1, 'cover');
          lootSpawns.push({ x: x0 + 3, z: z0 + 3, zone: 'town' });
        } else if (kind === 'plaza') {
          // Town square: the Contact stands in the middle, low walls around the edge.
          contacts.push({ id: contacts.length, townId: t.id, name: `${t.name} Contact`, x: cx, z: cz });
          t.contactId = contacts.length - 1;
          box(x0 + 2, z0 + 2, x0 + 9, z0 + 2.6, 1.1, 'cover');
          box(x1 - 9, z1 - 2.6, x1 - 2, z1 - 2, 1.1, 'cover');
          box(x0 + 2, z1 - 9, x0 + 2.6, z1 - 2, 1.1, 'cover');
          box(x1 - 2.6, z0 + 2, x1 - 2, z0 + 9, 1.1, 'cover');
        } else if (kind === 'park') {
          const count = 5 + Math.floor(rand() * 5);
          for (let k = 0; k < count; k++) {
            const w = 1.5 + rand() * 3.5, d = 0.6 + rand() * 1.4;
            const px = x0 + 3 + rand() * (BLOCK - 6 - w), pz = z0 + 3 + rand() * (BLOCK - 6 - d);
            if (rand() < 0.5) box(px, pz, px + d, pz + w, 1.1 + rand() * 0.4, 'cover');
            else box(px, pz, px + w, pz + d, 1.1 + rand() * 0.4, 'cover');
          }
          for (let k = 0; k < 2; k++) lootSpawns.push({ x: x0 + 2 + rand() * (BLOCK - 4), z: z0 + 2 + rand() * (BLOCK - 4), zone: 'town' });
        } else if (kind === 'industrial') {
          // Warehouses: long, low and full of salvage.
          if (rand() < 0.5) { box(x0 + 1, z0 + 1, x1 - 1, cz - 1.5, 7 + rand() * 3, 'warehouse'); box(x0 + 1, cz + 4, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse'); lootSpawns.push({ x: cx, z: cz + 1.2, zone: 'industrial' }, { x: x0 + 4, z: cz + 1.2, zone: 'industrial' }); }
          else { box(x0 + 1, z0 + 1, cx - 1.5, z1 - 1, 7 + rand() * 3, 'warehouse'); box(cx + 4, z0 + 1, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse'); lootSpawns.push({ x: cx + 1.2, z: cz, zone: 'industrial' }, { x: cx + 1.2, z: z0 + 4, zone: 'industrial' }); }
          box(x0 + 3, z1 + 1, x0 + 5.5, z1 + 3, 1.6, 'cover');
        } else {
          // Buildings: the street-facing wall of some carries a hackable terminal.
          if ((i + j) % 3 === 0) {
            const tx = x0 + 6;
            box(tx - 0.4, z1 - 1, tx + 0.4, z1 - 0.65, 1.5, 'terminal', { terminalId: terminals.length });
            terminals.push({ id: terminals.length, x: tx, z: z1 - 0.65, townId: t.id });
          }
          const split = rand();
          const tall = () => (t.city ? 14 : 6) + rand() * (t.city ? 30 : 14);
          if (split < 0.33) box(x0 + 1, z0 + 1, x1 - 1, z1 - 1, tall());
          else if (split < 0.66) { box(x0 + 1, z0 + 1, cx - 2, z1 - 1, tall()); box(cx + 2, z0 + 1, x1 - 1, z1 - 1, tall()); lootSpawns.push({ x: cx, z: cz, zone: 'town' }); }
          else { box(x0 + 1, z0 + 1, x1 - 1, cz - 2, tall()); box(x0 + 1, cz + 2, cx - 2, z1 - 1, tall()); box(cx + 2, cz + 2, x1 - 1, z1 - 1, tall()); lootSpawns.push({ x: cx - 4, z: cz, zone: 'town' }); }
        }
      }
    }
    // Town streets: cars and barriers.
    for (let s = 0; s < n - 1; s++) {
      const mid = x0t + s * PITCH + BLOCK + STREET / 2;
      const midZ = z0t + s * PITCH + BLOCK + STREET / 2;
      for (let k = 0; k < 2; k++) {
        const along = rand() * (t.span - 6);
        const car = rand() < 0.6;
        const len = car ? 4.4 : 2.8, wid = car ? 1.9 : 0.6, h = car ? 1.4 : 1.1;
        const off = (rand() - 0.5) * 5;
        if (rand() < 0.5) box(mid + off - wid / 2, z0t + along, mid + off + wid / 2, z0t + along + len, h, car ? 'car' : 'cover');
        else box(x0t + along, midZ + off - wid / 2, x0t + along + len, midZ + off + wid / 2, h, car ? 'car' : 'cover');
      }
      lootSpawns.push({ x: mid, z: z0t + rand() * t.span, zone: 'town' });
    }
  }

  // ---- roads between towns (each town to its 2 nearest neighbours)
  const seen = new Set();
  for (const a of towns) {
    const near = towns.filter((b) => b !== a).map((b) => [b, (b.x - a.x) ** 2 + (b.z - a.z) ** 2]).sort((p, q) => p[1] - q[1]).slice(0, 2);
    for (const [b] of near) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roads.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z });
    }
  }
  // Abandoned cars + roadside loot along roads (outside towns).
  const inTown = (x, z, pad = 4) => towns.some((t) => x > t.rect.minX - pad && x < t.rect.maxX + pad && z > t.rect.minZ - pad && z < t.rect.maxZ + pad);
  for (const r of roads) {
    const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
    for (let d = 60; d < len - 60; d += 70 + rand() * 80) {
      const f = d / len;
      const x = r.x1 + (r.x2 - r.x1) * f, z = r.z1 + (r.z2 - r.z1) * f;
      if (inTown(x, z, 10)) continue;
      if (rand() < 0.45) {
        const ox = x + (rand() - 0.5) * 6, oz = z + (rand() - 0.5) * 6;
        if (rand() < 0.5) box(ox - 0.95, oz - 2.2, ox + 0.95, oz + 2.2, 1.4, 'car');
        else box(ox - 2.2, oz - 0.95, ox + 2.2, oz + 0.95, 1.4, 'car');
        lootSpawns.push({ x: ox + 3, z: oz + 3, zone: 'road' });
      }
    }
  }

  // ---- countryside: farms, forests, rocks, rogue camp sites, landing zones
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      const cx0 = -half + i * CELL, cz0 = -half + j * CELL;
      const pick = (margin) => [cx0 + margin + rand() * (CELL - 2 * margin), cz0 + margin + rand() * (CELL - 2 * margin)];
      const farms = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < farms; k++) {
        const [fx, fz] = pick(60);
        if (!freeRect(fx - 20, fz - 16, fx + 20, fz + 16, 20)) continue;
        rects.push({ minX: fx - 20, minZ: fz - 16, maxX: fx + 20, maxZ: fz + 16 });
        box(fx - 18, fz - 12, fx - 8, fz - 4, 6, 'farmhouse');
        box(fx + 2, fz - 14, fx + 16, fz - 2, 8, 'barn');
        box(fx - 18, fz + 10, fx + 2, fz + 10.5, 1.1, 'cover');
        box(fx + 8, fz + 4, fx + 8.5, fz + 14, 1.1, 'cover');
        lootSpawns.push({ x: fx - 4, z: fz - 8, zone: 'farm' }, { x: fx + 9, z: fz + 1, zone: 'farm' });
      }
      const forests = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < forests; k++) {
        const [fx, fz] = pick(120);
        const rad = 40 + rand() * 70;
        if (inTown(fx, fz, rad)) continue;
        const trees = 15 + Math.floor(rand() * 40);
        for (let q = 0; q < trees; q++) {
          const tx = fx + (rand() * 2 - 1) * rad, tz = fz + (rand() * 2 - 1) * rad;
          if ((tx - fx) ** 2 + (tz - fz) ** 2 > rad * rad) continue;
          if (rects.some((r) => tx > r.minX - 2 && tx < r.maxX + 2 && tz > r.minZ - 2 && tz < r.maxZ + 2)) continue;
          box(tx - 0.3, tz - 0.3, tx + 0.3, tz + 0.3, 9 + rand() * 5, 'tree');
        }
        lootSpawns.push({ x: fx, z: fz, zone: 'forest' });
      }
      // Lone trees dotted across the fields.
      for (let k = 0; k < 45; k++) {
        const [tx, tz] = pick(10);
        if (inTown(tx, tz, 6) || rects.some((r) => tx > r.minX - 2 && tx < r.maxX + 2 && tz > r.minZ - 2 && tz < r.maxZ + 2)) continue;
        box(tx - 0.3, tz - 0.3, tx + 0.3, tz + 0.3, 8 + rand() * 6, 'tree');
      }
      for (let k = 0; k < 18; k++) {
        const [rx, rz] = pick(20);
        if (inTown(rx, rz, 8)) continue;
        const w = 1.4 + rand() * 2.2, d = 1.2 + rand() * 2;
        box(rx, rz, rx + w, rz + d, 0.9 + rand() * 1.1, 'rock');
      }
      const [sx, sz] = pick(150);
      if (!inTown(sx, sz, 80)) campSites.push({ x: sx, z: sz });
    }
  }
  // Landing zones: open countryside points spread around the map.
  const lzGrid = Math.max(2, Math.round(size / 2000));
  for (let i = 0; i < lzGrid; i++) {
    for (let j = 0; j < lzGrid; j++) {
      for (let tries = 0; tries < 20; tries++) {
        const x = -half + (i + 0.2 + rand() * 0.6) * (size / lzGrid), z = -half + (j + 0.2 + rand() * 0.6) * (size / lzGrid);
        if (!inTown(x, z, 40)) { landingZones.push({ id: landingZones.length, name: `LZ ${String.fromCharCode(65 + landingZones.length)}`, x, z }); break; }
      }
    }
  }

  // Map border walls.
  box(-half - 2, -half - 2, half + 2, -half, 6, 'border');
  box(-half - 2, half, half + 2, half + 2, 6, 'border');
  box(-half - 2, -half, -half, half, 6, 'border');
  box(half, -half, half + 2, half, 6, 'border');

  const grid = new SpatialGrid(half + 4, 32);
  for (const b of boxes) grid.insert(b);
  const free = (p, r = 1.0) => !grid.near(p.x, p.z, r + 1).some((b) => circleOverlapsBox(p.x, p.z, r, b));
  // Landing zones and camps need room; nudge them clear of trees/rocks.
  for (const p of [...landingZones, ...campSites]) for (let k = 0; k < 10 && !free(p, 3); k++) { p.x += 7; p.z += 3; }

  return {
    seed, size, half, boxes, grid, houses, towns, roads, contacts, terminals,
    lootSpawns: lootSpawns.filter((p) => free(p)),
    landingZones, campSites,
  };
}

/** Cheap fingerprint so clients can verify they generated the same world as the server. */
export function mapChecksum(map) {
  let h = 2166136261 >>> 0;
  for (const b of map.boxes) {
    h = Math.imul(h ^ Math.round(b.minX * 100), 16777619) >>> 0;
    h = Math.imul(h ^ Math.round(b.maxZ * 100), 16777619) >>> 0;
  }
  return `${map.boxes.length}:${h.toString(16)}`;
}

export function circleOverlapsBox(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

/** Push a circle out of every solid box. Returns the corrected position. */
export function resolveCircle(x, z, r, solids) {
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const b of solids) {
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r;
        z = cz + (dz / d) * r;
      } else {
        const pen = [x - b.minX + r, b.maxX - x + r, z - b.minZ + r, b.maxZ - z + r];
        const m = pen.indexOf(Math.min(...pen));
        if (m === 0) x = b.minX - r; else if (m === 1) x = b.maxX + r;
        else if (m === 2) z = b.minZ - r; else z = b.maxZ + r;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/** Move from (x,z) by (dx,dz) in small substeps so fast movement can't tunnel through thin walls. */
export function moveWithCollision(x, z, dx, dz, r, solids) {
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  for (let i = 0; i < steps; i++) {
    const p = resolveCircle(x + dx / steps, z + dz / steps, r, solids);
    x = p.x; z = p.z;
  }
  return { x, z };
}

/** Ray vs 3D axis-aligned box. Returns hit distance t or Infinity. */
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], mn = [minX, minY, minZ], mx = [maxX, maxY, maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < mn[a] || o[a] > mx[a]) return Infinity;
    } else {
      let t1 = (mn[a] - o[a]) / d[a];
      let t2 = (mx[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

export function rayAgainstBoxes(ox, oy, oz, dx, dy, dz, list, maxDist = Infinity) {
  let best = maxDist, hit = null;
  for (const b of list) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, 0, b.minZ, b.maxX, b.h, b.maxZ);
    if (t < best) { best = t; hit = b; }
  }
  return { t: best, box: hit };
}

/** Character hit volume as a box. */
export function characterBounds(x, z, crouch) {
  const r = 0.4;
  return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, minY: 0, maxY: crouch ? CROUCH_HEIGHT : STAND_HEIGHT };
}
