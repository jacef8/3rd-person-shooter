# Deadzone — progression and loot design

The core rule: **your level is your progression, and loot is fuel.** Levelling (like Future
Soldier) decides *what you can use*. Loot decides *how much of it you can afford to field right
now*, and you can lose it, so every trip out of your stash house is a risk.

There are no random stat rolls anywhere. A gun's strength comes from its platform plus the
attachments you chose in the gunsmith, and both are unlocked by level.

## The world: Bristol, Florida at real 1:1 scale

The map is the real area around **Bristol, Florida** (Liberty County) at **real scale**: one game
metre is one real metre. It is 18.6 × 18.6 miles (30 km), centred 3.1 miles east and 0.9 miles north of Bristol so it takes
in the real places around it. Positions come from real latitude/longitude (Wikipedia/GNIS) and are
converted in `shared/geography.js`. Real distances hold: Bristol to Blountstown is 4.1 miles, Bristol to Hosford 11 miles.

- **Towns:** Bristol, Blountstown (Calhoun), Hosford, Telogia, Estiffanulga, Lake Mystic, sized by
  population. Small towns are mostly single-storey houses in yards. Waterfront towns are nudged just onto dry ground.
- **The Apalachicola River:** a real ~460 ft wide channel with a floodplain swamp up to ~1.2 miles wide,
  too deep to wade. The **SR 20 bridge** between Blountstown and Bristol is the only dry crossing,
  so it's the map's big chokepoint.
- **Highways:** SR 20, SR 12, SR 65, SR 71, SR 69 and SR 267 on their real routes.
- **Terrain:** the steep **Torreya bluffs** on the east bank north of Bristol (Torreya State Park),
  the sandhills of the **Apalachicola Bluffs & Ravines Preserve**, pine plantations and the
  **Apalachicola National Forest** flatwoods toward Hosford and Telogia, and farmland around Blountstown.
- **Countryside detail:** trees, rocks and scrub aren't stored. At real scale there are hundreds of thousands of them, so
  each 128 m tile generates its own the first time anything (collision, a shot, the renderer) looks at
  it. They come from a seed per tile, so the server and every client get the same trees in any order.
- **Real buildings and roads** (optional): `tools/import-real-data.mjs` fetches FEMA/ORNL USA
  Structures footprints and OpenStreetMap roads. With them, every real structure is a map object and the procedural
  stand-ins (town blocks, farms, roadside homesteads) are left out. See the README.
- Outside this 18.6-mile square, the earlier layout's towns (Chattahoochee, Quincy, Marianna,
  Wewahitchka…), the Chipola, Ochlockonee, Lake Seminole and Lake Talquin are still defined in
  `geography.js`. A bigger `WORLD_SIZE` would bring them in, but it would also need more of the real data.

There are no real mountains or deserts here. The game's "hills" are the Torreya bluffs (exaggerated a little) and the sandy terrain is sandhill scrub.
Not real yet: **elevation** is shaped by hand plus noise, not taken from a real elevation model (USGS 3DEP would be the next import).

## Stash houses: claiming and home levels

**Claiming.** No home is assigned to you. You make a place yours by **planting a claim marker**
in it. That's an 8-second action, and moving or taking fire interrupts it. You can claim:

| Claimable | Where |
| --- | --- |
| Town house / apartment room | Every town (rooms are ground-floor units inside larger buildings) |
| Limestone cave | Torreya bluffs, Red Hills, Marianna karst |
| Rock outcrop | Hills and sandhills |
| Hollow cypress | Forest and river swamps |
| Fish camp | River and lake banks, with a jetty |
| **Abandoned vehicle**: RV, school bus, box truck, houseboat | Along the highways; houseboats moored on the rivers |
| **Any enterable building** | Every town building, house, warehouse, farmhouse, barn and ranger station (~2,200). Planting the marker inside puts a **stash locker** in the room and fits a **lockable door** in every doorway. It works like a claim flag, and its doors can be shot, hacked, chopped or blown like gates. Loot inside stops restocking once it's someone's home. |
| **Open ground**: claim flag | Anywhere you can build. Place the marker as a flag (build mode, piece 6), and the flag holds your stash |

- New characters start with one marker. More are crafted (10 wood, 10 salvage), found in town
  and farm loot, or bought from any Contact (40 parts).
- One stash house at a time. You can **abandon** it from its stash menu, and anything left inside is
  then free for anyone. Claiming a place someone abandoned gets you whatever they left.
