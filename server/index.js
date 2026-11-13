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
import {
  SpatialGrid, generateMap, mapChecksum, moveWithCollision, HOME_KINDS, VEHICLE_TYPES, resolveCircle, rayAgainstBoxes, rayBox, characterBounds,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, SPRINT_SPEED, INTERACT_RANGE, DEFAULT_WORLD_SIZE,
} from '../shared/world.js';
import {
  makeWeapon, makeArmor, makeConsumable, weaponStats, armorStats, worldSupply, partFits, isUnlocked,
  levelFromXp, unlocksAt, XP, ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS, GADGETS, FIELD_PERKS,
  UPGRADES, CONTRACT_TYPES, SUPPLY_DROP_CONTENTS, TERMINAL_REWARD, TERMINAL_COOLDOWN_MS,
} from '../shared/items.js';
import { PIECES, BUILD, TOOLS, CRAFTS, pieceBox, investedCost, placementProblem } from '../shared/building.js';
import { CLAIM, HOME_XP, homeLevel, homePerks } from '../shared/claims.js';
import { EXTRACT } from '../shared/extraction.js';
import { distText, feet } from '../shared/units.js';
import COMBAT from '../shared/data/combat.json' with { type: 'json' };
import GADGET_DATA from '../shared/data/gadgets.json' with { type: 'json' };
import ACTIVITIES from '../shared/data/activities.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const SEED = Number(process.env.SEED || 1337);
const WORLD_SIZE = Number(process.env.WORLD_SIZE || DEFAULT_WORLD_SIZE);
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const TICK_HZ = 20;
const SNAPSHOT_EVERY = 2;              // 10 Hz
const INTEREST = 320;                  // metres: what each client is told about
const AMBIENT_BOTS = Number(process.env.BOTS ?? 5);   // roaming rogues kept around each active player
const BOT_ACTIVE_RANGE = 450;
const PACK_SIZE = COMBAT.packSize;
const DOOR_HP = Number(process.env.DOOR_HP || COMBAT.doorHp);
const LOOT_RESPAWN_MS = ACTIVITIES.loot.respawnMs;
const BAG_LIFETIME_MS = COMBAT.bagLifetimeMs;
const DB_VERSION = 8;
const SQUAD_MAX = COMBAT.crewMax;
const RESOURCES = ['ammo', 'parts', 'tech', 'intel', 'salvage', 'wood', 'stone'];   // carried; all drop on death, all stealable
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

// Optional real-world data (tools/import-real-data.mjs): every real building / road becomes a map object.
const REAL_DIR = process.env.REAL_DATA_DIR || path.join(ROOT, 'data', 'real');
const readReal = (name) => { try { return JSON.parse(fs.readFileSync(path.join(REAL_DIR, name), 'utf8')); } catch { return null; } };
const realFiles = process.env.REAL_DATA === '0' ? {} : { structures: readReal('structures.json'), roads: readReal('roads.json') };
const map = generateMap(SEED, WORLD_SIZE, { structures: realFiles.structures?.rows, roads: realFiles.roads?.rows });
// Clients fetch the same files so they generate the identical world.
const REAL_INFO = (realFiles.structures || realFiles.roads) ? { structures: !!realFiles.structures, roads: !!realFiles.roads } : null;
const grid = map.grid;
const terrain = map.terrain;
const gy = (c) => terrain.height(c.x, c.z);   // ground height under a character
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
db.crews ??= {};

