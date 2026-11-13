// Helicopter extraction: getting loot home without the long walk.
//
// At any Contact or landing zone, call a pickup (it fires a red flare everyone nearby can see).
// Hold the area for 90 seconds, staying inside the pickup zone, and a helicopter flies you and every
// squadmate in the zone, with everything you're carrying, straight to your stash houses. Leave the zone
// or go down and the pilot aborts. Other players see the flare and can try to take the load.
export const EXTRACT = {
  holdMs: 90_000,          // from flare to touchdown
  radius: 25,              // pickup zone radius, metres (~80 ft): the caller must stay inside it
  callRange: 20,           // how close to a Contact / landing zone you must be to call it (~65 ft)
  alertRange: 800,         // players this close get a flare alert (~half a mile)
  cooldownMs: 5 * 60_000,  // per player, after a pickup or an abort
  xp: 30,
};
