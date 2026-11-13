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
  contract: 0,             // per-contract XP lives in CONTRACT_TYPES
  supplyDrop: 200,
  discoverContact: 50,
  hackTerminal: 60,
  hackDoor: 120,
  intelBanked: 40,         // per intel drive banked at your stash (carrying it is the risk)
  markAssist: 40,
  squadShare: 0.25,        // squadmates nearby get this share of your kill/bank XP
  playerKill: 300,         // + 20 per level of the victim
  headshotKill: 50,
  breach: 150,
  survivalPerMinute: 25,   // time alive in the zone counts — you level just by playing
  pickup: 5,
  build: 40,
};

// ------------------------------------------------------------------ tech (gadgets)
// Tech costs "tech" (electronics) — the resource that powers gadgets.
export const GADGETS = {
  mark:     { name: 'Target Tagging',   level: 1,  cost: 0,  key: 'F', desc: 'Tag the enemy under your crosshair; your squad sees them through walls for 8s.' },
  hack:     { name: 'Terminal Hacking', level: 1,  cost: 0,  key: 'E', desc: 'Hack data terminals for intel and tech. Stand still for 5s.' },
  sensor:   { name: 'Sensor Grenade',   level: 2,  cost: 10, key: 'G', desc: 'Reveals everyone within 18m of where it lands to your squad for 10s — including cloaked players.' },
  camo:     { name: 'Optical Camo',     level: 4,  cost: 1,  key: 'V', desc: 'Near-invisible while crouched or moving slowly. Drains 1 tech every 2s. Firing or taking damage breaks it.' },
  doorHack: { name: 'Lock Bypass',      level: 8,  cost: 15, key: 'E', desc: 'Silently hack open a locked stash house door (8s). The owner is alerted.' },
  rally:    { name: 'Rally (squad leader)', level: 5, cost: 0, key: 'T', desc: 'Leader only: restores 50% armor and gives +20% damage for 10s to squadmates within 30m. 90s cooldown.' },
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
  // Field gear: requisitioned from Contacts with commendations, which you only earn from contracts
  // and world events. Earned by being active out in the map — never a random drop.
  intSup:      { slot: 'muzzle', name: 'Integrated Suppressor', level: 4, field: 3, fits: ALL, mods: { suppressed: true, rangeMul: 0.97 } },
  fieldOptic:  { slot: 'optic', name: 'Field Hybrid Sight',  level: 6,  field: 3, fits: LONG_GUNS, mods: { zoom: 0.8, adsSpreadMul: 0.8, handling: -4 } },
  hardBarrel:  { slot: 'barrel', name: 'Hardened Barrel',    level: 8,  field: 4, fits: LONG_GUNS, mods: { damageMul: 1.06, rangeMul: 1.12, handling: -6 } },
  fieldGrip:   { slot: 'underbarrel', name: 'Operator Grip', level: 5,  field: 3, fits: LONG_GUNS, mods: { recoilMul: 0.82, handling: 6 } },
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
  field:    { name: 'Field Commander', level: 3, field: 2, color: '#3a4f6b' },
};

export const ARMORS = {
  light:  { name: 'Light Vest',    level: 1,  cost: 20, armor: 60,  mobility: 0 },
  medium: { name: 'Plate Carrier', level: 6,  cost: 45, armor: 110, mobility: -0.04 },
  heavy:  { name: 'Heavy Plates',  level: 14, cost: 80, armor: 170, mobility: -0.10 },
  field:  { name: 'Field Plate',   level: 8,  cost: 50, armor: 140, mobility: -0.02, field: 4 },
};

/** Field perks: permanent, bought with commendations at any Contact. */
export const FIELD_PERKS = {
  camoMk2:   { name: 'Camo battery Mk2', level: 6, field: 4, desc: 'Optical camo drains half as much tech.' },
  sensorMk2: { name: 'Sensor Mk2',       level: 6, field: 4, desc: 'Sensor grenades cover 85 ft instead of 60 ft.' },
  pouch:     { name: 'Secure pouch',     level: 4, field: 5, desc: 'Keep up to 3 intel when you die.' },
};

/** Is a level/field-gated definition unlocked for this character? */
export function isUnlocked(def, id, char) {
  const lvl = levelFromXp(char?.xp || 0);
  if (lvl < (def.level || 1)) return false;
  return !def.field || (char?.field || []).includes(id);
}

