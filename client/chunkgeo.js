// Building geometry for the near world (walls, roofs, shop fronts, house trim, furniture) as plain
// arrays. No three.js and no page here, so the same code runs in a background worker
// (client/chunkworker.js) as well as on the page (client/worldview.js).

export const CHUNK = 160;
export const TREE_FULL = 70;   // trees in chunks within this many metres get the full build
export const SKY_TOP = 0x5b8fc7, SKY_HORIZON = 0xc6d9e6;
export const COLORS = {
  building: [0.62, 0.6, 0.57], warehouse: [0.5, 0.47, 0.42], farmhouse: [0.72, 0.66, 0.55], barn: [0.55, 0.22, 0.18],
  housewall: [0.54, 0.43, 0.32], ownwall: [0.31, 0.54, 0.35], crate: [1.0, 0.54, 0.16], cover: [0.61, 0.61, 0.58],
  rock: [0.48, 0.48, 0.46], border: [0.17, 0.18, 0.2], car: [0.45, 0.2, 0.2], adobe: [0.78, 0.62, 0.45],
  boulder: [0.44, 0.42, 0.4], cactus: [0.3, 0.5, 0.25], cavewall: [0.38, 0.36, 0.34], caveroof: [0.4, 0.38, 0.35],
  rockwall: [0.62, 0.5, 0.38], logwall: [0.36, 0.25, 0.16], plankwall: [0.55, 0.42, 0.28], jetty: [0.5, 0.38, 0.25],
  roomwall: [0.66, 0.63, 0.58], dam: [0.62, 0.62, 0.6], scrub: [0.35, 0.42, 0.24],
  tower: [0.6, 0.62, 0.64], beacon: [0.9, 0.12, 0.08], tank: [0.86, 0.88, 0.9], fence: [0.56, 0.58, 0.6], equipment: [0.5, 0.55, 0.5],
  pole: [0.38, 0.28, 0.19], solar: [0.12, 0.16, 0.28], counter: [0.42, 0.3, 0.2], rack: [0.3, 0.22, 0.15], marker: [0.95, 0.95, 0.92], hangar: [0.66, 0.68, 0.68], plane: [0.93, 0.93, 0.9], windsock: [1, 0.45, 0.1],
};
// Each real building is painted one colour (picked by its id), so a street isn't all the same.
export const HOME_COLORS = [[0.9, 0.88, 0.82], [0.82, 0.8, 0.72], [0.74, 0.79, 0.82], [0.86, 0.8, 0.62], [0.64, 0.72, 0.64], [0.72, 0.62, 0.52], [0.6, 0.62, 0.65], [0.8, 0.72, 0.68], [0.68, 0.44, 0.36], [0.52, 0.58, 0.64]];
export const BARN_COLORS = [[0.55, 0.22, 0.18], [0.46, 0.4, 0.34], [0.62, 0.62, 0.6], [0.5, 0.2, 0.16], [0.38, 0.44, 0.38]];
export const WAREHOUSE_COLORS = [[0.5, 0.47, 0.42], [0.6, 0.6, 0.58], [0.45, 0.5, 0.54], [0.66, 0.6, 0.48]];
export const BRICK_COLORS = [[0.64, 0.31, 0.24], [0.56, 0.27, 0.21], [0.72, 0.43, 0.32], [0.8, 0.68, 0.54], [0.5, 0.33, 0.27], [0.62, 0.38, 0.3]];
export const STUCCO_COLORS = [[0.86, 0.84, 0.78], [0.9, 0.86, 0.74], [0.82, 0.76, 0.66], [0.78, 0.82, 0.8], [0.88, 0.8, 0.7], [0.92, 0.9, 0.86]];   // Florida stucco: whites, creams, tans, a pale green
export const BLOCK_COLORS = [[0.84, 0.83, 0.8], [0.78, 0.76, 0.7], [0.86, 0.82, 0.7], [0.7, 0.72, 0.72]];   // painted concrete block
export const CIVIC_COLORS = [[0.62, 0.36, 0.28], [0.7, 0.44, 0.33], [0.8, 0.76, 0.68], [0.56, 0.33, 0.27]];
export const ROOF_COLORS = [[0.3, 0.28, 0.27], [0.42, 0.24, 0.18], [0.36, 0.37, 0.39], [0.5, 0.5, 0.48], [0.26, 0.3, 0.34]];
export const METAL_ROOFS = [[0.62, 0.63, 0.64], [0.55, 0.57, 0.58], [0.3, 0.36, 0.44], [0.45, 0.22, 0.18]];   // galvanised, faded blue, barn red
export const FLOOR_COLORS = { home: [0.5, 0.38, 0.26], farmhouse: [0.5, 0.38, 0.26], barn: [0.42, 0.36, 0.28], civic: [0.56, 0.5, 0.42] };
export const FLOOR_DEFAULT = [0.5, 0.5, 0.49];
export const VEHICLE_COLORS = { rv: [0.86, 0.84, 0.78], bus: [0.95, 0.72, 0.12], truck: [0.82, 0.82, 0.84], houseboat: [0.55, 0.65, 0.72] };
// North Florida palette: farm fields, pine flatwoods, white sandhills, red-clay hills, river swamp.
export const GROUND = {
  plains: [0.4, 0.48, 0.26], forest: [0.24, 0.33, 0.17], desert: [0.85, 0.82, 0.68], mountain: [0.46, 0.4, 0.26],
  swamp: [0.2, 0.26, 0.15], sand: [0.78, 0.72, 0.55], mud: [0.29, 0.26, 0.19], road: [0.24, 0.25, 0.26], dirt: [0.56, 0.47, 0.33], town: [0.3, 0.31, 0.33],
};
export const CAR_COLORS = [[0.48, 0.13, 0.13], [0.16, 0.25, 0.42], [0.27, 0.27, 0.27], [0.73, 0.71, 0.6], [0.18, 0.35, 0.23]];
export const hash = (id) => (Math.imul(id | 0, 2654435761 | 0) >>> 0);
export const pick = (list, id) => list[hash(id) % list.length];

