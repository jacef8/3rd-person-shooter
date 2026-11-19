// Sound, made on the fly with the Web Audio API (no sound files needed).
// Everything that happens in the world is placed there: quieter, duller and later with distance
// (sound takes about 3 seconds to cross a kilometre), panned to the side it came from, and sent
// through an outdoor echo so a rifle across the river rolls off the treeline. Engines run
// continuously and follow each ride's speed through its gears. The countryside has its own
// background: wind and birds by day, crickets and frogs at night, rain when it rains.
//
// Real recordings can be dropped in later: list them in /sfx/manifest.json ({ "shot_carbine":
// "carbine.mp3", ... }) and the one-shot sounds use them instead of the synthesized ones.
//
// Browsers only allow sound after the player has tapped, clicked or pressed a key on the page;
// `unlock()` is called on those, and the first sound after that wakes the audio up.

let ctx = null, master = null, bus = null, noise = null, verb = null, verbIn = null;
const settings = { volume: 0.7 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('dz_sound') || '{}')); } catch { /* keep the default */ }
export function getVolume() { return settings.volume; }
export function setVolume(v) {
  settings.volume = Math.max(0, Math.min(1, v));
  try { localStorage.setItem('dz_sound', JSON.stringify(settings)); } catch { /* private mode */ }
  if (master) master.gain.value = settings.volume;
  sleepIfIdle();
}
/** Sound off, or the game hidden (another tab, the phone's home screen): the audio stops working
 *  entirely (no engines droning in the background, no battery spent on silence). */
function sleepIfIdle() {
  if (!ctx) return;
  const idle = !settings.volume || (typeof document !== 'undefined' && document.hidden);
  if (idle && ctx.state === 'running') ctx.suspend().catch(() => {});
  else if (!idle && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sleepIfIdle);

/** An outdoor echo: a few early slaps off nearby walls and trees, then a long soft fade. */
function makeVerb(c, secs = 1.7) {
  const n = Math.floor(c.sampleRate * secs), ir = c.createBuffer(2, n, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / c.sampleRate;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 3.2) * (t < 0.012 ? t / 0.012 : 1) * 0.5;
    }
    for (const at of [0.031, 0.058, 0.094, 0.15, 0.23]) {   // early reflections, a little different per ear
      const i = Math.floor((at + ch * 0.004 + Math.random() * 0.006) * c.sampleRate);
      for (let k = 0; k < 90 && i + k < n; k++) d[i + k] += (Math.random() * 2 - 1) * 0.6 * Math.exp(-k / 25) * Math.exp(-at * 5);
    }
  }
  return ir;
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    // A limiter on the way out, so a firefight right next to you doesn't crackle.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -10; lim.knee.value = 8; lim.ratio.value = 8; lim.attack.value = 0.002; lim.release.value = 0.18;
    master.connect(lim); lim.connect(ctx.destination);
    bus = master;
    // Two seconds of white noise, reused for every shot, step, engine and blast.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    try {
      verb = ctx.createConvolver(); verb.buffer = makeVerb(ctx);
      verbIn = ctx.createGain(); verbIn.gain.value = 0.9;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      verbIn.connect(lp); lp.connect(verb); verb.connect(master);
    } catch { verb = null; verbIn = null; }
    loadSamples();
  }
  if (ctx.state === 'suspended' && settings.volume && !(typeof document !== 'undefined' && document.hidden)) ctx.resume().catch(() => {});
  if (!settings.volume) return null;   // muted: make nothing at all
  return ctx.state === 'running' || ctx.state === 'suspended' ? ctx : null;
}
export function unlock() { audio(); }
/** The audio context and the master volume (voice chat plays through them). */
export function mixer() { const c = audio(); return c ? { ctx: c, out: master } : null; }

// ---- Optional recordings -------------------------------------------------------------------------
const samples = new Map();
let samplesTried = false;
async function loadSamples() {
  if (samplesTried) return; samplesTried = true;
  try {
    const r = await fetch('/sfx/manifest.json', { cache: 'force-cache' });
    if (!r.ok) return;
    const list = await r.json();
    for (const [name, file] of Object.entries(list)) {
      if (name.startsWith('_') || typeof file !== 'string') continue;
      fetch(`/sfx/${file}`).then((x) => (x.ok ? x.arrayBuffer() : null)).then((b) => b && ctx.decodeAudioData(b)).then((buf) => { if (buf) samples.set(name, buf); }).catch(() => {});
    }
  } catch { /* none: everything stays synthesized */ }
}
/** Play a recording if there is one; false if not (so the synthesized sound plays instead). */
function sample(name, dest, { t = 0, rate = 1, gain = 1 } = {}) {
  const variants = [samples.get(name), samples.get(`${name}2`), samples.get(`${name}3`)].filter(Boolean);
  if (!variants.length) return false;
  const src = ctx.createBufferSource(); src.buffer = variants[Math.floor(Math.random() * variants.length)];
  src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
  const g = ctx.createGain(); g.gain.value = gain; src.connect(g); g.connect(dest);
  src.start(ctx.currentTime + t);
  return true;
}

