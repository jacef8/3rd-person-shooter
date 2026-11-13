// Arsenal, gunsmith parts and level progression. Shared so the client shows exactly the stats the
// server uses in combat.
//
// Design: there are no random stat rolls. Power and variety come from your level, which unlocks
// weapon platforms, attachments, armor and paints on a fixed schedule, and from how you build your
// guns in the gunsmith. Attachments are trade-offs rather than straight upgrades, so a level-20
// player has more options than a level-2 player, not a guaranteed win.

// ------------------------------------------------------------------ progression
export const MAX_LEVEL = 30;

/** Total XP needed to reach `level` (level 1 = 0 XP). Each level costs a bit more than the last. */
export function xpForLevel(level) {
  const n = Math.max(0, Math.min(MAX_LEVEL, level) - 1);
  return 400 * n + 60 * n * (n - 1) / 2;
}

export function levelFromXp(xp) {
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}

export const XP = {
  rogueKill: 100,
  playerKill: 300,         // + 20 per level of the victim
  headshotKill: 50,
  breach: 150,
  survivalPerMinute: 25,   // time alive in the zone counts — you level just by playing
  pickup: 5,
  build: 40,
};

// ------------------------------------------------------------------ weapons
// Stats every build is measured on (shown as bars in the gunsmith).
// damage, range (m), rpm, mag, reloadMs, hipSpread, adsSpread (radians), recoil (pitch kick per shot),
// handling (0-100: ADS speed + swap), mobility (move speed multiplier).
export const ARCHETYPES = {
  sidearm: { label: 'Sidearm',        level: 1,  cost: 0,  semi: true,  damage: 30, range: 30, rpm: 320, mag: 12, reloadMs: 1500, hipSpread: 0.022, adsSpread: 0.010, recoil: 0.030, handling: 85, mobility: 1.05, pellets: 1, zoom: 1.2 },
  smg:     { label: 'SMG',            level: 1,  cost: 30, semi: false, damage: 19, range: 24, rpm: 860, mag: 32, reloadMs: 1900, hipSpread: 0.030, adsSpread: 0.016, recoil: 0.010, handling: 78, mobility: 1.03, pellets: 1, zoom: 1.25 },
  carbine: { label: 'Carbine',        level: 3,  cost: 45, semi: false, damage: 26, range: 45, rpm: 640, mag: 30, reloadMs: 2200, hipSpread: 0.028, adsSpread: 0.009, recoil: 0.012, handling: 62, mobility: 1.00, pellets: 1, zoom: 1.35 },
  shotgun: { label: 'Shotgun',        level: 6,  cost: 45, semi: true,  damage: 14, range: 13, rpm: 80,  mag: 7,  reloadMs: 2800, hipSpread: 0.075, adsSpread: 0.060, recoil: 0.060, handling: 60, mobility: 0.98, pellets: 8, zoom: 1.2 },
  dmr:     { label: 'Marksman Rifle', level: 10, cost: 60, semi: true,  damage: 90, range: 90, rpm: 120, mag: 10, reloadMs: 2600, hipSpread: 0.050, adsSpread: 0.003, recoil: 0.045, handling: 42, mobility: 0.95, pellets: 1, zoom: 1.6 },
  lmg:     { label: 'LMG',            level: 15, cost: 70, semi: false, damage: 24, range: 50, rpm: 580, mag: 80, reloadMs: 4400, hipSpread: 0.036, adsSpread: 0.014, recoil: 0.014, handling: 30, mobility: 0.90, pellets: 1, zoom: 1.4 },
};

export const SLOTS = ['optic', 'muzzle', 'barrel', 'underbarrel', 'magazine', 'stock', 'trigger'];
export const SLOT_LABELS = { optic: 'Optic', muzzle: 'Muzzle', barrel: 'Barrel', underbarrel: 'Underbarrel', magazine: 'Magazine', stock: 'Stock', trigger: 'Trigger', paint: 'Paint' };

const ALL = Object.keys(ARCHETYPES);
const LONG_GUNS = ['smg', 'carbine', 'shotgun', 'dmr', 'lmg'];

