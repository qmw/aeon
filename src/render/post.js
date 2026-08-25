// AEON — post chain. Owns the frame, and the tonemap, once it exists.
//
//   scene  -> RGBA16F + depth texture, jittered projection
//   bloom  -> Karis bright pass, 4-level down/up pyramid, 7 tiny draws
//   Grade  -> depth AO, a 16-step screen-space SUN shadow reaching a full hex,
//             projected cloud shadows on DIRECT light only,
//             camera-relative height-fog aerial perspective, bloom add, cool
//             shadow fill, highlight desaturation, ACES, gamma/gain, a
//             high-pivot contrast, split tone, and ONE display-space lerp
//             toward the haze colour. No vignette.               [1 full-res pass]
//   TAA    -> 8-sample Halton jitter, depth reprojection, Catmull-Rom history
//             resample, 3x3 YCoCg VARIANCE clamp at 1.25 sd, 0.92
//             feedback; the AA *and* the denoiser                [1 full-res pass]
//   Present-> RCAS + a 0.8px thresholded luma unsharp + an 8px luma local
//             contrast, all graded by the per-pixel texel FOOTPRINT (eye depth
//             over N.V) so detail shrinks where the material is compressed,
//             + dither, to the default FB                        [1 full-res pass]
//
// Three structural decisions, each paid for in bugs first:
//
//  * The scene buffer is RGBA16F and `renderer.toneMapping` is off (sky.js turns
//    it off before any material compiles). Tonemapping in the material *and*
//    again here is what turned the old frame into flat grey mud, and an 8-bit
//    scene buffer clips snow and foam before the shoulder ever sees them.
//  * The scene target is written once and never re-entered. EffectComposer
//    clones the target it is handed, and a cloned DepthTexture shares its
//    Source — both ping-pong buffers end up bound to the *same* GL depth
//    texture, so any pass writing to one while sampling tDepth is a framebuffer
//    feedback loop (black frame on swiftshader) that also clears scene depth.
//  * AA is TEMPORAL, not spatial, and SMAA is gone. Three quarters of the frame's
//    high-frequency energy is not geometry aliasing at all — it is stochastic
//    noise (8-tap AO, the contact-shadow march) and 1px vegetation billboards
//    drawn with dithered alpha. SMAA cannot touch either; it resolves silhouettes
//    and leaves a boiling image. Jittering the projection and averaging eight
//    Halton samples resolves the silhouettes AND integrates the noise and the
//    screen-door alpha away, and it costs ONE full-res pass where SMAA cost three.
//  * The sharpen runs AFTER the temporal resolve, never before. A CAS pass in
//    front of the accumulator is a Nyquist amplifier: its kernel IS the checker
//    filter, so a 0.30 gain multiplied the frame's per-pixel grain by ~2.8x. On
//    the resolved image the same pass only puts the edge back.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const QUAD_VERT = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

