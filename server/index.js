// Authoritative game server: one persistent, always-live shared world.
// - Serves the browser client over HTTP and runs the simulation over WebSocket.
// - Every position, shot, hit, pickup and stash transfer is validated here.
// - World state (characters, stash contents, door damage, dropped bags) persists to disk,
//   so the world keeps existing while players are offline — including their stash houses.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  generateMap, moveWithCollision, resolveCircle, rayAgainstBoxes, rayBox, characterBounds,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, SPRINT_SPEED, INTERACT_RANGE,
} from '../shared/world.js';
import {
  makeWeapon, makeArmor, makeConsumable, weaponStats, armorStats, worldSupply, partFits,
  levelFromXp, unlocksAt, XP, ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS,
} from '../shared/items.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const SEED = Number(process.env.SEED || 1337);
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const TICK_HZ = 20;
const SNAPSHOT_EVERY = 2;            // snapshots at 10 Hz
const BOT_COUNT = Number(process.env.BOTS ?? 14);
const PACK_SIZE = 12;
const STASH_SIZE = 30;
const DOOR_HP = Number(process.env.DOOR_HP || 1500);
const LOOT_RESPAWN_MS = 90_000;
const BAG_LIFETIME_MS = 30 * 60_000;
const DB_VERSION = 2;

const map = generateMap(SEED);
const staticSolids = map.boxes;

// ---------------------------------------------------------------- persistence
function freshDb() {
  return {
    characters: {},   // token -> persistent character
    houses: Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: DOOR_HP, doorOpen: false, items: [], parts: 0 }])),
    bags: [],
  };
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (db.seed !== SEED || db.version !== DB_VERSION) throw new Error('incompatible save');
    for (const h of map.houses) db.houses[h.id] ??= freshDb().houses[h.id];
    return db;
  } catch {
    return { seed: SEED, version: DB_VERSION, ...freshDb() };
  }
}

const db = loadDb();
db.seed = SEED;
db.version = DB_VERSION;
for (const h of Object.values(db.houses)) h.parts ??= 0;

