// The rocket launcher: rockets are their own ammo, and a rocket bursts where it lands, hurting
// everyone close and smashing structures.
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

test('a rocket bursts where it lands: splash damage, and the launcher reloads from rockets', async (t) => {
  let spot = null;
  for (const c of map.campSites) {
    if (map.terrain.height(c.x, c.z) < 1 || map.terrain.height(c.x + 14, c.z) < 1 || map.grid.near(c.x + 7, c.z, 10).length) continue;
    spot = c; break;
  }
  const A = 'e9'.repeat(16), B = 'fa'.repeat(16);
  const rl = makeWeapon('launcher');
  const person = (name, x, z, extra) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(15), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [], ...extra });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzrk-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: {
    [A]: person('Gunner', spot.x, spot.z, { inv: { primary: rl, primary2: null, secondary: null, armor: null, pack: [] }, mags: { [rl.id]: 1 }, rockets: 2 }),
    [B]: person('Target', spot.x + 14, spot.z) } }));
  const port = 32500 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const conn = (name, token) => new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; });
    c.send = (m) => ws.send(JSON.stringify(m));
    ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); });
  });
  const a = await conn('Gunner', A), b = await conn('Target', B);
  await until(() => a.you && b.you && !a.you.dead && !b.you.dead);
  await sleep(11000);   // spawn protection wears off
  // Aim at the ground beside the target: the blast still gets them.
  const gx = spot.x + 13, gz = spot.z, gy = map.terrain.height(gx, gz) + 0.1, oy = map.terrain.height(spot.x, spot.z) + 1.6;
  const dir = [gx - spot.x, gy - oy, gz - spot.z];
  a.send({ t: 'shoot', dir, at: [gx, gy, gz] });
  await until(() => a.msgs.some((m) => m.t === 'shot' && m.hits.some((h) => h[3] === 3)));
  await until(() => b.msgs.some((m) => m.t === 'boom'), 4000);
  await until(() => b.you.hp < 100 || b.you.downed || b.you.dead);
  // Reload: the next rocket comes out of the two carried.
  a.send({ t: 'reload' });
  await until(() => a.you.rockets === 1 && a.you.mag === 1, 6000);
});
