// Team play end to end: persistent crews, the shared crew stash house, downed/revive, team
// hacking, crew contracts and the crew leaderboard, and claiming any building.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzt-'));
const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
let portBase = 22000 + Math.floor(Math.random() * 800);

const freshHouses = () => Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, upg: {} }]));
const tok = (s) => s.repeat(32 / s.length);
function character(name, x, z, extra = {}) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(10), parts: 200, tech: 100, intel: 0, salvage: 200, wood: 50, stone: 50, comms: 0, field: [], discovered: [], contracts: [], ...extra };
}
function writeDb(file, characters, extra = {}) {
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 8, size: 30000, houses: freshHouses(), bags: [], structures: [], characters, ...extra }));
}
async function startServer(file, env = {}) {
  const port = portBase++;
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', SAVE_EVERY_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  return { proc, port };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [], name };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'correct' && m.force) { c.tpn = m.tp; c.pos = { x: m.x, z: m.z }; }
    if (m.t === 'you') c.you = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'squad') c.squad = m;
    if (m.t === 'leaderboard') c.board = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  c.close = () => new Promise((r) => { ws.once('close', r); ws.close(); });
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('crews are permanent teams with ranks, and survive logging off and restarts', async (t) => {
  const file = path.join(dir, 'crews.json');
  const A = tok('a1'), B = tok('b2'), C = tok('c3');
  const lz = map.landingZones[2];
  writeDb(file, { [A]: character('Ava', lz.x, lz.z), [B]: character('Ben', lz.x + 2, lz.z), [C]: character('Cal', lz.x + 4, lz.z) });
  let srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Ava', A), b = await conn(srv.port, 'Ben', B), c = await conn(srv.port, 'Cal', C);
  await until(() => a.welcome && b.welcome && c.welcome);

  a.send({ t: 'squad', action: 'create', name: 'x' });
  await a.toast(/at least 3 letters/);
  a.send({ t: 'squad', action: 'create', name: 'Apalachicola Wolves' });
  await until(() => a.squad?.name === 'Apalachicola Wolves' && a.squad.myRank === 'leader');
  for (const [who, other] of [[b, a], [c, a]]) {
    a.send({ t: 'squad', action: 'invite', id: who.welcome.id });
    await who.got((m) => m.t === 'invite' && m.crewName === 'Apalachicola Wolves');
    who.send({ t: 'squad', action: 'accept' });
    await until(() => who.squad?.name === 'Apalachicola Wolves');
    void other;
  }
  await until(() => a.squad.members.length === 3);
  // Members can't invite; officers can.
  const ben = () => a.squad.members.find((m) => m.name === 'Ben');
  a.send({ t: 'squad', action: 'officer', pid: ben().pid });
  await until(() => b.squad?.myRank === 'officer');
  // Members never see each other's login tokens.
  assert.ok(!JSON.stringify(a.squad).includes(B) && !JSON.stringify(a.squad).includes(C));

  // Cal logs off: still in the crew, shown offline.
  await c.close();
  await until(() => a.squad.members.find((m) => m.name === 'Cal')?.online === false);
  // Restart the server: the crew is still there.
  await sleep(700);   // the test server saves every 300 ms
  srv.proc.kill('SIGKILL');
  srv = await startServer(file);
  const a2 = await conn(srv.port, 'Ava', A);
  await until(() => a2.squad?.name === 'Apalachicola Wolves' && a2.squad.members.length === 3 && a2.squad.myRank === 'leader');
  // The leader removes the offline member by their public id.
  a2.send({ t: 'squad', action: 'kick', pid: a2.squad.members.find((m) => m.name === 'Cal').pid });
  await until(() => a2.squad.members.length === 2);
  // Handing over leadership.
  a2.send({ t: 'squad', action: 'leader', pid: a2.squad.members.find((m) => m.name === 'Ben').pid });
  await until(() => a2.squad.myRank === 'officer');
});