function saveDb() {
  for (const p of players.values()) persistCharacter(p);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------- runtime state
const players = new Map();   // id -> live player session
const bots = new Map();
const loot = new Map();      // id -> { id, x, z, item, spawnIndex }
const spawnCooldown = new Map(map.lootSpawns.map((_, i) => [i, 0]));
let nextId = 1;
const uid = (p) => `${p}${nextId++}`;

function doorBox(houseId) {
  const h = db.houses[houseId];
  if (h.doorHp <= 0 || h.doorOpen) return null;
  return { ...map.houses[houseId].door, type: 'door', houseId };
}

function solids() {
  const list = staticSolids.slice();
  for (const h of map.houses) { const d = doorBox(h.id); if (d) list.push(d); }
  return list;
}

// ---------------------------------------------------------------- characters
function starterKit() {
  return {
    primary: null,
    secondary: makeWeapon('sidearm'),
    armor: null,
    pack: [makeConsumable('medkit')],
  };
}

function starterLoadout() {
  const inv = starterKit();
  return { inv, ammo: 90, parts: 0, mags: { [inv.secondary.id]: weaponStats(inv.secondary).mag }, active: 'secondary' };
}

function newCharacter(name) {
  const sp = map.playerSpawns[Math.floor(Math.random() * map.playerSpawns.length)];
  return {
    name, x: sp.x, z: sp.z, yaw: 0, hp: 100, armor: 0, ...starterLoadout(), parts: 60, dead: false, kills: 0, xp: 0,
  };
}

function claimHouse(token, name) {
  const owned = Object.entries(db.houses).find(([, h]) => h.owner === token);
  if (owned) return Number(owned[0]);
  const free = Object.entries(db.houses).find(([, h]) => !h.owner);
  if (!free) return null;
  free[1].owner = token;
  free[1].ownerName = name;
  return Number(free[0]);
}

function maxHp() { return 100; }
function maxArmor(p) { return armorStats(p.inv.armor).armor; }
function activeWeapon(p) { return p.inv[p.active] || p.inv.primary || p.inv.secondary || null; }
function stats(p) { return weaponStats(activeWeapon(p)); }
function level(p) { return levelFromXp(p.xp || 0); }

/** Grant XP; announces level-ups along with exactly what they unlocked. */
function award(p, amount, reason) {
  if (!p || p.isBot || !amount) return;
  const before = level(p);
  p.xp = (p.xp || 0) + amount;
  const after = level(p);
  send(p.ws, { t: 'xp', amount, reason });
  for (let l = before + 1; l <= after; l++) {
    send(p.ws, { t: 'levelup', level: l, unlocks: unlocksAt(l) });
    feed(`${p.name} reached level ${l}`);
  }
  dirty(p);
}

function persistCharacter(p) {
  db.characters[p.token] = {
    name: p.name, x: p.x, z: p.z, yaw: p.yaw, hp: p.hp, armor: p.armor, inv: p.inv,
    ammo: p.ammo, mags: p.mags, active: p.active, dead: p.dead, kills: p.kills, xp: p.xp, parts: p.parts,
  };
}

// ---------------------------------------------------------------- networking helpers
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function feed(text) { broadcast({ t: 'feed', text }); }
function toast(p, text) { send(p.ws, { t: 'toast', text }); }

function privateState(p) {
  const w = activeWeapon(p);
  return {
    t: 'you', hp: p.hp, maxHp: maxHp(p), armor: p.armor, maxArmor: maxArmor(p), ammo: p.ammo,
    mag: w ? (p.mags[w.id] ?? 0) : 0, inv: p.inv, active: p.active, dead: p.dead, kills: p.kills,
    xp: p.xp, level: level(p), parts: p.parts, atStash: atOwnStash(p),
    reloading: p.reloadUntil > Date.now(), houseId: p.houseId,
  };
}
function dirty(p) { p.dirty = true; }

// ---------------------------------------------------------------- combat
function applyDamage(target, amount, attacker, isBot, headshot = false) {
  if (target.dead) return;
  let dmg = amount;
  if (!isBot && target.armor > 0) {
    const absorbed = Math.min(target.armor, dmg);
    target.armor -= absorbed;
    dmg -= absorbed;
  }
  target.hp -= dmg;
  target.lastHit = Date.now();
  if (!isBot) dirty(target);
  if (target.hp <= 0) {
    target.hp = 0;
    if (isBot) killBot(target, attacker, headshot); else killPlayer(target, attacker, headshot);
  }
}

function dropBag(x, z, items, ammo = 0, label = 'Bag', parts = 0) {
  const bag = { id: 'bag' + crypto.randomBytes(6).toString('hex'), x, z, items: items.filter(Boolean), ammo, parts, label, expires: Date.now() + BAG_LIFETIME_MS };
  if (bag.items.length || bag.ammo || bag.parts) db.bags.push(bag);
}

function killPlayer(p, attacker, headshotKill) {
  p.dead = true;
  const { primary, secondary, armor, pack } = p.inv;
  dropBag(p.x, p.z, [primary, secondary, armor, ...pack], p.ammo, `${p.name}'s bag`, p.parts);
  p.inv = { primary: null, secondary: null, armor: null, pack: [] };
  p.ammo = 0; p.mags = {}; p.armor = 0; p.parts = 0;
  const by = attacker ? attacker.name : 'the city';
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    award(attacker, XP.playerKill + 20 * level(p) + (headshotKill ? XP.headshotKill : 0), `Killed ${p.name}`);
  }
  feed(`${by} ➜ ${p.name}`);
  send(p.ws, { t: 'died', by });
  dirty(p);
}

function killBot(b, attacker, headshotKill) {
  b.dead = true;
  b.respawnAt = Date.now() + 45_000;
  dropBag(b.x, b.z, b.drops % 3 === 0 ? [makeConsumable('medkit')] : [], 30, 'Rogue cache', 20);
  b.drops++;
  if (attacker && !attacker.isBot) {
    attacker.kills++;
    award(attacker, XP.rogueKill + (headshotKill ? XP.headshotKill : 0), 'Rogue down');
  }
  if (attacker) feed(`${attacker.name} ➜ ${b.name}`);
}

/**
 * Trace a shot from (ox,oy,oz) along unit dir. Hits world geometry, doors, players and bots.
 * Returns { t, target, kind, headshot }.
 */