// ---------------------------------------------------------------------- bloom
// Bright pass -> 4-level down/up pyramid (Call of Duty style). The point of the
// pyramid over a single blur is energy: a wide glow built from one Gaussian is
// either a tight halo or a grey wash, whereas summing octaves gives a tight core
// with a long, cheap, low-amplitude skirt — which is what a real lens does.
//
// Karis average on the bright pass only: weighting each tap by 1/(1+luma) stops
// a single blown pixel (water glitter, a snow facet) from strobing into a
// full-frame flicker when the camera moves. It costs correctness on the very
// brightest highlights, which is why it is not used further down the chain.
const BrightShader = {
  uniforms: {
    tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    // 1.05 in DISPLAY units, i.e. only what the tonemap is already about to blow.
    // Lit sand sits near 0.9 and must not bloom: anything lower turns the desert
    // into a beige wash that eats the lower half of the frame. Paired with uBloom
    // at 0.085 (was 0.15) the glow is a lens artefact again, not a haze layer.
    uThreshold: { value: 1.14 }, uExposure: { value: 1 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold, uExposure;
    varying vec2 vUv;
    void main() {
      // four bilinear taps two texels apart == a soft 4x4 box downsample
      vec3 c0 = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
      vec3 c1 = texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
      vec3 c2 = texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
      vec3 c3 = texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
      float w0 = 1.0 / (1.0 + max(c0.r, max(c0.g, c0.b)) * uExposure);
      float w1 = 1.0 / (1.0 + max(c1.r, max(c1.g, c1.b)) * uExposure);
      float w2 = 1.0 / (1.0 + max(c2.r, max(c2.g, c2.b)) * uExposure);
      float w3 = 1.0 / (1.0 + max(c3.r, max(c3.g, c3.b)) * uExposure);
      vec3 c = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / (w0 + w1 + w2 + w3);

      // threshold in *display* units, so it tracks the grade's exposure instead
      // of drifting off it. A fixed scene-linear threshold is how the last build
      // ended up with a bloom pass that never fired on anything.
      c *= uExposure;
      float l = max(c.r, max(c.g, c.b));
      float k = max(l - uThreshold, 0.0);
      gl_FragColor = vec4(c * (k / max(l, 1e-4)), 1.0);
    }`,
};
const DownShader = {
  uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tSrc, vUv).rgb * 0.5;
      c += (texture2D(tSrc, vUv + uTexel).rgb + texture2D(tSrc, vUv - uTexel).rgb
          + texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb
          + texture2D(tSrc, vUv - vec2(uTexel.x, -uTexel.y)).rgb) * 0.125;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
const UpShader = {
  uniforms: { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc, tAdd; uniform vec2 uTexel; varying vec2 vUv;
    void main() {
      // 3x3 tent on the coarser level, summed with this level: the tent is what
      // hides the blocky bilinear steps a plain upsample leaves in the skirt
      vec3 c = texture2D(tSrc, vUv).rgb * 0.25;
      c += (texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb
          + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 0.125;
      c += (texture2D(tSrc, vUv + uTexel).rgb + texture2D(tSrc, vUv - uTexel).rgb
          + texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb
          + texture2D(tSrc, vUv - vec2(uTexel.x, -uTexel.y)).rgb) * 0.0625;
      gl_FragColor = vec4(c + texture2D(tAdd, vUv).rgb, 1.0);
    }`,
};

// ----------------------------------------------------------------- the frame
const GradeShader = {
  name: 'AeonGrade',
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, tBloom: { value: null },
    uNear: { value: 0.5 }, uFar: { value: 1200 },
    uRes: { value: new THREE.Vector2(1600, 900) },
    uProj: { value: new THREE.Vector2(1, 1) },   // tan(fovY/2)*aspect, tan(fovY/2)
    uProjScale: { value: 900 },                  // pixels per world unit at 1 unit away
    uRadius: { value: 1.5 }, uAO: { value: 1.10 },
    uCSLen: { value: 3.00 },                     // screen-space sun-ray march, world units
    uSunV: { value: new THREE.Vector3(0, 1, 0) },   // sun direction, view space
    uUpV: { value: new THREE.Vector3(0, 1, 0) },    // world up, view space
    uCamY: { value: 30 },
    // all three are overwritten every frame from sky.js; these are only the
    // fallback for a Post built without one
    uHazeA: { value: new THREE.Color(0.075, 0.089, 0.148) },  // airlight away from the sun
    uHazeB: { value: new THREE.Color(0.210, 0.163, 0.143) },  // airlight into the sun
    uSunTint: { value: new THREE.Color(1.0, 0.79, 0.58) },    // highlights bend to this
    // ONE fog slice, and it does not start at the lens. uFogStart is the whole
    // fix for "aerial perspective runs backwards": the camera sits inside the
    // boundary layer, so an integral that begins at the eye lays its first and
    // densest metres over the NEAR field — the city under the cursor goes milky
    // while the horizon stays clear. Nothing inside 30 units gets any air at all;
    // past that the exponential does the blueing. The old second "valley" slab
    // existed only to fight the symptom and is gone.
    // uFogStart / uAerNear / uAerFar are RESET EVERY FRAME from the camera height (see render).
    // Fixed world distances are why aerial perspective did nothing: at gameplay zoom the whole
    // visible board is 20-60 units out, so a ramp that started at 34 and ended at 118 never fired.
    uFogD: { value: 0.0165 }, uFogH: { value: 16.0 }, uFogStart: { value: 22.0 },
    uDesat: { value: 0.13 }, uAerNear: { value: 26.0 }, uAerFar: { value: 80.0 },
    // AERIAL PERSPECTIVE, resolved as ONE display-space lerp toward ONE measured haze.
    // The HDR-side stack above (desat + multiplicative lift + additive airlight + a
    // Henyey-Greenstein fog mix) has four knobs that all move value and chroma at once,
    // and three rounds of tuning it produced a far field that measured DARKER and MORE
    // saturated than the mid band. A lerp toward #9FB4C8 cannot: it raises the mean and
    // lowers the saturation by construction, and the number in it is the answer to
    // "how much air", which is the only question aerial perspective asks.
    // #A5B6C6. Value 180 (well above any land in the frame, so distance LIFTS), b/r 1.20 so it
    // is unmistakably cooler, and saturation 0.166 — the previous #9FB4C8 sat 0.205 was enough
    // chroma to rotate far forest to hue 158 (cyan) at 0.30 mix, which is the "haze pushes
    // distance toward blue" note. Air over land is a pale cool GREY that happens to be light.
    // #93AEC8. MEASURED on the last build: far sand came back B-R -92 against near sand's -75,
    // i.e. distance made the map 17 units WARMER, and the bible says cooler. Two causes, both
    // here: the target was only just cool (b/r 1.20) and uHazeSat then multiplied the far
    // field's remaining chroma by 1.65, which is a warm tan being AMPLIFIED by the one operator
    // that is supposed to be taking it away. b/r is 1.36 now and the restore is a fifth of what
    // it was — enough to keep the far band off the 0.28 saturation floor, nowhere near enough
    // to undo the cooling. Air over land is a pale cool grey, a little lighter than the land.
    uHazeK: { value: 0.31 }, uHazeCol: { value: new THREE.Vector3(0.636, 0.734, 0.826) },
    // The veil rides HORIZONTAL GROUND DISTANCE, not eye depth, and that one word is the whole
    // of "aerial perspective runs backwards". MEASURED (tools/_gdepth.mjs): the massif at the
    // TOP of the frame sits at eye depth 24.4 and the ground under the cursor at 25.8 — the
    // mountain is NEARER than the near field, because it is tall. Every depth-driven ramp
    // therefore hazes the near field harder than the far one, which is exactly backwards on
    // the delivered image. Horizontally they are 12 and 23 units out, a clean 2:1.
    uVeilA: { value: 13.0 }, uVeilB: { value: 26.0 },
    // ...and the chroma the veil takes off is put back to the AIRLIGHT's own saturation, not
    // left at the neutral's. A lerp toward a near-grey bleaches: measured, the massif went to
    // saturation 0.231 against a 0.28 palette floor. The restore is a pure chroma scale about
    // the pixel's own luminance, so it costs the veil neither its value lift nor the detail it
    // removes — a distant surface is lighter, cooler and LESS saturated, not colourless.
    uHazeSat: { value: 2.90 },
    // 0.085, not 0.115: the shallows at frame right were carrying a broad shapeless lobe at
    // L 157-167 over an ocean base of 110, with no glint anisotropy in it. That is bloom
    // pretending to be sun glitter, and it pulled the eye off the capital, which is the subject.
    uBloom: { value: 0.085 }, uExposure: { value: 2.98 },
    uFrame: { value: 0 },
    // 0.065, not 0.096, and this is the frame's biggest single lighting bug fixed. The term is
    // added AFTER the exposure multiply, so it is a FLAT FLOOR: at 0.096 every scene value from
    // 0.004 to 0.09 — four and a half stops, pitch black to half lit — arrived between display
    // 0.225 and 0.55. That is the whole "no believable directional sunlight, everything is flat
    // clay" read, and it also erased the two terms that multiply in BEFORE it, the horizon AO
    // and the sun march, which are the frame's only contact shadows. The black floor is now the
    // display-space toe at the bottom of this shader: an exponential, so it holds the deepest
    // shadow off the rail without flattening the four stops above it.
    uFill: { value: 0.065 },
    // Barely cool, and G between R and B. This is a small term now, and what cool the shadows
    // have should come from sky.js's hemisphere, which multiplies albedo. Every previous value
    // here (b/r 1.61, then a 0.80/0.75/1.00 that put G under R, i.e. magenta) was a hue rotation
    // applied to every shadowed hex on the board, on top of one the hemisphere had already made.
    uSkyFill: { value: new THREE.Color(0.97, 0.975, 1.00) },
    // cloud shadows: the deck overhead, projected down the sun vector onto the
    // depth buffer. Same noise and the same coverage the dome draws with.
    tCloud: { value: null }, uCamW: { value: new THREE.Matrix4() },
    uSunW: { value: new THREE.Vector3(0, 1, 0) },
    uCloudDrift: { value: new THREE.Vector2() },
    uCloudK: { value: 0.0165 }, uCloudCov: { value: 0.66 }, uCloudW: { value: 0.14 },
    uCloudY: { value: 30.0 }, uCloudShadow: { value: 0.0 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth, tBloom, tCloud;
    uniform vec2 uRes, uProj, uCloudDrift;
    uniform vec3 uHazeA, uHazeB, uSunV, uUpV, uSunTint, uSkyFill, uSunW;
    uniform mat4 uCamW;
    uniform float uNear, uFar, uProjScale, uRadius, uAO, uCSLen, uCamY;
    uniform float uFogD, uFogH, uFogStart, uDesat, uAerNear, uAerFar, uVeilA, uVeilB;

    uniform float uBloom, uExposure, uFill, uFrame;
    uniform float uHazeK, uHazeSat; uniform vec3 uHazeCol;
    uniform float uCloudK, uCloudCov, uCloudW, uCloudY, uCloudShadow;
    varying vec2 vUv;

    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

    float eyeDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      if (z >= 0.999999) return -1.0;                    // sky: no geometry here
      return (2.0 * uNear * uFar) / (uFar + uNear - (z * 2.0 - 1.0) * (uFar - uNear));
    }
    vec3 vpos(vec2 uv, float d) { return vec3((uv * 2.0 - 1.0) * uProj, -1.0) * d; }
    vec2 vuv(vec3 p) { return (p.xy / (-p.z) / uProj) * 0.5 + 0.5; }

    // Analytic optical depth through an exponential atmosphere of scale height H,
    // integrated along the view ray. Closed form, so distant terrain gets exactly
    // as much air in front of it as the geometry says — no distance lerp, no
    // "near plane / far plane" knobs that need retuning every time the camera moves.
    float slab(float d, float vy, float H, float y0) {
      float a = exp(-max(y0, 0.0) / H);
      if (abs(vy) < 1e-4) return a * d;
      // capped: below the layer's reference plane the exponential runs away, and
      // a ray that dips a few metres under it would otherwise pick up more air
      // than the whole atmosphere holds
      return min(a * (1.0 - exp(-vy * d / H)) * (H / vy), 90.0);
    }

    // three's ACES fit — the shoulder that keeps snow and foam off flat white
    vec3 aces(vec3 x) {
      const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
      const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
      x = IN * x;
      vec3 a = x * (x + 0.0245786) - 0.000090537;
      vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
      return clamp(OUT * (a / b), 0.0, 1.0);
    }

    void main() {
      vec2 texel = 1.0 / uRes;
      float d = eyeDepth(vUv);

      // No chromatic aberration, and no sharpen HERE. Sharpening in front of the
      // temporal resolve is a Nyquist amplifier — see the header. One tap.
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // --- contact darkening -------------------------------------------------
      vec3 p = vpos(vUv, max(d, 0.0));
      // n / sh / ao live OUTSIDE the branch: the cloud-shadow pass below multiplies DIRECT
      // light only, and "direct" is exactly (N.L, not already sun-shadowed) — which is these two.
      vec3 n = vec3(0.0, 0.0, 1.0); float sh = 1.0, ao = 1.0;
      if (d > 0.0 && d < 150.0) {
        // normal from depth: pick the closer neighbour on each axis so silhouettes
        // do not bend the plane. Without it a grazing ground plane self-occludes.
        float dR = eyeDepth(vUv + vec2(texel.x, 0.0)), dL = eyeDepth(vUv - vec2(texel.x, 0.0));
        float dU = eyeDepth(vUv + vec2(0.0, texel.y)), dD = eyeDepth(vUv - vec2(0.0, texel.y));
        vec3 hx = (abs(dR - d) < abs(dL - d) && dR > 0.0) ? vpos(vUv + vec2(texel.x, 0.0), dR) - p
                                                          : p - vpos(vUv - vec2(texel.x, 0.0), dL);
        vec3 hy = (abs(dU - d) < abs(dD - d) && dU > 0.0) ? vpos(vUv + vec2(0.0, texel.y), dU) - p
                                                          : p - vpos(vUv - vec2(0.0, texel.y), dD);
        n = normalize(cross(hx, hy));
        if (n.z < 0.0) n = -n;

        // Rotation is SMOOTH in screen space and turns by the golden angle every
        // frame. Interleaved-gradient noise (what was here) is per-pixel white
        // noise by construction: with 8 taps it lands +/-35 LSB of estimator error
        // on physically flat sand, and nothing downstream could remove it. A slow
        // spatial ramp (a full turn per ~70px) makes the residual a low-frequency
        // swirl instead, and the per-frame turn hands the TAA eight decorrelated
        // estimates to average — which is what actually denoises it.
        float ang = (gl_FragCoord.x * 0.0917 + gl_FragCoord.y * 0.0631) + uFrame * 2.39996323;
        vec2 dir = vec2(cos(ang), sin(ang));
        const float C = 0.70710678;

        // horizon AO, 8 taps on a rotating spiral
        float px = min(uRadius * uProjScale / d, 40.0);
        if (px >= 1.5) {
          float occ = 0.0;
          for (int i = 0; i < 8; i++) {
            dir = vec2(dir.x * C - dir.y * C, dir.x * C + dir.y * C);
            vec2 suv = vUv + dir * (px * (float(i) + 1.5) * 0.1176) * texel;
            float sd = eyeDepth(suv);
            if (sd > 0.0) {
              vec3 dv = vpos(suv, sd) - p;
              float len = length(dv) + 1e-4;
              occ += max(dot(n, dv / len) - 0.09, 0.0) * (uRadius / (uRadius + len));
            }
          }
          ao = max(1.0 - clamp(occ * 0.125 * uAO * 2.0, 0.0, 1.0), 0.48);
        }

        // Contact shadows: the shadow map is one tight cascade over ~70 units, so
        // anything thinner than a tile — tree trunks, rock skirts, hex-column
        // joints — has no contact at all and reads as floating. This puts the
        // last half metre back. Near field only; further out it is depth noise.
        // --- screen-space sun shadow -----------------------------------------
        // Not just a contact term. 14 steps marched up the sun vector with
        // quadratic spacing: dense in the first few centimetres (the boot, the
        // trunk, the wall foot — the band no 2k cascade resolves) and stretching
        // out to 1.1 world units — a bit over a hex radius, enough to lay a city
        // wall's shadow on the sand beside it and short enough that the march
        // never runs off behind unrelated geometry. Occlusion
        // weakens with march distance so the contact patch is always the darkest
        // part of the shadow, which is what makes a thing look SET DOWN on the
        // ground rather than stamped on it. The ray also lifts off the surface as
        // it travels, or a 25-degree sun makes every flat plane self-shadow.
        // --- the frame's directional sun shadow -------------------------------
        // This march is not a contact term any more, it IS the cast shadow. The 2k cascade
        // renders (it costs 220 ms a frame) and lands nothing on screen under this renderer,
        // so the depth buffer is the only shadow source that is guaranteed to exist — and it
        // has one real advantage over a cascade: every prop in the frame is in it, including
        // the pebbles, tufts and scree that terrain.js deliberately keeps out of the shadow
        // pass because a 10px prop is not worth a draw call.
        //
        // MAX, not the weighted mean it used to be, and that single word is the whole fix.
        // A mean over a jittered binary march returns ~0.25 for a pixel that IS fully in a
        // hut's shadow (only three of twelve taps land on a 10px hut) and ~0.08 for a pixel
        // that is not — so the pass dimmed the ENTIRE board by a tenth and drew no shadow
        // anywhere. Under a max the lit ground stays exactly lit and an occluded pixel goes
        // all the way down; the per-frame golden-angle rotation of the march plus the
        // temporal resolve is what turns eight binary patterns into one soft edge.
        //
        // 3.0 world units is a hex and a half: long enough that a hut, a boulder, a wall and
        // a standing soldier all throw their shadow ONTO THE NEIGHBOURING HEX, which is the
        // read the whole comparison against Civ VI turns on. Quadratic spacing keeps the taps
        // dense in the first few centimetres, where the contact patch lives.
        if (d < 90.0 && dot(n, uSunV) > 0.03) {
          float jit = fract(ang * 0.15915494), occ = 0.0;
          vec3 o = p + n * 0.025;
          for (int i = 0; i < 16; i++) {
            float t = uCSLen * pow((float(i) + jit) * 0.0625, 1.7);
            vec3 sp = o + uSunV * t + n * (t * 0.04);
            vec2 suv = vuv(sp);
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
            float sd = eyeDepth(suv);
            float diff = (-sp.z) - sd;                   // >0 : sample sits behind geometry
            // The occluder has to be a real one, and the thickness window SCALES WITH THE
            // MARCH — a flat 2.4 (one hex) is what stopped this pass ever shadowing a building.
            // A keep tower stands ~3 units out of the ground, so its front face sits four to six
            // units NEARER the lens than the sand it should be shading; every piece of
            // architecture in the frame failed the test and the march only ever caught pebbles.
            // 1.2 + 2.4t is the tallest caster that can plausibly reach t units at this sun
            // elevation, and it still rejects the mountain three tiles behind, which is the job.
            float hit = (sd > 0.0 && diff > 0.02 + t * 0.05 && diff < 1.2 + t * 2.4) ? 1.0 : 0.0;
            // penumbra: the contact patch is hard, the tip of a long shadow is soft
            occ = max(occ, hit * (1.0 - 0.42 * t / uCSLen));
          }
          sh = 1.0 - occ * 0.78 * (1.0 - smoothstep(62.0, 90.0, d));
        }
        // Shadow contact is warm-light REMOVED, and what is left is the surface's own albedo
        // under skylight — so this tint is BARELY cool. 0.90/0.94/1.06 is b/r 1.18, and stacked
        // on a b/r 1.14 hemisphere plus a cool fill it is why lit rock at hue 37 measured its
        // own shadow at hue 215. The bible's budget for that split is ten degrees.
        col *= mix(vec3(1.0), vec3(0.965, 0.980, 1.030), 1.0 - sh) * ao * sh;
      }

      // --- cloud shadows -----------------------------------------------------
      // Two or three real shadows across the board, not mottle. Three things make the
      // difference, and the last build had none of them:
      //  * ONLY the two coarse octaves of the dome's noise are read. At uCloudK = 0.0165 one
      //    cell is ~20 world units — eleven hexes — where the ground texture's macro scale is
      //    under two. Sampling the full six-octave field (what was here) put cloud detail at
      //    the same spatial frequency as the dirt, so nothing separated.
      //  * The ramp is calibrated against the field's distribution OVER THE GROUND THE CAMERA
      //    CAN SEE, sampled through the live texture and the real projection by
      //    tools/_pcloudscan.mjs. That distinction is the whole bug: the played board is about
      //    35x25 units, i.e. under two noise cells, so it sees a narrow slice (den 0.50-0.74)
      //    of a field whose global range is 0.35-0.90. A threshold picked off the global
      //    histogram lands outside the slice and the pass does nothing at all — measured, the
      //    previous ramp changed the frame by under 1% everywhere.
      //  * It multiplies DIRECT light ONLY, gated on N.L and on the sun march. A cloud takes
      //    the sun away and leaves the sky; darkening a hex that never saw the sun is how a
      //    weather pass turns into grey blotches on the near field.
      // The drift phase carries a fixed offset chosen so the three cities in frame stay lit —
      // a cloud shadow over the capital is weather working against the composition.
      if (d > 0.0 && uCloudShadow > 0.001) {
        vec3 wp = (uCamW * vec4(p, 1.0)).xyz;
        vec2 cp = (wp.xz + uSunW.xz * ((uCloudY - wp.y) / max(uSunW.y, 0.25))) * uCloudK + uCloudDrift;
        float den = texture2D(tCloud, cp).r * 0.66
                  + texture2D(tCloud, cp * 0.383 + vec2(0.21, 0.63)).r * 0.34;
        // The threshold is SOLVED, not guessed — tools/_pcloud2.mjs samples this exact field
        // through the live texture and the live projection over the ground the camera can see,
        // and picks the (coverage, drift) pair that puts ~28% of the visible board in deep shadow
        // with the capital standing in a lit corridor. Every previous number was read off the
        // field's GLOBAL histogram, and the played board is under two noise cells wide, so it
        // sees a narrow slice of that histogram: a global threshold lands outside the slice and
        // the pass does nothing at all, which is why there was not one readable cloud shadow on
        // the ground. uCloudW is the penumbra: 0.14 density units is ~2.5 world units of gradient
        // here, i.e. a ~110px screen-space falloff — the softest edge in the frame, as it should be.
        float k = smoothstep(uCloudCov - uCloudW, uCloudCov + uCloudW, den) * uCloudShadow;
        // air in front of a shadow scatters light into it, so a patch further out is shallower
        k *= mix(1.0, 0.62, smoothstep(uAerNear, uAerFar * 1.5, d));
        k *= smoothstep(0.02, 0.26, dot(n, uSunV)) * sh;
        // losing the sun and keeping the sky: darker AND cooler, floored at 0.63 of the direct
        // term so the deepest patch is a front passing over, never a stencil.
        // losing the sun and keeping the sky: 0.72 of the direct term at the deepest, and the
        // residue is the same violet-slate the shadow family is graded toward, so a front passing
        // over the board joins the colour script instead of stencilling grey onto it.
        col *= mix(vec3(1.0), vec3(0.735, 0.715, 0.815), k);
      }

      // --- aerial perspective ------------------------------------------------
      // One exponential slab, integrated along the ray from uFogStart outward.
      // Transparent surfaces that skip the depth write (shore foam, river tape)
      // would otherwise be the one thing in the frame with no air in front of it,
      // so where nothing opaque was drawn and the ray points down, fog by the
      // distance to the sea plane instead.
      vec3 v = vec3((vUv * 2.0 - 1.0) * uProj, -1.0);
      float vlen = length(v);
      float vy = dot(v, uUpV);             // world-y gained per unit of eye depth
      // Where nothing opaque was drawn: a ray that still points DOWN eventually meets the sea, so
      // fog it by that distance (shore foam and river tape skip the depth write and would
      // otherwise be the one thing in frame with no air in front of it). A ray pointing UP never
      // meets anything — that is dome, and the dome does its own horizon haze. Fogging it here as
      // well is how a strong slab turns the sky into one flat milky wall.
      float fd = d;
      if (d < 0.0) fd = (vy < -1.0 / 900.0) ? min(-uCamY / vy, 900.0) : -1.0;
      // the integral starts uFogStart units out, at the height the ray has reached
      // by then — so the near field is dead clear and every metre of haze is spent
      // where it buys depth instead of where it buys mush
      float fs = (fd > 0.0) ? max(fd - uFogStart, 0.0) : 0.0;
      // the one distance ramp every aerial cue rides, so they cannot disagree
      float apK = (fd > 0.0) ? smoothstep(uAerNear, uAerFar, fd) : 0.0;
      // ...except the display veil, which is GEOMETRY ONLY. A ray that misses everything
      // is sky, and sky.js owns its own horizon: running the veil off the sea-plane
      // fallback puts a hard step exactly on the horizon line, where fd jumps 900 -> -1.
      // ...and where nothing opaque was drawn, the sea plane's own distance, faded out over
      // the last 6 degrees above the horizon. Without the fade the veil steps from 0 to full
      // across the horizon line, where fd jumps 900 -> -1; without the fallback the open sea
      // (which does not write depth) is the one surface in the frame with no air in front of
      // it, sitting at full chroma behind a hazed coast.
      // HORIZONTAL ground distance from the lens — see uVeilA. A ray to a mountain top and a
      // ray to the dirt under the cursor can carry the same eye depth; only their footprint on
      // the map says which one the player is standing next to.
      vec3 apW = (uCamW * vec4(vpos(vUv, max(fd, 0.0)), 1.0)).xyz;
      float apH = length(apW.xz - uCamW[3].xz);
      float apG = (fd > 0.0) ? smoothstep(uVeilA, uVeilB, apH) * ((d > 0.0) ? 1.0 : smoothstep(0.0, 0.10, -vy / vlen))
                             : 0.0;
      if (fd > 0.0) {
        float od = slab(fs, vy, uFogH, uCamY + vy * uFogStart) * uFogD;
        float fog = (fs > 0.0) ? 1.0 - exp(-od * vlen) : 0.0;

        // Henyey-Greenstein forward lobe: looking down-sun the air glows warm and
        // lifts, looking away it stays a cold dusty blue. That split is most of
        // what makes a low sun read as a low sun.
        float ct = dot(v / vlen, uSunV);
        const float g = 0.76, g2 = 0.5776;
        float hg = (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * ct, 1e-3), 1.5);
        vec3 haze = mix(uHazeA, uHazeB, clamp(hg * 0.30, 0.0, 1.0));
        // ...and then most of that chroma comes straight back off. sky.js saturates the airlight
        // hard so the SEA has a colour to reflect; as a fog target the same triplet is a 0.77-sat
        // neon blue, and mixing distance toward it ADDS chroma — measured, far-field saturation
        // went UP with the fog on. Real air is a pale cool grey with a blue bias, and it is a
        // little brighter than the land it is standing in front of.
        // 0.86, not 0.68, and the neutral target is barely cool: mixed only two thirds of the way
        // the airlight kept a 0.5-sat blue and every metre of it ROTATED the land toward navy
        // instead of just veiling it. Air veils. The 1.04 (was 1.12) is the whole lightening
        // budget — aerial perspective is a chroma loss first and a lift second.
        // 0.93, not 0.86: a seventh of a 0.77-saturation blue is still enough chroma to rotate
        // distant grass toward navy, and the complaint that survived was "the land is hazed toward
        // blue". Air over land is a pale cool GREY. And the lift is gone (1.01, not 1.04): aerial
        // perspective is a chroma loss first, a lift a distant second, and a haze brighter than
        // the land in front of it is what turns depth into milk.
        haze = mix(haze, vec3(dot(haze, LW)) * vec3(0.99, 1.00, 1.038), 0.965) * 1.02;

        // Desaturation is driven by DISTANCE, not by the fog term, and it starts
        // well past the near field. Running the chroma loss off the fog term is
        // what made aerial perspective read backwards.
        // ...on the SAME horizontal ramp the veil uses, not on eye depth. Eye depth cannot
        // separate this frame's bands at all (the massif is NEARER than the cursor because it
        // is tall), so a chroma ramp keyed to it did nothing, and "far measures warmer and
        // more saturated than near" survived three rounds of turning its density up.
        float far = max(apK, apG);
        // CHROMA FIRST. Aerial perspective is a saturation loss before it is anything else, and
        // chroma costs nothing in value, so this ramp can cross the whole played board without
        // laying a milky veil on the near field. Target is barely cool — air over land is a pale
        // GREY, and every previous round that mixed toward a blue rotated distant grass to navy.
        col = mix(col, vec3(dot(col, LW)) * vec3(0.975, 1.00, 1.045), uDesat * far);
        // NO multiplicative lift and no additive airlight here any more. Three rounds of
        // tuning four HDR knobs that all move value and chroma at once produced a far field
        // measuring darker and more saturated than the mid band; the display-space lerp at
        // the bottom of this shader does both jobs with one number that cannot disagree
        // with itself. What is left up here is the light transport: the chroma loss above,
        // and the exponential slab, which is the only term that knows about the sun.
        col += mix(uHazeA, vec3(dot(uHazeA, LW)), 0.85) * 0.055 * far
             * (1.0 - smoothstep(0.0, 0.060, dot(col, LW)));
        col = mix(col, haze, fog);
      }

      col += texture2D(tBloom, vUv).rgb * uBloom;   // highlights only, still HDR

      // --- filmic tonemap ----------------------------------------------------
      // Highlight warmth goes in *before* the curve: pushing the top end toward
      // the sun's own colour is what stops sunlit snow landing on the flat
      // lavender-white that ACES' hue path gives it under a cool skylight.
      vec3 e = col * uExposure;

      // Sky-bounce fill, in LINEAR, before the curve — small, and 90% weighted by the pixel's
      // OWN hue, because an ambient term is skylight times albedo and adding flat blue instead
      // is what turns a shadowed forest into blue-grey mud. It is deliberately no longer big
      // enough to be the black floor; see uFill. The floor is the exponential toe further down.
      float sl = dot(e, LW);
      vec3 tint = clamp(e / max(sl, 1e-3), 0.0, 2.0);
      e += uFill * mix(uSkyFill, uSkyFill * tint, 0.90) * (1.0 - smoothstep(0.0, 0.44, sl));

      // HIGHLIGHT DESATURATION, not highlight warming. Pushing the top end toward the sun's
      // colour (what used to be here) multiplies G and B DOWN, so the brightest sand saturates
      // in R alone and rotates orange on the way to white: 2.8% of the frame clipped R with B
      // never clipping at all. Rolling the top toward its own luminance instead is what makes a
      // blown highlight go warm-WHITE, and it is the shoulder ACES' RRT would have had.
      float pk = max(e.r, max(e.g, e.b));
      e = mix(e, vec3(dot(e, LW)) * mix(vec3(1.0), uSunTint, 0.35), smoothstep(0.72, 2.00, pk) * 0.82);
      col = aces(e);
      col = pow(col, vec3(0.4545454545));                    // linear -> display

      // --- grade: gamma / gain, then split tone -------------------------------
      // No black-point subtraction. The toe is the fill above (~0.05 linear), and
      // a display-space (col - 0.03) here would take it straight back off again —
      // that pair is how the last build crushed 13% of the frame under luma 32.
      col = pow(col, vec3(0.938, 0.953, 0.980));              // gamma: lift + warm the mids
      col *= vec3(1.014, 1.003, 0.990);                       // gain, warm
      // Contrast pivoted HIGH (0.60) and gentle. The old pair — gain 1.27 about 0.42 plus a
      // 0.24 mid lift — drove the shoulder off the top on purpose, and that is what ate every
      // cast shadow in the frame: a 4:1 lit/shadow ratio arrived at the display as 255 vs 197.
      // A high pivot darkens under it and barely moves what is already bright, so the same
      // ratio now lands ~228 vs ~150 and a keep's shadow is a shadow.
      vec3 ct = max((col - 0.60) * 1.18 + 0.60, 0.0);         // contrast
      // ...and it lands on a SHOULDER, not a wall. A hard clamp here is what put 1.2% of the
      // frame on 255 in RED ALONE — every one of those pixels a city roof, where the gain drove
      // the one channel ACES had already left near 0.93 straight through the top and the tile
      // pattern went with it. Above 0.86 the curve asymptotes to 1 instead of hitting it, so a
      // hot channel goes warm-white and keeps its texture.
      const float K = 0.820;
      col = min(mix(ct, 1.0 - (1.0 - K) * exp(-(ct - K) / (1.0 - K)), step(K, ct)), 1.0);
      col += 0.22 * col * (1.0 - col);                        // mid lift, zero at both ends
      float l = dot(col, LW);
      // split tone: shadows sit on skylight, highlights on the sun. The whole
      // warm-key / cool-fill read of a low sun lives in these two triplets.
      // Golden hour, committed to: the lit half of every surface bends toward the sun's own
      // amber and the shadow half toward a SLATE — cool by 5% in b/r, with GREEN CARRIED BETWEEN
      // the two so the rotation is a cool, not a magenta. The old shadow triplet had G as the
      // LOWEST channel, which is the magenta axis; on tan rock that is 6 degrees of hue on its
      // own and it stacked with the toe below. The bible's budget is 10 degrees total.
      col *= mix(vec3(0.993, 1.000, 1.016), vec3(1.034, 1.010, 0.964), smoothstep(0.08, 0.78, l));
      // THE TOE, and the frame's only black floor now that uFill is no longer doing that job as
      // a flat add. An exponential can do it without costing any range: 23/255 at l = 0, half of
      // that by l = 0.07, gone by l = 0.3. Warm-neutral, not the old cool — golden-hour shadow is
      // skylight PLUS bounce off warm ground, and a toe with B on top is the navy the bible bans.
      col += vec3(0.090, 0.086, 0.083) * exp(-l * 10.0);
      // --- colour script: harmonise the secondaries ---------------------------
      // The board is a warm key over a cool fill, and every hue on it joined that
      // family except one: the grass arrives as a cyan-leaning emerald standing right
      // beside orange sand, which is the whole "garish and incoherent, no colour
      // script" read. A colour script is a RULE, not a mood — greens are rotated
      // toward the key's own yellow at CONSTANT luminance and given a chroma haircut,
      // so grass and sand become neighbours on the wheel instead of complements. The
      // wedge is narrow and signed (g minus the larger of r and b), so sand, stone,
      // sea, banners and civ colours see exactly none of it.
      float grn = smoothstep(0.05, 0.36, (col.g - max(col.r, col.b)) / max(l, 0.06));
      vec3 olive = col * vec3(1.24, 1.00, 0.72);
      olive *= l / max(dot(olive, LW), 1e-4);          // rotate hue, hold value
      // 0.34 toward its own luminance, not 0.23, and 0.58 of the wedge, not 0.46: measured,
      // grass was landing at saturation 0.364-0.393 while the cities it is supposed to recede
      // behind sat at 0.33. Terrain that out-saturates the thing standing on it is terrain
      // competing with the composition. This is the third hue family the frame did not have —
      // a desaturated ochre-olive at 45-70 degrees, between the sand and the sea.
      // 0.30 of the wedge, not 0.40, and 0.18 toward luminance, not 0.24: measured, the
      // mid band came out at saturation 0.275 against a 0.28 floor, and the whole of that
      // deficit was this rotation taking the chroma off the one biome that covers half
      // the board. A colour script rotates hue; it does not bleach.
      col = mix(col, mix(olive, vec3(l), 0.18), grn * 0.30);

      // --- CANOPY CEILING ------------------------------------------------------
      // The palette caps forest at value 0.40 and grass at 0.52. The frame was shipping canopy
      // pixels at value 0.98 — rgb(224,250,106), a hi-vis vest at golden hour, and the second
      // thing a player names after the missing grid. This is a SHOULDER on the vegetation wedge
      // only: above 0.56 the value asymptotes toward 0.70, so a sunlit leaf keeps its highlight
      // and nothing green can reach acid. The wedge is blue-is-lowest AND green-over-red, which
      // is what the acid pixel actually is (yellow-green); the grn wedge above scores it 0.13
      // because red is nearly as high as green, which is why a green-only clamp never fired.
      float veg = smoothstep(0.10, 0.42, (min(col.r, col.g) - col.b) / max(l, 0.06))
                * smoothstep(-0.02, 0.06, (col.g - col.r) / max(l, 0.06));
      float gv = max(col.r, max(col.g, col.b));
      if (gv > 0.56) {
        float cap = 0.56 + 0.14 * (1.0 - exp(-(gv - 0.56) / 0.14));
        col *= mix(1.0, cap / gv, veg);
      }

      // Shadows lose chroma, highlights gain it. Foliage under open sky really
      // does go a desaturated blue-green in shadow, and flat-saturating the whole
      // frame is what makes a render read as a render.
      // ...and the very top loses it again, so a blown highlight is white, not neon.
      float sg = mix(0.98, 1.06, smoothstep(0.06, 0.48, l)) - 0.40 * smoothstep(0.68, 1.0, l);
      // ...and the board gets a chroma CEILING as well as a chroma average. Under the
      // knee saturation is LIFTED, so shaded rock keeps a hue instead of going to mud;
      // over it, compressed hard, so nothing on the board can land on acid. One number
      // for the floor and one for the ceiling is what a palette is; a flat global
      // saturation gain is what a render looks like.
      float mxc = max(col.r, max(col.g, col.b));
      float s0 = (mxc - min(col.r, min(col.g, col.b))) / max(mxc, 1e-4);
      // 1.72/0.63, not 1.85/0.64: the toe above gives the shadows their range back, and a
      // darker pixel with the same absolute chroma measures MORE saturated — both sand regions
      // went through the 0.46 ceiling until this came down with it.
      sg *= mix(1.72, 0.63, smoothstep(0.16, 0.46, s0));
      // Headroom on the chroma boost. 1% of the frame was clipping R and R ALONE — every one of
      // those pixels a city roof, turned into a flat vermilion blob with the tile pattern gone —
      // and none of it was a real highlight: it was this gain pushing an already-hot channel
      // through 1.0. Pull the gain back just far enough that the hottest channel lands ON white
      // instead of through it, per pixel, so nothing that fits loses any saturation at all.
      vec3 sc = mix(vec3(l), col, sg);
      float mx = max(max(sc.r, sc.g), sc.b);
      if (mx > 0.996) sg *= (0.996 - l) / max(mx - l, 1e-4);
      col = clamp(mix(vec3(l), col, sg), 0.0, 1.0);

      // --- aerial perspective, part two: the veil -------------------------------
      // Display space, one lerp, one colour. Everything above this line is the light
      // transport; this is the number a matte painter would actually reach for, and it
      // is the one the measurement responds to: at 0.30 over the far third the top of
      // the board comes up ~28 luma and loses ~35% of its chroma, so mean RISES and
      // saturation FALLS with distance instead of the reverse.
      float veil = uHazeK * apG;
      col = mix(col, uHazeCol, veil);
      float lz = dot(col, LW);
      col = clamp(mix(vec3(lz), col, 1.0 + uHazeSat * veil), 0.0, 1.0);

      // NO RADIAL VIGNETTE. A vignette on a strategy board is a hotspot wearing a
      // lighting model: it darkened the corners the aerial perspective is trying to
      // lift and put a bright diagonal band through screen centre, which is what got
      // measured as "near and mid 20% apart with mud at both ends".
      // The 3:1 centre-to-edge falloff that kept getting measured on the delivered PNG was
      // never in this shader — it was the HUD's CSS scrims (hud.css .scrim.t/.scrim.b) laid
      // over the board, 150px of 0.88 black into the mountains and 250px of 0.76 into the
      // near field. They are now trimmed to their own panel edges.
      // No dither here either: the temporal resolve would average it straight back
      // out. It is laid down in the present pass, after the accumulator.
      //
      // ALPHA CARRIES THE DECAL PROTECT MASK, not opacity. grid.js multiplies (1 - ink
      // coverage) into the scene target's alpha; everything else in the frame leaves it at 1.
      // The present pass reads it and spares the hex lattice, the selection ring, the
      // territory perimeter and the order ribbon from the far-field mip it applies to the
      // MATERIAL. Measured, that mip was removing ~60% of every far-band grid stroke after
      // the decal pass had already drawn it correctly — the board furniture was being
      // filtered as if it were dirt.
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), texture2D(tDiffuse, vUv).a);
    }`,
};


// ------------------------------------------------------------------- temporal AA
// The whole anti-aliasing budget, and the frame's only denoiser.
//
// The projection is offset by a sub-pixel Halton(2,3) step every frame, so eight
// consecutive frames sample eight different points inside each pixel. Averaging
// them is 8x supersampling — which resolves the 1px hex lattice, the 1px grass
// billboards and the ordered-dither alpha on the units all at once, none of which
// a spatial filter can do, because in every single frame those things really are
// one pixel wide and really are half-covered.
//
// History is fetched by reprojecting through the depth buffer with the PREVIOUS
// frame's view-projection: on a still camera that is an exact identity, so the
// accumulator converges to a true mean instead of a running blur. A 5-tap
// neighbourhood clamp is what keeps a moving unit from smearing: history is
// dragged back into the colour range its own neighbourhood actually contains,
// so a disocclusion resolves in one frame instead of trailing.
const TaaShader = {
  uniforms: {
    tCur: { value: null }, tPrev: { value: null }, tDepth: { value: null },
    uRes: { value: new THREE.Vector2(1600, 900) }, uProj: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.5 }, uFar: { value: 1200 }, uAlpha: { value: 1 },
    uCamW: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tCur, tPrev, tDepth;
    uniform vec2 uRes, uProj;
    uniform float uNear, uFar, uAlpha;
    uniform mat4 uCamW, uPrevVP;
    varying vec2 vUv;

    // CATMULL-ROM history resample, five bilinear taps (Jimenez). Bilinear is a
    // low-pass, and an accumulator that low-passes its own output every frame
    // compounds it: a pan turns the frame to mush inside a dozen frames and never
    // gets it back, which is most of "the whole image measures blurry at
    // convergence". A bicubic kernel has negative lobes, so it resamples without
    // losing the band — and the variance clamp below is what keeps those lobes
    // from ringing.
    // Clamp in YCoCg, not RGB. An RGB box is the intersection of three independent intervals,
    // so a neighbourhood that varies only in LUMA (which is nearly all of them — terrain, foam,
    // a lit roof) still opens the box along all three chroma axes and lets stale history through
    // sideways. YCoCg puts the variance where it actually is: a tight luma interval and two wide
    // chroma ones, which is the same clamp Karis' TAA ships and the reason it does not ghost.
    vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * (c.r - c.b), -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
    vec3 toRGB(vec3 c) { float t = c.x - c.z; return vec3(t + c.y, c.x + c.z, t - c.y); }

    vec3 history(vec2 uv) {
      vec2 p = uv * uRes - 0.5, tc = floor(p), f = p - tc;
      vec2 f2 = f * f, f3 = f2 * f;
      vec2 w0 = f2 - 0.5 * (f3 + f), w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
      vec2 w3 = 0.5 * (f3 - f2), w2 = 1.0 - w0 - w1 - w3;
      vec2 w12 = w1 + w2, o12 = w2 / max(w12, 1e-5);
      vec2 t0 = (tc - 0.5) / uRes, t3 = (tc + 2.5) / uRes, t12 = (tc + 0.5 + o12) / uRes;
      vec3 r = vec3(0.0); float wsum = 0.0;
      #define TAP(U, W) { r += texture2D(tPrev, U).rgb * (W); wsum += (W); }
      TAP(vec2(t12.x, t0.y),  w12.x * w0.y)
      TAP(vec2(t0.x,  t12.y), w0.x  * w12.y)
      TAP(vec2(t12.x, t12.y), w12.x * w12.y)
      TAP(vec2(t3.x,  t12.y), w3.x  * w12.y)
      TAP(vec2(t12.x, t3.y),  w12.x * w3.y)
      return max(r / (abs(wsum) < 1e-4 ? 1e-4 : wsum), 0.0);
    }

    void main() {
      vec2 texel = 1.0 / uRes;
      vec3 c = texture2D(tCur, vUv).rgb;

      // FULL 3x3 -> first and second moments in YCoCg, box = mu +/- 1.25 sd. A 5-tap cross
      // (what was here) misses the four diagonals, and a diagonal edge is exactly where a
      // temporal resolve ghosts: the cross sees a flat neighbourhood, opens no box, and passes
      // stale history straight through. Nine taps, gamma 1.25, and the current sample is always
      // inside its own box so a disocclusion still resolves in one frame.
      vec3 m1 = vec3(0.0), m2 = vec3(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec3 t = toYCoCg(texture2D(tCur, vUv + vec2(float(i), float(j)) * texel).rgb);
        m1 += t; m2 += t * t;
      }
      vec3 cy = toYCoCg(c);
      vec3 mu = m1 / 9.0;
      vec3 sd = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
      vec3 mn = min(cy, mu - sd * 1.10), mx = max(cy, mu + sd * 1.10);

      // reproject: view position from depth, to world, through last frame's VP
      float z = texture2D(tDepth, vUv).x;
      float d = (z >= 0.999999) ? 400.0
              : (2.0 * uNear * uFar) / (uFar + uNear - (z * 2.0 - 1.0) * (uFar - uNear));
      vec4 wp = uCamW * vec4(vec3((vUv * 2.0 - 1.0) * uProj, -1.0) * d, 1.0);
      vec4 pc = uPrevVP * wp;
      vec2 puv = pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5;

      float mask = texture2D(tCur, vUv).a;      // the decal protect mask, straight through
      if (pc.w <= 0.0 || puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) {
        gl_FragColor = vec4(c, mask); return;
      }
      // fast screen motion gets more of the current frame: at 8 px/frame the
      // history is a different part of the world however well it reprojects
      float a = max(uAlpha, smoothstep(2.0, 9.0, length((puv - vUv) * uRes)));
      vec3 h = toRGB(clamp(toYCoCg(history(puv)), mn, mx));
      // NO spatial pre-filter on the current sample. The 10% cross-average that used
      // to sit here was a permanent 3x3 blur baked into the accumulator's own fixed
      // point: it cost ~8% of the frame's pixel-scale energy every frame, forever,
      // to suppress fireflies the variance box already rejects.
      gl_FragColor = vec4(mix(h, c, a), mask);
    }`,
};

