// Rogues fight back: shot from beyond the range they'd spot you, they turn on the shooter, come for
// them, return fire, and bring the squadmate beside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import COMBAT from '../shared/data/combat.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);

test('shot from out of their sight, rogues turn, close in, fire back, and call their squad', async (t) => {
  // An open stretch: me, and two rogues 50 m away (past the 32 m they'd spot me at).
  const far = 50;
  const spot = map.campSites.find((c) => [0, 10, 20, 30, 40, 50, 55].every((d) => map.terrain.height(c.x, c.z + d) > 1 && !map.grid.near(c.x, c.z + d, 4).length));
  assert.ok(spot, 'open ground');
  assert.ok(COMBAT.bots.rogue.sightRange < far);
  const A = 'ad'.repeat(16);
  const w = makeWeapon('carbine');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzbot-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: { name: 'Shooter', x: spot.x, z: spot.z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, primary2: null, secondary: null, armor: null, pack: [] }, ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(10), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [] } } }));
  const port = 33700 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = []; let you = null, snap = null, tp = 0;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'snap') snap = m; if (m.t === 'correct' && m.force) tp = m.tp; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Shooter', token: A });
  await until(() => you && !you.dead);
  send({ t: 'dev', spawnBots: [{ x: spot.x, z: spot.z + far, hp: 2000 }, { x: spot.x + 4, z: spot.z + far + 3, hp: 2000 }] });
  const rogues = () => (snap?.bots || []).filter((b) => b.maxHp === 2000);
  const [r1, r2] = await until(() => rogues().length >= 2 && rogues());
  const hold = setInterval(() => send({ t: 'state', tp, x: spot.x, z: spot.z, yaw: 0, pitch: 0, aim: true }), 100);
  t.after(() => clearInterval(hold));
  await sleep(1500);
  const start = Object.fromEntries(rogues().map((b) => [b.id, Math.hypot(b.x - spot.x, b.z - spot.z)]));
  assert.ok(Object.values(start).every((d) => d > COMBAT.bots.rogue.sightRange), 'out of their sight: they leave me alone');
  // Shoot the first one.
  const eyeY = map.terrain.height(spot.x, spot.z) + 1.6;
  for (let k = 0; k < 6; k++) {
    const b = rogues().find((x) => x.id === r1.id);
    const by = map.terrain.height(b.x, b.z) + 1.2;
    send({ t: 'shoot', dir: [b.x - spot.x, by - eyeY, b.z - spot.z], at: [b.x, by, b.z], tid: b.id });
    await sleep(200);
  }
  // Both come for me (closer than they were), and shots come back my way.
  await until(() => rogues().length >= 2 && rogues().every((b) => Math.hypot(b.x - spot.x, b.z - spot.z) < start[b.id] - 8), 15000);
  await until(() => msgs.some((m) => m.t === 'shot' && (m.from === r1.id || m.from === r2.id)), 15000);
  ws.close();
});
