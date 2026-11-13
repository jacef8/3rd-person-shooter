// Shared world definition + geometry helpers. Runs in both Node (server) and the browser (client).
// The server generates the map from a seed and ships it to clients, so both sides collide against
// exactly the same boxes.

export const WORLD_HALF = 165;          // map spans [-WORLD_HALF, WORLD_HALF] on X and Z (meters)
export const PLAYER_RADIUS = 0.45;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.2;
export const STAND_EYE = 1.6;
export const CROUCH_EYE = 1.05;
export const WALK_SPEED = 4.5;
export const SPRINT_SPEED = 7.0;
export const CROUCH_SPEED = 2.4;
export const INTERACT_RANGE = 2.4;

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(minX, minZ, maxX, maxZ, h, type = 'building', extra = {}) {
  return { minX, minZ, maxX, maxZ, h, type, ...extra };
}

/**
 * Procedural city: a grid of blocks separated by streets. Most blocks hold solid buildings,
 * some are parks full of low cover, and a set of blocks each hold one walled stash house
 * with a breachable door and a stash crate inside.
 */
export function generateMap(seed = 1337) {
  const rand = mulberry32(seed);
  const boxes = [];
  const houses = [];
  const lootSpawns = [];
  const playerSpawns = [];
  const terminals = [];

  const BLOCK = 30;
  const STREET = 12;
  const PITCH = BLOCK + STREET;
  const N = 7;
  const start = -((N * PITCH - STREET) / 2);

  // Pick which blocks become stash-house blocks and parks (deterministic from seed).
  const cells = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) cells.push([i, j]);
  for (let k = cells.length - 1; k > 0; k--) {
    const r = Math.floor(rand() * (k + 1));
    [cells[k], cells[r]] = [cells[r], cells[k]];
  }
  const houseCells = new Set(cells.slice(0, 12).map(([i, j]) => `${i},${j}`));
  const parkCells = new Set(cells.slice(12, 20).map(([i, j]) => `${i},${j}`));

  let houseId = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x0 = start + i * PITCH;
      const z0 = start + j * PITCH;
      const x1 = x0 + BLOCK;
      const z1 = z0 + BLOCK;
      const key = `${i},${j}`;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;

      if (houseCells.has(key)) {
        // Walled stash house: 12x12 compound, door gap on the +Z side.
        const hs = 6, t = 0.4, h = 3.2, gap = 1.8;
        const id = houseId++;
        boxes.push(box(cx - hs, cz - hs, cx + hs, cz - hs + t, h, 'housewall', { houseId: id }));
        boxes.push(box(cx - hs, cz - hs, cx - hs + t, cz + hs, h, 'housewall', { houseId: id }));
        boxes.push(box(cx + hs - t, cz - hs, cx + hs, cz + hs, h, 'housewall', { houseId: id }));
        boxes.push(box(cx - hs, cz + hs - t, cx - gap / 2, cz + hs, h, 'housewall', { houseId: id }));
        boxes.push(box(cx + gap / 2, cz + hs - t, cx + hs, cz + hs, h, 'housewall', { houseId: id }));
        // Stash crate (solid, interactable).
        boxes.push(box(cx - 0.7, cz - 3.5, cx + 0.7, cz - 2.7, 0.9, 'crate', { houseId: id }));
        houses.push({
          id,
          x: cx,
          z: cz,
          crate: { x: cx, z: cz - 3.1 },
          door: { minX: cx - gap / 2, minZ: cz + hs - t, maxX: cx + gap / 2, maxZ: cz + hs, h: 2.6 },
        });
        // A few cover pieces in the yard around the house.
        boxes.push(box(x0 + 2, z1 - 4, x0 + 5, z1 - 3.4, 1.1, 'cover'));
        boxes.push(box(x1 - 5, z1 - 4, x1 - 2, z1 - 3.4, 1.1, 'cover'));
        lootSpawns.push({ x: cx + 3, z: cz + 2 }, { x: x0 + 3, z: z0 + 3 });
      } else if (parkCells.has(key)) {
        // Park: scattered low walls, planters and wrecks — good for crouch-cover fights.
        const count = 6 + Math.floor(rand() * 5);
        for (let k = 0; k < count; k++) {
          const w = 1.5 + rand() * 3.5;
          const d = 0.6 + rand() * 1.4;
          const px = x0 + 3 + rand() * (BLOCK - 6 - w);
          const pz = z0 + 3 + rand() * (BLOCK - 6 - d);
          const rot = rand() < 0.5;
          boxes.push(rot ? box(px, pz, px + d, pz + w, 1.1 + rand() * 0.4, 'cover')
                         : box(px, pz, px + w, pz + d, 1.1 + rand() * 0.4, 'cover'));
        }
        for (let k = 0; k < 4; k++) lootSpawns.push({ x: x0 + 2 + rand() * (BLOCK - 4), z: z0 + 2 + rand() * (BLOCK - 4) });
        playerSpawns.push({ x: cx, z: cz });
      } else {
        // Solid buildings: split the block into 1–3 towers with an alley.
        // Every other building block gets a hackable data terminal on its street-facing (+Z) wall.
        if ((i + j) % 2 === 0) {
          const tx = x0 + 6;
          boxes.push(box(tx - 0.4, z1 - 1, tx + 0.4, z1 - 0.65, 1.5, 'terminal', { terminalId: terminals.length }));
          terminals.push({ id: terminals.length, x: tx, z: z1 - 0.65 });
        }
        const split = rand();
        const tall = () => 6 + rand() * 22;
        if (split < 0.33) {
          boxes.push(box(x0 + 1, z0 + 1, x1 - 1, z1 - 1, tall()));
        } else if (split < 0.66) {
          boxes.push(box(x0 + 1, z0 + 1, cx - 2, z1 - 1, tall()));
          boxes.push(box(cx + 2, z0 + 1, x1 - 1, z1 - 1, tall()));
          lootSpawns.push({ x: cx, z: cz });
        } else {
          boxes.push(box(x0 + 1, z0 + 1, x1 - 1, cz - 2, tall()));
          boxes.push(box(x0 + 1, cz + 2, cx - 2, z1 - 1, tall()));
          boxes.push(box(cx + 2, cz + 2, x1 - 1, z1 - 1, tall()));
          lootSpawns.push({ x: cx - 4, z: cz }, { x: cx, z: cz + 6 });
        }
      }
    }
  }

  // Streets: abandoned cars and barriers as cover, plus loot.
  for (let s = 0; s < N - 1; s++) {
    const mid = start + s * PITCH + BLOCK + STREET / 2;
    for (let k = 0; k < 7; k++) {
      const along = start + rand() * (N * PITCH - STREET);
      const off = (rand() - 0.5) * 5;
      const car = rand() < 0.6;
      const len = car ? 4.4 : 2.8, wid = car ? 1.9 : 0.6, h = car ? 1.4 : 1.1;
      const type = car ? 'car' : 'cover';
      // street running along Z (vertical) at x=mid, and along X at z=mid
      if (rand() < 0.5) boxes.push(box(mid + off - wid / 2, along, mid + off + wid / 2, along + len, h, type));
      else boxes.push(box(along, mid + off - wid / 2, along + len, mid + off + wid / 2, h, type));
    }
    for (let k = 0; k < 4; k++) {
      const along = start + rand() * (N * PITCH - STREET);
      lootSpawns.push(rand() < 0.5 ? { x: mid + (rand() - 0.5) * 6, z: along } : { x: along, z: mid + (rand() - 0.5) * 6 });
    }
    playerSpawns.push({ x: mid, z: start - 4 }, { x: start - 4, z: mid });
  }

  // Map border walls.
  const W = WORLD_HALF;
  boxes.push(box(-W - 2, -W - 2, W + 2, -W, 6, 'border'));
  boxes.push(box(-W - 2, W, W + 2, W + 2, 6, 'border'));
  boxes.push(box(-W - 2, -W, -W, W, 6, 'border'));
  boxes.push(box(W, -W, W + 2, W, 6, 'border'));

  // Drop any spawn point that ended up inside geometry.
  const free = (p) => !boxes.some((b) => circleOverlapsBox(p.x, p.z, 1.0, b));
  return {
    seed,
    half: WORLD_HALF,
    boxes,
    houses,
    lootSpawns: lootSpawns.filter(free),
    playerSpawns: playerSpawns.filter(free),
    terminals,
  };
}

