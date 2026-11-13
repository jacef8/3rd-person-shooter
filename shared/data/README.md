# Game rules data

Every number and table that defines how the game plays is in these JSON files. The code in
`shared/`, `server/` and `client/` only loads them and applies the logic. Edit a file, restart the
server and reload the page. `npm test` checks the files for broken references (`test/data.test.js`).

These files are engine-neutral on purpose: the plan is browser prototype → **Unreal Engine 5**, and
Unreal can import the same files (as DataTables / Data Assets), so balance work done here carries
over.

| File | What's in it |
| --- | --- |
| `progression.json` | Max level, the XP curve, and how much XP each action gives |
| `arsenal.json` | Weapon platforms, gunsmith parts (slots, what fits what, stat modifiers), paints, armor, field perks |
| `gadgets.json` | Tagging, sensor grenade, optical camo, lock bypass, rally |
| `stash.json` | Claim markers and flags, home levels and their perks, stash upgrades |
| `building.json` | Tools, crafting recipes, buildable pieces and their stages, building and raiding rules |
| `activities.json` | Contracts, supply drops, terminals, loot tables by zone, hack times, helicopter extraction |
| `combat.json` | Backpack size, door HP, headshots, damage falloff, medkits, AI Rogues |
| `map-bristol.json` | The real Bristol, FL area: towns, landmarks, rivers, lakes, highways, terrain regions |

## Conventions

- **Units:** distances in metres, times in milliseconds, spreads in radians. The game shows players
  feet and miles (`shared/units.js`). Unreal works in centimetres, so its importer multiplies by 100.
- **Positions** in `map-bristol.json` are real latitude/longitude, not game coordinates. The game
  projects them at 1:1 scale around `origin`, so the same file can place things in any engine.
- **Gunsmith part modifiers:** a field ending in `Mul` multiplies the stat (e.g. `recoilMul: 0.8`
  = 20% less recoil). Any other field adds (e.g. `handling: -10`).
- **`level`** = player level that unlocks it. **`field`** = commendations to buy it from a Contact.
  **`home`** = stash house level needed. **`cost`** keys are resources: parts, tech, salvage, wood,
  stone, intel, ammo, comms (commendations).
- `_about` fields are notes for people and are ignored by the game.
