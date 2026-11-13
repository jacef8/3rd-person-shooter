// Shared world definition + geometry helpers. Runs in both Node (server) and the browser (client).
//
// The world is generated deterministically from (seed, size). The server and every client run the
// same generator, so the multi-megabyte map never goes over the network: the server only sends the
// seed and size and the client rebuilds the identical world. Generation therefore only uses
// + - * / and the seeded RNG (no Math.sin etc., which can differ between JS engines).

import { createTerrain, biomeName, DEEP_WATER, MAX_STEP_SLOPE } from './terrain.js';
import { polyDist, lakeDepth } from './geography.js';
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
  room:      { name: 'Apartment room', wall: 'roomwall' },
  cave:      { name: 'Limestone cave', wall: 'cavewall' },
  rockfort:  { name: 'Rock outcrop', wall: 'rockwall' },
  treehut:   { name: 'Hollow cypress', wall: 'logwall' },
  boathouse: { name: 'Fish camp', wall: 'plankwall' },
  vehicle:   { name: 'Abandoned vehicle', wall: 'vehiclebody' },
};
export const VEHICLE_TYPES = {
  rv:        { name: 'RV', len: 8, wid: 3, h: 3.2 },
  bus:       { name: 'School bus', len: 11, wid: 3, h: 3.3 },
  truck:     { name: 'Box truck', len: 7, wid: 2.6, h: 3.1 },
  houseboat: { name: 'Houseboat', len: 11, wid: 4.5, h: 3 },
};

/**
 * Open world laid out like the real area around Bristol, Florida: the real towns at their real
 * relative positions, the Apalachicola / Chipola / Ochlockonee rivers, Lake Seminole, Lake Talquin,
 * the Dead Lakes, the real highways (SR 20, SR 12, SR 65, SR 71, SR 69, SR 267, US 90, I-10) with
 * bridges where they cross the rivers, the Torreya bluffs, the Red Hills, sandhill scrub and the
 * Apalachicola National Forest. Seeded noise fills in the detail. Homes you can claim: town houses,
 * apartment rooms, limestone caves, rock outcrops, hollow cypress trees, river fish camps and
 * abandoned vehicles (RVs, buses, box trucks, houseboats).
 */
