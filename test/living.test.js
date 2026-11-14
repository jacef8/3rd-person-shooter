// The living world: world events, NPCs you can trade with, player commerce (freight, stalls,
// face-to-face trades) and base defenses that work while you're offline.
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
async function until(fn, ms = 15000) {   // generous: the whole suite runs servers side by side
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzl-'));
let portBase = 25000 + Math.floor(Math.random() * 800);
const tool = (t) => ({ id: `t-${t}-${Math.random()}`, kind: 'tool', tool: t, name: t });
const hex = (s) => s.repeat(32 / s.length);
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [tool('hammer')] }, ammo: 400, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 200, tech: 100, intel: 0, salvage: 100, wood: 100, stone: 50, comms: 0, cash: 200, meat: 10, corn: 10, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
async function server(name, characters, env = {}) {
  const port = portBase++;
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', SAVE_EVERY_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  return { proc, port };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'contact') c.contact = m; if (m.t === 'worldEvents') c.events = m.list;
    if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'welcome') c.welcome = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
/** Open ground with room for several pieces in a row. */
function openGround(pieces) {
  for (const c of map.campSites) {
    const ok = pieces.every(([type, dx, dz]) => !placementProblem(world, type, c.x + dx, c.z + dz, 0, { x: c.x + dx, z: c.z + dz + 3 }));
    if (ok) return c;
  }
  return null;
}
const contactIn = (town) => map.contacts.find((c) => map.towns[c.townId].name === town);

test('world events: riot, county fair contest, market swing, hog hunt, convoy', async (t) => {
  const A = hex('a1'), B = hex('b2');
  const fairTown = contactIn('Blountstown');
  const srv = await server('events', { [A]: character('Ace', fairTown.x + 2, fairTown.z + 2), [B]: character('Bea', fairTown.x + 4, fairTown.z + 2, { meat: 4 }) });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Ace', A), b = await conn(srv.port, 'Bea', B);
  await until(() => a.you && b.you);

  // Riot: clear the rogues and the cache drops at the town square.
  a.send({ t: 'dev', event: 'riot' });
  const riot = (await until(() => a.events?.find((e) => e.type === 'riot'))).id;
  a.send({ t: 'dev', killEventBots: true, only: 'riot' });
  await until(() => !a.events.some((e) => e.id === riot));
  await a.got((m) => m.t === 'feed' && /Riot in .*: done/.test(m.text));

  // County fair: a safe zone and a hunting contest.
  a.send({ t: 'dev', event: 'fair' });
  const fair = await until(() => a.events?.find((e) => e.type === 'fair'));
  assert.equal(fair.town, 'Blountstown');
  b.send({ t: 'fairSubmit' });
  await b.toast(/Handed in 4 meat/);
  a.send({ t: 'fairSubmit' });
  await a.toast(/Handed in 10 meat/);
  // No shooting at the fair.
  a.send({ t: 'state', x: fairTown.x + 2, z: fairTown.z + 2, yaw: Math.atan2(2, 0), pitch: 0 });
  const cashA = a.you.cash, cashB = b.you.cash;
  a.send({ t: 'dev', endEvent: 'fair' });
  await until(() => a.you.cash === cashA + 300 + 10 * 3 && b.you.cash === cashB + 150 + 4 * 3);

  // Market swing: one post pays far more (or less) for one good.
  a.send({ t: 'dev', event: 'swing' });
  const sw = await until(() => a.events?.find((e) => e.type === 'swing'));
  assert.ok(sw.good && sw.mult && sw.town);

  // Hog hunt: a monster boar appears where the event is.
  await a.tp(fairTown.x + 400, fairTown.z + 400);
  a.send({ t: 'dev', event: 'hoghunt', x: a.you.x ?? fairTown.x + 400, z: fairTown.z + 400 });
  await until(() => a.events?.some((e) => e.type === 'hoghunt'));
  a.send({ t: 'dev', killEventBots: true, only: 'boar' });
  await a.got((m) => m.t === 'feed' && /Hog hunt.*: done/.test(m.text));

  // Convoy: the truck drives along SR 20.
  a.send({ t: 'dev', event: 'convoy' });
  const c0 = await until(() => a.events?.find((e) => e.type === 'convoy'));
  await sleep(2500);
  // Still running a couple of seconds later: the latest event list still has it.
  const lists = a.msgs.filter((m) => m.t === 'worldEvents');
  assert.ok(lists.at(-1).list.some((e) => e.type === 'convoy'), 'convoy still running');
  void c0;
});

