// AEON — atmosphere + light rig.
//
// One Preetham analytic sky on a camera-locked box (1 draw call), plus the light
// rig it implies: a warm key whose colour and intensity follow the sun's own
// elevation, a cool skylight / warm ground-bounce hemisphere for the fill, and
// the airlight colour post.js and water.js both fade their distance into — so
// sky, sea and fog are the same atmosphere by construction, not by eye.
//
// Two things this file is careful about, because both were broken before:
//
//  1. It renders HDR. `renderer.toneMapping` is turned OFF here (post.js owns
//     the tonemap) so the dome and every scene material write linear radiance.
//     Tonemapping in the material *and* again in post is what turned the sky
//     into flat grey mud.
//  2. Below the horizon Preetham degenerates (the optical-depth term saturates
//     and every channel lands on the same value), which reads as a dead grey
//     void — and at a 45-degree strategy camera that void is most of the empty
//     frame. So the lower hemisphere is treated as *distant airlight*: the
//     horizon colour continued downward and deepened, never a ground wedge.
import * as THREE from 'three';
import { hash2 } from '../core/rng.js';

// ---------------------------------------------------------------- cloud noise
// Tileable value-noise fBm baked into one RGBA texture: R = coarse silhouette,
// G/B/A = successively finer detail. One fetch buys four octaves.
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const w = v => ((v % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed), b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed), d = hash2(w(xi + 1), w(yi + 1), seed);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function noiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const r = vnoise(u * 3, v * 3, 3, 11) * 0.62 + vnoise(u * 6, v * 6, 6, 23) * 0.38;
    const g = vnoise(u * 12, v * 12, 12, 37);
    const b = vnoise(u * 24, v * 24, 24, 53);
    const a = vnoise(u * 48, v * 48, 48, 71);
    const i = (y * size + x) * 4;
    data[i] = r * 255; data[i + 1] = g * 255; data[i + 2] = b * 255; data[i + 3] = a * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */`
uniform vec3 uSunDir; uniform float uRayleigh; uniform float uTurbidity; uniform float uMie;
varying vec3 vWorld; varying vec3 vBetaR; varying vec3 vBetaM; varying float vSunE;
const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float cutoffAngle = 1.6110731556870734, steepness = 1.5, EE = 1000.0;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;   // pin to the far plane: early-Z kills covered pixels
  float zc = clamp(uSunDir.y, -1.0, 1.0);
  vSunE = EE * max(0.0, 1.0 - exp(-((cutoffAngle - acos(zc)) / steepness)));
  vBetaR = totalRayleigh * uRayleigh;
  vBetaM = (0.434 * (0.2 * uTurbidity) * 10E-18 * MieConst) * uMie;
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDir; uniform float uMieG; uniform float uExposure;
uniform sampler2D tNoise; uniform vec2 uWind; uniform vec2 uCloudSun;
uniform float uCoverage; uniform float uCloudAmt; uniform float uCloudScale;
uniform vec3 uSunTint; uniform vec3 uHazeTint; uniform vec3 uBelow; uniform float uSunDisc;
varying vec3 vWorld; varying vec3 vBetaR; varying vec3 vBetaM; varying float vSunE;

const float PI = 3.141592653589793;
const float rayleighZenith = 8.4E3, mieZenith = 1.25E3;
const float sunCos = 0.99995667;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);

// two fetches at incommensurate scales: four octaves each, and the second one
// breaks the 1-unit tile of the first so the deck never visibly repeats
float dens(vec2 p) {
  vec4 n = texture2D(tNoise, p);
  vec4 m = texture2D(tNoise, p * 0.383 + vec2(0.21, 0.63));
  return n.r * 0.40 + n.g * 0.19 + n.b * 0.10 + n.a * 0.05
       + m.r * 0.18 + m.g * 0.08;
}

void main() {
  vec3 dir = normalize(vWorld - cameraPosition);
  vec3 up = vec3(0.0, 1.0, 0.0);

  // --- Preetham single scattering ---------------------------------------
  float zen = acos(max(0.0, dot(up, dir)));
  float inv = 1.0 / (cos(zen) + 0.15 * pow(93.885 - (zen * 180.0 / PI), -1.253));
  vec3 Fex = exp(-(vBetaR * rayleighZenith * inv + vBetaM * mieZenith * inv));

  float cosT = dot(dir, uSunDir);
  float rPhase = 0.05968310365946075 * (1.0 + pow(cosT * 0.5 + 0.5, 2.0));
  float g2 = uMieG * uMieG;
  float mPhase = 0.07957747154594767 * ((1.0 - g2) / pow(1.0 - 2.0 * uMieG * cosT + g2, 1.5));
  vec3 betaT = vBetaR * rPhase + vBetaM * mPhase, betaS = vBetaR + vBetaM;

  vec3 Lin = pow(vSunE * (betaT / betaS) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(vSunE * (betaT / betaS) * Fex, vec3(0.5)),
             clamp(pow(1.0 - dot(up, uSunDir), 5.0), 0.0, 1.0));

  // solar disc with limb darkening + a tight aureole. Peak lands around 130,
  // i.e. well over the bloom threshold but nowhere near half-float trouble.
  float disc = smoothstep(sunCos, sunCos + 0.000045, cosT);
  disc *= 0.55 + 0.45 * smoothstep(sunCos - 0.00003, 1.0, cosT);
  vec3 L0 = (vSunE * 40.0 * Fex) * disc * uSunDisc
          + vSunE * 7.0 * Fex * pow(max(cosT, 0.0), 2600.0) * uSunDisc;

  vec3 col = (Lin + L0) * uExposure;

  // --- boundary-layer aerosol -------------------------------------------
  // Preetham models a clean atmosphere: its horizon is a hard cyan. Real ones
  // whiten out over the last ~15 degrees, and that whitening is the thing that
  // sells depth, so it is put back explicitly.
  float dn = smoothstep(0.0, -0.34, dir.y);          // 0 at the horizon, 1 below it
  float hz = exp(-max(dir.y, 0.0) * 13.0) * (1.0 - 0.72 * dn);
  // 0.21 of a target that keeps 45% of its own chroma. A horizon mixed most of the way to
  // luminance is the milky grey WALL that makes a sky read as a painted backdrop instead of as
  // air, and the whitening only has to be enough to say "there is atmosphere between us".
  col = mix(col, mix(col, vec3(dot(col, LW)), 0.55) * uHazeTint, hz * 0.21);
  vec3 skyOnly = col;

  // --- cloud slab --------------------------------------------------------
  if (dir.y > 0.002 && uCloudAmt > 0.001) {
    // project the view ray onto a flat layer: parallax falls off near the horizon
    // 0.095, not 0.055. The projection onto a flat layer is a 1/y stretch, and at the gameplay
    // camera the sky is a ~17-degree band right above the horizon — exactly where 1/y runs away.
    // At 0.055 a cloud two degrees up was smeared eighteen times its own width along the
    // horizon, which is what turned the deck into flat painted shapes lying on the ocean plane.
    // The larger softening constant caps the stretch at ~10x and costs a little parallax
    // overhead, where nothing in this camera's frame ever looks.
    vec2 p = dir.xz / (dir.y + 0.095) * uCloudScale + uWind;
    float base = dens(p);
    float toSun = dens(p + uCloudSun);            // density one slab-step sunward

    // A 0.24-wide coverage ramp, not 0.13: at 0.13 the deck's silhouette resolved inside two
    // noise cells and the clouds arrived as flat cut-out SHAPES with a hard boundary — the one
    // thing in the frame that has no hard boundary in life. The wider ramp turns the same field
    // into a density gradient, so an edge is where the cloud thins out, not where it stops.
    float cov = smoothstep(uCoverage - 0.05, uCoverage + 0.19, base);
    // Near the horizon the deck THINS AND HAZES OUT — it is never deleted. Cutting it off at 12
    // degrees (what was here) emptied every sky the gameplay camera can actually see: at a 50-74
    // degree pitch the frame only ever holds the first ~17 degrees above the horizon, so the deck
    // was culled from exactly the band it had to fill and the sky arrived as a bald grey wall.
    // hzc is that band; the deck loses opacity through it and, below, loses its CONTRAST against
    // the local sky, which is what a real cloud does when there are forty kilometres of air in
    // front of it — compressed and hazy, never a painted cut-out lying on the sea.
    float hzc = smoothstep(0.010, 0.170, dir.y);
    cov *= mix(0.30, 1.0, hzc);
    float thick = smoothstep(uCoverage - 0.05, uCoverage + 0.26, toSun);

    float lit = exp(-2.6 * thick);                // Beer self-shadow
    float edge = 1.0 - smoothstep(0.30, 0.95, cov);
    float silver = pow(max(cosT, 0.0), 10.0) * edge;

    // keyed off local sky luminance, so clouds hold contrast at any exposure
    float skyL = dot(skyOnly, LW);
    vec3 shade = mix(skyOnly, uSunTint * skyL, 0.25) * 0.60;
    vec3 bright = uSunTint * (skyL * 2.15);
    vec3 cloud = mix(shade, bright, lit) + uSunTint * silver * skyL * 1.8;
    // the haze in front of it: the last few degrees keep only a third of the cloud's own contrast
    cloud = mix(mix(skyOnly, cloud, 0.26), cloud, hzc);

    col = mix(col, cloud, clamp(cov * uCloudAmt, 0.0, 1.0));
  }

  // --- below the horizon = distant airlight, never a ground wedge ---------
  // Driven off luminance so the band's hue is set outright rather than inherited
  // from Preetham's degenerate grazing-ray colour, which is a flat neutral.
  if (dn > 0.0) {
    // faint large-scale variation so the band is not a dead flat fill
    // scale matters here: sampled too small the projected field is locally
    // linear and the modulation shows up as a straight diagonal wedge
    vec2 bp = dir.xz / (abs(dir.y) + 0.30) * 0.55 + uWind * 0.35;
    float m = texture2D(tNoise, bp).r * 0.6 + texture2D(tNoise, bp * 2.7).g * 0.4;
    vec3 band = mix(col, vec3(dot(col, LW)), 0.72) * uBelow * (1.0 + (m - 0.5) * 0.11);
    col = mix(col, band, dn);
  }

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>   // no-op: post.js owns the tonemap
  #include <colorspace_fragment>
}`;

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const SLAB_LO = -0.5, SLAB_HI = 10;   // world-y range shadow casters live in
const MOONLIGHT = /* @__PURE__ */ new THREE.Color(0.30, 0.40, 0.68);
const CORNER = [-1, -1, -1, 1, 1, -1, 1, 1];
const lerpC = (out, a, b, t) => out.setRGB(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);

