// Phones take loot from the nearby list (or by walking over it): one item by id, only within reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);

test('take one thing off the ground by tapping it in the list; out of reach is refused', async (t) => {
  const sp = map.lootSpawns.find((s) => map.terrain.height(s.x + 2, s.z) > 1 && !map.grid.near(s.x + 2, s.z, 1).length);
  const A = 'a7'.repeat(16);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzloot-')), 'w.json');
  const me = { name: 'Picker', x: sp.x + 2, z: sp.z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(6), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [] };
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: me } }));
  const port = 31200 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  let you = null, snap = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'you') you = m; if (m.t === 'snap') snap = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Picker', token: A });
  await until(() => you && !you.dead && snap?.loot?.length);
  const near = snap.loot.reduce((a, l) => (!a || Math.hypot(l.x - me.x, l.z - me.z) < Math.hypot(a.x - me.x, a.z - me.z) ? l : a), null);
  assert.ok(Math.hypot(near.x - me.x, near.z - me.z) < 3, 'loot beside you');
  const far = snap.loot.find((l) => Math.hypot(l.x - me.x, l.z - me.z) > 20);
  if (far) {
    send({ t: 'takeLoot', id: far.id });
    await sleep(400);
    assert.ok(snap.loot.some((l) => l.id === far.id), 'out of reach: still there');
  }
  const before = JSON.stringify([you.inv.pack.length, you[near.kind]]);
  send({ t: 'takeLoot', id: near.id });
  await until(() => !snap.loot.some((l) => l.id === near.id));
  await until(() => JSON.stringify([you.inv.pack.length, you[near.kind]]) !== before);
  ws.close();
});
