// The Annex compound: Halyard's walled yard in the forest. Sealed between openings (anyone caught inside
// can let themselves out), opens on its own clock, and its crates open only for a crew holding the access
// codes (all twelve Annex files). What comes out is hot: everyone else sees the carrier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dza-'));
const PORT = 27900 + Math.floor(Math.random() * 600);

function conn(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); c.msgs.push(m);
    if (m.t === 'you') c.you = m; if (m.t === 'snap') c.snap = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'annex') c.annex = m;
    if (m.t === 'correct' && m.force) { c.tpn = m.tp; c.at = { x: m.x, z: m.z }; }
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await sleep(250); };
  c.since = (n, fn) => until(() => c.msgs.slice(n).find(fn));
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token: null }); r(c); }));
}
// Compound space to the world, as the server lays it out: u along the gate wall, v out through the gate.
const W = (s, u, v) => ({ x: s.x + u * -s.fz + v * s.fx, z: s.z + u * s.fx + v * s.fz });

test('the Annex: sealed, opens on its clock, crates only for a crew with the codes', async (t) => {
  const file = path.join(dir, 'world.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, houses: {}, bags: [], structures: [], characters: {} }));
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999', HOTZONE_FIRST_MS: '99999999',
      ANNEX_FIRST_MS: '7000', ANNEX_OPEN_MS: '22000', ANNEX_WARN_MS: '3000', ANNEX_CRATE_MS: '400', ANNEX_GUARDS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGTERM'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  const a = await conn('Keyholder'), b = await conn('Outsider');
  for (const c of [a, b]) { await until(() => c.welcome); c.send({ t: 'deploy', kind: 'town', id: 0 }); }
  const ax = await until(() => a.annex);
  assert.ok(ax.site && !ax.open && ax.opensAt > Date.now(), 'the compound is on the map, locked, with a time it opens');
  assert.equal(ax.key, false, 'a new player has no codes');
  const s = ax.site, H = s.h;

  // Locked: the gate is a real, shut, Halyard-owned gate.
  const out = W(s, 0, H + 1.4);
  await a.tp(out.x, out.z);
  const gate = await until(() => a.snap?.structs?.find((q) => q.ax && q.type === 'gate' && Math.hypot(q.x - out.x, q.z - out.z) < 3));
  assert.equal(gate.open, false);
  assert.equal(gate.owner, 'Halyard');
  assert.equal(gate.mine, 0);
  let n = a.msgs.length;
  a.send({ t: 'interact' });
  await a.since(n, (m) => m.t === 'toast' && /sealed/i.test(m.text));

  // Nothing breaks it: shots into the gate leave it whole.
  a.send({ t: 'state', x: out.x, z: out.z, yaw: Math.atan2(-s.fx, -s.fz), pitch: 0, sprint: false, tp: a.tpn || 0 });
  for (let i = 0; i < 4; i++) { a.send({ t: 'shoot', dir: [-s.fx, 0, -s.fz] }); await sleep(400); }
  await sleep(600);
  const g2 = a.snap.structs.find((g) => g.id === gate.id);
  assert.equal(g2.hp, gate.hp, 'not a scratch');

  // Caught inside while it's locked: the emergency release lets you out, beyond the wall.
  const inside = W(s, 0, H - 1.4);
  await a.tp(inside.x, inside.z);
  n = a.msgs.length;
  a.send({ t: 'interact' });
  await a.since(n, (m) => m.t === 'toast' && /emergency release/i.test(m.text));
  const q = { dx: a.at.x - s.x, dz: a.at.z - s.z };
  assert.ok(q.dx * s.fx + q.dz * s.fz > H, 'put outside the gate');

  // Warned, then open: the gate stands open and the armory crates are out.
  await until(() => a.msgs.find((m) => m.t === 'toast' && /gate circuit is failing/.test(m.text)), 10000);
  const open = await until(() => a.annex.open && a.annex, 12000);
  assert.equal(open.crates.length, 6);
  await a.tp(out.x, out.z);
  await until(() => a.snap?.structs?.find((g) => g.id === gate.id)?.open === true);

  // No codes, no crate.
  const c1 = open.crates[4], c2 = open.crates[5];
  await b.tp(c1.x + 1, c1.z);
  n = b.msgs.length;
  b.send({ t: 'interact' });
  await b.since(n, (m) => m.t === 'toast' && /Halyard keypad/.test(m.text));

  // All twelve files: the codes. The crate opens, and what's in it is hot.
  a.send({ t: 'dev', annexIntel: 60 });
  await until(() => a.msgs.filter((m) => m.t === 'annexDoc').length === 12);
  await until(() => a.annex.key === true);
  await a.tp(c1.x + 1, c1.z);
  n = a.msgs.length;
  a.send({ t: 'interact' });
  await a.since(n, (m) => m.t === 'hack' && m.kind === 'annexcrate');
  const done = await a.since(n, (m) => m.t === 'hack' && m.done);
  assert.match(done.text, /Annex crate open/);
  const hot = await until(() => a.you?.inv?.pack?.filter((i) => i.hot === 'annex'));
  assert.equal(hot.length, 3, 'a gun, armor and a strongbox');
  assert.ok(hot.some((i) => /Annex armory/.test(i.name)));
  await b.since(0, (m) => m.t === 'alert' && /Hot loot carrier \(Keyholder\)/.test(m.text));

  // One each per opening.
  await a.tp(c2.x + 1, c2.z);
  n = a.msgs.length;
  a.send({ t: 'interact' });
  await a.since(n, (m) => m.t === 'toast' && /opened your Annex crate/.test(m.text));

  // Then it locks again, with the next opening already set.
  const shut = await until(() => a.annex && !a.annex.open && a.annex.opensAt > Date.now() && a.annex, 25000);
  assert.equal(shut.crates.length, 0);
  await a.tp(out.x, out.z);
  await until(() => a.snap?.structs?.find((g) => g.id === gate.id)?.open === false);
  for (const c of [a, b]) c.ws.close();
});
