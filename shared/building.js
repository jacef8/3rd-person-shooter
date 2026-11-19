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

// ---- the house kit: walls, window walls, door walls and gates on the edges of a 4 m grid; floors
// (roofs) filling its squares, on top of your walls or on the ground as a foundation; stairs up a
// strip along one side of a square. Everything lines up, so four walls and a floor make a room.
export const KIT_CELL = 4;
const EDGE = new Set(['wall', 'window', 'doorway', 'gate']);
export const isEdgePiece = (t) => EDGE.has(t);
export const isKitPiece = (t) => EDGE.has(t) || t === 'floor' || t === 'stairs';
const FLOOR_T = 0.25;
const STAIR_W = 1.4;
const STAIR_LAND = 0.6;   // the level bit at the foot of the stairs

/** The box a placed structure occupies: turned to `st.ang` when it has one (a claimed building's
 *  doors follow the building's real walls), otherwise square to the map with `rot` 0 or 1 (stairs:
 *  0-3, the way they climb). A foundation or stairs carry their own height `h`. */
export function structureBox(st, extra = {}) {
  if (st.ang === undefined) return { ...pieceBox(st.type, st.x, st.z, st.rot, st.y0), ...(st.h ? { h: st.h } : {}), ...extra };
  const [w, d, h] = PIECES[st.type].size;
  return orientedBox(st.x, st.z, w / 2, d / 2, st.ang, { y0: st.y0 || 0, h, ...extra });
}

/** The solid box a structure occupies. */
export function pieceBox(type, x, z, rot, y0 = 0) {
  const [w, d, h] = PIECES[type].size;
  const r = (rot || 0) & 1;
  const hw = (r ? d : w) / 2, hd = (r ? w : d) / 2;
  return { minX: x - hw, minZ: z - hd, maxX: x + hw, maxZ: z + hd, y0, h };
}

/** A door wall's door (the whole thing for a gate): what opens, and what blocks the way when shut. */
export function doorLeaf(st) {
  const b = structureBox(st);
  if (st.type !== 'doorway' || st.ang !== undefined) return b;
  const alongX = !((st.rot || 0) & 1), w = 0.65;
  return alongX ? { ...b, minX: st.x - w, maxX: st.x + w, h: 2.3 } : { ...b, minZ: st.z - w, maxZ: st.z + w, h: 2.3 };
}

/**
 * What a structure blocks, as boxes: a window wall leaves its window open, a door wall its doorway
 * when the door's open (an open gate blocks nothing), a floor leaves a stairwell over stairs, and
 * stairs are one ramp you walk up (world.js rampTop).
 */
export function structureBoxes(st, extra = {}) {
  const def = PIECES[st.type];
  const b = structureBox(st, extra);
  if (st.ang !== undefined) return def.door && st.open ? [] : [b];
  if (st.type === 'window' || st.type === 'doorway') {
    const alongX = !((st.rot || 0) & 1), out = [], H = b.h;
    const seg = (a0, a1, h0, h1, more) => out.push({ ...b, ...(alongX ? { minX: st.x + a0, maxX: st.x + a1 } : { minZ: st.z + a0, maxZ: st.z + a1 }), y0: b.y0 + h0, h: h1 - h0, ...more });
    if (st.type === 'window') { seg(-2, 2, 0, 1.0); seg(-2, 2, 2.2, H); seg(-2, -0.8, 1.0, 2.2); seg(0.8, 2, 1.0, 2.2); }
    else { seg(-2, -0.65, 0, 2.3); seg(0.65, 2, 0, 2.3); seg(-2, 2, 2.3, H); if (!st.open) seg(-0.65, 0.65, 0, 2.3, { leaf: 1 }); }
    return out;
  }
  if (st.type === 'floor' && st.hole) return cutOut(b, st.hole);
  if (st.type === 'stairs') {
    const dir = (st.rot || 0) & 3, ax = dir & 1 ? 'z' : 'x', s = dir < 2 ? 1 : -1;
    const lo = ax === 'x' ? (s > 0 ? b.minX : b.maxX) : (s > 0 ? b.minZ : b.maxZ);
    return [{ ...b, ramp: { ax, s, lo, len: KIT_CELL, land: STAIR_LAND, base: st.base ?? b.y0, rise: st.rise ?? PIECES.stairs.size[2] } }];
  }
  if (def.door && st.open) return [];
  return [b];
}
/** A box with a rectangular hole cut through it, as up to four boxes. */
function cutOut(b, [hx0, hz0, hx1, hz1]) {
  hx0 = Math.max(hx0, b.minX); hx1 = Math.min(hx1, b.maxX); hz0 = Math.max(hz0, b.minZ); hz1 = Math.min(hz1, b.maxZ);
  if (hx1 <= hx0 || hz1 <= hz0) return [b];
  return [
    { ...b, maxX: hx0 }, { ...b, minX: hx1 },
    { ...b, minX: hx0, maxX: hx1, maxZ: hz0 }, { ...b, minX: hx0, maxX: hx1, minZ: hz1 },
  ].filter((q) => q.maxX - q.minX > 0.02 && q.maxZ - q.minZ > 0.02);
}

