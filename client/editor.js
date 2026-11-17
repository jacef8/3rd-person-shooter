// The map editor: put the real buildings right. A top-down map of the county drawn from the same data
// the game builds from (open data + the county's GIS, shared/county.js), with the edits saved on the
// server (shared/edits.js). Pick a building, drag it, turn it, resize it, or take it out; Save keeps the
// edits; "Put in the game" restarts the worlds built with them (players are back in a few seconds).
import { project, unproject, REAL_SIZE } from '/shared/geography.js';
import { withCounty } from '/shared/county.js';
import { placement } from '/shared/edits.js';
import MAPDATA from '/shared/data/map-bristol.json' with { type: 'json' };

const $ = (id) => document.getElementById(id);
const FT = 3.28084;
const SIZE = REAL_SIZE;
let KEY = localStorage.getItem('dz_editor_key') || '';
{ const m = location.hash.match(/key=([^&]+)/); if (m) { KEY = decodeURIComponent(m[1]); localStorage.setItem('dz_editor_key', KEY); history.replaceState(null, '', location.pathname); } }

// ---------------------------------------------------------------- state
const S = {
  rows: [],          // merged building rows (before edits)
  bld: [],           // per row: { i, x, z, w, d, ang, rects, occ, name } with edits applied (null if gone)
  orig: [],          // per row: the same before edits
  roads: [],         // [{ cls, name, pts: [[x, z]...] }]
  biz: [],           // [{ name, x, z }]
  edits: { v: 1, b: {} },
  saved: '{}',       // the edits as last saved (to tell if there's anything to save)
  claims: new Map(), // building number -> owner name
  problems: new Map(), // building number -> why the game can't build it where it's been put
  sel: -1,
  undo: [],
  view: { cx: 0, cz: 0, k: 0.05 },   // centre (m) and pixels per metre
};
const toast = (t, ms = 3500) => { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), ms); };
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Editor-Key': KEY, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `Server said ${r.status}`), { status: r.status });
  return body;
};

// ---------------------------------------------------------------- data
async function load() {
  const get = async (f) => { const r = await fetch(`/data/real/${f}`); if (!r.ok) throw new Error(`Couldn't load ${f}`); return r.json(); };
  const [st, rd, county, biz] = await Promise.all([get('structures.json'), get('roads.json'), get('county.json').catch(() => null), get('businesses.json').catch(() => ({ rows: [] }))]);
  const merged = withCounty({ structures: st.rows, roads: rd.rows }, county);
  S.rows = merged.structures;
  S.openCount = st.rows.length;
  S.roads = merged.roads.map(([name, cls, pts]) => ({ name, cls, pts: pts.map(([la, lo]) => { const p = project(la, lo, SIZE); return [p.x, p.z]; }) }));
  for (const r of S.roads) { r.minX = Math.min(...r.pts.map((p) => p[0])); r.maxX = Math.max(...r.pts.map((p) => p[0])); r.minZ = Math.min(...r.pts.map((p) => p[1])); r.maxZ = Math.max(...r.pts.map((p) => p[1])); }
  S.biz = (biz.rows || []).map(([la, lo, , name]) => ({ name, ...project(la, lo, SIZE) }));
  // Lamar's and anything else placed by hand, and the named places (prisons, parks, sheriff's offices…).
  const extra = await fetch('/shared/data/real-extra.json').then((r) => r.json()).catch(() => ({}));
  for (const sh of extra.shops || []) S.biz.unshift({ name: sh.name, ...project(sh.lat, sh.lon, SIZE) });
  const infra = await get('infrastructure.json').catch(() => ({}));
  for (const [la, lo, , name] of infra.places || []) if (name && !/^(Gas station|Post office)$/.test(name)) S.biz.push({ name, ...project(la, lo, SIZE) });
  S.orig = S.rows.map((row, i) => fromRow(row, i));
  const towns = MAPDATA.towns.map((t) => ({ name: t.name, ...project(t.lat, t.lon, SIZE) }));
  for (const t of towns) { const o = document.createElement('option'); o.value = `${t.x},${t.z}`; o.textContent = t.name; $('town').append(o); }
  const bristol = towns.find((t) => /Bristol/.test(t.name)) || towns[0];
  Object.assign(S.view, { cx: bristol.x, cz: bristol.z, k: 0.6 });
}
function fromRow(row, i, e = null) {
  if (!row || e?.gone) return null;
  const p = { ...placement(row), ...(e || {}) };
  const { x, z } = project(p.lat, p.lon, SIZE);
  const resized = e && ((e.w != null && e.w !== row[2]) || (e.d != null && e.d !== row[3]));
  return { i, x, z, w: p.w || 10, d: p.d || 10, ang: p.ang || 0, rects: !resized && row[8] ? row[8] : null, occ: row[5] || '', name: row[6] || '' };
}
const rebuild = (i) => { S.bld[i] = fromRow(S.rows[i], i, S.edits.b[i]); };
async function loadEdits() {
  const r = await api('/api/editor/edits');
  S.edits = r.edits?.b ? r.edits : { v: 1, b: {} };
  S.saved = JSON.stringify(S.edits);
  S.claims = new Map(r.claims || []);
  for (const i of r.missing || []) S.problems.set(i, 'The game couldn\'t build this where it was put (something in the way, water, or steep ground). Move it a little.');
  S.bld = S.rows.map((_, i) => fromRow(S.rows[i], i, S.edits.b[i]));
  status();
}

