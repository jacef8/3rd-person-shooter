// The rule data files (shared/data/*.json) are what a designer edits, and what a future Unreal
// build will import. These checks catch broken references and typos before they reach the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const arsenal = load('arsenal.json'), progression = load('progression.json'), stash = load('stash.json');
const building = load('building.json'), activities = load('activities.json'), combat = load('combat.json');
const gadgets = load('gadgets.json'), map = load('map-bristol.json');
const RESOURCES = new Set(['ammo', 'parts', 'tech', 'intel', 'salvage', 'wood', 'stone', 'comms']);
const costOk = (cost, where) => { for (const [k, v] of Object.entries(cost || {})) { assert.ok(RESOURCES.has(k), `${where}: unknown resource "${k}"`); assert.ok(v > 0, `${where}: ${k} must be > 0`); } };

test('every data file is valid JSON with a description', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) assert.equal(typeof load(f)._about, 'string', `${f} needs an _about`);
});

test('arsenal: parts, slots, platforms and unlock levels line up', () => {
  const archetypes = Object.keys(arsenal.archetypes);
  for (const [g, list] of Object.entries(arsenal.fitGroups)) for (const a of list) assert.ok(archetypes.includes(a), `fit group ${g}: ${a}`);
  for (const [id, p] of Object.entries(arsenal.parts)) {
    assert.ok(arsenal.slots.includes(p.slot), `${id}: slot ${p.slot}`);
    const fits = typeof p.fits === 'string' ? arsenal.fitGroups[p.fits] : p.fits;
    assert.ok(Array.isArray(fits) && fits.every((a) => archetypes.includes(a)), `${id}: fits`);
    assert.ok(p.level >= 1 && p.level <= progression.maxLevel, `${id}: level`);
  }
  for (const s of arsenal.slots) assert.ok(arsenal.parts[arsenal.defaultParts[s]]?.slot === s, `default ${s}`);
  for (const [id, a] of Object.entries(arsenal.archetypes)) for (const k of ['damage', 'range', 'rpm', 'mag', 'reloadMs', 'pellets']) assert.ok(a[k] > 0, `${id}.${k}`);
  for (const [id, x] of Object.entries({ ...arsenal.paints, ...arsenal.armors, ...arsenal.fieldPerks, ...gadgets.gadgets })) assert.ok(x.level >= 1 && x.level <= progression.maxLevel, `${id}: level`);
});

test('stash: upgrades need reachable home levels and known resources', () => {
  const maxHome = stash.homeLevelXp.length;
  assert.equal(stash.homeLevelText.length, maxHome);
  for (let i = 1; i < maxHome; i++) assert.ok(stash.homeLevelXp[i] > stash.homeLevelXp[i - 1], 'home XP rises');
  for (const [id, u] of Object.entries(stash.upgrades)) u.tiers.forEach((t, i) => { costOk(t.cost, `${id} tier ${i}`); if (i) assert.ok(t.home >= 1 && t.home <= maxHome, `${id} tier ${i}: home level`); });
  costOk(stash.claim.markerCraft, 'marker'); costOk(stash.claim.markerPrice, 'marker price');
});

test('building, contracts, loot and AI reference things that exist', () => {
  for (const [id, c] of Object.entries(building.crafts)) costOk(c.cost, `craft ${id}`);
  for (const [id, p] of Object.entries(building.pieces)) { assert.equal(p.size.length, 3, `${id}: size`); p.stages.forEach((st, i) => { costOk(st.cost, `${id} stage ${i}`); assert.ok(st.hp > 0); }); }
  for (const [id, c] of Object.entries(activities.contracts.types)) { costOk(c.reward, `contract ${id}`); assert.ok(c.xp > 0); }
  costOk(activities.supplyDrop.contents, 'supply drop');
  const kinds = new Set([...RESOURCES, 'medkit', 'tool', 'marker']);
  for (const [zone, list] of Object.entries(activities.loot.zones)) for (const it of list) {
    assert.ok(kinds.has(it.kind), `loot ${zone}: ${it.kind}`);
    if (it.kind === 'tool') assert.ok(building.tools[it.tool], `loot ${zone}: tool ${it.tool}`);
  }
  for (const w of [...combat.bots.weapons, combat.bots.hvt.weapon]) assert.ok(arsenal.archetypes[w], `bot weapon ${w}`);
});

test('map: real positions sit in the Florida panhandle and the shapes are well formed', () => {
  const inArea = ([lat, lon]) => lat > 29.5 && lat < 31.5 && lon > -86 && lon < -84;
  for (const t of [...map.towns, ...map.landmarks]) assert.ok(inArea([t.lat, t.lon]), t.name);
  for (const r of [...map.rivers, ...map.highways]) { assert.ok(r.path.length >= 2, r.name); assert.ok(r.path.every(inArea), r.name); }
  for (const r of map.rivers) assert.ok(r.widthM > 0 && r.swampWidthM >= r.widthM, r.name);
  for (const l of map.lakes) for (const c of l.capsules) assert.ok(inArea(c.from) && inArea(c.to) && c.radiusM > 0, l.name);
  for (const k of ['hills', 'sandhills', 'forest']) for (const g of map.terrainRegions[k]) assert.ok(inArea([g.lat, g.lon]) && g.radiusM > 0 && g.weight > 0, k);
  assert.ok(map.towns.some((t) => t.name === 'Bristol'));
});
