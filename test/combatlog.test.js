// Quitting mid-fight: your character stays standing for a while (it can still be shot); quitting
// any other time takes you out of the world at once, with everything you carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { generateMap } from '../shared/world.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzc-'));
const port = 29400 + Math.floor(Math.random() * 400);
const hex = (s) => s.repeat(32 / s.length);
const file = path.join(dir, 'w.json');
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 100, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), comms: 0, cash: 100, food: 90, field: [], discovered: [], contracts: [] };
}
function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}
function clearSpot() {
  const map = generateMap(1337);
  for (const s of map.roads) {
    const l = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    if (l < 60 || [s.x1, s.z1, s.x2, s.z2].some((v) => Math.abs(v) > map.half - 200)) continue;
    const x = (s.x1 + s.x2) / 2, z = (s.z1 + s.z2) / 2;
    if (map.grid.near(x, z, 25).length) continue;
    if (Math.abs(map.terrain.height(x, z) - map.terrain.height(x, z + 20)) > 0.5 || map.terrain.height(x, z) < 1) continue;
    return { x, z };
  }
  throw new Error('no clear spot');
}

test('quitting mid-fight leaves you standing for a while; quitting otherwise is instant', async () => {
  const at = clearSpot();
  const tokA = hex('a7'), tokB = hex('b8'), tokC = hex('c9');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [tokA]: character('Jace', at.x, at.z), [tokB]: character('Eli', at.x, at.z + 6), [tokC]: character('Sam', at.x + 8, at.z) } }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', RIDES: '0', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', COMBAT_LOG_MS: '6000', ALLOW_DEV: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  try {
    const a = await conn('Jace', tokA), b = await conn('Eli', tokB), c = await conn('Sam', tokC);
    await until(() => a.you && b.you && c.you && a.snap);
    const sees = (name) => a.snap.players.some((p) => p.name === name);
    await until(() => sees('Eli') && sees('Sam'));
    // Sam was in no fight: gone the moment he quits.
    await c.close();
    await until(() => !sees('Sam'), 1500);
    // Jace shoots Eli; Eli pulls the plug.
    const hp = b.you.hp;
    a.send({ t: 'shoot', dir: [0, -0.05, 1] });
    await until(() => b.you.hp < hp);
    await b.close();
    await until(() => a.msgs.some((m) => m.t === 'feed' && /Eli quit mid-fight/.test(m.text)));
    await sleep(800);
    assert.ok(sees('Eli'), 'still standing there');
    await until(() => !sees('Eli'), 10000);   // then gone
    assert.ok(a.msgs.some((m) => m.t === 'feed' && /Eli left the zone/.test(m.text)));

    // Quit mid-fight and killed before getting away: only part of what you carried is lost.
    const b2 = await conn('Eli', tokB);
    await until(() => b2.you && sees('Eli'));
    a.send({ t: 'shoot', dir: [0, -0.05, 1] });
    await until(() => b2.you.hp < 100);
    await b2.close();
    await until(() => a.msgs.filter((m) => m.t === 'feed' && /Eli quit mid-fight/.test(m.text)).length >= 2);
    for (let i = 0; i < 40 && !a.msgs.some((m) => m.t === 'feed' && /Jace ➜ Eli/.test(m.text)); i++) {
      a.send({ t: 'reload' }); await sleep(120);
      a.send({ t: 'shoot', dir: [0, -0.05, 1] }); await sleep(180);
    }
    await until(() => a.msgs.some((m) => m.t === 'feed' && /Jace ➜ Eli/.test(m.text)));
    await until(() => !sees('Eli'), 10000);
    const b3 = await conn('Eli', tokB);
    await until(() => b3.you && b3.msgs.some((m) => m.t === 'awayLog'));
    assert.equal(b3.you.cash, 70, 'kept 70% of the cash');
    assert.ok(b3.msgs.find((m) => m.t === 'awayLog').entries.some((e) => /quit mid-fight and were killed/.test(e.text)));
    await b3.close();

    // A Rogue taking aim at you is a fight too, before it fires.
    const c2 = await conn('Sam', tokC);
    await until(() => c2.you);
    c2.send({ t: 'dev', spawnBots: [{ x: at.x + 8, z: at.z + 10, hp: 9999 }] });
    await sleep(1500);
    await c2.close();
    await until(() => a.msgs.some((m) => m.t === 'feed' && /Sam quit mid-fight/.test(m.text)));
    await a.close();
  } finally { proc.kill('SIGTERM'); }
});
