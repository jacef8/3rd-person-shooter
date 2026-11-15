// Hot zones: announced, then open with crates of top gear. What you take is hot: everyone is shown
// where you are until you get it home, the taxi won't carry it, and home makes it yours for good.
// A hot-drop flare parachutes you in at the zone's edge.
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
const HZ = ACT.hotZone;

test('a hot zone: crate loot is hot, pinged, refused by the taxi, and secured at home; a hot-drop flare drops you at its edge', async (t) => {
  const h = map.houses.find((x) => x.kind === 'house');
  const A = 'b1'.repeat(16), B = 'b2'.repeat(16);
  const person = (name, x, z, pack = []) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), cash: 1000, comms: 0, food: 90, field: [], discovered: [], contracts: [] });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzhot-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [],
    houses: { [h.id]: { owner: A, ownerName: 'Raider', items: [], doorHp: 100, upg: {} } },
    characters: { [A]: person('Raider', h.x, h.z), [B]: person('Jumper', h.x + 40, h.z + 40, [{ id: 'hf1', kind: 'hotflare', name: 'Hot-drop flare' }]) } }));
  const port = 31600 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0',
    HOTZONE_FIRST_MS: '300', HOTZONE_WARN_MS: '700', HOTZONE_OPEN_MS: '120000', HOTZONE_CRATE_MS: '400', HOTZONE_PING_MS: '1500', HOTZONE_GUARDS: '0', HOTDROP_WAIT_MS: '500', JUMP_ALT: '60',
    EVENT_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', TAXI_WAIT_MS: '400' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const join = async (name, token) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'hotzone') c.hz = m.zone; if (m.t === 'correct' && m.force) c.at = m; if (m.t === 'air') c.air = m; });
    await new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.toast = (re, ms) => until(() => c.msgs.find((m) => m.t === 'toast' && re.test(m.text)), ms);
    c.send({ t: 'join', name, token });
    await until(() => c.you && !c.you.dead);
    return c;
  };
  const a = await join('Raider', A), b = await join('Jumper', B);
  // Announced first, then open with its crates and pickup point.
  await until(() => a.hz && !a.hz.open);
  const hz = await until(() => a.hz?.open && a.hz.crates.length && a.hz.extract && a.hz);
  assert.equal(hz.radius, HZ.radius);
  // Fast travel can't land you near it (the house is far away from most zones; check the rule directly via a respawn-less travel attempt is covered by toasts in play).
  // The hot drop: B fires the flare away from the zone and is dropped by parachute at its edge.
  let open = null;
  for (let r = 200; r < 3000 && !open; r += 100) for (let k = 0; k < 16 && !open; k++) {
    const x = h.x + Math.cos(k) * r, z = h.z + Math.sin(k) * r;
    if (map.terrain.height(x, z) > 1 && !map.buildings.some((q) => x > q.minX - 6 && x < q.maxX + 6 && z > q.minZ - 6 && z < q.maxZ + 6) && Math.hypot(x - hz.x, z - hz.z) > 2000) open = { x, z };
  }
  b.send({ t: 'dev', x: open.x, z: open.z });
  await sleep(400);
  b.send({ t: 'inv', action: 'hotdrop', itemId: 'hf1' });
  await b.toast(/Hot-drop flare lit/);
  await until(() => b.air && b.air.heli);
  const edge = Math.hypot(b.at.x - hz.x, b.at.z - hz.z);
  assert.ok(edge > hz.radius && edge < hz.radius + HZ.hotDrop.edge + 40, `dropped ${Math.round(edge)} m from the middle`);
  // A walks up to a crate and opens it: the loot is hot, and B is shown where A is.
  const c0 = hz.crates[0];
  a.send({ t: 'dev', x: c0.x + 1, z: c0.z });
  await sleep(500);
  a.send({ t: 'interact' });
  await until(() => a.you.inv.pack.some((i) => i.hot));
  assert.ok(a.you.inv.pack.some((i) => i.kind === 'lockbox' && i.hot), 'a hot lockbox');
  assert.ok(a.you.inv.pack.some((i) => i.kind === 'weapon' && i.hot), 'a hot gun');
  await until(() => b.msgs.some((m) => m.t === 'alert' && m.hot));
  await until(() => a.hz.crates.find((c) => c.id === c0.id).opened);
  // The taxi won't carry it.
  const lz = map.landingZones[0];
  a.send({ t: 'dev', x: lz.x, z: lz.z });
  await sleep(500);
  a.send({ t: 'taxi', action: 'call', to: `ct${map.contacts[0].id}` });
  await a.toast(/won't carry hot loot|won't land this close/);
  // Home: it's yours for good, and the lockbox opens into your supplies.
  const cash = a.you.cash;
  a.send({ t: 'dev', x: h.crate.x + 1, z: h.crate.z });
  await a.toast(/Hot loot secured/);
  await until(() => !a.you.inv.pack.some((i) => i.hot) && a.you.cash > cash);
  assert.ok(a.you.inv.pack.some((i) => i.kind === 'weapon' && /hot-zone build/.test(i.name)), 'kept the gun');
  // The taxi to the stop nearest the zone drops you at least a mile out from it.
  await until(() => b.air && b.air.mode === null, 30000);
  const stops = [...map.landingZones.map((l) => ({ id: `lz${l.id}`, x: l.x, z: l.z })), ...map.contacts.map((c) => ({ id: `ct${c.id}`, x: c.x, z: c.z }))];
  const d = (q) => Math.hypot(q.x - hz.x, q.z - hz.z);
  const nearest = stops.reduce((m, q) => (d(q) < d(m) ? q : m)), from = stops.reduce((m, q) => (d(q) > d(m) ? q : m));
  b.send({ t: 'dev', x: map.landingZones.find((l) => `lz${l.id}` === from.id)?.x ?? from.x + 2, z: map.landingZones.find((l) => `lz${l.id}` === from.id)?.z ?? from.z + 2 });
  await sleep(500);
  b.air = null;
  b.send({ t: 'taxi', action: 'call', to: nearest.id });
  await until(() => b.air && b.air.heli, 15000);
  assert.ok(Math.hypot(b.at.x - hz.x, b.at.z - hz.z) >= HZ.keepOutM, `taxi dropped ${Math.round(Math.hypot(b.at.x - hz.x, b.at.z - hz.z))} m from the zone`);
});
