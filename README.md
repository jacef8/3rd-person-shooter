# Deadzone (working title)

A prototype **third-person shooter** set in one **persistent, always-PvP 18.6 × 18.6 mile open world**
laid out on the real area around **Bristol, Florida** at **real 1:1 scale**: Bristol, Blountstown,
Hosford, Telogia, Estiffanulga and Lake Mystic, the Apalachicola River, the real highways and the SR 20
bridge, the Torreya bluffs and the Apalachicola National Forest. Real buildings and roads can be
imported so **every real structure becomes a map object** (see below). Stash houses are **claimed with a claim
marker** (a room, house, cave, vehicle or open ground) and **level up**, and there's **DayZ-style base building**.

- **Level-based progression, not random drops.** You earn XP by playing: time alive in the zone,
  kills (players are worth more, especially high-level ones), breaching stash houses, building gear.
  Levels 1–30 unlock weapon platforms, attachments, armor and paints on a fixed schedule. There are no
  random stat rolls anywhere.
- **Gunsmith.** At the bench in your stash house you can swap optic, muzzle, barrel, underbarrel,
  magazine, stock, trigger and paint on any gun you own. It has a live 3D preview with an exploded
  view, and hovering an option shows how each stat bar would change. Parts are trade-offs, not
  upgrades: a suppressor hides your tracers but costs damage and range; a drum mag doubles capacity
  but slows reloads, handling and movement; a 4x scope zooms in but slows how fast you aim. Builds
  change real gameplay: zoom, recoil, spread, ADS speed and movement speed.
- **Parts** are the one resource. You find them as fixed caches in the world, take them from Rogues,
  or steal them from stashes. You spend them to build new guns and armor from the blueprints you've
  unlocked. Swapping attachments is free. Guns are physical items, so you can lose them, loot them
  and stash them. Your level and unlocks can never be taken from you.
- **Tech, Future Soldier-style.** Tag targets for your squad (F), sensor grenades that reveal
  everyone nearby, cloaked players included (G), optical camo (V), hack data terminals for intel and tech
  (E), and at higher levels hack enemy stash locks silently.
- **Squads and leadership, Division-style.** Squads of up to 4 with no friendly fire, shared tags and
  sensor reveals, shared XP and shared stash access. The leader sets the squad objective with a ping
  and can Rally the squad. A server leaderboard ranks everyone (P).
- **What loot is for:** parts build guns and armor, tech powers gadgets, and intel is XP, but only
  once you get it home to your stash. See [docs/DESIGN.md](docs/DESIGN.md) for the full loop.
- Combat: headshots, damage falloff, armor that regenerates out of combat, crouch behind cover.
- **Open world:** about 40 towns joined by roads, with farms, forests and wrecks between them.
  Contacts in every town hand out contracts, supply drops land every ~10 minutes, and salvage out in
  the map pays for **stash house upgrades** (door, storage, alarm, generator, infirmary, workbench).
  You deploy by picking your stash house on the map; after a death you redeploy at home, at a
  discovered Contact, or at a landing zone. Fast travel only goes out from home. See
  [docs/DESIGN.md](docs/DESIGN.md).
- **Helicopter extraction** gets loot home without the long walk. At any Contact (its panel) or
  landing zone (press E on the yellow helipad), fire a red flare and hold within 80 ft of it for 90
  seconds. The helicopter then flies you, any squadmates in the zone and everything you carry to your stash
  houses. Everyone within half a mile is alerted and can try to stop you. Leaving the zone or going down aborts it,
  and the pilot then needs 5 minutes before the next call.
- **Units:** distances, ranges and radii are shown in feet and miles.
- **Building:** chop trees (hatchet) and mine rocks (pickaxe) for wood and stone, then place
  frames and upgrade them into wooden or stone walls, gates, barricades and stash crates, anywhere
  in the wild. Raid other bases with hatchets, pickaxes, gate hacks or breach charges.
- Open-world rules: no safe zones, no instancing. When you die, everything you carried drops in a bag
  anyone can loot. When you log off, your character stays where you stood.
- **Stash houses are part of the live world.** Each player is given a walled stash house with a crate.
  Its door can be shot down by anyone, at any time, **including while you're offline**. Once it's
  breached, anyone can walk in and empty your stash. Owners get alerts while online, must rebuild a
  breached door by hand, and an intact door slowly repairs itself.
- AI "Rogues" patrol the city, fight anyone they see, and drop parts, tech, intel and ammo.

## Run it

```bash
npm install
npm start            # http://localhost:8080
```

Open the URL in several browser tabs (or on several machines on your network) to play against
each other. Options are environment variables: `PORT`, `SEED` (map), `WORLD_SIZE` (metres, default 30000; smaller maps crop the same 1:1 layout around Bristol),
`BOTS` (roaming rogues kept around each player, default 5), `SUPPLY_EVERY_MS` (supply drop
interval), `EXTRACT_HOLD_MS` (how long to hold an extraction, default 90000), `DATA_FILE` (where the world is saved; default `data/world.json`).

## Real buildings and roads (parked for now)

This is on hold; the game currently uses the procedural stand-in buildings. The importer is kept for later.

`tools/import-real-data.mjs` downloads the real building footprints and roads for the map area
into `data/real/`. The server loads them at start-up and sends them to every client, so each real
building becomes a solid map object you can take cover behind, and each road is drawn in the world and on the
map. Without the files the map uses procedural stand-in buildings.

```bash
node tools/import-real-data.mjs              # needs access to services2.arcgis.com and overpass-api.de
npm start                                    # picks up data/real/ automatically
```