// ---- Building blocks -----------------------------------------------------------------------------
/** A gain → pan chain into the mix, with some of it sent to the echo. Starts `delay` s from now. */
function out(gain, pan = 0, wet = 0) {
  const g = ctx.createGain();
  g.gain.value = gain;
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(bus); }
  else g.connect(bus);
  if (wet > 0 && verbIn) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(verbIn); }
  return g;
}
/** A burst of filtered noise with a quick attack and an exponential fade. */
function burst(dest, { t = 0, dur = 0.2, type = 'lowpass', freq = 2000, to = 0, q = 0.7, gain = 1, attack = 0.002 }) {
  const now = ctx.currentTime + t;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, now);
  if (to) f.frequency.exponentialRampToValueAtTime(to, now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(now, Math.random() * 1.5, dur + 0.05);
}
/** A short tone that slides from one pitch to another. */
function tone(dest, { t = 0, dur = 0.12, from = 440, to = from, type = 'sine', gain = 0.5, attack = 0.005 }) {
  const now = ctx.currentTime + t;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(from, now);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  o.connect(g); g.connect(dest);
  o.start(now); o.stop(now + dur + 0.05);
}
/** Metal on metal: a click of noise and a few out-of-tune ringing partials (mags, bolts, latches). */
function metal(dest, { t = 0, base = 2200, ring = 0.05, gain = 0.5 }) {
  burst(dest, { t, dur: 0.012, type: 'highpass', freq: base * 0.8, gain: gain * 1.2, attack: 0.0008 });
  [1, 1.47, 2.09, 2.71].forEach((r, i) => tone(dest, { t, dur: ring * (1 - i * 0.18), from: base * r * (0.98 + Math.random() * 0.04), type: 'sine', gain: gain * (0.45 - i * 0.08), attack: 0.001 }));
}
/** A slide of metal or polymer: a short swept scrape. */
function scrape(dest, { t = 0, dur = 0.12, from = 1800, to = 900, gain = 0.3 }) {
  burst(dest, { t, dur, type: 'bandpass', freq: from, to, q: 2.5, gain, attack: 0.01 });
}
/** Grit: lots of tiny ticks (gravel, a belt of rounds, shell casings). */
function grit(dest, { t = 0, dur = 0.08, n = 6, freq = 3500, gain = 0.25 }) {
  for (let i = 0; i < n; i++) burst(dest, { t: t + Math.random() * dur, dur: 0.008 + Math.random() * 0.01, type: 'bandpass', freq: freq * (0.6 + Math.random() * 0.8), q: 3, gain: gain * (0.5 + Math.random() * 0.5), attack: 0.0006 });
}
let curve = null;
/** A soft clipper: gives a shot or an engine its bite. */
function drive(amount = 3) {
  if (!curve) { curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * amount); } }
  const w = ctx.createWaveShaper(); w.curve = curve; w.oversample = 'none';
  return w;
}

// Where the listener is: set every frame from the camera.
const ear = { x: 0, y: 0, z: 0, yaw: 0 };
export function setListener(x, y, z, yaw) { ear.x = x; ear.y = y; ear.z = z; ear.yaw = yaw; }
/** Loudness, muffling, delay and left-right pan for a sound at (x, y, z). */
function place(x, y, z, reach = 400) {
  const dx = x - ear.x, dz = z - ear.z, d = Math.hypot(dx, y - ear.y, dz);
  if (d > reach) return null;
  const gain = 1 / (1 + d / 18);
  const ang = Math.atan2(dx, dz) - ear.yaw;   // 0 = straight ahead
  return {
    gain, d,
    pan: -Math.sin(ang) * Math.min(0.85, d / 8),
    muffle: Math.max(350, 12000 / (1 + d / 45)),   // the air eats the highs first
    delay: Math.min(1.6, d / 343),                 // speed of sound
    wet: Math.min(1.4, 0.18 + d / 160),            // far off you hear more echo than shot
  };
}
const NEAR = { gain: 1, pan: 0, muffle: 14000, d: 0, delay: 0, wet: 0.16 };

