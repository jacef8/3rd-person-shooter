// End-to-end: boots the real server, connects two clients over WebSocket and checks the core loop:
// an offline-proof stash house can be breached and looted by another player, PvP damage works,
// and everything survives a server restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon } from '../shared/items.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-'));
const DATA_FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const h = map.houses[0];
const TOK_A = 'a'.repeat(32), TOK_B = 'b'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function character(name, x, z, inv, extra = {}) {
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv, ammo: 400, mags: {}, active: 'primary', dead: false, kills: 0, xp: 0, parts: 0, tech: 0, intel: 0, salvage: 0, comms: 0, field: [], discovered: [], contracts: [], ...extra };
}

const relic = makeWeapon('carbine', { optic: 'holo' }, 'desert');
const lmg = makeWeapon('lmg', { magazine: 'drum' });
const seed = {
  seed: 1337,
  version: 9, size: 30000,
  characters: {
    [TOK_A]: character('Alice', h.x + 3, h.crate.z + 2, { primary: null, secondary: makeWeapon('sidearm', 'scrap'), armor: null, pack: [] }, { active: 'secondary' }),
    [TOK_B]: character('Bob', h.x, h.door.maxZ + 3, { primary: lmg, secondary: null, armor: null, pack: [] }, { mags: { [lmg.id]: 80 } }),
  },
  houses: Object.fromEntries(map.houses.map((x) => [x.id, { owner: null, ownerName: null, doorHp: 300, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} }])),
  bags: [],
};
seed.houses[0] = { owner: TOK_A, ownerName: 'Alice', doorHp: 300, doorOpen: false, items: [relic], parts: 50, tech: 0, intel: 0, salvage: 0, upg: {} };
fs.writeFileSync(DATA_FILE, JSON.stringify(seed));

function startServer() {
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE, BOTS: '0', DOOR_HP: '300' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) resolve(proc); }));
}

function client(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [], you: null, welcome: null, container: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.t === 'correct' && m.force) c.tpn = m.tp;
    if (m.t === 'you') c.you = m;
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'container') c.container = m;
    if (m.t === 'snap') c.snap = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  return new Promise((resolve) => ws.on('open', () => { c.send({ t: 'join', name, token }); resolve(c); }));
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('gunsmith: level-gated attachments, building with parts, XP', async (t) => {
  const server = await startServer();
  t.after(() => server.kill('SIGKILL'));
  const alice = await client('Alice', TOK_A);
  await until(() => alice.you);
  // Alice stands inside her house; walk to the crate.
  for (let z = h.crate.z + 2; z >= h.crate.z + 1.2; z -= 0.2) { alice.send({ t: 'state', x: h.x + 1, z, yaw: Math.PI, pitch: 0 }); await sleep(50); }
  const sidearm = alice.you.inv.secondary;
  alice.send({ t: 'gunsmith', action: 'attach', itemId: sidearm.id, slot: 'muzzle', partId: 'suppressor' });
  await until(() => alice.msgs.some((m) => m.t === 'toast' && /unlocks at level 7/.test(m.text)));
  alice.send({ t: 'gunsmith', action: 'attach', itemId: sidearm.id, slot: 'optic', partId: 'reflex' });
  alice.send({ t: 'gunsmith', action: 'build', type: 'carbine' });
  await until(() => alice.msgs.some((m) => m.t === 'toast' && /level 3/.test(m.text)));
  alice.send({ t: 'gunsmith', action: 'build', type: 'smg' });   // 30 parts, taken from her stash's 50
  await until(() => alice.you.inv.pack.some((i) => i.archetype === 'smg'));
  assert.equal(alice.you.inv.secondary.parts.optic, 'iron', 'reflex needs level 2');
  // Building gave XP; level 2 needs 400 XP so she's not there yet.
  await until(() => alice.msgs.some((m) => m.t === 'xp' && /Built/.test(m.reason)));
  assert.equal(alice.you.level, 1);
  alice.ws.close();
  await sleep(200);
});

