// The county packed for the Godot client, from the very map this world runs on (map editor fixes and
// all), so the two always agree on every hill, road, wall and tree. The hub serves it at /gmap/:
//   meta.json        sizes, every fixed solid thing (buildings, walls, towers, ladders...), roads, towns
//   heights.d16.gz   ground height in 10 cm steps above -40 m, 16-bit LE, each row as differences
//                    from the point before (the first as value - 32768), gzipped
//   colors.rgb.gz    ground colour (real land cover), 8-bit RGB per sample, gzipped
//   nature?t=tx,tz;… trees in those 128 m tiles (made on demand: there are millions)
import zlib from 'node:zlib';
import { landColor } from '../client/mapview.js';

const r2 = (v) => Math.round(v * 100) / 100;

/** The whole bundle: { meta, heights, colors } (the last two gzipped Buffers). */
export function packMap(map, { step = 10, seed = 0, sum = '' } = {}) {
  const n = Math.round(map.size / step) + 1;
  const hq = new Int32Array(n * n), hbuf = Buffer.alloc(n * n * 2), rgb = Buffer.alloc(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -map.half + i * step, z = -map.half + j * step, k = j * n + i;
    const h = map.terrain.drawn(x, z);
    hq[k] = Math.max(0, Math.min(65535, Math.round((h + 40) * 10)));
    const c = h < -0.3 ? (h < -6 ? [30, 72, 100] : [47, 107, 138]) : landColor(map.terrain, x, z, h);
    rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; hbuf.writeInt16LE(i ? hq[k] - hq[k - 1] : hq[k] - 32768, k * 2); }
  // Solid things, compact: [minX, minZ, maxX, maxZ, y0, h, type] (+ [angle, cx, cz, hw, hd] when turned).
  // Ladders also carry [ladderTop, inX, inZ] at the end (after the turned fields, or zeros).
  const types = [], typeId = (t) => { let i = types.indexOf(t); if (i < 0) { i = types.length; types.push(t); } return i; };
  const boxes = [];
  for (const b of map.boxes) {
    if (b.nature || b.type === 'border' || b.type === 'tree' || b.type === 'pine') continue;
    const e = [r2(b.minX), r2(b.minZ), r2(b.maxX), r2(b.maxZ), r2(b.y0 || 0), r2(b.h || 1), typeId(b.type || 'wall')];
    if (b.ang !== undefined) e.push(Math.round(b.ang * 1000) / 1000, r2(b.cx), r2(b.cz), r2(b.hw), r2(b.hd));
    if (b.type === 'ladder') { if (b.ang === undefined) e.push(0, 0, 0, 0, 0); e.push(r2(b.ladderTop), r2(b.ladderIn?.[0] || 0), r2(b.ladderIn?.[1] || 0)); }
    boxes.push(e);
  }
  // Buildings as a whole: footprint pieces (turned), roof shape and height, for roofs and walls drawn properly.
  const buildings = map.buildings.map((b) => ({
    type: b.type, top: r2(b.top ?? 0), y0: r2(b.floor ?? b.y0 ?? 0), roof: b.roof || null, name: b.name || undefined,
    ...(b.rects ? { cx: r2(b.cx), cz: r2(b.cz), ang: Math.round((b.ang || 0) * 1000) / 1000, rects: b.rects.map((q) => q.map(r2)) } : { rect: [r2(b.minX), r2(b.minZ), r2(b.maxX), r2(b.maxZ)] }),
  }));
  const roads = map.roads.map((r) => [r2(r.x1), r2(r.z1), r2(r.x2), r2(r.z2), r2(r.width || 8), r.dirt ? 1 : r.hw ? 2 : 0]);
  const meta = {
    v: 2, sum, seed, size: map.size, half: map.half, step, n, heightScale: 0.1, heightBase: -40,
    natureTile: map.natureTileSize, types, boxes, buildings, roads,
    towns: map.towns.map((t) => ({ name: t.name, x: r2((t.rect.minX + t.rect.maxX) / 2), z: r2((t.rect.minZ + t.rect.maxZ) / 2) })),
    labels: (map.labels || []).map((l) => ({ text: l.text, x: r2(l.x), z: r2(l.z), kind: l.kind })),
  };
  return { meta, heights: zlib.gzipSync(hbuf, { level: 9 }), colors: zlib.gzipSync(rgb, { level: 9 }) };
}

/** Trees in the given 128 m tiles: { "tx,tz": [[x, z, y0, h, kind (0 broadleaf, 1 pine), id, cut], ...] }. */
export function natureTiles(map, list, felled = new Set()) {
  const out = {};
  for (const [tx, tz] of list.slice(0, 64)) {
    out[`${tx},${tz}`] = map.natureTile(tx, tz).map((b) => [r2((b.minX + b.maxX) / 2), r2((b.minZ + b.maxZ) / 2), r2(b.y0 || 0), r2(b.h), b.type === 'pine' ? 1 : 0, b.id, felled.has(b.id) || b.gone ? 1 : 0]);
  }
  return out;
}