test('a crew shares one stash house that stays with the crew', async (t) => {
  const file = path.join(dir, 'crewhome.json');
  const A = tok('d4'), B = tok('e5');
  const home = map.houses.find((h) => h.kind === 'house');
  const lz = map.landingZones[4];
  writeDb(file, {
    [A]: character('Dee', home.crate.x, home.crate.z + 1.2, { inv: { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [{ id: 'mk1', kind: 'marker', name: 'Claim marker' }] } }),
    [B]: character('Eli', lz.x, lz.z),
  });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Dee', A), b = await conn(srv.port, 'Eli', B);
  await until(() => a.you && b.you);
  // Dee claims a house on her own, then founds a crew: it becomes the crew stash house.
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'claimed', 12000);
  a.send({ t: 'squad', action: 'create', name: 'Telogia Night Shift' });
  await until(() => a.squad?.id);
  await until(() => a.you.claim?.crew === 'Telogia Night Shift');
  // Eli joins and shares it: same house, and he can use its stash and gunsmith.
  await b.tp(lz.x + 1, lz.z + 1);
  await a.tp(lz.x - 1, lz.z - 1);
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.you?.houseId === home.id && b.you.claim?.crew === 'Telogia Night Shift');
  await b.tp(home.crate.x, home.crate.z + 1.2);
  b.send({ t: 'interact' });
  const view = await b.got((m) => m.t === 'container' && m.kind === 'stash' && m.id === home.id);
  assert.ok(view.gunsmith && view.canPut && view.upg, 'crewmate gets the full stash: storage, gunsmith, upgrades');
  assert.match(view.title, /Telogia Night Shift crew stash/);
  // A plain member can't abandon the crew's house.
  b.send({ t: 'abandon' });
  await b.toast(/Only the crew leader or an officer/);
  // Dee (the claimer) leaves the crew: the house stays with the crew, now Eli's crew.
  a.send({ t: 'squad', action: 'leave' });
  await until(() => a.you.claim === null);
  await until(() => b.you.claim?.id === home.id && b.squad?.myRank === 'leader');
});

test('downed and revive: crewmates pick each other up; solo players and wiped crews die', async (t) => {
  const file = path.join(dir, 'downed.json');
  const A = tok('f6'), B = tok('a7'), C = tok('b8');
  const lz = map.landingZones[6];
  writeDb(file, { [A]: character('Fay', lz.x, lz.z), [B]: character('Gus', lz.x + 30, lz.z), [C]: character('Hal', lz.x - 30, lz.z) });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Fay', A), b = await conn(srv.port, 'Gus', B), c = await conn(srv.port, 'Hal', C);
  await until(() => a.you && b.you && c.you);
  a.send({ t: 'squad', action: 'create', name: 'Liberty Medics' });
  await until(() => a.squad?.id);
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.squad?.id === a.squad.id);

  // Hal is solo: 0 HP is death.
  c.send({ t: 'dev', damage: 500 });
  await until(() => c.you.dead);

  // Fay has a crewmate online: she goes down instead.
  a.send({ t: 'dev', damage: 500 });
  await until(() => a.you.downed && !a.you.dead);
  await b.toast(/Fay is down/);
  // Downed players can't act.
  a.send({ t: 'reload' }); a.send({ t: 'camo' });
  await sleep(200);
  assert.ok(a.you.downed && !a.you.reloading);
  // Gus revives her.
  await b.tp(a.pos?.x ?? lz.x, (a.pos?.z ?? lz.z) + 1);
  b.send({ t: 'interact' });
  await b.got((m) => m.t === 'hack' && m.kind === 'revive');
  await until(() => !a.you.downed && !a.you.dead && a.you.hp > 0, 8000);

  // Down again, then give up.
  a.send({ t: 'dev', damage: 500 });
  await until(() => a.you.downed);
  a.send({ t: 'giveUp' });
  await until(() => a.you.dead);
});

test('a crew wiped out with nobody left standing dies', async (t) => {
  const file = path.join(dir, 'wipe.json');
  const A = tok('c9'), B = tok('d0');
  const lz = map.landingZones[7];
  writeDb(file, { [A]: character('Ivy', lz.x, lz.z), [B]: character('Jon', lz.x + 2, lz.z) });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Ivy', A), b = await conn(srv.port, 'Jon', B);
  await until(() => a.you && b.you);
  a.send({ t: 'squad', action: 'create', name: 'Last Stand' });
  await until(() => a.squad?.id);
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.squad?.id);
  a.send({ t: 'dev', damage: 500 });
  await until(() => a.you.downed);
  b.send({ t: 'dev', damage: 500 });
  // Jon has nobody left to revive him, so he dies, and so does Ivy.
  await until(() => b.you.dead && a.you.dead, 4000);
});

