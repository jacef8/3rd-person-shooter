import fs from 'node:fs';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, mapChecksum, moveWithCollision, rayBox, rayAgainstBoxes, circleOverlapsBox, PLAYER_RADIUS } from '../shared/world.js';
import { biomeName, DEEP_WATER, parseElevation } from '../shared/terrain.js';
import { PIECES, placementProblem, pieceBox, investedCost } from '../shared/building.js';
import { makeWeapon, weaponStats, levelFromXp, xpForLevel, unlocksAt, PARTS, ARCHETYPES, MAX_LEVEL, partFits, UPGRADES, CONTRACT_TYPES, isUnlocked } from '../shared/items.js';

test('open world: real Bristol area at 1:1, deterministic, towns, stash houses, contacts, landing zones', () => {
  const a = generateMap(42), b = generateMap(42);
  assert.equal(mapChecksum(a), mapChecksum(b));
  assert.equal(a.size, 30000);
  for (const n of ['Bristol', 'Blountstown', 'Hosford', 'Telogia', 'Estiffanulga', 'Lake Mystic']) assert.ok(a.towns.some((t) => t.name === n), n);
  assert.ok(a.houses.length >= 150, `houses ${a.houses.length}`);
  assert.equal(a.contacts.length, a.towns.length, 'every town has a Contact');
  assert.ok(a.landingZones.length >= 16);
  assert.ok(a.campSites.length >= 200);
  assert.ok(a.landmarks.some((l) => l.name === 'Torreya State Park'));
  for (const p of a.landingZones) assert.ok(!a.grid.near(p.x, p.z, 2).some((bx) => circleOverlapsBox(p.x, p.z, PLAYER_RADIUS, bx)));
  // Real distances: Bristol to Blountstown is ~6.6 km, Bristol to Hosford ~17 km.
  const T = (n) => a.towns.find((t) => t.name === n);
  const d = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
  assert.ok(Math.abs(d(T('Bristol'), T('Blountstown')) - 6600) < 700, `Bristol-Blountstown ${d(T('Bristol'), T('Blountstown'))}`);
  assert.ok(Math.abs(d(T('Bristol'), T('Hosford')) - 17600) < 900, `Bristol-Hosford ${d(T('Bristol'), T('Hosford'))}`);
  assert.ok(a.bridges.some((br) => br.road === 'SR 20' && br.river === 'Apalachicola River'), 'SR 20 bridge over the Apalachicola');
  assert.notEqual(mapChecksum(generateMap(43)), mapChecksum(a), 'different seeds give different worlds');
});

test('buildings can be walked into through their doorways, and have loot inside', () => {
  const m = generateMap(1337);
  assert.ok(m.buildings.length > 500, `${m.buildings.length} enterable buildings`);
  let doors = 0, walkedIn = 0;
  for (const b of m.buildings) {
    assert.ok(b.doors.length >= 1, 'every building has a doorway');
    for (const d of b.doors) {
      doors++;
      const solids = m.grid.near(d.x, d.z, 12);
      const p = moveWithCollision(d.x + d.out[0] * 3, d.z + d.out[1] * 3, -d.out[0] * 6, -d.out[1] * 6, PLAYER_RADIUS, solids, m.terrain);
      if (p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ) walkedIn++;
    }
  }
  assert.ok(walkedIn / doors > 0.99, `walked in through ${walkedIn}/${doors} doorways`);
  // Walls are solid where there's no door: walking at a doorless wall stops outside.
  const b = m.buildings.find((x) => x.doors.length === 2 && x.doors[0].out[0] === 0 && x.maxX - x.minX > 12);
  const p = moveWithCollision(b.maxX + 2, (b.minZ + b.maxZ) / 2, -6, 0, PLAYER_RADIUS, m.grid.near(b.maxX, (b.minZ + b.maxZ) / 2, 10), m.terrain);
  assert.ok(p.x > b.maxX, 'side wall blocks');
  // Loot spots inside buildings.
  const inside = m.lootSpawns.filter((l) => l.indoor);
  assert.ok(inside.length > 1000, `${inside.length} indoor loot spots`);
  for (const l of inside.slice(0, 200)) assert.ok(m.buildings.some((q) => l.x > q.minX && l.x < q.maxX && l.z > q.minZ && l.z < q.maxZ));
  // A shot from inside hits the ceiling, not the sky.
  const room = m.buildings[0], cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
  const up = rayAgainstBoxes(cx, room.floor + 1.5, cz, 0, 1, 0, m.grid.near(cx, cz, 2), 100);
  assert.ok(up.t < 4, 'ceiling overhead');
});

