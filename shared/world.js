// Shared world definition + geometry helpers. Runs in both Node (server) and the browser (client).
//
// The world is generated deterministically from (seed, size). The server and every client run the
// same generator, so the multi-megabyte map never goes over the network: the server only sends the
// seed and size and the client rebuilds the identical world. Generation therefore only uses
// + - * / and the seeded RNG (no Math.sin etc., which can differ between JS engines).

import { createTerrain, biomeName, DEEP_WATER, MAX_STEP_SLOPE } from './terrain.js';
export { WATER_LEVEL } from './terrain.js';

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
export const HOME_KINDS = {
  house:     { name: 'Town house', wall: 'housewall' },
  cave:      { name: 'Mountain cave', wall: 'cavewall' },
  rockfort:  { name: 'Rock formation', wall: 'rockwall' },
  treehut:   { name: 'Giant tree hut', wall: 'logwall' },
  boathouse: { name: 'Boathouse', wall: 'plankwall' },
};

/**
 * Procedural open world over real terrain. Biomes blend from city/plains into forest, desert,
 * mountains and water. Towns sit on flattened ground; between them are farms, forests, cacti,
 * boulders and wrecks. Stash homes come in five kinds: town houses, mountain caves, desert rock
 * formations, giant hollow trees in the forest and boathouses on the shore.
 */
