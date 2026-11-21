// Real 3D trees, built in code: a tapered, bending trunk with bark, branches growing off it, and
// clumps of leaves (or pine needles) at the ends of the branches, all fixed in the world. Walk round one
// and you see it from every side, with light through the gaps; nothing turns to face you.
//
// Four kinds from the North Florida woods, each built a few ways (`VARIANTS` per kind):
//   longleaf pine: a tall bare trunk with a small, open crown of long-needled tufts at the very top
//   slash pine:    a fuller, rounder crown starting about half-way up
//   live oak:      a short, thick trunk that splits into long limbs spreading out wide and low, hung with
//                  Spanish moss
//   oak / gum:     a straight trunk to a round, leafy crown
// Each tree is unit height (base at 0, top at 1) and scaled per instance. Each comes in a full build for
// close by and a light one (fewer branches and bigger clumps) for further off.
import * as THREE from 'three';

// ---------------------------------------------------------------- textures, drawn once
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; }; }

/**
 * Foliage, three cells side by side: broad leaves (left), pine needle tufts (middle), Spanish moss
 * (right). Each is a clump with ragged gaps, so the sky shows through.
 */
function foliageTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = S * 3; c.height = S;
  const x = c.getContext('2d'), r = rng(11);
  // Broad leaves: hundreds of small leaves, thicker in the middle of the clump.
  for (let i = 0; i < 1300; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * S * 0.46, px = S / 2 + Math.cos(a) * d, py = S / 2 + Math.sin(a) * d * 0.9;
    const g = 120 + r() * 80 | 0, sh = 1 - d / (S * 1.1);
    x.fillStyle = `rgb(${(g * 0.6 * sh + 15) | 0},${(g * sh + 25) | 0},${(g * 0.38 * sh + 10) | 0})`;
    x.save(); x.translate(px, py); x.rotate(r() * Math.PI); x.beginPath(); x.ellipse(0, 0, 4 + r() * 4, 2 + r() * 2.2, 0, 0, Math.PI * 2); x.fill(); x.restore();
  }
  // Pine needles: bursts of long thin needles out from a few points.
  x.lineCap = 'round';
  for (let b = 0; b < 12; b++) {
    const cx = S + S * (0.25 + r() * 0.5), cy = S * (0.25 + r() * 0.5);
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2, l = S * (0.12 + r() * 0.2), g = 115 + r() * 75 | 0;
      x.strokeStyle = `rgb(${(g * 0.62) | 0},${(g + 15) | 0},${(g * 0.4) | 0})`; x.lineWidth = 1.2 + r() * 1.4;
      x.beginPath(); x.moveTo(cx, cy); x.quadraticCurveTo(cx + Math.cos(a) * l * 0.5, cy + Math.sin(a) * l * 0.5 + l * 0.08, cx + Math.cos(a) * l, cy + Math.sin(a) * l + l * 0.15); x.stroke();
    }
  }
  // Spanish moss: grey-green strands hanging down.
  for (let i = 0; i < 160; i++) {
    let px = S * 2 + S * (0.15 + r() * 0.7), py = r() * S * 0.15; const l = S * (0.3 + r() * 0.6), v = 120 + r() * 50 | 0;
    x.strokeStyle = `rgb(${v - 10},${v + 5},${v - 20})`; x.lineWidth = 1 + r() * 1.5;
    x.beginPath(); x.moveTo(px, py);
    for (let y = 0; y < l; y += 8) { px += (r() - 0.5) * 4; x.lineTo(px, py + y); }
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const CELL = { leaf: 0, needle: 1, moss: 2 };

// ---------------------------------------------------------------- geometry builders
/** Collects triangles: positions, normals, uvs, colours. */
function buf() { return { p: [], n: [], u: [], c: [], i: [] }; }
function toGeo(b) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
  g.setIndex(b.i);
  g.computeBoundingSphere();
  g.userData.shared = true;   // used by every chunk: never disposed with one
  return g;
}

