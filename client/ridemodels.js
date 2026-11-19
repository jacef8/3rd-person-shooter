// Low-poly models of the rides (cars, trucks, bikes, horses...), and of the abandoned cars and the
// RVs, buses, box trucks and houseboats people live in. Used by the game (main.js) for rides you can
// drive, and by the world view for the wrecks and vehicle homes that are part of the map.
import * as THREE from 'three';
import { GLTFLoader } from '/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from '/addons/utils/BufferGeometryUtils.js';
import { BOATS } from '/shared/boats.js';
import { animalModel } from '/animals.js';

// Real models (client/models/vehicles, tools/build_vehicles.mjs): each is one unit long, front at +Z,
// wheels on y = 0. A ride is built from boxes first (shown at once) and swaps to its real model when
// that has loaded; kinds with no real model keep the boxes.
const REAL = { car: ['sedan', 'suv', 'classic'], pickup: ['pickup'], motorcycle: ['motorcycle'], dirtbike: ['motorcycle'], tractor: ['tractor'] };
const gltf = new GLTFLoader(), realCache = new Map();
// Each has a light copy, <name>_lo.glb (~2,000 triangles against 7-9,000; tools/build_vehicle_lods.mjs):
// a phone only ever uses those; a computer shows the full one up close and the light one past LO_AT.
const HAS_LO = new Set(['sedan', 'suv', 'classic', 'pickup', 'motorcycle', 'bus']), LO_AT = 28;
let lowOnly = false;
/** Phones and TV boxes: the light vehicle models only (set once at the start, before any are made). */
export function vehicleDetail(low) { lowOnly = !!low; }
function realModel(name) {
  if (!realCache.has(name)) realCache.set(name, gltf.loadAsync(`/models/vehicles/${name}.glb`).then((g) => {
    const m = mergeByMaterial(g.scene);
    m.traverse((o) => { if (o.isMesh) { o.geometry.userData.shared = true; o.castShadow = true; } });
    return m;
  }).catch((e) => { console.warn('vehicle', name, e); return null; }));
  return realCache.get(name);
}
/**
 * One mesh per material instead of the model's dozens of parts: each part is a separate draw for the
 * graphics chip, and with a street full of cars that was thousands a frame (the lag). Same look.
 */
