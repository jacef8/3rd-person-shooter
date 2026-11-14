# Playtest guide

**Play:** https://deadzone-server-production-c9ff7400.up.railway.app

It runs on Railway (project "Deadzone") and updates itself a few minutes after every push to the
`ccr-0f91b1bc-crkbxy` branch. The world is saved on a storage volume, so homes, crews and characters
last between sessions and updates. A change to the save format wipes it. **The real-map update did
that, so everyone starts fresh: new character, no home yet.**

## Getting in

**Phone + Backbone One (the main way to play)**

1. Plug the phone into the Backbone and open the link in Safari (iPhone) or Chrome (Android). Turn
   the phone sideways.
2. Press any controller button. The browser only notices a controller after a press. The touch
   buttons hide and a yellow outline shows what is picked.
3. Move the outline with the D-pad or left stick. **Ⓐ** picks, **Ⓑ** goes back.
4. Put the outline on the **Callsign** box and press Ⓐ. A keyboard comes up: D-pad to a letter, Ⓐ to
   type it, Ⓧ deletes, Ⓨ is a space, **☰** is done.
5. Pick **Create callsign**, then **Play**, then a town to start in (Bristol is easiest).

On iPhone, Share → **Add to Home Screen** and open it from there to get the full screen.

**Other ways**

- **Computer:** open the link, enter a callsign, pick a town. Click the game to capture the mouse.
  WASD + mouse, E use, M map, P crew panel, Tab bag. A controller plugged into the computer works too.
- **Phone, touch only:** left thumb drags to move (push past the ring to sprint), right thumb drags
  to look. FIRE, AIM, USE, RELOAD, CROUCH, SWAP, GRENADE, TAG and HEAL are on the right; MAP, BAG,
  CREW, CAMO, PING, grenade switch and BUILD are along the top. ✕ Close, top right, closes a screen.

Your character is tied to the browser you play in. Clearing its storage, or using another browser,
makes a new character.

## Controller buttons

The two small buttons are written **⧉** (left side; marked ••• on a Backbone One) and **☰** (right
side; marked ≡).