test('countryside trees and rocks are generated lazily and identically in any order', () => {
  const ids = (m, x, z) => m.grid.near(x, z, 60).filter((b) => b.nature).map((b) => `${b.id}:${b.minX.toFixed(3)}:${b.y0.toFixed(3)}`).sort().join();
  const m1 = generateMap(5), m2 = generateMap(5);
  const t = m1.towns[0];
  const x = t.x + 900, z = t.z + 400;
  m2.grid.near(x + 150, z - 90, 220);   // load the neighbourhood first, in a different order
  const a = ids(m1, x, z), b = ids(m2, x, z);
  assert.equal(a, b);
  // Forest is dense at real scale.
  let trees = 0;
  for (let i = 0; i < 30 && trees === 0; i++) trees = m1.grid.near(-12000 + i * 900, 9000, 64).filter((q) => q.type === 'pine' || q.type === 'tree').length;
  assert.ok(trees > 0, 'trees in the countryside');
});

test('imported real structures and roads become map objects', () => {
  const at = (dx, dz) => ({ lat: 30.42556 - dz / 111000, lon: -84.97722 + dx / 96000 });
  const p1 = at(2500, -1200), p2 = at(2600, -1150), p3 = at(-2200, 3000);
  const real = {
    structures: [[p1.lat, p1.lon, 14, 11, 0, 'Residential'], [p2.lat, p2.lon, 40, 25, 9, 'Industrial'], [p3.lat, p3.lon, 30, 18, 0, 'Agriculture']],
    roads: [['Test Rd', 'residential', [[p1.lat + 0.001, p1.lon - 0.01], [p1.lat + 0.001, p1.lon + 0.01]]]],
  };
  const m = generateMap(42, 30000, real), m2 = generateMap(42, 30000, real);
  assert.equal(mapChecksum(m), mapChecksum(m2));
  assert.notEqual(mapChecksum(m), mapChecksum(generateMap(42)));
  // Each real footprint becomes a walk-in building (or a solid box if it's too small to enter).
  const rb = [...m.buildings.filter((b) => b.real), ...m.boxes.filter((bx) => bx.real && !bx.shell)];
  assert.equal(m.real.structures, rb.length);
  assert.ok(rb.length >= 2, `placed ${rb.length}`);
  const wh = m.buildings.find((b) => b.real && b.type === 'warehouse');
  assert.ok(wh && Math.abs(wh.maxX - wh.minX - 40) < 0.01 && wh.doors.length >= 1, 'the warehouse is enterable at its real size');
  assert.ok(m.boxes.some((bx) => bx.type === 'warehouse' && bx.shell && bx.minX >= wh.minX - 0.01 && bx.maxX <= wh.maxX + 0.01), 'with walls');
  assert.ok(m.roads.some((r) => r.name === 'Test Rd'));
  // Real structures replace the procedural stand-in town blocks and farms.
  assert.ok(!m.boxes.some((bx) => bx.type === 'barn' && !bx.real));
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
    const slow = rayAgainstBoxes(ox, oy, oz, dx / l, dy / l, dz / l, [...m.boxes, ...m.grid.near(ox, oz, 210).filter((q) => q.nature)], 200);
    assert.equal(fast.t, slow.t);
  }
});

