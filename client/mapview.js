// Full-map rendering for the map screen (M), the deploy/redeploy screen and fast travel.
const COL = { grass: '#3f4d31', town: '#4b4f55', building: '#7b7f86', road: '#e4ddcc', street: '#c9c2b0', route: '#f0b54a', dirt: '#b08d58', tree: '#24391f', house: '#a8774c', farm: '#8a6d4c', home: '#9a9186', civic: '#a65f4b' };
/** Fill a box on a canvas: a turned one as its real four corners. `X`/`Z` map world to pixels. */
export function fillBox(g, b, X, Z, min = 1) {
  if (b.ang === undefined) { g.fillRect(X(b.minX), Z(b.minZ), Math.max(min, X(b.maxX) - X(b.minX)), Math.max(min, Z(b.maxZ) - Z(b.minZ))); return; }
  g.beginPath();
  for (const [lx, lz] of [[-b.hw, -b.hd], [b.hw, -b.hd], [b.hw, b.hd], [-b.hw, b.hd]]) g.lineTo(X(b.cx + lx * b.ca - lz * b.sa), Z(b.cz + lx * b.sa + lz * b.ca));
  g.closePath(); g.fill();
}
/** Map colours: state routes amber, main roads light, streets a shade darker, dirt tracks brown. */
const roadColor = (r) => (r.dirt ? COL.dirt : r.hw ? COL.route : (r.width || 12) >= 8 ? COL.road : COL.street);
const HIDDEN = new Set(['border', 'cover', 'rock', 'car', 'terminal', 'boulder', 'cactus', 'canopy', 'caveroof', 'jetty', 'scrub', 'tree', 'pine', 'rail']);
const boxColor = (b) => (b.type === 'housewall' || b.type === 'crate' ? COL.house : b.type === 'farmhouse' || b.type === 'barn' ? COL.farm : b.type === 'home' ? COL.home : b.type === 'civic' ? COL.civic : COL.building);
// Label chips: solid panels with sharp text (no outlines or glows).
const CHIP = { bg: '#171a21', line: '#2a2f3a', ink: '#ffffff', road: '#ffd27a', place: '#9fe39f', routeBg: '#1d3f73', routeLine: '#5d8fd6' };

