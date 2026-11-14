#!/usr/bin/env python3
"""Real-world data for the game map, from open sources. One run does everything:

  1. The Apalachicola's real course and the real line of each state highway are written into
     shared/data/map-bristol.json (the base geography every game mode uses).
  2. data/real/structures.json   every real building footprint (size, height, class, name)
  3. data/real/roads.json        every real road with its real name or route number
  4. data/real/elevation.bin.gz  real ground elevation, with the real rivers, lakes and ponds cut in
  5. data/real/landcover.bin.gz  what covers the ground: woods, farm fields, pasture, town, marsh
  6. data/real/infrastructure.json  towers, water towers, substations, power lines, the solar farm,
     railways, boat landings and public places for the map

    pip install pyarrow shapely numpy pillow tifffile imagecodecs pyproj
    python3 tools/import_real_world.py
    python3 tools/import_real_world.py --release 2026-10-21.0 --cache /tmp/overture-cache

The server loads data/real/ at start-up and every client downloads the same files, so both build the
identical world. Changing the data changes the map, which starts a fresh save.

Sources (see data/real/ATTRIBUTION.md, which this tool writes):
  Overture Maps Foundation (overturemaps.org): buildings (Microsoft ML Building Footprints and
    OpenStreetMap), roads and water (OpenStreetMap). Read straight from Overture's public S3 bucket
    with HTTPS range requests: only the Parquet row groups that overlap the map are downloaded.
  USGS 3D Elevation Program lidar: the 1 m bare-earth DEM from the 2020 Hurricane Michael survey
    (public domain), read from USGS's public S3 bucket as Cloud-Optimized GeoTIFFs; only their 4 m
    overview level is downloaded. `--dem terrarium` uses AWS Terrain Tiles instead (USGS 3DEP 1/3
    arc-second data), which is also the fallback for anywhere the lidar has no value.
  ESA WorldCover 2021 (10 m land cover from Sentinel-1 and -2 satellite images, CC BY 4.0), read
    from ESA's public S3 bucket: only the 1024-pixel tiles over the map are downloaded.

Elevation and water level. The game's water level is 0 everywhere, but the real river falls about
4 m across the map. So heights are stored relative to the river's own water surface at the nearest
point along it: the river sits at 0, the floodplain a metre or few above, the Torreya bluffs ~45 m.

elevation.bin.gz (little-endian, gzipped): 'DZEL', uint16 version=2, uint16 n, float32 step metres,
float32 origin x, float32 origin z (the map's north-west corner), then the n*n heights in decimetres,
index = j * n + i for x = origin + i*step (east), z = origin + j*step (south), each stored as its
difference from left + up - up-left: n*n int8 (-128 = see the next escape), then the escapes as int16.
(Version 1 stored the n*n int16 decimetres directly.)
"""
import argparse, concurrent.futures, gzip, heapq, io, json, math, os, re, struct, subprocess, sys, urllib.request
from collections import Counter, defaultdict

import numpy as np
import shapely
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image, ImageDraw
from shapely import wkb
from shapely.geometry import LineString, MultiLineString, Point, box as shp_box
from shapely.ops import linemerge, substring

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com/'
MAP_JSON = os.path.join(ROOT, 'shared', 'data', 'map-bristol.json')
STEPS = ['rivers', 'highways', 'buildings', 'roads', 'elevation', 'landcover', 'infrastructure']

ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
ap.add_argument('--release', default=None, help='Overture release, e.g. 2026-10-21.0 (default: the latest)')
ap.add_argument('--size', type=float, default=30000, help='map size in metres (must match WORLD_SIZE)')
ap.add_argument('--step', type=float, default=30, help='elevation grid spacing in metres')
ap.add_argument('--dem', choices=['lidar', 'terrarium'], default='lidar', help='elevation source (see above)')
ap.add_argument('--cover-step', type=float, default=20, help='land cover grid spacing in metres')
ap.add_argument('--zoom', type=int, default=13, help='terrain tile zoom (13 is about 16 m per pixel here)')
ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'real'))
ap.add_argument('--cache', default=None, help='keep downloads here so a re-run is quick')
ap.add_argument('--only', default=','.join(STEPS), help=f'comma-separated steps to run: {",".join(STEPS)}')
args = ap.parse_args()
ONLY = set(args.only.split(','))
HALF = args.size / 2


# ------------------------------------------------------------------ building footprints
def footprint(g, lon0, lat0, m_lon, m_lat, res=0.5):
    """A building's footprint in its own frame: (angle in degrees, width, depth, pieces or None).

    The angle comes from the smallest rectangle around the real outline, turned so it stays within
    45 degrees of east (so nearly-square buildings keep a small angle). The outline is then covered
    with up to six rectangles (an L is two, a T three); pieces is None when one rectangle does."""
    poly = g if g.geom_type == 'Polygon' else max(getattr(g, 'geoms', [g]), key=lambda q: q.area)
    if poly.geom_type != 'Polygon' or poly.area <= 0:
        return None
    # Game metres: x east, z south.
    ext = [((x - lon0) * m_lon, -(y - lat0) * m_lat) for x, y in poly.exterior.coords]
    from shapely.geometry import Polygon
    P = Polygon(ext).buffer(0)
    if P.is_empty or P.area < 6:
        return None
    if P.geom_type != 'Polygon':
        P = max(P.geoms, key=lambda q: q.area)
    r = P.minimum_rotated_rectangle
    pts = list(r.exterior.coords)
    ex, ez = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
    ang = math.degrees(math.atan2(ez, ex))
    while ang > 45:
        ang -= 90
    while ang <= -45:
        ang += 90
    ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    loc = Polygon([(x * ca + z * sa, -x * sa + z * ca) for x, z in P.exterior.coords])
    x0, z0, x1, z1 = loc.bounds
    w, d = x1 - x0, z1 - z0
    if w < 2.5 or d < 2.5:
        return None
    full = [round(x0, 1), round(z0, 1), round(x1, 1), round(z1, 1)]
    if loc.area >= 0.9 * w * d or w * d < 40:
        return ang, w, d, None
    # Fill a 0.5 m grid with the outline and take the biggest rectangles until it's covered.
    nx, nz = max(1, int(math.ceil(w / res))), max(1, int(math.ceil(d / res)))
    xs = x0 + (np.arange(nx) + 0.5) * res
    zs = z0 + (np.arange(nz) + 0.5) * res
    gx, gz = np.meshgrid(xs, zs)
    grid = shapely.contains_xy(loc, gx, gz)
    total = grid.sum()
    rects, covered = [], 0
    while len(rects) < 6 and covered < 0.92 * total:
        best = max_rect(grid)
        if not best:
            break
        area, (i0, j0, i1, j1) = best
        if area * res * res < max(6, 0.04 * total * res * res):
            break
        grid[i0:i1, j0:j1] = False
        covered += area
        rects.append([round(x0 + j0 * res, 1), round(z0 + i0 * res, 1), round(x0 + j1 * res, 1), round(z0 + i1 * res, 1)])
    rects = [q for q in rects if q[2] - q[0] >= 2.5 and q[3] - q[1] >= 2.5]
    if len(rects) <= 1:
        return ang, w, d, None
    return ang, w, d, rects


