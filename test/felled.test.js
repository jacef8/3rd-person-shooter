// A tree chopped until there's nothing left comes down to a stump for everyone: you can walk through
// where it stood and shoot past it, and it grows back later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap, PLAYER_RADIUS, moveWithCollision } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { BUILD } from '../shared/building.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
// A lone tree with open ground on its east side.
let tree = null;
for (const c of map.campSites.slice(0, 80)) {
  for (const b of map.grid.near(c.x, c.z, 150)) {
    if (b.type !== 'tree' || map.terrain.height(b.maxX + 1.2, (b.minZ + b.maxZ) / 2) < 1) continue;
    const sx = b.maxX + 1.2, sz = (b.minZ + b.maxZ) / 2;
    if (map.grid.near(sx, sz, 3).some((o) => o !== b) || map.grid.near(b.minX - 3, sz, 3).some((o) => o !== b)) continue;
    tree = b; break;
  }
  if (tree) break;
}

test('a tree chopped out comes down to a stump for everyone, and grows back', async (t) => {
  assert.ok(tree, 'found a lone tree');
  const A = 'f1'.repeat(16), B = 'f2'.repeat(16);
  const sx = tree.maxX + 1.2, sz = (tree.minZ + tree.maxZ) / 2;
  const tool = (k) => ({ id: `t${k}`, kind: 'tool', tool: k, name: k });
  const person = (name, x, z) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [tool('hatchet')] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(6), cash: 50, comms: 0, food: 90, field: [], discovered: [], contracts: [], wood: 0 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzfell-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: person('Logger', sx, sz), [B]: person('Watcher', sx + 6, sz + 6) } }));
  const port = 30500 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', HARVEST_REGROW_MS: '4000' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const join = async (name, token) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; });
    await new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.send({ t: 'join', name, token });
    await until(() => c.you && !c.you.dead);
    return c;
  };
  const a = await join('Logger', A), b = await join('Watcher', B);
  for (let i = 0; i < BUILD.harvest.uses; i++) {
    const w = a.you.wood;
    a.send({ t: 'interact' });
    await until(() => a.you.wood === w + BUILD.harvest.wood);
  }
  // Everyone hears it come down.
  const fell = await until(() => b.msgs.find((m) => m.t === 'felled' && m.on === 1));
  assert.equal(fell.id, tree.id);
  // Nothing more to gather from the stump.
  a.send({ t: 'interact' });
  await until(() => a.msgs.some((m) => m.t === 'toast' && /Nothing left here/.test(m.text)));
  // A late joiner is told too.
  const C = 'f3'.repeat(16);
  const c = new WebSocket(`ws://localhost:${port}`);
  const cm = [];
  c.on('message', (raw) => cm.push(JSON.parse(raw)));
  await new Promise((r) => c.on('open', r));
  c.send(JSON.stringify({ t: 'join', name: 'Late', token: C }));
  const welcome = await until(() => cm.find((m) => m.t === 'welcome'));
  assert.ok(welcome.felled.includes(tree.id), 'the stump is in the welcome');
  // Walk straight through where the tree stood (with the stump marked, the shared rules let you).
  tree.gone = 1;
  const through = moveWithCollision(sx, sz, -(tree.maxX - tree.minX) - 3, 0, PLAYER_RADIUS, map.grid.near(sx, sz, 6), map.terrain);
  assert.ok(through.x < tree.minX - 1, 'walked through the stump');
  // It grows back.
  await until(() => b.msgs.find((m) => m.t === 'felled' && m.on === 0 && m.id === tree.id), 10000);
  c.close();
});

test('a rock mined out crumbles to rubble for everyone', async (t) => {
  let rock = null;
  for (const c of map.campSites.slice(0, 120)) {
    for (const b of map.grid.near(c.x, c.z, 150)) {
      if (b.type !== 'rock' && b.type !== 'boulder') continue;
      const sx = b.maxX + 1.2, sz = (b.minZ + b.maxZ) / 2;
      if (map.terrain.height(sx, sz) < 1 || map.grid.near(sx, sz, 3).some((o) => o !== b)) continue;
      rock = b; break;
    }
    if (rock) break;
  }
  assert.ok(rock, 'found a lone rock');
  const A = 'f4'.repeat(16), sx = rock.maxX + 1.2, sz = (rock.minZ + rock.maxZ) / 2;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzrock-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: { name: 'Miner', x: sx, z: sz, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [{ id: 'tp', kind: 'tool', tool: 'pickaxe', name: 'pickaxe' }] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(6), cash: 50, comms: 0, food: 90, field: [], discovered: [], contracts: [], stone: 0 } } }));
  const port = 30850 + Math.floor(Math.random() * 100);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = [];
  let you = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'Miner', token: A }));
  await until(() => you && !you.dead);
  for (let i = 0; i < BUILD.harvest.uses; i++) {
    const st = you.stone;
    ws.send(JSON.stringify({ t: 'interact' }));
    await until(() => you.stone === st + BUILD.harvest.stone);
  }
  const fell = await until(() => msgs.find((m) => m.t === 'felled' && m.on === 1));
  assert.equal(fell.id, rock.id);
  ws.close();
});