function saveDb() {
  for (const p of players.values()) persistCharacter(p);
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
function structBox(s) { return { ...pieceBox(s.type, s.x, s.z, s.rot, s.y0), type: 'struct', structId: s.id }; }
/** Frames are walk-through scaffolding; open gates let you pass; charges aren't solid. */
function structIsSolid(s) { return stageDef(s).material !== 'frame' && !PIECES[s.type].explosive && !(PIECES[s.type].door && s.open); }
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
const makeTool = (tool) => ({ id: uid('t'), kind: 'tool', tool, name: TOOLS[tool].name });
function newCharacter(name) {
  const kit = starterLoadout();
  kit.inv.pack.push(makeTool('hammer'), makeTool('hatchet'), makeMarker());
  return {
    name, x: 0, z: 0, yaw: 0, hp: 100, armor: 0, ...kit, parts: 60, tech: 20, wood: 20, dead: false, kills: 0, xp: 0,
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
  return { kind: c.kind, id: c.id, name: claimName(c), x: c.x, z: c.z, level: lvl, xp: Math.floor(xp), perks: homePerks(lvl), crew: c.store.crew ? squads.get(c.store.crew)?.name || null : null };
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

const PERSIST = ['name', 'x', 'z', 'yaw', 'hp', 'armor', 'inv', 'ammo', 'mags', 'active', 'dead', 'kills', 'xp', 'parts', 'tech', 'intel', 'salvage', 'comms', 'field', 'discovered', 'contracts', 'needsDeploy'];
function persistCharacter(p) { db.characters[p.token] = Object.fromEntries(PERSIST.map((k) => [k, p[k]])); }

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
    downed: !!p.downed, downedUntil: p.downedUntil || 0, bleed: p.downed ? Math.max(0, Math.round(p.bleedHp)) : 0,
  };
}

// ---------------------------------------------------------------- claiming any building
// Plant a claim marker inside any enterable building: a stash locker goes in, and every doorway gets
// a lockable door. It then works like a claim flag (stash, gunsmith, upgrades, home level) and the
// doors can be shot, hacked, chopped or blown like gates.
const buildingGrid = new SpatialGrid(map.half + 4, 64);
map.buildings.forEach((b, i) => { b.idx = i; buildingGrid.insert(b); });
function buildingAt(x, z) {
  for (const b of buildingGrid.near(x, z, 1)) if (x > b.minX + 0.3 && x < b.maxX - 0.3 && z > b.minZ + 0.3 && z < b.maxZ - 0.3) return b.idx;
  return -1;
}
const BUILDING_NAMES = { building: 'Building', warehouse: 'Warehouse', farmhouse: 'Farmhouse', barn: 'Barn' };
function buildingLabel(idx) {
  const b = map.buildings[idx], cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const near = map.towns.reduce((a, t) => (!a || Math.hypot(t.x - cx, t.z - cz) < Math.hypot(a.x - cx, a.z - cz) ? t : a), null);
  const inTown = near && cx > near.rect.minX && cx < near.rect.maxX && cz > near.rect.minZ && cz < near.rect.maxZ;
  return `${BUILDING_NAMES[b.type] || 'Building'} ${inTown ? 'in' : 'near'} ${near ? near.name : 'the wilds'}`;
}
const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
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
    if (lb.minX < b.minX + 0.35 || lb.maxX > b.maxX - 0.35 || lb.minZ < b.minZ + 0.35 || lb.maxZ > b.maxZ - 0.35) return false;
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
  for (const d of b.doors) mk('door', d.x, d.z, d.out[0] === 0 ? 0 : 1, { claimOf: locker.id });
  placeAt(p, p.x, p.z);   // step out of the locker if it went in where you stood
  locker.spawn = { x: p.x, z: p.z };
  feed(`${p.name} claimed a ${lowerFirst(buildingLabel(idx))}`);
  send(p.ws, { t: 'hack', done: true, text: `Claimed! This ${lowerFirst(buildingLabel(idx))} is now your stash house: stash locker inside, ${b.doors.length} lockable door${b.doors.length > 1 ? 's' : ''}.` });
  send(p.ws, { t: 'claimed' });
  const s = squadOf(p);
  if (s) for (const m of crewOnline(s)) { if (m !== p) { toast(m, `${p.name} claimed a ${lowerFirst(buildingLabel(idx))} for ${s.name}`); send(m.ws, { t: 'claimed' }); } dirty(m); }
  dirty(p);
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
  const target = msg.id ? players.get(msg.id) : null;
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
  const now = Date.now();
  let src;
  if (kind === 'harvest' || kind === 'upgrade' || kind === 'raid' || kind === 'gatehack' || kind === 'claim' || kind === 'revive' || kind === 'claimBuilding') {
    const ms = kind === 'revive' ? DOWNED.reviveMs : kind === 'claim' || kind === 'claimBuilding' ? CLAIM.plantMs : kind === 'harvest' ? BUILD.harvest.channelMs : kind === 'upgrade' ? BUILD.upgradeMs : kind === 'gatehack' ? HACK_MS.door : BUILD.raid[extra.tool].ms;
    p.hack = { kind, id, start: now, until: now + ms, total: ms, x: p.x, z: p.z, ...extra };
    send(p.ws, { t: 'hack', kind, until: p.hack.until, total: ms });
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
    if (p.tech < GADGETS.doorHack.cost) return toast(p, `Lock bypass needs ${GADGETS.doorHack.cost} tech`);
    src = map.houses[id];
  } else if (kind === 'drop') {
    const d = drops.get(id);
    if (!d || d.landsAt > now) return toast(p, 'The drop hasn\'t landed yet');
    src = d;
  } else {
    src = objectives.get(id);
    if (!src || src.owner !== p.token) return toast(p, 'Not your contract');
  }
  p.hack = { kind, id, start: now, until: now + HACK_MS[kind], total: HACK_MS[kind], x: p.x, z: p.z };
  if (TEAM_HACK.exposes.includes(kind)) toast(p, 'Hacking shows your position to enemies nearby — have your crew cover you. Crewmates close by speed it up.');
  send(p.ws, { t: 'hack', kind, until: p.hack.until, total: HACK_MS[kind] });
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
    if (p.dead || p.downed) { cancelHack(p, 'You went down'); continue; }
    if (h.kind === 'revive') { const t = players.get(h.id); if (!t || !t.downed || t.dead) { cancelHack(p, 'Too late'); continue; } }
    if (Math.hypot(p.x - h.x, p.z - h.z) > 0.6) { cancelHack(p, 'Interrupted — you moved'); continue; }
    if ((p.lastHit || 0) > h.start) { cancelHack(p, 'Interrupted — taking fire'); continue; }
    if (now < h.until) continue;
    p.hack = null;
    if (h.kind === 'claim') { finishClaim(p, h.id); continue; }
    if (h.kind === 'claimBuilding') { finishClaimBuilding(p, h.id); continue; }
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
      send(p.ws, { t: 'hack', done: true, text: structs.has(st.id) ? `${stageDef(st).name}: ${Math.max(0, Math.round(st.hp))} HP left` : 'Broken through!' });
    } else if (h.kind === 'gatehack') {
      const st = structs.get(h.id);
      if (!st || p.tech < GADGETS.doorHack.cost) continue;
      p.tech -= GADGETS.doorHack.cost;
      st.open = true;
      award(p, XP.hackDoor, 'Gate lock bypassed', true);
      send(p.ws, { t: 'hack', done: true, text: 'Gate unlocked' });
    } else if (h.kind === 'terminal') {
      terminalReadyAt.set(h.id, now + TERMINAL_COOLDOWN_MS);
      p.intel += TERMINAL_REWARD.intel;
      p.tech += TERMINAL_REWARD.tech;
      award(p, XP.hackTerminal, 'Terminal hacked', true);
      send(p.ws, { t: 'hack', done: true, text: `+${TERMINAL_REWARD.intel} intel, +${TERMINAL_REWARD.tech} tech. Bank intel at your stash for XP.` });
      for (const c of [...p.contracts]) if (c.type === 'heist' && c.terminalId === h.id) completeContract(p, c);
    } else if (h.kind === 'door') {
      const house = db.houses[h.id];
      if (house.doorHp <= 0 || house.doorOpen) { send(p.ws, { t: 'hack', done: true, text: 'Door already open' }); continue; }
      p.tech -= GADGETS.doorHack.cost;
      house.doorOpen = true;
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
function canGoDown(p) { return squadMembersOnline(p).some((m) => m !== p && !m.dead && !m.downed); }
function goDown(p, attacker, headshot) {
  const now = Date.now();
  Object.assign(p, { downed: true, downedUntil: now + DOWNED.bleedOutMs, bleedHp: DOWNED.bleedHp, downedBy: attacker || null, downedHead: !!headshot, hp: 0, camoOn: false, crouch: true });
  cancelHack(p, 'You went down');
  p.openContainer = null;
  send(p.ws, { t: 'container', closed: true });
  feed(`${attacker ? attacker.name : 'The city'} downed ${p.name}`);
  for (const m of squadMembersOnline(p)) if (m !== p) { toast(m, `✚ ${p.name} is down — get to them and revive (E)`); send(m.ws, { t: 'alert', x: p.x, z: p.z, text: `${p.name} down` }); }
  toast(p, 'You\'re down! Crawl to cover — a crewmate can revive you. Q / Ⓨ to give up.');
  dirty(p);
}
function revive(p, by) {
  Object.assign(p, { downed: false, downedUntil: 0, bleedHp: 0, downedBy: null, hp: DOWNED.reviveHp });
  p.protectedUntil = 0;
  feed(`${by ? by.name : 'The medic'} revived ${p.name}`);
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
function applyDamage(target, amount, attacker, isBot, headshot = false) {
  if (target.dead) return;
  if (!isBot && (target.protectedUntil || 0) > Date.now()) return;
  if (!isBot && target.downed) {
    // Shooting someone who's down finishes them off.
    target.bleedHp -= amount;
    target.lastHit = Date.now();
    if (attacker) target.downedBy = attacker;
    if (target.bleedHp <= 0) killPlayer(target, attacker || target.downedBy, headshot || target.downedHead);
    dirty(target);
    return;
  }
  let dmg = amount;
  if (!isBot && target.armor > 0) { const absorbed = Math.min(target.armor, dmg); target.armor -= absorbed; dmg -= absorbed; }
  target.hp -= dmg;
  target.lastHit = Date.now();
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
  p.dead = true;
  Object.assign(p, { downed: false, downedUntil: 0, bleedHp: 0, downedBy: null });
  const { primary, secondary, armor, pack } = p.inv;
  const keepIntel = hasField(p, 'pouch') ? Math.min(3, p.intel) : 0;
  dropBag(p.x, p.z, [primary, secondary, armor, ...pack], { ...Object.fromEntries(RESOURCES.map((r) => [r, p[r]])), intel: p.intel - keepIntel }, `${p.name}'s bag`);
  p.inv = { primary: null, secondary: null, armor: null, pack: [] };
  p.mags = {}; p.armor = 0; p.camoOn = false;
  for (const r of RESOURCES) p[r] = 0;
  p.intel = keepIntel;
  cancelHack(p, 'You went down');
  markAssist(p, attacker);
  const by = attacker ? attacker.name : 'the city';
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    award(attacker, XP.playerKill + 20 * level(p) + (headshotKill ? XP.headshotKill : 0), `Killed ${p.name}`, true);
  }
  feed(`${by} ➜ ${p.name}`);
  send(p.ws, { t: 'died', by, deploy: deployOptions(p) });
  dirty(p);
}

function killBot(b, attacker, headshotKill) {
  b.dead = true;
  const res = b.kind === 'hvt' ? { ammo: 60, parts: 40, tech: 20, salvage: 30, intel: 2 } : { ammo: 30, parts: 15, tech: 5, salvage: 8, intel: b.serial % 2 };
  dropBag(b.x, b.z, b.serial % 3 === 0 ? [makeConsumable('medkit')] : [], res, b.kind === 'hvt' ? 'Lieutenant\'s cache' : 'Rogue cache');
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
    const b = structBox(s);
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, b.y0, b.minZ, b.maxX, b.y0 + b.h, b.maxZ);
    if (t < best) { best = t; target = s; kind = 'struct'; }
  }
  for (const h of map.houses) {
    if (Math.abs(h.x - ox) > range + 8 || Math.abs(h.z - oz) > range + 8) continue;
    const d = doorBox(h.id);
    if (!d) continue;
    const t = rayBox(ox, oy, oz, dx, dy, dz, d.minX, d.y0, d.minZ, d.maxX, d.y0 + d.h, d.maxZ);
    if (t < best) { best = t; target = h.id; kind = 'door'; }
  }
  const check = (c, k) => {
    if (c.dead || c.id === shooterId || Math.abs(c.x - ox) > best + 1 || Math.abs(c.z - oz) > best + 1) return;
    const b = characterBounds(c.x, c.z, c.crouch, gy(c));
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t < best) { best = t; target = c; kind = k; headshot = oy + dy * t > b.maxY - 0.3; }
  };
  for (const p of players.values()) check(p, 'player');
  for (const b of bots.values()) check(b, 'bot');
  return { t: best, target, kind, headshot };
}