// ---- Guns ----------------------------------------------------------------------------------------
// What each gun sounds like: how high the crack is, how heavy the thump, how long the body rings.
const GUNS = {
  sidearm: { crack: 3000, body: 1400, thump: 150, tail: 0.14, gain: 0.8, mech: 3200 },
  smg: { crack: 3400, body: 1600, thump: 135, tail: 0.11, gain: 0.7, mech: 3600 },
  carbine: { crack: 2600, body: 1150, thump: 115, tail: 0.18, gain: 0.95, mech: 2600 },
  dmr: { crack: 2100, body: 900, thump: 90, tail: 0.26, gain: 1.1, mech: 2200 },
  shotgun: { crack: 1400, body: 700, thump: 70, tail: 0.3, gain: 1.15, mech: 1800 },
  lmg: { crack: 2300, body: 1000, thump: 100, tail: 0.2, gain: 1.0, mech: 2400 },
  launcher: { crack: 700, body: 450, thump: 55, tail: 0.45, gain: 1.2, mech: 1400 },
  taser: { crack: 5000, body: 3000, thump: 300, tail: 0.05, gain: 0.3, mech: 4000 },
};
/** A gunshot at a point. `sup` 1 = suppressed, 2 = suppressed with subsonic rounds. */
const shotTimes = [];
export function shot(x, y, z, kind = 'carbine', sup = 0, own = false) {
  if (!audio()) return;
  const w = own ? NEAR : place(x, y, z, sup ? 70 : 1200);
  if (!w) return;
  // A voice budget: in a big firefight (dozens of shots a second) the far ones drop out and nobody's
  // shots get their rolling echo, so the audio thread never chokes (phones crackle past ~1000 nodes).
  const nowT = ctx.currentTime;
  while (shotTimes.length && nowT - shotTimes[0] > 1) shotTimes.shift();
  const busy = shotTimes.length;
  if (!own && ((busy > 40 && w.d > 60) || busy > 70)) return;
  shotTimes.push(nowT);
  const g = GUNS[kind] || GUNS.carbine, t = w.delay;
  if (kind === 'taser') {   // a crackle of electricity, not a bang
    const d = out(own ? 0.35 : w.gain * 0.5, w.pan, 0.05);
    for (let i = 0; i < 9; i++) burst(d, { t: t + i * 0.022 + Math.random() * 0.01, dur: 0.02, type: 'bandpass', freq: 3000 + Math.random() * 3000, q: 4, gain: 0.7 });
    tone(d, { t, dur: 0.22, from: 120, to: 118, type: 'sawtooth', gain: 0.12 });
    return;
  }
  const dryK = own ? 0.6 : Math.min(1, w.gain * 1.6) * 0.85;
  const dest = out(dryK * g.gain, w.pan, w.wet * (sup ? 0.3 : 1));
  if (sample(`shot_${kind}${sup ? '_sup' : ''}`, dest, { t })) return;
  if (sup) {
    burst(dest, { t, dur: 0.07, type: 'bandpass', freq: sup === 2 ? 800 : 1200, q: 1.4, gain: 0.55 });
    tone(dest, { t, dur: 0.05, from: 260, to: 110, gain: 0.3 });
    if (own) metal(dest, { t: t + 0.045, base: g.mech, ring: 0.03, gain: 0.25 });   // the action cycling: you hear it with a can on
    if (sup === 1 && !own && w.d > 15) burst(dest, { t: t * 0.3, dur: 0.012, type: 'highpass', freq: 3500, gain: 0.25 });   // the bullet still cracks
    return;
  }
  const close = w.d < 150;
  // The crack: the bullet and the muzzle blast, a sharp edge of high noise through a clipper.
  const sh = drive(2.5); sh.connect(dest);
  if (close) burst(sh, { t, dur: 0.028, type: 'highpass', freq: Math.min(w.muffle, g.crack), gain: 1.1, attack: 0.0006 });
  // The body: the blast itself, a midrange whoomp.
  burst(sh, { t, dur: g.tail * (close ? 1 : 1.6), type: 'bandpass', freq: Math.min(w.muffle * 0.7, g.body), to: Math.max(120, Math.min(w.muffle, g.body) * 0.4), q: 0.9, gain: 0.9, attack: 0.001 });
  // The punch you feel: a low thump falling in pitch.
  tone(sh, { t, dur: 0.14 + (close ? 0 : 0.1), from: g.thump * 1.8, to: g.thump * 0.45, gain: close ? 0.8 : 0.5, attack: 0.001 });
  if (own) {
    metal(dest, { t: 0.05, base: g.mech, ring: 0.035, gain: 0.18 });                                 // the bolt cycling
    if (kind === 'shotgun') { scrape(dest, { t: 0.32, dur: 0.09, from: 900, to: 1500, gain: 0.35 }); metal(dest, { t: 0.42, base: 1500, ring: 0.05, gain: 0.3 }); }   // rack the pump
    if (kind !== 'launcher' && busy < 12 && Math.random() < 0.6) grit(dest, { t: 0.45 + Math.random() * 0.2, n: 3, freq: 4200, gain: 0.05 });   // brass hitting the ground
  }
  // Far off: the rolling echo off the treelines and the river.
  if (w.d > 80 && busy < 18) for (let i = 0; i < 3; i++) burst(dest, { t: t + 0.12 + i * (0.18 + Math.random() * 0.2) + w.d / 2400, dur: 0.6, type: 'lowpass', freq: Math.min(500, w.muffle), gain: 0.22 / (i + 1), attack: 0.02 });
}
/** Out of rounds: the dry click of the trigger. */
export function empty() { if (!audio()) return; metal(out(0.45), { base: 3400, ring: 0.02, gain: 0.35 }); }
/** A bullet going past you: the supersonic snap and the zip. `side` -1 left … 1 right. */
export function whiz(side = 0, close = 1) {
  if (!audio()) return;
  const d = out(0.5 * close, side * 0.7);
  burst(d, { dur: 0.012, type: 'highpass', freq: 3000, gain: 0.9, attack: 0.0005 });
  burst(d, { t: 0.01, dur: 0.14, type: 'bandpass', freq: 4200, to: 1300, q: 3, gain: 0.45, attack: 0.01 });
}
/** A bullet landing: a slap on a body, a puff of dirt, a ping off metal. */
export function impact(x, y, z, kind = 'ground') {
  if (!audio()) return;
  const w = place(x, y, z, 45);
  if (!w) return;
  const d = out(w.gain * 0.9, w.pan, 0.1);
  if (kind === 'body') { burst(d, { t: w.delay, dur: 0.06, type: 'lowpass', freq: 500, gain: 0.8 }); tone(d, { t: w.delay, dur: 0.07, from: 140, to: 70, gain: 0.5 }); }
  else if (kind === 'metal') metal(d, { t: w.delay, base: 2600 + Math.random() * 1500, ring: 0.12, gain: 0.35 });
  else { burst(d, { t: w.delay, dur: 0.05, type: 'bandpass', freq: 1100, q: 1, gain: 0.5 }); grit(d, { t: w.delay + 0.01, n: 3, freq: 2500, gain: 0.15 }); }
}
/**
 * Reloading, timed to the gun: mag out, a fresh one in, the bolt or slide sent home. Shotguns load
 * shell by shell and pump; a belt-fed opens the cover. `ms` is how long the reload takes.
 */
