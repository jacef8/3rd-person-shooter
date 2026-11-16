/**
 * High-value sites (shared/data/sites.json): the county's real prisons, sheriff's and police offices,
 * hospital, clinics, pharmacies and sporting-goods stores, found in the open data's place list
 * (data/real/infrastructure.json) and business list (data/real/businesses.json).
 */
import SITES from './data/sites.json' with { type: 'json' };
import { project } from './geography.js';

export { SITES };

/** What kind of site a place or business is, or null. */
export function siteKind(cat, name) {
  const n = name || '';
  if (/youth|juvenile|business office|extension office|dental|dentist|chamber|recovery|rehab/i.test(n)) return null;
  if (cat === 'prison' || cat === 'jail_or_prison') return 'prison';
  if (cat === 'sheriff' || cat === 'police_station') return 'sheriff';
  if (cat === 'hospital') return /hospital/i.test(n) ? 'hospital' : 'clinic';
  if (cat === 'doctors_office' || cat === 'medical_service_organization' || cat === 'clinic') return 'clinic';
  if (cat === 'health_care') return /health|care|clinic|medical/i.test(n) ? 'clinic' : null;   // not a person's name
  if (cat === 'pharmacy') return 'pharmacy';
  if (cat === 'sporting_goods_store') return /sport|outdoor|gun|bait|tackle/i.test(n) ? 'sporting' : null;
  return null;
}

const tidy = (n) => n.replace(/\s+-\s+.*$/, '').trim();

/**
 * Every site on a map of the given size: [{ id, kind, name, x, z }]. Places of the same kind close
 * together (two listings for one jail, a work camp beside its prison) count once, under the fuller name;
 * two places with the same name count once too.
 */
export function findSites(infrastructure, businesses, size) {
  const raw = [];
  for (const [lat, lon, cat, name] of infrastructure?.places || []) raw.push({ lat, lon, cat, name });
  for (const [lat, lon, cat, name] of businesses?.rows || businesses || []) raw.push({ lat, lon, cat, name });
  const out = [];
  for (const r of raw) {
    const kind = siteKind(r.cat, r.name);
    if (!kind || !r.name) continue;
    const name = tidy(r.name), { x, z } = project(r.lat, r.lon, size);
    const merge = SITES.kinds[kind].merge;
    const same = out.find((o) => o.kind === kind && (o.name === name || Math.hypot(o.x - x, o.z - z) < merge));
    if (same) { if (name.length > same.name.length && same.name !== name) same.name = name; continue; }
    out.push({ kind, name, x, z });
  }
  // A clinic or pharmacy on the hospital's own grounds is part of the hospital.
  const hospitals = out.filter((o) => o.kind === 'hospital');
  const half = size / 2 - 150;
  return out.filter((s) => Math.abs(s.x) < half && Math.abs(s.z) < half)
    .filter((s) => s.kind === 'hospital' || !['clinic', 'pharmacy'].includes(s.kind) || !hospitals.some((h) => Math.hypot(h.x - s.x, h.z - s.z) < SITES.kinds.hospital.merge))
    .sort((a, b) => a.x - b.x || a.z - b.z)
    .map((s, i) => ({ id: `site${i}`, ...s }));
}
