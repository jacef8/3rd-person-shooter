// Phase 2: boats on the Apalachicola, landings, river freight, boat theft and sinking, swamp camps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { floats, stepBoat, BOATS } from '../shared/boats.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzr-'));
let portBase = 26000 + Math.floor(Math.random() * 800);
const hex = (s) => s.repeat(32 / s.length);
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 400, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 50, intel: 0, salvage: 50, wood: 100, stone: 0, comms: 0, cash: 2000, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
async function server(name, characters, env = {}) {
  const port = portBase++;
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 8, size: 30000, houses: {}, bags: [], structures: [], characters }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', SAVE_EVERY_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  return { proc, port, file };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'contact') c.contact = m; if (m.t === 'dock') c.dock = m; if (m.t === 'container') c.container = m;
    if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'welcome') c.welcome = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}
/** A dry spot right by a landing's mooring, to step into a boat from. */
const bankBy = (d) => ({ x: d.wx + d.nx * 3, z: d.wz + d.nz * 3 });
const myBoat = (c) => c.snap?.boats?.find((b) => b.mine);

test('the map has river landings and swamp camps on the Apalachicola', () => {
  const names = map.docks.map((d) => d.name);
  for (const n of ['Bristol Landing', 'Blountstown Landing', 'Estiffanulga Landing']) assert.ok(names.includes(n), n);
  assert.ok(map.camps.length >= 2, 'swamp camps');
  for (const d of map.docks) {
    assert.ok(floats(map.terrain, d.wx, d.wz), `${d.name} mooring floats`);
    assert.ok(!floats(map.terrain, d.x, d.z), `${d.name} post is on dry land`);
  }
  for (const c of map.camps) {
    assert.ok(map.docks[c.dockId].campId === c.id);
    assert.equal(c.shacks.length, 3);
    for (const id of c.shacks) assert.equal(map.houses[id].kind, 'shack');
  }
  // A boat runs aground at the bank and can pass under the SR 20 bridge.
  const d = map.docks[0];
  let b = { type: 'jonboat', x: d.wx, z: d.wz, yaw: Math.atan2(d.nx, d.nz), speed: 0 };
  for (let i = 0; i < 100; i++) b = { ...b, ...stepBoat(map.terrain, b, { throttle: 1 }, 0.05) };
  assert.ok(floats(map.terrain, b.x, b.z), 'still afloat after ramming the bank');
  const br = map.bridges[0];
  assert.ok(floats(map.terrain, br.x, br.z), 'channel under the bridge');
  assert.ok(BOATS.jonboat.hold > BOATS.airboat.hold);
});

test('buy a boat, drive it, haul river freight landing to landing', async (t) => {
  const A = hex('a7');
  const home = map.docks.find((d) => d.name === 'Bristol Landing');
  const srv = await server('freight', { [A]: character('Skipper', home.x, home.z) });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Skipper', A);
  await until(() => a.you);
  // The landing post: boats for sale, freight on offer.
  a.send({ t: 'interact' });
  const view = await until(() => a.dock);
  assert.equal(view.name, 'Bristol Landing');
  assert.ok(view.shop.some((s) => s.type === 'jonboat') && view.shop.some((s) => s.type === 'airboat'));
  assert.ok(view.freight.length >= 1);
  // Build a jon boat from wood and parts.
  a.send({ t: 'dock', id: home.id, action: 'buy', type: 'jonboat', pay: 'craft' });
  await a.toast(/jon boat is in the water/);
  await until(() => a.you.wood === 60 && a.you.parts === 70);
  const boat = await until(() => myBoat(a));
  // Take a freight job: it goes into the hold.
  const job = view.freight[0];
  a.send({ t: 'dock', id: home.id, action: 'freight', job: job.id });
  await a.toast(/loaded into your jon boat/);
  // Step into the boat from the bank.
  const bank = bankBy(home);
  await a.tp(bank.x, bank.z);
  a.send({ t: 'interact' });
  await until(() => a.you.boat?.id === boat.id && a.you.boat.seat === 0);
  // The hold: bulk freight can't be carried off by hand.
  a.send({ t: 'boatHold' });
  const hold = await until(() => a.container?.kind === 'boat' && a.container);
  const crate = hold.items.find((i) => i.bulk);
  assert.ok(crate, 'freight in the hold');
  a.send({ t: 'container', action: 'take', itemId: crate.id });
  await a.toast(/too heavy to carry/);
  a.send({ t: 'closeContainer' });
  // Drive out into the channel: the server moves the boat (and its driver).
  let b = { type: 'jonboat', x: boat.x, z: boat.z, yaw: Math.atan2(-home.nx, -home.nz), speed: 0 };
  for (let i = 0; i < 40; i++) {
    b = { ...b, ...stepBoat(map.terrain, b, { throttle: 1 }, 0.05) };
    a.send({ t: 'state', x: b.x, z: b.z, yaw: b.yaw, pitch: 0, boat: { x: b.x, z: b.z, yaw: b.yaw } });
    await sleep(50);
  }
  const moved = await until(() => { const s = myBoat(a); return s && Math.hypot(s.x - boat.x, s.z - boat.z) > 5 && s; });
  assert.ok(floats(map.terrain, moved.x, moved.z));
  // Trying to drive up onto land gets refused.
  a.send({ t: 'state', x: home.x, z: home.z, yaw: 0, pitch: 0, boat: { x: moved.x + home.nx * 0.8, z: moved.z + home.nz * 0.8, yaw: 0 } });
  for (let i = 0; i < 30; i++) { a.send({ t: 'state', x: 0, z: 0, yaw: 0, pitch: 0, boat: { x: home.x, z: home.z, yaw: 0 } }); await sleep(50); }
  await a.got((m) => m.t === 'boatFix');
  const still = myBoat(a);
  assert.ok(floats(map.terrain, still.x, still.z), 'boat stays on the water');
  // Run down to the destination landing and step off.
  const dest = map.docks[job.to];
  a.send({ t: 'dev', boatTo: dest.id });
  await until(() => { const s = myBoat(a); return s && Math.hypot(s.x - dest.wx, s.z - dest.wz) < 1; });
  a.send({ t: 'interact' });
  await until(() => !a.you.boat);
  await sleep(200);
  const cash = a.you.cash;
  await a.tp(dest.x, dest.z);
  a.send({ t: 'interact' });
  await a.toast(/Delivered 1 load of river freight/);
  await until(() => a.you.cash === cash + job.pay);
});

