// End-to-end: claiming stash houses with claim markers (vehicle, home, flag), vehicle locks,
// and home levels.
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
import { HOME_LEVEL_XP } from '../shared/claims.js';

const PORT = 21000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzc-'));
const FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const rv = map.houses.find((h) => h.kind === 'vehicle' && h.vtype === 'rv');
const cave = map.houses.find((h) => h.kind === 'cave');
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
let flagSpot = null;
for (let i = 0; i < 6000 && !flagSpot; i++) {
  const x = -1000 + (i % 80) * 29, z = -1800 + Math.floor(i / 80) * 41;
  if (placementProblem(world, 'flag', x, z, 0, { x: x + 2, z: z + 2 }) === null && map.grid.near(x, z, 8).length === 0) flagSpot = { x, z };
}
const TOK_A = 'd1'.repeat(16), TOK_B = 'e1'.repeat(16), TOK_C = 'f1'.repeat(16);
const marker = () => ({ id: `m${Math.random()}`, kind: 'marker', name: 'Claim marker' });
const ch = (name, x, z, extra) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [marker(), { id: 'h' + name, kind: 'tool', tool: 'hammer', name: 'Hammer' }] }, ammo: 300, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(10), parts: 200, tech: 50, intel: 6, salvage: 300, wood: 60, stone: 0, comms: 0, field: [], discovered: [], contracts: [], ...extra });
const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, upg: {} }]));
houses[rv.id].items = [makeWeapon('dmr')];   // abandoned loot already inside
fs.writeFileSync(FILE, JSON.stringify({ seed: 1337, version: 10, size: 30000, houses, bags: [], structures: [], characters: {
  [TOK_A]: ch('Ava', rv.crate.x, rv.crate.z),
  [TOK_B]: ch('Ben', rv.crate.x + 3, rv.crate.z + 3),
  [TOK_C]: ch('Cy', flagSpot.x + 2, flagSpot.z + 2),
} }));

function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'container') c.container = m; });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(200); };
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('claims: markers, vehicles and locks, home levels, flags', async (t) => {
  assert.ok(rv && cave && flagSpot);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: FILE, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  const a = await conn('Ava', TOK_A), b = await conn('Ben', TOK_B);
  await until(() => a.you && b.you);
  assert.equal(a.you.claim, null);
  // Planting the marker on the RV takes 8 s and claims it at home level 1.
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'hack' && m.kind === 'claim');
  await a.got((m) => m.t === 'claimed', 12000);
  await until(() => a.you.claim?.kind === 'home' && a.you.claim.level === 1 && a.you.houseId === rv.id);
  assert.match(a.you.claim.name, /^RV/);
  assert.ok(!a.you.inv.pack.some((i) => i.kind === 'marker'), 'marker used up');
  // The abandoned loot inside came with it.
  a.send({ t: 'interact' });
  await until(() => a.container?.kind === 'stash' && a.container.items.length === 1 && a.container.home?.level === 1);

  // One claim at a time.
  await a.tp(cave.crate.x, cave.crate.z + 1.2);
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'toast' && /already have a stash house/.test(m.text));
  await a.tp(rv.crate.x, rv.crate.z);

  // Ben can't get into Ava's locked RV …
  await sleep(300);
  b.send({ t: 'dev', x: rv.crate.x, z: rv.crate.z + 0.5 }); await sleep(250);
  b.send({ t: 'interact' });
  await b.got((m) => m.t === 'toast' && /locked/.test(m.text));

  // Home XP: installing storage (60 salvage) + uploading 6 intel (120) → 180 XP; another upgrade levels it up.
  a.send({ t: 'upgrade', track: 'storage' });
  await a.got((m) => m.t === 'toast' && /Installed: Storage/.test(m.text));
  a.send({ t: 'container', action: 'bank' });
  await until(() => a.you.claim.xp >= 180);
  a.send({ t: 'upgrade', track: 'door' });   // needs home level 2
  await a.got((m) => m.t === 'toast' && /Needs home level 2/.test(m.text));
  // Build barricades inside the claim radius: +10 home XP per piece (60 wood = 7 of them).
  const xp0 = a.you.claim.xp;
  for (let i = 0; i < 7; i++) {
    const x = rv.crate.x + 4 + (i % 4) * 3.5, z = rv.crate.z + 5 + Math.floor(i / 4) * 3;
    await a.tp(x, z - 2.2);
    a.send({ t: 'build', piece: 'barricade', x, z, rot: 0 });
    await sleep(80);
  }
  await until(() => a.you.claim.xp >= xp0 + 30);
  assert.ok(a.you.claim.xp < HOME_LEVEL_XP[1] + 100);
  await a.tp(rv.crate.x + 15, rv.crate.z + 15);   // out of Ben's line of fire

  // … so Ben shoots the lock off and gets in.
  const lockX = (rv.door.minX + rv.door.maxX) / 2, lockZ = (rv.door.minZ + rv.door.maxZ) / 2;
  b.send({ t: 'dev', x: lockX + (rv.alongX ? 4 : 0), z: lockZ + (rv.alongX ? 0 : 4) }); await sleep(300);
  for (let i = 0; i < 400 && (b.snap?.houses.find((h) => h.id === rv.id)?.hp ?? 1) > 0; i++) {
    if (b.you.mag === 0) b.send({ t: 'reload' });
    b.send({ t: 'shoot', dir: [rv.alongX ? -1 : 0, -0.12, rv.alongX ? 0 : -1] });
    await sleep(110);
  }
  await until(() => b.snap.houses.find((h) => h.id === rv.id).hp === 0, 2000);
  await a.got((m) => m.t === 'toast' && /breached/.test(m.text));
  b.send({ t: 'dev', x: rv.crate.x, z: rv.crate.z + 0.5 }); await sleep(250);
  b.send({ t: 'interact' });
  await until(() => b.container?.kind === 'stash' && b.container.title.includes("Ava"));

  // Ava abandons the RV; Ben now buys a marker from a Contact and claims it himself.
  await a.tp(rv.crate.x, rv.crate.z + 0.8);
  a.send({ t: 'abandon' });
  await until(() => a.you.claim === null);
  const ct = map.contacts[0];
  await b.tp(ct.x + 1.5, ct.z);
  b.send({ t: 'buyMarker', contactId: 0 });
  await until(() => b.you.inv.pack.filter((i) => i.kind === 'marker').length === 2);

  // Cy plants a claim flag on open ground: that's his stash house, with a gunsmith and upgrades.
  const c = await conn('Cy', TOK_C);
  await until(() => c.you);
  c.send({ t: 'build', piece: 'flag', x: flagSpot.x, z: flagSpot.z, rot: 0 });
  await until(() => c.you.claim?.kind === 'flag');
  const flag = await until(() => c.snap.structs?.find((st) => st.type === 'flag'));
  assert.equal(flag.hl, 1);
  c.send({ t: 'interact' });
  await until(() => c.container?.kind === 'crate' && c.container.gunsmith && c.container.upg && c.container.home?.kind === 'flag');
  c.send({ t: 'upgrade', track: 'storage' });
  await c.got((m) => m.t === 'toast' && /Installed: Storage/.test(m.text));
  for (const x of [a, b, c]) x.ws.close();
});
