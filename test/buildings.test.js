// Real buildings stand at their real angle and in their real shape (L, T and wings): you can't walk
// or shoot through a turned wall, you can walk in through its doorway, and "inside" means inside.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { generateMap, moveWithCollision, rayAgainstBoxes, insideBuilding, PLAYER_RADIUS } from '../shared/world.js';
import { parseElevation, parseLandcover } from '../shared/terrain.js';

const rj = (n) => JSON.parse(fs.readFileSync(new URL(`../data/real/${n}`, import.meta.url), 'utf8'));
const map = generateMap(1337, 30000, {
  structures: rj('structures.json').rows, roads: rj('roads.json').rows,
  elevation: parseElevation(zlib.gunzipSync(fs.readFileSync(new URL('../data/real/elevation.bin.gz', import.meta.url)))),
  landcover: parseLandcover(zlib.gunzipSync(fs.readFileSync(new URL('../data/real/landcover.bin.gz', import.meta.url)))),
});

test('real buildings keep their angle and shape', () => {
  const turned = map.buildings.filter((b) => b.real && Math.abs(b.ang) > 0.1);
  const shaped = map.buildings.filter((b) => b.real && b.rects?.length > 1);
  assert.ok(turned.length > 1000, `${turned.length} buildings stand at an angle`);
  assert.ok(shaped.length > 500, `${shaped.length} buildings have L, T or more complex shapes`);
  assert.ok(map.boxes.some((b) => b.ang !== undefined), 'their walls are turned boxes');
});

test("a turned building's walls stop you and bullets; its doorway lets you in", () => {
  const sample = map.buildings.filter((b) => b.real && Math.abs(Math.sin(2 * b.ang)) > 0.5 && b.doors.length && b.rects.length === 1).slice(0, 25);
  assert.ok(sample.length >= 10);
  let walkedIn = 0;
  for (const b of sample) {
    const solids = map.grid.near(b.cx, b.cz, 60);
    const gy = (x, z) => map.terrain.height(x, z);
    // From outside, straight at the middle of a wall with no door: you stop outside.
    const [x0, z0, x1, z1] = b.rects[0];
    const ca = Math.cos(b.ang), sa = Math.sin(b.ang), W = (lx, lz) => [b.cx + lx * ca - lz * sa, b.cz + lx * sa + lz * ca];
    const doorSides = new Set(b.doors.map((d) => `${Math.round(d.out[0] * ca + d.out[1] * sa)},${Math.round(-d.out[0] * sa + d.out[1] * ca)}`));
    const wall = [['0,-1', [(x0 + x1) / 2, z0 - 3], [(x0 + x1) / 2, (z0 + z1) / 2]], ['0,1', [(x0 + x1) / 2, z1 + 3], [(x0 + x1) / 2, (z0 + z1) / 2]],
      ['-1,0', [x0 - 3, (z0 + z1) / 2], [(x0 + x1) / 2, (z0 + z1) / 2]], ['1,0', [x1 + 3, (z0 + z1) / 2], [(x0 + x1) / 2, (z0 + z1) / 2]]].find(([k]) => !doorSides.has(k));
    if (wall) {
      const [from, to] = [W(...wall[1]), W(...wall[2])];
      let x = from[0], z = from[1];
      for (let i = 0; i < 80; i++) { const p = moveWithCollision(x, z, (to[0] - x) * 0.1, (to[1] - z) * 0.1, PLAYER_RADIUS, solids, map.terrain); x = p.x; z = p.z; }
      assert.ok(!insideBuilding(b, x, z, 0), 'a wall without a door keeps you out');
      // A bullet fired at that wall from outside hits it before the middle of the building.
      const ey = gy(from[0], from[1]) + 1.5, dx = to[0] - from[0], dz = to[1] - from[1], l = Math.hypot(dx, dz);
      const hit = rayAgainstBoxes(from[0], ey, from[1], dx / l, 0, dz / l, solids, l);
      assert.ok(hit.t < l, 'a bullet hits the turned wall');
    }
    // In through the doorway.
    const d = b.doors[0];
    let x = d.x + d.out[0] * 2.5, z = d.z + d.out[1] * 2.5;
    for (let i = 0; i < 60; i++) { const p = moveWithCollision(x, z, -d.out[0] * 0.15, -d.out[1] * 0.15, PLAYER_RADIUS, solids, map.terrain); x = p.x; z = p.z; }
    if (insideBuilding(b, x, z, 0)) walkedIn++;
  }
  assert.ok(walkedIn >= sample.length * 0.8, `walked in through the door of ${walkedIn} of ${sample.length}`);
});
