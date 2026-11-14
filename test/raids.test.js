// Fair raids: a base is sealed while everyone who lives there is offline outside their raid window,
// takes reduced damage inside it, and a raid carries off only a share of a stash. Tools wear out,
// better locks take longer, a broken home becomes a ruin its owner rebuilds. Also the new-player
// shield, the solo self-revive, and keeping your claim marker and tools when you die.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, makeConsumable, xpForLevel } from '../shared/items.js';
import { placementProblem, PIECES } from '../shared/building.js';
import { countyHour, RAIDS } from '../shared/claims.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzr-'));
const hex = (s) => s.repeat(32 / s.length);
const tool = (t, dur) => ({ id: `t-${t}-${Math.random()}`, kind: 'tool', tool: t, name: t[0].toUpperCase() + t.slice(1), ...(dur ? { dur, maxDur: dur } : {}) });
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: 0, parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, comms: 0, cash: 100, food: 90, field: [], discovered: [], contracts: [], ...extra };
}
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
const sid = () => 's' + crypto.randomBytes(5).toString('hex');
const res0 = { ammo: 0, parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0 };
const upg0 = { door: 0, storage: 0, alarm: 0, generator: 0, infirmary: 0, workbench: 0 };
function flag(owner, ownerName, x, z, extra) {
  return { id: sid(), type: 'flag', x, z, rot: 0, y0: map.terrain.height(x, z) - 0.15, stage: 0, hp: 2500, owner, ownerName, open: false, hxp: 0, crew: null, upg: { ...upg0 }, items: [], ...res0, ...extra };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'container') c.container = m; if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'correct' && m.force) c.tpn = m.tp;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.toast = (re, ms) => until(() => c.msgs.find((m) => m.t === 'toast' && re.test(m.text)), ms);
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(200); };
  c.st = (id) => c.snap?.structs.find((s) => s.id === id);
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('fair raids: sealed and window bases, the raid share, tool wear, lock tiers, ruins', async (t) => {
  // Two bases on open ground: one sealed (window closed, owner away), one inside its window.
  const ok = (type, x, z) => !placementProblem(world, type, x, z, 0, { x: x + 3, z: z + 3 });
  const free = (x, z) => ok('wall', x, z) && ok('wall', x, z + 1.4) && ok('flag', x, z - 4) && ok('flag', x + 14, z) && ok('wall', x + 14, z + 1.3);
  const site = map.campSites.find((c) => free(c.x, c.z));
  assert.ok(site, 'found open ground');
  const hour = countyHour();
  const O1 = hex('01'), O2 = hex('02'), O3 = hex('03'), R = hex('0f');
  const sealedFlag = flag(O1, 'Sleeper', site.x, site.z - 4, { raidWin: { start: (hour + 12) % 24 } });
  const wall = { id: sid(), type: 'wall', x: site.x, z: site.z, rot: 0, y0: map.terrain.height(site.x, site.z) - 0.15, stage: 1, hp: 1500, owner: O1, ownerName: 'Sleeper', open: false };
  const loot = [0, 1, 2, 3].map(() => makeWeapon('smg'));
  const openFlag = flag(O2, 'Napper', site.x + 14, site.z, { hp: 100, parts: 10, items: loot, raidWin: { start: hour } });
  // A third home: a town house with a blast door (tier 2), its owner online.
  const hid = map.houses.findIndex((h) => h.kind !== 'vehicle');
  const house = map.houses[hid];
  const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], ...res0, upg: {} }]));
  houses[hid] = { ...houses[hid], owner: O3, ownerName: 'Homebody', hxp: 0, upg: { ...upg0, door: 2 }, doorHp: 3000 };
  const port = 28900 + Math.floor(Math.random() * 400), file = path.join(dir, 'raids.json');
  fs.writeFileSync(file, JSON.stringify({
    seed: 1337, version: 11, size: 30000, houses, bags: [], structures: [sealedFlag, wall, openFlag],
    characters: {
      [R]: character('Raider', site.x, site.z + 1.4, { xp: xpForLevel(10), tech: 100, inv: { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [tool('hatchet', RAIDS.toolWear.raidUse)] } }),
      [O2]: character('Napper', site.x + 14, site.z + 3, { xp: xpForLevel(6), wood: 50, stone: 30, parts: 30, inv: { primary: null, secondary: null, armor: null, pack: [tool('hammer')] } }),
      [O3]: character('Homebody', house.x, house.z, { xp: xpForLevel(6) }),
    },
  }));
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const r = await conn(port, 'Raider', R);
  await until(() => r.you && r.snap);

  // The sealed base: the wall says so, and nothing can be started on it.
  await until(() => r.st(wall.id)?.rs === 2 && r.st(wall.id).rw === (hour + 12) % 24);
  r.send({ t: 'interact' });
  await r.toast(/Sealed: everyone who lives here is offline/);
  await sleep(300);
  assert.ok(!r.msgs.some((m) => m.t === 'hack' && m.kind === 'raid'), 'no raid started on a sealed base');
  assert.equal(r.st(wall.id).hp, 1500);

  // The base inside its window: a hatchet does a third of its damage, which is enough for this
  // weakened flag. The flag becomes a ruin, and the worn-out hatchet breaks.
  await r.tp(site.x + 14, site.z + 1.3);
  await until(() => r.st(openFlag.id)?.rs === 1);
  r.send({ t: 'interact' });
  await r.got((m) => m.t === 'hack' && m.kind === 'raid');
  await r.got((m) => m.t === 'hack' && m.done, 10000);
  await until(() => r.st(openFlag.id)?.ru === 1);
  await r.toast(/hatchet broke/);
  await until(() => !r.you.inv.pack.some((i) => i.tool === 'hatchet'));

  // The ruined stash opens, but one raid carries off only 35%: 2 of 4 guns and 3 of 10 parts.
  r.send({ t: 'interact' });
  await until(() => r.container?.kind === 'crate' && r.container.id === openFlag.id);
  assert.equal(r.container.raid.items, 2);
  assert.equal(r.container.raid.res.parts, 3);
  r.send({ t: 'container', action: 'take', res: 'parts' });
  await until(() => r.you.parts === 3);
  r.send({ t: 'container', action: 'take', res: 'parts' });
  await r.toast(/all one raid can carry off/);
  for (const g of loot.slice(0, 3)) { r.send({ t: 'container', action: 'take', itemId: g.id }); await sleep(150); }
  await until(() => r.you.inv.pack.filter((i) => i.kind === 'weapon').length === 2);
  await sleep(300);
  assert.equal(r.you.inv.pack.filter((i) => i.kind === 'weapon').length, 2, 'the third gun stays in their strongbox');
  assert.equal(r.you.parts, 3);

  // A blast door's lock takes 22 s and 40 tech to bypass (a basic one: 8 s, 15 tech).
  const ho = await conn(port, 'Homebody', O3);
  await until(() => ho.you);
  const d = house.door, dz = d.maxZ + 0.9 > house.z ? d.maxZ + 0.9 : d.minZ - 0.9;
  await r.tp((d.minX + d.maxX) / 2, dz);
  r.send({ t: 'interact' });
  const hack = await r.got((m) => m.t === 'hack' && m.kind === 'door');
  assert.equal(hack.total, RAIDS.lockBypass.ms[2]);
  r.send({ t: 'interact' });   // walk away from it
  await r.got((m) => m.t === 'hack' && m.cancel);
  assert.equal(r.you.tech, 100, 'no tech spent on a bypass you gave up');

  // The owner comes back and rebuilds the ruin with a hammer; their home kept its level.
  const n = await conn(port, 'Napper', O2);
  await until(() => n.you?.claim?.ruined === true);
  await n.tp(site.x + 14, site.z + 1.3);
  n.send({ t: 'interact' });
  await until(() => n.container?.id === openFlag.id && n.container.ruin);
  assert.equal(n.container.items.length, 2, 'two guns were left behind');
  n.send({ t: 'rebuild' });
  await n.got((m) => m.t === 'hack' && m.kind === 'rebuild');
  await n.got((m) => m.t === 'hack' && m.done, 12000);
  await until(() => n.you.claim.ruined === false && n.you.wood === 10 && n.you.stone === 10 && n.you.parts === 10);
  await until(() => n.st(openFlag.id) && !n.st(openFlag.id).ru && n.st(openFlag.id).hp > 0);

  // They move their raid window. It takes effect a day later.
  n.send({ t: 'raidWindow', start: (hour + 3) % 24 });
  await until(() => n.you.claim.raid.next === (hour + 3) % 24 && n.you.claim.raid.start === hour);
  await n.toast(/changes to/);
  r.ws.close(); ho.ws.close(); n.ws.close();
});

