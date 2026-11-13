// Arsenal, gunsmith parts and level progression. Shared so the client shows exactly the stats the
// server uses in combat.
//
// Design: there are no random stat rolls. Power and variety come from your level, which unlocks
// weapon platforms, attachments, armor and paints on a fixed schedule, and from how you build your
// guns in the gunsmith. Attachments are trade-offs rather than straight upgrades, so a level-20
// player has more options than a level-2 player, not a guaranteed win.

// All numbers and tables live in shared/data/*.json (engine-neutral, so a future Unreal build can
// load the same files). This module adds the logic on top.
import progression from './data/progression.json' with { type: 'json' };
import arsenal from './data/arsenal.json' with { type: 'json' };
import gadgetData from './data/gadgets.json' with { type: 'json' };
import stash from './data/stash.json' with { type: 'json' };
import activities from './data/activities.json' with { type: 'json' };

// ------------------------------------------------------------------ progression
export const MAX_LEVEL = progression.maxLevel;

/** Total XP needed to reach `level` (level 1 = 0 XP). Each level costs a bit more than the last. */
export function xpForLevel(level) {
  const n = Math.max(0, Math.min(MAX_LEVEL, level) - 1);
  const c = progression.xpCurve;
  return c.firstLevelXp * n + c.extraPerLevelXp * n * (n - 1) / 2;
}

export function levelFromXp(xp) {
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}

export const XP = progression.xp;

// ------------------------------------------------------------------ tech (gadgets)
// Tech costs "tech" (electronics) — the resource that powers gadgets.
export const GADGETS = gadgetData.gadgets;

// ------------------------------------------------------------------ weapons
// Stats every build is measured on (shown as bars in the gunsmith).
// damage, range (m), rpm, mag, reloadMs, hipSpread, adsSpread (radians), recoil (pitch kick per shot),
// handling (0-100: ADS speed + swap), mobility (move speed multiplier).
export const ARCHETYPES = arsenal.archetypes;

export const SLOTS = arsenal.slots;
export const SLOT_LABELS = arsenal.slotLabels;

// Parts list which platforms they fit, either directly or by group name ("all", "longGuns").
export const PARTS = Object.fromEntries(Object.entries(arsenal.parts).map(([id, p]) =>
  [id, { ...p, fits: typeof p.fits === 'string' ? arsenal.fitGroups[p.fits] : p.fits }]));

export const DEFAULT_PARTS = arsenal.defaultParts;

export const PAINTS = arsenal.paints;

export const ARMORS = arsenal.armors;

/** Field perks: permanent, bought with commendations at any Contact. */
export const FIELD_PERKS = arsenal.fieldPerks;

/** Is a level/field-gated definition unlocked for this character? */
export function isUnlocked(def, id, char) {
  const lvl = levelFromXp(char?.xp || 0);
  if (lvl < (def.level || 1)) return false;
  return !def.field || (char?.field || []).includes(id);
}

// ------------------------------------------------------------------ stash house upgrades
// Paid with salvage (found out in the map) plus parts/tech, gated by level. Upgrades make your base
// tougher, bigger and more useful — the main reason to go scavenging.
export const UPGRADES = stash.upgrades;

// ------------------------------------------------------------------ contracts (from NPC Contacts)
// Fixed rewards per type: what you see on the board is exactly what you get.
export const CONTRACT_TYPES = activities.contracts.types;
export const SUPPLY_DROP_CONTENTS = activities.supplyDrop.contents;

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
  const t = activities.loot.zones[zone] || activities.loot.zones.town;
  return { ...t[index % t.length] };
}

/** What a successful terminal hack pays out. */
export const TERMINAL_REWARD = activities.terminal.reward;
export const TERMINAL_COOLDOWN_MS = activities.terminal.cooldownMs;

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
    zoomAlt: 0,            // extra magnification you can flip to while aiming (hybrid and variable sights)
    armor: 1, flesh: 1,    // ammunition: damage multiplier against armor, and against health
    thermal: false, autoTag: false, rangefinder: false, glint: false, subsonic: false,   // what a sight or a load can do
  };
  for (const slot of SLOTS) {
    const id = item.parts?.[slot] || DEFAULT_PARTS[slot];
    if (!partFits(id, item.archetype)) continue;
    const m = PARTS[id].mods;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'boolean') s[k] = v;   // suppressed, thermal, autoTag, rangefinder, glint, subsonic
      else if (k.endsWith('Mul')) { const key = k.slice(0, -3); s[key] = (key in s ? s[key] : 1) * v; }
      else s[k] = (s[k] || 0) + v;
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
