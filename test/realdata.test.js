// The real-world map: real ground elevation, the real river course and highways, real buildings you
// can walk into, real road names. Built from the files tools/import_real_world.py writes to data/real/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { generateMap, mapChecksum, moveWithCollision, PLAYER_RADIUS } from '../shared/world.js';
import { parseElevation, DEEP_WATER, BRIDGE_DECK } from '../shared/terrain.js';
import { floats } from '../shared/boats.js';

const REAL = new URL('../data/real/', import.meta.url);
const rows = (name) => JSON.parse(fs.readFileSync(new URL(name, REAL))).rows;
const real = () => ({ structures: rows('structures.json'), roads: rows('roads.json'), elevation: parseElevation(zlib.gunzipSync(fs.readFileSync(new URL('elevation.bin.gz', REAL)))) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('the real-world map: ground, river, bridge, buildings and roads all line up', () => {
  const map = generateMap(1337, 30000, real());
  const T = map.terrain;
  assert.equal(mapChecksum(map), mapChecksum(generateMap(1337, 30000, real())), 'the same data always builds the same world');

  // Real ground: Bristol stands on the bluff side well above the river, Blountstown on the floodplain.
  const elev = (n) => map.towns.find((t) => t.name === n).elev;
  assert.ok(elev('Bristol') > 25 && elev('Blountstown') < 15, `Bristol ${elev('Bristol')}, Blountstown ${elev('Blountstown')}`);

  // Real buildings: thousands, mostly houses, each one enterable and on level ground.
  const built = map.buildings.filter((b) => b.real);
  assert.ok(built.length > 6000, `${built.length} real buildings`);
  const kinds = built.reduce((a, b) => (a[b.type] = (a[b.type] || 0) + 1, a), {});
  assert.ok(kinds.home > 4000 && kinds.barn > 300 && kinds.building > 100 && kinds.civic > 10, JSON.stringify(kinds));
  assert.ok(built.every((b) => b.doors.length >= 1), 'every one has a doorway');
  let level = 0;
  for (const b of built) {
    const hs = [[b.minX + 1, b.minZ + 1], [b.maxX - 1, b.minZ + 1], [b.minX + 1, b.maxZ - 1], [b.maxX - 1, b.maxZ - 1], [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]].map(([x, z]) => T.height(x, z));
    if (Math.max(...hs) - Math.min(...hs) < 0.25 && Math.abs(hs[4] - b.pad) < 0.25) level++;
  }
  assert.ok(level / built.length > 0.95, `${level} of ${built.length} floors are level with their pad`);
  // Landmarks keep their real names; shops and brands don't get one.
  const names = built.filter((b) => b.name).map((b) => b.name);
  for (const n of ['Liberty County Courthouse', 'Bristol City Hall', 'Calhoun County Public Library']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /dollar|burger|subway|texaco|piggly|hardware|motel/i.test(n)), 'no brand names');
  // You can walk in through a doorway of the courthouse.
  const court = built.find((b) => b.name === 'Liberty County Courthouse'), d = court.doors[0];
  const start = { x: d.x + d.out[0] * 2, z: d.z + d.out[1] * 2 };
  const end = moveWithCollision(start.x, start.z, -d.out[0] * 5, -d.out[1] * 5, PLAYER_RADIUS, map.grid.near(start.x, start.z, 8), T);
  assert.ok(end.x > court.minX && end.x < court.maxX && end.z > court.minZ && end.z < court.maxZ, 'walked in the door');

  // Real roads carry their real names and route numbers.
  const roadNames = new Set(map.roads.map((r) => r.name).filter(Boolean));
  for (const n of ['SR 20', 'Church Street', 'Pea Ridge Road']) assert.ok(roadNames.has(n) || [...roadNames].some((q) => q.includes(n)), n);
  assert.ok(map.roads.filter((r) => r.name).length > 4000 && map.roads.some((r) => r.dirt), 'named roads and dirt tracks');

  // The highway crosses the real river on a bridge: walkable all the way over, and boats pass under.
  const br = map.bridges.find((b) => b.road === 'SR 20' && b.river === 'Apalachicola River');
  assert.ok(br && br.path.length >= 2, 'SR 20 bridge');
  for (let i = 0; i < br.path.length - 1; i++) {
    const [x1, z1] = br.path[i], [x2, z2] = br.path[i + 1], len = Math.hypot(x2 - x1, z2 - z1);
    for (let t = 0; t <= len; t += 4) assert.ok(T.height(x1 + (x2 - x1) * t / len, z1 + (z2 - z1) * t / len) >= BRIDGE_DECK - 0.01, 'deck holds you up');
  }
  assert.ok(T.drawn(br.x, br.z) < DEEP_WATER, 'open water is drawn under the deck');
  assert.ok(floats(T, br.x, br.z), 'boats pass under the bridge');
  const a = br.path[0], b = br.path.at(-1);
  const across = moveWithCollision(a[0], a[1], b[0] - a[0], b[1] - a[1], PLAYER_RADIUS, [], T);   // (a straight bridge)
  if (br.path.length === 2) assert.ok(Math.hypot(across.x - b[0], across.z - b[1]) < 2, 'walked across');
  assert.ok(map.boxes.some((q) => q.type === 'rail'), 'railings');
  // The river is a continuous channel from the top of the map to the bottom.
  for (let i = 0; i < map.river.length - 1; i++) {
    const [x1, z1] = map.river[i], [x2, z2] = map.river[i + 1];
    if (Math.max(Math.abs(x1), Math.abs(z1), Math.abs(x2), Math.abs(z2)) > map.half - 50) continue;
    assert.ok(floats(T, (x1 + x2) / 2, (z1 + z2) / 2), 'navigable');
  }
  // Real lakes and ponds are cut in: Lake Mystic is water.
  const mystic = map.labels.find((l) => l.text === 'Lake Mystic' && l.kind === 'water');
  assert.ok(mystic && T.height(mystic.x, mystic.z) < 0, 'Lake Mystic');

  // Everything the game places still stands on dry ground it can use.
  assert.equal(map.towns.length, 6);
  assert.equal(map.contacts.length, 6);
  for (const c of map.contacts) assert.ok(T.height(c.x, c.z) > 0.5, `${c.name} is on dry ground`);
  for (const dk of map.docks) { assert.ok(floats(T, dk.wx, dk.wz), `${dk.name} mooring floats`); assert.ok(T.height(dk.x, dk.z) > 0.3, `${dk.name} post is dry`); }
  assert.ok(map.docks.length >= 5 && map.camps.length >= 2, 'landings and swamp camps');
  for (const lz of map.landingZones) assert.ok(T.height(lz.x, lz.z) > 0.5, `${lz.name} is dry`);
  // The Authority's compound in each town is small, and the real downtown around it is left standing.
  for (const t of map.towns) assert.ok(t.rect.maxX - t.rect.minX < 200, `${t.name} compound`);
  const bristol = map.towns.find((t) => t.name === 'Bristol');
  assert.ok(built.filter((q) => Math.abs((q.minX + q.maxX) / 2 - bristol.x) < 400 && Math.abs((q.minZ + q.maxZ) / 2 - bristol.z) < 400).length > 60, 'real Bristol stands around the compound');
});

test('the server runs on the real map and hands the same data to clients', async (t) => {
  const port = 27100 + Math.floor(Math.random() * 500);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzreal-')), 'w.json');
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '1', EVENT_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGKILL'));
  const banner = await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(String(d)); }));
  assert.match(banner, /\d{4} real buildings, \d{4} real roads/);
  // The elevation file is stored gzipped and arrives as plain bytes.
  const res = await fetch(`http://localhost:${port}/data/real/elevation.bin`);
  assert.equal(res.status, 200);
  const grid = parseElevation(new Uint8Array(await res.arrayBuffer()));
  assert.ok(grid && grid.n === 1001 && grid.step === 30);
  assert.ok((await (await fetch(`http://localhost:${port}/data/real/roads.json`)).json()).rows.length > 2000);
  // A player joins, builds the same world from the same files, deploys and walks.
  const ws = new WebSocket(`ws://localhost:${port}`);
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', name: 'Surveyor', token: 'ab'.repeat(16) }));
  const welcome = await until(() => got.find((m) => m.t === 'welcome'));
  assert.deepEqual(welcome.real, { structures: true, roads: true, elevation: true });
  const map = generateMap(welcome.seed, welcome.size, real());
  assert.equal(mapChecksum(map), welcome.mapSum, 'client and server build the same world');
  ws.send(JSON.stringify({ t: 'deploy', kind: 'contact', id: 0 }));
  await until(() => got.find((m) => m.t === 'deployed'));
  const at = await until(() => got.filter((m) => m.t === 'correct' && m.force).pop());
  const snap = await until(() => got.find((m) => m.t === 'snap'));
  assert.ok(Array.isArray(snap.boats));
  ws.send(JSON.stringify({ t: 'state', tp: at.tp, x: at.x + 0.5, z: at.z, yaw: 0, pitch: 0 }));
  await sleep(300);
  assert.ok(map.terrain.height(at.x, at.z) > 0.5, 'deployed on dry ground');
  ws.close();
});