// Modifiers: *Mul fields multiply, flat fields add. Each part trades something away.
export const PARTS = {
  // Optics: change ADS zoom; magnified optics slow handling.
  iron:        { slot: 'optic', name: 'Iron Sights',        level: 1,  fits: ALL, mods: {} },
  reflex:      { slot: 'optic', name: 'Reflex Sight',       level: 2,  fits: ALL, mods: { zoom: 0.1, adsSpreadMul: 0.95 } },
  holo:        { slot: 'optic', name: 'Holographic Sight',  level: 5,  fits: LONG_GUNS, mods: { zoom: 0.2, adsSpreadMul: 0.9, handling: -3 } },
  acog:        { slot: 'optic', name: '4x Combat Scope',    level: 9,  fits: ['carbine', 'dmr', 'lmg'], mods: { zoom: 1.4, adsSpreadMul: 0.75, handling: -10 } },
  sniper:      { slot: 'optic', name: '8x Long Scope',      level: 17, fits: ['dmr'], mods: { zoom: 3.2, adsSpreadMul: 0.55, handling: -18, hipSpreadMul: 1.3 } },
  // Muzzles: recoil vs. stealth.
  noMuzzle:    { slot: 'muzzle', name: 'Bare Muzzle',       level: 1,  fits: ALL, mods: {} },
  compensator: { slot: 'muzzle', name: 'Compensator',       level: 3,  fits: ALL, mods: { recoilMul: 0.8, hipSpreadMul: 1.08 } },
  suppressor:  { slot: 'muzzle', name: 'Suppressor',        level: 7,  fits: ALL, mods: { damageMul: 0.92, rangeMul: 0.9, suppressed: true } },
  brake:       { slot: 'muzzle', name: 'Muzzle Brake',      level: 12, fits: LONG_GUNS, mods: { recoilMul: 0.68, handling: -6 } },
  choke:       { slot: 'muzzle', name: 'Tight Choke',       level: 8,  fits: ['shotgun'], mods: { hipSpreadMul: 0.7, adsSpreadMul: 0.7, damageMul: 0.95 } },
  // Barrels: range/damage vs. handling/mobility.
  stdBarrel:   { slot: 'barrel', name: 'Standard Barrel',   level: 1,  fits: ALL, mods: {} },
  shortBarrel: { slot: 'barrel', name: 'Short Barrel',      level: 4,  fits: ALL, mods: { rangeMul: 0.8, handling: 12, mobility: 0.04 } },
  longBarrel:  { slot: 'barrel', name: 'Extended Barrel',   level: 8,  fits: LONG_GUNS, mods: { rangeMul: 1.25, damageMul: 1.04, handling: -12, mobility: -0.03 } },
  matchBarrel: { slot: 'barrel', name: 'Match-Grade Barrel', level: 14, fits: ['carbine', 'dmr', 'sidearm'], mods: { adsSpreadMul: 0.75, rpmMul: 0.92 } },
  // Underbarrel.
  noUnder:     { slot: 'underbarrel', name: 'None',         level: 1,  fits: ALL, mods: {} },
  vgrip:       { slot: 'underbarrel', name: 'Vertical Grip', level: 2, fits: LONG_GUNS, mods: { recoilMul: 0.85, handling: -3 } },
  agrip:       { slot: 'underbarrel', name: 'Angled Grip',  level: 6,  fits: LONG_GUNS, mods: { handling: 12, recoilMul: 1.05 } },
  laser:       { slot: 'underbarrel', name: 'Laser Module', level: 10, fits: ALL, mods: { hipSpreadMul: 0.7 } },
  bipod:       { slot: 'underbarrel', name: 'Bipod',        level: 13, fits: ['carbine', 'dmr', 'lmg'], mods: { crouchSpreadMul: 0.55, crouchRecoilMul: 0.5, handling: -8 } },
  // Magazines: capacity vs. reload speed.
  stdMag:      { slot: 'magazine', name: 'Standard Magazine', level: 1, fits: ALL, mods: {} },
  extMag:      { slot: 'magazine', name: 'Extended Magazine', level: 5, fits: ALL, mods: { magMul: 1.4, reloadMsMul: 1.15, mobility: -0.02 } },
  fastMag:     { slot: 'magazine', name: 'Quick-Change Mag',  level: 11, fits: ALL, mods: { reloadMsMul: 0.7, magMul: 0.85 } },
  drum:        { slot: 'magazine', name: 'Drum Magazine',     level: 18, fits: ['smg', 'carbine', 'lmg', 'shotgun'], mods: { magMul: 2.0, reloadMsMul: 1.45, handling: -10, mobility: -0.03 } },
  // Stocks.
  stdStock:    { slot: 'stock', name: 'Standard Stock',     level: 1,  fits: ALL, mods: {} },
  lightStock:  { slot: 'stock', name: 'Skeleton Stock',     level: 3,  fits: LONG_GUNS, mods: { handling: 10, recoilMul: 1.1 } },
  heavyStock:  { slot: 'stock', name: 'Padded Heavy Stock', level: 9,  fits: LONG_GUNS, mods: { recoilMul: 0.8, handling: -10 } },
  noStock:     { slot: 'stock', name: 'Stockless',          level: 16, fits: ['smg', 'carbine', 'shotgun'], mods: { mobility: 0.07, handling: 15, recoilMul: 1.3, adsSpreadMul: 1.15 } },
  // Triggers.
  stdTrigger:  { slot: 'trigger', name: 'Standard Trigger', level: 1,  fits: ALL, mods: {} },
  matchTrig:   { slot: 'trigger', name: 'Match Trigger',    level: 7,  fits: ALL, mods: { adsSpreadMul: 0.9, rpmMul: 0.95 } },
  hairTrig:    { slot: 'trigger', name: 'Hair Trigger',     level: 12, fits: ALL, mods: { rpmMul: 1.12, recoilMul: 1.12 } },
};

export const DEFAULT_PARTS = { optic: 'iron', muzzle: 'noMuzzle', barrel: 'stdBarrel', underbarrel: 'noUnder', magazine: 'stdMag', stock: 'stdStock', trigger: 'stdTrigger' };

