// Climbing (shared/world.js): standing on tops, climbing onto ledges and over fences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveWithCollision, platformTop, climbAhead, climbVy, JUMP_G, PLAYER_RADIUS } from '../shared/world.js';

const flat = { height: () => 0 };
const box = (minX, minZ, maxX, maxZ, h, type = 'cover') => ({ minX, minZ, maxX, maxZ, h, y0: 0, ...(type ? { type } : {}) });
const crate = box(2, -1, 3.2, 1, 1.0, 'crate');          // a crate 1 m high just ahead (+x)
const fence = box(2, -3, 2.1, 3, 1.4, 'cover');          // a thin fence 1.4 m high
const wall = box(2, -3, 2.4, 3, 3.0, 'building');        // a 3 m wall: too high
const baseWall = box(2, -3, 2.4, 3, 1.4, null);          // something a player built (no type)

test('climbing: a crate top is something to stand on, a fence top is not', () => {
  assert.equal(platformTop([crate], 2.6, 0, 1.2), 1.0);
  assert.equal(platformTop([crate], 2.6, 0, 0.8), -Infinity, 'out of reach from the ground');
  assert.equal(platformTop([fence], 2.05, 0, 2), -Infinity);
});
test('climbing: what you can climb ahead of you, and what you can\'t', () => {
  assert.equal(climbAhead([crate], 1.5, 0, 1, 0, 0), 1.0);
  assert.equal(climbAhead([fence], 1.5, 0, 1, 0, 0), 1.4);
  assert.equal(climbAhead([wall], 1.5, 0, 1, 0, 0), 0, 'too high');
  assert.equal(climbAhead([baseWall], 1.5, 0, 1, 0, 0), 0, 'players\' walls stay in the way');
  assert.equal(climbAhead([crate], 1.5, 0, -1, 0, 0), 0, 'nothing that way');
});
test('climbing: walk into a crate and you stop; jump high enough and you land on top; walk off and you come down', () => {
  const blocked = moveWithCollision(1.3, 0, 1.0, 0, PLAYER_RADIUS, [crate], flat, 0, 0);
  assert.ok(blocked.x < 2 - PLAYER_RADIUS + 0.01 && blocked.y === 0);
  const apex = climbVy(1.0, JUMP_G) ** 2 / (2 * JUMP_G);
  const up = moveWithCollision(1.3, 0, 1.0, 0, PLAYER_RADIUS, [crate], flat, 0, apex);
  assert.ok(up.x > 2.2 && Math.abs(up.y - 1.0) < 1e-9, `on top of the crate (at ${up.x.toFixed(2)}, ${up.y})`);
  const stay = moveWithCollision(2.4, 0, 0.3, 0, PLAYER_RADIUS, [crate], flat, 1.0, 0);
  assert.equal(stay.y, 1.0, 'walking about on top');
  const off = moveWithCollision(2.8, 0, 1.0, 0, PLAYER_RADIUS, [crate], flat, 1.0, 0);
  assert.equal(off.y, 0, 'off the end, down to the ground');
});
test('climbing: over a fence to the far side', () => {
  const apex = climbVy(1.4, JUMP_G) ** 2 / (2 * JUMP_G);
  const over = moveWithCollision(1.5, 0, 1.4, 0, PLAYER_RADIUS, [fence], flat, 0, apex);
  assert.ok(over.x > 2.1 + PLAYER_RADIUS, `cleared it (at ${over.x.toFixed(2)})`);
  assert.equal(over.y, 0, 'nothing to stand on up there: you come down the far side');
});
