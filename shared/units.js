// Display units. The simulation runs in metres; everything the player reads is in US customary
// units (feet and miles).
export const FT_PER_M = 3.28084;
export const M_PER_MI = 1609.344;

/** "85 ft", "0.4 mi", "11 mi". Feet under a quarter mile, miles above. */
export function distText(m) {
  const ft = m * FT_PER_M;
  if (ft < 1320) return `${Math.round(ft)} ft`;
  const mi = m / M_PER_MI;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}
/** Always feet, rounded to `step` ft: radii and weapon ranges ("80 ft", "650 ft"). */
export function feet(m, step = 5) { return `${Math.round((m * FT_PER_M) / step) * step} ft`; }