export function generateMap(seed = 1337, size = DEFAULT_WORLD_SIZE) {
  const rand = mulberry32(seed);
  const half = size / 2;
  const terrain = createTerrain(seed, size);
  const geo = terrain.geo;
  const boxes = [], houses = [], lootSpawns = [], terminals = [], contacts = [], towns = [], roads = [], campSites = [], landingZones = [];
  const rects = [];

  const box = (minX, minZ, maxX, maxZ, h, type = 'building', extra = {}) => {
    const b = { id: boxes.length, minX, minZ, maxX, maxZ, h, y0: 0, type, ...extra };
    boxes.push(b);
    return b;
  };
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
  const waterDist = (x, z) => Math.min(...geo.rivers.map((r) => polyDist(x, z, r.pts) - r.width / 2), ...geo.lakes.map((l) => -lakeDepth(x, z, l)));

  // ---- real towns, nudged onto dry ground where the real one sits right on the water
  for (const gt of geo.towns) {
    const span = gt.blocks * PITCH - STREET;
    const r = span / 2 + STREET;
    let pos = null;
    for (let ring = 0; ring <= 14 && !pos; ring++) {
      const steps = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < steps && !pos; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = gt.x + (ring ? Math.cos(a) * ring * 30 : 0), z = gt.z + (ring ? Math.sin(a) * ring * 30 : 0);
        if (Math.abs(x) > half - r - 40 || Math.abs(z) > half - r - 40) continue;
        if (waterDist(x, z) < r * 1.42 + 25) continue;
        if (!freeRect(x - r, z - r, x + r, z + r, 40)) continue;
        pos = { x, z };
      }
    }
    if (!pos) continue;
    const g = span4(pos.x, pos.z, r);
    const t = {
      id: towns.length, name: gt.name, county: gt.county, x: pos.x, z: pos.z, blocks: gt.blocks, span,
      city: gt.blocks >= 8, industrial: gt.blocks >= 5 && rand() < 0.5, biome: biomeName(terrain.biome(pos.x, pos.z)),
      elev: Math.max(2.5, (g.lo + g.hi) / 2), real: gt.real,
    };
    t.rect = { minX: pos.x - r, minZ: pos.z - r, maxX: pos.x + r, maxZ: pos.z + r };
    rects.push(t.rect);
    towns.push(t);
  }
  terrain.setFlats(towns.map((t) => ({ ...t.rect, elev: t.elev, margin: 60 })));

  function addHome(kind, cx, cz, townId = null, extra = {}) {
    const hs = 6, w = 0.4, gap = 1.8;
    const id = houses.length;
    const wallType = HOME_KINDS[kind].wall;
    const g = span4(cx, cz, hs + 1, terrain.exact);
    const y0 = townId !== null ? towns[townId].elev : g.lo - 0.5;
    const h = (townId !== null ? (kind === 'room' ? 3.6 : 3.2) : g.hi - y0 + (kind === 'cave' ? 4.5 : 3.4)) + (kind === 'rockfort' ? 1 : 0);
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
      box(cx - hs - 3, cz - hs - 4, cx + hs + 3, cz + hs - 1, 3, 'caveroof', { houseId: id, y0: y0 + h - 0.2 });
      box(cx - hs - 4, cz - hs - 5, cx - hs, cz + hs - 2, h + 2, 'boulder', { y0 });
      box(cx + hs, cz - hs - 5, cx + hs + 4, cz + hs - 2, h + 2, 'boulder', { y0 });
      box(cx - hs, cz - hs - 5, cx + hs, cz - hs, h + 3, 'boulder', { y0 });
      for (const [ox, oz, ww, hh] of [[-4, -3, 5, 3], [3, -5, 6, 4], [0, 1, 4, 2.2], [-hs - 3, 2, 3, h], [hs + 3, -1, 3.5, h + 1]]) {
        const top = ox < -hs || ox > hs ? y0 : y0 + h + 1.4;
        box(cx + ox - ww / 2, cz + oz - ww / 2, cx + ox + ww / 2, cz + oz + ww / 2, hh, 'boulder', { y0: top });
      }
    } else if (kind === 'room') {
      // A ground-floor unit inside a larger building: roof slab and storeys above.
      box(cx - hs - 1, cz - hs - 1, cx + hs + 1, cz + hs + 1, 6 + rand() * 10, 'building', { y0: y0 + h, houseId: id });
    } else if (kind === 'rockfort') {
      for (const [ox, oz, rr] of [[-hs - 2, -2, 3], [hs + 2, 1, 2.6], [-3, -hs - 2.4, 2.8], [3, hs + 2.5, 1.6], [-hs - 1, hs + 1.5, 1.8]]) {
        const bx = cx + ox, bz = cz + oz;
        ground(bx - rr, bz - rr * 0.8, bx + rr, bz + rr * 0.8, h + 0.5 - (rr < 2 ? 2 : 0), 'boulder');
      }
    } else if (kind === 'treehut') {
      box(cx - 13, cz - 13, cx + 13, cz + 13, 12, 'canopy', { houseId: id, y0: y0 + h + 6 });
      for (const [ox, oz] of [[-hs - 1.5, -hs - 1.5], [hs + 1.5, -hs - 1.5], [-hs - 1.5, hs + 1.5], [hs + 1.5, hs + 1.5]]) box(cx + ox - 1.2, cz + oz - 1.2, cx + ox + 1.2, cz + oz + 1.2, h + 7, 'logwall', { y0 });
    } else if (kind === 'boathouse') {
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      const [ox, oz] = dirs.find(([a, b]) => terrain.exact(cx + a * 24, cz + b * 24) < -1) || dirs[0];
      const ax = cx + ox * (hs + 7), az = cz + oz * (hs + 7);
      box(ax - (ox ? 7 : 1), az - (oz ? 7 : 1), ax + (ox ? 7 : 1), az + (oz ? 7 : 1), 0.3, 'jetty', { y0: 0.05 });
    }
    const door = { minX: cx - gap / 2, minZ: cz + hs - thick, maxX: cx + gap / 2, maxZ: cz + hs, h: 2.6, y0: terrain.exact(cx, cz + hs) - 0.3 };
    houses.push({ id, kind, townId, x: cx, z: cz, crate: { x: cx, z: cz - 3.1 }, door, biome: biomeName(terrain.biome(cx, cz)), ...extra });
    rects.push({ minX: cx - hs - 5, minZ: cz - hs - 5, maxX: cx + hs + 5, maxZ: cz + hs + 16 });
    lootSpawns.push({ x: cx + 9, z: cz + 9, zone: kind === 'house' || kind === 'room' ? 'town' : kind === 'boathouse' ? 'lake' : biomeName(terrain.biome(cx, cz)) });
    return id;
  }

  /** An abandoned vehicle you can claim: a solid body with a lockable door at the back. */
  function addVehicle(vtype, cx, cz, alongX) {
    const v = VEHICLE_TYPES[vtype];
    const hl = v.len / 2, hw = v.wid / 2;
    const id = houses.length;
    const floating = vtype === 'houseboat';
    const y0 = floating ? -0.4 : Math.min(terrain.exact(cx - hl, cz - hl), terrain.exact(cx + hl, cz + hl), terrain.exact(cx, cz)) - 0.3;
    const body = alongX ? [cx - hl, cz - hw, cx + hl, cz + hw] : [cx - hw, cz - hl, cx + hw, cz + hl];
    box(...body, v.h + 0.3, 'vehiclebody', { houseId: id, y0, vtype });
    // Rear door (the lock) and the spot you stand to reach the stash inside.
    const door = alongX
      ? { minX: cx + hl, minZ: cz - 0.8, maxX: cx + hl + 0.35, maxZ: cz + 0.8, h: 2.3, y0 }
      : { minX: cx - 0.8, minZ: cz + hl, maxX: cx + 0.8, maxZ: cz + hl + 0.35, h: 2.3, y0 };
    const crate = alongX ? { x: cx + hl + 1.4, z: cz } : { x: cx, z: cz + hl + 1.4 };
    houses.push({ id, kind: 'vehicle', vtype, townId: null, x: cx, z: cz, crate, door, biome: biomeName(terrain.biome(cx, cz)), alongX });
    rects.push({ minX: body[0] - 3, minZ: body[1] - 3, maxX: body[2] + 3, maxZ: body[3] + 3 });
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
    const houseCount = t.city ? 5 : n >= 5 ? 3 : 2;
    const roomCount = t.city ? 2 : 1;
    const parkCount = Math.max(1, Math.floor(n * n * 0.1));
    const kinds = new Map();
    cells.forEach(([i, j], idx) => kinds.set(`${i},${j}`,
      idx < houseCount ? 'house' : idx < houseCount + roomCount ? 'room' : idx < houseCount + roomCount + parkCount ? 'park' : t.industrial && rand() < 0.4 ? 'industrial' : 'buildings'));
    kinds.set(`${centre},${centre}`, 'plaza');
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x0 = x0t + i * PITCH, z0 = z0t + j * PITCH, x1 = x0 + BLOCK, z1 = z0 + BLOCK;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const kind = kinds.get(`${i},${j}`);
        if (kind === 'house' || kind === 'room') {
          addHome(kind, cx, cz, t.id);
          rects.pop();   // the town rect already reserves this space
          tb(x0 + 2, z1 - 4, x0 + 5, z1 - 3.4, 1.1, 'cover');
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
        } else {
          if ((i + j) % 3 === 0) {
            const tx = x0 + 6;
            tb(tx - 0.4, z1 - 1, tx + 0.4, z1 - 0.65, 1.5, 'terminal', { terminalId: terminals.length });
            terminals.push({ id: terminals.length, x: tx, z: z1 - 0.65, townId: t.id });
          }
          const split = rand();
          const tall = () => (t.city ? 9 : 5) + rand() * (t.city ? 16 : 7);
          if (split < 0.33) tb(x0 + 1, z0 + 1, x1 - 1, z1 - 1, tall());
          else if (split < 0.66) { tb(x0 + 1, z0 + 1, cx - 2, z1 - 1, tall()); tb(cx + 2, z0 + 1, x1 - 1, z1 - 1, tall()); lootSpawns.push({ x: cx, z: cz, zone: 'town' }); }
          else { tb(x0 + 1, z0 + 1, x1 - 1, cz - 2, tall()); tb(x0 + 1, cz + 2, cx - 2, z1 - 1, tall()); tb(cx + 2, cz + 2, x1 - 1, z1 - 1, tall()); lootSpawns.push({ x: cx - 4, z: cz, zone: 'town' }); }
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
  for (const t of towns) buildTown(t);

  // ---- landmarks: state parks (ranger stations + loot), the dam
  const landmarks = [];
  for (const lm of geo.landmarks) {
    landmarks.push({ ...lm });
    if (lm.kind === 'park') {
      let { x, z } = lm;
      for (let k = 0; k < 20 && (waterDist(x, z) < 30 || inRect(x, z, 20)); k++) { x += 25; z += 10; }
      if (!freeRect(x - 15, z - 15, x + 15, z + 15, 5)) continue;
      rects.push({ minX: x - 15, minZ: z - 15, maxX: x + 15, maxZ: z + 15 });
      ground(x - 6, z - 5, x + 6, z + 5, 4, 'farmhouse');
      lootSpawns.push({ x: x + 9, z, zone: 'park' }, { x: x - 9, z: z + 7, zone: 'park' }, { x, z: z + 9, zone: 'park' });
    } else if (lm.kind === 'dam') {
      box(lm.x - 95, lm.z - 14, lm.x + 95, lm.z + 6, 18, 'dam', { y0: -8 });
    }
  }

  // ---- highways (real routes), wrecks and abandoned vehicles along them
  const inTown = (x, z, pad = 4) => towns.some((t) => x > t.rect.minX - pad && x < t.rect.maxX + pad && z > t.rect.minZ - pad && z < t.rect.maxZ + pad);
  const highways = geo.roads;
  const VT = ['rv', 'bus', 'truck'];
  let vehicleN = 0;
  for (const hw of highways) {
    for (let i = 0; i < hw.pts.length - 1; i++) {
      const [x1, z1] = hw.pts[i], [x2, z2] = hw.pts[i + 1];
      roads.push({ x1, z1, x2, z2, name: hw.name });
      const len = Math.hypot(x2 - x1, z2 - z1);
      for (let d = 60; d < len - 60; d += 70 + rand() * 90) {
        const f = d / len;
        const x = x1 + (x2 - x1) * f, z = z1 + (z2 - z1) * f;
        if (inTown(x, z, 10) || terrain.exact(x, z) < 0.8 || waterDist(x, z) < 20) continue;
        const roll = rand();
        // Pull off to the side of the road.
        const nx = -(z2 - z1) / len, nz = (x2 - x1) / len, side = rand() < 0.5 ? 1 : -1;
        if (roll < 0.09 && vehicleN < 60) {
          const vx = x + nx * side * 9, vz = z + nz * side * 9;
          if (freeRect(vx - 7, vz - 7, vx + 7, vz + 7, 4) && span4(vx, vz, 6, terrain.exact).hi - span4(vx, vz, 6, terrain.exact).lo < 2.5) { addVehicle(VT[vehicleN % 3], vx, vz, Math.abs(x2 - x1) > Math.abs(z2 - z1)); vehicleN++; }
        } else if (roll < 0.5) {
          const ox = x + nx * side * 4, oz = z + nz * side * 4;
          if (rand() < 0.5) ground(ox - 0.95, oz - 2.2, ox + 0.95, oz + 2.2, 1.4, 'car');
          else ground(ox - 2.2, oz - 0.95, ox + 2.2, oz + 0.95, 1.4, 'car');
          lootSpawns.push({ x: ox + nx * side * 3, z: oz + nz * side * 3, zone: 'road' });
        }
      }
    }
  }
  // Houseboats moored along the rivers.
  for (const rv of geo.rivers) {
    for (let i = 0; i < rv.pts.length - 1; i++) {
      const [x1, z1] = rv.pts[i], [x2, z2] = rv.pts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (rand() > 0.55) continue;
      const f = 0.3 + rand() * 0.4;
      const nx = -(z2 - z1) / len, nz = (x2 - x1) / len, side = rand() < 0.5 ? 1 : -1;
      const cx = x1 + (x2 - x1) * f + nx * side * (rv.width / 2 - 3), cz = z1 + (z2 - z1) * f + nz * side * (rv.width / 2 - 3);
      if (inTown(cx, cz, 30) || !freeRect(cx - 8, cz - 8, cx + 8, cz + 8, 4)) continue;
      // The stash door faces the bank.
      const alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
      if (terrain.exact(cx, cz) > -0.5) continue;
      addVehicle('houseboat', cx, cz, alongX);
      const h = houses[houses.length - 1];
      // Put the access point on the bank side.
      const bx = cx - nx * side * (VEHICLE_TYPES.houseboat.wid / 2 + 2.5), bz = cz - nz * side * (VEHICLE_TYPES.houseboat.wid / 2 + 2.5);
      h.crate = { x: bx, z: bz };
      h.door = { minX: bx - 0.8, minZ: bz - 0.8, maxX: bx + 0.8, maxZ: bz + 0.8, h: 0.2, y0: -0.2, gangway: true };
    }
  }

  // ---- countryside, by biome
  const CELL = 1000 * (size / 8000);
  const cellsPerSide = Math.max(1, Math.round(size / CELL));
  const dry = (x, z, min = 0.8) => terrain.exact(x, z) > min;
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      const cx0 = -half + i * CELL, cz0 = -half + j * CELL;
      const pick = (margin) => [cx0 + margin + rand() * (CELL - 2 * margin), cz0 + margin + rand() * (CELL - 2 * margin)];
      const cb = terrain.biome(cx0 + CELL / 2, cz0 + CELL / 2);
      const farms = Math.round((cb.plains + cb.mountain * 0.3) * 3);
      for (let k = 0; k < farms; k++) {
        const [fx, fz] = pick(60);
        const g = span4(fx, fz, 20, terrain.exact);
        if (g.lo < 1.5 || g.hi - g.lo > 4 || !freeRect(fx - 20, fz - 16, fx + 20, fz + 16, 20)) continue;
        rects.push({ minX: fx - 20, minZ: fz - 16, maxX: fx + 20, maxZ: fz + 16 });
        ground(fx - 18, fz - 12, fx - 8, fz - 4, 6, 'farmhouse');
        ground(fx + 2, fz - 14, fx + 16, fz - 2, 8, 'barn');
        ground(fx - 18, fz + 10, fx + 2, fz + 10.5, 1.1, 'cover');
        ground(fx + 8, fz + 4, fx + 8.5, fz + 14, 1.1, 'cover');
        lootSpawns.push({ x: fx - 4, z: fz - 8, zone: 'farm' }, { x: fx + 9, z: fz + 1, zone: 'farm' });
      }
      // Woods: longleaf pine flatwoods in the forest, hardwoods in the hills, cypress in the swamps.
      const woods = Math.round(cb.forest * 8 + cb.plains * 2 + cb.mountain * 4 + cb.sea * 4 + cb.desert * 1);
      for (let k = 0; k < woods; k++) {
        const [fx, fz] = pick(60);
        const rad = 40 + rand() * 90;
        if (inTown(fx, fz, rad)) continue;
        const b0 = terrain.biome(fx, fz);
        const trees = Math.round((20 + rand() * 45) * (0.4 + b0.forest + b0.sea * 0.6));
        const type = b0.forest > 0.4 || b0.desert > 0.4 ? 'pine' : 'tree';
        for (let q = 0; q < trees; q++) {
          const tx = fx + (rand() * 2 - 1) * rad, tz = fz + (rand() * 2 - 1) * rad;
          if ((tx - fx) ** 2 + (tz - fz) ** 2 > rad * rad || inRect(tx, tz, 2) || !dry(tx, tz, 0.4)) continue;
          ground(tx - 0.3, tz - 0.3, tx + 0.3, tz + 0.3, (type === 'pine' ? 13 : 9) + rand() * 6, type);
        }
        lootSpawns.push({ x: fx, z: fz, zone: b0.sea > 0.4 ? 'lake' : 'forest' });
      }
      for (let k = 0; k < 60; k++) {
        const [x, z] = pick(10);
        if (inTown(x, z, 6) || inRect(x, z, 2) || !dry(x, z, 0.6)) continue;
        const b = terrain.biome(x, z);
        const r = rand();
        if (r < b.forest * 0.6 + b.plains * 0.2 + b.sea * 0.5) ground(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 8 + rand() * 6, b.forest > 0.5 ? 'pine' : 'tree');
        else if (r < 0.55 + b.desert * 0.2) { if (b.desert > 0.3) ground(x - 0.9, z - 0.9, x + 0.9, z + 0.9, 1.1 + rand() * 0.6, 'scrub'); }
        else if (r < 0.8) { const w = 1.2 + rand() * (b.mountain * 3 + 1.2), d = 1 + rand() * (b.mountain * 2 + 1.2); ground(x, z, x + w, z + d, 0.8 + rand() * (0.8 + b.mountain * 2), b.mountain > 0.4 ? 'boulder' : 'rock'); }
      }
      const tryHome = (kind, ok, attempts = 30) => {
        for (let k = 0; k < attempts; k++) {
          const [x, z] = pick(100);
          if (!ok(x, z) || !freeRect(x - 12, z - 12, x + 12, z + 22, 30) || inTown(x, z, 80)) continue;
          addHome(kind, x, z);
          return true;
        }
        return false;
      };
      const flatDry = (x, z, maxDiff = 3) => { const g = span4(x, z, 7, terrain.exact); return g.lo > 1 && g.hi - g.lo < maxDiff; };
      if (cb.mountain > 0.3) tryHome('cave', (x, z) => terrain.biome(x, z).mountain > 0.45 && flatDry(x, z, 9));
      if (cb.mountain > 0.2 || cb.desert > 0.3) tryHome('rockfort', (x, z) => { const b = terrain.biome(x, z); return (b.mountain > 0.35 || b.desert > 0.45) && flatDry(x, z); });
      if (cb.forest > 0.35 || cb.sea > 0.2) tryHome('treehut', (x, z) => { const b = terrain.biome(x, z); return (b.forest > 0.45 || b.sea > 0.35) && flatDry(x, z); });
      tryHome('boathouse', (x, z) => {
        const h = terrain.exact(x, z);
        if (h < 0.8 || h > 8 || !flatDry(x, z, 4)) return false;
        return [[0, 24], [0, -24], [24, 0], [-24, 0]].some(([ox, oz]) => terrain.exact(x + ox, z + oz) < -1);
      }, 200);
      const [sx, sz] = pick(150);
      if (!inTown(sx, sz, 80) && dry(sx, sz, 1.5)) campSites.push({ x: sx, z: sz });
    }
  }
  // Landing zones, named after the nearest town.
  const lzGrid = Math.max(2, Math.round(size / 2000));
  for (let i = 0; i < lzGrid; i++) {
    for (let j = 0; j < lzGrid; j++) {
      for (let tries = 0; tries < 60; tries++) {
        const x = -half + (i + 0.2 + rand() * 0.6) * (size / lzGrid), z = -half + (j + 0.2 + rand() * 0.6) * (size / lzGrid);
        const g = span4(x, z, 6, terrain.exact);
        if (inTown(x, z, 40) || g.lo < 1.5 || g.hi - g.lo > 4) continue;
        const near = towns.reduce((a, t) => (!a || Math.hypot(t.x - x, t.z - z) < Math.hypot(a.x - x, a.z - z) ? t : a), null);
        landingZones.push({ id: landingZones.length, name: `LZ ${String.fromCharCode(65 + landingZones.length)} (${near ? near.name : 'wilds'})`, x, z });
        break;
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
  // Labels for the map screen.
  const labels = [
    ...towns.map((t) => ({ text: t.name, x: t.x, z: t.rect.minZ - 6, kind: 'town' })),
    ...geo.rivers.map((r) => { const p = r.pts[Math.floor(r.pts.length / 2)]; return { text: r.name, x: p[0], z: p[1], kind: 'water' }; }),
    ...geo.lakes.map((l) => ({ text: l.name, x: (l.caps[0][0][0] + l.caps[0][1][0]) / 2, z: (l.caps[0][0][1] + l.caps[0][1][1]) / 2, kind: 'water' })),
    ...landmarks.map((l) => ({ text: l.name, x: l.x, z: l.z, kind: 'landmark' })),
  ];
  return {
    seed, size, half, boxes, grid, terrain, houses, towns, roads, highways, bridges: terrain.bridges, landmarks, labels, contacts, terminals,
    lootSpawns: lootSpawns.filter((p) => free(p)), landingZones, campSites, origin: geo.origin,
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
