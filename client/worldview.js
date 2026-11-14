// Draws the 30 km world around the player, with no fog wall.
//  Near: 160 m chunks holding everything (ground, buildings, trees), built as you approach and freed
//        behind you, so the GPU only ever holds a few hundred metres of detail — fine even on a phone.
//  Far:  the whole county's ground as one coarse mesh under a sky, plus plain stand-ins for buildings
//        and trees out to about a mile. main.js draws the far scene first and the near world over
//        it (the depth buffer is cleared in between), so the two can never fight over depth.
import * as THREE from 'three';
import { BRIDGE_DECK } from '/shared/terrain.js';
import { coverColor } from './mapview.js';

const CHUNK = 160;
export const SKY_TOP = 0x5b8fc7, SKY_HORIZON = 0xc6d9e6;
const COLORS = {
  building: [0.62, 0.6, 0.57], warehouse: [0.5, 0.47, 0.42], farmhouse: [0.72, 0.66, 0.55], barn: [0.55, 0.22, 0.18],
  housewall: [0.54, 0.43, 0.32], ownwall: [0.31, 0.54, 0.35], crate: [1.0, 0.54, 0.16], cover: [0.61, 0.61, 0.58],
  rock: [0.48, 0.48, 0.46], border: [0.17, 0.18, 0.2], car: [0.45, 0.2, 0.2], adobe: [0.78, 0.62, 0.45],
  boulder: [0.44, 0.42, 0.4], cactus: [0.3, 0.5, 0.25], cavewall: [0.38, 0.36, 0.34], caveroof: [0.4, 0.38, 0.35],
  rockwall: [0.62, 0.5, 0.38], logwall: [0.36, 0.25, 0.16], plankwall: [0.55, 0.42, 0.28], jetty: [0.5, 0.38, 0.25],
  roomwall: [0.66, 0.63, 0.58], dam: [0.62, 0.62, 0.6], scrub: [0.35, 0.42, 0.24],
  tower: [0.6, 0.62, 0.64], beacon: [0.9, 0.12, 0.08], tank: [0.86, 0.88, 0.9], fence: [0.56, 0.58, 0.6], equipment: [0.5, 0.55, 0.5],
  pole: [0.38, 0.28, 0.19], solar: [0.12, 0.16, 0.28], marker: [0.95, 0.95, 0.92], hangar: [0.66, 0.68, 0.68], plane: [0.93, 0.93, 0.9], windsock: [1, 0.45, 0.1],
};
// Each real building is painted one colour (picked by its id), so a street isn't all the same.
const HOME_COLORS = [[0.9, 0.88, 0.82], [0.82, 0.8, 0.72], [0.74, 0.79, 0.82], [0.86, 0.8, 0.62], [0.64, 0.72, 0.64], [0.72, 0.62, 0.52], [0.6, 0.62, 0.65], [0.8, 0.72, 0.68], [0.68, 0.44, 0.36], [0.52, 0.58, 0.64]];
const BARN_COLORS = [[0.55, 0.22, 0.18], [0.46, 0.4, 0.34], [0.62, 0.62, 0.6], [0.5, 0.2, 0.16], [0.38, 0.44, 0.38]];
const WAREHOUSE_COLORS = [[0.5, 0.47, 0.42], [0.6, 0.6, 0.58], [0.45, 0.5, 0.54], [0.66, 0.6, 0.48]];
const CIVIC_COLORS = [[0.62, 0.36, 0.28], [0.7, 0.44, 0.33], [0.8, 0.76, 0.68], [0.56, 0.33, 0.27]];
const ROOF_COLORS = [[0.3, 0.28, 0.27], [0.42, 0.24, 0.18], [0.36, 0.37, 0.39], [0.5, 0.5, 0.48], [0.26, 0.3, 0.34]];
const FLOOR_COLORS = { home: [0.5, 0.38, 0.26], farmhouse: [0.5, 0.38, 0.26], barn: [0.42, 0.36, 0.28], civic: [0.56, 0.5, 0.42] };
const FLOOR_DEFAULT = [0.5, 0.5, 0.49];
const VEHICLE_COLORS = { rv: [0.86, 0.84, 0.78], bus: [0.95, 0.72, 0.12], truck: [0.82, 0.82, 0.84], houseboat: [0.55, 0.65, 0.72] };
// North Florida palette: farm fields, pine flatwoods, white sandhills, red-clay hills, river swamp.
const GROUND = {
  plains: [0.4, 0.48, 0.26], forest: [0.24, 0.33, 0.17], desert: [0.85, 0.82, 0.68], mountain: [0.46, 0.4, 0.26],
  swamp: [0.2, 0.26, 0.15], sand: [0.78, 0.72, 0.55], mud: [0.29, 0.26, 0.19], road: [0.24, 0.25, 0.26], dirt: [0.56, 0.47, 0.33], town: [0.3, 0.31, 0.33],
};
const CAR_COLORS = [[0.48, 0.13, 0.13], [0.16, 0.25, 0.42], [0.27, 0.27, 0.27], [0.73, 0.71, 0.6], [0.18, 0.35, 0.23]];
const hash = (id) => (Math.imul(id | 0, 2654435761 | 0) >>> 0);
const pick = (list, id) => list[hash(id) % list.length];

