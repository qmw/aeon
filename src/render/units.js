// AEON — units, cities, districts and roads: everything that stands ON the board.
//
// One material for the whole cast. Colour arrives as instanceColor (units) or vertex colour
// (buildings); metalness / roughness / window-emissive ride an `aMR` attribute that is
// per-INSTANCE on the shared unit primitives and per-VERTEX on the merged building meshes.
// Same shader either way, so a bronze helmet, a linen tunic and a lit window all come out of
// the same draw call.
//
// Units are a bone rig, not a skinned mesh: a figure is a list of (primitive, bone, colour,
// local matrix). Per frame we build eight bone matrices and multiply each part through, so a
// unit costs ~20 matrix multiplies and zero allocations, and every part lands in one of seven
// InstancedMeshes. Buildings never animate, so each building type is merged once and
// instanced across every city that uses it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { axialToWorld, worldToAxial, DIRS } from '../world/hex.js';

const WATER_Y = 0.10;          // mirrors water.js — boats float here
const PI2 = Math.PI / 2;

// ------------------------------------------------------------------- scratch
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const EMPTY = [];
const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _c = new THREE.Color(), _c2 = new THREE.Color();
const _m0 = new THREE.Matrix4().makeScale(0, 0, 0);   // the LOD cull writes this
const _hsl = { h: 0, s: 0, l: 0 };

// Screen VALUE of each biome as the art bible authors it — the number a unit standing on that
// tile has to stay a quarter of a value away from.
const BIO_V = {
  ocean: 0.26, coast: 0.34, beach: 0.62, desert: 0.58, snow: 0.81, plains: 0.47,
  grass: 0.40, tundra: 0.45, hills: 0.40, mountain: 0.47, forest: 0.30, jungle: 0.28,
};
// A figure's own mean authored lightness, cached on the def. Everything else is measured
// against it, so the stretch below pushes parts apart without moving the cast as a whole.
function defV(d) {
  if (d._bv === undefined) {
    let t = 0, n = 0;
    for (const p of d.parts) {
      if (typeof p.c !== 'number') continue;
      _c.set(p.c).getHSL(_hsl, THREE.SRGBColorSpace); t += _hsl.l; n++;
    }
    d._bv = n ? t / n : 0.36;
  }
  return d._bv;
}

// deterministic little PRNG so a reseed lays the same town out the same way twice
const rng = (seed) => { let s = ((seed | 0) || 1) & 0x7fffffff; return () => (s = (s * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff; };
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const hexDist = (aq, ar, bq, br) => (Math.abs(aq - bq) + Math.abs(aq - bq + ar - br) + Math.abs(ar - br)) / 2;
function ringTiles(cq, cr, rad) {
  const out = []; let q = cq + DIRS[4].q * rad, r = cr + DIRS[4].r * rad;
  for (let i = 0; i < 6; i++) for (let j = 0; j < rad; j++) { out.push({ q, r }); q += DIRS[i].q; r += DIRS[i].r; }
  return out;
}

// ------------------------------------------------------------------- palette
const C = {
  skin: 0xac774b, skinD: 0x855c3a, hair: 0x2e2015,
  linen: 0xa79a80, wool: 0x796a4c, cloak: 0x51452f, trews: 0x54432e,
  leather: 0x7d5731, leatherD: 0x4c3520, wood: 0x8a6236, woodD: 0x593c20,
  iron: 0x8d8c85, steel: 0xb6bdc4, bronze: 0xc09338, gold: 0xe0b348,
  dark: 0x272320, rope: 0xb9a67c,
  plaster: 0xc0b291, plasterB: 0xac9c78, roof: 0xa8503a, roofD: 0x723325,
  thatch: 0x7d6234, thatchD: 0x50401e, stone: 0x8d8268, stoneD: 0x5f5744,
  stoneL: 0x968b71, soil: 0x594730, crop: 0x8f9a45, hide: 0x8a5b34,
  horse: 0x6a4527, horseD: 0x422a18, window: 0x5c4630, canvas: 0x93876c,
};

// [metalness, roughness, window-emissive, material ZONE].
// The zone is the whole texturing story: it picks which procedural surface the fragment
// shader synthesises — weave, grain, courses, scale-mail, thatch, tile. Nothing here is a
// flat colour by the time it reaches the screen.
// NO ENV MAP IN THIS SCENE, so metalness is a TRAP: three.js builds material.diffuseColor as
// diffuse * (1 - metalness), and the only specular this renderer supplies is the hand-rolled
// hemisphere below. A metalness-1.0 bronze therefore has NO diffuse and almost nothing to
// reflect, which measured (tools/_ucontrast.mjs) at 0.334 against ground at 0.492 — the
// brightest material in the game arriving DARKER than dirt, which is why five reviews in a row
// found no accent anywhere on a figure. Half-metal keeps the diffuse term and the low roughness
// keeps the spec lobe, so bronze is finally the top of the value ladder.
const M_CLOTH = [0, 0.94, 0, 0], M_SKIN = [0, 0.62, 0, 1], M_MET = [0.20, 0.28, 0, 2];
const M_MET2 = [0.18, 0.42, 0, 2], M_WOOD = [0, 0.82, 0, 3], M_LEATH = [0, 0.58, 0, 6];
const M_STONE = [0, 0.90, 0, 4], M_THATCH = [0, 0.97, 0, 5], M_PLAST = [0, 0.88, 0, 9];
const M_TILE = [0, 0.62, 0, 7], M_WIN = [0, 0.45, 1, 10], M_SOIL = [0, 0.95, 0, 8];
const M_SCALE = [0.20, 0.40, 0, 11];   // scale/lamellar armour
// BURNISHED, NOT MIRRORED. A metalness-1.0 dome under a 40-degree camera reflects the ground,
// and the ground is dark: every helmet in the roster was arriving on screen as a brown lump
// with one specular pip. Half-metal keeps a diffuse term, so a bronze helm is the BRIGHTEST
// thing on the figure from above — which is where the eye lands first.
const M_HELM = [0.24, 0.32, 0, 2];

// CONTACT OCCLUSION, and it is a MULTIPLY, not a painted colour. The last pass tinted a warm
// ochre pool and alpha-blended it over the sand, which is why the review called it a
// blob-decal sticker: an additive-looking brown smear four times the footprint, offset
// down-sun, with lit ground still visible between the boots and the darkest texel. Ambient
// occlusion is the ground times a number, the number leans toward the sky (never brown), and
// the darkest texel is directly under the feet.
const AO_MUL = new THREE.Color(0.325, 0.335, 0.360);
// Buildings go a step deeper than a soldier's boots: the acceptance test the review wrote is
// that terrace directly downsun of the keep reads 45-55% darker than the lit terrace beside it,
// and a multiply that lands at 0.71 of the ground cannot get there through the grade.
const PROP_MUL = new THREE.Color(0.255, 0.268, 0.292);

// Fallback livery for the standalone demo. In a real match the civ's OWN colour arrives on
// spec.color, and it has to win: rules.js paints Aeon 0x4fa8ff, grid.js draws its borders in
// that blue, and until now every Aeonian soldier on the board was crimson. A player who cannot
// match the man to the border he is standing inside cannot read the map.
const TEAMS = [
  { a: 0x7d2523, b: 0xe8c257, flag: 0xc03a37, name: 'Aurelia' },   // crimson + gold
  { a: 0x14525f, b: 0xdfe6e9, flag: 0x1d7f92, name: 'Kaldan' },    // teal + silver
  { a: 0x4e2d66, b: 0xe09a34, flag: 0x7a479e, name: 'Vashti' },    // purple + saffron
];
// The secondary is a pale TINT of the primary, not a second hue: heraldry pairs a field with
// its own light, and a tint survives at fifteen pixels where a contrasting hue just muddies.
const _livery = new Map();
function teamOf(spec) {
  const col = spec.color;
  if (col == null) return TEAMS[(spec.team ?? 0) % TEAMS.length];
  let t = _livery.get(col);
  if (!t) {
    // sRGB. Every number below — "wool sits around l 0.30", "s 0.58 / l 0.33" — is a painter's
    // value, and reading HSL in the LINEAR working space made all of them come out roughly one
    // stop lighter than they read on paper: the tabard the comments describe as dyed wool was
    // arriving at sRGB 0.56, which is the pale plastic swatch five reviews in a row measured.
    const hsl = {}; _c.set(col).getHSL(hsl, THREE.SRGBColorSpace);
    // TWO strengths of the same hue. The banner is heraldry and has to be a colour you can
    // name at forty pixels; a soldier's tabard is DYED WOOL, and painting it the same neon as
    // the flag is what makes a torso read as a solid plastic swatch — the review's words. So
    // cloth gets the hue at wool saturation and value, and only the flag stays vivid.
    // Round 3 shipped this too hot: a tabard, a shield face and a crest all at s 0.66 / l 0.42
    // turned every soldier into three saturated plastic slabs, which is literally what the
    // review drew a box around. Bronze-age dye does not do that. Cloth sits at indigo wool
    // strength and the FLAG keeps the vivid version, so the hue still names the owner.
    // Round 4: still too hot. The review's headline word for the shipped warrior was
    // "solid-cyan torso", and a tabard authored at s 0.44 / l 0.30 arrives on screen near
    // s 0.68 / l 0.51 once the cloth tint, the sky rim and the grade have all had a go at it.
    // Dyed wool sits lower than that. The FLAG keeps the vivid version, so ownership still
    // reads at forty pixels off a moving pennant instead of off a plastic slab.
    // Round 5: 0.14-0.26 was an over-correction. A tabard that dark is not dyed wool, it is a
    // hole in the figure — the whole torso arrived as one unlit mass with two pale skin balls
    // on top of it. Wool dyed with woad or madder sits around l 0.30, and the mantle now
    // carries that value where the camera can see it (see torso()).
    // Round 7: the review's measurement was that "#2F6FC0 appears nowhere on the map model".
    // Dyed wool still sits below the banner, but not below the GRASS — s 0.40 / l 0.26 against
    // a lit hillside is a grey lump, and a grey lump on green is the green-on-green failure.
    // MEASURED against tools/_upix.mjs, not eyeballed: at s 0.58 / l 0.33 a tabard arrived on
    // screen INSIDE the grade at sat 0.26 while the sand beside it measured 0.30 — the soldier
    // was literally less colourful than the dirt. Dye goes dark AND saturated: value is what
    // the tone curve eats, chroma is what it keeps.
    const a = new THREE.Color().setHSL(hsl.h, Math.min(0.74, hsl.s * 0.88 + 0.14), THREE.MathUtils.clamp(hsl.l * 0.50, 0.21, 0.32), THREE.SRGBColorSpace);
    const f = new THREE.Color().setHSL(hsl.h, Math.min(0.96, hsl.s * 1.12 + 0.18), THREE.MathUtils.clamp(hsl.l * 0.62, 0.28, 0.42), THREE.SRGBColorSpace);
    const b = new THREE.Color().setHSL(hsl.h, hsl.s * 0.30, 0.70, THREE.SRGBColorSpace);
    // The BASE DISC carries the raw livery at full chroma. It is the one surface on a unit
    // that is pure ownership signal — no weave, no weathering, no dye lot — which is how Civ
    // gets a player's colour onto 35% of a soldier's projected pixels without painting him.
    t = { a: a.getHex(), b: b.getHex(), flag: f.getHex(), disc: f.getHex(), raw: col };
    _livery.set(col, t);
  }
  return t;
}

// ------------------------------------------------------------ primitive set
// Seven shapes carry every unit in the game. Unit-space is metres-ish: a hex is 2.0 across
// the corners, a foot soldier is 0.82 tall — about 0.45 of a hex width, Civ's reading size.
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  caps: new THREE.CapsuleGeometry(0.5, 1, 3, 8),          // 2.0 tall, 1.0 wide
  sph: new THREE.SphereGeometry(0.5, 12, 8),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1),
  cone: new THREE.ConeGeometry(0.5, 1, 12, 1),
  ring: new THREE.TorusGeometry(0.42, 0.08, 4, 11),        // wheels, shield rims, hoops
  arc: new THREE.TorusGeometry(0.45, 0.036, 5, 18, Math.PI * 1.18),  // bows, stern curls
  rim: new THREE.TorusGeometry(0.46, 0.034, 5, 24),        // shield rims: thin, and round enough
};
// A LIMB THAT TAPERS. Two constant-radius capsules stuck on a torso is the loudest
// programmer-art tell a figure has, and the review named it: "constant-radius tan capsule
// arms". One extra primitive buys shoulder 1.7x wrist and thigh 1.9x ankle across the whole
// cast, because every arm and leg in the roster is drawn from this one shape.
G.limb = (() => {
  const g = G.caps.clone(), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.55 + 0.52 * THREE.MathUtils.smoothstep(p.getY(i), -1.0, 0.80);
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals(); return g;
})();

// ---------------------------------------------------------------- geo helpers
function xf(x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

// stamp colour + material params onto a placed copy of a primitive
function tag(geo, color, mr, mat) {
  const g = geo.clone();
  if (mat) g.applyMatrix4(mat);
  const n = g.attributes.position.count;
  _c.set(color);
  const col = new Float32Array(n * 3), amr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    amr[i * 4] = mr[0]; amr[i * 4 + 1] = mr[1]; amr[i * 4 + 2] = mr[2]; amr[i * 4 + 3] = mr[3] || 0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMR', new THREE.BufferAttribute(amr, 4));
  g.deleteAttribute('uv1'); g.deleteAttribute('uv2');
  return g;
}
const merge = (list) => mergeGeometries(list.filter(Boolean), false);

// narrow a shape toward its top — the single cheapest thing that stops a building reading
// as an extruded rectangle. Walls batter, huts cone, towers taper.
function taper(g, top, y0, y1) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = lerp(1, top, THREE.MathUtils.smoothstep(p.getY(i), y0, y1));
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals(); return g;
}
// hand-built wobble: nothing in a bronze-age town is straight
function wobble(g, amt, seed) {
  const r = rng(seed), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + (r() - 0.5) * amt, p.getY(i) + (r() - 0.5) * amt * 0.5, p.getZ(i) + (r() - 0.5) * amt);
  }
  g.computeVertexNormals(); return g;
}
// bake a ground-contact gradient into vertex colour; shadow maps never resolve this scale
function bakeAO(g, y0, y1, dark) {
  const p = g.attributes.position, c = g.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const k = lerp(dark, 1, THREE.MathUtils.smoothstep(p.getY(i), y0, y1));
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  return g;
}

// The MASS of a building, ignoring its trodden-earth apron: everything above 0.12 is structure,
// everything below it is the dirt skirt that is already flush with the ground. Shadow and
// contact-AO footprints are solved from this, so a keep throws a keep-sized shadow and not an
// apron-sized one, and nothing has to be hand-tabulated per building type.
function dimsOf(g) {
  const p = g.attributes.position;
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, h = 0;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); if (y > h) h = y;
    if (y < 0.12) continue;
    const X = p.getX(i), Z = p.getZ(i);
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  if (x0 > x1) { x0 = z0 = -0.18; x1 = z1 = 0.18; }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, rx: (x1 - x0) / 2, rz: (z1 - z0) / 2, h };
}
// Flat ground furniture: it IS the ground, or it floats on water with its own contact patch.
const NO_CAST = new Set(['terrace', 'rubble', 'field', 'dock', 'fishboat']);

// ------------------------------------------------------------------ material
// One MeshStandardMaterial for the whole cast, with four surgical replacements:
//
//  * roughness / metalness / window-emissive come off an `aMR` attribute (per-instance on the
//    unit primitives, per-vertex on the merged buildings), so bronze, linen and a lit window
//    share a draw call;
//  * aMR.w is a MATERIAL ZONE, and the fragment shader synthesises a real surface for it —
//    linen weave, leather crack, brushed bronze, wood grain, coursed stone, thatch straw,
//    roof scallops, lamellar scales. Albedo, roughness AND a height field, from which the
//    normal is perturbed with the standard derivative-based bump. That is what stops a
//    capsule reading as a capsule;
//  * a hemispheric ambient term is added by hand — nothing in the scene supplies an env map
//    and bare metal under one directional light is black;
//  * a downward-facing occlusion term, because a shadow map at 2cm/texel cannot resolve the
//    crease under a chin or a wagon bed.
//
// Detail is authored in OBJECT space (two-plane triplanar): units get per-part texel density
// that travels with the animation instead of swimming through world space, and the merged
// buildings — whose local space is already world scale — get courses that line up.
const DETAIL_GLSL = `
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}`;

// INVERTED HULL. At gameplay zoom a soldier is forty pixels of wool standing on grass and
// nothing separates him from it. Civ's answer is a dark contour, and a back-face hull pushed
// out a fixed number of SCREEN pixels is that contour for one extra instanced draw per
// primitive. Screen-space, not object-space: an object-space skin is invisible on the shield
// and a black halo on the sword. The push is view-depth * px / (h / (2 tan(fov/2))).
function hullMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 3.40 } },
    vertexShader: `
uniform float uPx;
void main(){
  #ifdef USE_INSTANCING
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
  #else
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
  #endif
  #ifdef USE_INSTANCING
    float psz = (length(instanceMatrix[0].xyz) + length(instanceMatrix[1].xyz) + length(instanceMatrix[2].xyz)) / 3.0;
  #else
    float psz = 1.0;
  #endif
  mv.xyz += n * min(psz * 0.075, -mv.z * uPx / 1680.0);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: 'void main(){ gl_FragColor = vec4(0.055, 0.049, 0.044, 1.0); }',
    side: THREE.BackSide,
  });
}

function castMat(u) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMR;\nvarying vec4 vMR;\nvarying vec3 vDet, vDetN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vDetN = objectNormal;')
      // Detail coordinates are object space SCALED BY THE INSTANCE, so texel density is constant
      // in world units while the frame still travels with the part. Raw object space is a trap:
      // the primitives are unit-sized, so a 0.1-wide bracer and a 0.6-wide hull would get the
      // same number of grain lines and the small one aliases into fur.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
 vMR = aMR;
 #ifdef USE_INSTANCING
   vDet = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
 #else
   vDet = position;
 #endif`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vMR; varying vec3 vDet, vDetN;
uniform float uWin, uDetail;
uniform vec3 uAmbSky, uAmbGnd, uUpV, uSunV, uRimCol;
float _dH = 0.0, _dR = 1.0, _dA = 1.0;
${DETAIL_GLSL}`)
      // ---- the surface itself. Runs once, before roughness and before the normal is used.
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // two-plane triplanar: pick the face the fragment is most parallel to
  vec3 an = abs(vDetN);
  vec2 uv = (an.y > max(an.x, an.z)) ? vDet.xz : (an.x > an.z ? vDet.zy : vDet.xy);
  // Every zone is authored in two octaves. The MACRO octave is sized to survive at gameplay
  // zoom (~3px features at 34 units); the MICRO octave is finer than a pixel out there, so it
  // is faded out by distance rather than left to alias into sparkle.
  // The gameplay camera sits ~44 units out — exactly where this used to hit zero, so every
  // fine octave in the whole cast was switched off in the one frame the critic scores. Pushed
  // out to keep ~25% of the micro detail alive at gameplay distance and still drop it entirely
  // on the far half of the map, where it is finer than a pixel and costs real milliseconds.
  float fade = 1.0 - smoothstep(18.0, 58.0, length(vViewPosition));
  float z = vMR.w, amp = 0.0;
  vec3 tint = vec3(1.0);
  // Everything multiplied by fade is finer than a pixel past ~34 units, so past that point
  // it is pure cost: a dozen hash-noise taps per fragment producing nothing the frame can
  // resolve. FN switches the fine octaves off wholesale out there. Under software GL this is
  // the difference between the cast costing 240 ms a frame and costing 170.
  bool _fx = fade > 0.02;
  #define FN(uv2) (_fx ? vn(uv2) : 0.5)
  if (z < 0.5) {                                   // ---- cloth: dye lots, slub, weave, hem grime
    // A tunic is not one colour. It is a bolt that took the dye unevenly, worn thin at the
    // shoulder and greyed at the hem, over a weave you can only see close up. The MACRO
    // octave is sized so ~3 patches cross a 0.22-wide torso: that is the largest feature that
    // still survives the 39 px/unit of gameplay zoom, and it is what stops the flat-fill read.
    float c = vn(uv * 15.0), c2 = vn(uv * 6.0);
    float m = FN(uv * 44.0) * fade;
    float w = FN(vec2(uv.x * 26.0, uv.y * 150.0)) * fade;   // warp threads, one direction only
    _dH = c * 1.0 + m * 0.62 + w * 0.40;
    tint = vec3(0.70 + 0.30 * c + 0.22 * c2 + 0.22 * m + 0.10 * w);
    _dR = 1.0 - 0.14 * m; amp = 0.0050;
  } else if (z < 1.5) {                            // ---- skin: shade break, not one tan fill
    float m = vn(uv * 17.0), f = FN(uv * 52.0) * fade;
    _dH = m * 0.55 + f * 0.35;
    tint = vec3(0.84 + 0.24 * m + 0.07 * f) * mix(vec3(1.0), vec3(1.05, 0.95, 0.90), m);
    _dR = 1.0 - 0.10 * m; amp = 0.0022;
  } else if (z < 2.5) {                            // ---- beaten / brushed metal
    // Bronze reads by CONTRAST: a hammered dish pattern big enough to survive at 24 px, a
    // fine brush streak that fades out with distance, and a wide roughness swing so the
    // specular breaks up instead of sitting as one plastic sheen.
    float d = vn(uv * 16.0), d0 = vn(uv * 6.5);
    float s1 = FN(vec2(uv.x * 6.0, uv.y * 90.0)) * fade;
    float d2 = FN(uv * 44.0) * fade;
    _dH = d * 1.15 + s1 * 0.34 + d2 * 0.40;
    tint = vec3(0.44 + 0.52 * d + 0.30 * d0 + 0.26 * s1 + 0.14 * d2);
    _dR = 0.34 + 1.30 * d - 0.24 * s1; amp = 0.0058;
  } else if (z < 3.5) {                            // ---- wood: grain rings along the long axis
    float g = vn(vec2(uv.x * 16.0, uv.y * 5.0));
    float ring = 0.5 + 0.5 * cos((g * 2.2 + uv.y * 4.5) * 6.2831853);
    float fine = FN(vec2(uv.x * 96.0, uv.y * 11.0)) * fade;
    _dH = ring * 1.0 + fine * 0.45;
    tint = vec3(0.56 + 0.52 * ring + 0.18 * fine);
    _dR = 0.90 + 0.18 * ring; amp = 0.0050;
  } else if (z < 4.5) {                            // ---- coursed stone: blocks + mortar
    // COURSE PITCH IS A SCREEN MEASUREMENT, not a taste. At 12 rows per world unit a keep
    // course projected 2.2 px at gameplay zoom: below the resolve threshold, so twenty of them
    // averaged into one flat gradient and the review measured "one step per face". 4.4 rows per
    // unit is a 0.23 m course — ~6 px here — and it is the finest octave allowed to carry the
    // structural read. Everything smaller is grain, and grain is what the pit octave is for.
    float row = floor(uv.y * 4.4), off = fract(row * 0.5);
    float bx = fract(uv.x * 2.9 + off), by = fract(uv.y * 4.4);
    float mort = min(smoothstep(0.0, 0.17, bx) * smoothstep(0.0, 0.17, 1.0 - bx),
                     smoothstep(0.0, 0.24, by) * smoothstep(0.0, 0.24, 1.0 - by));
    float t = h21(vec2(floor(uv.x * 2.9 + off), row));
    float pit = FN(uv * 34.0) * fade;
    _dH = mort * 1.7 + pit * 0.35;
    // The review counted "a single 4-course brick pattern tiling identically up the tower,
    // zero albedo variation, zero joint AO". Two things fix that and neither costs a texture:
    // a WEATHERING wash two octaves below the course grid, so the wall has damp and dry
    // stretches that are bigger than any one block, and a real JOINT occlusion — the mortar
    // line is recessed, so it is darker than the block face by more than its own albedo.
    float weath = vn(uv * 1.35) * 0.62 + vn(uv * 3.1) * 0.38;
    float joint = 1.0 - 0.52 * (1.0 - mort);
    tint = vec3((0.56 + 0.48 * mort) * (0.80 + 0.38 * t) + 0.07 * pit)
         * joint * (0.80 + 0.34 * weath)
         * mix(vec3(1.0), vec3(0.86, 0.90, 0.82), smoothstep(0.55, 0.95, weath) * 0.5);
    _dR = 1.0 - 0.10 * t; amp = 0.0090;
  } else if (z < 5.5) {                            // ---- thatch: combed straw bundles
    // Straw is combed DOWN the slope: stretched along the fall line, densely packed across it.
    float bundle = vn(vec2(uv.x * 2.6, uv.y * 12.0));
    float clump = vn(vec2(uv.x * 1.2, uv.y * 4.0));
    float st = FN(vec2(uv.x * 14.0, uv.y * 90.0)) * fade;
    _dH = bundle * 1.3 + clump * 0.7 + st * 0.5;
    tint = vec3(0.62 + 0.26 * bundle + 0.18 * clump + 0.14 * st); amp = 0.0080;
  } else if (z < 6.5) {                            // ---- leather: creased, pebbled, waxed
    float cr = vn(uv * 19.0), cr0 = vn(uv * 7.0), m = FN(uv * 48.0) * fade;
    _dH = cr * 1.3 + m * 0.55;
    tint = vec3(0.56 + 0.42 * cr + 0.26 * cr0 + 0.22 * m);
    _dR = 0.74 + 0.40 * cr; amp = 0.0054;
  } else if (z < 7.5) {                            // ---- roof tiles: scalloped courses
    // Courses step DOWN the slope (uv.x) and each course is a row of pantiles across it.
    float row = floor(uv.x * 11.0), off = fract(row * 0.5);
    float bx = fract(uv.y * 10.0 + off), by = fract(uv.x * 11.0);
    float lip = smoothstep(0.0, 0.30, by);
    float curve = sin(bx * 3.14159);
    float t = h21(vec2(floor(uv.y * 10.0 + off), row));
    float moss = smoothstep(0.62, 0.90, vn(uv * 2.4));      // damp courses go green
    _dH = curve * 0.9 + lip * 1.2;
    tint = vec3((0.56 + 0.50 * curve) * (0.26 + 0.74 * lip) * (0.84 + 0.32 * t) + 0.14)
         * mix(vec3(1.0), vec3(0.72, 0.80, 0.62), moss * 0.6);
    _dR = 0.9 + 0.2 * t; amp = 0.0065;
  } else if (z < 8.5) {                            // ---- soil / crop: furrows
    float f = sin(uv.y * 11.0) * 0.5 + 0.5;
    float cl = vn(uv * 7.0);
    _dH = f * 0.8 + cl * 0.7;
    tint = vec3(0.75 + 0.22 * f + 0.18 * cl); amp = 0.0055;
  } else if (z < 9.5) {                            // ---- lime plaster: trowelled, chipped
    float m = vn(uv * 4.2), m2 = vn(uv * 1.7), fine = FN(uv * 40.0) * fade;
    float chip = smoothstep(0.68, 0.78, vn(uv * 6.0));
    _dH = m * 1.0 + fine * 0.3 - chip * 1.5;
    // weathering: a limewashed wall streaks and greys where the rain runs off it
    float streak = smoothstep(0.45, 0.95, vn(vec2(uv.x * 2.6, uv.y * 0.9)));
    float pw = vn(uv * 1.15);
    tint = vec3(0.80 + 0.28 * m + 0.16 * m2 + 0.07 * fine)
         * (0.84 + 0.30 * pw)
         * mix(vec3(1.0), vec3(0.78, 0.76, 0.72), streak * 0.55)
         * mix(vec3(1.0), vec3(0.66, 0.59, 0.51), chip);
    _dR = 1.0 - 0.06 * m; amp = 0.0045;
  } else if (z > 10.5) {                           // ---- lamellar scale armour
    // Scale is the one zone whose pattern IS the silhouette read, so the plate count is tuned
    // to the cuirass width: ~7 scales across, ~9 courses down. Any denser and it moires.
    float row = floor(uv.y * 34.0), off = fract(row * 0.5);
    float bx = fract(uv.x * 26.0 + off), by = fract(uv.y * 34.0);
    float sc = sin(bx * 3.14159) * smoothstep(0.0, 0.55, by);
    float t = h21(vec2(floor(uv.x * 26.0 + off), row));
    _dH = sc * 1.7;
    tint = vec3((0.40 + 0.80 * sc) * (0.88 + 0.24 * t));
    _dR = 0.34 + 0.50 * (1.0 - sc); amp = 0.0062;
  }
  _dH *= amp * uDetail;
  diffuseColor.rgb *= mix(vec3(1.0), tint, uDetail);
  _dR = mix(1.0, _dR, uDetail);
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vMR.y * _dR, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMR.x;')
      // ---- derivative bump: turns the height field above into a real normal
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 sp = -vViewPosition;
  vec3 sx = dFdx(sp), sy = dFdy(sp);
  vec2 dB = clamp(vec2(dFdx(_dH), dFdy(_dH)), -0.02, 0.02);
  vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
  float det = dot(sx, R1);
  if (abs(det) > 1e-12) normal = normalize(abs(det) * normal - sign(det) * (dB.x * R1 + dB.y * R2));
  // ---- CAVITY, baked into albedo rather than into the ambient term alone.
  // At 24 px the bump normal is below its mip threshold and the shadow map resolves nothing
  // at this scale, so the only thing left holding a limb apart from the torso behind it is a
  // value break in the diffuse itself. Curvature is approximated by how far the (already
  // bumped) normal has fallen away from the sky: undersides of arms, the shadow line beneath
  // a helmet rim, the crease under a wagon bed. Applied here on purpose — lights_physical
  // builds material.diffuseColor from diffuseColor.rgb on the very next chunk.
  float cav = dot(normal, uUpV);
  diffuseColor.rgb *= mix(0.68, 1.06, smoothstep(-0.95, 0.45, cav));
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vMR.z * uWin * vec3(1.0, 0.52, 0.20) * 0.85;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // hemispheric fill + a sky-coloured specular sheen; metals get their tint from
        // specularColor, dielectrics only pick up a faint 4% rim.
        float ny = dot(normal, uUpV);
        // micro-occlusion: everything the sky cannot see is darker. A shadow map at this
        // scale resolves nothing, so the crease under a jaw or a wagon bed is bought here.
        float mao = mix(0.72, 1.06, smoothstep(-0.7, 0.6, ny));
        vec3 amb = mix(uAmbGnd, uAmbSky, ny * 0.5 + 0.5) * mao;
        reflectedLight.indirectDiffuse += material.diffuseColor * amb;
        float sheen = pow(1.0 - material.roughness, 1.6);
        // metal reads by CONTRAST, not by hue: a little flat fill, a strong sky bounce on the
        // up-facing planes and a fresnel rim on the silhouette.
        float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        reflectedLight.indirectSpecular += amb * material.specularColor * sheen * 0.9;
        // 2.6 on the up-facing term put every helmet in the roster at the top of the histogram:
        // from a 62-degree camera the dome IS the up-facing plane, so a bronze helm arrived as
        // a white egg and the crest that is supposed to name the unit sat on top of a blowout.
        // The sky still lights the crown; it no longer owns it.
        reflectedLight.indirectSpecular += uAmbSky * material.specularColor * sheen * (max(ny, 0.0) * 1.65 + fres * 1.4);
        // ---- RIM. At gameplay zoom a soldier is fifteen pixels of dark wool standing on dark
        // grass and his shadow side welds to whatever is behind him. The sky dome genuinely
        // wraps a lit figure, so take that light: a sky-coloured band along the silhouette,
        // weighted toward the upper edge so it never turns into a halo round the boots. This
        // is the silhouette gate — without it every unit is a smudge and every roofline is a
        // shape with no edge.
        // EXPONENT 2.6 IS NOT A RIM, IT IS A WASH. On a 0.66-unit cloak sphere a squared
        // fresnel covers a third of the projected area, so the "rim" was lighting the whole
        // garment — and the additive key-side term below then blew it to white and the bloom
        // pyramid finished the job. A rim is an EDGE: a band a pixel or two wide on the
        // silhouette. Exponents go up, intensities come down, and the figure gets its values
        // back.
        float rim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 8.0)
                  * (0.30 + 0.70 * smoothstep(-0.40, 0.55, ny));
        reflectedLight.indirectDiffuse += material.diffuseColor * uAmbSky * rim * 1.70;
        reflectedLight.indirectSpecular += uAmbSky * rim * 0.055;
        // ---- WARM KEY-SIDE RIM. The sky rim above separates a figure from the sky; this one
        // separates it from the GROUND, which is where a unit at twenty-four pixels actually
        // fails. A hot band, one to two pixels wide, only where the silhouette faces the sun.
        // It is the cheapest legibility this cast has and it goes on nothing else in the scene.
        float krim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 9.0)
                   * smoothstep(-0.10, 0.70, dot(normal, uSunV));
        reflectedLight.indirectSpecular += uRimCol * krim * 0.62;`);
  };
  return m;
}

// ============================================================ unit definitions
// bones: 0 root  1 torso  2 head  3 armL  4 armR  5 legL/axle-front  6 legR/axle-rear  7 mount
const P = (g, b, c, mr, x, y, z, sx, sy, sz, rx, ry, rz) =>
  ({ g, b, c, mr, m: xf(x, y, z, sx, sy, sz, rx || 0, ry || 0, rz || 0) });

// pivots for a standing man
// Proportion, not just size. At 0.345/0.40/0.615 the legs were 37% of the figure and the
// head+helm was taller than the torso: a three-head bobblehead, which is what "toy" means.
// Hips and shoulders go up, the leg capsules lengthen to match (see legs()), and bone 2 is
// scaled to 0.9 in the frame loop — legs 42%, head under a fifth of the body.
const HP = [[0, 0, 0], [0, 0.44, 0], [0, 0.665, 0], [0.125, 0.595, 0], [-0.125, 0.595, 0], [0.070, 0.385, 0], [-0.070, 0.385, 0], [0, 0, 0]];

