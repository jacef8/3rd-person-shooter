# Playtest guide

**Play:** https://deadzone-server-production-c9ff7400.up.railway.app

It runs on Railway (project "Deadzone") and redeploys automatically on every push to the
`ccr-0f91b1bc-crkbxy` branch. The world is saved on a storage volume, so stash houses, crews and
characters persist between sessions and redeploys. A change to the save format wipes it.

## Getting in

- **Computer:** open the link, enter a callsign, pick a town to deploy to. Click the game to capture
  the mouse. WASD + mouse, E interact, M map, P crew panel, Tab inventory.
- **Phone, touch only:** open the link in Chrome (Android) or Safari (iPhone), landscape.
  - **Move:** put your left thumb anywhere on the left half and drag; push past the ring to sprint.
  - **Look:** drag anywhere on the right half.
  - **Act:** FIRE, AIM, USE (= E), RELOAD, CROUCH, SWAP, GRENADE, TAG and HEAL are on the right; MAP, BAG, CREW, CAMO, PING, grenade switch and BUILD are along the top.
  - **Close a screen:** use ✕ Close, top right.
- **Phone + Backbone One (the main way to play):** same link. Press any controller button so the
  browser sees it; the touch buttons then hide. Everything works from the controller: Ⓐ on the
  callsign box opens an on-screen keyboard, hold ☰ for the crew panel (look speed is in there), tap ☰
  for the map, hold ⧉ to say yes to an invite or a trade request. Tell me about anything you could
  not do without touching the screen.
- Your character is tied to the browser you play in. Clearing its storage, or using another
  browser, makes a new character.

## Lobby, friends and invites

- **First visit:** pick a callsign. It's unique, it's how friends find you, and it's yours in every world.
- **Worlds:** the lobby lists the worlds (Bristol 1, Bristol 2) with player counts and which friends
  are in each. Each world is separate: its own players, crews, bases and loot, and its own character
  for you. Your old character and base are in **Bristol 1**.
- **Friends:** search a callsign → Add friend; they accept. Players you've played alongside show up
  under "Played with recently" for one-tap adding. In-game, friends are in the crew panel (P / CREW).
- **Invites:** in-game, tap **Invite here** on an online friend. They get a pop-up wherever they are
  (lobby or another world); **Join** drops them into your world *and* your crew, and their deploy
  screen offers "Deploy with <you>" to land right next to you. Friends already in your world get
  **Crew invite** instead. From the lobby, **Join Bristol N** goes to a friend's world.

## Things to try

Living off the land:
- Watch your **FOOD** bar. **H** eats (or heals if you're hurt and carry a medkit).
- Buy **seed packets** at any Contact's **trading post**, walk out of town, BUILD → **Farm plot**, then
  E to plant. Come back later to harvest (anyone can steal a ripe crop!).
- Buy or craft a **fishing rod**; stand at the river and press E.
- Hunt deer and hogs (sneak up crouched). BUILD → **Campfire** to cook raw fish/meat into meals.
- Sell goods at a trading post. Compare prices between towns: corn pays more in Bristol than Blountstown.

The living world:
- Watch the top-left tracker and the map for **world events** (riot, county fair, hog hunt, supply
  convoy, market swing). The first one starts about 3 minutes after the server starts, then one every
  ~12 minutes.
- Find a **travelling merchant** on the roads, or a **farmer / fisherman** at a farm or fish camp, and press E to trade.
- At a trading post, take a **freight** job and haul it to another town (no helicopter or fast travel with cargo).
- BUILD → **Market stall**, list some goods, and have a friend buy them. Check the **market board** at a trading post.
- Stand next to a friend and **trade** face to face (crew panel → Trade).
- Guard your place: BUILD → **Tripwire**, **Motion alarm**, **Sentry gun** (E to load ammo) and **Dog kennel**
  (E to feed meat). Log off, have a friend walk in, then log back on and read the **away log**.

The real map:
- There's no fog now: look around from the Bristol side of the river and from the Torreya bluffs north of town.
- Walk a real street in Blountstown or Bristol. The road's real name shows under the minimap; zoom the
  map (M) in to read the street names.
- Find the **Liberty County Courthouse** in Bristol and walk in. Any real building can be claimed.
- Cross the river on the **SR 20 bridge**, then take a boat under it.
- Tell me what looks wrong against the real place: a road, a building, a hill, the river.

Guns:
- At your stash, open the gunsmith. There are ten slots now, including **Forearm** and **Ammunition**.
  Try a two-range sight (the 1-6x, level 13) and flip it with R3 while aiming.
- Hollow points against Rogues and deer, armor-piercing against a friend in a vest.

The river:
- Go to **Bristol Landing**, on the river about 2 miles west of Bristol (⚓ on the map). E at the post:
  buy or build a **jon boat**, and take a **river freight** load.
- Walk to your boat at the end of the jetty and press E to take the helm. W/S throttle, A/D steer,
  Tab for the hold, steer up to the bank and press E to get out.
- Run the freight to the other landing and deliver it at the post.
- Head downriver to a **swamp camp** (🏕 on the map). No fighting there. Buy honey or moonshine from the
  camp trader and sell it in Hosford or Telogia. Claim a river shack. Watch for gators on the banks.
- With a friend: one drives, one rides and shoots. Try hotwiring each other's boats, and shooting a boat until it sinks.

Solo:
1. **Claim a home.** You start with a claim marker. Walk into any building (or a house, cave, RV…)
   with nothing else around and press E. Take your time picking: it's your base.
2. **Loot and level.** Search buildings for loot. Watch the XP and level-ups.
3. **Gunsmith.** At your stash (E on the locker or crate): swap attachments and compare the stats.
4. **Get loot home.** Walk it back, or **call extraction** at any Contact or landing zone (yellow
   helipad): fire the flare and hold the zone for 90 s.
5. **Terminals.** Hack one (E, 5 s) to scan for enemies within ~500 ft.

With a friend (meet in the same town; Bristol is easiest):
1. **Crew up:** P → Invite, they accept. Found a crew with a name.
2. **Shared base:** both of you can use the crew stash house.
3. **Downed and revive:** when one of you goes down, the other holds E on them for 4 s.
4. **Data hack:** take each other down from behind (E), then hold E on the stunned player. Check
   that their whole crew lights up on the map (M) and their stash house gets marked.
5. **Contracts:** take one from a Contact and finish it together. Both of you get paid.

## What to look out for

- Anything confusing: prompts that don't say what to do, or things you couldn't find.
- Performance on the phone: frame rate and load time. The map now downloads about 1.3 MB of real-world
  data when you enter, and draws the far landscape; streaming it in pieces is still a parked item.
- Distances and timings that feel wrong. They're all in `shared/data/*.json` and easy to change.
- Characters are placeholder capsules with no animations yet (planned for the Unreal version).

## Known limits

- Friends must already be your friends (lobby) to get an invite; anyone else has to be standing near you.
- One world for everyone on the link: anyone with the link can play.
- Debug commands are off on the hosted server.
