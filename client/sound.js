// Sound effects, made on the fly with the Web Audio API (no sound files to download).
// Gunshots and explosions are placed in the world: quieter and duller with distance, and panned to
// the side they came from. Everything goes through one volume control (saved in the browser).
//
// Browsers only allow sound after the player has tapped, clicked or pressed a key on the page;
// `unlock()` is called on those, and the first sound after that wakes the audio up.

let ctx = null, master = null, noise = null;
const settings = { volume: 0.7 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('dz_sound') || '{}')); } catch { /* keep the default */ }
export function getVolume() { return settings.volume; }
export function setVolume(v) {
  settings.volume = Math.max(0, Math.min(1, v));
  try { localStorage.setItem('dz_sound', JSON.stringify(settings)); } catch { /* private mode */ }
  if (master) master.gain.value = settings.volume;
}
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
    // One second of white noise, reused for every shot, step and blast.
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx.state === 'running' || ctx.state === 'suspended' ? ctx : null;
}
export function unlock() { audio(); }

/** A gain → pan chain into the master volume. */
function out(gain, pan = 0, at = 0) {
  const g = ctx.createGain();
  g.gain.value = gain;
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(master); }
  else g.connect(master);
  return g;
}
/** A burst of filtered noise with a quick attack and an exponential fade. */
function burst(dest, { t = 0, dur = 0.2, type = 'lowpass', freq = 2000, q = 0.7, gain = 1, attack = 0.002 }) {
  const now = ctx.currentTime + t;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(now, Math.random() * 0.5, dur + 0.05);
}
/** A short tone that slides from one pitch to another. */
function tone(dest, { t = 0, dur = 0.12, from = 440, to = from, type = 'sine', gain = 0.5 }) {
  const now = ctx.currentTime + t;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(from, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  o.connect(g); g.connect(dest);
  o.start(now); o.stop(now + dur + 0.05);
}

// Where the listener is: set every frame from the camera.
const ear = { x: 0, y: 0, z: 0, yaw: 0 };
export function setListener(x, y, z, yaw) { ear.x = x; ear.y = y; ear.z = z; ear.yaw = yaw; }
/** Loudness, muffling and left-right pan for a sound at (x, y, z). */
function place(x, y, z, reach = 400) {
  const dx = x - ear.x, dz = z - ear.z, d = Math.hypot(dx, dy0(y), dz);
  if (d > reach) return null;
  const gain = 1 / (1 + d / 18);
  const ang = Math.atan2(dx, dz) - ear.yaw;   // 0 = straight ahead
  return { gain, pan: -Math.sin(ang) * Math.min(1, d / 6), muffle: Math.max(500, 9000 / (1 + d / 60)), d };
}
const dy0 = (y) => y - ear.y;

// What each gun sounds like: how high the crack is, how heavy the thump, how long the tail.
const GUNS = {
  sidearm: { crack: 3200, thump: 150, tail: 0.18, gain: 0.8 },
  smg: { crack: 3600, thump: 140, tail: 0.14, gain: 0.7 },
  carbine: { crack: 2600, thump: 120, tail: 0.24, gain: 0.95 },
  dmr: { crack: 2000, thump: 95, tail: 0.38, gain: 1.1 },
  shotgun: { crack: 1500, thump: 80, tail: 0.32, gain: 1.15 },
  lmg: { crack: 2300, thump: 105, tail: 0.28, gain: 1.0 },
};
/** A gunshot at a point. `sup` 1 = suppressed, 2 = suppressed with subsonic rounds. */
export function shot(x, y, z, kind = 'carbine', sup = 0, own = false) {
  if (!audio()) return;
  const where = own ? { gain: 1, pan: 0, muffle: 12000, d: 0 } : place(x, y, z, sup ? 60 : 500);
  if (!where) return;
  const g = GUNS[kind] || GUNS.carbine;
  const dest = out(where.gain * g.gain * (own ? 0.55 : 0.8), where.pan);
  if (sup) {
    burst(dest, { dur: 0.09, type: 'bandpass', freq: sup === 2 ? 900 : 1300, q: 1.2, gain: 0.5 });
    tone(dest, { dur: 0.05, from: 300, to: 120, gain: 0.25 });
    return;
  }
  burst(dest, { dur: 0.05, type: 'highpass', freq: Math.min(where.muffle, g.crack), gain: 0.9 });
  burst(dest, { dur: g.tail + where.d / 900, type: 'lowpass', freq: Math.min(where.muffle, g.crack / 2), gain: 0.8 });
  tone(dest, { dur: 0.12, from: g.thump * 1.6, to: g.thump * 0.5, gain: 0.7 });
  if (where.d > 60) burst(dest, { t: 0.08 + where.d / 1200, dur: 0.5, type: 'lowpass', freq: 400, gain: 0.25 });   // echo off the trees
}
/** Out of rounds. */
export function empty() { if (!audio()) return; tone(out(0.4), { dur: 0.04, from: 1800, to: 1200, type: 'square', gain: 0.25 }); }
/** Mag out, mag in, charging handle. */
export function reload() {
  if (!audio()) return;
  const d = out(0.45);
  burst(d, { t: 0, dur: 0.06, type: 'bandpass', freq: 2400, q: 3, gain: 0.6 });
  tone(d, { t: 0.02, dur: 0.05, from: 900, to: 600, type: 'square', gain: 0.15 });
  burst(d, { t: 0.55, dur: 0.07, type: 'bandpass', freq: 1800, q: 3, gain: 0.7 });
  burst(d, { t: 0.9, dur: 0.05, type: 'bandpass', freq: 3200, q: 4, gain: 0.6 });
  tone(d, { t: 0.92, dur: 0.06, from: 1400, to: 800, type: 'square', gain: 0.15 });
}
/** You hit someone: a tick, sharper on a headshot. */
export function hit(head = false) {
  if (!audio()) return;
  tone(out(0.35), { dur: head ? 0.09 : 0.05, from: head ? 2400 : 1500, to: head ? 1800 : 1200, type: 'triangle', gain: 0.6 });
}
/** You took a hit. */
export function hurt() {
  if (!audio()) return;
  const d = out(0.6);
  tone(d, { dur: 0.18, from: 160, to: 60, gain: 0.8 });
  burst(d, { dur: 0.12, freq: 600, gain: 0.5 });
}
/** A footstep: grass, road or water; quieter crouched. */
export function step(surface = 'grass', soft = false) {
  if (!audio()) return;
  const d = out(soft ? 0.1 : 0.18, (Math.random() - 0.5) * 0.2);
  if (surface === 'water') burst(d, { dur: 0.16, type: 'bandpass', freq: 900, q: 1.5, gain: 0.8 });
  else if (surface === 'road') burst(d, { dur: 0.06, type: 'bandpass', freq: 1600, q: 1.2, gain: 0.8 });
  else burst(d, { dur: 0.09, type: 'lowpass', freq: 700, gain: 0.8 });
}
/** Picked something up. */
export function pickup() {
  if (!audio()) return;
  const d = out(0.3);
  tone(d, { dur: 0.06, from: 700, to: 900, type: 'triangle', gain: 0.5 });
  tone(d, { t: 0.05, dur: 0.08, from: 1050, to: 1300, type: 'triangle', gain: 0.4 });
}
/** Menus: moving the highlight and choosing. */
export function click(strong = false) { if (!audio()) return; tone(out(strong ? 0.18 : 0.08), { dur: 0.03, from: strong ? 900 : 1300, type: 'triangle', gain: 0.5 }); }
/** A breach charge or other blast. */
export function boom(x, y, z) {
  if (!audio()) return;
  const where = place(x, y, z, 1500);
  if (!where) return;
  const d = out(Math.min(1.2, where.gain * 3), where.pan);
  tone(d, { dur: 0.6, from: 90, to: 30, gain: 0.9 });
  burst(d, { dur: 1.2 + where.d / 500, freq: Math.min(where.muffle, 1200), gain: 0.9, attack: 0.005 });
}
/** A crew ping or an alert. */
export function ping(alert = false) {
  if (!audio()) return;
  const d = out(0.25);
  tone(d, { dur: 0.1, from: alert ? 880 : 660, type: 'sine', gain: 0.5 });
  tone(d, { t: 0.11, dur: 0.14, from: alert ? 660 : 990, type: 'sine', gain: 0.45 });
}
/** Level up. */
export function levelUp() {
  if (!audio()) return;
  const d = out(0.3);
  [523, 659, 784, 1047].forEach((f, i) => tone(d, { t: i * 0.09, dur: 0.22, from: f, type: 'triangle', gain: 0.5 }));
}