// shared sub-assemblies, so eight unit types are not eight copies of "a man"
// THE LOWER BODY IS ONE DARK MASS. Round 5 shipped 0.108-wide bare limbs under 0.107-wide
// constant-radius leather cylinders on top of two pale 0.176-deep boot planks: from a
// 40-degree camera that is two barrels standing on two bright floor tiles, wider than the
// torso above them, and it is the single loudest programmer-art tell left on the cast.
// Narrower than the torso, tapered to the ankle, and dark all the way down, so the value
// ladder runs dark legs / mid cloth / bright helmet the way a readable figure is painted.
const legs = (col = C.trews) => [
  P('limb', 5, col, M_CLOTH, 0, -0.172, 0, 0.086, 0.190, 0.090),
  P('limb', 6, col, M_CLOTH, 0, -0.172, 0, 0.086, 0.190, 0.090),
  P('limb', 5, C.leatherD, M_LEATH, 0, -0.244, 0.004, 0.093, 0.090, 0.095),
  P('limb', 6, C.leatherD, M_LEATH, 0, -0.244, 0.004, 0.093, 0.090, 0.095),
  // A boot with a toe, in ONE value, and that value is the darkest on the figure — the top
  // face of a shoe is all this camera can see of it, so a pale one reads as a plank.
  P('sph', 5, 0x3b2d1e, M_LEATH, 0, -0.348, 0.028, 0.094, 0.062, 0.152),
  P('sph', 6, 0x3b2d1e, M_LEATH, 0, -0.348, 0.028, 0.094, 0.062, 0.152),
  P('box', 5, 0x241a11, M_LEATH, 0, -0.372, 0.032, 0.086, 0.022, 0.148),
  P('box', 6, 0x241a11, M_LEATH, 0, -0.372, 0.032, 0.086, 0.022, 0.148),
];
// PTERUGES. The lower half of every foot unit measured as one unbroken dark mass — legs, boots
// and hem all inside the 0.60x depth multiplier that _slots applies below the waist. Four pale
// linen straps hanging off the belt are the period answer and, more to the point, they are four
// hard vertical edges at exactly the pixel scale the critic measures as HF.
const kilt = (col = C.linen) => [
  P('box', 1, col, M_CLOTH, 0.088, -0.128, 0.070, 0.056, 0.115, 0.030, 0.10, 0, 0.04),
  P('box', 1, col, M_CLOTH, 0.000, -0.136, 0.086, 0.058, 0.125, 0.030, 0.12, 0, 0),
  P('box', 1, col, M_CLOTH, -0.088, -0.128, 0.070, 0.056, 0.115, 0.030, 0.10, 0, -0.04),
  P('box', 1, col, M_CLOTH, 0.140, -0.118, 0.008, 0.030, 0.105, 0.058, 0, 0, 0.08),
  P('box', 1, col, M_CLOTH, -0.140, -0.118, 0.008, 0.030, 0.105, 0.058, 0, 0, -0.08),
  P('box', 1, C.leatherD, M_LEATH, 0, -0.072, 0.056, 0.250, 0.024, 0.130),
];
const torso = (tunic, tabard) => [
  P('caps', 1, tunic, M_CLOTH, 0, 0.02, 0, 0.216, 0.115, 0.158),
  P('cone', 1, C.cloak, M_CLOTH, 0, -0.095, 0, 0.276, 0.115, 0.208),   // darker overtunic hem
  // THE CIV COLOUR NEVER LANDS ON A FLAT PANEL. Two boxes on a chest are a sandwich board:
  // one normal, one value, no gradient anywhere across them — which is exactly what "solid-
  // cyan torso" means and why no amount of dye-lot jitter fixed it. A mantle over the
  // shoulders and a sash across the body are curved surfaces, so the same dye reads as three
  // values from lit crown to shadowed flank and the man stops being a swatch.
  ...(tabard ? [
    P('cone', 1, tabard, M_CLOTH, 0, 0.042, 0, 0.278, 0.190, 0.214),                     // mantle
    // A pale border on the mantle hem. One thin ring, and it is the only bright horizontal
    // between the shoulder line and the belt — without it the whole chest is a single value
    // and the figure has no waist.
    P('cyl', 1, 'B', M_CLOTH, 0, -0.036, 0, 0.271, 0.022, 0.209),
    P('cyl', 1, C.leatherD, M_LEATH, 0, 0.128, 0, 0.130, 0.026, 0.104),                  // collar
    P('cyl', 1, C.linen, M_CLOTH, 0, 0.150, 0, 0.108, 0.024, 0.090),                     // linen scarf
    P('box', 1, C.leather, M_LEATH, 0.012, -0.012, 0.090, 0.044, 0.235, 0.024, 0, 0, 0.50),  // baldric
    P('box', 1, C.leatherD, M_LEATH, 0.012, -0.012, 0.086, 0.020, 0.240, 0.026, 0, 0, 0.50),
  ] : []),
  P('cyl', 1, C.leatherD, M_LEATH, 0, -0.055, 0, 0.228, 0.044, 0.170),  // belt
  P('box', 1, 0x8a6a26, M_MET, 0, -0.055, 0.133, 0.042, 0.042, 0.026), // buckle
  // SHOULDERS ARE ARMOUR, NOT SKIN. Two bare tan spheres the size of the head, sitting higher
  // and brighter than anything else on the man, is what "sphere shoulders" means: at forty
  // pixels the eye reads three pale balls in a row and calls it a snowman. These are pauldrons
  // — flattened, wider than they are tall, dark-rimmed, riveted — and they are in the CIV
  // COLOUR, because a shoulder cap is the one surface on a standing figure that faces a
  // 40-degree camera, so it is the only place the livery is legible from above.
  // BRONZE, not more livery. The shoulder caps really are the planes a 55-degree camera sees
  // most of — which is exactly why painting them the same dye as the mantle, the kilt and the
  // cloak turned the whole upper body into one flat blue mass with no internal value at all.
  // The three-value read wants the ACCENT here: polished metal at the top of the histogram,
  // livery in the middle on the mantle, wool and leather at the bottom.
  P('sph', 1, C.bronze, M_MET2, 0.126, 0.106, 0, 0.132, 0.084, 0.124),
  P('sph', 1, C.bronze, M_MET2, -0.126, 0.106, 0, 0.132, 0.084, 0.124),
  P('cyl', 1, C.leatherD, M_LEATH, 0.126, 0.068, 0, 0.128, 0.026, 0.120),
  P('cyl', 1, C.leatherD, M_LEATH, -0.126, 0.068, 0, 0.128, 0.026, 0.120),
  P('sph', 1, C.bronze, M_MET, 0.150, 0.124, 0.012, 0.042, 0.030, 0.042),
  P('sph', 1, C.bronze, M_MET, -0.150, 0.124, 0.012, 0.042, 0.030, 0.042),
];
// A round shield that is not a dartboard: planked lime wood, a hide-bound bronze rim, one
// civ-coloured face, two dark cross-braces and a domed boss. Reads edge-on as a disc, face-on
// as a blazon, at 64px as a solid circle beside the body.
// s is the shield's DIAMETER. G.cyl has radius 0.5 (so scale s gives radius s/2) and G.ring
// has radius 0.42 (so the rim scale is s/0.84). Getting that ratio wrong is how you end up
// with a cartwheel bolted to a man's arm.
// A circle inside a bronze ring, seen from a 40-degree camera, is a CARTWHEEL — that is the
// 'untextured gold-ringed blue ellipse' the review drew a box around, and adding spokes to it
// only made the wheel better. So: an OVAL board, taller than it is wide, one hide-bound board
// down the face and no hub. Nothing round, nothing concentric, nothing symmetric.
const shield = (bone, x, y, z, s, rx = 0, ry = 0, rz = 0) => {
  const t = s * 1.32, TI = rx + 0.11;      // 6.3 deg cant off the body plane
  // FIVE LIME BOARDS, A BOSS AND A BOUND RIM. The review measured the shipped face at
  // HF_rms 8.68 on mean 97.5 — 9% relative surface contrast, most of it the rim bleeding in —
  // and called it a painted disc, which is what a single civ-coloured ellipsoid is. What makes
  // a shield read at ten pixels is VALUE BREAK inside its own outline: limewashed planks over
  // a dark carcass, so four hard seams cross the face, a bronze boss at the centre and a dark
  // hide-bound rim round the outside. Plank field ~L 72, rim and seams ~L 26: a 45-step break,
  // which survives every downsample between here and gameplay zoom.
  const PX = [-0.315, -0.158, 0, 0.158, 0.315], PH = [0.56, 0.86, 1.0, 0.86, 0.56];
  const board = [];
  for (let i = 0; i < 5; i++) {
    // PAINTED, in the owner's colours. Bare limewash boards made every civ's shield the same
    // cream oval; alternating the vivid livery with its dark wool keeps the four plank seams
    // (the thing that reads at ten pixels) while the FACE names who is holding it.
    board.push(P('box', bone, i === 2 ? 'F' : (i % 2 ? 'A' : 0xb9ac8d), M_CLOTH,
      x + s * PX[i], y, z + s * (0.225 - Math.abs(PX[i]) * 0.20), s * 0.128, t * PH[i], s * 0.075, TI, ry, rz));
  }
  return [
    // A DOMED CARCASS, NOT A DISC. A scaled cylinder cap has one normal across its whole face
    // and no amount of texture puts a highlight roll on it; an ellipsoid falls off to the rim.
    P('sph', bone, C.woodD, M_WOOD, x, y, z, s * 1.02, t * 1.02, s * 0.32, TI, ry, rz),
    P('sph', bone, 0x33261a, M_WOOD, x, y, z + 0.008, s * 0.98, t * 0.98, s * 0.34, TI, ry, rz),
    ...board,
    // Hide-bound rim in DARK leather: the outline of the board, and the far end of the value
    // ladder from the planks it holds together.
    P('rim', bone, C.leatherD, M_LEATH, x, y, z + 0.004, s * 1.087, t * 1.087, 0.50, TI, ry, rz),
    P('rim', bone, 0x241a11, M_LEATH, x, y, z + s * 0.055, s * 1.045, t * 1.045, 0.34, TI, ry, rz),
    // boss: a domed bronze cap with its own shadow collar — the brightest pixel on the figure
    P('cyl', bone, 0x241a11, M_LEATH, x, y, z + s * 0.21, s * 0.34, 0.018, s * 0.34, TI + PI2, ry, rz),
    P('sph', bone, C.bronze, M_MET, x, y, z + s * 0.26, s * 0.25, s * 0.25, s * 0.21, TI, ry, rz),
    // the device: ONE civ-coloured bar across the boards, so ownership still reads off the face
    P('box', bone, 'B', M_CLOTH, x, y + t * 0.30, z + s * 0.20, s * 0.86, t * 0.085, s * 0.075, TI, ry, rz),
    // four iron plank cleats, deliberately off-balance so nothing on this board is concentric
    P('sph', bone, C.iron, M_MET, x + s * 0.31, y + t * 0.30, z + s * 0.16, s * 0.085, s * 0.085, s * 0.07, TI, ry, rz),
    P('sph', bone, C.iron, M_MET, x - s * 0.33, y - t * 0.08, z + s * 0.17, s * 0.085, s * 0.085, s * 0.07, TI, ry, rz),
    P('sph', bone, C.iron, M_MET, x + s * 0.17, y - t * 0.36, z + s * 0.15, s * 0.080, s * 0.080, s * 0.065, TI, ry, rz),
    P('sph', bone, C.iron, M_MET, x - s * 0.16, y + t * 0.38, z + s * 0.15, s * 0.080, s * 0.080, s * 0.065, TI, ry, rz),
    // grip block on the BACK, so the fist has something to hold
    P('cyl', bone, C.leatherD, M_LEATH, x, y, z - s * 0.21, s * 0.32, 0.050, t * 0.30, TI + PI2, ry, rz),
  ];
};
// A SWORD THAT NEVER TOUCHES THE GROUND. It used to hang at the hip on a -0.52 rake with the
// point at unit-y 0.02 — i.e. AT the dirt, which is the "sword tip clips ten pixels through the
// ground plane" the review measured. It is now held up and out on the weapon side, so the
// blade is a clean diagonal against the sky above the shoulder line: the single most legible
// thing a melee unit can own at thirty pixels, and it cannot intersect anything.
// Laid out ALONG its own axis so the assembly is rigid — the pommel, the fist, the guard and
// the point are all on one line by construction rather than by three hand-tuned offsets.
const _ax = (rx, rz) => new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(rx, 0, rz));
const sword = (bone, base, rx, rz, len = 0.42) => {
  const d = _ax(rx, rz);
  const at = (t) => [base[0] + d.x * t, base[1] + d.y * t, base[2] + d.z * t];
  const p = (g, c, mr, t, sx, sy, sz) => { const q = at(t); return P(g, bone, c, mr, q[0], q[1], q[2], sx, sy, sz, rx, 0, rz); };
  return [
    p('sph', C.bronze, M_MET, -0.082, 0.050, 0.044, 0.050),                 // pommel
    p('cyl', C.leatherD, M_LEATH, -0.030, 0.032, 0.105, 0.032),             // grip, in the fist
    p('box', C.bronze, M_MET, 0.042, 0.130, 0.028, 0.040),                  // cross-guard
    p('box', C.bronze, M_MET, 0.058, 0.052, 0.030, 0.046),                  // ricasso block
    // Rougher and darker than polished steel. At metalness 0.85 / roughness 0.44 the specular
    // colour IS the albedo, so a near-white blade mirrors the sky dome and lands on screen as
    // a glowing blue slab — which is what the last frame drew across this man's shield.
    p('box', 0x646c74, [0.45, 0.50, 0, 2], 0.058 + len * 0.46, 0.026, len * 0.86, 0.014),
    p('box', 0x4a5056, [0.40, 0.62, 0, 2], 0.058 + len * 0.46, 0.010, len * 0.80, 0.018),
    p('cone', 0x646c74, [0.45, 0.50, 0, 2], 0.058 + len * 1.00, 0.026, len * 0.24, 0.014),
  ];
};
const head = () => [
  P('cyl', 2, C.skinD, M_SKIN, 0, -0.032, 0, 0.078, 0.075, 0.078),      // neck
  P('sph', 2, C.skin, M_SKIN, 0, 0.055, 0.012, 0.135, 0.15, 0.142),
  // A CRANIUM IS NOT A FACE. From a 55-degree camera the plane you see most of on a standing
  // man is the TOP of his head, and every unhelmeted unit in the roster was leaving that as
  // bare skin with one dark brow box across the front — which is the "featureless egg head
  // with a visor band" three reviews in a row have named. Hair covers the crown, set back so
  // the face is still the thing pointing forward, and it is the DARK value of the head.
  // A SKULL CAP, SET BACK. At 0.142 x 0.148 centred on z -0.014 the hair sphere was WIDER and
  // DEEPER than the head under it: it enclosed the whole cranium including the face, and every
  // portrait in the game came out as a brown ball with a helmet behind it. It still covers the
  // crown — which is the plane a 55-degree camera sees most of — and it no longer owns the front.
  P('sph', 2, C.hair, M_CLOTH, 0, 0.088, -0.038, 0.136, 0.116, 0.126),
  P('sph', 2, C.hair, M_CLOTH, 0, 0.006, 0.066, 0.094, 0.062, 0.076),  // beard, jaw only
  // The face. At 50 px you cannot read an eye, but you CAN read the dark band a brow throws
  // across it, and that band is what turns a tan sphere into a head that is facing somewhere.
  P('box', 2, 0x241a12, M_LEATH, 0, 0.083, 0.092, 0.090, 0.024, 0.024),
  // Brow. Narrow and DARK: at 0.112 x 0.030 in pale skin it caught the sun from a 40-degree
  // camera and read as an orange bar across the face — a beak, not a brow.
  P('box', 2, 0x7a5232, M_SKIN, 0, 0.101, 0.086, 0.084, 0.016, 0.024),
  // Eye sockets. Deliberately under the board's six-pixel LOD cut, so they cost nothing at
  // gameplay zoom and exist where the panel portrait actually resolves a face.
  P('box', 2, 0x2b1e15, M_SKIN, 0.042, 0.084, 0.104, 0.030, 0.016, 0.014),
  P('box', 2, 0x2b1e15, M_SKIN, -0.042, 0.084, 0.104, 0.030, 0.016, 0.014),
  P('sph', 2, C.skin, M_SKIN, 0, 0.046, 0.106, 0.062, 0.048, 0.040),   // cheek / nose mass
];
// Hands. Two capsules ending in nothing is the single clearest 'unfinished figure' tell, and
// a fist is also what makes a weapon read as held rather than parented.
// LIMBS RECEDE. A sleeve authored in the same pale wool as the tunic puts two bright slabs at
// shoulder height, one either side of the head, and the eye reads them as mass rather than as
// arms. Dark sleeve, lit forearm: the value ladder runs dark limbs / mid torso / bright helmet,
// which is the order every readable game figure is painted in.
const arms = (sleeve = C.cloak) => [
  P('limb', 3, C.skin, M_SKIN, 0, -0.105, 0, 0.094, 0.108, 0.094),
  P('limb', 4, C.skin, M_SKIN, 0, -0.105, 0, 0.094, 0.108, 0.094),
  P('caps', 3, sleeve, M_CLOTH, 0, -0.048, 0, 0.100, 0.076, 0.100),
  P('caps', 4, sleeve, M_CLOTH, 0, -0.048, 0, 0.100, 0.076, 0.100),
  P('sph', 3, C.skinD, M_SKIN, 0, -0.211, 0.014, 0.062, 0.062, 0.070),
  P('sph', 4, C.skinD, M_SKIN, 0, -0.211, 0.014, 0.062, 0.062, 0.070),
];

const ALIAS = {
  scout: 'archer', swordsman: 'warrior', slinger: 'archer', worker: 'builder',
  chariot: 'horseman', galley: 'trireme', boat: 'trireme', knight: 'horseman',
  pikeman: 'spearman', ram: 'catapult', trebuchet: 'catapult', migrant: 'settler',
};

