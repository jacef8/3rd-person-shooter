// The hub: the front door of the game. It serves the client, runs the lobby (world list, accounts,
// friends, invites) and routes each player's game connection to the world they picked.
//
// Each world is its own game server (server/index.js) running as a child process with its own save
// file, so every world has its own players, crews, bases and loot, like DayZ servers. The hub
// is the only thing exposed publicly.
//
//   ws /hub          lobby protocol (accounts, friends, presence, invites)
//   ws /world/<id>   proxied straight through to that world's game server
//
// Accounts: a unique callsign plus the secret login token the browser already keeps (dz_token).
// The same token identifies you in every world, so friends and invites work across worlds.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { serveStatic } from './static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
// Worlds keep the old single-world save as world 1, so existing characters and bases carry over.
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const DATA_DIR = path.dirname(DATA_FILE);
const HUB_FILE = process.env.HUB_FILE || path.join(DATA_DIR, 'hub.json');
const WORLD_PORT_BASE = Number(process.env.WORLD_PORT_BASE || 9100);
const WORLD_COUNT = Number(process.env.WORLDS || 1);   // one shared living world; more regions come later
const WORLD_CAP = Number(process.env.WORLD_CAP || 100);   // load-tested: see tools/load-test.mjs
const WORLDS = Array.from({ length: WORLD_COUNT }, (_, i) => ({
  id: i + 1,
  name: i === 0 ? 'Liberty County' : `Region ${i + 1}`,
  port: WORLD_PORT_BASE + i + 1,
  file: i === 0 ? DATA_FILE : path.join(DATA_DIR, `world-${i + 1}.json`),
  online: 0, names: [], up: false, proc: null,
}));
const worldById = new Map(WORLDS.map((w) => [w.id, w]));

// ---------------------------------------------------------------- worlds (child game servers)
let stopping = false;
function startWorld(w) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(w.port), DATA_FILE: w.file, WORLD_ID: String(w.id), WORLD_NAME: w.name },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],   // the IPC channel lets a world notice if the hub dies
  });
  w.proc = proc;
  proc.stdout.on('data', (d) => {
    const text = String(d);
    if (text.includes('Deadzone server')) w.up = true;
    process.stdout.write(`[${w.name}] ${text}`);
  });
  proc.on('exit', (code, sig) => {
    w.up = false; w.online = 0; w.names = [];
    if (stopping) return;
    console.log(`[${w.name}] exited (${code ?? sig}); restarting in 2 s`);
    setTimeout(() => startWorld(w), 2000);
  });
}
for (const w of WORLDS) startWorld(w);

async function pollWorlds() {
  for (const w of WORLDS) {
    try {
      const r = await fetch(`http://127.0.0.1:${w.port}/status`, { signal: AbortSignal.timeout(1500) });
      const s = await r.json();
      w.online = s.online; w.names = s.names; w.up = true;
    } catch { w.online = 0; w.names = []; }
  }
  pushAll();
}
setInterval(pollWorlds, 3000);

// ---------------------------------------------------------------- accounts and friends
function loadHub() {
  try { return JSON.parse(fs.readFileSync(HUB_FILE, 'utf8')); } catch { return { accounts: {} }; }
}
const hub = loadHub();
hub.accounts ??= {};
let hubDirty = false;
function saveHub() {
  if (!hubDirty) return;
  hubDirty = false;
  fs.mkdirSync(path.dirname(HUB_FILE), { recursive: true });
  fs.writeFileSync(HUB_FILE + '.tmp', JSON.stringify(hub));
  fs.renameSync(HUB_FILE + '.tmp', HUB_FILE);
}
setInterval(saveHub, 5000);
const touch = () => { hubDirty = true; };
const byName = (name) => Object.entries(hub.accounts).find(([, a]) => a.name.toLowerCase() === String(name).toLowerCase()) || null;
const cleanName = (n) => String(n || '').replace(/[^\w \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
/** Which world a callsign is playing in right now (from the worlds' own player lists). */
function worldOf(name) {
  const n = name.toLowerCase();
  for (const w of WORLDS) if (w.names.some((x) => x.toLowerCase() === n)) return w;
  return null;
}

// ---------------------------------------------------------------- lobby connections
const sockets = new Map();   // token -> Set(ws)
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function sendTo(token, m) { for (const ws of sockets.get(token) || []) send(ws, m); }
const online = (token) => (sockets.get(token)?.size || 0) > 0;
function view(token) {
  const a = hub.accounts[token];
  const person = (t) => {
    const o = hub.accounts[t];
    if (!o) return null;
    const w = worldOf(o.name);
    return { name: o.name, online: online(t) || !!w, world: w?.id ?? null, worldName: w?.name ?? null };
  };
  return {
    t: 'state',
    me: { name: a.name, world: worldOf(a.name)?.id ?? null },
    worlds: WORLDS.map((w) => ({ id: w.id, name: w.name, online: w.online, cap: WORLD_CAP, up: w.up, friends: a.friends.filter((f) => hub.accounts[f] && worldOf(hub.accounts[f].name) === w).map((f) => hub.accounts[f].name) })),
    friends: a.friends.map(person).filter(Boolean).sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name)),
    requests: a.requestsIn.map((t) => hub.accounts[t]?.name).filter(Boolean),
    sent: Object.entries(hub.accounts).filter(([, o]) => o.requestsIn.includes(token)).map(([, o]) => o.name),
    recent: a.recent.filter((t) => !a.friends.includes(t)).map(person).filter(Boolean).slice(0, 12),
  };
}
function push(token) { if (hub.accounts[token] && online(token)) sendTo(token, view(token)); }
function pushAll() { for (const t of sockets.keys()) push(t); }