test('new-player shield, solo self-revive, and keeping your marker and tools', async (t) => {
  const site = map.campSites.find((c) => !placementProblem(world, 'wall', c.x, c.z, 0, { x: c.x, z: c.z + 6 }) && !placementProblem(world, 'wall', c.x, c.z + 4, 0, { x: c.x, z: c.z + 9 }));
  const V = hex('0a'), N = hex('0b'), S = hex('0c');
  const port = 29400 + Math.floor(Math.random() * 400), file = path.join(dir, 'shield.json');
  const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], ...res0, upg: {} }]));
  fs.writeFileSync(file, JSON.stringify({
    seed: 1337, version: 11, size: 30000, houses, bags: [], structures: [],
    characters: {
      [V]: character('Veteran', site.x, site.z, { xp: xpForLevel(12), yaw: 0 }),
      [N]: character('Newbie', site.x, site.z + 4, { yaw: Math.PI }),
      [S]: character('Solo', site.x + 30, site.z, { inv: { primary: null, secondary: null, armor: null, pack: [makeConsumable('medkit'), tool('hammer'), tool('hatchet', 60), { id: 'mk1', kind: 'marker', name: 'Claim marker' }] } }),
    },
  }));
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const v = await conn(port, 'Veteran', V), n = await conn(port, 'Newbie', N), s = await conn(port, 'Solo', S);
  await until(() => v.you && n.you && s.you && v.snap && n.snap);
  assert.equal(n.you.shield, true);
  assert.equal(v.you.shield, false);
  await until(() => v.snap.players.find((p) => p.name === 'Newbie')?.sh === 1);
  await sleep(10_500);   // spawn protection wears off (they were placed, not deployed, but be safe)

  // The veteran can't hurt the newcomer.
  const shoot = async (c, dz, n = 6) => { for (let i = 0; i < n; i++) { c.send({ t: 'shoot', dir: [0, -0.12, dz] }); await sleep(130); } };
  await shoot(v, 4);
  await v.toast(/Newbie is new .* shielded/);
  assert.equal(n.you.hp, 100);

  // The newcomer opens fire: their shield is gone for good, and fire goes both ways.
  await shoot(n, -4, 2);
  await n.toast(/shield is off/);
  await until(() => v.you.hp < 100);
  assert.equal(n.you.shield, false);
  await shoot(v, 4, 2);
  await until(() => n.you.hp < 100);

  // On your own, a medkit gets you back up: down instead of dead, then patch yourself up.
  s.send({ t: 'dev', damage: 150 });
  await until(() => s.you.downed && !s.you.dead && s.you.selfRevive);
  s.send({ t: 'interact' });
  await s.got((m) => m.t === 'hack' && m.kind === 'selfrevive');
  await s.got((m) => m.t === 'hack' && m.done, 9000);
  await until(() => !s.you.downed && !s.you.dead && s.you.hp === 30);
  assert.equal(s.you.inv.pack.filter((i) => i.kind === 'medkit').length, 0);

  // Without a medkit (or within ten minutes of the last one) it's death; the marker and tools stay with you.
  s.send({ t: 'dev', damage: 150 });
  await until(() => s.you.dead);
  const kept = s.you.inv.pack.map((i) => i.kind === 'tool' ? i.tool : i.kind).sort();
  assert.deepEqual(kept, ['hammer', 'hatchet', 'marker']);
  v.ws.close(); n.ws.close(); s.ws.close();
});
