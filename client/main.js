import * as THREE from 'three';
import {
  moveWithCollision, rayAgainstBoxes, rayBox, characterBounds, INTERACT_RANGE,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED,
} from '/shared/world.js';
import {
  ARCHETYPES, PARTS, PAINTS, ARMORS, SLOTS, SLOT_LABELS, weaponStats, armorStats, statBars, partFits,
  xpForLevel, MAX_LEVEL, GADGETS,
} from '/shared/items.js';
import { buildGunModel, setExplode, gunKey } from '/gunmodel.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ renderer / scene
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9aa4ad);
scene.fog = new THREE.Fog(0x9aa4ad, 60, 230);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a3530, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 220 });
scene.add(sun, sun.target);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// Window texture for buildings (procedural so there are no asset files).
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9ea3'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#4c5966'; g.fillRect(10, 14, 44, 30);
  g.fillStyle = '#58616a'; g.fillRect(10, 44, 44, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const winTex = windowTexture();

function boxGeometry(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile) {
    // Scale UVs by face size so the window texture tiles every `tile` meters.
    const uv = g.attributes.uv;
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile);
    }
  }
  return g;
}

// ------------------------------------------------------------------ game state
const state = {
  exposed: new Map(), sensors: [], pings: [], alerts: [], squad: { id: null, members: [], leaderId: null }, invite: null,
  hack: null, terminals: [], terminalMeshes: [], aimTargetId: null,
  ws: null, id: null, map: null, houseId: null, me: null,
  x: 0, z: 0, yaw: 0, pitch: 0, crouch: false, aiming: false, sprint: false,
  keys: new Set(), mouseDown: false, firedThisPress: false, lastShot: 0,
  players: new Map(), bots: new Map(), loot: new Map(), bags: new Map(), houses: [],
  container: null, invOpen: false, lastSend: 0, recoil: 0,
  doorSolids: [], snapshotHouses: [],
};

// ------------------------------------------------------------------ world construction
const mats = {
  terminal: new THREE.MeshStandardMaterial({ color: 0x23303a, emissive: 0x16c2ff, emissiveIntensity: 0.6 }),
  building: new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.9 }),
  housewall: new THREE.MeshStandardMaterial({ color: 0x8a6e52, roughness: 0.95 }),
  ownwall: new THREE.MeshStandardMaterial({ color: 0x4f8a5a, roughness: 0.95 }),
  crate: new THREE.MeshStandardMaterial({ color: 0xff8a2a, roughness: 0.6 }),
  cover: new THREE.MeshStandardMaterial({ color: 0x9c9c95, roughness: 1 }),
  border: new THREE.MeshStandardMaterial({ color: 0x2b2f33 }),
  door: new THREE.MeshStandardMaterial({ color: 0x5a5f66, metalness: 0.4, roughness: 0.5 }),
};
const carColors = [0x7a2222, 0x2a3f6b, 0x444444, 0xbbb59a, 0x2f5a3a];
let doorMeshes = [];
let houseLabels = [];

