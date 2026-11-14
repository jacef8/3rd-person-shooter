// Base building (DayZ-style): gather materials with tools, place a frame, then upgrade it in
// stages. Shared so the client's placement preview applies the same rules the server enforces.
// Numbers live in shared/data/building.json.
import data from './data/building.json' with { type: 'json' };
import { orientedBox } from './world.js';

export const TOOLS = data.tools;

/** Things you can craft at your stash house (or one of your crates). */
export const CRAFTS = data.crafts;

// Each piece has stages: [0] is the frame you place, later ones are upgrades.
// size: [width along X, depth along Z, height] before rotation.
export const PIECES = data.pieces;

export const BUILD = data.build;

/** The box a placed structure occupies: turned to `st.ang` when it has one (a claimed building's
 *  doors follow the building's real walls), otherwise square to the map with `rot` 0 or 1. */
export function structureBox(st, extra = {}) {
  if (st.ang === undefined) return { ...pieceBox(st.type, st.x, st.z, st.rot, st.y0), ...extra };
  const [w, d, h] = PIECES[st.type].size;
  return orientedBox(st.x, st.z, w / 2, d / 2, st.ang, { y0: st.y0 || 0, h, ...extra });
}

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