test('stash upgrades and contracts are well formed', () => {
  for (const [k, u] of Object.entries(UPGRADES)) {
    u.tiers.slice(1).forEach((t, i) => {
      assert.ok(t.home >= 1 && t.cost, `${k} tier ${i + 1}`);
      if (i) assert.ok(t.home >= u.tiers[i].home, `${k} tiers increase in home level`);
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
  const blocked = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, [...near, door], map.terrain);
  assert.ok(blocked.z > door.maxZ, 'door should stop the player');
  // With the door breached the player walks in (gap is 1.8m, player is 0.9m wide).
  const open = moveWithCollision(outside.x, outside.z, 0, -4, PLAYER_RADIUS, near, map.terrain);
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

test('biomes: city, forest, desert, mountains and water all exist, with natural homes in them', () => {
  const m = generateMap(1337);
  const seen = new Set();
  let water = 0, peak = 0;
  for (let i = 0; i < 3600; i++) {
    const x = -m.half + ((i % 60) + 0.5) * m.size / 60, z = -m.half + (Math.floor(i / 60) + 0.5) * m.size / 60;
    seen.add(biomeName(m.terrain.biome(x, z)));
    const h = m.terrain.exact(x, z);
    if (h < 0) water++;
    peak = Math.max(peak, h);
  }
  for (const b of ['plains', 'forest', 'desert', 'mountain', 'sea']) assert.ok(seen.has(b), b);
  assert.ok(water > 15, `there is water (rivers and lakes): ${water}`);
  assert.ok(peak > 50, `the bluffs and hills rise well above the rivers (${peak.toFixed(0)} m)`);
  const kinds = new Set(m.houses.map((h) => h.kind));
  for (const k of ['house', 'room', 'cave', 'rockfort', 'treehut', 'boathouse', 'vehicle']) assert.ok(kinds.has(k), k);
  for (const h of m.houses.filter((x) => x.kind === 'cave')) assert.equal(biomeName(m.terrain.biome(h.x, h.z)), 'mountain');
  for (const h of m.houses.filter((x) => x.kind === 'treehut')) { const b = m.terrain.biome(h.x, h.z); assert.ok(b.forest + b.sea > 0.35, 'hollow cypress in woods or swamp'); }
  // Town ground is flattened.
  for (const t of m.towns) {
    const r = t.rect;
    const hs = [m.terrain.height(r.minX + 5, r.minZ + 5), m.terrain.height(r.maxX - 5, r.maxZ - 5), m.terrain.height(t.x, t.z)];
    assert.ok(Math.max(...hs) - Math.min(...hs) < 0.5, `${t.name} is flat`);
  }
});

test('terrain blocks deep water and cliffs, and stops bullets', () => {
  const m = generateMap(1337);
  const t = m.terrain;
  // Walk west from Bristol toward the Apalachicola: you stop at the river's edge.
  const bristol = m.towns.find((q) => q.name === 'Bristol');
  let shore = null;
  for (let x = bristol.rect.minX - 20; x > bristol.x - 6000 && !shore; x -= 2) if (t.height(x, bristol.z) < DEEP_WATER) shore = { x: x + 40, z: bristol.z };
  assert.ok(shore, 'found the Apalachicola east bank');
  const p = moveWithCollision(shore.x, shore.z, -200, 0, PLAYER_RADIUS, [], t);
  assert.ok(t.height(p.x, p.z) >= DEEP_WATER, 'did not walk into deep water');
  assert.ok(shore.x - p.x < 100, 'stopped at the river');
  // The SR 20 bridge between Bristol and Blountstown lets you cross.
  const br = m.bridges.find((b) => b.road === 'SR 20' && b.river === 'Apalachicola River');
  assert.ok(br, 'SR 20 bridge exists');
  assert.ok(t.height(br.x, br.z) > 1, 'bridge deck is above water');
  // Torreya bluffs, from the real elevation data: steep ground east of the river, north of Bristol.
  const elevation = parseElevation(zlib.gunzipSync(fs.readFileSync(new URL('../data/real/elevation.bin.gz', import.meta.url))));
  assert.ok(elevation && elevation.n > 500, 'real elevation loads');
  const te = generateMap(1337, 30000, { elevation }).terrain;
  let cliff = null;
  for (let x = -9000; x < 0 && !cliff; x += 3) for (let z = -14500; z < -3000 && !cliff; z += 50) if ((te.height(x + 3, z) - te.height(x, z)) / 3 > 1.3) cliff = { x, z };
  if (cliff) assert.ok(moveWithCollision(cliff.x, cliff.z, 6, 0, PLAYER_RADIUS, [], te).x < cliff.x + 3, 'cliff blocked');
  // A shot fired horizontally from the river bank into the bluffs hits the ground.
  let hill = null;
  for (let z = -14500; z < -3000 && !hill; z += 250) for (let x = -9000; x < 0 && !hill; x += 10) { const h = te.height(x, z); if (h > 1 && h < 6 && te.height(x + 80, z) > h + 12) hill = { x, z, h }; }
  assert.ok(hill, 'found the bluff face');
  assert.ok(te.ray(hill.x, hill.h + 1.5, hill.z, 1, 0, 0, 200) < 200);
  // Real ground: Bristol sits well above the river, Blountstown down on the floodplain.
  const rm = generateMap(1337, 30000, { elevation });
  const elev = (n) => rm.towns.find((q) => q.name === n).elev;
  assert.ok(elev('Bristol') > 25 && elev('Blountstown') < 15, `Bristol ${elev('Bristol')}, Blountstown ${elev('Blountstown')}`);
});

test('building rules: frames on open ground, not in towns, water or on top of things', () => {
  const m = generateMap(1337);
  const world = { terrain: m.terrain, towns: m.towns, contacts: m.contacts, landingZones: m.landingZones, solidsNear: (x, z, r) => m.grid.near(x, z, r) };
  const t = m.towns[0];
  assert.match(placementProblem(world, 'wall', t.x + 30, t.z, 0, { x: t.x + 30, z: t.z + 2 }), /towns/);
  // Somewhere open in the plains.
  let spot = null;
  for (let i = 0; i < 4000 && !spot; i++) {
    const x = -1000 + (i % 80) * 37, z = -2000 + Math.floor(i / 80) * 53;
    if (placementProblem(world, 'wall', x, z, 0, { x, z: z + 3 }) === null) spot = { x, z };
  }
  assert.ok(spot, 'found buildable ground');
  assert.equal(placementProblem(world, 'wall', spot.x, spot.z, 0, { x: spot.x + 20, z: spot.z }), 'Too far away');
  const wb = pieceBox('wall', 0, 0, 1);
  assert.ok(wb.maxZ - wb.minZ === 4 && Math.abs(wb.maxX - wb.minX - 0.4) < 1e-9, 'rotation swaps footprint');
  assert.deepEqual(investedCost('wall', 2), { wood: 25, stone: 20, salvage: 10 });
  for (const [k, p] of Object.entries(PIECES)) assert.ok(p.stages.length >= 1 && p.stages.every((s) => s.hp > 0), k);
});