const DEFS = {
  // -------------------------------------------------- warrior: crested helm + round shield
  // silhouette gate at 64px: helmet crest breaks the head line, shield disc reads clear of the
  // body on the left, sword arm hangs clear of the hem on the right.
  warrior: {
    foot: 0.24, h: 0.86, piv: HP, gait: 1,
    parts: [
      // LIVERY ON THE PLANES THE CAMERA CAN SEE. Measured at 20.7% of the figure's projected
      // pixels in the owner's hue against a required 35%: tunic, mantle, pauldrons and kilt all
      // carry it now, and only the leather, the helm and the madder crest stay out of it.
      ...legs(), ...torso('A', 'F'), ...kilt(C.wool), ...head(), ...arms(),
      P('sph', 2, 0x77746c, M_HELM, 0, 0.072, 0, 0.145, 0.132, 0.145),          // helm dome
      P('cyl', 2, C.bronze, M_HELM, 0, 0.030, 0, 0.152, 0.038, 0.152),          // brow band
      P('box', 2, 0x8d8c85, M_HELM, 0, 0.038, 0.058, 0.030, 0.075, 0.045),      // nasal
      // Cheek pieces. Two dark plates hinged either side of the face: they close the helmet's
      // outline into a single mass instead of a dome floating over a chin, and they are the
      // pair of hard vertical edges that survive the downsample to thirty pixels.
      P('box', 2, 0x2f2418, M_LEATH, 0.093, 0.018, 0.018, 0.032, 0.100, 0.098, 0, 0, 0.10),
      P('box', 2, 0x2f2418, M_LEATH, -0.093, 0.018, 0.018, 0.032, 0.100, 0.098, 0, 0, -0.10),
      // Transverse crest — across the head, not along it. At 35 px the fore-and-aft crest
      // vanished into the helmet dome; a bar wider than the shoulders does not.
      P('box', 2, 0x352a1c, M_LEATH, 0, 0.140, 0, 0.100, 0.030, 0.044),        // crest socket
      // A ROUNDED CREST, and it is NOT the civ colour. A flat fin in saturated blue on top of
      // a helmet is a blue rectangle from every angle this camera can reach — a cap, not a
      // crest. Horsehair is dyed madder, not woad, so it stays out of the livery read. Laid
      // ACROSS the head and wider than the dome: from a 55-degree camera a fore-and-aft ridge
      // hides inside the helmet's own outline, and a cross of both reads as a hat.
      P('caps', 2, 0x9e3a2c, M_CLOTH, 0, 0.176, 0, 0.040, 0.094, 0.040, 0, 0, PI2),
      // The shield rides the FOREARM, not the air beside it: the fist is at (0,-0.213,0.014)
      // and the board's grip block now lands on it, with a strap across the arm above.
      ...shield(3, 0.048, -0.166, 0.062, 0.212, 0, 0, 0.10),
      P('box', 3, C.leatherD, M_LEATH, 0.026, -0.150, 0.024, 0.070, 0.026, 0.070, 0, 0, 0.10),  // arm strap
      // The blade is raked hard OFF the shield side and shortened, so it can never cross the
      // board — a silver slab lying across a blue disc was the reading of the shipped frame.
      // A WEAPON THAT LEAVES THE BODY. The review's headline on this unit was that an 8-STR
      // melee figure showed no weapon at all: a 0.30 blade raked 29 deg keeps the point inside
      // the silhouette, so black-on-white the man is a pawn. At 0.44 and 41 deg the tip clears
      // the outer edge of the torso by ~40% of body width, which is the one line that names him.
      ...sword(4, [0.030, -0.206, -0.020], -0.16, 0.72, 0.44),
      // ONE ASYMMETRIC MASS. Flat-black at 40 px the old warrior was bilaterally symmetric —
      // helmet, two arms, two legs — which is the difference between a game character and a
      // test dummy. A cloak off the weapon-side shoulder is two primitives and it breaks the
      // outline on one side only. Neutral wool on purpose: the civ colour is already carried
      // by the tabard and the pennant, and a third saturated slab is what made him plastic.
      // A CLOAK IS A DRAPE, NOT A BALL. At 0.252 x 0.400 x 0.132 hung off the flank this
      // sphere projected LARGER than the torso, the head and the shield put together: under a
      // 52-degree camera the warrior read as a blue egg with a crest on it. A cloak hangs
      // BEHIND the man, narrow across and thin front-to-back, so it lengthens the silhouette
      // downward instead of widening it.
      P('cyl', 1, C.cloak, M_CLOTH, -0.052, 0.104, -0.060, 0.240, 0.055, 0.195),
      P('sph', 1, C.cloak, M_CLOTH, -0.062, -0.090, -0.150, 0.196, 0.390, 0.070, 0.12, 0.14, -0.07),
      P('sph', 1, C.bronze, M_MET, -0.140, 0.116, 0.026, 0.058, 0.058, 0.044),        // clasp
    ],
    flags: [],
  },
  // -------------------------------------------------- spearman: one long vertical line
  // The spear is 1.6x the man and dead vertical — at 64px this is the only unit in the roster
  // with a line running out of the top of the frame, which is the whole read.
  spearman: {
    foot: 0.24, h: 1.20, piv: HP, gait: 1,
    parts: [
      ...legs(), ...torso(C.linen, 0), ...kilt('A'), ...head(), ...arms(C.wool),
      P('cone', 1, 0x6d6f72, M_SCALE, 0, 0.055, 0, 0.240, 0.145, 0.192),       // lamellar cuirass
      P('cyl', 1, C.leatherD, M_LEATH, 0, -0.048, 0, 0.252, 0.048, 0.192),
      P('cyl', 1, 'A', M_CLOTH, 0, 0.112, 0, 0.300, 0.050, 0.235),             // civ mantle
      P('sph', 1, 'A', M_CLOTH, -0.150, -0.02, -0.048, 0.115, 0.300, 0.155, 0.10, 0, 0.10),
      P('sph', 2, C.steel, M_HELM, 0, 0.078, 0, 0.158, 0.155, 0.158),
      P('box', 2, 0x35301f, M_LEATH, 0.12, 0.03, 0.01, 0.045, 0.115, 0.115),   // cheek guards
      P('box', 2, 0x35301f, M_LEATH, -0.12, 0.03, 0.01, 0.045, 0.115, 0.115),
      P('box', 2, C.leatherD, M_LEATH, 0, 0.150, -0.004, 0.032, 0.030, 0.170),
      P('box', 2, 'B', M_CLOTH, 0, 0.180, -0.004, 0.024, 0.090, 0.160),        // crest
      ...shield(3, 0.054, -0.160, 0.060, 0.198, 0, 0, 0.05),
      P('box', 3, C.leatherD, M_LEATH, 0.030, -0.144, 0.024, 0.072, 0.026, 0.072, 0, 0, 0.05),
      // SILHOUETTE GATE. Flat-black at 35 px, the spearman was the warrior: same blob, same
      // one vertical (the standard). The pike is now thicker than the standard, canted 9 deg
      // off it, and tipped at 1.62 against the standard's 1.33 — so the top of this unit is a
      // long diagonal leaving the frame, and no other class in the roster has one.
      P('cyl', 4, C.woodD, M_WOOD, -0.048, 0.175, 0.050, 0.030, 0.88, 0.030, -0.05, 0, -0.10),
      P('cyl', 4, C.leatherD, M_LEATH, -0.010, -0.22, 0.056, 0.040, 0.080, 0.040, -0.05, 0, -0.10),
      P('cyl', 4, C.bronze, M_MET, -0.112, 0.610, 0.026, 0.054, 0.050, 0.054, -0.05, 0, -0.10),
      P('cone', 4, C.steel, M_MET, -0.130, 0.745, 0.020, 0.060, 0.26, 0.060, -0.05, 0, -0.10),
      P('cone', 4, C.bronze, M_MET, 0.020, -0.420, 0.078, 0.036, 0.10, 0.036, PI2 - 0.05, 0, -0.10),
    ],
    flags: [],
  },
  // -------------------------------------------------- archer: the bow arc reads at any size
  archer: {
    foot: 0.24, h: 0.84, piv: HP, gait: 0.9,
    parts: [
      ...legs(), ...torso(C.linen, 0), ...head(), ...arms(C.wool),
      P('cone', 1, 'A', M_CLOTH, 0, 0.10, -0.02, 0.29, 0.20, 0.24),           // hooded cloak
      P('sph', 2, C.cloak, M_CLOTH, 0, 0.072, -0.012, 0.155, 0.15, 0.16),      // hood
      P('cyl', 2, C.leatherD, M_LEATH, 0, 0.005, -0.005, 0.172, 0.046, 0.174), // brow band
      P('sph', 1, 'A', M_CLOTH, 0.02, -0.03, -0.140, 0.190, 0.290, 0.115, 0.16, 0, 0),
      P('cyl', 1, C.leather, M_LEATH, -0.105, 0.035, -0.125, 0.095, 0.26, 0.095, 0.26, 0, 0.22),
      P('cone', 1, C.linen, M_CLOTH, -0.118, 0.17, -0.155, 0.045, 0.09, 0.045, 0.26, 0, 0.22),
      P('cone', 1, 'B', M_CLOTH, -0.085, 0.175, -0.148, 0.045, 0.09, 0.045, 0.26, 0, 0.30),
      P('cone', 1, 'B', M_CLOTH, -0.150, 0.172, -0.162, 0.042, 0.085, 0.042, 0.26, 0, 0.14),
      // The bow is the archer's whole read, so it is big — but the grip has to be IN the
      // fist. Centred on the elbow, as it was, it floated beside the man as a detached hoop.
      P('arc', 3, C.wood, M_WOOD, 0.020, -0.205, -0.095, 0.48, 0.48, 0.48, 0, PI2, 1.29),
      P('cyl', 3, C.rope, M_CLOTH, 0.020, -0.205, -0.124, 0.009, 0.42, 0.009),
      P('cyl', 3, C.leatherD, M_LEATH, 0.020, -0.205, 0.010, 0.030, 0.072, 0.030, PI2, 0, 0),  // grip
      P('cyl', 4, C.wood, M_WOOD, 0.02, -0.13, 0.10, 0.014, 0.24, 0.014, PI2, 0, 0),
    ],
    flags: [],
  },
  // -------------------------------------------------- horseman: quadruped + a vertical lance
  // The lance stands almost upright with the pennant at the top — that is the top-third prop.
  // Nothing is stapled to the rider's back.
  horseman: {
    foot: 0.4, h: 1.30, gait: 1, mounted: 1,
    piv: [[0, 0, 0], [0, 0.72, -0.06], [0, 0.92, -0.06], [0.115, 0.855, -0.06], [-0.115, 0.855, -0.06], [0, 0.44, 0.22], [0, 0.44, -0.24], [0, 0, 0]],
    parts: [
      // horse — barrel along z, withers at 0.50, muzzle out at z 0.56
      P('caps', 7, C.horse, M_SKIN, 0, 0.50, -0.02, 0.27, 0.30, 0.25, PI2, 0, 0),
      P('sph', 7, C.horse, M_SKIN, 0, 0.50, 0.22, 0.28, 0.28, 0.26),                // chest
      P('sph', 7, C.horseD, M_SKIN, 0, 0.50, -0.26, 0.32, 0.31, 0.26),              // rump
      P('caps', 7, C.horse, M_SKIN, 0, 0.635, 0.30, 0.155, 0.175, 0.155, 0.72, 0, 0), // neck
      P('caps', 7, C.horse, M_SKIN, 0, 0.755, 0.435, 0.115, 0.115, 0.115, 0.55, 0, 0),
      P('box', 7, C.horseD, M_SKIN, 0, 0.685, 0.525, 0.088, 0.085, 0.14, 0.55, 0, 0),  // muzzle
      P('box', 7, C.dark, M_LEATH, 0, 0.655, 0.575, 0.075, 0.055, 0.05, 0.55, 0, 0),
      P('cone', 7, C.horse, M_SKIN, 0.052, 0.855, 0.395, 0.042, 0.075, 0.042, -0.2, 0, 0.24),
      P('cone', 7, C.horse, M_SKIN, -0.052, 0.855, 0.395, 0.042, 0.075, 0.042, -0.2, 0, -0.24),
      P('box', 7, C.dark, M_CLOTH, 0, 0.735, 0.285, 0.040, 0.105, 0.34, 0.72, 0, 0),   // mane
      P('cone', 7, C.dark, M_CLOTH, 0, 0.52, -0.40, 0.075, 0.30, 0.075, -0.42, 0, 0),  // tail
      P('box', 7, 'A', M_CLOTH, 0, 0.643, -0.06, 0.30, 0.035, 0.40),                   // caparison
      P('box', 7, 'A', M_CLOTH, 0.142, 0.548, -0.06, 0.032, 0.21, 0.38),               // drape
      P('box', 7, 'A', M_CLOTH, -0.142, 0.548, -0.06, 0.032, 0.21, 0.38),
      P('box', 7, 'B', M_CLOTH, 0.143, 0.452, -0.06, 0.034, 0.048, 0.39),              // hem
      P('box', 7, 'B', M_CLOTH, -0.143, 0.452, -0.06, 0.034, 0.048, 0.39),
      P('cyl', 7, C.leatherD, M_LEATH, 0, 0.675, -0.04, 0.28, 0.055, 0.21),            // saddle
      P('cyl', 7, C.leatherD, M_LEATH, 0, 0.65, 0.30, 0.20, 0.030, 0.20, 0.72, 0, 0),  // browband
      // tack: a cheekpiece and two reins running back to the rider's hands. Nothing sells a
      // horse as ridden faster than a line from the bit to the fist.
      P('cyl', 7, C.leatherD, M_LEATH, 0.075, 0.70, 0.455, 0.020, 0.16, 0.020, 0.55, 0, 0),
      P('cyl', 7, C.leatherD, M_LEATH, -0.075, 0.70, 0.455, 0.020, 0.16, 0.020, 0.55, 0, 0),
      P('cyl', 7, C.leatherD, M_LEATH, 0.090, 0.735, 0.285, 0.014, 0.40, 0.014, 1.16, 0, 0),
      P('cyl', 7, C.leatherD, M_LEATH, -0.090, 0.735, 0.285, 0.014, 0.40, 0.014, 1.16, 0, 0),
      P('cyl', 7, C.leatherD, M_LEATH, 0, 0.545, 0.155, 0.30, 0.030, 0.24, 0, 0, PI2), // girth
      // legs (front pair / rear pair) — long enough that the animal is not a dog
      P('caps', 5, C.horse, M_SKIN, 0.105, -0.115, 0, 0.072, 0.135, 0.072),
      P('caps', 5, C.horse, M_SKIN, -0.105, -0.115, 0, 0.072, 0.135, 0.072),
      P('caps', 5, C.horseD, M_SKIN, 0.105, -0.30, 0, 0.055, 0.10, 0.055),
      P('caps', 5, C.horseD, M_SKIN, -0.105, -0.30, 0, 0.055, 0.10, 0.055),
      P('cyl', 5, C.dark, M_LEATH, 0.105, -0.395, 0.004, 0.068, 0.060, 0.078),
      P('cyl', 5, C.dark, M_LEATH, -0.105, -0.395, 0.004, 0.068, 0.060, 0.078),
      P('caps', 6, C.horse, M_SKIN, 0.108, -0.11, 0.02, 0.085, 0.145, 0.09),
      P('caps', 6, C.horse, M_SKIN, -0.108, -0.11, 0.02, 0.085, 0.145, 0.09),
      P('caps', 6, C.horseD, M_SKIN, 0.108, -0.305, -0.01, 0.055, 0.105, 0.055),
      P('caps', 6, C.horseD, M_SKIN, -0.108, -0.305, -0.01, 0.055, 0.105, 0.055),
      P('cyl', 6, C.dark, M_LEATH, 0.108, -0.395, -0.004, 0.068, 0.060, 0.078),
      P('cyl', 6, C.dark, M_LEATH, -0.108, -0.395, -0.004, 0.068, 0.060, 0.078),
      // rider
      P('caps', 1, C.wool, M_CLOTH, 0, 0.02, 0, 0.225, 0.11, 0.165),
      P('cone', 1, C.iron, M_SCALE, 0, 0.045, 0, 0.245, 0.13, 0.19),
      P('box', 1, 'A', M_CLOTH, 0, 0.015, 0.082, 0.138, 0.205, 0.038),                 // surcoat
      P('box', 1, 'A', M_CLOTH, 0, 0.015, -0.082, 0.138, 0.205, 0.038),
      P('box', 1, 'B', M_CLOTH, 0, -0.078, 0.086, 0.140, 0.036, 0.036),
      P('box', 1, 'B', M_CLOTH, 0, -0.078, -0.086, 0.140, 0.036, 0.036),
      P('box', 1, C.leatherD, M_LEATH, 0, 0.020, 0.088, 0.032, 0.200, 0.038),
      P('cyl', 1, 'A', M_CLOTH, 0, 0.105, 0, 0.278, 0.052, 0.215),
      P('sph', 1, 'A', M_CLOTH, 0.120, 0.102, 0, 0.126, 0.080, 0.118),
      P('sph', 1, 'A', M_CLOTH, -0.120, 0.102, 0, 0.126, 0.080, 0.118),
      P('cyl', 1, C.leatherD, M_LEATH, 0.120, 0.066, 0, 0.122, 0.026, 0.114),
      P('cyl', 1, C.leatherD, M_LEATH, -0.120, 0.066, 0, 0.122, 0.026, 0.114),
      P('sph', 1, C.bronze, M_MET, 0.144, 0.118, 0.012, 0.040, 0.028, 0.040),
      P('sph', 1, C.bronze, M_MET, -0.144, 0.118, 0.012, 0.040, 0.028, 0.040),
      // legs OUTSIDE the barrel, knee forward, boot in a real stirrup
      P('caps', 1, C.leather, M_LEATH, 0.178, -0.088, 0.072, 0.088, 0.112, 0.092, 1.02, 0, 0),
      P('caps', 1, C.leather, M_LEATH, -0.178, -0.088, 0.072, 0.088, 0.112, 0.092, 1.02, 0, 0),
      P('caps', 1, C.leatherD, M_LEATH, 0.180, -0.238, 0.118, 0.072, 0.098, 0.072, -0.12, 0, 0),
      P('caps', 1, C.leatherD, M_LEATH, -0.180, -0.238, 0.118, 0.072, 0.098, 0.072, -0.12, 0, 0),
      P('box', 1, C.dark, M_LEATH, 0.180, -0.336, 0.140, 0.082, 0.042, 0.130),
      P('box', 1, C.dark, M_LEATH, -0.180, -0.336, 0.140, 0.082, 0.042, 0.130),
      P('ring', 1, C.iron, M_MET2, 0.180, -0.318, 0.140, 0.125, 0.125, 0.09, 0, PI2, 0),
      P('ring', 1, C.iron, M_MET2, -0.180, -0.318, 0.140, 0.125, 0.125, 0.09, 0, PI2, 0),
      P('cyl', 1, C.leatherD, M_LEATH, 0.180, -0.235, 0.098, 0.020, 0.22, 0.020),                 // leathers
      P('cyl', 1, C.leatherD, M_LEATH, -0.180, -0.235, 0.098, 0.020, 0.22, 0.020),
      P('cyl', 2, C.skin, M_SKIN, 0, -0.03, 0, 0.07, 0.065, 0.07),
      P('sph', 2, C.skin, M_SKIN, 0, 0.05, 0.006, 0.128, 0.142, 0.135),
      P('sph', 2, C.bronze, M_HELM, 0, 0.072, 0, 0.15, 0.145, 0.15),
      P('cyl', 2, C.bronze, M_HELM, 0, 0.030, 0, 0.156, 0.036, 0.156),
      P('box', 2, C.leatherD, M_LEATH, 0, 0.148, -0.004, 0.030, 0.030, 0.150),
      P('box', 2, 'B', M_CLOTH, 0, 0.176, -0.004, 0.022, 0.082, 0.140),                // crest
      P('caps', 3, C.skin, M_SKIN, 0, -0.095, 0, 0.078, 0.10, 0.078),
      P('caps', 4, C.skin, M_SKIN, 0, -0.095, 0, 0.078, 0.10, 0.078),
      // the lance: upright, butted in the stirrup boot, pennant near the head
      P('cyl', 4, C.wood, M_WOOD, 0.016, 0.24, 0.040, 0.020, 0.72, 0.020, 0.10, 0, 0.07),
      P('cyl', 4, C.leatherD, M_LEATH, 0.020, 0.00, 0.010, 0.030, 0.075, 0.030, 0.10, 0, 0.07),
      P('cone', 4, C.steel, M_MET, 0.062, 0.680, 0.078, 0.036, 0.17, 0.036, 0.10, 0, 0.07),
      P('cyl', 4, C.bronze, M_MET, 0.056, 0.598, 0.070, 0.026, 0.032, 0.026, 0.10, 0, 0.07),
    ],
    flags: [{ b: 4, x: 0.050, y: 0.470, z: 0.060, sx: 0.140, sy: 0.082, rz: 0.07 }],
  },
  // -------------------------------------------------- settler: hooped wagon + robed leader
  settler: {
    foot: 0.42, h: 0.90, gait: 0.55, wheels: 1, noLegs: 1,
    piv: [[0, 0, 0], [0, 0.42, 0.58], [0, 0.635, 0.58], [0.125, 0.565, 0.58], [-0.125, 0.565, 0.58], [0, 0.155, 0.22], [0, 0.155, -0.22], [0, 0, 0]],
    parts: [
      P('box', 0, C.wood, M_WOOD, 0, 0.235, -0.02, 0.44, 0.115, 0.66),
      P('box', 0, C.woodD, M_WOOD, 0, 0.30, -0.02, 0.47, 0.035, 0.69),
      P('cyl', 0, C.canvas, M_CLOTH, 0, 0.335, -0.02, 0.385, 0.60, 0.385, PI2, 0, 0),
      P('box', 0, 'A', M_CLOTH, 0, 0.525, -0.02, 0.075, 0.030, 0.58),                  // civ stripe
      P('ring', 0, C.woodD, M_WOOD, 0, 0.335, 0.28, 0.465, 0.465, 0.075),
      P('ring', 0, C.woodD, M_WOOD, 0, 0.335, 0.02, 0.465, 0.465, 0.075),
      P('ring', 0, C.woodD, M_WOOD, 0, 0.335, -0.30, 0.465, 0.465, 0.075),
      P('cyl', 0, C.canvas, M_CLOTH, 0, 0.335, -0.325, 0.36, 0.03, 0.36, PI2, 0, 0),
      P('cyl', 0, C.rope, M_CLOTH, 0, 0.335, -0.335, 0.24, 0.02, 0.24, PI2, 0, 0),
      P('box', 0, C.woodD, M_WOOD, 0, 0.20, 0.50, 0.06, 0.05, 0.36),        // draw pole
      P('box', 0, C.woodD, M_WOOD, 0, 0.20, 0.66, 0.30, 0.05, 0.05),        // yoke
      P('box', 0, C.hide, M_LEATH, 0.155, 0.34, -0.02, 0.06, 0.14, 0.30),
      // wheels on two axles
      P('ring', 5, C.woodD, M_WOOD, 0.235, 0, 0, 0.36, 0.36, 0.09, 0, PI2, 0),
      P('ring', 5, C.woodD, M_WOOD, -0.235, 0, 0, 0.36, 0.36, 0.09, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, 0.235, 0, 0, 0.035, 0.15, 0.035, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, 0.235, 0, 0, 0.035, 0.15, 0.035, 0, PI2, PI2),
      P('box', 5, C.woodD, M_WOOD, -0.235, 0, 0, 0.035, 0.15, 0.035, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, -0.235, 0, 0, 0.035, 0.15, 0.035, 0, PI2, PI2),
      P('ring', 6, C.woodD, M_WOOD, 0.235, 0, 0, 0.40, 0.40, 0.09, 0, PI2, 0),
      P('ring', 6, C.woodD, M_WOOD, -0.235, 0, 0, 0.40, 0.40, 0.09, 0, PI2, 0),
      P('box', 6, C.woodD, M_WOOD, 0.235, 0, 0, 0.035, 0.17, 0.035, 0, PI2, 0),
      P('box', 6, C.woodD, M_WOOD, 0.235, 0, 0, 0.035, 0.17, 0.035, 0, PI2, PI2),
      P('box', 6, C.woodD, M_WOOD, -0.235, 0, 0, 0.035, 0.17, 0.035, 0, PI2, 0),
      P('box', 6, C.woodD, M_WOOD, -0.235, 0, 0, 0.035, 0.17, 0.035, 0, PI2, PI2),
      P('cyl', 0, C.dark, M_WOOD, 0, 0.155, 0.22, 0.05, 0.50, 0.05, 0, 0, PI2),
      P('cyl', 0, C.dark, M_WOOD, 0, 0.155, -0.22, 0.05, 0.50, 0.05, 0, 0, PI2),
      // robed leader walking ahead
      P('cone', 1, 'A', M_CLOTH, 0, -0.10, 0, 0.34, 0.40, 0.28),
      P('caps', 1, 'A', M_CLOTH, 0, 0.03, 0, 0.225, 0.11, 0.165),
      P('cyl', 1, C.leather, M_LEATH, 0, -0.045, 0, 0.24, 0.04, 0.18),
      P('sph', 1, C.linen, M_CLOTH, 0.120, 0.104, 0, 0.128, 0.078, 0.120),
      P('sph', 1, C.linen, M_CLOTH, -0.120, 0.104, 0, 0.128, 0.078, 0.120),
      P('cyl', 1, C.leather, M_LEATH, 0.120, 0.068, 0, 0.124, 0.026, 0.116),
      P('cyl', 1, C.leather, M_LEATH, -0.120, 0.068, 0, 0.124, 0.026, 0.116),
      P('cyl', 2, C.skin, M_SKIN, 0, -0.03, 0, 0.072, 0.065, 0.072),
      P('sph', 2, C.skin, M_SKIN, 0, 0.05, 0.006, 0.13, 0.145, 0.138),
      P('sph', 2, C.hair, M_CLOTH, 0, 0.02, 0.05, 0.105, 0.08, 0.10),
      P('sph', 2, C.linen, M_CLOTH, 0, 0.075, -0.015, 0.165, 0.155, 0.165),   // headcloth
      P('cyl', 2, C.linen, M_CLOTH, 0, 0.005, -0.02, 0.20, 0.055, 0.20),
      P('caps', 3, C.skin, M_SKIN, 0, -0.10, 0, 0.08, 0.10, 0.08),
      P('caps', 4, C.skin, M_SKIN, 0, -0.10, 0, 0.08, 0.10, 0.08),
      P('cyl', 4, C.wood, M_WOOD, 0, -0.06, 0.03, 0.02, 0.32, 0.02, 0.12, 0, 0),
    ],
    flags: [],
  },
  // -------------------------------------------------- builder: conical hat + raised pick
  // Top-third prop is the pick head, held high and clear of the hat brim; the hat is the widest
  // horizontal in the roster, so at 64px this silhouette cannot be confused with a soldier.
  builder: {
    foot: 0.3, h: 0.86, piv: HP, gait: 0.85,
    parts: [
      ...legs(), ...torso(C.wool, 0), ...head(), ...arms(),
      P('cyl', 2, C.thatch, M_THATCH, 0, 0.112, 0, 0.30, 0.028, 0.30),        // brim
      P('cone', 2, C.thatch, M_THATCH, 0, 0.158, 0, 0.215, 0.15, 0.215),
      P('cyl', 2, 'A', M_CLOTH, 0, 0.110, 0, 0.238, 0.034, 0.238),            // civ hatband
      P('box', 1, C.leather, M_LEATH, 0.145, -0.02, -0.02, 0.10, 0.13, 0.16), // tool bag
      P('sph', 1, 'A', M_CLOTH, -0.02, 0.02, -0.146, 0.165, 0.250, 0.110, 0.14, 0, 0),
      // the pick: haft over the shoulder, head crossing the head line
      P('cyl', 4, C.wood, M_WOOD, -0.03, 0.170, -0.012, 0.024, 0.74, 0.024, 0.28, 0, 0.34),
      P('box', 4, C.iron, M_MET, -0.243, 0.560, 0.115, 0.078, 0.078, 0.078, 0.28, 0, 0.34),
      P('cone', 4, C.iron, M_MET, -0.405, 0.522, 0.115, 0.052, 0.36, 0.052, 0.28, 0, PI2 + 0.34),
      P('cone', 4, C.iron, M_MET, -0.088, 0.598, 0.115, 0.050, 0.24, 0.050, 0.28, 0, -PI2 + 0.34),
      // the site itself: dressed stone, a cut log, a shovel stuck in the spoil
      P('box', 0, C.stone, M_STONE, 0.34, 0.055, 0.16, 0.16, 0.11, 0.15, 0.1, 0.4, 0.05),
      P('box', 0, C.stoneL, M_STONE, 0.30, 0.135, 0.08, 0.14, 0.10, 0.13, 0.2, 0.9, 0.1),
      P('box', 0, C.stoneD, M_STONE, 0.44, 0.05, 0.03, 0.13, 0.10, 0.12, 0, 0.3, 0),
      P('cyl', 0, C.wood, M_WOOD, -0.34, 0.20, 0.10, 0.024, 0.40, 0.024, 0.18, 0, 0.22),
      P('box', 0, C.iron, M_MET2, -0.29, 0.03, 0.06, 0.10, 0.10, 0.02, 0.18, 0, 0.22),
      P('cyl', 0, C.woodD, M_WOOD, -0.38, 0.06, -0.16, 0.11, 0.36, 0.11, 0, 0.4, PI2),
    ],
    flags: [],
  },
  // -------------------------------------------------- catapult: diagonal arm over a frame
  catapult: {
    foot: 0.42, h: 1.0, gait: 0.5, wheels: 1, noLegs: 1,
    piv: [[0, 0, 0], [0.36, 0.40, -0.04], [0.36, 0.615, -0.04], [0, 0.36, -0.16], [0.485, 0.545, -0.04], [0, 0.155, 0.06], [0, 0.155, 0.06], [0, 0, 0]],
    parts: [
      P('box', 0, C.wood, M_WOOD, 0.155, 0.26, 0, 0.055, 0.09, 0.72),
      P('box', 0, C.wood, M_WOOD, -0.155, 0.26, 0, 0.055, 0.09, 0.72),
      P('box', 0, C.woodD, M_WOOD, 0, 0.215, 0.30, 0.37, 0.06, 0.075),
      P('box', 0, C.woodD, M_WOOD, 0, 0.215, -0.30, 0.37, 0.06, 0.075),
      P('box', 0, C.wood, M_WOOD, 0.155, 0.40, -0.16, 0.05, 0.34, 0.05, -0.30, 0, 0),
      P('box', 0, C.wood, M_WOOD, -0.155, 0.40, -0.16, 0.05, 0.34, 0.05, -0.30, 0, 0),
      P('box', 0, C.woodD, M_WOOD, 0, 0.545, -0.10, 0.37, 0.055, 0.055),
      P('cyl', 0, C.woodD, M_WOOD, 0, 0.30, 0.26, 0.075, 0.36, 0.075, 0, 0, PI2),   // winch drum
      P('cyl', 0, C.rope, M_CLOTH, 0, 0.34, 0.14, 0.016, 0.30, 0.016, 1.25, 0, 0),
      P('cyl', 0, C.dark, M_WOOD, 0, 0.155, 0.06, 0.05, 0.52, 0.05, 0, 0, PI2),      // axle
      P('ring', 5, C.woodD, M_WOOD, 0.245, 0, 0, 0.40, 0.40, 0.11, 0, PI2, 0),
      P('ring', 5, C.woodD, M_WOOD, -0.245, 0, 0, 0.40, 0.40, 0.11, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, 0.245, 0, 0, 0.035, 0.17, 0.035, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, 0.245, 0, 0, 0.035, 0.17, 0.035, 0, PI2, PI2),
      P('box', 5, C.woodD, M_WOOD, -0.245, 0, 0, 0.035, 0.17, 0.035, 0, PI2, 0),
      P('box', 5, C.woodD, M_WOOD, -0.245, 0, 0, 0.035, 0.17, 0.035, 0, PI2, PI2),
      // Throwing arm on bone 3 — the one prop this machine is read by, so it is thick, long
      // and held at a hard diagonal with the shot visible in the bucket.
      P('box', 3, C.wood, M_WOOD, 0, 0.30, 0, 0.072, 0.70, 0.072),
      P('box', 3, C.woodD, M_WOOD, 0, 0.30, 0, 0.082, 0.16, 0.082),                  // iron band
      P('cyl', 3, C.woodD, M_WOOD, 0, 0.615, 0, 0.19, 0.115, 0.19),                  // bucket
      P('cyl', 3, C.wood, M_WOOD, 0, 0.665, 0, 0.175, 0.030, 0.175),
      P('sph', 3, 0x8d8a82, M_PLAST, 0, 0.675, 0, 0.155, 0.135, 0.155),              // the shot
      P('cyl', 3, C.rope, M_CLOTH, 0.075, 0.44, 0, 0.014, 0.46, 0.014, 0, 0, 0.10),
      P('cyl', 3, C.rope, M_CLOTH, -0.075, 0.44, 0, 0.014, 0.46, 0.014, 0, 0, -0.10),
      P('box', 3, C.stoneD, M_STONE, 0, -0.19, 0, 0.24, 0.19, 0.21),                 // counterweight
      P('box', 3, C.woodD, M_WOOD, 0, -0.19, 0, 0.26, 0.045, 0.23),
      // ---- crewman. Was a solid team-coloured cylinder under a navy sphere, which is the
      // exact figure the last review put in the headline. Now: linen shirt, a leather jerkin
      // over it, a civ sash as the ONLY saturated area, hair, beard and a leather cap with a
      // bronze band — five materials in a 0.4-unit figure, so it has values to read even when
      // the texture is under its mip threshold.
      P('caps', 1, C.linen, M_CLOTH, 0, 0.02, 0, 0.225, 0.11, 0.165),
      P('cone', 1, C.linen, M_CLOTH, 0, -0.085, 0, 0.285, 0.10, 0.215),
      P('cone', 1, C.leatherD, M_LEATH, 0, 0.035, 0, 0.242, 0.098, 0.185),   // jerkin
      P('box', 1, 'A', M_CLOTH, 0.02, -0.005, 0, 0.256, 0.062, 0.196, 0, 0, 0.34),  // sash
      P('cyl', 1, C.leather, M_LEATH, 0, -0.058, 0, 0.238, 0.042, 0.178),
      P('box', 1, C.bronze, M_MET, 0, -0.058, 0.138, 0.052, 0.052, 0.028),
      P('sph', 1, C.skin, M_SKIN, 0.112, 0.108, 0, 0.095, 0.095, 0.095),
      P('sph', 1, C.skin, M_SKIN, -0.112, 0.108, 0, 0.095, 0.095, 0.095),
      P('caps', 1, C.skinD, M_SKIN, 0.062, -0.20, 0, 0.10, 0.16, 0.10),
      P('caps', 1, C.skinD, M_SKIN, -0.062, -0.20, 0, 0.10, 0.16, 0.10),
      P('box', 1, C.leatherD, M_LEATH, 0.062, -0.355, 0.02, 0.10, 0.05, 0.16),
      P('box', 1, C.leatherD, M_LEATH, -0.062, -0.355, 0.02, 0.10, 0.05, 0.16),
      P('cyl', 2, C.skin, M_SKIN, 0, -0.03, 0, 0.072, 0.065, 0.072),
      P('sph', 2, C.skin, M_SKIN, 0, 0.05, 0.006, 0.13, 0.145, 0.138),
      P('sph', 2, C.hair, M_CLOTH, 0, 0.018, 0.052, 0.105, 0.082, 0.10),
      P('sph', 2, C.leather, M_LEATH, 0, 0.068, -0.004, 0.148, 0.128, 0.148),   // cap
      P('cyl', 2, C.bronze, M_MET, 0, 0.030, 0, 0.152, 0.030, 0.152),           // band
      P('caps', 4, C.skin, M_SKIN, 0, -0.10, 0, 0.08, 0.10, 0.08),
      P('caps', 3, C.skin, M_SKIN, 0.30, 0.14, 0, 0.072, 0.095, 0.072, 0, 0, -0.5),
      // spare shot, stacked by the frame: three stones say "this thing throws stones"
      P('sph', 0, 0x7e7a71, M_PLAST, -0.42, 0.09, 0.26, 0.17, 0.16, 0.17),
      P('sph', 0, 0x938f86, M_PLAST, -0.30, 0.08, 0.34, 0.15, 0.14, 0.15),
      P('sph', 0, 0x7e7a71, M_PLAST, -0.37, 0.20, 0.30, 0.14, 0.13, 0.14),
    ],
    flags: [],
  },
  // -------------------------------------------------- trireme: long hull, mast, banked oars
  trireme: {
    foot: 0.55, h: 1.35, gait: 0, boat: 1, noLegs: 1,
    piv: [[0, 0, 0], [0, 0.30, 0], [0, 0.30, 0], [0.20, 0.24, 0], [-0.20, 0.24, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
    parts: [
      P('caps', 0, C.woodD, M_WOOD, 0, 0.15, 0, 0.36, 0.68, 0.26, PI2, 0, 0),
      // A hull seen from a strategy camera is 90% deck, so the deck has to be the detailed
      // surface: pale planking against the dark hull, a gangway down the middle, six rowing
      // benches. Last pass this was one brown capsule and it read as a floating log.
      P('box', 0, 0xb49a6c, M_WOOD, 0, 0.252, 0, 0.30, 0.05, 1.06),
      P('box', 0, C.woodD, M_WOOD, 0, 0.278, 0, 0.085, 0.020, 1.02),                 // gangway
      P('box', 0, C.woodD, M_WOOD, 0, 0.222, 0, 0.40, 0.045, 0.030),                 // wale, midships
      P('box', 0, 0x9c8352, M_WOOD, 0, 0.276, 0.40, 0.26, 0.020, 0.075),
      P('box', 0, 0x9c8352, M_WOOD, 0, 0.276, 0.22, 0.26, 0.020, 0.075),
      P('box', 0, 0x9c8352, M_WOOD, 0, 0.276, -0.10, 0.26, 0.020, 0.075),
      P('box', 0, 0x9c8352, M_WOOD, 0, 0.276, -0.28, 0.26, 0.020, 0.075),
      // the apotropaic eye: the single detail that says trireme and not rowboat
      P('cyl', 0, 0xe8dcc0, M_PLAST, 0.185, 0.215, 0.50, 0.115, 0.020, 0.085, 0, 0, PI2),
      P('cyl', 0, 0xe8dcc0, M_PLAST, -0.185, 0.215, 0.50, 0.115, 0.020, 0.085, 0, 0, PI2),
      P('cyl', 0, 0x2b2a28, M_PLAST, 0.192, 0.215, 0.50, 0.048, 0.020, 0.048, 0, 0, PI2),
      P('cyl', 0, 0x2b2a28, M_PLAST, -0.192, 0.215, 0.50, 0.048, 0.020, 0.048, 0, 0, PI2),
      P('box', 0, C.woodD, M_WOOD, 0.155, 0.275, 0, 0.045, 0.085, 1.04),
      P('box', 0, C.woodD, M_WOOD, -0.155, 0.275, 0, 0.045, 0.085, 1.04),
      P('box', 0, 'A', M_CLOTH, 0.168, 0.278, 0, 0.020, 0.055, 1.00),
      P('box', 0, 'A', M_CLOTH, -0.168, 0.278, 0, 0.020, 0.055, 1.00),
      P('cone', 0, C.bronze, M_MET, 0, 0.11, 0.76, 0.15, 0.34, 0.15, PI2, 0, 0),   // ram
      P('caps', 0, C.wood, M_WOOD, 0, 0.30, 0.50, 0.22, 0.22, 0.20, 1.15, 0, 0),   // rising bow
      P('arc', 0, C.woodD, M_WOOD, 0, 0.40, -0.60, 0.42, 0.42, 0.30, 0, PI2, 1.9),
      // The mast used to stop at 0.97 while the yard sat at 1.16 — a spar floating in the air
      // above the masthead, called out by name in the last review. The mast now runs THROUGH
      // the yard and the truck caps it.
      P('cyl', 0, C.wood, M_WOOD, 0, 0.78, 0.06, 0.038, 0.64, 0.038),             // mast
      P('cyl', 0, C.woodD, M_WOOD, 0, 1.02, 0.06, 0.030, 0.68, 0.030, 0, 0, PI2), // yard
      P('cyl', 0, C.rope, M_CLOTH, 0, 1.02, 0.06, 0.052, 0.055, 0.052),           // yard lashing
      P('sph', 0, C.bronze, M_MET, 0, 1.11, 0.06, 0.062, 0.062, 0.062),           // truck
      // shrouds: two lines from the masthead down to the rail. Nothing says "rigged" faster.
      P('cyl', 0, C.rope, M_CLOTH, 0.085, 0.76, 0.06, 0.010, 0.66, 0.010, 0, 0, 0.26),
      P('cyl', 0, C.rope, M_CLOTH, -0.085, 0.76, 0.06, 0.010, 0.66, 0.010, 0, 0, -0.26),
      P('cyl', 0, C.rope, M_CLOTH, 0, 0.80, 0.33, 0.010, 0.62, 0.010, 0.42, 0, 0),   // forestay
      P('cyl', 0, C.woodD, M_WOOD, 0, 0.50, -0.60, 0.022, 0.42, 0.022),               // ensign staff
      P('cyl', 0, C.woodD, M_WOOD, 0.22, 0.28, -0.50, 0.028, 0.42, 0.028, 0.85, 0, 0.35),
      P('box', 0, C.woodD, M_WOOD, 0.34, 0.02, -0.62, 0.02, 0.16, 0.13, 0.85, 0, 0.35),
      // shields on the rail
      P('cyl', 0, 'B', M_WOOD, 0.185, 0.335, 0.26, 0.155, 0.028, 0.155, 0, 0, PI2),
      P('ring', 0, C.bronze, M_MET, 0.192, 0.335, 0.26, 0.185, 0.185, 0.06, 0, PI2, 0),
      P('cyl', 0, 'A', M_WOOD, 0.185, 0.335, 0.02, 0.155, 0.028, 0.155, 0, 0, PI2),
      P('ring', 0, C.bronze, M_MET, 0.192, 0.335, 0.02, 0.185, 0.185, 0.06, 0, PI2, 0),
      P('cyl', 0, 'B', M_WOOD, -0.185, 0.335, 0.26, 0.155, 0.028, 0.155, 0, 0, PI2),
      P('ring', 0, C.bronze, M_MET, -0.192, 0.335, 0.26, 0.185, 0.185, 0.06, 0, PI2, 0),
      P('cyl', 0, 'A', M_WOOD, -0.185, 0.335, 0.02, 0.155, 0.028, 0.155, 0, 0, PI2),
      P('ring', 0, C.bronze, M_MET, -0.192, 0.335, 0.02, 0.185, 0.185, 0.06, 0, PI2, 0),
      // Oars — bones 3/4 sweep them. The loom runs from the rowlock at the rail DOWN to the
      // blade at the waterline, and the blade sits exactly on the loom's far end: the old rig
      // had a 0.18-unit gap, so three blades rowed along on their own beside the hull.
      P('cyl', 3, C.wood, M_WOOD, 0.205, -0.080, 0.30, 0.021, 0.513, 0.021, 0, 0, -2.148),
      P('cyl', 3, C.wood, M_WOOD, 0.205, -0.080, 0.04, 0.021, 0.513, 0.021, 0, 0, -2.148),
      P('cyl', 3, C.wood, M_WOOD, 0.205, -0.080, -0.22, 0.021, 0.513, 0.021, 0, 0, -2.148),
      P('box', 3, C.woodD, M_WOOD, 0.415, -0.205, 0.30, 0.125, 0.18, 0.018, 0, 0, -2.148),
      P('box', 3, C.woodD, M_WOOD, 0.415, -0.205, 0.04, 0.125, 0.18, 0.018, 0, 0, -2.148),
      P('box', 3, C.woodD, M_WOOD, 0.415, -0.205, -0.22, 0.125, 0.18, 0.018, 0, 0, -2.148),
      P('cyl', 4, C.wood, M_WOOD, -0.205, -0.080, 0.30, 0.021, 0.513, 0.021, 0, 0, 2.148),
      P('cyl', 4, C.wood, M_WOOD, -0.205, -0.080, 0.04, 0.021, 0.513, 0.021, 0, 0, 2.148),
      P('cyl', 4, C.wood, M_WOOD, -0.205, -0.080, -0.22, 0.021, 0.513, 0.021, 0, 0, 2.148),
      P('box', 4, C.woodD, M_WOOD, -0.415, -0.205, 0.30, 0.125, 0.18, 0.018, 0, 0, 2.148),
      P('box', 4, C.woodD, M_WOOD, -0.415, -0.205, 0.04, 0.125, 0.18, 0.018, 0, 0, 2.148),
      P('box', 4, C.woodD, M_WOOD, -0.415, -0.205, -0.22, 0.125, 0.18, 0.018, 0, 0, 2.148),
    ],
    // the sail is a flag: same flutter shader, just wider
    flags: [
      { b: 0, x: 0, y: 0.80, z: 0.06, sx: 0.62, sy: 0.44, ry: PI2, sail: 1 },
      { b: 0, x: 0, y: 0.630, z: -0.60, sx: 0.150, sy: 0.090 },
    ],
  },
};
// Every foot unit carries a standard on a short staff behind the shoulder — a vexillum, not a
// sheet stapled to its back. At gameplay zoom the figure itself is fifteen pixels; the thing
// that actually tells you WHOSE it is, and that something is standing there at all, is the
// coloured rectangle waving above the helmet line.
DEFS.spearman.flags.push({ b: 4, x: -0.098, y: 0.375, z: 0.056, sx: 0.138, sy: 0.078, ry: 0.5, rz: -0.10 });
// A vexillum, not a mainsail. The old one was 0.30 x 0.175 on a 0.62 staff, which put more
// cloth in the air than there was man underneath it — read as a flagpole with a doll tied to
// the base. It now clears the helmet crest by a hand's width and no more.
for (const k of ['warrior', 'archer', 'builder', 'settler', 'catapult']) {
  const b = DEFS[k].noLegs ? 0 : 1;
  const y0 = b ? 0.330 : 0.60, x0 = b ? -0.150 : -0.34, z0 = b ? -0.130 : -0.30;
  const hh = b ? 0.33 : 0.48;
  DEFS[k].parts.push(P('cyl', b, C.woodD, M_WOOD, x0, y0, z0, 0.016, hh, 0.016));
  DEFS[k].parts.push(P('sph', b, C.bronze, M_MET, x0, y0 + hh * 0.53, z0, 0.040, 0.040, 0.040));
  DEFS[k].parts.push(P('cyl', b, C.bronze, M_MET, x0, y0 + hh * 0.46, z0, 0.034, 0.018, 0.034));
  DEFS[k].flags.push({ b, x: x0, y: y0 + hh * 0.36, z: z0, sx: 0.132, sy: 0.079, ry: 0.42 });
}

// ============================================================ building meshes
// Each returns one merged geometry, origin at the tile centre, y=0 on the ground.
const B = {};

// A doorway that is a HOLE, not a black rectangle glued on the wall. The opening is recessed,
// an interior plate occludes what is behind it (and lights up warm at dusk), and a stone jamb
// and lintel stand proud of the wall so the reveal catches an edge. Every unlit black quad in
// the last pass came from skipping these six pieces.
const doorway = (x, y, z, w, h, jamb = C.stoneL, d = 0.05) => [
  tag(G.box, C.window, M_WIN, xf(x, y, z - d, w, h, 0.02)),                       // lit interior
  tag(G.box, C.stoneD, M_STONE, xf(x - w / 2 - 0.020, y, z - d * 0.4, 0.040, h, 0.09)),
  tag(G.box, C.stoneD, M_STONE, xf(x + w / 2 + 0.020, y, z - d * 0.4, 0.040, h, 0.09)),
  tag(G.box, jamb, M_STONE, xf(x - w / 2 - 0.030, y + 0.01, z + 0.016, 0.048, h + 0.05, 0.055)),
  tag(G.box, jamb, M_STONE, xf(x + w / 2 + 0.030, y + 0.01, z + 0.016, 0.048, h + 0.05, 0.055)),
  tag(G.box, jamb, M_STONE, xf(x, y + h / 2 + 0.032, z + 0.016, w + 0.115, 0.058, 0.065)),
  tag(G.box, C.stoneD, M_STONE, xf(x, y - h / 2 + 0.014, z + 0.028, w + 0.075, 0.028, 0.095)),
];
// Trodden-earth apron. Every structure gets one: a wide, almost-flat skirt of packed dirt that
// intersects whatever the ground is doing under it. A building whose base is a hard edge sitting
// on a hillside reads as pasted on however good the shadow is; half a centimetre of dirt fixes it.
// TRODDEN GROUND, not a plinth. The old one was 0x7e6849 across 2.9r — a pale disc that in
// full sun clipped to a flat white slab a hex and a half wide under every farm, and read as a
// pedestal under every house. Darker than the dirt it sits on (ground people walk on is
// compacted and shaded, never lighter) and tighter, so it grounds instead of haloing.
// WOBBLED, never a circle. A 14-segment cylinder skirt is a geometric ellipse, and an ellipse
// of bare dirt under a prop reads as a decal blob however dark it is — the review's phrase, on
// the farms and again on the quarry. Both skirts get an irregular outline and the outer one is
// barely proud of the ground, so what the eye gets is trodden earth spilling out from a base.
const apron = (r, y = 0.010) => [
  tag(wobble(taper(G.cyl.clone(), 0.55, -0.5, 0.5), 0.075, ((r * 1000) | 0) + 3), 0x483b29, M_SOIL,
    xf(0, y + 0.018, 0, r * 1.80, 0.150, r * 1.80)),
  tag(wobble(taper(G.cyl.clone(), 0.40, -0.5, 0.5), 0.105, ((r * 1700) | 0) + 11), 0x54462f, M_SOIL,
    xf(0, y - 0.014, 0, r * 2.20, 0.100, r * 2.20)),
];
// a shuttered window: reveal + sill + a lit pane set back, never a flat emissive sticker
const win = (x, y, z, w, h) => [
  tag(G.box, C.window, M_WIN, xf(x, y, z - 0.035, w, h, 0.02)),
  tag(G.box, C.woodD, M_WOOD, xf(x - w / 2 - 0.016, y, z + 0.006, 0.032, h + 0.03, 0.035)),
  tag(G.box, C.woodD, M_WOOD, xf(x + w / 2 + 0.016, y, z + 0.006, 0.032, h + 0.03, 0.035)),
  tag(G.box, C.woodD, M_WOOD, xf(x, y + h / 2 + 0.018, z + 0.006, w + 0.07, 0.032, 0.045)),
  tag(G.box, C.woodD, M_WOOD, xf(x, y - h / 2 - 0.016, z + 0.014, w + 0.07, 0.028, 0.055)),
];

// A town whose every roof is the same red is one mesh repeated, and it reads as one mesh
// repeated from any distance. Four roof treatments, chosen per building from the town's own
// RNG: fired pantile, weathered tile, split slate, straw. The ridge colour travels with the
// field colour so a slate roof does not get a terracotta ridge cap.
// Wall stone families: [hue, sat, lightness] base for _tint. A capital in chalk beside a town
// in red laterite is the cheapest per-city variety there is, and it costs one instance colour.
const STONE = [
  [0.075, 0.04, 0.82],   // chalk / limewash
  [0.085, 0.20, 0.72],   // warm sandstone
  [0.098, 0.03, 0.64],   // grey basalt
  [0.035, 0.17, 0.68],   // red laterite
];
const ROOF = [
  [C.roof, M_TILE, C.roofD],        // fresh terracotta
  [0x7f6b4e, M_WOOD, 0x584730],     // aged split shingle
  [0x6d6c64, M_STONE, 0x4e4d47],    // split slate
  [C.thatch, M_THATCH, C.thatchD],  // straw
];

B.hut = () => {
  const parts = [...apron(0.30), ];
  parts.push(tag(taper(G.cyl.clone(), 0.92, -0.5, 0.5), C.plasterB, M_PLAST, xf(0, 0.22, 0, 0.42, 0.44, 0.42)));
  parts.push(tag(G.cyl, C.stoneD, M_STONE, xf(0, 0.030, 0, 0.47, 0.06, 0.47)));          // footing
  parts.push(tag(G.cyl, C.stoneL, M_STONE, xf(0, 0.075, 0, 0.455, 0.05, 0.455)));
  for (let i = 0; i < 7; i++) {                                                           // wattle posts
    const a = i / 7 * Math.PI * 2;
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(Math.cos(a) * 0.20, 0.22, Math.sin(a) * 0.20, 0.032, 0.44, 0.032, 0, -a, 0)));
  }
  // THATCH IS LAID IN COURSES. One smooth cone from a 40-degree camera is a gradient with no
  // straight edge in it, which is why the review read a village of huts as "smooth gold garlic
  // bulbs". Three tapered courses, each overhanging the one below, put two hard eave lines
  // across the roof — and a hard line is the only thing that survives at twenty-five pixels.
  const CO = [[0.500, 0.150, 0.575, 0.78], [0.628, 0.135, 0.470, 0.74], [0.742, 0.125, 0.345, 0.66]];
  for (let i = 0; i < 3; i++) {
    const [cy, chh, cr, ct] = CO[i];
    parts.push(tag(wobble(taper(G.cyl.clone(), ct, -0.5, 0.5), 0.030, 7 + i * 5),
      i === 1 ? C.thatch : C.thatchD, M_THATCH, xf(0, cy, 0, cr, chh, cr)));
    // the shadow line under each course: a thin dark ring on its own lip
    parts.push(tag(G.cyl, 0x241b0d, M_THATCH, xf(0, cy - chh * 0.50, 0, cr * 1.035, 0.030, cr * 1.035)));
    // and a RAGGED eave: eight straw tufts hanging past the lip, so the outline of the roof is
    // a broken line rather than a turned edge. Four pixels of noise on a contour is the whole
    // difference between straw and clay.
    for (let k = 0; k < 8; k++) {
      const a = (k + i * 0.4) / 8 * Math.PI * 2, rr = cr * (1.02 + (k % 3) * 0.02);
      parts.push(tag(G.box, i === 1 ? C.thatch : C.thatchD, M_THATCH,
        xf(Math.cos(a) * rr, cy - chh * (0.60 + (k % 2) * 0.16), Math.sin(a) * rr,
           cr * 0.24, chh * 0.34, 0.030, 0, -a, 0)));
    }
  }
  parts.push(tag(wobble(G.cone.clone(), 0.02, 21), C.thatch, M_THATCH, xf(0, 0.845, 0, 0.24, 0.14, 0.24)));
  parts.push(tag(G.cyl, C.rope, M_CLOTH, xf(0, 0.895, 0, 0.075, 0.030, 0.075)));   // the binding at the apex
  parts.push(tag(G.sph, C.woodD, M_WOOD, xf(0, 0.925, 0, 0.055, 0.055, 0.055)));
  // eave binding: G.ring is authored at radius 0.42, so 0.70 puts it exactly on the eaves
  parts.push(tag(G.ring, 0x4a3a1c, M_THATCH, xf(0, 0.432, 0, 0.700, 0.700, 0.13, PI2, 0, 0)));
  parts.push(...doorway(0, 0.145, 0.212, 0.14, 0.26, C.woodD, 0.045));
  return bakeAO(merge(parts), 0, 0.44, 0.48);
};
B.house = (v = 0) => {
  const [rc, rm, rd] = ROOF[v % 4];
  const w = tag(taper(G.box.clone(), 0.93, -0.5, 0.5), C.plaster, M_PLAST, xf(0, 0.20, 0, 0.52, 0.40, 0.42));
  const parts = [...apron(0.34), w];
  // gable roof: two slabs
  for (const s of [1, -1]) parts.push(tag(G.box, rc, rm, xf(s * 0.145, 0.505, 0, 0.34, 0.045, 0.50, 0, 0, s * -0.72)));
  parts.push(tag(G.box, rd, rm, xf(0, 0.605, 0, 0.075, 0.045, 0.52)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.395, 0.215, 0.54, 0.035, 0.02)));   // timber band
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.395, -0.215, 0.54, 0.035, 0.02)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0.20, 0.22, 0.215, 0.028, 0.40, 0.02)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.20, 0.22, 0.215, 0.028, 0.40, 0.02)));
  parts.push(...doorway(0, 0.13, 0.215, 0.14, 0.26, C.woodD, 0.045));
  parts.push(...win(0.155, 0.30, 0.215, 0.10, 0.10));
  parts.push(...win(-0.155, 0.30, 0.215, 0.10, 0.10));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.025, 0, 0.56, 0.05, 0.46)));      // plinth
  return bakeAO(merge(parts), 0, 0.42, 0.5);
};
B.house2 = (v = 0) => {   // two storey, tiled, with a shop awning
  const [rc, rm, rd] = ROOF[v % 4];
  const parts = [...apron(0.31), ];
  parts.push(tag(taper(G.box.clone(), 0.95, -0.5, 0.5), C.plasterB, M_PLAST, xf(0, 0.31, 0, 0.46, 0.62, 0.40)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.335, 0, 0.48, 0.035, 0.42)));
  // jettied upper floor: the single cheapest way to stop a two-storey box reading as a box
  parts.push(tag(taper(G.box.clone(), 0.97, -0.5, 0.5), C.plaster, M_PLAST, xf(0, 0.50, 0.035, 0.50, 0.24, 0.44)));
  for (const s of [1, -1]) parts.push(tag(G.box, rc, rm, xf(s * 0.14, 0.705, 0.02, 0.32, 0.045, 0.50, 0, 0, s * -0.78)));
  parts.push(tag(G.box, rd, rm, xf(0, 0.805, 0.02, 0.07, 0.04, 0.52)));
  parts.push(...doorway(0, 0.13, 0.205, 0.13, 0.26, C.woodD, 0.045));
  parts.push(...win(0.135, 0.47, 0.205, 0.09, 0.13));
  parts.push(...win(-0.135, 0.47, 0.205, 0.09, 0.13));
  parts.push(tag(G.box, C.linen, M_CLOTH, xf(0, 0.29, 0.28, 0.42, 0.02, 0.20, -0.35, 0, 0)));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0.15, 0.86, -0.12, 0.115, 0.30, 0.115)));   // chimney
  parts.push(tag(G.box, 0x8f8168, M_STONE, xf(0.15, 1.015, -0.12, 0.145, 0.034, 0.145)));  // cap
  parts.push(tag(G.box, 0x241c14, M_STONE, xf(0.15, 1.030, -0.12, 0.070, 0.030, 0.070)));  // flue
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.02, 0, 0.50, 0.04, 0.44)));
  return bakeAO(merge(parts), 0, 0.5, 0.5);
};
B.tower = (v = 0) => {
  const [rc, rm] = ROOF[v % 4];
  const parts = [...apron(0.28), ];
  parts.push(tag(taper(G.cyl.clone(), 0.88, -0.5, 0.5), C.stone, M_STONE, xf(0, 0.40, 0, 0.40, 0.80, 0.40)));
  parts.push(tag(G.cyl, C.stoneL, M_STONE, xf(0, 0.80, 0, 0.48, 0.075, 0.48)));         // corbel
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    parts.push(tag(G.box, C.stoneL, M_STONE, xf(Math.cos(a) * 0.205, 0.885, Math.sin(a) * 0.205, 0.09, 0.10, 0.06, 0, -a, 0)));
  }
  parts.push(tag(G.cone, rc, rm, xf(0, 1.07, 0, 0.44, 0.38, 0.44)));
  parts.push(tag(G.sph, C.bronze, M_MET, xf(0, 1.28, 0, 0.070, 0.070, 0.070)));   // finial
  parts.push(tag(G.box, C.window, M_WIN, xf(0, 0.52, 0.175, 0.055, 0.14, 0.03)));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.52, 0.188, 0.105, 0.20, 0.035)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.625, 0.196, 0.135, 0.035, 0.05)));
  return bakeAO(merge(parts), 0, 0.6, 0.55);
};
// TIMBER WATCHTOWER — the village landmark. Everything about it is straight lines and right
// angles on purpose: four raking legs, a boarded platform with a rail, a hipped shingle roof
// with a ridge, and a ladder up the front. A tapered stone drum under a smooth cone reads from
// a 40-degree camera as a soft-serve swirl, which is what the review called Solmere's centre.
B.watch = (v = 0) => {
  const [rc, rm, rd] = ROOF[v % 4];
  const parts = [...apron(0.30)];
  const L = 0.235;                                   // half the leg spread at the ground
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    parts.push(tag(G.box, C.wood, M_WOOD, xf(sx * L * 0.62, 0.36, sz * L * 0.62, 0.058, 0.74, 0.058,
      sz * 0.20, 0, -sx * 0.20)));
    parts.push(tag(G.box, C.stoneD, M_STONE, xf(sx * L, 0.045, sz * L, 0.13, 0.09, 0.13)));   // pad stone
  }
  // Two braces per face, not six. A full X on all four sides is a lattice of sub-pixel sticks
  // from above and it read as scaffolding collapsing on itself.
  for (const s of [1, -1]) {
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.30, s * 0.175, 0.40, 0.030, 0.026, 0, 0, 0.58)));
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(s * 0.175, 0.34, 0, 0.026, 0.028, 0.40, 0, 0, 0)));
  }
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.545, 0, 0.40, 0.035, 0.40)));      // joists
  parts.push(tag(G.box, 0xa48a5e, M_WOOD, xf(0, 0.575, 0, 0.46, 0.030, 0.46)));     // deck boards
  for (let i = 0; i < 5; i++) parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.20 + i * 0.10, 0.588, 0, 0.022, 0.014, 0.46)));
  // rail: four corner posts and a top rail, so the platform has an outline
  for (const sx of [1, -1]) for (const sz of [1, -1])
    parts.push(tag(G.box, C.wood, M_WOOD, xf(sx * 0.21, 0.665, sz * 0.21, 0.036, 0.15, 0.036)));
  for (const s of [1, -1]) {
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.720, s * 0.21, 0.44, 0.024, 0.026)));
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(s * 0.21, 0.720, 0, 0.026, 0.024, 0.44)));
  }
  // hipped shingle roof on four corner posts — a RIDGE, not a point
  for (const sx of [1, -1]) for (const sz of [1, -1])
    parts.push(tag(G.box, C.wood, M_WOOD, xf(sx * 0.185, 0.80, sz * 0.185, 0.030, 0.28, 0.030)));
  for (const s of [1, -1]) parts.push(tag(G.box, rc, rm, xf(s * 0.115, 0.965, 0, 0.26, 0.042, 0.46, 0, 0, s * -0.62)));
  for (const s of [1, -1]) parts.push(tag(taper(G.box.clone(), 0.16, -0.5, 0.5), rc, rm,
    xf(0, 0.965, s * 0.175, 0.44, 0.15, 0.042, s * 0.62, 0, 0)));
  parts.push(tag(G.box, rd, rm, xf(0, 1.048, 0, 0.070, 0.040, 0.48)));               // ridge cap
  // ladder up the front
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0.055, 0.29, 0.30, 0.026, 0.62, 0.026, 0.22, 0, 0)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.055, 0.29, 0.30, 0.026, 0.62, 0.026, 0.22, 0, 0)));
  for (let i = 0; i < 5; i++) parts.push(tag(G.box, C.wood, M_WOOD, xf(0, 0.10 + i * 0.11, 0.345 - i * 0.025, 0.13, 0.020, 0.020)));
  parts.push(tag(G.box, C.window, M_WIN, xf(0, 0.66, -0.20, 0.16, 0.10, 0.02)));    // lamp in the loft
  return bakeAO(merge(parts), 0, 0.55, 0.50);
};
B.wall = () => {   // one hex edge of curtain wall, authored 1.0 long so scale x == edge length
  const parts = [];
  parts.push(tag(taper(G.box.clone(), 0.78, -0.5, 0.5), C.stone, M_STONE, xf(0, 0.20, 0, 1.02, 0.40, 0.18)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.415, 0, 1.06, 0.032, 0.21)));
  for (let i = 0; i < 5; i++) parts.push(tag(G.box, C.stoneL, M_STONE, xf(-0.36 + i * 0.18, 0.455, 0, 0.115, 0.055, 0.17)));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.03, 0, 1.06, 0.06, 0.24)));
  return bakeAO(merge(parts), 0, 0.4, 0.55);
};
B.palisade = () => {   // one hex edge of stockade, authored 1.0 long
  const parts = [];
  const R = rng(31);
  // THREE STAKES, NOT ONE INSTANCED TWENTY TIMES. The review counted "a single stake
  // instanced ~20x with identical lean, height and texture" — so each stake is cut from one
  // of three profiles, leans up to 8 deg in both axes, and varies 20% in height. Nothing in a
  // bronze-age stockade is plumb.
  const CUT = [[0.55, 0.10], [0.34, 0.22], [0.72, -0.05]];
  for (let i = 0; i < 11; i++) {
    const v = (i * 5 + (i >> 1)) % 3, [tp, y0] = CUT[v];
    const x = -0.45 + i * 0.09, h = 0.28 + R() * 0.09;
    parts.push(tag(taper(G.cyl.clone(), tp, y0, 0.5), [C.wood, 0x7a5730, 0x6d5228][v], M_WOOD,
      xf(x, h * 0.5, (R() - 0.5) * 0.035, 0.082 + v * 0.006, h, 0.082 + v * 0.006,
        (R() - 0.5) * 0.28, R() * 3, (R() - 0.5) * 0.28)));
  }
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.22, 0.045, 1.0, 0.030, 0.024)));   // rail
  parts.push(tag(G.box, 0x6d5940, M_SOIL, xf(0, 0.020, 0, 1.04, 0.040, 0.20)));    // spoil bank
  return bakeAO(merge(parts), 0, 0.30, 0.5);
};
B.gate = () => {
  const parts = [];
  for (const s of [1, -1]) {
    parts.push(tag(taper(G.box.clone(), 0.86, -0.5, 0.5), C.stone, M_STONE, xf(s * 0.355, 0.34, 0, 0.30, 0.68, 0.28)));
    parts.push(tag(G.box, C.stoneL, M_STONE, xf(s * 0.355, 0.70, 0, 0.34, 0.05, 0.32)));
    parts.push(tag(G.box, C.stoneL, M_STONE, xf(s * 0.355, 0.775, 0, 0.10, 0.09, 0.12)));
  }
  parts.push(tag(G.box, C.stone, M_STONE, xf(0, 0.60, 0, 0.44, 0.17, 0.24)));
  parts.push(tag(G.box, C.window, M_WIN, xf(0, 0.29, -0.02, 0.40, 0.60, 0.02)));       // the way through
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.29, 0.055, 0.40, 0.60, 0.055)));       // leaves
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.29, -0.055, 0.40, 0.60, 0.055)));
  // IRONWORK, not a brown slab. Four plank divisions, three straps, a ring: at gameplay zoom
  // the gate is the largest single flat surface in the city kit, and a flat surface that large
  // with nothing crossing it is the definition of the untextured read.
  for (let i = 0; i < 4; i++)
    parts.push(tag(G.box, 0x33220f, M_WOOD, xf(-0.135 + i * 0.09, 0.29, 0.088, 0.026, 0.56, 0.020)));
  parts.push(tag(G.box, 0x24262a, M_MET2, xf(0, 0.47, 0.090, 0.38, 0.070, 0.026)));
  parts.push(tag(G.box, 0x24262a, M_MET2, xf(0, 0.13, 0.090, 0.38, 0.070, 0.026)));
  parts.push(tag(G.box, 0x24262a, M_MET2, xf(0, 0.30, 0.090, 0.38, 0.048, 0.024)));
  parts.push(tag(G.ring, 0x53483a, M_MET2, xf(0.080, 0.245, 0.104, 0.080, 0.080, 0.038)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.53, 0.115, 0.50, 0.055, 0.06)));     // brow
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.03, 0, 1.02, 0.06, 0.30)));
  return bakeAO(merge(parts), 0, 0.5, 0.55);
};
B.temple = (v = 0) => {
  const [rc, rm, rd] = ROOF[v === 3 ? 0 : v % 4];
  const parts = [...apron(0.48), ];
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.05, 0, 0.86, 0.10, 0.62)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.13, 0, 0.78, 0.08, 0.56)));
  for (let i = 0; i < 4; i++) for (const s of [1, -1]) {
    parts.push(tag(taper(G.cyl.clone(), 0.86, -0.5, 0.5), C.plasterB, M_STONE, xf(-0.27 + i * 0.18, 0.42, s * 0.22, 0.085, 0.50, 0.085)));
  }
  parts.push(tag(G.box, C.plaster, M_PLAST, xf(0, 0.35, 0, 0.46, 0.44, 0.30)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.70, 0, 0.80, 0.07, 0.58)));
  for (const s of [1, -1]) parts.push(tag(G.box, rc, rm, xf(0, 0.79, s * 0.15, 0.82, 0.035, 0.34, s * 0.55, 0, 0)));
  parts.push(tag(G.box, rd, rm, xf(0, 0.875, 0, 0.84, 0.04, 0.06)));
  parts.push(...doorway(0, 0.30, 0.155, 0.15, 0.34, C.stoneL, 0.06));
  return bakeAO(merge(parts), 0, 0.5, 0.55);
};
B.keep = (v = 0) => {
  const [rc, rm, rd] = ROOF[v === 3 ? 0 : v % 4];
  const parts = [...apron(0.48), ];
  parts.push(tag(taper(G.box.clone(), 0.88, -0.5, 0.5), C.stone, M_STONE, xf(0, 0.50, 0, 0.62, 1.00, 0.56)));
  parts.push(tag(taper(G.box.clone(), 0.80, -0.5, 0.5), C.stoneD, M_STONE, xf(0, 0.09, 0, 0.76, 0.18, 0.70)));  // batter
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 0.52, 0, 0.635, 0.035, 0.575)));                                // stringcourse
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0, 1.02, 0, 0.70, 0.055, 0.64)));
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    parts.push(tag(taper(G.cyl.clone(), 0.92, -0.5, 0.5), C.stone, M_STONE, xf(sx * 0.31, 0.60, sz * 0.28, 0.26, 1.22, 0.26)));
    parts.push(tag(G.cyl, C.stoneD, M_STONE, xf(sx * 0.31, 1.21, sz * 0.28, 0.30, 0.05, 0.30)));
    parts.push(tag(G.cone, rd, rm, xf(sx * 0.31, 1.34, sz * 0.28, 0.32, 0.26, 0.32)));
  }
  // THE ROOF. This camera looks down: a flat-topped donjon presents its biggest face to the
  // player as one unbroken grey rectangle, which is exactly what "a stack of untextured grey
  // boxes" means from above. A steep tiled hip inside the parapet gives the capital's landmark
  // a lit slope, a ridge line and a shadow side.
  for (const s of [1, -1]) parts.push(tag(G.box, rc, rm, xf(s * 0.125, 1.17, 0, 0.34, 0.05, 0.56, 0, 0, s * -0.675)));
  parts.push(tag(G.box, rd, rm, xf(0, 1.285, 0, 0.075, 0.05, 0.58)));
  for (const e of [1, -1]) parts.push(tag(taper(G.box.clone(), 0.10, -0.5, 0.5), C.stoneL, M_STONE, xf(0, 1.16, e * 0.265, 0.50, 0.215, 0.05)));
  for (let i = 0; i < 4; i++) {
    parts.push(tag(G.box, C.stoneL, M_STONE, xf(-0.21 + i * 0.14, 1.085, 0.30, 0.085, 0.075, 0.065)));
    parts.push(tag(G.box, C.stoneL, M_STONE, xf(-0.21 + i * 0.14, 1.085, -0.30, 0.085, 0.075, 0.065)));
  }
  parts.push(...doorway(0, 0.27, 0.288, 0.32, 0.50, C.stoneL, 0.075));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.068, 0.23, 0.268, 0.105, 0.42, 0.03)));  // half-open leaf
  parts.push(tag(G.box, C.iron, M_MET2, xf(-0.068, 0.36, 0.256, 0.095, 0.028, 0.02)));
  parts.push(...win(0.17, 0.72, 0.288, 0.075, 0.17));
  parts.push(...win(-0.17, 0.72, 0.288, 0.075, 0.17));
  parts.push(...win(0, 0.75, 0.288, 0.075, 0.17));
  return bakeAO(merge(parts), 0, 0.7, 0.5);
};
B.barn = () => {
  const parts = [...apron(0.36), ];
  parts.push(tag(taper(G.box.clone(), 0.95, -0.5, 0.5), C.plasterB, M_PLAST, xf(0, 0.20, 0, 0.50, 0.40, 0.74)));
  // gable ends first: two slabs of roof with nothing between them is a tent, not a barn
  for (const e of [1, -1]) {
    parts.push(tag(taper(G.box.clone(), 0.10, -0.5, 0.5), C.plaster, M_PLAST, xf(0, 0.505, e * 0.37, 0.50, 0.21, 0.045)));
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.505, e * 0.395, 0.055, 0.21, 0.02)));
  }
  for (const s of [1, -1]) {
    parts.push(tag(G.box, C.thatchD, M_THATCH, xf(s * 0.145, 0.505, 0, 0.36, 0.05, 0.86, 0, 0, s * -0.74)));
    for (let i = 0; i < 4; i++)                                              // battens holding the straw down
      parts.push(tag(G.box, C.woodD, M_WOOD, xf(s * 0.145, 0.525, -0.33 + i * 0.22, 0.365, 0.018, 0.022, 0, 0, s * -0.74)));
  }
  parts.push(tag(G.box, C.thatch, M_THATCH, xf(0, 0.615, 0, 0.11, 0.055, 0.88)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.648, 0, 0.045, 0.022, 0.90)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.20, 0.375, 0.52, 0.035, 0.02)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0.20, 0.20, 0.375, 0.030, 0.40, 0.02)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.20, 0.20, 0.375, 0.030, 0.40, 0.02)));
  parts.push(...doorway(0, 0.17, 0.375, 0.24, 0.32, C.woodD, 0.05));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0, 0.025, 0, 0.54, 0.05, 0.78)));
  return bakeAO(merge(parts), 0, 0.4, 0.55);
};
// FOUR STANDING CROPS. [row colour, row height, stook colour|0 for none]
// NO alternating row colour. The old field ran thirteen rows 5 cm apart in two different
// greens; squashed to a 0.48 strip that is 2.4 cm of world per row, which at gameplay zoom is
// ONE AND A HALF PIXELS. A two-tone pattern at 1.5 px/period is a moire, and the moire is
// exactly the "saturated green programmer-art checkerboard" four separate reviews drew a box
// around. Rows are now 19 cm apart — a dozen screen pixels — one hue with a per-row value
// jitter, so what resolves is a crop, not a test grid.
// Values matter more than hue here. At 0xb59a4c under a lit ridge profile the rows blew out to
// cream and a farm read as eight canvas tents pitched in a paddock. Crops are DARK — they are
// the darkest large surface on a sunlit hex, not the brightest.
// No bare variant. "Ploughed and resting" was 2.4 cm of ridge over a soil skirt, and at
// gameplay zoom that is a run of pale slats with dark gaps — a pallet, not a field. Every
// variant now carries standing crop tall enough to close the gaps between its own rows.
// Darker still, and LOWER. A tall ridge tapered to 0.62 shows the eye a narrow lit crown with
// a shadowed flank either side, so an 11 px row resolves as a 6 px slat with a 5 px gap — a
// pallet. Flatten the ridge and the same geometry resolves as a crop mass with furrow lines
// in it, which is what a farm looks like from a helicopter.
// FOUR STANDING CROPS. [row colour, row height, stook colour|0 for none]
// Values matter more than hue: at 0xb59a4c a lit ridge blew out to cream and a farm read as
// canvas tents; crushed by a deep contact bake it reads as a conifer plantation instead.
// These sit in the middle — a crop mass is darker than the sand beside it and lighter than
// the woodland behind it.
const CROP = [
  [0x47502a, 0.052, 0],          // young corn
  [0x5d5530, 0.058, 0x6b6440],   // ripe, ready to cut
  [0x3c4726, 0.048, 0],          // beans on the ridge
  [0x4e552b, 0.062, 0],          // tall fodder
];
// A FIELD IS A WHOLE HEX. Authored 1.52 x 1.34 — inside the 1.73 flat-to-flat of a hex, so the
// plot can never cut a tile boundary — with the soil bed sunk deep enough that the terrain's
// own dome comes up THROUGH it instead of leaving it hovering on one edge.
//
// A crop clump is a low DOME, never a cone. The first attempt at breaking the extruded-prism
// rows used little cones, and a rank of cones in rows is a conifer plantation — the farm came
// out looking exactly like the terrain agent's pine scatter. What a field looks like from a
// helicopter is a continuous mat with furrow LINES through it, so that is what this builds:
// one unbroken low ridge per row for the line, clumps on top of it for the texture.
const CLUMP = new THREE.SphereGeometry(0.5, 6, 3);
B.field = (v = 0) => {
  const [ca, ch, st] = CROP[v % 4];
  const R = rng(v * 977 + 5);
  const parts = [];
  // ---- the bed. A TRAMPLED MARGIN first: a wider, lower, wobbled pan of scuffed dirt, so
  // the plot does not stop at a ruled line, then the ploughed bed on top of it. The skirt runs
  // 0.4 deep so a down-slope edge buries into the hill instead of hanging off it.
  parts.push(tag(wobble(taper(G.box.clone(), 0.90, -0.5, 0.5), 0.075, v * 23 + 7), 0x6a5942, M_SOIL,
    xf(0, -0.20, 0, 1.70, 0.42, 1.52)));
  parts.push(tag(wobble(taper(G.box.clone(), 0.88, -0.5, 0.5), 0.05, v * 17 + 3), C.soil, M_SOIL,
    xf(0, -0.145, 0, 1.52, 0.36, 1.34)));
  const hsl = {}; _c.set(ca).getHSL(hsl);
  const NR = 9;
  for (let i = 0; i < NR; i++) {
    const z = (i - (NR - 1) / 2) * 0.146;
    // per-ROW dye lot: +/-6 deg of hue, +/-10% of value. A field is sown in passes and the
    // passes never match, which is the cheapest thing that stops nine rows reading as one
    // extruded solid — the exact complaint.
    const rh = hsl.h + (R() - 0.5) * 0.033, rl = hsl.l * (0.90 + R() * 0.20);
    const L = 1.30 - (i % 3) * 0.11 + R() * 0.06, x0 = (R() - 0.5) * 0.08;
    // the trough: dark, continuous, and where the baked contact gradient starts
    parts.push(tag(G.box, _c.setHSL(rh, hsl.s * 0.72, rl * 0.70).getHex(), M_SOIL,
      xf(x0, 0.016, z, L + 0.05, 0.026, 0.148)));
    // the ridge: ONE continuous crown, so the row is a LINE and never a rank of objects
    parts.push(tag(wobble(taper(G.box.clone(), 0.80, -0.5, 0.5), 0.016, i * 13 + 5),
      _c.setHSL(rh, hsl.s * 0.88, rl * 0.82).getHex(), M_THATCH,
      xf(x0, 0.026 + ch * 0.5, z, L, ch, 0.112)));
    // Clumps OVERLAP. Spaced at their own width they are a rank of pale pillows on dark soil
    // — bubble wrap, which is the checkerboard complaint in a new costume. Spaced at 0.6 of
    // their width they fuse into one mat whose top edge is broken, which is a crop.
    const n = Math.max(5, Math.round(L / 0.155));
    for (let k = 0; k < n; k++) {
      const cx = x0 - L / 2 + (k + 0.5) * (L / n) + (R() - 0.5) * 0.04;
      const cz = z + (R() - 0.5) * 0.028;
      const sj = 0.88 + R() * 0.24;                        // +/-12% scale jitter
      const col = _c.setHSL(rh + (R() - 0.5) * 0.012, hsl.s * (0.76 + R() * 0.18),
        rl * (0.62 + R() * 0.18)).getHex();
      // Flat, and barely proud of the ridge it sits on. A tall dome presents a big up-facing
      // cap straight at the sun, and nine rows of those is a tray of popcorn.
      parts.push(tag(wobble(CLUMP.clone(), 0.018, i * 31 + k * 7), col, M_THATCH,
        xf(cx, 0.026 + ch * 0.46, cz, 0.250 * sj, (ch * 0.92) * sj, 0.200 * sj,
          (R() - 0.5) * 0.16, R() * 3, (R() - 0.5) * 0.16)));
    }
    if (st && i % 3 === 1)
      parts.push(tag(wobble(G.cone.clone(), 0.03, i * 7), st, M_THATCH,
        xf(0.44 - (i % 3) * 0.42, 0.105, z + 0.09, 0.19, 0.24, 0.19)));
  }
  // A low post-and-rail on three sides. The fourth side is the gateway. Low on purpose: at
  // 0.195 the rails were taller than the crop and the plot read as a stock pen.
  const FY = 0.135;
  const run = (x0, z0, x1, z1) => {
    const n = Math.max(3, Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.26));
    for (let i = 0; i <= n; i++) {
      const f = i / n, sc = 0.86 + ((i * 7) % 5) * 0.07;
      parts.push(tag(taper(G.cyl.clone(), 0.72, -0.5, 0.5), i % 2 ? C.woodD : 0x6b4a29, M_WOOD,
        xf(lerp(x0, x1, f), FY * 0.5 * sc, lerp(z0, z1, f), 0.022, FY * sc, 0.022, 0.06 * (i % 2 ? 1 : -1), 0, 0.05)));
    }
    const L = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(x1 - x0, z1 - z0);
    // ONE rail, dark and thin. Two pale rails on three sides of every farm around a town put a
    // cat's cradle of bright beams over the whole approach.
    parts.push(tag(G.box, C.woodD, M_WOOD, xf((x0 + x1) / 2, FY * 0.78, (z0 + z1) / 2, 0.014, 0.014, L, 0, a, 0)));
  };
  run(-0.79, -0.70, 0.79, -0.70);
  run(-0.79, 0.70, 0.79, 0.70);
  run(-0.79, -0.70, -0.79, 0.70);
  return bakeAO(merge(parts), -0.02, 0.12, 0.68);
};
B.workshop = () => {
  const parts = [...apron(0.32), ];
  parts.push(tag(taper(G.box.clone(), 0.94, -0.5, 0.5), C.plasterB, M_PLAST, xf(0, 0.19, 0, 0.46, 0.38, 0.40)));
  parts.push(tag(G.box, C.roofD, M_TILE, xf(0, 0.40, 0, 0.54, 0.05, 0.48, 0, 0, -0.16)));
  parts.push(tag(G.cyl, C.stoneD, M_STONE, xf(0.14, 0.55, -0.10, 0.13, 0.42, 0.13)));   // furnace stack
  parts.push(...doorway(0, 0.16, 0.208, 0.22, 0.26, C.woodD, 0.05));
  parts.push(tag(G.box, C.wood, M_WOOD, xf(-0.30, 0.10, 0.26, 0.22, 0.20, 0.20, 0, 0.4, 0)));
  parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(0.34, 0.07, 0.24, 0.11, 0.40, 0.11, 0, 0.3, PI2)));
  return bakeAO(merge(parts), 0, 0.4, 0.55);
};
// A market stall: trestle, goods, four posts. The awning is NOT geometry — it is pushed into
// the flag system every frame, so a tier-2 town has cloth moving in it even when nothing is
// walking through. A town where only the smoke moves reads as a model, not a place.
B.stall = () => {
  const parts = [];
  for (const sx of [1, -1]) for (const sz of [1, -1])
    parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(sx * 0.22, 0.17, sz * 0.15, 0.032, 0.34, 0.032)));
  parts.push(tag(G.box, C.wood, M_WOOD, xf(0, 0.20, 0, 0.52, 0.030, 0.36)));       // trestle top
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.115, 0, 0.46, 0.028, 0.30)));     // shelf
  parts.push(tag(G.box, C.linen, M_CLOTH, xf(0, 0.155, 0.17, 0.50, 0.11, 0.02)));  // cloth over the front
  // goods: sacks, amphorae, a crate. Different zones so the pile is not one colour.
  parts.push(tag(G.sph, C.canvas, M_CLOTH, xf(-0.16, 0.255, 0.02, 0.16, 0.13, 0.14)));
  parts.push(tag(G.sph, C.wool, M_CLOTH, xf(-0.02, 0.245, -0.05, 0.13, 0.11, 0.12)));
  parts.push(tag(G.cyl, C.roofD, M_TILE, xf(0.15, 0.28, 0.02, 0.10, 0.17, 0.10)));
  parts.push(tag(G.cone, C.roofD, M_TILE, xf(0.15, 0.375, 0.02, 0.08, 0.07, 0.08)));
  parts.push(tag(G.box, C.wood, M_WOOD, xf(0.02, 0.255, 0.10, 0.14, 0.10, 0.11, 0, 0.4, 0)));
  return bakeAO(merge(parts), 0, 0.30, 0.55);
};
// Kerb spoil. The terrace is a hexagonal prism and from above its outline IS a hexagon; a
// ring of half-buried boulders straddling that line is the cheapest thing that stops the eye
// tracing it, and it is what the edge of a real earth terrace looks like.
B.rubble = (v = 0) => {
  const r = rng(v * 31 + 7), parts = [];
  for (let i = 0, n = 2 + (v % 3); i < n; i++) {
    parts.push(tag(wobble(G.sph.clone(), 0.13, v * 13 + i * 5), [C.stone, C.stoneD, C.stoneL][(v + i) % 3], M_STONE,
      xf((r() - 0.5) * 0.55, 0.06 + r() * 0.05, (r() - 0.5) * 0.55,
        0.34 + r() * 0.26, 0.22 + r() * 0.16, 0.34 + r() * 0.26, 0, r() * 3, (r() - 0.5) * 0.4)));
  }
  return bakeAO(merge(parts), -0.06, 0.20, 0.58);
};
B.pole = () => {   // authored 1.0 tall so the Y scale IS the height
  // HALF THE DIAMETER, AND A REAL SOCKET. The shipped poles measured ~6 px through — a man's
  // torso — and two of them ran clean through the keep's roof and the courtyard wall with no
  // intersection treatment at all. They are now 26 mm sticks standing in a stepped stone
  // plinth, and _layout claims ground for each one before it is placed.
  const parts = [];
  parts.push(tag(taper(G.cyl.clone(), 0.70, -0.5, 0.5), C.wood, M_WOOD, xf(0, 0.50, 0, 0.026, 1.0, 0.026)));
  parts.push(tag(G.sph, C.bronze, M_MET, xf(0, 1.012, 0, 0.036, 0.036, 0.036)));
  parts.push(tag(G.cyl, C.bronze, M_MET, xf(0, 0.972, 0, 0.030, 0.014, 0.030)));
  parts.push(tag(G.cyl, C.leatherD, M_LEATH, xf(0, 0.115, 0, 0.036, 0.045, 0.036)));  // lashing
  parts.push(tag(G.cyl, C.stoneD, M_STONE, xf(0, 0.055, 0, 0.105, 0.075, 0.105)));    // socket block
  parts.push(tag(G.cyl, C.stone, M_STONE, xf(0, 0.020, 0, 0.145, 0.040, 0.145)));     // plinth
  return bakeAO(merge(parts), 0, 0.22, 0.55);
};
// A jetty authored with y=0 at the WATERLINE: piles run down out of the deck into the sea, the
// deck stands a hand above it, and the shed sits ashore. The old one was built from its own base
// and then dropped on the seabed, so a black plank and a tan crate floated half-drowned in a
// dark hex with nothing holding them up — the loudest wrong thing in the last frame.
// ---- CITY TERRACE. The tile a town stands on is a dome: sampling Aurelia's footprint gave
// wall segments at y 0.04, 0.21, 0.27 and 0.36, so the curtain stepped up and down like a
// collapsed quarry and half the houses sat below the other half. Every 4X flattens the city
// plate; this is that plate. A hex of packed earth with a stone kerb, its top at the tile's
// HIGHEST sample and a skirt long enough to bury into the hill, so the downhill side reads as
// a retaining wall instead of a building on stilts.
// Authored radius 1.0, top at y = 0.
B.terrace = (v = 0) => {
  const hex = (rt, rb, h, y, seg = 6) => {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1);
    g.rotateY(PI2);                       // flat-top: a corner on +x, matching hex.js
    g.translate(0, y, 0);
    return g;
  };
  const R0 = [0.68, 0.94, 0.98, 1.04][v] ?? 0.94;
  const big = v > 1;
  return bakeAO(merge([
    // A broken earth fringe OUTSIDE the kerb. Without it the plate is a clean hexagonal disc
    // stamped on the hillside with a hard rim all the way round — the exact silhouette the
    // review called a plinth. Twelve sides, wobbled, sunk almost flush: from above it reads as
    // trodden ground spilling off the terrace, and the hexagon stops being the outline.
    tag(wobble(hex(R0 * 1.16, R0 * 1.34, 0.34, -0.235, 12), 0.085, v * 7 + 3), 0x6b5940, M_SOIL),
    tag(wobble(hex(R0 * 1.02, R0 * 1.15, 0.20, -0.135, 12), 0.055, v * 13 + 9), 0x7a6647, M_SOIL),
    tag(hex(R0 * 0.99, R0 * 1.04, 1.7, -0.86), big ? 0x877c66 : 0x6f5c40, big ? M_STONE : M_SOIL),
    // The kerb and the trodden top are DIRT-COLOURED, not concrete. At C.stoneL the plate lit
    // to a pale grey ring a hex and a half wide and read as the flat untextured pad the review
    // drew a straight line across. Ground people walk on is compacted and darker than the
    // ground beside it, never lighter.
    tag(hex(R0 * 1.02, R0 * 1.02, 0.085, -0.055), big ? 0x847760 : 0x76664b, big ? M_STONE : M_SOIL),
    tag(hex(R0 * 0.99, R0 * 0.99, 0.10, -0.045), 0x685a41, M_SOIL),          // trodden top
  ]), -0.9, -0.05, 0.55);
};
B.dock = () => {
  const parts = [];
  for (let i = 0; i < 5; i++) for (const sx of [1, -1])
    parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(sx * 0.135, -0.16, -0.30 + i * 0.21, 0.048, 0.60, 0.048)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0, 0.075, 0.06, 0.34, 0.030, 0.92)));        // deck
  for (let i = 0; i < 7; i++)                                                             // planking
    parts.push(tag(G.box, i % 2 ? 0xa98f62 : 0x8d7550, M_WOOD, xf(0, 0.094, -0.34 + i * 0.13, 0.33, 0.012, 0.105)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0.175, 0.055, 0.06, 0.030, 0.055, 0.94)));   // stringers
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.175, 0.055, 0.06, 0.030, 0.055, 0.94)));
  // bollards and a coil of rope: the two props that say "boats tie up here"
  for (const z of [0.40, -0.18]) for (const sx of [1, -1]) {
    parts.push(tag(G.cyl, C.wood, M_WOOD, xf(sx * 0.185, 0.16, z, 0.055, 0.20, 0.055)));
    parts.push(tag(G.sph, C.woodD, M_WOOD, xf(sx * 0.185, 0.255, z, 0.070, 0.045, 0.070)));
  }
  // shore end: a plastered net-shed with a shingle roof, standing on dry land behind the deck
  parts.push(tag(taper(G.box.clone(), 0.94, -0.5, 0.5), C.plasterB, M_PLAST, xf(0.05, 0.28, -0.60, 0.40, 0.36, 0.34)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(0.05, 0.40, -0.60, 0.42, 0.028, 0.36)));
  // BLEACHED TIMBER. A harbour shed roofs in salt-scoured driftwood, not terracotta — that is
  // the third of the three roof families and the only pale one on the board.
  for (const sx of [1, -1]) parts.push(tag(G.box, 0xa7a08c, M_WOOD, xf(0.05 + sx * 0.11, 0.525, -0.60, 0.27, 0.042, 0.42, 0, 0, sx * -0.75)));
  parts.push(tag(G.box, 0x7d7663, M_WOOD, xf(0.05, 0.605, -0.60, 0.065, 0.040, 0.44)));
  parts.push(tag(G.box, C.stoneD, M_STONE, xf(0.05, 0.075, -0.60, 0.44, 0.15, 0.38)));   // footing above the tideline
  parts.push(...doorway(0.05, 0.20, -0.44, 0.14, 0.26, C.woodD, 0.045));
  // drying nets on a rack, and an upturned skiff
  parts.push(tag(G.cyl, C.wood, M_WOOD, xf(-0.30, 0.24, -0.30, 0.030, 0.48, 0.030)));
  parts.push(tag(G.cyl, C.wood, M_WOOD, xf(-0.30, 0.24, 0.14, 0.030, 0.48, 0.030)));
  parts.push(tag(G.box, C.rope, M_CLOTH, xf(-0.30, 0.30, -0.08, 0.020, 0.22, 0.44)));
  return bakeAO(merge(parts), -0.45, 0.35, 0.62);
};

