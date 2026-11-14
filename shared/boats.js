// Boats: what floats where, and how a boat moves. Shared by the server (authoritative) and the
// client (prediction), so both agree on where the bank is.
import RIVER from './data/river.json' with { type: 'json' };

export const BOATS = RIVER.boats;
export const BOAT_RULES = RIVER.rules;

/** Deep enough to float a boat? The channel under a bridge counts as open water. */
export function floats(terrain, x, z) {
  if (Math.abs(x) > terrain.half - 3 || Math.abs(z) > terrain.half - 3) return false;   // the map's edge stops boats too
  if (terrain.height(x, z) < BOAT_RULES.minDepth) return true;
  for (const br of terrain.bridges || []) if (Math.abs(x - br.x) < br.len && Math.abs(z - br.z) < br.len && Math.hypot(x - br.x, z - br.z) < br.len - 55) return true;
  return false;
}

/**
 * Advance a boat one step. `input`: { throttle: -1..1, steer: -1..1 }. Returns the new
 * { x, z, yaw, speed }; running aground stops it dead.
 */
export function stepBoat(terrain, b, input, dt) {
  const def = BOATS[b.type];
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

/** Where a seat is, for a boat at (x, z, yaw): seat 0 is the driver at the stern. */
export function seatPos(b, seat) {
  const def = BOATS[b.type];
  const along = def.len * (-0.3 + 0.3 * seat), fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  return { x: b.x + fx * along, z: b.z + fz * along };
}
