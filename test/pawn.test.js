// Lamar's Pawn (10508 FL-20, Bristol): a real building on the real map where you buy and sell guns,
// armor and goods. What one player sells goes in the case for the next. No fighting, no claiming.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { generateMap, insideBuilding } from '../shared/world.js';
import { parseElevation, parseLandcover } from '../shared/terrain.js';
import { project } from '../shared/geography.js';
import { makeWeapon, xpForLevel } from '../shared/items.js';
import PAWN from '../shared/data/pawn.json' with { type: 'json' };

const REAL = new URL('../data/real/', import.meta.url);
const rows = (n) => JSON.parse(fs.readFileSync(new URL(n, REAL), 'utf8')).rows;
const map = generateMap(1337, 30000, {
  structures: rows('structures.json'), roads: rows('roads.json'),
  elevation: parseElevation(zlib.gunzipSync(fs.readFileSync(new URL('elevation.bin.gz', REAL)))),
  landcover: parseLandcover(zlib.gunzipSync(fs.readFileSync(new URL('landcover.bin.gz', REAL)))),
  infrastructure: JSON.parse(fs.readFileSync(new URL('infrastructure.json', REAL), 'utf8')),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error('timed out');
}
const hex = (s) => s.repeat(32 / s.length);

test("Lamar's Pawn stands in the real building at 10508 FL-20", () => {
  const sh = map.shops.find((s) => s.kind === 'pawn');
  assert.ok(sh, 'the shop is on the map');
  const b = map.buildings[sh.building], spot = project(30.4320301, -84.9852762, 30000);
  assert.equal(b.name, "Lamar's Pawn");
  assert.ok(Math.hypot(b.cx - spot.x, b.cz - spot.z) < 15, 'the building on the real spot');
  assert.ok(insideBuilding(b, sh.keeper.x, sh.keeper.z, 0.3), 'Lamar stands inside');
  assert.ok(map.labels.some((l) => l.kind === 'place' && l.text === "Lamar's Pawn"), 'named on the map');
});

test("buy from Lamar's case, sell him a gun, and it's in the case for the next customer", async (t) => {
  const sh = map.shops.find((s) => s.kind === 'pawn');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzpawn-')), 'w.json');
  const shotgun = makeWeapon('shotgun', { barrel: 'longBarrel' });
  const A = hex('f1');
  fs.writeFileSync(file, JSON.stringify({ seed: 1337, version: 12, size: 30000, houses: {}, bags: [], structures: [], characters: {
    [A]: { name: 'Customer', x: sh.keeper.x + sh.door.out[0] * 1.6, z: sh.keeper.z + sh.door.out[1] * 1.6, yaw: 0, hp: 100, armor: 0, inv: { primary: null, primary2: null, secondary: makeWeapon('sidearm'), armor: null, pack: [shotgun] },
      ammo: 90, mags: {}, active: 'secondary', dead: false, kills: 0, xp: xpForLevel(3), parts: 0, tech: 0, intel: 0, salvage: 0, wood: 0, stone: 0, comms: 0, cash: 500, food: 90, corn: 10, field: [], discovered: [], contracts: [] },
  } }));
  const port = 28100 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', REAL_DATA: '1', EVENT_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { msgs: [] };
  ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'you') c.you = m; if (m.t === 'contact') c.contact = m; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Customer', token: A });
  await until(() => c.you);
  // E at the counter opens Lamar's: his case is stocked.
  let view;
  for (let i = 0; i < 40 && !view; i++) { send({ t: 'interact' }); await sleep(150); view = c.contact?.trade?.pawn && c.contact; }
  assert.ok(view, "Lamar's opens");
  assert.ok(view.trade.case.length >= PAWN.minStock, 'the case has guns and armor in it');
  // Sell him the shotgun with a long barrel: half its value, plus a share for the attachment.
  const offer = view.trade.offers.find((o) => o.id === shotgun.id);
  const value = Math.round(PAWN.gunValue.shotgun * (1 + PAWN.attachmentBonus));
  assert.equal(offer.pays, Math.round(value * PAWN.pays));
  c.contact = null;
  send({ t: 'trade', npcId: view.npc, action: 'sellItem', itemId: shotgun.id });
  const after = await until(() => c.contact?.trade?.pawn && c.contact);
  await until(() => c.you.cash === 500 + offer.pays && !c.you.inv.pack.some((i) => i.id === shotgun.id));
  const inCase = after.trade.case.find((i) => i.id === shotgun.id);
  assert.ok(inCase, 'the shotgun is in the case now');
  assert.equal(inCase.price, Math.round(value * PAWN.sells));
  // Buy something else from the case.
  const pick = after.trade.case.find((i) => i.kind === 'weapon' && i.id !== shotgun.id && i.price <= c.you.cash);
  const cash = c.you.cash;
  send({ t: 'trade', npcId: view.npc, action: 'buyItem', itemId: pick.id });
  await until(() => c.you.cash === cash - pick.price && c.you.inv.pack.some((i) => i.id === pick.id));
  // Goods too.
  send({ t: 'trade', npcId: view.npc, action: 'sell', good: 'corn', qty: 'all' });
  await until(() => c.you.corn === 0);
  // The shop isn't for claiming.
  send({ t: 'dev', x: sh.x, z: sh.z });
  await sleep(300);
  for (let i = 0; i < 20 && !c.msgs.some((m) => m.t === 'toast' && /not for claiming/.test(m.text)); i++) { send({ t: 'interact' }); await sleep(150); }
  assert.ok(c.msgs.some((m) => m.t === 'toast' && /not for claiming/.test(m.text)), "Lamar's can't be claimed");
  ws.close();
});