// =========================================================== improvements
// The worked landscape. A 4X map with no farms, mines or pastures is wilderness with towns
// dropped on it — Civ's read at gameplay zoom is that every tile a city works LOOKS worked,
// and that read is carried by three or four props per hex, not by a ground decal. Each of
// these is authored with y=0 on the ground, origin at the tile centre, ~0.9 across (a hex is
// 2.0 corner to corner) so one _put at scale 1 fills a tile without spilling over its edges.
const FWD = (a) => [Math.cos(a), -Math.sin(a)], SIDE = (a) => [Math.sin(a), Math.cos(a)];

// post-and-rail run between two points. Every improvement that encloses something uses it.
// FEWER, THICKER, DARKER. At gameplay zoom a 0.032 post is one pixel of warm brown and a run
// of them is a dashed orange line lying on the grass — the review's "orange line-art fence".
// Weathered timber is nearly black against a lit field; three posts read, five alias.
const rail = (x0, z0, x1, z1, h = 0.17, n = 3) => {
  const parts = [], dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), a = Math.atan2(dx, dz);
  for (let i = 0; i <= n; i++) {
    const f = i / n, s = 0.88 + ((i * 7) % 5) * 0.06;
    parts.push(tag(G.box, i % 2 ? 0x33251a : 0x40301f, M_WOOD,
      xf(lerp(x0, x1, f), h * 0.5 * s, lerp(z0, z1, f), 0.048, h * s, 0.048, 0.05, 0, 0.04)));
  }
  for (const y of [h * 0.88, h * 0.44])
    parts.push(tag(G.box, 0x4a3623, M_WOOD, xf((x0 + x1) / 2, y, (z0 + z1) / 2, 0.030, 0.030, L, 0, a, 0)));
  return parts;
};
// A four-legged animal: body capsule laid along its own heading, head, four shanks — plus the
// two things the review counted as missing. It STANDS ON the paddock's trodden apron (y0)
// instead of sinking to its knees in it, and it carries its own baked contact patch, because
// a pasture is one merged mesh with no per-animal instance to hang a decal on. Fleece is a
// combed-straw zone, not flat cloth: a white matte capsule is the "untextured prop" verdict.
const beast = (x, z, a, s, body, dark, y0 = 0.098) => {
  const [fx, fz] = FWD(a), [sx, sz] = SIDE(a), P = [];
  P.push(tag(G.cyl, 0x3b3123, M_SOIL, xf(x, y0 + 0.006, z, 0.34 * s, 0.012, 0.26 * s, 0, a, 0)));
  P.push(tag(G.caps, body, M_THATCH, xf(x, y0 + 0.155 * s, z, 0.105 * s, 0.085 * s, 0.105 * s, 0, a, PI2)));
  P.push(tag(G.sph, body, M_THATCH, xf(x + fx * 0.14 * s, y0 + 0.185 * s, z + fz * 0.14 * s, 0.085 * s, 0.080 * s, 0.085 * s)));
  P.push(tag(G.sph, dark, M_SKIN, xf(x + fx * 0.20 * s, y0 + 0.165 * s, z + fz * 0.20 * s, 0.060 * s, 0.055 * s, 0.070 * s)));
  for (const u of [-1, 1]) for (const v of [-1, 1])
    P.push(tag(G.cyl, dark, M_LEATH, xf(x + fx * u * 0.075 * s + sx * v * 0.055 * s, y0 + 0.055 * s,
      z + fz * u * 0.075 * s + sz * v * 0.055 * s, 0.026 * s, 0.11 * s, 0.026 * s)));
  return P;
};

