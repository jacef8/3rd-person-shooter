# Deadzone (working title)

A prototype **third-person shooter** set in one **persistent, always-PvP 18.6 × 18.6 mile open world**
laid out on the real area around **Bristol, Florida** at **real 1:1 scale**: Bristol, Blountstown,
Hosford, Telogia, Estiffanulga and Lake Mystic, the Apalachicola River, the real highways and the SR 20
bridge, the Torreya bluffs and the Apalachicola National Forest. It is built from open data: **real
ground elevation, the real river, every real road by name and every real building as a place you can
walk into** (see "The real-world map" below). Stash houses are **claimed with a claim
marker** (a room, house, cave, vehicle or open ground) and **level up**, and there's **DayZ-style base building**.

- **Level-based progression, not random drops.** You earn XP by playing: time alive in the zone,
  kills (players are worth more, especially high-level ones), breaching stash houses, building gear.
  Levels 1–30 unlock weapon platforms, attachments, armor and paints on a fixed schedule. There are no
  random stat rolls anywhere.
- **Gunsmith.** At the bench in your stash house you can change ten things on any gun you own: sight,
  muzzle, barrel, forearm, underbarrel, magazine, ammunition, stock, trigger and skin. Every slot has
  at least three real choices on every long gun, and each says who it is for. It has a live 3D preview
  with an exploded view, and highlighting an option shows how each stat bar would change. Parts are
  trade-offs, not upgrades: a suppressor hides your tracers but costs damage and range; a drum mag
  doubles capacity but slows reloads, handling and movement.
  - **13 sights**, from night sights to a 12x scope. Two flip between magnifications while you aim.
    The **spotter scope** tags whoever you aim at for your crew and reads the range. The **thermal
    sight** makes people and animals glow and sees through optical camo. The **12x** lens flashes
    when you aim, so the target gets a warning.
  - **Ammunition:** hollow points hit harder on Rogues and animals and poorly on armor;
    armor-piercing cracks players' plates; subsonic with a suppressor gives nothing away.
- **Parts** are the one resource. You find them as fixed caches in the world, take them from Rogues,
  or steal them from stashes. You spend them to build new guns and armor from the blueprints you've
  unlocked. Swapping attachments is free. Guns are physical items, so you can lose them, loot them
  and stash them. Your level and unlocks can never be taken from you.
- **Tech and hacking, Future Soldier-style.** Stun an enemy (stun grenade, or a takedown from
  behind), then **data-hack** them: their whole crew lights up for your crew through walls and on
  the map, and you learn where their stash house is. Hacking a terminal scans the area for enemies.
  Also: tag targets (F), sensor grenades (G), optical camo (V), and silent lock bypass.
- **A living world.** World events (riots, a county fair, hog hunts, armed convoys, market swings)
  pull players across the map. Travelling merchants and farm and fish-camp settlers trade even when few
  players are on. There's freight hauling, market stalls that sell while you're offline, and
  face-to-face trades. Tripwires, motion alarms, sentry guns and guard dogs protect your place while
  you're away, and an away log tells you what happened.
- **The river.** Buy or build a jon boat or an airboat at a river landing and run the Apalachicola:
  river freight between landings, swamp camps reachable only by water, where you can trade tupelo
  honey, moonshine and gator hides, and boats that can be hotwired or sunk. See `docs/STORY.md` for how
  the county ended up like this.