def max_rect(m):
    """Largest all-True rectangle in a boolean grid: (cells, (row0, col0, row1, col1)) or None."""
    rows, cols = m.shape
    h = np.zeros(cols, dtype=int)
    best = None
    for i in range(rows):
        h = np.where(m[i], h + 1, 0)
        stack = []
        for j in range(cols + 1):
            cur = h[j] if j < cols else 0
            start = j
            while stack and stack[-1][1] >= cur:
                s0, hh = stack.pop()
                area = hh * (j - s0)
                if hh and (not best or area > best[0]):
                    best = (area, (i - hh + 1, s0, i + 1, j))
                start = s0
            stack.append((start, cur))
    return best


# ------------------------------------------------------------------ the game's own projection
def node_json(expr):
    """Evaluate a JS expression with the game's geography module loaded as G; returns parsed JSON."""
    js = f"import('{ROOT}/shared/geography.js').then((G) => {{ console.log(JSON.stringify({expr})); }})"
    return json.loads(subprocess.check_output(['node', '-e', js]))


_c = node_json(f'[G.unproject(-{HALF}, -{HALF}, {args.size}), G.unproject({HALF}, {HALF}, {args.size})]')
NW, SE = _c   # the projection is linear, so two corners define it
m = 100       # fetch a little beyond the edge
BBOX = (NW['lon'] - (SE['lon'] - NW['lon']) * m / args.size, SE['lat'] - (NW['lat'] - SE['lat']) * m / args.size,
        SE['lon'] + (SE['lon'] - NW['lon']) * m / args.size, NW['lat'] + (NW['lat'] - SE['lat']) * m / args.size)   # west, south, east, north


def to_x(lon):
    return (np.asarray(lon) - NW['lon']) / (SE['lon'] - NW['lon']) * args.size - HALF


def to_z(lat):
    return (np.asarray(lat) - NW['lat']) / (SE['lat'] - NW['lat']) * args.size - HALF


def to_lonlat(x, z):
    return (NW['lon'] + (x + HALF) / args.size * (SE['lon'] - NW['lon']), NW['lat'] + (z + HALF) / args.size * (SE['lat'] - NW['lat']))


def metres(geom):
    """A shapely geometry in lon/lat -> the same in game metres (x east, z south)."""
    from shapely import transform
    return transform(geom, lambda c: np.column_stack([to_x(c[:, 0]), to_z(c[:, 1])]))


# ------------------------------------------------------------------ Overture over plain HTTPS
def http(url, rng=None):
    req = urllib.request.Request(url, headers={'Range': f'bytes={rng[0]}-{rng[1]}'} if rng else {})
    for k in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if k == 4:
                raise
            print(f'  retry {url[-60:]}: {e}', file=sys.stderr)


class RangeFile:
    """A read-only file over HTTP range requests (with a small block cache), for pyarrow."""
    BLOCK = 1 << 20

    def __init__(self, url, size):
        self.url, self.size, self.pos, self.cache, self.closed = url, size, 0, {}, False

    def seek(self, pos, whence=0):
        self.pos = pos if whence == 0 else self.pos + pos if whence == 1 else self.size + pos
        return self.pos

    def tell(self):
        return self.pos

    def seekable(self):
        return True

    def readable(self):
        return True

    def close(self):
        self.closed = True

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        if n == 0:
            return b''
        start, end = self.pos, self.pos + n
        if n > 4 * self.BLOCK:   # big reads go straight through; small ones through the block cache
            data = http(self.url, (start, end - 1))
        else:
            b0, b1 = start // self.BLOCK, (end - 1) // self.BLOCK
            for b in range(b0, b1 + 1):
                if b not in self.cache:
                    self.cache[b] = http(self.url, (b * self.BLOCK, min(self.size, (b + 1) * self.BLOCK) - 1))
            blob = b''.join(self.cache[b] for b in range(b0, b1 + 1))
            data = blob[start - b0 * self.BLOCK: end - b0 * self.BLOCK]
        self.pos = end
        return data


def list_files(prefix):
    xml = http(f'{BUCKET}?list-type=2&prefix={prefix}').decode()
    return [(k, int(s)) for k, s in re.findall(r'<Key>([^<]+\.parquet)</Key>.*?<Size>(\d+)</Size>', xml)]


def latest_release():
    xml = http(f'{BUCKET}?list-type=2&prefix=release/&delimiter=/').decode()
    return sorted(re.findall(r'<Prefix>release/([^<]+)/</Prefix>', xml))[-1]


def overlapping_groups(key, size):
    """Row groups in one Parquet file whose bbox statistics overlap the map."""
    md = pq.ParquetFile(pa.PythonFile(RangeFile(BUCKET + key, size), mode='r')).metadata
    names = [md.schema.column(i).path for i in range(md.num_columns)]
    idx = {n: names.index(n) for n in ('bbox.xmin', 'bbox.xmax', 'bbox.ymin', 'bbox.ymax')}
    hits = []
    for g in range(md.num_row_groups):
        st = {n: md.row_group(g).column(i).statistics for n, i in idx.items()}
        if any(s is None or not s.has_min_max for s in st.values()) or (
                st['bbox.xmin'].min <= BBOX[2] and st['bbox.xmax'].max >= BBOX[0] and st['bbox.ymin'].min <= BBOX[3] and st['bbox.ymax'].max >= BBOX[1]):
            hits.append(g)
    return key, size, hits