test('team hacking: crewmates speed it up, and the hacker shows up to enemies nearby', async (t) => {
  const file = path.join(dir, 'hack.json');
  const A = tok('e1'), B = tok('e2'), E = tok('e3');
  const term = map.terminals[3];
  const at = { x: term.x, z: term.z + 1.2 };
  writeDb(file, { [A]: character('Kai', at.x, at.z), [B]: character('Lou', at.x + 60, at.z), [E]: character('Max', at.x + 40, at.z + 40) });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Kai', A), b = await conn(srv.port, 'Lou', B), e = await conn(srv.port, 'Max', E);
  await until(() => a.you && b.you && e.you);
  a.send({ t: 'squad', action: 'create', name: 'Data Thieves' });
  await until(() => a.squad?.id);
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.squad?.id);

  const timeHack = async () => {
    await a.tp(at.x, at.z);
    const n = a.msgs.length;
    const t0 = Date.now();
    a.send({ t: 'interact' });
    await until(() => a.msgs.slice(n).find((m) => m.t === 'hack' && m.kind === 'terminal'));
    await until(() => a.msgs.slice(n).find((m) => m.t === 'hack' && m.done), 9000);
    return Date.now() - t0;
  };
  // Solo, with Max ~185 ft away: full 5 s, and Max sees where Kai is.
  const solo = await timeHack();
  assert.ok(solo >= 4700, `solo hack ${solo} ms`);
  assert.ok(e.msgs.some((m) => m.t === 'expose' && m.ids.includes(a.welcome.id)), 'enemy nearby sees the hacker');
  // Another terminal with Lou standing next to Kai: about a third faster.
  const t2 = map.terminals.find((q) => q.id !== term.id && Math.hypot(q.x - term.x, q.z - term.z) < 600) || map.terminals[4];
  at.x = t2.x; at.z = t2.z + 1.2;
  await b.tp(at.x + 2, at.z + 1);
  const helped = await timeHack();
  assert.ok(helped < 4000, `helped hack ${helped} ms`);
  assert.ok(a.msgs.some((m) => m.t === 'hack' && m.helpers === 1), 'hacker is told a crewmate is helping');
});

test('crew contracts pay everyone who took part, and crews have their own leaderboard', async (t) => {
  const file = path.join(dir, 'contracts.json');
  const A = tok('f1'), B = tok('f2'), C = tok('f3');
  const term = map.terminals[5];
  const heist = { id: 'cheist1', type: 'heist', contactId: 0, x: term.x, z: term.z, terminalId: term.id, expires: Date.now() + 3_600_000 };
  writeDb(file, {
    [A]: character('Nia', term.x, term.z + 1.2, { contracts: [heist] }),
    [B]: character('Oz', term.x + 3, term.z + 3),
    [C]: character('Pip', term.x + 1000, term.z),   // a crewmate far away doesn't share
  });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Nia', A), b = await conn(srv.port, 'Oz', B), c = await conn(srv.port, 'Pip', C);
  await until(() => a.you && b.you && c.you);
  a.send({ t: 'squad', action: 'create', name: 'Heist Crew' });
  await until(() => a.squad?.id);
  for (const who of [b, c]) {
    // Invites only show for players nearby on the client, but the server allows any online player.
    a.send({ t: 'squad', action: 'invite', id: who.welcome.id });
    await who.got((m) => m.t === 'invite');
    who.send({ t: 'squad', action: 'accept' });
    await until(() => who.squad?.id === a.squad.id);
  }
  const before = { b: { ...b.you }, c: { ...c.you }, a: { ...a.you } };
  await a.tp(term.x, term.z + 1.2);
  a.send({ t: 'interact' });
  const done = await a.got((m) => m.t === 'contractDone', 9000);
  assert.deepEqual(done.crew.sort(), ['Nia', 'Oz']);
  const got = await b.got((m) => m.t === 'contractDone');
  assert.equal(got.reward.salvage, 15, 'salvage split two ways');
  assert.equal(got.reward.comms, 2, 'commendations in full');
  await until(() => b.you.comms === before.b.comms + 2 && b.you.salvage === before.b.salvage + 15);
  assert.ok(!c.msgs.some((m) => m.t === 'contractDone'), 'far-away crewmate is not part of it');
  // Crew board.
  a.send({ t: 'leaderboard' });
  const board = await a.got((m) => m.t === 'leaderboard');
  const row = board.crews.find((r) => r.name === 'Heist Crew');
  assert.ok(row && row.members === 3 && row.score >= 500, JSON.stringify(row));
});

