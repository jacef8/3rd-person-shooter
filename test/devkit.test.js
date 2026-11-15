// The testing kit (DEV_KIT, on while the game is in development): a brand-new player gets one of every
// gun and armor, flares, charges, tools, every unlock, and can change scopes away from home; it
// refills after a respawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { levelFromXp, MAX_LEVEL, ARCHETYPES, ARMORS, PARTS } from '../shared/items.js';
import { TOOLS } from '../shared/building.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('testing kit: every gun, armor, flare, charge and tool, every unlock, gunsmith anywhere; refills on respawn', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzkit-')), 'w.json');
  const port = 29600 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = [];
  let you = null, welcome = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'welcome') welcome = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Tester' });
  await until(() => you && welcome);
  assert.equal(welcome.devKit, true);
  assert.ok(welcome.packSize >= 30);
  send({ t: 'deploy', kind: 'contact', id: 0 });
  await until(() => you && !you.dead);

  const check = () => {
    const inv = you.inv, all = [inv.primary, inv.primary2, inv.secondary, inv.armor, ...inv.pack].filter(Boolean);
    for (const a of Object.keys(ARCHETYPES)) assert.ok(all.some((i) => i.kind === 'weapon' && i.archetype === a), `has a ${a}`);
    for (const a of Object.keys(ARMORS)) assert.ok(all.some((i) => i.kind === 'armor' && i.type === a), `has ${a} armor`);
    for (const k of ['medkit', 'ammo', 'flare', 'charge', 'marker']) assert.ok(inv.pack.some((i) => i.kind === k), `has a ${k}`);
    assert.equal(inv.pack.filter((i) => i.kind === 'flare').length, 3);
    for (const tl of Object.keys(TOOLS)) assert.ok(inv.pack.some((i) => i.kind === 'tool' && i.tool === tl), `has a ${tl}`);
    assert.equal(levelFromXp(you.xp), MAX_LEVEL);
    assert.ok(you.cash >= 5000 && you.ammo >= 900 && you.tech >= 400);
  };
  check();

  // Every scope fits from right here (no stash house): each one the marksman rifle takes, in turn.
  const dmr = you.inv.primary2;
  const scopes = Object.entries(PARTS).filter(([, p]) => p.slot === 'optic' && p.fits.includes('dmr')).map(([id]) => id);
  assert.ok(scopes.includes('thermal') && scopes.includes('fieldOptic'));
  for (const id of scopes) {
    send({ t: 'gunsmith', action: 'attach', itemId: dmr.id, slot: 'optic', partId: id });
    await until(() => you.inv.primary2.parts.optic === id);
  }

  // Die and come back: the kit is full again.
  send({ t: 'dev', kill: true });
  await until(() => you.dead);
  send({ t: 'deploy', kind: 'lz', id: 0 });
  await until(() => you && !you.dead);
  await sleep(200);
  check();
});
