// Liberty County's own GIS on top of the open data (tools/import_county.py -> data/real/county.json).
// Server and clients both build the map from the merged rows, so they must merge them the same way:
// the county's homes and roads go after the open data's (no existing building or road changes its
// number), and the county's word on which roads are dirt and which are paved replaces the open data's.
export function withCounty(real, county) {
  if (!county || !real?.structures) return real;   // (no open data, as in tests: leave it be)
  const roads = (real.roads || []).slice();
  for (const [i, kind] of county.surface || []) {
    const r = roads[i];
    if (r) roads[i] = [r[0], kind === 'track' ? 'track' : r[1] === 'track' ? 'residential' : r[1], r[2]];
  }
  return { ...real, structures: [...real.structures, ...(county.structures || [])], roads: [...roads, ...(county.roads || [])] };
}
