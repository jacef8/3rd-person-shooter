// Rides: cars, trucks, bikes, horses and the rest left about the county, so nobody has to walk
// everywhere. Driving (shared, so client and server agree), finding and taking one, getting out,
// the lock it keeps for a while, stealing, and wrecking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { stepBoat, seatPos, BOATS, RIDES, onRoad } from '../shared/boats.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const T = map.terrain;
const env = { solids: (x, z, r) => map.grid.near(x, z, r), roadsNear: map.roadsNear };
const drive = (b, input, secs) => { let hit = 0; for (let t = 0; t < secs; t += 0.05) { const n = stepBoat(T, b, input, 0.05, env); hit = Math.max(hit, n.hit || 0); Object.assign(b, n); } return hit; };
/** A long, straight, clear stretch of road on level ground. */
function straightRoad() {
  for (const s of map.roads) {
    const l = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    if (l < 150 || [s.x1, s.z1, s.x2, s.z2].some((v) => Math.abs(v) > map.half - 200)) continue;
    let ok = true;
    for (let t = 0; t <= 1 && ok; t += 0.02) {
      const x = s.x1 + (s.x2 - s.x1) * t, z = s.z1 + (s.z2 - s.z1) * t;
      if (T.height(x, z) < 0 || map.grid.near(x, z, 3).some((b) => x > b.minX - 2 && x < b.maxX + 2 && z > b.minZ - 2 && z < b.maxZ + 2)) ok = false;
      if (Math.abs(T.height(x, z) - T.height(s.x1, s.z1)) > 6) ok = false;
    }
    if (ok) return { ...s, l, yaw: Math.atan2(s.x2 - s.x1, s.z2 - s.z1) };
  }
  throw new Error('no straight road');
}
/** Open ground well away from any road or building. */
function openField() {
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() * 2 - 1) * (map.half - 400), z = (Math.random() * 2 - 1) * (map.half - 400);
    let ok = T.height(x, z) > 0.5;
    for (let k = 0; k <= 60 && ok; k += 3) { if (onRoad(map.roadsNear, x, z + k) || map.grid.near(x, z + k, 4).length || Math.abs(T.height(x, z + k) - T.height(x, z)) > 3) ok = false; }
    if (ok) return { x, z };
  }
  throw new Error('no open field');
}

test('every kind of ride is there, with seats, speeds and somewhere it turns up', () => {
  for (const k of ['car', 'pickup', 'motorcycle', 'dirtbike', 'atv', 'golfcart', 'bicycle', 'skateboard', 'tractor', 'horse']) {
    const d = RIDES[k];
    assert.ok(d && BOATS[k].land, k);
    assert.ok(d.speed > 5.4 && d.seats.length >= 1 && d.count > 0 && ['road', 'town', 'field', 'trail'].includes(d.spawn), k);
  }
  assert.ok(Object.values(RIDES).reduce((a, d) => a + d.count, 0) >= 300, 'hundreds of rides out at once');
  // The driver sits on the left, the passenger on the right.
  const s0 = seatPos({ type: 'car', x: 0, z: 0, yaw: 0 }, 0), s1 = seatPos({ type: 'car', x: 0, z: 0, yaw: 0 }, 1);
  assert.ok(s0.x > 0 && s1.x < 0);
});