/** An office-style wall: a wide dark window per 4 m of wall. */
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#5a6672'; g.fillRect(10, 14, 44, 30);
  g.fillStyle = '#c9c9c9'; g.fillRect(10, 44, 44, 4);
  return finishTexture(c);
}
/** A house wall: lap siding with one small framed window per 4 m of wall. */
function sidingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e4e4e4'; for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 64, 1);   // siding laps
  g.fillStyle = '#f4f4f4'; g.fillRect(22, 22, 20, 22);                                  // window trim
  g.fillStyle = '#4c5a66'; g.fillRect(24, 24, 16, 18);                                  // glass
  g.fillStyle = '#f4f4f4'; g.fillRect(31, 24, 2, 18); g.fillRect(24, 32, 16, 2);        // sash bars
  return finishTexture(c);
}
function finishTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Append a box (no bottom face) to flat geometry arrays. A turned box is built in its own frame and turned into place. */
export function pushBox(buf, b, color, tile) {
  const turned = b.ang !== undefined;
  const { minX, minZ, maxX, maxZ } = turned ? { minX: -b.hw, minZ: -b.hd, maxX: b.hw, maxZ: b.hd } : b;
  const ca = turned ? b.ca : 1, sa = turned ? b.sa : 0, ox = turned ? b.cx : 0, oz = turned ? b.cz : 0;
  const y0 = b.y0 || 0, h = y0 + b.h;
  const faces = [
    // normal, 4 corners (counter-clockwise from outside), uv size
    [[1, 0, 0], [[maxX, y0, maxZ], [maxX, y0, minZ], [maxX, h, minZ], [maxX, h, maxZ]], maxZ - minZ],
    [[-1, 0, 0], [[minX, y0, minZ], [minX, y0, maxZ], [minX, h, maxZ], [minX, h, minZ]], maxZ - minZ],
    [[0, 0, 1], [[minX, y0, maxZ], [maxX, y0, maxZ], [maxX, h, maxZ], [minX, h, maxZ]], maxX - minX],
    [[0, 0, -1], [[maxX, y0, minZ], [minX, y0, minZ], [minX, h, minZ], [maxX, h, minZ]], maxX - minX],
    [[0, 1, 0], [[minX, h, maxZ], [maxX, h, maxZ], [maxX, h, minZ], [minX, h, minZ]], 0],
    [[0, -1, 0], [[minX, y0, minZ], [maxX, y0, minZ], [maxX, y0, maxZ], [minX, y0, maxZ]], 0],
  ];
  for (const [n, corners, width] of faces) {
    const base = buf.pos.length / 3;
    const top = n[1] === 1;
    corners.forEach(([x, y, z], i) => {
      buf.pos.push(ox + x * ca - z * sa, y, oz + x * sa + z * ca);
      buf.nor.push(n[0] * ca - n[2] * sa, n[1], n[0] * sa + n[2] * ca);
      const shade = top ? 0.85 : 1;
      buf.col.push(color[0] * shade, color[1] * shade, color[2] * shade);
      if (buf.uv) {
        if (!tile || top || width < 1.2) buf.uv.push(0.02, 0.02);   // a plain wall pixel of the texture
        else buf.uv.push(((i === 1 || i === 2) ? width : 0) / tile, (y > y0 ? b.h : 0) / tile);
      }
    });
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
/** A pitched roof over a building record: one per piece of a real building, turned to its walls. */
export function pushRoof(buf, r, color, wall) {
  if (!r.rects) return roofPiece(buf, r.minX, r.minZ, r.maxX, r.maxZ, r.top, color, wall, 1, 0, 0, 0);
  const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
  for (const [x0, z0, x1, z1] of r.rects) roofPiece(buf, x0, z0, x1, z1, r.top, color, wall, ca, sa, r.cx, r.cz);
}
/** Two slopes along the long side and two gable ends, over one rectangle (in its own frame, turned into place). */
function roofPiece(buf, minX, minZ, maxX, maxZ, top, color, wall, ca, sa, cx, cz) {
  const o = 0.4, x0 = minX - o, x1 = maxX + o, z0 = minZ - o, z1 = maxZ + o, y = top;
  const alongX = x1 - x0 >= z1 - z0, span = alongX ? z1 - z0 : x1 - x0, rh = Math.min(3.2, span * 0.38);
  const face = (pts, n, c) => {
    const l = Math.hypot(...n), nn = n.map((v) => v / l), base = buf.pos.length / 3;
    for (const [px, py, pz] of pts) { buf.pos.push(cx + px * ca - pz * sa, py, cz + px * sa + pz * ca); buf.nor.push(nn[0] * ca - nn[2] * sa, nn[1], nn[0] * sa + nn[2] * ca); buf.col.push(...c); if (buf.uv) buf.uv.push(0.02, 0.02); }
    if (pts.length === 4) buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3); else buf.idx.push(base, base + 1, base + 2);
  };
  if (alongX) {
    const zm = (z0 + z1) / 2;
    face([[x1, y, z0], [x0, y, z0], [x0, y + rh, zm], [x1, y + rh, zm]], [0, span / 2, -rh], color);
    face([[x0, y, z1], [x1, y, z1], [x1, y + rh, zm], [x0, y + rh, zm]], [0, span / 2, rh], color);
    face([[x0, y, z0], [x0, y, z1], [x0, y + rh, zm]], [-1, 0, 0], wall);
    face([[x1, y, z1], [x1, y, z0], [x1, y + rh, zm]], [1, 0, 0], wall);
  } else {
    const xm = (x0 + x1) / 2;
    face([[x0, y, z0], [x0, y, z1], [xm, y + rh, z1], [xm, y + rh, z0]], [-rh, span / 2, 0], color);
    face([[x1, y, z1], [x1, y, z0], [xm, y + rh, z0], [xm, y + rh, z1]], [rh, span / 2, 0], color);
    face([[x1, y, z0], [x0, y, z0], [xm, y + rh, z0]], [0, 0, -1], wall);
    face([[x0, y, z1], [x1, y, z1], [xm, y + rh, z1]], [0, 0, 1], wall);
  }
}
export function toGeometry(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  if (buf.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}
const newBuf = (uv) => ({ pos: [], nor: [], col: [], idx: [], ...(uv ? { uv: [] } : {}) });

/**
 * `land` is the coarse whole-map sampling from mapview.sampleLand (heights + land colours).
 * `farRange` is how far out buildings and trees are drawn as simple stand-ins.
 */
const CLAY = [0.52, 0.34, 0.22];
export function createWorldView(scene, map, { viewRange = 300, farRange = 1500, mobile = false, land = null } = {}) {
  const chunks = new Map();      // near: full detail
  const farChunks = new Map();   // far: stand-ins (null where a chunk has nothing to show)
  const terrain = map.terrain;
  let ownHouseId = null;
  const key = (cx, cz) => `${cx},${cz}`;
  // Buildings bucketed by chunk (roofs, floors and their far stand-ins).
  const buildingsIn = new Map();
  for (const r of map.buildings) {
    const k = key(Math.floor((r.minX + r.maxX) / 2 / CHUNK), Math.floor((r.minZ + r.maxZ) / 2 / CHUNK));
    if (!buildingsIn.has(k)) buildingsIn.set(k, []);
    buildingsIn.get(k).push(r);
  }

  const texturedMat = new THREE.MeshStandardMaterial({ map: windowTexture(), vertexColors: true, roughness: 0.9 });
  const sidingMat = new THREE.MeshStandardMaterial({ map: sidingTexture(), vertexColors: true, roughness: 0.95 });
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 1, 6);
  trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.ConeGeometry(1, 1, 7);
  crownGeo.translate(0, 0.5, 0);
  const farCrownGeo = new THREE.ConeGeometry(1, 1, 5, 1, true);
  farCrownGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x2f5129, roughness: 1 });
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x1f3a24, roughness: 1 });
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f6b8a, transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.1 });
  const waterGeo = new THREE.PlaneGeometry(CHUNK, CHUNK);
  waterGeo.rotateX(-Math.PI / 2);
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2d4f25, roughness: 1, flatShading: true });
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 20);
  tankGeo.translate(0, 0.5, 0);
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.6, metalness: 0.2 });
  const shared = new Set([trunkGeo, crownGeo, farCrownGeo, canopyGeo, waterGeo, tankGeo]);
  // Power line wires, strung between the real towers and poles with a little sag.
  if (map.powerLines?.length) {
    const pos = [];
    for (const line of map.powerLines) for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 700 || span < 1) continue;
      const offs = a.pylon && b.pylon ? [-5.4, 0, 5.4] : [-1.1, 0, 1.1], sag = Math.min(8, span * 0.03);
      for (const o of offs) {
        const ax = a.x + Math.cos(a.ang) * o, az = a.z + Math.sin(a.ang) * o, bx = b.x + Math.cos(b.ang) * o, bz = b.z + Math.sin(b.ang) * o;
        let px = ax, py = a.y, pz = az;
        for (let k = 1; k <= 10; k++) {
          const t = k / 10, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
          pos.push(px, py, pz, x, y, z); px = x; py = y; pz = z;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const wires = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x24262a }));
    scene.add(wires);
  }
  // Railway segments bucketed by chunk (drawn with the roads).
  const railIn = new Map();
  for (const r of map.rails || []) for (let i = 0; i < r.pts.length - 1; i++) {
    const [x1, z1] = r.pts[i], [x2, z2] = r.pts[i + 1], seg = { x1, z1, x2, z2, narrow: r.narrow };
    for (let cx = Math.floor(Math.min(x1, x2) / CHUNK); cx <= Math.floor(Math.max(x1, x2) / CHUNK); cx++) for (let cz = Math.floor(Math.min(z1, z2) / CHUNK); cz <= Math.floor(Math.max(z1, z2) / CHUNK); cz++) {
      const k = key(cx, cz);
      if (!railIn.has(k)) railIn.set(k, []);
      railIn.get(k).push(seg);
    }
  }

  // ------------------------------------------------------------------ the far scene
  const far = new THREE.Scene();
  far.fog = new THREE.Fog(SKY_HORIZON, 4000, 70000);   // only a trace of haze where the land meets the sky
  far.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a3530, 0.85));
  const farSun = new THREE.DirectionalLight(0xfff1dc, 2.0);
  farSun.position.set(62, 46, 38);
  far.add(farSun);
  const farMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const farRoofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const farCrownMat = new THREE.MeshLambertMaterial({ color: 0x2f5129 });
  const farPineMat = new THREE.MeshLambertMaterial({ color: 0x1f3a24 });
  // Sky: a dome that follows you, pale at the horizon and blue overhead.
  const skyGeo = new THREE.SphereGeometry(50000, 24, 12);
  {
    const top = new THREE.Color(SKY_TOP), hor = new THREE.Color(SKY_HORIZON), c = new THREE.Color(), p = skyGeo.attributes.position, col = [];
    for (let i = 0; i < p.count; i++) { c.copy(hor).lerp(top, Math.pow(Math.max(0, p.getY(i) / 50000), 0.55)); col.push(c.r, c.g, c.b); }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.renderOrder = -10;
  far.add(sky);
  // Water for the whole map (the near chunks carry their own).
  const farWater = new THREE.Mesh(new THREE.PlaneGeometry(map.size + 2000, map.size + 2000), new THREE.MeshLambertMaterial({ color: 0x2f6b8a, transparent: true, opacity: 0.9 }));
  farWater.rotation.x = -Math.PI / 2;
  far.add(farWater);
  // The whole county's ground, from the coarse land samples.
  if (land) {
    const n = land.n, pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, h = land.h[k];
      pos[k * 3] = -map.half + i * land.step; pos[k * 3 + 1] = Math.max(h, -8); pos[k * 3 + 2] = -map.half + j * land.step;
      const wet = h < 0;
      col[k * 3] = wet ? GROUND.mud[0] : land.rgb[k * 3] / 255; col[k * 3 + 1] = wet ? GROUND.mud[1] : land.rgb[k * 3 + 1] / 255; col[k * 3 + 2] = wet ? GROUND.mud[2] : land.rgb[k * 3 + 2] / 255;
    }
    let q = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    far.add(new THREE.Mesh(g, farMat));
  }

  /** Ground colour from biome, height and roads/towns. */
  function groundColor(x, z, h) {
    for (const t of map.towns) { const r = t.rect; if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return GROUND.town; }
    // (Roads aren't tinted into the ground any more: the ground has a point only every 8 m, so a
    // tint smeared each road two or three times its width. Roads are their own surface on top.)
    if (h < -0.3) return GROUND.mud;
    const b = terrain.biome(x, z);
    if (h < 0.7 && b.sea < 0.5) return GROUND.sand;
    const c = [0, 0, 0];
    for (const k of ['plains', 'forest', 'desert', 'mountain']) for (let i = 0; i < 3; i++) c[i] += GROUND[k][i] * b[k];
    for (let i = 0; i < 3; i++) c[i] += GROUND.swamp[i] * b.sea;
    const cc = coverColor(terrain, x, z);   // the real woods, fields, pasture and lawns
    if (cc) for (let i = 0; i < 3; i++) c[i] = cc[i] / 255 * 0.85 + c[i] * 0.15;
    return c;
  }
  // Roads are their own surface laid on the ground, so they stay crisp (the ground mesh has a point
  // only every 8 m, which smeared a 6 m road into the grass). Asphalt with a yellow centre line on
  // main roads, a double line on state routes, brown on dirt tracks.
  const STRIP_COL = { turf: [0.5, 0.6, 0.31], paint: [0.94, 0.94, 0.9] };
  const RAIL_COL = { bed: [0.45, 0.42, 0.38], tie: [0.3, 0.22, 0.16], steel: [0.62, 0.6, 0.58] };
  const ROAD_COL = { asphalt: [0.27, 0.28, 0.3], route: [0.25, 0.26, 0.28], dirt: [0.55, 0.45, 0.31], line: [0.92, 0.74, 0.2], edge: [0.85, 0.85, 0.82] };
  const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  /** Height of the drawn ground mesh itself (the same 8 m triangles), so a road never sinks into it. */
  function meshHeight(x, z) {
    const S = 8, i = Math.floor(x / S), j = Math.floor(z / S), fx = x / S - i, fz = z / S - j;
    const h = (a, b) => terrain.drawn(a * S, b * S);
    if (fx + fz <= 1) { const ha = h(i, j); return ha + (h(i + 1, j) - ha) * fx + (h(i, j + 1) - ha) * fz; }
    const hd = h(i + 1, j + 1); return hd + (h(i, j + 1) - hd) * (1 - fx) + (h(i + 1, j) - hd) * (1 - fz);
  }
  function buildRoads(x0, z0) {
    const pos = [], col = [], idx = [];
    const strip = (pts, half, c, lift) => {
      // pts: [[x, z], ...] along the road; a band `half` metres either side of it.
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, nx = -dz / l * half, nz = dx / l * half;
        const base = pos.length / 3;
        for (const [x, z] of [[ax + nx, az + nz], [ax - nx, az - nz], [bx + nx, bz + nz], [bx - nx, bz - nz]]) {
          const hg = meshHeight(x, z);
          pos.push(x, Math.max(hg, terrain.drawn(x, z)) + lift, z);
          col.push(c[0], c[1], c[2]);
        }
        idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    };
    for (const r of map.roadGrid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK, [], true)) {
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      if (len < 0.5) continue;
      const w = r.width || 12, n = Math.max(1, Math.ceil(len / 4));
      const pt = (t) => [r.x1 + (r.x2 - r.x1) * t, r.z1 + (r.z2 - r.z1) * t];
      // Only the pieces whose middle lies in this chunk (each piece is drawn once), and none over water
      // (bridges have their own deck). The road runs a little past each end so joints don't gap.
      const ext = Math.min(0.5, (w / 2) / len);
      let run = [];
      const flush = () => { if (run.length > 1) runs.push(run); run = []; };
      const runs = [];
      for (let k = 0; k < n; k++) {
        const t0 = k / n - (k === 0 ? ext : 0), t1 = (k + 1) / n + (k === n - 1 ? ext : 0), [mx, mz] = pt((t0 + t1) / 2);
        const inside = mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK && terrain.drawn(mx, mz) > 0.15;
        if (!inside) { flush(); continue; }
        if (!run.length) run.push(pt(t0));
        run.push(pt(t1));
      }
      flush();
      const surface = r.dirt ? ROAD_COL.dirt : r.hw ? ROAD_COL.route : ROAD_COL.asphalt;
      for (const pts of runs) {
        strip(pts, w / 2, surface, 0.06);
        if (r.dirt || w < 8) continue;
        if (r.hw) {
          // State route: white edge lines and a double yellow line down the middle.
          const ux = (r.x2 - r.x1) / len, uz = (r.z2 - r.z1) / len, off = (d) => pts.map(([x, z]) => [x - uz * d, z + ux * d]);
          for (const d of [w / 2 - 0.5, -(w / 2 - 0.5)]) strip(off(d), 0.12, ROAD_COL.edge, 0.08);
          for (const d of [0.18, -0.18]) strip(off(d), 0.08, ROAD_COL.line, 0.08);
        }
        else {
          // A dashed centre line: 3 m painted, 3 m gap.
          for (let k = 0; k < pts.length - 1; k += 2) strip([pts[k], [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2]], 0.13, ROAD_COL.line, 0.08);
        }
      }
    }
    // Railways: a gravel bed, cross-ties, and two steel rails.
    for (const r of railIn.get(key(Math.floor(x0 / CHUNK), Math.floor(z0 / CHUNK))) || []) {
      const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
      if (len < 0.5) continue;
      const ux = (r.x2 - r.x1) / len, uz = (r.z2 - r.z1) / len, n = Math.max(1, Math.ceil(len / 3));
      const pt = (t) => [r.x1 + (r.x2 - r.x1) * t, r.z1 + (r.z2 - r.z1) * t];
      const runs = [];
      let run = [];
      for (let k = 0; k < n; k++) {
        const [mx, mz] = pt((k + 0.5) / n);
        if (!(mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK && terrain.drawn(mx, mz) > 0.15)) { if (run.length > 1) runs.push(run); run = []; continue; }
        if (!run.length) run.push(pt(k / n));
        run.push(pt((k + 1) / n));
      }
      if (run.length > 1) runs.push(run);
      const gauge = r.narrow ? 0.45 : 0.72, off = (d, pts) => pts.map(([x, z]) => [x - uz * d, z + ux * d]);
      for (const pts of runs) {
        strip(pts, r.narrow ? 1.1 : 1.8, RAIL_COL.bed, 0.1);
        for (let k = 0; k < pts.length - 1; k++) for (const f of [0, 0.5]) {
          const x = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, z = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f, w = gauge + 0.45;
          strip([[x - ux * 0.13, z - uz * 0.13], [x + ux * 0.13, z + uz * 0.13]], w, RAIL_COL.tie, 0.16);
        }
        for (const d of [gauge, -gauge]) strip(off(d, pts), 0.05, RAIL_COL.steel, 0.24);
      }
    }
    // Airstrips: a mown runway with white bars across each end.
    for (const a of map.airstrips || []) {
      if (Math.max(a.x1, a.x2) + a.width < x0 || Math.min(a.x1, a.x2) - a.width > x0 + CHUNK || Math.max(a.z1, a.z2) + a.width < z0 || Math.min(a.z1, a.z2) - a.width > z0 + CHUNK) continue;
      const len = Math.hypot(a.x2 - a.x1, a.z2 - a.z1), ux = (a.x2 - a.x1) / len, uz = (a.z2 - a.z1) / len, n = Math.ceil(len / 4);
      const pt = (d) => [a.x1 + ux * d, a.z1 + uz * d], inside = ([x, z]) => x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK;
      let run = [];
      const flush = () => { if (run.length > 1) strip(run, a.width / 2, STRIP_COL.turf, 0.07); run = []; };
      for (let k = 0; k < n; k++) { const d0 = k * len / n, d1 = (k + 1) * len / n; if (!inside(pt((d0 + d1) / 2))) { flush(); continue; } if (!run.length) run.push(pt(d0)); run.push(pt(d1)); }
      flush();
      for (const d of [6, 9, len - 9, len - 6]) { const c = pt(d); if (inside(c)) strip([[c[0] - ux * 0.6, c[1] - uz * 0.6], [c[0] + ux * 0.6, c[1] + uz * 0.6]], a.width / 2 - 1, STRIP_COL.paint, 0.09); }
    }
    if (!idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, roadMat);
    m.receiveShadow = true;
    return m;
  }
  /** One chunk's ground; `wet` comes back true if any of it is under water. */
  function buildTerrain(x0, z0) {
    const STEP = 8, N = CHUNK / STEP;
    const pos = [], col = [], idx = [];
    let wet = false;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = x0 + i * STEP, z = z0 + j * STEP;
      const h = terrain.drawn(x, z);
      if (h < 0.15) wet = true;
      pos.push(x, h, z);
      let c = groundColor(x, z, h);
      // Slopes: bare red clay on the steep faces (bluffs, ravines, river banks), as in the real county.
      const sl = Math.hypot(terrain.drawn(x + STEP, z) - terrain.drawn(x - STEP, z), terrain.drawn(x, z + STEP) - terrain.drawn(x, z - STEP)) / (2 * STEP);
      if (h > 0.4 && sl > 0.18) { const k = Math.min(1, (sl - 0.18) / 0.4) * 0.7; c = [c[0] + (CLAY[0] - c[0]) * k, c[1] + (CLAY[1] - c[1]) * k, c[2] + (CLAY[2] - c[2]) * k]; }
      const v = 0.94 + (((i * 7 + j * 13) % 5) / 40);
      col.push(c[0] * v, c[1] * v, c[2] * v);
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, terrainMat);
    m.receiveShadow = true;
    return { mesh: m, wet };
  }

  // Highway bridges: a deck with railings on piers, following the road from bank to bank. It goes
  // in both scenes, so you see it from across the county and stand on it up close.
  {
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x7a7c80, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.6, metalness: 0.4 });
    for (const br of map.bridges || []) {
      const g = new THREE.Group();
      for (let i = 0; i < br.path.length - 1; i++) {
        const [x1, z1] = br.path[i], [x2, z2] = br.path[i + 1], len = Math.hypot(x2 - x1, z2 - z1);
        if (len < 0.5) continue;
        const span = new THREE.Group();
        const deck = new THREE.Mesh(new THREE.BoxGeometry(9.4, 0.7, len + 0.6), deckMat);
        deck.position.y = -0.33;
        span.add(deck);
        for (const sx of [-4.55, 4.55]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.05, len + 0.6), railMat); rail.position.set(sx, 0.55, 0); span.add(rail); }
        // Piers stand wherever the deck is over the river or its banks.
        for (let k = 8; k < len - 2; k += 16) {
          const px = x1 + (x2 - x1) * k / len, pz = z1 + (z2 - z1) * k / len, bed = terrain.exact(px, pz, true);
          if (bed > BRIDGE_DECK - 1.5) continue;
          const hgt = BRIDGE_DECK - 0.6 - (bed - 0.5);
          const pier = new THREE.Mesh(new THREE.BoxGeometry(7, hgt, 1.2), deckMat);
          pier.position.set(0, -0.6 - hgt / 2, k - len / 2);
          span.add(pier);
        }
        span.position.set((x1 + x2) / 2, BRIDGE_DECK + 0.02, (z1 + z2) / 2);
        span.rotation.y = Math.atan2(x2 - x1, z2 - z1);
        g.add(span);
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(g);
      far.add(g.clone());
    }
  }

  /** Colour, and which wall texture, for a box. */
  function paint(b) {
    const id = b.bldg ?? b.id;
    switch (b.type) {
      case 'building': { const c = COLORS.building, v = hash(id) / 4294967296; return [[c[0] + (v - 0.5) * 0.15, c[1] + (v - 0.5) * 0.12, c[2] + (v - 0.5) * 0.1], 'office']; }
      case 'civic': return [pick(CIVIC_COLORS, id), 'office'];
      case 'home': return [pick(HOME_COLORS, id), 'siding'];
      case 'barn': return [b.real ? pick(BARN_COLORS, id) : COLORS.barn, null];
      case 'warehouse': return [b.real ? pick(WAREHOUSE_COLORS, id) : COLORS.warehouse, null];
      case 'car': return [CAR_COLORS[b.id % CAR_COLORS.length], null];
      case 'vehiclebody': return [VEHICLE_COLORS[b.vtype] || COLORS.cover, null];
      case 'housewall': return [b.houseId === ownHouseId ? COLORS.ownwall : COLORS.housewall, null];
      default: return [COLORS[b.type] || COLORS.cover, null];
    }
  }
  const wallColor = (r) => paint({ type: r.type, bldg: r.bldg, real: r.real, id: r.bldg })[0];
  const ownChunk = (b, x0, z0) => { const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2; return mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK; };

  function buildChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const list = map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK).filter((b) => ownChunk(b, x0, z0));
    const office = newBuf(true), siding = newBuf(true), plain = newBuf(false), roof = newBuf(false);
    const trees = [], pines = [], canopies = [], tanks = [];
    for (const b of list) {
      if (b.type === 'terminal' || b.type === 'rail') continue;   // drawn separately (terminals change; rails are the bridge's)
      if (b.type === 'tree') { trees.push(b); continue; }
      if (b.type === 'pine') { pines.push(b); continue; }
      if (b.type === 'canopy') { canopies.push(b); continue; }
      if (b.type === 'tank') { tanks.push(b); continue; }
      const [c, tex] = paint(b);
      pushBox(tex === 'office' ? office : tex === 'siding' ? siding : plain, b, c, tex ? 4 : 0);
    }
    for (const r of buildingsIn.get(key(cx, cz)) || []) {
      if (r.roof) pushRoof(roof, r, pick(ROOF_COLORS, r.bldg), wallColor(r));
      // A floor on the building's level pad (real buildings; the others stand on town paving).
      if (r.pad !== undefined && r.rects) {
        const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
        for (const [x0, z0, x1, z1] of r.rects) {
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          pushBox(plain, { ang: r.ang, ca, sa, cx: r.cx + mx * ca - mz * sa, cz: r.cz + mx * sa + mz * ca, hw: (x1 - x0) / 2 - 0.2, hd: (z1 - z0) / 2 - 0.2, y0: r.pad - 0.3, h: 0.34 }, FLOOR_COLORS[r.type] || FLOOR_DEFAULT, 0);
        }
      } else if (r.pad !== undefined) pushBox(plain, { minX: r.minX + 0.2, minZ: r.minZ + 0.2, maxX: r.maxX - 0.2, maxZ: r.maxZ - 0.2, y0: r.pad - 0.3, h: 0.34 }, FLOOR_COLORS[r.type] || FLOOR_DEFAULT, 0);
    }
    const group = new THREE.Group();
    const ground = buildTerrain(x0, z0);
    group.add(ground.mesh);
    const roads = map.roadGrid && buildRoads(x0, z0);
    if (roads) group.add(roads);
    if (ground.wet) { const w = new THREE.Mesh(waterGeo, waterMat); w.position.set(x0 + CHUNK / 2, 0, z0 + CHUNK / 2); group.add(w); }
    for (const [buf, mat] of [[office, texturedMat], [siding, sidingMat], [plain, plainMat], [roof, roofMat]]) {
      if (!buf.idx.length) continue;
      const m = new THREE.Mesh(toGeometry(buf), mat);
      m.castShadow = true;
      m.receiveShadow = mat !== roofMat;
      group.add(m);
    }
    const forest = (list, crownMaterial, wide) => {
      if (!list.length) return;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMaterial, list.length);
      const m = new THREE.Matrix4();
      list.forEach((t, i) => {
        const x = (t.minX + t.maxX) / 2, z = (t.minZ + t.maxZ) / 2, y = t.y0 || 0, h = t.h;
        m.makeScale(1, h * 0.45, 1).setPosition(x, y, z);
        trunks.setMatrixAt(i, m);
        const w = wide + (t.id % 5) * 0.25;
        m.makeScale(w, h * 0.75, w).setPosition(x, y + h * 0.28, z);
        crowns.setMatrixAt(i, m);
      });
      trunks.castShadow = crowns.castShadow = !mobile;
      group.add(trunks, crowns);
    };
    forest(trees, crownMat, 2.2);
    forest(pines, pineMat, 1.4);
    for (const t of tanks) {   // water tower tanks and storage tanks are round
      const m = new THREE.Mesh(tankGeo, tankMat);
      m.position.set((t.minX + t.maxX) / 2, t.y0, (t.minZ + t.maxZ) / 2);
      m.scale.set((t.maxX - t.minX) / 2, t.h, (t.maxZ - t.minZ) / 2);
      m.castShadow = true;
      group.add(m);
    }
    for (const c of canopies) {
      const m = new THREE.Mesh(canopyGeo, canopyMat);
      m.position.set((c.minX + c.maxX) / 2, c.y0 + c.h / 2, (c.minZ + c.maxZ) / 2);
      m.scale.set((c.maxX - c.minX) / 2, c.h / 2, (c.maxZ - c.minZ) / 2);
      m.castShadow = true;
      group.add(m);
    }
    scene.add(group);
    return group;
  }

  // ------------------------------------------------------------------ far stand-ins
  // The trees of a countryside tile, worked out on the side (not loaded into the world) and kept
  // for a while so neighbouring chunks can share them.
  const tileTrees = new Map();
  function treesOfTile(tx, tz) {
    const k = tx * 100000 + tz;
    let list = tileTrees.get(k);
    if (!list) {
      list = map.natureTile(tx, tz);
      tileTrees.set(k, list);
      if (tileTrees.size > 900) for (const old of tileTrees.keys()) { tileTrees.delete(old); if (tileTrees.size <= 700) break; }
    }
    return list;
  }
  const FAR_SKIP = new Set(['terminal', 'rail', 'border', 'cover', 'rock', 'car', 'crate', 'scrub', 'cactus', 'boulder', 'jetty', 'canopy', 'caveroof']);
  /** The same buildings as plain boxes with their roofs, and the trees as bare crowns. No ground. */
  function buildFar(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const boxes = newBuf(false), roof = newBuf(false);
    for (const b of map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK, [], true)) {
      if (b.nature || FAR_SKIP.has(b.type) || !ownChunk(b, x0, z0)) continue;
      pushBox(boxes, b, paint(b)[0], 0);
    }
    for (const r of buildingsIn.get(key(cx, cz)) || []) if (r.roof) pushRoof(roof, r, pick(ROOF_COLORS, r.bldg), wallColor(r));
    const T = map.natureTileSize, trees = [], pines = [];
    for (let tx = Math.floor((x0 + map.half) / T); tx <= Math.floor((x0 + CHUNK + map.half) / T); tx++) {
      for (let tz = Math.floor((z0 + map.half) / T); tz <= Math.floor((z0 + CHUNK + map.half) / T); tz++) {
        for (const t of treesOfTile(tx, tz)) if (ownChunk(t, x0, z0)) (t.type === 'pine' ? pines : trees).push(t);
      }
    }
    if (!boxes.idx.length && !roof.idx.length && !trees.length && !pines.length) return null;
    const group = new THREE.Group();
    if (boxes.idx.length) group.add(new THREE.Mesh(toGeometry(boxes), farMat));
    if (roof.idx.length) group.add(new THREE.Mesh(toGeometry(roof), farRoofMat));
    const m = new THREE.Matrix4();
    for (const [list, mat, wide] of [[trees, farCrownMat, 2.2], [pines, farPineMat, 1.4]]) {
      if (!list.length) continue;
      const crowns = new THREE.InstancedMesh(farCrownGeo, mat, list.length);
      list.forEach((t, i) => {
        const w = wide + (t.id % 5) * 0.25;
        m.makeScale(w, t.h * 0.75, w).setPosition((t.minX + t.maxX) / 2, t.y0 + t.h * 0.28, (t.minZ + t.maxZ) / 2);
        crowns.setMatrixAt(i, m);
      });
      group.add(crowns);
    }
    far.add(group);
    return group;
  }

  function dispose(group, from = scene) {
    from.remove(group);
    group.traverse((o) => { if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
  }
  /** Chunks whose nearest point is within `range` of (px, pz), nearest first. */
  function chunksWithin(px, pz, range) {
    const r = Math.ceil(range / CHUNK), ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK), out = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const cx = ccx + i, cz = ccz + j;
      if (Math.abs(cx * CHUNK + CHUNK / 2) > map.half + CHUNK || Math.abs(cz * CHUNK + CHUNK / 2) > map.half + CHUNK) continue;   // off the map
      const nx = Math.max(cx * CHUNK, Math.min(px, (cx + 1) * CHUNK)), nz = Math.max(cz * CHUNK, Math.min(pz, (cz + 1) * CHUNK));
      const d = Math.hypot(nx - px, nz - pz);
      if (d <= range) out.push([d, cx, cz]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  return {
    /** The far scene: draw it first with a long-range camera at the same place, then clear depth. */
    far,
    setOwnHouse(id) {
      if (id === ownHouseId) return;
      ownHouseId = id;
      for (const g of chunks.values()) dispose(g);
      chunks.clear();
    },
    update(px, pz) {
      sky.position.set(px, 0, pz);
      const want = new Set();
      let built = 0;
      for (const [, cx, cz] of chunksWithin(px, pz, viewRange)) {
        const k = key(cx, cz);
        want.add(k);
        if (chunks.has(k) || built >= (chunks.size < 4 ? 9 : 2)) continue;    // spread chunk building over frames
        chunks.set(k, buildChunk(cx, cz));
        built++;
      }
      for (const [k, g] of chunks) if (!want.has(k)) { dispose(g); chunks.delete(k); }
      // Far stand-ins: built a few a frame, shown only where the full-detail chunk isn't.
      const wantFar = new Set();
      built = 0;
      for (const [, cx, cz] of chunksWithin(px, pz, farRange)) {
        const k = key(cx, cz);
        wantFar.add(k);
        if (!farChunks.has(k) && built < 3) { farChunks.set(k, buildFar(cx, cz)); built++; }
        const g = farChunks.get(k);
        if (g) g.visible = !chunks.has(k);
      }
      for (const [k, g] of farChunks) if (!wantFar.has(k)) { if (g) dispose(g, far); farChunks.delete(k); }
    },
    get chunkCount() { return chunks.size; },
    get farChunkCount() { return farChunks.size; },
  };
}
