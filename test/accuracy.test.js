// Accuracy: a single-shot gun, aimed, standing still, with a breath between shots, puts every round
// exactly where the crosshair is. Rushed single shots still group tightly; automatics spread inside
// their cone, bunched toward the middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, weaponStats, xpForLevel } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const angle = (o, a, b) => { const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]], v = [b[0] - o[0], b[1] - o[1], b[2] - o[2]]; const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.hypot(...u) / Math.hypot(...v); return Math.acos(Math.min(1, d)); };

test('steady single shots are dead-on; rushed ones group tight; automatics stay in their cone', async (t) => {
  const spot = map.campSites.find((c) => map.terrain.height(c.x, c.z) > 1 && !map.grid.near(c.x, c.z + 20, 25).length);
  const A = 'ef'.repeat(16);
  const dmr = makeWeapon('dmr', {}, 'factory', 'deer'), carbine = makeWeapon('carbine');   // the deer rifle: a bolt-action, about a shot a second
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzacc-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {}, characters: { [A]: { name: 'Shooter', x: spot.x, z: spot.z, yaw: 0, hp: 100, armor: 0, inv: { primary: dmr, primary2: carbine, secondary: null, armor: null, pack: [] }, ammo: 300, mags: { [dmr.id]: 10, [carbine.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(15), cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [] } } }));
  const port = 33300 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = []; let you = null, tp = 0;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'correct' && m.force) tp = m.tp; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Shooter', token: A });
  await until(() => you && !you.dead);
  const still = () => send({ t: 'state', tp, x: spot.x, z: spot.z, yaw: 0, pitch: 0, aim: true, crouch: false, prone: false });
  for (let k = 0; k < 6; k++) { still(); await sleep(100); }
  const target = [spot.x, map.terrain.height(spot.x, spot.z) + 1.6, spot.z + 40];   // open air, 40 m out
  const shoot = async () => {
    const n = msgs.filter((m) => m.t === 'shot').length;
    still();
    send({ t: 'shoot', dir: [0, 0, 1], at: target });
    const m = await until(() => msgs.filter((q) => q.t === 'shot')[n]);
    return angle(m.o, m.hits[0], target);
  };
  // Steady: aimed, still, rested between shots.
  for (let k = 0; k < 4; k++) { const a = await shoot(); assert.ok(a < 5e-4, `steady shot ${k} off by ${a.toFixed(5)} rad`); await sleep(1400); }
  // Rushed: right after the last one, still tight.
  const ads = weaponStats(dmr).adsSpread;
  for (let k = 0; k < 3; k++) { const a = await shoot(); assert.ok(a <= ads * 0.35 + 5e-4, `rushed shot off by ${a.toFixed(5)}`); await sleep(950); }
  // An automatic: inside its cone.
  send({ t: 'weapon', slot: 'primary2' });
  await sleep(600);
  const cs = weaponStats(carbine).adsSpread;
  const offs = [];
  for (let k = 0; k < 8; k++) { offs.push(await shoot()); await sleep(110); }
  assert.ok(offs.every((a) => a <= cs + 5e-4), `carbine shots within ${cs}: ${offs.map((a) => a.toFixed(4))}`);
  assert.ok(offs.some((a) => a > 1e-3), 'automatics do spread');
  ws.close();
});
