// Helicopter extraction: flare at a landing zone, hold the zone, get flown home with your loot.
// Leaving the zone aborts it. Uses ALLOW_DEV=1 teleports and a short EXTRACT_HOLD_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, makeArmor, xpForLevel } from '../shared/items.js';

const PORT = 21000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzx-'));
const FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

const TOK = 'e1'.repeat(16);
const home = map.houses.find((h) => h.kind === 'house');
const lz = map.landingZones[3];
const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} }]));
houses[home.id] = { ...houses[home.id], owner: TOK, ownerName: 'Pilot', hxp: 0, upg: { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0 } };
const w = makeWeapon('carbine');
const loot = makeArmor('heavy');
fs.writeFileSync(FILE, JSON.stringify({ seed: 1337, version: 11, size: 30000, houses, bags: [], structures: [], characters: {
  [TOK]: { name: 'Pilot', x: lz.x + 2, z: lz.z + 2, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [loot] },
    ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(5), parts: 100, tech: 50, intel: 0, salvage: 77, wood: 0, stone: 0, comms: 0,
    field: [], discovered: [], contracts: [] },
} }));

test('extraction: flare, hold the zone, fly home with your loot; leaving aborts', async (t) => {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: FILE, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EXTRACT_HOLD_MS: '1500' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const msgs = [];
  let you = null, events = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'events') events = m; });
  const send = (m) => ws.send(JSON.stringify(m));
  await new Promise((r) => ws.on('open', r));
  send({ t: 'join', name: 'Pilot', token: TOK });
  await until(() => you && !you.dead);
  const toast = (re) => until(() => msgs.find((m) => m.t === 'toast' && re.test(m.text)));

  // Away from any Contact or landing zone, there's nothing to call.
  send({ t: 'dev', x: lz.x + 300, z: lz.z + 300 });
  await sleep(200);
  send({ t: 'extract' });
  await toast(/within \d+ ft of a Contact or landing zone/);

  // At the landing zone: flare goes up and everyone sees it.
  send({ t: 'dev', x: lz.x + 2, z: lz.z + 2 });
  await sleep(200);
  send({ t: 'extract' });
  await toast(/Flare up/);
  await until(() => events?.extracts?.length === 1);
  // Walk off: the pilot aborts.
  send({ t: 'dev', x: lz.x + 60, z: lz.z });
  await toast(/aborted — you left the pickup zone/);
  await until(() => events.extracts.length === 0);
  // An abort puts the pilot on cooldown.
  send({ t: 'dev', x: lz.x + 2, z: lz.z + 2 });
  await sleep(200);
  msgs.length = 0;
  send({ t: 'extract' });
  await toast(/Pilot unavailable/);
});

test('extraction: a held pickup flies you home with everything you carry', async (t) => {
  const PORT2 = PORT + 1;
  const file2 = path.join(dir, 'world2.json');
  fs.copyFileSync(FILE, file2);
  const db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  Object.assign(db.characters[TOK], { x: lz.x + 2, z: lz.z + 2 });
  fs.writeFileSync(file2, JSON.stringify(db));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: PORT2, DATA_FILE: file2, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EXTRACT_HOLD_MS: '1500' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${PORT2}`);
  const msgs = [];
  let you = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; });
  const send = (m) => ws.send(JSON.stringify(m));
  await new Promise((r) => ws.on('open', r));
  send({ t: 'join', name: 'Pilot', token: TOK });
  await until(() => you && !you.dead);
  const xp0 = you.xp;
  // E at the landing zone calls it too.
  send({ t: 'interact' });
  await until(() => msgs.find((m) => m.t === 'toast' && /Flare up/.test(m.text)));
  await until(() => msgs.find((m) => m.t === 'extracted'), 6000);
  // The server moves you with a forced position correction.
  const moved = msgs.filter((m) => m.t === 'correct' && m.force).pop();
  assert.ok(moved && Math.hypot(moved.x - home.crate.x, moved.z - home.crate.z) < 4, 'landed at the stash house');
  assert.ok(you.inv.pack.some((i) => i.id === loot.id), 'the loot came along');
  assert.equal(you.salvage, 77);
  await until(() => you.xp > xp0);
});