function traceShot(ox, oy, oz, dx, dy, dz, range, shooterId) {
  const world = rayAgainstBoxes(ox, oy, oz, dx, dy, dz, staticSolids, range);
  let best = world.t, target = null, kind = world.box ? 'world' : null, headshot = false;
  for (const h of map.houses) {
    const d = doorBox(h.id);
    if (!d) continue;
    const t = rayBox(ox, oy, oz, dx, dy, dz, d.minX, 0, d.minZ, d.maxX, d.h, d.maxZ);
    if (t < best) { best = t; target = h.id; kind = 'door'; }
  }
  const check = (c, k) => {
    if (c.dead || c.id === shooterId) return;
    const b = characterBounds(c.x, c.z, c.crouch);
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
  const ox = shooter.x, oy = eye, oz = shooter.z;
  let base = dir;
  const len = Math.hypot(base[0], base[1], base[2]) || 1;
  base = [base[0] / len, base[1] / len, base[2] / len];
  const moving = !isBot && shooter.speed > 0.5;
  const baseSpread = isBot ? s.hipSpread * 0.6 : shooter.aiming ? s.adsSpread : s.hipSpread;
  const spreadMul = (moving ? 1.6 : 1) * (shooter.crouch ? 0.8 * s.crouchSpread : 1) / botAccuracy;
  const tracers = [];
  for (let i = 0; i < s.pellets; i++) {
    const sp = baseSpread * spreadMul;
    let dx = base[0] + (Math.random() - 0.5) * 2 * sp;
    let dy = base[1] + (Math.random() - 0.5) * 2 * sp;
    let dz = base[2] + (Math.random() - 0.5) * 2 * sp;
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const maxRange = s.range * 2.2;
    const hit = traceShot(ox, oy, oz, dx, dy, dz, maxRange, shooter.id);
    const t = Math.min(hit.t, maxRange);
    tracers.push([+(ox + dx * t).toFixed(2), +(oy + dy * t).toFixed(2), +(oz + dz * t).toFixed(2), hit.kind ? 1 : 0]);
    if (!hit.kind || hit.kind === 'world') continue;
    // Damage falls off linearly past optimal range down to 40%.
    const falloff = t <= s.range ? 1 : Math.max(0.4, 1 - (t - s.range) / (s.range * 1.2) * 0.6);
    let dmg = s.damage * falloff;
    if (hit.headshot) dmg *= 1.5;
    if (hit.kind === 'door') {
      const h = db.houses[hit.target];
      h.doorHp = Math.max(0, h.doorHp - dmg);
      h.lastDamaged = Date.now();
      if (h.doorHp === 0) {
        if (!isBot && h.owner !== shooter.token) award(shooter, XP.breach, 'Stash house breached');
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
  broadcast({ t: 'shot', from: shooter.id, sup: !!s.suppressed, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], hits: tracers });
}

function notifyOwner(houseId, text) {
  const owner = db.houses[houseId].owner;
  for (const p of players.values()) if (p.token === owner) toast(p, text);
}

// ---------------------------------------------------------------- bots ("Rogues")
const BOT_WEAPONS = ['carbine', 'smg', 'shotgun', 'lmg'];
function spawnBot(b) {
  const sp = map.lootSpawns[Math.floor(Math.random() * map.lootSpawns.length)];
  const arche = BOT_WEAPONS[Math.floor(Math.random() * BOT_WEAPONS.length)];
  Object.assign(b, {
    x: sp.x, z: sp.z, homeX: sp.x, homeZ: sp.z, yaw: 0, hp: 140, maxHp: 140, dead: false,
    weapon: (() => { const w = weaponStats(makeWeapon(arche)); return { ...w, damage: w.damage * 0.55 }; })(),
    nextShot: 0, wander: null, crouch: false, target: null, burst: 0,
  });
}
for (let i = 0; i < BOT_COUNT; i++) {
  const b = { id: uid('b'), name: 'Rogue', isBot: true, drops: i };
  spawnBot(b);
  bots.set(b.id, b);
}

function lineOfSight(ax, ay, az, bx, by, bz, list) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  return rayAgainstBoxes(ax, ay, az, dx / d, dy / d, dz / d, list, d).t >= d - 0.05;
}

function updateBots(dt, now, sol) {
  for (const b of bots.values()) {
    if (b.dead) { if (now > b.respawnAt) spawnBot(b); continue; }
    // Acquire nearest visible player within 32 m.
    let best = null, bestD = 32;
    for (const p of players.values()) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < bestD && lineOfSight(b.x, STAND_EYE, b.z, p.x, p.crouch ? 0.9 : 1.3, p.z, sol)) { best = p; bestD = d; }
    }
    b.target = best;
    let mx = 0, mz = 0;
    if (best) {
      b.yaw = Math.atan2(best.x - b.x, best.z - b.z);
      if (bestD > 14) { mx = Math.sin(b.yaw); mz = Math.cos(b.yaw); }
      if (now >= b.nextShot) {
        const ty = best.crouch ? 0.8 : 1.2;
        const dir = [best.x - b.x, ty - STAND_EYE, best.z - b.z];
        const accuracy = Math.max(0.35, 1.2 - bestD / 30);
        fire(b, dir, true, accuracy);
        b.burst = (b.burst + 1) % 5;
        b.nextShot = now + (b.burst === 0 ? 1400 : 60_000 / b.weapon.rpm * 1.3);
      }
    } else {
      if (!b.wander || Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1 || Math.random() < 0.003) {
        b.wander = { x: b.homeX + (Math.random() - 0.5) * 30, z: b.homeZ + (Math.random() - 0.5) * 30 };
      }
      b.yaw = Math.atan2(b.wander.x - b.x, b.wander.z - b.z);
      mx = Math.sin(b.yaw) * 0.45; mz = Math.cos(b.yaw) * 0.45;
    }
    const speed = 3.2;
    const np = moveWithCollision(b.x, b.z, mx * speed * dt, mz * speed * dt, PLAYER_RADIUS, sol);
    if (Math.hypot(np.x - b.x, np.z - b.z) < 0.001 && (mx || mz)) b.wander = null;
    b.x = np.x; b.z = np.z;
  }
}