export function circleOverlapsBox(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

/** Push a circle out of every solid box. Returns the corrected position. */
export function resolveCircle(x, z, r, solids) {
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const b of solids) {
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      let dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r;
        z = cz + (dz / d) * r;
      } else {
        // Center is inside the box: push out along the axis of least penetration.
        const pen = [x - b.minX + r, b.maxX - x + r, z - b.minZ + r, b.maxZ - z + r];
        const m = pen.indexOf(Math.min(...pen));
        if (m === 0) x = b.minX - r; else if (m === 1) x = b.maxX + r;
        else if (m === 2) z = b.minZ - r; else z = b.maxZ + r;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/**
 * Move from (x,z) by (dx,dz) in small substeps so fast movement can't tunnel through thin walls.
 */
export function moveWithCollision(x, z, dx, dz, r, solids) {
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.15));
  for (let i = 0; i < steps; i++) {
    const p = resolveCircle(x + dx / steps, z + dz / steps, r, solids);
    x = p.x; z = p.z;
  }
  return { x, z };
}

/** Ray vs 3D axis-aligned box (y from 0..h). Returns hit distance t or Infinity. */
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], mn = [minX, minY, minZ], mx = [maxX, maxY, maxZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < mn[a] || o[a] > mx[a]) return Infinity;
    } else {
      let t1 = (mn[a] - o[a]) / d[a];
      let t2 = (mx[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

export function rayAgainstBoxes(ox, oy, oz, dx, dy, dz, list, maxDist = Infinity) {
  let best = maxDist, hit = null;
  for (const b of list) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b.minX, 0, b.minZ, b.maxX, b.h, b.maxZ);
    if (t < best) { best = t; hit = b; }
  }
  return { t: best, box: hit };
}

/** Character hit volume as a box; returns { minX..maxZ, minY, maxY }. */
export function characterBounds(x, z, crouch) {
  const r = 0.4;
  return { minX: x - r, minZ: z - r, maxX: x + r, maxZ: z + r, minY: 0, maxY: crouch ? CROUCH_HEIGHT : STAND_HEIGHT };
}
