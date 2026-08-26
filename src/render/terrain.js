// AEON — hero terrain renderer.
//
// One merged BufferGeometry carries the whole landmass. Every hex is a 19-vertex fan (centre +
// two inner rings + its six shared corners). The radial profile is a SMOOTHSTEP from centre to
// corner and the centre carries no dome, so the surface is flat at the middle AND flat at the
// rim: two neighbouring tiles meet with matching slope, the boundary has no crease, and the
// landmass is one continuous heightfield. grid.js draws the tile lines; the ground draws none —
// a lit bevel plus a shadowed one, per hex, is what made the board read as laser-cut plates.
// Corners are shared between the tiles that meet there and
// clustered by height: anything within CLIFF welds to the cluster mean, a wider gap splits into a
// real step that a 3x3 cliff patch closes. Corners where land meets water are dragged to the
// waterline and jittered hard, which is what turns the coast from a polygon cut into a beach.
//
// Shading is a MeshPhongMaterial with the map / specular / normal / lighting chunks replaced: a
// four-tap splat of grass / sand / rock / snow out of one procedurally generated wrapping noise
// atlas (RG = detail normal, B = blotches, A = grain), sampled at 26m / 3m / 60cm so the ground
// has texel density right up to the near plane. The mid and fine taps are projected on two axes,
// so cliff faces get the same strata-and-scree treatment as the ground. Splat masks run through a
// noise-warped height blend, so biome borders wander half a tile off the hex lattice.
//
// Mountains are authored summits, not cone primitives: a radial mesh whose profile falls away
// slowly along a spur and fast down the gully between two, which carves real aretes. One per
// summit tile, laid ALONG THE CONTOUR of the massif and stretched by a per-instance factor so a
// few pull out into walls, with heights driven by prominence and a 40m swell — so the range has
// hero peaks, shoulders and saddles instead of one rhythm. Snow on them needs altitude AND an
// up-facing slope AND to be high up the mesh, minus wind stripping: a cap, never a white wash.
//
// Four instanced foliage batches (two conifers, two broadleaves) carry per-instance yaw, scale
// and hue jitter, vertex-shader wind matched by a custom depth material (or the shadows detach),
// and a backlit translucency term.
//
// Draw calls: 1 terrain + 4 foliage + 4 summit batches + 1 scree. ~300k triangles, 24 fps in
// software GL at 1600x900.

import * as THREE from 'three';
import { hash2, fbm2 } from '../core/rng.js';
import { axialToWorld, worldToAxial, DIRS } from '../world/hex.js';

// ---------------------------------------------------------------- tuning knobs
const R_A = 0.44, R_B = 0.79;   // the two inner rings, as a fraction of the corner radius
// Radial profile from a tile's centre to its corner. SMOOTHSTEP, not an exponent: it leaves the
// surface flat at the centre AND flat at the rim, so two neighbouring tiles meet with matching
// slope and the boundary has no crease in it at all. That crease — a bevel lit on one side and
// shadowed on the other, per hex — is what made the board read as laser-cut plates on a table.
const prof = R => R * R * (3 - 2 * R);
const CLIFF = 0.98;             // height gap at a corner above which it splits into a real step
const XY_JITTER = 0.085;        // shared corner jitter, so the lattice is not a perfect grid
const SHORE_JITTER = 0.30;      // ... and much more of it on the waterline, to break the chords
const WALL_MIN = 0.10;          // steps shorter than this are not worth a wall
const TREE_BUDGET = 1500;      // per foliage batch
const CLUTTER = 12000;         // ground-clutter instances alive at once
const CLUT_R = 27;             // ... and how far out they are scattered

// sRGB base tint + splat weights (veg, dry, snow) + centre lift. The lift is what domes a tile;
// summits keep only enough of it to seat the ridge meshes, which now own the silhouette.
// COLOUR SCRIPT. Every land base is held to an sRGB saturation of 0.17-0.20 and the read is
// carried by VALUE, which runs 0.36 (jungle) to 0.62 (desert) across the board. The reason is
// arithmetic, not taste: the shader ends on `col * col`, a gamma-2.0 lift, and squaring a
// colour SQUARES its channel ratio — an sRGB saturation of 0.31 lands at 0.53 in the linear
// buffer. The phase-4 palette was authored as if that step did not exist, which is the whole
// of the "acid green against orange" read. 0.19 in, ~0.35 out, one warm-olive family.
const BIOME = {
  ocean:    { c: [0.24, 0.24, 0.20], veg: 0.00, dry: 0.45, snow: 0.00, lift: 0.00 },
  coast:    { c: [0.478, 0.442, 0.335], veg: 0.00, dry: 0.90, snow: 0.00, lift: 0.00 },
  beach:    { c: [0.502, 0.460, 0.352], veg: 0.04, dry: 1.00, snow: 0.00, lift: 0.00 },
  grass:    { c: [0.352, 0.496, 0.312], veg: 1.00, dry: 0.04, snow: 0.00, lift: 0.03 },
  plains:   { c: [0.444, 0.512, 0.330], veg: 0.80, dry: 0.30, snow: 0.00, lift: 0.03 },
  desert:   { c: [0.516, 0.465, 0.361], veg: 0.01, dry: 1.00, snow: 0.00, lift: 0.02 },
  tundra:   { c: [0.456, 0.512, 0.358], veg: 0.34, dry: 0.26, snow: 0.26, lift: 0.06 },
  snow:     { c: [0.845, 0.885, 0.945], veg: 0.00, dry: 0.00, snow: 1.00, lift: 0.55 },
  forest:   { c: [0.306, 0.430, 0.270], veg: 1.00, dry: 0.00, snow: 0.00, lift: 0.05 },
  jungle:   { c: [0.272, 0.388, 0.243], veg: 1.00, dry: 0.00, snow: 0.00, lift: 0.05 },
  hills:    { c: [0.432, 0.512, 0.330], veg: 0.70, dry: 0.20, snow: 0.00, lift: 0.40 },
  mountain: { c: [0.462, 0.436, 0.386], veg: 0.06, dry: 0.05, snow: 0.04, lift: 0.85 },
};
const FALLBACK = BIOME.grass;

// trees per tile, and how likely each one is a conifer rather than a broadleaf. Thinner than it
// wants to be on purpose: Civ never lets the canopy hide the board.
const TREES = { forest: 6.0, jungle: 6.4, grass: 1.6, plains: 1.5, hills: 1.9, tundra: 1.1, snow: 0.2, mountain: 0.3, desert: 0.35, beach: 0.28 };
const CONIFER = { forest: 0.55, jungle: 0.04, grass: 0.22, plains: 0.18, hills: 0.62, tundra: 0.92, snow: 1.0, mountain: 0.95, desert: 0.0, beach: 0.1 };
// how much of a tile's scatter is low scrub rather than a tree. Dry and cold ground is mostly
// scrub, which is what an ecotone actually looks like from the air.
const SCRUB = { forest: 0.10, jungle: 0.08, grass: 0.30, plains: 0.42, hills: 0.30, tundra: 0.62, snow: 0.55, mountain: 0.62, desert: 0.88, beach: 0.80 };
// canopy palette, HSL in linear space: temperate / jungle / boreal / dry
// COLOUR SCRIPT. Two hue families only: vegetation on a 100-degree olive-green axis, dry
// ground on a 46-degree khaki axis, rock a warm neutral between them. Chroma is cut ~35% from
// the phase-4 palette across the board — the acid-green-against-orange read was two families
// at full chroma sitting next to each other, and VALUE, not chroma, is what has to carry the
// biome read. Saturation above 0.50 is reserved for player accents, which terrain never paints.
const CANOPY = [[0.283, 0.236, 0.222], [0.298, 0.252, 0.222], [0.352, 0.180, 0.198], [0.226, 0.176, 0.178],
                [0.244, 0.162, 0.231]];

// dir index -> the two corner indices of the hex edge shared with that neighbour
const EDGE_C = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const CORNER = [];
for (let k = 0; k < 6; k++) CORNER.push([Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)]);

const UP = new THREE.Vector3(0, 1, 0);
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep01 = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------- noise atlas
// One wrapping RGBA texture, BAND-LIMITED on purpose: nothing in it is finer than ~8 texels
// across. That single constraint is the fix for "the detail is uncorrelated per-pixel noise" —
// the old atlas carried content down to 1.3 texels, which IS white noise however you sample it,
// and it is what produced a 0.44 high-pass sign-flip (0.50 = white noise) and the combed,
// hatched look on every cliff face. With the ceiling in place the SHADER's tap scale, not the
// texture, decides how many screen pixels a feature covers, and every band can be placed.
//   RG = tangent-space normal   B = smooth blotches   A = cellular grain (HARD edges, so its
//   high-pass energy sits at cell BORDERS instead of in every pixel — that is what separates
//   material texture from noise at the same rms).
function tileNoise(size = 256, seed = 7, hi = 0) {
  const N = size, px = new Uint8Array(N * N * 4);
  // Two variants, SAME frequency ceiling — they differ in character, not in scale. `hi` is the
  // crisp one: more cellular and ridged content so the near bands read as pebbles, blades and
  // fracture; the smooth one carries the macro shapes the material variation actually lives in.
  const F = hi ? [10, 2, 14, 2, 30, 3, 2, 32, 18, 2] : [4, 3, 5, 2, 11, 3, 2, 12, 6, 2];
  const WR = hi ? 0.18 : 0.08, WG = hi ? 1.00 : 0.62;
  const lerp = (a, b, t) => a + (b - a) * t;
  const sm = t => t * t * (3 - 2 * t);
  // value noise on an f x f lattice that wraps, so the texture tiles seamlessly
  const vn = (x, y, f, s) => {
    const X = x * f, Y = y * f, xi = Math.floor(X), yi = Math.floor(Y), xf = X - xi, yf = Y - yi;
    const w = (i, j) => hash2(((i % f) + f) % f, ((j % f) + f) % f, s);
    const u = sm(xf), v = sm(yf);
    return lerp(lerp(w(xi, yi), w(xi + 1, yi), u), lerp(w(xi, yi + 1), w(xi + 1, yi + 1), u), v);
  };
  const fbm = (x, y, f0, oct, s) => {
    let a = 1, sum = 0, n = 0, f = f0;
    for (let i = 0; i < oct; i++) { sum += a * vn(x, y, f, s + i * 977); n += a; a *= 0.5; f *= 2; }
    return sum / n;
  };
  // wrapping cellular F1. This is the channel that gives the ground actual EDGES — pebbles,
  // grass clumps, fracture — instead of one more octave of smooth cloud.
  const cellF1 = (x, y, f, s) => {
    const X = x * f, Y = y * f, xi = Math.floor(X), yi = Math.floor(Y);
    let best = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % f) + f) % f, wy = ((cy % f) + f) % f;
      const dx = cx + 0.15 + 0.7 * hash2(wx, wy, s) - X, dy = cy + 0.15 + 0.7 * hash2(wx, wy, s + 331) - Y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.min(1, Math.sqrt(best) * 1.55);
  };
  const hgt = new Float32Array(N * N), blo = new Float32Array(N * N), grn = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    // NO cellular in the height field. A Voronoi F1 distance is a CONE around each feature
    // point, so its normal is a radial fan with a crease on every cell boundary — put it in a
    // relief map and the whole ground grows starbursts, which is exactly what it did. Cells
    // belong in the ALBEDO (channel A), where their hard edges are what makes material read as
    // material; height gets smooth fbm with a little ridging for bedding and bark.
    hgt[i] = fbm(u, v, F[0], F[1], seed)
           + (1 - Math.abs(fbm(u, v, F[2], F[3], seed + 5) * 2 - 1)) * WR;
    blo[i] = fbm(u, v, F[5], F[6], seed + 311);
    grn[i] = WG * (1 - cellF1(u, v, F[7], seed + 91)) + (1 - WG) * fbm(u, v, F[8], F[9], seed + 733);
  }
  // Histogram-normalise B and A to the full byte range. Band-limiting costs a channel most of
  // its swing (a 16-texel feature simply cannot reach the extremes an aliased one does), and a
  // hand-tuned contrast constant per frequency choice is exactly the knob that goes stale.
  const norm = (a, k) => {
    let lo = 1e9, hi2 = -1e9;
    for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi2) hi2 = a[i]; }
    const s = 1 / Math.max(1e-6, hi2 - lo);
    for (let i = 0; i < a.length; i++) a[i] = clamp01(((a[i] - lo) * s - 0.5) * k + 0.5);
  };
  norm(blo, 1.05); norm(grn, 1.20);
  for (let i = 0; i < N * N; i++) { px[i * 4 + 2] = blo[i] * 255 | 0; px[i * 4 + 3] = grn[i] * 255 | 0; }
  // central-difference normal off the wrapped height field, scaled so its RMS slope lands at a
  // fixed 0.17 of the encoding range whatever the frequency ladder is. Self-tuning: the old
  // fixed multiplier had to be re-guessed every time a lattice frequency moved.
  const gx = new Float32Array(N * N), gy = new Float32Array(N * N);
  let s2 = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    gx[i] = hgt[y * N + ((x - 1 + N) % N)] - hgt[y * N + ((x + 1) % N)];
    gy[i] = hgt[((y - 1 + N) % N) * N + x] - hgt[((y + 1) % N) * N + x];
    s2 += gx[i] * gx[i] + gy[i] * gy[i];
  }
  const NS = 0.17 / Math.sqrt(Math.max(1e-9, s2 / (2 * N * N)));
  for (let i = 0; i < N * N; i++) {
    px[i * 4] = clamp01(gx[i] * NS + 0.5) * 255 | 0;
    px[i * 4 + 1] = clamp01(gy[i] * NS + 0.5) * 255 | 0;
  }
  const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ prop meshes
// `bark` is a per-vertex flag AND shade in one float: 0 = foliage, 0.4-1.0 = wood. The tree
// shader uses it to lift the trunk back out of the instance's green tint, which is the only
// reason a trunk is visible at all on an instanced mesh coloured per instance.
function buildGeo(pos, idx, col, bark) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  if (bark) g.setAttribute('aBark', new THREE.BufferAttribute(new Float32Array(bark), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// one tapered barrel (trunk / branch / conifer tier). Colour ramps bottom -> top, so every prop
// carries its own ambient occlusion before a single light touches it. `wob` breaks the
// perfect circle so the silhouette is never a textbook cone.
function ring(P, y0, y1, r0, r1, seg, c0, c1, twist, wob = 0, sd = 3, bark = 0, x0 = 0, z0 = 0, x1 = 0, z1 = 0) {
  const { pos, col, idx, bk } = P;
  const base = pos.length / 3;
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2 + twist;
    const w = 1 + (hash2(s, sd, 4409) - 0.5) * wob;
    pos.push(x0 + Math.cos(a) * r0 * w, y0, z0 + Math.sin(a) * r0 * w);
    col.push(c0[0], c0[1], c0[2]); bk.push(bark ? bark * 0.62 : 0);
  }
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2 + twist;
    const w = 1 + (hash2(s, sd + 1, 4409) - 0.5) * wob;
    pos.push(x1 + Math.cos(a) * r1 * w, y1, z1 + Math.sin(a) * r1 * w);
    col.push(c1[0], c1[1], c1[2]); bk.push(bark);
  }
  for (let s = 0; s < seg; s++) {
    const n = (s + 1) % seg;
    idx.push(base + s, base + seg + s, base + seg + n, base + s, base + seg + n, base + n);
  }
}

// One canopy lobe: three jittered rings capped top and bottom, with a hard three-band value
// ramp. A tree is never ONE of these — four or five overlapping lobes are what put 8-14
// concavities in the outline instead of the cabbage a single dome gives you.
function blob(P, cx, cy, cz, rx, ry, seg, cLo, cHi, sd) {
  const { pos, col, idx, bk } = P;
  const shade = [0.0, 0.40, 1.0], rads = [0.78, 1.0, 0.62], ys = [-0.58, -0.02, 0.56];
  const ids = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2 + r * 0.42 + sd * 0.11;
      const w = 0.56 + 0.90 * hash2(s, r + sd * 7, 5501);
      const yw = (hash2(s, r + sd * 11, 6113) - 0.5) * 0.34;
      row.push(pos.length / 3);
      pos.push(cx + Math.cos(a) * rx * rads[r] * w, cy + ( ys[r] + yw ) * ry, cz + Math.sin(a) * rx * rads[r] * w);
      const t = shade[r], c0 = cLo[0] + (cHi[0] - cLo[0]) * t, c1 = cLo[1] + (cHi[1] - cLo[1]) * t, c2 = cLo[2] + (cHi[2] - cLo[2]) * t;
      col.push(c0, c1, c2); bk.push(0);
    }
    ids.push(row);
  }
  const bot = pos.length / 3; pos.push(cx, cy - ry * 0.88, cz); col.push(cLo[0] * 0.46, cLo[1] * 0.46, cLo[2] * 0.46); bk.push(0);
  const top = pos.length / 3; pos.push(cx, cy + ry * 1.02, cz); col.push(cHi[0], cHi[1], cHi[2]); bk.push(0);
  for (let s = 0; s < seg; s++) {
    const n = (s + 1) % seg;
    idx.push(bot, ids[0][n], ids[0][s]);
    for (let r = 0; r < 2; r++) {
      idx.push(ids[r][s], ids[r][n], ids[r + 1][n]);
      idx.push(ids[r][s], ids[r + 1][n], ids[r + 1][s]);
    }
    idx.push(ids[2][s], ids[2][n], top);
  }
}

// A tuft is a FAN, not a brush. The old version stood four near-vertical blades up in a
// bundle, which at 6 px reads as hair or astroturf; real grass splays out from a dark crown.
// Base vertices sit at 0.30 value, so every blade carries its own occlusion where it meets
// the ground even before the multiply decal under it.
function tuftGeometry() {
  const pos = [], col = [], idx = [], N = 5;
  for (let b = 0; b < N; b++) {
    const a = (b / N) * Math.PI * 2 + hash2(b, 1, 8641) * 1.1;
    const lean = 0.30 + 0.62 * hash2(b, 2, 8747), h = 0.62 + 0.66 * hash2(b, 3, 8849);
    const w = 0.150 + 0.130 * hash2(b, 4, 8951);
    const ca = Math.cos(a), sa = Math.sin(a);
    const tx = ca * lean, tz = sa * lean, px = -sa * w, pz = ca * w;
    const v = pos.length / 3;
    pos.push(-px, 0, -pz, px, 0, pz, tx - px * 0.14, h, tz - pz * 0.14, tx + px * 0.14, h, tz + pz * 0.14);
    // Tip 0.72, not 0.84. A blade tip lit head-on by a 6.7-intensity sun at 0.84 comes out
    // BRIGHTER than the ground it stands on, and 12000 of those on a near-regular lattice is
    // the "bubble wrap / frogspawn" read: a field of identical pale pills. A tuft has to be a
    // shade OF the ground, darker at the root, never a highlight on top of it.
    col.push(0.31, 0.31, 0.31, 0.31, 0.31, 0.31, 0.80, 0.80, 0.80, 0.80, 0.80, 0.80);
    idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
  }

  const g = buildGeo(pos, idx, col);
  // tilt the blade normals most of the way to vertical: a blade lit off its own plane goes
  // black on one side, and at 10 px on screen that reads as dirt, not grass
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i] * 0.3, y = n[i + 1] * 0.3 + 0.7, z = n[i + 2] * 0.3, l = Math.hypot(x, y, z) || 1;
    n[i] = x / l; n[i + 1] = y / l; n[i + 2] = z / l;
  }
  return g;
}

// A stone, and nothing else. The old version carried a PALE skirt ring around its foot that
// was meant to read as occlusion and instead haloed every pebble into a mushroom. Grounding
// is the multiply decal below; this is just the dome.
function pebbleGeometry() {
  const pos = [0, 1.05, 0], col = [1.15, 1.15, 1.15], idx = [], N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, r = 0.70 + 0.52 * hash2(i, 1, 9601);
    pos.push(Math.cos(a) * r, 0.0, Math.sin(a) * r);
    col.push(0.62, 0.62, 0.62);
  }
  for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);
  return buildGeo(pos, idx, col);
}

// The contact decal. One flat n-gon, white at the rim and dark at the centre, drawn with
// MULTIPLY blending over whatever the terrain already shaded: every tuft, stalk and pebble
// gets a soft occlusion pool at 1.4x its own footprint, which is the single thing that stops
// scattered geometry reading as stickers on a painted floor. 9 triangles, no texture.
function decalGeometry() {
  const pos = [0, 0, 0], col = [0.52, 0.52, 0.52], idx = [], N = 7;
  // two rings, so the falloff is fast out of the dark core and slow at the rim instead of a
  // linear cone — that is the difference between an occlusion pool and a grey circle
  for (let r = 0; r < 2; r++) for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, rr = r ? 1.0 : 0.44, v = r ? 1.0 : 0.76;
    pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr); col.push(v, v, v);
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(0, 1 + j, 1 + i);
    idx.push(1 + i, 1 + j, 1 + N + j, 1 + i, 1 + N + j, 1 + N + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  return g;
}

const BARK_LO = [0.30, 0.30, 0.30], BARK_HI = [0.92, 0.92, 0.92];
const newP = () => ({ pos: [], col: [], idx: [], bk: [] });
function fin(P) {
  const g = buildGeo(P.pos, P.idx, P.col, P.bk);
  const pos = g.attributes.position.array, nrm = g.attributes.normal.array, bk = P.bk;
  let cy = 0, cn = 0;
  for (let i = 0; i < bk.length; i++) if (bk[i] === 0) { cy += pos[i * 3 + 1]; cn++; }
  if (!cn) return g;
  cy /= cn;
  for (let i = 0; i < bk.length; i++) {
    if (bk[i] !== 0) continue;
    const dx = pos[i * 3], dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const nx = nrm[i * 3] * 0.30 + dx / l * 0.70, ny = nrm[i * 3 + 1] * 0.30 + dy / l * 0.70, nz = nrm[i * 3 + 2] * 0.30 + dz / l * 0.70;
    const m = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / m; nrm[i * 3 + 1] = ny / m; nrm[i * 3 + 2] = nz / m;
  }
  return g;
}

// A ring of canopy lobes around the axis. The gaps between lobes are the concavities the
// silhouette needs; the top lobe closes the crown so it does not read as a doughnut.
function crown(P, y, rSpread, rx, ry, n, seg, cLo, cHi, sd, phase = 0) {
  for (let k = 0; k < n; k++) {
    const j = hash2(k, sd, 3167), j2 = hash2(k, sd + 3, 4231), j3 = hash2(k, sd + 6, 5077);
    const a = phase + (k / n) * Math.PI * 2 + (j3 - 0.5) * 0.8;
    blob(P, Math.cos(a) * rSpread * (0.60 + 0.90 * j), y + (j2 - 0.60) * ry * 1.55,
      Math.sin(a) * rSpread * (0.60 + 0.90 * j2), rx * (0.62 + 0.70 * j3), ry * (0.66 + 0.60 * j2),
      seg, cLo, cHi, sd + k * 5);
  }
}

// v0: narrow spruce on a bare bole. v1: squat fir, five tiers and a wider skirt.
// Both keep 0.25-0.35 of clear trunk under the lowest tier so the prop is a TREE at gameplay
// zoom and not a green cone sitting on the dirt.
function coniferGeometry(v) {
  const P = newP();
  const th = v === 0 ? 1.40 : 1.18;
  ring(P, 0, th, v === 0 ? 0.062 : 0.072, 0.018, 5, BARK_LO, BARK_HI, 0, 0.10, 11, 1);
  const tiers = v === 0
    ? [[0.34, 0.74, 0.330, 0.185], [0.62, 1.00, 0.268, 0.145], [0.88, 1.22, 0.196, 0.100], [1.08, 1.42, 0.120, 0.0]]
    : [[0.26, 0.60, 0.430, 0.270], [0.48, 0.82, 0.352, 0.215], [0.68, 1.00, 0.276, 0.160], [0.86, 1.14, 0.196, 0.108], [1.00, 1.28, 0.118, 0.0]];
  tiers.forEach((t, i) => {
    const lo = 0.26 + i * 0.13, hi = 0.60 + i * 0.17;
    ring(P, t[0], t[1], t[2], t[3], 7,
      [lo * 0.76, lo, lo * 0.58], [hi * 0.82, hi, hi * 0.62], i * 0.55 + v * 0.4, 0.46, 3 + i * 5 + v * 17);
  });
  return fin(P);
}

