// The gunsmith's parts: every slot has real choices for every gun, sights cover every way of
// fighting, and the special ones (ammunition, thermal, spotter, 12x glint) do what they say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { ARCHETYPES, PARTS, PAINTS, SLOTS, DEFAULT_PARTS, makeWeapon, makeArmor, weaponStats, partFits, unlocksAt, xpForLevel, MAX_LEVEL } from '../shared/items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const LONG = ['smg', 'carbine', 'shotgun', 'dmr', 'lmg'];
const choices = (slot, gun) => Object.entries(PARTS).filter(([id, p]) => p.slot === slot && id !== DEFAULT_PARTS[slot] && partFits(id, gun)).map(([id]) => id);

test('every slot offers at least three real choices on every long gun, and about ten sights', () => {
  for (const slot of SLOTS) {
    assert.ok(PARTS[DEFAULT_PARTS[slot]], `default for ${slot}`);
    for (const gun of LONG) assert.ok(choices(slot, gun).length >= 3, `${ARCHETYPES[gun].label} ${slot}: ${choices(slot, gun).join(', ')}`);
  }
  // A sidearm has no forearm, but everything else on it has three choices too.
  for (const slot of ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'ammo', 'trigger']) assert.ok(choices(slot, 'sidearm').length >= 3, `sidearm ${slot}: ${choices(slot, 'sidearm').join(', ')}`);
  const sights = Object.values(PARTS).filter((p) => p.slot === 'optic');
  assert.ok(sights.length >= 11, `${sights.length} sights`);
  for (const gun of ['carbine', 'dmr', 'lmg']) assert.ok(choices('optic', gun).length >= 8, `${gun}: ${choices('optic', gun).length} sights`);
  assert.ok(Object.keys(PAINTS).length >= 12, 'skins');
  // Every part says who it is for, and none is free power: anything that helps costs something
  // (commendation gear is the exception: you pay for it another way).
  for (const [id, p] of Object.entries(PARTS)) {
    assert.ok(p.style && p.style.length > 8, `${id} says who it's for`);
    if (id === DEFAULT_PARTS[p.slot] || p.field) continue;
    const gun = LONG.find((g) => partFits(id, g)) || 'sidearm';
    const base = weaponStats(makeWeapon(gun)), s = weaponStats(makeWeapon(gun, { [p.slot]: id }));
    for (const [k, v] of Object.entries(s)) assert.ok(typeof v !== 'number' || Number.isFinite(v), `${id}: ${k} is a number`);
    assert.notDeepEqual(s, base, `${id} changes something`);
  }
  // Something unlocks at every level now, all the way to 30.
  for (let l = 2; l <= MAX_LEVEL; l++) assert.ok(unlocksAt(l).length >= 1, `level ${l} unlocks something`);
});

test('sights and loads each do a different job', () => {
  const st = (gun, parts) => weaponStats(makeWeapon(gun, parts));
  const base = st('carbine', {});
  // Two-range sights flip to a second magnification.
  assert.ok(st('carbine', { optic: 'lpvo' }).zoomAlt > 2 && st('carbine', { optic: 'fieldOptic' }).zoomAlt > 1 && base.zoomAlt === 0);
  // More glass, slower in the hands.
  const order = ['reflex', 'prism', 'acog', 'marksman'].map((o) => st('carbine', { optic: o }));
  for (let i = 1; i < order.length; i++) assert.ok(order[i].zoom > order[i - 1].zoom && order[i].handling < order[i - 1].handling);
  assert.ok(st('carbine', { optic: 'tritium' }).handling > base.handling);
  assert.ok(st('carbine', { optic: 'thermal' }).thermal && st('carbine', { optic: 'spotter' }).autoTag && st('carbine', { optic: 'spotter' }).rangefinder && st('dmr', { optic: 'long12' }).glint);
  assert.ok(!base.thermal && !base.autoTag && !base.glint);
  // Ammunition.
  assert.ok(st('carbine', { ammo: 'ap' }).armor > 1 && st('carbine', { ammo: 'ap' }).flesh < 1);
  assert.ok(st('carbine', { ammo: 'hollow' }).flesh > 1 && st('carbine', { ammo: 'hollow' }).armor < 1);
  assert.ok(st('carbine', { ammo: 'subsonic' }).subsonic && st('carbine', { ammo: 'subsonic' }).range < base.range);
  // A binary trigger only goes on semi-automatics.
  assert.ok(partFits('binaryTrig', 'dmr') && !partFits('binaryTrig', 'carbine'));
  assert.ok(st('dmr', { trigger: 'binaryTrig' }).rpm > st('dmr', {}).rpm * 1.3);
  // Old guns saved before forearms and ammunition existed still work.
  const old = makeWeapon('carbine'); delete old.parts.forearm; delete old.parts.ammo;
  assert.deepEqual(weaponStats(old), base);
});

