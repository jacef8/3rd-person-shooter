import * as THREE from 'three';
import {
  moveWithCollision, rayAgainstBoxes, rayBox, characterBounds, INTERACT_RANGE,
  PLAYER_RADIUS, STAND_EYE, CROUCH_EYE, WALK_SPEED, SPRINT_SPEED, CROUCH_SPEED,
} from '/shared/world.js';
import { RARITY, ARCHETYPES, ATTR_LABELS, weaponStats, armorStats, itemScore } from '/shared/items.js';

const $ = (id) => document.getElementById(id);
const SEMI_AUTO = new Set(['dmr', 'shotgun', 'sidearm']);

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
  ws: null, id: null, map: null, houseId: null, me: null,
  x: 0, z: 0, yaw: 0, pitch: 0, crouch: false, aiming: false, sprint: false,
  keys: new Set(), mouseDown: false, firedThisPress: false, lastShot: 0,
  players: new Map(), bots: new Map(), loot: new Map(), bags: new Map(), houses: [],
  container: null, invOpen: false, lastSend: 0, recoil: 0,
  doorSolids: [], snapshotHouses: [],
};

// ------------------------------------------------------------------ world construction
const mats = {
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
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.75), new THREE.MeshStandardMaterial({ color: 0x1b1b1b }));
  gun.position.set(-0.25, 1.25, 0.4);
  for (const m of [body, head, pack, gun]) m.castShadow = true;
  g.add(body, head, visor, pack, gun);
  const upper = new THREE.Group();
  g.userData = { body, head, visor, gun, pack };
  if (kind !== 'self') {
    const label = makeLabel(name, 0.006, kind === 'bot' ? '#ff6b6b' : '#ffb27a');
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
function lootMesh(rarity, isBag) {
  const color = isBag ? 0xffffff : new THREE.Color(RARITY[rarity].color);
  const g = new THREE.Group();
  const crate = new THREE.Mesh(new THREE.BoxGeometry(isBag ? 0.6 : 0.5, isBag ? 0.4 : 0.3, 0.4), new THREE.MeshStandardMaterial({ color: isBag ? 0x2d2d22 : color, emissive: isBag ? 0x000000 : color, emissiveIntensity: 0.4 }));
  crate.position.y = 0.2;
  const tier = isBag ? 2 : RARITY[rarity].tier;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 2 + tier * 2, 8, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  beam.position.y = 1 + tier;
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
    const t = RARITY[l.data.rarity]?.tier ?? 0;
    if (t < 2 && l.data.kind !== 'armor' && l.data.kind !== 'weapon') continue;
    g.fillStyle = RARITY[l.data.rarity].color;
    g.fillRect(R + (l.data.x - state.x) * k - 1.5, R + (l.data.z - state.z) * k - 1.5, 3, 3);
  }
  // Player arrow (screen-up = -Z, so rotate by yaw accordingly).
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
      }
      for (const [id, rec] of state.players) if (!m.players.some((p) => p.id === id)) { scene.remove(rec.mesh); state.players.delete(id); }
      for (const b of m.bots) {
        let rec = state.bots.get(b.id);
        if (!rec) { rec = { mesh: makeCharacter('bot', 'Rogue') }; rec.mesh.position.set(b.x, 0, b.z); state.bots.set(b.id, rec); }
        rec.data = { ...b, armor: 0, maxArmor: 0 };
      }
      for (const [id, rec] of state.bots) if (!m.bots.some((b) => b.id === id)) { scene.remove(rec.mesh); state.bots.delete(id); }
      syncEntities(m.loot, state.loot, (e) => lootMesh(e.rarity, false));
      syncEntities(m.bags, state.bags, () => lootMesh(null, true));
      state.houses = m.houses;
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
      break;
    }
    case 'correct':
      state.x = m.x; state.z = m.z;
      break;
    case 'shot':
      for (const h of m.hits) addTracer(m.o, h, h[3]);
      break;
    case 'hitmark':
      damageNumber(m.dmg, m.crit, [m.x, m.y, m.z]);
      break;
    case 'feed': feedLine(m.text); break;
    case 'toast': toast(m.text); break;
    case 'died':
      $('deathby').textContent = `Killed by ${m.by}`;
      $('death').hidden = false;
      closeInventory();
      document.exitPointerLock?.();
      break;
    case 'container':
      if (m.closed) { state.container = null; if (state.invOpen) renderInventory(); break; }
      state.container = m;
      openInventory();
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
  $('wname').textContent = w ? w.name : 'Unarmed';
  $('wname').style.color = w ? RARITY[w.rarity].color : '#aaa';
  $('mag').textContent = me.mag;
  $('reserve').textContent = me.ammo;
  const medkits = me.inv.pack.filter((i) => i.kind === 'medkit').length;
  $('wextra').textContent = `${me.reloading ? 'RELOADING… · ' : ''}Medkits ${medkits} · Kills ${me.kills}`;
}

function statLine(item) {
  if (item.kind === 'weapon') {
    const s = weaponStats(item);
    return `${ARCHETYPES[item.archetype].label} · ${Math.round(s.damage)}${s.pellets > 1 ? `×${s.pellets}` : ''} dmg · ${Math.round(s.rpm)} rpm · ${s.mag} mag`;
  }
  if (item.kind === 'armor') { const a = armorStats(item); return `Armor ${a.armor}`; }
  if (item.kind === 'medkit') return 'Restores 60 health and 40 armor';
  return '';
}

