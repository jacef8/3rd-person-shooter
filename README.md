# Deadzone (working title)

A prototype **third-person looter shooter** set in one **persistent, always-PvP city**.

- Loot shooter loop: rarity-tiered weapons and armor (Scrap → Field → Tactical → Elite → Relic) with
  rolled attributes, gear scores, crits, headshots, damage falloff, armor that regenerates out of combat.
- Open-world rules: no safe zones, no instancing. When you die, everything you carried drops in a bag
  anyone can loot. When you log off, your character stays where you stood.
- **Stash houses are part of the live world.** Each player is given a walled stash house with a crate.
  Its door can be shot down by anyone, at any time, **including while you're offline**. Once it's
  breached, anyone can walk in and empty your stash. Owners get alerts while online, must rebuild a
  breached door by hand, and an intact door slowly repairs itself.
- AI "Rogues" patrol the city, fight anyone they see, and drop better loot.

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
H medkit · Tab inventory.

## Tests

```bash
npm test
```

Includes an end-to-end test that boots the server, has one player shoot down another player's stash
house door, walk in, take an item, shoot the owner, then restarts the server and checks the stash,
door state and loot all persisted.

## Architecture

```
client/   Browser client (Three.js): rendering, input, local movement prediction, HUD, inventory
server/   Authoritative Node.js game server (HTTP + WebSocket), simulation, bots, persistence
shared/   Code both sides run: map generation, collision, ray casts, loot tables, weapon stats
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
5. **Content:** missions/landmarks, crafting, gear sets, a dark-zone-style extraction loop, and more.
