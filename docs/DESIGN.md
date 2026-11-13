# Deadzone — progression and loot design

The core rule: **your level is your progression, and loot is fuel.** Levelling (like Future
Soldier) decides *what you can use*. Loot decides *how much of it you can afford to field right
now*, and you can lose it, so every trip out of your stash house is a risk.

There are no random stat rolls anywhere. A gun's strength comes from its platform plus the
attachments you chose in the gunsmith, and both are unlocked by level.

## The world

- **One persistent 8 × 8 km map** (the size of PUBG's Erangel/Miramar): about 40 towns (some
  of them cities, some industrial) joined by roads, with farms, forests, rocks and abandoned cars in
  between. It's generated from a seed, so every client builds the identical world locally and the
  server only sends what's within ~320 m of you.
- Each town has **stash houses** (about 120 in total), a **Contact** NPC in the square, hackable
  **terminals**, and loot spots. Rogue patrols spawn around wherever players are.

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
  squadmate). Getting loot home is always on foot, which is where the risk is.

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

| Gadget | Key | Unlock | Effect |
| --- | --- | --- | --- |
| Target tagging | F | 1 | Tag the enemy under your crosshair; your squad sees them through walls for 8 s |
| Terminal hacking | E | 1 | 5 s, stand still; interrupted by moving or taking damage |
| Sensor grenade | G | 2 | Reveals everyone within 18 m of where it lands to your squad for 10 s, cloaked players included |
| Optical camo | V | 4 | Near-invisible while crouched or moving slowly; firing, sprinting or taking damage breaks it |
| Lock bypass | E | 8 | Silently hack open a locked stash house door (8 s); the owner is alerted |
| Rally | T | 5 | Squad leader only: +50% armor and +20% damage to squadmates within 30 m; 90 s cooldown |

Camo is enforced by the server: cloaked enemies are left out of your network updates unless
they're within 9 m or a tag or sensor has exposed them, so it can't be beaten by reading traffic.

## Squads and leadership (Division-style)

- Up to 4 players. The leader invites, kicks and promotes.
- **No friendly fire.** Tags and sensor reveals are shared. Squadmates show green on the minimap
  and through walls.
- The **leader's ping is the squad objective** (★ on everyone's HUD for 2 minutes). Members' pings
  are short callouts.
- **Rally** is the leader's own ability.
- **Shared stash access:** squadmates can open each other's stash house doors and deposit or take
  items. Only the owner can use the gunsmith or upload intel there.
- XP is shared at 25% within 50 m, so playing together levels everyone faster.
- The **leaderboard** (P) ranks every character on the server by XP, online or offline.

## Open questions to tune next

- XP rates and the level curve: how long should reaching level 30 take?
- Per-weapon XP and challenges to unlock specific parts (as in Future Soldier), in place of or
  alongside player level.
- Offline raid protection: should doors get tougher while the owner is offline?
- Vehicles: 8 km is a long walk. Bikes or trucks would pair well with the walk-home rule.
- Terrain height (hills, rivers) on top of the current flat ground.
- More gadgets: UAV drone, cross-com sync shot (squad fires together on tagged targets for a bonus),
  intel jammer.
- Clans/factions above squads, with a shared clan stronghold.
