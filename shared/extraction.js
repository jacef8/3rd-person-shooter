// Helicopter extraction: getting loot home without the long walk.
//
// At any Contact or landing zone, call a pickup (it fires a red flare everyone nearby can see).
// Hold the area for 90 seconds, staying inside the pickup zone, and a helicopter flies you and every
// squadmate in the zone, with everything you're carrying, straight to your stash houses. Leave the zone
// or go down and the pilot aborts. Other players see the flare and can try to take the load.
import activities from './data/activities.json' with { type: 'json' };

// Numbers live in shared/data/activities.json ("extraction").
export const EXTRACT = activities.extraction;