/** A tapered tube along `pts` ([x, y, z, radius]...), `sides` round, bark-coloured `col`. */
function tube(b, pts, sides, col) {
  const V = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const o = b.p.length / 3;
  let along = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x, y, z, r] = pts[k];
    const a = pts[Math.max(0, k - 1)], c = pts[Math.min(pts.length - 1, k + 1)];
    T.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize();
    N.crossVectors(Math.abs(T.y) > 0.95 ? V.set(1, 0, 0) : up, T).normalize();
    B.crossVectors(T, N);
    if (k) along += Math.hypot(x - pts[k - 1][0], y - pts[k - 1][1], z - pts[k - 1][2]);
    const dark = 0.75 + 0.25 * Math.min(1, y * 3);   // darker at the foot
    for (let s = 0; s <= sides; s++) {
      const ang = s / sides * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      const nx = N.x * cs + B.x * sn, ny = N.y * cs + B.y * sn, nz = N.z * cs + B.z * sn;
      b.p.push(x + nx * r, y + ny * r, z + nz * r); b.n.push(nx, ny, nz);
      b.u.push(s / sides * Math.max(1, Math.round(r * 160)), along * 18); b.c.push(col[0] * dark, col[1] * dark, col[2] * dark);
    }
  }
  for (let k = 0; k < pts.length - 1; k++) for (let s = 0; s < sides; s++) {
    const a = o + k * (sides + 1) + s, c = a + sides + 1;
    b.i.push(a, c, a + 1, a + 1, c, c + 1);
  }
}

/**
 * A clump of foliage at `at`: `planes` cards `size` across through the point, turned every which way,
 * lit as if part of a rounded crown (normals out from `centre`, leaning up). `cell` picks the texture.
 */
function clump(b, r, at, size, cell, centre, tint, planes = 3, hang = false) {
  const Q = new THREE.Quaternion(), E = new THREE.Euler(), A = new THREE.Vector3(), Bv = new THREE.Vector3(), Nrm = new THREE.Vector3();
  Nrm.set(at[0] - centre[0], (at[1] - centre[1]) * 1.4 + 0.7, at[2] - centre[2]).normalize();   // out from the crown, leaning up to catch the sky
  const shade = 0.82 + 0.18 * Math.max(0, Math.min(1, (at[1] - centre[1]) / 0.25 + 0.6));   // the underside of the crown is darker
  for (let q = 0; q < planes; q++) {
    if (hang) E.set(0, r() * Math.PI, 0); else E.set((r() - 0.5) * 1.6, q * Math.PI / planes + r() * 0.6, (r() - 0.5) * 1.6);
    Q.setFromEuler(E);
    A.set(size / 2, 0, 0).applyQuaternion(Q); Bv.set(0, hang ? size : size / 2, 0).applyQuaternion(Q);
    const o = b.p.length / 3, u0 = cell / 3, u1 = (cell + 1) / 3;
    const cy = hang ? at[1] - size / 2 : at[1];
    const corners = [[-1, -1, u0, 0], [1, -1, u1, 0], [1, 1, u1, 1], [-1, 1, u0, 1]];
    for (const [sx, sy, uu, vv] of corners) {
      const by = hang ? (sy + 1) / 2 - 0.5 : sy;
      b.p.push(at[0] + A.x * sx + Bv.x * by, cy + A.y * sx + Bv.y * by, at[2] + A.z * sx + Bv.z * by);
      b.n.push(Nrm.x, Nrm.y, Nrm.z);
      b.u.push(uu, vv);
      b.c.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
    }
    b.i.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
}

// Bark colour comes from the photos now (pine bark, oak bark): this only shades each kind a little.
const BARK = { pine: [1, 0.97, 0.94], oak: [0.95, 0.95, 0.95], gum: [0.85, 0.87, 0.9] };
// The photo leaves and needles carry their own colour now: this only shifts each kind a little.
const GREEN = { pine: [0.88, 1.08, 0.78], oak: [1, 1.02, 0.95], live: [0.9, 0.98, 0.84] };

/** A point partway up a polyline of [x, y, z, r]. */
function along(pts, t) {
  const f = t * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(f)), u = f - k, a = pts[k], c = pts[k + 1];
  return [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, a[2] + (c[2] - a[2]) * u, a[3] + (c[3] - a[3]) * u];
}
/** A trunk from the ground to `top`, leaning a little, flared at the foot. */
function trunkPts(r, top, base, tipR, steps, wob) {
  const out = [];
  let x = 0, z = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (k) { x += (r() - 0.5) * wob; z += (r() - 0.5) * wob; }
    out.push([x, t * top, z, base * (1 - t) + tipR * t + (k === 0 ? base * 0.35 : 0)]);
  }
  return out;
}
/** A branch from `from` heading `dir` (roughly), `len` long, bending `bend` (up +, down -). */
function branchPts(r, from, dir, len, r0, bend, steps = 3) {
  const out = [[from[0], from[1], from[2], r0]];
  let [x, y, z] = from;
  const d = new THREE.Vector3(...dir).normalize();
  for (let k = 1; k <= steps; k++) {
    d.y += bend / steps; d.x += (r() - 0.5) * 0.25; d.z += (r() - 0.5) * 0.25; d.normalize();
    x += d.x * len / steps; y += d.y * len / steps; z += d.z * len / steps;
    out.push([x, y, z, r0 * (1 - k / steps * 0.8)]);
  }
  return out;
}