| Button | In the world | In a menu |
| --- | --- | --- |
| Left stick | Move | Move the outline |
| Right stick | Look | Scroll; slide the map |
| L3 (press the left stick) | Sprint | |
| LT / RT | Aim / fire | Zoom the map out / in |
| Ⓐ | Use: loot, doors, talk, hack, revive | Pick |
| Ⓑ | Crouch (tap) · prone (hold) | Back |
| Ⓧ / Ⓨ | Reload / swap weapon | |
| LB | Grenade (hold: switch type) | Hold with ◀ ▶ to change a number by tens |
| RB | Tag the enemy you're aiming at | |
| R3 (press the right stick) | Camo; while aiming, flip a two-range sight | |
| ▲ ▼ ◀ ▶ | Medkit or eat · ping · rally · build mode | Move the outline; ◀ ▶ change a number |
| ⧉ | Bag (a boat's hold when aboard). **Hold** to say yes to an invite or trade request | |
| ☰ | Map. **Hold** for the crew panel (friends, look speed) | Done, on the keyboard |

Build mode: LB / RB pick a piece, Ⓧ turns it, RT places, Ⓐ upgrades, Ⓨ takes it down, ▶ leaves.
Boats: the left stick is throttle and steering; steer to the bank and press Ⓐ to get out.

## Controller check (start here)

Do these with the controller only. **Tell me about anything you had to touch the screen for.**

1. Type your callsign on the on-screen keyboard and get into the world.
2. Walk, look, aim, fire, reload, crouch, sprint.
3. Tap ☰ for the map. Slide it with the right stick, zoom with LT / RT, Ⓑ to close.
4. Hold ☰ for the crew panel. Under **Controller**, change the look speed until it feels right.
5. Walk up to the Contact in town (blue ✦) and press Ⓐ. Move down the list and buy something. The
   outline should stay where you put it.
6. Press ⧉ for your bag. Ⓑ to close.
7. Press ▶ for build mode, pick **Farm plot** with LB / RB and place it with RT (it costs 8 wood;
   you start with 20). ▶ again leaves build mode.
8. With a friend standing next to you: hold ☰, find them under the people nearby, pick **Trade**.
   They should see a bar at the top and answer it by holding ⧉.

## Lobby, friends and invites

- **First visit:** pick a callsign. It's unique, and it's how friends find you.
- **The world:** there is one shared world, **Liberty County**. The lobby shows how many are playing
  and which friends are in it.
- **Friends:** search a callsign → Add friend; they accept. Players you've played alongside show up
  under "Played with recently". In the world, friends are in the crew panel (hold ☰).
- **Invites:** in the world, pick **Invite here** on an online friend. A bar appears at the top of
  their screen; they hold ⧉ (or tap **Join**) and land in your crew, with "Deploy with <you>" on
  their start screen. Friends already in the world get **Crew invite** instead.

## Things to try

Buttons below are the controller's. On a keyboard: Ⓐ is E, ▲ is H, ▶ is X, ☰ is M, ⧉ is Tab.

Living off the land:
- Watch your **FOOD** bar. ▲ eats (or heals if you're hurt and carry a medkit).
- Buy **seed packets** at any Contact's **trading post**, walk out of town, ▶ → **Farm plot**, then
  Ⓐ to plant. Come back later to harvest (anyone can steal a ripe crop!).
- Buy or craft a **fishing rod**; stand at the river and press Ⓐ.
- Hunt deer and hogs (sneak up crouched). ▶ → **Campfire** to cook raw fish or meat into meals.
- Sell goods at a trading post. Compare prices between towns: corn pays more in Bristol than Blountstown.

The living world:
- Watch the top-left tracker and the map for **world events** (riot, county fair, hog hunt, supply
  convoy, market swing). The first one starts about 3 minutes after the server starts, then one every
  ~12 minutes.
- Find a **travelling merchant** on the roads, or a **farmer / fisherman** at a farm or fish camp, and press Ⓐ to trade.
- At a trading post, take a **freight** job and haul it to another town (no helicopter or fast travel with cargo).
- ▶ → **Market stall**, list some goods (◀ ▶ set how many and the price), and have a friend buy
  them. Check the **market board** at a trading post.
- Stand next to a friend and **trade** face to face (crew panel → Trade).
- Guard your place: ▶ → **Tripwire**, **Motion alarm**, **Sentry gun** (Ⓐ to load ammo) and **Dog kennel**
  (Ⓐ to feed meat). Log off, have a friend walk in, then log back on and read the **away log**.

The real map:
- There's no fog now: look around from the Bristol side of the river and from the Torreya bluffs north of town.
- Walk a real street in Blountstown or Bristol. The road's real name shows under the minimap; zoom the
  map in to read the street names.
- Find the **Liberty County Courthouse** in Bristol and walk in. Any real building can be claimed.
- Cross the river on the **SR 20 bridge**, then take a boat under it.
- Tell me what looks wrong against the real place: a road, a building, a hill, the river.

Moving, shooting and the map:
- Ⓑ crouches, **hold Ⓑ to go prone** (lower, slower, steadier aim), L3 sprints. On the crew panel
  (hold ☰), turn on **auto-sprint** to sprint by pushing the stick all the way forward.
- The crosshair now opens up to show how far shots can stray: wide when firing from the hip on the
  move, tight when aiming down sights, crouched or prone. Shots land on what was under it.
- On the map (☰): every road has its name; state routes are amber with blue tags. Slide the map so
  the cross is on a spot, then **Ⓧ sets a waypoint** and **Ⓨ pings your crew**. The waypoint shows
  in the world and on the minimap, and clears when you get there.
- Rogues now drop the gun they carried; Lieutenants also drop a plate carrier. Bags and bodies have
  a **Take everything** button.
- Sound: gunshots (placed and muffled by distance), footsteps, hits, reloads, pings, blasts. Volume
  is in the crew panel. On a TV or phone with only a controller, tap the screen once if it's silent:
  some browsers only start sound after a touch or click.

Fair raids (you need a friend, or two browsers):
- At your stash, find **Raid window** and pick when your base can be raided while you're offline.
  A new window starts a day after you set it.
- Have a friend log off. Outside their window, try to shoot their door or chop their wall: it says
  **Sealed** and when the window opens. Inside it, it takes about a third of the damage.
- Break in and open their stash: it says how much one raid can carry off (35% while they're away,
  50% while they're online).
- Break a claim flag: it becomes a **ruin**. The owner opens the stash and picks **Rebuild**.
- Watch your hatchet's condition in your bag; it wears out raiding and chopping.
- Bypassing a lock takes longer on a better door: 8 seconds for a basic door, 32 for a vault door.

New and solo players:
- Below level 5 a 🛡 shows on your name and other players can't hurt you, until you shoot someone.
- Playing alone with a medkit, you go down instead of dying: press Ⓐ to patch yourself up.
- Levelling is slower now: about 5 hours to level 10 and 50 to level 30.

Guns:
- At your stash, open the gunsmith. There are ten slots now, including **Forearm** and **Ammunition**.
  Moving the outline over a part shows what it would change before you fit it.
- Try a two-range sight (the 1-6x, level 13) and flip it with R3 while aiming.
- Hollow points against Rogues and deer, armor-piercing against a friend in a vest.

The river:
- Go to **Bristol Landing**, on the river about 2 miles west of Bristol (⚓ on the map). Ⓐ at the post:
  buy or build a **jon boat**, and take a **river freight** load.
- Walk to your boat at the end of the jetty and press Ⓐ to take the helm. The left stick is throttle
  and steering, ⧉ opens the hold, and you steer up to the bank and press Ⓐ to get out.
- Run the freight to the other landing and deliver it at the post.
- Head downriver to a **swamp camp** (🏕 on the map). No fighting there. Buy honey or moonshine from the
  camp trader and sell it in Hosford or Telogia. Claim a river shack. Watch for gators on the banks.
- With a friend: one drives, one rides and shoots. Try hotwiring each other's boats, and shooting a boat until it sinks.

Solo:
1. **Claim a home.** You start with a claim marker. Walk into any building (or a house, cave, RV…)
   with nothing else around and press Ⓐ. Take your time picking: it's your base.
2. **Loot and level.** Search buildings for loot. Watch the XP and level-ups.
3. **Gunsmith.** At your stash (Ⓐ on the locker or crate): swap attachments and compare the stats.
4. **Get loot home.** Walk it back, or **call extraction** at any Contact or landing zone (yellow
   helipad): fire the flare and hold the zone for 90 s.
5. **Terminals.** Hack one (Ⓐ, 5 s) to scan for enemies within ~500 ft.

With a friend (meet in the same town; Bristol is easiest):
1. **Crew up:** hold ☰ → Crew invite, they accept. Found a crew with a name (Ⓐ on the name box
   opens the keyboard).
2. **Shared base:** both of you can use the crew stash house.
3. **Downed and revive:** when one of you goes down, the other holds Ⓐ on them for 4 s.
4. **Data hack:** take each other down from behind (Ⓐ), then hold Ⓐ on the stunned player. Check
   that their whole crew lights up on the map and their stash house gets marked.
5. **Contracts:** take one from a Contact and finish it together. Both of you get paid.

## What to look out for

- Anything you couldn't do from the controller, and any hint that still names a keyboard key.
- Anything confusing: prompts that don't say what to do, or things you couldn't find.
- Performance on the phone: frame rate and load time. The map now downloads about 1.3 MB of real-world
  data when you enter, and draws the far landscape; streaming it in pieces is still a parked item.
- Distances and timings that feel wrong. They're all in `shared/data/*.json` and easy to change.
- Characters are placeholder capsules with no animations yet (planned for the Unreal version).

## Known limits

- Friends must already be your friends (lobby) to get an invite; anyone else has to be standing near you.
- One world for everyone on the link: anyone with the link can play.
- Debug commands are off on the hosted server.
- The controller has been tested with a simulated gamepad in a desktop browser, not yet on a real
  Backbone. Button feel, look speed and anything phone-specific still need your hands on it.