- **Vehicles are locked.** Others can't reach the stash until the lock is shot off, hacked or blown.
  Vehicle locks are a bit weaker than house doors.
- **Claim flags** can be destroyed (chopped, shot, blown up). Destroying one ends that claim and
  spills its stash.

**Home levels (1–10).** Your stash house earns home XP from:

| Source | Home XP |
| --- | --- |
| Installing upgrades | 1 per material spent |
| Building or upgrading structures inside your claim radius | 10 each |
| Uploading intel at home | 20 per drive |
| Just holding it | 60 per hour |

Each level adds stash slots (+4/level), door/lock/flag strength (+12%/level), claim radius
(20 m → 65 m) and build allowance (40 → 130 structures). Higher **upgrade tiers need home
levels**: steel door and alarm at 2, generator and workbench at 3, blast door at 4, 50 m alarm at 5,
60-slot storage and 30/h generator at 6, vault door at 7, 60/h generator at 9.

## Building (DayZ-style)

1. **Tools** (carried, lost on death): **hammer** (place and upgrade), **hatchet** (chop trees →
   wood, and chop wooden walls), **pickaxe** (mine rocks → stone, and break stone walls). New
   characters start with a hammer and hatchet. More are found in loot (farms, forests, industry,
   mountains) or crafted at your stash house or one of your crates.
2. **Materials:** **wood** (4 chops per tree, 6 each, regrows), **stone** (4 per rock, 5 each), and
   **salvage** (metal and nails, scavenged).
3. **Place a frame** in build mode (**X** / D-pad ▶) wherever you like in the wild: not inside
   towns, not on water, not on steep ground, not next to Contacts or landing zones. Frames are
   scaffolding you can walk and shoot through.
4. **Upgrade in stages** (E / A in build mode, with a 3 s action):

| Piece | Frame | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| Wall (4 m) | 10 wood · 300 HP | Wooden wall: 15 wood · 1500 HP | Stone wall: 20 stone + 10 salvage · 4000 HP |
| Gate (4 m) | 10 wood · 300 HP | Wooden gate: 15 wood + 10 salvage · 1400 HP | Reinforced: 15 stone + 20 salvage · 3500 HP |
| Barricade | 8 wood · 800 HP (crouch cover) | — | — |
| Stash crate | 20 wood · 20 slots | Reinforced: 10 stone + 15 salvage · 40 slots | — |

- **Gates** open and close for you and your squad. Anyone else has to break them, hack them
  (level 8, tech) or blow them up.
- **Stash crates** are extra storage anywhere. They aren't locked (your walls are the protection),
  you can redeploy at them, and you can craft at them.
- **Dismantle** your own pieces (Q / Y in build mode) for half the materials back.

**Raiding a base:** bullets barely scratch built walls (wood takes 15% damage, stone 4%). Instead,
chop wood with a **hatchet** (350 damage per 6 s), break stone with a **pickaxe** (500 per 8 s), or
craft a **breach charge** (level 7: 30 salvage, 20 tech, 20 parts). It's placed against a wall,
gate or stash door and goes off after 8 s, wrecking everything within 4.5 m and hurting anyone
standing near it. Owners get an alert whenever someone starts breaking in.

## Entering the map, and dying

- **First time:** a map screen lets you pick a town (or click a specific free house). You claim that
  stash house and spawn inside it.
- **Logging back in:** you appear exactly where you logged out (DayZ-style). Your house stayed in
  the world the whole time.
- **When you die:** everything you were carrying (guns, armor, ammo, parts, tech, salvage, intel)
  drops in a bag where you fell, for anyone to take. You **keep** your level and unlocks,
  commendations and field gear, and everything stored in your stash house. You then redeploy at
  your **stash house**, any **Contact you've discovered**, or a **landing zone**. Every deploy gives
  10 s of spawn protection, which ends early if you fire. With the Infirmary upgrade, deploying at
  home gives you a light vest and 2 medkits.
- **Fast travel** only goes *out* from your stash house (to a discovered Contact, or to a
  squadmate).
