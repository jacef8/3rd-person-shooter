// Shared world definition + geometry helpers. Runs in both Node (server) and the browser (client).
//
// The world is generated deterministically from (seed, size). The server and every client run the
// same generator, so the multi-megabyte map never goes over the network: the server only sends the
// seed and size and the client rebuilds the identical world. Generation therefore only uses
// + - * / and the seeded RNG (no Math.sin etc., which can differ between JS engines).

import { createTerrain, biomeName, DEEP_WATER, MAX_STEP_SLOPE, BRIDGE_DECK, PAD_MARGIN, RELIEF, COVER } from './terrain.js';
import { polyDist, lakeDepth, segDist, project, REAL_SIZE } from './geography.js';
import RIVER from './data/river.json' with { type: 'json' };
import EXTRA from './data/real-extra.json' with { type: 'json' };
export { WATER_LEVEL } from './terrain.js';

export const DEFAULT_WORLD_SIZE = REAL_SIZE;   // 30 x 30 km of the real Bristol, FL area at 1:1
const NATURE_ID = 1e7;                          // ids of lazily generated trees/rocks start here
export const PLAYER_RADIUS = 0.45;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.2;
export const STAND_EYE = 1.6;
export const CROUCH_EYE = 1.05;
export const PRONE_EYE = 0.45;
export const PRONE_HEIGHT = 0.6;
export const PRONE_SPEED = 1.3;
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
 * 30 km world with thousands of buildings and lazily generated forests cheap.
 */
