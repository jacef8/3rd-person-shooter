import * as THREE from 'three';
import { RoundedBoxGeometry } from '/addons/geometries/RoundedBoxGeometry.js';
import {
  generateMap, mapChecksum, moveWithCollision, rayAgainstBoxes, rayBox, characterBounds, insideBuilding, INTERACT_RANGE,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, PRONE_EYE, PRONE_SPEED, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED, ADS_SPEED, SLIDE, JUMP_V, JUMP_G, climbAhead, climbVy, LADDER, ladderAt, drawMs } from '/shared/world.js';
import {
  ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS, SLOT_LABELS, weaponStats, armorStats, statBars, partFits,
  xpForLevel, MAX_LEVEL, GADGETS, isUnlocked, UPGRADES, CONTRACT_TYPES, FIELD_PERKS, DEFAULT_PARTS,
} from '/shared/items.js';
import { buildGunModel, setExplode, gunKey, gunsReal } from '/gunmodel.js';
import * as sfx from '/sound.js';
import { buildRideModel, preloadVehicles } from '/ridemodels.js';
import { attachAnimal, animateAnimal, preloadAnimals } from '/animals.js';
import { createTownDressing } from '/towns.js';
import { withCounty } from '/shared/county.js';
import { withEdits } from '/shared/edits.js';
import { createEnvironment, worldClock, clockLabel } from '/daynight.js';
import { attachPerson, animatePerson, handsOnGun, handsOnBars, chestAt, hangFrom, preloadPeople } from '/people.js';
import { ACT_POSE, updateAction } from '/actions.js';
import { startLobbyFx } from '/lobbyfx.js';
import { createWorldView, SKY_HORIZON } from '/worldview.js';
import { buildMapBase, drawMap, mapGroundColor, sampleLand, sampleLandAsync, fillBox } from '/mapview.js';
import { PIECES, BUILD, TOOLS, CRAFTS, pieceBox, structureBox, placementProblem } from '/shared/building.js';
import { CLAIM, HOME_LEVEL_XP, MAX_HOME_LEVEL, HOME_LEVEL_TEXT, homePerks, RAIDS, hourLabel, windowText } from '/shared/claims.js';
import { VEHICLE_TYPES, HOME_KINDS } from '/shared/world.js';
import { EXTRACT } from '/shared/extraction.js';
import { distText, feet } from '/shared/units.js';
import HELI from '/shared/data/activities.json' with { type: 'json' };
import SITES from '/shared/data/sites.json' with { type: 'json' };
import { SKY, airRates, nextMode, stepAir } from '/shared/skydive.js';
import { BOATS, BOAT_RULES, RIDE_RULES, stepBoat, seatPos, riderFeet, rideSolids } from '/shared/boats.js';
import { parseElevation, parseLandcover, biomeName } from '/shared/terrain.js';
import COMBAT_RULES from '/shared/data/combat.json' with { type: 'json' };
import HOMESTEAD from '/shared/data/homestead.json' with { type: 'json' };
import WORLD_LIVING from '/shared/data/world.json' with { type: 'json' };
const GOODS = HOMESTEAD.goods;
// Everything you can carry, stash and trade, in display order.
const RES_UI = ['cash', 'parts', 'tech', 'salvage', 'ammo', 'rockets', 'wood', 'stone', 'intel', 'seeds', 'corn', 'peanuts', 'cotton', 'fish', 'meat', 'meals', 'honey', 'shine', 'hide'];
const RES_LABEL = { parts: 'parts', tech: 'tech', intel: 'intel drives', ammo: 'rounds', salvage: 'salvage', wood: 'wood', stone: 'stone', ...Object.fromEntries(Object.entries(GOODS).map(([k, g]) => [k, g.name])) };
// In the bag and the stash the goods go in two rows rather than one each: everything you can eat, best
// first, and the things you sell (or plant).
const FOOD_GOODS = ['meals', 'corn', 'peanuts', 'honey', 'fish', 'meat'];
const TRADE_GOODS = ['seeds', 'cotton', 'shine', 'hide'];
const GROUPED = new Set([...FOOD_GOODS, ...TRADE_GOODS]);
const resText = (r, n) => (r === 'cash' ? `$${n}` : `${n} ${RES_LABEL[r] || r}`);

const $ = (id) => document.getElementById(id);
/** Terrain height under a point (0 before the world exists). */
const ground = (x, z) => (state.map ? state.map.terrain.height(x, z) : 0);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('game');
// Phones/tablets (touch-first devices) get a lighter render profile.
const MOBILE = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // soft-edged shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // film-like light: bright sky without washing out the ground
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
// No fog. The distance is a second scene (sky, the county's ground, far-off buildings and woods,
// see worldview.js) drawn first through a long-range camera; the near world is drawn over it.
renderer.autoClear = false;
renderer.setClearColor(SKY_HORIZON);
// Graphics: Fast for phones (and older computers), Full for desktops; changed in the crew panel.
const GFX = {
  fast: { label: 'Low', pixel: 1, view: 200, far: 600, shadows: false, shadowMap: 1024, grass: 0, about: 'For older phones: shorter view, no shadows, no grass.' },
  balanced: { label: 'Medium', pixel: 1.5, view: 260, far: 1000, shadows: true, shadowMap: 1024, grass: 1.2, about: 'Middle ground: some grass.' },
  full: { label: 'High', pixel: 2, view: 320, far: 1500, shadows: true, shadowMap: 2048, grass: 3, about: 'Long views, shadows and grass, sharp on any screen.' },
  ultra: { label: 'Ultra', pixel: 3, view: 420, far: 2600, shadows: true, shadowMap: 4096, grass: 5.5, about: 'Full screen sharpness, the longest views, the finest shadows and the thickest grass: for flagship phones and gaming PCs.' },
};
// Everyone starts on High (today's phones run it); Low stays in Settings for older ones. A saved
// 'fast' from before High was the phone default is moved up once.
let gfxMode = (() => {
  try {
    const v = localStorage.getItem('dz_gfx');
    if (v === 'fast' && !localStorage.getItem('dz_gfx_v2')) { localStorage.setItem('dz_gfx_v2', '1'); return 'full'; }
    if (GFX[v]) return v;
  } catch { /* private mode */ }
  return 'full';
})();
function applyGfx(mode = gfxMode) {
  gfxMode = mode;
  try { localStorage.setItem('dz_gfx', mode); } catch { /* private mode */ }
  const g = GFX[mode];
  renderer.setPixelRatio(Math.min(devicePixelRatio, g.pixel));
  sun.castShadow = g.shadows;
  if (sun.shadow.mapSize.x !== g.shadowMap) { sun.shadow.mapSize.set(g.shadowMap, g.shadowMap); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  const reach = mode === 'ultra' ? 110 : 70;
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, far: reach * 3 });
  sun.shadow.camera.updateProjectionMatrix();
  try { localStorage.setItem('dz_gfx_v2', '1'); } catch { /* private mode */ }
  state.view?.setRanges(g.view, g.far);
  state.view?.setGrass(g.grass || 0);
  dispatchEvent(new Event('resize'));
}
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
const farCamera = new THREE.PerspectiveCamera(70, 1, 20, 130000);
function renderWorld() {
  renderer.clear();
  if (state.view) {
    farCamera.position.copy(camera.position);
    farCamera.quaternion.copy(camera.quaternion);
    if (farCamera.fov !== camera.fov || farCamera.aspect !== camera.aspect) { farCamera.fov = camera.fov; farCamera.aspect = camera.aspect; farCamera.updateProjectionMatrix(); }
    renderer.render(state.view.far, farCamera);
    renderer.clearDepth();
  }
  renderer.render(scene, camera);
}
const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x3a3530, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 220 });
sun.shadow.normalBias = 0.35;   // keeps sloped roofs and siding from shadowing themselves in speckles
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ game state
const state = {
  exposed: new Map(), sensors: [], pings: [], alerts: [], squad: { id: null, members: [], leaderId: null }, invite: null,
  hack: null, aimTargetId: null, houseState: new Map(), termState: new Map(),
  contracts: [], drops: [], extracts: [], objectives: [], contactMeshes: [], hotZone: null, sirens: new Map(), defMarks: [],
  ws: null, id: null, map: null, houseId: null, me: null,
  x: 0, z: 0, yaw: 0, pitch: 0, crouch: false, aiming: false, sprint: false,
  keys: new Set(), mouseDown: false, firedThisPress: false, lastShot: 0,
  players: new Map(), bots: new Map(), loot: new Map(), bags: new Map(), houses: [],
  container: null, invOpen: false, lastSend: 0, recoil: 0,
  doorSolids: [], snapshotHouses: [],
};

// ------------------------------------------------------------------ world construction
// The client regenerates the same world as the server from (seed, size) and streams it in chunks.
const houseVis = new Map();     // houseId -> { door, label }
/** Your stash house position (home, room, vehicle or claim flag), or null. */
const homePos = () => (state.me?.claim ? { x: state.me.claim.x, z: state.me.claim.z } : null);
const homeKindName = (h) => (h.kind === 'vehicle' ? VEHICLE_TYPES[h.vtype].name : HOME_KINDS[h.kind].name);
const termVis = new Map();      // terminalId -> mesh
const dropVis = new Map();      // supply drop id -> group
const objVis = new Map();       // contract crate id -> mesh
const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a5f66, metalness: 0.4, roughness: 0.5 });
const termGeo = new THREE.BoxGeometry(0.8, 1.5, 0.35);

/** The real-world data (buildings, roads, elevation) from tools/import_real_world.py, served by the game server. */
async function loadRealData(info) {
  const get = async (name) => { try { const r = await fetch(`/data/real/${name}`); return r.ok ? (await r.json()).rows : undefined; } catch { return undefined; } };
  const elevation = async () => {
    try {
      const r = await fetch('/data/real/elevation.bin');   // served from elevation.bin.gz, unpacked by the browser
      return r.ok ? parseElevation(new Uint8Array(await r.arrayBuffer())) || undefined : undefined;
    } catch { return undefined; }
  };
  const landcover = async () => {
    try {
      const r = await fetch('/data/real/landcover.bin');   // served from landcover.bin.gz
      return r.ok ? parseLandcover(new Uint8Array(await r.arrayBuffer())) || undefined : undefined;
    } catch { return undefined; }
  };
  const whole = async (name) => { try { const r = await fetch(`/data/real/${name}`); return r.ok ? await r.json() : undefined; } catch { return undefined; } };
  const [structures, roads, elev, cover, infrastructure, businesses] = await Promise.all([info.structures ? get('structures.json') : undefined, info.roads ? get('roads.json') : undefined,
    info.elevation ? elevation() : undefined, info.landcover ? landcover() : undefined, info.infrastructure ? whole('infrastructure.json') : undefined,
    get('businesses.json')]);   // (signs only: not part of the map, so it's fetched whatever the server says)
  const county = info.county ? await whole('county.json') : null;   // the county's own GIS, merged as the server does
  return { ...withEdits(withCounty({ structures, roads }, county), info.edits), elevation: elev, landcover: cover, infrastructure, businesses, hydrants: county?.hydrants };
}

/** A loaded tree or rock by its id (nature boxes sit in the grid near where they grow). */
function findNatureBox(id) {
  return state.map.grid.near(state.x, state.z, 400).find((q) => q.id === id) || null;
}
function initWorld(m) {
  const map = generateMap(m.seed, m.size, m.realData || {});
  for (const id of m.felled || []) map.felled.add(id);
  state.mapSum = m.mapSum;
  if (mapChecksum(map) !== m.mapSum) toast('⚠ World mismatch with server — update your client');
  state.map = map;
  // One coarse pass over the whole county, shared by the far landscape and the map screen.
  const land = sampleLand(map, MOBILE ? 120 : 75);
  state.view = createWorldView(scene, map, { viewRange: GFX[gfxMode].view, farRange: GFX[gfxMode].far, mobile: MOBILE, land });
  state.towns = createTownDressing(scene, map, m.realData?.businesses, ground, m.realData?.hydrants, () => state.view?.setPaved((x, z) => state.towns.pavedAt(x, z)));
  state.env = createEnvironment({ scene, far: state.view.far, sky: state.view.sky, sun, hemi, renderer, camera, towns: state.towns, thunder: (x, y, z) => sfx.boom(x, y, z) });
  applyGfx();
  state.view.setOwnHouse(m.houseId);
  state.mapBase = buildMapBase(map, MOBILE ? 1400 : 2000, land);
  // A sharper county picture (30 m samples), worked out a slice at a time once you're in.
  setTimeout(() => sampleLandAsync(map, 30).then((fine) => { if (state.map !== map) return; state.mapBase = buildMapBase(map, 2400, fine); if (state.mapOpen) drawMapCanvas(); }), 3000);
  state.landmarks = map.buildings.filter((b) => b.name);
  buildLandingPads();
  // Contacts: friendly NPCs standing in each town square.
  for (const c of map.contacts) {
    const g = makeCharacter('contact', c.name);
    g.position.set(c.x, ground(c.x, c.z), c.z);
    g.rotation.y = Math.PI / 4;
    setLabel(g.userData.label, `✦ ${c.name}`, '#7fd6ff');
    g.userData.bars.visible = false;
    state.contactMeshes.push(g);
  }
  // River landings: a post with a sign at the head of each jetty; swamp camps get a sign overhead.
  for (const d of map.docks) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x5a4330 }));
    post.position.y = 1.1;
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0x2b5d7a }));
    sign.position.y = 2.0;
    const label = makeLabel(`⚓ ${d.name}`, 0.006, '#7fd6ff');
    label.position.y = 2.8;
    g.add(post, sign, label);
    g.userData.label = label;
    g.position.set(d.x, ground(d.x, d.z), d.z);
    g.rotation.y = Math.atan2(d.nx, d.nz);
    scene.add(g);
    state.contactMeshes.push(g);
  }
  // Shop signs over the front door (Lamar's Pawn).
  for (const sh of map.shops || []) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const g2 = c.getContext('2d');
    g2.fillStyle = '#14161b'; g2.fillRect(0, 0, 1024, 256);
    g2.strokeStyle = '#ffd27a'; g2.lineWidth = 12; g2.strokeRect(14, 14, 996, 228);
    g2.fillStyle = '#ffd27a'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.font = '800 112px Archivo, Arial Black, sans-serif'; g2.fillText(sh.name.toUpperCase(), 512, 112);
    g2.fillStyle = '#ffffff'; g2.font = '700 46px Atkinson Hyperlegible, Arial, sans-serif'; g2.fillText(sh.kind === 'pawn' ? 'GUNS · GOODS · BUY & SELL' : '', 512, 200);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 1.4), new THREE.MeshBasicMaterial({ map: tex }));
    const d = sh.door;
    sign.position.set(d.x + d.out[0] * 0.32, ground(d.x + d.out[0] * 2, d.z + d.out[1] * 2) + 3.3, d.z + d.out[1] * 0.32);
    sign.rotation.y = Math.atan2(d.out[0], d.out[1]);
    scene.add(sign);
  }
  for (const c of map.camps) {
    const g = new THREE.Group();
    const label = makeLabel(`🏕 ${c.name} · no fighting`, 0.009, '#9fe39f');
    label.position.y = 7;
    g.add(label);
    g.userData.label = label;
    g.position.set(c.x, ground(c.x, c.z), c.z);
    scene.add(g);
    state.contactMeshes.push(g);
  }
}

// The door of a vehicle someone lives in, as that vehicle has it: an RV's entry door, a school bus's
// folding glass doors, a box truck's roll-up door, a houseboat's cabin door. Flush with the body, on
// the face of the lock's box nearest the vehicle (the lock itself is what the game breaks and hacks).
const DOOR_DAMAGED = new THREE.Color(0x2a1a14);
function vehicleDoor(def, d) {
  const g = new THREE.Group(), vt = def.vtype;
  const sx = d.maxX - d.minX, sz = d.maxZ - d.minZ, thinX = sx < sz;
  const w = (thinX ? sz : sx), floor = vt === 'houseboat' ? 0.5 : 0.75;
  const hgt = vt === 'truck' ? Math.max(1.6, d.h - 0.9) : vt === 'bus' ? 2.0 : 1.9;
  const M = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, ...extra });
  const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const glass = M(0x24323d, { roughness: 0.15, metalness: 0.4 }), dark = M(0x262626, { roughness: 0.8 }), chrome = M(0xc8c8c8, { metalness: 0.8, roughness: 0.3 });
  let panel;
  if (vt === 'bus') {   // two tall glass leaves in a black frame
    part(new THREE.BoxGeometry(w, hgt, 0.04), dark, 0, 0, 0);
    for (const s of [-1, 1]) part(new THREE.BoxGeometry(w / 2 - 0.08, hgt - 0.16, 0.03), glass, s * w / 4, 0, 0.02);
    panel = part(new THREE.BoxGeometry(0.04, hgt, 0.05), dark, 0, 0, 0.03);
    panel.userData.paint = new THREE.Color(0x262626);
  } else if (vt === 'truck') {   // a roll-up shutter with its slats
    panel = part(new THREE.BoxGeometry(w, hgt, 0.05), M(0xd8d8da, { metalness: 0.35 }), 0, 0, 0);
    for (let k = 1; k < 9; k++) part(new THREE.BoxGeometry(w, 0.025, 0.06), M(0xa8a8ac), 0, -hgt / 2 + (hgt * k) / 9, 0.01);
    part(new THREE.BoxGeometry(0.3, 0.05, 0.06), chrome, 0, -hgt / 2 + 0.15, 0.04);
  } else {   // an RV's or houseboat's door: a panel with a window and a handle
    panel = part(new THREE.BoxGeometry(w, hgt, 0.05), M(0xece6d6), 0, 0, 0);
    part(new THREE.BoxGeometry(w * 0.6, hgt * 0.24, 0.02), glass, 0, hgt * 0.22, 0.03);
    part(new THREE.BoxGeometry(0.16, 0.04, 0.05), chrome, w * 0.3, -hgt * 0.05, 0.04);
    part(new THREE.BoxGeometry(w + 0.06, 0.05, 0.03), dark, 0, hgt / 2 + 0.02, -0.01);
  }
  // On the face of the lock's box that touches the vehicle, facing out.
  const cx = (d.minX + d.maxX) / 2, cz = (d.minZ + d.maxZ) / 2, toV = thinX ? Math.sign(def.x - cx) : Math.sign(def.z - cz);
  const y = d.y0 + floor + hgt / 2;
  if (thinX) { g.position.set(toV > 0 ? d.maxX - 0.03 : d.minX + 0.03, y, cz); g.rotation.y = toV > 0 ? -Math.PI / 2 : Math.PI / 2; }
  else { g.position.set(cx, y, toV > 0 ? d.maxZ - 0.03 : d.minZ + 0.03); g.rotation.y = toV > 0 ? Math.PI : 0; }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { panel, paint: panel.material.color.clone() };
  return g;
}
// Lanterns by the doors of the homes people have claimed: they glow and flicker at night. The four
// nearest also light up what's around them (a fixed set of lights, so nothing recompiles).
const LANTERN = { frame: new THREE.MeshStandardMaterial({ color: 0x2b2620, roughness: 0.6, metalness: 0.4 }), geo: new THREE.BoxGeometry(0.16, 0.24, 0.16), cap: new THREE.ConeGeometry(0.13, 0.1, 4) };
const lanternLights = [0, 1, 2, 3].map(() => { const l = new THREE.PointLight(0xffa040, 0, 18, 1.5); scene.add(l); return l; });
function makeLantern(def, d) {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(LANTERN.geo, new THREE.MeshStandardMaterial({ color: 0xffd8a0, emissive: 0xff9a30, emissiveIntensity: 0, roughness: 0.3 }));
  const cap = new THREE.Mesh(LANTERN.cap, LANTERN.frame); cap.position.y = 0.17; cap.rotation.y = Math.PI / 4;
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.25), LANTERN.frame); hook.position.set(0, 0.24, -0.1);
  g.add(glass, cap, hook);
  // Beside the door, on the outside: the door's thin side faces out, away from the middle of the home.
  const cx = (d.minX + d.maxX) / 2, cz = (d.minZ + d.maxZ) / 2, thinX = d.maxX - d.minX < d.maxZ - d.minZ;
  const out = thinX ? Math.sign(cx - def.x) || 1 : Math.sign(cz - def.z) || 1, wide = thinX ? (d.maxZ - d.minZ) / 2 : (d.maxX - d.minX) / 2;
  const ox = thinX ? out * 0.28 : wide + 0.3, oz = thinX ? wide + 0.3 : out * 0.28;
  g.position.set(cx + ox, (d.y0 || ground(cx, cz)) + Math.min(2.0, d.h + 0.1), cz + oz);
  g.rotation.y = thinX ? (out > 0 ? -Math.PI / 2 : Math.PI / 2) : (out > 0 ? Math.PI : 0);
  g.userData = { glass, seed: Math.random() * 100 };
  g.visible = false;
  return g;
}
function updateLanterns(now) {
  const night = state.env?.state.night ?? 0, list = [];
  for (const [, v] of houseVis) {
    const L = v.lantern;
    if (!L?.visible) continue;
    const t = now / 1000 + L.userData.seed;
    const flick = 0.78 + 0.12 * Math.sin(t * 7.3) + 0.07 * Math.sin(t * 17.1 + 1.3) + 0.05 * Math.sin(t * 31.7);
    L.userData.glass.material.emissiveIntensity = (0.2 + 5 * night) * flick;
    L.userData.flick = flick;
    if (night > 0.05) list.push([L.position.distanceToSquared(camera.position), L]);
  }
  list.sort((a, b) => a[0] - b[0]);
  lanternLights.forEach((l, i) => {
    const e = list[i];
    if (!e || e[0] > 90 * 90) { l.intensity = 0; return; }
    l.position.copy(e[1].position); l.position.y -= 0.05;
    l.intensity = 40 * night * e[1].userData.flick;
  });
}
function syncHouses(list) {
  const seen = new Set();
  for (const h of list) {
    seen.add(h.id);
    state.houseState.set(h.id, h);
    let v = houseVis.get(h.id);
    const def = state.map.houses[h.id];
    if (!v) {
      const d = def.door;
      let door;
      if (def.kind === 'vehicle') door = vehicleDoor(def, d);
      else {
        door = new THREE.Mesh(new THREE.BoxGeometry(d.maxX - d.minX, d.h, d.maxZ - d.minZ), doorMat.clone());
        door.position.set((d.minX + d.maxX) / 2, d.y0 + d.h / 2, (d.minZ + d.maxZ) / 2);
        door.castShadow = true;
      }
      const label = makeLabel('', 0.012);
      label.position.set(def.x, ground(def.x, def.z) + (def.kind === 'vehicle' ? 4.6 : def.kind === 'room' ? 6 : 5.2), def.z);
      scene.add(door, label);
      const lantern = makeLantern(def, d);
      scene.add(lantern);
      houseVis.set(h.id, (v = { door, label, lantern }));
    }
    const f = h.max ? h.hp / h.max : 0;
    v.door.visible = h.hp > 0 && !h.open;
    v.lantern.visible = (!!h.owner || !!globalThis.__dzAllLanterns) && h.hp > 0;   // someone lives here: a lantern by the door (tests: all)
    if (v.door.userData.paint) v.door.userData.panel.material.color.copy(v.door.userData.paint).lerp(DOOR_DAMAGED, 0.85 * (1 - f));   // a vehicle's own back door, scorched as it's beaten in
    else v.door.material.color.setRGB(0.35 + 0.5 * (1 - f), 0.37 * f + 0.05, 0.4 * f + 0.05 + h.upg.door * 0.08);
    const own = h.id === state.houseId;
    const status = h.hp <= 0 ? 'BREACHED' : h.open ? 'open' : `${Math.round(f * 100)}%`;
    const kn = homeKindName(def);
    setLabel(v.label, h.owner ? `${own ? 'YOUR ' + kn.toUpperCase() : `${h.owner}'s ${kn.toLowerCase()}`} · Lv${h.hl} · ${status}` : `Unclaimed ${kn.toLowerCase()} · plant a claim marker`, own ? '#7dff9a' : !h.owner ? '#c9c9c9' : h.hp <= 0 ? '#ff6b6b' : '#ffd29a');
  }
  for (const [id, v] of houseVis) if (!seen.has(id)) { scene.remove(v.door, v.label, v.lantern); v.door.traverse((o) => o.geometry?.dispose()); houseVis.delete(id); state.houseState.delete(id); }
  state.doorSolids = list.filter((h) => h.hp > 0 && !h.open).map((h) => ({ ...state.map.houses[h.id].door, type: 'door' }));
}

function syncTerminals(list) {
  const seen = new Set();
  for (const [id, ready] of list) {
    seen.add(id);
    state.termState.set(id, !!ready);
    let mesh = termVis.get(id);
    if (!mesh) {
      const t = state.map.terminals[id];
      mesh = new THREE.Mesh(termGeo, new THREE.MeshStandardMaterial({ color: 0x23303a, emissive: 0x16c2ff, emissiveIntensity: 0.7 }));
      mesh.position.set(t.x, state.map.towns[t.townId].elev + 0.75, t.z - 0.17);
      scene.add(mesh);
      termVis.set(id, mesh);
    }
    mesh.material.emissive.setHex(ready ? 0x16c2ff : 0x552222);
  }
  for (const [id, mesh] of termVis) if (!seen.has(id)) { scene.remove(mesh); mesh.material.dispose(); termVis.delete(id); state.termState.delete(id); }
}

function syncDrops() {
  const seen = new Set(state.drops.map((d) => d.id));
  for (const d of state.drops) {
    if (dropVis.has(d.id)) continue;
    const g = new THREE.Group();
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 1.4), new THREE.MeshStandardMaterial({ color: 0x3b5a8a, emissive: 0x112244 }));
    crate.position.y = 0.5;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.4, 60, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.y = 30;
    g.add(crate, beam);
    g.userData = { crate, drop: d };
    g.position.set(d.x, ground(d.x, d.z), d.z);
    scene.add(g);
    dropVis.set(d.id, g);
  }
  for (const [id, g] of dropVis) if (!seen.has(id)) { scene.remove(g); dropVis.delete(id); }
}

// ---- the hot zone: a faint red wall around it you can see from far off, glowing crates, a green pickup beam
const hotVis = { group: null, id: null, crates: new Map() };
const hotCrateMat = new THREE.MeshStandardMaterial({ color: 0x5a1a10, emissive: 0xff3b1f, emissiveIntensity: 0.6 });
function syncHotZone() {
  const z = state.hotZone;
  if (hotVis.group && (!z || z.id !== hotVis.id)) { scene.remove(hotVis.group); hotVis.group = null; hotVis.crates.clear(); }
  if (!z) return;
  if (!hotVis.group) {
    const g = new THREE.Group(), y0 = ground(z.x, z.z);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(z.radius, z.radius, 60, 96, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff4a1f, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    wall.position.set(z.x, y0 + 20, z.z);
    g.add(wall);
    scene.add(g);
    hotVis.group = g; hotVis.id = z.id; hotVis.wall = wall;
  }
  hotVis.wall.material.opacity = z.open ? 0.22 : 0.1;
  for (const c of z.crates) {
    let m = hotVis.crates.get(c.id);
    if (!m) {
      m = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.9), hotCrateMat);
      box.position.y = 0.45;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.35, 40, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      beam.position.y = 20;
      m.add(box, beam);
      m.position.set(c.x, ground(c.x, c.z), c.z);
      hotVis.group.add(m);
      hotVis.crates.set(c.id, m);
    }
    m.visible = !c.opened;
  }
  if (z.extract && !hotVis.pickup) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.9, 80, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0x5dff8a, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.set(z.extract.x, ground(z.extract.x, z.extract.z) + 40, z.extract.z);
    hotVis.group.add(beam);
    hotVis.pickup = beam;
  }
  if (!z.extract) hotVis.pickup = null;
}
const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function hotZoneLine() {
  const z = state.hotZone;
  if (!z) return '';
  const now = Date.now(), d = distText(Math.hypot(z.x - state.x, z.z - state.z)), left = z.crates.filter((c) => !c.opened).length;
  return z.open ? `🔥 Hot zone: ${z.name} · ${d} · closes in ${mmss(z.closesAt - now)} · ${left} crate${left === 1 ? '' : 's'} left` : `🔥 Hot zone: ${z.name} · ${d} · opens in ${mmss(z.opensAt - now)}`;
}
const carryingHot = () => { const me = state.me; return !!me && (!!me.hotLoose || ['primary', 'primary2', 'secondary', 'armor'].some((s) => me.inv[s]?.hot) || me.inv.pack.some((i) => i.hot)); };

// ---- helicopter extraction: red flare smoke at the pickup, then a helicopter that comes down to it
const extractVis = new Map();   // id -> group
const heliMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 0.7 });
function makeHelicopter() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.4, 6.5), heliMat); body.position.y = 1.4;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 6), heliMat); tail.position.set(0, 2, -6);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, 1.2), heliMat); fin.position.set(0, 2.8, -8.6);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 1.4), new THREE.MeshStandardMaterial({ color: 0x8fb7c9, metalness: 0.5, roughness: 0.2 })); glass.position.set(0, 1.9, 3.1);
  const rotor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.12, 0.5), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
  rotor.position.y = 3.05;
  const rotor2 = rotor.clone(); rotor2.rotation.y = Math.PI / 2;
  const skids = [-1.1, 1.1].map((x) => { const k = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 5.5), heliMat); k.position.set(x, 0, 0); return k; });
  g.add(body, tail, fin, glass, rotor, rotor2, ...skids);
  g.userData.rotors = [rotor, rotor2];
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
function syncExtracts(pickup) {
  const seen = new Set(state.extracts.map((e) => e.id));
  for (const e of state.extracts) {
    if (extractVis.has(e.id)) continue;
    const g = new THREE.Group();
    const smoke = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.4, 40, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.35, depthWrite: false }));
    smoke.position.y = 20;
    const flare = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4040 }));
    flare.position.y = 0.3;
    const zone = new THREE.Mesh(new THREE.RingGeometry(EXTRACT.radius - 0.4, EXTRACT.radius, 64), new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    zone.rotation.x = -Math.PI / 2; zone.position.y = 0.25;
    const heli = makeHelicopter();
    heli.visible = false;
    g.add(smoke, flare, zone, heli);
    g.userData = { e, smoke, flare, heli };
    g.position.set(e.x, ground(e.x, e.z), e.z);
    scene.add(g);
    extractVis.set(e.id, g);
  }
  for (const [id, g] of extractVis) {
    if (seen.has(id)) continue;
    // A finished pickup: the helicopter lifts off and flies away before it disappears.
    if (pickup && Math.hypot(pickup.x - g.userData.e.x, pickup.z - g.userData.e.z) < 1) { g.userData.leaving = performance.now(); g.userData.heli.visible = true; g.userData.smoke.visible = g.userData.flare.visible = false; g.children[2].visible = false; continue; }
    scene.remove(g); extractVis.delete(id);
  }
}
function animateExtracts() {
  const now = Date.now();
  for (const [id, g] of extractVis) {
    const { e, smoke, flare, heli } = g.userData;
    for (const r of heli.userData.rotors) r.rotation.y += 0.6;
    if (g.userData.leaving) {
      const t = (performance.now() - g.userData.leaving) / 1000;
      heli.position.set(0, 2 + t * t * 4, t * t * 6);
      if (t > 8) { scene.remove(g); extractVis.delete(id); }
      continue;
    }
    smoke.material.opacity = 0.25 + 0.12 * Math.sin(now / 200);
    flare.scale.setScalar(0.8 + 0.4 * Math.random());
    // The helicopter appears 15 seconds out and comes down to hover over the flare.
    const left = (e.arrivesAt - now) / 1000;
    heli.visible = left < 15;
    if (heli.visible) { const f = Math.max(0, left) / 15; heli.position.set(-f * 120, 4 + f * 70, -f * 60); heli.rotation.y = Math.atan2(1, 0.5); }
  }
}
// Helipad markings at every landing zone, so you can find where to call a pickup.
const lzVis = [];
function buildLandingPads() {
  const padMat = new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  for (const lz of state.map.landingZones) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.4, 6, 40), padMat); ring.rotation.x = -Math.PI / 2;
    const h1 = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 4), padMat), h2 = h1.clone(), h3 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), padMat);
    for (const m of [h1, h2, h3]) m.rotation.x = -Math.PI / 2;
    h1.position.x = -1.2; h2.position.x = 1.2;
    g.add(ring, h1, h2, h3);
    g.position.set(lz.x, ground(lz.x, lz.z) + 0.15, lz.z);
    scene.add(g);
    lzVis.push(g);
  }
}

function syncObjectives(list) {
  const seen = new Set(list.map((o) => o.id));
  for (const o of list) {
    if (objVis.has(o.id)) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.7, 0.8), new THREE.MeshStandardMaterial({ color: 0xffc53d, emissive: 0x553300 }));
    mesh.position.set(o.x, ground(o.x, o.z) + 0.35, o.z);
    scene.add(mesh);
    objVis.set(o.id, mesh);
  }
  for (const [id, mesh] of objVis) if (!seen.has(id)) { scene.remove(mesh); objVis.delete(id); }
  state.objectives = list;
}

function makeLabel(text, scale = 0.01, color = '#fff') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(512 * scale, 96 * scale, 1);
  s.userData = { c, tex, text: null };
  setLabel(s, text, color);
  return s;
}
function setLabel(s, text, color = '#fff') {
  const key = text + color;
  if (s.userData.text === key) return;
  s.userData.text = key;
  const g = s.userData.c.getContext('2d');
  g.clearRect(0, 0, 512, 96);
  if (!text) { s.userData.tex.needsUpdate = true; return; }
  // Name tags: sharp text on a solid dark chip (no outline or glow around the letters).
  g.font = "700 40px 'Atkinson Hyperlegible', 'Segoe UI', sans-serif";
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = Math.min(500, g.measureText(text).width + 36);
  g.fillStyle = 'rgba(22, 26, 34, 0.92)';
  g.beginPath(); g.roundRect(256 - w / 2, 18, w, 62, 16); g.fill();
  g.fillStyle = color; g.fillText(text, 256, 50);
  s.userData.tex.needsUpdate = true;
}

// ------------------------------------------------------------------ characters
function makeTruck() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 6), new THREE.MeshStandardMaterial({ color: 0x4b5a3a, roughness: 0.8 }));
  body.position.set(0, 1.8, -0.8);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 2), new THREE.MeshStandardMaterial({ color: 0x3e4a30 }));
  cab.position.set(0, 1.5, 3);
  g.add(body, cab);
  for (const [x, z] of [[-1.2, 2.6], [1.2, 2.6], [-1.2, -2.4], [1.2, -2.4], [-1.2, -0.6], [1.2, -0.6]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10), new THREE.MeshStandardMaterial({ color: 0x151515 }));
    wh.rotation.z = Math.PI / 2; wh.position.set(x, 0.5, z);
    g.add(wh);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(g);
  return g;
}
/** Simple wildlife: a body, legs and a head; hogs are low and dark, deer tall and tan, dogs small. */
function makeAnimal(kind) {
  const g = new THREE.Group();
  if (kind === 'gator') {
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f3a24, roughness: 0.95 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.28, 1.9), mat); body.position.y = 0.2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.75), mat); head.position.set(0, 0.17, 1.3);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 1.4), mat); tail.position.set(0, 0.15, -1.6);
    g.add(body, head, tail);
    for (const [x, z] of [[-0.38, 0.6], [0.38, 0.6], [-0.38, -0.6], [0.38, -0.6]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.22), mat); leg.position.set(x, 0.07, z); g.add(leg); }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.userData = { body, head, animal: true };
    scene.add(g);
    attachAnimal(g, 'gator');
    return g;
  }
  if (kind === 'boar') { const m = makeAnimal('hog'); m.scale.setScalar(1.8); return m; }
  const deer = kind === 'deer', dog = kind === 'dog';
  const mat = new THREE.MeshStandardMaterial({ color: deer ? 0x8a6440 : dog ? 0x6b5236 : 0x3a302a, roughness: 0.9 });
  if (dog) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.8), mat); body.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.32), mat); head.position.set(0, 0.72, 0.48);
    g.add(body, head);
    for (const [x, z] of [[-0.11, 0.3], [0.11, 0.3], [-0.11, -0.3], [0.11, -0.3]]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.36, 0.07), mat); leg.position.set(x, 0.18, z); g.add(leg); }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(g);
    attachAnimal(g, 'dog');
    return g;
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(deer ? 0.45 : 0.55, 0.5, deer ? 1.3 : 1.1), mat);
  body.position.y = deer ? 1.0 : 0.55;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.28, deer ? 0.4 : 0.45), mat);
  head.position.set(0, deer ? 1.45 : 0.6, deer ? 0.75 : 0.7);
  g.add(body, head);
  for (const [x, z] of [[-0.15, 0.45], [0.15, 0.45], [-0.15, -0.45], [0.15, -0.45]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, deer ? 0.8 : 0.35, 0.09), mat);
    leg.position.set(x, deer ? 0.4 : 0.18, z * (deer ? 1 : 0.85));
    g.add(leg);
  }
  if (deer) for (const sx of [-0.1, 0.1]) { const a = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), new THREE.MeshStandardMaterial({ color: 0xd8cbb0 })); a.position.set(sx, 1.72, 0.7); g.add(a); }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.userData = { body, head, animal: true };
  scene.add(g);
  attachAnimal(g, deer ? 'deer' : 'hog');
  return g;
}

// ------------------------------------------------------------------ boats and rides
const boatVis = new Map();   // id -> { mesh, data }
function makeBoat(type, color) {
  if (BOATS[type].land) return makeRide(type, color);
  const def = BOATS[type], g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: type === 'airboat' ? 0x46705c : 0x6b6f5a, roughness: 0.6, metalness: 0.3 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(def.wid, 0.12, def.len), mat); floor.position.y = 0.05;
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, def.len), mat); sideL.position.set(-def.wid / 2, 0.28, 0);
  const sideR = sideL.clone(); sideR.position.x = def.wid / 2;
  const bow = new THREE.Mesh(new THREE.BoxGeometry(def.wid, 0.5, 0.1), mat); bow.position.set(0, 0.32, def.len / 2);
  const stern = bow.clone(); stern.position.z = -def.len / 2;
  g.add(floor, sideL, sideR, bow, stern);
  let prop = null;
  if (type === 'airboat') {
    const cage = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.05, 6, 20), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.6 }));
    cage.position.set(0, 1.15, -def.len / 2 + 0.25);
    prop = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.14, 0.04), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    prop.position.copy(cage.position);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.5), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    seat.position.set(0, 0.55, -def.len / 2 + 1.1);
    g.add(cage, prop, seat);
  } else {
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.65, 0.4), new THREE.MeshStandardMaterial({ color: 0x1c1c1c }));
    motor.position.set(0, 0.45, -def.len / 2 - 0.18);
    g.add(motor);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const label = makeLabel('', 0.0042, '#ffd27a');
  label.position.y = 1.9;
  g.add(label);
  g.userData = { label, prop };
  scene.add(g);
  return g;
}
function makeRide(type, color) {
  const def = BOATS[type], g = buildRideModel(type, color);
  const label = makeLabel('', 0.0042, '#7dff9a');
  label.position.y = def.h + 0.9;
  g.add(label);
  g.userData.label = label;
  scene.add(g);
  return g;
}
function syncBoats(list) {
  const seen = new Set();
  for (const b of list) {
    seen.add(b.id);
    let v = boatVis.get(b.id);
    if (!v) { v = { mesh: makeBoat(b.type, b.c) }; v.mesh.position.set(b.x, b.y ?? 0, b.z); v.mesh.rotation.y = b.yaw; boatVis.set(b.id, v); }
    // For gliding between updates: when this one came, and how fast it turns.
    if (v.data && (v.data.x !== b.x || v.data.z !== b.z)) { const dt = (performance.now() - (v.at || 0)) / 1000; v.turn = dt > 0 && dt < 0.5 ? Math.atan2(Math.sin(b.yaw - v.data.yaw), Math.cos(b.yaw - v.data.yaw)) / dt : 0; }
    v.at = performance.now();
    v.data = b;
    const def = BOATS[b.type], name = def.name.toLowerCase();
    // Rides only say whose they are when they're yours (the prompt tells you the rest up close).
    if (def.land) setLabel(v.mesh.userData.label, b.mine ? `◆ ${b.w ? '' : 'Your '}${b.w ? def.name : name}` : '', '#7dff9a');
    else setLabel(v.mesh.userData.label, `${b.mine ? '◆ ' : ''}${b.owner ? `${b.owner}'s ${name}` : `Abandoned ${name}`}  ${b.hp}/${b.max}`, b.mine ? '#7dff9a' : '#ffd27a');
  }
  for (const [id, v] of boatVis) if (!seen.has(id)) { scene.remove(v.mesh); boatVis.delete(id); }
}
const rideEnv = () => ({ solids: (x, z, r) => solidsNear(x, z, r), roadsNear: state.map.roadsNear });
function animateBoats(dt, now) {
  for (const [id, v] of boatVis) {
    const local = state.boat && state.boat.id === id ? state.boat : null;
    const t = local || v.data, g = v.mesh, k = Math.min(1, dt * 10), def = BOATS[v.data.type];
    const px = g.position.x, pz = g.position.z;
    if (local) { g.position.x = t.x; g.position.z = t.z; g.rotation.y = t.yaw; }
    else if (def.land && t.sp) {
      // Someone else driving: carry on from their last update at their speed and turn (updates come
      // ten times a second; easing toward each made a fast car hop), and drift onto the real track.
      const since = Math.min(0.3, (performance.now() - (v.at || 0)) / 1000), yaw = t.yaw + (v.turn || 0) * since;
      const fwd = (t.rev ? -1 : 1) * t.sp * since, px = t.x + Math.sin(yaw) * fwd, pz = t.z + Math.cos(yaw) * fwd, kk = Math.min(1, dt * 12);
      g.position.x += (px - g.position.x) * kk; g.position.z += (pz - g.position.z) * kk;
      let dy = yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); g.rotation.y += dy * kk;
    } else {
      g.position.x += (t.x - g.position.x) * k; g.position.z += (t.z - g.position.z) * k;
      let dy = t.yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); g.rotation.y += dy * k;
    }
    const u = g.userData;
    if (def.land) {
      // Sit on the ground (or a bridge deck), tipped to the slope; wheels turn with the distance covered.
      const gy = local && local.y !== undefined ? local.y : v.data.y ?? ground(g.position.x, g.position.z);
      g.position.y += (gy - g.position.y) * (Math.abs(gy - g.position.y) > 3 ? 1 : Math.min(1, dt * 14));
      const onGround = Math.abs(gy - ground(g.position.x, g.position.z)) < 0.4;
      const fx = Math.sin(g.rotation.y), fz = Math.cos(g.rotation.y), hl = def.len * 0.4, hw = Math.max(0.3, def.wid * 0.4);
      const pitch = onGround ? Math.atan2(ground(g.position.x - fx * hl, g.position.z - fz * hl) - ground(g.position.x + fx * hl, g.position.z + fz * hl), hl * 2) : 0;
      const roll = onGround && !def.lean ? Math.atan2(ground(g.position.x + fz * hw, g.position.z - fx * hw) - ground(g.position.x - fz * hw, g.position.z + fx * hw), hw * 2) : 0;
      g.rotation.x += (pitch - g.rotation.x) * Math.min(1, dt * 8);
      const moved = Math.hypot(g.position.x - px, g.position.z - pz), fwd = (g.position.x - px) * fx + (g.position.z - pz) * fz >= 0 ? 1 : -1;
      const speed = dt > 0 ? moved / dt : 0;
      for (const w of u.wheels) w.pivot.rotation.x += (moved * fwd) / w.r;
      // Bikes lean into turns.
      let turn = 0;
      if (def.lean) { const dyaw = Math.atan2(Math.sin(g.rotation.y - (u.lastYaw ?? g.rotation.y)), Math.cos(g.rotation.y - (u.lastYaw ?? g.rotation.y))); turn = dt > 0 ? (dyaw / dt) * Math.min(1, speed / 8) : 0; }
      u.steer = Math.max(-1, Math.min(1, (u.steer || 0) * 0.85 + (dt > 0 ? -Math.atan2(Math.sin(g.rotation.y - (u.lastYaw ?? g.rotation.y)), Math.cos(g.rotation.y - (u.lastYaw ?? g.rotation.y))) / dt * 0.15 * 0.6 : 0)));
      u.lastYaw = g.rotation.y;
      u.lean += (Math.max(-0.45, Math.min(0.45, turn * 0.35)) - u.lean) * Math.min(1, dt * 6);
      g.rotation.z += ((def.lean ? u.lean : roll) - g.rotation.z) * Math.min(1, dt * 8);
      // A horse walks, trots, gallops: legs swing with its speed.
      if (u.legs.length) {
        u.gait += dt * (2 + Math.min(14, speed) * 0.9) * (speed > 0.3 ? 1 : 0);
        const amp = Math.min(0.75, speed / 10 + (speed > 0.3 ? 0.2 : 0));
        for (const l of u.legs) {
          const ph = u.gait + (l.front ? 0 : Math.PI) + (l.side > 0 ? Math.PI / 2 : 0);
          l.hip.rotation.x = Math.sin(ph) * amp;
          l.knee.rotation.x = Math.max(0, -Math.cos(ph)) * amp * (l.front ? -1.2 : 1.2);
        }
        u.body.position.y = speed > 0.3 ? Math.abs(Math.sin(u.gait)) * Math.min(0.08, speed * 0.008) : 0;
      }
      u.label.visible = !!v.data.mine && state.me?.boat?.id !== id && camera.position.distanceTo(g.position) > 6;
      continue;
    }
    g.position.y = Math.sin(now / 700 + g.position.x) * 0.04;
    if (u.prop) u.prop.rotation.z += dt * ((local ? Math.abs(local.speed) > 0.5 : v.data.fast) ? 40 : 2);
    u.label.visible = state.me?.boat?.id !== id && camera.position.distanceTo(g.position) > 5;
  }
}
/** Where you'd be sitting: your own ride is predicted locally, anyone else's follows the server. */
function boatSeat(me) {
  if (state.boat && me.boat.seat === 0) return seatPos(state.boat, 0);
  const v = boatVis.get(me.boat.id);
  return v ? seatPos({ type: v.data.type, x: v.mesh.position.x, z: v.mesh.position.z, yaw: v.mesh.rotation.y }, me.boat.seat) : null;
}
/** Where a rider's feet go (the character's origin) in boat or ride `id`. */
/** Where a driver's hands go, from the seat: a wheel ahead of the chest, handlebars wide and lower,
 *  reins held close. `half`: how far apart the hands are; `turn`: how far a wheel turns them. */
const RIDE_GRIP = { wheel: { fwd: 0.42, up: 0.42, half: 0.18, turn: 0.6 }, bars: { fwd: 0.5, up: 0.32, half: 0.3, turn: 0.25 }, reins: { fwd: 0.42, up: 0.18, half: 0.1, turn: 0.1 }, none: null };
function rideFeet(id) {
  const v = boatVis.get(id);
  if (!v || !BOATS[v.data.type].land) return 0.15;
  return riderFeet(v.data.type, v.mesh.position.y);
}
const myRide = () => { const id = state.me?.boat?.id; const v = id && boatVis.get(id); return v ? BOATS[v.data.type] : null; };
const canStepOut = () => { if (myRide()?.land) return true; for (let r = 2; r <= BOAT_RULES.exitRange; r += 2) for (let a = 0; a < 16; a++) if (ground(state.x + Math.cos(a * Math.PI / 8) * r, state.z + Math.sin(a * Math.PI / 8) * r) > -0.6) return true; return false; };
function boatHud(pkey = '') {
  const me = state.me;
  if (!me?.boat) return '';
  const v = boatVis.get(me.boat.id);
  if (!v) return '';
  const def = BOATS[v.data.type], driving = me.boat.seat === 0;
  const mph = Math.round(Math.abs((state.boat && driving ? state.boat.speed : 0) || 0) * 2.237);
  const steer = driving ? (state.inputMode === 'pad' ? 'Left stick: gas, brake and steer · ' : state.inputMode === 'touch' ? '' : 'W/S gas and brake · A/D steer · ') : '';
  if (def.land) {
    const hp = v.data.hp < v.data.max ? ` · ${def.animal ? 'health' : 'damage'} ${Math.round((v.data.hp / v.data.max) * 100)}%` : '';
    return `${def.icon} ${def.name}${driving ? ` · <b>${mph} mph</b>` : ' · passenger'}${hp} <small>${steer}${def.hold && driving ? `${glyph('Tab')} ${def.animal ? 'saddlebags' : 'trunk'} · ` : ''}</small>${pkey || `<kbd>${glyph('E')}</kbd>`}get off`;
  }
  return `🚤 ${def.name}${driving ? ` · ${mph} mph` : ' · passenger'} · hull ${v.data.hp}/${v.data.max} <small>${steer}${glyph('Tab')} hold · steer to the bank and ${glyph('E')} to get out</small>`;
}

// ------------------------------------------------------------------ characters
// A low-poly person: legs with knees and boots, jacket, vest, belt, backpack, a head with a hat, and
// both hands on the gun. Clothes, skin and hat come from the name, so everyone looks a bit different;
// the vest colour says who they are (you blue, other players rust, rogues dark with a red visor band,
// contacts teal). Parts hang from joints so the walk, crouch, seat and prone poses can bend them.
const CHAR_GEO = new Map(), CHAR_MAT = new Map();
// Character parts are rounded boxes, smoothly shaded: bodies, not blocks.
const cbox = (w, h, d) => { const k = `${w},${h},${d}`; if (!CHAR_GEO.has(k)) CHAR_GEO.set(k, new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.42)); return CHAR_GEO.get(k); };
const cmat = (color, basic = false) => { const k = `${color}${basic ? 'b' : ''}`; if (!CHAR_MAT.has(k)) CHAR_MAT.set(k, basic ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness: 0.85 })); return CHAR_MAT.get(k); };
const SKIN = [0xf1c8a5, 0xd9a47c, 0xb57c55, 0x8d5a3b, 0x5f3b26];
const JACKET = [0x4f5a3a, 0x6b5a41, 0x3e4a55, 0x5b3f33, 0x6f6a5c, 0x394236, 0x7a6248];
const PANTS = [0x3a3f45, 0x4a4334, 0x2f3a2c, 0x55504a, 0x40362c];
const HATS = ['cap', 'helmet', 'boonie', 'beanie', 'none'];
const VEST = { self: 0x2f5d8c, player: 0x9a4f22, bot: 0x25202b, contact: 0x2a6f7a };
function nameHash(s) { let h = 2166136261; for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }

// Organic parts for people: capsules for limbs (thicker at the top), a shaped torso, rounded hands.
const ccap = (r, len, r2 = r) => {
  const k = `cap${r},${len},${r2}`;
  if (!CHAR_GEO.has(k)) {
    const geo = new THREE.CapsuleGeometry(r, len, 4, 12);
    if (r2 !== r) {   // taper: shrink the lower end toward r2
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i), f = 1 + (r2 / r - 1) * Math.max(0, Math.min(1, (len / 2 - y) / len)); p.setX(i, p.getX(i) * f); p.setZ(i, p.getZ(i) * f); }
      geo.computeVertexNormals();
    }
    CHAR_GEO.set(k, geo);
  }
  return CHAR_GEO.get(k);
};
/** A torso turned on a lathe from a profile (radius by height), squashed front to back. */
const clathe = (key, prof, depth) => {
  const k = `lathe${key}`;
  if (!CHAR_GEO.has(k)) { const geo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 18); geo.scale(1, 1, depth); geo.computeVertexNormals(); CHAR_GEO.set(k, geo); }
  return CHAR_GEO.get(k);
};
const csph = (r) => { const k = `sph${r}`; if (!CHAR_GEO.has(k)) CHAR_GEO.set(k, new THREE.SphereGeometry(r, 14, 10)); return CHAR_GEO.get(k); };
const TORSO = [[0.0, 0.0], [0.15, 0.0], [0.16, 0.08], [0.15, 0.2], [0.18, 0.36], [0.205, 0.5], [0.19, 0.57], [0.11, 0.62], [0.0, 0.63]];
const VEST_SHAPE = [[0.0, 0.18], [0.19, 0.18], [0.215, 0.32], [0.225, 0.5], [0.2, 0.56], [0.0, 0.57]];
const PLAYER_OUTFITS = ['swat1', 'swat2', 'james', 'liza', 'remy'];
/**
 * A person: a rigged model (client/people.js) in a Group whose +Z is forward and y = 0 the soles.
 * The gun is held on a pivot that follows the chest and the aim; slung guns and the holster hang off
 * the back and the right thigh. The outfit and skin come from the name, so everyone looks a bit
 * different and always the same to everyone: Rogues in black or punk gear, Contacts in work clothes.
 */
function makeCharacter(kind, name) {
  const g = new THREE.Group();
  const h = nameHash(kind === 'self' ? (localStorage.getItem('dz_name') || 'you') : name), pick = (list, n) => list[(h >>> n) % list.length];
  const joint = (x, y, z, parent) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
  const aimPivot = joint(0, 1.3, 0, g);
  const gun = joint(-0.17, -0.06, 0.24, aimPivot);
  // Slung guns: across the back, diagonally, muzzles over a shoulder.
  const sling = [joint(-0.02, 1.25, -0.2, g), joint(0.02, 1.22, -0.23, g)];
  for (const [i, sl] of sling.entries()) { sl.rotation.order = 'ZXY'; sl.rotation.set(-Math.PI / 2, 0, i ? -1.0 : 1.0); }
  const thigh = joint(-0.1, 0.9, 0, g);
  const holster = joint(-0.1, -0.12, 0.02, thigh);
  holster.rotation.x = Math.PI / 2;
  g.userData = { gun, aimPivot, sling, holster, stowedKey: '', phase: 0, last: null, lastT: performance.now() };
  if (kind !== 'self') {
    const label = makeLabel(name, kind === 'contact' ? 0.006 : 0.0042, kind === 'bot' ? '#ff6b6b' : '#ffb27a');
    label.position.y = 2.25;
    g.add(label);
    const barBg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), new THREE.MeshBasicMaterial({ color: 0xff3b3b }));
    const armorBar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.05), new THREE.MeshBasicMaterial({ color: 0x5aa8ff }));
    const bars = new THREE.Group();
    bars.add(barBg, bar, armorBar);
    bar.position.z = 0.001; armorBar.position.set(0, 0.08, 0.001);
    bars.position.y = 2.02;
    g.add(bars);
    Object.assign(g.userData, { label, bar, armorBar, bars });
  }
  scene.add(g);
  // Rogues all in black tactical gear; Contacts in street clothes; players any of the others.
  const outfit = kind === 'bot' ? 'swat3' : kind === 'contact' ? pick(['james', 'liza', 'remy'], 5) : pick(PLAYER_OUTFITS, 5);
  attachPerson(g, outfit, {
    onReady: (rig) => {
      const back = hangFrom(rig, 'Chest', g, [0, 0.95, 0]);
      for (const sl of sling) { sl.position.y -= 0.95; back.add(sl); }
      hangFrom(rig, 'UpperLegR', g, [-0.1, 0.9, 0]).add(holster);
      g.remove(thigh);
      g.userData.rig = rig;
      if (g.userData.cloak != null && g.userData.cloak < 1) { const c = g.userData.cloak; g.userData.cloak = null; setCloak(g, c); }
    },
    onFail: () => { g.remove(thigh); buildBlockBody(g, kind, name, h); },
  });
  return g;
}
/** The old hand-built body: only if a person's model can't be loaded. Moves the gun, sling and
 *  holster joints onto it. */
function buildBlockBody(g, kind, name, h) {
  const pick = (list, n) => list[(h >>> n) % list.length];
  const keep = g.userData;
  const skin = cmat(kind === 'bot' ? 0x6b5848 : pick(SKIN, 3)), jacket = cmat(kind === 'bot' ? 0x2b2a2e : pick(JACKET, 7)), pants = cmat(kind === 'bot' ? 0x1f1f22 : pick(PANTS, 11));
  const vest = cmat(VEST[kind] || VEST.player), boots = cmat(0x2a221b), dark = cmat(0x1b1d20), gear = cmat(0x3b3a30);
  const part = (geo, mat, x, y, z, parent) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  const joint = (x, y, z, parent) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
  // Hips and legs (y = 0 is the soles of the boots).
  const hips = joint(0, 0.95, 0, g);
  { const pelvis = part(csph(0.17), pants, 0, -0.03, 0, hips); pelvis.scale.set(1.15, 0.8, 0.85); }
  const legs = [1, -1].map((s) => {
    const thigh = joint(s * 0.1, -0.05, 0, hips);
    part(ccap(0.1, 0.28, 0.078), pants, 0, -0.22, 0, thigh);           // thigh, thicker at the hip
    const knee = joint(0, -0.46, 0, thigh);
    part(ccap(0.078, 0.27, 0.06), pants, 0, -0.2, 0, knee);            // shin
    const boot = part(cbox(0.13, 0.1, 0.26), boots, 0, -0.43, 0.04, knee);
    boot.scale.set(1, 1, 1);
    return { thigh, knee };
  });
  // Upper body: everything above the belt leans and turns together.
  const upper = joint(0, 0, 0, hips);
  { const belt = part(clathe('belt', [[0, 0], [0.165, 0], [0.17, 0.06], [0, 0.06]], 0.62), dark, 0, 0.04, 0, upper); belt.castShadow = false; }
  part(clathe('torso', TORSO, 0.62), jacket, 0, 0.06, 0, upper);                       // jacket: waist, chest, shoulders
  part(clathe('vest', VEST_SHAPE, 0.74), vest, 0, 0.06, 0, upper);                     // plate carrier
  for (const x of [-0.11, 0, 0.11]) part(cbox(0.085, 0.11, 0.05), gear, x, 0.33, 0.155, upper);   // mag pouches
  part(cbox(0.06, 0.08, 0.04), gear, 0.15, 0.5, 0.15, upper);                          // radio
  const pack = part(cbox(0.34, 0.42, 0.17), gear, 0, 0.4, -0.2, upper);                // backpack
  pack.scale.set(1, 1, 1);
  { const roll = part(ccap(0.06, 0.28), cmat(0x5a5040), 0, 0.64, -0.2, upper); roll.rotation.z = Math.PI / 2; }   // bedroll on top
  part(ccap(0.055, 0.05), skin, 0, 0.7, 0, upper);                                     // neck
  const head = joint(0, 0.8, 0, upper);
  const skull = new THREE.Mesh(csph(0.125), skin);
  skull.scale.set(1, 1.16, 1.06); skull.castShadow = true; head.add(skull);
  { const jaw = part(csph(0.1), skin, 0, -0.06, 0.025, head); jaw.scale.set(0.95, 0.72, 0.95); }
  part(csph(0.026), skin, 0, -0.005, 0.125, head);                                     // nose
  for (const sx of [-1, 1]) { const ear = part(csph(0.03), skin, sx * 0.125, 0, 0, head); ear.scale.set(0.5, 1, 0.8); }
  part(cbox(0.2, 0.05, 0.04), kind === 'bot' ? cmat(0xff2a2a, true) : dark, 0, 0.02, 0.12, head);   // shades (a red visor on rogues)
  const hat = kind === 'bot' ? 'beanie' : kind === 'contact' ? 'boonie' : pick(HATS, 17), hatMat = kind === 'self' ? vest : pick([jacket, dark, gear, pants], 19);
  if (hat === 'cap') { part(cbox(0.27, 0.1, 0.28), hatMat, 0, 0.11, 0, head); part(cbox(0.22, 0.025, 0.12), hatMat, 0, 0.07, 0.18, head); }
  else if (hat === 'helmet') { const hm = new THREE.Mesh(new THREE.SphereGeometry(0.165, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), hatMat); hm.position.y = 0.04; hm.castShadow = true; head.add(hm); }
  else if (hat === 'boonie') { part(cbox(0.27, 0.1, 0.27), hatMat, 0, 0.11, 0, head); part(cbox(0.42, 0.02, 0.42), hatMat, 0, 0.07, 0, head); }
  else if (hat === 'beanie') part(cbox(0.27, 0.14, 0.27), hatMat, 0, 0.11, -0.01, head);
  // Arms, posed holding the gun: right hand on the grip, left hand forward on the barrel.
  const arm = (s, sx, sz, ex) => {
    const shoulder = joint(s * 0.25, 0.56, 0, upper);
    shoulder.rotation.set(sx, 0, sz);
    part(csph(0.075), jacket, 0, 0.0, 0, shoulder);                                    // shoulder
    part(ccap(0.07, 0.19, 0.058), jacket, 0, -0.14, 0, shoulder);                        // upper arm
    const elbow = joint(0, -0.29, 0, shoulder);
    elbow.rotation.x = ex;
    part(ccap(0.058, 0.17, 0.048), jacket, 0, -0.13, 0, elbow);                         // forearm
    { const hand = part(csph(0.045), skin, 0, -0.3, 0.005, elbow); hand.scale.set(0.9, 1.15, 0.7); }
    return shoulder;
  };
  const arms = [arm(-1, -0.45, -0.05, -1.1), arm(1, -1.2, -0.75, -0.35)];
  const gun = keep.gun; upper.add(gun); gun.position.set(-0.3, 0.4, 0.22); keep.gunHome = null;
  // Guns you carry but aren't holding: two main guns slung crossways on the back, the sidearm in a
  // holster on the right thigh.
  const sling = keep.sling;
  sling.forEach((sl, i) => { upper.add(sl); sl.position.set(i ? 0.06 : -0.06, 0.4, i ? -0.37 : -0.33); });
  const holster = keep.holster; legs[1].thigh.add(holster); holster.position.set(-0.1, -0.12, 0.02);
  part(cbox(0.06, 0.16, 0.1), dark, -0.105, -0.16, 0.01, legs[1].thigh);   // the holster itself
  Object.assign(keep, { hips, legs, upper, head, arms });
}

/** Show the guns a character carries but isn't holding ([{ slot, a, parts, paint }]). */
function setCharacterStowed(g, list) {
  const key = JSON.stringify(list || []) + gunsReal();
  if (g.userData.stowedKey === key) return;
  setHolstered(g, false);
  g.userData.stowedKey = key;
  for (const m of [...g.userData.sling, g.userData.holster]) m.clear();
  let back = 0;
  for (const w of list || []) {
    const model = buildGunModel(w);
    if (w.slot === 'secondary') g.userData.holster.add(model);
    else if (back < 2) g.userData.sling[back++].add(model);
  }
}
/** Your own stowed guns, from your inventory. */
function stowedOf(me) { return ['primary', 'primary2', 'secondary'].filter((sl) => sl !== me.active && me.inv[sl]).map((sl) => ({ slot: sl, a: me.inv[sl].archetype, parts: me.inv[sl].parts, paint: me.inv[sl].paint })); }

// ------------------------------------------------------------------ gun effects: flash, empties, kick, reloads
/** A star-shaped muzzle flash, drawn once into a little texture. */
const FLASH_TEX = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,235,1)'); g.addColorStop(0.25, 'rgba(255,214,120,0.95)'); g.addColorStop(0.6, 'rgba(255,140,40,0.35)'); g.addColorStop(1, 'rgba(255,90,20,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  x.globalCompositeOperation = 'lighter'; x.fillStyle = 'rgba(255,220,150,0.8)';
  for (let k = 0; k < 6; k++) { x.save(); x.translate(32, 32); x.rotate(k * Math.PI / 3 + 0.2); x.beginPath(); x.moveTo(0, -3); x.lineTo(31, 0); x.lineTo(0, 3); x.fill(); x.restore(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const muzzleLight = new THREE.PointLight(0xffb060, 0, 10, 2);
scene.add(muzzleLight);
const SHELL = { brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 0.75, roughness: 0.35 }), hull: new THREE.MeshStandardMaterial({ color: 0xb02a1e, roughness: 0.6 }) };
const SHELL_GEO = { rifle: new THREE.CylinderGeometry(0.0055, 0.0055, 0.034, 7), pistol: new THREE.CylinderGeometry(0.0055, 0.0055, 0.02, 7), hull: new THREE.CylinderGeometry(0.0105, 0.0105, 0.055, 8) };
const FLASH_SIZE = { sidearm: 0.32, smg: 0.34, carbine: 0.42, lmg: 0.48, dmr: 0.55, shotgun: 0.62, launcher: 0.95 };
const gunFx = { flashes: [], bits: [] };
/** The gun a character is holding, and a point on it in the world. */
const heldGun = (g) => g?.userData?.gun?.children?.[0] || null;
/** A shot from a character's gun: flash at the muzzle, an empty flicked out the right, the gun kicks. */
function shotFx(g, archetype, sup = 0) {
  const gun = heldGun(g);
  if (!gun) return;
  const a = archetype || gun.userData.archetype || 'carbine';
  const mz = gun.localToWorld((gun.userData.muzzle || new THREE.Vector3(0, 0, 0.6)).clone());
  const size = (FLASH_SIZE[a] || 0.4) * (sup === 2 ? 0 : sup || gun.userData.suppressed ? 0.25 : 1);
  if (size > 0) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: FLASH_TEX, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, rotation: Math.random() * Math.PI }));
    sp.position.copy(mz); sp.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    scene.add(sp);
    gunFx.flashes.push({ obj: sp, life: 0.05 });
    if (a === 'launcher' && gun.userData.back) {   // the backblast out of the rear of the tube
      const bb = new THREE.Sprite(sp.material.clone()); bb.position.copy(gun.localToWorld(gun.userData.back.clone())); bb.scale.setScalar(0.8);
      scene.add(bb); gunFx.flashes.push({ obj: bb, life: 0.09 });
    }
    muzzleLight.position.copy(mz); muzzleLight.intensity = 5 * size;
  }
  g.userData.kick = 1; g.userData.firedAt = performance.now();
  if (a === 'launcher' || !gun.userData.eject) return;
  const shotgun = a === 'shotgun';
  const m = new THREE.Mesh(shotgun ? SHELL_GEO.hull : a === 'sidearm' ? SHELL_GEO.pistol : SHELL_GEO.rifle, shotgun ? SHELL.hull : SHELL.brass);
  m.position.copy(gun.localToWorld(gun.userData.eject.clone()));
  m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  const right = new THREE.Vector3(-1, 0, 0).transformDirection(gun.matrixWorld), back = new THREE.Vector3(0, 0, -1).transformDirection(gun.matrixWorld);
  const vel = right.multiplyScalar(2 + Math.random()).add(back.multiplyScalar(0.4)).add(new THREE.Vector3(0, 1.8 + Math.random() * 0.8, 0));
  scene.add(m);
  gunFx.bits.push({ obj: m, vel, spin: new THREE.Vector3(18 * Math.random() - 9, 18 * Math.random() - 9, 18 * Math.random() - 9), life: 2.6, rest: false, shell: true });
  if (gunFx.bits.length > 60) { const old = gunFx.bits.shift(); scene.remove(old.obj); }
}
/** A magazine dropping out of a gun during a reload. */
function dropMag(gun) {
  const mag = gun?.userData?.mag;
  if (!mag) return;
  const m = mag.clone(true);
  mag.getWorldPosition(m.position); mag.getWorldQuaternion(m.quaternion);
  scene.add(m);
  gunFx.bits.push({ obj: m, vel: new THREE.Vector3(0, -0.5, 0), spin: new THREE.Vector3(2 * Math.random() - 1, 0, 2 * Math.random() - 1), life: 6, rest: false });
}
/** Your own reload starts on screen the moment you press it. */
function startReloadFx() { if (!state.reloadAt || performance.now() - state.reloadAt > 6000) state.reloadAt = performance.now(); }
function updateGunFx(dt) {
  if (gunFx.hold) return;   // tests: freeze the effects to look at them
  for (let i = gunFx.flashes.length - 1; i >= 0; i--) { const f = gunFx.flashes[i]; f.life -= dt; if (f.life <= 0) { scene.remove(f.obj); f.obj.material.dispose(); gunFx.flashes.splice(i, 1); } }
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 80);
  for (let i = gunFx.bits.length - 1; i >= 0; i--) {
    const b = gunFx.bits[i];
    b.life -= dt;
    if (b.life <= 0) { scene.remove(b.obj); gunFx.bits.splice(i, 1); continue; }
    if (b.rest) continue;
    b.vel.y -= 9.8 * dt;
    b.obj.position.addScaledVector(b.vel, dt);
    b.obj.rotation.x += b.spin.x * dt; b.obj.rotation.y += b.spin.y * dt; b.obj.rotation.z += b.spin.z * dt;
    const gy0 = ground(b.obj.position.x, b.obj.position.z) + (b.shell ? 0.006 : 0.02);
    if (b.obj.position.y < gy0) {   // hit the ground: a small bounce, then it settles
      b.obj.position.y = gy0;
      if (Math.abs(b.vel.y) < 0.6) { b.rest = true; if (b.shell) b.obj.rotation.set(Math.PI / 2, b.obj.rotation.y, 0); }
      b.vel.y *= -0.32; b.vel.x *= 0.45; b.vel.z *= 0.45; b.spin.multiplyScalar(0.5);
    }
  }
}
/**
 * Sprinting: the gun in your hands goes over your back (or the pistol into its holster), and comes back
 * to your hands when you stop. Moves the model itself, so nothing is rebuilt.
 */
function setHolstered(g, on) {
  const u = g.userData, h = u.holstered;
  if (!on) { if (h) { if (h.model.parent === h.to) { u.gun.add(h.model); h.model.position.copy(h.pos); h.model.quaternion.copy(h.q); } u.holstered = null; } return; }
  if (h) return;
  const model = u.gun.children[0];
  if (!model) return;
  const pistol = /sidearm/.test(u.gunKey || '');
  const to = pistol ? (u.holster.children.length ? null : u.holster) : u.sling.find((sl) => !sl.children.length) || null;
  u.holstered = { model, to, pos: model.position.clone(), q: model.quaternion.clone() };
  if (to) to.add(model); else u.gun.remove(model);   // nowhere free on your back: out of sight
}
function setCharacterGun(g, gun) {
  const key = gunKey(gun);
  if (g.userData.gunKey === key) return;
  setHolstered(g, false);
  g.userData.gunKey = key;
  g.userData.gun.clear();
  if (gun) g.userData.gun.add(buildGunModel(gun));
}

/** A player as they were 110 ms ago, between the two updates either side: smooth, at the cost of a blink of delay. */
const SMOOTH_MS = 110;
function smoothed(r) {
  const b = r.buf, t = performance.now() - SMOOTH_MS;
  if (!b || b.length < 2 || t >= b[b.length - 1].t) return r.data;
  let i = b.length - 2;
  while (i > 0 && b[i].t > t) i--;
  const a = b[i], c = b[i + 1], f = Math.max(0, Math.min(1, (t - a.t) / Math.max(1, c.t - a.t)));
  let dy = c.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return { ...r.data, x: a.x + (c.x - a.x) * f, z: a.z + (c.z - a.z) * f, yaw: a.yaw + dy * f, alt: (a.alt || 0) + ((c.alt || 0) - (a.alt || 0)) * f, smooth: 1 };
}
/** The gun in the hands: kicks back and up with each shot and settles; during a reload it tips down and
 *  rolls, the support hand goes to the mag well, the old mag drops, a fresh one goes in, and back up. */
function gunPose(g, c, now, adt) {
  const u = g.userData, joint = u.gun, gun = heldGun(g), left = u.arms?.[1];
  if (!joint) return;
  u.gunHome ??= joint.position.clone();
  if (left && u.leftBase == null) u.leftBase = left.rotation.x;
  u.kick = Math.max(0, (u.kick || 0) - adt * 9);
  // Reload: c.rl is the ms left (others) or worked out from your own reload (you).
  const rl = c.rl || 0;
  if (rl > 0 && (!u.rlEnd || now > u.rlEnd || Math.abs(u.rlEnd - (now + rl)) > 350)) {
    if (!u.rlEnd || now > u.rlEnd) { u.rlDur = Math.max(400, rl); u.rlDropped = false; }
    u.rlEnd = now + rl;
  }
  let env = 0;
  if (u.rlEnd && now < u.rlEnd) {
    const f = 1 - (u.rlEnd - now) / u.rlDur;
    env = Math.sin(Math.min(1, Math.max(0, f)) * Math.PI);
    const a = gun?.userData.archetype;
    if (gun?.userData.mag && a !== 'shotgun' && a !== 'launcher') {
      if (f > 0.3 && !u.rlDropped) { u.rlDropped = true; dropMag(gun); gun.userData.mag.visible = false; }
      if (f > 0.62) gun.userData.mag.visible = true;
    }
    if (left) left.rotation.x = u.leftBase + 0.8 * Math.sin(Math.min(1, Math.max(0, (f - 0.15) / 0.7)) * Math.PI);
  } else {
    if (u.rlEnd && gun?.userData.mag) gun.userData.mag.visible = true;
    u.rlEnd = 0;
    if (left && u.leftBase != null) left.rotation.x += (u.leftBase - left.rotation.x) * Math.min(1, adt * 10);
  }
  // Reloading: the gun comes in toward the chest, nose up and rolled onto its side so the mag well faces you.
  joint.rotation.set(-0.12 * u.kick - 0.45 * env, 0.35 * env, 1.05 * env);
  joint.position.set(u.gunHome.x + 0.16 * env, u.gunHome.y + 0.04 * env, u.gunHome.z - 0.05 * u.kick - 0.08 * env);
}
function updateCharacterMesh(g, c, dt) {
  // On a ride: sit right on your seat, facing the way it points (no lag behind a fast car).
  const rv = c.boat && boatVis.get(c.boat), onRide = rv && BOATS[rv.data.type].land;
  if (onRide && c.seat != null) {
    const q = seatPos({ type: rv.data.type, x: rv.mesh.position.x, z: rv.mesh.position.z, yaw: rv.mesh.rotation.y }, c.seat);
    c = { ...c, x: q.x, z: q.z, yaw: c.aiming || c.aim ? c.yaw : rv.mesh.rotation.y, smooth: 1 };
  }
  // Interpolate toward the latest snapshot (already smoothed for other players: follow it exactly).
  const k = c.smooth ? 1 : Math.min(1, dt * 12);
  g.position.x += (c.x - g.position.x) * k;
  g.position.z += (c.z - g.position.z) * k;
  g.position.y = c.boat ? rideFeet(c.boat) : (c.y ?? ground(g.position.x, g.position.z)) + (c.alt || 0);
  // On a bike or a horse you lean (and tip on a slope) with it.
  g.rotation.z = onRide ? rv.mesh.rotation.z * (BOATS[rv.data.type].lean ? 1 : 0.6) : 0;
  let dy = c.yaw - g.rotation.y;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  g.rotation.y += dy * k;
  // Pose: walk cycle from how fast the character is really moving, crouch, sitting in a boat.
  const u = g.userData, now = performance.now(), adt = Math.min(0.1, (now - u.lastT) / 1000) || 0.016;
  u.lastT = now;
  const dxm = u.last ? g.position.x - u.last.x : 0, dzm = u.last ? g.position.z - u.last.z : 0;
  const speed = Math.hypot(dxm, dzm) / adt;
  u.last = { x: g.position.x, z: g.position.z };
  u.speed = (u.speed || 0) + (Math.min(8, speed) - (u.speed || 0)) * Math.min(1, adt * 10);
  const seated = !!c.boat && !(onRide && BOATS[rv.data.type].stand), crouched = !!c.crouch && !seated;
  if (u.rig) {
    // Which way you're really moving, against the way you face: forward, back, or strafing.
    const vk = Math.min(1, adt * 10), tooFar = speed > 25;   // a teleport isn't a step
    // Ahead and sideways in the person's own frame, each frame's step measured against the way they
    // face right now, then smoothed: turning while running stays running ahead (smoothing the step in
    // the world instead lagged behind the turn and read as a strafe for a moment, a hitch in the stride).
    const yaw = g.rotation.y, still = c.boat || c.downed || c.prone || c.air || c.slide || c.sl;   // (a slide is a crouch carried along, not running legs)
    const rf = tooFar ? 0 : (dxm * Math.sin(yaw) + dzm * Math.cos(yaw)) / adt, rs = tooFar ? 0 : (dxm * Math.cos(yaw) - dzm * Math.sin(yaw)) / adt;
    u.vf = (u.vf || 0) + (rf - (u.vf || 0)) * vk; u.vs = (u.vs || 0) + (rs - (u.vs || 0)) * vk;
    u.vx = u.vf * Math.sin(yaw) + u.vs * Math.cos(yaw); u.vz = u.vf * Math.cos(yaw) - u.vs * Math.sin(yaw);
    const fwd = u.vf, side = u.vs;
    const gunObj = heldGun(g), aimNow = !!(c.aim || c.aiming) || now - (u.firedAt || 0) < 900;   // shooting brings the gun up to the shoulder, as aiming does
    // Busy with something that takes a while (a locker, a flag, a flare…): the gun goes away for the pose.
    const act = c.act && !c.dead && !c.downed && !c.boat && !c.air && ACT_POSE[c.act] ? c.act : null;
    const kneel = act && ['pry', 'revive', 'cook'].includes(ACT_POSE[act]);
    const armed = !!gunObj && !act && !(seated && !aimNow) && !c.downed && !(c.air && c.air !== 'chute');
    u.gun.visible = armed;
    const cd = camera.position.distanceTo(g.position), detail = cd < 60 ? 1 : cd < 130 ? 0.3 : 0.1;
    const pitch = c.pitch || 0;
    const fine = animatePerson(g, u.rig, { speed: still || act ? 0 : Math.hypot(u.vx, u.vz), fwd: still ? 0 : fwd, side: still ? 0 : side, crouch: crouched || !!kneel, seated, armed, aiming: aimNow && !act, pitch: act ? 0 : pitch, detail }, adt);
    const acting = fine && updateAction(g, act, c.ap || 0, adt);
    if (!fine && u.props) updateAction(g, null, 0, adt);
    // The gun rides on the chest, turned with the aim; up to the eye when aiming down the sights.
    u.aimK = (u.aimK || 0) + ((aimNow ? 1 : 0) - (u.aimK || 0)) * Math.min(1, adt * 12);
    if (fine) chestAt(g, u.rig, u.aimPivot.position);
    else u.aimPivot.position.set(0, 1.3 - 0.36 * (crouched ? 1 : 0), 0);
    u.aimPivot.rotation.x = -Math.max(-1.1, Math.min(1.1, pitch));
    u.gunHome = (u.gunHome || new THREE.Vector3()).set(-0.17 + 0.07 * u.aimK, 0.17 * u.aimK, 0.26 - 0.02 * u.aimK);
    gunPose(g, c, now, adt);
    if (acting) {
      // (posed by updateAction)
    } else if (fine && armed) {
      const mag = u.rlEnd && now < u.rlEnd && gunObj.userData.mag ? gunObj.userData.mag.getWorldPosition(new THREE.Vector3()) : null;
      const f = mag ? 1 - (u.rlEnd - now) / u.rlDur : 0;
      handsOnGun(g, u.rig, gunObj, mag && f > 0.12 && f < 0.8 ? mag : null);
    } else if (fine && onRide && c.seat === 0) {
      // Driving: both hands on the wheel, the bars or the reins (in the ride's own frame, so they
      // tilt and lean with it). The wheel turns a little with the steering.
      const def = BOATS[rv.data.type], grip = RIDE_GRIP[def.grip || 'wheel'], [side, along] = def.seatAt[0];
      if (grip) {
        const turn = (rv.mesh.userData.steer || 0) * grip.turn;
        const at = (sx) => rv.mesh.localToWorld(new THREE.Vector3(side + sx * Math.cos(turn), def.seatH + grip.up + sx * Math.sin(turn) * 0.6, along + grip.fwd));
        handsOnBars(g, u.rig, at(-grip.half), at(grip.half));
      }
    }
  } else if (u.hips) {
  gunPose(g, c, now, adt);
  const moving = Math.min(1, u.speed / 3) * (c.boat || c.downed ? 0 : 1);
  u.phase += adt * (4 + u.speed * 1.6) * (moving > 0.05 ? 1 : 0);
  const kp = Math.min(1, adt * 12), ease = (o, key, v) => { o[key] += (v - o[key]) * kp; };
  ease(u.hips.position, 'y', seated ? 0.5 : crouched ? 0.62 : 0.95 + Math.abs(Math.sin(u.phase)) * 0.03 * moving);
  ease(u.upper.rotation, 'x', crouched ? 0.28 : seated ? 0.05 : 0.08 * moving);
  u.legs.forEach((l, i) => {
    const s = i ? -1 : 1, swing = Math.sin(u.phase) * s;
    const thigh = seated ? -1.5 : crouched ? -1.15 + (i ? 0.5 : 0) : swing * 0.6 * moving;
    const knee = seated ? 1.5 : crouched ? 1.7 - (i ? 0.6 : 0) : Math.max(0, -Math.sin(u.phase + 0.6) * s) * 0.9 * moving;
    ease(l.thigh.rotation, 'x', thigh);
    ease(l.knee.rotation, 'x', knee);
  });
  }
  g.visible = !c.dead;
  // Downed: lying on the ground.
  g.rotation.order = 'YXZ';
  g.rotation.x += ((c.downed || c.prone || c.air === 'fall' || c.air === 'suit' ? 1.35 : 0) - g.rotation.x) * (c.tiltK ?? k);
  if (c.air || u.canopy) {
    if (!u.canopy) { u.canopy = makeCanopy(); u.wings = makeWings(); g.add(u.canopy, u.wings); }
    u.canopy.visible = c.air === 'chute';
    u.wings.visible = c.air === 'suit';
  }
  if (g.userData.label) {
    const near = camera.position.distanceTo(g.position) < 4;
    g.userData.label.visible = !near;
    g.userData.bars.visible = !near;
  }
  if (g.userData.bars) {
    g.userData.bars.quaternion.copy(camera.quaternion);
    g.userData.bars.quaternion.premultiply(g.quaternion.clone().invert());
    const hpFrac = Math.max(0, c.hp / (c.maxHp || 100));
    g.userData.bar.scale.x = Math.max(0.001, hpFrac);
    g.userData.bar.position.x = -0.45 * (1 - hpFrac);
    const arFrac = c.maxArmor ? Math.max(0, c.armor / c.maxArmor) : 0;
    g.userData.armorBar.visible = arFrac > 0;
    g.userData.armorBar.scale.x = Math.max(0.001, arFrac);
    g.userData.armorBar.position.x = -0.45 * (1 - arFrac);
  }
}

/** A parachute canopy over the head, with lines down to the shoulders. */
function makeCanopy() {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3.2, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4f6b3a, side: THREE.DoubleSide, roughness: 0.9 }));
  dome.scale.y = 0.45;
  dome.position.y = 6.2;
  const pts = [];
  for (const [x, z] of [[-2.9, -1], [2.9, -1], [-2.9, 1], [2.9, 1], [0, -3], [0, 3]]) pts.push(new THREE.Vector3(Math.sign(x) * 0.25, 1.55, 0), new THREE.Vector3(x, 6.2, z));
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x222222 }));
  g.add(dome, lines);
  g.visible = false;
  return g;
}
/** The squirrel suit's webbing between arms and legs (the body lies flat, so it spans the body's plane). */
function makeWings() {
  const w = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.15, 0.04), new THREE.MeshStandardMaterial({ color: 0xc8541e, roughness: 0.8 }));
  w.position.y = 0.95;
  w.visible = false;
  return w;
}
/** The taxi flying on past after you jump. */
const flyBys = [];
function flyBy(h) {
  const heli = makeHelicopter();
  heli.position.set(h.x, ground(h.x, h.z) + (h.alt ?? SKY.alt) + 6, h.z);
  heli.rotation.y = h.yaw;
  scene.add(heli);
  flyBys.push({ heli, born: performance.now(), dx: Math.sin(h.yaw), dz: Math.cos(h.yaw) });
}
function animateFlyBys(dt) {
  for (let i = flyBys.length - 1; i >= 0; i--) {
    const f = flyBys[i];
    for (const r of f.heli.userData.rotors) r.rotation.y += 0.6;
    f.heli.position.x += f.dx * 45 * dt; f.heli.position.z += f.dz * 45 * dt; f.heli.position.y += 4 * dt;
    if (performance.now() - f.born > 14000) { scene.remove(f.heli); flyBys.splice(i, 1); }
  }
}

preloadPeople(['swat1', 'swat3']);
preloadVehicles();
preloadAnimals();
const selfMesh = makeCharacter('self', '');
selfMesh.visible = false;

// ------------------------------------------------------------------ loot visuals
const LOOT_COLORS = { parts: 0xffc53d, ammo: 0x7bd88f, medkit: 0xff5a5a, bag: 0xffffff };
function lootMesh(kind, hot = false) {
  if (hot) {
    // Hot-zone caches are tucked away: a small dark case with a faint orange glint, no beam of light.
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.38), new THREE.MeshStandardMaterial({ color: 0x2b2a24, emissive: 0xff5a1f, emissiveIntensity: 0.18, roughness: 0.8 }));
    box.position.y = 0.15;
    g.add(box);
    scene.add(g);
    return g;
  }
  const color = LOOT_COLORS[kind] ?? 0xffffff;
  const isBag = kind === 'bag';
  const g = new THREE.Group();
  const crate = new THREE.Mesh(new THREE.BoxGeometry(isBag ? 0.6 : 0.5, isBag ? 0.4 : 0.3, 0.4), new THREE.MeshStandardMaterial({ color: isBag ? 0x2d2d22 : color, emissive: isBag ? 0x000000 : color, emissiveIntensity: 0.35 }));
  crate.position.y = 0.2;
  const tall = isBag ? 4 : 2.5;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, tall, 8, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  beam.position.y = tall / 2;
  g.add(crate, beam);
  scene.add(g);
  return g;
}

function syncEntities(list, store, create) {
  const seen = new Set();
  for (const e of list) {
    seen.add(e.id);
    let rec = store.get(e.id);
    if (!rec) { rec = { mesh: create(e) }; rec.mesh.position.set(e.x, ground(e.x, e.z), e.z); store.set(e.id, rec); }
    rec.data = e;
  }
  for (const [id, rec] of store) if (!seen.has(id)) { scene.remove(rec.mesh); store.delete(id); }
}

// ------------------------------------------------------------------ effects
const tracers = [];
/** Where your own shots appear to leave from: the muzzle of the gun in your hands (right of you, at chest height). */
function muzzlePoint(o) {
  const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw), rx = -Math.cos(state.yaw), rz = Math.sin(state.yaw);
  return [state.x + rx * 0.32 + fx * 0.75, eyeHeight() - 0.28, state.z + rz * 0.32 + fz * 0.75];
}
const TRACER_MAT = new THREE.MeshBasicMaterial({ color: 0xffe4a0, transparent: true, opacity: 0.95, depthWrite: false });
const PUFF_MAT = new THREE.MeshBasicMaterial({ color: 0xd9cfbf, transparent: true, opacity: 0.85, depthWrite: false });
const MARK_MAT = new THREE.MeshBasicMaterial({ color: 0x1a1612, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
const HIT_MAT = new THREE.MeshBasicMaterial({ color: 0xff5040 });
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1), PUFF_GEO = new THREE.SphereGeometry(1, 8, 6), MARK_GEO = new THREE.CircleGeometry(0.09, 10);
/** Rounds you carry for the gun in your hands: rockets for a launcher, ammo for the rest. */
function reserveFor(me) { const w = me?.inv?.[me.active]; return w && weaponStats(w)?.explosive ? (me.rockets || 0) : (me?.ammo || 0); }
const ROCKET_MAT = new THREE.MeshBasicMaterial({ color: 0xffb060 });
const SMOKE_MAT = new THREE.MeshBasicMaterial({ color: 0xb8b8b0, transparent: true, opacity: 0.45, depthWrite: false });
function addTracer(o, p, hit) {
  if (hit === 3) {
    // A rocket: a hot streak and a trail of smoke puffs that hang and spread.
    const a = new THREE.Vector3(...o), b = new THREE.Vector3(p[0], p[1], p[2]), len = a.distanceTo(b);
    const streak = new THREE.Mesh(UNIT_BOX, ROCKET_MAT);
    streak.scale.set(0.12, 0.12, len);
    streak.position.copy(a).add(b).multiplyScalar(0.5);
    streak.lookAt(b);
    scene.add(streak);
    tracers.push({ obj: streak, life: 0.18, shared: true });
    for (let d = 4; d < len; d += Math.max(1.5, len / 40)) {   // starts a few metres out, so it doesn't fog your own view
      const puff = new THREE.Mesh(PUFF_GEO, SMOKE_MAT);
      puff.scale.setScalar(0.18);
      puff.position.copy(a).addScaledVector(b.clone().sub(a).normalize(), d);
      scene.add(puff);
      tracers.push({ obj: puff, life: 1.0 + Math.random() * 0.5, shared: true, grow: 0.45 });
    }
    return;
  }
  // A bright streak you can see, from the gun to where the bullet stopped.
  const a = new THREE.Vector3(...o), b = new THREE.Vector3(p[0], p[1], p[2]), len = a.distanceTo(b);
  if (len > 0.5) {
    const streak = new THREE.Mesh(UNIT_BOX, TRACER_MAT);
    streak.scale.set(0.035, 0.035, len);
    streak.position.copy(a).add(b).multiplyScalar(0.5);
    streak.lookAt(b);
    scene.add(streak);
    tracers.push({ obj: streak, life: 0.07, shared: true });
  }
  // Where it landed: red on a person or animal; dust and a bullet hole on anything else.
  if (!hit) return;   // into the sky: nothing to land on
  const body = hit === 2;
  const puff = new THREE.Mesh(PUFF_GEO, body ? HIT_MAT : PUFF_MAT);
  puff.scale.setScalar(body ? 0.09 : 0.16);
  puff.position.copy(b);
  scene.add(puff);
  tracers.push({ obj: puff, life: body ? 0.15 : 0.45, shared: true, grow: body ? 0 : 0.9 });
  if (!body && len > 0.5) {
    const mark = new THREE.Mesh(MARK_GEO, MARK_MAT);
    mark.position.copy(b).addScaledVector(b.clone().sub(a).normalize(), -0.02);
    mark.lookAt(a);
    scene.add(mark);
    tracers.push({ obj: mark, life: 6, shared: true });
    // Keep only the newest 40 holes.
    const marks = tracers.filter((t) => t.obj.geometry === MARK_GEO);
    if (marks.length > 40) marks[0].life = 0;
  }
}

function damageNumber(n, crit, pos) {
  const v = new THREE.Vector3(...pos).project(camera);
  if (v.z > 1) return;
  const el = document.createElement('div');
  el.textContent = n;
  if (crit) el.className = 'crit';
  el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth + (Math.random() - 0.5) * 30}px`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  $('dmgnums').append(el);
  el.animate([{ opacity: 1, marginTop: '0px' }, { opacity: 0, marginTop: '-40px' }], { duration: 700 }).onfinish = () => el.remove();
  $('crosshair').classList.add('hit');
  clearTimeout(damageNumber.t);
  damageNumber.t = setTimeout(() => $('crosshair').classList.remove('hit'), 120);
}

// Messages: one at a time on a phone (two on a big screen), the same message never twice in a row,
// a few queued at most, each up long enough to read and no longer.
const toastQ = { queue: [], shown: new Map() };
/** The server's messages name keyboard keys ("press E"); say the button for what you're playing on. */
function deviceKeys(text) {
  if (typeof text !== 'string') return text;
  const touchy = state.touchUI && state.inputMode !== 'pad', pad = state.inputMode === 'pad';
  if (!touchy && !pad) return text;
  return text.replace(/\b([Pp])ress E\b/g, (_, p) => (touchy ? `${p === 'P' ? 'T' : 't'}ap USE` : `${p}ress ${GLYPHS.E}`))
    .replace(/\(E\)/g, touchy ? '(tap USE)' : `(${GLYPHS.E})`)
    .replace(/\b([Pp])ress Q\b/g, (_, p) => (touchy ? `${p === 'P' ? 'T' : 't'}ap Give up` : `${p}ress ${GLYPHS.Q}`));
}
function toast(text) {
  text = deviceKeys(text);
  const now = performance.now();
  if ((toastQ.shown.get(text) || 0) > now - 6000 || toastQ.queue.includes(text)) return;
  toastQ.queue.push(text);
  if (toastQ.queue.length > 3) toastQ.queue.shift();   // falling behind: the oldest goes
  pumpToasts();
}
function pumpToasts() {
  const box = $('toasts'), max = document.body.classList.contains('touchui') ? 1 : 2;
  while (box.children.length < max && toastQ.queue.length) {
    const text = toastQ.queue.shift();
    toastQ.shown.set(text, performance.now());
    const el = document.createElement('div');
    el.textContent = text;
    box.append(el);
    setTimeout(() => { el.remove(); pumpToasts(); }, Math.min(4500, 2200 + text.length * 25));
  }
}

function feedLine(text) {
  // On a phone the corner feed is only for fights; everything else already comes as a message or on the map.
  if (document.body.classList.contains('touchui') && !/➜|downed|revived|took down|data-hacked/.test(text)) return;
  const el = document.createElement('div');
  el.textContent = text;
  $('feed').prepend(el);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
  setTimeout(() => el.remove(), 12000);
}

// ------------------------------------------------------------------ minimap
const MM_COLORS = { home: '#9a9186', civic: '#a65f4b', rail: 'rgba(0,0,0,0)', roomwall: '#8a8a86', vehiclebody: '#d6c79a', dam: '#999', scrub: '#55603a', pine: '#1f3a24', boulder: '#6a6560', adobe: '#a88a64', cactus: '#3f6a33', cavewall: '#5a5550', caveroof: 'rgba(0,0,0,0)', rockwall: '#8c7258', logwall: '#5a3d24', plankwall: '#7a5e3e', canopy: 'rgba(0,0,0,0)', jetty: '#7a5e3e', building: '#4a5058', warehouse: '#4a5058', farmhouse: '#6b5a44', barn: '#6b3a30', housewall: '#a8774c', crate: '#ff8a2a', tree: '#2c4a26', rock: '#555', car: '#5a3434', cover: '#3a3f44', terminal: '#16c2ff', border: '#000' };
const mmTerrain = { canvas: null, x: 0, z: 0, span: 1 };
function drawMinimap() {
  const c = $('minimap'), g = c.getContext('2d');
  const R = 100, view = 80;   // metres shown radius
  const k = R / view;
  g.clearRect(0, 0, 200, 200);
  g.save();
  g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.clip();
  // Terrain layer (re-rendered when you've moved a bit).
  if (!mmTerrain.canvas || Math.hypot(state.x - mmTerrain.x, state.z - mmTerrain.z) > 12) {
    mmTerrain.canvas ??= Object.assign(document.createElement('canvas'), { width: 48, height: 48 });
    const tg = mmTerrain.canvas.getContext('2d');
    const img = tg.createImageData(48, 48);
    const span = view * 2 * 1.2;
    for (let i = 0; i < 48; i++) for (let j = 0; j < 48; j++) {
      const x = state.x - span / 2 + (i + 0.5) * span / 48, z = state.z - span / 2 + (j + 0.5) * span / 48;
      const c = mapGroundColor(state.map, x, z);
      const o = (j * 48 + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    tg.putImageData(img, 0, 0);
    mmTerrain.x = state.x; mmTerrain.z = state.z; mmTerrain.span = span;
  }
  const X = (x) => R + (x - state.x) * k, Z = (z) => R + (z - state.z) * k;
  g.imageSmoothingEnabled = true;
  g.drawImage(mmTerrain.canvas, X(mmTerrain.x - mmTerrain.span / 2), Z(mmTerrain.z - mmTerrain.span / 2), mmTerrain.span * k, mmTerrain.span * k);
  // Roads, as on the big map: state routes amber, main roads light, streets a shade darker, tracks brown.
  const mmRoads = state.map.roadsNear(state.x, state.z, view * 1.42);
  g.lineCap = 'round';
  for (const r of [...mmRoads].sort((a, b) => (a.hw ? 1 : 0) - (b.hw ? 1 : 0))) {
    g.strokeStyle = r.dirt ? '#b08d58' : r.hw ? '#f0b54a' : (r.width || 12) >= 8 ? '#e4ddcc' : '#c9c2b0';
    g.lineWidth = Math.max(2.5, (r.width || 12) * k);
    g.beginPath(); g.moveTo(X(r.x1), Z(r.z1)); g.lineTo(X(r.x2), Z(r.z2)); g.stroke();
  }
  for (const b of state.map.grid.near(state.x, state.z, view * 1.42)) {
    g.fillStyle = b.type === 'housewall' && b.houseId === state.houseId ? '#4fbf6a' : MM_COLORS[b.type] || '#3a3f44';
    fillBox(g, b, X, Z, 1.5);
  }
  const dot = (x, z, color, size = 4) => { g.fillStyle = color; g.fillRect(X(x) - size / 2, Z(z) - size / 2, size, size); };
  for (const [id, ready] of state.termState) { const t = state.map.terminals[id]; dot(t.x, t.z, ready ? '#16c2ff' : '#553333', 3); }
  for (const ct of state.map.contacts) if (Math.abs(ct.x - state.x) < view * 1.5 && Math.abs(ct.z - state.z) < view * 1.5) dot(ct.x, ct.z, '#7fd6ff', 6);
  for (const [, r] of state.players) if (r.data.sq && !r.data.dead) dot(r.data.x, r.data.z, '#7dff9a', 5);
  const now = performance.now();
  for (const p of state.pings) if (p.until > now) dot(p.x, p.z, p.objective ? '#ffc53d' : '#ffffff', p.objective ? 7 : 5);
  for (const a of state.alerts) if (a.until > now && Math.floor(now / 250) % 2) dot(a.x, a.z, '#ff3b3b', 8);
  // Off-screen objectives (contracts, drops, home) are pinned to the minimap edge.
  const edge = (x, z, color, size) => {
    const dx = x - state.x, dz = z - state.z, d = Math.hypot(dx, dz);
    if (d * k < R - 6) return dot(x, z, color, size);
    g.fillStyle = color; g.beginPath(); g.arc(R + dx / d * (R - 6), R + dz / d * (R - 6), size / 2 + 1, 0, Math.PI * 2); g.fill();
  };
  for (const ct of state.contracts) edge(ct.x, ct.z, '#ffc53d', 7);
  for (const d of state.drops) edge(d.x, d.z, '#ff3b3b', 7);
  for (const e of state.extracts) edge(e.x, e.z, '#ff2a2a', 8);
  for (const e of state.worldEvents || []) edge(e.x, e.z, '#c77dff', 8);
  for (const st of state.sites || []) {
    const dx = st.x - state.x, dz = st.z - state.z;
    if (Math.hypot(dx, dz) * k > R + 8) continue;
    const c = siteColor(st, now);
    if (!c) continue;
    g.fillStyle = c; g.strokeStyle = '#111'; g.lineWidth = 1.5;
    g.beginPath(); g.rect(X(st.x) - 4, Z(st.z) - 4, 8, 8); g.fill(); g.stroke();
  }
  if (state.hotZone) {
    const hz = state.hotZone;
    g.strokeStyle = '#ff5a1f'; g.lineWidth = 2; g.beginPath(); g.arc(X(hz.x), Z(hz.z), hz.radius * k, 0, Math.PI * 2); g.stroke();
    for (const c of hz.crates) if (!c.opened) dot(c.x, c.z, '#ff5a1f', 6);
    if (hz.extract) dot(hz.extract.x, hz.extract.z, '#5dff8a', 7);
    edge(hz.x, hz.z, '#ff5a1f', 10);
  }
  for (const d of state.map.docks) if (Math.abs(d.x - state.x) < view * 1.5 && Math.abs(d.z - state.z) < view * 1.5) dot(d.x, d.z, '#7fd6ff', 5);
  for (const [, v] of boatVis) {
    const land = BOATS[v.data.type].land;
    if (land && !v.data.mine && (v.data.owner || Math.hypot(v.data.x - state.x, v.data.z - state.z) > view * 0.7)) continue;   // free rides close by only
    dot(v.mesh.position.x, v.mesh.position.z, v.data.mine ? '#7dff9a' : land ? '#d8d2b0' : '#ffd27a', land && !v.data.mine ? 3 : 5);
  }
  if (state.enemyStash && state.enemyStash.untilPerf > performance.now()) edge(state.enemyStash.x, state.enemyStash.z, '#ff8a2a', 8);
  for (const [id, e] of state.exposed) { if (e.until < performance.now()) continue; const c = state.players.get(id)?.data; if (c && !c.dead && !c.sq) edge(c.x, c.z, '#ff4d4d', 6); }
  const hp0 = homePos();
  if (hp0) edge(hp0.x, hp0.z, '#4fbf6a', 7);
  if (state.waypoint) edge(state.waypoint.x, state.waypoint.z, '#ff7a1a', 9);
  // Crewmates: a green dot when they're in view; further off, a green arrow on the rim pointing at
  // them, with their name and how far. Live position when they're near, else the crew update (5 s).
  const crewChips = [];
  for (const m of state.squad.members || []) {
    if (!m.online || m.id === state.id || m.x == null) continue;
    const live = state.players.get(m.id)?.data, x = live ? live.x : m.x, z = live ? live.z : m.z;
    const dx = x - state.x, dz = z - state.z, d = Math.hypot(dx, dz);
    if (d * k < R - 8) { dot(x, z, '#7dff9a', 6); continue; }
    const ux = dx / d, uz = dz / d, ex = R + ux * (R - 9), ez = R + uz * (R - 9);
    g.save(); g.translate(ex, ez); g.rotate(Math.atan2(uz, ux));
    g.fillStyle = '#7dff9a'; g.strokeStyle = '#0f1218'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(7, 0); g.lineTo(-7, -7); g.lineTo(-3, 0); g.lineTo(-7, 7); g.closePath(); g.fill(); g.stroke();
    g.restore();
    crewChips.push({ text: `${m.name.slice(0, 8)} ${distText(d)}`, x: R + ux * (R - 40), y: R + uz * (R - 34) });
  }
  g.font = "700 11px 'Atkinson Hyperlegible', Segoe UI, sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
  const chipBoxes = [];
  for (const cc of crewChips) {
    const w = g.measureText(cc.text).width + 10, h = 16;
    let y0 = Math.max(14, Math.min(200 - 14 - h, cc.y - h / 2));
    for (let n = 0; n < 4 && chipBoxes.some((b) => cc.x - w / 2 < b[0] + b[2] && cc.x + w / 2 > b[0] && y0 < b[1] + b[3] && y0 + h > b[1]); n++) y0 += y0 > R ? -h - 2 : h + 2;   // step clear of another chip
    // Kept whole inside the round minimap: as wide as the circle allows at that height.
    const far = Math.max(Math.abs(y0 - R), Math.abs(y0 + h - R)), half = Math.sqrt(Math.max(0, R * R - far * far)) - 3;
    const x0 = Math.max(R - half, Math.min(R + half - w, cc.x - w / 2));
    chipBoxes.push([x0, y0, w, h]);
    g.fillStyle = '#0f1218'; g.beginPath(); g.roundRect(x0, y0, w, h, 5); g.fill();
    g.strokeStyle = '#7dff9a'; g.lineWidth = 1; g.stroke();
    g.fillStyle = '#ffffff'; g.fillText(cc.text, x0 + w / 2, y0 + h / 2 + 0.5);
  }
  // Road names: the two nearest named roads, on solid chips.
  const named = new Map();
  for (const r of mmRoads) {
    if (!r.name) continue;
    const d = distToSeg(state.x, state.z, r);
    if (!named.has(r.name) || d < named.get(r.name).d) named.set(r.name, { d, r });
  }
  g.font = "700 12px 'Atkinson Hyperlegible', Segoe UI, sans-serif";
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const placed = [];   // chips already drawn: [x, y, w, h]
  const H = 20, PAD = 5, top = 42;   // (the N marker sits above `top`)
  /** Half the width the circle has across a chip whose middle is at y (its corners must stay inside). */
  const halfAt = (y) => { const far = Math.max(Math.abs(y - H / 2 - R), Math.abs(y + H / 2 - R)); return Math.sqrt(Math.max(0, (R - PAD) ** 2 - far * far)); };
  const hits = (x, y, w) => placed.some(([px, py, pw]) => Math.abs(py - y) < H + 3 && x < px + pw + 4 && px < x + w + 4);
  for (const [name, { r }] of [...named].sort((a, b) => a[1].d - b[1].d).slice(0, 2)) {
    // On the road, at the point of it nearest the middle of the minimap; then moved up or down (toward
    // the middle first) until the whole chip fits inside the circle without covering another one.
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0.1, Math.min(0.9, ((state.x - r.x1) * dx + (state.z - r.z1) * dz) / l2));
    const lx0 = X(r.x1 + dx * t), ly0 = Math.max(top, Math.min(2 * R - PAD - H / 2, Z(r.z1 + dz * t)));
    let text = name, w = g.measureText(text).width + 14, spot = null;
    const tryAt = () => {
      for (let k = 0; k < 16 && !spot; k++) {
        const step = Math.ceil(k / 2) * 12 * (k % 2 ? 1 : -1) * Math.sign(R - ly0 || 1);
        const y = ly0 + step;
        if (y < top || y > 2 * R - PAD - H / 2) continue;
        const half = halfAt(y);
        if (w > 2 * half) continue;
        const x = Math.max(R - half, Math.min(R + half - w, lx0 - w / 2));
        if (!hits(x, y, w)) spot = [x, y];
      }
    };
    tryAt();
    // Still no room (a long name near the edge): shorten it until it fits.
    while (!spot && text.length > 4) { text = text.slice(0, -2).trimEnd() + '…'; w = g.measureText(text).width + 14; tryAt(); }
    if (!spot) continue;
    const [x, y] = spot;
    placed.push([x, y, w]);
    g.fillStyle = '#161a22'; g.beginPath(); g.roundRect(x, y - H / 2, w, H, 6); g.fill();
    g.fillStyle = '#ffffff'; g.fillText(text, x + w / 2, y + 1);
  }
  g.textBaseline = 'alphabetic';
  g.translate(R, R);
  g.rotate(-state.yaw + Math.PI);
  g.fillStyle = '#5aa8ff';
  g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(-5, 6); g.closePath(); g.fill();
  g.restore();
  // North is always straight up (the map never turns; your arrow does): a red N pointer on the rim.
  g.fillStyle = '#161a22'; g.beginPath(); g.arc(R, 17, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ff4a3a'; g.beginPath(); g.moveTo(R, 0); g.lineTo(R + 6, 8); g.lineTo(R - 6, 8); g.closePath(); g.fill();
  g.fillStyle = '#ffffff'; g.font = '800 16px "Archivo", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('N', R, 19);
  g.textBaseline = 'alphabetic';
}

// ------------------------------------------------------------------ special sights: thermal, spotter, rangefinder, lens glint
const HEAT = new THREE.Color(0xffb060);
/** Make a character (or animal) glow as seen through a thermal sight, or put it back. */
function setHeat(g, on) {
  if (!!g.userData.hot === on) return;
  g.userData.hot = on;
  g.traverse((m) => {
    if (!m.material || !m.material.emissive) return;
    if (on) { m.userData.cool = [m.material.emissive.getHex(), m.material.emissiveIntensity, m.material.opacity, m.material.transparent]; m.material.emissive.copy(HEAT); m.material.emissiveIntensity = 1.6; m.material.opacity = 1; m.material.transparent = false; }
    else if (m.userData.cool) { const [e, i, o, t] = m.userData.cool; m.material.emissive.setHex(e); m.material.emissiveIntensity = i; m.material.opacity = o; m.material.transparent = t; delete m.userData.cool; }
  });
}
const glintGeo = new THREE.SphereGeometry(1, 8, 6), glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
/** The flash of a 12x lens pointed your way: a bright speck that stays visible at range. */
function setGlint(g, on) {
  if (on && !g.userData.glint) { g.userData.glint = new THREE.Mesh(glintGeo, glintMat); g.userData.glint.position.set(0, 1.6, 0.2); g.add(g.userData.glint); }
  if (g.userData.glint) { g.userData.glint.visible = on; if (on) g.userData.glint.scale.setScalar(Math.max(0.05, camera.position.distanceTo(g.position) * 0.004)); }
}
let tagAt = 0;
/** Runs every frame with the stats of the sight you're aiming through (null when you aren't). */
/** The sight on a gun, as the scope view draws it: none (iron sights), a dot, a holo ring, or a scope. */
const SIGHT_LOOK = {
  iron: 'iron', tritium: 'iron', reflex: 'dot', holo: 'holo', fieldOptic: 'dot', lpvo: 'dot',
  prism: 'chevron', acog: 'chevron', thermal: 'thermal', spotter: 'mil', marksman: 'mil', sniper: 'mil', long12: 'mil',
};
const SIGHT_ALT = { lpvo: 'mil', fieldOptic: 'chevron' };   // flipped to their higher zoom
/** A sight's magnification as people say it ("4x"), from its name, or worked out from its zoom. */
function scopeMag(item, alt) {
  const id = item?.parts?.optic || 'iron', name = PARTS[id]?.name || '';
  const m = name.match(/(\d+)(?:-(\d+))?x/);
  if (m && m[2]) return `${alt ? m[2] : m[1]}x`;
  if (m) return `${m[1]}x`;
  const ws = weaponStats(item);
  return `${(ws.zoom + (alt ? ws.zoomAlt : 0)).toFixed(1)}x`;
}
function aimNow() { return state.aiming && state.me && !state.me.dead && !state.air ? state.me.inv[state.me.active] : null; }
const scopeUi = { key: '' };
function updateScopeView(item) {
  const el = $('scopeview');
  const id = item?.parts?.optic || 'iron';
  let look = item ? (state.zoomAlt && SIGHT_ALT[id]) || SIGHT_LOOK[id] || 'iron' : 'none';
  const key = `${look}|${state.zoomAlt ? 1 : 0}|${id}`;
  const on = look !== 'none' && look !== 'iron';
  el.classList.toggle('up', on && camera.fov < 62);
  document.body.classList.toggle('scoped', on && camera.fov < 62);
  if (scopeUi.key === key) { el.hidden = !on; return; }
  scopeUi.key = key;
  el.hidden = !on;
  if (!on) return;
  el.dataset.look = look;
  const svg = el.querySelector('.ret');
  const R = {
    dot: '<circle r="3.2" fill="#ff3b30"/>',
    holo: '<circle r="34" fill="none" stroke="#ff3b30" stroke-width="2.4"/><circle r="2.6" fill="#ff3b30"/><path d="M0 -34v-8M0 34v8M-34 0h-8M34 0h8" stroke="#ff3b30" stroke-width="2.4"/>',
    chevron: '<path d="M-10 14L0 0L10 14" fill="none" stroke="#ff4433" stroke-width="2.6" stroke-linejoin="round"/><path d="M0 22v40M-3 34h6M-3 46h6" stroke="#111" stroke-width="1.6"/><path d="M-100 0h80M20 0h80" stroke="#111" stroke-width="1.4"/>',
    thermal: '<path d="M-100 0h88M12 0h88M0 -100v88M0 12v88" stroke="#e8fff0" stroke-width="1.4"/><circle r="2" fill="#e8fff0"/>',
    mil: '<path d="M-100 0h100M0 0h100M0 -100v100M0 0v100" stroke="#111" stroke-width="0.9"/><path d="M-100 0h-0M-100 0h70M30 0h70M0 30v70M0 -100v70" stroke="#111" stroke-width="3.4"/>' +
      [-24, -16, -8, 8, 16, 24].map((v) => `<circle cx="${v}" cy="0" r="1.3" fill="#111"/><circle cx="0" cy="${v}" r="1.3" fill="#111"/>`).join('') + '<circle r="1.1" fill="#ff3b30"/>',
  };
  svg.innerHTML = R[look] || '';
  el.querySelector('.mag').textContent = look === 'dot' || look === 'holo' ? '' : scopeMag(item, state.zoomAlt);
}
function updateSight(ws, now) {
  if (!ws) state.zoomAlt = false;
  // Thermal: living things within range glow, cloaked or not.
  const R = COMBAT_RULES.optics.thermalRange, hot = !!ws?.thermal;
  for (const [, r] of state.players) setHeat(r.mesh, hot && !r.data.dead && Math.hypot(r.data.x - state.x, r.data.z - state.z) < R);
  for (const [, r] of state.bots) setHeat(r.mesh, hot && Math.hypot(r.data.x - state.x, r.data.z - state.z) < R);
  // Spotter: tag whoever is under the crosshair for the crew.
  if (ws?.autoTag && state.aimTargetId && now - tagAt > 900) { tagAt = now; send({ t: 'mark', id: state.aimTargetId }); }
  // Rangefinder: the range to whatever the crosshair is on.
  const el = $('rangefinder'), show = !!ws?.rangefinder && state.aimDist > 0 && state.aimDist < 399;
  if (el.hidden === show) el.hidden = !show;
  if (show) { const t = `Range ${distText(state.aimDist)}`; if (el.textContent !== t) el.textContent = t; }
}

// ------------------------------------------------------------------ where am I: the road underfoot and the nearest town
const AREA = { plains: 'Farmland', forest: 'Pine flatwoods', desert: 'Sandhills', mountain: 'Hill country', sea: 'River swamp' };
const where = { at: 0, place: null, town: null };
function updateWhere(now) {
  if (now - where.at < 400) return;
  where.at = now;
  const map = state.map, x = state.x, z = state.z;
  // A landmark you're in or right beside comes first, then the road underfoot.
  let place = '';
  for (const b of state.landmarks || []) if (x > b.minX - 12 && x < b.maxX + 12 && z > b.minZ - 12 && z < b.maxZ + 12) { place = b.name; break; }
  if (!place) {
    let best = null, bd = 5;
    for (const r of map.roadsNear(x, z, 18)) {
      if (!r.name) continue;
      const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2));
      // Distance past the road's edge. A street's own name beats the highway line drawn along it.
      const d = Math.hypot(r.x1 + dx * t - x, r.z1 + dz * t - z) - (r.width || 8) / 2 + (r.hw ? 3 : 0);
      if (d < bd) { bd = d; best = r; }
    }
    if (best) place = best.name;
  }
  if (!place) {
    const camp = map.camps.find((c) => Math.hypot(c.x - x, c.z - z) < c.radius);
    if (camp) place = camp.name; else if (map.terrain.channel(x, z)) place = 'Apalachicola River';
  }
  const t = map.towns.reduce((a, q) => (!a || Math.hypot(q.x - x, q.z - z) < Math.hypot(a.x - x, a.z - z) ? q : a), null);
  const d = t ? Math.hypot(t.x - x, t.z - z) : Infinity;
  const inTown = d < 1600;
  // Somewhere with a name: say which town it's in or how far out. Nowhere in particular: the town
  // itself if you're in one, else what kind of country this is.
  let town = !t ? '' : inTown ? t.name : `${distText(d)} from ${t.name}`;
  if (!place) { place = inTown ? t.name : AREA[biomeName(map.terrain.biome(x, z))] || 'Open country'; if (inTown) town = `${t.county} County`; }
  if (place !== where.place) { where.place = place; $('wherePlace').textContent = place; }
  if (town !== where.town) { where.town = town; $('whereTown').textContent = town; }
}

// ------------------------------------------------------------------ networking
function connect(name, world = 1, ticket = null) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/world/${world}`);
  state.ws = ws;
  state.worldId = world;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, token: localStorage.getItem('dz_token'), ticket }));
  ws.onclose = (e) => {
    if (state.ws !== ws) return;
    joinStatus(null);
    // Signed in somewhere else, or never got in: back to the lobby. Otherwise the server restarted
    // (an update) or the signal dropped: keep the world on screen and get back in by ourselves.
    if (e.code === 4000 || !state.map || (state.reconnects || 0) > 40) {
      toast(e.reason || 'Disconnected from the world');
      setTimeout(() => location.replace('/'), 1500);
      return;
    }
    state.reconnects = (state.reconnects || 0) + 1;
    $('reconnect').hidden = false;
    setTimeout(() => connect(name, world), Math.min(4000, 700 * state.reconnects));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    // While real-world map data downloads, hold everything else until the world exists.
    if (state.loadingWorld) return state.loadingWorld.push(m);
    // Back from a world restart built differently (the map editor's fixes): start over with the new map.
    if (m.t === 'welcome' && state.map && state.mapSum != null && m.mapSum !== state.mapSum) { toast('The map was updated: reloading'); setTimeout(() => location.reload(), 800); return; }
    if (m.t === 'welcome' && !state.map && m.real) {
      state.loadingWorld = [];
      joinStatus('Downloading the county…', 'Real roads, buildings, woods and terrain: about 4 MB. Only slow the first time.');
      loadRealData(m.real).then((real) => {
        joinStatus('Building the world…', 'Laying out Liberty County. A few seconds.');
        // Let that show before the heavy build starts.
        setTimeout(() => {
          const queued = state.loadingWorld;
          state.loadingWorld = null;
          handle({ ...m, realData: real });
          for (const q of queued) handle(q);
          joinStatus(null);
        }, 60);
      });
      return;
    }
    handle(m);
    if (m.t === 'welcome') joinStatus(null);
  };
}
const send = (m) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(m));

function handle(m) {
  switch (m.t) {
    case 'air':
      // Out of the helicopter (or the chute opened, or you landed).
      if (m.mode == null) { state.air = null; return; }
      state.air = { alt: m.alt, mode: m.mode };
      if (m.heli) flyBy({ ...m.heli, alt: m.alt });
      return;
    case 'felled': {
      // A tree cut down to a stump (on: 1) or grown back (on: 0).
      if (m.on) state.map.felled.add(m.id); else state.map.felled.delete(m.id);
      const b = findNatureBox(m.id);
      if (b) { b.gone = m.on ? 1 : 0; state.view?.setFelled(b, !!m.on); }
      return;
    }
    case 'taxiMenu':
      state.taxi = m;
      openMapScreen('taxi');
      return;
    case 'welcome':
      if (state.reconnects) { state.reconnects = 0; $('reconnect').hidden = true; toast('Back in'); }
      state.worldId = m.world; loadWaypoint();
      localStorage.setItem('dz_token', m.token);
      state.myName = lobby.account?.name || $('name').value.trim() || 'Agent';
      Object.assign(state, { id: m.id, houseId: m.houseId, x: m.x, z: m.z, yaw: m.yaw || 0, packSize: m.packSize, devKit: !!m.devKit, doorBase: m.doorBase });
      $('testRideBtn').hidden = !m.testRides;
      document.querySelector('#touch [data-act=testRide]')?.toggleAttribute('hidden', !m.testRides);
      state.pushKey = m.pushKey || null;
      { const n = Number(localStorage.getItem('dz_tip_fire2') || 0);   // the first three games on a phone
        if (touchCapable && n < 3) { localStorage.setItem('dz_tip_fire2', String(n + 1)); setTimeout(() => toast(tset.autoFire && tset.autoFire !== 'off'
          ? 'Aiming: drag the right side of the screen to put the crosshair on someone. Your gun fires by itself (AUTO on the FIRE button). To fire by hand, hold FIRE and slide that thumb to aim.'
          : 'Aiming: hold FIRE and slide that same thumb to aim while you shoot. Or turn on Auto-fire in Settings → Controls.'), 6000); } }
      syncPush();
      if (!state.map) initWorld(m);
      selfMesh.visible = true;
      selfMesh.position.set(m.x, ground(m.x, m.z), m.z);
      $('login').hidden = true; $('hud').hidden = false;
      if (m.deploy) openMapScreen(m.firstDeploy ? 'first' : 'redeploy', m.deploy);
      else lockPointer();
      break;
    case 'snap': {
      for (const p of m.players) {
        if (p.id === state.id) {
          state.selfSnap = p;
          // The server owns your height on a jump: catch up if the two drift apart.
          if (state.air && p.alt != null) { if (Math.abs(p.alt - state.air.alt) > 4) state.air.alt = p.alt; if (p.air === 'chute') state.air.mode = 'chute'; }
          continue;
        }
        let rec = state.players.get(p.id);
        if (!rec) { rec = { mesh: makeCharacter('player', p.name) }; rec.mesh.position.set(p.x, ground(p.x, p.z), p.z); state.players.set(p.id, rec); }
        rec.data = p;
        (rec.buf ??= []).push({ t: performance.now(), x: p.x, z: p.z, yaw: p.yaw, alt: p.alt || 0, y: p.y });
        if (rec.buf.length > 12) rec.buf.shift();
        setCharacterGun(rec.mesh, p.gun);
        setCharacterStowed(rec.mesh, p.stowed);
        setHolstered(rec.mesh, !!p.sp && !p.boat);
        setLabel(rec.mesh.userData.label, `${p.sq ? '◆ ' : ''}${p.name}  [${p.level}]${p.sh ? ' 🛡' : ''}${p.hacking ? '  ⌁ hacking' : ''}`, p.sq ? '#7dff9a' : '#ffb27a');
        setCloak(rec.mesh, p.camo ? (p.sq ? 0.35 : 0.12) : 1);
        setGlint(rec.mesh, !!p.gl);
      }
      for (const [id, rec] of state.players) if (!m.players.some((p) => p.id === id)) { scene.remove(rec.mesh); state.players.delete(id); }
      for (const b of m.bots) {
        let rec = state.bots.get(b.id);
        if (!rec && (b.kind === 'merchant' || b.kind === 'settler' || b.kind === 'trader' || b.kind === 'pawn')) {
          rec = { mesh: makeCharacter('contact', b.name) };
          rec.mesh.position.set(b.x, ground(b.x, b.z), b.z);
          setLabel(rec.mesh.userData.label, b.kind === 'pawn' ? `$ ${b.name} · buys & sells guns` : `${b.kind === 'merchant' ? '🛒' : b.kind === 'trader' ? (b.name === 'Dockhand' ? '⚓' : '🏕') : '🌾'} ${b.name}`, b.kind === 'pawn' ? '#ffd27a' : '#9fe39f');
          state.bots.set(b.id, rec);
        }
        if (!rec && b.kind === 'convoy') {
          rec = { mesh: makeTruck(), animal: true };
          rec.mesh.position.set(b.x, ground(b.x, b.z), b.z);
          state.bots.set(b.id, rec);
        }
        if (!rec && (HOMESTEAD.animals[b.kind] || b.kind === 'dog')) {
          rec = { mesh: makeAnimal(b.kind), animal: true };
          rec.mesh.position.set(b.x, ground(b.x, b.z), b.z);
          state.bots.set(b.id, rec);
        }
        if (!rec) {
          rec = { mesh: makeCharacter('bot', b.name || 'Rogue') };
          rec.mesh.position.set(b.x, ground(b.x, b.z), b.z);
          setCharacterGun(rec.mesh, { a: b.kind === 'hvt' ? 'dmr' : 'carbine', paint: 'factory' });
          if (b.kind === 'hvt') rec.mesh.scale.setScalar(1.15);
          state.bots.set(b.id, rec);
        }
        rec.data = { ...b, armor: 0, maxArmor: 0 };
      }
      for (const [id, rec] of state.bots) if (!m.bots.some((b) => b.id === id)) { scene.remove(rec.mesh); state.bots.delete(id); }
      syncEntities(m.loot, state.loot, (e) => lootMesh(e.kind, e.hot));
      syncEntities(m.bags, state.bags, () => lootMesh('bag'));
      // The crew panel refreshes itself once a second, but never under someone's typing.
      if (state.panelOpen && !typingIn($('squadpanel')) && performance.now() - (state.panelDrawn || 0) > 1000) { state.panelDrawn = performance.now(); renderSquadPanel(); }
      syncHouses(m.houses);
      syncTerminals(m.terminals || []);
      syncObjectives(m.objectives || []);
      syncStructs(m.structs || []);
      syncBoats(m.boats || []);
      syncCharges(m.charges || []);
      break;
    }
    case 'you': {
      const wasDead = state.me?.dead;
      if (state.me && !m.dead && !wasDead) {
        if (m.hp < state.me.hp - 1) sfx.hurt();
        const haul = (x) => x.inv.pack.length + RES_UI.reduce((a, r) => a + (r === 'ammo' ? 0 : x[r] || 0), 0);
        if (haul(m) > haul(state.me) && m.inv.pack.length >= state.me.inv.pack.length) sfx.pickup();
      }
      if (m.boat && !state.me?.boat) state.crouch = false;
      if (!m.boat || m.boat.seat !== 0 || (state.boat && state.boat.id !== m.boat.id)) state.boat = null;
      state.me = m;
      if (m.houseId !== state.houseId) { state.houseId = m.houseId; state.view?.setOwnHouse(m.houseId); }
      if (state.mapMode && state.mapOpen) redraw($('mapscreen'), renderMapScreen);
      if (state.contactOpen) redraw($('contactpanel'), renderContact);
      updateHud();
      if (state.invOpen) redraw($('inventory'), renderInventory);
      if (state.gunsmithOpen) redraw($('gunsmith'), renderGunsmith);
      setCloak(selfMesh, m.camoActive ? 0.3 : 1);
      if (build.on) renderBuildBar();
      document.body.classList.toggle('cloaked', !!m.camoActive);
      updateGadgetBar();
      setCharacterGun(selfMesh, m.inv[m.active] ? { a: m.inv[m.active].archetype, parts: m.inv[m.active].parts, paint: m.inv[m.active].paint } : null);
      setCharacterStowed(selfMesh, stowedOf(m));
      break;
    }
    case 'boatFix':
      if (state.boat) Object.assign(state.boat, { x: m.x, z: m.z, yaw: m.yaw, speed: (state.boat.speed || 0) * 0.6, y: undefined });   // put back where the server has it, still rolling
      break;
    case 'dock':
      state.contact = { ...m, dock: true, offers: [], active: [] };
      openContact();
      break;
    case 'correct':
      state.x = m.x; state.z = m.z;
      if (m.y != null) { state.y = m.y; state.yx = m.x; state.yz = m.z; }
      if (m.force) { state.tp = m.tp || 0; selfMesh.position.set(m.x, ground(m.x, m.z), m.z); state.view?.update(m.x, m.z); }
      break;
    case 'shot': {
      // Your own shots are heard the moment you fire (see tryFire); everyone else's from where they are.
      if (m.from !== state.id) {
        sfx.shot(m.o[0], m.o[1], m.o[2], state.players.get(m.from)?.data?.gun?.a || 'carbine', m.sup);
        const r = state.players.get(m.from) || state.bots.get(m.from);
        if (r?.mesh && Math.hypot(m.o[0] - state.x, m.o[2] - state.z) < 120) shotFx(r.mesh, r.data?.gun?.a, m.sup);
      }
      // Suppressed fire from other players only shows up close.
      const near = Math.hypot(m.o[0] - state.x, m.o[2] - state.z) < (m.sup === 2 ? 8 : 25);
      if (m.sup && m.from !== state.id && !near) break;
      for (const h of m.hits) addTracer(m.from === state.id ? muzzlePoint(m.o) : m.o, h, h[3]);
      break;
    }
    case 'xp':
      xpPopup(m.amount, m.reason);
      break;
    case 'levelup':
      sfx.levelUp();
      levelBanner(m.level, m.unlocks);
      break;
    case 'hitmark':
      sfx.hit(m.crit);
      damageNumber(m.dmg, m.crit, [m.x, m.y, m.z]);
      break;
    case 'feed': feedLine(m.text); break;
    case 'squad':
      if (m.id) state.invite = null;
      state.squad = { id: m.id, name: m.name || null, score: m.score || 0, myRank: m.myRank || null, members: m.members || [], leaderId: m.leaderId ?? null };
      if (state.panelOpen) renderSquadPanel();
      updateGadgetBar();
      break;
    case 'invite':
      state.invite = { fromId: m.fromId, fromName: m.fromName, crewName: m.crewName };
      toast(`${m.fromName} invited you to ${m.crewName ? `the crew ${m.crewName}` : 'start a crew'} — open the crew panel (${glyph('P')}) to answer`);
      if (state.panelOpen) renderSquadPanel();
      break;
    case 'leaderboard':
      state.leaderboard = m.rows;
      state.crewBoard = m.crews || [];
      if (state.panelOpen) renderSquadPanel();
      break;
    case 'expose':
      for (const id of m.ids) {
        const prev = state.exposed.get(id);
        state.exposed.set(id, { until: performance.now() + (m.until - Date.now()), kind: prev?.kind === 'mark' && m.kind === 'sensor' ? 'mark' : m.kind });
      }
      if (m.kind === 'mark' && m.by && m.by !== state.myName) toast(m.ids.length > 1 ? `${m.by} lit up ${m.ids.length} targets` : `${m.by} tagged a target`);
      break;
    case 'sensor': {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff9b21 }));
      mesh.position.set(m.x, ground(m.x, m.z) + 0.2, m.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(m.radius - 0.15, m.radius, 48), new THREE.MeshBasicMaterial({ color: 0xff9b21, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(m.x, ground(m.x, m.z) + 0.3, m.z);
      scene.add(mesh, ring);
      state.sensors.push({ meshes: [mesh, ring], until: performance.now() + (m.until - Date.now()) });
      break;
    }
    case 'crewTicket':
      hubSend({ t: 'invite', name: m.for, world: state.worldId, ticket: m.ticket });
      break;
    case 'stunThrow': stunThrowFx(m); break;
    case 'nadeThrow':
      // Your own throw leaves from your shoulder, so you see it go past you rather than from behind your back.
      if (m.by === state.id) { m.from = muzzlePoint(m.from); if (m.kind === 'frag') toast('💣 Frag out!'); }
      stunThrowFx(m, m.kind === 'frag' ? 0xd7e08a : 0xff9b21);
      break;
    case 'stunBlast': stunBlastFx(m.x, m.y, m.z); break;
    case 'stunned':
      state.stunnedUntil = performance.now() + (m.until - Date.now());
      $('stunfx').style.opacity = 1;
      toast(m.by ? `⚡ Stunned by ${m.by}!` : '⚡ Stunned!');
      break;
    case 'intel':
      state.enemyStash = { ...m.stash, untilPerf: performance.now() + (m.stash.until - Date.now()) };
      toast(`🏠 Enemy stash house located: ${m.stash.owner} — marked on your map`);
      break;
    case 'scan': {
      const ring = new THREE.Mesh(new THREE.RingGeometry(m.r - 1.5, m.r, 96), new THREE.MeshBasicMaterial({ color: 0x16c2ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(m.x, ground(m.x, m.z) + 1, m.z);
      scene.add(ring);
      state.sensors.push({ meshes: [ring, ring], until: performance.now() + 1500 });
      break;
    }
    case 'ping':
      sfx.ping(false);
      if (m.objective) state.pings = state.pings.filter((p) => !p.objective);
      state.pings.push({ x: m.x, z: m.z, from: m.from, objective: m.objective, until: performance.now() + (m.objective ? 120_000 : 8000) });
      break;
    case 'alert':
      sfx.ping(true);
      state.alerts.push({ x: m.x, z: m.z, until: performance.now() + (m.hot ? 12000 : 6000), hot: !!m.hot });
      toast(m.hot ? `🔥 ${m.text} · ${distText(Math.hypot(m.x - state.x, m.z - state.z))} away` : `⚠ ${m.text} nearby`);
      break;
    case 'hack':
      if (m.cancel) { state.hack = null; toast(m.reason); }
      else if (m.done) { state.hack = null; toast(m.text); }
      // Progress can speed up mid-way (crewmates helping), so work back from the finish time.
      else state.hack = { start: performance.now() - Math.max(0, m.total - (m.until - Date.now())), total: m.total, kind: m.kind, helpers: m.helpers || 0 };
      break;
    case 'rally':
      toast(`${m.from} rallied the squad — armor restored, +20% damage`);
      break;
    case 'toast': toast(m.text); break;
    case 'died':
      state.gunsmithOpen = false; $('gunsmith').hidden = true;
      closeInventory(); closeContact();
      if (state.panelOpen) closeSquadPanel();
      state.killedBy = m.by;
      openMapScreen('redeploy', m.deploy);
      break;
    case 'deployed':
      closeMapScreen();
      state.view.setOwnHouse(state.houseId);
      toast(m.kind === 'claim' ? `Stash house claimed. Open the crate (${glyph('E')}) to reach your stash, gunsmith and upgrades.` : 'Deployed — 10 seconds of spawn protection.');
      lockPointer();
      break;
    case 'gesture':
      state.gesture = { kind: m.kind, start: performance.now(), until: performance.now() + m.ms };
      break;
    case 'hotzone':
      state.hotZone = m.zone;
      syncHotZone();
      break;
    case 'sites':
      state.sites = m.sites || [];
      if (m.noClaim) state.noClaim = new Set(m.noClaim);   // businesses, shops and sites: nobody's stash house
      break;
    case 'events':
      state.drops = m.drops;
      state.extracts = m.extracts || [];
      syncDrops();
      syncExtracts(m.pickup);
      if (m.announce) toast('📦 Supply drop inbound: it\'s on your map');
      break;
    case 'contracts':
      state.contracts = m.list;
      renderTracker();
      break;
    case 'extracted':
      toast(`🚁 Flown home from ${m.from} with everything you were carrying.`);
      break;
    case 'contact':
      state.contact = m;
      openContact();
      break;
    case 'worldEvents': {
      state.worldEvents = m.list;
      const e = m.announce && m.list.find((x) => x.id === m.announce);
      if (e) toast(`📣 ${e.name} — ${e.desc} Marked on your map (${glyph('M')}).`);
      if (state.contactOpen) renderContact();
      break;
    }
    case 'awayLog': {
      const n = m.entries.length;
      toast(`While you were away: ${n} thing${n === 1 ? '' : 's'} happened at your place`);
      for (const en of m.entries.slice(-6)) toast(`🕒 ${en.text}`);
      break;
    }
    case 'ptrade': handlePlayerTrade(m); break;
    case 'boom': boomFx(m.x, m.y, m.z, m.r); sfx.boom(m.x, m.y, m.z); break;
    case 'siren': {
      sfx.siren(m.x, m.y, m.z);
      state.sirens.set(m.id, { x: m.x, y: m.y, z: m.z, until: performance.now() + 4500 });
      if (Math.hypot(m.x - state.x, m.z - state.z) < 40) toast('🚨 You set off an alarm!');
      break;
    }
    case 'defmarks': for (const d of m.list) state.defMarks.push({ ...d, until: performance.now() + (m.until - Date.now()) }); break;
    case 'homexp': if (m.amount >= 5) xpPopup(m.amount, `Home: ${m.reason}`); break;
    case 'homeLevel': levelBanner(m.level, [{ name: HOME_LEVEL_TEXT[m.level - 1] }], 'STASH HOUSE LEVEL'); break;
    case 'claimed': toast('This is now your stash house. Open its stash for the gunsmith, upgrades and home level.'); break;
    case 'contractDone':
      toast(`✔ ${m.crew ? 'Crew contract' : 'Contract'} complete: ${m.name}${m.crew ? ` (shared with ${m.crew.filter((n) => n !== state.myName).join(', ')})` : ''} — ${Object.entries(m.reward).map(([k, v]) => `+${v} ${k === 'comms' ? 'commendations' : k}`).join(', ')}`);
      break;
    case 'container':
      if (m.closed) {
        state.container = null;
        if (state.gunsmithOpen) { state.gunsmithOpen = false; $('gunsmith').hidden = true; openInventory(); }
        if (state.invOpen) renderInventory();
        break;
      }
      state.container = m;
      if (state.gunsmithOpen) renderGunsmith(); else openInventory();
      break;
  }
}

// ------------------------------------------------------------------ HUD + inventory
const STANCE_TEXT = { stand: 'Standing', crouch: 'Crouched', prone: 'Prone', sprint: 'Sprinting' };
/** The stance chip above the gadget bar: what you are, and which button changes it. */
function stanceNote() {
  const el = $('stance');
  if (!el || !state.me) return;
  const st = state.sprint ? 'sprint' : state.prone ? 'prone' : state.crouch ? 'crouch' : 'stand';
  const pad = state.inputMode === 'pad';
  const hint = pad ? 'Ⓑ crouch · hold Ⓑ prone · L3 sprint' : MOBILE && !pad ? 'tap CROUCH · hold it to go prone' : 'C crouch · hold C prone · Shift sprint';
  el.innerHTML = `<b>${STANCE_TEXT[st]}</b><span>${hint}</span>`;
  el.hidden = !!state.me.dead || !!state.me.boat || !!state.air;   // the line above the crosshair covers a jump
  el.classList.toggle('standing', st === 'stand');
  // Phones are played sideways: say so if it's held upright in the game.
  const upright = document.body.classList.contains('touchui') && innerHeight > innerWidth * 1.1 && !state.me.dead;
  if ($('rotate').hidden === upright) $('rotate').hidden = !upright;
}
setInterval(stanceNote, 250);
function updateHud() {
  const me = state.me;
  if (!me) return;
  $('hpbar').style.width = `${(me.hp / me.maxHp) * 100}%`;
  $('hptext').textContent = `${Math.ceil(me.hp)} / ${me.maxHp}`;
  $('armorbar').style.width = me.maxArmor ? `${(me.armor / me.maxArmor) * 100}%` : '0%';
  $('armortext').textContent = me.maxArmor ? `ARMOR ${Math.ceil(me.armor)} / ${me.maxArmor}` : 'NO ARMOR';
  $('foodbar').style.width = `${(me.food / (me.foodMax || 100)) * 100}%`;
  $('foodtext').textContent = `FOOD ${me.food}${me.food < HOMESTEAD.hunger.noRegenBelow ? ' · HUNGRY (H to eat)' : ''}`;
  $('foodbar').parentElement.classList.toggle('low', me.food < HOMESTEAD.hunger.noRegenBelow);
  const w = me.inv[me.active];
  $('wname').textContent = w ? `${w.name}${w.parts?.muzzle === 'suppressor' ? ' · suppressed' : ''}` : 'Unarmed';
  const slotsHtml = ['primary', 'primary2', 'secondary'].map((sl, i) => { const it = me.inv[sl]; return `<span data-slot="${sl}" class="${sl === me.active ? 'on' : it ? '' : 'none'}">${i + 1} ${it ? esc(shortGun(it)) : '—'}</span>`; }).join('');
  if ($('wslots').innerHTML !== slotsHtml) $('wslots').innerHTML = slotsHtml;
  $('mag').textContent = me.mag;
  $('reserve').textContent = reserveFor(me);
  const medkits = me.inv.pack.filter((i) => i.kind === 'medkit').length;
  $('wextra').textContent = `${me.reloading ? 'RELOADING… · ' : ''}Medkits ${medkits} · Kills ${me.kills}`;
  $('housestatus').textContent = (me.claim ? `⌂ ${me.claim.name} · Lv${me.claim.level}${me.claim.ruined ? ' · RUIN: rebuild it at the stash' : ''}` : 'No stash house — plant a claim marker')
    + (me.shield ? ` · 🛡 New-player shield until level ${me.shieldLevel}` : '');
  const goodsHud = ['seeds', 'corn', 'peanuts', 'cotton', 'fish', 'meat', 'meals', 'honey', 'shine', 'hide'].filter((g) => me[g] && GOODS[g]).map((g) => `<span><b>${me[g]}</b> ${GOODS[g].name.toLowerCase()}</span>`).join('');
  // What you carry, in words. Zeros are left out to keep it short; cash always shows.
  const carried = [[`$${me.cash || 0}`, 'cash'], [me.parts, 'parts'], [me.tech, 'tech'], [me.salvage, 'salvage'], [me.wood, 'wood'], [me.stone, 'stone'], [me.intel, 'intel'], [me.comms, '★ medals']];
  $('resources').innerHTML = carried.filter(([n], i) => i === 0 || n).map(([n, w]) => `<span><b>${n}</b> ${w}</span>`).join('') + goodsHud;
  const lo = xpForLevel(me.level), hi = xpForLevel(me.level + 1);
  $('level').textContent = `LEVEL ${me.level}`;
  $('xpbar').style.width = me.level >= MAX_LEVEL ? '100%' : `${((me.xp - lo) / (hi - lo)) * 100}%`;
  $('xptext').textContent = me.level >= MAX_LEVEL ? 'MAX LEVEL' : `${me.xp - lo} / ${hi - lo} XP`;
}

function statLine(item) {
  if (item.kind === 'tool') return `${item.maxDur ? `Condition ${Math.max(0, Math.round((item.dur ?? item.maxDur) / item.maxDur * 100))}% · ` : ''}${TOOLS[item.tool]?.desc || ''}`;
  if (item.kind === 'charge') return CRAFTS.charge.desc;
  if (item.kind === 'marker') return CRAFTS.marker.desc;
  if (item.kind === 'package') return 'Contract crate — deliver to any Contact';
  if (item.kind === 'weapon') {
    const s = weaponStats(item);
    return `${Math.round(s.damage)}${s.pellets > 1 ? `×${s.pellets}` : ''} dmg · ${Math.round(s.rpm)} rpm · ${s.mag} mag · ${feet(s.range)}`;
  }
  if (item.kind === 'armor') { const a = armorStats(item); return `Armor ${a.armor}${a.mobility ? ` · ${Math.round(a.mobility * 100)}% speed` : ''}`; }
  if (item.kind === 'medkit') return 'Restores 60 health and 40 armor';
  if (item.kind === 'lockbox') return `Break it open here (10 s, noisy) or it opens at your stash: ${Object.entries(item.contents || {}).map(([k, v]) => (k === 'cash' ? `$${v}` : `${v} ${k}`)).join(', ')}`;
  if (item.kind === 'hotflare') return 'Parachutes you (and crew beside you) in at the edge of an open hot zone. Fire it outdoors. One use.';
  if (item.kind === 'flare') return `Calls the helicopter home from anywhere outdoors. Hold ${HELI.rescueFlare.holdMs / 60000} min; seen ${distText(HELI.rescueFlare.alertRange)} away. One use.`;
  return '';
}

function attachmentLine(item) {
  if (item.kind !== 'weapon') return '';
  const mods = SLOTS.map((sl) => item.parts?.[sl]).filter((id) => id && PARTS[id] && PARTS[id].level > 1).map((id) => PARTS[id].name);
  return mods.length ? mods.join(' · ') : 'Stock configuration';
}
/** A gun's main attachment slots as chips (fitted ones lit), for the gear column. */
const CHIP_SLOTS = [['optic', 'Sight'], ['muzzle', 'Muzzle'], ['underbarrel', 'Grip'], ['magazine', 'Mag'], ['stock', 'Stock']];
function attachmentChips(item) {
  if (item.kind !== 'weapon') return '';
  return `<span class="chips">${CHIP_SLOTS.map(([sl, label]) => {
    const id = item.parts?.[sl], part = id && PARTS[id];
    const fitted = part && part.level > 1;
    return `<span class="chip${fitted ? ' on' : ''}">${fitted ? part.name.replace(/ (Sight|Scope|Sights)$/, '') : `${label}: —`}</span>`;
  }).join('')}</span>`;
}
/** Change parts on a gun: at your stash house's gunsmith (or anywhere while testing). */
function partsAction(it) {
  const can = state.devKit || !!state.container?.gunsmith;
  return ['Parts', () => { if (!can) return toast('Change parts at the gunsmith in your stash house (or a hideout)'); gs.selectedId = it.id; openGunsmith(); }];
}

function itemCard(item, { slot, buttons = [] } = {}) {
  const el = document.createElement('div');
  el.className = 'item';
  if (!item) {
    el.innerHTML = `<span class="slot">${slot}</span><span class="empty">— empty —</span>`;
    return el;
  }
  const color = item.kind === 'weapon' ? (PAINTS[item.paint]?.color || '#888') : item.kind === 'armor' ? '#5aa8ff' : '#888';
  el.style.borderLeftColor = color;
  const att = attachmentLine(item);
  el.innerHTML = `${slot ? `<span class="slot">${slot}</span>` : ''}
    <div class="meta"><div class="nm">${item.name}</div>
    <div class="st">${statLine(item)}</div>${att ? `<div class="at">${att}</div>` : ''}</div>`;
  for (const [label, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = label;
    b.onclick = fn;
    el.append(b);
  }
  return el;
}

const SLOT_LABEL = { primary: 'Main gun 1', primary2: 'Main gun 2', secondary: 'Sidearm', armor: 'Armor' };
/** A short name for the weapon strip ("Marksman Rifle" is just "Marksman"). */
const shortGun = (it) => String(it.name || it.archetype || '').replace(/ Rifle$/, '');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Tap (or click) a gun in the weapon strip to take it in hand.
$('minimap').addEventListener('click', () => doAction('map'));
$('wslots').addEventListener('pointerdown', (e) => { const sl = e.target.closest('[data-slot]')?.dataset.slot; if (sl && state.me?.inv[sl]) { e.stopPropagation(); send({ t: 'weapon', slot: sl }); } });
function equippedFor(item) {
  const inv = state.me.inv;
  if (item.kind === 'armor') return inv.armor;
  if (item.kind === 'weapon') return item.archetype === 'sidearm' ? inv.secondary : !inv.primary || !inv.primary2 ? null : inv[state.me.active === 'primary2' ? 'primary2' : 'primary'];
  return undefined;
}

// ------------------------------------------------------------------ inventory
// Every line is one button, in one of two columns: you (left) and the stash, bag or body beside you
// (right). Ⓐ on a line does its only action, or opens a short list of what you can do with it right
// under it. Up and down go along the column; left and right switch sides.
const invUi = { tab: 'contents', menuFor: null, kind: null, view: 'pack', sel: null, rows: new Map() };
const RES_USE = {
  cash: 'Buy and sell at trading posts', parts: 'Build guns and armor at your gunsmith', tech: 'Powers gadgets and lock bypass',
  salvage: 'Stash house upgrades', ammo: 'Rounds for every gun', wood: 'Building (chop trees with a hatchet)', stone: 'Building (mine rocks with a pickaxe)',
  intel: 'Upload at your stash for XP. Lost if you die carrying it.', seeds: 'Plant in a farm plot',
};
/** One line: a full-width button. `actions` is [[label, fn], ...]; `why` says why there's nothing to do. */
const RES_ICON = { food: '🍽️', trade: '📦', cash: '💵', parts: '⚙️', tech: '🔌', salvage: '🔩', ammo: '🟡', rockets: '🚀', wood: '🪵', stone: '🪨', intel: '💾', seeds: '🌱', corn: '🌽', peanuts: '🥜', cotton: '☁️', fish: '🐟', meat: '🍖', meals: '🍲', honey: '🍯', shine: '🫙', hide: '🟫' };
const GUN_BADGE = { sidearm: 'PISTOL', smg: 'SMG', carbine: 'RIFLE', dmr: 'DMR', shotgun: 'SHOTGUN', lmg: 'LMG', launcher: 'RPG' };
const KEY_ICON = { gunsmith: '🛠', intel: '💾', travel: '🗺', takeall: '⬇️', putall: '⬆️', ruin: '🔨', abandon: '⚠️', devgunsmith: '🛠', 'g-all': '⬇️' };
/** The picture on a tile: a gun's type in its paint colour, or an emoji for everything else. */
function tileIcon(key, o) {
  const it = o.item;
  if (it?.kind === 'weapon') return `<span class="gunbadge" style="--paint:${PAINTS[it.paint]?.color || '#888'}">${GUN_BADGE[it.archetype] || 'GUN'}</span>`;
  if (it) return { armor: '🦺', medkit: '🩹', flare: '🧨', hotflare: '🔥', charge: '💣', marker: '🚩', package: '📦', frag: '💥', sensor: '📡' }[it.kind]
    || (/hammer/i.test(it.name) ? '🔨' : /hatchet|axe/i.test(it.name) ? '🪓' : /rod|fish/i.test(it.name) ? '🎣' : /shovel/i.test(it.name) ? '⛏️' : /claim/i.test(it.name) ? '🚩' : '🎒');
  const r = key.replace(/^(rs|cr)-/, '');
  if (RES_ICON[r] && /^(rs|cr)-/.test(key)) return RES_ICON[r];
  if (o.lootKind) return RES_ICON[o.lootKind] || { weapon: '🔫', armor: '🦺', medkit: '🩹', bag: '🎒' }[o.lootKind] || '📦';
  if (/^up-/.test(key)) return '⬆️';
  if (/^cf-/.test(key)) return '🔨';
  if (/^eq-/.test(key)) return '➖';
  return KEY_ICON[key] || '•';
}
/** One thing in the bag: a tile. Tap it and the panel beside the tiles shows all of it and what you can do. */
function invRow(key, o) {
  if (o.hot) o = { ...o, tag: 'HOT · extract to keep' };
  invUi.rows.set(key, o);
  const t = document.createElement('button');
  t.className = 'itile' + (invUi.sel === key ? ' sel' : '') + (o.hot ? ' hot' : '') + (o.actions?.length ? '' : ' idle');
  t.dataset.pad = key;
  t.style.setProperty('--bar', o.color || '#5a5f68');
  t.innerHTML = `<span class="tic">${tileIcon(key, o)}</span><b>${o.title}</b>${o.tag ? `<small>${o.tag}</small>` : ''}`;
  t.onclick = () => { invUi.sel = key; renderInvDetail(); };
  return [t];
}
/** The details of what's picked: all of the description, and every choice as a big button. */
function renderInvDetail() {
  const el = $('invDetail'), col = $(INV_VIEWS[invUi.view] || 'packCol');
  const tiles = [...col.querySelectorAll('.itile')];
  if (!tiles.some((t) => t.dataset.pad === invUi.sel)) invUi.sel = tiles[0]?.dataset.pad || null;
  for (const t of document.querySelectorAll('#inventory .itile')) t.classList.toggle('sel', t.dataset.pad === invUi.sel);
  const o = invUi.sel && invUi.rows.get(invUi.sel);
  if (!o) { el.innerHTML = '<p class="empty">Nothing here yet.</p>'; return; }
  el.innerHTML = `<div class="dhead"><span class="tic">${tileIcon(invUi.sel, o)}</span><div><h3>${o.title}</h3>${o.tag ? `<small>${o.tag}</small>` : ''}</div></div>${o.detail ? `<p>${o.detail}</p>` : ''}${o.extra ? `<p class="at">${o.extra}</p>` : ''}`;
  const acts = document.createElement('div');
  acts.className = 'dacts';
  (o.actions || []).forEach(([label, fn], i) => { const b = btn(label, () => { fn(); }, i ? 'dact ghost' : 'dact'); b.dataset.pad = `act-${i}`; acts.append(b); });
  if (!o.actions?.length && o.why) acts.append(Object.assign(document.createElement('p'), { className: 'why', textContent: o.why }));
  el.append(acts);
}
const INV_VIEWS = { gear: 'youCol', pack: 'packCol', here: 'containerCol' };
function setInvView(v) { invUi.view = v; invUi.sel = null; applyInvView(); renderInvDetail(); }
function applyInvView() {
  const c = state.container, me = state.me;
  for (const [v, id] of Object.entries(INV_VIEWS)) $(id).hidden = v !== invUi.view;
  const tabs = $('invTabs');
  const label = { gear: 'Gear', pack: `Backpack ${me.inv.pack.length}/${state.packSize}`, here: c ? c.title : 'Nearby' };
  tabs.innerHTML = '';
  for (const v of ['gear', 'pack', 'here']) { const b = btn(label[v], () => setInvView(v), `invtab${invUi.view === v ? ' on' : ''}`); b.dataset.pad = `view-${v}`; tabs.append(b); }
}
function closeInvMenu() {
  const key = invUi.menuFor;
  invUi.menuFor = null;
  renderInventory();
  const row = key && document.querySelector(`#inventory .irow[data-pad="${key}"]`);
  if (row) { if (state.inputMode === 'pad') padFocus(row); else row.focus(); }
}
const head = (text) => Object.assign(document.createElement('h2'), { textContent: text });

function renderInventory() {
  if (!state.me) return;
  const was = invUi.kind;
  invUi.rows = new Map();
  buildInvColumns();
  if ((state.container?.kind || null) !== was || !invUi.view) invUi.view = state.container ? 'here' : invUi.view || 'pack';
  applyInvView();
  renderInvDetail();
}
function buildInvColumns() {
  const me = state.me;
  const inv = me.inv, c = state.container;
  if ((c?.kind || null) !== invUi.kind) { invUi.kind = c?.kind || null; invUi.tab = 'contents'; invUi.menuFor = null; }
  const put = !!c?.canPut;
  // ---- you
  // Three columns side by side: what you have on (guns with their parts), your backpack and supplies,
  // and what's here (the ground around you, or the stash, bag or body you opened).
  const you = $('youCol'); you.innerHTML = '';
  you.append(head('Gear'));
  for (const slot of ['primary', 'primary2', 'secondary', 'armor']) {
    const it = inv[slot], label = SLOT_LABEL[slot];
    you.append(...invRow(`eq-${slot}`, it
      ? { item: it, tag: label, hot: !!it.hot, title: it.name, detail: `${label} · ${statLine(it)}`, color: it.kind === 'weapon' ? (PAINTS[it.paint]?.color || '#888') : '#5aa8ff', actions: it.kind === 'weapon' ? [partsAction(it), ['Unequip', () => send({ t: 'inv', action: 'unequip', slot })]] : [['Unequip', () => send({ t: 'inv', action: 'unequip', slot })]] }
      : { title: 'Empty', tag: label, detail: `Nothing in ${label.toLowerCase()}. Equip one from your backpack.`, why: 'Pick something in the Backpack tab and equip it.' }));
  }
  if (state.devKit) you.append(...invRow('devgunsmith', { title: 'Gunsmith (testing: works anywhere)', detail: 'Try every scope, part and paint on any gun you carry', color: '#ff7a1a', actions: [['Open', openGunsmith]] }));
  const packEl = $('packCol'); packEl.innerHTML = '';
  const full = inv.pack.length / (state.packSize || 1);
  packEl.append(head(`Backpack · ${inv.pack.length} of ${state.packSize}`));
  const bar = document.createElement('div');
  bar.className = `capbar${full >= 1 ? ' full' : full > 0.8 ? ' near' : ''}`;
  bar.innerHTML = `<i style="width:${Math.min(100, full * 100).toFixed(1)}%"></i>`;
  packEl.append(bar);
  if (!inv.pack.length) packEl.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing in your backpack.' }));
  inv.pack.forEach((it) => {
    const actions = [];
    if (it.kind === 'weapon' && it.archetype !== 'sidearm') {
      // Two main guns: put it in either slot (it swaps with what's there).
      for (const slot of ['primary', 'primary2']) actions.push([inv[slot] ? `${SLOT_LABEL[slot]}: swap for ${inv[slot].name}` : `Carry as ${SLOT_LABEL[slot].toLowerCase()}`, () => send({ t: 'inv', action: 'equip', itemId: it.id, slot })]);
    } else if (it.kind === 'weapon' || it.kind === 'armor') actions.push(['Equip', () => send({ t: 'inv', action: 'equip', itemId: it.id })]);
    if (it.kind === 'medkit') actions.push(['Use', () => send({ t: 'inv', action: 'use' })]);
    if (it.kind === 'lockbox') actions.push(['Break it open', () => { send({ t: 'inv', action: 'breakbox', itemId: it.id }); closeInventory(); }]);
    if (it.kind === 'flare') actions.push(['Fire it', () => { send({ t: 'inv', action: 'flare', itemId: it.id }); closeInventory(); }]);
    if (it.kind === 'hotflare') actions.push(['Fire it: hot drop', () => { send({ t: 'inv', action: 'hotdrop', itemId: it.id }); closeInventory(); }]);
    if (put) actions.push(['Put in stash', () => send({ t: 'container', action: 'put', itemId: it.id })]);
    if (it.kind !== 'package') actions.push(['Drop', () => send({ t: 'inv', action: 'drop', itemId: it.id })]);
    packEl.append(...invRow(`pk-${it.id}`, { item: it, hot: !!it.hot, title: it.name, detail: statLine(it), extra: attachmentLine(it), color: it.kind === 'weapon' ? (PAINTS[it.paint]?.color || '#888') : it.kind === 'armor' ? '#5aa8ff' : '#5a5f68', actions }));
  });
  const carried = RES_UI.filter((r) => me[r]);
  packEl.append(head('Supplies'));
  if (!carried.length) packEl.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No supplies.' }));
  for (const r of carried.filter((q) => !GROUPED.has(q))) {
    const actions = [];
    if (put && r !== 'intel') actions.push(['Put in stash', () => send({ t: 'container', action: 'put', res: r })]);
    packEl.append(...invRow(`rs-${r}`, { title: resText(r, me[r]), detail: RES_USE[r] || '', color: '#3f4650', actions, why: c ? '' : 'Carried' }));
  }
  const foods = FOOD_GOODS.filter((r) => me[r]), trades = TRADE_GOODS.filter((r) => me[r]);
  const list = (rs, src) => rs.map((r) => resText(r, src[r])).join(' · ');
  if (foods.length) {
    const best = foods[0], actions = [[`Eat ${GOODS[best].name} (+${GOODS[best].food} food)`, () => send({ t: 'inv', action: 'eat', good: best })]];
    if (put) actions.push(['Put food in stash', () => { for (const r of foods) send({ t: 'container', action: 'put', res: r }); }]);
    packEl.append(...invRow('rs-food', { title: `Food · ${foods.reduce((n, r) => n + me[r], 0)}`, detail: `${list(foods, me)}. Eat it when you're hungry (cooked meals fill you most); sell the rest at a trading post.`, color: '#3f4650', actions }));
  }
  if (trades.length) {
    const actions = put ? [['Put them in stash', () => { for (const r of trades) send({ t: 'container', action: 'put', res: r }); }]] : [];
    packEl.append(...invRow('rs-trade', { title: `Trade goods · ${trades.reduce((n, r) => n + me[r], 0)}`, detail: `${list(trades, me)}. Sell at a trading post${me.seeds ? ' (seed packets: plant them in a farm plot)' : ''}.`, color: '#3f4650', actions, why: c ? '' : 'Carried' }));
  }
  $('packcount').textContent = `Carrying ${inv.pack.length} of ${state.packSize} · ${me.ammo} rounds`;
  // ---- the stash, bag or body beside you; or, with nothing open, what's on the ground nearby
  const col = $('containerCol');
  if (!c) {
    const ground = [...state.loot.values()].map((l) => [Math.hypot(l.data.x - state.x, l.data.z - state.z), l.data]).filter(([d]) => d < 5).sort((a, b) => a[0] - b[0]);
    col.hidden = false;
    col.innerHTML = '';
    col.append(head('On the ground nearby'));
    if (!ground.length) col.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing on the ground within reach. Loot glows with a beam of light: walk up to it.' }));
    if (ground.length > 1) col.append(...invRow('g-all', { title: 'Take everything here', detail: `${ground.length} things`, color: '#7dff9a', actions: [['Take everything', () => { for (const [, l] of ground) send({ t: 'takeLoot', id: l.id }); }]] }));
    for (const [, l] of ground) col.append(...invRow(`g-${l.id}`, { lootKind: l.kind, title: `${l.name}${l.amount ? ` ×${l.amount}` : ''}`, detail: lootCategory(l.kind) === 'gear' ? 'Goes in your backpack' : 'Goes in your supplies', color: `#${(LOOT_COLORS[l.kind] ?? 0x5a5f68).toString(16).padStart(6, '0')}`, actions: [['Take', () => send({ t: 'takeLoot', id: l.id })]] }));
    return;
  }
  col.hidden = false;
  col.innerHTML = '';
  col.append(head(`${c.title}${c.cap ? ` · ${c.items.length} of ${c.cap}` : ''}`));
  const own = !!c.gunsmith;
  if (own) {
    const tabs = document.createElement('div');
    tabs.className = 'invtabs'; tabs.dataset.navrow = '1';
    for (const [k, label] of [['contents', 'Stash'], ['upgrades', 'Upgrades'], ['craft', 'Craft'], ['home', 'Home & raids']]) {
      const b = btn(label, () => { invUi.tab = k; invUi.menuFor = null; renderInventory(); }, `invtab${invUi.tab === k ? ' on' : ''}`);
      b.dataset.pad = `tab-${k}`;
      tabs.append(b);
    }
    col.append(tabs);
  }
  const tab = own ? invUi.tab : 'contents';
  if (tab === 'contents') {
    if (own) {
      const n = me.intel + (c.intel || 0);
      col.append(...invRow('gunsmith', { title: 'Gunsmith', detail: 'Change parts, build guns and armor', color: '#ff7a1a', actions: [['Open', openGunsmith]] }));
      col.append(...invRow('intel', { title: `Upload intel: ${n}`, detail: n ? `+${n * 40} XP` : 'Bring intel home from terminals and Rogues', color: '#ff7a1a', actions: n ? [['Upload', () => send({ t: 'container', action: 'bank' })]] : [], why: 'No intel' }));
      col.append(...invRow('travel', { title: 'Fast travel', detail: 'To a Contact you have found, or your crew', color: '#ff7a1a', actions: [['Choose where', () => { closeInventory(); openMapScreen('travel'); }]] }));
    }
    if (c.raid) col.append(raidPanel(c));
    if (c.ruin) col.append(...invRow('ruin', { title: 'Rebuild this stash house', detail: `It's a ruin. Needs a hammer and ${costText(c.ruin.cost)} carried.`, color: '#ff6b6b', actions: [['Rebuild', () => send({ t: 'rebuild' })]] }));
    const takeable = !c.raid?.sealed && (RES_UI.some((r) => c[r]) || c.items.length);
    if ((c.kind === 'bag' || c.raid) && takeable) {
      col.append(...invRow('takeall', { title: 'Take everything', detail: c.raid ? 'As much as one raid can carry off' : 'Into your backpack and supplies', color: '#7dff9a', actions: [['Take everything', () => {
        for (const r of RES_UI) if (c[r]) send({ t: 'container', action: 'take', res: r });
        for (const it of c.items) send({ t: 'container', action: 'take', itemId: it.id });
      }]] }));
    }
    if (put && carried.some((r) => r !== 'intel')) {
      col.append(...invRow('putall', { title: 'Put all supplies in the stash', detail: carried.filter((r) => r !== 'intel').map((r) => resText(r, me[r])).join(' · '), color: '#7dff9a', actions: [['Put them all in', () => { for (const r of carried) if (r !== 'intel') send({ t: 'container', action: 'put', res: r }); }]] }));
    }
    const res = RES_UI.filter((r) => c[r]);
    if (!c.items.length && !res.length) col.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Empty.' }));
    const canTake = (r) => (c.raid ? Math.min(c[r], c.raid.res[r] || 0) : c[r]);
    for (const r of res.filter((q) => !GROUPED.has(q))) {
      const can = canTake(r);
      col.append(...invRow(`cr-${r}`, { title: resText(r, c[r]), detail: c.raid ? `You can take ${can}` : RES_USE[r] || '', color: '#3f4650', actions: can > 0 && !c.raid?.sealed ? [[`Take ${can}`, () => send({ t: 'container', action: 'take', res: r })]] : [], why: c.raid?.sealed ? 'Sealed' : 'Raid limit reached' }));
    }
    for (const [key, name, group] of [['food', 'Food', FOOD_GOODS], ['trade', 'Trade goods', TRADE_GOODS]]) {
      const rs = group.filter((r) => c[r]);
      if (!rs.length) continue;
      const take = rs.filter((r) => canTake(r) > 0);
      col.append(...invRow(`cr-${key}`, { title: `${name} · ${rs.reduce((n, r) => n + c[r], 0)}`, detail: rs.map((r) => resText(r, c[r])).join(' · '), color: '#3f4650',
        actions: take.length && !c.raid?.sealed ? [['Take it all', () => { for (const r of take) send({ t: 'container', action: 'take', res: r }); }]] : [], why: c.raid?.sealed ? 'Sealed' : 'Raid limit reached' }));
    }
    const blocked = c.raid && (c.raid.sealed || c.raid.items <= 0);
    for (const it of c.items) {
      const actions = blocked ? [] : [['Take', () => send({ t: 'container', action: 'take', itemId: it.id })]];
      if (!blocked && (it.kind === 'weapon' || it.kind === 'armor')) actions.push(['Take and equip', () => { send({ t: 'container', action: 'take', itemId: it.id }); send({ t: 'inv', action: 'equip', itemId: it.id }); }]);
      col.append(...invRow(`ci-${it.id}`, { item: it, title: it.name, detail: statLine(it), extra: attachmentLine(it), color: it.kind === 'weapon' ? (PAINTS[it.paint]?.color || '#888') : it.kind === 'armor' ? '#5aa8ff' : '#5a5f68', actions, why: c.raid?.sealed ? 'Sealed' : 'Raid limit reached' }));
    }
  } else if (tab === 'upgrades') {
    const hl = c.home?.level ?? 1, have = (k) => (k === 'comms' ? me.comms : (me[k] || 0) + (c[k] || 0));
    for (const [key, u] of Object.entries(UPGRADES)) {
      const tier = c.upg[key] || 0, next = u.tiers[tier + 1];
      const lack = next && (hl < next.home ? `Needs home level ${next.home}` : !Object.entries(next.cost).every(([k, v]) => have(k) >= v) ? `Needs ${costText(next.cost)}` : '');
      col.append(...invRow(`up-${key}`, { title: `${u.name}: ${u.tiers[tier].label}`, detail: u.desc, extra: next ? `Next: ${next.label} · ${costText(next.cost)}` : 'Fully upgraded', color: '#ffc53d', actions: next && !lack ? [[`Install ${next.label}`, () => send({ t: 'upgrade', track: key })]] : [], why: next ? lack : 'Done' }));
    }
  } else if (tab === 'craft') {
    const have = (k) => (me[k] || 0) + (c[k] || 0);
    for (const [key, d] of Object.entries(CRAFTS)) {
      const lack = me.level < d.level ? `Needs level ${d.level}` : !Object.entries(d.cost).every(([k, v]) => have(k) >= v) ? `Needs ${Object.entries(d.cost).map(([k, v]) => `${v} ${k}`).join(', ')}` : '';
      col.append(...invRow(`cf-${key}`, { title: d.name, detail: TOOLS[key]?.desc || d.desc || '', extra: Object.entries(d.cost).map(([k, v]) => `${v} ${k}`).join(' · '), color: '#9fe39f', actions: lack ? [] : [['Craft', () => send({ t: 'craft', item: key })]], why: lack }));
    }
  } else if (tab === 'home' && c.home) {
    const h = c.home;
    const lo = HOME_LEVEL_XP[h.level - 1], hi = HOME_LEVEL_XP[h.level] ?? lo;
    const info = document.createElement('div');
    info.className = 'raidnote';
    info.innerHTML = `<b>${h.name} · home level ${h.level}</b>${h.level >= MAX_HOME_LEVEL ? 'Top level.' : `${h.xp - lo} of ${hi - lo} home XP to level ${h.level + 1} (${HOME_LEVEL_TEXT[h.level]}).`} Now: +${h.perks.storage} slots, door ×${h.perks.doorMul.toFixed(2)}, ${feet(h.perks.radius)} claim, ${h.perks.buildCap} structures. Home XP comes from upgrades, building inside your claim, uploading intel here, and holding it.`;
    col.append(info);
    if (h.raid) col.append(raidWindowPanel(h));
    col.append(...invRow('abandon', { title: 'Abandon this stash house', detail: 'Anything left inside can be taken by anyone', color: '#ff6b6b', actions: [['Yes, abandon it', () => send({ t: 'abandon' })], ['Keep it', () => {}]] }));
  }
}

function openInventory() {
  invUi.menuFor = null;
  state.invOpen = true;
  $('inventory').hidden = false;
  document.exitPointerLock?.();
  renderInventory();
}
function closeInventory() {
  state.invOpen = false;
  $('inventory').hidden = true;
  if (state.container) { state.container = null; send({ t: 'closeContainer' }); }
}

// ------------------------------------------------------------------ stash house upgrades
function costText(cost) {
  return Object.entries(cost).map(([k, v]) => (k === 'comms' ? `${v} ★` : resText(k, v))).join(' · ');
}
/** Someone else's stash: whether it can be raided now, and how much one raid can carry off. */
function raidPanel(c) {
  const r = c.raid, el = document.createElement('div');
  el.className = 'raidnote';
  el.innerHTML = r.sealed
    ? `<b>🔒 Sealed</b>Everyone who lives here is offline. You can look, but nothing can be taken until their raid window: ${r.window} (county time).`
    : `<b>Raid limit</b>One raid carries off ${Math.round(r.share * 100)}% of what was here${r.mode === 'window' ? ' (they are all away)' : ''}: ${r.items} more item${r.items === 1 ? '' : 's'}, and the amounts shown for supplies. The rest stays in their strongbox for a day.`;
  return el;
}
/** Your raid window: when your base can be raided while all of you are offline. */
function raidWindowPanel(h) {
  const r = h.raid, wrap = document.createElement('div');
  wrap.className = 'upgrades';
  const pick = r.next ?? r.start;
  wrap.innerHTML = `<h2>Raid window</h2>
    <div class="st">Now: <b>${windowText(r.start)}</b> (county time).${r.next != null ? ` Changes to <b>${windowText(r.next)}</b> from ${new Date(r.nextAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} your time.` : ''}</div>
    <div class="st" style="margin:6px 0">While anyone who lives here is online, your base can be attacked at any hour, so come defend it. Once you're all offline: outside the window it's <b>sealed</b>; inside it, it takes ${Math.round(r.offlineMul * 100)}% damage. A raid can carry off ${Math.round(r.share * 100)}% of a stash (${Math.round(r.shareOnline * 100)}% if you're around). A new window starts a day after you set it.</div>`;
  const row = document.createElement('div');
  row.className = 'item';
  const label = Object.assign(document.createElement('div'), { className: 'meta', innerHTML: `<div class="nm">Start at ${hourLabel(pick)}</div><div class="st">${windowText(pick)}</div>` });
  const earlier = btn('Earlier', () => send({ t: 'raidWindow', start: (pick + 23) % 24 })), later = btn('Later', () => send({ t: 'raidWindow', start: (pick + 1) % 24 }));
  earlier.dataset.pad = 'rw-earlier'; later.dataset.pad = 'rw-later';
  row.dataset.navrow = '1';
  row.append(label, earlier, later);
  wrap.append(row);
  return wrap;
}

// ------------------------------------------------------------------ contacts (contracts + field requisitions)
function openContact() {
  state.contactOpen = true;
  $('contactpanel').hidden = false;
  document.exitPointerLock?.();
  renderContact();
}
function closeContact() {
  if (!state.contactOpen) return;
  state.contactOpen = false;
  $('contactpanel').hidden = true;
  lockPointer();
}
/** Lamar's Pawn: his case of guns and armor, what he'd pay for yours, and goods both ways. */
function renderPawn(c, me, box) {
  const t = c.trade, tsend = (m) => send({ t: 'trade', npcId: c.npc, ...m });
  const row = (title, detail, extra, color, button) => {
    const r = document.createElement('div');
    r.className = 'item';
    r.innerHTML = `<div class="meta"><div class="nm"><span class="swatch" style="background:${color}"></span>${esc(title)}</div><div class="st">${detail}</div>${extra ? `<div class="st">${extra}</div>` : ''}</div>`;
    r.append(button);
    col.append(r);
  };
  const head = (text) => { const h = document.createElement('h3'); h.textContent = text; col.append(h); };
  box.innerHTML = `<p class="sub" style="text-align:left">You have <b>$${me.cash || 0}</b>. Lamar buys guns and armor at half what they're worth (more for good attachments) and sells at full price. Whatever anyone sells him goes in his case. No fighting in the shop.</p><div class="pawncols"><div></div><div></div></div>`;
  const [left, right] = box.querySelectorAll('.pawncols > div');
  let col = left;   // the case on the left; selling and supplies on the right
  head(`In the case · ${t.case.length}`);
  if (!t.case.length) col.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'The case is empty. New pieces come in through the day.' }));
  for (const it of t.case) {
    const b = btn(`Buy $${it.price}`, () => tsend({ action: 'buyItem', itemId: it.id }), '');
    b.disabled = (me.cash || 0) < it.price || me.inv.pack.length >= state.packSize;
    row(it.name, statLine(it), it.kind === 'weapon' ? attachmentLine(it) : '', it.kind === 'weapon' ? (PAINTS[it.paint]?.color || '#888') : '#5aa8ff', b);
  }
  col = right;
  head('Sell to Lamar');
  if (!t.offers.length) col.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'You have no guns or armor to sell.' }));
  for (const o of t.offers) {
    const where = o.slot === 'pack' ? 'in your backpack' : o.slot === 'armor' ? 'you are wearing it' : o.slot === me.active ? 'in your hands' : `carried (${SLOT_LABEL[o.slot].toLowerCase()})`;
    row(o.name, `${statLine(o)} · ${where}`, '', o.kind === 'weapon' ? (PAINTS[o.paint]?.color || '#888') : '#5aa8ff', btn(`Sell for $${o.pays}`, () => tsend({ action: 'sellItem', itemId: o.id }), ''));
  }
  const sellable = t.sells.filter((x) => me[x.good] > 0);
  if (sellable.length) {
    head('Sell goods');
    for (const x of sellable) {
      const r = document.createElement('div');
      r.className = 'item';
      r.innerHTML = `<div class="meta"><div class="nm">${GOODS[x.good]?.icon || ''} ${resText(x.good, me[x.good])}</div><div class="st">pays $${x.pays} each</div></div>`;
      r.append(btn('Sell 1', () => tsend({ action: 'sell', good: x.good, qty: 1 })), btn(`Sell all ($${x.pays * me[x.good]})`, () => tsend({ action: 'sell', good: x.good, qty: 'all' }), ''));
      col.append(r);
    }
  }
  head('Supplies');
  for (const it of t.shop) {
    const b = btn(`$${it.price}`, () => tsend({ action: 'buy', item: it.id }), '');
    b.disabled = (me.cash || 0) < it.price;
    row(`${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}`, '', '', '#5a5f68', b);
  }
}
function renderTrade(c, me) {
  const box = $('ctTrade');
  if (!box) return;
  const solo = !!(c.npc || c.stall || c.dock);
  $('ctColContracts').hidden = solo; $('ctColQm').hidden = solo;
  $('contactpanel').classList.toggle('solo', solo);
  $('ctTradeTitle').textContent = c.dock ? 'Landing' : c.stall ? 'Stall' : c.npc ? 'Trade' : 'Trading post';
  if (c.dock) return renderDock(c, me, box);
  if (c.trade?.pawn) return renderPawn(c, me, box);
  if (c.stall) return renderStall(c, me, box);
  if (!c.trade) return;
  const tsend = (m) => send({ t: 'trade', contactId: c.id, npcId: c.npc || undefined, ...m });
  box.innerHTML = c.npc ? `<p class="sub" style="text-align:left">You have <b>$${me.cash || 0}</b>. ${c.trade.who === 'Travelling merchant' ? 'Merchants pay close to the best price anywhere, and roam between towns.' : c.trade.who === 'Camp trader' ? 'River people sell tupelo honey, moonshine and gator hides cheap, and pay well for what they can\'t make out here. Towns far from the river pay most for swamp goods.' : c.trade.who === 'Dockhand' ? 'Buys at nine-tenths of town prices, right at the water.' : 'Settlers sell what they grow or catch, cheap.'}</p>`
    : `<p class="sub" style="text-align:left">You have <b>$${me.cash || 0}</b>. Prices here reflect what ${c.trade.town} has plenty of — haul goods to where they're scarce.</p>`;
  // County fair: hand in meat for the hunting contest.
  const fair = c.fair && (state.worldEvents || []).find((e) => e.type === 'fair');
  if (fair) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">🏆 Hunting contest</div><div class="st">${(fair.board || []).map((r, i) => `${i + 1}. ${r.name} — ${r.meat}`).join(' · ') || 'No entries yet'}</div></div>`;
    const b = btn(`Hand in ${me.meat || 0} meat`, () => send({ t: 'fairSubmit' }), '');
    b.disabled = !(me.meat > 0);
    row.append(b);
    box.append(row);
  }
  const sellable = c.trade.sells.filter((x) => me[x.good] > 0);
  if (sellable.length) {
    const h = document.createElement('h3'); h.textContent = 'Sell'; box.append(h);
    for (const x of sellable) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<div class="meta"><div class="nm">${GOODS[x.good]?.icon || ''} ${resText(x.good, me[x.good])}</div><div class="st">pays $${x.pays} each</div></div>`;
      row.append(btn('Sell 1', () => tsend({ action: 'sell', good: x.good, qty: 1 })), btn(`Sell all ($${x.pays * me[x.good]})`, () => tsend({ action: 'sell', good: x.good, qty: 'all' }), ''));
      box.append(row);
    }
  }
  const h = document.createElement('h3'); h.textContent = 'Buy'; box.append(h);
  for (const it of c.trade.shop) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${GOODS[it.id]?.icon || ''} ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}</div></div>`;
    const b = btn(`$${it.price}`, () => tsend({ action: 'buy', item: it.id }), '');
    b.disabled = (me.cash || 0) < it.price;
    row.append(b);
    box.append(row);
  }
  const prices = document.createElement('div');
  prices.className = 'sub'; prices.style.textAlign = 'left'; prices.style.fontSize = '11px';
  prices.textContent = 'Pays: ' + c.trade.sells.map((x) => `${x.name} $${x.pays}`).join(' · ');
  box.append(prices);
  if (c.npc) return;
  // Freight: carry a load to another town's post.
  if (c.hauls?.length) {
    const h = document.createElement('h3'); h.textContent = 'Freight jobs'; box.append(h);
    for (const j of c.hauls) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<div class="meta"><div class="nm">📦 ${j.label} → ${j.toTown}</div><div class="st">${distText(j.km * 1000)} · no helicopters or fast travel with freight</div></div>`;
      row.append(btn(`Take ($${j.pay})`, () => send({ t: 'haul', contactId: c.id, id: j.id }), ''));
      box.append(row);
    }
  }
  // Market board: what players are selling at their stalls around the map.
  const hb = document.createElement('h3'); hb.textContent = 'Market board — player stalls'; box.append(hb);
  if (!c.board?.length) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No player stalls are selling yet. Build a Market stall to be the first.' }));
  for (const r of c.board || []) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${GOODS[r.res]?.icon || ''} ${r.qty} ${r.name} · $${r.price} each</div><div class="st">${r.seller}'s stall near ${r.near} · ${distText(r.dist)}</div></div>`;
    row.append(btn('Mark', () => { state.pings.push({ x: r.x, z: r.z, from: `${r.seller}'s stall`, objective: false, until: performance.now() + 600_000 }); toast(`Marked ${r.seller}'s stall`); }));
    box.append(row);
  }
}
function renderDock(c, me, box) {
  const row = (html) => { const r = document.createElement('div'); r.className = 'item'; r.innerHTML = `<div class="meta">${html}</div>`; box.append(r); return r; };
  const head = (t) => box.append(Object.assign(document.createElement('div'), { className: 'nm', style: 'margin:12px 0 4px;color:#ffa64d;font-weight:700', textContent: t }));
  box.innerHTML = `<p class="sub" style="text-align:left">You have <b>$${me.cash || 0}</b>. ${c.camp ? `The landing for ${c.camp}. ` : ''}The river is the one road the Rogues don't own. You own ${c.owned} of ${c.maxOwned} boats.</p>`;
  head('Boats');
  for (const s of c.shop) {
    const r = row(`<div class="nm">🚤 ${s.name}</div><div class="st">${s.about} Seats ${s.seats} · hold ${s.hold} loads.</div>`);
    const col = Object.assign(document.createElement('div'), { style: 'display:flex;flex-direction:column;gap:4px;flex:none' });
    const b = btn(`Buy $${s.price}`, () => send({ t: 'dock', id: c.id, action: 'buy', type: s.type }), '');
    b.disabled = (me.cash || 0) < s.price || c.owned >= c.maxOwned;
    col.append(b);
    if (s.craft) {
      const cb = btn(`Build: ${costText(s.craft)}`, () => send({ t: 'dock', id: c.id, action: 'buy', type: s.type, pay: 'craft' }), '');
      cb.disabled = c.owned >= c.maxOwned || Object.entries(s.craft).some(([k, v]) => (me[k] || 0) < v);
      col.append(cb);
    }
    r.append(col);
  }
  if (c.boats.length) {
    head('Your boats at this landing');
    for (const b of c.boats) {
      const r = row(`<div class="nm">${b.name} · hull ${b.hp}/${b.max}</div><div class="st">Hold: ${b.free} free${b.cargo.length ? ` · carrying ${b.cargo.map((x) => x.name).join(', ')}` : ''}</div>`);
      if (b.repair) { const rb = btn(`Repair $${b.repair}`, () => send({ t: 'dock', id: c.id, action: 'repair', boat: b.id }), ''); rb.disabled = (me.cash || 0) < b.repair; r.append(rb); }
    }
  }
  head('River freight');
  box.append(Object.assign(document.createElement('p'), { className: 'sub', style: 'text-align:left;margin:0 0 6px', textContent: 'Bulk loads that only fit in a boat\'s hold. Moor at this landing with room in the hold, load up, and deliver at the other landing. Sink and it\'s lost.' }));
  if (!c.freight.length) row('<div class="st">No loads waiting. Check back later.</div>');
  const room = c.boats.some((b) => b.free > 0);
  for (const j of c.freight) {
    const r = row(`<div class="nm">📦 ${j.label} → ${j.toName}</div><div class="st">${distText(j.km * 1000)} · pays $${j.pay}</div>`);
    const b = btn('Load it', () => send({ t: 'dock', id: c.id, action: 'freight', job: j.id }), '');
    b.disabled = !room;
    if (!room) b.title = 'Moor a boat of yours here with room in its hold';
    r.append(b);
  }
}
const stallDraft = { res: '', qty: 1, price: 10 };   // the listing you're filling in
function renderStall(c, me, box) {
  const S = c.stallData;
  const hadFocus = ['stRes', 'stQty', 'stPrice'].includes(document.activeElement?.id) ? document.activeElement.id : null;
  if (hadFocus) setTimeout(() => { const el = $(hadFocus); if (el) { if (state.inputMode === 'pad') padFocus(el); else el.focus(); } }, 0);
  box.innerHTML = '';
  if (S.mine) {
    box.innerHTML = `<p class="sub" style="text-align:left">Goods listed here sell while you're away; buyers' cash goes in the till. Listed on every trading post's market board.</p>`;
    const till = document.createElement('div'); till.className = 'item';
    till.innerHTML = `<div class="meta"><div class="nm">💰 Till: $${S.till}</div></div>`;
    const cb = btn('Collect', () => send({ t: 'stall', id: c.stall, action: 'collect' }), ''); cb.disabled = !S.till; till.append(cb); box.append(till);
    // New listing: pick something you carry, how many, and a price.
    const row = document.createElement('div'); row.className = 'item';
    const sel = Object.assign(document.createElement('select'), { id: 'stRes' });
    for (const r of RES_UI) if (r !== 'cash' && r !== 'intel' && me[r]) sel.append(Object.assign(document.createElement('option'), { value: r, textContent: resText(r, me[r]) }));
    if ([...sel.options].some((o) => o.value === stallDraft.res)) sel.value = stallDraft.res;
    const qty = Object.assign(document.createElement('input'), { id: 'stQty', type: 'number', min: 1, max: me[sel.value] || 1, value: Math.min(stallDraft.qty, me[sel.value] || 1), style: 'width:60px', title: 'How many' });
    const price = Object.assign(document.createElement('input'), { id: 'stPrice', type: 'number', min: 1, max: 9999, value: stallDraft.price, style: 'width:70px', title: 'Price each ($)' });
    sel.onchange = () => { stallDraft.res = sel.value; qty.max = me[sel.value] || 1; if (Number(qty.value) > Number(qty.max)) qty.value = qty.max; };
    qty.oninput = () => { stallDraft.qty = Number(qty.value) || 1; };
    price.oninput = () => { stallDraft.price = Number(price.value) || 1; };
    row.append(sel, qty, Object.assign(document.createElement('span'), { textContent: '× $' }), price, btn('List', () => send({ t: 'stall', id: c.stall, action: 'list', res: sel.value, qty: qty.value, price: price.value }), ''));
    if (sel.options.length) box.append(row); else box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Carry some goods to list them.' }));
  }
  if (!S.listings.length) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nothing for sale.' }));
  for (const l of S.listings) {
    const row = document.createElement('div'); row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${GOODS[l.res]?.icon || ''} ${l.qty} ${l.name}</div><div class="st">$${l.price} each</div></div>`;
    if (S.mine) row.append(btn('Unlist', () => send({ t: 'stall', id: c.stall, action: 'unlist', i: l.i })));
    else {
      const b1 = btn(`Buy 1 ($${l.price})`, () => send({ t: 'stall', id: c.stall, action: 'buy', i: l.i, qty: 1 }), '');
      const ba = btn(`Buy all ($${l.price * l.qty})`, () => send({ t: 'stall', id: c.stall, action: 'buy', i: l.i, qty: 'all' }));
      b1.disabled = (me.cash || 0) < l.price; ba.disabled = (me.cash || 0) < l.price * l.qty;
      row.append(b1, ba);
    }
    box.append(row);
  }
}
function renderContact() {
  const c = state.contact, me = state.me;
  if (!c || !me) return;
  renderTrade(c, me);
  $('ctTitle').textContent = c.name;
  $('ctComms').textContent = `★ ${me.comms} commendations`;
  const offers = $('ctOffers'); offers.innerHTML = '';
  for (const o of c.offers) {
    const def = CONTRACT_TYPES[o.type];
    const d = distText(Math.hypot(o.x - state.x, o.z - state.z));
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${def.name} <small class="muted">${d} away</small></div><div class="st">${def.desc}</div><div class="at">Reward: ${Object.entries(def.reward).map(([k, v]) => `${v} ${k === 'comms' ? '★' : k}`).join(' · ')} · ${def.xp} XP</div></div>`;
    const b = btn('Accept', () => send({ t: 'acceptContract', contactId: c.id, id: o.id }));
    b.disabled = state.contracts.length >= 2;
    row.append(b);
    offers.append(row);
  }
  const active = $('ctActive'); active.innerHTML = '';
  if (!state.contracts.length) active.innerHTML = '<div class="empty">No active contracts (max 2).</div>';
  for (const ct of state.contracts) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${CONTRACT_TYPES[ct.type].name}</div><div class="st">${distText(Math.hypot(ct.x - state.x, ct.z - state.z))} · expires in ${Math.max(0, Math.round((ct.expires - Date.now()) / 60000))} min</div></div>`;
    row.append(btn('Abandon', () => send({ t: 'abandonContract', id: ct.id })));
    active.append(row);
  }
  // Quartermaster: field gear bought with commendations (earned only from contracts and events).
  const qm = $('ctShop'); qm.innerHTML = '';
  {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">🚁 Helicopter extraction</div><div class="st">Fire a flare and hold within ${feet(EXTRACT.radius)} of it for ${EXTRACT.holdMs / 1000} seconds. The helicopter flies you, any squadmates in the zone and everything you carry to your stash house. Everyone within ${distText(EXTRACT.alertRange)} sees the flare.</div></div>`;
    const b = btn('Call it', () => { send({ t: 'extract' }); closeContact(); });
    b.disabled = !me.claim;
    if (!me.claim) b.title = 'Claim a stash house first';
    row.append(b);
    qm.append(row);
    const taxi = document.createElement('div');
    taxi.className = 'item';
    taxi.innerHTML = `<div class="meta"><div class="nm">🚁 Helicopter taxi</div><div class="st">Fly to any landing zone, Contact or the airstrip. $${HELI.airTaxi.baseFare} plus $${HELI.airTaxi.perMile} a mile; it lands in ${HELI.airTaxi.waitMs / 1000} seconds. Crewmates with you ride free.</div></div>`;
    taxi.append(btn('Where to?', () => { closeContact(); send({ t: 'taxi', action: 'menu' }); }));
    qm.append(taxi);
  }
  {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">Claim marker</div><div class="st">Plant it to make a room, house, cave, vehicle or patch of ground your stash house.</div></div>`;
    const b = btn(`${CLAIM.markerPrice.parts} parts`, () => send({ t: 'buyMarker', contactId: c.id }));
    b.disabled = me.parts < CLAIM.markerPrice.parts;
    row.append(b);
    qm.append(row);
  }
  const entries = [
    ...Object.entries(PARTS).filter(([, d]) => d.field).map(([id, d]) => ['part', id, d, `Attachment · ${SLOT_LABELS[d.slot]}`]),
    ...Object.entries(ARMORS).filter(([, d]) => d.field).map(([id, d]) => ['armor', id, d, `Armor blueprint · ${d.armor} armor`]),
    ...Object.entries(PAINTS).filter(([, d]) => d.field).map(([id, d]) => ['paint', id, d, 'Paint']),
    ...Object.entries(FIELD_PERKS).map(([id, d]) => ['perk', id, d, d.desc]),
  ];
  for (const [kind, id, d, sub] of entries) {
    const owned = me.field.includes(id);
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">★ ${d.name}</div><div class="st">${sub}${d.level > 1 ? ` · level ${d.level}+` : ''}</div></div>`;
    if (owned) row.insertAdjacentHTML('beforeend', '<small class="good">OWNED</small>');
    else {
      const b = btn(`★ ${d.field}`, () => send({ t: 'requisition', contactId: c.id, kind, id }));
      b.disabled = me.comms < d.field || me.level < (d.level || 1);
      row.append(b);
    }
    qm.append(row);
  }
}

/** High-value sites (shared/sites.js): gold while stocked, flashing red on alarm, grey once cleared. */
function siteColor(st, now) {
  if (st.state === 'alarm') return Math.floor(now / 300) % 2 ? '#ff3b3b' : null;
  return st.state === 'cleared' ? '#8a8f96' : '#ffcc33';
}
function siteStatus(st) {
  if (st.state === 'cleared') return `cleared · restocks in ${Math.max(1, Math.ceil((st.restockAt - Date.now()) / 60000))} min`;
  const guards = SITES.kinds[st.kind].guard === 'guard' ? 'guarded' : 'held by looters';
  return `${st.state === 'alarm' ? '🚨 ALARM · ' : ''}${guards} · ${st.left} to take`;
}
/** The site you're at, if any. */
function siteHere() {
  return (state.sites || []).find((st) => Math.hypot(st.x - state.x, st.z - state.z) < st.r + 60) || null;
}

/** Active contracts shown under the kill feed. */
function renderTracker() {
  const el = $('tracker');
  if (document.body.classList.contains('touchui')) {
    const z = state.hotZone, now = Date.now();
    const c = state.contracts[0];
    const here = siteHere();
    el.innerHTML = carryingHot() ? '<div class="hotc carry">🔥 Hot loot: get it home</div>'
      : here ? `<div class="sitec ${here.state}">${SITES.kinds[here.kind].icon} ${here.name} · ${siteStatus(here)}</div>`
      : z ? `<div class="hotc">🔥 ${z.name.replace(/ \(.*\)$/, '')} · ${distText(Math.hypot(z.x - state.x, z.z - state.z))} · ${z.open ? 'closes' : 'opens'} ${mmss((z.open ? z.closesAt : z.opensAt) - now)}</div>`
        : c ? `<div>★ ${CONTRACT_TYPES[c.type].name} <span>${distText(Math.hypot(c.x - state.x, c.z - state.z))}</span></div>` : '';
    return;
  }
  const here = siteHere();
  el.innerHTML = (here ? `<div class="sitec ${here.state}">${SITES.kinds[here.kind].icon} ${here.name} <span>${siteStatus(here)}</span></div>` : '') +
    (state.hotZone ? `<div class="hotc">${hotZoneLine()}</div>` : '') +
    (carryingHot() ? '<div class="hotc carry">🔥 You carry hot loot: everyone sees you every 30 s. Get it home or fly it out.</div>' : '') +
    state.contracts.map((c) => `<div>★ ${CONTRACT_TYPES[c.type].name} <span>${distText(Math.hypot(c.x - state.x, c.z - state.z))}</span></div>`).join('') +
    (state.worldEvents || []).map((e) => `<div class="eventc">📣 ${e.name} <span>${e.type === 'swing' ? '' : `${distText(Math.hypot(e.x - state.x, e.z - state.z))} · `}${Math.max(0, Math.ceil((e.endsAt - Date.now()) / 60000))} min left</span></div>`).join('');
}
setInterval(() => { if (state.map) renderTracker(); }, 1000);

// ------------------------------------------------------------------ map screen (M), deploy + fast travel
const mapView = { cx: 0, cz: 0, zoom: 1 };
// Your waypoint: a personal marker you set on the map. Pings go to your crew.
const wpKey = () => `dz_wp_${state.worldId || 1}`;
function loadWaypoint() { try { state.waypoint = JSON.parse(localStorage.getItem(wpKey()) || 'null'); } catch { state.waypoint = null; } }
function setWaypoint(x, z) {
  state.waypoint = x == null ? null : { x: Math.round(x), z: Math.round(z) };
  try { if (state.waypoint) localStorage.setItem(wpKey(), JSON.stringify(state.waypoint)); else localStorage.removeItem(wpKey()); } catch { /* private mode */ }
  if (state.waypoint) toast(`Waypoint set · ${distText(Math.hypot(x - state.x, z - state.z))} away`);
  if (state.mapOpen) renderMapScreen();
}
function mapPing(x, z) {
  send({ t: 'squad', action: 'ping', x, z });
  toast(state.squad?.id ? 'Pinged for your crew' : 'Pinged (in a crew, they would see it too)');
}
function openMapScreen(mode, opts = null) {
  state.mapOpen = true;
  state.mapMode = mode;
  if (opts) opts.at = performance.now();
  state.deployOpts = opts || state.deployOpts;
  state.mapPick = null; state.mapHover = null;
  $('mapscreen').hidden = false;
  document.exitPointerLock?.();
  if (mode === 'view' || mode === 'travel') { mapView.cx = state.x; mapView.cz = state.z; mapView.zoom = 14; }
  else if (mode === 'taxi') { mapView.cx = state.x; mapView.cz = state.z; mapView.zoom = 1.4; }   // most of the county, centred on you   // close enough to read the street names around you
  else { mapView.cx = 0; mapView.cz = 0; mapView.zoom = 1; }
  renderMapScreen();
}
function closeMapScreen() {
  state.mapOpen = false;
  $('mapscreen').hidden = true;
  if (state.mapMode === 'view' || state.mapMode === 'travel' || state.mapMode === 'taxi') lockPointer();
}
const HOME_ICONS = { house: '🏠', cave: '⛰', rockfort: '🪨', treehut: '🌳', boathouse: '⚓' };
const HOME_NAMES = { house: 'Town house', cave: 'Mountain cave', rockfort: 'Rock formation', treehut: 'Giant tree hut', boathouse: 'Boathouse' };
function homeLabel(id, icon = false) {
  const map = state.map, h = map.houses[id];
  if (h.townId !== null) return `${icon ? '🏠 ' : ''}${map.towns[h.townId].name}`;
  const near = map.towns.reduce((a, t) => (!a || Math.hypot(t.x - h.x, t.z - h.z) < Math.hypot(a.x - h.x, a.z - h.z) ? t : a), null);
  return `${icon ? HOME_ICONS[h.kind] + ' ' : ''}${HOME_NAMES[h.kind]} near ${near.name}`;
}
/** The options the side list shows for the current mode. */
/** What's still counting down on the redeploy screen (ms), from when the options arrived. */
function respawnLeft() {
  const r = state.deployOpts?.respawn, since = performance.now() - (state.deployOpts?.at || 0);
  if (!r) return { wait: 0, crew: 0, away: 0 };
  return { wait: Math.max(0, r.waitMs - since), crew: Math.max(0, r.crewWaitMs - since), away: r.away ? Math.max(0, r.away.ms - since) : 0, spot: r.away, radius: r.keepAway, deaths: r.deaths };
}
/** One row per town you can start or come back in. */
function townRows(towns) {
  return (towns || []).map((t) => ({ label: `🏙 ${t.name}${t.county ? ` (${t.county} Co.)` : ''}`, x: t.x, z: t.z, msg: { t: 'deploy', kind: 'town', id: t.id }, color: '#ffd29a' }));
}
/** Landing zones by the area they're named for ("LZ H (Bristol)" → Bristol), in map order. */
function lzGroups(ids) {
  const groups = new Map();
  for (const id of ids) {
    const lz = state.map.landingZones[id], area = /\(([^)]+)\)/.exec(lz.name)?.[1] || 'the wilds';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(lz);
  }
  return groups;
}
/** One row per area: drop at a random landing zone there (pick a particular one on the map). */
function lzRows(ids, t = 'deploy') {
  return [...lzGroups(ids)].map(([area, lzs]) => ({ t,
    label: `🪂 Landing zone near ${area} (${lzs.length})`, group: lzs.map((l) => l.id), noMarker: true, color: '#e0e0e0',
    x: lzs.reduce((a, l) => a + l.x, 0) / lzs.length, z: lzs.reduce((a, l) => a + l.z, 0) / lzs.length,
    get msg() { return { t: this.t, kind: 'lz', id: lzs[Math.floor(Math.random() * lzs.length)].id }; },
  }));
}
/** Every single place on the map you can tap to pick (the list's area rows split into their zones). */
function mapTargets() {
  const out = mapOptions().filter((o) => !o.noMarker);
  for (const o of mapOptions()) if (o.group) for (const id of o.group) { const lz = state.map.landingZones[id]; out.push({ label: `🪂 ${lz.name}`, x: lz.x, z: lz.z, msg: { t: o.t || 'deploy', kind: 'lz', id }, color: '#e0e0e0' }); }
  return out;
}
function mapOptions() {
  const map = state.map, o = state.deployOpts || {};
  const town = (h) => homeLabel(h);
  if (state.mapMode === 'first') {
    // First deploy: any real town, or a landing zone out in the wilds. You claim a stash house
    // afterwards by planting your claim marker.
    return [
      ...(o.crew || []).map((m) => ({ label: `👥 Deploy with ${m.name} (crew)`, x: m.x, z: m.z, msg: { t: 'deploy', kind: 'crew', id: m.id }, color: '#7dff9a' })),
      ...townRows(o.towns),
      ...lzRows(map.landingZones.map((lz) => lz.id)),
    ];
  }
  if (state.mapMode === 'redeploy') {
    // After a death: a wait first, and nothing near where you died for a while except home.
    const rs = respawnLeft();
    const shut = (opt, { home = false, crew = false } = {}) => {
      if (rs.wait > 0) return Object.assign(opt, { disabled: true, why: `in ${Math.ceil(rs.wait / 1000)}s` });
      if (crew && rs.crew > 0) return Object.assign(opt, { disabled: true, why: `crew drop again in ${Math.ceil(rs.crew / 60000)} min` });
      if (!home && rs.away > 0 && Math.hypot(opt.x - rs.spot.x, opt.z - rs.spot.z) < rs.radius) return Object.assign(opt, { disabled: true, why: `too close to where you died · ${Math.ceil(rs.away / 60000)} min` });
      return opt;
    };
    const list = [];
    if (o.claim) list.push(shut({ label: `⌂ ${o.claim.name}`, x: o.claim.x, z: o.claim.z, msg: { t: 'deploy', kind: 'home' }, color: '#4fbf6a' }, { home: true }));
    for (const h of o.hideouts || []) list.push(shut({ label: `⛺ Hideout ${h.n}`, x: h.x, z: h.z, msg: { t: 'deploy', kind: 'hideout', id: h.id }, color: '#9fe39f' }));
    for (const r of townRows(o.towns)) list.push(shut(r));
    return list;
  }
  if (state.mapMode === 'taxi' && state.taxi) {
    const t = state.taxi, list = [];
    if (!t.from.startsWith('as')) list.push({ label: '🚁 Extraction home (free · hold the flare 60 s)', x: state.x, z: state.z, msg: { t: 'extract' }, color: '#ff7a1a', close: true });
    for (const d of [...t.dests].sort((a, b) => a.fare - b.fare)) {
      list.push({ label: `🚁 ${d.name} · ${d.miles} mi · $${d.fare}${t.cash < d.fare ? ' (not enough cash)' : ''}`, x: d.x, z: d.z, msg: { t: 'taxi', action: 'call', to: d.id }, color: '#e0e0e0', close: true });
    }
    return list;
  }
  if (state.mapMode === 'travel') {
    const list = (state.me?.hideouts || []).map((h) => ({ label: `⛺ Hideout ${h.n}`, x: h.x, z: h.z, msg: { t: 'travel', kind: 'hideout', id: h.id }, color: '#9fe39f' }));
    list.push(...(state.me?.discovered || []).map((id) => ({ label: map.contacts[id].name, x: map.contacts[id].x, z: map.contacts[id].z, msg: { t: 'travel', kind: 'contact', id }, color: '#7fd6ff' })));
    for (const m of state.squad.members) if (m.online && m.id !== state.id) list.push({ label: `Join ${m.name}`, x: m.x, z: m.z, msg: { t: 'travel', kind: 'squad', id: m.id }, color: '#7dff9a' });
    list.push(...lzRows(map.landingZones.map((l) => l.id), 'travel'));
    return list;
  }
  return [];
}
function renderMapScreen() {
  if (!state.mapOpen || !state.map) return;
  const titles = { taxi: state.taxi ? `Helicopter from ${state.taxi.fromName}` : 'Helicopter', first: 'Where do you want to start?', redeploy: state.killedBy ? `Killed by ${state.killedBy} — redeploy` : 'Deploy', travel: 'Fast travel (from your stash house)', view: 'Map' };
  const notes = {
    first: 'Pick a town, or a landing zone out in the woods. Then find somewhere to call home and plant your claim marker: a house, cave, fish camp, old RV or houseboat, or open ground.',
    redeploy: 'You dropped everything you carried in a bag where you fell. Level, unlocks and your stash are safe. Come back at your stash house, a hideout or any town, but nothing inside the red circle round where you died for 5 minutes. From your stash house, fast travel takes you to landing zones and your crew.',
    travel: 'Fast travel goes out from your stash house to your hideouts, Contacts you have found, landing zones (tap one on the map for an exact one) and your crew. Getting loot home is still on foot. Not within about a mile of where you last died for 5 minutes, and joining your crew works once every 5 minutes.',
    taxi: `Pick where to fly. You jump from ${feet(HELI.airTaxi.jump.alt, 50)} over a random spot ${distText(HELI.airTaxi.dropMin)}–${distText(HELI.airTaxi.dropMax)} out from it and steer down by parachute or squirrel suit, so nobody can camp it. It lands here in 20 seconds: stay on the pad (leave, go down or get shot at and it turns back, no charge). You pay when you board; crewmates on the pad ride free. No freight. You have $${state.taxi?.cash ?? 0}.${state.taxi?.readyIn ? ` The pilot can fly again in ${Math.ceil(state.taxi.readyIn / 1000)}s.` : ''}`,
    view: 'Orange ring 🔥 the hot zone (the faint ring a mile out: no taxi drops, fast travel or respawns inside it) · orange ● its crates · green ● its pickup point · Gold ◆ contracts · red ● supply drops · red ◆ extraction flares and lit-up enemies · orange ◆ enemy stash houses you hacked · blue ✦ Contacts (dim = undiscovered) · green = home & squad · purple ◆ world events · small blue ● ⚓ river landings · pale green ◆ 🏕 swamp camps (by boat). Call extraction at any Contact or landing zone.',
  };
  $('mapTitle').textContent = titles[state.mapMode];
  $('mapNote').textContent = notes[state.mapMode];
  if (state.mapMode === 'view') {
    $('mapNote').textContent = '';
    const key = document.createElement('details');
    key.className = 'mapkey';
    key.innerHTML = `<summary>Map key</summary><div>${notes.view}</div>`;
    $('mapNote').append(key);
  }
  if (state.mapMode === 'first' || state.mapMode === 'redeploy') $('mapNote').textContent += ' Tap a spot on the map to pick it.';
  if (state.mapMode === 'redeploy') {
    const rs = respawnLeft();
    if (rs.wait > 0) $('mapNote').textContent = `Back in ${Math.ceil(rs.wait / 1000)}s${rs.deaths > 1 ? ` — that's ${rs.deaths} deaths in 10 minutes, so the wait is longer` : ''}. ` + $('mapNote').textContent;
  }
  const list = $('mapList'); list.innerHTML = '';
  const pick = state.mapPick;
  if (pick) {
    // Tapped on the map: say which, and confirm (so a stray tap never sends you somewhere).
    const box = document.createElement('div');
    box.className = 'mappick';
    box.append(Object.assign(document.createElement('div'), { className: 'nm', textContent: pick.label }));
    const go = btn(state.mapMode === 'taxi' ? 'Fly here' : 'Start here', () => { state.mapPick = null; send(pick.msg); if (pick.close) closeMapScreen(); }, '');
    go.disabled = !!pick.disabled;
    box.append(go, btn('Cancel', () => { state.mapPick = null; renderMapScreen(); }, 'ghost'));
    list.append(box);
  }
  const opts = mapOptions();
  for (const o of opts) {
    const b = btn(o.why ? `${o.label} — ${o.why}` : o.label, () => { state.mapPick = null; send(o.msg); if (o.close) closeMapScreen(); });
    b.className = 'gsweapon';
    b.disabled = !!o.disabled;
    b.onmouseenter = () => { state.mapHover = o; drawMapCanvas(); };
    list.append(b);
  }
  if (state.mapMode === 'view') {
    const pad = state.inputMode === 'pad';
    const touchy = document.body.classList.contains('touchui');
    list.append(Object.assign(document.createElement('div'), { className: 'mapnote', textContent: pad ? 'The cross in the middle is your pointer: slide the map with the right stick, zoom with LT / RT.' : touchy ? 'Tap to set a waypoint. Drag to move, pinch (or + and −) to zoom.' : 'Click the map to set a waypoint, right-click to ping your crew. Drag to move, wheel to zoom.' }));
    // With a controller the cross in the middle is the pointer, so these buttons are how you mark it. With a
    // mouse or a finger you just click or tap the map, so they'd only repeat that: a ping at the waypoint instead.
    if (pad) list.append(btn('Set waypoint here (Ⓧ)', () => setWaypoint(mapView.cx, mapView.cz), 'gsweapon'), btn('Ping crew here (Ⓨ)', () => mapPing(mapView.cx, mapView.cz), 'gsweapon'));
    else if (state.waypoint) list.append(btn('Ping crew at the waypoint', () => mapPing(state.waypoint.x, state.waypoint.z), 'gsweapon'));
    if (state.waypoint) list.append(btn('Clear waypoint', () => setWaypoint(null), 'gsweapon'), btn('Show waypoint', () => { mapView.cx = state.waypoint.x; mapView.cz = state.waypoint.z; drawMapCanvas(); }, 'gsweapon'));
  }
  if (state.mapMode === 'view' || state.mapMode === 'travel' || state.mapMode === 'taxi') list.append(btn('Close', closeMapScreen));
  drawMapCanvas();
}
setInterval(() => {
  if (!state.mapOpen || state.mapMode !== 'redeploy') return;
  const rs = respawnLeft();
  if (rs.wait <= 0 && !state.respawnTicking) return;
  state.respawnTicking = rs.wait > 0;
  const focus = document.activeElement && $('mapList').contains(document.activeElement) ? [...$('mapList').querySelectorAll('button')].indexOf(document.activeElement) : -1;
  renderMapScreen();
  if (focus >= 0) $('mapList').querySelectorAll('button')[focus]?.focus();
}, 1000);
function drawMapCanvas() {
  const cv = $('mapcanvas');
  const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2.5);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  cv._dpr = dpr;
  const map = state.map, markers = [];
  const dim = new Set(state.me?.discovered || []);
  for (const c of map.contacts) markers.push({ x: c.x, z: c.z, kind: 'diamond', color: dim.has(c.id) ? '#7fd6ff' : '#3a5560', size: 5 });
  const deploying = state.mapMode === 'first' || state.mapMode === 'redeploy';
  if (state.mapMode === 'redeploy') {
    const rs = respawnLeft();
    if (rs.away > 0) { markers.push({ x: rs.spot.x, z: rs.spot.z, kind: 'ring', radius: rs.radius, color: '#ff4d4d' }); markers.push({ x: rs.spot.x, z: rs.spot.z, kind: 'diamond', color: '#ff4d4d', size: 7, label: 'Where you died', labelMin: 0 }); }
  }
  const lit = new Set(state.mapHover?.group || []);
  const lzPick = state.mapMode === 'first' || state.mapMode === 'travel';
  // A site's marker carries its name: drop the plain place label underneath it.
  for (const l of map.labels || []) if (l.kind === 'place' && ['prison', 'sheriff', 'hospital'].includes(l.place)) l.hidden = (state.sites || []).some((q) => Math.hypot(q.x - l.x, q.z - l.z) < 500);
  for (const st of state.sites || []) {
    const c = siteColor(st, Date.now()) || '#ff3b3b';
    markers.push({ x: st.x, z: st.z, kind: 'diamond', color: c, size: st.kind === 'prison' ? 10 : 8, label: `${SITES.kinds[st.kind].icon} ${st.name.replace('Correctional Institution', 'CI')}${st.state === 'stocked' ? '' : st.state === 'alarm' ? ' · 🚨 ALARM' : ' · cleared'}`, labelMin: st.kind === 'prison' || st.kind === 'hospital' ? 0 : 0.08 });
  }
  for (const lz of map.landingZones) markers.push({ x: lz.x, z: lz.z, color: lit.has(lz.id) ? '#ff7a1a' : '#cfcfcf', size: lzPick ? 6 : 4, highlight: lit.has(lz.id), label: lzPick ? lz.name.split(' (')[0] : '', labelMin: 0 });
  for (const ct of state.contracts) markers.push({ x: ct.x, z: ct.z, kind: 'diamond', color: '#ffc53d', size: 7, label: CONTRACT_TYPES[ct.type].name });
  for (const d of state.drops) markers.push({ x: d.x, z: d.z, color: '#ff3b3b', size: 7, label: 'Supply drop' });
  if (state.hotZone) {
    const hz = state.hotZone;
    markers.push({ x: hz.x, z: hz.z, kind: 'ring', radius: hz.radius, color: '#ff5a1f' });
    markers.push({ x: hz.x, z: hz.z, kind: 'ring', radius: HELI.hotZone.keepOutM, color: 'rgba(255,90,31,0.45)' });
    markers.push({ x: hz.x, z: hz.z, kind: 'diamond', color: '#ff5a1f', size: 9, label: `🔥 ${hotZoneLine().replace(/^🔥 Hot zone: /, 'Hot zone: ')}`, labelMin: 0 });
    for (const c of hz.crates) if (!c.opened) markers.push({ x: c.x, z: c.z, color: '#ff5a1f', size: 5 });
    if (hz.extract) markers.push({ x: hz.extract.x, z: hz.extract.z, color: '#5dff8a', size: 7, label: 'Hot-zone pickup', labelMin: 0 });
  }
  for (const a of state.alerts) if (a.hot && a.until > performance.now()) markers.push({ x: a.x, z: a.z, kind: 'diamond', color: '#ff5a1f', size: 7, label: 'Hot loot' });
  for (const d of map.docks) markers.push({ x: d.x, z: d.z, color: '#7fd6ff', size: 4, label: d.campId != null ? '' : `⚓ ${d.name}` });
  for (const c of map.camps) markers.push({ x: c.x, z: c.z, kind: 'diamond', color: '#9fe39f', size: 6, label: `🏕 ${c.name}` });
  for (const [, v] of boatVis) if (v.data.mine && state.me?.boat?.id !== v.data.id) markers.push({ x: v.mesh.position.x, z: v.mesh.position.z, color: '#7dff9a', size: 5, label: `${BOATS[v.data.type].icon || '🚤'} ${BOATS[v.data.type].name}` });
  for (const e of state.worldEvents || []) {
    markers.push({ x: e.x, z: e.z, kind: 'diamond', color: '#c77dff', size: 9, label: `📣 ${e.name}` });
    if (e.radius) markers.push({ x: e.x, z: e.z, kind: 'ring', radius: e.radius, color: '#c77dff' });
  }
  // Enemies lit up by a hack, a scan, a tag or a sensor, and any enemy stash house you've located.
  const pnow = performance.now();
  for (const [id, e] of state.exposed) {
    if (e.until < pnow) continue;
    const c = state.players.get(id)?.data || state.bots.get(id)?.data;
    if (c && !c.dead) markers.push({ x: c.x, z: c.z, kind: 'diamond', color: '#ff4d4d', size: 6, label: state.players.has(id) ? c.name : '' });
  }
  if (state.enemyStash && state.enemyStash.untilPerf > pnow) markers.push({ x: state.enemyStash.x, z: state.enemyStash.z, kind: 'diamond', color: '#ff8a2a', size: 9, label: `🏠 ${state.enemyStash.owner}'s stash` });
  for (const e of state.extracts) markers.push({ x: e.x, z: e.z, kind: 'diamond', color: '#ff2a2a', size: 8, label: `🚁 Extraction (${e.by})` });
  for (const m of state.squad.members) if (m.online && m.id !== state.id) markers.push({ x: m.x, z: m.z, color: '#7dff9a', size: 5, label: m.name });
  for (const p of state.pings) if (p.objective) markers.push({ x: p.x, z: p.z, kind: 'diamond', color: '#ffc53d', size: 6, label: 'Objective' });
  const hpos = homePos();
  if (hpos) markers.push({ x: hpos.x, z: hpos.z, color: '#4fbf6a', size: 7, label: `Home (Lv${state.me.claim.level})` });
  for (const h of state.me?.hideouts || []) markers.push({ x: h.x, z: h.z, color: '#9fe39f', size: 6, label: `⛺ Hideout ${h.n}`, labelMin: 0 });
  for (const o of mapOptions()) { if (o.noMarker) continue; const hl = state.mapHover?.label === o.label; markers.push({ x: o.x, z: o.z, color: o.color, size: 6, highlight: hl, label: hl ? o.label : '' }); }
  if (state.mapPick) markers.push({ x: state.mapPick.x, z: state.mapPick.z, kind: 'diamond', color: '#ff7a1a', size: 10, highlight: true, label: state.mapPick.label.replace(/^\S+ /, '') });
  if (state.waypoint) markers.push({ x: state.waypoint.x, z: state.waypoint.z, kind: 'diamond', color: '#ff7a1a', size: 8, label: `Waypoint · ${distText(Math.hypot(state.waypoint.x - state.x, state.waypoint.z - state.z))}` });
  if (state.me && !state.me.dead) markers.push({ x: state.x, z: state.z, kind: 'player', yaw: state.yaw, color: '#5aa8ff', size: 7 });
  // The road you're on is always named on the map, whatever the zoom.
  const here = state.me && !state.me.dead ? state.map.roadsNear(state.x, state.z, 25).filter((r) => r.name).sort((a, b) => distToSeg(state.x, state.z, a) - distToSeg(state.x, state.z, b))[0] : null;
  state.mapProj = drawMap(cv, map, state.mapBase, mapView, markers, here ? here.name : null);
  if (state.mapMode === 'view') {
    // The pointer for the controller: waypoints and pings go where the cross is.
    const g = cv.getContext('2d'), cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
    g.strokeStyle = '#000'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx - 12, cy); g.lineTo(cx + 12, cy); g.moveTo(cx, cy - 12); g.lineTo(cx, cy + 12); g.stroke();
    g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - 11, cy); g.lineTo(cx + 11, cy); g.moveTo(cx, cy - 11); g.lineTo(cx, cy + 11); g.stroke();
  }
}
$('mapcanvas').addEventListener('click', (e) => {
  if (!state.mapProj) return;
  const r = e.target.getBoundingClientRect();
  const w = state.mapProj.toWorld(e.clientX - r.left, e.clientY - r.top);
  // Pick the nearest option within ~20 px.
  let best = null, bd = 20 / state.mapProj.k;
  for (const o of mapTargets()) { const d = Math.hypot(o.x - w.x, o.z - w.z); if (d < bd) { bd = d; best = o; } }
  if (state.mapMode === 'view') { if (!mapDragMoved) setWaypoint(w.x, w.z); return; }
  if (mapDragMoved) return;
  if (best) { state.mapPick = best; renderMapScreen(); $('mapList').scrollTop = 0; }
  else if (state.mapMode === 'first') {
    // Clicking a specific free house on the map claims that one.
    let bh = null, bhd = 30 / state.mapProj.k;
    for (const id of state.deployOpts?.freeHouses || []) { const hh = state.map.houses[id]; const d = Math.hypot(hh.x - w.x, hh.z - w.z); if (d < bhd) { bhd = d; bh = id; } }
    if (bh !== null) send({ t: 'deploy', kind: 'claim', id: bh });
  }
});
$('mapcanvas').addEventListener('wheel', (e) => { e.preventDefault(); mapView.zoom = Math.max(1, Math.min(60, mapView.zoom * (e.deltaY < 0 ? 1.25 : 0.8))); drawMapCanvas(); }, { passive: false });
let mapDrag = null, mapDragMoved = false;
// Two fingers: pinch to zoom, keeping the spot between them under your fingers. One: drag.
const mapTouches = new Map();
let mapPinch = null;
$('mapcanvas').addEventListener('pointerdown', (e) => {
  mapTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (mapTouches.size === 2) {
    const [a, b] = [...mapTouches.values()], r = $('mapcanvas').getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    mapPinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: mapView.zoom, w: state.mapProj?.toWorld(mx, my) };
    mapDrag = null; mapDragMoved = true;
    return;
  }
  mapDrag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cz: mapView.cz }; mapDragMoved = false;
});
$('mapcanvas').addEventListener('pointermove', (e) => {
  if (!mapTouches.has(e.pointerId)) return;
  mapTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!mapPinch || mapTouches.size < 2 || !state.mapProj) return;
  const [a, b] = [...mapTouches.values()], r = $('mapcanvas').getBoundingClientRect();
  const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
  mapView.zoom = Math.max(1, Math.min(60, mapPinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / mapPinch.d));
  drawMapCanvas();
  if (mapPinch.w) {   // slide so the place you pinched on stays between your fingers
    const now = state.mapProj.toWorld(mx, my);
    mapView.cx += mapPinch.w.x - now.x; mapView.cz += mapPinch.w.z - now.z;
    drawMapCanvas();
  }
});
for (const ev of ['pointerup', 'pointercancel']) $('mapcanvas').addEventListener(ev, (e) => {
  mapTouches.delete(e.pointerId);
  if (mapTouches.size < 2) mapPinch = null;
  if (mapTouches.size === 1) { const [t] = [...mapTouches.values()]; mapDrag = { x: t.x, y: t.y, cx: mapView.cx, cz: mapView.cz }; }
});
$('mapcanvas').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.mapMode !== 'view' || !state.mapProj) return;
  const r = e.target.getBoundingClientRect(), w = state.mapProj.toWorld(e.clientX - r.left, e.clientY - r.top);
  mapPing(w.x, w.z);
});
addEventListener('pointerup', () => { mapDrag = null; });
addEventListener('pointermove', (e) => {
  if (!mapDrag || !state.mapProj || mapPinch) return;
  if (Math.hypot(e.clientX - mapDrag.x, e.clientY - mapDrag.y) > 6) mapDragMoved = true;
  mapView.cx = mapDrag.cx - (e.clientX - mapDrag.x) / state.mapProj.k;
  mapView.cz = mapDrag.cz - (e.clientY - mapDrag.y) / state.mapProj.k;
  drawMapCanvas();
});
$('mapZoomIn').onclick = () => { mapView.zoom = Math.min(60, mapView.zoom * 1.5); drawMapCanvas(); };
$('mapZoomOut').onclick = () => { mapView.zoom = Math.max(1, mapView.zoom / 1.5); drawMapCanvas(); };

// ------------------------------------------------------------------ gunsmith
const gs = { selectedId: null, slot: 'optic', hover: null, explode: 0, explodeTarget: 0, model: null, modelKey: '' };
const gsRenderer = new THREE.WebGLRenderer({ canvas: $('gsview'), antialias: true, alpha: true, preserveDrawingBuffer: true });
gsRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const gsScene = new THREE.Scene();
const gsCamera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
gsScene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4));
const gsKey = new THREE.DirectionalLight(0xffffff, 3); gsKey.position.set(1, 2, 2); gsScene.add(gsKey);
const gsRim = new THREE.DirectionalLight(0xbcd6ff, 2.2); gsRim.position.set(-2, 1, -2); gsScene.add(gsRim);   // a cool edge light so dark guns read against the panel
const gsTurntable = new THREE.Group(); gsScene.add(gsTurntable);

function ownedWeapons() {
  const me = state.me, out = [];
  if (!me) return out;
  for (const slot of ['primary', 'primary2', 'secondary']) if (me.inv[slot]) out.push({ item: me.inv[slot], where: slot });
  for (const i of me.inv.pack) if (i.kind === 'weapon') out.push({ item: i, where: 'backpack' });
  if (state.container?.gunsmith) for (const i of state.container.items) if (i.kind === 'weapon') out.push({ item: i, where: 'stash' });
  return out;
}

function openGunsmith() {
  state.gunsmithOpen = true;
  state.invOpen = false;   // the bag is closed while the gunsmith is up (left open, it stopped your gun firing afterwards)
  $('inventory').hidden = true;
  $('gunsmith').hidden = false;
  const list = ownedWeapons();
  if (!list.some((w) => w.item.id === gs.selectedId)) gs.selectedId = list[0]?.item.id ?? null;
  renderGunsmith();
}
function closeGunsmith() {
  state.gunsmithOpen = false;
  $('gunsmith').hidden = true;
  if (state.container) openInventory();
  else { state.invOpen = false; lockPointer(); }
}
$('gsClose').onclick = closeGunsmith;
$('gsExplode').onclick = () => { gs.explodeTarget = gs.explodeTarget ? 0 : 1; };

function previewItem(item, hover) {
  if (!hover) return item;
  if (hover.paint) return { ...item, paint: hover.paint };
  return { ...item, parts: { ...item.parts, [hover.slot]: hover.partId } };
}

function renderStatBars(item, preview) {
  const cur = weaponStats(item), nxt = weaponStats(preview);
  const a = statBars(cur), b = statBars(nxt);
  const el = $('gsStats'); el.innerHTML = '';
  for (const k of Object.keys(a)) {
    const lo = Math.min(a[k], b[k]), hi = Math.max(a[k], b[k]);
    const better = b[k] > a[k];
    const row = document.createElement('div');
    row.className = 'statrow';
    row.innerHTML = `<span>${k}</span><div class="sbar"><i style="width:${lo * 100}%"></i>${hi > lo ? `<b class="${better ? 'up' : 'down'}" style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></b>` : ''}</div>`;
    el.append(row);
  }
  const n = $('gsNumbers');
  const fmt = (x, y, f, suffix = '') => (Math.abs(f(x) - f(y)) > 0.0001 ? `${f(x)}${suffix} → <b>${f(y)}${suffix}</b>` : `${f(x)}${suffix}`);
  n.innerHTML = `Damage ${fmt(cur, nxt, (s) => Math.round(s.damage * s.pellets))} · RPM ${fmt(cur, nxt, (s) => Math.round(s.rpm))} · Mag ${fmt(cur, nxt, (s) => s.mag)}
    · Range ${fmt(cur, nxt, (s) => Math.round(s.range * 3.28084 / 5) * 5, ' ft')} · Reload ${fmt(cur, nxt, (s) => (s.reloadMs / 1000).toFixed(1), 's')} · Zoom ${fmt(cur, nxt, (s) => s.zoom.toFixed(1), 'x')}${nxt.zoomAlt ? ` (flips to <b>${(nxt.zoom + nxt.zoomAlt).toFixed(1)}x</b> with ${glyph('V')} while aiming)` : ''}
    · Against armor ${fmt(cur, nxt, (s) => Math.round(s.armor * 100), '%')} · Against health ${fmt(cur, nxt, (s) => Math.round(s.flesh * 100), '%')}${
  [['suppressed', 'Suppressed'], ['subsonic', 'Subsonic'], ['thermal', 'Thermal'], ['autoTag', 'Tags what you aim at'], ['rangefinder', 'Rangefinder'], ['glint', 'Lens glint']].filter(([k]) => nxt[k]).map(([, t]) => ` · <b>${t}</b>`).join('')}`;
}

function setPreviewModel(item) {
  const gun = item ? { a: item.archetype, parts: item.parts, paint: item.paint } : null;
  const key = gunKey(gun);
  if (key === gs.modelKey) return;
  gs.modelKey = key;
  gsTurntable.clear();
  gs.model = gun ? buildGunModel(gun) : null;
  if (gs.model) {
    // Fill the view (a pistol as big as a rifle) and centre the assembled gun on the turntable.
    const bb0 = new THREE.Box3().setFromObject(gs.model), sz = bb0.getSize(new THREE.Vector3());
    gs.model.scale.setScalar(1.05 / Math.max(sz.x, sz.y, sz.z, 0.05));
    const bb = new THREE.Box3().setFromObject(gs.model);
    const c = bb.getCenter(new THREE.Vector3());
    gs.model.position.set(-c.x, -c.y, -c.z);
    gsTurntable.add(gs.model);
  }
}

function renderGunsmith() {
  const me = state.me;
  if (!me || !state.gunsmithOpen) return;
  const totalParts = me.parts + (state.container?.parts || 0);
  $('gsParts').textContent = `${totalParts} parts${state.container?.parts ? ` (${me.parts} carried)` : ''}`;
  // Your guns across the top, and a chip to build a new one.
  const list = ownedWeapons();
  const building = gs.mode === 'build' || !list.length;
  const wl = $('gsWeapons'); wl.innerHTML = '';
  for (const { item, where } of list) {
    const b = document.createElement('button');
    b.className = 'gsweapon' + (!building && item.id === gs.selectedId ? ' sel' : '');
    b.dataset.pad = `gw-${item.id}`;
    b.innerHTML = `<b>${item.name}</b><small>${where}</small>`;
    b.onclick = () => { gs.mode = 'gun'; gs.selectedId = item.id; gs.hover = null; renderGunsmith(); };
    wl.append(b);
  }
  const nb = document.createElement('button');
  nb.className = 'gsweapon build' + (building ? ' sel' : '');
  nb.dataset.pad = 'gw-build';
  nb.innerHTML = '<b>+ Build new</b>';
  nb.onclick = () => { gs.mode = 'build'; gs.hover = null; renderGunsmith(); };
  wl.append(nb);

  const slotsEl = $('gsSlots'), opts = $('gsOptions');
  slotsEl.innerHTML = ''; opts.innerHTML = '';
  const colHead = (el, text) => el.append(Object.assign(document.createElement('div'), { className: 'colhead', textContent: text }));
  const item = building ? null : list.find((w) => w.item.id === gs.selectedId)?.item;
  if (!item) {
    // Build: guns in the first column, armor in the second; the cost on each button.
    $('gsTitle').textContent = 'Build new';
    setPreviewModel(null);
    $('gsStats').innerHTML = ''; $('gsNumbers').innerHTML = 'Build a new gun or armor from parts. It goes in your backpack.';
    const discount = UPGRADES.workbench.tiers[state.container?.upg?.workbench || 0].discount;
    const blueprint = (into, label, def, id, action, type) => {
      const locked = !isUnlocked(def, id, me);
      const cost = Math.round(def.cost * (1 - discount));
      const row = document.createElement('div');
      row.className = 'bprow' + (locked ? ' locked' : '');
      row.innerHTML = `<span>${def.field ? '★ ' : ''}${label}</span>`;
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = locked ? lockLabel(def) : cost ? `Build · ${cost}` : 'Build · free';
      b.disabled = locked || totalParts < cost;
      b.onclick = () => send({ t: 'gunsmith', action, type });
      row.append(b);
      into.append(row);
    };
    colHead(slotsEl, 'Guns');
    for (const [k, a] of Object.entries(ARCHETYPES)) blueprint(slotsEl, a.label, a, k, 'build', k);
    colHead(opts, 'Armor');
    for (const [k, a] of Object.entries(ARMORS)) blueprint(opts, `${a.name} (armor ${a.armor})`, a, k, 'buildArmor', k);
    return;
  }
  $('gsTitle').textContent = item.name;
  setPreviewModel(previewItem(item, gs.hover));
  renderStatBars(item, previewItem(item, gs.hover));
  // Slots: one line each, what's on it now.
  colHead(slotsEl, 'Slot');
  let firstFit = null;
  for (const slot of [...SLOTS, 'paint']) {
    const cur = slot === 'paint' ? PAINTS[item.paint]?.name : PARTS[item.parts[slot] || DEFAULT_PARTS[slot]]?.name;
    const anyFit = slot === 'paint' || Object.entries(PARTS).some(([id, p]) => p.slot === slot && partFits(id, item.archetype) && p.level > 1);
    if (anyFit && !firstFit) firstFit = slot;
    const b = document.createElement('button');
    b.className = 'gsslot' + (gs.slot === slot ? ' sel' : '');
    b.dataset.pad = `gs-${slot}`;
    b.innerHTML = `<small>${SLOT_LABELS[slot]}</small><b>${anyFit ? cur : '—'}</b>`;
    b.disabled = !anyFit;
    b.onclick = () => { gs.slot = slot; gs.hover = null; renderGunsmith(); const o = $('gsOptions'); o.scrollTop = 0; };
    slotsEl.append(b);
  }
  if (!gs.slot || (gs.slot !== 'paint' && !Object.entries(PARTS).some(([id, p]) => p.slot === gs.slot && partFits(id, item.archetype)))) gs.slot = firstFit || 'paint';
  // The parts for that slot, right beside it: each says what it does to the gun, one tap puts it on.
  colHead(opts, SLOT_LABELS[gs.slot] || 'Parts');
  const before = statBars(weaponStats(item));
  const delta = (hover) => {
    const after = statBars(weaponStats(previewItem(item, hover)));
    return Object.keys(before).map((k) => [k, after[k] - before[k]]).filter(([, d]) => Math.abs(d) > 0.015).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3)
      .map(([k, d]) => `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${k}</span>`).join(' ');
  };
  const option = (label, def, id, equipped, hover, onPick) => {
    const b = document.createElement('button');
    const locked = !isUnlocked(def, id, me);
    b.className = 'gsopt' + (equipped ? ' sel' : '') + (locked ? ' locked' : '');
    b.dataset.pad = `go-${id}`;
    const d = equipped || locked ? '' : delta(hover);
    b.innerHTML = `<span class="gsname"><span>${def.field ? '★ ' : ''}${label}</span>${locked ? `<small>${lockLabel(def)}</small>` : ''}</span>${d ? `<span class="gsdelta">${d}</span>` : equipped ? '' : def.style ? `<span class="gsdelta">${def.style}</span>` : ''}`;
    b.onmouseenter = () => { gs.hover = hover; setPreviewModel(previewItem(item, hover)); renderStatBars(item, previewItem(item, hover)); setExplode(gs.model, gs.explode, gs.slot); };
    b.onmouseleave = () => { gs.hover = null; setPreviewModel(item); renderStatBars(item, item); };
    if (!locked && !equipped) b.onclick = () => { gs.hover = null; onPick(); };
    opts.append(b);
  };
  if (gs.slot === 'paint') {
    for (const [id, p] of Object.entries(PAINTS)) {
      option(`<i class="swatch" style="background:${p.color}"></i>${p.name}`, p, id, item.paint === id, { paint: id }, () => send({ t: 'gunsmith', action: 'paint', itemId: item.id, paint: id }));
    }
  } else {
    for (const [id, p] of Object.entries(PARTS)) {
      if (p.slot !== gs.slot || !partFits(id, item.archetype)) continue;
      option(p.name, p, id, (item.parts[gs.slot] || DEFAULT_PARTS[gs.slot]) === id, { slot: gs.slot, partId: id }, () => send({ t: 'gunsmith', action: 'attach', itemId: item.id, slot: gs.slot, partId: id }));
    }
  }
}

/** "LVL 9" for level locks; "★3 at a Contact" for field gear you've reached the level for. */
function lockLabel(def) {
  const lvl = state.me?.level ?? 1;
  return def.field && lvl >= (def.level || 1) ? `★${def.field} · Contact` : `LVL ${def.level}`;
}

function drawGunsmith(dt) {
  if (!state.gunsmithOpen) return;
  const c = $('gsview');
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.floor(w * gsRenderer.getPixelRatio())) { gsRenderer.setSize(w, h, false); gsCamera.aspect = w / h; gsCamera.updateProjectionMatrix(); }
  gs.explode += (gs.explodeTarget - gs.explode) * Math.min(1, dt * 6);
  if (gs.model) setExplode(gs.model, gs.explode, gs.slot);
  gsTurntable.rotation.y += dt * 0.4;
  gsCamera.position.set(2.3, 0.6, 0);
  gsCamera.lookAt(0, 0, 0);
  gsRenderer.render(gsScene, gsCamera);
}

// ------------------------------------------------------------------ progression feedback
function xpPopup(amount, reason) {
  const el = document.createElement('div');
  el.textContent = `+${amount} XP  ${reason}`;
  $('xpfeed').prepend(el);
  while ($('xpfeed').children.length > 4) $('xpfeed').lastChild.remove();
  setTimeout(() => el.remove(), 2500);
}

function levelBanner(level, unlocks, title = 'LEVEL') {
  const el = $('levelup');
  el.innerHTML = `<h2>${title} ${level}</h2>${unlocks.length ? `<div>Unlocked: ${unlocks.map((u) => `<b>${u.name}</b>`).join(', ')}</div><small>Visit the gunsmith at your stash house</small>` : ''}`;
  el.hidden = false;
  el.animate([{ opacity: 0, transform: 'translate(-50%, -10px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 250 });
  clearTimeout(levelBanner.t);
  levelBanner.t = setTimeout(() => { el.hidden = true; }, 5000);
}

// ------------------------------------------------------------------ input
function lockPointer() {
  if (MOBILE || state.inputMode === 'pad') return;
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not supported */ }
}

/** One place for every gameplay action, shared by keyboard and controller. */
/** Jump (your client shows it at once; the server runs the same arc for everyone else and for hits). */
function jump() {
  const me = state.me, now = performance.now();
  if (!me || me.dead || me.downed || me.boat || state.air || state.hop || state.prone || now - (state.lastJump || 0) < 650 || build.on) return;
  state.lastJump = now;
  state.slide = null;   // a jump out of a slide keeps its speed, as momentum does
  state.crouch = false;
  if (climbLadder()) return;
  // Jump at a ledge, a fence, a car or a crate up to about 2 m high and you climb it: a jump just high
  // enough to clear it, carried forward onto it (or over a fence to the far side).
  const v = state.vel || [0, 0], sp = Math.hypot(v[0], v[1]);
  const dir = sp > 1 ? [v[0] / sp, v[1] / sp] : [Math.sin(state.yaw), Math.cos(state.yaw)];
  const h = climbAhead(solidsNear(state.x, state.z, 3), state.x, state.z, dir[0], dir[1], myY());
  if (h > 0) {
    state.hop = { alt: 0, vy: climbVy(h, JUMP_G), climb: 1 };
    state.climbPush = { until: now + 700, dir };
    send({ t: 'jump', climb: Math.round(h * 100) / 100 });
    return;
  }
  state.hop = { alt: 0, vy: JUMP_V };
  send({ t: 'jump' });
}
/** At the foot of a ladder: up it (JUMP or USE). Up you go at a steady pace and step off at the top. */
function climbLadder() {
  const lad = !state.hop && !state.air && !state.me?.boat && ladderAt(solidsNear(state.x, state.z, 3), state.x, state.z, myY());
  if (!lad) return false;
  state.hop = { alt: 0, vy: 0, ladder: lad.ladderTop - myY() + 0.35, dir: lad.ladderIn };
  state.slide = null; state.crouch = false; state.prone = false;
  state.vel = [0, 0];
  send({ t: 'jump', ladder: 1 });
  return true;
}
function doAction(a) {
  if (!state.me) return;
  if (a === 'interact' && !state.me.dead && !state.me.downed && /^🪜/.test(state.promptText || '') && climbLadder()) return;
  switch (a) {
    case 'squadPanel': if (state.panelOpen) closeSquadPanel(); else openSquadPanel(); return;
    case 'testRide': setTimeout(openRidePicker, 250); return;   // after the tap that asked for it has ended
    case 'map':
      if (state.mapOpen && (state.mapMode === 'view' || state.mapMode === 'travel')) closeMapScreen();
      else if (!state.mapOpen && !state.me.dead) openMapScreen('view');
      return;
    case 'inventory':
      if (state.me.dead) return;
      if (!state.invOpen && state.me.boat) { send({ t: 'boatHold' }); return; }
      if (state.invOpen) { state.gunsmithOpen = false; $('gunsmith').hidden = true; closeInventory(); lockPointer(); } else openInventory();
      return;
  }
  if (state.me.dead || state.invOpen || state.panelOpen || state.mapOpen || state.contactOpen) return;
  if (state.me.downed) { if (a === 'interact') send({ t: 'interact' }); else if (a === 'swap') send({ t: 'giveUp' }); else if (a === 'ping') { const p = aimPoint(); send({ t: 'squad', action: 'ping', x: p.x, z: p.z }); } return; }
  if (a === 'build') { toggleBuild(); return; }
  if (build.on) {
    // In build mode the same buttons drive building.
    switch (a) {
      case 'interact': send({ t: 'interact', build: true }); return;
      case 'reload': build.rot ^= 1; return;
      case 'tag': cyclePiece(1); return;
      case 'sensor': cyclePiece(-1); return;
      case 'swap': dismantleAimed(); return;
    }
  }
  switch (a) {
    case 'jump': jump(); break;
    case 'padA': if (state.promptText) { if (!(/^🪜/.test(state.promptText) && climbLadder())) send({ t: 'interact' }); } else jump(); break;   // controller A: use if there's something to use, else jump
    case 'interact': send({ t: 'interact' }); break;
    case 'tag': if (state.aimTargetId) send({ t: 'mark', id: state.aimTargetId }); break;
    case 'sensor': toggleNadeAim(); break;
    case 'switchGrenade':
      state.grenade = { frag: 'sensor', sensor: 'stun', stun: 'frag' }[state.grenade || 'frag'];
      toast(`Grenade: ${{ frag: 'Frag grenade', sensor: 'Sensor grenade', stun: 'Stun grenade' }[state.grenade]}`);
      updateGadgetBar();
      break;
    case 'camo':
      // While aiming through a two-range sight, the same button flips its magnification.
      if (state.aiming && weaponStats(state.me.inv[state.me.active])?.zoomAlt) { state.zoomAlt = !state.zoomAlt; break; }
      send({ t: 'camo' });
      break;
    case 'rally': send({ t: 'rally' }); break;
    case 'ping': { const p = aimPoint(); send({ t: 'squad', action: 'ping', x: p.x, z: p.z }); break; }
    case 'reload': if (state.me.mag < (weaponStats(state.me.inv[state.me.active])?.mag || 0) && reserveFor(state.me) > 0) { sfx.reload(); startReloadFx(); } send({ t: 'reload' }); break;
    case 'swap': send({ t: 'swap' }); break;
    case 'slot1': send({ t: 'weapon', slot: 'primary' }); break;
    case 'slot2': send({ t: 'weapon', slot: 'primary2' }); break;
    case 'slot3': send({ t: 'weapon', slot: 'secondary' }); break;
    case 'heal': send({ t: 'inv', action: 'use' }); break;
    case 'crouch': {
      // Crouch at a sprint: slide.
      const now = performance.now(), v = state.vel ? Math.hypot(state.vel[0], state.vel[1]) : 0;
      if (state.sprint && !state.prone && !state.hop && !state.air && v >= SLIDE.minSpeed && now >= (state.slideReadyAt || 0)) {
        state.slide = { start: now, until: now + SLIDE.ms, dir: [state.vel[0] / v, state.vel[1] / v] };
        state.slideReadyAt = now + SLIDE.cooldownMs;
        state.crouch = true; sfx.step?.('grass', false);
        break;
      }
      if (state.prone) { state.prone = false; state.crouch = true; } else state.crouch = !state.crouch;
      stanceNote(); break;
    }
    case 'prone': state.prone = !state.prone; if (state.prone) state.crouch = false; stanceNote(); break;
    case 'sprint': touch.sprintOn = !touch.sprintOn; if (touch.sprintOn) { state.prone = false; state.crouch = false; } break;
  }
}
$('name').value = localStorage.getItem('dz_name') || '';
{
  // Login-screen controller help. Gamepads only exist on HTTPS/localhost pages.
  const hint = $('padhint');
  if (!window.isSecureContext) {
    hint.innerHTML = '<b class="accent">Controllers need HTTPS.</b> This page is plain HTTP, so the browser hides gamepads. Open it over HTTPS (see README) to use a Backbone One or other controller.';
  } else {
    hint.innerHTML = '🎮 <b>Built for a controller.</b> Press any button on your Backbone One or gamepad to wake it, then D-pad and Ⓐ to pick. Ⓐ on a text box opens a keyboard.<span class="more"><br />'
      + '<b>Left stick</b> move · <b>Right stick</b> look · <b>LT</b> aim · <b>RT</b> fire · <b>Ⓐ</b> use · <b>Ⓑ</b> crouch · <b>Ⓧ</b> reload · <b>Ⓨ</b> next gun (main 1 · main 2 · sidearm) · <b>L3</b> sprint<br />'
      + '<b>LB</b> grenade (hold: switch) · <b>RB</b> tag · <b>R3</b> camo (aiming: flip magnification) · <b>▲</b> medkit · <b>▼</b> ping · <b>◀</b> rally · <b>▶</b> build<br />'
      + 'The two small buttons: <b>⧉</b> (left) bag (Crew & settings are in it), hold to accept an invite · <b>☰</b> (right) map · <b>Ⓑ</b> always goes back</span>';
  }
  if (MOBILE) document.body.classList.add('mobile');
}

canvas.addEventListener('click', () => { if (state.me && !state.invOpen && !state.me.dead) lockPointer(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  setInputMode('kb');
  const sens = state.aiming ? 0.0022 * camera.fov / 70 : 0.0022;
  state.yaw -= e.movementX * sens; if (e.movementX) state.lookAt = performance.now();
  state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch - e.movementY * sens));
});
/** Free look ends: the view swings back to the way you're going. */
function endMouseLook() {
  if (touch.freeLook?.id !== 'mouse') return;
  state.yaw = touch.freeLook.yaw; state.pitch = touch.freeLook.pitch;
  touch.freeLook = null;
}
addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  // Hold the wheel (middle button) to look around while you keep running the way you were facing.
  if (e.button === 1) { e.preventDefault(); if (!touch.freeLook && !state.aiming && state.me && !state.me.dead) touch.freeLook = { id: 'mouse', yaw: state.yaw, pitch: state.pitch }; return; }
  if (e.button === 0 || e.button === 2) endMouseLook();   // shooting or aiming: back to where you face first
  if (e.button === 0) { state.mouseDown = true; state.firedThisPress = false; }
  if (e.button === 2) state.aiming = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 1) endMouseLook();
  if (e.button === 0) state.mouseDown = false;
  if (e.button === 2) state.aiming = false;
});
addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  // Build mode: X toggles, 1-5 pick a piece.
  if (document.activeElement?.tagName === 'INPUT' || !state.me) return;
  if (e.code === 'KeyX' && !e.repeat) doAction('build');
  if (build.on && /^Digit[1-9]$/.test(e.code)) { const k = Object.keys(PIECES).filter((x) => !PIECES[x].auto)[Number(e.code.slice(5)) - 1]; if (k) { build.piece = k; renderBuildBar(); } e.stopImmediatePropagation(); }
}, true);
addEventListener('wheel', (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (build.on) { build.rot ^= 1; return; }
  // The mouse wheel steps through the guns you carry (primary, second primary, sidearm), skipping empty slots.
  const me = state.me, now = performance.now();
  if (!me || state.nadeAim || now - (state.wheelAt || 0) < 140 || Math.abs(e.deltaY) < 1) return;
  state.wheelAt = now;
  const slots = ['primary', 'primary2', 'secondary'].filter((sl) => me.inv?.[sl]);
  if (slots.length < 2) return;
  const i = Math.max(0, slots.indexOf(me.active));
  send({ t: 'weapon', slot: slots[(i + (e.deltaY > 0 ? 1 : slots.length - 1)) % slots.length] });
});
const KEY_ACTIONS = {
  KeyE: 'interact', KeyF: 'tag', KeyG: 'sensor', KeyZ: 'switchGrenade', KeyV: 'camo', KeyT: 'rally', KeyB: 'ping', KeyR: 'reload',
  KeyQ: 'swap', Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', KeyH: 'heal', ControlLeft: 'crouch', Space: 'jump',
};
addEventListener('keydown', (e) => {
  if (document.activeElement?.tagName === 'INPUT') return;
  setInputMode('kb');
  if (e.code === 'KeyP') { doAction('squadPanel'); return; }
  if (e.code === 'KeyM') { doAction('map'); return; }
  if (e.code === 'Escape' && state.contactOpen) { closeContact(); return; }
  if (e.code === 'Escape' && state.mapOpen && (state.mapMode === 'view' || state.mapMode === 'travel')) { closeMapScreen(); return; }
  if (e.code === 'Escape' && state.panelOpen) { closeSquadPanel(); return; }
  if (e.code === 'Tab' || e.code === 'KeyI') { e.preventDefault(); doAction('inventory'); return; }
  if (e.code === 'Escape' && state.rideOpen) { closeRidePicker(); return; }
  if (e.code === 'Escape' && state.gunsmithOpen) { closeGunsmith(); return; }
  if (e.code === 'Escape' && state.invOpen && invUi.menuFor) { closeInvMenu(); return; }
  if (e.code === 'Escape' && state.invOpen) { closeInventory(); return; }
  state.keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyC') { kbC.at = performance.now(); kbC.held = false; }
  if (KEY_ACTIONS[e.code]) doAction(KEY_ACTIONS[e.code]);
});
addEventListener('keyup', (e) => {
  state.keys.delete(e.code);
  if (e.code === 'KeyC' && kbC.at && !kbC.held) doAction('crouch');
  if (e.code === 'KeyC') kbC.at = 0;
});
// C: tap to crouch, hold to go prone.
const kbC = { at: 0, held: false };
setInterval(() => { if (kbC.at && !kbC.held && performance.now() - kbC.at > 400) { kbC.held = true; doAction('prone'); } }, 50);
addEventListener('blur', () => { state.keys.clear(); state.mouseDown = false; state.aiming = false; });

// ------------------------------------------------------------------ simulation helpers
function structSolid(sv) { const st = sv.data; const mat = PIECES[st.type].stages[st.stage].material; return mat !== 'frame' && !PIECES[st.type].explosive && !(PIECES[st.type].door && st.open); }
function structBoxOf(st) { return structureBox(st, { type: 'struct', structId: st.id }); }
function solidsNear(x, z, r) {
  const out = state.map.grid.near(x, z, r);
  for (const sv of structVis.values()) if (structSolid(sv) && Math.abs(sv.data.x - x) < r + 3 && Math.abs(sv.data.z - z) < r + 3) out.push(structBoxOf(sv.data));
  for (const d of state.doorSolids) if (Math.abs(d.minX - x) < r + 2 && Math.abs(d.minZ - z) < r + 2) out.push(d);
  return out;
}
function solidsAlongRay(ox, oz, dx, dz, dist) {
  const out = state.map.grid.ray(ox, oz, dx, dz, dist);
  for (const sv of structVis.values()) if (structSolid(sv)) out.push(structBoxOf(sv.data));
  return out.concat(state.doorSolids);
}

function distToSeg(x, z, r) {
  const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2));
  return Math.hypot(r.x1 + dx * t - x, r.z1 + dz * t - z);
}
function lookDir() {
  return new THREE.Vector3(Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), Math.cos(state.yaw) * Math.cos(state.pitch));
}

/** Where you stand: up on a bridge deck (tracked as you walk) or the ground. */
function myY() { return state.y !== undefined && state.yx === state.x && state.yz === state.z ? state.y : ground(state.x, state.z); }
function eyeHeight() { return state.me?.boat ? rideFeet(state.me.boat.id) + (myRide()?.land && !myRide().stand ? STAND_EYE - 0.45 : myRide()?.land ? STAND_EYE : 0.1 + STAND_EYE) : myY() + (state.air ? state.air.alt : 0) + (state.hop ? state.hop.alt : 0) + (state.eyeNow ?? STAND_EYE); }
/** Ease the eye (and the body) toward the stance you picked: about a quarter second to crouch, most
 *  of a second to go prone or get up from it, and you can't move while you're dropping or rising. */
const PRONE_SHIFT_MS = 700;
function updateStance(dt, now) {
  const key = state.prone ? 'prone' : state.crouch ? 'crouch' : 'stand';
  if (key !== state.stanceKey) {
    if (state.stanceKey && (key === 'prone' || state.stanceKey === 'prone')) state.stanceBusyUntil = now + PRONE_SHIFT_MS;
    state.stanceKey = key;
  }
  const target = key === 'prone' ? PRONE_EYE : key === 'crouch' ? CROUCH_EYE : STAND_EYE;
  const slow = key === 'prone' || now < (state.stanceBusyUntil || 0);
  state.eyeNow = (state.eyeNow ?? target) + (target - (state.eyeNow ?? target)) * Math.min(1, dt * (slow ? 4.5 : 10));
}
/** What the server is told: you're only flat once you've finished getting down. */
const proneSettled = () => state.prone && performance.now() >= (state.stanceBusyUntil || 0);

/** Raycast from the camera through the crosshair and return the world point it lands on. */
function aimPoint() {
  const o = camera.position, d = lookDir();
  // Only what's in front of you counts: a tree or wall between the camera and your shoulder is ignored.
  const minT = Math.max(0, new THREE.Vector3(state.x, eyeHeight(), state.z).sub(o).dot(d));
  const s0 = o.clone().addScaledVector(d, minT);
  let best = minT + rayAgainstBoxes(s0.x, s0.y, s0.z, d.x, d.y, d.z, solidsAlongRay(s0.x, s0.z, d.x, d.z, 400), 400).t;
  best = Math.min(best, minT + state.map.terrain.ray(s0.x, s0.y, s0.z, d.x, d.y, d.z, Math.min(best - minT, 400)));
  state.aimTargetId = null;
  const test = (c) => {
    if (!c || c.dead) return;
    const b = characterBounds(c.x, c.z, c.crouch, ground(c.x, c.z), c.prone);
    const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t > minT && t < best) { best = t; state.aimTargetId = c.sq ? null : c.id; state.aimFoe = !c.sq && !c.animal && !c.npc; }
  };
  state.aimFoe = false;
  for (const [, r] of state.players) test(r.data);
  for (const [, r] of state.bots) test(r.animal ? { ...r.data, animal: 1 } : r.data);
  if (best >= 400 + minT) best = 400 + minT;
  state.aimDist = best - minT;   // from you, not from the camera behind you
  return o.clone().addScaledVector(d, best);
}

/** Phones with auto-fire on: the crosshair is on an enemy within the gun's reach. */
function autoFireNow(me) {
  if (!state.touchUI || !tset.autoFire || tset.autoFire === 'off' || touch.freeLook) return false;
  if (tset.autoFire === 'aim' && !state.aiming) return false;
  const ws = weaponStats(me.inv[me.active]);
  return !!(ws && state.aimFoe && state.aimTargetId && state.aimDist <= ws.range);
}
// ------------------------------------------------------------------ grenades: aim, cook, throw
// NADE gets one out: its arc and where it'll land are drawn as you aim (look up to throw further,
// down for shorter). FIRE pulls the pin: a frag's fuse burns from then, so hold to cook it and let go
// to throw; hold it too long and it goes off in your hand. NADE again puts it away.
const NADE_RANGE = { frag: COMBAT_RULES.frag.throwRange, sensor: 30, stun: 30 };
const NADE_RING = { frag: COMBAT_RULES.frag.playerRadius, sensor: 22, stun: 9 };
const NADE_COL = { frag: 0xffd23a, sensor: 0xff9b21, stun: 0xe8f2ff };
const nadeFx = (() => {
  // The path as a string of bright beads (a 1-pixel line is lost on a phone), and a ring where it lands.
  const N = 90;
  const line = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd23a, depthTest: false, transparent: true, opacity: 0.95 }), N);
  line.count = 0; line.frustumCulled = false;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.4, 20), new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
  ring.rotation.x = dot.rotation.x = -Math.PI / 2;
  line.renderOrder = ring.renderOrder = dot.renderOrder = 6;
  for (const o of [line, ring, dot]) { o.visible = false; scene.add(o); }
  return { line, ring, dot, N };
})();
function toggleNadeAim() {
  const me = state.me;
  if (state.nadeAim) return putNadeAway();
  if (!me || me.dead || me.downed || me.boat || state.air) return;
  state.nadeAim = { kind: state.grenade || 'frag', cookAt: 0 };
  state.firedThisPress = true;   // a trigger already held doesn't pull the pin by itself
  if (!localStorage.getItem('dz_tip_nade')) { localStorage.setItem('dz_tip_nade', '1'); toast('Grenade out: aim with the camera (up = further) · hold FIRE to cook, let go to throw · NADE again to put it away'); }
}
function putNadeAway() {
  state.nadeAim = null;
  for (const o of Object.values(nadeFx)) if (o?.isObject3D) o.visible = false;
  $('nadecook').hidden = true;
}
/** Where a throw at the current aim goes: the path (points) and where it comes down. */
function nadeArc(kind) {
  const [sx, sy, sz] = muzzlePoint();
  const pitch = Math.max(-0.45, Math.min(1.15, (touch.freeLook ? touch.freeLook.pitch : state.pitch) + 0.3));
  const v = Math.sqrt(9.8 * NADE_RANGE[kind]), fx = Math.sin(state.yaw), fz = Math.cos(state.yaw);
  const p = new THREE.Vector3(sx, sy, sz), vel = new THREE.Vector3(fx * v * Math.cos(pitch), v * Math.sin(pitch), fz * v * Math.cos(pitch));
  const pts = [p.clone()], dt = 0.03;
  for (let t = 0; t < 5; t += dt) {
    const n = p.clone().addScaledVector(vel, dt);
    vel.y -= 9.8 * dt;
    const step = n.clone().sub(p), len = step.length();
    const hit = rayAgainstBoxes(p.x, p.y, p.z, step.x / len, step.y / len, step.z / len, solidsNear(p.x, p.z, len + 2), len);
    if (hit.t < len) { p.addScaledVector(step, hit.t / len); pts.push(p.clone()); break; }
    const g = ground(n.x, n.z);
    if (n.y <= g) { const k = (p.y - ground(p.x, p.z)) / Math.max(1e-3, (p.y - ground(p.x, p.z)) - (n.y - g)); p.lerp(n, Math.max(0, Math.min(1, k))); pts.push(p.clone()); break; }
    p.copy(n); pts.push(p.clone());
  }
  return { pts, land: p };
}
function updateNadeAim(now) {
  const a = state.nadeAim, me = state.me;
  if (!me || me.dead || me.downed || me.boat || state.air || state.invOpen) return putNadeAway();
  if (!a.cookAt && a.kind !== (state.grenade || 'frag')) a.kind = state.grenade || 'frag';
  const arc = nadeArc(a.kind), col = NADE_COL[a.kind];
  const { line, ring, dot } = nadeFx;
  const bead = new THREE.Matrix4();
  let nb = 0;
  for (let i = 2; i < arc.pts.length && nb < nadeFx.N; i += 2) { const q = arc.pts[i]; line.setMatrixAt(nb++, bead.makeTranslation(q.x, q.y, q.z)); }
  line.count = nb; line.instanceMatrix.needsUpdate = true; line.material.color.setHex(col);
  const gy = ground(arc.land.x, arc.land.z) + 0.08, r = NADE_RING[a.kind];
  ring.position.set(arc.land.x, Math.max(gy, arc.land.y) + 0.02, arc.land.z); ring.scale.setScalar(r); ring.material.color.setHex(col);
  dot.position.copy(ring.position); dot.material.color.setHex(col);
  line.visible = ring.visible = dot.visible = true;
  // FIRE: the pin comes out on the press; a frag cooks while it's held; letting go throws.
  const held = state.mouseDown && !state.firedThisPress;
  if (!state.mouseDown) state.firedThisPress = false;
  if (held && !a.cookAt) { a.cookAt = now; if (a.kind === 'frag') sfx.empty(); }
  const cookEl = $('nadecook');
  state.nadeSeen = now;
  if (a.cookAt && a.kind === 'frag') {
    const fuse = COMBAT_RULES.frag.fuseMs, cooked = now - a.cookAt, left = fuse - cooked;
    cookEl.hidden = false; cookEl.textContent = `💣 ${Math.max(0, left / 1000).toFixed(1)}`; cookEl.classList.toggle('hot', left < 1200);
    if (left <= 0) { send({ t: 'frag', x: state.x, z: state.z, cook: fuse }); toast('💥 Held it too long!'); putNadeAway(); state.firedThisPress = true; return; }
  } else cookEl.hidden = true;
  if (a.cookAt && !state.mouseDown) {
    send({ t: a.kind, x: arc.land.x, z: arc.land.z, cook: a.kind === 'frag' ? now - a.cookAt : 0 });
    putNadeAway();
  }
}

function tryFire(now) {
  if (state.nadeAim) return;
  const me = state.me;
  if (!me || me.dead || state.invOpen) return;
  const w = me.inv[me.active];
  if (!w) return;
  if (state.sprint || now < (state.drawUntil || 0)) return;   // gun on your back, or still coming up
  const s = weaponStats(w);
  const semi = s.semi;
  if (semi && state.firedThisPress) return;
  if (now - state.lastShot < 60000 / s.rpm) return;
  if (me.reloading) return;
  if (me.mag <= 0) {
    if (!state.firedThisPress) { sfx.empty(); state.firedThisPress = true; }
    if (reserveFor(me) > 0 && !state.autoReloadSent) { send({ t: 'reload' }); sfx.reload(); startReloadFx(); state.autoReloadSent = now; }
    return;
  }
  state.autoReloadSent = 0;
  const target = aimPoint();
  const eye = new THREE.Vector3(state.x, eyeHeight(), state.z);
  const dir = target.clone().sub(eye).normalize();
  // The server aims from its copy of you at the same point, and checks the target you saw.
  send({ t: 'shoot', dir: [dir.x, dir.y, dir.z], at: [+target.x.toFixed(2), +target.y.toFixed(2), +target.z.toFixed(2)], tid: state.aimTargetId || undefined });
  sfx.shot(0, 0, 0, w.archetype, s.suppressed ? (s.subsonic ? 2 : 1) : 0, true);
  shotFx(selfMesh, w.archetype, s.suppressed ? (s.subsonic ? 2 : 1) : 0);
  state.lastShot = now;
  state.firedThisPress = true;
  me.mag -= 1;                          // predicted; server confirms via 'you'
  $('mag').textContent = me.mag;
  // Recoil comes from the gunsmith build: stocks, grips, muzzles and bipods all change it.
  state.recoil += s.recoil * (state.prone ? 0.6 : state.crouch ? s.crouchRecoil : 1) * (state.aiming ? 0.85 : 1) * (0.8 + Math.random() * 0.4);
}

/** "· 🔒 sealed until 7 pm" on other people's bases while everyone who lives there is offline. */
function raidTag(o) {
  if (o.rs === 2) return ` · 🔒 sealed until ${hourLabel(o.rw)}`;
  if (o.rs === 1) return ' · raid window (owners away)';
  return '';
}
function nearestInteractable() {
  if (state.me?.boat) return myRide()?.land ? `${myRide().icon} Get off the ${myRide().name.toLowerCase()}` : canStepOut() ? '🚤 Get out onto the bank' : null;
  let best = null, bestD = INTERACT_RANGE;
  const consider = (d, text) => { if (d < bestD) { bestD = d; best = text; } };
  // At the foot of a ladder (a roof, a water tower, a radio tower).
  { const y = myY(), lad = !state.hop && !state.air && ladderAt(solidsNear(state.x, state.z, 3), state.x, state.z, y); if (lad) consider(0.4, `🪜 Climb the ladder (${feet(lad.ladderTop - y)} up)`); }
  // Boats and landing posts (boats are boarded from a little further off: they sit in the water).
  for (const [, v] of boatVis) {
    const def = BOATS[v.data.type];
    if (def.land) {
      const b = v.data, d = Math.hypot(b.x - state.x, b.z - state.z) - def.len / 2;
      if (d >= 2.2) continue;
      const name = def.name.toLowerCase(), crewed = b.seats.some(Boolean), verb = def.animal ? 'Ride' : def.stand || def.pedal ? 'Hop on' : 'Drive', hw = RIDE_RULES.hotwireMs / 1000;
      const text = b.mine ? (b.seats.every(Boolean) ? `Your ${name} is full` : b.seats[0] ? `${def.icon} Ride along on the ${name}` : `${def.icon} ${verb} the ${name}`)
        : !b.owner ? (b.nk ? `🔧 Hotwire the ${name} (no keys, ${hw}s)` : `${def.icon} ${verb} the ${name}`)
        : crewed ? `${b.owner}'s ${name} (taken)` : `🔧 ${def.animal ? 'Take' : 'Hotwire'} ${b.owner}'s ${name} (${hw}s, they'll be warned)`;
      if (d < bestD) { bestD = Math.max(0, d); best = text; }
      continue;
    }
    const b = v.data, d = Math.hypot(b.x - state.x, b.z - state.z) - 1.5;
    if (d >= BOAT_RULES.boardRange) continue;
    const name = BOATS[b.type].name.toLowerCase(), full = b.seats.every(Boolean), crewed = b.seats.some(Boolean);
    const text = b.mine ? (full ? `Your ${name} is full` : b.seats[0] ? `🚤 Ride in the ${name}` : `🚤 Take the helm of your ${name}`)
      : !b.owner ? `🚤 Take the abandoned ${name}` : crewed ? `${b.owner}'s ${name} (crewed)` : `🔧 Hotwire ${b.owner}'s ${name} (${BOAT_RULES.hotwireMs / 1000}s, they'll be warned)`;
    if (d < bestD) { bestD = Math.max(0, d - 1); best = text; }
  }
  for (const dk of state.map.docks) {
    if (Math.abs(dk.x - state.x) > 4 || Math.abs(dk.z - state.z) > 4) continue;
    const d = Math.hypot(dk.x - state.x, dk.z - state.z) - 0.4;
    if (d < 2.5) consider(Math.max(0, d - 1), `⚓ ${dk.name}: buy a boat, repairs, river freight`);
  }
  for (const [, l] of state.loot) consider(Math.hypot(l.data.x - state.x, l.data.z - state.z), `Pick up ${l.data.name}${l.data.amount ? ` (+${l.data.amount})` : ''}`);
  for (const [, b] of state.bags) consider(Math.hypot(b.data.x - state.x, b.data.z - state.z), `Search ${b.data.label}`);
  for (const [id, ready] of state.termState) { const t = state.map.terminals[id]; consider(Math.hypot(t.x - state.x, t.z - state.z), ready ? 'Hack terminal (stand still 5s) — intel + tech' : 'Terminal rebooting'); }
  for (const c of state.map.contacts) if (Math.abs(c.x - state.x) < 5 && Math.abs(c.z - state.z) < 5) consider(Math.hypot(c.x - state.x, c.z - state.z) - 0.8, `Talk to ${c.name} — contracts & field gear`);
  // Enemies at arm's length: data-hack the stunned or downed, take down from behind.
  for (const c of [...[...state.players.values()].map((r) => r.data).filter((d) => !d.sq), ...[...state.bots.values()].map((r) => r.data)]) {
    if (!c || c.dead || c.kind === 'merchant' || c.kind === 'settler' || c.kind === 'trader') continue;   // traders are for trading
    const d = Math.hypot(c.x - state.x, c.z - state.z);
    if (d > 2.2) continue;
    if (c.stun || c.downed) consider(d - 2, `⚡ Data hack ${c.name} (2s) — ${state.bots.has(c.id) ? 'reveals Rogues nearby' : 'lights up their whole crew + their stash'}`);
    else if (d <= 1.6) {
      const fx = Math.sin(c.yaw || 0), fz = Math.cos(c.yaw || 0), dot = (fx * (state.x - c.x) + fz * (state.z - c.z)) / (d || 1);
      if (dot < -0.35) consider(d - 1.5, `✊ Takedown ${c.name} — stun them`);
    }
  }
  for (const [, r] of state.bots) {
    const c = r.data;
    if (c && (c.kind === 'merchant' || c.kind === 'settler' || c.kind === 'trader')) consider(Math.hypot(c.x - state.x, c.z - state.z) - 0.3, `🛒 Trade with the ${c.name.toLowerCase()}`);
  }
  for (const [, r] of state.players) if (r.data.sq && r.data.downed && !r.data.dead) consider(Math.hypot(r.data.x - state.x, r.data.z - state.z) - 1.5, `✚ Revive ${r.data.name} (stand still ${COMBAT_RULES.downed.reviveMs / 1000}s)`);
  for (const d of state.drops) consider(Math.hypot(d.x - state.x, d.z - state.z) - 0.6, d.landsAt > Date.now() ? 'Supply drop incoming…' : 'Open supply drop (6s)');
  const hz = state.hotZone;
  if (hz?.open) {
    for (const c of hz.crates) if (!c.opened) consider(Math.hypot(c.x - state.x, c.z - state.z) - 0.6, `Open hot crate (${HELI.hotZone.crateMs / 1000}s): the alarm shows everyone near the zone where you are`);
    if (hz.extract && state.me?.claim && !state.extracts.length && Math.hypot(hz.extract.x - state.x, hz.extract.z - state.z) < EXTRACT.callRange) consider(Math.hypot(hz.extract.x - state.x, hz.extract.z - state.z), `Call extraction at the hot-zone pickup: hold ${feet(EXTRACT.radius)} for ${EXTRACT.holdMs / 1000}s, fly home with your loot`);
  }
  if (!best && state.me?.claim && !state.extracts.length) for (const lz of state.map.landingZones) if (Math.hypot(lz.x - state.x, lz.z - state.z) < EXTRACT.callRange) best = `Call extraction — fire a flare, hold ${feet(EXTRACT.radius)} for ${EXTRACT.holdMs / 1000}s, fly home with your loot`;
  for (const o of state.objectives) consider(Math.hypot(o.x - state.x, o.z - state.z) - 0.5, 'Recover contract crate (3s)');
  const me = state.me;
  const has = (t) => me?.inv.pack.some((i) => i.kind === 'tool' && i.tool === t);
  for (const sv of structVis.values()) {
    const st = sv.data, def = PIECES[st.type], stage = def.stages[st.stage];
    if (def.explosive) continue;
    const d = Math.hypot(Math.max(structBoxOf(st).minX - state.x, 0, state.x - structBoxOf(st).maxX), Math.max(structBoxOf(st).minZ - state.z, 0, state.z - structBoxOf(st).maxZ)) + 0.3;
    let text;
    const next = def.stages[st.stage + 1];
    const hp = ` <small>${st.hp}/${st.max} HP</small>${raidTag(st)}`;
    if (st.ru) {
      text = st.mine ? (def.door ? `🔨 Rebuild door (${costText(RAIDS.ruin.doorRebuildCost)}, hammer)` : '🔨 Your stash is a ruin: open it to rebuild')
        : def.door ? `${st.owner}'s door (broken down)` : `Search ${st.owner}'s ruined stash${raidTag(st)}`;
      consider(d, text);
      continue;
    }
    if (def.stall) {
      text = st.mine ? '🛒 Your market stall — list goods, collect the till' : `🛒 Browse ${st.owner}'s stall`;
    } else if (def.defense && st.mine) {
      text = def.defense === 'sentry' ? `🔫 Sentry: ${st.ammo} rounds — load ammo (you carry ${me?.ammo || 0})`
        : def.defense === 'kennel' ? `🐕 Kennel: ${st.meat} meat stored${st.fed ? '' : ' — HUNGRY, no dog on guard'} · feed (you carry ${me?.meat || 0})`
          : def.defense === 'tripwire' ? 'Tripwire (yours) — armed' : 'Motion alarm (yours) — on';
    } else if (def.farm) {
      const crop = st.crop ? st.crop[0].toUpperCase() + st.crop.slice(1) : '';
      text = !st.crop ? (st.mine ? (me?.seeds ? '🌱 Plant seeds (uses 1 seed packet)' : 'Empty farm plot — needs a seed packet') : `${st.owner}'s empty plot`)
        : st.rotten ? `${crop} rotted — clear it` : st.grow >= 1 ? (st.mine ? `🌾 Harvest ${crop.toLowerCase()}` : `🌾 Steal ${st.owner}'s ${crop.toLowerCase()}`) : `${crop} — ${Math.round(st.grow * 100)}% grown`;
    } else if (def.cook) {
      text = me && GOODS && ['fish', 'meat'].some((g) => me[g]) ? `🔥 Cook ${['fish', 'meat'].map((g) => me[g] ? resText(g, me[g]) : '').filter(Boolean).join(' + ')} (4s)` : 'Campfire — cook raw fish or meat here';
    } else if (st.mine) {
      if (build.on) text = next ? `Upgrade to ${next.name} (${Object.entries(next.cost).map(([k, v]) => `${v} ${k}`).join(', ')})${has('hammer') ? '' : ' — needs a hammer'}` : `${stage.name} — fully built`;
      else if (def.container) text = `Open ${stage.name.toLowerCase()}`;
      else if (def.door && stage.material !== 'frame') text = st.open ? `Close ${def.auto ? 'door' : 'gate'}` : `Open ${def.auto ? 'door' : 'gate'}`;
      else text = `${stage.name}${next ? ` — ${glyph('X')} for build mode to upgrade` : ''}`;
    } else if (def.claim && st.type === 'flag') text = `${st.owner}'s claim flag: break it to reach the stash${has('hatchet') || has('pickaxe') ? '' : ' (hatchet, pickaxe or charge)'}`;
    else if (def.container) text = `Search ${st.owner}'s ${stage.name.toLowerCase()}`;
    else if (stage.material === 'frame') text = `${st.owner}'s ${stage.name.toLowerCase()}`;
    else text = stage.material === 'stone' ? (has('pickaxe') ? `Break ${st.owner}'s ${stage.name.toLowerCase()} (pickaxe)` : `${st.owner}'s ${stage.name.toLowerCase()} — needs a pickaxe or breach charge`) : (has('hatchet') || has('pickaxe') ? `Chop through ${st.owner}'s ${stage.name.toLowerCase()}` : `${st.owner}'s ${stage.name.toLowerCase()} — needs a hatchet`);
    consider(d, def.farm || def.cook || def.stall || (def.defense && st.mine) ? text : text + hp);
  }
  for (const [id, hs] of state.houseState) {
    const h = state.map.houses[id];
    const own = id === state.houseId;
    const hasMarker = state.me?.inv.pack.some((i) => i.kind === 'marker');
    const claimText = state.me?.claim ? `Unclaimed ${homeKindName(h).toLowerCase()} (you already have a stash house)` : hasMarker ? `Plant claim marker — make this ${homeKindName(h).toLowerCase()} your stash house (8s)` : `Unclaimed ${homeKindName(h).toLowerCase()} — needs a claim marker`;
    const lockedVehicle = h.kind === 'vehicle' && hs.owner && !own && hs.hp > 0 && !hs.open;
    consider(Math.hypot(h.crate.x - state.x, h.crate.z - state.z) - 0.3, !hs.owner ? claimText : own ? `Open your stash · gunsmith · upgrades (home Lv${hs.hl})` : lockedVehicle ? `${hs.owner}'s ${homeKindName(h).toLowerCase()} — locked` : `Loot ${hs.owner}'s stash${raidTag(hs)}`);
    const d = h.door;
    if (!hs.owner) { consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), claimText); continue; }
    const squadHouse = !own && hs.owner && state.squad.members.some((m) => m.name === hs.owner);
    const tier = Math.min(3, hs.upg?.door || 0);
    const lockText = (state.me?.level ?? 1) >= GADGETS.doorHack.level ? `Bypass lock (${RAIDS.lockBypass.tech[tier]} tech, ${RAIDS.lockBypass.ms[tier] / 1000}s)` : `Locked — shoot it down (bypass at lvl ${GADGETS.doorHack.level})`;
    const doorText = own || squadHouse ? (hs.hp <= 0 ? (own ? 'Rebuild door' : 'Doorway (breached)') : hs.open ? 'Close door' : 'Open door') : (hs.hp <= 0 ? `Doorway (breached)${raidTag(hs)}` : hs.open ? 'Doorway (open)' : hs.rs === 2 ? `${hs.owner}'s door${raidTag(hs)}` : `${lockText} · ${Math.round(hs.hp / hs.max * 100)}%${raidTag(hs)}`);
    consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), doorText);
  }
  if (!best) {
    for (const b of state.map.grid.near(state.x, state.z, 2.5)) {
      const wood = b.type === 'tree' || b.type === 'pine', stone = b.type === 'rock' || b.type === 'boulder';
      if ((!wood && !stone) || b.gone) continue;
      const tool = wood ? 'hatchet' : 'pickaxe';
      if (!has(tool) && has('rod')) continue;   // fishing takes over at the water's edge (below)
      const d = Math.hypot(Math.max(b.minX - state.x, 0, state.x - b.maxX), Math.max(b.minZ - state.z, 0, state.z - b.maxZ)) + 0.6;
      consider(d, has(tool) ? (wood ? 'Chop tree for wood (3s)' : 'Mine rock for stone (3s)') : `${wood ? 'Tree' : 'Rock'} — needs a ${tool}`);
    }
  }
  if (!best && me && !state.map.buildings.some((q) => state.x > q.minX && state.x < q.maxX && state.z > q.minZ && state.z < q.maxZ && insideBuilding(q, state.x, state.z, 0))) {
    // At the water's edge: fish.
    const R = HOMESTEAD.fishing.waterWithin, T = state.map.terrain;
    let wet = false;
    for (let a = 0; a < 8 && !wet; a++) for (const r of [R * 0.5, R]) if (T.height(state.x + Math.cos(a * Math.PI / 4) * r, state.z + Math.sin(a * Math.PI / 4) * r) < -0.4) wet = true;
    if (wet) best = me.inv.pack.some((i) => i.kind === 'tool' && i.tool === 'rod') ? `🎣 Fish (${HOMESTEAD.fishing.ms / 1000}s)` : 'Water — a fishing rod would catch something here';
  }
  if (!best && me) {
    // Inside an enterable building nobody holds: it can become your stash house.
    const b = state.map.buildings.find((q) => state.x > q.minX && state.x < q.maxX && state.z > q.minZ && state.z < q.maxZ && insideBuilding(q, state.x, state.z, 0.3) && myY() < q.top - 1);   // inside, not up on its roof
    if (b) {
      const held = [...structVis.values()].find((sv) => PIECES[sv.data.type].claim && sv.data.x > b.minX && sv.data.x < b.maxX && sv.data.z > b.minZ && sv.data.z < b.maxZ);
      const what = b.name || ({ building: 'building', home: 'house', civic: 'hall' }[b.type] || b.type);
      const it = b.name ? `the ${b.name}` : `this ${what}`;
      if (b.shop || state.noClaim?.has(state.map.buildings.indexOf(b))) best = held ? null : b.name ? `${b.name}: open to everyone, nobody's stash house` : null;
      else if (held) best = held.data.mine ? null : `${held.data.owner}'s ${b.name || 'building'}`;
      else if (me.claim) best = `${b.name || `Unclaimed ${what}`} (${state.squad.id ? 'your crew has' : 'you have'} a stash house)`;
      else if (me.inv.pack.some((i) => i.kind === 'marker')) best = `Make ${it} your stash house (8 s): your own locker, and doors only your crew can open`;
      else best = `${b.name || `Unclaimed ${what}`} — a claim marker makes it your stash house`;
    }
  }
  return best;
}

// ------------------------------------------------------------------ tech + squad HUD
function setCloak(g, opacity) {
  if (g.userData.cloak === opacity) return;
  g.userData.cloak = opacity;
  g.traverse((m) => {
    if (!m.material || m.isSprite) return;
    m.material.transparent = opacity < 1;
    m.material.opacity = opacity;
    m.material.depthWrite = opacity >= 1;
    m.castShadow = opacity >= 1;
  });
}

const markerEls = new Map();
function marker(key, cls, text, pos) {
  let el = markerEls.get(key);
  if (!el) { el = document.createElement('div'); $('markers').append(el); markerEls.set(key, el); }
  el.className = `marker ${cls}`;
  el.textContent = text;
  const v = pos.clone().project(camera);
  const behind = v.z > 1;
  el.style.display = behind ? 'none' : '';
  el.style.left = `${Math.max(16, Math.min(innerWidth - 16, (v.x * 0.5 + 0.5) * innerWidth))}px`;
  el.style.top = `${Math.max(16, Math.min(innerHeight - 16, (-v.y * 0.5 + 0.5) * innerHeight))}px`;
  el.dataset.seen = '1';
}

const MINE_SEE = WORLD_LIVING.defenses.mine.seeWithin;
const DEF_LABEL = { mine: '💥 Mine', tripwire: '〰 Tripwire', alarm: '🚨 Alarm', sentry: '🔫 Sentry', kennel: '🐕 Dog' };
/** Through-wall HUD markers: tagged/sensed enemies, squadmates, pings, plus hack progress. */
function drawMarkers() {
  for (const el of markerEls.values()) el.dataset.seen = '';
  const now = performance.now();
  state.defMarks = state.defMarks.filter((d) => d.until > now);
  state.defMarks.forEach((d, i) => marker(`def${i}`, 'alert', DEF_LABEL[d.kind] || d.kind, new THREE.Vector3(d.x, d.y + 0.8, d.z)));
  for (const [id, s2] of state.sirens) { if (s2.until < now) { state.sirens.delete(id); continue; } if (Math.floor(now / 250) % 2) marker(`siren${id}`, 'alert', '🚨', new THREE.Vector3(s2.x, s2.y + 1.2, s2.z)); }
  if (state.map && state.me) {
    for (const [id, e] of state.exposed) {
      if (e.until < now) { state.exposed.delete(id); continue; }
      const c = state.players.get(id)?.data || state.bots.get(id)?.data;
      if (!c || c.dead) continue;
      const d = Math.hypot(c.x - state.x, c.z - state.z);
      marker(`x${id}`, e.kind === 'mark' ? 'tag' : 'sensed', e.kind === 'mark' ? `◆ ${distText(d)}` : '●', new THREE.Vector3(c.x, ground(c.x, c.z) + (c.crouch ? 1.2 : 1.8) + 0.5, c.z));
    }
    for (const [id, r] of [...state.players, ...state.bots]) {
      const c = r.data;
      if (!c || c.sq || c.dead || !c.stun || Math.hypot(c.x - state.x, c.z - state.z) > 60) continue;
      marker(`z${id}`, 'objective', `⚡ STUNNED — hack (${glyph('E')})`, new THREE.Vector3(c.x, ground(c.x, c.z) + 2.4, c.z));
    }
    for (const [id, r] of state.players) {
      if (!r.data.sq || r.data.dead) continue;
      if (r.data.downed) marker(`s${id}`, 'alert', `✚ ${r.data.name} DOWN · ${distText(Math.hypot(r.data.x - state.x, r.data.z - state.z))}`, new THREE.Vector3(r.data.x, ground(r.data.x, r.data.z) + 1.4, r.data.z));
      else marker(`s${id}`, 'squad', `▼ ${r.data.name}`, new THREE.Vector3(r.data.x, ground(r.data.x, r.data.z) + 2.6, r.data.z));
    }
    state.pings = state.pings.filter((p) => p.until > now);
    state.pings.forEach((p, i) => marker(`p${i}`, p.objective ? 'objective' : 'ping', `${p.objective ? '★ OBJECTIVE' : `◎ ${p.from}`} · ${distText(Math.hypot(p.x - state.x, p.z - state.z))}`, new THREE.Vector3(p.x, ground(p.x, p.z) + 1.5, p.z)));
    for (const ct of state.contracts) marker(`c${ct.id}`, 'objective', `◆ ${CONTRACT_TYPES[ct.type].name} · ${distText(Math.hypot(ct.x - state.x, ct.z - state.z))}`, new THREE.Vector3(ct.x, ground(ct.x, ct.z) + 2.5, ct.z));
    for (const d of state.drops) marker(`d${d.id}`, 'alert', `📦 ${distText(Math.hypot(d.x - state.x, d.z - state.z))}`, new THREE.Vector3(d.x, ground(d.x, d.z) + 3, d.z));
    for (const e of state.worldEvents || []) if (e.type !== 'swing') marker(`w${e.id}`, 'objective', `📣 ${e.name} · ${distText(Math.hypot(e.x - state.x, e.z - state.z))}`, new THREE.Vector3(e.x, ground(e.x, e.z) + 6, e.z));
    for (const e of state.extracts) marker(`e${e.id}`, 'alert', `🚁 ${distText(Math.hypot(e.x - state.x, e.z - state.z))}`, new THREE.Vector3(e.x, ground(e.x, e.z) + 4, e.z));
    if (state.waypoint) {
      const dw = Math.hypot(state.waypoint.x - state.x, state.waypoint.z - state.z);
      if (dw < 12) { setWaypoint(null); toast('Waypoint reached'); }
      else marker('wp', 'waypoint', `◆ Waypoint · ${distText(dw)}`, new THREE.Vector3(state.waypoint.x, ground(state.waypoint.x, state.waypoint.z) + 3, state.waypoint.z));
    }
    const hh = homePos();
    if (hh) {
      const dh = Math.hypot(hh.x - state.x, hh.z - state.z);
      if (dh > 40) marker('home', 'squad', `⌂ Home ${distText(dh)}`, new THREE.Vector3(hh.x, ground(hh.x, hh.z) + 4, hh.z));
    }
    state.alerts = state.alerts.filter((a) => a.until > now);
    state.alerts.forEach((a, i) => marker(`a${i}`, 'alert', '⚠', new THREE.Vector3(a.x, ground(a.x, a.z) + 2, a.z)));
  }
  for (const [k, el] of markerEls) if (!el.dataset.seen) { el.remove(); markerEls.delete(k); }
  for (let i = state.sensors.length - 1; i >= 0; i--) {
    const sn = state.sensors[i];
    if (sn.until < now) { for (const m of sn.meshes) scene.remove(m); state.sensors.splice(i, 1); continue; }
    sn.meshes[1].material.opacity = 0.2 + 0.2 * Math.sin(now / 150);
  }
  const hb = $('hackbar');
  if (state.hack) {
    hb.hidden = false;
    const f = Math.min(1, (now - state.hack.start) / state.hack.total);
    hb.querySelector('i').style.width = `${f * 100}%`;
    hb.querySelector('span').textContent = { terminal: 'HACKING TERMINAL', door: 'BYPASSING LOCK', gatehack: 'BYPASSING LOCK', drop: 'OPENING SUPPLY DROP', crate: 'RECOVERING CRATE', revive: 'REVIVING', datahack: 'DATA HACK', claim: 'PLANTING CLAIM MARKER', harvest: 'GATHERING', upgrade: 'BUILDING', raid: 'BREAKING IN', claimBuilding: 'CLAIMING BUILDING', cook: 'COOKING', fish: 'FISHING', hotwire: 'HOTWIRING', breakbox: 'PRYING OPEN THE LOCKER', rebuild: 'REBUILDING', selfrevive: 'PATCHING YOURSELF UP' }[state.hack.kind] + (state.hack.helpers ? ` · ${state.hack.helpers} helping` : '') + ' — hold still';
  } else hb.hidden = true;
  // Stun flash fades out over the stun.
  const sf = $('stunfx'), sLeft = (state.stunnedUntil || 0) - performance.now();
  sf.style.opacity = sLeft > 0 ? Math.min(0.85, 0.25 + sLeft / 4000) : 0;
  // Downed: bleed-out timer.
  const dbar = $('downbar');
  if (state.me?.downed && !state.me.dead) {
    const left = Math.max(0, Math.ceil((state.me.downedUntil - Date.now()) / 1000));
    dbar.hidden = false;
    // On a phone: buttons to tap below the bar. With a controller or keyboard: its buttons, named.
    const touchy = state.touchUI && state.inputMode !== 'pad', dt = $('downtouch');
    const patch = `patch yourself up (uses a medkit, ${COMBAT_RULES.downed.selfReviveMs / 1000}s)`;
    dbar.innerHTML = `<b>✚ DOWN</b> — bleeding out in ${left}s<br><small>${touchy ? (state.me.selfRevive ? `Patch up to ${patch.replace('patch yourself up', 'get back on your feet')}, or crawl to cover.` : 'Crawl to cover. A crewmate can revive you.')
      : `${state.me.selfRevive ? `<kbd>${glyph('E')}</kbd> ${patch} · ` : 'Crawl to cover. A crewmate can revive you. '}<kbd>${glyph('Q')}</kbd> give up`}</small>`;
    dt.hidden = !touchy;
    dt.querySelector('[data-down="patch"]').hidden = !state.me.selfRevive || !!state.hack;
  } else { dbar.hidden = true; $('downtouch').hidden = true; }
  // Extraction countdown for anyone near a flare.
  const xb = $('extractbar');
  const ex = state.extracts.find((e) => Math.hypot(e.x - state.x, e.z - state.z) < EXTRACT.radius * 3);
  if (ex && state.me && !state.me.dead) {
    const left = Math.max(0, Math.ceil((ex.arrivesAt - Date.now()) / 1000));
    const inside = Math.hypot(ex.x - state.x, ex.z - state.z) <= EXTRACT.radius;
    xb.hidden = false;
    xb.classList.toggle('out', !inside);
    xb.innerHTML = `🚁 <b>EXTRACTION · ${ex.site}</b> — ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}<br><small>${ex.by === state.myName ? (inside ? `Hold the zone (${feet(EXTRACT.radius)})` : 'GET BACK IN THE ZONE or the pilot aborts') : inside ? `${ex.by}'s pickup — squadmates in the zone ride along` : `${ex.by}'s pickup zone`}</small>`;
  } else xb.hidden = true;
}

function updateGadgetBar() {
  const me = state.me;
  if (!me) return;
  const lvl = me.level;
  const leader = state.squad.id && state.squad.leaderId === state.id;
  const now = Date.now();
  const items = [
    ['F', 'Tag', GADGETS.mark.level, ''],
    state.grenade === 'stun'
      ? ['G', 'Stun ⇄', GADGETS.stun.level, me.stunReadyAt > now ? 'cooldown' : me.tech < GADGETS.stun.cost ? 'notech' : '']
      : state.grenade === 'sensor'
        ? ['G', 'Sensor ⇄', GADGETS.sensor.level, me.sensorReadyAt > now ? 'cooldown' : me.tech < GADGETS.sensor.cost ? 'notech' : '']
        : ['G', 'Frag ⇄', 1, (me.parts || 0) < COMBAT_RULES.frag.costParts ? 'notech' : ''],
    ['V', me.camoOn ? (me.camoActive ? 'Camo ON' : 'Camo (move slow)') : 'Camo', GADGETS.camo.level, me.camoOn ? 'on' : ''],
    ['T', 'Rally', GADGETS.rally.level, !leader ? 'notleader' : me.rallyReadyAt > now ? 'cooldown' : ''],
    ['B', 'Ping', 1, state.squad.id ? '' : 'notleader'],
  ];
  $('gadgets').innerHTML = items.map(([k, name, lv, st]) => `<div class="gadget ${lvl < lv ? 'locked' : st}"><kbd>${glyph(k)}</kbd>${name}${lvl < lv ? `<small>LVL ${lv}</small>` : ''}</div>`).join('') +
    (me.buffUntil > now ? '<div class="gadget on"><kbd>★</kbd>Rallied</div>' : '');
}
setInterval(updateGadgetBar, 1000);

function openSquadPanel() {
  state.panelOpen = true;
  $('squadpanel').hidden = false;
  document.exitPointerLock?.();
  send({ t: 'leaderboard' });
  renderSquadPanel();
  renderPadSettings();
}
function closeSquadPanel() {
  state.panelOpen = false;
  $('squadpanel').hidden = true;
  lockPointer();
}

function btn(label, fn, cls = 'ghost') {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label; b.onclick = fn;
  return b;
}

/** Text boxes in panels that redraw themselves keep what you typed. */
const drafts = new Map();
function draftInput(props) {
  const input = Object.assign(document.createElement('input'), props);
  const key = props.id || props.placeholder;
  input.value = drafts.get(key) || '';
  input.addEventListener('input', () => drafts.set(key, input.value));
  return input;
}
/** Is someone typing in a text box inside this panel (with a real keyboard, or the on-screen one)? */
function typingIn(root) {
  const el = document.activeElement;
  return !!osk.input || (!!el && el.tagName === 'INPUT' && el.type !== 'number' && root.contains(el));
}
/** Redraw a panel without losing your place: the controller's highlight goes straight back on the
 *  same control, and a text box someone is typing in keeps its cursor. */
function redraw(root, draw) {
  const el = document.activeElement;
  const inside = !!el && el !== root && root.contains(el);
  const typing = inside && el.tagName === 'INPUT' && el.type !== 'number' ? { sig: sigOf(el), a: el.selectionStart, b: el.selectionEnd } : null;
  draw();
  if (!inside || root.contains(document.activeElement)) return;
  if (state.inputMode === 'pad') { if (topPanel() === root) regainFocus(root); return; }
  const again = typing && [...root.querySelectorAll('input')].find((i) => sigOf(i) === typing.sig);
  if (!again) return;
  again.focus({ preventScroll: true });
  try { again.setSelectionRange(typing.a, typing.b); } catch { /* not a text box */ }
}
function renderSquadPanel() { redraw($('squadpanel'), drawSquadPanel); }
function drawSquadPanel() {
  const sq = state.squad;
  const rank = sq.myRank, leader = rank === 'leader', canInvite = !sq.id || rank !== 'member';
  $('sqTitle').textContent = sq.id ? `Crew: ${sq.name}` : 'Crew';
  const inv = $('sqInvite'); inv.innerHTML = '';
  if (state.invite) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${state.invite.fromName} invited you to ${state.invite.crewName ? `join <b>${state.invite.crewName}</b>` : 'start a crew with them'}</div><div class="st">Joining moves you out of any crew you're in now.</div></div>`;
    row.append(btn('Accept', () => { send({ t: 'squad', action: 'accept' }); state.invite = null; renderSquadPanel(); }, ''),
      btn('Decline', () => { send({ t: 'squad', action: 'decline' }); state.invite = null; renderSquadPanel(); }));
    inv.append(row);
  }
  const mem = $('sqMembers'); mem.innerHTML = '';
  if (!sq.id) {
    mem.innerHTML = '<div class="empty">No crew. Found one, or invite someone below. Crews are permanent teams: they share a stash house, revive each other, hack faster together, split contract rewards and climb the crew board.</div>';
    const row = document.createElement('div');
    row.className = 'item';
    const input = draftInput({ placeholder: 'Crew name', maxLength: 20, id: 'crewNameIn' });
    row.append(input, btn('Found crew', () => send({ t: 'squad', action: 'create', name: input.value }), ''));
    mem.append(row);
  } else {
    const head = document.createElement('div');
    head.className = 'sub'; head.style.textAlign = 'left';
    head.innerHTML = `${sq.members.length} members · crew score ${sq.score} · you are ${rank === 'leader' ? 'the leader' : `${rank === 'officer' ? 'an' : 'a'} ${rank}`}`;
    mem.append(head);
  }
  const RANK = { leader: '★ Leader', officer: '◆ Officer', member: 'Member' };
  for (const m of sq.members) {
    const row = document.createElement('div');
    row.className = 'item';
    const me = m.id === state.id && m.online;
    row.innerHTML = `<div class="meta"><div class="nm"><span class="${m.online ? 'good' : 'muted'}">●</span> ${m.name} <small class="muted">lvl ${m.level} · ${RANK[m.rank]}${me ? ' · you' : m.online ? '' : ' · offline'}</small></div></div>`;
    if (leader && !me) {
      row.append(btn('Make leader', () => send({ t: 'squad', action: 'leader', pid: m.pid })));
      row.append(m.rank === 'officer' ? btn('Demote', () => send({ t: 'squad', action: 'demote', pid: m.pid })) : btn('Make officer', () => send({ t: 'squad', action: 'officer', pid: m.pid })));
    }
    if (!me && (leader || (rank === 'officer' && m.rank === 'member'))) row.append(btn('Remove', () => send({ t: 'squad', action: 'kick', pid: m.pid })));
    if (me) row.append(btn('Leave crew', () => send({ t: 'squad', action: 'leave' })));
    mem.append(row);
  }
  if (leader) {
    const row = document.createElement('div');
    row.className = 'item';
    const input = draftInput({ placeholder: 'New crew name', maxLength: 20 });
    row.append(input, btn('Rename', () => { send({ t: 'squad', action: 'rename', name: input.value }); drafts.delete('New crew name'); }));
    mem.append(row);
  }
  const on = $('sqOnline'); on.innerHTML = '';
  const others = [...state.players.values()].map((r) => r.data).filter((p) => !p.sq);
  if (!others.length) on.innerHTML = '<div class="empty">Nobody else nearby is online.</div>';
  for (const p of others) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${p.name} <small class="muted">lvl ${p.level}</small></div></div>`;
    if (canInvite) row.append(btn('Crew invite', () => send({ t: 'squad', action: 'invite', id: p.id })));
    row.append(btn('Trade', () => { send({ t: 'ptrade', action: 'request', id: p.id }); }));
    if (lobby.state && !lobby.state.friends.some((f) => f.name === p.name) && !lobby.state.sent.includes(p.name)) row.append(btn('Add friend', () => hubSend({ t: 'friendRequest', name: p.name })));
    on.append(row);
  }
  renderFriends($('sqFriends'), true);
  renderBoards();
}
function renderBoards() {
  const lb = $('sqBoard');
  lb.innerHTML = `<tr><th>#</th><th>Agent</th><th>Level</th><th>XP</th><th>Kills</th></tr>` +
    (state.leaderboard || []).map((r, i) => `<tr class="${r.online ? 'online' : ''}"><td>${i + 1}</td><td>${r.name}</td><td>${r.level}</td><td>${r.xp}</td><td>${r.kills}</td></tr>`).join('');
  const cb = $('sqCrewBoard');
  cb.innerHTML = `<tr><th>#</th><th>Crew</th><th>Leader</th><th>Members</th><th>Home</th><th>Score</th></tr>` +
    (state.crewBoard || []).map((r, i) => `<tr class="${r.name === state.squad.name ? 'online' : ''}"><td>${i + 1}</td><td>${r.name}</td><td>${r.leader}</td><td>${r.members}${r.online ? ` (${r.online} on)` : ''}</td><td>${r.home ? `Lv${r.home}` : '—'}</td><td>${r.score}</td></tr>`).join('') +
    ((state.crewBoard || []).length ? '' : '<tr><td colspan="6" class="empty">No crews yet.</td></tr>');
}

// ------------------------------------------------------------------ controller (Backbone One / any standard gamepad)
// Uses the browser Gamepad API "standard" layout, which is what the Backbone One reports on
// iPhone (MFi) and Android. Note: browsers only expose gamepads on HTTPS (or localhost) pages,
// and only after a button has been pressed.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS = {
  [BTN.A]: 'padA', [BTN.B]: 'crouch', [BTN.X]: 'reload', [BTN.Y]: 'swap', [BTN.LB]: 'sensor', [BTN.RB]: 'tag',
  [BTN.R3]: 'camo', [BTN.UP]: 'heal', [BTN.DOWN]: 'ping', [BTN.LEFT]: 'rally', [BTN.RIGHT]: 'build',
  [BTN.VIEW]: 'inventory', [BTN.MENU]: 'map',
};
const GLYPHS = { E: 'A', R: 'X', Q: 'Y', G: 'LB', F: 'RB', V: 'R3', T: '◀', B: '▼', H: '▲', P: '⧉ → Crew', M: '☰', X: '▶', LMB: 'RT', Tab: '⧉' };
const pad = { prev: [], moveX: 0, moveY: 0, sprint: false, navAt: 0, settings: { lookSpeed: 2.6, invertY: false } };
try { Object.assign(pad.settings, JSON.parse(localStorage.getItem('dz_pad') || '{}')); } catch { /* keep the defaults */ }
/** Look speed and up/down direction for the controller's right stick (in the crew panel). */
function renderPadSettings() {
  const box = $('padSettings');
  if (!box) return;
  const keep = document.activeElement?.dataset?.pad;
  const save = () => { try { localStorage.setItem('dz_pad', JSON.stringify(pad.settings)); } catch { /* private mode */ } renderPadSettings(); };
  box.innerHTML = '';
  const row = document.createElement('div'); row.className = 'item';
  row.innerHTML = `<div class="meta"><div class="nm">Look speed: ${pad.settings.lookSpeed.toFixed(1)}</div><div class="st">How fast the right stick turns you.</div></div>`;
  const slower = btn('Slower', () => { pad.settings.lookSpeed = Math.max(0.8, +(pad.settings.lookSpeed - 0.2).toFixed(1)); save(); });
  const faster = btn('Faster', () => { pad.settings.lookSpeed = Math.min(6, +(pad.settings.lookSpeed + 0.2).toFixed(1)); save(); });
  slower.dataset.pad = 'slower'; faster.dataset.pad = 'faster';
  row.append(slower, faster);
  const row2 = document.createElement('div'); row2.className = 'item';
  row2.innerHTML = '<div class="meta"><div class="nm">Look up and down</div><div class="st">Inverted: pull the stick back to look up.</div></div>';
  const inv = btn(pad.settings.invertY ? 'Inverted' : 'Normal', () => { pad.settings.invertY = !pad.settings.invertY; save(); });
  inv.dataset.pad = 'invert';
  row2.append(inv);
  const row3 = document.createElement('div'); row3.className = 'item';
  row3.innerHTML = '<div class="meta"><div class="nm">Sprint</div><div class="st">Click the left stick (L3) to sprint. With auto-sprint on, pushing the stick all the way forward sprints too.</div></div>';
  const as = btn(pad.settings.autoSprint ? 'Auto-sprint on' : 'Auto-sprint off', () => { pad.settings.autoSprint = !pad.settings.autoSprint; save(); });
  as.dataset.pad = 'autosprint';
  row3.append(as);
  const row4 = document.createElement('div'); row4.className = 'item';
  row4.innerHTML = `<div class="meta"><div class="nm">Sound: ${Math.round(sfx.getVolume() * 100)}%</div><div class="st">Gunshots, footsteps, hits, reloads and alerts.</div></div>`;
  const quieter = btn('Quieter', () => { sfx.setVolume(+(sfx.getVolume() - 0.1).toFixed(1)); sfx.click(true); save(); });
  const louder = btn('Louder', () => { sfx.setVolume(+(sfx.getVolume() + 0.1).toFixed(1)); sfx.click(true); save(); });
  quieter.dataset.pad = 'quieter'; louder.dataset.pad = 'louder';
  row4.append(quieter, louder);
  const row5 = document.createElement('div'); row5.className = 'item';
  row5.innerHTML = `<div class="meta"><div class="nm">Graphics: ${GFX[gfxMode].label}</div><div class="st">${GFX[gfxMode].about}</div></div>`;
  for (const m of Object.keys(GFX)) {
    const b = btn(GFX[m].label, () => { applyGfx(m); renderPadSettings(); }, m === gfxMode ? '' : 'ghost');
    b.dataset.pad = `gfx-${m}`;
    row5.append(b);
  }
  const rowA = document.createElement('div'); rowA.className = 'item';
  rowA.innerHTML = '<div class="meta"><div class="nm">Aim assist (phone and controller)</div><div class="st">Over an enemy your aim slows so you don\'t sweep past; while you move or fire it gently follows them; pressing AIM near one settles your sights on them. Never with a mouse.</div></div>';
  for (const [m, l] of [['off', 'Off'], ['light', 'Light'], ['strong', 'Strong']]) { const b = btn(l, () => { tset.aimAssist = m; saveTset(); renderPadSettings(); }, (tset.aimAssist || 'strong') === m ? '' : 'ghost'); b.dataset.pad = `assist-${m}`; rowA.append(b); }
  box.append(row5, row, row2, row3, row4, rowA, pushRow());
  if (touchCapable) {
    const t1 = document.createElement('div'); t1.className = 'item';
    t1.innerHTML = '<div class="meta"><div class="nm">Phone controls: layout</div><div class="st">Move any button where your thumbs want it, make them bigger or smaller, more or less see-through.</div></div>';
    t1.append(btn('Edit layout', () => editTouch('start')));
    const t2 = document.createElement('div'); t2.className = 'item';
    t2.innerHTML = '<div class="meta"><div class="nm">Second FIRE button (left side)</div><div class="st">Shoot with your left thumb while your right thumb aims.</div></div>';
    t2.append(btn(tset.leftFire ? 'On' : 'Off', () => { tset.leftFire = !tset.leftFire; saveTset(); applyTouchLayout(); renderPadSettings(); }, tset.leftFire ? '' : 'ghost'));
    const t3 = document.createElement('div'); t3.className = 'item';
    t3.innerHTML = '<div class="meta"><div class="nm">Gyro aim</div><div class="st">Turn the phone to fine-tune your aim. While aiming only, or all the time.</div></div>';
    for (const [m, l] of [['off', 'Off'], ['aim', 'While aiming'], ['always', 'Always']]) t3.append(btn(l, async () => { await setGyro(m); renderPadSettings(); }, tset.gyro === m ? '' : 'ghost'));
    const t4 = document.createElement('div'); t4.className = 'item';
    t4.innerHTML = '<div class="meta"><div class="nm">AIM button</div><div class="st">Tap to aim and tap again to stop, hold to aim while held, or both: a quick tap toggles, a long press aims until you let go.</div></div>';
    for (const [m, l] of [['mixed', 'Tap or hold'], ['tap', 'Tap'], ['hold', 'Hold']]) t4.append(btn(l, () => { tset.aimMode = m; saveTset(); renderPadSettings(); }, (tset.aimMode || 'mixed') === m ? '' : 'ghost'));
    const t5 = document.createElement('div'); t5.className = 'item';
    t5.innerHTML = '<div class="meta"><div class="nm">Auto-fire</div><div class="st">Your gun fires by itself when the crosshair is on an enemy in range. Off, only while aiming, or always.</div></div>';
    for (const [m, l] of [['off', 'Off'], ['aim', 'While aiming'], ['always', 'Always']]) t5.append(btn(l, () => { tset.autoFire = m; saveTset(); renderPadSettings(); }, tset.autoFire === m ? '' : 'ghost'));
    const t6 = document.createElement('div'); t6.className = 'item';
    t6.innerHTML = `<div class="meta"><div class="nm">Look speed while aiming: ${Math.round((tset.adsSens || 1) * 100)}%</div><div class="st">How fast a drag turns the view through sights and scopes (scopes already slow it by their zoom).</div></div>`;
    t6.append(btn('Slower', () => { tset.adsSens = Math.max(0.4, +((tset.adsSens || 1) - 0.1).toFixed(2)); saveTset(); renderPadSettings(); }),
      btn('Faster', () => { tset.adsSens = Math.min(2, +((tset.adsSens || 1) + 0.1).toFixed(2)); saveTset(); renderPadSettings(); }));
    const t7 = document.createElement('div'); t7.className = 'item';
    t7.innerHTML = '<div class="meta"><div class="nm">Pick up by walking over</div><div class="st">What you take just by walking over it. Everything else is in the list by your right thumb: tap to take.</div></div>';
    for (const [k, l] of [['ammo', 'Ammo'], ['heals', 'Medkits & food'], ['supplies', 'Supplies'], ['gear', 'Tools & gear']]) t7.append(btn(`${l}: ${tset.autoPick[k] ? 'on' : 'off'}`, () => { tset.autoPick[k] = !tset.autoPick[k]; saveTset(); renderPadSettings(); }, tset.autoPick[k] ? '' : 'ghost'));
    box.append(t1, t2, t3, t4, t5, t6, t7);
  }
  if (keep) { const el = box.querySelector(`[data-pad="${keep}"]`); if (el && state.inputMode === 'pad') padFocus(el); }
}

// ------------------------------------------------------------------ on-screen keyboard (so a controller can type a callsign or a crew name)
const osk = { input: null, text: '' };
const OSK_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL-', 'ZXCVBNM_.'];
function openOsk(input) {
  osk.input = input; osk.sig = sigOf(input); osk.text = input.value || '';
  $('oskLabel').textContent = input.placeholder || 'Type';
  $('oskText').dataset.hint = input.placeholder || '';   // shown inside the box on short screens
  const keys = $('oskKeys'); keys.innerHTML = '';
  for (const chars of OSK_ROWS) {
    const r = document.createElement('div'); r.className = 'oskrow';
    for (const ch of chars) r.append(btn(ch, () => oskType(ch), 'oskkey'));
    keys.append(r);
  }
  const r = document.createElement('div'); r.className = 'oskrow';
  r.append(btn('Space', () => oskType(' '), 'oskkey wide'), btn('Delete', () => oskType(null), 'oskkey wide'), btn('Done', () => closeOsk(true), 'oskkey wide done'), btn('Cancel', () => closeOsk(false), 'oskkey wide'));
  keys.append(r);
  $('osk').hidden = false;
  oskType('');
  if (state.inputMode === 'pad') padFocus(keys.querySelector('.oskrow:nth-child(2) .oskkey'));   // start on the letters
}
function oskType(ch) {
  const max = osk.input.maxLength > 0 ? osk.input.maxLength : 24;
  if (ch === null) osk.text = osk.text.slice(0, -1);
  // Capital at the start of each word, small letters after: "Swamp Fox", not "SWAMP FOX".
  else if (ch && osk.text.length < max) osk.text += osk.text.length && !/[ \-_.]$/.test(osk.text) ? ch.toLowerCase() : ch;
  $('oskText').textContent = osk.text;
  $('oskText').classList.toggle('empty', !osk.text);
}
function closeOsk(apply) {
  let input = osk.input;
  $('osk').hidden = true;
  osk.input = null;
  if (!input) return;
  // If the panel behind the keyboard was redrawn meanwhile, write into the box that replaced this one.
  if (!input.isConnected) input = [...document.querySelectorAll('input')].find((i) => sigOf(i) === osk.sig && i.offsetParent !== null);
  if (!input) return;
  if (apply) { input.value = osk.text.trim(); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
  if (state.inputMode === 'pad') padFocus(input);
}
/** Left / right on a number box or a pick-list changes it (by `d`), instead of moving on. */
function padAdjust(el, d) {
  if (el.tagName === 'SELECT') el.selectedIndex = (el.selectedIndex + (d > 0 ? 1 : -1) + el.options.length) % el.options.length;
  else {
    const min = el.min !== '' ? Number(el.min) : -Infinity, max = el.max !== '' ? Number(el.max) : Infinity;
    el.value = Math.max(min, Math.min(max, (Number(el.value) || 0) + d));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function airHud() {
  const a = state.air, height = `${Math.round(a.alt * 3.28084 / 10) * 10} ft`;
  if (a.mode === 'chute') return `🪂 ${height} · steer to land`;
  const sprint = state.inputMode === 'pad' ? 'L3' : !$('touch').hidden ? 'Sprint' : 'Shift';
  return `${a.mode === 'suit' ? '🐿 Squirrel suit' : 'Freefall'} · ${height} · hold <kbd>${sprint}</kbd> to fly the suit · <kbd>${glyph('E')}</kbd> pull chute (opens by itself at ${feet(SKY.autoChute, 10)})`;
}
// On a phone: the on-screen button (or where to find it) instead of a key it hasn't got.
const TOUCH_NAMES = { E: 'USE', M: 'the minimap', Tab: '⋯', P: '⋯ → CREW', V: '⋯ → CAMO', X: '⋯ → BUILD', Q: 'swap' };
function glyph(k) { return state.inputMode === 'pad' ? (GLYPHS[k] || k) : state.touchUI ? (TOUCH_NAMES[k] || k) : k; }
// Downed on a phone: Patch up, or Give up (tapped twice, so a panicked thumb doesn't end it).
$('downtouch').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-down]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (b.dataset.down === 'patch') return send({ t: 'interact' });
  if (!b.classList.contains('sure')) {
    b.classList.add('sure'); b.textContent = 'Tap again to give up';
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('sure'); b.textContent = 'Give up'; }, 2500);
    return;
  }
  b.classList.remove('sure'); b.textContent = 'Give up';
  send({ t: 'giveUp' });
});

for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => sfx.unlock(), { passive: true });
function setInputMode(m) {
  if (state.inputMode === m) return;
  state.inputMode = m;
  document.body.classList.toggle('pad', m === 'pad');
  if (m === 'pad') document.body.classList.add('padseen');   // the lobby shows controller help from now on
  // Back on touch or a real keyboard: text boxes may raise the phone's keyboard again.
  if (m !== 'pad') for (const i of document.querySelectorAll('input[inputmode="none"]')) i.removeAttribute('inputmode');
  if (m === 'pad') document.exitPointerLock?.();
  updateGadgetBar();
}

addEventListener('gamepadconnected', (e) => toast(`Controller connected: ${e.gamepad.id.split('(')[0].trim() || 'gamepad'}`));
addEventListener('gamepaddisconnected', () => { toast('Controller disconnected'); pad.moveX = pad.moveY = 0; state.mouseDown = false; });

function readPad() {
  if (!navigator.getGamepads) return null;
  for (const g of navigator.getGamepads()) if (g && g.connected) return g;
  return null;
}
const deadzone = (v, d = 0.16) => (Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d));

function topPanel() {
  for (const id of ['osk', 'ridepanel', 'tradepanel', 'mapscreen', 'contactpanel', 'gunsmith', 'squadpanel', 'inventory', 'login']) if (!$(id).hidden) return $(id);
  return null;
}
function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]):not(.nopad), input, select')].filter((el) => el.offsetParent !== null);
}
/** What a control is, so it can be found again after its panel is redrawn. */
function sigOf(el) { return el.id || el.dataset.pad || el.dataset.res || el.placeholder || el.textContent.trim().slice(0, 40); }
function padFocus(el) {
  const prev = document.activeElement;
  if (prev && prev !== el) { prev.classList.remove('padfocus'); prev.dispatchEvent(new MouseEvent('mouseleave')); }
  for (const stale of document.querySelectorAll('.padfocus')) if (stale !== el) stale.classList.remove('padfocus');
  el.classList.add('padfocus');
  // The controller types on the game's own keyboard, so the phone's must stay down.
  if (el.tagName === 'INPUT') el.setAttribute('inputmode', 'none');
  const root = topPanel();
  pad.mark = root && root.contains(el) ? { panel: root.id, idx: focusables(root).indexOf(el), sig: sigOf(el) } : null;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.dispatchEvent(new MouseEvent('mouseenter'));   // drives gunsmith previews and map highlights
}
/** Spatial menu navigation: move to the nearest control in the pushed direction. */
/**
 * Lists: up and down go along the column, left and right switch columns. Buttons that sit in one
 * row (data-navrow, like tabs or Earlier / Later) take left and right first.
 */
function moveInLists(root, cur, dx, dy) {
  const cols = [...root.querySelectorAll('[data-navcol]')].filter((c) => c.offsetParent !== null && focusables(c).length);
  const colOf = (el) => cols.find((c) => c.contains(el));
  const col = colOf(cur);
  if (!col) return false;
  const list = focusables(col), row = cur.closest('[data-navrow]');
  const nearestIn = (els) => { const a = cur.getBoundingClientRect(), y = a.top + a.height / 2, x = a.left + a.width / 2; return els.reduce((best, el) => { const b = el.getBoundingClientRect(), d = Math.abs(b.top + b.height / 2 - y) * 3 + Math.abs(b.left + b.width / 2 - x); return !best || d < best.d ? { el, d } : best; }, null)?.el; };
  if (dx) {
    if (row) { const rl = focusables(row), k = rl.indexOf(cur) + dx; if (k >= 0 && k < rl.length) { padFocus(rl[k]); return true; } }
    const side = cols.filter((c) => c !== col && c.dataset.navcol !== 'top').sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const target = side.find((c) => (dx > 0 ? c.getBoundingClientRect().left > col.getBoundingClientRect().left : c.getBoundingClientRect().left < col.getBoundingClientRect().left));
    if (target) { padFocus(nearestIn(focusables(target))); return true; }
    return true;   // nothing that way: stay put
  }
  // Up and down: the next line in this column (skipping the rest of a row of buttons).
  let k = list.indexOf(cur);
  do k += dy; while (k >= 0 && k < list.length && row && row.contains(list[k]));
  if (k >= 0 && k < list.length) { padFocus(list[k]); return true; }
  const top = cols.find((c) => c.dataset.navcol === 'top');
  if (dy < 0 && top && col !== top) { padFocus(nearestIn(focusables(top))); return true; }
  if (dy > 0 && col === top) { const first = cols.filter((c) => c !== top).map((c) => focusables(c)[0]).filter(Boolean); if (first.length) padFocus(nearestIn(first)); return true; }
  return true;
}
function moveFocus(root, dx, dy) {
  const list = focusables(root);
  if (!list.length) return;
  sfx.click();
  if (root.dataset.nav === 'lists' && list.includes(document.activeElement) && moveInLists(root, document.activeElement, dx, dy)) return;
  const cur = document.activeElement;
  // Start on the first button rather than a text box, so the phone keyboard doesn't pop up.
  if (!list.includes(cur)) return padFocus(list.find((el) => el.tagName === 'BUTTON') || list[0]);
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const vx = b.left + b.width / 2 - ax, vy = b.top + b.height / 2 - ay;
    const along = vx * dx + vy * dy;
    if (along <= 4) continue;
    const across = Math.abs(vx * dy - vy * dx);
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  // Nothing in that direction: step through controls in reading order instead.
  if (!best) best = list[(list.indexOf(cur) + (dx + dy > 0 ? 1 : -1) + list.length) % list.length];
  padFocus(best);
}
/** A redraw (or a newly opened screen) left nothing highlighted: find the same control again, or
 *  start at the top. Says whether it had to start at the top. */
function regainFocus(panel) {
  const list = focusables(panel);
  if (!list.length) return false;
  const m = pad.mark && pad.mark.panel === panel.id ? pad.mark : null;
  if (!m) { moveFocus(panel, 0, 1); return true; }
  let best = null, gap = Infinity;
  list.forEach((el, i) => { if (sigOf(el) === m.sig && Math.abs(i - m.idx) < gap) { gap = Math.abs(i - m.idx); best = el; } });
  padFocus(best || list[Math.min(Math.max(m.idx, 0), list.length - 1)]);
  return false;
}
function padBack() {
  if (osk.input) return closeOsk(false);
  if (state.invOpen && invUi.menuFor) return closeInvMenu();
  if (ptrade.open) return send({ t: 'ptrade', action: 'cancel' });
  if (state.rideOpen) return closeRidePicker();
  if (state.mapOpen) { if (state.mapMode === 'view' || state.mapMode === 'travel') closeMapScreen(); }
  else if (state.contactOpen) closeContact();
  else if (state.gunsmithOpen) closeGunsmith();
  else if (state.panelOpen) closeSquadPanel();
  else if (state.invOpen) closeInventory();
}

function pollPad(dt, now) {
  const g = readPad();
  if (!g) { pad.moveX = pad.moveY = 0; return; }
  const b = (i) => !!g.buttons[i]?.pressed;
  const val = (i) => g.buttons[i]?.value ?? 0;
  const just = (i) => b(i) && !pad.prev[i];
  const ax = g.axes.map((v) => v ?? 0);
  if (g.buttons.some((x) => x.pressed) || ax.some((v) => Math.abs(v) > 0.4)) { setInputMode('pad'); if (!pad.audioTried) { pad.audioTried = true; sfx.unlock(); } }
  if (state.inputMode !== 'pad') { pad.prev = g.buttons.map((x) => x.pressed); return; }

  // A question at the top of the screen (a friend's invite, a trade request): hold ⧉ to say yes.
  // While one is showing, ⧉ does its usual job when you let go, so a hold can be told from a tap.
  const asking = !$('invitebar').hidden;
  if (just(BTN.VIEW)) { pad.viewAt = now; pad.viewAsk = asking; pad.viewHeld = false; }
  if (pad.viewAsk && b(BTN.VIEW) && !pad.viewHeld && now - pad.viewAt > 500) { pad.viewHeld = true; if (asking) $('invitebar').querySelector('button')?.click(); }
  // Let go after a long hold that no frame caught (a slow frame): still a yes, not a tap.
  // (A hold only counts while the button is still down at 0.5 s: a tap during a slow frame stays a tap.)
  const viewTap = pad.viewAsk ? !b(BTN.VIEW) && !!pad.prev[BTN.VIEW] && !pad.viewHeld : just(BTN.VIEW);

  const panel = topPanel();
  if (!panel) { pad.panelId = null; pad.mark = null; }
  if (panel) {
    // Menu mode: D-pad / left stick to move focus, A to select, B to go back, right stick scrolls.
    // A screen that has just come up starts on its first choice, and ignores Ⓐ for a moment so a
    // button mashed as it opened doesn't pick something by accident.
    // (The on-screen keyboard is exempt: you opened it yourself, and its first letter must not be lost.)
    if (pad.panelId !== panel.id) { pad.panelId = panel.id; pad.armAt = panel.id === 'osk' ? 0 : now + 300; if (pad.mark && pad.mark.panel !== panel.id) pad.mark = null; }
    pad.moveX = pad.moveY = 0;
    if (state.inputMode === 'pad') { state.mouseDown = false; state.aiming = false; }
    const sx = deadzone(ax[0], 0.5), sy = deadzone(ax[1], 0.5);
    const dir = b(BTN.UP) || sy < 0 ? [0, -1] : b(BTN.DOWN) || sy > 0 ? [0, 1] : b(BTN.LEFT) || sx < 0 ? [-1, 0] : b(BTN.RIGHT) || sx > 0 ? [1, 0] : null;
    const navPressed = [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT].some(just);
    // Screens redraw when the server sends news, and that drops the highlight: put it back.
    const fresh = (!document.activeElement || !panel.contains(document.activeElement) || document.activeElement === panel) && regainFocus(panel);
    const cur = document.activeElement;
    const dial = cur && panel.contains(cur) && (cur.tagName === 'SELECT' || (cur.tagName === 'INPUT' && cur.type === 'number'));
    if (dir && fresh) pad.navAt = now + 380;   // the push that woke the highlight doesn't also move it
    else if (dir && (navPressed || now > pad.navAt)) {
      // On a number box or a pick-list, left and right change it (hold LB or RB for tens); up and down move on.
      if (dial && dir[0]) { padAdjust(cur, dir[0] * (b(BTN.LB) || b(BTN.RB) ? 10 : 1)); pad.navAt = now + (navPressed ? 380 : 90); }
      else { moveFocus(panel, dir[0], dir[1]); pad.navAt = now + (navPressed ? 380 : 160); }
    }
    if (!dir) pad.navAt = 0;
    if (panel.id === 'mapscreen') {
      // The right stick slides the map about.
      const mx = deadzone(ax[2]), mz = deadzone(ax[3]);
      if (mx || mz) { const span = state.map.size / mapView.zoom; mapView.cx += mx * span * dt * 0.9; mapView.cz += mz * span * dt * 0.9; drawMapCanvas(); }
    } else {
      const scroller = panel.id === 'gunsmith' ? $('gsOptions') : panel;
      if (scroller) scroller.scrollTop += deadzone(ax[3]) * 600 * dt;
    }
    if (panel.id === 'osk') {
      if (just(BTN.X)) oskType(null);
      if (just(BTN.Y)) oskType(' ');
      if (just(BTN.MENU)) closeOsk(true);
    }
    if (just(BTN.A) && now > (pad.armAt || 0)) {
      sfx.click(true);
      const el = document.activeElement;
      if (el && panel.contains(el) && el.tagName === 'INPUT' && el.type !== 'number') openOsk(el);
      else if (el && panel.contains(el) && el.tagName === 'BUTTON') {
        const idx = focusables(panel).indexOf(el);
        el.click();
        // Panels re-render after most actions; put the highlight back on the same control (or near where it was).
        setTimeout(() => { const p = topPanel(); if (!p) return; const l = focusables(p); if (l.length && !l.includes(document.activeElement)) { if (pad.mark?.panel === p.id) regainFocus(p); else padFocus(l[Math.min(idx, l.length - 1)]); } }, 150);
      } else if (!el || !panel.contains(el)) moveFocus(panel, 0, 1);
    }
    // A press that lands in a window belongs to the window: its release (or hold) mustn't reach the game
    // as a crouch, prone or map once the window has closed.
    if (just(BTN.B)) { pad.bEat = true; padBack(); }
    if (just(BTN.MENU)) pad.menuEat = true;
    if (just(BTN.Y) && state.gunsmithOpen) $('gsExplode').click();
    if (viewTap && !['login', 'mapscreen', 'osk', 'tradepanel'].includes(panel.id)) doAction('inventory');
    if (just(BTN.MENU) && panel.id === 'mapscreen') doAction('map');
    if (panel.id === 'mapscreen' && state.mapMode === 'view') {
      if (just(BTN.X)) setWaypoint(mapView.cx, mapView.cz);
      if (just(BTN.Y)) mapPing(mapView.cx, mapView.cz);
    }
    if (panel.id === 'mapscreen') { mapView.zoom = Math.max(1, Math.min(60, mapView.zoom * (1 + (val(BTN.RT) - val(BTN.LT)) * dt * 2))); if (val(BTN.RT) + val(BTN.LT) > 0.05) drawMapCanvas(); }
  } else if (state.me && !state.me.dead) {
    // Gameplay.
    pad.moveX = deadzone(ax[0]);
    pad.moveY = -deadzone(ax[1]);
    if (just(BTN.L3)) pad.sprint = !pad.sprint;
    if (Math.hypot(pad.moveX, pad.moveY) < 0.2 && !state.air) pad.sprint = false;
    // Look: response curve for fine aim, slower while aiming down sights, light aim slowdown over targets.
    aimPoint();
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 1.8;
    const lx = curve(deadzone(ax[2], 0.12)), ly = curve(deadzone(ax[3], 0.12));
    const zoomScale = state.aiming ? camera.fov / 70 : 1;
    const slow = assistFriction();
    const speed = pad.settings.lookSpeed * zoomScale * slow;
    state.yaw -= lx * speed * dt; if (Math.abs(lx) > 0.05) state.lookAt = performance.now();
    state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch - ly * speed * 0.75 * dt * (pad.settings.invertY ? -1 : 1)));
    if (state.inputMode === 'pad') {   // a controller that's connected but idle leaves touch AIM / FIRE alone
      state.aiming = val(BTN.LT) > 0.35;
      const firing = val(BTN.RT) > 0.35;
      if (firing && !state.mouseDown) state.firedThisPress = false;
      state.mouseDown = firing;
    }
    for (const [i, action] of Object.entries(PAD_ACTIONS)) if (![BTN.LB, BTN.MENU, BTN.VIEW, BTN.B].includes(Number(i)) && just(Number(i))) doAction(action);
    // Ⓑ: tap to crouch, hold to go prone (while downed, Ⓑ does nothing).
    const bb = b(BTN.B);
    if (bb && !pad.prev[BTN.B] && !pad.bEat) { pad.bAt = now; pad.bHeld = false; }
    if (bb && !pad.bEat && !pad.bHeld && now - pad.bAt > 400) { pad.bHeld = true; doAction('prone'); }
    if (!bb && pad.prev[BTN.B] && !pad.bHeld && !pad.bEat) doAction(now - pad.bAt > 400 ? 'prone' : 'crouch');   // judged by how long it was down, even on a slow frame
    if (!bb) pad.bEat = false;   // a B that closed a window is spent once it's let go
    if (viewTap) doAction('inventory');
    // ☰: the map (press it again, or Ⓑ, to close it). Crew and settings are in the bag.
    if (just(BTN.MENU) && !pad.menuEat) doAction('map');
    if (!b(BTN.MENU)) pad.menuEat = false;
    // LB: tap throws your grenade, hold to switch between sensor and stun.
    const lb = !!g.buttons[BTN.LB]?.pressed;
    if (lb && !pad.prev[BTN.LB]) { pad.lbAt = performance.now(); pad.lbSwitched = false; }
    if (lb && !pad.lbSwitched && performance.now() - pad.lbAt > 400) { pad.lbSwitched = true; doAction('switchGrenade'); }
    if (!lb && pad.prev[BTN.LB] && !pad.lbSwitched) doAction(performance.now() - pad.lbAt > 400 ? 'switchGrenade' : 'sensor');
  }
  pad.prev = g.buttons.map((x) => x.pressed);
}

// Panels opened by controller get an initial focus so A works immediately.
new MutationObserver(() => {
  if (state.inputMode !== 'pad') return;
  const p = topPanel();
  // (A screen that redrew itself gets the same control back, not its first button.)
  if (p && !p.contains(document.activeElement)) { const l = focusables(p); if (l.length) { if (pad.mark?.panel === p.id) regainFocus(p); else padFocus(l.find((el) => el.tagName === 'BUTTON') || l[0]); } }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

$('openSquadBtn').onclick = () => { closeInventory(); openSquadPanel(); };
$('openMapBtn').onclick = () => { closeInventory(); openMapScreen('view'); };
// Testing: a ride of any kind, put right beside you (while the server allows it). Its own little
// window; a pick answers on the release of the tap (and a click), once, and says so at once.
function openRidePicker() {
  const el = $('ridepick');
  if (!el.childElementCount) for (const [k, d] of Object.entries(BOATS)) {
    if (!d.land) continue;
    const b = document.createElement('button');
    b.className = 'ridechoice'; b.dataset.pad = `ride-${k}`;
    b.innerHTML = `<span class="ri">${d.icon}</span><b>${d.name}</b>`;
    const pick = (e) => {
      e.preventDefault();
      if (performance.now() - (el.openedAt || 0) < 300 || performance.now() - (el.pickedAt || 0) < 600) return;
      el.pickedAt = performance.now();
      send({ t: 'testRide', type: k });
      toast(`${d.icon} Bringing a ${d.name.toLowerCase()}…`);
      closeRidePicker();
    };
    b.addEventListener('pointerup', pick);
    b.addEventListener('click', pick);
    el.append(b);
  }
  if (state.invOpen) closeInventory();
  el.openedAt = performance.now();
  $('ridepanel').hidden = false;
  state.rideOpen = true;
}
function closeRidePicker() { $('ridepanel').hidden = true; state.rideOpen = false; }
$('testRideBtn').onclick = () => openRidePicker();

// ------------------------------------------------------------------ building (client)
const build = { on: false, piece: 'wall', rot: 0, ghost: null, ok: false, x: 0, z: 0 };
const structVis = new Map();   // id -> { mesh, data, key }
const chargeVis = new Map();
const STRUCT_MATS = {
  frame: new THREE.MeshStandardMaterial({ color: 0x9b7a52, transparent: true, opacity: 0.55, roughness: 1 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5533, roughness: 0.95 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x7d7c78, roughness: 1, flatShading: true }),
  charge: new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0x880000 }),
};
function structMesh(st) {
  const def = PIECES[st.type], stage = def.stages[st.stage];
  const b = pieceBox(st.type, st.x, st.z, st.ang !== undefined ? 0 : st.rot, st.y0);   // turned ones are built square, then turned
  const w = b.maxX - b.minX, d = b.maxZ - b.minZ, h = b.h + 0.15;
  const g = new THREE.Group();
  const mat = STRUCT_MATS[stage.material] || STRUCT_MATS.wood;
  if (stage.material === 'frame') {
    // Scaffolding: posts and rails you can see (and walk) through.
    const long = Math.max(w, d), alongX = w >= d;
    for (const f of [-0.5, 0, 0.5]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, h, 0.15), mat);
      post.position.set(alongX ? f * (long - 0.15) : 0, h / 2, alongX ? 0 : f * (long - 0.15));
      g.add(post);
    }
    for (const y of [0.4, h - 0.1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(alongX ? long : 0.12, 0.12, alongX ? 0.12 : long), mat);
      rail.position.y = y;
      g.add(rail);
    }
  } else if (def.farm) {
    // Tilled soil with crop rows that grow as the crop does.
    const soil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, d), new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 1 }));
    soil.position.y = 0.09;
    g.add(soil);
    if (st.crop) {
      const grow = Math.max(0.12, st.grow || 0);
      const ripe = (st.grow || 0) >= 1;
      const color = st.rotten ? 0x5a4a30 : !ripe ? 0x4f8a3a : st.crop === 'corn' ? 0xc9b84a : st.crop === 'cotton' ? 0xf2f2ea : 0x6b9a3c;
      const tall = st.crop === 'corn' ? 1.9 : st.crop === 'cotton' ? 1.0 : 0.45;
      const cm = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const hh = tall * grow;
        const plant = new THREE.Mesh(new THREE.BoxGeometry(0.28, hh, 0.28), cm);
        plant.position.set(-w / 2 + (i + 0.5) * w / 4, 0.18 + hh / 2, -d / 2 + (j + 0.5) * d / 4);
        g.add(plant);
      }
    }
  } else if (def.defense === 'mine') {
    const dirt = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.05, 12), new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 1 }));
    dirt.position.y = 0.025; g.add(dirt);
    const prong = new THREE.MeshStandardMaterial({ color: 0x3d4a2e, roughness: 0.6, metalness: 0.3 });
    for (let i = 0; i < 3; i++) { const pr = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 4), prong); pr.position.set(Math.cos(i * 2.1) * 0.06, 0.08, Math.sin(i * 2.1) * 0.06); g.add(pr); }
    g.userData.mine = true;
  } else if (def.defense === 'tripwire') {
    // Two stakes and a thin wire between them, low to the ground.
    const long = Math.max(w, d), alongX = w >= d;
    const stake = new THREE.MeshStandardMaterial({ color: 0x5a4632 });
    for (const f of [-0.5, 0.5]) { const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.06), stake); s2.position.set(alongX ? f * long : 0, 0.22, alongX ? 0 : f * long); g.add(s2); }
    const wire = new THREE.Mesh(new THREE.BoxGeometry(alongX ? long : 0.015, 0.015, alongX ? 0.015 : long), new THREE.MeshBasicMaterial({ color: 0xbfc6cc }));
    wire.position.y = 0.3;
    g.add(wire);
  } else if (def.defense === 'sentry') {
    const metal = new THREE.MeshStandardMaterial({ color: 0x4a5058, metalness: 0.5, roughness: 0.5 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.8, 10), metal); base.position.y = 0.4;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.4, 0.6), metal); head.position.y = 1.0;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8), new THREE.MeshStandardMaterial({ color: 0x1b1d20 }));
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 1.0, 0.6);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 })); eye.position.set(0, 1.12, 0.31);
    g.add(base, head, barrel, eye);
  } else if (def.defense === 'kennel') {
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5533, roughness: 0.95 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.7, d), wood); box.position.y = h * 0.35;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.75, h * 0.45, 4), new THREE.MeshStandardMaterial({ color: 0x8a2e22 }));
    roof.rotation.y = Math.PI / 4; roof.position.y = h * 0.92;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.05), new THREE.MeshBasicMaterial({ color: 0x111111 })); door.position.set(0, 0.28, d / 2 + 0.01);
    g.add(box, roof, door);
  } else if (def.defense === 'alarm') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 6), new THREE.MeshStandardMaterial({ color: 0x777b80 })); pole.position.y = h / 2;
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3a3a })); light.position.y = h + 0.05;
    g.add(pole, light);
  } else if (def.hideout) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4e33, roughness: 0.95 });
    const tarp = new THREE.MeshStandardMaterial({ color: 0x4d5a36, roughness: 0.9, side: THREE.DoubleSide });
    for (const f of [-0.5, 0.5]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), wood); post.position.set(f * (w - 0.2), h / 2, -d / 2 + 0.1); g.add(post); }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.08), wood); ridge.position.set(0, h, -d / 2 + 0.1); g.add(ridge);
    const slope = Math.hypot(d - 0.1, h);
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.2, slope), tarp);
    sheet.rotation.x = -Math.atan2(d - 0.1, h);   // from the ridge at the back down to the ground at the front
    sheet.position.set(0, h / 2, 0.05);
    g.add(sheet);
    const locker = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x3e4a2e, roughness: 0.7 }));
    locker.position.set(0, 0.25, -d / 2 + 0.45); g.add(locker);
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.02), new THREE.MeshStandardMaterial({ color: 0xb08d3c, metalness: 0.6 }));
    latch.position.set(0, 0.42, -d / 2 + 0.71); g.add(latch);
    if (st.stage > 0) {
      const bag = new THREE.MeshStandardMaterial({ color: 0x9a8a62, roughness: 1 });
      for (const [bx, bz, bw, bd] of [[0, d / 2 + 0.2, w + 0.6, 0.35], [-w / 2 - 0.2, 0, 0.35, d + 0.4], [w / 2 + 0.2, 0, 0.35, d + 0.4]]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.55, bd), bag); wall.position.set(bx, 0.27, bz); g.add(wall);
      }
    }
  } else if (def.stall) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.9 });
    const counter = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, d), wood); counter.position.y = 0.5;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.08, d + 0.6), new THREE.MeshStandardMaterial({ color: 0xc23b2a })); roof.position.y = 2.3;
    g.add(counter, roof);
    for (const f of [-0.5, 0.5]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.3, 0.08), wood); post.position.set(f * (w - 0.1), 1.15, -d / 2 + 0.05); g.add(post); }
  } else if (def.cook) {
    // Ring of stones and a flame.
    const stone = new THREE.MeshStandardMaterial({ color: 0x77736d, roughness: 1, flatShading: true });
    for (let i = 0; i < 7; i++) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16), stone);
      r.position.set(Math.cos(i / 7 * Math.PI * 2) * 0.45, 0.1, Math.sin(i / 7 * Math.PI * 2) * 0.45);
      g.add(r);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 7), new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
    flame.position.y = 0.35;
    g.add(flame);
  } else if (def.door) {
    const long = Math.max(w, d), alongX = w >= d;
    for (const f of [-0.5, 0.5]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.3 : d, h, alongX ? d : 0.3), mat);
      post.position.set(alongX ? f * (long - 0.3) : 0, h / 2, alongX ? 0 : f * (long - 0.3));
      g.add(post);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(alongX ? long : d, 0.3, alongX ? d : long), mat);
    lintel.position.y = h - 0.15;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(alongX ? long - 0.6 : d * 0.8, h - 0.3, alongX ? d * 0.8 : long - 0.6), mat.clone());
    panel.material.color.multiplyScalar(0.8);
    panel.position.y = (h - 0.3) / 2;
    panel.visible = !st.open;
    g.add(lintel, panel);
    g.userData.panel = panel;
  } else {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.y = h / 2;
    g.add(m);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(st.x, b.y0, st.z);
  if (st.ang !== undefined) g.rotation.y = -st.ang;
  scene.add(g);
  return g;
}
function syncStructs(list) {
  const seen = new Set();
  for (const st of list) {
    seen.add(st.id);
    const key = `${st.stage}|${st.crop || ''}|${(st.grow || 0) >= 1 ? 'ripe' : Math.floor((st.grow || 0) * 4)}|${st.rotten || 0}|${st.ru || 0}`;
    let v = structVis.get(st.id);
    if (v && v.key !== key) { scene.remove(v.mesh); v = null; }
    if (!v) {
      v = { mesh: structMesh(st), key };
      // A ruin (or a broken-down door) is charred and slumped until its owner rebuilds it.
      if (st.ru) v.mesh.traverse((o) => { if (o.material?.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.3); } });
      if (st.ru && !PIECES[st.type].door) { v.mesh.rotation.z = 0.25; v.mesh.position.y -= 0.3; }
      structVis.set(st.id, v);
    }
    v.data = st;
    if (v.mesh.userData.panel) v.mesh.userData.panel.visible = !st.open;
  }
  for (const [id, v] of structVis) if (!seen.has(id)) { scene.remove(v.mesh); structVis.delete(id); }
}
function syncCharges(list) {
  const seen = new Set(list.map((c) => c.id));
  for (const c of list) {
    if (chargeVis.has(c.id)) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.4), STRUCT_MATS.charge);
    m.position.set(c.x, c.y + 0.4, c.z);
    scene.add(m);
    chargeVis.set(c.id, m);
  }
  for (const [id, m] of chargeVis) if (!seen.has(id)) { scene.remove(m); chargeVis.delete(id); }
}
function stunThrowFx(m, color = 0xe8f2ff) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(m.kind === 'frag' ? 0.16 : 0.12, 10, 8), new THREE.MeshBasicMaterial({ color }));
  if (m.kind === 'frag') {   // lying where it landed, a red light blinks faster and faster until it goes off
    const blink = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    blink.position.y = 0.17; ball.add(blink);
    const tick = () => {
      if (!ball.parent) return;
      const left = (m.boomAt || 0) - Date.now();
      blink.visible = Math.floor(performance.now() / Math.max(60, Math.min(300, left / 6))) % 2 === 0;
      requestAnimationFrame(tick);
    };
    tick();
  }
  scene.add(ball);
  const [fx, fy, fz] = m.from, ty = ground(m.x, m.z) + 0.3, ms = Math.max(300, m.at - Date.now());
  const t0 = performance.now();
  const step = () => {
    const f = Math.min(1, (performance.now() - t0) / ms);
    ball.position.set(fx + (m.x - fx) * f, fy + (ty - fy) * f + Math.sin(f * Math.PI) * 4, fz + (m.z - fz) * f);
    if (f < 1) requestAnimationFrame(step); else setTimeout(() => scene.remove(ball), m.kind === 'frag' ? Math.max(50, (m.boomAt || 0) - Date.now()) : 50);   // a frag sits where it lands until it goes off
  };
  step();
}
function stunBlastFx(x, y, z) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
  ball.position.set(x, y + 0.5, z);
  scene.add(ball);
  const t0 = performance.now();
  const step = () => {
    const f = (performance.now() - t0) / 350;
    if (f >= 1) { scene.remove(ball); ball.geometry.dispose(); return; }
    ball.scale.setScalar(1 + f * 7);
    ball.material.opacity = 1 - f;
    requestAnimationFrame(step);
  };
  step();
}
// One light kept in the scene for explosions (adding and removing lights would make every material
// recompile, a stutter right when it matters).
const boomLight = new THREE.PointLight(0xffb060, 0, 60, 1.6);
scene.add(boomLight);
// Explosion sprites: Kenney's Particle Pack (CC0), white with alpha, tinted per use.
const FX_TEX = Object.fromEntries(['burst', 'fire', 'puff', 'smoke1', 'smoke2', 'smoke3', 'dirt', 'glow'].map((n) => {
  const t = new THREE.TextureLoader().load(`/textures/fx/${n}.png`); t.colorSpace = THREE.SRGBColorSpace; return [n, t];
}));
const SCORCH_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
/** An explosion that reads from across a field: a white-hot flash and starburst, a rolling fireball
 *  of flame puffs, dirt and debris thrown up and falling back, a ring of dust racing out along the
 *  ground, thick smoke that climbs and drifts and thins over several seconds, and a scorch mark left
 *  on the ground. r is the blast's danger radius (metres): grenades ~7, rockets ~5.5, mines ~4.5. */
function boomFx(x, y, z, r = 6) {
  const g0 = ground(x, z), t0 = performance.now(), parts = [];
  const sprite = (tex, color, opacity, additive = false) => {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: FX_TEX[tex], color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, rotation: Math.random() * Math.PI * 2 }));
    scene.add(m); parts.push(m); return m;
  };
  const R = (a) => (Math.random() - 0.5) * 2 * a;
  const base = Math.max(y, g0 + 0.3);
  // Flash and starburst: a blink of white-hot light.
  const flash = sprite('glow', 0xfff3c8, 1, true), burst = sprite('burst', 0xffd890, 1, true);
  flash.position.set(x, base + 0.6, z); burst.position.copy(flash.position);
  // Fireball: flame puffs that swell, roll upward and cool from yellow to deep orange to soot.
  const fire = Array.from({ length: 10 }, (_, i) => {
    const m = sprite(i % 3 ? 'puff' : 'fire', 0xffb040, 0, true);
    m.userData = { dx: R(r * 0.18), dy: Math.random() * r * 0.15, dz: R(r * 0.18), s: r * (0.35 + Math.random() * 0.3), spin: R(1.5), delay: i * 0.012 };
    return m;
  });
  // Dirt clods thrown up (sprites of chunks), falling back under gravity.
  const dirt = Array.from({ length: 12 }, () => {
    const m = sprite('dirt', 0x4a3d2c, 1);
    const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 9;
    m.userData = { vx: Math.cos(a) * sp, vy: 6 + Math.random() * 10, vz: Math.sin(a) * sp, s: 0.5 + Math.random() * 0.8 };
    m.position.set(x, base, z); m.scale.setScalar(m.userData.s);
    return m;
  });
  // Dust skirt racing out along the ground.
  const dust = Array.from({ length: 10 }, (_, i) => {
    const m = sprite(['smoke1', 'smoke2', 'smoke3'][i % 3], 0x9a8a72, 0);
    const a = (i / 10) * Math.PI * 2 + R(0.3);
    m.userData = { ax: Math.cos(a), az: Math.sin(a), s: r * (0.3 + Math.random() * 0.2) };
    return m;
  });
  // Smoke column: dark, thick, climbing and spreading, thinning out over ~7 s.
  const smoke = Array.from({ length: 14 }, (_, i) => {
    const m = sprite(['smoke1', 'smoke2', 'smoke3', 'puff'][i % 4], i % 2 ? 0x3c3a37 : 0x56524c, 0);
    m.userData = { dx: R(r * 0.3), dz: R(r * 0.3), rise: 2.5 + Math.random() * 5, s: r * (0.45 + Math.random() * 0.35), delay: 0.15 + i * 0.04, spin: R(0.3), wind: 0.3 + Math.random() * 0.5 };
    return m;
  });
  // Scorch mark left on the ground (fades after a while).
  const scorch = new THREE.Mesh(SCORCH_GEO, new THREE.MeshBasicMaterial({ map: FX_TEX.smoke2, color: 0x000000, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  scorch.position.set(x, g0 + 0.04, z); scorch.scale.setScalar(r * 0.9); scorch.rotation.y = Math.random() * 6;
  scene.add(scorch); parts.push(scorch);
  boomLight.position.set(x, base + 1.5, z);
  const hot = new THREE.Color(0xfff0a0), warm = new THREE.Color(0xff7a1a), soot = new THREE.Color(0x3a2a20);
  let last = t0;
  const step = () => {
    const now = performance.now(), t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000); last = now;
    flash.scale.setScalar(r * (1.2 + t * 6)); flash.material.opacity = Math.max(0, 1 - t / 0.18);
    burst.scale.setScalar(r * (0.8 + t * 5)); burst.material.opacity = Math.max(0, 1 - t / 0.22);
    for (const m of fire) {
      const u = m.userData, f = Math.max(0, t - u.delay), grow = Math.min(1, f / 0.25);
      m.position.set(x + u.dx * (1 + f), base + 0.4 + u.dy + f * 2.2, z + u.dz * (1 + f));
      m.scale.setScalar(u.s * (0.4 + 0.9 * Math.sqrt(grow) + f * 0.4));
      m.material.rotation += u.spin * dt;
      // White-hot, then orange, then sooty, fading out by ~0.9 s.
      const k = Math.min(1, f / 0.5);
      m.material.color.copy(hot).lerp(warm, Math.min(1, k * 1.6)).lerp(soot, Math.max(0, k * 1.5 - 0.6));
      m.material.opacity = f <= 0 ? 0 : Math.max(0, 1 - Math.max(0, f - 0.25) / 0.65);
    }
    for (const m of dirt) {
      const u = m.userData;
      u.vy -= 22 * dt;
      m.position.x += u.vx * dt; m.position.z += u.vz * dt;
      m.position.y = Math.max(g0 + 0.15, m.position.y + u.vy * dt);
      m.material.rotation += dt * 3;
      m.material.opacity = Math.max(0, 1 - Math.max(0, t - 1.3) / 0.5);
    }
    for (const m of dust) {
      const u = m.userData, f = Math.min(1, t / 0.6), d = r * (0.25 + 0.9 * Math.sqrt(f));
      m.position.set(x + u.ax * d, g0 + 0.6 + t * 0.3, z + u.az * d);
      m.scale.setScalar(u.s * (1 + t * 1.2));
      m.material.opacity = Math.min(0.75, t * 6) * Math.max(0, 1 - t / 2.5);
    }
    for (const m of smoke) {
      const u = m.userData, f = Math.max(0, t - u.delay);
      m.position.set(x + u.dx * (1 + f * 0.3) + f * u.wind, base + 0.8 + u.rise * Math.min(1, f / 2.5) + f * 0.5, z + u.dz * (1 + f * 0.3));
      m.scale.setScalar(u.s * (0.6 + Math.min(2.2, f * 0.6)));
      m.material.rotation += u.spin * dt;
      m.material.opacity = f <= 0 ? 0 : Math.min(0.85, f * 2.5) * Math.max(0, 1 - f / 7);
    }
    scorch.material.opacity = 0.75 * Math.max(0, 1 - Math.max(0, t - 20) / 10);
    boomLight.intensity = Math.max(0, 1 - t / 0.45) * 320;
    if (t < 30) requestAnimationFrame(step);
    else { boomLight.intensity = 0; for (const m of parts) { scene.remove(m); m.material.dispose(); } }
    // Once the smoke has gone, only the scorch mark is left: drop the sprites early.
    if (t > 8 && parts.length > 1) { for (const m of parts) if (m !== scorch) { scene.remove(m); m.material.dispose(); } parts.length = 0; parts.push(scorch); }
  };
  step();
  // A jolt you feel up close.
  const d = Math.hypot(x - state.x, z - state.z);
  if (d < 50) { state.recoil += 0.09 * (1 - d / 50); state.shake = Math.max(state.shake || 0, 0.6 * (1 - d / 50)); }
}

function toggleBuild() {
  build.on = !build.on;
  $('buildbar').hidden = !build.on;
  document.body.classList.toggle('building', build.on);
  if (build.on) toast(`Build mode: aim and place. Frames are cheap; upgrade them (${glyph('E')}) to make them solid.`);
  else if (build.ghost) { scene.remove(build.ghost); build.ghost = null; }
  renderBuildBar();
}
function cyclePiece(dir) {
  const keys = Object.keys(PIECES).filter((k) => !PIECES[k].auto);
  build.piece = keys[(keys.indexOf(build.piece) + dir + keys.length) % keys.length];
  renderBuildBar();
}
function renderBuildBar() {
  const me = state.me;
  if (!me) return;
  const items = Object.entries(PIECES).filter(([, p]) => !p.auto).map(([k, p], idx) => {
    const st = p.stages[0];
    let cost = p.explosive ? `${me.inv.pack.filter((i) => i.kind === 'charge').length} carried` : Object.entries(st.cost).map(([r, v]) => `${v} ${r}`).join(' ') + (p.claim ? ' + marker' : '');
    if (p.hideout) cost = (me.hideouts || []).length < (me.hideoutsAllowed || 0) ? `${cost} · ${(me.hideoutsAllowed || 0) - (me.hideouts || []).length} left` : me.hideoutNext ? `unlocks at Lv ${me.hideoutNext}` : 'all built';
    return `<div class="bpiece ${k === build.piece ? 'sel' : ''}"><kbd>${idx < 9 ? idx + 1 : '·'}</kbd>${p.name}<small>${cost}</small></div>`;
  }).join('');
  const pad = state.inputMode === 'pad';
  $('buildbar').innerHTML = `<div class="pieces">${items}</div><div class="bhint">${pad
    ? 'LB/RB piece · X rotate · RT place · A upgrade · Y dismantle · ▶ exit'
    : '1-9 or F/G piece · R / wheel rotate · Click place · E upgrade · Q dismantle · X exit'}${me.inv.pack.some((i) => i.tool === 'hammer') ? '' : ' · <b class="danger">You need a hammer</b>'}</div>`;
}
const buildWorldClient = () => ({
  terrain: state.map.terrain, towns: state.map.towns, contacts: state.map.contacts, landingZones: state.map.landingZones,
  solidsNear: (x, z, r) => {
    const out = solidsNear(x, z, r);
    for (const sv of structVis.values()) if (!structSolid(sv) && !PIECES[sv.data.type].explosive && Math.abs(sv.data.x - x) < r + 3 && Math.abs(sv.data.z - z) < r + 3) out.push(structBoxOf(sv.data));
    return out;
  },
});
function updateBuildGhost() {
  if (!build.on || !state.me || state.me.dead) { if (build.ghost) build.ghost.visible = false; return; }
  const def = PIECES[build.piece];
  const key = `${build.piece}:${build.rot}`;
  if (!build.ghost || build.ghost.userData.key !== key) {
    if (build.ghost) scene.remove(build.ghost);
    const b = pieceBox(build.piece, 0, 0, build.rot);
    build.ghost = new THREE.Mesh(new THREE.BoxGeometry(b.maxX - b.minX, b.h, b.maxZ - b.minZ), new THREE.MeshBasicMaterial({ color: 0x5fd35f, transparent: true, opacity: 0.4, depthWrite: false }));
    build.ghost.userData.key = key;
    scene.add(build.ghost);
  }
  // Aim point, pulled back to build reach and snapped to a 0.5 m grid.
  const p = aimPoint();
  let dx = p.x - state.x, dz = p.z - state.z;
  const d = Math.hypot(dx, dz), reach = def.explosive ? 1.8 : BUILD.reach - 0.5;
  if (d > reach) { dx *= reach / d; dz *= reach / d; }
  build.x = Math.round((state.x + dx) * 2) / 2;
  build.z = Math.round((state.z + dz) * 2) / 2;
  let problem;
  if (def.explosive) {
    const near = [...structVis.values()].some((sv) => { const b = structBoxOf(sv.data); return Math.hypot(Math.max(b.minX - build.x, 0, build.x - b.maxX), Math.max(b.minZ - build.z, 0, build.z - b.maxZ)) < 1.6; })
      || [...state.houseState.keys()].some((id) => { const dd = state.map.houses[id].door; return Math.hypot(Math.max(dd.minX - build.x, 0, build.x - dd.maxX), Math.max(dd.minZ - build.z, 0, build.z - dd.maxZ)) < 1.6; });
    problem = near ? null : 'Place it against a wall, gate or door';
  } else problem = placementProblem(buildWorldClient(), build.piece, build.x, build.z, build.rot, state);
  build.ok = !problem;
  build.problem = problem;
  build.ghost.visible = true;
  build.ghost.material.color.setHex(build.ok ? 0x5fd35f : 0xff4040);
  const b = pieceBox(build.piece, build.x, build.z, build.rot);
  const gy = Math.min(...[[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]].map(([a, c]) => ground(a, c)));
  build.ghost.position.set(build.x, gy + b.h / 2, build.z);
}
function placePiece() {
  if (!build.ok) { toast(build.problem || 'Can\'t build there'); return; }
  send({ t: 'build', piece: build.piece, x: build.x, z: build.z, rot: build.rot });
}
function dismantleAimed() {
  let best = null, bd = 4;
  for (const sv of structVis.values()) {
    if (!sv.data.mine) continue;
    const b = structBoxOf(sv.data);
    const d = Math.hypot(Math.max(b.minX - state.x, 0, state.x - b.maxX), Math.max(b.minZ - state.z, 0, state.z - b.maxZ));
    if (d < bd) { bd = d; best = sv.data; }
  }
  if (best) send({ t: 'dismantle', id: best.id }); else toast('Stand next to one of your structures to dismantle it');
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  pollPad(dt, now);   // also drives the login and death screens
  if (!state.map) { renderWorld(); return; }
  const me = state.me;
  const alive = me && !me.dead;

  // In a boat: the driver steers it (predicted here, checked by the server); passengers ride along.
  const inBoat = alive && me.boat;
  if (inBoat) {
    const k = state.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const free = !state.invOpen && !state.contactOpen && !state.mapOpen && !state.panelOpen;
    if (me.boat.seat === 0) {
      const v = boatVis.get(me.boat.id);
      if (!state.boat && v) state.boat = { id: me.boat.id, type: v.data.type, x: v.data.x, z: v.data.z, y: v.data.y, yaw: v.data.yaw, speed: 0 };
      // Driving and not looking about: the camera swings round behind the vehicle (land rides).
      if (state.boat && BOATS[state.boat.type].land && Math.abs(state.boat.speed || 0) > 2 && now - (state.lookAt || 0) > 1200 && !state.aiming) {
        const back = state.boat.speed < 0 ? Math.PI : 0, d = Math.atan2(Math.sin(state.boat.yaw + back - state.yaw), Math.cos(state.boat.yaw + back - state.yaw));
        state.yaw += d * Math.min(1, dt * 2.5);
      }
      if (state.boat) {
        const n = stepBoat(state.map.terrain, state.boat, free ? { throttle: f + pad.moveY + touch.moveY, steer: r + pad.moveX + touch.moveX } : {}, dt, rideEnv());
        if (n.hit) { state.boat.crash = Math.max(state.boat.crash || 0, n.hit); sfx.hurt?.(); }
        Object.assign(state.boat, n);
      }
    }
    const seat = boatSeat(me);
    if (seat) { state.x = seat.x; state.z = seat.z; }
    state.sprint = false; state.crouch = false; state.prone = false;
    if (state.mouseDown && free && !build.on) tryFire(now); else if (!state.mouseDown) state.firedThisPress = false;
  }
  if (!alive) state.air = null;
  if (state.hop?.ladder) {
    // On a ladder: up at a steady pace; at the top, a little hop and a step onto the roof or platform.
    state.hop.alt = Math.min(state.hop.ladder, state.hop.alt + LADDER.speed * dt);
    // At the top you hang on while you step off (however slow the frames), then let go.
    if (state.hop.alt >= state.hop.ladder) { state.climbPush = { until: now + 1500, dir: state.hop.dir, frames: 0, x0: state.x, z0: state.z }; state.hop.ladder = 0; state.hop.vy = 0; state.hop.hold = true; }
    if (!alive) state.hop = null;
  } else if (state.hop) {
    if (!(state.hop.hold && state.climbPush)) { state.hop.vy -= JUMP_G * dt; state.hop.alt += state.hop.vy * dt; }
    if (state.hop.alt <= 0 || !alive) state.hop = null;
  }
  if (alive && state.air && !inBoat) {
    // On a jump: Sprint (held) flies the squirrel suit, the stick steers, Use pulls the chute.
    const k = state.keys;
    const pf = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + pad.moveY + touch.moveY;
    const pr = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + pad.moveX + touch.moveX;
    const glide = !me.downed && !!(k.has('ShiftLeft') || pad.sprint || touch.sprint || touch.sprintOn);
    state.air.mode = nextMode(state.air.mode, glide);
    stepAir(state.air, dt);
    const speed = airRates(state.air.mode).speed;
    const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw), rx = -Math.cos(state.yaw), rz = Math.sin(state.yaw);
    let mx, mz;
    if (state.air.mode === 'suit') {
      // The suit always flies forward; push on to go faster, turn by looking.
      const fwd = 0.7 + 0.3 * Math.max(0, Math.min(1, pf));
      mx = fx * fwd + rx * pr * 0.35; mz = fz * fwd + rz * pr * 0.35;
    } else {
      mx = fx * pf + rx * pr; mz = fz * pf + rz * pr;
      const l = Math.hypot(mx, mz);
      if (l > 1) { mx /= l; mz /= l; }
    }
    const lim = state.map.half - 30;
    state.x = Math.max(-lim, Math.min(lim, state.x + mx * speed * dt));
    state.z = Math.max(-lim, Math.min(lim, state.z + mz * speed * dt));
    state.sprint = glide; state.crouch = false; state.prone = false;
  } else if (alive && !state.invOpen && !inBoat) {
  // Local movement (client-side prediction; server re-validates every step).
    const k = state.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const pf = f + pad.moveY + touch.moveY, pr = r + pad.moveX + touch.moveX;
    const autoSprint = pad.settings.autoSprint && pad.moveY > 0.92;   // controller setting: stick all the way forward
    const wasSprint = state.sprint;
    // Pulling the trigger or aiming while you sprint stops the sprint and brings the gun up (PUBG-style).
    const trigger = (state.mouseDown || autoFireNow(me)) && !build.on && !state.nadeAim;   // (phones: auto-fire on a foe counts)
    state.sprint = (k.has('ShiftLeft') || pad.sprint || autoSprint || touch.sprint || touch.sprintOn) && pf > 0.3 && !state.aiming && !trigger;
    if (trigger && (pad.sprint || touch.sprintOn)) { pad.sprint = false; touch.sprintOn = false; }
    if (state.sprint) { state.crouch = false; state.prone = false; }
    // Mobility comes from the active weapon build and the armor you wear.
    const ws = weaponStats(me.inv[me.active]);
    const mobility = (ws ? ws.mobility : 1.05) + armorStats(me.inv.armor).mobility;
    if (me.downed || (me.food ?? 100) < HOMESTEAD.hunger.noSprintBelow) state.sprint = false;
    if (wasSprint && !state.sprint) state.drawUntil = now + drawMs(me.inv[me.active]?.archetype);
    const stunnedNow = performance.now() < (state.stunnedUntil || 0);
    const speed = me.downed ? COMBAT_RULES.downed.crawlSpeed : state.prone ? PRONE_SPEED : (state.sprint ? SPRINT_SPEED : state.crouch ? CROUCH_SPEED : state.aiming ? ADS_SPEED : WALK_SPEED) * mobility;
    // Sliding: carried along the way you were sprinting, fast at first and slowing to a crouch; the
    // stick steers it a little. Standing up (sprint or jump) or hitting something ends it.
    const sl = state.slide && now < state.slide.until && !me.downed && !stunnedNow ? state.slide : null;
    if (state.slide && !sl) state.slide = null;
    const mYaw = touch.freeLook ? touch.freeLook.yaw : state.yaw;   // free look: you keep going the way you faced
    const fx = Math.sin(mYaw), fz = Math.cos(mYaw);
    const rx = -Math.cos(mYaw), rz = Math.sin(mYaw);
    let mx = fx * pf + rx * pr, mz = fz * pf + rz * pr;
    const len = Math.hypot(mx, mz);
    if (len > 0.05 && !stunnedNow && !state.prone && !me.downed) {
      // Footsteps: one every stride, quieter crouched, splashing in water, sharper on a road.
      state.stepAcc = (state.stepAcc || 0) + Math.min(len, 1) * speed * dt;
      const stride = state.sprint ? 2.3 : state.crouch ? 1.2 : 1.7;
      if (state.stepAcc > stride) {
        state.stepAcc = 0;
        const gh = ground(state.x, state.z);
        const onRoad = state.map.roadsNear(state.x, state.z, 8).some((r) => !r.dirt && distToSeg(state.x, state.z, r) < (r.width || 12) / 2);
        sfx.step(gh < 0.2 ? 'water' : onRoad ? 'road' : 'grass', state.crouch);
      }
    }
    // Momentum: you reach full speed in well under a tenth of a second and stop almost as fast:
    // quick to start and stop, without dead stops.
    if (len > 1) { mx /= len; mz /= len; }   // analog sticks below full tilt walk slower
    updateStance(dt, now);
    let want = len > 0.05 && !stunnedNow && now >= (state.stanceBusyUntil || 0) ? [mx * speed, mz * speed] : [0, 0];
    if (state.hop?.ladder) want = [0, 0];   // on a ladder: up, not about
    // Climbing: carried on forward, onto the top or over to the other side.
    // (a few frames at least, however slow they come, and no further than the step off a ladder needs)
    const cp0 = state.climbPush;
    if (cp0 && state.hop && (now < cp0.until || cp0.frames < 24) && Math.hypot(state.x - (cp0.x0 ?? state.x), state.z - (cp0.z0 ?? state.z)) < 2.2) { cp0.frames = (cp0.frames || 0) + 1; want = [cp0.dir[0] * Math.max(3.2, speed * 0.6), cp0.dir[1] * Math.max(3.2, speed * 0.6)]; }
    else { state.climbPush = null; if (state.hop) state.hop.hold = false; }
    if (sl) {
      const t = (now - sl.start) / SLIDE.ms, s = SLIDE.speed * (1 - 0.7 * t * t);
      if (len > 0.05) { const k = Math.min(1, dt * 2.5); sl.dir[0] += (mx - sl.dir[0]) * k; sl.dir[1] += (mz - sl.dir[1]) * k; const l = Math.hypot(sl.dir[0], sl.dir[1]) || 1; sl.dir[0] /= l; sl.dir[1] /= l; }
      want = [sl.dir[0] * s, sl.dir[1] * s];
      state.sprint = false; state.crouch = true;
    }
    const v = state.vel || (state.vel = [0, 0]), rate = Math.min(1, dt * (sl ? 30 : len > 0.05 ? 16 : 14));
    v[0] += (want[0] - v[0]) * rate; v[1] += (want[1] - v[1]) * rate;
    if (Math.hypot(v[0], v[1]) > 0.05) {
      const y0 = myY();
      const rides = rideSolids([...boatVis.values()].map((bv) => bv.data), state.x, state.z, 3, (b) => b.y ?? state.map.terrain.height(b.x, b.z), PLAYER_RADIUS);
      const p = moveWithCollision(state.x, state.z, v[0] * dt, v[1] * dt, PLAYER_RADIUS, solidsNear(state.x, state.z, 3).concat(rides), state.map.terrain, y0, state.hop ? state.hop.alt : 0);
      if (dt > 0 && Math.hypot(p.x - state.x - v[0] * dt, p.z - state.z - v[1] * dt) > 0.01 && !state.climbPush) { v[0] = (p.x - state.x) / dt; v[1] = (p.z - state.z) / dt; }   // walked into something: keep only the slide along it
      state.x = p.x; state.z = p.z; state.y = p.y; state.yx = p.x; state.yz = p.z;
      // Up onto a top in mid-jump: what's left of the jump is measured from there (you land on it).
      // Off the edge of one: you drop, rather than snapping to the ground.
      if (state.hop && p.y !== y0) { state.hop.alt -= p.y - y0; if (state.hop.alt <= 0) { state.hop = null; state.climbPush = null; } }
      else if (!state.hop && y0 - p.y > 0.6) state.hop = { alt: y0 - p.y, vy: 0 };
    } else { v[0] = 0; v[1] = 0; }
    if (build.on) { if (state.mouseDown && !state.firedThisPress) { placePiece(); state.firedThisPress = true; } if (!state.mouseDown) state.firedThisPress = false; }
    else if (state.nadeAim) updateNadeAim(now);
    else if ((state.mouseDown || autoFireNow(me)) && !me.downed && !stunnedNow) tryFire(now); else state.firedThisPress = false;
  }
  if (now - state.lastSend > 50 && alive) {
    state.lastSend = now;
    send({ t: 'state', tp: state.tp || 0, ...(state.slide ? { slide: 1 } : {}), x: state.x, z: state.z, yaw: touch.freeLook ? touch.freeLook.yaw : state.yaw, pitch: touch.freeLook ? touch.freeLook.pitch : state.pitch, crouch: state.crouch || (state.prone && !proneSettled()), prone: proneSettled(), aim: state.aiming, sprint: state.sprint, boat: state.boat && me.boat?.seat === 0 ? { x: +state.boat.x.toFixed(3), z: +state.boat.z.toFixed(3), yaw: +state.boat.yaw.toFixed(4) } : undefined, crash: state.boat?.crash ? +state.boat.crash.toFixed(1) : undefined });
    if (state.boat) state.boat.crash = 0;
  }

  // Recoil recovers smoothly.
  if (state.recoil > 0) {
    const kick = Math.min(state.recoil, dt * 0.6);
    const before = state.pitch;
    state.pitch = Math.min(1.2, state.pitch + kick * 0.9);
    state.recoilBank = (state.recoilBank || 0) + (state.pitch - before);
    state.recoil -= kick;
  } else if (state.recoilBank > 0 && performance.now() - state.lastShot > 120) {
    // A moment after the last shot the gun comes back down onto your target.
    const back = Math.min(state.recoilBank, dt * Math.max(0.35, state.recoilBank * 6));
    state.pitch -= back; state.recoilBank -= back;
  }

  // Self mesh.
  if (state.reloadAt && (performance.now() - state.reloadAt > 6000 || !state.me || state.me.dead)) state.reloadAt = 0;
  const myRl = state.reloadAt ? Math.max(0, (weaponStats(state.me.inv[state.me.active])?.reloadMs || 2000) - (performance.now() - state.reloadAt)) : 0;
  const nowP = performance.now();
  const myAct = state.hack ? { act: state.hack.kind, ap: Math.min(1, (nowP - state.hack.start) / state.hack.total) }
    : state.gesture && nowP < state.gesture.until ? { act: state.gesture.kind, ap: (nowP - state.gesture.start) / (state.gesture.until - state.gesture.start) } : {};
  setHolstered(selfMesh, !!state.me && !state.me.boat && (state.sprint || now < (state.drawUntil || 0) - 150));   // gun on your back at a sprint
  updateCharacterMesh(selfMesh, { ...myAct, slide: !!state.slide, rl: myRl, tiltK: state.air ? 1 : Math.min(1, dt * 4.5), x: state.x, z: state.z, yaw: touch.freeLook ? touch.freeLook.yaw : state.yaw, crouch: state.crouch || (state.prone && !proneSettled()), prone: state.prone, dead: !alive, downed: !!state.me?.downed, boat: state.me?.boat?.id || null, seat: state.me?.boat?.seat, aim: state.aiming, pitch: touch.freeLook ? touch.freeLook.pitch : state.pitch, air: state.air?.mode, alt: state.air?.alt ?? state.hop?.alt, y: myY() }, 1);
  animateFlyBys(dt);
  animateBoats(dt, now);
  for (const [, r] of state.players) updateCharacterMesh(r.mesh, smoothed(r), dt);
  updateGunFx(dt);
  for (const [, r] of state.bots) {
    if (!r.animal) { updateCharacterMesh(r.mesh, r.data, dt); continue; }
    // Wildlife: glide toward the latest position and face where it's going.
    const g = r.mesh, c = r.data, k = Math.min(1, dt * 10);
    g.position.x += (c.x - g.position.x) * k; g.position.z += (c.z - g.position.z) * k;
    g.position.y = ground(g.position.x, g.position.z);
    let dy = c.yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); g.rotation.y += dy * k;
    animateAnimal(g, dt);
  }
  for (const [, l] of state.loot) l.mesh.rotation.y += dt;
  for (const [, b] of state.bags) b.mesh.rotation.y += dt * 0.5;

  updateAimAssist(dt);
  // Over-the-shoulder camera with wall collision.
  const d = lookDir();
  const right = new THREE.Vector3(-Math.cos(state.yaw), 0, Math.sin(state.yaw));
  const aim = state.aiming && alive;
  const afloat = !!me?.boat;
  const ride = afloat && myRide(), rideCam = ride?.land ? Math.max(3.6, Math.min(7.5, ride.len * 1.2 + 1.8)) : 6.5;
  const dist = aim ? 0.05 : afloat ? rideCam : state.air ? 7.5 : 4.2, shoulder = aim ? 0 : afloat ? 0.3 : 0.85;
  const pivot = new THREE.Vector3(state.x, eyeHeight() + (aim ? 0.02 : afloat ? 0.9 : 0.45), state.z).addScaledVector(right, shoulder);
  selfMesh.visible = alive && !aim;   // looking down the sights: your own back isn't in the way
  const want = pivot.clone().addScaledVector(d, -dist);
  const toCam = want.clone().sub(pivot);
  const tl = toCam.length();
  toCam.normalize();
  const hit = rayAgainstBoxes(pivot.x, pivot.y, pivot.z, toCam.x, toCam.y, toCam.z, solidsNear(pivot.x, pivot.z, tl + 1), tl);
  const camDist = Math.max(0.3, Math.min(tl, hit.t - 0.25));
  // Ease the camera out to its distance (walls still pull it in at once, so it never clips through).
  state.camDist = aim ? camDist : Math.min(camDist, (state.camDist ?? camDist) + (camDist - (state.camDist ?? camDist)) * Math.min(1, dt * 8));
  camera.position.copy(pivot).addScaledVector(toCam, state.camDist);
  // A soft lag on the pivot itself, so the view glides behind you instead of being bolted on.
  if (!aim && !afloat && state.camLag && camera.position.distanceTo(state.camLag) < 3) camera.position.lerp(state.camLag, Math.max(0, 1 - dt * 22));   // (not in a ride: at speed the lag reads as judder)
  state.camLag = camera.position.clone();
  const camGround = Math.max(ground(camera.position.x, camera.position.z), 0);
  if (camera.position.y < camGround + 0.4) camera.position.y = camGround + 0.4;
  camera.lookAt(camera.position.clone().add(d));
  if (state.shake > 0.002) {   // a blast nearby rattles the view, settling over half a second
    const k2 = state.shake;
    camera.rotation.x += (Math.random() - 0.5) * 0.05 * k2; camera.rotation.y += (Math.random() - 0.5) * 0.05 * k2;
    camera.position.y += (Math.random() - 0.5) * 0.25 * k2;
    state.shake *= Math.max(0, 1 - dt * 5);
  }
  sfx.setListener(camera.position.x, camera.position.y, camera.position.z, state.yaw);
  // Optic zoom sets ADS field of view; handling sets how fast you get there.
  const ws = me && weaponStats(me.inv[me.active]);
  const fov = aim && ws ? 70 / Math.max(1.4, ws.zoom + (state.zoomAlt ? ws.zoomAlt : 0)) : state.slide ? 80 : state.sprint ? 77 : 70;   // wider at a sprint, wider still on a slide
  updateSight(aim ? ws : null, now);
  const adsRate = ws ? 4 + ws.handling / 6 : 12;
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * adsRate); camera.updateProjectionMatrix(); }
  $('crosshair').classList.toggle('aim', aim);
  // The grenade's arc and cook timer only show while the throw is really being lined up this frame.
  if (now - (state.nadeSeen || 0) > 150 && (!$('nadecook').hidden || nadeFx.ring.visible)) { $('nadecook').hidden = true; for (const o of Object.values(nadeFx)) if (o?.isObject3D) o.visible = false; }
  // Steady: a single-shot gun, aimed, standing still, a breath since the last shot: the next round goes
  // exactly where the crosshair is, and the crosshair closes up to say so.
  const moved = Math.hypot(state.vel?.[0] || 0, state.vel?.[1] || 0) > 0.5;
  $('crosshair').classList.toggle('steady', !!(aim && ws?.semi && (ws.pellets || 1) === 1 && !moved && now - (state.lastShot || 0) >= Math.max(350, 60000 / ws.rpm * 1.4)));
  // The crosshair opens up to show how far shots can stray (hip fire, moving, crouched, prone).
  if (ws) {
    const moving = Math.hypot(pad.moveX, pad.moveY) > 0.2 || Math.hypot(touch.moveX, touch.moveY) > 0.2 || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => state.keys.has(k));
    // Same rules as the server: single-shot guns group tighter, and a steady aimed shot is dead-on.
    const single = ws.semi && (ws.pellets || 1) === 1, steady = $('crosshair').classList.contains('steady');
    const spread = steady ? 0 : (aim ? ws.adsSpread : ws.hipSpread) * (single ? (aim ? 0.35 : 0.6) : 1) * (moving ? (ws.semi ? 1.3 : 1.6) : 1) * (state.prone ? 0.6 : state.crouch ? 0.8 * ws.crouchSpread : 1);
    const gap = Math.max(steady ? 1 : 2, Math.min(80, Math.tan(spread) / Math.tan(camera.fov * Math.PI / 360) * innerHeight / 2));
    $('crosshair').style.setProperty('--gap', `${gap.toFixed(1)}px`);
  }

  // Hide stash labels you're standing right under.
  for (const [id, v] of houseVis) { const h = state.map.houses[id]; v.label.visible = Math.hypot(h.x - state.x, h.z - state.z) > 9; }
  state.view.update(state.x, state.z, state.boat ? Math.abs(state.boat.speed || 0) : state.me?.boat ? 12 : 0);
  state.towns?.update(state.x, state.z);
  for (const g of state.contactMeshes) {
    g.visible = Math.abs(g.position.x - state.x) < 300 && Math.abs(g.position.z - state.z) < 300;
    // Name tags float at a fixed size: up close they'd fill the screen, so they hide within 7 m.
    if (g.visible && g.userData.label) g.userData.label.visible = camera.position.distanceTo(g.position) > 7;
    // Standing about, unarmed (breathing, shifting their weight).
    const u = g.userData;
    if (g.visible && u.rig) {
      const now = performance.now(), dt = Math.min(0.1, (now - (u.lastT || now)) / 1000) || 0.016, cd = camera.position.distanceTo(g.position);
      u.lastT = now;
      animatePerson(g, u.rig, { speed: 0, fwd: 0, side: 0, crouch: false, seated: false, armed: false, pitch: 0, detail: cd < 60 ? 1 : cd < 130 ? 0.3 : 0.1 }, dt);
    }
  }
  for (const g of dropVis.values()) {
    // Falling crate until it lands.
    const left = g.userData.drop.landsAt - Date.now();
    g.userData.crate.position.y = left > 0 ? 0.5 + Math.min(60, left / 1000) : 0.5;
  }
  animateExtracts();
  for (const g of lzVis) g.visible = Math.abs(g.position.x - state.x) < 300 && Math.abs(g.position.z - state.z) < 300;
  const gy0 = ground(state.x, state.z);
  // Day and night, and the weather: the sun or moon, the sky, fog, rain and lightning (client/daynight.js).
  if (state.env) {
    state.env.update(new THREE.Vector3(state.x, gy0, state.z), dt);
    updateLanterns(now);
    if (now - (state.clockShown || 0) > 1000) { state.clockShown = now; $('whereClock').textContent = clockLabel(state.env.state.clock); }
  }
  else { sun.position.set(state.x + 62, gy0 + 46, state.z + 38); sun.target.position.set(state.x, gy0, state.z); }

  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.grow) t.obj.scale.multiplyScalar(1 + t.grow * dt * 3);
    if (t.life <= 0) { scene.remove(t.obj); if (!t.shared) t.obj.geometry.dispose(); tracers.splice(i, 1); }
  }

  const prompt = alive && !state.invOpen && !state.air && !state.me?.downed ? nearestInteractable() : null;   // (down: the DOWN panel says what you can do)
  state.promptText = prompt;
  // On a phone the prompt names the button to tap (the same word and hand as the USE button, lit up).
  const pkey = state.touchUI && state.inputMode !== 'pad' ? `<kbd class="tk">${ticon('use')}${useVerb(prompt)}</kbd>` : `<kbd>${glyph('E')}</kbd>`;
  $('prompt').innerHTML = state.air && alive ? airHud() : prompt && !(alive && myRide()?.land) ? `${pkey}${prompt}` : boatHud(pkey);
  drawMinimap();
  updateWhere(now);
  if (now - (state.lootUiAt || 0) > 150) { state.lootUiAt = now; updateTouchLoot(); }
  updateScopeView(aimNow());
  renderWorld();
  drawGunsmith(dt);
  drawMarkers();
  updateBuildGhost();
  for (const v of chargeVis.values()) v.visible = Math.floor(now / 300) % 2 === 0;
  for (const [, v] of structVis) if (v.mesh?.userData?.mine && !v.data?.mine) v.mesh.visible = Math.hypot(v.mesh.position.x - state.x, v.mesh.position.z - state.z) < MINE_SEE || state.defMarks.some((d) => d.until > now && Math.abs(d.x - v.mesh.position.x) < 0.5 && Math.abs(d.z - v.mesh.position.z) < 0.5);
}
requestAnimationFrame(frame);

// Debug/test hook (used by the automated smoke test).
window.__dz = { nadeFx, nadeArc, openGunsmith, state, send, boatVis, structVis, houseVis };

// ------------------------------------------------------------------ touch controls
// Phones without a controller: a thumbstick on the left (push to the edge to sprint), drag anywhere
// on the right to look, and buttons for everything else. Hidden while a controller is in use.
const touch = { moveX: 0, moveY: 0, sprint: false, stick: null, look: null, autoRun: false };
// Phone settings (this device): button layout, size and see-through, the left fire button, gyro aim.
const tset = { pos: {}, scale: 1, alpha: 1, leftFire: false, gyro: 'off', aimMode: 'mixed', autoFire: 'always', adsSens: 1, aimAssist: 'strong', autoPick: { ammo: true, heals: true, supplies: true, gear: false } };
try { Object.assign(tset, JSON.parse(localStorage.getItem('dz_touch') || '{}')); } catch { /* keep the defaults */ }
tset.autoPick = { ammo: true, heals: true, supplies: true, gear: false, ...(tset.autoPick || {}) };
if (!tset.lf2) { tset.leftFire = false; tset.lf2 = 1; try { localStorage.setItem('dz_touch', JSON.stringify(tset)); } catch { /* private mode */ } }   // the left FIRE button starts off once (turn it on in Settings)
// Auto-fire starts on (once) for phones: aiming and holding FIRE with one thumb is the hard part on a
// phone, so like the big phone shooters' simple mode the gun fires itself when the crosshair is on someone.
// The buttons were laid out again (v3: the middle right kept clear for turning); positions moved by
// hand on the old layout would land in the wrong places, so they start from the new one (once).
if (!tset.lay3) { tset.pos = {}; tset.lay3 = 1; try { localStorage.setItem('dz_touch', JSON.stringify(tset)); } catch { /* private mode */ } }
if (!tset.af2) { if (!tset.autoFire || tset.autoFire === 'off') tset.autoFire = 'always'; tset.af2 = 1; try { localStorage.setItem('dz_touch', JSON.stringify(tset)); } catch { /* private mode */ } }
const saveTset = () => { try { localStorage.setItem('dz_touch', JSON.stringify(tset)); } catch { /* private mode */ } markAutoFire(); };
/** The FIRE buttons wear an AUTO badge while auto-fire is on. */
function markAutoFire() { for (const b of document.querySelectorAll('#touch .tbtn.fire')) b.classList.toggle('auto', !!tset.autoFire && tset.autoFire !== 'off'); }
// Line icons for the phone buttons (24-unit grid, drawn in the button's text colour).
const TICON = {
  fire: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  aim: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  use: '<path d="M8 13V6a1.8 1.8 0 0 1 3.6 0v5M11.6 10V4.6a1.8 1.8 0 0 1 3.6 0V11M15.2 9.5a1.8 1.8 0 0 1 3.6 0v4.5a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5.4-2.9L4 15.4a1.7 1.7 0 0 1 2.7-2L8 15"/>',
  reload: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6"/><path d="M4 3.5v5.1h5.1"/>',
  crouch: '<path d="M6 7l6 6 6-6"/><path d="M5 19h14"/>',
  prone: '<circle cx="6" cy="11" r="2.2"/><path d="M9.5 12.5H21M3 17h18"/>',
  nade: '<circle cx="12" cy="14.5" r="6"/><path d="M10 8.5V5.5h4v3M14 5.5l3.5-2.5"/>',
  jump: '<path d="M6 13l6-6 6 6"/><path d="M6 19l6-6 6 6"/>',
  tag: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
  heal: '<path d="M12 5v14M5 12h14"/>',
  look: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M10.5 8v5M8 10.5h5"/>',
};
const ticon = (k) => TICON[k] ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TICON[k]}</svg>` : '';
const TOUCH_BTNS = [
  // [label, action, class, key]   Both FIRE buttons are held, and dragging on one aims while you shoot.
  // AIM toggles the sights; CROUCH and PRONE toggle. Push the stick to its edge to sprint, or on up
  // into the lock to keep running. Guns switch by tapping them at the bottom.
  ['FIRE', 'fire', 'big fire', 'fire'], ['FIRE', 'fire', 'mid fire lfire', 'lfire'], ['AIM', 'aim', 'mid aim', 'aim'], ['USE', 'interact', 'mid use', 'use'],
  ['RELOAD', 'reload', 'sm r1', 'reload'], ['CROUCH', 'crouch', 'sm r2', 'crouch'],   // tap: crouch · hold: prone (one button for both)
  ['NADE', 'sensor', 'sm r4', 'nade'],
  ['JUMP', 'jump', 'mid jump', 'jump'], ['TAG', 'tag', 'sm r5', 'tag'], ['HEAL', 'heal', 'sm r6', 'heal'],
  // Hold the eye and drag to look around without turning (you keep running the way you were going).
  ['LOOK', 'look', 'sm look', 'look'],
  // Only while looking through a sight with two zoom levels: flip between them.
  ['ZOOM', 'zoom', 'sm zoom', 'zoom'],
];
const TICON_OF = { fire: 'fire', lfire: 'fire', aim: 'aim', use: 'use', reload: 'reload', crouch: 'crouch', prone: 'prone', nade: 'nade', jump: 'jump', tag: 'tag', heal: 'heal', look: 'look', zoom: 'zoom' };
// Top left: the bag, and ⋯ for the rest (the map: tap the minimap).
const TOUCH_TOP = [['BAG', 'inventory'], ['⋯', 'touchMore']];   // the map: tap the minimap
const TOUCH_MORE = [['CREW', 'squadPanel'], ['CAMO', 'camo'], ['PING', 'ping'], ['⇄ GRENADE', 'switchGrenade'], ['BUILD', 'build'], ['🚗 TEST RIDE', 'testRide']];
function buildTouchUI() {
  const ui = $('touch');
  ui.innerHTML = '<div id="tstick"><div id="tknob"></div></div><div id="tlock">🔒 RUN</div>' +
    TOUCH_BTNS.map(([l, a, c, k]) => `<button class="tbtn ${c}" data-act="${a}" data-key="${k}" aria-label="${l}">${ticon(TICON_OF[k])}<span class="tl">${l}</span></button>`).join('') +
    '<div id="tpick" hidden></div><div id="tloot" hidden></div>' +
    '<div id="tedit" hidden><b>Drag any button to move it</b><span><button class="tbtn tiny" data-ed="small">Smaller</button><button class="tbtn tiny" data-ed="big">Bigger</button><button class="tbtn tiny" data-ed="faint">More see-through</button><button class="tbtn tiny" data-ed="solid">Less</button><button class="tbtn tiny" data-ed="reset">Reset</button><button class="tbtn tiny" data-ed="done">Done</button></span></div>' +
    `<div class="ttop">${TOUCH_TOP.map(([l, a]) => `<button class="tbtn tiny" data-act="${a}">${l}</button>`).join('')}</div>` +
    `<div class="tmore" hidden>${TOUCH_MORE.map(([l, a]) => `<button class="tbtn tiny" data-act="${a}">${l}</button>`).join('')}</div>`;
  markAutoFire();
  for (const b of ui.querySelectorAll('#tedit [data-ed]')) b.addEventListener('click', (e) => { e.stopPropagation(); editTouch(b.dataset.ed); });
  for (const b of ui.querySelectorAll('.tbtn[data-act]')) {
    // Layout editor: drag the button to where you want it.
    b.addEventListener('pointermove', (e) => {
      if (b.drag?.id === e.pointerId) {
        const x = Math.max(0, Math.min(innerWidth, e.clientX - b.drag.dx)), y = Math.max(0, Math.min(innerHeight, e.clientY - b.drag.dy));
        tset.pos[b.dataset.key] = [+(x / innerWidth).toFixed(4), +(y / innerHeight).toFixed(4)];
        applyTouchLayout();
      } else if (b.aimPress?.id === e.pointerId) {
        // Slide up on AIM to zoom in, down to zoom out (sights with two zoom levels).
        const dy = e.clientY - b.aimPress.y;
        if (!b.aimPress.flipped && Math.abs(dy) > 34 && state.aiming && weaponStats(state.me?.inv[state.me.active])?.zoomAlt) {
          state.zoomAlt = dy < 0; b.aimPress.flipped = true;
        }
        if (Math.abs(dy) > 34 || Math.abs(e.clientX - b.aimPress.x) > 34) b.aimPress.moved = true;
      } else if (touch.freeLook?.id === e.pointerId) {
        lookBy(e.clientX - touch.freeLook.x, e.clientY - touch.freeLook.y);
        touch.freeLook.x = e.clientX; touch.freeLook.y = e.clientY;
      } else if (b.look?.id === e.pointerId) {
        // Thumb on FIRE: slide it to aim while you shoot.
        lookBy(e.clientX - b.look.x, e.clientY - b.look.y);
        b.look.x = e.clientX; b.look.y = e.clientY;
      }
    });
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (touch.editing) {
        if (!b.closest('.ttop') && !b.closest('.tmore')) {
          const r = b.getBoundingClientRect();
          b.drag = { id: e.pointerId, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
          b.setPointerCapture(e.pointerId);
        }
        return;
      }
      const a = b.dataset.act;
      if (a === 'fire') {
        state.mouseDown = true; state.firedThisPress = false; b.classList.add('on'); b.setPointerCapture(e.pointerId);
        b.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
        // A quick tap can end before the next frame looks at the trigger, so fire right away.
        if (state.me && !state.me.dead && !state.me.downed && !build.on && !state.invOpen) tryFire(performance.now());
        return;
      }
      if (a === 'aim') {
        // Tap: toggle. Hold: aim while held. Tap or hold (the default): either, by how long you press.
        const mode = tset.aimMode || 'mixed';
        b.setPointerCapture(e.pointerId);
        b.aimPress = { id: e.pointerId, t: performance.now(), was: state.aiming, y: e.clientY, x: e.clientX, flipped: false };
        state.aiming = mode === 'tap' ? !state.aiming : true;
        b.classList.toggle('on', state.aiming);
        return;
      }
      if (a === 'look') {   // free look: the camera turns, you don't
        b.setPointerCapture(e.pointerId);
        touch.freeLook = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch };
        b.classList.add('on');
        return;
      }
      if (a === 'zoom') { state.zoomAlt = !state.zoomAlt; return; }
      if (a === 'heal' || a === 'sensor') {   // tap: use the best one; hold: choose which
        b.setPointerCapture(e.pointerId);
        b.holdTimer = setTimeout(() => { b.holdTimer = null; openTouchPicker(a, b); }, 380);
        return;
      }
      if (a === 'touchMore') { const m = ui.querySelector('.tmore'); m.hidden = !m.hidden; b.classList.toggle('on', !m.hidden); return; }
      if (b.closest('.tmore')) { ui.querySelector('.tmore').hidden = true; ui.querySelector('[data-act=touchMore]').classList.remove('on'); }
      if (a === 'crouch') {   // tap: crouch / stand; hold: prone
        b.setPointerCapture(e.pointerId);
        b.holdTimer = setTimeout(() => { b.holdTimer = null; doAction('prone'); }, 450);
        return;
      }
      doAction(a);
    });
    if (b.dataset.act === 'crouch') for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { if (b.holdTimer) { clearTimeout(b.holdTimer); b.holdTimer = null; doAction('crouch'); } });
    if (b.dataset.act === 'heal' || b.dataset.act === 'sensor') for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { if (b.holdTimer) { clearTimeout(b.holdTimer); b.holdTimer = null; doAction(b.dataset.act); } });
    if (b.dataset.act === 'aim') for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => {
      const ap = b.aimPress;
      if (!ap) return;
      b.aimPress = null;
      const mode = tset.aimMode || 'mixed', held = performance.now() - ap.t > 260 || ap.moved;
      if (mode === 'hold' || (mode === 'mixed' && held)) state.aiming = false;      // let go: back to the hip
      else if (mode === 'mixed') state.aiming = !ap.was;                            // a tap toggles
      b.classList.toggle('on', state.aiming);
    });
    if (b.dataset.act === 'look') for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => {
      if (!touch.freeLook) return;
      state.yaw = touch.freeLook.yaw; state.pitch = touch.freeLook.pitch;   // the view swings back
      touch.freeLook = null; b.classList.remove('on');
    });
    if (b.dataset.act === 'fire') for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { if (touch.editing) return; b.look = null; if (![...ui.querySelectorAll('.tbtn.fire')].some((o) => o !== b && o.look)) state.mouseDown = false; b.classList.remove('on'); });
    for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { if (b.drag) { b.drag = null; saveTset(); } });
  }
  const knob = $('tknob'), base = $('tstick');
  const lock = $('tlock');
  ui.addEventListener('pointerdown', (e) => {
    const pick = e.target.closest('#tpick button, #tloot button');
    if (pick) { e.preventDefault(); e.stopPropagation(); pick.onpick?.(); return; }
    if (!$('tpick').hidden) $('tpick').hidden = true;
    if (e.target.closest('.tbtn') || touch.editing) return;
    // A tap on the minimap opens the big map.
    { const r = $('minimap').getBoundingClientRect();
      if (Math.hypot(e.clientX - (r.left + r.right) / 2, e.clientY - (r.top + r.bottom) / 2) < r.width / 2 + 6) { e.preventDefault(); doAction('map'); return; } }
    // A tap on a gun in the weapon strip (drawn under this layer) takes that gun in hand.
    for (const chip of $('wslots').children) {
      const r = chip.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { if (state.me?.inv[chip.dataset.slot]) send({ t: 'weapon', slot: chip.dataset.slot }); e.preventDefault(); return; }
    }
    e.preventDefault();
    ui.setPointerCapture(e.pointerId);
    const zone = stickZone();
    // Left half: the move stick (unless a thumb is already on it). Everywhere else: look. A new finger
    // always takes over looking, so a drag the phone lost track of can never leave the view stuck.
    if (e.clientX < innerWidth * 0.5 && !touch.stick && e.clientY > zone.top) {
      // The stick comes up under your thumb, but kept between the top buttons and your health bars.
      const cx = Math.max(zone.minX, Math.min(zone.maxX, e.clientX)), cy = Math.max(zone.minY, Math.min(zone.maxY, e.clientY));
      touch.stick = { id: e.pointerId, x: e.clientX, y: e.clientY, bx: cx, by: cy };   // input from where your thumb landed; drawn at (bx, by)
      touch.autoRun = false; touch.sprintOn = false;
      Object.assign(base.style, { left: `${cx - 60}px`, top: `${cy - 60}px`, display: 'block' });
      Object.assign(lock.style, { left: `${cx - 34}px`, top: `${cy - 104}px`, display: 'block' });
      lock.textContent = '🔒 RUN';
      lock.classList.remove('on', 'held');
      knob.style.transform = 'translate(0px, 0px)';
    } else touch.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  ui.addEventListener('pointermove', (e) => {
    if (touch.stick?.id === e.pointerId) {
      let dx = e.clientX - touch.stick.x, dy = e.clientY - touch.stick.y;
      const d = Math.hypot(dx, dy), R = 60;
      if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      touch.moveX = dx / R; touch.moveY = -dy / R;
      touch.sprint = d > R * 1.15;   // push past the ring to sprint
      // On up into the lock and let go: keep running until you touch the stick again.
      touch.lockZone = e.clientY - touch.stick.y < -R * 1.7 && Math.abs(e.clientX - touch.stick.x) < R;
      lock.classList.toggle('on', touch.lockZone);
    } else if (touch.look?.id === e.pointerId) {
      lookBy(e.clientX - touch.look.x, e.clientY - touch.look.y);
      touch.look.x = e.clientX; touch.look.y = e.clientY;
    }
  });
  const end = (e) => {
    if (touch.stick?.id === e.pointerId) {
      touch.stick = null; base.style.display = 'none';
      if (touch.lockZone) { touch.autoRun = true; touch.moveX = 0; touch.moveY = 1; touch.sprintOn = true; lock.classList.add('held'); lock.textContent = '🔒 AUTO-RUN · tap stick to stop'; }
      else { touch.moveX = touch.moveY = 0; touch.sprint = false; touch.sprintOn = false; lock.style.display = 'none'; }
      touch.lockZone = false;
    }
    if (touch.look?.id === e.pointerId) touch.look = null;
  };
  ui.addEventListener('pointerup', end);
  ui.addEventListener('pointercancel', end);
  ui.addEventListener('lostpointercapture', end);   // a menu opened, the phone took the touch: let go cleanly
  // Leaving the app (a call, the home button) drops every touch.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    touch.stick = null; touch.look = null; touch.moveX = touch.moveY = 0; touch.sprint = false;
    if (!touch.autoRun) { $('tstick').style.display = 'none'; $('tlock').style.display = 'none'; }
  });
  // A close button for any open screen (phones have no Esc / Tab / P keys).
  $('tclose').addEventListener('click', closeTopPanel);
  applyTouchLayout();
  addEventListener('resize', applyTouchLayout);
}
/** The word on the USE button for what's in front of you ("TAKE", "OPEN", "CLAIM"). */
function useVerb(text) {
  const first = String(text || '').replace(/<[^>]+>/g, '').replace(/^[^A-Za-z]+/, '').trim().split(/\s+/)[0] || 'Use';
  return ({ Pick: 'TAKE', Make: 'CLAIM', Talk: 'TALK', Plant: 'PLANT', Break: 'BREAK', Bypass: 'HACK' }[first] || first).toUpperCase().slice(0, 7);
}
/** Hold HEAL or NADE: a short list pops up over the button to choose from. */
function openTouchPicker(kind, from) {
  const me = state.me, box = $('tpick');
  if (!me) return;
  const opts = [];
  if (kind === 'heal') {
    const kits = me.inv.pack.filter((i) => i.kind === 'medkit').length;
    if (kits) opts.push([`Medkit ×${kits}`, `+${COMBAT_RULES.medkitHeal ?? 50} health`, () => send({ t: 'inv', action: 'use' })]);
    for (const g of Object.keys(GOODS)) if (GOODS[g].food && me[g] > 0) opts.push([`${GOODS[g].name} ×${me[g]}`, `+${GOODS[g].food} food`, () => send({ t: 'inv', action: 'eat', good: g })]);
    if (!opts.length) opts.push(['Nothing to heal with', 'Find medkits; cook or buy food', null]);
  } else {
    for (const [k, name, about] of [['frag', 'Frag grenade', `Bursts after ${COMBAT_RULES.frag.fuseMs / 1000}s: hurts everyone close · ${COMBAT_RULES.frag.costParts} parts`], ['sensor', 'Sensor grenade', `Shows who is near where it lands, and any defenses · ${GADGETS.sensor.cost} tech`], ['stun', 'Stun grenade', `Dazes anyone caught in it, jams sentries and alarms · ${GADGETS.stun.cost} tech`]]) {
      opts.push([`${(state.grenade || 'frag') === k ? '● ' : ''}${name}`, about, () => { state.grenade = k; doAction('sensor'); }]);
    }
  }
  box.innerHTML = '';
  for (const [label, sub, fn] of opts) {
    const b = document.createElement('button');
    b.innerHTML = `<b>${label}</b><small>${sub}</small>`;
    if (fn) b.onpick = () => { box.hidden = true; fn(); };
    else { b.disabled = true; b.onpick = () => { box.hidden = true; }; }
    box.append(b);
  }
  box.hidden = false;
  const r = from.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  box.style.top = `${Math.max(8, r.top - h - 8)}px`;
}
/** What a loot pickup is, for the auto-pickup settings. */
const LOOT_PACK = new Set(['medkit', 'tool', 'marker', 'flare', 'weapon', 'armor', 'package']);
function lootCategory(kind) {
  if (kind === 'ammo') return 'ammo';
  if (kind === 'medkit' || (GOODS[kind]?.food)) return 'heals';
  if (LOOT_PACK.has(kind)) return 'gear';
  return 'supplies';
}
const lootTried = new Map();
// ---- base alerts: a phone notification when your base is attacked while you're out of the game
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64u = (s) => { const pad = '='.repeat((4 - s.length % 4) % 4), raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function pushSubscription(create) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = b64u(state.pushKey);
  const same = (a) => a && new Uint8Array(a).length === key.length && new Uint8Array(a).every((v, i) => v === key[i]);
  if (sub && !same(sub.options?.applicationServerKey)) { await sub.unsubscribe(); sub = null; }   // the server's key changed
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub;
}
async function enablePush() {
  if (!pushOk() || !state.pushKey) return toast('This browser can\'t show notifications. On iPhone, add Deadzone to your Home Screen first.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications are blocked for Deadzone: allow them in your phone\'s settings for this site, then try again'); renderPadSettings(); return; }
  try {
    const sub = await pushSubscription(true);
    send({ t: 'pushSub', sub: sub.toJSON(), fresh: 1 });
    localStorage.setItem('dz_push', '1');
  } catch (e) { toast(`Couldn't turn on base alerts: ${e.message}`); }
  renderPadSettings();
}
async function disablePush() {
  try { const sub = await pushSubscription(false); if (sub) { send({ t: 'pushUnsub', endpoint: sub.endpoint }); await sub.unsubscribe(); } } catch { /* already gone */ }
  localStorage.removeItem('dz_push');
  toast('Base alerts are off for this device');
  renderPadSettings();
}
/** Every time you join a world: make sure it knows where to reach this device. */
async function syncPush() {
  if (!pushOk() || !state.pushKey || localStorage.getItem('dz_push') !== '1' || Notification.permission !== 'granted') return;
  try { const sub = await pushSubscription(true); if (sub) send({ t: 'pushSub', sub: sub.toJSON() }); } catch { /* try again next time */ }
}
function pushRow() {
  const r = document.createElement('div'); r.className = 'item';
  const on = pushOk() && localStorage.getItem('dz_push') === '1' && Notification.permission === 'granted';
  const blocked = pushOk() && Notification.permission === 'denied';
  r.innerHTML = `<div class="meta"><div class="nm">Base alerts on this device: ${on ? 'on' : 'off'}</div><div class="st">${!pushOk() ? 'This browser can\'t show notifications (on iPhone, add Deadzone to your Home Screen first).' : blocked ? 'Notifications are blocked for Deadzone: allow them in your phone\'s settings for this site.' : 'A notification on this phone or computer when your base or your crew\'s is attacked while you\'re out of the game (at most one every few minutes).'}</div></div>`;
  if (pushOk() && !on) { const b = btn('Turn on', enablePush); b.dataset.pad = 'pushon'; r.append(b); }
  if (on) { const t2 = btn('Send a test', () => send({ t: 'pushTest' })); const off = btn('Turn off', disablePush, 'ghost'); t2.dataset.pad = 'pushtest'; off.dataset.pad = 'pushoff'; r.append(t2, off); }
  return r;
}
/** Phones: things on the ground within reach, as a tap-to-take list; walking over the kinds you chose
 *  in Settings picks them up for you. */
function updateTouchLoot() {
  const el = $('tloot');
  if (!el) return;
  const me = state.me;
  if (!me || me.dead || me.downed || state.invOpen || state.air || $('touch').hidden) { el.hidden = true; return; }
  const near = [];
  for (const [, l] of state.loot) { const d = Math.hypot(l.data.x - state.x, l.data.z - state.z); if (d < 5) near.push([d, l.data]); }
  near.sort((a, b) => a[0] - b[0]);
  const now = performance.now(), packFull = me.inv.pack.length >= (state.packSize || 24);
  for (const [d, l] of near) {
    if (d > 2.2 || l.hot || !tset.autoPick[lootCategory(l.kind)] || (packFull && LOOT_PACK.has(l.kind))) continue;   // hot loot is always a choice
    if (now - (lootTried.get(l.id) || 0) < 1500) continue;
    lootTried.set(l.id, now);
    send({ t: 'takeLoot', id: l.id, auto: 1 });
  }
  const show = near.slice(0, 4);
  el.hidden = !show.length;
  const sig = show.map(([, l]) => l.id).join(',');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = '';
  for (const [, l] of show) {
    const b = document.createElement('button');
    const col = LOOT_COLORS[l.kind] ?? 0xffffff;
    b.innerHTML = `<i style="background:#${col.toString(16).padStart(6, '0')}"></i><b>${l.name}${l.amount ? ` ×${l.amount}` : ''}</b><span>Take</span>`;
    b.onpick = () => send({ t: 'takeLoot', id: l.id });
    el.append(b);
  }
}
/** Where the move stick's centre may sit: under the top buttons (room for the RUN lock above it) and
 *  above your level and health bars, so it never covers either. */
function stickZone() {
  const R = 60, top = $('touch').querySelector('.ttop')?.getBoundingClientRect().bottom || 60;
  const vit = $('levelrow')?.parentElement?.getBoundingClientRect(), bottom = vit && vit.height ? vit.top : innerHeight - 90;
  let minY = top + R + 48, maxY = bottom - R - 6;
  if (minY > maxY) minY = maxY = (minY + maxY) / 2;
  return { top: top + 4, minX: R + 10, maxX: Math.max(R + 10, innerWidth * 0.3), minY, maxY };
}
// ---- aim assist (phones and controllers; never a mouse): like the big phone shooters. Over an enemy
// your turning slows so you don't sweep past; while you move, look or fire, the view gently follows
// the target you're on; pressing AIM near one settles your sights onto it. Off / Light / Strong.
const ASSIST_LV = { off: 0, light: 0.55, strong: 1 };
const assist = { target: null, ang: 0, prevAim: false, snap: 0 };
const NOT_FOES = new Set(['merchant', 'settler', 'trader', 'pawn', 'convoy']);
const assistLevel = () => ((state.touchUI && state.inputMode !== 'pad') || state.inputMode === 'pad' ? ASSIST_LV[tset.aimAssist || 'strong'] ?? 1 : 0);
function assistFriction() { return assist.target ? 1 - 0.45 * assistLevel() : 1; }
function updateAimAssist(dt) {
  const lv = assistLevel();
  const me = state.me, aimNowOn = state.aiming;
  assist.target = null;
  if (!lv || !me || me.dead || me.downed || state.air || build.on || state.invOpen) { assist.prevAim = aimNowOn; return; }
  const ws = weaponStats(me.inv[me.active]);
  if (!ws) { assist.prevAim = aimNowOn; return; }
  const E = new THREE.Vector3(state.x, eyeHeight(), state.z), d = lookDir();
  const maxAng = (aimNowOn ? 0.06 : 0.09) * (camera.fov / 70) + 0.015;
  let best = null, bestA = maxAng;
  const consider = (c, mesh) => {
    if (!c || c.dead || c.sq || !mesh) return;
    const p = mesh.position, h = c.prone ? 0.35 : c.crouch ? 0.9 : 1.25;
    const tx = p.x - E.x, ty = p.y + h - E.y, tz = p.z - E.z, L = Math.hypot(tx, ty, tz);
    if (L < 1.5 || L > ws.range * 1.6) return;
    const a = Math.acos(Math.min(1, (tx * d.x + ty * d.y + tz * d.z) / L));
    if (a < bestA) { bestA = a; best = { x: p.x, y: p.y + h, z: p.z, L }; }
  };
  for (const [, r] of state.players) consider(r.data, r.mesh);
  for (const [, r] of state.bots) if (!r.animal && !NOT_FOES.has(r.data?.kind)) consider(r.data, r.mesh);
  if (best) {   // only someone you could actually hit: nothing solid in between
    const dir = new THREE.Vector3(best.x - E.x, best.y - E.y, best.z - E.z).normalize();
    const wall = Math.min(rayAgainstBoxes(E.x, E.y, E.z, dir.x, dir.y, dir.z, solidsAlongRay(E.x, E.z, dir.x, dir.z, best.L), best.L).t, state.map.terrain.ray(E.x, E.y, E.z, dir.x, dir.y, dir.z, best.L));
    if (wall < best.L - 0.6) best = null;
  }
  if (best) {
    assist.target = best; assist.ang = bestA;
    const wantYaw = Math.atan2(best.x - E.x, best.z - E.z), wantPitch = Math.atan2(best.y - E.y, Math.hypot(best.x - E.x, best.z - E.z));
    const dyaw = Math.atan2(Math.sin(wantYaw - state.yaw), Math.cos(wantYaw - state.yaw)), dp = wantPitch - state.pitch;
    if (aimNowOn && !assist.prevAim) assist.snap = 0.16;   // just pressed AIM near a target
    if (assist.snap > 0) {
      const k = Math.min(1, dt / assist.snap) * 0.75 * lv;
      state.yaw += dyaw * k; state.pitch += dp * k; assist.snap -= dt;
    } else {
      const moving = Math.hypot(state.vel?.[0] || 0, state.vel?.[1] || 0) > 0.5;
      const active = moving || !!touch.look || state.mouseDown || [...document.querySelectorAll('#touch .tbtn.fire')].some((b) => b.look);
      if (active) {
        const k = Math.min(1, dt * 3.2 * lv) * (1 - 0.5 * bestA / maxAng);
        state.yaw += dyaw * k * 0.6; state.pitch += dp * k * 0.35;
      }
    }
  } else assist.snap = 0;
  assist.prevAim = aimNowOn;
}
/** Turn the camera by a finger's drag, in pixels (look area, or a thumb sliding on FIRE). */
function lookBy(dx, dy) {
  const sens = (state.aiming ? 0.004 * camera.fov / 70 * (tset.adsSens || 1) : 0.006) * pad.settings.lookSpeed / 2.6 * assistFriction();
  state.yaw -= dx * sens; if (dx) state.lookAt = performance.now();
  state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch - dy * sens));
}
/** Where each button sits (moved ones by the layout editor), how big, how see-through. */
function applyTouchLayout() {
  const ui = $('touch');
  if (!ui) return;
  ui.style.setProperty('--talpha', String(tset.alpha));
  for (const b of ui.querySelectorAll('.tbtn[data-key]')) {
    const at = tset.pos[b.dataset.key];
    // A moved button is centred on its saved spot (share of the screen, so it survives turning the phone).
    if (at) Object.assign(b.style, { left: `${(at[0] * 100).toFixed(2)}%`, top: `${(at[1] * 100).toFixed(2)}%`, right: 'auto', bottom: 'auto', transform: `translate(-50%, -50%) scale(${tset.scale})` });
    else Object.assign(b.style, { left: '', top: '', right: '', bottom: '', transform: `scale(${tset.scale})` });
    if (b.dataset.key === 'lfire') b.hidden = !tset.leftFire && !touch.editing;
  }
}
/** The layout editor (from Settings in the crew panel). */
function editTouch(what) {
  if (what === 'start') { touch.editing = true; closeTopPanel(); $('tedit').hidden = false; $('touch').classList.add('editing'); applyTouchLayout(); return; }
  if (what === 'small') tset.scale = Math.max(0.7, +(tset.scale - 0.1).toFixed(2));
  if (what === 'big') tset.scale = Math.min(1.5, +(tset.scale + 0.1).toFixed(2));
  if (what === 'faint') tset.alpha = Math.max(0.3, +(tset.alpha - 0.15).toFixed(2));
  if (what === 'solid') tset.alpha = Math.min(1, +(tset.alpha + 0.15).toFixed(2));
  if (what === 'reset') { tset.pos = {}; tset.scale = 1; tset.alpha = 1; }
  if (what === 'done') { touch.editing = false; $('tedit').hidden = true; $('touch').classList.remove('editing'); }
  saveTset();
  applyTouchLayout();
}
// Gyro aim: turn the phone to fine-aim (Off, while aiming, or always). Rates are mapped to the screen
// the way the phone is held, so it works upright or either way sideways.
let gyroAt = 0;
function onGyro(e) {
  const rr = e.rotationRate;
  if (!rr || tset.gyro === 'off' || $('touch').hidden || touch.editing || (tset.gyro === 'aim' && !state.aiming)) { gyroAt = 0; return; }
  const now = performance.now(), dt = gyroAt ? Math.min(0.1, (now - gyroAt) / 1000) : 0;
  gyroAt = now;
  if (!dt) return;
  const ang = (screen.orientation?.angle ?? window.orientation ?? 0) % 360, rad = Math.PI / 180 * dt * 1.1;
  const a = rr.beta || 0, g = rr.gamma || 0;
  const [yaw, pitch] = ang === 90 ? [a, -g] : ang === 270 || ang === -90 ? [-a, g] : [g, a];
  state.yaw += yaw * rad;
  state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch + pitch * rad));
}
async function setGyro(mode) {
  if (mode !== 'off' && typeof DeviceMotionEvent?.requestPermission === 'function') {
    try { if (await DeviceMotionEvent.requestPermission() !== 'granted') { toast('Motion access was turned down, so gyro aim stays off'); mode = 'off'; } } catch { mode = 'off'; }
  }
  tset.gyro = mode; saveTset();
  removeEventListener('devicemotion', onGyro);
  if (mode !== 'off') addEventListener('devicemotion', onGyro);
}
if (tset.gyro !== 'off') addEventListener('devicemotion', onGyro);
Object.assign(window.__dz, { touch, tset, editTouch, aimPoint, eyeHeight, camera, scene, tracers, boomFx, ground, toast, gunFx, selfMesh, doAction, mapView });   // debug/test hook
function closeTopPanel() {
  if (state.rideOpen) return closeRidePicker();
  if (ptrade.open) return send({ t: 'ptrade', action: 'cancel' });
  if (state.gunsmithOpen) return closeGunsmith();
  if (state.contactOpen) return closeContact();
  if (state.mapOpen && (state.mapMode === 'view' || state.mapMode === 'travel')) return closeMapScreen();
  if (state.panelOpen) return closeSquadPanel();
  if (state.invOpen) return doAction('inventory');
}
const touchCapable = MOBILE || 'ontouchstart' in window;
if (touchCapable) buildTouchUI();
setInterval(() => {
  if (!touchCapable) return;
  const panel = topPanel();
  const playing = !!state.me && state.inputMode !== 'pad' && !state.me.dead;
  $('touch').hidden = (!playing || !!panel) && !touch.editing;
  document.body.classList.toggle('touchui', !$('touch').hidden || (touchCapable && !!state.me && state.inputMode !== 'pad'));
  // Close button for screens that otherwise need a keyboard to leave.
  $('tclose').hidden = !(state.inputMode !== 'pad' && panel && panel.id !== 'login' && !(panel.id === 'mapscreen' && state.mapMode !== 'view' && state.mapMode !== 'travel'));
  if ($('touch').hidden && (touch.stick || touch.look)) { touch.stick = null; touch.look = null; touch.moveX = touch.moveY = 0; touch.sprint = false; $('tstick').style.display = 'none'; }
  $('touch').querySelector('.aim')?.classList.toggle('on', state.aiming);
  // Buttons that only matter sometimes show only then: USE when there's something to use, RELOAD when
  // the gun isn't full, HEAL when you're hurt and carry a medkit. (The layout editor shows them all.)
  const me = state.me, show = (key, on) => { const b = $('touch').querySelector(`[data-key=${key}]`); if (b) b.classList.toggle('idle', !on && !touch.editing); };
  if (me) {
    const w = me.inv?.[me.active], full = w ? me.mag >= weaponStats(w).mag : true;
    show('use', !!state.promptText);
    $('touch').querySelector('[data-key=use]')?.classList.toggle('ready', !!state.promptText);
    const useLabel = $('touch').querySelector('[data-key=use] .tl');
    if (useLabel) {
      const verb = useVerb(state.promptText);
      if (useLabel.textContent !== verb) useLabel.textContent = verb;
    }
    const wsNow = w && weaponStats(w);
    show('zoom', !!(state.aiming && wsNow?.zoomAlt));
    const zl = $('touch').querySelector('[data-key=zoom] .tl');
    if (zl && wsNow?.zoomAlt) { const t = `${scopeMag(w, !state.zoomAlt ? 1 : 0)}`; if (zl.textContent !== t) zl.textContent = t; }
    state.touchUI = document.body.classList.contains('touchui');
    show('reload', !!w && !full && reserveFor(me) > 0);
    show('heal', (me.hp < me.maxHp && me.inv?.pack?.some((i) => i.kind === 'medkit')) || ((me.food ?? 100) < 60 && Object.keys(GOODS).some((g) => GOODS[g].food && me[g] > 0)));
  }
  $('touch').querySelector('[data-key=crouch]')?.classList.toggle('on', !!state.crouch);
  $('touch').querySelector('[data-key=prone]')?.classList.toggle('on', !!state.prone);
  if (touch.autoRun && (state.me?.dead || state.me?.downed)) { touch.autoRun = false; touch.moveY = 0; touch.sprintOn = false; $('tlock').style.display = 'none'; }
}, 200);

// ------------------------------------------------------------------ lobby: worlds, friends, invites
// The hub (server/hub.js) runs the lobby: pick a world, manage friends, send and receive invites.
// Its connection stays open while you play, so invites reach you anywhere.
const lobby = { ws: null, account: null, state: null, results: null, invite: null, autoJoined: false };
function hubSend(m) { if (lobby.ws?.readyState === 1) lobby.ws.send(JSON.stringify(m)); }
function hubConnect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/hub`);
  lobby.ws = ws;
  ws.onopen = () => hubSend({ t: 'hello', token: localStorage.getItem('dz_token'), name: localStorage.getItem('dz_name') });
  ws.onclose = () => setTimeout(hubConnect, 3000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'needName':
        $('lbName').hidden = false; $('lbMain').hidden = true;
        if (m.suggest && !$('name').value) $('name').value = m.suggest;
        break;
      case 'account': {
        lobby.account = m;
        localStorage.setItem('dz_token', m.token);
        localStorage.setItem('dz_name', m.name);
        state.myName = m.name;
        $('lbName').hidden = true; $('lbMain').hidden = false;
        $('lbWho').textContent = m.name;
        // Arrived from an invite link: go straight into that world.
        const q = new URLSearchParams(location.search);
        if (q.get('world') && !lobby.autoJoined && !state.ws) {
          lobby.autoJoined = true;
          history.replaceState(null, '', '/');
          playWorld(Number(q.get('world')), q.get('ticket'));
        }
        break;
      }
      case 'state':
        lobby.state = m;
        // This arrives every few seconds: never redraw a list under someone's typing.
        if (!typingIn($('login'))) redraw($('login'), renderLobby);
        if (state.panelOpen && !typingIn($('squadpanel'))) redraw($('squadpanel'), () => renderFriends($('sqFriends'), true));
        break;
      case 'search': lobby.results = m.results; redraw($('login'), renderLobby); if (state.panelOpen) renderSquadPanel(); break;
      case 'linkCode': lobby.link = m; renderLobby(); break;
      case 'invite': showInvite(m); break;
      case 'note': toast(m.text); break;
      case 'error': toast(`⚠ ${m.text}`); break;
    }
  };
}
$('register').onclick = () => hubSend({ t: 'register', name: $('name').value, token: localStorage.getItem('dz_token') });
// Your callsign on this device too: callsign + the code from the device you already play on.
$('linkGo').onclick = () => hubSend({ t: 'link', name: $('linkName').value, code: $('linkCode').value });
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('register').click(); });
/** The joining card: what's happening between pressing Play and the deploy screen. */
function joinStatus(step, sub = '') {
  $('joining').hidden = !step;
  if (!step) return;
  $('joinStep').textContent = step;
  $('joinSub').textContent = sub;
}
function playWorld(id, ticket = null) {
  if (!lobby.account) return;
  // Answer the press at once: the button, then the card.
  for (const b of document.querySelectorAll('.lb-play')) { b.disabled = true; b.textContent = 'Joining…'; }
  if (!state.ws) joinStatus('Joining Liberty County…', 'Connecting to the server.');
  if (state.ws && state.worldId !== id) { location.href = `/?world=${id}${ticket ? `&ticket=${ticket}` : ''}`; return; }
  if (state.ws) return;
  connect(lobby.account.name, id, ticket);
}
function renderLobby() {
  const st = lobby.state;
  if (!st) return;
  const wl = $('lbWorlds'); wl.innerHTML = '';
  for (const w of st.worlds) {
    // The world as a card: its name, who's on, which friends are there, and one big Play button.
    const card = document.createElement('div');
    card.className = 'lb-world';
    card.innerHTML = `<div class="lb-wname">${w.name}</div><div class="lb-wstat">${w.up ? `<b>${w.online}</b> of ${w.cap} players on now` : 'Starting up, a few seconds…'}</div>${w.friends.length ? `<div class="lb-wfriends">Friends here: ${w.friends.join(', ')}</div>` : ''}`;
    const b = btn(w.up ? (w.online >= w.cap ? 'Full right now' : 'Play') : 'Starting…', () => playWorld(w.id), 'lb-play');
    b.dataset.pad = `play-${w.id}`;
    b.disabled = !w.up || w.online >= w.cap;
    card.append(b);
    wl.append(card);
  }
  renderFriends($('lbFriends'), false);
  // Play as yourself on a phone, the Shield app or another browser.
  const lk = document.createElement('div');
  lk.className = 'lb-link';
  if (lobby.link && lobby.link.expires > Date.now()) {
    lk.innerHTML = `<h2>Play on another device</h2><p class="lb-note">On the other device, choose <b>Already playing on another device?</b> and enter your callsign <b>${lobby.account?.name || ''}</b> and this code:</p><div class="lb-codebig">${lobby.link.code}</div><p class="lb-note">Good for ten minutes, once. Your level, home and gear come with you.</p>`;
  } else {
    lk.innerHTML = '<h2>Play on another device</h2><p class="lb-note">Use the same callsign, level and home on your phone, the Shield app or another browser.</p>';
    const b = btn('Get a code for another device', () => hubSend({ t: 'linkCode' }));
    b.dataset.pad = 'getcode';
    lk.append(b);
  }
  wl.append(lk);
}
/** Friends list, requests, search and recent players. `inGame` adds invite-to-this-world buttons. */
function renderFriends(el, inGame) {
  const st = lobby.state;
  if (!el) return;
  if (!st) { el.innerHTML = '<div class="empty">Connecting…</div>'; return; }
  el.innerHTML = '';
  const add = (html, buttons = []) => { const row = document.createElement('div'); row.className = 'item'; row.innerHTML = `<div class="meta">${html}</div>`; row.append(...buttons); el.append(row); };
  const head = (t) => { const h = document.createElement('h3'); h.textContent = t; el.append(h); };
  // Search.
  const srow = document.createElement('div');
  srow.className = 'item';
  const input = draftInput({ placeholder: 'Find agents by callsign', maxLength: 16 });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const go = () => hubSend({ t: 'search', q: input.value });
  srow.append(input, btn('Search', go, ''));
  el.append(srow);
  for (const r of lobby.results || []) {
    add(`<div class="nm">${r.name} <small class="${r.online ? 'good' : 'muted'}">${r.online ? '● online' : 'offline'}</small></div>`,
      r.friend ? [] : r.requested ? [Object.assign(btn('Requested', () => {}), { disabled: true })] : [btn('Add friend', () => hubSend({ t: 'friendRequest', name: r.name }))]);
  }
  if (st.requests.length) {
    head('Friend requests');
    for (const n of st.requests) add(`<div class="nm">${n}</div>`, [btn('Accept', () => hubSend({ t: 'friendAccept', name: n }), ''), btn('Decline', () => hubSend({ t: 'friendDecline', name: n }))]);
  }
  head(`Friends (${st.friends.length})`);
  if (!st.friends.length) add('<div class="st">No friends yet. Search for a callsign above, or add people you play with.</div>');
  const crewNames = new Set((state.squad.members || []).map((m) => m.name));
  for (const f of st.friends) {
    const where = f.world ? `in ${f.worldName}` : f.online ? 'in the lobby' : 'offline';
    const buttons = [];
    if (inGame && f.online && f.world !== state.worldId) buttons.push(btn('Invite here', () => send({ t: 'squad', action: 'ticket', for: f.name }), ''));
    if (inGame && f.world === state.worldId && !crewNames.has(f.name)) buttons.push(btn('Crew invite', () => send({ t: 'squad', action: 'invite', name: f.name }), ''));
    if (f.world && f.world !== state.worldId) buttons.push(btn(`Join ${f.worldName}`, () => playWorld(f.world)));
    // Removing a friend takes two presses: the first asks, the second does it (no browser pop-up).
    const rm = btn('Remove', () => {
      if (rm.dataset.sure) return hubSend({ t: 'unfriend', name: f.name });
      rm.dataset.sure = '1'; rm.textContent = `Remove ${f.name}? Press again`; rm.className = 'danger-btn';
      setTimeout(() => { if (rm.isConnected) { delete rm.dataset.sure; rm.textContent = 'Remove'; rm.className = 'ghost'; } }, 4000);
    });
    rm.dataset.pad = `rm-${f.name}`;
    buttons.push(rm);
    add(`<div class="nm"><span class="${f.online ? 'good' : 'muted'}">●</span> ${f.name} <small class="muted">${where}${crewNames.has(f.name) ? ' · your crew' : ''}</small></div>`, buttons);
  }
  if (st.recent.length) {
    head('Played with recently');
    for (const r of st.recent) add(`<div class="nm">${r.name} <small class="muted">${r.world ? `in ${r.worldName}` : r.online ? 'online' : 'offline'}</small></div>`,
      st.sent.includes(r.name) ? [Object.assign(btn('Requested', () => {}), { disabled: true })] : [btn('Add friend', () => hubSend({ t: 'friendRequest', name: r.name }))]);
  }
}
/** An invite pops up wherever you are: in the lobby or mid-game. */
/** The bar at the top that asks a yes-or-no question (a friend's invite, a trade request). On a
 *  controller, holding ⧉ says yes. It goes away by itself after `ms`. */
function showAsk(html, yesText, onYes, noText, ms) {
  const bar = $('invitebar');
  const close = () => { bar.hidden = true; clearTimeout(showAsk.timer); };
  bar.innerHTML = `<div>${html}</div>`;
  const hint = Object.assign(document.createElement('small'), { className: 'padonly', textContent: `Hold ⧉ to ${yesText.toLowerCase()}` });
  bar.append(btn(yesText, () => { close(); onYes(); }, ''), btn(noText, close), hint);
  bar.hidden = false;
  clearTimeout(showAsk.timer);
  showAsk.timer = setTimeout(close, ms);
}
function showInvite(m) {
  lobby.invite = m;
  showAsk(`<b>${m.from}</b> invited you to <b>${m.worldName}</b>${m.ticket ? ' and their crew' : ''}`, state.worldId === m.world && state.ws ? 'Join crew' : 'Join', () => {
    if (state.ws && state.worldId === m.world) { if (m.ticket) toast(`You're already in this world — ask them for a crew invite (crew panel: ${glyph('P')})`); return; }
    playWorld(m.world, m.ticket);
  }, 'Not now', 60_000);
}
// Tell the hub who you've been playing alongside, for the "played with recently" list.
setInterval(() => {
  if (!state.ws || !lobby.account) return;
  const names = [...state.players.values()].map((r) => r.data?.name).filter(Boolean);
  for (const m of state.squad.members || []) if (m.name !== state.myName) names.push(m.name);
  if (names.length) hubSend({ t: 'met', names: [...new Set(names)] });
}, 30_000);

// Start talking to the lobby once everything above exists.
hubConnect();
// The lobby's moving map (stops by itself once you're in the game). The right stick leans it too.
startLobbyFx($('lobbyfx'), { isVisible: () => !$('login').hidden, look: () => { const g = readPad(); return g ? [g.axes[2] || 0, g.axes[3] || 0] : [0, 0]; } });

// ------------------------------------------------------------------ install as an app
// Phones and computers: the browser's own "Install" (Chrome / Edge) or Add to Home Screen (iPhone).
// Android TV (Shield) has no browser to install from, so there's an app file to download.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; renderGetApp(); });
function renderGetApp() {
  const box = $('getApp');
  if (!box) return;
  const app = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || /DeadzoneApp/.test(navigator.userAgent);
  if (app) { box.hidden = true; return; }
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  box.innerHTML = '<h2>Get the app</h2>';
  if (installPrompt) box.append(btn('Install Deadzone on this device', async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; renderGetApp(); }, ''));
  const p = document.createElement('p');
  p.className = 'sub';
  p.innerHTML = ios ? 'iPhone: tap Share, then <b>Add to Home Screen</b>.'
    : `${installPrompt ? '' : 'Phone: open the browser menu and pick <b>Install app</b> or <b>Add to Home screen</b>. '}Android TV and Shield: install the free <b>Downloader</b> app, then enter <b>${location.host}/apk/deadzone.apk</b>.`;
  box.append(p);
}
renderGetApp();

// ------------------------------------------------------------------ face-to-face trading
// Both players put up goods, items or cash; both confirm; it swaps at once. Any change un-confirms.
const ptrade = { open: false, offer: { res: {}, items: [] } };
function handlePlayerTrade(m) {
  if (m.state === 'ask') {
    // The request lapses on the server after 30 seconds, so the bar does too.
    showAsk(`<b>${m.from}</b> wants to trade`, 'Trade', () => send({ t: 'ptrade', action: 'accept' }), 'No', 30_000);
    return;
  }
  if (m.state === 'closed') { ptrade.open = false; $('tradepanel').hidden = true; toast(m.why); lockPointer(); return; }
  ptrade.open = true;
  ptrade.view = m;
  $('tradepanel').hidden = false;
  document.exitPointerLock?.();
  renderPlayerTrade();
}
function renderPlayerTrade() {
  const m = ptrade.view, me = state.me;
  if (!m || !me) return;
  $('tpTitle').textContent = `Trading with ${m.with || '…'}`;
  const keepRes = document.activeElement?.dataset?.res;
  const mine = $('tpMine'); mine.innerHTML = '';
  const offer = { res: { ...m.you.res }, items: m.you.items.map((i) => i.id) };
  for (const r of RES_UI.filter((x) => me[x] || offer.res[x])) {
    const row = document.createElement('div'); row.className = 'item';
    const input = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: me[r], value: offer.res[r] || 0, style: 'width:70px', title: `How much ${RES_LABEL[r] || r} to offer` });
    input.dataset.res = r;
    input.onchange = () => { offer.res[r] = Number(input.value) || 0; send({ t: 'ptrade', action: 'offer', ...offer }); };
    if (keepRes === r) setTimeout(() => { if (state.inputMode === 'pad') padFocus(input); else input.focus(); }, 0);
    row.innerHTML = `<div class="meta"><div class="nm">${resText(r, me[r])}</div></div>`;
    row.append(input);
    mine.append(row);
  }
  for (const it of me.inv.pack.filter((i) => i.kind !== 'cargo')) {
    const row = document.createElement('div'); row.className = 'item';
    const on = offer.items.includes(it.id);
    row.innerHTML = `<div class="meta"><div class="nm">${it.name}</div></div>`;
    row.append(btn(on ? '✓ Offered' : 'Offer', () => { offer.items = on ? offer.items.filter((x) => x !== it.id) : [...offer.items, it.id]; send({ t: 'ptrade', action: 'offer', ...offer }); }, on ? '' : 'ghost'));
    mine.append(row);
  }
  const theirs = $('tpTheirs');
  const list = [...Object.entries(m.them.res).filter(([, v]) => v > 0).map(([k, v]) => resText(k, v)), ...m.them.items.map((i) => i.name)];
  theirs.innerHTML = list.length ? list.map((x) => `<div class="item"><div class="meta"><div class="nm">${x}</div></div></div>`).join('') : '<div class="empty">Nothing yet</div>';
  $('tpStatus').textContent = `${m.youOk ? '✔ You confirmed' : 'You haven\'t confirmed'} · ${m.themOk ? `✔ ${m.with} confirmed` : `${m.with} hasn't confirmed`}`;
}
$('tpConfirm').onclick = () => send({ t: 'ptrade', action: 'confirm' });
$('tpCancel').onclick = () => send({ t: 'ptrade', action: 'cancel' });
// Touching the screen after using a controller brings the touch controls back.
addEventListener('touchstart', () => { if (state.inputMode === 'pad') setInputMode('kb'); }, { passive: true });