export class Sky {
  constructor(scene, renderer, opts = {}) {
    this.scene = scene; this.renderer = renderer;
    this.sun = opts.sun ?? null; this.hemi = opts.hemi ?? null; this.camera = opts.camera ?? null;

    // post.js tonemaps. Doing it here as well double-crushes every midtone.
    renderer.toneMapping = THREE.NoToneMapping;

    this.sunDir = new THREE.Vector3(-0.86, 0.42, -0.28).normalize();
    // Both of these are radiance in the same arbitrary unit the water shader
    // reads them in, NOT normalised hues: water.js takes sunColor and hazeColor
    // straight, so their *level* — not just their hue — decides whether the sea
    // or the land owns the frame. The DirectionalLight compensates with its
    // intensity, which is why that number looks large.
    this.hazeColor = new THREE.Color(0.07, 0.09, 0.15);   // linear; set by _airlight()
    this.hazeSun = new THREE.Color(0.16, 0.13, 0.10);     // airlight looking into the sun
    this.sunColor = new THREE.Color(0.62, 0.455, 0.295);
    this.elevation = 0.42;
    // 38 degrees up, azimuth up-screen-left. 25 degrees was prettier in isolation and cost the
    // frame every readable cast shadow: at 25 a keep throws 2.1x its own height, so the silhouette
    // detaches from its caster and lands three hexes away (usually on water, which receives
    // nothing). At 38 the ratio is 1.28 and a tower's shadow lies on the tile next to it, which is
    // what makes a building look like it is standing on the board. The gold stays in the key
    // colour and the airlight, not in the elevation.
    this._t = 0.3834;
    this._clock = 0;
    this._tmp = new THREE.Color();

    this.uniforms = {
      uSunDir: { value: this.sunDir },
      uRayleigh: { value: 2.6 }, uTurbidity: { value: 3.1 }, uMie: { value: 0.0058 },
      uMieG: { value: 0.76 }, uExposure: { value: 0.0044 }, uSunDisc: { value: 1 },
      tNoise: { value: noiseTexture(256) },
      uWind: { value: new THREE.Vector2() },
      uCloudSun: { value: new THREE.Vector2() },
      uCoverage: { value: 0.575 }, uCloudAmt: { value: 0.95 }, uCloudScale: { value: 0.42 },
      uSunTint: { value: new THREE.Color(1, 0.90, 0.76) },
      uHazeTint: { value: new THREE.Color(1.05, 1.01, 0.97) },
      uBelow: { value: new THREE.Color(0.86, 0.83, 0.81) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'AeonSky', uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(600, 600, 600), this.material);
    this.mesh.renderOrder = 1000;    // after opaques: covered pixels never run the maths
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    scene.background = null;         // the dome paints every pixel

    if (this.sun) {
      // a frustum-fitted 1k map beats a fixed 2k one stretched over the world
      // 2k over the ~70-unit fitted frustum is ~3.5cm/texel at hex scale, which
      // is the difference between a tree having a contact shadow and not.
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    }
    this._v = new THREE.Vector3(); this._c = new THREE.Vector3();
    this._lx = new THREE.Vector3(); this._ly = new THREE.Vector3();
    this._pts = new Float32Array(24);

    this.setTimeOfDay(this._t);
  }

  // Fit the shadow ortho box to the ground the camera can actually see. Rays are
  // clipped where they cross the terrain slab, so a 1k map covers ~70 world units
  // instead of the 240 an unclipped far plane would demand.
  _fitShadow() {
    const cam = this.camera, sun = this.sun;
    if (!cam || !sun) return;
    this._lx.crossVectors(UP, this.sunDir).normalize();
    this._ly.crossVectors(this.sunDir, this._lx);

    const maxD = Math.min(cam.far, 220), tan = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const v = this._v, c = this._c.set(0, 0, 0), pts = this._pts;
    const cy = cam.position.y;
    let n = 0;
    for (let i = 0; i < 8; i += 2) {
      v.set(CORNER[i] * tan * cam.aspect, CORNER[i + 1] * tan, -1).transformDirection(cam.matrixWorld);
      // stop the ray at the terrain slab; downward rays would run to the far plane
      const hit = v.y < -1e-3 ? (SLAB_LO - cy) / v.y : maxD;
      const t = THREE.MathUtils.clamp(hit, 4, maxD);
      for (let k = 0; k < 2; k++) {
        const f = k === 0 ? 0.06 : 1.0;
        pts[n++] = cam.position.x + v.x * t * f;
        pts[n++] = cam.position.y + v.y * t * f;
        pts[n++] = cam.position.z + v.z * t * f;
      }
    }
    for (let i = 0; i < n; i += 3) c.set(c.x + pts[i], c.y + pts[i + 1], c.z + pts[i + 2]);
    c.multiplyScalar(3 / n); c.y = THREE.MathUtils.clamp(c.y, SLAB_LO, SLAB_HI);
    sun.position.copy(this.sunDir).multiplyScalar(170).add(c);
    sun.target.position.copy(c); sun.target.updateMatrixWorld();

    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < n; i += 3) {
      // include the top of the tallest caster, not just the ground hit
      for (let k = 0; k < 2; k++) {
        v.set(pts[i] - sun.position.x, (k ? SLAB_HI : SLAB_LO) - sun.position.y, pts[i + 2] - sun.position.z);
        const x = v.dot(this._lx), yy = v.dot(this._ly);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
      }
    }
    // square + texel-snapped: uniform density, no crawling when the camera pans
    const half = Math.max(maxX - minX, maxY - minY) * 0.5 + 3;
    const texel = (half * 2) / sun.shadow.mapSize.x;
    const sc = sun.shadow.camera;
    const ox = Math.round((minX + maxX) * 0.5 / texel) * texel;
    const oy = Math.round((minY + maxY) * 0.5 / texel) * texel;
    sc.left = ox - half; sc.right = ox + half; sc.bottom = oy - half; sc.top = oy + half;
    // The light sits 170 units out and the fitted box is ~36 across, so 1..360 spent more than
    // three quarters of the depth range on empty air either side of the casters. Tightening it
    // around the slab is free precision, and shadow precision is the difference between a keep's
    // shadow landing on the next hex and it dissolving into acne against its own bias.
    sc.near = Math.max(1, 170 - half - 24); sc.far = 170 + half + 40;
    sc.updateProjectionMatrix();
    sun.shadow.normalBias = Math.max(0.010, texel * 0.7);
  }