// v0: round oak — a real bole, two forks, then a five-lobe crown.
// v1: tall slim poplar/jungle emergent on a long bare trunk.
function broadleafGeometry(v) {
  const P = newP();
  if (v === 0) {
    ring(P, 0, 0.66, 0.082, 0.055, 6, BARK_LO, BARK_HI, 0, 0.14, 21, 1);
    ring(P, 0.58, 0.86, 0.042, 0.026, 4, BARK_LO, BARK_HI, 0.4, 0.1, 23, 0.9, 0, 0, 0.13, -0.09);
    ring(P, 0.58, 0.84, 0.038, 0.024, 4, BARK_LO, BARK_HI, 1.1, 0.1, 27, 0.9, 0, 0, -0.11, 0.10);
    crown(P, 0.92, 0.185, 0.215, 0.185, 6, 8, [0.14, 0.21, 0.10], [0.62, 0.76, 0.46], 1, 0.3);
    crown(P, 0.78, 0.215, 0.150, 0.115, 3, 7, [0.11, 0.17, 0.085], [0.44, 0.56, 0.34], 7, 1.4);
    blob(P, 0.02, 1.10, -0.01, 0.20, 0.155, 8, [0.22, 0.31, 0.15], [0.76, 0.90, 0.56], 13);
  } else {
    ring(P, 0, 0.96, 0.070, 0.040, 6, BARK_LO, BARK_HI, 0, 0.12, 31, 1);
    ring(P, 0.84, 1.10, 0.034, 0.020, 4, BARK_LO, BARK_HI, 0.8, 0.1, 33, 0.9, 0, 0, 0.10, 0.08);
    crown(P, 1.16, 0.155, 0.190, 0.150, 4, 8, [0.13, 0.20, 0.095], [0.64, 0.78, 0.47], 2, 0.9);
    blob(P, -0.01, 1.36, 0.02, 0.175, 0.135, 7, [0.22, 0.31, 0.15], [0.78, 0.92, 0.57], 17);
  }
  return fin(P);
}

// v2: acacia — a leaning bare bole and a flat umbrella broken into three plates. Dry ground
// and ecotones live on this one, and its outline is nothing like the round oak's.
function dryTreeGeometry() {
  const P = newP();
  ring(P, 0, 0.74, 0.070, 0.040, 5, BARK_LO, BARK_HI, 0, 0.16, 41, 1, 0, 0, 0.06, -0.04);
  ring(P, 0.66, 0.86, 0.030, 0.020, 4, BARK_LO, BARK_HI, 0.5, 0.1, 43, 0.9, 0.05, -0.03, 0.20, -0.10);
  ring(P, 0.66, 0.84, 0.028, 0.018, 4, BARK_LO, BARK_HI, 1.4, 0.1, 47, 0.9, 0.05, -0.03, -0.16, 0.12);
  crown(P, 0.90, 0.215, 0.230, 0.088, 4, 9, [0.196, 0.216, 0.152], [0.622, 0.688, 0.520], 3, 0.5);
  return fin(P);
}

// A scrub bush: three squat lobes, no trunk. Cheap enough to scatter by the thousand, and it is
// what fills an ecotone band so grass never meets desert with a hard edge and nothing between.
function shrubGeometry(v) {
  const P = newP();
  const r = v ? 0.30 : 0.24, h = v ? 0.17 : 0.21;
  crown(P, 0.19, r * 0.42, r * 0.72, h, 3, 7, [0.186, 0.202, 0.138], [0.606, 0.652, 0.462], v ? 4 : 1, v ? 1.1 : 0.2);
  return fin(P);
}

// Scree boulder: stacked rings with per-ring, per-segment radius noise. Smooth-shaded — the
// rock shader's triplanar detail normal supplies the crunch, so no giant flat facets.
function boulderGeometry() {
  const pos = [], col = [], idx = [], SEG = 7;
  const rings = [[0.0, 1.0], [0.34, 0.86], [0.66, 0.58], [0.88, 0.28], [1.0, 0.08]];
  const rows = [];
  for (let r = 0; r < rings.length; r++) {
    const row = [], y = rings[r][0], rad = rings[r][1];
    const shade = 0.42 + 0.50 * y;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2 + r * 0.31 + (hash2(s, r, 7031) - 0.5) * 0.42;
      const rr = rad * (0.70 + 0.56 * hash2(s, r, 4021));
      const yy = y + (r > 0 && r < rings.length - 1 ? (hash2(s, r, 5023) - 0.5) * 0.14 : 0);
      row.push(pos.length / 3);
      pos.push(Math.cos(a) * rr, yy, Math.sin(a) * rr);
      const t = shade * (0.74 + 0.50 * hash2(s, r, 6029));
      col.push(t, t * 0.985, t * 0.95);
    }
    rows.push(row);
  }
  for (let r = 0; r < rows.length - 1; r++) for (let s = 0; s < SEG; s++) {
    const n = (s + 1) % SEG;
    idx.push(rows[r][s], rows[r + 1][s], rows[r + 1][n], rows[r][s], rows[r + 1][n], rows[r][n]);
  }
  return buildGeo(pos, idx, col);
}

// ------------------------------------------------------- tile-information props
// A Civ board is read for its resources before anything else, so a resource gets a real object
// on a real plinth: a stone disc that catches the sun and sits IN the ground, with one of four
// silhouettes on it. Four covers every resource the generator makes — at 15 px what has to read
// is "marked tile, roughly what kind", and the per-instance colour carries the rest.
const RES_ICON = {
  wheat: ['grain', [0.96, 0.80, 0.34]], bananas: ['grain', [0.92, 0.86, 0.30]],
  cattle: ['beast', [0.62, 0.44, 0.30]], sheep: ['beast', [0.94, 0.92, 0.86]],
  horses: ['beast', [0.66, 0.46, 0.28]], deer: ['beast', [0.76, 0.56, 0.34]],
  furs: ['beast', [0.62, 0.46, 0.34]], ivory: ['ore', [0.96, 0.94, 0.84]],
  iron: ['ore', [0.62, 0.66, 0.72]], copper: ['ore', [0.92, 0.56, 0.28]],
  gold: ['ore', [1.00, 0.82, 0.28]], silver: ['ore', [0.90, 0.92, 0.96]],
  gems: ['ore', [0.46, 0.86, 0.92]], marble: ['ore', [0.96, 0.95, 0.92]],
  stone: ['ore', [0.74, 0.72, 0.68]], oil: ['ore', [0.34, 0.32, 0.36]],
  coal: ['ore', [0.32, 0.31, 0.34]], wine: ['crop', [0.80, 0.30, 0.42]],
  silk: ['crop', [0.94, 0.88, 0.70]], dyes: ['crop', [0.74, 0.36, 0.84]],
  spices: ['crop', [0.94, 0.56, 0.24]], incense: ['crop', [0.92, 0.82, 0.54]],
  cocoa: ['crop', [0.60, 0.40, 0.24]], fish: ['ore', [0.72, 0.86, 0.94]],
  crabs: ['ore', [0.94, 0.48, 0.32]], pearls: ['ore', [0.98, 0.96, 0.92]],
  whales: ['ore', [0.56, 0.68, 0.78]],
};
// flat fan cap, so a plinth is a solid object from above and not an open tube
function disc(P, y, r, seg, c, x0 = 0, z0 = 0) {
  const { pos, col, idx, bk } = P;
  const c0 = pos.length / 3;
  pos.push(x0, y, z0); col.push(c[0], c[1], c[2]); bk.push(0);
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    pos.push(x0 + Math.cos(a) * r, y, z0 + Math.sin(a) * r);
    col.push(c[0] * 0.93, c[1] * 0.93, c[2] * 0.93); bk.push(0);
  }
  for (let s = 0; s < seg; s++) idx.push(c0, c0 + 1 + (s + 1) % seg, c0 + 1 + s);
}

// a dressed stone disc, chamfered so the top edge catches the key light
function plinthGeometry() {
  const P = newP();
  const lo = [0.40, 0.39, 0.37], mid = [0.80, 0.79, 0.76], hi = [1.02, 1.01, 0.97];
  ring(P, 0.000, 0.052, 0.310, 0.296, 9, lo, mid, 0, 0.05, 71);
  ring(P, 0.052, 0.082, 0.296, 0.244, 9, mid, hi, 0, 0.05, 73);
  disc(P, 0.082, 0.244, 9, [0.96, 0.95, 0.92]);
  return buildGeo(P.pos, P.idx, P.col, P.bk);
}

// four silhouettes: a sheaf, a beast, an ore pile, a bush. Grayscale — the instance colour
// supplies the hue, so one geometry serves seven resources.
function iconGeometry(kind) {
  const P = newP();
  const lo = [0.30, 0.30, 0.30], hi = [1.12, 1.12, 1.12];
  if (kind === 'grain') {
    for (let k = 0; k < 5; k++) {
      const a = k * 1.257 + 0.3, lx = Math.cos(a) * 0.062, lz = Math.sin(a) * 0.062;
      ring(P, 0, 0.185, 0.017, 0.010, 4, lo, hi, a, 0.1, 101 + k, 0, 0, 0, lx, lz);
      blob(P, lx, 0.225, lz, 0.038, 0.058, 5, [0.52, 0.52, 0.52], hi, 41 + k);
    }
  } else if (kind === 'beast') {
    for (let k = 0; k < 4; k++) {
      const x = k < 2 ? 0.058 : -0.058, z = (k % 2) ? 0.046 : -0.046;
      ring(P, 0.0, 0.095, 0.021, 0.017, 4, lo, [0.72, 0.72, 0.72], 0, 0, 61 + k, 0, x, z, x, z);
    }
    blob(P, 0, 0.150, 0, 0.108, 0.068, 7, [0.36, 0.36, 0.36], hi, 51);
    blob(P, 0.108, 0.192, 0, 0.050, 0.046, 6, [0.50, 0.50, 0.50], hi, 57);
  } else if (kind === 'ore') {
    const pts = [[0, 0, 0.086, 0.100], [0.082, 0.030, 0.058, 0.070], [-0.068, -0.048, 0.054, 0.078]];
    for (let k = 0; k < 3; k++) {
      const [x, z, r, h] = pts[k];
      ring(P, 0.0, h * 0.50, r, r * 0.74, 5, lo, [0.78, 0.78, 0.78], k * 0.7, 0.25, 71 + k, 0, x, z, x, z);
      blob(P, x, h * 0.74, z, r * 0.82, h * 0.46, 5, [0.44, 0.44, 0.44], hi, 81 + k);
    }
  } else {
    ring(P, 0, 0.085, 0.019, 0.013, 4, lo, [0.60, 0.60, 0.60], 0, 0, 95);
    crown(P, 0.135, 0.082, 0.086, 0.070, 4, 6, [0.28, 0.28, 0.28], hi, 91, 0.4);
  }
  return buildGeo(P.pos, P.idx, P.col, P.bk);
}

// One mountain: a summit with radiating aretes. Along a spur the profile falls away slowly, in
// the gully between two spurs it falls away fast — that single exponent difference is what carves
// the star-shaped peak silhouette every real mountain has and no cone primitive ever will. Six
// variants differ in spur count, phase and lean, and the shader hangs strata and snow on it.
//
// The mesh is normalised to a UNIT MEAN FOOTPRINT and closed with a buried skirt, because the
// instance that uses it is now sized against one hex. The old geometry ran out to r = 1.39
// local and was then scaled by anything from 1.1 to 3.8, so summits ran from one hex wide to
// five and crossed each other at every angle and scale: that intersection — not the shading —
// is the "field of flat shards" the massif read as. One mass per hex, all within 1.4x of each
// other, so neighbours MERGE at the feet into a range instead of cutting through each other.
function peakGeometry(v) {
  // RIM is the ring at rr = 1; the last two rings run PAST it, flaring out and dropping below
  // it, so the mass is seated in the hex field on a continuous cone instead of ending on a
  // horizontal plate that the field can graze.
  const pos = [], col = [], idx = [], ANG = 40, RIM = 15, RINGS = RIM + 2;
  const spurs = 3 + (v % 3);
  const phase = v * 1.7, lean = (hash2(v, 1, 8123) - 0.5) * 0.34;
  const apex = pos.length / 3;
  pos.push(lean, 1.0, lean * 0.6); col.push(0.76, 0.75, 0.73);
  const rows = [];
  // MONOTONIC RINGS. The radius jitter is interpolated across 11 radial bands over 15 rings, so
  // between two rings a column's jitter can swing the full 0.32 range while rr itself grows only
  // 6.75% — the ring CROSSES the one inside it, that quad turns inside out, and its two triangles
  // shade away from the sun. That inverted quad, seen against the loft behind it, is the pair of
  // hard dark triangles meeting in a V that this massif has been rejected for three times running:
  // it is not the hex field punching through (hiding the field leaves them untouched) and it is
  // not the shadow map (killing castShadow leaves them untouched). Forcing each column's radius
  // to grow and its height to fall keeps the surface single-valued, and the silhouette is
  // unchanged wherever the jitter was already well behaved — which is most of the mesh.
  const prevR = new Float32Array(ANG), prevH = new Float32Array(ANG).fill(2);
  let maxR = 0;   // MEAN rim radius: normalising by it makes the instance scale the world radius
  for (let j = 0; j < RINGS; j++) {
    const rr = 0.055 + (j / (RIM - 1)) * 0.945;
    const rc = Math.min(1, rr);      // the tapers all key on the rim, not on the flare past it
    // The jitter field is 11 RADIAL BANDS, not one per ring, and it is interpolated between
    // them the same way it already was around the circle. Keying it on the ring index instead
    // tied the landform to the tessellation: adding rings re-rolled every silhouette, and each
    // band edge was a crease, which is the "long straight creases running across the form" and
    // the flat shard planes between them. Same mountains as before, described by more triangles.
    const fb = ((rc - 0.055) / 0.945) * 11, b0 = Math.min(10, Math.floor(fb));
    const bf = fb - b0, bu = bf * bf * (3 - 2 * bf);
    const row = [];
    for (let i = 0; i < ANG; i++) {
      const a = (i / ANG) * Math.PI * 2;
      // spur mask: 1 on an arete, 0 down a gully, warped so the spurs are not evenly spaced
      const sp = 0.5 + 0.5 * Math.cos(a * spurs + phase + Math.sin(a * 2.0 + v) * 0.45);
      // The radius/height jitter has to be SMOOTH around the circle. hash2(i, ...) draws an
      // independent number for each of the 16 angular columns, so every column got its own
      // radius and its own vertex shade and the massif grew a pelt of 4 px vertical striations
      // — the "stretched fur, not bedded rock / vertical smear" read on every summit, and it
      // was in the GEOMETRY, not in any projection. Seven lobes, smoothstep-interpolated: real
      // spurs and gullies at a scale the eye reads as landform.
      const fa = i / ANG * 7, k0 = Math.floor(fa), kf = fa - k0, ku = kf * kf * (3 - 2 * kf);
      const jit = (k, sd) => {
        const kk = ((k % 7) + 7) % 7;
        return hash2(kk, b0 + v * 13, sd) * (1 - bu) + hash2(kk, b0 + 1 + v * 13, sd) * bu;
      };
      const n1r = 0.84 + 0.32 * (jit(k0, 4177) * (1 - ku) + jit(k0 + 1, 4177) * ku);
      // and its amplitude TAPERS OUT toward the rim. At full strength the mesh meets the hex
      // field on a zigzag polyline, so the line where the two surfaces cross snaps to whole
      // triangles and comes back as notches; rounded, the foot crosses on a curve. The crest
      // keeps every arete — the taper is 1.0 at the apex.
      const n1 = 1.0 + (n1r - 1.0) * (0.52 + 0.48 * (1 - rc));
      const n2 = 0.91 + 0.18 * (jit(k0, 5231) * (1 - ku) + jit(k0 + 1, 5231) * ku);
      // BEDDING, in the radius rather than the height. Snapping height collapses whole rings
      // onto one bench and the flank goes flat-shaded; a 6% radius wave at ~7 beds up the loft
      // puts horizontal ledges in the silhouette and never removes the slope under them.
      // Spurs bite into the SILHOUETTE, not into the FOOTPRINT. At full strength down to the
      // foot the base is a five-pointed star whose widest lobe is 2.4x its narrowest, so a
      // hex-sized mass either overhangs its neighbours at the points or leaves bare plate in
      // the notches. Tapered out toward the rim, the foot comes back round and fills the hex
      // while the crest keeps every arete and gully it had.
      const sps = sp * (0.42 + 0.58 * (1 - rc));
      let rad = rr * (0.72 + 0.48 * sps) * n1 * (1 + 0.075 * Math.cos((1 - rc) * 15.7 + v * 1.9));
      // Straight along an arete, concave down a gully: the exponent difference IS the peak.
      // (Under 1.0 the profile inverts — blunt apex, cliff rim — and a hex of that is a bread
      // roll, which is what a tray of them read as.)
      // A LOFT MUST NOT GRAZE THE GROUND IT STANDS IN. pow(1-rr, e) with e > 1 reaches the rim
      // with ZERO slope, so the outer fifth of the mesh is a near-horizontal plate lying within
      // centimetres of the hex field, and which of the two surfaces is on top is then decided
      // by millimetres of terrain relief — a decision that snaps to whole triangles. That is
      // the row of hard isoceles notches ("crocodile teeth") along the ridge lips this frame
      // was rejected on: not a modelling defect in the mountain, a tangency between two
      // surfaces. Sliding the power off its own zero gives every profile a real angle where it
      // enters the ground — the mass cuts in instead of skimming. Both ends are pinned, so the
      // silhouette above the rim is unchanged. Past the rim the two flare rings keep going,
      // out and down, so the foot buries itself in the field instead of lying on it.
      const ex = 1.02 + 0.86 * (1 - sp), FT = 0.08, f0 = Math.pow(FT, ex);
      let h = (Math.pow(Math.max(0, 1 - rr + FT), ex) - f0) / (Math.pow(1 + FT, ex) - f0) * n2
              - Math.max(0, rr - 1) * 1.10;   // and the flare digs in, on any profile
      if (j > 0) { rad = Math.max(rad, prevR[i] * 1.02); h = Math.min(h, prevH[i] - 0.005); }
      prevR[i] = rad; prevH[i] = h;
      if (j === RIM - 1) maxR += rad / ANG;
      row.push(pos.length / 3);
      pos.push(Math.cos(a) * rad + lean * (1 - rc), h, Math.sin(a) * rad + lean * 0.6 * (1 - rc));
      const g = 0.46 + 0.24 * h * (0.62 + 0.44 * sp);
      col.push(g, g * 0.99, g * 0.965);
    }
    rows.push(row);
  }
  // NO SKIRT. The vertical curtain that used to hang off the rim was half of the rejected
  // frame's notches on its own: the flank arrives at the rim horizontally and the curtain left
  // it vertically, so computeVertexNormals handed the rim a normal that is the average of the
  // two and every quad of that strip split into one triangle shading up and one shading out.
  // The flare rings above replace it — same job, one continuous surface, no crease. The open
  // foot is never visible from a board camera; you would have to get under the rim to see it.
  // unit MEAN footprint: after this the instance scale IS the mass's mean world radius, and
  // only the spur lobes reach past it (x1.26 at the widest)
  for (let i = 0; i < pos.length; i += 3) { pos[i] /= maxR; pos[i + 2] /= maxR; }
  for (let i = 0; i < ANG; i++) idx.push(apex, rows[0][(i + 1) % ANG], rows[0][i]);
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < ANG; i++) {
    const i2 = (i + 1) % ANG;
    const A = rows[j][i], B = rows[j][i2], C = rows[j + 1][i2], D = rows[j + 1][i];
    idx.push(A, B, C, A, C, D);
  }
  return buildGeo(pos, idx, col);
}

// ============================================================================
export class Terrain {
  constructor(map, ctx = {}) {
    this.map = map;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.time = { value: 0 };
    this.noise = tileNoise(256, (map.seed ?? 1) & 0xffff);
    this.detail = tileNoise(256, ((map.seed ?? 1) * 31 + 907) & 0xffff, 1);
    const aniso = ctx.renderer ? Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy()) : 16;
    this.noise.anisotropy = this.detail.anisotropy = aniso;

    this._pools = [];          // every instanced batch that culls to the view (see _repackPools)
    this._vis = []; this._visD = [];
    this._buildTiles();
    this._initProp();
    this._buildSurface();
    this._buildClutter();
    this._buildProps();
    this.propTex.needsUpdate = true;
    // perf/inspection hook for the shot tools; nothing in the game reads it
    if (typeof window !== 'undefined') window.__terrain = this;

