#!/usr/bin/env python3
"""Liberty County's own GIS (its 911 road centrelines and address points) on top of the open data.

    python3 tools/import_county.py <folder with Roads.shp> <folder with "Address gdb.shp" | address points .json>

The address points can also be a cut-down .json: {"rows": [[lat, lon, place_type, structype], ...]}.

Writes data/real/county.json, which the server and every client add to the open data the same way
(shared/county.js), after it, so no existing building or road changes its number:

  structures  the county's homes that have no building in the open data (most of the county's
              mobile homes and many houses): a house or a mobile home on the spot, its long side to
              the nearest road, kept off the road itself
  roads       county roads the open data hasn't got (mostly private roads and long driveways)
  surface     open-data roads the county says are dirt (or paved): [road index, 'track'|'paved']
  move        open-data minor roads the county surveyed elsewhere (same name, ours 10+ m off along most
              of it): [road index, the road's points snapped onto the county's line]
  hydrants    the county's fire hydrants

Only where things are and what kind of thing they are is used. The address points also carry
dispatch notes, owners' names and phone numbers: none of that is read or written.

Needs: pip install pyshp
"""
import collections, json, math, os, re, sys
import shapefile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAL = os.path.join(ROOT, 'data', 'real')
roads_dir, addr_dir = sys.argv[1], sys.argv[2]
R = 6378137.0
def ll(x, y):   # Web Mercator (the county's files) -> lat, lon
    return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), math.degrees(x / R)

geo = json.load(open(os.path.join(ROOT, 'shared', 'data', 'map-bristol.json')))
O, SZ = geo['origin'], geo['sizeM']
CX, CZ = geo['centreOffsetM']['east'], -geo['centreOffsetM']['north']
MLAT = 69.05 * 1609.344
MLON = 69.17 * math.cos(math.radians(O['lat'])) * 1609.344
def xz(lat, lon):   # the game's own projection (shared/geography.js)
    return (lon - O['lon']) * MLON - CX, -(lat - O['lat']) * MLAT - CZ
H = SZ / 2 - 40
inside = lambda x, z: abs(x) < H and abs(z) < H

DIRT = {'FD', 'CD', 'GM', 'PR', 'DIRT'}
PAVED = {'SR', 'CP', 'BP', 'FP'}
TITLE = {'NW': 'NW', 'NE': 'NE', 'SW': 'SW', 'SE': 'SE', 'SR': 'SR', 'CR': 'CR', 'FR': 'FR', 'US': 'US'}
# Road names compared across the two sources: 'NW Lindsey Ln' is 'Lindsey Lane'.
ABBR = {'road': 'rd', 'lane': 'ln', 'drive': 'dr', 'trail': 'tr', 'circle': 'cir', 'loop': 'lp', 'lp': 'lp', 'street': 'st',
        'avenue': 'ave', 'court': 'ct', 'place': 'pl', 'highway': 'hwy', 'boulevard': 'blvd', 'way': 'wy', 'path': 'pth'}
def key(name):
    w = [ABBR.get(t, t) for t in re.sub(r'[^a-z0-9 ]', ' ', (name or '').lower()).split()]
    while w and w[0] in ('nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w', 'northwest', 'northeast', 'southwest', 'southeast'): w = w[1:]
    return ' '.join(w)
def nice(label):
    return ' '.join(TITLE.get(w, w.capitalize()) for w in (label or '').split())