/** Append a box (no bottom face) to flat geometry arrays. A turned box is built in its own frame and turned into place. */
export function pushBox(buf, b, color, tile, noBottom = false) {
  const turned = b.ang !== undefined;
  const { minX, minZ, maxX, maxZ } = turned ? { minX: -b.hw, minZ: -b.hd, maxX: b.hw, maxZ: b.hd } : b;
  const ca = turned ? b.ca : 1, sa = turned ? b.sa : 0, ox = turned ? b.cx : 0, oz = turned ? b.cz : 0;
  const y0 = b.y0 || 0, h = y0 + b.h;
  const faces = [
    // normal, 4 corners (counter-clockwise from outside), uv size
    [[1, 0, 0], [[maxX, y0, maxZ], [maxX, y0, minZ], [maxX, h, minZ], [maxX, h, maxZ]], maxZ - minZ],
    [[-1, 0, 0], [[minX, y0, minZ], [minX, y0, maxZ], [minX, h, maxZ], [minX, h, minZ]], maxZ - minZ],
    [[0, 0, 1], [[minX, y0, maxZ], [maxX, y0, maxZ], [maxX, h, maxZ], [minX, h, maxZ]], maxX - minX],
    [[0, 0, -1], [[maxX, y0, minZ], [minX, y0, minZ], [minX, h, minZ], [maxX, h, minZ]], maxX - minX],
    [[0, 1, 0], [[minX, h, maxZ], [maxX, h, maxZ], [maxX, h, minZ], [minX, h, minZ]], 0],
    [[0, -1, 0], [[minX, y0, minZ], [maxX, y0, minZ], [maxX, y0, maxZ], [minX, y0, maxZ]], 0],
  ];
  for (const [n, corners, width] of faces) {
    if (noBottom && n[1] === -1) continue;   // (standing on the floor: its underside is never seen)
    const base = buf.pos.length / 3;
    const top = n[1] === 1;
    corners.forEach(([x, y, z], i) => {
      buf.pos.push(ox + x * ca - z * sa, y, oz + x * sa + z * ca);
      buf.nor.push(n[0] * ca - n[2] * sa, n[1], n[0] * sa + n[2] * ca);
      const shade = top ? 0.85 : 1;
      buf.col.push(color[0] * shade, color[1] * shade, color[2] * shade);
      if (buf.uv) {
        if (!tile || top || width < 1.2) buf.uv.push(0.02, 0.02);   // a plain wall pixel of the texture
        else buf.uv.push(((i === 1 || i === 2) ? width : 0) / tile, (y > y0 ? b.h : 0) / tile);
      }
    });
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
/** A steel ladder: two rails and a rung every 30 cm, across the box's wider side. */
export const LADDER_STEEL = [0.42, 0.44, 0.46];
export function pushLadder(buf, b) {
  const turned = b.ang !== undefined;
  const ca = turned ? b.ca : 1, sa = turned ? b.sa : 0;
  const cx = turned ? b.cx : (b.minX + b.maxX) / 2, cz = turned ? b.cz : (b.minZ + b.maxZ) / 2;
  const hw = turned ? b.hw : (b.maxX - b.minX) / 2, hd = turned ? b.hd : (b.maxZ - b.minZ) / 2;
  const wideX = hw >= hd, half = Math.max(hw, hd), y0 = b.y0 || 0, h = b.h;
  const piece = (u, w, yy, hh) => {   // u: along the ladder's width; w: that piece's width
    const lx = wideX ? u : 0, lz = wideX ? 0 : u;
    pushBox(buf, { ang: b.ang || 0, ca, sa, cx: cx + lx * ca - lz * sa, cz: cz + lx * sa + lz * ca, hw: wideX ? w / 2 : 0.03, hd: wideX ? 0.03 : w / 2, y0: yy, h: hh }, LADDER_STEEL, 0);
  };
  piece(-half + 0.03, 0.06, y0, h + 0.9);   // the rails run up past the top, to hold on to
  piece(half - 0.03, 0.06, y0, h + 0.9);
  for (let y = y0 + 0.3; y < y0 + h; y += 0.3) piece(0, half * 2 - 0.06, y, 0.035);
}
/** A pitched roof over a building record: one per piece of a real building, turned to its walls. */
export function pushRoof(buf, r, color, wall, low = false) {
  if (!r.rects) return roofPiece(buf, r.minX, r.minZ, r.maxX, r.maxZ, r.top, color, wall, 1, 0, 0, 0, low);
  const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
  for (const [x0, z0, x1, z1] of r.rects) roofPiece(buf, x0, z0, x1, z1, r.top, color, wall, ca, sa, r.cx, r.cz, low);
}
/**
 * The top of a flat-roofed building (shops, offices, halls): a dark roof membrane, a parapet in a trim
 * colour round the edge (the roof line you see from the street), and, on a big roof, a unit or two of
 * air conditioning. For drawing only (nothing up there to stand on).
 */
export function pushFlatRoof(buf, r, wall) {
  const turned = !!r.rects;
  const pieces = turned ? r.rects : [[r.minX, r.minZ, r.maxX, r.maxZ]];
  const ca = turned ? Math.cos(r.ang) : 1, sa = turned ? Math.sin(r.ang) : 0, ox = turned ? r.cx : 0, oz = turned ? r.cz : 0;
  const lum = wall[0] * 0.3 + wall[1] * 0.59 + wall[2] * 0.11;
  const trim = lum > 0.5 ? [0.3, 0.29, 0.28] : [0.84, 0.8, 0.72];   // a cream cornice on dark walls, dark bronze on light ones
  const tar = [0.27, 0.27, 0.28], unit = [0.66, 0.67, 0.68], top = r.top, seed = hash(r.bldg ?? `${r.minX},${r.minZ}`);
  const at = (x0, z0, x1, z1, y0, h, c) => {
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    pushBox(buf, { ang: r.ang || 0, ca, sa, cx: ox + mx * ca - mz * sa, cz: oz + mx * sa + mz * ca, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, y0, h }, c, 0);
  };
  pieces.forEach(([x0, z0, x1, z1], i) => {
    at(x0 + 0.1, z0 + 0.1, x1 - 0.1, z1 - 0.1, top - 0.08, 0.12, tar);
    const o = 0.1, t = 0.3, yb = top - 0.5, h = 1.2;   // cap: from just below the top of the wall to 0.7 m above it
    at(x0 - o, z0 - o, x1 + o, z0 - o + t, yb, h, trim);
    at(x0 - o, z1 + o - t, x1 + o, z1 + o, yb, h, trim);
    at(x0 - o, z0 - o + t, x0 - o + t, z1 + o - t, yb, h, trim);
    at(x1 + o - t, z0 - o + t, x1 + o, z1 + o - t, yb, h, trim);
    const w = x1 - x0, d = z1 - z0;
    if (i === 0 && w * d > 140) {
      for (let k = 0; k < 1 + (seed % 2) + (w * d > 900 ? 1 : 0); k++) {
        const ux = x0 + w * (0.25 + 0.5 * (((seed >> (k * 3)) % 7) / 7)), uz = z0 + d * (0.25 + 0.5 * (((seed >> (k * 3 + 9)) % 5) / 5));
        at(ux - 0.9, uz - 0.7, ux + 0.9, uz + 0.7, top, 1.1, unit);
      }
    }
  });
}
/** Two slopes along the long side and two gable ends, over one rectangle (in its own frame, turned into place). */
/**
 * A shop front on the wall that faces the road (`toward`: a point on it): a glass front in panes with
 * a door in the middle, a kick plate under it, an awning over it, and a row of windows on each floor
 * above. For drawing only.
 */
export const GLASS = [0.16, 0.22, 0.28], FRAME = [0.14, 0.13, 0.12], KICK = [0.55, 0.54, 0.52], AWNINGS = [[0.55, 0.12, 0.1], [0.12, 0.3, 0.2], [0.14, 0.2, 0.4], [0.3, 0.3, 0.32], [0.5, 0.36, 0.16]];
export function pushStorefront(buf, r, toward) {
  const turned = !!r.rects;
  const pieces = turned ? r.rects : [[r.minX, r.minZ, r.maxX, r.maxZ]];
  const ca = turned ? Math.cos(r.ang) : 1, sa = turned ? Math.sin(r.ang) : 0, ox = turned ? r.cx : 0, oz = turned ? r.cz : 0;
  // The road point in the building's own frame; the piece and wall that face it.
  const tx = toward.x - ox, tz = toward.z - oz, lx = tx * ca + tz * sa, lz = -tx * sa + tz * ca;
  let best = null;
  for (const [x0, z0, x1, z1] of pieces) {
    const cxp = (x0 + x1) / 2, czp = (z0 + z1) / 2;
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wx = nx ? (nx > 0 ? x1 : x0) : cxp, wz = nz ? (nz > 0 ? z1 : z0) : czp;
      const score = (lx - wx) * nx + (lz - wz) * nz;   // how far out in front of this wall the road is
      const len = nx ? z1 - z0 : x1 - x0;
      if (len > 4 && (!best || score > best.score)) best = { score, nx, nz, wx, wz, len, ux: nz, uz: -nx };
    }
  }
  if (!best || best.score < 1) return;
  const { nx, nz, wx, wz, len, ux, uz } = best, seed = hash(r.bldg ?? 1), floor = r.floor ?? 0, height = r.top - floor;
  const at = (u, out, y0, h, w, d, c) => {   // a box centred `u` along the wall, `out` from it
    const px = wx + ux * u + nx * out, pz = wz + uz * u + nz * out;
    const hw = Math.abs(ux) * w / 2 + Math.abs(nx) * d / 2, hd = Math.abs(uz) * w / 2 + Math.abs(nz) * d / 2;
    pushBox(buf, { ang: r.ang || 0, ca, sa, cx: ox + px * ca - pz * sa, cz: oz + px * sa + pz * ca, hw, hd, y0, h }, c, 0);
  };
  const front = Math.min(len - 1.2, Math.max(4, len * 0.7)), y0 = floor + 0.5, gh = Math.min(2.3, height - 1.2);
  if (gh < 1.6) return;
  // Glass in panes about 2 m wide, framed; the door in the middle.
  const n = Math.max(2, Math.round(front / 2.1)), pw = front / n;
  at(0, 0.04, y0 - 0.5, 0.5, front + 0.2, 0.06, KICK);
  at(0, 0.05, y0 + gh, 0.14, front + 0.2, 0.08, FRAME);
  for (let i = 0; i < n; i++) {
    const u = -front / 2 + pw * (i + 0.5);
    const door = i === Math.floor(n / 2);
    if (door) { at(u, 0.05, floor, gh + 0.5, Math.min(1.9, pw - 0.1), 0.06, FRAME); at(u, 0.08, floor + 0.08, gh + 0.32, Math.min(1.6, pw - 0.35), 0.03, GLASS); }
    else at(u, 0.05, y0, gh, pw - 0.12, 0.05, GLASS);
    at(-front / 2 + pw * i, 0.06, y0, gh, 0.1, 0.07, FRAME);
  }
  at(front / 2, 0.06, y0, gh, 0.1, 0.07, FRAME);
  // Awning (most shops have one) over the front.
  // Awning (most shops have one) over the front: the canopy and a hanging front edge, kept under the
  // business sign (towns.js puts it from 3.4 m up).
  if (seed % 3 !== 0) {
    const ay = Math.min(y0 + gh + 0.16, floor + 3.05), col = AWNINGS[seed % AWNINGS.length];
    at(0, 0.55, ay, 0.12, front + 0.4, 1.1, col);
    at(0, 1.08, ay - 0.28, 0.4, front + 0.4, 0.04, col);
  }
  // Upper floors: a window every 3 m.
  for (let fy = floor + 3.6; fy + 1.6 < r.top - 0.4; fy += 3.4) {
    const m = Math.max(1, Math.floor((len - 2) / 3));
    for (let i = 0; i < m; i++) at(-((m - 1) * 3) / 2 + i * 3, 0.04, fy + 0.3, 1.4, 1.2, 0.05, GLASS);
  }
}
/**
 * A house's outside, so it reads as a house and not a box: a block foundation, white corner boards,
 * windows along every wall (a white frame, the glass, a sill and, on some houses, shutters), a frame
 * and a concrete stoop at each door, a porch roof on two posts over the door that faces the road, and
 * an air conditioner by a side wall. All drawing only (the walls are what's solid). `glass` gets the
 * window panes (a shiny material that shows the sky).
 */
export const TRIM = [0.93, 0.92, 0.88], SILL = [0.86, 0.85, 0.8], STOOP = [0.62, 0.61, 0.58], FOUND = [0.46, 0.45, 0.43], PANE = [0.06, 0.08, 0.1];
export const SHUTTERS = [[0.13, 0.22, 0.16], [0.1, 0.11, 0.12], [0.14, 0.2, 0.34], [0.42, 0.13, 0.1], [0.36, 0.33, 0.28]];
export const DOORS = [[0.42, 0.13, 0.1], [0.1, 0.11, 0.12], [0.14, 0.2, 0.34], [0.93, 0.92, 0.88], [0.4, 0.28, 0.16], [0.13, 0.3, 0.2]];
// ---- furniture (shared/world.js furnish): one solid box each, drawn here with its real parts.
export const WOODS = [[0.42, 0.28, 0.17], [0.55, 0.38, 0.24], [0.3, 0.2, 0.13], [0.62, 0.5, 0.36]];
export const FABRICS = [[0.32, 0.36, 0.42], [0.45, 0.3, 0.24], [0.28, 0.38, 0.3], [0.52, 0.48, 0.42], [0.2, 0.22, 0.28], [0.55, 0.22, 0.2]];
export const BLANKETS = [[0.62, 0.66, 0.72], [0.35, 0.45, 0.62], [0.6, 0.35, 0.35], [0.45, 0.55, 0.42], [0.78, 0.74, 0.62]];
export const GOODS = [[0.8, 0.25, 0.2], [0.2, 0.45, 0.75], [0.9, 0.75, 0.25], [0.3, 0.6, 0.35], [0.85, 0.85, 0.82], [0.6, 0.35, 0.6], [0.95, 0.55, 0.2]];
export const METAL = [0.55, 0.57, 0.6], DARK = [0.12, 0.12, 0.13], WHITE = [0.9, 0.9, 0.88], STEEL_BLUE = [0.18, 0.32, 0.6], RACK_ORANGE = [0.85, 0.42, 0.12];
export function pushFurniture(buf, b) {
  const fx = b.fr?.[0] ?? 0, fz = b.fr?.[1] ?? 1, ca = fz, sa = -fx, ang = Math.atan2(-fx, fz);
  const cx = b.cx ?? (b.minX + b.maxX) / 2, cz = b.cz ?? (b.minZ + b.maxZ) / 2, y = b.y0 || 0;
  const L = b.fl || 1, D = b.fd || 1, H = b.h, s = b.fs || 1;
  const pick = (list, k = 0) => list[(s >> k) % list.length];
  // A part `w` along by `d` deep, its centre `u` along and `v` out from the middle (back is -D/2).
  const P = (u, v, y0, h, w, d, c) => pushBox(buf, { ang, ca, sa, cx: cx + ca * u - sa * v, cz: cz + sa * u + ca * v, hw: w / 2, hd: d / 2, y0: y + y0, h }, c, 0, true);
  const wood = pick(WOODS), fab = pick(FABRICS, 2);
  switch (b.furn) {
    case 'bed': {   // L across the wall, D out into the room
      P(0, 0, 0, 0.32, L, D, wood);
      P(0, 0.04, 0.32, 0.18, L - 0.08, D - 0.12, WHITE);                          // mattress
      P(0, 0.22, 0.5, 0.07, L - 0.04, D - 0.5, pick(BLANKETS, 3));                // blanket
      for (const k of L > 1.5 ? [-L / 4, L / 4] : [0]) P(k, -D / 2 + 0.32, 0.5, 0.13, L > 1.5 ? L / 2 - 0.12 : L - 0.3, 0.4, WHITE);   // pillows
      P(0, -D / 2 + 0.04, 0, 1.05, L, 0.08, wood);                                // headboard
      break;
    }
    case 'couch':
    case 'chair':
      P(0, 0.05, 0.1, 0.32, L, D - 0.1, fab);
      P(0, -D / 2 + 0.13, 0.1, H - 0.1, L, 0.26, fab);                           // back
      for (const k of [-1, 1]) P(k * (L / 2 - 0.09), 0.05, 0.1, 0.55, 0.18, D - 0.1, fab);   // arms
      for (const k of L > 1.2 ? [-L / 4, L / 4] : [0]) P(k, 0.12, 0.42, 0.12, L > 1.2 ? L / 2 - 0.22 : L - 0.4, D - 0.4, fab.map((c) => c * 1.12));   // cushions
      P(0, 0, 0, 0.1, L - 0.1, D - 0.1, DARK);
      break;
    case 'table': {
      P(0, 0, H - 0.05, 0.05, L, D, wood);
      for (const a of [-1, 1]) for (const c of [-1, 1]) P(a * (L / 2 - 0.08), c * (D / 2 - 0.08), 0, H - 0.05, 0.07, 0.07, wood);
      for (const a of [-1, 1]) for (const c of L > 1.3 ? [-L / 4, L / 4] : [0]) {   // chairs tucked in
        P(c, a * (D / 2 + 0.22), 0.44, 0.05, 0.42, 0.42, wood);
        P(c, a * (D / 2 + 0.41), 0.44, 0.5, 0.42, 0.05, wood);
        for (const q of [-1, 1]) for (const r of [-1, 1]) P(c + q * 0.18, a * (D / 2 + 0.22) + r * 0.18, 0, 0.44, 0.04, 0.04, wood);
      }
      break;
    }
    case 'tv':
      P(0, 0, 0, H, L, D, DARK.map((c) => c * 2.2));
      P(0, -D / 2 + 0.15, H, 0.7, L * 0.85, 0.05, DARK);                          // the set
      P(0, -D / 2 + 0.15, H + 0.08, 0.56, L * 0.8, 0.055, [0.05, 0.07, 0.1]);
      break;
    case 'kitchen':
      P(0, 0, 0, H - 0.04, L, D, pick(WOODS, 1).map((c) => c * 1.2));
      P(0, 0.02, H - 0.04, 0.04, L + 0.02, D + 0.04, [0.82, 0.8, 0.76]);           // counter top
      P(-L / 4, 0.05, H, 0.02, 0.7, 0.45, METAL);                                 // sink
      P(L / 2 - 0.4, 0.02, H - 0.04, 0.05, 0.62, D, DARK);                         // the stove top
      P(0, -D / 2 + 0.17, 1.45, 0.75, L, 0.34, pick(WOODS, 1).map((c) => c * 1.2));   // wall cupboards
      for (let i = 0; i < Math.floor(L / 0.6); i++) P(-L / 2 + 0.3 + i * 0.6, D / 2 + 0.005, 0.12, H - 0.25, 0.54, 0.01, pick(WOODS, 1).map((c) => c * 1.35));
      break;
    case 'fridge':
      P(0, 0, 0, H, L, D, WHITE);
      P(L / 2 - 0.08, D / 2 + 0.02, 0.9, 0.6, 0.03, 0.04, METAL);
      P(0, D / 2 + 0.003, 1.18, 0.015, L - 0.04, 0.01, METAL.map((c) => c * 0.7));
      break;
    case 'dresser':
    case 'cabinet':
      P(0, 0, 0.08, H - 0.08, L, D, b.furn === 'cabinet' ? METAL.map((c) => c * 0.8) : wood);
      for (let i = 0; i < 3; i++) P(0, D / 2 + 0.005, 0.2 + i * (H - 0.25) / 3, 0.02, L - 0.12, 0.012, DARK);
      break;
    case 'books':
    case 'shelf':
    case 'aisle': {
      const frame = b.furn === 'books' ? wood : METAL, rows = b.furn === 'books' ? 5 : 4, both = b.furn === 'aisle';
      for (const k of [-1, 1]) P(k * (L / 2 - 0.03), 0, 0, H, 0.06, D, frame);
      if (!both) P(0, -D / 2 + 0.02, 0, H, L, 0.03, frame);
      else P(0, 0, 0, H, L, 0.03, frame);
      for (let i = 0; i < rows; i++) {
        const yy = 0.08 + i * (H - 0.12) / rows;
        P(0, 0, yy, 0.03, L, D, frame);
        // What's on it: a few blocks of books or goods per row (one box each: whole rows of single
        // items cost too much to draw), a gap here and there.
        for (const face of both ? [-1, 1] : [0]) {
          const n = 3, w = (L - 0.16) / n;
          for (let j = 0; j < n; j++) {
            const pick2 = (s >> ((i * 5 + j * 3 + (face > 0 ? 7 : 0)) % 24)) % 9;
            if (pick2 === 0) continue;
            const hh = Math.min((b.furn === 'books' ? 0.22 : 0.2 + (pick2 % 3) * 0.06), (H - 0.12) / rows - 0.06);
            P(-L / 2 + 0.08 + w * (j + 0.5), face ? face * D / 4 : 0.02, yy + 0.03, hh, w - 0.04, face ? D / 2 - 0.08 : D - 0.1, GOODS[(s + i * 3 + j) % GOODS.length].map((c) => (b.furn === 'books' ? c * 0.75 : c)));
          }
        }
      }
      break;
    }
    case 'counter':
      P(0, 0, 0, H - 0.05, L, D, wood);
      P(0, 0.03, H - 0.05, 0.05, L + 0.06, D + 0.08, [0.75, 0.73, 0.7]);
      P(L / 2 - 0.4, 0, H, 0.22, 0.38, 0.32, DARK);                                // the till
      break;
    case 'cooler':
      P(0, 0, 0, H, L, D, WHITE.map((c) => c * 0.85));
      P(0, D / 2 + 0.01, 0.12, H - 0.35, L - 0.12, 0.02, [0.55, 0.7, 0.78]);       // glass doors
      for (let i = 0; i < 4; i++) P(0, D / 2 - 0.2, 0.25 + i * 0.4, 0.22, L - 0.3, 0.3, GOODS[(s + i) % GOODS.length]);
      P(0, D / 2 + 0.02, H - 0.2, 0.18, L, 0.03, [0.85, 0.2, 0.15]);
      break;
    case 'desk':
      P(0, 0, H - 0.04, 0.04, L, D, wood);
      for (const k of [-1, 1]) P(k * (L / 2 - 0.03), 0, 0, H - 0.04, 0.05, D, wood);
      P(-L / 4, -D / 2 + 0.2, H, 0.36, 0.5, 0.04, DARK);                           // monitor
      P(-L / 4, -D / 2 + 0.25, H, 0.03, 0.18, 0.12, DARK);
      P(0, D / 2 + 0.35, 0, 0.48, 0.48, 0.48, DARK.map((c) => c * 2.5));              // the chair
      P(0, D / 2 + 0.58, 0.48, 0.5, 0.46, 0.06, DARK.map((c) => c * 2.5));
      break;
    case 'bench':
      P(0, 0, H - 0.08, 0.08, L, D, wood);
      for (const k of [-1, 1]) P(k * (L / 2 - 0.1), 0, 0, H - 0.08, 0.08, D - 0.1, wood.map((c) => c * 0.8));
      if (H > 0.7) P(0, -D / 2 + 0.2, H, 0.5, L - 0.1, 0.35, METAL);                // tools on the workbench
      break;
    case 'rack':
      for (const a of [-1, 1]) for (const c of [-1, 1]) P(a * (L / 2 - 0.05), c * (D / 2 - 0.05), 0, H, 0.08, 0.08, STEEL_BLUE);
      for (const yy of [0.15, H * 0.45, H * 0.85]) {
        for (const c of [-1, 1]) P(0, c * (D / 2 - 0.05), yy, 0.1, L, 0.06, RACK_ORANGE);
        for (const k of [-1, 0, 1]) if ((s >> (k + 3 + Math.round(yy * 3))) % 4) P(k * L / 3, 0, yy + 0.1, 0.6 + ((s >> (k + 5)) % 3) * 0.1, L / 3 - 0.15, D - 0.15, k ? [0.62, 0.48, 0.3] : [0.7, 0.56, 0.36]);
      }
      break;
    case 'crates':
    case 'pallets': {
      P(0, 0, 0, 0.14, L, D, [0.58, 0.46, 0.3]);
      if (b.furn === 'pallets') { P(0, 0, 0.14, H - 0.14, L - 0.1, D - 0.1, [0.75, 0.72, 0.65]); break; }
      const top = H - 0.14, two = top > 1.4;
      P(0, 0, 0.14, two ? top / 2 : top, L - 0.06, D - 0.06, [0.62, 0.47, 0.28]);
      P(0, D / 2 - 0.02, 0.14 + (two ? top / 4 : top / 2) - 0.05, 0.1, L - 0.04, 0.02, [0.42, 0.3, 0.17]);
      if (two) P(0.1, -0.05, 0.14 + top / 2, top / 2, L - 0.3, D - 0.3, [0.66, 0.52, 0.32]);
      break;
    }
    case 'hay':
      for (let yy = 0; yy < H - 0.1; yy += 0.95) P(0, 0, yy, Math.min(0.92, H - yy), L, D, [0.78, 0.66, 0.34].map((c) => c * (0.9 + ((s >> Math.round(yy)) % 3) * 0.06)));
      break;
    default:
      P(0, 0, 0, H, L, D, wood);
  }
}
export function pushHouseDetail(buf, glass, r, roofColor) {
  const rects = r.rects || [[r.minX, r.minZ, r.maxX, r.maxZ]];
  const turned = !!r.rects, ca = turned ? Math.cos(r.ang) : 1, sa = turned ? Math.sin(r.ang) : 0, ox = turned ? r.cx : 0, oz = turned ? r.cz : 0;
  const seed = hash(r.bldg ?? 7), floor = r.floor ?? 0, wallTop = r.top - (r.roof ? 0 : 0.3), wallH = wallTop - floor;
  if (wallH < 2.2) return;
  const box = (b, lx, lz, hw, hd, y0, h, c) => pushBox(b, { ang: r.ang || 0, ca, sa, cx: ox + lx * ca - lz * sa, cz: oz + lx * sa + lz * ca, hw, hd, y0, h }, c, 0);
  // Outside wall runs: each piece's sides, minus where another piece carries on past them.
  const runs = [];
  rects.forEach(([x0, z0, x1, z1], i) => {
    for (const sd of [{ nx: 0, nz: -1, at: z0, a: x0, b: x1 }, { nx: 0, nz: 1, at: z1, a: x0, b: x1 }, { nx: -1, nz: 0, at: x0, a: z0, b: z1 }, { nx: 1, nz: 0, at: x1, a: z0, b: z1 }]) {
      let parts = [[sd.a, sd.b]];
      const out = sd.at + (sd.nx || sd.nz) * 0.05;
      rects.forEach(([qx0, qz0, qx1, qz1], j) => {
        if (j === i) return;
        const crosses = sd.nz ? qz0 < out && qz1 > out : qx0 < out && qx1 > out;
        if (!crosses) return;
        const c0 = sd.nz ? qx0 : qz0, c1 = sd.nz ? qx1 : qz1;
        parts = parts.flatMap(([a, b]) => (c1 <= a || c0 >= b ? [[a, b]] : [[a, Math.max(a, c0)], [Math.min(b, c1), b]].filter(([p, q]) => q - p > 0.3)));
      });
      for (const [a, b] of parts) runs.push({ ...sd, a, b, len: b - a });
    }
  });
  // A box `w` wide along a run, `d` deep out from it, centred `u` along it and `out` in front.
  const onRun = (b, run, u, out, y0, h, w, d, c) => {
    const lx = run.nz ? u : run.at + run.nx * out, lz = run.nz ? run.at + run.nz * out : u;
    box(b, lx, lz, run.nz ? w / 2 : d / 2, run.nz ? d / 2 : w / 2, y0, h, c);
  };
  const local = (x, z) => { const dx = x - ox, dz = z - oz; return [dx * ca + dz * sa, -dx * sa + dz * ca]; };
  const doors = (r.doors || []).map((d) => local(d.x, d.z)), doorTops = (r.doors || []).map((d) => d.top ?? floor + 2.42);
  const shutters = seed % 3 !== 0 ? SHUTTERS[(seed >> 3) % SHUTTERS.length] : null, doorC = DOORS[(seed >> 6) % DOORS.length];
  const storeys = Math.max(1, Math.round(wallH / 3.2));
  for (const run of runs) {
    // Foundation: block skirting under the wall, down into the ground a little.
    onRun(buf, run, (run.a + run.b) / 2, 0.06, floor - 0.7, 0.85, run.len + 0.12, 0.12, FOUND);
    // Corner boards at the ends.
    for (const u of [run.a + 0.06, run.b - 0.06]) onRun(buf, run, u, 0.05, floor + 0.1, wallH - 0.1, 0.16, 0.06, TRIM);
    // A frieze board under the eaves.
    onRun(buf, run, (run.a + run.b) / 2, 0.05, wallTop - 0.28, 0.22, run.len, 0.05, TRIM);
    // The doors on this run: their trim and a stoop.
    const here = doors.map((q, i) => [q, doorTops[i]]).filter(([[lx, lz]]) => (run.nz ? Math.abs(lz - run.at) < 0.5 && lx > run.a && lx < run.b : Math.abs(lx - run.at) < 0.5 && lz > run.a && lz < run.b));
    const onThis = here.map(([[lx, lz]]) => (run.nz ? lx : lz));
    // The frame goes round the real opening (its top follows the ground at the door, as the wall does).
    here.forEach(([, top], i) => {
      const u = onThis[i];
      for (const s of [-1, 1]) onRun(buf, run, u + s * 0.86, 0.06, floor, top - floor + 0.08, 0.14, 0.08, TRIM);
      onRun(buf, run, u, 0.06, top, 0.16, 1.86, 0.08, TRIM);
      onRun(buf, run, u, 0.75, floor - 0.6, 0.6, 2.1, 1.5, STOOP);
    });
    // Windows every ~3.2 m, kept clear of the doors and the corners.
    const n = Math.floor((run.len - 1.4) / 3.2);
    for (let k = 0; k < n; k++) {
      const u = run.a + (run.len - (n - 1) * 3.2) / 2 + k * 3.2;
      if (onThis.some((du) => Math.abs(du - u) < 1.9)) continue;
      for (let f = 0; f < storeys; f++) {
        const y = floor + 0.95 + f * 3.2;
        if (y + 1.3 > wallTop - 0.3) break;
        onRun(buf, run, u, 0.03, y - 0.1, 1.5, 1.24, 0.06, TRIM);          // frame
        onRun(glass, run, u, 0.07, y, 1.3, 1.0, 0.03, PANE);               // glass
        onRun(buf, run, u, 0.07, y + 0.62, 0.06, 1.0, 0.035, TRIM);          // the sash bar
        onRun(buf, run, u, 0.1, y - 0.16, 0.08, 1.4, 0.16, SILL);          // sill
        if (shutters) for (const s of [-1, 1]) onRun(buf, run, u + s * 0.86, 0.06, y - 0.05, 1.4, 0.42, 0.05, shutters);
      }
    }
  }
  // The front door (the first one): a porch roof on two posts, and the door itself shut in its frame.
  const front = (r.doors || [])[0];
  if (front) {
    const [lx, lz] = local(front.x, front.z), run = runs.find((q) => (q.nz ? Math.abs(lz - q.at) < 0.5 : Math.abs(lx - q.at) < 0.5));
    if (run) {
      const u = run.nz ? lx : lz, pw = Math.min(run.len - 0.4, 4.2), py = Math.max(floor + 2.75, (front.top ?? 0) + 0.35);
      onRun(buf, run, u, 1.25, py, 0.14, pw, 2.5, roofColor);                 // the porch roof
      onRun(buf, run, u, 2.46, py - 0.12, 0.14, pw, 0.08, TRIM);              // its fascia
      for (const s of [-1, 1]) onRun(buf, run, u + s * (pw / 2 - 0.15), 2.35, floor - 0.1, py - floor + 0.1, 0.16, 0.16, TRIM);   // posts
    }
  }
  // An air conditioner against a side wall.
  const side = runs.filter((q) => q.len > 3)[(seed >> 9) % Math.max(1, runs.length)];
  if (side) {
    const u = side.a + side.len * 0.3;
    onRun(buf, side, u, 0.55, floor - 0.6, 0.95, 0.9, 0.85, [0.72, 0.73, 0.72]);
  }
}
export function roofPiece(buf, minX, minZ, maxX, maxZ, top, color, wall, ca, sa, cx, cz, low = false) {
  const o = low ? 0.5 : 0.4, x0 = minX - o, x1 = maxX + o, z0 = minZ - o, z1 = maxZ + o, y = top;
  // (low: the shallow metal roof of a warehouse or big shed)
  const alongX = x1 - x0 >= z1 - z0, span = alongX ? z1 - z0 : x1 - x0, rh = low ? Math.min(2.2, span * 0.1) : Math.min(3.2, span * 0.38);
  const face = (pts, n, c) => {
    const l = Math.hypot(...n), nn = n.map((v) => v / l), base = buf.pos.length / 3;
    for (const [px, py, pz] of pts) { buf.pos.push(cx + px * ca - pz * sa, py, cz + px * sa + pz * ca); buf.nor.push(nn[0] * ca - nn[2] * sa, nn[1], nn[0] * sa + nn[2] * ca); buf.col.push(...c); if (buf.uv) buf.uv.push(0.02, 0.02); }
    if (pts.length === 4) buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3); else buf.idx.push(base, base + 1, base + 2);
  };
  if (alongX) {
    const zm = (z0 + z1) / 2;
    face([[x1, y, z0], [x0, y, z0], [x0, y + rh, zm], [x1, y + rh, zm]], [0, span / 2, -rh], color);
    face([[x0, y, z1], [x1, y, z1], [x1, y + rh, zm], [x0, y + rh, zm]], [0, span / 2, rh], color);
    face([[x0, y, z0], [x0, y, z1], [x0, y + rh, zm]], [-1, 0, 0], wall);
    face([[x1, y, z1], [x1, y, z0], [x1, y + rh, zm]], [1, 0, 0], wall);
  } else {
    const xm = (x0 + x1) / 2;
    face([[x0, y, z0], [x0, y, z1], [xm, y + rh, z1], [xm, y + rh, z0]], [-rh, span / 2, 0], color);
    face([[x1, y, z1], [x1, y, z0], [xm, y + rh, z0], [xm, y + rh, z1]], [rh, span / 2, 0], color);
    face([[x1, y, z0], [x0, y, z0], [xm, y + rh, z0]], [0, 0, -1], wall);
    face([[x0, y, z1], [x1, y, z1], [xm, y + rh, z1]], [0, 0, 1], wall);
  }
}
export const newBuf = (uv) => ({ pos: [], nor: [], col: [], idx: [], ...(uv ? { uv: [] } : {}) });

