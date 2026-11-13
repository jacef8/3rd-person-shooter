// Full-map rendering for the map screen (M), the deploy/redeploy screen and fast travel.
const COL = { grass: '#3f4d31', town: '#4b4f55', building: '#7b7f86', road: '#2c2f33', tree: '#24391f', house: '#a8774c', farm: '#8a6d4c' };

const GC = { plains: [104, 124, 68], forest: [58, 86, 44], desert: [214, 206, 170], mountain: [128, 104, 66], swamp: [52, 68, 40], sand: [204, 189, 140], water: [47, 107, 138], deep: [30, 72, 100] };
/** Map colour (0-255 RGB) for a point: biome blend, water, beaches, snow, shaded by slope. */
export function mapGroundColor(map, x, z, H = map.terrain.height) {
  const t = map.terrain;
  const h = H(x, z);
  if (h < -6) return GC.deep;
  if (h < 0) return GC.water;
  const b = t.biome(x, z);
  if (h < 1.0 && b.sea < 0.5) return GC.sand;
  const c = [0, 0, 0];
  for (const k of ['plains', 'forest', 'desert', 'mountain']) for (let i = 0; i < 3; i++) c[i] += GC[k][i] * b[k];
  for (let i = 0; i < 3; i++) c[i] += GC.swamp[i] * b.sea;
  // Hill shading from the slope toward the light (north-west).
  const shade = Math.max(0.6, Math.min(1.35, 1 + (h - H(x - 12, z - 12)) * 0.04));
  return c.map((v) => Math.min(255, v * shade));
}

/** Draw the static world once into an offscreen canvas. */
export function buildMapBase(map, px = 1400) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const k = px / map.size;
  const X = (x) => (x + map.half) * k, Z = (z) => (z + map.half) * k;
  // Terrain: sample a coarse grid and scale it up smoothly.
  const res = Math.round(px / 6);
  const tc = Object.assign(document.createElement('canvas'), { width: res, height: res });
  const tg = tc.getContext('2d');
  const img = tg.createImageData(res, res);
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    // Direct evaluation here: going through the cached sampler would fill it for the whole map.
    const col = mapGroundColor(map, -map.half + (i + 0.5) * map.size / res, -map.half + (j + 0.5) * map.size / res, map.terrain.exact);
    const o = (j * res + i) * 4;
    img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(tc, 0, 0, px, px);
  g.strokeStyle = COL.road; g.lineCap = 'round';
  // Minor roads first, highways on top.
  for (const r of [...map.roads].sort((a, b) => (a.width || 12) - (b.width || 12))) { g.lineWidth = Math.max((r.width || 12) >= 10 ? 2 : 0.8, (r.width || 12) * k); g.beginPath(); g.moveTo(X(r.x1), Z(r.z1)); g.lineTo(X(r.x2), Z(r.z2)); g.stroke(); }
  for (const t of map.towns) { g.fillStyle = COL.town; g.fillRect(X(t.rect.minX), Z(t.rect.minZ), (t.rect.maxX - t.rect.minX) * k, (t.rect.maxZ - t.rect.minZ) * k); }
  for (const b of map.boxes) {
    if (b.type === 'tree' || b.type === 'pine') { g.fillStyle = COL.tree; g.fillRect(X(b.minX) - 1, Z(b.minZ) - 1, 2.2, 2.2); continue; }
    if (['border', 'cover', 'rock', 'car', 'terminal', 'boulder', 'cactus', 'canopy', 'caveroof', 'jetty', 'scrub'].includes(b.type)) continue;
    g.fillStyle = b.type === 'housewall' || b.type === 'crate' ? COL.house : b.type === 'farmhouse' || b.type === 'barn' ? COL.farm : COL.building;
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
    for (const r of map.roadGrid ? map.roadGrid.rect(minX, minZ, maxX, maxZ) : []) { g.lineWidth = Math.max(1, (r.width || 12) * k); g.beginPath(); g.moveTo(sx(r.x1), sz(r.z1)); g.lineTo(sx(r.x2), sz(r.z2)); g.stroke(); }
    for (const b of map.grid.rect(minX, minZ, maxX, maxZ, [], true)) {
      if (b.nature || ['border', 'cover', 'rock', 'car', 'terminal', 'boulder', 'canopy', 'caveroof', 'jetty', 'scrub', 'tree', 'pine'].includes(b.type)) continue;
      g.fillStyle = b.type === 'housewall' || b.type === 'crate' ? COL.house : b.type === 'farmhouse' || b.type === 'barn' ? COL.farm : COL.building;
      g.fillRect(sx(b.minX), sz(b.minZ), Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
    }
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
