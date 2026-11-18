// The finish on the picture: what makes it read as a game rather than a 3D sketch.
//   - The far landscape and the near world drawn into one high-range image (so bright sky can glow),
//     with multisampled (smooth) edges.
//   - Ambient occlusion (GTAO): soft shade where things meet, in corners, under cars, round the foot of a
//     wall. Leaves, grass and other cut-out cards are left out of it (they'd shade as solid squares).
//   - Bloom: a soft glow off the brightest things (the sun on metal, lamps, muzzle flashes).
//   - Then tone mapping, and a grade: a touch more contrast and warmth, and a faint vignette.
// Quality follows the graphics setting: Low skips all of it (the plain render), Medium has no AO.
import * as THREE from 'three';
import { EffectComposer } from '/addons/postprocessing/EffectComposer.js';
import { Pass } from '/addons/postprocessing/Pass.js';
import { GTAOPass } from '/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from '/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '/addons/postprocessing/ShaderPass.js';

/** Draws the far scene, then the near one over it, into the composer's buffer. */
class WorldPass extends Pass {
  constructor(draw) { super(); this.draw = draw; this.needsSwap = false; }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.draw(renderer);
  }
}

/** GTAO that leaves out cut-out cards (leaves, grass, fences of planks drawn as pictures) and lines. */
class CleanGTAOPass extends GTAOPass {
  _overrideVisibility() {
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const m = o.material;
      const cutout = m && !Array.isArray(m) && (m.alphaTest > 0 || m.transparent || m.side === THREE.DoubleSide);
      if (o.isPoints || o.isLine || o.isLine2 || o.isSprite || (o.isMesh && cutout) || o.userData.noAO) { o.visible = false; cache.push(o); }
    });
  }
}

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, contrast: { value: 1.1 }, saturation: { value: 1.08 }, warmth: { value: 0.025 }, vignette: { value: 0.22 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast, saturation, warmth, vignette; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      col = (col - 0.5) * contrast + 0.5;                                  // a little more punch
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);                                 // a little richer
      col += vec3(warmth, warmth * 0.35, -warmth);                         // Florida afternoon, not overcast blue
      vec2 d = vUv - 0.5; col *= 1.0 - vignette * smoothstep(0.35, 0.85, length(d * vec2(1.25, 1.0)));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

/**
 * `draw(renderer)` renders the far scene then the near one (clearing depth between). `scene` / `camera`:
 * the near world, for the ambient occlusion. Returns { render(), setSize(w, h, pixelRatio), setQuality(mode) }.
 */
export function createPost(renderer, scene, camera, draw) {
  let composer = null, ao = null, bloom = null, mode = 'off';
  const size = new THREE.Vector2();
  function build(q) {
    composer?.dispose?.();
    composer = null; ao = null; bloom = null;
    if (q === 'off') return;
    renderer.getDrawingBufferSize(size);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q === 'ultra' ? 8 : 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new WorldPass(draw));
    if (q === 'high' || q === 'ultra') {
      ao = new CleanGTAOPass(scene, camera, size.x, size.y);
      ao.blendIntensity = 0.85;
      ao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: q === 'ultra' ? 16 : 12 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      composer.addPass(ao);
    }
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.18, 0.4, 2.2);   // only what's really bright: glints, lamps, flashes (not the whole sky)
    composer.addPass(bloom);
    composer.addPass(new OutputPass());   // tone mapping and sRGB, as the plain render did
    composer.addPass(new ShaderPass(GradeShader));
    composer.setPixelRatio(1);
    composer.setSize(size.x, size.y);
  }
  return {
    /** off (Low), medium (no AO), high, ultra. */
    setQuality(q) { if (q !== mode) { mode = q; build(q); } },
    get on() { return !!composer; },
    setSize() {
      if (!composer) return;
      renderer.getDrawingBufferSize(size);
      composer.setSize(size.x, size.y);
      ao?.setSize(size.x, size.y);
    },
    render(dt) {
      if (composer) composer.render(dt);
      else draw(renderer);
    },
  };
}