- **Getting loot home: helicopter extraction** (The Division's Dark Zone extraction). At any
  Contact or landing zone, fire a flare: a red smoke column goes up and everyone within half a mile
  is alerted. Hold within **80 ft** of the flare for **90 seconds**. The helicopter then flies you, every squadmate in the
  zone, and everything you're all carrying straight to your stash houses (+30 XP each). Leave the zone or go
  down and the pilot aborts. After any pickup or abort the pilot needs **5 minutes**. Walking
  home is still free and quiet; extraction is fast but loud. Tuning lives in `shared/extraction.js`.

## Buildings

Every ordinary building is a walk-in shell, not a solid block: walls with doorways (one in small
buildings, two on opposite sides in bigger ones), a ceiling, and an interior wall with a gap in
buildings 46 ft (14 m) or longer. Loot sits inside: one spot per ~1,300 sq ft (120 m²) of floor,
up to three per building, from the building's zone table (town, industrial, farm, park). Only the
ground floor is open; upper storeys are solid for now, because stairs and multi-level movement
come with the move to Unreal. Roadside homesteads in the countryside are still solid scenery.

## Units

The simulation runs in metres (one game metre is one real metre). Everything the player reads is
in US customary units: feet under a quarter mile, miles above (`shared/units.js`). The map has a
feet/miles scale bar.

## Why leave the house

| Activity | Where | What you get |
| --- | --- | --- |
| **Contracts** from Contacts (Data Heist, Clear Rogue Camp, Supply Recovery, High-Value Target) | 250–1200 m from the Contact | Fixed, listed rewards: ★ commendations, salvage, parts/tech, big XP |
| **Supply drops** (every ~10 min, announced map-wide, 60 s fall) | Countryside | 120 salvage, 80 parts, 40 tech, 150 ammo, ★1. Opening takes 6 s and alerts everyone nearby |
| **Terminals** | Towns | Intel (→ XP) and tech |
| **Scavenging** | Industrial zones, farms, forests, roads, towns | Salvage (mostly outside town centres), parts, tech, ammo, medkits |
| **Rogues / Lieutenants** | Everywhere / contract sites | Parts, tech, salvage, intel |
| **Discovering Contacts** | Every town | XP, a new contract board, a new redeploy and fast-travel point |

## Three layers

| Layer | What it is | Can you lose it? |
| --- | --- | --- |
| **Level and unlocks** | XP → levels 1–30 → weapons, attachments, armor, paints, gadgets | Never |
| **Gear** | Physical guns (with your gunsmith build) and armor | Yes: dropped on death, stealable from stashes |
| **Resources** | Parts, tech, intel, ammo | Yes: dropped on death, stealable from stashes |

## How progression is balanced

1. **Primary: level (XP).** Levels 1–30 unlock weapon platforms, attachments, armor, paints and
   gadgets on a fixed schedule. XP comes from everything you do: time alive, kills, hacks,
   contracts, uploading intel, drops.
2. **Secondary: field gear (★ commendations).** A short list of strong-but-fair sidegrades
   (Integrated Suppressor, Hardened Barrel, Field Plate, Secure Pouch, Camo/Sensor Mk2, …) bought
   from any Contact's Quartermaster. Commendations come **only** from completing contracts and
   securing supply drops, so this gear is earned by being active out in the map. There's no luck
   involved: every reward is fixed and shown up front. You keep commendations and field gear when
   you die.
3. **Your base: stash house upgrades (salvage).** Salvage is found out in the map and paid into
   upgrades at home:

| Upgrade | Tiers | Effect |
| --- | --- | --- |
| Reinforced Door | Wood → Steel → Blast → Vault | 1× → 2× → 3.5× → 5.5× door HP |
| Storage | 30 → 45 → 60 → 90 slots | Bigger stash |
| Perimeter Alarm | 25 m / 50 m | Alerts you anywhere on the map and reveals intruders (optical camo beats it) |
| Generator | 12 / 30 / 60 per hour | Parts and tech into your stash, even offline (raiders can take it) |
| Infirmary | 1 | Deploying at home gives a vest and 2 medkits |
| Workbench | -25% / -50% | Cheaper gunsmith builds |

There are no random drops anywhere, so grinding for luck is never the way to progress.

## What loot gets you

| Resource | Where it comes from | What you spend it on |
| --- | --- | --- |
| **Parts** ⚙ | Parts caches in the street, Rogue kills, other players' bags and stashes | Building new guns (30–70) and armor (20–80) from blueprints you've unlocked. Swapping attachments is free. |
| **Salvage** ⛭ | Industrial zones, farms, forests, roads, contracts, supply drops | Stash house upgrades |
| **Commendations** ★ | Only contracts and supply drops (never lost) | Field gear from Contacts, top-tier upgrades |
| **Tech** ⌁ | Electronics caches, hacked terminals, Rogue kills | Powering gadgets: sensor grenade (10), optical camo (1 per 2 s), lock bypass (15) |
| **Intel** ▣ | Hacked terminals, Rogue kills | **XP.** Worth nothing until you upload it at your own stash (40 XP each, shared with nearby squadmates). Lost if you die carrying it. |
| **Ammo** | Ammo boxes, Rogue kills, bags | Shooting |

So the loot loop is:

1. Go out and hack terminals, kill Rogues and sweep caches → collect parts, tech and intel.
2. Hacking is loud: every enemy within 80 m gets a warning. Expect company.
3. Get home alive, upload intel for XP, put parts and tech in your stash.
4. Spend parts at the gunsmith on new platforms or armor as you unlock them; spend tech on gadgets.
5. Your stash is raidable at any time, so hoarding has a cost. Spend it or defend it.

## XP sources (how levelling works)

| Action | XP |
| --- | --- |
| Every minute alive in the zone | 25 |
| Rogue kill (+50 headshot) | 100 |
| Player kill (+20 per victim level, +50 headshot) | 300+ |
| Hack a terminal | 60 |
| Upload intel | 40 each |
| Breach a stash house (shoot or hack) | 150 / 120 |
| Your tag leads to a kill (assist) | 40 |
| Build a gun or armor | 40 |
| Squad share: nearby squadmates get 25% of your kill, hack and upload XP | — |

## Tech (Future Soldier-style gadgets)

**Hacking is a combat tool, not a chore.** It's about lighting up the other crew so you can kill
them.

1. **Take an enemy down without killing them:**
   - throw a **stun grenade** at them;
   - sneak up behind them for a **takedown** (E);
   - or down them in a fight (crews go down instead of dying).
2. **Data-hack them:** hold E next to them for 2 s. They stay pinned while you hack, but you show up
   to enemies nearby, so your crew has to cover you. Each crewmate within ~30 ft speeds the hack up.
3. **The payoff:**
   - their **whole crew lights up** for your crew for 20 s: through walls, on the minimap and on the map, at any distance, camo included;
   - you also **learn where their stash house is**, which is marked on your map for 15 minutes.
4. Hacking a stunned **Rogue** taps their radio and lights up every Rogue within ~1,000 ft.
5. **Counterplay:**
   - the hacked crew is told immediately;
   - a crewmate can shoot the hacker off;
   - the **Intel jammer** field perk halves how long you stay lit up.

**Terminals** are for scouting. Hacking one (5 s) **scans the area**: every enemy within ~500 ft lights
up for your crew for 10 s. It also pays tech and intel. Hack one before you push a town.

| Gadget | Key (controller) | Unlock | Effect |
| --- | --- | --- | --- |
| Data hack | E (A) next to a stunned/downed enemy | 1 | 2 s: lights up their whole crew for 20 s and marks their stash house |
| Takedown | E (A) from behind | 1 | Stuns them for 4 s, ready to hack (+30 XP) |
| Target tagging | F (RB) | 1 | Tag the enemy under your crosshair; your crew sees them through walls for 8 s |
| Sensor grenade | G (tap LB) | 2 | Reveals everyone within 60 ft of where it lands to your crew for 10 s, cloaked players included |
| Stun grenade | Z / hold LB to switch, then G / tap LB | 3 | 15 tech: after 1 s, enemies within 20 ft who can see it are stunned for 2-4 s |
| Optical camo | V (R3) | 4 | Near-invisible while crouched or moving slowly; firing, sprinting or taking damage breaks it |
| Rally | T (◀) | 5 | Crew leader only: +50% armor and +20% damage to crewmates within 100 ft; 90 s cooldown |
| Lock bypass | E (A) on a locked door | 8 | Silently hack open a locked stash house door (8 s); the owner is alerted |

Stunned players can't move, shoot or use anything until it wears off. Numbers live in
`shared/data/gadgets.json` (`stun`, `takedown`, `dataHack`) and `activities.json` (`terminal`).

Camo is enforced by the server: cloaked enemies are left out of your network updates unless
they're within 9 m or a tag or sensor has exposed them, so it can't be beaten by reading traffic.

## Crews: playing as a team (Division-style)

This is a team game, and the crew is the team.

- **Crews are permanent.** They're saved with the world: you stay in your crew when you log off,
  and offline members still show (greyed) in the crew panel (P). Up to 6 members.
- **Ranks:** the **leader** invites, removes, promotes, renames and hands over leadership.
  **Officers** can invite and remove ordinary members. If the leader leaves, the longest-serving
  officer takes over. Members are shown to each other by a public id, never their login token.
- **No friendly fire.** Tags and sensor reveals are shared. Crewmates show green on the minimap
  and through walls. The **leader's ping is the crew objective** (★ on everyone's HUD), and
  **Rally** is the leader's ability.