function buildWorld(map) {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.half * 2 + 40, map.half * 2 + 40), new THREE.MeshStandardMaterial({ color: 0x3d4145, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(map.half * 2, map.half / 5, 0x555a60, 0x4a4f54);
  grid.position.y = 0.01;
  scene.add(grid);

  map.boxes.forEach((b, i) => {
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    let mat = mats[b.type] || mats.cover;
    if (b.type === 'terminal') mat = mats.terminal.clone();
    if (b.type === 'housewall' && b.houseId === state.houseId) mat = mats.ownwall;
    if (b.type === 'car') mat = new THREE.MeshStandardMaterial({ color: carColors[i % carColors.length], metalness: 0.3, roughness: 0.6 });
    if (b.type === 'building') {
      mat = mats.building.clone();
      mat.color.setHSL(0.07 + (i % 7) * 0.015, 0.08, 0.55 + (i % 5) * 0.06);
    }
    const mesh = new THREE.Mesh(boxGeometry(w, b.h, d, b.type === 'building' ? 4 : 0), mat);
    mesh.position.set((b.minX + b.maxX) / 2, b.h / 2, (b.minZ + b.maxZ) / 2);
    mesh.castShadow = b.h < 12;
    mesh.receiveShadow = true;
    if (b.type === 'terminal') state.terminalMeshes[b.terminalId] = mesh;
    scene.add(mesh);
  });

  doorMeshes = map.houses.map((h) => {
    const d = h.door;
    const m = new THREE.Mesh(new THREE.BoxGeometry(d.maxX - d.minX, d.h, d.maxZ - d.minZ), mats.door.clone());
    m.position.set((d.minX + d.maxX) / 2, d.h / 2, (d.minZ + d.maxZ) / 2);
    m.castShadow = true;
    scene.add(m);
    return m;
  });
  houseLabels = map.houses.map((h) => {
    const s = makeLabel('', 0.012);
    s.position.set(h.x, 5.2, h.z);
    scene.add(s);
    return s;
  });
  buildMinimapBase(map);
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
  const color = kind === 'self' ? 0x3a7bd5 : kind === 'bot' ? 0x3d2b4f : 0xd0602a;
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
    const label = makeLabel(name, 0.0042, kind === 'bot' ? '#ff6b6b' : '#ffb27a');
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
    if (!rec) { rec = { mesh: create(e) }; rec.mesh.position.set(e.x, 0, e.z); store.set(e.id, rec); }
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
let minimapBase = null;
const MM_SCALE = 2;
function buildMinimapBase(map) {
  const size = (map.half * 2 + 10) * MM_SCALE;
  minimapBase = document.createElement('canvas');
  minimapBase.width = minimapBase.height = size;
  const g = minimapBase.getContext('2d');
  g.fillStyle = '#1a1e23'; g.fillRect(0, 0, size, size);
  for (const b of map.boxes) {
    g.fillStyle = b.type === 'building' ? '#4a5058' : b.type === 'housewall' ? (b.houseId === state.houseId ? '#4fbf6a' : '#a8774c') : b.type === 'crate' ? '#ff8a2a' : '#363b40';
    g.fillRect((b.minX + map.half + 5) * MM_SCALE, (b.minZ + map.half + 5) * MM_SCALE, (b.maxX - b.minX) * MM_SCALE, (b.maxZ - b.minZ) * MM_SCALE);
  }
}

function drawMinimap() {
  const c = $('minimap'), g = c.getContext('2d');
  const R = 100, view = 70;   // meters shown radius
  g.clearRect(0, 0, 200, 200);
  g.save();
  g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.clip();
  const k = R / view;
  const off = state.map.half + 5;
  // Map is drawn with +X to the right and +Z downward (north-up = -Z).
  g.drawImage(minimapBase, (state.x + off - view) * MM_SCALE, (state.z + off - view) * MM_SCALE, view * 2 * MM_SCALE, view * 2 * MM_SCALE, 0, 0, 200, 200);
  for (const [, l] of state.loot) {
    if (l.data.kind !== 'parts') continue;
    g.fillStyle = '#ffc53d';
    g.fillRect(R + (l.data.x - state.x) * k - 1.5, R + (l.data.z - state.z) * k - 1.5, 3, 3);
  }
  // Player arrow (screen-up = -Z, so rotate by yaw accordingly).
  const dot = (x, z, color, size = 4) => { g.fillStyle = color; g.fillRect(R + (x - state.x) * k - size / 2, R + (z - state.z) * k - size / 2, size, size); };
  state.map.terminals.forEach((t, i) => dot(t.x, t.z, state.terminals[i] === false ? '#553333' : '#16c2ff', 3));
  for (const [, r] of state.players) if (r.data.sq && !r.data.dead) dot(r.data.x, r.data.z, '#7dff9a', 5);
  const now = performance.now();
  for (const p of state.pings) if (p.until > now) dot(p.x, p.z, p.objective ? '#ffc53d' : '#ffffff', p.objective ? 7 : 5);
  for (const a of state.alerts) if (a.until > now && Math.floor(now / 250) % 2) dot(a.x, a.z, '#ff3b3b', 8);
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
      Object.assign(state, { id: m.id, map: m.map, houseId: m.houseId, x: m.x, z: m.z, yaw: m.yaw || 0, packSize: m.packSize, doorMax: m.doorMax });
      buildWorld(m.map);
      selfMesh.visible = true;
      selfMesh.position.set(m.x, 0, m.z);
      $('login').hidden = true; $('hud').hidden = false;
      if (m.houseId !== null) toast(`Your stash house is marked green on the minimap. It stays in the world while you're offline.`);
      else toast('All stash houses are claimed — survive and take one by force… (claim when an owner is freed)');
      canvas.requestPointerLock?.();
      break;
    case 'snap': {
      for (const p of m.players) {
        if (p.id === state.id) { state.selfSnap = p; continue; }
        let rec = state.players.get(p.id);
        if (!rec) { rec = { mesh: makeCharacter('player', p.name) }; rec.mesh.position.set(p.x, 0, p.z); state.players.set(p.id, rec); }
        rec.data = p;
        setCharacterGun(rec.mesh, p.gun);
        setLabel(rec.mesh.userData.label, `${p.sq ? '◆ ' : ''}${p.name}  [${p.level}]${p.hacking ? '  ⌁ hacking' : ''}`, p.sq ? '#7dff9a' : '#ffb27a');
        setCloak(rec.mesh, p.camo ? (p.sq ? 0.35 : 0.12) : 1);
      }
      for (const [id, rec] of state.players) if (!m.players.some((p) => p.id === id)) { scene.remove(rec.mesh); state.players.delete(id); }
      for (const b of m.bots) {
        let rec = state.bots.get(b.id);
        if (!rec) { rec = { mesh: makeCharacter('bot', 'Rogue') }; rec.mesh.position.set(b.x, 0, b.z); setCharacterGun(rec.mesh, { a: 'carbine', paint: 'factory' }); state.bots.set(b.id, rec); }
        rec.data = { ...b, armor: 0, maxArmor: 0 };
      }
      for (const [id, rec] of state.bots) if (!m.bots.some((b) => b.id === id)) { scene.remove(rec.mesh); state.bots.delete(id); }
      syncEntities(m.loot, state.loot, (e) => lootMesh(e.kind));
      syncEntities(m.bags, state.bags, () => lootMesh('bag'));
      state.houses = m.houses;
      if (state.panelOpen && performance.now() - (state.panelDrawn || 0) > 1000) { state.panelDrawn = performance.now(); renderSquadPanel(); }
      state.terminals = m.terminals || [];
      state.terminals.forEach((ready, i) => { const tm = state.terminalMeshes[i]; if (tm) tm.material.emissive.setHex(ready ? 0x16c2ff : 0x552222); });
      state.doorSolids = m.houses.filter((h) => h.hp > 0 && !h.open).map((h) => ({ ...state.map.houses[h.id].door, type: 'door' }));
      m.houses.forEach((h, i) => {
        const dm = doorMeshes[i];
        dm.visible = h.hp > 0 && !h.open;
        dm.material.color.setRGB(0.35 + 0.5 * (1 - h.hp / state.doorMax), 0.37 * (h.hp / state.doorMax) + 0.05, 0.4 * (h.hp / state.doorMax) + 0.05);
        const own = h.id === state.houseId;
        const status = h.hp <= 0 ? 'BREACHED' : h.open ? 'open' : `${Math.round(h.hp / state.doorMax * 100)}%`;
        setLabel(houseLabels[i], `${own ? 'YOUR STASH' : (h.owner ? `${h.owner}'s stash` : 'Unclaimed stash')} · ${status}`, own ? '#7dff9a' : h.hp <= 0 ? '#ff6b6b' : '#ffd29a');
        if (own) $('housestatus').textContent = `Your stash house: ${status}`;
      });
      break;
    }
    case 'you': {
      const wasDead = state.me?.dead;
      state.me = m;
      if (m.dead && !wasDead) { /* death handled by 'died' */ }
      if (!m.dead && wasDead) $('death').hidden = true;
      updateHud();
      if (state.invOpen) renderInventory();
      if (state.gunsmithOpen) renderGunsmith();
      setCloak(selfMesh, m.camoActive ? 0.3 : 1);
      document.body.classList.toggle('cloaked', !!m.camoActive);
      updateGadgetBar();
      setCharacterGun(selfMesh, m.inv[m.active] ? { a: m.inv[m.active].archetype, parts: m.inv[m.active].parts, paint: m.inv[m.active].paint } : null);
      break;
    }
    case 'correct':
      state.x = m.x; state.z = m.z;
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
      mesh.position.set(m.x, 0.2, m.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(m.radius - 0.15, m.radius, 48), new THREE.MeshBasicMaterial({ color: 0xff9b21, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(m.x, 0.05, m.z);
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
      $('deathby').textContent = `Killed by ${m.by}`;
      $('death').hidden = false;
      state.gunsmithOpen = false; $('gunsmith').hidden = true;
      closeInventory();
      document.exitPointerLock?.();
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
  $('resources').innerHTML = `<span title="Build guns and armor">⚙ ${me.parts} parts</span><span title="Powers gadgets">⌁ ${me.tech} tech</span><span title="Bank at your stash for XP — lost if you die">▣ ${me.intel} intel</span>`;
  const lo = xpForLevel(me.level), hi = xpForLevel(me.level + 1);
  $('level').textContent = `LEVEL ${me.level}`;
  $('xpbar').style.width = me.level >= MAX_LEVEL ? '100%' : `${((me.xp - lo) / (hi - lo)) * 100}%`;
  $('xptext').textContent = me.level >= MAX_LEVEL ? `${me.xp} XP · max level` : `${me.xp - lo} / ${hi - lo} XP`;
}

function statLine(item) {
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
    if (c.canPut) {
      const dep = document.createElement('div');
      dep.className = 'gsentry';
      for (const r of ['parts', 'tech', 'ammo']) {
        if (!me[r]) continue;
        const b = document.createElement('button');
        b.className = 'ghost'; b.textContent = `Deposit ${me[r]} ${r}`;
        b.onclick = () => send({ t: 'container', action: 'put', res: r });
        dep.append(b);
      }
      if (dep.children.length) box.append(dep);
    }
    const label = { parts: 'parts', tech: 'tech', intel: 'intel drives', ammo: 'rounds' };
    for (const r of ['parts', 'tech', 'intel', 'ammo']) {
      if (c[r]) box.append(itemCard({ kind: r, name: `${c[r]} ${label[r]}` }, { buttons: [['← Take', () => send({ t: 'container', action: 'take', res: r })]] }));
    }
    if (!c.items.length && !['parts', 'tech', 'intel', 'ammo'].some((r) => c[r])) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Empty' }));
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
  const blueprint = (label, lvl, cost, action, type) => {
    const row = document.createElement('div');
    row.className = 'bprow' + (lvl > me.level ? ' locked' : '');
    row.innerHTML = `<span>${label}</span>`;
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = lvl > me.level ? `LVL ${lvl}` : cost ? `Build · ${cost}` : 'Build · free';
    b.disabled = lvl > me.level || totalParts < cost;
    b.onclick = () => send({ t: 'gunsmith', action, type });
    row.append(b);
    bp.append(row);
  };
  for (const [k, a] of Object.entries(ARCHETYPES)) blueprint(a.label, a.level, a.cost, 'build', k);
  for (const [k, a] of Object.entries(ARMORS)) blueprint(`${a.name} (armor ${a.armor})`, a.level, a.cost, 'buildArmor', k);

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

  const option = (label, lvl, equipped, hover, onPick) => {
    const b = document.createElement('button');
    const locked = lvl > me.level;
    b.className = 'gsopt' + (equipped ? ' sel' : '') + (locked ? ' locked' : '');
    b.innerHTML = `${label}${locked ? `<small>LVL ${lvl}</small>` : equipped ? '<small>equipped</small>' : ''}`;
    b.onmouseenter = () => { gs.hover = hover; setPreviewModel(previewItem(item, hover)); renderStatBars(item, previewItem(item, hover)); setExplode(gs.model, gs.explode, gs.slot); };
    b.onmouseleave = () => { gs.hover = null; setPreviewModel(item); renderStatBars(item, item); };
    if (!locked && !equipped) b.onclick = onPick;
    opts.append(b);
  };
  if (gs.slot === 'paint') {
    for (const [id, p] of Object.entries(PAINTS)) {
      option(`<i class="swatch" style="background:${p.color}"></i>${p.name}`, p.level, item.paint === id, { paint: id }, () => send({ t: 'gunsmith', action: 'paint', itemId: item.id, paint: id }));
    }
  } else {
    for (const [id, p] of Object.entries(PARTS)) {
      if (p.slot !== gs.slot || !partFits(id, item.archetype)) continue;
      option(p.name, p.level, item.parts[gs.slot] === id, { slot: gs.slot, partId: id }, () => send({ t: 'gunsmith', action: 'attach', itemId: item.id, slot: gs.slot, partId: id }));
    }
  }
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

function levelBanner(level, unlocks) {
  const el = $('levelup');
  el.innerHTML = `<h2>LEVEL ${level}</h2>${unlocks.length ? `<div>Unlocked: ${unlocks.map((u) => `<b>${u.name}</b>`).join(', ')}</div><small>Visit the gunsmith at your stash house</small>` : ''}`;
  el.hidden = false;
  el.animate([{ opacity: 0, transform: 'translate(-50%, -10px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 250 });
  clearTimeout(levelBanner.t);
  levelBanner.t = setTimeout(() => { el.hidden = true; }, 5000);
}

// ------------------------------------------------------------------ input
$('join').onclick = () => {
  const name = $('name').value.trim() || 'Agent';
  localStorage.setItem('dz_name', name);
  connect(name);
};
$('name').value = localStorage.getItem('dz_name') || '';
$('name').onkeydown = (e) => { if (e.key === 'Enter') $('join').click(); };
$('respawn').onclick = () => { send({ t: 'respawn' }); $('death').hidden = true; canvas.requestPointerLock?.(); };

canvas.addEventListener('click', () => { if (state.me && !state.invOpen && !state.me.dead) canvas.requestPointerLock?.(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
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
  if (document.activeElement === $('name')) return;
  if (e.code === 'KeyP') {
    if (!state.me) return;
    if (state.panelOpen) closeSquadPanel(); else openSquadPanel();
    return;
  }
  if (e.code === 'Escape' && state.panelOpen) { closeSquadPanel(); return; }
  if (e.code === 'Tab' || e.code === 'KeyI') {
    e.preventDefault();
    if (!state.me || state.me.dead) return;
    if (state.invOpen) { state.gunsmithOpen = false; $('gunsmith').hidden = true; closeInventory(); canvas.requestPointerLock?.(); } else openInventory();
    return;
  }
  if (e.code === 'Escape' && state.gunsmithOpen) { closeGunsmith(); return; }
  if (e.code === 'Escape' && state.invOpen) { closeInventory(); return; }
  state.keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyE') send({ t: 'interact' });
  if (e.code === 'KeyF' && state.aimTargetId) send({ t: 'mark', id: state.aimTargetId });
  if (e.code === 'KeyG') { const p = aimPoint(); send({ t: 'sensor', x: p.x, z: p.z }); }
  if (e.code === 'KeyV') send({ t: 'camo' });
  if (e.code === 'KeyT') send({ t: 'rally' });
  if (e.code === 'KeyB') { const p = aimPoint(); send({ t: 'squad', action: 'ping', x: p.x, z: p.z }); }
  if (e.code === 'KeyR') send({ t: 'reload' });
  if (e.code === 'KeyQ' || e.code === 'Digit1' || e.code === 'Digit2') send({ t: 'swap' });
  if (e.code === 'KeyH') send({ t: 'inv', action: 'use' });
  if (e.code === 'KeyC' || e.code === 'ControlLeft') state.crouch = !state.crouch;
});
addEventListener('keyup', (e) => state.keys.delete(e.code));
addEventListener('blur', () => { state.keys.clear(); state.mouseDown = false; state.aiming = false; });

// ------------------------------------------------------------------ simulation helpers
function solids() { return state.doorSolids.length ? state.map.boxes.concat(state.doorSolids) : state.map.boxes; }

function lookDir() {
  return new THREE.Vector3(Math.sin(state.yaw) * Math.cos(state.pitch), Math.sin(state.pitch), Math.cos(state.yaw) * Math.cos(state.pitch));
}

function eyeHeight() { return state.crouch ? CROUCH_EYE : STAND_EYE; }

/** Raycast from the camera through the crosshair and return the world point it lands on. */
function aimPoint() {
  const o = camera.position, d = lookDir();
  let best = rayAgainstBoxes(o.x, o.y, o.z, d.x, d.y, d.z, solids(), 400).t;
  const minT = o.distanceTo(new THREE.Vector3(state.x, eyeHeight(), state.z));
  state.aimTargetId = null;
  const test = (c) => {
    if (!c || c.dead) return;
    const b = characterBounds(c.x, c.z, c.crouch);
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
  state.map.terminals.forEach((t, i) => consider(Math.hypot(t.x - state.x, t.z - state.z), state.terminals[i] === false ? 'Terminal rebooting' : 'Hack terminal (stand still 5s) — intel + tech'));
  state.map.houses.forEach((h, i) => {
    const hs = state.houses[i];
    if (!hs) return;
    const own = h.id === state.houseId;
    consider(Math.hypot(h.crate.x - state.x, h.crate.z - state.z) - 0.3, own ? 'Open your stash' : `Loot ${hs.owner || 'unclaimed'}'s stash`);
    const d = h.door;
    const squadHouse = !own && hs.owner && state.squad.members.some((m) => m.name === hs.owner);
    const lockText = (state.me?.level ?? 1) >= GADGETS.doorHack.level ? `Hack lock (${GADGETS.doorHack.cost} tech, 8s)` : `Locked — shoot it down (hack at lvl ${GADGETS.doorHack.level})`;
    const doorText = own || squadHouse ? (hs.hp <= 0 ? (own ? 'Rebuild door' : 'Doorway (breached)') : hs.open ? 'Close door' : 'Open door') : (hs.hp <= 0 ? 'Doorway (breached)' : hs.open ? 'Doorway (open)' : `${lockText} · ${Math.round(hs.hp / state.doorMax * 100)}%`);
    consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), doorText);
  });
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
      marker(`x${id}`, e.kind === 'mark' ? 'tag' : 'sensed', e.kind === 'mark' ? `◆ ${Math.round(d)}m` : '●', new THREE.Vector3(c.x, (c.crouch ? 1.2 : 1.8) + 0.5, c.z));
    }
    for (const [id, r] of state.players) {
      if (!r.data.sq || r.data.dead) continue;
      marker(`s${id}`, 'squad', `▼ ${r.data.name}`, new THREE.Vector3(r.data.x, 2.6, r.data.z));
    }
    state.pings = state.pings.filter((p) => p.until > now);
    state.pings.forEach((p, i) => marker(`p${i}`, p.objective ? 'objective' : 'ping', `${p.objective ? '★ OBJECTIVE' : `◎ ${p.from}`} · ${Math.round(Math.hypot(p.x - state.x, p.z - state.z))}m`, new THREE.Vector3(p.x, 1.5, p.z)));
    state.alerts = state.alerts.filter((a) => a.until > now);
    state.alerts.forEach((a, i) => marker(`a${i}`, 'alert', '⚠', new THREE.Vector3(a.x, 2, a.z)));
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
  $('gadgets').innerHTML = items.map(([k, name, lv, st]) => `<div class="gadget ${lvl < lv ? 'locked' : st}"><kbd>${k}</kbd>${name}${lvl < lv ? `<small>LVL ${lv}</small>` : ''}</div>`).join('') +
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
  canvas.requestPointerLock?.();
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

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!state.map) { renderer.render(scene, camera); return; }
  const me = state.me;
  const alive = me && !me.dead;

  // Local movement (client-side prediction; server re-validates every step).
  if (alive && !state.invOpen) {
    const k = state.keys;
    const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    state.sprint = k.has('ShiftLeft') && f > 0 && !state.aiming;
    if (state.sprint) state.crouch = false;
    // Mobility comes from the active weapon build and the armor you wear.
    const ws = weaponStats(me.inv[me.active]);
    const mobility = (ws ? ws.mobility : 1.05) + armorStats(me.inv.armor).mobility;
    const speed = (state.sprint ? SPRINT_SPEED : (state.crouch || state.aiming) ? CROUCH_SPEED : WALK_SPEED) * mobility;
    const fx = Math.sin(state.yaw), fz = Math.cos(state.yaw);
    const rx = -Math.cos(state.yaw), rz = Math.sin(state.yaw);
    let mx = fx * f + rx * r, mz = fz * f + rz * r;
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len; mz /= len;
      const p = moveWithCollision(state.x, state.z, mx * speed * dt, mz * speed * dt, PLAYER_RADIUS, solids());
      state.x = p.x; state.z = p.z;
    }
    if (state.mouseDown) tryFire(now); else state.firedThisPress = false;
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
  const hit = rayAgainstBoxes(pivot.x, pivot.y, pivot.z, toCam.x, toCam.y, toCam.z, solids(), tl);
  const camDist = Math.max(0.3, Math.min(tl, hit.t - 0.25));
  camera.position.copy(pivot).addScaledVector(toCam, camDist);
  if (camera.position.y < 0.3) camera.position.y = 0.3;
  camera.lookAt(camera.position.clone().add(d));
  // Optic zoom sets ADS field of view; handling sets how fast you get there.
  const ws = me && weaponStats(me.inv[me.active]);
  const fov = aim && ws ? 70 / ws.zoom : 70;
  const adsRate = ws ? 4 + ws.handling / 6 : 12;
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * adsRate); camera.updateProjectionMatrix(); }
  $('crosshair').classList.toggle('aim', aim);

  // Hide stash labels you're standing right under.
  state.map.houses.forEach((h, i) => { houseLabels[i].visible = Math.hypot(h.x - state.x, h.z - state.z) > 9; });
  sun.position.set(state.x + 40, 80, state.z + 25);
  sun.target.position.set(state.x, 0, state.z);

  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.life <= 0) { scene.remove(t.obj); t.obj.geometry.dispose(); tracers.splice(i, 1); }
  }

  const prompt = alive && !state.invOpen ? nearestInteractable() : null;
  $('prompt').innerHTML = prompt ? `<kbd>E</kbd>${prompt}` : '';
  drawMinimap();
  renderer.render(scene, camera);
  drawGunsmith(dt);
  drawMarkers();
}
requestAnimationFrame(frame);

// Debug/test hook (used by the automated smoke test).
window.__dz = { state, send };
