// Boats and rides: what floats where, how a boat moves, and how everything on wheels (or hooves)
// gets about on land. Shared by the server (authoritative) and the client (prediction), so both
// agree on where the bank is and what a car can drive through.
import RIVER from './data/river.json' with { type: 'json' };
import RIDE_DATA from './data/rides.json' with { type: 'json' };
import { moveWithCollision, resolveCircle } from './world.js';
import { segDist } from './geography.js';

/** Land rides by type, each flagged `land`. */
export const RIDES = Object.fromEntries(Object.entries(RIDE_DATA.types).map(([k, v]) => [k, { ...v, land: true }]));
export const RIDE_RULES = RIDE_DATA.rules;
/** Everything you can get into, boats and rides alike (a ride's `seats` here is its seat count). */
export const BOATS = { ...RIVER.boats, ...Object.fromEntries(Object.entries(RIDES).map(([k, v]) => [k, { ...v, seats: v.seats.length, seatAt: v.seats }])) };
export const BOAT_RULES = RIVER.rules;
export const isLand = (type) => !!BOATS[type]?.land;

/** Deep enough to float a boat? The channel under a bridge counts as open water. */
export function floats(terrain, x, z) {
  if (Math.abs(x) > terrain.half - 3 || Math.abs(z) > terrain.half - 3) return false;   // the map's edge stops boats too
  if (terrain.height(x, z) < BOAT_RULES.minDepth) return true;
  for (const br of terrain.bridges || []) if (Math.abs(x - br.x) < br.len && Math.abs(z - br.z) < br.len && Math.hypot(x - br.x, z - br.z) < br.len - 55) return true;
  return false;
}

/** On (or right beside) a road? `roadsNear` is the map's road index. */
export function onRoad(roadsNear, x, z) {
  if (!roadsNear) return true;
  for (const s of roadsNear(x, z, 14)) if (segDist(x, z, s.x1, s.z1, s.x2, s.z2).d < s.width / 2 + 1.5) return true;
  return false;
}

/**
 * Advance a boat or ride one step. `input`: { throttle: -1..1, steer: -1..1 }. Rides need `env`:
 * { solids(x, z, r), roadsNear(x, z, r) } for what they can hit and where the blacktop is.
 * Returns the new { x, z, yaw, speed } (plus `y` and `hit`, the speed of any crash, for rides).
 */
export function stepBoat(terrain, b, input, dt, env = {}) {
  const def = BOATS[b.type];
  if (def.land) return stepRide(terrain, b, input, dt, env);
  const throttle = Math.max(-1, Math.min(1, input.throttle || 0)), steer = Math.max(-1, Math.min(1, input.steer || 0));
  const target = throttle >= 0 ? throttle * def.speed : throttle * def.reverse;
  let speed = b.speed || 0;
  const rate = (Math.abs(target) > Math.abs(speed) ? def.accel : def.accel * 1.5) * dt;
  speed += Math.max(-rate, Math.min(rate, target - speed));
  // Steering bites harder with some way on; a little even when stopped.
  const grip = Math.min(1, 0.25 + Math.abs(speed) / (def.speed * 0.5));
  const yaw = b.yaw - steer * def.turn * grip * dt * (speed < -0.1 ? -1 : 1);
  const dist = speed * dt, steps = Math.max(1, Math.ceil(Math.abs(dist) / 0.5));
  let x = b.x, z = b.z;
  const fx = Math.sin(yaw), fz = Math.cos(yaw), bow = (def.len / 2) * Math.sign(dist || 1);
  for (let i = 0; i < steps; i++) {
    const nx = x + fx * dist / steps, nz = z + fz * dist / steps;
    if (!floats(terrain, nx, nz) || !floats(terrain, nx + fx * bow, nz + fz * bow)) { speed = 0; break; }
    x = nx; z = nz;
  }
  return { x, z, yaw, speed };
}

/** How fast a ride can go where it is: full speed on a road, less off it, crawling through water. */
export function rideTop(terrain, def, x, z, roadsNear) {
  let top = def.speed * (onRoad(roadsNear, x, z) ? 1 : def.offroad);
  if (terrain.height(x, z) < RIDE_RULES.shallow && !def.wades) top *= RIDE_RULES.shallowMul;
  return top;
}

