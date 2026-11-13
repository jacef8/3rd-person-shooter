// Deterministic terrain + biomes, shared by server and client.
//
// Heights come from seeded value noise (only + - * / Math.floor and Math.imul, so every JS engine
// produces bit-identical results). Biomes blend organically: forest to the north, mountains to
// the west, desert to the south-east, a sea along the east coast and lakes scattered through
// the lowlands, with plains/cities in between. Towns get their ground flattened.
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
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { const t = clamp01(v); return t * t * (3 - 2 * t); };

export function createTerrain(seed, size) {
  const half = size / 2;
  const s0 = (seed * 7919) | 0;
  let flats = [];

  /** Biome weights at a point (sum to 1). */
  function biome(x, z) {
    // Domain warp so borders meander instead of following straight lines.
    const wx = x + (fbm(x / 900, z / 900, s0 + 7, 2) - 0.5) * 1500;
    const wz = z + (fbm(x / 900, z / 900, s0 + 13, 2) - 0.5) * 1500;
    const u = (wx + half) / size, v = (wz + half) / size;
    const sea = smooth((u - 0.86) / 0.07);
    const mountain = smooth((0.3 - u) / 0.14) * (1 - sea);
    const desert = smooth((v - 0.56) / 0.12) * smooth((u - 0.5) / 0.12) * (1 - sea) * (1 - mountain);
    const forest = smooth((0.42 - v) / 0.14) * (1 - mountain) * (1 - sea) * (1 - desert);
    const plains = Math.max(0, 1 - sea - mountain - desert - forest);
    const t = sea + mountain + desert + forest + plains || 1;
    return { sea: sea / t, mountain: mountain / t, desert: desert / t, forest: forest / t, plains: plains / t };
  }

  /** Unflattened, unsampled height (used during world generation). */
  function raw(x, z) {
    const b = biome(x, z);
    const plainsH = 3 + 7 * fbm(x / 420, z / 420, s0 + 1);
    const forestH = 4 + 18 * fbm(x / 360, z / 360, s0 + 2);
    const dunes = Math.abs(fbm(x / 70, z / 240, s0 + 3, 2) - 0.5) * 2;
    const desertH = 2 + 5 * fbm(x / 600, z / 600, s0 + 4) + 4 * dunes;
    const r = 1 - Math.abs(2 * fbm(x / 650, z / 650, s0 + 5, 5) - 1);
    const mountainH = 12 + 120 * r * r + 25 * fbm(x / 200, z / 200, s0 + 6, 3);
    const seaH = -22 + 6 * fbm(x / 300, z / 300, s0 + 8, 2);
    let h = b.plains * plainsH + b.forest * forestH + b.desert * desertH + b.mountain * mountainH + b.sea * seaH;
    // Lakes in the lowlands.
    const lake = fbm(x / 700, z / 700, s0 + 33, 3);
    if (lake > 0.66) h -= ((lake - 0.66) / 0.34) * 45 * (b.plains + b.forest);
    // Keep the map border as dry land/sea, never mid-air.
    return h;
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
    seed, size, half,
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
