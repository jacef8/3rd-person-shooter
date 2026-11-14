// The lobby hub: unique callsigns, friends, presence across worlds, invites that land you in your
// friend's world and crew, and deploying next to them. Runs the real hub with two worlds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(30); }
  throw new Error('timed out');
}
const PORT = 23000 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzh-'));

function hubConn(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/hub`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'state') c.state = m; if (m.t === 'account') c.account = m; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'hello', token }); r(c); }));
}
function worldConn(world, name, token, ticket) {
  const ws = new WebSocket(`ws://localhost:${PORT}/world/${world}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'welcome') c.welcome = m; if (m.t === 'you') c.you = m; if (m.t === 'squad') c.squad = m; if (m.t === 'correct' && m.force) c.pos = m; });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token, ticket }); r(c); }));
}

test('lobby: callsigns, friends, presence, invites into your world and crew, deploy together', async (t) => {
  const proc = spawn(process.execPath, ['server/hub.js'], {
    env: { ...process.env, PORT, WORLDS: '2', WORLD_PORT_BASE: String(PORT + 100), DATA_FILE: path.join(dir, 'world.json'), BOTS: '0', REAL_DATA: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGTERM'));
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  await until(() => (out.match(/Deadzone server/g) || []).length === 2 && out.includes('Deadzone hub'), 20000);

  // Callsigns: unique, case-insensitively.
  const a = await hubConn(null);
  await a.got((m) => m.t === 'needName');
  a.send({ t: 'register', name: 'Ava' });
  await until(() => a.account?.name === 'Ava');
  const b = await hubConn(null);
  await b.got((m) => m.t === 'needName');
  b.send({ t: 'register', name: 'ava' });
  await b.got((m) => m.t === 'error' && /taken/.test(m.text));
  b.send({ t: 'register', name: 'Ben' });
  await until(() => b.account?.name === 'Ben');
  // Coming back with your token logs you straight in.
  const a2 = await hubConn(a.account.token);
  await until(() => a2.account?.name === 'Ava');
  // A second device: a link code from a signed-in one, then callsign + code on the new one.
  a2.send({ t: 'linkCode' });
  const lc = await a2.got((m) => m.t === 'linkCode');
  const dev = await hubConn(null);
  await dev.got((m) => m.t === 'needName');
  dev.send({ t: 'link', name: 'Ben', code: lc.code });
  await dev.got((m) => m.t === 'error' && /don't match/.test(m.text));
  dev.send({ t: 'link', name: 'ava', code: lc.code.toLowerCase() });
  await until(() => dev.account?.name === 'Ava');
  assert.equal(dev.account.token, a.account.token, 'the new device plays as the same character');
  const dev2 = await hubConn(null);
  await dev2.got((m) => m.t === 'needName');
  dev2.send({ t: 'link', name: 'Ava', code: lc.code });
  await dev2.got((m) => m.t === 'error');   // a code works once
  dev.ws.close(); dev2.ws.close();
  a2.ws.close();

  // Friends: search, request, accept.
  a.send({ t: 'search', q: 'be' });
  const res = await a.got((m) => m.t === 'search' && m.results.length);
  assert.equal(res.results[0].name, 'Ben');
  a.send({ t: 'friendRequest', name: 'Ben' });
  await until(() => b.state?.requests.includes('Ava'));
  b.send({ t: 'friendAccept', name: 'Ava' });
  await until(() => a.state?.friends.some((f) => f.name === 'Ben') && b.state?.friends.some((f) => f.name === 'Ava'));

  // Ava plays world 2 (through the hub's proxy); Ben's lobby shows where she is.
  const wa = await worldConn(2, 'Ava', a.account.token);
  await until(() => wa.welcome);
  assert.equal(wa.welcome.world, 2);
  wa.send({ t: 'deploy', kind: 'contact', id: 0 });
  await wa.got((m) => m.t === 'deployed');
  await until(() => b.state?.friends.find((f) => f.name === 'Ava')?.world === 2 && b.state.worlds.find((w) => w.id === 2).friends.includes('Ava'), 8000);

  // Ava invites Ben to her world and crew: a crew pass from the world, delivered by the hub.
  wa.send({ t: 'squad', action: 'ticket', for: 'Ben' });
  const tk = await wa.got((m) => m.t === 'crewTicket');
  assert.ok(tk.ticket);
  a.send({ t: 'invite', name: 'Ben', world: 2, ticket: tk.ticket });
  const inv = await b.got((m) => m.t === 'invite');
  assert.equal(inv.from, 'Ava'); assert.equal(inv.world, 2);
  // Ben accepts: joins world 2 with the pass and lands in Ava's crew.
  const wb = await worldConn(inv.world, 'Ben', b.account.token, inv.ticket);
  await until(() => wb.welcome && wb.squad?.id && wa.squad?.members.length === 2);
  // His deploy screen offers to drop in next to Ava, and it puts him beside her.
  const opt = wb.welcome.deploy.crew.find((m) => m.name === 'Ava');
  assert.ok(opt, 'deploy next to your crewmate');
  wb.send({ t: 'deploy', kind: 'crew', id: opt.id });
  await wb.got((m) => m.t === 'deployed');
  const ap = wa.pos, bp = await until(() => wb.pos);
  assert.ok(Math.hypot(ap.x - bp.x, ap.z - bp.z) < 5, 'Ben drops in beside Ava');
  // A pass works once.
  const wc = await worldConn(2, 'Cal', null, tk.ticket);
  await until(() => wc.welcome);
  await sleep(300);
  assert.ok(!wc.squad?.id);

  // Only friends can be invited.
  a.send({ t: 'invite', name: 'Cal', world: 2 });
  await a.got((m) => m.t === 'error' && /only invite friends/.test(m.text));
});
