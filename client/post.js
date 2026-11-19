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

// The last pass, drawn to the screen at its full resolution: when the world was drawn smaller than
// the screen (the graphics setting's pixel budget), it's sharpened as it's scaled up (AMD's
// contrast-adaptive sharpening: edges and texture detail come back without halos), then graded.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, contrast: { value: 1.1 }, saturation: { value: 1.08 }, warmth: { value: 0.025 }, vignette: { value: 0.22 }, sharpen: { value: 0 }, texel: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float contrast, saturation, warmth, vignette, sharpen; uniform vec2 texel; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      if (sharpen > 0.0) {
        vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, -texel.y)).rgb, s = texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb;
        vec3 e = texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb, w = texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0)).rgb;
        vec3 mn = min(col, min(min(n, s), min(e, w))), mx = max(col, max(max(n, s), max(e, w)));
        vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
        vec3 wt = amp * (-1.0 / mix(8.0, 5.0, sharpen));
        col = clamp((col + (n + s + e + w) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
      }
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
  let composer = null, ao = null, bloom = null, grade = null, mode = 'off', scale = 1;
  const size = new THREE.Vector2();
  /** The world's size in pixels: the screen's, times the render scale. */
  const inner = () => { renderer.getDrawingBufferSize(size); size.set(Math.max(1, Math.round(size.x * scale)), Math.max(1, Math.round(size.y * scale))); return size; };
  const fitGrade = () => { if (!grade) return; grade.uniforms.texel.value.set(1 / size.x, 1 / size.y); grade.uniforms.sharpen.value = scale < 0.99 ? 0.75 : 0.3; };
  function build(q) {
    // (The composer's own dispose leaves its passes' render targets behind: free them too, or each
    // quality change by the frame-rate governor leaks tens of MB of GPU memory.)
    if (composer) { for (const p of composer.passes || []) p.dispose?.(); composer.dispose?.(); }
    composer = null; ao = null; bloom = null; grade = null;
    if (q === 'off') return;
    inner();
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
    // Cap the brightest pixels first: the sun in the sky is thousands of times brighter than anything
    // else, and left alone its glow would wash out half the screen whenever you face it.
    composer.addPass(new ShaderPass({ uniforms: { tDiffuse: { value: null } }, vertexShader: GradeShader.vertexShader,
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float m = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c.rgb * min(1.0, 3.0 / max(m, 1e-4)), c.a); }' }));
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.16, 0.4, 2.6);   // only what's really bright: glints, lamps, flashes (not the whole sky)
    composer.addPass(bloom);
    composer.addPass(new OutputPass());   // tone mapping and sRGB, as the plain render did
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
    composer.setPixelRatio(1);
    composer.setSize(size.x, size.y);
    fitGrade();
  }
  return {
    /** off (Low), medium (no AO), high, ultra. */
    setQuality(q) { if (q !== mode) { mode = q; build(q); } },
    get on() { return !!composer; },
    setSize() {
      if (!composer) return;
      inner();
      composer.setSize(size.x, size.y);
      ao?.setSize(size.x, size.y);
      fitGrade();
    },
    /** Draw the world at this share of the screen's width and height (it's sharpened back up to the screen). */
    setScale(s) {
      s = Math.max(0.5, Math.min(1, s || 1));
      if (Math.abs(s - scale) < 0.01) return;
      scale = s;
      this.setSize();
    },
    get scale() { return scale; },
    render(dt) {
      if (composer) composer.render(dt);
      else draw(renderer);
    },
  };
}