function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || Array.isArray(o.material)) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (o.matrixWorld.determinant() < 0) {   // a mirrored part: turn its faces back the right way out
      if (!g.index) g = g.toNonIndexed();
      if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
    }
    (byMat.get(o.material) || byMat.set(o.material, []).get(o.material)).push(g);
  });
  const out = new THREE.Group();
  for (const [mat, list] of byMat) {
    const keep = ['position', 'normal', 'uv', 'color', 'tangent'].filter((a) => list.every((g) => g.attributes[a]));
    const allIdx = list.every((g) => g.index);
    const parts = list.map((g) => { const src = allIdx ? g : g.index ? g.toNonIndexed() : g; const n = new THREE.BufferGeometry(); for (const a of keep) n.setAttribute(a, src.attributes[a]); if (allIdx) n.setIndex(src.index); return n; });
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!merged) { for (const g of list) out.add(new THREE.Mesh(g, mat)); continue; }
    out.add(new THREE.Mesh(merged, mat));
  }
  return out;
}
const fadedCache = new Map();
/** A weathered copy of a model's materials (sun-faded, dusty, no shine), shared by every wreck of it. */
function faded(name, src) {
  if (!fadedCache.has(name)) {
    const map = new Map();
    src.traverse((o) => {
      if (!o.isMesh || map.has(o.material)) return;
      const m = o.material.clone();
      m.roughness = 1; m.metalness = 0;
      // Glass: grimed over and cracked dark, not clear.
      if (m.transparent) { m.transparent = false; m.opacity = 1; m.color.setHex(0x2b2a26); m.map = null; }
      // Sun-bleached and dusty (most of the colour gone, darker, a brown cast), with rust coming
      // through in blotches, worst low down, so it reads as dead from across the street.
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = 'varying vec3 vWr;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWr = position;');
        sh.fragmentShader = 'varying vec3 vWr;\nfloat wrH(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }\nfloat wrN(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);\n  return mix(mix(mix(wrH(i), wrH(i + vec3(1,0,0)), f.x), mix(wrH(i + vec3(0,1,0)), wrH(i + vec3(1,1,0)), f.x), f.y), mix(mix(wrH(i + vec3(0,0,1)), wrH(i + vec3(1,0,1)), f.x), mix(wrH(i + vec3(0,1,1)), wrH(i + vec3(1,1,1)), f.x), f.y), f.z); }\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  { float l = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)); diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.3) * vec3(0.72, 0.64, 0.55);
    float n = wrN(vWr * 5.0) * 0.65 + wrN(vWr * 17.0) * 0.35;
    float low = 1.0 - smoothstep(0.05, 0.3, vWr.y);
    float rust = smoothstep(0.66 - 0.16 * low, 0.72 - 0.16 * low, n);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.15, 0.06) * (0.7 + 0.6 * wrN(vWr * 90.0)), rust * 0.9); }`);
      };
      m.customProgramCacheKey = () => 'faded3';
      map.set(o.material, m);
    });
    fadedCache.set(name, map);
  }
  return fadedCache.get(name);
}
/** Swap a ride's box model for the real one, `len` metres long. */
function useReal(g, name, len, { fade = false } = {}) {
  const lo = HAS_LO.has(name), names = lo && lowOnly ? [`${name}_lo`] : lo ? [name, `${name}_lo`] : [name];
  Promise.all(names.map(realModel)).then(([src, srcLo]) => {
    if (!src || g.userData.disposed) return;
    const dress = (n, s) => { const c = s.clone(); if (fade) { const mats = faded(n, s); c.traverse((o) => { if (o.isMesh) o.material = mats.get(o.material) || o.material; }); } return c; };
    let m = dress(names[0], src);
    if (srcLo) { const l = new THREE.LOD(); l.addLevel(m, 0); l.addLevel(dress(names[1], srcLo), LO_AT); m = l; }
    m.scale.setScalar(len);
    const body = g.userData.body;
    for (const c of body.children) c.visible = false;
    body.add(m);
    g.userData.real = m;
  });
}
/** Start fetching the real models early. */
export function preloadVehicles() { for (const list of [...Object.values(REAL), ['bus']]) for (const n of list) { if (!lowOnly || !HAS_LO.has(n)) realModel(n); if (HAS_LO.has(n)) realModel(`${n}_lo`); } }

// Shared bits for the ride models (built once, reused by every ride).
const RIDE_MAT = {
  tire: new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.4, metalness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x24323d, roughness: 0.15, metalness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.7 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.25, metalness: 0.8 }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0x806a40, roughness: 0.3 }),
  tail: new THREE.MeshStandardMaterial({ color: 0xb01818, emissive: 0x400606, roughness: 0.3 }),
  leather: new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 }),
};
/** A low-poly model of each kind of ride, in its paint colour. Wheels spin, horses' legs walk. */
export function buildRideModel(type, color, { real: wantReal = true } = {}) {
  const def = BOATS[type], g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshStandardMaterial({ color: color || def.colors?.[0] || 0x888888, roughness: 0.45, metalness: type === 'horse' ? 0 : 0.35 });
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const wheels = [], legs = [];
  /** A wheel at (x, y=r, z): a tyre with a hub, on a pivot that spins. */
  const wheel = (x, z, r, w = 0.22, thin = false) => {
    const pivot = new THREE.Group(); pivot.position.set(x, r, z); body.add(pivot);
    if (thin) { const t = new THREE.Mesh(new THREE.TorusGeometry(r - 0.03, 0.035, 6, 18), RIDE_MAT.tire); t.rotation.y = Math.PI / 2; pivot.add(t);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 6), RIDE_MAT.rim); hub.rotation.z = Math.PI / 2; pivot.add(hub);
      for (let i = 0; i < 3; i++) { const sp = new THREE.Mesh(boxG(0.01, (r - 0.05) * 2, 0.012), RIDE_MAT.rim); sp.rotation.x = (i * Math.PI) / 3; pivot.add(sp); }
    } else {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 14), RIDE_MAT.tire); t.rotation.z = Math.PI / 2; pivot.add(t);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10), RIDE_MAT.rim); hub.rotation.z = Math.PI / 2; pivot.add(hub);
      const mark = new THREE.Mesh(boxG(w + 0.03, r * 0.9, 0.05), RIDE_MAT.dark); pivot.add(mark);   // so you can see it turn
    }
    wheels.push({ pivot, r });
    return pivot;
  };
  const L = def.len, W = def.wid;
  if (type === 'car') {
    add(boxG(W, 0.55, L), paint, 0, 0.6, 0);
    const cab = add(boxG(W * 0.86, 0.5, L * 0.48), RIDE_MAT.glass, 0, 1.12, -0.25);
    add(boxG(W * 0.88, 0.06, L * 0.46), paint, 0, 1.39, -0.25);
    void cab;
    for (const s of [-1, 1]) { add(boxG(0.3, 0.12, 0.05), RIDE_MAT.head, s * W * 0.32, 0.72, L / 2 + 0.01); add(boxG(0.3, 0.12, 0.05), RIDE_MAT.tail, s * W * 0.32, 0.72, -L / 2 - 0.01); }
    add(boxG(W + 0.04, 0.14, 0.12), RIDE_MAT.dark, 0, 0.4, L / 2); add(boxG(W + 0.04, 0.14, 0.12), RIDE_MAT.dark, 0, 0.4, -L / 2);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.08), e * L * 0.32, 0.33);
  } else if (type === 'pickup') {
    add(boxG(W, 0.6, L), paint, 0, 0.85, 0);
    add(boxG(W * 0.96, 0.62, 1.7), paint, 0, 1.45, 0.75);
    add(boxG(W * 0.97, 0.42, 0.06), RIDE_MAT.glass, 0, 1.5, 1.61);
    for (const s of [-1, 1]) add(boxG(0.06, 0.4, 1.4), RIDE_MAT.glass, s * W * 0.485, 1.5, 0.8);
    for (const s of [-1, 1]) add(boxG(0.08, 0.35, L * 0.42), paint, s * (W / 2 - 0.04), 1.32, -L * 0.27);
    add(boxG(W, 0.35, 0.08), paint, 0, 1.32, -L / 2 + 0.04);
    for (const s of [-1, 1]) { add(boxG(0.32, 0.14, 0.05), RIDE_MAT.head, s * W * 0.32, 0.98, L / 2 + 0.01); add(boxG(0.14, 0.3, 0.05), RIDE_MAT.tail, s * W * 0.44, 1.2, -L / 2 - 0.01); }
    add(boxG(W + 0.06, 0.18, 0.14), RIDE_MAT.chrome, 0, 0.6, L / 2);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.1), e * L * 0.32, 0.42, 0.28);
  } else if (type === 'motorcycle' || type === 'dirtbike') {
    const dirt = type === 'dirtbike', r = dirt ? 0.36 : 0.32;
    wheel(0, L / 2 - r, r, 0.12); wheel(0, -L / 2 + r, r, 0.14);
    add(boxG(0.18, 0.22, L * 0.55), RIDE_MAT.dark, 0, r + 0.25, 0);
    add(boxG(0.32, 0.22, 0.5), paint, 0, r + 0.42, 0.25);   // tank
    add(boxG(0.28, 0.1, 0.6), RIDE_MAT.dark, 0, r + 0.48, -0.25);   // seat
    add(boxG(0.7, 0.04, 0.04), RIDE_MAT.chrome, 0, r + 0.72, L / 2 - r - 0.05);   // bars
    const fork = add(boxG(0.05, 0.6, 0.05), RIDE_MAT.chrome, 0, r + 0.3, L / 2 - r - 0.05); fork.rotation.x = -0.35;
    if (dirt) { add(boxG(0.22, 0.04, 0.5), paint, 0, r * 2 + 0.05, L / 2 - r); add(boxG(0.22, 0.04, 0.6), paint, 0, r * 2 + 0.1, -L / 2 + r + 0.2); }
    else { add(boxG(0.1, 0.1, 0.6), RIDE_MAT.chrome, 0.16, r * 0.8, -0.35); add(boxG(0.18, 0.1, 0.05), RIDE_MAT.head, 0, r + 0.62, L / 2 - 0.25); }
  } else if (type === 'atv') {
    add(boxG(0.9, 0.3, 1.5), paint, 0, 0.62, 0);
    add(boxG(1.15, 0.08, 0.45), paint, 0, 0.82, 0.7); add(boxG(1.15, 0.08, 0.45), paint, 0, 0.82, -0.7);   // fenders
    add(boxG(0.36, 0.14, 0.6), RIDE_MAT.dark, 0, 0.84, -0.1);
    add(boxG(0.8, 0.04, 0.04), RIDE_MAT.chrome, 0, 1.05, 0.5);
    add(boxG(0.9, 0.04, 0.4), RIDE_MAT.dark, 0, 0.95, 0.85); add(boxG(0.9, 0.04, 0.4), RIDE_MAT.dark, 0, 0.95, -0.85);   // racks
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * 0.5, e * 0.68, 0.3, 0.25);
  } else if (type === 'golfcart') {
    add(boxG(W, 0.22, L), paint, 0, 0.36, 0);
    add(boxG(W * 0.95, 0.5, 0.55), paint, 0, 0.6, 0.85);   // nose
    add(boxG(W * 0.9, 0.14, 0.55), RIDE_MAT.dark, 0, 0.62, -0.05);   // bench
    add(boxG(W * 0.9, 0.5, 0.1), RIDE_MAT.dark, 0, 0.92, -0.32);
    add(boxG(W * 1.02, 0.06, L * 0.82), RIDE_MAT.chrome, 0, 1.75, 0.05);   // roof
    for (const s of [-1, 1]) for (const e of [0.75, -0.6]) add(boxG(0.04, 1.3, 0.04), RIDE_MAT.chrome, s * W * 0.45, 1.12, e);
    add(boxG(W * 0.8, 0.5, 0.04), RIDE_MAT.glass, 0, 1.45, 0.76);
    for (const s of [-1, 1]) for (const e of [-1, 1]) wheel(s * (W / 2 - 0.08), e * L * 0.34, 0.2, 0.16);
  } else if (type === 'bicycle') {
    wheel(0, 0.52, 0.34, 0.04, true); wheel(0, -0.52, 0.34, 0.04, true);
    const bar = (x1, y1, z1, x2, y2, z2) => { const len = Math.hypot(y2 - y1, z2 - z1); const m = add(boxG(0.035, len, 0.035), paint, 0, (y1 + y2) / 2, (z1 + z2) / 2); m.rotation.x = Math.atan2(z2 - z1, y2 - y1); void x1; void x2; return m; };
    bar(0, 0.34, -0.52, 0, 0.8, -0.12); bar(0, 0.34, 0, 0, 0.8, -0.12); bar(0, 0.8, -0.12, 0, 0.82, 0.38); bar(0, 0.34, 0, 0, 0.82, 0.38); bar(0, 0.34, 0.52, 0, 0.92, 0.42);
    add(boxG(0.16, 0.05, 0.26), RIDE_MAT.dark, 0, 0.86, -0.16);
    add(boxG(0.55, 0.03, 0.03), RIDE_MAT.dark, 0, 0.98, 0.42);
  } else if (type === 'skateboard') {
    add(boxG(0.22, 0.025, 0.82), paint, 0, 0.1, 0);
    add(boxG(0.2, 0.004, 0.78), RIDE_MAT.dark, 0, 0.114, 0);
    for (const e of [-1, 1]) { add(boxG(0.18, 0.03, 0.05), RIDE_MAT.chrome, 0, 0.07, e * 0.27); for (const s of [-1, 1]) wheel(s * 0.09, e * 0.27, 0.035, 0.03); }
  } else if (type === 'tractor') {
    wheel(-0.85, -0.85, 0.78, 0.42); wheel(0.85, -0.85, 0.78, 0.42); wheel(-0.72, 1.15, 0.42, 0.24); wheel(0.72, 1.15, 0.42, 0.24);
    add(boxG(0.75, 0.75, 2.0), paint, 0, 1.05, 0.55);   // engine hood
    add(boxG(0.95, 0.5, 0.9), paint, 0, 0.95, -0.7);
    add(boxG(0.5, 0.12, 0.45), RIDE_MAT.dark, 0, 1.3, -0.65);   // seat
    add(boxG(0.5, 0.45, 0.08), RIDE_MAT.dark, 0, 1.55, -0.88);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), RIDE_MAT.dark, 0.25, 1.85, 1.0);   // exhaust
    for (const s of [-1, 1]) for (const e of [-1.05, -0.25]) add(boxG(0.05, 1.3, 0.05), RIDE_MAT.dark, s * 0.6, 2.0, e);   // rollover frame
    add(boxG(1.3, 0.06, 1.0), paint, 0, 2.62, -0.65);   // canopy
    for (const s of [-1, 1]) add(boxG(0.5, 0.08, 1.0), paint, s * 0.85, 1.6, -0.85);   // fenders
    add(boxG(0.5, 0.06, 0.04), RIDE_MAT.head, 0, 1.2, 1.56);
  } else if (type === 'horse') {
    const coat = paint, mane = new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.9 });
    const trunk = add(new THREE.SphereGeometry(0.5, 14, 10), coat, 0, 1.3, 0); trunk.scale.set(0.82, 0.85, 1.75);
    const neck = add(new THREE.CylinderGeometry(0.17, 0.27, 0.95, 10), coat, 0, 1.75, 0.82); neck.rotation.x = 0.65;
    const head = add(new THREE.BoxGeometry(0.24, 0.26, 0.6), coat, 0, 2.05, 1.25); head.rotation.x = 0.55;
    add(boxG(0.06, 0.5, 0.75), mane, 0, 1.92, 0.7).rotation.x = 0.65;
    for (const s of [-1, 1]) add(boxG(0.05, 0.14, 0.05), coat, s * 0.08, 2.32, 1.08);   // ears
    const tail = add(new THREE.CylinderGeometry(0.06, 0.1, 0.75, 6), mane, 0, 1.15, -0.95); tail.rotation.x = -0.45;
    add(boxG(0.66, 0.14, 0.7), RIDE_MAT.leather, 0, 1.73, -0.05).userData.tack = true;   // saddle
    for (const s of [-1, 1]) add(boxG(0.06, 0.4, 0.5), RIDE_MAT.leather, s * 0.42, 1.38, -0.35).userData.tack = true;   // saddlebags
    for (const [x, z] of [[-0.2, 0.62], [0.2, 0.62], [-0.2, -0.62], [0.2, -0.62]]) {
      const hip = new THREE.Group(); hip.position.set(x, 1.15, z); body.add(hip);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.6, 7), coat); upper.position.y = -0.3; hip.add(upper);
      const knee = new THREE.Group(); knee.position.y = -0.6; hip.add(knee);
      const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 6), coat); lower.position.y = -0.25; knee.add(lower);
      const hoof = new THREE.Mesh(boxG(0.1, 0.06, 0.12), mane); hoof.position.y = -0.52; knee.add(hoof);
      legs.push({ hip, knee, front: z > 0, side: x });
    }
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.rotation.order = 'YXZ';
  g.userData = { body, wheels, legs, gait: 0, lean: 0 };
  const real = REAL[type];
  if (real && wantReal) useReal(g, real[Math.abs(Math.round((color || 0) / 7)) % real.length], def.len);
  // The horse: a real, animated one (client/models/animals/horse.glb) in place of the shapes, once it
  // has loaded; the saddle and bags stay. Its walk and gallop follow the ride's speed (main.js).
  if (type === 'horse' && wantReal) animalModel('horse').then((m) => {
    if (!m || g.userData.disposed) return;
    for (const c of [...body.children]) if (!c.userData.tack) body.remove(c);
    body.add(m.model);
    g.userData.legs = []; g.userData.anim = m.anim;
  });
  return g;
}

/** An abandoned car or pickup by the road: faded paint, sat low on flat tyres, a little skewed. */
export function buildWreck(seed) {
  const type = seed % 3 === 0 ? 'pickup' : 'car';
  const FADED = [0x6e4b35, 0x5d5f5a, 0x7d6a4c, 0x48525a, 0x6b3a2e, 0x8a8577];
  const g = buildRideModel(type, FADED[seed % FADED.length], { real: false });
  g.traverse((o) => { if (o.isMesh && o.material?.color && o.material !== RIDE_MAT.tire) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.8); o.material.roughness = 0.95; o.material.metalness = 0.1; } });
  // Flat tyres: sat down on its rims, sagging to one corner.
  g.userData.body.position.y = -0.17;
  g.userData.body.rotation.z = (seed % 2 ? 1 : -1) * (0.025 + (seed % 5) * 0.006);
  g.userData.body.rotation.x = ((seed >>> 3) % 2 ? 1 : -1) * 0.02;
  g.userData.wreckType = type;
  // The real thing, sun-faded, in place of the boxes.
  const pick = type === 'pickup' ? 'pickup' : ['sedan', 'suv', 'classic'][(seed >>> 2) % 3];
  useReal(g, pick, BOATS[type].len, { fade: true });
  return g;
}

/** The vehicles people live in: an RV, a school bus, a box truck, a houseboat. Built to the size of
 *  the claimable box (`len` along +Z, `wid`, `h`); the lockable door at the back is drawn by the game. */
export function buildHomeVehicle(vtype, len, wid, h, color) {
  const g = new THREE.Group(), body = new THREE.Group();
  g.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
  const trim = new THREE.MeshStandardMaterial({ color: vtype === 'bus' ? 0x1a1a1a : 0x7a5a3a, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); body.add(m); return m; };
  const box = (w, hh, d) => new THREE.BoxGeometry(w, hh, d);
  const wheel = (x, z, r) => { const t = add(new THREE.CylinderGeometry(r, r, 0.3, 14), RIDE_MAT.tire, x, r, z); t.rotation.z = Math.PI / 2; const hub = add(new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.32, 10), RIDE_MAT.rim, x, r, z); hub.rotation.z = Math.PI / 2; };
  const windows = (y, hh, z0, z1, n, inset = 0.02) => {
    const step = (z1 - z0) / n;
    for (const s of [-1, 1]) for (let k = 0; k < n; k++) add(box(0.04, hh, step * 0.72), RIDE_MAT.glass, s * (wid / 2 + inset), y, z0 + step * (k + 0.5));
  };
  if (vtype === 'houseboat') {
    add(box(wid, 0.8, len), new THREE.MeshStandardMaterial({ color: 0x3d4a52, roughness: 0.6 }), 0, 0.3, 0);   // hull
    add(box(wid * 0.82, h - 1.0, len * 0.66), white, 0, 0.7 + (h - 1.0) / 2, -len * 0.08);   // cabin
    add(box(wid * 0.9, 0.12, len * 0.72), paint, 0, h - 0.24, -len * 0.08);   // roof
    windows(1.6, 0.7, -len * 0.38, len * 0.22, 4);
    for (const s of [-1, 1]) add(box(0.05, 0.8, len * 0.96), RIDE_MAT.chrome, s * (wid / 2 - 0.05), 1.1, 0);   // rails
  } else {
    const r = vtype === 'bus' ? 0.52 : 0.46, floor = r * 1.15;
    const bodyH = h - floor;
    if (vtype === 'truck') {
      const cab = Math.min(2.2, len * 0.3);
      add(box(wid, bodyH * 0.72, cab), paint, 0, floor + bodyH * 0.36, len / 2 - cab / 2);   // cab
      add(box(wid * 0.92, bodyH * 0.3, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.55, len / 2 + 0.01);
      add(box(wid, bodyH, len - cab - 0.2), white, 0, floor + bodyH / 2, -cab / 2 - 0.1);   // the box
      add(box(wid + 0.02, 0.25, len - cab - 0.2), paint, 0, floor + bodyH * 0.25, -cab / 2 - 0.1);   // stripe
    } else {
      add(box(wid, bodyH, len), vtype === 'bus' ? paint : white, 0, floor + bodyH / 2, 0);
      if (vtype === 'bus') {
        add(box(wid * 0.9, bodyH * 0.45, 1.2), paint, 0, floor + bodyH * 0.22, len / 2 + 0.6);   // the hood
        for (const y of [floor + bodyH * 0.35, floor + bodyH * 0.18]) add(box(wid + 0.03, 0.08, len), trim, 0, y, 0);   // black rub rails
        windows(floor + bodyH * 0.68, bodyH * 0.32, -len / 2 + 0.6, len / 2 - 1.2, 8);
        add(box(wid * 0.86, bodyH * 0.34, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.7, len / 2 + 0.01);
      } else {   // RV: a stripe down each side, a few windows, a cab-over front, an air conditioner on top
        add(box(wid + 0.02, 0.3, len), trim, 0, floor + bodyH * 0.42, 0);
        add(box(wid + 0.02, 0.1, len), paint, 0, floor + bodyH * 0.55, 0);
        windows(floor + bodyH * 0.72, bodyH * 0.22, -len / 2 + 1.0, len / 2 - 2.2, 3);
        add(box(wid * 0.96, bodyH * 0.3, 1.2), white, 0, floor + bodyH * 0.82, len / 2 + 0.4);   // cab-over
        add(box(wid * 0.9, bodyH * 0.32, 0.05), RIDE_MAT.glass, 0, floor + bodyH * 0.48, len / 2 + 0.01);
        add(box(0.9, 0.3, 1.0), white, 0, h + 0.15, -len * 0.1);
      }
    }
    for (const s of [-1, 1]) for (const z of [len / 2 - 1.5, -len / 2 + 1.6]) wheel(s * (wid / 2 - 0.15), z, r);
    if (vtype !== 'truck') for (const s of [-1, 1]) add(box(0.1, 0.12, 0.3), RIDE_MAT.head, s * wid * 0.35, floor + 0.35, len / 2 + (vtype === 'bus' ? 1.21 : 0.01));
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.body = body;
  g.name = 'home-' + vtype; if (vtype === 'bus') useReal(g, 'bus', len);   // a real bus fits the box (the RV and box truck have no good match yet)
  return g;
}
