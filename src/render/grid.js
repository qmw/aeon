// AEON — the hex grid overlay and every decal that lives on it.
//
// One decal surface, one shader, one pass, and the pass is a MODULATE: blending is
// dst * src.rgb, so everything the player reads off the board — the engraved tile boundary,
// the hover, the selection ring, the territory perimeter, the movement plate, the focus dim —
// is a per-channel multiplier on the terrain radiance already sitting in post.js's HDR buffer.
// Four rules keep it from looking like a debug wireframe, and each one was a bug first:
//
//  * The lattice is regular BY CONSTRUCTION — in the SHADER. aLocal is always the ideal
//    flat-top hexagon, so `d`, the stroke width and the AA never know the ground moved, and no
//    5- or 7-sided cell can be emitted however the mesh is jittered. Where the vertices go is
//    a different question, and the answer is terrain.js's OWN welded, jittered tile polygon
//    (cornerLocal / cornerY) evaluated for THE TILE THAT OWNS THE VERTEX — not heightAt(),
//    which rounds a world point to a tile and therefore flips sides at every rim sample. On
//    flat ground that flip is a millimetre; on a cliff it is the whole drop, and the rods it
//    laid across the massif are the "grid drawn over the cliff faces" read. Never a local copy
//    of terrain.js's profile: that is how the lattice ended up buried the day it changed.
//  * Line width is PIXEL-constant, from the EXACT gradient of the distance-to-hexagon (not
//    fwidth, which runs 41% wide on a diagonal and exact on an axis edge — an angle-varying
//    width sold as a constant one, and the six edge orientations are what stair-stepped).
//    Distance attenuates alpha, never width — and the attenuators combine with min(), not
//    with a product: six independent 0.85s multiply to 0.38, which is how a stroke that reads
//    on paper arrives on screen as a rumour.
//  * ONE stroke per edge and ONE PROFILE: a 2px core and a 2px analytic feather to zero.
//    No second lobe beside it, no glow, no groove under it, no bevel inboard of it — there is
//    nothing left on the board that can rasterise as a second parallel polyline. Priority is
//    strict (selection, pointer, claimed perimeter, bare seam), and BOTH HALVES OF THE EDGE
//    AGREE: each tile paints only the inboard half of its own boundary, so every fragment reads
//    the NEIGHBOUR across its edge out of the same state texture and folds its flags in before
//    choosing. The movement range answers with a FILL, and a fill cannot collide with a line.
//  * Five languages, none of them another thin line of the same colour: selection is a warm
//    gold BRIGHTENING ring, hover a cool pale one, the territory perimeter a civ-blue
//    DARKENING stroke lit by the ground it claims (0.6*N.L + 0.4, so it tracks the hex into
//    shade instead of sitting on the frame as an unlit sticker), the movement range a 0.22
//    blue FILL with a 6px inner feather and no rim at all, and the order a team-blue chevron
//    ribbon ending on a warm destination plate. Over water they all drop to 0.13, bare seam
//    included: the sea carries no yield, no relief and no movement cost to count, but a
//    player counting tiles to a landing still has a board to count on.
//  * The BARE SEAM is a darkening at every exposure and on every biome — the multiplier is
//    below 1 in all three channels, so the line is never brighter than the terrain luminance
//    under it. What the sun changes is the ALPHA (1.20 in shade, 0.86 in full sun), not the
//    polarity: a pale line over shaded grass is a lit wire lying on unlit ground.
//  * The decal sits ON the ground, not over it. Clearance is bought in the DEPTH TEST (a view-space
//    bias along the eye ray, which moves nothing on screen) instead of in world Y (which moves the
//    line by bias*cot(pitch) pixels and is exactly what made the old ribbon hover a fifth of a tile
//    off its own edge). The residual Y lift is 0.04 — under the fbm ripple, over nothing. The bias
//    is 0.11, smaller than the shortest prop on the board, so anything the player can see standing
//    on a hex occludes the line over it: an engraving, not an overlay.
//
// Draw calls: ~12 frustum-culled grid chunks (2-4 survive at gameplay zoom) + 2 for the path.
import * as THREE from 'three';
import { axialToWorld, DIRS } from '../world/hex.js';

const WATER_Y = 0.10;                 // must match water.js sea level
const CH_Q = 16, CH_R = 12;           // chunk size, in tiles
const RINGS = [0.50, 0.82, 0.94, 1.0];// radial fan, packed toward the rim where the stroke lives
// Clearance of the OUTER ring, identical for every tile. It has to be a constant: the rim ring is
// the shared edge, and if two neighbours lift it by different amounts their rasterised edges stop
// coinciding and the stroke breaks into a bead chain along every seam — a crack, not a stipple.
// terrain.js welds its corner heights, so with one constant here the two edges are the same line.
// Small enough that the stroke reads as inlaid: uBias, not this, is what wins the depth test.
const EDGE_LIFT = 0.04;

// unit hex corners, flat-top, CCW from +x — local (x, z) on the IDEAL hexagon
const C = [];
for (let k = 0; k < 6; k++) C.push([Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)]);
// ...and the rings are SAMPLED along that hexagon, not chorded corner to corner: six points
// makes every hex edge one straight 1.0 u chord in 3D, and on a plateau rim the ground falls
// away under the middle of it. Two samples per edge halve the chord. These are the LOCAL
// coordinates only — the world positions come off terrain.js's own corners (see _build) — and
// both tiles sharing an edge resample the same two welded corners, so their halves of the
// stroke are the same polyline traversed in opposite directions. One line, from both sides.
const RIM = [];
for (let k = 0; k < 6; k++) for (let sub = 0; sub < 2; sub++) {
  const a = C[k], b = C[(k + 1) % 6], t = sub / 2;
  RIM.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}