// ---------------------------------------------------------------- loot
function refillLoot(now) {
  map.lootSpawns.forEach((sp, i) => {
    if (spawnCooldown.get(i) > now) return;
    for (const l of loot.values()) if (l.spawnIndex === i) return;
    const item = { ...worldSupply(i), id: uid('i') };
    const id = uid('l');
    loot.set(id, { id, x: sp.x, z: sp.z, item, spawnIndex: i });
    spawnCooldown.set(i, Infinity);
  });
}

function addToPack(p, item) {
  if (item.kind === 'ammo') { p.ammo += item.amount || 60; return true; }
  if (item.kind === 'parts') { p.parts += item.amount || 10; return true; }
  if (p.inv.pack.length >= PACK_SIZE) return false;
  p.inv.pack.push(item);
  return true;
}

// ---------------------------------------------------------------- interaction
function nearestInteractable(p) {
  let best = null, bestD = INTERACT_RANGE;
  const consider = (d, obj) => { if (d < bestD) { bestD = d; best = obj; } };
  for (const l of loot.values()) consider(Math.hypot(l.x - p.x, l.z - p.z), { kind: 'loot', ref: l });
  for (const bag of db.bags) consider(Math.hypot(bag.x - p.x, bag.z - p.z), { kind: 'bag', ref: bag });
  for (const h of map.houses) {
    consider(Math.hypot(h.crate.x - p.x, h.crate.z - p.z) - 0.3, { kind: 'stash', ref: h });
    const d = h.door;
    consider(Math.hypot((d.minX + d.maxX) / 2 - p.x, (d.minZ + d.maxZ) / 2 - p.z), { kind: 'door', ref: h });
  }
  return best;
}

function containerView(p, kind, id) {
  if (kind === 'stash') {
    const h = db.houses[id];
    const mine = h.owner === p.token;
    return { t: 'container', kind, id, title: mine ? 'Your stash' : `${h.ownerName || 'Unclaimed'}'s stash`, items: h.items, ammo: 0, parts: h.parts || 0, canPut: mine, cap: STASH_SIZE, gunsmith: mine };
  }
  const bag = db.bags.find((b) => b.id === id);
  return bag ? { t: 'container', kind, id, title: bag.label, items: bag.items, ammo: bag.ammo, parts: bag.parts || 0, canPut: false, cap: 0 } : { t: 'container', closed: true };
}