/** Total materials spent on a structure up to and including `stage` (for dismantle refunds). */
export function investedCost(type, stage) {
  const out = {};
  PIECES[type].stages.slice(0, stage + 1).forEach((s) => { for (const [k, v] of Object.entries(s.cost)) out[k] = (out[k] || 0) + v; });
  return out;
}

/**
 * Where a piece would go and whether it can: placement rules shared by the client's preview and the
 * server. `world` supplies terrain, towns, contacts, landingZones, solidsNear(x, z, r) and (for the
 * house kit) structsNear(x, z, r): structures with `mine` set on yours and your crew's. `player` is
 * { x, z, y (feet) }. (ax, az) is the aim point: house-kit pieces snap to the 4 m grid (walls to the
 * nearest grid line, turned to run along it) and sit on your floors and walls; everything else goes
 * where it's aimed, on the ground or on the floor you're standing on.
 * Returns { x, z, rot, y0, h?, base?, rise?, hole?, holeBy?, holeFloors?, problem }.
 */
export function planPiece(world, type, ax, az, rot, player) {
  const def = PIECES[type];
  if (!def) return { problem: 'Unknown piece' };
  const T = world.terrain, C = KIT_CELL;
  const feet = Number.isFinite(player.y) ? player.y : T.height(player.x, player.z);
  const all = world.structsNear ? world.structsNear(ax, az, 10) : [];
  const mine = all.filter((s) => s.mine && isKitPiece(s.type));
  const topOf = (s) => { const b = structureBox(s); return b.y0 + b.h; };
  const at = (list, t, x, z) => list.filter((s) => (typeof t === 'function' ? t(s.type) : s.type === t) && Math.abs(s.x - x) < 0.1 && Math.abs(s.z - z) < 0.1);
  const cellOf = (v) => Math.floor(v / C) * C;
  let x = ax, z = az, r = rot ? 1 : 0;
  if (EDGE.has(type)) {
    const fx = Math.abs(ax / C - Math.round(ax / C)), fz = Math.abs(az / C - Math.round(az / C));
    if (fz <= fx) { r = 0; x = cellOf(ax) + C / 2; z = Math.round(az / C) * C; }
    else { r = 1; x = Math.round(ax / C) * C; z = cellOf(az) + C / 2; }
  } else if (type === 'floor') { r = 0; x = cellOf(ax) + C / 2; z = cellOf(az) + C / 2; }
  else if (type === 'stairs') {
    r = (rot || 0) & 3;
    if (r & 1) { z = cellOf(az) + C / 2; const c0 = cellOf(ax); x = ax - c0 < C / 2 ? c0 + STAIR_W / 2 : c0 + C - STAIR_W / 2; }
    else { x = cellOf(ax) + C / 2; const c0 = cellOf(az); z = az - c0 < C / 2 ? c0 + STAIR_W / 2 : c0 + C - STAIR_W / 2; }
  }
  const plan = { x, z, rot: r, problem: null };
  const b = pieceBox(type, x, z, r);
  const corners = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ], [x, z]].map(([px, pz]) => T.height(px, pz));
  const tmin = Math.min(...corners), tmax = Math.max(...corners);
  let y0 = tmin - 0.15, h = def.size[2], onGround = true;
  // Standing on one of your floors: things go on it, not on the ground below.
  const floorUnder = (list) => {
    let best = null;
    for (const s of list) { const t = topOf(s); if (Math.abs(t - feet) < 1.6 && (best === null || Math.abs(t - feet) < Math.abs(best - feet))) best = t; }
    return best;
  };
  if (type === 'floor') {
    // On the walls round this square (a roof, or the next storey's floor), level with a floor next
    // door (a balcony), or the ground (a foundation). With a choice: the one just over your head.
    const cands = [
      ...at(mine, isEdgePiece, x, z - C / 2).filter((s) => !(s.rot & 1)), ...at(mine, isEdgePiece, x, z + C / 2).filter((s) => !(s.rot & 1)),
      ...at(mine, isEdgePiece, x - C / 2, z).filter((s) => s.rot & 1), ...at(mine, isEdgePiece, x + C / 2, z).filter((s) => s.rot & 1),
    ].map(topOf).concat([[C, 0], [-C, 0], [0, C], [0, -C]].flatMap(([dx, dz]) => at(mine, 'floor', x + dx, z + dz).map((s) => s.y0)));
    if (cands.length) {
      const above = cands.filter((c) => c >= feet + 1.0);
      y0 = above.length ? Math.min(...above) : Math.max(...cands);
      // Level with a floor next door when it's about the same height (walls on uneven ground differ a little).
      const next = [[C, 0], [-C, 0], [0, C], [0, -C]].flatMap(([dx, dz]) => at(mine, 'floor', x + dx, z + dz).map((s) => s.y0)).filter((c) => Math.abs(c - y0) < 0.4);
      if (next.length) y0 = next.reduce((a, c) => (Math.abs(c - y0) < Math.abs(a - y0) ? c : a));
      h = FLOOR_T; onGround = false;
    } else h = Math.max(FLOOR_T, tmax + 0.1 - y0);
    // Over stairs that come up here: leave the stairwell open.
    const top = y0 + h;
    const st = mine.find((s) => s.type === 'stairs' && cellOf(s.x) + C / 2 === x && cellOf(s.z) + C / 2 === z && Math.abs((s.base ?? s.y0) + (s.rise ?? 3.25) - top) < 0.4);
    if (st) { const sb = structureBox(st); plan.hole = [sb.minX, sb.minZ, sb.maxX, sb.maxZ]; plan.holeBy = st.id; }
  } else if (EDGE.has(type) || type === 'stairs') {
    const cells = type === 'stairs' ? [[cellOf(x) + C / 2, cellOf(z) + C / 2]] : r ? [[x - C / 2, z], [x + C / 2, z]] : [[x, z - C / 2], [x, z + C / 2]];
    const top = floorUnder(cells.flatMap(([cx, cz]) => at(mine, 'floor', cx, cz)));
    if (top !== null) { y0 = top; onGround = false; }
    if (type === 'stairs') {
      const dir = r, s = dir < 2 ? 1 : -1;
      const lowX = dir & 1 ? x : x - s * C / 2, lowZ = dir & 1 ? z - s * C / 2 : z;
      plan.base = +(onGround ? T.height(lowX, lowZ) : y0).toFixed(2);
      // Up to the floor over them, or a roof next to them; a storey up if there's neither yet.
      const want = plan.base + PIECES.stairs.size[2];
      const cx = cellOf(x) + C / 2, cz = cellOf(z) + C / 2;
      let best = null;
      for (const [dx, dz] of [[0, 0], [C, 0], [-C, 0], [0, C], [0, -C]]) {
        for (const f of at(mine, 'floor', cx + dx, cz + dz)) {
          const t = topOf(f), rise = t - plan.base;
          if (rise >= 2.2 && rise <= 3.6 && (best === null || Math.abs(t - want) < Math.abs(best - want))) best = t;
        }
      }
      plan.rise = +((best ?? want) - plan.base).toFixed(2);
      h = plan.base + plan.rise - y0;
      plan.holeFloors = at(mine, 'floor', cx, cz).filter((f) => Math.abs(topOf(f) - (plan.base + plan.rise)) < 0.4).map((f) => f.id);
    }
  } else if (!def.explosive) {
    const top = floorUnder(mine.filter((s) => s.type === 'floor' && (s.hole ? structureBoxes(s) : [structureBox(s)]).some((q) => x > q.minX && x < q.maxX && z > q.minZ && z < q.maxZ)));
    if (top !== null) { y0 = top; onGround = false; }
  }
  plan.y0 = +y0.toFixed(2);
  if (Math.abs(h - def.size[2]) > 0.01) plan.h = +h.toFixed(2);
  const hh = plan.h ?? def.size[2];
  const problem = (msg) => { plan.problem = msg; return plan; };

  if (Math.hypot(x - player.x, z - player.z) > BUILD.reach + 1) return problem('Too far away');
  for (const t of world.towns) {
    const q = t.rect, m = BUILD.townMargin;
    if (b.maxX > q.minX - m && b.minX < q.maxX + m && b.maxZ > q.minZ - m && b.minZ < q.maxZ + m) return problem('No building inside towns — build out in the wild');
  }
  for (const c of [...world.contacts, ...world.landingZones]) if (Math.hypot(c.x - x, c.z - z) < BUILD.contactClear) return problem('Too close to a Contact / landing zone');
  if (onGround) {
    if (tmin < 0.2) return problem('Can\'t build in water');
    if (!def.explosive && tmax - tmin > BUILD.maxSlope) return problem('Ground too steep');
    if ((type === 'window' || type === 'doorway') && tmax - tmin > 0.6) return problem('Ground too uneven for a doorway or window: put a floor down first');
  }
  if (!def.explosive) {
    // One piece per slot: the same wall, floor or stairs again on top of itself.
    const cls = (t) => (EDGE.has(t) ? 'edge' : t);
    if (isKitPiece(type) && all.some((s) => cls(s.type) === cls(type) && Math.abs(s.x - x) < 0.1 && Math.abs(s.z - z) < 0.1 && ((s.rot || 0) & 1) === (r & 1) && Math.min(topOf(s), y0 + hh) - Math.max(s.y0, y0) > 0.3)) return problem('Blocked: there\'s one there already');
    // Your own house-kit pieces fit together (a floor on its walls, stairs against one); anything
    // else in the way blocks it.
    const kitIds = new Set(isKitPiece(type) ? mine.map((s) => s.id) : []);
    for (const o of world.solidsNear(x, z, 6)) {
      if (o.structId && kitIds.has(o.structId)) continue;
      if (!(b.maxX > o.minX + 0.05 && b.minX < o.maxX - 0.05 && b.maxZ > o.minZ + 0.05 && b.minZ < o.maxZ - 0.05)) continue;
      if (o.y0 !== undefined) {
        if (onGround && o.y0 > corners[4] + 2.5 && !o.structId) continue;   // overhead (e.g. cave roof / canopy)
        if (o.y0 >= y0 + hh - 0.05 || o.y0 + o.h <= y0 + 0.05) continue;   // above or below it
      }
      return problem('Blocked');
    }
    const body = !(y0 > feet + 1.9 || y0 + hh < feet + 0.1);
    if (body && Math.hypot(player.x - x, player.z - z) < 0.9 + Math.max(...def.size.slice(0, 2)) / 2 && player.x > b.minX - 0.5 && player.x < b.maxX + 0.5 && player.z > b.minZ - 0.5 && player.z < b.maxZ + 0.5) return problem('You\'re standing there');
  }
  return plan;
}

/** Just the yes/no of planPiece: null if it can go there, or the reason it can't. */
export function placementProblem(world, type, x, z, rot, player) {
  return planPiece(world, type, x, z, rot, player).problem || null;
}
