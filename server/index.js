// Authoritative game server: one persistent, always-live 30 x 30 km open world (real 1:1 Bristol, FL).
// - Serves the browser client over HTTP(S) and runs the simulation over WebSocket.
// - Every position, shot, hit, pickup, hack, contract and stash transfer is validated here.
// - World state (characters, stash houses and their upgrades, dropped bags) persists to disk, so the
//   world keeps existing while players are offline — including their stash houses.
// - Interest management: each player only receives what's within ~320 m of them, and AI only runs
//   near players, which is what lets one server host a PUBG-sized map.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { biomeName, DEEP_WATER, parseElevation } from '../shared/terrain.js';
import zlib from 'node:zlib';
import { serveStatic } from './static.js';
import { BOATS, floats, seatPos } from '../shared/boats.js';
import {
  SpatialGrid, generateMap, mapChecksum, moveWithCollision, HOME_KINDS, VEHICLE_TYPES, resolveCircle, rayAgainstBoxes, rayBox, rayHitBox, insideBuilding, characterBounds,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, PRONE_EYE, PRONE_SPEED, SPRINT_SPEED, INTERACT_RANGE, DEFAULT_WORLD_SIZE,
} from '../shared/world.js';
import {
  makeWeapon, makeArmor, makeConsumable, weaponStats, armorStats, worldSupply, partFits, isUnlocked,
  levelFromXp, unlocksAt, XP, ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS, GADGETS, FIELD_PERKS,
  UPGRADES, CONTRACT_TYPES, SUPPLY_DROP_CONTENTS, TERMINAL_REWARD, TERMINAL_COOLDOWN_MS,
} from '../shared/items.js';
import { PIECES, BUILD, TOOLS, CRAFTS, pieceBox, structureBox, investedCost, placementProblem } from '../shared/building.js';
import { CLAIM, HOME_XP, homeLevel, homePerks, RAIDS, windowOpen, windowText } from '../shared/claims.js';
import { EXTRACT } from '../shared/extraction.js';
import { distText, feet } from '../shared/units.js';
import COMBAT from '../shared/data/combat.json' with { type: 'json' };
import GADGET_DATA from '../shared/data/gadgets.json' with { type: 'json' };
import ACTIVITIES from '../shared/data/activities.json' with { type: 'json' };
import HOMESTEAD from '../shared/data/homestead.json' with { type: 'json' };
import ECONOMY from '../shared/data/economy.json' with { type: 'json' };
import LIVING from '../shared/data/world.json' with { type: 'json' };
import RIVER_DATA from '../shared/data/river.json' with { type: 'json' };

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
const AMBIENT_BOTS = Number(process.env.BOTS ?? 5);   // roaming rogues kept around each active player
const BOT_ACTIVE_RANGE = 450;
const PACK_SIZE = COMBAT.packSize;
const DOOR_HP = Number(process.env.DOOR_HP || COMBAT.doorHp);
const LOOT_RESPAWN_MS = ACTIVITIES.loot.respawnMs;
const BAG_LIFETIME_MS = COMBAT.bagLifetimeMs;
const DB_VERSION = 10;   // 10: real buildings at their real angle and shape (the map changed under every save)
const SQUAD_MAX = COMBAT.crewMax;
const GOODS = Object.keys(HOMESTEAD.goods);   // cash, seeds, crops, fish, meat, meals
const RESOURCES = ['ammo', 'parts', 'tech', 'intel', 'salvage', 'wood', 'stone', ...GOODS];   // carried; all drop on death, all stealable
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
const realFiles = process.env.REAL_DATA === '0' ? {} : { structures: readReal('structures.json'), roads: readReal('roads.json'), elevation: readElevation() };
const map = generateMap(SEED, WORLD_SIZE, { structures: realFiles.structures?.rows, roads: realFiles.roads?.rows, elevation: realFiles.elevation });
// Clients fetch the same files so they generate the identical world.
const REAL_INFO = (realFiles.structures || realFiles.roads || realFiles.elevation) ? { structures: !!realFiles.structures, roads: !!realFiles.roads, elevation: !!realFiles.elevation } : null;
const grid = map.grid;
const terrain = map.terrain;
/** Look something up by a key a client sent: only the table's own entries count (never 'constructor'
 *  and friends, never a "_about" note). */
const own = (table, key) => (typeof key === 'string' && key[0] !== '_' && Object.hasOwn(table, key) ? table[key] : undefined);
/** An entry of a list by an index a client sent: whole numbers only. */
const nth = (list, i) => { const k = typeof i === 'string' && /^\d+$/.test(i) ? Number(i) : i; return Number.isInteger(k) && k >= 0 && k < list.length ? list[k] : undefined; };
const gy = (c) => (c.boat ? 0.25 : terrain.height(c.x, c.z));   // ground height under a character (or the boat deck)
const MAP_SUM = mapChecksum(map);

// ---------------------------------------------------------------- persistence
const freshHouse = () => ({ owner: null, ownerName: null, doorHp: DOOR_HP, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, upg: {} });
function freshDb() {
  return { characters: {}, houses: Object.fromEntries(map.houses.map((h) => [h.id, freshHouse()])), bags: [], structures: [] };
}
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (db.seed !== SEED || db.version !== DB_VERSION || db.size !== WORLD_SIZE) throw new Error('incompatible save');
    return db;
  } catch {
    return { seed: SEED, version: DB_VERSION, size: WORLD_SIZE, ...freshDb() };
  }
}
const db = loadDb();
Object.assign(db, { seed: SEED, version: DB_VERSION, size: WORLD_SIZE });
for (const h of map.houses) {
  db.houses[h.id] = { ...freshHouse(), ...(db.houses[h.id] || {}) };
  db.houses[h.id].upg = { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0, ...db.houses[h.id].upg };
}
db.structures ??= [];
db.boats ??= [];
db.crews ??= {};
db.lastSeen ??= {};   // login token -> when they were last online (fair raids)

