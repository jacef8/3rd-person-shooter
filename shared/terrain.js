// Deterministic terrain + biomes, shared by server and client, at real 1:1 scale.
//
// The layout follows the real area around Bristol, Florida (see geography.js): the Apalachicola,
// Chipola and Ochlockonee rivers with their floodplain swamps, Lake Seminole, Lake Talquin, the
// Dead Lakes, the Torreya bluffs and Red Hills, sandhill scrub and the Apalachicola National Forest
// flatwoods. Seeded value noise (only + - * / Math.floor and Math.imul, so every JS engine is
// bit-identical) adds the local detail. Towns get their ground flattened.
//
// Lookups go through a lazily-filled 8 m sample grid with bilinear interpolation, which keeps
// height() cheap enough to call for every footstep, shot and vertex.

export const WATER_LEVEL = 0;
export const DEEP_WATER = -0.9;     // deeper than this is impassable (you'd need a boat)
export const MAX_STEP_SLOPE = 1.1;  // rise/run a character can climb (~48°)
export const PAD_LEVEL = 8.5;       // how far past a building's walls its level pad runs before grading out
export const PAD_MARGIN = 15;       // …and where the grading ends
export const BRIDGE_DECK = 2.5;     // height of a bridge's road deck over the water
export const BRIDGE_HALF_WIDTH = 16; // how far either side of a bridge's centreline the walking height is the deck's.
//   Much wider than the deck itself (its railings keep you on it): the ground is sampled every 8 m,
//   and this keeps every sample around the deck at deck height, so you don't sink as you cross.
const DECK_HALF_WIDTH = 4.8;        // the solid deck, for bullets
const SAMPLE = 8;
const TILE = 32;

function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, seed, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, z * f, seed + i * 101); norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}
import { geography, polyDist, lakeDepth, segDist, crossings } from './geography.js';
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };

/**
 * Real ground elevation (tools/import_real_world.py): a gzipped grid of int16 decimetres above the
 * river's water surface. Returns { n, step, ox, oz, data } or null if the bytes aren't one.
 */
export function parseElevation(bytes) {
  if (!bytes || bytes.byteLength < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'DZEL') return null;
  const n = dv.getUint16(6, true), step = dv.getFloat32(8, true), ox = dv.getFloat32(12, true), oz = dv.getFloat32(16, true);
  const data = new Int16Array(n * n);
  for (let k = 0; k < n * n; k++) data[k] = dv.getInt16(20 + k * 2, true);
  return { n, step, ox, oz, data };
}