const NR = RIM.length;
// the shader derives an edge index from the fragment angle; this maps it back to a DIRS index
const EDGE_DIR = [0, 5, 4, 3, 2, 1];

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const VERT = /* glsl */`
attribute vec2 aLocal;    // position on the IDEAL hex, corner radius = 1
attribute vec2 aTile;     // uv into the state texture
attribute float aFade;    // baked per-tile legibility; negative marks a water tile
attribute float aBias;    // EXTRA depth bias, for tiles with rock standing on them (see below)
uniform sampler2D uState;
uniform float uFar, uBias;
varying vec2 vL; varying vec4 vS; varying vec3 vP; varying vec2 vT;
varying float vFade; varying float vD; varying float vWet; varying float vRock;
void main() {
  vRock = step(0.01, aBias);
  vL = aLocal; vT = aTile;
  vS = texture2D(uState, aTile);
  vWet = step(aFade, 0.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = length(toCam);
  vD = dist;
  // ATTENUATORS COMBINE WITH min(), NEVER WITH A PRODUCT. Six independent 0.8-ish terms
  // multiplied together is 0.26, and that product — not any one term — is why the lattice
  // measured invisible over the tiles the player actually clicks. min() keeps every term's
  // meaning ("this is the most the grid may be here") and drops the compounding.
  // The range ramp also starts PAST the played board: uFar*0.30 is nearer than the front row
  // of hexes, so the old ramp was already halfway down at frame centre.
  float distK  = 1.0 - smoothstep(uFar * 0.55, uFar * 1.05, dist);
  float grazeK = smoothstep(0.05, 0.22, toCam.y / dist);
  vFade = min(abs(aFade), min(distK, grazeK));
  vec4 mv = viewMatrix * wp;
  mv.xyz -= normalize(mv.xyz) * (uBias + aBias);   // pure depth bias along the eye ray: zero screen motion
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vL; varying vec4 vS; varying vec3 vP; varying vec2 vT;
varying float vFade; varying float vD; varying float vWet; varying float vRock;
uniform sampler2D uState;
uniform float uGrid, uDist, uDim, uCurR, uTime;
uniform vec3 uSun; uniform vec2 uCursor, uStep;
// water.js's own signed-distance field, published as gridMaskUniforms + gridMaskGLSL exactly
// so this pass can ask it "is there water over this square metre". 0 under water, 1 on dry
// land, with a soft shore band. The per-TILE water flag it replaces could only answer for
// whole hexes, so every river plane crossing a land tile still had the lattice running under
// it — which is the hex diagonal the critic watched continue into the sea past the shore.
uniform sampler2D uWField; uniform vec2 uWMin, uWSize; uniform float uWRange, uWHas;
float waterMask(vec2 wxz) {
  float sd = (texture2D(uWField, (wxz - uWMin) / uWSize).r * 2.0 - 1.0) * uWRange;
  return smoothstep(-0.10, 0.60, sd);
}
const float AP = 0.8660254, PI3 = 1.0471975512;
float bit(float v, float k) { return mod(floor(v / pow(2.0, k)), 2.0); }

// THE WHOLE PASS IS A MODULATE. Blending is dst*src.rgb, so every layer below is a
// per-channel MULTIPLIER on the terrain radiance that is already in the buffer, and the
// buffer is HDR-linear pre-tonemap — which means "multiplied into terrain lighting" is
// literal here, not an approximation. Three things fall out of that for free and each of
// them was a hand-tuned failure before:
//   * a border can never be brighter than the hex it is drawn on: its multiplier is < 1.
//   * nothing the pass draws can flatten the ground texture under it, because it scales
//     that texture instead of compositing a flat colour over it. The old alpha plates
//     tinted the sand into a matte quad; a modulate cannot.
//   * an overlay over lit sand and the same overlay over shaded grass are the SAME
//     ratio, so one number works across the whole board and the frame stops needing a
//     brightness that only reads at one exposure.
// Bright languages (selection, hover) use multipliers > 1: they scale the ground UP,
// so they glow without ever becoming a light source of their own.
#define MUL(k, amt) m *= mix(vec3(1.0), (k), clamp(amt, 0.0, 1.0));

void main() {
  vec3 m = vec3(1.0);
  if (vFade <= 0.004) discard;
  // exact distance to the hexagon boundary, in world units — three edge-normal half-spaces.
  // vL is the ideal local coord, so d hits 0 on the shared boundary from both sides and the
  // stroke is continuous across the seam with no polygon silhouette anywhere.
  float d = AP - max(max(abs(dot(vL, vec2(AP, 0.5))), abs(vL.y)), abs(dot(vL, vec2(-AP, 0.5))));
  // EXACT gradient magnitude, not fwidth(). fwidth is |ddx| + |ddy|, which runs up to 41%
  // large on a diagonal edge and exactly right on an axis-aligned one — an angle-varying
  // line width sold as a constant one, and the frame has six edge orientations in it at all
  // times. length() is the true world-units-per-pixel across the line, so a stroke measures
  // the same 1.5px on every one of the six orientations and nothing stair-steps.
  float px = max(length(vec2(dFdx(d), dFdy(d))), 1e-5);
  // MOIRE CUTOFF, in units a player can check: px is world units per pixel and a hex is
  // 1.732 world units across the flats, so the hex spans 1.732/px pixels. The old window
  // (0.045..0.105) started fading the lattice at 38 px per hex and had it two thirds gone at
  // 24 px — i.e. it was switching the grid off across the whole far half of a frame whose
  // tiles are still perfectly countable, and that alone was 1.5x of the missing far stroke.
  // 0.115..0.215 is 15 px down to 8 px per hex: the grid now survives everywhere a tile is
  // big enough to click and only dies where it would alias into moire.
  // ...and the cutoff must ask "HOW BIG IS THIS HEX ON SCREEN", not "how fast does the hex
  // distance field change under this pixel". Those are the same number on flat ground and
  // wildly different on a slope: a face tilted away from the lens compresses d's gradient
  // range so px runs 2-4x large, the cutoff fires, and the lattice vanishes from every steep
  // surface in the frame. That is "zero hex edges anywhere on the mountain massif", measured
  // by two separate reviews, on a biome whose tiles are still 40+ px across and perfectly
  // clickable. The HORIZONTAL footprint is the orientation-robust one — on a tilted face the
  // surface barely moves in xz per pixel, so it stays small exactly where the gradient does
  // not — and taking the min of the two keeps the honest moire cutoff on flat ground while
  // refusing to switch the grid off just because the ground is not level.
  // dp below still uses the TRUE gradient: that one is a screen-space width and it is right.
  float pxH = max(length(vec2(dFdx(vP.x), dFdy(vP.x))), length(vec2(dFdx(vP.z), dFdy(vP.z))));
  float f = min(vFade, 1.0 - smoothstep(0.115, 0.215, min(px, pxH)));
  if (f <= 0.004) discard;

  float rng = vS.r, rmask = floor(vS.g * 255.0 + 0.5), flags = floor(vS.b * 255.0 + 0.5), bmask = floor(vS.a * 255.0 + 0.5);

  // focus dim — while an order is live, everything the unit CANNOT reach loses ~10% toward a
  // cool slate. Cheap, and it is what makes the reachable region read without shouting.
  MUL(vec3(0.905, 0.900, 0.945), uDim * (1.0 - step(0.5, rng)) * (1.0 - vWet * 0.55))


  // Fill rate is the entire cost of a full-screen decal and most of a tile is empty interior:
  // anything past this radius with no state on it is done after the dim.
  if (d > 0.30 && dot(vS, vec4(1.0)) < 0.002) { gl_FragColor = vec4(mix(vec3(1.0), m, f), 1.0); return; }

  float hov = bit(flags, 0.0), sel = bit(flags, 1.0);
  float pth = bit(flags, 3.0), dst = bit(flags, 4.0);
  // DEPTH FADE. A constant-strength stroke on a 3D surface is the clearest tech-demo tell
  // after the unit: the lattice has to obey the same aerial perspective the ground does. The ramp
  // is in CAMERA-RELATIVE units because that is the only thing that tracks the zoom — at the
  // gameplay rig the whole visible board spans eye depth 18-28, so a ramp anchored at 3x the
  // camera distance (what was here) never fired inside the frame. This lands ~1.0 on the nearest
  // hex, ~0.8 at frame centre, ~0.5 at the far edge of the board and 0.28 past it.
  float att = mix(1.0, 0.68, smoothstep(uDist * 1.05, uDist * 2.30, vD));
  // which of the six edges this fragment belongs to — a perimeter is a per-edge fact
  float ek = floor(mod(atan(vL.y, vL.x) / PI3, 6.0));

  // --- the OTHER half of this edge ------------------------------------------------
  // Every stroke here is drawn on d >= 0, i.e. each tile paints only the INBOARD half of
  // its own boundary; a shared edge is two half-strokes butted together. So if the two
  // tiles disagree about what that edge is — selected on one side, claimed on the other —
  // the seam rasterises as one stroke against a different stroke with a visible colour break
  // down the middle. That IS the "double-drawn grid", and no amount of per-tile priority
  // fixes it, because the priority runs twice with two different inputs. The fix is for both
  // halves to see the same state: read the NEIGHBOUR across this edge and fold its flags in.
  // The neighbour's axial offset comes straight out of the edge angle (edge e faces
  // (e+0.5)*60deg, its centre is sqrt3 away), so there is nothing to keep in sync with hex.js.
  float th = (ek + 0.5) * PI3;
  vec2 wd = vec2(cos(th), sin(th)) * 1.7320508;
  vec2 nUV = vT + vec2(0.6666667 * wd.x, -0.3333333 * wd.x + 0.5773503 * wd.y) * uStep;
  if (nUV.x > 0.0 && nUV.x < 1.0 && nUV.y > 0.0 && nUV.y < 1.0) {
    float nf = floor(texture2D(uState, nUV).b * 255.0 + 0.5);
    hov = max(hov, bit(nf, 0.0)); sel = max(sel, bit(nf, 1.0));
  }

  vec3 nrm = normalize(cross(dFdx(vP), dFdy(vP)));
  float ndl = max(dot(nrm.y < 0.0 ? -nrm : nrm, uSun), 0.0);
  float lit = smoothstep(0.14, 0.60, ndl);
  // The lattice leans in around the pointer and thins out over board the player is not
  // reading — 0.84 at the far corners, 1.0 under the pointer. The floor is high on purpose:
  // the previous 0.68 stacked on a 0.50 distance fade and left two thirds of the frame with
  // a stroke the player could not count tiles with, which for a turn-based game is the whole
  // product. A hex the player cannot see is a hex they cannot click.
  float cur = mix(0.92, 1.0, 1.0 - smoothstep(uCurR, uCurR * 3.2, distance(vP.xz, uCursor)));
  // Over open water the lattice carries NO information — no yield, no terrain form, no movement
  // cost to count — and it is the one surface in the frame that has to read as liquid. water.js
  // draws the sea BEFORE this pass and lifts it above nothing, so a lattice line out there is a
  // wire lying on the sea. 0.13 on the bare seam and on every feature stroke (see wetK) —
  // enough to count landing tiles and to say whose water it is, quiet enough that the sea
  // still reads as liquid rather than as graph paper.
  float wet = (uWHas > 0.5) ? 1.0 - waterMask(vP.xz) : vWet;
  float g = uGrid * min(att, cur) * mix(1.0, 0.13, wet);
  float wetK = mix(1.0, 0.13, wet);
  float dp = d / px;                       // distance from the seam, IN PIXELS

  // ------------------------------------------------------------------ movement range: a FILL
  // A plate with a 6px inner feather at its own perimeter, and NO rim. A second hard line
  // running parallel to a hex edge three pixels away is the doubled rail the critic measured,
  // and a fill cannot collide with a line by construction. The feather is applied only on the
  // range's OUTER edges (rmask), or every internal hex boundary inside the range would gap.
  if (rng > 0.001) {
    float fe = mix(1.0, smoothstep(0.0, 6.0 * px, d), bit(rmask, ek));
    MUL(vec3(0.68, 0.88, 1.32), rng * 0.28 * fe * (1.0 - sel * 0.7) * wetK)
  }
  // the walked tiles get the same language one step quieter, so the order reads as a corridor
  if (pth > 0.5) MUL(vec3(0.76, 0.90, 1.24), 0.20 * wetK)
  // The DESTINATION is a plate, not a ring, and it is the one WARM thing on the board — a hex
  // outline sitting one tile from the cream selection ring is what a player reads as the grid
  // drawn twice, and a fill brightening toward its CENTRE is the opposite gradient to every
  // stroke on the board.
  if (dst > 0.5) MUL(vec3(1.30, 1.16, 0.82), att * (0.20 + 0.34 * smoothstep(0.0, 0.62, d)) * wetK)

  // ------------------------------------------------------------------ ONE stroke per edge
  // Strict priority — selection, then the pointer, then the claimed perimeter, then the bare
  // seam — and only ONE branch ever runs, with ONE profile: a 1.5px core and a 1px analytic
  // feather to zero. There is no glow, no groove and no bevel beside it, so there is nothing
  // on the board that can rasterise as a second parallel polyline. Five languages, and none of
  // them is another thin line of the same colour:
  //   selection  — WARM GOLD, brightening, 1.6px, breathing
  //   hover      — COOL PALE, brightening, 1.1px, steady
  //   territory  — CIV BLUE, DARKENING, 1.4px, lit by the ground (0.6*N.L + 0.4)
  //   movement   — a fill, above. No stroke at all.
  //   the order  — a team-blue chevron ribbon, its own mesh. No stroke at all.
  vec3 lk = vec3(1.0); float lhw = 0.0, la = 0.0;
  if (sel > 0.5) {
    lk = vec3(2.30, 1.78, 0.88); lhw = 1.70;
    la = (0.80 + 0.20 * (0.5 + 0.5 * sin(uTime * 1.9))) * wetK;
  } else if (hov > 0.5) {
    lk = vec3(1.44, 1.52, 1.66); lhw = 1.15; la = 0.85 * wetK;
  } else if (bit(bmask, ek) > 0.5) {
    // A DARKENING stroke: a multiplier < 1, so it is ink on the terrain — it keeps the
    // ground's own texture running through it and cannot be the brighter of the two at any
    // exposure. PERIMETER ONLY, and MODULATED BY THE TERRAIN'S OWN LIGHTING (0.6*N.L + 0.4). The
    // inboard wash that used to sit beside it was a second, softer, parallel band of the
    // same hue on the same edge — the doubled rail, arriving from the region side. And an
    // unlit border is a sticker: it kept the same strength on a shaded slope and on lit
    // water, which is what made it read as printed on the glass rather than lying on the
    // ground it claims.
    lk = vec3(0.34, 0.48, 0.95); lhw = 1.40; la = att * (0.6 * ndl + 0.4) * wetK;
  }

  // ONE profile for every language: solid to lhw pixels off the seam, then a 1px
  // analytic feather to zero. No second lobe beside it — the 0.32 outer skirt that
  // used to run 1-2px outboard of every core is a second polyline the moment the
  // core is anything but perfectly centred, and it is what a player reads as a
  // doubled grid. dp is in PIXELS, from the exact gradient, so the same profile
  // measures the same width on all six edge orientations and nothing stair-steps.
  if (la > 0.0) {
    MUL(lk, (1.0 - smoothstep(lhw, lhw + 1.0, dp)) * la)
  } else {
    // THE BARE TILE SEAM. One stroke, centred on d = 0, 1px of core and 1px of feather on
    // EACH side of the shared edge (2px + 2px in total, since both tiles paint their half),
    // and it is ALWAYS A DARKENING — the multiplier is below 1 at every channel, so the
    // line can never be brighter than the terrain luminance it is drawn on, at any
    // exposure and on any biome. The old pass flipped polarity with the sun and drew a
    // PALE line wherever the ground was shaded, which is a lit wire lying on unlit grass.
    // What varies with the sun is the ALPHA, not the colour: shaded ground has less local
    // contrast for the eye to work with, so the stroke leans on it harder there and backs
    // off in full sun where a 30% cut already reads from across the board.
    // The stroke has to BEAT THE MATERIAL UNDER IT. Terrain HF_rms runs 12-24 display levels
    // here; a seam is only countable at roughly twice that, so the multiplier is sized for a
    // ~32-level drop on mid-grey ground. MEASURED (tools/_gdip.mjs) on the last build: the
    // median edge dip was 44 L in the near band, 30 mid and 8.1 far against a terrain noise
    // floor of 26 / 20 / 6.3 — i.e. in the far band the stroke was sitting ON its own noise
    // floor. Three things were taking it: the moire cutoff above (1.5x), post.js's far-field
    // mip (2.5x, now masked off) and the multiplier itself, which is 0.335 rather than 0.42.
    // WARM-NEUTRAL, NOT NAVY. The old triple put blue 30% above red, which on bright grass and
    // sand reads as a neutral dark line — and on the massif, where the ground under it is a dark
    // warm rock, leaves a residue that is almost pure blue. Measured: the surviving strokes over
    // the mountains came back navy. Same luminance (0.360), warm side of neutral, so the line is
    // ink on the ground everywhere instead of ink on grass and a blue wire on rock.
    // ...and the multiply has to be sized to the VALUE UNDER IT. 0.400 on lit sand at L 0.55
    // is a 0.33 drop; the same 0.400 on shaded rock at L 0.18 is 0.11, i.e. the stroke that
    // reads across the board disappears on the one biome whose tiles a player most needs to
    // count. Rock gets a deeper multiply (aBias marks it, and only rough tiles carry one)
    // while keeping the same hue and the same single profile.
    vec3 seamK = mix(vec3(0.400, 0.355, 0.310), vec3(0.352, 0.310, 0.268), vRock);
    MUL(seamK, (1.0 - smoothstep(1.00, 2.00, dp)) * g * mix(1.16, 0.94, lit))
  }
  // ALPHA IS NOT OPACITY HERE — it is the DECAL PROTECT MASK, and it is the other half of
  // "the hex grid is nearly invisible". post.js's present pass applies a footprint-graded mip
  // to the far field (a 1px low-pass plus an 8px blob-band cut) and a 4px stroke is squarely
  // inside both bands, so ~60% of every far-field grid line was being removed by the frame's
  // own material filter after the decal had already been drawn correctly. The material wants
  // that mip; the board furniture does not. So the pass writes (1 - ink coverage) into the
  // scene target's alpha — blendDstAlpha multiplies it in, everything else in the frame leaves
  // alpha at 1 — and post.js spares whatever it marks. Coverage is measured off the modulator
  // itself, so it covers the bright languages (selection, hover) as well as the dark ones.
  float cov = clamp(abs(1.0 - dot(m, vec3(0.3333333))) * 1.9, 0.0, 1.0) * f;
  gl_FragColor = vec4(mix(vec3(1.0), m, f), 1.0 - cov);
}`;