// ------------------------------------------------------------------ stash house upgrades
// Paid with salvage (found out in the map) plus parts/tech, gated by level. Upgrades make your base
// tougher, bigger and more useful — the main reason to go scavenging.
export const UPGRADES = {
  door: { name: 'Reinforced Door', desc: 'More door/lock HP before it breaks.', tiers: [
    { label: 'Basic door', hp: 1 },
    { label: 'Steel door', hp: 2, home: 2, cost: { salvage: 80, parts: 30 } },
    { label: 'Blast door', hp: 3.5, home: 4, cost: { salvage: 200, parts: 80 } },
    { label: 'Vault door', hp: 5.5, home: 7, cost: { salvage: 400, parts: 150, comms: 3 } },
  ] },
  storage: { name: 'Storage', desc: 'More stash slots.', tiers: [
    { label: '30 slots', slots: 30 },
    { label: '45 slots', slots: 45, home: 1, cost: { salvage: 60 } },
    { label: '60 slots', slots: 60, home: 6, cost: { salvage: 150, parts: 50 } },
    { label: '90 slots', slots: 90, home: 8, cost: { salvage: 300, parts: 100, comms: 2 } },
  ] },
  alarm: { name: 'Perimeter Alarm', desc: 'Alerts you (anywhere on the map) when an enemy gets near your home, and shows them.', tiers: [
    { label: 'None', radius: 0 },
    { label: '80 ft alarm', radius: 25, home: 2, cost: { salvage: 50, tech: 30 } },
    { label: '165 ft alarm', radius: 50, home: 5, cost: { salvage: 120, tech: 60 } },
  ] },
  generator: { name: 'Generator', desc: 'Produces parts and tech into your stash every hour, even offline. (Raiders can take it.)', tiers: [
    { label: 'None', rate: 0 },
    { label: '12 / hour', rate: 12, home: 3, cost: { salvage: 100, parts: 60 } },
    { label: '30 / hour', rate: 30, home: 6, cost: { salvage: 250, parts: 120, comms: 2 } },
    { label: '60 / hour', rate: 60, home: 9, cost: { salvage: 500, parts: 200, comms: 4 } },
  ] },
  infirmary: { name: 'Infirmary', desc: 'Redeploying at your home gives a light vest and 2 medkits.', tiers: [
    { label: 'None' },
    { label: 'Installed', home: 2, cost: { salvage: 80, tech: 20 } },
  ] },
  workbench: { name: 'Workbench', desc: 'Cheaper builds at your gunsmith.', tiers: [
    { label: 'Basic', discount: 0 },
    { label: '-25% build cost', discount: 0.25, home: 3, cost: { salvage: 120, parts: 60 } },
    { label: '-50% build cost', discount: 0.5, home: 7, cost: { salvage: 300, parts: 120, comms: 2 } },
  ] },
};

// ------------------------------------------------------------------ contracts (from NPC Contacts)
// Fixed rewards per type: what you see on the board is exactly what you get.
export const CONTRACT_TYPES = {
  heist:    { name: 'Data Heist',          desc: 'Hack the marked terminal.', xp: 250, reward: { comms: 2, salvage: 30, tech: 25, intel: 2 } },
  camp:     { name: 'Clear Rogue Camp',    desc: 'Wipe out the rogue camp at the marked location.', xp: 400, reward: { comms: 3, salvage: 50, parts: 50 } },
  recovery: { name: 'Supply Recovery',     desc: 'Recover the marked crate and bring it to any Contact.', xp: 350, reward: { comms: 2, salvage: 80, parts: 30 } },
  hvt:      { name: 'High-Value Target',   desc: 'Eliminate the rogue lieutenant near the marked location.', xp: 450, reward: { comms: 3, parts: 50, tech: 40 } },
};
export const SUPPLY_DROP_CONTENTS = { salvage: 120, parts: 80, tech: 40, ammo: 150, comms: 1 };

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

/**
 * Fixed (non-random) world supplies by zone: what you find is resources, not stat-rolled gear.
 * Salvage (for stash upgrades) is mostly out in industrial zones, farms and forests — away from
 * the safety of town centres.
 */
export function worldSupply(index, zone = 'town') {
  const tables = {
    town:       [['parts', 15], ['ammo', 60], ['medkit'], ['parts', 10], ['tech', 8], ['salvage', 10], ['tool', 'hammer'], ['marker']],
    industrial: [['salvage', 25], ['salvage', 20], ['parts', 20], ['tool', 'pickaxe'], ['salvage', 30], ['tech', 10], ['tool', 'hammer']],
    farm:       [['wood', 20], ['ammo', 60], ['medkit'], ['salvage', 15], ['tool', 'hatchet'], ['parts', 15], ['marker']],
    park:       [['tech', 12], ['medkit'], ['ammo', 60], ['wood', 15], ['salvage', 12]],
    forest:     [['wood', 15], ['tech', 12], ['medkit'], ['tool', 'hatchet'], ['ammo', 60]],
    road:       [['parts', 20], ['ammo', 60], ['salvage', 12], ['tech', 8]],
    desert:     [['salvage', 25], ['ammo', 60], ['stone', 15], ['parts', 15], ['tech', 10]],
    mountain:   [['stone', 20], ['tech', 12], ['tool', 'pickaxe'], ['salvage', 15], ['medkit']],
    lake:       [['wood', 15], ['ammo', 60], ['salvage', 12], ['medkit']],
  };
  const t = tables[zone] || tables.town;
  const [kind, amount] = t[index % t.length];
  const names = { parts: 'Parts Cache', ammo: 'Ammo Box', medkit: 'Medkit', tech: 'Electronics', salvage: 'Salvage', wood: 'Lumber', stone: 'Stone', marker: 'Claim marker' };
  if (kind === 'tool') return { kind: 'tool', tool: amount, name: amount[0].toUpperCase() + amount.slice(1) };
  return amount ? { kind, name: names[kind], amount } : { kind, name: names[kind] };
}

/** What a successful terminal hack pays out. */
export const TERMINAL_REWARD = { intel: 3, tech: 10 };
export const TERMINAL_COOLDOWN_MS = 3 * 60_000;

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
  for (const [k, p] of Object.entries(PARTS)) if (p.level === level && p.level > 1 && !p.field) out.push({ type: 'part', id: k, name: p.name });
  for (const [k, p] of Object.entries(PAINTS)) if (p.level === level && p.level > 1 && !p.field) out.push({ type: 'paint', id: k, name: `${p.name} paint` });
  for (const [k, a] of Object.entries(ARMORS)) if (a.level === level && a.level > 1 && !a.field) out.push({ type: 'armor', id: k, name: a.name });
  for (const [k, g] of Object.entries(GADGETS)) if (g.level === level && g.level > 1) out.push({ type: 'gadget', id: k, name: g.name });
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