export function reload(kind = 'carbine', ms = 2200) {
  if (!audio()) return;
  const d = out(0.5, 0.05, 0.08), T = Math.max(0.8, ms / 1000);
  if (sample(`reload_${kind}`, d, { rate: Math.max(0.7, Math.min(1.4, (samples.get(`reload_${kind}`)?.duration || T) / T)) })) return;
  if (kind === 'shotgun') {
    const n = Math.max(2, Math.min(6, Math.round(T / 0.55)));
    for (let i = 0; i < n; i++) { const at = 0.2 + i * (T - 0.6) / n; scrape(d, { t: at, dur: 0.05, from: 1200, to: 700, gain: 0.25 }); metal(d, { t: at + 0.06, base: 1700, ring: 0.03, gain: 0.3 }); }
    scrape(d, { t: T - 0.32, dur: 0.1, from: 800, to: 1500, gain: 0.4 }); metal(d, { t: T - 0.18, base: 1500, ring: 0.06, gain: 0.45 });
    return;
  }
  if (kind === 'launcher') {
    scrape(d, { t: 0.3, dur: 0.3, from: 600, to: 300, gain: 0.35 });
    burst(d, { t: T * 0.65, dur: 0.12, type: 'lowpass', freq: 400, gain: 0.7 }); metal(d, { t: T * 0.85, base: 1100, ring: 0.1, gain: 0.45 });
    return;
  }
  if (kind === 'lmg') {
    metal(d, { t: 0.15, base: 1400, ring: 0.08, gain: 0.4 });                  // feed cover up
    scrape(d, { t: T * 0.25, dur: 0.15, from: 1500, to: 800, gain: 0.3 });     // box off
    grit(d, { t: T * 0.5, dur: 0.25, n: 12, freq: 3000, gain: 0.18 });        // belt laid in
    burst(d, { t: T * 0.62, dur: 0.06, type: 'lowpass', freq: 600, gain: 0.5 });
    metal(d, { t: T * 0.78, base: 1300, ring: 0.09, gain: 0.5 });              // cover slammed
    scrape(d, { t: T * 0.88, dur: 0.07, from: 1100, to: 2200, gain: 0.35 }); metal(d, { t: T * 0.93, base: 2000, ring: 0.05, gain: 0.45 });
    return;
  }
  const pistol = kind === 'sidearm';
  metal(d, { t: 0.06, base: pistol ? 3600 : 2800, ring: 0.025, gain: 0.3 });                 // mag release
  scrape(d, { t: 0.1, dur: pistol ? 0.08 : 0.13, from: 1600, to: 800, gain: 0.3 });           // mag out
  burst(d, { t: T * 0.35, dur: 0.1, type: 'bandpass', freq: 700, q: 1, gain: 0.15 });        // into the pouch
  scrape(d, { t: T * 0.55, dur: 0.08, from: 800, to: 1500, gain: 0.3 });                      // fresh mag in…
  burst(d, { t: T * 0.55 + 0.08, dur: 0.05, type: 'lowpass', freq: 700, gain: 0.6 });          // …seated
  metal(d, { t: T * 0.55 + 0.08, base: pistol ? 3000 : 2300, ring: 0.03, gain: 0.4 });
  if (pistol) { metal(d, { t: T * 0.86, base: 2600, ring: 0.06, gain: 0.5 }); return; }        // slide release
  scrape(d, { t: T * 0.8, dur: 0.07, from: 1200, to: 2400, gain: 0.35 });                       // charging handle back…
  metal(d, { t: T * 0.89, base: 2100, ring: 0.06, gain: 0.55 });                                // …and home
}
/** Switching guns: a rustle and a click. */
export function equip() {
  if (!audio()) return;
  const d = out(0.3);
  burst(d, { dur: 0.12, type: 'bandpass', freq: 900, q: 0.8, gain: 0.2, attack: 0.02 });
  metal(d, { t: 0.12, base: 2900, ring: 0.03, gain: 0.25 });
}
/** You hit someone: a tick, sharper on a headshot. */
export function hit(head = false) {
  if (!audio()) return;
  const d = out(0.35);
  tone(d, { dur: head ? 0.09 : 0.05, from: head ? 2400 : 1500, to: head ? 1800 : 1200, type: 'triangle', gain: 0.6 });
  if (head) metal(d, { t: 0.01, base: 3800, ring: 0.06, gain: 0.15 });
}
/** You took a hit. */
export function hurt() {
  if (!audio()) return;
  const d = out(0.6);
  tone(d, { dur: 0.18, from: 160, to: 60, gain: 0.8 });
  burst(d, { dur: 0.12, freq: 600, gain: 0.5 });
}

// ---- Footsteps -----------------------------------------------------------------------------------
/**
 * A footstep, heel then toe: grass, dirt, road, wood, metal or water; softer crouched, heavier at a
 * sprint. With a position it's someone else's, heard from where they are.
 */
export function step(surface = 'grass', soft = false, at = null, sprint = false) {
  if (!audio()) return;
  const w = at ? place(at[0], at[1], at[2], 40) : NEAR;
  if (!w) return;
  const k = (soft ? 0.45 : sprint ? 1.25 : 1) * (at ? Math.min(1.4, w.gain * 2.2) : 1);
  const d = out(0.2 * k, at ? w.pan : (Math.random() - 0.5) * 0.15, 0.04);
  const t = w.delay, toe = 0.03 + Math.random() * 0.02, m = Math.min(1, w.muffle / 6000);
  if (sample(`step_${surface}`, d, { t })) return;
  switch (surface) {
    case 'water':
      burst(d, { t, dur: 0.18, type: 'bandpass', freq: 800, to: 1400, q: 1.2, gain: 0.8, attack: 0.01 });
      burst(d, { t: t + 0.05, dur: 0.2, type: 'highpass', freq: 2500 * m + 500, gain: 0.25, attack: 0.02 });
      break;
    case 'road':
      burst(d, { t, dur: 0.035, type: 'bandpass', freq: 2200 * m + 400, q: 1.6, gain: 0.8, attack: 0.001 });
      tone(d, { t, dur: 0.05, from: 110, to: 70, gain: 0.35, attack: 0.001 });
      burst(d, { t: t + toe, dur: 0.06, type: 'highpass', freq: 2500 * m + 300, gain: 0.25, attack: 0.008 });   // scuff
      break;
    case 'dirt':
      burst(d, { t, dur: 0.06, type: 'lowpass', freq: 900, gain: 0.7 });
      grit(d, { t, dur: 0.09, n: 7, freq: 3200 * m + 600, gain: 0.3 });
      break;
    case 'wood':
      tone(d, { t, dur: 0.09, from: 150, to: 105, gain: 0.6, attack: 0.001 });
      burst(d, { t, dur: 0.07, type: 'bandpass', freq: 520, q: 4, gain: 0.7, attack: 0.001 });
      burst(d, { t: t + toe, dur: 0.04, type: 'bandpass', freq: 900, q: 3, gain: 0.3 });
      if (Math.random() < 0.15) tone(d, { t: t + 0.04, dur: 0.18, from: 380, to: 430, type: 'triangle', gain: 0.05, attack: 0.04 });   // a board creaks
      break;
    case 'metal':
      metal(d, { t, base: 700 + Math.random() * 200, ring: 0.18, gain: 0.45 });
      break;
    default:   // grass and leaves
      burst(d, { t, dur: 0.07, type: 'lowpass', freq: 650, gain: 0.7 });
      burst(d, { t: t + toe, dur: 0.1, type: 'highpass', freq: 3200 * m + 400, gain: 0.22, attack: 0.015 });   // blades brushing
      if (sprint) burst(d, { t: t + 0.02, dur: 0.12, type: 'bandpass', freq: 1800, q: 0.6, gain: 0.12, attack: 0.02 });
  }
}
/** Hooves: a horse's two-beat clop. */
function clop(x, y, z, road) {
  const w = place(x, y, z, 70);
  if (!w) return;
  const d = out(Math.min(1, w.gain * 2) * 0.3, w.pan, 0.08);
  tone(d, { t: w.delay, dur: 0.06, from: road ? 900 : 300, to: road ? 600 : 150, type: 'triangle', gain: 0.5, attack: 0.001 });
  burst(d, { t: w.delay, dur: 0.05, type: road ? 'bandpass' : 'lowpass', freq: road ? 1800 : 500, q: 2, gain: 0.6 });
}

