// Hand fixes to the real buildings (the map editor, client/editor.html): where a building really stands,
// which way it faces, how big it is, or that it isn't there at all. Server and clients build the map from
// the same rows, so both apply the same edits, after the county's (shared/county.js), and no building
// changes its number (a removed one leaves an empty row).
//
//   edits = { v: 1, b: { "<building number>": { lat, lon, ang, w, d } | { gone: 1 } } }
//
// The building number is its row in the merged list: the open data's buildings, then the county's homes.

/** A building's footprint as the editor and the world understand it: { lat, lon, w, d, ang }. */
export const placement = (row) => ({ lat: row[0], lon: row[1], w: row[2], d: row[3], ang: row[7] || 0 });

/** The rows with the edits made. */
export function withEdits(real, edits) {
  const b = edits?.b;
  if (!b || !real?.structures || !Object.keys(b).length) return real;
  const structures = real.structures.slice();
  for (const [k, e] of Object.entries(b)) {
    const i = Number(k), row = structures[i];
    if (!row || !Number.isInteger(i)) continue;
    if (e.gone) { structures[i] = null; continue; }
    const r = row.slice();
    if (Number.isFinite(e.lat)) r[0] = e.lat;
    if (Number.isFinite(e.lon)) r[1] = e.lon;
    if (Number.isFinite(e.w)) r[2] = Math.max(3, Math.min(120, e.w));
    if (Number.isFinite(e.d)) r[3] = Math.max(3, Math.min(120, e.d));
    if (Number.isFinite(e.ang)) r[7] = e.ang;
    // An L- or T-shaped outline is drawn in the building's own frame, so it moves and turns with it,
    // but it doesn't stretch: a resized one becomes a plain rectangle.
    if ((Number.isFinite(e.w) && e.w !== row[2]) || (Number.isFinite(e.d) && e.d !== row[3])) r.length = Math.min(r.length, 8);
    structures[i] = r;
  }
  return { ...real, structures };
}

/** Tidy edits from the editor (numbers only, nothing else), or null if they don't make sense. */
export function cleanEdits(raw, count) {
  if (!raw || typeof raw !== 'object' || typeof raw.b !== 'object' || !raw.b) return null;
  const b = {};
  for (const [k, e] of Object.entries(raw.b)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= count || !e || typeof e !== 'object') continue;
    if (e.gone) { b[i] = { gone: 1 }; continue; }
    const o = {};
    for (const f of ['lat', 'lon', 'ang', 'w', 'd']) if (Number.isFinite(e[f])) o[f] = Math.round(e[f] * (f === 'lat' || f === 'lon' ? 1e6 : 10)) / (f === 'lat' || f === 'lon' ? 1e6 : 10);
    if (Object.keys(o).length) b[i] = o;
  }
  return { v: 1, b };
}
