// Loot tables, rarity tiers and stat rolls. Shared so the client can show the same derived stats
// the server uses for combat.

export const RARITIES = [
  { key: 'scrap',    name: 'Scrap',    color: '#b9b9b9', mult: 1.00, attrs: 0, weight: 48 },
  { key: 'field',    name: 'Field',    color: '#5fd35f', mult: 1.08, attrs: 1, weight: 28 },
  { key: 'tactical', name: 'Tactical', color: '#3f8cff', mult: 1.16, attrs: 1, weight: 15 },
  { key: 'elite',    name: 'Elite',    color: '#b552ff', mult: 1.27, attrs: 2, weight: 7 },
  { key: 'relic',    name: 'Relic',    color: '#ff9b21', mult: 1.42, attrs: 3, weight: 2 },
];
export const RARITY = Object.fromEntries(RARITIES.map((r, i) => [r.key, { ...r, tier: i }]));

export const ARCHETYPES = {
  carbine: { label: 'Carbine', damage: 26, rpm: 620, mag: 30, reloadMs: 2200, range: 45, spread: 0.018, pellets: 1 },
  smg:     { label: 'SMG',     damage: 19, rpm: 860, mag: 32, reloadMs: 1900, range: 25, spread: 0.03,  pellets: 1 },
  lmg:     { label: 'LMG',     damage: 24, rpm: 560, mag: 80, reloadMs: 4200, range: 50, spread: 0.028, pellets: 1 },
  dmr:     { label: 'DMR',     damage: 92, rpm: 110, mag: 10, reloadMs: 2600, range: 90, spread: 0.004, pellets: 1 },
  shotgun: { label: 'Shotgun', damage: 14, rpm: 75,  mag: 7,  reloadMs: 2800, range: 14, spread: 0.07,  pellets: 8 },
  sidearm: { label: 'Sidearm', damage: 30, rpm: 300, mag: 12, reloadMs: 1500, range: 30, spread: 0.015, pellets: 1 },
};

const WEAPON_ATTRS = ['critChance', 'critDamage', 'damage', 'rpm', 'mag', 'reload'];
const ARMOR_ATTRS = ['health', 'armorRegen', 'critChance', 'damage'];
export const ATTR_LABELS = {
  critChance: 'Crit Chance', critDamage: 'Crit Damage', damage: 'Weapon Damage', rpm: 'Rate of Fire',
  mag: 'Magazine Size', reload: 'Reload Speed', health: 'Health', armorRegen: 'Armor Regen',
};
const ATTR_RANGES = {
  critChance: [3, 8], critDamage: [8, 20], damage: [4, 12], rpm: [4, 10], mag: [8, 25], reload: [6, 15],
  health: [10, 35], armorRegen: [2, 6],
};

const NAME_PARTS = ['Kestrel', 'Ironside', 'Vanta', 'Harrow', 'Corvid', 'Bastion', 'Nomad', 'Rook', 'Talon', 'Grizzly', 'Wraith', 'Saber'];

let idCounter = 0;
export function newItemId() {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function rollRarity(rand = Math.random, luck = 0) {
  // luck shifts weight from lower tiers toward higher ones (used for bot drops).
  const weights = RARITIES.map((r, i) => r.weight * (1 + luck * i));
  let roll = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < RARITIES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return RARITIES[i].key;
  }
  return RARITIES[0].key;
}

function rollAttrs(pool, count, rand) {
  const out = {};
  const choices = [...pool];
  for (let i = 0; i < count && choices.length; i++) {
    const k = choices.splice(Math.floor(rand() * choices.length), 1)[0];
    const [lo, hi] = ATTR_RANGES[k];
    out[k] = Math.round(lo + rand() * (hi - lo));
  }
  return out;
}

export function makeWeapon(archetype, rarity, rand = Math.random) {
  const r = RARITY[rarity];
  return {
    id: newItemId(),
    kind: 'weapon',
    archetype,
    rarity,
    name: `${NAME_PARTS[Math.floor(rand() * NAME_PARTS.length)]} ${ARCHETYPES[archetype].label}`,
    roll: +(0.92 + rand() * 0.16).toFixed(3),
    attrs: rollAttrs(WEAPON_ATTRS, r.attrs, rand),
  };
}

export function makeArmor(rarity, rand = Math.random) {
  const r = RARITY[rarity];
  return {
    id: newItemId(),
    kind: 'armor',
    rarity,
    name: `${NAME_PARTS[Math.floor(rand() * NAME_PARTS.length)]} Plate Carrier`,
    roll: +(0.92 + rand() * 0.16).toFixed(3),
    attrs: rollAttrs(ARMOR_ATTRS, r.attrs, rand),
  };
}

export function makeConsumable(kind) {
  return { id: newItemId(), kind, rarity: 'scrap', name: kind === 'medkit' ? 'Medkit' : 'Ammo Box' };
}

/** Roll a random world drop. */
export function rollLoot(rand = Math.random, luck = 0) {
  const p = rand();
  if (p < 0.22) return makeConsumable('ammo');
  if (p < 0.36) return makeConsumable('medkit');
  const rarity = rollRarity(rand, luck);
  if (p < 0.55) return makeArmor(rarity, rand);
  const types = Object.keys(ARCHETYPES);
  return makeWeapon(types[Math.floor(rand() * types.length)], rarity, rand);
}

export function weaponStats(item, armorItem = null) {
  if (!item) return null;
  const a = ARCHETYPES[item.archetype];
  const m = RARITY[item.rarity].mult * item.roll;
  const at = item.attrs || {};
  const gear = armorItem?.attrs || {};
  return {
    damage: a.damage * m * (1 + ((at.damage || 0) + (gear.damage || 0)) / 100),
    rpm: a.rpm * (1 + (at.rpm || 0) / 100),
    mag: Math.round(a.mag * (1 + (at.mag || 0) / 100)),
    reloadMs: a.reloadMs * (1 - (at.reload || 0) / 100),
    range: a.range,
    spread: a.spread,
    pellets: a.pellets,
    critChance: 0.05 + ((at.critChance || 0) + (gear.critChance || 0)) / 100,
    critDamage: 0.5 + (at.critDamage || 0) / 100,
  };
}

export function armorStats(item) {
  if (!item) return { armor: 0, health: 0, armorRegen: 0 };
  const m = RARITY[item.rarity].mult * item.roll;
  return { armor: Math.round(80 * m), health: item.attrs?.health || 0, armorRegen: item.attrs?.armorRegen || 0 };
}

/** Single number summarising an item's strength, like a gear score. */
export function itemScore(item) {
  if (!item || (item.kind !== 'weapon' && item.kind !== 'armor')) return 0;
  const r = RARITY[item.rarity];
  return Math.round(100 * r.mult * item.roll + Object.keys(item.attrs || {}).length * 6);
}