export function generateMap(seed = 1337, size = DEFAULT_WORLD_SIZE) {
  const rand = mulberry32(seed);
  const half = size / 2;
  const terrain = createTerrain(seed, size);
  const boxes = [], houses = [], lootSpawns = [], terminals = [], contacts = [], towns = [], roads = [], campSites = [], landingZones = [];
  const rects = [];   // occupied areas for countryside placement

  const box = (minX, minZ, maxX, maxZ, h, type = 'building', extra = {}) => {
    const b = { id: boxes.length, minX, minZ, maxX, maxZ, h, y0: 0, type, ...extra };
    boxes.push(b);
    return b;
  };
  /** A box sitting on the (exact) terrain, sunk a little so it never floats on slopes. */
  const ground = (minX, minZ, maxX, maxZ, h, type, extra = {}) => {
    const hs = [terrain.exact(minX, minZ), terrain.exact(maxX, minZ), terrain.exact(minX, maxZ), terrain.exact(maxX, maxZ)];
    const lo = Math.min(...hs), hi = Math.max(...hs);
    return box(minX, minZ, maxX, maxZ, h + (hi - lo) + 0.4, type, { y0: lo - 0.4, ...extra });
  };
  const inRect = (x, z, pad = 0) => rects.some((r) => x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad);
  const freeRect = (minX, minZ, maxX, maxZ, pad = 0) =>
    minX > -half + 30 && maxX < half - 30 && minZ > -half + 30 && maxZ < half - 30 &&
    !rects.some((r) => maxX + pad > r.minX && minX - pad < r.maxX && maxZ + pad > r.minZ && minZ - pad < r.maxZ);
  const span4 = (x, z, r, f = terrain.raw) => { const hs = [f(x - r, z - r), f(x + r, z - r), f(x - r, z + r), f(x + r, z + r), f(x, z)]; return { lo: Math.min(...hs), hi: Math.max(...hs) }; };

  // ---- towns: only on dry, not-too-mountainous ground
  const CELL = size >= 2000 ? 1000 : size / 2;
  const cellsPerSide = Math.max(1, Math.round(size / CELL));
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      const isCity = rand() < 0.08;
      if (!isCity && rand() > 0.8 && !(i === 0 && j === 0)) continue;
      const blocks = isCity ? 8 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 4);
      const span = blocks * PITCH - STREET;
      const cx = -half + (i + 0.5) * CELL + (rand() - 0.5) * (CELL - span - 120);
      const cz = -half + (j + 0.5) * CELL + (rand() - 0.5) * (CELL - span - 120);
      let name = '';
      for (let tries = 0; tries < 30 && (!name || towns.some((o) => o.name === name)); tries++) name = SYL_A[Math.floor(rand() * SYL_A.length)] + SYL_B[Math.floor(rand() * SYL_B.length)];
      const industrial = rand() < 0.3;
      const b = terrain.biome(cx, cz);
      if (b.mountain > 0.45 || b.sea > 0.15) continue;
      const g = span4(cx, cz, span / 2);
      if (g.lo < 0.5 || g.hi - g.lo > 45) continue;
      const t = { id: towns.length, name, x: cx, z: cz, blocks, span, city: isCity, industrial, biome: biomeName(b), elev: Math.max(2, terrain.raw(cx, cz)) };
      t.rect = { minX: cx - span / 2 - STREET, minZ: cz - span / 2 - STREET, maxX: cx + span / 2 + STREET, maxZ: cz + span / 2 + STREET };
      if (!freeRect(t.rect.minX, t.rect.minZ, t.rect.maxX, t.rect.maxZ, 80)) continue;
      rects.push(t.rect);
      towns.push(t);
    }
  }
  terrain.setFlats(towns.map((t) => ({ ...t.rect, elev: t.elev, margin: 60 })));
  for (const t of towns) buildTown(t);

  function addHome(kind, cx, cz, townId = null) {
    const hs = 6, w = 0.4, gap = 1.8;
    const id = houses.length;
    const wallType = HOME_KINDS[kind].wall;
    const g = span4(cx, cz, hs + 1, terrain.exact);
    const y0 = townId !== null ? towns[townId].elev : g.lo - 0.5;
    const h = (townId !== null ? 3.2 : g.hi - y0 + (kind === 'cave' ? 4.5 : 3.4)) + (kind === 'rockfort' ? 1 : 0);
    const wall = (a, b, c, d, hh = h) => box(a, b, c, d, hh, wallType, { houseId: id, y0 });
    const thick = kind === 'cave' || kind === 'rockfort' ? 1.2 : kind === 'treehut' ? 0.8 : w;
    wall(cx - hs, cz - hs, cx + hs, cz - hs + thick);
    wall(cx - hs, cz - hs, cx - hs + thick, cz + hs);
    wall(cx + hs - thick, cz - hs, cx + hs, cz + hs);
    wall(cx - hs, cz + hs - thick, cx - gap / 2, cz + hs);
    wall(cx + gap / 2, cz + hs - thick, cx + hs, cz + hs);
    const floor = terrain.exact(cx, cz - 3.1);
    box(cx - 0.7, cz - 3.5, cx + 0.7, cz - 2.7, 0.9 + (floor - y0), 'crate', { houseId: id, y0 });
    if (kind === 'cave') {
      // Rock mass around and over the chamber so it reads as a cave in the hillside.
      box(cx - hs - 3, cz - hs - 4, cx + hs + 3, cz + hs - 1, 3, 'caveroof', { houseId: id, y0: y0 + h - 0.2 });
      box(cx - hs - 4, cz - hs - 5, cx - hs, cz + hs - 2, h + 2, 'boulder', { y0 });
      box(cx + hs, cz - hs - 5, cx + hs + 4, cz + hs - 2, h + 2, 'boulder', { y0 });
      box(cx - hs, cz - hs - 5, cx + hs, cz - hs, h + 3, 'boulder', { y0 });
      // Craggy rock piled on the roof and flanks so it reads as a hillside, not a box.
      for (const [ox, oz, w, hh] of [[-4, -3, 5, 3], [3, -5, 6, 4], [0, 1, 4, 2.2], [-hs - 3, 2, 3, h], [hs + 3, -1, 3.5, h + 1]]) {
        const top = ox < -hs || ox > hs ? y0 : y0 + h + 1.4;
        box(cx + ox - w / 2, cz + oz - w / 2, cx + ox + w / 2, cz + oz + w / 2, hh, 'boulder', { y0: top });
      }
    } else if (kind === 'rockfort') {
      for (const [ox, oz, r] of [[-hs - 2, -2, 3], [hs + 2, 1, 2.6], [-3, -hs - 2.4, 2.8], [3, hs + 2.5, 1.6], [-hs - 1, hs + 1.5, 1.8]]) {
        const bx = cx + ox, bz = cz + oz;
        ground(bx - r, bz - r * 0.8, bx + r, bz + r * 0.8, h + 0.5 - (r < 2 ? 2 : 0), 'boulder');
      }
    } else if (kind === 'treehut') {
      // A giant hollowed tree: thick trunk walls plus a canopy far overhead.
      box(cx - 13, cz - 13, cx + 13, cz + 13, 12, 'canopy', { houseId: id, y0: y0 + h + 6 });
      for (const [ox, oz] of [[-hs - 1.5, -hs - 1.5], [hs + 1.5, -hs - 1.5], [-hs - 1.5, hs + 1.5], [hs + 1.5, hs + 1.5]]) box(cx + ox - 1.2, cz + oz - 1.2, cx + ox + 1.2, cz + oz + 1.2, h + 7, 'logwall', { y0 });
    } else if (kind === 'boathouse') {
      // Jetty out toward the water.
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      const [ox, oz] = dirs.find(([a, b]) => terrain.exact(cx + a * 24, cz + b * 24) < -1) || dirs[0];
      const ax = cx + ox * (hs + 7), az = cz + oz * (hs + 7);
      box(ax - (ox ? 7 : 1), az - (oz ? 7 : 1), ax + (ox ? 7 : 1), az + (oz ? 7 : 1), 0.3, 'jetty', { y0: 0.05 });
    }
    const door = { minX: cx - gap / 2, minZ: cz + hs - thick, maxX: cx + gap / 2, maxZ: cz + hs, h: 2.6, y0: terrain.exact(cx, cz + hs) - 0.3 };
    houses.push({ id, kind, townId, x: cx, z: cz, crate: { x: cx, z: cz - 3.1 }, door, biome: biomeName(terrain.biome(cx, cz)) });
    rects.push({ minX: cx - hs - 5, minZ: cz - hs - 5, maxX: cx + hs + 5, maxZ: cz + hs + 16 });
    lootSpawns.push({ x: cx + 9, z: cz + 9, zone: kind === 'house' ? 'town' : kind === 'boathouse' ? 'lake' : biomeName(terrain.biome(cx, cz)) });
    return id;
  }

  function buildTown(t) {
    const n = t.blocks, y0 = t.elev;
    const tb = (a, b, c, d, h, type = 'building', extra = {}) => box(a, b, c, d, h, type, { y0, ...extra });
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
    const desert = t.biome === 'desert';
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x0 = x0t + i * PITCH, z0 = z0t + j * PITCH, x1 = x0 + BLOCK, z1 = z0 + BLOCK;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const kind = kinds.get(`${i},${j}`);
        if (kind === 'house') {
          addHome('house', cx, cz, t.id);
          rects.pop();   // the town rect already reserves this space
          tb(x0 + 2, z1 - 4, x0 + 5, z1 - 3.4, 1.1, 'cover');
          tb(x1 - 5, z1 - 4, x1 - 2, z1 - 3.4, 1.1, 'cover');
        } else if (kind === 'plaza') {
          contacts.push({ id: contacts.length, townId: t.id, name: `${t.name} Contact`, x: cx, z: cz });
          t.contactId = contacts.length - 1;
          tb(x0 + 2, z0 + 2, x0 + 9, z0 + 2.6, 1.1, 'cover');
          tb(x1 - 9, z1 - 2.6, x1 - 2, z1 - 2, 1.1, 'cover');
          tb(x0 + 2, z1 - 9, x0 + 2.6, z1 - 2, 1.1, 'cover');
          tb(x1 - 2.6, z0 + 2, x1 - 2, z0 + 9, 1.1, 'cover');
        } else if (kind === 'park') {
          const count = 5 + Math.floor(rand() * 5);
          for (let k = 0; k < count; k++) {
            const w = 1.5 + rand() * 3.5, d = 0.6 + rand() * 1.4;
            const px = x0 + 3 + rand() * (BLOCK - 6 - w), pz = z0 + 3 + rand() * (BLOCK - 6 - d);
            if (rand() < 0.5) tb(px, pz, px + d, pz + w, 1.1 + rand() * 0.4, 'cover');
            else tb(px, pz, px + w, pz + d, 1.1 + rand() * 0.4, 'cover');
          }
          for (let k = 0; k < 2; k++) lootSpawns.push({ x: x0 + 2 + rand() * (BLOCK - 4), z: z0 + 2 + rand() * (BLOCK - 4), zone: 'town' });
        } else if (kind === 'industrial') {
          if (rand() < 0.5) { tb(x0 + 1, z0 + 1, x1 - 1, cz - 1.5, 7 + rand() * 3, 'warehouse'); tb(x0 + 1, cz + 4, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse'); lootSpawns.push({ x: cx, z: cz + 1.2, zone: 'industrial' }, { x: x0 + 4, z: cz + 1.2, zone: 'industrial' }); }
          else { tb(x0 + 1, z0 + 1, cx - 1.5, z1 - 1, 7 + rand() * 3, 'warehouse'); tb(cx + 4, z0 + 1, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse'); lootSpawns.push({ x: cx + 1.2, z: cz, zone: 'industrial' }, { x: cx + 1.2, z: z0 + 4, zone: 'industrial' }); }
          tb(x0 + 3, z1 + 1, x0 + 5.5, z1 + 3, 1.6, 'cover');
        } else {
          if ((i + j) % 3 === 0) {
            const tx = x0 + 6;
            tb(tx - 0.4, z1 - 1, tx + 0.4, z1 - 0.65, 1.5, 'terminal', { terminalId: terminals.length });
            terminals.push({ id: terminals.length, x: tx, z: z1 - 0.65, townId: t.id });
          }
          const split = rand();
          const type = desert ? 'adobe' : 'building';
          const tall = () => (t.city ? 14 : desert ? 5 : 6) + rand() * (t.city ? 30 : desert ? 6 : 14);
          if (split < 0.33) tb(x0 + 1, z0 + 1, x1 - 1, z1 - 1, tall(), type);
          else if (split < 0.66) { tb(x0 + 1, z0 + 1, cx - 2, z1 - 1, tall(), type); tb(cx + 2, z0 + 1, x1 - 1, z1 - 1, tall(), type); lootSpawns.push({ x: cx, z: cz, zone: 'town' }); }
          else { tb(x0 + 1, z0 + 1, x1 - 1, cz - 2, tall(), type); tb(x0 + 1, cz + 2, cx - 2, z1 - 1, tall(), type); tb(cx + 2, cz + 2, x1 - 1, z1 - 1, tall(), type); lootSpawns.push({ x: cx - 4, z: cz, zone: 'town' }); }
        }
      }
    }
    for (let s = 0; s < n - 1; s++) {
      const mid = x0t + s * PITCH + BLOCK + STREET / 2;
      const midZ = z0t + s * PITCH + BLOCK + STREET / 2;
      for (let k = 0; k < 2; k++) {
        const along = rand() * (t.span - 6);
        const car = rand() < 0.6;
        const len = car ? 4.4 : 2.8, wid = car ? 1.9 : 0.6, h = car ? 1.4 : 1.1;
        const off = (rand() - 0.5) * 5;
        if (rand() < 0.5) tb(mid + off - wid / 2, z0t + along, mid + off + wid / 2, z0t + along + len, h, car ? 'car' : 'cover');
        else tb(x0t + along, midZ + off - wid / 2, x0t + along + len, midZ + off + wid / 2, h, car ? 'car' : 'cover');
      }
      lootSpawns.push({ x: mid, z: z0t + rand() * t.span, zone: 'town' });
    }
  }

  // ---- roads between towns
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
  const inTown = (x, z, pad = 4) => towns.some((t) => x > t.rect.minX - pad && x < t.rect.maxX + pad && z > t.rect.minZ - pad && z < t.rect.maxZ + pad);
  for (const r of roads) {
    const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
    for (let d = 60; d < len - 60; d += 70 + rand() * 80) {
      const f = d / len;
      const x = r.x1 + (r.x2 - r.x1) * f, z = r.z1 + (r.z2 - r.z1) * f;
      if (inTown(x, z, 10) || terrain.exact(x, z) < 0.8) continue;
      if (rand() < 0.45) {
        const ox = x + (rand() - 0.5) * 6, oz = z + (rand() - 0.5) * 6;
        if (rand() < 0.5) ground(ox - 0.95, oz - 2.2, ox + 0.95, oz + 2.2, 1.4, 'car');
        else ground(ox - 2.2, oz - 0.95, ox + 2.2, oz + 0.95, 1.4, 'car');
        lootSpawns.push({ x: ox + 3, z: oz + 3, zone: 'road' });
      }
    }
  }

  // ---- countryside, by biome
  const dry = (x, z, min = 0.8) => terrain.exact(x, z) > min;
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      const cx0 = -half + i * CELL, cz0 = -half + j * CELL;
      const pick = (margin) => [cx0 + margin + rand() * (CELL - 2 * margin), cz0 + margin + rand() * (CELL - 2 * margin)];
      const cb = terrain.biome(cx0 + CELL / 2, cz0 + CELL / 2);

      // Farms on gentle lowland.
      const farms = Math.round((cb.plains + cb.forest * 0.4) * 3);
      for (let k = 0; k < farms; k++) {
        const [fx, fz] = pick(60);
        const g = span4(fx, fz, 20, terrain.exact);
        if (g.lo < 1 || g.hi - g.lo > 4 || !freeRect(fx - 20, fz - 16, fx + 20, fz + 16, 20)) continue;
        rects.push({ minX: fx - 20, minZ: fz - 16, maxX: fx + 20, maxZ: fz + 16 });
        ground(fx - 18, fz - 12, fx - 8, fz - 4, 6, 'farmhouse');
        ground(fx + 2, fz - 14, fx + 16, fz - 2, 8, 'barn');
        ground(fx - 18, fz + 10, fx + 2, fz + 10.5, 1.1, 'cover');
        ground(fx + 8, fz + 4, fx + 8.5, fz + 14, 1.1, 'cover');
        lootSpawns.push({ x: fx - 4, z: fz - 8, zone: 'farm' }, { x: fx + 9, z: fz + 1, zone: 'farm' });
      }
      // Desert ruins.
      for (let k = 0; k < Math.round(cb.desert * 2); k++) {
        const [rx, rz] = pick(60);
        if (!freeRect(rx - 12, rz - 12, rx + 12, rz + 12, 15) || !dry(rx, rz, 1)) continue;
        rects.push({ minX: rx - 12, minZ: rz - 12, maxX: rx + 12, maxZ: rz + 12 });
        ground(rx - 10, rz - 10, rx - 2, rz - 3, 3.5, 'adobe');
        ground(rx + 2, rz - 9, rx + 3, rz + 6, 2.2, 'adobe');
        ground(rx - 8, rz + 4, rx - 1, rz + 5, 1.6, 'adobe');
        lootSpawns.push({ x: rx, z: rz, zone: 'desert' }, { x: rx - 6, z: rz + 1, zone: 'desert' });
      }
      // Forest clusters (pines up high).
      const forests = Math.round(cb.forest * 7 + cb.plains * 2 + cb.mountain * 2);
      for (let k = 0; k < forests; k++) {
        const [fx, fz] = pick(80);
        const rad = 40 + rand() * 90;
        if (inTown(fx, fz, rad)) continue;
        const trees = Math.round((20 + rand() * 50) * (0.4 + cb.forest));
        for (let q = 0; q < trees; q++) {
          const tx = fx + (rand() * 2 - 1) * rad, tz = fz + (rand() * 2 - 1) * rad;
          if ((tx - fx) ** 2 + (tz - fz) ** 2 > rad * rad || inRect(tx, tz, 2) || !dry(tx, tz, 0.6)) continue;
          const high = terrain.exact(tx, tz) > 45;
          ground(tx - 0.3, tz - 0.3, tx + 0.3, tz + 0.3, 9 + rand() * 6, high ? 'pine' : 'tree');
        }
        lootSpawns.push({ x: fx, z: fz, zone: 'forest' });
      }
      // Scatter: lone trees, cacti, rocks and boulders depending on biome.
      for (let k = 0; k < 70; k++) {
        const [x, z] = pick(10);
        if (inTown(x, z, 6) || inRect(x, z, 2) || !dry(x, z, 0.6)) continue;
        const b = terrain.biome(x, z);
        const r = rand();
        if (r < b.forest * 0.7 + b.plains * 0.25) ground(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 8 + rand() * 6, 'tree');
        else if (r < b.forest * 0.7 + b.plains * 0.25 + b.desert * 0.5) ground(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 2 + rand() * 2.5, 'cactus');
        else if (r < 0.8) { const w = 1.2 + rand() * (b.mountain * 4 + b.desert * 2 + 1.2), d = 1 + rand() * (b.mountain * 3 + 1.5); ground(x, z, x + w, z + d, 0.9 + rand() * (1 + b.mountain * 3), b.mountain > 0.4 ? 'boulder' : 'rock'); }
      }
      // Natural homes.
      const tryHome = (kind, ok, attempts = 30) => {
        for (let k = 0; k < attempts; k++) {
          const [x, z] = pick(100);
          if (!ok(x, z) || !freeRect(x - 12, z - 12, x + 12, z + 22, 30) || inTown(x, z, 80)) continue;
          addHome(kind, x, z);
          return true;
        }
        return false;
      };
      if (cb.mountain > 0.45) tryHome('cave', (x, z) => { const h = terrain.exact(x, z); const g = span4(x, z, 7, terrain.exact); return h > 12 && h < 90 && g.hi - g.lo < 9 && terrain.biome(x, z).mountain > 0.5; });
      if (cb.desert > 0.4) tryHome('rockfort', (x, z) => { const g = span4(x, z, 7, terrain.exact); return g.lo > 1 && g.hi - g.lo < 3 && terrain.biome(x, z).desert > 0.5; });
      if (cb.forest > 0.45) tryHome('treehut', (x, z) => { const g = span4(x, z, 7, terrain.exact); return g.lo > 1 && g.hi - g.lo < 3 && terrain.biome(x, z).forest > 0.5; });
      // Boathouses on lake shores / the coast: dry here, water just south of the door.
      // Boathouses: low dry ground with open water within ~25 m in some direction.
      tryHome('boathouse', (x, z) => {
        const h = terrain.exact(x, z);
        if (h < 0.6 || h > 7) return false;
        const g = span4(x, z, 7, terrain.exact);
        if (g.lo < 0.5 || g.hi - g.lo > 4) return false;
        return [[0, 24], [0, -24], [24, 0], [-24, 0]].some(([ox, oz]) => terrain.exact(x + ox, z + oz) < -1);
      }, 300);
      const [sx, sz] = pick(150);
      if (!inTown(sx, sz, 80) && dry(sx, sz, 1)) campSites.push({ x: sx, z: sz });
    }
  }
  // Landing zones: open dry ground spread around the map.
  const lzGrid = Math.max(2, Math.round(size / 2000));
  for (let i = 0; i < lzGrid; i++) {
    for (let j = 0; j < lzGrid; j++) {
      for (let tries = 0; tries < 40; tries++) {
        const x = -half + (i + 0.2 + rand() * 0.6) * (size / lzGrid), z = -half + (j + 0.2 + rand() * 0.6) * (size / lzGrid);
        const g = span4(x, z, 6, terrain.exact);
        if (!inTown(x, z, 40) && g.lo > 1 && g.hi - g.lo < 4) { landingZones.push({ id: landingZones.length, name: `LZ ${String.fromCharCode(65 + landingZones.length)}`, x, z }); break; }
      }
    }
  }
  box(-half - 2, -half - 2, half + 2, -half, 300, 'border', { y0: -50 });
  box(-half - 2, half, half + 2, half + 2, 300, 'border', { y0: -50 });
  box(-half - 2, -half, -half, half, 300, 'border', { y0: -50 });
  box(half, -half, half + 2, half, 300, 'border', { y0: -50 });

  const grid = new SpatialGrid(half + 4, 32);
  for (const b of boxes) grid.insert(b);
  const free = (p, r = 1.0) => terrain.exact(p.x, p.z) > 0.3 && !grid.near(p.x, p.z, r + 1).some((b) => circleOverlapsBox(p.x, p.z, r, b) && b.type !== 'caveroof' && b.type !== 'canopy');
  for (const p of [...landingZones, ...campSites]) for (let k = 0; k < 10 && !free(p, 3); k++) { p.x += 7; p.z += 3; }
  return {
    seed, size, half, boxes, grid, terrain, houses, towns, roads, contacts, terminals,
    lootSpawns: lootSpawns.filter((p) => free(p)), landingZones, campSites,
  };
}