function stepRide(terrain, b, input, dt, env) {
  const def = BOATS[b.type];
  const throttle = Math.max(-1, Math.min(1, input.throttle || 0)), steer = Math.max(-1, Math.min(1, input.steer || 0));
  let speed = b.speed || 0;
  const top = rideTop(terrain, def, b.x, b.z, env.roadsNear);
  const target = throttle >= 0 ? throttle * top : throttle * def.reverse;
  // Gas speeds you up, the opposite pedal brakes hard, letting off coasts down; over the limit
  // (rolling off the road onto grass) you bleed speed fast.
  const braking = Math.abs(speed) > 0.3 && throttle !== 0 && Math.sign(throttle) !== Math.sign(speed);
  const rate = (braking ? def.brake : Math.abs(target) >= Math.abs(speed) ? def.accel : Math.abs(speed) > top + 0.5 ? def.brake * 0.6 : def.accel * 0.6) * dt;
  speed += Math.max(-rate, Math.min(rate, target - speed));
  // Wheels only steer while rolling, and less at speed; a horse or a board turns on the spot.
  const grip = def.animal || def.stand ? Math.min(1, 0.6 + Math.abs(speed) / 4) : Math.min(1, Math.abs(speed) / 3.5);
  const fast = 1 / (1 + Math.max(0, Math.abs(speed) - 12) / 16);
  const yaw = b.yaw - steer * def.turn * grip * fast * dt * (speed < -0.1 ? -1 : 1);
  const fx = Math.sin(yaw), fz = Math.cos(yaw), dist = speed * dt, r = def.wid / 2;
  const solids = env.solids ? env.solids(b.x, b.z, Math.abs(dist) + def.len) : [];
  const edge = terrain.half - 3;
  let m = moveWithCollision(b.x, b.z, fx * dist, fz * dist, r, solids, terrain, b.y);
  m.x = Math.max(-edge, Math.min(edge, m.x)); m.z = Math.max(-edge, Math.min(edge, m.z));
  // The nose (or the tail, backing up) mustn't end up inside anything either.
  const reach = (def.len / 2 - r) * (dist < 0 ? -1 : 1);
  let blocked = false;
  if (Math.abs(reach) > 0.1 && Math.abs(dist) > 1e-4) {
    const nx = m.x + fx * reach, nz = m.z + fz * reach, q = resolveCircle(nx, nz, r, solids, m.y);
    blocked = Math.hypot(q.x - nx, q.z - nz) > 0.05;
  }
  let hit = 0;
  const moved = Math.hypot(m.x - b.x, m.z - b.z);
  if (blocked) { hit = Math.abs(speed); speed = 0; m = { x: b.x, z: b.z, y: b.y ?? terrain.height(b.x, b.z) }; }
  else if (Math.abs(dist) > 0.02 && moved < Math.abs(dist) * 0.6) {
    // Scraped along a wall or stalled on a bank: lose most of the speed; head-on, all of it.
    if (moved < Math.abs(dist) * 0.15) hit = Math.abs(speed);
    speed = (moved / dt) * Math.sign(speed) * 0.7;
  }
  return { x: m.x, z: m.z, y: m.y, yaw, speed, hit: hit > RIDE_RULES.crashAt ? hit : 0 };
}

/** Where a seat is, for a boat or ride at (x, z, yaw): seat 0 is the driver. */
export function seatPos(b, seat) {
  const def = BOATS[b.type], fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  if (def.land) {
    const [side, along] = def.seatAt[seat] || [0, 0];
    return { x: b.x + fx * along + fz * side, z: b.z + fz * along - fx * side };
  }
  const along = def.len * (-0.3 + 0.3 * seat);
  return { x: b.x + fx * along, z: b.z + fz * along };
}

/** Where a rider's feet are (the character's origin) on a ride standing at height `y`: seated
 *  riders have their hips at the seat (0.5 m above the feet); a skateboarder stands on the deck. */
export function riderFeet(type, y) {
  const def = BOATS[type];
  return y + (def.stand ? def.seatH : def.seatH - 0.5);
}