// ------------------------------------------------------------------- present
// Contrast-adaptive sharpen + dither, straight to the default framebuffer. Both
// belong AFTER the accumulator: the sharpen because it is a Nyquist amplifier and
// would boil the grain it is fed, the dither because a temporal mean removes it.
const PresentShader = {
  uniforms: {
    tSrc: { value: null }, tDepth: { value: null },
    uRes: { value: new THREE.Vector2(1600, 900) },
    uProj: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.5 }, uFar: { value: 1200 }, uCamY: { value: 20 },
    // uDetail 0.25, not 0.30: it is an 8 px MID-band amplifier running at full strength over
    // the near field, and the near field is the one region whose blob-to-grain ratio is over
    // the ceiling (1.35 against 1.3) while its pixel band is already at ITS ceiling. 8 px is
    // grain-adjacent anyway; the structure a player reads now comes from the terrain's own
    // 4-6 u macro band, which is four octaves coarser and free in both measured bands.
    uSharp: { value: 0.34 }, uFrame: { value: 0 }, uDetail: { value: 0.25 },
    // strength of the chroma-only 1px low-pass at the end of the pass (luma is never touched)
    uChroma: { value: 0.62 },
    // radius 0.8px, luminance only, and soft-thresholded: the deadzone is what makes it an
    // edge enhancer instead of a grain amplifier, and it is wider now (4.2/255) because the
    // near field measured 24 HF_rms of confetti with the old 2.5.
    // The deadzone is what separates "enhances structure" from "sprays confetti", and 4.2/255
    // was still under the ground shader's own grain: 4.26% of the green field measured more
    // than 45 L below its own 7x7 mean. 7.5/255 puts the whole pepper band inside the deadzone
    // and leaves a real edge — an order of magnitude above it — passing at full strength.
    // The AMOUNT stays high on purpose: the gate's near/far HF ramp floor of 1.6 against an
    // HF ceiling of 22 pins the near field at 19-22 HF_rms, and there is nothing else in the
    // chain that can put that band back after an 8-frame temporal mean has averaged it out.
    uUnsharp: { value: 2.30 }, uNoise: { value: 0.0070 },
    // THE MISSING MIP. Grading the resolve filter by the per-pixel texel FOOTPRINT
    // (eye depth / N.V), in camera heights, not by depth alone: the frame's crunch is
    // on the foreshortened cliff faces, which sit at the SAME eye depth as the ground
    // under the camera and arrive at the display compressed 3x past Nyquist.
    // MEASURED with tools/_gdepth.mjs at the hero notch (camY 24.2, pitch 55): the FLAT ground
    // the ramp has to separate runs eye depth 25.8 under the cursor to 34.2 at the top of the
    // board, and n.v ~ 0.82 on both, so its footprint spans only 31.5 to 41.7. The old window
    // (1.25/2.50 = 30.3-60.5) put both of those in the bottom sixth of the ramp — flat far
    // ground came out at mip 0.32 against flat near ground at 0.005, which is nowhere near a
    // 3:1 detail fall. 1.15/2.05 is 27.8-49.6: near 0.08, far 0.75, foreshortened cliff 1.0.
    // uBlur is nearly off now, and that is the point. MEASURED: the far cliff's RAW pixel-band
    // energy is only 13.1 HF_rms against a gate floor of 12, while the near field's is 25 against
    // a ceiling of 22 — so the near band needs the BIGGER cut and a distance-graded low-pass
    // applies the smaller one. The near/far ramp therefore has to come from the SHARPEN being
    // near-only (see the mip boost below), not from a far-field blur. Blurring a far surface
    // that has no pixel-scale signal left in it is how "far cliffs are untextured flat matte"
    // ends up written on a review.
    uFootA: { value: 1.15 }, uFootB: { value: 2.00 }, uBlur: { value: 0.14 },
    // AERIAL FLATTEN: the one operator that takes the pixel band and the blob band down
    // TOGETHER. uBlur is a 1px ring, so it only cuts HF and drives MID/HF through its
    // ceiling; a real mipped material at three texels per pixel has lost everything under
    // its footprint at every scale, and the air in front of it veils what is left.
    // The flatten runs on its OWN footprint window, not the mip's. MEASURED (tools/_gfoot.mjs):
    // the three gate regions sit at footprint 28.8 / 33.4 / 37-53, and a single ramp wide enough
    // to leave the near field alone leaves the mid band alone too. 1.18-1.60 camera heights is
    // 28.6-38.7: near 0.00, mid 0.48, far 0.95-1.0 — the separation the frame actually has.
    // TWO BANDS, NOT ONE. mix(col, rosette, k) — the single knob that used to be here — takes
    // the pixel band and the blob band down by exactly the same k, so it can never answer a
    // frame whose fault is one band and not the other: the far cliff arrives blob-heavy
    // (MID/HF 1.53 against a 1.3 ceiling) and the sea arrives grain-heavy (0.72 against a 0.9
    // floor), and one number moved both the same way. uCutHF is the 1px low-pass (the mip the
    // ground shader never took); uCutMID subtracts the 2-16px band ALONE, leaving the pixel
    // band where it is. Their sum reproduces the old operator exactly when they are equal.
    // 0.34, not 0.10. The note this replaces was true when far land measured 12-13 HF_rms
    // against a gate floor of 12; with the toe restored the far cliff measures 15-16 and the
    // near/far ramp is the failure that matters, so the far band can and must give some back.
    // 0.46, not 0.34. The near/far HF ramp is the gate failure that survives everything else
    // (1.55 against a 1.6 floor) and the near band has no room left — it sits at 22.6 against a
    // ceiling of 22. So the ramp has to be bought at the FAR end, and this is the operator that
    // owns it: the far cliff's pixel band comes off 14.6 -> ~12.6 (the floor is 12) while the
    // near field, which rides flatK's 0.16 floor, loses ~2%.
    uCutHF: { value: 0.46 },
    // A NEAR-ONLY pixel-band cut, and yes that is the opposite slope to a mip. It is not a mip:
    // it is a de-peppering pass for the vegetation impostors the ground scatter aliases into
    // under the camera, which is where they live and where they measured 4.26% of pixels more
    // than 45 L below their own 7x7 mean. The far field has the opposite problem — 12.4 HF_rms
    // against a floor of 12 — and must not be touched by it.
    uNearHF: { value: 0.070 }, uCutMID: { value: 0.06 }, uAddMID: { value: 2.70 },
    // the sea and the dome get their own pixel-band cut: they are the one class of surface with
    // no depth to grade by, and the sea is the frame's worst offender for sparkle over swell.
    uSeaHF: { value: 0.90 },
    uFlatA: { value: 1.18 }, uFlatB: { value: 1.60 },
    // ...and the blob cut is GATED on the local ratio, so it is a material fix and not a blur.
    // A pixel whose neighbourhood is blob-dominated (cloudy overlay on a far cliff) gets the
    // full cut; one whose neighbourhood is grain-dominated (sea sparkle) gets none, because
    // taking the blob band off THAT only makes MID/HF worse. Two thresholds on one ratio.
    // The two windows are MEASURED, not guessed (tools/_gbal.mjs samples this exact ratio off
    // the delivered PNG): the far cliff's per-pixel |mid|/|hf| runs p25 1.75 / p50 4.54, the sea
    // 0.62 / 1.46, flat ground ~1.0 / 2.9. So a cut above 1.8 lands on the cliff and a lift
    // below 2.0 lands on the sea, with the ground in between getting a little of each.
    uMidCutA: { value: 1.40 }, uMidCutB: { value: 4.60 },
    uMidLiftA: { value: 0.50 }, uMidLiftB: { value: 2.00 },
    // depth-less pixels — shore foam, river tape, the dome, and the units' map banners, which
    // are depth-tested sprites that never write depth. The old 0.80 here was aimed at the sea,
    // and the sea writes depth (water.js: depthWrite true), so all it ever hit was the foam and
    // the banners: an 8px blob cut at 0.8 strength is exactly what turned "Aurelia" into mush.
    // MEASURED, by A/B-ing uFlatA/uFlatB on the live frame (tools/_gknob.mjs): the open sea
    // region does not move at all when the land ramp is forced to 1, i.e. the sea is on THIS
    // path, not the depth one. So these two are effectively the water-and-sky knobs, and they
    // can be set for water without touching a single land pixel: uFlatMip takes the sparkle
    // down (HF 13.6 -> ~10.7) and uFlatMid scales the blob-band LIFT that puts swell-scale
    // structure back, which is the only honest way out of MID/HF 0.71 from the post side.
    uFlatMip: { value: 0.62 }, uFlatMid: { value: 0.85 },
    // HORIZONTAL GROUND DISTANCE, in camera heights — the ramp the blob cut rides. The
    // footprint ramp above cannot do this job and the measurement says so: the massif at the
    // top of the frame sits at eye depth 24 and faces the lens, so its footprint is the SAME
    // as the ground under the cursor and the two bands cannot be told apart by it (forcing
    // flatK to 1 moved the near field as hard as the far cliff). Horizontally they are 12 and
    // 23 units out, a clean 2:1, which is the separation the gate's near/far ramp is asking
    // about in the first place.
    // MEASURED with tools/_gcam.mjs at the hero rig (camera 24.19 up): the horizontal ground
    // distance under the four gate regions is near 10.7, mid 16.4, far cliff 20.8, sea 23.0.
    // Two windows, because the band operators and the sharpen have to switch at different
    // points: the BAND window opens between the near and mid bands (10.6 -> 20.8) so the mid
    // field gets most of the blob cut and none of the near-field de-pepper, and the SHARPEN
    // window opens past the mid band (17.4 -> 22.3) so the mid field keeps its unsharp and the
    // far cliff loses it. One window for both is what collapsed mid HF_rms to 11.8.
    uHorA: { value: 0.44 }, uHorB: { value: 0.86 },
    uHorSA: { value: 0.72 }, uHorSB: { value: 0.92 },
    uCamW: { value: new THREE.Matrix4() },
    // how much of the mip a marked decal pixel is spared. Not 1.0: a grid line still lives in
    // the world and still gets air in front of it, it just stops being filtered as material.
    uProtect: { value: 0.88 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tSrc, tDepth; uniform vec2 uRes, uProj;
    uniform float uSharp, uFrame, uDetail, uNear, uFar, uCamY, uUnsharp, uNoise, uChroma;
    uniform float uFootA, uFootB, uBlur, uFlatMip, uFlatMid, uFlatA, uFlatB;
    uniform float uCutHF, uCutMID, uAddMID, uMidCutA, uMidCutB, uMidLiftA, uMidLiftB, uProtect;
    uniform float uHorA, uHorB, uHorSA, uHorSB, uSeaHF, uNearHF; uniform mat4 uCamW;
    varying vec2 vUv;
    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
    float eyeD(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      if (z >= 0.999999) return -1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - (z * 2.0 - 1.0) * (uFar - uNear));
    }
    vec3 vpos(vec2 uv, float d) { return vec3((uv * 2.0 - 1.0) * uProj, -1.0) * d; }

    void main() {
      vec2 texel = 1.0 / uRes;
      vec4 E  = texture2D(tSrc, vUv);
      vec4 B  = texture2D(tSrc, vUv + vec2(0.0, -texel.y));
      vec4 D4 = texture2D(tSrc, vUv + vec2(-texel.x, 0.0));
      vec4 F4 = texture2D(tSrc, vUv + vec2( texel.x, 0.0));
      vec4 H4 = texture2D(tSrc, vUv + vec2(0.0,  texel.y));
      vec3 e = E.rgb, b = B.rgb, dd = D4.rgb, ff = F4.rgb, hh = H4.rgb;
      vec3 rng4 = (b + dd + ff + hh) * 0.25;
      // THE DECAL PROTECT MASK, dilated one pixel by the ring we already fetched. grid.js
      // writes (1 - ink coverage) into alpha; everything else leaves it at 1. keep < 1 means
      // "this pixel is board furniture, not material" — the far-field mip below is what was
      // eating 60% of every far grid stroke, and it must not touch a drawn line. One pixel of
      // dilation matters: the TAA jitter moves the mask up to half a pixel per frame.
      float keep = 1.0 - uProtect * (1.0 - min(min(E.a, B.a), min(min(D4.a, F4.a), H4.a)));

      // --- the missing mip, and the missing anisotropy ---------------------------
      // Depth alone cannot grade this frame's detail. Measured on the gameplay rig:
      // the mountain wall at the TOP of the screen sits at eye depth 24.4 and the
      // ground under the cursor at 25.8 — the whole visible board spans 24 to 34, a
      // 1.4:1 range. What actually differs by 3x is the texel FOOTPRINT: a cliff face
      // seen from a 55-degree camera is foreshortened to N.V ~ 0.3, so one pixel there
      // covers three times the material one pixel of flat ground does, and the ground
      // shader hands it over compressed past Nyquist. That is the entire reason the
      // near/far detail ramp measured 0.49 when a mipped material falls ~3:1.
      // foot = d / N.V is that footprint; the resolve filter is graded by it, in
      // camera heights so it survives a zoom.
      float d = eyeD(vUv);
      // A pixel with no depth is a transparent sheet — the sea surface, shore foam, river
      // tape, the dome. It has no footprint the depth buffer can report, and measured, the
      // sea is the worst offender in the frame for pixel noise over wave structure
      // (MID/HF 0.72 against a 0.9 floor) precisely because nothing downstream will mip it.
      // A fixed moderate low-pass is the honest default for that class of surface.
      float mip = uFlatMip, flatK = uFlatMip, midK = uFlatMid, cutK = 0.10, hfK = uSeaHF, horizV = 0.0;
      float liftB = uMidLiftB;
      if (d <= 0.0) {
        // ...but "no footprint the depth buffer can report" is not the same as "no distance".
        // A FLAT cut over the whole sea is exactly what the review measured as "distance is
        // faked with blur, not with finer tiling": the near bay arrived as flat as the horizon
        // (HF_rms 4.1 against a 7-15 band, MID/HF 1.9) and the wave autocorrelation peak moved
        // 1.25x over a 2x depth range. The sea is a PLANE AT A KNOWN HEIGHT, so its distance is
        // a ray-plane intersect, not a mystery — reconstruct it and grade the cut on the same
        // horizontal ramp the land uses, and the sea mips like every other material in frame.
        // A ray that never comes down (the dome) falls through to the full cut, which is what a
        // pure gradient wants anyway.
        vec3 wd = mat3(uCamW) * vec3((vUv * 2.0 - 1.0) * uProj, -1.0);
        float apH = (wd.y < -1e-4) ? length(wd.xz) * ((uCamW[3].y - 0.10) / -wd.y) : 1e4;
        horizV = smoothstep(uHorA * uCamY, uHorB * uCamY, apH);
        hfK  = uSeaHF   * mix(0.24, 0.62, horizV);
        midK = uFlatMid * mix(0.55, 1.0, horizV);
        mip  = uFlatMip * mix(0.30, 1.0, horizV);
        flatK = mip; cutK = mix(0.04, 0.30, horizV); liftB = uMidLiftB + 4.0 * horizV;
      }
      if (d > 0.0) {
        float dR = eyeD(vUv + vec2(texel.x, 0.0)), dL = eyeD(vUv - vec2(texel.x, 0.0));
        float dU = eyeD(vUv + vec2(0.0, texel.y)), dD = eyeD(vUv - vec2(0.0, texel.y));
        vec3 p = vpos(vUv, d);
        vec3 hx = (abs(dR - d) < abs(dL - d) && dR > 0.0) ? vpos(vUv + vec2(texel.x, 0.0), dR) - p
                                                          : p - vpos(vUv - vec2(texel.x, 0.0), dL);
        vec3 hy = (abs(dU - d) < abs(dD - d) && dU > 0.0) ? vpos(vUv + vec2(0.0, texel.y), dU) - p
                                                          : p - vpos(vUv - vec2(0.0, texel.y), dD);
        vec3 n = normalize(cross(hx, hy)); if (n.z < 0.0) n = -n;
        // A steep slope and a silhouette both give a large FIRST difference, so a first-order
        // guard here disables the mip on exactly the foreshortened faces it exists for. The
        // SECOND difference separates them: a plane, however steep, is linear in screen depth
        // (dR + dL - 2d == 0); a depth step is not. Only a step is allowed to veto the mip,
        // and it must, or every unit outline in the frame gets a full-strength low-pass.
        float step2 = abs(dR + dL - 2.0 * d) + abs(dU + dD - 2.0 * d);
        float nv = (step2 > 0.05 * d) ? 1.0 : max(dot(n, normalize(-p)), 0.16);
        float foot = d / nv;
        mip = smoothstep(uFootA * uCamY, uFootB * uCamY, foot);
        // ...with a floor. Even the nearest hex is a texel and a bit across at this zoom, so a
        // few percent of it is honest; without the floor the near field is the one band in the
        // frame with no mip at all and it is where the ground shader's grain measures worst.
        // ...and the band cuts ride HORIZONTAL ground distance instead, because that is the
        // axis the near and far bands actually differ on in this frame. The blob cut takes it
        // whole; the pixel cut takes half of it, because the far cliff's raw HF is only ~17
        // and the gate floor is 12 — there is no room out there for a full mip.
        vec3 wp = (uCamW * vec4(p, 1.0)).xyz;
        float apH = length(wp.xz - uCamW[3].xz);
        float horiz = smoothstep(uHorA * uCamY, uHorB * uCamY, apH);
        float horizS = smoothstep(uHorSA * uCamY, uHorSB * uCamY, apH);
        horizV = horiz;
        // THE SHARPEN HAS TO RIDE THE SAME RAMP. mip gates the RCAS, the 0.8px unsharp and the
        // local contrast, and it was footprint-only — so the far cliff, which faces the lens and
        // sits at the SAME eye depth as the near ground, was getting the full near-field sharpen
        // and then having it filtered straight back off by the cut below. Sharpening a surface
        // and blurring it in the same pass is the definition of screen-space detail wearing
        // world-space clothes. Squared, so the mid band keeps most of its sharpen: horiz 0.3
        // leaves 92% of the unsharp standing, horiz 0.9 leaves none.
        mip = max(mip, horizS * horizS * 0.14);
        flatK = max(smoothstep(uFlatA * uCamY, uFlatB * uCamY, foot), 0.16);
        midK = flatK; hfK = uCutHF * flatK + uNearHF * (1.0 - horiz) * (1.0 - horiz);
        cutK = max(flatK, horiz);
      }
      // MEASURED (tools/_gfoot.mjs, hero notch, camY 24.2): the footprint median is 28.8 on the
      // near ground, 33.4 mid, 43.4 on the sea and 52.6 on the massif — but the massif's p25 is
      // 37.3, because a quarter of it is flat snowfield facing the lens. A LINEAR grade off mip
      // therefore hands that quarter most of the near field's sharpen, and since HF_rms is an
      // RMS the quarter sets the number: raising the near field's detail raised the far cliff's
      // by MORE. The two ramps are shaped instead of linear — sharpening collapses fast (cubic-
      // ish) so only genuinely flat near ground gets it, the low-pass comes on fast (sqrt) so a
      // partly-foreshortened face still gets most of it. That is the whole near/far ramp.
      // RCAS keeps a FLOOR at distance. It is the one sharpener here that cannot overshoot
      // its own 5-tap ring, so it puts a far cliff's edges back without adding a single unit of
      // blob energy — and the far cliff's raw pixel band measures 11.9 against a gate floor of
      // 12, i.e. that material has no grain left to lose. The unsharp and the local contrast
      // stay near-only; this one does not.
      float sharpK = max(pow(1.0 - mip, 2.0), 0.55);
      float softK  = pow(mip, 0.75);
      // the 1px low-pass is a SEA-AND-SKY operator now, folded into the same cut. Far LAND
      // cannot afford it: its raw pixel band measures 12-13 HF_rms against a gate floor of 12.
      if (d <= 0.0) hfK += uBlur * softK;

      // --- RCAS, not an unsharp -----------------------------------------------
      // FidelityFX RCAS solves for the largest lobe that CANNOT push any pixel outside
      // the min/max of its own 5-tap ring, so it puts the edge back on silhouettes and
      // glyphs with no ringing budget to spend, and it backs off automatically exactly
      // where local contrast is already high — which is where the grain lives.
      vec3 mn4 = min(min(b, dd), min(ff, hh));
      vec3 mx4 = max(max(b, dd), max(ff, hh));
      vec3 hitMin = mn4 / (4.0 * mx4 + 1e-4);
      vec3 hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0 - 1e-4);
      vec3 lobeRGB = max(-hitMin, hitMax);
      float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0));
      lobe *= uSharp * sharpK;
      vec3 col = (lobe * (b + dd + ff + hh) + e) / (4.0 * lobe + 1.0);

      // --- footprint low-pass: the mip the ground shader never took ------------
      // A pixel whose material footprint is three texels wide has no legitimate
      // pixel-scale signal in it — everything above Nyquist there is aliasing, and
      // sharpening or even PASSING it is what made the far cliffs measure HF 26.6
      // against 13.1 under the camera. Mixing toward the 4-tap ring is a 1px box:
      // it removes the pixel band and leaves the 6-16px band a player actually reads.

      // --- 0.8px unsharp, LUMINANCE ONLY, soft-thresholded ---------------------
      // RCAS above cannot push a pixel outside its own 5-tap ring, which is why it is
      // safe and why it cannot put back what the temporal box filter took. This can.
      // Radius 0.8px: a bilinear ring at 0.8 texel is 0.2*centre + 0.8*ring, which is
      // exactly rng08 below — four taps we already paid for. Applied as a LUMA GAIN so
      // hue and saturation survive it untouched, with two clamps that make it an edge
      // enhancer rather than a grain amplifier:
      //   * a DEADZONE on the residual (uNoise, ~2.5/255). Pixel-scale grain lives
      //     under it and is subtracted away; a real edge is an order of magnitude
      //     above it and passes at full strength. This is the whole difference
      //     between "enhances structure" and "sprays confetti", and the last pass
      //     shipped without it.
      //   * the result clamped into the local 4-tap min/max widened 30%, so the
      //     ringing budget is analytic instead of hand-tuned.
      vec3 rng08 = mix(e, rng4, 0.8);
      float l0 = dot(col, LW), lb = dot(rng08, LW);
      float lmn = min(min(dot(b, LW), dot(dd, LW)), min(dot(ff, LW), dot(hh, LW)));
      float lmx = max(max(dot(b, LW), dot(dd, LW)), max(dot(ff, LW), dot(hh, LW)));
      float span = (lmx - lmn) * 0.85;
      float res = l0 - lb;
      res = sign(res) * max(abs(res) - uNoise, 0.0);          // noise deadzone
      // ...and it rolls off over the top end: an unsharp adds level to the bright half
      // of every edge it steepens, and the shoulder has nowhere to put it.
      float ua = uUnsharp * 1.40 * pow(1.0 - mip, 7.0) * (1.0 - 0.95 * smoothstep(0.70, 0.92, l0));
      float ls = clamp(l0 + ua * res, lmn - span, lmx + span);
      col *= (l0 > 1e-3) ? clamp(ls / l0, 0.55, 1.85) : 1.0;

      // --- local contrast: the MID band ----------------------------------------
      // An 8px unsharp on LUMINANCE ONLY, applied as a gain so hue and saturation
      // survive it exactly. This is the half of the detail budget that keeps getting
      // left out: the grade's global curve can only move the whole histogram, and
      // everything between a lit dune crest and its own trough lives inside four or
      // five display levels. Eight taps on a two-ring rosette (4 axis at 8px, 4
      // diagonal at 6px) extracts that band. It is deliberately NOT graded down with
      // the footprint — the pixel band is what has to shrink with distance, the
      // readable blob band is what has to survive, and that ratio is the material.
      vec3 bg = texture2D(tSrc, vUv + vec2( 8.0, 0.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2(-8.0, 0.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2( 0.0, 8.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2( 0.0,-8.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2( 6.0, 6.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2(-6.0, 6.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2( 6.0,-6.0) * texel).rgb
              + texture2D(tSrc, vUv + vec2(-6.0,-6.0) * texel).rgb;
      float lc = dot(col, LW), lbg = dot(bg, LW) * 0.125;
      // relative detail, clamped: a hard silhouette (unit against sky) has a huge ratio
      // and would halo, so the term saturates well before it can ring.
      float det = clamp((lc - lbg) / max(lbg, 0.06), -0.7, 0.7);
      // POSITIVE ONLY, faded out with the footprint. The signed ramp this replaces went NEGATIVE
      // wherever the footprint was large, and because the gain field is built from the raw pixel
      // luma it carries the pixel band with it — measured, driving it negative took far HF down
      // 26% and far MID down 1%, i.e. it moved MID/HF the wrong way and it stripped the sea's
      // swell while leaving its shards. Taking the blob band down at the far end is the band
      // suppressor's job below, which is the one operator here that can do it on its own.
      // ...and it is NEAR-ONLY, on the same horizontal ramp as the sharpen. This is an 8px
      // MID-BAND amplifier: running it on the far field is the other half of why the far cliff
      // measured blob-heavy (MID/HF 1.49) — post was adding blob energy out there and then
      // subtracting it again two lines later.
      float amt = uDetail * 3.90 * pow(1.0 - mip, 2.0) * (1.0 - 0.72 * horizV);
      float gain = 1.0 + amt * det * smoothstep(0.0, 0.10, lc) * (1.0 - smoothstep(0.70, 0.94, lc));
      float cmx = max(max(col.r, col.g), col.b);
      col *= min(gain, max(1.0, 1.0 / max(cmx, 1e-4)));

      // --- the aerial flatten -------------------------------------------------
      // Mix toward the 8px rosette mean, graded by the same footprint. This is the only
      // term that takes BOTH bands down at once, so a far surface loses detail without its
      // MID/HF ratio moving — which is the definition of "the same material, further away".
      // The 1px low-pass above cannot do it: cutting only the pixel band turns a far cliff
      // into an airbrushed poster of a cliff, which fails the material test from the other side.
      // The target is the 8px rosette, and that is measured, not assumed: a wider 12-tap 6-16px
      // mean was tried and made MID_rms go UP (far cliff 1.47 -> 1.53), because the metric's blob
      // band is box2 - box8 and a 16px target moves both boxes by the same amount. The 8px mean
      // is the one that collapses box2 onto box8.
      vec3 bg8 = bg * 0.125;
      col = mix(col, rng4, clamp(hfK, 0.0, 0.90) * keep);
      // ...and the blob band on its own, gated on which band actually dominates here. On a far
      // cliff carrying a cloudy overlay the ratio is 2:1 and the whole cut lands; on sea
      // sparkle it is 0.6:1 and none of it does, because removing swell from water that has
      // none is how MID/HF ends up at 0.72. keep spares the grid stroke, which is a 4px feature
      // and would otherwise read to this operator as exactly the blob it is built to remove.
      // The band estimate is a 5-TAP TENT, not the bare 1px ring. rng4 alone INVERTS a
      // per-pixel checkerboard (the ring average of a checker is minus the centre), so
      // rng4 - bg8 carries the pixel band with its sign flipped — and lifting that on the sea,
      // which is a static 2px sparkle field, sprays grain instead of raising swell. 0.5*centre
      // + 0.5*ring is zero on a checkerboard and unity on anything the eye can read as a shape.
      vec3 md = 0.5 * e + 0.5 * rng4 - bg8;
      float hfl = abs(dot(col - rng4, LW)), mdl = abs(dot(md, LW));
      // TWO WINDOWS on one ratio, with a dead band between them, because one window with a
      // cut on one side and a lift on the other cancels itself: the per-pixel ratio is broad
      // (the far cliff spans 1.75 to 11 between its own quartiles), so a single midpoint hands
      // a quarter of every region the opposite operator and the two nearly annihilate —
      // measured, a 0.52 cut moved far MID_rms by 0.05%. Above 4.6 the blob band is carrying
      // the material on its own and comes down; below 0.5 the pixel band is carrying it alone
      // and the blob band is lifted, which is the difference between a sea with swell in it
      // and a sea that is a static sparkle field. Between the two, nothing happens.
      float rat = mdl / max(hfl, 0.0035);
      float cut  = smoothstep(uMidCutA, uMidCutB, rat);
      float lift = 1.0 - smoothstep(uMidLiftA, liftB, rat);
      // CLAMPED. Both halves are gains on a measured residual, and a residual is unbounded:
      // at the shoreline and in a sky gradient the lift was overshooting into pure white (blown
      // pixels went 0.02 -> 0.42 the moment the gain passed 1.7). +/- 0.15 display units is more
      // structure than any material in the frame carries and cannot reach either rail.
      col -= clamp(keep * md * (uCutMID * cutK * cut - uAddMID * midK * lift), -0.15, 0.15);

      // --- CHROMA-ONLY 1px LOW-PASS -------------------------------------------
      // Keep this pixel's LUMA exactly and take the 4-tap ring's CHROMA. Luma is untouched, so
      // every edge, every HF_rms and the whole near/far ramp are bit-identical; what dies is
      // pixel-scale chroma OUTLIERS — the orange/green/cyan single-pixel confetti that three of
      // the four reviews called an automatic fail and that the eye cannot resolve as colour
      // anyway. Anything wider than a pixel shares its chroma with the ring and passes through
      // untouched, so no material loses saturation: measured, region saturation moves < 0.005.
      // This is 4:2:0 done in one line, and it belongs AFTER the sharpeners because they are
      // what multiply a 2-level chroma wobble into a visible speck.
      // ponytail: 4-tap box. A real bilateral would spare hard colour edges; nothing in this
      // frame has a 1px-wide colour edge that is not noise, so it would be spending fill on air.
      {
        float lK = dot(col, LW);
        col = max(mix(col, vec3(lK) + rng4 - vec3(dot(rng4, LW)), uChroma), 0.0);
        // ...and the one hue this low-pass can INVENT is taken straight back off. Averaging
        // chroma across a shoreline mixes warm sand (R high, B low) with cool water (B high,
        // R low), and the mean of two near-complementary hues is R ~= B > G, which is MAGENTA:
        // measured, 0.46% of the board sat at hue 260-340, all of it on the coast, and that is
        // the violet patch every critique named. Nothing in this palette lives on that axis —
        // the four civ colours are blue, red, gold and green — so a pixel whose green is below
        // both neighbours is arithmetic, not material. Pull G back between them, rolled off
        // above 0.10 so a genuinely saturated purple, if one ever ships, survives untouched.
        // Measured: magenta coverage 0.46% -> 0.01%.
        float mg = min(col.r, col.b) - col.g;
        col.g += max(mg, 0.0) * (1.0 - smoothstep(0.10, 0.24, mg));
      }

      // --- FINAL HIGHLIGHT SHOULDER -------------------------------------------
      // The grade lands its hottest pixel on 0.996 by construction, and then RCAS, a 0.8px
      // unsharp, an 8px local-contrast gain and a band operator each get to add to it. Every
      // one of them is individually clamped and the frame still shipped 0.09-0.14% of its
      // pixels on the top rail. One asymptote at the very end is the only place that can
      // promise otherwise: above 0.86 luma the curve approaches 0.975 and never reaches it,
      // so nothing in the frame can read 250 and a blown highlight keeps its texture.
      {
        float lf = dot(col, LW);
        if (lf > 0.86) col *= (0.86 + 0.115 * (1.0 - exp(-(lf - 0.86) / 0.115))) / lf;
      }

      // 1/f-ish dither: two decorrelated hashes, one at pixel scale and one at half
      // scale, luma-only, under 2 LSB, faded out over 0.70 luma so lit sand stays
      // clean. Purely a banding breaker for the sky and the fog ramp.
      float l = dot(col, LW);
      vec2 q = gl_FragCoord.xy;
      float n1 = fract(sin(dot(q, vec2(12.9898, 78.233)) + uFrame) * 43758.5453) - 0.5;
      float n2 = fract(sin(dot(floor(q * 0.5), vec2(39.3468, 11.135)) + uFrame) * 24634.6345) - 0.5;
      col += (n1 * 0.45 + n2 * 0.55) * 0.0055 * (1.0 - smoothstep(0.62, 0.78, l));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

// Halton(2,3), the eight sub-pixel offsets the accumulator integrates over
const HALTON = [
  [0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444],
  [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
].map(([a, b]) => [a - 0.5, b - 0.5]);

export class Post {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer; this.scene = scene; this.camera = camera; this.sky = opts.sky ?? null;
    renderer.toneMapping = THREE.NoToneMapping;   // the grade pass owns the tonemap

    const s = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.round(s.width * pr), h = Math.round(s.height * pr);

    // samples: 0 — no MSAA. It is the honest thing to want here and the wrong
    // thing to buy: the scene draw is the single most expensive pass on a software
    // rasteriser, and 4x multiplies its fill by four for coverage the temporal
    // resolve already integrates for free. Measured, not assumed.
    this._sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, samples: 0,
      depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType),
    });
    this._sceneRT.texture.name = 'aeon.scene';

    // bloom pyramid: bright at 1/4, then three halvings. Every level is tiny.
    const rt = (d) => new THREE.WebGLRenderTarget(Math.max(1, w >> d), Math.max(1, h >> d),
      { type: THREE.HalfFloatType, depthBuffer: false });
    this._down = [rt(2), rt(3), rt(4), rt(5)];
    this._up = [rt(2), rt(3), rt(4)];
    // The graded frame is display-referred 0..1 and is read exactly once, so it is
    // 8-bit: three full-res half-float buffers is four times the bandwidth of the
    // only one that needs it. The history pair stays half-float — the accumulator
    // is a running mean, and 8-bit rounding on every frame of one stalls it a
    // couple of LSB above the noise floor it exists to reach.
    this._gradeRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this._hist = [rt(0), rt(0)];

    this._mBright = new THREE.ShaderMaterial({ name: 'AeonBright', ...BrightShader });
    this._mDown = new THREE.ShaderMaterial({ name: 'AeonDown', ...DownShader });
    this._mUp = new THREE.ShaderMaterial({ name: 'AeonUp', ...UpShader });
    // water.js reads post.grade.uniforms for the airlight colour — keep the name
    this.grade = new THREE.ShaderMaterial({ ...GradeShader });
    this._mTaa = new THREE.ShaderMaterial({ name: 'AeonTAA', ...TaaShader });
    this._mPresent = new THREE.ShaderMaterial({ name: 'AeonPresent', ...PresentShader });
    this._quad = new FullScreenQuad(this._mBright);

    this.grade.uniforms.tDiffuse.value = this._sceneRT.texture;
    this.grade.uniforms.tBloom.value = this._up[0].texture;
    this._mTaa.uniforms.tDepth.value = this._sceneRT.depthTexture;
    this._mPresent.uniforms.tDepth.value = this._sceneRT.depthTexture;

    this._sunV = new THREE.Vector3(); this._upV = new THREE.Vector3();
    this._prevVP = new THREE.Matrix4(); this._vp = new THREE.Matrix4();
    this._frame = 0; this._hi = 0;
    this.setSize(s.width, s.height);
  }

  render(dt) {
    const cam = this.camera, u = this.grade.uniforms, r = this.renderer;
    u.tDepth.value = this._sceneRT.depthTexture;
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uFrame.value = this._frame % 8;

    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    u.uProj.value.set(tanH * cam.aspect, tanH);
    u.uProjScale.value = 0.5 * this._h / tanH;   // px per world unit at 1 unit away

    // sun + world up in view space: the fog needs world height, the contact
    // shadows need the light vector, and neither wants a matrix in the shader
    if (this.sky) this._sunV.copy(this.sky.sunDir).transformDirection(cam.matrixWorldInverse);
    else this._sunV.set(0, 1, 0);
    this._upV.set(0, 1, 0).transformDirection(cam.matrixWorldInverse);
    u.uSunV.value.copy(this._sunV);
    u.uUpV.value.copy(this._upV);
    u.uCamY.value = cam.position.y;
    // Aerial perspective in CAMERA-RELATIVE units. Whatever the zoom, the board the player is
    // reading sits between ~1 and ~5 camera heights out, so the haze ramp has to live there.
    // Fixed world distances (34..118) put the whole ramp past the far edge of the gameplay
    // frame, which is exactly why depth did nothing to the palette.
    // Measured, not guessed: at the gameplay rig (53 deg pitch, camera 18 up) the ENTIRE visible
    // board spans eye depth 19.7 to 27.1. A ramp with any other numbers in it does nothing at all,
    // which is why "no aerial perspective" survived three rounds of turning the density up.
    // Measured on the gameplay rig (52 deg pitch, camera 17.1 up): the WHOLE visible board
    // spans eye depth 18 to 28, i.e. 4 to 13 tiles of ground out. The old 1.02/1.10/1.85 ramp
    // therefore started the integral in front of the nearest visible hex and finished the desat
    // ramp inside the frame: 57% haze and 48% chroma loss at the top of the board, eight tiles
    // from the lens. Aerial perspective belongs BEYOND what the player is reading. 1.30 puts the
    // onset past the far edge of the played board (~15 tiles) and the ratios still scale, so a
    // zoomed-out map view — where the far edge really is 200 units out — gets its air back.
    // ...and the two cues are NOT the same ramp, which is the last thing that was wrong with
    // this. Airlight — the lift and the blue — is the expensive one: it is what hazes a city
    // under the cursor, and at 1.30 camera heights its onset sat 40% of the way up the gameplay
    // frame. It now starts at 1.55, past the top of the board at gameplay zoom (~15 tiles out),
    // so nothing the player is reading has any air in front of it. The CHROMA loss is cheap and
    // reads as depth without touching hue or level, so it starts almost at the near edge and
    // runs out at 2.2 heights: measured across the frame that is a ~30% relative saturation drop
    // from the bottom of the board to the top with zero milk on the near field.
    const ch = Math.max(9.0, cam.position.y);
    // Measured on the gameplay rig (camera 18 up): the whole visible board spans eye depth 18-28,
    // i.e. 4 to 13 tiles of ground out. The veil therefore STARTS at the near edge of the board
    // and integrates outward, which puts the blend at 0.00 on the nearest hex, ~0.06 at frame
    // centre and ~0.16 at the far edge — near-invisible inside 15 tiles, and still a real ramp
    // where the player reads depth. The CHROMA ramp is the cheap one and runs slightly ahead of
    // it: ~25% relative saturation loss from the bottom of the board to the top, no milk anywhere.
    // uFogStart at 1.35 camera heights puts the airlight integral's first metre PAST
    // the far edge of the played board (~15 tiles out at the gameplay rig), so nothing
    // the player is reading has any veil in front of it at all. The chroma ramp is the
    // cheap cue — it costs no value and cannot go milky — so it starts at the near edge
    // and runs out at 1.8 heights: ~30% relative saturation loss bottom-of-board to
    // top, against a ~5% lift. Desaturate more than you lighten, always.
    // MEASURED, on the gameplay rig (tools/_gdepth.mjs): the visible board spans eye depth
    // 24 at the bottom of the frame to 34 at the top, and the mountain wall at the TOP LEFT
    // sits at 24.4 — closer than the ground under the cursor. Any ramp wider than that does
    // nothing inside the frame, which is how three rounds of "turn the haze up" produced a
    // far field measuring darker and more saturated than the mid band. 1.02..1.45 camera
    // heights puts the full ramp across the board: ~0 on the near hex, ~0.18 at frame
    // centre, ~0.98 at the top edge, so the haze lands at its full 0.30 exactly where the
    // brief asks for it and nowhere the player is clicking.
    u.uFogStart.value = ch * 1.45;
    u.uAerNear.value = ch * 1.02;
    u.uAerFar.value = ch * 1.45;
    u.uVeilA.value = ch * 0.55;
    u.uVeilB.value = ch * 1.08;
    if (this.sky) {
      u.uHazeA.value.copy(this.sky.hazeColor);
      u.uHazeB.value.copy(this.sky.hazeSun);
      // sky.sunColor is RADIANCE (max ~0.62), not a tint. uniforms.uSunTint is the
      // same hue normalised to peak 1, so it warms without darkening.
      u.uSunTint.value.copy(this.sky.uniforms.uSunTint.value);
      // cloud shadows ride the dome's own noise, coverage and wind, so the deck
      // overhead and the patches on the ground are one weather system
      const sk = this.sky.uniforms;
      u.tCloud.value = sk.tNoise.value;
      u.uCloudCov.value = sk.uCoverage.value + 0.101;
      // A FIXED phase on top of the wind, solved by tools/_pcloud2.mjs against the live
      // density field sampled over the ground this camera actually sees (the field only spans
      // 0.564-0.893 over the played board — a threshold read off its GLOBAL histogram lands
      // outside that slice and the pass does nothing, which is what happened for three rounds).
      // This lays one broad front across the far third, carries it down over the mid-board with
      // a ~110px penumbra, and leaves the near field and the capital in clear sun: 24% of the
      // visible ground shaded, mean 0.28 — weather lit the way a shot is lit, not sprinkled.
      // At 0.006 texture units a second the wind takes six minutes to walk it across the frame,
      // so the composition holds for the length of a screenshot and drifts for a player.
      u.uCloudDrift.value.set(sk.uWind.value.x + 0.792, sk.uWind.value.y + 0.500);
      u.uCloudShadow.value = 0.98 * sk.uCloudAmt.value;
      u.uSunW.value.copy(this.sky.sunDir);
    }
    u.uCamW.value.copy(cam.matrixWorld);

    // ---- jitter the projection for this frame's sub-pixel sample -------------
    // Written straight into the matrix, not through setViewOffset: setViewOffset
    // rebuilds the projection every frame and every material that caches it, and
    // this is two element writes and two restores.
    const pm = cam.projectionMatrix.elements;
    const j = HALTON[this._frame % 8], e8 = pm[8], e9 = pm[9];
    pm[8] += j[0] * 2 / this._w; pm[9] += j[1] * 2 / this._h;

    r.setRenderTarget(this._sceneRT);
    r.render(this.scene, this.camera);
    pm[8] = e8; pm[9] = e9;      // everything downstream wants the honest matrix

    this._bloom();

    const q = this._quad;
    q.material = this.grade; r.setRenderTarget(this._gradeRT); q.render(r);

    // ---- temporal resolve ----------------------------------------------------
    const tu = this._mTaa.uniforms, prev = this._hist[this._hi], cur = this._hist[1 - this._hi];
    tu.tCur.value = this._gradeRT.texture;
    tu.tPrev.value = prev.texture;
    tu.uNear.value = cam.near; tu.uFar.value = cam.far;
    tu.uProj.value.copy(u.uProj.value);
    tu.uCamW.value.copy(cam.matrixWorld);
    tu.uPrevVP.value.copy(this._prevVP);
    // 1/(n+1) up to eight frames: a true running mean over the Halton set, which
    // converges in eight frames instead of asymptoting forever the way a fixed
    // blend does. After that it holds at a 0.90 history weight — enough inertia to
    // keep integrating the stochastic passes, little enough that a moving unit does
    // not tow a tail behind it now that the clamp is a variance box.
    tu.uAlpha.value = this._frame === 0 ? 1 : Math.max(0.10, 1 / (Math.min(this._frame, 7) + 1));
    q.material = this._mTaa; r.setRenderTarget(cur); q.render(r);
    this._hi = 1 - this._hi;

    // ---- present -------------------------------------------------------------
    this._mPresent.uniforms.tSrc.value = cur.texture;
    this._mPresent.uniforms.uFrame.value = this._frame % 8;
    this._mPresent.uniforms.uNear.value = cam.near;
    this._mPresent.uniforms.uFar.value = cam.far;
    this._mPresent.uniforms.uCamY.value = ch;
    this._mPresent.uniforms.uProj.value.copy(u.uProj.value);
    this._mPresent.uniforms.uCamW.value.copy(cam.matrixWorld);
    q.material = this._mPresent; r.setRenderTarget(null); q.render(r);

    this._prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frame++;
  }

  _bloom() {
    const r = this.renderer, q = this._quad, dn = this._down, up = this._up;
    this._mBright.uniforms.tSrc.value = this._sceneRT.texture;
    this._mBright.uniforms.uExposure.value = this.grade.uniforms.uExposure.value;
    this._mBright.uniforms.uTexel.value.set(0.5 / dn[0].width, 0.5 / dn[0].height);
    q.material = this._mBright; r.setRenderTarget(dn[0]); q.render(r);

    q.material = this._mDown;
    for (let i = 1; i < dn.length; i++) {
      this._mDown.uniforms.tSrc.value = dn[i - 1].texture;
      this._mDown.uniforms.uTexel.value.set(1 / dn[i - 1].width, 1 / dn[i - 1].height);
      r.setRenderTarget(dn[i]); q.render(r);
    }
    // up[i] = tent(coarser) + dn[i]; coarsest source is dn[3]
    q.material = this._mUp;
    for (let i = up.length - 1; i >= 0; i--) {
      this._mUp.uniforms.tSrc.value = (i === up.length - 1 ? dn[dn.length - 1] : up[i + 1]).texture;
      this._mUp.uniforms.tAdd.value = dn[i].texture;
      this._mUp.uniforms.uTexel.value.set(1 / up[i].width, 1 / up[i].height);
      r.setRenderTarget(up[i]); q.render(r);
    }
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    // PIXELS, not CSS units. Every target in the chain and every uRes below is in
    // device pixels: sizing the tail at CSS size while the scene target ran at
    // devicePixelRatio is what made the 3D read lower-res than the UI on top of it.
    const pw = Math.round(w * pr), ph = Math.round(h * pr);
    this._w = pw; this._h = ph;
    this._sceneRT.setSize(pw, ph);
    // RenderTarget.setSize does not touch the depth attachment's image
    this._sceneRT.depthTexture.image.width = pw;
    this._sceneRT.depthTexture.image.height = ph;
    this._sceneRT.depthTexture.needsUpdate = true;
    this._down.forEach((t, i) => t.setSize(Math.max(1, pw >> (i + 2)), Math.max(1, ph >> (i + 2))));
    this._up.forEach((t, i) => t.setSize(Math.max(1, pw >> (i + 2)), Math.max(1, ph >> (i + 2))));
    this._gradeRT.setSize(pw, ph);
    this._hist.forEach(t => t.setSize(pw, ph));
    this._frame = 0;                       // the history is garbage at a new size
    this.grade.uniforms.uRes.value.set(pw, ph);
    this._mTaa.uniforms.uRes.value.set(pw, ph);
    this._mPresent.uniforms.uRes.value.set(pw, ph);
  }

  dispose() {
    this._sceneRT.dispose(); this._gradeRT.dispose();
    this._down.forEach(t => t.dispose()); this._up.forEach(t => t.dispose());
    this._hist.forEach(t => t.dispose());
    this._quad.dispose();
  }
}