function nearContainer(p, kind, id) {
  if (kind === 'stash') {
    const h = map.houses[id];
    return h && Math.hypot(h.crate.x - p.x, h.crate.z - p.z) < INTERACT_RANGE + 0.6;
  }
  const bag = db.bags.find((b) => b.id === id);
  return bag && Math.hypot(bag.x - p.x, bag.z - p.z) < INTERACT_RANGE + 0.6;
}

function refreshContainerViewers(kind, id) {
  for (const p of players.values()) {
    if (p.openContainer?.kind === kind && p.openContainer.id === id) send(p.ws, containerView(p, kind, id));
  }
}

function interact(p) {
  const it = nearestInteractable(p);
  if (!it) return;
  if (it.kind === 'loot') {
    if (!addToPack(p, it.ref.item)) return toast(p, 'Backpack full');
    loot.delete(it.ref.id);
    award(p, XP.pickup, it.ref.item.name);
    spawnCooldown.set(it.ref.spawnIndex, Date.now() + LOOT_RESPAWN_MS);
    dirty(p);
  } else if (it.kind === 'bag' || it.kind === 'stash') {
    const id = it.kind === 'bag' ? it.ref.id : it.ref.id;
    p.openContainer = { kind: it.kind, id };
    send(p.ws, containerView(p, it.kind, id));
  } else if (it.kind === 'door') {
    const h = db.houses[it.ref.id];
    if (h.owner !== p.token) return toast(p, h.doorHp > 0 && !h.doorOpen ? `Locked — ${h.ownerName || 'nobody'}'s stash house. Shoot it down.` : 'Not your door');
    if (h.doorHp <= 0) {
      // A breached door has to be rebuilt in stages — the owner must stand there working on it.
      if (Date.now() - (p.lastRepair || 0) < 1500) return;
      p.lastRepair = Date.now();
      h.rebuild = (h.rebuild || 0) + 1;
      if (h.rebuild >= 4) { h.rebuild = 0; h.doorHp = DOOR_HP * 0.25; h.doorOpen = false; toast(p, 'Door rebuilt (25%) — it repairs itself while undamaged'); }
      else toast(p, `Rebuilding door… ${h.rebuild}/4`);
    } else {
      // Don't let the door close on top of someone.
      if (h.doorOpen) {
        const d = map.houses[it.ref.id].door;
        const blocked = [...players.values(), ...bots.values()].some((c) => !c.dead && Math.abs(c.x - (d.minX + d.maxX) / 2) < 1.4 && Math.abs(c.z - (d.minZ + d.maxZ) / 2) < 0.8);
        if (blocked) return toast(p, 'Doorway blocked');
      }
      h.doorOpen = !h.doorOpen;
    }
  }
}

function containerAction(p, msg) {
  const { kind, id } = p.openContainer || {};
  if (!kind || !nearContainer(p, kind, id)) { p.openContainer = null; return send(p.ws, { t: 'container', closed: true }); }
  const store = kind === 'stash' ? db.houses[id] : db.bags.find((b) => b.id === id);
  if (!store) return;
  if (msg.action === 'take') {
    if (msg.ammo && store.ammo) { p.ammo += store.ammo; store.ammo = 0; }
    else if (msg.parts && store.parts) { p.parts += store.parts; store.parts = 0; }
    else {
      const idx = store.items.findIndex((i) => i.id === msg.itemId);
      if (idx < 0) return;
      if (!addToPack(p, store.items[idx])) return toast(p, 'Backpack full');
      store.items.splice(idx, 1);
    }
  } else if (msg.action === 'put') {
    if (kind !== 'stash' || db.houses[id].owner !== p.token) return;
    if (msg.parts) { store.parts = (store.parts || 0) + p.parts; p.parts = 0; dirty(p); return refreshContainerViewers(kind, id); }
    if (store.items.length >= STASH_SIZE) return toast(p, 'Stash full');
    const idx = p.inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0) return;
    store.items.push(p.inv.pack.splice(idx, 1)[0]);
  }
  if (kind === 'bag' && !store.items.length && !store.ammo && !store.parts) db.bags = db.bags.filter((b) => b !== store);
  dirty(p);
  refreshContainerViewers(kind, id);
}

// ---------------------------------------------------------------- gunsmith (at your own stash house)
function atOwnStash(p) {
  if (p.houseId === null || p.houseId === undefined || p.dead) return false;
  const h = map.houses[p.houseId];
  return Math.hypot(h.crate.x - p.x, h.crate.z - p.z) < INTERACT_RANGE + 0.6;
}

