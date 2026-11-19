// The house kit: walls snap to the 4 m grid, floors go on top of them, stairs climb to the floor
// above through a stairwell, a window wall lets shots through its window and a door wall opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPiece, structureBox, structureBoxes, KIT_CELL } from '../shared/building.js';
import { moveWithCollision, rayAgainstBoxes } from '../shared/world.js';

const G = 5;   // flat ground at 5 m
const terrain = { height: () => G };
function makeWorld() {
  const built = [];
  let n = 0;
  const world = {
    terrain, towns: [], contacts: [], landingZones: [],
    structsNear: () => built.map((s) => ({ ...s, mine: true })),
    solidsNear: () => built.flatMap((s) => structureBoxes(s, { type: 'struct', structId: s.id })),
  };
  const place = (type, ax, az, rot, player) => {
    const plan = planPiece(world, type, ax, az, rot, player);
    if (plan.problem) return plan;
    const st = { id: `s${++n}`, type, x: plan.x, z: plan.z, rot: plan.rot, y0: plan.y0, stage: 1 };
    for (const k of ['h', 'base', 'rise', 'hole', 'holeBy']) if (plan[k] !== undefined) st[k] = plan[k];
    for (const id of plan.holeFloors || []) { const f = built.find((q) => q.id === id); const sb = structureBox(st); f.hole = [sb.minX, sb.minZ, sb.maxX, sb.maxZ]; f.holeBy = st.id; }
    built.push(st);
    return st;
  };
  return { world, built, place };
}
const solids = (built) => built.flatMap((s) => structureBoxes(s, { type: 'struct', structId: s.id }));
// Walk from (x, z, y) toward (tx, tz) in small steps, the way the client and server move you.
function walk(built, x, z, y, tx, tz) {
  for (let i = 0; i < 400; i++) {
    const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz);
    if (d < 0.05) break;
    const s = Math.min(0.1, d);
    const np = moveWithCollision(x, z, dx / d * s, dz / d * s, 0.35, solids(built), terrain, y);
    if (Math.hypot(np.x - x, np.z - z) < 1e-4) break;
    ({ x, z, y } = np);
  }
  return { x, z, y };
}

test('house kit: walls snap to the grid and turn to the line you aim at', () => {
  const { place } = makeWorld();
  const me = { x: 10, z: 10, y: G };
  // Aim near the line z = 8 (between x 8 and 12): a wall along x, centred on the square's edge.
  const a = place('wall', 9.3, 8.4, 1, me);
  assert.deepEqual([a.x, a.z, a.rot], [10, 8, 0]);
  // Aim near the line x = 12: turned to run along z.
  const b = place('window', 11.7, 9.1, 0, me);
  assert.deepEqual([b.x, b.z, b.rot], [12, 10, 1]);
  // Same edge again: blocked.
  assert.match(place('wall', 10.4, 8.1, 0, me).problem, /Blocked/);
  // Walls sit just into the ground, 3 m tall.
  assert.equal(a.y0, G - 0.15);
});

test('house kit: a room with a roof, stairs up through a stairwell to a second storey', () => {
  const { place, built } = makeWorld();
  const me = { x: 10, z: 10, y: G };
  const wallS = place('wall', 10, 8, 0, me);
  place('window', 12, 10, 0, me);
  const door = place('doorway', 10, 12, 0, me);
  place('wall', 8, 10, 0, me);
  assert.equal(built.length, 4);
  // The roof: on top of the walls, not on the ground.
  const roof = place('floor', 10, 10, 0, me);
  assert.equal(roof.y0, wallS.y0 + 3);
  assert.equal(structureBox(roof).h, 0.25);
  const roofTop = roof.y0 + 0.25;
  // A foundation out on open ground (no walls around it): on the ground.
  const pad = place('floor', 30, 30, 0, { x: 30, z: 33, y: G });
  assert.ok(pad.y0 < G && pad.y0 + structureBox(pad).h > G, 'foundation sits on the ground');

  // Stairs inside, climbing +x along the room's south side, up to the roof: the roof opens a stairwell.
  const stairs = place('stairs', 10, 8.5, 0, me);
  assert.ok(!stairs.problem, stairs.problem);
  assert.equal(stairs.z, 8 + 0.7);
  assert.ok(Math.abs(stairs.base + stairs.rise - roofTop) < 0.01, 'stairs reach the roof');
  assert.ok(roof.hole, 'roof has a stairwell over the stairs');
  assert.deepEqual(structureBoxes(roof).map((q) => [+q.minZ.toFixed(2), q.maxZ]), [[9.4, 12]], 'the rest of the square is still roof');

  // Walk in through the open doorway, up the stairs and onto the roof.
  door.open = true;
  let p = walk(built, 10, 14, G, 10, 11.5);   // in through the door
  assert.ok(p.z < 12, `got through the open doorway (z ${p.z.toFixed(2)})`);
  p = walk(built, p.x, p.z, p.y, 8.5, 8.7);    // to the foot of the stairs
  p = walk(built, p.x, p.z, p.y, 11.9, 8.7);   // up them
  assert.ok(Math.abs(p.y - roofTop) < 0.2, `top of the stairs at the roof (y ${p.y.toFixed(2)} vs ${roofTop.toFixed(2)})`);
  p = walk(built, p.x, p.z, p.y, 11, 10.8);    // step off onto the roof
  assert.ok(Math.abs(p.y - roofTop) < 0.05 && p.z > 10.5, `standing on the roof (y ${p.y.toFixed(2)})`);

  // Up here, a wall goes on the roof (the second storey), and a second roof on top of that.
  const up = { x: p.x, z: p.z, y: p.y };
  const w2 = place('wall', 10, 12.2, 0, up);
  assert.ok(!w2.problem, w2.problem);
  assert.equal(w2.y0, +roofTop.toFixed(2));
  const roof2 = place('floor', 10, 10, 0, up);
  assert.ok(!roof2.problem, roof2.problem);
  assert.equal(roof2.y0, +(w2.y0 + 3).toFixed(2));

  // A closed door blocks the way; the window is open to shots but not to walking.
  door.open = false;
  const shut = walk(built, 10, 14, G, 10, 11);
  assert.ok(shut.z > 12, 'closed door holds');
  const win = solids(built).filter((q) => q.structId === built[1].id);
  const through = rayAgainstBoxes(14, G + 1.5, 10, -1, 0, 0, win, 10);
  assert.ok(through.t > 5, 'a shot at chest height goes through the window');
  const low = rayAgainstBoxes(14, G + 0.5, 10, -1, 0, 0, win, 10);
  assert.ok(low.t < 3, 'a shot at knee height hits the wall under it');
  assert.equal(KIT_CELL, 4);
});