let STAMP = 0;   // shared by every grid, so an object can sit in more than one grid
export class SpatialGrid {
  constructor(half, cell = 32) {
    this.half = half;
    this.cell = cell;
    this.n = Math.ceil((half * 2) / cell) + 2;
    this.cells = new Map();
    this.loader = null;      // optional lazy content: { tile, fn(tx, tz), done: Set }
  }
  ci(v) { return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.half) / this.cell))); }
  /** Fill in lazily generated content (countryside trees and rocks) for a tile the first time it's touched. */
  setLoader(tile, fn) { this.loader = { tile, fn, done: new Set() }; }
  load(minX, minZ, maxX, maxZ) {
    const L = this.loader;
    if (!L) return;
    const t0 = Math.floor((minX + this.half) / L.tile), t1 = Math.floor((maxX + this.half) / L.tile);
    const u0 = Math.floor((minZ + this.half) / L.tile), u1 = Math.floor((maxZ + this.half) / L.tile);
    for (let tx = t0; tx <= t1; tx++) for (let tz = u0; tz <= u1; tz++) {
      const k = tx * 100000 + tz;
      if (L.done.has(k)) continue;
      L.done.add(k);
      L.fn(tx, tz);
    }
  }
  insert(b) {
    for (let ix = this.ci(b.minX); ix <= this.ci(b.maxX); ix++) {
      for (let iz = this.ci(b.minZ); iz <= this.ci(b.maxZ); iz++) {
        const k = ix * 65536 + iz;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(b);
      }
    }
  }
  /** Boxes overlapping the rectangle. `noLoad` skips lazy content that isn't generated yet. */
  rect(minX, minZ, maxX, maxZ, out = [], noLoad = false) {
    if (!noLoad) this.load(minX, minZ, maxX, maxZ);
    const s = ++STAMP;
    for (let ix = this.ci(minX); ix <= this.ci(maxX); ix++) {
      for (let iz = this.ci(minZ); iz <= this.ci(maxZ); iz++) {
        const list = this.cells.get(ix * 65536 + iz);
        if (!list) continue;
        for (const b of list) {
          if (b._s === s) continue;
          b._s = s;
          if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) out.push(b);
        }
      }
    }
    return out;
  }
  near(x, z, r, out = [], noLoad = false) { return this.rect(x - r, z - r, x + r, z + r, out, noLoad); }
  /** Boxes in the grid cells a ray passes through (2D DDA), up to maxDist. */
  ray(ox, oz, dx, dz, maxDist, out = []) {
    const c = this.cell;
    const len = Math.hypot(dx, dz);
    if (this.loader) { const f = maxDist * len; this.load(Math.min(ox, ox + dx / (len || 1) * f), Math.min(oz, oz + dz / (len || 1) * f), Math.max(ox, ox + dx / (len || 1) * f), Math.max(oz, oz + dz / (len || 1) * f)); }
    const s = ++STAMP;
    let ix = this.ci(ox), iz = this.ci(oz);
    const visit = () => {
      const list = this.cells.get(ix * 65536 + iz);
      if (!list) return;
      for (const b of list) if (b._s !== s) { b._s = s; out.push(b); }
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
  shack:     { name: 'River shack', wall: 'plankwall' },
  vehicle:   { name: 'Abandoned vehicle', wall: 'vehiclebody' },
};
export const VEHICLE_TYPES = {
  rv:        { name: 'RV', len: 8, wid: 3, h: 3.2 },
  bus:       { name: 'School bus', len: 11, wid: 3, h: 3.3 },
  truck:     { name: 'Box truck', len: 7, wid: 2.6, h: 3.1 },
  houseboat: { name: 'Houseboat', len: 11, wid: 4.5, h: 3 },
};

/**
 * Open world laid out on the real area around Bristol, Florida at 1:1 scale (see geography.js):
 * the real towns at their real positions, the Apalachicola / Ochlockonee rivers and their swamps,
 * Lake Mystic, the real highways with bridges where they cross the rivers, the Torreya bluffs,
 * sandhill scrub and the national forest flatwoods. Homes you can claim: town houses, apartment
 * rooms, limestone caves, rock outcrops, hollow cypress trees, river fish camps and abandoned
 * vehicles (RVs, buses, box trucks, houseboats).
 *
 * `real` is the real-world data from tools/import_real_world.py (all optional):
 *   structures: [[lat, lon, width, depth, height, class, name?], ...]   real building footprints
 *   roads:      [[name, class, [[lat, lon], ...]], ...]                  real roads, 'track' = dirt
 *   elevation:  the real ground (terrain.parseElevation), with real water cut in
 *   landcover:  what covers the ground (terrain.parseLandcover): real woods, fields, pasture, town
 *   infrastructure: towers, water towers, substations, power lines, the solar farm, railways, places
 * With structures, every real building becomes a walk-in building on a level pad, each town shrinks
 * to a small compound, and the procedural stand-in buildings (town blocks, farms, roadside
 * homesteads) are left out.
 *
 * The countryside's trees, rocks and scrub (hundreds of thousands at real scale) aren't stored:
 * they're generated per 128 m tile, deterministically, the first time anything looks at that tile.
 */
export function generateMap(seed = 1337, size = DEFAULT_WORLD_SIZE, real = {}) {
  const rand = mulberry32(seed);
  const half = size / 2;
  const terrain = createTerrain(seed, size, real.elevation || null, real.landcover || null);
  const geo = terrain.geo;
  const boxes = [], buildings = [], houses = [], lootSpawns = [], terminals = [], contacts = [], towns = [], roads = [], campSites = [], landingZones = [];
  const realStructs = Array.isArray(real.structures) && real.structures.length > 0;
  const grid = new SpatialGrid(half + 4, 32);
  const reserved = new SpatialGrid(half + 4, 64);   // areas kept clear: towns, homes, farms, vehicles
  const roadGrid = new SpatialGrid(half + 4, 64);   // road segments (highways + imported roads)
  const reserve = (r) => { reserved.insert(r); return r; };

  const box = (minX, minZ, maxX, maxZ, h, type = 'building', extra = {}) => {
    const b = { id: boxes.length, minX, minZ, maxX, maxZ, h, y0: 0, type, ...extra };
    boxes.push(b);
    grid.insert(b);
    return b;
  };
  const ground = (minX, minZ, maxX, maxZ, h, type, extra = {}) => {
    const hs = [terrain.exact(minX, minZ), terrain.exact(maxX, minZ), terrain.exact(minX, maxZ), terrain.exact(maxX, maxZ)];
    const lo = Math.min(...hs), hi = Math.max(...hs);
    return box(minX, minZ, maxX, maxZ, h + (hi - lo) + 0.4, type, { y0: lo - 0.4, ...extra });
  };
  /**
   * A building you can walk into: walls with doorways, a ceiling with any upper storeys solid above
   * it, an interior wall with a gap in the bigger ones, and loot spots inside. `base` is the floor
   * height (a town's flattened ground); leave it null to sit the building on the terrain.
   */
  const STOREY = 3.4, WALL = 0.3, DOOR_W = 1.6, DOOR_H = 2.4;
  function shell(minX, minZ, maxX, maxZ, h, type, zone, base = null, opts = {}) {
    const w = maxX - minX, d = maxZ - minZ;
    let y0 = base, storey = STOREY, total = h;
    if (base !== null && opts.sink) { y0 = base - opts.sink; storey = STOREY + opts.sink; total = h + opts.sink; }
    if (base === null) {
      const hs = [terrain.exact(minX, minZ), terrain.exact(maxX, minZ), terrain.exact(minX, maxZ), terrain.exact(maxX, maxZ), terrain.exact((minX + maxX) / 2, (minZ + maxZ) / 2)];
      const lo = Math.min(...hs), hi = Math.max(...hs);
      y0 = lo - 0.4; storey = STOREY + (hi - lo) + 0.4; total = h + (hi - lo) + 0.4;
    }
    // Every piece of one building shares `bldg`, so the client can paint it one colour.
    const bldg = buildings.length + boxes.length * 7919;
    if (w < 5 || d < 5) return box(minX, minZ, maxX, maxZ, total, type, { y0, bldg, ...(opts.real ? { real: 1 } : {}) });
    const oneStorey = total < storey + 1;
    const wallH = oneStorey ? total - 0.3 : storey;
    const part = { y0, shell: 1, bldg, ...(opts.real ? { real: 1 } : {}) };
    const floorAt = (x, z) => (base === null ? terrain.exact(x, z) : base);
    // Doorways: small buildings get one, bigger ones a pair on opposite sides so you can run through.
    const sides = ['n', 's', 'w', 'e'];
    const doors = new Set();
    const rec = { minX, minZ, maxX, maxZ, type, floor: y0, ...(opts.sink ? { pad: base } : {}), doors: [], top: y0 + (oneStorey ? wallH + 0.3 : total), roof: opts.roof || null, bldg, ...(opts.real ? { real: 1 } : {}), ...(opts.name ? { name: opts.name } : {}) };
    buildings.push(rec);
    if (Math.max(w, d) < 10) doors.add(sides[Math.floor(rand() * 4)]);
    else if (rand() < 0.5) { doors.add('n'); doors.add('s'); } else { doors.add('w'); doors.add('e'); }
    const wallRun = (side) => {
      const horiz = side === 'n' || side === 's';
      const len = horiz ? w : d, a0 = horiz ? minX : minZ;
      const fixed0 = side === 'n' ? minZ : side === 's' ? maxZ - WALL : side === 'w' ? minX : maxX - WALL;
      const seg = (a, b, y, hh) => {
        if (b - a < 0.05) return;
        if (horiz) box(a, fixed0, b, fixed0 + WALL, hh, type, { ...part, y0: y });
        else box(fixed0, a, fixed0 + WALL, b, hh, type, { ...part, y0: y });
      };
      if (!doors.has(side)) return seg(a0, a0 + len, y0, wallH);
      // Keep doorways that face the interior wall's end clear of it.
      const facesPartition = Math.max(w, d) >= 14 && horiz === (w >= d);
      const frac = facesPartition ? (rand() < 0.5 ? 0.18 + rand() * 0.2 : 0.62 + rand() * 0.2) : 0.3 + rand() * 0.4;
      const c = a0 + len * frac, da = c - DOOR_W / 2, db = c + DOOR_W / 2;
      seg(a0, da, y0, wallH);
      seg(db, a0 + len, y0, wallH);
      // Lintel over the doorway.
      const doorFloor = horiz ? floorAt(c, fixed0) : floorAt(fixed0, c);
      // Door centre and the outward direction (for tests and, later, AI pathing).
      const out = side === 'n' ? [0, -1] : side === 's' ? [0, 1] : side === 'w' ? [-1, 0] : [1, 0];
      rec.doors.push(horiz ? { x: c, z: fixed0 + WALL / 2, out } : { x: fixed0 + WALL / 2, z: c, out });
      const top = Math.max(doorFloor + DOOR_H, y0 + 0.1);
      if (y0 + wallH - top > 0.05) seg(da, db, top, y0 + wallH - top);
    };
    for (const sd of sides) wallRun(sd);
    // Interior wall across the long axis, with a doorway in it.
    const alongX = w >= d;
    let mid = null;
    if (Math.max(w, d) >= 14) {
      mid = alongX ? (minX + maxX) / 2 : (minZ + maxZ) / 2;
      const a0 = (alongX ? minZ : minX) + WALL, a1 = (alongX ? maxZ : maxX) - WALL;
      const g0 = a0 + 1 + rand() * (a1 - a0 - 2 - DOOR_W), g1 = g0 + DOOR_W;
      for (const [a, b] of [[a0, g0], [g1, a1]]) {
        if (alongX) box(mid - WALL / 2, a, mid + WALL / 2, b, wallH, type, part);
        else box(a, mid - WALL / 2, b, mid + WALL / 2, wallH, type, part);
      }
    }
    // Ceiling (one storey) or the solid upper floors.
    if (oneStorey) box(minX, minZ, maxX, maxZ, 0.3, type, { ...part, y0: y0 + wallH });
    else box(minX, minZ, maxX, maxZ, total - storey, type, { ...part, y0: y0 + storey });
    // Loot inside: one spot per ~120 m² of floor, up to 3, kept off the walls.
    const n = zone ? Math.max(1, Math.min(3, Math.floor((w * d) / 120))) : 0;
    for (let k = 0; k < n; k++) {
      let x = minX + 1.6 + rand() * (w - 3.2), z = minZ + 1.6 + rand() * (d - 3.2);
      if (mid !== null) {
        // Alternate sides of the interior wall and keep clear of it.
        const half = k % 2 ? 1 : -1, span = (alongX ? w : d) / 2 - 3.2;
        const v = mid + half * (1.6 + rand() * Math.max(0, span));
        if (alongX) x = v; else z = v;
      }
      lootSpawns.push({ x, z, zone, indoor: true });
    }
    return null;
  }
  /**
   * A real building at its real angle and shape. `rects` are pieces in its own frame (x along its
   * walls), relative to (cx, cz). Walls run only along the outside of the shape (where two pieces
   * meet it's open inside), with one or two doorways; a ceiling over each piece; loot inside.
   */
  function realShell(cx, cz, ang, rects, h, type, zone, base, opts = {}) {
    // Its own random numbers (from where it stands), so a change to one building never reshuffles the rest of the map.
    const rand = mulberry32((Math.round(cx * 10) * 73856093) ^ (Math.round(cz * 10) * 19349663) ^ seed);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const W = (lx, lz) => [cx + lx * ca - lz * sa, cz + lx * sa + lz * ca];
    const y0 = base - opts.sink, storey = STOREY + opts.sink, total = h + opts.sink;
    const bldg = buildings.length + boxes.length * 7919;
    const part = { shell: 1, bldg, real: 1 };
    const obox = (x0, z0, x1, z1, hh, yy, extra = {}) => {
      const [wx, wz] = W((x0 + x1) / 2, (z0 + z1) / 2);
      const b = orientedBox(wx, wz, (x1 - x0) / 2, (z1 - z0) / 2, ang, { id: boxes.length, h: hh, y0: yy, type, ...part, ...extra });
      boxes.push(b);
      grid.insert(b);
      return b;
    };
    // The building's footprint in the world (around every piece), for the record.
    let lx0 = Infinity, lz0 = Infinity, lx1 = -Infinity, lz1 = -Infinity;
    for (const [x0, z0, x1, z1] of rects) { lx0 = Math.min(lx0, x0); lz0 = Math.min(lz0, z0); lx1 = Math.max(lx1, x1); lz1 = Math.max(lz1, z1); }
    const corners = rects.flatMap(([x0, z0, x1, z1]) => [W(x0, z0), W(x1, z0), W(x0, z1), W(x1, z1)]);
    const bb = { minX: Math.min(...corners.map((q) => q[0])), maxX: Math.max(...corners.map((q) => q[0])), minZ: Math.min(...corners.map((q) => q[1])), maxZ: Math.max(...corners.map((q) => q[1])) };
    // Too small to walk into: a solid block per piece.
    if (lx1 - lx0 < 5 || lz1 - lz0 < 5) { for (const [x0, z0, x1, z1] of rects) obox(x0, z0, x1, z1, total, y0); return null; }
    const oneStorey = total < storey + 1;
    const wallH = oneStorey ? total - 0.3 : storey;
    const rec = { ...bb, cx, cz, ang, rects, type, floor: y0, pad: base, doors: [], top: y0 + (oneStorey ? wallH + 0.3 : total), roof: opts.roof || null, bldg, real: 1, ...(opts.name ? { name: opts.name } : {}) };
    buildings.push(rec);
    // Outside walls: each piece's edges, minus where another piece carries on past them.
    const EPS = 0.05, runs = [];
    rects.forEach(([x0, z0, x1, z1], i) => {
      const sides = [
        { side: 'n', along: 'x', at: z0, a: x0, b: x1, out: z0 - EPS },
        { side: 's', along: 'x', at: z1, a: x0, b: x1, out: z1 + EPS },
        { side: 'w', along: 'z', at: x0, a: z0, b: z1, out: x0 - EPS },
        { side: 'e', along: 'z', at: x1, a: z0, b: z1, out: x1 + EPS },
      ];
      for (const sd of sides) {
        let parts = [[sd.a, sd.b]];
        rects.forEach(([qx0, qz0, qx1, qz1], j) => {
          if (j === i) return;
          const crosses = sd.along === 'x' ? qz0 < sd.out && qz1 > sd.out : qx0 < sd.out && qx1 > sd.out;
          if (!crosses) return;
          const c0 = sd.along === 'x' ? qx0 : qz0, c1 = sd.along === 'x' ? qx1 : qz1;
          parts = parts.flatMap(([a, b]) => (c1 <= a || c0 >= b ? [[a, b]] : [[a, Math.max(a, c0)], [Math.min(b, c1), b]].filter(([p, q]) => q - p > 0.2)));
        });
        for (const [a, b] of parts) runs.push({ ...sd, a, b, len: b - a });
      }
    });
    // Doorways: one in a small building, two in a bigger one (on different sides when it can).
    const area = rects.reduce((t, [x0, z0, x1, z1]) => t + (x1 - x0) * (z1 - z0), 0);
    const fit = runs.filter((r) => r.len >= DOOR_W + 1.4).sort((p, q) => q.len - p.len);
    const doorRuns = new Set();
    if (fit.length) {
      doorRuns.add(fit[Math.floor(rand() * Math.min(2, fit.length))]);
      if (area >= 100) { const other = fit.find((r) => !doorRuns.has(r) && ![...doorRuns].some((d) => d.side === r.side)); if (other) doorRuns.add(other); }
    }
    const OUT = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (const r of runs) {
      // A wall piece along this run, `WALL` thick, on the inside of the line.
      const seg = (a, b, yy, hh) => {
        if (b - a < 0.05) return;
        if (r.side === 'n') obox(a, r.at, b, r.at + WALL, hh, yy);
        else if (r.side === 's') obox(a, r.at - WALL, b, r.at, hh, yy);
        else if (r.side === 'w') obox(r.at, a, r.at + WALL, b, hh, yy);
        else obox(r.at - WALL, a, r.at, b, hh, yy);
      };
      if (!doorRuns.has(r)) { seg(r.a, r.b, y0, wallH); continue; }
      const c = r.a + r.len * (0.3 + rand() * 0.4), da = c - DOOR_W / 2, db = c + DOOR_W / 2;
      seg(r.a, da, y0, wallH);
      seg(db, r.b, y0, wallH);
      const inward = r.side === 'n' || r.side === 'w' ? WALL / 2 : -WALL / 2;
      const [dx, dz] = r.along === 'x' ? W(c, r.at + inward) : W(r.at + inward, c);
      const [ox, oz] = OUT[r.side];
      // The door's centre, which way is out, and the angle of the wall it sits in.
      rec.doors.push({ x: dx, z: dz, out: [ox * ca - oz * sa, ox * sa + oz * ca], ang: r.along === 'x' ? ang : ang + Math.PI / 2 });
      const top = Math.max(terrain.exact(dx, dz) + DOOR_H, y0 + 0.1);
      if (y0 + wallH - top > 0.05) seg(da, db, top, y0 + wallH - top);
    }
    // One big room: an interior wall across it, with a gap.
    let mid = null;
    const one = rects.length === 1 ? rects[0] : null;
    const alongX = one ? one[2] - one[0] >= one[3] - one[1] : true;
    if (one && Math.max(one[2] - one[0], one[3] - one[1]) >= 14) {
      const [x0, z0, x1, z1] = one;
      mid = alongX ? (x0 + x1) / 2 : (z0 + z1) / 2;
      const a0 = (alongX ? z0 : x0) + WALL, a1 = (alongX ? z1 : x1) - WALL;
      const g0 = a0 + 1 + rand() * (a1 - a0 - 2 - DOOR_W), g1 = g0 + DOOR_W;
      for (const [a, b] of [[a0, g0], [g1, a1]]) {
        if (alongX) obox(mid - WALL / 2, a, mid + WALL / 2, b, wallH, y0);
        else obox(a, mid - WALL / 2, b, mid + WALL / 2, wallH, y0);
      }
    }
    // A ceiling over each piece (or the solid upper floors).
    for (const [x0, z0, x1, z1] of rects) {
      if (oneStorey) obox(x0, z0, x1, z1, 0.3, y0 + wallH);
      else obox(x0, z0, x1, z1, total - storey, y0 + storey);
    }
    // Loot inside: one spot per ~120 m² of floor, up to 3, in the bigger pieces and off the walls.
    const n = zone ? Math.max(1, Math.min(3, Math.floor(area / 120))) : 0;
    const roomy = rects.filter(([x0, z0, x1, z1]) => x1 - x0 > 3.4 && z1 - z0 > 3.4);
    for (let k = 0; k < n && roomy.length; k++) {
      const [x0, z0, x1, z1] = roomy[k % roomy.length];
      let lx = x0 + 1.6 + rand() * (x1 - x0 - 3.2), lz = z0 + 1.6 + rand() * (z1 - z0 - 3.2);
      if (mid !== null) { const v = mid + (k % 2 ? 1 : -1) * (1.6 + rand() * Math.max(0, ((alongX ? x1 - x0 : z1 - z0) / 2) - 3.2)); if (alongX) lx = v; else lz = v; }
      const [wx, wz] = W(lx, lz);
      lootSpawns.push({ x: wx, z: wz, zone, indoor: true });
    }
    return null;
  }
  const inBounds = (minX, minZ, maxX, maxZ) => minX > -half + 30 && maxX < half - 30 && minZ > -half + 30 && maxZ < half - 30;
  const inRect = (x, z, pad = 0) => reserved.near(x, z, pad + 1).some((r) => x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad);
  const freeRect = (minX, minZ, maxX, maxZ, pad = 0) => inBounds(minX, minZ, maxX, maxZ) &&
    !reserved.rect(minX - pad - 1, minZ - pad - 1, maxX + pad + 1, maxZ + pad + 1).some((r) => maxX + pad > r.minX && minX - pad < r.maxX && maxZ + pad > r.minZ && minZ - pad < r.maxZ);
  const solidAt = (minX, minZ, maxX, maxZ) => grid.rect(minX, minZ, maxX, maxZ, [], true).some((b) => b.type !== 'canopy' && b.type !== 'caveroof');
  const span4 = (x, z, r, f = terrain.raw) => { const hs = [f(x - r, z - r), f(x + r, z - r), f(x - r, z + r), f(x + r, z + r), f(x, z)]; return { lo: Math.min(...hs), hi: Math.max(...hs) }; };
  const waterDist = (x, z) => Math.min(...geo.rivers.map((r) => polyDist(x, z, r.pts) - r.width / 2), ...geo.lakes.map((l) => -lakeDepth(x, z, l)));
  const addRoadSeg = (x1, z1, x2, z2, name, width, extra) => {
    const r = { x1, z1, x2, z2, name, width, ...extra, minX: Math.min(x1, x2) - width, maxX: Math.max(x1, x2) + width, minZ: Math.min(z1, z2) - width, maxZ: Math.max(z1, z2) + width };
    roads.push(r);
    roadGrid.insert(r);
  };
  /** Distance to the nearest road edge within `r` metres (Infinity if none). */
  const roadDist = (x, z, r = 20) => {
    let best = Infinity;
    for (const s of roadGrid.near(x, z, r)) best = Math.min(best, segDist(x, z, s.x1, s.z1, s.x2, s.z2).d - s.width / 2);
    return best;
  };

  // ---- real towns, nudged onto dry ground where the real one sits right on the water
  // With real buildings, the game's own "town" shrinks to the Authority's compound: a small paved
  // post (the Contact, quarters to claim, terminals, cover) set on the emptiest ground near the real
  // centre, so the real downtown around it is left standing.
  const realXZ = realStructs ? real.structures.map(([lat, lon]) => project(lat, lon, size)) : [];
  for (const gt of geo.towns) {
    const blocks = realStructs ? Math.min(gt.blocks, 3) : gt.blocks;
    const span = blocks * PITCH - STREET;
    const r = span / 2 + STREET;
    let pos = null, bestScore = Infinity;
    for (let ring = 0; ring <= 16 && (!pos || (realStructs && ring <= 6)); ring++) {
      const steps = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < steps && (!pos || realStructs); k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = gt.x + (ring ? Math.cos(a) * ring * 60 : 0), z = gt.z + (ring ? Math.sin(a) * ring * 60 : 0);
        if (Math.abs(x) > half - r - 40 || Math.abs(z) > half - r - 40) continue;
        if (waterDist(x, z) < r * 1.42 + 25) continue;
        if (!freeRect(x - r, z - r, x + r, z + r, 40)) continue;
        if (!realStructs) { pos = { x, z }; continue; }
        // Fewest real buildings underfoot wins; nearer the centre breaks ties.
        const score = realXZ.reduce((n, q) => n + (Math.abs(q.x - x) < r + 10 && Math.abs(q.z - z) < r + 10 ? 1 : 0), 0) * 100 + ring;
        if (score < bestScore) { bestScore = score; pos = { x, z }; }
      }
    }
    if (!pos) continue;
    const g = span4(pos.x, pos.z, r);
    const t = {
      id: towns.length, name: gt.name, county: gt.county, x: pos.x, z: pos.z, blocks, span,
      city: gt.blocks >= 13, industrial: gt.blocks >= 9 && rand() < 0.5, biome: biomeName(terrain.biome(pos.x, pos.z)),
      elev: Math.max(2.5, (g.lo + g.hi) / 2), real: gt.real,
    };
    t.rect = reserve({ minX: pos.x - r, minZ: pos.z - r, maxX: pos.x + r, maxZ: pos.z + r });
    towns.push(t);
  }
  const townFlats = towns.map((t) => ({ ...t.rect, elev: t.elev, margin: 60 }));
  terrain.setFlats(townFlats);
  // Every real building stands on a level pad cut into (or built up on) the real ground.
  const realPads = [];
  if (realStructs) {
    for (const row of real.structures) {
      const [lat, lon, w0, d0] = row;
      const { x, z } = project(lat, lon, size);
      const w = Math.max(3, Math.min(120, w0 || 10)), d = Math.max(3, Math.min(120, d0 || 10));
      // Turned buildings take the area around them (the pad is levelled a little wider anyway).
      const ang = (row[7] || 0) * Math.PI / 180, ca = Math.abs(Math.cos(ang)), sa = Math.abs(Math.sin(ang));
      const ex = (ca * w + sa * d) / 2, ez = (sa * w + ca * d) / 2;
      const minX = x - ex, minZ = z - ez, maxX = x + ex, maxZ = z + ez;
      const hs = [terrain.exact(minX, minZ), terrain.exact(maxX, minZ), terrain.exact(minX, maxZ), terrain.exact(maxX, maxZ), terrain.exact(x, z)];
      const lo = Math.min(...hs), hi = Math.max(...hs);
      // Not in the water, and not on a slope too steep to cut a pad into (hills are drawn RELIEF x taller).
      realPads.push(minX > -half + 30 && maxX < half - 30 && minZ > -half + 30 && maxZ < half - 30 && lo > 0.3 && hi - lo < 4 * RELIEF + 0.15 * Math.max(w, d)
        ? { minX, minZ, maxX, maxZ, x, z, w, d, ang, rects: row[8] || null, elev: Math.round((hs.reduce((a, b) => a + b) / 5) * 100) / 100, margin: PAD_MARGIN, pad: 1 } : null);
    }
    terrain.setFlats([...townFlats, ...realPads.filter(Boolean)]);
  }

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
    reserve({ minX: cx - hs - 5, minZ: cz - hs - 5, maxX: cx + hs + 5, maxZ: cz + hs + 16, home: 1 });
    lootSpawns.push({ x: cx + 9, z: cz + 9, zone: kind === 'house' || kind === 'room' ? 'town' : kind === 'boathouse' || kind === 'shack' ? 'lake' : biomeName(terrain.biome(cx, cz)) });
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
    reserve({ minX: body[0] - 3, minZ: body[1] - 3, maxX: body[2] + 3, maxZ: body[3] + 3, home: 1 });
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
      idx < houseCount ? 'house' : idx < houseCount + roomCount ? 'room' : idx < houseCount + roomCount + parkCount ? 'park' : !realStructs && t.industrial && rand() < 0.4 ? 'industrial' : 'buildings'));
    kinds.set(`${centre},${centre}`, 'plaza');
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x0 = x0t + i * PITCH, z0 = z0t + j * PITCH, x1 = x0 + BLOCK, z1 = z0 + BLOCK;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const kind = kinds.get(`${i},${j}`);
        if (kind === 'house' || kind === 'room') {
          addHome(kind, cx, cz, t.id);
          tb(x0 + 2, z1 - 4, x0 + 5, z1 - 3.4, 1.1, 'cover');
        } else if (kind === 'plaza') {
          contacts.push({ id: contacts.length, townId: t.id, name: `${t.name} Contact`, x: cx, z: cz });
          reserve({ minX: x0, minZ: z0, maxX: x1, maxZ: z1, home: 1 });
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
          if (rand() < 0.5) { shell(x0 + 1, z0 + 1, x1 - 1, cz - 1.5, 7 + rand() * 3, 'warehouse', 'industrial', y0); shell(x0 + 1, cz + 4, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse', 'industrial', y0); lootSpawns.push({ x: cx, z: cz + 1.2, zone: 'industrial' }); }
          else { shell(x0 + 1, z0 + 1, cx - 1.5, z1 - 1, 7 + rand() * 3, 'warehouse', 'industrial', y0); shell(cx + 4, z0 + 1, x1 - 1, z1 - 1, 7 + rand() * 3, 'warehouse', 'industrial', y0); lootSpawns.push({ x: cx + 1.2, z: cz, zone: 'industrial' }); }
        } else {
          if ((i + j) % 3 === 0) {
            const tx = x0 + 6;
            // On the sidewalk, clear of the building's doorways.
            tb(tx - 0.4, z1 + 0.6, tx + 0.4, z1 + 0.95, 1.5, 'terminal', { terminalId: terminals.length });
            terminals.push({ id: terminals.length, x: tx, z: z1 + 0.95, townId: t.id });
          }
          const split = rand();
          if (realStructs) {
            // The real town is all around; a spare lot in the compound is a yard of barricades.
            for (let k = 0; k < 5; k++) {
              const w = 1.5 + rand() * 3.5, d = 0.6 + rand() * 1.4;
              const px = x0 + 3 + rand() * (BLOCK - 6 - w), pz = z0 + 3 + rand() * (BLOCK - 6 - d);
              if (rand() < 0.5) tb(px, pz, px + d, pz + w, 1.1 + rand() * 0.4, 'cover'); else tb(px, pz, px + w, pz + d, 1.1 + rand() * 0.4, 'cover');
            }
            lootSpawns.push({ x: cx, z: cz, zone: 'town' });
            continue;
          }
          if (!t.city && split < 0.6) {
            // Small-town residential block: a few single-storey houses in yards.
            const lots = [[x0 + 1.5, z0 + 1.5], [cx + 1.5, z0 + 1.5], [x0 + 1.5, cz + 1.5], [cx + 1.5, cz + 1.5]];
            for (const [lx, lz] of lots) {
              if (rand() < 0.3) continue;
              const w = 8 + rand() * 4, d = 7 + rand() * 4;
              shell(lx + 1, lz + 1, lx + 1 + Math.min(w, BLOCK / 2 - 4), lz + 1 + Math.min(d, BLOCK / 2 - 4), 3.6 + rand() * 1.6, 'building', 'town', y0);
            }
            if (rand() < 0.6) tb(cx - 0.3, cz - 0.3, cx + 0.3, cz + 0.3, 9 + rand() * 5, 'tree');
            lootSpawns.push({ x: cx, z: cz, zone: 'town' });
            continue;
          }
          const tall = () => (t.city ? 9 : 5) + rand() * (t.city ? 16 : 7);
          const sh = (a, b, c, d) => shell(a, b, c, d, tall(), 'building', 'town', y0);
          if (split < 0.33) sh(x0 + 1, z0 + 1, x1 - 1, z1 - 1);
          else if (split < 0.66) { sh(x0 + 1, z0 + 1, cx - 2, z1 - 1); sh(cx + 2, z0 + 1, x1 - 1, z1 - 1); lootSpawns.push({ x: cx, z: cz, zone: 'town' }); }
          else { sh(x0 + 1, z0 + 1, x1 - 1, cz - 2); sh(x0 + 1, cz + 2, cx - 2, z1 - 1); sh(cx + 2, cz + 2, x1 - 1, z1 - 1); lootSpawns.push({ x: cx - 4, z: cz, zone: 'town' }); }
        }
      }
    }
    for (let s = 0; s < n - 1; s++) {
      const mid = x0t + s * PITCH + BLOCK + STREET / 2;
      const midZ = z0t + s * PITCH + BLOCK + STREET / 2;
      for (let k = 0; k < 2 && !realStructs; k++) {
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
      for (let k = 0; k < 40 && (waterDist(x, z) < 30 || inRect(x, z, 20) || terrain.exact(x, z) < 1); k++) { x += 25; z += 10; }
      if (!freeRect(x - 15, z - 15, x + 15, z + 15, 5)) continue;
      reserve({ minX: x - 15, minZ: z - 15, maxX: x + 15, maxZ: z + 15 });
      shell(x - 6, z - 5, x + 6, z + 5, 4, 'farmhouse', 'park');
      lootSpawns.push({ x: x + 9, z, zone: 'park' }, { x: x - 9, z: z + 7, zone: 'park' }, { x, z: z + 9, zone: 'park' });
    } else if (lm.kind === 'dam') {
      box(lm.x - 95, lm.z - 14, lm.x + 95, lm.z + 6, 18, 'dam', { y0: -8 });
    }
  }

  // ---- roads: the traced highways, plus every imported OpenStreetMap road
  const highways = geo.roads;
  for (const hw of highways) for (let i = 0; i < hw.pts.length - 1; i++) addRoadSeg(hw.pts[i][0], hw.pts[i][1], hw.pts[i + 1][0], hw.pts[i + 1][1], hw.name, 12, { hw: 1 });
  const ROAD_W = { motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, unclassified: 6, residential: 6, service: 4, track: 4 };
  for (const [name, cls, pts] of real.roads || []) {
    const w = ROAD_W[cls] || 5;
    const p = pts.map(([lat, lon]) => project(lat, lon, size));
    for (let i = 0; i < p.length - 1; i++) {
      if (Math.max(Math.abs(p[i].x), Math.abs(p[i].z), Math.abs(p[i + 1].x), Math.abs(p[i + 1].z)) > half + 200) continue;
      addRoadSeg(p[i].x, p[i].z, p[i + 1].x, p[i + 1].z, name || '', w, cls === 'track' ? { cls, dirt: 1 } : { cls });
    }
  }

  // ---- bridge railings: solid (they're cover, and keep you on the deck), drawn by the client as rails
  for (const br of terrain.bridges) {
    for (let i = 0; i < br.path.length - 1; i++) {
      const [x1, z1] = br.path[i], [x2, z2] = br.path[i + 1], len = Math.hypot(x2 - x1, z2 - z1) || 1;
      const nx = -(z2 - z1) / len, nz = (x2 - x1) / len;
      for (let t = 0; t <= len; t += 0.7) for (const side of [-1, 1]) {
        const x = x1 + (x2 - x1) * t / len + nx * side * 4.9, z = z1 + (z2 - z1) * t / len + nz * side * 4.9;
        if (terrain.exact(x, z, true) > BRIDGE_DECK - 0.6) continue;   // the bank is as high as the deck here
        box(x - 0.45, z - 0.45, x + 0.45, z + 0.45, 1.6, 'rail', { y0: BRIDGE_DECK - 0.5 });
      }
    }
  }

  const inTown = (x, z, pad = 4) => towns.some((t) => x > t.rect.minX - pad && x < t.rect.maxX + pad && z > t.rect.minZ - pad && z < t.rect.maxZ + pad);
  // ---- real structures (FEMA/ORNL USA Structures), one map object per building
  const realBuildings = [];
  if (realStructs) {
    let n = 0;
    for (let si = 0; si < real.structures.length; si++) {
      const pad = realPads[si];
      if (!pad) continue;
      const [, , , , h0, occ, name] = real.structures[si];
      const { minX, minZ, maxX, maxZ, x, z, w, d } = pad;
      const area0 = pad.rects ? pad.rects.reduce((a, [x0, z0, x1, z1]) => a + (x1 - x0) * (z1 - z0), 0) : w * d;
      if (solidAt(minX - 0.5, minZ - 0.5, maxX + 0.5, maxZ + 0.5) || reserved.rect(minX, minZ, maxX, maxZ).some((r) => r.home && maxX > r.minX && minX < r.maxX && maxZ > r.minZ && minZ < r.maxZ)) continue;
      const o = String(occ || '').toLowerCase(), area = area0;
      const slim = Math.min(w, d) < 6.5 && Math.max(w, d) > 2.6 * Math.min(w, d);   // a mobile home
      const nearTown = towns.some((t) => Math.abs(t.x - x) < 900 && Math.abs(t.z - z) < 900);
      const type = o.startsWith('agri') ? (area > 300 ? 'barn' : 'farmhouse') : o.startsWith('indus') ? 'warehouse' : o.startsWith('resid') ? 'home'
        : o.startsWith('comm') ? 'building' : o.startsWith('civic') ? 'civic'
          : area < 300 || (slim && area < 220) ? 'home' : area < 900 ? (nearTown ? 'building' : 'barn') : nearTown ? 'building' : 'warehouse';
      // Height: measured where the data has it. A house is one storey unless it's clearly taller.
      const h = type === 'home' ? (h0 > 7 ? 6.4 : 3.3) : type === 'farmhouse' ? 3.6
        : type === 'barn' ? Math.max(4.6, Math.min(8, h0 > 2 ? h0 * 0.8 : 5.5)) : type === 'warehouse' ? Math.max(5, Math.min(14, h0 > 2 ? h0 : 7))
          : Math.max(3.6, Math.min(30, h0 > 2 ? h0 : type === 'civic' ? 5.5 : area > 1500 ? 6 : 4.2));
      // A walk-in shell of the real footprint and height (doorways, an interior wall in big ones,
      // a ceiling), with a pitched roof on houses, barns and small halls. Every other one has loot.
      const zone = type === 'barn' || type === 'farmhouse' ? 'farm' : nearTown ? 'town' : type === 'warehouse' ? 'industrial' : 'road';
      const pitched = type === 'home' || type === 'farmhouse' || type === 'barn' || (type === 'civic' && area < 1200);
      // Pieces in the building's own frame (one rectangle, or the L / T / wings of the real outline).
      const rects = pad.rects || [[-w / 2, -d / 2, w / 2, d / 2]];
      realShell(x, z, pad.ang, rects, h, type, n++ % 2 === 0 ? zone : null, pad.elev, { roof: pitched ? 'gable' : null, name: name || undefined, sink: 0.6 });
      realBuildings.push(1);
    }
  }

  // ---- wrecks and abandoned vehicles along the highways
  const VT = ['rv', 'bus', 'truck'];
  let vehicleN = 0;
  for (const hw of highways) {
    for (let i = 0; i < hw.pts.length - 1; i++) {
      const [x1, z1] = hw.pts[i], [x2, z2] = hw.pts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      for (let d = 60; d < len - 60; d += 140 + rand() * 260) {
        const f = d / len;
        const x = x1 + (x2 - x1) * f, z = z1 + (z2 - z1) * f;
        const roll = rand(), side = rand() < 0.5 ? 1 : -1;
        if (Math.abs(x) > half - 60 || Math.abs(z) > half - 60) continue;
        if (inTown(x, z, 10) || terrain.exact(x, z) < 0.8 || waterDist(x, z) < 20) continue;
        // Pull off to the side of the road.
        const nx = -(z2 - z1) / len, nz = (x2 - x1) / len;
        if (roll < 0.12 && vehicleN < 80) {
          const vx = x + nx * side * 11, vz = z + nz * side * 11;
          if (freeRect(vx - 7, vz - 7, vx + 7, vz + 7, 4) && !solidAt(vx - 7, vz - 7, vx + 7, vz + 7) && span4(vx, vz, 6, terrain.exact).hi - span4(vx, vz, 6, terrain.exact).lo < 2.5) { addVehicle(VT[vehicleN % 3], vx, vz, Math.abs(x2 - x1) > Math.abs(z2 - z1)); vehicleN++; }
        } else if (roll < 0.5) {
          const ox = x + nx * side * 4, oz = z + nz * side * 4;
          if (solidAt(ox - 3, oz - 3, ox + 3, oz + 3)) continue;
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
      for (let q = 0; q < 2; q++) {
        if (rand() > 0.6) continue;
        const f = 0.15 + rand() * 0.7;
        const nx = -(z2 - z1) / len, nz = (x2 - x1) / len, side = rand() < 0.5 ? 1 : -1;
        const cx = x1 + (x2 - x1) * f + nx * side * (rv.width / 2 - 3), cz = z1 + (z2 - z1) * f + nz * side * (rv.width / 2 - 3);
        if (inTown(cx, cz, 30) || !freeRect(cx - 8, cz - 8, cx + 8, cz + 8, 4)) continue;
        const alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
        if (terrain.exact(cx, cz) > -0.5) continue;
        addVehicle('houseboat', cx, cz, alongX);
        const h = houses[houses.length - 1];
        // The stash access point is on the bank side.
        const bx = cx - nx * side * (VEHICLE_TYPES.houseboat.wid / 2 + 2.5), bz = cz - nz * side * (VEHICLE_TYPES.houseboat.wid / 2 + 2.5);
        h.crate = { x: bx, z: bz };
        h.door = { minX: bx - 0.8, minZ: bz - 0.8, maxX: bx + 0.8, maxZ: bz + 0.8, h: 0.2, y0: -0.2, gangway: true };
      }
    }
  }

  // ---- countryside, by biome: farms, natural homes, camps (trees and rocks are lazy, see below)
  const CELL = 1500;
  const cellsPerSide = Math.max(1, Math.round(size / CELL));
  const cellSize = size / cellsPerSide;
  const dry = (x, z, min = 0.8) => terrain.exact(x, z) > min;
  for (let i = 0; i < cellsPerSide; i++) {
    for (let j = 0; j < cellsPerSide; j++) {
      const cx0 = -half + i * cellSize, cz0 = -half + j * cellSize;
      const pick = (margin) => [cx0 + margin + rand() * (cellSize - 2 * margin), cz0 + margin + rand() * (cellSize - 2 * margin)];
      const cb = terrain.biome(cx0 + cellSize / 2, cz0 + cellSize / 2);
      const farms = realStructs ? 0 : Math.round((cb.plains + cb.mountain * 0.3) * 4);
      for (let k = 0; k < farms; k++) {
        const [fx, fz] = pick(60);
        const g = span4(fx, fz, 20, terrain.exact);
        if (g.lo < 1.5 || g.hi - g.lo > 4 || !freeRect(fx - 20, fz - 16, fx + 20, fz + 16, 20)) continue;
        reserve({ minX: fx - 20, minZ: fz - 16, maxX: fx + 20, maxZ: fz + 16 });
        shell(fx - 18, fz - 12, fx - 8, fz - 4, 6, 'farmhouse', 'farm');
        shell(fx + 2, fz - 14, fx + 16, fz - 2, 8, 'barn', 'farm');
        ground(fx - 18, fz + 10, fx + 2, fz + 10.5, 1.1, 'cover');
        ground(fx + 8, fz + 4, fx + 8.5, fz + 14, 1.1, 'cover');
        lootSpawns.push({ x: fx - 4, z: fz - 8, zone: 'farm' }, { x: fx + 9, z: fz + 1, zone: 'farm' });
      }
      // Loot caches out in the woods and swamps.
      for (let k = 0; k < 2; k++) {
        const [x, z] = pick(40);
        const b0 = terrain.biome(x, z);
        if (dry(x, z, 0.6) && !inTown(x, z, 20)) lootSpawns.push({ x, z, zone: b0.sea > 0.4 ? 'lake' : b0.forest > 0.4 ? 'forest' : biomeName(b0) });
      }
      const tryHome = (kind, ok, attempts = 30) => {
        for (let k = 0; k < attempts; k++) {
          const [x, z] = pick(100);
          if (!ok(x, z) || !freeRect(x - 12, z - 12, x + 12, z + 22, 30) || inTown(x, z, 80) || solidAt(x - 12, z - 12, x + 12, z + 22) || roadDist(x, z, 30) < 25) continue;
          addHome(kind, x, z);
          return true;
        }
        return false;
      };
      const flatDry = (x, z, maxDiff = 3) => { const g = span4(x, z, 7, terrain.exact); return g.lo > 1 && g.hi - g.lo < maxDiff; };
      if (cb.mountain > 0.3 && rand() < 0.7) tryHome('cave', (x, z) => terrain.biome(x, z).mountain > 0.52 && flatDry(x, z, 9));
      if ((cb.mountain > 0.2 || cb.desert > 0.3) && rand() < 0.6) tryHome('rockfort', (x, z) => { const b = terrain.biome(x, z); return (b.mountain > 0.35 || b.desert > 0.45) && flatDry(x, z); });
      if ((cb.forest > 0.35 || cb.sea > 0.2) && rand() < 0.5) tryHome('treehut', (x, z) => { const b = terrain.biome(x, z); return (b.forest > 0.45 || b.sea > 0.35) && flatDry(x, z); });
      if (waterDist(cx0 + cellSize / 2, cz0 + cellSize / 2) < cellSize) tryHome('boathouse', (x, z) => {
        const h = terrain.exact(x, z);
        if (h < 0.8 || h > 8 || !flatDry(x, z, 4)) return false;
        return [[0, 24], [0, -24], [24, 0], [-24, 0]].some(([ox, oz]) => terrain.exact(x + ox, z + oz) < -1);
      }, 120);
      const [sx, sz] = pick(150);
      if (!inTown(sx, sz, 80) && dry(sx, sz, 1.5)) campSites.push({ x: sx, z: sz });
    }
  }
  // ---- the river trade (phase 2): a landing for each river town and each swamp camp.
  // Uses its own random stream so the rest of the map doesn't shift.
  const docks = [], camps = [];
  const river = geo.rivers.find((r) => r.pts.some(([x, z]) => Math.abs(x) < half && Math.abs(z) < half));
  if (river) {
    const rr = mulberry32((seed ^ 0x51ab0a7) >>> 0);
    /** Nearest point on the river's centreline, with the unit normal pointing toward (tx,tz). */
    const onRiver = (tx, tz) => {
      let best = null;
      for (let i = 0; i < river.pts.length - 1; i++) {
        const [ax, az] = river.pts[i], [bx, bz] = river.pts[i + 1];
        const s = segDist(tx, tz, ax, az, bx, bz);
        if (!best || s.d < best.d) {
          const l = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / l, uz = (bz - az) / l;
          const cx = ax + (bx - ax) * s.t, cz = az + (bz - az) * s.t;
          let nx = -uz, nz = ux;
          if ((tx - cx) * nx + (tz - cz) * nz < 0) { nx = -nx; nz = -nz; }
          best = { d: s.d, x: cx, z: cz, nx, nz, ux, uz };
        }
      }
      return best;
    };
    /** Walk out from the channel to the bank on the normal's side. */
    const bankFrom = (c) => {
      let k = 0;
      while (k < 400 && terrain.exact(c.x + c.nx * k, c.z + c.nz * k) < 1.0) k += 2;
      if (k >= 400) return null;
      // Mooring: back toward the channel until it's deep enough to float.
      let w = k;
      while (w > 0 && Math.max(terrain.exact(c.x + c.nx * w, c.z + c.nz * w), terrain.height(c.x + c.nx * w, c.z + c.nz * w)) > RIVER.rules.minDepth - 0.5) w -= 0.5;
      return { bx: c.x + c.nx * k, bz: c.z + c.nz * k, wx: c.x + c.nx * w, wz: c.z + c.nz * w };
    };
    const addDock = (name, c, extra) => {
      const b = bankFrom(c);
      if (!b || Math.abs(b.bx) > half - 60 || Math.abs(b.bz) > half - 60) return null;
      const px = b.bx + c.nx * 5, pz = b.bz + c.nz * 5;   // the landing post, on dry ground
      // The jetty: from the post out over the water.
      const len = Math.hypot(b.wx - px, b.wz - pz);
      for (let k = 0; k < len; k += 3) {
        const jx = px + (b.wx - px) * (k / len), jz = pz + (b.wz - pz) * (k / len);
        box(jx - 1.6, jz - 1.6, jx + 1.6, jz + 1.6, 0.3, 'jetty', { y0: Math.max(0.05, terrain.exact(jx, jz) + 0.05) });
      }
      reserve({ minX: Math.min(px, b.wx) - 6, minZ: Math.min(pz, b.wz) - 6, maxX: Math.max(px, b.wx) + 6, maxZ: Math.max(pz, b.wz) + 6 });
      const d = { id: docks.length, name, x: px, z: pz, wx: b.wx, wz: b.wz, nx: c.nx, nz: c.nz, ...extra };
      docks.push(d);
      return d;
    };
    // A town's landing is at its real public boat ramp where there is one near enough.
    const ramps = (real.infrastructure?.places || []).filter((q) => q[2] === 'landing').map(([lat, lon, , name]) => ({ ...project(lat, lon, size), name }))
      .concat(real.infrastructure ? EXTRA.landings.map((l) => ({ ...project(l.lat, l.lon, size), name: l.real, own: l.name })) : []);
    const usedRamps = new Set();
    for (const t of towns) {
      const ramp = ramps.filter((q) => Math.hypot(q.x - t.x, q.z - t.z) < RIVER.docks.maxFromTown).sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z))[0];
      const c = onRiver(ramp ? ramp.x : t.x, ramp ? ramp.z : t.z);
      if (ramp) usedRamps.add(ramp);
      if (ramp || c.d < RIVER.docks.maxFromTown) addDock(`${t.name} Landing`, c, { townId: t.id, ...(ramp ? { real: ramp.name } : {}) });
    }
    // Swamp camps: out in the floodplain, away from towns and roads.
    const C = RIVER.camps;
    const cands = [];
    for (let i = 0; i < river.pts.length - 1; i++) {
      const [ax, az] = river.pts[i], [bx, bz] = river.pts[i + 1];
      const l = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < l; s += 250) cands.push([ax + (bx - ax) * s / l, az + (bz - az) * s / l]);
    }
    for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    const roadAway = (x, z, r) => roads.every((s) => segDist(x, z, s.x1, s.z1, s.x2, s.z2).d - s.width / 2 > r);
    for (const [x, z] of cands) {
      if (camps.length >= C.count) break;
      if (Math.abs(x) > half - 1500 || Math.abs(z) > half - 1500) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < C.minFromTown)) continue;
      if (docks.some((d) => Math.hypot(d.x - x, d.z - z) < C.minApart * 0.7) || camps.some((c) => Math.hypot(c.x - x, c.z - z) < C.minApart)) continue;
      const side = rr() < 0.5 ? 1 : -1;
      const c0 = onRiver(x, z);
      const c = { ...c0, nx: c0.nx * side, nz: c0.nz * side };
      const b = bankFrom(c);
      if (!b) continue;
      const cx = b.bx + c.nx * 30, cz = b.bz + c.nz * 30;
      if (terrain.biome(cx, cz).sea < 0.5 || !roadAway(cx, cz, C.minFromRoad)) continue;
      // Room for the shacks along the bank.
      const spots = [-24, 0, 24].map((o) => [cx + c.ux * o + c.nx * 12, cz + c.uz * o + c.nz * 12]);
      if (!spots.every(([sx, sz]) => freeRect(sx - 12, sz - 12, sx + 12, sz + 22, 2) && !solidAt(sx - 12, sz - 12, sx + 12, sz + 22) && terrain.exact(sx, sz) > 1 && span4(sx, sz, 7, terrain.exact).hi - span4(sx, sz, 7, terrain.exact).lo < 3)) continue;
      const id = camps.length, name = `${C.names[id % C.names.length]} camp`;
      const dock = addDock(`${C.names[id % C.names.length]} Landing`, c, { campId: id });
      if (!dock) continue;
      const shackIds = spots.slice(0, C.shacks).map(([sx, sz]) => addHome('shack', sx, sz, null, { campId: id }));
      camps.push({ id, name, x: cx, z: cz, dockId: dock.id, shacks: shackIds, radius: C.safeRadius });
      reserve({ minX: cx - 8, minZ: cz - 8, maxX: cx + 8, maxZ: cz + 8 });
    }
    // Real public ramps that aren't a town's landing get one of their own (added last, so the
    // other landings keep their numbers).
    for (const r of ramps) if (r.own && !usedRamps.has(r)) addDock(r.own, onRiver(r.x, r.z), { real: r.name });
  }
  // Landing zones, named after the nearest town.
  const lzGrid = Math.max(2, Math.round(size / 6000));
  for (let i = 0; i < lzGrid; i++) {
    for (let j = 0; j < lzGrid; j++) {
      for (let tries = 0; tries < 60; tries++) {
        const x = -half + (i + 0.2 + rand() * 0.6) * (size / lzGrid), z = -half + (j + 0.2 + rand() * 0.6) * (size / lzGrid);
        const g = span4(x, z, 6, terrain.exact);
        if (inTown(x, z, 40) || g.lo < 1.5 || g.hi - g.lo > 4) continue;
        const near = towns.reduce((a, t) => (!a || Math.hypot(t.x - x, t.z - z) < Math.hypot(a.x - x, a.z - z) ? t : a), null);
        landingZones.push({ id: landingZones.length, name: `LZ ${String.fromCharCode(65 + landingZones.length)} (${near ? near.name : 'wilds'})`, x, z });
        reserve({ minX: x - 12, minZ: z - 12, maxX: x + 12, maxZ: z + 12 });
        break;
      }
    }
  }
  box(-half - 2, -half - 2, half + 2, -half, 300, 'border', { y0: -50 });
  box(-half - 2, half, half + 2, half + 2, 300, 'border', { y0: -50 });
  box(-half - 2, -half, -half, half, 300, 'border', { y0: -50 });
  box(half, -half, half + 2, half, 300, 'border', { y0: -50 });

  // ---- real infrastructure (tools/import_real_world.py): cell and radio towers, water towers, tanks,
  // substations, power lines on their real steel towers and wooden poles, the solar farm and the
  // railways. Built last, and never on top of anything already standing.
  const infra = real.infrastructure || null;
  const powerLines = [], rails = [];
  const railGrid = new SpatialGrid(half + 4, 64);
  if (infra) {
    const P = (ll) => project(ll[0], ll[1], size);
    const onMap = (x, z, m = 30) => Math.abs(x) < half - m && Math.abs(z) < half - m;
    const lowest = (x, z, r) => Math.min(terrain.exact(x - r, z - r), terrain.exact(x + r, z - r), terrain.exact(x - r, z + r), terrain.exact(x + r, z + r), terrain.exact(x, z));
    const open = (x, z, r) => onMap(x, z) && !solidAt(x - r, z - r, x + r, z + r) && lowest(x, z, r) > 0.4;
    const obox = (cx, cz, hw, hd, ang, h, y0, type) => { const b = orientedBox(cx, cz, hw, hd, ang, { id: boxes.length, h, y0, type }); boxes.push(b); grid.insert(b); return b; };
    /** A steel lattice tower: tapering sections, a platform, a red light on top. */
    const lattice = (x, z, base, height, light = true) => {
      const y = lowest(x, z, base / 2) - 0.3, n = 6, sh = height / n;
      for (let k = 0; k < n; k++) { const w = base * (1 - k / (n + 1.5)) / 2; box(x - w, z - w, x + w, z + w, sh + 0.05, 'tower', { y0: y + k * sh }); }
      if (light) box(x - 0.35, z - 0.35, x + 0.35, z + 0.35, 0.7, 'beacon', { y0: y + height });
      return y;
    };
    for (const [lat, lon, kind] of infra.towers || []) {
      const { x, z } = P([lat, lon]);
      if (!open(x, z, 7)) continue;
      const height = kind === 'radio' ? 95 : 55, y = lattice(x, z, kind === 'radio' ? 4.5 : 3.2, height);
      box(x - 2.4, z - 2.4, x + 2.4, z + 2.4, 0.5, 'tower', { y0: y + height - 4 });   // the antenna platform
      // The fenced yard and the equipment shed at its foot.
      for (const [a, b, c, d] of [[-7, -7, 7, -6.9], [-7, 6.9, 7, 7], [-7, -7, -6.9, 7], [6.9, -7, 7, 2]]) box(x + a, z + b, x + c, z + d, 2.4, 'fence', { y0: lowest(x, z, 7) - 0.2 });
      box(x + 3, z + 3, x + 6, z + 6, 2.8, 'equipment', { y0: lowest(x + 4.5, z + 4.5, 1.5) - 0.2 });
    }
    for (const ll of infra.waterTowers || []) {
      const { x, z } = P(ll);
      if (!open(x, z, 6)) continue;
      const y = lowest(x, z, 4) - 0.3;
      for (const [a, b] of [[-3.2, -3.2], [3.2, -3.2], [-3.2, 3.2], [3.2, 3.2]]) box(x + a - 0.3, z + b - 0.3, x + a + 0.3, z + b + 0.3, 31, 'tower', { y0: y });
      box(x - 0.4, z - 0.4, x + 0.4, z + 0.4, 31, 'tower', { y0: y });
      box(x - 5, z - 5, x + 5, z + 5, 8, 'tank', { y0: y + 30 });
    }
    for (const [lat, lon, dm] of infra.tanks || []) {
      const { x, z } = P([lat, lon]), r = dm / 2;
      if (open(x, z, r + 1)) box(x - r, z - r, x + r, z + r, 9, 'tank', { y0: lowest(x, z, r) - 0.3 });
    }
    for (const [lat, lon, w, d, angDeg] of infra.substations || []) {
      const { x, z } = P([lat, lon]), ang = angDeg * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
      const ex = (Math.abs(ca) * w + Math.abs(sa) * d) / 2, ez = (Math.abs(sa) * w + Math.abs(ca) * d) / 2;
      if (!onMap(x, z, 40) || solidAt(x - ex, z - ez, x + ex, z + ez) || lowest(x, z, Math.max(ex, ez)) < 0.4) continue;
      const y = lowest(x, z, Math.max(ex, ez)) - 0.2, W = (lx, lz) => [x + lx * ca - lz * sa, z + lx * sa + lz * ca];
      for (const [lx, lz, hw, hd] of [[0, -d / 2, w / 2, 0.08], [0, d / 2, w / 2, 0.08], [-w / 2, 0, 0.08, d / 2], [w / 2, -d / 4, 0.08, d / 4]]) { const [cx, cz] = W(lx, lz); obox(cx, cz, hw, hd, ang, 2.6, y, 'fence'); }
      let n = 0;
      for (let lx = -w / 2 + 6; lx < w / 2 - 4 && n < 24; lx += 9) for (let lz = -d / 2 + 6; lz < d / 2 - 4 && n < 24; lz += 8, n++) {
        const [cx, cz] = W(lx, lz);
        obox(cx, cz, 1.6, 1.2, ang, 3.2, y, 'equipment');
        obox(cx, cz, 0.15, 0.15, ang, 7, y, 'tower');   // a bus-bar post above it
      }
    }
    // Power lines: a support at every real tower and pole (and in between where the data skips some),
    // with the line's direction for its cross-arm. Wires are drawn by the client between them.
    for (const run of infra.powerLines || []) {
      const pts = run.map((q) => ({ ...P(q), kind: q[2] }));
      const line = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        line.push(a);
        if (!b) break;
        const len = Math.hypot(b.x - a.x, b.z - a.z), gap = a.kind === 'pylon' && b.kind === 'pylon' ? 240 : 70, extra = Math.floor(len / gap);
        for (let k = 1; k <= extra && len > gap * 1.4; k++) line.push({ x: a.x + (b.x - a.x) * k / (extra + 1), z: a.z + (b.z - a.z) * k / (extra + 1), kind: a.kind === 'pylon' || b.kind === 'pylon' ? 'pylon' : 'pole' });
      }
      const sup = [];
      for (let i = 0; i < line.length; i++) {
        const q = line[i], prev = line[Math.max(0, i - 1)], next = line[Math.min(line.length - 1, i + 1)];
        const ang = Math.atan2(next.z - prev.z, next.x - prev.x) + Math.PI / 2;   // the cross-arm runs across the line
        const pylon = q.kind === 'pylon', top = pylon ? 26 : 10.5;
        let y = terrain.exact(q.x, q.z);
        if (onMap(q.x, q.z, 5) && y > 0.4 && !solidAt(q.x - 1.5, q.z - 1.5, q.x + 1.5, q.z + 1.5)) {
          if (pylon) y = lattice(q.x, q.z, 2.4, top, false);
          else { y -= 0.4; box(q.x - 0.17, q.z - 0.17, q.x + 0.17, q.z + 0.17, top + 0.4, 'pole', { y0: y }); }
          obox(q.x, q.z, pylon ? 6 : 1.3, 0.2, ang, 0.35, y + top - 1, pylon ? 'tower' : 'pole');
        }
        sup.push({ x: q.x, z: q.z, y: y + top - 0.8, ang, pylon });
      }
      if (sup.length > 1) powerLines.push(sup);
    }
    // The solar farm: rows of panel tables running east-west, 7 m apart.
    for (const ring of infra.solar || []) {
      const poly = ring.map((q) => { const p = P(q); return [p.x, p.z]; });
      const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
      const inPoly = (x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
      for (let z = Math.min(...zs) + 6; z < Math.max(...zs) - 6; z += 7) for (let x = Math.min(...xs) + 4; x < Math.max(...xs) - 30; x += 32) {
        if (!inPoly(x, z) || !inPoly(x + 28, z) || !onMap(x + 14, z, 20)) continue;
        const g0 = terrain.exact(x, z), g1 = terrain.exact(x + 28, z);
        if (Math.min(g0, g1) < 0.4 || Math.abs(g1 - g0) > 2.5 || solidAt(x, z - 2, x + 28, z + 2)) continue;
        box(x, z - 1.9, x + 28, z + 1.9, 0.3, 'solar', { y0: Math.max(g0, g1) + 1.1 });
        box(x + 13.8, z - 0.15, x + 14.2, z + 0.15, Math.max(g0, g1) + 1.1 - Math.min(g0, g1) + 0.3, 'tower', { y0: Math.min(g0, g1) - 0.3 });   // the post it stands on
      }
    }
    // Railways: drawn by the client; kept clear of trees.
    for (const r of infra.rail || []) {
      const pts = r.pts.map((q) => { const p = P(q); return [p.x, p.z]; });
      rails.push({ name: r.name || null, narrow: !!r.narrow, pts });
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
        railGrid.insert({ minX: Math.min(x1, x2) - 4, minZ: Math.min(z1, z2) - 4, maxX: Math.max(x1, x2) + 4, maxZ: Math.max(z1, z2) + 4, x1, z1, x2, z2 });
      }
    }
  }
  // Airstrips (hand-placed, shared/data/real-extra.json): a mown grass runway with edge markers,
  // an open-fronted hangar with a light plane in it, and a windsock.
  const airstrips = [];
  if (infra) for (const a of EXTRA.airstrips) {
    const S = project(a.south[0], a.south[1], size), N = project(a.north[0], a.north[1], size);
    const len = Math.hypot(N.x - S.x, N.z - S.z), ux = (N.x - S.x) / len, uz = (N.z - S.z) / len, ex = -uz, ez = ux;   // (ex, ez): across the strip
    const ang = Math.atan2(uz, ux), w = a.width;
    airstrips.push({ name: a.name, x1: S.x, z1: S.z, x2: N.x, z2: N.z, width: w });
    for (let d = 0; d <= len; d += 50) for (const side of [-1, 1]) {   // white edge markers
      const x = S.x + ux * d + ex * side * (w / 2 + 1), z = S.z + uz * d + ez * side * (w / 2 + 1);
      box(x - 0.35, z - 0.35, x + 0.35, z + 0.35, 0.7, 'marker', { y0: terrain.exact(x, z) - 0.3 });
    }
    // The hangar: beside the north end, its open side facing the runway.
    const hx = N.x - ux * 70 + ex * (w / 2 + 26), hz = N.z - uz * 70 + ez * (w / 2 + 26), hw = 12, hd = 10, H = 6.5;
    const hy = Math.min(terrain.exact(hx - hw, hz - hw), terrain.exact(hx + hw, hz + hw), terrain.exact(hx - hw, hz + hw), terrain.exact(hx + hw, hz - hw)) - 0.4;
    const L = (lx, lz) => [hx + ux * lx + ex * lz, hz + uz * lx + ez * lz];   // lx along the strip, lz away from it
    const wall = (lx, lz, a2, b2, hh, yy, type) => { const [cx, cz] = L(lx, lz); const b = orientedBox(cx, cz, a2, b2, ang, { id: boxes.length, h: hh, y0: yy, type }); boxes.push(b); grid.insert(b); };
    if (!solidAt(hx - 16, hz - 16, hx + 16, hz + 16)) {
    wall(0, hd, hw, 0.2, H + 0.4, hy, 'hangar');            // back wall
    wall(-hw, 0, 0.2, hd, H + 0.4, hy, 'hangar');            // ends
    wall(hw, 0, 0.2, hd, H + 0.4, hy, 'hangar');
    wall(0, 0, hw + 0.3, hd + 0.3, 0.3, hy + H + 0.4, 'hangar');   // roof
    // A high-wing light plane parked inside, nose out.
    const py = hy + 0.4;
    wall(0, 1, 0.65, 3.8, 1.4, py + 0.5, 'plane');           // fuselage
    wall(0, 0.2, 5.4, 0.8, 0.15, py + 1.95, 'plane');        // wing
    wall(0, 4.4, 1.6, 0.4, 0.12, py + 1.2, 'plane');         // tailplane
    wall(0, 4.5, 0.08, 0.5, 1.3, py + 1.3, 'plane');         // fin
    }
    reserve({ minX: hx - 18, minZ: hz - 18, maxX: hx + 18, maxZ: hz + 18 });
    // The windsock, by the south end.
    const wx = S.x + ux * 30 - ex * (w / 2 + 12), wz = S.z + uz * 30 - ez * (w / 2 + 12), wy = terrain.exact(wx, wz) - 0.3;
    box(wx - 0.08, wz - 0.08, wx + 0.08, wz + 0.08, 6.5, 'pole', { y0: wy });
    box(wx - 0.3, wz - 1.6, wx + 0.3, wz, 0.6, 'windsock', { y0: wy + 5.6 });
  }
  const nearStrip = (x, z) => airstrips.some((a) => segDist(x, z, a.x1, a.z1, a.x2, a.z2).d < a.width / 2 + 10);
  const nearRail = (x, z, r) => railGrid.near(x, z, r).some((s) => segDist(x, z, s.x1, s.z1, s.x2, s.z2).d < r) || nearStrip(x, z);

  const free = (p, r = 1.0) => { const gh = terrain.exact(p.x, p.z); return gh > 0.3 && !grid.near(p.x, p.z, r + 1, [], true).some((b) => circleOverlapsBox(p.x, p.z, r, b) && b.type !== 'caveroof' && b.type !== 'canopy' && !(b.y0 > gh + 2)); };
  for (const p of [...landingZones, ...campSites]) for (let k = 0; k < 10 && !free(p, 3); k++) { p.x += 7; p.z += 3; }
  const spawns = lootSpawns.filter((p) => free(p));
  // Loot spots and camps are kept clear of the lazy trees too.
  for (const p of [...spawns, ...campSites]) reserve({ minX: p.x - 1.5, minZ: p.z - 1.5, maxX: p.x + 1.5, maxZ: p.z + 1.5 });

  // ---- lazy countryside: trees (longleaf pine flatwoods, hardwood hills, cypress swamps), rocks,
  // scrub, and (without real data) roadside homesteads standing in for the real rural houses.
  const NATURE_TILE = 128;
  const H = terrain.height;
  /** Everything that grows or lies in one 128 m tile of countryside. Deterministic, so it's worked
   *  out when first needed rather than stored. `Hf` is the height function to stand things on. */
  function natureTile(tx, tz, Hf = H) {
    const out = [];
    const x0 = -half + tx * NATURE_TILE, z0 = -half + tz * NATURE_TILE;
    if (tx < 0 || tz < 0 || x0 >= half || z0 >= half) return out;
    const r = mulberry32((Math.imul(tx + 7, 73856093) ^ Math.imul(tz + 13, 19349663) ^ Math.imul(seed, 83492791)) >>> 0);
    const b = terrain.biome(x0 + NATURE_TILE / 2, z0 + NATURE_TILE / 2);
    let id = NATURE_ID + (tx * 512 + tz) * 512;
    const blocked = (minX, minZ, maxX, maxZ) =>
      reserved.rect(minX, minZ, maxX, maxZ).some((q) => maxX > q.minX && minX < q.maxX && maxZ > q.minZ && minZ < q.maxZ) ||
      grid.rect(minX, minZ, maxX, maxZ, [], true).some((q) => !q.nature);
    const add = (minX, minZ, maxX, maxZ, h, type) => {
      const y0 = Math.min(Hf(minX, minZ), Hf(maxX, maxZ), Hf(minX, maxZ), Hf(maxX, minZ)) - 0.3;
      out.push({ id: id++, minX, minZ, maxX, maxZ, h: h + 0.3, y0, type, nature: 1 });
    };
    const spot = (m) => [x0 + m + r() * (NATURE_TILE - 2 * m), z0 + m + r() * (NATURE_TILE - 2 * m)];
    const pineTile = b.forest + b.desert > b.mountain + b.sea;
    if (terrain.hasCover) {
      // Real land cover: woods are thick (about one tree every 9 m), pasture and fields are open
      // with the odd shade tree, town has yard trees, marsh has scattered cypress, cut-over and
      // scrub ground has brush and young pines.
      const cand = Math.round(200 * (0.85 + r() * 0.3));
      const KEEP = { [COVER.woods]: 1, [COVER.scrub]: 0.12, [COVER.grass]: 0.012, [COVER.crops]: 0.002, [COVER.town]: 0.05, [COVER.marsh]: 0.12 };
      for (let k = 0; k < cand; k++) {
        const [x, z] = spot(1), c = terrain.cover(x, z), keep = KEEP[c] || 0, roll = r(), kind = r(), tall = r();
        if (roll >= keep) continue;
        if (Hf(x, z) < 0.4 || roadDist(x, z, 14) < 3 || nearRail(x, z, 4) || blocked(x - 0.4, z - 0.4, x + 0.4, z + 0.4)) continue;
        const pine = c === COVER.marsh ? false : c === COVER.scrub ? true : pineTile ? kind < 0.85 : kind < 0.3;
        add(x - 0.3, z - 0.3, x + 0.3, z + 0.3, c === COVER.scrub ? 5 + tall * 6 : (pine ? 15 : 10) + tall * 9, pine ? 'pine' : 'tree');
      }
      const brush = Math.round(14 * r()) + 6;
      for (let k = 0; k < brush; k++) {
        const [x, z] = spot(2), c = terrain.cover(x, z), roll = r(), tall = r();
        if (!(c === COVER.scrub ? roll < 0.9 : c === COVER.woods ? roll < 0.35 : c === COVER.marsh ? roll < 0.5 : false)) continue;
        if (Hf(x, z) < 0.6 || roadDist(x, z, 14) < 3 || blocked(x - 1, z - 1, x + 1, z + 1)) continue;
        add(x - 0.9, z - 0.9, x + 0.9, z + 0.9, 1.1 + tall * 0.7, 'scrub');
      }
      if (r() < 0.3) {   // a fallen log or a stump-pile now and then; Florida has no boulders
        const [x, z] = spot(4), w = 1.2 + r() * 1.5, d = 1 + r() * 1.2;
        if (terrain.cover(x, z) !== COVER.crops && Hf(x, z) > 0.6 && roadDist(x, z, 14) > 3 && !blocked(x - 0.5, z - 0.5, x + w + 0.5, z + d + 0.5)) add(x, z, x + w, z + d, 0.7 + r() * 0.5, 'rock');
      }
      return out;
    }
    // Trees grow in clumps; open ground between them.
    const nTrees = Math.round((b.forest * 60 + b.sea * 40 + b.mountain * 34 + b.plains * 5 + b.desert * 9) * (0.5 + r()));
    const clumps = [spot(10), spot(10), spot(10)];
    for (let k = 0; k < nTrees; k++) {
      let x, z;
      if (r() < 0.7) { const c = clumps[k % 3]; x = c[0] + (r() * 2 - 1) * 34; z = c[1] + (r() * 2 - 1) * 34; } else [x, z] = spot(1);
      if (x < x0 + 0.5 || x > x0 + NATURE_TILE - 0.5 || z < z0 + 0.5 || z > z0 + NATURE_TILE - 0.5) continue;
      if (Hf(x, z) < 0.4 || roadDist(x, z, 14) < 3 || blocked(x - 0.4, z - 0.4, x + 0.4, z + 0.4)) continue;
      const pine = pineTile ? r() < 0.85 : r() < 0.2;
      add(x - 0.3, z - 0.3, x + 0.3, z + 0.3, (pine ? 14 : 9) + r() * 7, pine ? 'pine' : 'tree');
    }
    const nRocks = Math.round(1 + b.mountain * 9 + b.desert * 2 + r() * 2);
    for (let k = 0; k < nRocks; k++) {
      const [x, z] = spot(4);
      const w = 1.2 + r() * (b.mountain * 3 + 1.2), d = 1 + r() * (b.mountain * 2 + 1.2);
      if (Hf(x, z) < 0.6 || roadDist(x, z, 14) < 3 || blocked(x - 0.5, z - 0.5, x + w + 0.5, z + d + 0.5)) continue;
      add(x, z, x + w, z + d, 0.8 + r() * (0.8 + b.mountain * 2), b.mountain > 0.4 ? 'boulder' : 'rock');
    }
    const nScrub = Math.round(b.desert * 16 * r());
    for (let k = 0; k < nScrub; k++) {
      const [x, z] = spot(2);
      if (Hf(x, z) < 0.6 || roadDist(x, z, 14) < 3 || blocked(x - 1, z - 1, x + 1, z + 1)) continue;
      add(x - 0.9, z - 0.9, x + 0.9, z + 0.9, 1.1 + r() * 0.6, 'scrub');
    }
    if (!realStructs && r() < 0.18 + b.plains * 0.2) {
      // A homestead set back from a nearby road.
      const [x, z] = spot(16);
      const rd = roadDist(x, z, 70);
      const w = 9 + r() * 5, d = 8 + r() * 5;
      if (rd > 12 && rd < 70 && Hf(x, z) > 1.2 && !blocked(x - w / 2 - 3, z - d / 2 - 3, x + w / 2 + 3, z + d / 2 + 3)) add(x - w / 2, z - d / 2, x + w / 2, z + d / 2, 4.5 + r() * 2, 'farmhouse');
    }
    return out;
  }
  grid.setLoader(NATURE_TILE, (tx, tz) => { for (const b of natureTile(tx, tz)) grid.insert(b); });

  // Labels for the map screen (only what's on this map).
  const onMap = (l) => Math.abs(l.x) < half - 200 && Math.abs(l.z) < half - 200;
  const riverLabel = (rv) => {
    const inside = rv.pts.filter(([x, z]) => Math.abs(x) < half - 500 && Math.abs(z) < half - 500);
    const p = inside[Math.floor(inside.length / 2)];
    return p ? { text: rv.name, x: p[0] + 400, z: p[1], kind: 'water' } : null;
  };
  const labels = [
    ...towns.map((t) => ({ text: t.name, x: t.x, z: t.rect.minZ - 6, kind: 'town' })),
    ...geo.rivers.map(riverLabel).filter(Boolean),
    ...geo.lakes.map((l) => ({ text: l.name, x: (l.caps[0][0][0] + l.caps[0][1][0]) / 2, z: (l.caps[0][0][1] + l.caps[0][1][1]) / 2, kind: 'water' })).filter(onMap),
    ...landmarks.map((l) => ({ text: l.name, x: l.x, z: l.z, kind: 'landmark' })),
    ...(infra?.places || []).filter(([lat, lon, kind]) => kind !== 'landing').map(([lat, lon, kind, text]) => ({ ...project(lat, lon, size), text, kind: 'place', place: kind })).filter(onMap),
    ...airstrips.map((a) => ({ text: a.name, x: (a.x1 + a.x2) / 2, z: (a.z1 + a.z2) / 2, kind: 'place', place: 'airstrip' })),
  ];
  return {
    seed, size, half, boxes, buildings, grid, terrain, houses, towns, roads, roadGrid, highways, bridges: terrain.bridges, landmarks, labels, contacts, terminals,
    lootSpawns: spawns, landingZones, campSites, origin: geo.origin, centre: geo.centre,
    docks, camps, river: river ? river.pts : null, powerLines, rails, airstrips,
    /** The trees in one 128 m countryside tile, for drawing far-off woods without loading them into the world. */
    natureTile: (tx, tz) => natureTile(tx, tz, terrain.exact).filter((b) => b.type === 'tree' || b.type === 'pine'), natureTileSize: NATURE_TILE,
    real: { structures: realBuildings.length, roads: (real.roads || []).length },
    roadsNear: (x, z, r) => roadGrid.near(x, z, r),
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

// ---------------------------------------------------------------- turned boxes
// Most boxes run north-south and east-west (minX..maxX, minZ..maxZ). A real building that stands at
// an angle is made of turned boxes: they also carry a centre (cx, cz), half sizes along their own
// walls (hw, hd) and the angle (ang, with its cosine and sine). minX..maxZ is then the area around
// it, which keeps the spatial grid and quick checks working; the exact tests below use the walls.
/** A box turned by `ang` radians: its own x axis points along (cos ang, sin ang). */
export function orientedBox(cx, cz, hw, hd, ang, extra = {}) {
  if (Math.abs(ang) < 0.008) return { ...extra, minX: cx - hw, minZ: cz - hd, maxX: cx + hw, maxZ: cz + hd };
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const ex = Math.abs(ca) * hw + Math.abs(sa) * hd, ez = Math.abs(sa) * hw + Math.abs(ca) * hd;
  return { ...extra, minX: cx - ex, minZ: cz - ez, maxX: cx + ex, maxZ: cz + ez, cx, cz, hw, hd, ang, ca, sa };
}
/** A world point in a turned box's own frame. */
function toBox(b, x, z) { const dx = x - b.cx, dz = z - b.cz; return [dx * b.ca + dz * b.sa, -dx * b.sa + dz * b.ca]; }
/** Is (x, z) inside a building's walls (`margin` metres in from them)? Works for turned and L-shaped ones. */
export function insideBuilding(b, x, z, margin = 0.3) {
  if (!b.rects) return x > b.minX + margin && x < b.maxX - margin && z > b.minZ + margin && z < b.maxZ - margin;
  const dx = x - b.cx, dz = z - b.cz, ca = Math.cos(b.ang), sa = Math.sin(b.ang);
  const lx = dx * ca + dz * sa, lz = -dx * sa + dz * ca;
  return b.rects.some(([x0, z0, x1, z1]) => lx > x0 + margin && lx < x1 - margin && lz > z0 + margin && lz < z1 - margin);
}
/** Where a ray meets a box (turned or not): distance, or Infinity. */
export function rayHitBox(b, ox, oy, oz, dx, dy, dz) {
  const y0 = b.y0 || 0;
  if (b.ang === undefined) return rayBox(ox, oy, oz, dx, dy, dz, b.minX, y0, b.minZ, b.maxX, y0 + b.h, b.maxZ);
  const [lx, lz] = toBox(b, ox, oz);
  return rayBox(lx, oy, lz, dx * b.ca + dz * b.sa, dy, -dx * b.sa + dz * b.ca, -b.hw, y0, -b.hd, b.hw, y0 + b.h, b.hd);
}

export function circleOverlapsBox(x, z, r, b) {
  if (b.ang !== undefined) {
    const [lx, lz] = toBox(b, x, z);
    const qx = lx - Math.max(-b.hw, Math.min(lx, b.hw)), qz = lz - Math.max(-b.hd, Math.min(lz, b.hd));
    return qx * qx + qz * qz < r * r;
  }
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
      if (b.ang !== undefined) {
        // A turned box: push out in its own frame, then turn the answer back.
        const [lx, lz] = toBox(b, x, z);
        const px = Math.max(-b.hw, Math.min(lx, b.hw)), pz = Math.max(-b.hd, Math.min(lz, b.hd));
        const qx = lx - px, qz = lz - pz, q2 = qx * qx + qz * qz;
        if (q2 >= r * r) continue;
        let nx, nz;
        if (q2 > 1e-9) { const q = Math.sqrt(q2); nx = px + (qx / q) * r; nz = pz + (qz / q) * r; }
        else {
          const pen = [lx + b.hw + r, b.hw - lx + r, lz + b.hd + r, b.hd - lz + r];
          const m = pen.indexOf(Math.min(...pen));
          nx = m === 0 ? -b.hw - r : m === 1 ? b.hw + r : lx;
          nz = m === 2 ? -b.hd - r : m === 3 ? b.hd + r : lz;
        }
        x = b.cx + nx * b.ca - nz * b.sa; z = b.cz + nx * b.sa + nz * b.ca;
        moved = true;
        continue;
      }
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
    const t = rayHitBox(b, ox, oy, oz, dx, dy, dz);
    if (t < best) { best = t; hit = b; }
  }
  return { t: best, box: hit };
}

/** Character hit volume as a box. */
export function characterBounds(x, z, crouch, y = 0, prone = false) {
  const r = prone ? 0.7 : 0.4;   // lying down: lower and longer
  return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, minY: y, maxY: y + (prone ? PRONE_HEIGHT : crouch ? CROUCH_HEIGHT : STAND_HEIGHT) };
}
