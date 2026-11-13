import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, moveWithCollision, rayBox, circleOverlapsBox, PLAYER_RADIUS } from '../shared/world.js';
import { makeWeapon, weaponStats, levelFromXp, xpForLevel, unlocksAt, PARTS, ARCHETYPES, MAX_LEVEL, partFits } from '../shared/items.js';

test('map generation is deterministic and has stash houses', () => {
  const a = generateMap(42), b = generateMap(42);
  assert.deepEqual(a.boxes, b.boxes);
  assert.equal(a.houses.length, 12);
  assert.ok(a.lootSpawns.length > 40);
  assert.ok(a.playerSpawns.length > 4);
  for (const p of a.playerSpawns) assert.ok(!a.boxes.some((bx) => circleOverlapsBox(p.x, p.z, PLAYER_RADIUS, bx)));
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
  // Walking straight in through the door gap, blocked when door is present.
  const blocked = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, [...map.boxes, door]);
  assert.ok(blocked.z > door.maxZ, 'door should stop the player');
  // With the door breached the player walks in (gap is 1.8m, player is 0.9m wide).
  const open = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, map.boxes);
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
  for (const [id, p] of Object.entries(PARTS)) if (p.level > 1) assert.ok(seen.has('part' + id), id);
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
