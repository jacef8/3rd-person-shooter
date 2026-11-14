// The lobby's moving background: Liberty County drawn in points of light. Every real road is a
// trail of pale points, the state routes run in the game's orange, the Apalachicola and the other
// rivers in blue, and each town is a warm cluster. It turns slowly in 3D and leans toward the
// pointer (or the right stick). It sits behind the lobby's solid panels and never under text.
// Stops and frees the GPU once you're in the game; holds still if your device asks for less motion.
import * as THREE from 'three';
import { geography, project } from '/shared/geography.js';

const SIZE = 30000, K = 1 / 1000;   // world metres -> scene units (the county is 30 units across)

export function startLobbyFx(canvas, { isVisible, look = () => [0, 0] }) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = Math.min(innerWidth, innerHeight) < 600;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { return () => {}; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  const group = new THREE.Group();
  scene.add(group);

  const geo = geography(SIZE);
  const pts = [], col = [], sizes = [], seeds = [];
  const add = (x, z, c, s) => { if (Math.abs(x) > SIZE / 2 || Math.abs(z) > SIZE / 2) return; pts.push(x * K, 0, z * K); col.push(...c); sizes.push(s); seeds.push(Math.random() * 6.283); };
  const trail = (line, step, c, s, jitter = 0) => {
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, z1] = line[i], [x2, z2] = line[i + 1], n = Math.max(1, Math.round(Math.hypot(x2 - x1, z2 - z1) / step));
      for (let k = 0; k < n; k++) add(x1 + (x2 - x1) * k / n + (Math.random() - 0.5) * jitter, z1 + (z2 - z1) * k / n + (Math.random() - 0.5) * jitter, c, s);
    }
  };
  const ROAD = [0.74, 0.84, 1], ROUTE = [1, 0.48, 0.1], RIVER = [0.35, 0.72, 1], TOWN = [1, 0.8, 0.35];
  for (const r of geo.rivers) trail(r.pts, 45, RIVER, 1.5, r.width * 0.8);
  for (const r of geo.roads) trail(r.pts, 70, ROUTE, 1.6);
  for (const t of geo.towns) for (let k = 0; k < (t.blocks || 3) * 40; k++) { const a = Math.random() * 6.283, d = Math.pow(Math.random(), 0.7) * (300 + (t.blocks || 3) * 60); add(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, TOWN, 1.3); }
  const build = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
    g.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    return g;
  };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { t: { value: 0 }, px: { value: Math.max(renderer.getPixelRatio(), 1.8) } },   // points stay visible on low-density screens
    vertexShader: `attribute float size; attribute float seed; attribute vec3 color; uniform float t, px; varying vec3 vc; varying float tw;
      void main() { vec3 p = position; p.y += sin(t * 0.4 + seed + p.x * 0.3) * 0.06;
        tw = 0.75 + 0.25 * sin(t * 1.2 + seed * 7.0); vc = color;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = size * px * (44.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vc; varying float tw; void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
      gl_FragColor = vec4(vc, pow(1.0 - d * 2.0, 1.6) * tw); }`,
  });
  let points = new THREE.Points(build(), mat);
  group.add(points);
  // A faint dust of stars around it, for depth.
  const star = [];
  for (let i = 0; i < (small ? 600 : 1500); i++) star.push((Math.random() - 0.5) * 90, -6 - Math.random() * 30, (Math.random() - 0.5) * 90);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(star, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x8fa8d8, size: 0.08, transparent: true, opacity: 0.6, depthWrite: false })));

  // Every real road too, once its data arrives (the world needs the same file later anyway).
  fetch('/data/real/roads.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || !renderer) return;
    const budget = small ? 9000 : 22000;
    const lines = d.rows.map(([, cls, ll]) => ({ minor: cls === 'track' || cls === 'service', pts: ll.map(([la, lo]) => { const p = project(la, lo, SIZE); return [p.x, p.z]; }) }));
    const total = lines.reduce((a, l) => a + l.pts.slice(1).reduce((b, p, i) => b + Math.hypot(p[0] - l.pts[i][0], p[1] - l.pts[i][1]), 0), 0);
    const step = Math.max(40, total / budget);
    for (const l of lines) trail(l.pts, step, l.minor ? [0.5, 0.6, 0.78] : ROAD, l.minor ? 0.9 : 1.15);
    group.remove(points); points.geometry.dispose();
    points = new THREE.Points(build(), mat);
    group.add(points);
  }).catch(() => {});

  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); };
  addEventListener('resize', resize);
  resize();
  let px = 0, py = 0, running = true;
  const onMove = (e) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; };
  addEventListener('pointermove', onMove);
  // The county from the south-west, tipped toward you; it turns about once every four minutes.
  let ang = -0.6, lean = 0, tilt = 0;
  const frame = (ms) => {
    if (!running) return;
    if (!isVisible()) { stop(); return; }
    const [sx, sy] = look();
    const tx = px + sx * 0.5, ty = py + sy * 0.5;
    if (!calm) ang += 0.00045;
    lean += (tx * 0.5 - lean) * 0.04; tilt += (ty * 0.25 - tilt) * 0.04;
    // Closer in on wide screens, and set to the left so the county sits beside the card.
    const wide = canvas.clientWidth / Math.max(1, canvas.clientHeight), r = wide > 1.5 ? 21 : 25, h = 13 + tilt * 10;
    cam.position.set(Math.sin(ang + lean) * r, h, Math.cos(ang + lean) * r);
    cam.lookAt(wide > 1.5 ? 1 : 2.5, -2, 0);
    mat.uniforms.t.value = ms / 1000;
    renderer.render(scene, cam);
    if (!calm && !document.hidden) requestAnimationFrame(frame);
  };
  const wake = () => { if (!document.hidden && running && !calm) requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', wake);
  requestAnimationFrame(frame);
  // Holding still for reduced motion: draw one frame once the roads have arrived.
  if (calm) setTimeout(() => requestAnimationFrame(frame), 1500);
  function stop() {
    running = false;
    removeEventListener('resize', resize); removeEventListener('pointermove', onMove);
    document.removeEventListener('visibilitychange', wake);
    points.geometry.dispose(); mat.dispose(); renderer.dispose(); renderer = null;
  }
  return stop;
}