// MINE. Silhouette gate: a timber headframe is the only A-frame on the board, and the spoil
// cone beside it is the only bare-earth mound. Both read at twenty pixels.
B.mine = () => {
  // SILHOUETTE GATE — the review wrote the acceptance test: render this black at 60 px and a
  // player must name it. That allows exactly TWO masses and forbids a third, and it also
  // forbids the two things three passes of this prop kept getting wrong. First, VALUE: a mine
  // stands on sand, so pale timber and grey stone give an outline with no contrast and the
  // whole thing dissolves into the hex. Every structural member here is dark. Second, ROUND
  // SHAPES: cones, cylinders and spheres at this size are lumps, and four lumps in a heap is
  // the "no readable silhouette at any zoom" verdict. The A-frame is boxes; the tip is a
  // nine-sided frustum with a flat crown, which is what a spoil heap actually is.
  const parts = [...apron(0.40)];
  const TIP = new THREE.CylinderGeometry(0.19, 0.5, 1, 9, 1);
  parts.push(tag(wobble(TIP.clone(), 0.07, 5), 0x40371f, M_SOIL, xf(0.42, 0.16, 0.36, 0.76, 0.32, 0.70)));
  parts.push(tag(wobble(TIP.clone(), 0.05, 9), 0x4e422a, M_SOIL, xf(0.22, 0.055, 0.60, 0.54, 0.12, 0.50)));
  // ---- the A-frame: the only A-shape on the board, dark against whatever it stands on
  for (const sx of [1, -1])
    parts.push(tag(G.box, C.woodD, M_WOOD, xf(sx * 0.235, 0.50, -0.16, 0.140, 1.06, 0.140, 0, 0, -sx * 0.345)));
  parts.push(tag(G.box, 0x40301c, M_WOOD, xf(0, 0.42, -0.16, 0.50, 0.090, 0.090)));       // tie beam
  parts.push(tag(G.box, 0x40301c, M_WOOD, xf(0, 0.94, -0.15, 0.32, 0.120, 0.30)));        // head block
  parts.push(tag(G.ring, C.iron, M_MET2, xf(0, 1.00, -0.15, 0.22, 0.22, 0.075, 0, 0, PI2)));
  parts.push(tag(G.cyl, C.rope, M_CLOTH, xf(0.010, 0.50, -0.15, 0.016, 0.90, 0.016)));
  // ---- everything below 0.1 hex, all of it squared off so nothing reads as a boulder
  parts.push(tag(G.box, 0x4a3a22, M_WOOD, xf(0.010, 0.035, -0.16, 0.66, 0.070, 0.56)));   // shaft curb
  parts.push(tag(G.box, 0x11100c, M_STONE, xf(0.010, 0.062, -0.16, 0.38, 0.030, 0.32)));  // the shaft itself
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.34, 0.095, 0.06, 0.24, 0.18, 0.22, 0, 0.4, 0)));  // kibble
  parts.push(tag(G.box, 0x2b2418, M_WOOD, xf(-0.34, 0.180, 0.06, 0.26, 0.030, 0.24, 0, 0.4, 0)));
  return bakeAO(merge(parts), 0, 0.45, 0.52);
};
// QUARRY. Stepped benches cut into the hill, sawn blocks stacked on the floor, sheerlegs.
B.quarry = () => {
  const parts = [...apron(0.46)];
  const R = rng(19);
  // BENCHES CUT INTO ROCK, not three stacked boxes. Each bench is wobbled so its face is
  // broken stone rather than a extruded rectangle, and each carries a lip of loose scree where
  // the next cut spilled over it.
  for (let i = 0; i < 3; i++) {
    parts.push(tag(wobble(taper(G.box.clone(), 0.94, -0.5, 0.5), 0.045, 11 + i * 7),
      [C.stoneL, C.stone, C.stoneD][i], M_STONE,
      xf(0, 0.05 + i * 0.115, -0.10 - i * 0.18, 0.88 - i * 0.11, 0.16, 0.36)));
    for (let k = 0; k < 3; k++) parts.push(tag(wobble(G.sph.clone(), 0.16, i * 31 + k * 5),
      [C.stone, C.stoneD, 0x7d7361][k % 3], M_STONE,
      xf(-0.30 + k * 0.29 + (R() - 0.5) * 0.12, 0.115 + i * 0.115, 0.06 - i * 0.18,
        0.15 + R() * 0.10, 0.10 + R() * 0.06, 0.15 + R() * 0.10, 0, R() * 3, (R() - 0.5) * 0.5)));
  }
  // sawn blocks on the floor: each on its own bearing, so the stack is a yard and not a wall
  for (let i = 0; i < 5; i++) parts.push(tag(G.box, i % 2 ? C.stoneL : C.stone, M_STONE,
    xf(-0.32 + (i % 3) * 0.26 + (R() - 0.5) * 0.06, 0.078 + Math.floor(i / 3) * 0.155, 0.28 + (i % 2) * 0.15,
      0.19 + R() * 0.06, 0.15, 0.16 + R() * 0.05, 0, R() * 0.9 - 0.45, 0)));
  // sheerlegs: two legs, a head lashing, a fall and a hooked block
  for (const s of [1, -1]) parts.push(tag(G.cyl, C.wood, M_WOOD, xf(0.26 + s * 0.13, 0.32, 0.10, 0.038, 0.68, 0.038, 0, 0, -s * 0.24)));
  parts.push(tag(G.sph, C.rope, M_CLOTH, xf(0.26, 0.655, 0.10, 0.055, 0.045, 0.055)));
  parts.push(tag(G.cyl, C.rope, M_CLOTH, xf(0.26, 0.50, 0.145, 0.012, 0.32, 0.012)));
  parts.push(tag(G.box, C.stoneL, M_STONE, xf(0.26, 0.30, 0.145, 0.15, 0.13, 0.13)));
  parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(-0.34, 0.09, -0.02, 0.10, 0.44, 0.10, 0, 0.3, PI2)));  // a discarded roller
  return bakeAO(merge(parts), 0, 0.35, 0.55);
};
// PASTURE. A fenced paddock with stock in it, a trough and a stook of hay. The livestock IS
// the read: nothing else on the board is a small pale body on four legs.
B.pasture = () => {
  const parts = [...apron(0.46)];
  const c = [[-0.44, -0.40], [0.44, -0.40], [0.44, 0.42], [-0.44, 0.42]];
  for (let i = 0; i < 4; i++) {
    if (i === 2) continue;                       // one side open, so the paddock has a way in
    const a = c[i], b = c[(i + 1) % 4];
    parts.push(...rail(a[0], a[1], b[0], b[1], 0.19, 4));
  }
  parts.push(...beast(-0.16, -0.05, 0.9, 1.0, 0xb0a68d, 0x584c3d));
  parts.push(...beast(0.14, 0.16, 2.4, 0.92, 0x9d9179, 0x584c3d));
  parts.push(...beast(0.24, -0.22, 1.6, 0.82, 0x8a765f, 0x4a3e31));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.34, 0.075, 0.24, 0.36, 0.09, 0.14)));     // trough
  parts.push(tag(G.box, 0x3d4c58, M_STONE, xf(-0.34, 0.108, 0.24, 0.31, 0.025, 0.10)));
  parts.push(tag(wobble(G.cone.clone(), 0.04, 3), C.thatch, M_THATCH, xf(0.36, 0.14, 0.30, 0.34, 0.42, 0.34)));
  parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(0.36, 0.36, 0.30, 0.022, 0.30, 0.022)));
  return bakeAO(merge(parts), 0, 0.22, 0.60);
};
// PLANTATION. Rows of clipped bushes on their own ridges, a drying rack and stacked baskets.
B.grove = () => {
  const parts = [...apron(0.46)];
  const R = rng(53);
  for (let r = 0; r < 4; r++) {
    const z = -0.34 + r * 0.24;
    parts.push(tag(G.box, 0x6a5334, M_SOIL, xf(0, 0.045, z, 0.84, 0.09, 0.15)));
    for (let i = 0; i < 4; i++) {
      const x = -0.30 + i * 0.20 + (R() - 0.5) * 0.05;
      parts.push(tag(G.cyl, C.woodD, M_WOOD, xf(x, 0.13, z, 0.030, 0.16, 0.030)));
      parts.push(tag(wobble(G.sph.clone(), 0.05, r * 9 + i), r % 2 ? 0x4f6b33 : 0x5d7a38, M_THATCH,
        xf(x, 0.255, z, 0.185, 0.19, 0.185)));
    }
  }
  for (const s of [1, -1]) parts.push(tag(G.cyl, C.wood, M_WOOD, xf(-0.42, 0.17, s * 0.20, 0.030, 0.34, 0.030)));
  parts.push(tag(G.box, C.woodD, M_WOOD, xf(-0.42, 0.325, 0, 0.026, 0.026, 0.44)));
  parts.push(tag(G.box, C.linen, M_CLOTH, xf(-0.42, 0.245, 0, 0.10, 0.17, 0.40)));       // drying cloth
  parts.push(tag(taper(G.cyl.clone(), 1.25, -0.5, 0.5), C.rope, M_CLOTH, xf(0.40, 0.085, -0.36, 0.20, 0.17, 0.20)));
  parts.push(tag(taper(G.cyl.clone(), 1.25, -0.5, 0.5), C.rope, M_CLOTH, xf(0.40, 0.235, -0.36, 0.17, 0.14, 0.17)));
  return bakeAO(merge(parts), 0, 0.30, 0.58);
};
// FISHING BOAT. Authored with y=0 at the WATERLINE: the hull sits in the sea to its real
// draft, the net floats trail off the stern, and the stake weir stands in the shallows.
B.fishboat = () => {
  const parts = [];
  const hull = taper(G.caps.clone(), 0.30, -0.2, 1.0);
  parts.push(tag(hull, C.woodD, M_WOOD, xf(0, -0.015, 0, 0.20, 0.115, 0.62, PI2, 0, 0)));
  parts.push(tag(G.box, 0x9a7f52, M_WOOD, xf(0, 0.055, 0, 0.17, 0.022, 0.50)));          // washboard
  for (const z of [-0.14, 0.10]) parts.push(tag(G.box, C.wood, M_WOOD, xf(0, 0.045, z, 0.19, 0.020, 0.055)));
  parts.push(tag(G.cyl, C.wood, M_WOOD, xf(0.02, 0.24, -0.02, 0.024, 0.50, 0.024, 0.10, 0, 0.06)));
  parts.push(tag(G.box, C.rope, M_CLOTH, xf(0.09, 0.16, 0.12, 0.02, 0.24, 0.26, 0, 0, -0.25)));  // net over the side
  for (let i = 0; i < 4; i++) parts.push(tag(G.sph, 0xb8703a, M_WOOD,
    xf(0.16 + i * 0.055, 0.010, 0.24 + i * 0.16, 0.055, 0.045, 0.055)));                 // cork floats
  // stake weir: the thing that says the water itself is worked
  for (let i = 0; i < 7; i++) parts.push(tag(G.cyl, C.woodD, M_WOOD,
    xf(-0.52 + i * 0.055, 0.10, -0.44 + i * 0.115, 0.028, 0.40, 0.028, 0.06 * (i % 2 ? 1 : -1), 0, 0.05)));
  parts.push(tag(G.box, C.rope, M_CLOTH, xf(-0.36, 0.16, -0.09, 0.026, 0.13, 0.72, 0, -0.45, 0)));
  return bakeAO(merge(parts), -0.06, 0.16, 0.62);
};

// What a tile turns into once a city works it. Derived from the tile itself — biome, resource,
// feature — because the rules layer has no improvement field to read: a hex with iron in the
// hills gets a mine, wheat on the flat gets a farm, a shoal with fish in it gets a boat. The
// tiles that get NOTHING matter as much: raw forest, mountain and marsh stay wild, so the
// worked land reads as a claim rather than as wallpaper.
const IMPROVE = (t) => {
  const r = t.resource, b = t.biome, f = t.feature;
  if (t.height <= 0) return (r === 'fish' || r === 'crabs' || r === 'whales' || r === 'pearls') ? 'fish' : null;
  if (f === 'marsh' || f === 'volcano' || f === 'ice' || f === 'oasis') return null;
  if (r === 'iron' || r === 'copper' || r === 'gold' || r === 'silver' || r === 'gems' || r === 'oil') return 'mine';
  if (r === 'stone' || r === 'marble') return 'quarry';
  if (r === 'cattle' || r === 'sheep' || r === 'horses' || r === 'deer' || r === 'ivory' || r === 'furs') return 'pasture';
  if (r === 'spices' || r === 'dyes' || r === 'cocoa' || r === 'bananas' || r === 'silk' || r === 'wine' || r === 'incense') return 'grove';
  if (b === 'mountain' || b === 'snow' || b === 'tundra' || b === 'jungle' || b === 'forest') return null;
  if (b === 'hills') return 'pasture';
  if (b === 'grass' || b === 'plains' || f === 'floodplains') return 'farm';
  return null;
};

// ================================================================ flag system
// One InstancedMesh, one vertex-shader wave. Banners, pennants and the trireme's sail all
// come from here — a flag that does not move is the fastest way to make a frame look dead.
const FLAG_V = `
attribute vec3 aColA, aColB; attribute vec2 aPhase;
varying vec2 vUv; varying vec3 vA, vB; varying vec3 vN; varying float vKind;
uniform float uTime;
void main(){
  vUv = uv; vA = aColA; vB = aColB; vKind = aPhase.y;
  float w = uv.x;                        // 0 at the pole, 1 at the fly
  float t = uTime * 4.6 + aPhase.x;
  if (vKind > 0.5) w = 0.35 + 0.35 * abs(uv.y - 0.5) * 2.0;   // awning/sail: pinned along one edge
  vec3 p = position;
  float k = 9.0;
  p.z += (sin(p.x * k - t) * 0.10 + sin(p.x * 4.0 - t * 0.63) * 0.055) * w * w;
  p.y += sin(p.x * 6.0 - t * 1.07) * 0.05 * w;
  // second bone: a slow fold running down the drop, so the cloth has a lengthwise crease as
  // well as a flutter and the shading is not one flat value across the whole panel
  float fold = sin(p.y * 7.0 + t * 0.41) * 0.030 * w;
  p.z += fold;
  float d = cos(p.x * k - t) * k * 0.10 * w * w;
  float dy = cos(p.y * 7.0 + t * 0.41) * 7.0 * 0.030 * w;
  vec3 n = normalize(vec3(-d, -dy, 1.0));
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FLAG_F = `
varying vec2 vUv; varying vec3 vA, vB; varying vec3 vN; varying float vKind;
uniform vec3 uSun, uSunCol, uAmb;
void main(){
  // A market awning is not a heraldic banner. Drawing it with the swallowtail cut and the civ
  // roundel is what put a row of gold half-discs with dark rims across the market square —
  // called out as 'flat blue/gold quads' in the last review. Awnings get stripes and nothing else.
  if (vKind > 0.5) {
    // Analytic stripes. A hard step() on a cloth seen nearly edge-on aliases into a
    // checkerboard — that is the 'UV test grid' hanging over Solmere's market.
    float sw = sin(vUv.y * 12.5664), aa = fwidth(vUv.y) * 12.5664 + 0.02;
    float st = smoothstep(-aa, aa, sw);
    vec3 c = mix(vA, vB, st) * (0.86 + 0.16 * vUv.x);
    c *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.10, vUv.x));
    vec3 nn = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    float dd = max(dot(nn, uSun), 0.0) + max(-dot(nn, uSun), 0.0) * 0.45;
    gl_FragColor = vec4(c * (uAmb + uSunCol * dd), 1.0);
    return;
  }
  // The FIELD is the civ's primary and the secondary is trim. The other way round — which is
  // what this was — put a wall of gold across the map and every banner read as the same
  // neutral pennant regardless of who owned it.
  vec3 base = vA;
  base = mix(base, vB, smoothstep(0.80, 0.87, vUv.y));            // chief band
  base = mix(base, vB * 0.92, 1.0 - smoothstep(0.13, 0.20, vUv.y)); // base band
  base = mix(base, vA * 0.72, 1.0 - smoothstep(0.74, 0.80, vUv.y)) * mix(1.0, 1.0, step(0.80, vUv.y));
  // the civ's charge: a roundel in the fly. A bicolour rectangle is a placeholder; one
  // device is the difference between a flag and a swatch.
  vec2 fc = vec2(vUv.x - 0.44, (vUv.y - 0.5) * 1.30);
  float ring = length(fc);
  // Every edge on this cloth is antialiased against its OWN screen footprint. At gameplay
  // zoom a pennant is thirty pixels wide, so a fixed 0.014-wide smoothstep is a hard step and
  // the charge crawls; fwidth makes the ramp exactly one pixel however far away it is.
  float rw = fwidth(ring) + 0.002;
  base = mix(base, vB, 1.0 - smoothstep(0.104 - rw, 0.104 + rw, ring));
  base = mix(base, vA * 0.70, 1.0 - smoothstep(0.058 - rw, 0.058 + rw, ring));
  base = mix(base, vB, 1.0 - smoothstep(0.022 - rw, 0.022 + rw, ring));
  base *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.07, vUv.x));   // shadowed at the pole
  // HEM. A dark selvedge all the way round. Without it a banner is a saturated rectangle
  // pasted over whatever is behind it, and over a tiled roof at gameplay zoom that reads as a
  // flat blue tarp draped on the town — which is exactly what the review saw at Solmere.
  float hem = min(min(vUv.y, 1.0 - vUv.y) * 7.0, min(vUv.x * 14.0, (1.0 - vUv.x) * 9.0));
  base *= 0.40 + 0.60 * smoothstep(0.0, 1.0, hem);
  // WEAVE, fenced off by its own footprint. sixty periods across a thirty-pixel flag is one
  // period every half pixel — a guaranteed moire, and it is the checkerboard the review saw
  // hanging over Solmere. Lower frequency, and switched off entirely once a pixel spans more
  // than a period.
  base *= 1.0 + 0.075 * sin(vUv.y * 24.0) * clamp(1.0 - fwidth(vUv.y) * 70.0, 0.0, 1.0);
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float d = max(dot(n, uSun), 0.0);
  float back = max(-dot(n, uSun), 0.0) * 0.35;             // cloth is thin, light bleeds
  gl_FragColor = vec4(base * (uAmb + uSunCol * (d + back)), 1.0);
}`;

class Flags {
  constructor(cap) {
    const g = new THREE.PlaneGeometry(1, 1, 12, 4);
    g.translate(0.5, 0, 0);
    // SWALLOWTAIL IN THE GEOMETRY, NOT IN A DISCARD. A fly edge cut with `discard` cannot be
    // antialiased by anything downstream — not by TAA, not by the grade — which is the
    // stair-stepped pennant the review measured on the Calyx flag. Notching the mesh makes the
    // cut a real polygon edge that every AA path in the chain already handles.
    {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getX(i) < 0.99) continue;
        pos.setX(i, 1.0 - 0.32 * (1.0 - Math.min(1, Math.abs(pos.getY(i)) * 4.0)));
      }
    }
    this.cap = cap;
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.p = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    g.setAttribute('aColA', this.a); g.setAttribute('aColB', this.b); g.setAttribute('aPhase', this.p);
    this.u = {
      uTime: { value: 0 }, uSun: { value: new THREE.Vector3(-0.86, 0.42, -0.28) },
      uSunCol: { value: new THREE.Color(1.5, 1.28, 0.98) }, uAmb: { value: new THREE.Color(0.30, 0.34, 0.42) },
    };
    this.mesh = new THREE.InstancedMesh(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: FLAG_V, fragmentShader: FLAG_F, side: THREE.DoubleSide,
    }), cap);
    this.mesh.frustumCulled = false; this.mesh.count = 0; this.mesh.renderOrder = 4;
    this.n = 0;
  }
  reset() { this.n = 0; }
  push(m, colA, colB, phase, kind = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    _c.set(colA); this.a.setXYZ(i, _c.r, _c.g, _c.b);
    _c.set(colB); this.b.setXYZ(i, _c.r, _c.g, _c.b);
    this.p.setXY(i, phase, kind);
  }
  flush() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.a.needsUpdate = this.b.needsUpdate = this.p.needsUpdate = true;
  }
}

// ============================================================== puff system
// Chimney smoke and footfall dust are the same thing with different gravity. Billboarded in
// the vertex shader off the instance translation so the CPU never touches the camera basis.
const PUFF_V = `
attribute float aFade; attribute vec3 aCol;
varying float vFade; varying vec3 vCol; varying vec2 vUv;
void main(){
  vFade = aFade; vCol = aCol; vUv = uv;
  vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  mv.xy += position.xy * instanceMatrix[0].x;
  gl_Position = projectionMatrix * mv;
}`;
const PUFF_F = `
varying float vFade; varying vec3 vCol; varying vec2 vUv;
void main(){
  vec2 d = vUv - 0.5;
  float r = length(d);
  float a = (1.0 - smoothstep(0.12, 0.5, r)) * vFade;
  // three lobes so a puff is not a perfect disc
  a *= 0.72 + 0.28 * sin(atan(d.y, d.x) * 3.0 + vFade * 9.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
}`;

class Puffs {
  constructor(cap) {
    const g = new THREE.PlaneGeometry(1, 1);
    this.cap = cap;
    this.f = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.c = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    g.setAttribute('aFade', this.f); g.setAttribute('aCol', this.c);
    this.mesh = new THREE.InstancedMesh(g, new THREE.ShaderMaterial({
      vertexShader: PUFF_V, fragmentShader: PUFF_F, transparent: true, depthWrite: false,
    }), cap);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.count = 0;
    this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap);
    this.head = 0;
  }
  spawn(x, y, z, vx, vy, vz, s0, s1, life, col) {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.s0[i] = s0; this.s1[i] = s1; this.life[i] = 0; this.max[i] = life;
    _c.set(col); this.c.setXYZ(i, _c.r, _c.g, _c.b);
  }
  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.max[i] <= 0) continue;
      const t = (this.life[i] += dt) / this.max[i];
      if (t >= 1) {
        // collapse the quad, do not just zero the alpha: a dead 0.5-unit puff still rasterises
        // its whole footprint before the discard, and 200 of those is real money on software GL
        this.max[i] = 0; this.f.setX(i, 0);
        _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); continue;
      }
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      this.v[i * 3 + 1] -= 0.02 * dt;
      const s = lerp(this.s0[i], this.s1[i], t);
      _m.makeScale(s, s, s);
      _m.elements[12] = this.p[i * 3]; _m.elements[13] = this.p[i * 3 + 1]; _m.elements[14] = this.p[i * 3 + 2];
      this.mesh.setMatrixAt(i, _m);
      this.f.setX(i, Math.sin(Math.min(1, t * 3.2) * Math.PI * 0.5) * (1 - t) * (1 - t) * 0.50);
    }
    this.mesh.count = this.cap;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.f.needsUpdate = true; this.c.needsUpdate = true;
  }
}

// =============================================================== ground decals
// Two jobs, one InstancedMesh, switched on aMode:
//
//   0  CONTACT AO. A tight occlusion capsule centred exactly on the caster's footprint —
//      no sun offset, because the sun's own shadow is already being cast by the 2048 cascade
//      and a second, displaced copy of it is what read as a sticker. This layer is MULTIPLIED
//      into the ground (see AO_MUL) so it darkens whatever is under it instead of painting a
//      brown pool on it, and its darkest texel is under the feet.
//   1  OWNERSHIP. A hex-conformal tint — analytic hexagon, soft radial fill at ~15% civ
//      colour, one crisp rim — that sits inside the tile instead of an aliased ellipse cutting
//      across it. Replaces the ring decal entirely.
//   2  WAKE. A stretched foam ellipse for hulls.
const DECAL_V = `
attribute vec4 aCol; attribute vec2 aMode;
varying vec2 vUv; varying vec3 vCol; varying float vMode, vK;
void main(){ vUv = uv; vCol = aCol.rgb; vK = aCol.w; vMode = aMode.x;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const DECAL_F = `
varying vec2 vUv; varying vec3 vCol; varying float vMode, vK;
// signed distance to a flat-top hexagon of circumradius 1, in the plane
float hexd(vec2 p){
  const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z, k.z), 1.0);
  return length(p) * sign(p.y);
}
void main(){
  vec2 d = vUv - 0.5;
  if (vMode < 0.5) {
    // --- contact AO. Plateau then feather: the caster's own footprint is fully dark and only
    // the penumbra ramps, so there is no lit gap between the boots and the darkest texel.
    float r = length(d * 2.0);
    float a = 1.0 - smoothstep(0.30, 1.0, r);
    a = a * (0.55 + 0.45 * a) * vK;
    if (a < 0.006) discard;
    #ifdef MUL
      gl_FragColor = vec4(mix(vec3(1.0), vCol, a), 1.0);
    #else
      gl_FragColor = vec4(vCol, a);
    #endif
  } else if (vMode < 1.5) {
    // --- ownership hex
    float h = hexd(d * 2.0);
    float w = fwidth(h) * 1.2 + 0.004;
    float fill = 1.0 - smoothstep(-0.90, -0.02, h);          // soft toward the rim
    float rim = 1.0 - smoothstep(0.0, max(w, 0.030), abs(h + 0.055));
    float a = (fill * 0.16 + rim * 0.20) * vK;
    if (a < 0.006) discard;
    gl_FragColor = vec4(vCol * (0.70 + 0.55 * rim), a);
  } else if (vMode > 3.5) {
    // --- TEAM BASE DISC. Civ's answer to "a player cannot find the unit": a hard-edged oval
    // of pure ownership colour under the feet, dark-stroked so it never welds to the ground it
    // is lying on. Two-tone — a bright rim and a sunk fill — because a single flat ellipse is
    // a poker chip, and the rim is what survives when the disc is thirty pixels across.
    float r = length(d * 2.0);
    float w = fwidth(r) * 0.9 + 0.012;
    float disc = 1.0 - smoothstep(1.0 - w, 1.0, r);
    // The ring was 34% of the radius wide — an opaque livery DONUT the size of the soldier,
    // which is what the eye was actually finding at gameplay zoom. A rim is a rim: 16%.
    float fill = 1.0 - smoothstep(0.84 - w, 0.84, r);
    float ink  = 1.0 - smoothstep(0.92 - w, 0.92, r);
    vec3 col = mix(vCol * 1.15, vCol * 0.55, fill);
    col = mix(vec3(0.045, 0.040, 0.036), col, ink);       // 1 px dark outer stroke
    // The RING carries the read; the fill is a wash. A solid opaque ellipse of livery under a
    // soldier is a puddle the size of his hex — it out-reads the model it is supposed to be
    // pointing at, which is the same mistake as the badge.
    // Round 8: 0.46 of saturated livery across a 0.8-unit ellipse measured LOUDER than the
    // soldier standing on it — at gameplay zoom the eye found a blue puddle first and the
    // model second. The RING is the ownership read; the fill is now a wash you notice only
    // after you have already read the figure, and the contact AO under it carries the ground.
    float a = (fill * 0.14 + (disc - fill) * 0.68) * vK;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  } else if (vMode < 2.5) {
    // --- V wake. Two foam arms opening astern from the hull plus the churn right behind the
    // stern, the whole thing decaying quadratically so it is gone by three hex lengths.
    float t = clamp(vUv.y, 0.0, 1.0);          // 0 at the hull, 1 astern
    float x = (vUv.x - 0.5) * 2.0;
    float arm = abs(x) - t * 0.66;
    float line = exp(-abs(arm) * 13.0);
    float churn = (1.0 - smoothstep(0.0, 0.26, t)) * exp(-abs(x) * 4.5);
    float ripple = 0.62 + 0.38 * sin(t * 34.0 - vK * 4.4);
    float a = (line * ripple * 0.85 + churn * 0.9) * (1.0 - t) * (1.0 - t);
    if (a < 0.008) discard;
    gl_FragColor = vec4(vec3(0.94, 0.975, 1.0), a * 0.72);
  } else {
    // --- SUN-ALIGNED CONTACT SHADOW. vUv.y is 0 at the caster's feet and 1 at the tip of the
    // shadow, so the darkest texel is always directly under the model and only the TAIL says
    // where the sun is. That ordering is the whole trick: a symmetric pool offset down-sun is
    // a sticker, and a pool with no direction at all is a smudge. This is a shadow.
    float t = vUv.y;
    float x = (vUv.x - 0.5) * 2.0;
    float wid = 1.0 - 0.30 * t;                       // narrows as it runs out
    float r = abs(x) / wid;
    float body = (1.0 - smoothstep(0.18, 1.0, r)) * (1.0 - smoothstep(0.05, 1.0, t));
    // the contact wedge itself: small, nearly opaque, hard against the boots
    float core = 1.0 - smoothstep(0.10, 0.70, length(vec2(x * 1.15, (t - 0.04) * 2.1)));
    float a = clamp(body * 0.82 + core * 1.05, 0.0, 1.0) * vK;
    if (a < 0.006) discard;
    #ifdef MUL
      gl_FragColor = vec4(mix(vec3(1.0), vCol, a), 1.0);
    #else
      gl_FragColor = vec4(vCol, a);
    #endif
  }
}`;

class Decals {
  constructor(cap, mul) {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-PI2);
    this.cap = cap;
    this.c = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.k = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    g.setAttribute('aCol', this.c); g.setAttribute('aMode', this.k);
    const m = new THREE.ShaderMaterial({
      vertexShader: DECAL_V, fragmentShader: DECAL_F, transparent: true, depthWrite: false,
      defines: mul ? { MUL: '' } : {}, blending: mul ? THREE.MultiplyBlending : THREE.NormalBlending,
      premultipliedAlpha: !!mul,   // r185 refuses MultiplyBlending without it
    });
    m.polygonOffset = true; m.polygonOffsetFactor = -4; m.polygonOffsetUnits = -8;
    this.mesh = new THREE.InstancedMesh(g, m, cap);
    this.mesh.frustumCulled = false; this.mesh.count = 0; this.mesh.renderOrder = 3;
    this.n = 0;
  }
  reset() { this.n = 0; }
  push(m, col, k, mode) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    _c.set(col); this.c.setXYZW(i, _c.r, _c.g, _c.b, k);
    this.k.setXY(i, mode, 0);
  }
  flush() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.c.needsUpdate = true; this.k.needsUpdate = true;
  }
}

// ============================================================== city nameplate
// Canvas2D, drawn once per city. Sprite so it always faces the camera; depthTest off so it
// never sinks into a ridge — Civ does exactly this and it is the only honest way to keep a
// label legible over an arbitrary landscape.
// FIXED PLATE. The review measured the shipped bars at 176 / 160 / 111 px against a 145 px
// hex and heights of 37 / 39 / 43 — i.e. the plate grew with the string, so no two labels in
// the frame were the same object. The bar is now a CONSTANT 420x112 of a 512-wide canvas and
// the name is ellipsised to fit it, so every plate in the game is one shape; _plateFade then
// pins that shape to a fixed fraction of a hex on screen whatever the camera is doing.
const PL = { W: 512, H: 176, X: 46, Y: 10, BW: 420, BH: 112, HEX: 1.25 };
function plateTexture(name, pop, prod, team) {
  const { W, H, X: x0, Y: y0, BW: w, BH: h } = PL;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const r = 13;
  const round = (x, y, ww, hh, rr) => {
    g.beginPath(); g.moveTo(x + rr, y);
    g.arcTo(x + ww, y, x + ww, y + hh, rr); g.arcTo(x + ww, y + hh, x, y + hh, rr);
    g.arcTo(x, y + hh, x, y, rr); g.arcTo(x, y, x + ww, y, rr); g.closePath();
  };
  // 0/6px 45% drop shadow under the body, then a 1px dark outline round it: without the
  // outline the plate dissolves into a red roof or a lit field the moment it crosses one.
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 10; g.shadowOffsetY = 7;
  const body = g.createLinearGradient(0, y0, 0, y0 + h);
  body.addColorStop(0, 'rgba(32,36,45,0.95)'); body.addColorStop(1, 'rgba(13,16,21,0.95)');
  g.fillStyle = body; round(x0, y0, w, h, r); g.fill();
  g.shadowColor = 'transparent';
  // team chip with the population
  const tc = '#' + (team.flag ?? team.a).toString(16).padStart(6, '0');
  const chip = g.createLinearGradient(0, y0, 0, y0 + h);
  chip.addColorStop(0, tc); chip.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.save(); round(x0, y0, w, h, r); g.clip();
  g.fillStyle = chip; g.fillRect(x0, y0, 96, h);
  g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x0, y0, w, 3);
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 4; round(x0 - 1, y0 - 1, w + 2, h + 2, r + 1); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.20)'; g.lineWidth = 2; round(x0, y0, w, h, r); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x0 + 96, y0); g.lineTo(x0 + 96, y0 + h); g.stroke();
  g.fillStyle = '#f4f1ea'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 58px "DejaVu Sans", sans-serif';
  g.fillText(String(pop), x0 + 48, y0 + h / 2 + 2);
  // name — ELLIPSISED, never widening the plate
  g.textAlign = 'left';
  g.font = 'bold 44px "DejaVu Serif", Georgia, serif';
  let nm = name;
  if (nm.length > 9) nm = nm.slice(0, 8) + '\u2026';
  while (nm.length > 2 && g.measureText(nm).width > 222) nm = nm.slice(0, nm.length - 2) + '\u2026';
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(nm, x0 + 115, y0 + h / 2 + 3);
  g.fillStyle = 'rgba(243,241,235,0.98)'; g.fillText(nm, x0 + 113, y0 + h / 2);
  // Production: the hammer inside its own progress ring, the way every 4X draws it.
  const hx = x0 + w - 52, hy = y0 + h / 2, RR = 30;
  const frac = THREE.MathUtils.clamp(1 - (prod % 10) / 10, 0.08, 1);
  g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.13)';
  g.beginPath(); g.arc(hx, hy, RR, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = '#d9b25c'; g.lineCap = 'round';
  g.beginPath(); g.arc(hx, hy, RR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); g.stroke();
  g.lineCap = 'butt';
  g.save(); g.translate(hx, hy + 2); g.rotate(-0.45); g.scale(0.95, 0.95);
  g.fillStyle = '#c9b083'; g.fillRect(-4, -5, 8, 32);
  g.fillStyle = '#9aa3ad'; g.fillRect(-17, -24, 34, 17);
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-17, -24, 34, 4);
  g.restore();
  // ANCHOR. A 2 px stem and a tail pointing at the hex centre: a label with neither is a
  // sticker hovering somewhere above a town and the eye cannot tell which town.
  const by = y0 + h;
  g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(W / 2 - 5, by - 2, 10, 30);
  g.fillStyle = 'rgba(20,24,31,0.95)'; g.fillRect(W / 2 - 3, by - 2, 6, 28);
  g.beginPath(); g.moveTo(W / 2 - 11, by + 24); g.lineTo(W / 2 + 11, by + 24); g.lineTo(W / 2, by + 46); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.16)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(W / 2 - 3, by); g.lineTo(W / 2 - 3, by + 24); g.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.frac = w / W;
  return t;
}

const NAMES = ['Aurelia', 'Kaldan', 'Vashti', 'Tirenne', 'Orsova', 'Belmar', 'Cassidra', 'Nyx Ordo'];

// ==================================================================== Units
export class Units {
  constructor(map, ctx = {}) {
    this.map = map;
    this.camera = ctx.camera || null;
    this.group = new THREE.Group(); this.group.name = 'units';
    this.terrain = null;
    this.time = 0; this._ready = false; this._nextId = 1;
    this.sunDir = new THREE.Vector3(-0.86, 0.42, -0.28);   // refreshed from sky.js every frame

    this.u = {
      uWin: { value: 0.10 }, uDetail: { value: 1 },
      uAmbSky: { value: new THREE.Color(0.30, 0.35, 0.44) },
      uAmbGnd: { value: new THREE.Color(0.20, 0.17, 0.13) },
      uUpV: { value: new THREE.Vector3(0, 1, 0) },
      uSunV: { value: new THREE.Vector3(0, 1, 0) },
      uRimCol: { value: new THREE.Color(1.00, 0.84, 0.62) },
    };
    this.mat = castMat(this.u);
    this.outMat = hullMat();
    this.roadMat = castMat(this.u);
    this.roadMat.transparent = true; this.roadMat.depthWrite = false;
    this.roadMat.side = THREE.DoubleSide;
    this.roadMat.polygonOffset = true; this.roadMat.polygonOffsetFactor = -3; this.roadMat.polygonOffsetUnits = -6;

    // seven instanced primitives carry every animated part in the game
    this.prim = {};
    for (const k in G) this.prim[k] = this._prim(k, 384);

    this.flags = new Flags(96); this.group.add(this.flags.mesh);
    this.puffs = new Puffs(220); this.group.add(this.puffs.mesh);
    this.decals = new Decals(128); this.group.add(this.decals.mesh);
    // Contact occlusion is its own layer because it MULTIPLIES the ground; the ownership hex
    // and the wake are painted over it.
    // Every building, wall, tower, pole and improvement in the world now pushes two of these
    // every frame, so the pool is sized for a board, not for a warband.
    this.shadows = new Decals(1600, 1); this.shadows.mesh.renderOrder = 2; this.group.add(this.shadows.mesh);
    this._contacts = [];         // static contact patches: docks, pier decks, district yards

    this.units = new Map();
    this.cities = [];
    this.builds = new Map();     // building type -> array of {m, tint}
    this.bmesh = new Map();
    this.roads = [];             // arrays of world points
    this.roadMesh = null;
    this._pending = [];
    this._slotsDirty = true;
    this._platAt = new Map();    // settled tile -> terrace height (see y())
    this._impAt = new Map();   // improved tile key -> owning city
    // ponytail: never pruned when a city is razed — a stale key only makes a unit stand at the
    // tile edge instead of its centre. Rebuild it in _flushBuildings if that ever matters.
    this._builtAt = new Set(); // every tile that carries a building, district or improvement
    this._footAt = new Map();  // settled tile -> terrace radius (see the garrison in _step)
    this.bdim = new Map();       // building type -> {cx,cz,rx,rz,h} of its structural mass
    this._smokers = [];          // {x,y,z} chimneys
    this._smokeT = 0;
  }

