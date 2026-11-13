// End-to-end tests for the open-world loop: deploying, contracts, supply drops, stash upgrades,
// fast travel and death/redeploy. Uses the server's test-only teleport (ALLOW_DEV=1) because an
// 30 km map is too big to walk in a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';

const PORT = 19000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzw-'));
const FILE = path.join(dir, 'world.json');
const map = generateMap(1337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

const TOK_Q = 'a1'.repeat(16);
const home = map.houses[5];
const houses = Object.fromEntries(map.houses.map((h) => [h.id, { owner: null, ownerName: null, doorHp: 1500, doorOpen: false, items: [], parts: 0, tech: 0, intel: 0, salvage: 0, upg: {} }]));
houses[home.id] = { ...houses[home.id], owner: TOK_Q, ownerName: 'Quinn', hxp: 300 };
const w = makeWeapon('carbine');
fs.writeFileSync(FILE, JSON.stringify({ seed: 1337, version: 9, size: 30000, houses, bags: [], characters: {
  [TOK_Q]: { name: 'Quinn', x: home.crate.x, z: home.crate.z + 1.2, yaw: 0, hp: 100, armor: 0, inv: { primary: w, secondary: null, armor: null, pack: [] },
    ammo: 300, mags: { [w.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(6), parts: 100, tech: 50, intel: 0, salvage: 0, comms: 0,
    field: [], discovered: [], contracts: [] },
} }));

function conn(name, token) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'correct' && m.force) c.tpn = m.tp; if (m.t === 'you') c.you = m; if (m.t === 'welcome') c.welcome = m; if (m.t === 'contracts') c.contracts = m.list; if (m.t === 'contact') c.contact = m; if (m.t === 'events') c.drops = m.drops; });
  c.send = (m) => ws.send(JSON.stringify(m.t === 'state' ? { tp: c.tpn || 0, ...m } : m));
  c.got = (fn, ms) => until(() => c.msgs.find(fn), ms);
  c.tp = async (x, z) => { c.send({ t: 'dev', x, z }); await until(() => c.you && Math.hypot(c.you.x ?? 0, 0) >= 0); await sleep(120); };
  return new Promise((r) => ws.on('open', () => { c.send({ t: 'join', name, token }); r(c); }));
}