function findOwnedWeapon(p, itemId) {
  const inv = p.inv;
  for (const slot of ['primary', 'secondary']) if (inv[slot]?.id === itemId) return inv[slot];
  const inPack = inv.pack.find((i) => i.id === itemId);
  if (inPack) return inPack;
  if (p.houseId !== null) return db.houses[p.houseId].items.find((i) => i.id === itemId) || null;
  return null;
}

/** Spend parts, carried first, then from the stash you're standing at. */
function spendParts(p, cost) {
  const stash = db.houses[p.houseId];
  if (p.parts + (stash.parts || 0) < cost) return false;
  const fromPack = Math.min(p.parts, cost);
  p.parts -= fromPack;
  stash.parts -= cost - fromPack;
  return true;
}

function gunsmithAction(p, msg) {
  if (!atOwnStash(p)) return toast(p, 'The gunsmith bench is at your stash house');
  const lvl = level(p);
  if (msg.action === 'attach' || msg.action === 'paint') {
    const w = findOwnedWeapon(p, msg.itemId);
    if (!w || w.kind !== 'weapon') return;
    if (msg.action === 'attach') {
      const part = PARTS[msg.partId];
      if (!part || !SLOTS.includes(msg.slot) || part.slot !== msg.slot) return;
      if (!partFits(msg.partId, w.archetype)) return toast(p, `${part.name} doesn't fit a ${ARCHETYPES[w.archetype].label}`);
      if (part.level > lvl) return toast(p, `${part.name} unlocks at level ${part.level}`);
      w.parts[msg.slot] = msg.partId;
      const cap = weaponStats(w).mag;
      if ((p.mags[w.id] ?? 0) > cap) { p.ammo += p.mags[w.id] - cap; p.mags[w.id] = cap; }
    } else {
      const paint = PAINTS[msg.paint];
      if (!paint) return;
      if (paint.level > lvl) return toast(p, `${paint.name} unlocks at level ${paint.level}`);
      w.paint = msg.paint;
    }
  } else if (msg.action === 'build' || msg.action === 'buildArmor') {
    const isArmor = msg.action === 'buildArmor';
    const def = isArmor ? ARMORS[msg.type] : ARCHETYPES[msg.type];
    if (!def) return;
    if (def.level > lvl) return toast(p, `${isArmor ? def.name : def.label} unlocks at level ${def.level}`);
    const stash = db.houses[p.houseId];
    const roomInPack = p.inv.pack.length < PACK_SIZE;
    if (!roomInPack && stash.items.length >= STASH_SIZE) return toast(p, 'Backpack and stash are full');
    if (!spendParts(p, def.cost)) return toast(p, `Needs ${def.cost} parts`);
    const item = isArmor ? makeArmor(msg.type) : makeWeapon(msg.type);
    if (roomInPack) p.inv.pack.push(item); else stash.items.push(item);
    award(p, XP.build, `Built ${item.name}`);
    toast(p, `Built ${item.name}${roomInPack ? '' : ' (sent to stash)'}`);
  } else return;
  dirty(p);
  refreshContainerViewers('stash', p.houseId);
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
    p.hp = Math.min(p.hp, maxHp(p));
  } else if (msg.action === 'unequip') {
    const slot = msg.slot;
    if (!['primary', 'secondary', 'armor'].includes(slot) || !inv[slot]) return;
    if (inv.pack.length >= PACK_SIZE) return toast(p, 'Backpack full');
    inv.pack.push(inv[slot]);
    inv[slot] = null;
    p.armor = Math.min(p.armor, maxArmor(p));
    p.hp = Math.min(p.hp, maxHp(p));
  } else if (msg.action === 'drop') {
    const idx = inv.pack.findIndex((i) => i.id === msg.itemId);
    if (idx < 0) return;
    dropBag(p.x, p.z, [inv.pack.splice(idx, 1)[0]], 0, `${p.name}'s drop`);
  } else if (msg.action === 'use') {
    const idx = inv.pack.findIndex((i) => i.kind === 'medkit');
    if (idx < 0) return toast(p, 'No medkits');
    if (p.hp >= maxHp(p) && p.armor >= maxArmor(p)) return;
    inv.pack.splice(idx, 1);
    p.hp = Math.min(maxHp(p), p.hp + 60);
    p.armor = Math.min(maxArmor(p), p.armor + 40);
  }
  dirty(p);
}

