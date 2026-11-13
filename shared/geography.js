// Real-world layout of the area around Bristol, Florida (Liberty County) at real 1:1 scale:
// one game metre is one real metre. +X is east, +Z is south (the map is drawn north-up).
//
// The data lives in shared/data/map-bristol.json, in real latitude/longitude, so any engine can
// place it. The map is a square (18.6 miles / 30 km across) centred 3.1 miles east and 0.9 miles
// north of Bristol, taking in Blountstown, Lake Mystic, Hosford, Telogia, Estiffanulga and Torreya
// State Park. Smaller test maps crop the same layout around Bristol. Towns and landmarks are
// Wikipedia/GNIS positions; rivers, lakes, highways and terrain regions were traced by hand.
import MAP from './data/map-bristol.json' with { type: 'json' };

export const ORIGIN = MAP.origin;
export const REAL_SIZE = MAP.sizeM;                       // metres across the full map
const CENTRE = { x: MAP.centreOffsetM.east, z: -MAP.centreOffsetM.north };   // map centre, metres from the origin
const M_PER_MILE = 1609.344;
const M_PER_DEG_LAT = 69.05 * M_PER_MILE;
const M_PER_DEG_LON = 69.17 * Math.cos((ORIGIN.lat * Math.PI) / 180) * M_PER_MILE;   // computed once at load

/** Map centre (metres from the origin) for a map of this size: smaller maps stay around Bristol. */
export function mapCentre(size = REAL_SIZE) {
  const f = Math.min(1, size / REAL_SIZE);
  return { x: CENTRE.x * f, z: CENTRE.z * f };
}
/** Real lat/lon -> map metres (1:1) for a map of the given size. */
export function project(lat, lon, size = REAL_SIZE) {
  const c = mapCentre(size);
  return { x: Math.round((lon - ORIGIN.lon) * M_PER_DEG_LON - c.x), z: Math.round(-(lat - ORIGIN.lat) * M_PER_DEG_LAT - c.z) };
}
/** Map metres -> real lat/lon (inverse of project; used by the data importer for the bbox). */
export function unproject(x, z, size = REAL_SIZE) {
  const c = mapCentre(size);
  return { lat: ORIGIN.lat - (z + c.z) / M_PER_DEG_LAT, lon: ORIGIN.lon + (x + c.x) / M_PER_DEG_LON };
}

/** Geography for a map of the given size, in metres around the map centre. */
export function geography(size = REAL_SIZE) {
  const half = size / 2;
  const P = ([lat, lon]) => { const p = project(lat, lon, size); return [p.x, p.z]; };
  const inside = (p, m = 0) => Math.abs(p.x) < half - m && Math.abs(p.z) < half - m;
  return {
    origin: ORIGIN, centre: mapCentre(size),
    towns: MAP.towns.map((t) => ({ name: t.name, ...project(t.lat, t.lon, size), blocks: t.blocks, county: t.county, real: { lat: t.lat, lon: t.lon } })).filter((t) => inside(t, 100)),
    landmarks: MAP.landmarks.map((l) => ({ name: l.name, kind: l.kind, ...project(l.lat, l.lon, size), real: { lat: l.lat, lon: l.lon } })).filter((l) => inside(l, 60)),
    rivers: MAP.rivers.map((r) => ({ name: r.name, width: r.widthM, swamp: r.swampWidthM, pts: r.path.map(P) })),
    lakes: MAP.lakes.map((l) => ({ name: l.name, caps: l.capsules.map((c) => [P(c.from), P(c.to), c.radiusM]) })),
    roads: MAP.highways.map((r) => ({ name: r.name, pts: r.path.map(P) })),
    regions: Object.fromEntries(['hills', 'sandhills', 'forest'].map((k) => [k, MAP.terrainRegions[k].map((g) => { const [x, z] = P([g.lat, g.lon]); return [x, z, g.radiusM, g.weight]; })])),
  };
}

// ------------------------------------------------------------------ geometry helpers
/** Distance from (x,z) to segment a-b, plus the parameter t along it. */
export function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  let t = ((x - ax) * dx + (z - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x, pz = az + dz * t - z;
  return { d: Math.sqrt(px * px + pz * pz), t };
}
export function polyDist(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    // Cheap bounding reject.
    if (x < Math.min(ax, bx) - best || x > Math.max(ax, bx) + best || z < Math.min(az, bz) - best || z > Math.max(az, bz) + best) continue;
    const d = segDist(x, z, ax, az, bx, bz).d;
    if (d < best) best = d;
  }
  return best;
}
/** Signed-ish depth into a lake: >0 inside (metres from the shore), <0 outside. */
export function lakeDepth(x, z, lake) {
  let best = -Infinity;
  for (const [[ax, az], [bx, bz], r] of lake.caps) best = Math.max(best, r - segDist(x, z, ax, az, bx, bz).d);
  return best;
}
/** Where two polylines cross: [{x, z}] (used to put bridges on highways over rivers). */
export function crossings(a, b) {
  const out = [];
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
    const [x1, z1] = a[i], [x2, z2] = a[i + 1], [x3, z3] = b[j], [x4, z4] = b[j + 1];
    const den = (x1 - x2) * (z3 - z4) - (z1 - z2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x1 - x3) * (z3 - z4) - (z1 - z3) * (x3 - x4)) / den;
    const u = -((x1 - x2) * (z1 - z3) - (z1 - z2) * (x1 - x3)) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push({ x: x1 + t * (x2 - x1), z: z1 + t * (z2 - z1), dir: [x2 - x1, z2 - z1] });
  }
  return out;
}
