// Saves from the last version carry over: when the map's stash-house list changes, characters, crews
// and claimed real buildings are kept and only the house claims reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('a version 11 save loads into version 12 with the characters kept', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzsave-')), 'w.json');
  const A = 'ab'.repeat(16), gun = makeWeapon('dmr');
  fs.writeFileSync(file, JSON.stringify({
    seed: 1337, version: 11, size: 30000, bags: [], structures: [], crews: {},
    houses: { 0: { owner: A, ownerName: 'Veteran', items: [], doorHp: 100, upg: {} } },
    characters: { [A]: { name: 'Veteran', x: 0, z: 0, yaw: 0, hp: 100, armor: 0, inv: { primary: gun, primary2: null, secondary: null, armor: null, pack: [] }, ammo: 120, mags: {}, active: 'primary', dead: false, kills: 7, xp: xpForLevel(9), cash: 1234, comms: 3, food: 80, field: [], discovered: [], contracts: [] } },
  }));
  const port = 28700 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', REAL_DATA: '0', SAVE_EVERY_MS: '300', EVENT_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  let out = '';
  await new Promise((r) => proc.stdout.on('data', (d) => { out += d; if (out.includes('Deadzone server')) r(); }));
  assert.match(out, /Save moved to version 12/);
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = {};
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'you') c.you = m; });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'Veteran', token: A }));
  const you = await until(() => c.you);
  assert.equal(you.cash, 1234);
  assert.equal(you.kills, 7);
  assert.equal(you.level, 9);
  assert.equal(you.inv.primary?.id, gun.id, 'gear kept');
  // The old house claim is gone (the list was renumbered), and the file is now version 12.
  await sleep(800);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, 12);
  assert.ok(!Object.values(saved.houses).some((h) => h.owner === A), 'house claims reset');
  ws.close();
});
