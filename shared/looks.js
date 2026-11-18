// The wardrobe: what you can wear. An outfit (one of the people models) and a colour for the clothes
// (skin and hair keep their own). Saved with your character; everyone sees what you picked.
// Black tactical gear is the Rogues' look, so it isn't on offer.
export const OUTFITS = [
  { id: 'swat1', label: 'Tactical' },
  { id: 'swat2', label: 'Officer' },
  { id: 'james', label: 'Street' },
  { id: 'liza', label: 'Casual' },
  { id: 'remy', label: 'Work clothes' },
];
export const DYES = [
  { id: 'none', label: 'As made', hex: null },
  { id: 'olive', label: 'Olive', hex: 0x48522e },
  { id: 'tan', label: 'Tan', hex: 0xb39a72 },
  { id: 'woods', label: 'Woods brown', hex: 0x6b5236 },
  { id: 'navy', label: 'Navy', hex: 0x2c3e66 },
  { id: 'gray', label: 'Gray', hex: 0x8a8f94 },
  { id: 'orange', label: 'Hunter orange', hex: 0xe0661f },
];
/** "outfit:dye" if both are on the lists, else null. */
export function cleanLook(v) {
  const [o, d = 'none'] = String(v || '').split(':');
  return OUTFITS.some((x) => x.id === o) && DYES.some((x) => x.id === d) ? `${o}:${d}` : null;
}
