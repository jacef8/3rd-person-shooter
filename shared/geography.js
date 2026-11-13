// Real-world layout of the area around Bristol, Florida (Liberty County) at real 1:1 scale:
// one game metre is one real metre. +X is east, +Z is south (the map is drawn north-up).
//
// The full map is 30 x 30 km, centred 5 km east and 1.5 km north of Bristol so it takes in
// Blountstown, Lake Mystic, Hosford, Telogia, Estiffanulga and Torreya State Park. Smaller test maps
// crop the same layout around Bristol. Town and landmark positions come from real latitude /
// longitude (Wikipedia/GNIS). Rivers, lakes, highways and terrain regions were traced at 1 mile =
// 133.33 m and are scaled up here by REF_TO_REAL.
//
// Real buildings and roads are optional: run tools/import-real-data.mjs where the data hosts are
// reachable and the generator places every structure from data/real/ (see README).

export const ORIGIN = { lat: 30.42556, lon: -84.97722, name: 'Bristol, FL' };
export const REAL_SIZE = 30000;                           // metres across the full map
const CENTRE = { x: 5000, z: -1500 };                     // map centre, metres from Bristol
const M_PER_MILE = 1609.344;
export const REF_TO_REAL = M_PER_MILE / (4000 / 30);      // traced reference metres -> real metres
const MI_PER_DEG_LAT = 69.05;
const MI_PER_DEG_LON = 69.17 * Math.cos((ORIGIN.lat * Math.PI) / 180);   // computed once at load

/** Map centre (metres from Bristol) for a map of this size: smaller maps stay around Bristol. */
export function mapCentre(size = REAL_SIZE) {
  const f = Math.min(1, size / REAL_SIZE);
  return { x: CENTRE.x * f, z: CENTRE.z * f };
}
/** Real lat/lon -> map metres (1:1) for a map of the given size. */
export function project(lat, lon, size = REAL_SIZE) {
  const c = mapCentre(size);
  return {
    x: Math.round((lon - ORIGIN.lon) * MI_PER_DEG_LON * M_PER_MILE - c.x),
    z: Math.round(-(lat - ORIGIN.lat) * MI_PER_DEG_LAT * M_PER_MILE - c.z),
  };
}
/** Map metres -> real lat/lon (inverse of project; used by the data importer for the bbox). */
export function unproject(x, z, size = REAL_SIZE) {
  const c = mapCentre(size);
  return { lat: ORIGIN.lat - (z + c.z) / (MI_PER_DEG_LAT * M_PER_MILE), lon: ORIGIN.lon + (x + c.x) / (MI_PER_DEG_LON * M_PER_MILE) };
}

// Real towns. blocks ~ size by population; county for flavour.
// [name, lat, lon, blocks, county]
const TOWN_DATA = [
  ['Bristol', 30.42556, -84.97722, 5, 'Liberty'],
  ['Blountstown', 30.44306, -85.04556, 6, 'Calhoun'],
  ['Hosford', 30.38667, -84.79806, 3, 'Liberty'],
  ['Telogia', 30.35083, -84.81917, 3, 'Liberty'],
  ['Estiffanulga', 30.30833, -85.0325, 3, 'Liberty'],
  ['Lake Mystic', 30.37944, -85.00139, 3, 'Liberty'],
  ['Sumatra', 30.02306, -84.9825, 3, 'Liberty'],
  ['Altha', 30.57139, -85.12278, 3, 'Calhoun'],
  ['Clarksville', 30.43694, -85.18611, 3, 'Calhoun'],
  ['Kinard', 30.28083, -85.26389, 3, 'Calhoun'],
  ['Scotts Ferry', 30.2953, -85.1317, 3, 'Calhoun'],
  ['Chattahoochee', 30.7, -84.83333, 6, 'Gadsden'],
  ['Greensboro', 30.57083, -84.74444, 4, 'Gadsden'],
  ['Gretna', 30.61556, -84.6625, 4, 'Gadsden'],
  ['Quincy', 30.56611, -84.58583, 8, 'Gadsden'],
  ['Mount Pleasant', 30.65722, -84.69111, 3, 'Gadsden'],
  ['Sneads', 30.70861, -84.925, 5, 'Jackson'],
  ['Grand Ridge', 30.71194, -85.00194, 4, 'Jackson'],
  ['Marianna', 30.77389, -85.25472, 8, 'Jackson'],
  ['Cottondale', 30.79556, -85.37444, 4, 'Jackson'],
  ['Wewahitchka', 30.12556, -85.19222, 5, 'Gulf'],
];

