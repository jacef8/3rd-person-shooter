// Map editor fixes (shared/edits.js): applied to the building rows the same way by server and clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withEdits, cleanEdits } from '../shared/edits.js';

const rows = [[30.1, -85.1, 10, 12, 4, 'comm', 'Shop', 15, [[-5, -6, 5, 0], [-2, 0, 2, 6]]], [30.2, -85.2, 8, 9, 0, 'resid', '', 0]];
test('edits: move, turn and resize a building; take one out; nothing renumbers', () => {
  const out = withEdits({ structures: rows }, { v: 1, b: { 0: { lat: 30.11, lon: -85.11, ang: 30 }, 1: { gone: 1 } } });
  assert.equal(out.structures.length, 2);
  assert.deepEqual(out.structures[0].slice(0, 8), [30.11, -85.11, 10, 12, 4, 'comm', 'Shop', 30]);
  assert.ok(out.structures[0][8], 'an L-shaped outline moves and turns with it');
  assert.equal(out.structures[1], null);
  assert.deepEqual(rows[0][0], 30.1, 'the data itself is untouched');
  const resized = withEdits({ structures: rows }, { b: { 0: { w: 20 } } });
  assert.equal(resized.structures[0][2], 20);
  assert.equal(resized.structures[0].length, 8, 'a resized outline becomes a plain rectangle');
});
test('edits: only numbers for real buildings get through', () => {
  const c = cleanEdits({ b: { 0: { lat: 30.1234567, lon: -85.1, ang: 12.345, evil: 'x' }, 5: { lat: 1 }, x: { gone: 1 }, 1: { gone: 'yes' } } }, 2);
  assert.deepEqual(c, { v: 1, b: { 0: { lat: 30.123457, lon: -85.1, ang: 12.3 }, 1: { gone: 1 } } });
  assert.equal(cleanEdits('nope', 2), null);
});
