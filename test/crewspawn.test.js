// Playing together: spawn on a crewmate (after a death or to join in) unless they're in the middle of
// something, and text chat to your crew (anywhere) or to whoever's nearby.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const tok = (s) => s.repeat(32 / s.length);
function character(name, x, z) {
  const w = makeWeapon('carbine');
  return { name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] }, ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(3), parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, comms: 0, field: [], discovered: [], contracts: [] };
}
function conn(port, name, token) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, msgs: [], name };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'correct' && m.force) { c.tpn = m.tp; c.pos = { x: m.x, z: m.z }; }
    if (m.t === 'you') c.you = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'squad') c.squad = m;
    if (m.t === 'died') c.deploy = m.deploy; if (m.t === 'deployOpts') c.deploy = m.deploy;
  });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.toast = (re, ms) => c.got((m) => m.t === 'toast' && re.test(m.text), ms);
  c.chats = () => c.msgs.filter((m) => m.t === 'chat');
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(150); };
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('spawn on a crewmate unless they are busy; crew and nearby text chat', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzcrew-')), 'w.json');
  const A = tok('a7'), B = tok('b8'), C = tok('c9');
  const lz = map.landingZones[3], far = map.landingZones[9];
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [A]: character('Dad', lz.x, lz.z), [B]: character('Kid', lz.x + 3, lz.z), [C]: character('Stranger', far.x, far.z),
  } }));
  const port = 26300 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', CREW_CALM_S: '2' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const a = await conn(port, 'Dad', A), b = await conn(port, 'Kid', B), c = await conn(port, 'Stranger', C);
  await until(() => a.welcome && b.welcome && c.welcome);
  a.send({ t: 'squad', action: 'create', name: 'Ford Family' });
  await until(() => a.squad?.name === 'Ford Family');
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.squad?.name === 'Ford Family' && a.squad.members.length === 2);

  // Crew chat reaches the crew wherever they are, never the stranger; a swear is starred out.
  await b.tp(far.x + 200, far.z);
  a.send({ t: 'chat', ch: 'crew', text: 'meet at the bridge  what the fuck' });
  const heard = await until(() => b.chats().find((m) => m.ch === 'crew'));
  assert.equal(heard.from, 'Dad');
  assert.equal(heard.text, 'meet at the bridge what the ****');
  await sleep(300);
  assert.ok(!c.chats().length, 'the stranger heard nothing');
  // Nearby chat: only who's close.
  await c.tp(lz.x + 10, lz.z);
  c.send({ t: 'chat', ch: 'near', text: 'hello there' });
  await until(() => a.chats().find((m) => m.ch === 'near' && m.from === 'Stranger'));
  await sleep(300);
  assert.ok(!b.chats().some((m) => m.ch === 'near'), 'too far away to hear it');

  // The kid dies far away: Dad is just walking around, so they can spawn on him.
  b.send({ t: 'dev', kill: true });
  await until(() => b.deploy?.crew?.some((m) => m.name === 'Dad'));
  const dad = () => b.deploy.crew.find((m) => m.name === 'Dad');
  assert.equal(dad().busy, null);
  // Dad gets shot: in a fight, so not now (the deploy map says so).
  a.send({ t: 'dev', damage: 5 });
  await until(() => /in a fight/.test(dad()?.busy || ''), 6000);
  b.send({ t: 'deploy', kind: 'crew', id: a.welcome.id });
  await b.toast(/in a fight/);
  // A couple of quiet seconds later (CREW_CALM_S here; 30 s in the game) it's open again.
  await until(() => b.deploy && dad()?.busy === null, 8000);
  b.pos = null;
  b.send({ t: 'deploy', kind: 'crew', id: a.welcome.id });
  await until(() => b.pos && Math.hypot(b.pos.x - lz.x, b.pos.z - lz.z) < 8);
  await until(() => b.you && !b.you.dead);
});
