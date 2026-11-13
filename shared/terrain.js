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

export function createTerrain(seed, size) {
  const half = size / 2;
  const s0 = (seed * 7919) | 0;
  const geo = geography(size);
  let flats = [];
  // Bridges/causeways: where highways cross rivers the ground isn't carved away.
  const bridges = [];
  for (const r of geo.roads) for (const rv of geo.rivers) for (const c of crossings(r.pts, rv.pts)) if (Math.abs(c.x) < half && Math.abs(c.z) < half) bridges.push({ ...c, road: r.name, river: rv.name, len: rv.width / 2 + 60 });
  const apalachicola = geo.rivers[0];

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
    let best = Infinity, side = 0;
    const p = apalachicola.pts;
    for (let i = 0; i < p.length - 1; i++) {
      const { d } = segDist(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
      if (d < best) { best = d; const cross = (p[i + 1][0] - p[i][0]) * (z - p[i][1]) - (p[i + 1][1] - p[i][1]) * (x - p[i][0]); side = cross < 0 ? 1 : -1; }
    }
    return { d: best, side };
  }
  function waterInfo(x, z) {
    let swamp = 0, river = Infinity, riverW = 0, lake = -Infinity;
    for (const rv of geo.rivers) {
      const d = polyDist(x, z, rv.pts);
      if (d < river) { river = d; riverW = rv.width; }
      if (d < rv.swamp) swamp = Math.max(swamp, smooth((rv.swamp - d) / (rv.swamp * 0.6)));
    }
    for (const lk of geo.lakes) lake = Math.max(lake, lakeDepth(x, z, lk));
    if (lake > -400) swamp = Math.max(swamp, smooth((lake + 400) / 300) * 0.7);
    return { swamp, river, riverW, lake };
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

  /** Unflattened, unsampled height (used during world generation). */
  function raw(x, z) {
    const w = waterInfo(x, z);
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
    // River channels (unless a highway crosses here), lakes.
    let bridged = false;
    for (const br of bridges) {
      if (Math.abs(x - br.x) > br.len + 10 || Math.abs(z - br.z) > br.len + 10) continue;
      if (Math.hypot(x - br.x, z - br.z) < br.len && roadNear(x, z, br.road) < 7) { bridged = true; break; }
    }
    if (!bridged) {
      const hw = w.riverW / 2;
      if (w.river < hw) h = -4 - fbm(x / 60, z / 60, s0 + 11, 1);
      else if (w.river < hw + 40) h = -4 + (Math.min(h, 3) + 4) * smooth((w.river - hw) / 40);
    } else h = Math.max(h, 2.5);
    if (w.lake > 0) h = Math.min(h, -3 - Math.min(w.lake, 200) * 0.03);
    else if (w.lake > -40) h = Math.min(h, -3 + (Math.min(h, 3) + 3) * smooth((w.lake + 40) / 40));
    return h;
  }
  function roadNear(x, z, name) {
    const r = geo.roads.find((o) => o.name === name);
    return r ? polyDist(x, z, r.pts) : Infinity;
  }

  function flattened(x, z) {
    let h = raw(x, z);
    for (const f of flats) {
      const dx = Math.max(f.minX - x, 0, x - f.maxX), dz = Math.max(f.minZ - z, 0, z - f.maxZ);
      const d = Math.max(dx, dz);
      if (d >= f.margin) continue;
      const t = 1 - smooth(d / f.margin);
      h = h + (f.elev - h) * t;
    }
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

  return {
    seed, size, half, geo, bridges,
    biome, raw, height, exact: flattened,
    /** Flatten ground under towns: [{minX,minZ,maxX,maxZ,elev,margin}]. Call before any height() use. */
    setFlats(list) { flats = list; tiles.clear(); },
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
        if (y < height(ox + dx * tt, oz + dz * tt)) {
          // Refine between prevT and tt.
          let lo = prevT, hi = tt;
          for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (oy + dy * m < height(ox + dx * m, oz + dz * m)) hi = m; else lo = m; }
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