- **Buildings:** FEMA / Oak Ridge National Laboratory **USA Structures**, roughly 15,000 in Liberty and
  Calhoun counties. Each footprint becomes a box of its real size, at its real position. Height comes
  from the data, or from the occupancy class when the data has none. Agricultural buildings become barns and industrial ones warehouses.
  Collision is axis-aligned, so a footprint turned well off north-south becomes a square of the same area.
- **Roads:** OpenStreetMap, every drivable road and forest track (footpaths are skipped).
- Credits: *USA Structures, FEMA Response Geospatial Office / Oak Ridge National Laboratory
  (CC BY 4.0)*; *road data © OpenStreetMap contributors (ODbL 1.0)*.
- Set `REAL_DATA=0` to ignore the files, `REAL_DATA_DIR` to read them from elsewhere. Saves are tied to the
  map, so changing the data means starting a fresh `DATA_FILE`.

**Controls:** WASD move · Shift sprint · C crouch (makes low walls and cars real cover) · mouse aim ·
LMB fire · RMB aim down sights · E interact (loot, bags, stash, doors) · R reload · Q swap weapon ·
H medkit · Tab inventory · F tag · G sensor grenade · V optical camo · T rally (squad leader) ·
B squad ping · P squad panel and leaderboard · M map · X build mode (1-5 piece, R rotate, click
place, E upgrade, Q dismantle). Controller layout below. Open your stash (E at the orange crate in your house) → **Open Gunsmith**.

## Playing on a phone with a Backbone One (or any controller)

The game supports controllers through the browser's standard gamepad layout. That's how a
Backbone One shows up on iPhone (Safari) and Android (Chrome). Every screen works from the
controller: login, gameplay, inventory, stash, gunsmith (highlighting an attachment previews it),
squad panel and the death screen. On phones the game also uses a lighter graphics setting and a
smaller HUD for landscape.

| Control | Gameplay | Menus |
| --- | --- | --- |
| Left stick | Move (analog: tilt less to walk slower) | Move highlight |
| Right stick | Look (slows down slightly over enemies, and while aiming) | Scroll |
| L3 (click left stick) | Sprint (toggle) | |
| RT / LT | Fire / aim down sights | |
| A | Interact: loot, doors, stash, hack terminals | Select |
| B | Crouch | Back |
| X / Y | Reload / swap weapon | Y: gunsmith exploded view |
| RB / LB | Tag target / sensor grenade | |
| R3 (click right stick) | Optical camo | |
| D-pad ▲ ▼ ◀ ▶ | Medkit · squad ping · Rally (leader) · build mode | Move highlight |
| View (⧉) / Menu (☰) | Inventory (squad panel button inside) / map | Map: LT/RT zoom |

In build mode: LB/RB pick a piece, X rotates, RT places, A upgrades, Y dismantles, ▶ exits.

On-screen prompts switch to controller buttons as soon as you use the controller.

**Phones need HTTPS.** Browsers only let web pages read controllers on secure (HTTPS) pages, and
`localhost` counts as secure. A phone opening `http://192.168.x.x:8080` won't see the controller.
Choose one:

- **Host it** anywhere that gives you an HTTPS URL. A real online game needs this anyway.
- **Local Wi-Fi testing** with a self-signed certificate:
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout data/key.pem -out data/cert.pem -days 365 -subj "/CN=deadzone.local"
  TLS_CERT=data/cert.pem TLS_KEY=data/key.pem npm start
  ```
  On the phone, open `https://<your-computer's-LAN-IP>:8080` and accept the certificate warning.
  (Safari: Show Details → visit this website.)

Then press any button on the controller; browsers only expose a controller after a button press.
For full screen on iPhone, use Share → **Add to Home Screen** and launch it from there.

## Tests

```bash
npm test
```

Includes unit tests for the level curve, unlock schedule and attachment stat math, plus end-to-end
tests that boot the server and check that the gunsmith enforces level and parts requirements and only
works at your own stash. Another end-to-end test boots the server, has one player shoot down another player's stash
house door, walk in, take an item, shoot the owner, then restarts the server and checks the stash,
door state and loot all persisted.

## Architecture

```
client/   Browser client (Three.js): rendering, input, local movement prediction, HUD, inventory
server/   Authoritative Node.js game server (HTTP + WebSocket), simulation, bots, persistence
shared/   Code both sides run: map generation, collision, ray casts, arsenal, gunsmith parts,
          level curve and unlock schedule
```

"Live all the time" means the world has to exist when nobody who owns it is online, so this uses
**dedicated authoritative servers**, not pure peer-to-peer. A peer-to-peer host's world disappears
when the host leaves, and a peer can't be trusted with loot or stash contents (cheating). Every move,
shot, hit, pickup and stash transfer here is validated server-side: movement is speed-clamped and
swept through collision so players can't pass through stash walls, fire rate and ammo are checked, and
hits are traced on the server.

## Scaling this into a real game

This is a playable vertical slice meant to prove the design. The likely next steps are:

1. **Engine:** move the client to Unreal or Unity for animation, real cover-snapping and production art.
   The server-authoritative design carries over (e.g. Unreal dedicated server, or Unity + Netcode/Mirror).
2. **Netcode:** send inputs instead of positions, add server-side lag compensation for hit
   registration and snapshot delta compression.
3. **Persistence:** swap the JSON file for a database (Postgres/Redis) so a cluster of server shards
   can share characters and stashes.
4. **Raid design:** decide on raid-protection rules (e.g. breach tools, raid windows, offline
   protection that ramps up) so offline raiding feels fair, not just punishing.
5. **Progression depth:** per-weapon XP and challenges for unlocking parts, prestige, and more
   platforms and attachments.
6. **Content:** missions/landmarks, a dark-zone-style extraction loop, and more.
