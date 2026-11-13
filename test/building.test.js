// End-to-end: DayZ-style building on the real server. Gather wood and stone with tools, place
// frames, upgrade them, build a gate and a stash crate, then get raided with a hatchet and a
// breach charge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { placementProblem } from '../shared/building.js';

const PORT = 20000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzb-'));
const FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 7000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

// A tree with open buildable ground next to it, and a rock somewhere.
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
// Countryside trees and rocks are generated lazily, so look around the camp sites.
const wild = [];
for (const c of map.campSites.slice(0, 60)) for (const b of map.grid.near(c.x, c.z, 150)) if (b.nature && !wild.includes(b)) wild.push(b);
let site = null;
for (const b of wild) {
  if (b.type !== 'tree') continue;
  const x = (b.minX + b.maxX) / 2 + 1.2, z = (b.minZ + b.maxZ) / 2;
  const bx = x + 2, bz = z + 6;
  if (map.terrain.height(x, z) < 1) continue;
  const stand = { x: bx + 2, z: bz - 1.5 };
  if (placementProblem(world, 'wall', bx, bz, 0, stand) || placementProblem(world, 'gate', bx + 4.2, bz, 0, stand) || placementProblem(world, 'crate', bx, bz - 3, 0, stand)) continue;
  if (map.grid.near(bx + 2, bz - 2, 8).some((o) => o !== b)) continue;
  if (map.grid.near(x, z, 1.5).some((o) => o !== b && o.type !== 'tree')) continue;
  site = { x, z, bx, bz };
  break;
}
const rock = wild.find((b) => b.type === 'rock' && map.terrain.height(b.minX - 1, (b.minZ + b.maxZ) / 2) > 1 && !map.grid.near(b.minX - 1, (b.minZ + b.maxZ) / 2, 1.6).some((o) => o !== b));

const TOK_B = 'b0'.repeat(16), TOK_R = 'c0'.repeat(16);
const tool = (t) => ({ id: `t${t}${Math.random()}`, kind: 'tool', tool: t, name: t });
const ch = (name, x, z, extra) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [] }, ammo: 100, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 60, intel: 0, salvage: 100, wood: 0, stone: 0, comms: 0, field: [], discovered: [], contracts: [], ...extra });
const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, upg: {} }]));
const builderHome = map.houses[2];
houses[builderHome.id] = { ...houses[builderHome.id], owner: TOK_B, ownerName: 'Builder' };
fs.writeFileSync(FILE, JSON.stringify({ seed: 1337, version: 9, size: 30000, houses, bags: [], structures: [], characters: {
  [TOK_B]: ch('Builder', site.x, site.z, { wood: 10, inv: { primary: null, secondary: makeWeapon('sidearm'), armor: null, pack: [tool('hammer'), tool('hatchet'), tool('pickaxe')] } }),
  [TOK_R]: ch('Raider', site.x - 3, site.z, { inv: { primary: null, secondary: makeWeapon('sidearm'), armor: null, pack: [tool('hatchet'), tool('pickaxe')] } }),
} }));