// ---------------------------------------------------------------- connection handling
function handleJoin(ws, msg) {
  const name = String(msg.name || 'Agent').replace(/[^\w \-]/g, '').slice(0, 16) || 'Agent';
  let token = typeof msg.token === 'string' && /^[a-f0-9]{32}$/.test(msg.token) ? msg.token : null;
  for (const other of players.values()) {
    if (other.token !== token) continue;
    persistCharacter(other);
    players.delete(other.id);
    other.ws.player = null;
    other.ws.close(4000, 'Logged in elsewhere');
  }
  if (!token || !db.characters[token]) {
    token = token || crypto.randomBytes(16).toString('hex');
    db.characters[token] = newCharacter(name);
  }
  const c = db.characters[token];
  const p = {
    id: uid('p'), ws, token, ...structuredClone(c), name,
    crouch: false, aiming: false, speed: 0, lastShot: 0, reloadUntil: 0, lastMove: Date.now(), aliveMs: 0,
    openContainer: null, dirty: true,
  };
  p.houseId = claimHouse(token, name);
  if (p.houseId !== null) db.houses[p.houseId].ownerName = name;
  const fixed = resolveCircle(p.x, p.z, PLAYER_RADIUS, solids());
  p.x = fixed.x; p.z = fixed.z;
  players.set(p.id, p);
  ws.player = p;
  send(ws, { t: 'welcome', id: p.id, token, map, houseId: p.houseId, x: p.x, z: p.z, yaw: p.yaw, packSize: PACK_SIZE, stashSize: STASH_SIZE, doorMax: DOOR_HP });
  feed(`${name} entered the zone`);
}

function handleState(p, msg) {
  if (p.dead) return;
  const now = Date.now();
  const dt = Math.min(0.25, (now - p.lastMove) / 1000);
  p.lastMove = now;
  const tx = Number(msg.x), tz = Number(msg.z);
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
  // Clamp claimed movement to max speed (with slack for jitter), then sweep it through collision.
  let dx = tx - p.x, dz = tz - p.z;
  const maxStep = SPRINT_SPEED * dt * 1.5 + 0.15;
  const d = Math.hypot(dx, dz);
  if (d > maxStep) { dx *= maxStep / d; dz *= maxStep / d; }
  const np = moveWithCollision(p.x, p.z, dx, dz, PLAYER_RADIUS, solids());
  p.speed = dt > 0 ? Math.hypot(np.x - p.x, np.z - p.z) / dt : 0;
  p.x = np.x; p.z = np.z;
  p.yaw = Number(msg.yaw) || 0;
  p.pitch = Math.max(-1.5, Math.min(1.5, Number(msg.pitch) || 0));
  p.crouch = !!msg.crouch;
  p.aiming = !!msg.aim;
  if (Math.hypot(p.x - tx, p.z - tz) > 0.5) send(p.ws, { t: 'correct', x: p.x, z: p.z });
  if (p.openContainer && !nearContainer(p, p.openContainer.kind, p.openContainer.id)) {
    p.openContainer = null;
    send(p.ws, { t: 'container', closed: true });
  }
}