// ---------------------------------------------------------------------------- path decal
// The order preview is a mitred ribbon: a Catmull-Rom spline through the hex CENTRES, resampled
// every ~0.28 units so it follows the relief, with the chevrons drawn analytically inside it and
// travelling along its own arc length. Screen-space glyphs cutting across hex corners is what the
// old one did; a ribbon cannot cut a corner because it never leaves its own centreline.
const RIB_VERT = /* glsl */`
attribute vec2 aUV;      // x = arc length (world units), y = -1..1 across
attribute float aA;
uniform float uBias;
varying vec2 vUV; varying float vA;
void main() {
  vUV = aUV; vA = aA;
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  mv.xyz -= normalize(mv.xyz) * uBias;
  gl_Position = projectionMatrix * mv;
}`;

const RIB_FRAG = /* glsl */`
precision highp float;
uniform float uTime;
varying vec2 vUV; varying float vA;
void main() {
  float e = 1.0 - abs(vUV.y);
  float aa = max(fwidth(vUV.y), 1e-4);
  float body = smoothstep(0.0, aa * 2.0 + 0.09, e);
  // V-shaped front: shifting the phase by |v| bends the band into a chevron pointing forward.
  // Phase runs on arc length, so the chevrons keep their spacing through every corner.
  float s = vUV.x * 1.35 - uTime * 0.85 + abs(vUV.y) * 0.42;
  float cw = max(fwidth(s), 1e-4);
  float chev = 1.0 - smoothstep(0.075, 0.095 + cw * 2.0, abs(fract(s) - 0.5));
  // TEAM BLUE, not gold, and a dark rim down both sides. The gold ribbon was the same cream
  // family as the selection ring and the old destination ring, at the same width and the same
  // softness, and it enters its destination hex ALONG an edge — so at gameplay zoom the frame
  // carried a hex outline with a second cream polyline running parallel about ten pixels
  // inboard, which is exactly what a player reads as "the grid is drawn twice". Colour is the
  // cheapest way to make two things different, and the order already has a colour: the civ's.
  float rim = 1.0 - smoothstep(0.0, aa * 2.0 + 0.34, e);      // the outer ~1.5px of the band
  float a = body * vA * (0.60 + 0.40 * chev);
  if (a <= 0.003) discard;
  // dark outline under team blue: the outline grounds the ribbon and stops it reading as a
  // painted stripe, the chevrons carry the direction of the order.
  vec3 col = mix(vec3(0.105, 0.230, 0.500), vec3(0.235, 0.430, 0.760), chev);
  col = mix(col, vec3(0.022, 0.030, 0.048), rim * 0.88);
  gl_FragColor = vec4(col * a, a);
}`;

