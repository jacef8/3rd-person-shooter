// Full-map rendering for the map screen (M), the deploy/redeploy screen and fast travel.
const COL = { grass: '#3f4d31', town: '#4b4f55', building: '#7b7f86', road: '#2c2f33', dirt: '#77694a', tree: '#24391f', house: '#a8774c', farm: '#8a6d4c', home: '#9a9186', civic: '#a65f4b' };
const HIDDEN = new Set(['border', 'cover', 'rock', 'car', 'terminal', 'boulder', 'cactus', 'canopy', 'caveroof', 'jetty', 'scrub', 'tree', 'pine', 'rail']);
const boxColor = (b) => (b.type === 'housewall' || b.type === 'crate' ? COL.house : b.type === 'farmhouse' || b.type === 'barn' ? COL.farm : b.type === 'home' ? COL.home : b.type === 'civic' ? COL.civic : COL.building);
// Label chips: solid panels with sharp text (no outlines or glows).
const CHIP = { bg: '#171a21', line: '#2a2f3a', ink: '#ffffff', road: '#ffd27a', place: '#9fe39f' };

const GC = { plains: [104, 124, 68], forest: [58, 86, 44], desert: [214, 206, 170], mountain: [128, 104, 66], swamp: [52, 68, 40], sand: [204, 189, 140], water: [47, 107, 138], deep: [30, 72, 100] };
/** Ground colour (0-255 RGB) of dry land at a point: the biome blend, with sand along the water's edge. */
export function landColor(terrain, x, z, h) {
  const b = terrain.biome(x, z);
  if (h < 0.7 && b.sea < 0.5) return GC.sand;
  const c = [0, 0, 0];
  for (const k of ['plains', 'forest', 'desert', 'mountain']) for (let i = 0; i < 3; i++) c[i] += GC[k][i] * b[k];
  for (let i = 0; i < 3; i++) c[i] += GC.swamp[i] * b.sea;
  return c;
}
/** Map colour (0-255 RGB) for a point: land colour, water, shaded by slope. */
export function mapGroundColor(map, x, z, H = map.terrain.height) {
  const h = H(x, z);
  if (h < -6) return GC.deep;
  if (h < 0) return GC.water;
  // Hill shading from the slope toward the light (north-west).
  const shade = Math.max(0.6, Math.min(1.35, 1 + (h - H(x - 12, z - 12)) * 0.04));
  return landColor(map.terrain, x, z, h).map((v) => Math.min(255, v * shade));
}
/**
 * One coarse sampling of the whole map: height and land colour every `step` metres. Shared by the
 * map screen and the far landscape, so the county is only walked over once at load.
 */
export function sampleLand(map, step) {
  const n = Math.round(map.size / step) + 1, t = map.terrain;
  const h = new Float32Array(n * n), rgb = new Uint8Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -map.half + i * step, z = -map.half + j * step, k = j * n + i;
    const y = h[k] = t.exact(x, z);
    const c = landColor(t, x, z, y);
    rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
  }
  return { n, step, h, rgb };
}

/** Draw the static world once into an offscreen canvas. */
export function buildMapBase(map, px = 1400, land = sampleLand(map, map.size / Math.round(px / 6))) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const k = px / map.size;
  const X = (x) => (x + map.half) * k, Z = (z) => (z + map.half) * k;
  // Terrain: the coarse land samples, coloured for the map (water, hill shading) and scaled up smoothly.
  const res = land.n;
  const tc = Object.assign(document.createElement('canvas'), { width: res, height: res });
  const tg = tc.getContext('2d');
  const img = tg.createImageData(res, res);
  const relief = 0.04 * 17 / (land.step * Math.SQRT2);   // the same slope shading as the close-up map
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const k = j * res + i, h = land.h[k], o = k * 4;
    let col;
    if (h < -6) col = GC.deep;
    else if (h < 0) col = GC.water;
    else {
      const shade = Math.max(0.6, Math.min(1.35, 1 + (h - land.h[Math.max(0, j - 1) * res + Math.max(0, i - 1)]) * relief));
      col = [land.rgb[k * 3] * shade, land.rgb[k * 3 + 1] * shade, land.rgb[k * 3 + 2] * shade];
    }
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  // Samples sit on the grid's corners, so the image overhangs the map by half a cell each side.
  const cell = px / (res - 1);
  g.drawImage(tc, -cell / 2, -cell / 2, px + cell, px + cell);
  g.strokeStyle = COL.road; g.lineCap = 'round';
  // Minor roads first, highways on top.
  for (const r of [...map.roads].sort((a, b) => (a.width || 12) - (b.width || 12))) { g.strokeStyle = r.dirt ? COL.dirt : COL.road; g.lineWidth = Math.max((r.width || 12) >= 10 ? 2 : r.dirt ? 0.5 : 0.8, (r.width || 12) * k); g.beginPath(); g.moveTo(X(r.x1), Z(r.z1)); g.lineTo(X(r.x2), Z(r.z2)); g.stroke(); }
  for (const t of map.towns) { g.fillStyle = COL.town; g.fillRect(X(t.rect.minX), Z(t.rect.minZ), (t.rect.maxX - t.rect.minX) * k, (t.rect.maxZ - t.rect.minZ) * k); }
  for (const b of map.boxes) {
    if (b.type === 'tree' || b.type === 'pine') { g.fillStyle = COL.tree; g.fillRect(X(b.minX) - 1, Z(b.minZ) - 1, 2.2, 2.2); continue; }
    if (HIDDEN.has(b.type)) continue;
    g.fillStyle = boxColor(b);
    g.fillRect(X(b.minX), Z(b.minZ), Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
  }
  g.textAlign = 'center';
  // Labels: towns, rivers and lakes, parks and landmarks.
  for (const l of map.labels || map.towns.map((t) => ({ text: t.name, x: t.x, z: t.rect.minZ, kind: 'town' }))) {
    const water = l.kind === 'water', lm = l.kind === 'landmark';
    g.font = `${water ? 'italic ' : 'bold '}${Math.round(px / (water ? 105 : lm ? 115 : 85))}px Segoe UI, sans-serif`;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(l.text, X(l.x), Z(l.z) - 4);
    g.fillStyle = water ? '#a9d7f2' : lm ? '#bfe6a8' : '#f0f0f0';
    g.fillText(l.text, X(l.x), Z(l.z) - 4);
  }
  return c;
}