// ---------------------------------------------------------------- drawing
const cv = $('cv'), g = cv.getContext('2d');
let W = 0, H = 0, dpr = 1, dirty = true;
function resize() {
  const r = $('map').getBoundingClientRect();
  dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height;
  cv.width = W * dpr; cv.height = H * dpr; dirty = true;
}
const sx = (x) => W / 2 + (x - S.view.cx) * S.view.k, sz = (z) => H / 2 + (z - S.view.cz) * S.view.k;
const wx = (px) => S.view.cx + (px - W / 2) / S.view.k, wz = (py) => S.view.cz + (py - H / 2) / S.view.k;
/** A building's outline pieces in the world: each a list of four corners. */
function pieces(b) {
  const a = b.ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const rects = b.rects || [[-b.w / 2, -b.d / 2, b.w / 2, b.d / 2]];
  return rects.map(([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([lx, lz]) => [b.x + lx * ca - lz * sa, b.z + lx * sa + lz * ca]));
}
const ROADW = { motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, residential: 6, unclassified: 6, service: 4, track: 4 };
function draw() {
  dirty = false;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#2d3a2a'; g.fillRect(0, 0, W, H);
  const x0 = wx(0), x1 = wx(W), z0 = wz(0), z1 = wz(H), k = S.view.k;
  // Roads.
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const r of S.roads) {
    if (r.maxX < x0 || r.minX > x1 || r.maxZ < z0 || r.minZ > z1) continue;
    g.strokeStyle = r.cls === 'track' ? '#8b7a58' : '#9aa1a8';
    g.lineWidth = Math.max(1, (ROADW[r.cls] || 5) * k);
    g.beginPath(); r.pts.forEach(([x, z], j) => (j ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z)))); g.stroke();
  }
  // Where an edited building was (dashed), then every building.
  const vis = (b) => b && b.x > x0 - 80 && b.x < x1 + 80 && b.z > z0 - 80 && b.z < z1 + 80;
  g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
  for (const k2 of Object.keys(S.edits.b)) { const o = S.orig[k2]; if (!vis(o)) continue; for (const q of pieces(o)) { g.beginPath(); q.forEach(([x, z], j) => (j ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z)))); g.closePath(); g.stroke(); } }
  g.setLineDash([]);
  if (k > 0.04) for (const b of S.bld) {
    if (!vis(b)) continue;
    const edited = S.edits.b[b.i] != null, claimed = S.claims.has(b.i), sel = b.i === S.sel, bad = S.problems.has(b.i);
    g.fillStyle = sel ? '#ffd84a' : edited ? '#ff8a2a' : claimed ? '#5aa8ff' : b.occ.startsWith('resid') ? '#a7a39a' : '#8a96a3';
    g.strokeStyle = bad ? '#ff3b3b' : sel ? '#fff' : '#20262c'; g.lineWidth = bad ? 3 : sel ? 2 : 1;
    for (const q of pieces(b)) { g.beginPath(); q.forEach(([x, z], j) => (j ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z)))); g.closePath(); g.fill(); g.stroke(); }
  }
  // Removed ones: a red cross where they were.
  g.strokeStyle = '#ff5a5a'; g.lineWidth = 2;
  for (const [k2, e] of Object.entries(S.edits.b)) { if (!e.gone) continue; const o = S.orig[k2]; if (!vis(o)) continue; const r = Math.max(4, Math.min(o.w, o.d) * k / 2); g.beginPath(); g.moveTo(sx(o.x) - r, sz(o.z) - r); g.lineTo(sx(o.x) + r, sz(o.z) + r); g.moveTo(sx(o.x) + r, sz(o.z) - r); g.lineTo(sx(o.x) - r, sz(o.z) + r); g.stroke(); }
  // Names: businesses, and roads when close.
  g.font = '700 13px Atkinson, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (k > 0.5) for (const b of S.biz) {
    if (b.x < x0 || b.x > x1 || b.z < z0 || b.z > z1) continue;
    const t = b.name, w = g.measureText(t).width + 10;
    g.fillStyle = 'rgba(18,22,27,0.85)'; g.fillRect(sx(b.x) - w / 2, sz(b.z) - 18 - 9, w, 18);
    g.fillStyle = '#ffd9b0'; g.fillText(t, sx(b.x), sz(b.z) - 18);
  }
  if (k > 0.35) {
    const seen = new Set();
    for (const r of S.roads) {
      if (!r.name || seen.has(r.name) || r.maxX < x0 || r.minX > x1 || r.maxZ < z0 || r.minZ > z1) continue;
      const m = r.pts[Math.floor(r.pts.length / 2)];
      if (m[0] < x0 || m[0] > x1 || m[1] < z0 || m[1] > z1) continue;
      seen.add(r.name);
      const w = g.measureText(r.name).width + 10;
      g.fillStyle = 'rgba(240,242,244,0.92)'; g.fillRect(sx(m[0]) - w / 2, sz(m[1]) - 9, w, 18);
      g.fillStyle = '#1b2128'; g.fillText(r.name, sx(m[0]), sz(m[1]));
    }
  }
  if (k <= 0.04) { g.fillStyle = '#f2f4f6'; g.font = '700 15px Atkinson, system-ui'; g.fillText('Zoom in to see the buildings', W / 2, 24); }
  // Scale bar.
  const ft = [50, 100, 250, 500, 1000, 2500, 5280].find((f) => (f / FT) * k > 70) || 5280;
  g.fillStyle = '#f2f4f6'; g.fillRect(14, H - 22, (ft / FT) * k, 4); g.font = '700 13px Atkinson, system-ui'; g.textAlign = 'left';
  g.fillText(ft === 5280 ? '1 mile' : `${ft} ft`, 14, H - 34);
}
(function loop() { if (dirty) draw(); requestAnimationFrame(loop); })();