test('stash house breach, loot, PvP and persistence', async (t) => {
  let server = await startServer();
  t.after(() => server.kill('SIGKILL'));

  const alice = await client('Alice', TOK_A);
  const bob = await client('Bob', TOK_B);
  await until(() => alice.welcome && bob.welcome && bob.you);
  assert.equal(alice.welcome.houseId, 0, 'Alice keeps her stash house');
  assert.notEqual(bob.welcome.houseId, 0);

  // Bob can't open Alice's door — at level 1 he can't hack it either.
  for (let z = h.door.maxZ + 3; z >= h.door.maxZ + 1; z -= 0.2) {
    bob.send({ t: 'state', x: h.x, z, yaw: Math.PI, pitch: 0 });
    await sleep(50);
  }
  bob.send({ t: 'interact' });
  await until(() => bob.msgs.some((m) => m.t === 'toast' && /Locked.*level 8 to hack/.test(m.text)));

  // Bob shoots the door down.
  const bz = h.door.maxZ + 1;
  const doorZ = (h.door.minZ + h.door.maxZ) / 2;
  const breached = () => bob.snap?.houses.find((x) => x.id === 0)?.hp === 0;
  for (let i = 0; i < 120 && !breached(); i++) {
    bob.send({ t: 'shoot', dir: [0, 1.3 - 1.6, doorZ - bz] });
    await sleep(115);
  }
  await until(breached);
  await until(() => alice.msgs.some((m) => m.t === 'toast' && /breached/.test(m.text)));
  await until(() => bob.msgs.some((m) => m.t === 'xp' && /breached/.test(m.reason)));

  // Bob walks inside to the crate, respecting the speed limit.
  let z = bz;
  while (z > h.crate.z + 1.2) {
    z = Math.max(h.crate.z + 1.2, z - 0.2);
    bob.send({ t: 'state', x: h.x, z, yaw: Math.PI, pitch: 0 });
    await sleep(50);
  }
  bob.send({ t: 'interact' });
  await until(() => bob.container?.kind === 'stash');
  assert.equal(bob.container.title, "Alice's stash");
  assert.equal(bob.container.canPut, false);
  bob.send({ t: 'container', action: 'take', itemId: relic.id });
  await until(() => bob.you.inv.pack.some((i) => i.id === relic.id));
  bob.send({ t: 'container', action: 'take', res: 'parts' });
  await until(() => bob.you.parts === 50);
  // The gunsmith only works at your own stash house.
  bob.send({ t: 'gunsmith', action: 'attach', itemId: relic.id, slot: 'muzzle', partId: 'compensator' });
  await until(() => bob.msgs.some((m) => m.t === 'toast' && /your stash house/.test(m.text)));

  // PvP: Bob shoots Alice (standing to his side inside the house).
  const before = alice.you.hp;
  const bx = h.x, bzz = h.crate.z + 1.2;
  for (let i = 0; i < 10; i++) {
    bob.send({ t: 'shoot', dir: [(h.x + 3) - bx, 1.2 - 1.6, (h.crate.z + 2) - bzz] });
    await sleep(115);
  }
  await until(() => alice.you.hp < before || alice.you.dead);

  // Restart the server: stash, door and Bob's loot persist.
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.equal(saved.houses[0].items.length, 0);
  assert.equal(saved.houses[0].doorHp, 0);
  assert.ok(saved.characters[TOK_B].inv.pack.some((i) => i.id === relic.id));

  server = await startServer();
  const bob2 = await client('Bob', TOK_B);
  await until(() => bob2.you);
  assert.ok(bob2.you.inv.pack.some((i) => i.id === relic.id));
  assert.ok(Math.abs(bob2.welcome.z - (h.crate.z + 1.2)) < 1, 'logged back in where he logged out');
  for (const c of [alice, bob, bob2]) c.ws.close();
});

