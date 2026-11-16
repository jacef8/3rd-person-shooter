#!/usr/bin/env python3
"""Liberty County's own GIS (its 911 road centrelines and address points) on top of the open data.

    python3 tools/import_county.py <folder with Roads.shp> <folder with "Address gdb.shp">

Writes data/real/county.json, which the server and every client add to the open data the same way
(shared/county.js), after it, so no existing building or road changes its number:

  structures  the county's homes that have no building in the open data (most of the county's
              mobile homes and many houses): a house or a mobile home on the spot, its long side to
              the nearest road, kept off the road itself
  roads       county roads the open data hasn't got (mostly private roads and long driveways)
  surface     open-data roads the county says are dirt (or paved): [road index, 'track'|'paved']
  hydrants    the county's fire hydrants

Only where things are and what kind of thing they are is used. The address points also carry
dispatch notes, owners' names and phone numbers: none of that is read or written.

Needs: pip install pyshp
"""
import collections, json, math, os, sys
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
bld = grid_of([(*xz(r[0], r[1]), max(r[2], r[3])) for r in structs])

# ---- county roads: surfaces for ours, and the ones we haven't got
rr = shapefile.Reader(os.path.join(roads_dir, 'Roads'))
RF = [f[0] for f in rr.fields[1:]]
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
            if Lrun >= 40:
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
ar = shapefile.Reader(os.path.join(addr_dir, 'Address gdb'))
AF = [f[0] for f in ar.fields[1:]]
homes, hydrants, placed = [], [], []
MOBILE = {'MH', 'SW', 'RV', 'MOBILE HOME', 'DW', 'DOUBLE WIDE', 'TRAILER'}
for sh, rec in zip(ar.shapes(), ar.records()):
    d = dict(zip(AF, rec))
    pt = (d['place_type'] or '').strip()
    lat, lon = ll(*sh.points[0])
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
       'structures': homes, 'roads': new_roads, 'surface': surface, 'hydrants': hydrants}
with open(os.path.join(REAL, 'county.json'), 'w') as fh:
    json.dump(out, fh, separators=(',', ':'))
km = sum(sum(math.hypot(*(a - b for a, b in zip(xz(*p), xz(*q)))) for p, q in zip(r[2], r[2][1:])) for r in new_roads) / 1000
print(f'county: {len(homes)} homes added, {len(new_roads)} roads added ({km:.0f} km), {len(surface)} surfaces corrected '
      f"({sum(1 for s in surface if s[1] == 'track')} to dirt, {sum(1 for s in surface if s[1] == 'paved')} to paved), {len(hydrants)} hydrants")