- **One shared stash house per crew.** Every member uses its stash, gunsmith and upgrades and
  levels it up. Alarms and raid alerts go to every member online. Only the leader or an officer can
  abandon it. If the member who planted the claim leaves, the house stays with the crew. A claim
  you had before joining a crew that already has one stays yours, unused, for if you ever leave.
- **Downed, not dead.** At 0 HP, while a crewmate is online and still up, you go **down**: you
  crawl at about 4 ft/s and bleed out over 30 s. Enemy fire drains a separate 120-point bleed pool,
  so you can be finished off. A crewmate stands still next to you for 4 s to **revive** you (35 HP,
  +75 XP to them). If nobody in the crew is left standing, it's a wipe and everyone down dies.
  Solo players die at 0 HP. You can give up (Q / Ⓨ) to respawn sooner. Rogues ignore downed players,
  and an extraction helicopter patches up downed crewmates who ride it.
- **Team hacking.** Each crewmate within ~30 ft of a hacker takes half a second off every second
  (up to two helpers, so a 5 s terminal takes 2.5 s). While you hack a terminal, door, gate or
  supply drop, **your position shows to enemies within ~260 ft**, so someone has to cover you.
- **Crew contracts.** When a contract is completed, every crewmate who is up and within ~500 ft of
  the finisher or the objective takes part: everyone gets the full XP and commendations, and parts,
  salvage, tech and intel are split evenly.
