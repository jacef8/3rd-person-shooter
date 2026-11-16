// Draws the 30 km world around the player, with no fog wall.
//  Near: 160 m chunks holding everything (ground, buildings, trees), built as you approach and freed
//        behind you, so the GPU only ever holds a few hundred metres of detail — fine even on a phone.
//  Far:  the whole county's ground as one coarse mesh under a sky, plus plain stand-ins for buildings
//        and trees out to about a mile. main.js draws the far scene first and the near world over
//        it (the depth buffer is cleared in between), so the two can never fight over depth.
import * as THREE from 'three';
import { mergeGeometries } from '/addons/utils/BufferGeometryUtils.js';
import { Sky } from '/addons/objects/Sky.js';
import { coverColor } from './mapview.js';
import TREE_ATLAS from '/textures/trees.json' with { type: 'json' };
import { buildWreck, buildHomeVehicle } from '/ridemodels.js';

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
  pole: [0.38, 0.28, 0.19], solar: [0.12, 0.16, 0.28], counter: [0.42, 0.3, 0.2], rack: [0.3, 0.22, 0.15], marker: [0.95, 0.95, 0.92], hangar: [0.66, 0.68, 0.68], plane: [0.93, 0.93, 0.9], windsock: [1, 0.45, 0.1],
};
// Each real building is painted one colour (picked by its id), so a street isn't all the same.
const HOME_COLORS = [[0.9, 0.88, 0.82], [0.82, 0.8, 0.72], [0.74, 0.79, 0.82], [0.86, 0.8, 0.62], [0.64, 0.72, 0.64], [0.72, 0.62, 0.52], [0.6, 0.62, 0.65], [0.8, 0.72, 0.68], [0.68, 0.44, 0.36], [0.52, 0.58, 0.64]];
const BARN_COLORS = [[0.55, 0.22, 0.18], [0.46, 0.4, 0.34], [0.62, 0.62, 0.6], [0.5, 0.2, 0.16], [0.38, 0.44, 0.38]];
const WAREHOUSE_COLORS = [[0.5, 0.47, 0.42], [0.6, 0.6, 0.58], [0.45, 0.5, 0.54], [0.66, 0.6, 0.48]];
const BRICK_COLORS = [[0.64, 0.31, 0.24], [0.56, 0.27, 0.21], [0.72, 0.43, 0.32], [0.8, 0.68, 0.54], [0.5, 0.33, 0.27], [0.62, 0.38, 0.3]];
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
/** A storefront or town-hall wall: running-bond brick with one framed window per 4 m bay. */
function brickTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c8c3bd';                                                       // mortar
  for (let y = 0; y < 64; y += 5) {
    g.fillRect(0, y, 64, 1);
    for (let x = (y / 5) % 2 ? 6 : 0; x < 64; x += 12) g.fillRect(x, y, 1, 5);
  }
  g.fillStyle = '#ece8e2'; g.fillRect(16, 20, 32, 26);                            // window surround
  g.fillStyle = '#3e4a55'; g.fillRect(18, 22, 28, 22);                            // glass
  g.fillStyle = '#ece8e2'; g.fillRect(31, 22, 2, 22);                             // mullion
  return finishTexture(c);
}
/** A barn or warehouse wall: ribbed metal siding, no windows. */
function metalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  for (let x = 0; x < 64; x += 8) { g.fillStyle = '#d9d9d9'; g.fillRect(x, 0, 2, 64); g.fillStyle = '#f2f2f2'; g.fillRect(x + 2, 0, 2, 64); }
  g.fillStyle = '#cfcfcf'; g.fillRect(0, 62, 64, 2);                                // base trim
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
export function createWorldView(scene, map, { viewRange: view0 = 300, farRange: far0 = 1500, mobile = false, land = null } = {}) {
  let viewRange = view0, farRange = far0;   // changeable while playing (the Graphics setting)
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
  // Walls in photo-scanned materials (Poly Haven, CC0): real brick, corrugated metal, weathered planks,
  // each with its normal map. The building's own colour tints them (a red barn, a white shed), half way.
  const wallTex = (name, rep) => { const t = new THREE.TextureLoader().load(`/textures/pbr/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = mobile ? 2 : 4; return t; };
  const wallNor = (name, rep) => { if (mobile) return null; const t = new THREE.TextureLoader().load(`/textures/pbr/${name}_n.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); return t; };
  const photoWall = (name, rep, tint, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({ map: wallTex(name, rep), normalMap: wallNor(name, rep), vertexColors: true, roughness: 0.92, ...extra });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#if defined( USE_COLOR )
  { float vl = max(dot(vColor.rgb, vec3(0.3, 0.59, 0.11)), 0.05); diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb / vl * 0.62, ${tint.toFixed(2)}) * 1.25; }
#endif`);
    };
    return m;
  };
  const brickMat = photoWall('brick', 2.4, 0.25);
  const metalMat = photoWall('metal', 2, 0.65, { roughness: 0.55, metalness: 0.3 });
  const plankMat = photoWall('planks', 2, 0.35, { color: new THREE.Color(1.8, 1.7, 1.6) });   // the plank photo is dark weathered wood: lift it
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  // Roofs: corrugated metal (as on most of rural Florida), laid in world space down the slopes, in the
  // roof's own colour.
  const roofTex = wallTex('metal', 1), roofNor = wallNor('metal', 1);
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25, side: THREE.DoubleSide });
  roofMat.onBeforeCompile = (sh) => {
    sh.uniforms.uRoof = { value: roofTex };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoofP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoofP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uRoof;\nvarying vec3 vRoofP;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  { vec3 t = texture2D(uRoof, vRoofP.xz / 1.8).rgb; float tl = dot(t, vec3(0.3, 0.59, 0.11)) / 0.18; diffuseColor.rgb *= mix(1.0, tl, 0.85); }`);
  };
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 9);
  trunkGeo.translate(0, 0.5, 0);
  // Crowns: a broadleaf is a few overlapping rounded clumps; a pine is three stacked tiers. Unit-sized,
  // scaled per tree like before (crown base at 0, top at 1).
  const blob = (r, x, y, z) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z);
  const crownGeo = mergeGeometries([blob(0.62, 0, 0.45, 0), blob(0.48, 0.36, 0.36, 0.1), blob(0.46, -0.3, 0.4, -0.18), blob(0.42, 0.05, 0.72, -0.05), blob(0.4, -0.08, 0.3, 0.38)]);
  const tier = (r, y0, h) => new THREE.ConeGeometry(r, h, 10).translate(0, y0 + h / 2, 0);
  const pineGeo = mergeGeometries([tier(1, 0, 0.5), tier(0.78, 0.3, 0.45), tier(0.52, 0.58, 0.42)]);
  const farCrownGeo = new THREE.ConeGeometry(1, 1, 5, 1, true);
  farCrownGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });   // colour per tree (instance colours)
  const pineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  const LEAF = [0x3b6532, 0x467236, 0x3f6a33, 0x4f7a38, 0x37602f], NEEDLE = [0x27482c, 0x2d5132, 0x24432a, 0x325836];
  // Photo trees: the pines, live oak and oak cut from real pictures (tools/build_tree_atlas.py), each
  // drawn as two crossed picture cards. One sheet holds all six; each tree says which part it uses.
  const treeTex = new THREE.TextureLoader().load('/textures/trees.webp');
  treeTex.colorSpace = THREE.SRGBColorSpace; treeTex.anisotropy = 4;
  const PHOTO = { pine: TREE_ATLAS.trees.filter((t) => t.kind === 'pine'), tree: TREE_ATLAS.trees.filter((t) => t.kind === 'tree') };
  const cardGeo = (() => {
    // Two upright planes crossed at right angles, each with a face both ways (so neither side goes
    // dark), every normal pointing up: the leaves are lit like the canopy from above.
    const P = [], N = [], U = [], I = [];
    const quad = (ax, az, bx, bz, flip) => {
      const o = P.length / 3;
      P.push(ax, 0, az, bx, 0, bz, bx, 1, bz, ax, 1, az);
      for (let k = 0; k < 4; k++) N.push(0, 1, 0);
      U.push(0, 0, 1, 0, 1, 1, 0, 1);
      if (flip) I.push(o, o + 2, o + 1, o, o + 3, o + 2); else I.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    quad(-0.5, 0, 0.5, 0, false);   // one picture; the shader turns it to face you (below)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    return g;
  })();
  /** Each tree's own part of the sheet, as an attribute per instance. */
  // Each tree is one picture that always turns to face you round its trunk, so from wherever you
  // stand it's a whole, round tree (never two flat cards crossed). Its shadow turns to the sun.
  const atlasUv = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTreeUv;\nvec3 bbWorld;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * aTreeUv.zw + aTreeUv.xy;\n#endif')
      .replace('#include <project_vertex>', `
  vec4 mvPosition;
  {
    vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float w = length(instanceMatrix[0].xyz), h = length(instanceMatrix[1].xyz);
    vec3 toCam = cameraPosition - c; toCam.y = 0.0;
    float l = length(toCam); toCam = l > 1e-4 ? toCam / l : vec3(0.0, 0.0, 1.0);
    vec3 side = vec3(toCam.z, 0.0, -toCam.x);
    bbWorld = c + side * transformed.x * w + vec3(0.0, transformed.y * h, 0.0);
    mvPosition = viewMatrix * vec4(bbWorld, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }`)
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(bbWorld, 1.0);');
  };
  const photoMat = new THREE.MeshStandardMaterial({ map: treeTex, alphaTest: 0.42, roughness: 1, metalness: 0, alphaToCoverage: true });
  photoMat.onBeforeCompile = atlasUv;
  const photoFarMat = new THREE.MeshLambertMaterial({ map: treeTex, alphaTest: 0.42 });
  photoFarMat.onBeforeCompile = atlasUv;
  const photoDepth = new THREE.MeshDepthMaterial({ map: treeTex, alphaTest: 0.42, depthPacking: THREE.RGBADepthPacking });
  photoDepth.onBeforeCompile = atlasUv;
  /** An instanced batch of photo trees: [{ x, y, z, h, kind, id }] -> mesh (and each tree's card size). */
  function photoTrees(list, mat) {
    const geo = cardGeo.clone(), uvs = new Float32Array(list.length * 4);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const tint = new THREE.Color();
    list.forEach((t, i) => {
      const v = PHOTO[t.kind][(t.id * 7 + 3) % PHOTO[t.kind].length];
      uvs.set([v.u, v.v, v.w, v.h], i * 4);
      t.cardH = t.h * (t.kind === 'pine' ? 1.18 : 1.05); t.cardW = t.cardH * v.aspect; t.cardYaw = ((t.id * 2.399) % Math.PI);
      const k = 0.84 + ((t.id * 13) % 9) * 0.03;
      im.setColorAt(i, tint.setRGB(k, k, k * 0.97));
    });
    geo.setAttribute('aTreeUv', new THREE.InstancedBufferAttribute(uvs, 4));
    return im;
  }
  const cardQ = new THREE.Quaternion(), cardS = new THREE.Vector3(), cardP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const cardMatrix = (m, x, y, z, w, h, yaw) => m.compose(cardP.set(x, y, z), cardQ.setFromAxisAngle(UP, yaw), cardS.set(w, h, w));
  // Water: small waves rolling across it (worked out per pixel from where it is and the time), and the
  // sky showing in it more the flatter you look across it, like the real thing.
  const waterTime = { value: 0 };
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x22566e, transparent: true, opacity: 0.86, roughness: 0.08, metalness: 0.05 });
  waterMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWaterP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWaterP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uTime;
varying vec3 vWaterP;
vec2 dzWave(vec2 p, vec2 dir, float k, float sp, float a) { float ph = dot(p, dir) * k + uTime * sp; return dir * cos(ph) * a * k; }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{ vec2 q = vWaterP.xz;
  vec2 g = dzWave(q, normalize(vec2(1.0, 0.35)), 0.55, 1.6, 0.05) + dzWave(q, normalize(vec2(-0.4, 1.0)), 0.9, 2.1, 0.03)
         + dzWave(q, normalize(vec2(0.7, -0.7)), 1.7, 2.9, 0.015) + dzWave(q, normalize(vec2(-1.0, -0.2)), 3.1, 3.7, 0.008);
  vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
  totalEmissiveRadiance += vec3(0.55, 0.68, 0.8) * fres * 0.75; }`);
  };
  const waterGeo = new THREE.PlaneGeometry(CHUNK, CHUNK);
  waterGeo.rotateX(-Math.PI / 2);
  // The ground: smooth shading, and fine colour variation worked out per pixel from where it is (patches
  // of lighter and darker grass, soil showing through) so it reads as ground, not flat-coloured tiles.
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  // Photo-scanned ground (Poly Haven, CC0; client/textures/pbr): grass, forest floor, leaf litter and
  // sand, with their normal maps, laid in world space and blended by what the land really is there
  // (each corner of the ground mesh says how much of each, from the land cover). The land's own colour
  // still tints it, so fields, woods and sandhills keep their look from the map. Phones get the
  // colours without the normal maps.
  const texLoader = new THREE.TextureLoader();
  const pbr = (name, srgb = true) => { const t = texLoader.load(`/textures/pbr/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = mobile ? 2 : 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const grassTex = new THREE.TextureLoader().load('/textures/grass.jpg');
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping; grassTex.colorSpace = THREE.SRGBColorSpace; grassTex.anisotropy = 8;
  const GTEX = { grass: pbr('grass'), forest: pbr('forest'), leaves: pbr('leaves'), sand: pbr('sand'), trail: pbr('trail') };
  const GROUND_N = mobile ? null : { grass: pbr('grass_n', false), forest: pbr('forest_n', false), sand: pbr('sand_n', false), trail: pbr('trail_n', false) };
  terrainMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrass = { value: grassTex };
    for (const [k, t] of Object.entries(GTEX)) sh.uniforms[`uG_${k}`] = { value: t };
    if (GROUND_N) for (const [k, t] of Object.entries(GROUND_N)) sh.uniforms[`uN_${k}`] = { value: t };
    if (GROUND_N) sh.defines = { ...(sh.defines || {}), DZ_GROUND_NORMALS: '' };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;\nattribute vec4 aMat;\nvarying vec4 vMat;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvMat = aMat;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D uGrass, uG_grass, uG_forest, uG_leaves, uG_sand, uG_trail;
#ifdef DZ_GROUND_NORMALS
uniform sampler2D uN_grass, uN_forest, uN_sand, uN_trail;
#endif
varying vec3 vWorldP;
varying vec4 vMat;
float dzHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dzNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(dzHash(i), dzHash(i + vec2(1, 0)), f.x), mix(dzHash(i + vec2(0, 1)), dzHash(i + vec2(1, 1)), f.x), f.y); }
vec3 dzN = vec3(0.0, 0.0, 1.0);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{ vec2 q = vWorldP.xz;
  float big = dzNoise(q * 0.035) * 0.6 + dzNoise(q * 0.11) * 0.4;     // patches across a field
  // How much of each kind of ground, from the land cover (woods, sand, bare dirt, grass), broken up a
  // little by noise so the edges between them aren't straight lines.
  // (Only the kinds already here vary, so a field never reads the sand or woods photos.)
  vec4 w = vMat * (1.0 + (vec4(big, 1.0 - big, dzNoise(q * 0.07), 0.5) - 0.5) * 1.2);
  w /= max(w.x + w.y + w.z + w.w, 1e-3);
  vec2 qa = q / 3.0, qb = mat2(0.8, -0.6, 0.6, 0.8) * q / 3.6 + 0.37;
  // Only read the photos this spot actually uses (most of the ground is one or two kinds). Where a
  // kind fades out (under 2%) the skipped read can't show.
  float leafy = smoothstep(0.35, 0.75, dzNoise(q * 0.09));
  vec3 photo = vec3(0.0);
  if (w.x > 0.02) {
    vec3 woods = texture2D(uG_forest, qa).rgb;
    if (leafy > 0.01) woods = mix(woods, texture2D(uG_leaves, qb).rgb, leafy);
    photo += woods * w.x;
  }
  if (w.y > 0.02) photo += texture2D(uG_sand, qb).rgb * w.y;
  if (w.z > 0.02) photo += texture2D(uG_trail, qa).rgb * w.z;
  if (w.w > 0.02) photo += mix(texture2D(uG_grass, qa).rgb, texture2D(uGrass, qb * 1.1).rgb * vec3(0.95, 0.9, 0.75), 0.5) * w.w;
  // Each photo's average brightness (not this pixel's), so the photo's own light and dark detail stays.
  float pl = dot(w, vec4(mix(0.244, 0.142, leafy), 0.182, 0.235, 0.12)), gl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  // The photo, at this ground's brightness, with a third of the map's colour mixed in.
  vec3 real = photo * (gl / pl) * mix(vec3(1.0), diffuseColor.rgb / max(gl, 1e-3) * 0.33, 0.35);
  diffuseColor.rgb = mix(real, diffuseColor.rgb, 0.18) * (0.88 + big * 0.24);
#ifdef DZ_GROUND_NORMALS
  vec3 nw = vec3(0.0);
  if (w.x > 0.02) nw += texture2D(uN_forest, qa).rgb * w.x;
  if (w.y > 0.02) nw += texture2D(uN_sand, qb).rgb * w.y;
  if (w.z > 0.02) nw += texture2D(uN_trail, qa).rgb * w.z;
  if (w.w > 0.02) nw += texture2D(uN_grass, qa).rgb * w.w;
  nw = nw * 2.0 - 1.0;
  dzN = normalize(vec3(nw.xy * 1.2, max(nw.z, 0.2)));
#endif
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#ifdef DZ_GROUND_NORMALS
{ vec3 T = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz), B = normalize((viewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
  normal = normalize(T * dzN.x + B * dzN.y + normal * dzN.z); }
#endif`);
  };
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2d4f25, roughness: 1, flatShading: true });
  const tankGeo = new THREE.CylinderGeometry(1, 1, 1, 20);
  tankGeo.translate(0, 0.5, 0);
  const tankMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.6, metalness: 0.2 });
  const shared = new Set([trunkGeo, crownGeo, pineGeo, farCrownGeo, canopyGeo, waterGeo, tankGeo]);
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
  // Sky: a real atmosphere (light scattered blue overhead, paler and warmer toward the horizon and
  // around the sun), the sun placed where the game's sunlight comes from. Follows you.
  const sky = new Sky();
  sky.scale.setScalar(60000);
  sky.renderOrder = -10;
  sky.material.fog = false;
  // The scattering model is tuned for a darker exposure than the game's: scale it to sit with the land.
  sky.material.fragmentShader = sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * 0.55, 1.0 );');
  Object.assign(sky.material.uniforms.turbidity, { value: 3.2 });
  Object.assign(sky.material.uniforms.rayleigh, { value: 1.35 });
  Object.assign(sky.material.uniforms.mieCoefficient, { value: 0.004 });
  Object.assign(sky.material.uniforms.mieDirectionalG, { value: 0.82 });
  sky.material.uniforms.sunPosition.value.set(62, 46, 38).normalize();
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
    for (const t of map.towns) { const r = t.rect; if (t.paved !== false && x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return GROUND.town; }
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
  // Real asphalt on the paved roads and loose gravel on the dirt ones (photo-scanned, laid in world
  // space); the painted lines keep their colour with a little of the road's grain through them.
  const ROAD_TEX = { asphalt: pbr('asphalt'), trail: GTEX.trail }, ROAD_NOR = mobile ? null : pbr('asphalt_n', false);
  roadMat.onBeforeCompile = (sh) => {
    sh.uniforms.uAsph = { value: ROAD_TEX.asphalt }; sh.uniforms.uTrail = { value: ROAD_TEX.trail };
    if (ROAD_NOR) { sh.uniforms.uAsphN = { value: ROAD_NOR }; sh.defines = { ...(sh.defines || {}), DZ_ROAD_NORMALS: '' }; }
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoadP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoadP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uAsph, uTrail;\n#ifdef DZ_ROAD_NORMALS\nuniform sampler2D uAsphN;\n#endif\nvarying vec3 vRoadP;\nfloat dzPaint = 0.0;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  { vec2 q = vRoadP.xz / 3.5;
    float vl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    float dirt = smoothstep(0.08, 0.16, diffuseColor.r - diffuseColor.b);
    dzPaint = smoothstep(0.42, 0.55, vl) * (1.0 - dirt);
    vec3 a = texture2D(uAsph, q).rgb, t = texture2D(uTrail, q * 1.2).rgb;
    vec3 surf = mix(a * (vl / 0.08), t * (vl / 0.23), dirt);
    float grain = dot(a, vec3(0.3, 0.59, 0.11)) / 0.08;
    diffuseColor.rgb = mix(surf, diffuseColor.rgb * mix(1.0, grain, 0.25), dzPaint); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#ifdef DZ_ROAD_NORMALS
  { vec3 n = texture2D(uAsphN, vRoadP.xz / 3.5).rgb * 2.0 - 1.0;
    vec3 T = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz), B = normalize((viewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
    normal = normalize(mix(normal, normalize(T * n.x + B * n.y + normal * n.z), 1.0 - dzPaint)); }
#endif`);
  };
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
        // Edge, middle, edge at each end: the middle follows the ground too, so a crowned or tilted
        // stretch doesn't let the grass show through the centre of a wide road.
        const row = half > 1.5 ? [[ax + nx, az + nz], [ax, az], [ax - nx, az - nz], [bx + nx, bz + nz], [bx, bz], [bx - nx, bz - nz]] : [[ax + nx, az + nz], [ax - nx, az - nz], [bx + nx, bz + nz], [bx - nx, bz - nz]];
        for (const [x, z] of row) {
          const hg = Math.max(meshHeight(x, z), terrain.drawn(x, z), meshHeight(x + 0.8, z), meshHeight(x - 0.8, z), meshHeight(x, z + 0.8), meshHeight(x, z - 0.8));
          pos.push(x, hg + lift, z);
          col.push(c[0], c[1], c[2]);
        }
        if (row.length === 6) idx.push(base, base + 3, base + 1, base + 1, base + 3, base + 4, base + 1, base + 4, base + 2, base + 2, base + 4, base + 5);
        else idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    };
    const disc = (cx, cz, rad, c, lift) => {
      const base = pos.length / 3, N = 10;
      pos.push(cx, Math.max(meshHeight(cx, cz), terrain.drawn(cx, cz)) + lift, cz); col.push(c[0], c[1], c[2]);
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2, x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
        pos.push(x, Math.max(meshHeight(x, z), terrain.drawn(x, z)) + lift, z); col.push(c[0], c[1], c[2]);
      }
      for (let k = 0; k < N; k++) idx.push(base, base + 1 + ((k + 1) % N), base + 1 + k);
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
        const inside = mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK && terrain.drawn(mx, mz) > 0.15 && !terrain.underDeck(mx, mz, 6);
        if (!inside) { flush(); continue; }
        if (!run.length) run.push(pt(t0));
        run.push(pt(t1));
      }
      flush();
      const surface = r.dirt ? ROAD_COL.dirt : r.hw ? ROAD_COL.route : ROAD_COL.asphalt;
      // A round patch at each end, so bends and junctions have no wedge-shaped gaps.
      for (const [ex, ez] of [[r.x1, r.z1], [r.x2, r.z2]]) {
        if (ex < x0 || ex >= x0 + CHUNK || ez < z0 || ez >= z0 + CHUNK || terrain.drawn(ex, ez) <= 0.15 || terrain.underDeck(ex, ez, 6)) continue;
        disc(ex, ez, w / 2, surface, 0.055);
      }
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
    const pos = [], col = [], idx = [], mat = [];
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
      // What the ground is made of here: woods (forest floor and leaves), sand, bare dirt, grass.
      const cv = terrain.hasCover ? terrain.cover(x, z) : 3;
      const steep = h > 0.4 && sl > 0.18 ? Math.min(1, (sl - 0.18) / 0.4) : 0;
      let mw = cv === 1 || cv === 9 ? [1, 0, 0, 0.15] : cv === 6 ? [0, 1, 0.2, 0] : cv === 4 ? [0, 0, 0.45, 0.55] : cv === 5 ? [0, 0.1, 0.25, 0.65] : cv === 2 ? [0.35, 0.1, 0.1, 0.45] : [0, 0, 0.05, 1];
      if (steep) mw = mw.map((m, k) => m * (1 - steep) + (k === 2 ? steep : 0));
      mat.push(...mw);
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(mat, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, terrainMat);
    m.receiveShadow = true;
    return { mesh: m, wet };
  }

  // Bridges: each deck follows its road line from bank to bank, a level above the ground, on concrete
  // bents over the swamp and big piers in the river. The Trammell Bridge's 1938 span carries a steel
  // through-truss over the channel; the 1998 span is a plain concrete high-rise. Drawn with instanced
  // boxes (a handful of draw calls for 6 km of bridge), in both scenes.
  {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const mats = {
      deck: new THREE.MeshStandardMaterial({ color: 0x9b9d9f, roughness: 0.9 }),
      old: new THREE.MeshStandardMaterial({ color: 0x84878a, roughness: 0.95 }),
      parapet: new THREE.MeshStandardMaterial({ color: 0xc6c7c4, roughness: 0.85 }),
      pier: new THREE.MeshStandardMaterial({ color: 0x8e908f, roughness: 0.95 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5f6d63, roughness: 0.6, metalness: 0.4 }),
    };
    const parts = { deck: [], old: [], parapet: [], pier: [], steel: [] };
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), v = new THREE.Vector3(), sc = new THREE.Vector3();
    /** A box from its centre, size (w across, h tall, l along) and heading/slope. */
    const put = (list, x, y, z, w, h, l, yaw, pitch = 0) => { e.set(pitch, yaw, 0); q.setFromEuler(e); list.push(m4.compose(v.set(x, y, z), q, sc.set(w, h, l)).clone()); };
    for (const d of map.bridges || []) {
      const P = d.pts, truss = d.style === 'truss';
      for (let i = 0; i < P.length - 1; i++) {
        const [x1, z1, y1] = P[i], [x2, z2, y2] = P[i + 1], len = Math.hypot(x2 - x1, z2 - z1);
        if (len < 0.5) continue;
        const yaw = Math.atan2(x2 - x1, z2 - z1), pitch = -Math.atan2(y2 - y1, len), ux = (x2 - x1) / len, uz = (z2 - z1) / len;
        const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2, my = (y1 + y2) / 2, L = Math.hypot(len, y2 - y1) + 0.15;
        put(truss ? parts.old : parts.deck, mx, my - 0.42, mz, 9.6, 0.85, L, yaw, pitch);
        for (const sd of [-1, 1]) put(truss ? parts.steel : parts.parapet, mx - uz * sd * 4.75, my + (truss ? 0.45 : 0.5), mz + ux * sd * 4.75, truss ? 0.18 : 0.4, truss ? 0.9 : 1.0, L, yaw, pitch);
        // A bent every 30 m where the deck stands clear of the ground: two columns and a cap.
        const gnd = terrain.height(mx, mz), clear = my - gnd;
        const sC = (i - d.sC) * 10, channel = Math.abs(sC) < 200 && gnd < 1;
        if (clear > 1.6 && i % (channel ? 6 : 3) === 0) {
          const foot = Math.min(gnd, 0) - 1.5, colH = my - 0.85 - foot;
          for (const sd of channel ? [0] : [-1, 1]) put(parts.pier, mx - uz * sd * 3.1, foot + colH / 2, mz + ux * sd * 3.1, channel ? 8.5 : 1.1, colH, channel ? 2.4 : 1.1, yaw);
          if (!channel) put(parts.pier, mx, my - 1.15, mz, 9.2, 0.8, 1.4, yaw);
        }
        // The old span's through-truss over the river: top chords, posts and bracing every 10 m.
        if (truss && Math.abs(sC) < 170) {
          const H = 7;
          for (const sd of [-1, 1]) {
            const ox = -uz * sd * 4.95, oz = ux * sd * 4.95;
            put(parts.steel, mx + ox, my + H, mz + oz, 0.45, 0.45, L, yaw, pitch);
            put(parts.steel, x1 + ox, y1 + H / 2, z1 + oz, 0.35, H, 0.35, yaw);
            // diagonal from this post's foot to the next post's top
            const dl = Math.hypot(len, H + (y2 - y1));
            put(parts.steel, mx + ox, my + H / 2, mz + oz, 0.3, 0.3, dl, yaw, -Math.atan2(H + (y2 - y1), len));
          }
          put(parts.steel, x1, y1 + H, z1, 9.9, 0.35, 0.35, yaw);
        }
      }
    }
    for (const [k, list] of Object.entries(parts)) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(unit, mats[k], list.length);
      list.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true; im.receiveShadow = true;
      im.computeBoundingSphere();
      scene.add(im);
      far.add(im.clone());
    }
  }

  /** Colour, and which wall texture, for a box. */
  function paint(b) {
    const id = b.bldg ?? b.id;
    switch (b.type) {
      // Real buildings dress by type: brick storefronts and halls, lap-sided houses, metal barns and warehouses.
      case 'building': { if (b.real) return [pick(BRICK_COLORS, id), 'brick']; const c = COLORS.building, v = hash(id) / 4294967296; return [[c[0] + (v - 0.5) * 0.15, c[1] + (v - 0.5) * 0.12, c[2] + (v - 0.5) * 0.1], 'office']; }
      case 'civic': return [pick(CIVIC_COLORS, id), b.real ? 'brick' : 'office'];
      case 'home': return [pick(HOME_COLORS, id), 'siding'];
      case 'barn': return [b.real ? pick(BARN_COLORS, id) : COLORS.barn, b.real ? (hash(id) % 5 < 2 ? 'planks' : 'metal') : 'planks'];   // old wooden barns and metal ones
      case 'warehouse': return [b.real ? pick(WAREHOUSE_COLORS, id) : COLORS.warehouse, b.real ? 'metal' : null];
      case 'car': return [CAR_COLORS[b.id % CAR_COLORS.length], null];
      case 'vehiclebody': return [VEHICLE_COLORS[b.vtype] || COLORS.cover, null];
      case 'housewall': return [b.houseId === ownHouseId ? COLORS.ownwall : COLORS.housewall, null];
      default: return [COLORS[b.type] || COLORS.cover, null];
    }
  }
  const wallColor = (r) => paint({ type: r.type, bldg: r.bldg, real: r.real, id: r.bldg })[0];
  const ownChunk = (b, x0, z0) => { const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2; return mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK; };

  // Each drawn tree's place in its chunk's instanced meshes, so one can be cut to a stump (or regrow) in place.
  const treeSlots = new WeakMap(), tm = new THREE.Matrix4();
  const rockGeo = new THREE.DodecahedronGeometry(0.62, 0), rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  function setTreeMatrix(t) {
    const sl = treeSlots.get(t);
    if (!sl) return;
    if (sl.rock) {   // a stone, or when mined out a low spread of rubble
      const { rock, i, x, y, z, w, d, h } = sl;
      if (t.gone) tm.makeScale(w * 1.25, 0.3, d * 1.25).setPosition(x, y + 0.35, z);
      else tm.makeScale(w, h, d).setPosition(x, y + h / 2, z);
      rock.setMatrixAt(i, tm); rock.instanceMatrix.needsUpdate = true;
      return;
    }
    const { trunks, crowns, i, x, y, z, cw, ch, yaw } = sl;
    if (t.gone) {   // a stump knee-high, and no tree
      tm.makeScale(1.15, 0.55, 1.15).setPosition(x, y + 0.3, z); trunks.setMatrixAt(i, tm);
      tm.makeScale(0, 0, 0).setPosition(x, y, z); crowns.setMatrixAt(i, tm);
    } else {
      tm.makeScale(0, 0, 0).setPosition(x, y, z); trunks.setMatrixAt(i, tm);
      cardMatrix(tm, x, y - 0.15, z, cw, ch, yaw); crowns.setMatrixAt(i, tm);
    }
    trunks.instanceMatrix.needsUpdate = true; crowns.instanceMatrix.needsUpdate = true;
  }
  // ---------------------------------------------------------------- grass around you
  // Blades fixed in the world (each 1 m square of grassy ground gets its own few, always the same), laid
  // out again as you move. Only on grass: not roads, towns, sand, water or inside anything. They sway in
  // a breeze. How many depends on the graphics setting (none on Low).
  const GRASS_R = 30;
  const bladeGeo = (() => {
    const pos = [], nor = [], idx = [], W = 0.06, segs = 3;
    for (let i = 0; i <= segs; i++) { const t = i / segs, w = W * (1 - t * 0.9) / 2; pos.push(-w, t, 0, w, t, 0); nor.push(0, 1, 0.25, 0, 1, 0.25); }
    for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  })();
  const grassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide });
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vBlade;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBlade = position.y;
{ vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sway = sin(uTime * 1.6 + wp.x * 0.31 + wp.z * 0.23) * 0.6 + sin(uTime * 2.7 + wp.x * 0.9 - wp.z * 0.5) * 0.25;
  float bend = position.y * position.y;
  transformed.x += sway * bend * 0.22; transformed.z += sway * bend * 0.12; }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vBlade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.6, 1.15, vBlade);')
      // Lit as the ground is (from above), whichever side of the blade you see: no black backs.
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
  };
  let grassMesh = null, grassDensity = 0, grassAt = null;
  const tint = new THREE.Color(), tm2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), e2 = new THREE.Euler(), s2 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const ghash = (i, j, k) => { let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  function setGrass(density) {
    grassDensity = density;
    if (grassMesh) { scene.remove(grassMesh); grassMesh.dispose(); grassMesh = null; }
    grassAt = null;
    if (!density) return;
    grassMesh = new THREE.InstancedMesh(bladeGeo, grassMat, Math.ceil(Math.PI * GRASS_R * GRASS_R * density * 1.05));
    grassMesh.count = 0;
    grassMesh.frustumCulled = false;
    grassMesh.receiveShadow = !mobile;
    scene.add(grassMesh);
  }
  let pavedAt = null;   // parking lots and sidewalks (client/towns.js): no grass on them
  function layGrass(px, pz) {
    const cx = Math.round(px), cz = Math.round(pz), N = GRASS_R * 2 + 1;
    // What blades can't grow in: buildings and solid things (trees are fine), roads.
    const blocked = new Uint8Array(N * N);
    for (const b of map.grid.near(cx, cz, GRASS_R + 4)) {
      if (b.type === 'tree' || b.type === 'pine' || b.gone) continue;
      for (let x = Math.floor(b.minX) - cx + GRASS_R; x <= Math.ceil(b.maxX) - cx + GRASS_R; x++) for (let z = Math.floor(b.minZ) - cz + GRASS_R; z <= Math.ceil(b.maxZ) - cz + GRASS_R; z++) if (x >= 0 && z >= 0 && x < N && z < N) blocked[z * N + x] = 1;
    }
    const roads = map.roadsNear(cx, cz, GRASS_R + 12);
    const onRoad = (x, z) => roads.some((r) => { const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2)); return Math.hypot(r.x1 + dx * t - x, r.z1 + dz * t - z) < (r.width || 8) / 2 + 0.4; });
    const colorAt = new Map();
    let n = 0;
    const cap = grassMesh.instanceMatrix.count;
    for (let j = -GRASS_R; j <= GRASS_R && n < cap; j++) for (let i = -GRASS_R; i <= GRASS_R && n < cap; i++) {
      if (i * i + j * j > GRASS_R * GRASS_R || blocked[(j + GRASS_R) * N + (i + GRASS_R)]) continue;
      const gx = cx + i, gz = cz + j;
      const kmax = Math.floor(grassDensity) + (ghash(gx, gz, 99) < grassDensity % 1 ? 1 : 0);
      if (!kmax) continue;
      const ck = `${gx >> 2},${gz >> 2}`;   // ground colour, sampled every 4 m
      let c = colorAt.get(ck);
      if (c === undefined) {
        const h0 = terrain.drawn(gx, gz);
        const gc = h0 < 0.8 ? null : groundColor(gx, gz, h0);
        c = gc && gc[1] > gc[0] * 1.08 && gc[1] > gc[2] * 1.25 ? gc : null;   // green ground only
        colorAt.set(ck, c);
      }
      if (!c || onRoad(gx + 0.5, gz + 0.5) || pavedAt?.(gx + 0.5, gz + 0.5)) continue;
      for (let k = 0; k < kmax && n < cap; k++) {
        const x = gx + ghash(gx, gz, k * 3 + 1), z = gz + ghash(gx, gz, k * 3 + 2), r = ghash(gx, gz, k * 3 + 3);
        const hgt = 0.18 + r * 0.38;
        e2.set((r - 0.5) * 0.35, r * 6.283, (ghash(gz, gx, k) - 0.5) * 0.35);
        tm2.compose(p2.set(x, meshHeight(x, z) - 0.02, z), q2.setFromEuler(e2), s2.set(1, hgt, 1));
        grassMesh.setMatrixAt(n, tm2);
        const v = 0.95 + r * 0.4;
        grassMesh.setColorAt(n, tint.setRGB(Math.min(1, c[0] * v * 0.95), Math.min(1, c[1] * v * 1.12), Math.min(1, c[2] * v * 0.85)));
        n++;
      }
    }
    grassMesh.count = n;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassAt = { x: px, z: pz };
  }
  function buildChunk(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const list = map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK).filter((b) => ownChunk(b, x0, z0));
    const office = newBuf(true), siding = newBuf(true), brick = newBuf(true), metal = newBuf(true), planks = newBuf(true), plain = newBuf(false), roof = newBuf(false);
    const trees = [], pines = [], canopies = [], tanks = [], rocks = [], rigs = [];
    for (const b of list) {
      if (b.type === 'terminal' || b.type === 'rail') continue;   // drawn separately (terminals change; rails are the bridge's)
      if (b.type === 'tree') { trees.push(b); continue; }
      if (b.nature && (b.type === 'rock' || b.type === 'boulder')) { rocks.push(b); continue; }
      if (b.type === 'pine') { pines.push(b); continue; }
      if (b.type === 'canopy') { canopies.push(b); continue; }
      if (b.type === 'tank') { tanks.push(b); continue; }
      if (b.type === 'car' || b.type === 'vehiclebody') { rigs.push(b); continue; }   // drawn as real vehicles, below
      const [c, tex] = paint(b);
      pushBox(tex === 'office' ? office : tex === 'siding' ? siding : tex === 'brick' ? brick : tex === 'metal' ? metal : tex === 'planks' ? planks : plain, b, c, tex ? 4 : 0);
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
    for (const [buf, mat] of [[office, texturedMat], [siding, sidingMat], [brick, brickMat], [metal, metalMat], [planks, plankMat], [plain, plainMat], [roof, roofMat]]) {
      if (!buf.idx.length) continue;
      const m = new THREE.Mesh(toGeometry(buf), mat);
      m.castShadow = true;
      m.receiveShadow = mat !== roofMat;
      group.add(m);
    }
    const forest = (list, crownMaterial) => {
      if (!list.length) return;
      // The photo tree stands there; the trunk mesh is only the stump once it's been cut down.
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
      const cards = photoTrees(list.map((t) => ({ kind: crownMaterial === pineMat ? 'pine' : 'tree', id: t.id, h: t.h })), photoMat);
      list.forEach((t, i) => {
        const x = (t.minX + t.maxX) / 2, z = (t.minZ + t.maxZ) / 2, y = t.y0 || 0, h = t.h;
        const kind = crownMaterial === pineMat ? 'pine' : 'tree', hh = h * (kind === 'pine' ? 1.18 : 1.05);
        const v = PHOTO[kind][(t.id * 7 + 3) % PHOTO[kind].length];
        treeSlots.set(t, { trunks, crowns: cards, i, x, y, z, h, cw: hh * v.aspect, ch: hh, yaw: (t.id * 2.399) % Math.PI });
        setTreeMatrix(t);
      });
      cards.castShadow = !mobile; cards.customDepthMaterial = photoDepth;
      trunks.castShadow = !mobile;
      group.add(trunks, cards);
    };
    // Rocks you can mine: chunky stones, one batch per chunk, so a mined-out one can crumble in place.
    if (rocks.length) {
      const im = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
      rocks.forEach((r, i) => { im.setColorAt(i, new THREE.Color(...(r.type === 'boulder' ? COLORS.boulder : COLORS.rock))); treeSlots.set(r, { rock: im, i, x: (r.minX + r.maxX) / 2, y: r.y0 || 0, z: (r.minZ + r.maxZ) / 2, w: r.maxX - r.minX, d: r.maxZ - r.minZ, h: r.h }); setTreeMatrix(r); });
      im.castShadow = true; im.receiveShadow = true;
      group.add(im);
    }
    forest(trees, crownMat);
    forest(pines, pineMat);
    // Abandoned cars by the road, and the RVs, buses, box trucks and houseboats people live in.
    for (const b of rigs) {
      const w = b.maxX - b.minX, d = b.maxZ - b.minZ, alongX = w > d, len = Math.max(w, d), wid = Math.min(w, d);
      const m = b.type === 'car' ? buildWreck(b.id) : buildHomeVehicle(b.vtype, len, wid, Math.max(1.5, b.h - 0.3), new THREE.Color(...(VEHICLE_COLORS[b.vtype] || COLORS.cover)).getHex());
      m.position.set((b.minX + b.maxX) / 2, b.vtype === 'houseboat' ? -0.4 : (b.y0 ?? terrain.drawn((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)) + (b.type === 'car' ? 0 : 0.3), (b.minZ + b.maxZ) / 2);
      // Homes face away from their door (it's at the far end of the box); wrecks lie either way.
      m.rotation.y = b.type === 'vehiclebody' ? (alongX ? -Math.PI / 2 : Math.PI) : (alongX ? Math.PI / 2 : 0) + (b.id % 2 ? Math.PI : 0);
      group.add(m);
    }
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
    for (const [list, kind] of [[trees, 'tree'], [pines, 'pine']]) {
      if (!list.length) continue;
      const far0 = list.map((t) => ({ kind, id: t.id, h: t.h }));
      const cards = photoTrees(far0, photoFarMat);
      list.forEach((t, i) => { const f = far0[i]; cardMatrix(m, (t.minX + t.maxX) / 2, t.y0 - 0.15, (t.minZ + t.maxZ) / 2, f.cardW, f.cardH, f.cardYaw); cards.setMatrixAt(i, m); });
      group.add(cards);
    }
    far.add(group);
    return group;
  }

  function dispose(group, from = scene) {
    from.remove(group);
    group.traverse((o) => { if (o.geometry && !shared.has(o.geometry) && !o.geometry.userData.shared) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
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
    /** The sky dome (its sun and clouds follow the day and the weather). */
    sky,
    /** Where the ground is paved (a test (x, z) => bool): grass is kept off it. */
    setPaved(fn) { pavedAt = fn; grassAt = null; },
    /** A tree cut down to a stump, or grown back. */
    setFelled(t) { setTreeMatrix(t); },
    setOwnHouse(id) {
      if (id === ownHouseId) return;
      ownHouseId = id;
      for (const g of chunks.values()) dispose(g);
      chunks.clear();
    },
    update(px, pz, speed = 0) {
      sky.position.set(px, 0, pz);
      waterTime.value = performance.now() / 1000;
      // Grass blades are laid out around you as you move. At driving speed they'd be laid out again
      // several times a second (a stutter on a phone) for blades nobody can see go by: hide them, and
      // lay them out again once you slow down.
      if (grassMesh) {
        const fast = speed > 9;
        grassMesh.visible = !fast;
        if (!fast && (!grassAt || Math.hypot(px - grassAt.x, pz - grassAt.z) > 6)) layGrass(px, pz);
      }
      const want = new Set();
      let built = 0;
      const t0 = performance.now();
      for (const [, cx, cz] of chunksWithin(px, pz, viewRange)) {
        const k = key(cx, cz);
        want.add(k);
        // Spread the building of new ground over frames: a few at the start, then one at a time and only
        // while this frame has time to spare, so driving into new ground doesn't hitch.
        if (chunks.has(k) || built >= (chunks.size < 4 ? 9 : 2) || (chunks.size >= 4 && built && performance.now() - t0 > 5)) continue;
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
        if (!farChunks.has(k) && built < 3 && performance.now() - t0 < 8) { farChunks.set(k, buildFar(cx, cz)); built++; }
        const g = farChunks.get(k);
        if (g) g.visible = !chunks.has(k);
      }
      for (const [k, g] of farChunks) if (!wantFar.has(k)) { if (g) dispose(g, far); farChunks.delete(k); }
    },
    /** Graphics setting: how far full detail and the far stand-ins reach. Chunks outside go next frame. */
    setRanges(view, farR) { viewRange = view; farRange = farR; },
    /** Graphics setting: grass blades per square metre around you (0 = none). */
    setGrass(d) { if (d !== grassDensity) setGrass(d); },
    get chunkCount() { return chunks.size; },
    get farChunkCount() { return farChunks.size; },
  };
}