/** Road names and landmark buildings, as solid chips, once the map is zoomed in enough to read them. */
function drawNames(g, map, roads, v) {
  const taken = [];
  const chip = (text, x, y, color) => {
    g.font = '700 12px Segoe UI, system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 12, h = 20, x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
    if (x0 < 4 || y0 < 4 || x0 + w > v.W - 4 || y0 + h > v.H - 4) return false;
    if (taken.some((t) => x0 < t[0] + t[2] + 6 && x0 + w + 6 > t[0] && y0 < t[1] + t[3] + 4 && y0 + h + 4 > t[1])) return false;
    taken.push([x0, y0, w, h]);
    g.fillStyle = CHIP.bg; g.strokeStyle = CHIP.line; g.lineWidth = 1;
    g.beginPath(); g.roundRect(x0 + 0.5, y0 + 0.5, w, h, 6); g.fill(); g.stroke();
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x0 + w / 2, y0 + h / 2 + 1);
    g.textBaseline = 'alphabetic';
    return true;
  };
  // Landmarks first (there are few), then roads: highways before side streets, longest stretch in view first.
  if (v.k > 0.12) for (const b of map.buildings) if (b.name && b.maxX > v.minX && b.minX < v.maxX && b.maxZ > v.minZ && b.minZ < v.maxZ) chip(b.name, v.sx((b.minX + b.maxX) / 2), v.sz(b.minZ) - 12, CHIP.place);
  const byName = new Map();
  for (const r of roads) {
    if (!r.name || r.hw) continue;
    const major = (r.width || 0) >= 8;
    if (!major && v.k < 0.35) continue;   // side streets only when you're in close
    const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
    const e = byName.get(r.name) || { len: 0, best: 0, major };
    e.len += len;
    if (len > e.best) { e.best = len; e.x = (r.x1 + r.x2) / 2; e.z = (r.z1 + r.z2) / 2; }
    byName.set(r.name, e);
  }
  const list = [...byName.entries()].sort((a, b) => (b[1].major - a[1].major) || b[1].len - a[1].len).slice(0, 60);
  let n = 0;
  for (const [name, e] of list) { if (n >= 22) break; if (chip(name, v.sx(e.x), v.sz(e.z), e.major ? CHIP.road : CHIP.ink)) n++; }
}

/**
 * Draw the map with live markers. `view` = { cx, cz, zoom } (zoom 1 = whole map).
 * markers: [{ x, z, kind, label, color, size, highlight }]
 */
