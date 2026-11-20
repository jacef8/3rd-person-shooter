// The voice relay: two crewmates who can't connect directly ask for it, and their speech frames go
// through the server to each other (tagged with who's talking), never to anyone else.
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
  const c = { ws, msgs: [], bins: [], name };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { c.bins.push(Buffer.from(raw)); return; }
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'welcome') c.welcome = m; if (m.t === 'squad') c.squad = m; if (m.t === 'you') c.you = m;
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('voice relay: speech goes through the server between crewmates, and only to them', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzvr-')), 'w.json');
  const A = tok('d1'), B = tok('e2'), C = tok('f3');
  const lz = map.landingZones[5], far = map.landingZones[11];
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [A]: character('Dad', lz.x, lz.z), [B]: character('Kid', far.x, far.z), [C]: character('Stranger', lz.x + 3, lz.z),
  } }));
  const port = 27300 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const a = await conn(port, 'Dad', A), b = await conn(port, 'Kid', B), c = await conn(port, 'Stranger', C);
  await until(() => a.welcome && b.welcome && c.welcome);
  a.send({ t: 'squad', action: 'create', name: 'Relay Crew' });
  await until(() => a.squad?.name === 'Relay Crew');
  a.send({ t: 'squad', action: 'invite', id: b.welcome.id });
  await b.got((m) => m.t === 'invite');
  b.send({ t: 'squad', action: 'accept' });
  await until(() => b.squad?.name === 'Relay Crew');
  // Voice on (crew for the family, nearby for all three).
  for (const x of [a, b, c]) x.send({ t: 'voice', crew: true, near: true });
  await a.got((m) => m.t === 'voicePeers' && m.peers.some((q) => q.id === b.welcome.id));

  // Before any relay is asked for, frames go nowhere.
  const frame = (seq, n = 400) => { const f = Buffer.alloc(2 + n, 0x55); f[0] = 1; f[1] = seq; return f; };
  a.ws.send(frame(1));
  await sleep(300);
  assert.equal(b.bins.length, 0);

  // The kid's direct line didn't connect: either side asks, both are told.
  b.send({ t: 'vrelay', id: a.welcome.id });
  await a.got((m) => m.t === 'vrelay' && m.id === b.welcome.id);
  await b.got((m) => m.t === 'vrelay' && m.id === a.welcome.id);
  // Someone who may not hear you can't be added.
  c.send({ t: 'vrelay', id: b.welcome.id });
  await sleep(300);
  assert.ok(!b.msgs.some((m) => m.t === 'vrelay' && m.id === c.welcome.id), 'a stranger far away cannot join the relay');

  // Dad talks: the kid gets each frame, tagged as Dad's; the stranger right next to Dad gets none.
  for (let i = 2; i < 7; i++) a.ws.send(frame(i));
  await until(() => b.bins.length >= 5);
  const got = b.bins[0], idLen = got[2], from = got.subarray(3, 3 + idLen).toString();
  assert.equal(got[0], 1);
  assert.equal(from, a.welcome.id);
  assert.equal(got.length - 3 - idLen, 400, 'the speech itself, unchanged');
  assert.equal(c.bins.length, 0);
  // And back the other way.
  b.ws.send(frame(9, 300));
  await until(() => a.bins.length >= 1);
  assert.equal(a.bins[0].subarray(3, 3 + a.bins[0][2]).toString(), b.welcome.id);
  // Junk is dropped: the wrong type, or far too big.
  const before = b.bins.length;
  const bad = Buffer.alloc(100); bad[0] = 7; a.ws.send(bad);
  a.ws.send(Buffer.alloc(3000, 1));
  await sleep(300);
  assert.equal(b.bins.length, before);
  // A flood is cut off at about 40 a second.
  for (let i = 0; i < 100; i++) a.ws.send(frame(i & 0xff, 50));
  await sleep(600);
  assert.ok(b.bins.length - before <= 41, `rate-limited (${b.bins.length - before})`);
});
