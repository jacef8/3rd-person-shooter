# Where this map data comes from

Made by `tools/import_real_world.py` from open data. Keep this file with the data.

| File | What | Source and licence |
|---|---|---|
| `structures.json` | Building footprints, heights and landmark names | Overture Maps Foundation, release 2026-10-21.0. Footprints from **Microsoft ML Building Footprints** (CDLA Permissive 2.0) and **OpenStreetMap** contributors (ODbL 1.0). |
| `roads.json` | Roads, their names and route numbers | Overture Maps Foundation, release 2026-10-21.0; road data **© OpenStreetMap contributors** (ODbL 1.0). |
| `elevation.bin.gz` | Ground elevation, with rivers, lakes and ponds cut in | **AWS Terrain Tiles** (Mapzen terrarium tiles); in the US from **USGS 3D Elevation Program** data (public domain). Water outlines **© OpenStreetMap contributors** (ODbL 1.0) via Overture. |

The river's course and the highway lines in `shared/data/map-bristol.json` also come from
OpenStreetMap via Overture.

OpenStreetMap data is open under the Open Database Licence: https://www.openstreetmap.org/copyright
Overture Maps: https://overturemaps.org · Terrain tiles: https://registry.opendata.aws/terrain-tiles/

Shop and brand names are left out of the building names on purpose. Everything the game does with
these places is fiction.