function saveDb() {
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
  return { primary: null, secondary: makeWeapon('sidearm'), armor: null, pack: [makeConsumable('medkit')] };
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
function activeWeapon(p) { return p.inv[p.active] || p.inv.primary || p.inv.secondary || null; }
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

const PERSIST = ['shieldOff', 'selfReviveAt', 'name', 'x', 'z', 'yaw', 'hp', 'armor', 'inv', 'ammo', 'mags', 'active', 'dead', 'kills', 'xp', 'comms', 'field', 'discovered', 'contracts', 'needsDeploy', 'food', ...RESOURCES];
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
    reloading: p.reloadUntil > Date.now(), houseId: claimOf(p)?.kind === 'home' ? claimOf(p).id : null, claim: claimSummary(p),
    camoOn: !!p.camoOn, camoActive: camoActive(p), sensorReadyAt: p.sensorReadyAt || 0, rallyReadyAt: p.rallyReadyAt || 0,
    buffUntil: p.buffUntil || 0, protectedUntil: p.protectedUntil || 0, deploying: !!p.deploying,
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
function shielded(c) { return !!c && !c.isBot && !!c.token && !c.shieldOff && level(c) < SHIELD_LEVEL; }
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
function logAway(ownerToken, text) {
  const now = Date.now();
  for (const tok of teamTokensOf(ownerToken)) {
    const online = onlineByToken(tok);
    if (online) continue;   // online crewmates get toasts instead
    const c = db.characters[tok];
    if (!c) continue;
    c.awayLog = [...(c.awayLog || []), { at: now, text }].slice(-DEF.logMax);
  }
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
function npcTradeView(b) {
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
  for (const b of bots.values()) if (b.npc && !b.dead && (b.kind === 'merchant' || b.kind === 'settler' || b.kind === 'trader') && Math.hypot(b.x - p.x, b.z - p.z) < 2.6) return b;
  return null;
}
function npcView(p, b) {
  return { t: 'contact', id: null, npc: b.id, name: b.name, offers: [], active: [], comms: p.comms, trade: npcTradeView(b) };
}


// ---- the river trade (phase 2): boats, landings, river freight, river traders and swamp camps
const RV = RIVER_DATA;
const boatRt = new Map();   // boat id -> { speed, seats: [playerId | null] } (runtime only)
function rtOf(b) { let r = boatRt.get(b.id); if (!r) { r = { speed: 0, seats: Array(BOATS[b.type].seats).fill(null) }; boatRt.set(b.id, r); } return r; }
const boatById = (id) => db.boats.find((b) => b.id === id);
const canUseBoat = (p, b) => !!b.owner && tokenInSquadWith(p, b.owner);
const boatName = (b) => `${b.ownerName ? `${b.ownerName}'s ` : ''}${BOATS[b.type].name.toLowerCase()}`;
const boatOccupants = (b) => rtOf(b).seats.map((id) => id && players.get(id)).filter(Boolean);
function inCamp(x, z) { for (const c of map.camps) if (Math.hypot(x - c.x, z - c.z) <= c.radius) return c; return null; }
function newBoat(type, x, z, yaw, owner) {
  const b = { id: `boat${crypto.randomBytes(4).toString('hex')}`, type, owner: owner?.token || null, ownerName: owner?.name || null, x, z, yaw, hp: BOATS[type].hp, items: [] };
  db.boats.push(b);
  return b;
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
function placeOccupants(b) { rtOf(b).seats.forEach((id, i) => { const o = id && players.get(id); if (o) { const q = seatPos(b, i); o.x = q.x; o.z = q.z; } }); }
function boardBoat(p, b) {
  const rt = rtOf(b);
  const seat = rt.seats[0] == null ? 0 : rt.seats.findIndex((x) => x == null);
  if (seat < 0) return toast(p, 'The boat is full');
  cancelHack(p, 'Cancelled');
  rt.seats[seat] = p.id; p.boat = b.id; p.seat = seat; p.crouch = false;
  const q = seatPos(b, seat);
  p.x = q.x; p.z = q.z;
  p.tp = (p.tp || 0) + 1;
  send(p.ws, { t: 'correct', x: p.x, z: p.z, force: true, tp: p.tp });
  toast(p, seat === 0 ? `At the helm of the ${BOATS[b.type].name.toLowerCase()}. E to get out at the bank, BAG for the hold.` : `Riding in ${boatName(b)}. E to get out at the bank.`);
  dirty(p);
}
function unseat(p) {
  const b = p.boat && boatById(p.boat);
  if (b) { const rt = rtOf(b); if (rt.seats[p.seat] === p.id) rt.seats[p.seat] = null; if (p.seat === 0) rt.speed = 0; }
  p.boat = null; p.seat = null;
  if (p.openContainer?.kind === 'boat') { p.openContainer = null; send(p.ws, { t: 'container', closed: true }); }
  dirty(p);
}
function leaveBoat(p, force = false) {
  const b = boatById(p.boat);
  if (!b) { unseat(p); return true; }
  let spot = landingSpot(b.x, b.z);
  if (!spot && force) { spot = landingSpot(b.x, b.z, 90); if (!spot) { const d = nearestDock(b.x, b.z); spot = { x: d.x, z: d.z }; } }
  if (!spot) { toast(p, 'Steer in to the bank to get out'); return false; }
  unseat(p);
  placeAt(p, spot.x, spot.z);
  return true;
}
/** Driver input: the client predicts the boat; the server keeps it on the water and in speed. */
function boatState(p, msg) {
  const b = boatById(p.boat);
  if (!b) return unseat(p);
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.aiming = !!msg.aim; p.crouch = false;
  const rt = rtOf(b), now = Date.now();
  if (p.seat === 0 && msg.boat && [msg.boat.x, msg.boat.z, msg.boat.yaw].every(Number.isFinite)) {
    const dt = Math.min(0.25, (now - (b.lastMove || now - 50)) / 1000);
    b.lastMove = now;
    let dx = msg.boat.x - b.x, dz = msg.boat.z - b.z;
    const max = BOATS[b.type].speed * dt * 1.5 + 0.3, d = Math.hypot(dx, dz);
    if (d > max) { dx *= max / d; dz *= max / d; }
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
    let x = b.x, z = b.z, ok = true;
    for (let i = 0; i < steps; i++) { const nx = x + dx / steps, nz = z + dz / steps; if (!floats(terrain, nx, nz)) { ok = false; break; } x = nx; z = nz; }
    rt.speed = dt > 0 ? Math.hypot(x - b.x, z - b.z) / dt : 0;
    b.x = x; b.z = z; b.yaw = msg.boat.yaw;
    if (!ok || Math.hypot(x - msg.boat.x, z - msg.boat.z) > 1) send(p.ws, { t: 'boatFix', x, z, yaw: b.yaw });
    placeOccupants(b);
  }
  p.speed = rt.speed;
  if (rt.speed > 0.5) p.lastActive = now;
}
/** Boats and landing posts within reach, as an interactable: { d, run }. */
function riverInteractable(p) {
  let best = null;
  for (const b of db.boats) {
    const d = Math.hypot(b.x - p.x, b.z - p.z) - 1.5;
    if (d < RV.rules.boardRange && (!best || d < best.d)) best = { d, run: () => boatInteract(p, b) };
  }
  for (const dk of map.docks) {
    const d = Math.hypot(dk.x - p.x, dk.z - p.z) - 0.4;
    if (d < 2.5 && (!best || d < best.d)) best = { d, run: () => send(p.ws, dockView(p, dk)) };
  }
  return best;
}
function boatInteract(p, b) {
  if (canUseBoat(p, b)) return boardBoat(p, b);
  if (rtOf(b).seats.some(Boolean)) return toast(p, `${boatName(b)} is crewed. Not yours to board.`);
  if (!b.owner) { b.owner = p.token; b.ownerName = p.name; return boardBoat(p, b); }
  warnTeam(b.owner, `⚠ ${p.name} is hotwiring your ${BOATS[b.type].name.toLowerCase()}`, b.x, b.z, 'Boat theft');
  return startHack(p, 'hotwire', b.id);
}
function finishHotwire(p, id) {
  const b = boatById(id);
  if (!b || Math.hypot(b.x - p.x, b.z - p.z) > RV.rules.boardRange + 2) return toast(p, 'The boat drifted off');
  if (rtOf(b).seats.some(Boolean)) return toast(p, 'Someone got in first');
  const was = b.owner;
  warnTeam(was, `⚠ ${p.name} stole your ${BOATS[b.type].name.toLowerCase()}`, b.x, b.z, 'Boat stolen');
  b.owner = p.token; b.ownerName = p.name;
  award(p, 60, 'Hotwired a boat');
  send(p.ws, { t: 'hack', done: true, text: 'Engine running' });
  boardBoat(p, b);
}
function openHold(p) {
  const b = p.boat ? boatById(p.boat) : db.boats.find((x) => canUseBoat(p, x) && Math.hypot(x.x - p.x, x.z - p.z) < RV.rules.boardRange + 1);
  if (!b || !canUseBoat(p, b)) return toast(p, 'No boat of yours here');
  p.openContainer = { kind: 'boat', id: b.id };
  send(p.ws, containerView(p, 'boat', b.id));
}
function damageBoat(b, dmg, by) {
  b.hp -= dmg;
  if (b.owner && !(by && tokenInSquadWith(by, b.owner)) && (!b.alertedAt || Date.now() - b.alertedAt > 20_000)) {
    b.alertedAt = Date.now();
    warnTeam(b.owner, `⚠ ${by?.name || 'Someone'} is shooting your ${BOATS[b.type].name.toLowerCase()}`, b.x, b.z, 'Boat under fire');
  }
  if (b.hp <= 0) sinkBoat(b, by);
}
function sinkBoat(b, by) {
  const spot = landingSpot(b.x, b.z, 90) || (() => { const d = nearestDock(b.x, b.z); return { x: d.x, z: d.z }; })();
  for (const o of boatOccupants(b)) { unseat(o); placeAt(o, spot.x, spot.z); toast(o, 'The boat went down. You swam for the bank.'); }
  // Bulk freight goes down with her; everything else washes up on the bank.
  const items = b.items.filter((i) => !i.bulk);
  if (items.length || RESOURCES.some((r) => b[r])) dropBag(spot.x, spot.z, items, Object.fromEntries(RESOURCES.map((r) => [r, b[r] || 0])), `Wreck of ${boatName(b)}`);
  db.boats = db.boats.filter((x) => x !== b);
  boatRt.delete(b.id);
  if (b.owner) warnTeam(b.owner, `⚠ Your ${BOATS[b.type].name.toLowerCase()} was sunk${by ? ` by ${by.name}` : ''}`, b.x, b.z, 'Boat sunk');
  feed(by ? `${by.name} sank ${boatName(b)}` : `${boatName(b)} sank`);
  if (by && !by.isBot && b.owner !== by.token) award(by, 150, 'Sank a boat', true);
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
    if (!canUseBoat(p, b) || !mooredAt(b, d)) continue;
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
  const here = db.boats.filter((b) => canUseBoat(p, b) && mooredAt(b, d));
  return {
    t: 'dock', id: d.id, name: d.name, camp: d.campId != null ? map.camps[d.campId].name : null, cash: p.cash || 0,
    shop: Object.entries(BOATS).map(([k, v]) => ({ type: k, name: v.name, price: v.price, craft: v.craft || null, about: v._about, seats: v.seats, hold: v.hold })),
    boats: here.map((b) => ({ id: b.id, name: BOATS[b.type].name, hp: Math.round(b.hp), max: BOATS[b.type].hp, repair: Math.ceil((BOATS[b.type].hp - b.hp) * RV.rules.repairPerHp), free: BOATS[b.type].hold - b.items.length,
      cargo: b.items.filter((i) => i.bulk).map((i) => ({ name: i.name, dest: i.destName })) })),
    freight: dockJobs(d), owned: db.boats.filter((b) => b.owner === p.token).length, maxOwned: RV.rules.maxBoatsEach,
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
    if (!def) return;
    if (db.boats.filter((b) => b.owner === p.token).length >= RV.rules.maxBoatsEach) return toast(p, `You can own ${RV.rules.maxBoatsEach} boats at a time`);
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
    const boats = db.boats.filter((b) => canUseBoat(p, b) && mooredAt(b, d) && b.items.length < BOATS[b.type].hold).sort((a, b) => (b.id === p.boat) - (a.id === p.boat));
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
    else logAway(st.owner, `${p.name} bought ${qty} ${HOMESTEAD.goods[l.res]?.name || l.res} at your stall for $${cost}`);
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
function tickDefenses(now) {
  for (const st of structs.values()) {
    const kind = PIECES[st.type].defense;
    if (!kind) continue;
    if (kind === 'tripwire') {
      if ((st.rearmAt || 0) > now) continue;
      const b = structBox(st);
      const hit = hostilesNear(st, 4).find((c) => c.x > b.minX - 0.45 && c.x < b.maxX + 0.45 && c.z > b.minZ - 0.45 && c.z < b.maxZ + 0.45);
      if (!hit) continue;
      st.rearmAt = now + DEF.tripwire.rearmMs;
      stun(hit, DEF.tripwire.stunMs, null);
      if (!hit.isBot) { exposeToTeam(hit, st.owner, DEF.tripwire.exposeMs); toast(hit, '⚡ You tripped a wire!'); }
      warnTeam(st.owner, `⚠ ${hit.name} tripped your wire`, st.x, st.z, 'Tripwire');
    } else if (kind === 'alarm') {
      if ((st.alarmAt || 0) > now) continue;
      const hit = hostilesNear(st, DEF.alarm.radius).find((c) => c.isBot || !camoActive(c));
      if (!hit) continue;
      st.alarmAt = now + DEF.alarm.cooldownMs;
      if (!hit.isBot) exposeToTeam(hit, st.owner, DEF.alarm.exposeMs);
      warnTeam(st.owner, `⚠ Motion alarm: ${hit.name} at your camp`, st.x, st.z, 'Motion alarm');
    } else if (kind === 'sentry') {
      if (!(st.ammo > 0) || (st.nextShot || 0) > now) continue;
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
  sensors.push({ x, z, until: now + SENSOR.duration, key: squadKey(p), owner: p, radius });
  sendSquad(p, { t: 'sensor', x, z, until: now + SENSOR.duration, radius });
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
  const view = npcTradeView(b);
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
const STUN = GADGET_DATA.stun, TAKEDOWN = GADGET_DATA.takedown, DATAHACK = GADGET_DATA.dataHack;
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
  stunBlasts.push({ x, z, y: terrain.height(x, z) + 0.4, at: now + STUN.fuseMs, owner: p });
  for (const o of players.values()) if (Math.abs(o.x - x) < INTEREST && Math.abs(o.z - z) < INTEREST) send(o.ws, { t: 'stunThrow', x, z, from: [p.x, gy(p) + 1.5, p.z], at: now + STUN.fuseMs });
  dirty(p);
}
function tickStuns(now) {
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
  if (kind === 'rebuild' || kind === 'selfrevive' || kind === 'harvest' || kind === 'upgrade' || kind === 'raid' || kind === 'gatehack' || kind === 'claim' || kind === 'revive' || kind === 'claimBuilding' || kind === 'datahack' || kind === 'cook' || kind === 'fish' || kind === 'hotwire') {
    const ms = extra.ms ? extra.ms : kind === 'rebuild' ? RAIDS.ruin.rebuildMs : kind === 'selfrevive' ? DOWNED.selfReviveMs : kind === 'hotwire' ? RV.rules.hotwireMs : kind === 'cook' ? HOMESTEAD.cooking.ms : kind === 'fish' ? HOMESTEAD.fishing.ms : kind === 'datahack' ? DATAHACK.ms : kind === 'revive' ? DOWNED.reviveMs : kind === 'claim' || kind === 'claimBuilding' ? CLAIM.plantMs : kind === 'harvest' ? BUILD.harvest.channelMs : kind === 'upgrade' ? BUILD.upgradeMs : BUILD.raid[extra.tool].ms;
    p.hack = { kind, id, start: now, until: now + ms, total: ms, x: p.x, z: p.z, ...extra };
    send(p.ws, { t: 'hack', kind, until: p.hack.until, total: ms });
    if (kind === 'datahack') toast(p, 'Hacking shows your position to enemies nearby — have your crew cover you.');
    if (kind === 'raid' || kind === 'gatehack') {
      const st = structs.get(id);
      const team = st ? teamOfToken(st.owner) : [];
      if (team.length && (!st.raidAlert || now - st.raidAlert > 20_000)) { st.raidAlert = now; for (const o of team) { toast(o, `⚠ ${p.name} is breaking into your base!`); send(o.ws, { t: 'alert', x: st.x, z: st.z, text: 'Base under attack' }); } }
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
    if (Math.hypot(p.x - h.x, p.z - h.z) > 0.6) { cancelHack(p, 'Interrupted — you moved'); continue; }
    if ((p.lastHit || 0) > h.start) { cancelHack(p, 'Interrupted — taking fire'); continue; }
    if (now < h.until) continue;
    p.hack = null;
    if (h.kind === 'claim') { finishClaim(p, h.id); continue; }
    if (h.kind === 'claimBuilding') { finishClaimBuilding(p, h.id); continue; }
    if (h.kind === 'datahack') { finishDataHack(p, h.id); continue; }
    if (h.kind === 'cook') { finishCook(p); continue; }
    if (h.kind === 'fish') { finishFishing(p); continue; }
    if (h.kind === 'hotwire') { finishHotwire(p, h.id); continue; }
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
      if (hv.uses >= BUILD.harvest.uses) hv.regrowAt = now + BUILD.harvest.regrowMs;
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
  toast(p, soloRevive(p) ? 'You\'re down! Press E / Ⓐ to patch yourself up with a medkit, or crawl to cover. Q / Ⓨ to give up.' : 'You\'re down! Crawl to cover — a crewmate can revive you. Q / Ⓨ to give up.');
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
  if (target.npc && target.kind === 'trader') return;   // river traders are left alone by everyone
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
function killPlayer(p, attacker, headshotKill) {
  if (p.boat) unseat(p);
  p.dead = true;
  Object.assign(p, { downed: false, downedUntil: 0, bleedHp: 0, downedBy: null });
  const { primary, secondary, armor, pack } = p.inv;
  const keepIntel = hasField(p, 'pouch') ? Math.min(3, p.intel) : 0;
  // Your claim marker and tools stay with you: losing them would leave you unable to start again.
  const keep = pack.filter((i) => i && (i.kind === 'marker' || i.kind === 'tool'));
  dropBag(p.x, p.z, [primary, secondary, armor, ...pack.filter((i) => !keep.includes(i))], { ...Object.fromEntries(RESOURCES.map((r) => [r, p[r]])), intel: p.intel - keepIntel }, `${p.name}'s bag`);
  p.inv = { primary: null, secondary: null, armor: null, pack: keep };
  p.mags = {}; p.armor = 0; p.camoOn = false;
  for (const r of RESOURCES) p[r] = 0;
  p.intel = keepIntel;
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
  const gear = [makeWeapon(b.arche || 'carbine'), ...(b.kind === 'hvt' ? [makeArmor('medium')] : []), ...(b.serial % 3 === 0 ? [makeConsumable('medkit')] : [])];
  dropBag(b.x, b.z, gear, res, b.kind === 'hvt' ? 'Lieutenant\'s body' : 'Rogue\'s body');
  markAssist(b, attacker);
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    award(attacker, (b.kind === 'hvt' ? 300 : XP.rogueKill) + (headshotKill ? XP.headshotKill : 0), b.kind === 'hvt' ? 'Lieutenant down' : 'Rogue down', true);
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
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.x - ex, -0.3, b.z - ez, b.x + ex, 0.8, b.z + ez);
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
  const ox = shooter.x, oy = gy(shooter) + eye, oz = shooter.z;
  // The shot goes from your eye to the point under your crosshair, so it lands where you aimed even
  // if the server's copy of you is a step behind where your screen has you.
  if (opts.at) { const ax = opts.at[0] - ox, ay = opts.at[1] - oy, az = opts.at[2] - oz, al = Math.hypot(ax, ay, az); if (al > 0.5 && al < 2000) dir = [ax, ay, az]; }
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const base = [dir[0] / len, dir[1] / len, dir[2] / len];
  const moving = !isBot && shooter.speed > 0.5;
  const baseSpread = isBot ? s.hipSpread * 0.6 : shooter.aiming ? s.adsSpread : s.hipSpread;
  const spreadMul = (moving ? 1.6 : 1) * (shooter.prone ? 0.6 : shooter.crouch ? 0.8 * s.crouchSpread : 1) / botAccuracy;
  const seen = !isBot && opts.tid ? (players.get(opts.tid) || bots.get(opts.tid)) : null;   // who was under their crosshair
  const tracers = [];
  for (let i = 0; i < s.pellets; i++) {
    const sp = baseSpread * spreadMul;
    let dx = base[0] + (Math.random() - 0.5) * 2 * sp, dy = base[1] + (Math.random() - 0.5) * 2 * sp, dz = base[2] + (Math.random() - 0.5) * 2 * sp;
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
    tracers.push([+(ox + dx * t).toFixed(2), +(oy + dy * t).toFixed(2), +(oz + dz * t).toFixed(2), hit.kind ? 1 : 0]);
    if (!hit.kind || hit.kind === 'world') continue;
    const F = COMBAT.falloff;
    const falloff = t <= s.range ? 1 : Math.max(F.minMul, 1 - (t - s.range) / (s.range * F.overRangeSpan) * F.maxDrop);
    let dmg = s.damage * falloff;
    if (hit.headshot) dmg *= COMBAT.headshotMul;
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
  if (!isBot) { breakCamo(shooter, 2000); shooter.protectedUntil = 0; }
  const msg = JSON.stringify({ t: 'shot', from: shooter.id, sup: s.suppressed ? (s.subsonic ? 2 : 1) : 0, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], hits: tracers });
  for (const p of players.values()) if (p.ws.readyState === 1 && Math.abs(p.x - ox) < INTEREST && Math.abs(p.z - oz) < INTEREST) p.ws.send(msg);
}
function notifyOwner(houseId, text) { notifyStore(db.houses[houseId], text); }

// ---------------------------------------------------------------- AI ("Rogues")
let botSerial = 0;
const BOT_WEAPONS = COMBAT.bots.weapons;
function spawnBot(x, z, kind = 'ambient', extra = {}) {
  const def = kind === 'hvt' ? COMBAT.bots.hvt : COMBAT.bots.rogue;
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
    for (let tries = 0; tries < 25; tries++) {
      const sp = map.lootSpawns[Math.floor(Math.random() * map.lootSpawns.length)];
      const d = Math.hypot(sp.x - p.x, sp.z - p.z);
      if (d < 110 || d > 280) continue;
      if (alive.some((o) => Math.hypot(o.x - sp.x, o.z - sp.z) < 90)) continue;
      spawnBot(sp.x + 2, sp.z + 2);
      break;
    }
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
    let best = null, bestD = (b.kind === 'hvt' ? COMBAT.bots.hvt : COMBAT.bots.rogue).sightRange;
    for (const p of alive) {
      if (p.downed) continue;   // rogues move on to whoever is still fighting
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d >= bestD) continue;
      if (camoActive(p) && d > 6) continue;
      if ((p.protectedUntil || 0) > now) continue;
      if (lineOfSight(b.x, gy(b) + STAND_EYE, b.z, p.x, gy(p) + (p.crouch ? 0.9 : 1.3), p.z)) { best = p; bestD = d; }
    }
    let mx = 0, mz = 0;
    if (best) {
      b.yaw = Math.atan2(best.x - b.x, best.z - b.z);
      if (bestD > 14) { mx = Math.sin(b.yaw); mz = Math.cos(b.yaw); }
      if (now >= b.nextShot) {
        const dir = [best.x - b.x, gy(best) + (best.crouch ? 0.8 : 1.2) - gy(b) - STAND_EYE, best.z - b.z];
        fire(b, dir, true, Math.max(0.35, 1.2 - bestD / 30));
        b.burst = (b.burst + 1) % 5;
        b.nextShot = now + (b.burst === 0 ? 1400 : 60_000 / b.weapon.rpm * 1.3);
      }
    } else {
      const leash = b.kind === 'ambient' ? 30 : 12;
      if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1 || Math.random() < 0.003) {
        b.wander = { x: b.homeX + (Math.random() - 0.5) * leash, z: b.homeZ + (Math.random() - 0.5) * leash };
      }
      b.yaw = Math.atan2(b.wander.x - b.x, b.wander.z - b.z);
      mx = Math.sin(b.yaw) * 0.45; mz = Math.cos(b.yaw) * 0.45;
    }
    const np = moveWithCollision(b.x, b.z, mx * 3.2 * dt, mz * 3.2 * dt, PLAYER_RADIUS, solidsNear(b.x, b.z, 3), terrain);
    if (Math.hypot(np.x - b.x, np.z - b.z) < 0.001 && (mx || mz)) b.wander = null;
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
  feed('📦 Supply drop inbound — marked on the map');
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
  const cap = homePerks(myClaim ? homeLevel(myClaim.store.hxp) : 1).buildCap;
  const mine = [...structs.values()].filter((o) => o.owner === p.token).length;
  if (mine >= cap) return toast(p, `Build limit reached (${cap}) — level up your home for more`);
  const problem = placementProblem(buildWorld, msg.piece, x, z, rot, p);
  if (problem) return toast(p, problem);
  const stage0 = def.stages[0];
  if (!payCarried(p, stage0.cost)) return toast(p, `Needs ${costText(stage0.cost)} (carried)`);
  const b = pieceBox(msg.piece, x, z, rot);
  const y0 = Math.min(...[[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]].map(([a, c]) => terrain.height(a, c))) - 0.15;
  const st = { id: 's' + crypto.randomBytes(5).toString('hex'), type: msg.piece, x, z, rot, y0, stage: 0, hp: stage0.hp, owner: p.token, ownerName: p.name, open: false };
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
  const owner = onlineByToken(st.owner);
  if (owner && by !== owner && (!st.alertedAt || Date.now() - st.alertedAt > 20_000)) { st.alertedAt = Date.now(); toast(owner, `⚠ Your ${stageDef(st).name.toLowerCase()} is under attack${by ? ` by ${by.name}` : ''}!`); }
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

function explode(c, now) {
  charges.delete(c.id);
  const k = BUILD.charge;
  const by = onlineByToken(c.owner);
  const msg = JSON.stringify({ t: 'boom', x: c.x, y: c.y + 0.5, z: c.z });
  for (const p of players.values()) if (p.ws.readyState === 1 && Math.abs(p.x - c.x) < INTEREST && Math.abs(p.z - c.z) < INTEREST) p.ws.send(msg);
  for (const st of structsNear(c.x, c.z, k.radius + 3)) {
    const d = boxDist(structBox(st), c.x, c.z);
    if (d <= k.radius) damageStruct(st, k.damage * (1 - d / (k.radius * 1.5)), by);
  }
  for (const h of map.houses) {
    const d = boxDist(h.door, c.x, c.z);
    if (d > k.radius) continue;
    damageHouseDoor(h.id, k.damage * (1 - d / (k.radius * 1.5)), by || { name: c.ownerName, isBot: true }, 'blew open');
  }
  for (const t of [...players.values(), ...bots.values()]) {
    if (t.dead) continue;
    const d = Math.hypot(t.x - c.x, t.z - c.z);
    if (d < k.playerRadius) applyDamage(t, k.playerDamage * (1 - d / k.playerRadius), by, !!t.isBot);
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
  if (!it) {
    if (map.landingZones.some((l) => Math.hypot(l.x - p.x, l.z - p.z) < EXTRACT.callRange)) return callExtraction(p);
    const b = buildingAt(p.x, p.z);
    if (b >= 0) return startClaimBuilding(p, b);
    if (nearWater(p.x, p.z)) {
      if (!hasTool(p, 'rod')) return toast(p, 'You need a fishing rod (trading posts sell them; craft one at your stash)');
      return startHack(p, 'fish', 0);
    }
    return;
  }
  if (it.kind === 'terminal') return startHack(p, 'terminal', it.ref.id);
  if (it.kind === 'drop') return startHack(p, 'drop', it.ref.id);
  if (it.kind === 'crate') return startHack(p, 'crate', it.ref.id);
  if (it.kind === 'harvest') {
    const tool = it.res === 'wood' ? 'hatchet' : 'pickaxe';
    // No tool for the tree or rock, but a rod at the water's edge: fish instead.
    if (!hasTool(p, tool) && hasTool(p, 'rod') && nearWater(p.x, p.z)) return startHack(p, 'fish', 0);
    if (!hasTool(p, tool)) return toast(p, `You need a ${tool} to gather ${it.res}`);
    const hv = harvested.get(it.ref.id);
    if (hv && hv.uses >= BUILD.harvest.uses && hv.regrowAt > Date.now()) return toast(p, 'Nothing left here — it regrows in a while');
    return startHack(p, 'harvest', it.ref.id, { res: it.res });
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
    if (!addToPack(p, it.ref.item)) return toast(p, 'Backpack full');
    loot.delete(it.ref.id);
    lootAtSpawn.delete(it.ref.spawnIndex);
    spawnReadyAt.set(it.ref.spawnIndex, Date.now() + LOOT_RESPAWN_MS);
    award(p, XP.pickup, it.ref.item.name);
    dirty(p);
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
    if (store.items.length >= (kind === 'crate' && PIECES[store.type].claim ? claimCap({ kind: 'flag', store }) : cap)) return toast(p, kind === 'boat' ? 'The hold is full' : kind === 'stash' ? 'Stash full — upgrade storage or level up your home' : 'Crate full — reinforce it for more room');
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
  for (const slot of ['primary', 'secondary']) if (inv[slot]?.id === itemId) return inv[slot];
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
  if (!atOwnStash(p)) return toast(p, 'The gunsmith bench is at your stash house');
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
    const item = isArmor ? makeArmor(msg.type) : makeWeapon(msg.type);
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
    if (was && was !== rs.mode && was !== 'home' && rs.mode !== 'home') logAway(h.owner, rs.mode === 'window' ? `Your raid window opened (${windowText(rs.start)}): your base can be raided, at reduced damage, while you're all away` : 'Your raid window closed: your base is sealed again');
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
    else if (item.kind === 'weapon') slot = item.archetype === 'sidearm' ? 'secondary' : 'primary';
    else return;
    inv.pack.splice(idx, 1);
    if (inv[slot]) inv.pack.push(inv[slot]);
    inv[slot] = item;
    if (slot !== 'armor') p.active = slot;
    p.armor = Math.min(p.armor, maxArmor(p));
  } else if (msg.action === 'unequip') {
    const slot = msg.slot;
    if (!['primary', 'secondary', 'armor'].includes(slot) || !inv[slot]) return;
    if (inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
    inv.pack.push(inv[slot]);
    inv[slot] = null;
    p.armor = Math.min(p.armor, maxArmor(p));
  } else if (msg.action === 'drop') {
    const idx = inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0) return;
    dropBag(p.x, p.z, [inv.pack.splice(idx, 1)[0]], {}, `${p.name}'s drop`);
  } else if (msg.action === 'eat') {
    return eat(p, msg.good);
  } else if (msg.action === 'use') {
    // H: patch up if you're hurt and have a medkit, otherwise eat.
    const idx = inv.pack.findIndex((i) => i.kind === 'medkit');
    const hurt = p.hp < maxHp(p) || p.armor < maxArmor(p);
    if (idx < 0 || !hurt) return eat(p);
    if (p.hp >= maxHp(p) && p.armor >= maxArmor(p)) return;
    inv.pack.splice(idx, 1);
    p.hp = Math.min(maxHp(p), p.hp + COMBAT.medkitHeal);
    p.armor = Math.min(maxArmor(p), p.armor + 40);
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
function deployOptions(p) {
  const own = claimOf(p)?.kind === 'home' ? claimOf(p).id : null;
  const c = claimOf(p);
  return {
    houseId: own,
    claim: c ? { kind: c.kind, id: c.id, x: c.x, z: c.z, name: claimName(c) } : null,
    towns: p.deploying ? map.contacts.map((ct) => ct.id) : [],
    contacts: p.discovered,
    lzs: map.landingZones.map((l) => l.id),
    crew: squadMembersOnline(p).filter((m) => m !== p && !m.dead && !m.downed && !m.deploying).map((m) => ({ id: m.id, name: m.name, x: Math.round(m.x), z: Math.round(m.z) })),
    crates: [...structs.values()].filter((st) => st.owner === p.token && PIECES[st.type].container).map((st) => ({ id: st.id, x: st.x, z: st.z })),
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
  let at = null;
  if (msg.kind === 'claim') {
    return toast(p, 'Deploy first, then plant your claim marker where you want your stash house');
  } else if (msg.kind === 'house' || msg.kind === 'home') {
    if (!claim) return;
    at = homeSpot(claim);
  } else if (msg.kind === 'contact') {
    // First deploy: any town. After that: Contacts you've discovered.
    if (!p.discovered.includes(msg.id) && !p.deploying) return;
    const ct = nth(map.contacts, msg.id);
    if (!ct) return;
    at = { x: ct.x + 3, z: ct.z + 3 };
  } else if (msg.kind === 'crate') {
    const st = structs.get(msg.id);
    if (!st || st.owner !== p.token || !PIECES[st.type].container) return;
    at = { x: st.x, z: st.z + 1.4 };
  } else if (msg.kind === 'lz') {
    at = nth(map.landingZones, msg.id);
    if (!at) return;
  } else if (msg.kind === 'crew') {
    // Drop in next to a crewmate (not while they're in a firefight).
    const m = players.get(msg.id);
    if (!m || !sameSquad(m, p) || m === p || m.dead || m.downed || m.deploying) return toast(p, 'They can\'t take you right now');
    if (Date.now() - (m.lastHit || 0) < 10_000) return toast(p, `${m.name} is in a fight — try again in a moment`);
    at = { x: m.x + 1.5, z: m.z + 1.5 };
  } else return;
  if (!p.deploying) {
    const keepIntel = p.intel;
    Object.assign(p, { hp: 100, armor: 0, ...starterLoadout(), food: HOMESTEAD.hunger.start });
    p.intel = keepIntel;
  }
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
  if (msg.kind === 'contact') {
    if (!p.discovered.includes(msg.id)) return toast(p, 'Discover that Contact on foot first');
    const c = nth(map.contacts, msg.id);
    placeAt(p, c.x + 3, c.z + 3);
  } else if (msg.kind === 'squad') {
    const m = players.get(msg.id);
    if (!m || !sameSquad(p, m) || m === p || m.dead) return;
    if (Date.now() - (m.lastHit || 0) < 10_000) return toast(p, `${m.name} is in combat`);
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
const extractions = new Map();   // id -> { id, x, z, site, owner, ownerName, arrivesAt }
function extractList() { return [...extractions.values()].map((e) => ({ id: e.id, x: e.x, z: e.z, site: e.site, by: e.ownerName, arrivesAt: e.arrivesAt })); }
function sendEvents(extra = {}) { broadcast({ t: 'events', drops: dropList(), extracts: extractList(), ...extra }); }
/** The Contact or landing zone the player is standing at, if any. */
function extractSite(p) {
  let best = null, bd = EXTRACT.callRange;
  for (const c of map.contacts) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = { x: c.x, z: c.z, name: c.name.replace(/ Contact$/, '') }; } }
  for (const l of map.landingZones) { const d = Math.hypot(l.x - p.x, l.z - p.z); if (d < bd) { bd = d; best = { x: l.x, z: l.z, name: l.name }; } }
  return best;
}
function homeSpot(c) { return c.store.spawn ? { ...c.store.spawn } : c.kind === 'flag' ? { x: c.x, z: c.z + 1.6 } : { x: c.x, z: c.z + 1.2 }; }
function callExtraction(p) {
  if (p.dead) return;
  const now = Date.now();
  const site = extractSite(p);
  if (!site) return toast(p, `Call extraction within ${feet(EXTRACT.callRange)} of a Contact or landing zone`);
  if (hasCargo(p)) return toast(p, 'The helicopter won\'t carry freight — deliver it by land (or river)');
  if (!claimOf(p)) return toast(p, 'You need a stash house for the helicopter to fly you to — plant a claim marker first');
  for (const e of extractions.values()) {
    if (e.owner === p.token || (Math.hypot(e.x - site.x, e.z - site.z) < EXTRACT.radius * 2 && tokenInSquadWith(p, e.owner))) return toast(p, `Extraction already inbound — ${Math.ceil((e.arrivesAt - now) / 1000)}s. Hold the zone.`);
    if (Math.hypot(e.x - site.x, e.z - site.z) < EXTRACT.radius * 2) return toast(p, `${e.ownerName} already has a flare up here`);
  }
  if ((p.extractReadyAt || 0) > now) return toast(p, `Pilot unavailable — try again in ${Math.ceil((p.extractReadyAt - now) / 1000)}s`);
  const id = uid('x');
  extractions.set(id, { id, x: site.x, z: site.z, site: site.name, owner: p.token, ownerName: p.name, arrivesAt: now + EXTRACT_HOLD_MS });
  toast(p, `🔴 Flare up at ${site.name}. Helicopter in ${Math.round(EXTRACT_HOLD_MS / 1000)}s — stay within ${feet(EXTRACT.radius)} of the flare. Squadmates in the zone ride along.`);
  for (const o of players.values()) {
    if (o === p || o.dead) continue;
    const d = Math.hypot(o.x - site.x, o.z - site.z);
    if (sameSquad(o, p)) toast(o, `${p.name} called extraction at ${site.name} (${distText(d)} away)`);
    else if (d < EXTRACT.alertRange) { toast(o, `🔴 Extraction flare at ${site.name}, ${distText(d)} away — someone is flying loot out`); send(o.ws, { t: 'alert', x: site.x, z: site.z, text: 'Extraction flare' }); }
  }
  sendEvents();
}
function tickExtractions(now) {
  for (const e of [...extractions.values()]) {
    const caller = onlineByToken(e.owner);
    const inZone = (o) => o && !o.dead && Math.hypot(o.x - e.x, o.z - e.z) <= EXTRACT.radius;
    if (!inZone(caller) || caller.downed) {
      extractions.delete(e.id);
      if (caller) { caller.extractReadyAt = now + EXTRACT.cooldownMs; toast(caller, caller.dead || caller.downed ? 'Extraction aborted — you went down' : 'Extraction aborted — you left the pickup zone'); }
      sendEvents();
      continue;
    }
    if (now < e.arrivesAt) continue;
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
    t: 'welcome', id: p.id, token, world: WORLD_ID, worldName: WORLD_NAME, seed: SEED, size: WORLD_SIZE, mapSum: MAP_SUM, real: REAL_INFO, houseId: p.houseId,
    x: p.x, z: p.z, yaw: p.yaw, packSize: PACK_SIZE, doorBase: DOOR_HP,
    deploy: p.dead ? deployOptions(p) : null, firstDeploy: p.deploying,
  });
  send(ws, { t: 'events', drops: dropList(), extracts: extractList() });
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
  let dx = tx - p.x, dz = tz - p.z;
  const hungry = (p.food ?? 100) < HUNGER.noSprintBelow;
  p.prone = !!msg.prone && !p.downed;
  const maxStep = isStunned(p, now) ? 0.05 : p.prone ? PRONE_SPEED * dt * 1.5 + 0.15 : hungry && !p.downed ? 4.8 * dt * 1.5 + 0.15 : (p.downed ? DOWNED.crawlSpeed : SPRINT_SPEED) * dt * 1.5 + 0.15;
  const d = Math.hypot(dx, dz);
  if (d > maxStep) { dx *= maxStep / d; dz *= maxStep / d; }
  const np = moveWithCollision(p.x, p.z, dx, dz, PLAYER_RADIUS, solidsNear(p.x, p.z, maxStep + 2), terrain);
  p.speed = dt > 0 ? Math.hypot(np.x - p.x, np.z - p.z) / dt : 0;
  if (p.speed > 0.5) p.lastActive = now;
  p.x = np.x; p.z = np.z;
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.crouch = (!!msg.crouch && !p.prone) || !!p.downed;
  p.aiming = !!msg.aim;
  if (p.camoOn && msg.sprint) breakCamo(p, 500);
  if (Math.hypot(p.x - tx, p.z - tz) > 0.5) send(p.ws, { t: 'correct', x: p.x, z: p.z });
  if (p.openContainer && !nearContainer(p, p.openContainer.kind, p.openContainer.id)) { p.openContainer = null; send(p.ws, { t: 'container', closed: true }); }
}
function handleShoot(p, msg) {
  if (p.dead) return;
  const w = activeWeapon(p);
  if (!w) return;
  const s = stats(p);
  const now = Date.now();
  if (now < p.reloadUntil) return;
  if (now - p.lastShot < (60_000 / s.rpm) * 0.85) return;
  const mag = p.mags[w.id] ?? 0;
  if (mag <= 0) return;
  if (!Array.isArray(msg.dir) || msg.dir.length !== 3 || !msg.dir.every(Number.isFinite)) return;
  p.lastShot = now;
  p.mags[w.id] = mag - 1;
  const at = Array.isArray(msg.at) && msg.at.length === 3 && msg.at.every(Number.isFinite) ? msg.at : null;
  fire(p, msg.dir, false, 1, { at, tid: typeof msg.tid === 'string' ? msg.tid : null });
  dirty(p);
}
function handleReload(p) {
  const w = activeWeapon(p);
  if (!w || p.dead) return;
  const s = stats(p);
  const need = s.mag - (p.mags[w.id] ?? 0);
  if (need <= 0 || p.ammo <= 0 || p.reloadUntil > Date.now()) return;
  p.reloadUntil = Date.now() + s.reloadMs;
  const take = Math.min(need, p.ammo);
  setTimeout(() => {
    if (p.dead || activeWeapon(p)?.id !== w.id) return;
    p.ammo -= take;
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
    switch (msg.t) {
      case 'state': return handleState(p, msg);
      case 'shoot': return handleShoot(p, msg);
      case 'reload': return handleReload(p);
      case 'swap': if (!p.dead && p.reloadUntil < Date.now()) { p.active = p.active === 'primary' ? 'secondary' : 'primary'; if (!p.inv[p.active]) p.active = p.active === 'primary' ? 'secondary' : 'primary'; dirty(p); } return;
      case 'interact': p.buildIntent = !!msg.build; return !p.dead && interact(p);
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
      case 'dock': return !p.dead && dockAction(p, msg);
      case 'squad': return squadAction(p, msg);
      case 'rally': return !p.dead && rally(p);
      case 'mark': return !p.dead && markTarget(p, msg);
      case 'sensor': return !p.dead && throwSensor(p, msg);
      case 'stun': return !p.dead && throwStun(p, msg);
      case 'camo':
        if (p.dead) return;
        if (level(p) < GADGETS.camo.level) return toast(p, `Optical camo unlocks at level ${GADGETS.camo.level}`);
        if (!p.camoOn && p.tech <= 0) return toast(p, 'No tech to power camo');
        p.camoOn = !p.camoOn; dirty(p); return;
      case 'leaderboard': return send(p.ws, leaderboard());
      case 'build': return !p.dead && handleBuild(p, msg);
      case 'dismantle': return !p.dead && dismantle(p, msg);
      case 'craft': return !p.dead && craft(p, msg);
      case 'dev':
        // Test-only helpers (teleport / die), never enabled unless the server is started with ALLOW_DEV=1.
        if (process.env.ALLOW_DEV !== '1') return;
        if (msg.kill) return !p.dead && killPlayer(p, null);
        if (Number.isFinite(msg.damage)) return applyDamage(p, msg.damage, null, false);
        if (msg.event) { const e = startEvent(msg.event); if (e && Number.isFinite(msg.x)) { e.x = msg.x; e.z = msg.z; } return; }
        if (msg.endEvent) { const e = [...worldEvents.values()].find((x) => x.type === msg.endEvent); if (e) endEvent(e, 'expired'); return; }
        if (msg.give && typeof msg.give === 'object') { for (const [k, v] of Object.entries(msg.give)) if (RESOURCES.includes(k) && Number.isFinite(v)) p[k] = (p[k] || 0) + v; dirty(p); return; }
        if (Number.isInteger(msg.boatTo) && p.boat && map.docks[msg.boatTo]) { const b = boatById(p.boat), d = map.docks[msg.boatTo]; b.x = d.wx; b.z = d.wz; placeOccupants(b); return send(p.ws, { t: 'boatFix', x: b.x, z: b.z, yaw: b.yaw }); }
        if (Number.isFinite(msg.boatDamage) && msg.boatId) { const b = boatById(msg.boatId); if (b) damageBoat(b, msg.boatDamage, p); return; }
        if (msg.killEventBots) { for (const b of [...bots.values()]) if (b.eventId && !b.dead && (!msg.only || b.kind === msg.only)) { applyDamage(b, 99999, p, true); } return; }
        if (Number.isFinite(msg.x) && Number.isFinite(msg.z)) placeAt(p, msg.x, msg.z);
        return;
    }
  }
  ws.on('close', () => {
    const p = ws.player;
    if (!p) return;
    if (p.boat) leaveBoat(p, true);   // nobody logs off in the middle of the river
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
      loot: [...loot.values()].filter((l) => near(l, 140)).map((l) => ({ id: l.id, x: l.x, z: l.z, kind: l.item.kind, name: l.item.name, amount: l.item.amount || 0 })),
      bags: db.bags.filter((b) => near(b, 200)).map((b) => ({ id: b.id, x: b.x, z: b.z, label: b.label })),
      houses: map.houses.filter((h) => near(h)).map((h) => { const s = db.houses[h.id]; const rs = s.owner && !livesAt(r, s) ? cachedRaidState(s) : null; return { id: h.id, hp: Math.round(s.doorHp), max: Math.round(doorMax(h.id)), open: s.doorOpen, owner: s.owner ? s.ownerName : null, upg: s.upg, hl: s.owner ? homeLevel(s.hxp) : 0, ...(rs ? { rs: RS_CODE[rs.mode], rw: rs.start } : {}) }; }),
      terminals: map.terminals.filter((t) => near(t)).map((t) => [t.id, (terminalReadyAt.get(t.id) || 0) <= now ? 1 : 0]),
      objectives: [...objectives.values()].filter((o) => near(o) && tokenInSquadWith(r, o.owner)).map((o) => ({ id: o.id, x: o.x, z: o.z })),
      structs: structsNear(r.x, r.z, INTEREST).map((st) => ({ id: st.id, type: st.type, x: st.x, z: st.z, rot: st.rot, y0: +st.y0.toFixed(2), stage: st.stage, hp: Math.round(st.hp), max: Math.round(PIECES[st.type].claim ? flagMax(st) : stageDef(st).hp), hl: PIECES[st.type].claim ? homeLevel(st.hxp) : undefined, open: !!st.open, owner: st.ownerName, mine: canManage(r, st) ? 1 : 0, ...structRaidView(r, st), ...(PIECES[st.type].defense && canManage(r, st) ? { ammo: st.ammo || 0, meat: st.meat || 0, fed: (st.fedUntil || 0) > now ? 1 : 0 } : {}), ...(st.type === 'plot' ? { crop: st.crop || null, grow: +cropState(st, now).grow.toFixed(2), rotten: cropState(st, now).phase === 'rotten' ? 1 : 0 } : {}) })),
    }).slice(1, -1) };
  }
  const fast = JSON.stringify({
    t: 'snap', players: 0,
    bots: [...bots.values()].filter((b) => !b.dead && near(b)).map((b) => ({ id: b.id, name: b.name, kind: b.kind, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), maxHp: b.maxHp, stun: isStunned(b, now) ? 1 : 0 })),
    boats: db.boats.filter((b) => near(b) || (BOATS[b.type].loud && rtOf(b).speed > 1 && Math.hypot(b.x - r.x, b.z - r.z) < BOATS[b.type].loud)).map((b) => ({ id: b.id, type: b.type, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), max: BOATS[b.type].hp, owner: b.ownerName, mine: canUseBoat(r, b) ? 1 : 0, seats: rtOf(b).seats, fast: rtOf(b).speed > 1 ? 1 : 0 })),
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
  updateBots(dt, now);
  tickHacks(now);
  if (tick % 5 === 0) { tickExtractions(now); tickDowned(now); }
  tickStuns(now);
  tickEvents(now, dt);
  if (tick % 4 === 0) tickDefenses(now);
  for (const c of [...charges.values()]) if (c.detAt <= now) explode(c, now);
  if (tick % 10 === 0) tickSensors(now);
  if (tick % TICK_HZ === 0) {
    manageAmbientBots();
    manageAnimals();
    keepMerchants(now);
    keepSettlers(now);
    keepTraders();
    scheduleDrop(now);
    for (const [id, d] of drops) if (d.expires < now) { drops.delete(id); sendEvents(); }
    for (const p of players.values()) {
      if (!camoActive(p)) continue;
      p.camoDrain = (p.camoDrain || 0) + (hasField(p, 'camoMk2') ? 0.25 : 0.5);
      if (p.camoDrain >= 1) { p.camoDrain -= 1; p.tech = Math.max(0, p.tech - 1); dirty(p); }
      if (p.tech <= 0) { p.camoOn = false; toast(p, 'Camo offline — out of tech'); }
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
      tickHunger(p, now);
      for (const c of [...p.contracts]) if (c.expires < now) { abandonContract(p, c.id); toast(p, `Contract expired: ${CONTRACT_TYPES[c.type].name}`); }
    }
    if (tick % (TICK_HZ * 5) === 0) for (const s of squads.values()) pushSquadState(s);   // squadmate positions for the map
  }
  if (tick % SNAPSHOT_EVERY === 0 && players.size) {
    const views = new Map([...players.values()].filter((p) => !p.deploying).map((p) => [p, {
      id: p.id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pitch: +(p.pitch || 0).toFixed(3),
      crouch: p.crouch, prone: p.prone ? 1 : 0, dead: p.dead, downed: p.downed ? 1 : 0, stun: isStunned(p, now) ? 1 : 0, hp: Math.round(p.hp), maxHp: maxHp(p), armor: Math.round(p.armor), maxArmor: maxArmor(p),
      level: level(p), sh: shielded(p) ? 1 : 0, camo: camoActive(p), hacking: !!p.hack, prot: (p.protectedUntil || 0) > now, boat: p.boat || null, seat: p.seat ?? null,
      gl: p.aiming && !p.dead && activeWeapon(p) && stats(p).glint ? 1 : 0,
      gun: activeWeapon(p) ? { a: activeWeapon(p).archetype, parts: activeWeapon(p).parts, paint: activeWeapon(p).paint } : null,
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
server.listen(PORT, () => console.log(`Deadzone server on ${TLS ? 'https' : 'http'}://localhost:${PORT}  (seed ${SEED}, ${(WORLD_SIZE / 1609.344).toFixed(1)} × ${(WORLD_SIZE / 1609.344).toFixed(1)} mi world at 1:1, ${map.towns.length} towns, ${map.real.structures ? `${map.real.structures} real buildings, ` : ''}${map.real.roads ? `${map.real.roads} real roads, ` : ''}${map.houses.length} stash houses, ${map.contacts.length} contacts)`));
