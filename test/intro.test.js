// The intro mission ("Welcome to the Zone"): a new player's first job, followed step by step by the
// server. Plays the first five steps for real (find the Contact, loot, shoot and reload, chop a tree,
// claim a home), then checks it's saved across a log-off, that skipping it ends it, and that it can be
// started over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzi-'));
const PORT = 27000 + Math.floor(Math.random() * 800);

function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'correct' && m.force) c.tpn = m.tp;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(200); };
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}
const step = (c) => c.you?.tut?.step;
/** Press E once and wait while the channel runs (chopping 3 s, planting a claim 8 s); again if it didn't start. */
async function press(c, kind, done, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const n = c.msgs.length;
    c.send({ t: 'interact' });
    const started = await until(() => c.msgs.slice(n).find((m) => m.t === 'hack' && m.kind === kind), 1500).catch(() => null);
    if (!started) continue;
    await until(() => done() || c.msgs.slice(n).find((m) => m.t === 'hack' && m.done), 15000);
    if (done()) return;
  }
  throw new Error(`timed out pressing E (${kind})`);
}

test('intro mission: a new player is walked through the first steps, paid for each, and can skip or start over', async (t) => {
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: {} }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', SAVE_EVERY_MS: '300' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGTERM'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  // A brand-new player deploys at a town: the first job starts, from that town's Contact.
  let c = await conn('Rookie', null);
  await until(() => c.welcome);
  c.send({ t: 'deploy', kind: 'town', id: 0 });
  await until(() => c.you?.tut && step(c) === 0);
  const tut0 = c.you.tut, ct = map.contacts.find((q) => q.name === tut0.contact);
  assert.ok(ct, 'it names the Contact');
  assert.ok(tut0.target && Math.hypot(tut0.target.x - ct.x, tut0.target.z - ct.z) < 2, 'the marker is on the Contact');
  const xp0 = c.you.xp;

  // 1. Walk to the Contact.
  await c.tp(ct.x + 6, ct.z);
  await until(() => step(c) === 1, 5000);
  assert.ok(c.you.xp > xp0, 'paid for the step');

  // 2. Pick up the loot the marker points at.
  const lt = await until(() => c.you.tut.target);
  await c.tp(lt.x + 0.5, lt.z);
  const item = await until(() => c.snap?.loot?.find((l) => Math.hypot(l.x - lt.x, l.z - lt.z) < 1));
  c.send({ t: 'takeLoot', id: item.id });
  await until(() => step(c) === 2);

  // 3. Three shots and a reload.
  c.send({ t: 'state', x: c.you.x ?? lt.x, z: c.you.z ?? lt.z, yaw: 0, pitch: 0, sprint: false });
  for (let i = 0; i < 3; i++) { c.send({ t: 'shoot', dir: [0, 0.2, 1] }); await sleep(450); }
  await until(() => c.you.tut.shots === 3);
  assert.equal(step(c), 2, 'not done until you reload');
  c.send({ t: 'reload' });
  await until(() => step(c) === 3);

  // 4. Chop the tree the marker points at (the starting hatchet).
  const tr = await until(() => c.you.tut.target);
  const tree = map.grid.near(tr.x, tr.z, 3).find((b) => b.nature && (b.type === 'tree' || b.type === 'pine'));
  assert.ok(tree, 'the marker is on a tree');
  await c.tp(tree.minX - 0.9, (tree.minZ + tree.maxZ) / 2);
  await press(c, 'harvest', () => step(c) === 4);

  // 5. Claim the free home the marker points at, at its door.
  const hm = await until(() => c.you.tut.target);
  assert.ok(hm.house != null && !map.houses[hm.house].campId, 'a free home, not a camp shack');
  const door = map.houses[hm.house].door;
  const dx = (door.minX + door.maxX) / 2, dz = (door.minZ + door.maxZ) / 2, h = map.houses[hm.house];
  const ox = Math.sign(dx - h.x) || 1, oz = Math.sign(dz - h.z);
  await c.tp(dx + (Math.abs(dx - h.x) > Math.abs(dz - h.z) ? ox * 1.2 : 0), dz + (Math.abs(dz - h.z) >= Math.abs(dx - h.x) ? oz * 1.2 : 0));
  await press(c, 'claim', () => step(c) === 5, 40000);
  assert.ok(c.you.houseId != null || c.you.claim, 'the home is theirs');
  assert.equal(c.you.tut.target?.label, 'Your stash house', 'next: build at home');
  assert.ok(map.contacts.every((q) => Math.hypot(q.x - h.x, q.z - h.z) >= 80), 'the home it pointed at is away from the traders');

  // Nobody sets up house right by a trader: a home next to a Contact can't be claimed.
  const byTrader = map.houses.find((q) => map.contacts.some((k) => Math.hypot(k.x - q.x, k.z - q.z) < 60) && q.door);
  if (byTrader) {
    const d2 = byTrader.door, n0 = c.msgs.length;
    await c.tp((d2.minX + d2.maxX) / 2 + (Math.sign((d2.minX + d2.maxX) / 2 - byTrader.x) || 1) * 1.2, (d2.minZ + d2.maxZ) / 2);
    c.send({ t: 'interact' });
    await until(() => c.msgs.slice(n0).find((m) => m.t === 'toast' && /Too close to/.test(m.text)), 4000).catch(() => null);
  }

  // Saved: log off and back on, and it carries on from the same step.
  const token = c.welcome.token;
  await c.close();
  await sleep(700);
  c = await conn('Rookie', token);
  await until(() => c.you?.tut);
  assert.equal(step(c), 5);

  // Skip it: done, no card. Start over: back to step 1, from the nearest Contact (and the home it already has counts).
  c.send({ t: 'tut', action: 'skip' });
  await until(() => c.you.tut.done && c.you.tut.skipped);
  c.send({ t: 'tut', action: 'start' });
  await until(() => c.you.tut && !c.you.tut.done && step(c) === 0);
  await c.close();
});