def fetch(name, theme, cols):
    """Every feature of an Overture type that overlaps the map, as an Arrow table."""
    cached = args.cache and os.path.join(args.cache, f'{RELEASE}-{name}-{int(args.size)}.parquet')
    if cached and os.path.exists(cached):
        return pq.read_table(cached)
    files = list_files(f'release/{RELEASE}/{theme}/')
    print(f'{name}: reading the footers of {len(files)} files…')
    with concurrent.futures.ThreadPoolExecutor(24) as ex:
        found = [r for r in ex.map(lambda f: overlapping_groups(*f), files) if r[2]]
    tables = []
    for key, size, groups in found:
        t = pq.ParquetFile(pa.PythonFile(RangeFile(BUCKET + key, size), mode='r')).read_row_groups(groups, columns=cols + ['bbox'])
        b = t.column('bbox').combine_chunks()
        xmin, xmax, ymin, ymax = (b.field(n).to_numpy(zero_copy_only=False) for n in ('xmin', 'xmax', 'ymin', 'ymax'))
        tables.append(t.filter(pa.array((xmin <= BBOX[2]) & (xmax >= BBOX[0]) & (ymin <= BBOX[3]) & (ymax >= BBOX[1]))))
    t = pa.concat_tables(tables)
    print(f'  {t.num_rows} {name} features in the map area')
    if cached:
        os.makedirs(args.cache, exist_ok=True)
        pq.write_table(t, cached)
    return t


# ------------------------------------------------------------------ roads
ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'track', 'unknown'}
NETWORKS = {'US:I': 'I-', 'US:US': 'US ', 'US:FL': 'SR ', 'US:FL:CR': 'CR '}


def route_labels(routes):
    out = []
    for r in routes or []:
        pre = NETWORKS.get(r.get('network') or '')
        if pre and r.get('ref') and pre + r['ref'] not in out:
            out.append(pre + r['ref'])
    return out


def load_roads():
    t = fetch('roads', 'theme=transportation/type=segment', ['id', 'geometry', 'subtype', 'class', 'subclass', 'names', 'routes', 'connectors', 'road_surface'])
    d = t.to_pydict()
    segs = []
    for i in range(t.num_rows):
        cls = d['class'][i] or 'unknown'
        if d['subtype'][i] != 'road' or cls not in ROAD_CLASSES or d['subclass'][i] == 'parking_aisle':
            continue
        g = wkb.loads(d['geometry'][i])
        if g.geom_type != 'LineString':
            continue
        refs = route_labels(d['routes'][i])
        street = (d['names'][i] or {}).get('primary') or ''
        name = street if not refs else refs[0] if not street or street.replace('State Road ', 'SR ').replace('County Road ', 'CR ') in refs else f'{street} ({refs[0]})'
        surf = {s.get('value') for s in (d['road_surface'][i] or [])}
        if cls == 'living_street':
            cls = 'residential'
        if surf & {'unpaved', 'dirt', 'gravel'} and cls in ('residential', 'unclassified', 'service', 'unknown'):
            cls = 'track'   # drawn as a dirt road
        segs.append({'geom': g, 'line': metres(g), 'cls': cls, 'name': name, 'refs': refs, 'conns': [(c['connector_id'], c['at']) for c in (d['connectors'][i] or [])]})
    return segs


def write_roads(segs):
    rows = [[s['name'], s['cls'], [[round(y, 6), round(x, 6)] for x, y in s['geom'].coords]] for s in segs]
    named = sum(1 for s in segs if s['name'])
    print(f'roads: {len(rows)} segments, {named} with a name or route number ({len({s["name"] for s in segs if s["name"]})} different names)')
    write_json('roads.json', rows)


def road_graph(segs):
    """Overture segments meet at 'connectors', which can sit part-way along a segment: split there."""
    adj = defaultdict(list)
    xy = {}
    for s in segs:
        cs = sorted(s['conns'], key=lambda c: c[1])
        for (a, fa), (b, fb) in zip(cs, cs[1:]):
            if fb - fa <= 1e-9:
                continue
            sub = substring(s['line'], fa, fb, normalized=True)
            if sub.geom_type != 'LineString' or sub.length < 0.01:
                continue
            co = list(sub.coords)
            xy[a], xy[b] = co[0], co[-1]
            adj[a].append((b, sub.length, co, s['refs']))
            adj[b].append((a, sub.length, co[::-1], s['refs']))
    return adj, xy


def real_path(adj, xy, ref, start, end):
    """The real road for a route between two points: the shortest way that stays on the route
    wherever it's signed (other roads cost 8x, so they only bridge gaps in the tagging)."""
    on = {n for n, es in adj.items() if any(ref in e[3] for e in es)}
    if not on:
        return None
    near = lambda p: min(on, key=lambda n: (xy[n][0] - p[0]) ** 2 + (xy[n][1] - p[1]) ** 2)
    a, b = near(start), near(end)
    dist, prev, heap = {a: 0.0}, {}, [(0.0, a)]
    while heap:
        dcur, n = heapq.heappop(heap)
        if n == b:
            break
        if dcur > dist.get(n, math.inf):
            continue
        for o, ln, co, refs in adj[n]:
            nd = dcur + ln * (1 if ref in refs else 8)
            if nd < dist.get(o, math.inf):
                dist[o], prev[o] = nd, (n, co)
                heapq.heappush(heap, (nd, o))
    if b not in prev and a != b:
        return None
    parts, n = [], b
    while n != a:
        n, co = prev[n]
        parts.append(co)
    out = []
    for co in reversed(parts):
        out.extend(co if not out else co[1:])
    return out


def snap_highways(segs):
    """Replace the hand-traced line of each highway, inside the map, with the real road."""
    adj, xy = road_graph(segs)
    geo = json.load(open(MAP_JSON))
    area = shp_box(-HALF - 60, -HALF - 60, HALF + 60, HALF + 60)
    for hw in geo['highways']:
        traced = LineString([(float(to_x(lon)), float(to_z(lat))) for lat, lon in hw['path']])
        inside = traced.intersection(area)
        pieces = [g for g in getattr(inside, 'geoms', [inside]) if g.geom_type == 'LineString' and g.length > 50]
        if not pieces:
            continue
        s0 = min(traced.project(Point(p.coords[0])) for p in pieces)
        s1 = max(traced.project(Point(p.coords[-1])) for p in pieces)
        path = real_path(adj, xy, hw['name'], traced.interpolate(s0).coords[0], traced.interpolate(s1).coords[0])
        if not path or len(path) < 2:
            print(f'  {hw["name"]}: no signed road found in the data, kept as traced')
            continue
        line = LineString(path).simplify(3)
        before = [p for p in hw['path'] if traced.project(Point(float(to_x(p[1])), float(to_z(p[0])))) < s0 - 1]
        after = [p for p in hw['path'] if traced.project(Point(float(to_x(p[1])), float(to_z(p[0])))) > s1 + 1]
        real = [[round(float(lat), 6), round(float(lon), 6)] for lon, lat in (to_lonlat(x, z) for x, z in line.coords)]
        hw['path'] = before + real + after
        hw['_source'] = f'Inside the map: OpenStreetMap via Overture {RELEASE}; outside: traced by hand.'
        print(f'  {hw["name"]}: {line.length / 1000:.1f} km of real road, {len(real)} points')
    save_map_json(geo)