// ---------------------------------------------------------------- the four kinds
function longleaf(seed, lite) {
  const r = rng(seed), wood = buf(), leaves = buf();
  const trunk = trunkPts(r, 1, 0.016, 0.004, lite ? 4 : 8, 0.012);
  tube(wood, trunk, lite ? 5 : 8, BARK.pine);
  const crown0 = 0.66 + r() * 0.08, centre = [trunk[trunk.length - 1][0], 0.85, trunk[trunk.length - 1][2]];
  const n = lite ? 6 : 11 + (r() * 4 | 0);
  for (let k = 0; k < n; k++) {
    const t = crown0 + (k / n) * (0.97 - crown0), at = along(trunk, t), a = k * 2.4 + r() * 0.5;
    const len = 0.05 + 0.09 * Math.sin(Math.PI * (k + 1) / (n + 1)) + r() * 0.03;
    const pts = branchPts(r, at, [Math.cos(a), 0.15 + r() * 0.3, Math.sin(a)], len, 0.0035, 0.25, 2);
    if (!lite) tube(wood, pts, 4, BARK.pine);
    const tip = pts[pts.length - 1];
    clump(leaves, r, tip, lite ? 0.15 : 0.11, CELL.needle, centre, GREEN.pine, lite ? 2 : 3);
    if (!lite) { clump(leaves, r, along(pts, 0.5), 0.085, CELL.needle, centre, GREEN.pine, 2); clump(leaves, r, along(pts, 0.25), 0.07, CELL.needle, centre, GREEN.pine, 2); }
  }
  clump(leaves, r, trunk[trunk.length - 1], lite ? 0.1 : 0.07, CELL.needle, centre, GREEN.pine, 3);
  return { wood: toGeo(wood), leaves: toGeo(leaves) };
}
function slash(seed, lite) {
  const r = rng(seed), wood = buf(), leaves = buf();
  const trunk = trunkPts(r, 1, 0.017, 0.004, lite ? 4 : 8, 0.016);
  tube(wood, trunk, lite ? 5 : 8, BARK.pine);
  const crown0 = 0.45 + r() * 0.1, centre = [trunk[trunk.length - 1][0], 0.74, trunk[trunk.length - 1][2]];
  const n = lite ? 8 : 16 + (r() * 5 | 0);
  for (let k = 0; k < n; k++) {
    const t = crown0 + (k / n) * (0.98 - crown0), at = along(trunk, t), a = k * 2.4 + r() * 0.6;
    const len = (0.1 + 0.13 * Math.sin(Math.PI * Math.min(1, (k + 2) / (n + 1)))) * (1.05 - (t - crown0)) + r() * 0.03;
    const pts = branchPts(r, at, [Math.cos(a), -0.05 + r() * 0.35, Math.sin(a)], len, 0.004, 0.2, 2);
    if (!lite) tube(wood, pts, 4, BARK.pine);
    clump(leaves, r, pts[pts.length - 1], lite ? 0.18 : 0.13, CELL.needle, centre, GREEN.pine, lite ? 2 : 3);
    if (!lite) clump(leaves, r, along(pts, 0.55), 0.1, CELL.needle, centre, GREEN.pine, 2);
  }
  clump(leaves, r, trunk[trunk.length - 1], 0.09, CELL.needle, centre, GREEN.pine, 3);
  return { wood: toGeo(wood), leaves: toGeo(leaves) };
}
function liveOak(seed, lite) {
  const r = rng(seed), wood = buf(), leaves = buf();
  const split = 0.22 + r() * 0.08;
  const trunk = trunkPts(r, split, 0.04, 0.028, 3, 0.01);
  tube(wood, trunk, lite ? 6 : 9, BARK.oak);
  const top = trunk[trunk.length - 1], centre = [0, 0.62, 0];
  const limbs = lite ? 4 : 5 + (r() * 2 | 0);
  for (let k = 0; k < limbs; k++) {
    const a = k / limbs * Math.PI * 2 + r() * 0.6, rise = 0.35 + r() * 0.5;
    const limb = branchPts(r, [top[0], top[1] - 0.02, top[2]], [Math.cos(a), rise, Math.sin(a)], 0.5 + r() * 0.2, 0.024, -0.25, lite ? 3 : 5);
    tube(wood, limb, lite ? 5 : 7, BARK.oak);
    const subs = lite ? 1 : 3;
    for (let s = 0; s < subs; s++) {
      const at = along(limb, 0.4 + s * 0.2), b2 = a + (r() - 0.5) * 1.6;
      const sub = branchPts(r, at, [Math.cos(b2), 0.5 + r() * 0.5, Math.sin(b2)], 0.18 + r() * 0.12, 0.01, 0.1, 2);
      if (!lite) tube(wood, sub, 4, BARK.oak);
      clump(leaves, r, sub[sub.length - 1], 0.2, CELL.leaf, centre, GREEN.live, 3);
      clump(leaves, r, along(sub, 0.5), 0.16, CELL.leaf, centre, GREEN.live, 2);
    }
    for (const t of lite ? [0.7, 1] : [0.45, 0.65, 0.85, 1]) {
      const at = along(limb, t);
      clump(leaves, r, [at[0], at[1] + 0.05, at[2]], lite ? 0.3 : 0.22, CELL.leaf, centre, GREEN.live, lite ? 2 : 3);
    }
    // Spanish moss hanging off the limb.
    if (!lite) for (let m = 0; m < 2; m++) { const at = along(limb, 0.35 + r() * 0.5); clump(leaves, r, [at[0], at[1] - 0.01, at[2]], 0.12 + r() * 0.08, CELL.moss, centre, [1, 1, 1], 2, true); }
  }
  return { wood: toGeo(wood), leaves: toGeo(leaves) };
}
function roundOak(seed, lite) {
  const r = rng(seed), wood = buf(), leaves = buf();
  const trunk = trunkPts(r, 0.62, 0.03, 0.012, lite ? 3 : 6, 0.012);
  tube(wood, trunk, lite ? 5 : 8, BARK.gum);
  const centre = [0, 0.66, 0];
  const n = lite ? 4 : 7;
  for (let k = 0; k < n; k++) {
    const at = along(trunk, 0.5 + k / n * 0.45), a = k * 2.4 + r() * 0.5;
    const pts = branchPts(r, at, [Math.cos(a), 0.9 + r() * 0.5, Math.sin(a)], 0.22 + r() * 0.1, 0.012, 0, 3);
    if (!lite) tube(wood, pts, 5, BARK.gum);
  }
  // The crown: clumps through a rounded volume, more of them near its outside.
  const clumps = lite ? 14 : 34;
  for (let k = 0; k < clumps; k++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), d = 0.55 + 0.45 * Math.cbrt(r());
    const at = [Math.cos(a) * s * 0.3 * d, 0.68 + u * 0.27 * d, Math.sin(a) * s * 0.3 * d];
    clump(leaves, r, at, lite ? 0.24 : 0.17, CELL.leaf, centre, GREEN.oak, lite ? 2 : 3);
  }
  return { wood: toGeo(wood), leaves: toGeo(leaves) };
}

