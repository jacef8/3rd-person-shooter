#!/usr/bin/env node
// Downloads the real buildings and roads for the game map and writes them to data/real/.
// The server loads these files at start-up and every real structure becomes a map object.
//
//   node tools/import-real-data.mjs                 # full 30 x 30 km map
//   node tools/import-real-data.mjs --size 8000     # a smaller map (must match WORLD_SIZE)
//   node tools/import-real-data.mjs --skip-roads    # buildings only
//
// Needs network access to:
//   services2.arcgis.com   FEMA / ORNL "USA Structures" building footprints
//   overpass-api.de        OpenStreetMap roads (Overpass API)
//
// Data credits (shown in the README and the game's credits):
//   USA Structures, FEMA Response Geospatial Office / Oak Ridge National Laboratory (CC BY 4.0)
//   Road data (c) OpenStreetMap contributors (ODbL 1.0)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unproject, REAL_SIZE } from '../shared/geography.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const SIZE = Number(opt('size', REAL_SIZE));
const OUT = path.resolve(opt('out', path.join(ROOT, 'data', 'real')));
const STRUCTURES_URL = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query';
const OVERPASS_URL = opt('overpass', 'https://overpass-api.de/api/interpreter');

// Bounding box of the map in real lat/lon (+ a small margin).
const half = SIZE / 2 + 100;
const nw = unproject(-half, -half, SIZE), se = unproject(half, half, SIZE);
const bbox = { west: nw.lon, east: se.lon, north: nw.lat, south: se.lat };
console.log(`Map ${SIZE / 1000} km: lon ${bbox.west.toFixed(4)} .. ${bbox.east.toFixed(4)}, lat ${bbox.south.toFixed(4)} .. ${bbox.north.toFixed(4)}`);
fs.mkdirSync(OUT, { recursive: true });

async function getJson(url, init, tries = 4) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, init);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      if (k >= tries) throw e;
      console.warn(`  retry ${k} after error: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000 * k));
    }
  }
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;
const attr = (a, name) => { for (const k of Object.keys(a)) if (k.toLowerCase() === name) return a[k]; return undefined; };

/**
 * Footprint polygon -> centre and width/depth along the map axes. The game's collision uses
 * axis-aligned boxes, so a footprint is fitted with its minimum-area rectangle; one that's turned
 * well off the compass axes becomes a square of the same area.
 */
function fitFootprint(ring, lat0) {
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), mz = 110540;
  const pts = ring.map(([lon, lat]) => [lon * mx, -lat * mz]);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ex = pts[i + 1][0] - pts[i][0], ez = pts[i + 1][1] - pts[i][1], len = Math.hypot(ex, ez);
    if (len < 0.5) continue;
    const ux = ex / len, uz = ez / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of pts) { const a = x * ux + z * uz, b = -x * uz + z * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      best = { area, w: a1 - a0, d: b1 - b0, angle: Math.atan2(uz, ux), cx: ca * ux - cb * uz, cz: ca * uz + cb * ux };
    }
  }
  if (!best) return null;
  const lon = best.cx / mx, lat = -best.cz / mz;
  let deg = ((best.angle * 180) / Math.PI) % 90;
  if (deg < 0) deg += 90;
  if (deg < 20 || deg > 70) {
    const swap = deg > 45;   // the long side runs along Z
    return { lat, lon, w: swap ? best.d : best.w, d: swap ? best.w : best.d };
  }
  const side = Math.sqrt(best.area);
  return { lat, lon, w: side, d: side };
}

async function importStructures() {
  const rows = [];
  const PAGE = 2000;
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({
      where: '1=1',
      geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true', outSR: '4326', geometryPrecision: '7',
      resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'json',
    });
    const page = await getJson(`${STRUCTURES_URL}?${q}`);
    if (page.error) throw new Error(`ArcGIS: ${JSON.stringify(page.error)}`);
    for (const f of page.features || []) {
      const a = f.attributes || {};
      const ring = f.geometry?.rings?.[0];
      let fit = ring && ring.length > 3 ? fitFootprint(ring, ring[0][1]) : null;
      if (!fit) {
        const lat = attr(a, 'latitude'), lon = attr(a, 'longitude'), sq = attr(a, 'sqmeters');
        if (lat == null || lon == null) continue;
        const side = Math.sqrt(sq || 100);
        fit = { lat, lon, w: side, d: side };
      }
      const h = Number(attr(a, 'height')) || 0;
      rows.push([r6(fit.lat), r6(fit.lon), r1(fit.w), r1(fit.d), r1(h), attr(a, 'occ_cls') || attr(a, 'prim_occ') || '']);
    }
    console.log(`  structures: ${rows.length}`);
    if (!page.exceededTransferLimit && (page.features || []).length < PAGE) break;
  }
  // Stable order so every server and client build the same world.
  rows.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return {
    source: 'USA Structures (FEMA Response Geospatial Office / Oak Ridge National Laboratory)',
    license: 'CC BY 4.0', url: STRUCTURES_URL.replace(/\/query$/, ''), fetched: new Date().toISOString(),
    size: SIZE, bbox, fields: ['lat', 'lon', 'width_m', 'depth_m', 'height_m', 'occupancy'], rows,
  };
}

const SKIP_HIGHWAY = new Set(['footway', 'path', 'cycleway', 'steps', 'bridleway', 'pedestrian', 'corridor', 'proposed', 'construction', 'platform', 'elevator', 'raceway']);
async function importRoads() {
  const query = `[out:json][timeout:300];way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});out tags geom;`;
  const data = await getJson(OVERPASS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
  const rows = [];
  for (const el of data.elements || []) {
    const cls = el.tags?.highway;
    if (!cls || SKIP_HIGHWAY.has(cls) || !el.geometry || el.geometry.length < 2) continue;
    rows.push([el.tags.name || el.tags.ref || '', cls.replace(/_link$/, ''), el.geometry.map((g) => [r6(g.lat), r6(g.lon)])]);
  }
  rows.sort((a, b) => a[2][0][0] - b[2][0][0] || a[2][0][1] - b[2][0][1]);
  console.log(`  roads: ${rows.length}`);
  return { source: 'OpenStreetMap contributors', license: 'ODbL 1.0', url: OVERPASS_URL, fetched: new Date().toISOString(), size: SIZE, bbox, fields: ['name', 'class', 'points [lat, lon]'], rows };
}

const write = (name, obj) => { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj)); console.log(`Wrote ${path.join(OUT, name)} (${obj.rows.length} rows)`); };
if (!flag('skip-structures')) { console.log('Fetching building footprints (FEMA/ORNL USA Structures)…'); write('structures.json', await importStructures()); }
if (!flag('skip-roads')) { console.log('Fetching roads (OpenStreetMap Overpass)…'); write('roads.json', await importRoads()); }
console.log('Done. Restart the server; it picks up data/real/ automatically (set WORLD_SIZE to match --size).');
