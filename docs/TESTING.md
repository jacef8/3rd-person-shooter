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
- **Phone + Backbone One:** same link. Press any controller button so the browser sees it; the
  touch buttons then hide. The A button joins.
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
- Performance on the phone: frame rate, load time (the whole 18.6-mile map is generated on load;
  streaming it in pieces is a parked item).
- Distances and timings that feel wrong. They're all in `shared/data/*.json` and easy to change.
- Characters are placeholder capsules with no animations yet (planned for the Unreal version).

## Known limits

- You can only invite players who are near you on screen.
- One world for everyone on the link: anyone with the link can play.
- Debug commands are off on the hosted server.
