// How many players can one world hold? Starts a world server, connects N fake players who walk
// about (20 updates a second, like the real client) and now and then shoot, and reads how long
// each server tick takes. A tick has 50 ms; past about half that, the world starts to lag.
//
//   node tools/load-test.mjs 40 100 150 200      (player counts to try; default 40 100 150)
//
// Half the players gather in the towns (the worst case: everyone sees everyone), half spread over
// the county. Rogues are on, as on the hosted server. Numbers depend on the machine it runs on.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const WebSocket = createRequire(import.meta.url)('ws');

const counts = process.argv.slice(2).map(Number).filter((n) => n > 0);
const tries = counts.length ? counts : [40, 100, 150];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 29900 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzload-'));

const proc = spawn(process.execPath, [...(process.env.SERVER_NODE_ARGS || '').split(' ').filter(Boolean), 'server/index.js'], {
  env: { ...process.env, PORT: String(port), DATA_FILE: path.join(dir, 'world.json'), ALLOW_DEV: '1', SAVE_EVERY_MS: '600000' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
const status = async () => (await fetch(`http://localhost:${port}/status`)).json();

const bots = [];
let received = 0;
function player(i) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const b = { ws, i, x: 0, z: 0, a: Math.random() * 6.28, tp: 0, ready: false };
  ws.on('message', (raw) => {
    received += raw.length;
    const m = JSON.parse(raw);
    if (m.t === 'welcome') { b.contacts = m.deploy; ws.send(JSON.stringify({ t: 'deploy', kind: 'contact', id: i % 6 })); }
    if (m.t === 'correct') { b.x = m.x; b.z = m.z; if (m.force) b.tp = m.tp; b.ready = true; }
    if (m.t === 'you' && !b.ready && !m.dead) b.ready = true;
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: `Load${i}`, token: crypto.randomBytes(16).toString('hex') })));
  return b;
}
const timer = setInterval(() => {
  for (const b of bots) {
    if (b.ws.readyState !== 1 || !b.ready) continue;
    b.a += 0.03;
    b.x += Math.cos(b.a) * 0.25; b.z += Math.sin(b.a) * 0.25;   // a walking pace at 20 updates a second
    b.ws.send(JSON.stringify({ t: 'state', tp: b.tp, x: b.x, z: b.z, yaw: b.a, pitch: 0, crouch: false, aim: false, sprint: false }));
    if (Math.random() < 0.01) b.ws.send(JSON.stringify({ t: 'shoot', dir: [Math.cos(b.a), 0, Math.sin(b.a)] }));
  }
}, 50);

console.log('players | tick avg ms | tick max ms | out MB/s to clients (all) | verdict');
for (const n of tries) {
  while (bots.length < n) {
    const b = player(bots.length);
    bots.push(b);
    if (bots.length % 2) setTimeout(() => { if (b.ws.readyState === 1) { const x = (Math.random() - 0.5) * 24000, z = (Math.random() - 0.5) * 24000; b.ws.send(JSON.stringify({ t: 'dev', x, z })); b.x = x; b.z = z; } }, 3000);
    await sleep(40);
  }
  await sleep(15000);   // settle: Rogues spawn around everyone
  received = 0;
  const t0 = Date.now();
  const samples = [];
  for (let k = 0; k < 10; k++) { await sleep(1000); samples.push(await status()); }
  const avg = samples.reduce((a, s) => a + s.tickMs, 0) / samples.length;
  const max = Math.max(...samples.map((s) => s.tickMaxMs));
  const mbps = received / ((Date.now() - t0) / 1000) / 1e6;
  const verdict = avg < 12 && max < 45 ? 'fine' : avg < 25 && max < 50 ? 'busy' : 'too many';
  console.log(`${String(n).padStart(7)} | ${avg.toFixed(1).padStart(11)} | ${max.toFixed(1).padStart(11)} | ${mbps.toFixed(2).padStart(25)} | ${verdict}`);
}
clearInterval(timer);
for (const b of bots) b.ws.close();
proc.kill(process.env.SERVER_NODE_ARGS ? 'SIGINT' : 'SIGKILL');
await sleep(1500);
process.exit(0);