- **Crew board.** The leaderboard (P) ranks crews by **crew score** (all XP members earn while in
  the crew), alongside the agent board.
- XP is still shared at 25% with crewmates within 165 ft.

Numbers live in `shared/data/combat.json` (`crewMax`, `downed`) and `activities.json`
(`teamHack`, `contracts.crewShareRange`).

## Open questions to tune next

- XP rates and the level curve: how long should reaching level 30 take?
- Per-weapon XP and challenges to unlock specific parts (as in Future Soldier), in place of or
  alongside player level.
- Offline raid protection: should doors get tougher while the owner is offline?
- Vehicles: at real scale it's 11 miles from Bristol to Hosford, about 40 minutes on foot. Extraction covers the trip home; trucks, bikes or boats on the Apalachicola would cover the trip out.
- Rivers, bridges and boats; climbable watchtowers and multi-storey builds.
- Base decay or upkeep, so abandoned bases eventually fall apart.
- More gadgets: UAV drone, cross-com sync shot (squad fires together on tagged targets for a bonus),
  intel jammer.
- Clans/factions above squads, with a shared clan stronghold.

## Engine plan

1. **Now: this browser prototype** (Three.js client, Node.js server). Changes are fastest here, and
   it runs on a phone from a link. Use it to settle the design.
2. **Then: Unreal Engine 5.** World Partition for streaming the real-scale map, Chaos vehicles,
   real building interiors, Lyra as the online-shooter base, dedicated servers, native phone builds.
   Godot was considered as a middle step and **skipped**.

To make the move cheap, every rule and number is in engine-neutral data files
(`shared/data/*.json`, see its README), in metres and milliseconds, with the map in real
latitude/longitude. Unreal imports these directly. What carries over: the rules, balance, map and
design. What gets rebuilt in Unreal: rendering, movement, networking and UI. The tests in `test/`
describe how each system must behave.

## Parked work (to pick back up)

- **Real 3D buildings:** importing the real FEMA/ORNL building footprints and OpenStreetMap roads
  (`tools/import-real-data.mjs`, generator support already in place) and real elevation. On hold
  by request.
- **Environment streaming for phones:** phones still generate the whole 18.6-mile map on load and
  build its overview map. Next: have the server send only the area around the player, stream it
  in tiles as you move, keep a coarse low-detail map for the map screen, and cap what phones keep
  in memory.