// ---- Engines -------------------------------------------------------------------------------------
// rpm: idle and redline. cyl: cylinders firing per two turns (two-strokes count double). gears: how
// many. tone: the oscillators' shape. bright: how open the exhaust is. rough: how lumpy it runs.
const MOTORS = {
  car: { idle: 750, red: 6200, cyl: 6, gears: 5, wave: 'sawtooth', bright: 1, rough: 0.15, gain: 0.32 },
  pickup: { idle: 620, red: 5000, cyl: 8, gears: 4, wave: 'sawtooth', bright: 0.8, rough: 0.35, gain: 0.4 },
  motorcycle: { idle: 1100, red: 9000, cyl: 2, gears: 5, wave: 'sawtooth', bright: 1.5, rough: 0.5, gain: 0.38 },
  dirtbike: { idle: 1600, red: 10500, cyl: 2, gears: 5, wave: 'square', bright: 1.8, rough: 0.3, gain: 0.32 },
  atv: { idle: 1300, red: 8000, cyl: 2, gears: 4, wave: 'square', bright: 1.2, rough: 0.35, gain: 0.32 },
  tractor: { idle: 800, red: 2400, cyl: 4, gears: 3, wave: 'square', bright: 0.6, rough: 0.8, gain: 0.42, diesel: true },
  golfcart: { electric: true, gain: 0.12 },
  jonboat: { idle: 950, red: 5800, cyl: 4, gears: 1, wave: 'sawtooth', bright: 1.2, rough: 0.3, gain: 0.34, water: true },
  airboat: { idle: 1000, red: 5200, cyl: 6, gears: 1, wave: 'sawtooth', bright: 1.4, rough: 0.2, gain: 0.5, water: true, prop: true },
};
const NO_MOTOR = { bicycle: 'bike', skateboard: 'board', horse: 'horse' };
const engines = new Map();
let frame = 0;

function startEngine(type) {
  const m = MOTORS[type];
  const e = { type, m, nodes: [], born: ctx.currentTime, seen: frame, rpm: m?.idle || 0, last: null };
  e.gain = ctx.createGain(); e.gain.gain.value = 0;
  e.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (e.pan) { e.gain.connect(e.pan); e.pan.connect(bus); } else e.gain.connect(bus);
  if (verbIn) { e.send = ctx.createGain(); e.send.gain.value = 0.08; e.gain.connect(e.send); e.send.connect(verbIn); }
  e.lp = ctx.createBiquadFilter(); e.lp.type = 'lowpass'; e.lp.frequency.value = 600; e.lp.Q.value = 0.9;
  e.lp.connect(e.gain);
  const keep = (n) => { e.nodes.push(n); return n; };
  const loop = (rate = 1) => { const s = keep(ctx.createBufferSource()); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.start(0, Math.random() * 1.5); return s; };
  // Tires on the road (or water past the hull): every ride has this.
  e.roll = ctx.createGain(); e.roll.gain.value = 0;
  e.rollF = ctx.createBiquadFilter(); e.rollF.type = m?.water ? 'bandpass' : 'lowpass'; e.rollF.frequency.value = 300; e.rollF.Q.value = m?.water ? 0.8 : 0.5;
  loop(0.7).connect(e.rollF); e.rollF.connect(e.roll); e.roll.connect(e.gain);
  if (!m) return e;
  if (m.electric) {   // golf cart: a motor's whine and nothing else
    e.osc = keep(ctx.createOscillator()); e.osc.type = 'triangle'; e.osc.frequency.value = 180;
    e.og = ctx.createGain(); e.og.gain.value = 0.25; e.osc.connect(e.og); e.og.connect(e.lp); e.osc.start();
    return e;
  }
  // The exhaust: the firing note, an octave down for weight and a detuned upper voice for growl,
  // through a clipper and a filter that opens with the throttle.
  const sh = drive(m.diesel ? 4 : 2.2); sh.connect(e.lp);
  e.mix = ctx.createGain(); e.mix.gain.value = 0.4; e.mix.connect(sh);
  e.osc = keep(ctx.createOscillator()); e.osc.type = m.wave;
  e.sub = keep(ctx.createOscillator()); e.sub.type = 'sine';
  e.hi = keep(ctx.createOscillator()); e.hi.type = m.wave; e.hi.detune.value = 9;
  const og = ctx.createGain(); og.gain.value = 0.55; e.osc.connect(og); og.connect(e.mix);
  const sg = ctx.createGain(); sg.gain.value = 0.7; e.sub.connect(sg); sg.connect(e.mix);
  const hg = ctx.createGain(); hg.gain.value = 0.25 * m.bright; e.hi.connect(hg); hg.connect(e.mix);
  // Each cylinder's pop: the note's volume pulses at the firing rate, more on a rough-running motor.
  e.am = ctx.createGain(); e.am.gain.value = 1 - m.rough * 0.5;
  e.mix.disconnect(); e.mix.connect(e.am); e.am.connect(sh);
  e.lfo = keep(ctx.createOscillator()); e.lfo.type = 'sine';
  e.lfoG = ctx.createGain(); e.lfoG.gain.value = m.rough * 0.5; e.lfo.connect(e.lfoG); e.lfoG.connect(e.am.gain);
  // Intake and valve noise, rising with the throttle; a diesel's clatter.
  e.air = ctx.createGain(); e.air.gain.value = 0;
  e.airF = ctx.createBiquadFilter(); e.airF.type = 'bandpass'; e.airF.Q.value = 1.4; e.airF.frequency.value = 900;
  loop(1).connect(e.airF); e.airF.connect(e.air); e.air.connect(e.lp);
  if (m.prop) {   // an airboat's propeller: a huge chopping roar
    e.propG = ctx.createGain(); e.propG.gain.value = 0;
    const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 700;
    loop(0.5).connect(pf); pf.connect(e.propG); e.propG.connect(e.gain);
  }
  for (const o of [e.osc, e.sub, e.hi, e.lfo]) o.start();
  return e;
}
function stopEngine(e) {
  const t = ctx.currentTime;
  e.gain.gain.cancelScheduledValues(t); e.gain.gain.setTargetAtTime(0, t, 0.12);
  for (const n of e.nodes) try { n.stop(t + 0.8); } catch { /* already stopped */ }
  setTimeout(() => { try { e.gain.disconnect(); } catch { /* gone */ } }, 1200);
}
/** The starter cranking over before it catches. */
function crank(e, w) {
  const d = out(Math.min(1, w.gain * 2) * 0.35, w.pan, 0.05);
  for (let i = 0; i < 6; i++) burst(d, { t: i * 0.085, dur: 0.07, type: 'bandpass', freq: 380 + i * 25, q: 1.5, gain: 0.6 });
  tone(d, { dur: 0.55, from: 140, to: 210, type: 'sawtooth', gain: 0.08 });
}
/**
 * Keep a ride's sound going this frame. Call every frame for each ride you can hear; rides not
 * updated for a moment fall silent. `o`: { x, y, z, speed (m/s), top (m/s), on (engine running),
 * own (you're aboard), throttle (-1..1, yours only), road (on pavement) }.
 */