function fire(shooter, dir, isBot = false, botAccuracy = 1) {
  const s = isBot ? shooter.weapon : stats(shooter);
  const eye = shooter.crouch ? CROUCH_EYE : STAND_EYE;
  const ox = shooter.x, oy = gy(shooter) + eye, oz = shooter.z;
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const base = [dir[0] / len, dir[1] / len, dir[2] / len];
  const moving = !isBot && shooter.speed > 0.5;
  const baseSpread = isBot ? s.hipSpread * 0.6 : shooter.aiming ? s.adsSpread : s.hipSpread;
  const spreadMul = (moving ? 1.6 : 1) * (shooter.crouch ? 0.8 * s.crouchSpread : 1) / botAccuracy;
  const tracers = [];
  for (let i = 0; i < s.pellets; i++) {
    const sp = baseSpread * spreadMul;
    let dx = base[0] + (Math.random() - 0.5) * 2 * sp, dy = base[1] + (Math.random() - 0.5) * 2 * sp, dz = base[2] + (Math.random() - 0.5) * 2 * sp;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const maxRange = s.range * 2.2;
    const hit = traceShot(ox, oy, oz, dx, dy, dz, maxRange, shooter.id);
    const t = Math.min(hit.t, maxRange);
    tracers.push([+(ox + dx * t).toFixed(2), +(oy + dy * t).toFixed(2), +(oz + dz * t).toFixed(2), hit.kind ? 1 : 0]);
    if (!hit.kind || hit.kind === 'world') continue;
    const F = COMBAT.falloff;
    const falloff = t <= s.range ? 1 : Math.max(F.minMul, 1 - (t - s.range) / (s.range * F.overRangeSpan) * F.maxDrop);
    let dmg = s.damage * falloff;
    if (hit.headshot) dmg *= COMBAT.headshotMul;
    if (!isBot && (shooter.buffUntil || 0) > Date.now()) dmg *= 1.2;
    if (hit.kind === 'player' && !isBot && sameSquad(shooter, hit.target)) continue;
    if (hit.kind === 'struct') {
      damageStruct(hit.target, dmg * (BUILD.bulletMul[stageDef(hit.target).material] ?? 0.1), isBot ? null : shooter);
      continue;
    }
    if (hit.kind === 'door') {
      const h = db.houses[hit.target];
      h.doorHp = Math.max(0, h.doorHp - dmg);
      h.lastDamaged = Date.now();
      if (h.doorHp === 0) {
        if (!isBot && h.owner !== shooter.token) award(shooter, XP.breach, 'Stash house breached', true);
        feed(`${shooter.name} breached ${h.ownerName || 'an unclaimed'}'s stash house`);
        notifyOwner(hit.target, `⚠ Your stash house door was breached by ${shooter.name}!`);
      } else if (!h.alertedAt || Date.now() - h.alertedAt > 30_000) {
        h.alertedAt = Date.now();
        notifyOwner(hit.target, `⚠ ${shooter.name} is shooting your stash house door!`);
      }
    } else {
      applyDamage(hit.target, dmg, shooter, hit.kind === 'bot', hit.headshot);
      if (!isBot) send(shooter.ws, { t: 'hitmark', dmg: Math.round(dmg), crit: hit.headshot, x: tracers.at(-1)[0], y: tracers.at(-1)[1], z: tracers.at(-1)[2] });
    }
  }
  if (!isBot) { breakCamo(shooter, 2000); shooter.protectedUntil = 0; }
  const msg = JSON.stringify({ t: 'shot', from: shooter.id, sup: !!s.suppressed, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], hits: tracers });
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
    weapon: { ...w, damage: w.damage * def.damageMul },
    nextShot: 0, wander: null, crouch: false, burst: 0, ...extra,
  };
  bots.set(b.id, b);
  return b;
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
    if (b.dead) continue;
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
  const contact = map.contacts[msg.contactId];
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
  return { t: 'contact', id: contactId, name: map.contacts[contactId].name, offers: contactOffers(p, contactId), active: p.contracts.map((c) => c.id), comms: p.comms };
}
function requisition(p, msg) {
  const contact = map.contacts[msg.contactId];
  if (!contact || Math.hypot(contact.x - p.x, contact.z - p.z) > 6) return;
  const table = { part: PARTS, paint: PAINTS, armor: ARMORS, perk: FIELD_PERKS }[msg.kind];
  const def = table?.[msg.id];
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
  const def = PIECES[msg.piece];
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
  if (!structs.has(st.id)) return;
  st.hp -= dmg;
  const owner = onlineByToken(st.owner);
  if (owner && by !== owner && (!st.alertedAt || Date.now() - st.alertedAt > 20_000)) { st.alertedAt = Date.now(); toast(owner, `⚠ Your ${stageDef(st).name.toLowerCase()} is under attack${by ? ` by ${by.name}` : ''}!`); }
  if (st.hp > 0) return;
  if (PIECES[st.type].claim) { feed(`${storeOwnerLabel(st)}'s ${stageDef(st).name.toLowerCase()} was destroyed`); notifyStore(st, '⚠ Your stash house was destroyed — you no longer have one'); }
  removeStruct(st, true);
  if (by && !by.isBot && st.owner !== by.token) award(by, PIECES[st.type].claim ? 250 : 40, `Destroyed ${stageDef(st).name.toLowerCase()}`, true);
}
function removeStruct(st, destroyed) {
  indexStruct(st, false);
  db.structures = db.structures.filter((o) => o !== st);
  // A claimed building's doors go with its stash locker.
  if (PIECES[st.type].claim && st.building != null) for (const d of [...structs.values()]) if (d.claimOf === st.id) removeStruct(d, false);
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
    const hs = db.houses[h.id];
    if (hs.doorHp <= 0) continue;
    hs.doorHp = Math.max(0, hs.doorHp - k.damage * (1 - d / (k.radius * 1.5)));
    hs.lastDamaged = now;
    if (hs.doorHp === 0) { feed(`${c.ownerName} blew open ${hs.ownerName || 'an unclaimed'}'s ${HOME_KINDS[h.kind].name.toLowerCase()}`); notifyOwner(h.id, `⚠ Your stash door was blown open by ${c.ownerName}!`); if (by && hs.owner !== by.token) award(by, XP.breach, 'Stash house breached', true); }
  }
  for (const t of [...players.values(), ...bots.values()]) {
    if (t.dead) continue;
    const d = Math.hypot(t.x - c.x, t.z - c.z);
    if (d < k.playerRadius) applyDamage(t, k.playerDamage * (1 - d / k.playerRadius), by, !!t.isBot);
  }
}