const GC = { plains: [104, 124, 68], forest: [58, 86, 44], desert: [214, 206, 170], mountain: [128, 104, 66], swamp: [52, 68, 40], sand: [204, 189, 140], water: [47, 107, 138], deep: [30, 72, 100] };
// Real land cover (terrain.cover): woods dark, pasture bright, each farm field its own crop.
const COVER_RGB = { 1: [60, 60, 34], 2: [104, 106, 62], 3: [112, 138, 70], 5: [98, 108, 82], 6: [204, 189, 140], 9: [78, 96, 56] };
const FIELDS = [[150, 122, 80], [118, 142, 62], [166, 154, 94], [136, 128, 70]];
/** The real ground cover's colour (0-255 RGB) at a point, or null where there's no land cover data. */
export function coverColor(terrain, x, z) {
  const c = terrain.cover ? terrain.cover(x, z) : 0;
  if (!c || c === 8) return null;
  if (c === 4) { const i = Math.floor(x / 90), j = Math.floor(z / 90); return FIELDS[(Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0 & 3]; }
  return COVER_RGB[c] || null;
}
/** Ground colour (0-255 RGB) of dry land at a point: the real cover (or the biome blend), with sand along the water's edge. */
export function landColor(terrain, x, z, h) {
  const b = terrain.biome(x, z);
  if (h < 0.7 && b.sea < 0.5) return GC.sand;
  const c = [0, 0, 0];
  for (const k of ['plains', 'forest', 'desert', 'mountain']) for (let i = 0; i < 3; i++) c[i] += GC[k][i] * b[k];
  for (let i = 0; i < 3; i++) c[i] += GC.swamp[i] * b.sea;
  const cc = coverColor(terrain, x, z);
  if (cc) for (let i = 0; i < 3; i++) c[i] = cc[i] * 0.85 + c[i] * 0.15;
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
  for (const r of [...map.roads].sort((a, b) => (a.hw ? 1 : 0) - (b.hw ? 1 : 0) || (a.width || 12) - (b.width || 12))) { g.strokeStyle = roadColor(r); g.lineWidth = Math.max(r.hw ? 3 : (r.width || 12) >= 8 ? 1.6 : r.dirt ? 0.8 : 1, (r.width || 12) * k); g.beginPath(); g.moveTo(X(r.x1), Z(r.z1)); g.lineTo(X(r.x2), Z(r.z2)); g.stroke(); }
  for (const t of map.towns) { g.fillStyle = COL.town; g.fillRect(X(t.rect.minX), Z(t.rect.minZ), (t.rect.maxX - t.rect.minX) * k, (t.rect.maxZ - t.rect.minZ) * k); }
  for (const b of map.boxes) {
    if (b.type === 'tree' || b.type === 'pine') { g.fillStyle = COL.tree; g.fillRect(X(b.minX) - 1, Z(b.minZ) - 1, 2.2, 2.2); continue; }
    if (HIDDEN.has(b.type)) continue;
    g.fillStyle = boxColor(b);
    fillBox(g, b, X, Z);
  }
  g.textAlign = 'center';
  // Labels: towns, rivers and lakes, parks and landmarks.
  for (const l of map.labels || map.towns.map((t) => ({ text: t.name, x: t.x, z: t.rect.minZ, kind: 'town' }))) {
    const water = l.kind === 'water', lm = l.kind === 'landmark';
    g.font = `${water ? 'italic ' : 'bold '}${Math.round(px / (water ? 105 : lm ? 115 : 85))}px Segoe UI, sans-serif`;
    // Place names on a solid chip (no outline around the letters).
    const tw = g.measureText(l.text).width, th = parseInt(g.font.match(/(\d+)px/)[1], 10);
    g.fillStyle = CHIP.bg; g.fillRect(X(l.x) - tw / 2 - th * 0.35, Z(l.z) - 4 - th * 0.95, tw + th * 0.7, th * 1.3);
    g.fillStyle = water ? '#a9d7f2' : lm ? '#bfe6a8' : '#f0f0f0';
    g.fillText(l.text, X(l.x), Z(l.z) - 4);
  }
  return c;
}

/**
 * Road names and landmark buildings, as solid chips, at every zoom level. State routes (SR 20 and
 * friends) are always named, repeated along the road; main roads appear as you zoom in, then every
 * named street. Labels never overlap: the more important one wins.
 */
function drawNames(g, map, roads, v) {
  const taken = [];
  const chip = (text, x, y, color, route = false) => {
    g.font = `700 ${route ? 13 : 12}px Segoe UI, system-ui, sans-serif`;
    const w = Math.ceil(g.measureText(text).width) + 14, h = route ? 22 : 20, x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
    if (x0 < 4 || y0 < 4 || x0 + w > v.W - 4 || y0 + h > v.H - 4) return false;
    if (taken.some((t) => x0 < t[0] + t[2] + 6 && x0 + w + 6 > t[0] && y0 < t[1] + t[3] + 4 && y0 + h + 4 > t[1])) return false;
    taken.push([x0, y0, w, h]);
    g.fillStyle = route ? CHIP.routeBg : CHIP.bg; g.strokeStyle = route ? CHIP.routeLine : CHIP.line; g.lineWidth = route ? 1.5 : 1;
    g.beginPath(); g.roundRect(x0 + 0.5, y0 + 0.5, w, h, route ? 4 : 6); g.fill(); g.stroke();
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x0 + w / 2, y0 + h / 2 + 1);
    g.textBaseline = 'alphabetic';
    return true;
  };
  // Tier 0: state routes. 1: main roads (zoomed in a little). 2: every named street (zoomed in close).
  const tierOf = (r) => (r.hw || /^(SR|US|CR|I)[ -]\d/.test(r.name) ? 0 : (r.width || 0) >= 8 ? 1 : 2);
  const minK = [0, 0.04, 0.12];   // routes always; main roads a little in; every street once you're in on a town
  const cell = [260, 300, 340];   // one label per this many pixels of road
  const best = new Map();
  for (const r of roads) {
    if (!r.name) continue;
    const tier = r.name === v.hereRoad ? -1 : tierOf(r);   // the road you're on comes first
    if (tier >= 0 && v.k < minK[tier]) continue;
    const x1 = v.sx(r.x1), y1 = v.sz(r.z1), x2 = v.sx(r.x2), y2 = v.sz(r.z2);
    const len = Math.hypot(x2 - x1, y2 - y1), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (mx < 0 || my < 0 || mx > v.W || my > v.H) continue;
    if (len < (tier <= 0 ? 4 : 24)) continue;
    const key = `${r.name}|${Math.floor(mx / cell[Math.max(0, tier)])}|${Math.floor(my / cell[Math.max(0, tier)])}`;
    const e = best.get(key);
    // The road you're on: its label sits just below the centre cross rather than under it.
    const nearCentre = tier === -1 && Math.abs(mx - v.W / 2) < 60 && Math.abs(my - v.H / 2) < 24;
    if (!e || len > e.len) best.set(key, { name: r.name, tier, len, x: mx, y: nearCentre ? v.H / 2 + 30 : my });
  }
  const list = [...best.values()].sort((a, b) => a.tier - b.tier || b.len - a.len);
  let placed = 0;
  for (const e of list) { if (placed >= 70) break; if (chip(e.name, e.x, e.y, e.tier === -1 ? '#ffc53d' : e.tier === 0 ? '#ffffff' : e.tier === 1 ? CHIP.road : CHIP.ink, e.tier === 0)) placed++; }
  // Landmarks once you're in close enough to find them.
  if (v.k > 0.12) for (const b of map.buildings) if (b.name && b.maxX > v.minX && b.minX < v.maxX && b.maxZ > v.minZ && b.minZ < v.maxZ) chip(b.name, v.sx((b.minX + b.maxX) / 2), v.sz(b.minZ) - 12, CHIP.place);
}

