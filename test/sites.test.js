// High-value sites (shared/sites.js): the county's real prisons, sheriff's offices, hospital, clinics and
// stores, guarded and stocked; taking from one sets off the alarm, and most of what comes out is hot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { findSites, siteKind } from '../shared/sites.js';
import { REAL_SIZE } from '../shared/geography.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(50); } }
const read = (f) => JSON.parse(fs.readFileSync(path.join('data', 'real', f), 'utf8'));

test('sites: the real prisons, sheriff\'s offices and hospital are on the map, once each', () => {
  const sites = findSites(read('infrastructure.json'), read('businesses.json'), REAL_SIZE);
  const names = (kind) => sites.filter((s) => s.kind === kind).map((s) => s.name);
  assert.ok(names('prison').includes('Liberty Correctional Institution'));
  assert.ok(names('prison').includes('Calhoun Correctional Institution'));
  assert.equal(names('prison').length, 2, 'the work camp beside Calhoun CI is part of it');
  assert.ok(names('sheriff').some((n) => /Liberty County Sheriff/.test(n)) && names('sheriff').some((n) => /Calhoun County Sheriff/.test(n)));
  assert.deepEqual(names('hospital'), ['Calhoun Liberty Hospital']);
  assert.ok(!sites.some((s) => /Youth Academy/.test(s.name)), 'not the youth academy');
  assert.equal(new Set(sites.map((s) => s.id)).size, sites.length);
  assert.equal(siteKind('health_care', 'Jane Smith'), null, 'a person\'s name is not a clinic');
});

test('sites: taking from a sheriff\'s office sets off the alarm, and the loot is hot', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dzsite-')), 'w.json');
  const port = 34100 + Math.floor(Math.random() * 300);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: port, DATA_FILE: file, BOTS: '0', ALLOW_DEV: '1', DEV_KIT: '0', RIDES: '0', HOTZONE_FIRST_MS: '99999999', SUPPLY_EVERY_MS: '99999999', EVENT_FIRST_MS: '99999999' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => proc.kill('SIGKILL'));
  await new Promise((r) => proc.stdout.on('data', (d) => { if (String(d).includes('Deadzone server')) r(); }));
  const ws = new WebSocket(`ws://localhost:${port}`);
  let you = null, snap = null, sites = null, tp = 0; const toasts = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'you') you = m; if (m.t === 'snap') snap = m; if (m.t === 'sites') sites = m.sites; if (m.t === 'toast') toasts.push(m.text); if (m.t === 'correct' && m.force) tp = m.tp; });
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: 'join', name: 'Raider', token: 'site-raider' });
  await until(() => you && sites);
  const s = sites.find((q) => q.kind === 'sheriff');
  assert.equal(s.state, 'stocked');
  send({ t: 'deploy', kind: 'contact', id: 0 });
  await until(() => you && !you.dead && !you.deploying);
  let at = { x: s.x + 25, z: s.z + 25 };
  send({ t: 'dev', ...at });
  const hold = setInterval(() => send({ t: 'state', tp, x: at.x, z: at.z, yaw: 0, pitch: 0 }), 150);
  t.after(() => clearInterval(hold));
  const guards = await until(() => (snap?.bots || []).filter((b) => b.kind === 'guard' && Math.hypot(b.x - s.x, b.z - s.z) < 80).length >= 3);
  assert.ok(guards, 'guards turned up');
  const box = await until(() => (snap?.loot || []).find((l) => l.kind === 'lockbox' && l.hot && Math.hypot(l.x - s.x, l.z - s.z) < 90));
  at = { x: box.x, z: box.z };
  send({ t: 'dev', ...at });
  await sleep(600);
  send({ t: 'takeLoot', id: box.id });
  await until(() => toasts.some((x) => /alarm at/.test(x)));
  await until(() => sites.find((q) => q.id === s.id).state === 'alarm');
  assert.equal(sites.find((q) => q.id === s.id).left, s.left - 1);
  // Pry the locker open well away from the guards: what's inside goes into your supplies, still hot.
  const locker = await until(() => you.inv.pack.find((i) => i.kind === 'lockbox'));
  const before = { cash: you.cash || 0, intel: you.intel || 0, ammo: you.ammo || 0, parts: you.parts || 0 };
  at = { x: s.x + 600, z: s.z + 600 };
  send({ t: 'dev', ...at });
  await sleep(1500);
  send({ t: 'inv', action: 'breakbox', itemId: locker.id });
  await until(() => toasts.some((x) => /Pried open/.test(x)) || !you.inv.pack.some((i) => i.id === locker.id), 20000);
  await until(() => you.hotLoose && !you.inv.pack.some((i) => i.id === locker.id));
  const gained = Object.keys(before).reduce((n, k) => n + ((you[k] || 0) - before[k]), 0);
  assert.ok(gained > 0, 'the contents are in my supplies');
});