function register(ws, token, raw) {
  const name = cleanName(raw);
  if (name.length < 3) return send(ws, { t: 'error', text: 'Callsigns need at least 3 letters or numbers' });
  const taken = byName(name);
  if (taken && taken[0] !== token) return send(ws, { t: 'error', text: `${name} is taken — pick another callsign` });
  // Keep the browser's existing token if it has one, so its characters in the worlds carry over.
  const tok = /^[a-f0-9]{32}$/.test(token || '') && !hub.accounts[token] ? token : crypto.randomBytes(16).toString('hex');
  hub.accounts[tok] = { name, created: Date.now(), friends: [], requestsIn: [], recent: [] };
  touch();
  attach(ws, tok);
}
function attach(ws, token) {
  ws.token = token;
  if (!sockets.has(token)) sockets.set(token, new Set());
  sockets.get(token).add(ws);
  send(ws, { t: 'account', token, name: hub.accounts[token].name });
  push(token);
  for (const f of hub.accounts[token].friends) push(f);   // friends see you come online
}

function friendRequest(token, name) {
  const me = hub.accounts[token];
  const found = byName(name);
  if (!found) return sendTo(token, { t: 'error', text: `No agent called ${cleanName(name)}` });
  const [ft, f] = found;
  if (ft === token) return;
  if (me.friends.includes(ft)) return sendTo(token, { t: 'note', text: `${f.name} is already your friend` });
  if (me.requestsIn.includes(ft)) return friendAccept(token, f.name);   // they asked you first
  if (!f.requestsIn.includes(token)) f.requestsIn.push(token);
  touch();
  sendTo(ft, { t: 'note', text: `${me.name} sent you a friend request` });
  sendTo(token, { t: 'note', text: `Friend request sent to ${f.name}` });
  push(ft); push(token);
}
function friendAccept(token, name) {
  const me = hub.accounts[token];
  const found = byName(name);
  if (!found) return;
  const [ft, f] = found;
  if (!me.requestsIn.includes(ft)) return;
  me.requestsIn = me.requestsIn.filter((t) => t !== ft);
  if (!me.friends.includes(ft)) me.friends.push(ft);
  if (!f.friends.includes(token)) f.friends.push(token);
  touch();
  sendTo(ft, { t: 'note', text: `${me.name} accepted your friend request` });
  push(ft); push(token);
}
function friendDecline(token, name) {
  const me = hub.accounts[token];
  const found = byName(name);
  if (!found) return;
  me.requestsIn = me.requestsIn.filter((t) => t !== found[0]);
  touch(); push(token);
}
function unfriend(token, name) {
  const found = byName(name);
  if (!found) return;
  const me = hub.accounts[token], [ft, f] = found;
  me.friends = me.friends.filter((t) => t !== ft);
  f.friends = f.friends.filter((t) => t !== token);
  touch(); push(token); push(ft);
}
/** Players you've been in a world with (reported by your client), for one-tap friend requests. */
function met(token, names) {
  const me = hub.accounts[token];
  for (const n of (Array.isArray(names) ? names : []).slice(0, 20)) {
    const found = byName(n);
    if (!found || found[0] === token) continue;
    me.recent = [found[0], ...me.recent.filter((t) => t !== found[0])].slice(0, 20);
  }
  touch();
}
function invite(token, msg) {
  const me = hub.accounts[token];
  const found = byName(msg.name);
  if (!found || !me.friends.includes(found[0])) return sendTo(token, { t: 'error', text: 'You can only invite friends' });
  const w = worldById.get(Number(msg.world)) || worldOf(me.name);
  if (!w) return sendTo(token, { t: 'error', text: 'Pick a world to invite them to' });
  if (!online(found[0])) return sendTo(token, { t: 'error', text: `${found[1].name} isn't online` });
  sendTo(found[0], { t: 'invite', from: me.name, world: w.id, worldName: w.name, ticket: typeof msg.ticket === 'string' ? msg.ticket.slice(0, 40) : null });
  sendTo(token, { t: 'note', text: `Invited ${found[1].name} to ${w.name}` });
}
function search(token, q) {
  const s = cleanName(q).toLowerCase();
  if (s.length < 2) return sendTo(token, { t: 'search', q, results: [] });
  const me = hub.accounts[token];
  const results = Object.entries(hub.accounts)
    .filter(([t, a]) => t !== token && a.name.toLowerCase().includes(s))
    .sort(([, a], [, b]) => (a.name.toLowerCase().startsWith(s) ? 0 : 1) - (b.name.toLowerCase().startsWith(s) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map(([t, a]) => ({ name: a.name, online: online(t) || !!worldOf(a.name), friend: me.friends.includes(t), requested: a.requestsIn.includes(token) }));
  sendTo(token, { t: 'search', q, results });
}

const hubWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
hubWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!ws.token) {
      if (m.t === 'hello') {
        if (typeof m.token === 'string' && hub.accounts[m.token]) return attach(ws, m.token);
        return send(ws, { t: 'needName', suggest: cleanName(m.name) });
      }
      if (m.t === 'register') return register(ws, m.token, m.name);
      return;
    }
    const t = ws.token;
    switch (m.t) {
      case 'search': return search(t, m.q);
      case 'friendRequest': return friendRequest(t, m.name);
      case 'friendAccept': return friendAccept(t, m.name);
      case 'friendDecline': return friendDecline(t, m.name);
      case 'unfriend': return unfriend(t, m.name);
      case 'met': return met(t, m.names);
      case 'invite': return invite(t, m);
      case 'refresh': return push(t);
    }
  });
  ws.on('close', () => {
    const t = ws.token;
    if (!t) return;
    sockets.get(t)?.delete(ws);
    if (!sockets.get(t)?.size) { sockets.delete(t); for (const f of hub.accounts[t]?.friends || []) push(f); }
  });
});