/**
 * Draw the map with live markers. `view` = { cx, cz, zoom } (zoom 1 = whole map).
 * markers: [{ x, z, kind, label, color, size, highlight }]
 */
const detail = { key: null, canvas: null };
export function drawMap(canvas, map, base, view, markers, hereRoad = null) {
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
  const minX = view.cx - W / 2 / k, maxX = view.cx + W / 2 / k, minZ = view.cz - H / 2 / k, maxZ = view.cz + H / 2 / k;
  // Roads on screen (zoomed out, a straight pass over the list beats thousands of grid cells).
  const wide = (maxX - minX) * (maxZ - minZ) > 4e6;
  const inView = wide ? map.roads.filter((r) => r.maxX >= minX && r.minX <= maxX && r.maxZ >= minZ && r.minZ <= maxZ) : map.roadGrid ? map.roadGrid.rect(minX, minZ, maxX, maxZ) : [];
  // Zoomed in past the base image's detail (the map is 30 km across): draw roads and buildings live.
  if (k > base.width / map.size * 1.5) {
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
    for (const r of [...inView].sort((a, b) => (a.hw ? 1 : 0) - (b.hw ? 1 : 0))) { g.strokeStyle = roadColor(r); g.lineWidth = Math.max(r.hw ? 3 : 1.5, (r.width || 12) * k); g.beginPath(); g.moveTo(sx(r.x1), sz(r.z1)); g.lineTo(sx(r.x2), sz(r.z2)); g.stroke(); }
    for (const b of map.grid.rect(minX, minZ, maxX, maxZ, [], true)) {
      if (b.nature || HIDDEN.has(b.type)) continue;
      g.fillStyle = boxColor(b);
      fillBox(g, b, sx, sz);
    }
  }
  drawNames(g, map, inView, { minX, minZ, maxX, maxZ, k, sx, sz, W, H, hereRoad });
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
      g.font = `700 ${m.highlight ? 14 : 13}px 'Atkinson Hyperlegible', Segoe UI, sans-serif`;
      // Marker names on a solid chip, like the road names.
      const tw = g.measureText(m.label).width;
      g.fillStyle = CHIP.bg; g.beginPath(); g.roundRect(x - tw / 2 - 6, y - s - 21, tw + 12, 20, 6); g.fill();
      g.fillStyle = m.highlight ? '#ffc53d' : '#ffffff'; g.fillText(m.label, x, y - s - 6);
    }
  }
  // Scale bar in feet / miles.
  const STEPS = [[100, 'ft'], [250, 'ft'], [500, 'ft'], [1000, 'ft'], [0.25, 'mi'], [0.5, 'mi'], [1, 'mi'], [2, 'mi'], [5, 'mi']];
  const toM = ([v, u]) => (u === 'ft' ? v / 3.28084 : v * 1609.344);
  const step = STEPS.find((st) => toM(st) * k >= 70) || STEPS[STEPS.length - 1];
  const bw = toM(step) * k, bx = 16, by = H - 18;
  g.fillStyle = CHIP.bg; g.fillRect(bx - 6, by - 20, bw + 12, 28);
  g.strokeStyle = '#eee'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(bx, by - 5); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.lineTo(bx + bw, by - 5); g.stroke();
  g.fillStyle = '#ffffff'; g.font = "700 13px 'Atkinson Hyperlegible', Segoe UI, sans-serif"; g.textAlign = 'center';
  g.fillText(`${step[0]} ${step[1]}`, bx + bw / 2, by - 7);
  return { toWorld: (px, py) => ({ x: view.cx + (px - W / 2) / k, z: view.cz + (py - H / 2) / k }), k };
}
