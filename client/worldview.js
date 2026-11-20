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
import { makeTreeKit, treePick } from '/trees3d.js';
import { COVER } from '/shared/terrain.js';
import { buildWreck, buildHomeVehicle } from '/ridemodels.js';
import {
  CHUNK, TREE_FULL, SKY_TOP, SKY_HORIZON, COLORS, ROOF_COLORS, METAL_ROOFS, VEHICLE_COLORS, GROUND, hash, pick,
  pushBox, pushRoof, pushFlatRoof, newBuf, paint as paintBox, wallColor, CHUNK_BUFS, isChunkBox, buildChunkBuffers,
} from '/chunkgeo.js';
export { SKY_TOP, SKY_HORIZON, pushBox, pushLadder, pushRoof, pushFlatRoof, pushStorefront, pushHouseDetail, pushFurniture } from '/chunkgeo.js';

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

export function toGeometry(buf) {
  const g = new THREE.BufferGeometry();
  // (Typed arrays, as the chunk worker sends, are used as they are; plain arrays are copied into some.)
  const attr = (a, n) => (ArrayBuffer.isView(a) ? new THREE.BufferAttribute(a, n) : new THREE.Float32BufferAttribute(a, n));
  g.setAttribute('position', attr(buf.pos, 3));
  g.setAttribute('normal', attr(buf.nor, 3));
  g.setAttribute('color', attr(buf.col, 3));
  if (buf.uv) g.setAttribute('uv', attr(buf.uv, 2));
  g.setIndex(ArrayBuffer.isView(buf.idx) ? new THREE.BufferAttribute(buf.idx, 1) : buf.idx);
  g.computeBoundingSphere();
  return g;
}

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
  // House windows: dark glass that catches the sky.
  const paneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0, envMapIntensity: 1.2 });
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
    m.customProgramCacheKey = () => `photoWall:${name}`;   // (its numbers are baked into the shader: no sharing a program with another wall)
    return m;
  };
  const brickMat = photoWall('brick', 2.4, 0.25);
  const metalMat = photoWall('metal', 2, 0.65, { roughness: 0.55, metalness: 0.3 });
  const plankMat = photoWall('planks', 2, 0.35, { color: new THREE.Color(1.8, 1.7, 1.6) });   // the plank photo is dark weathered wood: lift it
  // Painted walls (Poly Haven photo scans, CC0): the photo gives the surface (the laps of the siding,
  // the trowel marks in stucco, the courses of block), the building its colour. `avg` is the photo's
  // own mean brightness (linear), so a white house stays white and a green one green.
  const paintWall = (name, rep, avg, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({ map: wallTex(name, rep), normalMap: wallNor(name, rep), vertexColors: true, roughness: 0.9, ...extra });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#if defined( USE_COLOR )
  { float l = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)) / ${avg.toFixed(4)}; diffuseColor.rgb = vColor.rgb * 0.9 * clamp(mix(1.0, l, 0.7), 0.4, 1.3); }   // (capped: white walls in full sun mustn't blow out)