// ---------------------------------------------------------------- http: static files + routing
const STATIC = [
  ['/vendor/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'archivo', 'files')],
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'atkinson-hyperlegible', 'files')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/data/real/', process.env.REAL_DATA_DIR || path.join(ROOT, 'data', 'real')],
  ['/', path.join(ROOT, 'client')],
];
const handler = (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/worlds') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(WORLDS.map((w) => ({ id: w.id, name: w.name, online: w.online, up: w.up }))));
  }
  if (serveStatic(req, res, url, STATIC)) return;
  res.writeHead(404); res.end('Not found');
};
const TLS = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  const m = url.match(/^\/world\/(\d+)/);
  if (m) {
    // Pass the game connection straight through to the world's server.
    const w = worldById.get(Number(m[1]));
    if (!w || !w.up) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    const up = net.connect(w.port, '127.0.0.1', () => {
      let h = `${req.method} / HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(h + '\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return;
  }
  if (url.startsWith('/hub')) return hubWss.handleUpgrade(req, socket, head, (ws) => hubWss.emit('connection', ws, req));
  socket.destroy();
});

server.listen(PORT, () => console.log(`Deadzone hub on ${TLS ? 'https' : 'http'}://localhost:${PORT}  (${WORLDS.length} worlds: ${WORLDS.map((w) => w.name).join(', ')})`));

// Redeploys: let every world save, then exit cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    stopping = true;
    hubDirty = true;
    try { saveHub(); } catch (e) { console.error('Hub save failed:', e); }
    const alive = WORLDS.filter((w) => w.proc && w.proc.exitCode === null);
    for (const w of alive) w.proc.kill('SIGTERM');
    let left = alive.length;
    const done = () => { console.log(`Hub shut down (${sig})`); process.exit(0); };
    if (!left) done();
    for (const w of alive) w.proc.once('exit', () => { if (--left === 0) done(); });
    setTimeout(done, 8000).unref();
  });
}
