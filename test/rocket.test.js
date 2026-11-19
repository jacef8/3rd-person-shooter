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

test('a frag grenade: costs parts, flies, and bursts after its fuse, hurting whoever is close', async (t) => {
  const C = await import('../shared/data/combat.json', { with: { type: 'json' } });
  const FRAG = C.default.frag;
  let spot = null;
  for (const c of map.campSites.slice(5)) {
    if (map.terrain.height(c.x, c.z) < 1 || map.terrain.height(c.x + 10, c.z) < 1 || map.grid.near(c.x + 5, c.z, 8).length) continue;
    spot = c; break;
  }
  const A = 'ab'.repeat(16), B = 'cd'.repeat(16);
  const person = (name, x, z, extra = {}) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(15), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [], parts: 20, ...extra });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzfg-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: person('Thrower', spot.x, spot.z), [B]: person('Target', spot.x + 10, spot.z) } }));
  const port = 32800 + Math.floor(Math.random() * 100);
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
  const a = await conn('Thrower', A), b = await conn('Target', B);
  await until(() => a.you && b.you && !a.you.dead && !b.you.dead);
  await sleep(11000);   // spawn protection wears off
  a.send({ t: 'frag', x: spot.x + 10, z: spot.z });
  await until(() => b.msgs.some((m) => m.t === 'nadeThrow' && m.kind === 'frag'));
  await until(() => a.you.parts === 20 - FRAG.costParts);
  assert.equal(b.you.hp, 100, 'nothing yet: the fuse is burning');
  await until(() => b.msgs.some((m) => m.t === 'boom'), FRAG.fuseMs + 3000);
  await until(() => b.you.hp < 100 || b.you.downed || b.you.dead);
});

test('a blast stops at a wall: a grenade outside doesn\'t hurt someone just inside', async (t) => {
  const T = map.terrain;
  // A plain wall, away from any door: a wall box across the building's south side, standing on the ground.
  let spot = null;
  for (const b of map.buildings) {
    if (b.rects || b.maxX - b.minX < 10 || b.maxZ - b.minZ < 10) continue;
    for (let x = b.minX + 2; x < b.maxX - 2 && !spot; x += 1) {
      if ((b.doors || []).some((d) => Math.abs((d.minX + d.maxX) / 2 - x) < 4 && Math.abs((d.minZ + d.maxZ) / 2 - b.minZ) < 3)) continue;
      const wall = map.grid.near(x, b.minZ, 1).find((o) => o.minX <= x && o.maxX >= x && o.minZ <= b.minZ + 0.4 && o.maxZ >= b.minZ && (o.y0 || 0) <= T.height(x, b.minZ) + 0.2 && o.h >= 2.6);
      if (!wall || T.height(x, b.minZ - 2) < 1 || Math.abs(T.height(x, b.minZ - 2) - T.height(x, b.minZ + 2)) > 0.4) continue;
      if (map.grid.near(x, b.minZ - 2, 1.5).some((o) => o !== wall && o.maxZ < b.minZ)) continue;
      spot = { x, outZ: wall.minZ - 1.4, inZ: wall.maxZ + 1.6, from: wall.minZ - 9 };
    }
    if (spot) break;
  }
  assert.ok(spot, 'a wall to test against');
  const A = 'ef'.repeat(16), B = '01'.repeat(16);
  const person = (name, x, z) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(15), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [], parts: 20 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzwl-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: person('Thrower', spot.x, spot.from), [B]: person('Inside', spot.x, spot.inZ) } }));
  const port = 32900 + Math.floor(Math.random() * 90);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', RIDES: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const conn = (name, token) => new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; });
    c.send = (m) => ws.send(JSON.stringify(m));
    ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); });
  });
  const a = await conn('Thrower', A), b = await conn('Inside', B);
  await until(() => a.you && b.you && !a.you.dead && !b.you.dead);
  await sleep(11000);   // spawn protection wears off
  a.send({ t: 'frag', x: spot.x, z: spot.outZ });
  const boom = await until(() => b.msgs.find((m) => m.t === 'boom'), 8000);
  assert.ok(boom.z < spot.inZ - 1.6, `it went off outside the wall (z ${boom.z.toFixed(1)}, wall face ${(spot.inZ - 1.6).toFixed(1)})`);
  assert.ok(Math.hypot(boom.x - spot.x, boom.z - spot.inZ) < 7, 'close enough to hurt in the open');
  await sleep(600);
  assert.equal(b.you.hp, 100, 'the wall took it');
});