#endif`);
    };
    m.customProgramCacheKey = () => `paintWall:${name}`;
    return m;
  };
  const sidingMat = paintWall('siding', 2.2, 0.0538);
  const stuccoMat = paintWall('stucco', 1.5, 0.4194, { roughness: 0.95 });
  const blockMat = paintWall('block', 2.0, 0.0517, { roughness: 0.95 });
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  // Roofs: corrugated metal (as on most of rural Florida), laid in world space down the slopes, in the
  // roof's own colour.
  // Roofs, laid in world space down the slopes in the roof's own colour: asphalt shingles on houses and
  // shops, corrugated metal on barns, sheds and warehouses (as on most of rural Florida's).
  const roofOf = (name, scale, avg, extra) => {
    const tex = wallTex(name, 1);
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, ...extra });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRoof = { value: tex };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRoofP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoofP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uRoof;\nvarying vec3 vRoofP;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  { vec3 t = texture2D(uRoof, vRoofP.xz / ${scale.toFixed(2)}).rgb; float tl = dot(t, vec3(0.3, 0.59, 0.11)) / ${avg.toFixed(4)}; diffuseColor.rgb *= mix(1.0, tl, 0.85); }`);
    };
    m.customProgramCacheKey = () => `roof:${name}`;
    return m;
  };
  const roofMat = roofOf('metal', 1.8, 0.18, { roughness: 0.6, metalness: 0.25 });
  const shingleMat = roofOf('shingles', 3.2, 0.1062, { roughness: 0.92, metalness: 0 });
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
  // Close by, trees are real 3D models (client/trees3d.js); the photo cards are only for the far view.
  const kit = makeTreeKit();
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
    // Three pictures crossed through the trunk (0°, 60°, 120°), fixed in the world: walk round a tree and
    // it stays put, like a real one, instead of turning to follow you. Each has a face both ways.
    for (let k = 0; k < 3; k++) {
      const a = k * Math.PI / 3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
      quad(-cx, -cz, cx, cz, false); quad(-cx, -cz, cx, cz, true);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    return g;
  })();
  /** Each tree's own part of the sheet, as an attribute per instance. */
  // Each tree's photo, from its own part of the sheet (the planes stay where they stand).
  const atlasUv = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTreeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * aTreeUv.zw + aTreeUv.xy;\n#endif');
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
      // A tall tree is drawn taller more than wider: its trunk runs up longer and its crown sits higher.
      t.cardH = t.h * (t.kind === 'pine' ? 1.18 : 1.05); t.cardW = Math.min(t.cardH, 12 * (t.cardH / 12) ** 0.72) * v.aspect; t.cardYaw = ((t.id * 2.399) % Math.PI);
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
  // Capped below the glow threshold (client/post.js): the bright sky round the sun covers a quarter of the
  // screen, and left uncapped its glow washed the whole view white whenever you faced it.
  sky.material.fragmentShader = sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor * 0.55, vec3( 1.9 ) ), 1.0 );');
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
        const inside = mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK && terrain.drawn(mx, mz) > 0.15 && !terrain.underDeck(mx, mz, 6) && !terrain.besideDeck(mx, mz, r.name);
        if (!inside) { flush(); continue; }
        if (!run.length) run.push(pt(t0));
        run.push(pt(t1));
      }
      flush();
      const surface = r.dirt ? ROAD_COL.dirt : r.hw ? ROAD_COL.route : ROAD_COL.asphalt;
      // A round patch at each end, so bends and junctions have no wedge-shaped gaps.
      for (const [ex, ez] of [[r.x1, r.z1], [r.x2, r.z2]]) {
        if (ex < x0 || ex >= x0 + CHUNK || ez < z0 || ez >= z0 + CHUNK || terrain.drawn(ex, ez) <= 0.15 || terrain.underDeck(ex, ez, 6) || terrain.besideDeck(ex, ez, r.name)) continue;
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

  const bridgeCells = [];   // { x, z, near, far }: the bridges in 400 m pieces (just below)
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
    // In 400 m pieces, so what's off screen is skipped, and each piece is drawn once: in the near
    // scene when it's within the near range, in the far scene beyond it (see update).
    const CELL = 400, cells = new Map(), p = new THREE.Vector3();
    for (const [k, list] of Object.entries(parts)) for (const mm of list) {
      p.setFromMatrixPosition(mm);
      const ck = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      if (!cells.has(ck)) cells.set(ck, { x: (Math.floor(p.x / CELL) + 0.5) * CELL, z: (Math.floor(p.z / CELL) + 0.5) * CELL, parts: {} });
      (cells.get(ck).parts[k] ??= []).push(mm);
    }
    for (const c of cells.values()) {
      c.near = new THREE.Group(); c.far = new THREE.Group();
      for (const [k, list] of Object.entries(c.parts)) {
        const im = new THREE.InstancedMesh(unit, mats[k], list.length);
        list.forEach((mm, i) => im.setMatrixAt(i, mm));
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true; im.receiveShadow = true;
        im.computeBoundingSphere();
        c.near.add(im); c.far.add(im.clone());
      }
      c.parts = null;
      scene.add(c.near); far.add(c.far);
      bridgeCells.push(c);
    }
  }

  /** Colour, and which wall texture, for a box. */
  const paint = (b) => paintBox(b, ownHouseId);
  const ownChunk = (b, x0, z0) => { const mx = (b.minX + b.maxX) / 2, mz = (b.minZ + b.maxZ) / 2; return mx >= x0 && mx < x0 + CHUNK && mz >= z0 && mz < z0 + CHUNK; };

  // Each drawn tree's place in its chunk's instanced meshes, so one can be cut to a stump (or regrow) in place.
  const treeSlots = new WeakMap(), tm = new THREE.Matrix4();
  // Brush: saw palmetto, the fan-leaved scrub under the pines all over North Florida. One clump of
  // fronds (each a stem and a pleated fan) made once; every bush in a chunk is an instance of it,
  // turned, sized to its box and tinted a little differently.
  const palmettoGeo = (() => {
    const pos = [], col = [], rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    const FRONDS = 8, RIBS = 10;
    for (let f = 0; f < FRONDS; f++) {
      const az = (f / FRONDS) * Math.PI * 2 + rnd() * 0.5, el = 0.45 + rnd() * 0.65, len = 0.45 + rnd() * 0.3;
      const ox = Math.cos(az), oz = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
      const tip = [ox * ce * len, se * len, oz * ce * len];
      // the stem: a thin blade from the ground to the fan
      const sw = 0.025;
      pos.push(-oz * sw, 0, ox * sw, oz * sw, 0, -ox * sw, ...tip);
      for (let k = 0; k < 3; k++) col.push(0.12, 0.1, 0.04);   // (linear colours: a dull tan stem)
      // the fan, opening outward and up from the stem's end: ribs fanned through ~200 degrees
      const v = [ox * Math.cos(el + 0.35), Math.sin(el + 0.35), oz * Math.cos(el + 0.35)], u = [-oz, 0, ox], n = [v[1] * u[2] - v[2] * u[1], v[2] * u[0] - v[0] * u[2], v[0] * u[1] - v[1] * u[0]];
      const R = 0.42 + rnd() * 0.18, ribs = [];
      for (let i = 0; i <= RIBS; i++) {
        const t = -1.75 + (3.5 * i) / RIBS, c = Math.cos(t), sn = Math.sin(t), pleat = (i % 2 ? 1 : -1) * 0.035, droop = -0.12 * sn * sn;
        ribs.push([tip[0] + (v[0] * c + u[0] * sn) * R + n[0] * pleat, tip[1] + (v[1] * c + u[1] * sn) * R + n[1] * pleat + droop, tip[2] + (v[2] * c + u[2] * sn) * R + n[2] * pleat]);
      }
      for (let i = 0; i < RIBS; i++) {
        pos.push(...tip, ...ribs[i], ...ribs[i + 1]);
        col.push(0.034, 0.065, 0.022, 0.13, 0.2, 0.07, 0.13, 0.2, 0.07);   // darker at the heart, a lighter silvery green at the tips (#34482a -> #657a45, linear)
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  })();
  const palmettoMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  shared.add(palmettoGeo);   // (one for every chunk: never freed with a chunk)
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
    const { trunks, ti, parts, i, x, y, z, h, sx, yaw } = sl;
    if (t.gone) {   // a stump knee-high, and no tree
      tm.makeScale(Math.max(0.6, sx * 0.05), 0.55, Math.max(0.6, sx * 0.05)).setPosition(x, y + 0.3, z); trunks.setMatrixAt(ti, tm);
      tm.makeScale(0, 0, 0).setPosition(x, y, z);
    } else {
      tm.makeScale(0, 0, 0).setPosition(x, y, z); trunks.setMatrixAt(ti, tm);
      tm.compose(cardP.set(x, y + 0.15, z), cardQ.setFromAxisAngle(UP, yaw), cardS.set(sx, h, sx));
    }
    for (const m of parts) { m.setMatrixAt(i, tm); m.instanceMatrix.needsUpdate = true; }
    trunks.instanceMatrix.needsUpdate = true;
  }
  // ---------------------------------------------------------------- grass around you
  // Tufts of real grass (photo scans, Poly Haven grass_medium_01, CC0: tools/build_foliage.py), two
  // crossed pictures each, fixed in the world (each 1 m square of grassy ground gets its own few, always
  // the same), laid out again as you move. Only on grass: not roads, towns, sand, water, the woods floor
  // or inside anything. They sway in a breeze. How many depends on the graphics setting (none on Low).
  const GRASS_R = 30, TUFTS_PER_BLADE = 0.55;   // (the setting counts blades; a tuft is a clump of them)
  const GRASS_FAR = mobile ? 45 : 85, OUTER_K = 0.4;   // the thinner outer ring: out to here, this share of the density
  const bladeGeo = (() => {
    const pos = [], nor = [], uv = [], idx = [];
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      const o = pos.length / 3;
      pos.push(-0.5 * ax, 0, -0.5 * az, 0.5 * ax, 0, 0.5 * az, 0.5 * ax, 1, 0.5 * az, -0.5 * ax, 1, -0.5 * az);
      for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  })();
  const tuftTex = new THREE.TextureLoader().load('/textures/grasstuft.png');
  tuftTex.colorSpace = THREE.SRGBColorSpace; tuftTex.anisotropy = mobile ? 2 : 4;
  const grassMat = new THREE.MeshStandardMaterial({ map: tuftTex, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide });
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vBlade;\nattribute float aCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * 0.5 + vec2(mod(aCell, 2.0) * 0.5, aCell < 1.5 ? 0.5 : 0.0);\n#endif')   // (one of the four tufts)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBlade = position.y;
{ vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sway = sin(uTime * 1.6 + wp.x * 0.31 + wp.z * 0.23) * 0.6 + sin(uTime * 2.7 + wp.x * 0.9 - wp.z * 0.5) * 0.25;
  float bend = position.y * position.y;
  transformed.x += sway * bend * 0.22; transformed.z += sway * bend * 0.12; }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vBlade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.72, 1.06, vBlade);')
      // Lit as the ground is (from above), whichever side of the blade you see: no black backs.
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
  };
  let grassMesh = null, grassDensity = 0, grassAt = null, grassThisFrame = false, chunkBuiltLast = false;
  const tint = new THREE.Color(), tm2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), e2 = new THREE.Euler(), s2 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const ghash = (i, j, k) => { let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  function setGrass(density) {
    grassDensity = density;
    if (grassMesh) { scene.remove(grassMesh); grassMesh.dispose(); grassMesh = null; }
    grassAt = null;
    if (!density) return;
    const cap = Math.ceil(Math.PI * (GRASS_R * GRASS_R + (GRASS_FAR * GRASS_FAR - GRASS_R * GRASS_R) * OUTER_K) * density * TUFTS_PER_BLADE * 1.05) + 64;
    grassMesh = new THREE.InstancedMesh(bladeGeo.clone(), grassMat, cap);
    grassMesh.geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    grassMesh.count = 0;
    grassMesh.frustumCulled = false;
    grassMesh.receiveShadow = !mobile;
    scene.add(grassMesh);
  }
  let pavedAt = null;   // parking lots and sidewalks (client/towns.js): no grass on them
  function layGrass(px, pz) {
    const cx = Math.round(px), cz = Math.round(pz), N = GRASS_FAR * 2 + 1;
    // What blades can't grow in: buildings and solid things (trees are fine), roads.
    const blocked = new Uint8Array(N * N);
    for (const b of map.grid.near(cx, cz, GRASS_FAR + 4)) {
      if (b.gone) continue;
      if (b.type === 'tree' || b.type === 'pine') {   // bare ground round the foot of a tree
        const tx = Math.round((b.minX + b.maxX) / 2) - cx + GRASS_FAR, tz = Math.round((b.minZ + b.maxZ) / 2) - cz + GRASS_FAR;
        for (let x = tx - 2; x <= tx + 2; x++) for (let z = tz - 2; z <= tz + 2; z++) if (x >= 0 && z >= 0 && x < N && z < N) blocked[z * N + x] = 1;
        continue;
      }
      for (let x = Math.floor(b.minX) - cx + GRASS_FAR; x <= Math.ceil(b.maxX) - cx + GRASS_FAR; x++) for (let z = Math.floor(b.minZ) - cz + GRASS_FAR; z <= Math.ceil(b.maxZ) - cz + GRASS_FAR; z++) if (x >= 0 && z >= 0 && x < N && z < N) blocked[z * N + x] = 1;
    }
    const roads = map.roadsNear(cx, cz, GRASS_FAR + 12);
    // (Each road's box first, so most cells skip the distance sums: this runs for every grass cell.)
    const rb = roads.map((r) => { const w = (r.width || 8) / 2 + 0.6; return [Math.min(r.x1, r.x2) - w, Math.min(r.z1, r.z2) - w, Math.max(r.x1, r.x2) + w, Math.max(r.z1, r.z2) + w]; });
    const onRoad = (x, z) => roads.some((r, i) => { const b = rb[i]; if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) return false; const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2)); return Math.hypot(r.x1 + dx * t - x, r.z1 + dz * t - z) < (r.width || 8) / 2 + 0.4; });
    const colorAt = new Map();
    let n = 0;
    const cap = grassMesh.instanceMatrix.count;
    // Close by, every 1 m square; farther out (to GRASS_FAR) every 2 m, fewer but bigger clumps, so the
    // field doesn't stop a few steps ahead of you.
    for (let j = -GRASS_FAR; j <= GRASS_FAR && n < cap; j++) for (let i = -GRASS_FAR; i <= GRASS_FAR && n < cap; i++) {
      const d2 = i * i + j * j;
      if (d2 > GRASS_FAR * GRASS_FAR) continue;
      const outer = d2 > GRASS_R * GRASS_R, cell = outer ? 2 : 1, big = outer ? 1.45 : 1;
      if (outer && ((i | j) & 1)) continue;
      if (blocked[(j + GRASS_FAR) * N + (i + GRASS_FAR)]) continue;
      const gx = cx + i, gz = cz + j;
      const td = grassDensity * TUFTS_PER_BLADE * (outer ? 4 * OUTER_K : 1), kmax = Math.floor(td) + (ghash(gx, gz, 99) < td % 1 ? 1 : 0);
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
      if (terrain.hasCover && terrain.cover(gx + 0.5, gz + 0.5) === COVER.woods) continue;   // the woods floor is pine straw and leaves, not grass
      for (let k = 0; k < kmax && n < cap; k++) {
        const x = gx + ghash(gx, gz, k * 3 + 1) * cell, z = gz + ghash(gx, gz, k * 3 + 2) * cell, r = ghash(gx, gz, k * 3 + 3);
        const hgt = (0.34 + r * 0.38) * big, wid = (0.75 + ghash(gz, gx, k + 7) * 0.5) * big;
        e2.set((r - 0.5) * 0.12, r * 6.283, (ghash(gz, gx, k) - 0.5) * 0.12);
        tm2.compose(p2.set(x, meshHeight(x, z) - 0.03, z), q2.setFromEuler(e2), s2.set(wid, hgt, wid));
        grassMesh.setMatrixAt(n, tm2);
        grassMesh.geometry.attributes.aCell.array[n] = Math.floor(ghash(gx, gz, k * 3 + 5) * 4);
        // The photo has its own green: lean it a little toward this ground's colour (drier, greener).
        const l = Math.max(0.05, c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11), v = 1.05 + r * 0.25;
        grassMesh.setColorAt(n, tint.setRGB(v * (0.65 + 0.35 * c[0] / l), v * (0.65 + 0.35 * c[1] / l), v * (0.65 + 0.35 * c[2] / l)));
        n++;
      }
    }
    grassMesh.count = n;
    grassMesh.geometry.attributes.aCell.needsUpdate = true;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassAt = { x: px, z: pz };
  }
  /**
   * What a chunk's buildings need, for chunkgeo.buildChunkBuffers (run in the worker, or here): its own
   * boxes, its building records (with the point of road a shop front faces), and which house is yours.
   * Also the things drawn apart from the buildings (trees, rocks, tanks, vehicles), kept on this side.
   */
  function chunkJob(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const list = map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK).filter((b) => ownChunk(b, x0, z0));
    const boxes = [], apart = [];
    for (const b of list) (isChunkBox(b) ? boxes : apart).push(b);
    const bldgs = (buildingsIn.get(key(cx, cz)) || []).map((r) => {
      if (!((r.type === 'building' || r.type === 'civic') && r.top - (r.floor ?? 0) > 2.8)) return r;
      const cxr = (r.minX + r.maxX) / 2, czr = (r.minZ + r.maxZ) / 2;
      let front = null, nd = 60;
      for (const q of map.roadsNear(cxr, czr, 60)) {
        const dx = q.x2 - q.x1, dz = q.z2 - q.z1, l2 = dx * dx + dz * dz || 1, u = Math.max(0, Math.min(1, ((cxr - q.x1) * dx + (czr - q.z1) * dz) / l2));
        const px = q.x1 + dx * u, pz = q.z1 + dz * u, d = Math.hypot(px - cxr, pz - czr);
        if (d < nd) { nd = d; front = { x: px, z: pz }; }
      }
      return front ? { ...r, front } : r;
    });
    return { req: { boxes, bldgs, ownHouse: ownHouseId }, apart };
  }
  /** A chunk, built all at once on this thread (the first few, or with no worker). */
  function buildChunk(cx, cz) {
    const { req, apart } = chunkJob(cx, cz);
    return finishChunk(cx, cz, buildChunkBuffers(req), apart);
  }
  /** A chunk from its buildings' finished buffers: the ground, roads, trees and the rest are added here. */
  /** A chunk's ground and roads (the heavier half of wrapping one up, so it can go in a frame of its own). */
  function groundOf(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    return { ground: buildTerrain(x0, z0), roads: map.roadGrid && buildRoads(x0, z0), palms: understory(x0, z0) };
  }
  /**
   * Saw palmetto under the pines: clumps scattered through the woods (and scrub and marsh edges),
   * decoration you walk through like the grass, the same for everyone (placed by a hash of where).
   * Kept off roads, out of buildings and from right against a tree. [x, y, z, size, turn] each.
   */
  function understory(x0, z0) {
    if (!terrain.hasCover) return [];
    const out = [], STEP = mobile ? 9 : 6.5, roads = map.roadsNear(x0 + CHUNK / 2, z0 + CHUNK / 2, CHUNK);
    const nearRoad = (x, z) => roads.some((r) => { const dx = r.x2 - r.x1, dz = r.z2 - r.z1, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (z - r.z1) * dz) / l2)); return Math.hypot(r.x1 + dx * t - x, r.z1 + dz * t - z) < (r.width || 8) / 2 + 2; });
    for (let gx = x0; gx < x0 + CHUNK; gx += STEP) for (let gz = z0; gz < z0 + CHUNK; gz += STEP) {
      const h1 = hash((Math.floor(gx * 7.3) * 73856093) ^ (Math.floor(gz * 7.3) * 19349663)) / 4294967296;
      const c = terrain.cover(gx, gz), want = c === COVER.woods ? 0.42 : c === COVER.scrub ? 0.6 : c === COVER.marsh ? 0.25 : 0;
      if (h1 >= want) continue;
      const h2 = hash(Math.floor(h1 * 1e9)) / 4294967296, h3 = hash(Math.floor(h2 * 1e9) + 7) / 4294967296;
      const x = gx + (h2 - 0.5) * STEP * 0.9, z = gz + (h3 - 0.5) * STEP * 0.9, y = terrain.drawn(x, z);
      if (y < 0.4 || nearRoad(x, z) || map.grid.near(x, z, 1.2).some((b) => !b.nature || Math.hypot((b.minX + b.maxX) / 2 - x, (b.minZ + b.maxZ) / 2 - z) < 1.0)) continue;
      out.push(x, y, z, 0.75 + h2 * 0.7, h3 * Math.PI * 2);
    }
    return out;
  }
  function finishChunk(cx, cz, bufs, list, pre = groundOf(cx, cz)) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const trees = [], pines = [], canopies = [], tanks = [], rocks = [], rigs = [], brush = [];
    for (const b of list) {
      if (b.type === 'tree') trees.push(b);
      else if (b.nature && (b.type === 'rock' || b.type === 'boulder')) rocks.push(b);
      else if (b.type === 'pine') pines.push(b);
      else if (b.type === 'canopy') canopies.push(b);
      else if (b.type === 'tank') tanks.push(b);
      else if (b.type === 'car' || b.type === 'vehiclebody') rigs.push(b);   // drawn as real vehicles, below
      else if (b.type === 'scrub') brush.push(b);
    }
    const group = new THREE.Group();
    const { ground, roads } = pre;
    group.add(ground.mesh);
    if (roads) group.add(roads);
    if (ground.wet) { const w = new THREE.Mesh(waterGeo, waterMat); w.position.set(x0 + CHUNK / 2, 0, z0 + CHUNK / 2); group.add(w); }
    const MATS = { office: texturedMat, siding: sidingMat, brick: brickMat, stucco: stuccoMat, block: blockMat, metal: metalMat, planks: plankMat, plain: plainMat, roof: roofMat, shingles: shingleMat, panes: paneMat, furn: plainMat };
    for (const k of CHUNK_BUFS) {
      if (!bufs[k]) continue;
      const m = new THREE.Mesh(toGeometry(bufs[k]), MATS[k]);
      m.castShadow = k !== 'furn';   // (furniture is indoors, under a roof: its shadows would never be seen)
      m.receiveShadow = k !== 'roof';
      group.add(m);
    }
    // The trees: real 3D ones, batched by which build each uses. Every build has a full version (shown
    // when the chunk is near) and a light one (further off); the stump mesh only shows once one is cut.
    const treeLod = [];
    const forest = (list, kind) => {
      if (!list.length) return;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
      const byBuild = new Map();
      for (const t of list) { const [v, sx] = treePick(kit, kind, t.id, t.h); if (!byBuild.has(v)) byBuild.set(v, []); byBuild.get(v).push([t, sx]); }
      let ti = 0;
      for (const [v, ts] of byBuild) {
        const mk = (geo, mat, depth) => {
          const m = new THREE.InstancedMesh(geo, mat, ts.length);
          m.castShadow = !mobile; m.receiveShadow = !mobile;
          if (depth) m.customDepthMaterial = depth;
          group.add(m);
          return m;
        };
        const full = [mk(v.full.wood, kit.barkFor(v)), mk(v.full.leaves, kit.leafMat, kit.leafDepth)];
        const lite = [mk(v.lite.wood, kit.barkFor(v)), mk(v.lite.leaves, kit.leafMat, kit.leafDepth)];
        for (const m of [...full, ...lite]) m.userData.noAO = true;   // thin branches in the corner shading only get dark outlines
        treeLod.push({ full, lite });
        ts.forEach(([t, sx], i) => {
          const k = 0.86 + ((t.id * 13) % 9) * 0.035;   // each tree a slightly different green and bark
          tint.setRGB(k, k, k * (0.96 + ((t.id * 7) % 5) * 0.02));
          for (const m of [full[1], lite[1]]) m.setColorAt(i, tint);
          for (const m of [full[0], lite[0]]) m.setColorAt(i, tint.setRGB(k, k, k));
          const x = (t.minX + t.maxX) / 2, z = (t.minZ + t.maxZ) / 2;
          treeSlots.set(t, { trunks, ti: ti++, parts: [...full, ...lite], i, x, y: t.y0 || 0, z, h: t.h, sx, yaw: (t.id * 2.399) % (Math.PI * 2) });
          setTreeMatrix(t);
        });
      }
      trunks.castShadow = !mobile;
      group.add(trunks);
    };
    const palms = pre.palms || [], nPalm = palms.length / 5;
    if (brush.length || nPalm) {
      const im = new THREE.InstancedMesh(palmettoGeo, palmettoMat, brush.length + nPalm), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
      brush.forEach((b, i) => {   // brush the map stands up as solid (scrub boxes)
        const x = (b.minX + b.maxX) / 2, z = (b.minZ + b.maxZ) / 2, w = (b.maxX - b.minX) * 0.62, h = b.h * 0.85, k = 0.85 + ((b.id * 7) % 6) * 0.05;
        q.setFromAxisAngle(up, (b.id * 2.399) % (Math.PI * 2));
        im.setMatrixAt(i, tm.compose(v.set(x, b.y0 ?? terrain.drawn(x, z), z), q, sc.set(w * 1.7, h * 1.35, w * 1.7)));
        im.setColorAt(i, tint.setRGB(k, k * (0.97 + ((b.id * 3) % 5) * 0.015), k * 0.9));
      });
      for (let j = 0; j < nPalm; j++) {   // the understory
        const [x, y, z, s, yaw] = palms.slice(j * 5, j * 5 + 5), k = 0.82 + (s - 0.75) * 0.3, i = brush.length + j;
        q.setFromAxisAngle(up, yaw);
        im.setMatrixAt(i, tm.compose(v.set(x, y - 0.05, z), q, sc.set(1.5 * s, 1.15 * s, 1.5 * s)));
        im.setColorAt(i, tint.setRGB(k, k * (0.95 + (yaw % 0.1)), k * 0.88));
      }
      im.castShadow = !mobile; im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    }
    // Rocks you can mine: chunky stones, one batch per chunk, so a mined-out one can crumble in place.
    if (rocks.length) {
      const im = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);
      rocks.forEach((r, i) => { im.setColorAt(i, new THREE.Color(...(r.type === 'boulder' ? COLORS.boulder : COLORS.rock))); treeSlots.set(r, { rock: im, i, x: (r.minX + r.maxX) / 2, y: r.y0 || 0, z: (r.minZ + r.maxZ) / 2, w: r.maxX - r.minX, d: r.maxZ - r.minZ, h: r.h }); setTreeMatrix(r); });
      im.castShadow = true; im.receiveShadow = true;
      group.add(im);
    }
    forest(trees, 'tree');
    forest(pines, 'pine');
    group.userData.treeLod = treeLod; group.userData.at = [x0, z0];
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
  const FAR_SKIP = new Set(['terminal', 'rail', 'border', 'cover', 'rock', 'car', 'crate', 'scrub', 'cactus', 'boulder', 'jetty', 'canopy', 'caveroof', 'ladder']);
  /** The same buildings as plain boxes with their roofs, and the trees as bare crowns. No ground. */
  function buildFar(cx, cz) {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const boxes = newBuf(false), roof = newBuf(false);
    for (const b of map.grid.rect(x0, z0, x0 + CHUNK, z0 + CHUNK, [], true)) {
      if (b.nature || FAR_SKIP.has(b.type) || !ownChunk(b, x0, z0)) continue;
      pushBox(boxes, b, paint(b)[0], 0);
    }
    for (const r of buildingsIn.get(key(cx, cz)) || []) {
      if (r.roof) pushRoof(roof, r, pick(ROOF_COLORS, r.look ?? r.bldg), wallColor(r));
      else if (r.type === 'warehouse') pushRoof(roof, r, pick(METAL_ROOFS, r.look ?? r.bldg), wallColor(r), true);
      else if (r.type === 'building' || r.type === 'civic') pushFlatRoof(boxes, r, wallColor(r));
    }
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

  // ------------------------------------------------------------------ the chunk worker
  // Buildings are laid out off this thread (client/chunkworker.js) so new ground doesn't stall a frame.
  // Without workers (or if it fails to start), chunks are built here as before.
  const pending = new Map();   // key -> job sent to the worker
  const ready = new Map();     // key -> job with its buffers back, waiting to be wrapped up
  let chunkGen = 0, jobId = 0, worker = null;
  try {
    worker = new Worker('/chunkworker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const { id, out, error } = e.data;
      for (const [k, job] of pending) {
        if (job.id !== id) continue;
        pending.delete(k);
        if (error) { console.warn('chunk worker:', error); job.out = buildChunkBuffers(job.req); } else job.out = out;
        job.req = null;
        ready.set(k, job);
        break;
      }
    };
    worker.onerror = (e) => { console.warn('chunk worker failed; building on the page', e.message || e); worker = null; for (const [k, job] of pending) { job.out = buildChunkBuffers(job.req); ready.set(k, job); } pending.clear(); };
  } catch { worker = null; }
  function requestChunk(cx, cz) {
    const { req, apart } = chunkJob(cx, cz), id = ++jobId;
    const job = { id, cx, cz, apart, req, gen: chunkGen };
    pending.set(key(cx, cz), job);
    worker.postMessage({ id, req });
  }

  const primed = [];   // drawn this frame whatever way you face (see update)
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
      chunkGen++; pending.clear(); ready.clear();   // (anything in the works still has the old walls)
    },
    update(px, pz, speed = 0) {
      // New ground is drawn once whatever way you face, so its shapes reach the graphics card as it's
      // built, not in a lump the moment you turn to look at it (a hitch on every turn).
      for (const m of primed) m.frustumCulled = true;
      primed.length = 0;
      const prime = (g) => g?.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.frustumCulled && o.visible) { o.frustumCulled = false; primed.push(o); } });
      sky.position.set(px, 0, pz);
      for (const c of bridgeCells) { const nearBy = Math.hypot(c.x - px, c.z - pz) < viewRange + 300; c.near.visible = nearBy; c.far.visible = !nearBy; }
      waterTime.value = performance.now() / 1000;
      // Grass blades are laid out around you as you move. At driving speed they'd be laid out again
      // several times a second (a stutter on a phone) for blades nobody can see go by: hide them, and
      // lay them out again once you slow down.
      if (grassMesh) {
        const fast = speed > 9;
        grassMesh.visible = !fast;
        if (!fast && (!grassAt || Math.hypot(px - grassAt.x, pz - grassAt.z) > 6) && !chunkBuiltLast) { layGrass(px, pz); grassThisFrame = true; }
      }
      const want = new Set();
      let built = 0;
      const t0 = performance.now();
      // One heavy job a frame: new ground or a fresh layout of grass, never both (each is several ms).
      // The buildings of new ground are laid out in the background (chunkworker.js); here a finished one
      // is only wrapped up with its ground and trees, one a frame. The first few are built at once, so
      // you never arrive to an empty world, and so is everything if there's no worker.
      const order = chunksWithin(px, pz, viewRange);
      for (const [, cx, cz] of order) want.add(key(cx, cz));
      for (const [k, job] of ready) {
        if (!want.has(k) || job.gen !== chunkGen || chunks.has(k)) { ready.delete(k); continue; }
        if (built >= (grassThisFrame ? 0 : 1)) break;
        // Two frames each: its ground and roads in one, its buildings and trees in the next.
        if (!job.pre) { job.pre = groundOf(job.cx, job.cz); built++; continue; }
        ready.delete(k);
        const g = finishChunk(job.cx, job.cz, job.out, job.apart, job.pre);
        chunks.set(k, g); prime(g); built++;
      }
      const hereK = key(Math.floor(px / CHUNK), Math.floor(pz / CHUNK)), empty = chunks.size === 0;
      for (const [, cx, cz] of order) {
        const k = key(cx, cz);
        if (chunks.has(k) || pending.has(k) || ready.has(k)) continue;
        // Built here and now: the first few when the world is empty (you've just arrived), and the
        // ground under your feet if it's somehow missing; the rest come from the worker.
        const sync = !worker || (empty && built < 4) || k === hereK;
        if (sync) {
          if (built >= (empty || k === hereK ? 9 : grassThisFrame ? 0 : 1)) continue;
          const g = buildChunk(cx, cz);
          chunks.set(k, g); prime(g); built++;
          continue;
        }
        if (pending.size >= 2) break;   // nearest first: a couple in hand at a time keeps the order right as you move
        requestChunk(cx, cz);
      }
      chunkBuiltLast = built > 0 && chunks.size >= 4; grassThisFrame = false;
      for (const [k, g] of chunks) if (!want.has(k)) { dispose(g); chunks.delete(k); }
      // Trees: the full build in chunks close by, the light one further off; and a breeze in the leaves.
      kit.tick(waterTime.value);
      for (const g of chunks.values()) {
        const [x0, z0] = g.userData.at || [0, 0], lod = g.userData.treeLod;
        if (!lod?.length) continue;
        const d = Math.hypot(Math.max(x0 - px, 0, px - x0 - CHUNK), Math.max(z0 - pz, 0, pz - z0 - CHUNK));
        const near = d < (mobile ? 1 : TREE_FULL);   // phones: the full build only in the chunk you're in
        if (g.userData.near === near) continue;
        g.userData.near = near;
        for (const l of lod) { for (const m of l.full) m.visible = near; for (const m of l.lite) m.visible = !near; }
        prime(g);
      }
      // Far stand-ins: built a few a frame, shown only where the full-detail chunk isn't.
      const wantFar = new Set();
      built = 0;
      for (const [, cx, cz] of chunksWithin(px, pz, farRange)) {
        const k = key(cx, cz);
        wantFar.add(k);
        if (!farChunks.has(k) && built < 3 && performance.now() - t0 < 8) { farChunks.set(k, buildFar(cx, cz)); prime(farChunks.get(k)); built++; }
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