  // t01: 0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
  setTimeOfDay(t01) {
    this._t = t01;
    const a = (t01 - 0.5) * Math.PI * 2, tilt = 0.5934;   // 34deg arc lean
    // The arc leans toward -z on purpose. main.js looks down -z, so a +z sun
    // sits behind the camera and every cast shadow hides behind its own caster:
    // correct light, dead flat frame. Leaning the other way throws the shadows
    // down-screen where they actually read as height.
    this.sunDir.set(Math.sin(a), Math.cos(a) * Math.cos(tilt), -Math.cos(a) * Math.sin(tilt)).normalize();
    const e = this.sunDir.y;          // sin(altitude)
    this.elevation = e;

    // --- atmosphere: thicker + hazier as the sun drops -------------------
    const low = 1 - THREE.MathUtils.smoothstep(e, -0.02, 0.60);      // 1 at horizon
    this.uniforms.uTurbidity.value = 2.4 + low * 2.8;
    this.uniforms.uMie.value = 0.0034 + low * 0.0034;
    this.uniforms.uRayleigh.value = 2.9 - low * 0.6;
    this.uniforms.uCoverage.value = 0.575 - low * 0.03;
    this.uniforms.uSunDisc.value = e > -0.06 ? 1 : 0;

    // cloud lighting: sunward offset in the projected plane == one slab step
    const hx = this.sunDir.x, hz = this.sunDir.z, hl = Math.hypot(hx, hz) || 1;
    const step = THREE.MathUtils.clamp(0.30 / Math.max(e, 0.12), 0.2, 2.0) * this.uniforms.uCloudScale.value;
    this.uniforms.uCloudSun.value.set(hx / hl * step, hz / hl * step);

    // --- colour temperature ----------------------------------------------
    const day = THREE.MathUtils.smoothstep(e, -0.05, 0.30);          // 0 night, 1 day
    // two-segment blackbody-ish ramp: deep orange on the deck, gold through the
    // golden hour, only near-white once the sun is properly up. Kept at ~0.62 of
    // unit radiance — see the constructor note; the key light divides that back
    // out into a normalised colour and an intensity, so terrain and water end up
    // on the same scale despite lighting themselves completely differently.
    const g1 = THREE.MathUtils.smoothstep(e, 0.00, 0.26);
    // 0.52, not 0.40: at the rig's 38-degree sun the old ramp was already a third of the way to
    // white, so the key was a pale straw and post's highlight target — which is this same tint —
    // had nothing warm to bend the top end toward. The frame is graded as golden hour; the light
    // has to be golden hour, and the two now come off one number.
    const g2 = THREE.MathUtils.smoothstep(e, 0.52, 0.98);
    const s = this.sunColor;
    lerpC(s, [0.62, 0.26, 0.11], [0.62, 0.455, 0.295], g1);
    lerpC(s, [s.r, s.g, s.b], [0.60, 0.573, 0.543], g2);
    const inv = 1 / Math.max(s.r, s.g, s.b);
    lerpC(this.uniforms.uSunTint.value, [s.r * inv, s.g * inv, s.b * inv], [1, 1, 1], 0.20);
    // The airlight ramps run faster than the sun's own colour: by 30 degrees of
    // elevation the horizon has already gone blue-white even though the key
    // light is still golden, and that warm-key / cool-air split is most of what
    // makes a late-afternoon frame read as late afternoon.
    const g3 = THREE.MathUtils.smoothstep(e, 0.02, 0.55);
    lerpC(this.uniforms.uHazeTint.value, [1.14, 1.00, 0.88], [0.96, 1.01, 1.08], g3);
    // below the horizon: deepen, and let the red go first — distant air is blue.
    // This is also the airlight hue post.js fogs into (see _airlight), so it is
    // the one place the sea's colour at the map edge is decided.
    // The day end sits on the BIBLE'S OCEAN HUE and nothing else gets a vote. _airlight below
    // saturates this triplet 1.85x and hands it to post.js as the airlight the whole far field
    // fogs into, so a hue error here is a hue error on every distant pixel in the frame. The
    // previous value was pushed to 232 to "add a violet family": measured result was ocean at
    // hue 232 against spec #123A63's 210, a lavender coast at hue 276 against coast #2E7C93's
    // 194, and four separate critiques calling the board purple. 0.62/0.92/1.26 saturates to
    // hue ~212, which is #123A63.
    lerpC(this.uniforms.uBelow.value, [1.10, 0.78, 0.60], [0.62, 0.92, 1.26], g3);

    if (this.sun) {
      this.sun.color.copy(s).multiplyScalar(inv).lerp(MOONLIGHT, 1 - day);
      // Key sits high on purpose, and higher again at a 25-degree sun: a low sun
      // puts N.L ~ 0.42 on flat ground, so the same lit grass needs well over
      // twice the irradiance a noon sun would have delivered. Big key, small
      // fill, and the grade's exposure takes the level back down.
      this.sun.intensity = (0.30 + 10.6 * Math.pow(day, 0.8)) * Math.max(s.r, s.g, s.b);
      const tp = this.sun.target.position;
      this.sun.position.set(tp.x + this.sunDir.x * 160, tp.y + this.sunDir.y * 160, tp.z + this.sunDir.z * 160);
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.bias = -0.0002;   // normalBias is set per-frame by _fitShadow
    }
    if (this.hemi) {
      // Terrain is Lambert, which never sees scene.environment, so the hemi is
      // the whole ambient budget: a cool skylight over a warm ground bounce.
      // That split is what stops shadowed rock reading as neutral black — the
      // vertical walls of the hex columns see almost nothing else.
      const sky = new THREE.Color(), gnd = new THREE.Color();
      // b/r was 1.81 — a raw zenith sample, and Lambert terrain has no other ambient, so every
      // cast shadow in the frame arrived as navy on tan (measured hue rotation: 90-100 deg off
      // the lit hue). Real skylight reaching a shadowed hex is already mixed with the bounce off
      // everything around it. b/r 1.52 and a warmer, stronger ground term is that mix, done here
      // where it still respects surface orientation instead of as a flat lift in post.
      // b/r 1.14, not 1.52. Terrain is Lambert and this hemisphere IS its entire ambient, so
      // this pair alone decides the hue of every shaded hex on the board — and at a raw zenith
      // blue it decided BLUE: measured, lit rock #776a60 hue 26 against its own shadow #535563
      // hue 232, against the bible's 10-degree budget. Skylight reaching a shadowed hex is
      // already mixed with the bounce off everything warm around it; warm-neutral sky over a
      // stronger warm ground term is that mix, and it lets the surface's own albedo carry the
      // hue the way the bible's 'albedo-weighted ambient with ground bounce' says it should.
      lerpC(sky, [0.09, 0.12, 0.21], [0.70, 0.735, 0.80], day);
      lerpC(gnd, [0.05, 0.05, 0.06], [0.48, 0.375, 0.25], day);
      this.hemi.color.copy(sky); this.hemi.groundColor.copy(gnd);
      // The fill carries every shadowed hex on the board: terrain is Lambert with no GI, so
      // whatever this misses, post.js has to fake back in as a flat lift. Better here, where it
      // still respects surface orientation. Deliberately UNDER a third of the key: at 0.72 the
      // ambient was filling every cast shadow back in, which is why a frame full of working
      // shadow maps read as a frame with no shadows in it at all.
      this.hemi.intensity = 0.19 + 0.37 * day;
    }
    this._airlight(day, g3);
  }

