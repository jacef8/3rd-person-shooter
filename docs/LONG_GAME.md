# The long game: what the review found, and what I recommend

Five reviewers went through the story, the rules in `shared/data/` and the server code, each with a
different job: story and end goal, levelling numbers, long-term play, the economy and black markets,
and a sceptical veteran player looking for reasons people would quit. Nothing was play-tested; the
figures are worked out from the rules as written. I checked the ones I repeat here.

## The verdict in five lines

1. **The first few hours work.** Scavenge, get it home, unlock, build.
2. **There is no end goal.** The story promises a "Reopening" that never comes, and none of the story's
   words (Halyard, the Authority, the Reopening) appear in the game yet.
3. **Level 30 comes far too fast:** about 4 to 9 hours of play. Before this week's changes you could
   reach it by standing still for 24 hours, and nothing useful unlocked after level 18.
4. **Nothing drains and nothing is scarce.** No upkeep, no tax, bottomless shops, weightless goods. Cash
   stops mattering within two hours, so there is nothing for a market, or a black market, to sell.
5. **The rules punish the builders you want to keep.** A base can be emptied in 30 seconds to 4
   minutes while its owner sleeps, by one raider risking a 25-part pickaxe.

## What happens at level 30, and how long it should take

**Today:** level 30 is 35,960 XP and gives one gold skin.

**Recommended: about 50 hours of play for a typical player.** That is in line with comparable
shooters (roughly 25 to 50 hours to the cap), and is as far as the unlock list can stretch: about one
unlock every hour and a half.

| Level | 5 | 10 | 15 | 20 | 25 | 30 |
|---|---|---|---|---|---|---|
| XP today | 1,960 | 5,760 | 11,060 | 17,860 | 26,160 | 35,960 |
| XP proposed | 5,040 | 21,240 | 48,440 | 86,640 | 135,840 | 196,040 |
| Hours of play, proposed | 1 | 5 | 12 | 22 | 34 | 49 |

Reaching 30 on the proposed curve is roughly 850 Rogue kills, 150 contracts and 40 player kills,
plus intel and hacks along the way. It is two numbers in `shared/data/progression.json`
(`firstLevelXp` 400 to 600, `extraPerLevelXp` 60 to 440). **Not changed yet: it is your call.**

**What you unlock along the way.** With this week's gun parts, something now unlocks at every level
up to 30. The reviewers' advice on order: one thing per level and a big moment every fifth level
(a new gun class, optical camo, the raid tools), instead of 23 of the 40 old unlocks landing in levels 2 to 8.

