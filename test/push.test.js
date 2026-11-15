// Base alerts: a device subscribes; a test alert goes out at once; and when the owner is out of the
// game and someone sets off a mine at their base, a signed, encrypted push goes to the device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { placementProblem } from '../shared/building.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };
const spot = map.campSites.find((c) => !placementProblem(world, 'mine', c.x, c.z, 0, { x: c.x, z: c.z + 3 }));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

test('base alerts: a test push, and a real one when your base is hit while you are away', async (t) => {
  // A stand-in for the phone's push service.
  const got = [];
  // Push services are HTTPS: a throwaway self-signed certificate for the stand-in (the test server trusts it).
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzcert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const ep = https.createServer({ key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) }, (req, res) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { got.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); }); });
  await new Promise((r) => ep.listen(0, r));
  t.after(() => ep.close());
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const sub = { endpoint: `https://localhost:${ep.address().port}/push/abc`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };

  const O = 'a9'.repeat(16), I = 'b8'.repeat(16);
  const w = makeWeapon('carbine');
  const ch = (name, x, z) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [{ id: 'th', kind: 'tool', tool: 'hammer', name: 'hammer' }] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), parts: 100, tech: 50, salvage: 100, cash: 0, comms: 0, food: 90, field: [], discovered: [], contracts: [] });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzpush-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: { [O]: ch('Owner', spot.x, spot.z + 3), [I]: ch('Raider', spot.x + 40, spot.z) } }));
  const port = 32900 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REAL_DATA: '0', PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', DEV_KIT: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const conn = (name, token) => new Promise((r) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { ws, msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'correct' && m.force) c.tpn = m.tp; });
    c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
    c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(200); };
    ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); });
  });
  const o = await conn('Owner', O);
  await until(() => o.you);
  const welcome = o.msgs.find((m) => m.t === 'welcome');
  assert.ok(welcome.pushKey && welcome.pushKey.length > 60, 'the world hands out its public key');
  o.send({ t: 'pushSub', sub, fresh: 1 });
  await until(() => o.msgs.some((m) => m.t === 'toast' && /Base alerts are on/.test(m.text)));
  // The test button.
  o.send({ t: 'pushTest' });
  await until(() => got.length === 1);
  assert.match(got[0].headers.authorization || '', /^vapid t=/);
  assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
  assert.ok(got[0].body.length > 30, 'an encrypted payload');
  // A mine at the base, then the owner logs off and a raider walks onto it.
  o.send({ t: 'build', piece: 'mine', x: spot.x, z: spot.z, rot: 0 });
  const mine = await until(() => o.snap?.structs.find((s) => s.type === 'mine'), 6000);
  await new Promise((r) => { o.ws.once('close', r); o.ws.close(); });
  await sleep(300);
  const i = await conn('Raider', I);
  await until(() => i.you);
  await i.tp(mine.x + 2.2, mine.z);
  for (let k = 0; k < 8; k++) { i.send({ t: 'state', x: mine.x + 2.2 - k * 0.3, z: mine.z, yaw: 0, pitch: 0 }); await sleep(60); }
  await until(() => got.length === 2, 6000);
  assert.equal(got[1].headers.urgency, 'high');
});
