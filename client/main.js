import * as THREE from 'three';
import {
  generateMap, mapChecksum, moveWithCollision, rayAgainstBoxes, rayBox, characterBounds, INTERACT_RANGE,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED,
} from '/shared/world.js';
import {
  ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS, SLOT_LABELS, weaponStats, armorStats, statBars, partFits,
  xpForLevel, MAX_LEVEL, GADGETS, isUnlocked, UPGRADES, CONTRACT_TYPES, FIELD_PERKS,
} from '/shared/items.js';
import { buildGunModel, setExplode, gunKey } from '/gunmodel.js';
import { createWorldView } from '/worldview.js';
import { buildMapBase, drawMap, mapGroundColor } from '/mapview.js';
import { PIECES, BUILD, TOOLS, CRAFTS, pieceBox, placementProblem } from '/shared/building.js';
import { CLAIM, HOME_LEVEL_XP, MAX_HOME_LEVEL, HOME_LEVEL_TEXT, homePerks } from '/shared/claims.js';
import { VEHICLE_TYPES, HOME_KINDS } from '/shared/world.js';

const $ = (id) => document.getElementById(id);
/** Terrain height under a point (0 before the world exists). */
const ground = (x, z) => (state.map ? state.map.terrain.height(x, z) : 0);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('game');
// Phones/tablets (touch-first devices) get a lighter render profile.
const MOBILE = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.25 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9aa4ad);
scene.fog = new THREE.Fog(0x9aa4ad, MOBILE ? 45 : 60, MOBILE ? 170 : 230);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, MOBILE ? 260 : 360);
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a3530, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 220 });
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
  contracts: [], drops: [], objectives: [], contactMeshes: [],
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

function initWorld(m) {
  const map = generateMap(m.seed, m.size);
  if (mapChecksum(map) !== m.mapSum) toast('⚠ World mismatch with server — update your client');
  state.map = map;
  state.view = createWorldView(scene, map, { viewRange: MOBILE ? 230 : 320, mobile: MOBILE });
  state.view.setOwnHouse(m.houseId);
  state.mapBase = buildMapBase(map, MOBILE ? 1000 : 1400);
  // Contacts: friendly NPCs standing in each town square.
  for (const c of map.contacts) {
    const g = makeCharacter('contact', c.name);
    g.position.set(c.x, ground(c.x, c.z), c.z);
    g.rotation.y = Math.PI / 4;
    setLabel(g.userData.label, `✦ ${c.name}`, '#7fd6ff');
    g.userData.bars.visible = false;
    state.contactMeshes.push(g);
  }
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
      const door = new THREE.Mesh(new THREE.BoxGeometry(d.maxX - d.minX, d.h, d.maxZ - d.minZ), doorMat.clone());
      door.position.set((d.minX + d.maxX) / 2, d.y0 + d.h / 2, (d.minZ + d.maxZ) / 2);
      door.castShadow = true;
      const label = makeLabel('', 0.012);
      label.position.set(def.x, ground(def.x, def.z) + (def.kind === 'vehicle' ? 4.6 : def.kind === 'room' ? 6 : 5.2), def.z);
      scene.add(door, label);
      houseVis.set(h.id, (v = { door, label }));
    }
    const f = h.max ? h.hp / h.max : 0;
    v.door.visible = h.hp > 0 && !h.open;
    v.door.material.color.setRGB(0.35 + 0.5 * (1 - f), 0.37 * f + 0.05, 0.4 * f + 0.05 + h.upg.door * 0.08);
    const own = h.id === state.houseId;
    const status = h.hp <= 0 ? 'BREACHED' : h.open ? 'open' : `${Math.round(f * 100)}%`;
    const kn = homeKindName(def);
    setLabel(v.label, h.owner ? `${own ? 'YOUR ' + kn.toUpperCase() : `${h.owner}'s ${kn.toLowerCase()}`} · Lv${h.hl} · ${status}` : `Unclaimed ${kn.toLowerCase()} · plant a claim marker`, own ? '#7dff9a' : !h.owner ? '#c9c9c9' : h.hp <= 0 ? '#ff6b6b' : '#ffd29a');
  }
  for (const [id, v] of houseVis) if (!seen.has(id)) { scene.remove(v.door, v.label); v.door.geometry.dispose(); houseVis.delete(id); state.houseState.delete(id); }
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
  g.font = 'bold 40px Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(text, 256, 60);
  g.fillStyle = color; g.fillText(text, 256, 60);
  s.userData.tex.needsUpdate = true;
}

// ------------------------------------------------------------------ characters
function makeCharacter(kind, name) {
  const g = new THREE.Group();
  const color = kind === 'self' ? 0x3a7bd5 : kind === 'bot' ? 0x3d2b4f : kind === 'contact' ? 0x2a6f7a : 0xd0602a;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.95, 4, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  body.position.y = 0.82;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshStandardMaterial({ color: kind === 'bot' ? 0x222222 : 0xc9a27e }));
  head.position.y = 1.58;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.1), new THREE.MeshBasicMaterial({ color: kind === 'bot' ? 0xff2222 : 0xffa64d }));
  visor.position.set(0, 1.6, 0.17);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.22), new THREE.MeshStandardMaterial({ color: 0x3b3a30 }));
  pack.position.set(0, 1.05, -0.3);
  const gun = new THREE.Group();          // holds the gunsmith-built weapon model
  gun.position.set(-0.25, 1.25, 0.25);
  for (const m of [body, head, pack]) m.castShadow = true;
  g.add(body, head, visor, pack, gun);
  const upper = new THREE.Group();
  g.userData = { body, head, visor, gun, pack };
  if (kind !== 'self') {
    const label = makeLabel(name, kind === 'contact' ? 0.006 : 0.0042, kind === 'bot' ? '#ff6b6b' : '#ffb27a');
    label.position.y = 2.35;
    g.add(label);
    const barBg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), new THREE.MeshBasicMaterial({ color: 0xff3b3b }));
    const armorBar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.05), new THREE.MeshBasicMaterial({ color: 0x5aa8ff }));
    const bars = new THREE.Group();
    bars.add(barBg, bar, armorBar);
    bar.position.z = 0.001; armorBar.position.set(0, 0.08, 0.001);
    bars.position.y = 2.12;
    g.add(bars);
    Object.assign(g.userData, { label, bar, armorBar, bars });
  }
  g.add(upper);
  scene.add(g);
  return g;
}

function setCharacterGun(g, gun) {
  const key = gunKey(gun);
  if (g.userData.gunKey === key) return;
  g.userData.gunKey = key;
  g.userData.gun.clear();
  if (gun) g.userData.gun.add(buildGunModel(gun));
}

function updateCharacterMesh(g, c, dt) {
  // Interpolate toward the latest snapshot.
  const k = Math.min(1, dt * 12);
  g.position.x += (c.x - g.position.x) * k;
  g.position.z += (c.z - g.position.z) * k;
  g.position.y = ground(g.position.x, g.position.z);
  let dy = c.yaw - g.rotation.y;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  g.rotation.y += dy * k;
  const crouchScale = c.crouch ? 0.68 : 1;
  g.userData.body.scale.y += (crouchScale - g.userData.body.scale.y) * k;
  const yShift = c.crouch ? -0.55 : 0;
  for (const part of ['head', 'visor', 'gun', 'pack']) {
    const base = { head: 1.58, visor: 1.6, gun: 1.25, pack: 1.05 }[part];
    const m = g.userData[part];
    m.position.y += (base + yShift - m.position.y) * k;
  }
  g.visible = !c.dead;
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

const selfMesh = makeCharacter('self', '');
selfMesh.visible = false;

// ------------------------------------------------------------------ loot visuals
const LOOT_COLORS = { parts: 0xffc53d, ammo: 0x7bd88f, medkit: 0xff5a5a, bag: 0xffffff };
function lootMesh(kind) {
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
function addTracer(o, p, hit) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...o), new THREE.Vector3(p[0], p[1], p[2])]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }));
  scene.add(line);
  tracers.push({ obj: line, life: 0.08 });
  if (hit) {
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    spark.position.set(p[0], p[1], p[2]);
    scene.add(spark);
    tracers.push({ obj: spark, life: 0.12 });
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

function toast(text) {
  const el = document.createElement('div');
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

function feedLine(text) {
  const el = document.createElement('div');
  el.textContent = text;
  $('feed').prepend(el);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
  setTimeout(() => el.remove(), 12000);
}

// ------------------------------------------------------------------ minimap
const MM_COLORS = { roomwall: '#8a8a86', vehiclebody: '#d6c79a', dam: '#999', scrub: '#55603a', pine: '#1f3a24', boulder: '#6a6560', adobe: '#a88a64', cactus: '#3f6a33', cavewall: '#5a5550', caveroof: 'rgba(0,0,0,0)', rockwall: '#8c7258', logwall: '#5a3d24', plankwall: '#7a5e3e', canopy: 'rgba(0,0,0,0)', jetty: '#7a5e3e', building: '#4a5058', warehouse: '#4a5058', farmhouse: '#6b5a44', barn: '#6b3a30', housewall: '#a8774c', crate: '#ff8a2a', tree: '#2c4a26', rock: '#555', car: '#5a3434', cover: '#3a3f44', terminal: '#16c2ff', border: '#000' };
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
  for (const b of state.map.grid.near(state.x, state.z, view * 1.42)) {
    g.fillStyle = b.type === 'housewall' && b.houseId === state.houseId ? '#4fbf6a' : MM_COLORS[b.type] || '#3a3f44';
    g.fillRect(X(b.minX), Z(b.minZ), Math.max(1.5, (b.maxX - b.minX) * k), Math.max(1.5, (b.maxZ - b.minZ) * k));
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
  const hp0 = homePos();
  if (hp0) edge(hp0.x, hp0.z, '#4fbf6a', 7);
  g.translate(R, R);
  g.rotate(-state.yaw + Math.PI);
  g.fillStyle = '#5aa8ff';
  g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(-5, 6); g.closePath(); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ networking
function connect(name) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, token: localStorage.getItem('dz_token') }));
  ws.onclose = (e) => { toast(e.reason || 'Disconnected from server'); $('login').hidden = false; $('hud').hidden = true; };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}