// ---------------------------------------------------------------- picking and dragging
function hit(px, py) {
  const x = wx(px), z = wz(py);
  let best = -1, bd = Infinity;
  for (const b of S.bld) {
    if (!b || Math.abs(b.x - x) > 70 || Math.abs(b.z - z) > 70) continue;
    const a = b.ang * Math.PI / 180, dx = x - b.x, dz = z - b.z;
    const lx = dx * Math.cos(a) + dz * Math.sin(a), lz = -dx * Math.sin(a) + dz * Math.cos(a);
    const slack = 4 / S.view.k;   // a few pixels' grace for small ones
    if (Math.abs(lx) <= b.w / 2 + slack && Math.abs(lz) <= b.d / 2 + slack) { const d = Math.hypot(dx, dz); if (d < bd) { bd = d; best = b.i; } }
  }
  return best;
}
const pointers = new Map();
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  pointers.set(e.pointerId, { px, py });
  if (pointers.size === 2) { drag = { pinch: true, d0: dist(), k0: S.view.k }; return; }
  const i = hit(px, py);
  if (i >= 0 && i === S.sel) drag = { move: i, wx0: wx(px), wz0: wz(py), b0: { ...S.bld[i] }, moved: false };
  else drag = { pan: true, px0: px, py0: py, cx0: S.view.cx, cz0: S.view.cz, tap: i, moved: false };
});
const dist = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.px - b.px, a.py - b.py) || 1; };
cv.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  pointers.set(e.pointerId, { px, py });
  if (!drag) return;
  if (drag.pinch && pointers.size === 2) { S.view.k = Math.max(0.01, Math.min(12, drag.k0 * dist() / drag.d0)); dirty = true; return; }
  if (drag.pan) {
    if (Math.hypot(px - drag.px0, py - drag.py0) > 6) drag.moved = true;
    S.view.cx = drag.cx0 - (px - drag.px0) / S.view.k; S.view.cz = drag.cz0 - (py - drag.py0) / S.view.k; dirty = true;
  } else if (drag.move != null) {
    const dx = wx(px) - drag.wx0, dz = wz(py) - drag.wz0;
    if (!drag.moved && Math.hypot(dx, dz) * S.view.k < 4) return;
    if (!drag.moved) { pushUndo(drag.move); drag.moved = true; }
    setPlace(drag.move, { x: drag.b0.x + dx, z: drag.b0.z + dz }, false);
  }
});
const up = (e) => {
  pointers.delete(e.pointerId);
  if (!drag) return;
  if (drag.pan && !drag.moved && !drag.pinch) select(drag.tap);
  if (drag.move != null && drag.moved) panel();
  drag = pointers.size ? null : null;
};
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, bx = wx(px), bz = wz(py);
  S.view.k = Math.max(0.01, Math.min(12, S.view.k * Math.exp(-e.deltaY * 0.0015)));
  S.view.cx = bx - (px - W / 2) / S.view.k; S.view.cz = bz - (py - H / 2) / S.view.k; dirty = true;
}, { passive: false });

