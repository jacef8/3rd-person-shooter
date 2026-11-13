// Stash house claims and home levels.
//
// A stash house isn't assigned to you: you claim it by planting a claim marker. Anything can be
// claimed: a town house or apartment room, a cave, rock outcrop, hollow cypress or fish camp, an
// abandoned vehicle (RV, bus, box truck, houseboat), or an open patch of ground (place the marker
// as a claim flag). Your home then levels up as you invest in it.

export const CLAIM = {
  plantMs: 8000,            // planting a marker is a long, interruptible action
  markerCraft: { wood: 10, salvage: 10 },
  markerPrice: { parts: 40 },   // sold by every Contact
  flagCost: { wood: 15 },
  flagHp: 2500,
  flagSlots: 24,
};

/** Home XP needed to reach each level (index = level - 1). */
export const HOME_LEVEL_XP = [0, 300, 800, 1500, 2500, 4000, 6000, 8500, 11500, 15000];
export const MAX_HOME_LEVEL = HOME_LEVEL_XP.length;
export function homeLevel(xp = 0) {
  let l = 1;
  while (l < MAX_HOME_LEVEL && xp >= HOME_LEVEL_XP[l]) l++;
  return l;
}

/** Where home XP comes from. */
export const HOME_XP = {
  perMaterial: 1,      // every unit of salvage/parts/tech/★ spent on upgrades
  intel: 20,           // per intel drive uploaded at this home
  build: 10,           // per piece built or upgraded inside your claim radius
  perHour: 60,         // just for holding it
};

/** What each home level gives you. */
export function homePerks(level) {
  return {
    storage: 4 * (level - 1),           // extra stash slots
    doorMul: 1 + 0.12 * (level - 1),    // stronger door / lock / flag
    radius: 15 + 5 * level,             // claim radius: building and alarms count inside it
    buildCap: 30 + 10 * level,          // structures you may own
  };
}
export const HOME_LEVEL_TEXT = [
  'Claimed',
  'Steel door and perimeter alarm unlocked',
  'Generator and workbench unlocked',
  'Blast door unlocked',
  '50 m alarm unlocked',
  '60-slot storage and 30/h generator unlocked',
  'Vault door and -50% workbench unlocked',
  '+12% door strength',
  '60/h generator unlocked',
  'Max level: fortress',
];