// ---- on the server
const map = generateMap(1337);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dza-'));
const hex = (s) => s.repeat(32 / s.length);
function character(name, x, z, weapon, extra = {}) {
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: weapon, secondary: null, armor: null, pack: [] }, ammo: 400, mags: { [weapon.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 200, intel: 0, salvage: 0, wood: 0, stone: 0, comms: 0, cash: 0, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'correct' && m.force) c.tpn = m.tp;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('on the server: armor-piercing cracks plates, hollow points do not; thermal sees through camo; a 12x lens glints', async (t) => {
  // Open, level ground with nothing in the way.
  const spot = map.campSites.find((c) => map.grid.near(c.x, c.z, 80).filter((b) => !b.nature).length === 0 && Math.abs(map.terrain.height(c.x, c.z) - map.terrain.height(c.x + 60, c.z)) < 2);
  assert.ok(spot, 'open ground');
  const plate = () => ({ armor: 110, inv: undefined });
  const gun = (parts) => makeWeapon('carbine', parts);
  const armored = (name, x, z) => { const w = gun({}); const c = character(name, x, z, w, { armor: 110 }); c.inv.armor = makeArmor('medium'); return c; };
  void plate;
  const chars = {
    [hex('a1')]: character('Ball', spot.x, spot.z, gun({})), [hex('a2')]: armored('T1', spot.x + 3, spot.z),
    [hex('b1')]: character('Ap', spot.x, spot.z + 20, gun({ ammo: 'ap' })), [hex('b2')]: armored('T2', spot.x + 3, spot.z + 20),
    [hex('c1')]: character('Hp', spot.x, spot.z + 40, gun({ ammo: 'hollow' })), [hex('c2')]: armored('T3', spot.x + 3, spot.z + 40),
    [hex('d1')]: character('Hunter', spot.x + 60, spot.z, gun({ optic: 'thermal' })), [hex('d2')]: character('Ghost', spot.x + 60, spot.z + 60, gun({})),
    [hex('e1')]: character('Longshot', spot.x + 60, spot.z + 20, makeWeapon('dmr', { optic: 'long12' })),
  };
  const port = 27700 + Math.floor(Math.random() * 500), file = path.join(dir, 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: chars }));
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const C = {};
  for (const [tok, c] of Object.entries(chars)) C[c.name] = await conn(port, c.name, tok);
  await until(() => Object.values(C).every((c) => c.you && c.snap));

  // One aimed round each into the chest of an armored target 3 m away.
  const armorLost = async (shooter, target) => {
    const before = target.you.armor;
    const s = chars[Object.keys(chars).find((k) => chars[k].name === shooter.you && 0)] || null; void s;
    shooter.send({ t: 'state', x: shooter.at.x, z: shooter.at.z, yaw: Math.PI / 2, pitch: 0, aim: true });
    await sleep(120);
    shooter.send({ t: 'shoot', dir: [3, -0.6, 0] });
    await until(() => target.you.armor < before);
    return before - target.you.armor;
  };
  for (const [n, z] of [['Ball', 0], ['Ap', 20], ['Hp', 40]]) C[n].at = { x: spot.x, z: spot.z + z };
  const ball = await armorLost(C.Ball, C.T1), ap = await armorLost(C.Ap, C.T2), hp = await armorLost(C.Hp, C.T3);
  assert.ok(Math.abs(ap / ball - 1.5) < 0.05, `armor-piercing takes 1.5x the armor (${ap} vs ${ball})`);
  assert.ok(Math.abs(hp / ball - 0.6) < 0.05, `hollow points take 0.6x (${hp} vs ${ball})`);
  assert.equal(C.T1.you.hp, 100);

  // Optical camo hides Ghost from Hunter 60 m away, until Hunter aims the thermal sight.
  C.Ghost.send({ t: 'camo' });
  await until(() => C.Ghost.you.camoActive);
  const sees = (c, name) => c.snap.players.some((p) => p.name === name);
  await until(() => !sees(C.Hunter, 'Ghost'));
  C.Hunter.send({ t: 'state', x: spot.x + 60, z: spot.z, yaw: 0, pitch: 0, aim: true });
  await until(() => sees(C.Hunter, 'Ghost'));
  C.Hunter.send({ t: 'state', x: spot.x + 60, z: spot.z, yaw: 0, pitch: 0, aim: false });
  await until(() => !sees(C.Hunter, 'Ghost'));

  // The 12x lens flashes while its owner is aiming.
  const glint = () => C.Hunter.snap.players.find((p) => p.name === 'Longshot')?.gl;
  assert.ok(!glint());
  C.Longshot.send({ t: 'state', x: spot.x + 60, z: spot.z + 20, yaw: 0, pitch: 0, aim: true });
  await until(() => glint() === 1);
});