# ------------------------------------------------------------------ the river
def load_water():
    return fetch('water', 'theme=base/type=water', ['id', 'geometry', 'subtype', 'class', 'names', 'is_intermittent'])


def update_river(water):
    """Swap the hand-traced Apalachicola inside the map for its real centreline."""
    d = water.to_pydict()
    lines = [wkb.loads(d['geometry'][i]) for i in range(water.num_rows)
             if d['subtype'][i] == 'river' and (d['names'][i] or {}).get('primary') == 'Apalachicola River']
    merged = linemerge(MultiLineString([g for g in lines if g.geom_type == 'LineString']))
    line = max(getattr(merged, 'geoms', [merged]), key=lambda g: g.length).simplify(0.0003)   # ~30 m
    pts = [[round(y, 6), round(x, 6)] for x, y in line.coords]
    if pts[0][0] < pts[-1][0]:
        pts.reverse()   # north to south, like the traced path
    geo = json.load(open(MAP_JSON))
    rv = next(r for r in geo['rivers'] if r['name'] == 'Apalachicola River')
    rv['path'] = [p for p in rv['path'] if p[0] > pts[0][0]] + pts + [p for p in rv['path'] if p[0] < pts[-1][0]]
    rv['_source'] = f'Inside the map: OpenStreetMap centreline via Overture {RELEASE}; outside: traced by hand.'
    save_map_json(geo)
    print(f'river: the Apalachicola follows its real course ({len(pts)} points inside the map)')


def save_map_json(geo):
    text = json.dumps(geo, indent=2, ensure_ascii=False)
    # Keep the file's style: short all-number arrays on one line.
    text = re.sub(r'\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]', lambda mm: '[' + re.sub(r',\s+', ', ', mm.group(1)) + ']', text)
    with open(MAP_JSON, 'w') as fh:
        fh.write(text + '\n')


# ------------------------------------------------------------------ buildings
# Overture class / subtype -> the occupancy words the game's generator understands.
OCC = {
    'residential': 'resid', 'house': 'resid', 'detached': 'resid', 'apartments': 'resid', 'semidetached_house': 'resid', 'bungalow': 'resid',
    'static_caravan': 'resid', 'cabin': 'resid', 'dormitory': 'resid', 'terrace': 'resid', 'garage': 'resid', 'garages': 'resid', 'shed': 'resid',
    'carport': 'resid', 'outbuilding': 'resid', 'farm': 'agri', 'barn': 'agri', 'farm_auxiliary': 'agri', 'agricultural': 'agri', 'greenhouse': 'agri',
    'stable': 'agri', 'silo': 'agri', 'cowshed': 'agri', 'industrial': 'indus', 'warehouse': 'indus', 'factory': 'indus', 'manufacture': 'indus',
    'hangar': 'indus', 'commercial': 'comm', 'retail': 'comm', 'office': 'comm', 'supermarket': 'comm', 'hotel': 'comm', 'service': 'comm',
    'church': 'civic', 'chapel': 'civic', 'religious': 'civic', 'school': 'civic', 'education': 'civic', 'library': 'civic', 'hospital': 'civic',
    'medical': 'civic', 'government': 'civic', 'civic': 'civic', 'public': 'civic', 'fire_station': 'civic', 'police': 'civic', 'post_office': 'civic',
    'transportation': 'comm', 'entertainment': 'comm', 'military': 'civic',
}


CIVIC_WORDS = ('church', 'chapel', 'library', 'courthouse', 'city hall', 'town hall', 'school', 'post office', 'fire', 'emergency', 'ranger',
               'kingdom hall', 'assembly of god', 'museum', 'jail', 'sheriff', 'police', 'clinic', 'hospital', 'community center')
HOME_WORDS = ('cabin', 'home', 'house', 'calaboose', 'blacksmith', 'office')


def write_buildings():
    t = fetch('buildings', 'theme=buildings/type=building', ['id', 'geometry', 'height', 'num_floors', 'class', 'subtype', 'is_underground', 'names', 'sources'])
    d = t.to_pydict()
    m_lon, m_lat = abs(float(to_x(1) - to_x(0))), abs(float(to_z(1) - to_z(0)))   # metres per degree
    rows, src = [], Counter()
    for i in range(t.num_rows):
        if d['is_underground'][i]:
            continue
        try:
            g = wkb.loads(d['geometry'][i])
        except Exception:  # noqa: BLE001
            continue
        if g.is_empty:
            continue
        c = g.centroid
        shape = footprint(g, c.x, c.y, m_lon, m_lat)
        if not shape:
            continue
        ang, w, dd, rects = shape
        h = d['height'][i] or ((d['num_floors'][i] or 0) * 3.2) or 0
        cls, sub = d['class'][i] or '', d['subtype'][i] or ''
        occ = OCC.get(cls) or OCC.get(sub) or ''
        # Real names for landmarks (courthouse, churches, libraries, historic houses). Shop and brand
        # names are left out: only names that say what kind of public place it is are kept.
        name = (d['names'][i] or {}).get('primary') or ''
        low = name.lower()
        if name and occ in ('', 'civic') and any(k in low for k in CIVIC_WORDS):
            occ = 'civic'
        elif name and occ in ('', 'resid') and any(k in low for k in HOME_WORDS):
            occ = 'resid'
        elif occ != 'civic':
            name = ''
        # [lat, lon, width, depth, height, use, name, angle (degrees), pieces]. Width and depth are
        # measured along the building's own walls; the angle turns them to face the way it really
        # does. `pieces` (only for L, T and other shapes) are rectangles in the building's own
        # frame, relative to its centre: [x0, z0, x1, z1] in metres.
        row = [round(c.y, 6), round(c.x, 6), round(w, 1), round(dd, 1), round(h, 1), occ, name.strip().rstrip('.') if name else '', round(ang, 1)]
        if rects:
            row.append(rects)
        rows.append(row)
        src[((d['sources'][i] or [{}])[0] or {}).get('dataset') or 'unknown'] += 1
    print(f'buildings: {len(rows)} ({", ".join(f"{v} from {k}" for k, v in src.most_common())}); {sum(1 for r in rows if r[4] > 0)} with a measured height, {sum(1 for r in rows if r[6])} named')
    write_json('structures.json', rows)


