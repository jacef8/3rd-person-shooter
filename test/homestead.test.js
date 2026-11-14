// Living off the land: hunger and eating, farm plots (and stealing crops), campfire cooking,
// fishing, trading posts with town prices, and wildlife.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const PORT = 24000 + Math.floor(Math.random() * 800);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzf-'));
const FILE = path.join(dir, 'world.json');
const tool = (t) => ({ id: `t-${t}-${Math.random()}`, kind: 'tool', tool: t, name: t });
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [tool('hammer'), tool('rod')] }, ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(5), parts: 50, tech: 20, intel: 0, salvage: 0, wood: 60, stone: 20, comms: 0, field: [], discovered: [], contracts: [], ...extra };
}
function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'contact') c.contact = m; if (m.t === 'correct' && m.force) c.tpn = m.tp; });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

// Open ground for a farm plot and a campfire.
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
let site = null;
for (const c of map.campSites) {
  for (const [dx, dz] of [[0, 0], [8, 0], [0, 8], [-8, 0], [0, -8]]) {
    const x = c.x + dx, z = c.z + dz, stand = { x: x + 2.5, z };
    if (!placementProblem(world, 'plot', x, z, 0, stand) && !placementProblem(world, 'campfire', x, z + 5, 0, { x: x + 2, z: z + 5 })) { site = { x, z }; break; }
  }
  if (site) break;
}
// The river bank west of Bristol, for fishing.
const bristol = map.towns.find((t) => t.name === 'Bristol');
let bank = null;
for (let x = bristol.rect.minX - 20; x > bristol.x - 6000 && !bank; x -= 1) if (map.terrain.height(x, bristol.z) < -0.6) bank = { x: x + 2.5, z: bristol.z };
const contactIn = (town) => map.contacts.find((c) => map.towns[c.townId].name === town);

test('homestead: eat, farm (and steal), cook, fish, trade at town prices, wildlife', async (t) => {
  assert.ok(site && bank, 'found farmland and a river bank');
  const A = 'ab'.repeat(16), B = 'cd'.repeat(16);
  fs.writeFileSync(FILE, JSON.stringify({ seed: 1337, version: 11, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [A]: character('Farmer', site.x + 2.5, site.z, { food: 30, corn: 2, seeds: 1, cash: 100 }),
    [B]: character('Thief', site.x + 30, site.z),
  } }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: FILE, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', CROP_GROW_SCALE: '0.0004' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const a = await conn('Farmer', A), b = await conn('Thief', B);
  await until(() => a.you && b.you);
  assert.equal(a.you.food, 30);

  // Eat: H with no wounds eats the best-fitting food.
  a.send({ t: 'inv', action: 'use' });
  await until(() => a.you.food === 45 && a.you.corn === 1);

  // Build a farm plot and plant: the ground decides the crop.
  a.send({ t: 'build', piece: 'plot', x: site.x, z: site.z, rot: 0 });
  const plot = await until(() => a.snap?.structs.find((s) => s.type === 'plot'));
  a.send({ t: 'interact' });
  await a.toast(/Planted (corn|peanuts|cotton)/);
  assert.equal((await until(() => a.you.seeds === 0 && a.you)).seeds, 0);
  const grown = await until(() => a.snap.structs.find((s) => s.id === plot.id && s.grow >= 1), 8000);
  const crop = grown.crop;
  // The thief walks over and takes it; the farmer is told.
  await b.tp(site.x + 2.4, site.z);
  b.send({ t: 'interact' });
  await b.toast(new RegExp(`\\+\\d+ ${crop} \\(stolen\\)`));
  await a.toast(new RegExp(`Thief harvested your ${crop}`));

  // Campfire: cook raw fish into meals.
  a.send({ t: 'build', piece: 'campfire', x: site.x, z: site.z + 5, rot: 0 });
  await until(() => a.snap?.structs.find((s) => s.type === 'campfire'));
  // Fishing at the river bank.
  await a.tp(bank.x, bank.z);
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'hack' && m.kind === 'fish');
  await a.got((m) => m.t === 'hack' && m.done && /\+\d+ fish/.test(m.text), 9000);
  const fish = await until(() => a.you.fish > 0 && a.you.fish);
  await a.tp(site.x + 1.2, site.z + 5);
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'hack' && m.done && /Cooked \d+ meal/.test(m.text), 8000);
  await until(() => a.you.fish === 0 && a.you.meals === fish);

  // Trading: corn pays more in Bristol (where it isn't grown) than in Blountstown (farm country).
  const cb = contactIn('Bristol'), cbl = contactIn('Blountstown');
  await a.tp(cb.x + 1.5, cb.z);
  a.send({ t: 'interact' });
  const bv = await until(() => a.contact?.trade?.town === 'Bristol' && a.contact);
  await a.tp(cbl.x + 1.5, cbl.z);
  a.contact = null;
  a.send({ t: 'interact' });
  const blv = await until(() => a.contact?.trade?.town === 'Blountstown' && a.contact);
  const pays = (v, g) => v.trade.sells.find((x) => x.good === g).pays;
  assert.ok(pays(bv, 'corn') > pays(blv, 'corn'), `corn: Bristol $${pays(bv, 'corn')} vs Blountstown $${pays(blv, 'corn')}`);
  assert.ok(pays(blv, 'fish') > pays(bv, 'fish') || pays(bv, 'fish') >= pays(blv, 'fish'));
  // Sell meals here, buy seeds.
  const cash0 = a.you.cash;
  a.send({ t: 'trade', contactId: cbl.id, action: 'sell', good: 'meals', qty: 'all' });
  await until(() => a.you.meals === 0 && a.you.cash === cash0 + fish * pays(blv, 'meals'));
  const seedPrice = blv.trade.shop.find((x) => x.id === 'seeds').price;
  const cash1 = a.you.cash;
  a.send({ t: 'trade', contactId: cbl.id, action: 'buy', item: 'seeds' });
  await until(() => a.you.seeds === 1 && a.you.cash === cash1 - seedPrice);
  // You can't buy what you can't afford.
  a.send({ t: 'trade', contactId: cbl.id, action: 'buy', item: 'medkit' });
  if (a.you.cash < 30) await a.toast(/That costs/);

  // Wildlife shows up around you out in the country.
  await a.tp(site.x, site.z);
  await until(() => a.snap?.bots?.some((x) => x.kind === 'deer' || x.kind === 'hog'), 6000);
});