export const PAINTS = {
  factory:  { name: 'Factory Black', level: 1,  color: '#232323' },
  urban:    { name: 'Urban Grey',    level: 2,  color: '#6b7076' },
  desert:   { name: 'Desert Tan',    level: 4,  color: '#b39a6b' },
  woodland: { name: 'Woodland',      level: 8,  color: '#4d5e3a' },
  arctic:   { name: 'Arctic White',  level: 12, color: '#d9dde0' },
  ember:    { name: 'Ember Orange',  level: 20, color: '#e0661c' },
  gold:     { name: 'Veteran Gold',  level: 30, color: '#d4af37' },
};

export const ARMORS = {
  light:  { name: 'Light Vest',    level: 1,  cost: 20, armor: 60,  mobility: 0 },
  medium: { name: 'Plate Carrier', level: 6,  cost: 45, armor: 110, mobility: -0.04 },
  heavy:  { name: 'Heavy Plates',  level: 14, cost: 80, armor: 170, mobility: -0.10 },
};

// ------------------------------------------------------------------ items
let idCounter = 0;
export function newItemId() {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function makeWeapon(archetype, parts = {}, paint = 'factory') {
  return { id: newItemId(), kind: 'weapon', archetype, name: ARCHETYPES[archetype].label, parts: { ...DEFAULT_PARTS, ...parts }, paint };
}

export function makeArmor(type) {
  return { id: newItemId(), kind: 'armor', type, name: ARMORS[type].name };
}

export function makeConsumable(kind) {
  return { id: newItemId(), kind, name: kind === 'medkit' ? 'Medkit' : 'Ammo Box' };
}

/** Fixed (non-random) world supplies: what you find is resources, not stat-rolled gear. */
export function worldSupply(index) {
  const k = index % 5;
  if (k === 0 || k === 3) return { kind: 'parts', name: 'Parts Cache', amount: 15 };
  if (k === 1) return { kind: 'ammo', name: 'Ammo Box', amount: 60 };
  if (k === 2) return { kind: 'medkit', name: 'Medkit' };
  return { kind: 'parts', name: 'Parts Cache', amount: 10 };
}

export function partFits(partId, archetype) {
  const part = PARTS[partId];
  return !!part && part.fits.includes(archetype);
}

/** Compute final weapon stats from the platform plus every attached part. */
export function weaponStats(item) {
  if (!item) return null;
  const a = ARCHETYPES[item.archetype];
  const s = {
    damage: a.damage, range: a.range, rpm: a.rpm, mag: a.mag, reloadMs: a.reloadMs,
    hipSpread: a.hipSpread, adsSpread: a.adsSpread, recoil: a.recoil, handling: a.handling,
    mobility: a.mobility, pellets: a.pellets, zoom: a.zoom, semi: a.semi,
    suppressed: false, crouchSpread: 1, crouchRecoil: 1,
  };
  for (const slot of SLOTS) {
    const id = item.parts?.[slot] || DEFAULT_PARTS[slot];
    if (!partFits(id, item.archetype)) continue;
    const m = PARTS[id].mods;
    for (const [k, v] of Object.entries(m)) {
      if (k === 'suppressed') s.suppressed = true;
      else if (k.endsWith('Mul')) { const key = k.slice(0, -3); s[key] = (key in s ? s[key] : 1) * v; }
      else s[k] += v;
    }
  }
  s.mag = Math.max(1, Math.round(s.mag));
  s.handling = Math.max(5, Math.min(100, s.handling));
  return s;
}

export function armorStats(item) {
  if (!item || item.kind !== 'armor') return { armor: 0, mobility: 0 };
  const a = ARMORS[item.type];
  return { armor: a.armor, mobility: a.mobility };
}

/** Everything that becomes available exactly at `level` (for level-up announcements). */
export function unlocksAt(level) {
  const out = [];
  for (const [k, a] of Object.entries(ARCHETYPES)) if (a.level === level) out.push({ type: 'weapon', id: k, name: a.label });
  for (const [k, p] of Object.entries(PARTS)) if (p.level === level && p.level > 1) out.push({ type: 'part', id: k, name: p.name });
  for (const [k, p] of Object.entries(PAINTS)) if (p.level === level && p.level > 1) out.push({ type: 'paint', id: k, name: `${p.name} paint` });
  for (const [k, a] of Object.entries(ARMORS)) if (a.level === level && a.level > 1) out.push({ type: 'armor', id: k, name: a.name });
  return out;
}

/** 0..1 normalised stat values for the gunsmith bars (higher is always better). */
export function statBars(s) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return {
    Damage: clamp((s.damage * s.pellets) / 120),
    Range: clamp(s.range / 110),
    Accuracy: clamp(1 - s.adsSpread / 0.07),
    'Hip Fire': clamp(1 - s.hipSpread / 0.09),
    Stability: clamp(1 - s.recoil / 0.07),
    Handling: clamp(s.handling / 100),
    'Fire Rate': clamp(s.rpm / 1000),
    Capacity: clamp(s.mag / 160),
    Mobility: clamp((s.mobility - 0.8) / 0.35),
  };
}