# ------------------------------------------------------------------ elevation
def terrain_tiles(lon, lat):
    """Elevation in metres above sea level at each lon/lat (bilinear, from terrarium tiles)."""
    Z = args.zoom
    fx = (lon + 180) / 360 * 2 ** Z * 256
    lr = np.radians(lat)
    fy = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / np.pi) / 2 * 2 ** Z * 256
    tiles = {}
    for tx in range(int(fx.min() // 256), int(fx.max() // 256) + 1):
        for ty in range(int(fy.min() // 256), int(fy.max() // 256) + 1):
            cached = args.cache and os.path.join(args.cache, f'terrarium-{Z}-{tx}-{ty}.png')
            if cached and os.path.exists(cached):
                raw = open(cached, 'rb').read()
            else:
                raw = http(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png')
                if cached:
                    os.makedirs(args.cache, exist_ok=True)
                    open(cached, 'wb').write(raw)
            px = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), dtype=np.float64)
            tiles[(tx, ty)] = px[..., 0] * 256 + px[..., 1] + px[..., 2] / 256 - 32768

    def at(gx, gy):
        tx, ty = (gx // 256).astype(int), (gy // 256).astype(int)
        out = np.empty(gx.shape)
        for (a, b), arr in tiles.items():
            mk = (tx == a) & (ty == b)
            if mk.any():
                out[mk] = arr[(gy[mk] - b * 256).astype(int), (gx[mk] - a * 256).astype(int)]
        return out
    gx0, gy0 = np.floor(fx - 0.5), np.floor(fy - 0.5)
    u, v = fx - 0.5 - gx0, fy - 0.5 - gy0
    print(f'elevation: {len(tiles)} terrain tiles at zoom {Z}')
    return at(gx0, gy0) * (1 - u) * (1 - v) + at(gx0 + 1, gy0) * u * (1 - v) + at(gx0, gy0 + 1) * (1 - u) * v + at(gx0 + 1, gy0 + 1) * u * v


def remote_size(url):
    with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as r:
        return int(r.headers['Content-Length'])


LIDAR = ('https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/FL_HurricaneMichael_2020_D20/'
         'TIFF/USGS_1M_16_x{x}y{y}_FL_HurricaneMichael_2020_D20.tif')
LIDAR_LEVEL = 2   # overview level: 0 is 1 m, 1 is 2 m, 2 is 4 m


def lidar_dem(lon, lat):
    """Elevation in metres above sea level at each lon/lat from the USGS 1 m lidar DEM (UTM 16N tiles
    10 km on a side, named by their west and north edges in units of 10 km). NaN where there's none."""
    import tifffile
    from pyproj import Transformer
    E, N = Transformer.from_crs(4326, 26916, always_xy=True).transform(lon, lat)
    out = np.full(E.shape, np.nan)
    tiles = [(x, y) for x in range(int(E.min() // 10000), int(E.max() // 10000) + 1)
             for y in range(int(N.min() // 10000) + 1, int(N.max() // 10000) + 2)]

    def load(xy):
        x, y = xy
        cached = args.cache and os.path.join(args.cache, f'lidar-{x}-{y}-L{LIDAR_LEVEL}.npz')
        if cached and os.path.exists(cached):
            z = np.load(cached)
            return xy, z['a'], tuple(z['geo'])
        url = LIDAR.format(x=x, y=y)
        with tifffile.TiffFile(RangeFile(url, remote_size(url))) as t:
            p0, p = t.pages[0], t.pages[LIDAR_LEVEL]
            sx = p0.tags[33550].value[0] * p0.shape[1] / p.shape[1]
            tp = p0.tags[33922].value
            a = p.asarray().astype(np.float32)
        geo = (tp[3], tp[4], sx)
        if cached:
            os.makedirs(args.cache, exist_ok=True)
            np.savez(cached, a=a, geo=np.array(geo))
        return xy, a, geo

    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        for (x, y), a, (ox, oy, px) in pool.map(load, tiles):
            a[a < -1000] = np.nan
            # A 3 x 3 mean (12 m) so each sample is the ground around it, not one 4 m pixel.
            p = np.pad(a, 1, mode='edge')
            a = sum(p[1 + dj:1 + dj + a.shape[0], 1 + di:1 + di + a.shape[1]] for dj in (-1, 0, 1) for di in (-1, 0, 1)) / 9
            fx, fy = (E - ox) / px - 0.5, (oy - N) / px - 0.5
            mk = (fx >= 0) & (fy >= 0) & (fx < a.shape[1] - 1) & (fy < a.shape[0] - 1) & np.isnan(out)
            i, j = fx[mk].astype(int), fy[mk].astype(int)
            u, v = fx[mk] - i, fy[mk] - j
            out[mk] = (a[j, i] * (1 - u) * (1 - v) + a[j, i + 1] * u * (1 - v) + a[j + 1, i] * (1 - u) * v + a[j + 1, i + 1] * u * v)
            print(f'  lidar tile x{x}y{y}: {int(mk.sum())} samples')
    return out


def box_blur(a, r):
    """Mean over a (2r+1) square, edges repeated."""
    p = np.pad(a, r, mode='edge')
    c = np.cumsum(np.cumsum(p, axis=0), axis=1)
    c = np.pad(c, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def write_elevation(water, segs):
    step = args.step
    n = int(round(args.size / step)) + 1
    xs = -HALF + np.arange(n) * step
    X, Zg = np.meshgrid(xs, xs)   # [j, i]: x east, z south
    lon, lat = to_lonlat(X, Zg)
    if args.dem == 'lidar':
        dem = lidar_dem(lon, lat)
        gaps = np.isnan(dem)
        print(f'elevation: USGS lidar, {100 * (1 - gaps.mean()):.2f}% of the map covered')
        if gaps.any():
            dem[gaps] = terrain_tiles(lon[gaps], lat[gaps])
    else:
        dem = terrain_tiles(lon, lat)
    print(f'  ground {dem.min():.1f} .. {dem.max():.1f} m above sea level')

    # The river's water surface along its course (lidar elevation data is flat over water).
    river = node_json(f'G.geography({args.size}).rivers[0]')
    pts = np.array(river['pts'], dtype=np.float64)
    seg_len = np.hypot(*(pts[1:] - pts[:-1]).T)
    cum = np.concatenate([[0], np.cumsum(seg_len)])
    best_d = np.full(X.shape, np.inf)
    best_s = np.zeros(X.shape)
    for k in range(len(pts) - 1):
        a, d = pts[k], pts[k + 1] - pts[k]
        t = np.clip(((X - a[0]) * d[0] + (Zg - a[1]) * d[1]) / ((d ** 2).sum() or 1), 0, 1)
        dist = np.hypot(X - (a[0] + d[0] * t), Zg - (a[1] + d[1] * t))
        mk = dist < best_d
        best_d[mk] = dist[mk]
        best_s[mk] = (cum[k] + t * seg_len[k])[mk]
    ss = np.arange(0, cum[-1], 200.0)
    surf = np.full(len(ss), np.nan)
    for q, s in enumerate(ss):
        k = min(np.searchsorted(cum, s, side='right') - 1, len(pts) - 2)
        p = pts[k] + (pts[k + 1] - pts[k]) * ((s - cum[k]) / seg_len[k])
        i, j = (p[0] + HALF) / step, (p[1] + HALF) / step
        if 0 <= i < n - 1 and 0 <= j < n - 1:
            surf[q] = np.percentile(dem[max(0, int(j) - 2):int(j) + 3, max(0, int(i) - 2):int(i) + 3], 25)
    ok = ~np.isnan(surf)
    surf = np.minimum.accumulate(np.interp(ss, ss[ok], surf[ok]))   # water never runs uphill
    surf = np.convolve(np.pad(surf, 4, mode='edge'), np.ones(9) / 9, mode='valid')
    datum = np.interp(best_s, ss, surf)
    # Away from the river "the nearest point on it" jumps about; smooth the water level there so
    # the land doesn't get a step in it.
    far = np.clip((best_d - 250) / 750, 0, 1)
    far = far * far * (3 - 2 * far)
    datum = datum * (1 - far) + box_blur(datum, int(round(900 / step))) * far
    rel = dem - datum
    print(f'  river surface {surf.max():.1f} m (north) to {surf.min():.1f} m (south) above sea level')

    # Real water: rivers, lakes, ponds and reservoirs cut in below the water line, oversampled.
    S = 3 if step >= 20 else 2
    img = Image.new('L', (n * S, n * S), 0)
    draw = ImageDraw.Draw(img)
    px = lambda g: [((x + HALF) / step * S + S / 2, (z + HALF) / step * S + S / 2) for x, z in g.coords]
    d = water.to_pydict()
    kinds = Counter()
    river_mask = None
    for big in (False, True):   # rivers last, into their own mask as well
        if big:
            small = np.asarray(img, dtype=np.uint8).copy()
        for i in range(water.num_rows):
            sub = d['subtype'][i]
            if sub not in ('river', 'lake', 'pond', 'reservoir', 'water', 'canal') or (sub == 'river') != big or d['is_intermittent'][i]:
                continue
            g = metres(wkb.loads(d['geometry'][i]))
            for poly in getattr(g, 'geoms', [g]):
                if poly.geom_type != 'Polygon':
                    continue
                kinds[sub] += 1
                if not poly.interiors:
                    draw.polygon(px(poly.exterior), fill=1)
                    continue
                # Islands: draw the polygon with its holes on its own canvas, then merge.
                tmp = Image.new('L', img.size, 0)
                td = ImageDraw.Draw(tmp)
                td.polygon(px(poly.exterior), fill=1)
                for hole in poly.interiors:
                    td.polygon(px(hole), fill=0)
                img = Image.fromarray(np.maximum(np.asarray(img), np.asarray(tmp)))
                draw = ImageDraw.Draw(img)
    full = np.asarray(img, dtype=np.float32)
    cover = full.reshape(n, S, n, S).mean(axis=(1, 3))
    river_mask = (full - small).clip(0, 1).reshape(n, S, n, S).mean(axis=(1, 3)) >= 0.45
    wet = cover >= 0.45
    # Wide reaches the map data misses: flat lidar "ground" at river level right beside the channel.
    flat = (best_d < 450) & (rel < 0.3)
    print(f'  water cut in: {", ".join(f"{v} {k}s" for k, v in kinds.most_common())}; {int(wet.sum())} cells from the map data, {int((flat & ~wet).sum())} more from flat river-level ground')
    rel = np.where(river_mask | flat, np.minimum(rel, -3.0), np.where(wet, np.minimum(rel, -2.2), rel))

    # Roads cross water on a causeway (the game builds the bridge over the main channel itself).
    rimg = Image.new('L', (n, n), 0)
    rd = ImageDraw.Draw(rimg)
    for s in segs:
        if s['cls'] in ('track', 'service'):
            continue
        rd.line([((x + HALF) / step, (z + HALF) / step) for x, z in s['line'].coords], fill=1, width=max(2, round(30 / step)))
    on_road = np.asarray(rimg, dtype=bool)
    raised = on_road & (rel < 1.0)
    rel = np.where(raised, 1.0, rel)
    print(f'  ground {rel.min():.1f} .. {rel.max():.1f} m above the river; {int(raised.sum())} road cells raised onto causeways')

    # Version 2 packs the grid small: each value is stored as its difference from a guess made from
    # its neighbours (left + up - up-left), one byte each; the few that don't fit in a byte are -128
    # there and follow in order as int16 after all n*n bytes.
    a = np.clip(np.round(rel * 10), -32000, 32000).astype(np.int32)
    r = a.copy()
    r[1:, 1:] = a[1:, 1:] - a[1:, :-1] - a[:-1, 1:] + a[:-1, :-1]
    r[0, 1:] = a[0, 1:] - a[0, :-1]
    r[1:, 0] = a[1:, 0] - a[:-1, 0]
    r = r.ravel()
    big = np.abs(r) > 127
    raw = (struct.pack('<4sHHfff', b'DZEL', 2, n, step, -HALF, -HALF) + np.where(big, -128, r).astype(np.int8).tobytes()
           + r[big].astype('<i2').tobytes())
    os.makedirs(args.out, exist_ok=True)
    p = os.path.join(args.out, 'elevation.bin.gz')
    with gzip.GzipFile(p, 'wb', compresslevel=9, mtime=0) as fh:
        fh.write(raw)
    print(f'wrote a {n} x {n} elevation grid ({step:g} m) to {p} ({os.path.getsize(p) / 1e6:.2f} MB)')


# ------------------------------------------------------------------ land cover
WORLDCOVER = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif'
COVER_NAMES = {1: 'woods', 2: 'scrub', 3: 'grass and pasture', 4: 'farm fields', 5: 'town', 6: 'bare sand', 8: 'water', 9: 'marsh'}


def write_landcover():
    """landcover.bin.gz: 'DZLC', uint16 version=1, uint16 n, float32 step, float32 origin x, z, then
    n*n bytes, index j * n + i as in elevation.bin.gz. Each byte is the ESA WorldCover class / 10:
    1 trees, 2 shrubs, 3 grass, 4 cropland, 5 built-up, 6 bare, 8 water, 9 wetland (95 mangrove too)."""
    import tifffile
    step = args.cover_step
    n = int(round(args.size / step)) + 1
    xs = -HALF + np.arange(n) * step
    X, Zg = np.meshgrid(xs, xs)
    lon, lat = to_lonlat(X, Zg)
    lat0, lon0 = int(math.floor(lat.min() / 3) * 3), int(math.floor(lon.min() / 3) * 3)   # 3-degree tiles, named by their SW corner
    if int(math.floor(lat.max() / 3) * 3) != lat0 or int(math.floor(lon.max() / 3) * 3) != lon0:
        sys.exit('landcover: the map crosses a WorldCover tile edge (not handled)')
    tile = f'{"N" if lat0 >= 0 else "S"}{abs(lat0):02d}{"E" if lon0 >= 0 else "W"}{abs(lon0):03d}'
    url = WORLDCOVER.format(tile=tile)
    with tifffile.TiffFile(RangeFile(url, remote_size(url))) as t:
        p = t.pages[0]
        res = p.tags[33550].value[0]
        west, north = p.tags[33922].value[3], p.tags[33922].value[4]
        col, row = np.floor((lon - west) / res).astype(int), np.floor((north - lat) / res).astype(int)
        T = p.tilewidth
        across = (p.shape[1] + T - 1) // T
        out = np.zeros(X.shape, np.uint8)
        fh = t.filehandle
        for tr in range(row.min() // T, row.max() // T + 1):
            for tc in range(col.min() // T, col.max() // T + 1):
                k = tr * across + tc
                fh.seek(p.dataoffsets[k])
                data = p.decode(fh.read(p.databytecounts[k]), k)[0].reshape(T, T)
                mk = (row // T == tr) & (col // T == tc)
                out[mk] = data[row[mk] - tr * T, col[mk] - tc * T]
    cls = np.where(out == 95, 9, out // 10).astype(np.uint8)
    counts = Counter(cls.ravel().tolist())
    print('landcover: ' + ', '.join(f'{COVER_NAMES.get(c, c)} {100 * v / cls.size:.1f}%' for c, v in counts.most_common()))
    raw = struct.pack('<4sHHfff', b'DZLC', 1, n, step, -HALF, -HALF) + cls.tobytes()
    os.makedirs(args.out, exist_ok=True)
    p = os.path.join(args.out, 'landcover.bin.gz')
    with gzip.GzipFile(p, 'wb', compresslevel=9, mtime=0) as fh:
        fh.write(raw)
    print(f'wrote a {n} x {n} land cover grid ({step:g} m) to {p} ({os.path.getsize(p) / 1e6:.2f} MB)')


# ------------------------------------------------------------------ infrastructure
PLACE_KINDS = [   # (Overture place category or name pattern, kind, keep the real name?)
    (r'boat_service|boat_ramp|marina|landing$', 'landing', True), (r'fire_station', 'fire station', True),
    (r'police_station', 'sheriff', True), (r'^hospital$', 'hospital', True), (r'post_office', 'post office', False),
    (r'gas_station', 'gas station', False), (r'jail_or_prison', 'prison', True), (r'campground|rv_park', 'campground', True),
    (r'^park$', 'park', True)]


def write_infrastructure():
    """infrastructure.json: the real towers, water towers, tanks, substations, power lines (with which
    supports are steel towers and which are wooden poles), the solar farm, the railways, and a few kinds
    of public place for the map (landings, fire stations, sheriff, hospital, gas stations, parks...).
    Schools and churches are left out on purpose, and so are shop and brand names."""
    inside = lambda lat, lon: BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]
    ll = lambda x, y: [round(y, 6), round(x, 6)]
    t = fetch('infrastructure', 'theme=base/type=infrastructure', ['id', 'geometry', 'subtype', 'class', 'names'])
    d = t.to_pydict()
    geoms = [wkb.loads(g) for g in d['geometry']]
    name = lambda i: (d['names'][i] or {}).get('primary')
    out = {'source': f'Overture Maps Foundation, release {RELEASE} (OpenStreetMap). See ATTRIBUTION.md.',
           'towers': [], 'waterTowers': [], 'tanks': [], 'substations': [], 'powerLines': [], 'solar': [], 'rail': [], 'places': []}
    lon0, lat0 = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2
    m_lon, m_lat = 111320 * math.cos(math.radians(lat0)), 110540
    pts_of = lambda cls: np.array([[geoms[i].x, geoms[i].y] for i in range(t.num_rows) if d['class'][i] == cls and geoms[i].geom_type == 'Point']).reshape(-1, 2)
    pylons, poles = pts_of('power_tower'), pts_of('power_pole')
    near = (lambda P, x, y: len(P) and (np.hypot((P[:, 0] - x) * m_lon, (P[:, 1] - y) * m_lat).min() < 15))
    for i in range(t.num_rows):
        g, cls = geoms[i], d['class'][i]
        c = g.centroid
        if cls in ('mobile_phone_tower', 'communication_tower') and inside(c.y, c.x):
            out['towers'].append(ll(c.x, c.y) + ['radio' if cls == 'communication_tower' else 'cell'])
        elif cls == 'water_tower' and inside(c.y, c.x):
            out['waterTowers'].append(ll(c.x, c.y))
        elif cls == 'storage_tank' and inside(c.y, c.x):
            out['tanks'].append(ll(c.x, c.y) + [round(max(8.0, min(30.0, 2 * math.sqrt(max(g.area * m_lon * m_lat, 1) / math.pi))), 1)])
        elif cls == 'substation' and inside(c.y, c.x) and g.geom_type.endswith('Polygon'):
            f = footprint(g, lon0, lat0, m_lon, m_lat)
            if f:
                out['substations'].append(ll(c.x, c.y) + [round(max(12, f[1]), 1), round(max(10, f[2]), 1), round(f[0], 1)])
        elif cls == 'plant' and g.geom_type.endswith('Polygon'):
            for poly in getattr(g, 'geoms', [g]):
                poly = poly.intersection(shp_box(*BBOX))
                for q in getattr(poly, 'geoms', [poly]):
                    if q.geom_type == 'Polygon' and q.area * m_lon * m_lat > 5000:
                        out['solar'].append([ll(x, y) for x, y in q.exterior.coords])
        elif cls in ('power_line', 'minor_line') and g.geom_type == 'LineString':
            cs = list(g.coords)
            kinds = ['pylon' if near(pylons, x, y) else 'pole' if near(poles, x, y) else None for x, y in cs]
            known = [k for k in kinds if k]
            default = max(set(known), key=known.count) if known else ('pylon' if g.length * m_lon > 3000 else 'pole')
            run = []
            for (x, y), k in zip(cs, kinds):
                if inside(y, x):
                    run.append(ll(x, y) + [k or default])
                elif run:
                    if len(run) > 1: out['powerLines'].append(run)
                    run = []
            if len(run) > 1:
                out['powerLines'].append(run)
        elif cls in ('viewpoint', 'camp_site') and name(i) and inside(c.y, c.x):
            out['places'].append(ll(c.x, c.y) + ['overlook' if cls == 'viewpoint' else 'campground', name(i)])
    # Railways (in the transportation theme alongside the roads).
    r = fetch('roads', 'theme=transportation/type=segment', ['id', 'geometry', 'subtype', 'class', 'subclass', 'names', 'routes', 'connectors', 'road_surface']).to_pydict()
    for i in range(len(r['id'])):
        if r['subtype'][i] != 'rail':
            continue
        g = wkb.loads(r['geometry'][i]).intersection(shp_box(*BBOX))
        for part in getattr(g, 'geoms', [g]):
            if part.geom_type == 'LineString' and part.length * m_lon > 20:
                out['rail'].append({'name': (r['names'][i] or {}).get('primary'), 'narrow': r['class'][i] == 'narrow_gauge', 'pts': [ll(x, y) for x, y in part.coords]})
    # Public places, for the map.
    pl = fetch('places', 'theme=places/type=place', ['id', 'geometry', 'names', 'basic_category', 'taxonomy', 'confidence']).to_pydict()
    for i in range(len(pl['id'])):
        cat = (pl['taxonomy'][i] or {}).get('primary') or pl['basic_category'][i] or ''
        nm = (pl['names'][i] or {}).get('primary') or ''
        for pat, kind, keep in PLACE_KINDS:
            if re.search(pat, cat) or (kind == 'landing' and re.search(r'(boat )?landing$', nm, re.I) and 'RV' not in nm):
                if kind == 'hospital' and 'Hospital' not in nm:
                    break
                g = wkb.loads(pl['geometry'][i])
                if not inside(g.y, g.x):
                    break
                label = nm if keep else kind.capitalize()
                if 'Business Office' in nm or any(q[2] == kind and ((keep and q[3] == label) or (abs(q[0] - g.y) < 0.0007 and abs(q[1] - g.x) < 0.0007)) for q in out['places']):
                    break
                out['places'].append(ll(g.x, g.y) + [kind, label])
                break
    os.makedirs(args.out, exist_ok=True)
    p = os.path.join(args.out, 'infrastructure.json')
    with open(p, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
    print('infrastructure: ' + ', '.join(f'{len(v)} {k}' for k, v in out.items() if isinstance(v, list)) + f'; {sum(len(l) for l in out["powerLines"])} line supports')
    print(f'wrote {p} ({os.path.getsize(p) / 1e3:.0f} KB)')


# ------------------------------------------------------------------ output
def write_json(name, rows):
    os.makedirs(args.out, exist_ok=True)
    p = os.path.join(args.out, name)
    with open(p, 'w') as fh:
        json.dump({'source': f'Overture Maps Foundation, release {RELEASE}. See ATTRIBUTION.md.', 'rows': rows}, fh, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {len(rows)} rows to {p} ({os.path.getsize(p) / 1e6:.2f} MB)')


ATTRIBUTION = """# Where this map data comes from

Made by `tools/import_real_world.py` from open data. Keep this file with the data.

| File | What | Source and licence |
|---|---|---|
| `structures.json` | Building footprints, heights and landmark names | Overture Maps Foundation, release {release}. Footprints from **Microsoft ML Building Footprints** (CDLA Permissive 2.0) and **OpenStreetMap** contributors (ODbL 1.0). |
| `roads.json` | Roads, their names and route numbers | Overture Maps Foundation, release {release}; road data **© OpenStreetMap contributors** (ODbL 1.0). |
| `landcover.bin.gz` | What covers the ground: woods, fields, pasture, town, marsh | **ESA WorldCover 10 m 2021 v200** © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0). |
| `infrastructure.json` | Towers, water towers, substations, power lines, the solar farm, railways, landings and public places | Overture Maps Foundation, release {release}: infrastructure and transportation **© OpenStreetMap contributors** (ODbL 1.0); places from Overture's places data (CDLA Permissive 2.0). |
| `elevation.bin.gz` | Ground elevation, with rivers, lakes and ponds cut in | **USGS 3D Elevation Program** 1 m lidar DEM, FL Hurricane Michael 2020 survey (public domain); **AWS Terrain Tiles** (USGS 3DEP 1/3 arc-second) where the lidar has no value. Water outlines **© OpenStreetMap contributors** (ODbL 1.0) via Overture. |

The river's course and the highway lines in `shared/data/map-bristol.json` also come from
OpenStreetMap via Overture.

OpenStreetMap data is open under the Open Database Licence: https://www.openstreetmap.org/copyright
Overture Maps: https://overturemaps.org · USGS 3DEP: https://www.usgs.gov/3d-elevation-program · ESA WorldCover: https://esa-worldcover.org · Terrain tiles: https://registry.opendata.aws/terrain-tiles/

Shop and brand names are left out of the building names on purpose. Everything the game does with
these places is fiction.
"""

RELEASE = args.release or latest_release()
print(f'Overture release {RELEASE}; map {args.size / 1000:g} km, lon {BBOX[0]:.4f}..{BBOX[2]:.4f}, lat {BBOX[1]:.4f}..{BBOX[3]:.4f}')
water = load_water() if ONLY & {'rivers', 'elevation'} else None
segs = load_roads() if ONLY & {'highways', 'roads', 'elevation'} else None
if 'rivers' in ONLY:
    update_river(water)
if 'highways' in ONLY:
    print('highways:')
    snap_highways(segs)
if 'buildings' in ONLY:
    write_buildings()
if 'roads' in ONLY:
    write_roads(segs)
if 'elevation' in ONLY:
    write_elevation(water, segs)
if 'landcover' in ONLY:
    write_landcover()
if 'infrastructure' in ONLY:
    write_infrastructure()
os.makedirs(args.out, exist_ok=True)
with open(os.path.join(args.out, 'ATTRIBUTION.md'), 'w') as fh:
    fh.write(ATTRIBUTION.format(release=RELEASE))
print('done')