# ---- what's there already
roads = json.load(open(os.path.join(REAL, 'roads.json')))['rows']
structs = json.load(open(os.path.join(REAL, 'structures.json')))['rows']
CELL = 60
def grid_of(points):
    g = collections.defaultdict(list)
    for p in points:
        g[(int(p[0] // CELL), int(p[1] // CELL))].append(p)
    return g
def near(g, x, z, d):
    best = None
    for i in range(int(x // CELL) - 1 - int(d // CELL), int(x // CELL) + 2 + int(d // CELL)):
        for j in range(int(z // CELL) - 1 - int(d // CELL), int(z // CELL) + 2 + int(d // CELL)):
            for p in g.get((i, j), ()):
                dd = math.hypot(p[0] - x, p[1] - z)
                if dd < d and (best is None or dd < best[0]):
                    best = (dd, p)
    return best
bld = grid_of([(*xz(r[0], r[1]), max(r[2], r[3])) for r in structs])

# ---- county roads: surfaces for ours, and the ones we haven't got
rr = shapefile.Reader(os.path.join(roads_dir, 'Roads'))
RF = [f[0] for f in rr.fields[1:]]
ours_by_name = collections.defaultdict(list)   # name key -> our roads' points
for _n, _c, _pts in roads:
    if key(_n): ours_by_name[key(_n)] += [xz(*p) for p in _pts]
def through_building(run):
    """A driveway drawn straight through someone's house: leave it out."""
    for (la1, lo1), (la2, lo2) in zip(run, run[1:]):
        (x1, z1), (x2, z2) = xz(la1, lo1), xz(la2, lo2)
        n = max(1, int(math.hypot(x2 - x1, z2 - z1) / 3))
        for k in range(n + 1):
            x, z = x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n
            hit = near(bld, x, z, 15)
            if hit and hit[0] < hit[1][2] * 0.4: return True
    return False
def same_as_ours(label, run):
    """A county road we'd add that's really one of ours under the county's spelling, drawn a little way off."""
    pts = ours_by_name.get(key(label))
    if not pts: return False
    mx, mz = xz(*run[len(run) // 2])
    return min(math.hypot(x - mx, z - mz) for x, z in pts) < 120
# ---- our minor roads that the county puts somewhere else: the county's 911 centrelines are surveyed;
# the open data's minor roads are often old census traces, 40-80 m off. Same name, and ours more than
# 10 m from the county's along most of it: ours moves onto the county's line (same number, same name).
by_name = collections.defaultdict(list)   # name key -> county polylines, in the game's metres
for sh, rec in zip(rr.shapes(), rr.records()):
    d = dict(zip(RF, rec))
    k = key(d['street_lab'])
    if k: by_name[k].append([ll(x, y) for x, y in sh.points])
def dist_to(poly, x, z):
    best = 1e9
    for (x1, z1), (x2, z2) in zip(poly, poly[1:]):
        dx, dz = x2 - x1, z2 - z1; L = dx * dx + dz * dz or 1
        t = max(0, min(1, ((x - x1) * dx + (z - z1) * dz) / L))
        best = min(best, math.hypot(x - x1 - dx * t, z - z1 - dz * t))
    return best
move, moved_keys = [], {}
for idx, (name, cls, pts) in enumerate(roads):
    k = key(name)
    if not k or k not in by_name or cls in ('primary', 'secondary', 'trunk', 'motorway'): continue
    P = [xz(*p) for p in pts]
    if not inside(*P[len(P) // 2]): continue
    cands = [[xz(*q) for q in poly] for poly in by_name[k]]
    near_c = [c for c in cands if min(dist_to(c, x, z) for x, z in P[::max(1, len(P) // 6)]) < 150]
    if not near_c: continue
    ds = sorted(min(dist_to(c, x, z) for c in near_c) for x, z in P)
    med = ds[len(ds) // 2]
    if med <= 10 or ds[int(len(ds) * 0.8)] > 150: continue
    # Each point of ours (every ~12 m) snapped onto the nearest county line: the same stretch of road,
    # just where the county says it is.
    def snap(x, z):
        best = None
        for c in near_c:
            for (x1, z1), (x2, z2) in zip(c, c[1:]):
                dx, dz = x2 - x1, z2 - z1; L = dx * dx + dz * dz or 1
                t = max(0, min(1, ((x - x1) * dx + (z - z1) * dz) / L))
                px, pz = x1 + dx * t, z1 + dz * t
                d = math.hypot(x - px, z - pz)
                if best is None or d < best[0]: best = (d, px, pz)
        return best
    dense = []
    for (x1, z1), (x2, z2) in zip(P, P[1:]):
        n = max(1, int(math.hypot(x2 - x1, z2 - z1) / 12))
        dense += [(x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n) for k in range(n)]
    dense.append(P[-1])
    seg = []
    for x, z in dense:
        b = snap(x, z)
        if b and b[0] < 150 and (not seg or math.hypot(b[1] - seg[-1][0], b[2] - seg[-1][1]) > 1.5): seg.append((b[1], b[2]))
    if len(seg) < 2: continue
    plen = lambda Q: sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(Q, Q[1:]))
    if plen(seg) < 0.7 * plen(P): continue   # ours runs on past where the county's ends: leave it be
    lls = [[round(O['lat'] - (z + CZ) / MLAT, 6), round(O['lon'] + (x + CX) / MLON, 6)] for x, z in seg]
    move.append([idx, lls])
    moved_keys.setdefault(k, []).append(seg)
# Our roads where they'll be drawn now.
roads = [list(r) for r in roads]
for idx, lls in move: roads[idx][2] = lls
# Points every ~8 m along our roads, carrying the road's index and direction.
road_pts = []
for idx, (name, cls, pts) in enumerate(roads):
    P = [xz(*p) for p in pts]
    for (x1, z1), (x2, z2) in zip(P, P[1:]):
        L = math.hypot(x2 - x1, z2 - z1)
        n = max(1, int(L / 8))
        for k in range(n + 1):
            road_pts.append((x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n, idx, (x2 - x1) / (L or 1), (z2 - z1) / (L or 1)))
ours = grid_of(road_pts)
votes = collections.defaultdict(collections.Counter)
new_roads, county_pts = [], []
for sh, rec in zip(rr.shapes(), rr.records()):
    d = dict(zip(RF, rec))
    surf = (d['surfacetyp'] or '').strip().upper()
    kind = 'track' if surf in DIRT else 'paved' if surf in PAVED else None
    LL = [ll(x, y) for x, y in sh.points]
    P = [xz(*p) for p in LL]
    missing = []
    for i, ((x1, z1), (x2, z2)) in enumerate(zip(P, P[1:])):
        L = math.hypot(x2 - x1, z2 - z1)
        n = max(1, int(L / 10))
        for k in range(n + 1):
            x, z = x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n
            county_pts.append((x, z, (x2 - x1) / (L or 1), (z2 - z1) / (L or 1)))
        mx, mz = (x1 + x2) / 2, (z1 + z2) / 2
        if not inside(mx, mz):
            continue
        hit = near(ours, mx, mz, 22)
        if hit and kind:
            votes[hit[1][2]][kind] += L
        missing.append(not near(ours, mx, mz, 30))
    # Runs of the county road that ours hasn't got (at least 40 m of them) become new roads.
    run = []
    for i, miss in enumerate(missing):
        if miss:
            run = run or [LL[i]]
            run.append(LL[i + 1])
        if (not miss or i == len(missing) - 1) and len(run) > 1:
            Lrun = sum(math.hypot(*(a - b for a, b in zip(xz(*p), xz(*q)))) for p, q in zip(run, run[1:]))
            if Lrun >= 40 and not same_as_ours(d['street_lab'], run) and not through_building(run):
                new_roads.append([nice(d['street_lab']), 'track' if kind != 'paved' else 'residential', [[round(a, 6), round(b, 6)] for a, b in run]])
            run = []
surface = []
for idx, v in votes.items():
    kind, amount = v.most_common(1)[0]
    cls = roads[idx][1]
    if kind == 'track' and cls != 'track' and cls not in ('primary', 'secondary'):
        surface.append([idx, 'track'])
    elif kind == 'paved' and cls == 'track':
        surface.append([idx, 'paved'])
county = grid_of(county_pts)

# ---- homes the open data hasn't got, and the hydrants
def address_points():   # (lat, lon, {'place_type', 'structype'}) from the shapefile or the cut-down .json
    if addr_dir.endswith('.json'):
        for lat, lon, pt, st in json.load(open(addr_dir))['rows']:
            yield lat, lon, {'place_type': pt, 'structype': st}
        return
    ar = shapefile.Reader(os.path.join(addr_dir, 'Address gdb'))
    AF = [f[0] for f in ar.fields[1:]]
    for sh, rec in zip(ar.shapes(), ar.records()):
        d = dict(zip(AF, rec))
        yield (*ll(*sh.points[0]), {'place_type': d['place_type'], 'structype': d['structype']})
homes, hydrants, placed = [], [], []
MOBILE = {'MH', 'SW', 'RV', 'MOBILE HOME', 'DW', 'DOUBLE WIDE', 'TRAILER'}
for lat, lon, d in address_points():
    pt = (d['place_type'] or '').strip()
    x, z = xz(lat, lon)
    if not inside(x, z):
        continue
    if pt == 'Fire Hydrant':
        hydrants.append([round(lat, 6), round(lon, 6)])
        continue
    if pt != 'House' and (pt or (d['structype'] or '').strip() not in MOBILE | {'HOUSE', 'FRAMED HOUSE'}):
        continue
    if near(bld, x, z, 28) or any(math.hypot(px - x, pz - z) < 14 for px, pz in placed[-400:]):
        continue
    st = (d['structype'] or '').strip().upper()
    h = (hash((round(lat, 5), round(lon, 5))) & 0xffff) / 0xffff
    if st in MOBILE or h < 0.45:   # most of the county's homes without a footprint are mobile homes
        w, dd = (20.0 if st not in ('DW', 'DOUBLE WIDE') else 18.0), (4.6 if st not in ('DW', 'DOUBLE WIDE') else 8.5)
    else:
        w, dd = round(11 + h * 5, 1), round(9 + h * 4, 1)
    # Long side along the nearest road; kept back off it.
    r = near(county, x, z, 120) or near(ours, x, z, 120)
    ang = 0.0
    if r:
        rx, rz, ux, uz = r[1][0], r[1][1], r[1][-2], r[1][-1]
        ang = math.degrees(math.atan2(uz, ux))
        nx, nz = x - rx, z - rz
        dist = math.hypot(nx, nz)
        need = dd / 2 + 9
        if dist < need:
            if dist < 0.5:
                nx, nz, dist = -uz, ux, 1
            x, z = rx + nx / dist * need, rz + nz / dist * need
            lon = O['lon'] + (x + CX) / MLON
            lat = O['lat'] - (z + CZ) / MLAT
    placed.append((x, z))
    homes.append([round(lat, 6), round(lon, 6), w, dd, 0, 'resid', '', round(ang, 1)])

out = {'source': "Liberty County, Florida: its 911 road centrelines and address points (locations and kinds of thing only). See ATTRIBUTION.md.",
       'structures': homes, 'roads': new_roads, 'surface': surface, 'move': move, 'hydrants': hydrants}
with open(os.path.join(REAL, 'county.json'), 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))
km = sum(sum(math.hypot(*(a - b for a, b in zip(xz(*p), xz(*q)))) for p, q in zip(r[2], r[2][1:])) for r in new_roads) / 1000
print(f'county: {len(move)} of our roads moved onto the county line; {len(homes)} homes added, {len(new_roads)} roads added ({km:.0f} km), {len(surface)} surfaces corrected '
      f"({sum(1 for s in surface if s[1] == 'track')} to dirt, {sum(1 for s in surface if s[1] == 'paved')} to paved), {len(hydrants)} hydrants")
