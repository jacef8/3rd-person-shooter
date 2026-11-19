// Stashing: what you pick up out in the world isn't safe until you get it home. Walk into your stash
// house and it's stashed (a few seconds); from then on it stays with you through a death. What you
// picked up since goes in the bag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { generateMap } from '../shared/world.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}

test('stashing: loot is lost on death until you get it home; stashed gear survives', async (t) => {
  const map = generateMap(1337);
  const home = map.houses.find((h) => h.kind === 'house');
  const A = 'e5'.repeat(16);
  const gun = makeWeapon('carbine');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzstash-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, bags: [], structures: [],
    houses: { [home.id]: { owner: A, ownerName: 'Hauler', items: [], doorHp: 1500, upg: {} } },
    characters: { [A]: { name: 'Hauler', x: home.x + 300, z: home.z + 300, yaw: 0, hp: 100, armor: 0, inv: { primary: gun, primary2: null, secondary: null, armor: null, pack: [] }, ammo: 90, mags: { [gun.id]: 30 }, active: 'primary', dead: false, kills: 0, xp: xpForLevel(8), cash: 50, comms: 0, food: 90, field: [], discovered: [], contracts: [] } } }));
  const port = 30600 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', RIDES: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', RESPAWN_WAIT_S: '0', RESPAWN_KEEPAWAY_M: '', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Hauler', token: A });
  await until(() => c.you && !c.you.dead);

  // What you had before stashing existed counts as stashed.
  assert.deepEqual(c.you.unstashed, { ids: [], res: {} });
  // Out in the field: a new gun and $40. Usable, but not safe.
  send({ t: 'dev', giveGun: 'shotgun' });
  send({ t: 'dev', give: { cash: 40 } });
  await until(() => c.you.unstashed.ids.length === 1 && c.you.unstashed.res.cash === 40);
  const shotgun = c.you.inv.pack.find((i) => i.archetype === 'shotgun');

  // Home: it stashes itself after a few seconds.
  send({ t: 'dev', x: home.x, z: home.door.minZ - 1.2 });   // just inside the front door
  await until(() => c.msgs.some((m) => m.t === 'hack' && m.kind === 'stash'));
  await until(() => c.msgs.some((m) => m.t === 'hack' && m.done && /Stashed/.test(m.text || '')), 8000);
  await until(() => c.you.unstashed.ids.length === 0 && !Object.keys(c.you.unstashed.res).length);

  // Back out, pick up more, and die before getting it home.
  send({ t: 'dev', x: home.x + 300, z: home.z + 300 });
  await sleep(300);
  send({ t: 'dev', giveGun: 'dmr' });
  send({ t: 'dev', give: { cash: 25 } });
  await until(() => c.you.unstashed.ids.length === 1 && c.you.unstashed.res.cash === 25);
  const dmr = c.you.inv.pack.find((i) => i.archetype === 'dmr');
  send({ t: 'dev', kill: true });
  await until(() => c.you.dead);
  assert.equal(c.you.cash, 90, 'kept the $90 that was stashed, lost the $25 that wasn\'t');
  const all = (you) => [you.inv.primary, you.inv.primary2, you.inv.secondary, you.inv.armor, ...you.inv.pack].filter(Boolean).map((i) => i.id);
  assert.ok(all(c.you).includes(gun.id) && all(c.you).includes(shotgun.id), 'stashed guns kept');
  assert.ok(!all(c.you).includes(dmr.id), 'the unstashed rifle went in the bag');
  send({ t: 'respawn' });
  await until(() => !c.you.dead);
  assert.ok(all(c.you).includes(gun.id) && all(c.you).includes(shotgun.id), 'and they come back with you');
  assert.equal(c.you.cash, 90);
  ws.close();
});
