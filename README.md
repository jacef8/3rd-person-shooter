# Deadzone (working title)

A prototype **third-person looter shooter** set in one **persistent, always-PvP city**.

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
each other. Options are environment variables: `PORT`, `SEED` (map), `BOTS` (rogue count),
`DATA_FILE` (where the world is saved; default `data/world.json`).

**Controls:** WASD move · Shift sprint · C crouch (makes low walls and cars real cover) · mouse aim ·
LMB fire · RMB aim down sights · E interact (loot, bags, stash, doors) · R reload · Q swap weapon ·
H medkit · Tab inventory · F tag · G sensor grenade · V optical camo · T rally (squad leader) ·
B squad ping · P squad panel and leaderboard. Open your stash (E at the orange crate in your house) → **Open Gunsmith**.

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
