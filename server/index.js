// Authoritative game server: one persistent, always-live 30 x 30 km open world (real 1:1 Bristol, FL).
// - Serves the browser client over HTTP(S) and runs the simulation over WebSocket.
// - Every position, shot, hit, pickup, hack, contract and stash transfer is validated here.
// - World state (characters, stash houses and their upgrades, dropped bags) persists to disk, so the
//   world keeps existing while players are offline — including their stash houses.
// - Interest management: each player only receives what's within ~320 m of them, and AI only runs
//   near players, which is what lets one server host a PUBG-sized map.

import { withCounty } from '../shared/county.js';
import { withEdits, placement } from '../shared/edits.js';
import { SITES, findSites } from '../shared/sites.js';
import { project } from '../shared/geography.js';
import { cleanLook } from '../shared/looks.js';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { packMap, natureTiles } from './gmap.js';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { biomeName, DEEP_WATER, parseElevation, parseLandcover, COVER, RELIEF } from '../shared/terrain.js';
import zlib from 'node:zlib';
import { serveStatic } from './static.js';
import webpush from 'web-push';
import { BOATS, RIDES, RIDE_RULES, floats, seatPos, isLand, riderFeet, rideSolids } from '../shared/boats.js';
import {
  SpatialGrid, generateMap, mapChecksum, moveWithCollision, HOME_KINDS, VEHICLE_TYPES, resolveCircle, rayAgainstBoxes, throwPath, rayBox, rayHitBox, insideBuilding, characterBounds,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, PRONE_EYE, PRONE_SPEED, SPRINT_SPEED, INTERACT_RANGE, DEFAULT_WORLD_SIZE,
  JUMP_V, JUMP_G, blocksAt, circleOverlapsBox, climbAhead, climbVy, CLIMB, LADDER, ladderAt, drawMs,
} from '../shared/world.js';
import {
  makeWeapon, makeArmor, makeConsumable, weaponStats, DEFAULT_PARTS, armorStats, worldSupply, partFits, isUnlocked,
  levelFromXp, xpForLevel, MAX_LEVEL, unlocksAt, XP, ARCHETYPES, MODELS, modelOf, gunLabel, PARTS, PAINTS, ARMORS, SLOTS, GADGETS, FIELD_PERKS,
  UPGRADES, CONTRACT_TYPES, SUPPLY_DROP_CONTENTS, TERMINAL_REWARD, TERMINAL_COOLDOWN_MS,
} from '../shared/items.js';
import { PIECES, BUILD, TOOLS, CRAFTS, pieceBox, structureBox, investedCost, placementProblem } from '../shared/building.js';
import { CLAIM, HOME_XP, homeLevel, homePerks, RAIDS, windowOpen, windowText } from '../shared/claims.js';
import { EXTRACT } from '../shared/extraction.js';
import { distText, feet } from '../shared/units.js';
import { SKY, airRates, nextMode, stepAir } from '../shared/skydive.js';
import COMBAT from '../shared/data/combat.json' with { type: 'json' };
import GADGET_DATA from '../shared/data/gadgets.json' with { type: 'json' };
import ACTIVITIES from '../shared/data/activities.json' with { type: 'json' };
import HOMESTEAD from '../shared/data/homestead.json' with { type: 'json' };
import ECONOMY from '../shared/data/economy.json' with { type: 'json' };
import LIVING from '../shared/data/world.json' with { type: 'json' };
import RIVER_DATA from '../shared/data/river.json' with { type: 'json' };
import PAWN from '../shared/data/pawn.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const SEED = Number(process.env.SEED || 1337);
const WORLD_SIZE = Number(process.env.WORLD_SIZE || DEFAULT_WORLD_SIZE);
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const WORLD_ID = Number(process.env.WORLD_ID || 1);
const WORLD_NAME = process.env.WORLD_NAME || 'Bristol';
const TICK_HZ = 20;
const SNAPSHOT_EVERY = 2;              // 10 Hz
const INTEREST = 320;                  // metres: what each client is told about
const AMBIENT_BOTS = Number(process.env.BOTS ?? 12);   // roaming rogues kept around each active player (in squads)
const BOT_ACTIVE_RANGE = 450;
// Testing kit (on while the game is in development; set DEV_KIT=0 to turn it off): everyone gets one
// of every gun and armor, flares, charges, tools, top level (every scope, part, paint and grenade
// unlocked), plenty of cash and materials, a bigger backpack, and the gunsmith anywhere. It refills
// on every join and respawn.
const DEV_KIT = process.env.DEV_KIT !== '0';
const PACK_SIZE = DEV_KIT ? 80 : COMBAT.packSize;
const DOOR_HP = Number(process.env.DOOR_HP || COMBAT.doorHp);
const LOOT_RESPAWN_MS = ACTIVITIES.loot.respawnMs;
const BAG_LIFETIME_MS = COMBAT.bagLifetimeMs;
const DB_VERSION = 12;   // 12: real towns have no made-up compound (the stash-house list changed; v11 saves carry over, see loadDb)
const SQUAD_MAX = COMBAT.crewMax;
const GOODS = Object.keys(HOMESTEAD.goods);   // cash, seeds, crops, fish, meat, meals
const RESOURCES = ['ammo', 'rockets', 'parts', 'tech', 'intel', 'salvage', 'wood', 'stone', ...GOODS];   // carried; all drop on death, all stealable
const CAMO_REVEAL_DIST = GADGET_DATA.camoRevealDistance;
const MARK_MS = GADGET_DATA.markMs;
const SENSOR = GADGET_DATA.sensor;
const HACK_MS = ACTIVITIES.hackMs;
const RALLY = GADGET_DATA.rally;
const SPAWN_PROTECT_MS = COMBAT.spawnProtectMs;
const MAX_CONTRACTS = ACTIVITIES.contracts.maxActive;
const CONTRACT_MS = ACTIVITIES.contracts.durationMs;
const SUPPLY_EVERY_MS = Number(process.env.SUPPLY_EVERY_MS || ACTIVITIES.supplyDrop.everyMs);
const SUPPLY_FALL_MS = Number(process.env.SUPPLY_FALL_MS || ACTIVITIES.supplyDrop.fallMs);

// Real-world data (tools/import_real_world.py): real ground elevation, and every real building and road as a map object.
const REAL_DIR = process.env.REAL_DATA_DIR || path.join(ROOT, 'data', 'real');
const readReal = (name) => { try { return JSON.parse(fs.readFileSync(path.join(REAL_DIR, name), 'utf8')); } catch { return null; } };
const readElevation = () => { try { return parseElevation(zlib.gunzipSync(fs.readFileSync(path.join(REAL_DIR, 'elevation.bin.gz')))); } catch { return null; } };
const readLandcover = () => { try { return parseLandcover(zlib.gunzipSync(fs.readFileSync(path.join(REAL_DIR, 'landcover.bin.gz')))); } catch { return null; } };
const realFiles = process.env.REAL_DATA === '0' ? {} : { structures: readReal('structures.json'), roads: readReal('roads.json'), elevation: readElevation(), landcover: readLandcover(), infrastructure: readReal('infrastructure.json') };
const COUNTY = process.env.REAL_DATA === '0' || process.env.COUNTY_DATA === '0' ? null : readReal('county.json');   // Liberty County's own GIS (shared/county.js)
const MERGED = withCounty({ structures: realFiles.structures?.rows, roads: realFiles.roads?.rows, elevation: realFiles.elevation, landcover: realFiles.landcover, infrastructure: realFiles.infrastructure }, COUNTY);
// Hand fixes from the map editor (client/editor.html, saved by the hub beside the world's save):
// read once at start, so the world and everyone in it are built from the same ones.
const EDITS_FILE = process.env.MAP_EDITS_FILE || path.join(path.dirname(DATA_FILE), 'map-edits.json');
const EDITS = (() => { if (process.env.REAL_DATA === '0') return null; try { const e = JSON.parse(fs.readFileSync(EDITS_FILE, 'utf8')); return e?.b && Object.keys(e.b).length ? e : null; } catch { return null; } })();
const map = generateMap(SEED, WORLD_SIZE, withEdits(MERGED, EDITS));
// Clients fetch the same files so they generate the identical world.
const REAL_INFO = (realFiles.structures || realFiles.roads || realFiles.elevation) ? { ...(EDITS ? { edits: EDITS } : {}), county: !!COUNTY, structures: !!realFiles.structures, roads: !!realFiles.roads, elevation: !!realFiles.elevation, landcover: !!realFiles.landcover, infrastructure: !!realFiles.infrastructure } : null;
const grid = map.grid;
const terrain = map.terrain;
/** Look something up by a key a client sent: only the table's own entries count (never 'constructor'
 *  and friends, never a "_about" note). */
const own = (table, key) => (typeof key === 'string' && key[0] !== '_' && Object.hasOwn(table, key) ? table[key] : undefined);
/** An entry of a list by an index a client sent: whole numbers only. */
const nth = (list, i) => { const k = typeof i === 'string' && /^\d+$/.test(i) ? Number(i) : i; return Number.isInteger(k) && k >= 0 && k < list.length ? list[k] : undefined; };
/** Where a character stands: a boat deck, a bridge deck (its tracked height, while it's still where it was
 *  measured), or the ground; plus how high it is on a jump. */
const standing = (c) => (c.y !== undefined && c.yx === c.x && c.yz === c.z ? c.y : terrain.height(c.x, c.z));
const gy = (c) => (c.boat ? boatFeet(c) : standing(c) + (c.air ? c.air.alt : 0) + (c.hop ? c.hop.alt : 0));   // where a character's feet are: the ground, a boat deck, or up in the air on a jump
const MAP_SUM = mapChecksum(map);

// ---------------------------------------------------------------- persistence
const freshHouse = () => ({ owner: null, ownerName: null, doorHp: DOOR_HP, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, upg: {} });
function freshDb() {
  return { characters: {}, houses: Object.fromEntries(map.houses.map((h) => [h.id, freshHouse()])), bags: [], structures: [] };
}
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // 11 -> 12: the towns' made-up compounds went, so the stash-house list was renumbered. Characters,
    // crews, claimed real buildings, boats and Lamar's case carry over; only house claims reset.
    if (db.seed === SEED && db.size === WORLD_SIZE && db.version === 11 && DB_VERSION === 12) {
      db.houses = {};
      for (const c of Object.values(db.characters || {})) c.needsDeploy = true;
      db.version = 12;
      console.log('Save moved to version 12: characters kept, stash houses reset');
    }
    if (db.seed !== SEED || db.version !== DB_VERSION || db.size !== WORLD_SIZE) throw new Error('incompatible save');
    return db;
  } catch {
    return { seed: SEED, version: DB_VERSION, size: WORLD_SIZE, ...freshDb() };
  }
}
const db = loadDb();
Object.assign(db, { seed: SEED, version: DB_VERSION, size: WORLD_SIZE });
// Guns renamed since they were made (the "Carbine" is the Assault Rifle now): saved ones take the new name.
{
  const OLD = { carbine: ['Carbine'] };
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (o.kind === 'weapon' && OLD[o.archetype]?.includes(o.name) && ARCHETYPES[o.archetype]) o.name = ARCHETYPES[o.archetype].label;
    // Made before there were real guns in a class: it's the class's first one (an AR-15, a deer rifle).
    if (o.kind === 'weapon' && MODELS[o.archetype] && !o.model) { o.model = modelOf(o); if (o.name === ARCHETYPES[o.archetype].label) o.name = gunLabel(o.archetype, o.model); }
    for (const v of Array.isArray(o) ? o : Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(db);
}
moveWithEdits();
/**
 * A building moved or turned in the map editor takes what's inside it along: a claimed building's stash
 * locker and everything players built in and around it (within a metre of its walls) keeps its place in
 * the building. Compared with the edits the world last ran with (db.appliedEdits).
 */
function moveWithEdits() {
  const rows = MERGED?.structures;
  if (!rows) return;
  const prev = db.appliedEdits?.b || {}, next = EDITS?.b || {};
  const at = (i, e) => (e && !e.gone ? { ...placement(rows[i]), ...e } : e?.gone ? null : placement(rows[i]));
  let moved = 0;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const i = Number(k);
    if (!rows[i]) continue;
    const a = at(i, prev[k]), b = at(i, next[k]);
    if (!a || !b || (a.lat === b.lat && a.lon === b.lon && a.ang === b.ang)) continue;
    const pa = project(a.lat, a.lon, map.size), pb = project(b.lat, b.lon, map.size);
    const ra = a.ang * Math.PI / 180, rb = b.ang * Math.PI / 180, turn = rb - ra;
    for (const st of db.structures) {
      const dx = st.x - pa.x, dz = st.z - pa.z;
      const lx = dx * Math.cos(ra) + dz * Math.sin(ra), lz = -dx * Math.sin(ra) + dz * Math.cos(ra);
      if (Math.abs(lx) > a.w / 2 + 1 || Math.abs(lz) > a.d / 2 + 1) continue;
      st.x = pb.x + dx * Math.cos(turn) - dz * Math.sin(turn);
      st.z = pb.z + dx * Math.sin(turn) + dz * Math.cos(turn);
      if (Math.round(Math.abs(turn) / (Math.PI / 2)) % 2) st.rot = st.rot ? 0 : 1;
      st.y0 = terrain.height(st.x, st.z) - 0.05;
      moved++;
    }
  }
  if (moved) console.log(`Map edits: ${moved} stash lockers and built pieces moved along with their buildings`);
  db.appliedEdits = EDITS || null;
}
// The map editor (via the hub) asks which buildings are someone's stash house (so they aren't taken out),
// which of its fixes the world couldn't build, and whether a building would stand where it's being put.
if (process.send) process.on('message', (m) => {
  if (m?.t === 'claims') {
    const out = [];
    for (const st of structs.values()) if (PIECES[st.type].claim && st.building != null && map.buildings[st.building]?.si != null) out.push([map.buildings[st.building].si, st.ownerName || '']);
    const built = new Set(map.buildings.map((b) => b.si).filter((v) => v != null));
    const missing = Object.entries(EDITS?.b || {}).filter(([k, e]) => !e.gone && !built.has(Number(k))).map(([k]) => Number(k));
    process.send({ t: 'claims', id: m.id, list: out, missing });
  } else if (m?.t === 'check') process.send({ t: 'check', id: m.id, ...checkPlacement(Number(m.si), m.e || {}) });
  // The Godot client's copy of the map (server/gmap.js): packed once, written beside the other temp files.
  else if (m?.t === 'gmap') gmapFiles().then((dir) => process.send({ t: 'gmap', id: m.id, dir }), (e) => process.send({ t: 'gmap', id: m.id, error: String(e) }));
  else if (m?.t === 'nature') process.send({ t: 'nature', id: m.id, tiles: natureTiles(map, (m.tiles || []).filter((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isInteger)), map.felled) });
});
let gmapReady = null;
if (process.send && !process.env.NO_GMAP) setTimeout(() => gmapFiles().catch((e) => console.warn('Godot map:', e)), 8000).unref();   // ready before anyone asks
function gmapFiles() {
  gmapReady ??= new Promise((resolve, reject) => setImmediate(() => {
    try {
      const t0 = Date.now(), dir = path.join(os.tmpdir(), `deadzone-gmap-${WORLD_ID}-${MAP_SUM}`);
      if (!fs.existsSync(path.join(dir, 'meta.json.gz'))) {
        const pk = packMap(map, { seed: SEED, sum: String(MAP_SUM) });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'heights.d16.gz'), pk.heights);
        fs.writeFileSync(path.join(dir, 'colors.rgb.gz'), pk.colors);
        fs.writeFileSync(path.join(dir, 'meta.json.gz'), zlib.gzipSync(JSON.stringify(pk.meta), { level: 9 }));
        console.log(`Godot map packed in ${Date.now() - t0} ms`);
      }
      resolve(dir);
    } catch (e) { gmapReady = null; reject(e); }
  }));
  return gmapReady;
}
/** Would the world build building `si` where the editor's putting it? The same tests the world makes
 *  when it lays the county out (shared/world.js): on the map, on dry ground, not too steep, nothing in the way. */
const NATURE = new Set(['tree', 'pine', 'rock', 'boulder', 'bush', 'scrub', 'cactus', 'canopy', 'caveroof', 'cover', 'border']);
function checkPlacement(si, e) {
  const row = MERGED?.structures?.[si];
  if (!row) return { ok: false, why: 'There\'s no such building' };
  const p = { ...placement(row), ...e };
  if (![p.lat, p.lon, p.w, p.d, p.ang].every(Number.isFinite)) return { ok: false, why: 'Not a place' };
  const { x, z } = project(p.lat, p.lon, map.size);
  const w = Math.max(3, Math.min(120, p.w)), d = Math.max(3, Math.min(120, p.d)), a = p.ang * Math.PI / 180;
  const ex = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * d) / 2, ez = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * d) / 2;
  const minX = x - ex, maxX = x + ex, minZ = z - ez, maxZ = z + ez, half = map.size / 2;
  if (minX < -half + 30 || maxX > half - 30 || minZ < -half + 30 || maxZ > half - 30) return { ok: false, why: 'Too near the edge of the map' };
  const H = terrain.raw || terrain.exact;
  const hs = [H(minX, minZ), H(maxX, minZ), H(minX, maxZ), H(maxX, maxZ), H(x, z)];
  const lo = Math.min(...hs), hi = Math.max(...hs);
  if (lo <= 0.3) return { ok: false, why: 'It would be standing in water' };
  if (hi - lo >= 4 * RELIEF + 0.15 * Math.max(w, d)) return { ok: false, why: 'The ground there is too steep for it' };
  const self = map.buildings.find((b) => b.si === si);
  // (what's inside it now, its counter or its shelves, is made with it, so it doesn't count)
  const ownInside = (b) => self && (b.minX + b.maxX) / 2 > self.minX && (b.minX + b.maxX) / 2 < self.maxX && (b.minZ + b.maxZ) / 2 > self.minZ && (b.minZ + b.maxZ) / 2 < self.maxZ;
  const inWay = map.grid.rect(minX - 0.5, minZ - 0.5, maxX + 0.5, maxZ + 0.5, [], true).find((b) => !NATURE.has(b.type) && !(self && b.bldg === self.bldg) && !ownInside(b) && !(b.houseId == null && b.type === 'door'));
  if (inWay) {
    const other = map.buildings.find((q) => q.bldg === inWay.bldg);
    return { ok: false, why: other ? `It overlaps ${other.name || 'another building'}: the game would leave one of them out` : `It overlaps a ${inWay.type}` };
  }
  const home = map.houses.find((h) => Math.abs(h.x - x) < ex + 16 && Math.abs(h.z - z) < ez + 16);
  if (home) return { ok: false, why: 'Too close to one of the game\'s stash-house spots' };
  return { ok: true };
}
remapHouseClaims(db);
for (const h of map.houses) {
  db.houses[h.id] = { ...freshHouse(), ...(db.houses[h.id] || {}) };
  db.houses[h.id].upg = { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0, ...db.houses[h.id].upg };
}
db.structures ??= [];
db.boats ??= [];
db.crews ??= {};
db.lastSeen ??= {};   // login token -> when they were last online (fair raids)

/**
 * Stash houses are numbered by where they come in the map's list, and new real buildings (or any change
 * to the map data) can renumber that list. So each claimed home's save also notes where it stands, and
 * at start-up every claim is matched back to the home at that spot (the nearest of the same kind within
 * 8 m). A claim whose home is gone is set aside in db.lostHouses rather than landing on someone else's.
 */
function remapHouseClaims(d) {
  const saved = d.houses || {}, out = {}, taken = new Set();
  let moved = 0, lost = 0;
  for (const [id, st] of Object.entries(saved)) {
    if (!st?.owner) continue;
    const h = map.houses[id];
    if (!st.at) { if (h) { out[id] = st; taken.add(+id); } continue; }   // (saved before positions were kept: trust the number)
    const [ax, az, kind] = st.at;
    if (h && h.kind === kind && Math.hypot(h.x - ax, h.z - az) < 3) { out[id] = st; taken.add(+id); continue; }
    let best = null;
    for (const q of map.houses) {
      if (taken.has(q.id) || q.kind !== kind) continue;
      const dd = Math.hypot(q.x - ax, q.z - az);
      if (dd < 8 && (!best || dd < best.d)) best = { d: dd, q };
    }
    if (best) { out[best.q.id] = st; taken.add(best.q.id); moved++; }
    else { (d.lostHouses ??= []).push(st); lost++; }
  }
  for (const [id, st] of Object.entries(saved)) if (!st?.owner && !taken.has(+id) && map.houses[id]) out[id] ??= st;   // unclaimed state (doors) where it still fits
  d.houses = out;
  if (moved || lost) console.log(`Stash house claims matched to the map: ${moved} moved to their new numbers, ${lost} set aside (home gone)`);
}
function saveDb() {
  // Where each claimed home stands, so its claim survives a change to the map (see remapHouseClaims).
  for (const h of map.houses) { const st = db.houses[h.id]; if (st?.owner) st.at = [Math.round(h.x * 10) / 10, Math.round(h.z * 10) / 10, h.kind]; }
  for (const p of players.values()) { persistCharacter(p); db.lastSeen[p.token] = Date.now(); }
  db.crews = Object.fromEntries([...squads.values()].map((s) => [s.id, { ...s, officers: [...s.officers], members: [...s.members] }]));
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------- runtime state
const players = new Map();
const bots = new Map();
const loot = new Map();           // id -> { id, x, z, item, spawnIndex }
const lootAtSpawn = new Map();    // spawnIndex -> loot id
const spawnReadyAt = new Map(map.lootSpawns.map((_, i) => [i, 0]));
const terminalReadyAt = new Map(map.terminals.map((t) => [t.id, 0]));
const objectives = new Map();     // contract crates: id -> { id, x, z, contractId, owner }
const drops = new Map();          // supply drops: id -> { id, x, z, landsAt, expires }
const sensors = [];
const squads = new Map();        // crews: id -> { id, name, leader, officers: Set, members: Set, score, created }
const squadOfToken = new Map();
for (const c of Object.values(db.crews)) {
  const s = { ...c, officers: new Set(c.officers || []), members: new Set(c.members || []) };
  if (!s.members.size) continue;
  squads.set(s.id, s);
  for (const t of s.members) squadOfToken.set(t, s.id);
}
const invites = new Map();
const crewTickets = new Map();   // ticket -> { fromToken, fromName, expires }
let nextId = 1;
const uid = (p) => `${p}${nextId++}`;
let nextDropAt = Date.now() + Math.min(SUPPLY_EVERY_MS, 2 * 60_000);

// ---------------------------------------------------------------- world queries
const perksOf = (store) => homePerks(homeLevel(store.hxp || 0));
function doorMax(houseId) { const h = db.houses[houseId]; return DOOR_HP * UPGRADES.door.tiers[h.upg.door].hp * (h.owner ? perksOf(h).doorMul : 1) * (map.houses[houseId].kind === 'vehicle' ? 0.8 : 1); }
function stashCap(houseId) { const h = db.houses[houseId]; return UPGRADES.storage.tiers[h.upg.storage].slots + perksOf(h).storage; }
function doorBox(houseId) {
  const h = db.houses[houseId];
  if (h.doorHp <= 0 || h.doorOpen) return null;
  return { ...map.houses[houseId].door, type: 'door', houseId };
}
function doorsNear(x, z, r, out) {
  for (const h of map.houses) if (Math.abs(h.x - x) < r + 8 && Math.abs(h.z - z) < r + 8) { const d = doorBox(h.id); if (d) out.push(d); }
  return out;
}
function solidsNear(x, z, r) { return structSolids(x, z, r, doorsNear(x, z, r, grid.near(x, z, r))); }
function solidsAlongRay(ox, oz, dx, dz, dist) {
  const out = grid.ray(ox, oz, dx, dz, dist);
  const mx = ox + dx * dist / 2, mz = oz + dz * dist / 2;
  return structSolids(mx, mz, dist / 2 + 4, doorsNear(mx, mz, dist / 2 + 2, out));
}
/** Clear line between two points: no boxes, structures, doors or terrain in the way. */
function lineOfSight(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  const ux = dx / d, uy = dy / d, uz = dz / d;
  if (rayAgainstBoxes(ax, ay, az, ux, uy, uz, solidsAlongRay(ax, az, ux, uz, d), d).t < d - 0.05) return false;
  return terrain.ray(ax, ay, az, ux, uy, uz, d - 0.3) === Infinity;
}

// ---------------------------------------------------------------- player-built structures
const structs = new Map();
const structCells = new Map();
const sKey = (x, z) => Math.floor((x + map.half) / 32) * 65536 + Math.floor((z + map.half) / 32);
function indexStruct(s, add) {
  const k = sKey(s.x, s.z);
  if (add) { if (!structCells.has(k)) structCells.set(k, new Set()); structCells.get(k).add(s.id); structs.set(s.id, s); }
  else { structCells.get(k)?.delete(s.id); structs.delete(s.id); }
}
for (const s of db.structures) indexStruct(s, true);
function structsNear(x, z, r) {
  const out = [];
  const c0 = Math.floor((x - r - 3 + map.half) / 32), c1 = Math.floor((x + r + 3 + map.half) / 32);
  const d0 = Math.floor((z - r - 3 + map.half) / 32), d1 = Math.floor((z + r + 3 + map.half) / 32);
  for (let i = c0; i <= c1; i++) for (let j = d0; j <= d1; j++) {
    const set = structCells.get(i * 65536 + j);
    if (set) for (const id of set) { const s = structs.get(id); if (Math.abs(s.x - x) < r + 3 && Math.abs(s.z - z) < r + 3) out.push(s); }
  }
  return out;
}
const stageDef = (s) => PIECES[s.type].stages[s.stage];
function structBox(s) { return structureBox(s, { type: 'struct', structId: s.id }); }
/** Frames are walk-through scaffolding; open gates let you pass; charges aren't solid. */
function structIsSolid(s) { return stageDef(s).material !== 'frame' && stageDef(s).material !== 'wire' && !PIECES[s.type].explosive && !(PIECES[s.type].door && s.open); }
function structSolids(x, z, r, out = []) {
  for (const s of structsNear(x, z, r)) if (structIsSolid(s)) out.push(structBox(s));
  return out;
}
function canManage(p, s) { return s.owner === p.token || tokenInSquadWith(p, s.owner); }
function hasTool(p, tool) { return p.inv.pack.some((i) => i.kind === 'tool' && i.tool === tool); }
function boxDist(b, x, z) { return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ)); }
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

// ---------------------------------------------------------------- characters
function starterKit() {
  return { primary: null, primary2: null, secondary: makeWeapon('sidearm'), armor: null, pack: [makeConsumable('medkit')] };
}
function starterLoadout() {
  const inv = starterKit();
  return { inv, ammo: 90, parts: 0, tech: 0, intel: 0, salvage: 0, mags: { [inv.secondary.id]: weaponStats(inv.secondary).mag }, active: 'secondary' };
}
const WEAR = RAIDS.toolWear;
const makeTool = (tool) => ({ id: uid('t'), kind: 'tool', tool, name: TOOLS[tool].name, ...(WEAR[tool] ? { dur: WEAR[tool], maxDur: WEAR[tool] } : {}) });
/** Hatchets and pickaxes wear out: raid hits and harvests use them up, and at 0 they break. */
function wearTool(p, tool, n) {
  const it = p.inv.pack.find((i) => i.kind === 'tool' && i.tool === tool);
  if (!it || !WEAR[tool]) return;
  it.maxDur ??= WEAR[tool]; it.dur ??= it.maxDur;
  it.dur -= n;
  if (it.dur <= 0) { p.inv.pack = p.inv.pack.filter((i) => i !== it); toast(p, `Your ${it.name.toLowerCase()} broke. Craft or buy another.`); }
  else if (it.dur <= n * 2) toast(p, `Your ${it.name.toLowerCase()} is nearly worn out`);
  dirty(p);
}
/** The testing kit: top up whatever is missing (never takes anything away). */
function devKit(p) {
  if (!DEV_KIT) return;
  p.xp = Math.max(p.xp || 0, xpForLevel(MAX_LEVEL));
  p.rockets = Math.max(p.rockets || 0, COMBAT.rocket.devKit);
  const field = new Set(p.field || []);
  for (const table of [PARTS, PAINTS, ARMORS]) for (const [id, d] of Object.entries(table)) if (d.field) field.add(id);
  for (const id of Object.keys(FIELD_PERKS)) field.add(id);
  p.field = [...field];
  const atLeast = { cash: 5000, ammo: 900, parts: 600, tech: 400, intel: 5, salvage: 400, wood: 400, stone: 400, comms: 20 };
  for (const g of GOODS) if (g !== 'cash') atLeast[g] = 20;
  for (const [k, v] of Object.entries(atLeast)) p[k] = Math.max(p[k] || 0, v);
  // One of every gun: carbine, marksman rifle and sidearm in hand, the rest in the pack.
  const inv = p.inv;
  inv.primary ??= makeWeapon('carbine');
  inv.primary2 ??= makeWeapon('dmr');
  inv.secondary ??= makeWeapon('sidearm');
  inv.armor ??= makeArmor('heavy');
  const all = () => [inv.primary, inv.primary2, inv.secondary, inv.armor, ...inv.pack].filter(Boolean);
  for (const a of Object.keys(ARCHETYPES)) for (const m of MODELS[a] ? Object.keys(MODELS[a]) : [undefined]) if (!all().some((i) => i.kind === 'weapon' && i.archetype === a && (!m || modelOf(i) === m))) inv.pack.push(makeWeapon(a, {}, 'factory', m));   // every real gun too
  for (const a of Object.keys(ARMORS)) if (!all().some((i) => i.kind === 'armor' && i.type === a)) inv.pack.push(makeArmor(a));
  const upTo = (n, test, make) => { for (let k = inv.pack.filter(test).length; k < n; k++) inv.pack.push(make()); };
  upTo(3, (i) => i.kind === 'medkit', () => makeConsumable('medkit'));
  upTo(2, (i) => i.kind === 'ammo', () => makeConsumable('ammo'));
  upTo(3, (i) => i.kind === 'flare', makeFlare);
  upTo(3, (i) => i.kind === 'charge', () => ({ id: uid('c'), kind: 'charge', name: 'Breach Charge' }));
  for (const t of Object.keys(TOOLS)) upTo(1, (i) => i.kind === 'tool' && i.tool === t, () => makeTool(t));
  if (!claimOf(p)) upTo(1, (i) => i.kind === 'marker', makeMarker);
  for (const w of all()) if (w.kind === 'weapon') p.mags[w.id] = Math.max(p.mags[w.id] ?? 0, weaponStats(w).mag);
  if (inv.pack.length > PACK_SIZE) inv.pack.length = PACK_SIZE;
  p.armor = Math.max(p.armor || 0, maxArmor(p));
}
function newCharacter(name) {
  const kit = starterLoadout();
  kit.inv.pack.push(makeTool('hammer'), makeTool('hatchet'), makeMarker());
  return {
    name, x: 0, z: 0, yaw: 0, hp: 100, armor: 0, ...kit, parts: 60, tech: 20, wood: 20, cash: ECONOMY.startingCash, food: HOMESTEAD.hunger.start, dead: false, kills: 0, xp: 0,
    comms: 0, field: [], discovered: [], contracts: [], needsDeploy: true,
  };
}
function ownedHouse(token) {
  const e = Object.entries(db.houses).find(([, h]) => h.owner === token);
  return e ? Number(e[0]) : null;
}
const makeMarker = () => ({ id: uid('m'), kind: 'marker', name: 'Claim marker' });
const hasMarker = (p) => p.inv.pack.some((i) => i.kind === 'marker');
const takeMarker = (p) => { const i = p.inv.pack.findIndex((x) => x.kind === 'marker'); if (i >= 0) p.inv.pack.splice(i, 1); return i >= 0; };
/**
 * Your stash house claim: a home/room/vehicle (kind 'home') or a claim flag on open ground
 * (kind 'flag'). Both hold the stash, gunsmith, upgrades and home level.
 */
function claimWhere(test) {
  for (const [idStr, h] of Object.entries(db.houses)) if (h.owner && test(h)) { const hid = Number(idStr), d = map.houses[hid]; return { kind: 'home', id: hid, store: h, x: d.crate.x, z: d.crate.z, def: d }; }
  for (const st of structs.values()) if (PIECES[st.type].claim && test(st)) return { kind: 'flag', id: st.id, store: st, x: st.x, z: st.z };
  return null;
}
/** The crew's shared stash house, if the crew has one. */
function crewClaim(crewId) { return crewId ? claimWhere((st) => st.crew === crewId) : null; }
/**
 * The stash house a player uses: their crew's shared one if they're in a crew, otherwise their own.
 * A claim you made before joining a crew that already had one stays yours, dormant, for if you leave.
 */
function claimOfToken(token) {
  const crewId = squadOfToken.get(token);
  if (crewId) return crewClaim(crewId);
  return claimWhere((st) => st.owner === token && !st.crew);
}
/** Everyone who should hear about something happening at a stash house: its crew, or its owner. */
function storeTeam(store) {
  const s = store.crew && squads.get(store.crew);
  if (s) return crewOnline(s);
  const o = onlineByToken(store.owner);
  return o ? [o] : [];
}
/** A player and their online crewmates (by login token; works when the player is offline). */
function teamOfToken(token) { const s = squads.get(squadOfToken.get(token)); if (s) return crewOnline(s); const o = onlineByToken(token); return o ? [o] : []; }
function notifyStore(store, text) { for (const o of storeTeam(store)) toast(o, text); }
const storeOwnerLabel = (store) => (store.crew && squads.get(store.crew) ? squads.get(store.crew).name : store.ownerName);
const claimOf = (p) => claimOfToken(p.token);
function claimName(c) {
  if (!c) return null;
  if (c.kind === 'flag') return c.store.building != null ? buildingLabel(c.store.building) : 'Claim flag';
  const h = c.def;
  const base = h.kind === 'vehicle' ? VEHICLE_TYPES[h.vtype].name : HOME_KINDS[h.kind].name;
  return `${base} — ${homeLabel(c.id).replace(/^.*? (in|near) /, '')}`;
}
function claimCap(c) { return c.kind === 'home' ? stashCap(c.id) : UPGRADES.storage.tiers[c.store.upg.storage].slots - 6 + perksOf(c.store).storage; }
function flagMax(st) { return CLAIM.flagHp * UPGRADES.door.tiers[st.upg?.door || 0].hp * perksOf(st).doorMul; }
function refreshClaim(c) { if (c) refreshContainerViewers(c.kind === 'home' ? 'stash' : 'crate', c.id); }
/** Home XP; announces home level-ups to the owner. */
function addHomeXp(c, n, reason) {
  if (!c || !n) return;
  const before = homeLevel(c.store.hxp || 0);
  c.store.hxp = (c.store.hxp || 0) + n;
  const after = homeLevel(c.store.hxp);
  for (const o of storeTeam(c.store)) {
    send(o.ws, { t: 'homexp', amount: n, reason });
    if (after > before) send(o.ws, { t: 'homeLevel', level: after });
    dirty(o);
  }
  if (after > before) feed(`${storeOwnerLabel(c.store)}'s stash house reached level ${after}`);
  if (after > before && c.kind === 'home') db.houses[c.id].doorHp = Math.min(doorMax(c.id), db.houses[c.id].doorHp * (homePerks(after).doorMul / homePerks(before).doorMul));
}
function claimSummary(p) {
  const c = claimOf(p);
  if (!c) return null;
  const xp = c.store.hxp || 0, lvl = homeLevel(xp);
  return { kind: c.kind, id: c.id, name: claimName(c), x: c.x, z: c.z, level: lvl, xp: Math.floor(xp), perks: homePerks(lvl), crew: c.store.crew ? squads.get(c.store.crew)?.name || null : null, raid: raidSummary(c.store), ruined: !!c.store.ruined };
}
function startClaim(p, houseId) {
  if (claimOf(p)) return toast(p, squadOf(p) ? 'Your crew already has a stash house. An officer can abandon it from its stash menu.' : 'You already have a stash house. Abandon it (from its stash menu) before claiming another.');
  if (!hasMarker(p)) return toast(p, 'Unclaimed — plant a claim marker here to make it your stash house (craft one, find one, or buy one from a Contact)');
  startHack(p, 'claim', houseId);
}
function finishClaim(p, houseId) {
  const h = db.houses[houseId];
  if (h.owner) return send(p.ws, { t: 'hack', done: true, text: 'Someone else claimed it first' });
  if (claimOf(p) || !takeMarker(p)) return send(p.ws, { t: 'hack', done: true, text: 'Claim failed' });
  // Whatever the last owner left behind stays in the stash.
  Object.assign(h, { owner: p.token, ownerName: p.name, crew: squadOf(p)?.id || null, hxp: 0, upg: { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0 }, doorOpen: false });
  h.doorHp = doorMax(houseId);
  p.houseId = houseId;
  feed(`${p.name} claimed a ${homeLabel(houseId)}`);
  send(p.ws, { t: 'hack', done: true, text: `Claimed! This ${claimName(claimOf(p))} is now your stash house (level 1).` });
  send(p.ws, { t: 'claimed' });
  const crew = squadOf(p);
  if (crew) for (const m of crewOnline(crew)) { if (m !== p) { toast(m, `${p.name} claimed a stash house for ${crew.name}`); send(m.ws, { t: 'claimed' }); } dirty(m); }
  dirty(p);
}
function abandonClaim(p) {
  const c = claimOf(p);
  if (!c || !atOwnStash(p)) return toast(p, 'Abandon your stash house from inside it');
  const crew = squadOf(p);
  if (crew && rankOf(crew, p.token) === 'member') return toast(p, 'Only the crew leader or an officer can abandon the crew stash house');
  if (c.kind === 'home') { Object.assign(c.store, { owner: null, ownerName: null, crew: null, hxp: 0 }); p.houseId = null; }
  else removeStruct(c.store, false);
  toast(p, 'Stash house abandoned — anything left inside is up for grabs');
  if (crew) for (const m of crewOnline(crew)) { if (m !== p) toast(m, `${p.name} abandoned the crew stash house`); dirty(m); }
  p.openContainer = null;
  send(p.ws, { t: 'container', closed: true });
  dirty(p);
}
function maxHp() { return 100; }
function maxArmor(p) { return armorStats(p.inv.armor).armor; }
const ARCHETYPE_KEYS = ['sidearm', 'smg', 'carbine', 'shotgun', 'dmr', 'lmg'];
// Every player carries two main guns and a sidearm: 'primary', 'primary2' and 'secondary' (the sidearm).
const GUN_SLOTS = ['primary', 'primary2', 'secondary'];
function activeWeapon(p) { return p.inv[p.active] || p.inv.primary || p.inv.primary2 || p.inv.secondary || null; }
/** The guns you're carrying but not holding (slung on your back, or the sidearm in its holster). */
function stowedGuns(p) { return GUN_SLOTS.filter((s) => s !== p.active && p.inv[s]).map((s) => ({ slot: s, a: p.inv[s].archetype, m: modelOf(p.inv[s]) || undefined, parts: p.inv[s].parts, paint: p.inv[s].paint })); }
function stats(p) { return weaponStats(activeWeapon(p)); }
function level(p) { return levelFromXp(p.xp || 0); }
function hasField(p, id) { return (p.field || []).includes(id); }

function award(p, amount, reason, share = false) {
  if (!p || p.isBot || !amount) return;
  if (share) {
    for (const m of squadMembersOnline(p)) {
      if (m !== p && !m.dead && Math.hypot(m.x - p.x, m.z - p.z) < 50) award(m, Math.round(amount * XP.squadShare), `Squad: ${reason}`);
    }
  }
  const before = level(p);
  p.xp = (p.xp || 0) + amount;
  const crew = squadOf(p);
  if (crew) crew.score = (crew.score || 0) + amount;   // crew score: XP members earn together
  const after = level(p);
  send(p.ws, { t: 'xp', amount, reason });
  for (let l = before + 1; l <= after; l++) {
    send(p.ws, { t: 'levelup', level: l, unlocks: unlocksAt(l) });
    feed(`${p.name} reached level ${l}`);
  }
  dirty(p);
}

const PERSIST = ['deaths', 'diedAt', 'deathSpot', 'crewDropAt', 'shieldOff', 'selfReviveAt', 'name', 'x', 'z', 'yaw', 'hp', 'armor', 'inv', 'ammo', 'mags', 'active', 'dead', 'kills', 'xp', 'comms', 'field', 'discovered', 'contracts', 'needsDeploy', 'food', 'hotLoose', 'look', ...RESOURCES];
function persistCharacter(p) { db.characters[p.token] = { ...Object.fromEntries(PERSIST.map((k) => [k, p[k]])), awayLog: db.characters[p.token]?.awayLog || [] }; }

// ---------------------------------------------------------------- networking helpers
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function feed(text) { broadcast({ t: 'feed', text }); }
function toast(p, text) { send(p.ws, { t: 'toast', text }); }
function dirty(p) { p.dirty = true; }

function privateState(p) {
  const w = activeWeapon(p);
  return {
    t: 'you', hp: p.hp, maxHp: maxHp(p), armor: p.armor, maxArmor: maxArmor(p), ammo: p.ammo,
    mag: w ? (p.mags[w.id] ?? 0) : 0, inv: p.inv, active: p.active, dead: p.dead, kills: p.kills,
    xp: p.xp, level: level(p), ...Object.fromEntries(RESOURCES.map((r) => [r, p[r] || 0])), comms: p.comms,
    field: p.field, discovered: p.discovered, atStash: atOwnStash(p),
    hideouts: hideoutsOf(p).map((st, i) => ({ id: st.id, n: i + 1, x: Math.round(st.x), z: Math.round(st.z) })), hideoutsAllowed: hideoutAllowance(p).allowed, hideoutNext: hideoutAllowance(p).next,
    reloading: p.reloadUntil > Date.now(), houseId: claimOf(p)?.kind === 'home' ? claimOf(p).id : null, claim: claimSummary(p),
    taserOut: !!p.taserOut, taserReadyAt: p.taserReadyAt || 0, camoOn: !!p.camoOn, camoActive: camoActive(p), camoUntil: p.camoOn ? p.camoUntil || 0 : 0, camoReadyAt: p.camoReadyAt || 0, sensorReadyAt: p.sensorReadyAt || 0, rallyReadyAt: p.rallyReadyAt || 0,
    buffUntil: p.buffUntil || 0, protectedUntil: p.protectedUntil || 0, deploying: !!p.deploying, hotLoose: !!p.hotLoose,
    food: Math.round(p.food ?? 0), foodMax: HOMESTEAD.hunger.max,
    boat: p.boat ? { id: p.boat, seat: p.seat } : null,
    shield: shielded(p), shieldLevel: SHIELD_LEVEL, selfRevive: !!p.downed && soloRevive(p),
    downed: !!p.downed, downedUntil: p.downedUntil || 0, stunnedUntil: p.stunnedUntil || 0, stunReadyAt: p.stunReadyAt || 0, bleed: p.downed ? Math.max(0, Math.round(p.bleedHp)) : 0,
  };
}

// ---------------------------------------------------------------- fair raids
// Each home has a raid window its owner picks. While anyone who lives there is online (or was in the
// last 15 minutes) the base can be attacked at full strength: they can come and defend it. Once the
// whole crew is offline, outside the window it's sealed, and inside it it takes reduced damage. A
// raid can carry off only a share of a stash. Numbers: shared/data/stash.json "raids".
const RAID_PROTECTION = process.env.RAID_PROTECTION !== '0';
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS || RAIDS.offlineAfterMs);
const RAID_CHANGE_MS = Number(process.env.RAID_CHANGE_MS ?? RAIDS.changeDelayMs);
const RS_CODE = { home: 0, window: 1, sealed: 2 };
/** The window start hour (county time) in force for a home. A newly picked one waits changeDelayMs. */
function raidStart(store, now = Date.now()) {
  const w = store.raidWin;
  if (!w) return RAIDS.defaultStartHour;
  if (w.next != null && now >= w.nextAt) { w.start = w.next; w.next = null; w.nextAt = 0; }
  return w.start ?? RAIDS.defaultStartHour;
}
/** Everyone who lives at a home: its crew, or its owner. */
function storeTokens(store) { const s = store.crew && squads.get(store.crew); return s ? [...s.members] : store.owner ? [store.owner] : []; }
function tokenHome(t, now) { return !!onlineByToken(t) || now - (db.lastSeen[t] || 0) < OFFLINE_AFTER_MS; }
/** How a home stands right now: someone's home (full damage), everyone away inside the window (reduced), or sealed. */
function raidState(store, now = Date.now()) {
  const start = raidStart(store, now);
  if (!RAID_PROTECTION || !store.owner || storeTokens(store).some((t) => tokenHome(t, now))) return { mode: 'home', mul: 1, start };
  if (windowOpen(start, now)) return { mode: 'window', mul: RAIDS.offlineMul, start };
  return { mode: 'sealed', mul: 0, start };
}
const rsCache = new WeakMap();   // store -> raid state, refreshed every second (snapshots read it)
const cachedRaidState = (store) => rsCache.get(store) || raidState(store);
const baseCache = new WeakMap();
/** The home a structure belongs to: the flag or locker itself, a claimed building's doors, or anything its people built inside the claim radius. */
function baseOf(st, now = Date.now()) {
  if (PIECES[st.type].claim) return st;
  if (st.claimOf) return structs.get(st.claimOf) || null;
  const hit = baseCache.get(st);
  if (hit && now - hit.at < 2000) return hit.base;
  const c = claimOfToken(st.owner);
  const base = c && Math.hypot(st.x - c.x, st.z - c.z) <= homePerks(homeLevel(c.store.hxp || 0)).radius ? c.store : null;
  baseCache.set(st, { base, at: now });
  return base;
}
const livesAt = (p, store) => storeTokens(store).some((t) => t === p.token || tokenInSquadWith(p, t));
function sealedNote(p, rs) {
  const now = Date.now();
  if (!p || p.isBot || now - (p.sealedNote || 0) < 4000) return;
  p.sealedNote = now;
  toast(p, rs.mode === 'sealed'
    ? `🔒 Sealed: everyone who lives here is offline, and their raid window is ${windowText(rs.start)} (county time)`
    : `Everyone here is offline: inside their raid window the base takes only ${Math.round(rs.mul * 100)}% damage`);
}
/** Damage scale for an attack on a base (1 if it's yours, or nobody's). Attacking ends a new-player shield. */
function raidMul(store, by, now = Date.now()) {
  if (!store || !store.owner || (by && !by.isBot && livesAt(by, store))) return 1;
  if (by && !by.isBot) dropShield(by);
  const rs = raidState(store, now);
  if (rs.mul < 1) sealedNote(by, rs);
  return rs.mul;
}
/** Damage to a stash house door (shots and charges). */
function damageHouseDoor(houseId, dmg, by, how = 'breached') {
  const h = db.houses[houseId];
  if (h.doorHp <= 0) return;
  dmg *= raidMul(h, by);
  if (dmg <= 0) return;
  h.doorHp = Math.max(0, h.doorHp - dmg);
  h.lastDamaged = Date.now();
  const who = by ? by.name : 'Someone';
  if (h.doorHp === 0) {
    if (by && !by.isBot && h.owner !== by.token) award(by, XP.breach, 'Stash house breached', true);
    feed(`${who} ${how} ${h.ownerName || 'an unclaimed'}'s stash house`);
    notifyOwner(houseId, `⚠ Your stash house door was ${how} by ${who}!`);
    if (h.owner) logAway(h.owner, `${who} ${how} your stash house door`);
  } else if (!h.alertedAt || Date.now() - h.alertedAt > 30_000) {
    h.alertedAt = Date.now();
    notifyOwner(houseId, `⚠ ${who} is attacking your stash house door!`);
  }
}
/**
 * What someone may still carry off from another's stash or crate in this raid: null if there's no
 * limit (it's theirs, or nobody's), false if it's sealed (and tells them). A raid gets a share of
 * what was there when it started, counted once a day.
 */
function raidCap(p, kind, store, commit = true) {
  let base;
  if (kind === 'stash') { if (!store.owner || livesAt(p, store)) return null; base = store; }
  else if (kind === 'crate') { if (canManage(p, store)) return null; base = baseOf(store); }
  else return null;
  const now = Date.now();
  const rs = base ? raidState(base, now) : { mode: 'home', start: RAIDS.defaultStartHour };
  if (rs.mode === 'sealed') { if (commit) { sealedNote(p, rs); return false; } return { sealed: true, start: rs.start, items: 0, res: {} }; }
  let r = store.raidTake;
  if (!r || now - r.since > RAIDS.takeResetMs) {
    const share = rs.mode === 'home' ? RAIDS.takeShareOnline : RAIDS.takeShare;
    r = { since: now, share, items: Math.max(1, Math.ceil(store.items.length * share)), res: Object.fromEntries(RESOURCES.map((k) => [k, Math.floor((store[k] || 0) * share)])) };
    if (commit) store.raidTake = r;
  }
  if (commit) { dropShield(p); return r; }
  return { ...r, start: rs.start, mode: rs.mode };
}
function raidView(p, kind, store) {
  const r = raidCap(p, kind, store, false);
  if (!r) return null;
  return { sealed: !!r.sealed, items: Math.max(0, r.items), res: r.res, share: r.share || 0, window: windowText(r.start), mode: r.mode || 'sealed' };
}
/** Pick a new raid window (leader or officer, at the stash). It takes effect after changeDelayMs. */
function setRaidWindow(p, msg) {
  const c = claimOf(p);
  if (!c || !atOwnStash(p)) return toast(p, 'Set your raid window from your stash');
  const crew = squadOf(p);
  if (crew && rankOf(crew, p.token) === 'member') return toast(p, 'Only the crew leader or an officer can change the raid window');
  const start = Number(msg.start);
  if (!Number.isInteger(start) || start < 0 || start > 23) return;
  const now = Date.now();
  const cur = raidStart(c.store, now);
  c.store.raidWin ??= { start: cur, next: null, nextAt: 0 };
  if (start === cur) { c.store.raidWin.next = null; c.store.raidWin.nextAt = 0; toast(p, `Raid window stays ${windowText(cur)}`); }
  else {
    c.store.raidWin.next = start; c.store.raidWin.nextAt = now + RAID_CHANGE_MS;
    raidStart(c.store, now);
    toast(p, RAID_CHANGE_MS > 0 ? `Raid window changes to ${windowText(start)} in ${Math.round(RAID_CHANGE_MS / 3_600_000)} hours` : `Raid window is now ${windowText(start)}`);
  }
  for (const o of storeTeam(c.store)) dirty(o);
  refreshClaim(c);
}
function raidSummary(store) {
  const w = store.raidWin, now = Date.now();
  return { start: raidStart(store, now), next: w?.next ?? null, nextAt: w?.nextAt || 0, hours: RAIDS.windowHours, mode: raidState(store, now).mode, offlineMul: RAIDS.offlineMul, share: RAIDS.takeShare, shareOnline: RAIDS.takeShareOnline };
}
/** Lock tier of a door or gate (0-3): longer and dearer to bypass the better it is. */
function doorTier(kind, id) {
  if (kind === 'door') return Math.min(3, db.houses[id].upg.door || 0);
  const st = structs.get(id);
  if (!st) return 0;
  const claim = st.claimOf && structs.get(st.claimOf);
  return Math.min(3, Math.max(claim ? claim.upg?.door || 0 : 0, st.type === 'door' ? st.stage : Math.max(0, st.stage - 1)));
}
function bypassOf(kind, id) { const t = doorTier(kind, id); return { tier: t, ms: RAIDS.lockBypass.ms[t], tech: RAIDS.lockBypass.tech[t] }; }
const TIER_NAMES = ['basic', 'steel', 'blast', 'vault'];

// ---------------------------------------------------------------- new-player shield
const SHIELD_LEVEL = Number(process.env.SHIELD_UNTIL_LEVEL ?? COMBAT.newPlayerShield.untilLevel);
/** Below level 5, other players can't hurt you, until you attack someone (that ends it for good). */
function shielded(c) { return !!c && !c.isBot && !!c.token && !c.shieldOff && level(c) < SHIELD_LEVEL && !inHotZone(c); }
function dropShield(p) {
  if (!shielded(p)) return;
  p.shieldOff = true;
  toast(p, '🛡 Your new-player shield is off: you attacked someone. Other players can hurt you now.');
  dirty(p);
}
/** A player hurting a player: false if the target is shielded (and says so). Ends the attacker's own shield. */
function pvpAllowed(attacker, target) {
  if (!attacker || attacker.isBot || !attacker.token || !target?.token || target.isBot || attacker === target) return true;
  if (shielded(target)) {
    const now = Date.now();
    if (now - (attacker.shieldNote || 0) > 4000) { attacker.shieldNote = now; toast(attacker, `🛡 ${target.name} is new (below level ${SHIELD_LEVEL}) and shielded until they attack someone`); }
    return false;
  }
  dropShield(attacker);
  return true;
}

// ---------------------------------------------------------------- claiming any building
// Plant a claim marker inside any enterable building: a stash locker goes in, and every doorway gets
// a lockable door. It then works like a claim flag (stash, gunsmith, upgrades, home level) and the
// doors can be shot, hacked, chopped or blown like gates.
const buildingGrid = new SpatialGrid(map.half + 4, 64);
map.buildings.forEach((b, i) => { b.idx = i; buildingGrid.insert(b); });
function buildingAt(x, z) {
  for (const b of buildingGrid.near(x, z, 1)) if (insideBuilding(b, x, z, 0.3)) return b.idx;
  return -1;
}
const BUILDING_NAMES = { building: 'Building', warehouse: 'Warehouse', farmhouse: 'Farmhouse', barn: 'Barn', home: 'House', civic: 'Hall' };
function buildingLabel(idx) {
  const b = map.buildings[idx], cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const near = map.towns.reduce((a, t) => (!a || Math.hypot(t.x - cx, t.z - cz) < Math.hypot(a.x - cx, a.z - cz) ? t : a), null);
  const inTown = near && cx > near.rect.minX && cx < near.rect.maxX && cz > near.rect.minZ && cz < near.rect.maxZ;
  if (b.name) return b.name;   // a real landmark keeps its real name
  return `${BUILDING_NAMES[b.type] || 'Building'} ${inTown ? 'in' : 'near'} ${near ? near.name : 'the wilds'}`;
}
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
// A claimed building is found again by where its stash locker stands, so a later change to the map
// data (which can renumber the buildings) doesn't hand someone a different house.
for (const st of db.structures) if (st.type === 'locker' && st.building != null) { const idx = buildingAt(st.x, st.z); if (idx >= 0) st.building = idx; }
function buildingClaimant(idx) { for (const st of structs.values()) if (PIECES[st.type].claim && st.building === idx) return st; return null; }
// Loot spots inside a claimed building stop restocking: it's someone's home now.
const spawnBuilding = map.lootSpawns.map((sp) => (sp.indoor ? buildingAt(sp.x, sp.z) : -1));
function startClaimBuilding(p, idx) {
  if (NO_CLAIM.has(idx)) return toast(p, NO_CLAIM.get(idx));
  const held = buildingClaimant(idx);
  if (held) return toast(p, `${storeOwnerLabel(held)} holds this building — break in through a door`);
  if (claimOf(p)) return toast(p, squadOf(p) ? 'Your crew already has a stash house' : 'You already have a stash house. Abandon it before claiming another.');
  if (!hasMarker(p)) return toast(p, 'Claim this building with a claim marker (craft one, find one, or buy one from a Contact)');
  startHack(p, 'claimBuilding', idx);
}
function finishClaimBuilding(p, idx) {
  const b = map.buildings[idx];
  if (buildingClaimant(idx)) return send(p.ws, { t: 'hack', done: true, text: 'Someone else claimed it first' });
  if (claimOf(p) || !hasMarker(p)) return send(p.ws, { t: 'hack', done: true, text: 'Claim failed' });
  // Find a spot for the locker: near where you stand, clear of walls and doorways.
  const fits = (x, z) => {
    const lb = pieceBox('locker', x, z, 0);
    if (![[lb.minX, lb.minZ], [lb.maxX, lb.minZ], [lb.minX, lb.maxZ], [lb.maxX, lb.maxZ]].every(([cx, cz]) => insideBuilding(b, cx, cz, 0.35))) return false;
    if (b.doors.some((d) => Math.hypot(d.x - x, d.z - z) < 2.6)) return false;
    return !solidsNear(x, z, 2).some((o) => (o.y0 ?? 0) < terrain.height(x, z) + 2 && lb.maxX > o.minX && lb.minX < o.maxX && lb.maxZ > o.minZ && lb.minZ < o.maxZ);
  };
  let spot = null;
  for (let r = 0; r <= 8 && !spot; r += 0.75) for (let a = 0; a < 12 && !spot; a++) { const x = p.x + Math.cos(a / 12 * Math.PI * 2) * r, z = p.z + Math.sin(a / 12 * Math.PI * 2) * r; if (fits(x, z)) spot = { x, z }; }
  if (!spot) return send(p.ws, { t: 'hack', done: true, text: 'No room for a stash locker here — try another spot inside' });
  takeMarker(p);
  const crew = squadOf(p)?.id || null;
  const mk = (type, x, z, rot, extra) => {
    const st = { id: 's' + crypto.randomBytes(5).toString('hex'), type, x, z, rot, y0: terrain.height(x, z) - 0.05, stage: 0, hp: PIECES[type].stages[0].hp, owner: p.token, ownerName: p.name, open: false, ...extra };
    db.structures.push(st);
    indexStruct(st, true);
    return st;
  };
  const locker = mk('locker', spot.x, spot.z, 0, { building: idx, crew, hxp: 0, items: [], ...Object.fromEntries(RESOURCES.map((r) => [r, 0])), upg: { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0 } });
  locker.hp = flagMax(locker);
  // Each doorway gets a door, turned to match the real wall it sits in.
  for (const d of b.doors) {
    const sn = Math.sin(d.ang ?? 0), cs = Math.cos(d.ang ?? 0);
    if (d.ang === undefined || Math.abs(sn) < 0.01 || Math.abs(cs) < 0.01) mk('door', d.x, d.z, d.ang === undefined ? (d.out[0] === 0 ? 0 : 1) : Math.abs(sn) < 0.01 ? 0 : 1, { claimOf: locker.id });
    else mk('door', d.x, d.z, 0, { claimOf: locker.id, ang: d.ang });
  }
  placeAt(p, p.x, p.z);   // step out of the locker if it went in where you stood
  locker.spawn = { x: p.x, z: p.z };
  feed(`${p.name} claimed a ${lowerFirst(buildingLabel(idx))}`);
  send(p.ws, { t: 'hack', done: true, text: `Claimed! This ${lowerFirst(buildingLabel(idx))} is now your stash house: stash locker inside, ${b.doors.length} lockable door${b.doors.length > 1 ? 's' : ''}.` });
  send(p.ws, { t: 'claimed' });
  const s = squadOf(p);
  if (s) for (const m of crewOnline(s)) { if (m !== p) { toast(m, `${p.name} claimed a ${lowerFirst(buildingLabel(idx))} for ${s.name}`); send(m.ws, { t: 'claimed' }); } dirty(m); }
  dirty(p);
}


// ================================================================ the living world
// World events that pull people across the map, NPCs who travel and trade, player commerce, and
// defenses that guard your stuff while you're offline. Numbers live in shared/data/world.json.
const EV = LIVING.events, NPC = LIVING.npcs, COM = LIVING.commerce, DEF = LIVING.defenses;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const townContact = (t) => map.contacts.find((c) => c.townId === t.id);

// ---- offline log: what happened to your stuff while you were away
function teamTokensOf(token) { const s = squads.get(squadOfToken.get(token)); return s ? [...s.members] : [token]; }
function logAway(ownerToken, text, alert = true) {
  const now = Date.now();
  for (const tok of teamTokensOf(ownerToken)) {
    const online = onlineByToken(tok);
    if (online) continue;   // online crewmates get toasts instead
    const c = db.characters[tok];
    if (!c) continue;
    c.awayLog = [...(c.awayLog || []), { at: now, text }].slice(-DEF.logMax);
    if (alert) pushTo(tok, text);
  }
}
// ---- phone notifications (Web Push): your base is under attack and you're not in the game.
// Each device that turned base alerts on is a subscription, kept with your character. At most one
// notification every PUSH_EVERY_MS per player, so a raid doesn't bury your phone.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || null;
let pushReady = false;
{
  let pub = VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; process.env.VAPID_PUBLIC_KEY = pub; }   // run alone (tests): keys for this run
  try { webpush.setVapidDetails(process.env.VAPID_SUBJECT || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'deadzone.game'}`, pub, priv); pushReady = true; } catch (e) { console.log('Push notifications off:', e.message); }
}
const PUSH_EVERY_MS = Number(process.env.PUSH_EVERY_MS || 180_000);
const lastPush = new Map();
function pushTo(token, text, force = false) {
  const subs = db.pushSubs?.[token];
  if (!pushReady || !subs?.length) return;
  const now = Date.now();
  if (!force) {
    if (now - (lastPush.get(token) || 0) < PUSH_EVERY_MS) return;
    lastPush.set(token, now);   // a test doesn't use up the allowance
  }
  const payload = JSON.stringify({ title: `Deadzone · ${WORLD_NAME}`, body: text, tag: force ? 'test' : 'base' });
  for (const sub of [...subs]) {
    webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }).catch((e) => {
      // Gone (uninstalled, permission taken back): forget it.
      if (e.statusCode === 404 || e.statusCode === 410) db.pushSubs[token] = (db.pushSubs[token] || []).filter((q) => q.endpoint !== sub.endpoint);
    });
  }
}
function pushSubscribe(p, msg) {
  const sub = msg.sub;
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000 || !/^https:\/\//.test(sub.endpoint)) return;
  if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) return;
  db.pushSubs ??= {};
  const list = (db.pushSubs[p.token] || []).filter((q) => q.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  db.pushSubs[p.token] = list.slice(-5);   // a few devices each
  if (msg.fresh) toast(p, '🔔 Base alerts are on for this device: you\'ll get a notification if your base is attacked while you\'re out of the game');
}
function warnTeam(ownerToken, text, x, z, alert = 'Intruder') {
  for (const o of teamOfToken(ownerToken)) { toast(o, text); send(o.ws, { t: 'alert', x, z, text: alert }); }
  logAway(ownerToken, text.replace(/^⚠ /, ''));
}
const teamKeyOf = (token) => squadOfToken.get(token) || `solo:${token}`;
function exposeToTeam(target, ownerToken, ms) {
  expose(target, teamKeyOf(ownerToken), ms);
  for (const o of teamOfToken(ownerToken)) send(o.ws, { t: 'expose', ids: [target.id], until: Date.now() + ms, kind: 'sensor' });
}

// ---- world events
const worldEvents = new Map();
let nextEventAt = Date.now() + Number(process.env.EVENT_FIRST_MS || EV.firstAfterMs);
function eventView(e) {
  return { id: e.id, type: e.type, name: e.name, desc: e.desc, x: Math.round(e.x), z: Math.round(e.z), radius: e.radius || 0, endsAt: e.endsAt, town: e.town || null,
    good: e.good || null, mult: e.mult || null, board: e.board ? Object.values(e.board).sort((a, b) => b.meat - a.meat).slice(0, 5) : null };
}
function pushWorldEvents(extra = {}) { broadcast({ t: 'worldEvents', list: [...worldEvents.values()].map(eventView), ...extra }); }
function inFair(x, z) { for (const e of worldEvents.values()) if (e.type === 'fair' && Math.hypot(x - e.x, z - e.z) <= e.radius) return e; return null; }
function priceSwing(contactId, good) {
  for (const e of worldEvents.values()) if (e.type === 'swing' && e.contactId === contactId && e.good === good) return e.mult;
  return 1;
}
function randomDry(test, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const x = (Math.random() - 0.5) * (map.size - 1200), z = (Math.random() - 0.5) * (map.size - 1200);
    if (terrain.height(x, z) < 1 || map.towns.some((t) => x > t.rect.minX - 60 && x < t.rect.maxX + 60 && z > t.rect.minZ - 60 && z < t.rect.maxZ + 60)) continue;
    if (test(x, z)) return { x, z };
  }
  return null;
}
// ---- hot zones: one at a time, announced ahead, guarded, a few crates of the best gear. What comes out
// of a crate is hot until you get it home: you show on everyone's map, and it drops if you die.
const HZ = ACTIVITIES.hotZone;
// Random within a range (tests pin them with the env).
const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
const hzWarn = () => Number(process.env.HOTZONE_WARN_MS || between(HZ.warnMs)), hzOpen = () => Number(process.env.HOTZONE_OPEN_MS || between(HZ.openMs));
const hzGap = () => Number(process.env.HOTZONE_GAP_MS || between(HZ.gapMs));
const HZ_CACHE_PING_MS = Number(process.env.HOTZONE_CACHE_PING_MS || HZ.cachePingMs);
let nextHotAt = Date.now() + Number(process.env.HOTZONE_FIRST_MS || between([HZ.firstAfterMs, HZ.firstAfterMs * 2]));
const HZ_CRATE_MS = Number(process.env.HOTZONE_CRATE_MS || HZ.crateMs), HZ_PING_MS = Number(process.env.HOTZONE_PING_MS || HZ.pingMs);
const HOTDROP_WAIT_MS = Number(process.env.HOTDROP_WAIT_MS || HZ.hotDrop.waitMs);
const HZ_GUARDS = Number(process.env.HOTZONE_GUARDS ?? HZ.guards);
let hotZone = null, lastHotSpot = null;
/** Real places a hot zone can open: the towns, Rock Bluff, either end of a bridge, the airstrips. */
function hotSpots() {
  const out = map.towns.map((t) => ({ name: t.name, x: (t.rect.minX + t.rect.maxX) / 2, z: (t.rect.minZ + t.rect.maxZ) / 2 }));
  for (const c of map.communities || []) out.push({ name: c.name, x: c.x, z: c.z });
  for (const b of map.bridges || []) {
    const end = [b.pts?.[0], b.pts?.[b.pts.length - 1]].filter(Boolean).find((q) => terrain.height(q[0], q[1]) > 1);
    if (end && !out.some((o) => o.name === b.name)) out.push({ name: b.name, x: end[0], z: end[1] });
  }
  for (const a of map.airstrips || []) out.push({ name: a.name, x: (a.x1 + a.x2) / 2, z: (a.z1 + a.z2) / 2 });
  return out.filter((o) => Math.abs(o.x) < map.half - 400 && Math.abs(o.z) < map.half - 400);
}
const inHotZone = (c) => !!(hotZone?.open && c && Math.hypot(c.x - hotZone.x, c.z - hotZone.z) <= hotZone.radius);
/** Within a mile of a hot zone that's announced or open: no taxi drops, fast travel or respawns there. */
const nearHotZone = (x, z) => !!(hotZone && Math.hypot(x - hotZone.x, z - hotZone.z) < HZ.keepOutM);
const hasHot = (p) => !!p.hotLoose || [...GUN_SLOTS, 'armor'].some((s) => p.inv[s]?.hot) || p.inv.pack.some((i) => i.hot);
function hotZoneView() {
  if (!hotZone) return null;
  const z = hotZone;
  return { id: z.id, name: z.name, x: Math.round(z.x), z: Math.round(z.z), radius: z.radius, opensAt: z.opensAt, closesAt: z.closesAt, open: !!z.open,
    crates: z.crates.map((c) => ({ id: c.id, x: +c.x.toFixed(1), z: +c.z.toFixed(1), opened: !!c.opened })), extract: z.extract };
}
const sendHotZone = () => broadcast({ t: 'hotzone', zone: hotZoneView() });
/** A dry, outdoor, clear spot near (x, z), within r. */
function openSpotNear(x, z, r, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    if (terrain.height(px, pz) < 0.8 || buildingAt(px, pz) >= 0) continue;
    const fixed = resolveCircle(px, pz, 1.2, solidsNear(px, pz, 4), terrain.height(px, pz));
    if (Math.hypot(fixed.x - px, fixed.z - pz) > 0.3) continue;
    return { x: px, z: pz };
  }
  return null;
}
/** Open country anywhere in the county, named for the road it's by or the nearest town. */
function randomHotSpot() {
  for (let i = 0; i < 300; i++) {
    const x = (Math.random() - 0.5) * (map.size - 2400), z = (Math.random() - 0.5) * (map.size - 2400);
    if (terrain.height(x, z) < 1.5 || terrain.channel?.(x, z)) continue;
    let wet = 0;
    for (let k = 0; k < 12; k++) if (terrain.height(x + Math.cos(k) * HZ.radius * 0.7, z + Math.sin(k) * HZ.radius * 0.7) < 0.6) wet++;
    if (wet > 3) continue;   // mostly dry ground, so there's somewhere to fight and hide
    const road = map.roadsNear(x, z, 400).find((r) => r.name);
    const town = map.towns.reduce((m, t) => { const d = Math.hypot((t.rect.minX + t.rect.maxX) / 2 - x, (t.rect.minZ + t.rect.maxZ) / 2 - z); return !m || d < m.d ? { t, d } : m; }, null);
    return { x, z, name: road ? `${road.name} (${(town.d / 1609.344).toFixed(1)} mi from ${town.t.name})` : `the woods ${(town.d / 1609.344).toFixed(1)} mi from ${town.t.name}` };
  }
  return null;
}
function announceHotZone(now) {
  // Never the same place twice running, never close to the last one, and as often open country as a town.
  const last = lastHotSpot;
  const far = (o) => !last || Math.hypot(o.x - last.x, o.z - last.z) > 3000;
  const at = (Math.random() < HZ.namedChance ? pick(hotSpots().filter(far)) : null) || randomHotSpot() || pick(hotSpots());
  if (!at) { nextHotAt = now + hzGap(); return; }
  lastHotSpot = { x: at.x, z: at.z };
  const c = touchdownSpot(at.x, at.z), warn = hzWarn(), open = hzOpen();
  hotZone = { id: uid('hz'), name: at.name, x: c.x, z: c.z, radius: HZ.radius, opensAt: now + warn, closesAt: now + warn + open, open: false, crates: [], guards: [], opened: new Map(), extract: null, reinforceAt: 0, caches: [] };
  nextHotAt = Infinity;   // the next one is timed from when this one closes
  for (const o of players.values()) toast(o, `🔥 Hot zone at ${at.name} (${distText(Math.hypot(o.x - c.x, o.z - c.z))} away) opens in ${Math.max(1, Math.round(warn / 60000))} min, for ${Math.round(open / 60000)} min: elite guards, ${HZ.crates} crates of top gear and loot hidden all through it. Is it worth the trip?`);
  feed(`🔥 Hot zone announced: ${at.name}`);
  sendHotZone();
}
function spawnGuard(z) {
  const at = openSpotNear(z.x, z.z, z.radius * 0.55) || { x: z.x, z: z.z };
  z.guards.push(spawnBot(at.x, at.z, 'guard', { hotZone: z.id }).id);
}
function openHotZone(z) {
  z.open = true;
  for (let i = 0; i < HZ.crates; i++) {
    const at = openSpotNear(z.x, z.z, z.radius * 0.7);
    if (at) z.crates.push({ id: `${z.id}c${i}`, x: at.x, z: at.z, opened: null });
  }
  for (let i = 0; i < HZ_GUARDS; i++) spawnGuard(z);
  z.reinforceAt = Date.now() + HZ.reinforceMs;
  // The zone's own pickup point, just outside its edge, on the side nearest the middle of the county.
  const a = Math.atan2(-z.z, -z.x);
  const ex = openSpotNear(z.x + Math.cos(a) * (z.radius + HZ.extractOut), z.z + Math.sin(a) * (z.radius + HZ.extractOut), 30) || touchdownSpot(z.x + Math.cos(a) * (z.radius + HZ.extractOut), z.z + Math.sin(a) * (z.radius + HZ.extractOut));
  z.extract = { x: Math.round(ex.x), z: Math.round(ex.z) };
  placeCaches(z);
  for (const o of players.values()) toast(o, `🔥 The hot zone at ${z.name} is open for ${Math.round((z.closesAt - Date.now()) / 60000)} min. Crates and hidden caches are guarded; whatever you take is hot until you extract it.`);
  sendHotZone();
}
function closeHotZone(z) {
  for (const id of z.guards) bots.delete(id);
  for (const id of z.caches) loot.delete(id);   // what nobody found is gone
  hotZone = null;
  nextHotAt = Date.now() + hzGap();
  feed(`🔥 The hot zone at ${z.name} has closed`);
  sendHotZone();
}
/** A gun with rare parts already fitted: the best that fits it in each slot, one or two steps down at random. */
function rareWeapon() {
  const arche = pick(['carbine', 'dmr', 'lmg', 'smg', 'shotgun']);
  const w = makeWeapon(arche, {}, 'factory', 'random');
  w.parts = { ...(w.parts || {}) };
  for (const slot of SLOTS) {
    const fits = Object.entries(PARTS).filter(([id, pt]) => pt.slot === slot && partFits(id, arche) && pt.level >= 5).sort((a, b) => b[1].level - a[1].level);
    if (fits.length) w.parts[slot] = fits[Math.min(fits.length - 1, Math.floor(Math.random() * 3))][0];
  }
  w.name = `${w.name} (hot-zone build)`;
  return w;
}
const rnd = ([a, b]) => Math.round(a + Math.random() * (b - a));
/** Caches tucked all through the zone: in its buildings, in the ditches along its roads, in the woods and fields. */
function placeCaches(z) {
  const spots = [];
  const inside = map.buildings.filter((b) => Math.hypot((b.minX + b.maxX) / 2 - z.x, (b.minZ + b.maxZ) / 2 - z.z) < z.radius * 0.9);
  for (const b of inside.sort(() => Math.random() - 0.5).slice(0, Math.ceil(HZ.caches * 0.4))) {
    for (let t = 0; t < 12; t++) {
      const x = b.minX + 1.2 + Math.random() * Math.max(0.1, b.maxX - b.minX - 2.4), zz = b.minZ + 1.2 + Math.random() * Math.max(0.1, b.maxZ - b.minZ - 2.4);
      if (insideBuilding(b, x, zz, 0.4)) { spots.push({ x, z: zz, where: 'building' }); break; }
    }
  }
  for (const r of map.roadsNear(z.x, z.z, z.radius).sort(() => Math.random() - 0.5).slice(0, 4)) {   // the ditch beside the road
    const f = Math.random(), x = r.x1 + (r.x2 - r.x1) * f, zz = r.z1 + (r.z2 - r.z1) * f, len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1) || 1;
    const off = (r.width || 8) / 2 + 2, nx = -(r.z2 - r.z1) / len * off, nz = (r.x2 - r.x1) / len * off;
    const px = x + (Math.random() < 0.5 ? nx : -nx), pz = zz + (Math.random() < 0.5 ? nz : -nz);
    if (Math.hypot(px - z.x, pz - z.z) < z.radius && terrain.height(px, pz) > 0.5 && buildingAt(px, pz) < 0) spots.push({ x: px, z: pz, where: 'ditch' });
  }
  while (spots.length < HZ.caches) {   // woods and fields: under a tree if there's one, otherwise open ground
    const at = openSpotNear(z.x, z.z, z.radius * 0.95);
    if (!at) break;
    const tree = map.grid.near(at.x, at.z, 8).find((b) => b.type === 'tree' || b.type === 'pine');
    spots.push(tree ? { x: tree.maxX + 0.8, z: (tree.minZ + tree.maxZ) / 2, where: 'woods' } : { ...at, where: 'field' });
  }
  const kinds = HZ.cache.kinds, total = kinds.reduce((n, k) => n + k.w, 0);
  for (const sp of spots.slice(0, HZ.caches)) {
    let r = Math.random() * total, k = kinds[0];
    for (const q of kinds) { r -= q.w; if (r <= 0) { k = q; break; } }
    const item = k.gun ? rareWeapon() : { id: uid('lb'), kind: 'lockbox', name: k.name, contents: Object.fromEntries(Object.entries(k.contents).map(([key, range]) => [key, rnd(range)])) };
    item.hot = z.id; item.hotTier = 'cache';
    const id = uid('l');
    loot.set(id, { id, x: sp.x, z: sp.z, item, zone: z.id });
    z.caches.push(id);
  }
}
function finishHotCrate(p, id) {
  const z = hotZone, c = z?.crates.find((q) => q.id === id);
  if (!z?.open || !c) return send(p.ws, { t: 'hack', done: true, text: 'The hot zone has closed' });
  if (c.opened) return send(p.ws, { t: 'hack', done: true, text: `${c.opened} got to that crate first` });
  const got = [Math.random() < COMBAT.rocket.crateChance ? makeWeapon('launcher') : rareWeapon(), ...(Math.random() < HZ.crate.armorChance ? [makeArmor('heavy')] : [])];
  const box = { id: uid('lb'), kind: 'lockbox', name: 'Hot-zone lockbox', contents: { cash: rnd(HZ.crate.cash), tech: rnd(HZ.crate.tech), intel: rnd(HZ.crate.intel), parts: rnd(HZ.crate.parts), ...(got[0].archetype === 'launcher' ? { rockets: 3 } : {}) } };
  got.push(box);
  if (p.inv.pack.length + got.length > PACK_SIZE) return send(p.ws, { t: 'hack', done: true, text: `Make room: the crate holds ${got.length} things` });
  c.opened = p.name;
  z.opened.set(p.token, (z.opened.get(p.token) || 0) + 1);
  for (const it of got) { it.hot = z.id; it.hotTier = 'crate'; p.inv.pack.push(it); }
  send(p.ws, { t: 'hack', done: true, text: `🔥 Crate open: ${got.map((i) => i.name).join(', ')}. It's hot: you'll show on everyone's map every ${Math.round(HZ_PING_MS / 1000)}s until you extract it.` });
  award(p, 60, 'Hot crate');
  feed(`🔥 ${p.name} cracked a hot-zone crate at ${z.name}`);
  pingHot(p, true);
  dirty(p);
  sendHotZone();
}
/** Everyone but your crew sees where a hot-loot carrier is. */
function pingHot(p, first = false) {
  p.hotPingAt = Date.now();
  if (first) toast(p, '🔥 You are carrying hot loot. Get it to your stash house or a hideout, or fly it out at an extraction point or with a rescue flare.');
  for (const o of players.values()) {
    if (o === p || o.dead || sameSquad(o, p)) continue;
    send(o.ws, { t: 'alert', x: Math.round(p.x), z: Math.round(p.z), text: `Hot loot carrier (${p.name})`, hot: 1 });
  }
}
/** Hot loot made safe: home, a hideout, or flown out. Lockboxes open into your supplies. */
function coolHot(p, how) {
  const got = {}, names = [];
  if (p.hotLoose) { for (const [k, v] of Object.entries(p.hotLoose.got || {})) got[k] = (got[k] || 0) + v; p.hotLoose = null; }   // already in your supplies
  for (const s of [...GUN_SLOTS, 'armor']) if (p.inv[s]?.hot) { delete p.inv[s].hot; delete p.inv[s].hotTier; names.push(p.inv[s].name); }
  for (const it of [...p.inv.pack]) {
    if (!it.hot) continue;
    if (it.kind === 'lockbox') {
      p.inv.pack.splice(p.inv.pack.indexOf(it), 1);
      for (const [k, v] of Object.entries(it.contents || {})) { if (k === 'cash') p.cash = (p.cash || 0) + v; else p[k] = (p[k] || 0) + v; got[k] = (got[k] || 0) + v; }
    } else { delete it.hot; delete it.hotTier; names.push(it.name); }
  }
  const res = Object.entries(got).map(([k, v]) => (k === 'cash' ? `$${v}` : `${v} ${k}`));
  toast(p, `✅ Hot loot secured ${how}: ${[...names, ...res].join(', ')}. It's yours for good.`);
  award(p, 80, 'Hot loot extracted');
  feed(`✅ ${p.name} got hot-zone loot out`);
  dirty(p);
}
/** A locker pried open in the field: what was inside goes into your supplies. Still hot until you get it home. */
const LOCKBOX_BREAK = HZ.lockboxBreak;
function finishBreakBox(p, id) {
  const i = p.inv.pack.findIndex((q) => q.id === id && q.kind === 'lockbox');
  if (i < 0) return send(p.ws, { t: 'hack', done: true, text: 'The locker is gone' });
  const box = p.inv.pack.splice(i, 1)[0], got = {};
  for (const [k, v] of Object.entries(box.contents || {})) { p[k] = (p[k] || 0) + v; got[k] = v; }
  const what = Object.entries(got).map(([k, v]) => (k === 'cash' ? `$${v}` : `${v} ${k}`)).join(', ');
  if (box.hot) {
    const loose = p.hotLoose || { tier: 'cache', got: {} };
    if (box.hotTier !== 'cache') loose.tier = box.hotTier;
    for (const [k, v] of Object.entries(got)) loose.got[k] = (loose.got[k] || 0) + v;
    p.hotLoose = loose;
  }
  send(p.ws, { t: 'hack', done: true, text: `Pried open: ${what || 'empty'}.${box.hot ? ' Still hot: you show on the map until you get it home. Die first and it all drops.' : ''}` });
  dirty(p);
}
function tickHotZone(now) {
  if (!hotZone && now >= nextHotAt) announceHotZone(now);
  const z = hotZone;
  if (z && !z.open && now >= z.opensAt) openHotZone(z);
  if (z?.open) {
    if (now >= z.closesAt) closeHotZone(z);
    else if (now >= z.reinforceAt) {   // reinforcements: back up to full strength every few minutes
      z.guards = z.guards.filter((id) => bots.has(id) && !bots.get(id).dead);
      for (let i = z.guards.length; i < HZ_GUARDS; i++) spawnGuard(z);
      z.reinforceAt = now + HZ.reinforceMs;
    }
  }
  for (const p of players.values()) {
    if (p.dead || p.deploying || !hasHot(p)) continue;
    // Home free: inside your stash house or at one of your hideouts.
    if (atOwnStash(p) || hideoutsOf(p).some((st) => Math.hypot(st.x - p.x, st.z - p.z) < 6)) { coolHot(p, 'at your stash'); continue; }
    const loud = (p.hotLoose && p.hotLoose.tier !== 'cache') || [...GUN_SLOTS, 'armor'].some((s) => p.inv[s]?.hot && p.inv[s].hotTier !== 'cache') || p.inv.pack.some((i) => i.hot && i.hotTier !== 'cache');
    if (now - (p.hotPingAt || 0) >= (loud ? HZ_PING_MS : HZ_CACHE_PING_MS)) pingHot(p);
  }
  for (const [tok, h] of [...hotDrops]) if (now >= h.arrivesAt) { hotDrops.delete(tok); landHotDrop(tok, h, now); }
}
// ---- high-value sites (shared/sites.js): the county's real prisons, sheriff's offices, hospital, clinics,
// pharmacies and sporting-goods stores. Guarded, stocked with better loot; the first thing taken (or the
// first shot at a guard) sets off the alarm: everyone near hears it and backup is on its way. Most of what
// comes out is hot until you get it home. A cleared site restocks after a while.
const SITE_ON = process.env.SITES !== '0' && !!realFiles.infrastructure;
const centreOf = (b) => ({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });
const sites = (SITE_ON ? findSites(realFiles.infrastructure, readReal('businesses.json'), map.size) : []).map((s) => {
  const K = SITES.kinds[s.kind];
  const near = map.buildings.map((b) => ({ b, d: Math.hypot(centreOf(b).x - s.x, centreOf(b).z - s.z) })).filter((q) => q.d < K.radius)
    .sort((a, b) => a.d - b.d).slice(0, s.kind === 'prison' ? 12 : 3).map((q) => q.b);
  const c = near[0] && Math.hypot(centreOf(near[0]).x - s.x, centreOf(near[0]).z - s.z) < 90 ? centreOf(near[0]) : s;
  return { ...s, x: Math.round(c.x), z: Math.round(c.z), K, buildings: near, state: 'stocked', caches: [], guards: [], awake: false, lastNear: 0, alarmUntil: 0, reinforceAt: 0, raider: null, restockAt: 0 };
});
const siteById = new Map(sites.map((s) => [s.id, s]));
// Buildings nobody can make a stash house: Lamar's and the trading posts, the high-value sites, and
// every shop, office or hall a real business is in (a business run from a house doesn't count).
const NO_CLAIM = new Map();   // building index -> why
{
  for (const b of map.buildings) if (b.shop) NO_CLAIM.set(b.idx, `${b.name} is open for business, not for claiming`);
  for (const s of sites) for (const b of s.buildings) NO_CLAIM.set(b.idx, `${s.name} can't be anyone's stash house`);
  const rows = SITE_ON ? readReal('businesses.json')?.rows || [] : [];
  for (const [lat, lon, , name] of rows) {
    const { x, z } = project(lat, lon, map.size);
    let best = null, bd = 20;
    for (const b of buildingGrid.near(x, z, 20)) {
      if (b.type === 'home' || b.type === 'farmhouse' || b.type === 'barn') continue;
      const d = Math.hypot(Math.max(0, b.minX - x, x - b.maxX), Math.max(0, b.minZ - z, z - b.maxZ));
      if (d < bd) { bd = d; best = b; }
    }
    if (best && !NO_CLAIM.has(best.idx)) NO_CLAIM.set(best.idx, `${name} is a business, not a stash house`);
  }
}
if (NO_CLAIM.size) console.log(`${NO_CLAIM.size} buildings are businesses, shops or sites: nobody can claim them`);
const siteView = (s) => ({ id: s.id, kind: s.kind, name: s.name, x: s.x, z: s.z, r: Math.min(s.K.radius, 120), state: s.alarmUntil > Date.now() && s.state === 'stocked' ? 'alarm' : s.state, left: s.caches.length, restockAt: s.restockAt });
const sendSites = (to) => { const msg = { t: 'sites', sites: sites.map(siteView), ...(to ? { noClaim: [...NO_CLAIM.keys()] } : {}) }; if (to) send(to, msg); else broadcast(msg); };
const pickW = (list) => { let r = Math.random() * list.reduce((n, k) => n + k.w, 0); for (const k of list) { r -= k.w; if (r <= 0) return k; } return list[0]; };
/** A spot inside one of the site's buildings, else outside close by. */
function siteSpot(s) {
  for (let t = 0; t < 20 && s.buildings.length; t++) {
    const b = pick(s.buildings);
    const x = b.minX + 1.2 + Math.random() * Math.max(0.1, b.maxX - b.minX - 2.4), z = b.minZ + 1.2 + Math.random() * Math.max(0.1, b.maxZ - b.minZ - 2.4);
    if (insideBuilding(b, x, z, 0.4)) return { x, z };
  }
  return openSpotNear(s.x, s.z, 30) || { x: s.x + 3, z: s.z + 3 };
}
/** What one of the site's caches holds. */
function siteItems(s) {
  const k = pickW(s.K.loot), hot = (it) => Object.assign(it, { hot: s.id, hotTier: s.K.hot });
  if (k.medkit) return Array.from({ length: k.medkit }, () => makeConsumable('medkit'));
  if (k.armor) return [hot(makeArmor(k.armor))];
  if (k.gun) { const w = rareWeapon(); w.name = w.name.replace('hot-zone build', s.kind === 'sporting' ? 'store stock' : 'armory'); return [hot(w)]; }
  return [hot({ id: uid('lb'), kind: 'lockbox', name: k.name, contents: Object.fromEntries(Object.entries(k.contents).map(([key, range]) => [key, rnd(range)]).filter(([, v]) => v > 0)) })];
}
function stockSite(s) {
  for (const id of s.caches) loot.delete(id);
  s.caches = [];
  for (let i = 0; i < s.K.caches; i++) {
    const at = siteSpot(s);
    siteItems(s).forEach((item, j) => {
      const id = uid('l');
      loot.set(id, { id, x: at.x + j * 0.6, z: at.z, item, site: s.id });
      s.caches.push(id);
    });
  }
  s.state = 'stocked';
}
function spawnSiteGuard(s, from) {
  const at = from || openSpotNear(s.x, s.z, Math.min(s.K.radius, 60)) || { x: s.x, z: s.z };
  const b = spawnBot(at.x, at.z, s.K.guard, { site: s.id });
  if (from) b.patrol = { x: s.x, z: s.z };
  s.guards.push(b.id);
  return b;
}
function raiseSiteAlarm(s, p, now) {
  if (s.alarmUntil > now || s.state !== 'stocked') return;
  s.alarmUntil = now + SITES.alarmMs;
  s.reinforceAt = now + s.K.reinforceAfterMs;
  s.raider = p.id;
  const who = s.K.guard === 'guard' ? 'the guards are' : 'the looters holding it are';
  for (const o of players.values()) {
    const d = Math.hypot(o.x - s.x, o.z - s.z);
    if (o === p) toast(o, `🚨 You set off the alarm at ${s.name}: backup arrives in ${Math.round(s.K.reinforceAfterMs / 1000)}s. ${s.K.hot ? 'What you take is hot until you get it home.' : ''}`);
    else if (d < SITES.alarmRangeM) toast(o, `🚨 Alarm at ${s.name}, ${distText(d)} away: somebody's inside and ${who} calling for backup.`);
  }
  sendSites();
}
/** Something was taken from a site (takeLoot). */
function siteLooted(p, l) {
  const s = siteById.get(l.site);
  if (!s) return;
  s.caches = s.caches.filter((id) => id !== l.id);
  const now = Date.now();
  raiseSiteAlarm(s, p, now);
  if (s.caches.length || s.state !== 'stocked') return sendSites();
  s.state = 'cleared';
  s.restockAt = now + between(s.K.restockMs);
  award(p, s.K.xp, `${s.name} cleared`, true);
  feed(`🚨 ${p.name} cleaned out ${s.name}`);
  sendSites();
}
function tickSites(now) {
  if (!sites.length) return;
  const alive = [...players.values()].filter((p) => !p.dead && !p.deploying);
  let changed = false;
  for (const s of sites) {
    s.guards = s.guards.filter((id) => bots.has(id) && !bots.get(id).dead);
    if (s.state === 'cleared' && now >= s.restockAt) { stockSite(s); changed = true; }
    if (s.alarmUntil && now >= s.alarmUntil) { s.alarmUntil = 0; changed = true; }
    let d = Infinity;
    for (const p of alive) d = Math.min(d, Math.hypot(p.x - s.x, p.z - s.z));
    if (d < SITES.wakeM) {
      s.lastNear = now;
      if (!s.awake) {
        s.awake = true;
        if (s.state === 'stocked') for (let i = s.guards.length; i < s.K.guards; i++) spawnSiteGuard(s);
      }
    } else if (s.awake && d > SITES.sleepM && now - s.lastNear > 60_000) {
      s.awake = false;
      for (const id of s.guards) bots.delete(id);
      s.guards = [];
    }
    if (!s.awake) continue;
    // Shooting at a guard sets off the alarm too.
    if (s.state === 'stocked' && !(s.alarmUntil > now)) {
      for (const id of s.guards) {
        const a = bots.get(id)?.aggro, p = a && !a.heard && players.get(a.id);
        if (p) { raiseSiteAlarm(s, p, now); break; }
      }
    }
    if (s.reinforceAt && now >= s.reinforceAt) {
      s.reinforceAt = 0;
      const raider = players.get(s.raider), a = Math.random() * Math.PI * 2;
      const from = openSpotNear(s.x + Math.cos(a) * 140, s.z + Math.sin(a) * 140, 40) || touchdownSpot(s.x + Math.cos(a) * 140, s.z + Math.sin(a) * 140);
      for (let i = 0; i < s.K.reinforce; i++) {
        const b = spawnSiteGuard(s, { x: from.x + i * 1.5, z: from.z });
        if (raider && !raider.dead) b.aggro = { id: raider.id, until: now + BOT_AI.aggroMs, x: raider.x, z: raider.z, heard: true };
      }
      for (const o of alive) if (Math.hypot(o.x - s.x, o.z - s.z) < 400) toast(o, `🚨 Backup has arrived at ${s.name}`);
    }
  }
  if (changed) sendSites();
}
for (const s of sites) stockSite(s);
// ---- the hot-drop flare: the helicopter picks you (and crew beside you) up and drops you at the zone's edge
const hotDrops = new Map();   // token -> { arrivesAt, x, z, flare }
const makeHotFlare = () => ({ id: uid('hf'), kind: 'hotflare', name: 'Hot-drop flare' });
function callHotDrop(p, flare) {
  const now = Date.now();
  if (!hotZone?.open) return toast(p, 'There\'s no hot zone open to drop into');
  if (inHotZone(p) || Math.hypot(p.x - hotZone.x, p.z - hotZone.z) < hotZone.radius + 80) return toast(p, 'You\'re already at the hot zone');
  if (buildingAt(p.x, p.z) >= 0) return toast(p, 'Get outside: the helicopter can\'t see a flare indoors');
  if (terrain.height(p.x, p.z) < 0.3 || p.boat) return toast(p, 'Get onto dry land to fire the flare');
  if (now - (p.lastHit || 0) < 10_000) return toast(p, 'Not while you\'re being shot at');
  if (hasCargo(p) || hasHot(p)) return toast(p, 'Not with freight or hot loot aboard: extract that first');
  if (hotDrops.has(p.token) || taxis.has(p.token)) return toast(p, 'A helicopter is already on its way to you');
  p.inv.pack.splice(p.inv.pack.indexOf(flare), 1);
  hotDrops.set(p.token, { arrivesAt: now + HOTDROP_WAIT_MS, x: p.x, z: p.z, flare });
  gesture(p, 'flare', 2200);
  toast(p, `🚁 Hot-drop flare lit. The helicopter lands in ${Math.round(HOTDROP_WAIT_MS / 1000)}s: stay close. Crew beside you ride along. It drops you at the edge of ${hotZone.name}.`);
  dirty(p);
}
function landHotDrop(tok, h, now) {
  const p = onlineByToken(tok);
  if (!p) return;
  const refund = (why) => { if (p.inv.pack.length < PACK_SIZE) p.inv.pack.push(h.flare); toast(p, `${why} (flare back in your bag)`); dirty(p); };
  if (p.dead || p.downed || Math.hypot(p.x - h.x, p.z - h.z) > 25) return refund('The helicopter couldn\'t find you');
  if (!hotZone?.open) return refund('The hot zone closed before the helicopter got there');
  if (now - (p.lastHit || 0) < 10_000) return refund('The pilot saw the shooting and turned back');
  const z = hotZone, a = Math.atan2(p.z - z.z, p.x - z.x);
  const riders = [...players.values()].filter((o) => !o.dead && !o.downed && (o === p || sameSquad(o, p)) && Math.hypot(o.x - h.x, o.z - h.z) < 25 && !hasCargo(o) && !hasHot(o));
  const edge = openSpotNear(z.x + Math.cos(a) * (z.radius + HZ.hotDrop.edge), z.z + Math.sin(a) * (z.radius + HZ.hotDrop.edge), 25) || touchdownSpot(z.x + Math.cos(a) * (z.radius + HZ.hotDrop.edge), z.z + Math.sin(a) * (z.radius + HZ.hotDrop.edge));
  riders.forEach((o, i) => {
    if (o.hack) cancelHack(o, 'Boarding the helicopter');
    o.openContainer = null;
    send(o.ws, { t: 'container', closed: true });
    placeAt(o, edge.x + Math.cos(i * 2.1) * 6 * (riders.length > 1), edge.z + Math.sin(i * 2.1) * 6 * (riders.length > 1));
    o.air = { alt: JUMP_ALT, mode: 'fall' };
    send(o.ws, { t: 'air', alt: JUMP_ALT, mode: 'fall', heli: { x: edge.x, z: edge.z, yaw: a + Math.PI } });
    toast(o, `🪂 Jump! You're over the edge of the ${z.name} hot zone. Everyone in there can see you coming.`);
    dirty(o);
  });
  for (const o of players.values()) if (!riders.includes(o) && !o.dead && Math.hypot(o.x - z.x, o.z - z.z) < z.radius * 3) send(o.ws, { t: 'alert', x: Math.round(edge.x), z: Math.round(edge.z), text: 'Hot drop: parachutes coming in' });
}
function startEvent(type) {
  const def = EV[type];
  if (!def) return null;
  const now = Date.now();
  const e = { id: uid('ev'), type, name: def.name, desc: def.desc, startedAt: now, endsAt: now + def.durationMs, radius: def.radius || 0, hitters: new Set() };
  if (type === 'riot') {
    const busy = new Set([...worldEvents.values()].map((x) => x.town));
    const t = pick(map.towns.filter((q) => !busy.has(q.name))) || pick(map.towns);
    const c = townContact(t);
    Object.assign(e, { x: c.x, z: c.z, town: t.name, name: `Riot in ${t.name}` });
    e.bots = [];
    for (let i = 0; i < def.rogues; i++) {
      const a = (i / def.rogues) * Math.PI * 2;
      e.bots.push(spawnBot(c.x + Math.cos(a) * 14, c.z + Math.sin(a) * 14, 'riot', { eventId: e.id }).id);
    }
  } else if (type === 'fair') {
    const t = map.towns.find((q) => q.name === 'Blountstown' && ![...worldEvents.values()].some((x) => x.town === q.name)) || pick(map.towns);
    const c = townContact(t);
    Object.assign(e, { x: c.x, z: c.z, town: t.name, name: `${t.name} county fair`, board: {} });
  } else if (type === 'hoghunt') {
    const at = randomDry((x, z) => terrain.biome(x, z).sea > 0.45) || randomDry(() => true);
    Object.assign(e, { x: at.x, z: at.z, name: 'Hog hunt in the swamp' });
    const boar = spawnAnimal('boar', at.x, at.z);
    Object.assign(boar, { hp: def.boarHp, maxHp: def.boarHp, eventId: e.id, aggressive: true });
    e.boss = boar.id;
    for (let i = 0; i < def.hogs; i++) spawnAnimal('hog', at.x + (Math.random() - 0.5) * 30, at.z + (Math.random() - 0.5) * 30);
  } else if (type === 'convoy') {
    const road = geoRoad('SR 20');
    if (!road || road.length < 2) return null;
    const route = Math.random() < 0.5 ? road : [...road].reverse();
    const truck = { id: uid('cv'), name: 'Supply convoy', isBot: true, npc: true, kind: 'convoy', serial: botSerial++, x: route[0][0], z: route[0][1], yaw: 0, hp: def.hp, maxHp: def.hp, dead: false, route, leg: 1, eventId: e.id };
    bots.set(truck.id, truck);
    e.truck = truck.id;
    e.bots = [];
    for (let i = 0; i < def.escorts; i++) e.bots.push(spawnBot(truck.x + (i - 1.5) * 4, truck.z + 6, 'escort', { eventId: e.id, follow: truck.id, offset: [(i - 1.5) * 5, (i % 2 ? 8 : -8)] }).id);
    Object.assign(e, { x: truck.x, z: truck.z, radius: 0 });
  } else if (type === 'swing') {
    const c = pick(map.contacts);
    const good = pick(Object.keys(ECONOMY.prices).filter((g) => HOMESTEAD.goods[g]));
    const boom = Math.random() < 0.6;
    Object.assign(e, { x: c.x, z: c.z, contactId: c.id, town: postTown(c.id), good, mult: boom ? def.boom : def.glut,
      name: boom ? `${HOMESTEAD.goods[good].name} shortage in ${postTown(c.id)}` : `${HOMESTEAD.goods[good].name} glut in ${postTown(c.id)}`,
      desc: boom ? `${postTown(c.id)}'s trading post is paying ${def.boom}× for ${HOMESTEAD.goods[good].name}. Haul it in while it lasts.` : `${postTown(c.id)} is drowning in ${HOMESTEAD.goods[good].name}: it pays less than half. Sell it elsewhere.` });
  }
  worldEvents.set(e.id, e);
  feed(`📣 ${e.name}`);
  pushWorldEvents({ announce: e.id });
  return e;
}
function geoRoad(name) {
  const r = map.highways.find((h) => h.name === name);
  if (!r) return null;
  return r.pts.filter(([x, z]) => Math.abs(x) < map.half - 100 && Math.abs(z) < map.half - 100);
}
function payout(e, def, x, z, label) {
  dropBag(x, z, [], def.reward || {}, label);
  for (const tok of e.hitters) { const o = onlineByToken(tok); if (o) award(o, def.xp, e.name); }
}
function endEvent(e, outcome) {
  worldEvents.delete(e.id);
  const def = EV[e.type];
  if (e.type === 'riot' || e.type === 'convoy') for (const id of e.bots || []) bots.delete(id);
  if (e.type === 'convoy') bots.delete(e.truck);
  if (e.type === 'hoghunt' && outcome !== 'won') bots.delete(e.boss);
  if (e.type === 'fair') {
    const ranked = Object.entries(e.board).sort((a, b) => b[1].meat - a[1].meat);
    ranked.forEach(([tok, row], i) => {
      const prize = ranked.length >= def.minHunters ? def.prizes[i] || 0 : 0;   // it takes a contest to win a prize
      const total = prize + row.meat * def.perMeat;
      const o = onlineByToken(tok);
      if (o) { o.cash = (o.cash || 0) + total; award(o, def.xp, `County fair${prize ? ` — ${['1st', '2nd', '3rd'][i]} place` : ''}`); toast(o, `🏆 Hunting contest: ${prize ? `${['1st', '2nd', '3rd'][i]} place, ` : ''}$${total}`); dirty(o); }
      else if (db.characters[tok]) db.characters[tok].cash = (db.characters[tok].cash || 0) + total;
    });
    if (ranked.length) feed(`🏆 ${e.town} hunting contest won by ${ranked[0][1].name} (${ranked[0][1].meat} meat)`);
  }
  if (outcome === 'won') feed(`✔ ${e.name}: done`);
  else if (outcome === 'escaped') feed(`The supply convoy got through`);
  pushWorldEvents();
}
function eventBotDown(b, attacker) {
  const e = worldEvents.get(b.eventId);
  if (!e) return;
  if (attacker && !attacker.isBot) e.hitters.add(attacker.token);
  const def = EV[e.type];
  if (e.type === 'riot' && !e.bots.some((id) => id !== b.id && bots.get(id) && !bots.get(id).dead)) {
    payout(e, def, e.x, e.z, 'Riot cache');
    endEvent(e, 'won');
  }
  if (e.type === 'hoghunt' && b.id === e.boss) { payout(e, def, b.x, b.z, 'Monster boar'); endEvent(e, 'won'); }
  if (e.type === 'convoy' && b.id === e.truck) { payout(e, def, b.x, b.z, 'Convoy cargo'); endEvent(e, 'won'); }
}
function tickEvents(now, dt) {
  const every = Number(process.env.EVENT_EVERY_MS || EV.everyMs);
  if (now >= nextEventAt) {
    nextEventAt = now + every * (0.75 + Math.random() * 0.5);
    if (worldEvents.size < EV.maxActive && players.size) {
      const types = Object.keys(EV).filter((k) => EV[k]?.weight && ![...worldEvents.values()].some((x) => x.type === k));
      let r = Math.random() * types.reduce((a, k) => a + EV[k].weight, 0);
      for (const k of types) { r -= EV[k].weight; if (r <= 0) { startEvent(k); break; } }
    }
  }
  for (const e of [...worldEvents.values()]) {
    if (now > e.endsAt) { endEvent(e, e.type === 'convoy' ? 'escaped' : 'expired'); continue; }
    if (e.type === 'convoy') {
      const t = bots.get(e.truck);
      if (!t) { endEvent(e, 'expired'); continue; }
      const [tx, tz] = t.route[t.leg];
      const dx = tx - t.x, dz = tz - t.z, d = Math.hypot(dx, dz), step = EV.convoy.speed * dt;
      if (d <= step) { t.x = tx; t.z = tz; t.leg++; if (t.leg >= t.route.length) { endEvent(e, 'escaped'); continue; } }
      else { t.x += dx / d * step; t.z += dz / d * step; t.yaw = Math.atan2(dx, dz); }
      e.x = t.x; e.z = t.z;
      for (const id of e.bots) {
        const b = bots.get(id);
        if (!b || b.dead) continue;
        b.homeX = t.x + b.offset[0]; b.homeZ = t.z + b.offset[1];
        // Nobody around to see: the escorts just ride along.
        if (![...players.values()].some((p) => dist2(p, b) < BOT_ACTIVE_RANGE ** 2)) { b.x = b.homeX; b.z = b.homeZ; }
      }
    }
  }
}
function fairSubmit(p) {
  const e = inFair(p.x, p.z);
  if (!e) return toast(p, 'Hand in meat at the county fair');
  if (!(p.meat > 0)) return toast(p, 'Bring raw meat for the hunting contest — hunt deer and hogs');
  const row = e.board[p.token] || (e.board[p.token] = { name: p.name, meat: 0 });
  row.meat += p.meat;
  toast(p, `Handed in ${p.meat} meat — you're on ${row.meat}`);
  p.meat = 0;
  dirty(p);
  pushWorldEvents();
}

// ---- NPC life: travelling merchants and settlers
function spawnMerchant(town) {
  const c = townContact(town);
  const d = NPC.merchant;
  const b = { id: uid('m'), name: d.name, isBot: true, npc: true, kind: 'merchant', serial: botSerial++, x: c.x + 4, z: c.z + 4, yaw: 0, hp: d.hp, maxHp: d.hp, dead: false, target: null, stuckFor: 0 };
  bots.set(b.id, b);
  return b;
}
const merchantRespawns = [];
function keepMerchants(now) {
  const alive = [...bots.values()].filter((b) => b.kind === 'merchant').length;
  for (let i = merchantRespawns.length - 1; i >= 0; i--) if (merchantRespawns[i] <= now) merchantRespawns.splice(i, 1);
  for (let i = alive + merchantRespawns.length; i < NPC.merchant.count; i++) spawnMerchant(pick(map.towns));
}
const settlerHomes = map.lootSpawns.filter((l) => l.zone === 'farm' || l.zone === 'lake').filter((_, i) => i % NPC.settler.every === 0)
  .map((l, i) => ({ i, x: l.x + 3, z: l.z + 3, zone: l.zone, goneUntil: 0, bot: null }));
function keepSettlers(now) {
  const alive = [...players.values()].filter((p) => !p.dead && !p.deploying);
  for (const h of settlerHomes) {
    const near = alive.some((p) => Math.abs(p.x - h.x) < NPC.settler.spawnWithin && Math.abs(p.z - h.z) < NPC.settler.spawnWithin);
    const b = h.bot && bots.get(h.bot);
    if (b && !alive.some((p) => Math.hypot(p.x - b.x, p.z - b.z) < NPC.settler.despawn)) { bots.delete(b.id); h.bot = null; continue; }
    if (!b && near && h.goneUntil <= now) {
      const s = { id: uid('s'), name: h.zone === 'lake' ? 'Fisherman' : 'Farmer', isBot: true, npc: true, kind: 'settler', home: h.i, serial: botSerial++, x: h.x, z: h.z, homeX: h.x, homeZ: h.z, yaw: 0, hp: NPC.settler.hp, maxHp: NPC.settler.hp, dead: false, wander: null, zone: h.zone };
      bots.set(s.id, s);
      h.bot = s.id;
    }
  }
}
function updateNpc(b, dt, now) {
  if (b.kind === 'merchant') {
    // Walk from town to town; if stuck (a river in the way), pick another town.
    if (!b.target || Math.hypot(b.target.x - b.x, b.target.z - b.z) < 6) {
      const t = pick(map.towns);
      const c = townContact(t);
      b.target = { x: c.x + 4, z: c.z + 4, town: t.name };
      b.pauseUntil = now + 60_000;   // trade in town for a minute
    }
    if (now < (b.pauseUntil || 0)) return;
    const dx = b.target.x - b.x, dz = b.target.z - b.z, d = Math.hypot(dx, dz), step = NPC.merchant.speed * dt;
    const np = moveWithCollision(b.x, b.z, dx / d * step, dz / d * step, PLAYER_RADIUS, solidsNear(b.x, b.z, step + 2), terrain);
    if (Math.hypot(np.x - b.x, np.z - b.z) < step * 0.2) { b.stuckFor += dt; if (b.stuckFor > 8) { b.target = null; b.stuckFor = 0; } } else b.stuckFor = 0;
    b.x = np.x; b.z = np.z; b.yaw = Math.atan2(dx, dz);
  } else if (b.kind === 'settler') {
    if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1 || Math.random() < 0.003) b.wander = { x: b.homeX + (Math.random() - 0.5) * 16, z: b.homeZ + (Math.random() - 0.5) * 16 };
    if (Math.random() < 0.5) return;
    const dx = b.wander.x - b.x, dz = b.wander.z - b.z, d = Math.hypot(dx, dz) || 1, step = 1.2 * dt;
    const np = moveWithCollision(b.x, b.z, dx / d * step, dz / d * step, PLAYER_RADIUS, solidsNear(b.x, b.z, 3), terrain);
    b.x = np.x; b.z = np.z; b.yaw = Math.atan2(dx, dz);
  }
}
function npcDown(b, attacker) {
  if (b.kind === 'merchant') {
    dropBag(b.x, b.z, [], NPC.merchant.loot, "Merchant's pack");
    merchantRespawns.push(Date.now() + NPC.merchant.respawnMs);
    if (attacker && !attacker.isBot) feed(`${attacker.name} robbed a travelling merchant`);
  } else if (b.kind === 'settler') {
    const h = settlerHomes[b.home];
    if (h) { h.goneUntil = Date.now() + NPC.settler.goneMs; h.bot = null; }
    dropBag(b.x, b.z, [], { ...NPC.settler.loot, ...(b.zone === 'lake' ? { fish: 6 } : { corn: 8, seeds: 2 }) }, `${b.name}'s goods`);
    if (attacker && !attacker.isBot) feed(`${attacker.name} killed a ${b.name.toLowerCase()}`);
  }
}
/** What a friendly NPC buys and sells. Merchants pay near the best price anywhere; settlers sell their produce cheap. */
// ---- Lamar's Pawn: guns, armor and goods bought and sold. What players sell goes in the case.
function pawnValue(it) {
  if (it.kind === 'weapon') {
    const extra = Object.entries(it.parts || {}).filter(([k, v]) => v && DEFAULT_PARTS[k] !== v).length;
    return Math.round((PAWN.gunValue[it.archetype] || 150) * (1 + PAWN.attachmentBonus * extra));
  }
  if (it.kind === 'armor') return PAWN.armorValue[it.type] || 100;
  return 0;
}
function pawnCase(now = Date.now()) {
  if (!db.pawn) db.pawn = { stock: [], restockAt: 0 };
  const P = db.pawn;
  // Low on stock: a new piece comes in every so often (a fresh shop opens with the full starting case).
  if (P.stock.length < PAWN.minStock && now >= (P.restockAt || 0)) {
    const have = P.stock.length;
    for (let i = have; i < (have ? have + 1 : PAWN.stockStart.length); i++) {
      const k = PAWN.stockStart[(i + Math.floor(now / 60000)) % PAWN.stockStart.length];
      P.stock.push(PAWN.armorValue[k] ? makeArmor(k) : makeWeapon(k, {}, 'factory', 'random'));
    }
    P.restockAt = now + PAWN.restockMinutes * 60000;
  }
  return P.stock;
}
const pawnPrice = (it) => Math.max(1, Math.round(pawnValue(it) * PAWN.sells));
const pawnPays = (it) => Math.max(1, Math.round(pawnValue(it) * PAWN.pays));
/** Everything a player could sell Lamar: guns and armor carried, worn or in the backpack. */
function pawnSellable(p) {
  const out = [];
  for (const slot of [...GUN_SLOTS, 'armor']) if (p.inv[slot]) out.push({ item: p.inv[slot], slot });
  for (const it of p.inv.pack) if (it.kind === 'weapon' || it.kind === 'armor') out.push({ item: it, slot: 'pack' });
  return out.filter((o) => !o.item.hot);   // hot loot has to be extracted before Lamar will touch it
}
function pawnView(p) {
  const G = (g) => HOMESTEAD.goods[g]?.name || g;
  return { town: PAWN.name, who: PAWN.keeper, pawn: true,
    sells: Object.keys(ECONOMY.prices).map((g) => ({ good: g, pays: Math.max(1, Math.floor(ECONOMY.prices[g] * PAWN.goodsPays)), name: G(g) })),
    shop: [{ id: 'rescueFlare', name: 'Rescue flare (calls the helicopter from anywhere)', price: FLARE.price, qty: 1 },
      { id: 'hotFlare', name: 'Hot-drop flare (parachute in at the edge of an open hot zone)', price: HZ.hotDrop.price, qty: 1 },
      { id: 'launcher', name: 'Rocket launcher (fires rockets: walls, gates, sentries, vehicles)', price: COMBAT.rocket.launcherPrice, qty: 1 },
      { id: 'rockets', name: 'Rocket', price: COMBAT.rocket.price, qty: 1 },
      ...Object.entries(ECONOMY.shop).filter(([k]) => !k.startsWith('_')).map(([k, it]) => ({ id: k, name: it.name || G(k), price: it.kind === 'good' && ECONOMY.prices[k] ? Math.max(it.price, Math.round(ECONOMY.prices[k] * PAWN.goodsMarkup)) : it.price, qty: it.qty || 1 }))],
    case: pawnCase().map((it) => ({ ...it, price: pawnPrice(it) })),
    offers: p ? pawnSellable(p).map(({ item, slot }) => ({ id: item.id, name: item.name, kind: item.kind, archetype: item.archetype, type: item.type, parts: item.parts, paint: item.paint, slot, pays: pawnPays(item) })) : [] };
}
const makeFlare = () => ({ id: uid('fl'), kind: 'flare', name: 'Rescue flare' });
function pawnTrade(p, b, msg) {
  if (msg.action === 'buy' && msg.item === 'rescueFlare') {
    if ((p.cash || 0) < FLARE.price) return toast(p, `A rescue flare is $${FLARE.price}. You have $${p.cash || 0}`), true;
    if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full'), true;
    p.cash -= FLARE.price;
    p.inv.pack.push(makeFlare());
    toast(p, 'Bought a rescue flare. Fire it from your bag, out in the open.');
    return true;
  }
  if (msg.action === 'buy' && (msg.item === 'launcher' || msg.item === 'rockets')) {
    const price = msg.item === 'launcher' ? COMBAT.rocket.launcherPrice : COMBAT.rocket.price;
    if ((p.cash || 0) < price) return toast(p, `That's $${price}. You have $${p.cash || 0}`), true;
    if (msg.item === 'launcher' && p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full'), true;
    p.cash -= price;
    if (msg.item === 'launcher') { p.inv.pack.push(makeWeapon('launcher')); toast(p, 'Bought a rocket launcher. It fires rockets (Lamar sells them one at a time).'); }
    else { p.rockets = (p.rockets || 0) + 1; toast(p, `Bought a rocket (you carry ${p.rockets})`); }
    dirty(p);
    return true;
  }
  if (msg.action === 'buy' && msg.item === 'hotFlare') {
    if ((p.cash || 0) < HZ.hotDrop.price) return toast(p, `A hot-drop flare is $${HZ.hotDrop.price}. You have $${p.cash || 0}`), true;
    if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full'), true;
    p.cash -= HZ.hotDrop.price;
    p.inv.pack.push(makeHotFlare());
    toast(p, 'Bought a hot-drop flare. Fire it from your bag, out in the open, while a hot zone is open.');
    return true;
  }
  if (msg.action === 'buyItem') {
    const stock = pawnCase(), i = stock.findIndex((x) => x.id === msg.itemId);
    if (i < 0) return toast(p, 'Somebody bought that one already'), true;
    const it = stock[i], price = pawnPrice(it);
    if ((p.cash || 0) < price) return toast(p, `That costs $${price}. You have $${p.cash || 0}`), true;
    if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full'), true;
    stock.splice(i, 1);
    p.cash -= price;
    p.inv.pack.push(it);
    if (it.kind === 'weapon') p.mags[it.id] = p.mags[it.id] ?? 0;
    toast(p, `Bought ${it.name} for $${price}. It's in your backpack: equip it from the bag.`);
    return true;
  }
  if (msg.action === 'sellItem') {
    const found = pawnSellable(p).find((x) => x.item.id === msg.itemId);
    if (!found) return true;
    const { item, slot } = found, pays = pawnPays(item);
    if (slot === 'pack') p.inv.pack.splice(p.inv.pack.indexOf(item), 1);
    else {
      p.inv[slot] = null;
      if (slot === p.active) p.active = GUN_SLOTS.find((s2) => p.inv[s2]) || 'secondary';
      if (slot === 'armor') p.armor = Math.min(p.armor, maxArmor(p));
    }
    delete p.mags[item.id];
    p.cash = (p.cash || 0) + pays;
    const stock = pawnCase();
    stock.push(item);
    if (stock.length > PAWN.maxStock) stock.shift();   // the oldest piece goes out the back
    toast(p, `Lamar gave you $${pays} for your ${item.name}`);
    return true;
  }
  return false;
}
function npcTradeView(b, p) {
  if (b.kind === 'pawn') return pawnView(p);
  if (b.kind === 'trader') return traderView(b);
  const best = (g) => Math.max(...map.contacts.map((c) => priceAt(c.id, g)));
  if (b.kind === 'merchant') {
    return { town: 'travelling', who: b.name,
      sells: Object.keys(ECONOMY.prices).map((g) => ({ good: g, pays: Math.max(1, Math.floor(best(g) * NPC.merchant.buyRate)), name: HOMESTEAD.goods[g]?.name || g })),
      shop: Object.entries(NPC.merchant.shop).map(([k, price]) => ({ id: k, name: ECONOMY.shop[k]?.name || HOMESTEAD.goods[k]?.name || k, price, qty: ECONOMY.shop[k]?.qty || 1 })) };
  }
  const produce = b.zone === 'lake' ? ['fish', 'meals'] : ['corn', 'peanuts', 'seeds'];
  return { town: b.zone === 'lake' ? 'fish camp' : 'farm', who: b.name,
    sells: ['meat', 'parts', 'tech', 'salvage'].map((g) => ({ good: g, pays: Math.max(1, Math.round(ECONOMY.prices[g] * NPC.settler.buyRate)), name: HOMESTEAD.goods[g]?.name || g })),
    shop: produce.map((g) => ({ id: g, name: HOMESTEAD.goods[g].name, price: Math.max(1, Math.round((ECONOMY.prices[g] || 3) * NPC.settler.sellRate * ECONOMY.buyMarkup)), qty: 1 })) };
}
function friendlyNpcNear(p) {
  for (const b of bots.values()) if (b.npc && !b.dead && (b.kind === 'merchant' || b.kind === 'settler' || b.kind === 'trader' || b.kind === 'pawn') && Math.hypot(b.x - p.x, b.z - p.z) < (b.kind === 'pawn' ? 3.2 : 2.6)) return b;
  return null;
}
function npcView(p, b) {
  return { t: 'contact', id: null, npc: b.id, name: b.kind === 'pawn' ? `${PAWN.keeper} · ${PAWN.name}` : b.name, offers: [], active: [], comms: p.comms, trade: npcTradeView(b, p) };
}


// ---- the river trade (phase 2): boats, landings, river freight, river traders and swamp camps
const RV = RIVER_DATA;
const boatRt = new Map();   // boat id -> { speed, seats: [playerId | null] } (runtime only)
function rtOf(b) { let r = boatRt.get(b.id); if (!r) { r = { speed: 0, seats: Array(BOATS[b.type].seats).fill(null) }; boatRt.set(b.id, r); } return r; }
const boatIdx = new Map();
const boatById = (id) => { let b = boatIdx.get(id); if (b && !b.gone) return b; b = db.boats.find((x) => x.id === id); if (b) boatIdx.set(id, b); return b; };
const canUseBoat = (p, b) => !!b.owner && tokenInSquadWith(p, b.owner);
const rideWord = (b) => BOATS[b.type].name.toLowerCase();
const boatName = (b) => `${b.ownerName ? `${b.ownerName}'s ` : ''}${rideWord(b)}`;
const boatOccupants = (b) => rtOf(b).seats.map((id) => id && players.get(id)).filter(Boolean);
/** How far off the ground a ride stands (bridge decks included). */
const rideY = (b) => (b.y !== undefined && b.yx === b.x && b.yz === b.z ? b.y : terrain.height(b.x, b.z));
/** Where a rider's feet are: on a boat's deck, or a ride's seat. */
function boatFeet(c) {
  const b = boatById(c.boat);
  return b && isLand(b.type) ? riderFeet(b.type, rideY(b)) : 0.25;
}
/** How far rides are seen: further than most things, so you can spot one to run to. */
const RIDE_SEEN = 420;
function inCamp(x, z) {
  for (const c of map.camps) if (Math.hypot(x - c.x, z - c.z) <= c.radius) return c;
  for (const sh of map.shops || []) if (Math.hypot(x - sh.x, z - sh.z) <= PAWN.safeRadius) return sh;   // no fighting at Lamar's
  return null;
}
function newBoat(type, x, z, yaw, owner, extra = {}) {
  const b = { id: `boat${crypto.randomBytes(4).toString('hex')}`, type, owner: owner?.token || null, ownerName: owner?.name || null, x, z, yaw, hp: BOATS[type].hp, items: [], ...extra };
  db.boats.push(b);
  boatIdx.set(b.id, b);
  return b;
}
function removeBoat(b) {
  b.gone = true;
  db.boats = db.boats.filter((x) => x !== b);
  boatRt.delete(b.id); boatIdx.delete(b.id);
}
const nearestDock = (x, z) => map.docks.reduce((a, d) => (!a || Math.hypot(d.x - x, d.z - z) < Math.hypot(a.x - x, a.z - z) ? d : a), null);
/** Somewhere dry to step out onto, near (x, z). */
function landingSpot(x, z, maxR = RV.rules.exitRange) {
  for (let r = 1.5; r <= maxR; r += 1) for (let a = 0; a < 16; a++) {
    const px = x + Math.cos(a * Math.PI / 8) * r, pz = z + Math.sin(a * Math.PI / 8) * r;
    if (terrain.height(px, pz) < DEEP_WATER + 0.3) continue;
    const fixed = resolveCircle(px, pz, PLAYER_RADIUS, solidsNear(px, pz, 3), terrain.height(px, pz));
    if (Math.hypot(fixed.x - px, fixed.z - pz) < 0.3) return { x: px, z: pz };
  }
  return null;
}
/** Beside a ride: the driver's side first, then the other, the back, the front; on a bridge, the same deck. */
function besideRide(b) {
  const def = BOATS[b.type], fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), y = rideY(b);
  const out = def.wid / 2 + 0.7, end = def.len / 2 + 0.7;
  for (const k of [1, 1.6, 2.4]) for (const [s, a] of [[out, 0], [-out, 0], [0, -end], [0, end], [out, -end], [-out, -end]]) {
    const px = b.x + fx * a * k + fz * s * k, pz = b.z + fz * a * k - fx * s * k;
    const py = terrain.standY ? terrain.standY(px, pz, y) : terrain.height(px, pz);
    if (py < DEEP_WATER + 0.3 || Math.abs(py - y) > 1.2) continue;
    const fixed = resolveCircle(px, pz, PLAYER_RADIUS, solidsNear(px, pz, 3), py);
    if (Math.hypot(fixed.x - px, fixed.z - pz) < 0.3) return { x: px, z: pz, y: py };
  }
  const s = landingSpot(b.x, b.z, 40);
  return s ? { ...s, y: terrain.height(s.x, s.z) } : null;
}
function placeOccupants(b) { rtOf(b).seats.forEach((id, i) => { const o = id && players.get(id); if (o) { const q = seatPos(b, i); o.x = q.x; o.z = q.z; } }); }
function boardBoat(p, b) {
  const rt = rtOf(b), def = BOATS[b.type];
  const seat = rt.seats[0] == null ? 0 : rt.seats.findIndex((x) => x == null);
  if (seat < 0) return toast(p, `The ${rideWord(b)} is full`);
  cancelHack(p, 'Cancelled');
  rt.seats[seat] = p.id; p.boat = b.id; p.seat = seat; p.crouch = false; p.prone = false;
  b.freeAt = null; b.usedAt = Date.now();
  const q = seatPos(b, seat);
  p.x = q.x; p.z = q.z;
  p.tp = (p.tp || 0) + 1;
  send(p.ws, { t: 'correct', x: p.x, z: p.z, force: true, tp: p.tp });
  if (def.land) toast(p, seat === 0 ? `${def.icon} ${def.animal ? 'Riding' : def.stand || def.pedal ? 'On' : 'Driving'} the ${rideWord(b)}. ${def.hold ? 'BAG for the ' + (def.animal ? 'saddlebags' : 'trunk') + '. ' : ''}E to get off.` : `${def.icon} Riding with ${boatName(b)}. E to get off.`);
  else toast(p, seat === 0 ? `At the helm of the ${rideWord(b)}. E to get out at the bank, BAG for the hold.` : `Riding in ${boatName(b)}. E to get out at the bank.`);
  dirty(p);
}
function unseat(p) {
  const b = p.boat && boatById(p.boat);
  if (b) {
    const rt = rtOf(b);
    if (rt.seats[p.seat] === p.id) rt.seats[p.seat] = null;
    if (p.seat === 0) rt.speed = 0;
    // A ride you found stays yours a while after you get out, then it's anyone's again.
    if (b.world && !rt.seats.some(Boolean)) { b.freeAt = Date.now() + RIDE_RULES.lockMs; b.usedAt = Date.now(); }
  }
  p.boat = null; p.seat = null;
  if (p.openContainer?.kind === 'boat') { p.openContainer = null; send(p.ws, { t: 'container', closed: true }); }
  dirty(p);
}
function leaveBoat(p, force = false) {
  const b = boatById(p.boat);
  if (!b) { unseat(p); return true; }
  if (isLand(b.type)) {
    const spot = besideRide(b) || (() => { const d = nearestDock(b.x, b.z); return { x: d.x, z: d.z, y: terrain.height(d.x, d.z) }; })();
    unseat(p);
    p.x = spot.x; p.z = spot.z; p.y = spot.y; p.yx = p.x; p.yz = p.z;
    p.tp = (p.tp || 0) + 1;
    send(p.ws, { t: 'correct', x: p.x, z: p.z, y: spot.y, force: true, tp: p.tp });
    return true;
  }
  let spot = landingSpot(b.x, b.z);
  if (!spot && force) { spot = landingSpot(b.x, b.z, 90); if (!spot) { const d = nearestDock(b.x, b.z); spot = { x: d.x, z: d.z }; } }
  if (!spot) { toast(p, 'Steer in to the bank to get out'); return false; }
  unseat(p);
  placeAt(p, spot.x, spot.z);
  // Stepping off at a landing hands over any freight bound for it (no need to find the post).
  for (const d of map.docks) if (mooredAt(b, d)) deliverRiverFreight(p, d);
  return true;
}
/** Driver input: the client predicts the boat or ride; the server keeps it on the water (or out of
 *  walls and off the deep water) and within its top speed. */
function boatState(p, msg) {
  const b = boatById(p.boat);
  if (!b) return unseat(p);
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.aiming = !!msg.aim; p.crouch = false;
  const rt = rtOf(b), now = Date.now(), def = BOATS[b.type];
  if (p.seat === 0 && msg.boat && [msg.boat.x, msg.boat.z, msg.boat.yaw].every(Number.isFinite)) {
    const dt = Math.min(0.25, (now - (b.lastMove || now - 50)) / 1000);
    b.lastMove = now; b.usedAt = now;
    let dx = msg.boat.x - b.x, dz = msg.boat.z - b.z;
    // A running allowance of distance, topped up with time: updates from a phone often arrive two
    // at once, and judging each on its own gap made a fast car snap back. Up to 0.6 s can be saved.
    const cap = def.speed * 1.3 * 0.6;
    b.budget = Math.min(cap, (b.budget ?? cap) + def.speed * 1.3 * dt);
    const max = b.budget + 0.3, d = Math.hypot(dx, dz);
    if (d > max) { dx *= max / d; dz *= max / d; }
    b.budget = Math.max(0, b.budget - Math.min(d, max));
    let x = b.x, z = b.z, ok = true;
    if (def.land) {
      const m = moveWithCollision(b.x, b.z, dx, dz, def.wid / 2 * 0.85, solidsNear(b.x, b.z, Math.hypot(dx, dz) + 3), terrain, rideY(b));
      x = m.x; z = m.z;
      b.y = m.y; b.yx = x; b.yz = z;
      if (Math.hypot(x - b.x - dx, z - b.z - dz) > 1.2) ok = false;
      // A hard crash dents it (the client says how hard; never more than it was really going).
      const crash = Math.min(Number(msg.crash) || 0, rt.speed + 3);
      if (crash > RIDE_RULES.crashAt) damageBoat(b, (crash - RIDE_RULES.crashAt) * RIDE_RULES.crashDmg * 10, null);
      if (b.gone) return;
    } else {
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
      for (let i = 0; i < steps; i++) { const nx = x + dx / steps, nz = z + dz / steps; if (!floats(terrain, nx, nz)) { ok = false; break; } x = nx; z = nz; }
    }
    // Speed, smoothed: two updates arriving together mustn't read as a burst of hundreds of mph.
    const inst = Math.min(def.speed * 1.3, Math.hypot(x - b.x, z - b.z) / Math.max(dt, 0.05));
    rt.speed += (inst - rt.speed) * (dt > 0.03 ? 0.6 : 0.3);
    rt.rev = (x - b.x) * Math.sin(msg.boat.yaw) + (z - b.z) * Math.cos(msg.boat.yaw) < -0.01;   // backing up
    b.x = x; b.z = z; b.yaw = msg.boat.yaw;
    if (!ok || Math.hypot(x - msg.boat.x, z - msg.boat.z) > (def.land ? 3 : 1.5)) send(p.ws, { t: 'boatFix', x, z, yaw: b.yaw });
    placeOccupants(b);
  }
  p.speed = rt.speed;
  if (rt.speed > 0.5) p.lastActive = now;
}
/** Boats, rides and landing posts within reach, as an interactable: { d, run }. */
function riverInteractable(p) {
  let best = null;
  for (const b of db.boats) {
    if (Math.abs(b.x - p.x) > 12 || Math.abs(b.z - p.z) > 12) continue;
    const def = BOATS[b.type];
    const d = def.land ? Math.hypot(b.x - p.x, b.z - p.z) - def.len / 2 : Math.hypot(b.x - p.x, b.z - p.z) - 1.5;
    if (d < (def.land ? 2.2 : RV.rules.boardRange) && (!best || d < best.d)) best = { d, run: () => boatInteract(p, b) };
  }
  for (const dk of map.docks) {
    const d = Math.hypot(dk.x - p.x, dk.z - p.z) - 0.4;
    if (d < 2.5 && (!best || d < best.d)) best = { d, run: () => send(p.ws, dockView(p, dk)) };
  }
  return best;
}
function boatInteract(p, b) {
  if (canUseBoat(p, b)) return boardBoat(p, b);
  if (rtOf(b).seats.some(Boolean)) return toast(p, `${boatName(b)} is taken. Not yours to get in.`);
  const def = BOATS[b.type];
  if (!b.owner) {
    // Found one: no keys in it means hotwiring it first.
    if (def.land && b.keys === false) { toast(p, `No keys. Hotwiring the ${rideWord(b)}…`); return startHack(p, 'hotwire', b.id, { ms: RIDE_RULES.hotwireMs }); }
    b.owner = p.token; b.ownerName = p.name;
    return boardBoat(p, b);
  }
  warnTeam(b.owner, `⚠ ${p.name} is ${def.animal ? 'taking' : 'hotwiring'} your ${rideWord(b)}`, b.x, b.z, def.land ? 'Ride theft' : 'Boat theft');
  return startHack(p, 'hotwire', b.id, def.land ? { ms: RIDE_RULES.hotwireMs } : {});
}
function finishHotwire(p, id) {
  const b = boatById(id), def = b && BOATS[b.type];
  if (!b || Math.hypot(b.x - p.x, b.z - p.z) > (def.land ? def.len / 2 + 4 : RV.rules.boardRange + 2)) return toast(p, def?.land ? 'It got away' : 'The boat drifted off');
  if (rtOf(b).seats.some(Boolean)) return toast(p, 'Someone got in first');
  const was = b.owner;
  if (was) warnTeam(was, `⚠ ${p.name} stole your ${rideWord(b)}`, b.x, b.z, def.land ? 'Ride stolen' : 'Boat stolen');
  b.owner = p.token; b.ownerName = p.name; b.keys = true;   // wires hanging out: it starts from now on
  if (was) award(p, def.land ? 25 : 60, def.land ? 'Stole a ride' : 'Hotwired a boat');
  send(p.ws, { t: 'hack', done: true, text: def.animal ? 'Saddled up' : 'Engine running' });
  boardBoat(p, b);
}
function openHold(p) {
  const b = p.boat ? boatById(p.boat) : db.boats.find((x) => canUseBoat(p, x) && Math.hypot(x.x - p.x, x.z - p.z) < RV.rules.boardRange + 1);
  if (!b || !canUseBoat(p, b)) return toast(p, 'No boat of yours here');
  if (!BOATS[b.type].hold) return toast(p, `Nowhere to carry anything on a ${rideWord(b)}`);
  p.openContainer = { kind: 'boat', id: b.id };
  send(p.ws, containerView(p, 'boat', b.id));
}
function damageBoat(b, dmg, by) {
  if (b.gone) return;
  b.hp -= dmg;
  const word = rideWord(b), land = isLand(b.type);
  if (b.owner && by && !tokenInSquadWith(by, b.owner) && (!b.alertedAt || Date.now() - b.alertedAt > 20_000) && !b.world) {
    b.alertedAt = Date.now();
    warnTeam(b.owner, `⚠ ${by.name} is shooting your ${word}`, b.x, b.z, land ? 'Ride under fire' : 'Boat under fire');
  }
  if (b.hp <= 0) sinkBoat(b, by);
}
function sinkBoat(b, by) {
  const def = BOATS[b.type], land = !!def.land;
  if (land) {
    // Wrecked: everyone aboard is thrown clear (a little hurt), the trunk spills, cars go up in flames.
    const spot = besideRide(b) || { x: b.x + 3, z: b.z, y: terrain.height(b.x + 3, b.z) };
    for (const o of boatOccupants(b)) {
      unseat(o);
      placeAt(o, spot.x, spot.z);
      if (!o.dead) applyDamage(o, def.animal || def.pedal || def.stand ? 10 : 25, by, false);
      toast(o, def.animal ? `Your ${def.name.toLowerCase()} went down. You were thrown clear.` : `The ${def.name.toLowerCase()} is wrecked. You got out.`);
    }
    if (!def.animal && !def.pedal && !def.stand) {
      const msg = JSON.stringify({ t: 'boom', x: b.x, y: rideY(b) + 0.8, z: b.z, r: 5 });
      for (const p of players.values()) if (p.ws.readyState === 1 && Math.abs(p.x - b.x) < INTEREST && Math.abs(p.z - b.z) < INTEREST) p.ws.send(msg);
    }
  } else {
    const spot = landingSpot(b.x, b.z, 90) || (() => { const d = nearestDock(b.x, b.z); return { x: d.x, z: d.z }; })();
    for (const o of boatOccupants(b)) { unseat(o); placeAt(o, spot.x, spot.z); toast(o, 'The boat went down. You swam for the bank.'); }
    b.spill = spot;
  }
  // Bulk freight goes down with her; everything else washes up on the bank (or spills in the road).
  const items = b.items.filter((i) => !i.bulk), at = land ? { x: b.x, z: b.z } : b.spill;
  if (items.length || RESOURCES.some((r) => b[r])) dropBag(at.x, at.z, items, Object.fromEntries(RESOURCES.map((r) => [r, b[r] || 0])), `Wreck of ${boatName(b)}`);
  removeBoat(b);
  if (b.owner && !b.world) warnTeam(b.owner, `⚠ Your ${rideWord(b)} ${land ? (def.animal ? 'went down' : 'was wrecked') : 'was sunk'}${by ? ` by ${by.name}` : ''}`, b.x, b.z, land ? 'Ride wrecked' : 'Boat sunk');
  if (!land) feed(by ? `${by.name} sank ${boatName(b)}` : `${boatName(b)} sank`);
  else if (by && b.ownerName && b.ownerName !== by.name) feed(`${by.name} wrecked ${boatName(b)}`);
  if (by && !by.isBot && b.owner && b.owner !== by.token && !tokenInSquadWith(by, b.owner)) award(by, land ? 50 : 150, land ? 'Wrecked a ride' : 'Sank a boat', true);
}

// ---- testing: any ride you ask for, put right beside you. One each (asking again takes the last one
// away if nobody's in it). Off with TEST_RIDES=0.
const TEST_RIDES = process.env.TEST_RIDES !== '0';
function testRide(p, type) {
  const def = own(RIDES, type);
  if (!TEST_RIDES || !def) return;
  if (p.boat || p.air || p.downed) return toast(p, 'Get out and on your feet first');
  const now = Date.now();
  if (now - (p.testRideAt || 0) < 1500) return;
  p.testRideAt = now;
  const old = p.testRideId && boatById(p.testRideId);
  if (old && !rtOf(old).seats.some(Boolean)) removeBoat(old);
  // Beside you on your right, then the left, ahead, behind; a little further out if those are blocked.
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), rx = -fz, rz = fx;
  const gap = def.wid / 2 + 1.4, r = Math.max(def.len, def.wid) / 2 + 0.2;
  for (const k of [1, 1.6, 2.4]) for (const [ox, oz] of [[rx * gap, rz * gap], [-rx * gap, -rz * gap], [fx * (def.len / 2 + 1.6), fz * (def.len / 2 + 1.6)], [-fx * (def.len / 2 + 1.6), -fz * (def.len / 2 + 1.6)]]) {
    const x = p.x + ox * k, z = p.z + oz * k, h = terrain.height(x, z);
    if (h < RIDE_RULES.shallow) continue;
    if (solidsNear(x, z, r + 2).some((sb) => !sb.gone && blocksAt(sb, h) && circleOverlapsBox(x, z, r, sb))) continue;
    const b = newBoat(type, x, z, p.yaw, p, { world: 1, color: def.colors[Math.floor(Math.random() * def.colors.length)], keys: true });
    b.y = h; b.yx = x; b.yz = z; b.usedAt = now; b.freeAt = now + RIDE_RULES.lockMs;
    p.testRideId = b.id;
    return toast(p, `${def.icon} ${def.name} beside you: walk up and press E`);
  }
  toast(p, 'No room here for that: try somewhere more open');
}

// ---- rides lying about the county: kept topped up, towed off when abandoned
const RIDE_TYPES = Object.keys(RIDES);
/** Clear ground for something `len` long at (x, z), facing `yaw`: dry, not too steep, nothing in the way, nothing parked there. */
function rideFits(type, x, z) {
  const def = RIDES[type], R = RIDE_RULES, edge = map.half - 20;
  if (Math.abs(x) > edge || Math.abs(z) > edge) return false;
  const h = terrain.height(x, z);
  if (h < R.shallow || inCamp(x, z)) return false;
  if (Math.abs(terrain.height(x + 2, z) - terrain.height(x - 2, z)) > 1.2 || Math.abs(terrain.height(x, z + 2) - terrain.height(x, z - 2)) > 1.2) return false;
  const r = Math.max(def.len, def.wid) / 2 + 0.3;
  for (const s of solidsNear(x, z, r + 2)) if (!s.gone && blocksAt(s, h) && circleOverlapsBox(x, z, r, s)) return false;
  for (const b of db.boats) if (Math.abs(b.x - x) < R.spacing && Math.abs(b.z - z) < R.spacing) return false;
  return true;
}
const coverAt = (x, z) => (terrain.cover ? terrain.cover(x, z) : 0);
/** Find somewhere a ride of this type would be left: cars on a road's shoulder, bikes and carts by
 *  a house, tractors and horses out in the fields, four-wheelers and dirt bikes in the woods. */
function rideSpot(type, around = null) {
  const def = RIDES[type], tries = around ? 40 : 60;
  const rnd = (r) => (Math.random() * 2 - 1) * r;
  for (let i = 0; i < tries; i++) {
    let x, z, yaw = Math.random() * Math.PI * 2;
    if (def.spawn === 'road' || (around && def.spawn !== 'field' && Math.random() < 0.4)) {
      const segs = around ? map.roadsNear(around.x, around.z, around.r) : null;
      const s = segs ? (segs.length ? segs[Math.floor(Math.random() * segs.length)] : null) : map.roads[Math.floor(Math.random() * map.roads.length)];
      if (!s) continue;
      const t = Math.random(), lx = s.x2 - s.x1, lz = s.z2 - s.z1, l = Math.hypot(lx, lz) || 1;
      const side = Math.random() < 0.5 ? -1 : 1, off = s.width / 2 + def.wid / 2 + 0.6;
      x = s.x1 + lx * t + (lz / l) * off * side; z = s.z1 + lz * t - (lx / l) * off * side;
      yaw = Math.atan2(lx, lz) + (Math.random() < 0.5 ? 0 : Math.PI);
    } else if (def.spawn === 'town') {
      const hs = around ? map.houses.filter((h) => h.kind !== 'vehicle' && Math.abs(h.x - around.x) < around.r && Math.abs(h.z - around.z) < around.r) : map.houses;
      const h = hs.length ? hs[Math.floor(Math.random() * hs.length)] : null;
      if (!h) { x = (around?.x ?? 0) + rnd(around?.r ?? map.half); z = (around?.z ?? 0) + rnd(around?.r ?? map.half); }
      else { const a = Math.random() * Math.PI * 2, d = 7 + Math.random() * 6; x = h.x + Math.cos(a) * d; z = h.z + Math.sin(a) * d; }
    } else {
      x = around ? around.x + rnd(around.r) : rnd(map.half - 40); z = around ? around.z + rnd(around.r) : rnd(map.half - 40);
      const c = coverAt(x, z);
      if (terrain.cover && !around) {
        if (def.spawn === 'field' && c !== COVER.grass && c !== COVER.crops && i < tries - 10) continue;
        if (def.spawn === 'trail' && c !== COVER.woods && c !== COVER.scrub && c !== COVER.grass && i < tries - 10) continue;
      }
    }
    if (rideFits(type, x, z)) return { x, z, yaw };
  }
  return null;
}
function spawnRide(type, around = null) {
  const def = RIDES[type], at = rideSpot(type, around);
  if (!at) return null;
  const b = newBoat(type, at.x, at.z, at.yaw, null, { world: 1, color: def.colors[Math.floor(Math.random() * def.colors.length)], keys: Math.random() < def.keys });
  b.y = terrain.height(at.x, at.z); b.yx = b.x; b.yz = b.z;
  return b;
}
let ridesNextAt = 0;
function tickRides(now) {
  if (now < ridesNextAt || process.env.RIDES === '0') return;
  ridesNextAt = now + RIDE_RULES.tickMs;
  const R = RIDE_RULES, alive = [...players.values()].filter((p) => !p.dead);
  const nearSomeone = (b, r) => alive.some((p) => Math.abs(p.x - b.x) < r && Math.abs(p.z - b.z) < r);
  // Locks run out; long-abandoned rides nobody's near get towed (their trunk left in a bag).
  for (const b of [...db.boats]) {
    if (!b.world) continue;
    const rt = rtOf(b);
    if (rt.seats.some(Boolean)) continue;
    if (b.owner && b.freeAt && now >= b.freeAt) { b.owner = null; b.ownerName = null; b.freeAt = null; }
    if (!b.owner && b.usedAt && now - b.usedAt > R.idleMs && !nearSomeone(b, R.idleRange)) {
      if (b.items.length) dropBag(b.x, b.z, b.items, {}, `Left in a ${rideWord(b)}`);
      removeBoat(b);
    }
  }
  // Top up each kind, a few a tick so a fresh world fills in its first minute or two.
  const have = {};
  for (const b of db.boats) if (b.world) have[b.type] = (have[b.type] || 0) + 1;
  // A fresh world gets the lot at once; after that a few a tick, a bit of each kind in turn.
  const total = Object.values(have).reduce((x, y) => x + y, 0), want = RIDE_TYPES.reduce((x, t) => x + RIDES[t].count, 0);
  let budget = total < want / 2 ? want : 40;
  const t0 = Date.now(), fill = budget > 40;
  for (let more = true; more && budget > 0;) {
    more = false;
    for (const t of RIDE_TYPES) if ((have[t] || 0) < RIDES[t].count && budget > 0) { budget--; have[t] = (have[t] || 0) + 1; spawnRide(t); more = true; }
  }
  // Always something to grab where people start out: every town and landing zone.
  for (const s of [...map.towns, ...map.landingZones]) {
    const free = db.boats.filter((b) => b.world && !b.owner && Math.abs(b.x - s.x) < R.nearRange && Math.abs(b.z - s.z) < R.nearRange).length;
    for (let k = free; k < R.nearSpawn; k++) {
      const pool = s.blocks !== undefined ? ['car', 'pickup', 'bicycle', 'golfcart', 'skateboard', 'motorcycle'] : ['atv', 'dirtbike', 'horse', 'pickup', 'bicycle'];
      spawnRide(pool[Math.floor(Math.random() * pool.length)], { x: s.x, z: s.z, r: R.nearRange * 0.8 });
    }
  }
  if (fill) console.log(`Rides: ${db.boats.filter((b) => b.world).length} cars, trucks, bikes and horses about the county (${Date.now() - t0} ms)`);
}

// Landings: buy, build and repair boats; river freight runs landing to landing.
const dockFreight = new Map();   // dock id -> { refreshAt, jobs: [{ id, to, toName, label, pay, km }] }
function dockJobs(d, now = Date.now()) {
  let e = dockFreight.get(d.id);
  if (!e || now >= e.refreshAt) {
    const others = map.docks.filter((o) => o.id !== d.id);
    e = { refreshAt: now + RV.freight.refreshMs, jobs: others.length ? Array.from({ length: RV.freight.perDock }, () => {
      const to = pick(others), km = Math.hypot(to.x - d.x, to.z - d.z) / 1000;
      return { id: uid('rf'), to: to.id, toName: to.name, label: pick(RV.freight.labels), pay: Math.round(RV.freight.base + km * RV.freight.perKm), km: +km.toFixed(1) };
    }) : [] };
    dockFreight.set(d.id, e);
  }
  return e.jobs;
}
const mooredAt = (b, d) => Math.hypot(b.x - d.wx, b.z - d.wz) < RV.rules.mooredAt;
function deliverRiverFreight(p, d) {
  let paid = 0, n = 0;
  for (const b of db.boats) {
    if (isLand(b.type) || !canUseBoat(p, b) || !mooredAt(b, d)) continue;
    const here = b.items.filter((i) => i.bulk && i.dest === d.id);
    if (!here.length) continue;
    b.items = b.items.filter((i) => !here.includes(i));
    for (const c of here) { paid += c.pay; n++; }
  }
  if (!n) return;
  p.cash = (p.cash || 0) + paid;
  award(p, RV.freight.xp * n, `River freight delivered (${n})`, true);
  toast(p, `Delivered ${n} load${n > 1 ? 's' : ''} of river freight: $${paid}`);
  dirty(p);
}
function dockView(p, d) {
  deliverRiverFreight(p, d);
  const here = db.boats.filter((b) => !isLand(b.type) && canUseBoat(p, b) && mooredAt(b, d));
  return {
    t: 'dock', id: d.id, name: d.name, camp: d.campId != null ? map.camps[d.campId].name : null, cash: p.cash || 0,
    shop: Object.entries(BOATS).filter(([, v]) => !v.land).map(([k, v]) => ({ type: k, name: v.name, price: v.price, craft: v.craft || null, about: v._about, seats: v.seats, hold: v.hold })),
    boats: here.map((b) => ({ id: b.id, name: BOATS[b.type].name, hp: Math.round(b.hp), max: BOATS[b.type].hp, repair: Math.ceil((BOATS[b.type].hp - b.hp) * RV.rules.repairPerHp), free: BOATS[b.type].hold - b.items.length,
      cargo: b.items.filter((i) => i.bulk).map((i) => ({ name: i.name, dest: i.destName })) })),
    freight: dockJobs(d), owned: db.boats.filter((b) => b.owner === p.token && !isLand(b.type)).length, maxOwned: RV.rules.maxBoatsEach,
  };
}
function launchSpot(d) {
  const tx = -d.nz, tz = d.nx;   // along the bank
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const x = d.wx + tx * k * 6, z = d.wz + tz * k * 6;
    if (floats(terrain, x, z) && !db.boats.some((b) => Math.hypot(b.x - x, b.z - z) < 5)) return { x, z };
  }
  return { x: d.wx, z: d.wz };
}
function dockAction(p, msg) {
  const d = nth(map.docks, msg.id);
  if (!d || Math.hypot(d.x - p.x, d.z - p.z) > 6) return;
  if (msg.action === 'buy') {
    const def = own(BOATS, msg.type);
    if (!def || def.land) return;
    if (db.boats.filter((b) => b.owner === p.token && !isLand(b.type)).length >= RV.rules.maxBoatsEach) return toast(p, `You can own ${RV.rules.maxBoatsEach} boats at a time`);
    if (msg.pay === 'craft') {
      if (!def.craft) return;
      if (!payCarried(p, def.craft)) return toast(p, `Building one takes ${costText(def.craft)}`);
    } else {
      if ((p.cash || 0) < def.price) return toast(p, `A ${def.name.toLowerCase()} costs $${def.price}`);
      p.cash -= def.price;
    }
    const at = launchSpot(d);
    newBoat(msg.type, at.x, at.z, Math.atan2(-d.nx, -d.nz), p);
    toast(p, `Your ${def.name.toLowerCase()} is in the water at the end of the jetty`);
  } else if (msg.action === 'repair') {
    const b = boatById(msg.boat);
    if (!b || !canUseBoat(p, b) || !mooredAt(b, d)) return;
    const cost = Math.ceil((BOATS[b.type].hp - b.hp) * RV.rules.repairPerHp);
    if (!cost) return;
    if ((p.cash || 0) < cost) return toast(p, `Repairs cost $${cost}`);
    p.cash -= cost; b.hp = BOATS[b.type].hp;
    toast(p, `Patched up for $${cost}`);
  } else if (msg.action === 'freight') {
    const e = dockFreight.get(d.id);
    const job = e?.jobs.find((j) => j.id === msg.job);
    if (!job) return toast(p, 'That job is gone');
    const boats = db.boats.filter((b) => !isLand(b.type) && canUseBoat(p, b) && mooredAt(b, d) && b.items.length < BOATS[b.type].hold).sort((a, b) => (b.id === p.boat) - (a.id === p.boat));
    if (!boats.length) return toast(p, 'Bring a boat with room in its hold to this landing first');
    const b = boats[0];
    b.items.push({ id: uid('freight'), kind: 'cargo', bulk: true, name: `${job.label} → ${job.toName}`, dest: job.to, destName: job.toName, pay: job.pay, from: d.id });
    e.jobs = e.jobs.filter((j) => j !== job);
    toast(p, `${job.label} loaded into your ${BOATS[b.type].name.toLowerCase()}. Take it to ${job.toName}.`);
  }
  dirty(p);
  send(p.ws, dockView(p, d));
}

// River traders: a dockhand at every town landing, a camp trader at every swamp camp.
const traderPosts = map.docks.map((d) => {
  const camp = d.campId != null ? map.camps[d.campId] : null;
  const x = camp ? camp.x : d.x - d.nz * 4 + d.nx * 2, z = camp ? camp.z : d.z + d.nx * 4 + d.nz * 2;
  const at = resolveCircle(x, z, PLAYER_RADIUS, solidsNear(x, z, 3), terrain.height(x, z));
  return { dock: d, camp, x: at.x, z: at.z, bot: null };
});
function keepTraders() {
  const alive = [...players.values()].filter((p) => !p.dead && !p.deploying);
  // Lamar minds the shop whenever anyone's nearby.
  for (const sh of map.shops || []) {
    const b = sh.bot && bots.get(sh.bot), k = sh.keeper;
    const near = (r) => alive.some((p) => Math.abs(p.x - k.x) < r && Math.abs(p.z - k.z) < r);
    if (b && !near(600)) { bots.delete(b.id); sh.bot = null; }
    else if (!b && near(400)) {
      const n = { id: uid('pw'), name: PAWN.keeper, isBot: true, npc: true, kind: 'pawn', shop: sh.id, serial: botSerial++, x: k.x, z: k.z, homeX: k.x, homeZ: k.z, yaw: k.yaw, hp: 500, maxHp: 500, dead: false };
      bots.set(n.id, n);
      sh.bot = n.id;
    }
  }
  traderPosts.forEach((t, i) => {
    const b = t.bot && bots.get(t.bot);
    const near = (r) => alive.some((p) => Math.abs(p.x - t.x) < r && Math.abs(p.z - t.z) < r);
    if (b && !near(600)) { bots.delete(b.id); t.bot = null; return; }
    if (!b && near(400)) {
      const n = { id: uid('t'), name: t.camp ? 'Camp trader' : 'Dockhand', isBot: true, npc: true, kind: 'trader', post: i, serial: botSerial++, x: t.x, z: t.z, homeX: t.x, homeZ: t.z, yaw: Math.atan2(t.dock.wx - t.x, t.dock.wz - t.z), hp: 500, maxHp: 500, dead: false };
      bots.set(n.id, n);
      t.bot = n.id;
    }
  });
}
// A camp only has so much to sell: it holds an hour's worth of what it makes and restocks steadily,
// and that stock is shared by everyone who comes to buy.
const campStock = new Map();   // trader post -> { good: { n, at } }
function campStockOf(post, good, now = Date.now()) {
  const per = RV.camps.trader.stockPerHour?.[good];
  if (!per) return null;
  let s = campStock.get(post);
  if (!s) campStock.set(post, (s = {}));
  const e = s[good] || (s[good] = { n: per, at: now });
  e.n = Math.min(per, e.n + ((now - e.at) / 3_600_000) * per);
  e.at = now;
  return e;
}
function traderView(b) {
  const t = traderPosts[b.post];
  const G = (g) => HOMESTEAD.goods[g]?.name || g;
  if (t.camp) {
    const T = RV.camps.trader;
    return { town: t.camp.name, who: b.name,
      sells: Object.entries(T.pays).filter(([g, m]) => m > 0 && ECONOMY.prices[g]).map(([g, m]) => ({ good: g, pays: Math.max(1, Math.round(ECONOMY.prices[g] * m)), name: G(g) })),
      shop: [...Object.entries(T.sellsCheap).map(([g, price]) => { const left = Math.floor(campStockOf(b.post, g)?.n ?? Infinity); return { id: g, name: Number.isFinite(left) ? `${G(g)} (${left} left)` : G(g), price, qty: 1 }; }), ...Object.entries(T.shop).map(([k, price]) => ({ id: k, name: ECONOMY.shop[k]?.name || G(k), price, qty: ECONOMY.shop[k]?.qty || 1 }))] };
  }
  const town = map.towns[t.dock.townId]?.name;
  return { town: `${town} landing`, who: b.name,
    sells: Object.keys(ECONOMY.prices).map((g) => ({ good: g, pays: Math.max(1, Math.floor(ECONOMY.prices[g] * (ECONOMY.towns[town]?.[g] ?? 1) * 0.9)), name: G(g) })),
    shop: ['ammo', 'rod', 'medkit'].map((k) => ({ id: k, name: ECONOMY.shop[k].name || k, price: ECONOMY.shop[k].price, qty: ECONOMY.shop[k].qty || 1 })) };
}

// ---- commerce: freight (haul jobs), player stalls, the market board, player-to-player trades
const hauls = new Map();   // contactId -> [{ id, from, to, toTown, label, pay }]
let haulsAt = 0;
function refreshHauls(now) {
  if (now - haulsAt < COM.haul.refreshMs && hauls.size) return;
  haulsAt = now;
  hauls.clear();
  for (const c of map.contacts) {
    const list = [];
    for (let i = 0; i < COM.haul.perPost; i++) {
      const to = pick(map.contacts.filter((o) => o.id !== c.id));
      const km = Math.hypot(to.x - c.x, to.z - c.z) / 1000;
      const good = pick(['corn', 'peanuts', 'cotton', 'fish', 'meat', 'parts', 'tech', 'salvage']);
      list.push({ id: uid('h'), from: c.id, to: to.id, toTown: postTown(to.id), label: `${HOMESTEAD.goods[good]?.name || good} freight`, pay: Math.round(COM.haul.base + km * COM.haul.perKm) });
    }
    hauls.set(c.id, list);
  }
}
const hasCargo = (p) => p.inv.pack.some((i) => i.kind === 'cargo');
function takeHaul(p, msg) {
  const ct = nth(map.contacts, msg.contactId);
  if (!ct || Math.hypot(ct.x - p.x, ct.z - p.z) > 6) return;
  const list = hauls.get(ct.id) || [];
  const job = list.find((j) => j.id === msg.id);
  if (!job) return toast(p, 'That job has been taken');
  if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
  list.splice(list.indexOf(job), 1);
  p.inv.pack.push({ id: uid('cargo'), kind: 'cargo', name: `${job.label} → ${job.toTown}`, dest: job.to, destTown: job.toTown, pay: job.pay });
  toast(p, `Freight loaded: take it to ${job.toTown}'s trading post for $${job.pay}. No helicopters or fast travel with freight.`);
  dirty(p);
  send(p.ws, contactView(p, ct.id));
}
function deliverCargo(p, contactId) {
  const mine = p.inv.pack.filter((i) => i.kind === 'cargo' && i.dest === contactId);
  if (!mine.length) return;
  let pay = 0;
  for (const c of mine) pay += c.pay;
  p.inv.pack = p.inv.pack.filter((i) => !mine.includes(i));
  p.cash = (p.cash || 0) + pay;
  award(p, COM.haul.xp * mine.length, 'Freight delivered');
  toast(p, `📦 Delivered ${mine.length} freight load${mine.length > 1 ? 's' : ''}: +$${pay}`);
  dirty(p);
}
function stallView(p, st) {
  const mine = canManage(p, st);
  return { t: 'contact', id: null, stall: st.id, name: mine ? 'Your market stall' : `${st.ownerName}'s market stall`, offers: [], active: [], comms: p.comms,
    stallData: { mine, till: mine ? st.till || 0 : null, listings: (st.listings || []).map((l, i) => ({ i, res: l.res, qty: l.qty, price: l.price, name: HOMESTEAD.goods[l.res]?.name || l.res })), max: COM.stall.maxListings } };
}
function stallAction(p, msg) {
  const st = structs.get(msg.id);
  if (!st || !PIECES[st.type].stall || boxDist(structBox(st), p.x, p.z) > INTERACT_RANGE + 1) return;
  st.listings ??= []; st.till ??= 0;
  const mine = canManage(p, st);
  if (msg.action === 'list' && mine) {
    const res = String(msg.res), qty = Math.floor(Number(msg.qty)), price = Math.floor(Number(msg.price));
    if (!RESOURCES.includes(res) || res === 'cash' || res === 'intel') return;
    if (!(qty > 0) || (p[res] || 0) < qty) return toast(p, 'You don\'t have that many');
    if (!(price > 0) || price > COM.stall.maxPrice) return toast(p, 'Set a price per unit');
    if (st.listings.length >= COM.stall.maxListings) return toast(p, 'The stall is full');
    p[res] -= qty;
    const same = st.listings.find((l) => l.res === res && l.price === price);
    if (same) same.qty += qty; else st.listings.push({ res, qty, price });
  } else if (msg.action === 'unlist' && mine) {
    const l = nth(st.listings, msg.i);
    if (!l) return;
    p[l.res] = (p[l.res] || 0) + l.qty;
    st.listings.splice(msg.i, 1);
  } else if (msg.action === 'collect' && mine) {
    if (!Number.isFinite(st.till)) st.till = 0;
    p.cash = (p.cash || 0) + st.till;
    toast(p, `Collected $${st.till}`);
    st.till = 0;
  } else if (msg.action === 'buy') {
    const l = nth(st.listings, msg.i);
    if (!l) return toast(p, 'Sold out');
    const qty = Math.min(l.qty, Math.max(1, msg.qty === 'all' ? l.qty : Math.floor(Number(msg.qty) || 1)));
    const cost = qty * l.price;
    if (!(qty > 0) || !Number.isFinite(cost)) return;
    if ((p.cash || 0) < cost) return toast(p, `That's $${cost} — you have $${p.cash || 0}`);
    p.cash -= cost; p[l.res] = (p[l.res] || 0) + qty;
    st.till += cost; l.qty -= qty;
    if (!l.qty) st.listings.splice(msg.i, 1);
    toast(p, `Bought ${qty} ${HOMESTEAD.goods[l.res]?.name || l.res} for $${cost}`);
    const owner = onlineByToken(st.owner);
    if (owner && owner !== p) toast(owner, `💰 ${p.name} bought ${qty} ${HOMESTEAD.goods[l.res]?.name || l.res} at your stall (+$${cost})`);
    else logAway(st.owner, `${p.name} bought ${qty} ${HOMESTEAD.goods[l.res]?.name || l.res} at your stall for $${cost}`, false);
  } else return;
  dirty(p);
  send(p.ws, stallView(p, st));
}
/** Every stall's listings, for the market board at trading posts. */
function marketBoard(fromX, fromZ) {
  const rows = [];
  for (const st of structs.values()) {
    if (!PIECES[st.type].stall || !(st.listings || []).length) continue;
    const near = map.towns.reduce((a, t) => (!a || Math.hypot(t.x - st.x, t.z - st.z) < Math.hypot(a.x - st.x, a.z - st.z) ? t : a), null);
    for (const l of st.listings) rows.push({ seller: st.ownerName, res: l.res, name: HOMESTEAD.goods[l.res]?.name || l.res, qty: l.qty, price: l.price, x: Math.round(st.x), z: Math.round(st.z), near: near?.name || '', dist: Math.round(Math.hypot(st.x - fromX, st.z - fromZ)) });
  }
  return rows.sort((a, b) => a.res.localeCompare(b.res) || a.price - b.price).slice(0, 40);
}
// Face-to-face trades: both sides put up goods/items/cash, both confirm, then it swaps at once.
const trades = new Map();   // token -> session
function tradeEmpty() { return { res: {}, items: [] }; }
function tradePush(sess) {
  for (const [me, them] of [[sess.a, sess.b], [sess.b, sess.a]]) {
    const pm = onlineByToken(me), pt = onlineByToken(them);
    if (!pm) continue;
    const show = (o, owner) => ({ res: o.res, items: o.items.map((id) => owner.inv.pack.find((i) => i.id === id)).filter(Boolean) });
    send(pm.ws, { t: 'ptrade', state: 'open', with: pt?.name, you: show(sess.offer[me], pm), them: pt ? show(sess.offer[them], pt) : tradeEmpty(), youOk: !!sess.ok[me], themOk: !!sess.ok[them] });
  }
}
function tradeClose(sess, why) {
  for (const tok of [sess.a, sess.b]) { trades.delete(tok); const o = onlineByToken(tok); if (o) send(o.ws, { t: 'ptrade', state: 'closed', why }); }
}
function playerTrade(p, msg) {
  const now = Date.now();
  if (msg.action === 'request') {
    const t = players.get(msg.id);
    if (!t || t === p || t.dead || Math.hypot(t.x - p.x, t.z - p.z) > COM.trade.range) return toast(p, 'Get closer to trade');
    if (trades.has(t.token)) return toast(p, `${t.name} is busy trading`);
    t.tradeAsk = { from: p.token, until: now + 30_000 };
    send(t.ws, { t: 'ptrade', state: 'ask', from: p.name, fromId: p.id });
    return toast(p, `Asked ${t.name} to trade`);
  }
  if (msg.action === 'accept') {
    const ask = p.tradeAsk;
    p.tradeAsk = null;
    const o = ask && ask.until > now && onlineByToken(ask.from);
    if (!o || Math.hypot(o.x - p.x, o.z - p.z) > COM.trade.range) return toast(p, 'They\'re gone');
    if (trades.has(o.token) || trades.has(p.token)) return toast(p, 'Already trading');
    const sess = { a: o.token, b: p.token, offer: { [o.token]: tradeEmpty(), [p.token]: tradeEmpty() }, ok: {} };
    trades.set(o.token, sess); trades.set(p.token, sess);
    return tradePush(sess);
  }
  const sess = trades.get(p.token);
  if (!sess) return;
  const otherTok = sess.a === p.token ? sess.b : sess.a, other = onlineByToken(otherTok);
  if (msg.action === 'cancel' || !other || Math.hypot(other.x - p.x, other.z - p.z) > COM.trade.range + 2) return tradeClose(sess, msg.action === 'cancel' ? `${p.name} cancelled` : 'Too far apart');
  if (msg.action === 'offer') {
    const res = {};
    for (const [k, v] of Object.entries(msg.res || {})) { const n = Math.floor(Number(v)); if (RESOURCES.includes(k) && n > 0) res[k] = Math.min(n, p[k] || 0); }
    const items = [...new Set(Array.isArray(msg.items) ? msg.items : [])].filter((id) => p.inv.pack.some((i) => i.id === id && i.kind !== 'cargo')).slice(0, PACK_SIZE);
    sess.offer[p.token] = { res, items };
    sess.ok = {};   // any change needs both to confirm again
    return tradePush(sess);
  }
  if (msg.action === 'confirm') {
    sess.ok[p.token] = true;
    if (!sess.ok[otherTok]) return tradePush(sess);
    // Both confirmed: check everything is still there, then swap.
    const A = onlineByToken(sess.a), B = onlineByToken(sess.b);
    const valid = (who, o) => Object.entries(o.res).every(([k, v]) => (who[k] || 0) >= v) && o.items.every((id) => who.inv.pack.some((i) => i.id === id));
    const oa = sess.offer[sess.a], ob = sess.offer[sess.b];
    if (!valid(A, oa) || !valid(B, ob)) return tradeClose(sess, 'Something changed — trade cancelled');
    if (A.inv.pack.length - oa.items.length + ob.items.length > PACK_SIZE || B.inv.pack.length - ob.items.length + oa.items.length > PACK_SIZE) return tradeClose(sess, 'Not enough backpack space');
    const move = (from, to, o) => {
      for (const [k, v] of Object.entries(o.res)) { from[k] -= v; to[k] = (to[k] || 0) + v; }
      for (const id of o.items) { const i = from.inv.pack.findIndex((x) => x.id === id); to.inv.pack.push(from.inv.pack.splice(i, 1)[0]); }
    };
    move(A, B, oa); move(B, A, ob);
    dirty(A); dirty(B);
    tradeClose(sess, 'Trade complete');
  }
}

// ---- defenses: tripwires, motion alarms, sentry guns, guard dogs. They work while you're offline.
const isDefense = (st) => !!PIECES[st.type].defense;
function hostilesNear(st, r) {
  const out = [];
  for (const p of players.values()) {
    if (p.dead || p.deploying || tokenInSquadWith(p, st.owner) || (p.protectedUntil || 0) > Date.now()) continue;
    if (Math.hypot(p.x - st.x, p.z - st.z) <= r) out.push(p);
  }
  for (const b of bots.values()) {
    if (b.dead || b.animal || b.npc || b.dog) continue;
    if (Math.hypot(b.x - st.x, b.z - st.z) <= r) out.push(b);
  }
  return out;
}
const sentryWeapon = { ...weaponStats(makeWeapon('carbine')), damage: DEF.sentry.damage };
const MINE_BLAST = { radius: 0, damage: 0, playerRadius: DEF.mine.playerRadius, playerDamage: DEF.mine.playerDamage };
function mineBlast(st, who) {
  if (!structs.has(st.id)) return;
  removeStruct(st, true);
  explode({ id: st.id, x: st.x, y: st.y0 || terrain.height(st.x, st.z), z: st.z, owner: st.owner, ownerName: st.ownerName }, Date.now(), MINE_BLAST);
  if (who && !who.isBot) toast(who, '💥 Land mine!');
  warnTeam(st.owner, `⚠ A land mine went off at your base${who ? ` (${who.name})` : ''}`, st.x, st.z, 'Land mine');
}
const jammed = (st, now) => (st.jammedUntil || 0) > now;
function tickDefenses(now) {
  for (const st of structs.values()) {
    const kind = PIECES[st.type].defense;
    if (!kind) continue;
    if (kind === 'mine') {
      const hit = hostilesNear(st, DEF.mine.trigger).find((c) => !c.air);
      if (hit) mineBlast(st, hit);
      continue;
    }
    if (kind === 'tripwire') {
      if ((st.rearmAt || 0) > now) continue;
      const b = structBox(st);
      // Jumping clears it: only feet on the ground catch the wire.
      const hit = hostilesNear(st, 4).find((c) => !c.hop && !c.air && c.x > b.minX - 0.45 && c.x < b.maxX + 0.45 && c.z > b.minZ - 0.45 && c.z < b.maxZ + 0.45);
      if (!hit) continue;
      st.rearmAt = now + DEF.tripwire.rearmMs;
      stun(hit, DEF.tripwire.stunMs, null);
      if (!hit.isBot) { exposeToTeam(hit, st.owner, DEF.tripwire.exposeMs); toast(hit, '⚡ You tripped a wire!'); }
      warnTeam(st.owner, `⚠ ${hit.name} tripped your wire`, st.x, st.z, 'Tripwire');
    } else if (kind === 'alarm') {
      if ((st.alarmAt || 0) > now || jammed(st, now)) continue;
      const hit = hostilesNear(st, DEF.alarm.radius).find((c) => c.isBot || !camoActive(c));
      if (!hit) continue;
      st.alarmAt = now + DEF.alarm.cooldownMs;
      // The siren: everyone nearby hears it, the intruder included.
      for (const o of players.values()) if (!o.dead && Math.hypot(o.x - st.x, o.z - st.z) < DEF.alarm.sirenRange) send(o.ws, { t: 'siren', x: st.x, y: (st.y0 || 0) + 1.2, z: st.z, id: st.id });
      if (!hit.isBot) exposeToTeam(hit, st.owner, DEF.alarm.exposeMs);
      warnTeam(st.owner, `⚠ Motion alarm: ${hit.name} at your camp`, st.x, st.z, 'Motion alarm');
    } else if (kind === 'sentry') {
      if (!(st.ammo > 0) || (st.nextShot || 0) > now || jammed(st, now)) continue;
      const eye = st.y0 + 1.3;
      let target = null, td = DEF.sentry.range;
      for (const c of hostilesNear(st, DEF.sentry.range)) {
        const d = Math.hypot(c.x - st.x, c.z - st.z);
        if (d < td && lineOfSight(st.x, eye, st.z, c.x, gy(c) + 1.2, c.z)) { td = d; target = c; }
      }
      if (!target) continue;
      st.nextShot = now + 60_000 / DEF.sentry.rpm;
      st.ammo--;
      const shooter = { id: st.id, name: `${st.ownerName}'s sentry`, isBot: true, x: st.x, z: st.z, crouch: true, weapon: sentryWeapon };
      fire(shooter, [target.x - st.x, gy(target) + 1.1 - eye, target.z - st.z], true, 1.4);
      if (!st.warned || now - st.warned > 30_000) { st.warned = now; warnTeam(st.owner, `⚠ Your sentry is firing at ${target.name}`, st.x, st.z, 'Sentry'); }
    } else if (kind === 'kennel') {
      // Hungry dogs don't guard. One meal an hour.
      if ((st.fedUntil || 0) < now && (st.meat || 0) > 0) { st.meat--; st.fedUntil = now + DEF.kennel.mealEveryMs; }
      const fed = (st.fedUntil || 0) > now;
      const dog = st.dog && bots.get(st.dog);
      const someone = [...players.values()].some((p) => !p.dead && Math.hypot(p.x - st.x, p.z - st.z) < DEF.kennel.activeWithin);
      if (dog && (!fed || !someone)) { bots.delete(dog.id); st.dog = null; continue; }
      if (!dog && fed && someone && (st.dogDeadUntil || 0) <= now) {
        const d = { id: uid('dog'), name: `${st.ownerName}'s dog`, isBot: true, dog: true, kind: 'dog', owner: st.owner, kennel: st.id, serial: botSerial++, x: st.x + 1.5, z: st.z + 1.5, homeX: st.x, homeZ: st.z, yaw: 0, hp: DEF.kennel.dogHp, maxHp: DEF.kennel.dogHp, dead: false, wander: null };
        bots.set(d.id, d);
        st.dog = d.id;
      }
    }
  }
}
function updateDog(b, dt, now) {
  const K = DEF.kennel;
  const st = structs.get(b.kennel);
  if (!st) { bots.delete(b.id); return; }
  let target = null, td = K.guardRange;
  for (const c of hostilesNear(st, K.chaseRange)) {
    const d = Math.hypot(c.x - st.x, c.z - st.z);
    if (d < td || (b.target === c.id && d < K.chaseRange)) { td = d; target = c; }
  }
  let gx, gz, speed;
  if (target) {
    if (b.target !== target.id) { b.target = target.id; warnTeam(st.owner, `⚠ Your dog is going after ${target.name}`, st.x, st.z, 'Guard dog'); }
    gx = target.x; gz = target.z; speed = K.speed;
    if (Math.hypot(target.x - b.x, target.z - b.z) < 1.7 && now >= (b.nextBite || 0)) {
      b.nextBite = now + K.biteEveryMs;
      applyDamage(target, K.bite, b, !!target.isBot);
    }
  } else {
    b.target = null;
    if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1 || Math.random() < 0.01) b.wander = { x: st.x + (Math.random() - 0.5) * 24, z: st.z + (Math.random() - 0.5) * 24 };
    gx = b.wander.x; gz = b.wander.z; speed = 2;
  }
  const dx = gx - b.x, dz = gz - b.z, d = Math.hypot(dx, dz);
  if (d < 1.2) return;
  const step = speed * dt;
  const np = moveWithCollision(b.x, b.z, dx / d * step, dz / d * step, 0.4, solidsNear(b.x, b.z, step + 2), terrain);
  b.x = np.x; b.z = np.z; b.yaw = Math.atan2(dx, dz);
}
function defenseInteract(p, st) {
  const kind = PIECES[st.type].defense;
  if (kind === 'sentry') {
    const room = DEF.sentry.maxAmmo - (st.ammo || 0);
    const n = Math.min(room, p.ammo, DEF.sentry.loadAtOnce);
    if (!n) return toast(p, room ? 'You have no ammo to load' : `Sentry full (${st.ammo} rounds)`);
    p.ammo -= n; st.ammo = (st.ammo || 0) + n;
    toast(p, `Loaded ${n} rounds — sentry has ${st.ammo}`);
    return dirty(p);
  }
  if (kind === 'kennel') {
    const room = DEF.kennel.maxMeat - (st.meat || 0);
    const n = Math.min(room, p.meat || 0);
    if (!n) return toast(p, room ? 'Bring raw meat to feed your dog (hunt deer and hogs)' : `The kennel's full (${st.meat} meat)`);
    p.meat -= n; st.meat = (st.meat || 0) + n;
    toast(p, `Fed the kennel ${n} meat — enough for ${st.meat + ((st.fedUntil || 0) > Date.now() ? 1 : 0)} hours`);
    return dirty(p);
  }
  if (kind === 'tripwire') return toast(p, (st.rearmAt || 0) > Date.now() ? 'Tripwire re-arming…' : 'Tripwire armed');
  if (kind === 'alarm') return toast(p, `Motion alarm on — it watches ${feet(DEF.alarm.radius)} around it`);
}

// ---------------------------------------------------------------- crews ("leadership")
// A crew is a permanent team: it's saved with the world and survives logging off. It has a name,
// a leader, officers and members. Everything team-related keys off it: shared tags and sensors, no
// friendly fire, the shared stash house, revives, team hacking, crew contracts and the crew board.
// (The code still calls them squads in places; it's the same thing.)
// Members are shown to other players by a public id derived from their secret login token.
const pubId = (token) => crypto.createHash('sha256').update(`crew:${token}`).digest('hex').slice(0, 12);
function crewName(raw) { return String(raw || '').replace(/[^\w '\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20); }
function charName(token) { return onlineByToken(token)?.name || db.characters[token]?.name || 'Agent'; }
function rankOf(s, token) { return s.leader === token ? 'leader' : s.officers.has(token) ? 'officer' : 'member'; }
function squadOf(p) { return squads.get(squadOfToken.get(p.token)) || null; }
function squadKey(p) { return squadOfToken.get(p.token) || `solo:${p.token}`; }
function sameSquad(a, b) {
  if (!a || !b || a.isBot || b.isBot) return false;
  if (a.token === b.token) return true;
  const s = squadOfToken.get(a.token);
  return !!s && s === squadOfToken.get(b.token);
}
function tokenInSquadWith(p, token) { return token === p.token || (!!squadOfToken.get(p.token) && squadOfToken.get(p.token) === squadOfToken.get(token)); }
function onlineByToken(token) { for (const p of players.values()) if (p.token === token) return p; return null; }
function squadMembersOnline(p) {
  const s = squadOf(p);
  if (!s) return [p];
  return [...s.members].map(onlineByToken).filter(Boolean);
}
function crewOnline(s) { return [...s.members].map(onlineByToken).filter(Boolean); }
function sendSquad(p, msg) { for (const m of squadMembersOnline(p)) send(m.ws, msg); }
function sendCrew(s, msg) { for (const m of crewOnline(s)) send(m.ws, msg); }
function tokenByPub(s, pid) { return [...s.members].find((t) => pubId(t) === pid) || null; }
function crewView(s) {
  const leader = onlineByToken(s.leader);
  return {
    t: 'squad', id: s.id, name: s.name, leaderId: leader?.id ?? null, score: Math.round(s.score || 0),
    members: [...s.members].map((tok) => {
      const m = onlineByToken(tok), c = m || db.characters[tok] || {};
      return { pid: pubId(tok), id: m?.id ?? null, online: !!m, name: charName(tok), level: levelFromXp(c.xp || 0), rank: rankOf(s, tok), x: m ? Math.round(m.x) : null, z: m ? Math.round(m.z) : null };
    }),
  };
}
function pushSquadState(s) {
  const view = crewView(s);
  for (const m of crewOnline(s)) send(m.ws, { ...view, myRank: rankOf(s, m.token) });
}
function newCrew(founder, name) {
  const s = { id: uid('crew') + crypto.randomBytes(3).toString('hex'), name, leader: founder.token, officers: new Set(), members: new Set([founder.token]), score: 0, created: Date.now() };
  squads.set(s.id, s);
  squadOfToken.set(founder.token, s.id);
  crewCreated(s, founder);
  dirty(founder);
  return s;
}
function nameTaken(name, except) { const n = name.toLowerCase(); return [...squads.values()].some((s) => s !== except && s.name.toLowerCase() === n); }
function freeCrewName(base) { let n = crewName(base) || 'Crew', k = 2; while (nameTaken(n)) n = `${crewName(base).slice(0, 17)} ${k++}`; return n; }
/** Remove a member (online or not). Hands leadership on; an emptied crew is disbanded. */
function removeMember(s, token, reason = 'left') {
  s.members.delete(token);
  s.officers.delete(token);
  squadOfToken.delete(token);
  const gone = onlineByToken(token);
  if (gone) { send(gone.ws, { t: 'squad', id: null, members: [] }); dirty(gone); }
  crewMemberLeft(s, token);
  if (!s.members.size) { crewDisbanded(s); squads.delete(s.id); return; }
  sendCrew(s, { t: 'toast', text: `${charName(token)} ${reason} the crew` });
  if (s.leader === token) {
    // Longest-serving officer first, then anyone.
    s.leader = [...s.officers][0] || [...s.members][0];
    s.officers.delete(s.leader);
    sendCrew(s, { t: 'toast', text: `${charName(s.leader)} now leads the crew` });
  }
  pushSquadState(s);
  for (const m of crewOnline(s)) dirty(m);
}
function leaveSquad(p, reason = 'left') { const s = squadOf(p); if (s) removeMember(s, p.token, reason); }
function squadAction(p, msg) {
  const now = Date.now();
  const s = squadOf(p);
  const rank = s ? rankOf(s, p.token) : null;
  const target = msg.id ? players.get(msg.id) : msg.name ? [...players.values()].find((o) => o.name.toLowerCase() === String(msg.name).toLowerCase()) || null : null;
  // Members can be named by their public id (works for offline members) or, if online, by player id.
  const targetTok = s && (msg.pid ? tokenByPub(s, msg.pid) : target && s.members.has(target.token) ? target.token : null);
  if (msg.action === 'create') {
    if (s) return toast(p, 'Leave your crew first');
    const name = crewName(msg.name);
    if (name.length < 3) return toast(p, 'Crew names need at least 3 letters');
    if (nameTaken(name)) return toast(p, `There's already a crew called ${name}`);
    pushSquadState(newCrew(p, name));
    feed(`${p.name} founded the crew ${name}`);
  } else if (msg.action === 'rename') {
    if (!s || rank !== 'leader') return toast(p, 'Only the crew leader can rename the crew');
    const name = crewName(msg.name);
    if (name.length < 3) return toast(p, 'Crew names need at least 3 letters');
    if (nameTaken(name, s)) return toast(p, `There's already a crew called ${name}`);
    s.name = name;
    pushSquadState(s);
  } else if (msg.action === 'invite') {
    if (!target || target === p) return;
    if (s && rank === 'member') return toast(p, 'Only the leader and officers can invite');
    if (s && s.members.size >= SQUAD_MAX) return toast(p, `Crews are capped at ${SQUAD_MAX}`);
    if (squadOf(target)) return toast(p, `${target.name} is already in a crew`);
    invites.set(target.token, { fromToken: p.token, fromName: p.name, crewName: s?.name || null, expires: now + 60_000 });
    send(target.ws, { t: 'invite', fromId: p.id, fromName: p.name, crewName: s?.name || null });
    toast(p, `Invited ${target.name}`);
  } else if (msg.action === 'accept') {
    const inv = invites.get(p.token);
    invites.delete(p.token);
    if (!inv || inv.expires < now) return toast(p, 'Invite expired');
    const inviter = onlineByToken(inv.fromToken);
    if (!inviter) return toast(p, 'Inviter went offline');
    let cs = squadOf(inviter);
    if (cs === s && s) return;
    if (cs && cs.members.size >= SQUAD_MAX) return toast(p, 'That crew is full');
    leaveSquad(p);
    if (!cs) cs = newCrew(inviter, freeCrewName(`${inviter.name}'s Crew`));
    cs.members.add(p.token);
    squadOfToken.set(p.token, cs.id);
    crewMemberJoined(cs, p);
    sendCrew(cs, { t: 'toast', text: `${p.name} joined ${cs.name}` });
    pushSquadState(cs);
    for (const m of crewOnline(cs)) dirty(m);
  } else if (msg.action === 'ticket') {
    // A one-time pass for a friend invited from the lobby / friends list: whoever joins this
    // world with it lands in your crew (or starts one with you).
    // Ordinary members can still invite friends to the world, just not straight into the crew.
    if (s && rank === 'member') return send(p.ws, { t: 'crewTicket', ticket: null, for: String(msg.for || '') });
    for (const [k, v] of crewTickets) if (v.expires < now) crewTickets.delete(k);
    const ticket = crypto.randomBytes(9).toString('hex');
    crewTickets.set(ticket, { fromToken: p.token, fromName: p.name, expires: now + 15 * 60_000 });
    send(p.ws, { t: 'crewTicket', ticket, for: String(msg.for || '') });
  } else if (msg.action === 'decline') {
    invites.delete(p.token);
  } else if (msg.action === 'leave') {
    leaveSquad(p);
  } else if (msg.action === 'kick') {
    if (!s || !targetTok || targetTok === p.token) return;
    const tr = rankOf(s, targetTok);
    if (rank === 'member' || (rank === 'officer' && tr !== 'member')) return toast(p, 'You can\'t remove them');
    removeMember(s, targetTok, 'was removed from');
  } else if (msg.action === 'promote' || msg.action === 'leader') {
    // Hand over leadership.
    if (!s || rank !== 'leader' || !targetTok || targetTok === p.token) return;
    s.officers.delete(targetTok);
    s.officers.add(p.token);
    s.leader = targetTok;
    sendCrew(s, { t: 'toast', text: `${charName(targetTok)} now leads ${s.name}` });
    pushSquadState(s);
  } else if (msg.action === 'officer' || msg.action === 'demote') {
    if (!s || rank !== 'leader' || !targetTok || targetTok === s.leader) return;
    if (msg.action === 'officer') s.officers.add(targetTok); else s.officers.delete(targetTok);
    pushSquadState(s);
  } else if (msg.action === 'ping') {
    const x = Number(msg.x), z = Number(msg.z);
    if (!Number.isFinite(x) || !Number.isFinite(z) || now - (p.lastPing || 0) < 500) return;
    p.lastPing = now;
    sendSquad(p, { t: 'ping', x, z, from: p.name, objective: !!s && s.leader === p.token });
  }
}
// ---- the shared crew stash house
// A crew has one stash house. Every member can use its stash, gunsmith and upgrades, and it levels
// up from everyone's effort. The claim keeps a "holder" (a current member) for bookkeeping.
function crewCreated(s, founder) {
  const own = claimWhere((st) => st.owner === founder.token && !st.crew);
  if (own) own.store.crew = s.id;
}
function crewMemberJoined(s, p) {
  const shared = crewClaim(s.id);
  const own = claimWhere((st) => st.owner === p.token && !st.crew);
  if (!shared && own) { own.store.crew = s.id; sendCrew(s, { t: 'toast', text: `${p.name}'s stash house is now the crew stash house` }); }
  else if (shared && own) toast(p, `You now share ${s.name}'s stash house. Your own one stays yours, unused, for if you ever leave.`);
  else if (shared) toast(p, `You now share ${s.name}'s stash house`);
}
function crewMemberLeft(s, token) {
  // The stash house stays with the crew; the leaver walks away from it.
  const c = crewClaim(s.id);
  if (!c || c.store.owner !== token || !s.members.size) return;
  const heir = s.leader !== token ? s.leader : [...s.members][0];
  c.store.owner = heir;
  c.store.ownerName = charName(heir);
}
function crewDisbanded(s) {
  // The last member keeps it as their own.
  const c = crewClaim(s.id);
  if (c) c.store.crew = null;
}
function rally(p) {
  const now = Date.now();
  const s = squadOf(p);
  if (!s || s.leader !== p.token) return toast(p, 'Rally is a squad leader ability');
  if (level(p) < GADGETS.rally.level) return toast(p, `Rally unlocks at level ${GADGETS.rally.level}`);
  if (now < (p.rallyReadyAt || 0)) return toast(p, `Rally ready in ${Math.ceil((p.rallyReadyAt - now) / 1000)}s`);
  p.rallyReadyAt = now + RALLY.cooldown;
  let n = 0;
  for (const m of squadMembersOnline(p)) {
    if (m.dead || Math.hypot(m.x - p.x, m.z - p.z) > RALLY.radius) continue;
    m.armor = Math.min(maxArmor(m), m.armor + maxArmor(m) * 0.5);
    m.buffUntil = now + RALLY.buffMs;
    dirty(m); n++;
  }
  sendSquad(p, { t: 'rally', from: p.name, x: p.x, z: p.z, count: n });
  dirty(p);
}

// ---------------------------------------------------------------- tech: camo, tagging, sensors, hacking
function camoActive(p) { return !!p.camoOn && !p.dead && p.tech > 0 && (p.speed || 0) < 3.2 && Date.now() > (p.camoBreakUntil || 0); }
/** Camo off (run out or switched off): it recharges for as long as it was used, in proportion. */
function endCamo(p, now) {
  if (!p.camoOn) return;
  const dur = GADGETS.camo.durationMs, used = dur - Math.max(0, (p.camoUntil || 0) - now);
  p.camoOn = false;
  p.camoReadyAt = now + GADGETS.camo.cooldownMs * Math.max(0.3, Math.min(1, used / dur));
}
function breakCamo(p, ms) { if (p.camoOn) p.camoBreakUntil = Math.max(p.camoBreakUntil || 0, Date.now() + ms); }
function expose(target, key, ms) { target.exposed ??= {}; target.exposed[key] = Math.max(target.exposed[key] || 0, Date.now() + ms); }
function exposedTo(target, viewer) { return (target.exposed?.[squadKey(viewer)] || 0) > Date.now(); }
function findCharacter(id) { return players.get(id) || bots.get(id) || null; }

function markTarget(p, msg) {
  const now = Date.now();
  if (now - (p.lastMark || 0) < 700) return;
  const t = findCharacter(msg.id);
  if (!t || t.dead || sameSquad(p, t)) return;
  const eye = gy(p) + (p.crouch ? CROUCH_EYE : STAND_EYE);
  if (Math.hypot(t.x - p.x, t.z - p.z) > 120 || !lineOfSight(p.x, eye, p.z, t.x, gy(t) + (t.crouch ? 0.9 : 1.3), t.z)) return;
  p.lastMark = now;
  const key = squadKey(p);
  expose(t, key, MARK_MS);
  t.markedBy = { token: p.token, key, until: now + MARK_MS };
  sendSquad(p, { t: 'expose', ids: [t.id], until: now + MARK_MS, kind: 'mark', by: p.name });
}

function throwSensor(p, msg) {
  const now = Date.now();
  if (level(p) < GADGETS.sensor.level) return toast(p, `Sensor grenade unlocks at level ${GADGETS.sensor.level}`);
  if (now < (p.sensorReadyAt || 0)) return;
  if (p.tech < GADGETS.sensor.cost) return toast(p, `Sensor needs ${GADGETS.sensor.cost} tech`);
  let x = Number(msg.x), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const d = Math.hypot(x - p.x, z - p.z);
  if (d > SENSOR.throwRange) { x = p.x + (x - p.x) * SENSOR.throwRange / d; z = p.z + (z - p.z) * SENSOR.throwRange / d; }
  p.tech -= GADGETS.sensor.cost;
  p.sensorReadyAt = now + SENSOR.cooldown;
  const radius = hasField(p, 'sensorMk2') ? SENSOR.radiusMk2 : SENSOR.radius;
  sensorThrowFx(p, x, z);
  sensors.push({ x, z, until: now + SENSOR.duration, key: squadKey(p), owner: p, radius });
  sendSquad(p, { t: 'sensor', x, z, until: now + SENSOR.duration, radius });
  const found = [];
  for (const st of structsNear(x, z, radius)) {
    const kind = PIECES[st.type].defense;
    if (!kind || tokenInSquadWith(p, st.owner) || Math.hypot(st.x - x, st.z - z) > radius) continue;
    found.push({ x: +st.x.toFixed(1), y: +((st.y0 || 0) + 0.6).toFixed(1), z: +st.z.toFixed(1), kind });
  }
  if (found.length) { sendSquad(p, { t: 'defmarks', list: found, until: now + DEF.revealMs }); toast(p, `Sensor found ${found.length} defense${found.length === 1 ? '' : 's'}: marked for ${DEF.revealMs / 1000}s`); }
  dirty(p);
}
// ---- living off the land: hunger, eating, farming, cooking, fishing, trading posts
const HUNGER = HOMESTEAD.hunger;
const CROP_SCALE = Number(process.env.CROP_GROW_SCALE || 1);   // tests speed crops up
function tickHunger(p, now) {
  if (p.deploying || p.downed) return;
  const before = Math.round(p.food);
  p.food = Math.max(0, p.food - HUNGER.perMinute / 60);
  if (Math.round(p.food) !== before) dirty(p);
  if (p.food < HUNGER.noRegenBelow && before >= HUNGER.noRegenBelow) toast(p, '🍽 You\'re getting hungry — armor won\'t recharge until you eat (H)');
  if (p.food <= 0 && now - (p.starvedAt || 0) >= HUNGER.starvingEveryMs && p.hp > HUNGER.starvingFloorHp) {
    p.starvedAt = now;
    p.hp = Math.max(HUNGER.starvingFloorHp, p.hp - HUNGER.starvingDamage);
    if (!p.starveWarned || now - p.starveWarned > 60_000) { p.starveWarned = now; toast(p, '⚠ Starving — find food: farm, fish, hunt, or buy a meal at a trading post'); }
    dirty(p);
  }
}
/** Eat one of a good (or the best thing you're carrying). */
/**
 * Eating and patching up take a moment (PUBG-style): a bar fills, you can walk but not sprint, and
 * it only counts when it's done. Sprinting, firing, jumping into a ride or going down stops it (you keep
 * what you were using). Taking fire doesn't.
 */
const USE_MS = { eat: 3000, heal: 5000 };
function startUse(p, kind, good) {
  if (p.dead || p.downed || p.boat) return;
  if (p.hack) { if (p.hack.kind === kind) return; return toast(p, 'Busy: finish what you\'re doing first'); }
  if (kind === 'eat') {
    if (HUNGER.max - p.food < 3) return toast(p, 'You\'re full');
    if (!GOODS.some((g) => HOMESTEAD.goods[g].food && p[g] > 0)) return toast(p, 'Nothing to eat — farm, fish, hunt, or buy food at a trading post');
  } else if (!p.inv.pack.some((i) => i.kind === 'medkit')) return toast(p, 'No medkit');
  const now = Date.now(), ms = USE_MS[kind];
  p.hack = { kind, id: null, start: now, until: now + ms, total: ms, x: p.x, z: p.z, good, walk: true };
  send(p.ws, { t: 'hack', kind, until: p.hack.until, total: ms });
}
function finishHeal(p) {
  const idx = p.inv.pack.findIndex((i) => i.kind === 'medkit');
  if (idx < 0) return;
  p.inv.pack.splice(idx, 1);
  p.hp = Math.min(maxHp(p), p.hp + COMBAT.medkitHeal);
  p.armor = Math.min(maxArmor(p), p.armor + 40);
  send(p.ws, { t: 'hack', done: true, text: `Patched up (+${COMBAT.medkitHeal} health)` });
  dirty(p);
}
function eat(p, good) {
  const room = HUNGER.max - p.food;
  if (room < 3) return toast(p, 'You\'re full');
  const foods = GOODS.filter((g) => HOMESTEAD.goods[g].food && p[g] > 0);
  if (!foods.length) return toast(p, 'Nothing to eat — farm, fish, hunt, or buy food at a trading post');
  // Prefer what you asked for, then whatever fills you up without wasting much.
  const pick = good && foods.includes(good) ? good : foods.sort((a, b) => Math.abs(HOMESTEAD.goods[a].food - room) - Math.abs(HOMESTEAD.goods[b].food - room))[0];
  p[pick]--;
  p.food = Math.min(HUNGER.max, p.food + HOMESTEAD.goods[pick].food);
  toast(p, `Ate ${HOMESTEAD.goods[pick].name.replace(/s$/, '')} (+${HOMESTEAD.goods[pick].food} food)`);
  dirty(p);
}
/** Which crop a plot grows, from the ground it's on. */
function cropFor(x, z) {
  const b = biomeName(terrain.biome(x, z));
  return Object.keys(HOMESTEAD.crops).find((k) => !k.startsWith('_') && HOMESTEAD.crops[k].biomes.includes(b)) || 'corn';
}
function cropState(st, now = Date.now()) {
  if (!st.crop) return { phase: 'empty', grow: 0 };
  const c = HOMESTEAD.crops[st.crop];
  const grow = Math.min(1, (now - st.plantedAt) / (c.growMs * CROP_SCALE));
  if (grow < 1) return { phase: 'growing', grow };
  const ripeFor = now - st.plantedAt - c.growMs * CROP_SCALE;
  return { phase: ripeFor > HOMESTEAD.ripeKeepsMs * CROP_SCALE ? 'rotten' : 'ripe', grow: 1 };
}
const dur = (ms) => (ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h ${Math.round((ms % 3600_000) / 60_000)}m` : `${Math.max(1, Math.round(ms / 60_000))}m`);
function farmInteract(p, st) {
  const now = Date.now();
  const cs = cropState(st, now);
  if (cs.phase === 'empty') {
    if (!canManage(p, st)) return toast(p, `${st.ownerName}'s empty farm plot`);
    if ((p.seeds || 0) < 1) return toast(p, 'You need a seed packet to plant (trading posts sell them; farms have them)');
    p.seeds--;
    st.crop = cropFor(st.x, st.z); st.plantedAt = now; st.planter = p.token;
    toast(p, `Planted ${st.crop} — ripe in ${dur(HOMESTEAD.crops[st.crop].growMs * CROP_SCALE)}. Come back to harvest it before someone else does.`);
    return dirty(p);
  }
  if (cs.phase === 'growing') return toast(p, `${st.crop[0].toUpperCase() + st.crop.slice(1)}: ${Math.round(cs.grow * 100)}% grown — ripe in ${dur(HOMESTEAD.crops[st.crop].growMs * CROP_SCALE * (1 - cs.grow))}`);
  const crop = st.crop;
  st.crop = null; st.plantedAt = 0;
  if (cs.phase === 'rotten') return toast(p, `The ${crop} rotted in the field. Plant again (E with seeds).`);
  const n = HOMESTEAD.crops[crop].yield;
  p[crop] = (p[crop] || 0) + n;
  const mine = canManage(p, st);
  if (!mine) {
    feed(`${p.name} stole a ${crop} harvest`);
    for (const o of teamOfToken(st.owner)) { toast(o, `⚠ ${p.name} harvested your ${crop}!`); send(o.ws, { t: 'alert', x: st.x, z: st.z, text: 'Crop stolen' }); }
  } else {
    const c = claimOf(p);
    if (c && Math.hypot(st.x - c.x, st.z - c.z) <= homePerks(homeLevel(c.store.hxp)).radius) addHomeXp(c, 15, 'Harvest');
  }
  award(p, 25, `Harvested ${crop}`);
  toast(p, `+${n} ${crop}${mine ? '' : ' (stolen)'}`);
  dirty(p);
}
function cookInteract(p, st) {
  const raw = GOODS.filter((g) => HOMESTEAD.goods[g].cooksTo && p[g] > 0);
  if (!raw.length) return toast(p, 'Nothing to cook — bring raw fish or meat');
  startHack(p, 'cook', st.id);
}
function finishCook(p) {
  let n = 0;
  for (const g of GOODS) {
    const to = HOMESTEAD.goods[g].cooksTo;
    if (!to || !p[g]) continue;
    p[to] = (p[to] || 0) + p[g];
    n += p[g];
    p[g] = 0;
  }
  if (n) award(p, 5 + n, 'Cooked a meal');
  send(p.ws, { t: 'hack', done: true, text: n ? `Cooked ${n} meal${n === 1 ? '' : 's'}` : 'Nothing to cook' });
  dirty(p);
}
/** Standing at the water's edge? (Something within reach is water deep enough to fish.) */
function nearWater(x, z) {
  const R = HOMESTEAD.fishing.waterWithin;
  for (let a = 0; a < 8; a++) for (const r of [R * 0.5, R]) if (terrain.height(x + Math.cos(a * Math.PI / 4) * r, z + Math.sin(a * Math.PI / 4) * r) < -0.4) return true;
  return false;
}
function finishFishing(p) {
  const F = HOMESTEAD.fishing;
  let n = F.catchMin + Math.floor(Math.random() * (F.catchMax - F.catchMin + 1));
  if (terrain.biome(p.x, p.z).sea > 0.4) n += F.swampBonus;
  p.fish = (p.fish || 0) + n;
  award(p, 8, 'Caught fish');
  send(p.ws, { t: 'hack', done: true, text: `+${n} fish` });
  dirty(p);
}
function tradeNpc(p, msg) {
  const b = bots.get(msg.npcId);
  if (!b || b.dead || !b.npc || Math.hypot(b.x - p.x, b.z - p.z) > 4) return toast(p, 'They\'ve moved on');
  if (b.kind === 'pawn' && pawnTrade(p, b, msg)) { dirty(p); return send(p.ws, npcView(p, b)); }
  const view = npcTradeView(b, p);
  if (msg.action === 'sell') {
    const row = view.sells.find((x) => x.good === msg.good);
    const have = p[msg.good] || 0;
    const qty = msg.qty === 'all' ? have : Math.min(have, 1);
    if (!row || qty < 1) return;
    p[msg.good] -= qty; p.cash = (p.cash || 0) + qty * row.pays;
    toast(p, `Sold ${qty} ${row.name} for $${qty * row.pays}`);
  } else if (msg.action === 'buy') {
    const it = view.shop.find((x) => x.id === msg.item);
    if (!it) return;
    if ((p.cash || 0) < it.price) return toast(p, `That costs $${it.price}`);
    const stock = b.kind === 'trader' && traderPosts[b.post].camp ? campStockOf(b.post, it.id) : null;
    if (stock && stock.n < 1) return toast(p, 'Sold out for now. The camp restocks through the day.');
    if (stock) stock.n -= 1;
    const sh = own(ECONOMY.shop, it.id);
    if (sh && (sh.kind === 'tool' || sh.kind === 'medkit') && p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
    p.cash -= it.price;
    if (!sh || sh.kind === 'good') p[it.id] = (p[it.id] || 0) + (it.qty || 1);
    else if (sh.kind === 'tool') p.inv.pack.push(makeTool(it.id));
    else if (sh.kind === 'medkit') p.inv.pack.push(makeConsumable('medkit'));
    else if (sh.kind === 'ammo') p.ammo += sh.qty || 60;
    toast(p, `Bought ${it.name} for $${it.price}`);
  }
  dirty(p);
  send(p.ws, npcView(p, b));
}
// Trading posts: every Contact buys and sells, at prices set by what its town has plenty of.
function postTown(contactId) { const c = map.contacts[contactId]; return map.towns[c.townId]?.name || ''; }
function priceAt(contactId, good) { return Math.max(1, Math.round(ECONOMY.prices[good] * (ECONOMY.towns[postTown(contactId)]?.[good] ?? 1) * priceSwing(contactId, good))); }
function tradeView(contactId) {
  return {
    town: postTown(contactId),
    sells: Object.keys(ECONOMY.prices).map((g) => ({ good: g, pays: priceAt(contactId, g), name: HOMESTEAD.goods[g]?.name || g })),
    shop: Object.entries(ECONOMY.shop).filter(([k]) => !k.startsWith('_')).map(([k, it]) => ({ id: k, name: it.name || HOMESTEAD.goods[k]?.name || k, price: it.kind === 'good' && ECONOMY.prices[k] ? Math.max(it.price, Math.round(priceAt(contactId, k) * ECONOMY.buyMarkup)) : it.price, qty: it.qty || 1 })),
  };
}
function trade(p, msg) {
  if (msg.npcId) return tradeNpc(p, msg);
  const ct = nth(map.contacts, msg.contactId);
  if (!ct || Math.hypot(ct.x - p.x, ct.z - p.z) > 6) return toast(p, 'Trade at a Contact\'s trading post');
  if (msg.action === 'sell') {
    const g = msg.good;
    if (!ECONOMY.prices[g]) return;
    const have = p[g] || 0;
    const qty = msg.qty === 'all' ? have : Math.min(have, Math.max(1, Math.floor(Number(msg.qty) || 1)));
    if (qty < 1) return toast(p, `You have no ${HOMESTEAD.goods[g]?.name || g} to sell`);
    const pay = qty * priceAt(msg.contactId, g);
    p[g] -= qty; p.cash = (p.cash || 0) + pay;
    toast(p, `Sold ${qty} ${HOMESTEAD.goods[g]?.name || g} for $${pay}`);
  } else if (msg.action === 'buy') {
    const it = own(ECONOMY.shop, msg.item);
    if (!it || msg.item.startsWith('_')) return;
    const price = tradeView(msg.contactId).shop.find((x) => x.id === msg.item).price;
    if ((p.cash || 0) < price) return toast(p, `That costs $${price} — you have $${p.cash || 0}`);
    if ((it.kind === 'tool' || it.kind === 'medkit') && p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
    p.cash -= price;
    if (it.kind === 'good') p[msg.item] = (p[msg.item] || 0) + (it.qty || 1);
    else if (it.kind === 'tool') p.inv.pack.push(makeTool(msg.item));
    else if (it.kind === 'medkit') p.inv.pack.push(makeConsumable('medkit'));
    else if (it.kind === 'ammo') p.ammo += it.qty || 60;
    toast(p, `Bought ${it.name || HOMESTEAD.goods[msg.item]?.name || msg.item} for $${price}`);
  }
  dirty(p);
  send(p.ws, contactView(p, msg.contactId));
}

// ---- stuns and data hacking (Future Soldier-style)
// Stun an enemy (stun grenade, or a takedown from behind) or down them, then data-hack them: their
// whole crew lights up for your crew and you learn where their stash house is.
const STUN = GADGET_DATA.stun, TAKEDOWN = GADGET_DATA.takedown, DATAHACK = GADGET_DATA.dataHack, TASER = GADGET_DATA.taser;
const stunBlasts = [];   // pending grenades: { x, z, y, at, owner }
const isStunned = (c, now = Date.now()) => (c.stunnedUntil || 0) > now;
function stun(c, ms, by) {
  const now = Date.now();
  if (c.dead || (!c.isBot && (c.protectedUntil || 0) > now)) return false;
  if (!c.isBot && by && !pvpAllowed(by, c)) return false;
  c.stunnedUntil = Math.max(c.stunnedUntil || 0, now + ms);
  c.stunnedBy = by?.token || null;
  if (!c.isBot) {
    cancelHack(c, 'Stunned');
    c.camoOn = false;
    send(c.ws, { t: 'stunned', until: c.stunnedUntil, by: by?.name || null });
    dirty(c);
  }
  return true;
}
function throwStun(p, msg) {
  const now = Date.now();
  if (level(p) < GADGETS.stun.level) return toast(p, `Stun grenades unlock at level ${GADGETS.stun.level}`);
  if (now < (p.stunReadyAt || 0)) return;
  if (p.tech < GADGETS.stun.cost) return toast(p, `A stun grenade needs ${GADGETS.stun.cost} tech`);
  let x = Number(msg.x), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const d = Math.hypot(x - p.x, z - p.z);
  if (d > STUN.throwRange) { x = p.x + (x - p.x) * STUN.throwRange / d; z = p.z + (z - p.z) * STUN.throwRange / d; }
  p.tech -= GADGETS.stun.cost;
  p.stunReadyAt = now + STUN.cooldown;
  const fl = flyNade(p, x, z, Math.min(STUN.fuseMs * 0.8, Math.max(250, d * 28)), STUN.fuseMs);
  stunBlasts.push({ x: fl.x, z: fl.z, y: fl.y + 0.25, at: now + STUN.fuseMs, owner: p });
  for (const o of players.values()) if (Math.abs(o.x - x) < INTEREST && Math.abs(o.z - z) < INTEREST) send(o.ws, { t: 'stunThrow', x: fl.x, z: fl.z, y: fl.y, path: fl.path, from: [p.x, gy(p) + 1.5, p.z], at: now + STUN.fuseMs });
  dirty(p);
}
// ---- the frag grenade: thrown in an arc, bursts after its fuse
const FRAG = COMBAT.frag, fragBlasts = [];
function throwFrag(p, msg) {
  const now = Date.now();
  if (now < (p.fragReadyAt || 0)) return;
  if ((p.parts || 0) < FRAG.costParts) return toast(p, `A frag grenade takes ${FRAG.costParts} parts`);
  let x = Number(msg.x), z = Number(msg.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const d = Math.hypot(x - p.x, z - p.z);
  if (d > FRAG.throwRange) { x = p.x + (x - p.x) * FRAG.throwRange / d; z = p.z + (z - p.z) * FRAG.throwRange / d; }
  p.parts -= FRAG.costParts;
  p.fragReadyAt = now + FRAG.cooldownMs;
  breakCamo(p, 2000); p.protectedUntil = 0;
  // Cooked: the fuse has been burning since the pin came out. Held too long, it goes off in your hand.
  const cook = Math.max(0, Math.min(FRAG.fuseMs, Number(msg.cook) || 0)), left = FRAG.fuseMs - cook;
  if (left <= (FRAG.cookMinMs || 150)) { x = p.x; z = p.z; }
  const flight = left <= (FRAG.cookMinMs || 150) ? 0 : Math.min(left, Math.max(250, Math.min(1200, d * 32)));
  // Its real flight: off walls, roofs and the ground, rolling to a stop where the fuse finds it.
  const fl = flight ? flyNade(p, x, z, flight, left) : { x, z, y: gy(p) + 0.15, path: null };
  fragBlasts.push({ id: uid('fg'), x: fl.x, z: fl.z, y: fl.y, at: now + left, owner: p.token, ownerName: p.name });
  for (const o of players.values()) if (Math.abs(o.x - x) < INTEREST && Math.abs(o.z - z) < INTEREST) send(o.ws, { t: 'nadeThrow', kind: 'frag', by: p.id, x: fl.x, z: fl.z, y: fl.y, path: fl.path, from: [p.x, gy(p) + 1.5, p.z], at: now + flight, boomAt: now + left });
  dirty(p);
}
/** A grenade's path from someone's hand toward (x, z): bounces and all (shared/world.js throwPath). */
function flyNade(p, x, z, flightMs, fuseMs) {
  const from = [p.x, gy(p) + 1.5, p.z], mx = (p.x + x) / 2, mz = (p.z + z) / 2;
  const r = Math.hypot(x - p.x, z - p.z) / 2 + 12;
  return throwPath(from, x, z, flightMs, fuseMs, solidsNear(mx, mz, r), (a, b) => terrain.height(a, b));
}
/** Anyone throwing a sensor: everyone nearby sees it fly. */
function sensorThrowFx(p, x, z) {
  for (const o of players.values()) if (Math.abs(o.x - x) < INTEREST && Math.abs(o.z - z) < INTEREST) send(o.ws, { t: 'nadeThrow', kind: 'sensor', by: p.id, x, z, from: [p.x, gy(p) + 1.5, p.z], at: Date.now() + 600 });
}
function tickStuns(now) {
  for (let i = fragBlasts.length - 1; i >= 0; i--) {
    const g = fragBlasts[i];
    if (g.at > now) continue;
    fragBlasts.splice(i, 1);
    explode({ id: g.id, x: g.x, y: (g.y ?? terrain.height(g.x, g.z)) + 0.1, z: g.z, owner: g.owner, ownerName: g.ownerName }, now, FRAG);
  }
  for (let i = stunBlasts.length - 1; i >= 0; i--) {
    const g = stunBlasts[i];
    if (g.at > now) continue;
    stunBlasts.splice(i, 1);
    for (const o of players.values()) if (Math.abs(o.x - g.x) < INTEREST && Math.abs(o.z - g.z) < INTEREST) send(o.ws, { t: 'stunBlast', x: g.x, y: g.y, z: g.z });
    let n = 0;
    for (const c of [...players.values(), ...bots.values()]) {
      if (c.dead || (!c.isBot && sameSquad(c, g.owner))) continue;
      const d = Math.hypot(c.x - g.x, c.z - g.z);
      if (d > STUN.radius || !lineOfSight(g.x, g.y + 0.5, g.z, c.x, gy(c) + 1.4, c.z)) continue;
      const ms = STUN.minDurationMs + (STUN.durationMs - STUN.minDurationMs) * Math.max(0, 1 - Math.max(0, d - 3) / (STUN.radius - 3));
      if (stun(c, ms, g.owner)) n++;
    }
    if (n && players.has(g.owner.id)) toast(g.owner, `Stunned ${n} — get in and data-hack them (E)`);
    let jams = 0;
    for (const st of structsNear(g.x, g.z, STUN.radius + 2)) {
      const kind = PIECES[st.type].defense;
      if ((kind !== 'sentry' && kind !== 'alarm') || tokenInSquadWith(g.owner, st.owner) || Math.hypot(st.x - g.x, st.z - g.z) > STUN.radius) continue;
      st.jammedUntil = now + DEF.jamMs; jams++;
    }
    if (jams && players.has(g.owner.id)) toast(g.owner, `⚡ Jammed ${jams} sentr${jams === 1 ? 'y' : 'ies'} / alarm${jams === 1 ? '' : 's'} for ${DEF.jamMs / 1000}s`);
  }
}
/** Enemy at reach for a takedown or a data hack (player or Rogue). */
function enemyAtReach(p, range) {
  let best = null, bd = range;
  for (const c of [...players.values(), ...bots.values()]) {
    if (c === p || c.dead || c.animal || c.npc || (c.dog && tokenInSquadWith(p, c.owner)) || (!c.isBot && sameSquad(c, p))) continue;
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
/** Is `p` behind `t`? (t's facing points away from p.) */
function behind(p, t) {
  const fx = Math.sin(t.yaw || 0), fz = Math.cos(t.yaw || 0);
  const dx = p.x - t.x, dz = p.z - t.z, l = Math.hypot(dx, dz) || 1;
  return (fx * dx + fz * dz) / l < -0.35;
}
/**
 * The stun gun: everyone carries one. `msg.draw` pulls it out or puts it away (others see it in your
 * hand); `msg.dir` fires: the first enemy along your aim within range, in sight, is stunned (no damage),
 * ready to be data-hacked. Then it recharges.
 */
// ---- voice chat (client/voice.js): crewmates who both have crew chat on; anyone within VOICE_NEAR
// who both have nearby chat on. The server only says who may talk to whom and passes the introductions
// along; the voices go straight between players.
const VOICE_NEAR = 80;
function voiceLink(a, b) {
  if (!a.voice || !b.voice || a.dead || b.dead) return null;
  if (a.voice.crew && b.voice.crew && sameSquad(a, b)) return 'crew';
  if (a.voice.near && b.voice.near && Math.hypot(a.x - b.x, a.z - b.z) < VOICE_NEAR) return 'near';
  return null;
}
function tickVoice() {
  for (const p of players.values()) {
    if (!p.voice) continue;
    const list = [];
    for (const o of players.values()) {
      if (o === p) continue;
      let k = voiceLink(p, o);
      // (a nearby voice already connected stays so out to 20 m further, so the edge doesn't flicker)
      if (!k && p.voicePeers?.[o.id] && p.voice.near && o.voice?.near && !o.dead && Math.hypot(p.x - o.x, p.z - o.z) < VOICE_NEAR + 20) k = 'near';
      if (k) list.push({ id: o.id, crew: k === 'crew' });
    }
    const key = list.map((q) => q.id + (q.crew ? 'c' : 'n')).sort().join(',');
    if (key !== p.voiceKey) { p.voiceKey = key; p.voicePeers = Object.fromEntries(list.map((q) => [q.id, 1])); send(p.ws, { t: 'voicePeers', peers: list }); }
  }
}
function handleTaser(p, msg) {
  const now = Date.now();
  if (p.dead || p.downed) return;
  if (msg.draw !== undefined) { p.taserOut = !!msg.draw && !p.boat; dirty(p); return; }
  if (!p.taserOut || p.boat || isStunned(p, now)) return;
  if (now < (p.taserReadyAt || 0)) return toast(p, `Stun gun recharging: ${Math.ceil((p.taserReadyAt - now) / 1000)}s`);
  const d = msg.dir;
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return;
  const l = Math.hypot(d[0], d[1], d[2]) || 1, dx = d[0] / l, dy = d[1] / l, dz = d[2] / l;
  const eye = gy(p) + (p.prone ? 0.4 : p.crouch ? CROUCH_EYE : STAND_EYE);
  p.taserReadyAt = now + TASER.cooldown;
  breakCamo(p, 2000); p.protectedUntil = 0;
  let best = null, bt = Infinity, by = 0;
  for (const c of [...players.values(), ...bots.values()]) {
    if (c === p || c.dead || c.animal || c.npc || (c.dog && tokenInSquadWith(p, c.owner)) || (!c.isBot && sameSquad(c, p))) continue;
    const cy = gy(c) + (c.prone ? 0.3 : c.crouch ? 0.8 : 1.15);
    const vx = c.x - p.x, vy = cy - eye, vz = c.z - p.z, t = vx * dx + vy * dy + vz * dz;
    if (t < 0.2 || t > TASER.range || t >= bt) continue;
    if (Math.hypot(vx - dx * t, vy - dy * t, vz - dz * t) > TASER.aimTolerance) continue;
    if (!lineOfSight(p.x, eye, p.z, c.x, cy, c.z)) continue;
    best = c; bt = t; by = cy;
  }
  const to = best ? [best.x, by, best.z] : [p.x + dx * TASER.range, eye + dy * TASER.range, p.z + dz * TASER.range];
  for (const r of players.values()) if (Math.hypot(r.x - p.x, r.z - p.z) < 150) send(r.ws, { t: 'zap', from: [p.x, eye - 0.15, p.z], to, hit: best ? 1 : 0, by: p.id });
  dirty(p);
  if (!best) return toast(p, `Missed: the stun gun reaches about ${Math.round(TASER.range * 3.28 / 5) * 5} ft`);
  if (!best.isBot && !pvpAllowed(p, best)) return toast(p, `Can't stun ${best.name} here`);
  if (!stun(best, TASER.stunMs, p)) return toast(p, `${best.name} just deployed: spawn protection for a few more seconds`);
  botsHear(p, 15);   // (a stun gun's crack carries a little way)
  toast(p, `⚡ ${best.name} is stunned: data-hack them now (hold USE)`);
}
function takedown(p, t) {
  if (!pvpAllowed(p, t)) return;
  if (!stun(t, TAKEDOWN.stunMs, p)) return toast(p, `${t.name} just deployed — spawn protection for a few more seconds`);
  feed(`${p.name} took down ${t.name}`);
  award(p, XP.takedown, `Takedown: ${t.name}`);
  toast(p, `${t.name} is stunned — data-hack them now (E)`);
}
function finishDataHack(p, id) {
  const t = findCharacter(id);
  if (!t || t.dead || !(isStunned(t) || t.downed)) return send(p.ws, { t: 'hack', done: true, text: 'They shook it off' });
  const now = Date.now();
  const key = squadKey(p);
  // Their radio only gives up its secrets once in a while: no hacking the same target over and over.
  if ((t.hackedUntil || 0) > now) return send(p.ws, { t: 'hack', done: true, text: 'Nothing new on their radio yet' });
  t.hackedUntil = now + DATAHACK.repeatMs;
  if (t.isBot) {
    // A Rogue's radio: every Rogue nearby lights up.
    const ids = [];
    for (const b of bots.values()) if (!b.dead && Math.hypot(b.x - t.x, b.z - t.z) <= DATAHACK.rogueRevealRadius) { expose(b, key, DATAHACK.exposeMs); ids.push(b.id); }
    sendSquad(p, { t: 'expose', ids, until: now + DATAHACK.exposeMs, kind: 'mark', by: p.name });
    award(p, Math.round(XP.dataHack / 2), 'Rogue comms hacked', true);
    return send(p.ws, { t: 'hack', done: true, text: `Rogue comms hacked: ${ids.length} Rogue${ids.length === 1 ? '' : 's'} nearby revealed` });
  }
  // A player: their whole crew lights up for your crew, and you learn where they live.
  const victims = squadMembersOnline(t).filter((m) => !m.dead);
  const ids = [];
  for (const m of victims) {
    const ms = hasField(m, 'jammer') ? DATAHACK.jammerExposeMs : DATAHACK.exposeMs;
    expose(m, key, ms);
    ids.push(m.id);
    toast(m, m === t ? `⚠ ${p.name} hacked you — your crew is exposed!` : `⚠ ${p.name} hacked ${t.name} — you're exposed for ${Math.round(ms / 1000)}s!`);
  }
  sendSquad(p, { t: 'expose', ids, until: now + DATAHACK.exposeMs, kind: 'mark', by: p.name });
  const home = claimOfToken(t.token);
  if (home) sendSquad(p, { t: 'intel', stash: { x: home.x, z: home.z, owner: storeOwnerLabel(home.store), until: now + DATAHACK.stashIntelMs } });
  feed(`${p.name} data-hacked ${t.name}`);
  award(p, XP.dataHack, `Data hack: ${t.name}`, true);
  send(p.ws, { t: 'hack', done: true, text: `Hacked ${t.name}: ${victims.length} enemy${victims.length === 1 ? '' : ' crew'} lit up${home ? ', stash house marked on your map' : ''}` });
}
/** Hacking a terminal scans the area around it. */
function terminalScan(p, term) {
  const now = Date.now(), key = squadKey(p), R = ACTIVITIES.terminal.scanRadius, ms = ACTIVITIES.terminal.scanMs;
  const ids = [];
  for (const c of [...players.values(), ...bots.values()]) {
    if (c.dead || c.animal || c.npc || (!c.isBot && sameSquad(c, p)) || Math.hypot(c.x - term.x, c.z - term.z) > R) continue;
    expose(c, key, ms);
    ids.push(c.id);
  }
  sendSquad(p, { t: 'expose', ids, until: now + ms, kind: 'sensor' });
  sendSquad(p, { t: 'scan', x: term.x, z: term.z, r: R, until: now + 1500 });
  return ids.length;
}

function tickSensors(now) {
  for (let i = sensors.length - 1; i >= 0; i--) {
    const s = sensors[i];
    if (now > s.until || !players.has(s.owner.id)) { sensors.splice(i, 1); continue; }
    const ids = [];
    for (const c of [...players.values(), ...bots.values()]) {
      if (c.dead || sameSquad(c, s.owner)) continue;
      if (Math.hypot(c.x - s.x, c.z - s.z) <= s.radius) { expose(c, s.key, 1200); ids.push(c.id); }
    }
    if (ids.length) sendSquad(s.owner, { t: 'expose', ids, until: now + 1200, kind: 'sensor' });
  }
}

/** Timed, interruptible channel: terminals, door bypass, supply drops, contract crates. */
function startHack(p, kind, id, extra = {}) {
  if (kind === 'rebuild') {
    const st = structs.get(id);
    if (!st || !(st.ruined || st.broken) || !canManage(p, st)) return;
    if (!hasTool(p, 'hammer')) return toast(p, 'You need a hammer to rebuild');
    const cost = st.ruined ? RAIDS.ruin.rebuildCost : RAIDS.ruin.doorRebuildCost;
    if (Object.entries(cost).some(([k, v]) => (p[k] || 0) < v)) return toast(p, `Rebuilding needs ${costText(cost)} (carried)`);
  }
  const now = Date.now();
  let src;
  if (kind === 'raid' || kind === 'gatehack') {
    // Nothing gets broken into while a base is sealed; a gate lock takes longer the better it is.
    const st = structs.get(id);
    if (!st || raidMul(baseOf(st), p) <= 0) return;
    if (kind === 'gatehack') { const bp = bypassOf('gate', id); extra = { ...extra, ms: bp.ms, tech: bp.tech }; }
  }
  if (kind === 'rebuild' || kind === 'selfrevive' || kind === 'harvest' || kind === 'upgrade' || kind === 'raid' || kind === 'gatehack' || kind === 'claim' || kind === 'revive' || kind === 'claimBuilding' || kind === 'datahack' || kind === 'cook' || kind === 'fish' || kind === 'hotwire' || kind === 'hotcrate' || kind === 'breakbox' || kind === 'disarm') {
    const ms = extra.ms ? extra.ms : kind === 'rebuild' ? RAIDS.ruin.rebuildMs : kind === 'selfrevive' ? DOWNED.selfReviveMs : kind === 'hotwire' ? RV.rules.hotwireMs : kind === 'cook' ? HOMESTEAD.cooking.ms : kind === 'fish' ? HOMESTEAD.fishing.ms : kind === 'datahack' ? DATAHACK.ms : kind === 'revive' ? DOWNED.reviveMs : kind === 'claim' || kind === 'claimBuilding' ? CLAIM.plantMs : kind === 'harvest' ? BUILD.harvest.channelMs : kind === 'upgrade' ? BUILD.upgradeMs : BUILD.raid[extra.tool].ms;
    p.hack = { kind, id, start: now, until: now + ms, total: ms, x: p.x, z: p.z, ...extra };
    send(p.ws, { t: 'hack', kind, until: p.hack.until, total: ms });
    if (kind === 'datahack') toast(p, 'Hacking shows your position to enemies nearby — have your crew cover you.');
    if (kind === 'raid' || kind === 'gatehack') {
      const st = structs.get(id);
      const team = st ? teamOfToken(st.owner) : [];
      if (!st.raidAlert || now - st.raidAlert > 20_000) {
        st.raidAlert = now;
        for (const o of team) { toast(o, `⚠ ${p.name} is breaking into your base!`); send(o.ws, { t: 'alert', x: st.x, z: st.z, text: 'Base under attack' }); }
        logAway(st.owner, `${p.name} is breaking into your base`);
      }
    }
    return;
  }
  if (kind === 'terminal') {
    if ((terminalReadyAt.get(id) || 0) > now) return toast(p, `Terminal rebooting — ${Math.ceil((terminalReadyAt.get(id) - now) / 1000)}s`);
    src = map.terminals[id];
  } else if (kind === 'door') {
    if (level(p) < GADGETS.doorHack.level) return toast(p, `Locked. Shoot it down, or reach level ${GADGETS.doorHack.level} to hack it.`);
    if (raidMul(db.houses[id], p) <= 0) return;
    const bp = bypassOf('door', id);
    if (p.tech < bp.tech) return toast(p, `Bypassing a ${TIER_NAMES[bp.tier]} lock needs ${bp.tech} tech`);
    extra = { ms: bp.ms, tech: bp.tech };
    src = map.houses[id];
  } else if (kind === 'drop') {
    const d = drops.get(id);
    if (!d || d.landsAt > now) return toast(p, 'The drop hasn\'t landed yet');
    src = d;
  } else {
    src = objectives.get(id);
    if (!src || src.owner !== p.token) return toast(p, 'Not your contract');
  }
  const ms = extra.ms || HACK_MS[kind];
  p.hack = { kind, id, start: now, until: now + ms, total: ms, x: p.x, z: p.z, ...extra };
  if (TEAM_HACK.exposes.includes(kind)) toast(p, 'Hacking shows your position to enemies nearby — have your crew cover you. Crewmates close by speed it up.');
  send(p.ws, { t: 'hack', kind, until: p.hack.until, total: ms });
  if (kind === 'crate') return;
  const text = { terminal: 'Terminal hack detected', door: 'Stash lock bypass detected', drop: 'Someone is opening the supply drop' }[kind];
  for (const o of players.values()) {
    if (o !== p && !sameSquad(o, p) && Math.hypot(o.x - src.x, o.z - src.z) < 80) send(o.ws, { t: 'alert', x: src.x, z: src.z, text });
  }
}
/** A short one-off action others see (a flare held up). */
function gesture(p, kind, ms) { p.gesture = { kind, start: Date.now(), until: Date.now() + ms }; send(p.ws, { t: 'gesture', kind, ms }); }
/** What a player is busy with, for the snapshot: { act: kind, ap: how far along }. */
function actionView(p, now) {
  if (p.hack && !p.dead) return { act: p.hack.kind, ap: Math.round(Math.min(1, Math.max(0, (now - p.hack.start) / Math.max(1, p.hack.until - p.hack.start))) * 100) / 100 };
  if (p.gesture && p.gesture.until > now) return { act: p.gesture.kind, ap: Math.round((now - p.gesture.start) / (p.gesture.until - p.gesture.start) * 100) / 100 };
  return {};
}
function cancelHack(p, reason) { if (!p.hack) return; p.hack = null; send(p.ws, { t: 'hack', cancel: true, reason }); }

const TEAM_HACK = ACTIVITIES.teamHack;
/** Crewmates close enough to help with a hack (up, not hacking themselves). */
function hackHelpers(p) {
  let n = 0;
  for (const m of squadMembersOnline(p)) if (m !== p && !m.dead && !m.downed && !m.hack && Math.hypot(m.x - p.x, m.z - p.z) <= TEAM_HACK.helperRange) n++;
  return Math.min(n, TEAM_HACK.maxHelpers);
}
function tickHacks(now) {
  const dtMs = 1000 / TICK_HZ;
  for (const p of players.values()) {
    const h = p.hack;
    if (!h) continue;
    if (TEAM_HACK.speedUp.includes(h.kind)) {
      // Each helper takes speedPerHelper seconds off per second.
      const helpers = hackHelpers(p);
      h.until -= dtMs * TEAM_HACK.speedPerHelper * helpers;
      if (helpers !== (h.helpers || 0)) { h.helpers = helpers; send(p.ws, { t: 'hack', kind: h.kind, until: h.until, total: h.total, helpers }); }
    }
    // Hacking broadcasts your position to enemies nearby.
    if (TEAM_HACK.exposes.includes(h.kind) && now - (h.exposedAt || 0) >= 1000) {
      h.exposedAt = now;
      for (const o of players.values()) {
        if (o === p || o.dead || sameSquad(o, p) || Math.hypot(o.x - p.x, o.z - p.z) > TEAM_HACK.exposeRange) continue;
        expose(p, squadKey(o), 1500);
        send(o.ws, { t: 'expose', ids: [p.id], until: now + 1500, kind: 'sensor' });
      }
    }
    if (p.dead || (p.downed && h.kind !== 'selfrevive')) { cancelHack(p, 'You went down'); continue; }
    if (h.kind === 'revive') { const t = players.get(h.id); if (!t || !t.downed || t.dead) { cancelHack(p, 'Too late'); continue; } }
    if (h.kind === 'datahack') {
      // The target stays pinned while you hack them.
      const t = findCharacter(h.id);
      if (!t || t.dead || Math.hypot(t.x - p.x, t.z - p.z) > DATAHACK.range + 1) { cancelHack(p, 'Lost them'); continue; }
      if (isStunned(t, now)) t.stunnedUntil = Math.max(t.stunnedUntil, now + 600);
      else if (!t.downed) { cancelHack(p, 'They shook it off'); continue; }
    }
    if (h.walk) { if (p.sprint || p.boat) { cancelHack(p, h.kind === 'eat' ? 'Stopped eating' : 'Stopped patching up'); continue; } }
    else {
      if (Math.hypot(p.x - h.x, p.z - h.z) > 0.6) { cancelHack(p, 'Interrupted — you moved'); continue; }
      if ((p.lastHit || 0) > h.start) { cancelHack(p, 'Interrupted — taking fire'); continue; }
    }
    if (now < h.until) continue;
    p.hack = null;
    if (h.kind === 'eat') { eat(p, h.good); send(p.ws, { t: 'hack', done: true, text: '' }); continue; }
    if (h.kind === 'heal') { finishHeal(p); continue; }
    if (h.kind === 'claim') { finishClaim(p, h.id); continue; }
    if (h.kind === 'claimBuilding') { finishClaimBuilding(p, h.id); continue; }
    if (h.kind === 'datahack') { finishDataHack(p, h.id); continue; }
    if (h.kind === 'cook') { finishCook(p); continue; }
    if (h.kind === 'fish') { finishFishing(p); continue; }
    if (h.kind === 'hotwire') { finishHotwire(p, h.id); continue; }
    if (h.kind === 'hotcrate') { finishHotCrate(p, h.id); continue; }
    if (h.kind === 'breakbox') { finishBreakBox(p, h.id); continue; }
    if (h.kind === 'disarm') {
      const st = structs.get(h.id);
      if (!st) { send(p.ws, { t: 'hack', done: true, text: 'Gone already' }); continue; }
      const mine = PIECES[st.type].defense === 'mine';
      removeStruct(st, true);
      if (mine) p.salvage = (p.salvage || 0) + DEF.mine.salvageBack;
      send(p.ws, { t: 'hack', done: true, text: mine ? `Mine disarmed (+${DEF.mine.salvageBack} salvage)` : 'Wire cut' });
      logAway(st.owner, `${p.name} ${mine ? 'disarmed one of your land mines' : 'cut one of your tripwires'}`);
      warnTeam(st.owner, `⚠ ${p.name} ${mine ? 'disarmed a mine' : 'cut a tripwire'} at your base`, st.x, st.z, mine ? 'Mine disarmed' : 'Wire cut');
      dirty(p);
      continue;
    }
    if (h.kind === 'selfrevive') {
      const i = p.inv.pack.findIndex((x) => x.kind === 'medkit');
      if (!p.downed || i < 0) { send(p.ws, { t: 'hack', done: true, text: 'No medkit' }); continue; }
      p.inv.pack.splice(i, 1);
      p.selfReviveAt = now + DOWNED.selfReviveCooldownMs;
      revive(p, null);
      p.hp = DOWNED.selfReviveHp;
      send(p.ws, { t: 'hack', done: true, text: `Patched up. You can do that again in ${Math.round(DOWNED.selfReviveCooldownMs / 60000)} minutes.` });
      dirty(p);
      continue;
    }
    if (h.kind === 'rebuild') {
      const st = structs.get(h.id);
      if (!st || !(st.ruined || st.broken)) continue;
      const cost = st.ruined ? RAIDS.ruin.rebuildCost : RAIDS.ruin.doorRebuildCost;
      if (!payCarried(p, cost)) { send(p.ws, { t: 'hack', done: true, text: 'Missing materials' }); continue; }
      if (st.ruined) { st.ruined = false; st.hp = flagMax(st) * RAIDS.ruin.rebuildHp; refreshContainerViewers('crate', st.id); }
      else { st.broken = false; st.open = false; st.hp = stageDef(st).hp * RAIDS.ruin.rebuildHp; }
      send(p.ws, { t: 'hack', done: true, text: st.claimOf ? 'Door rebuilt' : 'Stash house rebuilt' });
      dirty(p);
      continue;
    }
    if (h.kind === 'revive') {
      const t = players.get(h.id);
      if (t && t.downed && !t.dead && Math.hypot(t.x - p.x, t.z - p.z) <= DOWNED.reviveRange + 0.5) { revive(t, p); send(p.ws, { t: 'hack', done: true, text: `${t.name} is back up` }); }
      else send(p.ws, { t: 'hack', done: true, text: 'Too late' });
      continue;
    }
    if (h.kind === 'harvest') {
      const hv = harvested.get(h.id) || { uses: 0, regrowAt: 0 };
      if (hv.uses >= BUILD.harvest.uses && hv.regrowAt <= now) hv.uses = 0;
      hv.uses++;
      if (hv.uses >= BUILD.harvest.uses) {
        hv.regrowAt = now + Number(process.env.HARVEST_REGROW_MS || BUILD.harvest.regrowMs);
        // A tree with nothing left comes down to a stump (a rock crumbles to rubble) for everyone until it's back.
        if (h.box && h.box.nature && ['tree', 'pine', 'rock', 'boulder'].includes(h.box.type)) { hv.box = h.box; h.box.gone = 1; map.felled.add(h.box.id); broadcast({ t: 'felled', id: h.box.id, on: 1 }); }
      }
      harvested.set(h.id, hv);
      const n = BUILD.harvest[h.res];
      p[h.res] += n;
      wearTool(p, h.res === 'wood' ? 'hatchet' : 'pickaxe', WEAR.harvestUse);
      send(p.ws, { t: 'hack', done: true, text: `+${n} ${h.res}` });
    } else if (h.kind === 'upgrade') {
      const st = structs.get(h.id);
      if (!st) continue;
      const next = PIECES[st.type].stages[st.stage + 1];
      if (!next || !payCarried(p, next.cost)) { send(p.ws, { t: 'hack', done: true, text: 'Missing materials' }); continue; }
      const frac = st.hp / stageDef(st).hp;
      st.stage++;
      st.hp = Math.max(next.hp * frac, next.hp * 0.5);
      if (st.stage === 1 && stageDef(st).material !== 'frame') st.hp = next.hp;
      award(p, 15, `Built ${next.name}`);
      homeBuildXp(p, st, `Built ${next.name}`);
      send(p.ws, { t: 'hack', done: true, text: `${next.name} complete` });
      if (PIECES[st.type].container) refreshContainerViewers('crate', st.id);
    } else if (h.kind === 'raid') {
      const st = structs.get(h.id);
      if (!st) continue;
      const r = BUILD.raid[h.tool];
      if (!r.vs.split(',').includes(stageDef(st).material)) { send(p.ws, { t: 'hack', done: true, text: `A ${h.tool} won't break ${stageDef(st).material}` }); continue; }
      damageStruct(st, r.dmg, p);
      wearTool(p, h.tool, WEAR.raidUse);
      const through = !structs.has(st.id) || st.ruined || st.broken;
      send(p.ws, { t: 'hack', done: true, text: through ? 'Broken through!' : `${stageDef(st).name}: ${Math.max(0, Math.round(st.hp))} HP left` });
    } else if (h.kind === 'gatehack') {
      const st = structs.get(h.id);
      if (!st || p.tech < (h.tech ?? GADGETS.doorHack.cost)) continue;
      p.tech -= h.tech ?? GADGETS.doorHack.cost;
      st.open = true;
      award(p, XP.hackDoor, 'Gate lock bypassed', true);
      send(p.ws, { t: 'hack', done: true, text: 'Gate unlocked' });
    } else if (h.kind === 'terminal') {
      terminalReadyAt.set(h.id, now + TERMINAL_COOLDOWN_MS);
      p.intel += TERMINAL_REWARD.intel;
      p.tech += TERMINAL_REWARD.tech;
      award(p, XP.hackTerminal, 'Terminal hacked', true);
      const seen = terminalScan(p, map.terminals[h.id]);
      send(p.ws, { t: 'hack', done: true, text: `Area scan: ${seen} hostile${seen === 1 ? '' : 's'} within ${feet(ACTIVITIES.terminal.scanRadius, 50)} lit up · +${TERMINAL_REWARD.tech} tech, +${TERMINAL_REWARD.intel} intel` });
      for (const c of [...p.contracts]) if (c.type === 'heist' && c.terminalId === h.id) completeContract(p, c);
    } else if (h.kind === 'door') {
      const house = db.houses[h.id];
      if (house.doorHp <= 0 || house.doorOpen) { send(p.ws, { t: 'hack', done: true, text: 'Door already open' }); continue; }
      p.tech -= h.tech ?? GADGETS.doorHack.cost;
      house.doorOpen = true;
      if (house.owner) logAway(house.owner, `${p.name} bypassed the lock on your stash house door`);
      award(p, XP.hackDoor, 'Lock bypassed', true);
      notifyOwner(h.id, `⚠ ${p.name} hacked open your stash house door!`);
      send(p.ws, { t: 'hack', done: true, text: `${house.ownerName || 'The'}'s door is open` });
    } else if (h.kind === 'drop') {
      const d = drops.get(h.id);
      if (!d) { send(p.ws, { t: 'hack', done: true, text: 'Someone beat you to it' }); continue; }
      drops.delete(h.id);
      const { comms, ...res } = SUPPLY_DROP_CONTENTS;
      for (const [k, v] of Object.entries(res)) p[k] += v;
      p.comms += comms;
      if (Math.random() < FLARE.dropChance && p.inv.pack.length < PACK_SIZE) { p.inv.pack.push(makeFlare()); toast(p, 'There was a rescue flare in the drop!'); }
      if (Math.random() < HZ.hotDrop.dropChance && p.inv.pack.length < PACK_SIZE) { p.inv.pack.push(makeHotFlare()); toast(p, 'There was a hot-drop flare in the drop!'); }
      if (Math.random() < COMBAT.rocket.dropChance) { const n = 1 + Math.floor(Math.random() * 2); p.rockets = (p.rockets || 0) + n; toast(p, `There ${n === 1 ? 'was a rocket' : `were ${n} rockets`} in the drop!`); }
      award(p, XP.supplyDrop, 'Supply drop secured', true);
      feed(`${p.name} secured a supply drop`);
      sendEvents();
      send(p.ws, { t: 'hack', done: true, text: `+${res.salvage} salvage, +${res.parts} parts, +${res.tech} tech, +${comms} commendation. Get it home!` });
    } else if (h.kind === 'crate') {
      const o = objectives.get(h.id);
      if (!o) continue;
      if (p.inv.pack.length >= PACK_SIZE) { send(p.ws, { t: 'hack', done: true, text: 'Backpack full' }); continue; }
      objectives.delete(h.id);
      p.inv.pack.push({ id: uid('pkg'), kind: 'package', name: 'Recovered supply crate', contractId: o.contractId });
      send(p.ws, { t: 'hack', done: true, text: 'Crate recovered — deliver it to any Contact' });
      pushContracts(p);
    }
    dirty(p);
  }
}

// ---------------------------------------------------------------- combat
const DOWNED = COMBAT.downed;
/** Can this player be revived if they drop? Only with a crewmate who is online and still up. */
function canGoDown(p) { return squadMembersOnline(p).some((m) => m !== p && !m.dead && !m.downed) || soloRevive(p); }
/** A player with nobody from their crew online can patch themselves up with a medkit, once in a while. */
function soloRevive(p, now = Date.now()) {
  return !squadMembersOnline(p).some((m) => m !== p) && p.inv.pack.some((i) => i.kind === 'medkit') && (p.selfReviveAt || 0) <= now;
}
function goDown(p, attacker, headshot) {
  const now = Date.now();
  Object.assign(p, { downed: true, downedUntil: now + DOWNED.bleedOutMs, bleedHp: DOWNED.bleedHp, downedBy: attacker || null, downedHead: !!headshot, hp: 0, camoOn: false, crouch: true });
  cancelHack(p, 'You went down');
  p.openContainer = null;
  send(p.ws, { t: 'container', closed: true });
  feed(`${attacker ? attacker.name : 'The city'} downed ${p.name}`);
  for (const m of squadMembersOnline(p)) if (m !== p) { toast(m, `✚ ${p.name} is down — get to them and revive (E)`); send(m.ws, { t: 'alert', x: p.x, z: p.z, text: `${p.name} down` }); }
  toast(p, soloRevive(p) ? 'You\'re down! Patch yourself up with a medkit, or crawl to cover.' : 'You\'re down! Crawl to cover — a crewmate can revive you. Q / Ⓨ to give up.');
  dirty(p);
}
function revive(p, by) {
  Object.assign(p, { downed: false, downedUntil: 0, bleedHp: 0, downedBy: null, hp: DOWNED.reviveHp });
  p.protectedUntil = 0;
  if (by) feed(`${by.name} revived ${p.name}`);
  if (by) award(by, DOWNED.reviveXp, `Revived ${p.name}`);
  toast(p, by ? `${by.name} got you back up` : 'Back on your feet');
  dirty(p);
}
/** Downed players bleed out; a whole crew down (nobody left to revive) is a wipe. */
function tickDowned(now) {
  for (const p of players.values()) {
    if (!p.downed || p.dead) continue;
    if (now > p.downedUntil || !canGoDown(p)) killPlayer(p, p.downedBy, p.downedHead);
  }
}
function applyDamage(target, amount, attacker, isBot, headshot = false, ammo = null) {
  if (target.dead) return;
  if (!isBot && attacker && !attacker.isBot && (inFair(target.x, target.z) || inFair(attacker.x, attacker.z) || inCamp(target.x, target.z) || inCamp(attacker.x, attacker.z))) return;   // the fairgrounds and swamp camps are safe zones
  if (target.npc && (target.kind === 'trader' || target.kind === 'pawn')) return;   // traders and Lamar are left alone by everyone
  if (!isBot && (target.protectedUntil || 0) > Date.now()) return;
  if (!isBot && !pvpAllowed(attacker, target)) return;
  if (!isBot && target.downed) {
    // Shooting someone who's down finishes them off.
    target.bleedHp -= amount;
    target.lastHit = Date.now();
    if (attacker) target.downedBy = attacker;
    if (target.bleedHp <= 0) killPlayer(target, attacker || target.downedBy, headshot || target.downedHead);
    dirty(target);
    return;
  }
  // Ammunition: armor-piercing chews through plates faster, hollow points hit health harder.
  const vsArmor = ammo?.armor ?? 1, vsFlesh = ammo?.flesh ?? 1;
  let dmg = amount;
  if (!isBot && target.armor > 0) { const absorbed = Math.min(target.armor, dmg * vsArmor); target.armor -= absorbed; dmg -= absorbed / vsArmor; }
  target.hp -= dmg * vsFlesh;
  target.lastHit = Date.now();
  if (target.animal) { target.hurtUntil = Date.now() + 6000; target.lastAttacker = attacker; }
  if (target.eventId && attacker && !attacker.isBot) worldEvents.get(target.eventId)?.hitters.add(attacker.token);
  if (!isBot) { breakCamo(target, 3000); dirty(target); }
  if (isBot && !target.animal && !target.npc && !target.dog && attacker && !attacker.isBot) botProvoked(target, attacker);
  if (target.hp <= 0) { target.hp = 0; if (isBot) killBot(target, attacker, headshot); else if (canGoDown(target)) goDown(target, attacker, headshot); else killPlayer(target, attacker, headshot); }
}
function dropBag(x, z, items, res = {}, label = 'Bag') {
  const bag = { id: 'bag' + crypto.randomBytes(6).toString('hex'), x, z, items: items.filter(Boolean), label, expires: Date.now() + BAG_LIFETIME_MS };
  for (const r of RESOURCES) bag[r] = Math.floor(res[r] || 0);
  if (bag.items.length || RESOURCES.some((r) => bag[r])) db.bags.push(bag);
}
function markAssist(target, killer) {
  const m = target.markedBy;
  target.markedBy = null;
  if (!m || m.until < Date.now() || !killer || m.token === killer.token) return;
  const marker = onlineByToken(m.token);
  if (marker) award(marker, XP.markAssist, 'Tagged target eliminated');
}

/**
 * Death: everything you carry (gear, ammo, parts, tech, salvage, intel) drops in a bag where you fell.
 * You keep your level, unlocks, commendations, field gear and everything in your stash house.
 */
// ---------------------------------------------------------------- coming back after a death
const RESPAWN = { ...ACTIVITIES.respawn };
if (process.env.RESPAWN_WAIT_S) RESPAWN.waitS = RESPAWN.perDeathS = Number(process.env.RESPAWN_WAIT_S);
if (process.env.RESPAWN_KEEPAWAY_M) RESPAWN.keepAwayM = Number(process.env.RESPAWN_KEEPAWAY_M);
/** When you can come back, and the circle round where you died that's closed for now. */
function respawnRules(p, now = Date.now()) {
  const recent = (p.deaths || []).filter((t) => now - t < RESPAWN.streakMin * 60_000);
  const wait = Math.min(RESPAWN.maxWaitS, RESPAWN.waitS + RESPAWN.perDeathS * Math.max(0, recent.length - 1));
  const away = p.deathSpot && now - p.deathSpot.t < RESPAWN.keepAwayMin * 60_000 && RESPAWN.keepAwayM > 0 ? p.deathSpot : null;
  return { readyAt: (p.diedAt || 0) + wait * 1000, away, deaths: recent.length, crewAt: (p.crewDropAt || 0) + RESPAWN.crewEveryMin * 60_000 };
}
const nearDeath = (r, x, z) => !!r.away && Math.hypot(x - r.away.x, z - r.away.z) < RESPAWN.keepAwayM;
const minsLeft = (ms) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;
function killPlayer(p, attacker, headshotKill) {
  {
    const now = Date.now();
    p.deaths = [...(p.deaths || []).filter((t) => now - t < RESPAWN.streakMin * 60_000), now];
    p.diedAt = now;
    p.deathSpot = { x: Math.round(p.x), z: Math.round(p.z), t: now };
  }
  if (p.air) { p.air = null; send(p.ws, { t: 'air', mode: null }); }
  if (p.boat) unseat(p);
  p.dead = true;
  Object.assign(p, { downed: false, downedUntil: 0, bleedHp: 0, downedBy: null });
  const { primary, primary2, secondary, armor, pack } = p.inv;
  const keepIntel = hasField(p, 'pouch') ? Math.min(3, p.intel) : 0;
  // Your claim marker and tools stay with you: losing them would leave you unable to start again.
  const keep = pack.filter((i) => i && (i.kind === 'marker' || i.kind === 'tool'));
  dropBag(p.x, p.z, [primary, primary2, secondary, armor, ...pack.filter((i) => !keep.includes(i))], { ...Object.fromEntries(RESOURCES.map((r) => [r, p[r]])), intel: p.intel - keepIntel }, `${p.name}'s bag`);
  p.inv = { primary: null, primary2: null, secondary: null, armor: null, pack: keep };
  p.mags = {}; p.armor = 0; p.camoOn = false;
  for (const r of RESOURCES) p[r] = 0;
  p.intel = keepIntel;
  p.hotLoose = null;   // the loose cash and intel went into the bag with everything else
  cancelHack(p, 'You went down');
  markAssist(p, attacker);
  const by = attacker ? attacker.name : 'the city';
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    // The same victim again within ten minutes is worth half as much each time (no trading kills for XP).
    const again = (attacker.recentKills ??= new Map());
    const prev = again.get(p.token);
    const streak = prev && Date.now() - prev.at < XP.repeatKillMs ? prev.n + 1 : 0;
    again.set(p.token, { at: Date.now(), n: streak });
    award(attacker, Math.round((XP.playerKill + 20 * level(p) + (headshotKill ? XP.headshotKill : 0)) / 2 ** streak), `Killed ${p.name}`, true);
  }
  feed(`${by} ➜ ${p.name}`);
  send(p.ws, { t: 'died', by, deploy: deployOptions(p) });
  dirty(p);
}

function killBot(b, attacker, headshotKill) {
  b.dead = true;
  if (b.eventId) eventBotDown(b, attacker);
  if (b.npc && b.kind !== 'convoy') { npcDown(b, attacker); bots.delete(b.id); return; }
  if (b.kind === 'convoy') { bots.delete(b.id); return; }
  if (b.dog) {
    const st = structs.get(b.kennel);
    if (st) { st.dogDeadUntil = Date.now() + DEF.kennel.respawnMs; st.dog = null; warnTeam(b.owner, `⚠ ${attacker?.name || 'Someone'} killed your guard dog`, b.x, b.z, 'Dog down'); }
    bots.delete(b.id);
    return;
  }
  if (b.animal) {
    const a = HOMESTEAD.animals[b.kind];
    dropBag(b.x, b.z, [], { meat: a.meat, ...(a.hide ? { hide: a.hide } : {}) }, `${a.name} carcass`);
    bots.delete(b.id);
    if (attacker && !attacker.isBot) award(attacker, HOMESTEAD.animals.xp, `Hunted a ${a.name.toLowerCase()}`);
    return;
  }
  const res = b.kind === 'hvt' ? { ammo: 60, parts: 40, tech: 20, salvage: 30, intel: 2 } : { ammo: 30, parts: 15, tech: 5, salvage: 8, intel: b.serial % 2 };
  // What they carried is yours to take: their gun, and a Lieutenant's plate carrier.
  const gear = [makeWeapon(b.arche || 'carbine', {}, 'factory', 'random'), ...(b.kind === 'hvt' ? [makeArmor('medium')] : []), ...(b.serial % 3 === 0 ? [makeConsumable('medkit')] : []),
    ...(b.kind === 'hvt' && Math.random() < FLARE.lieutenantChance ? [makeFlare()] : [])];
  dropBag(b.x, b.z, gear, res, b.kind === 'hvt' ? 'Lieutenant\'s body' : 'Rogue\'s body');
  markAssist(b, attacker);
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    award(attacker, (b.kind === 'hvt' ? 300 : b.kind === 'guard' ? 150 : XP.rogueKill) + (headshotKill ? XP.headshotKill : 0), b.kind === 'hvt' ? 'Lieutenant down' : b.kind === 'guard' ? 'Elite guard down' : 'Rogue down', true);
    if (b.kind !== 'ambient') feed(`${attacker.name} ➜ ${b.name}`);
  }
  bots.delete(b.id);
  if (b.contractId && !b.contractId.endsWith('-escort')) {
    const owner = onlineByToken(b.ownerToken);
    const rest = [...bots.values()].some((o) => o.contractId === b.contractId && !o.dead);
    if (rest) return;
    if (owner) { const c = owner.contracts.find((x) => x.id === b.contractId); if (c) completeContract(owner, c); }
    else { const c = db.characters[b.ownerToken]?.contracts?.find((x) => x.id === b.contractId); if (c) c.ready = true; }
  }
}

function traceShot(ox, oy, oz, dx, dy, dz, range, shooterId) {
  const world = rayAgainstBoxes(ox, oy, oz, dx, dy, dz, grid.ray(ox, oz, dx, dz, range), range);
  let best = world.t, target = null, kind = world.box ? 'world' : null, headshot = false;
  const ground = terrain.ray(ox, oy, oz, dx, dy, dz, Math.min(best, range));
  if (ground < best) { best = ground; kind = 'world'; }
  for (const s of structsNear(ox + dx * range / 2, oz + dz * range / 2, range / 2 + 3)) {
    if (!structIsSolid(s)) continue;
    const t = rayHitBox(structBox(s), ox, oy, oz, dx, dy, dz);
    if (t < best) { best = t; target = s; kind = 'struct'; }
  }
  for (const h of map.houses) {
    if (Math.abs(h.x - ox) > range + 8 || Math.abs(h.z - oz) > range + 8) continue;
    const d = doorBox(h.id);
    if (!d) continue;
    const t = rayBox(ox, oy, oz, dx, dy, dz, d.minX, d.y0, d.minZ, d.maxX, d.y0 + d.h, d.maxZ);
    if (t < best) { best = t; target = h.id; kind = 'door'; }
  }
  for (const b of db.boats) {
    if (Math.abs(b.x - ox) > range + 6 || Math.abs(b.z - oz) > range + 6) continue;
    if (rtOf(b).seats.includes(shooterId)) continue;
    const def = BOATS[b.type], sn = Math.abs(Math.sin(b.yaw)), cs = Math.abs(Math.cos(b.yaw));
    const ex = (sn * def.len / 2 + cs * def.wid / 2) * 0.8, ez = (cs * def.len / 2 + sn * def.wid / 2) * 0.8;
    const y0 = def.land ? rideY(b) : -0.3, y1 = def.land ? y0 + def.h : 0.8;
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x - ex, y0, b.z - ez, b.x + ex, y1, b.z + ez);
    if (t < best) { best = t; target = b; kind = 'boat'; }
  }
  const check = (c, k) => {
    if (c.dead || c.id === shooterId || Math.abs(c.x - ox) > best + 1 || Math.abs(c.z - oz) > best + 1) return;
    const b = characterBounds(c.x, c.z, c.crouch, gy(c), c.prone);
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t < best) { best = t; target = c; kind = k; headshot = oy + dy * t > b.maxY - 0.3; }
  };
  for (const p of players.values()) check(p, 'player');
  for (const b of bots.values()) check(b, 'bot');
  return { t: best, target, kind, headshot };
}

const REWIND_MS = 300;   // favour the shooter: a hit on what their screen showed up to this long ago counts
function fire(shooter, dir, isBot = false, botAccuracy = 1, opts = {}) {
  const s = isBot ? shooter.weapon : stats(shooter);
  const eye = shooter.prone ? PRONE_EYE : shooter.crouch ? CROUCH_EYE : STAND_EYE;
  let ox = shooter.x, oy = gy(shooter) + eye, oz = shooter.z;
  // Fired from where the shooter's own screen has them (a step ahead of the server's copy of them when
  // they've just stepped out from a corner), if that's close and nothing solid is in between: otherwise a
  // shot from round a corner would hit the wall the server still has them behind.
  if (!isBot && opts.from) {
    const [fx, fy, fz] = opts.from, ddx = fx - ox, ddy = fy - oy, ddz = fz - oz, dl = Math.hypot(ddx, ddz);
    if (dl <= 1.6 && Math.abs(ddy) <= 0.8 && (dl < 0.05 || rayAgainstBoxes(ox, oy, oz, ddx / Math.hypot(ddx, ddy, ddz), ddy / Math.hypot(ddx, ddy, ddz), ddz / Math.hypot(ddx, ddy, ddz), solidsNear(ox, oz, dl + 1), Math.hypot(ddx, ddy, ddz) + 0.35).t > Math.hypot(ddx, ddy, ddz) + 0.3)) { ox = fx; oy = fy; oz = fz; }
  }
  // The shot goes from your eye to the point under your crosshair, so it lands where you aimed even
  // if the server's copy of you is a step behind where your screen has you.
  if (opts.at) { const ax = opts.at[0] - ox, ay = opts.at[1] - oy, az = opts.at[2] - oz, al = Math.hypot(ax, ay, az); if (al > 0.5 && al < 2000) dir = [ax, ay, az]; }
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const base = [dir[0] / len, dir[1] / len, dir[2] / len];
  const moving = !isBot && shooter.speed > 0.5;
  // Single-shot guns (pistols, marksman rifles, launchers) reward a careful shot: aimed, standing
  // still, with a breath since the last one, the round goes exactly where the crosshair is. Rushed
  // or on the move they still group far tighter than an automatic. Shotgun pellets always spread.
  const careful = !isBot && s.semi && s.pellets === 1 && shooter.aiming && !moving && (opts.since ?? Infinity) >= Math.max(350, 60_000 / s.rpm * 1.4);
  const semiMul = !isBot && s.semi && s.pellets === 1 ? (shooter.aiming ? 0.35 : 0.6) : 1;
  const baseSpread = isBot ? s.hipSpread * 0.6 : careful ? 0 : (shooter.aiming ? s.adsSpread : s.hipSpread) * semiMul;
  const spreadMul = (moving ? (s.semi ? 1.3 : 1.6) : 1) * (shooter.prone ? 0.6 : shooter.crouch ? 0.8 * s.crouchSpread : 1) / botAccuracy;
  // Two directions square to the shot, for scattering it in a cone.
  const ux = Math.abs(base[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = [base[1] * ux[2] - base[2] * ux[1], base[2] * ux[0] - base[0] * ux[2], base[0] * ux[1] - base[1] * ux[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1; u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = [base[1] * u[2] - base[2] * u[1], base[2] * u[0] - base[0] * u[2], base[0] * u[1] - base[1] * u[0]];
  const seen = !isBot && opts.tid ? (players.get(opts.tid) || bots.get(opts.tid)) : null;   // who was under their crosshair
  const tracers = [];
  for (let i = 0; i < s.pellets; i++) {
    const sp = baseSpread * spreadMul;
    // Scatter inside a cone of that size, bunched toward the middle (most shots near the crosshair,
    // a few out at the edge), instead of evenly over a square.
    const ang = Math.random() * Math.PI * 2, rad = sp * Math.min(1, Math.abs((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * 1.6);
    let dx = base[0] + (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * rad, dy = base[1] + (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * rad, dz = base[2] + (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * rad;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const maxRange = s.range * 2.2;
    let hit = traceShot(ox, oy, oz, dx, dy, dz, maxRange, shooter.id);
    // Lag: the target the shooter saw may have moved on since. If the shot went through where it
    // was a moment ago (and nothing nearer was in the way), it's a hit.
    if (seen && hit.target !== seen && !seen.dead && seen !== shooter) {
      const nowT = Date.now();
      for (const h of seen.hist || []) {
        if (nowT - h.t > REWIND_MS) continue;
        const b = characterBounds(h.x, h.z, h.crouch, h.y, h.prone);
        const tt = rayBox(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
        if (tt > 0 && tt < hit.t && tt < maxRange) { hit = { t: tt, target: seen, kind: players.has(seen.id) ? 'player' : 'bot', headshot: oy + dy * tt > b.maxY - 0.3 }; break; }
      }
    }
    const t = Math.min(hit.t, maxRange);
    if (s.explosive) {   // a rocket: a smoke trail, and a blast where it stops
      const ex = ox + dx * Math.max(0, t - 0.3), ey = oy + dy * Math.max(0, t - 0.3), ez = oz + dz * Math.max(0, t - 0.3);
      tracers.push([+ex.toFixed(2), +ey.toFixed(2), +ez.toFixed(2), 3]);
      setTimeout(() => explode({ id: uid('rk'), x: ex, y: ey - 0.5, z: ez, owner: shooter.token, ownerName: shooter.name }, Date.now(), COMBAT.rocket), Math.min(900, t / 0.12));   // flies ~120 m/s
      continue;
    }
    tracers.push([+(ox + dx * t).toFixed(2), +(oy + dy * t).toFixed(2), +(oz + dz * t).toFixed(2), hit.kind === 'player' || hit.kind === 'bot' ? 2 : hit.kind ? 1 : 0]);   // 2 a person or animal, 1 anything solid, 0 nothing
    if (!hit.kind || hit.kind === 'world') continue;
    const F = COMBAT.falloff;
    const falloff = t <= s.range ? 1 : Math.max(F.minMul, 1 - (t - s.range) / (s.range * F.overRangeSpan) * F.maxDrop);
    let dmg = s.damage * falloff;
    if (hit.headshot && !isBot) dmg *= COMBAT.headshotMul;   // the AI aims centre mass: no headshot bonus
    if (!isBot && (shooter.buffUntil || 0) > Date.now()) dmg *= 1.2;
    if (hit.kind === 'player' && !isBot && sameSquad(shooter, hit.target)) continue;
    if (hit.kind === 'boat') { damageBoat(hit.target, dmg * 0.5, isBot ? null : shooter); continue; }
    if (hit.kind === 'struct') {
      damageStruct(hit.target, dmg * (BUILD.bulletMul[stageDef(hit.target).material] ?? 0.1), isBot ? null : shooter);
      continue;
    }
    if (hit.kind === 'door') {
      damageHouseDoor(hit.target, dmg, shooter);
    } else {
      applyDamage(hit.target, dmg, shooter, hit.kind === 'bot', hit.headshot, isBot ? null : s);
      if (!isBot) send(shooter.ws, { t: 'hitmark', dmg: Math.round(dmg), crit: hit.headshot, x: tracers.at(-1)[0], y: tracers.at(-1)[1], z: tracers.at(-1)[2] });
    }
  }
  if (!isBot) { breakCamo(shooter, 2000); shooter.protectedUntil = 0; botsHear(shooter, s.suppressed ? (s.subsonic ? 8 : 22) : 70); }
  const msg = JSON.stringify({ t: 'shot', from: shooter.id, sup: s.suppressed ? (s.subsonic ? 2 : 1) : 0, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], hits: tracers });
  for (const p of players.values()) if (p.ws.readyState === 1 && Math.abs(p.x - ox) < INTEREST && Math.abs(p.z - oz) < INTEREST) p.ws.send(msg);
}
function notifyOwner(houseId, text) { notifyStore(db.houses[houseId], text); }

// ---------------------------------------------------------------- AI ("Rogues")
let botSerial = 0;
const BOT_WEAPONS = COMBAT.bots.weapons;
function spawnBot(x, z, kind = 'ambient', extra = {}) {
  const def = kind === 'hvt' ? COMBAT.bots.hvt : kind === 'guard' ? COMBAT.bots.guard : COMBAT.bots.rogue;
  const arche = def.weapon || BOT_WEAPONS[botSerial % BOT_WEAPONS.length];
  const w = weaponStats(makeWeapon(arche));
  const hp = def.hp;
  const p = resolveCircle(x, z, PLAYER_RADIUS, solidsNear(x, z, 3), terrain.height(x, z));
  const b = {
    id: uid('b'), name: def.name, isBot: true, kind, serial: botSerial++,
    x: p.x, z: p.z, homeX: p.x, homeZ: p.z, yaw: 0, hp, maxHp: hp, dead: false,
    weapon: { ...w, damage: w.damage * def.damageMul }, arche,
    nextShot: 0, wander: null, crouch: false, burst: 0, ...extra,
  };
  bots.set(b.id, b);
  return b;
}

// ---- wildlife: deer and wild hogs to hunt. They wander, and bolt when you get close.
const ANIMALS = HOMESTEAD.animals;
function spawnAnimal(kind, x, z) {
  const a = ANIMALS[kind];
  const b = { id: uid('a'), name: a.name, isBot: true, animal: true, kind, serial: botSerial++, x, z, homeX: x, homeZ: z, yaw: Math.random() * 6.28, hp: a.hp, maxHp: a.hp, dead: false, wander: null };
  bots.set(b.id, b);
  return b;
}
function manageAnimals() {
  const alive = [...players.values()].filter((p) => !p.dead && !p.deploying);
  for (const b of bots.values()) if (b.animal && !alive.some((p) => dist2(p, b) < ANIMALS.despawn ** 2)) bots.delete(b.id);
  for (const p of alive) {
    let near = 0;
    for (const b of bots.values()) if (b.animal && dist2(p, b) < 250 * 250) near++;
    if (near >= ANIMALS.perPlayer) continue;
    for (let tries = 0; tries < 12; tries++) {
      const a = Math.random() * Math.PI * 2, d = ANIMALS.spawnMin + Math.random() * (ANIMALS.spawnMax - ANIMALS.spawnMin);
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      if (Math.abs(x) > map.half - 50 || Math.abs(z) > map.half - 50 || terrain.height(x, z) < 0.5) continue;
      if (map.towns.some((t) => x > t.rect.minX - 40 && x < t.rect.maxX + 40 && z > t.rect.minZ - 40 && z < t.rect.maxZ + 40)) continue;
      const biome = biomeName(terrain.biome(x, z));
      let kinds = ['deer', 'hog'].filter((k) => ANIMALS[k].biomes.includes(biome));
      if (biome === 'sea' && nearDeepWater(x, z, ANIMALS.gator.nearWater) && Math.random() < 0.6) kinds = ['gator'];
      if (!kinds.length) continue;
      spawnAnimal(kinds[Math.floor(Math.random() * kinds.length)], x, z);
      break;
    }
  }
}
function nearDeepWater(x, z, r) {
  for (let k = 0; k < 8; k++) for (const f of [0.5, 1]) if (terrain.height(x + Math.cos(k * Math.PI / 4) * r * f, z + Math.sin(k * Math.PI / 4) * r * f) < DEEP_WATER) return true;
  return false;
}
function updateAnimal(b, dt, alive) {
  const a = ANIMALS[b.kind];
  // The hog-hunt boar charges whoever is closest; a gator lunges at anyone who gets too close.
  const aggro = b.aggressive ? 30 : a.aggroRange ? a.aggroRange * (b.hunting ? 1.6 : 1) : 0;
  if (aggro) {
    let prey = null, pd = aggro;
    for (const p of alive) { const d = Math.hypot(p.x - b.x, p.z - b.z); if (d < pd && !p.downed) { pd = d; prey = p; } }
    if (prey) {
      const dx = prey.x - b.x, dz = prey.z - b.z, step = a.speed * dt;
      const np = moveWithCollision(b.x, b.z, dx / pd * step, dz / pd * step, 0.6, solidsNear(b.x, b.z, step + 2), terrain);
      b.x = np.x; b.z = np.z; b.yaw = Math.atan2(dx, dz);
      if (pd < 2.2 && Date.now() >= (b.nextBite || 0)) { b.nextBite = Date.now() + 1000; applyDamage(prey, a.bite || EV.hoghunt.boarBite, b, false); }
      b.hunting = true;
      return;
    }
    b.hunting = false;
    if (a.aggroRange) return;   // a gator lies still until something comes close
  }
  let threat = null, td = a.fleeRange;
  for (const p of alive) {
    const d = Math.hypot(p.x - b.x, p.z - b.z) * (p.crouch ? 1.6 : 1) * (camoActive(p) ? 3 : 1);   // sneak up crouched
    if (d < td) { td = d; threat = p; }
  }
  if (b.hurtUntil > Date.now() && b.lastAttacker) threat = b.lastAttacker;
  let mx = 0, mz = 0, speed = 0;
  if (threat) {
    mx = b.x - threat.x; mz = b.z - threat.z; speed = a.speed;
  } else {
    if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1.5 || Math.random() < 0.004) b.wander = { x: b.homeX + (Math.random() - 0.5) * 60, z: b.homeZ + (Math.random() - 0.5) * 60 };
    mx = b.wander.x - b.x; mz = b.wander.z - b.z; speed = Math.random() < 0.3 ? 0 : a.walk;
  }
  const l = Math.hypot(mx, mz);
  if (l < 1e-3 || !speed) return;
  const step = speed * dt;
  const np = moveWithCollision(b.x, b.z, mx / l * step, mz / l * step, 0.5, solidsNear(b.x, b.z, step + 2), terrain);
  if (Math.hypot(np.x - b.x, np.z - b.z) < step * 0.2) b.wander = null;   // blocked: pick somewhere else
  b.x = np.x; b.z = np.z;
  b.yaw = Math.atan2(mx, mz);
}

/** Keep a few roaming rogues around every active player; despawn ones nobody is near. */
function manageAmbientBots() {
  const alive = [...players.values()].filter((p) => !p.dead);
  for (const b of bots.values()) {
    if (b.kind !== 'ambient') continue;
    if (!alive.some((p) => dist2(p, b) < 550 * 550)) bots.delete(b.id);
  }
  if (!AMBIENT_BOTS) return;
  for (const p of alive) {
    let near = 0;
    for (const b of bots.values()) if (b.kind === 'ambient' && dist2(p, b) < 300 * 300) near++;
    if (near >= AMBIENT_BOTS) continue;
    // A squad of two to four turns up out of sight, 90-260 m off: by a building worth looting, or
    // just out in the country. About half are on patrol toward where you are now, so the fight comes
    // to you; the rest hold their ground.
    let at = null;
    for (let tries = 0; tries < 30 && !at; tries++) {
      let x, z;
      if (tries < 15) { const sp = map.lootSpawns[Math.floor(Math.random() * map.lootSpawns.length)]; x = sp.x + 2; z = sp.z + 2; }
      else { const a = Math.random() * Math.PI * 2, r = 90 + Math.random() * 170; x = p.x + Math.cos(a) * r; z = p.z + Math.sin(a) * r; }
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 90 || d > 260 || terrain.height(x, z) < 0.3 || inCamp(x, z)) continue;
      if (alive.some((o) => Math.hypot(o.x - x, o.z - z) < 80)) continue;
      at = { x, z };
    }
    if (!at) continue;
    const size = Math.min(AMBIENT_BOTS - near, 2 + Math.floor(Math.random() * 3));
    const hunt = Math.random() < 0.5 ? { x: p.x + (Math.random() - 0.5) * 60, z: p.z + (Math.random() - 0.5) * 60 } : null;
    for (let k = 0; k < size; k++) {
      const b = spawnBot(at.x + (Math.random() - 0.5) * 8, at.z + (Math.random() - 0.5) * 8);
      if (hunt) b.patrol = { x: hunt.x + (Math.random() - 0.5) * 8, z: hunt.z + (Math.random() - 0.5) * 8 };
    }
  }
}

// ---- Rogues react: shot at, they turn on the shooter (from any range they can reach) and call the
// squad nearby; a shot they hear brings them to look. In a fight they strafe, close in or back off to
// a good range, rush the last place they saw you when you break line of sight, and pull back to cover
// when hurt. They give up after a while and drift home.
const BOT_AI = { aggroMs: 25_000, callRange: 40, chaseRange: 160, fireRange: 70, bestMin: 9, bestMax: 26, runSpeed: 6.0, walkSpeed: 3.8, flinchMs: 280, hurtBelow: 0.35 };
const fighter = (b) => !b.dead && !b.animal && !b.npc && !b.dog;
function botProvoked(b, attacker, call = true) {
  const now = Date.now();
  b.aggro = { id: attacker.id, until: now + BOT_AI.aggroMs, x: attacker.x, z: attacker.z };
  b.flinchUntil = now + BOT_AI.flinchMs;
  b.nextShot = Math.max(b.nextShot || 0, now + 250);   // a beat to react, not an instant reply
  if (!call) return;
  for (const o of bots.values()) if (o !== b && fighter(o) && !o.aggro && Math.hypot(o.x - b.x, o.z - b.z) < BOT_AI.callRange) botProvoked(o, attacker, false);
}
function botsHear(shooter, range) {
  const now = Date.now();
  for (const b of bots.values()) {
    if (!fighter(b) || (b.aggro && b.aggro.until > now)) continue;
    if (Math.hypot(b.x - shooter.x, b.z - shooter.z) < range) b.aggro = { id: shooter.id, until: now + BOT_AI.aggroMs * 0.6, x: shooter.x, z: shooter.z, heard: true };
  }
}
function updateBots(dt, now) {
  const alive = [...players.values()].filter((p) => !p.dead);
  for (const b of bots.values()) {
    if (b.dead || isStunned(b, now)) continue;
    if (b.dog) { updateDog(b, dt, now); continue; }
    if (b.npc) { if (b.kind !== 'convoy') updateNpc(b, dt, now); continue; }
    if (b.animal) { updateAnimal(b, dt, alive); continue; }
    if (!alive.some((p) => dist2(p, b) < BOT_ACTIVE_RANGE * BOT_ACTIVE_RANGE)) continue;   // asleep
    const sight = (b.kind === 'hvt' ? COMBAT.bots.hvt : b.kind === 'guard' ? COMBAT.bots.guard : COMBAT.bots.rogue).sightRange;
    const sees = (p) => lineOfSight(b.x, gy(b) + STAND_EYE, b.z, p.x, gy(p) + (p.crouch ? 0.9 : 1.3), p.z);
    // Roaming rogues leave you be unless you come right up on them (or shoot: see botsHear / botProvoked).
    // Guards at the big sites and the lieutenant open up on anyone they see.
    const wary = b.kind !== 'hvt' && b.kind !== 'guard';
    let best = null, bestD = wary ? Math.min(sight, COMBAT.bots.rogue.territory ?? 12) : sight;
    for (const p of alive) {
      if (p.downed) continue;   // rogues move on to whoever is still fighting
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d >= bestD) continue;
      if (camoActive(p) && d > 6) continue;
      if ((p.protectedUntil || 0) > now) continue;
      if (sees(p)) { best = p; bestD = d; }
    }
    // Whoever shot at us (or whose shot we heard) comes first, from much further away.
    if (b.aggro && b.aggro.until < now) b.aggro = null;
    let foe = best;
    if (b.aggro) {
      const a = players.get(b.aggro.id);
      if (!a || a.dead || a.downed || Math.hypot(a.x - b.x, a.z - b.z) > BOT_AI.chaseRange) { if (!a || a.dead) b.aggro = null; }
      else if (sees(a)) { foe = a; bestD = Math.hypot(a.x - b.x, a.z - b.z); b.aggro.x = a.x; b.aggro.z = a.z; b.aggro.heard = false; b.aggro.until = Math.max(b.aggro.until, now + 8000); }
    }
    let mx = 0, mz = 0, speed = BOT_AI.walkSpeed;
    const hurt = b.hp < b.maxHp * BOT_AI.hurtBelow;
    if (foe) {
      b.yaw = Math.atan2(foe.x - b.x, foe.z - b.z);
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
      // Strafe side to side, switching every second or two.
      if (!b.strafeAt || now > b.strafeAt) { b.strafe = Math.random() < 0.5 ? -1 : 1; b.strafeAt = now + 900 + Math.random() * 1300; }
      let fwd = 0;
      if (hurt) fwd = -0.9;                                   // pull back, still shooting
      else if (bestD > BOT_AI.bestMax) fwd = 1;               // close in
      else if (bestD < BOT_AI.bestMin) fwd = -0.7;            // too close: give ground
      mx = fx * fwd + fz * b.strafe * 0.75; mz = fz * fwd - fx * b.strafe * 0.75;
      speed = fwd > 0.5 ? BOT_AI.runSpeed : BOT_AI.walkSpeed;
      b.crouch = hurt || (bestD > 20 && b.serial % 3 === 0);
      if (now >= b.nextShot && now >= (b.flinchUntil || 0) && bestD < BOT_AI.fireRange) {
        const dir = [foe.x - b.x, gy(foe) + (foe.crouch ? 0.8 : 1.2) - gy(b) - STAND_EYE, foe.z - b.z];
        fire(b, dir, true, Math.max(0.3, 1.2 - bestD / 30) * (b.crouch ? 1.15 : 1) / (b.kind === 'guard' ? COMBAT.bots.guard.aim : 1));
        b.burst = (b.burst + 1) % 3;   // short bursts with a breather between, so there's time to answer
        b.nextShot = now + (b.burst === 0 ? 1400 + Math.random() * 800 : 60_000 / b.weapon.rpm * 1.3);
      }
    } else if (b.aggro) {
      // Lost sight (or only heard it): go to where they were last, at a run.
      const dx = b.aggro.x - b.x, dz = b.aggro.z - b.z, d = Math.hypot(dx, dz);
      b.crouch = false;
      if (d > 2) { b.yaw = Math.atan2(dx, dz); mx = dx / d; mz = dz / d; speed = BOT_AI.runSpeed; }
      else b.aggro.until = Math.min(b.aggro.until, now + 3000);   // nobody here: look about a moment, then give up
    } else if (b.patrol) {
      // On patrol: walk to the spot, rifle up; once there it's their new ground.
      const dx = b.patrol.x - b.x, dz = b.patrol.z - b.z, d = Math.hypot(dx, dz);
      if (d < 3) { b.homeX = b.patrol.x; b.homeZ = b.patrol.z; b.patrol = null; }
      else { b.yaw = Math.atan2(dx, dz); mx = dx / d; mz = dz / d; speed = BOT_AI.walkSpeed; }
      b.crouch = false;
    } else {
      const leash = b.site ? 26 : b.kind === 'ambient' ? 30 : b.kind === 'guard' ? HZ.guardLeash : 12;
      if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1 || Math.random() < 0.003) {
        b.wander = { x: b.homeX + (Math.random() - 0.5) * leash, z: b.homeZ + (Math.random() - 0.5) * leash };
      }
      b.yaw = Math.atan2(b.wander.x - b.x, b.wander.z - b.z);
      mx = Math.sin(b.yaw) * 0.45; mz = Math.cos(b.yaw) * 0.45;
      b.crouch = false;
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const np = moveWithCollision(b.x, b.z, mx * speed * dt, mz * speed * dt, PLAYER_RADIUS, solidsNear(b.x, b.z, 3), terrain);
    if (Math.hypot(np.x - b.x, np.z - b.z) < 0.001 && (mx || mz)) { b.wander = null; b.strafe = -(b.strafe || 1); }
    b.x = np.x; b.z = np.z;
  }
}

// ---------------------------------------------------------------- loot
function refillLoot(now) {
  const claimed = new Set();
  for (const st of structs.values()) if (st.building != null && PIECES[st.type].claim) claimed.add(st.building);
  map.lootSpawns.forEach((sp, i) => {
    if (lootAtSpawn.has(i) || spawnReadyAt.get(i) > now) return;
    if (spawnBuilding[i] >= 0 && claimed.has(spawnBuilding[i])) return;
    const id = uid('l');
    loot.set(id, { id, x: sp.x, z: sp.z, item: { ...worldSupply(i, sp.zone), id: uid('i') }, spawnIndex: i });
    lootAtSpawn.set(i, id);
  });
}
/** Pick up one thing lying in the world (Use, a tap on the nearby list, or walking over it). */
function takeLoot(p, l, quiet = false) {
  const wasHot = hasHot(p);
  if (!addToPack(p, l.item)) return quiet ? null : toast(p, 'Backpack full');
  loot.delete(l.id);
  if (l.spawnIndex != null) { lootAtSpawn.delete(l.spawnIndex); spawnReadyAt.set(l.spawnIndex, Date.now() + LOOT_RESPAWN_MS); }
  if (l.site) siteLooted(p, l);
  if (l.item.hot && !wasHot) { p.hotPingAt = Date.now(); toast(p, `🔥 ${l.item.name}: hot loot. Everyone sees where you are every ${Math.round(HZ_CACHE_PING_MS / 1000)}s (every ${Math.round(HZ_PING_MS / 1000)}s with crate loot) until you get it home or fly it out.`); }
  award(p, XP.pickup, l.item.name);
  dirty(p);
}
function addToPack(p, item) {
  if (RESOURCES.includes(item.kind)) { p[item.kind] += item.amount || 10; return true; }
  if (p.inv.pack.length >= PACK_SIZE) return false;
  p.inv.pack.push(item);
  return true;
}

// ---------------------------------------------------------------- contracts
function nearestBy(list, x, z, minD, maxD) {
  const inRange = list.filter((o) => { const d = Math.hypot(o.x - x, o.z - z); return d >= minD && d <= maxD; });
  if (inRange.length) return inRange[Math.floor(Math.random() * inRange.length)];
  return list.reduce((a, o) => (!a || Math.hypot(o.x - x, o.z - z) < Math.hypot(a.x - x, a.z - z) ? o : a), null);
}
function makeContract(type, contact) {
  const c = { id: uid('c'), type, contactId: contact.id, expires: Date.now() + CONTRACT_MS };
  if (type === 'heist') { const t = nearestBy(map.terminals, contact.x, contact.z, 250, 1000); Object.assign(c, { x: t.x, z: t.z, terminalId: t.id }); }
  else if (type === 'recovery') {
    // Placed beside (not on) a loot spot so the two don't overlap.
    const s = nearestBy(map.lootSpawns.filter((l) => l.zone !== 'town'), contact.x, contact.z, 300, 1100);
    const spot = resolveCircle(s.x + 2.5, s.z, 0.8, solidsNear(s.x + 2.5, s.z, 3), terrain.height(s.x + 2.5, s.z));
    Object.assign(c, { x: spot.x, z: spot.z });
  }
  else { const s = nearestBy(map.campSites, contact.x, contact.z, 250, 1200); Object.assign(c, { x: s.x, z: s.z }); }
  return c;
}
function contactOffers(p, contactId) {
  p.offers ??= {};
  if (!p.offers[contactId]) {
    const contact = map.contacts[contactId];
    p.offers[contactId] = Object.keys(CONTRACT_TYPES).sort(() => Math.random() - 0.5).slice(0, 3).map((t) => makeContract(t, contact));
  }
  return p.offers[contactId];
}
/** Spawn whatever a contract needs in the world (also used to restore them after a restart/login). */
function instantiateContract(p, c) {
  if (c.type === 'camp' && ![...bots.values()].some((b) => b.contractId === c.id)) {
    for (let i = 0; i < 4; i++) spawnBot(c.x + (i % 2 ? 4 : -4), c.z + (i < 2 ? 4 : -4), 'camp', { contractId: c.id, ownerToken: p.token });
  } else if (c.type === 'hvt' && ![...bots.values()].some((b) => b.contractId === c.id)) {
    spawnBot(c.x, c.z, 'hvt', { contractId: c.id, ownerToken: p.token });
    for (let i = 0; i < 2; i++) spawnBot(c.x + (i ? 5 : -5), c.z + 3, 'camp', { contractId: `${c.id}-escort`, ownerToken: p.token });
  } else if (c.type === 'recovery' && ![...objectives.values()].some((o) => o.contractId === c.id)
    && !p.inv.pack.some((i) => i.contractId === c.id) && !db.bags.some((b) => b.items.some((i) => i.contractId === c.id))) {
    const id = uid('o');
    objectives.set(id, { id, x: c.x, z: c.z, contractId: c.id, owner: p.token });
  }
}
function cleanupContract(c) {
  for (const b of bots.values()) if (b.contractId === c.id || b.contractId === `${c.id}-escort`) bots.delete(b.id);
  for (const o of objectives.values()) if (o.contractId === c.id) objectives.delete(o.id);
}
function pushContracts(p) {
  send(p.ws, { t: 'contracts', list: p.contracts.map((c) => ({ id: c.id, type: c.type, x: c.x, z: c.z, expires: c.expires, contactId: c.contactId })) });
}
function acceptContract(p, msg) {
  const contact = nth(map.contacts, msg.contactId);
  if (!contact || Math.hypot(contact.x - p.x, contact.z - p.z) > 6) return;
  const offers = contactOffers(p, contact.id);
  const idx = offers.findIndex((o) => o.id === msg.id);
  if (idx < 0) return;
  if (p.contracts.length >= MAX_CONTRACTS) return toast(p, `You can run ${MAX_CONTRACTS} contracts at once`);
  const c = offers.splice(idx, 1)[0];
  offers.push(makeContract(Object.keys(CONTRACT_TYPES)[Math.floor(Math.random() * 4)], contact));
  c.expires = Date.now() + CONTRACT_MS;
  p.contracts.push(c);
  instantiateContract(p, c);
  toast(p, `Contract accepted: ${CONTRACT_TYPES[c.type].name} — marked on your map`);
  pushContracts(p);
  send(p.ws, contactView(p, contact.id));
  dirty(p);
}
/** Rewards are fixed and land in your pack — the salvage still has to get home. */
/**
 * Crew contracts: everyone in the crew who took part (up, and near the finisher or the objective)
 * gets the full XP and commendations, and the resources are split between them.
 */
function completeContract(p, c) {
  const def = CONTRACT_TYPES[c.type];
  p.contracts = p.contracts.filter((x) => x.id !== c.id);
  cleanupContract(c);
  const R = ACTIVITIES.contracts.crewShareRange;
  const near = (m, o) => o && Number.isFinite(o.x) && Math.hypot(m.x - o.x, m.z - o.z) <= R;
  const team = squadMembersOnline(p).filter((m) => m === p || (!m.dead && !m.downed && (near(m, p) || near(m, c))));
  const { comms = 0, ...res } = def.reward;
  const share = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Math.ceil(v / team.length)]));
  const names = team.map((m) => m.name);
  for (const m of team) {
    for (const [k, v] of Object.entries(share)) m[k] = (m[k] || 0) + v;
    m.comms += comms;
    award(m, def.xp, `Contract: ${def.name}`);
    send(m.ws, { t: 'contractDone', name: def.name, reward: { ...share, ...(comms ? { comms } : {}) }, crew: team.length > 1 ? names : null, by: p.name });
    dirty(m);
  }
  if (team.length > 1) feed(`${squadOf(p)?.name || p.name} completed ${def.name}`);
  pushContracts(p);
}
function abandonContract(p, id) {
  const c = p.contracts.find((x) => x.id === id);
  if (!c) return;
  p.contracts = p.contracts.filter((x) => x !== c);
  cleanupContract(c);
  p.inv.pack = p.inv.pack.filter((i) => i.contractId !== c.id);
  pushContracts(p);
  dirty(p);
}
function contactView(p, contactId) {
  refreshHauls(Date.now());
  const ct = map.contacts[contactId];
  return { t: 'contact', id: contactId, name: ct.name, offers: contactOffers(p, contactId), active: p.contracts.map((c) => c.id), comms: p.comms, trade: tradeView(contactId),
    hauls: (hauls.get(contactId) || []).map((h) => ({ id: h.id, label: h.label, toTown: h.toTown, pay: h.pay, km: +(Math.hypot(map.contacts[h.to].x - ct.x, map.contacts[h.to].z - ct.z) / 1000).toFixed(1) })),
    board: marketBoard(ct.x, ct.z), fair: !!inFair(ct.x, ct.z) };
}
function requisition(p, msg) {
  const contact = nth(map.contacts, msg.contactId);
  if (!contact || Math.hypot(contact.x - p.x, contact.z - p.z) > 6) return;
  const table = own({ part: PARTS, paint: PAINTS, armor: ARMORS, perk: FIELD_PERKS }, msg.kind);
  const def = table && own(table, msg.id);
  if (!def?.field) return;
  if (hasField(p, msg.id)) return toast(p, 'Already requisitioned');
  if (level(p) < (def.level || 1)) return toast(p, `Requires level ${def.level}`);
  if (p.comms < def.field) return toast(p, `Needs ${def.field} commendations — earned from contracts and supply drops`);
  p.comms -= def.field;
  p.field.push(msg.id);
  toast(p, `Requisitioned ${def.name}`);
  send(p.ws, contactView(p, contact.id));
  dirty(p);
}

// ---------------------------------------------------------------- supply drops (world events)
function dropList() { return [...drops.values()].map((d) => ({ id: d.id, x: d.x, z: d.z, landsAt: d.landsAt })); }
function scheduleDrop(now) {
  if (now < nextDropAt || !players.size) return;
  nextDropAt = now + SUPPLY_EVERY_MS;
  const spots = map.lootSpawns.filter((l) => l.zone !== 'town');
  const sp = spots[Math.floor(Math.random() * spots.length)];
  const id = uid('d');
  drops.set(id, { id, x: sp.x + 1.5, z: sp.z + 1.5, landsAt: now + SUPPLY_FALL_MS, expires: now + SUPPLY_FALL_MS + 15 * 60_000 });
  sendEvents({ announce: true });
}

// ---------------------------------------------------------------- building (DayZ-style)
const harvested = new Map();   // world box id -> { uses, regrowAt }
const charges = new Map();     // id -> { id, x, z, y, detAt, owner, ownerName }
const buildWorld = {
  terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones,
  solidsNear: (x, z, r) => { const out = solidsNear(x, z, r); for (const s of structsNear(x, z, r)) if (!structIsSolid(s) && !PIECES[s.type].explosive) out.push(structBox(s)); return out; },
};
function payCarried(p, cost) {
  for (const [k, v] of Object.entries(cost)) if ((p[k] || 0) < v) return false;
  for (const [k, v] of Object.entries(cost)) p[k] -= v;
  return true;
}
const costText = (c) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');

/** Your hideouts (a crewmate's count for the crew), oldest first. */
const hideoutsOf = (p) => [...structs.values()].filter((st) => PIECES[st.type].hideout && canManage(p, st) && !st.ruined).sort((a, b) => (a.builtAt || 0) - (b.builtAt || 0));
/** How many hideouts your level allows, and the level the next one unlocks at. */
function hideoutAllowance(p) {
  const lv = level(p), steps = BUILD.hideoutLevels;
  return { allowed: steps.filter((l) => lv >= l).length, next: steps.find((l) => lv < l) || null };
}
function handleBuild(p, msg) {
  p.slow = null;
  const def = own(PIECES, msg.piece);
  if (!def) return;
  const x = Number(msg.x), z = Number(msg.z), rot = msg.rot ? 1 : 0;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  if (def.explosive) {
    const idx = p.inv.pack.findIndex((i) => i.kind === 'charge');
    if (idx < 0) return toast(p, 'You need a breach charge — craft one at your stash (level 7)');
    if (Math.hypot(x - p.x, z - p.z) > 3) return toast(p, 'Too far away');
    const nearStruct = structsNear(x, z, 3).some((s2) => boxDist(structBox(s2), x, z) < 1.6);
    const nearDoor = map.houses.some((h) => boxDist(h.door, x, z) < 1.6);
    if (!nearStruct && !nearDoor) return toast(p, 'Place it against a wall, gate or stash house door');
    p.inv.pack.splice(idx, 1);
    const id = uid('x');
    charges.set(id, { id, x, z, y: terrain.height(x, z), detAt: Date.now() + BUILD.charge.fuseMs, owner: p.token, ownerName: p.name });
    toast(p, 'Charge armed — 8 seconds. Get clear!');
    dirty(p);
    return;
  }
  if (!hasTool(p, 'hammer')) return toast(p, 'You need a hammer to build');
  const myClaim = claimOf(p);
  if (def.claim) {
    if (myClaim) return toast(p, squadOf(p) ? 'Your crew already has a stash house' : 'You already have a stash house. Abandon it before planting a claim flag.');
    if (!hasMarker(p)) return toast(p, 'A claim flag needs a claim marker');
  }
  if (def.hideout) {
    if (!myClaim) return toast(p, 'Set up your stash house first; hideouts are extra stashes on top of it');
    const mineHideouts = [...structs.values()].filter((o) => o.owner === p.token && PIECES[o.type].hideout).length;
    const { allowed, next } = hideoutAllowance(p);
    if (mineHideouts >= allowed) return toast(p, next ? `${allowed ? 'Your next hideout' : 'Hideouts'} unlock${allowed ? 's' : ''} at level ${next}` : `You have all ${allowed} hideouts`);
  }
  const cap = homePerks(myClaim ? homeLevel(myClaim.store.hxp) : 1).buildCap;
  const mine = [...structs.values()].filter((o) => o.owner === p.token).length;
  if (mine >= cap) return toast(p, `Build limit reached (${cap}) — level up your home for more`);
  const problem = placementProblem(buildWorld, msg.piece, x, z, rot, p);
  if (problem) return toast(p, problem);
  const stage0 = def.stages[0];
  if (!payCarried(p, stage0.cost)) return toast(p, `Needs ${costText(stage0.cost)} (carried)`);
  const b = pieceBox(msg.piece, x, z, rot);
  const y0 = Math.min(...[[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]].map(([a, c]) => terrain.height(a, c))) - 0.15;
  const st = { id: 's' + crypto.randomBytes(5).toString('hex'), type: msg.piece, x, z, rot, y0, stage: 0, hp: stage0.hp, owner: p.token, ownerName: p.name, open: false, builtAt: Date.now() };
  if (def.hideout) toast(p, 'Hideout built: stash goods here, come back here after a death, and fast travel here from home. It has no raid protection out here.');
  if (def.container) Object.assign(st, { items: [], ...Object.fromEntries(RESOURCES.map((r) => [r, 0])) });
  if (def.claim) {
    takeMarker(p);
    Object.assign(st, { hxp: 0, crew: squadOf(p)?.id || null, upg: { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0 } });
    st.hp = flagMax(st);
    feed(`${p.name} planted a claim flag`);
    send(p.ws, { t: 'claimed' });
  }
  db.structures.push(st);
  indexStruct(st, true);
  award(p, 10, `Built ${stage0.name}`);
  homeBuildXp(p, st, `Built ${stage0.name}`);
  dirty(p);
}

/** Building inside your claim radius levels your home. */
function homeBuildXp(p, st, reason) {
  const c = claimOf(p);
  if (!c || PIECES[st.type].claim) return;
  if (Math.hypot(st.x - c.x, st.z - c.z) <= homePerks(homeLevel(c.store.hxp)).radius) addHomeXp(c, HOME_XP.build, reason);
}
function damageStruct(st, dmg, by) {
  if (!structs.has(st.id) || st.ruined || st.broken) return;
  dmg *= raidMul(baseOf(st), by);
  if (dmg <= 0) return;
  st.hp -= dmg;
  if (PIECES[st.type].defense === 'mine' && st.hp <= 0) return mineBlast(st, null);
  const owner = onlineByToken(st.owner);
  if (by !== owner && st.owner !== by?.token && (!st.alertedAt || Date.now() - st.alertedAt > 20_000)) {
    st.alertedAt = Date.now();
    if (owner) toast(owner, `⚠ Your ${stageDef(st).name.toLowerCase()} is under attack${by ? ` by ${by.name}` : ''}!`);
    else for (const tok of teamTokensOf(st.owner)) if (!onlineByToken(tok)) pushTo(tok, `Your ${stageDef(st).name.toLowerCase()} is under attack${by ? ` by ${by.name}` : ''}!`);
  }
  if (st.hp > 0) return;
  const who = by ? by.name : 'Someone';
  if (PIECES[st.type].claim) {
    // A home isn't wiped out: it becomes a ruin its owner can rebuild (level and upgrades kept).
    st.ruined = true; st.hp = 0;
    feed(`${who} broke ${storeOwnerLabel(st)}'s ${stageDef(st).name.toLowerCase()}: it's a ruin`);
    notifyStore(st, '⚠ Your stash house was broken into a ruin. Its level and upgrades are safe: rebuild it with a hammer.');
    logAway(st.owner, `${who} broke your stash house into a ruin. Rebuild it from the stash with a hammer (${costText(RAIDS.ruin.rebuildCost)}).`);
    refreshContainerViewers('crate', st.id);
  } else if (st.claimOf) {
    // A claimed building's door breaks open, and its owner can put it back.
    st.broken = true; st.hp = 0; st.open = true;
    const home = structs.get(st.claimOf);
    if (home) { notifyStore(home, `⚠ ${who} broke down a door of your stash house`); logAway(home.owner, `${who} broke down a door of your stash house`); }
  } else removeStruct(st, true);
  if (by && !by.isBot && st.owner !== by.token) award(by, PIECES[st.type].claim ? 250 : 40, `Destroyed ${stageDef(st).name.toLowerCase()}`, true);
}
function removeStruct(st, destroyed) {
  indexStruct(st, false);
  db.structures = db.structures.filter((o) => o !== st);
  // A claimed building's doors go with its stash locker.
  if (PIECES[st.type].claim && st.building != null) for (const d of [...structs.values()]) if (d.claimOf === st.id) removeStruct(d, false);
  if (PIECES[st.type].stall && ((st.listings || []).length || st.till)) {
    // A wrecked (or packed-up) stall spills what was on it: the goods and the till.
    const goods = { cash: Number.isFinite(st.till) ? st.till : 0 };
    for (const l of st.listings || []) goods[l.res] = (goods[l.res] || 0) + l.qty;
    dropBag(st.x, st.z, [], goods, destroyed ? `Wreck of ${st.ownerName}'s stall` : 'Stall goods');
    if (destroyed) logAway(st.owner, 'Your market stall was wrecked; its goods and till spilled on the ground');
  }
  if (PIECES[st.type].container) {
    dropBag(st.x, st.z, st.items, st, destroyed ? 'Wrecked crate' : 'Crate contents');
    for (const p of players.values()) if (p.openContainer?.kind === 'crate' && p.openContainer.id === st.id) { p.openContainer = null; send(p.ws, { t: 'container', closed: true }); }
  }
}
function dismantle(p, msg) {
  const st = structs.get(msg.id);
  if (!st || !canManage(p, st) || boxDist(structBox(st), p.x, p.z) > 4) return;
  if (!hasTool(p, 'hammer') && !PIECES[st.type].explosive) return toast(p, 'You need a hammer to dismantle');
  const refund = investedCost(st.type, st.stage);
  for (const [k, v] of Object.entries(refund)) p[k] += Math.floor(v / 2);
  removeStruct(st, false);
  toast(p, `Dismantled — refunded ${costText(Object.fromEntries(Object.entries(refund).map(([k, v]) => [k, Math.floor(v / 2)])))}`);
  dirty(p);
}

function explode(c, now, k = BUILD.charge) {
  charges.delete(c.id);
  const by = onlineByToken(c.owner);
  const msg = JSON.stringify({ t: 'boom', x: c.x, y: c.y + 0.5, z: c.z, r: k.playerRadius || 6 });
  for (const p of players.values()) if (p.ws.readyState === 1 && Math.abs(p.x - c.x) < INTEREST && Math.abs(p.z - c.z) < INTEREST) p.ws.send(msg);
  if (k.radius) for (const st of structsNear(c.x, c.z, k.radius + 3)) {
    if (st.id === c.id) continue;
    const d = boxDist(structBox(st), c.x, c.z);
    if (d <= k.radius) damageStruct(st, k.damage * (1 - d / (k.radius * 1.5)), by);
  }
  if (k.radius) for (const h of map.houses) {
    const d = boxDist(h.door, c.x, c.z);
    if (d > k.radius) continue;
    damageHouseDoor(h.id, k.damage * (1 - d / (k.radius * 1.5)), by || { name: c.ownerName, isBot: true }, 'blew open');
  }
  for (const t of [...players.values(), ...bots.values()]) {
    if (t.dead) continue;
    const d = Math.hypot(t.x - c.x, t.z - c.z);
    if (d < k.playerRadius) applyDamage(t, k.playerDamage * (1 - d / k.playerRadius), by, !!t.isBot);
  }
  // Cars, bikes and boats caught in the blast: most of a rocket's punch.
  if (k.playerRadius) for (const b of [...db.boats]) {
    const d = Math.hypot(b.x - c.x, b.z - c.z) - BOATS[b.type].len / 3;
    if (d < k.playerRadius) damageBoat(b, Math.max(k.playerDamage, (k.damage || 0) * 0.5) * 1.5 * (1 - Math.max(0, d) / k.playerRadius), by);
  }
}

function craft(p, msg) {
  const def = own(CRAFTS, msg.item);
  if (!def) return;
  const store = craftStore(p);
  if (!store) return toast(p, 'Craft at your stash house or one of your crates');
  if (level(p) < def.level) return toast(p, `${def.name} needs level ${def.level}`);
  if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
  if (!spend(p, def.cost, store)) return toast(p, `Needs ${costText(def.cost)}`);
  p.inv.pack.push(msg.item === 'charge' ? { id: uid('c'), kind: 'charge', name: 'Breach Charge' } : msg.item === 'marker' ? makeMarker() : makeTool(msg.item));
  toast(p, `Crafted ${def.name}`);
  dirty(p);
  if (p.openContainer) refreshContainerViewers(p.openContainer.kind, p.openContainer.id);
}
function craftStore(p) {
  if (atOwnStash(p)) return claimOf(p).store;
  const oc = p.openContainer;
  if (oc?.kind === 'crate') { const st = structs.get(oc.id); if (st && st.owner === p.token && nearContainer(p, 'crate', st.id)) return st; }
  return null;
}

// ---------------------------------------------------------------- interaction
function nearestInteractable(p) {
  let best = null, bestD = INTERACT_RANGE;
  const consider = (d, obj) => { if (d < bestD) { bestD = d; best = obj; } };
  for (const l of loot.values()) if (Math.abs(l.x - p.x) < 4 && Math.abs(l.z - p.z) < 4) consider(Math.hypot(l.x - p.x, l.z - p.z), { kind: 'loot', ref: l });
  for (const bag of db.bags) if (Math.abs(bag.x - p.x) < 4 && Math.abs(bag.z - p.z) < 4) consider(Math.hypot(bag.x - p.x, bag.z - p.z), { kind: 'bag', ref: bag });
  for (const h of map.houses) {
    if (Math.abs(h.x - p.x) > 12 || Math.abs(h.z - p.z) > 12) continue;
    consider(Math.hypot(h.crate.x - p.x, h.crate.z - p.z) - 0.3, { kind: 'stash', ref: h });
    const d = h.door;
    consider(Math.hypot((d.minX + d.maxX) / 2 - p.x, (d.minZ + d.maxZ) / 2 - p.z), { kind: 'door', ref: h });
  }
  for (const t of map.terminals) if (Math.abs(t.x - p.x) < 4 && Math.abs(t.z - p.z) < 4) consider(Math.hypot(t.x - p.x, t.z - p.z), { kind: 'terminal', ref: t });
  for (const c of map.contacts) if (Math.abs(c.x - p.x) < 5 && Math.abs(c.z - p.z) < 5) consider(Math.hypot(c.x - p.x, c.z - p.z) - 0.8, { kind: 'contact', ref: c });
  for (const d of drops.values()) consider(Math.hypot(d.x - p.x, d.z - p.z) - 0.6, { kind: 'drop', ref: d });
  if (hotZone?.open) for (const c of hotZone.crates) if (!c.opened) consider(Math.hypot(c.x - p.x, c.z - p.z) - 0.6, { kind: 'hotcrate', ref: c });
  for (const o of objectives.values()) if (o.owner === p.token) consider(Math.hypot(o.x - p.x, o.z - p.z) - 0.5, { kind: 'crate', ref: o });
  for (const st of structsNear(p.x, p.z, 4)) if (!PIECES[st.type].explosive) consider(boxDist(structBox(st), p.x, p.z) + 0.3, { kind: 'struct', ref: st });
  if (!best) {
    // Trees and rocks you can gather from (only when nothing else is in reach).
    for (const b of grid.near(p.x, p.z, 2.5)) {
      const res = b.type === 'tree' || b.type === 'pine' ? 'wood' : b.type === 'rock' || b.type === 'boulder' ? 'stone' : null;
      if (res) consider(boxDist(b, p.x, p.z) + 0.6, { kind: 'harvest', ref: b, res });
    }
  }
  if (best) best.d = bestD;
  return best;
}
function containerView(p, kind, id) {
  if (kind === 'boat') {
    const b = boatById(id);
    if (!b) return { t: 'container', closed: true };
    return { t: 'container', kind, id, title: `${b.owner === p.token ? `Your ${BOATS[b.type].name.toLowerCase()}` : boatName(b)}: the hold`, items: b.items, ...Object.fromEntries(RESOURCES.map((r) => [r, b[r] || 0])), canPut: canUseBoat(p, b), cap: BOATS[b.type].hold };
  }
  if (kind === 'stash') {
    const h = db.houses[id];
    const ours = claimOf(p);
    const mine = ours?.kind === 'home' && ours.id === id;
    const squad = !mine && !!h.owner && tokenInSquadWith(p, h.owner);
    const title = mine ? (h.crew ? `${storeOwnerLabel(h)} crew stash` : 'Your stash') : `${storeOwnerLabel(h) || 'Unclaimed'}'s stash${squad ? ' (crew)' : ''}`;
    return { t: 'container', kind, id, title, items: h.items, ...Object.fromEntries(RESOURCES.map((r) => [r, h[r] || 0])), ammo: 0, canPut: mine || squad, cap: stashCap(id), raid: raidView(p, 'stash', h), gunsmith: mine, bank: mine, craft: mine, upg: mine ? h.upg : null, home: mine ? claimSummary(p) : null };
  }
  if (kind === 'crate') {
    const st = structs.get(id);
    if (!st) return { t: 'container', closed: true };
    const mine = canManage(p, st);
    const own = claimOf(p)?.store === st, flag = !!PIECES[st.type].claim;
    const cap = flag ? claimCap({ kind: 'flag', store: st }) : stageDef(st).slots;
    return { t: 'container', kind, id, title: flag ? (own ? (st.crew ? `${storeOwnerLabel(st)} crew stash` : `Your ${stageDef(st).name.toLowerCase()} (stash)`) : `${storeOwnerLabel(st)}'s ${stageDef(st).name.toLowerCase()}`) : `${st.ownerName}'s ${stageDef(st).name.toLowerCase()}${mine ? '' : ' (not yours)'}`, items: st.items, ...Object.fromEntries(RESOURCES.map((r) => [r, st[r] || 0])), canPut: mine, cap, craft: own, upgradable: mine && !!PIECES[st.type].stages[st.stage + 1],
      gunsmith: flag && own, bank: flag && own, upg: flag && own ? st.upg : null, home: flag && own ? claimSummary(p) : null,
      raid: raidView(p, 'crate', st), ruin: st.ruined && mine ? { cost: RAIDS.ruin.rebuildCost } : null };
  }
  const bag = db.bags.find((b) => b.id === id);
  return bag ? { t: 'container', kind, id, title: bag.label, items: bag.items, ...Object.fromEntries(RESOURCES.map((r) => [r, bag[r] || 0])), canPut: false, cap: 0 } : { t: 'container', closed: true };
}
function nearContainer(p, kind, id) {
  if (kind === 'boat') { const b = boatById(id); return !!b && canUseBoat(p, b) && (p.boat === id || Math.hypot(b.x - p.x, b.z - p.z) < RV.rules.boardRange + 1.5); }
  if (kind === 'stash') { const h = map.houses[id]; return h && Math.hypot(h.crate.x - p.x, h.crate.z - p.z) < INTERACT_RANGE + 0.6; }
  if (kind === 'crate') { const st = structs.get(id); return st && boxDist(structBox(st), p.x, p.z) < INTERACT_RANGE + 0.6; }
  if (kind === 'stash' && !map.houses[id]) return false;
  const bag = db.bags.find((b) => b.id === id);
  return bag && Math.hypot(bag.x - p.x, bag.z - p.z) < INTERACT_RANGE + 0.6;
}
function refreshContainerViewers(kind, id) {
  for (const p of players.values()) if (p.openContainer?.kind === kind && p.openContainer.id === id) send(p.ws, containerView(p, kind, id));
}

function interact(p) {
  p.slow = null;   // their next snapshot shows the result straight away
  if (p.hack) return cancelHack(p, 'Cancelled');
  if (p.boat) return leaveBoat(p);
  // A downed crewmate within reach comes first.
  for (const m of squadMembersOnline(p)) {
    if (m !== p && m.downed && !m.dead && Math.hypot(m.x - p.x, m.z - p.z) <= DOWNED.reviveRange) return startHack(p, 'revive', m.id);
  }
  // Friendly NPCs trade.
  // (Unless something else is closer: a crate at a farmer's feet still gets picked up.)
  const npc = friendlyNpcNear(p);
  if (npc) {
    const near = nearestInteractable(p);
    if (!near || Math.hypot(npc.x - p.x, npc.z - p.z) < near.d) return send(p.ws, npcView(p, npc));
  }
  // Boats and landing posts.
  const rv = riverInteractable(p);
  if (rv) {
    const near = nearestInteractable(p);
    if (!near || rv.d < near.d) return rv.run();
  }
  // Then an enemy at arm's length: data-hack them if they're stunned or down, take them down from behind.
  const foe = enemyAtReach(p, DATAHACK.range);
  if (foe) {
    if ((isStunned(foe) || foe.downed) && pvpAllowed(p, foe)) return startHack(p, 'datahack', foe.id);
    if (Math.hypot(foe.x - p.x, foe.z - p.z) <= TAKEDOWN.range && behind(p, foe)) return takedown(p, foe);
  }
  const it = nearestInteractable(p);
  // Nothing else here: at a landing zone, E calls the extraction helicopter.
  if (!it && hotZone?.open && hotZone.extract && Math.hypot(hotZone.extract.x - p.x, hotZone.extract.z - p.z) < EXTRACT.callRange) return callExtraction(p);
  if (!it) {
    if (taxiAt(p) && !map.contacts.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 8)) return taxiMenu(p);
    const b = buildingAt(p.x, p.z);
    if (b >= 0 && standing(p) < map.buildings[b].top - 1) return startClaimBuilding(p, b);   // (inside it, not up on the roof)
    if (nearWater(p.x, p.z)) {
      if (!hasTool(p, 'rod')) return toast(p, 'You need a fishing rod (trading posts sell them; craft one at your stash)');
      return startHack(p, 'fish', 0);
    }
    return;
  }
  if (it.kind === 'terminal') return startHack(p, 'terminal', it.ref.id);
  if (it.kind === 'drop') return startHack(p, 'drop', it.ref.id);
  if (it.kind === 'hotcrate') {
    if ((hotZone.opened.get(p.token) || 0) >= HZ.cratesPerPlayer) return toast(p, `You've opened ${HZ.cratesPerPlayer} crates in this zone: leave the rest for someone else`);
    if (p.inv.pack.length + 3 > PACK_SIZE) return toast(p, 'Make room in your backpack first (a crate holds up to 3 things)');
    startHack(p, 'hotcrate', it.ref.id, { ms: HZ_CRATE_MS });
    // The alarm: everyone near the zone sees where the crate is being opened.
    for (const o of players.values()) if (o !== p && !o.dead && !sameSquad(o, p) && Math.hypot(o.x - it.ref.x, o.z - it.ref.z) < HZ.alarmRange) send(o.ws, { t: 'alert', x: Math.round(it.ref.x), z: Math.round(it.ref.z), text: 'Hot crate alarm' });
    return toast(p, `🔥 Opening the crate (${Math.round(HZ_CRATE_MS / 1000)}s) — the alarm is going: everyone near the zone knows where you are`);
  }
  if (it.kind === 'crate') return startHack(p, 'crate', it.ref.id);
  if (it.kind === 'harvest') {
    const tool = it.res === 'wood' ? 'hatchet' : 'pickaxe';
    // No tool for the tree or rock, but a rod at the water's edge: fish instead.
    if (!hasTool(p, tool) && hasTool(p, 'rod') && nearWater(p.x, p.z)) return startHack(p, 'fish', 0);
    if (!hasTool(p, tool)) return toast(p, `You need a ${tool} to gather ${it.res}`);
    const hv = harvested.get(it.ref.id);
    if (hv && hv.uses >= BUILD.harvest.uses && hv.regrowAt > Date.now()) return toast(p, 'Nothing left here — it regrows in a while');
    return startHack(p, 'harvest', it.ref.id, { res: it.res, box: it.ref });
  }
  if (it.kind === 'struct') return structInteract(p, it.ref);
  if (it.kind === 'contact') {
    // Deliver any recovered crates first, then open the contact board.
    for (const pkg of p.inv.pack.filter((i) => i.kind === 'package')) {
      const c = p.contracts.find((x) => x.id === pkg.contractId);
      if (!c) continue;
      p.inv.pack = p.inv.pack.filter((i) => i !== pkg);
      completeContract(p, c);
    }
    deliverCargo(p, it.ref.id);
    return send(p.ws, contactView(p, it.ref.id));
  }
  if (it.kind === 'loot') {
    takeLoot(p, it.ref);
  } else if (it.kind === 'stash' && !db.houses[it.ref.id].owner) {
    return startClaim(p, it.ref.id);
  } else if (it.kind === 'stash' && map.houses[it.ref.id].kind === 'vehicle' && !tokenInSquadWith(p, db.houses[it.ref.id].owner)) {
    // Vehicles are locked: the stash inside is only reachable once the lock is broken or hacked.
    const h = db.houses[it.ref.id];
    if (h.doorHp > 0 && !h.doorOpen) return toast(p, `${h.ownerName}'s ${VEHICLE_TYPES[map.houses[it.ref.id].vtype].name.toLowerCase()} is locked — break the door, hack it, or blow it`);
    p.openContainer = { kind: 'stash', id: it.ref.id };
    send(p.ws, containerView(p, 'stash', it.ref.id));
  } else if (it.kind === 'bag' || it.kind === 'stash') {
    p.openContainer = { kind: it.kind, id: it.ref.id };
    send(p.ws, containerView(p, it.kind, it.ref.id));
  } else if (it.kind === 'door') {
    const h = db.houses[it.ref.id];
    if (!h.owner) return startClaim(p, it.ref.id);
    const allowed = h.owner === p.token || (h.owner && tokenInSquadWith(p, h.owner));
    if (!allowed) {
      if (h.doorHp > 0 && !h.doorOpen) return startHack(p, 'door', it.ref.id);
      return toast(p, 'Not your door');
    }
    if (h.doorHp <= 0) {
      if (Date.now() - (p.lastRepair || 0) < 1500) return;
      p.lastRepair = Date.now();
      h.rebuild = (h.rebuild || 0) + 1;
      if (h.rebuild >= 4) { h.rebuild = 0; h.doorHp = doorMax(it.ref.id) * 0.25; h.doorOpen = false; toast(p, 'Door rebuilt (25%) — it repairs itself while undamaged'); }
      else toast(p, `Rebuilding door… ${h.rebuild}/4`);
    } else {
      if (h.doorOpen) {
        const d = map.houses[it.ref.id].door;
        const blocked = [...players.values(), ...bots.values()].some((c) => !c.dead && Math.abs(c.x - (d.minX + d.maxX) / 2) < 1.4 && Math.abs(c.z - (d.minZ + d.maxZ) / 2) < 0.8);
        if (blocked) return toast(p, 'Doorway blocked');
      }
      h.doorOpen = !h.doorOpen;
    }
  }
}

function structInteract(p, st) {
  const def = PIECES[st.type];
  const stage = stageDef(st);
  if (def.farm && !msg_upgradeIntent(p)) return farmInteract(p, st);
  if (def.stall && !msg_upgradeIntent(p)) return send(p.ws, stallView(p, st));
  if (def.defense && canManage(p, st) && !msg_upgradeIntent(p)) return defenseInteract(p, st);
  if (def.cook && !msg_upgradeIntent(p) && (canManage(p, st) || !p.buildIntent)) return cookInteract(p, st);
  if (canManage(p, st)) {
    if (st.broken) return startHack(p, 'rebuild', st.id);
    if (def.container && st.stage >= 0 && !(msg_upgradeIntent(p))) {
      p.openContainer = { kind: 'crate', id: st.id };
      return send(p.ws, containerView(p, 'crate', st.id));
    }
    if (def.door && stage.material !== 'frame' && !msg_upgradeIntent(p)) {
      if (st.open && [...players.values(), ...bots.values()].some((c) => !c.dead && boxDist(structBox(st), c.x, c.z) < 0.5)) return toast(p, 'Gateway blocked');
      st.open = !st.open;
      return;
    }
    const next = def.stages[st.stage + 1];
    if (!next) return toast(p, `${stage.name} is fully built`);
    if (!hasTool(p, 'hammer')) return toast(p, 'You need a hammer to upgrade');
    for (const [k, v] of Object.entries(next.cost)) if ((p[k] || 0) < v) return toast(p, `${next.name} needs ${costText(next.cost)} (carried)`);
    return startHack(p, 'upgrade', st.id);
  }
  // Someone else's structure.
  if (def.defense === 'mine' || def.defense === 'tripwire') {
    if (raidMul(baseOf(st), p) <= 0) return toast(p, `${st.ownerName}'s base is sealed right now: its defenses can't be touched`);
    if (!p.crouch && !p.prone) return toast(p, `Crouch first: ${def.defense === 'mine' ? 'disarming a mine' : 'cutting a wire'} takes a steady hand`);
    return startHack(p, 'disarm', st.id, { ms: def.defense === 'mine' ? DEF.mine.disarmMs : DEF.tripwire.cutMs });
  }
  if (def.defense === 'alarm' || def.defense === 'sentry') return toast(p, `${st.ownerName}'s ${stage.name.toLowerCase()}: shoot it, jam it with a stun grenade${def.defense === 'alarm' ? ', or slip past it with camo' : ', or wait for it to run dry'}`);
  if (st.broken) return toast(p, `${st.ownerName}'s door is broken down`);
  const lockedFlag = def.claim && st.type === 'flag' && !st.ruined;   // a flag's stash opens only once the flag is broken
  if (lockedFlag && !hasTool(p, 'hatchet') && !hasTool(p, 'pickaxe')) return toast(p, `${storeOwnerLabel(st)}'s claim flag: its stash is locked until the flag is broken (hatchet, pickaxe or breach charge)`);
  if (def.container && !lockedFlag) { p.openContainer = { kind: 'crate', id: st.id }; return send(p.ws, containerView(p, 'crate', st.id)); }
  if (stage.material === 'frame') return toast(p, `${st.ownerName}'s ${stage.name.toLowerCase()}`);
  if (def.door && !st.open && level(p) >= GADGETS.doorHack.level && p.tech >= bypassOf('gate', st.id).tech && !hasTool(p, 'hatchet') && !hasTool(p, 'pickaxe')) return startHack(p, 'gatehack', st.id);
  const tool = stage.material === 'stone' ? 'pickaxe' : hasTool(p, 'hatchet') ? 'hatchet' : hasTool(p, 'pickaxe') ? 'pickaxe' : null;
  if (!tool || !hasTool(p, tool)) return toast(p, stage.material === 'stone' ? 'Stone — break it with a pickaxe or a breach charge' : 'Chop it down with a hatchet, or use a breach charge');
  return startHack(p, 'raid', st.id, { tool });
}
// In build mode, interacting with your own crate/gate upgrades it instead of opening it.
function msg_upgradeIntent(p) { return !!p.buildIntent; }

function containerAction(p, msg) {
  p.slow = null;
  const { kind, id } = p.openContainer || {};
  if (!kind || !nearContainer(p, kind, id)) { p.openContainer = null; return send(p.ws, { t: 'container', closed: true }); }
  const store = kind === 'stash' ? db.houses[id] : kind === 'crate' ? structs.get(id) : kind === 'boat' ? boatById(id) : db.bags.find((b) => b.id === id);
  if (!store) return;
  if (kind === 'boat' && !canUseBoat(p, store)) return;
  if (msg.action === 'take') {
    const cap = raidCap(p, kind, store);
    if (cap === false) return;
    const full = () => toast(p, `That's all one raid can carry off from here (${Math.round(cap.share * 100)}% of what was in it). The rest is locked in their strongbox for a day.`);
    if (RESOURCES.includes(msg.res)) {
      const n = Math.min(store[msg.res] || 0, cap ? Math.max(0, cap.res[msg.res] || 0) : Infinity);
      if (cap && n <= 0) return full();
      p[msg.res] += n; store[msg.res] = (store[msg.res] || 0) - n;
      if (cap) cap.res[msg.res] -= n;
    } else {
      const idx = store.items.findIndex((i) => i.id === msg.itemId);
      if (idx < 0) return;
      if (store.items[idx].bulk) return toast(p, 'Bulk freight is too heavy to carry. It stays in the hold until you deliver it at the landing.');
      if (cap && cap.items <= 0) return full();
      if (!addToPack(p, store.items[idx])) return toast(p, 'Backpack full');
      store.items.splice(idx, 1);
      if (cap) cap.items--;
    }
    if (cap && store.owner && !cap.logged) { cap.logged = true; logAway(store.owner, `${p.name} took from your ${kind === 'stash' ? 'stash' : stageDef(store).name.toLowerCase()}`); }
  } else if (msg.action === 'put') {
    if (kind === 'bag') return;
    if (kind === 'stash') { const h = db.houses[id]; if (!(h.owner === p.token || (h.owner && tokenInSquadWith(p, h.owner)))) return; }
    if (kind === 'crate' && !canManage(p, store)) return;
    if (RESOURCES.includes(msg.res)) { store[msg.res] = (store[msg.res] || 0) + p[msg.res]; p[msg.res] = 0; dirty(p); return refreshContainerViewers(kind, id); }
    const cap = kind === 'stash' ? stashCap(id) : kind === 'boat' ? BOATS[store.type].hold : stageDef(store).slots;
    if (store.items.length >= (kind === 'crate' && PIECES[store.type].claim ? claimCap({ kind: 'flag', store }) : cap)) return toast(p, kind === 'boat' ? 'The hold is full' : kind === 'stash' ? 'Stash full — upgrade storage or level up your home' : PIECES[store.type]?.hideout ? 'Hideout full — dig it in (E with a hammer) for more room' : 'Crate full — reinforce it for more room');
    const idx = p.inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0 || p.inv.pack[idx].kind === 'package') return;
    store.items.push(p.inv.pack.splice(idx, 1)[0]);
  } else if (msg.action === 'bank') {
    // Intel is the extraction loop: worthless until you get it home, lost if you die on the way.
    if (!atOwnStash(p) || store !== claimOf(p)?.store) return;
    const n = p.intel + (store.intel || 0);
    if (!n) return toast(p, 'No intel to bank');
    p.intel = 0; store.intel = 0;
    award(p, n * XP.intelBanked, `Banked ${n} intel`, true);
    addHomeXp(claimOf(p), n * HOME_XP.intel, `Uploaded ${n} intel`);
    feed(`${p.name} uploaded ${n} intel`);
  }
  if (kind === 'bag' && !store.items.length && !RESOURCES.some((r) => store[r])) db.bags = db.bags.filter((b) => b !== store);
  dirty(p);
  refreshContainerViewers(kind, id);
}

// ---------------------------------------------------------------- stash house: gunsmith + upgrades
function atOwnStash(p) {
  const c = claimOf(p);
  if (!c || p.dead) return false;
  if (c.kind === 'flag') return boxDist(structBox(c.store), p.x, p.z) < INTERACT_RANGE + 0.6;
  return Math.hypot(c.x - p.x, c.z - p.z) < INTERACT_RANGE + 0.6;
}
function findOwnedWeapon(p, itemId) {
  const inv = p.inv;
  for (const slot of GUN_SLOTS) if (inv[slot]?.id === itemId) return inv[slot];
  const inPack = inv.pack.find((i) => i.id === itemId);
  if (inPack) return inPack;
  return claimOf(p)?.store.items.find((i) => i.id === itemId) || null;
}
/** Pay a cost from carried resources first, then the stash/crate you're at. Commendations are personal. */
function spend(p, cost, store = claimOf(p)?.store || {}) {
  const stash = store;
  for (const [k, v] of Object.entries(cost)) {
    const have = k === 'comms' ? p.comms : p[k] + (stash[k] || 0);
    if (have < v) return false;
  }
  for (const [k, v] of Object.entries(cost)) {
    if (k === 'comms') { p.comms -= v; continue; }
    const fromPack = Math.min(p[k], v);
    p[k] -= fromPack;
    stash[k] -= v - fromPack;
  }
  return true;
}
function gunsmithAction(p, msg) {
  const anywhere = DEV_KIT && (msg.action === 'attach' || msg.action === 'paint');   // testing kit: parts and paint anywhere
  if (!atOwnStash(p) && !anywhere) return toast(p, 'The gunsmith bench is at your stash house');
  if (msg.action === 'attach' || msg.action === 'paint') {
    const w = findOwnedWeapon(p, msg.itemId);
    if (!w || w.kind !== 'weapon') return;
    if (msg.action === 'attach') {
      const part = own(PARTS, msg.partId);
      if (!part || !SLOTS.includes(msg.slot) || part.slot !== msg.slot) return;
      if (!partFits(msg.partId, w.archetype)) return toast(p, `${part.name} doesn't fit a ${ARCHETYPES[w.archetype].label}`);
      if (!isUnlocked(part, msg.partId, p)) return toast(p, part.field && level(p) >= part.level ? `${part.name} is field gear — requisition it from a Contact` : `${part.name} unlocks at level ${part.level}`);
      w.parts[msg.slot] = msg.partId;
      const cap = weaponStats(w).mag;
      if ((p.mags[w.id] ?? 0) > cap) { p.ammo += p.mags[w.id] - cap; p.mags[w.id] = cap; }
    } else {
      const paint = own(PAINTS, msg.paint);
      if (!paint) return;
      if (!isUnlocked(paint, msg.paint, p)) return toast(p, paint.field && level(p) >= paint.level ? `${paint.name} is field gear — requisition it from a Contact` : `${paint.name} unlocks at level ${paint.level}`);
      w.paint = msg.paint;
    }
  } else if (msg.action === 'build' || msg.action === 'buildArmor') {
    const isArmor = msg.action === 'buildArmor';
    const def = own(isArmor ? ARMORS : ARCHETYPES, msg.type);
    if (!def) return;
    const label = isArmor ? def.name : def.label;
    if (!isUnlocked(def, msg.type, p)) return toast(p, def.field && level(p) >= def.level ? `${label} is field gear — requisition it from a Contact` : `${label} unlocks at level ${def.level}`);
    const c = claimOf(p);
    const stash = c.store;
    const roomInPack = p.inv.pack.length < PACK_SIZE;
    if (!roomInPack && stash.items.length >= claimCap(c)) return toast(p, 'Backpack and stash are full');
    const cost = Math.round(def.cost * (1 - UPGRADES.workbench.tiers[stash.upg.workbench].discount));
    if (!spend(p, { parts: cost })) return toast(p, `Needs ${cost} parts`);
    const item = isArmor ? makeArmor(msg.type) : makeWeapon(msg.type, {}, 'factory', typeof msg.model === 'string' ? msg.model : undefined);
    if (roomInPack) p.inv.pack.push(item); else stash.items.push(item);
    if (cost > 0) award(p, XP.build, `Built ${item.name}`);   // a free sidearm teaches nothing
    toast(p, `Built ${item.name}${roomInPack ? '' : ' (sent to stash)'}`);
  } else return;
  dirty(p);
  refreshClaim(claimOf(p));
}
function upgradeAction(p, msg) {
  if (!atOwnStash(p)) return toast(p, 'Upgrades are installed at your stash house');
  const track = own(UPGRADES, msg.track);
  if (!track) return;
  const c = claimOf(p);
  const h = c.store;
  const next = track.tiers[h.upg[msg.track] + 1];
  if (!next) return toast(p, 'Already fully upgraded');
  if (homeLevel(h.hxp) < next.home) return toast(p, `Needs home level ${next.home} — level your stash house up first`);
  if (!spend(p, next.cost, h)) return toast(p, `Not enough materials: ${Object.entries(next.cost).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const before = c.kind === 'home' ? doorMax(c.id) : flagMax(h);
  h.upg[msg.track]++;
  if (msg.track === 'door') {
    if (c.kind === 'home' && h.doorHp > 0) h.doorHp += doorMax(c.id) - before;
    if (c.kind === 'flag') h.hp += flagMax(h) - before;
  }
  award(p, 100, `Stash upgrade: ${track.name}`);
  addHomeXp(c, Object.values(next.cost).reduce((a, b) => a + b, 0) * HOME_XP.perMaterial, `Installed ${track.name}`);
  toast(p, `Installed: ${track.name} — ${next.label}`);
  dirty(p);
  refreshClaim(c);
}
function tickHouses(now) {
  const claims = [];
  for (const [idStr, h] of Object.entries(db.houses)) if (h.owner) claims.push({ kind: 'home', id: Number(idStr), store: h, x: map.houses[idStr].x, z: map.houses[idStr].z });
  for (const st of structs.values()) if (PIECES[st.type].claim) claims.push({ kind: 'flag', id: st.id, store: st, x: st.x, z: st.z });
  for (const c of claims) {
    const h = c.store;
    const was = rsCache.get(h)?.mode, rs = raidState(h, now);
    rsCache.set(h, rs);
    if (was && was !== rs.mode && was !== 'home' && rs.mode !== 'home') logAway(h.owner, rs.mode === 'window' ? `Your raid window opened (${windowText(rs.start)}): your base can be raided, at reduced damage, while you're all away` : 'Your raid window closed: your base is sealed again', false);
    if (c.kind === 'home') {
      const max = doorMax(c.id);
      if (h.doorHp > 0 && h.doorHp < max && now - (h.lastDamaged || 0) > 60_000) h.doorHp = Math.min(max, h.doorHp + max * 0.02);
    }
    // Home XP just for holding it.
    h.hxpAcc = (h.hxpAcc || 0) + HOME_XP.perHour / 3600;
    if (h.hxpAcc >= 1) { const n = Math.floor(h.hxpAcc); h.hxpAcc -= n; addHomeXp(c, n, 'Holding your home'); }
    // Generator: produces into the stash (where raiders can take it), even while you're offline.
    const rate = UPGRADES.generator.tiers[h.upg.generator].rate;
    if (rate) {
      h.genAcc = (h.genAcc || 0) + rate / 3600;
      if (h.genAcc >= 1) {
        const n = Math.floor(h.genAcc);
        h.genAcc -= n;
        if (h.parts < 400) h.parts += n;
        h.genTech = (h.genTech || 0) + n / 2;
        if (h.genTech >= 1) { if (h.tech < 200) h.tech += Math.floor(h.genTech); h.genTech %= 1; }
      }
    }
    // Perimeter alarm: tells the owner (anywhere on the map) and exposes the intruder. Camo beats it.
    const radius = UPGRADES.alarm.tiers[h.upg.alarm].radius;
    if (!radius) continue;
    const team = storeTeam(h);
    const owner = team[0];
    if (!owner) continue;
    for (const o of players.values()) {
      if (o.dead || team.some((m) => sameSquad(m, o)) || tokenInSquadWith(o, h.owner) || camoActive(o)) continue;
      if (Math.hypot(o.x - c.x, o.z - c.z) > radius) continue;
      expose(o, squadKey(owner), 5000);
      if (now - (h.lastAlarm || 0) > 20_000) {
        h.lastAlarm = now;
        for (const m of team) { toast(m, `🚨 Perimeter alarm: ${o.name} is at your stash house`); send(m.ws, { t: 'alert', x: c.x, z: c.z, text: 'Perimeter alarm' }); }
      }
    }
  }
}

function invAction(p, msg) {
  const inv = p.inv;
  if (msg.action === 'equip') {
    const idx = inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0) return;
    const item = inv.pack[idx];
    let slot;
    if (item.kind === 'armor') slot = 'armor';
    else if (item.kind === 'weapon') {
      // A main gun goes in the slot you asked for, else an empty one, else replaces the one in your hands.
      if (item.archetype === 'sidearm') slot = 'secondary';
      else if (msg.slot === 'primary' || msg.slot === 'primary2') slot = msg.slot;
      else slot = !inv.primary ? 'primary' : !inv.primary2 ? 'primary2' : p.active === 'primary2' ? 'primary2' : 'primary';
    }
    else return;
    inv.pack.splice(idx, 1);
    if (inv[slot]) inv.pack.push(inv[slot]);
    inv[slot] = item;
    if (slot !== 'armor') p.active = slot;
    p.armor = Math.min(p.armor, maxArmor(p));
  } else if (msg.action === 'unequip') {
    const slot = msg.slot;
    if (![...GUN_SLOTS, 'armor'].includes(slot) || !inv[slot]) return;
    if (inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
    inv.pack.push(inv[slot]);
    inv[slot] = null;
    p.armor = Math.min(p.armor, maxArmor(p));
  } else if (msg.action === 'drop') {
    const idx = inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0) return;
    dropBag(p.x, p.z, [inv.pack.splice(idx, 1)[0]], {}, `${p.name}'s drop`);
  } else if (msg.action === 'flare') {
    const it = inv.pack.find((i) => i.id === msg.itemId && i.kind === 'flare');
    if (it) return callExtraction(p, it);
    return;
  } else if (msg.action === 'breakbox') {
    const it = inv.pack.find((i) => i.id === msg.itemId && i.kind === 'lockbox');
    if (!it) return;
    if (p.boat) return toast(p, 'Not while you\'re riding');
    if (p.hack) return toast(p, 'Finish what you\'re doing first');
    startHack(p, 'breakbox', it.id, { ms: LOCKBOX_BREAK.ms });
    botsHear(p, LOCKBOX_BREAK.heardM);
    for (const o of players.values()) if (o !== p && !o.dead && !sameSquad(o, p) && Math.hypot(o.x - p.x, o.z - p.z) < LOCKBOX_BREAK.heardM) send(o.ws, { t: 'alert', x: Math.round(p.x), z: Math.round(p.z), text: 'Someone is prying open a locker' });
    return toast(p, `Prying open the ${it.name.toLowerCase()}: hold still for ${Math.round(LOCKBOX_BREAK.ms / 1000)}s. Anyone close by can hear it.`);
  } else if (msg.action === 'hotdrop') {
    const it = inv.pack.find((i) => i.id === msg.itemId && i.kind === 'hotflare');
    if (it) return callHotDrop(p, it);
    return;
  } else if (msg.action === 'eat') {
    return startUse(p, 'eat', msg.good);
  } else if (msg.action === 'use') {
    // H: patch up if you're hurt and have a medkit, otherwise eat. Either takes a few seconds.
    const hurt = p.hp < maxHp(p) || p.armor < maxArmor(p);
    if (!hurt || !inv.pack.some((i) => i.kind === 'medkit')) return startUse(p, 'eat');
    return startUse(p, 'heal');
  }
  dirty(p);
}

// ---------------------------------------------------------------- deployment + travel
/** Where a player may enter the map from. */
function homeLabel(id) {
  const h = map.houses[id];
  const kindName = h.kind === 'vehicle' ? VEHICLE_TYPES[h.vtype].name : HOME_KINDS[h.kind].name;
  if (h.townId !== null) return `${kindName.toLowerCase()} in ${map.towns[h.townId].name}`;
  const near = map.towns.reduce((a, t) => (!a || Math.hypot(t.x - h.x, t.z - h.z) < Math.hypot(a.x - h.x, a.z - h.z) ? t : a), null);
  return `${kindName.toLowerCase()} near ${near.name}`;
}
/** Every town you can come back to: the towns with a Contact, then the small named communities. */
const SPAWN_TOWNS = [
  ...map.contacts.map((c) => ({ name: map.towns[c.townId].name, county: map.towns[c.townId].county || null, x: c.x + 3, z: c.z + 3, contact: c.id })),
  ...map.communities.map((c) => ({ name: c.name, county: c.county || null, x: c.x, z: c.z, contact: null })),
];
function deployOptions(p) {
  const own = claimOf(p)?.kind === 'home' ? claimOf(p).id : null;
  const c = claimOf(p);
  return {
    houseId: own,
    claim: c ? { kind: c.kind, id: c.id, x: c.x, z: c.z, name: claimName(c) } : null,
    // First time in: any town, landing zone or crewmate. After a death: your stash house or any
    // town; landing zones and your crew are fast travel from home.
    towns: SPAWN_TOWNS.map((t, i) => ({ id: i, name: t.name, county: t.county, x: Math.round(t.x), z: Math.round(t.z) })),
    contacts: [],
    hideouts: hideoutsOf(p).map((st, i) => ({ id: st.id, n: i + 1, x: Math.round(st.x), z: Math.round(st.z) })),
    lzs: p.deploying ? map.landingZones.map((l) => l.id) : [],
    crew: p.deploying ? squadMembersOnline(p).filter((m) => m !== p && !m.dead && !m.downed && !m.deploying).map((m) => ({ id: m.id, name: m.name, x: Math.round(m.x), z: Math.round(m.z) })) : [],
    crates: [],
    respawn: (() => {
      if (p.deploying) return null;
      const now = Date.now(), r = respawnRules(p, now);
      return { waitMs: Math.max(0, r.readyAt - now), deaths: r.deaths, keepAway: RESPAWN.keepAwayM, away: r.away ? { x: r.away.x, z: r.away.z, ms: r.away.t + RESPAWN.keepAwayMin * 60_000 - now } : null, crewWaitMs: Math.max(0, r.crewAt - now) };
    })(),
  };
}
function placeAt(p, x, z) {
  if (p.boat) unseat(p);
  const fixed = resolveCircle(x, z, PLAYER_RADIUS, solidsNear(x, z, 3), terrain.height(x, z));
  p.x = fixed.x; p.z = fixed.z;
  // Number each teleport: movement the client sent before it saw this one is stale and ignored.
  p.tp = (p.tp || 0) + 1;
  send(p.ws, { t: 'correct', x: p.x, z: p.z, force: true, tp: p.tp });
}
function handleDeploy(p, msg) {
  if (!p.dead && !p.deploying) return;
  const claim = claimOf(p);
  const now = Date.now(), rules = p.deploying ? null : respawnRules(p, now);
  if (rules && now < rules.readyAt) return toast(p, `You can redeploy in ${Math.ceil((rules.readyAt - now) / 1000)}s`);
  if (rules && !['home', 'house', 'town', 'contact', 'hideout'].includes(msg.kind)) return toast(p, 'After a death you come back at your stash house, a hideout or a town. From your stash house, fast travel takes you to landing zones and your crew.');
  let at = null;
  if (msg.kind === 'claim') {
    return toast(p, 'Deploy first, then plant your claim marker where you want your stash house');
  } else if (msg.kind === 'house' || msg.kind === 'home') {
    if (!claim) return;
    at = homeSpot(claim);
  } else if (msg.kind === 'hideout') {
    const st = structs.get(msg.id);
    if (!st || !PIECES[st.type].hideout || !canManage(p, st) || st.ruined) return toast(p, 'That hideout is gone');
    at = touchdownSpot(st.x, st.z + 2.2);
  } else if (msg.kind === 'town') {
    const tw = nth(SPAWN_TOWNS, msg.id);
    if (!tw) return;
    at = touchdownSpot(tw.x, tw.z);
  } else if (msg.kind === 'contact') {
    // A town by its Contact (any town: first time in, or after a death).
    const ct = nth(map.contacts, msg.id);
    if (!ct) return;
    at = { x: ct.x + 3, z: ct.z + 3 };
  } else if (msg.kind === 'crate') {
    const st = structs.get(msg.id);
    if (!st || st.owner !== p.token || !PIECES[st.type].container) return;
    at = { x: st.x, z: st.z + 1.4 };
  } else if (msg.kind === 'lz') {
    // After a death it's a random one, away from where you died; the first time you pick.
    if (rules) { const ok = map.landingZones.filter((l) => !nearDeath(rules, l.x, l.z)); at = ok[Math.floor(Math.random() * ok.length)]; }
    else at = nth(map.landingZones, msg.id);
    if (!at) return;
  } else if (msg.kind === 'crew') {
    // Drop in next to a crewmate (not while they're in a firefight).
    const m = players.get(msg.id);
    if (!m || !sameSquad(m, p) || m === p || m.dead || m.downed || m.deploying) return toast(p, 'They can\'t take you right now');
    if (Date.now() - (m.lastHit || 0) < 10_000) return toast(p, `${m.name} is in a fight — try again in a moment`);
    if (rules && now < rules.crewAt) return toast(p, `You can drop in on your crew again in ${minsLeft(rules.crewAt - now)}`);
    at = { x: m.x + 1.5, z: m.z + 1.5 };
  } else return;
  if (msg.kind !== 'home' && msg.kind !== 'house' && hotZone && nearHotZone(at.x, at.z)) return toast(p, `Too close to the ${hotZone.name} hot zone: you have to get there yourself. Your stash house is open.`);
  if (rules && msg.kind !== 'home' && msg.kind !== 'house' && nearDeath(rules, at.x, at.z)) return toast(p, `Too close to where you died — that opens again in ${minsLeft(rules.away.t + RESPAWN.keepAwayMin * 60_000 - now)}. Your stash house is open.`);
  if (rules && msg.kind === 'crew') p.crewDropAt = now;
  if (!p.deploying) {
    const keepIntel = p.intel;
    Object.assign(p, { hp: 100, armor: 0, ...starterLoadout(), food: HOMESTEAD.hunger.start });
    p.intel = keepIntel;
  }
  devKit(p);
  if ((msg.kind === 'house' || msg.kind === 'home') && claim.store.upg.infirmary) {
    p.inv.armor = makeArmor('light');
    p.armor = maxArmor(p);
    p.inv.pack.push(makeConsumable('medkit'), makeConsumable('medkit'));
  }
  p.deploying = false; p.needsDeploy = false; p.dead = false;
  p.protectedUntil = Date.now() + SPAWN_PROTECT_MS;
  placeAt(p, at.x, at.z);
  for (const c of p.contracts) instantiateContract(p, c);
  pushContracts(p);
  send(p.ws, { t: 'deployed', kind: msg.kind });
  dirty(p);
}
/** Fast travel only goes OUT from your stash house — getting loot home is still on foot. */
function handleTravel(p, msg) {
  if (p.dead || !atOwnStash(p)) return toast(p, 'Fast travel leaves from your stash house');
  if (Date.now() - (p.lastHit || 0) < 10_000) return toast(p, 'Can\'t travel while in combat');
  if (hasCargo(p)) return toast(p, 'You can\'t fast travel with freight');
  const rules = respawnRules(p), now = Date.now();
  const closed = (x, z) => (nearHotZone(x, z) && (toast(p, `No fast travel within a mile of the ${hotZone.name} hot zone: get there on foot, by taxi to a mile out, or with a hot-drop flare`), true))
    || (nearDeath(rules, x, z) && (toast(p, `You died near there — fast travel there opens again in ${minsLeft(rules.away.t + RESPAWN.keepAwayMin * 60_000 - now)}. You can still go on foot.`), true));
  if (msg.kind === 'contact') {
    if (!p.discovered.includes(msg.id)) return toast(p, 'Discover that Contact on foot first');
    const c = nth(map.contacts, msg.id);
    if (!c || closed(c.x, c.z)) return;
    placeAt(p, c.x + 3, c.z + 3);
  } else if (msg.kind === 'lz') {
    const l = nth(map.landingZones, msg.id);
    if (!l || closed(l.x, l.z)) return;
    placeAt(p, l.x + 2, l.z + 2);
  } else if (msg.kind === 'hideout') {
    const st = structs.get(msg.id);
    if (!st || !PIECES[st.type].hideout || !canManage(p, st) || st.ruined) return toast(p, 'That hideout is gone');
    if (closed(st.x, st.z)) return;
    const at = touchdownSpot(st.x, st.z + 2.2);
    placeAt(p, at.x, at.z);
  } else if (msg.kind === 'squad') {
    const m = players.get(msg.id);
    if (!m || !sameSquad(p, m) || m === p || m.dead) return;
    if (Date.now() - (m.lastHit || 0) < 10_000) return toast(p, `${m.name} is in combat`);
    if (now < rules.crewAt) return toast(p, `You can join your crew by fast travel again in ${minsLeft(rules.crewAt - now)}`);
    if (closed(m.x, m.z)) return;
    p.crewDropAt = now;
    placeAt(p, m.x + 1.5, m.z + 1.5);
  } else return;
  p.protectedUntil = Date.now() + 5000;
  p.openContainer = null;
  send(p.ws, { t: 'container', closed: true });
  dirty(p);
}
function discoverContacts(p) {
  for (const c of map.contacts) {
    if (p.discovered.includes(c.id) || Math.abs(c.x - p.x) > 40 || Math.abs(c.z - p.z) > 40 || Math.hypot(c.x - p.x, c.z - p.z) > 40) continue;
    p.discovered.push(c.id);
    award(p, XP.discoverContact, `Discovered ${c.name}`);
    toast(p, `Contact discovered: ${c.name}. Talk to them for contracts. You can now fast travel here from your stash.`);
  }
}

// ---------------------------------------------------------------- helicopter extraction
const EXTRACT_HOLD_MS = Number(process.env.EXTRACT_HOLD_MS || EXTRACT.holdMs);
const EXTRACT_GRACE_MS = Number(process.env.EXTRACT_GRACE_MS ?? EXTRACT.graceMs ?? 10000);
const extractions = new Map();   // id -> { id, x, z, site, owner, ownerName, arrivesAt }
function extractList() { return [...extractions.values()].map((e) => ({ id: e.id, x: e.x, z: e.z, site: e.site, by: e.ownerName, arrivesAt: e.arrivesAt })); }
function sendEvents(extra = {}) { broadcast({ t: 'events', drops: dropList(), extracts: extractList(), ...extra }); }
/** The Contact or landing zone the player is standing at, if any. */
function extractSite(p) {
  let best = null, bd = EXTRACT.callRange;
  for (const c of map.contacts) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = { x: c.x, z: c.z, name: c.name.replace(/ Contact$/, '') }; } }
  for (const l of map.landingZones) { const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; best = { x: l.x, z: l.z, name: l.name }; } }
  if (hotZone?.open && hotZone.extract) { const e = hotZone.extract, d = Math.hypot(e.x - p.x, e.z - p.z); if (d < bd) { bd = d; best = { x: e.x, z: e.z, name: `the ${hotZone.name} hot-zone pickup` }; } }
  return best;
}
const FLARE = ACTIVITIES.rescueFlare, TAXI = ACTIVITIES.airTaxi, TAXI_WAIT_MS = Number(process.env.TAXI_WAIT_MS || TAXI.waitMs);
const JUMP_ALT = Number(process.env.JUMP_ALT || SKY.alt);   // how high the taxi drops you (lower in tests)
// ---- the helicopter taxi: between landing zones, Contacts and the airstrip, for a fare
const taxiPoints = [
  ...map.landingZones.map((l) => ({ id: `lz${l.id}`, name: l.name, x: l.x, z: l.z, range: TAXI.pickupRange })),
  ...map.contacts.map((c) => ({ id: `ct${c.id}`, name: c.name.replace(/ Contact$/, ''), x: c.x, z: c.z, range: TAXI.pickupRange })),
  ...(map.airstrips || []).map((a, i) => ({ id: `as${i}`, name: a.name, x: (a.x1 + a.x2) / 2, z: (a.z1 + a.z2) / 2, range: TAXI.airstripRange })),
];
const taxis = new Map();   // owner token -> { from, to, arrivesAt, fare }
const taxiAt = (p) => taxiPoints.find((t) => Math.hypot(t.x - p.x, t.z - p.z) <= t.range) || null;
const taxiFare = (a, b) => Math.round(TAXI.baseFare + TAXI.perMile * Math.hypot(a.x - b.x, a.z - b.z) / 1609.344);
function taxiMenu(p) {
  const here = taxiAt(p);
  if (!here) return toast(p, 'Helicopters land at landing zones, Contacts and the airstrip');
  send(p.ws, { t: 'taxiMenu', from: here.id, fromName: here.name, cash: p.cash || 0, readyIn: Math.max(0, (p.taxiReadyAt || 0) - Date.now()),
    dests: taxiPoints.filter((t) => t !== here).map((t) => ({ id: t.id, name: t.name, x: Math.round(t.x), z: Math.round(t.z), fare: taxiFare(here, t), miles: +(Math.hypot(t.x - here.x, t.z - here.z) / 1609.344).toFixed(1) })) });
}
function taxiAction(p, msg) {
  if (p.dead || p.downed) return;
  if (msg.action === 'menu') return taxiMenu(p);
  if (msg.action !== 'call') return;
  const now = Date.now(), here = taxiAt(p), to = taxiPoints.find((t) => t.id === msg.to);
  if (!here || !to || to === here) return toast(p, 'Stand on a landing zone, at a Contact or on the airstrip to call the helicopter');
  if (taxis.has(p.token)) return toast(p, 'Your helicopter is already on its way: stay on the pad');
  if (now - (p.lastHit || 0) < 10_000) return toast(p, 'The pilot won\'t land in a firefight');
  if (hasCargo(p)) return toast(p, 'No freight on the helicopter');
  if (hasHot(p)) return toast(p, 'The taxi won\'t carry hot loot: extract it (extraction point, rescue flare) or walk it home');
  if (hotZone?.open && Math.hypot(here.x - hotZone.x, here.z - hotZone.z) < HZ.keepOutM) return toast(p, `The pilot won't land this close to the ${hotZone.name} hot zone`);
  if ((p.taxiReadyAt || 0) > now) return toast(p, `Pilot refuelling: ${Math.ceil((p.taxiReadyAt - now) / 1000)}s`);
  const fare = taxiFare(here, to);
  if ((p.cash || 0) < fare) return toast(p, `The fare to ${to.name} is $${fare}. You have $${p.cash || 0}`);
  taxis.set(p.token, { from: here, to, fare, arrivesAt: now + TAXI_WAIT_MS });
  toast(p, `🚁 Helicopter to ${to.name} lands in ${Math.round(TAXI_WAIT_MS / 1000)}s ($${fare} when you board). Stay on the pad; crewmates on it ride free.`);
}
const COMPASS = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
/** A random open spot some way out from a stop: dry, outdoors, in the county, clear of strangers. */
function taxiDrop(to, riders) {
  const strangers = [...players.values()].filter((o) => !o.dead && !o.deploying && !riders.some((r) => r === o || sameSquad(r, o)));
  // Never within a mile of a hot zone: a stop that close is swapped for a spot a mile out on its side.
  let cx = to.x, cz = to.z;
  if (hotZone && Math.hypot(to.x - hotZone.x, to.z - hotZone.z) < HZ.keepOutM + TAXI.dropMax) {
    const a = Math.atan2(to.z - hotZone.z, to.x - hotZone.x) || 0;
    cx = hotZone.x + Math.cos(a) * (HZ.keepOutM + TAXI.dropMax + 20); cz = hotZone.z + Math.sin(a) * (HZ.keepOutM + TAXI.dropMax + 20);
  }
  for (let tries = 0; tries < 80; tries++) {
    const a = Math.random() * Math.PI * 2, r = TAXI.dropMin + Math.random() * (TAXI.dropMax - TAXI.dropMin);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (nearHotZone(x, z)) continue;
    if (Math.abs(x) > map.half - 60 || Math.abs(z) > map.half - 60) continue;
    if (terrain.height(x, z) < 0.6 || buildingAt(x, z) >= 0) continue;
    if (strangers.some((o) => Math.hypot(o.x - x, o.z - z) < TAXI.keepClear)) continue;
    const fixed = resolveCircle(x, z, PLAYER_RADIUS * 3, solidsNear(x, z, 5), terrain.height(x, z));
    if (Math.hypot(fixed.x - x, fixed.z - z) > 0.3) continue;
    return { x, z, dist: Math.hypot(x - to.x, z - to.z), dir: COMPASS[((Math.round(Math.atan2(z - to.z, x - to.x) / (Math.PI / 4)) % 8) + 8) % 8] };
  }
  const near = landingSpot(cx, cz, 40) || { x: cx + 3, z: cz + 3 };
  return { ...near, dist: 0, dir: '' };
}
function tickTaxis(now) {
  for (const [tok, t] of [...taxis]) {
    const p = onlineByToken(tok);
    const onPad = (o) => o && !o.dead && !o.downed && Math.hypot(o.x - t.from.x, o.z - t.from.z) <= Math.max(TAXI.radius, t.from.range);
    if (!onPad(p)) { taxis.delete(tok); if (p) toast(p, 'The helicopter turned back: you left the pad (no charge)'); continue; }
    if (now < t.arrivesAt) continue;
    taxis.delete(tok);
    if (now - (p.lastHit || 0) < 10_000) { toast(p, 'The pilot saw the shooting and turned back (no charge)'); continue; }
    if ((p.cash || 0) < t.fare) { toast(p, `You can't cover the $${t.fare} fare`); continue; }
    p.cash -= t.fare;
    const riders = [...players.values()].filter((o) => onPad(o) && (o === p || sameSquad(o, p)) && !hasCargo(o));
    const drop = taxiDrop(t.to, riders);
    const where = drop.dist ? `${distText(drop.dist)} ${drop.dir} of ${t.to.name}` : t.to.name;
    riders.forEach((o, i) => {
      if (o.hack) cancelHack(o, 'Boarding the helicopter');
      o.openContainer = null;
      send(o.ws, { t: 'container', closed: true });
      const a = (i / Math.max(1, riders.length)) * Math.PI * 2;
      // Out the door over the drop: each rider a few metres apart, the helicopter flying on past.
      placeAt(o, drop.x + Math.cos(a) * 6 * (riders.length > 1), drop.z + Math.sin(a) * 6 * (riders.length > 1));
      o.air = { alt: JUMP_ALT, mode: 'fall' };
      send(o.ws, { t: 'air', alt: JUMP_ALT, mode: 'fall', heli: { x: drop.x, z: drop.z, yaw: Math.atan2(t.to.x - t.from.x, t.to.z - t.from.z) } });
      o.taxiReadyAt = now + TAXI.cooldownMs;
      toast(o, `🪂 Jump! You're over ${where}${o === p ? ` ($${t.fare})` : ' (on your crewmate)'}. Hold Sprint for the squirrel suit; Use pulls your chute.`);
      dirty(o);
    });
  }
}
function homeSpot(c) { return c.store.spawn ? { ...c.store.spawn } : c.kind === 'flag' ? { x: c.x, z: c.z + 1.6 } : { x: c.x, z: c.z + 1.2 }; }
function callExtraction(p, flare = null) {
  if (p.dead) return;
  const now = Date.now();
  // A rescue flare calls it from right where you stand, in the open; otherwise it's a Contact or LZ.
  const site = flare ? { x: p.x, z: p.z, name: 'a rescue flare' } : extractSite(p);
  if (!site) return toast(p, `Call extraction within ${feet(EXTRACT.callRange)} of a Contact or landing zone (or fire a rescue flare)`);
  if (hasCargo(p)) return toast(p, 'The helicopter won\'t carry freight — deliver it by land (or river)');
  if (!claimOf(p)) return toast(p, 'You need a stash house for the helicopter to fly you to — plant a claim marker first');
  if (flare) {
    if (buildingAt(p.x, p.z) >= 0) return toast(p, 'Get outside: the helicopter can\'t see a flare indoors');
    if (terrain.height(p.x, p.z) < 0.3 || p.boat) return toast(p, 'Get onto dry land to fire the flare');
  }
  for (const e of extractions.values()) {
    if (e.owner === p.token || (Math.hypot(e.x - site.x, e.z - site.z) < EXTRACT.radius * 2 && tokenInSquadWith(p, e.owner))) return toast(p, `Extraction already inbound — ${Math.ceil((e.arrivesAt - now) / 1000)}s. Hold the zone.`);
    if (Math.hypot(e.x - site.x, e.z - site.z) < EXTRACT.radius * 2) return toast(p, `${e.ownerName} already has a flare up here`);
  }
  if (!flare && (p.extractReadyAt || 0) > now) return toast(p, `Pilot unavailable — try again in ${Math.ceil((p.extractReadyAt - now) / 1000)}s`);
  if (flare) { p.inv.pack.splice(p.inv.pack.indexOf(flare), 1); dirty(p); }   // one use: it's burning now
  const hold = flare ? Math.min(FLARE.holdMs, EXTRACT_HOLD_MS) : EXTRACT_HOLD_MS, alertRange = flare ? FLARE.alertRange : EXTRACT.alertRange;
  const id = uid('x');
  extractions.set(id, { id, x: site.x, z: site.z, site: site.name, owner: p.token, ownerName: p.name, arrivesAt: now + hold, flare: !!flare });
  gesture(p, 'flare', 2200);   // the flare goes up in your hand
  toast(p, flare
    ? `🔴 Flare lit. The helicopter lands here in ${Math.round(hold / 1000)}s and waits ${Math.round(FLARE_WAIT_MS / 1000)}s: be within ${feet(EXTRACT.radius)} of the flare then (go where you like till then). Crew beside you ride along.`
    : `🔴 Flare up at ${site.name}. Helicopter in ${Math.round(hold / 1000)}s — stay within ${feet(EXTRACT.radius)} of the flare. Squadmates in the zone ride along.`);
  for (const o of players.values()) {
    if (o === p || o.dead) continue;
    const d = Math.hypot(o.x - site.x, o.z - site.z);
    if (sameSquad(o, p)) toast(o, `${p.name} called extraction at ${site.name} (${distText(d)} away)`);
    else if (d < alertRange) { toast(o, `🔴 Extraction flare at ${site.name}, ${distText(d)} away — someone is flying loot out`); send(o.ws, { t: 'alert', x: site.x, z: site.z, text: 'Extraction flare' }); }
  }
  sendEvents();
}
const FLARE_WAIT_MS = Number(process.env.FLARE_WAIT_MS || FLARE.waitMs || 20000);
function tickExtractions(now) {
  for (const e of [...extractions.values()]) {
    const caller = onlineByToken(e.owner);
    const inZone = (o) => o && !o.dead && Math.hypot(o.x - e.x, o.z - e.z) <= EXTRACT.radius;
    // A rescue flare: no zone to hold. The helicopter lands at the flare when it said it would and
    // waits a little; be there (crew too) and you're off, or you miss it.
    if (e.flare) {
      if (now < e.arrivesAt) continue;
      if (!e.landed) {
        e.landed = true;
        if (caller && !inZone(caller)) toast(caller, `🚁 The helicopter is down at your flare (${distText(Math.hypot(caller.x - e.x, caller.z - e.z))} away). It leaves in ${Math.round(FLARE_WAIT_MS / 1000)}s.`);
        sendEvents();
      }
      if (caller && inZone(caller)) { flyOut(e, caller, now, inZone); continue; }
      if (now > e.arrivesAt + FLARE_WAIT_MS) {
        extractions.delete(e.id);
        if (caller) toast(caller, '🚁 You missed the helicopter: it waited at the flare, then flew off');
        sendEvents();
      }
      continue;
    }
    // Getting shot, even going down, doesn't call it off (the crew chief patches you up on board).
    // Dying does; so does staying out of the zone for more than a few seconds.
    if (caller && !caller.dead && !inZone(caller)) {
      if (!e.outSince) { e.outSince = now; toast(caller, `⚠ Get back to the flare: the helicopter leaves without you in ${Math.round(EXTRACT_GRACE_MS / 1000)}s`); }
    } else e.outSince = 0;
    if (!caller || caller.dead || (e.outSince && now - e.outSince > EXTRACT_GRACE_MS)) {
      extractions.delete(e.id);
      if (caller) { caller.extractReadyAt = now + EXTRACT.cooldownMs; toast(caller, caller.dead ? 'Extraction aborted — you were killed' : 'Extraction aborted — you left the pickup zone'); }
      sendEvents();
      continue;
    }
    if (now >= e.arrivesAt && !inZone(caller)) continue;   // it waits over the zone for you, for the grace time
    if (now < e.arrivesAt) continue;
    flyOut(e, caller, now, inZone);
  }
}
/** The helicopter lifts off with the caller and every crewmate in the pickup zone, to their stash houses. */
function flyOut(e, caller, now, inZone) {
  {
    extractions.delete(e.id);
    const riders = [...players.values()].filter((o) => inZone(o) && (o === caller || sameSquad(o, caller)));
    for (const o of riders) {
      const c = claimOf(o);
      if (!c) { toast(o, 'No stash house to fly to — you stay here'); continue; }
      const at = homeSpot(c);
      if (o.downed) revive(o, null);   // the crew chief patches you up on the way
      if (o.hack) cancelHack(o, 'Boarding the helicopter');
      o.openContainer = null;
      send(o.ws, { t: 'container', closed: true });
      placeAt(o, at.x, at.z);
      o.protectedUntil = now + 5000;
      o.extractReadyAt = now + EXTRACT.cooldownMs;
      award(o, EXTRACT.xp, 'Extracted');
      if (hasHot(o)) coolHot(o, 'by helicopter');
      send(o.ws, { t: 'extracted', from: e.site });
      dirty(o);
    }
    feed(`🚁 ${e.ownerName}${riders.length > 1 ? ` and ${riders.length - 1} squadmate${riders.length > 2 ? 's' : ''}` : ''} extracted from ${e.site}`);
    sendEvents({ pickup: { x: e.x, z: e.z } });
  }
}

// ---------------------------------------------------------------- connection handling
function handleJoin(ws, msg) {
  const name = String(msg.name || 'Agent').replace(/[^\w \-]/g, '').slice(0, 16) || 'Agent';
  let token = typeof msg.token === 'string' && /^[a-f0-9]{32}$/.test(msg.token) ? msg.token : null;
  for (const other of players.values()) {
    if (other.token !== token) continue;
    persistCharacter(other); players.delete(other.id); other.ws.player = null; other.ws.close(4000, 'Logged in elsewhere');
  }
  if (!token || !db.characters[token]) {
    token = token || crypto.randomBytes(16).toString('hex');
    db.characters[token] = newCharacter(name);
  }
  const c = db.characters[token];
  const p = {
    id: uid('p'), ws, token, ...structuredClone(c), name,
    crouch: false, aiming: false, speed: 0, lastShot: 0, reloadUntil: 0, lastMove: Date.now(), aliveMs: 0,
    openContainer: null, dirty: true, hack: null, camoOn: false, exposed: {},
  };
  for (const r of RESOURCES) p[r] ??= 0;
  p.comms ??= 0; p.field ??= []; p.discovered ??= []; p.contracts ??= [];
  p.food ??= HOMESTEAD.hunger.start;
  if (c.cash === undefined) p.cash = ECONOMY.startingCash;   // characters from before money existed
  p.houseId = ownedHouse(token);
  if (p.houseId !== null) db.houses[p.houseId].ownerName = name;
  p.mags ??= {};
  devKit(p);
  for (const st of structs.values()) if (st.owner === token) st.ownerName = name;
  p.deploying = !!p.needsDeploy;
  if (p.deploying) p.dead = true;
  else if (!p.dead) { const fixed = resolveCircle(p.x, p.z, PLAYER_RADIUS, solidsNear(p.x, p.z, 3), terrain.height(p.x, p.z)); p.x = fixed.x; p.z = fixed.z; }
  players.set(p.id, p);
  ws.player = p;
  // Arrived on a friend's invite: join their crew.
  const tk = typeof msg.ticket === 'string' && crewTickets.get(msg.ticket);
  if (tk && tk.expires > Date.now() && tk.fromToken !== token) {
    crewTickets.delete(msg.ticket);
    const host = onlineByToken(tk.fromToken);
    if (host && (!squadOf(host) || squadOf(host) !== squadOf(p))) {
      invites.set(token, { fromToken: tk.fromToken, fromName: tk.fromName, crewName: squadOf(host)?.name || null, expires: Date.now() + 60_000 });
      squadAction(p, { action: 'accept' });
    } else if (!host) toast(p, `${tk.fromName} has left this world — find them on your friends list`);
  }
  send(ws, {
    t: 'welcome', id: p.id, token, pushKey: process.env.VAPID_PUBLIC_KEY || null, world: WORLD_ID, worldName: WORLD_NAME, seed: SEED, size: WORLD_SIZE, mapSum: MAP_SUM, real: REAL_INFO, houseId: p.houseId,
    x: p.x, z: p.z, yaw: p.yaw, felled: [...map.felled], packSize: PACK_SIZE, devKit: DEV_KIT, doorBase: DOOR_HP, testRides: TEST_RIDES,
    deploy: p.dead ? deployOptions(p) : null, firstDeploy: p.deploying,
  });
  send(ws, { t: 'events', drops: dropList(), extracts: extractList() });
  send(ws, { t: 'hotzone', zone: hotZoneView() });
  sendSites(ws);
  send(ws, { t: 'worldEvents', list: [...worldEvents.values()].map(eventView) });
  if (db.characters[token]?.awayLog?.length) { send(ws, { t: 'awayLog', entries: db.characters[token].awayLog }); db.characters[token].awayLog = []; }
  // Contracts whose targets were finished while offline pay out now.
  for (const ct of [...p.contracts]) {
    if (ct.ready) completeContract(p, ct);
    else if (ct.expires < Date.now()) { abandonContract(p, ct.id); toast(p, `Contract expired: ${CONTRACT_TYPES[ct.type].name}`); }
    else if (!p.dead) instantiateContract(p, ct);
  }
  pushContracts(p);
  const crew = squadOf(p);
  if (crew) { pushSquadState(crew); sendCrew(crew, { t: 'toast', text: `${name} is online` }); }
  feed(`${name} entered the zone`);
}

function handleState(p, msg) {
  if (p.dead) return;
  const now = Date.now();
  const dt = Math.min(0.25, (now - p.lastMove) / 1000);
  p.lastMove = now;
  const tx = Number(msg.x), tz = Number(msg.z);
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
  if ((msg.tp || 0) !== (p.tp || 0)) return;   // sent before the latest teleport
  if (p.boat) return boatState(p, msg);
  if (p.air) return airState(p, msg, dt, tx, tz);
  let dx = tx - p.x, dz = tz - p.z;
  const hungry = (p.food ?? 100) < HUNGER.noSprintBelow;
  p.prone = !!msg.prone && !p.downed;
  const maxStep = isStunned(p, now) ? 0.05 : p.prone ? PRONE_SPEED * dt * 1.5 + 0.15 : hungry && !p.downed ? 4.8 * dt * 1.5 + 0.15 : (p.downed ? DOWNED.crawlSpeed : SPRINT_SPEED) * dt * 1.5 + 0.15;
  const d = Math.hypot(dx, dz);
  if (d > maxStep) { dx *= maxStep / d; dz *= maxStep / d; }
  const y0 = standing(p);
  const np = moveWithCollision(p.x, p.z, dx, dz, PLAYER_RADIUS, solidsNear(p.x, p.z, maxStep + 2).concat(rideSolids(db.boats, p.x, p.z, maxStep + 2, rideY, PLAYER_RADIUS)), terrain, y0, p.hop ? p.hop.alt : 0);
  if (p.hop && np.y !== y0) { p.hop.alt -= np.y - y0; if (p.hop.alt <= 0) p.hop = null; }   // landed on a top mid-climb
  if (p.hop?.hold && Math.hypot(p.x - p.hop.x0, p.z - p.hop.z0) > 3) p.hop.hold = 0;   // stepped away from the top of a ladder without landing: let go
  p.speed = dt > 0 ? Math.hypot(np.x - p.x, np.z - p.z) / dt : 0;
  if (p.speed > 0.5) p.lastActive = now;
  p.x = np.x; p.z = np.z;
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.crouch = (!!msg.crouch && !p.prone) || !!p.downed;
  p.slide = !!msg.slide && p.crouch && !p.downed;   // (for how others draw you)
  // Sprinting: the gun's put away. Stopping starts the draw; no shots till it's back up.
  const sprinting = !!msg.sprint && !p.downed && !p.boat && !p.air;
  if (p.sprint && !sprinting) p.drawnAt = Date.now() + drawMs(activeWeapon(p)?.archetype);
  p.sprint = sprinting;
  p.aiming = !!msg.aim;
  if (p.camoOn && msg.sprint) breakCamo(p, 500);
  p.y = np.y; p.yx = p.x; p.yz = p.z;
  if (Math.hypot(p.x - tx, p.z - tz) > 0.5) send(p.ws, { t: 'correct', x: p.x, z: p.z, y: +p.y.toFixed(2) });
  if (p.openContainer && !nearContainer(p, p.openContainer.kind, p.openContainer.id)) { p.openContainer = null; send(p.ws, { t: 'container', closed: true }); }
}
/** Steering a jump: no walls up there, just how fast this part of the fall lets you move. */
function airState(p, msg, dt, tx, tz) {
  p.air.mode = p.downed ? 'chute' : nextMode(p.air.mode, !!msg.sprint);
  const max = airRates(p.air.mode).speed * dt * 1.5 + 0.3, lim = map.half - 30;
  let dx = tx - p.x, dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  if (d > max) { dx *= max / d; dz *= max / d; }
  const nx = Math.max(-lim, Math.min(lim, p.x + dx)), nz = Math.max(-lim, Math.min(lim, p.z + dz));
  p.speed = dt > 0 ? Math.hypot(nx - p.x, nz - p.z) / dt : 0;
  p.x = nx; p.z = nz;
  p.lastActive = Date.now();
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.crouch = false; p.prone = false; p.aiming = false;
  if (Math.hypot(p.x - tx, p.z - tz) > 1) send(p.ws, { t: 'correct', x: p.x, z: p.z });
}
/** Open ground to touch down on near (x, z): not in a building, not in deep water, not in a wall. */
function touchdownSpot(x, z) {
  const ok = (px, pz) => buildingAt(px, pz) < 0 && terrain.height(px, pz) >= DEEP_WATER + 0.3
    && Math.hypot(resolveCircle(px, pz, PLAYER_RADIUS, solidsNear(px, pz, 3), terrain.height(px, pz)).x - px, resolveCircle(px, pz, PLAYER_RADIUS, solidsNear(px, pz, 3), terrain.height(px, pz)).z - pz) < 0.3;
  if (ok(x, z)) return { x, z };
  for (let r = 2; r <= 60; r += 2) for (let a = 0; a < 16; a++) {
    const px = x + Math.cos(a * Math.PI / 8) * r, pz = z + Math.sin(a * Math.PI / 8) * r;
    if (ok(px, pz)) return { x: px, z: pz };
  }
  return { x, z };
}
function pullChute(p) {
  if (!p.air || p.air.mode === 'chute') return;
  p.air.mode = 'chute';
  send(p.ws, { t: 'air', alt: p.air.alt, mode: 'chute' });
}
function landAir(p) {
  p.air = null;
  const at = touchdownSpot(p.x, p.z);
  placeAt(p, at.x, at.z);
  send(p.ws, { t: 'air', mode: null });
}
function tickAir(p, dt) {
  const was = p.air.mode;
  stepAir(p.air, dt);
  if (p.downed) p.air.mode = 'chute';
  if (was !== 'chute' && p.air.mode === 'chute') send(p.ws, { t: 'air', alt: p.air.alt, mode: 'chute' });
  if (p.air.alt <= 0) landAir(p);
}
function handleShoot(p, msg) {
  if (p.dead || p.taserOut) return;
  if (p.hack?.walk) cancelHack(p, p.hack.kind === 'eat' ? 'Stopped eating' : 'Stopped patching up');
  const w = activeWeapon(p);
  if (!w) return;
  const s = stats(p);
  const now = Date.now();
  if (now < p.reloadUntil) return;
  if (p.sprint || now < (p.drawnAt || 0) - 150) return;   // gun on your back (a little slack for the network)
  if (now - p.lastShot < (60_000 / s.rpm) * 0.85) return;
  const mag = p.mags[w.id] ?? 0;
  if (mag <= 0) return;
  if (!Array.isArray(msg.dir) || msg.dir.length !== 3 || !msg.dir.every(Number.isFinite)) return;
  const since = now - (p.lastShot || 0);
  p.lastShot = now;
  p.mags[w.id] = mag - 1;
  const at = Array.isArray(msg.at) && msg.at.length === 3 && msg.at.every(Number.isFinite) ? msg.at : null;
  const from = Array.isArray(msg.from) && msg.from.length === 3 && msg.from.every(Number.isFinite) ? msg.from : null;
  fire(p, msg.dir, false, 1, { at, from, since, tid: typeof msg.tid === 'string' ? msg.tid : null });
  dirty(p);
}
function handleReload(p) {
  const w = activeWeapon(p);
  if (!w || p.dead) return;
  const s = stats(p);
  const need = s.mag - (p.mags[w.id] ?? 0), pool = s.explosive ? 'rockets' : 'ammo';
  if (need <= 0 || (p[pool] || 0) <= 0 || p.reloadUntil > Date.now()) return;
  p.reloadUntil = Date.now() + s.reloadMs;
  const take = Math.min(need, p[pool]);
  setTimeout(() => {
    if (p.dead || activeWeapon(p)?.id !== w.id) return;
    p[pool] -= take;
    p.mags[w.id] = (p.mags[w.id] ?? 0) + take;
    dirty(p);
  }, s.reloadMs);
  dirty(p);
}
function leaderboard() {
  const live = new Map([...players.values()].map((p) => [p.token, p]));
  const rows = Object.entries(db.characters).map(([tok, c]) => {
    const src = live.get(tok) || c;
    return { name: src.name, level: levelFromXp(src.xp || 0), xp: src.xp || 0, kills: src.kills || 0, online: live.has(tok) };
  });
  rows.sort((a, b) => b.xp - a.xp);
  const crews = [...squads.values()].map((s) => {
    const home = crewClaim(s.id);
    return { name: s.name, leader: charName(s.leader), members: s.members.size, online: crewOnline(s).length, score: Math.round(s.score || 0), home: home ? homeLevel(home.store.hxp || 0) : 0 };
  }).sort((a, b) => b.score - a.score);
  return { t: 'leaderboard', rows: rows.slice(0, 15), crews: crews.slice(0, 15) };
}

// ---------------------------------------------------------------- http + ws
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
// Phones need HTTPS for controller (Gamepad API) access. Set TLS_CERT and TLS_KEY to serve HTTPS directly.
const TLS = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const STATIC = [
  ['/vendor/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/addons/', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm')],
  ['/g/', path.join(ROOT, 'godot', 'web')],   // the Godot client's web build (tools: see godot/README.md)
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'archivo', 'files')],
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'atkinson-hyperlegible', 'files')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/data/real/', REAL_DIR],
  ['/', path.join(ROOT, 'client')],
];
const handler = (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  // Who's playing, for the lobby (the hub polls this; it isn't exposed publicly through the hub).
  if (url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const avg = tickMs.length ? tickMs.reduce((a, b) => a + b, 0) / tickMs.length : 0;
    return res.end(JSON.stringify({ world: WORLD_ID, name: WORLD_NAME, online: players.size, names: [...players.values()].map((p) => p.name), tickMs: +avg.toFixed(2), tickMaxMs: +Math.max(0, ...tickMs).toFixed(2), budgetMs: 1000 / TICK_HZ }));
  }
  if (serveStatic(req, res, url, STATIC)) return;
  res.writeHead(404); res.end('Not found');
};
const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    // One bad message must never take the whole world down with it.
    try { onMessage(ws, raw); } catch (e) { console.error(`Message from ${ws.player?.name || 'a new connection'} failed:`, e); }
  });
  function onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const p = ws.player;
    if (!p) { if (msg.t === 'join') handleJoin(ws, msg); return; }
    if (msg.t !== 'state') p.lastActive = Date.now();   // doing anything counts as being active
    // Stunned: nothing but talking to your crew until it wears off.
    if (isStunned(p) && !p.dead && !p.downed && !['state', 'squad', 'leaderboard', 'closeContainer', 'dev'].includes(msg.t)) return;
    // While downed you can crawl, talk to your crew, or give up; nothing else.
    if (p.downed && !p.dead) {
      if (msg.t === 'giveUp') return killPlayer(p, p.downedBy, p.downedHead);
      if (msg.t === 'interact') { if (p.hack) return cancelHack(p, 'Cancelled'); return soloRevive(p) ? startHack(p, 'selfrevive', p.id) : toast(p, 'Only a crewmate can revive you'); }
      if (!['state', 'squad', 'leaderboard', 'closeContainer', 'dev'].includes(msg.t)) return;
    }
    // In the air: steer, pull the chute (Use), talk to your crew; no shooting or anything else.
    if (p.air && !p.dead) {
      if (msg.t === 'interact') return pullChute(p);
      if (!['state', 'squad', 'leaderboard', 'closeContainer', 'dev', 'swap', 'reload'].includes(msg.t)) return;
    }
    switch (msg.t) {
      case 'state': return handleState(p, msg);
      case 'look': {   // the wardrobe (shared/looks.js)
        const v = cleanLook(msg.look);
        if (v) p.look = v;
        return;
      }
      case 'jump': {   // off the ground only, not lying down, a breath between jumps
        const now = Date.now();
        if (p.dead || p.downed || p.prone || p.boat || p.air || p.hop || now - (p.lastJump || 0) < 650 || isStunned(p, now)) return;
        p.lastJump = now;
        // Up a ladder that's really there.
        if (msg.ladder) {
          const lad = ladderAt(solidsNear(p.x, p.z, 3), p.x, p.z, standing(p));
          if (lad) { p.hop = { alt: 0, vy: 0, ladder: lad.ladderTop - standing(p) + 0.35, x0: p.x, z0: p.z, ly: Math.atan2(lad.ladderIn[0], lad.ladderIn[1]) }; return; }
        }
        // A climb: only as high as something there really is to climb, in some direction.
        const want = Number(msg.climb);
        if (want > 0 && want <= CLIMB.max) {
          const solids = solidsNear(p.x, p.z, 3), y = standing(p);
          let h = 0;
          for (let k = 0; k < 16 && h < want - 0.05; k++) h = Math.max(h, climbAhead(solids, p.x, p.z, Math.sin(k * Math.PI / 8), Math.cos(k * Math.PI / 8), y));
          if (h > 0) { p.hop = { alt: 0, vy: climbVy(Math.min(want, h), JUMP_G), climb: 1 }; return; }
        }
        p.hop = { alt: 0, vy: JUMP_V };
        return;
      }
      case 'shoot': return handleShoot(p, msg);
      case 'taser': return handleTaser(p, msg);
      case 'voice': p.voice = { crew: !!msg.crew, near: !!msg.near }; p.voiceAt = 0; return;   // voice chat settings
      case 'rtc': {   // voice chat: a connection message for one player, only to someone you may talk to
        const o = players.get(msg.to);
        if (!o || o === p || !msg.data || JSON.stringify(msg.data).length > 12000 || !(voiceLink(p, o) || p.voicePeers?.[o.id])) return;
        return send(o.ws, { t: 'rtc', from: p.id, data: msg.data });
      }
      case 'reload': return handleReload(p);
      case 'swap': {   // next gun you're carrying: main gun 1, main gun 2, sidearm, round again
        if (p.dead || p.reloadUntil >= Date.now()) return;
        if (p.taserOut) { p.taserOut = false; dirty(p); return; }   // stun gun away: back to the gun you had
        const at = GUN_SLOTS.indexOf(p.active);
        for (let k = 1; k <= 3; k++) { const s2 = GUN_SLOTS[(at + k) % 3]; if (p.inv[s2]) { p.active = s2; break; } }
        dirty(p); return;
      }
      case 'weapon':   // straight to one slot (keys 1, 2, 3)
        if (!p.dead && p.reloadUntil < Date.now() && GUN_SLOTS.includes(msg.slot) && p.inv[msg.slot]) { p.active = msg.slot; p.taserOut = false; dirty(p); }
        return;
      case 'interact': p.buildIntent = !!msg.build; return !p.dead && interact(p);
      case 'pushSub': return pushSubscribe(p, msg);
      case 'pushUnsub': if (db.pushSubs?.[p.token] && typeof msg.endpoint === 'string') db.pushSubs[p.token] = db.pushSubs[p.token].filter((q) => q.endpoint !== msg.endpoint); return;
      case 'pushTest': {
        if (!db.pushSubs?.[p.token]?.length) return toast(p, 'Turn base alerts on first');
        if (Date.now() - (p.pushTestAt || 0) < 15_000) return;
        p.pushTestAt = Date.now();
        pushTo(p.token, 'Test alert: this is what you\'ll see if your base is attacked while you\'re away', true);
        return toast(p, 'Test alert sent: it should show up on every device you turned alerts on');
      }
      case 'takeLoot': {   // a tap on the nearby-loot list, or auto-pickup walking over it
        const l = loot.get(msg.id);
        if (!l || p.dead || p.downed || Math.hypot(l.x - p.x, l.z - p.z) > 5) return;
        return takeLoot(p, l, !!msg.auto);
      }
      case 'container': return !p.dead && containerAction(p, msg);
      case 'closeContainer': p.openContainer = null; return;
      case 'inv': return !p.dead && invAction(p, msg);
      case 'deploy': return handleDeploy(p, msg);
      case 'respawn': return handleDeploy(p, { kind: claimOf(p) ? 'home' : 'lz', id: 0 });
      case 'abandon': return abandonClaim(p);
      case 'raidWindow': return setRaidWindow(p, msg);
      case 'rebuild': { const oc = p.openContainer; if (!p.dead && oc?.kind === 'crate' && nearContainer(p, 'crate', oc.id)) startHack(p, 'rebuild', oc.id); return; }
      case 'buyMarker': {
        const ct = nth(map.contacts, msg.contactId);
        if (!ct || p.dead || Math.hypot(ct.x - p.x, ct.z - p.z) > 6) return;
        if (p.inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
        if (!payCarried(p, CLAIM.markerPrice)) return toast(p, `A claim marker costs ${CLAIM.markerPrice.parts} parts`);
        p.inv.pack.push(makeMarker());
        toast(p, 'Bought a claim marker');
        dirty(p);
        return;
      }
      case 'travel': return handleTravel(p, msg);
      case 'extract': return callExtraction(p);
      case 'taxi': return taxiAction(p, msg);
      case 'gunsmith': return gunsmithAction(p, msg);
      case 'upgrade': return upgradeAction(p, msg);
      case 'acceptContract': return !p.dead && acceptContract(p, msg);
      case 'abandonContract': return abandonContract(p, msg.id);
      case 'requisition': return !p.dead && requisition(p, msg);
      case 'trade': return !p.dead && trade(p, msg);
      case 'haul': return !p.dead && takeHaul(p, msg);
      case 'stall': return !p.dead && stallAction(p, msg);
      case 'ptrade': return !p.dead && playerTrade(p, msg);
      case 'fairSubmit': return !p.dead && fairSubmit(p);
      case 'boatHold': return !p.dead && openHold(p);
      case 'testRide': return !p.dead && testRide(p, msg.type);
      case 'dock': return !p.dead && dockAction(p, msg);
      case 'squad': return squadAction(p, msg);
      case 'rally': return !p.dead && rally(p);
      case 'mark': return !p.dead && markTarget(p, msg);
      case 'sensor': return !p.dead && throwSensor(p, msg);
      case 'stun': return !p.dead && throwStun(p, msg);
      case 'frag': return !p.dead && !p.downed && throwFrag(p, msg);
      case 'camo': {   // a charge that runs out, then recharges (shared/data/gadgets.json)
        if (p.dead) return;
        if (level(p) < GADGETS.camo.level) return toast(p, `Optical camo unlocks at level ${GADGETS.camo.level}`);
        const now = Date.now();
        if (p.camoOn) { endCamo(p, now); dirty(p); return; }
        if (now < (p.camoReadyAt || 0)) return toast(p, `Camo recharging: ready in ${Math.ceil((p.camoReadyAt - now) / 1000)}s`);
        if (p.tech <= 0) return toast(p, 'No tech to power camo');
        p.camoOn = true; p.camoUntil = now + GADGETS.camo.durationMs; dirty(p); return;
      }
      case 'leaderboard': return send(p.ws, leaderboard());
      case 'build': return !p.dead && handleBuild(p, msg);
      case 'dismantle': return !p.dead && dismantle(p, msg);
      case 'craft': return !p.dead && craft(p, msg);
      case 'dev':
        // Test-only helpers (teleport / die), never enabled unless the server is started with ALLOW_DEV=1.
        if (process.env.ALLOW_DEV !== '1') return;
        if (msg.kill) return !p.dead && killPlayer(p, null);
        if (typeof msg.gesture === 'string' && msg.gesture.length < 20) return gesture(p, msg.gesture, Math.min(60000, Number(msg.ms) || 3000));
        if (Number.isFinite(msg.damage)) return applyDamage(p, msg.damage, null, false);
        if (Array.isArray(msg.spawnBots)) { for (const q of msg.spawnBots.slice(0, 6)) if (Number.isFinite(q.x) && Number.isFinite(q.z)) spawnBot(q.x, q.z, 'ambient', { hp: q.hp || 140, maxHp: q.hp || 140 }); return; }
        if (msg.event) { const e = startEvent(msg.event); if (e && Number.isFinite(msg.x)) { e.x = msg.x; e.z = msg.z; } return; }
        if (msg.endEvent) { const e = [...worldEvents.values()].find((x) => x.type === msg.endEvent); if (e) endEvent(e, 'expired'); return; }
        if (typeof msg.giveGun === 'string' && ARCHETYPE_KEYS.includes(msg.giveGun)) { const w = makeWeapon(msg.giveGun); p.inv.pack.push(w); p.mags[w.id] = weaponStats(w).mag; dirty(p); return; }
        if (msg.give && typeof msg.give === 'object') { for (const [k, v] of Object.entries(msg.give)) if (RESOURCES.includes(k) && Number.isFinite(v)) p[k] = (p[k] || 0) + v; dirty(p); return; }
        if (Number.isInteger(msg.boatTo) && p.boat && map.docks[msg.boatTo]) { const b = boatById(p.boat), d = map.docks[msg.boatTo]; b.x = d.wx; b.z = d.wz; placeOccupants(b); return send(p.ws, { t: 'boatFix', x: b.x, z: b.z, yaw: b.yaw }); }
        if (Number.isFinite(msg.boatDamage) && msg.boatId) { const b = boatById(msg.boatId); if (b) damageBoat(b, msg.boatDamage, p); return; }
        if (msg.spawnRide && own(RIDES, msg.spawnRide.type) && Number.isFinite(msg.spawnRide.x) && Number.isFinite(msg.spawnRide.z)) { const q = msg.spawnRide, b = newBoat(q.type, q.x, q.z, Number(q.yaw) || 0, null, { world: 1, color: 0, keys: q.keys !== false }); return send(p.ws, { t: 'devRide', id: b.id }); }
        if (msg.rideCount) return send(p.ws, { t: 'devRide', counts: db.boats.reduce((a, b) => (a[b.type] = (a[b.type] || 0) + 1, a), {}) });
        if (msg.killEventBots) { for (const b of [...bots.values()]) if (b.eventId && !b.dead && (!msg.only || b.kind === msg.only)) { applyDamage(b, 99999, p, true); } return; }
        if (Number.isFinite(msg.x) && Number.isFinite(msg.z)) placeAt(p, msg.x, msg.z);
        return;
    }
  }
  ws.on('close', () => {
    const p = ws.player;
    if (!p) return;
    if (p.boat) leaveBoat(p, true);   // nobody logs off in the middle of the river
    if (p.air) { const at = touchdownSpot(p.x, p.z); p.x = at.x; p.z = at.z; p.air = null; }   // or in the sky
    persistCharacter(p);
    db.lastSeen[p.token] = Date.now();
    players.delete(p.id);
    const crew = squadOf(p);
    if (crew) pushSquadState(crew);   // stays in the crew, shown offline
    feed(`${p.name} left the zone`);
  });
});

// ---------------------------------------------------------------- main loop
function snapshotFor(r, views, now) {
  const near = (o, d = INTEREST) => Math.abs(o.x - r.x) < d && Math.abs(o.z - r.z) < d;
  const list = [];
  const thermal = r.aiming && !r.dead && !!stats(r)?.thermal;   // aiming through a thermal sight
  for (const [p, v] of views) {
    const close = near(p);
    const squad = sameSquad(r, p);
    if (!close && !squad && !exposedTo(p, r)) continue;   // hacked enemies show wherever they are
    const d = Math.hypot(p.x - r.x, p.z - r.z);
    if (p !== r && v.camo && !squad && !exposedTo(p, r) && d > CAMO_REVEAL_DIST && !(thermal && d < COMBAT.optics.thermalRange)) continue;
    list.push(squad && p !== r ? `${v.json.slice(0, -1)},"sq":1}` : v.json);   // each player's view is encoded once a tick
  }
  // What changes slowly (loot, bags, doors, terminals, structures) is rebuilt twice a second, or
  // straight after the player does something; the rest ten times a second.
  if (!r.slow || now - r.slow.at > 450) {
    r.slow = { at: now, json: JSON.stringify({
      loot: [...loot.values()].filter((l) => near(l, 140)).map((l) => ({ id: l.id, x: l.x, z: l.z, kind: l.item.kind, name: l.item.name, amount: l.item.amount || 0, ...(l.item.hot ? { hot: 1 } : {}) })),
      bags: db.bags.filter((b) => near(b, 200)).map((b) => ({ id: b.id, x: b.x, z: b.z, label: b.label })),
      houses: map.houses.filter((h) => near(h)).map((h) => { const s = db.houses[h.id]; const rs = s.owner && !livesAt(r, s) ? cachedRaidState(s) : null; return { id: h.id, hp: Math.round(s.doorHp), max: Math.round(doorMax(h.id)), open: s.doorOpen, owner: s.owner ? s.ownerName : null, upg: s.upg, hl: s.owner ? homeLevel(s.hxp) : 0, ...(rs ? { rs: RS_CODE[rs.mode], rw: rs.start } : {}) }; }),
      terminals: map.terminals.filter((t) => near(t)).map((t) => [t.id, (terminalReadyAt.get(t.id) || 0) <= now ? 1 : 0]),
      objectives: [...objectives.values()].filter((o) => near(o) && tokenInSquadWith(r, o.owner)).map((o) => ({ id: o.id, x: o.x, z: o.z })),
      structs: structsNear(r.x, r.z, INTEREST).map((st) => ({ id: st.id, type: st.type, x: st.x, z: st.z, rot: st.rot, y0: +st.y0.toFixed(2), stage: st.stage, hp: Math.round(st.hp), max: Math.round(PIECES[st.type].claim ? flagMax(st) : stageDef(st).hp), hl: PIECES[st.type].claim ? homeLevel(st.hxp) : undefined, open: !!st.open, owner: st.ownerName, mine: canManage(r, st) ? 1 : 0, ...structRaidView(r, st), ...(PIECES[st.type].defense && canManage(r, st) ? { ammo: st.ammo || 0, meat: st.meat || 0, fed: (st.fedUntil || 0) > now ? 1 : 0 } : {}), ...(st.type === 'plot' ? { crop: st.crop || null, grow: +cropState(st, now).grow.toFixed(2), rotten: cropState(st, now).phase === 'rotten' ? 1 : 0 } : {}) })),
    }).slice(1, -1) };
  }
  const fast = JSON.stringify({
    t: 'snap', players: 0,
    bots: [...bots.values()].filter((b) => !b.dead && near(b)).map((b) => ({ id: b.id, name: b.name, kind: b.kind, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), maxHp: b.maxHp, stun: isStunned(b, now) ? 1 : 0, ...(b.crouch ? { crouch: true } : {}) })),
    boats: db.boats.filter((b) => near(b, isLand(b.type) ? RIDE_SEEN : INTEREST) || (BOATS[b.type].loud && rtOf(b).speed > 1 && Math.hypot(b.x - r.x, b.z - r.z) < BOATS[b.type].loud)).map((b) => ({ id: b.id, type: b.type, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), max: BOATS[b.type].hp, owner: b.ownerName, mine: canUseBoat(r, b) ? 1 : 0, seats: rtOf(b).seats, fast: rtOf(b).speed > 1 ? 1 : 0,
      ...(isLand(b.type) ? { y: +rideY(b).toFixed(2), c: b.color || 0, ...(b.keys === false ? { nk: 1 } : {}), ...(b.world ? { w: 1 } : {}), ...(rtOf(b).speed > 0.3 ? { sp: +rtOf(b).speed.toFixed(1), ...(rtOf(b).rev ? { rev: 1 } : {}) } : {}) } : {}) })),
    charges: [...charges.values()].filter((c) => near(c)).map((c) => ({ id: c.id, x: c.x, z: c.z, y: c.y, detAt: c.detAt })),
  });
  return `${fast.slice(0, -1).replace('"players":0', `"players":[${list.join(',')}]`)},${r.slow.json}}`;
}

function structRaidView(r, st) {
  const out = st.ruined || st.broken ? { ru: 1 } : {};
  const base = baseOf(st);
  if (base && !canManage(r, st) && !livesAt(r, base)) { const rs = cachedRaidState(base); out.rs = RS_CODE[rs.mode]; out.rw = rs.start; }
  return out;
}

let tick = 0;
const tickMs = [];   // how long each tick took (for /status and load tests)
const loop = setInterval(() => {
  const t0 = performance.now();
  const now = Date.now();
  // Where everyone stood over the last few ticks (shots are checked against what the shooter saw).
  for (const c of players.values()) if (!c.dead) { (c.hist ??= []).push({ t: now, x: c.x, z: c.z, y: gy(c), crouch: c.crouch, prone: !!c.prone }); if (c.hist.length > 8) c.hist.shift(); }
  for (const c of bots.values()) if (!c.dead) { (c.hist ??= []).push({ t: now, x: c.x, z: c.z, y: gy(c), crouch: c.crouch }); if (c.hist.length > 8) c.hist.shift(); }
  const dt = 1 / TICK_HZ;
  for (const p of players.values()) if (p.air && !p.dead) tickAir(p, dt);
  for (const p of players.values()) if (p.hop) {
    if (p.hop.ladder) { p.hop.alt = Math.min(p.hop.ladder, p.hop.alt + LADDER.speed * dt); if (p.hop.alt >= p.hop.ladder) { p.hop.ladder = 0; p.hop.vy = 0; p.hop.hold = Date.now() + 60_000; } }   // at the top: hang on until you step off (landing on the top ends it; so does moving away)
    else if (!(p.hop.hold > Date.now())) { p.hop.vy -= JUMP_G * dt; p.hop.alt += p.hop.vy * dt; }
    if (p.hop.alt <= 0 || p.dead || p.downed || p.boat || p.air) p.hop = null;
  }
  updateBots(dt, now);
  tickHacks(now);
  if (tick % 5 === 0) { tickExtractions(now); tickTaxis(now); tickDowned(now); tickHotZone(now); tickSites(now); tickRides(now); }
  tickStuns(now);
  tickEvents(now, dt);
  if (tick % 4 === 0) tickDefenses(now);
  for (const c of [...charges.values()]) if (c.detAt <= now) explode(c, now);
  if (tick % 10 === 0) tickSensors(now);
  if (tick % TICK_HZ === 0) {
    manageAmbientBots();
    manageAnimals();
    tickVoice();
    keepMerchants(now);
    keepSettlers(now);
    keepTraders();
    scheduleDrop(now);
    for (const [id, d] of drops) if (d.expires < now) { drops.delete(id); sendEvents(); }
    for (const p of players.values()) {
      if (p.camoOn && now >= (p.camoUntil || 0)) { endCamo(p, now); dirty(p); toast(p, `Camo ran out: recharging (${Math.round(GADGETS.camo.cooldownMs / 1000)}s)`); continue; }
      if (!camoActive(p)) continue;
      p.camoDrain = (p.camoDrain || 0) + (hasField(p, 'camoMk2') ? 0.25 : 0.5);
      if (p.camoDrain >= 1) { p.camoDrain -= 1; p.tech = Math.max(0, p.tech - 1); dirty(p); }
      if (p.tech <= 0) { endCamo(p, now); toast(p, 'Camo offline: out of tech'); }
    }
    for (const [tok, inv] of invites) if (inv.expires < now) invites.delete(tok);
    refillLoot(now);
    db.bags = db.bags.filter((b) => b.expires > now);
    tickHouses(now);
    for (const p of players.values()) {
      if (p.dead) continue;
      discoverContacts(p);
      // Time alive pays while you're out and moving: not standing idle, not sitting in a safe camp.
      if (now - (p.lastActive || 0) < XP.idleAfterMs && !inCamp(p.x, p.z) && !inFair(p.x, p.z)) p.aliveMs += 1000;
      if (p.aliveMs >= 60_000) { p.aliveMs -= 60_000; award(p, XP.survivalPerMinute, 'Survived another minute'); }
      if (now - (p.lastHit || 0) >= 6000 && p.armor < maxArmor(p) && p.food >= HUNGER.noRegenBelow) { p.armor = Math.min(maxArmor(p), p.armor + 3); dirty(p); }
      const HR = COMBAT.healthRegen;   // and health, part of the way, once you're out of the fight
      if (HR && !p.downed && now - (p.lastHit || 0) >= HR.afterMs && p.hp < HR.upTo && p.food >= HUNGER.noRegenBelow) { p.hp = Math.min(HR.upTo, p.hp + HR.perSec); dirty(p); }
      tickHunger(p, now);
      for (const c of [...p.contracts]) if (c.expires < now) { abandonContract(p, c.id); toast(p, `Contract expired: ${CONTRACT_TYPES[c.type].name}`); }
    }
    if (tick % (TICK_HZ * 5) === 0) for (const s of squads.values()) pushSquadState(s);   // squadmate positions for the map
    for (const [id, hv] of harvested) if (hv.box && hv.regrowAt <= now) { hv.box.gone = 0; hv.box = null; hv.uses = 0; map.felled.delete(id); broadcast({ t: 'felled', id, on: 0 }); }   // grown back
  }
  if (tick % SNAPSHOT_EVERY === 0 && players.size) {
    const views = new Map([...players.values()].filter((p) => !p.deploying).map((p) => [p, {
      id: p.id, name: p.name, ...(p.look ? { lk: p.look } : {}), x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pitch: +(p.pitch || 0).toFixed(3),
      crouch: p.crouch, ...(p.slide ? { sl: 1 } : {}), prone: p.prone ? 1 : 0, dead: p.dead, downed: p.downed ? 1 : 0, stun: isStunned(p, now) ? 1 : 0, hp: Math.round(p.hp), maxHp: maxHp(p), armor: Math.round(p.armor), maxArmor: maxArmor(p),
      level: level(p), sh: shielded(p) ? 1 : 0, camo: camoActive(p), hacking: !!p.hack, prot: (p.protectedUntil || 0) > now, boat: p.boat || null, seat: p.seat ?? null,
      ...(p.hop?.ladder ? { lad: 1, ly: +p.hop.ly.toFixed(2) } : {}),   // on a ladder: climbing pose
      air: p.air ? p.air.mode : undefined, alt: p.air ? Math.round(p.air.alt * 10) / 10 : p.hop ? Math.round(p.hop.alt * 100) / 100 : undefined,
      y: !p.boat && standing(p) > terrain.height(p.x, p.z) + 0.8 ? +standing(p).toFixed(2) : undefined,   // up on a bridge deck
      aim: p.aiming && !p.dead ? 1 : 0,
      ...(p.sprint && !p.dead ? { sp: 1 } : {}),   // sprinting: gun put away
      gl: p.aiming && !p.dead && activeWeapon(p) && stats(p).glint ? 1 : 0,
      gun: p.taserOut ? { a: 'taser' } : activeWeapon(p) ? { a: activeWeapon(p).archetype, m: modelOf(activeWeapon(p)) || undefined, parts: activeWeapon(p).parts, paint: activeWeapon(p).paint } : null,
      stowed: stowedGuns(p),
      rl: p.reloadUntil > now ? Math.round(p.reloadUntil - now) : undefined,   // reloading: ms left
      ...actionView(p, now),   // doing something that takes a while (client/actions.js poses it)
    }]));
    for (const v of views.values()) Object.defineProperty(v, 'json', { value: JSON.stringify(v) });   // not enumerable: never encoded twice
    for (const r of players.values()) if (r.ws.readyState === 1) r.ws.send(snapshotFor(r, views, now));
  }
  for (const p of players.values()) if (p.dirty) { p.dirty = false; send(p.ws, privateState(p)); }
  tickMs.push(performance.now() - t0);
  if (tickMs.length > 200) tickMs.shift();
  tick++;
}, 1000 / TICK_HZ);

const saver = setInterval(saveDb, Number(process.env.SAVE_EVERY_MS || 10_000));
// Run by the hub: if the hub goes away (even killed outright), save and stop too.
if (process.send) process.on('disconnect', () => { try { saveDb(); } catch { /* best effort */ } process.exit(0); });
// Hosting platforms stop the old server with SIGTERM on every redeploy: save the world and exit
// cleanly, so nothing is lost and the platform doesn't report a crash.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    try { saveDb(); } catch (e) { console.error('Save on shutdown failed:', e); }
    console.log(`Saved the world and shut down (${sig})`);
    process.exit(0);
  });
}
function shutdown() { clearInterval(loop); clearInterval(saver); saveDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

refillLoot(Date.now());
server.listen(PORT, () => console.log(`Deadzone server on ${TLS ? 'https' : 'http'}://localhost:${PORT}  (seed ${SEED}, ${(WORLD_SIZE / 1609.344).toFixed(1)} × ${(WORLD_SIZE / 1609.344).toFixed(1)} mi world at 1:1, ${map.towns.length} towns, ${map.real.structures ? `${map.real.structures} real buildings, ` : ''}${map.real.roads ? `${map.real.roads} real roads, ` : ''}${map.houses.length} stash houses, ${map.lootSpawns.length} loot spots, ${map.contacts.length} contacts)`));
