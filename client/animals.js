// Wildlife models: deer, hogs (and the event boar, a hog scaled up), alligators and dogs, each a
// skinned, animated model (client/models/animals/, see its CREDITS.md). An animal is made at once as a
// simple stand-in shape and swaps to the real model when it has loaded; it idles, walks or runs by
// how fast it is really moving, the steps kept in time with its speed.
import * as THREE from 'three';
import { GLTFLoader } from '/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
const files = new Map();
const load = (name) => { if (!files.has(name)) files.set(name, loader.loadAsync(`/models/animals/${name}.glb`)); return files.get(name); };
/** Ground covered (m/s) by one play of each clip at normal speed, and the speed a walk turns to a run. */
const PACE = {
  deer: { walk: 1.3, run: 5.5, runAt: 2.6 },
  hog: { walk: 0.55, run: 2.4, runAt: 1.8 },
  gator: { walk: 0.35, run: 1.4, runAt: 1.2 },
  dog: { walk: 0.9, run: 4.0, runAt: 2.2 },
  horse: { walk: 1.7, run: 8.5, runAt: 3.4 },
};

export function preloadAnimals() { for (const n of Object.keys(PACE)) load(n).catch(() => {}); }

/**
 * A `kind` model of its own with its animations, for something other than wildlife to wear (the
 * horse you ride): { model, anim }, or null if it can't be had. Step it with stepAnimal.
 */
export async function animalModel(kind) {
  try {
    const gltf = await load(kind);
    const model = cloneSkinned(gltf.scene);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const mixer = new THREE.AnimationMixer(model), actions = {};
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
    const anim = { kind, mixer, actions, cur: null, speed: 0 };
    play(anim, 'idle', 0);
    return { model, anim };
  } catch { return null; }
}
/** Idle, walk or run at `speed` (m/s, as the thing carrying it moves), steps in time with it. */
export function stepAnimal(a, speed, dt) {
  if (!a || dt <= 0) return;
  a.speed += (Math.min(speed, 20) - a.speed) * Math.min(1, dt * 6);
  const p = PACE[a.kind], s = a.speed;
  const gait = s < 0.3 ? 'idle' : s < p.runAt ? 'walk' : 'run';
  play(a, gait);
  a.cur.timeScale = gait === 'idle' ? 1 : Math.max(0.5, Math.min(2.2, s / p[gait]));
  a.mixer.update(dt);
}

/** Swap the stand-in in group `g` for the real `kind` model once it's in. */
export function attachAnimal(g, kind) {
  if (!PACE[kind]) return;
  load(kind).then((gltf) => {
    if (!g.parent) return;   // gone before it loaded
    const model = cloneSkinned(gltf.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.frustumCulled = false;   // skinned: its bounds don't follow the pose
      o.material = o.material.clone();                // its own, so a thermal glow lights only this one
    });
    for (const c of [...g.children]) if (c.isMesh) g.remove(c);   // the stand-in boxes
    g.add(model);
    const mixer = new THREE.AnimationMixer(model), actions = {};
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
    g.userData.anim = { kind, mixer, actions, cur: null, speed: 0, px: g.position.x, pz: g.position.z };
    play(g.userData.anim, 'idle', 0);
  }).catch(() => { /* keep the stand-in */ });
}

function play(a, name, fade = 0.25) {
  const next = a.actions[name] || a.actions.idle;
  if (!next || a.cur === next) return;
  next.reset().play();
  if (a.cur) next.crossFadeFrom(a.cur, fade, false);
  a.cur = next;
}

/** Each frame: pick idle, walk or run from how fast it actually moved, and step the animation. */
export function animateAnimal(g, dt) {
  const a = g.userData.anim;
  if (!a || dt <= 0) return;
  const moved = Math.hypot(g.position.x - a.px, g.position.z - a.pz) / dt;
  a.px = g.position.x; a.pz = g.position.z;
  a.speed += (Math.min(moved, 20) - a.speed) * Math.min(1, dt * 6);
  const p = PACE[a.kind], s = a.speed / (g.scale.x || 1);   // a big boar takes bigger steps
  const gait = s < 0.25 ? 'idle' : s < p.runAt ? 'walk' : 'run';
  play(a, gait);
  a.cur.timeScale = gait === 'idle' ? 1 : Math.max(0.5, Math.min(2.5, s / p[gait]));
  a.mixer.update(dt);
}
