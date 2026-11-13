// Full-map rendering for the map screen (M), the deploy/redeploy screen and fast travel.
const COL = { grass: '#3f4d31', town: '#4b4f55', building: '#7b7f86', road: '#2c2f33', tree: '#24391f', house: '#a8774c', farm: '#8a6d4c' };

/** Draw the static world once into an offscreen canvas. */
export function buildMapBase(map, px = 1400) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const k = px / map.size;
  const X = (x) => (x + map.half) * k, Z = (z) => (z + map.half) * k;
  g.fillStyle = COL.grass; g.fillRect(0, 0, px, px);
  g.strokeStyle = COL.road; g.lineWidth = Math.max(2, 8 * k);
  for (const r of map.roads) { g.beginPath(); g.moveTo(X(r.x1), Z(r.z1)); g.lineTo(X(r.x2), Z(r.z2)); g.stroke(); }
  for (const t of map.towns) { g.fillStyle = COL.town; g.fillRect(X(t.rect.minX), Z(t.rect.minZ), (t.rect.maxX - t.rect.minX) * k, (t.rect.maxZ - t.rect.minZ) * k); }
  for (const b of map.boxes) {
    if (b.type === 'tree') { g.fillStyle = COL.tree; g.fillRect(X(b.minX) - 1, Z(b.minZ) - 1, 2.2, 2.2); continue; }
    if (b.type === 'border' || b.type === 'cover' || b.type === 'rock' || b.type === 'car' || b.type === 'terminal') continue;
    g.fillStyle = b.type === 'housewall' || b.type === 'crate' ? COL.house : b.type === 'farmhouse' || b.type === 'barn' ? COL.farm : COL.building;
    g.fillRect(X(b.minX), Z(b.minZ), Math.max(1, (b.maxX - b.minX) * k), Math.max(1, (b.maxZ - b.minZ) * k));
  }
  g.font = `bold ${Math.round(px / 90)}px Segoe UI, sans-serif`;
  g.textAlign = 'center';
  for (const t of map.towns) {
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(t.name, X(t.x), Z(t.rect.minZ) - 4);
    g.fillStyle = '#e8e8e8'; g.fillText(t.name, X(t.x), Z(t.rect.minZ) - 4);
  }
  return c;
}

/**
 * Draw the map with live markers. `view` = { cx, cz, zoom } (zoom 1 = whole map).
 * markers: [{ x, z, kind, label, color, size, highlight }]
 */
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
  return { toWorld: (px, py) => ({ x: view.cx + (px - W / 2) / k, z: view.cz + (py - H / 2) / k }), k };
}