function craft(p, msg) {
  const def = CRAFTS[msg.item];
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
  return best;
}
function containerView(p, kind, id) {
  if (kind === 'stash') {
    const h = db.houses[id];
    const ours = claimOf(p);
    const mine = ours?.kind === 'home' && ours.id === id;
    const squad = !mine && !!h.owner && tokenInSquadWith(p, h.owner);
    const title = mine ? (h.crew ? `${storeOwnerLabel(h)} crew stash` : 'Your stash') : `${storeOwnerLabel(h) || 'Unclaimed'}'s stash${squad ? ' (crew)' : ''}`;
    return { t: 'container', kind, id, title, items: h.items, ...Object.fromEntries(RESOURCES.map((r) => [r, h[r] || 0])), ammo: 0, canPut: mine || squad, cap: stashCap(id), gunsmith: mine, bank: mine, craft: mine, upg: mine ? h.upg : null, home: mine ? claimSummary(p) : null };
  }
  if (kind === 'crate') {
    const st = structs.get(id);
    if (!st) return { t: 'container', closed: true };
    const mine = canManage(p, st);
    const own = claimOf(p)?.store === st, flag = !!PIECES[st.type].claim;
    const cap = flag ? claimCap({ kind: 'flag', store: st }) : stageDef(st).slots;
    return { t: 'container', kind, id, title: flag ? (own ? (st.crew ? `${storeOwnerLabel(st)} crew stash` : `Your ${stageDef(st).name.toLowerCase()} (stash)`) : `${storeOwnerLabel(st)}'s ${stageDef(st).name.toLowerCase()}`) : `${st.ownerName}'s ${stageDef(st).name.toLowerCase()}${mine ? '' : ' (not yours)'}`, items: st.items, ...Object.fromEntries(RESOURCES.map((r) => [r, st[r] || 0])), canPut: mine, cap, craft: own, upgradable: mine && !!PIECES[st.type].stages[st.stage + 1],
      gunsmith: flag && own, bank: flag && own, upg: flag && own ? st.upg : null, home: flag && own ? claimSummary(p) : null };
  }
  const bag = db.bags.find((b) => b.id === id);
  return bag ? { t: 'container', kind, id, title: bag.label, items: bag.items, ...Object.fromEntries(RESOURCES.map((r) => [r, bag[r] || 0])), canPut: false, cap: 0 } : { t: 'container', closed: true };
}
function nearContainer(p, kind, id) {
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
  if (p.hack) return cancelHack(p, 'Cancelled');
  // A downed crewmate within reach comes first.
  for (const m of squadMembersOnline(p)) {
    if (m !== p && m.downed && !m.dead && Math.hypot(m.x - p.x, m.z - p.z) <= DOWNED.reviveRange) return startHack(p, 'revive', m.id);
  }
  const it = nearestInteractable(p);
  // Nothing else here: at a landing zone, E calls the extraction helicopter.
  if (!it) {
    if (map.landingZones.some((l) => Math.hypot(l.x - p.x, l.z - p.z) < EXTRACT.callRange)) return callExtraction(p);
    const b = buildingAt(p.x, p.z);
    if (b >= 0) startClaimBuilding(p, b);
    return;
  }
  if (it.kind === 'terminal') return startHack(p, 'terminal', it.ref.id);
  if (it.kind === 'drop') return startHack(p, 'drop', it.ref.id);
  if (it.kind === 'crate') return startHack(p, 'crate', it.ref.id);
  if (it.kind === 'harvest') {
    const tool = it.res === 'wood' ? 'hatchet' : 'pickaxe';
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
  if (canManage(p, st)) {
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
  if (def.container) { p.openContainer = { kind: 'crate', id: st.id }; return send(p.ws, containerView(p, 'crate', st.id)); }
  if (stage.material === 'frame') return toast(p, `${st.ownerName}'s ${stage.name.toLowerCase()}`);
  if (def.door && !st.open && level(p) >= GADGETS.doorHack.level && p.tech >= GADGETS.doorHack.cost && !hasTool(p, 'hatchet') && !hasTool(p, 'pickaxe')) return startHack(p, 'gatehack', st.id);
  const tool = stage.material === 'stone' ? 'pickaxe' : hasTool(p, 'hatchet') ? 'hatchet' : hasTool(p, 'pickaxe') ? 'pickaxe' : null;
  if (!tool || !hasTool(p, tool)) return toast(p, stage.material === 'stone' ? 'Stone — break it with a pickaxe or a breach charge' : 'Chop it down with a hatchet, or use a breach charge');
  return startHack(p, 'raid', st.id, { tool });
}
// In build mode, interacting with your own crate/gate upgrades it instead of opening it.
function msg_upgradeIntent(p) { return !!p.buildIntent; }

function containerAction(p, msg) {
  const { kind, id } = p.openContainer || {};
  if (!kind || !nearContainer(p, kind, id)) { p.openContainer = null; return send(p.ws, { t: 'container', closed: true }); }
  const store = kind === 'stash' ? db.houses[id] : kind === 'crate' ? structs.get(id) : db.bags.find((b) => b.id === id);
  if (!store) return;
  if (msg.action === 'take') {
    if (RESOURCES.includes(msg.res)) { p[msg.res] += store[msg.res] || 0; store[msg.res] = 0; }
    else {
      const idx = store.items.findIndex((i) => i.id === msg.itemId);
      if (idx < 0) return;
      if (!addToPack(p, store.items[idx])) return toast(p, 'Backpack full');
      store.items.splice(idx, 1);
    }
  } else if (msg.action === 'put') {
    if (kind === 'bag') return;
    if (kind === 'stash') { const h = db.houses[id]; if (!(h.owner === p.token || (h.owner && tokenInSquadWith(p, h.owner)))) return; }
    if (kind === 'crate' && !canManage(p, store)) return;
    if (RESOURCES.includes(msg.res)) { store[msg.res] = (store[msg.res] || 0) + p[msg.res]; p[msg.res] = 0; dirty(p); return refreshContainerViewers(kind, id); }
    const cap = kind === 'stash' ? stashCap(id) : stageDef(store).slots;
    if (store.items.length >= (kind === 'crate' && PIECES[store.type].claim ? claimCap({ kind: 'flag', store }) : cap)) return toast(p, kind === 'stash' ? 'Stash full — upgrade storage or level up your home' : 'Crate full — reinforce it for more room');
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
      const part = PARTS[msg.partId];
      if (!part || !SLOTS.includes(msg.slot) || part.slot !== msg.slot) return;
      if (!partFits(msg.partId, w.archetype)) return toast(p, `${part.name} doesn't fit a ${ARCHETYPES[w.archetype].label}`);
      if (!isUnlocked(part, msg.partId, p)) return toast(p, part.field && level(p) >= part.level ? `${part.name} is field gear — requisition it from a Contact` : `${part.name} unlocks at level ${part.level}`);
      w.parts[msg.slot] = msg.partId;
      const cap = weaponStats(w).mag;
      if ((p.mags[w.id] ?? 0) > cap) { p.ammo += p.mags[w.id] - cap; p.mags[w.id] = cap; }
    } else {
      const paint = PAINTS[msg.paint];
      if (!paint) return;
      if (!isUnlocked(paint, msg.paint, p)) return toast(p, paint.field && level(p) >= paint.level ? `${paint.name} is field gear — requisition it from a Contact` : `${paint.name} unlocks at level ${paint.level}`);
      w.paint = msg.paint;
    }
  } else if (msg.action === 'build' || msg.action === 'buildArmor') {
    const isArmor = msg.action === 'buildArmor';
    const def = isArmor ? ARMORS[msg.type] : ARCHETYPES[msg.type];
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
    award(p, XP.build, `Built ${item.name}`);
    toast(p, `Built ${item.name}${roomInPack ? '' : ' (sent to stash)'}`);
  } else return;
  dirty(p);
  refreshClaim(claimOf(p));
}
function upgradeAction(p, msg) {
  if (!atOwnStash(p)) return toast(p, 'Upgrades are installed at your stash house');
  const track = UPGRADES[msg.track];
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
  } else if (msg.action === 'use') {
    const idx = inv.pack.findIndex((i) => i.kind === 'medkit');
    if (idx < 0) return toast(p, 'No medkits');
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
    crates: [...structs.values()].filter((st) => st.owner === p.token && PIECES[st.type].container).map((st) => ({ id: st.id, x: st.x, z: st.z })),
  };
}
function placeAt(p, x, z) {
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
    if (!map.contacts[msg.id]) return;
    at = { x: map.contacts[msg.id].x + 3, z: map.contacts[msg.id].z + 3 };
  } else if (msg.kind === 'crate') {
    const st = structs.get(msg.id);
    if (!st || st.owner !== p.token || !PIECES[st.type].container) return;
    at = { x: st.x, z: st.z + 1.4 };
  } else if (msg.kind === 'lz') {
    at = map.landingZones[msg.id];
    if (!at) return;
  } else return;
  if (!p.deploying) {
    const keepIntel = p.intel;
    Object.assign(p, { hp: 100, armor: 0, ...starterLoadout() });
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
  if (msg.kind === 'contact') {
    if (!p.discovered.includes(msg.id)) return toast(p, 'Discover that Contact on foot first');
    const c = map.contacts[msg.id];
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
  p.houseId = ownedHouse(token);
  if (p.houseId !== null) db.houses[p.houseId].ownerName = name;
  for (const st of structs.values()) if (st.owner === token) st.ownerName = name;
  p.deploying = !!p.needsDeploy;
  if (p.deploying) p.dead = true;
  else if (!p.dead) { const fixed = resolveCircle(p.x, p.z, PLAYER_RADIUS, solidsNear(p.x, p.z, 3), terrain.height(p.x, p.z)); p.x = fixed.x; p.z = fixed.z; }
  players.set(p.id, p);
  ws.player = p;
  send(ws, {
    t: 'welcome', id: p.id, token, seed: SEED, size: WORLD_SIZE, mapSum: MAP_SUM, real: REAL_INFO, houseId: p.houseId,
    x: p.x, z: p.z, yaw: p.yaw, packSize: PACK_SIZE, doorBase: DOOR_HP,
    deploy: p.dead ? deployOptions(p) : null, firstDeploy: p.deploying,
  });
  send(ws, { t: 'events', drops: dropList(), extracts: extractList() });
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
  let dx = tx - p.x, dz = tz - p.z;
  const maxStep = (p.downed ? DOWNED.crawlSpeed : SPRINT_SPEED) * dt * 1.5 + 0.15;
  const d = Math.hypot(dx, dz);
  if (d > maxStep) { dx *= maxStep / d; dz *= maxStep / d; }
  const np = moveWithCollision(p.x, p.z, dx, dz, PLAYER_RADIUS, solidsNear(p.x, p.z, maxStep + 2), terrain);
  p.speed = dt > 0 ? Math.hypot(np.x - p.x, np.z - p.z) / dt : 0;
  p.x = np.x; p.z = np.z;
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.crouch = !!msg.crouch || !!p.downed;
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
  fire(p, msg.dir);
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
  for (const [prefix, dir] of STATIC) {
    if (!url.startsWith(prefix)) continue;
    const rel = url.slice(prefix.length) || 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) break;
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end('Not found');
};
const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = ws.player;
    if (!p) { if (msg.t === 'join') handleJoin(ws, msg); return; }
    // While downed you can crawl, talk to your crew, or give up; nothing else.
    if (p.downed && !p.dead) {
      if (msg.t === 'giveUp') return killPlayer(p, p.downedBy, p.downedHead);
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
      case 'buyMarker': {
        const ct = map.contacts[msg.contactId];
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
      case 'squad': return squadAction(p, msg);
      case 'rally': return !p.dead && rally(p);
      case 'mark': return !p.dead && markTarget(p, msg);
      case 'sensor': return !p.dead && throwSensor(p, msg);
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
        if (Number.isFinite(msg.x) && Number.isFinite(msg.z)) placeAt(p, msg.x, msg.z);
        return;
    }
  });
  ws.on('close', () => {
    const p = ws.player;
    if (!p) return;
    persistCharacter(p);
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
  for (const [p, v] of views) {
    const squad = sameSquad(r, p);
    if (!squad && !near(p)) continue;
    if (p !== r && v.camo && !squad && !exposedTo(p, r) && Math.hypot(p.x - r.x, p.z - r.z) > CAMO_REVEAL_DIST) continue;
    list.push(squad && p !== r ? { ...v, sq: 1 } : v);
  }
  return {
    t: 'snap', players: list,
    bots: [...bots.values()].filter((b) => !b.dead && near(b)).map((b) => ({ id: b.id, name: b.name, kind: b.kind, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), maxHp: b.maxHp })),
    loot: [...loot.values()].filter((l) => near(l, 140)).map((l) => ({ id: l.id, x: l.x, z: l.z, kind: l.item.kind, name: l.item.name, amount: l.item.amount || 0 })),
    bags: db.bags.filter((b) => near(b, 200)).map((b) => ({ id: b.id, x: b.x, z: b.z, label: b.label })),
    houses: map.houses.filter((h) => near(h)).map((h) => { const s = db.houses[h.id]; return { id: h.id, hp: Math.round(s.doorHp), max: Math.round(doorMax(h.id)), open: s.doorOpen, owner: s.owner ? s.ownerName : null, upg: s.upg, hl: s.owner ? homeLevel(s.hxp) : 0 }; }),
    terminals: map.terminals.filter((t) => near(t)).map((t) => [t.id, (terminalReadyAt.get(t.id) || 0) <= now ? 1 : 0]),
    objectives: [...objectives.values()].filter((o) => near(o) && tokenInSquadWith(r, o.owner)).map((o) => ({ id: o.id, x: o.x, z: o.z })),
    structs: structsNear(r.x, r.z, INTEREST).map((st) => ({ id: st.id, type: st.type, x: st.x, z: st.z, rot: st.rot, y0: +st.y0.toFixed(2), stage: st.stage, hp: Math.round(st.hp), max: Math.round(PIECES[st.type].claim ? flagMax(st) : stageDef(st).hp), hl: PIECES[st.type].claim ? homeLevel(st.hxp) : undefined, open: !!st.open, owner: st.ownerName, mine: canManage(r, st) ? 1 : 0 })),
    charges: [...charges.values()].filter((c) => near(c)).map((c) => ({ id: c.id, x: c.x, z: c.z, y: c.y, detAt: c.detAt })),
  };
}