function handleShoot(p, msg) {
  if (p.dead) return;
  const w = activeWeapon(p);
  if (!w) return;
  const s = stats(p);
  const now = Date.now();
  if (now < p.reloadUntil) return;
  if (now - p.lastShot < (60_000 / s.rpm) * 0.85) return;   // rate-of-fire check with jitter slack
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
  const cur = p.mags[w.id] ?? 0;
  const need = s.mag - cur;
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

function handleRespawn(p) {
  if (!p.dead) return;
  const sp = map.playerSpawns[Math.floor(Math.random() * map.playerSpawns.length)];
  Object.assign(p, { x: sp.x, z: sp.z, hp: 100, armor: 0, ...starterLoadout(), dead: false });
  send(p.ws, { t: 'correct', x: p.x, z: p.z, force: true });
  dirty(p);
}

// ---------------------------------------------------------------- http + ws
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const STATIC = [
  ['/vendor/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/', path.join(ROOT, 'client')],
];
const server = http.createServer((req, res) => {
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
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = ws.player;
    if (!p) { if (msg.t === 'join') handleJoin(ws, msg); return; }
    switch (msg.t) {
      case 'state': return handleState(p, msg);
      case 'shoot': return handleShoot(p, msg);
      case 'reload': return handleReload(p);
      case 'swap': if (!p.dead && p.reloadUntil < Date.now()) { p.active = p.active === 'primary' ? 'secondary' : 'primary'; if (!p.inv[p.active]) p.active = p.active === 'primary' ? 'secondary' : 'primary'; dirty(p); } return;
      case 'interact': return !p.dead && interact(p);
      case 'container': return !p.dead && containerAction(p, msg);
      case 'closeContainer': p.openContainer = null; return;
      case 'inv': return !p.dead && invAction(p, msg);
      case 'respawn': return handleRespawn(p);
      case 'gunsmith': return gunsmithAction(p, msg);
    }
  });
  ws.on('close', () => {
    const p = ws.player;
    if (!p) return;
    persistCharacter(p);   // character logs out where they stand; their stash house stays live
    players.delete(p.id);
    feed(`${p.name} left the zone`);
  });
});

// ---------------------------------------------------------------- main loop
let tick = 0;
const loop = setInterval(() => {
  const now = Date.now();
  const dt = 1 / TICK_HZ;
  const sol = solids();
  updateBots(dt, now, sol);
  if (tick % TICK_HZ === 0) {
    refillLoot(now);
    db.bags = db.bags.filter((b) => b.expires > now);
    // Closed, intact doors slowly repair themselves after a minute without damage.
    for (const h of Object.values(db.houses)) {
      if (h.doorHp > 0 && h.doorHp < DOOR_HP && now - (h.lastDamaged || 0) > 60_000) h.doorHp = Math.min(DOOR_HP, h.doorHp + DOOR_HP * 0.02);
    }
    // Time in the zone earns XP, so you level up just by playing — not only by farming kills or drops.
    for (const p of players.values()) {
      if (p.dead) continue;
      p.aliveMs += 1000;
      if (p.aliveMs >= 60_000) { p.aliveMs -= 60_000; award(p, XP.survivalPerMinute, 'Survived another minute'); }
    }
    // Armor regen out of combat.
    for (const p of players.values()) {
      if (p.dead || now - (p.lastHit || 0) < 6000) continue;
      const regen = 3;
      if (p.armor < maxArmor(p)) { p.armor = Math.min(maxArmor(p), p.armor + regen); dirty(p); }
    }
  }
  if (tick % SNAPSHOT_EVERY === 0 && players.size) {
    const snap = {
      t: 'snap',
      players: [...players.values()].map((p) => ({
        id: p.id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3), pitch: +(p.pitch || 0).toFixed(3),
        crouch: p.crouch, dead: p.dead, hp: Math.round(p.hp), maxHp: maxHp(p), armor: Math.round(p.armor), maxArmor: maxArmor(p),
        level: level(p),
        gun: activeWeapon(p) ? { a: activeWeapon(p).archetype, parts: activeWeapon(p).parts, paint: activeWeapon(p).paint } : null,
      })),
      bots: [...bots.values()].filter((b) => !b.dead).map((b) => ({ id: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), hp: Math.round(b.hp), maxHp: b.maxHp })),
      loot: [...loot.values()].map((l) => ({ id: l.id, x: l.x, z: l.z, kind: l.item.kind, name: l.item.name, amount: l.item.amount || 0 })),
      bags: db.bags.map((b) => ({ id: b.id, x: b.x, z: b.z, label: b.label })),
      houses: map.houses.map((h) => { const s = db.houses[h.id]; return { id: h.id, hp: Math.round(s.doorHp), open: s.doorOpen, owner: s.ownerName }; }),
    };
    const s = JSON.stringify(snap);
    for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s);
  }
  for (const p of players.values()) if (p.dirty) { p.dirty = false; send(p.ws, privateState(p)); }
  tick++;
}, 1000 / TICK_HZ);

const saver = setInterval(saveDb, 10_000);

function shutdown() {
  clearInterval(loop); clearInterval(saver);
  saveDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

refillLoot(Date.now());
server.listen(PORT, () => console.log(`Deadzone server on http://localhost:${PORT}  (seed ${SEED}, ${map.houses.length} stash houses, ${BOT_COUNT} rogues)`));
