// The stun gun: pull it, fire at someone close, they're stunned (no damage) and can be data-hacked;
// then it recharges; out of range it misses.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzl-'));
const port = 28950 + Math.floor(Math.random() * 400);
const hex = (s) => s.repeat(32 / s.length);
const file = path.join(dir, 'w.json');
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 100, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), comms: 0, cash: 100, food: 90, field: [], discovered: [], contracts: [] };
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


/** A clear stretch of road, level, away from buildings. */
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

test('stun gun: stuns someone close (no damage), recharges, misses out of range', async () => {
  const at = clearSpot();
  const tokA = hex('c3'), tokB = hex('d4');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: { [tokA]: character('Jace', at.x, at.z), [tokB]: character('Eli', at.x, at.z + 6) } }));
  const proc = await start();
  try {
    const a = await conn('Jace', tokA), b = await conn('Eli', tokB);
    await until(() => a.you && b.you);
    a.send({ t: 'taser', dir: [0, 0, 1] });   // not drawn yet: nothing
    await sleep(300);
    assert.ok(!(b.you.stunnedUntil > Date.now()), 'has to be drawn first');
    a.send({ t: 'taser', draw: true });
    await until(() => a.you.taserOut);
    await until(() => b.snap?.players?.find((p) => p.name === 'Jace')?.gun?.a === 'taser');   // others see it in hand
    const hp = b.you.hp;
    a.send({ t: 'taser', dir: [0, -0.05, 1] });
    await until(() => b.you.stunnedUntil > Date.now());
    assert.equal(b.you.hp, hp, 'no damage');
    assert.ok(a.msgs.some((m) => m.t === 'zap' && m.hit === 1));
    // Recharging: a second shot does nothing but say so.
    a.send({ t: 'taser', dir: [0, -0.05, 1] });
    await until(() => a.msgs.some((m) => m.t === 'toast' && /Stun gun recharging/.test(m.text)));
    // Putting it away: normal shots again.
    a.send({ t: 'weapon', slot: 'primary' });
    await until(() => !a.you.taserOut);
    await a.close(); await b.close();
  } finally { proc.kill('SIGTERM'); }
});
