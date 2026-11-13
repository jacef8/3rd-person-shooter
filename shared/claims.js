// Stash house claims and home levels.
//
// A stash house isn't assigned to you: you claim it by planting a claim marker. Anything can be
// claimed: a town house or apartment room, a cave, rock outcrop, hollow cypress or fish camp, an
// abandoned vehicle (RV, bus, box truck, houseboat), or an open patch of ground (place the marker
// as a claim flag). Your home then levels up as you invest in it.

import stash from './data/stash.json' with { type: 'json' };

// Numbers live in shared/data/stash.json.
export const CLAIM = stash.claim;

/** Home XP needed to reach each level (index = level - 1). */
export const HOME_LEVEL_XP = stash.homeLevelXp;
export const MAX_HOME_LEVEL = HOME_LEVEL_XP.length;
export function homeLevel(xp = 0) {
  let l = 1;
  while (l < MAX_HOME_LEVEL && xp >= HOME_LEVEL_XP[l]) l++;
  return l;
}

/** Where home XP comes from. */
export const HOME_XP = stash.homeXp;

/** What each home level gives you. */
export function homePerks(level) {
  const k = stash.homePerks, n = level - 1;
  return {
    storage: k.storagePerLevel * n,                 // extra stash slots
    doorMul: 1 + k.doorMulPerLevel * n,             // stronger door / lock / flag
    radius: k.radiusBase + k.radiusPerLevel * level, // claim radius: building and alarms count inside it
    buildCap: k.buildCapBase + k.buildCapPerLevel * level,   // structures you may own
  };
}
export const HOME_LEVEL_TEXT = stash.homeLevelText;