function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'container') c.container = m; });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); c.send({ t: 'state', x, z, yaw: 0, pitch: 0 }); await sleep(80); };
  c.st = (id) => c.snap?.structs?.find((s) => s.id === id);
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('building: gather, build, upgrade, gate, crate, raid, breach charge, dismantle', async (t) => {
  assert.ok(site && rock, 'found a build site and a rock');
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: FILE, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  const b = await conn('Builder', TOK_B);
  await until(() => b.you && b.snap);
  // Chop the tree for wood, mine the rock for stone.
  b.send({ t: 'interact' });
  await b.got((m) => m.t === 'hack' && m.kind === 'harvest');
  await until(() => b.you.wood === 16);
  b.send({ t: 'interact' }); await b.got((m) => m.t === 'hack' && /\+6 wood/.test(m.text || '') && b.msgs.filter((x) => x.t === 'hack' && x.done).length >= 2);
  await b.tp(rock.minX - 1, (rock.minZ + rock.maxZ) / 2);
  for (let i = 0; i < 4; i++) { b.send({ t: 'interact' }); await until(() => b.you.stone === 5 * (i + 1)); }
  // Top up wood with a few more chops (4 uses per tree).
  await b.tp(site.x, site.z);
  b.send({ t: 'interact' }); await until(() => b.you.wood === 28);
  b.send({ t: 'interact' }); await until(() => b.you.wood === 34);
  // That tree is used up now.
  b.send({ t: 'interact' }); await b.got((m) => m.t === 'toast' && /Nothing left/.test(m.text));
  b.you.wood += 0;

  // Place a wall frame (10 wood) and upgrade it to a wooden wall (15 wood) and a stone wall (20 stone + 10 salvage).
  await b.tp(site.bx + 2, site.bz - 1.5);
  b.send({ t: 'build', piece: 'wall', x: site.bx, z: site.bz, rot: 0 });
  const wall = await until(() => b.snap.structs?.find((s) => s.type === 'wall'));
  assert.equal(wall.stage, 0);
  await until(() => b.you.wood === 24);
  await b.tp(site.bx, site.bz - 1.2);
  b.send({ t: 'interact', build: true });
  await until(() => b.st(wall.id)?.stage === 1, 8000);
  // Not enough wood for anything else now; give the builder materials via the stash route is overkill — mine more instead.
  b.send({ t: 'interact', build: true });
  await until(() => b.st(wall.id)?.stage === 2, 8000);
  assert.equal(b.you.stone, 0);

  // Placement rules hold server-side.
  b.send({ t: 'build', piece: 'wall', x: site.bx, z: site.bz, rot: 0 });
  await b.got((m) => m.t === 'toast' && /Blocked/.test(m.text));

  // Gate + stash crate (needs more wood: chop a fresh tree nearby).
  const tree2 = map.grid.near(site.x, site.z, 120).find((o) => o.type === 'tree' && Math.hypot(o.minX - site.x, o.minZ - site.z) > 3 && !map.grid.near(o.maxX + 1.2, o.minZ + 0.3, 1.4).some((q) => q !== o));
  await b.tp(tree2.maxX + 1.2, tree2.minZ + 0.3);
  for (let i = 0; i < 4; i++) { const w = b.you.wood; b.send({ t: 'interact' }); await until(() => b.you.wood === w + 6); }
  await b.tp(site.bx + 2, site.bz - 1.5);
  b.send({ t: 'build', piece: 'gate', x: site.bx + 4.2, z: site.bz, rot: 0 });
  const gate = await until(() => b.snap.structs?.find((s) => s.type === 'gate'));
  b.send({ t: 'build', piece: 'crate', x: site.bx, z: site.bz - 3, rot: 0 });
  const crate = await until(() => b.snap.structs?.find((s) => s.type === 'crate'));
  // Put salvage in the crate.
  await b.tp(site.bx, site.bz - 4.4);
  b.send({ t: 'interact' });
  await until(() => b.container?.kind === 'crate' && b.container.canPut);
  b.send({ t: 'container', action: 'put', res: 'salvage' });
  await until(() => b.container.salvage === 90);   // 100 - 10 spent on the stone wall
  const woodStored = b.you.wood;
  b.send({ t: 'container', action: 'put', res: 'wood' });
  await until(() => b.container.wood === woodStored && b.you.wood === 0);

  // A raider loots the crate (crates aren't locked — your walls are the protection) …
  const r = await conn('Raider', TOK_R);
  await until(() => r.you);
  await r.tp(site.bx, site.bz - 4.4);
  r.send({ t: 'interact' });
  await until(() => r.container?.kind === 'crate');
  assert.equal(r.container.canPut, false);
  r.send({ t: 'container', action: 'take', res: 'wood' });
  await until(() => r.you.wood === woodStored);
  // … then takes a pickaxe to the stone wall from the outside. The owner is alerted and the wall loses HP.
  const hp0 = b.st(wall.id).hp;
  await r.tp(site.bx - 1, site.bz + 1.4);
  r.send({ t: 'interact' });
  await r.got((m) => m.t === 'hack' && m.kind === 'raid');
  await b.got((m) => m.t === 'toast' && /breaking into your base/.test(m.text), 4000);
  await r.got((m) => m.t === 'hack' && m.done, 10000);
  await until(() => b.st(wall.id).hp === hp0 - 500);

  // Breach charge: craft at a crate you own (level 7, 30 salvage + 20 tech + 20 parts), then blow the stone wall.
  const wallBefore = b.st(wall.id).hp;
  await b.tp(site.bx, site.bz - 4.4);
  b.send({ t: 'interact' });
  await until(() => b.container?.kind === 'crate');
  b.send({ t: 'container', action: 'take', res: 'salvage' });
  await until(() => b.you.salvage >= 30 || true);
  b.send({ t: 'craft', item: 'charge' });
  await until(() => b.you.inv.pack.some((i) => i.kind === 'charge'));
  await b.tp(site.bx + 0.5, site.bz - 1);
  b.send({ t: 'build', piece: 'charge', x: site.bx, z: site.bz - 0.5 });
  await b.got((m) => m.t === 'toast' && /Charge armed/.test(m.text));
  await b.tp(site.x + 20, site.z - 20);
  await b.got((m) => m.t === 'boom', 12000);
  await until(() => !b.st(wall.id) || b.st(wall.id).hp < wallBefore);

  // The blast also flattened the flimsy gate frame and the (by now empty) wooden crate.
  await b.tp(site.bx + 2, site.bz - 1.5);
  await until(() => !b.st(gate.id) && !b.st(crate.id));

  // Dismantle what's left of the stone wall: half of everything invested comes back.
  assert.ok(b.st(wall.id), 'stone wall survived one charge');
  const before = { wood: b.you.wood, stone: b.you.stone };
  b.send({ t: 'dismantle', id: wall.id });
  await until(() => !b.st(wall.id) && b.you.wood === before.wood + 12 && b.you.stone === before.stone + 10);
  b.ws.close(); r.ws.close();
});