export function ride(id, type, o) {
  if (!audio() || !settings.volume) return;
  const w = o.own ? { ...NEAR, gain: 1 } : place(o.x, o.y, o.z, MOTORS[type]?.prop ? 600 : 260);
  let e = engines.get(id);
  if (!w || (!o.on && !NO_MOTOR[type] && Math.abs(o.speed) < 0.5)) { if (e) { stopEngine(e); engines.delete(id); } return; }
  if (!e) {
    if (engines.size >= 7) {   // only the closest few: drop the farthest
      let far = null; for (const [k, x] of engines) if (!far || x.d > far[1].d) far = [k, x];
      if (far && far[1].d > w.d) { stopEngine(far[1]); engines.delete(far[0]); } else return;
    }
    e = startEngine(type); engines.set(id, e);
    if (e.m && !e.m.electric && o.on && (o.own || w.d < 40) && Math.abs(o.speed) < 1) { crank(e, w); e.born = ctx.currentTime + 0.5; }
  }
  e.seen = frame; e.d = w.d;
  const t = ctx.currentTime, tc = 0.06, m = e.m, sp = Math.abs(o.speed || 0), top = Math.max(4, o.top || 20), ratio = Math.min(1.1, sp / top);
  // How hard it's working: the throttle if it's yours, otherwise from how its speed changes.
  const accel = e.last == null ? 0 : (sp - e.last) / Math.max(0.016, t - (e.lastT || t));
  e.last = sp; e.lastT = t;
  const load = Math.max(0, Math.min(1, o.throttle != null ? Math.abs(o.throttle) : 0.25 + accel * 0.25));
  e.load = (e.load ?? load) + (load - (e.load ?? load)) * 0.15;
  const vol = Math.min(1, w.gain * (o.own ? 1 : 2.4)) * (o.own ? 0.75 : 1);
  if (e.pan) e.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, w.pan)), t, 0.05);
  const muffle = Math.min(w.muffle, 14000);
  // Rolling: tires hiss louder and brighter with speed; rougher off the road.
  e.roll.gain.setTargetAtTime(Math.min(0.5, ratio * (o.road === false ? 0.55 : 0.32)) * (m?.water ? 1.6 : 1), t, tc);
  e.rollF.frequency.setTargetAtTime(Math.min(muffle, (m?.water ? 500 : 220) + sp * (o.road === false ? 22 : 40)), t, tc);
  if (!m) {   // no motor: tires (and hooves) only
    e.gain.gain.setTargetAtTime(vol * (NO_MOTOR[type] === 'board' ? 0.8 : 0.5), t, tc);
    e.lp.frequency.setTargetAtTime(Math.min(muffle, 3000), t, tc);
    if (type === 'skateboard') e.rollF.frequency.setTargetAtTime(Math.min(muffle, 160 + sp * 30), t, tc);
    if (type === 'horse' && sp > 0.4) {
      e.gait = (e.gait || 0) + (o.dt || 0.016) * (1.6 + Math.min(14, sp) * 0.25);
      if (e.gait >= 1) { e.gait = 0; clop(o.x, o.y, o.z, o.road); if (sp > 6) setTimeout(() => clop(o.x, o.y, o.z, o.road), 90); }
    }
    return;
  }
  if (m.electric) {
    e.osc.frequency.setTargetAtTime(150 + sp * 55, t, tc);
    e.og.gain.setTargetAtTime(0.08 + e.load * 0.3, t, tc);
    e.lp.frequency.setTargetAtTime(Math.min(muffle, 2500), t, tc);
    e.gain.gain.setTargetAtTime(vol * (o.on ? 1 : 0), t, tc);
    return;
  }
  // Through the gears: revs climb, drop at each shift, climb again. Boats have one long gear.
  let rpm;
  if (!o.on) rpm = m.idle * 0.6;
  else if (m.gears <= 1) rpm = m.idle + (m.red - m.idle) * Math.min(1, ratio * 0.9 + e.load * 0.15);
  else {
    const x = Math.min(0.999, ratio) * m.gears, gear = Math.floor(x), f = x - gear;
    rpm = gear === 0 ? m.idle + (m.red - m.idle) * 0.85 * f : m.idle + (m.red - m.idle) * (0.42 + 0.5 * f);
    if (sp < 0.4) rpm = m.idle;
    rpm += (m.red - m.idle) * 0.08 * e.load;
  }
  e.rpm += (rpm - e.rpm) * 0.12;   // revs don't jump
  const fire = (e.rpm / 60) * (m.cyl / 2);
  e.osc.frequency.setTargetAtTime(fire, t, 0.03);
  e.sub.frequency.setTargetAtTime(fire / 2, t, 0.03);
  e.hi.frequency.setTargetAtTime(fire * 2, t, 0.03);
  e.lfo.frequency.setTargetAtTime(Math.max(4, fire / (m.cyl > 4 ? 2 : 1)), t, 0.03);
  const rev = (e.rpm - m.idle) / (m.red - m.idle);
  e.lp.frequency.setTargetAtTime(Math.min(muffle, (260 + rev * 2400 + e.load * 900) * m.bright), t, tc);
  e.air.gain.setTargetAtTime((0.05 + e.load * 0.25 + rev * 0.15) * (m.diesel ? 2 : 1), t, tc);
  e.airF.frequency.setTargetAtTime(Math.min(muffle, fire * (m.diesel ? 9 : 5)), t, tc);
  if (e.propG) e.propG.gain.setTargetAtTime(0.2 + rev * 0.9, t, tc);
  const starting = t < e.born ? 0 : 1;
  e.gain.gain.setTargetAtTime(vol * m.gain * (0.55 + rev * 0.35 + e.load * 0.25) * (o.on ? 1 : 0.0) * starting, t, starting ? tc : 0.01);
}