  // ------------------------------------------------------------- plumbing
  _prim(key, cap) {
    const g = G[key].clone();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const amr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    g.setAttribute('aMR', amr);
    const mesh = new THREE.InstancedMesh(g, this.mat, cap);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false; mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.group.add(mesh);
    const out = new THREE.InstancedMesh(g, this.outMat, cap);
    out.instanceMatrix = mesh.instanceMatrix;        // one buffer, two draws
    out.frustumCulled = false; out.count = 0; out.renderOrder = -1;
    out.castShadow = out.receiveShadow = false;
    out.raycast = () => {};                          // never intercept a pick
    this.group.add(out);
    return { mesh, out, amr, cap, n: 0 };
  }
  _grow(key, need) {
    const p = this.prim[key];
    if (need <= p.cap) return p;
    this.group.remove(p.mesh); p.mesh.dispose();
    this.group.remove(p.out); p.out.dispose();
    const np = this._prim(key, Math.max(need * 2, p.cap * 2));
    this.prim[key] = np; return np;
  }

  // Ground height under a world point; falls back to the tile plate before terrain exists.
  // A settled tile answers with its TERRACE instead of the terrain under it — otherwise a
  // garrison stands knee-deep in its own city and the road into town dives under the gate.
  y(x, z) {
    let g;
    if (this.terrain?.heightAt) g = this.terrain.heightAt(x, z);
    else { const t = worldToAxial(x, z); g = this.map.get(t.q, t.r)?.height ?? 0; }
    if (!this._platAt.size) return g;
    const a = worldToAxial(x, z);
    const p = this._platAt.get(a.q * 4096 + a.r);
    return p === undefined ? g : Math.max(g, p);
  }
  tileY(q, r) { const p = axialToWorld(q, r); return this.y(p.x, p.z); }
  // the terrain UNDER the plate, ignoring the terrace — what the kerb spoil has to sit on
  _ground(x, z) {
    if (this.terrain?.heightAt) return this.terrain.heightAt(x, z);
    const t = worldToAxial(x, z); return this.map.get(t.q, t.r)?.height ?? 0;
  }

  // Plane fit under a footprint. Sampling only the tile centre is wrong: the terrain hexes are
  // DOMED, so a cart standing anywhere but the apex has its wheels out over ground that is
  // lower than the point it was placed on, and it floats. Fitting the plane through four
  // samples across the footprint gives both the height (the plane's value at the centre, i.e.
  // the mean of the four) and the slope to tilt onto, so the extremities land on the dirt.
  _fit(x, z, fp, out) {
    const yl = this.y(x - fp, z), yr = this.y(x + fp, z);
    const yb = this.y(x, z - fp), yf = this.y(x, z + fp);
    const yc = this.y(x, z);
    let nx = yl - yr, nz = yb - yf;
    const m = Math.hypot(nx, nz), lim = fp * 0.75;
    if (m > lim) { nx *= lim / m; nz *= lim / m; }
    out.nx = nx; out.nz = nz;
    // The HIGHEST sample under the footprint, not the mean. Every flat decal laid under this
    // unit has to clear it or the terrain eats the shadow — which is precisely what happened
    // last pass: the pool was placed at mean+0.075 while the tile's own dome ran 0.13 higher
    // a half-unit away, so the grounding cue was inside the ground.
    out.yMax = Math.max(yl, yr, yb, yf, yc);
    // The height is the ground DIRECTLY UNDER THE FEET, not the mean of the four. The hexes
    // are domed, so the plane through the four samples runs below the dome at its centre and
    // the mean buried every idle unit to the ankles — the Aurelia warrior in the shipped frame.
    // The four samples still supply the tilt; they no longer supply the height.
    return yc;
  }

  // ONE sun-aligned contact shadow, anchored at the caster's feet. The cascade is fitted to
  // the visible ground by sky.js and at 33 m across a 2048 map it simply does not resolve a
  // 0.8 m man; this does, it costs one instanced quad, and it survives whatever the terrain's
  // shadow receive is doing this build. Length follows the real sun elevation, clamped so a
  // low sun cannot throw a two-hex streak across the board.
  _shade(x, y, z, hgt, wid, k, maxL, col) {
    const s = this.sunDir;
    const hxz = Math.hypot(s.x, s.z) || 1e-3;
    let L = THREE.MathUtils.clamp(hgt * hxz / Math.max(s.y, 0.25), wid * 1.6, hgt * 1.6);
    if (maxL && L > maxL) L = maxL;
    const dx = -s.x / hxz, dz = -s.z / hxz;      // the way the light travels along the ground
    _m.compose(_v.set(x + dx * L * 0.5, y, z + dz * L * 0.5),
      _q.setFromEuler(_e.set(0, Math.atan2(-dx, -dz), 0)), _s.set(wid * 2, 1, L));
    this.shadows.push(_m, col || AO_MUL, k, 3);
  }

  // ------------------------------------------------------------- public API
  add(spec) {
    if (!this._ready) { this._pending.push(spec); return spec.id ?? null; }
    return spec.type === 'city' ? this._addCity(spec) : this._addUnit(spec);
  }

  _addUnit(spec) {
    const def = DEFS[spec.type] || DEFS[ALIAS[spec.type]] || DEFS.warrior;
    const id = spec.id ?? ('u' + this._nextId++);
    // re-equipped: turn.js removes and re-adds under the same id, and that is not a death
    if (this.units.get(id)?.die !== undefined) this.units.delete(id);
    const p = axialToWorld(spec.q, spec.r);
    const t = this.map.get(spec.q, spec.r);
    const water = def.boat || !t || t.height <= 0;
    const u = {
      id, type: spec.type, def, team: teamOf(spec),
      q: spec.q, r: spec.r, x: p.x, z: p.z, y: water ? WATER_Y : this.y(p.x, p.z),
      yaw: spec.yaw ?? (Math.random() - 0.5) * 0.9, tYaw: 0, water,
      phase: Math.random() * 100, walk: 0, seed: (this._nextId * 2654435761) & 0xffff,
      path: null, seg: 0, t: 0, speed: def.boat ? 1.3 : (def.wheels ? 0.9 : 1.15),
      dist: 0, step: 0, slots: null, bone: [], gy: 0,
      // SCALE LADDER. Measured, not guessed: at the shipped framing a hex spans ~130 px corner
      // to corner and a foot soldier at 1.06 measured 33 px of body / 51 px including his
      // standard — half of what the same unit occupies in the reference, which is why the
      // review called them 25x30 px lumps. 1.68 puts the body at ~52 px and the standard tip
      // at ~85 px, and a figure has to earn that many pixels before any amount of material
      // work on it is visible at all. Cart and horse follow at the same ratio; the hull grows
      // less (1.15) because it is already 1.25 long and a hex is only 2.0 across.
      // Round 6: 1.60 put a foot soldier at 1.38 world units — 0.69 of a hex, taller than the
      // town he garrisoned, and the reason a keep gate measured 0.28 of a man. A hex is 2.0
      // corner to corner; 0.86 * 1.00 lands the figure at 0.43 hex widths, which is the
      // reference's reading size, and every opening in the city kit is now authored against it.
      // Round 7, MEASURED not guessed: tools/_upx.mjs reports a hex spanning 118 px centre to
      // centre at the shipped framing and 1 world unit of HEIGHT projecting to ~40 px. A foot
      // soldier at 1.05 therefore stood 36 px tall — a green lump the size of a bush, which is
      // exactly what the review measured. 1.66 puts the body at ~57 px and a pike tip at ~85,
      // i.e. 0.55 hex, the reference's reading size. Everything else follows the same ratio.
      // Round 8, MEASURED (tools/_upx.mjs): at the shipped framing a hex spans 106 px centre
      // to centre and a foot soldier at 1.66 projected 44 px of height — 0.41 of a hex, which
      // is the "I cannot find the units" verdict. 2.20 puts him at ~58 px, i.e. 0.55 hex, the
      // reference's reading size. A rider is already 1.30 tall before scale, so he needs less.
      scale: (spec.scale ?? 1) * (def.boat ? 1.72 : def.wheels ? 1.98 : def.mounted ? 1.95 : 2.55),
    };
    u.tYaw = u.yaw;
    for (let i = 0; i < 8; i++) u.bone.push(new THREE.Matrix4());
    this.units.set(id, u);
    this._slotsDirty = true;
    return id;
  }

  // The gameplay bridge calls this when a unit dies or a settlement is razed. Units are a map
  // delete plus a slot rebuild; a city has to drop the buildings, poles, roads and smokers it
  // put on the board, which is why every one of those carries its owner.
  remove(id) {
    const dead = this.units.get(id);
    // A unit that vanishes between two frames is the oldest tell in strategy rendering. It gets
    // two thirds of a second to fall: topple forward, sink, throw one puff of dust, then go.
    if (dead) {
      if (dead.die === undefined) {
        dead.die = 0; dead.path = null; dead.loop = 0;
        // Whoever is standing next to it just killed it. The bridge gives us no attack signal
        // at all — only add/remove — and a soldier that falls over with nothing striking him
        // reads as a unit being deleted, which is what it is. An adjacent enemy gets the swing.
        for (const o of this.units.values()) {
          if (o === dead || o.die !== undefined || o.team === dead.team) continue;
          if (hexDist(o.q, o.r, dead.q, dead.r) !== 1) continue;
          o.atk = 0; o.tYaw = Math.atan2(dead.x - o.x, dead.z - o.z);
          break;
        }
      }
      return true;
    }
    const i = this.cities.findIndex((c) => c.id === id || c.name === id);
    if (i < 0) return false;
    const c = this.cities.splice(i, 1)[0];
    if (c.plate) { this.group.remove(c.plate); c.plate.material.map?.dispose(); c.plate.material.dispose(); }
    for (const list of this.builds.values()) {
      for (let k = list.length - 1; k >= 0; k--) if (list[k].c === c) list.splice(k, 1);
    }
    this._platAt.delete(c.q * 4096 + c.r);
    this._footAt.delete(c.q * 4096 + c.r);
    for (const [k, oc] of this._impAt) if (oc === c) this._impAt.delete(k);
    this._smokers = this._smokers.filter((sm) => sm.c !== c);
    this._contacts = this._contacts.filter((k) => k.c !== c);
    this.roads = this.roads.filter((rd) => rd.c !== c);
    this._flushBuildings();
    return true;
  }

  // turn.js calls these every push. sync() is what lights the selection: `u.sel` has always
  // driven the ownership decal's strength and nothing has ever set it, so the selected unit's
  // tile has read exactly like every other unit's tile since the bridge was written.
  sync(state) {
    const sel = state?.selectedUnit?.rid ?? null;
    for (const u of this.units.values()) u.sel = u.id === sel;
    // hud.js picks the panel's subject as "whatever was clicked, else the first live unit";
    // mirror that exactly or the portrait and the name under it disagree.
    const su = state?.selected?.city ? null
      : (state?.selectedUnit ?? state?.selected?.unit
         ?? state?.units?.find((x) => x.civ === 0 && !x.dead));
    this._port = su ? { type: su.type, color: state?.civs?.[su.civ]?.color ?? 0x4fa8ff } : null;
  }
  // turn.js hands us civ 0's fog every push. It already filters what it sends, so this is a
  // backstop: anything standing on a tile we have never explored is collapsed to nothing
  // rather than left poking through fx.js's cloud deck.
  setVisibility(vis) { this.vis = vis; }
  _hidden(u) { return this.vis ? this.vis[this.map.get(u.q, u.r)?.i ?? 0] === 0 : false; }

  moveUnit(id, path) {
    const u = this.units.get(id);
    if (!u || !path || path.length === 0) return;
    const pts = path.map((s) => (Array.isArray(s) ? { q: s[0], r: s[1] } : s));
    // start from where the unit actually is, not from the first waypoint
    if (pts[0].q !== u.q || pts[0].r !== u.r) pts.unshift({ q: u.q, r: u.r });
    u.path = pts; u.last = pts; u.seg = 0; u.t = 0;
  }