  // Airlight for post.js's aerial perspective, and — because water.js mirrors
  // these two colours for its sky reflection and its entire ambient term — the
  // single strongest control over whether the sea or the land owns the frame.
  //
  // Hue comes from uBelow, which *is* the dome's below-horizon band, so the fog
  // and the sky it fades into are the same colour by construction. Level is set
  // by hand: Preetham's absolute scale is an arbitrary exposure, and reading it
  // raw is what made the ocean the brightest object on screen.
  _airlight(day, g3) {
    const lum = c => Math.max(c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722, 1e-4);
    const level = 0.008 + 0.100 * day;

    // saturate about luminance (the operation preserves it), then set the level.
    // ACES pulls a lot of chroma out of anything this bright, and grey haze reads
    // as a washed-out render rather than as air.
    const h = this.hazeColor.copy(this.uniforms.uBelow.value);
    const l = lum(h), sat = 1.85;
    h.setRGB(Math.max(l + (h.r - l) * sat, 0), Math.max(l + (h.g - l) * sat, 0), Math.max(l + (h.b - l) * sat, 0));
    h.multiplyScalar(level / lum(h));

    // Looking down-sun the Mie forward lobe turns the same air dusty gold and
    // lifts it ~2x. That warm/cool split across the frame is most of what makes
    // a low sun read as a low sun rather than as a colour filter.
    const t = this._tmp;
    lerpC(t, [1.30, 0.82, 0.44], [1.05, 1.02, 1.00], THREE.MathUtils.smoothstep(this.elevation, 0.25, 0.85));
    t.multiplyScalar(level / lum(t));
    this.hazeSun.copy(h).lerp(t, 0.75).multiplyScalar(1.9);

    // No PMREM bake. scene.environment only reaches MeshStandardMaterial, and
    // nothing in this build is standard-shaded (terrain is Lambert, water is a
    // raw ShaderMaterial), so convolving one cost seconds of cold-start compile
    // on the software rasteriser for zero pixels. The hemisphere pair is the
    // entire ambient term.
    // ponytail: add the PMREM back the day a Standard-shaded module ships.
    this.scene.environment = null;
  }

  update(dt) {
    this._clock += dt;
    // clouds drift with the prevailing wind; slow enough to read as scale
    this.uniforms.uWind.value.set(this._clock * 0.0060, this._clock * 0.0028);
    if (this.camera) this.mesh.position.copy(this.camera.position);
    this._fitShadow();
  }

  dispose() {
    this.mesh.geometry.dispose(); this.material.dispose();
    this.uniforms.tNoise.value.dispose();
  }
}
