// Swimming: walk off the bank into deep water and you swim at the surface; crouch dives, your breath
// runs down under the water and then you drown; no shooting in the water; walk back out up the bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap, moveWithCollision, SWIM_Y, maxDive } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const map = generateMap(1337), T = map.terrain;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
// A bank: dry land a few metres from water deep enough to dive in, nothing in the way.
let bank = null;
for (const rv of T.geo.rivers) {
  for (const [x, z] of rv.pts) {
    if (Math.abs(x) > T.half - 200 || Math.abs(z) > T.half - 200) continue;
    for (let a = 0; a < 8 && !bank; a++) {
      const dx = Math.cos(a * Math.PI / 4), dz = Math.sin(a * Math.PI / 4);
      // walk out from the deep middle until it's dry
      if (maxDive(T, x, z) < 2) continue;
      for (let s = 1; s < 120; s++) {
        const px = x + dx * s, pz = z + dz * s;
        if (T.height(px, pz) > 0.3) {
          const land = { x: px + dx * 3, z: pz + dz * 3 }, water = { x: px - dx * 30, z: pz - dz * 30 };
          let clear = T.height(land.x, land.z) > 0.3 && maxDive(T, water.x, water.z) > 1.2;
          for (let k = -2; k <= 40 && clear; k++) { const qx = land.x - dx * k, qz = land.z - dz * k; if (map.grid.near(qx, qz, 1.5).length) clear = false; }   // nothing in the way along the swim
          if (clear) bank = { land, water, dx, dz };
          break;
        }
      }
    }
    if (bank) break;
  }
  if (bank) break;
}

test('shared: you swim out into deep water at the surface, and climb back out', () => {
  assert.ok(bank, 'found a bank by deep water');
  let p = { x: bank.land.x, z: bank.land.z, y: T.height(bank.land.x, bank.land.z) };
  // Without swimming (a bot) the water stops you.
  const dry = moveWithCollision(p.x, p.z, -bank.dx * 15, -bank.dz * 15, 0.35, [], T, p.y);
  assert.ok(T.height(dry.x, dry.z) > -0.9, 'stopped at the edge');
  for (let i = 0; i < 70; i++) p = moveWithCollision(p.x, p.z, -bank.dx * 0.5, -bank.dz * 0.5, 0.35, [], T, p.y, 0, true);
  assert.equal(p.y, SWIM_Y, 'swimming at the surface');
  for (let i = 0; i < 90; i++) p = moveWithCollision(p.x, p.z, bank.dx * 0.5, bank.dz * 0.5, 0.35, [], T, p.y, 0, true);
  assert.ok(p.y > SWIM_Y && T.height(p.x, p.z) > -0.5, `back out on the bank (y ${p.y.toFixed(2)})`);
});

test('swimming on the server: dive, hold your breath, drown; no shooting in the water', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzswim-')), 'w.json');
  const A = 'ab'.repeat(16), w = makeWeapon('carbine');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [A]: { name: 'Swimmer', x: bank.land.x, z: bank.land.z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 100, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(3), field: [], discovered: [], contracts: [] },
  } }));
  const port = 28100 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', BREATH_S: '3', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'correct' && m.force) c.tp = m.tp; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Swimmer', token: A });
  await until(() => c.you && !c.you.dead);
  // Swim out: small steps from the bank into the water.
  let x = bank.land.x, z = bank.land.z;
  for (let i = 0; i < 115; i++) { x -= bank.dx * 0.3; z -= bank.dz * 0.3; send({ t: 'state', tp: c.tp || 0, x, z, yaw: 0, pitch: 0 }); await sleep(60); }
  await until(() => c.you.swim, 5000);
  const meIn = () => c.snap?.players?.find((q) => q.name === 'Swimmer');
  await until(() => meIn()?.sw);
  assert.equal(meIn().y, SWIM_Y, 'at the surface');
  // No shooting in the water.
  const mag = c.you.mag;
  send({ t: 'shoot', ox: x, oy: 0.2, oz: z, dx: 0, dy: 0, dz: 1 });
  await sleep(400);
  assert.equal(c.you.mag, mag, 'no round fired');
  // Dive: down by the amount asked for, a little at a time.
  for (let i = 0; i < 20; i++) { send({ t: 'state', tp: c.tp || 0, x, z, yaw: 0, pitch: 0, dive: 1.1 }); await sleep(100); }
  await until(() => meIn()?.y < SWIM_Y - 0.8);
  // Breath (3 s here) runs out, then you drown.
  const hp0 = c.you.hp;
  const keepDown = setInterval(() => send({ t: 'state', tp: c.tp || 0, x, z, yaw: 0, pitch: 0, dive: 1.1 }), 100);
  t.after(() => clearInterval(keepDown));
  await until(() => c.you.breath === 0, 8000);
  await until(() => c.you.hp < hp0, 4000);
  clearInterval(keepDown);
  // Back up: breath comes back.
  for (let i = 0; i < 10; i++) { send({ t: 'state', tp: c.tp || 0, x, z, yaw: 0, pitch: 0, dive: 0 }); await sleep(100); }
  await until(() => c.you.breath > 0, 4000);
  // And out up the bank.
  for (let i = 0; i < 130; i++) { x += bank.dx * 0.3; z += bank.dz * 0.3; send({ t: 'state', tp: c.tp || 0, x, z, yaw: 0, pitch: 0 }); await sleep(60); }
  await until(() => c.you.swim === false, 5000);
  ws.close();
});