test('squads, tagging, sensors, camo, terminal hacking, intel banking', async (t) => {
  // Fresh world with a high-level hacker (Carol), her squadmate (Dave) and an enemy (Eve).
  const file = path.join(dir, 'tech.json');
  const TOK_C = 'c'.repeat(32), TOK_D = 'd'.repeat(32), TOK_E = 'e'.repeat(32), TOK_F = 'f'.repeat(32), TOK_G = '0'.repeat(32);
  const term = map.terminals[0];
  const tx = term.x, tz = term.z + 1.2;
  const houses = Object.fromEntries(map.houses.map((x) => [x.id, { owner: null, ownerName: null, doorHp: 300, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} }]));
  houses[1] = { owner: TOK_E, ownerName: 'Eve', doorHp: 300, doorOpen: false, items: [makeWeapon('dmr')], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} };
  const h1 = map.houses[1], h2 = map.houses[2];
  houses[2] = { owner: TOK_G, ownerName: 'Grace', doorHp: 300, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} };
  const lvl10 = 4000;
  const frankKit = { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [] };
  const kit = () => ({ primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [] });
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 9, size: 30000, houses, bags: [], characters: {
    [TOK_C]: character('Carol', tx, tz, kit(), { xp: lvl10, tech: 100 }),
    [TOK_D]: character('Dave', tx + 2, tz + 1, kit()),
    [TOK_E]: character('Eve', tx + 6, tz + 4, kit()),
    [TOK_F]: character('Frank', h1.x, h1.door.maxZ + 1, frankKit, { xp: 9000, tech: 40, mags: { [frankKit.primary.id]: 30 } }),
    [TOK_G]: character('Grace', h2.crate.x + 1, h2.crate.z + 1.2, kit(), { intel: 5 }),
  } }));
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: PORT + 1, DATA_FILE: file, BOTS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const conn = (name, token) => {
    const ws = new WebSocket(`ws://localhost:${PORT + 1}`);
    const c = { ws, msgs: [], you: null };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'you') c.you = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'snap') c.snap = m; });
    c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
    c.got = (fn, ms = 5000) => until(() => c.msgs.find(fn), ms);
    return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
  };
  const carol = await conn('Carol', TOK_C), dave = await conn('Dave', TOK_D), eve = await conn('Eve', TOK_E);
  await until(() => carol.snap && dave.snap && eve.snap && carol.you && dave.you);

  // Squad up: Carol invites Dave.
  carol.send({ t: 'squad', action: 'invite', id: dave.welcome.id });
  await dave.got((m) => m.t === 'invite' && m.fromName === 'Carol');
  dave.send({ t: 'squad', action: 'accept' });
  const sq = await carol.got((m) => m.t === 'squad' && m.members?.length === 2);
  assert.equal(sq.leaderId, carol.welcome.id);
  await until(() => dave.snap.players.find((p) => p.id === carol.welcome.id)?.sq);

  // No friendly fire: Carol shoots Dave.
  const daveHp = dave.you.hp;
  carol.send({ t: 'shoot', dir: [2, -0.3, 1] });
  await sleep(300);
  assert.equal(dave.you.hp, daveHp);

  // Tagging: Carol tags Eve, Dave (squadmate) is told.
  carol.send({ t: 'mark', id: eve.welcome.id });
  await dave.got((m) => m.t === 'expose' && m.kind === 'mark' && m.ids.includes(eve.welcome.id));

  // Sensor grenade: costs tech and reveals Eve to the squad.
  const techBefore = carol.you.tech;
  carol.send({ t: 'sensor', x: tx + 6, z: tz + 4 });
  await dave.got((m) => m.t === 'expose' && m.kind === 'sensor' && m.ids.includes(eve.welcome.id));
  await until(() => carol.you.tech === techBefore - 10);

  // Optical camo: Eve is level 1, so it's locked for her. Carol cloaks and Eve stops receiving her
  // once she's out of reveal range (Eve is ~7 m away; move Carol further off first).
  eve.send({ t: 'camo' });
  await eve.got((m) => m.t === 'toast' && /camo unlocks at level 4/.test(m.text));

  // Terminal hacking: Carol hacks, Eve (enemy, nearby) gets an alert, Carol gets intel + tech.
  carol.send({ t: 'interact' });
  await carol.got((m) => m.t === 'hack' && m.kind === 'terminal');
  await eve.got((m) => m.t === 'alert' && /Terminal hack/.test(m.text));
  await carol.got((m) => m.t === 'hack' && (m.done || m.cancel), 9000);
  assert.ok(carol.msgs.find((m) => m.t === 'hack' && m.done), 'hack completed');
  await until(() => carol.you.intel === 3);
  await until(() => carol.snap.terminals.some(([id, ready]) => id === term.id && !ready));

  // Lock bypass: Frank (level 10) stands at Eve's locked door and hacks it open silently.
  const frank = await conn('Frank', TOK_F);
  await until(() => frank.you);
  frank.send({ t: 'interact' });
  await frank.got((m) => m.t === 'hack' && m.kind === 'door');
  await frank.got((m) => m.t === 'hack' && (m.done || m.cancel), 12000);
  await until(() => frank.snap?.houses.find((x) => x.id === 1)?.open === true);
  await eve.got((m) => m.t === 'toast' && /hacked open your stash/.test(m.text));

  // Optical camo: once Frank cloaks, Eve (far away, not a squadmate) stops receiving his position.
  await until(() => eve.snap.players.some((p) => p.id === frank.welcome.id));
  frank.send({ t: 'camo' });
  await until(() => frank.you.camoActive);
  await until(() => !eve.snap.players.some((p) => p.id === frank.welcome.id));
  // A sensor grenade from Eve's side would expose him again; here Frank just fires, which breaks camo.
  frank.send({ t: 'shoot', dir: [0, 0, 1] });
  await until(() => eve.snap.players.some((p) => p.id === frank.welcome.id));

  // Intel banking: Grace stands at her own stash with 5 intel and uploads it for XP.
  const grace = await conn('Grace', TOK_G);
  await until(() => grace.you);
  grace.send({ t: 'interact' });
  await grace.got((m) => m.t === 'container' && m.bank);
  grace.send({ t: 'container', action: 'bank' });
  await grace.got((m) => m.t === 'xp' && /Banked 5 intel/.test(m.reason));
  await until(() => grace.you.intel === 0 && grace.you.xp === 5 * 40);

  // Leaderboard lists everyone, best first.
  grace.send({ t: 'leaderboard' });
  const lb = await grace.got((m) => m.t === 'leaderboard');
  assert.equal(lb.rows[0].name, 'Frank');
  for (const c of [carol, dave, eve, frank, grace]) c.ws.close();
});