// the destination marker and its turn count: the only two things left that want a texture
const TAG_VERT = /* glsl */`
attribute vec2 aUV; attribute vec2 aBill; attribute float aA;
uniform float uBias;
varying vec2 vUV; varying float vA;
void main() {
  vUV = aUV; vA = aA;
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  mv.xyz -= normalize(mv.xyz) * uBias;
  mv.xy += aBill;
  gl_Position = projectionMatrix * mv;
}`;
const TAG_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUV; varying float vA;
void main() {
  vec4 t = texture2D(uAtlas, vUV);
  float a = t.a * vA;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(t.rgb * a, a);
}`;

const CELL = 64, COLS = 4, ROWS = 4;            // 0 plate, 4..13 digits
const PLATE_G = 0, DIGIT = i => 4 + i;

function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL; cv.height = ROWS * CELL;
  const x = cv.getContext('2d');
  const at = i => [(i % COLS) * CELL, ((i / COLS) | 0) * CELL];
  {                                              // opaque plate behind the turn count
    const [ox, oy] = at(PLATE_G), cx = ox + 32, cy = oy + 32;
    const g = x.createRadialGradient(cx, cy, 4, cx, cy, 29);
    g.addColorStop(0, 'rgba(14,11,8,0.96)'); g.addColorStop(0.74, 'rgba(20,16,11,0.94)');
    g.addColorStop(0.88, 'rgba(255,214,140,0.98)'); g.addColorStop(1, 'rgba(255,214,140,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, 29, 0, 7); x.fill();
  }
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '700 42px ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif';
  for (let i = 0; i < 10; i++) {
    const [ox, oy] = at(DIGIT(i));
    x.lineWidth = 7; x.lineJoin = 'round'; x.strokeStyle = 'rgba(0,0,0,0.92)';
    x.strokeText(String(i), ox + 32, oy + 34);
    x.fillStyle = '#fff'; x.fillText(String(i), ox + 32, oy + 34);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4;
  return tex;
}

export class Grid {
  constructor(map, terrain) {
    this.map = map; this.terrain = terrain;
    this.group = new THREE.Group(); this.group.name = 'grid';

    this.state = new Uint8Array(map.w * map.h * 4);
    this.tex = new THREE.DataTexture(this.state, map.w, map.h, THREE.RGBAFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;

    this.uniforms = {
      uState: { value: this.tex }, uTime: { value: 0 }, uFar: { value: 70 },
      uGrid: { value: 1 }, uDist: { value: 24 }, uBias: { value: 0.11 }, uDim: { value: 0 },
      uSun: { value: new THREE.Vector3(-0.86, 0.42, -0.28).normalize() },
      uCursor: { value: new THREE.Vector2(0, 0) }, uCurR: { value: 8.5 },
      uStep: { value: new THREE.Vector2(1 / map.w, 1 / map.h) },
      // water.js's shore SDF, wired lazily in update(): main.js builds water first but only
      // publishes it on window AFTER input.js (and therefore this) is constructed.
      uWField: { value: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1) },
      uWMin: { value: new THREE.Vector2() }, uWSize: { value: new THREE.Vector2(1, 1) },
      uWRange: { value: 1 }, uWHas: { value: 0 },
    };
    this.uniforms.uWField.value.needsUpdate = true;
    this._curT = new THREE.Vector2();
    // depthTest defaults ON; depthWrite OFF + polygonOffset is what lets props, buildings and
    // units occlude the overlay instead of the overlay painting over them.
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      // out = dst * src.rgb. See the header on FRAG: the decal MODULATES the terrain
      // radiance already in the HDR buffer instead of compositing a colour over it.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      // ...and alpha is a SEPARATE channel carrying the protect mask: dst.a * src.a, so the
      // mask accumulates through every decal that touches the pixel and nothing else moves it.
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      side: THREE.DoubleSide, fog: false,
    });

    const bias = { value: 0.13 };
    this.ribMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uBias: bias },
      vertexShader: RIB_VERT, fragmentShader: RIB_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      // colour composites premultiplied; ALPHA writes the protect mask (dst.a * (1 - a)) so the
      // chevrons and the turn badge survive post.js's far-field mip the same way the lattice does
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.atlas = buildAtlas();
    this.tagMat = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: this.atlas }, uBias: bias },
      vertexShader: TAG_VERT, fragmentShader: TAG_FRAG,
      transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), this.ribMat);
    this.tags = new THREE.Mesh(new THREE.BufferGeometry(), this.tagMat);
    for (const m of [this.ribbon, this.tags]) { m.frustumCulled = false; m.renderOrder = 14; m.visible = false; this.group.add(m); }

    this._range = []; this._work = []; this._path = []; this._hover = null; this._sel = null; this._dst = null;
    this._build();
  }

  // Y of the decal, ASKED OF THE TILE THE VERTEX BELONGS TO — never of heightAt(worldXZ).
  //
  // heightAt() decides which tile owns a world point by ROUNDING the axial coordinate, and
  // every rim vertex sits exactly ON a boundary, where that rounding is a coin flip. On flat
  // ground the two answers agree to a millimetre and nobody noticed. At a cliff they are the
  // two sides of the drop, so consecutive samples along ONE edge landed alternately on the lip
  // and on the floor and the rim polyline came out a sawtooth of three-metre vertical rods.
  // MEASURED on the champion build: 818 edges carried more than 1.0 u of vertical jump between
  // samples 6 cm apart, worst 3.21 u. Rasterised at a 60-degree pitch those are the straight
  // grey scratches lying across the massif — the "grid drawn over the cliff faces as a decal on
  // the heightfield" read. Asking the tile that owns the vertex instead: worst 0.28 u.
  //
  // Duplicating terrain.js's height function is still the bug it always was, so this CALLS it
  // (_localY is heightAt's own body, minus the rounding step) rather than re-deriving it.
  tileY(i, lx, lz) {
    return Math.max(WATER_Y + 0.05, this.terrain ? this.terrain._localY(i, lx, lz) : 0);
  }
  // ...and the order ribbon, which is resampled along a spline through the hex CENTRES and so
  // never lands on a boundary, still asks by world XZ.
  surfY(x, z) {
    return Math.max(WATER_Y + 0.05, this.terrain?.heightAt(x, z) ?? 0);
  }

  _build() {
    const { map } = this, n = map.tiles.length;

    // distance to the nearest land, so open ocean keeps a lattice but a quieter one
    const dw = new Int16Array(n).fill(99); const q0 = [];
    for (const t of map.tiles) if (t.height > 0) { dw[t.i] = 0; q0.push(t); }
    for (let h = 0; h < q0.length; h++) {
      const t = q0[h];
      for (const d of DIRS) {
        const u = map.get(t.q + d.q, t.r + d.r);
        if (u && dw[u.i] > dw[t.i] + 1) { dw[u.i] = dw[t.i] + 1; q0.push(u); }
      }
    }

    // THE TILE POLYGON THE TERRAIN ACTUALLY RASTERISES, not the ideal one.
    // terrain.js welds every shared corner and then jitters it — 0.085 inland, 0.30 on a
    // shoreline — and builds the tile top, and the top of every cliff wall, out to THOSE
    // corners. The ideal hexagon therefore misses the real boundary by a measured 0.07 u
    // median and 0.42 u worst: on flat ground that is two pixels of nothing, on a cliff lip it
    // is the stroke hanging out over the drop instead of sitting on the edge it marks.
    // The rim rides the terrain's own corners; aLocal stays on the IDEAL hexagon, so `d`, the
    // pixel-constant width and the analytic AA in the shader are untouched. Both tiles read the
    // SAME welded corner, so the two halves of a shared edge still coincide exactly — and the
    // fan is still a hexagon by construction, so no 5- or 7-sided cells come back.
    const cl = this.terrain?.cornerLocal, cY = this.terrain?.cornerY;
    const chunks = new Map();
    for (const t of map.tiles) {
      const water = t.height === 0, p = axialToWorld(t.q, t.r), i = t.i;
      const cx = k => (cl ? cl[i * 12 + k * 2] : C[k][0]), cz = k => (cl ? cl[i * 12 + k * 2 + 1] : C[k][1]);
      // Corner heights straight off the terrain's welded set. The rim ring uses THESE and not
      // tileY(), because two tiles either side of a seam must land on the identical number:
      // where the corner cluster held they do (one line, no bead chain), and where it split
      // they are the lip and the wall foot — which is the boundary running down the face.
      const cyk = k => (cY ? Math.max(WATER_Y + 0.05, cY[i * 6 + k]) : this.tileY(i, cx(k), cz(k)));
      let lo = 1e9, hi = -1e9;
      for (let k = 0; k < 6; k++) { const y = cyk(k); lo = Math.min(lo, y); hi = Math.max(hi, y); }
      const relief = hi - lo;

      // Only a genuine cliff loses the lattice — a tile whose own face has more relief in it
      // than a hex is wide has no readable ground plane left to engrave. This is a guard for a
      // pathological seed and nothing more: measured on this map the honest per-tile relief is
      // 0.47 median and 1.75 worst, so nothing is culled. It used to read up to 4.85 and fade
      // three tiles out, purely because it was sampling heightAt() at the shared corners, where
      // the tile it answers for is a coin flip between the three that meet there.
      let fade = 1 - sstep(4.0, 7.5, relief);
      const rough = t.biome === 'mountain' || t.biome === 'snow';
      // NO extra cut for rock. Mountains are where a player most needs to count tiles — the
      // massif is the biggest single mass in the frame — and the relief window above already
      // takes the lattice off anything that is a genuine cliff face rather than sloped ground.
      // water keeps its per-tile fade near 1 so a hover, a selection or a coastal city's
      // border still reads out there; it is the bare LATTICE that gets taken down to ~0.13,
      // and that happens in the shader (see vWet) so the two can be separated at all.
      // (the sea's own quieting is wetK in the shader, a single 0.13 — not a second factor here)
      // ...and the sea keeps a countable board out to six rings, not one. A player counting
      // tiles to a landing site is reading open water; one ring of lattice and then nothing
      // is the same as no lattice.
      if ((water && dw[t.i] > 6) || fade < 0.03) continue;
      // clearance over terrain.js's fbm relief, which is damped to ~0.2*amp at the rim
      const lift = 0.04 + relief * 0.02 + (rough ? 0.05 : 0);

      // THE ROCK STANDS ON THE TILE THE LATTICE IS ENGRAVED INTO — but no longer ON ITS RIM.
      // terrain.js used to scatter summit lofts three hexes wide, so 53% of every visible
      // mountain rim was buried under rock and the seam needed a 1.25 view-space bias to punch
      // through it. A bias that large draws the buried edge OVER the face in front of it, at
      // the screen position of the thing it is hiding behind: that is the stray dark line
      // wandering across a summit that reads as a scratch rather than as a tile boundary.
      // Summits are now one per hex and sized to it, so the rim carries ~0.4 u of rock instead
      // of 1.14: the stroke lands on the mass's own shoulder, within a fifth of a hex of the
      // edge it marks, and reads as a joint in the rock rather than a wire across the face.
      const bias = rough ? 0.60 : 0;

      const key = ((t.q / CH_Q) | 0) * 64 + ((t.r / CH_R) | 0);
      let ch = chunks.get(key);
      if (!ch) chunks.set(key, ch = { pos: [], loc: [], uv: [], fd: [], bs: [], idx: [] });
      const b = ch.pos.length / 3;
      const uvx = (t.q + 0.5) / map.w, uvy = (t.r + 0.5) / map.h, fsign = water ? -fade : fade;
      const put = (x, y, z, lx, lz) => { ch.pos.push(x, y, z); ch.loc.push(lx, lz); ch.uv.push(uvx, uvy); ch.fd.push(fsign); ch.bs.push(bias); };

      put(p.x, this.tileY(i, 0, 0) + lift, p.z, 0, 0);
      for (const R of RINGS) for (let k = 0; k < NR; k++) {
        const e = k >> 1, e2 = (e + 1) % 6, ht = (k & 1) * 0.5;      // NR = 6 edges x 2 samples
        const lx = (cx(e) + (cx(e2) - cx(e)) * ht) * R, lz = (cz(e) + (cz(e2) - cz(e)) * ht) * R;
        const y = R === 1 ? cyk(e) + (cyk(e2) - cyk(e)) * ht + EDGE_LIFT : this.tileY(i, lx, lz) + lift;
        put(p.x + lx, y, p.z + lz, RIM[k][0] * R, RIM[k][1] * R);
      }
      for (let k = 0; k < NR; k++) {
        const k2 = (k + 1) % NR;
        ch.idx.push(b, b + 1 + k, b + 1 + k2);
        for (let r = 0; r + 1 < RINGS.length; r++) {
          const a0 = b + 1 + r * NR, a1 = a0 + NR;
          ch.idx.push(a0 + k, a1 + k, a1 + k2, a0 + k, a1 + k2, a0 + k2);
        }
      }
    }

    for (const ch of chunks.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ch.pos), 3));
      g.setAttribute('aLocal', new THREE.BufferAttribute(new Float32Array(ch.loc), 2));
      g.setAttribute('aTile', new THREE.BufferAttribute(new Float32Array(ch.uv), 2));
      g.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(ch.fd), 1));
      g.setAttribute('aBias', new THREE.BufferAttribute(new Float32Array(ch.bs), 1));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(ch.idx), 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.mat); m.renderOrder = 12;
      this.group.add(m);
    }
  }

  // ---------------------------------------------------------------- state writes
  _flag(t, bit, on) {
    if (!t) return;
    const o = t.i * 4 + 2;
    this.state[o] = on ? (this.state[o] | (1 << bit)) : (this.state[o] & ~(1 << bit));
    this.tex.needsUpdate = true;
  }
  // The outward-facing edges of a set of tiles — the only edges that carry a region's stroke.
  // `mirror` also marks the OUTSIDE neighbour's opposing edge, so the stroke straddles the
  // boundary instead of covering only the inner half of it. Without that the unowned tile keeps
  // drawing its bare seam on its own half and the perimeter arrives as a blue line with a pale
  // line 2px outside it — the doubled rail, back again from the other side.
  _border(tiles, chan, mirror = false) {
    const st = this.state, inSet = new Set(tiles.map(t => t.i));
    for (let i = chan; i < st.length; i += 4) st[i] = 0;    // stale mirror bits live outside `tiles`
    for (const t of tiles) {
      let mask = 0;
      for (let e = 0; e < 6; e++) {
        const d = DIRS[EDGE_DIR[e]], u = this.map.get(t.q + d.q, t.r + d.r);
        if (u && inSet.has(u.i)) continue;
        mask |= 1 << e;
        // e and (e+3)%6 are the same physical edge seen from the two tiles that share it
        if (mirror && u) st[u.i * 4 + chan] |= 1 << ((e + 3) % 6);
      }
      st[t.i * 4 + chan] |= mask;
    }
  }

  // the lattice concentrates wherever the player is looking: pointer if there is one, otherwise
  // whatever is selected. Kept as a target and eased in update() so it never snaps between tiles.
  _focus(t) { if (t) { const p = axialToWorld(t.q, t.r); this._curT.set(p.x, p.z); } }

  setHover(t) {
    if (t === this._hover) return;
    this._flag(this._hover, 0, false); this._hover = t; this._flag(t, 0, true);
    this._focus(t);
  }
  setSelected(t) {
    if (t === this._sel) return;
    this._flag(this._sel, 1, false); this._sel = t; this._flag(t, 1, true);
    if (!this._hover) this._focus(t);
  }
  // a city's owned tiles, drawn as one solid civ-colour PERIMETER and nothing else — the
  // inboard region wash that used to go with it was a second parallel band on the same edge.
  setWorkable(tiles = []) {
    this._work = tiles.filter(Boolean);
    this._border(this._work, 3, true);
    this.tex.needsUpdate = true;
  }
  // tiles a unit can reach: a quiet plate inside, one solid stroke around the outer boundary, and
  // the rest of the board dimmed. That triad is what separates a move overlay from a wash of blue.
  setRange(tiles = []) {
    for (const t of this._range) { this.state[t.i * 4] = 0; this.state[t.i * 4 + 1] = 0; }
    this._range = tiles.filter(Boolean);
    for (const t of this._range) this.state[t.i * 4] = 255;
    this._border(this._range, 1);
    this.uniforms.uDim.value = this._range.length ? 0.11 : 0;
    this.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- path decal
  // tiles: the whole walk including the unit's own tile. turns: what the badge shows.
  setPath(tiles = [], turns = 0) {
    for (const t of this._path) this._flag(t, 3, false);
    this._flag(this._dst, 4, false); this._dst = null;
    this._path = tiles.filter(Boolean);
    for (const t of this._path) this._flag(t, 3, true);
    const P = this._path;
    if (P.length < 2) { this.ribbon.visible = this.tags.visible = false; return; }
    this._flag(this._dst = P[P.length - 1], 4, true);   // the destination gets a PLATE, never a ring

    // Catmull-Rom through the hex centres, resampled short enough to hug the relief
    const K = P.map(t => axialToWorld(t.q, t.r));
    const at = i => K[Math.min(K.length - 1, Math.max(0, i))];
    const spline = [];
    for (let i = 0; i + 1 < K.length; i++) {
      const p0 = at(i - 1), p1 = K[i], p2 = K[i + 1], p3 = at(i + 2);
      const N = 6;
      for (let s = 0; s < N; s++) {
        const u = s / N, u2 = u * u, u3 = u2 * u;
        spline.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
          z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * u + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * u2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * u3),
        });
      }
    }
    spline.push(K[K.length - 1]);

    const pos = [], uv = [], al = [], idx = [];
    const HW = 0.170;                      // ribbon half-width, world units
    let arc = 0;
    const total = spline.reduce((s, p, i) => i ? s + Math.hypot(p.x - spline[i - 1].x, p.z - spline[i - 1].z) : 0, 0);
    for (let i = 0; i < spline.length; i++) {
      const p = spline[i], a = spline[Math.max(0, i - 1)], b = spline[Math.min(spline.length - 1, i + 1)];
      if (i) arc += Math.hypot(p.x - a.x, p.z - a.z);
      let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      // the mitre: the offset is perpendicular to the LOCAL tangent, so corners never pinch
      const nx = -tz, nz = tx, y = this.surfY(p.x, p.z) + 0.09;
      // the shaft leaves the unit's boots almost at once — a long fade-in on a one-tile order
      // left nothing on screen but a single chevron stranded mid-hex with no shaft behind it
      const alpha = Math.min(1, arc / 0.26) * (1 - sstep(total - 0.30, total, arc) * 0.80);
      for (const s of [-1, 1]) {
        pos.push(p.x + nx * HW * s, y, p.z + nz * HW * s);
        uv.push(arc, s); al.push(alpha);
      }
      if (i) { const v = (i - 1) * 2; idx.push(v, v + 1, v + 3, v, v + 3, v + 2); }
    }
    this.ribbon.geometry.dispose();
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    rg.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(uv), 2));
    rg.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(al), 1));
    rg.setIndex(idx);
    this.ribbon.geometry = rg; this.ribbon.visible = true;

    // destination marker + turn count
    const tp = [], tuv = [], tb = [], ta = [], ti = [];
    const U = cell => { const c = cell % COLS, r = (cell / COLS) | 0; return [c / COLS, 1 - (r + 1) / ROWS, (c + 1) / COLS, 1 - r / ROWS]; };
    const e = K[K.length - 1], ey = this.surfY(e.x, e.z);
    const quad = (cell, x, y, z, s, dx, dy, ground) => {
      const [u0, v0, u1, v1] = U(cell), b = tp.length / 3;
      const v = (ax, az, uu, vv) => {
        if (ground) { tp.push(x + az * s, y, z - ax * s); tb.push(0, 0); }
        else { tp.push(x, y, z); tb.push(dx + ax * s, dy + az * s); }
        tuv.push(uu, vv); ta.push(1);
      };
      v(-1, 1, u0, v1); v(1, 1, u1, v1); v(1, -1, u1, v0); v(-1, -1, u0, v0);
      ti.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const s = String(Math.max(1, Math.round(turns) || 1)), w = 0.13, by = ey + 0.92;
    quad(PLATE_G, e.x, by, e.z, 0.215, 0, 0, false);
    for (let k = 0; k < s.length; k++) quad(DIGIT(+s[k]), e.x, by, e.z, w, (k - (s.length - 1) / 2) * w * 1.35, 0, false);
    this.tags.geometry.dispose();
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tp), 3));
    tg.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(tuv), 2));
    tg.setAttribute('aBill', new THREE.BufferAttribute(new Float32Array(tb), 2));
    tg.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(ta), 1));
    tg.setIndex(ti);
    this.tags.geometry = tg; this.tags.visible = true;
  }

  update(dt, camDist) {
    this.uniforms.uTime.value += dt;
    // sky.js owns the sun; the lattice only needs to know which way it points so it can invert its
    // contrast against it. Read off the global main.js publishes — same route units.js takes.
    const sd = window.sky?.sunDir; if (sd) this.uniforms.uSun.value.copy(sd);
    // one-shot: adopt water.js's shore field the first frame it exists
    if (!this.uniforms.uWHas.value) {
      const w = window.water?.gridMaskUniforms;
      if (w) {
        this.uniforms.uWField.value = w.uWField.value;
        this.uniforms.uWMin.value.copy(w.uWMin.value);
        this.uniforms.uWSize.value.copy(w.uWSize.value);
        this.uniforms.uWRange.value = w.uWRange.value;
        this.uniforms.uWHas.value = 1;
      }
    }
    const k = Math.min(1, dt * 5), cur = this.uniforms.uCursor.value;
    cur.x += (this._curT.x - cur.x) * k; cur.y += (this._curT.y - cur.y) * k;
    this.uniforms.uDist.value += (camDist - this.uniforms.uDist.value) * Math.min(1, dt * 6);
    // the fade radius tracks the zoom: the grid never becomes a full-screen moire when the camera
    // pulls out, and never stops short of the frame edge when it pushes in
    this.uniforms.uFar.value += (Math.max(54, camDist * 2.6) - this.uniforms.uFar.value) * Math.min(1, dt * 4);
    this.uniforms.uGrid.value = 0.72 + 0.28 * (1 - sstep(60, 120, camDist));
  }

  dispose() {
    this.group.traverse(o => o.geometry?.dispose());
    this.mat.dispose(); this.ribMat.dispose(); this.tagMat.dispose(); this.tex.dispose(); this.atlas.dispose();
  }
}