// Landmarks: state parks, the dam and the national forest.
const LANDMARK_DATA = [
  ['Torreya State Park', 30.56889, -84.94806, 'park'],
  ['Three Rivers State Park', 30.73984, -84.93487, 'park'],
  ['Florida Caverns State Park', 30.81389, -85.23306, 'park'],
  ['Jim Woodruff Dam', 30.70861, -84.86389, 'dam'],
  ['Apalachicola National Forest', 30.23611, -84.66556, 'forest'],
];

// Rivers as polylines on the reference map (metres), traced from the real courses.
// Apalachicola: from Jim Woodruff Dam south between Blountstown and Bristol, past Estiffanulga,
// east of Wewahitchka. Chipola: from Marianna / Florida Caverns south past Altha, Clarksville and
// Scotts Ferry, through the Dead Lakes and into the Apalachicola. Ochlockonee: out of Lake Talquin
// (Jackson Bluff) south along the Liberty County line through the national forest.
// Real channel widths and floodplain (swamp) widths, metres.
const RIVER_REAL = { 'Apalachicola River': [140, 1900], 'Chipola River': [45, 800], 'Ochlockonee River': [55, 1000] };
const RIVER_DATA = [
  { name: 'Apalachicola River', width: 30, swamp: 330, pts: [[901, -2606], [760, -2350], [520, -1900], [260, -1400], [90, -950], [-110, -560], [-280, -160], [-380, 300], [-470, 720], [-540, 1100], [-660, 1600], [-860, 2200], [-1050, 2800], [-1160, 3400], [-1260, 4060]] },
  { name: 'Chipola River', width: 18, swamp: 200, pts: [[-2035, -3620], [-2010, -3000], [-1820, -2300], [-1590, -1400], [-1700, -600], [-1820, -100], [-1600, 500], [-1240, 1190], [-1480, 2000], [-1660, 2500], [-1450, 3000], [-1110, 3320]] },
  { name: 'Ochlockonee River', width: 22, swamp: 240, pts: [[2560, 380], [2380, 900], [2220, 1500], [2060, 2200], [1900, 2900], [1720, 3600], [1640, 4060]] },
];

// Lakes as capsules (segment + radius) so they're cheap to test.
const LAKE_DATA = [
  { name: 'Lake Seminole', caps: [[[920, -2700], [1500, -3000], 230], [[700, -2900], [560, -4060], 160], [[1450, -3000], [1900, -4060], 190], [[1200, -2850], [1300, -3350], 220]] },
  { name: 'Lake Talquin', caps: [[[2560, 380], [3200, 300], 75], [[3200, 300], [4060, 230], 90]] },
  { name: 'Dead Lakes', caps: [[[-1720, 2100], [-1640, 2650], 120]] },
  { name: 'Lake Mystic', caps: [[[-215, 395], [-170, 455], 55]] },
  { name: "Merritt's Mill Pond", caps: [[[-2060, -3330], [-2000, -2880], 28]] },
];

