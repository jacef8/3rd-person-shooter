import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, mapChecksum, moveWithCollision, rayBox, rayAgainstBoxes, circleOverlapsBox, PLAYER_RADIUS } from '../shared/world.js';
import { makeWeapon, weaponStats, levelFromXp, xpForLevel, unlocksAt, PARTS, ARCHETYPES, MAX_LEVEL, partFits, UPGRADES, CONTRACT_TYPES, isUnlocked } from '../shared/items.js';

test('open world: 8 km, deterministic, towns, stash houses, contacts, landing zones', () => {
  const a = generateMap(42), b = generateMap(42);
  assert.equal(mapChecksum(a), mapChecksum(b));
  assert.equal(a.size, 8000);
  assert.ok(a.towns.length >= 25, `towns ${a.towns.length}`);
  assert.ok(a.houses.length >= 60, `houses ${a.houses.length}`);
  assert.equal(a.contacts.length, a.towns.length, 'every town has a Contact');
  assert.ok(a.landingZones.length >= 9);
  assert.ok(a.campSites.length >= 30);
  for (const p of a.landingZones) assert.ok(!a.grid.near(p.x, p.z, 2).some((bx) => circleOverlapsBox(p.x, p.z, PLAYER_RADIUS, bx)));
  // Towns spread across the whole map, not bunched in the middle.
  const xs = a.towns.map((t) => t.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 5000);
  assert.notEqual(mapChecksum(generateMap(43)), mapChecksum(a), 'different seeds give different worlds');
});

test('spatial grid ray query finds the same first hit as brute force', () => {
  const m = generateMap(7);
  let rand = 1;
  const r = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) {
    const t = m.towns[i % m.towns.length];
    const ox = t.x + (r() - 0.5) * 300, oz = t.z + (r() - 0.5) * 300, oy = 1.5;
    const a = r() * 6.283;
    const dx = Math.cos(a), dz = Math.sin(a), dy = (r() - 0.5) * 0.1;
    const l = Math.hypot(dx, dy, dz);
    const fast = rayAgainstBoxes(ox, oy, oz, dx / l, dy / l, dz / l, m.grid.ray(ox, oz, dx / l, dz / l, 200), 200);
    const slow = rayAgainstBoxes(ox, oy, oz, dx / l, dy / l, dz / l, m.boxes, 200);
    assert.equal(fast.t, slow.t);
  }
});

test('stash upgrades and contracts are well formed', () => {
  for (const [k, u] of Object.entries(UPGRADES)) {
    u.tiers.slice(1).forEach((t, i) => {
      assert.ok(t.level >= 1 && t.cost, `${k} tier ${i + 1}`);
      if (i) assert.ok(t.level >= u.tiers[i].level, `${k} tiers increase in level`);
    });
  }
  for (const c of Object.values(CONTRACT_TYPES)) assert.ok(c.reward.comms > 0 && c.xp > 0);
});

test('field gear needs commendations as well as level', () => {
  const lvl10 = { xp: xpForLevel(10) };
  assert.equal(isUnlocked(PARTS.intSup, 'intSup', lvl10), false);
  assert.equal(isUnlocked(PARTS.intSup, 'intSup', { ...lvl10, field: ['intSup'] }), true);
  assert.equal(isUnlocked(PARTS.intSup, 'intSup', { xp: 0, field: ['intSup'] }), false);
});

test('movement cannot tunnel through a thin wall', () => {
  const wall = { minX: 0, minZ: -5, maxX: 0.4, maxZ: 5, h: 3 };
  const p = moveWithCollision(-1, 0, 5, 0, PLAYER_RADIUS, [wall]);
  assert.ok(p.x <= -PLAYER_RADIUS + 1e-6, `ended at ${p.x}`);
});

test('stash house door blocks entry; walls are closed except the door gap', () => {
  const map = generateMap(1337);
  const h = map.houses[0];
  const door = { ...h.door };
  const outside = { x: h.x, z: h.door.maxZ + 1 };
  const near = map.grid.near(h.x, h.z, 12);
  // Walking straight in through the door gap, blocked when door is present.
  const blocked = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, [...near, door]);
  assert.ok(blocked.z > door.maxZ, 'door should stop the player');
  // With the door breached the player walks in (gap is 1.8m, player is 0.9m wide).
  const open = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, near);
  assert.ok(open.z < door.minZ, 'should pass through the empty doorway');
});

test('ray vs box', () => {
  assert.equal(rayBox(-5, 1, 0, 1, 0, 0, 0, 0, -1, 1, 2, 1), 5);
  assert.equal(rayBox(-5, 3, 0, 1, 0, 0, 0, 0, -1, 1, 2, 1), Infinity);
});

test('level curve is monotonic and round-trips', () => {
  for (let l = 1; l < MAX_LEVEL; l++) {
    assert.ok(xpForLevel(l + 1) > xpForLevel(l));
    assert.equal(levelFromXp(xpForLevel(l)), l);
    assert.equal(levelFromXp(xpForLevel(l + 1) - 1), l);
  }
  assert.equal(levelFromXp(1e9), MAX_LEVEL);
});

test('every unlock is reachable and announced exactly once', () => {
  const seen = new Set();
  for (let l = 2; l <= MAX_LEVEL; l++) for (const u of unlocksAt(l)) { assert.ok(!seen.has(u.type + u.id)); seen.add(u.type + u.id); }
  for (const [id, p] of Object.entries(PARTS)) if (p.level > 1 && !p.field) assert.ok(seen.has('part' + id), id);
  for (const [id, a] of Object.entries(ARCHETYPES)) if (a.level > 1) assert.ok(seen.has('weapon' + id), id);
});

test('gunsmith parts are trade-offs that change stats', () => {
  const base = weaponStats(makeWeapon('carbine'));
  const ext = weaponStats(makeWeapon('carbine', { magazine: 'extMag' }));
  assert.ok(ext.mag > base.mag && ext.reloadMs > base.reloadMs);
  const sup = weaponStats(makeWeapon('carbine', { muzzle: 'suppressor' }));
  assert.ok(sup.suppressed && sup.damage < base.damage);
  const acog = weaponStats(makeWeapon('carbine', { optic: 'acog' }));
  assert.ok(acog.zoom > base.zoom && acog.handling < base.handling);
  const heavy = weaponStats(makeWeapon('carbine', { stock: 'heavyStock' }));
  assert.ok(heavy.recoil < base.recoil && heavy.handling < base.handling);
});

test('incompatible parts are ignored', () => {
  assert.equal(partFits('sniper', 'smg'), false);
  const s = weaponStats(makeWeapon('smg', { optic: 'sniper' }));
  assert.equal(s.zoom, weaponStats(makeWeapon('smg')).zoom);
});

test('every part modifier maps onto a real stat', () => {
  const base = weaponStats(makeWeapon('carbine'));
  for (const p of Object.values(PARTS)) {
    for (const k of Object.keys(p.mods)) {
      const key = k.endsWith('Mul') ? k.slice(0, -3) : k;
      assert.ok(key in base, `${p.name}: ${k}`);
    }
  }
});
