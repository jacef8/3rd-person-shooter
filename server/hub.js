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
import { cleanEdits } from '../shared/edits.js';
import webpush from 'web-push';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
// Worlds keep the old single-world save as world 1, so existing characters and bases carry over.
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'world.json');
const DATA_DIR = path.dirname(DATA_FILE);
const HUB_FILE = process.env.HUB_FILE || path.join(DATA_DIR, 'hub.json');
// Phone notifications are signed with one key pair (VAPID). From the environment if it's set there;
// otherwise made once and kept beside the hub's data, so phones stay subscribed across restarts.
// Every world inherits it.
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const file = path.join(DATA_DIR, 'vapid.json');
  let keys = null;
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!keys?.publicKey) {
    keys = webpush.generateVAPIDKeys();
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(keys)); } catch { /* read-only: keys last until restart */ }
  }
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}
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
  w.startedAt = Date.now();
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
/** A new callsign for your account: your level, home, gear and friends stay (they're kept by your
 *  device's key, not your name); you show up under the new name next time you join a world. */
function rename(token, raw) {
  const a = hub.accounts[token], name = cleanName(raw);
  if (!a) return;
  if (name.length < 3) return sendTo(token, { t: 'error', text: 'Callsigns need at least 3 letters or numbers' });
  const taken = byName(name);
  if (taken && taken[0] !== token) return sendTo(token, { t: 'error', text: `${name} is taken — pick another callsign` });
  a.name = name;
  touch();
  sendTo(token, { t: 'account', token, name });
  push(token);
  for (const f of a.friends) push(f);
}
function attach(ws, token) {
  ws.token = token;
  if (!sockets.has(token)) sockets.set(token, new Set());
  sockets.get(token).add(ws);
  send(ws, { t: 'account', token, name: hub.accounts[token].name });
  push(token);
  for (const f of hub.accounts[token].friends) push(f);   // friends see you come online
}