- **Crews: a team game.** Permanent crews of up to 6 (leader, officers, members) that survive
  logging off. They share one stash house, revive each other when downed, hack faster together
  (while the hacker shows up to enemies nearby), split contract rewards and climb a crew board.
  There's no friendly fire, and tags and sensor reveals are shared. The leader sets the crew objective
  with a ping and can Rally the crew. See [docs/DESIGN.md](docs/DESIGN.md#crews-playing-as-a-team-division-style).
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
- **Living off the land:** hunger, farm plots with crops that grow in real time (and can be stolen),
  fishing, hunting deer and hogs, campfire cooking, and cash with a **trading post at every Contact**
  whose prices depend on the town, so hauling goods across the map pays. One shared world that never resets.
- **Units:** distances, ranges and radii are shown in feet and miles.
- **Enterable buildings:** town buildings, houses, warehouses, farmhouses, barns and ranger stations
  have doorways, a ceiling and loot inside. Bigger ones have an interior wall, so you can fight room
  to room. Only the ground floor is open for now; upper storeys are solid. **Any of them can be
  claimed** as a stash house: plant a marker inside for a stash locker and lockable doors.
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

## Play the test build

**https://deadzone-server-production-c9ff7400.up.railway.app** (hosted on Railway; redeploys on every push to this branch). Works on phones with a controller. See [docs/TESTING.md](docs/TESTING.md) for what to try.

## Game rules are data

Every number and table (weapons, gunsmith parts, levels, XP, gadgets, stash upgrades, home levels,
building, contracts, loot, extraction, combat and AI tuning, and the real Bristol map) is in
`shared/data/*.json`. Edit those to rebalance the game; see [shared/data/README.md](shared/data/README.md).
They're engine-neutral so they carry over to the planned move to Unreal Engine 5.

## Run it

```bash
npm install
npm start            # http://localhost:8080  (lobby + 2 worlds)
```

Open the URL in several browser tabs (or on several machines on your network) to play against
each other. Options are environment variables: `PORT`, `SEED` (map), `WORLD_SIZE` (metres, default 30000; smaller maps crop the same 1:1 layout around Bristol),
`BOTS` (roaming rogues kept around each player, default 5), `SUPPLY_EVERY_MS` (supply drop
interval), `EXTRACT_HOLD_MS` (how long to hold an extraction, default 90000), `DATA_FILE` (where world 1 is saved; default `data/world.json`; other worlds and the lobby's accounts sit next to it), `WORLDS` (how many worlds the lobby runs, default 2), `WORLD_CAP` (players per world, default 40). `npm run start:world` runs a single world without the lobby.

## The real-world map

The world is built from open data for the real place, in `data/real/` (about 1.8 MB, in the repo):

- **Ground:** real elevation on a 30 m grid (USGS 3D Elevation Program data, via the open AWS Terrain
  Tiles). Bristol sits on the high east bank about 130 ft above the river; Blountstown is down on the
  floodplain; the Torreya bluffs rise about 150 ft straight off the water.
- **Water:** the Apalachicola follows its real course, with its real width, islands and side channels,
  and 335 real lakes, ponds and reservoirs are cut in (OpenStreetMap, via Overture Maps).
- **Roads:** every real road, 2,129 stretches of them. 1,234 carry a real name or route number
  (496 different names: Church Street, Pea Ridge Road, SR 20…). The rest are service roads and forest
  tracks, which have no names in real life either; unpaved ones are drawn as dirt. The five state
  highways (SR 20, 12, 65, 69, 71) follow their real lines, and SR 20 crosses the river on a bridge where
  the real one stands. The road you're on shows under the minimap, and the map labels roads when you zoom in.
- **Buildings:** every real building footprint, about 7,400 placed (Microsoft's open building
  footprints and OpenStreetMap, via Overture). Each is a building you can walk into, at its real size
  and position on a level pad cut into the real ground: houses with siding and pitched roofs, barns,
  warehouses, shops, and brick civic buildings. 26 landmarks keep their real names (Liberty County
  Courthouse, Bristol City Hall, the libraries, churches, the Apalachicola Ranger Station). Shop and
  brand names are left out on purpose. Any of them can be claimed as a stash house.
- **Towns:** the game's own part of each town is now just the Authority's compound (the Contact, a
  couple of quarters, terminals, barricades), set on the emptiest ground near the real centre.
- **No fog:** you see to the horizon. The whole county's ground is drawn in the distance, with
  simple stand-ins for buildings and trees out to about a mile.

Limits: walls run north-south and east-west only, so a building turned more than 25° off that
becomes a square of the same floor area. Buildings have real heights where the data has them
(about 4 in 10) and a sensible guess otherwise.

To refresh the data (a new Overture release, or a different map size):

```bash
pip install pyarrow shapely numpy pillow
python3 tools/import_real_world.py        # reads only the parts of the open datasets that cover the map
```

Sources and licences are in `data/real/ATTRIBUTION.md` (OpenStreetMap is ODbL: keep the credit).
Set `REAL_DATA=0` to run on the old generated stand-in world (the automated tests do).
The save file is tied to the map, so new data starts a fresh world.

**Controls:** WASD move · Shift sprint · C crouch (makes low walls and cars real cover) · mouse aim ·
LMB fire · RMB aim down sights · E interact (loot, bags, stash, doors) · R reload · Q swap weapon ·
H medkit · Tab inventory · F tag · G throw grenade (Z switches sensor/stun) · V optical camo · T rally (squad leader) ·
B crew ping · P crew panel and leaderboards · M map · X build mode (1-5 piece, R rotate, click
place, E upgrade, Q dismantle). Controller layout below. Open your stash (E at the orange crate in your house) → **Open Gunsmith**.

## Built for a controller (Backbone One or any gamepad)

The controller is the main way to play; keyboard and mouse, and touch, also work. Controllers come
through the browser's standard gamepad layout, which is how a Backbone One shows up on iPhone
(Safari) and Android (Chrome). **Everything can be done from the controller alone:**

- **Typing** (callsign, crew name, finding a friend): Ⓐ on a text box opens an on-screen keyboard.
  Ⓧ deletes, Ⓨ is space, ☰ is done, Ⓑ cancels.
- **Numbers and pick-lists** (stall prices, trade amounts): ◀ ▶ change them, hold LB or RB for tens.
- **The map:** left stick or D-pad picks from the list, right stick slides the map, LT/RT zoom.
- **Boats:** left stick is throttle and steering.
- **Sights with two magnifications:** R3 while aiming flips between them.
- **Invites and trade requests** (the bar at the top of the screen): hold ⧉ to say yes. It goes
  away by itself if you ignore it.
- **Look speed and inverted look:** in the crew panel (hold ☰), under Controller.
- **Menus keep your place.** Every screen opens with its first choice highlighted, and the highlight
  stays where you put it when a screen refreshes itself.
- Prompts and hints name the controller's buttons once you press one.

On phones the game also uses a lighter graphics setting and a smaller HUD for landscape.

| Control | Gameplay | Menus |
| --- | --- | --- |
| Left stick | Move (analog: tilt less to walk slower) | Move highlight |
| Right stick | Look (slows down slightly over enemies, and while aiming) | Scroll |
| L3 (click left stick) | Sprint (toggle) | |
| RT / LT | Fire / aim down sights | |
| A | Interact: loot, doors, stash, hack terminals | Select |
| B | Crouch | Back |
| X / Y | Reload / swap weapon | Y: gunsmith exploded view |
| RB / LB | Tag target / throw grenade (hold LB to switch sensor/stun) | |
| R3 (click right stick) | Optical camo; while aiming, flip a two-range sight | |
| D-pad ▲ ▼ ◀ ▶ | Medkit · squad ping · Rally (leader) · build mode | Move highlight |
| View (⧉) / Menu (☰) | Inventory (a boat's hold when aboard); **hold ⧉** to accept an invite or trade request / map; **hold ☰** for the crew panel | Map: LT/RT zoom, right stick slides it; ☰ = done on the keyboard |

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

**Controller check.** `tools/controller-check.mjs` plays the game in a real browser with a simulated
controller and nothing else: it types a callsign on the on-screen keyboard, searches for a friend,
deploys, founds a crew, shops, and accepts a trade request. It needs Playwright with Chromium, which
is not a dependency of the game; how to run it is at the top of the file.

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