/** Cheap fingerprint so clients can verify they generated the same world as the server. */
export function mapChecksum(map) {
  let h = 2166136261 >>> 0;
  for (const b of map.boxes) {
    h = Math.imul(h ^ Math.round(b.minX * 100), 16777619) >>> 0;
    h = Math.imul(h ^ Math.round(b.maxZ * 100), 16777619) >>> 0;
    h = Math.imul(h ^ Math.round(b.y0 * 100), 16777619) >>> 0;
  }
  return `${map.boxes.length}:${h.toString(16)}`;
}

export function circleOverlapsBox(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

/** Does a box block a character standing at height y? (Overhead roofs/canopies and flat jetties don't.) */
export function blocksAt(b, y) {
  if (y === undefined) return true;
  const y0 = b.y0 || 0;
  return y0 < y + 1.9 && y0 + b.h > y + 0.35;
}

/** Push a circle out of every solid box. Returns the corrected position. */
export function resolveCircle(x, z, r, solids, y) {
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const b of solids) {
      if (y !== undefined && !blocksAt(b, y)) continue;
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

/**
 * Move from (x,z) by (dx,dz) in small substeps so fast movement can't tunnel through thin walls.
 * With `terrain`, too-steep slopes and deep water also stop you.
 */
export function moveWithCollision(x, z, dx, dz, r, solids, terrain) {
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  for (let i = 0; i < steps; i++) {
    const y = terrain ? terrain.height(x, z) : undefined;
    const p = resolveCircle(x + dx / steps, z + dz / steps, r, solids, y);
    if (terrain) {
      const ny = terrain.height(p.x, p.z);
      const run = Math.hypot(p.x - x, p.z - z);
      if (ny < DEEP_WATER || (run > 1e-6 && (ny - y) / run > MAX_STEP_SLOPE)) break;
    }
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
    const y0 = b.y0 || 0;
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, y0, b.minZ, b.maxX, y0 + b.h, b.maxZ);
    if (t < best) { best = t; hit = b; }
  }
  return { t: best, box: hit };
}

/** Character hit volume as a box. */
export function characterBounds(x, z, crouch, y = 0) {
  const r = 0.4;
  return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, minY: y, maxY: y + (crouch ? CROUCH_HEIGHT : STAND_HEIGHT) };
}
