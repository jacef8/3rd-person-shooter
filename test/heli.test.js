// The helicopter: a taxi between landing zones, Contacts and the airstrip for a fare, and the rescue
// flare that calls the extraction helicopter home from anywhere in the open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import ACT from '../shared/data/activities.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const T = ACT.airTaxi;

async function world(characters, extra = {}, env = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzheli-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters, ...extra }));
  const port = 29100 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', TAXI_WAIT_MS: '600', EXTRACT_HOLD_MS: '500', EVENT_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', JUMP_ALT: '70', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  return { proc, port };
}
async function join(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'taxiMenu') c.menu = m; if (m.t === 'correct' && m.force) c.at = m; if (m.t === 'welcome') c.id = m.id; if (m.t === 'air') c.air = m; });
  await new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.toast = (re) => until(() => c.msgs.find((m) => m.t === 'toast' && re.test(m.text)));
  c.send({ t: 'join', name, token });
  await until(() => c.you);
  return c;
}
const person = (name, x, z, extra = {}) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(4), cash: 500, comms: 0, food: 90, field: [], discovered: [], contracts: [], ...extra });

test('the helicopter taxi flies you between pads for a fare; leaving the pad sends it back', async (t) => {
  const lz = map.landingZones[0], dest = map.contacts[0];
  const A = 'c1'.repeat(16);
  const srv = await world({ [A]: person('Flyer', lz.x, lz.z) });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await join(srv.port, 'Flyer', A);
  // E on the landing zone opens the helicopter menu, with a fare to every other pad.
  a.send({ t: 'interact' });
  const menu = await until(() => a.menu);
  const to = menu.dests.find((d) => d.id === `ct${dest.id}`);
  const fare = Math.round(T.baseFare + T.perMile * Math.hypot(dest.x - lz.x, dest.z - lz.z) / 1609.344);
  assert.equal(to.fare, fare);
  // Call it, then walk off the pad: it turns back and nothing is charged.
  a.send({ t: 'taxi', action: 'call', to: to.id });
  await a.toast(/lands in/);
  a.send({ t: 'dev', x: lz.x + 200, z: lz.z });
  await a.toast(/turned back/);
  assert.equal(a.you.cash, 500);
  // Back on the pad, call again and wait: flown to the Contact, fare paid.
  a.send({ t: 'dev', x: lz.x, z: lz.z });
  await sleep(300);
  a.send({ t: 'taxi', action: 'call', to: to.id });
  await a.toast(/Jump! You're over .* of /);
  await until(() => a.you.cash === 500 - fare);
  // Never on the stop itself: a random open spot out from it, so nobody can camp the drop.
  const off = Math.hypot(a.at.x - dest.x, a.at.z - dest.z);   // where you jumped
  assert.ok(off >= T.dropMin - 5 && off <= T.dropMax + 5, `dropped ${Math.round(off)} m out from the Contact`);
  // Down by parachute, then walk in to the Contact: the pilot needs a while before the next trip.
  await until(() => a.air && a.air.mode === null, 20000);
  a.send({ t: 'dev', x: dest.x + 2, z: dest.z + 2 });
  await sleep(300);
  a.send({ t: 'taxi', action: 'menu' });
  await until(() => a.menu.readyIn > 0);
});

test('a rescue flare calls the helicopter home from the open, and is used up', async (t) => {
  const h = map.houses.find((x) => x.kind === 'house' || x.kind === 'cave');
  const A = 'd2'.repeat(16);
  // Out in the open, well away from any building.
  let spot = null;
  for (let r = 300; r < 4000 && !spot; r += 100) for (let k = 0; k < 16 && !spot; k++) {
    const x = h.x + Math.cos(k) * r, z = h.z + Math.sin(k) * r;
    if (map.terrain.height(x, z) > 1 && !map.buildings.some((b) => x > b.minX - 5 && x < b.maxX + 5 && z > b.minZ - 5 && z < b.maxZ + 5)) spot = { x, z };
  }
  const flare = { id: 'fl-test', kind: 'flare', name: 'Rescue flare' };
  const srv = await world({ [A]: person('Stranded', spot.x, spot.z, { inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [flare] } }) },
    { houses: { [h.id]: { owner: A, ownerName: 'Stranded', items: [], doorHp: 100, upg: {} } } });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await join(srv.port, 'Stranded', A);
  a.send({ t: 'inv', action: 'flare', itemId: flare.id });
  await a.toast(/Flare up at a rescue flare/);
  await until(() => !a.you.inv.pack.some((i) => i.id === flare.id));   // burning: one use
  await until(() => a.msgs.some((m) => m.t === 'extracted'));
  assert.ok(Math.hypot(a.at.x - h.x, a.at.z - h.z) < 12, 'flown home to the stash house');
});

test('jumping from the taxi: freefall, pull the chute, get shot on the way down, land on open ground', async (t) => {
  const lz = map.landingZones[0], dest = map.contacts[0];
  const A = 'e3'.repeat(16), B = 'f4'.repeat(16);
  const gun = makeWeapon('carbine');
  const srv = await world({ [A]: person('Jumper', lz.x, lz.z, { xp: xpForLevel(6) }), [B]: person('Spotter', dest.x + 900, dest.z, { inv: { primary: gun, primary2: null, secondary: null, armor: null, pack: [] }, mags: { [gun.id]: 30 } }) });
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await join(srv.port, 'Jumper', A);
  const b = await join(srv.port, 'Spotter', B);
  a.send({ t: 'taxi', action: 'call', to: `ct${dest.id}` });
  await a.toast(/Jump!/);
  await until(() => a.air && a.air.mode === 'fall' && a.air.alt === 70 && a.air.heli);
  // Up in the air: no shooting, and Use pulls the chute.
  a.send({ t: 'interact' });
  await until(() => a.air.mode === 'chute');
  // Someone on the ground 25 m off sees you up there and shoots.
  const at = { ...a.at };
  b.send({ t: 'dev', x: at.x + 25, z: at.z });
  const seen = await until(() => b.msgs.findLast((m) => m.t === 'snap' && m.players.some((p) => p.id === a.id && p.alt > 10))?.players.find((p) => p.id === a.id));
  assert.equal(seen.air, 'chute');
  await sleep(200);
  const by = b.at;
  const oy = map.terrain.height(by.x, by.z) + 1.6;   // the shooter's eye
  for (let i = 0; i < 25 && a.you.hp >= 100; i++) {
    const s = b.msgs.findLast((m) => m.t === 'snap' && m.players.some((p) => p.id === a.id))?.players.find((p) => p.id === a.id) || seen;
    const sy = map.terrain.height(s.x, s.z) + (s.alt || 0) + 1;
    const dx = s.x - by.x, dy = sy - oy, dz = s.z - by.z, l = Math.hypot(dx, dy, dz);
    b.send({ t: 'state', tp: by.tp, x: by.x, z: by.z, yaw: Math.atan2(dx, dz), pitch: Math.asin(dy / l), aim: true });   // aiming down the sights
    b.send({ t: 'shoot', dir: [dx / l, dy / l, dz / l], at: [s.x, sy, s.z], tid: a.id });
    await sleep(250);
  }
  await until(() => a.you.hp < 100, 4000);   // hit in the air
  // Down under the canopy, onto open ground.
  await until(() => a.air && a.air.mode === null, 20000);
  const landed = a.at;
  assert.ok(map.terrain.height(landed.x, landed.z) > 0, 'landed on dry ground');
  assert.ok(!map.buildings.some((bb) => landed.x > bb.minX && landed.x < bb.maxX && landed.z > bb.minZ && landed.z < bb.maxZ), 'not inside a building');
});
