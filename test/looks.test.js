// The wardrobe: pick an outfit and a colour; it's checked, saved with your character, and everyone
// sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { cleanLook } from '../shared/looks.js';
import { makeWeapon } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzl-'));
const port = 28500 + Math.floor(Math.random() * 400);
const hex = (s) => s.repeat(32 / s.length);
const file = path.join(dir, 'w.json');
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 100, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: 0, comms: 0, cash: 100, food: 90, field: [], discovered: [], contracts: [] };
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
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('looks: only real outfits and colours', () => {
  assert.equal(cleanLook('james:navy'), 'james:navy');
  assert.equal(cleanLook('swat1'), 'swat1:none');
  assert.equal(cleanLook('swat3:none'), null, "the Rogues' black gear isn't on offer");
  assert.equal(cleanLook('james:<script>'), null);
  assert.equal(cleanLook(null), null);
});

test('wardrobe: what you pick is seen by others and kept for next time', async () => {
  const tokA = hex('a7'), tokB = hex('b8');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: { [tokA]: character('Jace', 40, 40), [tokB]: character('Eli', 45, 40) } }));
  let proc = await start();
  try {
    const a = await conn('Jace', tokA), b = await conn('Eli', tokB);
    await until(() => a.you && b.you);
    a.send({ t: 'look', look: 'remy:orange' });
    b.send({ t: 'look', look: 'swat3:none' });   // not allowed: ignored
    const seen = await until(() => b.snap?.players?.find((p) => p.name === 'Jace' && p.lk));
    assert.equal(seen.lk, 'remy:orange');
    await sleep(400);
    assert.ok(!a.snap.players.find((p) => p.name === 'Eli')?.lk, 'a bad pick changes nothing');
    await a.close(); await b.close();
    await sleep(500);
    proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r));
    proc = await start();
    const a2 = await conn('Jace', tokA);
    const me = await until(() => a2.snap?.players?.find((p) => p.name === 'Jace' && p.lk));
    assert.equal(me.lk, 'remy:orange', 'kept with the character');
    await a2.close();
  } finally { proc.kill('SIGTERM'); }
});