// Highways, traced between the real towns they connect.
const ROAD_DATA = [
  { name: 'SR 20', pts: [[-4060, -60], [-2800, -90], [-1661, -105], [-544, -161], [0, 0], [700, 250], [1425, 358], [2200, 430], [2600, 470], [4060, 520]] },
  { name: 'SR 12', pts: [[0, 0], [320, -600], [1000, -1100], [1851, -1337], [2500, -1300], [3113, -1294]] },
  { name: 'SR 65', pts: [[1425, 358], [1257, 688], [1100, 1600], [700, 2600], [-42, 3705], [-100, 4060]] },
  { name: 'SR 71', pts: [[-2207, -3207], [-1700, -2500], [-1158, -1343], [-800, -700], [-544, -161], [-760, 700], [-1100, 1500], [-1500, 2350], [-1711, 2762], [-2000, 4060]] },
  { name: 'SR 69', pts: [[-544, -161], [-420, -1300], [-260, -2200], [-197, -2637]] },
  { name: 'SR 267', pts: [[3113, -1294], [3000, -400], [2700, 380]] },
  { name: 'US 90', pts: [[-4060, -3330], [-3159, -3407], [-2207, -3207], [-1100, -2900], [-197, -2637], [415, -2606], [820, -2560], [1144, -2527], [1700, -2350], [2276, -2133], [2800, -1700], [3113, -1294], [4060, -1050]] },
  { name: 'I-10', pts: [[-4060, -3150], [-2300, -2950], [-1000, -2700], [-197, -2540], [415, -2480], [780, -2450], [1144, -2400], [1800, -2050], [2503, -1720], [3200, -1080], [4060, -820]] },
];

// Regions that set the terrain character (circles: [x, z, radius, weight]).
// Hills = the Torreya bluffs along the east bank and the Red Hills of Gadsden County, plus the karst
// hills around Marianna / Florida Caverns. Sandhills = dry sand-pine scrub in the national forest
// and Gulf County. Forest = the Apalachicola National Forest flatwoods.
const REGION_DATA = {
  hills: [[700, -1600, 620, 1], [380, -800, 450, 0.9], [980, -2150, 450, 0.8], [1700, -1500, 900, 0.7], [2700, -1700, 900, 0.75], [3300, -800, 700, 0.6], [-2100, -3450, 650, 0.7]],
  // The first sandhill patch is the Apalachicola Bluffs & Ravines Preserve just north of Bristol.
  sandhills: [[250, -330, 230, 1], [1100, 700, 260, 0.8], [700, 2700, 850, 1], [2700, 2300, 700, 0.9], [-2700, 3100, 750, 0.8], [3400, 3500, 650, 0.8]],
  // Pine plantations and flatwoods between Bristol, Hosford and Telogia.
  forest: [[1500, 250, 950, 0.85], [700, 600, 500, 0.7], [1600, 2200, 2600, 1], [500, 1300, 1300, 0.9], [-2300, 1200, 1100, 0.6], [-3100, -800, 900, 0.5], [3400, 1200, 1000, 0.9]],
};

const K = REF_TO_REAL;
function realPts(pts, c) { return pts.map(([x, z]) => [Math.round(x * K - c.x), Math.round(z * K - c.z)]); }
// Town grid size at 1:1, from the reference size (by population).
const REAL_BLOCKS = { 3: 5, 4: 7, 5: 9, 6: 11, 8: 13 };

/** Geography for a map of the given size, in real metres around the map centre. */
export function geography(size = REAL_SIZE) {
  const half = size / 2, c = mapCentre(size);
  const inside = (p, m = 0) => Math.abs(p.x) < half - m && Math.abs(p.z) < half - m;
  return {
    origin: ORIGIN, centre: c,
    towns: TOWN_DATA.map(([name, lat, lon, blocks, county]) => ({ name, ...project(lat, lon, size), blocks: REAL_BLOCKS[blocks] || blocks, county, real: { lat, lon } })).filter((t) => inside(t, 100)),
    landmarks: LANDMARK_DATA.map(([name, lat, lon, kind]) => ({ name, kind, ...project(lat, lon, size), real: { lat, lon } })).filter((l) => inside(l, 60)),
    rivers: RIVER_DATA.map((r) => ({ name: r.name, width: RIVER_REAL[r.name][0], swamp: RIVER_REAL[r.name][1], pts: realPts(r.pts, c) })),
    lakes: LAKE_DATA.map((l) => ({ name: l.name, caps: l.caps.map(([a, b, r]) => [realPts([a], c)[0], realPts([b], c)[0], Math.round(r * K * (l.name === 'Lake Mystic' ? 0.55 : 1))]) })),
    roads: ROAD_DATA.map((r) => ({ name: r.name, pts: realPts(r.pts, c) })),
    regions: Object.fromEntries(Object.entries(REGION_DATA).map(([k, list]) => [k, list.map(([x, z, r, w]) => [x * K - c.x, z * K - c.z, r * K, w])])),
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
