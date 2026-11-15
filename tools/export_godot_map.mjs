// Bakes the county for the Godot client from the same generator the server uses, so both agree on
// every hill, road and wall:
//   godot/map/heights.d16.gz ground height in 10 cm steps above -40 m, 16-bit LE, each row as
//                            differences from the point before (the first as value - 32768), gzipped
//   godot/map/colors.rgb.gz ground colour (real land cover), 8-bit RGB per sample, gzipped
//   godot/map/meta.json     sizes, plus every building, road, tree and rock as compact arrays
// Usage: node tools/export_godot_map.mjs [step metres, default 10]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { generateMap } from '../shared/world.js';
import { parseElevation, parseLandcover } from '../shared/terrain.js';
import { landColor } from '../client/mapview.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(ROOT, 'data', 'real');
const OUT = path.join(ROOT, 'godot', 'map');
const STEP = Number(process.argv[2] || 10);
const readJ = (n) => JSON.parse(fs.readFileSync(path.join(REAL, n), 'utf8'));
const structures = readJ('structures.json'), roads = readJ('roads.json'), infrastructure = readJ('infrastructure.json');
const elevation = parseElevation(zlib.gunzipSync(fs.readFileSync(path.join(REAL, 'elevation.bin.gz'))));
const landcover = parseLandcover(zlib.gunzipSync(fs.readFileSync(path.join(REAL, 'landcover.bin.gz'))));
const SEED = Number(process.env.SEED || 1337);
const map = generateMap(SEED, undefined, { structures: structures.rows, roads: roads.rows, elevation, landcover, infrastructure });
fs.mkdirSync(OUT, { recursive: true });

// Heights and colours on a grid covering the county.
const n = Math.round(map.size / STEP) + 1;
const hq = new Int32Array(n * n), hbuf = Buffer.alloc(n * n * 2);
const rgb = Buffer.alloc(n * n * 3);
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
  const x = -map.half + i * STEP, z = -map.half + j * STEP, k = j * n + i;
  const h = map.terrain.drawn(x, z);
  hq[k] = Math.max(0, Math.min(65535, Math.round((h + 40) * 10)));   // 10 cm steps
  const c = h < -0.3 ? (h < -6 ? [30, 72, 100] : [47, 107, 138]) : landColor(map.terrain, x, z, h);
  rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
}
// Each row stored as the difference from the point before it (small numbers that compress well).
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; hbuf.writeInt16LE(i ? hq[k] - hq[k - 1] : hq[k] - 32768, k * 2); }
fs.writeFileSync(path.join(OUT, 'heights.d16.gz'), zlib.gzipSync(hbuf, { level: 9 }));
fs.writeFileSync(path.join(OUT, 'colors.rgb.gz'), zlib.gzipSync(rgb, { level: 9 }));   // raw RGB, gzipped (a PNG would be imported as a texture)

// Solid things, compact: [minX, minZ, maxX, maxZ, y0, h, type] (+ [angle, cx, cz, hw, hd] when turned)
const r2 = (v) => Math.round(v * 100) / 100;
const TYPES = [];
const typeId = (t) => { let i = TYPES.indexOf(t); if (i < 0) { i = TYPES.length; TYPES.push(t); } return i; };
const boxes = [];
// Every fixed solid thing (buildings, walls, cars, towers...): the generator keeps them in map.boxes.
// Trees and rocks are made on demand per tile (millions across the county): left out here.
for (const b of map.boxes) {
  if (b.nature || b.type === 'border' || b.type === 'tree' || b.type === 'pine') continue;
  const e = [r2(b.minX), r2(b.minZ), r2(b.maxX), r2(b.maxZ), r2(b.y0 || 0), r2(b.h || 1), typeId(b.type || 'wall')];
  if (b.ang !== undefined) e.push(Math.round(b.ang * 1000) / 1000, r2(b.cx), r2(b.cz), r2(b.hw), r2(b.hd));   // turned: centre and half sizes
  boxes.push(e);
}
const roadSegs = map.roads.map((r) => [r2(r.x1), r2(r.z1), r2(r.x2), r2(r.z2), r2(r.width || 8), r.dirt ? 1 : r.hw ? 2 : 0]);
const meta = {
  seed: SEED, size: map.size, half: map.half, step: STEP, n, heightScale: 0.1, heightBase: -40,
  types: TYPES, boxes, roads: roadSegs,
  towns: map.towns.map((t) => ({ name: t.name, x: r2((t.rect.minX + t.rect.maxX) / 2), z: r2((t.rect.minZ + t.rect.maxZ) / 2) })),
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta));
fs.copyFileSync(path.join(ROOT, 'shared', 'data', 'arsenal.json'), path.join(OUT, 'arsenal.json'));   // weapon rates for the client
console.log(`grid ${n}x${n} @${STEP} m, ${boxes.length} boxes (${map.buildings.length} buildings), ${roadSegs.length} road segments`);

/** A minimal 8-bit RGB PNG encoder. */
function png(w, h, data) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; data.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = new Int32Array(256).map((_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