function itemCard(item, { slot, buttons = [], compare } = {}) {
  const el = document.createElement('div');
  el.className = 'item';
  if (!item) {
    el.innerHTML = `<span class="slot">${slot}</span><span class="empty">— empty —</span>`;
    return el;
  }
  const r = RARITY[item.rarity];
  el.style.borderLeftColor = r.color;
  const attrs = Object.entries(item.attrs || {}).map(([k, v]) => `+${v}% ${ATTR_LABELS[k]}`).join(' · ');
  const score = itemScore(item);
  let diff = '';
  if (compare !== undefined && score) {
    const d = score - itemScore(compare);
    diff = d > 0 ? `<div class="up">▲ ${d}</div>` : d < 0 ? `<div class="down">▼ ${-d}</div>` : '';
  }
  el.innerHTML = `${slot ? `<span class="slot">${slot}</span>` : ''}
    <div class="meta"><div class="nm" style="color:${r.color}">${item.name} <small style="color:#888">${item.kind === 'weapon' || item.kind === 'armor' ? r.name : ''}</small></div>
    <div class="st">${statLine(item)}</div>${attrs ? `<div class="at">${attrs}</div>` : ''}</div>
    <div class="score">${score || ''}${diff}</div>`;
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
  $('packcount').textContent = `(${inv.pack.length}/${state.packSize}) · ammo ${me.ammo}`;
  const c = state.container;
  if (!inv.pack.length) pack.innerHTML = '<div class="empty">Empty</div>';
  for (const item of inv.pack) {
    const buttons = [];
    if (item.kind === 'weapon' || item.kind === 'armor') buttons.push(['Equip', () => send({ t: 'inv', action: 'equip', itemId: item.id })]);
    if (item.kind === 'medkit') buttons.push(['Use', () => send({ t: 'inv', action: 'use' })]);
    if (c?.canPut) buttons.push(['Stash →', () => send({ t: 'container', action: 'put', itemId: item.id })]);
    buttons.push(['Drop', () => send({ t: 'inv', action: 'drop', itemId: item.id })]);
    pack.append(itemCard(item, { buttons, compare: equippedFor(item) }));
  }
  $('containerCol').hidden = !c;
  if (c) {
    $('containerTitle').textContent = `${c.title}${c.cap ? ` (${c.items.length}/${c.cap})` : ''}`;
    const box = $('container'); box.innerHTML = '';
    if (c.ammo) box.append(itemCard({ kind: 'ammo', rarity: 'scrap', name: `${c.ammo} rounds` }, { buttons: [['← Take', () => send({ t: 'container', action: 'take', ammo: true })]] }));
    if (!c.items.length && !c.ammo) box.innerHTML = '<div class="empty">Empty</div>';
    for (const item of c.items) box.append(itemCard(item, { buttons: [['← Take', () => send({ t: 'container', action: 'take', itemId: item.id })]], compare: equippedFor(item) }));
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
  const sens = state.aiming ? 0.0012 : 0.0022;
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
  if (e.code === 'Tab' || e.code === 'KeyI') {
    e.preventDefault();
    if (!state.me || state.me.dead) return;
    if (state.invOpen) { closeInventory(); canvas.requestPointerLock?.(); } else openInventory();
    return;
  }
  if (e.code === 'Escape' && state.invOpen) { closeInventory(); return; }
  state.keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyE') send({ t: 'interact' });
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
  const test = (c) => {
    if (!c || c.dead) return;
    const b = characterBounds(c.x, c.z, c.crouch);
    const t = rayBox(o.x, o.y, o.z, d.x, d.y, d.z, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    if (t > minT && t < best) best = t;
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
  const semi = SEMI_AUTO.has(w.archetype);
  if (semi && state.firedThisPress) return;
  const s = weaponStats(w, me.inv.armor);
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
  state.recoil += semi ? 0.035 : 0.012;
}

function nearestInteractable() {
  let best = null, bestD = INTERACT_RANGE;
  const consider = (d, text) => { if (d < bestD) { bestD = d; best = text; } };
  for (const [, l] of state.loot) consider(Math.hypot(l.data.x - state.x, l.data.z - state.z), `Pick up <span style="color:${RARITY[l.data.rarity].color}">${l.data.kind === 'weapon' || l.data.kind === 'armor' ? RARITY[l.data.rarity].name + ' ' : ''}${l.data.name}</span>`);
  for (const [, b] of state.bags) consider(Math.hypot(b.data.x - state.x, b.data.z - state.z), `Search ${b.data.label}`);
  state.map.houses.forEach((h, i) => {
    const hs = state.houses[i];
    if (!hs) return;
    const own = h.id === state.houseId;
    consider(Math.hypot(h.crate.x - state.x, h.crate.z - state.z) - 0.3, own ? 'Open your stash' : `Loot ${hs.owner || 'unclaimed'}'s stash`);
    const d = h.door;
    const doorText = own ? (hs.hp <= 0 ? 'Rebuild door' : hs.open ? 'Close door' : 'Open door') : (hs.hp <= 0 ? 'Doorway (breached)' : `Locked door — ${Math.round(hs.hp / state.doorMax * 100)}%`);
    consider(Math.hypot((d.minX + d.maxX) / 2 - state.x, (d.minZ + d.maxZ) / 2 - state.z), doorText);
  });
  return best;
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
    const speed = state.sprint ? SPRINT_SPEED : (state.crouch || state.aiming) ? CROUCH_SPEED : WALK_SPEED;
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
    send({ t: 'state', x: state.x, z: state.z, yaw: state.yaw, pitch: state.pitch, crouch: state.crouch, aim: state.aiming });
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
  const fov = aim ? 50 : 70;
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 12); camera.updateProjectionMatrix(); }
  $('crosshair').classList.toggle('aim', aim);

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
}
requestAnimationFrame(frame);

// Debug/test hook (used by the automated smoke test).
window.__dz = { state, send };
