// Hideouts: small extra stashes out in the field. You need a stash house first; the first unlocks at
// level 8, the second at 16. You can stash goods in one, come back to it after a death (unless you
// died within a mile of it in the last 5 minutes) and fast travel to it from home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateMap } from '../shared/world.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import { placementProblem, BUILD } from '../shared/building.js';
import ACT from '../shared/data/activities.json' with { type: 'json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const map = generateMap(1337);
const world = { terrain: map.terrain, towns: map.towns, contacts: map.contacts, landingZones: map.landingZones, solidsNear: (x, z, r) => map.grid.near(x, z, r) };

// Open ground for a hideout, out in the wild, well over a mile from the stash house.
const home = map.houses.find((h) => h.kind === 'house');
let spot = null;
for (let r = 2600; r < 9000 && !spot; r += 150) for (let k = 0; k < 24 && !spot; k++) {
  const x = home.x + Math.cos(k / 24 * Math.PI * 2) * r, z = home.z + Math.sin(k / 24 * Math.PI * 2) * r;
  if (Math.abs(x) > map.half - 300 || Math.abs(z) > map.half - 300 || map.terrain.height(x, z) < 1.5) continue;
  const stand = { x, z: z + 2.6 };
  if (placementProblem(world, 'hideout', x, z, 0, stand)) continue;
  if (map.grid.near(x, z + 2.6, 2).length || map.grid.near(x, z, 5).length) continue;
  spot = { x, z };
}

test('hideouts: unlocked by level, a stash in the field, a respawn point and a fast-travel stop', async (t) => {
  assert.ok(spot, 'found open ground');
  const A = 'a9'.repeat(16), B = 'b9'.repeat(16);
  const tool = (k) => ({ id: `t${k}`, kind: 'tool', tool: k, name: k });
  const person = (name, x, z, extra) => ({ name, x, z, yaw: 0, hp: 100, armor: 0, inv: { primary: makeWeapon('carbine'), primary2: null, secondary: null, armor: null, pack: [tool('hammer')] }, ammo: 90, mags: {}, active: 'primary', dead: false, kills: 0, xp: xpForLevel(9), cash: 50, comms: 0, food: 90, field: [], discovered: [], contracts: [], wood: 200, parts: 200, stone: 0, salvage: 40, ...extra });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzhide-')), 'w.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 13, size: 30000, bags: [], structures: [],
    houses: { [home.id]: { owner: A, ownerName: 'Camper', items: [], doorHp: 1500, upg: {} } },
    characters: { [A]: person('Camper', spot.x, spot.z + 2.6), [B]: person('Drifter', spot.x + 30, spot.z + 2.6) } }));
  const port = 30100 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '0', DEV_KIT: '0', RESPAWN_WAIT_S: '0', RESPAWN_KEEPAWAY_M: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const join = async (name, token) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { msgs: [] };
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'correct' && m.force) c.at = m; if (m.t === 'container') c.container = m; });
    await new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.toast = (re) => until(() => c.msgs.find((m) => m.t === 'toast' && re.test(m.text)));
    c.send({ t: 'join', name, token });
    await until(() => c.you && !c.you.dead);
    return c;
  };
  const a = await join('Camper', A), b = await join('Drifter', B);

  // No stash house, no hideout.
  b.send({ t: 'build', piece: 'hideout', x: spot.x + 30, z: spot.z - 1, rot: 0 });
  await b.toast(/stash house first/);

  // Level 9: one hideout, and the second waits for level 16.
  assert.equal(a.you.hideoutsAllowed, 1);
  assert.equal(a.you.hideoutNext, BUILD.hideoutLevels[1]);
  a.send({ t: 'build', piece: 'hideout', x: spot.x, z: spot.z, rot: 0 });
  await a.toast(/Hideout built/);
  const hid = (await until(() => a.you.hideouts?.length === 1 && a.you.hideouts))[0];
  a.send({ t: 'build', piece: 'hideout', x: spot.x + 6, z: spot.z + 6, rot: 0 });
  await a.toast(/next hideout unlocks at level 16/);

  // Stash salvage in it.
  a.send({ t: 'interact' });
  await until(() => a.container?.canPut);
  a.send({ t: 'container', action: 'put', res: 'salvage' });
  await until(() => a.container.salvage === 40);

  // Die well away from it: the hideout is a way back in.
  a.send({ t: 'dev', x: spot.x + 2500, z: spot.z });
  await sleep(300);
  a.send({ t: 'dev', kill: true });
  const died = await until(() => a.msgs.find((m) => m.t === 'died'));
  assert.equal(died.deploy.hideouts[0].id, hid.id);
  a.send({ t: 'deploy', kind: 'hideout', id: hid.id });
  await until(() => !a.you.dead);
  await sleep(200);
  assert.ok(Math.hypot(a.at.x - spot.x, a.at.z - spot.z) < 8, 'back at the hideout');

  // Home, then fast travel back out to it.
  a.send({ t: 'dev', x: home.crate.x, z: home.crate.z + 1.2 });
  await sleep(1200);
  a.send({ t: 'travel', kind: 'hideout', id: hid.id });
  await until(() => Math.hypot(a.at.x - spot.x, a.at.z - spot.z) < 8);

  // Die at the hideout: it's closed to you for a while (your stash house isn't).
  a.msgs.length = 0;
  a.send({ t: 'dev', kill: true });
  await until(() => a.msgs.find((m) => m.t === 'died'));
  a.send({ t: 'deploy', kind: 'hideout', id: hid.id });
  await a.toast(/Too close to where you died/);
  a.send({ t: 'deploy', kind: 'home' });
  await until(() => !a.you.dead);
  void ACT;
});