// ---- The countryside -----------------------------------------------------------------------------
const amb = { on: false };
function startAmbience() {
  amb.on = true;
  const loop = (rate) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.start(0, Math.random()); return s; };
  // Wind: low rushing noise, gusting slowly.
  amb.wind = ctx.createGain(); amb.wind.gain.value = 0;
  amb.windF = ctx.createBiquadFilter(); amb.windF.type = 'lowpass'; amb.windF.frequency.value = 380; amb.windF.Q.value = 0.6;
  loop(0.6).connect(amb.windF); amb.windF.connect(amb.wind); amb.wind.connect(bus);
  // Rain: a bright hiss, and a lower patter on leaves and roofs.
  amb.rain = ctx.createGain(); amb.rain.gain.value = 0;
  const rf = ctx.createBiquadFilter(); rf.type = 'highpass'; rf.frequency.value = 1800;
  const rl = ctx.createBiquadFilter(); rl.type = 'bandpass'; rl.frequency.value = 600; rl.Q.value = 0.5;
  const n1 = loop(1), n2 = loop(0.9); n1.connect(rf); n2.connect(rl);
  const rlg = ctx.createGain(); rlg.gain.value = 0.6; rl.connect(rlg);
  rf.connect(amb.rain); rlg.connect(amb.rain); amb.rain.connect(bus);
  // Crickets: a high trill, chopped into chirps.
  amb.crk = ctx.createGain(); amb.crk.gain.value = 0;
  for (const [f, trill, chirp, pan] of [[4300, 32, 2.6, -0.5], [4750, 41, 1.9, 0.45], [3900, 27, 3.3, 0.1]]) {
    const o = ctx.createOscillator(); o.frequency.value = f;
    const a = ctx.createGain(); a.gain.value = 0;
    const tr = ctx.createOscillator(); tr.type = 'square'; tr.frequency.value = trill;
    const trg = ctx.createGain(); trg.gain.value = 0.5;
    const ch = ctx.createOscillator(); ch.type = 'square'; ch.frequency.value = chirp;
    const chg = ctx.createGain(); chg.gain.value = 0.5;
    const env = ctx.createGain(); env.gain.value = 0;   // trill × chirp → on/off pulses
    tr.connect(trg); trg.connect(a.gain); ch.connect(chg); chg.connect(env.gain);
    o.connect(a); a.connect(env);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; env.connect(p); p.connect(amb.crk); } else env.connect(amb.crk);
    for (const x of [o, tr, ch]) x.start();
  }
  amb.crk.connect(bus);
  amb.nextCall = 0;
}
function bird(k) {
  const d = out(0.05 * k, Math.random() * 1.6 - 0.8, 0.5), base = 2200 + Math.random() * 2600, n = 2 + Math.floor(Math.random() * 4);
  const kind = Math.random();
  for (let i = 0; i < n; i++) {
    const t = i * (0.09 + Math.random() * 0.08);
    if (kind < 0.4) tone(d, { t, dur: 0.08, from: base, to: base * 1.35, type: 'sine', gain: 0.6, attack: 0.01 });          // tweet
    else if (kind < 0.75) tone(d, { t, dur: 0.12, from: base * 1.3, to: base * 0.8, type: 'sine', gain: 0.6, attack: 0.01 }); // tew
    else { tone(d, { t: t * 2, dur: 0.22, from: base * 0.6, to: base * 0.62, type: 'triangle', gain: 0.4, attack: 0.03 }); break; }   // a long whistle
  }
}
function frog(k) {
  const d = out(0.07 * k, Math.random() * 1.6 - 0.8, 0.5), f = 180 + Math.random() * 260, n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    tone(d, { t: i * 0.25, dur: 0.16, from: f * 1.2, to: f, type: 'square', gain: 0.18, attack: 0.02 });
    burst(d, { t: i * 0.25, dur: 0.16, type: 'bandpass', freq: f * 3, q: 6, gain: 0.25, attack: 0.02 });
  }
}
/**
 * The background, every frame: `night` 0 (day) … 1 (night), `rain` 0 … 1, `storm`, `wind` extra
 * rush (falling, riding fast), `town` 0 … 1 (fewer critters in town), `indoor` (muffled rain).
 */