test('boats get stolen and sunk; swamp camps trade and are safe ground', async (t) => {
  const O = hex('b8'), T = hex('c9'), S = hex('d0');
  const camp = map.camps[0], cd = map.docks[camp.dockId];
  const bank = bankBy(cd);
  const srv = await server('camp', {
    [O]: character('Owner', cd.x, cd.z), [T]: character('Thief', bank.x + 1, bank.z), [S]: character('Shooter', camp.x + 2, camp.z + 2),
  });
  t.after(() => srv.proc.kill('SIGKILL'));
  let o = await conn(srv.port, 'Owner', O);
  await until(() => o.you);
  // Buy an airboat at the camp landing and walk away (log off).
  o.send({ t: 'interact' });
  await until(() => o.dock);
  assert.equal(o.dock.camp, camp.name);
  o.send({ t: 'dock', id: cd.id, action: 'buy', type: 'airboat' });
  await o.toast(/airboat is in the water/);
  const boat = await until(() => myBoat(o));
  await o.close();
  // A stranger hotwires it.
  const th = await conn(srv.port, 'Thief', T);
  await until(() => th.you);
  await th.tp(bank.x, bank.z);
  th.send({ t: 'interact' });
  await th.got((m) => m.t === 'hack' && m.kind === 'hotwire');
  await until(() => th.you.boat?.id === boat.id, 14000);
  // The owner hears about it on the way back in.
  o = await conn(srv.port, 'Owner', O);
  const log = await o.got((m) => m.t === 'awayLog', 6000);
  assert.match(log.entries.map((e) => e.text).join(' | '), /Thief stole your airboat/);

  // The camp: no shooting here, and the camp trader deals in honey, moonshine and hides.
  const sh = await conn(srv.port, 'Shooter', S);
  await until(() => sh.you && sh.snap);
  const tr = await until(() => sh.snap?.bots?.find((b) => b.kind === 'trader'), 6000);
  await sh.tp(tr.x + 1.2, tr.z);
  sh.send({ t: 'interact' });
  const tv = await until(() => sh.contact?.npc && sh.contact);
  assert.equal(tv.trade.town, camp.name);
  const honey = tv.trade.shop.find((x) => x.id === 'honey');
  assert.ok(honey && tv.trade.shop.some((x) => x.id === 'shine'));
  const c0 = sh.you.cash;
  sh.send({ t: 'trade', npcId: tv.npc, action: 'buy', item: 'honey' });
  await until(() => sh.you.honey === 1 && sh.you.cash === c0 - honey.price);
  const partsRow = tv.trade.sells.find((x) => x.good === 'parts');
  sh.send({ t: 'trade', npcId: tv.npc, action: 'sell', good: 'parts', qty: 'all' });
  await until(() => sh.you.parts === 0 && sh.you.cash === c0 - honey.price + 100 * partsRow.pays);
  // Shots inside the camp do nothing to people.
  await o.tp(camp.x + 5, camp.z);
  await sh.tp(camp.x, camp.z);
  await sleep(300);
  for (let i = 0; i < 5; i++) { sh.send({ t: 'shoot', dir: [1, -0.1, 0] }); await sleep(150); }
  await sleep(300);
  assert.equal(o.you.hp, 100, 'nobody gets hurt at the camp');

  // Out on the river the boat can be shot, and sunk.
  const thiefBoat = myBoat(th);
  const before = thiefBoat.hp;
  sh.send({ t: 'dev', boatDamage: 40, boatId: boat.id });
  await until(() => myBoat(th)?.hp === before - 40);
  sh.send({ t: 'dev', boatDamage: 999, boatId: boat.id });
  await th.toast(/boat went down/);
  await until(() => !th.you.boat && !th.snap.boats.some((b) => b.id === boat.id));
});