test('any enterable building can be claimed: stash locker inside, lockable doors in every doorway', async (t) => {
  const file = path.join(dir, 'claimbuilding.json');
  const A = tok('aa'), E = tok('ee');
  // A building with a free spot inside, away from loot and doorways.
  let b = null, spot = null;
  for (const q of map.buildings) {
    if (q.type !== 'building' || q.maxX - q.minX < 9 || q.maxZ - q.minZ < 9 || q.doors.length !== 2) continue;
    for (let x = q.minX + 2; x < q.maxX - 2 && !spot; x += 1) for (let z = q.minZ + 2; z < q.maxZ - 2 && !spot; z += 1) {
      if (map.lootSpawns.some((l) => Math.hypot(l.x - x, l.z - z) < 4) || q.doors.some((d) => Math.hypot(d.x - x, d.z - z) < 4)) continue;
      if (map.grid.near(x, z, 1.2).some((o) => o.y0 < q.floor + 2 && x > o.minX - 1 && x < o.maxX + 1 && z > o.minZ - 1 && z < o.maxZ + 1)) continue;
      spot = { x, z };
    }
    if (spot) { b = q; break; }
  }
  assert.ok(b, 'found a building to claim');
  const door = b.doors[0];
  const outside = { x: door.x + door.out[0] * 3, z: door.z + door.out[1] * 3 };
  writeDb(file, {
    [A]: character('Quin', spot.x, spot.z, { inv: { primary: makeWeapon('carbine'), secondary: null, armor: null, pack: [{ id: 'mk2', kind: 'marker', name: 'Claim marker' }] } }),
    [E]: character('Rex', outside.x, outside.z),
  });
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Quin', A), e = await conn(srv.port, 'Rex', E);
  await until(() => a.you && e.you);
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'hack' && m.kind === 'claimBuilding');
  await a.got((m) => m.t === 'claimed', 12000);
  await until(() => a.you.claim && a.you.claim.kind === 'flag' && !a.you.inv.pack.some((i) => i.kind === 'marker'));
  assert.match(a.you.claim.name, /^Building (in|near) /);
  // The snapshot shows a locker and a closed door in every doorway.
  const snap = await e.got((m) => m.t === 'snap' && m.structs.filter((s) => s.type === 'door').length === b.doors.length);
  assert.ok(snap.structs.every((s) => s.type !== 'door' || !s.open));
  assert.equal(snap.structs.filter((s) => s.type === 'locker').length, 1);
  // Rex can't walk in through the locked door.
  for (let i = 0; i < 12; i++) { e.send({ t: 'state', x: door.x - door.out[0] * (2 - i * 0.4), z: door.z - door.out[1] * (2 - i * 0.4) + 0, yaw: 0, pitch: 0 }); await sleep(60); }
  await sleep(150);
  const last = e.msgs.filter((m) => m.t === 'correct').pop();
  assert.ok(last && (door.out[0] ? (last.x - door.x) * door.out[0] > 0 : (last.z - door.z) * door.out[1] > 0), 'locked door keeps him out');
  // Quin opens the stash locker: full stash with gunsmith and upgrades.
  a.send({ t: 'interact' });
  const view = await a.got((m) => m.t === 'container' && m.kind === 'crate');
  assert.ok(view.gunsmith && view.upg && view.canPut);
  // And can open a door from inside.
  await a.tp(door.x - door.out[0] * 1.2, door.z - door.out[1] * 1.2);
  a.send({ t: 'closeContainer' });
  a.send({ t: 'interact' });
  await e.got((m) => m.t === 'snap' && m.structs.some((s) => s.type === 'door' && s.open));
});

