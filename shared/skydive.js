// Jumping from the helicopter: freefall, the squirrel suit, and the parachute. The server owns how
// high you are; the client runs the same numbers so the fall looks smooth between snapshots.
import ACT from './data/activities.json' with { type: 'json' };

export const SKY = ACT.airTaxi.jump;

/** How fast you drop (m/s) and how fast you can move sideways (m/s) in each part of the jump. */
export function airRates(mode) {
  if (mode === 'suit') return { fall: SKY.suitFall, speed: SKY.suitSpeed };
  if (mode === 'chute') return { fall: SKY.chuteFall, speed: SKY.chuteSpeed };
  return { fall: SKY.fall, speed: SKY.fallSpeed };
}

/** Freefall and the suit switch on Sprint; the chute, once open, stays open. */
export function nextMode(mode, glide) {
  if (mode === 'chute') return 'chute';
  return glide ? 'suit' : 'fall';
}

/** One step of the fall: lower by the rate, and the chute opens by itself at the safety height. */
export function stepAir(air, dt) {
  air.alt = Math.max(0, air.alt - airRates(air.mode).fall * dt);
  if (air.mode !== 'chute' && air.alt <= SKY.autoChute) air.mode = 'chute';
  return air;
}