const send = (m) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(m));

function handle(m) {
  switch (m.t) {
    case 'welcome':
      localStorage.setItem('dz_token', m.token);
      state.myName = $('name').value.trim() || 'Agent';
      Object.assign(state, { id: m.id, houseId: m.houseId, x: m.x, z: m.z, yaw: m.yaw || 0, packSize: m.packSize, doorBase: m.doorBase });
      if (!state.map) initWorld(m);
      selfMesh.visible = true;
      selfMesh.position.set(m.x, ground(m.x, m.z), m.z);
      $('login').hidden = true; $('hud').hidden = false;
      if (m.deploy) openMapScreen(m.firstDeploy ? 'first' : 'redeploy', m.deploy);
      else { toast('Back in the zone where you left off.'); lockPointer(); }
      break;
    case 'snap': {
      for (const p of m.players) {
        if (p.id === state.id) { state.selfSnap = p; continue; }
        let rec = state.players.get(p.id);
        if (!rec) { rec = { mesh: makeCharacter('player', p.name) }; rec.mesh.position.set(p.x, ground(p.x, p.z), p.z); state.players.set(p.id, rec); }
        rec.data = p;
        setCharacterGun(rec.mesh, p.gun);
        setLabel(rec.mesh.userData.label, `${p.sq ? '◆ ' : ''}${p.name}  [${p.level}]${p.hacking ? '  ⌁ hacking' : ''}`, p.sq ? '#7dff9a' : '#ffb27a');
        setCloak(rec.mesh, p.camo ? (p.sq ? 0.35 : 0.12) : 1);
      }
      for (const [id, rec] of state.players) if (!m.players.some((p) => p.id === id)) { scene.remove(rec.mesh); state.players.delete(id); }
      for (const b of m.bots) {
        let rec = state.bots.get(b.id);
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
      syncEntities(m.loot, state.loot, (e) => lootMesh(e.kind));
      syncEntities(m.bags, state.bags, () => lootMesh('bag'));
      if (state.panelOpen && performance.now() - (state.panelDrawn || 0) > 1000) { state.panelDrawn = performance.now(); renderSquadPanel(); }
      syncHouses(m.houses);
      syncTerminals(m.terminals || []);
      syncObjectives(m.objectives || []);
      syncStructs(m.structs || []);
      syncCharges(m.charges || []);
      break;
    }
    case 'you': {
      const wasDead = state.me?.dead;
      state.me = m;
      if (m.houseId !== state.houseId) { state.houseId = m.houseId; state.view?.setOwnHouse(m.houseId); }
      if (state.mapMode && state.mapOpen) renderMapScreen();
      if (state.contactOpen) renderContact();
      updateHud();
      if (state.invOpen) renderInventory();
      if (state.gunsmithOpen) renderGunsmith();
      setCloak(selfMesh, m.camoActive ? 0.3 : 1);
      if (build.on) renderBuildBar();
      document.body.classList.toggle('cloaked', !!m.camoActive);
      updateGadgetBar();
      setCharacterGun(selfMesh, m.inv[m.active] ? { a: m.inv[m.active].archetype, parts: m.inv[m.active].parts, paint: m.inv[m.active].paint } : null);
      break;
    }
    case 'correct':
      state.x = m.x; state.z = m.z;
      if (m.force) { selfMesh.position.set(m.x, ground(m.x, m.z), m.z); state.view?.update(m.x, m.z); }
      break;
    case 'shot': {
      // Suppressed fire from other players only shows up close.
      const near = Math.hypot(m.o[0] - state.x, m.o[2] - state.z) < 25;
      if (m.sup && m.from !== state.id && !near) break;
      for (const h of m.hits) addTracer(m.o, h, h[3]);
      break;
    }
    case 'xp':
      xpPopup(m.amount, m.reason);
      break;
    case 'levelup':
      levelBanner(m.level, m.unlocks);
      break;
    case 'hitmark':
      damageNumber(m.dmg, m.crit, [m.x, m.y, m.z]);
      break;
    case 'feed': feedLine(m.text); break;
    case 'squad':
      state.squad = { id: m.id, members: m.members || [], leaderId: m.leaderId ?? null };
      if (state.panelOpen) renderSquadPanel();
      updateGadgetBar();
      break;
    case 'invite':
      state.invite = { fromId: m.fromId, fromName: m.fromName };
      toast(`${m.fromName} invited you to their squad — press P to respond`);
      if (state.panelOpen) renderSquadPanel();
      break;
    case 'leaderboard':
      state.leaderboard = m.rows;
      if (state.panelOpen) renderSquadPanel();
      break;
    case 'expose':
      for (const id of m.ids) {
        const prev = state.exposed.get(id);
        state.exposed.set(id, { until: performance.now() + (m.until - Date.now()), kind: prev?.kind === 'mark' && m.kind === 'sensor' ? 'mark' : m.kind });
      }
      if (m.kind === 'mark' && m.by && m.by !== state.myName) toast(`${m.by} tagged a target`);
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
    case 'ping':
      if (m.objective) state.pings = state.pings.filter((p) => !p.objective);
      state.pings.push({ x: m.x, z: m.z, from: m.from, objective: m.objective, until: performance.now() + (m.objective ? 120_000 : 8000) });
      break;
    case 'alert':
      state.alerts.push({ x: m.x, z: m.z, until: performance.now() + 6000 });
      toast(`⚠ ${m.text} nearby`);
      break;
    case 'hack':
      if (m.cancel) { state.hack = null; toast(m.reason); }
      else if (m.done) { state.hack = null; toast(m.text); }
      else state.hack = { start: performance.now(), total: m.total, kind: m.kind };
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
      toast(m.kind === 'claim' ? 'Stash house claimed. Open the crate (E) to reach your stash, gunsmith and upgrades.' : 'Deployed — 10 seconds of spawn protection.');
      lockPointer();
      break;
    case 'events':
      state.drops = m.drops;
      syncDrops();
      if (m.announce) toast('📦 Supply drop inbound — salvage, parts, tech and a commendation. Check the map (M).');
      break;
    case 'contracts':
      state.contracts = m.list;
      renderTracker();
      break;
    case 'contact':
      state.contact = m;
      openContact();
      break;
    case 'boom': boomFx(m.x, m.y, m.z); break;
    case 'homexp': if (m.amount >= 5) xpPopup(m.amount, `Home: ${m.reason}`); break;
    case 'homeLevel': levelBanner(m.level, [{ name: HOME_LEVEL_TEXT[m.level - 1] }], 'STASH HOUSE LEVEL'); break;
    case 'claimed': toast('This is now your stash house. Open its stash for the gunsmith, upgrades and home level.'); break;
    case 'contractDone':
      toast(`✔ Contract complete: ${m.name} — ${Object.entries(m.reward).map(([k, v]) => `+${v} ${k === 'comms' ? 'commendations' : k}`).join(', ')}`);
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
function updateHud() {
  const me = state.me;
  if (!me) return;
  $('hpbar').style.width = `${(me.hp / me.maxHp) * 100}%`;
  $('hptext').textContent = `${Math.ceil(me.hp)} / ${me.maxHp}`;
  $('armorbar').style.width = me.maxArmor ? `${(me.armor / me.maxArmor) * 100}%` : '0%';
  $('armortext').textContent = me.maxArmor ? `ARMOR ${Math.ceil(me.armor)} / ${me.maxArmor}` : 'NO ARMOR';
  const w = me.inv[me.active];
  $('wname').textContent = w ? `${w.name}${w.parts?.muzzle === 'suppressor' ? ' · suppressed' : ''}` : 'Unarmed';
  $('mag').textContent = me.mag;
  $('reserve').textContent = me.ammo;
  const medkits = me.inv.pack.filter((i) => i.kind === 'medkit').length;
  $('wextra').textContent = `${me.reloading ? 'RELOADING… · ' : ''}Medkits ${medkits} · Kills ${me.kills}`;
  $('housestatus').textContent = me.claim ? `⌂ ${me.claim.name} · Lv${me.claim.level}` : 'No stash house — plant a claim marker';
  $('resources').innerHTML = `<span title="Build guns and armor">⚙ ${me.parts}</span><span title="Powers gadgets">⌁ ${me.tech}</span><span title="Stash upgrades, building">⛭ ${me.salvage} salvage</span><span title="Building: chop trees with a hatchet">🪵 ${me.wood}</span><span title="Building: mine rocks with a pickaxe">⛰ ${me.stone}</span><span title="Bank at your stash for XP — lost if you die">▣ ${me.intel} intel</span><span title="Field gear at Contacts (never lost)">★ ${me.comms}</span>`;
  const lo = xpForLevel(me.level), hi = xpForLevel(me.level + 1);
  $('level').textContent = `LEVEL ${me.level}`;
  $('xpbar').style.width = me.level >= MAX_LEVEL ? '100%' : `${((me.xp - lo) / (hi - lo)) * 100}%`;
  $('xptext').textContent = me.level >= MAX_LEVEL ? `${me.xp} XP · max level` : `${me.xp - lo} / ${hi - lo} XP`;
}

function statLine(item) {
  if (item.kind === 'tool') return TOOLS[item.tool]?.desc || '';
  if (item.kind === 'charge') return CRAFTS.charge.desc;
  if (item.kind === 'marker') return CRAFTS.marker.desc;
  if (item.kind === 'package') return 'Contract crate — deliver to any Contact';
  if (item.kind === 'weapon') {
    const s = weaponStats(item);
    return `${Math.round(s.damage)}${s.pellets > 1 ? `×${s.pellets}` : ''} dmg · ${Math.round(s.rpm)} rpm · ${s.mag} mag · ${Math.round(s.range)} m`;
  }
  if (item.kind === 'armor') { const a = armorStats(item); return `Armor ${a.armor}${a.mobility ? ` · ${Math.round(a.mobility * 100)}% speed` : ''}`; }
  if (item.kind === 'medkit') return 'Restores 60 health and 40 armor';
  return '';
}

function attachmentLine(item) {
  if (item.kind !== 'weapon') return '';
  const mods = SLOTS.map((sl) => item.parts?.[sl]).filter((id) => id && PARTS[id] && PARTS[id].level > 1).map((id) => PARTS[id].name);
  return mods.length ? mods.join(' · ') : 'Stock configuration';
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

function equippedFor(item) {
  const inv = state.me.inv;
  if (item.kind === 'armor') return inv.armor;
  if (item.kind === 'weapon') return item.archetype === 'sidearm' ? inv.secondary : inv.primary;
  return undefined;
}

function renderInventory() {
  const me = state.me;
  if (!me) return;
  const inv = me.inv;
  const eq = $('equipped'); eq.innerHTML = '';
  for (const slot of ['primary', 'secondary', 'armor']) {
    eq.append(itemCard(inv[slot], { slot, buttons: inv[slot] ? [['Unequip', () => send({ t: 'inv', action: 'unequip', slot })]] : [] }));
  }
  const pack = $('pack'); pack.innerHTML = '';
  $('packcount').textContent = `(${inv.pack.length}/${state.packSize}) · ammo ${me.ammo} · parts ${me.parts}`;
  const c = state.container;
  if (!inv.pack.length) pack.innerHTML = '<div class="empty">Empty</div>';
  for (const item of inv.pack) {
    const buttons = [];
    if (item.kind === 'weapon' || item.kind === 'armor') buttons.push(['Equip', () => send({ t: 'inv', action: 'equip', itemId: item.id })]);
    if (item.kind === 'medkit') buttons.push(['Use', () => send({ t: 'inv', action: 'use' })]);
    if (c?.canPut) buttons.push(['Stash →', () => send({ t: 'container', action: 'put', itemId: item.id })]);
    buttons.push(['Drop', () => send({ t: 'inv', action: 'drop', itemId: item.id })]);
    pack.append(itemCard(item, { buttons }));
  }
  $('containerCol').hidden = !c;
  if (c) {
    $('containerTitle').textContent = `${c.title}${c.cap ? ` (${c.items.length}/${c.cap})` : ''}`;
    const box = $('container'); box.innerHTML = '';
    if (c.gunsmith) {
      const bar = document.createElement('div');
      bar.className = 'gsentry';
      bar.innerHTML = `<button id="openGs">Open Gunsmith</button><button id="bankIntel" ${me.intel + (c.intel || 0) ? '' : 'disabled'}>Upload ${me.intel + (c.intel || 0)} intel (+${(me.intel + (c.intel || 0)) * 40} XP)</button>`;
      box.append(bar);
      bar.querySelector('#openGs').onclick = openGunsmith;
      bar.querySelector('#bankIntel').onclick = () => send({ t: 'container', action: 'bank' });
    }
    if (c.gunsmith) {
      const tr = document.createElement('div');
      tr.className = 'gsentry';
      tr.append(btn('Fast travel…', () => { closeInventory(); openMapScreen('travel'); }));
      box.append(tr);
    }
    if (c.home) box.append(homePanel(c));
    if (c.upg) box.append(upgradePanel(c));
    if (c.craft) box.append(craftPanel(c));
    if (c.canPut) {
      const dep = document.createElement('div');
      dep.className = 'gsentry';
      for (const r of ['parts', 'tech', 'salvage', 'ammo']) {
        if (!me[r]) continue;
        const b = document.createElement('button');
        b.className = 'ghost'; b.textContent = `Deposit ${me[r]} ${r}`;
        b.onclick = () => send({ t: 'container', action: 'put', res: r });
        dep.append(b);
      }
      if (dep.children.length) box.append(dep);
    }
    const label = { parts: 'parts', tech: 'tech', intel: 'intel drives', ammo: 'rounds', salvage: 'salvage' };
    for (const r of ['parts', 'tech', 'salvage', 'intel', 'ammo']) {
      if (c[r]) box.append(itemCard({ kind: r, name: `${c[r]} ${label[r]}` }, { buttons: [['← Take', () => send({ t: 'container', action: 'take', res: r })]] }));
    }
    if (!c.items.length && !['parts', 'tech', 'salvage', 'intel', 'ammo'].some((r) => c[r])) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Empty' }));
    for (const item of c.items) box.append(itemCard(item, { buttons: [['← Take', () => send({ t: 'container', action: 'take', itemId: item.id })]] }));
  }
}

function openInventory() {
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
  const names = { salvage: 'salvage', parts: 'parts', tech: 'tech', comms: '★' };
  return Object.entries(cost).map(([k, v]) => `${v} ${names[k]}`).join(' · ');
}
/** Stash house level: XP bar, current perks, what the next level unlocks, abandon. */
function homePanel(c) {
  const h = c.home;
  const wrap = document.createElement('div');
  wrap.className = 'upgrades';
  const lo = HOME_LEVEL_XP[h.level - 1], hi = HOME_LEVEL_XP[h.level] ?? lo;
  const pct = h.level >= MAX_HOME_LEVEL ? 100 : ((h.xp - lo) / (hi - lo)) * 100;
  const next = homePerks(Math.min(MAX_HOME_LEVEL, h.level + 1));
  wrap.innerHTML = `<h2>${h.name} — home level ${h.level}</h2>
    <div class="bar homexp"><div class="fill xpfill" style="width:${pct}%"></div><span>${h.level >= MAX_HOME_LEVEL ? 'Max level' : `${h.xp - lo} / ${hi - lo} home XP`}</span></div>
    <div class="st" style="margin:6px 0">Now: +${h.perks.storage} slots · door ×${h.perks.doorMul.toFixed(2)} · ${h.perks.radius} m claim · ${h.perks.buildCap} structures.
    ${h.level < MAX_HOME_LEVEL ? `<br>Level ${h.level + 1}: ${HOME_LEVEL_TEXT[h.level]} · +${next.storage} slots · ${next.radius} m claim.` : ''}
    <br><small style="color:#888">Home XP: install upgrades, build inside your claim radius, upload intel here, and just hold it over time.</small></div>`;
  const ab = btn('Abandon this stash house', () => { if (confirm('Abandon your stash house? Anything left inside can be taken by anyone.')) send({ t: 'abandon' }); });
  wrap.append(ab);
  return wrap;
}
function upgradePanel(c) {
  const me = state.me;
  const wrap = document.createElement('div');
  wrap.className = 'upgrades';
  wrap.innerHTML = '<h2>Stash house upgrades</h2>';
  const have = (k) => (k === 'comms' ? me.comms : (me[k] || 0) + (c[k] || 0));
  for (const [key, u] of Object.entries(UPGRADES)) {
    const tier = c.upg[key] || 0;
    const next = u.tiers[tier + 1];
    const row = document.createElement('div');
    row.className = 'item';
    const hl = c.home?.level ?? 1;
    row.innerHTML = `<div class="meta"><div class="nm">${u.name} <small style="color:#888">${u.tiers[tier].label}</small></div><div class="st">${u.desc}</div>${next ? `<div class="at">Next: ${next.label} — ${costText(next.cost)}${hl < next.home ? ` · needs home level ${next.home}` : ''}</div>` : '<div class="at">Maxed</div>'}</div>`;
    if (next) {
      const ok = hl >= next.home && Object.entries(next.cost).every(([k, v]) => have(k) >= v);
      const b = btn('Install', () => send({ t: 'upgrade', track: key }));
      b.disabled = !ok;
      row.append(b);
    }
    wrap.append(row);
  }
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
function renderContact() {
  const c = state.contact, me = state.me;
  if (!c || !me) return;
  $('ctTitle').textContent = c.name;
  $('ctComms').textContent = `★ ${me.comms} commendations`;
  const offers = $('ctOffers'); offers.innerHTML = '';
  for (const o of c.offers) {
    const def = CONTRACT_TYPES[o.type];
    const d = Math.round(Math.hypot(o.x - state.x, o.z - state.z));
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${def.name} <small style="color:#888">${d} m away</small></div><div class="st">${def.desc}</div><div class="at">Reward: ${Object.entries(def.reward).map(([k, v]) => `${v} ${k === 'comms' ? '★' : k}`).join(' · ')} · ${def.xp} XP</div></div>`;
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
    row.innerHTML = `<div class="meta"><div class="nm">${CONTRACT_TYPES[ct.type].name}</div><div class="st">${Math.round(Math.hypot(ct.x - state.x, ct.z - state.z))} m · expires in ${Math.max(0, Math.round((ct.expires - Date.now()) / 60000))} min</div></div>`;
    row.append(btn('Abandon', () => send({ t: 'abandonContract', id: ct.id })));
    active.append(row);
  }
  // Quartermaster: field gear bought with commendations (earned only from contracts and events).
  const qm = $('ctShop'); qm.innerHTML = '';
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
    if (owned) row.insertAdjacentHTML('beforeend', '<small style="color:#5fd35f">OWNED</small>');
    else {
      const b = btn(`★ ${d.field}`, () => send({ t: 'requisition', contactId: c.id, kind, id }));
      b.disabled = me.comms < d.field || me.level < (d.level || 1);
      row.append(b);
    }
    qm.append(row);
  }
}

/** Active contracts shown under the kill feed. */
function renderTracker() {
  const el = $('tracker');
  el.innerHTML = state.contracts.map((c) => `<div>★ ${CONTRACT_TYPES[c.type].name} <span>${Math.round(Math.hypot(c.x - state.x, c.z - state.z))} m</span></div>`).join('');
}
setInterval(() => { if (state.map) renderTracker(); }, 1000);

// ------------------------------------------------------------------ map screen (M), deploy + fast travel
const mapView = { cx: 0, cz: 0, zoom: 1 };
function openMapScreen(mode, opts = null) {
  state.mapOpen = true;
  state.mapMode = mode;
  state.deployOpts = opts || state.deployOpts;
  $('mapscreen').hidden = false;
  document.exitPointerLock?.();
  if (mode === 'view' || mode === 'travel') { mapView.cx = state.x; mapView.cz = state.z; mapView.zoom = 2.5; }
  else { mapView.cx = 0; mapView.cz = 0; mapView.zoom = 1; }
  renderMapScreen();
}
function closeMapScreen() {
  state.mapOpen = false;
  $('mapscreen').hidden = true;
  if (state.mapMode === 'view' || state.mapMode === 'travel') lockPointer();
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
function mapOptions() {
  const map = state.map, o = state.deployOpts || {};
  const town = (h) => homeLabel(h);
  if (state.mapMode === 'first') {
    // First deploy: any real town, or a landing zone out in the wilds. You claim a stash house
    // afterwards by planting your claim marker.
    return [
      ...(o.towns || []).map((id) => ({ label: `🏙 ${map.towns[map.contacts[id].townId].name}${map.towns[map.contacts[id].townId].county ? ` (${map.towns[map.contacts[id].townId].county} Co.)` : ''}`, x: map.contacts[id].x, z: map.contacts[id].z, msg: { t: 'deploy', kind: 'contact', id }, color: '#ffd29a' })),
      ...map.landingZones.map((lz) => ({ label: `🪂 ${lz.name}`, x: lz.x, z: lz.z, msg: { t: 'deploy', kind: 'lz', id: lz.id }, color: '#e0e0e0' })),
    ];
  }
  if (state.mapMode === 'redeploy') {
    const list = [];
    if (o.claim) list.push({ label: `⌂ ${o.claim.name}`, x: o.claim.x, z: o.claim.z, msg: { t: 'deploy', kind: 'home' }, color: '#4fbf6a' });
    for (const id of o.contacts || []) list.push({ label: map.contacts[id].name, x: map.contacts[id].x, z: map.contacts[id].z, msg: { t: 'deploy', kind: 'contact', id }, color: '#7fd6ff' });
    for (const c of o.crates || []) list.push({ label: 'Your stash crate', x: c.x, z: c.z, msg: { t: 'deploy', kind: 'crate', id: c.id }, color: '#c9a36b' });
    for (const id of o.lzs || []) list.push({ label: map.landingZones[id].name, x: map.landingZones[id].x, z: map.landingZones[id].z, msg: { t: 'deploy', kind: 'lz', id }, color: '#e0e0e0' });
    return list;
  }
  if (state.mapMode === 'travel') {
    const list = (state.me?.discovered || []).map((id) => ({ label: map.contacts[id].name, x: map.contacts[id].x, z: map.contacts[id].z, msg: { t: 'travel', kind: 'contact', id }, color: '#7fd6ff' }));
    for (const m of state.squad.members) if (m.id !== state.id) list.push({ label: `Join ${m.name}`, x: m.x, z: m.z, msg: { t: 'travel', kind: 'squad', id: m.id }, color: '#7dff9a' });
    return list;
  }
  return [];
}
function renderMapScreen() {
  if (!state.mapOpen || !state.map) return;
  const titles = { first: 'Where do you want to start?', redeploy: state.killedBy ? `Killed by ${state.killedBy} — redeploy` : 'Deploy', travel: 'Fast travel (from your stash house)', view: 'Map' };
  const notes = {
    first: 'Pick where to start. Then find a place to call home and plant your claim marker in it: a town house or apartment room, a limestone cave, rock outcrop, hollow cypress, river fish camp, an abandoned RV, bus, box truck or houseboat — or plant it as a claim flag on open ground.',
    redeploy: 'You dropped everything you carried in a bag where you fell. Level, unlocks, commendations and your stash are safe. Deploy at your house, any Contact you\'ve discovered, or a landing zone.',
    travel: 'Fast travel only goes out from your stash house — getting loot home is still on foot.',
    view: 'Gold ◆ contracts · red ● supply drops · blue ✦ Contacts (dim = undiscovered) · green = home & squad.',
  };
  $('mapTitle').textContent = titles[state.mapMode];
  $('mapNote').textContent = notes[state.mapMode];
  const list = $('mapList'); list.innerHTML = '';
  const opts = mapOptions();
  for (const o of opts) {
    const b = btn(o.label, () => send(o.msg));
    b.className = 'gsweapon';
    b.onmouseenter = () => { state.mapHover = o; drawMapCanvas(); };
    list.append(b);
  }
  if (state.mapMode === 'view' || state.mapMode === 'travel') list.append(btn('Close', closeMapScreen));
  drawMapCanvas();
}
function drawMapCanvas() {
  const cv = $('mapcanvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const map = state.map, markers = [];
  const dim = new Set(state.me?.discovered || []);
  for (const c of map.contacts) markers.push({ x: c.x, z: c.z, kind: 'diamond', color: dim.has(c.id) ? '#7fd6ff' : '#3a5560', size: 5 });
  for (const lz of map.landingZones) markers.push({ x: lz.x, z: lz.z, color: '#cfcfcf', size: 4, label: state.mapMode === 'redeploy' ? lz.name : '' });
  for (const ct of state.contracts) markers.push({ x: ct.x, z: ct.z, kind: 'diamond', color: '#ffc53d', size: 7, label: CONTRACT_TYPES[ct.type].name });
  for (const d of state.drops) markers.push({ x: d.x, z: d.z, color: '#ff3b3b', size: 7, label: 'Supply drop' });
  for (const m of state.squad.members) if (m.id !== state.id) markers.push({ x: m.x, z: m.z, color: '#7dff9a', size: 5, label: m.name });
  for (const p of state.pings) if (p.objective) markers.push({ x: p.x, z: p.z, kind: 'diamond', color: '#ffc53d', size: 6, label: 'Objective' });
  const hpos = homePos();
  if (hpos) markers.push({ x: hpos.x, z: hpos.z, color: '#4fbf6a', size: 7, label: `Home (Lv${state.me.claim.level})` });
  for (const o of mapOptions()) { const hl = state.mapHover?.label === o.label; markers.push({ x: o.x, z: o.z, color: o.color, size: 6, highlight: hl, label: hl ? o.label : '' }); }
  if (state.me && !state.me.dead) markers.push({ x: state.x, z: state.z, kind: 'player', yaw: state.yaw, color: '#5aa8ff', size: 7 });
  state.mapProj = drawMap(cv, map, state.mapBase, mapView, markers);
}
$('mapcanvas').addEventListener('click', (e) => {
  if (!state.mapProj) return;
  const r = e.target.getBoundingClientRect();
  const w = state.mapProj.toWorld(e.clientX - r.left, e.clientY - r.top);
  // Pick the nearest option within ~20 px.
  let best = null, bd = 20 / state.mapProj.k;
  for (const o of mapOptions()) { const d = Math.hypot(o.x - w.x, o.z - w.z); if (d < bd) { bd = d; best = o; } }
  if (best) send(best.msg);
  else if (state.mapMode === 'first') {
    // Clicking a specific free house on the map claims that one.
    let bh = null, bhd = 30 / state.mapProj.k;
    for (const id of state.deployOpts?.freeHouses || []) { const hh = state.map.houses[id]; const d = Math.hypot(hh.x - w.x, hh.z - w.z); if (d < bhd) { bhd = d; bh = id; } }
    if (bh !== null) send({ t: 'deploy', kind: 'claim', id: bh });
  }
});
$('mapcanvas').addEventListener('wheel', (e) => { e.preventDefault(); mapView.zoom = Math.max(1, Math.min(16, mapView.zoom * (e.deltaY < 0 ? 1.25 : 0.8))); drawMapCanvas(); }, { passive: false });
let mapDrag = null;
$('mapcanvas').addEventListener('pointerdown', (e) => { mapDrag = { x: e.clientX, y: e.clientY, cx: mapView.cx, cz: mapView.cz }; });
addEventListener('pointerup', () => { mapDrag = null; });
addEventListener('pointermove', (e) => {
  if (!mapDrag || !state.mapProj) return;
  mapView.cx = mapDrag.cx - (e.clientX - mapDrag.x) / state.mapProj.k;
  mapView.cz = mapDrag.cz - (e.clientY - mapDrag.y) / state.mapProj.k;
  drawMapCanvas();
});
$('mapZoomIn').onclick = () => { mapView.zoom = Math.min(16, mapView.zoom * 1.5); drawMapCanvas(); };
$('mapZoomOut').onclick = () => { mapView.zoom = Math.max(1, mapView.zoom / 1.5); drawMapCanvas(); };

// ------------------------------------------------------------------ gunsmith
const gs = { selectedId: null, slot: 'optic', hover: null, explode: 0, explodeTarget: 0, model: null, modelKey: '' };
const gsRenderer = new THREE.WebGLRenderer({ canvas: $('gsview'), antialias: true, alpha: true, preserveDrawingBuffer: true });
gsRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const gsScene = new THREE.Scene();
const gsCamera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
gsScene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
const gsKey = new THREE.DirectionalLight(0xffffff, 2); gsKey.position.set(1, 2, 2); gsScene.add(gsKey);
const gsTurntable = new THREE.Group(); gsScene.add(gsTurntable);

function ownedWeapons() {
  const me = state.me, out = [];
  if (!me) return out;
  for (const slot of ['primary', 'secondary']) if (me.inv[slot]) out.push({ item: me.inv[slot], where: slot });
  for (const i of me.inv.pack) if (i.kind === 'weapon') out.push({ item: i, where: 'backpack' });
  if (state.container?.gunsmith) for (const i of state.container.items) if (i.kind === 'weapon') out.push({ item: i, where: 'stash' });
  return out;
}

function openGunsmith() {
  state.gunsmithOpen = true;
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
    · Range ${fmt(cur, nxt, (s) => Math.round(s.range), 'm')} · Reload ${fmt(cur, nxt, (s) => (s.reloadMs / 1000).toFixed(1), 's')} · Zoom ${fmt(cur, nxt, (s) => s.zoom.toFixed(1), 'x')}${nxt.suppressed ? ' · <b>Suppressed</b>' : ''}`;
}

function setPreviewModel(item) {
  const gun = item ? { a: item.archetype, parts: item.parts, paint: item.paint } : null;
  const key = gunKey(gun);
  if (key === gs.modelKey) return;
  gs.modelKey = key;
  gsTurntable.clear();
  gs.model = gun ? buildGunModel(gun) : null;
  if (gs.model) {
    // Center the assembled gun on the turntable.
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
  $('gsParts').textContent = `Level ${me.level} · ${totalParts} parts available (${me.parts} carried, ${state.container?.parts || 0} in stash)`;

  // Weapon list.
  const list = ownedWeapons();
  const wl = $('gsWeapons'); wl.innerHTML = '';
  for (const { item, where } of list) {
    const b = document.createElement('button');
    b.className = 'gsweapon' + (item.id === gs.selectedId ? ' sel' : '');
    b.innerHTML = `<b>${item.name}</b><small>${where}</small>`;
    b.onclick = () => { gs.selectedId = item.id; gs.hover = null; renderGunsmith(); };
    wl.append(b);
  }
  if (!list.length) wl.innerHTML = '<div class="empty">No weapons — build one below.</div>';

  // Blueprints (build new platforms / armor from parts).
  const bp = $('gsBuild'); bp.innerHTML = '';
  const discount = UPGRADES.workbench.tiers[state.container?.upg?.workbench || 0].discount;
  const blueprint = (label, def, id, action, type) => {
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
    bp.append(row);
  };
  for (const [k, a] of Object.entries(ARCHETYPES)) blueprint(a.label, a, k, 'build', k);
  for (const [k, a] of Object.entries(ARMORS)) blueprint(`${a.name} (armor ${a.armor})`, a, k, 'buildArmor', k);

  const item = list.find((w) => w.item.id === gs.selectedId)?.item;
  $('gsTitle').textContent = item ? item.name : 'Gunsmith';
  setPreviewModel(item ? previewItem(item, gs.hover) : null);
  const slotsEl = $('gsSlots'); slotsEl.innerHTML = '';
  const opts = $('gsOptions'); opts.innerHTML = '';
  if (!item) { $('gsStats').innerHTML = ''; $('gsNumbers').innerHTML = ''; return; }
  renderStatBars(item, previewItem(item, gs.hover));

  for (const slot of [...SLOTS, 'paint']) {
    const cur = slot === 'paint' ? PAINTS[item.paint]?.name : PARTS[item.parts[slot]]?.name;
    const anyFit = slot === 'paint' || Object.entries(PARTS).some(([id, p]) => p.slot === slot && partFits(id, item.archetype) && p.level > 1);
    const b = document.createElement('button');
    b.className = 'gsslot' + (gs.slot === slot ? ' sel' : '');
    b.innerHTML = `<small>${SLOT_LABELS[slot]}</small><b>${anyFit ? cur : '—'}</b>`;
    b.disabled = !anyFit;
    b.onclick = () => { gs.slot = slot; gs.hover = null; renderGunsmith(); };
    slotsEl.append(b);
  }

  const option = (label, def, id, equipped, hover, onPick) => {
    const b = document.createElement('button');
    const locked = !isUnlocked(def, id, me);
    b.className = 'gsopt' + (equipped ? ' sel' : '') + (locked ? ' locked' : '');
    b.innerHTML = `${def.field ? '★ ' : ''}${label}${locked ? `<small>${lockLabel(def)}</small>` : equipped ? '<small>equipped</small>' : ''}`;
    b.onmouseenter = () => { gs.hover = hover; setPreviewModel(previewItem(item, hover)); renderStatBars(item, previewItem(item, hover)); setExplode(gs.model, gs.explode, gs.slot); };
    b.onmouseleave = () => { gs.hover = null; setPreviewModel(item); renderStatBars(item, item); };
    if (!locked && !equipped) b.onclick = onPick;
    opts.append(b);
  };
  if (gs.slot === 'paint') {
    for (const [id, p] of Object.entries(PAINTS)) {
      option(`<i class="swatch" style="background:${p.color}"></i>${p.name}`, p, id, item.paint === id, { paint: id }, () => send({ t: 'gunsmith', action: 'paint', itemId: item.id, paint: id }));
    }
  } else {
    for (const [id, p] of Object.entries(PARTS)) {
      if (p.slot !== gs.slot || !partFits(id, item.archetype)) continue;
      option(p.name, p, id, item.parts[gs.slot] === id, { slot: gs.slot, partId: id }, () => send({ t: 'gunsmith', action: 'attach', itemId: item.id, slot: gs.slot, partId: id }));
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
function doAction(a) {
  if (!state.me) return;
  switch (a) {
    case 'squadPanel': if (state.panelOpen) closeSquadPanel(); else openSquadPanel(); return;
    case 'map':
      if (state.mapOpen && (state.mapMode === 'view' || state.mapMode === 'travel')) closeMapScreen();
      else if (!state.mapOpen && !state.me.dead) openMapScreen('view');
      return;
    case 'inventory':
      if (state.me.dead) return;
      if (state.invOpen) { state.gunsmithOpen = false; $('gunsmith').hidden = true; closeInventory(); lockPointer(); } else openInventory();
      return;
  }
  if (state.me.dead || state.invOpen || state.panelOpen || state.mapOpen || state.contactOpen) return;
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
    case 'interact': send({ t: 'interact' }); break;
    case 'tag': if (state.aimTargetId) send({ t: 'mark', id: state.aimTargetId }); break;
    case 'sensor': { const p = aimPoint(); send({ t: 'sensor', x: p.x, z: p.z }); break; }
    case 'camo': send({ t: 'camo' }); break;
    case 'rally': send({ t: 'rally' }); break;
    case 'ping': { const p = aimPoint(); send({ t: 'squad', action: 'ping', x: p.x, z: p.z }); break; }
    case 'reload': send({ t: 'reload' }); break;
    case 'swap': send({ t: 'swap' }); break;
    case 'heal': send({ t: 'inv', action: 'use' }); break;
    case 'crouch': state.crouch = !state.crouch; break;
  }
}
$('join').onclick = () => {
  const name = $('name').value.trim() || 'Agent';
  localStorage.setItem('dz_name', name);
  connect(name);
};
$('name').value = localStorage.getItem('dz_name') || '';
{
  // Login-screen controller help. Gamepads only exist on HTTPS/localhost pages.
  const hint = $('padhint');
  if (!window.isSecureContext) {
    hint.innerHTML = '<b style="color:#ff8a2a">Controllers need HTTPS.</b> This page is plain HTTP, so the browser hides gamepads. Open it over HTTPS (see README) to use a Backbone One or other controller.';
  } else {
    hint.innerHTML = '🎮 <b>Controller:</b> press any button on your Backbone One / gamepad. D-pad + A to pick Join.';
  }
  if (MOBILE) document.body.classList.add('mobile');
}
$('name').onkeydown = (e) => { if (e.key === 'Enter') $('join').click(); };

canvas.addEventListener('click', () => { if (state.me && !state.invOpen && !state.me.dead) lockPointer(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  setInputMode('kb');
  const sens = state.aiming ? 0.0022 * camera.fov / 70 : 0.0022;
  state.yaw -= e.movementX * sens;
  state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch - e.movementY * sens));
});
addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (e.button === 0) { state.mouseDown = true; state.firedThisPress = false; }
  if (e.button === 2) state.aiming = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) state.mouseDown = false;
  if (e.button === 2) state.aiming = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => {
  // Build mode: X toggles, 1-5 pick a piece.
  if (document.activeElement === $('name') || !state.me) return;
  if (e.code === 'KeyX' && !e.repeat) doAction('build');
  if (build.on && /^Digit[1-6]$/.test(e.code)) { build.piece = Object.keys(PIECES)[Number(e.code.slice(5)) - 1]; renderBuildBar(); e.stopImmediatePropagation(); }
}, true);
addEventListener('wheel', (e) => { if (build.on && document.pointerLockElement === canvas) build.rot ^= 1; });
const KEY_ACTIONS = {
  KeyE: 'interact', KeyF: 'tag', KeyG: 'sensor', KeyV: 'camo', KeyT: 'rally', KeyB: 'ping', KeyR: 'reload',
  KeyQ: 'swap', Digit1: 'swap', Digit2: 'swap', KeyH: 'heal', KeyC: 'crouch', ControlLeft: 'crouch',
};
addEventListener('keydown', (e) => {
  if (document.activeElement === $('name')) return;
  setInputMode('kb');
  if (e.code === 'KeyP') { doAction('squadPanel'); return; }
  if (e.code === 'KeyM') { doAction('map'); return; }
  if (e.code === 'Escape' && state.contactOpen) { closeContact(); return; }
  if (e.code === 'Escape' && state.mapOpen && (state.mapMode === 'view' || state.mapMode === 'travel')) { closeMapScreen(); return; }
  if (e.code === 'Escape' && state.panelOpen) { closeSquadPanel(); return; }
  if (e.code === 'Tab' || e.code === 'KeyI') { e.preventDefault(); doAction('inventory'); return; }
  if (e.code === 'Escape' && state.gunsmithOpen) { closeGunsmith(); return; }
  if (e.code === 'Escape' && state.invOpen) { closeInventory(); return; }
  state.keys.add(e.code);
  if (e.repeat) return;
  if (KEY_ACTIONS[e.code]) doAction(KEY_ACTIONS[e.code]);
});
addEventListener('keyup', (e) => state.keys.delete(e.code));
addEventListener('blur', () => { state.keys.clear(); state.mouseDown = false; state.aiming = false; });

// ------------------------------------------------------------------ simulation helpers
function structSolid(sv) { const st = sv.data; const mat = PIECES[st.type].stages[st.stage].material; return mat !== 'frame' && !PIECES[st.type].explosive && !(PIECES[st.type].door && st.open); }
function structBoxOf(st) { return { ...pieceBox(st.type, st.x, st.z, st.rot, st.y0), type: 'struct', structId: st.id }; }
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

function lookDir() {
  return new THREE.Vector3(Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), Math.cos(state.yaw) * Math.cos(state.pitch));
}

function eyeHeight() { return ground(state.x, state.z) + (state.crouch ? CROUCH_EYE : STAND_EYE); }

/** Raycast from the camera through the crosshair and return the world point it lands on. */
function aimPoint() {
  const o = camera.position, d = lookDir();
  let best = rayAgainstBoxes(o.x, o.y, o.z, d.x, d.y, d.z, solidsAlongRay(o.x, o.z, d.x, d.z, 400), 400).t;
  best = Math.min(best, state.map.terrain.ray(o.x, o.y, o.z, d.x, d.y, d.z, Math.min(best, 400)));
  const minT = o.distanceTo(new THREE.Vector3(state.x, eyeHeight(), state.z));
  state.aimTargetId = null;
  const test = (c) => {
    if (!c || c.dead) return;
    const b = characterBounds(c.x, c.z, c.crouch, ground(c.x, c.z));
    const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t > minT && t < best) { best = t; state.aimTargetId = c.sq ? null : c.id; }
  };
  for (const [, r] of state.players) test(r.data);
  for (const [, r] of state.bots) test(r.data);
  if (best >= 400) best = 400;
  return o.clone().addScaledVector(d, best);
}

function tryFire(now) {
  const me = state.me;
  if (!me || me.dead || state.invOpen) return;
  const w = me.inv[me.active];
  if (!w) return;
  const s = weaponStats(w);
  const semi = s.semi;
  if (semi && state.firedThisPress) return;
  if (now - state.lastShot < 60000 / s.rpm) return;
  if (me.reloading) return;
  if (me.mag <= 0) { if (me.ammo > 0 && !state.autoReloadSent) { send({ t: 'reload' }); state.autoReloadSent = now; } return; }
  state.autoReloadSent = 0;
  const target = aimPoint();
  const eye = new THREE.Vector3(state.x, eyeHeight(), state.z);
  const dir = target.sub(eye).normalize();
  send({ t: 'shoot', dir: [dir.x, dir.y, dir.z] });
  state.lastShot = now;
  state.firedThisPress = true;
  me.mag -= 1;                          // predicted; server confirms via 'you'
  $('mag').textContent = me.mag;
  // Recoil comes from the gunsmith build: stocks, grips, muzzles and bipods all change it.
  state.recoil += s.recoil * (state.crouch ? s.crouchRecoil : 1) * (state.aiming ? 0.85 : 1) * (0.8 + Math.random() * 0.4);
}

function nearestInteractable() {
  let best = null, bestD = INTERACT_RANGE;
  const consider = (d, text) => { if (d < bestD) { bestD = d; best = text; } };
  for (const [, l] of state.loot) consider(Math.hypot(l.data.x - state.x, l.data.z - state.z), `Pick up ${l.data.name}${l.data.amount ? ` (+${l.data.amount})` : ''}`);
  for (const [, b] of state.bags) consider(Math.hypot(b.data.x - state.x, b.data.z - state.z), `Search ${b.data.label}`);
  for (const [id, ready] of state.termState) { const t = state.map.terminals[id]; consider(Math.hypot(t.x - state.x, t.z - state.z), ready ? 'Hack terminal (stand still 5s) — intel + tech' : 'Terminal rebooting'); }
  for (const c of state.map.contacts) if (Math.abs(c.x - state.x) < 5 && Math.abs(c.z - state.z) < 5) consider(Math.hypot(c.x - state.x, c.z - state.z) - 0.8, `Talk to ${c.name} — contracts & field gear`);
  for (const d of state.drops) consider(Math.hypot(d.x - state.x, d.z - state.z) - 0.6, d.landsAt > Date.now() ? 'Supply drop incoming…' : 'Open supply drop (6s)');
  for (const o of state.objectives) consider(Math.hypot(o.x - state.x, o.z - state.z) - 0.5, 'Recover contract crate (3s)');
  const me = state.me;
  const has = (t) => me?.inv.pack.some((i) => i.kind === 'tool' && i.tool === t);
  for (const sv of structVis.values()) {
    const st = sv.data, def = PIECES[st.type], stage = def.stages[st.stage];
    if (def.explosive) continue;
    const d = Math.hypot(Math.max(structBoxOf(st).minX - state.x, 0, state.x - structBoxOf(st).maxX), Math.max(structBoxOf(st).minZ - state.z, 0, state.z - structBoxOf(st).maxZ)) + 0.3;
    let text;
    const next = def.stages[st.stage + 1];
    const hp = ` <small>${st.hp}/${st.max} HP</small>`;
    if (st.mine) {
      if (build.on) text = next ? `Upgrade to ${next.name} (${Object.entries(next.cost).map(([k, v]) => `${v} ${k}`).join(', ')})${has('hammer') ? '' : ' — needs a hammer'}` : `${stage.name} — fully built`;
      else if (def.container) text = `Open ${stage.name.toLowerCase()}`;
      else if (def.door && st.stage > 0) text = st.open ? 'Close gate' : 'Open gate';
      else text = `${stage.name}${next ? ' — press X for build mode to upgrade' : ''}`;
    } else if (def.container) text = `Search ${st.owner}'s crate`;
    else if (stage.material === 'frame') text = `${st.owner}'s ${stage.name.toLowerCase()}`;
    else text = stage.material === 'stone' ? (has('pickaxe') ? `Break ${st.owner}'s ${stage.name.toLowerCase()} (pickaxe)` : `${st.owner}'s ${stage.name.toLowerCase()} — needs a pickaxe or breach charge`) : (has('hatchet') || has('pickaxe') ? `Chop through ${st.owner}'s ${stage.name.toLowerCase()}` : `${st.owner}'s ${stage.name.toLowerCase()} — needs a hatchet`);
    consider(d, text + hp);
  }
  for (const [id, hs] of state.houseState) {
    const h = state.map.houses[id];
    const own = id === state.houseId;
    const hasMarker = state.me?.inv.pack.some((i) => i.kind === 'marker');
    const claimText = state.me?.claim ? `Unclaimed ${homeKindName(h).toLowerCase()} (you already have a stash house)` : hasMarker ? `Plant claim marker — make this ${homeKindName(h).toLowerCase()} your stash house (8s)` : `Unclaimed ${homeKindName(h).toLowerCase()} — needs a claim marker`;
    const lockedVehicle = h.kind === 'vehicle' && hs.owner && !own && hs.hp > 0 && !hs.open;
    consider(Math.hypot(h.crate.x - state.x, h.crate.z - state.z) - 0.3, !hs.owner ? claimText : own ? `Open your stash · gunsmith · upgrades (home Lv${hs.hl})` : lockedVehicle ? `${hs.owner}'s ${homeKindName(h).toLowerCase()} — locked` : `Loot ${hs.owner}'s stash`);
    const d = h.door;
    if (!hs.owner) { consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), claimText); continue; }
    const squadHouse = !own && hs.owner && state.squad.members.some((m) => m.name === hs.owner);
    const lockText = (state.me?.level ?? 1) >= GADGETS.doorHack.level ? `Hack lock (${GADGETS.doorHack.cost} tech, 8s)` : `Locked — shoot it down (hack at lvl ${GADGETS.doorHack.level})`;
    const doorText = own || squadHouse ? (hs.hp <= 0 ? (own ? 'Rebuild door' : 'Doorway (breached)') : hs.open ? 'Close door' : 'Open door') : (hs.hp <= 0 ? 'Doorway (breached)' : hs.open ? 'Doorway (open)' : `${lockText} · ${Math.round(hs.hp / hs.max * 100)}%`);
    consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), doorText);
  }
  if (!best) {
    for (const b of state.map.grid.near(state.x, state.z, 2.5)) {
      const wood = b.type === 'tree' || b.type === 'pine', stone = b.type === 'rock' || b.type === 'boulder';
      if (!wood && !stone) continue;
      const tool = wood ? 'hatchet' : 'pickaxe';
      const d = Math.hypot(Math.max(b.minX - state.x, 0, state.x - b.maxX), Math.max(b.minZ - state.z, 0, state.z - b.maxZ)) + 0.6;
      consider(d, has(tool) ? (wood ? 'Chop tree for wood (3s)' : 'Mine rock for stone (3s)') : `${wood ? 'Tree' : 'Rock'} — needs a ${tool}`);
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

/** Through-wall HUD markers: tagged/sensed enemies, squadmates, pings, plus hack progress. */
function drawMarkers() {
  for (const el of markerEls.values()) el.dataset.seen = '';
  const now = performance.now();
  if (state.map && state.me) {
    for (const [id, e] of state.exposed) {
      if (e.until < now) { state.exposed.delete(id); continue; }
      const c = state.players.get(id)?.data || state.bots.get(id)?.data;
      if (!c || c.dead) continue;
      const d = Math.hypot(c.x - state.x, c.z - state.z);
      marker(`x${id}`, e.kind === 'mark' ? 'tag' : 'sensed', e.kind === 'mark' ? `◆ ${Math.round(d)}m` : '●', new THREE.Vector3(c.x, ground(c.x, c.z) + (c.crouch ? 1.2 : 1.8) + 0.5, c.z));
    }
    for (const [id, r] of state.players) {
      if (!r.data.sq || r.data.dead) continue;
      marker(`s${id}`, 'squad', `▼ ${r.data.name}`, new THREE.Vector3(r.data.x, ground(r.data.x, r.data.z) + 2.6, r.data.z));
    }
    state.pings = state.pings.filter((p) => p.until > now);
    state.pings.forEach((p, i) => marker(`p${i}`, p.objective ? 'objective' : 'ping', `${p.objective ? '★ OBJECTIVE' : `◎ ${p.from}`} · ${Math.round(Math.hypot(p.x - state.x, p.z - state.z))}m`, new THREE.Vector3(p.x, ground(p.x, p.z) + 1.5, p.z)));
    for (const ct of state.contracts) marker(`c${ct.id}`, 'objective', `◆ ${CONTRACT_TYPES[ct.type].name} · ${Math.round(Math.hypot(ct.x - state.x, ct.z - state.z))}m`, new THREE.Vector3(ct.x, ground(ct.x, ct.z) + 2.5, ct.z));
    for (const d of state.drops) marker(`d${d.id}`, 'alert', `📦 ${Math.round(Math.hypot(d.x - state.x, d.z - state.z))}m`, new THREE.Vector3(d.x, ground(d.x, d.z) + 3, d.z));
    const hh = homePos();
    if (hh) {
      const dh = Math.hypot(hh.x - state.x, hh.z - state.z);
      if (dh > 40) marker('home', 'squad', `⌂ Home ${Math.round(dh)}m`, new THREE.Vector3(hh.x, ground(hh.x, hh.z) + 4, hh.z));
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
    hb.querySelector('span').textContent = state.hack.kind === 'terminal' ? 'HACKING TERMINAL — hold still' : 'BYPASSING LOCK — hold still';
  } else hb.hidden = true;
}

function updateGadgetBar() {
  const me = state.me;
  if (!me) return;
  const lvl = me.level;
  const leader = state.squad.id && state.squad.leaderId === state.id;
  const now = Date.now();
  const items = [
    ['F', 'Tag', GADGETS.mark.level, ''],
    ['G', 'Sensor', GADGETS.sensor.level, me.sensorReadyAt > now ? 'cooldown' : me.tech < GADGETS.sensor.cost ? 'notech' : ''],
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

function renderSquadPanel() {
  const sq = state.squad;
  const leader = sq.id && sq.leaderId === state.id;
  const inv = $('sqInvite'); inv.innerHTML = '';
  if (state.invite) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${state.invite.fromName} invited you to their squad</div></div>`;
    row.append(btn('Accept', () => { send({ t: 'squad', action: 'accept' }); state.invite = null; renderSquadPanel(); }, ''),
      btn('Decline', () => { send({ t: 'squad', action: 'decline' }); state.invite = null; renderSquadPanel(); }));
    inv.append(row);
  }
  const mem = $('sqMembers'); mem.innerHTML = '';
  if (!sq.id) mem.innerHTML = '<div class="empty">Solo. Invite players below — squads share tags, sensors, XP and stash access, and can\'t shoot each other.</div>';
  for (const m of sq.members) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${m.id === sq.leaderId ? '★ ' : ''}${m.name} <small style="color:#888">lvl ${m.level}${m.id === state.id ? ' · you' : ''}</small></div></div>`;
    if (leader && m.id !== state.id) row.append(btn('Make leader', () => send({ t: 'squad', action: 'promote', id: m.id })), btn('Kick', () => send({ t: 'squad', action: 'kick', id: m.id })));
    if (m.id === state.id) row.append(btn('Leave', () => send({ t: 'squad', action: 'leave' })));
    mem.append(row);
  }
  const on = $('sqOnline'); on.innerHTML = '';
  const others = [...state.players.values()].map((r) => r.data).filter((p) => !p.sq);
  if (!others.length) on.innerHTML = '<div class="empty">Nobody else nearby is online.</div>';
  for (const p of others) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${p.name} <small style="color:#888">lvl ${p.level}</small></div></div>`;
    if (!sq.id || leader) row.append(btn('Invite', () => send({ t: 'squad', action: 'invite', id: p.id })));
    on.append(row);
  }
  const lb = $('sqBoard');
  lb.innerHTML = `<tr><th>#</th><th>Agent</th><th>Level</th><th>XP</th><th>Kills</th></tr>` +
    (state.leaderboard || []).map((r, i) => `<tr class="${r.online ? 'online' : ''}"><td>${i + 1}</td><td>${r.name}</td><td>${r.level}</td><td>${r.xp}</td><td>${r.kills}</td></tr>`).join('');
}

// ------------------------------------------------------------------ controller (Backbone One / any standard gamepad)
// Uses the browser Gamepad API "standard" layout, which is what the Backbone One reports on
// iPhone (MFi) and Android. Note: browsers only expose gamepads on HTTPS (or localhost) pages,
// and only after a button has been pressed.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS = {
  [BTN.A]: 'interact', [BTN.B]: 'crouch', [BTN.X]: 'reload', [BTN.Y]: 'swap', [BTN.LB]: 'sensor', [BTN.RB]: 'tag',
  [BTN.R3]: 'camo', [BTN.UP]: 'heal', [BTN.DOWN]: 'ping', [BTN.LEFT]: 'rally', [BTN.RIGHT]: 'build',
  [BTN.VIEW]: 'inventory', [BTN.MENU]: 'map',
};
const GLYPHS = { E: 'A', R: 'X', Q: 'Y', G: 'LB', F: 'RB', V: 'R3', T: '◀', B: '▼', H: '▲', P: '☰', X: '▶', LMB: 'RT' };
const pad = { prev: [], moveX: 0, moveY: 0, sprint: false, navAt: 0, settings: { lookSpeed: 2.6, invertY: false } };
function glyph(k) { return state.inputMode === 'pad' ? (GLYPHS[k] || k) : k; }

function setInputMode(m) {
  if (state.inputMode === m) return;
  state.inputMode = m;
  document.body.classList.toggle('pad', m === 'pad');
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
  for (const id of ['mapscreen', 'contactpanel', 'gunsmith', 'squadpanel', 'inventory', 'login']) if (!$(id).hidden) return $(id);
  return null;
}
function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]):not(.nopad), input')].filter((el) => el.offsetParent !== null);
}
function padFocus(el) {
  const prev = document.activeElement;
  if (prev && prev !== el) { prev.classList.remove('padfocus'); prev.dispatchEvent(new MouseEvent('mouseleave')); }
  el.classList.add('padfocus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.dispatchEvent(new MouseEvent('mouseenter'));   // drives gunsmith previews and map highlights
}
/** Spatial menu navigation: move to the nearest control in the pushed direction. */
function moveFocus(root, dx, dy) {
  const list = focusables(root);
  if (!list.length) return;
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
function padBack() {
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
  if (g.buttons.some((x) => x.pressed) || ax.some((v) => Math.abs(v) > 0.4)) setInputMode('pad');
  if (state.inputMode !== 'pad') { pad.prev = g.buttons.map((x) => x.pressed); return; }

  const panel = topPanel();
  if (panel) {
    // Menu mode: D-pad / left stick to move focus, A to select, B to go back, right stick scrolls.
    pad.moveX = pad.moveY = 0;
    state.mouseDown = false; state.aiming = false;
    const sx = deadzone(ax[0], 0.5), sy = deadzone(ax[1], 0.5);
    const dir = b(BTN.UP) || sy < 0 ? [0, -1] : b(BTN.DOWN) || sy > 0 ? [0, 1] : b(BTN.LEFT) || sx < 0 ? [-1, 0] : b(BTN.RIGHT) || sx > 0 ? [1, 0] : null;
    const navPressed = [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT].some(just);
    if (dir && (navPressed || now > pad.navAt)) { moveFocus(panel, dir[0], dir[1]); pad.navAt = now + (navPressed ? 380 : 160); }
    if (!dir) pad.navAt = 0;
    const scroller = panel.id === 'gunsmith' ? panel.querySelector('.gsgrid aside:last-child') : panel;
    if (scroller) scroller.scrollTop += deadzone(ax[3]) * 600 * dt;
    if (just(BTN.A)) {
      const el = document.activeElement;
      if (el && panel.contains(el) && el.tagName === 'BUTTON') {
        const idx = focusables(panel).indexOf(el);
        el.click();
        // Panels re-render after most actions; put focus back where it was.
        setTimeout(() => { const p = topPanel(); if (!p) return; const l = focusables(p); if (l.length && !l.includes(document.activeElement)) padFocus(l[Math.min(idx, l.length - 1)]); }, 150);
      } else if (!el || !panel.contains(el)) moveFocus(panel, 0, 1);
    }
    if (just(BTN.B)) padBack();
    if (just(BTN.Y) && state.gunsmithOpen) $('gsExplode').click();
    if (just(BTN.VIEW) && !['login', 'mapscreen'].includes(panel.id)) doAction('inventory');
    if (just(BTN.MENU) && panel.id === 'mapscreen') doAction('map');
    if (panel.id === 'mapscreen') { mapView.zoom = Math.max(1, Math.min(16, mapView.zoom * (1 + (val(BTN.RT) - val(BTN.LT)) * dt * 2))); if (val(BTN.RT) + val(BTN.LT) > 0.05) drawMapCanvas(); }
  } else if (state.me && !state.me.dead) {
    // Gameplay.
    pad.moveX = deadzone(ax[0]);
    pad.moveY = -deadzone(ax[1]);
    if (just(BTN.L3)) pad.sprint = !pad.sprint;
    if (Math.hypot(pad.moveX, pad.moveY) < 0.2) pad.sprint = false;
    // Look: response curve for fine aim, slower while aiming down sights, light aim slowdown over targets.
    aimPoint();
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 1.8;
    const lx = curve(deadzone(ax[2], 0.12)), ly = curve(deadzone(ax[3], 0.12));
    const zoomScale = state.aiming ? camera.fov / 70 : 1;
    const slow = state.aimTargetId ? 0.5 : 1;
    const speed = pad.settings.lookSpeed * zoomScale * slow;
    state.yaw -= lx * speed * dt;
    state.pitch = Math.max(-1.2, Math.min(1.2, state.pitch - ly * speed * 0.75 * dt * (pad.settings.invertY ? -1 : 1)));
    state.aiming = val(BTN.LT) > 0.35;
    const firing = val(BTN.RT) > 0.35;
    if (firing && !state.mouseDown) state.firedThisPress = false;
    state.mouseDown = firing;
    for (const [i, action] of Object.entries(PAD_ACTIONS)) if (just(Number(i))) doAction(action);
  }
  pad.prev = g.buttons.map((x) => x.pressed);
}

// Panels opened by controller get an initial focus so A works immediately.
new MutationObserver(() => {
  if (state.inputMode !== 'pad') return;
  const p = topPanel();
  if (p && !p.contains(document.activeElement)) { const l = focusables(p); if (l.length) padFocus(l.find((el) => el.tagName === 'BUTTON') || l[0]); }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

$('openSquadBtn').onclick = () => { closeInventory(); openSquadPanel(); };
$('openMapBtn').onclick = () => { closeInventory(); openMapScreen('view'); };

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
  const b = pieceBox(st.type, st.x, st.z, st.rot, st.y0);
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
  scene.add(g);
  return g;
}
function syncStructs(list) {
  const seen = new Set();
  for (const st of list) {
    seen.add(st.id);
    const key = `${st.stage}`;
    let v = structVis.get(st.id);
    if (v && v.key !== key) { scene.remove(v.mesh); v = null; }
    if (!v) { v = { mesh: structMesh(st), key }; structVis.set(st.id, v); }
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
function boomFx(x, y, z) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 }));
  ball.position.set(x, y, z);
  scene.add(ball);
  const t0 = performance.now();
  const step = () => {
    const f = (performance.now() - t0) / 600;
    if (f >= 1) { scene.remove(ball); ball.geometry.dispose(); return; }
    ball.scale.setScalar(1 + f * 6);
    ball.material.opacity = 0.9 * (1 - f);
    requestAnimationFrame(step);
  };
  step();
  const d = Math.hypot(x - state.x, z - state.z);
  if (d < 40) state.recoil += 0.05 * (1 - d / 40);
}

function toggleBuild() {
  build.on = !build.on;
  $('buildbar').hidden = !build.on;
  document.body.classList.toggle('building', build.on);
  if (build.on) toast('Build mode: aim and place. Frames are cheap; upgrade them (E) to make them solid.');
  else if (build.ghost) { scene.remove(build.ghost); build.ghost = null; }
  renderBuildBar();
}
function cyclePiece(dir) {
  const keys = Object.keys(PIECES);
  build.piece = keys[(keys.indexOf(build.piece) + dir + keys.length) % keys.length];
  renderBuildBar();
}
function renderBuildBar() {
  const me = state.me;
  if (!me) return;
  const items = Object.entries(PIECES).map(([k, p]) => {
    const st = p.stages[0];
    const cost = p.explosive ? `${me.inv.pack.filter((i) => i.kind === 'charge').length} carried` : Object.entries(st.cost).map(([r, v]) => `${v} ${r}`).join(' ') + (p.claim ? ' + marker' : '');
    return `<div class="bpiece ${k === build.piece ? 'sel' : ''}"><kbd>${p.key}</kbd>${p.name}<small>${cost}</small></div>`;
  }).join('');
  const pad = state.inputMode === 'pad';
  $('buildbar').innerHTML = `<div class="pieces">${items}</div><div class="bhint">${pad
    ? 'LB/RB piece · X rotate · RT place · A upgrade · Y dismantle · ▶ exit'
    : '1-5 piece · R / wheel rotate · Click place · E upgrade · Q dismantle · X exit'}${me.inv.pack.some((i) => i.tool === 'hammer') ? '' : ' · <b style="color:#ff6b6b">You need a hammer</b>'}</div>`;
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
function craftPanel(c) {
  const me = state.me;
  const wrap = document.createElement('div');
  wrap.className = 'upgrades';
  wrap.innerHTML = '<h2>Craft tools</h2>';
  const have = (k) => (me[k] || 0) + (c[k] || 0);
  for (const [key, d] of Object.entries(CRAFTS)) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="meta"><div class="nm">${d.name}</div><div class="st">${TOOLS[key]?.desc || d.desc || ''}</div><div class="at">${Object.entries(d.cost).map(([k, v]) => `${v} ${k}`).join(' · ')}${me.level < d.level ? ` · needs level ${d.level}` : ''}</div></div>`;
    const b = btn('Craft', () => send({ t: 'craft', item: key }));
    b.disabled = me.level < d.level || !Object.entries(d.cost).every(([k, v]) => have(k) >= v);
    row.append(b);
    wrap.append(row);
  }
  return wrap;
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  pollPad(dt, now);   // also drives the login and death screens
  if (!state.map) { renderer.render(scene, camera); return; }
  const me = state.me;
  const alive = me && !me.dead;

  // Local movement (client-side prediction; server re-validates every step).
  if (alive && !state.invOpen) {
    const k = state.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const pf = f + pad.moveY, pr = r + pad.moveX;
    state.sprint = (k.has('ShiftLeft') || pad.sprint) && pf > 0.3 && !state.aiming;
    if (state.sprint) state.crouch = false;
    // Mobility comes from the active weapon build and the armor you wear.
    const ws = weaponStats(me.inv[me.active]);
    const mobility = (ws ? ws.mobility : 1.05) + armorStats(me.inv.armor).mobility;
    const speed = (state.sprint ? SPRINT_SPEED : (state.crouch || state.aiming) ? CROUCH_SPEED : WALK_SPEED) * mobility;
    const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw);
    const rx = -Math.cos(state.yaw), rz = Math.sin(state.yaw);
    let mx = fx * pf + rx * pr, mz = fz * pf + rz * pr;
    const len = Math.hypot(mx, mz);
    if (len > 0.05) {
      if (len > 1) { mx /= len; mz /= len; }   // analog sticks below full tilt walk slower
      const p = moveWithCollision(state.x, state.z, mx * speed * dt, mz * speed * dt, PLAYER_RADIUS, solidsNear(state.x, state.z, 3), state.map.terrain);
      state.x = p.x; state.z = p.z;
    }
    if (build.on) { if (state.mouseDown && !state.firedThisPress) { placePiece(); state.firedThisPress = true; } if (!state.mouseDown) state.firedThisPress = false; }
    else if (state.mouseDown) tryFire(now); else state.firedThisPress = false;
  }
  if (now - state.lastSend > 50 && alive) {
    state.lastSend = now;
    send({ t: 'state', x: state.x, z: state.z, yaw: state.yaw, pitch: state.pitch, crouch: state.crouch, aim: state.aiming, sprint: state.sprint });
  }

  // Recoil recovers smoothly.
  if (state.recoil > 0) {
    const kick = Math.min(state.recoil, dt * 0.6);
    state.pitch = Math.min(1.2, state.pitch + kick * 0.9);
    state.recoil -= kick;
  }

  // Self mesh.
  updateCharacterMesh(selfMesh, { x: state.x, z: state.z, yaw: state.yaw, crouch: state.crouch, dead: !alive }, 1);
  for (const [, r] of state.players) updateCharacterMesh(r.mesh, r.data, dt);
  for (const [, r] of state.bots) updateCharacterMesh(r.mesh, r.data, dt);
  for (const [, l] of state.loot) l.mesh.rotation.y += dt;
  for (const [, b] of state.bags) b.mesh.rotation.y += dt * 0.5;

  // Over-the-shoulder camera with wall collision.
  const d = lookDir();
  const right = new THREE.Vector3(-Math.cos(state.yaw), 0, Math.sin(state.yaw));
  const aim = state.aiming && alive;
  const dist = aim ? 1.8 : 4.2, shoulder = aim ? 0.6 : 0.85;
  const pivot = new THREE.Vector3(state.x, eyeHeight() + (aim ? 0.2 : 0.45), state.z).addScaledVector(right, shoulder);
  const want = pivot.clone().addScaledVector(d, -dist);
  const toCam = want.clone().sub(pivot);
  const tl = toCam.length();
  toCam.normalize();
  const hit = rayAgainstBoxes(pivot.x, pivot.y, pivot.z, toCam.x, toCam.y, toCam.z, solidsNear(pivot.x, pivot.z, tl + 1), tl);
  const camDist = Math.max(0.3, Math.min(tl, hit.t - 0.25));
  camera.position.copy(pivot).addScaledVector(toCam, camDist);
  const camGround = Math.max(ground(camera.position.x, camera.position.z), 0);
  if (camera.position.y < camGround + 0.4) camera.position.y = camGround + 0.4;
  camera.lookAt(camera.position.clone().add(d));
  // Optic zoom sets ADS field of view; handling sets how fast you get there.
  const ws = me && weaponStats(me.inv[me.active]);
  const fov = aim && ws ? 70 / ws.zoom : 70;
  const adsRate = ws ? 4 + ws.handling / 6 : 12;
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * adsRate); camera.updateProjectionMatrix(); }
  $('crosshair').classList.toggle('aim', aim);

  // Hide stash labels you're standing right under.
  for (const [id, v] of houseVis) { const h = state.map.houses[id]; v.label.visible = Math.hypot(h.x - state.x, h.z - state.z) > 9; }
  state.view.update(state.x, state.z);
  for (const g of state.contactMeshes) g.visible = Math.abs(g.position.x - state.x) < 300 && Math.abs(g.position.z - state.z) < 300;
  for (const g of dropVis.values()) {
    // Falling crate until it lands.
    const left = g.userData.drop.landsAt - Date.now();
    g.userData.crate.position.y = left > 0 ? 0.5 + Math.min(60, left / 1000) : 0.5;
  }
  const gy0 = ground(state.x, state.z);
  sun.position.set(state.x + 40, gy0 + 80, state.z + 25);
  sun.target.position.set(state.x, gy0, state.z);

  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) { scene.remove(t.obj); t.obj.geometry.dispose(); tracers.splice(i, 1); }
  }

  const prompt = alive && !state.invOpen ? nearestInteractable() : null;
  $('prompt').innerHTML = prompt ? `<kbd>${glyph('E')}</kbd>${prompt}` : '';
  drawMinimap();
  renderer.render(scene, camera);
  drawGunsmith(dt);
  drawMarkers();
  updateBuildGhost();
  for (const v of chargeVis.values()) v.visible = Math.floor(now / 300) % 2 === 0;
}
requestAnimationFrame(frame);

// Debug/test hook (used by the automated smoke test).
window.__dz = { state, send };
