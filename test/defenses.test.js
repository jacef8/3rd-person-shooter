// Base defenses you can find and beat: a sensor grenade shows them, a mine can be disarmed crouching
// (or goes off underfoot), and a motion alarm sounds a siren the intruder hears too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { placementProblem } from '../shared/building.js';
import WORLD from '../shared/data/world.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
const LAYOUT = [['mine', 0, 0], ['mine', 8, 0], ['alarm', 0, 12]];
const spot = map.campSites.find((c) => LAYOUT.every(([type, dx, dz]) => !placementProblem(world, type, c.x + dx, c.z + dz, 0, { x: c.x + dx, z: c.z + dz + 3 })));
const tool = (t) => ({ id: `t-${t}`, kind: 'tool', tool: t, name: t });
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [tool('hammer')] }, ammo: 400, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 200, tech: 100, intel: 0, salvage: 100, wood: 100, stone: 50, comms: 0, cash: 200, food: 90, field: [], discovered: [], contracts: [] };
}

test('find a base\'s defenses with a sensor, disarm a mine, step on another, set off the siren', async (t) => {
  assert.ok(spot, 'room for the layout');
  const O = 'c7'.repeat(16), I = 'd8'.repeat(16);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzdef-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: { [O]: character('Owner', spot.x, spot.z + 3), [I]: character('Intruder', spot.x + 70, spot.z) } }));
  const port = 32100 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', DEV_KIT: '0', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', HOTZONE_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const conn = (name, token) => new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'correct' && m.force) c.tpn = m.tp; });
    c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
    c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
    c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(200); };
    ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); });
  });
  const o = await conn('Owner', O), i = await conn('Intruder', I);
  await until(() => o.you && i.you);
  for (const [piece, dx, dz] of LAYOUT) {
    await o.tp(spot.x + dx, spot.z + dz + 3);
    o.send({ t: 'build', piece, x: spot.x + dx, z: spot.z + dz, rot: 0 });
    await sleep(200);
  }
  const mines = await until(() => { const m = o.snap?.structs.filter((s) => s.type === 'mine'); return m?.length === 2 && o.snap.structs.some((s) => s.type === 'alarm') && m; }, 6000);
  await o.tp(spot.x - 60, spot.z);   // the owner steps away (their own mines never go off under them)
  // A sensor grenade over the camp marks every defense in its radius.
  await i.tp(spot.x + 25, spot.z);
  i.send({ t: 'sensor', x: spot.x + 2, z: spot.z + 4 });
  const marks = await i.got((m) => m.t === 'defmarks');
  assert.ok(marks.list.filter((d) => d.kind === 'mine').length === 2 && marks.list.some((d) => d.kind === 'alarm'), 'mines and the alarm marked');
  // Crouch beside the far mine and take it apart.
  const far = mines.reduce((m, s) => (s.x > m.x ? s : m));
  await i.tp(far.x + 1.6, far.z);
  i.send({ t: 'state', x: far.x + 1.6, z: far.z, yaw: -Math.PI / 2, pitch: 0, crouch: true });
  await sleep(200);
  const salvage = i.you.salvage;
  i.send({ t: 'interact' });
  await i.got((m) => m.t === 'hack' && m.done && /disarmed/.test(m.text), 8000);
  await until(() => !i.snap.structs.some((s) => s.id === far.id) && i.you.salvage === salvage + WORLD.defenses.mine.salvageBack);
  // Walk onto the other one: it goes off.
  const near = mines.find((s) => s.id !== far.id);
  await i.tp(near.x + 2.2, near.z);
  i.send({ t: 'state', x: near.x + 2.2, z: near.z, yaw: 0, pitch: 0, crouch: false });
  await sleep(150);
  for (let k = 0; k < 8; k++) { i.send({ t: 'state', x: near.x + 2 - k * 0.3, z: near.z, yaw: 0, pitch: 0 }); await sleep(60); }
  await i.got((m) => m.t === 'boom', 4000);
  await until(() => i.you.hp < 100 || i.you.downed || i.you.dead);
  // The alarm went off at some point with the intruder this close: they heard the siren too.
  await i.got((m) => m.t === 'siren', 4000);
});