const detail = { key: null, canvas: null };
export function drawMap(canvas, map, base, view, markers) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const span = map.size / view.zoom;               // metres across the shorter side
  const k = Math.min(W, H) / span;
  // Keep the view inside the world (no black margins at the map edge).
  const hx = W / 2 / k, hz = H / 2 / k;
  view.cx = hx >= map.half ? 0 : Math.max(-map.half + hx, Math.min(map.half - hx, view.cx));
  view.cz = hz >= map.half ? 0 : Math.max(-map.half + hz, Math.min(map.half - hz, view.cz));
  const sx = (x) => W / 2 + (x - view.cx) * k, sz = (z) => H / 2 + (z - view.cz) * k;
  g.fillStyle = '#0d1014'; g.fillRect(0, 0, W, H);
  const bk = base.width / map.size;
  const srcX = (view.cx - W / 2 / k + map.half) * bk, srcZ = (view.cz - H / 2 / k + map.half) * bk;
  g.drawImage(base, srcX, srcZ, W / k * bk, H / k * bk, 0, 0, W, H);
  // Zoomed in past the base image's detail (the map is 30 km across): draw roads and buildings live.
  if (k > base.width / map.size * 1.5) {
    const minX = view.cx - W / 2 / k, maxX = view.cx + W / 2 / k, minZ = view.cz - H / 2 / k, maxZ = view.cz + H / 2 / k;
    // Sharper terrain for just the area on screen (cached until the view changes).
    const key = `${Math.round(view.cx)},${Math.round(view.cz)},${k.toFixed(4)},${W},${H}`;
    if (detail.key !== key) {
      const cw = Math.ceil(W / 5), ch = Math.ceil(H / 5);
      const c = detail.canvas || (detail.canvas = document.createElement('canvas'));
      c.width = cw; c.height = ch;
      const dg = c.getContext('2d'), img = dg.createImageData(cw, ch);
      for (let i = 0; i < cw; i++) for (let j = 0; j < ch; j++) {
        const col = mapGroundColor(map, minX + ((i + 0.5) / cw) * (maxX - minX), minZ + ((j + 0.5) / ch) * (maxZ - minZ), map.terrain.exact);
        const o = (j * cw + i) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
      dg.putImageData(img, 0, 0);
      detail.key = key;
    }
    g.imageSmoothingEnabled = true;
    g.drawImage(detail.canvas, 0, 0, W, H);
    g.strokeStyle = COL.road; g.lineCap = 'round';
    const inView = map.roadGrid ? map.roadGrid.rect(minX, minZ, maxX, maxZ) : [];
    for (const r of inView) { g.strokeStyle = r.dirt ? COL.dirt : COL.road; g.lineWidth = Math.max(1, (r.width || 12) * k); g.beginPath(); g.moveTo(sx(r.x1), sz(r.z1)); g.lineTo(sx(r.x2), sz(r.z2)); g.stroke(); }
    for (const b of map.grid.rect(minX, minZ, maxX, maxZ, [], true)) {
      if (b.nature || HIDDEN.has(b.type)) continue;
      g.fillStyle = boxColor(b);
      g.fillRect(sx(b.minX), sz(b.minZ), Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
    }
    drawNames(g, map, inView, { minX, minZ, maxX, maxZ, k, sx, sz, W, H });
  }
  g.textAlign = 'center';
  for (const m of markers) {
    const x = sx(m.x), y = sz(m.z);
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
    const s = m.size || 7;
    g.fillStyle = m.color || '#fff';
    g.strokeStyle = '#000'; g.lineWidth = 2;
    if (m.kind === 'player') {
      g.save(); g.translate(x, y); g.rotate(-m.yaw + Math.PI);
      g.beginPath(); g.moveTo(0, -s * 1.4); g.lineTo(s, s); g.lineTo(-s, s); g.closePath(); g.fill(); g.stroke(); g.restore();
    } else if (m.kind === 'ring') {
      g.beginPath(); g.arc(x, y, m.radius * k, 0, Math.PI * 2); g.strokeStyle = m.color; g.lineWidth = 2; g.stroke();
    } else if (m.kind === 'diamond') {
      g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); g.fill(); g.stroke();
    } else {
      g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    if (m.highlight) { g.beginPath(); g.arc(x, y, s + 6, 0, Math.PI * 2); g.strokeStyle = '#ffc53d'; g.lineWidth = 3; g.stroke(); }
    if (m.label) {
      g.font = `bold ${m.highlight ? 13 : 11}px Segoe UI, sans-serif`;
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.strokeText(m.label, x, y - s - 5);
      g.fillStyle = m.highlight ? '#ffc53d' : '#eee'; g.fillText(m.label, x, y - s - 5);
    }
  }
  // Scale bar in feet / miles.
  const STEPS = [[100, 'ft'], [250, 'ft'], [500, 'ft'], [1000, 'ft'], [0.25, 'mi'], [0.5, 'mi'], [1, 'mi'], [2, 'mi'], [5, 'mi']];
  const toM = ([v, u]) => (u === 'ft' ? v / 3.28084 : v * 1609.344);
  const step = STEPS.find((st) => toM(st) * k >= 70) || STEPS[STEPS.length - 1];
  const bw = toM(step) * k, bx = 16, by = H - 18;
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(bx - 6, by - 20, bw + 12, 28);
  g.strokeStyle = '#eee'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(bx, by - 5); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.lineTo(bx + bw, by - 5); g.stroke();
  g.fillStyle = '#eee'; g.font = 'bold 11px Segoe UI, sans-serif'; g.textAlign = 'center';
  g.fillText(`${step[0]} ${step[1]}`, bx + bw / 2, by - 7);
  return { toWorld: (px, py) => ({ x: view.cx + (px - W / 2) / k, z: view.cz + (py - H / 2) / k }), k };
}