/** Colour, and which wall texture, for a box. `ownHouse`: the id of your own house (its walls show apart). */
export function paint(b, ownHouse = null) {
  const id = b.bldg ?? b.id;
  switch (b.type) {
    // Real buildings dress by type: brick storefronts and halls, lap-sided houses, metal barns and warehouses.
    case 'building': { if (b.real) { const k = hash(id) % 6; return k < 3 ? [pick(BRICK_COLORS, id), 'brick'] : k < 5 ? [pick(STUCCO_COLORS, id), 'stucco'] : [pick(BLOCK_COLORS, id), 'block']; } const c = COLORS.building, v = hash(id) / 4294967296; return [[c[0] + (v - 0.5) * 0.15, c[1] + (v - 0.5) * 0.12, c[2] + (v - 0.5) * 0.1], 'office']; }
    case 'civic': return [pick(CIVIC_COLORS, id), b.real ? (hash(id) % 3 ? 'brick' : 'stucco') : 'office'];
    case 'home': return b.real && hash(id) % 4 === 1 ? [pick(BRICK_COLORS, id), 'brick'] : [pick(HOME_COLORS, id), 'siding'];   // a brick ranch house now and then
    case 'barn': return [b.real ? pick(BARN_COLORS, id) : COLORS.barn, b.real ? (hash(id) % 5 < 2 ? 'planks' : 'metal') : 'planks'];   // old wooden barns and metal ones
    case 'warehouse': return [b.real ? pick(WAREHOUSE_COLORS, id) : COLORS.warehouse, b.real ? 'metal' : null];
    case 'car': return [CAR_COLORS[b.id % CAR_COLORS.length], null];
    case 'vehiclebody': return [VEHICLE_COLORS[b.vtype] || COLORS.cover, null];
    case 'housewall': return [b.houseId === ownHouse ? COLORS.ownwall : COLORS.housewall, null];
    default: return [COLORS[b.type] || COLORS.cover, null];
  }
}
export const wallColor = (r) => paint({ type: r.type, bldg: r.bldg, real: r.real, id: r.bldg })[0];