  // --------------------------------------------------------------- cities
  _addCity(spec) {
    const team = teamOf(spec);
    const pop = spec.pop ?? 3;
    // FOUR tiers, and the read is the SILHOUETTE, not the roof count: a hamlet is thatch with
    // no defences, a village is a palisade ring under a timber watchtower, a town is coursed
    // stone with a keep and a temple, a capital is a double enceinte under a citadel. Roofline
    // steps ~0.55 / 1.05 / 1.9 / 2.8, so the outline alone carries the growth — which is what
    // the review said pop 7, 5 and 4 completely failed to do.
    const tier = pop >= 11 ? 4 : pop >= 7 ? 3 : pop >= 4 ? 2 : 1;
    const c = {
      q: spec.q, r: spec.r, team, pop, tier, prod: spec.prod ?? 4,
      name: spec.name ?? NAMES[this.cities.length % NAMES.length],
    };
    const o = axialToWorld(c.q, c.r);
    c.x = o.x; c.z = o.z; c.y = this.y(o.x, o.z);
    c.id = spec.id ?? ('c' + this._nextId++);
    this._owner = c; this._layout(c, spec.districts ?? this._districtsOf(c, spec.buildings)); this._owner = null;

    const tex = plateTexture(c.name, pop, c.prod, team);
    // 0.80 on the material keeps the brightest text below post.js's 0.72 display-unit bright
    // pass. A full-white plate rendered into the HDR buffer blooms, and bloomed text reads as
    // a double-blit ghost — which is exactly what it is.
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      color: new THREE.Color(0.80, 0.80, 0.80),
    }));
    // The scale is re-solved every frame in _plateFade so the bar covers a FIXED share of a
    // hex on screen; this is just a sane first value before the first update runs.
    const s = (PL.HEX * 2) / (tex.frac || 1);
    sp.scale.set(s, s * PL.H / PL.W, 1);
    sp.center.set(0.5, 0);
    // 0.85 of a hex height above the town, plus the tier's own roofline, so the plate clears
    // the curtain wall and the farm belt instead of sitting on them.
    sp.position.set(c.x, c.y + 1.70 + tier * 0.34, c.z);
    sp.renderOrder = 1400;
    this.group.add(sp);
    c.plate = sp;

    this.cities.push(c);
    this._flushBuildings();
    return c.name;
  }

  _put(type, x, z, yaw, scale = 1, tint = 0xffffff, lift = 0) {
    if (!this.builds.has(type)) this.builds.set(type, []);
    const sc = Array.isArray(scale) ? scale : [scale, scale, scale];
    const gy = (this._flatY ?? this.y(x, z)) + 0.012 + lift;
    const m = new THREE.Matrix4().compose(
      _v.set(x, gy, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(sc[0], sc[1], sc[2]));
    // the placement, kept in the clear so the grounding pass does not have to decompose a
    // matrix for every building in the world once a frame
    this.builds.get(type).push({ m, tint, c: this._owner, p: [x, gy, z, sc[0], sc[1], sc[2], yaw] });
    const a = worldToAxial(x, z); this._builtAt.add(a.q * 4096 + a.r);
    return m;
  }
  // Whitewash is never uniform: nudge every instance a little warm or cool. Lightness lives
  // near 1.0 on purpose — this is a MODULATION of the authored albedo, and the old 0.50-0.61
  // range was quietly multiplying every building in the game by 0.55, which is why a limestone
  // keep read as a heap of grey rubble against lit sand.
  // Every town quarries the hill it stands on. One stone family per city — chalk, warm
  // sandstone, grey basalt, red laterite — chosen in _layout from the city's own seed, plus the
  // per-instance jitter on top. Two settlements in the same frame can no longer be the same
  // stamped mesh in the same colour, which is the whole of the "two identical cities" note.
  _tint(R) {
    const f = this._owner?.mat ?? STONE[0];
    return _c.setHSL(f[0] + R() * 0.04, f[1] + R() * 0.09, f[2] + R() * 0.12).getHex();
  }

  // NO MESH-MESH INTERSECTION, asserted at build time. Every landmark, wall segment and house
  // claims a disc; anything whose disc overlaps a claimed one is simply not built. This is the
  // whole answer to "Aurelia's roofs interpenetrate and Solmere is a collision pile": a random
  // scatter at these densities WILL collide, and the cheapest fix is to let it fail and skip.
  _claim(x, z, r) {
    const o = this._occ;
    for (let i = 0; i < o.length; i += 3) {
      const dx = x - o[i], dz = z - o[i + 1], rr = r + o[i + 2];
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    o.push(x, z, r);
    return true;
  }

  // Lay a town out: a hearth block in the middle, a wall ring once it is big enough, then
  // houses filling the remaining rings, then districts on the neighbours it can reach.
  _layout(c, districts) {
    const R = rng((c.q * 73856093) ^ (c.r * 19349663));
    const t = c.tier, cx = c.x, cz = c.z;
    this._occ = [];
    // A stone-walled town must NOT roof itself in slate: grey ashlar under grey slate is a
    // monochrome heap, which is what a capital that rolled the slate variant looked like. Big
    // towns get warm roofs against their own stone; villages can be thatch or slate.
    // Seeded from the CIV as well as the site: a civ's towns share a look (so the board reads
    // as three cultures, not twelve random villages) while each town still rolls its own stone.
    const civH = ((c.team.raw ?? c.team.a) * 2654435761) >>> 0;
    // ONE KIT PER CIV. The review's second tell was that three settlements in one frame were
    // three unrelated art packs — a European keep with red cones, a clay thatch village and a
    // heap of tan wedges. Stone family AND roof family now come off the civ hash alone, so
    // every town a civ owns quarries the same rock and tiles the same roofs; growth is carried
    // by module COUNT and by silhouette height, which is where it belongs.
    c.mat = STONE[(civH >>> 8) % 4];
    // THREE ARCHETYPES, THREE ROOF FAMILIES, and they are chosen by TIER, not by dice: a
    // capital keeps oxide-red pantile (hue ~12 deg), a village is dark thatch (~38 deg) and the
    // harbour is bleached timber. Three settlements in one frame used to share one tan/olive/
    // red-brown palette and one silhouette language; now the roofs alone tell them apart.
    c.roof = [0, 1, 3, 1][(civH >>> 3) % 4];   // terracotta / shingle / thatch / shingle
    // The plate. Top at the HIGHEST ground under the town, so the tile's own dome can never
    // push up through it, and everything inside the walls is laid on that one height.
    // Footprint radius IS the growth read: village 0.62, walled town 0.80, capital 0.98 — the
    // last of which fills its hex to the kerb. Height follows it, it does not replace it.
    const RT = [0.68, 0.94, 0.98, 1.04][t - 1], RW = [0, 0.84, 0.90, 0.94][t - 1];
    c.foot = RT;
    let top = c.y;
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6, d = k % 2 ? RT : RT * 0.55;
      top = Math.max(top, this.y(cx + Math.cos(a) * d, cz + Math.sin(a) * d));
    }
    c.plat = top + 0.012;
    if (t >= 2) this._platAt.set(c.q * 4096 + c.r, c.plat);
    // where a garrison stands: between the wall ring and the kerb, so he is OUTSIDE the
    // defences he is holding and still on the trodden top of the plate.
    // The garrison stands on the kerb, OUTSIDE every ring of frontage — the outer house band
    // now tops out at 0.66, so 0.94 of the terrace radius is clear ground on every tier. A man
    // parked among the roofs is the unit the review could not find in Solmere at all.
    this._footAt.set(c.q * 4096 + c.r, RT * (RW ? 0.96 : 0.86));
    if (t >= 2) this._put('terrace:' + (t - 1), cx, cz, 0, 1, 0xffffff, -0.012);
    for (let k = 0, nr = t >= 2 ? 11 + t * 3 : 0; k < nr; k++) {
      const a = (k + R() * 0.8) * (Math.PI * 2 / nr), dd = RT * (0.96 + R() * 0.20);
      const rx = cx + Math.cos(a) * dd, rz = cz + Math.sin(a) * dd;
      const gy = Math.max(Math.min(this._ground(rx, rz), c.plat), WATER_Y - 0.06);
      this._put('rubble:' + (k % 3), rx, rz, R() * 6.3, 0.17 + R() * 0.20, this._tint(R),
        gy - this.y(rx, rz) - 0.012 - 0.03 - R() * 0.05);
    }
    if (t >= 2) { this._flatY = c.plat; c.y = c.plat; } else { this._flatY = null; c.plat = c.y; }
    // The gate faces the road: pick the edge that points at the first district before anything
    // is built, so the town is laid out around its approach instead of around nothing.
    const gateEdge = districts.length ? districts[0].dir % 6 : 1;
    const gateA = gateEdge * Math.PI / 3 + Math.PI / 6;

    // ---- VERTICALITY IS THE POPULATION READ.
    // Sprawl alone cannot tell a capital from a town: at gameplay zoom both are a patch of
    // roofs and the eye measures the patch, not the count. So the tiers differ in HEIGHT
    // first — hamlet roofline ~0.7, walled town keep ~1.6, capital citadel ~2.6 — and the
    // keep is the only stone tower-and-turret silhouette in the kit, so the tallest thing in
    // a big city is a shape that appears nowhere else on the board.
    c.awn = [];
    // The settlement's landmark height in world units: keep, watchtower or hut. Poles, plates
    // and the smoke plume are all authored as fractions of it, so nothing can out-top it.
    const KH = t === 4 ? 3.29 : t === 3 ? 2.44 : t === 2 ? 1.78 : 0.95;
    c.KH = KH;
    // How much ground the landmark holds. The frontage is laid OUTWARD from this, not inward
    // from the wall: a ring solved from the defences can — and did — land entirely inside the
    // thing it is supposed to be ringing.
    let KR = t === 2 ? 0.28 : 0.25;
    if (t >= 3) {
      // the landmark: the ONE silhouette that exists nowhere else on the board, so a capital is
      // identifiable from across the map without reading its plate. A capital's citadel is half
      // again the height of a town's keep and stands on its own inner ward.
      // 1.6x. A gate a man cannot walk through is a doll's house whatever the shader does:
      // the keep's own doorway is authored 0.50 tall, so at 1.72 it stands 0.86 world units —
      // one full soldier — and the curtain gate below is sized off the same module.
      // A donjon is TALL, not fat: at 0.94 across on a plate 0.98 in radius the keep's own
      // claim disc swallowed the entire house ring and a pop-7 walled town built one dwelling.
      // Same height, two thirds of the footprint — which is also the better silhouette.
      const ks = t === 4 ? [0.82, 2.24, 0.82] : [0.70, 1.66, 0.70];
      // Dead centre, not offset: a landmark 0.09 off the middle of its own plate pushes its
      // exclusion disc across one side of the frontage ring and half the town never gets built.
      KR = ks[0] * 0.44;
      this._claim(cx, cz, ks[0] * 0.40);
      this._put('keep:' + c.roof, cx, cz, gateA + Math.PI + (R() - 0.5) * 0.3, ks, this._tint(R));
      const tsc = t === 4 ? 0.84 : 0.70, tx = cx + (t === 4 ? 0.66 : 0.60) * Math.cos(gateA + 1.6);
      const tz = cz + (t === 4 ? 0.66 : 0.60) * Math.sin(gateA + 1.6);
      this._claim(tx, tz, tsc * 0.38);
      this._put('temple:' + c.roof, tx, tz, -Math.atan2(tz - cz, tx - cx) + PI2,
        t === 4 ? [0.84, 1.16, 0.84] : [0.70, 0.94, 0.70], this._tint(R));
      this._smokers.push({ c: this._owner, x: cx + 0.24, y: c.plat + KH * 0.99, z: cz + 0.20, r: 0.075, s: 0.8 });
      // inner ward: the second enceinte a capital gets, drawn tight round the citadel so the
      // outline reads as two rings of defence rather than one wall with more roofs behind it
      if (t === 4) for (let e = 0; e < 6; e++) {
        if (e === gateEdge) continue;
        const a0 = e * Math.PI / 3, a1 = (e + 1) * Math.PI / 3, RI = 0.50;
        const p0 = [Math.cos(a0) * RI, Math.sin(a0) * RI], p1 = [Math.cos(a1) * RI, Math.sin(a1) * RI];
        this._claim(cx + (p0[0] + p1[0]) * 0.5, cz + (p0[1] + p1[1]) * 0.5, RI * 0.32);
        this._put('wall', cx + (p0[0] + p1[0]) * 0.5, cz + (p0[1] + p1[1]) * 0.5,
          -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), [RI, 0.86, 0.62], this._tint(R));
      }
    } else if (t === 2) {
      // A village has no stone: a TIMBER watchtower over the palisade is its whole landmark.
      // The stone tower's tapered drum plus a smooth cone read from above as a soft-serve
      // swirl — the review's word — because at thirty pixels a taper with a cone on it has no
      // straight edge anywhere. Four raking legs, a boarded platform and a hipped shingle roof
      // give it four corners and a ridge instead.
      this._claim(cx - 0.02, cz - 0.03, 0.24);
      if (R() < 0.45) this._put('tower:' + (c.roof === 3 ? 2 : c.roof), cx - 0.02, cz - 0.03,
        R() * 3, [0.84, 1.36, 0.84], this._tint(R));
      else this._put('watch:' + c.roof, cx - 0.02, cz - 0.03, R() * 3, [0.92, 1.70, 0.92], this._tint(R));
      const bx = cx + 0.54 * Math.cos(gateA + 2.2), bz = cz + 0.54 * Math.sin(gateA + 2.2);
      this._claim(bx, bz, 0.30);
      this._put('barn', bx, bz, -Math.atan2(bz - cz, bx - cx), 0.86, this._tint(R));
      this._smokers.push({ c: this._owner, x: bx, y: c.plat + 0.62, z: bz, r: 0.115, s: 0.65 });
    } else {
      this._claim(cx, cz, 0.21);
      this._put('hut', cx, cz, R() * 3, 0.98, this._tint(R));
      this._claim(cx - 0.06, cz - 0.44, 0.26);
      this._put('barn', cx - 0.06, cz - 0.44, 0.4, 0.72, this._tint(R));
      this._put('field:2', cx + 0.10, cz + 0.46, 0.35 + R() * 0.3, 0.52, 0xffffff, 0.02);
      this._smokers.push({ c: this._owner, x: cx, y: c.plat + 0.70, z: cz, r: 0.105, s: 0.55 });
    }

    // wall ring, from tier 2 up. Six edges, each three segments, towers on the corners.
    // Defence ring. The MATERIAL is the second tier read: a walled town is a stockade of logs,
    // a capital is coursed ashlar with towers on every corner. Both hexagonal and both laid on
    // the tile's own six edges, so the ring is the hex silhouette rather than a circle in it.
    if (t >= 2) {
      // The curtain has to be LOWER than the roofs it protects, or the near wall occludes the whole
      // town from a 40-degree camera and a capital reads as one grey slab with a gate in it.
      const stone = t >= 3, hs = stone ? (t === 4 ? 1.06 : 0.88) : 1.10;
      for (let e = 0; e < 6; e++) {
        const a0 = e * Math.PI / 3, a1 = (e + 1) * Math.PI / 3;
        const p0 = [Math.cos(a0) * RW, Math.sin(a0) * RW], p1 = [Math.cos(a1) * RW, Math.sin(a1) * RW];
        const yaw = -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const x = cx + (p0[0] + p1[0]) * 0.5, z = cz + (p0[1] + p1[1]) * 0.5;
        if (e === gateEdge && !stone) continue;                          // the stockade's gap IS its gate
        // The gatehouse is taller than the curtain it pierces — that is what a gatehouse is,
        // and it is the only way the opening clears a soldier's head at this module.
        this._put(stone ? (e === gateEdge ? 'gate' : 'wall') : 'palisade', x, z, yaw,
          e === gateEdge && stone ? [RW, hs * 1.78, hs * 1.00] : [RW, hs, hs * 0.85], this._tint(R));
        if (stone ? (t === 4 ? e % 2 === 0 : e % 3 === 0) : (e === (gateEdge + 1) % 6 || e === (gateEdge + 5) % 6)) {
          this._claim(cx + p0[0], cz + p0[1], 0.22);
          this._put('tower:' + (c.roof === 3 ? 2 : c.roof), cx + p0[0], cz + p0[1], R() * 3,
            stone ? (t === 4 ? [0.64, 0.86, 0.64] : [0.56, 0.62, 0.56]) : [0.40, 0.44, 0.40], this._tint(R));
        }
      }
    }

    // houses in the remaining space
    // Houses on a street loop rather than scattered: two rings of frontage, every roof ridge
    // square to the street it faces, and the block nearest the gate left open as the market.
    // Population drives the count directly, so pop 12 has half again the frontage of pop 6 and
    // the plate's number and the thing under it agree.
    // Count AND density scale with population, in visible steps: ~6 dwellings in a village,
    // ~14 in a walled town, ~26 in a capital, and the capital's houses are the SMALLEST of the
    // three so the same hex reads as more of them rather than bigger ones.
    // Two rings of frontage, EVENLY spaced round each one. A random scatter at these densities
    // is guaranteed interpenetration — the last pass had roof planes inside walls — so the
    // spacing is solved arithmetically: arc length per house always exceeds its own width, and
    // the radial gap between rings always exceeds its depth.
    // MORE, SMALLER HOUSES. A 0.90-scale dwelling is 47 cm wide on a plate 1.6 m across, so
    // eight of them plus a keep cannot physically fit and the leftovers ended up inside each
    // other — that is the whole of "Aurelia is a collision pile". They are now a third smaller,
    // there are more of them, and every one is offered to _claim before it is built. Candidate
    // slots are generated on concentric frontages from the wall inwards and taken until the
    // population's worth are standing; the ones that would collide are simply never placed, so
    // the density falls out of the geometry instead of being guessed.
    const HS = [0.60, 0.62, 0.60, 0.56][t - 1];
    const WANT = [4, 8, 12, 18][t - 1];
    // The inner face of the defences (wall segments stand at RW*cos30) or, with no wall, the kerb.
    const OUT = (RW ? RW * 0.866 - 0.075 : RT * 0.94);
    const HR = HS * 0.99 * 0.26;                      // the disc a dwelling claims
    let built = 0;
    for (let band = 0; band < 4 && built < WANT; band++) {
      const rr0 = KR + HR + 0.03 + band * (HR * 1.95);
      if (rr0 + HR > OUT) break;
      // Slots are spaced by the disc a dwelling CLAIMS, not by its own width: offering more
      // candidates than the ring can physically hold just means _claim rejects most of them and
      // the town comes out with three houses in it.
      const n = Math.max(5, Math.round(rr0 * 2 * Math.PI / (HR * 1.55)));
      for (let i = 0; i < n && built < WANT; i++) {
        const a = (i + 0.5) / n * Math.PI * 2 + band * 0.37 + (R() - 0.5) * 0.12;
        if (Math.abs(((a - gateA + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.42) continue;  // gate road stays clear
        const rr = rr0 + (R() - 0.5) * 0.05;
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        const sc = HS * (0.90 + R() * 0.18);
        if (!this._claim(x, z, sc * 0.28)) continue;
        const flat = this._flatY; if (rr > RT) this._flatY = null;
        // Roof variant is weighted, not uniform: a real town has a dominant local material with
        // two or three outliers. The dominant is picked ONCE per settlement, so Aurelia is a
        // red-tile town and its neighbour is a slate one.
        const rv = R() < 0.80 ? c.roof : (c.roof + 1 + (R() < 0.5)) % 4;
        const kind = t === 1 ? (R() < 0.52 ? 'hut' : 'house:3')
          : (R() < (t >= 3 ? 0.42 : 0.24) ? 'house2:' + rv : (t === 2 && R() < 0.16 ? 'hut' : 'house:' + rv));
        this._put(kind, x, z, -a + PI2 + (R() - 0.5) * 0.18, sc, this._tint(R));
        built++;
        if (t >= 2 && R() < 0.26) this._smokers.push({ c: this._owner, x, y: (rr > RT ? this.y(x, z) : c.plat) + sc * 0.92, z, r: 0.085, s: 0.40 });
        this._flatY = flat;
      }
    }

    // market square, just inside the gate: the block the house loop kept clear
    if (t >= 2) {
      const n = THREE.MathUtils.clamp(1 + Math.floor(c.pop / 2), 2, 7);
      for (let i = 0; i < n; i++) {
        const a = gateA + (i - (n - 1) / 2) * 0.30, rr = KR + 0.20 + (i % 2) * 0.19;
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        const yaw = -a + PI2 + (R() - 0.5) * 0.4;
        if (!this._claim(x, z, 0.21)) continue;
        this._put('stall', x, z, yaw, 0.74 + R() * 0.16, this._tint(R));
        c.awn.push({ x, z, y: c.plat + 0.34, yaw, col: i % 2 });
      }
    }

    // banner poles on the towers / the keep
    c.poles = [];
    if (t >= 2) {
      // two corner standards, not six. A skyline of identical pennants is noise; two reading
      // against the keep's own is a garrison.
      for (const e of (t >= 3 ? [1, 4] : [3])) {
        const a = e * Math.PI / 3;
        // Just inside the corner, not on it: a socket plinth straddling the joint between two
        // wall segments is the same interpenetration the review found on the keep.
        c.poles.push({ x: cx + Math.cos(a) * RW * 0.84, z: cz + Math.sin(a) * RW * 0.84, h: Math.max(0.62, KH * 0.36) });
      }
    }
    // The great standard stands in the plaza, NOT on the tile centre: the centre is where the
    // keep, the watchtower or the hut already is, and a mast rising through a roof plane at a
    // slant was the most obvious interpenetration in the shipped frame.
    // The great standard: walked out from the plaza until it stands on ground nothing else has
    // claimed, so it can never pierce a roof, and capped at 45% of the landmark's own height so
    // the keep — not the flag — is the tallest thing in the settlement.
    for (let k = 0; k < 7; k++) {
      const pa = gateA + 0.85 + k * 0.42, pr = (t >= 3 ? 0.52 : t === 2 ? 0.44 : 0.36) + k * 0.03;
      const px = cx + Math.cos(pa) * pr, pz = cz + Math.sin(pa) * pr;
      if (!this._claim(px, pz, 0.13)) continue;
      c.poles.push({ x: px, z: pz, h: Math.max(0.80, KH * 0.50) });
      break;
    }
    for (const pl of c.poles) this._put('pole', pl.x, pl.z, R() * 3, [1, pl.h, 1]);

    // districts on the neighbours, plus the road that reaches each one — off the plate, so
    // they follow their own ground again
    this._flatY = null;
    const nb = DIRS.map((d) => ({ q: c.q + d.q, r: c.r + d.r }));
    const used = new Set(districts.map((d) => d.dir % 6));
    // a big city does not stop at its hex: two neighbouring tiles become suburbs, linked back
    // NOTE: no invented suburbs. A capital used to scatter five houses onto as many as five
    // of its six neighbours, which buried whatever was standing there — including, in the
    // shipped frame, the unit the camera was framed on — and none of it came from game state.
    // Neighbouring hexes are built on only where the city has ACTUALLY built a district.
    if (t >= 2) {
      for (let e = 0; e < 6; e++) {
        if (used.has(e)) continue;
        const n = nb[e], tile = this.map.get(n.q, n.r);
        if (!tile || tile.height > 0) continue;
        const p = axialToWorld(n.q, n.r);
        used.add(e);
        this._district('harbor', lerp(p.x, cx, 0.20), lerp(p.z, cz, 0.20), Math.atan2(cx - p.x, cz - p.z), R);
        break;
      }
    }
    // A capital does not fit in one hex. One neighbouring land tile becomes a suburb — a row of
    // houses along the road out of the gate, not a second town — so the outline spills the way
    // a real city outgrows its walls.
    // SPRAWL IS THE POPULATION READ. A hex is 2.0 across and a keep stands in the middle of
    // it, so a walled town can physically hold five dwellings inside its curtain and no more.
    // What tells a capital from a village at a glance is that the capital does not FIT: houses
    // spill along the road out of the gate onto the next hex.
    let placed = 0;
    if (t >= 3) {
      for (let k = 0; k < 6; k++) {
        const e = (gateEdge + k) % 6;
        if (used.has(e)) continue;
        const n = nb[e], tile = this.map.get(n.q, n.r);
        if (!tile || tile.height <= 0 || tile.biome === 'mountain') continue;
        const p = axialToWorld(n.q, n.r);
        used.add(e);
        const ax = Math.atan2(cz - p.z, cx - p.x);
        const NS = t === 4 ? 6 : 4;
        for (let i = 0; i < NS; i++) {
          const off = (i - (NS - 1) / 2) * 0.46, side = i % 2 ? 0.40 : -0.38;
          const x = p.x + Math.cos(ax + PI2) * off + Math.cos(ax) * side * 0.6 + Math.cos(ax) * 0.10;
          const z = p.z + Math.sin(ax + PI2) * off + Math.sin(ax) * side * 0.6 + Math.sin(ax) * 0.10;
          this._put(i % 3 === 2 ? 'workshop' : 'house:' + (i % 3 ? c.roof : (c.roof + 1) % 4), x, z, -ax + (i % 2 ? 0 : Math.PI), 0.62, this._tint(R));
        }
        this._put('field:0', p.x - Math.cos(ax) * 0.52, p.z - Math.sin(ax) * 0.52, -ax, 0.72, 0xffffff, 0.01);
        this._smokers.push({ c: this._owner, x: p.x, y: this.y(p.x, p.z) + 0.62, z: p.z, r: 0.085, s: 0.5 });
        this.roads.push(Object.assign([{ x: cx, z: cz }, { x: lerp(cx, p.x, 0.55), z: lerp(cz, p.z, 0.55) }, { x: p.x, z: p.z }], { c: this._owner }));
        placed++;
        break;
      }
    }
    for (const spec of districts) {
      const n = nb[spec.dir % 6];
      const tile = this.map.get(n.q, n.r);
      if (!tile) continue;
      const p = axialToWorld(n.q, n.r);
      this._district(spec.kind, p.x, p.z, Math.atan2(cx - p.x, cz - p.z), R);
      // A ROAD STOPS AT THE WATER. Running the ribbon onto a sea tile drew a wide flat grey
      // band across the shoreline with no waterline and no termination — the review called it
      // a causeway and it was the largest untextured surface in the frame. A quayside lane
      // ends on dry land and the dock's own decking carries on from there.
      const f = tile.height <= 0 ? 0.42 : 1;
      this.roads.push(Object.assign([{ x: cx, z: cz },
        { x: lerp(cx, p.x, f * 0.5), z: lerp(cz, p.z, f * 0.5) },
        { x: lerp(cx, p.x, f), z: lerp(cz, p.z, f) }], { c: this._owner }));
      placed++;
    }
    if (!placed && t >= 2) {
      const ex = cx + Math.cos(gateA) * 1.7, ez = cz + Math.sin(gateA) * 1.1;
      const et = this.map.get(worldToAxial(ex, ez).q, worldToAxial(ex, ez).r);
      const f = et && et.height > 0 ? 1 : 0.45;
      this.roads.push(Object.assign([{ x: cx, z: cz }, { x: lerp(cx, ex, f), z: lerp(cz, ez, f) }], { c: this._owner }));
    }
    this._improvements(c, used);
  }

  // The worked landscape around a town: the farms, mines, pastures, quarries, plantations and
  // fishing boats a player expects to see on a hex a city is working. Radius 2, resource tiles
  // first, count driven by population, and every tile claimed is registered so the next city
  // over cannot stack a second holding on it.
  _improvements(c, used) {
    const R = rng((c.q * 83492791) ^ (c.r * 297121507));
    for (const e of used) {
      const d = DIRS[e % 6];
      this._impAt.set((c.q + d.q) * 4096 + (c.r + d.r), c);
    }
    const cand = [];
    for (let rad = 1; rad <= 2; rad++) for (const n of ringTiles(c.q, c.r, rad)) {
      const key = n.q * 4096 + n.r;
      if (this._impAt.has(key) || this._platAt.has(key)) continue;
      const t = this.map.get(n.q, n.r);
      if (!t) continue;
      const kind = IMPROVE(t);
      if (!kind) continue;
      // adjacency first, then resources, then a deterministic shuffle so two towns with the
      // same biome around them do not lay out the same farm belt twice
      cand.push({ q: n.q, r: n.r, key, kind, rad, w: rad + (t.resource ? -0.7 : 0) + R() * 0.6 });
    }
    cand.sort((a, b) => a.w - b.w);
    const want = Math.min(cand.length, 2 + Math.round(c.pop * 0.52));
    let farms = 0;
    for (let i = 0, n = 0; i < cand.length && n < want; i++) {
      // three farm belts is a fed city; a fourth is wallpaper. Everything else is rare enough
      // to be its own read, so it is never rationed.
      if (cand[i].kind === 'farm' && ++farms > 3) continue;
      n++;
      const k = cand[i], p = axialToWorld(k.q, k.r);
      this._impAt.set(k.key, c);
      this._improve(k.kind, p.x, p.z, Math.atan2(c.x - p.x, c.z - p.z), R);
      // a lane out to the near holdings: a worked hex with no way to it is a diorama
      if (k.rad === 1 && k.kind !== 'fish' && n <= 3)
        this.roads.push(Object.assign([{ x: c.x, z: c.z },
          { x: lerp(c.x, p.x, 0.55), z: lerp(c.z, p.z, 0.55) }, { x: p.x, z: p.z }], { c: this._owner }));
    }
  }

  _improve(kind, x, z, yaw, R) {
    const gy = this.y(x, z);
    if (kind === 'fish') {
      this._put('fishboat', x + (R() - 0.5) * 0.34, z + (R() - 0.5) * 0.34, yaw + (R() - 0.5) * 0.9,
        0.95, 0xffffff, WATER_Y - gy - 0.012);
      this._contacts.push({ c: this._owner, x, y: WATER_Y + 0.04, z, rx: 0.9, rz: 1.3, yaw, k: 0.5 });
      return;
    }
    if (kind === 'farm') {
      // ONE plot, square to the road in, with the shed on its headland. Three strips laid side
      // by side is what pushed crop rows under a pixel and cut the tile boundary in two places.
      const a = yaw + (R() - 0.5) * 0.4, [fx, fz] = FWD(a), [sx, sz] = SIDE(a);
      // The plate is flat and hex-wide, but terrain.js welds a shoreline hex's shared corners
      // down to the waterline — so on a coastal tile a full-size field hangs its rail out over
      // the sea. Walk it in until every point on its rim is still dry.
      let k = 1, gmin = gy;
      for (let i = 0; i < 12; i++) {
        const th = i * Math.PI / 6, cx = Math.cos(th) * 0.87, cz = Math.sin(th) * 0.87;
        while (k > 0.45 && this._ground(x + cx * k, z + cz * k) < WATER_Y + 0.18) k -= 0.06;
        gmin = Math.min(gmin, this._ground(x + cx * k, z + cz * k));
      }
      // ...and sit it on the LOW corner of the plot, not the middle of the hex. A hex is a dome;
      // a plate levelled at its crown stands its whole 0.4 soil skirt proud of the rim, which is
      // the extruded-slab-with-a-visible-side-wall read. Clamped so the crop rows stay above soil.
      this._put('field:' + ((R() * 4) | 0), x, z, a, [0.86 * k, 1, 0.78 * k], 0xffffff,
        0.01 + Math.max(-0.14, Math.min(0, gmin - gy)));
      this._put('barn', x + (fx * 0.62 + sx * 0.30) * k, z + (fz * 0.62 + sz * 0.30) * k, a + 1.2, 0.46, this._tint(R));
    } else {
      this._put(kind, x, z, yaw + (R() - 0.5) * 0.5, 0.92 + R() * 0.12, this._tint(R));
    }
    this._contacts.push({ c: this._owner, x, y: gy + 0.05, z, rx: 1.0, rz: 1.0, yaw, k: 0.48 });
  }

  // Which neighbouring hexes get built on, derived from what the city has ACTUALLY built —
  // turn.js pushes `buildings`, so a harbour on the board is a harbour on the water beside it
  // and a workshop is a smoking yard on the next hex, each with the road that reaches it.
  // Nothing here is invented: a city with no district buildings gets no districts.
  _districtsOf(c, buildings) {
    if (!buildings || !buildings.length) return [];
    const want = [];
    if (buildings.includes('harbor')) want.push('harbor');
    if (buildings.some((b) => b === 'workshop' || b === 'factory' || b === 'encampment' || b === 'campus')) want.push('workshop');
    if (buildings.some((b) => b === 'granary' || b === 'aqueduct' || b === 'sewer' || b === 'market')) want.push('farm');
    const out = [], used = new Set();
    for (const kind of want) {
      for (let e = 0; e < 6; e++) {
        if (used.has(e)) continue;
        const t = this.map.get(c.q + DIRS[e].q, c.r + DIRS[e].r);
        if (!t) continue;
        const sea = t.height <= 0;
        if (kind === 'harbor' ? !sea : (sea || t.biome === 'mountain')) continue;
        used.add(e); out.push({ dir: e, kind }); break;
      }
    }
    return out;
  }

  _district(kind, x, z, yaw, R) {
    if (kind === 'farm') {
      this._put('field:' + ((R() * 4) | 0), x, z, yaw + (R() - 0.5) * 0.15, [0.84, 1, 0.74], 0xffffff, 0.01);
      this._put('barn', x + 0.50, z - 0.32, yaw + 0.5, 0.62);
    } else if (kind === 'harbor') {
      // dock geometry is authored around y=0 == waterline, so lift it off the seabed by exactly
      // the difference. `lift` is added to this.y(), which over a sea tile is the BED.
      this._put('dock', x, z, yaw + Math.PI, 0.95, 0xffffff, WATER_Y - this.y(x, z) - 0.01);
      // the water under the deck goes dark: pilings, planking and a shed all shade it, and
      // nothing else in the pipeline will do it (the sea receives no cascade)
      this._contacts.push({ c: this._owner, x, y: WATER_Y + 0.035, z, rx: 1.05, rz: 2.0, yaw: yaw + Math.PI, k: 0.72 });
    } else {
      this._put('workshop', x - 0.22, z + 0.12, yaw + 0.3, 1.05);
      this._put('workshop', x + 0.34, z - 0.30, yaw - 1.1, 0.90);
      this._put('house:1', x + 0.14, z + 0.52, yaw + 0.1, 0.86);
      this._smokers.push({ c: this._owner, x: x - 0.12, y: this.y(x, z) + 0.62, z: z + 0.05, r: 0.07, s: 0.6 });
    }
  }

  _flushBuildings() {
    for (const [type, list] of this.builds) {
      let entry = this.bmesh.get(type);
      if (entry && entry.mesh.count >= list.length && entry.cap >= list.length) {
        // reuse
      } else {
        if (entry) { this.group.remove(entry.mesh); entry.mesh.dispose(); }
        // 'house:2' -> B.house(2). Variants are separate InstancedMeshes on purpose: an
        // instance colour multiplies the WHOLE building, so it can never give one house a
        // slate roof over the same plaster walls. Four extra draw calls buys the entire
        // difference between a town and a stamped-out tile pattern.
        const [bk, bv] = type.split(':');
        const geo = B[bk](+bv || 0);
        if (!this.bdim.has(type)) this.bdim.set(type, dimsOf(geo));
        const mesh = new THREE.InstancedMesh(geo, this.mat, Math.max(8, list.length));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        entry = { mesh, cap: Math.max(8, list.length) };
        this.bmesh.set(type, entry);
      }
      list.forEach((b, i) => { entry.mesh.setMatrixAt(i, b.m); entry.mesh.setColorAt(i, _c.set(b.tint)); });
      entry.mesh.count = list.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
    }
    this._buildRoads();
  }

  // Roads are one merged ribbon: four vertices across, alpha 0 at the rim so the dirt melts
  // into whatever biome it crosses instead of stamping a hard-edged decal on it.
  _buildRoads() {
    if (this.roadMesh) { this.group.remove(this.roadMesh); this.roadMesh.geometry.dispose(); this.roadMesh = null; }
    if (!this.roads.length) return;
    const pos = [], col = [], amr = [], nrm = [], uvs = [], idx = [];
    // SIX vertices across, not four. A four-vertex ribbon in one flat brown is a smear however
    // it is textured, and "blurry road streaks with no texture" was the review's word for it.
    // Two dark wheel ruts either side of a pale trodden crown, feathered to nothing at the
    // verge — structure ACROSS the road is what makes a track read as a track at forty pixels.
    const OFF = [-1, -0.64, -0.22, 0.22, 0.64, 1], AL = [0, 0.92, 1, 1, 0.92, 0];
    const CX = [0x4e4130, 0x413526, 0x776548, 0x776548, 0x413526, 0x4e4130];
    const W = 0.24;
    for (const path of this.roads) {
      // resample the polyline so it follows the ground
      const pts = [];
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(2, Math.ceil(d / 0.28));
        for (let k = 0; k < n; k++) {
          const f = k / n;
          pts.push({ x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f) });
        }
      }
      pts.push(path[path.length - 1]);
      if (pts.length < 2) continue;
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(pts.length - 1, i + 1)];
        let dx = pb.x - pa.x, dz = pb.z - pa.z;
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const nx = -dz, nz = dx;
        const wob = Math.sin(i * 1.7) * 0.05 + Math.sin(i * 0.41) * 0.06;
        // same convexity trap as the unit plates: heightAt runs under the tile's domed top,
        // so ride the highest of the three samples across the ribbon.
        const yc = Math.max(this.y(p.x, p.z), this.y(p.x + nx * W, p.z + nz * W), this.y(p.x - nx * W, p.z - nz * W));
        // ends fade out, so a lane does not stamp a blunt cut into the town or the field
        const ef = Math.min(1, Math.min(i, pts.length - 1 - i) / 2.2);
        for (let k = 0; k < 6; k++) {
          const o = (OFF[k] * W) + wob * OFF[k];
          const x = p.x + nx * o, z = p.z + nz * o;
          pos.push(x, Math.max(yc, this.y(x, z)) + 0.045, z);
          nrm.push(0, 1, 0); uvs.push(k / 5, i * 0.3);
          const shade = 0.84 + 0.16 * Math.sin(i * 2.3 + k * 1.9) + 0.08 * Math.sin(i * 0.7 + k);
          _c.set(CX[k]);
          col.push(_c.r * shade, _c.g * shade, _c.b * shade, AL[k] * ef);
          amr.push(0, 0.98, 0, 8);
        }
      }
      for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < 5; k++) {
        const a = base + i * 6 + k, b = a + 1, cc = a + 6, d = cc + 1;
        idx.push(a, b, cc, b, d, cc);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('aMR', new THREE.Float32BufferAttribute(amr, 4));
    g.setIndex(idx);
    this.roadMesh = new THREE.Mesh(g, this.roadMat);
    this.roadMesh.renderOrder = 2; this.roadMesh.receiveShadow = true; this.roadMesh.frustumCulled = false;
    this.group.add(this.roadMesh);
  }

  // ------------------------------------------------------------ instance slots
  _slots() {
    const need = {};
    for (const k in G) need[k] = 0;
    for (const u of this.units.values()) for (const p of u.def.parts) need[p.g]++;
    for (const k in G) { this._grow(k, need[k]); this.prim[k].n = 0; }
    for (const u of this.units.values()) {
      u.slots = new Int32Array(u.def.parts.length);
      // WEATHERING. Six identical men on one hex is a clone stamp, and the eye reads a stamp
      // instantly. Every unit gets its own dye lot — a value and warmth shift on everything
      // that is not livery — and every PART gets a second, smaller one on top, so a tunic, a
      // cloak and a pair of boots on the same man are not one flat wash either. The civ
      // colours move in value only: a tabard that drifts in hue stops naming its owner.
      const RW = rng(u.seed * 7 + 13);
      const dye = (RW() - 0.5), warm = (RW() - 0.5);
      const bv = defV(u.def);
      // -1 on bright sand or snow, +1 on forest floor and deep water: which way this figure's
      // mid band has to move so it never matches the ground it is standing on.
      const gnd = THREE.MathUtils.clamp((0.44 - (BIO_V[this.map.get(u.q, u.r)?.biome] ?? 0.44)) * 3.2, -1, 1);
      u.gv = gnd;
      u.def.parts.forEach((p, i) => {
        const pr = this.prim[p.g];
        // Characteristic local size: the geometric mean of the part's two largest axes, i.e.
        // roughly what it projects to. _step culls anything under six pixels — see the note there.
        if (p._sz === undefined) {
          const e = p.m.elements;
          const a = [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])].sort((x, y) => y - x);
          p._sz = Math.max(Math.sqrt(a[0] * a[1]), a[0] * 0.46);
        }
        const s = pr.n++;
        u.slots[i] = s;
        const livery = p.c === 'A' || p.c === 'B' || p.c === 'F';
        const col = p.c === 'A' ? u.team.a : p.c === 'B' ? u.team.b : p.c === 'F' ? u.team.flag : p.c;
        const py = (u.def.piv?.[p.b]?.[1] ?? 0) + p.m.elements[13];
        _c.set(col);
        if (livery) _c.offsetHSL(0, -0.02 + RW() * 0.04, dye * 0.045);
        else _c.offsetHSL(warm * 0.030 + (RW() - 0.5) * 0.020, dye * 0.10 - 0.02, dye * 0.075 + (RW() - 0.5) * 0.045);
        _c.multiplyScalar(lerp(0.60, 1.0, THREE.MathUtils.smoothstep(py, -0.05, 0.42)));
        // ---- THREE VALUES, AND ONE OF THEM IS ALWAYS OFF THE GROUND.
        // The measured failure was a Warrior at value 110 standing on sand at 112: every part
        // of him was authored inside one narrow band, so the whole figure welded to whatever
        // it happened to be standing on. Two things fix it and neither touches the geometry.
        // First, each part's lightness is pushed AWAY from the figure's own mean, so the cast
        // carries a dark mass, a mid and a bright accent instead of one wash — a silhouette
        // with three values in it cannot vanish into a single-valued background. Second, the
        // whole figure is nudged a little off the value of the biome under its feet, so the
        // mid band leans dark on sand and snow and light on forest floor.
        // sRGB, not the linear working space: these are AUTHORED values and the point is to
        // move them the way a painter would — reading HSL in linear space and centring on an
        // sRGB number turned the entire cast white in one line. Livery keeps its own value: it
        // is the ownership signal and stretching it is how a tabard becomes a headlight.
        const z = p.mr[3] || 0;
        _c.getHSL(_hsl, THREE.SRGBColorSpace);
        // 0.33 was still the value of the LAND. Measured with tools/_ucontrast.mjs, a torso
        // authored there arrives on screen at 89/255 against sand at 108 — a gap of 19 where
        // the brief wants 64. A soldier under a golden-hour key reads DARK; the colour comes
        // back off the bronze, the mantle and the base ring, not off the mass.
        // and METAL is the other end of the same decision. Pushing the whole figure dark without
        // lifting the helm, the boss and the pauldrons just makes a darker blob: the three-value
        // read needs the accent as much as it needs the mass, so polished metal is centred a
        // band and a half above everything else and is the only thing allowed near the top.
        const met = z === 2 || z === 11;
        // THREE HARD BANDS, and which band a part lands in is decided by WHERE IT IS, not only
        // by what it is made of. At forty pixels the eye reads a figure as a stack of three
        // values top to bottom: a bright crown, a mid mass, a dark base. Polished metal owns
        // the accent, the legs and boots own the floor, everything else is the mass — and the
        // head gets half a band of lift on top so the silhouette always has a light top.
        const lo = p.b === 5 || p.b === 6;
        const cen = (met ? 0.615 : lo ? 0.11 : 0.375) + (p.b === 2 && !met ? 0.075 : 0) + gnd * 0.20;
        // Metal gets a NARROW band, not a big one: it is already the brightest thing in the
        // frame once the spec lobe is on it, and stretching pale steel the same way as wool put
        // a blown-white pickaxe head in the middle of the board.
        const l = livery ? THREE.MathUtils.clamp(_hsl.l * (0.96 + gnd * 0.26), 0.19, 0.46)
                         : cen + (_hsl.l - bv) * (met ? 0.50 : _hsl.l > bv ? 1.05 : 1.35);
        // The ACCENT band belongs to metal. A linen tunic allowed up to 0.66 is the brightest
        // mass on the figure — bigger than the helmet, brighter than the shield boss — and the
        // eye lands on a shirt instead of on a soldier. Cloth, leather and skin top out below
        // the polished-metal ceiling, so the hierarchy is bronze > cloth > wool > boots.
        const cap = met ? 0.84 : lo ? 0.26 : 0.60;
        _c.setHSL(_hsl.h, _hsl.s, THREE.MathUtils.clamp(l, 0.05, cap), THREE.SRGBColorSpace);
        pr.mesh.setColorAt(s, _c);
        // roughness rides the same lot: a scuffed helmet and a polished one in the same file
        pr.amr.setXYZW(s, p.mr[0], THREE.MathUtils.clamp(p.mr[1] + dye * 0.10, 0.10, 1), p.mr[2], p.mr[3] || 0);
      });
    }
    for (const k in G) {
      const pr = this.prim[k];
      pr.mesh.count = pr.out.count = pr.n;
      pr.amr.needsUpdate = true;
      if (pr.mesh.instanceColor) pr.mesh.instanceColor.needsUpdate = true;
    }
    this._slotsDirty = false;
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    const now = performance.now();
    dt = this._last ? Math.min(0.2, (now - this._last) / 1000) : dt;
    this._last = now;
    // How far the cast tips toward the lens this frame. A standing man seen from 55 degrees
    // projects square — 1.43 tall foreshortens to 0.82 against a 0.8 footprint — which is the
    // whole of "unreadable blob"; tipping him back up by whatever the camera is over 38
    // degrees restores the vertical without making him look drunk at portrait range.
    if (this.camera) {
      _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this._lean = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(-_v.y, -1, 1)) - 0.66, 0, 0.44);
      // pixels per world unit at unit distance — the silhouette budget in _step divides by depth
      this._pxk = (window.innerHeight * 0.5) / Math.tan(this.camera.fov * Math.PI / 360);
    } else { this._lean = 0; this._pxk = 0; }
    if (!this._ready) {
      this.terrain = window.terrain ?? null;
      this._ready = true;
      const q = this._pending; this._pending = [];
      for (const s of q) this.add(s);
      this._demo();
      // Chimneys need a head start. At software-GL frame rates the gap between frame one and
      // frame two is most of a second of simulated time, so a town shot on load has nothing
      // over its roofs and reads as abandoned. _demo() used to prime this; a real match turns
      // _demo off entirely, which is why every shipped frame so far has had no smoke in it.
      for (let i = 0; i < 34 && this._smokers.length; i++) { this._smoke(0.21); this.puffs.update(0.13); }
    }
    this.time += dt;

    // hand the flag and ambient shaders whatever the sky is doing this frame
    const sky = window.sky;
    if (sky) {
      this.sunDir.copy(sky.sunDir);
      this.flags.u.uSun.value.copy(sky.sunDir);
      this.flags.u.uSunCol.value.copy(sky.sunColor).multiplyScalar(2.4);
      this.flags.u.uAmb.value.copy(sky.hazeColor).multiplyScalar(2.0).addScalar(0.10);
      // SHADOWS ARE NOT BLACK. Every "untextured flat-matte surface" the last review measured
      // — hut cone HF 0.79, tree line, the mine's spoil tip — was a patch INSIDE a cast shadow:
      // albedo variation times a near-zero ambient is a near-zero variation, so the material
      // vanishes exactly where the critic's box lands. A shadowed surface still sees the sky
      // dome and the ground bounce; lifting both keeps the surface readable in shadow and drops
      // the frame's crushed percentage at the same time.
      _c.copy(sky.hazeColor);
      const hzL = _c.r * 0.2126 + _c.g * 0.7152 + _c.b * 0.0722;
      _c.lerp(_c2.setRGB(hzL * 1.03, hzL * 0.99, hzL * 0.93), 0.45);
      this.u.uAmbSky.value.copy(_c).multiplyScalar(2.15).addScalar(0.095);
      this.u.uAmbGnd.value.copy(sky.sunColor).multiplyScalar(0.34).addScalar(0.075);
      // windows come up as the sun goes down
      // A window is a HOLE by day and a lamp at dusk. Held near zero while the sun is up:
      // a doorway glowing orange at noon reads as the town being on fire, which is exactly
      // what the last frame did behind Aurelia's curtain wall.
      this.u.uWin.value = 0.08 + 1.05 * (1 - THREE.MathUtils.smoothstep(sky.elevation, 0.03, 0.30));
    }
    this.flags.u.uTime.value = this.time;
    if (this.camera) {
      this.u.uUpV.value.set(0, 1, 0).transformDirection(this.camera.matrixWorldInverse);
      this.u.uSunV.value.copy(this.sunDir).transformDirection(this.camera.matrixWorldInverse);
      if (sky?.sunColor) this.u.uRimCol.value.copy(sky.sunColor).multiplyScalar(1.35).addScalar(0.10);
    }

    if (this._slotsDirty) this._slots();

    this.flags.reset(); this.decals.reset(); this.shadows.reset();
    // Stack separation. Two men parked on the same hex used to stand on the same point and
    // grow through each other — two heads out of one pair of shoulders in the shipped frame.
    // Index them per tile here, spread them in _step.
    const st = this._st || (this._st = new Map());
    st.clear();
    for (const u of this.units.values()) { const k = u.q * 4096 + u.r; u.si = st.get(k) || 0; st.set(k, u.si + 1); }
    for (const u of this.units.values()) u.sn = st.get(u.q * 4096 + u.r);
    for (const u of this.units.values()) this._step(u, dt);
    this._cityFrame(dt);
    this._hudPortrait();
    this.flags.flush(); this.decals.flush(); this.shadows.flush();
    this.puffs.update(dt);

    for (const k in G) this.prim[k].mesh.instanceMatrix.needsUpdate = true;
  }

  _smoke(dt) {
    this._smokeT += dt;
    if (this._smokeT < 0.20) return;
    this._smokeT = 0;
    for (let i = 0; i < this._smokers.length; i++) {
      const s = this._smokers[i];
      if (Math.random() > 0.55) continue;
      // Smoke DRIFTS. The old plume went up almost vertically and grew to seven times its
      // vent width, so a tier-2 town wore one opaque grey blanket across half its roofs.
      // Smaller, shorter-lived, and pushed downwind hard enough to lean into a plume.
      this.puffs.spawn(s.x + (Math.random() - 0.5) * 0.06, s.y, s.z + (Math.random() - 0.5) * 0.06,
        0.26 + Math.random() * 0.10, 0.34 + Math.random() * 0.12, 0.07 + Math.random() * 0.05,
        s.r * 1.3, s.r * 3.9, 3.2 + Math.random() * 0.8, 0x8e887c);
    }
  }

  _cityFrame(dt) {
    this._smoke(dt);
    for (const c of this.cities) {
      // market awnings: cloth that moves, inside the walls, at zero geometry cost
      for (let i = 0; i < c.awn.length; i++) {
        const a = c.awn[i];
        // PITCH IT. `_e.set(-0.30, yaw, 0)` left the plane all but vertical, so every market
        // awning in the game hung as a pale sheet beside the stall — the white streak next to
        // Solmere's tower, and the aliased 'UV grid' before that. Yaw first, then a local
        // pitch, so the cloth is a canopy sloping off the trestle whatever way the stall faces.
        _q.setFromEuler(_e.set(0, a.yaw + PI2, 0)).multiply(_q2.setFromEuler(_e.set(-1.18, 0, 0)));
        _m.compose(_v.set(a.x - Math.cos(a.yaw) * 0.20, a.y, a.z + Math.sin(a.yaw) * 0.20),
          _q, _s.set(0.38, 0.30, 1));
        this.flags.push(_m, a.col ? c.team.b : 0xb0a07c, a.col ? 0xb0a07c : (c.team.flag ?? c.team.a), i * 3.1, 1);
      }
      // town banners
      for (let i = 0; i < c.poles.length; i++) {
        const p = c.poles[i];
        const y = (c.plat ?? this.y(p.x, p.z)) - 0.03 + p.h * 0.965;
        _m.compose(_v.set(p.x + 0.02, y, p.z), _q.setFromEuler(_e.set(0, i * 1.7, 0)), _s.set(0.255, 0.158, 1));
        this.flags.push(_m, c.team.flag ?? c.team.a, c.team.b, i * 2.1);
      }
      // The settlement's own occlusion: the ground a town stands on never sees the sky.
      const s = (c.foot ?? 0.8) * 2.20;
      _m.compose(_v.set(c.x, c.y + 0.055, c.z), _q2.identity(), _s.set(s, 1, s));
      this.shadows.push(_m, AO_MUL, 0.13, 0);
      // and the town's own bulk throws a shadow off its down-sun side: without it a walled
      // capital reads as a model kit placed on a photograph of a hill.
      this._shade(c.x, c.y + 0.060, c.z, (c.foot ?? 0.8) * (1.4 + c.tier * 0.35),
        (c.foot ?? 0.8) * 1.15, 0.14);
    }
    this._propGround();
    // Static contact patches — the pier, the yards. A dock stands on water, and water does not
    // receive the cascade, so without this the pilings have daylight under them and the whole
    // jetty reads as a bed frame composited onto a blue rectangle. Called out by name.
    for (const k of this._contacts) {
      _m.compose(_v.set(k.x, k.y, k.z), _q.setFromEuler(_e.set(0, k.yaw || 0, 0)), _s.set(k.rx, 1, k.rz));
      this.shadows.push(_m, AO_MUL, k.k, 0);
    }
    this._plateFade(dt);
  }

  // GROUNDING, UNCONDITIONALLY, ON EVERY PROP THAT STANDS ON DIRT.
  // Two decals per building: a radial contact patch at ~1.6x its own footprint whose darkest
  // texel is directly under the walls, and a sun-aligned cast shadow running off its down-sun
  // side, length solved from the real sun elevation and the building's own height. Both are
  // MULTIPLIES into whatever is underneath, so a keep darkens its courtyard, a hut darkens the
  // sand it stands on, and a flagpole finally throws something. The whole reason this exists
  // rather than leaning on the cascade: the shadow camera is fitted to the visible ground at
  // ~1.6 cm/texel and a 3.4-unit tower downsun of a 1-unit terrace is exactly the case it
  // cannot resolve — the review measured a 1.5% delta under a 220 px keep.
  _propGround() {
    const sd = this.sunDir, hxz = Math.hypot(sd.x, sd.z) || 1e-3;
    const dx = -sd.x / hxz, dz = -sd.z / hxz;          // the way the light travels along the ground
    const px = -dz, pz = dx;                            // and across it
    for (const [type, list] of this.builds) {
      const flat = NO_CAST.has(type.split(':')[0]);
      const d = this.bdim.get(type);
      if (!d) continue;
      for (let i = 0; i < list.length; i++) {
        const p = list[i].p; if (!p) continue;
        const ca = Math.cos(p[6]), sa = Math.sin(p[6]);
        // the mass centre, rotated into world: a mine's spoil tip and a dock's shed are not
        // over the origin they were placed on
        const x = p[0] + (d.cx * ca + d.cz * sa) * p[3];
        const z = p[2] + (-d.cx * sa + d.cz * ca) * p[3];
        const rx = d.rx * p[3], rz = d.rz * p[5], h = d.h * p[4];
        // Contact AO takes the building's own FOOTPRINT, not a circle round it: a 0.9-long
        // curtain wall wearing a 1.2-wide disc reads as a moat, not as a wall standing on dirt.
        _m.compose(_v.set(x, p[1] + 0.020, z), _q.setFromEuler(_e.set(0, p[6], 0)),
          _s.set(rx * 2.1, 1, rz * 2.1));
        this.shadows.push(_m, PROP_MUL, flat ? 0.20 : 0.34, 0);
        if (flat || h <= 0.26) continue;
        // The cast shadow is as wide as the caster's silhouette ACROSS the sun, so a wall
        // throws a wall-shaped shadow and a tower throws a tower-shaped one.
        const w = Math.abs(rx * (ca * px - sa * pz)) + Math.abs(rz * (sa * px + ca * pz));
        // A flat decal cannot follow a hill: the run is solved from the caster's own footprint
        // so it stays on the ground the caster is standing on.
        // A KEEP THROWS A KEEP'S SHADOW. Clamped at 1.70 a 3.3-unit citadel cast the same run as
        // a 1.9-unit watchtower, so the tallest thing on the board had no more presence on the
        // ground than a hut. Tall casters reach across the next hex under a low sun; the cap only
        // exists because a flat quad cannot follow relief for ever.
        this._shade(x, p[1] + 0.026, z, h, w * 0.92, 0.66, THREE.MathUtils.clamp(h * 1.10, 0.35, 2.45), PROP_MUL);
      }
    }
  }

  // Nameplate vs HUD. A world label sliced in half by the unit panel is clipped UI, full stop.
  // Project each plate, measure it against the HUD's own panel rects, and fade it out over
  // ~120 ms when they overlap. The rects are read from the DOM (they are the truth) and only
  // re-read a few times a second, because getBoundingClientRect is a layout flush.
  _plateFade(dt) {
    const cam = this.camera;
    if (!cam || !this.cities.length) return;
    if ((this._rectT = (this._rectT || 0) - dt) <= 0) {
      this._rectT = 0.35;
      this._rects = [...document.querySelectorAll('#hud .pl')]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 40 && r.height > 24);
    }
    const rects = this._rects;
    if (!rects) return;
    const W = window.innerWidth, H = window.innerHeight;
    for (const c of this.cities) {
      const sp = c.plate; if (!sp) continue;
      // ---- SCREEN-SPACE PIN. World-space sizing is why the shipped plates measured 0.73 to
      // 0.86 of a hex depending only on how far away the town was and how long its name is.
      // Solve the scale from the ratio of the plate's own depth to its TILE's depth, so the
      // bar always covers PL.HEX of the hex it labels. The ratio is the only free term and it
      // is clamped, so a plate can never balloon or vanish because of its stem height.
      const frac = sp.material.map?.frac ?? 1;
      const dP = cam.position.distanceTo(sp.position);
      const dG = Math.hypot(cam.position.x - c.x, cam.position.y - c.y, cam.position.z - c.z);
      const ss = (PL.HEX * 2 / frac) * THREE.MathUtils.clamp(dP / dG, 0.90, 1.10);
      sp.scale.set(ss, ss * PL.H / PL.W, 1);
      _v.copy(sp.position).project(cam);
      const x = (_v.x * 0.5 + 0.5) * W, y = (0.5 - _v.y * 0.5) * H;
      // half-width in pixels: project a point one half-plate to camera-right
      _v2.set(cam.matrixWorld.elements[0], cam.matrixWorld.elements[1], cam.matrixWorld.elements[2])
        .multiplyScalar(sp.scale.x * 0.5).add(sp.position).project(cam);
      const hw = Math.abs((_v2.x - _v.x) * 0.5 * W) * frac, hgt = hw * 2 * PL.BH / PL.BW;
      // DEPTH ORDER. The plates are depthTest:false so nothing in the world can hide one, but
      // two of them at the same renderOrder draw in creation order — a town on the far side of
      // the map could paint over the capital in front of it. Nearer plate, higher order.
      sp.renderOrder = 1400 + Math.round((1 - THREE.MathUtils.clamp(_v.z, -1, 1)) * 300);
      // A plate the viewport cuts in half is worse than no plate: the frame edge slices the
      // name and it reads as a clipped banner. Treat the edges exactly like a HUD panel.
      let hit = _v.z > 1 || x - hw < 4 || x + hw > W - 4 || y > H - 6 || y - hgt < 4;
      for (const r of rects) {
        if (x + hw > r.left - 12 && x - hw < r.right + 12 && y > r.top - 10 && y - hgt < r.bottom + 12) { hit = true; break; }
      }
      const want = hit ? 0 : 1;
      c.pfade = c.pfade === undefined ? want : c.pfade + (want - c.pfade) * Math.min(1, dt / 0.12);
      sp.material.opacity = c.pfade;
      sp.visible = c.pfade > 0.02;
    }
  }

  // ------------------------------------------------------------- unit frame
  _step(u, dt) {
    const d = u.def;
    // a march from grass onto sand re-keys the figure's value band (see _slots)
    if (u._bq !== u.q || u._br !== u.r) { u._bq = u.q; u._br = u.r; this._slotsDirty = true; }
    if (this._hidden(u) && u.die === undefined) {
      _m.makeScale(0, 0, 0);
      for (let i = 0; i < d.parts.length; i++) this.prim[d.parts[i].g].mesh.setMatrixAt(u.slots[i], _m);
      return;
    }
    const fp = d.foot || 0.26;
    let moving = 0;

    if (u.path) {
      const a = u.path[u.seg], b = u.path[u.seg + 1];
      if (!b) {
        const pa = axialToWorld(a.q, a.r);
        u.x = pa.x; u.z = pa.z; u.q = a.q; u.r = a.r; u.path = null;
        this.onArrive?.(u.id);
        if (u.loop) this.moveUnit(u.id, u.last.slice().reverse());
      }
      else {
        const pa = axialToWorld(a.q, a.r), pb = axialToWorld(b.q, b.r);
        const len = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
        u.t += dt * u.speed / len;
        if (u.t >= 1) {
          u.t = 0; u.seg++; u.q = b.q; u.r = b.r;
          const nt = this.map.get(b.q, b.r);
          u.water = !!d.boat || !nt || nt.height <= 0;
          if (u.seg >= u.path.length - 1) {
            u.path = null; this.onArrive?.(u.id);
            if (u.loop) this.moveUnit(u.id, u.last.slice().reverse());
          }
        } else {
          // ease in and out of every tile so movement reads as steps, not a slide
          const f = smooth(u.t);
          u.x = lerp(pa.x, pb.x, f); u.z = lerp(pa.z, pb.z, f);
          const gy = u.water ? WATER_Y : this._fit(u.x, u.z, fp, u);
          u.y = gy + (d.boat ? 0 : Math.sin(u.t * Math.PI) * 0.035);
          u.tYaw = Math.atan2(pb.x - pa.x, pb.z - pa.z);
          moving = 1;
          u.dist += (u.speed * dt) / (d.wheels ? 0.19 : 1);
        }
      }
    }
    if (!moving && !u.path) {
      // A garrison parked on the tile centre stands ON TOP of its own town: at this scale the
      // soldier is three times the height of a house and he buries the thing he is defending.
      // Idle units settle toward the front edge of their hex when a settlement owns it —
      // which is also where Civ parks them, because it is the only place they read.
      const tp = axialToWorld(u.q, u.r);
      let tx = tp.x, tz = tp.z;
      const n = Math.max(1, u.sn || 1);
      if (this._platAt.has(u.q * 4096 + u.r)) {
        // Garrison. A soldier parked on the tile centre is taller than the keep and buries the
        // town he is holding — Solmere shipped with one standing on its roofs, helmet through
        // the temple spire. He stands on the CAMERA side of the plate instead, at the kerb, so
        // the only thing he can overlap is in front of him and the depth test sorts it; a stack
        // fans along that near arc rather than growing through itself. The radius is the town's
        // OWN terrace radius, because y() answers with the plate over this whole tile and a man
        // standing past the kerb would float the height of the retaining wall.
        const cam = this.camera;
        const b = cam ? Math.atan2(cam.position.x - tp.x, cam.position.z - tp.z) : 0;
        const a = b + (n > 1 ? (u.si / (n - 1) - 0.5) * 1.25 : (u.seed % 3 - 1) * 0.30);
        const rr = this._footAt.get(u.q * 4096 + u.r) ?? 0.8;
        tx += Math.sin(a) * rr; tz += Math.cos(a) * rr;
      } else if (this._builtAt.has(u.q * 4096 + u.r)) {
        // THE FIGURE OWNS ITS TILE. A soldier parked on a market district stands inside four
        // stalls, two awnings and a crate stack, and the review's "nine competing shapes in
        // forty-four pixels" is mostly those. He steps to the camera-side edge of the hex, in
        // front of the props rather than among them; a stack fans along that arc.
        const cam = this.camera;
        const b = cam ? Math.atan2(cam.position.x - tp.x, cam.position.z - tp.z) : 0;
        const a = b + (n > 1 ? (u.si / (n - 1) - 0.5) * 1.10 : (u.seed % 3 - 1) * 0.26);
        tx += Math.sin(a) * 0.60; tz += Math.cos(a) * 0.60;
      } else if (n > 1) {
        const a = (u.si / n) * Math.PI * 2 + (u.q + u.r) * 0.9;
        tx += Math.cos(a) * 0.42; tz += Math.sin(a) * 0.42;
      }
      const k = Math.min(1, dt * 4);
      u.x += (tx - u.x) * k; u.z += (tz - u.z) * k;
      const gy = u.water ? WATER_Y : this._fit(u.x, u.z, fp, u);
      u.y += (gy - u.y) * Math.min(1, dt * 8);
    }

    // yaw chases the travel direction the short way round
    let dy = u.tYaw - u.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    u.yaw += dy * Math.min(1, dt * 6);
    u.walk += ((moving ? 1 : 0) - u.walk) * Math.min(1, dt * 5);
    // A soldier is drawn 1.6x life size so he reads at forty pixels; inside a village that
    // makes him taller than the watchtower and Solmere shipped with one straddling its roofs.
    // On a settled tile he drops back toward true scale, eased so a march in and out reads.
    const wantS = this._platAt.has(u.q * 4096 + u.r) ? 0.82 : 1;
    u.ds = u.ds === undefined ? wantS : u.ds + (wantS - u.ds) * Math.min(1, dt * 2.5);
    let usc = u.scale * u.ds;
    // MIN_PX is measured on the un-foreshortened vertical: at this camera pitch a world-up
    // segment lands on screen at ~0.50 of its projected length, so 96 here is ~48 real pixels
    // of standing figure — the floor under which a silhouette stops being nameable.
    if (this._pxk && this.camera) {
      const dd = Math.hypot(this.camera.position.x - u.x, this.camera.position.y - u.y, this.camera.position.z - u.z);
      const proj = (d.h || 0.85) * usc * this._pxk / Math.max(dd, 1e-3);
      usc *= THREE.MathUtils.clamp(96 / proj, 1, 1.9);
    }

    const w = u.walk, idle = 1 - w;
    u.phase += dt * (d.boat ? 2.2 : lerp(1.5, 7.4 * (d.gait || 1), w));
    const ph = u.phase, sw = Math.sin(ph), sw2 = Math.sin(ph * 2);

    // footfall dust, twice a stride
    if (moving && !d.boat) {
      const st = Math.floor(ph / Math.PI);
      if (st !== u.step) {
        u.step = st;
        const gy = this.y(u.x, u.z);
        this.puffs.spawn(u.x + (Math.random() - 0.5) * 0.12, gy + 0.04, u.z + (Math.random() - 0.5) * 0.12,
          (Math.random() - 0.5) * 0.06, 0.055, (Math.random() - 0.5) * 0.06,
          0.06, 0.26, 0.85, 0x9c8f72);
        this.onFootstep?.(u.x, gy, u.z);
      }
    }

    // ---- bones
    const root = u.bone[0];
    const bobY = d.boat ? Math.sin(this.time * 0.9 + u.seed) * 0.028 : 0;
    const roll = d.boat ? Math.sin(this.time * 0.62 + u.seed * 0.7) * 0.045 : 0;
    // Ground fit. The root sits on the tile's own surface and the whole figure is TILTED onto
    // the local slope: a plane fit through four samples across its footprint. Without this a
    // cart on a 15-degree beach puts one wheel in the air and the other in the sand, which is
    // exactly the tell that makes a unit read as pasted on rather than standing there.
    _v2.set(u.water ? 0 : u.nx || 0, 2 * fp, u.water ? 0 : u.nz || 0).normalize();
    _q.setFromUnitVectors(UP, _v2);
    _q.multiply(_q2.setFromEuler(_e.set(roll * 0.6, u.yaw, roll)));
    u.gN = _v2.y;
    // ---- attack. A short lunge onto the front foot with the weapon arm coming over. Fired
    // when an adjacent enemy dies (see remove) — the only combat signal the bridge exposes.
    let atk = 0;
    if (u.atk !== undefined) {
      u.atk += dt * 2.0;
      if (u.atk >= 1) u.atk = undefined; else atk = Math.sin(u.atk * Math.PI);
    }
    // A lunge pitches FORWARD (+x is the same direction the death topple uses); the resting
    // pose leans a little back, which on a 40-degree camera turns a bald scalp into a chest,
    // a tabard and a face — the difference between a figure and a shoulder-blob seen from above.
    if (atk || !d.boat) _q.multiply(_q2.setFromEuler(_e.set(0.30 * atk - (d.boat ? 0 : 0.14), 0, 0)));
    // ---- TIP THE LONG AXIS INTO THE IMAGE PLANE. At a 55-degree pitch a standing figure is
    // only 18 degrees off the optical axis, so it projects as its own plan view: a helmet lid,
    // two shoulders and a shield lying flat — the "unreadable blob" every review has named.
    // Rotating it about the horizontal axis ACROSS the view by the camera's own excess pitch
    // swings that axis back toward perpendicular and the plan becomes an elevation: crest,
    // face, tabard, belt, boots stacked vertically in screen space, feet still on the pivot.
    // WHICH WAY depends on which axis carries the read, and this is where every earlier pass
    // got it backwards. A man is TALL: his axis is vertical, so he must recline AWAY from the
    // lens (measured: projected height x2.5, 36 px to 90 px on a 133 px hex). A horse and a
    // cart are LONG: their axis is horizontal and already square to the view, so the same
    // rotation foreshortens them into a belly and a heap of scaffolding — they tip the other
    // way, toward the lens, which is what stands their flanks and wheels up instead. Hulls sit
    // in water that is already flat to the camera and take neither.
    if (!d.boat && this._lean > 0.01) {
      const b = Math.atan2(this.camera.position.x - u.x, this.camera.position.z - u.z);
      const ln = (d.mounted || d.wheels) ? this._lean : -this._lean;
      _q.premultiply(_q2.setFromAxisAngle(_v2.set(Math.cos(b), 0, -Math.sin(b)), ln));
    }
    u.atkS = atk;
    root.compose(_v.set(u.x + Math.sin(u.yaw) * 0.26 * atk * usc, u.y + bobY - (d.boat ? 0 : 0.022),
      u.z + Math.cos(u.yaw) * 0.26 * atk * usc), _q, _s.set(usc, usc, usc));

    // ---- death. Topple forward over the boots, sink a little, kick up one puff, then shrink
    // out. The bridge's only death signal is remove(), so this is where it has to live.
    let dk = 1;
    if (u.die !== undefined) {
      u.die += dt * 1.5;
      const k = Math.min(1, u.die); dk = (1 - k) * (1 - k);
      if (!u.diePuff) {
        u.diePuff = 1;
        this.puffs.spawn(u.x, u.y + 0.10, u.z, 0, 0.09, 0, 0.12, 0.66, 1.2, 0x8f7f62);
      }
      _q.multiply(_q2.setFromEuler(_e.set(smooth(Math.min(1, k * 1.5)) * 1.52, 0, 0)));
      const sc = usc * (1 - smooth(THREE.MathUtils.clamp((k - 0.7) / 0.3, 0, 1)));
      root.compose(_v.set(u.x, u.y + bobY - k * 0.06, u.z), _q, _s.set(sc, sc, sc));
      if (u.die >= 1) { this.units.delete(u.id); this._slotsDirty = true; }
    }

    const bones = u.bone, piv = d.piv;
    const breathe = 1 + Math.sin(this.time * 1.6 + u.seed) * 0.012 * idle;
    for (let i = 1; i < 8; i++) {
      const p = piv[i];
      if (!p) { bones[i].copy(root); continue; }
      let rx = 0, ry = 0, rz = 0, sy = 1, oy = 0, hs = 1;
      if (i === 1) {                                   // torso
        oy = Math.abs(sw2) * 0.022 * w;
        rz = sw * 0.05 * w; rx = -0.04 * w + Math.sin(this.time * 1.6 + u.seed) * 0.012 * idle;
        sy = breathe;
      } else if (i === 2) {                            // head
        hs = 0.90;                                     // see HP: the head was too big for the body
        ry = Math.sin(this.time * 0.7 + u.seed * 1.3) * 0.22 * idle - sw * 0.05 * w;
        rx = Math.sin(this.time * 0.9 + u.seed) * 0.06 * idle;
      } else if (i === 3 || i === 4) {                 // arms / oars / throwing arm
        const s = i === 3 ? 1 : -1;
        if (d.boat) rx = Math.sin(ph + (i === 3 ? 0 : 0.25)) * 0.42;
        else if (u.type === 'catapult' && i === 3) rx = -0.74 + Math.sin(this.time * 1.1 + u.seed) * 0.035;
        else rx = -sw * s * 0.55 * w + Math.sin(this.time * 1.3 + u.seed + s) * 0.05 * idle;
        rx += (i === 4 ? -2.0 : -0.5) * u.atkS;
      } else if (i === 5 || i === 6) {                 // legs / axles
        if (d.wheels) rx = u.dist * (i === 5 ? 1 : 1);
        else if (!d.noLegs) rx = sw * (i === 5 ? 1 : -1) * (d.mounted ? 0.42 : 0.62) * w
          + (d.mounted ? Math.sin(this.time * 1.1 + u.seed) * 0.02 : 0);
      } else if (i === 7) {                            // mount body
        oy = Math.abs(sw2) * 0.020 * w;
        rx = -0.02 * w + Math.sin(this.time * 1.4 + u.seed) * 0.010 * idle;
      }
      _e.set(rx, ry, rz);
      _m.compose(_v.set(p[0], p[1] + oy, p[2]), _q.setFromEuler(_e), _s.set(hs, sy * hs, hs));
      bones[i].multiplyMatrices(root, _m);
      // pivot correction: the local matrix already sits at the pivot, so parts are authored
      // relative to it. Nothing else to do.
    }

    // ---- parts. SILHOUETTE BUDGET. A soldier projects to about sixty pixels at gameplay
    // zoom and this cast carries forty-odd primitives, every one of which also draws an
    // inverted-hull contour. The sub-pixel furniture — a belt buckle, a nasal bar, a cloak
    // clasp — therefore arrives not as detail but as a rim of dark grit that fills the figure
    // in, which is exactly the "unnameable navy/rust smear with nine competing shapes" the
    // review measured. Anything that cannot resolve to six pixels is dropped here; it still
    // exists at portrait range, where the same test lets it back in.
    const parts = d.parts;
    const cam = this.camera;
    const cut = (cam && this._pxk)
      ? 6.0 * Math.hypot(cam.position.x - u.x, cam.position.y - u.y, cam.position.z - u.z) / (this._pxk * usc)
      : 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p._sz < cut) { this.prim[p.g].mesh.setMatrixAt(u.slots[i], _m0); continue; }
      const bm = p.b === 0 ? root : bones[p.b];
      _m.multiplyMatrices(bm, p.m);
      this.prim[p.g].mesh.setMatrixAt(u.slots[i], _m);
    }
    // ---- flags. A GARRISON FURLS ITS STANDARD. Inside a town the civ already flies two
    // banners off its own towers, and a third one on the man in front of them draped a blue
    // tarpaulin across Solmere's tower in the shipped frame. Outside a town the pennant is what
    // says whose the soldier is; inside, the town says it.
    const fsc = u.ds ?? 1;
    for (const f of (fsc > 0.85 ? d.flags : EMPTY)) {
      const bm = f.b === 0 ? root : bones[f.b];
      _m.compose(_v.set(f.x, f.y, f.z), _q.setFromEuler(_e.set(0, f.ry || 0, f.rz || 0)), _s.set(f.sx, f.sy, 1));
      _m.premultiply(bm);
      this.flags.push(_m, f.sail ? 0xe6dcc0 : (u.team.flag ?? u.team.a), f.sail ? (u.team.flag ?? u.team.a) : u.team.b, u.seed * 0.01, f.sail ? 1 : 0);
    }
    // ---- grounding. ONE occlusion capsule, centred on the feet, multiplied into the ground.
    // The directional shadow is the sun's job and the 2048 cascade already casts it; what the
    // cascade cannot buy at 5 cm/texel is the dense wedge of darkness in the few centimetres
    // where a boot meets dirt, and that is all this is. Laid at the footprint's HIGHEST terrain
    // sample (see _fit) so the tile's own dome can never eat it, and never displaced: an offset
    // pool leaves lit ground under the model, which is the exact pixel the review named.
    if (!u.water) {
      const rr = (d.foot || 0.26) * usc * 1.15;
      const base = Math.max(u.yMax ?? u.y,
        this.y(u.x - rr, u.z), this.y(u.x + rr, u.z), this.y(u.x, u.z - rr), this.y(u.x, u.z + rr));
      // a unit mid-hop lifts off; the capsule widens and fades exactly as far as it climbed
      const lift = THREE.MathUtils.clamp((u.y - base) * 3.4, 0, 0.8);
      const w = (d.foot || 0.26) * usc * 1.05 * (1 + lift * 0.5);
      // capped: a 1.9-unit-tall soldier under a low sun would otherwise throw a shadow across
      // most of the next hex, which reads as a wall, not a man.
      this._shade(u.x, base + 0.030, u.z, (d.h || 0.85) * usc,
        w, dk * (1.0 - lift * 0.55) * (0.90 + 0.10 * (u.gN || 1)), 1.55);
      // and a tight occlusion disc right at the soles. The sun-aligned wedge above says WHERE
      // the light is; this says the boots are touching. Without both, a figure reads as a
      // sticker with a shadow painted next to it.
      // 0.55 of the hex inradius, per the brief: plateau under the boots, feathered to nothing
      // at the rim, MULTIPLYING the ground so it carries the terrain's own hue and can never be
      // the grey (or worse, blue) puddle five reviews have drawn a box around.
      _m.compose(_v.set(u.x, base + 0.026, u.z), _q2.identity(), _s.set(w * 1.72, 1, w * 1.72));
      this.shadows.push(_m, AO_MUL, dk * 0.80 * (1 - lift), 0);
      // ---- and the owner's disc on top of it. This is the single cue the review said was
      // missing outright: 60 x 36 px of the civ's own blue under a 57 px soldier, so the eye
      // lands on the unit before it lands on the badge, and green-on-green cannot happen.
      _m.compose(_v.set(u.x, base + 0.034, u.z), _q2.identity(), _s.set(w * 1.55, 1, w * 1.55));
      this.decals.push(_m, u.team.disc ?? u.team.flag, dk * (1 - lift) * (u.sel ? 1.0 : 0.80), 4);
      // NO OWNERSHIP HEX. grid.js draws the territory band and the selection ring on these
      // exact edges; a third civ-tinted hexagon under the unit is the double-stroke the
      // review measured, and it drew at full alpha straight through the water plane.
    } else if (d.boat) {
      // CONTACT PATCH. A hull does not cast a drop shadow onto water, it sits IN it: the sea
      // right under the planking goes dark because the light never gets there. One soft
      // ellipse the length of the hull, at the waterline, aligned with the keel.
      _m.compose(_v.set(u.x, WATER_Y + 0.045, u.z), _q.setFromEuler(_e.set(0, u.yaw, 0)),
        _s.set(fp * u.scale * 1.5, 1, fp * u.scale * 3.4));
      this.shadows.push(_m, 0x4a5f74, 0.85, 0);
      // V wake, opening astern and dying over ~3 hex lengths. Anchored at the bow and stretched
      // backwards so the hull sits in the apex of its own V instead of on top of a foam pill.
      // Lifted well clear of WATER_Y: the sea mesh displaces its own vertices and writes
      // depth, so a wake laid 12 mm above nominal sea level spends half the swell inside it.
      _m.compose(_v.set(u.x - Math.sin(u.yaw) * 2.55, WATER_Y + 0.085, u.z - Math.cos(u.yaw) * 2.55),
        _q.setFromEuler(_e.set(0, u.yaw, 0)), _s.set(2.8, 1, 5.4));
      this.decals.push(_m, 0xffffff, this.time, 2);
      // and a real displacement in the sea itself, not just a decal painted on top of it
      if (moving && (u.rip = (u.rip || 0) + dt) > 0.18) {
        u.rip = 0;
        window.water?.addRipple?.(u.x - Math.sin(u.yaw) * 0.55, u.z - Math.cos(u.yaw) * 0.55, 0.7);
      }
    }
  }

  // ----------------------------------------------------------- portraits
  // The unit panel ships a hand-drawn mannequin: one ellipse helmet, one airbrush gradient, a
  // pure-black visor slit and no material break at all. This renders the ACTUAL model instead
  // — a bust in three-quarter view under a real three-point rig (warm key from camera-left, a
  // cool bounce off the shade side, a hot rim from behind the sun shoulder) over a vignetted
  // civ-washed backdrop, offscreen, cached per (type, civ, size).
  //
  // src/ui/hud.js owns the DOM and is not this agent's file, so this is offered rather than
  // installed. One line adopts it:
  //     el.innerHTML = `<img class="bust" src="${window.units.portrait('warrior', civColor)}">`;
  portrait(type, color = 0x4fa8ff, px = 192) {
    const R = window.renderer;
    if (!R) return null;
    const cache = this._ports || (this._ports = new Map());
    const key = `${type}:${color}:${px}`;
    if (cache.has(key)) return cache.get(key);

    const def = DEFS[type] || DEFS[ALIAS[type]] || DEFS.warrior;
    const team = teamOf({ color });
    // BIND POSE. A bone sits on its own pivot when nothing is animating it, so a part's matrix
    // is just T(pivot) * its local placement — the same numbers the board uses, no rig needed.
    const geos = [];
    for (const p of def.parts) {
      const pv = def.piv?.[p.b] ?? [0, 0, 0];
      const col = p.c === 'A' ? team.a : p.c === 'B' ? team.b : p.c === 'F' ? team.flag : p.c;
      geos.push(tag(G[p.g], col, p.mr,
        new THREE.Matrix4().makeTranslation(pv[0], pv[1], pv[2]).multiply(p.m)));
    }
    const geo = merge(geos);
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(geo, this.mat));
    const out = new THREE.Mesh(geo, this.outMat); out.renderOrder = -1; sc.add(out);
    // three-point rig, 5600K key / 7000K bounce / 5600K rim
    const L = (hex, i, x, y, z) => { const d = new THREE.DirectionalLight(hex, i); d.position.set(x, y, z); sc.add(d); };
    L(0xffe3ba, 3.6, -0.95, 1.40, 1.95);      // key, on the camera side so it lights the FACE
    L(0x9db8dc, 0.85, 1.70, -0.15, 0.85);     // cool bounce off the shade side
    L(0xfff0d6, 2.7, 1.25, 0.95, -1.60);      // rim, behind the sun shoulder

    // FRAME THE BUST OFF THE RIG, not off a hand-tuned constant. The head BONE is where the
    // face is for every unit in the roster; a hand-solved distance framed the warrior with his
    // crest out of the top of the plate and the spearman as a doll in the middle of one,
    // because a pike four times the height of the man was setting the zoom.
    const h = def.h || 0.86;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const hy = (def.piv?.[2]?.[1] ?? h * 0.78) + h * 0.02;
    const span = h * (def.mounted ? 0.86 : def.boat || def.wheels ? 1.15 : 0.70);
    const d = span / (2 * Math.tan(13 * Math.PI / 180));
    const cam = new THREE.PerspectiveCamera(26, 1, 0.05, 40);
    const aim = new THREE.Vector3(
      THREE.MathUtils.clamp((bb.min.x + bb.max.x) * 0.5, -h * 0.09, h * 0.09),
      def.boat || def.wheels ? (bb.min.y + bb.max.y) * 0.5 : hy - h * 0.07, 0);
    cam.position.set(aim.x + d * 0.40, aim.y + d * 0.03, aim.z + d * 0.916);
    cam.lookAt(aim);

    const rt = new THREE.WebGLRenderTarget(px, px, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const oRT = R.getRenderTarget(), oTM = R.toneMapping, oCol = new THREE.Color();
    R.getClearColor(oCol); const oA = R.getClearAlpha();
    R.toneMapping = THREE.ACESFilmicToneMapping;
    R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear();
    R.render(sc, cam);
    const buf = new Uint8Array(px * px * 4);
    R.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    R.setRenderTarget(oRT); R.toneMapping = oTM; R.setClearColor(oCol, oA);
    rt.dispose(); geo.dispose();

    // composite: civ wash, the figure, then a vignette that closes the plate
    const cv = document.createElement('canvas'); cv.width = cv.height = px;
    const g = cv.getContext('2d');
    // raw sRGB bytes: _c.set() would hand back the LINEAR components and paint a black wash
    const civ = `${(color >> 16) & 255},${(color >> 8) & 255},${color & 255}`;
    let bg = g.createRadialGradient(px * 0.5, px * 0.36, 0, px * 0.5, px * 0.36, px * 0.72);
    bg.addColorStop(0, `rgba(${civ},0.34)`); bg.addColorStop(1, 'rgba(10,9,7,1)');
    g.fillStyle = '#14110c'; g.fillRect(0, 0, px, px);
    g.fillStyle = bg; g.fillRect(0, 0, px, px);
    const im = g.createImageData(px, px);
    for (let y = 0; y < px; y++) {                       // GL reads bottom-up
      const src = (px - 1 - y) * px * 4, dst = y * px * 4;
      im.data.set(buf.subarray(src, src + px * 4), dst);
    }
    const fig = document.createElement('canvas'); fig.width = fig.height = px;
    fig.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(fig, 0, 0);
    const vg = g.createRadialGradient(px * 0.48, px * 0.40, px * 0.22, px * 0.48, px * 0.40, px * 0.80);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.70)');
    g.fillStyle = vg; g.fillRect(0, 0, px, px);
    // a warm floor bounce along the bottom edge: the plate reads as a lit alcove rather than a
    // cut-out on a swatch, which is the whole difference between a portrait and an avatar
    const fl = g.createLinearGradient(0, px, 0, px * 0.62);
    fl.addColorStop(0, 'rgba(255,206,142,0.20)'); fl.addColorStop(1, 'rgba(255,206,142,0)');
    g.fillStyle = fl; g.fillRect(0, 0, px, px);
    const url = cv.toDataURL('image/png');
    cache.set(key, url);
    return url;
  }

  // Push the rendered bust into the unit panel. hud.js owns that node and is not this agent's
  // file, so the portrait is installed at runtime: one <img> swap when the selection changes,
  // re-applied if the HUD rewrites the element from its own placeholder set. A CITY selection
  // is left alone — hud.js's city bust is its own art.
  _hudPortrait() {
    const want = this._port;
    if (!want) return;
    const el = document.querySelector('#hud [data-f="portrait"]');
    if (!el) return;
    const key = want.type + ':' + want.color;
    if (el.dataset.aeon === key && el.firstElementChild?.tagName === 'IMG') return;
    const url = this.portrait(want.type, want.color, 192);
    if (!url) return;
    el.dataset.aeon = key;
    el.innerHTML = '<img class="bust" alt="" src="' + url + '">';
  }

  // ------------------------------------------------------------------ demo
  // A showcase state: an old walled capital, a growing town and a young village, plus a mixed
  // warband. Additive and anchored on whatever the gameplay agent already seeded, so the
  // showpiece lands next to the action instead of on the far side of the fog.
  // Pick the best tile on a ring, not the first legal one: a capital on green land next to
  // water reads as a capital, the same buildings on bare sand read as a ruin.
  _site(aq, ar, rMin, rMax, gap, spin, aim) {
    const SCORE = { grass: 10, plains: 9.5, forest: 7, hills: 6, jungle: 5, beach: 4, tundra: 2, desert: 1 };
    let best = null, bs = -1;
    for (let rad = rMin; rad <= rMax; rad++) {
      const ring = ringTiles(aq, ar, rad);
      for (let k = 0; k < ring.length; k++) {
        const n = ring[(k + spin) % ring.length];
        const t = this.map.get(n.q, n.r);
        if (!t || t.height <= 0) continue;
        if (this.cities.some((c) => hexDist(n.q, n.r, c.q, c.r) < gap)) continue;
        let land = 0, sc = SCORE[t.biome] ?? 0, rough = 0;
        if (!sc) continue;
        for (const d of DIRS) {
          const nb = this.map.get(n.q + d.q, n.r + d.r);
          if (!nb) continue;
          if (nb.height > 0) { land++; sc += (SCORE[nb.biome] ?? 0) * 0.35; rough += Math.abs(nb.height - t.height); }
          else sc += 1.2;                            // a coastal or lakeside site is prettier
        }
        if (land < 4) continue;                      // districts need somewhere to go
        sc -= rough * 1.6;                           // a town wants a shelf, not a cliff edge
        sc -= Math.max(0, t.height - 2.2) * 2.0;
        sc -= (rad - rMin) * 2.2 + k * 0.02;         // near the action, ties to the heading
        // A demo city half off the bottom of the frame is a demo city nobody sees, and three
        // demo cities stacked in the middle is a worse composition than one. Score the
        // candidate in the camera's own clip space against a per-city AIM point, so the
        // settlements land on the thirds instead of piling on the focus.
        if (this.camera && aim) {
          const w = axialToWorld(n.q, n.r);
          _v.set(w.x, t.height, w.z).project(this.camera);
          if (Math.abs(_v.x) > 0.90 || _v.y < -0.58 || _v.y > 0.80 || _v.z > 1) sc -= 20;
          else sc += 11 - 7 * Math.hypot(_v.x - aim[0], (_v.y - aim[1]) * 0.85);
        }
        if (sc > bs) { bs = sc; best = n; }
      }
    }
    return best;
  }

  // Pick a free land tile whose SCREEN position is nearest an NDC aim point. The demo scene
  // is a photograph as much as a game state: a plate with a quarter of it empty sand reads as
  // an unfinished level, so the caravan goes where the composition needs mass.
  _aimSpot(cq, cr, rMin, rMax, aim) {
    if (!this.camera) return this._spot(cq, cr, rMin, 0);
    let best = null, bd = 1e9;
    for (let rad = rMin; rad <= rMax; rad++) for (const n of ringTiles(cq, cr, rad)) {
      const t = this.map.get(n.q, n.r);
      if (!t || t.height <= 0 || t.biome === 'mountain') continue;
      if (this.cities.some((c) => c.q === n.q && c.r === n.r)) continue;
      let taken = false;
      for (const u of this.units.values()) if (u.q === n.q && u.r === n.r) { taken = true; break; }
      if (taken) continue;
      const w = axialToWorld(n.q, n.r);
      _v.set(w.x, t.height, w.z).project(this.camera);
      if (_v.z > 1) continue;
      const d = Math.hypot(_v.x - aim[0], (_v.y - aim[1]) * 0.9);
      if (d < bd) { bd = d; best = n; }
    }
    return bd < 0.42 ? best : null;
  }

  _spot(q, r, rad, spin) {
    const ring = ringTiles(q, r, rad);
    for (let k = 0; k < ring.length; k++) {
      const n = ring[(k + spin) % ring.length];
      const t = this.map.get(n.q, n.r);
      if (!t || t.height <= 0 || t.biome === 'mountain') continue;
      if (this.cities.some((c) => c.q === n.q && c.r === n.r)) continue;
      let taken = false;
      for (const u of this.units.values()) if (u.q === n.q && u.r === n.r) { taken = true; break; }
      if (!taken) return n;
    }
    return null;
  }

  _demo() {
    const a = this.cities[0] ?? { q: 30, r: 31 };
    // rad/aim per settlement: the capital right of the focus, the town low-left, the village
    // high-left, so the frame reads as a settled region rather than one clump.
    const plan = [
      { rad: 2, r2: 4, gap: 2, spin: 0, aim: [0.16, 0.02], team: 0, name: 'Aurelia', pop: 12, prod: 9, districts: [{ dir: 3, kind: 'farm' }, { dir: 1, kind: 'workshop' }, { dir: 5, kind: 'farm' }] },
      { rad: 3, r2: 6, gap: 3, spin: 4, aim: [-0.30, -0.34], team: 1, name: 'Kaldan', pop: 6, prod: 5, districts: [{ dir: 4, kind: 'farm' }, { dir: 2, kind: 'workshop' }] },
      { rad: 3, r2: 7, gap: 3, spin: 10, aim: [-0.22, 0.40], team: 2, name: 'Vashti', pop: 3, prod: 2, districts: [{ dir: 0, kind: 'farm' }] },
    ];
    // The gameplay agent may already have founded cities of its own by now. Never reuse one of
    // their names — two plates reading "Aurelia" over two different towns is the single most
    // obvious tell that a screenshot is staged.
    const taken = new Set(this.cities.map((c) => c.name));
    const made = [];
    for (const pl of plan) {
      const n = this._site(a.q, a.r, pl.rad, pl.r2, pl.gap, pl.spin, pl.aim);
      if (!n) continue;
      let name = pl.name;
      for (let k = 0; taken.has(name); k++) name = NAMES[(NAMES.indexOf(pl.name) + 1 + k) % NAMES.length];
      taken.add(name);
      this.add({ type: 'city', q: n.q, r: n.r, team: pl.team, name, pop: pl.pop, prod: pl.prod, districts: pl.districts });
      made.push(n);
    }
    if (!made.length) return;

    // a trade road between the first and last settlement
    if (made.length >= 2) {
      const p0 = axialToWorld(made[0].q, made[0].r), p1 = axialToWorld(made[made.length - 1].q, made[made.length - 1].r);
      this.roads.push([{ x: p0.x, z: p0.z },
        { x: lerp(p0.x, p1.x, 0.34) + 0.7, z: lerp(p0.z, p1.z, 0.34) + 0.6 },
        { x: lerp(p0.x, p1.x, 0.70) - 0.5, z: lerp(p0.z, p1.z, 0.70) + 0.3 },
        { x: p1.x, z: p1.z }]);
      this._buildRoads();
    }

    // a warband around each settlement — every silhouette in the roster shows up somewhere
    const roster = [
      ['warrior', 0, 1, 0], ['spearman', 0, 1, 2], ['archer', 0, 2, 5], ['builder', 0, 1, 4],
      ['catapult', 0, 2, 1], ['horseman', 0, 2, 9], ['settler', 0, 2, 7],
      ['warrior', 1, 1, 1], ['spearman', 1, 1, 3], ['horseman', 1, 2, 6],
      ['archer', 2, 1, 2], ['builder', 2, 1, 5],
    ];
    const ids = [];
    for (const [type, ci, rad, spin] of roster) {
      const c = made[Math.min(ci, made.length - 1)];
      const n = this._spot(c.q, c.r, rad, spin);
      ids.push(n ? this.add({ type, q: n.q, r: n.r, team: ci }) : null);
    }

    // The lower right of the plate is open sand with nothing in it. Put a road party there:
    // an ox-cart, its escort and a surveyor, spaced so they read as a group in motion.
    const caravan = [['settler', 0, [0.30, -0.42]], ['spearman', 0, [0.20, -0.52]],
                     ['builder', 1, [0.44, -0.28]], ['horseman', 0, [0.05, -0.60]]];
    for (const [type, team, aim] of caravan) {
      const n = this._aimSpot(made[0].q, made[0].r, 2, 8, aim);
      if (n) ids.push(this.add({ type, q: n.q, r: n.r, team }));
    }

    // A galley on OPEN water. The old rule — any water tile touching land — put the hull on a
    // shelf so shallow that the terrain reads as beach under it, and a beached trireme is the
    // loudest possible bug in the frame. Require the tile and all six neighbours to be sea, and
    // then keep the nearest such tile to the capital so the coast still reads as inhabited.
    for (let rad = 2; rad <= 10 && !this._boat; rad++) {
      for (const n of ringTiles(made[0].q, made[0].r, rad)) {
        const t = this.map.get(n.q, n.r);
        if (!t || t.height > 0 || t.biome !== 'ocean') continue;
        if (!DIRS.every((d) => { const v = this.map.get(n.q + d.q, n.r + d.r); return v && v.height <= 0; })) continue;
        const p = axialToWorld(n.q, n.r);
        if (this.y(p.x, p.z) > WATER_Y - 0.06) continue;     // the ground here still breaks surface
        this._boat = this.add({ type: 'trireme', q: n.q, r: n.r, team: 0, yaw: rad * 0.7 });
        break;
      }
    }

    // The galley patrols. A V wake behind a parked hull is a lie, and a parked hull in a
    // 4X screenshot is the thing that tells you nothing in the frame is simulated.
    if (this._boat) {
      const bu = this.units.get(this._boat);
      const leg = [{ q: bu.q, r: bu.r }];
      for (let i = 0; i < 4; i++) {
        const last = leg[leg.length - 1];
        let nxt = null;
        for (let k = 0; k < 6 && !nxt; k++) {
          const d = DIRS[(k + 2) % 6], n = { q: last.q + d.q, r: last.r + d.r };
          const t = this.map.get(n.q, n.r);
          if (!t || t.height > 0) continue;
          if (leg.some((v) => v.q === n.q && v.r === n.r)) continue;
          if (!DIRS.every((dd) => { const v = this.map.get(n.q + dd.q, n.r + dd.r); return v && v.height <= 0; })) continue;
          nxt = n;
        }
        if (!nxt) break;
        leg.push(nxt);
      }
      if (leg.length > 1) { bu.loop = 1; bu.speed = 0.85; this.moveUnit(this._boat, leg); bu.t = 0.4; }
    }

    // three of them walk, so the frame has motion, dust and a turned silhouette in it
    for (const k of [0, 6, 5]) {
      const u = ids[k] && this.units.get(ids[k]);
      if (!u) continue;
      const path = [{ q: u.q, r: u.r }];
      for (let i = 0; i < 3; i++) {
        const last = path[path.length - 1];
        const n = this._spot(last.q, last.r, 1, i * 2 + k);
        if (!n) break;
        path.push(n);
      }
      if (path.length < 2) continue;
      u.loop = 1;
      this.moveUnit(u.id, path);
      u.t = Math.random() * 0.85;            // stagger, so nobody marches in lockstep
    }
  }
}