/** `elevation` (optional, from parseElevation) replaces the generated hills with the real ground. */
export function createTerrain(seed, size, elevation = null) {
  const half = size / 2;
  const s0 = (seed * 7919) | 0;
  const geo = geography(size);
  let flats = [];
  const FCELL = 64, flatCells = new Map();   // flats bucketed by the 64 m cells they reach
  // Nearest river segment, exactly, without measuring the whole river every time. For a 250 m
  // cell, the only segments that can be nearest to a point inside it are those within (the nearest
  // to its centre + one cell diagonal) of its centre. Lists are built the first time a cell is
  // asked about; cells further than anything in the game cares about (RIVER_FAR) hold nothing.
  const RCELL = 250, RDIAG = RCELL * Math.SQRT2, RIVER_FAR = 4200;
  const riverCells = geo.rivers.map(() => new Map());
  function riverSegs(ri, x, z) {
    const cx = Math.floor(x / RCELL), cz = Math.floor(z / RCELL), key = cx * 100003 + cz;
    let segs = riverCells[ri].get(key);
    if (!segs) {
      const p = geo.rivers[ri].pts, mx = (cx + 0.5) * RCELL, mz = (cz + 0.5) * RCELL;
      const ds = new Float64Array(p.length - 1);
      let dmin = Infinity;
      for (let i = 0; i < ds.length; i++) { ds[i] = segDist(mx, mz, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]).d; if (ds[i] < dmin) dmin = ds[i]; }
      segs = [];
      if (dmin - RDIAG / 2 <= RIVER_FAR) for (let i = 0; i < ds.length; i++) if (ds[i] <= dmin + RDIAG) segs.push(i);
      riverCells[ri].set(key, segs);
    }
    return segs;
  }
  /** Distance to a river's centreline (Infinity beyond RIVER_FAR) and the segment it's on. */
  function riverNear(ri, x, z) {
    const p = geo.rivers[ri].pts;
    let d = Infinity, seg = -1;
    for (const i of riverSegs(ri, x, z)) { const q = segDist(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]).d; if (q < d) { d = q; seg = i; } }
    return { d, seg };
  }

  // Bridges: where a highway crosses a river, the road is carried over on a deck instead of the
  // channel being cut through it. `path` follows the road from bank to bank, however it angles across.
  const bridges = [];
  for (const r of geo.roads) for (const rv of geo.rivers) for (const c of crossings(r.pts, rv.pts)) {
    if (Math.abs(c.x) >= half || Math.abs(c.z) >= half) continue;
    const clear = rv.width / 2 + 45;   // past the channel and the slope of its banks
    let at = 0, best = Infinity;
    for (let i = 0; i < r.pts.length - 1; i++) { const d = segDist(c.x, c.z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]).d; if (d < best) { best = d; at = i; } }
    const walk = (dir) => {
      const out = [];
      let from = [c.x, c.z], walked = 0;
      for (let k = dir > 0 ? at + 1 : at; k >= 0 && k < r.pts.length && walked < 2500; k += dir) {
        const to = r.pts[k], len = Math.hypot(to[0] - from[0], to[1] - from[1]);
        for (let t = 5; t < len; t += 5) {
          const x = from[0] + (to[0] - from[0]) * t / len, z = from[1] + (to[1] - from[1]) * t / len;
          if (polyDist(x, z, rv.pts) > clear) { out.push([x, z]); return out; }
        }
        out.push(to); walked += len; from = to;
      }
      return out;
    };
    const path = [...walk(-1).reverse(), [c.x, c.z], ...walk(1)];
    bridges.push({ ...c, road: r.name, river: rv.name, path, len: Math.max(...path.map(([x, z]) => Math.hypot(x - c.x, z - c.z))) + 10 });
  }
  /** The bridge whose deck is over (x, z), within `pad` metres of its centreline. */
  function bridgeAt(x, z, pad = BRIDGE_HALF_WIDTH) {
    for (const br of bridges) {
      if (Math.abs(x - br.x) > br.len + pad || Math.abs(z - br.z) > br.len + pad) continue;
      if (polyDist(x, z, br.path) < pad) return br;
    }
    return null;
  }

  const regionW = (list, x, z) => {
    let w = 0;
    for (const [cx, cz, r, k] of list) {
      const dx = x - cx, dz = z - cz;
      if (Math.abs(dx) > r || Math.abs(dz) > r) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < r) w = Math.max(w, k * smooth((r - d) / (r * 0.45)));
    }
    return w;
  };
  /** Which side of the Apalachicola a point is on (+1 east bank, -1 west bank) and how far. */
  function eastOfApalachicola(x, z) {
    const { d, seg } = riverNear(0, x, z);
    if (seg < 0) return { d: Infinity, side: 0 };
    const p = geo.rivers[0].pts;
    const cross = (p[seg + 1][0] - p[seg][0]) * (z - p[seg][1]) - (p[seg + 1][1] - p[seg][1]) * (x - p[seg][0]);
    return { d, side: cross < 0 ? 1 : -1 };
  }
  function waterInfo(x, z) {
    let swamp = 0, river = Infinity, riverW = 0, lake = -Infinity;
    for (let ri = 0; ri < geo.rivers.length; ri++) {
      const rv = geo.rivers[ri];
      const d = riverNear(ri, x, z).d;
      if (d < river) { river = d; riverW = rv.width; }
      if (d < rv.swamp) swamp = Math.max(swamp, smooth((rv.swamp - d) / (rv.swamp * 0.6)));
    }
    for (const lk of geo.lakes) lake = Math.max(lake, lakeDepth(x, z, lk));
    if (lake > -400) swamp = Math.max(swamp, smooth((lake + 400) / 300) * 0.7);
    return { swamp, river, riverW, lake };
  }
  /** In the open channel of a river (boats float here, bridge or not). */
  function channel(x, z) {
    for (let ri = 0; ri < geo.rivers.length; ri++) if (riverNear(ri, x, z).d < geo.rivers[ri].width / 2 - 4) return true;
    return false;
  }

  /** Biome weights at a point (sum to 1). Keys: plains (farmland), forest (pine flatwoods),
   *  desert (sandhill scrub), mountain (Red Hills / Torreya bluffs), sea (river swamp). */
  function biomeW(x, z, w = waterInfo(x, z)) {
    // A little warp so region edges meander.
    const wx = x + (fbm(x / 3000, z / 3000, s0 + 7, 2) - 0.5) * 2400, wz = z + (fbm(x / 3000, z / 3000, s0 + 13, 2) - 0.5) * 2400;
    let hills = regionW(geo.regions.hills, wx, wz);
    // The bluffs are on the east bank only; the west bank opposite is low floodplain.
    let east = 1;
    if (hills > 0.05 && w.swamp > 0) { const e = eastOfApalachicola(x, z); if (e.d < 4000 && e.side < 0) { east = 0; hills *= smooth((e.d - 1800) / 1800); } }
    // Where the hills meet the river (the Torreya bluffs) there's no floodplain swamp.
    const sea = w.swamp * (1 - 0.9 * hills * east);
    const mountain = hills * (1 - sea);
    const desert = regionW(geo.regions.sandhills, wx, wz) * (1 - sea) * (1 - mountain);
    const forest = regionW(geo.regions.forest, wx, wz) * (1 - sea) * (1 - mountain * 0.6) * (1 - desert);
    const plains = Math.max(0, 1 - sea - mountain - desert - forest);
    const t = sea + mountain + desert + forest + plains || 1;
    return { sea: sea / t, mountain: mountain / t, desert: desert / t, forest: forest / t, plains: plains / t };
  }
  const biome = (x, z) => biomeW(x, z);

  /** Real ground, bilinear between the 30 m elevation samples. */
  const dem = elevation;
  function demAt(x, z) {
    const fx = Math.max(0, Math.min(dem.n - 1.001, (x - dem.ox) / dem.step)), fz = Math.max(0, Math.min(dem.n - 1.001, (z - dem.oz) / dem.step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, n = dem.n, d = dem.data;
    const a = d[j * n + i], b = d[j * n + i + 1], c = d[(j + 1) * n + i], e = d[(j + 1) * n + i + 1];
    return (a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v) / 10;
  }

  /** Unflattened, unsampled height (used during world generation). */
  function raw(x, z, noBridge = false) {
    const w = waterInfo(x, z);
    if (dem) return carveWater(x, z, w, demAt(x, z) + 0.6 * (fbm(x / 40, z / 40, s0 + 21, 2) - 0.5), noBridge);
    const b = biomeW(x, z, w);
    const plainsH = 9 + 10 * fbm(x / 500, z / 500, s0 + 1);
    const forestH = 6 + 6 * fbm(x / 400, z / 400, s0 + 2);
    const dunes = Math.abs(fbm(x / 90, z / 260, s0 + 3, 2) - 0.5) * 2;
    const desertH = 10 + 9 * fbm(x / 350, z / 350, s0 + 4) + 6 * dunes;
    const hillsH = 16 + 42 * fbm(x / 420, z / 420, s0 + 5, 5);
    const pond = fbm(x / 90, z / 90, s0 + 9, 2);
    const swampH = 1.6 + 2 * fbm(x / 160, z / 160, s0 + 8, 2) - (pond > 0.66 ? 3.5 : 0);
    let h = b.plains * plainsH + b.forest * forestH + b.desert * desertH + b.mountain * hillsH + b.sea * swampH;
    // Torreya bluffs: the east bank of the Apalachicola rises steeply where the hills meet it.
    if (b.mountain > 0.2) {
      const e = eastOfApalachicola(x, z);
      // Real Torreya bluffs stand ~45 m over the river within a few hundred metres of the bank.
      if (e.side > 0 && e.d < 1500) h += 32 * b.mountain * smooth((e.d - 90) / 320);
    }
    return carveWater(x, z, w, h, noBridge);
  }
  /** River channels (unless a bridge deck is here) and lakes cut into the ground. */
  function carveWater(x, z, w, h, noBridge) {
    if (!noBridge && w.river < w.riverW / 2 + 60 && bridgeAt(x, z)) return Math.max(h, BRIDGE_DECK);
    const hw = w.riverW / 2;
    if (w.river < hw) h = -4 - fbm(x / 60, z / 60, s0 + 11, 1);
    else if (w.river < hw + 40) h = -4 + (Math.min(h, 3) + 4) * smooth((w.river - hw) / 40);
    if (w.lake > 0) h = Math.min(h, -3 - Math.min(w.lake, 200) * 0.03);
    else if (w.lake > -40) h = Math.min(h, -3 + (Math.min(h, 3) + 3) * smooth((w.lake + 40) / 40));
    return h;
  }
  function flattened(x, z, noBridge = false) {
    let h = raw(x, z, noBridge);
    const near = flatCells.get(Math.floor(x / FCELL) * 100003 + Math.floor(z / FCELL));
    if (!near) return h;
    let pad = null, padD = Infinity;
    for (const f of near) {
      const dx = Math.max(f.minX - x, 0, x - f.maxX), dz = Math.max(f.minZ - z, 0, z - f.maxZ);
      const d = Math.max(dx, dz);
      if (d >= f.margin) continue;
      if (f.pad) { if (d < padD) { padD = d; pad = f; } continue; }   // building pads: the nearest one wins
      h += (f.elev - h) * (1 - smooth(d / f.margin));
    }
    // A building's pad is dead level under it and a little way out (PAD_LEVEL: far enough that the
    // sampled ground inside is exactly flat), then grades back into the lie of the land.
    if (pad) h += (pad.elev - h) * (1 - smooth((padD - PAD_LEVEL) / (pad.margin - PAD_LEVEL)));
    return h;
  }

  // Lazily sampled 8 m grid.
  const n = Math.ceil(size / SAMPLE) + 2;
  const tiles = new Map();
  function sampleAt(i, j) {
    const ti = Math.floor(i / TILE), tj = Math.floor(j / TILE);
    const key = ti * 4096 + tj;
    let tile = tiles.get(key);
    if (!tile) {
      tile = new Float32Array(TILE * TILE);
      for (let a = 0; a < TILE; a++) for (let b = 0; b < TILE; b++) {
        tile[a * TILE + b] = flattened((ti * TILE + a) * SAMPLE - half, (tj * TILE + b) * SAMPLE - half);
      }
      tiles.set(key, tile);
    }
    return tile[(i - ti * TILE) * TILE + (j - tj * TILE)];
  }
  function height(x, z) {
    const fx = (Math.max(-half, Math.min(half, x)) + half) / SAMPLE, fz = (Math.max(-half, Math.min(half, z)) + half) / SAMPLE;
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz));
    const u = fx - i, v = fz - j;
    const a = sampleAt(i, j), b = sampleAt(i + 1, j), c = sampleAt(i, j + 1), d = sampleAt(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** What stops a bullet: the ground, and at a bridge the deck itself rather than everything under it. */
  function solid(x, z) {
    const br = bridgeAt(x, z, BRIDGE_HALF_WIDTH + 17);
    if (!br) return height(x, z);
    const g = flattened(x, z, true);
    return polyDist(x, z, br.path) < DECK_HALF_WIDTH ? Math.max(g, BRIDGE_DECK) : g;
  }

  return {
    seed, size, half, geo, bridges,
    biome, raw, height, exact: flattened, channel, bridgeAt,
    /** The ground as it's drawn: under a bridge deck that's the river and its banks, not the deck you walk on. */
    drawn(x, z) { return bridgeAt(x, z, BRIDGE_HALF_WIDTH + 17) ? flattened(x, z, true) : height(x, z); },
    /** Flatten ground: towns [{minX,minZ,maxX,maxZ,elev,margin}] and building pads (the same with
     *  pad: 1). Call before any height() use. */
    setFlats(list) {
      flats = list;
      flatCells.clear();
      for (const f of list) {
        for (let cx = Math.floor((f.minX - f.margin) / FCELL); cx <= Math.floor((f.maxX + f.margin) / FCELL); cx++) {
          for (let cz = Math.floor((f.minZ - f.margin) / FCELL); cz <= Math.floor((f.maxZ + f.margin) / FCELL); cz++) {
            const k = cx * 100003 + cz;
            if (!flatCells.has(k)) flatCells.set(k, []);
            flatCells.get(k).push(f);
          }
        }
      }
      tiles.clear();
    },
    isDeep(x, z) { return height(x, z) < DEEP_WATER; },
    isWater(x, z) { return height(x, z) < WATER_LEVEL; },
    /**
     * March a ray against the ground. Returns distance to the first point below the terrain,
     * or Infinity.
     */
    ray(ox, oy, oz, dx, dy, dz, maxDist) {
      const step = 2.5;
      let prevT = 0;
      for (let t = step; t <= maxDist + step; t += step) {
        const tt = Math.min(t, maxDist);
        const y = oy + dy * tt;
        if (y < solid(ox + dx * tt, oz + dz * tt)) {
          // Refine between prevT and tt.
          let lo = prevT, hi = tt;
          for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (oy + dy * m < solid(ox + dx * m, oz + dz * m)) hi = m; else lo = m; }
          return hi;
        }
        prevT = tt;
        if (tt >= maxDist) break;
      }
      return Infinity;
    },
  };
}

export function biomeName(b) {
  let best = 'plains', bv = -1;
  for (const k of ['plains', 'forest', 'desert', 'mountain', 'sea']) if (b[k] > bv) { bv = b[k]; best = k; }
  return best;
}
