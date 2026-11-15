// Coming back after a death: a wait that grows with each death, nothing near where you died for a
// while except your own stash house, and landing zones are random (and away from it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import ACT from '../shared/data/activities.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);

test('respawn: a growing wait; home or a town, but not near where you died; fast travel from home', async (t) => {
  const A = 'a7'.repeat(16);
  const ct = map.contacts[0], home = map.houses.find((h) => h.kind === 'house' && Math.hypot(h.x - ct.x, h.z - ct.z) < 1200);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzresp-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [],
    houses: { [home.id]: { owner: A, ownerName: 'Again', items: [], doorHp: 1500, upg: {} } },
    characters: { [A]: { name: 'Again', x: ct.x + 4, z: ct.z + 4, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(6), cash: 50, comms: 0, food: 90, field: [], discovered: map.contacts.map((c) => c.id), contracts: [] } } }));
  const port = 29900 + Math.floor(Math.random() * 80);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', RESPAWN_WAIT_S: '2', RESPAWN_KEEPAWAY_M: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = [];
  let you = null, at = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'correct' && m.force) at = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  const toast = (re) => until(() => msgs.find((m) => m.t === 'toast' && re.test(m.text)));
  send({ t: 'join', name: 'Again', token: A });
  await until(() => you && !you.dead);

  // First death, by the Contact: a short wait, then home or a town (not the one where you died).
  send({ t: 'dev', kill: true });
  const died = await until(() => msgs.find((m) => m.t === 'died'));
  const r1 = died.deploy.respawn;
  assert.ok(r1.waitMs > 1000 && r1.waitMs <= 2000, `first wait ${r1.waitMs}`);
  assert.equal(r1.keepAway, ACT.respawn.keepAwayM);
  assert.ok(Math.hypot(r1.away.x - ct.x, r1.away.z - ct.z) < 10, 'the closed circle is where you died');
  assert.ok(died.deploy.claim && died.deploy.towns.length >= 7 && !died.deploy.lzs.length && !died.deploy.crew.length, 'home or a town');
  assert.ok(died.deploy.towns.some((tw) => tw.name === 'Rock Bluff'), 'Rock Bluff is one of the towns');
  send({ t: 'deploy', kind: 'home' });
  await toast(/You can redeploy in \ds/);
  await sleep(2100);
  send({ t: 'deploy', kind: 'town', id: 0 });   // the town you died in
  await toast(/Too close to where you died/);
  send({ t: 'deploy', kind: 'lz', id: 0 });
  await toast(/come back at your stash house or a town/);
  assert.ok(you.dead, 'not back yet');
  send({ t: 'deploy', kind: 'home' });
  await until(() => !you.dead);
  await sleep(300);
  assert.ok(Math.hypot(at.x - home.crate.x, at.z - home.crate.z) < 5, 'back at the stash house');

  // Fast travel from home: not back to where you died for a while, but anywhere else.
  send({ t: 'travel', kind: 'contact', id: ct.id });
  await toast(/You died near there/);
  await sleep(200);
  assert.ok(Math.hypot(at.x - home.crate.x, at.z - home.crate.z) < 5, 'refused: still at home');
  const far = map.landingZones.find((l) => Math.hypot(l.x - ct.x, l.z - ct.z) > ACT.respawn.keepAwayM + 100);
  send({ t: 'travel', kind: 'lz', id: far.id });
  await until(() => Math.hypot(at.x - far.x, at.z - far.z) < 6);

  // Second death within 10 minutes: the wait is longer.
  msgs.length = 0;
  send({ t: 'dev', kill: true });
  const died2 = await until(() => msgs.find((m) => m.t === 'died'));
  assert.ok(died2.deploy.respawn.waitMs > 3000, `second wait ${died2.deploy.respawn.waitMs}`);
  assert.equal(died2.deploy.respawn.deaths, 2);
  await sleep(died2.deploy.respawn.waitMs + 150);
  send({ t: 'deploy', kind: 'home' });
  await until(() => !you.dead);
});

test('respawn with no stash house: any town outside the circle round where you died', async (t) => {
  const B = 'b8'.repeat(16), ct = map.contacts[0];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzresp2-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [], houses: {},
    characters: { [B]: { name: 'Homeless', x: ct.x + 4, z: ct.z + 4, yaw: 0, hp: 100, armor: 0, inv: { primary: null, primary2: null, secondary: makeWeapon('sidearm'), armor: null, pack: [] }, ammo: 90, mags: {}, active: 'secondary', dead: false, kills: 0, xp: xpForLevel(6), cash: 50, comms: 0, food: 90, field: [], discovered: [ct.id], contracts: [] } } }));
  const port = 29990 + Math.floor(Math.random() * 9);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', RESPAWN_WAIT_S: '0', RESPAWN_KEEPAWAY_M: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const msgs = [];
  let you = null, at = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); msgs.push(m); if (m.t === 'you') you = m; if (m.t === 'correct' && m.force) at = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Homeless', token: B });
  await until(() => you && !you.dead);
  send({ t: 'dev', kill: true });
  const died = await until(() => msgs.find((m) => m.t === 'died'));
  assert.ok(!died.deploy.claim && died.deploy.towns.length >= 7);
  send({ t: 'deploy', kind: 'town', id: 0 });
  await until(() => msgs.find((m) => m.t === 'toast' && /Too close to where you died/.test(m.text)));
  const far = died.deploy.towns.find((tw) => Math.hypot(tw.x - ct.x, tw.z - ct.z) > ACT.respawn.keepAwayM + 200);
  send({ t: 'deploy', kind: 'town', id: far.id });
  await until(() => !you.dead);
  await sleep(200);
  assert.ok(Math.hypot(at.x - far.x, at.z - far.z) < 70, `back in ${far.name}`);
});
