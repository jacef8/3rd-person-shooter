// Base building (DayZ-style): gather materials with tools, place a frame, then upgrade it in
// stages. Shared so the client's placement preview applies the same rules the server enforces.

export const TOOLS = {
  hammer:  { name: 'Hammer',  desc: 'Needed to place and upgrade anything you build.' },
  hatchet: { name: 'Hatchet', desc: 'Chop trees for wood. Also chops through wooden walls and gates.' },
  pickaxe: { name: 'Pickaxe', desc: 'Mine rocks for stone. Also breaks stone walls and gates.' },
};

/** Things you can craft at your stash house (or one of your crates). */
export const CRAFTS = {
  hammer:  { name: 'Hammer',        level: 1, cost: { parts: 15 } },
  hatchet: { name: 'Hatchet',       level: 1, cost: { parts: 20 } },
  pickaxe: { name: 'Pickaxe',       level: 2, cost: { parts: 25 } },
  charge:  { name: 'Breach Charge', level: 7, cost: { salvage: 30, tech: 20, parts: 20 }, desc: 'Explodes 8 s after placing: wrecks walls, gates, doors and anyone standing too close.' },
};

// Each piece has stages: [0] is the frame you place, later ones are upgrades.
// size: [width along X, depth along Z, height] before rotation.
export const PIECES = {
  wall: {
    name: 'Wall', size: [4, 0.4, 3], key: '1',
    stages: [
      { name: 'Wall frame', cost: { wood: 10 }, hp: 300, material: 'frame' },
      { name: 'Wooden wall', cost: { wood: 15 }, hp: 1500, material: 'wood' },
      { name: 'Stone wall', cost: { stone: 20, salvage: 10 }, hp: 4000, material: 'stone' },
    ],
  },
  gate: {
    name: 'Gate', size: [4, 0.4, 3], key: '2', door: true,
    stages: [
      { name: 'Gate frame', cost: { wood: 10 }, hp: 300, material: 'frame' },
      { name: 'Wooden gate', cost: { wood: 15, salvage: 10 }, hp: 1400, material: 'wood' },
      { name: 'Reinforced gate', cost: { stone: 15, salvage: 20 }, hp: 3500, material: 'stone' },
    ],
  },
  barricade: {
    name: 'Barricade', size: [2.4, 0.6, 1.1], key: '3',
    stages: [{ name: 'Barricade', cost: { wood: 8 }, hp: 800, material: 'wood' }],
  },
  crate: {
    name: 'Stash crate', size: [1.2, 0.8, 0.9], key: '4', container: true,
    stages: [
      { name: 'Wooden crate', cost: { wood: 20 }, hp: 800, material: 'wood', slots: 20 },
      { name: 'Reinforced crate', cost: { stone: 10, salvage: 15 }, hp: 2000, material: 'stone', slots: 40 },
    ],
  },
  charge: {
    name: 'Breach charge', size: [0.4, 0.4, 0.3], key: '5', explosive: true,
    stages: [{ name: 'Breach charge', cost: {}, hp: 1, material: 'charge' }],
  },
};

export const BUILD = {
  reach: 5,                // how far from you a piece can be placed
  maxPerPlayer: 80,
  townMargin: 6,           // no building inside towns (plus this margin)
  contactClear: 25,        // or right next to Contacts / landing zones
  maxSlope: 1.6,           // max height difference across a piece's footprint
  harvest: { wood: 6, stone: 5, uses: 4, regrowMs: 20 * 60_000, channelMs: 3000 },
  upgradeMs: 3000,
  raid: { hatchet: { ms: 6000, dmg: 350, vs: 'frame,wood' }, pickaxe: { ms: 8000, dmg: 500, vs: 'frame,wood,stone' } },
  bulletMul: { frame: 0.5, wood: 0.15, stone: 0.04 },
  charge: { fuseMs: 8000, damage: 2600, radius: 4.5, playerDamage: 140, playerRadius: 6 },
};

/** The solid box a structure occupies. */
export function pieceBox(type, x, z, rot, y0 = 0) {
  const [w, d, h] = PIECES[type].size;
  const hw = (rot ? d : w) / 2, hd = (rot ? w : d) / 2;
  return { minX: x - hw, minZ: z - hd, maxX: x + hw, maxZ: z + hd, y0, h };
}

/** Total materials spent on a structure up to and including `stage` (for dismantle refunds). */
export function investedCost(type, stage) {
  const out = {};
  PIECES[type].stages.slice(0, stage + 1).forEach((s) => { for (const [k, v] of Object.entries(s.cost)) out[k] = (out[k] || 0) + v; });
  return out;
}

/**
 * Placement rules shared by client preview and server. `world` supplies:
 * terrain, towns, contacts, landingZones, solidsNear(x,z,r).
 * Returns null if OK, or a reason string.
 */
export function placementProblem(world, type, x, z, rot, player) {
  const def = PIECES[type];
  if (!def) return 'Unknown piece';
  if (Math.hypot(x - player.x, z - player.z) > BUILD.reach + 1) return 'Too far away';
  const b = pieceBox(type, x, z, rot);
  for (const t of world.towns) {
    const r = t.rect, m = BUILD.townMargin;
    if (b.maxX > r.minX - m && b.minX < r.maxX + m && b.maxZ > r.minZ - m && b.minZ < r.maxZ + m) return 'No building inside towns — build out in the wild';
  }
  for (const c of [...world.contacts, ...world.landingZones]) if (Math.hypot(c.x - x, c.z - z) < BUILD.contactClear) return 'Too close to a Contact / landing zone';
  const hs = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ], [x, z]].map(([px, pz]) => world.terrain.height(px, pz));
  if (Math.min(...hs) < 0.2) return 'Can\'t build in water';
  if (!def.explosive && Math.max(...hs) - Math.min(...hs) > BUILD.maxSlope) return 'Ground too steep';
  if (!def.explosive) {
    for (const o of world.solidsNear(x, z, 6)) {
      if (b.maxX > o.minX + 0.05 && b.minX < o.maxX - 0.05 && b.maxZ > o.minZ + 0.05 && b.minZ < o.maxZ - 0.05) {
        if (o.y0 !== undefined && o.y0 > hs[4] + 2.5) continue;   // overhead (e.g. cave roof / canopy)
        return 'Blocked';
      }
    }
    if (Math.hypot(player.x - x, player.z - z) < 0.9 + Math.max(...def.size.slice(0, 2)) / 2 && player.x > b.minX - 0.5 && player.x < b.maxX + 0.5 && player.z > b.minZ - 0.5 && player.z < b.maxZ + 0.5) return 'You\'re standing there';
  }
  return null;
}
