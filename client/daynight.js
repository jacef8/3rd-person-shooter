// Day and night, and the weather. Everyone sees the same: both come from the clock, not from the
// server. A day lasts 48 minutes (about 34 of daylight, dusk and dawn included, and 14 of night); the
// weather changes every 15 minutes, fading from one to the next over a minute and a half.
//
//   clear · cloudy · rain · thunderstorm (rain, lightning, thunder)
import * as THREE from 'three';

export const DAY_MS = 48 * 60 * 1000;
const WEATHER_MS = 15 * 60 * 1000, BLEND_MS = 90 * 1000;
const WEATHERS = {
  //        share  clouds dens  sun   sky   rain fog     label
  clear:  [0.50, 0.22, 0.30, 1.00, 1.00, 0, 0.0, '☀ Clear'],
  cloudy: [0.24, 0.72, 0.60, 0.50, 0.75, 0, 0.0, '☁ Cloudy'],
  rain:   [0.16, 0.92, 0.80, 0.32, 0.58, 1, 0, '🌧 Rain'],
  storm:  [0.08, 1.00, 0.95, 0.22, 0.45, 2, 0, '⛈ Thunderstorm'],
};
const NAMES = Object.keys(WEATHERS);
const hashU = (n) => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0; h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function weatherAt(windowIndex) {
  let u = hashU(windowIndex), acc = 0;
  for (const n of NAMES) { acc += WEATHERS[n][0]; if (u < acc) return n; }
  return 'clear';
}
/** Time of day 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset) and the weather now. */
export function worldClock(now = Date.now()) {
  const o = globalThis.__dzClock;   // (tests: { t, weather })
  if (o) return { t: o.t, weather: o.weather, prev: o.weather, blend: 1 };
  const t = ((now % DAY_MS) + DAY_MS) % DAY_MS / DAY_MS;
  const w = Math.floor(now / WEATHER_MS), into = now - w * WEATHER_MS;
  return { t, weather: weatherAt(w), prev: weatherAt(w - 1), blend: Math.min(1, into / BLEND_MS) };
}
export function clockLabel(c) {
  const mins = Math.floor(c.t * 24 * 60), h = Math.floor(mins / 60), m = mins % 60, h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} · ${WEATHERS[c.weather][7]}`;
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const C = (h) => new THREE.Color(h);
const DAY_SKY = C(0xdfe8f0), NIGHT_SKY = C(0x3a4f7a), DAY_GROUND = C(0x3a3530), NIGHT_GROUND = C(0x10121a);
const SUN_HIGH = C(0xfff1dc), SUN_LOW = C(0xffa04a), MOON = C(0x9fb6e6);
const HORIZON_DAY = C(0xbfd3e3), HORIZON_DUSK = C(0xd9a27a), HORIZON_NIGHT = C(0x0d1424), HORIZON_GREY = C(0x9aa3ab);

/**
 * Drive the lights, sky, fog, rain and the towns' lamps from the clock. `opts`: { scene, far, sky,
 * sun, hemi, renderer, camera, towns, thunder(x, y, z) }.
 */
export function createEnvironment(o) {
  const { scene, far, sky, sun, hemi, renderer, camera } = o;
  // Fog is always on (thin as nothing when it's clear), so materials never recompile mid-game.
  scene.fog = new THREE.FogExp2(HORIZON_DAY.getHex(), 0);
  const farFog = far.fog;
  const u = sky?.material.uniforms;
  // Stars, far out, for clear nights.
  const starGeo = new THREE.BufferGeometry(), sp = [];
  for (let i = 0; i < 1600; i++) {
    const a = Math.random() * Math.PI * 2, y = Math.random() ** 0.6;
    const r = Math.sqrt(1 - y * y);
    sp.push(Math.cos(a) * r * 50000, y * 50000 + 800, Math.sin(a) * r * 50000);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -9; stars.frustumCulled = false;
  far.add(stars);
  // A moon disc.
  const moon = new THREE.Mesh(new THREE.CircleGeometry(900, 32), new THREE.MeshBasicMaterial({ color: 0xe9eef8, fog: false, transparent: true, opacity: 0 }));
  moon.renderOrder = -8; far.add(moon);
  // Rain: streaks in a box that follows the camera.
  const N = 1800, rainPos = new Float32Array(N * 6), seeds = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { seeds[i * 3] = Math.random() * 60 - 30; seeds[i * 3 + 1] = Math.random() * 30; seeds[i * 3 + 2] = Math.random() * 60 - 30; }
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false; scene.add(rain);
  let fall = 0, flash = 0, nextBolt = performance.now() + 8000, thunderAt = 0, thunderPos = null;
  const dir = new THREE.Vector3(), moonDir = new THREE.Vector3(), horizon = new THREE.Color(), tmp = new THREE.Color();
  const mix = (k, i) => { const a = WEATHERS[k.prev][i], b = WEATHERS[k.weather][i]; return a + (b - a) * k.blend; };
  const state = { clock: worldClock(), night: 0 };

  return {
    state,
    /** Once a frame. `target` is where the light should centre (the player), dt in seconds. */
    update(target, dt) {
      const now = Date.now(), pnow = performance.now(), c = state.clock = worldClock(now);
      // The sun: up in the east (+x) at 0.25, high in the south (+z) at noon, down in the west at 0.75.
      const th = (c.t - 0.25) * Math.PI * 2;
      dir.set(Math.cos(th), Math.sin(th), Math.sin(th) * 0.42 + 0.18).normalize();
      moonDir.copy(dir).negate(); moonDir.y = Math.abs(moonDir.y) * 0.8 + 0.25; moonDir.normalize();
      const el = dir.y, day = smooth(-0.1, 0.16, el), dusk = smooth(-0.12, 0.02, el) * (1 - smooth(0.05, 0.3, el));
      state.night = 1 - day;
      const clouds = mix(c, 1), dens = mix(c, 2), sunK = mix(c, 3), skyK = mix(c, 4), rainK = Math.min(1, mix(c, 5)), storm = Math.max(0, mix(c, 5) - 1), fog = mix(c, 6);
      // Sunlight by day, moonlight by night (the shadows follow whichever is up).
      const up = el > -0.04 ? dir : moonDir;
      sun.position.set(target.x + up.x * 90, target.y + up.y * 90, target.z + up.z * 90);
      sun.target.position.copy(target);
      sun.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(0.02, 0.35, el)).lerp(MOON, 1 - day);
      sun.intensity = (2.1 * day * sunK) + (0.7 * (1 - day) * (0.5 + 0.5 * sunK));   // moonlight bright enough to play by
      hemi.color.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(HORIZON_GREY, (1 - skyK) * 0.5 * day);
      hemi.groundColor.copy(NIGHT_GROUND).lerp(DAY_GROUND, day);
      hemi.intensity = (0.85 * day * (0.75 + 0.25 * skyK) + 0.85 * (1 - day)) + flash * 2.5;
      // Sky: the scattering model follows the sun; clouds by the weather; a horizon colour to match.
      if (u) {
        u.sunPosition.value.copy(dir);
        u.cloudCoverage.value = clouds; u.cloudDensity.value = dens;
        u.turbidity.value = 3.2 + (1 - skyK) * 8; u.rayleigh.value = 1.35 * (0.4 + 0.6 * skyK);
        if (u.time) u.time.value = pnow / 1000;
      }
      horizon.copy(HORIZON_NIGHT).lerp(HORIZON_DUSK, dusk * skyK).lerp(HORIZON_DAY, day * (1 - dusk)).lerp(tmp.copy(HORIZON_GREY).multiplyScalar(0.3 + 0.7 * day), (1 - skyK) * 0.7);
      renderer.setClearColor(horizon);
      // Fog: thick and grey in fog, a light veil in rain; the far landscape fades into it too.
      const fd = fog * (0.75 + 0.25 * day);
      scene.fog.color.copy(horizon); scene.fog.density = fd;
      if (farFog) { farFog.color.copy(horizon); farFog.near = fog > 1e-4 ? 40 : 4000; farFog.far = fog > 1e-4 ? Math.max(150, 2.2 / Math.max(fog, 1e-6)) : 70000; }
      if (sky) sky.visible = fog < 0.008;
      starMat.opacity = Math.max(0, (1 - day) - clouds * 0.9) * (fog > 0.008 ? 0 : 1);
      stars.position.set(camera.position.x, 0, camera.position.z);
      moon.position.set(camera.position.x + moonDir.x * 45000, moonDir.y * 45000, camera.position.z + moonDir.z * 45000); moon.lookAt(camera.position);
      moon.material.opacity = Math.max(0, (1 - day) * (1 - clouds * 0.8)) * (fog > 0.008 ? 0 : 1);
      renderer.toneMappingExposure = 1.05;
      // Rain streaks around the camera.
      rainMat.opacity = rainK * (0.35 + 0.25 * day);
      rain.visible = rainK > 0.02;
      if (rain.visible) {
        fall = (fall + dt * (storm > 0 ? 26 : 19)) % 30;
        const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, slant = 0.08 + storm * 0.12, n = Math.floor(N * (0.5 + 0.5 * rainK) * (1 + storm * 0.5) / 1.5);
        for (let i = 0; i < N; i++) {
          if (i >= n) { rainPos.fill(0, i * 6, i * 6 + 6); continue; }
          const x = cx + seeds[i * 3], z = cz + seeds[i * 3 + 2], y = cy + 15 - ((seeds[i * 3 + 1] + fall) % 30);
          rainPos[i * 6] = x; rainPos[i * 6 + 1] = y; rainPos[i * 6 + 2] = z;
          rainPos[i * 6 + 3] = x + slant; rainPos[i * 6 + 4] = y + 0.7; rainPos[i * 6 + 5] = z + slant * 0.5;
        }
        rainGeo.attributes.position.needsUpdate = true;
      }
      // Lightning: a flash across the sky, then thunder a few seconds later.
      flash = Math.max(0, flash - dt * 7);
      if (storm > 0.3 && pnow > nextBolt) {
        flash = 1; nextBolt = pnow + 6000 + Math.random() * 14000;
        const a = Math.random() * Math.PI * 2, d = 400 + Math.random() * 1800;
        thunderPos = { x: target.x + Math.cos(a) * d, y: target.y + 300, z: target.z + Math.sin(a) * d };
        thunderAt = pnow + d / 343 * 1000;
      }
      if (thunderPos && pnow > thunderAt) { o.thunder?.(thunderPos.x, thunderPos.y, thunderPos.z); thunderPos = null; }
      o.towns?.setGlow(Math.max(1 - day, (1 - skyK) * 0.5));
    },
  };
}