// ---------------------------------------------------------------- the same callsign on another device
// There are no passwords: a device knows you by a key it keeps. To play as yourself on a second
// device (a phone, the Shield app, another browser), ask for a link code on the one you already use
// and type your callsign and the code on the new one. Codes last ten minutes and work once.
const linkCodes = new Map();   // code -> { token, expires }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I to mix up
function linkCode(token) {
  const now = Date.now();
  for (const [c, l] of linkCodes) if (l.expires < now || l.token === token) linkCodes.delete(c);
  let code;
  do code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join(''); while (linkCodes.has(code));
  linkCodes.set(code, { token, expires: now + 10 * 60_000 });
  sendTo(token, { t: 'linkCode', code, expires: now + 10 * 60_000 });
}
function linkDevice(ws, name, code) {
  ws.linkTries = (ws.linkTries || 0) + 1;
  if (ws.linkTries > 5) return send(ws, { t: 'error', text: 'Too many tries. Reload the page and ask for a new code.' });
  const l = linkCodes.get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const acc = l && l.expires > Date.now() && hub.accounts[l.token];
  if (!acc || acc.name.toLowerCase() !== cleanName(name).toLowerCase()) return send(ws, { t: 'error', text: "That callsign and code don't match. Codes last ten minutes." });
  for (const [c, x] of linkCodes) if (x.token === l.token) linkCodes.delete(c);
  attach(ws, l.token);
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
      if (m.t === 'link') return linkDevice(ws, m.name, m.code);
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
      case 'linkCode': return linkCode(t);
      case 'rename': return rename(t, m.name);
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
  ['/addons/', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm')],
  ['/g/', path.join(ROOT, 'godot', 'web')],   // the Godot client's web build (tools: see godot/README.md)
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'archivo', 'files')],
  ['/fonts/', path.join(ROOT, 'node_modules', '@fontsource', 'atkinson-hyperlegible', 'files')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/data/real/', process.env.REAL_DATA_DIR || path.join(ROOT, 'data', 'real')],
  ['/', path.join(ROOT, 'client')],
];
// ---------------------------------------------------------------- the map editor (client/editor.html)
// Hand fixes to the real buildings, saved beside the worlds' saves (map-edits.json) and read by each
// world when it starts. Only with the editor key (EDITOR_KEY): there's no editing without one.
const EDITS_FILE = process.env.MAP_EDITS_FILE || path.join(DATA_DIR, 'map-edits.json');
const REAL_DIR = process.env.REAL_DATA_DIR || path.join(ROOT, 'data', 'real');
let buildingCount = null;
const countBuildings = () => {
  if (buildingCount == null) {
    const n = (f, k) => { try { return JSON.parse(fs.readFileSync(path.join(REAL_DIR, f), 'utf8'))[k]?.length || 0; } catch { return 0; } };
    buildingCount = n('structures.json', 'rows') + n('county.json', 'structures');
  }
  return buildingCount;
};
const editorOk = (req) => {
  const key = process.env.EDITOR_KEY || '', got = String(req.headers['x-editor-key'] || '');
  return key.length >= 12 && got.length === key.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
};
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
/** Ask the first world something (its answer has the same `t`), or `fallback` if it can't say. */
function askWorld(msg, fallback, waitMs = 2500) {
  const w = WORLDS[0];
  if (!w.proc?.connected || !w.up) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const id = crypto.randomBytes(4).toString('hex');
    const on = (m) => { if (m?.t === msg.t && m.id === id) { w.proc.off('message', on); clearTimeout(t); resolve(m); } };
    const t = setTimeout(() => { w.proc.off('message', on); resolve(fallback); }, waitMs);
    w.proc.on('message', on);
    w.proc.send({ ...msg, id });
  });
}
/** Which buildings are someone's stash house right now, and which edits the world couldn't build. */
const worldStatus = () => askWorld({ t: 'claims' }, { list: [], missing: [] });
const claimedBuildings = async () => (await worldStatus()).list || [];
// ---------------------------------------------------------------- the map for the Godot client (server/gmap.js)
// The same county the world runs on, so map editor fixes reach the Godot client with no rebuild.
const GMAP_FILES = { 'meta.json': ['meta.json.gz', 'application/json', true], 'heights.d16.gz': ['heights.d16.gz', 'application/octet-stream'], 'colors.rgb.gz': ['colors.rgb.gz', 'application/octet-stream'] };
async function gmapApi(req, res, url) {
  const name = url.slice('/gmap/'.length).split('?')[0];
  if (name === 'nature') {
    const q = new URL(req.url, 'http://x').searchParams.get('t') || '';
    const tiles = q.split(';').slice(0, 64).map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isInteger));
    const ans = await askWorld({ t: 'nature', tiles }, null, 5000);
    return ans ? json(res, 200, { tiles: ans.tiles }) : json(res, 503, { error: 'World not ready' });
  }
  const f = GMAP_FILES[name];
  if (!f) return json(res, 404, { error: 'No such file' });
  const ans = await askWorld({ t: 'gmap' }, null, 120000);
  if (!ans?.dir) return json(res, 503, { error: ans?.error || 'World not ready' });
  fs.readFile(path.join(ans.dir, f[0]), (err, buf) => {
    if (err) return json(res, 500, { error: 'Missing' });
    res.writeHead(200, { 'Content-Type': f[1], ...(f[2] ? { 'Content-Encoding': 'gzip' } : {}), 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
    res.end(buf);
  });
}
async function editorApi(req, res, url) {
  if (!process.env.EDITOR_KEY) return json(res, 404, { error: 'The map editor is switched off on this server (no EDITOR_KEY).' });
  if (!editorOk(req)) return json(res, 403, { error: 'Wrong editor key' });
  const read = () => { try { return JSON.parse(fs.readFileSync(EDITS_FILE, 'utf8')); } catch { return { v: 1, b: {} }; } };
  if (url === '/api/editor/edits' && req.method === 'GET') return json(res, 200, { edits: read(), ...(await worldStatus().then((st) => ({ claims: st.list || [], missing: st.missing || [] }))), started: WORLDS[0].startedAt || 0, savedAt: (() => { try { return fs.statSync(EDITS_FILE).mtimeMs; } catch { return 0; } })() });
  if (url === '/api/editor/edits' && req.method === 'PUT') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 2e6) return json(res, 413, { error: 'Too big' }); }
    let raw; try { raw = JSON.parse(body); } catch { return json(res, 400, { error: 'Not JSON' }); }
    const edits = cleanEdits(raw, countBuildings());
    if (!edits) return json(res, 400, { error: 'Not map edits' });
    // A stash house can't be taken out from under its owner.
    const claimed = new Map(await claimedBuildings());
    for (const [k, e] of Object.entries(edits.b)) if (e.gone && claimed.has(Number(k))) return json(res, 409, { error: `Building ${k} is ${claimed.get(Number(k)) || 'someone'}'s stash house: it can be moved, not removed` });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EDITS_FILE + '.tmp', JSON.stringify(edits));
    fs.renameSync(EDITS_FILE + '.tmp', EDITS_FILE);
    console.log(`Map editor: saved ${Object.keys(edits.b).length} building edits`);
    return json(res, 200, { ok: true, count: Object.keys(edits.b).length });
  }
  if (url === '/api/editor/check' && req.method === 'POST') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1e4) return json(res, 413, { error: 'Too big' }); }
    let m; try { m = JSON.parse(body); } catch { return json(res, 400, { error: 'Not JSON' }); }
    return json(res, 200, await askWorld({ t: 'check', si: Number(m.si), e: m.e || {} }, { ok: true, unknown: true }));
  }
  if (url === '/api/editor/apply' && req.method === 'POST') {
    // Each world saves, stops and comes straight back up (the exit handler restarts it) built with the edits.
    for (const w of WORLDS) if (w.proc && w.proc.exitCode === null) w.proc.kill('SIGTERM');
    console.log('Map editor: worlds restarting to take the edits');
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'No such editor call' });
}

const handler = (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.startsWith('/gmap/')) { gmapApi(req, res, url).catch((e) => { console.error('Godot map:', e); json(res, 500, { error: 'Map error' }); }); return; }
  if (url.startsWith('/api/editor/')) { editorApi(req, res, url).catch((e) => { console.error('Map editor:', e); json(res, 500, { error: 'Editor error' }); }); return; }
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