test('NPCs and commerce: settlers trade, freight, player stalls, face-to-face trades', async (t) => {
  const A = hex('c3'), B = hex('d4');
  const bristol = contactIn('Bristol'), hosford = contactIn('Hosford');
  const spot = openGround([['stall', 0, 0]]);
  const srv = await server('commerce', { [A]: character('Sel', spot.x, spot.z + 3), [B]: character('Buy', spot.x + 2, spot.z + 3) });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Sel', A), b = await conn(srv.port, 'Buy', B);
  await until(() => a.you && b.you);

  // A settler at a farm or fish camp: walk up and trade.
  const homes = map.lootSpawns.filter((l) => l.zone === 'farm' || l.zone === 'lake').filter((_, i) => i % 6 === 0);
  const home = homes[0];
  await b.tp(home.x + 6, home.z + 6);
  const settler = await until(() => b.snap?.bots?.find((x) => x.kind === 'settler'), 6000);
  await b.tp(settler.x + 1, settler.z);
  b.send({ t: 'interact' });
  const view = await until(() => b.contact?.npc && b.contact);
  assert.ok(view.trade.shop.length);
  const item = view.trade.shop[0];
  const before = b.you.cash;
  b.send({ t: 'trade', npcId: view.npc, action: 'buy', item: item.id });
  await until(() => b.you.cash === before - item.price);

  // Freight: take a job in Bristol, deliver it in Hosford.
  await a.tp(bristol.x + 1.5, bristol.z);
  a.send({ t: 'interact' });
  const cv = await until(() => a.contact?.hauls && a.contact.id === bristol.id && a.contact);
  let job = cv.hauls.find((h) => h.toTown === 'Hosford');
  if (!job) job = cv.hauls[0];
  a.send({ t: 'haul', contactId: bristol.id, id: job.id });
  await until(() => a.you.inv.pack.some((i) => i.kind === 'cargo'));
  a.send({ t: 'extract' });
  await a.toast(/won't carry freight/);
  const dest = map.contacts.find((c) => map.towns[c.townId].name === job.toTown);
  const cash0 = a.you.cash;
  await a.tp(dest.x + 1.5, dest.z);
  a.send({ t: 'interact' });
  await until(() => a.you.cash === cash0 + job.pay && !a.you.inv.pack.some((i) => i.kind === 'cargo'));

  // A market stall: Sel lists corn, Buy buys it, Sel collects the till.
  await a.tp(spot.x, spot.z + 3);
  a.send({ t: 'build', piece: 'stall', x: spot.x, z: spot.z, rot: 0 });
  const stall = await until(() => a.snap?.structs.find((s) => s.type === 'stall'));
  a.send({ t: 'stall', id: stall.id, action: 'list', res: 'corn', qty: 5, price: 9 });
  await until(() => a.you.corn === 5);
  await b.tp(spot.x + 1.5, spot.z + 2.2);
  const bc = b.you.cash, bcorn0 = b.you.corn || 0;
  b.send({ t: 'stall', id: stall.id, action: 'buy', i: 0, qty: 'all' });
  await until(() => b.you.corn === bcorn0 + 5 && b.you.cash === bc - 45);
  await a.toast(/Buy bought 5 corn at your stall/);
  const ac = a.you.cash;
  a.send({ t: 'stall', id: stall.id, action: 'collect' });
  await until(() => a.you.cash === ac + 45);

  // Face to face: Sel gives $20 for 3 of Buy's corn.
  await b.tp(spot.x + 2, spot.z + 3);
  a.send({ t: 'ptrade', action: 'request', id: b.welcome.id });
  await b.got((m) => m.t === 'ptrade' && m.state === 'ask');
  b.send({ t: 'ptrade', action: 'accept' });
  await a.got((m) => m.t === 'ptrade' && m.state === 'open');
  a.send({ t: 'ptrade', action: 'offer', res: { cash: 20 }, items: [] });
  b.send({ t: 'ptrade', action: 'offer', res: { corn: 3 }, items: [] });
  await sleep(200);
  const [ac2, bc2, acorn, bcorn] = [a.you.cash, b.you.cash, a.you.corn, b.you.corn];
  a.send({ t: 'ptrade', action: 'confirm' });
  b.send({ t: 'ptrade', action: 'confirm' });
  await a.got((m) => m.t === 'ptrade' && m.state === 'closed' && /complete/.test(m.why));
  await until(() => a.you.cash === ac2 - 20 && b.you.cash === bc2 + 20 && a.you.corn === acorn + 3 && b.you.corn === bcorn - 3);
});

test('defenses guard your place while you are offline, and you hear about it when you are back', async (t) => {
  const O = hex('e5'), I = hex('f6');
  const spot = openGround([['tripwire', 0, 0], ['sentry', 6, 0], ['kennel', -6, 0], ['alarm', 0, 6]]);
  assert.ok(spot, 'room for a defended camp');
  const srv = await server('defense', { [O]: character('Owner', spot.x, spot.z + 3), [I]: character('Intruder', spot.x + 60, spot.z) });
  t.after(() => srv.proc.kill('SIGKILL'));
  let o = await conn(srv.port, 'Owner', O);
  const i = await conn(srv.port, 'Intruder', I);
  await until(() => o.you && i.you);
  for (const [piece, dx, dz] of [['tripwire', 0, 0], ['sentry', 6, 0], ['kennel', -6, 0], ['alarm', 0, 6]]) {
    await o.tp(spot.x + dx, spot.z + dz + 3);
    o.send({ t: 'build', piece, x: spot.x + dx, z: spot.z + dz, rot: 0 });
    await sleep(150);
  }
  await until(() => ['tripwire', 'sentry', 'kennel', 'alarm'].every((k) => o.snap?.structs.some((s) => s.type === k)), 6000);
  const sentry = o.snap.structs.find((s) => s.type === 'sentry'), kennel = o.snap.structs.find((s) => s.type === 'kennel');
  // Load the sentry and feed the dog.
  await o.tp(spot.x + 6, spot.z + 1.2);
  o.send({ t: 'interact' });
  await o.toast(/Loaded \d+ rounds/);
  await o.tp(spot.x - 6, spot.z + 1.4);
  o.send({ t: 'interact' });
  await o.toast(/Fed the kennel \d+ meat/);
  // Owner logs off.
  await o.close();
  await sleep(300);
  // The intruder walks into the camp across the wire.
  await i.tp(spot.x, spot.z - 2);
  for (let k = 0; k < 10; k++) { i.send({ t: 'state', x: spot.x, z: spot.z - 2 + k * 0.4, yaw: 0, pitch: 0 }); await sleep(60); }
  await i.got((m) => m.t === 'stunned', 4000);
  // The sentry and the dog go to work.
  await until(() => i.you.hp < 100, 8000);
  await until(() => i.snap?.bots?.some((x) => x.kind === 'dog'), 6000);
  await sleep(800);
  // The owner comes back and hears what happened.
  o = await conn(srv.port, 'Owner', O);
  const log = await o.got((m) => m.t === 'awayLog', 6000);
  const text = log.entries.map((e) => e.text).join(' | ');
  assert.match(text, /Intruder tripped your wire/);
  assert.match(text, /sentry is firing at Intruder|dog is going after Intruder|Motion alarm/);
  void sentry; void kennel;
});
