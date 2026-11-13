// Nothing a client sends can crash the world or corrupt someone else's goods, and the loopholes the
// design review found (stall wipes, poisoned trades, bottomless camp stock) stay closed.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzh-'));
const hex = (s) => s.repeat(32 / s.length);
const tool = (t) => ({ id: `t-${t}-${Math.random()}`, kind: 'tool', tool: t, name: t });
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [tool('hammer'), tool('rod')] }, ammo: 200, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 50, intel: 0, salvage: 100, wood: 100, stone: 20, comms: 0, cash: 1000, corn: 20, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') { c.snap = m; c.snaps = (c.snaps || 0) + 1; } if (m.t === 'contact') c.contact = m; if (m.t === 'ptrade') c.trade = m;
    if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'welcome') c.welcome = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.raw = (text) => ws.send(text);
  c.toast = (re, ms) => until(() => c.msgs.find((m) => m.t === 'toast' && re.test(m.text)), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}
/** Press E until something happens (a stray loot item at your feet can take the first press). */
async function press(c, done, ms = 9000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { c.send({ t: 'interact' }); for (let k = 0; k < 28; k++) { const v = done(); if (v) return v; await sleep(25); } }
  throw new Error('timed out pressing E');
}
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };

test('malformed and hostile messages are shrugged off; stalls, trades and camp stock hold up', async (t) => {
  const A = hex('a9'), B = hex('b9');
  const spot = map.campSites.find((c) => !placementProblem(world, 'stall', c.x, c.z, 0, { x: c.x, z: c.z + 3 }));
  const port = 28300 + Math.floor(Math.random() * 500), file = path.join(dir, 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 9, size: 30000, houses: {}, bags: [], structures: [], characters: { [A]: character('Keeper', spot.x, spot.z + 3), [B]: character('Prowler', spot.x + 2, spot.z + 3) } }));
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => proc.kill('SIGKILL'));
  let exited = false, errors = '';
  proc.on('exit', () => { exited = true; });
  proc.stderr.on('data', (d) => { errors += d; });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const a = await conn(port, 'Keeper', A), b = await conn(port, 'Prowler', B);
  await until(() => a.you && b.you && a.snap && b.snap);

  // Keeper sets up a stall with corn on it.
  a.send({ t: 'build', piece: 'stall', x: spot.x, z: spot.z, rot: 0 });
  const stall = await until(() => a.snap?.structs.find((s) => s.type === 'stall'));
  a.send({ t: 'stall', id: stall.id, action: 'list', res: 'corn', qty: 10, price: 9 });
  await until(() => a.you.corn === 10);

  // Prowler throws everything at the server.
  const bristol = map.contacts[0];
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', -1, 1e9, 1.5, null, {}, []]) {
    b.send({ t: 'stall', id: stall.id, action: 'buy', i: bad, qty: 'all' });
    b.send({ t: 'stall', id: stall.id, action: 'unlist', i: bad });
    b.send({ t: 'trade', contactId: bad, action: 'buy', item: bad });
    b.send({ t: 'trade', contactId: bristol.id, action: 'buy', item: bad });
    b.send({ t: 'trade', npcId: bad, action: 'buy', item: bad });
    b.send({ t: 'dock', id: bad, action: 'buy', type: bad });
    b.send({ t: 'dock', id: 0, action: 'buy', type: bad });
    b.send({ t: 'gunsmith', action: 'attach', itemId: b.you.inv.primary.id, slot: bad, partId: bad });
    b.send({ t: 'gunsmith', action: 'paint', itemId: b.you.inv.primary.id, paint: bad });
    b.send({ t: 'gunsmith', action: 'build', type: bad });
    b.send({ t: 'build', piece: bad, x: spot.x + 8, z: spot.z, rot: 0 });
    b.send({ t: 'craft', item: bad });
    b.send({ t: 'requisition', contactId: bad, kind: bad, id: bad });
    b.send({ t: 'upgrade', track: bad });
    b.send({ t: 'travel', id: bad, kind: bad });
    b.send({ t: 'haul', contactId: bad, id: bad });
    b.send({ t: 'ptrade', action: 'offer', res: bad, items: bad });
    b.send({ t: 'squad', action: bad, id: bad });
    b.send({ t: 'mark', id: bad });
    b.send({ t: 'container', action: 'take', res: bad, itemId: bad });
  }
  for (const text of ['null', '[]', '"x"', '42', '{"t":{}}', '{"t":"state","x":"NaN"}', 'not json']) b.raw(text);
  // The world is still running, and nothing was bought, broken or turned into nonsense.
  const n0 = b.snaps;
  await until(() => b.snaps > n0 + 3);
  assert.equal(exited, false, `server survived (stderr: ${errors.slice(0, 300)})`);
  assert.equal(errors, '', 'and none of it even raised an error');
  assert.equal(b.you.cash, 1000);
  for (const k of ['cash', 'corn', 'parts', 'ammo']) assert.ok(Number.isFinite(b.you[k]), `${k} is still a number`);
  // The stall's listing and till are intact: an honest sale still works to the cent.
  await b.tp(spot.x + 1.5, spot.z + 2.2);
  b.send({ t: 'stall', id: stall.id, action: 'buy', i: 0, qty: 4 });
  await until(() => b.you.corn === 24 && b.you.cash === 1000 - 36);
  a.send({ t: 'stall', id: stall.id, action: 'collect' });
  await until(() => a.you.cash === 1000 + 36);

  // A face-to-face trade can't offer the same item twice (that used to leave a hole in the other pack).
  const rod = a.you.inv.pack.find((i) => i.tool === 'rod');
  await b.tp(spot.x + 2, spot.z + 3);
  a.send({ t: 'ptrade', action: 'request', id: b.welcome.id });
  await until(() => b.trade?.state === 'ask');
  b.send({ t: 'ptrade', action: 'accept' });
  await until(() => a.trade?.state === 'open');
  a.send({ t: 'ptrade', action: 'offer', res: {}, items: [rod.id, rod.id, rod.id] });
  await sleep(200);
  a.send({ t: 'ptrade', action: 'confirm' });
  b.send({ t: 'ptrade', action: 'confirm' });
  await until(() => a.trade?.state === 'closed');
  await until(() => b.you.inv.pack.filter((i) => i && i.id === rod.id).length === 1);
  assert.ok(a.you.inv.pack.every(Boolean) && b.you.inv.pack.every(Boolean), 'no holes in either backpack');
  assert.equal(a.you.inv.pack.filter((i) => i.id === rod.id).length, 0);

  // Packing up (or wrecking) a stall spills its goods and till instead of deleting them.
  await a.tp(spot.x, spot.z + 3);
  a.send({ t: 'dismantle', id: stall.id });
  const bag = await until(() => a.snap.bags.find((g) => /Stall goods/.test(g.label)));
  assert.ok(bag, 'the 6 corn left on the stall is in a bag');

  // Road freight pays what the data file says: base + distance x rate.
  await a.tp(bristol.x + 1.5, bristol.z);
  const view = await press(a, () => a.contact?.hauls?.length && a.contact);
  for (const h of view.hauls) {
    const to = map.contacts.find((c) => map.towns[c.townId].name === h.toTown), km = Math.hypot(to.x - bristol.x, to.z - bristol.z) / 1000;
    assert.equal(h.pay, Math.round(25 + km * 15), `freight to ${h.toTown}`);
  }

  // A swamp camp only has so much to sell.
  const camp = map.camps[0];
  await b.tp(camp.x + 2, camp.z + 2);
  const trader = await until(() => b.snap?.bots?.find((x) => x.kind === 'trader'), 6000);
  await b.tp(trader.x + 1.2, trader.z);
  b.contact = null;
  const tv = await press(b, () => b.contact?.npc && b.contact);
  assert.ok(!tv.trade.sells.some((x) => x.good === 'meals'), 'camps do not buy cooked meals');
  assert.match(tv.trade.shop.find((x) => x.id === 'shine').name, /\(40 left\)/);
  for (let k = 0; k < 45; k++) b.send({ t: 'trade', npcId: tv.npc, action: 'buy', item: 'shine' });
  await b.toast(/Sold out for now/);
  await until(() => b.you.shine === 40);   // forty jars, then the shelf is bare
  await sleep(300);
  assert.equal(b.you.shine, 40);
  assert.equal(exited, false);
});