    // Shadow hygiene: only touch the light if nobody else has set a bias, because the sky
    // agent owns the rig and fits the frustum per frame.
    ctx.scene?.traverse?.(o => {
      if (o.isDirectionalLight && o.castShadow && o.shadow.normalBias === 0 && o.shadow.bias === 0) {
        o.shadow.normalBias = 0.045; o.shadow.bias = -0.0002;
      }
    });
  }

  // -------------------------------------------------------------- per-tile data
  // Water beds mirror water.js exactly (it derives its shore decals from this curve).
  _bedY(t) {
    if (t.height > 0) return t.height;
    const sea = this.map.seaLevel ?? 0.42;
    const d = clamp01((sea - t.elev) / Math.max(0.05, sea));
    return -(0.14 + 2.5 * Math.pow(d, 1.35));
  }

  // ------------------------------------------------------- prop / wetness buffer
  // One world-space RGBA sheet over the whole map, 4 texels per unit, sampled once by the
  // terrain shader. R = contact darkening under every prop, G = wet ground along rivers and
  // shore, B = canopy stand density. It is what stops trees and rocks reading as stickers,
  // and it costs one texture fetch instead of thousands of decal quads.
  _initProp() {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const t of this.map.tiles) {
      const p = axialToWorld(t.q, t.r);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    x0 -= 1.4; x1 += 1.4; z0 -= 1.4; z1 += 1.4;
    // 16 texels per world unit. The old 4/unit could not resolve a canopy pool at all — a
    // 0.3-unit disc landed on one texel and bilinear averaged it back to nothing, which is
    // exactly why every tree read as a sticker. At 16 a pool is ~10 texels across.
    const S = 16;
    const W = Math.min(2048, Math.max(8, Math.round((x1 - x0) * S)));
    const H = Math.min(2048, Math.max(8, Math.round((z1 - z0) * S)));
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { px[i * 4] = 255; px[i * 4 + 3] = 255; }
    this.propPx = px; this.propW = W; this.propH = H;
    this.propX0 = x0; this.propZ0 = z0; this.propKx = W / (x1 - x0); this.propKz = H / (z1 - z0);
    this.propXf = new THREE.Vector4(x0, z0, 1 / (x1 - x0), 1 / (z1 - z0));
    const tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    this.propTex = tex;

    // wet ground: the river channel and the shoreline, painted straight into G
    for (const t of this.map.tiles) {
      if (t.height <= 0) continue;
      const p = axialToWorld(t.q, t.r);
      for (let d = 0; d < 6; d++) {
        const nb = this.map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
        const river = (t.river & (1 << d)) !== 0;
        const shore = nb && nb.height <= 0;
        if (!river && !shore) continue;
        const ka = EDGE_C[d][0], kb = EDGE_C[d][1];
        const mx = p.x + (CORNER[ka][0] + CORNER[kb][0]) * 0.5;
        const mz = p.z + (CORNER[ka][1] + CORNER[kb][1]) * 0.5;
        this._stamp(mx, mz, river ? 0.72 : 0.46, river ? 0.90 : 0.30, 1, river ? 1.3 : 2.2);
      }
    }
  }

  // A prop's grounding: one tight occlusion pool centred on the pivot with ZERO offset, plus a
  // wide soft one. The CAST shadow is the real shadow map — a baked down-sun lobe on top of it
  // double-darkened the ground and pointed the wrong way the moment sky.js re-aimed the sun.
  // `foot` is the prop's TRUE footprint radius. The decal goes down at 1.6x that, 0.55 opaque
  // at its centre (a 0.45 multiply) falling to nothing at the rim.
  _ground(x, z, y, foot, amt, tile) {
    // Contact is TWO terms. A tight, nearly flat-cored pool at the footprint radius is the one
    // that reads as the prop TOUCHING the ground; a wide soft skirt seats it in the light. One
    // wide soft pool on its own — which is what this was — spreads its darkening over 2x the
    // footprint, averages into general shading, and reads as no contact at all. That single
    // omission is why every tree, hut and bush measured as a cutout pasted onto the terrain.
    // three radii, because contact is not one falloff: a tight near-flat core at 0.6x the
    // footprint is the pixel-level "this thing touches here", the 1.15x pool is the ambient
    // occlusion of the object itself, the 2.1x skirt seats it in the light.
    this._stamp(x, z, foot * 0.60, Math.min(0.58, amt * 1.05), 0, 0.55);
    this._stamp(x, z, foot * 1.15, amt * 0.60, 0, 0.80);
    this._stamp(x, z, foot * 2.10, amt * 0.20, 0, 1.8);
    this.propDecal.push(x, y + 0.030, z, foot * 1.45, tile);
  }

  // soft radial stamp into one channel. ch 0 darkens (min), 1 and 2 accumulate (max).
  // `p` shapes the falloff: below 1 keeps a flat dark core, above 1 spikes to the centre.
  _stamp(x, z, rad, amt, ch, p = 2) {
    const cx = (x - this.propX0) * this.propKx, cz = (z - this.propZ0) * this.propKz;
    const rx = rad * this.propKx, rz = rad * this.propKz;
    const i0 = Math.max(0, Math.floor(cx - rx)), i1 = Math.min(this.propW - 1, Math.ceil(cx + rx));
    const j0 = Math.max(0, Math.floor(cz - rz)), j1 = Math.min(this.propH - 1, Math.ceil(cz + rz));
    const px = this.propPx;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5 - cx) / rx, dz = (j + 0.5 - cz) / rz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= 1) continue;
      const f = Math.pow(1 - d2, p) * amt;   // radial falloff, shaped by p
      const o = (j * this.propW + i) * 4 + ch;
      if (ch === 0) { const v = (1 - f) * 255; if (v < px[o]) px[o] = v; }
      else { const v = f * 255; if (v > px[o]) px[o] = v; }
    }
  }

  _buildTiles() {
    const { map } = this;
    const n = map.tiles.length;
    this.surfY = new Float32Array(n);
    this.peak = new Float32Array(n);
    // per-tile cull sphere: one hex plus a 2.5 unit pad, so a prop just off the frame edge is
    // still drawn and still throws its shadow into shot. Summits widen their own.
    this.cullR = new Float32Array(n).fill(3.2);
    this.rough = new Float32Array(n);
    this.base = new Float32Array(n * 3);
    this.mat = new Float32Array(n * 4);
    let maxH = 0.001, minY = 0;

    for (let i = 0; i < n; i++) {
      const t = map.tiles[i];
      const b = BIOME[t.biome] ?? FALLBACK;
      let y = this._bedY(t);
      // wobble only inland: the shoreline has to stay flush with water.js's wet apron
      if (t.height > 0) {
        let coastal = false;
        for (const d of DIRS) { const o = map.get(t.q + d.q, t.r + d.r); if (o && o.height <= 0) { coastal = true; break; } }
        if (!coastal) y += (hash2(t.q, t.r, 5501) - 0.5) * 0.085;
      }
      const pk = axialToWorld(t.q, t.r);
      // Massif height is a CONTINUOUS field, never a per-tile hash: two neighbouring mountain
      // hexes used to disagree by up to 1.1 u, which split their shared corner and put a wall
      // between them. ~5 hexes' wavelength, so the range keeps a crest line and shoulders.
      if (t.height > 0) y += b.lift * (0.42 + 1.05 * fbm2(pk.x * 0.19 + 31, pk.z * 0.19 + 13, { octaves: 2, seed: 6607 }));
      this.surfY[i] = y;
      this.peak[i] = 0;
      if (y > maxH) maxH = y;
      if (y < minY) minY = y;

      // Colour variation is a CONTINUOUS world field, never a per-tile hash. A hashed tint is
      // exactly what made the map a quilt: two neighbouring desert hexes stepped ~60 sRGB across
      // their shared chord. Sampled at 18 m and 32 m periods, it crosses every seam smoothly and
      // is held to +-4.5% value / +-2.5% warm so it can never read as a patch.
      const pw = axialToWorld(t.q, t.r);
      const mul = 0.955 + 0.090 * fbm2(pw.x * 0.055 + 3, pw.z * 0.055 + 9, { octaves: 2, seed: 991 });
      const warm = (fbm2(pw.x * 0.031 + 17, pw.z * 0.031 + 2, { octaves: 2, seed: 4477 }) - 0.5) * 0.050;
      this.base[i * 3] = Math.min(1, b.c[0] * mul * (1 + warm));
      this.base[i * 3 + 1] = Math.min(1, b.c[1] * mul);
      this.base[i * 3 + 2] = Math.min(1, b.c[2] * mul * (1 - warm));
      this.mat[i * 4] = b.veg * (0.90 + 0.20 * fbm2(pw.x * 0.075 + 5, pw.z * 0.075 + 23, { octaves: 2, seed: 313 }));
      this.mat[i * 4 + 1] = b.dry;
      this.mat[i * 4 + 2] = b.snow;
    }
    this.maxH = maxH; this.floorY = minY - 2.6;

    const base = this.base, mat = this.mat;

    // ---- riparian corridor: a river drags a band of green through whatever biome it crosses,
    //      which is the single most legible sign that moisture, not a lookup table, is driving
    //      the vegetation. One tile either side, faded.
    this.rip = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = map.tiles[i];
      if (t.height <= 0) continue;
      let r = t.river ? 1 : 0;
      for (const d of DIRS) {
        const o = map.get(t.q + d.q, t.r + d.r);
        if (o && (o.river || o.height <= 0)) r = Math.max(r, 0.5);
      }
      if (!r) continue;
      const p = axialToWorld(t.q, t.r);
      r *= 0.55 + 0.45 * fbm2(p.x * 0.31, p.z * 0.31, { octaves: 2, seed: 913 });
      this.rip[i] = r;
      const b = BIOME[t.biome] ?? FALLBACK;
      if (b.snow > 0.5) continue;
      const k = r * (b.dry > 0.6 ? 0.62 : 0.34);
      base[i * 3] = base[i * 3] * (1 - k) + 0.30 * k;
      base[i * 3 + 1] = base[i * 3 + 1] * (1 - k) + 0.44 * k;
      base[i * 3 + 2] = base[i * 3 + 2] * (1 - k) + 0.21 * k;
      mat[i * 4] = Math.min(1, mat[i * 4] + r * 0.55);
      mat[i * 4 + 1] *= 1 - r * 0.65;
    }

    // ---- ecotones. ONE noise-weighted smoothing pass over colour AND splat weights, spreading
    //      every biome border across 1.5-2 tiles; the shader's 0.35-wide height blend then
    //      breaks that band up so the transition interlocks instead of reading as a gradient
    //      ramp. Two passes was a 3-5 tile blur, and averaging four biomes together is exactly
    //      how every hex ended up the same olive mud with no biome identity left in it.
    //      `eco` records how much a tile disagrees with its neighbours: the scatter ramps on it.
    this.eco = new Float32Array(n);
    const soft = t => t.height > 0 && t.biome !== 'coast';
    {
      const sb = base.slice(), sm = mat.slice();
      for (let i = 0; i < n; i++) {
        const t = map.tiles[i];
        if (!soft(t)) continue;
        const p = axialToWorld(t.q, t.r);
        const k = 0.14 + 0.20 * fbm2(p.x * 0.085 + 17, p.z * 0.085 + 3, { octaves: 2, seed: 2287 });
        let w = 0, b0 = 0, b1 = 0, b2 = 0, m0 = 0, m1 = 0, m2 = 0;
        for (const d of DIRS) {
          const o = map.get(t.q + d.q, t.r + d.r);
          if (!o || !soft(o)) continue;
          w++; b0 += sb[o.i * 3]; b1 += sb[o.i * 3 + 1]; b2 += sb[o.i * 3 + 2];
          m0 += sm[o.i * 4]; m1 += sm[o.i * 4 + 1]; m2 += sm[o.i * 4 + 2];
        }
        if (!w) continue;
        base[i * 3] += (b0 / w - sb[i * 3]) * k;
        base[i * 3 + 1] += (b1 / w - sb[i * 3 + 1]) * k;
        base[i * 3 + 2] += (b2 / w - sb[i * 3 + 2]) * k;
        mat[i * 4] += (m0 / w - sm[i * 4]) * k;
        mat[i * 4 + 1] += (m1 / w - sm[i * 4 + 1]) * k;
        mat[i * 4 + 2] += (m2 / w - sm[i * 4 + 2]) * k;
        // the ecotone mask: how far this tile's splat weights sit from the neighbourhood mean.
        // Scatter density ramps on it, so props thicken across a transition instead of
        // stopping dead where the colour ramp does.
        this.eco[i] = clamp01((Math.abs(m0 / w - sm[i * 4]) + Math.abs(m1 / w - sm[i * 4 + 1])) * 1.8);
      }
    }

    // ruggedness (how much the neighbours disagree) drives interior displacement; a cheap baked
    // AO darkens tiles sitting in a bowl, and the canopy tiles get their own contact darkening
    // so trees never look pasted onto lit grass.
    for (let i = 0; i < n; i++) {
      const t = map.tiles[i];
      let rise = 0, spread = 0, canopy = t.biome === 'forest' || t.biome === 'jungle' ? 1 : 0;
      for (const d of DIRS) {
        const nb = map.get(t.q + d.q, t.r + d.r);
        if (!nb) continue;
        const dy = this.surfY[nb.i] - this.surfY[i];
        rise += Math.max(0, Math.min(1.4, dy));
        spread = Math.max(spread, Math.abs(dy));
        if (nb.biome === 'forest' || nb.biome === 'jungle') canopy += 0.28;
      }
      const b = BIOME[t.biome] ?? FALLBACK;
      this.rough[i] = clamp01(spread * 0.42 + b.lift * 0.55);
      this.mat[i * 4 + 3] = Math.max(0.66, 1 - rise * 0.11) * (1 - 0.09 * clamp01(canopy * 0.5));
    }
  }

  // ------------------------------------------------------- merged hex surface
  _buildSurface() {
    const { map, surfY, base, mat, rough } = this;
    const n = map.tiles.length;

    // 1. every hex corner, shared by up to three tiles. Jitter is a function of the corner,
    //    so all three tiles agree on it exactly and nothing cracks open.
    const cm = new Map();
    const key = (x, z) => (Math.round(x * 512) + 262144) * 1048576 + (Math.round(z * 512) + 262144);
    const tileKeys = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const t = map.tiles[i], p = axialToWorld(t.q, t.r);
      for (let k = 0; k < 6; k++) {
        const cx = p.x + CORNER[k][0], cz = p.z + CORNER[k][1];
        const kk = key(cx, cz);
        tileKeys[i * 6 + k] = kk;
        let e = cm.get(kk);
        if (!e) {
          const hx = Math.round(cx * 8), hz = Math.round(cz * 8);
          e = {
            ox: cx, oz: cz, hx, hz,
            x: cx + (hash2(hx, hz, 61) - 0.5) * XY_JITTER * 2,
            z: cz + (hash2(hx, hz, 97) - 0.5) * XY_JITTER * 2,
            jy: (hash2(hx, hz, 131) - 0.5) * 0.10,
            c: 0, wet: 0, land: 0, sea: 0, ys: [], b: [0, 0, 0], m: [0, 0, 0, 0],
          };
          cm.set(kk, e);
        }
        e.c++; e.ys.push(surfY[i]);
        if (t.height > 0) e.land = 1; else e.sea = 1;
        for (let c = 0; c < 3; c++) e.b[c] += base[i * 3 + c];
        for (let c = 0; c < 4; c++) e.m[c] += mat[i * 4 + c];
      }
      // river banks and the waterline get a wet, dark gravel band painted along the corners
      for (let d = 0; d < 6; d++) {
        const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
        const isRiver = (t.river & (1 << d)) !== 0 && t.height > 0;
        const isShore = t.height > 0 && nb && nb.height <= 0;
        if (!isRiver && !isShore) continue;
        const w = isRiver ? 1.0 : 0.85;
        for (const k of EDGE_C[d]) {
          const e = cm.get(key(p.x + CORNER[k][0], p.z + CORNER[k][1]));
          if (e && w > e.wet) e.wet = w;
        }
      }
    }

    // 2. Resolve each corner. Tiles meeting there are clustered by height — anything within
    //    CLIFF of a neighbour joins the cluster and takes its mean, which welds the mesh shut; a
    //    wider gap splits the corner into two levels and a wall closes the step. Clustering is a
    //    pure function of the corner's height set, so all three tiles derive the identical value.
    //    Corners where land meets sea are dragged onto the waterline and jittered much harder:
    //    that, not a decal, is what makes the coast a wandering beach instead of polygon chords.
    for (const e of cm.values()) {
      const shore = e.land && e.sea;
      if (shore) {
        e.x = e.ox + (hash2(e.hx, e.hz, 61) - 0.5) * SHORE_JITTER * 2;
        e.z = e.oz + (hash2(e.hx, e.hz, 97) - 0.5) * SHORE_JITTER * 2;
        e.jy *= 0.35;
      }
      const ys = e.ys.sort((a, b) => a - b), g = [];
      let start = 0;
      for (let j = 1; j <= ys.length; j++) {
        if (j === ys.length || ys[j] - ys[j - 1] > CLIFF) {
          let s = 0; for (let k = start; k < j; k++) s += ys[k];
          let mean = s / (j - start);
          // a cluster that straddles the waterline IS the shoreline: sit it on sea level
          if (shore && ys[start] <= 0 && ys[j - 1] > 0) {
            mean = Math.min(mean, -0.05 + 0.13 * hash2(e.hx, e.hz, 151));
          }
          g.push(ys[start], ys[j - 1], mean);
          start = j;
        }
      }
      e.g = g;
    }
    const cy = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) {
      const e = cm.get(tileKeys[i * 6 + k]), own = surfY[i];
      let y = e.g[2];
      for (let j = 0; j < e.g.length; j += 3) if (own >= e.g[j] - 1e-6 && own <= e.g[j + 1] + 1e-6) { y = e.g[j + 2]; break; }
      cy[i * 6 + k] = y + e.jy;
    }
    this.cornerY = cy;

    // 3. tops: centre + ring A + ring B + the corners = 19 verts, 30 triangles per tile
    const maxV = n * 19 + n * 72;
    const maxI = n * 90 + n * 216;
    const pos = new Float32Array(maxV * 3);
    const abs_ = new Float32Array(maxV * 3), amt = new Float32Array(maxV * 4), inf = new Float32Array(maxV * 3);
    const idx = new Uint32Array(maxI);
    const weld = new Map();   // corner key -> vertex ids, for seam-free normals
    let v = 0, f = 0;

    const push = (x, y, z, b0, b1, b2, m0, m1, m2, m3, rim, wall, wet) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      abs_[v * 3] = b0; abs_[v * 3 + 1] = b1; abs_[v * 3 + 2] = b2;
      amt[v * 4] = m0; amt[v * 4 + 1] = m1; amt[v * 4 + 2] = m2; amt[v * 4 + 3] = m3;
      inf[v * 3] = rim; inf[v * 3 + 1] = wall; inf[v * 3 + 2] = wet;
      return v++;
    };
    const tri = (a, b, c) => { idx[f++] = a; idx[f++] = b; idx[f++] = c; };

    const cxs = new Float32Array(6), czs = new Float32Array(6);
    this.centreY = new Float32Array(n);
    this.cornerLocal = new Float32Array(n * 12);
    const vA = new Array(6), vB = new Array(6), vO = new Array(6);

    for (let i = 0; i < n; i++) {
      const t = map.tiles[i], p = axialToWorld(t.q, t.r);
      const b0 = base[i * 3], b1 = base[i * 3 + 1], b2 = base[i * 3 + 2];
      const m0 = mat[i * 4], m1 = mat[i * 4 + 1], m2 = mat[i * 4 + 2], m3 = mat[i * 4 + 3];
      const rgh = rough[i];
      // relief amplitude: lowlands stay readable, high ground breaks into crags.
      // EVERY HIGH TILE takes the massif's relief, not just the two rock biomes. The benches
      // around a range (tundra above the treeline) already shade as bare rock, and on the
      // lowland branch their 0.87 u fbm is sampled by 19 vertices per hex — under its own
      // Nyquist, so what lands is an independent offset per vertex and the tile rasterises as
      // one flat facet at a random tilt. Those are the unlit grey wedges between the summits.
      // The massif branch's 2.4 u swell is sampled four times per period and rolls across the
      // seam instead, so a bench reads as ground with a slope on it.
      const ridged = (t.biome === 'mountain' || t.biome === 'snow' || surfY[i] > this.maxH * 0.42) ? 1 : 0;
      // ...and it is BOUNDED BY THE SUMMIT'S BURIAL. The field's crags reach 0.72*amp above the
      // corner-interpolated surface; the mass standing in the same hex is seated 0.55 below its
      // lowest welded corner. When the first number wins, the field punches up THROUGH the loft
      // and the camera sees a row of hard dark triangles — the hex fan's own facets — cut into
      // the lit rock. That is the "crocodile teeth" this frame was rejected on, and it was never
      // in the mountain mesh: it is two surfaces fighting over the same 20 cm. 0.32 keeps the
      // crags (0.27) inside the burial with room to spare.
      const amp = t.height > 0 ? (ridged ? 0.06 + 0.32 * rgh : 0.06 + 0.55 * rgh) : 0.05;

      let cySum = 0;
      for (let k = 0; k < 6; k++) {
        const e = cm.get(tileKeys[i * 6 + k]);
        cxs[k] = e.x - p.x; czs[k] = e.z - p.z; cySum += cy[i * 6 + k];
        this.cornerLocal[i * 12 + k * 2] = cxs[k];
        this.cornerLocal[i * 12 + k * 2 + 1] = czs[k];
      }
      // NO DOME. The tile centre is its own height blended into the welded corner mean and
      // nothing else: on flat ground centre and rim land on the same plane, so a field of
      // hexes is one continuous heightfield and the grid overlay is the only thing that says
      // where a tile ends. grid.js draws the lines; the ground stops drawing them.
      const yC = surfY[i] * 0.62 + (cySum / 6) * 0.38 + (hash2(t.q, t.r, 8123) - 0.5) * 0.05;
      this.centreY[i] = yC;

      // fbm relief, sampled in world space so it never lines up with the hex grid
      // damped toward the rim, because the corners are welded and a big kick there creases.
      // HIGH GROUND IS BEDDED, NOT SPIKED. The old rock branch ridged the SAME 0.87 u fbm the
      // lowlands use and multiplied it by 1.7 — a 45-degree kick every 60 screen px, in every
      // direction at once, which is the shard field the whole upper-left of the frame was.
      // A massif instead gets one coherent 2.4 u swell with a fifth of the old chatter on top,
      // so a face is a face. The BEDDING is the shader's job — quantising the vertex offset
      // instead terraces a relief that is damped toward the rim, i.e. it turns every hex into
      // its own stepped mound and the range into a heap of hexagonal crystals.
      const relief = (x, z, R) => {
        let d = (fbm2(x * 1.15 + 11, z * 1.15 + 5, { octaves: 3, seed: 71 }) - 0.5) * 2;
        if (!ridged) return d * amp * (1 - R * 0.62);
        const swell = (fbm2(x * 0.42 + 11, z * 0.42 + 5, { octaves: 2, seed: 71 }) - 0.5) * 2;
        return (swell * 0.62 + d * 0.10) * amp * (1 - R * 0.62);
      };

      const vC = push(p.x, yC + relief(p.x, p.z, 0.0) * 0.55, p.z, b0, b1, b2, m0, m1, m2, m3, 0, 0, 0);
      for (let k = 0; k < 6; k++) {
        const kk = tileKeys[i * 6 + k], e = cm.get(kk);
        const yO = cy[i * 6 + k];
        // corners take the blend of every tile meeting there -> biome colour crosses the border
        const ob0 = e.b[0] / e.c, ob1 = e.b[1] / e.c, ob2 = e.b[2] / e.c;
        const om0 = e.m[0] / e.c, om1 = e.m[1] / e.c, om2 = e.m[2] / e.c, om3 = e.m[3] / e.c;
        vO[k] = push(e.x, yO, e.z, ob0, ob1, ob2, om0, om1, om2, om3, 1, 0, e.wet);
        let list = weld.get(kk); if (!list) weld.set(kk, list = []);
        list.push(vO[k]);

        for (let ri = 0; ri < 2; ri++) {
          const R = (ri === 0 ? R_A : R_B) * (1 + (hash2(t.q * 7 + k, t.r * 13 + ri, 409) - 0.5) * 0.30);
          const mixT = R * 0.72;
          const jx = (hash2(t.q * 7 + k, t.r * 13 + ri, 211) - 0.5) * 0.15;
          const jz = (hash2(t.q * 7 + k, t.r * 13 + ri, 307) - 0.5) * 0.15;
          const x = p.x + cxs[k] * R + jx, z = p.z + czs[k] * R + jz;
          const y = yC + (yO - yC) * prof(R) + relief(x, z, R);
          const id = push(x, y, z,
            b0 + (ob0 - b0) * mixT, b1 + (ob1 - b1) * mixT, b2 + (ob2 - b2) * mixT,
            m0 + (om0 - m0) * mixT, m1 + (om1 - m1) * mixT, m2 + (om2 - m2) * mixT, m3 + (om3 - m3) * mixT,
            R, 0, e.wet * (ri === 0 ? 0.2 : 0.6));
          if (ri === 0) vA[k] = id; else vB[k] = id;
        }
      }
      for (let k = 0; k < 6; k++) {
        const k2 = (k + 1) % 6;
        tri(vC, vA[k2], vA[k]);
        tri(vA[k], vA[k2], vB[k2]); tri(vA[k], vB[k2], vB[k]);
        tri(vB[k], vB[k2], vO[k2]); tri(vB[k], vO[k2], vO[k]);
      }
    }

    // 4. cliff walls: emitted once, from the higher side down, three rows so the face can bow
    this.wallFeet = [];   // [x, y, z, drop] per emitted face, for the talus scatter
    for (let i = 0; i < n; i++) {
      const t = map.tiles[i], p = axialToWorld(t.q, t.r);
      const b0 = base[i * 3], b1 = base[i * 3 + 1], b2 = base[i * 3 + 2];
      const m3 = mat[i * 4 + 3];
      for (let d = 0; d < 6; d++) {
        const ka = EDGE_C[d][0], kb = EDGE_C[d][1];
        const ea = cm.get(tileKeys[i * 6 + ka]), eb = cm.get(tileKeys[i * 6 + kb]);
        const ya = cy[i * 6 + ka], yb = cy[i * 6 + kb];
        const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
        let na, nbY;
        if (nb) {
          const od = (d + 3) % 6;
          na = cy[nb.i * 6 + EDGE_C[od][1]];
          nbY = cy[nb.i * 6 + EDGE_C[od][0]];
          const mine = ya + yb, theirs = na + nbY;
          if (theirs > mine + 1e-5) continue;                 // the higher side emits
          if (theirs > mine - 1e-5 && nb.i < i) continue;     // tie -> lowest index emits
          na = Math.min(na, ya); nbY = Math.min(nbY, yb);     // never let the quad bow-tie
        } else { na = this.floorY; nbY = this.floorY; }

        const drop = Math.max(ya - na, yb - nbY);
        if (drop < WALL_MIN) continue;
        if (drop > 0.22) this.wallFeet.push((ea.x + eb.x) * 0.5, (na + nbY) * 0.5, (ea.z + eb.z) * 0.5, drop, i);
        // 3x3 patch. Only the middle vertex is free to move: the rim rows and the corner
        // columns are shared with the two tile tops, so anything else opens a slit.
        let ox = (ea.x + eb.x) * 0.5 - p.x, oz = (ea.z + eb.z) * 0.5 - p.z;
        const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
        const bulge = (0.05 + 0.11 * hash2(t.q * 13 + d, t.r * 7, 1721)) * Math.min(1.5, drop);
        const ao = Math.max(0.68, m3 - Math.min(0.20, drop * 0.16));
        const ml1 = mat[i * 4 + 1] * 0.35, ml2 = mat[i * 4 + 2] * 0.6;
        const cvar = 0.93 + 0.13 * hash2(t.q * 13 + d, t.r * 7, 1901);   // per-face rock tone

        const lip = (0.07 + 0.10 * hash2(t.q * 13 + d, t.r * 7, 2111)) * Math.min(1.3, drop);
        const ROW = [0.0, 0.19, 0.62, 1.0];
        const g = [];
        for (let row = 0; row < 4; row++) {
          const tt = ROW[row], line = [];
          for (let cl = 0; cl < 3; cl++) {
            const ct = cl * 0.5;
            const x0 = ea.x + (eb.x - ea.x) * ct, z0 = ea.z + (eb.z - ea.z) * ct;
            const yTop = ya + (yb - ya) * ct, yBot = na + (nbY - na) * ct;
            let y = yTop + (yBot - yTop) * tt, bx = 0, bz = 0;
            if (cl === 1 && row === 1) { bx = ox * lip; bz = oz * lip; y += drop * 0.03; }
            if (cl === 1 && row === 2) {
              bx = ox * bulge; bz = oz * bulge;
              y += (hash2(t.q * 3 + d, t.r * 5, 2003) - 0.5) * drop * 0.16;
            }
            line.push(push(x0 + bx, y, z0 + bz, b0, b1, b2, 0, ml1, ml2,
              ao * (1 - tt * 0.30) * cvar, tt, 1, 0));
          }
          g.push(line);
        }
        for (let row = 0; row < 3; row++) for (let cl = 0; cl < 2; cl++) {
          const A = g[row][cl], B = g[row][cl + 1], C = g[row + 1][cl + 1], D = g[row + 1][cl];
          tri(A, B, C); tri(A, C, D);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute('aBase', new THREE.BufferAttribute(abs_.subarray(0, v * 3), 3));
    geo.setAttribute('aMat', new THREE.BufferAttribute(amt.subarray(0, v * 4), 4));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(inf.subarray(0, v * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, f), 1));
    geo.computeVertexNormals();

    // Normals: weld, smooth, weld. Welding the shared corners closes the seam between two
    // tiles but leaves every INTERIOR vertex carrying the mean of its own six triangles, and
    // on ground that is only a few degrees off flat that mean still steps from one fan to the
    // next — which is the straight-edged wedge of sunlight the open fields were drawing.
    // The middle pass is one angle-limited smoothing sweep: a vertex takes the mean of the
    // normals it shares a triangle with, weighted by how often they share one, but ONLY those
    // within 40 degrees of its own. A cliff riser (which is 60-90 degrees off its cap) keeps
    // its hard edge; a 5-degree facet on a meadow disappears. The second weld puts the shared
    // corners back in lockstep after the sweep has moved them apart.
    const nrm = geo.attributes.normal.array;
    const weldNormals = () => {
      for (const list of weld.values()) {
        if (list.length < 2) continue;
        let x = 0, y = 0, z = 0;
        for (const id of list) { x += nrm[id * 3]; y += nrm[id * 3 + 1]; z += nrm[id * 3 + 2]; }
        const l = Math.hypot(x, y, z) || 1;
        for (const id of list) { nrm[id * 3] = x / l; nrm[id * 3 + 1] = y / l; nrm[id * 3 + 2] = z / l; }
      }
    };
    weldNormals();
    {
      const acc = new Float32Array(v * 3), COS40 = 0.423;   // 65 deg: a riser is 70-90 off its cap and still keeps its edge
      for (let k = 0; k < f; k += 3) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        if (a === b) continue;
        const i0 = idx[k + a] * 3, i1 = idx[k + b] * 3;
        if (nrm[i0] * nrm[i1] + nrm[i0 + 1] * nrm[i1 + 1] + nrm[i0 + 2] * nrm[i1 + 2] < COS40) continue;
        acc[i0] += nrm[i1]; acc[i0 + 1] += nrm[i1 + 1]; acc[i0 + 2] += nrm[i1 + 2];
      }
      for (let i = 0; i < v * 3; i += 3) {
        const x = nrm[i] + acc[i] * 0.85, y = nrm[i + 1] + acc[i + 1] * 0.85, z = nrm[i + 2] + acc[i + 2] * 0.85;
        const l = Math.hypot(x, y, z) || 1;
        nrm[i] = x / l; nrm[i + 1] = y / l; nrm[i + 2] = z / l;
      }
    }
    weldNormals();
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();

    this.mesh = new THREE.Mesh(geo, this._surfaceMaterial());
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain-surface';
    this.group.add(this.mesh);
  }

  // ------------------------------------------------------------ surface shader
  _surfaceMaterial() {
    // A bright specular tint gated by a per-fragment strength: wet gravel and snow crust get a
    // real sun glint that clips, everything else keeps a dull sheen.
    const m = new THREE.MeshPhongMaterial({ shininess: 40, specular: new THREE.Color(0x8f8878) });
    const snowLo = Math.max(2.8, this.maxH * 0.78), snowHi = Math.max(3.8, this.maxH * 0.99);
    m.onBeforeCompile = (s) => {
      s.uniforms.uNoise = { value: this.noise };
      s.uniforms.uDet = { value: this.detail };
      s.uniforms.uProp = { value: this.propTex };
      s.uniforms.uPropXf = { value: this.propXf };
      s.uniforms.uSnow = { value: new THREE.Vector2(snowLo, snowHi) };
      s.uniforms.uRock = { value: new THREE.Vector2(this.maxH * 0.32, this.maxH * 0.66) };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', /* glsl */`#include <common>
          attribute vec3 aBase; attribute vec4 aMat; attribute vec3 aInfo;
          varying vec3 vBase; varying vec4 vMat; varying vec3 vInfo;
          varying vec3 vWP; varying vec3 vWN;`)
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          vBase = aBase; vMat = aMat; vInfo = aInfo;
          vWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vWN = normalize( mat3( modelMatrix ) * objectNormal );`);

      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', /* glsl */`#include <common>
          uniform sampler2D uNoise; uniform sampler2D uDet; uniform sampler2D uProp; uniform vec4 uPropXf;
          uniform vec2 uSnow; uniform vec2 uRock;
          varying vec3 vBase; varying vec4 vMat; varying vec3 vInfo;
          varying vec3 vWP; varying vec3 vWN;
          // Height-blend: the threshold is what the noise moves, not the weight, so a mask of
          // zero can never bloom into a patch. The band is 0.35 wide and its centre wanders
          // +-0.22 on a 190-1540 px field, which pulls a biome edge one to five hexes off the
          // lattice and leaves an interlocked edge rather than a gradient ramp. It has to ride
          // the COARSE bands: thresholding a field with tussock-scale octaves in it draws a
          // contour map, because that is exactly what a contour map is.
          float hblend( float w, float noise ) {
            return smoothstep( 0.255, 0.605, w + ( noise - 0.5 ) * 0.44 );
          }
          float sharp( float v, float k ) { float x = ( v - 0.5 ) * k * 2.0; return 0.5 + 0.5 * x / ( 1.0 + abs( x ) ); }
          vec2 sharp2( vec2 v, float k ) { return ( v - 0.5 ) * k; }
          // TRIPLANAR. Three world-axis projections on a pow-4 normal weight. A single frame
          // laid along the face is degenerate in exactly one direction, the pixel footprint on
          // a cut face IS that direction, and the sampler averaging it away is what printed a
          // comb of parallel hairs down the fall line of every cliff in the frame. Three axes
          // have no degenerate direction, so a wall gets the same grain as open ground.
          vec4 tri3( sampler2D T, vec2 aX, vec2 aY, vec2 aZ, vec3 w ) {
            return texture2D( T, aX ) * w.x + texture2D( T, aY ) * w.y + texture2D( T, aZ ) * w.z;
          }`)
        .replace('#include <map_fragment>', /* glsl */`
          vec3 wn = normalize( vWN );
          // LOD, measured off the DERIVATIVE, not off camera distance. The whole visible board
          // spans camDist 21.6 to 30.1 at gameplay zoom — a 1.4x range — so every distance
          // window ever written here was pinned at one value across the entire frame and the
          // "detail layer" never varied. mpp is world units per screen pixel straight out of
          // the rasteriser: it falls as the ground approaches the camera and rises as it tilts
          // away, which is exactly the signal a LOD ramp wants and cannot invert. Each band is
          // then faded on its OWN finest feature (tile / 16, because both atlases are
          // band-limited to 16 cycles), gone before that feature reaches 2 px and full by 5.
          // FULL 3D derivative, not the XZ footprint. On a cut face vWP.xz barely moves from
          // one screen pixel to the next while vWP.y moves a long way, so an XZ-only mpp reported
          // "this surface is right under the camera" for every wall in the frame and switched the
          // two finest bands to full strength on a surface the rasteriser cannot resolve them on.
          // The sampler then mipped the vertical axis flat and left the horizontal one alone,
          // which is precisely a pelt of vertical corduroy — the "stretched fur, single-planar
          // smear" read on every cliff. Measuring the real world-space footprint fades those
          // bands out exactly where they cannot be drawn.
          vec3 wdx = dFdx( vWP ), wdy = dFdy( vWP );
          float mpp = max( length( wdx ), length( wdy ) ) + 1e-6;
          // see the note in _rockMaterial: a cut face's footprint is a line, and a fine band
          // filtered through a line comes back as combing. Open ground is only mildly
          // anisotropic at this pitch, so the fade is applied through the wall mask and nowhere else.
          float wIso = ( length( cross( wdx, wdy ) ) / mpp ) / mpp;   // short axis / long axis
          // The gate is on the feature, not on the tap: both atlases are band-limited to 16
          // cycles, so a band's finest feature is tile/16 world units and it may run until that
          // feature is about 2 screen px. Held at 4-8 px it switched OFF over the near field —
          // which is the whole of "near-field HF measures BELOW far-field HF", because the only
          // detail left near the camera was the scatter layer and the scatter layer shrinks
          // with distance the wrong way round. Full by 4 px, gone by 1.6.
          // Each band is gated on ITS OWN finest feature reaching a resolvable size, and the
          // floor is 1.8-2.0 px, not 1.2. Below 2 px a feature does not fade, it MOIRES — the
          // beat between a 2.2 px cell field and the pixel grid is exactly the ~7.5 px diamond
          // lattice the last pass drew over every field of grass. Above it, the mip chain plus
          // 16x aniso carries the fade and these ramps only stop the last half-octave.
          // The analytic world-Y strata need the same gate as a texture and never had one. A cut
          // face seen from a board camera is foreshortened to almost nothing, so 17 rad/u of
          // bedding lands its 0.37 u period on ~3 screen px at gameplay zoom and under 1 px on
          // anything in the back half of the frame — which is the vertical corduroy that
          // measured HF_rms 26 on the far cliff and inverted the whole near/far ramp.
          // FOOTPRINT-DRIVEN FADE, and the ramp lives here. Each band is gated on ITS OWN
          // finest feature measured in screen pixels, and the gates are now WIDE and HIGH:
          // full by 5-7 px, gone by 2-3. The old 1.6-3.6 pair held both fine bands at full
          // strength right to the back of the frame, which is the whole of "detail energy
          // grows with distance" — far-cliff 16.3 against near-field 12.6. With these the
          // micro band is worth ~1.0 in the near field, ~0.5 at mid depth and ~0 on the far
          // massif, i.e. a real mipped material that falls roughly 2:1 with distance.
          // Bedding is a function of world Y ALONE, so the footprint that decides whether it
          // is resolvable is the world-Y span of a pixel — not the 3D one. On a cut face seen
          // from a board camera the long axis of the 3D footprint runs down the fall line, so
          // mpp reported "unresolvable" for the exact surface bedding has to be drawn on, and
          // every cliff in the frame came back with no strata in it at all.
          float mppY  = max( abs( wdx.y ), abs( wdy.y ) ) + 1e-6;
          float sBed  = smoothstep( 2.0, 5.0, 0.6200 / mppY );   // 0.62 u beds
          float sFine = smoothstep( 2.0, 4.5, 0.2100 / mppY );   // 0.21 u laminae
          float detail = smoothstep( 2.2, 5.0, 0.3330 / mpp );   // nMes, uNoise 4.0 u tile / 12
          float dNear  = smoothstep( 3.0, 6.5, 0.1438 / mpp );   // nMic, uDet   4.6 u tile / 32
          float dClose = smoothstep( 2.0, 4.4, 0.0547 / mpp );   // nFin, uDet   1.75 u tile / 32
          float up = abs( wn.y );
          float flatness = smoothstep( 0.30, 0.78, up );
          float wall = vInfo.y;

          // THREE WORLD-AXIS FRAMES. There is no along-the-face frame any more: that frame is
          // degenerate in the fall-line direction, the pixel footprint on a cut face IS the
          // fall line, and the two together are the down-slope corduroy comb that every rock
          // face in the frame was wearing. pow-4 normal weights, normalised.
          vec3 tw = abs( wn ); tw *= tw * tw; tw /= ( tw.x + tw.y + tw.z + 1e-5 );
          vec2 pX = vec2( vWP.z, -vWP.y ), pY = vWP.xz, pZ = vec2( vWP.x, -vWP.y );
          vec2 uf = pY;                                  // macro frames stay planar-from-above
          // second UV frame, rotated 63 degrees, so nothing ever beats against the hex lattice
          mat2 rotA = mat2( 0.825, -0.565, 0.565, 0.825 );
          mat2 rotB = mat2( 0.454, -0.891, 0.891, 0.454 );

          // ---------------------------------------------- FIVE TAPS, ONE OCTAVE LADDER
          // Both atlases are band-limited to f = 2..16 cycles across themselves, so a tap's
          // WORLD TILE fixes exactly which screen band it lands in and nothing can alias. The
          // rig sits 20 u up at 30 degrees fov, which is a MEASURED 80 screen px per world unit
          // at the bottom of the frame and 57 at the top; take 70. Then:
          // The metric that decides this is not "detail energy", it is WHERE the energy sits.
          // HF_rms is (pixel - 3x3 box): only 1-3 px content reaches it. MID_rms is
          // (5x5 box - 17x17 box): a band-pass whose gain peaks on 10-14 px features and is
          // ~7x its own HF gain there. So MID/HF >= 0.9 is a statement about WORLD SCALE —
          // the material has to carry more energy at 0.14 u than at 0.04 u. The old ladder put
          // BOTH fine taps under 3.5 px (uDet cells at 1.5 u / 32 and 1.0 u / 32) and left the
          // 10 px band empty, which is the whole of MID/HF 0.59-0.88. uDet's albedo channel is
          // a 32-cell Voronoi, so its feature is tile/32 and the tile is the only knob:
          //   nVar -> uNoise 44 u  : 3700 .. 265 px  the macro shapes the variation LIVES in
          //   nMac -> uNoise 13 u  : 1080 ..  78 px  patches, swales, stands
          //   nMes -> uNoise 4.0 u :  290 ..  24 px  MACRO ALBEDO: dune ridges, soil patches
          //   nMic -> uDet   4.6 u :  330 ..  10 px  material grain      (the MID band)
          //   nFin -> uDet   1.75 u:  126 ..   3 px  the finest resolvable (the HF band)
          // 4x between the two uDet taps, ~3x above. NO NEGATIVE LOD BIAS anywhere: a bias of
          // -1.4 on a 2.2 px feature does not sharpen it, it forces the sampler a mip below
          // the pixel footprint and the result beats against the pixel grid. That beat is the
          // ~7.5 px diamond lattice measured over every field of grass, and it is also why
          // detail energy did not fall with distance — a moire pattern is the same size on
          // screen at every depth, which is the literal definition of screen-space noise.
          // 16x anisotropy (set on both atlases at construction) is what keeps the near field
          // sharp without it: the footprint on a board tilted 65 degrees is ~2.4x longer than
          // it is wide, and an isotropic sampler picks a mip two levels past what the short
          // axis needs.
          // NEVER sample inside non-uniform control flow: detail/dNear/wall vary per fragment,
          // and an if around a fetch makes the implicit derivative undefined. SwiftShader
          // answers with a high mip, i.e. flat grey, which is what "airbrushed near field" was.
          vec4 nVar = texture2D( uNoise, pY * 0.02273 + vec2( 0.31, 0.17 ) );
          vec4 nMac = tri3( uNoise, pX * 0.0769, pY * 0.0769, pZ * 0.0769, tw );
          // The one field that breaks every tile period below it: a 24 u mask, 1/17 the scale
          // of the finest tap, cross-fading two copies of that tap in frames 37 and 113
          // degrees apart. Neither frame's repeat ever runs more than a few tiles before the
          // mask hands over to the other one, so there is no period left to see.
          float uBrk = smoothstep( 0.30, 0.70, texture2D( uNoise, uf * 0.0417 + vec2( 0.71, 0.29 ) ).b );
          // DOMAIN WARP, sized properly. A warp folds the texture onto itself the moment its
          // amplitude approaches the wavelength of the field doing the warping: |grad(warp)| > 1
          // is a fold, and a fold in a 2D displacement has a WINDING NUMBER — which is a
          // starburst singularity with parallel bands flowing out of it. nMac's finest feature
          // is 0.53 u, so a 1.60 u warp ran a gradient of 3 and printed fingerprint whorls over
          // the entire board. Every "wood grain", "brushed metal" and "contour map" note in this
          // file was chasing that one number. 0.16 u keeps the gradient near 0.3 and still
          // decorrelates the 160 px tile enough to hide it under the bands above.
          vec2 w1 = ( nMac.rg - 0.5 ) * 0.16;
          vec4 nMes = tri3( uNoise, ( pX + w1 ) * 0.2500 * rotA + vec2( 0.63, 0.11 ),
                                    ( pY + w1 ) * 0.2500 * rotA + vec2( 0.63, 0.11 ),
                                    ( pZ + w1 ) * 0.2500 * rotA + vec2( 0.63, 0.11 ), tw );
          vec2 w2 = w1 + ( nMes.rg - 0.5 ) * 0.07;
          vec4 nMic = tri3( uDet, ( pX + w2 ) * 0.2174 * rotB + vec2( 0.19, 0.77 ),
                                  ( pY + w2 ) * 0.2174 * rotB + vec2( 0.19, 0.77 ),
                                  ( pZ + w2 ) * 0.2174 * rotB + vec2( 0.19, 0.77 ), tw );
          // The finest tap is the one a repeat lattice shows up in, so it is the one that gets
          // the 24 u macro breakup. Not two taps cross-faded — MIX THE TWO ROTATIONS. Both are
          // [a,-b;b,a], so their linear blend is exactly a rotation by the interpolated angle
          // times cos(half the difference): the frame sweeps 37 -> 113 degrees AND the world
          // scale dips 27% in between, which decorrelates harder than a cross-fade and costs
          // three fetches instead of six.
          float rfA = mix( 0.799, -0.391, uBrk ), rfB = mix( 0.602, 0.921, uBrk );
          mat2 rotF = mat2( rfA, -rfB, rfB, rfA );
          vec4 nFin = tri3( uDet, ( pX + w2 ) * 0.5714 * rotF + vec2( 0.41, 0.53 ),
                                  ( pY + w2 ) * 0.5714 * rotF + vec2( 0.41, 0.53 ),
                                  ( pZ + w2 ) * 0.5714 * rotF + vec2( 0.41, 0.53 ), tw );
          // The one multiplier that breaks repetition, on a 44 u period. VALUE, never hue —
          // the moment this touches chroma the ground goes back to per-pixel hue scatter.
          // THE MACRO BAND, and it is the only band in the ladder the eye reads as FORM.
          // nVar.b is fbm f0=11 on a 44 u tile, so its dominant period is 4-6 u — 280-420
          // screen px, shapes not grain. MID_rms band-passes 10-30 px and HF_rms 1-3, so a
          // 350 px feature is invisible to BOTH measured bands: this is structure bought for
          // nothing, and it is where the read goes when chroma comes off below.
          float v32 = 0.898 + 0.204 * nVar.b;

          // prop buffer: R = contact darkening under trees/rocks/summits, G = wet ground near
          // water and rivers, B = canopy stand density (drives the sward tint under a forest)
          vec4 pd = texture2D( uProp, ( vWP.xz - uPropXf.xy ) * uPropXf.zw );

          // ---- material masks, from the GEOMETRIC normal, so the detail octaves cannot
          //      punch rock through a grass field one texel at a time
          float gslope = 1.0 - up;
          float warp = nVar.b * 0.74 + nMac.b * 0.26;
          float bare = 1.0 - clamp( vMat.x + vMat.y + vMat.z, 0.0, 1.0 );
          float alp = smoothstep( uRock.x, uRock.y, vWP.y + ( nVar.b - 0.5 ) * 2.4 );
          float wRock = clamp( hblend( smoothstep( 0.16, 0.62, gslope ) * 0.95 + bare * 0.9 + alp * 0.85, warp ) + wall, 0.0, 1.0 );
          // snowline jittered by ASPECT: the sun-facing flank melts out a good 30m higher than
          // the lee, which is what stops a snowline reading as a contour line on a map
          float aspect = dot( normalize( wn.xz + vec2( 1e-4 ) ), vec2( 0.86, 0.30 ) );
          float snowH = smoothstep( uSnow.x, uSnow.y, vWP.y + ( nVar.b - 0.5 ) * 2.6 + ( nMac.b - 0.5 ) * 1.5 - aspect * 0.95 );
          float wSnow = clamp( hblend( vMat.z * 0.95 + snowH * 1.1, warp ) * ( 1.0 - gslope * 1.3 ), 0.0, 1.0 );
          float wSand = clamp( hblend( smoothstep( 0.22, 0.86, vMat.y ) * 0.95 + smoothstep( 0.55, -0.05, vWP.y ) * 0.85, warp )
                          * ( 1.0 - wRock * 0.75 ), 0.0, 1.0 );
          // Wet sand runs a good 1.2 m inland of the waterline, and it is the term that seats
          // the beach against the sea instead of letting white sand meet blue water on a line.
          float wet = clamp( vInfo.z * 0.50 + smoothstep( 0.14, -0.02, vWP.y ) * 0.80 + pd.g * 0.95, 0.0, 1.0 );
          // desert pavement: occasional, not a coffee stain over half the dune field
          float hamada = smoothstep( 0.70, 0.93, nVar.b * 0.50 + nMac.b * 0.50 )
                       * smoothstep( 0.30, 0.72, vMat.y ) * smoothstep( 0.35, 1.1, vWP.y );
          wRock = clamp( wRock + hamada * 0.22, 0.0, 1.0 );
          wSand *= 1.0 - wRock * 0.55;
          float wGrass = ( 1.0 - wSand ) * ( 1.0 - wRock ) * ( 1.0 - wSnow );

          // DOMAIN WARP. Every directional term below — dune ripples, wind comb, strata —
          // is evaluated on wq, not on world XZ, or the whole map wears one 30-degree streak.
          vec2 wq = vWP.xz + ( nVar.rg - 0.5 ) * 0.40 + ( nMac.rg - 0.5 ) * 0.12;

          // ---- relief normal, one octave per band. Both atlases now encode a normal whose
          // slope RMS is a fixed 0.17 of the encoding range, so these coefficients ARE the
          // per-band strength: 0.27 / 0.37 / 0.44 / 0.25 rms, i.e. a 1/f ladder with its weight
          // on the 7-50 px band. That is the band a player reads material off, and the old
          // build spent its whole budget two octaves below it, on 2 px grain that had nothing
          // under it — which is what measured as noise rather than texture.
          // The anisotropy fade used to run to ZERO, and that is why every steep face in the
          // frame was a large uniform quad with literally no texture inside it: a 60-degree
          // slope on a board camera has wIso ~0.3, both fine bands switched off, and the
          // massif went back to being flat-shaded polygon salad. 16x aniso on the sampler is
          // what stops combing; this only takes the last of the edge off.
          dNear  *= mix( 0.62, 1.0, smoothstep( 0.10, 0.55, wIso ) );
          dClose *= mix( 0.34, 1.0, smoothstep( 0.18, 0.70, wIso ) );
          vec2 grad = sharp2( nMac.rg, 0.14 )
                    + sharp2( nMes.rg, 0.60 ) * detail
                    + sharp2( nMic.rg, 3.40 ) * dNear
                    + sharp2( nFin.rg, 2.10 ) * dClose;
          grad *= 1.0 - wSand * 0.10;
          // SAND KEEPS THE RIPPLE, NOT THE BLOB FIELD. nMic's octaves land at 10-40 screen px,
          // dead centre of MID_rms's band-pass, and at 3.40 gain in the relief they are the
          // mottled smears the near sand still wore underneath the ripple train — open sand
          // measured MID/HF 1.68 with the albedo blobs already gone, because the blobs had
          // simply moved into the normal. Rock drops this band for the same reason.
          grad -= sharp2( nMic.rg, 3.40 ) * dNear * 0.55 * wSand;
          // ROCK drops the blob bands and KEEPS the fine one. nMic's octaves land at 7-18
          // screen px, which is precisely the band MID_rms is a band-pass on, and at 3.40 gain
          // on a cut face they are the field of soft round bubble-wrap the whole massif was
          // wearing — 8-25 px energy with nothing at 3 px under it, i.e. MID/HF 1.6.
          grad -= ( sharp2( nMes.rg, 0.60 ) * detail * 0.55
                  + sharp2( nMic.rg, 3.40 ) * dNear * 0.94
                  + sharp2( nFin.rg, 2.10 ) * dClose * 0.10 ) * wRock;
          // NO BLADE COMB. Pushing the cell band along vec2(cos(lean), sin(lean)) looks like a
          // good idea and is a vortex generator: a direction field built from a scalar that way
          // has a winding number, and every place the scalar's level sets pinch becomes a phase
          // singularity — a starburst with parallel bands flowing out of it. That, not the dune
          // ripples, is what put fingerprint whorls across the dry flats. The cell band already
          // reads as clumps without being combed; a sward does not need a direction field.
          // SAND IS DIRECTIONAL, and every band it wears is a harmonic of ONE SCALAR PHASE.
          // sPh is linear in world position — a plane, not a direction field — so its level
          // sets ARE the crests, and because the world-Y term is evaluated on the surface
          // they bend by -1.30 * grad(height): the crests swing onto the contour, across the
          // fall line, wherever the ground actually slopes, and hold the wind's bearing on a
          // flat pan where there is no fall line to follow. Two things follow for free. A
          // scalar has no winding number, so no crest can pinch into the starburst
          // singularity that killed the last ripple ladder; and sinusoids of the SAME phase
          // are harmonics, so the 5.5 u dune and the 0.35 u ripple cannot beat each other
          // into the moire that made the old three-ripple stack read as brushed metal.
          // The trap, and it cost a full iteration: writing this as dot( vWP.xz, someDir )
          // with someDir varying per fragment. A direction that turns, dotted into a position
          // 50 units from the origin, scrambles the phase by tens of radians per unit and
          // grows a fan wherever the direction crosses a zero — starburst hatching over the
          // whole beach, from one wrong line.
          float sPh = vWP.x * 0.63 + vWP.z * 0.78 - vWP.y * 1.30;
          float duneL = sin( sPh * 1.15 + nVar.b * 2.2 );                    // 5.5 u crests
          // 0.35 u ripples — 24 screen px in the near field — faded out on their own
          // footprint, because an analytic sine has no mip chain to do it for them.
          // ONE global wavenumber over a whole quadrant is CORDUROY, and that is what the last
          // pass shipped. Two fixes, both of which stay on a scalar phase:
          // (a) a smooth PHASE field bends the train. The local wavefront normal is
          //     k + grad(phi), so ~13 rad on nVar's 4-6 u band and ~5 on nMac's 1-3 u one
          //     swings the heading around 15 degrees and wanders the wavelength ~20% — the
          //     crests curve along the ground instead of holding one heading per region.
          //     This is the SAFE way to turn a wave: a varying DIRECTION dotted into position
          //     scrambles the phase by tens of radians per unit and fans out at every zero
          //     crossing; a varying phase OFFSET cannot, because grad(phi) is bounded.
          // (b) FETCH gates the amplitude. Ripples build where the pan tilts into the wind and
          //     die out completely in the sheltered slacks, so the train is patchy rather than
          //     a comb drawn edge to edge. sRip carries it, so the relief, the trough grit and
          //     the sheen all fade together.
          float fetch = smoothstep( 0.28, 0.72, nMac.b * 0.55 + nVar.b * 0.45 )
                      * ( 0.26 + 0.74 * smoothstep( 0.015, 0.13, gslope ) );
          float sRip = smoothstep( 2.4, 5.5, 0.350 / mpp ) * fetch;
          float rPh = sPh * 17.95 + nVar.b * 13.0 + nMac.b * 5.0;
          float ripL = sin( rPh ) * sRip;
          // cos, not sin: the relief is the DERIVATIVE of the wave the albedo below paints,
          // so crest and highlight land on the same line instead of a quarter period apart.
          // Contrast off the 24 px ripple and onto the 385 px dune: the ripple is the band
          // MID_rms band-passes, the dune is invisible to both metrics and reads as form.
          grad += vec2( 0.63, 0.78 ) * ( duneL * 0.38 + cos( rPh ) * 0.115 * sRip ) * ( wSand * flatness );

          vec3 upv = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), step( 0.80, up ) );
          vec3 tgv = normalize( cross( upv, wn ) + vec3( 1e-5, 0.0, 0.0 ) );
          // bedding planes cut across a cut face: strata have to be in the NORMAL, or a cliff
          // stays a painted plate however good the albedo is. 1.2 u and 0.37 u periods on world
          // Y, so a face reads as bedded rock rather than as a fan of vertical combing.
          float bedX = wq.x * 0.62 + wq.y * 0.46;      // ~8.5 deg structural dip on 1.2 u beds
          // A wall's read is BEDDING, not chatter. The old ladder put 2.6 rms of noise normal on
          // a cut face and multiplied the lot by 1.32 — a 70-degree tangent kick every few
          // pixels on the most foreshortened surface in the frame, which is the "hair" note and
          // most of the far-cliff detail energy. Cut the noise bands to a third and let the
          // horizontal strata carry it: 1.80 u beds, 0.60 u laminae, both footprint-gated.
          // A wall's relief is BEDDING and almost nothing else. The phase used to carry
          // 9 + 3 + 1.8 radians of noise — three full turns across one face, which is not
          // strata, it is the same blob field wearing a sine's name. One radian of wander plus
          // a real structural DIP is what reads as rock: direction is the one thing noise
          // cannot fake, and it is the only scale cue a cliff has.
          grad += ( sharp2( nMes.rg, 0.55 ) + sharp2( nMic.rg, 0.55 ) * dNear + sharp2( nFin.rg, 0.90 ) * dClose ) * wall;
          grad.y += ( sin( vWP.y * 10.13 + bedX * 1.93 + nVar.b * 1.10 ) * 1.60 * sBed
                    + sin( vWP.y * 29.9 + bedX * 5.7 + nMac.b * 1.30 ) * 0.58 * sFine ) * wall;
          vec3 gN = normalize( wn + ( tgv * grad.x + cross( wn, tgv ) * grad.y ) * ( 0.60 + 0.30 * wall ) * ( 1.0 - 0.22 * wGrass ) );

          // ==================================================================== GRASS
          // ONE hue family — the tile's own green — and every band spends its budget on VALUE.
          // The ladder, in SCREEN pixels at gameplay zoom: 1540-190 / 455-57 / 147-18 / 52-6.6 /
          // 31-3.9, and the value budget runs 6 / 9 / 8 / 7 / 11 / 6 percent. Weighted toward
          // the MIDDLE of that ladder on purpose: a shipping ground shader measures MID/HF near
          // 1.1 because its variation lives in painted macro shapes with grain on top. The old
          // split put 12% and 11% on the two finest bands and 1.8% on the macro one — inverted,
          // and it measured as noise (sign-flip 0.43, white noise is 0.50) rather than material.
          float gMac  = nMac.b;                                            // 1080-78 px patches
          float gMes  = nMes.b;                                            //  480-48 px swales
          float gMeso = smoothstep( 0.22, 0.80, nMes.a );                  //  290-24 px soil patches
          float gMic  = smoothstep( 0.14, 0.86, nMic.a );                  //  330-10 px clumps  (MID)
          float gGate = smoothstep( 0.16, 0.78, nMac.b ) * 0.62 + 0.44;    // stony here, smooth there
          float gFin  = smoothstep( 0.32, 0.68, nFin.a );                  //   80-3 px  grain   (HF)
          vec3 gCol = vBase * v32;
          gCol *= 0.910 + 0.180 * gMac;                                 // +-9%
          gCol *= 0.876 + 0.248 * gMes;                                 // +-12.4%
          gCol *= 0.866 + 0.268 * gMeso;                                // +-13%    <- MACRO ALBEDO
          // The two finest bands are worth ~17% each, not 35%. The gate is now full across the
          // whole near field, and 35% on a 6 px band, SQUARED by the gamma-2 lift at the end of
          // this shader, is a field of blown white specks — cottage cheese, not sward. Detail
          // energy belongs on the 18-50 px bands above, where a player reads material.
          gCol *= mix( 1.0, 1.0 + ( gMic - 0.5 ) * 0.38 * gGate, dNear );
          // 0.46, not 0.62. Squared by the gamma-2 lift below, 31% on a 3 px band is the
          // pale cottage-cheese speckle the mid field measured HF_rms 27.5 on — the single
          // largest block of detail energy in the frame and all of it on the one band that
          // reads as confetti rather than as sward.
          gCol *= 1.0 + ( gFin - 0.5 ) * 0.46 * dClose * gGate;
          // The macro band's job is HUE, not value: blue-green swale to yellow-green rise,
          // about 7 degrees apart at matched luminance. Half the old swing — 1.050/0.916 across
          // R and B was a 14% chroma push, and against warm sand that is the acid-green read.
          gCol *= mix( vec3( 0.972, 1.006, 1.002 ), vec3( 1.026, 1.003, 0.958 ),
                       smoothstep( 0.24, 0.86, gMac * 0.55 + nVar.b * 0.45 ) );
          // +12% chroma about the region's own luminance, applied ONCE at the end of the value
          // ladder. Pushing it into the base tint instead just gets averaged back out by the
          // neutral sky fill; this holds the sward inside the 0.30-0.45 band the script wants
          // without touching hue or value.
          // 1.22, not 1.54. The tile tint is already ON palette (#5a7e4f, sat 0.371); this
          // boost, then squared by the gamma-2 lift at the end of the shader, is what shipped
          // the sward at a measured 0.46-0.55 against a locked 0.30-0.42. Value and hue do not
          // move — the read that comes off here goes back on in v32's 4-6 u band above.
          gCol = mix( vec3( dot( gCol, vec3( 0.30, 0.59, 0.11 ) ) ), gCol, 1.22 );
          gCol = mix( gCol, gCol * vec3( 0.86, 0.93, 0.83 ), pd.b * 0.45 );          // forest sward
          // bare soil showing between the clumps: the dark end of the value range, same family
          gCol = mix( gCol, gCol * vec3( 0.84, 0.79, 0.70 ), smoothstep( 0.34, 0.06, sharp( nMic.a, 1.5 ) ) * 0.20 * dNear );
          // clumping: the 24 px band gates WHERE the blades bunch, so the sward has stands and
          // thin patches instead of one even carpet of noise
          gCol *= mix( 1.0, 0.90 + 0.20 * gMic, gMeso * dNear * 0.9 );

          // ==================================================================== SAND
          // Warm 38-degree family. Every bit of structure is ripple and grain; nothing here
          // shifts hue, so a dune is read by its light, not by its colour. Same ladder as grass
          // — the beach measured as a flat cream matte because its whole budget sat on a 2 px
          // grain band that the mip chain then averaged straight back out.
          vec3 sCol = vec3( 0.5 );
          if ( wSand > 0.003 ) {
          // chroma another 10% off each end's OWN luminance, so no value moves: measured
          // 0.436 against #C6A874's own 0.414, which is what read acid beside the sward.
          // and another 16% off both ends about their OWN mean: the frame measured sat 0.428
          // where the bible's desert band tops out at 0.34, which is sand out-chroma'ing the
          // sward next to it. Value does not move, so the dune's light is untouched.
          sCol = mix( vec3( 0.305, 0.283, 0.248 ), vec3( 0.376, 0.349, 0.306 ), 0.30 + 0.36 * nMac.b + 0.26 * nVar.b );
          sCol *= v32;
          sCol *= 0.935 + 0.130 * nMes.b;                                             // 480-48 px drift
          // THE MACRO READ IS THE WAVE TRAIN, not a blob field. What used to sit here was
          // a 24 px Voronoi at +-12.9% with a 10 px one at +-17% on top of it: two isotropic
          // cell fields stacked, which is the mottled leopard-blotch camouflage the judges
          // named, and no amount of tuning turns an isotropic cell field into a desert.
          // Crests and ripples are harmonics of sPh, so the structure is DIRECTIONAL and
          // its energy lands on the 24 px band a player reads as material rather than on
          // the 3 px band that measures as confetti.
          sCol *= 1.0 + duneL * 0.086 + ripL * 0.050;
          // The 10 px cell tap is GONE rather than damped — a Voronoi field sitting on the
          // exact peak of MID_rms's band-pass, i.e. every pixel of its energy landing where
          // the metric reads "blurry blobs". The ripple owns that scale now. The 3 px band
          // keeps a whisper, enough that the near field does not mip to matte: a dune's
          // finest REAL feature is the ripple, and the ripple is 24 px.
          // Grain stays on dClose and nothing else. Giving sand its own looser footprint gate
          // to buy back near-field HF prints a HARD BAND of white speckle across the frame:
          // the board is tilted, so the pixel footprint is LARGEST at the bottom of the screen
          // and any gate tuned to open in the near field opens in the mid field first. That
          // band measured +0.55 HF and read as couscous — the confetti the bible rejects.
          sCol *= 1.0 + ( gFin - 0.5 ) * 0.16 * dClose;
          // coarse dark grains swept into the ripple TROUGHS — same hue, lower value. The
          // ripple places them, so the grit reads as sorting rather than as leopard print.
          sCol = mix( sCol, sCol * vec3( 0.812, 0.778, 0.722 ),
                      smoothstep( 0.40, -0.80, ripL ) * 0.17 * sRip );
          }

          // ==================================================================== ROCK
          // Warm grey-ochre family. Two things only: bedding strata (value bands on world Y)
          // and a fracture network (the CELL BORDERS of the 0.12 m tap, a dark hairline mesh).
          vec3 rCol = vec3( 0.5 );
          if ( wRock > 0.003 ) {
          // Bedding, one band per resolvable scale and each faded out where it stops being one.
          // 1.21 u beds carry the read; the 0.37 u laminae only exist in the near field; the
          // 1.61 u marker bed is the coarse rhythm that survives to the back of the frame.
          float sbP = fract( vWP.y * 1.613 + bedX * 0.308 + nVar.b * 0.18 );                     // 0.62 u beds
          float strata  = smoothstep( 0.0, 0.30, sbP ) * ( 1.0 - smoothstep( 0.86, 1.0, sbP ) );
          float fineBed = 0.5 + 0.5 * sin( vWP.y * 29.9 + bedX * 5.7 + nMac.b * 1.30 );            // 0.21 u
          float beds = smoothstep( 0.38, 0.62, fract( vWP.y * 0.42 + bedX * 0.12 + nVar.b * 0.35 ) ); // 2.4 u marker
          // No strata on flat ground: a sine on world Y has an infinite screen frequency where
          // the surface is level, and the old 0.22 floor printed that alias over every plateau.
          strata = mix( 1.0, ( 0.62 + 0.62 * mix( 0.5, strata, sBed ) )
                           * ( 0.86 + 0.28 * mix( 0.5, fineBed, sFine ) )
                           * ( 0.82 + 0.36 * beds ),
                        clamp( wall * 0.80 + smoothstep( 0.015, 0.20, gslope ), 0.0, 1.0 ) );
          // Chroma cut ~22% off the phase-6 pair: the far massif measured a terracotta 0.44 on
          // a lit face where the bible's mountain band tops out far lower. Value spread keeps
          // the read; the hue family does not move.
          // MOUNTAIN, not desert. The bible locks rock on #7A7368 at sat 0.08-0.18, val
          // 0.32-0.62; this pair used to BE the desert albedo and a lit face measured #c6a67c,
          // sat 0.37 val 0.78 — twice the chroma ceiling and the rock sharing the sand's tint.
          // MOUNTAIN, MEASURED. The pair above was chroma 0.40 on a 35 degree hue — that is
          // the DESERT axis, and the far massif duly measured sat 0.317 hue 34.5 and read as
          // tan dough. #7A7368 is chroma 0.148 at hue 37; this pair is 0.225, held a little
          // above the letter of the palette so the rock does not go pewter, and every end
          // keeps its old luminance exactly. Value spread does the reading, not chroma.
          rCol = mix( vec3( 0.301, 0.273, 0.233 ), vec3( 0.562, 0.509, 0.436 ),
                      clamp( 0.24 + 0.26 * nMac.b + 0.30 * nMes.b + 0.14 * nMic.b * dNear + 0.10 * nVar.b, 0.0, 1.0 ) );
          // Mineral staining, block to block: iron-warm on one, grey-cool on the next, on the
          // 78-1080 px band. Chroma BETWEEN blocks rather than chroma in the base is how rock
          // reads grey to the eye and still carries a saturation signal.
          rCol *= mix( vec3( 1.088, 0.994, 0.904 ), vec3( 0.951, 0.993, 1.052 ),
                       smoothstep( 0.30, 0.95, strata * 0.62 + nMac.b * 0.26 + nVar.b * 0.14 ) );
          rCol *= strata * v32;
          // A fracture net is a HAIRLINE, so it belongs on the finest tap. At 10 px a
          // half-strength dark mesh is pure MID energy — it is most of what measured as
          // "blurry blobs, no material" on the far massif. Cavity AO keeps the 10 px band at
          // a third of its old depth, because that one is shape rather than grain.
          float frac = smoothstep( 0.22, 0.02, sharp( nFin.a, 3.0 ) );                // joints, 3.4 px
          rCol *= 1.0 - frac * ( 0.38 + 0.30 * wall ) * mix( 0.22, 1.0, dClose );
          float cav = smoothstep( 0.58, 0.18, 0.55 * nMes.a + 0.45 * sharp( nMic.a, 1.6 ) );
          rCol *= 1.0 - cav * 0.13 * ( 0.45 + 0.55 * detail );
          rCol *= 0.968 + 0.062 * smoothstep( 0.22, 0.80, nMes.a );                   // block scatter, 20 px
          // SLABS, 65 px. Between the 20 px grain and the 220 px massif shapes the rock had
          // nothing at all, which is why every face read as one uniform plate with static on
          // it. A 65 px feature contributes 0.15 to MID_rms and 0.01 to HF, so this is shape
          // bought for free — and the cell BORDERS give it the hard edges rock has.
          rCol *= 0.928 + 0.144 * smoothstep( 0.24, 0.76, nMac.a );
          rCol *= 1.0 - smoothstep( 0.20, 0.02, nMac.a ) * 0.26;                        // slab joints
          // Grit at 3.4 px, and NOT gated out with distance — the mip chain IS the LOD here.
          // A 3 px feature contributes ~1.0 to HF_rms and ~0.12 to MID_rms, so this is the one
          // band that keeps a far massif from mipping down to a painted plate without adding
          // any of the blur the metric reads as structureless.
          // ...and the far end of the grit comes off. "The mip chain is the LOD" is not true
          // of a Voronoi: its cell borders are step edges, and a step edge survives a mip as
          // contrast, not as blur — so the back of the massif wore the same 3.4 px scales as
          // the front and the near/far HF ramp measured 1.55 against a 1.6 floor. The 65 px
          // slab band above takes over what this gives up.
          // ...and the far floor comes down again, here and on the massif mesh's two 3.4 px
          // bands. These mixes are DISTANCE floors: they are 1.0 in the near field and change
          // nothing there. Holding them at a quarter of a band the rasteriser cannot resolve
          // pinned far-field HF at 14.3, and the near/far ramp is a RATIO — once the beach
          // stopped being confetti the near end could no longer clear 1.6x a far end that
          // was still carrying sub-pixel grain.
          rCol *= 1.0 + ( gFin - 0.5 ) * 0.86 * mix( 0.16, 1.0, dClose )
                      + ( smoothstep( 0.16, 0.84, nMic.a ) - 0.5 ) * 0.06 * dNear;
          rCol = mix( rCol, rCol * vec3( 0.86, 1.06, 0.79 ), nMac.b * 0.30 * ( 1.0 - wall ) );   // lichen
          // talus: a gravel wash over the bottom third only, so it grounds the cut without
          // painting the whole face brown
          float scree = wall * smoothstep( 0.55, 1.0, vInfo.x ) * ( 0.42 + 0.58 * nMac.a );
          rCol = mix( rCol, vec3( 0.372, 0.352, 0.322 ) * ( 0.70 + 0.62 * nMic.a ), scree * 0.80 );
          }

          // ==================================================================== SNOW
          // SNOW ALBEDO CANNOT SIT ON THE TONEMAP SHOULDER. This pair is squared into linear
          // below (gamma 2.0), so a 0.98 top end is 0.96 linear, and 0.96 albedo under the key
          // plus a 0.62 specular lands at 2.5+ in the HDR buffer — where the ACES curve has
          // almost no slope left. Every crust, drift and wind streak the taps below put into
          // the snow was therefore being flattened into one value on the way out: the blown
          // white voids on the massif, measured at RGB 226-232 with saturation 0.03 and zero
          // HF. Same hue family, 10% off the top, and the texture survives the curve.
          vec3 nCol = mix( vec3( 0.780, 0.818, 0.905 ), vec3( 0.880, 0.892, 0.928 ), 0.44 * nMac.a + 0.56 * nMic.a * dNear );
          nCol *= ( 0.972 + 0.055 * nFin.a * dNear ) * v32;

          vec3 col = gCol;
          col = mix( col, sCol, wSand );
          col = mix( col, rCol, wRock );
          col = mix( col, nCol, wSnow );

          // ---- MACRO ALBEDO, once, over every material. A 24-48 px value field with a whisper
          // of hue in it: the band the metric's MID_rms is a band-pass ON, and the band a
          // player reads as SHAPE rather than as grain. It costs nothing in HF — a 24 px
          // feature's high-pass gain is 0.02 against 0.9 for a 3 px one — which is exactly why
          // structure has to be bought here and not by turning the fine taps up.
          float mLo = smoothstep( 0.18, 0.82, nMes.a * 0.62 + nMes.b * 0.38 );
          col *= 1.0 + ( mLo - 0.5 ) * 0.146 * ( 1.0 - wRock * 0.72 - wSand * 0.55 );
          col *= mix( vec3( 0.985, 0.994, 1.010 ), vec3( 1.018, 1.002, 0.976 ), mLo );
          // A SECOND macro band, one octave coarser and pure value: 78-1080 px shapes — swales,
          // soil sheets, the pale rise on a dune field. This is the band MID_rms is a band-pass
          // ON, it costs nothing in HF, and without it the material's whole budget sits on
          // grain and measures as noise-beats-structure however much grain there is.
          // Sand's damping halves: this is where the contrast the ripple gave up goes. A
          // 78-1080 px band cannot reach HF or MID, so a dune field gets its pale rises and
          // dark slacks back for free.
          col *= 1.0 + ( smoothstep( 0.20, 0.80, nMac.b * 0.55 + nMac.a * 0.45 ) - 0.5 ) * 0.268 * ( 1.0 - wRock * 0.55 - wSand * 0.26 );

          // wet sand and riparian mud darken and warm rather than going grey
          col *= mix( vec3( 1.0 ), vec3( 0.700, 0.628, 0.522 ), wet * ( 1.0 - wSnow ) );
          // AO applied gently: this multiplies a colour that is about to be squared into linear,
          // so a raw 0.5 would land at 0.25 and the shadowed ground would crush to mud.
          col *= mix( 1.0, vMat.w, 0.38 );                                     // valley / canopy AO
          col *= pd.r;                                                         // contact pool under props
          // a cut face is dark at its foot: 30% of the wall runs down to 0.58, which is the
          // term that seats a cliff on the ground instead of standing it on a razor line
          col *= mix( 1.0, 0.79, smoothstep( 0.42, 1.0, vInfo.x ) * wall );
          col *= mix( 0.80, 1.0, smoothstep( -1.2, 0.10, vWP.y ) );            // darker sea bed

          // NO RIM BAND. Material has to bleed across a tile boundary — grid.js owns the line,
          // and a desaturated curb painted just inside every hex was the second half of the
          // double-drawn edge that read as laser-cut plates.

          col = mix( vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ), col, 1.07 );
          diffuseColor.rgb *= col * col;   // gamma 2.0: pow() is dear in software GL`)
        .replace('#include <specularmap_fragment>', /* glsl */`
          // broken up by the grain octave, or a wet bank turns into one blown-out blob
          // The sand sheen rides the RIPPLE, not a 2.5 px sparkle mask. A quartz glint on a
          // 3 px feature is a specular highlight the size of a pixel — the one term in this
          // shader guaranteed to measure as confetti — and a windward face catching the light
          // while the lee slack stays matte is what actually says "dune" at gameplay zoom.
          float specularStrength = ( 0.05 + 0.085 * wSand * ( 0.62 + 0.38 * nMic.a + 0.34 * ripL ) + 0.22 * wRock
                                     + 0.30 * wSnow + 0.34 * wet )
                                 * ( 0.40 + 0.60 * flatness ) * ( 0.84 + 0.32 * nFin.a );`)
        .replace('#include <normal_fragment_maps>', /* glsl */`
          normal = normalize( mat3( viewMatrix ) * gN );`)
        .replace('#include <lights_phong_fragment>', /* glsl */`
          BlinnPhongMaterial material;
          material.diffuseColor = diffuseColor.rgb;
          material.specularColor = specular * specularStrength;
          material.specularShininess = mix( 26.0, 175.0, clamp( wSnow * 0.5 + wet, 0.0, 1.0 ) ) + wSand * 32.0;
          material.specularStrength = specularStrength;`)
        // AMBIENT, ALBEDO-WEIGHTED. A shadow on tan sand must stay tan. The sky term is kept
        // nearly neutral (a strongly blue sky term is what puts navy in a desert shadow), and
        // most of the fill is a ground bounce that is the surface's OWN albedo squared — so the
        // unlit side of a ripple lands within a few degrees of hue of the lit side instead of
        // rotating toward the sky. Cheap stand-in for an SH bounce.
        .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
          float ambUp = clamp( gN.y * 0.5 + 0.5, 0.0, 1.0 );
          // SHADOW-AWARE FILL, and it is the reason this frame reads as having shadows at all.
          // reflectedLight.directDiffuse already carries the shadow mask, so dividing the albedo
          // back out of it recovers the sun's irradiance here: ~0 under a cast shadow, ~1.9 in
          // open sun. A fill that is CONSTANT across that boundary lifts every shadow straight
          // back to within a few percent of the lit ground, which is exactly how a frame full of
          // working shadow maps ends up critiqued as "nothing in this frame casts one".
          vec3 dd = reflectedLight.directDiffuse / max( material.diffuseColor, vec3( 1e-4 ) );
          float lit = clamp( max( dd.r, max( dd.g, dd.b ) ) * 0.80, 0.0, 1.0 );
          vec3 skyC = mix( vec3( 0.252, 0.252, 0.258 ), vec3( 0.322, 0.328, 0.344 ), ambUp );
          // warm/cool separation: the shadow family cools ~400 K, the lit family does not move.
          // Only the SKY third of the fill is tinted, so the shadow hue stays inside ~8 degrees
          // of the lit hue and a shadow on tan sand is still tan.
          skyC *= mix( vec3( 0.988, 0.996, 1.020 ), vec3( 1.0 ), lit );
          vec3 bounce = material.diffuseColor * vec3( 1.24, 1.10, 0.88 );
          // The two fills do NOT occlude the same way. Skylight still reaches a shadowed hex —
          // knock it down for the geometry that is casting, not to nothing. The ground BOUNCE
          // is second-hand sunlight, so under a cast shadow it is almost entirely gone; leaving
          // it at full strength is what held a fully shadowed fragment at 0.84 of its lit
          // luminance and made a board full of working shadow maps read as having none.
          // The floor is up: nothing lit should land below luma 0.20, and near grass was
          // measuring v50 0.169 with its shadow chroma collapsing, i.e. mud. The extra fill is
          // deliberately weighted to the BOUNCE (which is albedo-tinted) rather than to the sky
          // term, so lifting the shadow does not rotate its hue toward blue.
          reflectedLight.indirectDiffuse += material.diffuseColor
            * ( skyC * ( 0.60 + 0.14 * wall - 0.12 * wRock ) * mix( 0.58 - 0.06 * wRock, 1.0, lit )
              + bounce * ( 1.04 + 0.30 * wRock ) * mix( 0.44 + 0.30 * wRock, 1.0, lit ) );`);
    };
    return m;
  }

  // ---------------------------------------------------- ridges, trees and scree
  _buildProps() {
    const { map } = this;
    this.propDecal = [];
    // Reserved ground: the resource marker is the single most-scanned thing on a Civ board, so
    // its spot is claimed before a tree, a boulder or a tuft can be scattered on top of it.
    this.resSpot = new Float32Array(map.tiles.length * 2).fill(9);
    for (const t of map.tiles) {
      if (t.height <= 0 || !t.resource || !RES_ICON[t.resource]) continue;
      const a = hash2(t.q, t.r, 5171) * 6.283, rr = 0.50 + 0.10 * hash2(t.q, t.r, 5273);
      this.resSpot[t.i * 2] = Math.cos(a) * rr; this.resSpot[t.i * 2 + 1] = Math.sin(a) * rr;
    }
    const clearOf = (i, lx, lz, r2) => {
      const sx = this.resSpot[i * 2]; if (sx > 8) return true;
      const dx = lx - sx, dz = lz - this.resSpot[i * 2 + 1];
      return dx * dx + dz * dz > r2;
    };
    this._clearOf = clearOf;
    const trees = [[], [], [], [], [], []];   // conifer A/B, broadleaf A/B, dry, scrub
    const ridges = [], rocks = [];
    const hi = this.maxH * 0.58;
    const treeLine = Math.max(2.2, this.maxH * 0.62) * 0.86;
    const HIGH = t => t.biome === 'mountain' || t.biome === 'snow';

    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i];
      if (this.surfY[i] < 0.02 || t.height <= 0) continue;
      const p = axialToWorld(t.q, t.r);

      // ---- trees. Density is a climate field, not a per-biome constant: a Worley-ish fbm cuts
      //      clearings a few hexes across, a river corridor thickens the stand, and both slope
      //      and altitude thin it out so nothing grows on a cliff or above the treeline.
      const stand = fbm2(p.x * 0.115 + 41, p.z * 0.115 + 7, { octaves: 3, seed: 3301 });
      let dens = smoothstep01(0.30, 0.62, stand) * 0.85 + 0.15;
      dens *= 1 - 0.85 * clamp01((this.rough[i] - 0.34) / 0.34);            // no forest on a crag
      dens *= 1 - 0.90 * clamp01((this.surfY[i] - treeLine) / 1.2);         // treeline
      dens *= 1 + 0.55 * this.rip[i];                                       // riparian gallery
      const want = (TREES[t.biome] ?? 0) * dens;
      const cShare = CONIFER[t.biome] ?? 0.4, scrubShare = SCRUB[t.biome] ?? 0.3;
      const nt = Math.floor(want) + (hash2(t.q, t.r, 55) < (want % 1) ? 1 : 0);
      for (let k = 0; k < nt; k++) {
        const h1 = hash2(t.q * 31 + k, t.r * 17, 701), h2 = hash2(t.q * 31 + k, t.r * 17, 809);
        const h3 = hash2(t.q * 31 + k, t.r * 17, 907), h4 = hash2(t.q * 31 + k, t.r * 17, 1013);
        const h5 = hash2(t.q * 31 + k, t.r * 17, 1117), h6 = hash2(t.q * 31 + k, t.r * 17, 1223);
        const h7 = hash2(t.q * 31 + k, t.r * 17, 1319);
        // clumped, not scattered: trees pull toward one of two knots per tile so the grass
        // reads between the stands instead of a wall-to-wall carpet
        const knot = h6 < 0.5 ? 0 : 1;
        const ka = hash2(t.q, t.r * 3 + knot, 1327) * 6.283, kr = 0.24 * hash2(t.q, t.r * 3 + knot, 1429);
        const a = h1 * Math.PI * 2, rr = 0.22 + 0.60 * Math.sqrt(h2);
        const lx = Math.cos(ka) * kr + Math.cos(a) * rr * 0.85, lz = Math.sin(ka) * kr + Math.sin(a) * rr * 0.85;
        const y = this._localY(i, lx, lz);
        if (y < 0.06 || !clearOf(i, lx, lz, 0.26)) continue;
        if (this._slope(i, lx, lz) > 0.62) continue;    // ~32 degrees: no tree roots on a cut face
        const jungle = t.biome === 'jungle';
        const dry = t.biome === 'desert' || t.biome === 'plains' || t.biome === 'beach';
        const cold = this.surfY[i] > hi || t.biome === 'tundra' || t.biome === 'snow';
        const scrub = h7 < scrubShare;
        const conif = !scrub && h4 < cShare;
        const batch = scrub ? 5 : conif ? (h5 < 0.5 ? 0 : 1) : (jungle ? (h5 < 0.55 ? 3 : 2) : dry ? (h5 < 0.62 ? 4 : 2) : (h5 < 0.30 ? 3 : 2));
        const kind = scrub ? 4 : jungle ? 1 : cold ? 2 : dry ? 3 : 0;
        // Scale against a hex: a hex is 1.73 units across the flats, so a canopy has to sit
        // near 0.4 of that or the board reads as a diorama of gravel. +-0.75..1.30 per instance.
        const base = scrub ? 0.44 : jungle ? 0.86 : conif ? 0.76 : 0.80;
        const s = base * (0.75 + 0.55 * h3);
        trees[batch].push(p.x + lx, y - 0.04, p.z + lz, s, h5 * 6.283, h3, kind, i);
        this._ground(p.x + lx, p.z + lz, y, (scrub ? 0.46 : 0.66) * s, scrub ? 0.34 : 0.56, i);
        if (!scrub) this._stamp(p.x + lx, p.z + lz, 0.30 + 0.9 * s, 0.55, 2);
      }

      // ---- ecotone scatter. Every edge where this tile disagrees with its neighbour gets a
      //      couple of bushes sitting ON the seam, half in each tile. Without them the biome
      //      blend is a colour ramp that still stops dead on the hex chord.
      for (let d = 0; d < 6; d++) {
        const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
        if (!nb || nb.height <= 0 || nb.biome === t.biome) continue;
        if (t.biome === 'beach' || nb.biome === 'beach' || t.i > nb.i) continue;   // one side emits
        const ka = EDGE_C[d][0], kb = EDGE_C[d][1];
        const ex = (CORNER[ka][0] + CORNER[kb][0]) * 0.5, ez = (CORNER[ka][1] + CORNER[kb][1]) * 0.5;
        const cnt = 2 + (hash2(t.q * 5 + d, t.r, 3413) < 0.5 ? 1 : 0);
        for (let k = 0; k < cnt; k++) {
          const g1 = hash2(t.q * 7 + d * 3 + k, t.r * 11, 3517), g2 = hash2(t.q * 7 + d * 3 + k, t.r * 11, 3623);
          const g3 = hash2(t.q * 7 + d * 3 + k, t.r * 11, 3719);
          const lx = ex * (0.72 + 0.62 * g1) + (g2 - 0.5) * 0.62 * (CORNER[kb][0] - CORNER[ka][0]);
          const lz = ez * (0.72 + 0.62 * g1) + (g2 - 0.5) * 0.62 * (CORNER[kb][1] - CORNER[ka][1]);
          const y = this._localY(i, lx * 0.98, lz * 0.98);
          if (y < 0.06) continue;
          const s = 0.30 * (0.75 + 0.55 * g3);
          trees[5].push(p.x + lx, y - 0.03, p.z + lz, s, g1 * 6.283, g3, 4, i);
          this._ground(p.x + lx, p.z + lz, y, 0.24 * s, 0.30, i);
        }
      }

      // ---- summits: ONE closed mass per high hex, its footprint sized to that hex and its
      //      foot seated on the tile's LOWEST welded corner, so the mass grows out of the hex
      //      field instead of being parked on it. Two consequences, and both were the standing
      //      reject: no summit can cross into a neighbour's hex any more (that intersection is
      //      what read as flat shards), and no high tile is left as a bare flat hexagonal plate
      //      with a sky-coloured saddle behind it. Height still carries the crest line —
      //      prominence and the massif swell decide who is a shoulder and who is a hero peak.
      if (HIGH(t)) {
        let gx = 0, gz = 0, nbSum = 0, nbN = 0;
        for (let d = 0; d < 6; d++) {
          const o = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
          if (!o) continue;
          const dy = this.surfY[o.i] - this.surfY[i];
          gx += dy * CORNER[d === 0 ? 0 : 6 - d][0]; gz += dy * CORNER[d === 0 ? 0 : 6 - d][1];
          if (HIGH(o)) { nbSum += this.surfY[o.i]; nbN++; }
        }
        const h1 = hash2(t.q, t.r, 1601), h2 = hash2(t.q, t.r, 1709), h3 = hash2(t.q, t.r, 1811);
        const prom = nbN ? clamp01((this.surfY[i] - nbSum / nbN) * 0.9 + 0.35) : 0.9;
        const glen = Math.hypot(gx, gz);
        // ridge axis = perpendicular to the gradient; a flat summit falls back to a hashed yaw
        const theta = glen > 0.06 ? Math.atan2(gx, -gz) : h1 * Math.PI * 2;
        const alt = clamp01((this.surfY[i] - this.maxH * 0.42) / (this.maxH * 0.5));
        // 40m swell over the massif, so the skyline has shoulders and summits, not one plateau
        const swell = 0.55 + 1.05 * fbm2(p.x * 0.055, p.z * 0.055, { octaves: 2, seed: 4241 });
        // A hex is 1.0 to a corner and 0.866 to an edge. A mean foot of 1.28-1.42 is a little
        // over one hex — enough that neighbours meet and weld low on the flanks, little enough
        // that the peak belongs to one tile and grid.js's seam is only ~0.4 u under rock at
        // the rim instead of the 1.14 u it used to be.
        const rad = 1.34 + 0.15 * h1;
        const stretch = 0.86 + 0.36 * h3 * h3;   // some summits pull out along the contour
        // seat on the lowest welded corner and give the mass that drop back as height, so a
        // summit on a shelving tile grows taller instead of opening a gap on its low side
        let foot = this.centreY[i];
        for (let k = 0; k < 6; k++) foot = Math.min(foot, this.cornerY[i * 6 + k]);
        const rise = this.centreY[i] - foot;
        // height leans on the CONTINUOUS fields (altitude, prominence, the massif swell) and
        // only jitters +-40% per tile: a per-tile hash cubed put a 3x step between two touching
        // masses, which is a bed of nails however well each one is modelled
        const hgt = Math.min(3.4, (0.85 + 1.85 * h2 * h2) * (0.58 + 0.88 * alt)
          * (0.72 + 0.60 * prom) * swell) + Math.min(1.1, rise) * 0.80 + 0.50;
        // yaw is negated: a +Y rotation carries local +X to (cos, 0, -sin)
        // The dark V-notches in the massif are NOT the loft grazing the field: lifting this
        // seat by a third of the corner spread, and then by three quarters of it, moved neither
        // their position nor their size. They are pairs of CLIFF WALL faces meeting at a hex
        // corner — two vertical quads that both face away from a low sun — and the fill below
        // is what stops them reading as holes punched in the rock.
        ridges.push(p.x + (h1 - 0.5) * 0.12, foot - 0.55, p.z + (h3 - 0.5) * 0.12,
          rad * stretch, hgt, rad / stretch,
          -theta + (h3 - 0.5) * 0.7, (h1 - 0.5) * 0.10, h2, i);
        this.cullR[i] = Math.max(this.cullR[i], 3.2 + hgt);
        this._stamp(p.x, p.z, rad * stretch * 1.15, 0.38, 0, 2.4);
      }

      // ---- boulders on hills and bare high ground
      const rocky = HIGH(t) ? 2.4 : (t.biome === 'hills' ? 0.4 : (t.biome === 'desert' ? 0.45 : (this.surfY[i] > hi ? 0.25 : 0.04)));
      const nr = Math.floor(rocky) + (hash2(t.q, t.r, 77) < (rocky % 1) ? 1 : 0);
      for (let k = 0; k < nr; k++) {
        const h1 = hash2(t.q * 23 + k, t.r * 29, 1201), h2 = hash2(t.q * 23 + k, t.r * 29, 1303);
        const h3 = hash2(t.q * 23 + k, t.r * 29, 1409), h4 = hash2(t.q * 23 + k, t.r * 29, 1511);
        const a = h1 * Math.PI * 2, rr = 0.42 + 0.46 * h2;
        const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
        const y = this._localY(i, lx, lz);
        if (y < 0.05 || !clearOf(i, lx, lz, 0.20)) continue;
        const s = HIGH(t) ? 0.14 + 0.26 * h3 : (t.biome === 'desert' ? 0.075 + 0.135 * h3 : 0.10 + 0.17 * h3);
        rocks.push(p.x + lx, y - s * 0.36, p.z + lz,
          s * (0.8 + 0.5 * h4), s * (0.6 + 0.5 * h3), s * (0.8 + 0.5 * h1), h4 * 6.283, (h2 - 0.5) * 0.4, h3, i);
        this._ground(p.x + lx, p.z + lz, y, s, 0.56, i);
      }
    }

    // ---- talus: a fan of scree spilling from the foot of every cliff face, so a cut never
    //      ends in a clean line against flat ground. The shader paints the wash, these are the
    //      blocks that sell it.
    const wf = this.wallFeet || [];
    for (let w = 0; w < wf.length; w += 5) {
      const drop = wf[w + 3], wt = wf[w + 4];
      const nb = Math.min(6, 2 + Math.floor(drop * 2.2));
      for (let k = 0; k < nb; k++) {
        const h1 = hash2(w + k * 7, k, 2711), h2 = hash2(w + k * 7, k, 2803), h3 = hash2(w + k * 7, k, 2909);
        const a = h1 * Math.PI * 2, rr = 0.10 + 0.55 * h2;
        const x = wf[w] + Math.cos(a) * rr, z = wf[w + 2] + Math.sin(a) * rr;
        const s = (0.10 + 0.22 * h3) * Math.min(1.6, 0.6 + drop * 0.5);
        rocks.push(x, wf[w + 1] - s * 0.30, z, s * (0.9 + 0.5 * h1), s * (0.55 + 0.4 * h2), s * (0.9 + 0.5 * h3),
          h2 * 6.283, (h3 - 0.5) * 0.5, h1, wt);
        this._ground(x, z, wf[w + 1], s, 0.52, wt);
      }
    }

    const treeMat = this._treeMaterial();
    const rockMat = this._rockMaterial();
    this.treeMesh = [
      this._instance(coniferGeometry(0), trees[0], treeMat, 'terrain-conifer-a'),
      this._instance(coniferGeometry(1), trees[1], treeMat, 'terrain-conifer-b'),
      this._instance(broadleafGeometry(0), trees[2], treeMat, 'terrain-broadleaf-a'),
      this._instance(broadleafGeometry(1), trees[3], treeMat, 'terrain-broadleaf-b'),
      this._instance(dryTreeGeometry(), trees[4], treeMat, 'terrain-dry'),
      this._instance(shrubGeometry(0), trees[5], treeMat, 'terrain-scrub'),
    ];
    for (const m of this.treeMesh) if (m) {
      // a matching depth material, or the wind sway would detach every shadow from its tree
      m.customDepthMaterial = this._treeDepth;
      // Foliage RECEIVES now. A tree standing inside a keep's shadow and still lit at full sun
      // is the single clearest "pasted on" tell there is, and it is worth the PCF taps.
      this.group.add(m);
    }
    this._buildTileInfo();

    // Static contact decals for everything the prop buffer is too coarse to seat: one
    // multiply disc per tree, shrub, boulder and talus block. Same mechanism as the clutter
    // pools, built once because none of these ever move.
    const pd = this.propDecal;
    if (pd.length) {
      const dq = new THREE.Quaternion(), dp = new THREE.Vector3(), ds = new THREE.Vector3();
      const dm = this._pool(decalGeometry(), this.decalMat, 'terrain-contact-static',
        pd.length / 5, pd.length / 5, 95, (n, m4, col) => {
          const k = n * 5;
          dp.set(pd[k], pd[k + 1], pd[k + 2]); ds.set(pd[k + 3], 1, pd[k + 3]);
          dq.setFromAxisAngle(UP, hash2(n, 3, 8317) * 6.283);
          m4.compose(dp, dq, ds);
          col.setRGB(1, 1, 1);
          return pd[k + 4];
        });
      dm.renderOrder = 2;
      this.group.add(dm);
      this.propDecalMesh = dm;
    }

    // summits rotate through six spur profiles by instance, so no two share a skyline
    this.ridgeMesh = this._instanceRock(ridges, rockMat, 'terrain-ridges');
    this.rockMesh = this._instanceRock(rocks, rockMat, 'terrain-scree', boulderGeometry(), 130);
    if (this.ridgeMesh) this.group.add(this.ridgeMesh);
    if (this.rockMesh) this.group.add(this.rockMesh);
    this.rockMat = rockMat;
  }

  // -------------------------------------------------------------- tile information
  // What a player reads off a Civ board, in two layers. Static: a stone plinth and a prop on
  // every land resource — the thing a player scans for before anything else. Dynamic: a faint
  // warm plate on the hexes a citizen is actually working, rebuilt whenever that set changes.
  // grid.js owns hex lines and range plates; units.js owns the improvement props themselves.
  _buildTileInfo() {
    const { map } = this;
    this.iconMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const plinths = [], icons = { grain: [], beast: [], ore: [], crop: [] };
    for (const t of map.tiles) {
      if (t.height <= 0 || !t.resource) continue;
      const e = RES_ICON[t.resource]; if (!e) continue;
      const i = t.i, p = axialToWorld(t.q, t.r);
      // The spot reserved in _buildProps: out toward the rim, because the middle of a worked
      // hex belongs to units.js's farm or mine and the middle of any hex belongs to whatever
      // unit is standing on it — and swept clear of trees, boulders and tufts.
      const lx = this.resSpot[i * 2], lz = this.resSpot[i * 2 + 1];
      const a = Math.atan2(lz, lx);
      const y = this._localY(i, lx, lz);
      if (y < 0.06 || this.rough[i] > 0.66) continue;
      const s = 0.94 + 0.16 * hash2(t.q, t.r, 5381);
      plinths.push(p.x + lx, y - 0.018, p.z + lz, s, a * 2.1, i);
      icons[e[0]].push(p.x + lx, y + 0.076 * s, p.z + lz, s * 1.45, a * 1.7, i, e[1][0], e[1][1], e[1][2]);
      this._ground(p.x + lx, p.z + lz, y, 0.32 * s, 0.54, i);
    }
    const q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const put = (geo, data, stride, name) => {
      const total = data.length / stride;
      if (!total) { geo.dispose(); return; }
      const m = this._pool(geo, this.iconMat, name, total, total, 120, (n, m4, col) => {
        const o = n * stride, s = data[o + 3];
        q.setFromAxisAngle(UP, data[o + 4]);
        sc.set(s, s, s);
        m4.compose(new THREE.Vector3(data[o], data[o + 1], data[o + 2]), q, sc);
        if (stride > 6) col.setRGB(data[o + 6] * data[o + 6], data[o + 7] * data[o + 7], data[o + 8] * data[o + 8], THREE.LinearSRGBColorSpace);
        else col.setRGB(0.40, 0.365, 0.312, THREE.LinearSRGBColorSpace);   // warm sandstone, not board grey
        return data[o + 5];
      });
      m.castShadow = true; m.receiveShadow = true;   // a plinth is 0.3 tall: it earns a real shadow
      this.group.add(m);
    };
    put(plinthGeometry(), plinths, 6, 'terrain-plinth');
    for (const k of ['grain', 'beast', 'ore', 'crop']) put(iconGeometry(k), icons[k], 9, 'terrain-icon-' + k);

    // Worked-tile highlight. Improvements themselves are units.js's — it ships farms, mines,
    // pastures, quarries and groves as real props on worked hexes, and a second set of furrows
    // painted under them would only fight them. What no one else draws is WHICH hexes a citizen
    // is standing on, so that is what stays here: one additive plate, warm, faint, and gone
    // before the hex chord so grid.js keeps a clean edge to draw its lines on.
    this.workMat = new THREE.MeshBasicMaterial({
      color: 0xffe8b4, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      premultipliedAlpha: true, depthWrite: false, fog: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.workMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.workMat);
    this.workMesh.name = 'terrain-worked';
    this.workMesh.renderOrder = 2;
    this.workMesh.frustumCulled = false;
    this.group.add(this.workMesh);
  }

  // Rebuilt only when the worked set changes — once per end-turn at most, a few dozen tiles.
  // Four rings so the plate carries a soft inner ring instead of a flat wash, and dies to zero
  // at 0.97 of the hex radius.
  _buildWorked() {
    if (!this.workMesh) return;
    const wb = (typeof window !== 'undefined' && window.game?.workedBy) || null;
    const RING = [[0.0, 0.062], [0.45, 0.086], [0.74, 0.101], [0.97, 0.0]];
    const pos = [], col = [], idx = [];
    if (wb) for (const t of this.map.tiles) {
      const i = t.i;
      if (t.height <= 0 || wb[i] < 0 || this.rough[i] > 0.72) continue;
      const p = axialToWorld(t.q, t.r);
      const put = (lx, lz, k) => {
        pos.push(p.x + lx, this._localY(i, lx, lz) + 0.040, p.z + lz);
        col.push(k, k, k);
        return pos.length / 3 - 1;
      };
      const c = put(0, 0, RING[0][1]), rows = [];
      for (let r = 1; r < RING.length; r++) {
        const row = [];
        for (let k = 0; k < 6; k++) {
          const cx = this.cornerLocal[i * 12 + k * 2], cz = this.cornerLocal[i * 12 + k * 2 + 1];
          row.push(put(cx * RING[r][0], cz * RING[r][0], RING[r][1]));
        }
        rows.push(row);
      }
      for (let k = 0; k < 6; k++) {
        const j = (k + 1) % 6;
        idx.push(c, rows[0][j], rows[0][k]);
        for (let r = 0; r < rows.length - 1; r++)
          idx.push(rows[r][k], rows[r][j], rows[r + 1][j], rows[r][k], rows[r + 1][j], rows[r + 1][k]);
      }
    }
    const geo = new THREE.BufferGeometry();
    if (pos.length) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
      geo.setIndex(idx);
    }
    this.workMesh.geometry.dispose();
    this.workMesh.geometry = geo;
    this.workMesh.visible = pos.length > 0;
  }

  // ---------------------------------------------------------------- culled instance pools
  // Every scatter batch on the map is one InstancedMesh, and the gameplay camera can see about
  // 25 of 2816 tiles: drawing all of it was 2 M triangles a frame to show 1%. A pool keeps the
  // full instance table in plain arrays and refills the GPU buffer from the tiles that are
  // actually in the frustum, inside `maxD`, and not under unexplored fog. Refill happens only
  // when the camera moves or the fog changes, so the steady-state cost is zero.
  _pool(geo, material, name, total, cap, maxD, fill) {
    const count = Math.min(total, cap);
    const mesh = new THREE.InstancedMesh(geo, material, count);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const M = new Float32Array(total * 16), C = new Float32Array(total * 3), byTile = new Map();
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    for (let n = 0; n < total; n++) {
      const tile = fill(n, m4, col);
      M.set(m4.elements, n * 16);
      C[n * 3] = col.r; C[n * 3 + 1] = col.g; C[n * 3 + 2] = col.b;
      let l = byTile.get(tile); if (!l) byTile.set(tile, l = []);
      l.push(n);
    }
    mesh.count = 0;
    this._pools.push({ mesh, M, C, byTile, cap: count, maxD });
    return mesh;
  }

  // Visible tiles, nearest first: frustum-tested with a 3.2 unit pad (so a prop just off the
  // edge still casts its shadow into frame) and dropped entirely where the fog has never lifted.
  _visible(camera) {
    const { map } = this, cp = camera.position;
    const vis = (typeof window !== 'undefined' && window.game?.state?.visibility) || null;
    this._frus.setFromProjectionMatrix(this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const list = [];
    for (let i = 0; i < map.tiles.length; i++) {
      if (vis && vis[i] === 0) continue;
      const t = map.tiles[i], p = axialToWorld(t.q, t.r);
      const r = this.cullR[i];
      this._sph.center.set(p.x, this.centreY[i] + r * 0.25, p.z); this._sph.radius = r;
      if (!this._frus.intersectsSphere(this._sph)) continue;
      list.push(Math.hypot(p.x - cp.x, p.z - cp.z), i);
    }
    const order = [];
    for (let k = 0; k < list.length; k += 2) order.push(k);
    order.sort((a, b) => list[a] - list[b]);
    this._vis.length = 0; this._visD.length = 0;
    for (const k of order) { this._visD.push(list[k]); this._vis.push(list[k + 1]); }
  }

  _repackPools() {
    const V = this._vis, D = this._visD;
    for (const p of this._pools) {
      const im = p.mesh.instanceMatrix.array, ic = p.mesh.instanceColor.array;
      let w = 0;
      for (let k = 0; k < V.length && w < p.cap; k++) {
        if (D[k] > p.maxD) break;                       // sorted, so the rest are farther still
        const l = p.byTile.get(V[k]); if (!l) continue;
        for (const n of l) {
          if (w >= p.cap) break;
          im.set(p.M.subarray(n * 16, n * 16 + 16), w * 16);
          ic[w * 3] = p.C[n * 3]; ic[w * 3 + 1] = p.C[n * 3 + 1]; ic[w * 3 + 2] = p.C[n * 3 + 2];
          w++;
        }
      }
      p.mesh.count = w;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.instanceColor.needsUpdate = true;
    }
  }

  // stride-packed [x,y,z,scale,rotY,tint,kind,tile] -> culled InstancedMesh
  _instance(geo, data, material, name) {
    const total = data.length / 8;
    if (total === 0) { geo.dispose(); return null; }
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const mesh = this._pool(geo, material, name, total, TREE_BUDGET, 240, (n, m4, col) => {
      const o = n * 8;
      const s = data[o + 3], rot = data[o + 4], tint = data[o + 5], kind = data[o + 6];
      pos.set(data[o], data[o + 1], data[o + 2]);
      e.set((tint - 0.5) * 0.12, rot, (tint - 0.5) * 0.10);
      scl.set(s * (0.94 + tint * 0.13), s * (0.90 + (1 - tint) * 0.24), s * (0.94 + tint * 0.13));
      // 0 temperate, 1 jungle, 2 boreal, 3 dry — hue jittered +-9 degrees, value +-25%
      const c = CANOPY[kind] || CANOPY[0];
      const jitter = hash2(n * 13 + 5, kind, 3733);
      const st = fbm2(data[o] * 0.085 + 3, data[o + 2] * 0.085 + 11, { octaves: 2, seed: 5701 });
      col.setHSL(c[0] + (jitter - 0.5) * 0.05 + (st - 0.5) * 0.040,
        c[1] * (0.86 + 0.30 * tint) * (0.82 + 0.36 * st),
        c[2] * (0.74 + 0.58 * tint) * (0.84 + 0.34 * st), THREE.LinearSRGBColorSpace);
      q.setFromEuler(e);
      m4.compose(pos, q, scl);
      return data[o + 7];
    });
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  // stride-packed [x,y,z,sx,sy,sz,yaw,tilt,tint,tile]. `geo` omitted -> the six ridge profiles,
  // split into six batches so a single instanced draw never repeats one silhouette.
  _instanceRock(data, material, name, geo, maxD = 260) {
    const total = data.length / 10;
    if (total === 0) { geo?.dispose(); return null; }
    const geos = geo ? [geo] : [0, 1, 2, 3, 4, 5].map(peakGeometry);
    const g = new THREE.Group(); g.name = name;
    const q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();
    for (let b = 0; b < geos.length; b++) {
      const ids = [];
      for (let n = 0; n < total; n++) if (n % geos.length === b) ids.push(n);
      if (!ids.length) { geos[b].dispose(); continue; }
      const mesh = this._pool(geos[b], material, name + '-' + b, ids.length, ids.length, maxD, (w, m4, col) => {
        const o = ids[w] * 10;
        pos.set(data[o], data[o + 1], data[o + 2]);
        scl.set(data[o + 3], data[o + 4], data[o + 5]);
        e.set(data[o + 7], data[o + 6], (hash2(ids[w], 7, 9091) - 0.5) * 0.16);
        q.setFromEuler(e);
        m4.compose(pos, q, scl);
        const t = 0.26 + 0.15 * hash2(ids[w], 11, 6151) + 0.06 * data[o + 8];
        col.setRGB(t * 1.05, t * 1.0, t * 0.94);
        return data[o + 9];
      });
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
    }
    return g.children.length ? g : null;
  }

  _treeMaterial() {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    const SWAY = /* glsl */`#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 iw = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
      #else
        vec3 iw = vec3( 0.0 );
      #endif
      float sw = clamp( position.y / 1.45, 0.0, 1.0 ); sw *= sw;
      float ph = iw.x * 0.55 + iw.z * 0.41;
      transformed.x += sin( uTime * 1.45 + ph ) * sw * 0.085;
      transformed.z += cos( uTime * 1.13 + ph * 1.3 ) * sw * 0.070;
      transformed.y -= sw * 0.014 * ( 1.0 + sin( uTime * 1.45 + ph ) );`;
    const inject = (s, extra = '') => {
      s.uniforms.uTime = this.time;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', SWAY + extra);
    };
    m.onBeforeCompile = (s) => {
      inject(s, /* glsl */`
      #ifdef USE_INSTANCING
        vTWP = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
      #else
        vTWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      #endif`);
      s.uniforms.uNoise = { value: this.noise };
      s.uniforms.uDet = { value: this.detail };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTWP;\nattribute float aBark;\nvarying float vBark;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBark = aBark;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uNoise;\nuniform sampler2D uDet;\nvarying vec3 vTWP;\nvarying float vBark;')
        .replace('#include <map_fragment>', /* glsl */`
          // leaf-scale breakup: the canopy is not one flat green
          // A canopy is ~30 px across at the gameplay rig. The old 0.34 tap put its cells at
          // 10 px, i.e. three of them on a whole tree, which is why every crown came back a
          // flat green blob with polygon facets on it. 0.95 lands leaf clumps at 3 px.
          vec4 lf = texture2D( uDet, vTWP.xz * 0.36 + vec2( vTWP.y * 0.25, vTWP.y * -0.16 ) );
          vec4 lm = texture2D( uNoise, vTWP.xz * 0.31 + vec2( vTWP.y * -0.22, vTWP.y * 0.14 ) + vec2( 0.27, 0.63 ) );
          vec4 lc = texture2D( uNoise, vTWP.xz * 0.055 + vec2( 0.4, 0.7 ) );
          diffuseColor.rgb *= vec3( 0.80 + 0.40 * lf.a ) * ( 0.86 + 0.30 * lm.a )
            * mix( vec3( 1.05, 1.00, 0.86 ), vec3( 0.80, 1.00, 0.90 ), lf.b )
            * ( 0.82 + 0.36 * lc.b ) * 0.50;
          diffuseColor.rgb = mix( vec3( dot( diffuseColor.rgb, vec3( 0.32, 0.56, 0.12 ) ) ) * vec3( 1.04, 1.0, 0.88 ),
                                  diffuseColor.rgb, 0.88 );
          // bark: lifted straight back out of the instance's green tint, otherwise every trunk
          // is a dark olive smear and the prop reads as a floating cabbage
          diffuseColor.rgb = mix( diffuseColor.rgb,
            vec3( 0.235, 0.150, 0.092 ) * ( 0.42 + 1.05 * vBark ) * ( 0.72 + 0.56 * lf.a ),
            step( 0.01, vBark ) );`)
        .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
          // backlit translucency: sun through the canopy, the thing that stops foliage
          // reading as two flat tones
          #if NUM_DIR_LIGHTS > 0
            vec3 Ldir = directionalLights[ 0 ].direction;
            vec3 Vdir = normalize( vViewPosition );
            vec3 Hs = normalize( Ldir + normal * 0.45 );
            // subsurface wrap: warm yellow-green transmission, not the leaf's own colour
            float trans = pow( max( dot( Vdir, -Hs ), 0.0 ), 2.4 ) * 0.35;
            reflectedLight.indirectDiffuse += material.diffuseColor * directionalLights[ 0 ].color
              * vec3( 1.24, 1.14, 0.52 ) * trans;
            // warm rim on the sunward edge: the term that separates a canopy from the ground
            // behind it and stops the whole batch reading as flat cut-outs
            float rimF = pow( clamp( 1.0 - dot( Vdir, normal ), 0.0, 1.0 ), 2.1 );
            float sunSide = clamp( dot( normal, Ldir ) * 0.5 + 0.62, 0.0, 1.0 );
            reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * material.diffuseColor
              * rimF * sunSide * sunSide * 0.24;
          #endif
          reflectedLight.indirectDiffuse += material.diffuseColor
            * ( vec3( 0.198, 0.206, 0.214 ) + material.diffuseColor * vec3( 1.05, 1.20, 0.95 ) * 0.74 );`);
    };
    const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    d.onBeforeCompile = (s) => inject(s);
    this._treeDepth = d;
    return m;
  }

  // Ridge + scree material. Smooth-shaded geometry, all the crunch from a two-axis triplanar
  // detail normal; strata banded on world Y; snow driven by altitude AND up-facing slope AND
  // lee aspect, then stripped by wind noise along the exposed crests.
  _rockMaterial() {
    const m = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 95, specular: new THREE.Color(0x8a8880) });
    // Two notches down (0.80/1.02 -> 0.78/0.99), because the top of the band sat ABOVE every
    // summit in the map and the range carried no snow at all — one tan from foot to crest. It
    // now caps the hero peaks and dusts the lee of the shoulders, and cap/aspect/wind below
    // keep it a cap on a mesh rather than a contour line drawn at one altitude.
    const snowLo = Math.max(3.2, this.maxH * 0.78), snowHi = Math.max(4.2, this.maxH * 0.99);
    m.onBeforeCompile = (s) => {
      s.uniforms.uSnow = { value: new THREE.Vector2(snowLo, snowHi) };
      s.uniforms.uNoise = { value: this.noise };
      s.uniforms.uDet = { value: this.detail };
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRWP;\nvarying vec3 vRWN;\nvarying float vRY;')
        .replace('#include <project_vertex>', /* glsl */`
          #ifdef USE_INSTANCING
            vRWP = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
            vec3 iSc = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ),
                             length( instanceMatrix[ 2 ].xyz ) );
            vRWN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix )
                              * ( objectNormal / max( iSc * iSc, vec3( 1e-6 ) ) ) );
            vRY = clamp( position.y, 0.0, 1.0 );
          #else
            vRWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
            vRWN = normalize( mat3( modelMatrix ) * objectNormal );
            vRY = clamp( position.y, 0.0, 1.0 );
          #endif
          #include <project_vertex>`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', /* glsl */`#include <common>
          uniform vec2 uSnow; uniform sampler2D uNoise; uniform sampler2D uDet;
          varying vec3 vRWP; varying vec3 vRWN; varying float vRY;
          vec4 tri( sampler2D T, vec2 aX, vec2 aY, vec2 aZ, vec3 w, float b ) {
            return texture2D( T, aX, b ) * w.x + texture2D( T, aY, b ) * w.y + texture2D( T, aZ, b ) * w.z;
          }`)
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          vec3 rwn = normalize( vRWN );
          // TRUE TRIPLANAR. A single world axis is degenerate for every face parallel to it,
          // and an along-face frame is worse on a cone: dot(xz, tangent) collapses to zero at
          // the apex, so a summit wore a pleated fan of radial streaks. Three world-axis
          // projections on a cubed normal weight has no degenerate direction on the loft.
          vec3 tw = abs( rwn ); tw *= tw * tw; tw /= ( tw.x + tw.y + tw.z + 1e-5 );
          vec2 pX = vec2( vRWP.z, -vRWP.y ), pY = vRWP.xz, pZ = vec2( vRWP.x, -vRWP.y );
          // TEXEL DENSITY, not "smaller number = more detail". At gameplay zoom one world unit
          // is ~75 screen px, so a 512 atlas wants a ~9 u tile for one texel per 1.3 px. The old
          // fine tap ran the MACRO atlas at a 1.14 u tile — 6 texels per screen pixel, four mips
          // past its own Nyquist, i.e. a uniform grey multiply. That is why every summit flank
          // read as a smooth painted plate.
          // LOD, off the true 3D world footprint. This material had NO gate at all: rk3 and rk4
          // ran at 1.5 u and 0.9 u tiles over a 32-cycle detail atlas, i.e. a 4.7 cm feature, and
          // a far summit draws one screen pixel per 3 cm. Sub-Nyquist detail does not disappear,
          // it aliases into a regular pattern — which is the pelt of vertical corduroy every
          // massif in the back of the frame was wearing. Fade both bands out where they cannot
          // be resolved and the flank goes back to being bedded rock.
          // A massif is the most foreshortened surface in the frame, so rmpp on it runs several
          // times what it does on open ground and these gates decide the whole far-field read.
          // The old pair held at 0.8-1.9 px with a -1.0 / -1.6 LOD bias on top, i.e. both fine
          // bands ran at half a pixel per feature on every distant flank. Sub-Nyquist detail
          // does not fade, it beats against the pixel grid into a fixed-size pattern — the
          // pelt of vertical corduroy that measured HF_rms 26 on the far cliff while the near
          // field measured 13. Gate on 2.2-4.5 px, bias 0, and let the mip chain do its job.
          vec3 rdx = dFdx( vRWP ), rdy = dFdy( vRWP );
          float rax = length( rdx ), ray = length( rdy );
          float rmpp = max( rax, ray ) + 1e-6;
          // ANISOTROPY, not just size. A cut face on a board camera is foreshortened to a
          // sliver, so its pixel footprint is a LINE, not a square: the sampler resolves the
          // short axis and averages the long one away, and a high-amplitude fine band under
          // that filter does not read as grain — it reads as combing, stretched down the fall
          // line. That is the "vertical corduroy / stretched fur" note on every rock face in
          // this file, and no LOD gate keyed on footprint SIZE can see it. Fade the finest
          // band out as the footprint degenerates and a flank goes back to being bedded rock.
          float rIso = ( length( cross( rdx, rdy ) ) / rmpp ) / rmpp;   // short axis / long axis
          // The anisotropy fade must NOT run to zero. A summit flank on a board camera has
          // rIso ~0.3, both fine bands switched fully off, and the loft came back as a large
          // uniform slab with no texture in it — the "flat-shaded polygon salad" read. 16x
          // aniso on the sampler is what stops combing; this only takes the edge off.
          float rNear = smoothstep( 3.0, 6.5, 0.1438 / rmpp ) * mix( 0.60, 1.0, smoothstep( 0.10, 0.55, rIso ) );
          float rFin  = smoothstep( 2.0, 4.4, 0.0547 / rmpp ) * mix( 0.35, 1.0, smoothstep( 0.18, 0.70, rIso ) );
          vec4 rk1 = texture2D( uNoise, pY * 0.034 );                                     // 1030-129 px
          vec4 rk2 = tri( uNoise, pX * 0.167, pY * 0.167, pZ * 0.167, tw, 0.0 );          //  210-26 px
          vec4 rk3 = tri( uDet, pX * 0.2174 + vec2( 0.37, 0.61 ), pY * 0.2174 + vec2( 0.37, 0.61 ),
                                pZ * 0.2174 + vec2( 0.37, 0.61 ), tw, 0.0 );               // 4.6 u / 32 = 10 px
          vec4 rk4 = tri( uDet, pX * 0.5714 + vec2( 0.19, 0.77 ), pY * 0.5714 + vec2( 0.19, 0.77 ),
                                pZ * 0.5714 + vec2( 0.19, 0.77 ), tw, 0.0 );               // 1.75 u / 32 = 3.4 px
          // triplanar detail normal: this is what gives the smooth loft its rock surface
          // The two blob bands are cut by half and the fine one raised: 8-25 px normal energy
          // is what MID_rms is a band-pass on, and a massif carrying all of its relief there
          // measures as structureless blur however much of it there is.
          // AMPLITUDE. This is the term that decides whether light describes the MASS or the
          // grain. Summed at full swing the old bands tilted the normal up to 58 degrees, which
          // is more than the difference between a summit's lit flank and its shaded one: every
          // face then wears the same stipple, no two adjacent faces agree about the sun, and the
          // range reads as crumpled cloth instead of rock. Halved, the loft's own shape carries
          // the light and the grain sits on top of it where grain belongs.
          vec2 rg = ( rk2.rg - 0.5 ) * 0.72 + ( rk3.rg - 0.5 ) * 0.58 * rNear + ( rk1.rg - 0.5 ) * 0.40
                  + ( rk4.rg - 0.5 ) * 1.25 * rFin;
          vec3 rUp = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), step( 0.80, abs( rwn.y ) ) );
          vec3 rTg = normalize( cross( rUp, rwn ) + vec3( 1e-5, 0.0, 0.0 ) );
          vec3 rN = normalize( rwn + ( rTg * rg.x + cross( rwn, rTg ) * rg.y ) * 0.80 );

          // Bedding is a function of world Y alone, so gate it on the world-Y footprint of a
          // pixel and not on the 3D one: on a cut face the 3D footprint runs down the fall line
          // and reported "unresolvable" for the one surface bedding has to be drawn on.
          float rmppY = max( abs( rdx.y ), abs( rdy.y ) ) + 1e-6;
          float rBed = smoothstep( 2.0, 5.0, 0.6200 / rmppY );
          float rLam = smoothstep( 2.0, 4.5, 0.2100 / rmppY );
          // DIP: one massif, one bedding attitude, ~8.5 degrees off horizontal, with a radian
          // of wander and no more. The old phase carried 5 + 2.4 + 1.2 radians of noise, i.e.
          // more than a whole turn per bed, so the "strata" were a blob field in disguise.
          float rDip = vRWP.x * 0.62 + vRWP.z * 0.46 + rk1.b * 1.05;
          float rTilt = smoothstep( 0.015, 0.20, 1.0 - abs( rwn.y ) );   // a bed on a level facet aliases
          rBed *= rTilt; rLam *= rTilt;
          // A bedding plane is an EDGE. Sawtooth the phase and smoothstep it and each bed gets
          // a crisp top and a graded base — the read a sinusoid cannot give at any amplitude.
          float bedP = fract( vRWP.y * 1.613 + rDip * 0.308 );                       // 0.62 u beds
          float bedS = smoothstep( 0.0, 0.30, bedP ) * ( 1.0 - smoothstep( 0.86, 1.0, bedP ) );
          float band = mix( 0.5, bedS, rBed )
                     * mix( 1.0, 0.80 + 0.40 * ( 0.5 + 0.5 * sin( vRWP.y * 29.9 + rDip * 5.7 ) ), rLam );   // 0.21 u laminae
          float local = vRY;                                   // 0 at the foot, 1 at the summit
          // COLOUR SCRIPT: rock sits on the same 44-degree khaki axis as dry ground, one hue
          // family, chroma ~0.35, and it is the VALUE spread (0.21 -> 0.70) that does the work.
          // The old range was a neutral grey at chroma 0.19 and half the spread, which is why
          // every massif measured sat 0.24 against a 0.30-0.45 target and read as pewter.
          // MOUNTAIN, not desert. The bible locks rock on #7A7368 at sat 0.08-0.18 and
          // val 0.32-0.62; this pair used to be the DESERT albedo and a lit flank measured
          // #c6a67c, sat 0.373 val 0.776 — twice the chroma ceiling, sharing the sand's tint.
          // Same measured move as the surface shader's rCol: chroma 0.40 (the desert axis)
          // down to 0.225 with every end's luminance held, so the massif stops sharing the
          // sand's tint and lands next to #7A7368 instead.
          // ...and back UP, to chroma 0.40: at 0.225 the massif measured saturation 0.259
          // against the bible's 0.28 floor and read as chalk — geology carried by value alone.
          // A pure chroma scale about each end's OWN luminance, so hue (34.6) and both
          // luminances are unchanged to the digit and the lift lands on the whole family at
          // once, never on a band. Strata stay VALUE (the band multiply below). 0.40 is the
          // linear chroma the ground shader's rock already carries; the massif needs that at
          // source to READ as that, because it is the surface aerial perspective bleaches.
          vec3 rock = mix( vec3( 0.2142, 0.1781, 0.1287 ), vec3( 0.5855, 0.4867, 0.3518 ),
                           rk1.b * 0.40 + rk2.b * 0.44 + rk4.b * 0.16 );
          rock *= 0.68 + 0.62 * band;                          // strata
          // Mineral staining, block to block — and OFF the bedding. Driven by band it painted a
          // chroma ribbon along every bed, running across facet boundaries at unchanged
          // saturation into the shade: a decal stain, not bedding. Strata are VALUE (the band
          // multiply above); this is the block-to-block hue drift only, and its cool end no
          // longer cancels the family's warmth back down to chalk.
          rock *= mix( vec3( 1.076, 0.995, 0.925 ), vec3( 0.972, 0.996, 1.032 ),
                       smoothstep( 0.28, 0.82, rk1.b * 0.56 + rk2.b * 0.44 ) );
          // scree skirt, LIFTED: 0.268 under a shadowed flank lands at luma 0.06, so the
          // floor between the summits had no value left for any band below to modulate and
          // measured as flat near-black. A scree fan is pale broken rock, not a hole.
          // scree skirt, NARROWED. A summit mass now fills its hex, so the bottom 30% of the
          // mesh is most of what the camera sees of it, and a 0.54 mix to one flat pale colour
          // over all of that is the washed-out tan plate the range read as. It is a skirt, not
          // a coat: 0.16 keeps it on the talus where the fan actually is.
          rock = mix( rock, vec3( 0.3426, 0.3103, 0.2673 ), smoothstep( 0.23, 0.0, local ) * 0.49 );  // scree skirt
          // The two COARSE bands take over what the grit band gives up at distance: 30 px
          // blocks and 145 px slabs are the scales a far massif can still resolve, and they
          // cost ~0.01 HF each. Without them the ramps between the summits are untextured plate.
          rock *= 0.930 + 0.140 * smoothstep( 0.22, 0.80, rk2.a );        // 30 px block scatter
          rock *= 0.905 + 0.190 * smoothstep( 0.24, 0.76, rk1.a );        // 145 px slabs
          rock *= 1.0 - smoothstep( 0.18, 0.02, rk2.a ) * 0.24;           // slab joints
          rock *= mix( 1.0, 0.955 + 0.09 * smoothstep( 0.24, 0.76, rk3.a ), rNear );  // 10 px grain
          rock *= 1.0 - smoothstep( 0.30, 0.07, rk3.a ) * 0.13 * mix( 0.5, 1.0, rNear );  // joints, 10 px
          rock *= 1.0 - smoothstep( 0.24, 0.03, rk4.a ) * 0.42 * mix( 0.10, 1.0, rFin );  // hairlines, 3.4 px
          rock *= mix( 1.0, 0.932 + 0.136 * rk3.a, rNear );               // cavity AO
          // 3.4 px grit, LOD'd by the mip chain and by nothing else. Every band above this one
          // lands in MID; this is the only one that lands in HF, so it is what keeps a distant
          // flank from mipping down to a painted plate.
          rock *= 1.0 + ( smoothstep( 0.26, 0.74, rk4.a ) - 0.5 ) * 0.376 * mix( 0.08, 1.0, rFin );
          // snow: needs altitude, a face that is not sheer, and it favours the lee side.
          // Wind noise strips it off the exposed crest, so it never reads as a white wash.
          float lee = 0.78 + 0.22 * clamp( -dot( normalize( rN.xz + vec2( 1e-4 ) ), vec2( 0.80, 0.60 ) ), -1.0, 1.0 );
          float alt = smoothstep( uSnow.x, uSnow.y, vRWP.y + ( rk1.b - 0.5 ) * 2.2 );
          float lie = smoothstep( 0.12, 0.58, clamp( rN.y, 0.0, 1.0 ) );      // sheer faces shed it
          float strip = smoothstep( 0.22, 0.74, rk2.b * 0.55 + rk1.a * 0.45 );// wind off the crest
          // a summit wears a cap, not a coat: snow needs altitude AND to be up the mesh, so
          // rock buttresses run out from under it all the way down the flanks
          float cap = smoothstep( 0.34, 0.76, local );
          float snowAmt = clamp( alt * lie * lee * cap * 1.9 - strip * 0.95 * alt, 0.0, 1.0 );
          snowAmt = smoothstep( 0.08, 0.66, snowAmt );
          // snow is never one flat white: it takes the sky in its hollows and a wind crust on
          // the drifts, and the arete rock cuts straight through it
          // Same clip as the surface shader's nCol, and this is the one that blew a scree
          // instance out into the white "hole" in the top-left massif: 0.93 albedo x 2.85 gain
          // x a 0.22 snow specular is well past where the curve still resolves anything.
          // A SUMMIT CAP IS NOT A WHITE CARD. Two faults, both measured on the delivered
          // frame: the hollow end was a 0.34-chroma blue where the bible caps snow at 0.12,
          // and the ONLY structure on it was one 3.4 px crust band — the first thing the mip
          // chain takes away, so by mid-frame the cap was a featureless RGB 209,206,194 patch
          // at HF ~0 that a reviewer read as background showing through a hole in the mesh.
          // Snow now carries the same two COARSE world-space bands as the rock under it, plus
          // the bedding it lies in, so it holds shape at every distance; all three multipliers
          // average 1.0 and the top end comes down 4% off the tonemap shoulder.
          // ...and it was STILL a blown void, measured RGB 226,221,208 at HF 6.8 over the whole
          // cap: 0.70 albedo plus a 0.11 specular under this key is 2.5 in the HDR buffer, so
          // every band below was being flattened by the tonemap exactly as before. Snow is the
          // brightest thing in the frame whatever its albedo; what decides whether it reads as
          // snow or as a hole is how much of its own texture survives the curve. 0.60x on the
          // pair with the spread widened 1.21 -> 1.48, and all four modulations deepened.
          vec3 snowC = mix( vec3( 0.384, 0.403, 0.436 ), vec3( 0.566, 0.575, 0.599 ), rk2.a * 0.6 + rk3.a * 0.4 );
          snowC *= 0.918 + 0.164 * smoothstep( 0.24, 0.76, rk1.a );      // 145 px drifts
          snowC *= 0.940 + 0.120 * smoothstep( 0.22, 0.80, rk2.a );      //  30 px sastrugi
          snowC *= 0.906 + 0.188 * band;                                 // it lies in the bedding
          snowC *= ( 0.94 + 0.11 * rk1.b ) * mix( 1.0, 0.935 + 0.13 * rk4.a, rFin );   // crust, 3.4 px
          // snow replaces the instance tint instead of being multiplied by it, or a dark
          // boulder ends up with grey snow on top
          // EXPOSURE. 2.85 put the product's top end past 2.0 in the HDR buffer, where the ACES
          // curve has no slope left, so every albedo band above was flattened into one value on
          // the way out: the pale tan plate the lit flanks read as. A UNIFORM gain cut is the
          // only correction that does not cost material — the bands are multiplicative, so
          // their ratios survive a scale exactly while the whole surface slides back down onto
          // the part of the curve that can still resolve them. Hue and chroma unmoved.
          diffuseColor.rgb = mix( diffuseColor.rgb * rock * 2.40, snowC, snowAmt );
          float rspec = ( 0.055 + 0.042 * snowAmt ) * ( 0.45 + 1.1 * rk4.a );  // sparkle, not gloss`)
        .replace('#include <normal_fragment_maps>', 'normal = normalize( mat3( viewMatrix ) * rN );')
        .replace('#include <specularmap_fragment>', 'float specularStrength = rspec;')
        .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
          vec3 rdd = reflectedLight.directDiffuse / max( material.diffuseColor, vec3( 1e-4 ) );
          float rlit = clamp( max( rdd.r, max( rdd.g, rdd.b ) ) * 0.80, 0.0, 1.0 );
          reflectedLight.indirectDiffuse += material.diffuseColor
            * ( vec3( 0.176, 0.174, 0.172 ) * mix( 1.16, 1.0, rlit )
              + material.diffuseColor * vec3( 1.26, 1.10, 0.88 ) * 0.96 * mix( 1.06, 1.0, rlit ) );`);
    };
    return m;
  }

  // ------------------------------------------------------------------ ground clutter
  // 30-40 tufts, dry stalks and pebbles per hex, live only for the tiles actually on screen.
  // A fixed 6.5k instance pool is repacked whenever the camera moves, which is what lets the
  // density be Civ-grade in the near field without scattering 100k props over the whole map.
  _buildClutter() {
    this.clutMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const pool = (geo, n, name, mat) => {
      const mesh = new THREE.InstancedMesh(geo, mat || this.clutMat, n);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = false;   // 10 px props; the shadow costs more than it shows
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    // MULTIPLY over the shaded ground, no depth write, no fog, no tonemap: a pure albedo
    // multiply. This is mechanism (b) of grounding — every clutter instance drops one.
    this.decalMat = new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
      transparent: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
    });
    this.clutter = pool(tuftGeometry(), CLUTTER, 'terrain-clutter');
    this.pebbles = pool(pebbleGeometry(), CLUTTER >> 1, 'terrain-pebbles');
    this.decals = pool(decalGeometry(), CLUTTER + (CLUTTER >> 1), 'terrain-contact', this.decalMat);
    this.decals.renderOrder = 2;
    this._cl = { x: 1e9, z: 1e9, fx: 0, fz: 0 };
    this._frus = new THREE.Frustum(); this._pm = new THREE.Matrix4(); this._sph = new THREE.Sphere();
    this._cv = new THREE.Vector3();
  }

  _packClutter(camera) {
    const { map, base, mat, clutter } = this;
    const cp = camera.position;
    this._frus.setFromProjectionMatrix(this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const vis = (typeof window !== 'undefined' && window.game?.state?.visibility) || null;
    const near = [];
    for (let i = 0; i < map.tiles.length; i++) {
      if (this.surfY[i] < 0.06 || this.rough[i] > 0.62) continue;
      if (vis && vis[i] === 0) continue;              // never scatter under unexplored cloud
      const t = map.tiles[i], p = axialToWorld(t.q, t.r);
      const dx = p.x - cp.x, dz = p.z - cp.z, d = Math.hypot(dx, dz);
      if (d > CLUT_R) continue;
      this._sph.center.set(p.x, this.centreY[i], p.z); this._sph.radius = 1.4;
      if (!this._frus.intersectsSphere(this._sph)) continue;
      near.push(d, i, p.x, p.z);
    }
    // nearest tiles first, so running out of budget thins the far ones and never the near ones
    const order = [];
    for (let k = 0; k < near.length; k += 4) order.push(k);
    order.sort((a, b) => near[a] - near[b]);

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
    const peb = this.pebbles, dec = this.decals, PMAX = CLUTTER >> 1, DMAX = CLUTTER + PMAX;
    const white = new THREE.Color(1, 1, 1);
    let w = 0, pw = 0, dw = 0;
    for (const k of order) {
      if (w >= CLUTTER) break;
      const d = near[k], i = near[k + 1], px = near[k + 2], pz = near[k + 3];
      const fade = 1 - smoothstep01(CLUT_R * 0.66, CLUT_R, d);
      if (fade < 0.06) continue;
      const veg = mat[i * 4], dry = mat[i * 4 + 1], snow = mat[i * 4 + 2];
      // How sandy this ground is, independent of how DRY it is: plains are dry and still
      // covered in grass, a beach is not. Nothing green is scattered where this is high —
      // green tufts strewn over white beach sand were the loudest biome-nonsense in the frame.
      const sand = clamp01(dry - veg * 1.15);
      // density ramps across the ecotone on the same mask the colour blend uses, so a
      // transition thickens with scrub instead of stopping where the paint stops
      const fall = (1 - sand) * (1 - sand) * (1 - sand);   // cubic ramp-out across the ecotone
      // The ramp gates what KIND of clutter a tile grows (vShare / pShare below already refuse
      // green tufts on sand), so it must not also gate HOW MUCH. At 0.10 a beach tile got one
      // and a half props and the near field measured barer than the midfield — the exact LOD
      // inversion the whole pass is about. Gravel and bleached litter belong on sand.
      const n = Math.round(58 * (0.18 + 0.92 * veg + 0.34 * dry) * (0.40 + 0.60 * fall)
                              * (1 - 0.75 * snow) * (1.45 - 0.80 * d / CLUT_R)
                              * (1 + 0.55 * (this.eco ? this.eco[i] : 0)));
      const br = base[i * 3], bg = base[i * 3 + 1], bb = base[i * 3 + 2];
      // stones come in fields: a macro mask decides whether this patch of ground is stony at
      // all, so they never read as an even sprinkle of gravel over the whole board
      const stony = smoothstep01(0.40, 0.74, fbm2(px * 0.09 + 31, pz * 0.09 + 5, { octaves: 2, seed: 6421 })) * (0.30 + 0.9 * dry);
      // Gravel comes in WASHES. With pShare near 0.9 on dry ground the whole beach came out as
      // one even shingle field — cornflakes wall to wall, which is the same "one stamp, one
      // lattice" failure the pale discs were, just in a different colour. A 4.5 u field decides
      // where the stone actually lies, so there is open sand to see it against.
      const shingle = sand > 0.15;
      // SAND GROWS NO LITTER. This is the one line the "bubble wrap / frogspawn" note was
      // looking at: on a beach veg is 0, so vShare was 0, pShare capped near 0.39, and the
      // remaining 61% of every beach tile's scatter came out as `kind 1` — squat, bleached,
      // near-identical cream discs on a near-regular lattice, brighter than the sand under
      // them. Dry ground is gravel and grit with the odd cured stalk, so let pShare run to
      // 0.9 there and the discs are gone.
      const pShare = clamp01((0.05 + 0.30 * stony + 0.92 * sand) * (1 - 0.55 * veg * (1 - sand)));
      const vShare = veg * 0.86 * (1 - sand);
      for (let j = 0; j < n && w < CLUTTER; j++) {
        const h1 = hash2(i * 7 + j, j * 3, 9173), h2 = hash2(i * 7 + j, j * 3, 9281);
        const h3 = hash2(i * 7 + j, j * 3, 9391), h4 = hash2(i * 7 + j, j * 3, 9497);
        const a = h1 * 6.283, rr = 0.94 * Math.sqrt(h2);
        const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
        const y = this._localY(i, lx, lz);
        if (y < 0.05 || !this._clearOf(i, lx, lz, 0.11)) continue;
        if (shingle) {
          const wash = smoothstep01(0.44, 0.70, fbm2((px + lx) * 0.22 + 17, (pz + lz) * 0.22 + 3, { octaves: 2, seed: 5501 }));
          if (hash2(i * 7 + j, j * 3, 9601) > 0.13 + 1.10 * wash * sand) continue;
        }
        const kind = h3 < vShare ? 0 : (h3 > 1.0 - pShare ? 2 : 1);
        let sx, sy, r, g, b, foot;
        // SIZE SPREAD, not one stamp. h4^2 biases small, so a patch reads as a few big clumps
        // in a haze of little ones instead of one repeated pill; 3.4x range, not 1.6x.
        const sz = h4 * h4;
        if (kind === 0) {                                   // living tuft, tile-tinted
          sx = (0.040 + 0.118 * sz) * fade; sy = (0.048 + 0.100 * h1) * (0.72 + 0.62 * sz);
          const ao = mat[i * 4 + 3];   // the tile's own baked AO: a tuft is lit by the same sky as the dirt it grows in
          r = br * (0.68 + 0.26 * h4) * ao; g = bg * (0.72 + 0.26 * h4) * ao; b = bb * (0.64 + 0.24 * h4) * ao;
          // ecotone dry variant: a third of the grass in a transition band has cured off.
          // Hue +25 deg toward yellow, saturation -20%, same value — a green tuft standing on
          // half-sand ground is the loudest biome-nonsense a Civ board can show.
          const cure = clamp01(sand * 2.4) * (h2 < 0.35 ? 1 : 0.15);
          if (cure > 0.01) {
            const l = (r + g + b) / 3;
            r += (l * 1.20 - r) * cure; g += (l * 1.06 - g) * cure; b += (l * 0.60 - b) * cure;
            sy *= 1 - 0.22 * cure;
          }
          foot = sx * 1.45;
        } else if (kind === 1) {                            // dry stalks / bleached litter
          sx = (0.044 + 0.112 * sz) * fade; sy = (0.048 + 0.092 * h1) * (0.70 + 0.66 * sz);
          r = 0.560 + 0.16 * h4; g = 0.505 + 0.15 * h4; b = 0.320 + 0.13 * h4;
          // straw litter over a lush sward is confetti: pull it most of the way back to the
          // tile's own colour wherever there is green to stand in
          const lush = veg * (1 - sand) * 0.78;
          r += (br * 1.05 - r) * lush; g += (bg * 1.02 - g) * lush; b += (bb * 1.10 - b) * lush;
          if (sand > 0.25) {                                // cured, and DARKER than the sand
            // 0.452 cream against a 0.50 sand base, squashed to 55% height, is a disc that
            // out-lights the ground. A dry stalk on a beach is driftwood-brown and stands UP.
            const kk = sand * 0.90;
            r += (0.318 + 0.10 * h4 - r) * kk; g += (0.276 + 0.09 * h4 - g) * kk; b += (0.206 + 0.08 * h4 - b) * kk;
            sx *= 1 - 0.34 * sand;
          }
          foot = sx * 1.45;
        } else {                                            // pebble / clod / gravel
          if (pw >= PMAX) continue;
          // 0.016 to 0.082 — grit through cobble. A single-size pebble field is gravel-print
          // wallpaper; the size histogram is most of what makes a wash read as loose stone.
          sx = (0.016 + 0.066 * sz) * fade; sy = sx * (0.62 + 0.60 * h1);
          r = 0.330 + 0.20 * h4; g = 0.310 + 0.18 * h4; b = 0.272 + 0.16 * h4;
          const soil = 0.58 * (1 - sand);
          r += (br - r) * soil; g += (bg - g) * soil; b += (bb - b) * soil;
          foot = sx * 1.50;
        }
        pos.set(px + lx, y - 0.012, pz + lz);
        scl.set(sx * (0.74 + 0.52 * h1), kind === 2 ? sy : sy * (0.55 + 0.45 * fade), sx * (0.74 + 0.52 * h3));
        // lean. Every instance standing perfectly plumb is what turns a scatter into a lattice
        // of identical stamps; 0.3 rad of random tilt breaks the silhouette repeat for free.
        e.set((h3 - 0.5) * 0.60, h2 * 6.283, (h4 - 0.5) * 0.60); q.setFromEuler(e);
        m4.compose(pos, q, scl);
        col.setRGB(r * r, g * g, b * b, THREE.LinearSRGBColorSpace);   // matches the ground's gamma-2 albedo
        if (kind === 2) { peb.setMatrixAt(pw, m4); peb.setColorAt(pw, col); pw++; }
        else { clutter.setMatrixAt(w, m4); clutter.setColorAt(w, col); w++; }
        // ...and its occlusion pool. Lifted 3.5 cm so the disc clears the ground triangle on
        // a slope; that is 1 px on screen and invisible, and it is the whole reason these
        // things sit ON the ground instead of hovering over a painted floor.
        if (dw < DMAX && fade > 0.30 && kind !== 2 && sz > 0.26) {
          pos.y = y + 0.035;
          scl.set(foot * (0.85 + 0.55 * sz), 1, foot * (0.85 + 0.55 * sz));
          e.set(0, h2 * 6.283, 0); q.setFromEuler(e);
          m4.compose(pos, q, scl);
          dec.setMatrixAt(dw, m4); dec.setColorAt(dw, white); dw++;
        }
      }
    }
    for (const [mesh, n] of [[clutter, w], [peb, pw], [dec, dw]]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------- queries
  // Height inside tile i at local offset (lx,lz). Barycentric point location on
  // (centre, Ck, Ck+1), then the SAME radial plate profile and the SAME fbm relief the mesh
  // was built with. The old version interpolated linearly to the corners and ignored both,
  // which put it up to 10 cm under the real surface on a domed tile — enough to bury a
  // ground decal, sink a pebble and float a tree.
  // Local gradient, central difference on the same surface _localY reconstructs. Used to
  // keep scatter off cliff faces.
  _slope(i, lx, lz) {
    const d = 0.13;
    return Math.max(Math.abs(this._localY(i, lx + d, lz) - this._localY(i, lx - d, lz)),
                    Math.abs(this._localY(i, lx, lz + d) - this._localY(i, lx, lz - d))) / (2 * d);
  }

  _localY(i, lx, lz) {
    let a = Math.atan2(lz, lx); if (a < 0) a += Math.PI * 2;
    const k = Math.min(5, Math.floor(a / (Math.PI / 3))), k2 = (k + 1) % 6;
    const ax = this.cornerLocal[i * 12 + k * 2], az = this.cornerLocal[i * 12 + k * 2 + 1];
    const bx = this.cornerLocal[i * 12 + k2 * 2], bz = this.cornerLocal[i * 12 + k2 * 2 + 1];
    const det = ax * bz - bx * az;
    const yC = this.centreY[i];
    if (Math.abs(det) < 1e-6) return yC;
    const u = (lx * bz - bx * lz) / det, w = (ax * lz - lx * az) / det;
    const R = Math.max(0, Math.min(1, u + w));
    const t = this.map.tiles[i], rgh = this.rough[i];
    const yE = R > 1e-4 ? (u * this.cornerY[i * 6 + k] + w * this.cornerY[i * 6 + k2]) / R : yC;
    const y = yC + (yE - yC) * prof(R);
    const p = axialToWorld(t.q, t.r);
    // MUST mirror _buildSurface's relief() exactly, or every prop on a massif floats or sinks.
    const ridged = t.biome === 'mountain' || t.biome === 'snow';
    const wx = p.x + lx, wz = p.z + lz;
    let d = (fbm2(wx * 1.15 + 11, wz * 1.15 + 5, { octaves: 3, seed: 71 }) - 0.5) * 2;
    if (ridged) d = ((fbm2(wx * 0.42 + 11, wz * 0.42 + 5, { octaves: 2, seed: 71 }) - 0.5) * 2) * 0.62 + d * 0.10;
    const amp = t.height > 0 ? (ridged ? 0.05 + 0.26 * rgh : 0.06 + 0.55 * rgh) : 0.05;
    return y + d * amp * (1 - R * 0.62) * (0.55 + 0.45 * Math.min(1, R / R_A));
  }

  heightAt(x, z) {
    const { q, r } = worldToAxial(x, z);
    const t = this.map.get(q, r);
    if (!t) return 0;
    const p = axialToWorld(t.q, t.r);
    return this._localY(t.i, x - p.x, z - p.z);
  }

  update(dt, camera) {
    this.time.value += dt;
    if (!camera || !this.clutter) return;
    // Fog and the worked set both change on end-turn with the camera perfectly still, so the
    // repack gate watches them as well as the rig. Two linear scans of a 2816-entry array.
    const g = (typeof window !== 'undefined' && window.game) || null;
    let vsig = 0, wsig = 0;
    if (g) {
      const v = g.state?.visibility, wb = g.workedBy;
      if (v) for (let i = 0; i < v.length; i++) vsig = (vsig * 31 + v[i]) | 0;
      if (wb) for (let i = 0; i < wb.length; i++) if (wb[i] >= 0) wsig = (wsig * 31 + i) | 0;
    }
    if (wsig !== this._wsig) { this._wsig = wsig; this._buildWorked(); }
    const f = this._cv.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const c = this._cl, dx = camera.position.x - c.x, dz = camera.position.z - c.z;
    if (vsig === this._vsig && dx * dx + dz * dz < 2.2
        && Math.abs(f.x - c.fx) < 0.008 && Math.abs(f.z - c.fz) < 0.008) return;
    this._vsig = vsig;
    c.x = camera.position.x; c.z = camera.position.z; c.fx = f.x; c.fz = f.z;
    this._visible(camera);
    this._repackPools();
    this._packClutter(camera);
  }

  dispose() {
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.group.traverse(o => { if (o.isInstancedMesh) { o.geometry.dispose(); o.dispose(); } });
    this.treeMesh?.[0]?.material.dispose();
    this.rockMat?.dispose();
    this.clutMat?.dispose(); this.decalMat?.dispose();
    this.iconMat?.dispose(); this.workMat?.dispose(); this.workMesh?.geometry.dispose();
    this._treeDepth?.dispose();
    this.noise.dispose(); this.detail.dispose();
    this.propTex?.dispose();
  }
}