test('hacking: stun or take down an enemy, data-hack them to light up their crew and find their stash; terminals scan', async (t) => {
  const file = path.join(dir, 'datahack.json');
  const A = tok('1a'), E = tok('2e'), F = tok('3f'), G = tok('4b');
  const lz = map.landingZones[9];
  const term = map.terminals[7];
  const enemyHome = map.houses.find((h) => h.kind === 'room');
  const db = {
    [A]: character('Ace', lz.x, lz.z),
    [E]: character('Eve', lz.x + 5, lz.z),           // enemy, 5 m away
    [F]: character('Fox', lz.x + 900, lz.z + 900),   // Eve's crewmate, far away
    [G]: character('Gil', lz.x - 40, lz.z, { yaw: 0 }), // facing +Z
  };
  writeDb(file, db);
  // Eve's crew owns a stash house.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.houses[enemyHome.id] = { ...raw.houses[enemyHome.id], owner: E, ownerName: 'Eve', hxp: 0, upg: {} };
  fs.writeFileSync(file, JSON.stringify(raw));
  const srv = await startServer(file);
  t.after(() => srv.proc.kill('SIGKILL'));
  const a = await conn(srv.port, 'Ace', A), e = await conn(srv.port, 'Eve', E), f = await conn(srv.port, 'Fox', F), g = await conn(srv.port, 'Gil', G);
  await until(() => a.you && e.you && f.you && g.you);
  e.send({ t: 'squad', action: 'create', name: 'Vipers' });
  await until(() => e.squad?.id);
  e.send({ t: 'squad', action: 'invite', id: f.welcome.id });
  await f.got((m) => m.t === 'invite');
  f.send({ t: 'squad', action: 'accept' });
  await until(() => f.squad?.id);
  await until(() => e.you.claim?.crew === 'Vipers');

  // Stun grenade at Eve's feet.
  a.send({ t: 'stun', x: lz.x + 5, z: lz.z });
  await e.got((m) => m.t === 'stunned', 4000);
  assert.ok(a.you.tech < 100, 'costs tech');
  // Stunned: Eve can't act.
  e.send({ t: 'reload' });
  await sleep(150);
  assert.ok(!e.you.reloading);
  // Ace runs over and data-hacks her.
  await a.tp(lz.x + 4, lz.z);
  a.send({ t: 'interact' });
  await a.got((m) => m.t === 'hack' && m.kind === 'datahack');
  await a.got((m) => m.t === 'hack' && m.done && /Hacked Eve/.test(m.text), 5000);
  const ex = a.msgs.find((m) => m.t === 'expose' && m.kind === 'mark' && m.ids.includes(f.welcome.id));
  assert.ok(ex && ex.ids.includes(e.welcome.id), 'Eve and her crewmate Fox light up');
  const intel = await a.got((m) => m.t === 'intel');
  assert.equal(intel.stash.owner, 'Vipers');
  assert.ok(Math.hypot(intel.stash.x - enemyHome.crate.x, intel.stash.z - enemyHome.crate.z) < 1, 'their stash house is located');
  // Fox is 1.3 km away but now shows in Ace's snapshots.
  await a.got((m) => m.t === 'snap' && m.players.some((p) => p.id === f.welcome.id), 3000);
  await f.toast(/hacked Eve/);

  // Takedown from behind: Gil faces +Z, so Ace comes in from -Z.
  await a.tp(lz.x - 40, lz.z - 1.1);
  a.send({ t: 'interact' });
  await g.got((m) => m.t === 'stunned', 3000);

  // Terminal: an area scan lights up enemies nearby.
  await sleep(4500);   // let Gil's stun wear off so he can be moved
  g.send({ t: 'dev', x: term.x + 30, z: term.z });
  await a.tp(term.x, term.z + 1.2);
  const n = a.msgs.length;
  a.send({ t: 'interact' });
  await until(() => a.msgs.slice(n).find((m) => m.t === 'hack' && m.done && /Area scan: 1 hostile/.test(m.text)), 9000);
  assert.ok(a.msgs.slice(n).some((m) => m.t === 'expose' && m.ids.includes(g.welcome.id)));
});