export function ambience(o) {
  if (!audio() || !settings.volume) return;
  if (!amb.on) startAmbience();
  const t = ctx.currentTime, tc = 0.8, night = o.night || 0, rain = o.rain || 0, wild = 1 - (o.town || 0) * 0.7;
  const gust = 0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1);
  amb.wind.gain.setTargetAtTime(0.035 + gust * 0.03 + rain * 0.04 + Math.min(0.5, o.wind || 0), t, (o.wind || 0) > 0.05 ? 0.15 : tc);
  amb.windF.frequency.setTargetAtTime(300 + gust * 200 + Math.min(1200, (o.wind || 0) * 1500), t, 0.3);
  amb.rain.gain.setTargetAtTime(rain * (o.indoor ? 0.05 : 0.11) * (1 + (o.storm || 0) * 0.5), t, tc);
  amb.crk.gain.setTargetAtTime(Math.max(0, night - 0.3) * 0.022 * wild * (1 - rain * 0.8), t, 2);
  // Now and then a bird (day) or a frog (night) somewhere off in the trees.
  if (t > amb.nextCall) {
    amb.nextCall = t + 1.5 + Math.random() * 5;
    if (rain < 0.5 && Math.random() < wild) { if (night < 0.5) bird(1 - night); else if (Math.random() < 0.6) frog(night); }
  }
}

/** Thunder: a crack if it's close, then a long low roll. */
export function thunder(x, y, z) {
  if (!audio()) return;
  const w = place(x, y, z, 6000) || { gain: 0.02, pan: 0, d: 3000, delay: 1.6, muffle: 300 };
  const d = out(Math.min(1, 0.5 + w.gain * 6), w.pan * 0.5, 0.6), t = Math.min(4, w.d / 343);
  if (w.d < 600) burst(d, { t, dur: 0.25, type: 'highpass', freq: 1200, gain: 0.6, attack: 0.003 });
  for (let i = 0; i < 5; i++) burst(d, { t: t + i * (0.3 + Math.random() * 0.5), dur: 1.2 + Math.random(), type: 'lowpass', freq: 160 + Math.random() * 160, gain: 0.9 / (1 + i * 0.4), attack: 0.08 });
  tone(d, { t, dur: 2.5, from: 55, to: 30, gain: 0.5, attack: 0.1 });
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
/** A car door: getting in or out. */
export function door(x, y, z) {
  if (!audio()) return;
  const w = x == null ? NEAR : place(x, y, z, 40);
  if (!w) return;
  const d = out(Math.min(1, w.gain * 2) * 0.4, w.pan, 0.06);
  metal(d, { t: w.delay, base: 1200, ring: 0.04, gain: 0.2 });
  burst(d, { t: w.delay + 0.35, dur: 0.12, type: 'lowpass', freq: 350, gain: 0.9, attack: 0.002 });
  metal(d, { t: w.delay + 0.35, base: 900, ring: 0.08, gain: 0.2 });
}
/** A splash: something going into the water. */
export function splash(x, y, z, big = false) {
  if (!audio()) return;
  const w = place(x, y, z, 80);
  if (!w) return;
  const d = out(Math.min(1, w.gain * 2) * (big ? 0.6 : 0.35), w.pan, 0.15);
  burst(d, { t: w.delay, dur: big ? 0.6 : 0.3, type: 'bandpass', freq: 700, to: 1800, q: 0.8, gain: 0.8, attack: 0.01 });
  burst(d, { t: w.delay + 0.08, dur: 0.5, type: 'highpass', freq: 2500, gain: 0.25, attack: 0.05 });
}
/** A breach charge, grenade or other blast: a hard crack, a deep boom and a long roll. */
export function boom(x, y, z) {
  if (!audio()) return;
  const w = place(x, y, z, 2500);
  if (!w) return;
  const d = out(Math.min(1.2, w.gain * 3), w.pan, Math.min(1.2, w.wet * 0.8)), t = w.delay;
  if (sample('boom', d, { t })) return;
  const sh = drive(3); sh.connect(d);
  if (w.d < 200) burst(sh, { t, dur: 0.05, type: 'highpass', freq: Math.min(w.muffle, 1800), gain: 1, attack: 0.001 });
  tone(sh, { t, dur: 0.9, from: 95, to: 28, gain: 1, attack: 0.002 });
  burst(sh, { t, dur: 1.4 + w.d / 500, type: 'lowpass', freq: Math.min(w.muffle, 1400), to: 200, gain: 0.9, attack: 0.004 });
  if (w.d < 60) grit(d, { t: t + 0.4, dur: 1.2, n: 14, freq: 2400, gain: 0.12 });   // debris pattering down
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

/** A base alarm's siren: a rising and falling wail for a few seconds, from where the alarm is. */
export function siren(x, y, z) {
  if (!audio()) return;
  const w = place(x, y, z, 400);
  if (!w) return;
  const d = out(Math.min(0.9, w.gain * 2.2), w.pan, 0.5);
  for (let i = 0; i < 6; i++) {
    tone(d, { t: w.delay + i * 0.7, dur: 0.35, from: 620, to: 1150, type: 'sawtooth', gain: 0.22 });
    tone(d, { t: w.delay + i * 0.7 + 0.35, dur: 0.35, from: 1150, to: 620, type: 'sawtooth', gain: 0.22 });
  }
}

/** Once a frame: silence rides that weren't updated (out of earshot, gone, parked). */
export function tick() {
  if (!ctx) return;
  frame++;
  for (const [id, e] of engines) if (frame - e.seen > 3) { stopEngine(e); engines.delete(id); }
}
/** For checking from the console: what's running. */
export function debug() { return { state: ctx?.state, engines: [...engines].map(([id, e]) => ({ id, type: e.type, rpm: Math.round(e.rpm), d: Math.round(e.d) })), samples: [...samples.keys()] }; }
