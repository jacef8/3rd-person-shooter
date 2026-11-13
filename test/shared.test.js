import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, moveWithCollision, rayBox, circleOverlapsBox, PLAYER_RADIUS } from '../shared/world.js';
import { rollLoot, makeWeapon, weaponStats, itemScore, RARITIES } from '../shared/items.js';

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

test('higher rarity weapons are stronger', () => {
  const lo = makeWeapon('carbine', 'scrap'); lo.roll = 1;
  const hi = makeWeapon('carbine', 'relic'); hi.roll = 1; hi.attrs = {};
  assert.ok(weaponStats(hi).damage > weaponStats(lo).damage);
  assert.ok(itemScore(hi) > itemScore(lo));
});

test('loot rolls produce every rarity over many drops', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(rollLoot(Math.random, 0.5).rarity);
  for (const r of RARITIES) assert.ok(seen.has(r.key), r.key);
});
