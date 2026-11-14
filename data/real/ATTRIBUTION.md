# Where this map data comes from

Made by `tools/import_real_world.py` from open data. Keep this file with the data.

| File | What | Source and licence |
|---|---|---|
| `structures.json` | Building footprints, heights and landmark names | Overture Maps Foundation, release 2026-10-21.0. Footprints from **Microsoft ML Building Footprints** (CDLA Permissive 2.0) and **OpenStreetMap** contributors (ODbL 1.0). |
| `roads.json` | Roads, their names and route numbers | Overture Maps Foundation, release 2026-10-21.0; road data **© OpenStreetMap contributors** (ODbL 1.0). |
| `elevation.bin.gz` | Ground elevation, with rivers, lakes and ponds cut in | **USGS 3D Elevation Program** 1 m lidar DEM, FL Hurricane Michael 2020 survey (public domain); **AWS Terrain Tiles** (USGS 3DEP 1/3 arc-second) where the lidar has no value. Water outlines **© OpenStreetMap contributors** (ODbL 1.0) via Overture. |

The river's course and the highway lines in `shared/data/map-bristol.json` also come from
OpenStreetMap via Overture.

OpenStreetMap data is open under the Open Database Licence: https://www.openstreetmap.org/copyright
Overture Maps: https://overturemaps.org · USGS 3DEP: https://www.usgs.gov/3d-elevation-program · Terrain tiles: https://registry.opendata.aws/terrain-tiles/

Shop and brand names are left out of the building names on purpose. Everything the game does with
these places is fiction.