/** The buffers of one chunk's buildings, in the order the page pairs them with materials. */
export const CHUNK_BUFS = ['office', 'siding', 'brick', 'stucco', 'block', 'metal', 'planks', 'plain', 'roof', 'shingles', 'panes', 'furn'];
const UV_BUFS = new Set(['office', 'siding', 'brick', 'stucco', 'block', 'metal', 'planks']);
/** Does a map box get drawn into the chunk's building buffers? (Trees, rocks, tanks, vehicles and the rest are drawn apart.) */
export function isChunkBox(b) {
  if (b.type === 'terminal' || b.type === 'rail' || b.type === 'tree' || b.type === 'pine' || b.type === 'canopy' || b.type === 'tank' || b.type === 'car' || b.type === 'vehiclebody') return false;
  return !(b.nature && (b.type === 'rock' || b.type === 'boulder'));
}
/**
 * Every building in one chunk as flat typed arrays.
 * `boxes`: the chunk's own map boxes (see isChunkBox); `bldgs`: its building records, with `front` set on
 * those with a shop front (the nearest point of road); `ownHouse`: your own house's id.
 * Returns { name: { pos, nor, col, uv?, idx } } for each non-empty buffer of CHUNK_BUFS.
 */
export function buildChunkBuffers({ boxes, bldgs, ownHouse = null }) {
  const B = Object.fromEntries(CHUNK_BUFS.map((k) => [k, newBuf(UV_BUFS.has(k))]));
  for (const b of boxes) {
    if (b.type === 'ladder') { pushLadder(B.plain, b); continue; }
    if (b.type === 'furn') { pushFurniture(B.furn, b); continue; }
    const [c, tex] = paint(b, ownHouse);
    pushBox(tex && B[tex] && UV_BUFS.has(tex) ? B[tex] : B.plain, b, c, tex ? 4 : 0);
  }
  for (const r of bldgs) {
    if (r.roof) pushRoof(r.type === 'barn' ? B.roof : B.shingles, r, pick(r.type === 'barn' ? METAL_ROOFS : ROOF_COLORS, r.bldg), wallColor(r));
    if (r.type === 'home') pushHouseDetail(B.plain, B.panes, r, pick(ROOF_COLORS, r.bldg).map((v) => v * 0.8));
    else if (r.type === 'warehouse') pushRoof(B.roof, r, pick(METAL_ROOFS, r.bldg), wallColor(r), true);
    else if (r.type === 'building' || r.type === 'civic') pushFlatRoof(B.plain, r, wallColor(r));
    if (r.front) pushStorefront(B.plain, r, r.front);
    // A floor on the building's level pad (real buildings; the others stand on town paving).
    if (r.pad !== undefined && r.rects) {
      const ca = Math.cos(r.ang), sa = Math.sin(r.ang);
      for (const [x0, z0, x1, z1] of r.rects) {
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        pushBox(B.plain, { ang: r.ang, ca, sa, cx: r.cx + mx * ca - mz * sa, cz: r.cz + mx * sa + mz * ca, hw: (x1 - x0) / 2 - 0.2, hd: (z1 - z0) / 2 - 0.2, y0: r.pad - 0.3, h: 0.34 }, FLOOR_COLORS[r.type] || FLOOR_DEFAULT, 0);
      }
    } else if (r.pad !== undefined) pushBox(B.plain, { minX: r.minX + 0.2, minZ: r.minZ + 0.2, maxX: r.maxX - 0.2, maxZ: r.maxZ - 0.2, y0: r.pad - 0.3, h: 0.34 }, FLOOR_COLORS[r.type] || FLOOR_DEFAULT, 0);
  }
  const out = {};
  for (const k of CHUNK_BUFS) {
    const b = B[k];
    if (!b.idx.length) continue;
    const n = b.pos.length / 3;
    out[k] = { pos: new Float32Array(b.pos), nor: new Float32Array(b.nor), col: new Float32Array(b.col), idx: n > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx), ...(b.uv ? { uv: new Float32Array(b.uv) } : {}) };
  }
  return out;
}
/** The typed arrays' memory, to hand over to the page without a copy. */
export function chunkTransfer(out) {
  const list = [];
  for (const b of Object.values(out)) for (const a of Object.values(b)) list.push(a.buffer);
  return list;
}