test('a car is fast on the road, slow in a field; a horse or four-wheeler is better off it; walls stop you', () => {
  const r = straightRoad();
  const car = { type: 'car', x: r.x1 + Math.sin(r.yaw) * 5, z: r.z1 + Math.cos(r.yaw) * 5, yaw: r.yaw, speed: 0 };
  drive(car, { throttle: 1 }, 4);
  assert.ok(car.speed > 16, `on the road: ${car.speed.toFixed(1)} m/s`);
  assert.ok(Math.hypot(car.x - r.x1, car.z - r.z1) > 40, 'covered ground');
  // Braking stops it quickly.
  drive(car, { throttle: -1 }, 2.2);
  assert.ok(Math.abs(car.speed) < 3, `braked to ${car.speed.toFixed(1)}`);

  const f = openField();
  const fieldCar = { type: 'car', x: f.x, z: f.z, yaw: 0, speed: 0 }, horse = { type: 'horse', x: f.x, z: f.z, yaw: 0, speed: 0 }, atv = { type: 'atv', x: f.x, z: f.z, yaw: 0, speed: 0 };
  drive(fieldCar, { throttle: 1 }, 4); drive(horse, { throttle: 1 }, 4); drive(atv, { throttle: 1 }, 4);
  assert.ok(fieldCar.speed < RIDES.car.speed * 0.5, `car off-road ${fieldCar.speed.toFixed(1)}`);
  assert.ok(horse.speed > fieldCar.speed && atv.speed > fieldCar.speed, `horse ${horse.speed.toFixed(1)}, atv ${atv.speed.toFixed(1)}, car ${fieldCar.speed.toFixed(1)}`);
  // Every ride beats walking (5.4 m/s) on a road.
  for (const k of Object.keys(RIDES)) { const b = { type: k, x: r.x1 + Math.sin(r.yaw) * 5, z: r.z1 + Math.cos(r.yaw) * 5, yaw: r.yaw, speed: 0 }; drive(b, { throttle: 1 }, 5); assert.ok(b.speed > 6, `${k}: ${b.speed.toFixed(1)}`); }

  // Straight at a building: it stops at the wall, not inside it.
  const bld = map.buildings.find((b) => !b.real && b.maxX - b.minX > 8 && T.height((b.minX + b.maxX) / 2, b.minZ - 30) > 0.5 && !map.grid.near((b.minX + b.maxX) / 2, b.minZ - 15, 12).some((o) => o !== b && o.maxZ < b.minZ - 1 && o.maxZ > b.minZ - 30 && o.minX < (b.minX + b.maxX) / 2 + 2 && o.maxX > (b.minX + b.maxX) / 2 - 2))
    || map.boxes.find((b) => b.maxX - b.minX > 6 && b.h > 2);
  const cx = (bld.minX + bld.maxX) / 2;
  const ram = { type: 'pickup', x: cx, z: bld.minZ - 25, yaw: 0, speed: 0 };
  const hit = drive(ram, { throttle: 1 }, 5);
  assert.ok(ram.z < bld.minZ, `stopped short of the wall (${ram.z.toFixed(1)} vs ${bld.minZ.toFixed(1)})`);
  assert.ok(Math.abs(ram.speed) < 3, 'and stopped');
  assert.ok(hit > 0, 'hit it hard enough to count as a crash');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzv-'));
let portBase = 27000 + Math.floor(Math.random() * 800);
const hex = (s) => s.repeat(32 / s.length);
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 400, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 50, intel: 0, salvage: 50, wood: 100, stone: 0, comms: 0, cash: 2000, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
async function server(name, characters, extraEnv = {}) {
  const port = portBase++;
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', SAVE_EVERY_MS: '300', RIDES: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  return { proc, port, file };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'devRide') c.dev = m;
    if (m.t === 'correct' && m.force) { c.tpn = m.tp; c.correct = m; }
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('the county fills with rides; find one, hotwire it, drive it, get out; it stays yours a while; wreck it', async () => {
  const r = straightRoad();
  const at = { x: r.x1 + Math.sin(r.yaw) * 10, z: r.z1 + Math.cos(r.yaw) * 10 };
  const tokA = hex('a1'), tokB = hex('b2');
  const s = await server('rides', { [tokA]: character('Jace', at.x + 3, at.z), [tokB]: character('Eli', at.x - 30, at.z) });
  try {
    const a = await conn(s.port, 'Jace', tokA), b = await conn(s.port, 'Eli', tokB);
    await until(() => a.you && b.you);
    // The spawner tops the county up: hundreds of rides of every kind, some near every town.
    let counts;
    for (let i = 0; i < 40; i++) { a.dev = null; a.send({ t: 'dev', rideCount: 1 }); await sleep(250); counts = a.dev?.counts; if (counts && Object.values(counts).reduce((x, y) => x + y, 0) > 300) break; }
    assert.ok(counts && Object.keys(RIDES).every((k) => counts[k] > 0), `rides out: ${JSON.stringify(counts)}`);

    // A car with no keys in it, on the road beside us.
    a.dev = null;
    a.send({ t: 'dev', spawnRide: { type: 'car', x: at.x, z: at.z, yaw: r.yaw, keys: false } });
    const id = (await until(() => a.dev)).id;
    await until(() => a.snap?.boats?.some((v) => v.id === id && v.nk && v.y !== undefined));
    a.send({ t: 'interact' });
    await a.got((m) => m.t === 'hack' && m.total === RIDES.car ? false : m.t === 'hack' && m.total > 0, 3000);
    await until(() => a.you?.boat?.id === id, 10000);
    assert.equal(a.you.boat.seat, 0, 'in the driver seat');

    // Drive it down the road: the server follows (no corrections).
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    for (let i = 1; i <= 25; i++) { a.send({ t: 'state', x: 0, z: 0, yaw: r.yaw, pitch: 0, boat: { x: at.x + fx * i, z: at.z + fz * i, yaw: r.yaw } }); await sleep(50); }
    await sleep(200);
    const car = a.snap.boats.find((v) => v.id === id);
    assert.ok(Math.hypot(car.x - at.x, car.z - at.z) > 20, 'it moved down the road');
    assert.ok(!a.msgs.some((m) => m.t === 'boatFix'), 'no corrections on a clear road');
    // Too fast is held to its top speed.
    a.send({ t: 'state', x: 0, z: 0, yaw: r.yaw, pitch: 0, boat: { x: car.x + fx * 60, z: car.z + fz * 60, yaw: r.yaw } });
    await a.got((m) => m.t === 'boatFix');

    // Get out: standing beside it, and it's still ours to come back to.
    a.send({ t: 'interact' });
    await until(() => a.you && !a.you.boat);
    const parked = a.snap.boats.find((v) => v.id === id);
    const me = a.correct;
    assert.ok(Math.hypot(me.x - parked.x, me.z - parked.z) < 6, 'beside the car');
    assert.equal(parked.mine, 1);

    // Someone else can't just get in: they have to hotwire it, and we hear about it.
    await b.tp(parked.x - Math.cos(r.yaw) * 2.5, parked.z + Math.sin(r.yaw) * 2.5);
    await until(() => b.snap?.boats?.some((v) => v.id === id));
    b.send({ t: 'interact' });
    await b.got((m) => m.t === 'hack' && m.total > 0, 3000);
    await a.got((m) => /hotwiring your car/.test(m.text || ''), 3000);
    b.send({ t: 'state', x: parked.x + 30, z: parked.z, yaw: 0, pitch: 0 });   // walk off: cancels it
    await sleep(300);

    // Wreck it with us in it: thrown clear, a bang, and it's gone.
    a.send({ t: 'interact' });
    await until(() => a.you?.boat?.id === id);
    a.send({ t: 'dev', boatDamage: 5000, boatId: id });
    await a.got((m) => m.t === 'boom', 3000);
    await until(() => a.you && !a.you.boat && !a.snap.boats.some((v) => v.id === id));
    await a.toast(/wrecked/);
    await a.close(); await b.close();
  } finally { s.proc.kill(); }
});