/** How wide each kind's crown is, for its height (so very tall trees aren't drawn enormous). */
const WIDE = { longleaf: 0.32, slash: 0.45, liveOak: 1.3, roundOak: 0.62 };
export const KINDS = { pine: ['longleaf', 'slash'], tree: ['liveOak', 'roundOak'] };
const BUILD = { longleaf, slash, liveOak, roundOak };
const VARIANTS = { longleaf: 2, slash: 2, liveOak: 1, roundOak: 1 };   // pines fill the woods: more of them

/**
 * Everything to draw the trees: for each kind and variant, the full and light geometry for wood and
 * leaves, and the two materials (bark, and alpha-cut foliage) with their shadow-casting versions.
 */
export function makeTreeKit() {
  // Leaves, needles and Spanish moss: photo scans (Poly Haven, CC0) built into one sheet by
  // tools/build_foliage.py. The drawn sheet (foliageTexture) shows until it has loaded.
  const fol = foliageTexture();
  new THREE.TextureLoader().load('/textures/foliage.png', (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    for (const m of [leafMat, leafDepth]) { m.map = t; m.needsUpdate = true; }
  });
  // Bark: photo scans (Poly Haven, CC0): plated red-brown pine bark, furrowed grey-brown oak bark.
  const barkPhoto = (name) => {
    const ld = new THREE.TextureLoader();
    const t = ld.load(`/textures/pbr/${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const n = ld.load(`/textures/pbr/${name}_n.jpg`); n.wrapS = n.wrapT = THREE.RepeatWrapping;
    return new THREE.MeshStandardMaterial({ map: t, normalMap: n, vertexColors: true, roughness: 0.95, metalness: 0 });
  };
  const pineBarkMat = barkPhoto('pinebark'), oakBarkMat = barkPhoto('oakbark');
  const woodMat = pineBarkMat;
  const leafMat = new THREE.MeshStandardMaterial({ map: fol, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, alphaToCoverage: true });
  // A breath of wind in the leaves: the outer ends of the crown move a little.
  const windT = { value: 0 };
  leafMat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = windT;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float k = position.y * position.y * 0.012;
  transformed.x += sin(uWind * 1.3 + wp.x * 0.13 + position.y * 3.0) * k;
  transformed.z += sin(uWind * 1.1 + wp.z * 0.17 + position.x * 5.0) * k; }`);
  };
  const leafDepth = new THREE.MeshDepthMaterial({ map: fol, alphaTest: 0.45, depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const kinds = {};
  for (const [kind, names] of Object.entries(KINDS)) {
    kinds[kind] = [];
    names.forEach((name, ni) => {
      for (let v = 0; v < VARIANTS[name]; v++) {
        const seed = 1000 + ni * 97 + v * 31 + (kind === 'pine' ? 0 : 500);
        kinds[kind].push({ name, wide: WIDE[name], full: BUILD[name](seed, false), lite: BUILD[name](seed, true) });
      }
    });
  }
  return {
    kinds, woodMat, leafMat, leafDepth,
    /** The bark for a build: pine bark on the pines, oak bark on the broadleaves. */
    barkFor: (v) => (v.name === 'longleaf' || v.name === 'slash' ? pineBarkMat : oakBarkMat),
    tick(t) { windT.value = t; },
    /** Triangles in each build, for a check. */
    tris() { const o = {}; for (const [k, list] of Object.entries(kinds)) o[k] = list.map((v) => ({ name: v.name, full: (v.full.wood.index.count + v.full.leaves.index.count) / 3, lite: (v.lite.wood.index.count + v.lite.leaves.index.count) / 3 })); return o; },
  };
}

/**
 * Which build a tree uses (always the same for the same tree) and its size: [variant, widthScale].
 * `h` is the tree's height in metres.
 */
export function treePick(kit, kind, id, h, one = false) {
  // (`one`: phones and TV boxes use a single build per kind, so a patch of woods is two draws a kind.)
  const list = kit.kinds[kind], v = list[one ? 0 : (id * 7 + 3) % list.length];
  // Crowns widen with height more slowly than they grow taller, and never past ~22 m across.
  const w = Math.min(h, 12 * (h / 12) ** 0.72);
  const sx = Math.min(w, 22 / v.wide) * (0.9 + ((id * 13) % 7) * 0.035);
  return [v, sx];
}