// ---------------------------------------------------------------- editing
function pushUndo(i) { S.undo.push([i, S.edits.b[i] ? { ...S.edits.b[i] } : null]); if (S.undo.length > 200) S.undo.shift(); }
/** Set where building i is / which way it faces / how big it is (any of x, z, ang, w, d). */
function setPlace(i, p, withUndo = true) {
  if (withUndo) pushUndo(i);
  const cur = S.bld[i] || S.orig[i], row = S.rows[i];
  const x = p.x ?? cur.x, z = p.z ?? cur.z;
  const ll = unproject(x, z, SIZE);
  const e = { lat: ll.lat, lon: ll.lon, ang: ((p.ang ?? cur.ang) % 360 + 360) % 360, w: p.w ?? cur.w, d: p.d ?? cur.d };
  // Nothing different from the data: no edit at all.
  const o = placement(row);
  if (Math.abs(e.lat - o.lat) < 2e-7 && Math.abs(e.lon - o.lon) < 2e-7 && Math.abs(e.ang - (o.ang || 0)) < 0.05 && e.w === o.w && e.d === o.d) delete S.edits.b[i];
  else S.edits.b[i] = e;
  rebuild(i); dirty = true; status();
  checkSoon(i);
}
/** Ask the game whether building i can stand where it now is (after the dragging stops). */
const checkTimers = new Map();
function checkSoon(i) {
  clearTimeout(checkTimers.get(i));
  checkTimers.set(i, setTimeout(async () => {
    const e = S.edits.b[i];
    if (!e || e.gone) { S.problems.delete(i); dirty = true; if (i === S.sel) panel(); return; }
    try {
      const r = await api('/api/editor/check', { method: 'POST', body: JSON.stringify({ si: i, e }) });
      if (r.ok) S.problems.delete(i); else S.problems.set(i, r.why);
    } catch { /* leave it as it was */ }
    dirty = true; status(); if (i === S.sel) panel();
  }, 350));
}
function select(i) { S.sel = i; dirty = true; panel(); }
function remove(i) {
  if (S.claims.has(i)) return toast(`That's ${S.claims.get(i) || 'someone'}'s stash house: it can be moved, but not taken out.`);
  pushUndo(i); S.edits.b[i] = { gone: 1 }; rebuild(i); dirty = true; status(); panel();
}
function reset(i) { pushUndo(i); delete S.edits.b[i]; S.problems.delete(i); rebuild(i); dirty = true; status(); panel(); }
$('undo').onclick = () => {
  const u = S.undo.pop();
  if (!u) return;
  const [i, e] = u;
  if (e) S.edits.b[i] = e; else delete S.edits.b[i];
  rebuild(i); checkSoon(i); dirty = true; status(); panel();
};
const OCC = { resid: 'Home', comm: 'Shop or office', indus: 'Warehouse', agri: 'Farm building', civic: 'Public building', gov: 'Public building', educ: 'School' };
function panel() {
  const side = $('side'), i = S.sel;
  if (i < 0) { side.innerHTML = '<h2>Fix a building</h2><p class="sub">Tap a building to pick it. Drag it to move it. Drag the empty map to look around; pinch or scroll to zoom.</p><div class="legend"><span><i style="background:#8a96a3"></i>Building</span><span><i style="background:var(--accent)"></i>Changed</span><span><i style="background:var(--claim)"></i>Someone\'s stash house</span><span><i style="background:var(--sel)"></i>Picked</span></div>'; return; }
  const b = S.bld[i], o = S.orig[i], e = S.edits.b[i];
  const near = S.biz.filter((q) => Math.hypot(q.x - o.x, q.z - o.z) < 40).map((q) => q.name);
  const kind = OCC[String(o.occ).slice(0, 5)] || OCC[String(o.occ).slice(0, 4)] || 'Building';
  const moved = b && (Math.hypot(b.x - o.x, b.z - o.z) * FT);
  side.innerHTML = `
    <h2>${o.name || near[0] || kind}</h2>
    <p class="sub">${kind} · building #${i}${i >= S.openCount ? ' (from the county\'s map)' : ''}</p>
    <p>${e?.gone ? '<span class="chip gone">Taken out</span>' : e ? '<span class="chip edit">Changed</span>' : ''} ${S.claims.has(i) ? `<span class="chip claim">${S.claims.get(i) || 'Someone'}'s stash house</span>` : ''}</p>
    ${S.problems.has(i) ? `<p style="color:#ffb3b3;border:1px solid var(--bad);border-radius:10px;padding:8px 10px;margin:8px 0">⚠ The game can't build it here: ${S.problems.get(i)}.</p>` : ''}
    ${e?.gone ? '' : `
    <div class="lbl">Size</div>
    <div class="num">${Math.round(b.w * FT)} × ${Math.round(b.d * FT)} ft · facing ${Math.round(b.ang)}°${moved > 1 ? ` · moved ${Math.round(moved)} ft` : ''}</div>
    <div class="lbl">Turn</div>
    <div class="row"><button data-a="ang" data-v="-15">⟲ 15°</button><button data-a="ang" data-v="-1">⟲ 1°</button><button data-a="ang" data-v="1">1° ⟳</button><button data-a="ang" data-v="15">15° ⟳</button></div>
    <div class="lbl">Nudge (1 ft)</div>
    <div class="row"><button data-a="mv" data-v="0,-1">↑ North</button><button data-a="mv" data-v="0,1">↓ South</button><button data-a="mv" data-v="-1,0">← West</button><button data-a="mv" data-v="1,0">East →</button></div>
    <div class="lbl">Resize (2 ft)</div>
    <div class="row"><button data-a="w" data-v="-1">Narrower</button><button data-a="w" data-v="1">Wider</button><button data-a="d" data-v="-1">Shallower</button><button data-a="d" data-v="1">Deeper</button></div>`}
    <div class="lbl">Other</div>
    <div class="row">${e?.gone ? '' : '<button data-a="gone" class="danger">Take it out</button>'}${e ? '<button data-a="reset">Put it back as it was</button>' : ''}<button data-a="none">Done</button></div>
    ${S.claims.has(i) ? '<p class="sub">Moving it is fine: their stash locker and anything they built moves with it.</p>' : ''}`;
  side.querySelectorAll('button[data-a]').forEach((btn) => btn.addEventListener('click', () => {
    const a = btn.dataset.a, v = btn.dataset.v, cur = S.bld[i];
    if (a === 'ang') setPlace(i, { ang: cur.ang + Number(v) });
    else if (a === 'mv') { const [dx, dz] = v.split(',').map(Number); setPlace(i, { x: cur.x + dx / FT, z: cur.z + dz / FT }); }
    else if (a === 'w') setPlace(i, { w: Math.max(3, cur.w + Number(v) * 2 / FT) });
    else if (a === 'd') setPlace(i, { d: Math.max(3, cur.d + Number(v) * 2 / FT) });
    else if (a === 'gone') return remove(i);
    else if (a === 'reset') return reset(i);
    else if (a === 'none') return select(-1);
    panel();
  }));
}
function status() {
  const n = Object.keys(S.edits.b).length, changed = JSON.stringify(S.edits) !== S.saved;
  const bad = [...S.problems.keys()].filter((i) => S.edits.b[i] && !S.edits.b[i].gone).length;
  $('status').textContent = `${n} building${n === 1 ? '' : 's'} fixed${bad ? ` · ${bad} can't go where they are` : ''}${changed ? ' · not saved' : ' · saved'}`;
  $('save').disabled = !changed; $('undo').disabled = !S.undo.length;
}
/** Fixes the game can't build where they are: say so before they're saved. */
const okToSave = () => {
  const bad = [...S.problems.keys()].filter((i) => S.edits.b[i] && !S.edits.b[i].gone);
  return !bad.length || confirm(`${bad.length} of these buildings can't go where you've put them (they're outlined in red), and the game would leave them out. Save anyway?`);
};
$('save').onclick = async () => {
  if (!okToSave()) return;
  try { await api('/api/editor/edits', { method: 'PUT', body: JSON.stringify(S.edits) }); S.saved = JSON.stringify(S.edits); status(); toast('Saved. "Put in the game" when you\'re ready for everyone to see it.'); }
  catch (err) { toast(`Not saved: ${err.message}`, 6000); }
};
$('apply').onclick = async () => {
  if (!okToSave()) return;
  if (JSON.stringify(S.edits) !== S.saved) { try { await api('/api/editor/edits', { method: 'PUT', body: JSON.stringify(S.edits) }); S.saved = JSON.stringify(S.edits); status(); } catch (err) { return toast(`Not saved: ${err.message}`, 6000); } }
  if (!confirm('Put these fixes in the game now? The game restarts: everyone playing is kicked off for about 20 seconds and comes straight back.')) return;
  try { await api('/api/editor/apply', { method: 'POST', body: '{}' }); toast('The game is restarting with your fixes. Back in about 20 seconds.', 8000); }
  catch (err) { toast(`Didn't go through: ${err.message}`, 6000); }
};
addEventListener('beforeunload', (e) => { if (JSON.stringify(S.edits) !== S.saved) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- finding places
$('town').onchange = () => { const v = $('town').value; if (!v) return; const [x, z] = v.split(',').map(Number); Object.assign(S.view, { cx: x, cz: z, k: Math.max(S.view.k, 0.6) }); dirty = true; $('town').value = ''; };
$('search').addEventListener('input', () => {
  const q = $('search').value.trim().toLowerCase(), box = $('results');
  if (q.length < 2) { box.hidden = true; return; }
  const found = S.biz.filter((b) => b.name.toLowerCase().includes(q)).slice(0, 12);
  box.innerHTML = '';
  for (const b of found) {
    const btn = document.createElement('button'); btn.textContent = b.name;
    btn.onclick = () => { Object.assign(S.view, { cx: b.x, cz: b.z, k: 2.5 }); dirty = true; box.hidden = true; $('search').value = ''; const i = hit(sx(b.x), sz(b.z)); if (i >= 0) select(i); };
    box.append(btn);
  }
  box.hidden = !found.length;
});

// ---------------------------------------------------------------- start
async function start() {
  resize(); addEventListener('resize', resize);
  await load();
  try { await loadEdits(); }
  catch (err) {
    if (err.status === 403 || err.status === 404) { askKey(err.status === 404 ? err.message : (KEY ? 'That key didn\'t work.' : '')); return; }
    toast(`Couldn't load the edits: ${err.message}`, 8000);
  }
  dirty = true;
}
function askKey(msg) {
  $('keybox').hidden = false;
  if (msg) { $('keyerr').textContent = msg; $('keyerr').hidden = false; }
  $('keygo').onclick = async () => {
    KEY = $('keyin').value.trim(); localStorage.setItem('dz_editor_key', KEY);
    try { await loadEdits(); $('keybox').hidden = true; dirty = true; }
    catch (err) { $('keyerr').textContent = err.status === 403 ? 'That key didn\'t work.' : err.message; $('keyerr').hidden = false; }
  };
}
start().catch((err) => toast(`The editor couldn't start: ${err.message}`, 10000));