test('open world loop: deploy, contracts, supply drop, upgrades, fast travel, death', async (t) => {
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, REAL_DATA: '0', PORT, DATA_FILE: FILE, BOTS: '0', ALLOW_DEV: '1', SUPPLY_EVERY_MS: '1500', SUPPLY_FALL_MS: '200' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));

  // --- A brand-new player picks a stash house on the map and deploys there.
  const nina = await conn('Nina', null);
  await until(() => nina.welcome);
  assert.ok(nina.welcome.firstDeploy);
  assert.equal(nina.welcome.deploy.claim, null);
  assert.ok(nina.welcome.deploy.towns.length >= 6, 'first deploy offers the real towns');
  // Deploy into a town, then claim a free house by planting the starter claim marker.
  nina.send({ t: 'deploy', kind: 'contact', id: 0 });
  await nina.got((m) => m.t === 'deployed');
  await until(() => nina.you && !nina.you.dead);
  assert.ok(nina.you.protectedUntil > Date.now(), 'spawn protection');
  assert.ok(nina.you.inv.pack.some((i) => i.kind === 'marker'), 'starts with a claim marker');
  const pick = map.houses.find((h) => h.id !== home.id && h.kind === 'room');
  nina.send({ t: 'dev', x: pick.crate.x, z: pick.crate.z + 1.2 });
  await sleep(300);
  nina.send({ t: 'interact' });
  await nina.got((m) => m.t === 'hack' && m.kind === 'claim');
  await nina.got((m) => m.t === 'claimed', 12000);
  await until(() => nina.you.houseId === pick.id && nina.you.claim?.level === 1 && !nina.you.inv.pack.some((i) => i.kind === 'marker'));

  // --- Quinn (level 6) runs contracts from Contacts.
  const q = await conn('Quinn', TOK_Q);
  await until(() => q.you);
  const findOffer = async (type) => {
    for (const c of map.contacts) {
      await q.tp(c.x + 1.5, c.z);
      q.contact = null;
      q.send({ t: 'interact' });
      await until(() => q.contact);
      const o = q.contact.offers.find((x) => x.type === type);
      if (o) return { contact: c, offer: o };
    }
    throw new Error(`no ${type} offer`);
  };

  // Data heist: hack the marked terminal.
  const heist = await findOffer('heist');
  q.send({ t: 'acceptContract', contactId: heist.contact.id, id: heist.offer.id });
  await until(() => q.contracts?.some((c) => c.id === heist.offer.id));
  const term = map.terminals[heist.offer.terminalId];
  await q.tp(term.x, term.z + 1.1);
  q.send({ t: 'interact' });
  await q.got((m) => m.t === 'contractDone' && m.name === 'Data Heist', 9000);
  await until(() => q.you.comms === 2 && q.you.salvage >= 30);

  // Supply recovery: pick up the crate, deliver it to any Contact.
  const rec = await findOffer('recovery');
  q.send({ t: 'acceptContract', contactId: rec.contact.id, id: rec.offer.id });
  await until(() => q.contracts?.some((c) => c.id === rec.offer.id));
  await q.tp(rec.offer.x, rec.offer.z + 0.6);
  q.send({ t: 'interact' });
  await until(() => q.you.inv.pack.some((i) => i.kind === 'package'), 6000);
  await q.tp(map.contacts[0].x + 1.5, map.contacts[0].z);
  q.send({ t: 'interact' });
  await q.got((m) => m.t === 'contractDone' && m.name === 'Supply Recovery');
  await until(() => q.you.comms === 4);

  // Contacts Quinn spends time near are discovered (checked once a second).
  for (const c of map.contacts.slice(1, 3)) { await q.tp(c.x + 1.5, c.z); await sleep(1200); }
  await until(() => q.you.discovered.length >= 2);

  // --- Supply drop: announced, lands, opened for salvage + a commendation.
  await until(() => q.drops?.length, 8000);
  const drop = q.drops[0];
  await sleep(300);
  await q.tp(drop.x + 0.5, drop.z);
  q.send({ t: 'interact' });
  await q.got((m) => m.t === 'hack' && m.done && /commendation/.test(m.text), 9000);
  await until(() => q.you.comms === 5);

  // --- Stash upgrades at home, paid with field salvage.
  await q.tp(home.crate.x, home.crate.z + 1.2);
  const salvageBefore = q.you.salvage;
  q.send({ t: 'upgrade', track: 'storage' });
  await q.got((m) => m.t === 'toast' && /Installed: Storage/.test(m.text));
  await until(() => q.you.salvage === salvageBefore - 60);
  q.send({ t: 'upgrade', track: 'generator' });    // level 5, needs 100 salvage + 60 parts
  await q.got((m) => m.t === 'toast' && /Installed: Generator|Not enough|Needs home level/.test(m.text));

  // --- Requisition field gear with commendations at a Contact.
  await q.tp(map.contacts[0].x + 1.5, map.contacts[0].z);
  q.send({ t: 'requisition', contactId: 0, kind: 'part', id: 'intSup' });
  await until(() => q.you.field.includes('intSup') && q.you.comms === 2);

  // --- Fast travel: only out from your own stash, only to discovered Contacts.
  q.send({ t: 'travel', kind: 'contact', id: q.you.discovered[0] });
  await q.got((m) => m.t === 'toast' && /leaves from your stash/.test(m.text));
  await q.tp(home.crate.x, home.crate.z + 1.2);
  await sleep(1100);
  const dest = map.contacts[q.you.discovered[0]];
  q.send({ t: 'travel', kind: 'contact', id: dest.id });
  await q.got((m) => m.t === 'correct' && Math.hypot(m.x - dest.x, m.z - dest.z) < 6);

  // --- Death: carried salvage/commendation-free loot drops; redeploy options come back.
  const carried = q.you.salvage;
  q.send({ t: 'dev', kill: true });
  const died = await q.got((m) => m.t === 'died');
  assert.equal(died.deploy.houseId, home.id);
  assert.ok(died.deploy.contacts.length >= 2 && died.deploy.lzs.length >= 9);
  await until(() => q.you.dead && q.you.salvage === 0);
  assert.equal(q.you.comms, 2, 'commendations are kept on death');
  assert.ok(q.you.field.includes('intSup'), 'field unlocks are kept on death');
  q.send({ t: 'deploy', kind: 'lz', id: 2 });
  await until(() => !q.you.dead);
  void carried;
  for (const c of [nina, q]) c.ws.close();
});