**After 30** (nothing here adds power, so a newcomer is never outgunned by a veteran's rank):
- **Weapon mastery (main):** each gun class has 20 mastery levels fed by kills with that gun, about
  20 to 25 hours each. Rewards are a patterned skin at 5, a kill counter and title at 10, a saved
  build slot at 15, a gold version at 20.
- **Re-enlist (second):** at 30 you may start again at level 1 for a rank chevron, a skin nobody
  else can get, and one blueprint you keep forever. Ten tours, for the people who never stop.

## The end goal: the Survey

The story's "Reopening" is the right idea in the wrong shape: one final date ends the game, and a
last-day count just hands it to the biggest crew. The proposal:

- **The Authority surveys one district at a time**, on a published date. Six towns, six chapters, about
  six weeks each to start with.
- **For everyone, a Title.** Reach level 15 and home level 5, hold your land for enough days (not just
  on the last day) and pay a fee, and you get a deed. A titled home can be robbed but never taken
  away, your name goes on the map, and your claim marker is freed so you can start a second place.
- **For one crew, the Charter.** The crew that did the most to settle the district gets its name on
  the town and a cut of its trading post's sales.
- **Nothing is wiped.** Only the chapter's scoreboard resets. The day after, that district is
  "reopened" (fewer Rogues, contraband banned there so worth more), land tax starts, and the next
  district is named.

| | Solo | Crew |
|---|---|---|
| Week 1 | Tag, claim, first boat trip | Shared base, first contract |
| Month 1 | First deed | First Charter |
| Month 6 | Several deeds and a known trade | Several Charters; first into the Torreya depot |
| Winning | Your name on the map | A Charter held through a Survey |

Story fixes that go with it: PvP is legal because the Recovery Act gives land to whoever builds on
it, farms it and holds it (Florida really had a law like that in 1842); your level is your Zone tag's
clearance tier; and Rogue numbers in a district fall as players stabilise it, so the fight can be won.

## Keeping people for months

In the order the reviewers would build it. Each step makes the next one possible.

| # | What | Why it comes here | Size |
|---|---|---|---|
| 1 | **Fair raids.** Raid windows the owner picks, far less damage while a whole crew is offline, lock bypass that takes longer on better doors, tools that wear out, a cap on what one raid can take, and a ruin you can rebuild from. | Nobody builds big while a base falls in a minute. | Small to medium |
| 2 | **A real economy.** Shops with limited stock, prices that move with what players sell, goods that weigh something. | Without scarcity there is nothing to trade. | Medium |
| 3 | **Land rights and upkeep.** Nobody else builds inside your claim; a daily land tax that grows with the size of the base; unpaid places decay. | Stops the first big crew owning everything forever, and gives cash a use. | Medium to large |
| 4 | **Production buildings and fuel.** Stills, workshops, generators that need feeding. | Reasons to log in daily and to need each other. | Medium |
| 5 | **The Survey.** Titles, Charters, the chapter scoreboard. | The end goal. | Medium |
| 6 | **Jobs, bounties, reputation, contraband.** | The black market needs laws to break and taxes to dodge. | Large |

The planned "phase 3" had the right contents in the wrong order: fair raids have to come first.

**Massive bases today** are capped at 40 to 130 pieces a player (780 for a crew of six), earn nothing
for being big, and anyone can build inside your walls. The fix is a build budget tied to land you
hold and pay tax on.

**Solo against crews.** A crew of six gets revives, teleporting to each other and six times the
building. A solo player gets none of it. Suggested: a self-revive for solos, crew teleport to home
only, and a new-player shield (your claim marker and tools never drop; no PvP until level 5 or your first shot).

## Economies and black markets

- **Only players should make** guns and armor for sale, ammunition, medkits, and moonshine (from corn,
  at a still). Shops stop selling what players can make.
- **Cash needs somewhere to go:** land tax, boat fuel, helicopter and fast-travel fares, a 5% market
  fee, repairs. Today the dearest thing in the game is a $650 airboat.
- **A first black market, small enough to try:** moonshine and stolen freight are contraband. Contacts
  and dockhands refuse them; merchants, settlers and camp traders buy them. Selling builds **heat**.
  Carry contraband near a Contact or across the SR 20 bridge and it is confiscated. At high heat the
  Authority cuts you off (no contracts, no helicopter) and posts a bounty on you.
- **Later:** two reputations that pull against each other (the Authority, and the river people),
  dirty cash that has to be washed, fences with a daily budget, and timed runs across the Line.

## Fixed already, because they were plain bugs

- Three ways a player could crash the server or wipe another player's stall, found by the economy
  reviewer. A bad message can no longer crash the world, and there is a test that throws junk at it.
- A wrecked stall now spills its goods and till instead of deleting them.
- A money loop at the swamp camps (buy fish at $3, cook, sell meals back at $16, forever). Camps now
  hold an hour's stock and don't buy cooked meals.
- Road freight paid ten times what the rules file said. It now pays $25 plus $15 a kilometre.
- XP farms: free sidearm builds, hacking the same stunned target over and over, trading kills with a
  friend, and standing still in a safe camp.

## Decisions only you can make

1. **Does anything ever get wiped, and what survives the move to Unreal?** Everything about titles,
   mastery and "permanent" depends on the answer.
2. **How much can you lose while you sleep?** Everything (today), a capped share, or nothing outside
   a raid window you choose. "Never resets" and "raidable at any time" cannot both stand.
3. **How long to level 30?** I recommend about 50 hours.
4. **How many players in one world?** It is capped at 40 on 348 square miles today. Markets and
   bounties need a few hundred regulars, or a smaller map.
5. **Are solo players first-class, or prey for crews?**
6. **Can a titled home ever be taken, or only robbed?**
