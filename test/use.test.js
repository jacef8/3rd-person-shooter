// Eating and medkits take a few seconds (PUBG-style): nothing lands until the bar is full; you can walk
// but sprinting or firing stops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { makeWeapon } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzl-'));
const port = 29400 + Math.floor(Math.random() * 400);
const hex = (s) => s.repeat(32 / s.length);
const file = path.join(dir, 'w.json');
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 100, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: 0, comms: 0, cash: 100, food: 20, corn: 3, field: [], discovered: [], contracts: [] };
}

function start() {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', RIDES: '0', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', SAVE_EVERY_MS: '200' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(proc); }));
}
function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws };
  c.msgs = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}


test('eating and medkits take time, and only count when they finish', async () => {
  const tok = hex('e5');
  const ch = character('Jace', 40, 40);
  ch.hp = 50; ch.inv.pack.push({ id: 'mk1', kind: 'medkit', name: 'Medkit' });
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: { [tok]: ch } }));
  const proc = await start();
  try {
    const a = await conn('Jace', tok);
    await until(() => a.you);
    const food0 = a.you.food;
    a.send({ t: 'inv', action: 'eat' });
    await until(() => a.msgs.some((m) => m.t === 'hack' && m.kind === 'eat'));
    await sleep(1200);
    assert.equal(a.you.food, food0, 'not yet: still eating');
    await until(() => a.you.food > food0, 6000);
    // A medkit: five seconds; a shot stops it and the medkit is kept.
    const kits = () => a.you.inv.pack.filter((i) => i.kind === 'medkit').length, n0 = kits();
    a.send({ t: 'inv', action: 'use' });
    await until(() => a.msgs.some((m) => m.t === 'hack' && m.kind === 'heal'));
    await sleep(800);
    a.send({ t: 'shoot', dir: [0, 0, 1] });
    await until(() => a.msgs.some((m) => m.t === 'hack' && m.cancel));
    assert.ok(a.you.hp <= 62, 'no medkit health from a stopped one (just the slow regen)');
    assert.equal(kits(), n0, 'kept the medkit');
    a.send({ t: 'inv', action: 'use' });
    await until(() => a.you.hp > 90, 8000);
    assert.equal(kits(), n0 - 1, 'used one up');
    await a.close();
  } finally { proc.kill('SIGTERM'); }
});