let tick = 0;
const loop = setInterval(() => {
  const now = Date.now();
  const dt = 1 / TICK_HZ;
  updateBots(dt, now);
  tickHacks(now);
  if (tick % 5 === 0) { tickExtractions(now); tickDowned(now); }
  for (const c of [...charges.values()]) if (c.detAt <= now) explode(c, now);
  if (tick % 10 === 0) tickSensors(now);
  if (tick % TICK_HZ === 0) {
    manageAmbientBots();
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
      p.aliveMs += 1000;
      if (p.aliveMs >= 60_000) { p.aliveMs -= 60_000; award(p, XP.survivalPerMinute, 'Survived another minute'); }
      if (now - (p.lastHit || 0) >= 6000 && p.armor < maxArmor(p)) { p.armor = Math.min(maxArmor(p), p.armor + 3); dirty(p); }
      for (const c of [...p.contracts]) if (c.expires < now) { abandonContract(p, c.id); toast(p, `Contract expired: ${CONTRACT_TYPES[c.type].name}`); }
    }
    if (tick % (TICK_HZ * 5) === 0) for (const s of squads.values()) pushSquadState(s);   // squadmate positions for the map
  }
  if (tick % SNAPSHOT_EVERY === 0 && players.size) {
    const views = new Map([...players.values()].filter((p) => !p.deploying).map((p) => [p, {
      id: p.id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pitch: +(p.pitch || 0).toFixed(3),
      crouch: p.crouch, dead: p.dead, downed: p.downed ? 1 : 0, hp: Math.round(p.hp), maxHp: maxHp(p), armor: Math.round(p.armor), maxArmor: maxArmor(p),
      level: level(p), camo: camoActive(p), hacking: !!p.hack, prot: (p.protectedUntil || 0) > now,
      gun: activeWeapon(p) ? { a: activeWeapon(p).archetype, parts: activeWeapon(p).parts, paint: activeWeapon(p).paint } : null,
    }]));
    for (const r of players.values()) if (r.ws.readyState === 1) r.ws.send(JSON.stringify(snapshotFor(r, views, now)));
  }
  for (const p of players.values()) if (p.dirty) { p.dirty = false; send(p.ws, privateState(p)); }
  tick++;
}, 1000 / TICK_HZ);

const saver = setInterval(saveDb, Number(process.env.SAVE_EVERY_MS || 10_000));
function shutdown() { clearInterval(loop); clearInterval(saver); saveDb(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

refillLoot(Date.now());
server.listen(PORT, () => console.log(`Deadzone server on ${TLS ? 'https' : 'http'}://localhost:${PORT}  (seed ${SEED}, ${(WORLD_SIZE / 1609.344).toFixed(1)} × ${(WORLD_SIZE / 1609.344).toFixed(1)} mi world at 1:1, ${map.towns.length} towns, ${map.real.structures ? `${map.real.structures} real buildings, ` : ''}${map.real.roads ? `${map.real.roads} real roads, ` : ''}${map.houses.length} stash houses, ${map.contacts.length} contacts)`));
