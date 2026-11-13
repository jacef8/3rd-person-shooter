// End-to-end: boots the real server, connects two clients over WebSocket and checks the core loop:
// an offline-proof stash house can be breached and looted by another player, PvP damage works,
// and everything survives a server restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon } from '../shared/items.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-'));
const DATA_FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const h = map.houses[0];
const TOK_A = 'a'.repeat(32), TOK_B = 'b'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function character(name, x, z, inv, extra = {}) {
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv, ammo: 400, mags: {}, active: 'primary', dead: false, kills: 0, ...extra };
}

const relic = makeWeapon('carbine', 'relic');
const lmg = makeWeapon('lmg', 'relic');
const seed = {
  seed: 1337,
  characters: {
    [TOK_A]: character('Alice', h.x + 3, h.crate.z + 2, { primary: null, secondary: makeWeapon('sidearm', 'scrap'), armor: null, pack: [] }, { active: 'secondary' }),
    [TOK_B]: character('Bob', h.x, h.door.maxZ + 3, { primary: lmg, secondary: null, armor: null, pack: [] }, { mags: { [lmg.id]: 80 } }),
  },
  houses: Object.fromEntries(map.houses.map((x) => [x.id, { owner: null, ownerName: null, doorHp: 300, doorOpen: false, items: [] }])),
  bags: [],
};
seed.houses[0] = { owner: TOK_A, ownerName: 'Alice', doorHp: 300, doorOpen: false, items: [relic] };
fs.writeFileSync(DATA_FILE, JSON.stringify(seed));

function startServer() {
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_FILE, BOTS: '0', DOOR_HP: '300' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) resolve(proc); }));
}

function client(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [], you: null, welcome: null, container: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.t === 'you') c.you = m;
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'container') c.container = m;
    if (m.t === 'snap') c.snap = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  return new Promise((resolve) => ws.on('open', () => { c.send({ t: 'join', name, token }); resolve(c); }));
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('stash house breach, loot, PvP and persistence', async (t) => {
  let server = await startServer();
  t.after(() => server.kill('SIGKILL'));

  const alice = await client('Alice', TOK_A);
  const bob = await client('Bob', TOK_B);
  await until(() => alice.welcome && bob.welcome && bob.you);
  assert.equal(alice.welcome.houseId, 0, 'Alice keeps her stash house');
  assert.notEqual(bob.welcome.houseId, 0);

  // Bob can't open Alice's door.
  for (let z = h.door.maxZ + 3; z >= h.door.maxZ + 1; z -= 0.2) {
    bob.send({ t: 'state', x: h.x, z, yaw: Math.PI, pitch: 0 });
    await sleep(50);
  }
  bob.send({ t: 'interact' });
  await until(() => bob.msgs.some((m) => m.t === 'toast' && /Locked/.test(m.text)));

  // Bob shoots the door down.
  const bz = h.door.maxZ + 1;
  const doorZ = (h.door.minZ + h.door.maxZ) / 2;
  const breached = () => bob.snap?.houses[0].hp === 0;
  for (let i = 0; i < 120 && !breached(); i++) {
    bob.send({ t: 'shoot', dir: [0, 1.3 - 1.6, doorZ - bz] });
    await sleep(115);
  }
  await until(breached);
  await until(() => alice.msgs.some((m) => m.t === 'toast' && /breached/.test(m.text)));

  // Bob walks inside to the crate, respecting the speed limit.
  let z = bz;
  while (z > h.crate.z + 1.2) {
    z = Math.max(h.crate.z + 1.2, z - 0.2);
    bob.send({ t: 'state', x: h.x, z, yaw: Math.PI, pitch: 0 });
    await sleep(50);
  }
  bob.send({ t: 'interact' });
  await until(() => bob.container?.kind === 'stash');
  assert.equal(bob.container.title, "Alice's stash");
  assert.equal(bob.container.canPut, false);
  bob.send({ t: 'container', action: 'take', itemId: relic.id });
  await until(() => bob.you.inv.pack.some((i) => i.id === relic.id));

  // PvP: Bob shoots Alice (standing to his side inside the house).
  const before = alice.you.hp;
  const bx = h.x, bzz = h.crate.z + 1.2;
  for (let i = 0; i < 10; i++) {
    bob.send({ t: 'shoot', dir: [(h.x + 3) - bx, 1.2 - 1.6, (h.crate.z + 2) - bzz] });
    await sleep(115);
  }
  await until(() => alice.you.hp < before || alice.you.dead);

  // Restart the server: stash, door and Bob's loot persist.
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.equal(saved.houses[0].items.length, 0);
  assert.equal(saved.houses[0].doorHp, 0);
  assert.ok(saved.characters[TOK_B].inv.pack.some((i) => i.id === relic.id));

  server = await startServer();
  const bob2 = await client('Bob', TOK_B);
  await until(() => bob2.you);
  assert.ok(bob2.you.inv.pack.some((i) => i.id === relic.id));
  assert.ok(Math.abs(bob2.welcome.z - (h.crate.z + 1.2)) < 1, 'logged back in where he logged out');
  for (const c of [alice, bob, bob2]) c.ws.close();
});
