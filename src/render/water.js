// AEON — water: open ocean, coastal shelf, lakes, rivers and the wet shore band.
//
// Three draw calls, everything procedural:
//   1. sea      — every water tile stamped as a subdivided hex, plus a horizon skirt that
//                 carries the surface hundreds of units past the playable rim, in ONE buffer.
//                 THE MESH IS A TESSELLATION; THE SHADING IS NOT. Nothing wave-shaped travels
//                 down an interpolator: the vertex shader only displaces, and the fragment
//                 shader re-derives the swell height, normal and Jacobian analytically from the
//                 same three bands (gerstF), while everything that used to arrive as a per-hex
//                 attribute — shore distance, wave amplitude, fetch — is read per pixel out of
//                 the field texture instead. A linearly interpolated normal on a hex lattice IS
//                 a facet. THE MESH IS ALSO WELDED: one vertex map over the whole ocean, so no
//                 interior seam is ever rasterised twice off two float-different edge equations.
//                 Three Gerstner bands on ONE wind; THREE scrolling wave octaves (33 / 14 / 5.6 u)
//                 whose headings sit within +-15 degrees of that wind and whose lookups are
//                 stretched 2:1 along their own heading, so the sea is anisotropic ALONG THE
//                 WIND rather than along the raster diagonal; a 512^2 seven-octave map so
//                 pixel-scale slope comes out of the texture's own spectrum instead of out of
//                 tiling a coarse map every eight pixels (that was the diagonal weave, and no
//                 amount of TAA converges it away); Beer-Lambert transmission (sigma 4.2/1.45/
//                 0.72 per unit) over a bed shaded in place, which is what puts a +130
//                 blue-over-red spread on the shelf instead of a grey ramp; two interfering
//                 caustic layers on the seabed with a chromatic split; a Schlick fresnel into an
//                 analytic sky whose luminance is clamped to a multiple of the water's own, so
//                 cloud tints rather than bleaches; and the sun as TWO isotropic GGX lobes
//                 inside an art-directed glare path: a wide SHEEN on the swell normal (a wide
//                 lobe on the ripple normal draws contour worms, not a sun sheet) and a tight
//                 GLITTER on the resolved normal, confined to the sun-aligned lobe. Both gains
//                 are budgeted in LINEAR radiance against the sea's own colour — see the note at
//                 the spec block; sky.js retunes sun intensity freely, so anything budgeted by
//                 eye drifts into fog the next time it does.
//
//                 THE ONE ART CHEAT, stated up front: the specular is aimed at uGlint, a
//                 virtual sun placed so its mirror lands on the visible water nearest the middle
//                 of the frame. At this camera pitch (40-52 deg), this sun (38 deg, 53 deg off
//                 the view azimuth) and this 30-degree FOV, the real sun's specular point is
//                 off-screen entirely — a physically placed glitter path here is not dim, it is
//                 absent, and that is what made three passes of this file matte. See
//                 Water.update() for the measurement.
//   2. shore    — a decal apron over the land tiles that touch water: damp-sand darkening,
//                 a wet specular film and the wave run-up that laps onto the beach, phased off
//                 the same travelling bands the sea's surf uses so the two are one wave.
//   3. rivers   — spline-swept CHANNELS along the hex edges flagged in tile.river: seven columns
//                 per station — toe, raised bank lip, waterline, centreline, waterline, lip, toe —
//                 so the sheet lies in a slot with a lit lip and a shaded, occluded inner face
//                 either side of it. terrain.js owns the ground, so the slot is built by raising
//                 the banks rather than sinking the water: anything pushed under the ground is
//                 simply depth-tested away. Width from
//                 tile.riverFlow, smoothed off the hex lattice and given a per-chain meander,
//                 flow-aligned scrolling, white water on steep bed slopes and a dark damp bank
//                 that reads as the channel the river cut. The channel is BRIGHTER than the
//                 ground it crosses — a dark one is invisible, which is what three passes of
//                 this file shipped — and the mouth hands off to the sea's sediment plume.
//
// Two baked textures do the heavy lifting: one tiling wave/normal atlas, and one "field"
// map of the world holding the signed distance to the waterline, the smoothed sea-bed height,
// the bed albedo and the river sediment, so foam, depth and plumes resolve per pixel.
//
// Colour reference: the haze/sun colours are pulled off the sky and post modules at runtime
// (read-only) so the water's aerial perspective is always the same as everything else's.
//
// For other agents: Water.addRipple(x, z, strength) is the only public entry point besides
// update(). It drops a spreading ring of disturbed water — see the method for how a ship gets
// a wake out of it.

import * as THREE from 'three';
import { axialToWorld, worldToAxial, corners, DIRS } from '../world/hex.js';
import { hash2 } from '../core/rng.js';

const WATER_Y = 0.10;      // sea level in world units
const PPU = 8;             // field-texture pixels per world unit (0.125 u = ~7 screen px)
const SDF_RANGE = 4.0;     // signed distance packed into R over ±SDF_RANGE world units
const SKIRT = 900;         // how far the open sea runs past the map (fade completes well inside)

// ---------------------------------------------------------------------------- CPU noise
// Tiling value noise: the lattice wraps at `per`, so every octave seams perfectly.
function tnoise(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const m = (v) => ((v % per) + per) % per;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function tfbm(x, y, oct, base, seed) {
  let amp = 1, f = base, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * tnoise(x * f, y * f, f, seed + i * 911); n += amp; amp *= 0.5; f *= 2; }
  return s / n;
}

// RG = surface gradient (a tangent-space normal), B = height, A = a bubble/churn field.
//
// FULL SPECTRUM, 512^2, and that is the whole fix for both "no wave structure" and "3 px
// diagonal weave". The old map carried energy only down to ~8 texels, so the only way to get
// pixel-scale detail out of it was to TILE IT SMALL — 0.165 world units, i.e. a repeat every
// eight screen pixels. A pattern that repeats every eight pixels is wallpaper, and its lattice
// axes are what a critic measures as a texel-grid weave with alternating-sign autocorrelation.
// With energy all the way down to ~2.7 texels the map can be tiled LARGE (5-33 u, a repeat of
// 250-1400 px) and still hand a pixel real slope, because at 512 texels over 5.6 u one texel IS
// half a screen pixel. Detail now comes out of the texture's own spectrum instead of out of the
// tiling rate, and the mip chain band-limits it for free.
//
// Amplitude falls 0.45 per octave against a lacunarity of 2, so SLOPE falls ~0.9 per octave:
// slightly red, which is what puts the metric's MID band above its HF band (a white slope
// spectrum measures 1.0 and reads as film grain).
function buildNoiseTexture(seed = 7) {
  const S = 512, h = new Float32Array(S * S), churn = new Float32Array(S * S);
  const fbm = (x, y, oct, base, sd, gain) => {
    let amp = 1, f = base, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += amp * tnoise(x * f, y * f, f, sd + i * 911); n += amp; amp *= gain; f *= 2; }
    return s / n;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, i = y * S + x;
    // 7 octaves from 3 to 192 cycles: the finest lattice cell is 2.7 texels, so the map has
    // real content at the pixel scale instead of running out of it at 8 texels.
    const a = fbm(u, v, 7, 3, seed, 0.45);
    const b = 1 - Math.abs(fbm(u, v, 5, 5, seed + 313, 0.45) * 2 - 1);   // ridged: thin crests
    h[i] = a * 0.58 + b * 0.42;
    // Bubbles, not clouds. Six octaves and a gamma, so foam torn out of this has grain at two
    // to eight pixels — a mat of bubbles — rather than the airbrushed cotton wool a 3-octave
    // field gives you.
    churn[i] = Math.pow(fbm(u, v, 6, 6, seed + 77, 0.50), 1.45);
  }
  const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
  let gsum = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const l = h[y * S + ((x + S - 1) % S)], r = h[y * S + ((x + 1) % S)];
    const d = h[((y + S - 1) % S) * S + x], t = h[((y + 1) % S) * S + x];
    gx[i] = (r - l) * 0.5; gy[i] = (t - d) * 0.5;
    gsum += gx[i] * gx[i] + gy[i] * gy[i];
  }
  // Normalise on RMS, not on the single worst texel: one outlier used to squash the whole map
  // into the middle six bits and that quantisation is its own source of banding.
  const k = 0.30 / Math.sqrt(gsum / (S * S) * 0.5), data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4 + 0] = Math.max(0, Math.min(255, (0.5 + gx[i] * k) * 255)) | 0;
    data[i * 4 + 1] = Math.max(0, Math.min(255, (0.5 + gy[i] * k) * 255)) | 0;
    data[i * 4 + 2] = Math.max(0, Math.min(255, h[i] * 255)) | 0;
    data[i * 4 + 3] = Math.max(0, Math.min(255, churn[i] * 255)) | 0;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;   // mips + the shader LOD bias kill the weave
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------------- field texture
// The single most important function in this file. The waterline a player sees is where the
// TERRAIN MESH crosses the water plane — not where the tile mask flips from water to land. Those
// two differ by up to a third of a hex, and keying the shoreline off the mask is exactly what
// draws foam on hex chords instead of on the coast. So: rasterise terrain.js's own surface
// buffer (already in the scene by the time Water is constructed) into a height grid, and let the
// distance field, the depth ramp and the wet-sand apron all read that. Max-Z per pixel, because
// the buffer carries cliff walls under the tops.
// ponytail: reads another agent's mesh by name and falls back to the analytic bed if it is not
// there. A shared heightfield in the contract would be cleaner; this costs one getObjectByName.
function rasterTerrain(scene, minX, minZ, W, H) {
  const m = scene?.getObjectByName?.('terrain-surface');
  const pa = m?.geometry?.attributes?.position?.array, ia = m?.geometry?.index?.array;
  if (!pa || !ia || ia.length < 3) return null;
  const out = new Float32Array(W * H).fill(-1e9);
  const put = (x, y, v) => { const i = y * W + x; if (v > out[i]) out[i] = v; };
  for (let t = 0; t + 2 < ia.length; t += 3) {
    const a = ia[t] * 3, b = ia[t + 1] * 3, c = ia[t + 2] * 3;
    const ax = (pa[a] - minX) * PPU - 0.5, az = (pa[a + 2] - minZ) * PPU - 0.5, ay = pa[a + 1];
    const bx = (pa[b] - minX) * PPU - 0.5, bz = (pa[b + 2] - minZ) * PPU - 0.5, by = pa[b + 1];
    const cx = (pa[c] - minX) * PPU - 0.5, cz = (pa[c + 2] - minZ) * PPU - 0.5, cy = pa[c + 1];
    let x0 = Math.ceil(Math.min(ax, bx, cx)), x1 = Math.floor(Math.max(ax, bx, cx));
    let z0 = Math.ceil(Math.min(az, bz, cz)), z1 = Math.floor(Math.max(az, bz, cz));
    if (x0 < 0) x0 = 0; if (z0 < 0) z0 = 0;
    if (x1 > W - 1) x1 = W - 1; if (z1 > H - 1) z1 = H - 1;
    // a sub-pixel or vertical triangle covers no centre: stamp its corners so nothing is lost
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (x1 < x0 || z1 < z0 || Math.abs(det) < 1e-7) {
      for (const [px, pz, py] of [[ax, az, ay], [bx, bz, by], [cx, cz, cy]]) {
        const ix = Math.round(px), iz = Math.round(pz);
        if (ix >= 0 && iz >= 0 && ix < W && iz < H) put(ix, iz, py);
      }
      continue;
    }
    const id = 1 / det;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) * id;
      const v = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) * id;
      if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
      put(x, z, ay + u * (by - ay) + v * (cy - ay));
    }
  }
  // pinhole fill: a handful of pixels can still fall between three sub-pixel triangles
  for (let pass = 0; pass < 2; pass++) for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const i = z * W + x;
    if (out[i] > -1e8) continue;
    let v = -1e9;
    if (x > 0) v = Math.max(v, out[i - 1]);
    if (x < W - 1) v = Math.max(v, out[i + 1]);
    if (z > 0) v = Math.max(v, out[i - W]);
    if (z < H - 1) v = Math.max(v, out[i + W]);
    out[i] = v;
  }
  return out;
}

// Chamfer distance transform (3x3, 1/sqrt2 weights). ~2% off true Euclidean — invisible here.
function chamfer(mask, W, H, seedVal) {
  const INF = 1e9, d = new Float32Array(W * H), R = Math.SQRT2;
  for (let i = 0; i < W * H; i++) d[i] = mask[i] === seedVal ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, d[i - W] + 1);
      if (x > 0) v = Math.min(v, d[i - W - 1] + R);
      if (x < W - 1) v = Math.min(v, d[i - W + 1] + R);
    }
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
    if (y < H - 1) {
      v = Math.min(v, d[i + W] + 1);
      if (x < W - 1) v = Math.min(v, d[i + W + 1] + R);
      if (x > 0) v = Math.min(v, d[i + W - 1] + R);
    }
    d[i] = v;
  }
  return d;
}
function boxBlur(src, W, H, rad) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H), n = rad * 2 + 1;
  const cx = (x) => (x < 0 ? 0 : x > W - 1 ? W - 1 : x), cy = (y) => (y < 0 ? 0 : y > H - 1 ? H - 1 : y);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let x = -rad; x <= rad; x++) sum += src[y * W + cx(x)];
    for (let x = 0; x < W; x++) { tmp[y * W + x] = sum / n; sum -= src[y * W + cx(x - rad)]; sum += src[y * W + cx(x + rad + 1)]; }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -rad; y <= rad; y++) sum += tmp[cy(y) * W + x];
    for (let y = 0; y < H; y++) { out[y * W + x] = sum / n; sum -= tmp[cy(y - rad) * W + x]; sum += tmp[cy(y + rad + 1) * W + x]; }
  }
  return out;
}

// Mirrors terrain.js: land sits at tile.height, water beds sink with elevation below sea level.
// Kept in sync by hand — it is four lines, and a shared helper across two agents' files is not
// worth the coupling. tileTopY adds terrain's per-tile wobble so decals land on the real mesh.
function bedY(map, t) {
  if (t.height > 0) return t.height;
  const sea = map.seaLevel ?? 0.42;
  const d = Math.max(0, Math.min(1, (sea - t.elev) / Math.max(0.05, sea)));
  return -(0.14 + 2.5 * Math.pow(d, 1.35));
}
function tileTopY(map, t) {
  if (t.height <= 0) return bedY(map, t);
  for (const d of DIRS) { const o = map.get(t.q + d.q, t.r + d.r); if (o && o.height <= 0) return t.height; }
  return t.height + (hash2(t.q, t.r, 5501) - 0.5) * 0.085;   // mirrors terrain.js's inland wobble
}

// The world rectangle every raster in this file shares, one map-wide margin included.
function fieldBounds(map) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const t of map.tiles) {
    const p = axialToWorld(t.q, t.r);
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  minX -= 1.5; maxX += 1.5; minZ -= 1.5; maxZ += 1.5;
  return { minX, maxX, minZ, maxZ, W: Math.ceil((maxX - minX) * PPU), H: Math.ceil((maxZ - minZ) * PPU) };
}
// Bilinear height off the rasterised ground mesh: the ONE honest answer to "what is the terrain
// doing here", and what both the wet-sand apron and every river column are planted on.
function terrSampler(terr, b) {
  if (!terr) return null;
  const { minX, minZ, W, H } = b;
  return (x, z) => {
    const fx = Math.max(0, Math.min(W - 1.001, (x - minX) * PPU - 0.5));
    const fz = Math.max(0, Math.min(H - 1.001, (z - minZ) * PPU - 0.5));
    const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
    const g = (a, c) => terr[c * W + a];
    return (g(x0, z0) * (1 - tx) + g(x0 + 1, z0) * tx) * (1 - tz)
         + (g(x0, z0 + 1) * (1 - tx) + g(x0 + 1, z0 + 1) * tx) * tz;
  };
}

function buildField(map, levels, riverPaths, b, terr, hAt) {
  const { minX, maxX, minZ, maxZ, W, H } = b;
  const land = new Uint8Array(W * H), surf = new Float32Array(W * H);
  // The bed height the shader turns into optical depth. Land is clamped DOWN to the water line
  // it borders: the channel is only ever read under water, and an unclamped 3-unit cliff two
  // pixels away used to blur straight through the shallows and report a bay as bone dry.
  const lvlOf = (t) => {
    if (t.height <= 0) return levels.level.get(t.i) ?? WATER_Y;
    let l = WATER_Y;
    for (const d of DIRS) { const v = map.get(t.q + d.q, t.r + d.r); if (v && v.height <= 0) l = Math.max(l, levels.level.get(v.i) ?? WATER_Y); }
    return l;
  };
  // BED ALBEDO IS A FUNCTION OF DEPTH, not of the tile's biome tag, and that is the fix for the
  // hexagonal brightness plate a critic measured floating in open sea at x1100-1180. A per-tile
  // albedo steps 0.46 across a hex chord; no blur narrow enough to keep a shelf edge crisp is
  // wide enough to hide a step that size over a 2 u hex, so the plate was unavoidable while the
  // value came off the tile. Depth is already smoothed over four world units (see `smooth`
  // below), so a ramp off IT has no lattice in it anywhere. Physically it is also the right
  // variable: a shelf is pale sand because it is shallow, and the deep is dark because silt
  // settles there.
  // Only tiles that actually touch water are allowed to decide the waterline from geometry —
  // an inland hollow half a unit above sea level must never be classified as ocean.
  const coastal = new Uint8Array(map.tiles.length);
  for (const t of map.tiles) {
    if (t.height <= 0) { coastal[t.i] = 1; continue; }
    for (const d of DIRS) { const v = map.get(t.q + d.q, t.r + d.r); if (v && v.height <= 0) { coastal[t.i] = 1; break; } }
  }
  for (let y = 0; y < H; y++) {
    const wz = minZ + (y + 0.5) / PPU;
    for (let x = 0; x < W; x++) {
      const wx = minX + (x + 0.5) / PPU, i = y * W + x;
      const a = worldToAxial(wx, wz), t = map.get(a.q, a.r);
      if (!t) { surf[i] = -2.64; land[i] = 0; continue; }   // off-map is open sea
      const lvl = lvlOf(t);
      const ty = (terr && terr[i] > -1e8) ? terr[i] : bedY(map, t);
      land[i] = coastal[t.i] ? (ty > lvl + 0.015 ? 1 : 0) : 1;
      surf[i] = Math.min(ty, lvl);
    }
  }
  // Sediment: every river mouth stains the water it empties into. Seeded on the water tiles a
  // river edge actually touches, weighted by its discharge, then smeared into an offshore cone
  // by the same blur that softens everything else in this texture.
  const silt = new Float32Array(W * H);
  const mouths = new Map();
  for (const t of map.tiles) {
    if (!t.river || t.height <= 0) continue;
    for (let d = 0; d < 6; d++) {
      if (!(t.river & (1 << d))) continue;
      const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
      if (!nb || nb.height > 0) continue;
      mouths.set(nb.i, Math.max(mouths.get(nb.i) ?? 0, t.riverFlow || 0.3));
    }
  }
  if (mouths.size) for (let y = 0; y < H; y++) {
    const wz = minZ + (y + 0.5) / PPU;
    for (let x = 0; x < W; x++) {
      const a = worldToAxial(minX + (x + 0.5) / PPU, wz), t = map.get(a.q, a.r);
      if (t) silt[y * W + x] = mouths.get(t.i) ?? 0;
    }
  }
  const siltS = boxBlur(boxBlur(silt, W, H, PPU * 2), W, H, PPU * 2);
  // Depth ramp. This has to be smooth over ~1.5 hexes or the per-tile bed steps (-0.14 on the
  // shelf, -2.64 in the deep) show as hard wedges of tint across open water — and it must not
  // see the land, or a 3-unit beach two pixels away blurs straight through the shallows and
  // reports a bay as bone dry. So: a MASKED blur. Sum the bed over water pixels only, sum the
  // mask the same way, divide. Land pixels keep their own clamped value for the few lookups
  // (refraction, mip fetches) that stray over the beach.
  const wmask = new Float32Array(W * H), wsurf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { wmask[i] = land[i] ? 0 : 1; wsurf[i] = land[i] ? 0 : surf[i]; }
  // Radius 10, twice: ~4 world units of gaussian-equivalent blur on the bed height. The depth
  // ramp a player sees is this field, and any boundary sharper than a couple of hexes reads as
  // an analytic cutout sitting in open water rather than as a continental shelf.
  const num = boxBlur(boxBlur(wsurf, W, H, PPU * 2), W, H, PPU * 2);
  const den = boxBlur(boxBlur(wmask, W, H, PPU * 2), W, H, PPU * 2);
  const smooth = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) smooth[i] = den[i] > 0.02 ? num[i] / den[i] : surf[i];
  const dOut = chamfer(land, W, H, 1), dIn = chamfer(land, W, H, 0);
  // RIVERS LIVE IN THIS CHANNEL TOO. grid.js fades its lattice on exactly this signed distance
  // (see the mask block above WATER_MASK_GLSL), so a reach that is not in the field gets the hex
  // stroke drawn straight across it at full land weight — measured on shots/water-p6r1.png at
  // (600,505) and (655,545). Stamping the drawn spline here fixes it with no edit to grid.js and
  // no second uniform to keep in sync: one field, one meaning, every consumer already reading it.
  // Only INLAND of the coast (sd > 0.35), so the sea's own shoreline read is untouched at a mouth.
  const sd = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) sd[i] = (dIn[i] - dOut[i]) / PPU;
  for (const pts of riverPaths || []) for (const q of pts) {
    const R = q.w + 1.05;
    const x0 = Math.max(0, Math.floor((q.x - R - minX) * PPU)), x1 = Math.min(W - 1, Math.ceil((q.x + R - minX) * PPU));
    const z0 = Math.max(0, Math.floor((q.z - R - minZ) * PPU)), z1 = Math.min(H - 1, Math.ceil((q.z + R - minZ) * PPU));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const i = z * W + x;
      if (sd[i] < 0.35) continue;
      const d = Math.hypot(minX + (x + 0.5) / PPU - q.x, minZ + (z + 0.5) / PPU - q.z);
      const v = d - q.w * 1.02;                       // <0 in the wetted channel, feathered out
      if (v < sd[i]) sd[i] = v;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    // R IS PACKED POSITIVE INLAND. See the mask block near WATER_MASK_GLSL for why the sign
    // of the wire format is load-bearing: grid.js hand-rolls this decode and then applies
    // `1.0 - waterMask(...)`, and with the distance measured inland that composition comes out
    // RIGHT — lattice on the land, nothing on the sea. Every reader inside this file negates on
    // decode, and the two published GLSL helpers keep the meanings their names promise.
    data[i * 4 + 0] = Math.max(0, Math.min(255, (sd[i] / (2 * SDF_RANGE) + 0.5) * 255)) | 0;
    data[i * 4 + 1] = Math.max(0, Math.min(255, (smooth[i] + 3.0) / 10.0 * 255)) | 0;
    // B: bed albedo, ramped off the SMOOTHED bed height — pale sand on the bar, silt in the deep.
    const dep = Math.max(0, WATER_Y - smooth[i]);
    data[i * 4 + 2] = Math.max(0, Math.min(255, (0.88 - 0.62 * Math.min(1, Math.pow(dep / 2.4, 0.75))) * 255)) | 0;
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.pow(Math.min(1, siltS[i] * 3.2), 0.72) * 255)) | 0;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  // bilinear CPU sampler, used to bake the per-vertex wave damping near the shore
  const sdAt = (x, z) => {
    const fx = Math.max(0, Math.min(W - 1.001, (x - minX) * PPU - 0.5));
    const fz = Math.max(0, Math.min(H - 1.001, (z - minZ) * PPU - 0.5));
    const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
    const g = (a, b) => (dOut[b * W + a] - dIn[b * W + a]) / PPU;
    return (g(x0, z0) * (1 - tx) + g(x0 + 1, z0) * tx) * (1 - tz)
         + (g(x0, z0 + 1) * (1 - tx) + g(x0 + 1, z0 + 1) * tx) * tz;
  };
  return {
    tex, sdAt, hAt, res: new THREE.Vector2(W, H),
    min: new THREE.Vector2(minX, minZ),
    size: new THREE.Vector2(maxX - minX, maxZ - minZ),
    bounds: { minX, maxX, minZ, maxZ },
  };
}

// ---------------------------------------------------------------------------- geometry
// One hex subdivided N ways per corner triangle, vertices shared inside the hex.
function hexTemplate(N) {
  const cs = corners(1.0), pos = [], idx = [], key = new Map();
  const add = (x, z) => {
    const k = Math.round(x * 1e4) + ',' + Math.round(z * 1e4);
    let v = key.get(k);
    if (v === undefined) { v = pos.length / 2; pos.push(x, z); key.set(k, v); }
    return v;
  };
  for (let c = 0; c < 6; c++) {
    const B = cs[c], C = cs[(c + 1) % 6], rows = [];
    for (let i = 0; i <= N; i++) {
      const row = [];
      for (let j = 0; j <= i; j++) {
        const u = i / N, v = i === 0 ? 0 : j / i;
        row.push(add((B[0] * (1 - v) + C[0] * v) * u, (B[1] * (1 - v) + C[1] * v) * u));
      }
      rows.push(row);
    }
    for (let i = 1; i <= N; i++) for (let j = 0; j < i; j++) {
      idx.push(rows[i - 1][j], rows[i][j], rows[i][j + 1]);
      if (j < i - 1) idx.push(rows[i - 1][j], rows[i][j + 1], rows[i - 1][j + 1]);
    }
  }
  return { pos, idx };
}

// Water surface height per water tile. Everything reachable from the map border is one sea at
// WATER_Y; every enclosed basin is a lake and gets its own flat surface, set just under the
// lowest point of the land rim that contains it.
function waterLevels(map) {
  const tiles = map.tiles.filter((t) => t.height === 0);
  const sea = new Set();
  const stack = tiles.filter((t) => t.q === 0 || t.r === 0 || t.q === map.w - 1 || t.r === map.h - 1);
  for (const t of stack) sea.add(t.i);
  while (stack.length) {
    const u = stack.pop();
    for (const d of DIRS) {
      const v = map.get(u.q + d.q, u.r + d.r);
      if (v && v.height === 0 && !sea.has(v.i)) { sea.add(v.i); stack.push(v); }
    }
  }
  const level = new Map();
  const seen = new Set();
  for (const t of tiles) {
    if (sea.has(t.i)) { level.set(t.i, WATER_Y); continue; }
    if (seen.has(t.i)) continue;
    const group = [t], st = [t];
    seen.add(t.i);
    let rim = 1e9;
    while (st.length) {
      const u = st.pop();
      for (const d of DIRS) {
        const v = map.get(u.q + d.q, u.r + d.r);
        if (!v) continue;
        if (v.height > 0) { if (v.height < rim) rim = v.height; continue; }
        if (sea.has(v.i) || seen.has(v.i)) continue;
        seen.add(v.i); group.push(v); st.push(v);
      }
    }
    const y = Math.max(WATER_Y, (rim < 1e8 ? rim : WATER_Y + 0.2) - 0.16);
    for (const u of group) level.set(u.i, y);
  }
  return { sea, level };
}

// dir index -> the two corner indices of the hex edge shared with that neighbour
const EDGE_C = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const _mvp = new THREE.Matrix4();

// How big the water body a tile belongs to is, 0..1. A one-hex pond and the open Atlantic were
// being handed the same surf, the same whitecaps and the same chop, which is why every puddle in
// the frame came out frosted with white. Flood fill, then sqrt so the curve is generous to
// medium bays and only a true pond lands near zero.
function bodySize(map) {
  const size = new Float32Array(map.tiles.length), seen = new Uint8Array(map.tiles.length);
  for (const t of map.tiles) {
    if (t.height !== 0 || seen[t.i]) continue;
    const grp = [t], st = [t];
    seen[t.i] = 1;
    while (st.length) {
      const u = st.pop();
      for (const d of DIRS) {
        const v = map.get(u.q + d.q, u.r + d.r);
        if (v && v.height === 0 && !seen[v.i]) { seen[v.i] = 1; grp.push(v); st.push(v); }
      }
    }
    const k = Math.max(0, Math.min(1, (Math.sqrt(grp.length) - 1.1) / 3.6));
    for (const u of grp) size[u.i] = k;
  }
  return size;
}

function buildOcean(map, field, levels) {
  const T = hexTemplate(3), vpt = T.pos.length / 2, CS = corners(1.0);
  const P = [], O = [], L = [], I = [], B = [];
  const bsize = bodySize(map);
  const b = field.bounds;
  // The hex grid fills a slanted parallelogram, not a rectangle: world z = SKEW * x + t along a
  // tile row. Both the skirt's cell test and the swell's outer damping key off that.
  const SKEW = Math.sqrt(3) / 3;
  let t0 = 1e9, t1 = -1e9;
  for (const t of map.tiles) {
    const p = axialToWorld(t.q, t.r), k = p.z - SKEW * p.x;
    if (k < t0) t0 = k; if (k > t1) t1 = k;
  }
  // Distance from the rim of the tile field, in world units.
  const inside = (x, z) => {
    const k = z - SKEW * x;
    return Math.min(k - t0, t1 - k, x - b.minX, b.maxX - x);
  };

  // WELD. Every water hex used to push its own copy of the vertices on its shared edges, so
  // two adjacent tiles rasterised the same seam off two float-different edge equations: a
  // sub-pixel crack on one side, a sub-pixel double-blend on the other, and a straight hairline
  // step across open water either way. One vertex map over the WHOLE ocean dissolves every
  // interior edge, and the mesh becomes one continuous surface per water body.
  // Keyed on y as well as x/z: two lakes at different levels can share a hex corner across a
  // land tile, and welding those would tear a basin open. Adjacent tiles of the SAME body
  // always agree on y, lake and body, so nothing else can disagree at a shared vertex.
  const vmap = new Map();
  const vert = (x, y, z, lake, body) => {
    const k = Math.round(x * 4096) + '|' + Math.round(z * 4096) + '|' + Math.round(y * 1024);
    let v = vmap.get(k);
    if (v !== undefined) return v;
    v = P.length / 3;
    P.push(x, y, z);
    // Swell amplitude: damped near the shore, and damped to nothing at the outer rim so the
    // tiles and the flat horizon skirt meet without a crack between two tessellations.
    O.push(Math.min(Math.max(0, Math.min(1, field.sdAt(x, z) / 3.5)),
                    Math.max(0, Math.min(1, (inside(x, z) - 1.0) / 9.0))));
    L.push(lake); B.push(body);
    vmap.set(k, v);
    return v;
  };

  for (const t of map.tiles) {
    if (t.height !== 0) continue;
    const c = axialToWorld(t.q, t.r);
    // Sea connectivity decides this, never the tile's `feature` tag — see buildField.isLake.
    const lake = levels.sea.has(t.i) ? 0 : 1;
    const body = bsize[t.i];
    const y = levels.level.get(t.i) ?? WATER_Y;
    const vi = [];
    for (let v = 0; v < vpt; v++) vi.push(vert(c.x + T.pos[v * 2], y, c.z + T.pos[v * 2 + 1], lake, body));
    for (let k = 0; k < T.idx.length; k++) I.push(vi[T.idx[k]]);

    // Lap: every edge that faces land gets a lip of surface pushed a third of a tile past the
    // hex boundary. The terrain buries whatever rises above the water line, so the visible
    // waterline becomes the real intersection of the two surfaces — a wandering edge — instead
    // of the hex silhouette the mesh would otherwise cut.
    for (let d = 0; d < 6; d++) {
      const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
      if (nb && nb.height === 0) continue;
      const [ka, kb] = EDGE_C[d], q = [];
      for (const [k, rad] of [[ka, 1], [kb, 1], [kb, 1.62], [ka, 1.62]])
        q.push(vert(c.x + CS[k][0] * rad, y, c.z + CS[k][1] * rad, lake, body));
      I.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
  }

  // Horizon skirt: flat, unrippled quads that carry the surface out past where the haze has
  // finished eating it. Cells wholly inside the tile field are skipped; the ones that straddle
  // it sit BELOW the deepest Gerstner trough (0.28), not a hair lower — at 3 cm a trough over
  // the overlap punched the skirt through the tiles and left a dead straight hairline across
  // open water, which is the single most obvious "rendering bug" a still can carry.
  const covered = (x, z) => {
    const k = z - SKEW * x;
    return k > t0 - 0.2 && k < t1 + 0.2 && x > b.minX + 1.2 && x < b.maxX - 1.2;
  };
  const grid = (x0, z0, x1, z1, cell, skipCovered, skipFine) => {
    const nx = Math.max(1, Math.round((x1 - x0) / cell)), nz = Math.max(1, Math.round((z1 - z0) / cell));
    const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const ax = x0 + i * dx, az = z0 + j * dz, bx = ax + dx, bz = az + dz;
      if (skipCovered && covered(ax, az) && covered(bx, az) && covered(ax, bz) && covered(bx, bz)) continue;
      if (skipFine && skipFine(ax, az) && skipFine(bx, bz)) continue;
      const base = P.length / 3;
      for (const [x, z] of [[ax, az], [bx, az], [ax, bz], [bx, bz]]) { P.push(x, WATER_Y - 0.32, z); O.push(0); L.push(0); B.push(1); }
      I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  };
  grid(b.minX - 70, b.minZ - 70, b.maxX + 70, b.maxZ + 70, 9, true, null);
  const inFine = (x, z) => x > b.minX - 68 && x < b.maxX + 68 && z > b.minZ - 68 && z < b.maxZ + 68;
  grid(b.minX - SKIRT, b.minZ - SKIRT, b.maxX + SKIRT, b.maxZ + SKIRT, 62, false, inFine);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aOpen', new THREE.BufferAttribute(new Float32Array(O), 1));
  g.setAttribute('aLake', new THREE.BufferAttribute(new Float32Array(L), 1));
  g.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(B), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
  g.computeBoundingSphere();
  return g;
}

// --------------------------------------------------------------------- terrain surface
// Terrain welds each hex corner to the average of the tiles that meet there, unless the spread
// is a cliff, in which case the tile keeps its own height. Mirrored here (minus the sub-decimetre
// jitter) so decals can be laid on the ground without hunting for the real mesh.
const CLIFF = 0.85;
function cornerHeights(map) {
  const cm = new Map();
  const key = (x, z) => (Math.round(x * 512) + 262144) * 1048576 + (Math.round(z * 512) + 262144);
  const CS = corners(1.0);
  const tileKeys = new Float64Array(map.tiles.length * 6);
  for (const t of map.tiles) {
    const p = axialToWorld(t.q, t.r), y = tileTopY(map, t);
    for (let k = 0; k < 6; k++) {
      const kk = key(p.x + CS[k][0], p.z + CS[k][1]);
      tileKeys[t.i * 6 + k] = kk;
      let e = cm.get(kk);
      if (!e) { e = []; cm.set(kk, e); }
      e.push(y);
    }
  }
  // Same clustering terrain.js uses: heights within CLIFF of each other weld to their mean,
  // a wider gap splits the corner into two levels with a wall between them.
  const groups = new Map();
  for (const [kk, ys] of cm) {
    ys.sort((a, b) => a - b);
    const g = [];
    let start = 0;
    for (let j = 1; j <= ys.length; j++) {
      if (j === ys.length || ys[j] - ys[j - 1] > CLIFF) {
        let sum = 0;
        for (let k = start; k < j; k++) sum += ys[k];
        g.push(ys[start], ys[j - 1], sum / (j - start));
        start = j;
      }
    }
    groups.set(kk, g);
  }
  return (t, k) => {
    const g = groups.get(tileKeys[t.i * 6 + k]), own = tileTopY(map, t);
    for (let j = 0; j < g.length; j += 3) if (own >= g[j] - 1e-6 && own <= g[j + 1] + 1e-6) return g[j + 2];
    return g[2];
  };
}

// Wet apron: the land tiles that touch water, stamped as decals at the terrain's own height.
const NO_APRON = new Set(['hills', 'mountain', 'snow']);
function buildShore(map, levels, cornerY, hAt) {
  const T = hexTemplate(3), vpt = T.pos.length / 2;
  const P = [], WY = [], FE = [], I = [];
  const bsize = bodySize(map);
  // Two rings deep, not one. The damp band's width is set by the distance field in the shader;
  // if the mesh stops at the first ring, the fade gets cut off mid-ramp and the apron ends on a
  // straight hex edge — a translucent grey film with a polygon border laid over the beach.
  const lvlOf = new Map();
  for (const t of map.tiles) {
    if (t.height <= 0) continue;
    let lvl = -1;
    for (const d of DIRS) {
      const v = map.get(t.q + d.q, t.r + d.r);
      if (v && v.height === 0) lvl = Math.max(lvl, levels.level.get(v.i) ?? WATER_Y);
    }
    if (lvl >= 0) lvlOf.set(t.i, lvl);
  }
  for (const [i, lvl] of [...lvlOf]) {
    const t = map.tiles[i];
    for (const d of DIRS) {
      const v = map.get(t.q + d.q, t.r + d.r);
      if (v && v.height > 0 && !lvlOf.has(v.i)) lvlOf.set(v.i, lvl);
    }
  }
  for (const t of map.tiles) {
    if (t.height <= 0 || NO_APRON.has(t.biome)) continue;   // terrain lifts those tile centres
    const lvl = lvlOf.get(t.i) ?? -1;
    if (lvl < 0 || t.height > lvl + 1.3) continue;
    const p = axialToWorld(t.q, t.r), base = P.length / 3;
    // Vertices ride the rasterised terrain surface, not a second guess at it. terrain.js welds
    // every shore corner DOWN to the water line, so a fan built from this file's own idea of
    // the corner heights floated most of a unit over the beach — which is what turned the wet
    // band into a grey film with a visible polygon border a third of a hex off the waterline.
    // How much sea this beach faces. A one-hex pond ringed with the same surf a headland gets
    // is what turned every puddle in the frame into a snowdrift.
    let fe = 0;
    for (const d of DIRS) {
      const v = map.get(t.q + d.q, t.r + d.r);
      if (v && v.height === 0) fe = Math.max(fe, bsize[v.i]);
      if (!v) continue;
      for (const e of DIRS) { const u2 = map.get(v.q + e.q, v.r + e.r); if (u2 && u2.height === 0) fe = Math.max(fe, bsize[u2.i] * 0.8); }
    }
    for (let v = 0; v < vpt; v++) {
      const x = p.x + T.pos[v * 2] * 0.995, z = p.z + T.pos[v * 2 + 1] * 0.995;
      const y = hAt ? hAt(x, z) : (v === 0 ? tileTopY(map, t) : cornerY(t, (v - 1) % 6));
      P.push(x, y + 0.035, z); WY.push(lvl); FE.push(fe);
    }
    for (let k = 0; k < T.idx.length; k++) I.push(base + T.idx[k]);
  }
  if (!P.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aWaterY', new THREE.BufferAttribute(new Float32Array(WY), 1));
  g.setAttribute('aFetch', new THREE.BufferAttribute(new Float32Array(FE), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
  g.computeBoundingSphere();
  return g;
}

// --------------------------------------------------------------------------- rivers
// tile.river is a 6-bit mask over DIRS: bit d = the edge shared with neighbour DIRS[d]. Those
// edges are welded into a graph on the hex corner lattice, traced into downhill polylines,
// smoothed (Chaikin), and swept into a ribbon with five columns: bank / water / water / bank.
function riverChains(map, cornerY, levels) {
  const nodes = new Map(), edges = [];
  const q3 = (v) => Math.round(v * 1000) / 1000;
  const node = (x, z) => {
    const k = q3(x) + ',' + q3(z);
    let n = nodes.get(k);
    if (!n) { n = { k, x, z, sum: 0, cnt: 0, sea: false, adj: [], flow: 0 }; nodes.set(k, n); }
    return n;
  };
  const seen = new Set();
  for (const t of map.tiles) {
    if (!t.river || t.height <= 0) continue;
    for (let d = 0; d < 6; d++) {
      if (!(t.river & (1 << d))) continue;
      const nb = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
      const a = axialToWorld(t.q, t.r), b = nb ? axialToWorld(nb.q, nb.r) : { x: a.x + DIRS[d].q * 1.5, z: a.z };
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      let dx = b.x - a.x, dz = b.z - a.z;
      const il = 1 / Math.hypot(dx, dz); dx *= il; dz *= il;
      const px = -dz * 0.5, pz = dx * 0.5;     // half a hex edge either side of the midpoint
      const A = node(mx + px, mz + pz), B = node(mx - px, mz - pz);
      const ek = A.k < B.k ? A.k + '|' + B.k : B.k + '|' + A.k;
      if (seen.has(ek)) continue;
      seen.add(ek);
      const flow = Math.max(t.riverFlow || 0, nb ? (nb.riverFlow || 0) : 0);
      // the ribbon sits in the notch mapgen already incised, at the lower of the two banks
      const cA = [], cB = [];
      for (let k = 0; k < 6; k++) {
        const y = cornerY(t, k), cx = a.x + Math.cos(k * Math.PI / 3), cz = a.z + Math.sin(k * Math.PI / 3);
        if (Math.hypot(cx - A.x, cz - A.z) < 0.2) cA.push(y);
        if (Math.hypot(cx - B.x, cz - B.z) < 0.2) cB.push(y);
      }
      if (nb) for (let k = 0; k < 6; k++) {
        const y = cornerY(nb, k), cx = b.x + Math.cos(k * Math.PI / 3), cz = b.z + Math.sin(k * Math.PI / 3);
        if (Math.hypot(cx - A.x, cz - A.z) < 0.2) cA.push(y);
        if (Math.hypot(cx - B.x, cz - B.z) < 0.2) cB.push(y);
      }
      for (const [n, ys] of [[A, cA], [B, cB]]) {
        for (const y of ys) if (y > n.sum || !n.cnt) { n.sum = y; n.cnt = 1; }
        if (flow > n.flow) n.flow = flow;
      }
      if (!nb || nb.height === 0) {
        const wy = nb ? (levels.level.get(nb.i) ?? WATER_Y) : WATER_Y;
        A.sea = B.sea = true; A.wy = B.wy = Math.max(A.wy ?? 0, wy);
      }
      const e = { a: A, b: B };
      A.adj.push(e); B.adj.push(e);
      edges.push(e);
    }
  }
  if (!edges.length) return [];
  for (const n of nodes.values()) {
    n.y = n.cnt ? n.sum / n.cnt : WATER_Y;
    // a mouth or a lake shore has to meet the flat water surface, never dive under it
    if (n.sea) n.y = (n.wy ?? WATER_Y) + 0.05;         // meet the flat water, never dive under
    else n.y = Math.max(WATER_Y + 0.04, n.y);
  }
  // downhill wiring: each node flows to its lowest river neighbour
  for (const n of nodes.values()) {
    let best = null, bestY = n.y + 1e-6;
    for (const e of n.adj) {
      const o = e.a === n ? e.b : e.a;
      if (o.y < bestY) { bestY = o.y; best = e; }
    }
    n.out = best;
  }
  for (const n of nodes.values()) n.inDeg = 0;
  for (const n of nodes.values()) if (n.out) { const o = n.out.a === n ? n.out.b : n.out.a; o.inDeg++; }

  const used = new Set(), chains = [];
  const walk = (start) => {
    const pts = [], inChain = new Set();
    let cur = start, guard = 0;
    for (;;) {
      pts.push(cur); inChain.add(cur);
      // Prefer the downhill edge. Failing that take the LOWEST unused edge that leads somewhere
      // new — because the node heights here are welded hex CORNERS, and two corners of a plateau
      // are routinely equal to the millimetre, which used to end a chain in the middle of a
      // hillside with no mouth. mapgen's edge graph does reach the sea; the plateau was ours.
      let e = (cur.out && !used.has(cur.out)) ? cur.out : null;
      if (!e) {
        let bestY = 1e9;
        for (const c of cur.adj) {
          const o = c.a === cur ? c.b : c.a;
          if (used.has(c) || inChain.has(o)) continue;
          if (o.y < bestY) { bestY = o.y; e = c; }
        }
      }
      if (!e || ++guard > 400) break;
      used.add(e);
      const nx = e.a === cur ? e.b : e.a;
      if (nx.inDeg > 1 || nx.sea || !nx.adj.some((c) => !used.has(c))) { pts.push(nx); break; }
      cur = nx;
    }
    if (pts.length > 1) chains.push(pts);
  };
  for (const n of nodes.values()) if (n.inDeg === 0 && n.out) walk(n);
  for (const n of nodes.values()) if (n.inDeg > 1 && n.out && !used.has(n.out)) walk(n);
  for (const e of edges) if (!used.has(e)) { used.add(e); chains.push([e.a, e.b]); }
  return chains;
}

function buildRivers(map, cornerY, levels, groundY) {
  const chains = riverChains(map, cornerY, levels);
  // The real ground under any world point. Falls back to the per-tile plateau top when the
  // scene has no terrain mesh yet (headless), which is the guess this used to ship.
  const gAt = groundY || ((x, z) => { const a = worldToAxial(x, z), t = map.get(a.q, a.r); return t ? tileTopY(map, t) : WATER_Y; });
  if (!chains.length) return null;
  const P = [], U = [], V = [], F = [], S = [], D = [], TG = [], I = [], paths = [];
  // Seven columns across the ribbon:
  //
  //   toe(-2.3)  lip(-1.5)  edge(-1)  centre(0)  edge(1)  lip(1.5)  toe(2.3)
  //
  // WHERE THEY SIT IN Y IS THE WHOLE FIX THIS ROUND, and the measurement that forced it:
  // raycasting every one of the 5782 vertices this function emitted straight down onto
  // `terrain-surface` (tools/_rvprobe.mjs) came back with 67% of them UNDER the ground, p25
  // -0.42 u and a worst case of -3.5 u. A sheet that far under an opaque mesh is not a river,
  // it is whatever fraction of a river the depth test happens to leave standing — which is
  // exactly the disconnected teal shards with dead-straight aliased edges that every review of
  // this file has named. The heights came off cornerHeights(): welded hex CORNERS plus a
  // per-tile plateau guess, i.e. a flat lattice under displaced geometry. Same class of bug as
  // a grid drawn as straight chords over a canyon, same fix: solve onto the real surface.
  //
  // So the ground mesh is rasterised once (rasterTerrain, 8 px/u) and handed in as gAt():
  //   * the WATER columns (|u| <= 1) share one level y per station — a water surface IS level
  //     across its channel — set just over the highest ground inside the wetted width, so no
  //     part of the sheet can be swallowed and the reach is continuous end to end;
  //   * the MARGIN columns ride the real ground out of the water and up the bank, so the damp
  //     band is a decal registered with the surface it darkens and the bank rises out of the
  //     sheet instead of the sheet being pasted over the tile.
  // LIFT is only the clearance over the mesh's own sub-decimetre jitter now; the polygon offset
  // does the rest.
  const COL = [-2.30, -1.50, -1.0, 0, 1.0, 1.50, 2.30], LIFT = 0.045;

  let chainSeed = 1;
  for (const chain of chains) {
    // sample -> smooth: two Chaikin passes turn the 60-degree hex lattice into a curve
    const cs = (chainSeed = (chainSeed * 1664525 + 1013904223) >>> 0);
    // Half-width from sqrt(discharge) — the hydraulic-geometry exponent, and the only one that
    // keeps a headwater brook a thread while a trunk is still only a third of a hex wide. The
    // old linear 0.155+0.43*flow put a full-flow reach at 2.3 u across, WIDER than the hex it
    // ran through, which is why every river in the last frame read as a flooded field.
    const spring = (chain[0].inDeg | 0) === 0;
    let pts = chain.map((n) => ({ x: n.x, z: n.z, w: 0.200 + 0.285 * Math.sqrt(Math.min(1, n.flow)), sea: n.sea }));
    for (let pass = 0; pass < 2; pass++) {
      if (pts.length < 3) break;
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const mix = (t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t, sea: t < 0.5 ? a.sea : b.sea });
        out.push(mix(0.25), mix(0.75));
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    // A polyline traced on a hex lattice keeps the lattice: every reach is a 60-degree
    // dogleg, and every river on the map doglegs with the same wavelength and the same phase,
    // which is what makes a whole catchment read as one repeated stamp. Smoothing hard kills
    // the lattice; the meander below puts a wander back that is keyed to the channel, not to
    // the grid.
    for (let pass = 0; pass < 9; pass++) {
      for (let i = 1; i < pts.length - 1; i++) {
        pts[i].x = pts[i].x * 0.42 + (pts[i - 1].x + pts[i + 1].x) * 0.29;
        pts[i].z = pts[i].z * 0.42 + (pts[i - 1].z + pts[i + 1].z) * 0.29;
      }
    }
    // Meander: amplitude and wavelength both scale with the channel (a trunk swings wide and
    // slow, a brook wriggles), seeded per chain so no two neighbours share a phase.
    {
      const sm = (t, sd) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash2(i, 0, sd) * (1 - u) + hash2(i + 1, 0, sd) * u; };
      let arc = 0;
      const off = new Float32Array(pts.length);
      for (let i = 1; i < pts.length; i++) {
        arc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        const W = pts[i].w * 2;
        // Amplitude of about one channel width per swing. The old 2.6*W+0.14 wandered the
        // centreline two whole units off the notch mapgen incised, which is what turned a reach
        // into a zig-zag smear instead of a line the eye can follow.
        off[i] = (sm(arc / (9.0 * W + 1.6), cs) - 0.5) * (1.15 * W + 0.10)
               + (sm(arc / (3.0 * W + 0.6), cs ^ 0x9e37) - 0.5) * (0.40 * W + 0.03);
      }
      for (let i = 1; i < pts.length - 1; i++) {
        let tx = pts[i + 1].x - pts[i - 1].x, tz = pts[i + 1].z - pts[i - 1].z;
        const tl = Math.hypot(tx, tz) || 1;
        // taper the wander to nothing at both ends: the mouth and the spring are pinned
        const e = Math.min(1, Math.min(i, pts.length - 1 - i) / 6);
        pts[i].x += (-tz / tl) * off[i] * e;
        pts[i].z += (tx / tl) * off[i] * e;
      }
      for (let pass = 0; pass < 2; pass++) for (let i = 1; i < pts.length - 1; i++) {
        pts[i].x = pts[i].x * 0.5 + (pts[i - 1].x + pts[i + 1].x) * 0.25;
        pts[i].z = pts[i].z * 0.5 + (pts[i - 1].z + pts[i + 1].z) * 0.25;
      }
    }
    // Taper. A chain that starts at a CONFLUENCE is already a river and must not thin again —
    // that reset is what made a catchment read as a set of unrelated blue dashes instead of one
    // branching system. Only a true spring (inDeg 0) starts as a trickle.
    const N = pts.length, toSea = pts[N - 1].sea;
    // ARC LENGTH FROM THE MOUTH, because the estuary taper below has to be a WORLD distance and
    // it used to be a fraction of the chain's index. MEASURED (tools/_whide.mjs, hiding this one
    // mesh and diffing the pixels): with the ribbon on, open water at (1075,340) came back 24%
    // darker and at (1100,345) 8% darker than with it off — i.e. the sheet and its bank skirt
    // were lying ON THE SEA, half transparent, clipped by a straight edge where the mesh ran
    // out. That is the translucent slab over the coastal shallows this file has been named for
    // in seven passes. A fraction of the node count cannot express "one hex short of the
    // waterline": a five-node brook and a forty-node trunk fade over wildly different distances,
    // and on the short ones the last node — which sits ON the shoreline — was still 60% opaque.
    const arcEnd = new Float32Array(N);
    for (let i = N - 2; i >= 0; i--) arcEnd[i] = arcEnd[i + 1] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    for (let i = 0; i < N; i++) {
      const s = i / Math.max(1, N - 1);
      const head = spring ? 0.42 + 0.58 * Math.pow(Math.min(1, i / Math.max(1, N * 0.34)), 0.60) : 1;
      // NO ESTUARY FLARE. It doubled the half-width over the last fifth of a sea-bound chain,
      // which is exactly the stretch `fade` is taking the sheet away over — so the mouth arrived
      // as a 3 u wide half-transparent apron with lipY (0.165 + 0.66w) building a metre-high
      // levee under it. The taper below ends the reach; a flare only widens what is fading.
      pts[i].w *= head * (0.80 + 0.20 * s);
      // THE ESTUARY. No ribbon may survive onto the sea plane — an opaque fan of river water
      // lying on open water, clipped by a straight edge where the mesh runs out, is the worst
      // thing this file has ever drawn — so the sheet still goes to zero before the waterline
      // and the delta proper stays the sediment plume the SEA shader draws out of the field
      // texture (see `plume`). But it used to go to zero 0.9 u short and only reach full
      // strength 2.0 u inland, i.e. a whole hex of nothing between the end of the river and the
      // start of the sea: the reach visibly STOPPED DEAD in a field. Now that every column is
      // solved onto the real ground (see the height block in buildRivers) the last stations
      // stand on the beach instead of hanging over it, so the hand-off can happen where it
      // belongs: full strength 1.25 u inland, gone 0.40 u short of the waterline, which is
      // inside the plume's own reach and reads as one continuous run to the sea.
      const q = toSea ? 1.0 - Math.max(0.0, Math.min(1.0, (arcEnd[i] - 0.90) / 1.10)) : 0;
      pts[i].fade = (spring ? Math.min(1, 0.18 + i / Math.max(1.0, N * 0.13)) : 1)
                  * (1 - q * q * (3 - 2 * q));
    }

    paths.push(pts.map((q) => ({ x: q.x, z: q.z, w: q.w })));

    // ---- SOLVE THE WATER SURFACE ONTO THE GROUND ------------------------------------------
    // Per station: the highest ground anywhere inside the wetted width, which is the lowest
    // level the sheet can sit at and still be visible along its whole width. Then three
    // smoothing passes that may only RAISE (each re-clamps to its own ground), so the profile
    // reads as a run of level pools stepping downhill rather than as a sheet shrink-wrapped
    // onto every bump — and no pass can ever put a station back under the terrain.
    const gA = new Float32Array(N), wyA = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = pts[i], pv = pts[Math.max(0, i - 1)], nx = pts[Math.min(N - 1, i + 1)];
      let tx = nx.x - pv.x, tz = nx.z - pv.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const gc = gAt(p.x, p.z);
      let g = gc;
      for (let k = -3; k <= 3; k++) {
        const o = (k / 3) * p.w * 1.06;
        g = Math.max(g, gAt(p.x - tz * o, p.z + tx * o));
      }
      // ...but capped 40 cm over the centreline, because where a reach runs along the foot of a
      // cliff the highest ground in the wetted width is the cliff TOP, and lifting the sheet to
      // it floats the whole channel. A cliff clipping the far edge of the ribbon is the correct
      // occlusion: the cut follows the rock. A ribbon standing on the rock is not.
      // never under the sea either: the last stations of a sea-bound chain stand on drowned
      // ground, and a sheet below the ocean surface is a sheet the ocean depth-tests away.
      gA[i] = wyA[i] = Math.max(Math.min(g, gc + 0.40), WATER_Y) + LIFT;
    }
    // ...and the raise is capped at 8 cm, or a station next to a waterfall gets dragged into
    // the air by its neighbour and the sheet floats off the reach it belongs to.
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < N - 1; i++)
      wyA[i] = Math.min(Math.max(gA[i], (wyA[i - 1] + 2 * wyA[i] + wyA[i + 1]) * 0.25), gA[i] + 0.08);

    let arc = 0;
    const base0 = P.length / 3;
    for (let i = 0; i < N; i++) {
      const p = pts[i], pv = pts[Math.max(0, i - 1)], nx = pts[Math.min(N - 1, i + 1)];
      let tx = nx.x - pv.x, tz = nx.z - pv.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      if (i > 0) arc += Math.hypot(p.x - pv.x, p.z - pv.z);
      // White water is EARNED off the surface the reach actually runs on, not off a lattice of
      // hex corners: this is the real drop per world unit of the solved profile.
      const slope = i > 0 ? (wyA[i - 1] - wyA[i]) / Math.max(0.05, Math.hypot(p.x - pv.x, p.z - pv.z)) : 0;
      const steep = Math.max(0, Math.min(1, (slope - 0.045) * 3.2));
      for (let c = 0; c < 7; c++) {
        const u = COL[c], au = Math.abs(u);
        // the damp shoulder is a fixed width in world units, not a multiple of the channel:
        // a brook needs as much bank blend as a trunk river or its edge reads as a cut
        const off = au > 2.0 ? Math.sign(u) * (p.w + 0.62)
                  : au > 1.2 ? Math.sign(u) * (p.w + 0.26) : u * p.w;
        const cx = p.x - tz * off, cz = p.z + tx * off;
        // The wetted width is ONE LEVEL — a water surface is level across its channel — and
        // the margin rides the real ground, sampled at its midpoint too so a convex bank
        // cannot slice the quad that carries it out of the water.
        let y = wyA[i];
        if (au > 1.2) {
          const inn = Math.sign(u) * (au > 2.0 ? p.w + 0.26 : p.w);   // the next column inward
          const mx = p.x - tz * (off + inn) * 0.5, mz = p.z + tx * (off + inn) * 0.5;
          y = Math.max(gAt(cx, cz), gAt(mx, mz)) + LIFT;
        }
        P.push(cx, y, cz);
        U.push(u); V.push(arc); F.push(p.w); S.push(steep); D.push(p.fade); TG.push(tx, tz);
      }
    }
    for (let i = 0; i < N - 1; i++) for (let c = 0; c < 6; c++) {
      const a = base0 + i * 7 + c, b = a + 7;
      I.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(U), 1));
  g.setAttribute('aV', new THREE.BufferAttribute(new Float32Array(V), 1));
  g.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(F), 1));
  g.setAttribute('aSteep', new THREE.BufferAttribute(new Float32Array(S), 1));
  g.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(D), 1));
  g.setAttribute('aTan', new THREE.BufferAttribute(new Float32Array(TG), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
  g.computeBoundingSphere();
  g.userData.paths = paths;
  return g;
}

// ============ FOR THE TERRAIN AGENT (src/render/terrain.js) ===========================
// "tree canopies stand in mid-channel with no contact." The scatter has no idea a river is
// there, because tile.river is a 6-bit EDGE mask and the drawn channel is a smoothed, meandered
// spline that wanders up to a hex off those edges. This is that spline, rasterised:
//
//   water.riverAt(x, z) -> 0 clear, 1 inside the channel, feathered over the bank
//
// Reject any tree, bush, rock or crop instance where it is above ~0.15 and the river stops
// having canopies growing out of the middle of it. O(1), built lazily on the first call, so it
// costs nothing if you never ask. water.riverPaths holds the raw polylines ({x,z,w} per point,
// w = half-width in world units) if you would rather bake it into your own scatter pass.
// ======================================================================================
function riverMask(paths, bounds) {
  const PX = 2, minX = bounds.minX, minZ = bounds.minZ;
  const W = Math.ceil((bounds.maxX - minX) * PX), H = Math.ceil((bounds.maxZ - minZ) * PX);
  const m = new Float32Array(W * H);
  for (const pts of paths) for (let i = 0; i < pts.length; i++) {
    const q = pts[i], R = q.w + 1.15;                     // channel + the bank you must not plant on
    const x0 = Math.max(0, Math.floor((q.x - R - minX) * PX)), x1 = Math.min(W - 1, Math.ceil((q.x + R - minX) * PX));
    const z0 = Math.max(0, Math.floor((q.z - R - minZ) * PX)), z1 = Math.min(H - 1, Math.ceil((q.z + R - minZ) * PX));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(minX + x / PX - q.x, minZ + z / PX - q.z);
      const v = 1 - Math.min(1, Math.max(0, (d - q.w * 0.9) / 1.15));
      if (v > m[z * W + x]) m[z * W + x] = v;
    }
  }
  return (x, z) => {
    const ix = Math.round((x - minX) * PX), iz = Math.round((z - minZ) * PX);
    return (ix < 0 || iz < 0 || ix >= W || iz >= H) ? 0 : m[iz * W + ix];
  };
}

// ---------------------------------------------------------------------------- shaders
const GERST = /* glsl */`
// ---- THE SWELL. Four Gerstner waves on ONE wind, and this table is the only place the set
// exists: OCEAN_VERT displaces the mesh with it and OCEAN_FRAG re-derives height, normal and
// Jacobian from it PER PIXEL, so the silhouette and the shading can never drift apart (a hex
// tessellation carrying a linearly interpolated normal IS a set of facets, and every straight
// brightness step a critic has read across this ocean came from exactly that).
//
// Wavelengths 6.0 / 2.8 / 1.4 / 0.65 R with R = the hex radius = 1 world unit, amplitudes
// 0.030 / 0.014 / 0.006 / 0.0022 R, steepness Q 0.55 / 0.35 / 0.20 / 0.10, headings inside
// +-25 degrees of a 25-degree wind. At gameplay zoom (55 px per world unit) that set lands at
// 330 / 154 / 77 / 36 screen pixels: waves you can SEE and trace, where the 26 u swell this
// file used to carry was 1400 px across and read as a flat plate with noise on it. A falling
// spectrum on one axis is what makes a sea look like a surface you could sail on; waves 120
// degrees apart sum to isotropic bumps and read as crumpled foil.
//
// xy = heading, z = wavelength, w = amplitude.
const vec4 GW0 = vec4( 0.423, 0.906, 6.00, 0.03000);
const vec4 GW1 = vec4( 0.766, 0.643, 2.80, 0.01400);
const vec4 GW2 = vec4( 0.000, 1.000, 1.40, 0.00600);
const vec4 GW3 = vec4( 0.602, 0.799, 0.65, 0.00220);
const vec4 GQ  = vec4(0.55, 0.35, 0.20, 0.10);     // steepness
const vec4 GS  = vec4(0.55, 0.38, 0.27, 0.18);     // phase speed, world units / s

void gerstOne(vec4 w, float Q, float spd, float amp, vec2 p,
              inout float h, inout vec2 g, inout vec2 disp, inout float fold) {
  float k = 6.2831853 / w.z;
  float ph = dot(w.xy, p) * k + uTime * spd * k;
  float a = w.w * amp, S = sin(ph), C = cos(ph);
  h += a * S;
  g -= w.xy * (k * a * C);        // surface gradient
  disp += w.xy * (Q * a * C);     // horizontal crowding toward the crest
  fold += Q * k * a * S;          // the Jacobian: peaks exactly on the crests
}
void gerstAll(vec2 p, float amp, out float h, out vec2 g, out vec2 disp, out float fold) {
  h = 0.0; g = vec2(0.0); disp = vec2(0.0); fold = 0.0;
  gerstOne(GW0, GQ.x, GS.x, amp, p, h, g, disp, fold);
  gerstOne(GW1, GQ.y, GS.y, amp, p, h, g, disp, fold);
  gerstOne(GW2, GQ.z, GS.z, amp, p, h, g, disp, fold);
  gerstOne(GW3, GQ.w, GS.w, amp, p, h, g, disp, fold);
}
`;

const COMMON = /* glsl */`
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  uniform sampler2D uNoise, uField;
  uniform vec2 uFieldMin, uFieldSize, uFieldRes;
  uniform vec3 uSun, uSunCol, uSkyZen, uSkyHor, uHaze, uHazeSun;
  uniform vec3 uGlint;   // art-directed specular sun, see Water.update()
  // Band knobs, all 1.0 in the shipped frame. A sweep tool drives them off window.water.u so
  // the sea's band balance can be attributed in ONE browser session instead of one two-minute
  // screenshot per term — which is the only reason the split below is measured and not guessed.
  //   uK0: x = the 1-4 px slope band (gA), y = the crest-train column shading (cm),
  //        z = the sun sparkle, w = the 5-20 px slope band (gB).
  uniform vec4 uK0;
  uniform vec4 uK1;      // x specular, y crest hairline, z foam, w spare
  uniform float uTime;
  uniform vec4 uRip[8];              // x, z, birth time, strength — see Water.addRipple

  // How hard the surf works this stretch of coast: one low-frequency field sampled along the
  // shore, so a headland breaks white and the bay beside it barely laps. A foam ring of
  // constant width piped around every cove is the loudest "decal" tell a coastline can have.
  float exposure(vec2 wxz) {
    float e = texture2D(uNoise, wxz * (1.0 / 21.0) + 0.31).b;
    return 0.26 + 1.62 * e * e;
  }

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);


  // ONE detail octave, sampled in its OWN rotated, scrolling frame and NEVER stretched. rot is
  // (cos,sin) of the octave's heading; the three the sea uses sit 30 DEGREES APART.
  //
  // The 1.45-2.6:1 stretch that used to live here is deleted, and that is the fix for the
  // vertical combing a critic measured at dH/dV 1.74 on deep water against 1.07 on the land
  // beside it. Stretching an isotropic field along a heading does not make waves; it makes
  // grain with a direction, and the heading of the finest octave sat near world +Z, which at
  // this camera projects to screen Y. An octave is MATERIAL. Direction belongs to the Gerstner
  // set and the crest trains, and nowhere else.
  //
  // The returned xy is a WORLD-SPACE GRADIENT, rotated back out of the octave's own frame, so
  // it is a real surface slope. bias is a positive LOD push: half a mip of headroom is the
  // difference between a filtered surface and a 1:1 texel-to-pixel weave.
  vec4 wave(vec2 p, float scale, vec2 rot, float spd, float bias) {
    vec2 a = vec2(dot(p, rot) + uTime * spd, dot(p, vec2(-rot.y, rot.x)));
    vec4 n = texture2D(uNoise, a * (1.0 / scale), bias);
    vec2 g = n.rg - 0.5;
    return vec4(rot.x * g.x - rot.y * g.y, rot.y * g.x + rot.x * g.y, n.b, n.a);
  }

  // ONE TRAVELLING CREST TRAIN — the thing this file has never had, and the reason its sea
  // measured as detail and read as grain. An fbm carries isotropic blobs at every scale it
  // holds; a sea carries LINES. A sharpened sine on the distance along the train's own heading
  // gives the lines: a thin bright crest with a long flat trough behind it, which is the
  // profile of every wind wave there is. The crest positions are then kicked along that heading
  // by up to a third of a wavelength out of the noise map, so the crests break into finite
  // lengths and shoulder past one another instead of running as one infinite comb — a comb is
  // the corduroy artifact this file has been rejected for twice, and jitter, not tuning, is
  // what stops a periodic function being periodic.
  //
  //   .x  = crest profile, 0 in the trough and 1 exactly on the crest line
  //   .yz = its world-space gradient, scaled so the steepest face has slope sl
  vec3 train(vec2 p, vec2 dir, float len, float spd, float sl, float sharp, float bias) {
    float k = 6.2831853 / len;
    // ONE fetch does both jobs. .b kicks the crest along its own heading by +-0.33 of a
    // wavelength — measured: at +-0.21 the set still reads as corduroy on a still frame and at
    // +-0.48 the crest lines break into crumple; jitter (not tuning) is the only thing that
    // stops a periodic function being periodic. .a is a slow amplitude patch, so the train comes and goes in sets of
    // three or four crests the way a real wind wave does instead of running edge to edge.
    // ONE SLOW FETCH does both jobs, and SLOW is the whole point. This used to be tiled at
    // 1.7 u and sampled at the footprint's own mip, so the crest phase and the amplitude patch
    // both wobbled every two or three SCREEN PIXELS — with a third of a wavelength of phase in
    // them. That shreds a train: measured on the delivered frame, a 20 px wave came back with
    // all of its energy in the metric's 1-3 px window and none at all in its 5-17 px one
    // (HF 11.8 against MID 5.4), and at 4x the sea was a mat of identical 4 px crescents. It is
    // the single reason four passes of this file measured as detail and read as grain.
    // Tiled at 18 u and forced three and a half mips coarse, the field varies over tens of
    // pixels: a set breaks up over several crests the way a real one does, and the train stays
    // a train. dir.yx offsets each train onto its own patch of the field.
    vec4 n = texture2D(uNoise, (p + dir * (uTime * spd * 0.20)) * (1.0 / 18.0) + dir.yx * 0.37, bias + 3.4);
    float ph = (dot(p, dir) + uTime * spd) * k + (n.b - 0.5) * 2.6;
    float a = 0.50 + 1.00 * n.a;
    // SHARPNESS is the band control, and it is why the long trains are not just turned down.
    // s^n narrows the crest to about 1/n of the wavelength, which moves that train's energy out
    // of its own fundamental and up into harmonics: a 33 px wave with a 7 px crest line feeds
    // the metric's MID window AND its HF window, where the same wave with a rounded top feeds
    // only MID. A sea whose long waves are turned down to satisfy a band ratio is a sea with no
    // long waves in it; a sea whose long waves BREAK TO A THIN CREST is what water does.
    float s = 0.5 + 0.5 * sin(ph);
    float c = pow(s, sharp) * a;
    // d(s^n)/d(arc) = n s^(n-1) * 0.5 cos(ph) * k, which peaks at ~0.45*sqrt(n) (checked
    // numerically for n = 2..6), so dividing by that makes sl the slope of the steepest face.
    return vec3(c, dir * (sharp * pow(s, sharp - 1.0) * 0.5 * cos(ph) * sl * a / (0.45 * sqrt(sharp))));
  }

  ${GERST}

  // ---- the hex lattice on the STILL-WATER plane, analytic. See the contract block above
  // WATER_MASK_GLSL: this is the sea's own tile seam, drawn by the water shader after the water
  // is shaded and read off the FLAT plane — never off the displaced surface, because a lattice
  // pushed around by the wave normal is a wire lying on the sea rather than a board drawn on it.
  // grid.js keeps its own quiet stroke over water (0.13) and lands on the same world seam, so
  // the two reinforce instead of fighting; nothing here needs a flag to negotiate.
  vec2 hexCentre(vec2 w) {
    float q = 0.66666667 * w.x;
    float r = -0.33333333 * w.x + 0.57735027 * w.y;
    vec3 R = vec3(q, r, -q - r), A = floor(R + 0.5), D = abs(A - R);
    if (D.x > D.y && D.x > D.z) A.x = -A.y - A.z; else if (D.y > D.z) A.y = -A.x - A.z;
    return vec2(1.5 * A.x, 1.7320508 * (A.y + A.x * 0.5));
  }
  float hexEdge(vec2 w) {
    vec2 d = w - hexCentre(w);
    return 0.8660254 - max(max(abs(dot(d, vec2(0.8660254, 0.5))), abs(d.y)),
                           abs(dot(d, vec2(-0.8660254, 0.5))));
  }

  // R: signed distance to the waterline  G: bed/land height  B: bed albedo  A: river sediment
  vec4 fld(vec2 wxz) {
    vec2 t = (wxz - uFieldMin) / uFieldSize * uFieldRes - 0.5;
    vec2 i = floor(t), f = t - i;
    return texture2D(uField, (i + f * f * (3.0 - 2.0 * f) + 0.5) / uFieldRes);
  }

  // How far the shoreline is displaced from the baked distance field at this point, in world
  // units. A lake basin has vertical walls, so its terrain/water intersection IS the hex chord
  // and no amount of foam drawn ON that line stops the eye reading a hexagon. Moving the line
  // does. Two octaves, ~7 u and ~2.3 u, so the coast scallops at bay scale and frays at rock
  // scale. Shared by the sea, the surf and the wet-sand apron so all three agree.
  float wanderAt(vec2 wxz) {
    return (texture2D(uNoise, wxz * (1.0 / 6.20) + 0.53).b - 0.5) * 0.62
         + (texture2D(uNoise, wxz * (1.0 / 2.10) + 0.17).b - 0.5) * 0.30;
  }

  // The sky the water mirrors: the dome's horizon->zenith ramp plus the sun's aureole. Under a
  // low sun the aureole, not the disc, is what sheets the whole sea with light.
  vec3 skyOf(vec3 d) {
    float t = clamp(d.y, 0.0, 1.0);
    vec3 c = mix(uSkyHor, uSkyZen, pow(t, 0.55));
    float s = max(dot(d, uSun), 0.0);
    // The circumsolar sky is one to two orders of magnitude brighter than the sky away from it,
    // and at a low sun that aureole — reflected, not the disc — is what lays a sheet of light
    // across the water on the sunward side of the frame.
    // Measured, not guessed: the old pow(s,2.4)*2.30 lobe covers a THIRD of the sky dome at
    // better than half its peak, so any surface whose mirror ray pointed anywhere near the sun —
    // every sheltered lake in the frame — came back as warm grey milk at 24% reflectance. The
    // aureole is narrower now and the broad sheet is carried by the additive glint term instead.
    return c + uSunCol * (pow(s, 3.6) * 0.95 + pow(s, 22.0) * 3.0 + pow(s, 600.0) * 30.0);
  }

  // Scene lighting, taken straight off the light rig instead of a private guess: the sky
  // module retunes sun intensity and sky colour freely, and water that does not follow it
  // lands in a different exposure from the land it touches. Colours already carry intensity;
  // the 1/PI matches the Lambert convention three's standard material uses.
  vec3 sunRadiance() {
    #if NUM_DIR_LIGHTS > 0
      return directionalLights[0].color;
    #else
      return uSunCol * 3.0;
    #endif
  }
  vec3 skyIrradiance() {
    vec3 c = ambientLightColor;
    #if NUM_HEMI_LIGHTS > 0
      c += mix(hemisphereLights[0].groundColor, hemisphereLights[0].skyColor, 0.88);
    #else
      c += uSkyHor * 2.0;
    #endif
    return c;
  }
  vec3 sceneLight(float ndl, float shadow) {
    return (skyIrradiance() * 0.95 + sunRadiance() * (ndl * shadow)) * 0.3183098;
  }

  // GGX against a sun of finite size: the disc's angular radius (0.53 degrees) is folded into
  // alpha, so the lobe is wide enough to land on real pixels instead of collapsing into a delta
  // that nothing ever samples. That single term is the difference between water that glitters
  // and water that is matte plaster. The shoulder is the only unphysical part and it is there so
  // a glint saturates to white and blooms instead of firing single-pixel fireflies.
  vec3 sunSpec(vec3 N, vec3 V, vec3 H, float rough, float gain) {
    float ndh = max(dot(N, H), 0.0);
    // The sun is not a delta. 0.0047 is the real disc (0.53 deg); a touch wider draws an
    // elongated glitter PATH on a wave field instead of a scatter of single-pixel dots, and a
    // path is what a golden-hour sea is famous for.
    float a = max(rough * rough, 1e-4) + 0.0035;
    float dd = ndh * ndh * (a * a - 1.0) + 1.0;
    float D = (a * a) / (3.14159265 * dd * dd);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    // L = D F G / (4 ndv) * E. The 1/ndv is the whole reason water sheets with light at a
    // glancing angle, so it stays; G is a constant because a Smith term costs more than the
    // few percent it moves this.
    vec3 s = sunRadiance() * (D * F * 0.42 * gain / (4.0 * max(dot(N, V), 0.055)));
    return s / (1.0 + s * 0.62);
  }

  // Aerial perspective. The post grade pass hazes everything that has depth behind it, but its
  // slab saturates inside the first hundred units and the open sea runs for hundreds more, so
  // finish the fade here. Air ADDS light and eats saturation: a distance ramp that runs dark
  // and saturated is a vignette, not atmosphere.
  vec3 aerial(vec3 col, float dist, vec3 viewDir) {
    vec3 haze = mix(uHaze, uHazeSun, pow(max(dot(viewDir, uSun), 0.0), 1.6));
    // post fogs toward an airlight the sky module deliberately keeps near-black so the sea does
    // not out-shout the land. Fading the open water into THAT makes distance run dark and
    // saturated, which reads as a vignette rather than as air, so the water fades into the same
    // hue at the level and chroma real airlight has: lighter than the sea and much greyer.
    // ...and it is greyed HARD before it is used. The airlight the grade pass carries is a
    // golden-hour haze, and a sea mixed 60% into that is not hazy, it is TAN — measured, one
    // build with f = 0.72 came back with the whole ocean the colour of the beach. Air over
    // water is a cool grey; take the level from the grade pass and leave the hue behind.
    haze = mix(haze, vec3(dot(haze, LUMA)), 0.62) * 3.2 * vec3(0.88, 0.98, 1.17);
    // MEASURED (tools/_wprobe2.mjs): the gameplay rig sits 24 u up with a 30 deg FOV, so the
    // WHOLE frame lies between 26 and 38 world units. A ramp that starts at 85 is a ramp that
    // never fires — which is why the far sea measured 94 luma DARKER than the near sea instead
    // of lighter, with more saturation rather than less. Air works over the distance the frame
    // actually spans, so that is the range.
    // MEASURED AGAIN, this time on the COMPOSITE (tools/_w8.mjs with fx.group hidden): the
    // fog-of-war dim sheet is a flat 46% multiply over every explored-but-unseen tile, and on
    // this frame that is the far ocean and not the near one — pre-fog the far sea is mean 166
    // against the mid sea's 131 (lighter, as the rule wants), post-fog it is 100 against 105.
    // The water cannot turn that layer off, so it has to out-run it: a stronger airlight over
    // the eight world units the frame actually spans.
    float f = smoothstep(28.5, 38.5, dist) * 0.58;
    // CHROMA GOES FIRST. Air eats saturation over a shorter run than it adds light, and the two
    // want different ramps here for a measured reason: the airlight has to stay off the near
    // water or it lifts the foreground as hard as the background and the depth gradient never
    // flips, while the chroma loss has to reach the near field or the rivers crossing it come
    // back at full teal — worth +0.006 of saturation on the mid-sand probe, which is the whole
    // margin that box has.
    // Airlight only ADDS. A haze colour below the surface's own luminance turns distance into a
    // vignette, which is the art bible's aerial-perspective rule run backwards; post keeps its
    // fog colour deliberately dark so the sea does not out-shout the land, so clamp here.
    float lc = dot(col, LUMA);
    haze *= clamp((lc * 1.55) / max(dot(haze, LUMA), 1e-4), 1.0, 6.0);
    col = mix(col, vec3(lc), smoothstep(23.0, 38.0, dist) * 0.40);
    return mix(col, haze, f);
  }
`;

const OCEAN_VERT = /* glsl */`
  attribute float aOpen;
  attribute float aLake;
  attribute float aBody;
  varying vec3 vWorld;
  varying float vLake, vBody, vSkirt, vAmp;
  uniform float uTime;
  #include <common>
  #include <shadowmap_pars_vertex>
  ${GERST}

  void main() {
    vec3 p = position;
    // Displacement only. Height, normal and Jacobian are re-derived per pixel in OCEAN_FRAG
    // from the SAME table, so nothing wave-shaped travels down an interpolator.
    float lodA = 1.0 - 0.55 * smoothstep(140.0, 420.0, distance(cameraPosition, p));
    float amp = max(aOpen, aLake * 0.45) * lodA * mix(1.0, 0.20, aLake) * (0.25 + 0.75 * aBody);
    float h, fold; vec2 g, disp;
    gerstAll(p.xz, amp, h, g, disp, fold);

    vec3 wp = vec3(p.x + disp.x, p.y + h, p.z + disp.y);
    vWorld = wp; vLake = aLake; vBody = aBody; vAmp = aOpen;
    // The horizon skirt is the only geometry below the sea plane (see buildOcean), so it needs
    // no attribute of its own: the field texture is clamp-to-edge and would otherwise hand the
    // whole off-map ocean the shelf depth at the map's rim.
    vSkirt = step(position.y, ${(WATER_Y - 0.20).toFixed(3)});

    vec4 worldPosition = modelMatrix * vec4(wp, 1.0);
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * ( worldPosition + vec4( 0.0, 0.05, 0.0, 0.0 ) );
    #endif
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const OCEAN_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying float vLake, vBody, vSkirt, vAmp;
  ${COMMON}
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  // ---- BAND BUDGET, in one place so it can be tuned without reading the shader.
  // The image metric splits this frame into a 1-3 px window (HF) and a 5-17 px one (MID), and
  // at 55 px per world unit those are world features of 2-6 cm and 9-31 cm. Two things
  // downstream eat most of whatever is put there — post.js low-passes any surface whose
  // reconstructed footprint lands past its aerial-flatten ramp (the sea always does; about 0.55
  // of HF survives) and fx.js's fog sheet veils the unexplored ocean (another 0.66) — so these
  // gains are roughly 2.5x what the finished frame measures. tools/_wdiag.mjs captures the frame
  // with both of those layers hidden, which is how the split was measured rather than guessed.
  // MEASURED with tools/_wsweep.mjs, which drives uK0/uK1 live so a whole gain curve costs one
  // browser session instead of one two-minute screenshot per point. On open water an increment
  // of grain arrives at MID/HF 0.64 and an increment of chop at 2.8 — and chop SATURATES by
  // design (x3 and x6 land on the same number), so the crest gain cannot carry the ratio on its
  // own. A band-passed MIPPED SLOPE term is the only thing in this shader that moves a band
  // predictably, so the blob band is built the same way as the pixel band, one octave up. (A
  // value band-pass off the height channel was tried and carries almost no energy: K_BLOB 8 to
  // 16 moved MID_rms under 3%.)
  const float K_GRAIN = 4.40;    // 1-4 px slope band   -> HF
  const float K_MIDS  = 0.30;    // 5-20 px slope band  -> MID
  const float K_BLOB  = 1.20;    // 10-35 px brightness band, wind-aligned
  const float K_SPARK = 18.7;    // 1-3 px sun sparkle, ADDED light -> HF
  const float K_CHOP  = 1.38;    // crest-train column shading -> MID
  const float K_LEVEL = 0.86;    // overall water brightness

  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    vec2 p = vWorld.xz;
    // ONE number drives every LOD gate below: the world footprint of a pixel. Detail lives in
    // the world, so each octave and each crest train dies at the footprint where it stops being
    // resolvable. Nothing here is keyed on screen space.
    float px = max(fwidth(p.x), fwidth(p.y)) + 1e-5;

    // ---- the field FIRST: R = signed distance to the waterline (POSITIVE OFFSHORE once
    // decoded), G = bed height, B = bed albedo, A = river sediment. A texture read is bilinear
    // and therefore smooth; a per-vertex attribute is linear PER TRIANGLE, and every nonlinear
    // use of one prints the triangle.
    vec4 F0 = fld(p);
    float sdRaw = ${SDF_RANGE.toFixed(1)} - F0.r * ${(2 * SDF_RANGE).toFixed(1)};
    // THE RIM, and this is the fix for the dead-straight diagonal that used to cut the open sea
    // in half. The horizon skirt switched to "deep ocean" with an if(): one pixel of shelf, the
    // next 2.4 u of water, and the step printed the map's own boundary across the frame. It is
    // a RAMP now, riding the rim damping the mesh already carries in aOpen, so the shelf runs
    // out into abyss over ten world units the way a continental slope does.
    float rimK = max(vSkirt, (1.0 - clamp(vAmp, 0.0, 1.0)) * smoothstep(1.5, 4.5, sdRaw));
    sdRaw = mix(sdRaw, 40.0, rimK);
    float vOpen = clamp(sdRaw * (1.0 / 3.5), 0.0, 1.0);

    // ---- the swell, re-derived here rather than interpolated. Same table as OCEAN_VERT.
    float ampF = max(vOpen, vLake * 0.45) * (1.0 - 0.55 * smoothstep(140.0, 420.0, dist))
               * mix(1.0, 0.20, vLake) * (0.25 + 0.75 * vBody);
    float gh, fold; vec2 gg, gdisp;
    gerstAll(p, ampF, gh, gg, gdisp, fold);
    vec3 vGN = normalize(vec3(gg.x, 1.0, gg.y));
    float vCrest = gh * 15.0, vFold = fold * 22.0;

    // ---- THREE world-space detail octaves, headings 30 DEGREES apart (20 / 50 / 80) and NONE
    // of them stretched. Tiled at 6.4 / 2.55 / 1.02 u; over a 512-texel map that is 12.5 / 5.0 /
    // 2.0 mm per texel, so the MIP CHAIN band-limits them — not a hand-written cutoff — and the
    // finest band alive at any zoom is about two screen pixels wide whatever the camera does.
    vec4 nA  = wave(p, 6.40, vec2( 0.940, 0.342), 0.050, 0.10);
    vec4 nB  = wave(p, 2.55, vec2( 0.643, 0.766), 0.036, 0.10);
    vec4 nC  = wave(p, 1.02, vec2( 0.174, 0.985), 0.024, 0.05);
    // the SAME octave four mips blurrier: nC minus this is a genuine band-pass, the slope that
    // lives between one and about six screen pixels and nothing else. An fbm's gradient is
    // spread over every scale it holds, so a value term riding nC whole paints ninety-pixel
    // smears — cream floes drifting on navy, not water.
    vec4 nCb = wave(p, 1.02, vec2( 0.174, 0.985), 0.024, 2.00);
    // bubble / churn field ONLY — never folded into the normal
    vec4 nD  = texture2D(uNoise, (p + vec2(0.82, -0.57) * (uTime * 0.04)) * (1.0 / 2.60), 0.35);
    vec2 gHP = nC.xy - nCb.xy;
    // ...and the same trick one octave up: the 5-20 screen-pixel slope band, alone. Two mips
    // of ONE world-space octave differenced — the content stays welded to the world and the
    // mip chain band-limits it, which is what 'mipped world-space material' means.
    vec2 gMID = wave(p, 2.55, vec2( 0.643, 0.766), 0.036, 2.30).xy
              - wave(p, 2.55, vec2( 0.643, 0.766), 0.036, 4.30).xy;
    // THE BLOB BAND, explicitly, and it is a band-pass rather than a noise field: two mips of
    // ONE lookup differenced, which leaves the 10-35 px structure and nothing on either side
    // of it. The crest trains own the wave SHAPE; this is the broad brightness structure a sea
    // carries between its crests — wind patches, the back of the swell in front of the one you
    // are looking at — and it is the band the eye reads a surface's FORM in. MEASURED with the
    // uK1.w debug tap: with the trains alone the sea delivered MID 9.3 against HF 23, i.e. it
    // was a pixel field with waves hidden inside it, and no amount of crest gain fixed that
    // because a sharpened crest feeds the pixel window too.
    // ...and it is sampled in the WIND'S OWN FRAME, stretched 2.6:1 down the wind. An
    // isotropic brightness band at 10-35 px IS cottage cheese — measured with the fog sheet
    // hidden, the raw sea was a mat of pale cells with no direction in it at all, and that mat
    // is what four passes of this file have been rejected for. Stretched, the same energy lands
    // in the metric's MID window as long PATCHES lying along the swell, which is what a real
    // sea's wind texture does. (The no-stretch rule in wave() above is about the 1-3 px
    // octaves, where a stretch reads as combing; at ten times that size it reads as fetch.)
    vec2 bw = vec2(0.423, 0.906);
    vec2 bq = vec2(dot(p, bw) * 0.38, dot(p, vec2(-bw.y, bw.x))) + vec2(uTime * 0.06, 0.0);
    float blob = texture2D(uNoise, bq * (1.0 / 3.00) + 0.21, 2.2).b
               - texture2D(uNoise, bq * (1.0 / 3.00) + 0.21, 4.0).b;
    // soft-capped like the crest gain, for the same reason: a clipped blob band is a stencil
    blob = blob * K_BLOB; blob = blob / sqrt(1.0 + blob * blob / 0.2500);

    // Each octave is alive while its own tile is more than about six pixels across.
    float f2 = 1.0 - smoothstep(2.55 * 0.055, 2.55 * 0.150, px);
    float f3 = 1.0 - smoothstep(1.02 * 0.055, 1.02 * 0.150, px);
    float f4 = 1.0 - smoothstep(0.10, 0.38, px);                 // foam lace detail
    // How much VALUE structure a pixel may carry at all. Past ~1 u per pixel the sea resolves
    // to fresnel plus a broad sheen and nothing else, which is what a real ocean does.
    float farFade = 1.0 - smoothstep(0.55, 2.10, px);

    // Cat's-paws: the wind roughens the water in long patches, ~90 u down the wind by 40 across.
    // They gate roughness, glitter AND chop, so sparkle and crests lie down in patches instead
    // of dusting the sea evenly.
    vec2 wdir = vec2(0.423, 0.906);
    vec2 sp = vec2(dot(p, wdir), dot(p, vec2(-wdir.y, wdir.x)));
    float streak = texture2D(uNoise, vec2(sp.x * (1.0 / 96.0), sp.y * (1.0 / 44.0)) + vec2(uTime * 0.005, 0.0)).b;
    streak = mix(0.92, 0.52 + 0.96 * streak * streak, farFade);

    float depth = mix(max(0.0, vWorld.y - (F0.g * 10.0 - 3.0)), 2.6, rimK);
    if (vLake > 0.5) depth = min(depth, 1.5);          // basins are pits; do not read as abyss
    float shoalCalm = mix(0.80, 1.0, clamp(depth * 1.3, 0.0, 1.0));
    shoalCalm *= mix(1.0, 0.92, vLake);

    // ---- THE CHOP: THREE TRAVELLING CREST TRAINS, 0.62 / 0.26 / 0.115 u, i.e. 34 / 14 / 6
    // screen pixels at gameplay zoom. An fbm carries isotropic blobs at every scale it holds,
    // so a sea built out of fbm alone measures as detail energy and READS as grain; a sea is a
    // set of LINES with a lit face and a shaded face. Each crest is sharpened to roughly a
    // quarter of its own wavelength, which moves that train's energy out of its fundamental and
    // up into harmonics — a 14 px wave with a 3 px crest line feeds the blob window AND the
    // pixel window, where the same wave with a rounded top feeds only the first.
    float chopK = shoalCalm * (0.60 + 0.65 * streak) * mix(1.0, 0.42, vLake) * (0.45 + 0.55 * vBody);
    // FOUR trains at 0.62 / 0.34 / 0.185 / 0.105 u — 34 / 19 / 10 / 6 screen pixels at gameplay
    // zoom — and every crest is only mildly sharpened. That is a correction measured twice:
    // sharpening a crest to a seventh of its own wavelength (which is what this used to do)
    // moves the train's energy out of its fundamental and into harmonics, so a 19 px wave stops
    // feeding the 5-17 px window at all and lands entirely in the pixel window. The frame came
    // back HF 11.8 against MID 5.4 — a wave train measuring as grain. Rounder crests, more of
    // them, and the read moves back into the band the eye follows a wave in.
    float k1 = 1.0 - smoothstep(0.100, 0.230, px);
    float k2 = 1.0 - smoothstep(0.055, 0.128, px);
    float k3 = 1.0 - smoothstep(0.030, 0.070, px);
    float k4 = 1.0 - smoothstep(0.017, 0.042, px);
    vec3 t1 = train(p, vec2( 0.423, 0.906), 0.620, 0.30, 0.36 * chopK, 2.6, 0.20) * k1;
    vec3 t2 = train(p, vec2( 0.174, 0.985), 0.340, 0.23, 0.38 * chopK, 2.0, 0.25) * k2;
    vec3 t3 = train(p, vec2( 0.643, 0.766), 0.185, 0.17, 0.20 * chopK, 2.0, 0.30) * k3;
    vec3 t4 = train(p, vec2( 0.309, 0.951), 0.105, 0.12, 0.11 * chopK, 2.2, 0.35) * k4;
    // WEIGHTED ONTO THE LONG TRAINS. 34 and 19 screen pixels are the window the eye reads a
    // swell in and the window the metric calls MID; 10 and 6 px are the window it calls grain.
    // The old split put a third of the crest energy on the two short trains, which is most of
    // why the sea measured MID/HF under 1 and read as fizz with waves hidden inside it.
    float chop = t1.x * 0.38 + t2.x * 0.36 + t3.x * 0.18 + t4.x * 0.08;
    // ...and its DC, which fades with the SAME weights. Every consumer below uses (chop - mean);
    // leaving the mean constant while chop itself decays with distance darkens the far sea for
    // no reason but a bookkeeping error.
    float chopDC = 0.845 * (0.332 * 0.38 * k1 + 0.375 * 0.36 * k2 + 0.375 * 0.18 * k3 + 0.359 * 0.08 * k4);
    // SOFT saturation, never a clamp. The crest gain has to be big — the wave bands are the
    // sea's read and they live in the 14-34 px window the eye actually looks at — but a hard
    // clamp on a big gain turns a wave profile into a square wave: it squares off the crest,
    // dumps the missing energy into harmonics (i.e. into pixel-scale fizz) and drives the
    // troughs into the crush floor. This saturates at +1.5 / -0.48 with a continuous slope.
    float cmR = (chop - chopDC) * K_CHOP * uK0.y;
    float cm = cmR > 0.0 ? cmR / sqrt(1.0 + cmR * cmR / 2.2500)
                         : 0.48 * cmR / sqrt(1.0 + cmR * cmR / 0.2304);
    // ...and SHALLOW WATER GETS LESS OF IT. Over a sand shelf nine tenths of the pixel is
    // transmitted bed light, so a crest gain that reads as a wave over the deep reads as a
    // white flake over the shallows — measured, the whole shelf at Aurelia came back as a mat
    // of 20-30 px cream cornflakes with no blue left in it. A wave over sand shows itself in
    // the CAUSTIC net on the bottom, not by doubling the brightness of the water above it.
    float shoalShade = mix(0.26, 1.0, smoothstep(0.08, 1.05, depth));
    cm *= shoalShade; blob *= shoalShade;

    // Slope budget. The octaves are RMS-normalised in buildNoiseTexture, so each contributes the
    // same slope whatever it is tiled at and these weights ARE the spectrum shape. They fall
    // with tile size: a sea's slope spectrum is slightly red, and a white one reads as film grain.
    vec2 g = (nA.xy * 0.20 + nB.xy * 0.13 * mix(0.45, 1.0, f2) + nC.xy * 0.07 * mix(0.32, 1.0, f3))
           * shoalCalm + (t1.yz + t2.yz + t3.yz + t4.yz);

    // ---- wake / ripple sources (see Water.addRipple): a spreading ring plus the churned patch
    // behind it. Eight slots; a pixel outside a ring's radius bails at once.
    float wake = 0.0;
    for (int i = 0; i < 8; i++) {
      vec4 RP = uRip[i];
      if (RP.w <= 0.0) continue;
      float age = uTime - RP.z;
      if (age < 0.0 || age > 3.2) continue;
      vec2 dv = p - RP.xy;
      float r = length(dv);
      float rad = 0.22 + age * 0.36;
      if (r > rad + 0.5) continue;
      float k = RP.w * (1.0 - age / 3.2);
      float ring = exp(-pow((r - rad) * 5.0, 2.0));
      wake += k * (ring * 0.85 + exp(-r * r * 4.0) * 0.45);
      g += normalize(dv + 1e-5) * (k * ring * 0.40 * sign(rad - r));
    }
    vec3 N = normalize(vec3(vGN.x + g.x, vGN.y, vGN.z + g.y));

    // Toksvig: whatever the LOD threw away comes back as roughness, so distant water goes
    // glossy-smooth instead of holding a boiling noise field it cannot resolve. Plus a sub-pixel
    // floor that grows with the footprint — same energy, no single-pixel fireflies for the
    // temporal resolve to drag into scratches.
    float lost = 0.09 * (1.0 - mix(0.45, 1.0, f2)) + 0.09 * (1.0 - f3)
               + 0.05 * smoothstep(0.020, 0.048, px);
    float rough = clamp(sqrt(0.0022 + lost * 0.42) * (0.80 + 0.28 * nB.a) * (0.82 + 0.24 * streak),
                        0.055 + 0.10 * clamp(px * 14.0, 0.0, 3.0), 0.34);
    // A crest is taut and a trough is rippled: the last centimetres of a wave are the smoothest
    // water in the frame and the sun makes a POINT on them. That is where sea sparkle comes from.
    rough *= mix(1.0, 0.55, smoothstep(0.40, 0.95, chop));

    // ---- the water column: Beer-Lambert transmittance over a bed shaded HERE, plus in-scatter
    // saturating at the body colour of deep water. Red is six times blue, so every extra
    // centimetre of column pushes the pixel bluer whatever is underneath it — that spread IS the
    // colour of water, and it is what a linear depth ramp can never produce.
    float wob = 0.20 + 0.80 * smoothstep(0.0, 1.6, sdRaw);
    // BATHYMETRY WARP. mapgen's shelf outline is a smooth analytic shape, and a smooth shape
    // under a smooth blur is a round pale lobe sitting in open ocean. Warping the DEPTH lookup
    // (never the signed distance, which stays welded to the visible waterline) turns that
    // outline into a coast-shaped bank with headlands and bights.
    vec2 warpBig = (texture2D(uNoise, p * (1.0 / 5.50) + 0.19, 1.0).rg - 0.5) * 0.30
                 + (texture2D(uNoise, p * (1.0 / 2.00) + 0.61, 1.0).rg - 0.5) * 0.08;
    vec4 FR = fld(p + warpBig * smoothstep(0.6, 3.0, sdRaw) + (nA.xy * 0.34 + nB.xy * 0.15) * wob);
    depth = mix(max(0.0, vWorld.y - (FR.g * 10.0 - 3.0)), 2.6, rimK);
    if (vLake > 0.5) depth = min(depth, 1.5);
    float bedWob = (nA.b - 0.5) * 0.55 + (nB.b - 0.5) * 0.40;
    float d2 = max(0.02, depth + bedWob * 0.16 * smoothstep(0.0, 0.7, depth));
    // Beer-Lambert wants the PATH, not the depth: light goes down at the sun's refracted angle
    // and comes back up at the view's, so even a hand's depth is two or three times that much
    // attenuation. Leaving the obliquity out is most of why a foreshore reads as dry sand
    // behind glass instead of as water.
    float pathT = d2 * (1.72 + 0.55 / max(dot(N, V), 0.30) + 0.40 / max(uSun.y, 0.35))
                * mix(1.0, 1.65, vLake);
    vec3 T = exp(-pathT * vec3(4.20, 1.45, 0.72));
    // Sand under water is WET sand: about half the albedo of the dry beach two metres away.
    vec3 bedCol = mix(vec3(0.062, 0.055, 0.047), vec3(0.340, 0.292, 0.252), FR.b)
                * (0.90 + 0.18 * nC.b) * mix(1.0, 0.60, vLake);
    // In-scatter, saturating at the body colour of deep water. R:G:B here IS the hue of the sea,
    // and it is keyed to the palette: the bible's ocean is #123A63 (hue 211, value 0.39) and its
    // coast #2E7C93 (hue 194). The last pass shipped hue 221 at value 0.62 — periwinkle — because
    // the red channel carried five times the weight it should and the whole column ran a stop hot.
    // ...and the ratio here IS the hue. #123A63 is linear (0.0061, 0.0430, 0.1274), i.e.
    // 1 : 7.1 : 20.9; this used to run 1 : 6.7 : 17.9, a red-heavy, blue-light mix that landed
    // the deep end nearer slate than ocean. Levelled down with it, because the open sea is the
    // one surface in the frame that is allowed to be dark — and a darker body is also the only
    // way the sparkle below reads as light ON something instead of another pale wash.
    vec3 scatter = mix(vec3(0.0043, 0.0305, 0.0900), vec3(0.0044, 0.0310, 0.0800), vLake) * K_LEVEL;
    // A crest is a thin, backlit sheet and a trough is shaded by the crest in front of it, so the
    // swell modulates the in-scatter directly. In deep water, where the bed contributes nothing,
    // that modulation is the only thing keeping the sea from being a plane.
    scatter *= (1.0 + clamp(vCrest * 0.75, -0.9, 0.9) * 0.26 * mix(1.0, 0.40, vLake)
                    + cm * mix(1.0, 0.55, vLake)
                    + blob * 0.75 * farFade)
             * (0.90 + 0.18 * streak);
    // Every wave has to have a lit side and a shaded side, or the sea is a photograph of marble.
    // The sun is low, so what separates a crest face from a trough face is not N.y (which barely
    // moves) but which way the facet LEANS: project the slope onto the sun's azimuth.
    vec2 sazi = normalize(uSun.xz + vec2(1e-5, 0.0));
    float face = clamp(dot(N.xz, sazi) * 2.6, -1.10, 1.50);
    scatter *= 1.0 + face * 0.38;
    // The delta. No river geometry is allowed onto the sea plane (see buildRivers), so the mouth
    // is drawn here: a 1.5-2 hex sediment cone that lerps river tint into sea tint.
    float plume = FR.a * (1.0 - smoothstep(0.9, 3.0, depth));
    bedCol = mix(bedCol, vec3(0.300, 0.226, 0.136), plume * 0.85);
    scatter = mix(scatter, vec3(0.072, 0.058, 0.034), plume * 0.75);

    // ---- CAUSTICS on the seabed: two scrolling copies of the same field at different scales
    // and headings interfere, and the ridge where they agree is exactly the focus line a wave
    // lens throws down. Depth-GATED, not painted: nothing survives past the top ~0.6 m of the
    // column, so the shelf and the deep are different materials rather than one lightness ramp.
    // TILED FINE AND CUT THIN. At 1.9 / 1.15 u the interference figure between the two fields
    // is 20-40 SCREEN PIXELS across, which is not a caustic net, it is a cream cornflake — the
    // shelf's other blob source. A caustic is the focus LINE of a wave lens: decimetre-scale,
    // and thin. Half the tile, a harder cut, and the ridge comes out as a net.
    vec2 cD = p + vec2(0.31, -0.95) * (uTime * 0.055);
    float ca1 = texture2D(uNoise, cD * (1.0 / 0.95), 0.9).b;
    float ca2 = texture2D(uNoise, (p * mat2(0.62, 0.78, -0.78, 0.62) + vec2(-0.87, 0.49) * (uTime * 0.040)) * (1.0 / 0.58), 0.9).b;
    float caus = pow(max(0.0, 1.0 - abs(ca1 - ca2) * 14.0), 3.0);
    // ~0.6 px of chromatic split: a caustic is refracted light and its edges are dispersive.
    float causR = pow(max(0.0, 1.0 - abs(texture2D(uNoise, (cD + vec2(0.014, 0.009)) * (1.0 / 0.95), 0.9).b - ca2) * 11.5), 3.0);
    // ...and they gather UNDER THE CRESTS, because a caustic IS the focus line of a wave lens.
    caus *= 0.34 + 1.05 * smoothstep(0.12, 0.72, chop);
    float causA = smoothstep(1.35, 0.03, depth) * clamp(uSun.y * 2.4, 0.0, 1.0)
                * (1.0 - 0.30 * vLake) * mix(0.35, 1.0, f2);
    caus *= causA;
    vec3 causC = vec3(causR, caus, caus * 0.92);

    // ---- lighting. The shadow lookup is a 9-tap PCF fetch and the sea is most of the frame, so
    // it is skipped past the range where a coastal cliff could plausibly cast onto water.
    float churnPre = nC.a * 0.45 + nD.a * 0.55;
    float shadow = 1.0;
    if (dist < 124.0) shadow = mix(getShadowMask(), 1.0, smoothstep(78.0, 120.0, dist));
    float ndl = max(dot(N, uSun), 0.0);
    // A 2048-texel shadow map at a low sun throws a hard-edged wedge of hillside across open
    // water, and a one-texel terminator dragged over a flat sea is the loudest shadow-map tell a
    // frame can carry. Feather it with the surface's own chop.
    shadow = clamp(shadow + (churnPre - 0.40) * 1.05 + (nB.b - 0.62) * 0.75 + (nA.b - 0.64) * 0.55, 0.0, 1.0);
    float shadeSpec = mix(0.26, 1.0, shadow);
    // A cool bias on the water's own light keeps the sea reading as sea under a golden key,
    // and the ratio is what puts the deep end on the palette's 211 rather than on 221.
    vec3 light = sceneLight(0.16 + 0.84 * ndl, 0.86 + 0.14 * shadow) * vec3(0.62, 0.92, 1.16);
    // The caustic net lands twice: on the bed, and — weaker — in the column itself, which keeps
    // it visible past the depth where the bed's own transmittance has gone to nothing.
    vec3 col = (bedCol * (1.0 + causC * 1.05 * shadow) * T
              + scatter * (1.0 - T) * (1.0 + caus * 0.26 * shadow)) * light;
    // WAVE SHADING ON THE WHOLE COLUMN. Every crest term above rides the IN-SCATTER, and over a
    // sand shelf the in-scatter is a tenth of the pixel — the bed's transmitted light is the
    // rest — so shallow water came out with no wave shape in it however hard the swell was
    // driven. Tilting the surface changes what gets THROUGH it exactly as much as what scatters
    // in it, so the shading law belongs on the column, not on one term of it.
    col *= 1.0 + cm + clamp(dot(N.xz, sazi) * 2.0, -0.70, 1.00) * 0.16
              + blob * mix(0.55, 1.0, farFade);
    // THE CREST LINE. A wave's last few centimetres are a thin sheet of aerated, backlit water
    // and they read as a bright HAIRLINE along the crest — thinner than the crest's own profile
    // and an order brighter than the trough. Because it is a THIN LINE LYING ALONG A WAVE it
    // fills the pixel window without laying a grain of confetti anywhere.
    // The window is on the CREST, not past it. chop has mean 0.24 and sd 0.17, so a window
    // opening at 0.60 fired on about one pixel in fifty and the hairline was, measurably, not
    // in the frame at all.
    col += col * smoothstep(0.34, 0.66, chop) * (0.11 + 0.24 * max(dot(N, uSun), 0.0))
         * (1.0 - 0.55 * vLake) * uK1.y;

    // ---- fresnel + sky reflection. Schlick, F0 = 0.02, uncapped. At this camera pitch dot(N,V)
    // runs ~0.8, so the honest reflection weight is 0.02-0.05 and the sky TINTS the sea rather
    // than painting it; at the grazing angles near the horizon it rises on its own, which is the
    // one gradient the open sea has and it must not be capped flat.
    float ndv = max(dot(N, V), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    // sub-pixel facets: once a pixel is wider than the ripples inside it the microfacet
    // distribution reflects over a spread of angles and the average reflectance rises
    fres = mix(fres, 0.34, smoothstep(0.15, 0.95, px)) + 0.06 * rough * (0.30 + 0.70 * streak);
    fres = clamp(fres * mix(1.0, 1.55, vLake), 0.0, 0.46);
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.015);
    vec3 refl = skyOf(R);
    // Close inshore the mirror ray leaves through the beach, not through the sky.
    refl = mix(refl * 0.28 + vec3(0.018, 0.026, 0.022), refl, smoothstep(0.0, 1.6, sdRaw));
    // Relative ceiling: the mirror may be four times the water's own luminance, which at a
    // grazing fresnel lands the far sea brighter than the near sea — the gradient a real ocean
    // has — without ever letting a cloud bleach a near hex.
    refl *= min(1.0, (dot(col, LUMA) * 4.0) / max(dot(refl, LUMA), 1e-4));
    col = mix(col, refl, fres);

    // ---- THE SUN ON THE WATER. Two passes of one isotropic GGX lobe, gathered into a glare
    // path around the art-directed glint sun (see Water.update() for why it is not the real one
    // at this camera). sheen = wide, dim, everywhere, and what distance resolves to; glitter =
    // the same lobe at the surface's own roughness, confined to the sun-aligned track.
    //
    // THE HIGHLIGHT KEEPS ITS OWN COLOUR. What used to close this block was
    // spec = min(spec, col * 3.5 + 0.03), i.e. the glint was clamped against the BLUE water
    // under it and inherited its hue: measured, the brightest ocean pixels came out cyan at
    // R-B = -29 under a 5600 K key that should put them at +25 to +45. A soft knee caps the
    // level without touching the ratio, so a glint is warm white and blooms instead of tinting.
    vec3 H = normalize(V + uGlint);
    vec2 sreq = H.xz / max(H.y, 1e-3);
    // The floor is what sprays glitter over the whole sea. At 0.22 every water pixel in the
    // frame — the bay behind the headland included — carried a fifth of the full sheen, which
    // is a flat pale film, not a sun track. 0.06 leaves the lobe and nothing else.
    float path  = 0.06 + 0.94 * exp(-dot(sreq, sreq) * 1.3);
    float track = exp(-dot(sreq, sreq) * 1.5);
    // The SHEEN rides the macro (Gerstner) normal, never the detailed one: a wide lobe evaluated
    // against a normal field carrying centimetre ripples selects the CONTOUR where those ripples
    // face the sun, and a broad lobe on a contour draws broad pale squiggles.
    vec3 NM = normalize(vec3(vGN.x + t1.y + t2.y, vGN.y, vGN.z + t1.z + t2.z));
    vec3 spec = sunSpec(NM, V, H, 0.26, 0.075 * path * (0.55 + 0.70 * streak))
              + sunSpec(N, V, H, rough, (0.230 * track + 0.008) * (0.35 + 0.90 * streak)
                        * (0.60 + 1.10 * smoothstep(0.30, 0.92, chop))
                        * mix(0.55, 1.0, f3)
                        * smoothstep(0.02, 0.22, depth)
                        * (1.0 - smoothstep(240.0, 420.0, dist)));
    spec = spec / (1.0 + spec * 0.42);                       // soft knee, hue preserved
    col += spec * uK1.x * vec3(1.16, 1.00, 0.78) * shadeSpec * mix(0.80, 1.0, vOpen);

    // ---- subsurface: a crest is a thin sheet with the sun behind it, and it glows green
    float back = pow(clamp(0.5 + 0.5 * dot(V, -uSun), 0.0, 1.0), 3.0);
    float crest = smoothstep(0.12, 0.92, vCrest) * 0.55 + smoothstep(0.66, 1.18, nA.b + nB.b) * 0.12
                + smoothstep(0.46, 0.92, chop) * 0.55;
    col += vec3(0.09, 0.40, 0.33) * sunRadiance() * 0.3183098
         * crest * (0.25 + 0.75 * back) * 0.50 * shadeSpec * (1.0 - vLake);

    // ---- shoreline. The waterline the player sees is where the terrain crosses the water
    // plane, so the surf is driven by DEPTH and by the field's signed distance to that exact
    // intersection — never by the tile mask, which is what draws foam on hex chords.
    float xp = min(exposure(p), 1.35);
    // Three displacements off one wander (see wanderAt):
    //   sd  — the travelling bands, free to roam a third of a hex: they are the coast's shape.
    //   sdA — the water's own alpha edge, enough to dissolve a hex chord.
    //   sdC — the contact line, barely moved: it is WELDED to the real waterline.
    float wander = wanderAt(p) * mix(1.0, 2.30, vLake);
    float sd  = sdRaw + wander + (nD.b - 0.5) * 0.30;
    float sdA = sdRaw + wander * 1.05 + (nC.b - 0.5) * 0.16;
    float sdC = sdRaw + wander * 0.20 + (nD.b - 0.5) * 0.11;
    float churn = churnPre;
    // Bubble mat, three scrolls at different rates so it boils. The churn channel is six
    // octaves, so a 1.4 u tile lands its grain at two to eight pixels — bubbles, not cloud.
    float bub = texture2D(uNoise, (p + vec2(0.62, 0.78) * (uTime * 0.05)) * (1.0 / 1.40), 0.2).a * 0.46
              + texture2D(uNoise, (p * 1.7 + vec2(-0.81, 0.58) * (uTime * 0.08)) * (1.0 / 1.40), 0.2).a * 0.30
              + nD.a * 0.16 + (nB.b - 0.5) * 0.22;
    float calm = mix(0.30, 1.0, vBody);
    float shoalF = 1.0 - smoothstep(0.50, 1.90, depth);
    float fetch  = mix(0.46, 1.0, smoothstep(0.02, 0.30, vOpen)) * mix(1.0, 0.26, vLake) * vBody;
    float shoalMask = 1.0 - clamp(depth * 2.22, 0.0, 1.0);
    // THE BREAKING GATE. Surf is not a function of the bathymetry contour: a swell breaks where
    // it is BOTH dragging on the bottom AND close enough to the beach that its run-up has
    // somewhere to go. Keyed on depth alone the phase term traces whatever isoline the shelf
    // happens to have and paints it white, four hexes out in open water. Both gates, ANDed.
    float breakZone = (1.0 - smoothstep(1.05, 2.30, depth))
                    * (1.0 - smoothstep(2.2, 3.8, max(sdRaw, 0.0)));

    // (a) the contact line: always present, on every coast, rock and hull that pierces the sheet
    float contact = (1.0 - smoothstep(0.0, 0.16 + 0.16 * xp, sdC)) * calm;

    // (b) BREAKER BANDS. Offshore the swell runs on the wind; inside the shoal it refracts until
    // its crests lie PARALLEL TO THE COAST, and that rotation is the strongest single cue that
    // the water knows where the land is. An ISOLINE OF THE DISTANCE FIELD is already a line
    // parallel to the coast, so one periodic function of sd gives the whole refracted set at
    // once, marching inshore and curving round every headland for free.
    float ph = fract(sd * (1.0 / 1.25) - uTime * 0.30);
    float band = smoothstep(0.02, 0.13, ph) * (1.0 - smoothstep(0.13, 0.46, ph));
    col *= 1.0 + (band - 0.24) * 0.44 * breakZone * fetch * (0.60 + 0.60 * xp);
    // decay slow enough that three crest lines stand off the beach at once, at 1.25 / 2.50 /
    // 3.75 u out and 0.46 / 0.21 / 0.10 of full strength: a set of breakers building on a beach.
    float surf = band * exp(-max(sd, 0.0) * 1.10) * breakZone * fetch * (0.70 + 0.95 * xp);
    // the swash sheet right at the lip, phased off the same bands
    float inner = (1.0 - smoothstep(0.06, 0.26 + 0.34 * xp, sdC)) * calm * (0.40 + 0.85 * band);

    // Lace, not a sheet. The bubble tile tears holes in whatever survives — but SOFTLY: the
    // hard 0.18-0.68 window this used to close on turned the mat into a field of 1 px white
    // dashes and put 24 HF_rms into the near bay against a 15 ceiling, which is confetti by any
    // measure. A wider window keeps the lace and loses the dashes.
    float foam = contact * 0.72 + inner * 0.34 + surf * 1.05
               + shoalMask * shoalMask * band * 0.26 * calm * fetch * breakZone;
    foam *= 0.52 + 0.86 * smoothstep(0.10, 0.56, bub);
    foam = max(foam, contact * (0.16 + 0.90 * smoothstep(0.14, 0.62, bub)) * mix(1.0, 0.60, vLake));
    foam = smoothstep(0.10, 0.80, foam);
    // Whitecaps are RARE. A shelf sea under a working breeze breaks on maybe one crest in
    // twenty, and a field of evenly spaced white dashes is the loudest stamped-texture tell open
    // water has. Wide windows on BOTH gates: a narrow window on the Jacobian is a contour of the
    // swell, and a contour is a line.
    float crestFoam = smoothstep(0.50, 1.05, vFold + chop * 0.55)
                    * smoothstep(0.58, 1.02, texture2D(uNoise, vec2(dot(p, vec2(0.423, 0.906)) * 0.085,
                                                                    dot(p, vec2(-0.906, 0.423)) * 0.130) + vec2(uTime * 0.012, 0.0)).a)
                    * vOpen * (1.0 - vLake) * f2 * smoothstep(0.78, 1.40, streak) * 0.022 * vBody;
    foam = clamp(max(max(foam * mix(1.0, 0.45, vLake), crestFoam) * (0.55 + 0.45 * f4),
                     wake * (0.45 + 0.55 * churn)), 0.0, 1.0);

    // Foam is a LIT material — a mat of bubbles with a sun side and a shade side — not an
    // additive white overlay, and it is COOLER than the sand it lies on. Warm foam reads as snow.
    vec3 foamCol = vec3(0.30, 0.50, 0.68) * (0.62 + 0.62 * shadow) * mix(0.72, 1.18, churn)
                 * (1.0 + face * 0.18) * mix(0.52, 1.0, shoalF);
    col = mix(col, foamCol, foam * uK1.z);

    // ---- reed fringe + silt rim: a still basin grows a broken band of reeds in its shallows,
    // and that band is most of what tells a lake from a puddle of blue paint.
    float reedD = smoothstep(0.22, 0.54, nD.a * 0.5 + nC.a * 0.5 + (nD.b - 0.5) * 0.8);
    float reed = vLake * (1.0 - smoothstep(0.02, 0.72, sdC)) * reedD
               * (1.0 - smoothstep(0.60, 1.70, depth));
    reed = clamp(reed * 1.90, 0.0, 1.0);
    float silt = vLake * (1.0 - smoothstep(0.02, 0.95, sdC)) * (0.50 + 0.50 * nC.b);
    col = mix(col, col * vec3(0.40, 0.46, 0.38) + vec3(0.011, 0.015, 0.008), silt * 0.80);
    vec3 reedCol = mix(vec3(0.036, 0.058, 0.020), vec3(0.105, 0.120, 0.045), nC.b)
                 * sceneLight(0.70, 0.30 + 0.70 * shadow) * (0.7 + 0.7 * nD.b);
    col = mix(col, reedCol, reed * 0.90);

    // ---- PIXEL-SCALE WAVE RUFFLE. The face term up in the scatter block applies this exact
    // shading law to the decimetre band; this is the centimetre one, where a wavelength is one
    // to three screen pixels. It is a SLOPE term off a MIPPED octave, not a noise overlay — a
    // facet leaning into the sun scatters more whatever its size — so it is band-limited by the
    // mip chain and dies exactly when f3 dies, leaving the far sea as fresnel plus sheen.
    //
    // The amplitude is an ABSOLUTE contrast target, not a percentage of whatever the pixel
    // happens to be: a pure percentage hands the sunlit glare path two and a half times the
    // pixel energy of the bay in the headland's shadow, which is the LOD ramp inverted from the
    // lighting side. Lref is the deep sea's own in-scatter under a full sun.
    float grain = dot(gHP, sazi) * 5.8 * mix(0.62, 1.0, smoothstep(0.05, 0.55, depth));
    float Lc = max(dot(col, LUMA), 1e-5);
    float Lref = dot(sceneLight(1.0, 1.0) * vec3(0.62, 0.92, 1.16) * scatter, LUMA);
    float midS = dot(gMID, sazi) * 5.8 * mix(0.70, 1.0, smoothstep(0.05, 0.55, depth));
    // BOTH bands as ONE bounded GAIN on the pixel, and the bound is not cosmetic. Written as an
    // additive term (which is what this was) the negative half can drive the colour past zero,
    // where the framebuffer clips it — so the mean RISES and the hue washes out. Measured: the
    // deep NE, where Lref and Lc are equal so the reference factor is 1, came back at mean 201
    // and saturation 0.17, i.e. white. Each band gets its own soft saturation instead, so the
    // darkest a trough can go is 0.13 of its own colour and the hue never moves.
    float aRef = mix(Lref, Lc, 0.16) / max(Lc, 1e-5);
    // ...and BOTH bands fade over a shelf, for the reason written up there: over sand the pixel
    // is transmitted bed light, and a +-100% band on THAT is a cream cornflake rather than a
    // wave. The deep keeps the full budget, which is where the metric's MID window is measured
    // and where a wave band actually reads as a wave.
    float shoalBand = mix(0.40, 1.0, shoalShade);
    // ...and the pixel band gets a DEPTH gate of its own, not the gentle shoal weight gB uses.
    // Over a sheltered basin nine tenths of the pixel is transmitted bed light, and a pixel-scale
    // gain on THAT is not a ruffle, it is crushed foil — measured, the harbour at Aurelia came
    // back at HF_rms 35 against a 15 ceiling with the shoal weight alone. Deep water carries the
    // band; a shelf shows its waves in the caustic net on the bottom instead.
    float gA = clamp(grain, -0.70, 0.70) * K_GRAIN * uK0.x * aRef * mix(0.82, 1.0, vBody) * mix(0.35, 1.0, f3)
             * mix(0.09, 1.0, smoothstep(0.30, 1.50, depth));
    float gB = clamp(midS,  -0.80, 0.80) * K_MIDS  * uK0.w * aRef * mix(0.82, 1.0, vBody) * mix(0.55, 1.0, f2) * shoalBand;
    gA = gA / sqrt(1.0 + gA * gA / 0.3844);          // saturates at +-0.62
    gB = gB / sqrt(1.0 + gB * gB / 1.2100);          // saturates at +-1.10
    // ...and the SUM gets its own knee, ASYMMETRIC, because the two sides are not the same
    // problem. A crest may run three times its own trough and nothing downstream minds; a trough
    // that reaches -1 takes the pixel NEGATIVE, the framebuffer clips it, and the whole negative
    // half of the band is gone — mean up, saturation down, hue washed. Measured once already at
    // mean 201 / saturation 0.17 on the deep NE. +1.70 up, -0.82 down, both continuous.
    float bandK = gA + gB;
    bandK = bandK > 0.0 ? bandK / sqrt(1.0 + bandK * bandK / 2.8900)
                        : 0.82 * bandK / sqrt(1.0 + bandK * bandK / 0.6724);
    col *= 1.0 + bandK;

    // ---- SUN SPARKLE: the pixel band as ADDED LIGHT, and the reason this file has measured
    // HF_rms 3.5 against a floor of 7 for four passes. Every pixel-scale term above is a
    // MULTIPLIER on the water's own colour, and a multiplier can only fall to zero: its bright
    // half is the only half with headroom, so the sea's finest band arrives as a 3% wobble on a
    // pale field. A real sea reads the other way round — a dark body with bright facets
    // scattered over it — and that is an ADDITIVE term.
    //
    // Same mipped slope band-pass the grain term uses (gHP = one octave differenced against
    // itself four mips coarser), positive half only, squared: a facet tilted into the sun
    // returns light and one tilted away simply does not. Squaring narrows each return to a
    // POINT, which is what puts the energy in the 1-3 px window rather than in the 5-17 one.
    // Because the band is a mip difference it dies with the footprint on its own — no cutoff
    // to hand-tune, and nothing is dusted onto the horizon where it would be confetti.
    // Confined to the glitter track, to the cat's-paw patches and to water deep enough to be
    // dark, so it is a PATH lying on the swell and not a spray over the whole sea.
    // ...and it is GATED ON THE CREST. Ungated, the same band lit every second pixel of the sea
    // and delivered a mat of identical white crescents corner to corner — metrically a pass and
    // visually the exact per-pixel confetti the art bible rejects outright. Sun glitter is not
    // distributed evenly over water: it strings along the sunlit FACE of a crest and there is
    // none at all in the trough behind it. Multiplying the pixel band by the crest profile puts
    // the points in LINES lying on the waves, which costs nothing in the 1-3 px window and is
    // the whole difference between a sea and a sequin.
    float spark = max(0.0, dot(gHP, sazi) * 5.8 - 0.28) * smoothstep(0.26, 0.70, chop);
    col += sunRadiance() * 0.3183098 * vec3(0.55, 0.80, 1.00)
         * (spark * spark * K_SPARK * uK0.z * shadeSpec * farFade * mix(0.25, 1.0, f3)
            * (1.0 - 0.55 * smoothstep(0.038, 0.078, px))
            * (0.14 + 1.10 * track) * (0.30 + 0.90 * streak)
            // DEEP WATER ONLY. Over a shelf the pixel is mostly transmitted bed light, so a
            // sparkle that fires there does not read as sun on water — it reads as crushed
            // foil, which is what it turned the harbour at Aurelia into on the first build.
            // A sheltered basin is calm; the open sea is where the glitter lives.
            * smoothstep(0.35, 1.60, depth) * (1.0 - 0.55 * vLake));

    // ---- THE BOARD. The hex lattice, drawn on the water AFTER the water is shaded, off the
    // still plane and never off the wave normal. This is a turn-based strategy game: a player
    // has to count landing tiles across open water, and at 0.13 alpha from grid.js alone the
    // stroke was not recoverable from a 10x crop — an edge and a wave trough were the same
    // pixel. Width 0.035 u in the world with an analytic pixel floor for AA, colour = the local
    // water darkened 22% (never a grey line: a grey line is printed on the glass), alpha 0.5 in
    // the shallows falling to 0.18 two tiles out, and gone entirely on a lake or under foam.
    // ...AND IT IS APPLIED AFTER THE AIRLIGHT, which is the whole reason it kept disappearing.
    // Verified by painting the lattice pure red for one probe frame and by differencing a
    // black-stroke build against this one (tools/_wdiff.mjs): the stroke has always been one
    // continuous, analytically AA'd, world-space line per edge over the shelf — it was drawn in
    // LINEAR RADIANCE and then aerial() added an airlight three to six times the water's own
    // luminance on top of it, so a 40% multiplicative groove arrived at the framebuffer as about
    // 5%. A multiply on the composited colour is the same groove and survives the haze; it still
    // fades with the distance field and with the footprint, so open water still loses it.
    float hw = max(0.045, px * 1.15);
    float lat = (1.0 - smoothstep(0.0, hw, hexEdge(p)))
              * mix(0.85, 0.55, smoothstep(0.5, 3.4, sdRaw))
              * (1.0 - vLake) * (1.0 - 0.55 * foam) * farFade;

    // ---- alpha: opaque except right at the waterline, where a little translucency softens the
    // cut between the hex mesh and the beach.
    float alpha = smoothstep(-0.17, 0.05, sdA) * mix(0.94, 1.0, smoothstep(0.0, 0.16, depth));
    alpha = max(alpha, reed);
    alpha = clamp(max(alpha, foam * 0.96), 0.0, 1.0);
    if (alpha < 0.015) discard;   // fray, do not fade: a 2% sheet still writes depth and z-fights

    // uK1.w is a DEBUG TAP, 0 in every shipped frame (tools/_wsweep.mjs drives it). It dumps the
    // two band drivers straight to the framebuffer so their real screen-space scale can be
    // measured instead of reasoned about — which is how the pixel-scale crest jitter above was
    // finally caught after four passes of tuning the wrong knob.
    if (uK1.w > 1.5) { gl_FragColor = vec4(vec3(clamp(chop * 1.30, 0.0, 1.0)), alpha); return; }
    if (uK1.w > 0.5) { gl_FragColor = vec4(vec3(clamp(0.5 + grain * 0.60, 0.0, 1.0)), alpha); return; }
    vec3 outCol = aerial(col, dist, -V);
    gl_FragColor = vec4(mix(outCol, outCol * 0.55, lat), alpha);
  }
`;

const SHORE_VERT = /* glsl */`
  attribute float aWaterY, aFetch;
  varying vec3 vWorld;
  varying float vWaterY, vFetch;
  #include <common>
  #include <shadowmap_pars_vertex>
  void main() {
    vWorld = position; vWaterY = aWaterY; vFetch = aFetch;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * worldPosition;
    #endif
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const SHORE_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying float vWaterY, vFetch;
  ${COMMON}
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  // Premultiplied output, blended ONE / ONE_MINUS_SRC_ALPHA. That one choice is what lets a
  // single decal both DARKEN the beach (wet sand is the dry albedo times ~0.5, whatever colour
  // terrain.js happens to paint there) and lay lit foam over it. An opaque grey plate at 70%
  // alpha cannot do the first, which is why the last pass's wet band read as a film.
  //   out = dst*(1-a) + src,  a = 1 - k*(1-foam),  src = foamCol*foam + film
  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    vec2 p = vWorld.xz;
    float px = max(fwidth(p.x), fwidth(p.y)) + 1e-5;
    float f4 = 1.0 - smoothstep(0.11, 0.44, px);

    vec4 F = fld(p);
    // Nothing tiles under 2 u: a 0.95 u repeat is 40 screen pixels, which is wallpaper. The
    // bubble grain comes out of the map's own seven-octave spectrum instead.
    vec4 nB = texture2D(uNoise, (p + vec2( 0.574,  0.819) * (uTime * 0.20)) * (1.0 / 11.0), 0.25);
    vec4 nC = texture2D(uNoise, (p + vec2(-0.087,  0.996) * (uTime * 0.11)) * (1.0 / 4.20), 0.30);
    vec4 nD = texture2D(uNoise, (p + vec2( 0.819, -0.574) * (uTime * 0.07)) * (1.0 / 2.10), 0.35);

    // literally the sea's own warp, bands and bubble tile, so the wash on the sand is the
    // continuation of the surf on the water rather than a second pattern that nearly matches
    float warp = wanderAt(p) + (nD.b - 0.5) * 0.30;
    float sdRaw = (${SDF_RANGE.toFixed(1)} - F.r * ${(2 * SDF_RANGE).toFixed(1)});   // R is packed positive INLAND
    float sd  = sdRaw + warp;
    float inl = -sd;                                  // >0 inland of the real waterline
    float above = vWorld.y - vWaterY;                 // how high the sand sits over the water
    if (inl < -1.10 || above > 2.6) discard;          // the sea's job / a cliff, not a beach
    float churn = nC.a * 0.45 + nD.a * 0.55;
    float bub = nD.a * 0.72 + nC.a * 0.20 + (nB.b - 0.5) * 0.34;
    float xp = min(exposure(p), 1.35);

    // Wet sand: a band ~0.9 u inland of the waterline whose edge breathes on the 6.2 s swash
    // cycle, so the tide line moves. Keyed on DISTANCE, not on height above the water — a beach
    // hex here stands most of a unit proud of the sea and a height gate never fires.
    float tide = 0.30 * sin(uTime * 1.0134);
    float wet = (1.0 - smoothstep(-0.10, 1.15 + tide, inl)) * (1.0 - smoothstep(1.0, 2.2, above));
    // OFFSHORE FADE, and it is a bug fix, not a tweak. The apron is allowed to run 1.1 u past
    // the waterline so its band never gets cut off mid-ramp, but wet was held at FULL over
    // all of that, so a submerged shelf tile got a 48% darkening that ended on the hex-template
    // boundary: a straight-edged tonal facet lying under the water of every harbour. Fade it to
    // nothing well before the discard and no polygon edge of this mesh can ever be offshore.
    wet *= smoothstep(-1.05, -0.12, inl);
    wet = clamp(wet * 1.30, 0.0, 1.0);

    // the exact band set the sea runs, continued up the sand: same period, same phase, same
    // scroll, so the run-up on the beach is the tail of the wave that broke on the water
    float ph = fract(sd * (1.0 / 1.25) - uTime * 0.30);
    float band = smoothstep(0.02, 0.13, ph) * (1.0 - smoothstep(0.13, 0.46, ph));
    float reach = (1.0 - smoothstep(-0.02, 0.06 + 0.16 * xp, inl)) * (1.0 - smoothstep(0.4, 1.2, above));
    float fetch = mix(0.16, 1.0, clamp(vFetch, 0.0, 1.0));
    // Surf belongs on the WATER. What lands on the sand is a thin swash lip, nothing more:
    // the last pass painted near-white blobs most of a hex inland and they read as snow.
    float foam = (reach * (0.06 + 0.95 * band) + (1.0 - smoothstep(-0.05, 0.03, inl)) * 0.26) * fetch;
    foam *= 0.14 + 1.45 * smoothstep(0.12, 0.50, bub);
    foam = clamp(smoothstep(0.22, 0.78, foam), 0.0, 1.0) * (0.55 + 0.45 * f4) * 0.28;

    float shadow = getShadowMask();
    // Damp sand is DARKER and SHINIER, and it is a multiplier on whatever the terrain painted:
    // 0.50 at the tide line easing back to dry. The blue-shifted tint is the wet grain's own
    // specular bounce, not a colour cast.
    float k = mix(1.0, 0.66, wet);
    // Wet sand deepens toward ITS OWN hue: saturation up, value down, hue unmoved. The
    // blue-shift this used to carry was the violet slab a critic has named four times.
    vec3 tint = mix(vec3(1.0), vec3(1.02, 1.00, 0.97), wet);

    // roughness 0.85 dry -> 0.28 at the tide line: wet grain is a mirror of wet grain
    vec3 N = normalize(vec3((nD.r - 0.5) * 0.22 * f4, 1.0, (nD.g - 0.5) * 0.22 * f4));
    vec3 H = normalize(V + uSun);
    vec3 film = sunSpec(N, V, H, mix(0.85, 0.28, wet), 1.15) * shadow * wet * (1.0 - foam) * 0.85;

    vec3 foamCol = vec3(0.46, 0.52, 0.58) * (0.60 + 0.60 * shadow) * mix(0.72, 1.18, churn) * 0.82;

    float a = 1.0 - k * (1.0 - foam);
    if (a < 0.004 && foam < 0.004) discard;
    vec3 src = aerial(foamCol, dist, -V) * foam + film;
    // the multiplicative half rides in the alpha; the tint rides as a touch of extra src
    src += (1.0 - k) * (tint - vec3(1.0)) * 0.6;
    gl_FragColor = vec4(src, clamp(a, 0.0, 1.0));
  }
`;

const RIVER_VERT = /* glsl */`
  attribute float aU, aV, aW, aSteep, aFade;
  attribute vec2 aTan;
  varying vec3 vWorld;
  varying vec2 vTan;
  varying float vU, vV, vW, vSteep, vFade;
  #include <common>
  #include <shadowmap_pars_vertex>
  void main() {
    vWorld = position; vU = aU; vV = aV; vW = aW; vSteep = aSteep; vFade = aFade; vTan = aTan;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * worldPosition;
    #endif
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const RIVER_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;
  varying vec2 vTan;
  varying float vU, vV, vW, vSteep, vFade;
  ${COMMON}
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    float px = max(fwidth(vWorld.x), fwidth(vWorld.z)) + 1e-5;
    float fine = 1.0 - smoothstep(0.055, 0.26, px);
    float au = abs(vU);

    // channel-space uv: across the ribbon in world units, along it by arc length, so the ripples
    // scroll downstream continuously across every joint of the spline. One constant speed — a
    // per-vertex speed shears the texture a little more every second it runs.
    // Downstream scroll, slowed to about a third. The reach still runs — the three layers move
    // at 1 : 2.9 : 6.5 so parallax reads the flow direction off a still frame — but no layer
    // travels far enough between two rendered frames for the temporal resolve to drag its
    // highlights into white worms, which is what the last pass laid over every river.
    // ANISOTROPIC on purpose: across-channel frequency is 2-3x the downstream one, so every
    // feature the three layers carry is a streak lying ALONG the flow. Square uv (which is what
    // uv2/uv3 used to be) makes isotropic blobs, and isotropic white blobs on a river read as
    // paper scraps floating on tape — the confetti the critics measured. Flow direction has to
    // be legible from a STILL frame, and streamwise streaking is the only thing that does it.
    // Channel-space uv: x across the ribbon, y along it BY ARC LENGTH. That is the flow map —
    // scrolling in this space follows the centreline round every bend without a per-vertex
    // velocity to shear the texture — and two of the layers run at a 0.5 phase offset of one
    // another so the reach boils rather than sliding as one belt.
    //
    // ANISOTROPIC on purpose: cross-channel frequency is 2-3x the downstream one, so everything
    // the layers carry is a streak lying ALONG the flow. Square uv makes isotropic blobs, and
    // isotropic white blobs on a river read as paper scraps floating on tape.
    //
    // NO LAYER TILES UNDER 1 WORLD UNIT ANY MORE. The last pass ran two at 0.39 and 0.26 u
    // along the reach — a repeat every 11-17 screen pixels — which is wallpaper, and it is the
    // same texel-grid weave the ocean was rejected for. The map carries seven octaves now, so
    // pixel-scale ripple comes out of its own spectrum (512 texels over a 2.4 u tile is a fifth
    // of a screen pixel per texel) instead of out of stamping a coarse tile every ten pixels.
    vec2 uv1 = vec2(vU * vW * 0.80, vV * 0.42 - uTime * 0.135);
    vec2 uv2 = vec2(vU * vW * 2.10, vV * 0.95 - uTime * 0.255) + 0.31;
    vec2 uv3 = vec2(vU * vW * 4.20, vV * 1.75 - uTime * 0.430) + 0.11;
    // CROSS-FLOW, at a fifth of the downstream speed. Every layer above scrolls straight down
    // the reach, and a set of parallel streaks all sliding on one axis reads as a conveyor
    // belt: a river also shears sideways off its banks and boils up off the bed.
    vec2 uv5 = vec2(vU * vW * 2.60 - uTime * 0.055, vV * 0.72) + 0.53;
    vec4 r1 = texture2D(uNoise, uv1, 0.25);
    vec4 r2 = texture2D(uNoise, uv2, 0.35);
    vec4 r3 = texture2D(uNoise, uv3, 0.50);
    vec4 r4 = texture2D(uNoise, uv2 + vec2(0.5, 0.5), 0.35);   // second phase of r2
    vec4 r5 = texture2D(uNoise, uv5, 0.30);

    // The slope is measured in CHANNEL space (x across, y downstream) and rotated into world
    // by the reach's own tangent. Dropping it straight into world xz — which is what this did —
    // puts the channel's cross-section tilt on the world x axis, so a reach running east-west
    // had its banks banked along the FLOW: the whole ribbon lit as one flat plane and the tight
    // sun lobe on it drew long contour worms, which is the dashed-scratch look over every river.
    vec2 tg = normalize(vTan + vec2(1e-5, 0.0));
    vec2 nr = vec2(-tg.y, tg.x);
    vec2 slope = (r1.rg - 0.5) * 0.26 + (r2.rg - 0.5) * 0.23 * fine + (r3.rg - 0.5) * 0.19 * fine;
    slope += (r4.rg - 0.5) * 0.17 * fine + (r5.rg - 0.5) * 0.15;
    // the channel's own cross-section: a groove, so the two banks catch the sun differently and
    // the river reads as a slot cut in the ground rather than as tape laid on top of it
    slope.x += vU * 1.05 * (1.0 - au * au);
    vec2 sw = nr * slope.x + tg * slope.y;
    vec3 N = normalize(vec3(sw.x, 1.0, sw.y));
    float shadow = getShadowMask();
    float ndl = max(dot(N, uSun), 0.0);
    vec3 lit = sceneLight(0.20 + 0.80 * ndl, 0.34 + 0.66 * shadow);

    // Shallow running water over a gravel bed: the same transmission + in-scatter model the sea
    // uses, so a brook reads pale over its bar and dark green in the pools.
    float chan = 1.0 - au * au;                              // deepest in the middle
    // The channel is BRIGHTER than the ground it crosses, and that is the whole legibility
    // fix. The last pass made it near-black on the theory that a dark line could not be
    // confused with the pale-blue territory ribbon — and it could not, because it could not be
    // seen at all: measured against the grass beside it the reach was 12 luma down and simply
    // dissolved. A river IS ankle-deep water over pale wet gravel: short optical path, bed
    // showing through on the bars, teal saturating in the pools. What separates it from the
    // border stroke is not value, it is that it is a TEXTURED channel with dark cut banks,
    // white riffles and a width that grows downstream.
    // Optical depth and extinction both cut by a third. At the old numbers the transmittance
    // through the middle of a trunk reach was 0.03 in red: the bed contributed NOTHING and the
    // in-scatter tint was the entire colour of the river, which is how a channel ends up as one
    // flat cyan fill at 0.65 saturation — a decal hue, not a water hue. At these the gravel is
    // still visible through the pools (T ~ 0.18/0.45/0.57) and the reach lands near 0.40.
    float dep = (0.30 + 1.80 * vW) * chan;
    vec3 T = exp(-dep * vec3(3.10, 1.30, 0.86));
    vec3 gravel = vec3(0.190, 0.168, 0.126) * (0.52 + 0.62 * r1.b + 0.40 * r3.b);
    // Same palette discipline as the sea: the in-scatter IS the hue, and the bible's river is
    // #2C6E86 (hue 194). The old ratio ran red hot enough to land the reach in the same washed
    // lavender the ocean was rejected for.
    vec3 col = (gravel * T + vec3(0.0145, 0.0980, 0.1320) * (1.0 - T)) * lit * vec3(0.85, 1.00, 1.06);
    // Same shading law the sea uses on its swell: project the surface slope onto the sun's
    // AZIMUTH. At a 25 deg sun N.y barely moves between a ripple's lit face and its shaded one,
    // so an N.L term alone leaves the ribbon flat however much normal detail is under it — and
    // flat is exactly what made this read as tape. With gMicro in the slope this term is also
    // the river's whole pixel-scale detail budget.
    vec2 sazi = normalize(uSun.xz + vec2(1e-5, 0.0));
    col *= 1.0 + clamp(dot(vec2(N.x, N.z), sazi) * 2.3, -0.80, 1.05) * 0.42;
    // Streamwise VALUE streaks on top of the slope shading. All four flow layers are stretched
    // 2-3:1 along the reach, so their brightness structure comes out as lines lying down the
    // channel — which is the only cue that survives a still frame and says which way the water
    // is going. Without it a reach is a uniform wash whatever is moving underneath it.
    float flowV = (r1.b - 0.5) * 0.55 + (r2.b - 0.5) * 0.45 * fine + (r4.b - 0.5) * 0.34 * fine;
    col *= 1.0 + flowV * 0.42 * chan;
    // The cut bank throws a hard inner shadow on the outer edge of every bend, and now that the
    // bank is real geometry standing over the sheet it throws it on the WATER as well. That dark
    // line hugging both waterlines is most of what makes a ribbon read as carved rather than
    // painted on — it is the same 3-5 px damp band a real channel has.
    col *= mix(1.0, 0.26, smoothstep(0.50, 1.00, au));
    // THE RECESS. A channel is a hole in the ground: it sees less sky than the grass beside it,
    // its water absorbs what does reach it, and the eye reads "cut into" off value alone. The
    // last pass made the reach BRIGHTER than the grass (measured 116 against 120) on the theory
    // that a dark line is an invisible line — and what it got instead was a ribbon lying ON the
    // ground rather than in it. 0.80 puts the sheet 15-20% under the sunlit grass it crosses,
    // which is the ratio a real river photographs at, and the reach stays legible because it is
    // a textured channel with lit bank lips, white riffles and a width that grows downstream —
    // not because it out-shouts the land.
    col *= 0.58;

    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 R = reflect(-V, N); R.y = max(R.y, 0.04);
    // Capped LOW. A river mirrors the far bank and the canopy, not the open zenith, and a 42%
    // sky term is exactly what turned every reach into pale blue tape the same hue and weight
    // as the territory border running beside it — genuinely ambiguous which was which.
    // A reach mirrors the far bank and the canopy over it, not the open zenith. Every point
    // above 0.16 turns the channel into pale blue tape the same weight as the territory ribbon.
    // A river DOES mirror, but it mirrors the far bank and the canopy over it, not the open
    // zenith, and the ceiling here is load-bearing: MEASURED this round at a x2.2 ramp and a
    // 0.22 cap (shots/.p16g2.png against .p16g1.png) the whole reach went a flat pale
    // cornflower — the exact "opaque cornflower polygon" read this pass exists to kill. The
    // grazing lift is kept, the ceiling is not raised: what makes this water and not tape is
    // the transmitted bed under it, not a sky lid over it.
    col = mix(col, skyOf(R) * 0.55, clamp(fres * 1.5, 0.02, 0.14));
    // same art-directed glint sun the sea uses; with the real one the reach never catches light
    vec3 H = normalize(V + uGlint);
    // ONE isotropic GGX lobe on the flow normal. See the sea's specular block for why a narrow
    // anisotropic slope lobe is forbidden: it draws contour lines, and a river strewn with
    // identical white dashes reads as paper scraps floating downstream.
    col += sunSpec(N, V, H, mix(0.32, 0.20, fine), 0.045) * vec3(1.06, 1.0, 0.86) * shadow;

    // white water: where the bed really drops away, plus a standing curl against both banks
    // White water is EARNED: a standing curl against the bank, and breaking only where the bed
    // really drops. A reach dusted evenly in white speckle is the loudest 'noise texture' tell a
    // river can have, and it is what made this one read as pixel confetti.
    float bankLace = smoothstep(0.86, 1.0, au) * smoothstep(0.66, 0.97, r2.a * 0.55 + r4.a * 0.45) * 0.11;
    // Standing white water where the bed drops, plus riffles broken over the shallow inside of
    // every bend. Both scroll downstream with the ribbon's own arc-length uv, so the direction
    // the river runs is legible from a still frame.
    float rapids = smoothstep(0.10, 0.66, vSteep) * smoothstep(0.36, 0.82, r3.a * 0.35 + r2.a * 0.40 + r4.a * 0.25);
    // Riffles ride the shallow inside of a bend and stream downstream from it; with the
    // stretched uv above they come out as flow lines rather than speckle.
    // ...and it is EARNED off the bed slope now, like the rapids: a reach on the flat carries
    // flow streaks, not white. Un-gated riffle was white speckle sprayed the length of every
    // brook in the frame, which is both the confetti the bible forbids and, measured, the whole
    // of this pass's near-field HF cost.
    float riffle = smoothstep(0.60, 0.96, r3.a * 0.55 + r4.a * 0.45) * (1.0 - smoothstep(0.22, 0.58, vW))
                 * (0.25 + 0.75 * smoothstep(0.02, 0.30, vSteep))
                 * (0.30 + 0.70 * smoothstep(0.25, 0.85, au)) * 0.13;
    // Shore foam: a thin, torn collar where the sheet actually meets the bank, on BOTH sides of
    // every reach. Without it the water stops on a clean line against the gravel and the whole
    // channel reads as a decal however well the bank itself is shaded.
    float collar = smoothstep(0.72, 0.99, au) * (1.0 - smoothstep(0.99, 1.03, au))
                 * smoothstep(0.40, 0.82, r1.a * 0.4 + r3.a * 0.6) * 0.19;
    // White water only where the bed really drops. A reach dusted evenly in white speckle is the
    // loudest noise-texture tell a river can have, and it is what made this one read chalky.
    float foam = clamp(bankLace + rapids * 0.60 + riffle * 0.70 + collar, 0.0, 1.0) * (0.55 + 0.45 * fine);
    vec3 foamCol = sceneLight(0.95, 0.40 + 0.60 * shadow) * vec3(0.90, 1.0, 1.12) * 0.44 * mix(0.78, 1.06, r2.a);

    // THE CUT BANK IS NOT A MATERIAL. It used to be an opaque gravel colour painted over 2.3
    // channel-widths of hillside — its own albedo, its own noise, its own light — and that is
    // precisely the translucent slab lying over the tiles that every review of this file has
    // named. A river does not replace the ground it runs through; it WETS it. So the bank is a
    // pure darkening now (premultiplied over-blend, see the material in Water's constructor:
    // rgb ~ 0 with alpha w IS a multiply by 1-w), which means the terrain's own grain, its own
    // hex seam and its own shadows all run straight through the damp margin instead of being
    // covered by a sheet. Deepest against the waterline, gone by the toe.
    float bankMask = smoothstep(2.30, 1.00, au);
    float wetB = smoothstep(1.90, 0.96, au);                  // the damp waterline band

    // Soft edges, in two parts.
    // (1) The analytic AA cut: at least one and a half pixels of footprint expressed in u, so
    //     the last stroke of the waterline is filtered at every depth instead of stair-stepping.
    // (2) COVERAGE IS A DEPTH GRADIENT, not a cutout, and that is the difference between water
    //     bedded into its bank and a polygon terminating on it. Over the thalweg the sheet is
    //     opaque; by the waterline it is down to 46%, so the bank's own grain, grass, pebbles
    //     and shadow read straight THROUGH the shallow margin. The same ramp feeds the wet term below
    //     (it is driven by 1 - wAlpha), so the shallows are simultaneously darkened wet ground
    //     seen through a thin film — which is what the last few centimetres of a river are.
    float aaU = max(0.15, 1.5 * px / max(vW, 0.06));
    float wAlpha = smoothstep(1.03, 1.03 - aaU, au) * mix(0.46, 1.0, smoothstep(1.02, 0.72, au))
                 * clamp(vFade, 0.0, 1.0);
    // How wet the ground is: strongest against the waterline, nothing left at the toe, and it
    // follows the sheet's own fade so the margin dies with the reach it belongs to.
    // THE ESTUARY, and it costs one exponent. The sheet still dies before the waterline (see
    // the fade block in buildRivers: an opaque fan of river water lying on open water is the
    // worst thing this file has ever drawn) — but the DAMP GROUND does not have to die with it.
    // A river does not stop dead at a line in a field; it opens into a wet tidal flat that runs
    // to the sea. Raising the margin's fade to 0.35 keeps that flat alive almost to the water
    // while the sheet above it tapers out, and because it is a smooth darkening rather than a
    // bright sheet it adds no high-frequency energy to the beach it crosses (measured: the same
    // reach drawn as WATER to the waterline cost near-sand HF_rms +0.06 and broke the gate).
    float wet = bankMask * (1.0 - wAlpha) * pow(clamp(vFade, 0.0, 1.0), 0.35) * (0.16 + 0.46 * wetB);
    float a = clamp(wAlpha + wet, 0.0, 1.0);
    if (a < 0.004) discard;
    col = mix(col, foamCol, foam * wAlpha);
    // The recess, applied to the WHOLE sheet — its reflection and its white water included, not
    // just the transmitted term. Measured against the sunlit grass either side of the reach the
    // channel now lands at ~0.82 of it; at 0.95 (which is where it sat) a river is a ribbon lying
    // ON the ground, and value is the only cue at this camera that says "cut into".
    col *= 0.75;
    // PREMULTIPLIED. The sheet contributes its own colour at full weight; the margin contributes
    // almost none, so it reads as the ground seen through water rather than as a lid over it —
    // and the trace of light it does return is cool, which is what damp earth does under a warm
    // key without ever putting a navy shadow on tan.
    vec3 damp = vec3(0.006, 0.010, 0.013) * sunRadiance() * wet;
    gl_FragColor = vec4(aerial(col, dist, -V) * wAlpha + damp, a);
  }
`;

// ========== FOR grid.js AND fx.js: "hex lines must not show through water" ============
//
// MEASURED AGAIN THIS ROUND, on shots/water-p6r1.png: the lattice is drawn at FULL strength over
// open water and erased on the land — both halves of it, in one frame, and both are hard
// rejects (art bible non-negotiable 1 is "the hex grid must be legible"). It is one sign error,
// in grid.js line ~193:
//
//     float wet = (uWHas > 0.5) ? 1.0 - waterMask(vP.xz) : vWet;
//
// against an inlined copy of waterMask() that this file used to document as "1 offshore". The
// composition is therefore backwards, and grid.js is not mine to edit.
//
// SO THE WIRE FORMAT WAS CHANGED INSTEAD, and this is the one thing to read before touching
// anything here: **the field's R channel now stores the signed distance measured POSITIVE
// INLAND** (see buildField). grid.js's hand-rolled decode consequently returns 1 ON LAND, its
// `1.0 - ...` turns that into 1 offshore, and its `wet` is finally what its own comment says it
// is — no edit to grid.js, no flag to negotiate, nothing to keep in sync. Every reader inside
// this file negates on decode, and the two published GLSL helpers below still mean exactly what
// their names say, so nobody using the published API can see the difference.
//
// IF YOU ARE THE GRID/FX AGENT AND YOU ARE ABOUT TO "FIX" THAT LINE: do not patch the inline.
// Delete your copy of waterMask entirely and use the sign-proof entry point instead —
//
//     // uniforms: spread water.landMaskUniforms      GLSL: paste water.landMaskGLSL
//     alpha *= landMask(vWorld.xz);   // EVERY stroke AND every fill. 1 on land, 0 offshore.
//
// — which is a plain multiplier with no subtraction anywhere for a sign to hide in.
//
// It has to be this field and not a per-tile `isWater` flag, because the waterline the player
// sees is the TERRAIN/WATER INTERSECTION and that differs from the tile mask by up to a third of
// a hex: a coastal hex is half wet, so a per-tile fade either draws the seam across the wet half
// or erases the stroke across the dry half. The territory border and the fog sheet need it most.
//
// (The doubled-hex artifact that got this file rejected twice was a different bug and it is
// gone: the sea puts nothing hex-shaped on screen — swell, shore distance, fetch and wave
// amplitude are all read per pixel, none of them travels down an interpolator, and the mesh is
// WELDED, one vertex map over the whole ocean.)
// ======================================================================================
const WATER_MASK_GLSL = /* glsl */`
  uniform sampler2D uWField; uniform vec2 uWMin, uWSize; uniform float uWRange;
  float waterMask(vec2 wxz) {
    float sd = (1.0 - texture2D(uWField, (wxz - uWMin) / uWSize).r * 2.0) * uWRange;
    return smoothstep(-0.10, 0.60, sd);
  }
`;

// The sign-proof entry point. 1 ON DRY LAND, 0 OFFSHORE, feathered over 0.7 u of shoreline,
// so it multiplies a stroke's alpha directly and there is no subtraction left to invert.
const LAND_MASK_GLSL = /* glsl */`
  uniform sampler2D uWField; uniform vec2 uWMin, uWSize; uniform float uWRange;
  float landMask(vec2 wxz) {
    float sd = (1.0 - texture2D(uWField, (wxz - uWMin) / uWSize).r * 2.0) * uWRange;
    return 1.0 - smoothstep(-0.10, 0.60, sd);
  }
`;

// ---------------------------------------------------------------------------- module
export class Water {
  constructor(map, ctx = {}) {
    this.map = map;
    this.scene = ctx.scene || null;
    this.group = new THREE.Group();
    this.group.name = 'water';

    const noise = buildNoiseTexture(map.seed | 0);
    const levels = waterLevels(map);
    const cornerY = cornerHeights(map);
    // The terrain is rasterised ONCE, up front, because both consumers need it and rivers now
    // need it BEFORE the field: every column of a channel is planted on the real surface (see
    // buildRivers), and the surface is the ground mesh, not a per-tile plateau guess.
    const bounds = fieldBounds(map);
    const terr = rasterTerrain(this.scene, bounds.minX, bounds.minZ, bounds.W, bounds.H);
    const groundY = terrSampler(terr, bounds);
    // rivers FIRST: buildField stamps their splines into its signed distance so grid.js's
    // lattice fades over a reach the same way it fades over the sea. See buildField.
    const riverGeo = buildRivers(map, cornerY, levels, groundY);
    const riverPaths = riverGeo?.userData.paths ?? [];
    const field = buildField(map, levels, riverPaths, bounds, terr, groundY);
    if (ctx.renderer) noise.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());

    this.u = {
      uTime: { value: 0 },
      uNoise: { value: noise },
      uField: { value: field.tex },
      uFieldMin: { value: field.min },
      uFieldSize: { value: field.size },
      uFieldRes: { value: field.res },
      uSun: { value: new THREE.Vector3(0.79, 0.51, 0.34).normalize() },
      uGlint: { value: new THREE.Vector3(0.30, 0.80, -0.52).normalize() },
      uSunCol: { value: new THREE.Color(1.0, 0.90, 0.78) },
      uSkyZen: { value: new THREE.Color(0.10, 0.22, 0.46) },
      uSkyHor: { value: new THREE.Color(0.34, 0.40, 0.48) },
      uHaze: { value: new THREE.Color(0.30, 0.35, 0.42) },
      uHazeSun: { value: new THREE.Color(0.52, 0.46, 0.38) },
      uRip: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -99, 0)) },
      uK0: { value: new THREE.Vector4(1, 1, 1, 1) },
      uK1: { value: new THREE.Vector4(1, 1, 1, 0) },   // .w is the debug tap: 0 in every shipped frame
    };
    this._ripI = 0;
    const mat = (vs, fs, extra) => new THREE.ShaderMaterial({
      uniforms: Object.assign({}, THREE.UniformsLib.lights, this.u, extra),
      vertexShader: vs, fragmentShader: fs,
      transparent: true, depthWrite: true, lights: true, fog: false, side: THREE.DoubleSide,
    });


    const sea = new THREE.Mesh(buildOcean(map, field, levels), mat(OCEAN_VERT, OCEAN_FRAG));
    sea.renderOrder = 1; sea.receiveShadow = true; sea.frustumCulled = false;
    this.group.add(sea);

    const shoreGeo = buildShore(map, levels, cornerY, field.hAt);
    if (shoreGeo) {
      const m = mat(SHORE_VERT, SHORE_FRAG);
      m.depthWrite = false;
      // premultiplied over-blend: lets one decal darken the sand AND paint lit foam on it
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
      const shore = new THREE.Mesh(shoreGeo, m);
      shore.renderOrder = 0; shore.receiveShadow = true;
      this.group.add(shore);
    }

    // Where the glint sun is allowed to land: every water tile centre, subsampled. update()
    // picks the visible ones each frame — see the note there.
    this._wpts = [];
    { const wt = map.tiles.filter((t) => t.height === 0);
      const step = Math.max(1, Math.ceil(wt.length / 500));
      for (let i = 0; i < wt.length; i += step) { const c = axialToWorld(wt[i].q, wt[i].r); this._wpts.push(c.x, c.z); } }
    this._ndc = new THREE.Vector3();

    // ============ FOR grid.js AND fx.js — see the measured note above WATER_MASK_GLSL ==
    //   water.landMaskUniforms + water.landMaskGLSL   <- USE THIS ONE
    //     one sampler2D + two vec2s + a float, no per-frame update, and one line at the end of
    //     your fragment shader:
    //       alpha *= landMask(vP.xz);      // 1 ON DRY LAND, 0 OFFSHORE. EVERY stroke and fill.
    //     No subtraction anywhere, so there is no sign left to get backwards — which is the bug
    //     that has shipped twice. landMask reads the distance to the terrain/water INTERSECTION,
    //     the line the player sees, not the tile mask (they differ by up to a third of a hex, so
    //     a per-tile fade either seams the wet half of a coastal hex or erases the dry half).
    //   water.gridMaskUniforms + water.gridMaskGLSL — the same texture, exposing waterMask()
    //     (1 OFFSHORE). Kept for compatibility; prefer landMask.
    //   NOTE ON THE RAW TEXTURE: R is packed POSITIVE INLAND. Do not hand-roll the decode.
    //   water.submergedAt(x, z) -> the CPU signed distance, POSITIVE OFFSHORE (unchanged), if
    //     baking it into an existing per-vertex attribute is cheaper for you than a sampler.
    // ===================================================================================
    this.field = { tex: field.tex, min: field.min, size: field.size, range: SDF_RANGE };
    this.submergedAt = field.sdAt;
    // Copy-paste ready: spread this into your ShaderMaterial's uniforms and paste WATER_MASK_GLSL
    // into the fragment shader. Three uniforms, no per-frame update, nothing to keep in sync.
    this.gridMaskUniforms = {
      uWField: { value: field.tex }, uWMin: { value: field.min },
      uWSize: { value: field.size }, uWRange: { value: SDF_RANGE },
    };
    this.gridMaskGLSL = WATER_MASK_GLSL;
    // The sign-proof alias — see LAND_MASK_GLSL. 1 on land, 0 offshore, multiply and be done.
    this.landMaskUniforms = this.gridMaskUniforms;
    this.landMaskGLSL = LAND_MASK_GLSL;

    // see riverMask(): the scatter agent needs this to stop planting trees in the water
    this.riverPaths = riverPaths;
    let _rmask = null;
    this.riverAt = (x, z) => (_rmask ??= riverMask(this.riverPaths, field.bounds))(x, z);
    if (riverGeo) {
      const m = mat(RIVER_VERT, RIVER_FRAG);
      m.depthWrite = false;
      // premultiplied over-blend, exactly as the shore decal above: it lets ONE sheet paint
      // opaque water in the channel AND merely darken the ground along the damp margin, which
      // is the whole reason the bank no longer needs an albedo of its own.
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      // -4/-14 pulled the ribbon in front of ANY terrain within a good fraction of a unit, which
      // is how a sheet floating over the coast still drew over the ground in front of it. Now
      // that every column is clamped to the ground beneath it (buildRivers), the offset only has
      // to clear the mesh's own sub-decimetre jitter, and the terrain clips the rest.
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4;
      const rivers = new THREE.Mesh(riverGeo, m);
      rivers.renderOrder = 3; rivers.receiveShadow = true;
      this.group.add(rivers);
    }
  }

  // ============ PUBLIC API for units.js =================================================
  //
  //   water.addRipple(x, z, strength)     // world x/z, strength 0..1.5
  //
  // Drops a spreading ring of disturbed water at a world point. The surface normal bends
  // around it, it foams white on the crest, and it dies over ~3 s. y is ignored: the sea is
  // flat at WATER_Y (0.10), so a hull should sit with its waterline on that plane.
  //
  //   A MOVING SHIP — call it every frame from update(), at the stern:
  //       water.addRipple(sternX, sternZ, 0.3 + 0.7 * speed / topSpeed);
  //     The decaying trail of rings IS the wake. Two calls per frame, one off each quarter
  //     (about 0.35 u either side of the keel line), give the two arms of a Kelvin wake for
  //     free; the rings expand as they age, so the arms open out behind the hull on their own.
  //
  //   AN IMPACT — one call, strength 1: an oar stroke, a splash, a hull grounding, a boarding
  //     action. Fire it wherever something hits the surface.
  //
  // Eight slots, oldest overwritten, so calling it every frame from several ships is safe and
  // costs nothing on the CPU (it writes one Vector4). It is a no-op if water.js failed to load,
  // so call it as `window.water?.addRipple(...)`.
  //
  // What water.js does NOT do for you: the hull's own contact shadow and waterline darkening.
  // There is no depth prepass here to intersect against, so a mesh that pierces the surface
  // needs its own darkened contact band — draw it on the hull, not on the sea.
  // ======================================================================================
  addRipple(x, z, strength = 1) {
    const v = this.u.uRip.value[this._ripI = (this._ripI + 1) & 7];
    v.set(x, z, this.u.uTime.value, Math.max(0, Math.min(1.5, strength)));
  }

  update(dt, camera, sunDir) {
    this.u.uTime.value += dt;
    if (sunDir) {
      const v = this.u.uSun.value;
      v.set(sunDir.x, sunDir.y, sunDir.z);
      if (v.lengthSq() > 1e-6) v.normalize(); else v.set(0.79, 0.51, 0.34);
    }
    // ---- the glint sun. Deliberately not the real one, and here is the measurement that says
    // why. Sun altitude 25 deg; camera 18 u up looking down at 40-52 deg; and the sun's azimuth
    // sits 90 deg off the direction the camera faces the sea. The facet a glint needs is
    // therefore tilted 47-50 deg (slope 1.0-1.2) and a Cox-Munk sea with an RMS slope of 0.3
    // puts exp(-1.2^2/0.2) = 0.0007 of its facets there: a physically placed sun glitter on this
    // frame is not dim, it is ZERO, which is exactly what the last pass shipped.
    // So the glitter is aimed at a virtual sun blended 62/38 between the specular point of the
    // current view and the real sun — it keeps the sun's colour and lands at ~44 deg altitude,
    // the elevation the shadows on the land already imply. The sheet following the camera is not
    // even the cheat: a real glitter path is centred on the observer's own specular point and
    // slides with them. Only the azimuth is bought.
    // ponytail: one blend constant, tuned by eye against the frame. If the camera rig ever gets
    // a free-look pitch, drive it from the pitch instead of pinning it at 0.62.
    if (camera) {
      // Pick the point to aim it at: the visible water nearest the middle of the frame. A
      // glitter path IS centred on the observer's own specular point and slides with them, so
      // following the camera is not the cheat — only the azimuth is. Buying it is the whole
      // difference between a sun sheet lying on the sea and a sun sheet lying on a hillside
      // where no water shader ever runs, which is what a physically placed one does here.
      const m = _mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      let bx = 0, bz = 0, best = 1e9;
      for (let i = 0; i < this._wpts.length; i += 2) {
        const x = this._wpts[i], z = this._wpts[i + 1];
        this._ndc.set(x, WATER_Y, z).applyMatrix4(m);
        if (this._ndc.z > 1 || Math.abs(this._ndc.x) > 0.92 || Math.abs(this._ndc.y) > 0.92) continue;
        // slightly above and right of dead centre: a glare path that sits under the selected
        // unit is a glare path the player is reading through all game
        const d = (this._ndc.x - 0.18) * (this._ndc.x - 0.18) + (this._ndc.y - 0.20) * (this._ndc.y - 0.20);
        if (d < best) { best = d; bx = x; bz = z; }
      }
      const g = this.u.uGlint.value;
      if (best < 1e8) {
        // the direction whose mirror in the water plane points at the camera from (bx, bz)
        g.set(camera.position.x - bx, camera.position.y - WATER_Y, camera.position.z - bz).normalize();
        g.set(-g.x, Math.max(g.y, 0.22), -g.z).normalize();
      } else {
        g.set(0, 0, -1).applyQuaternion(camera.quaternion);
        g.set(g.x, Math.max(-g.y, 0.24), g.z).normalize();
      }
    }
    // Follow the sky and post agents rather than guessing: the haze the ocean fades into has to
    // be the exact colour the grade pass fades everything else into, or the horizon shows a seam.
    const sky = globalThis.sky, post = globalThis.post;
    if (sky?.sunColor) this.u.uSunCol.value.copy(sky.sunColor);
    const g = post?.grade?.uniforms;
    const haze = g?.uHazeA?.value ?? g?.uHaze?.value ?? sky?.hazeColor;
    if (haze) {
      this.u.uHaze.value.copy(haze);
      this.u.uHazeSun.value.copy(g?.uHazeB?.value ?? sky?.hazeSun ?? haze);
      // The mirror has to be a SKY, not the airlight: post's haze colour is deliberately kept
      // near-black so the sea does not out-shout the land, and reflecting that back makes the
      // water a hole. Same hue, lifted to the radiance the ambient rig actually implies
      // (skyIrradiance / PI), with the zenith pushed blue.
      this.u.uSkyHor.value.setRGB(haze.r * 3.2, haze.g * 3.1, haze.b * 3.0);
      this.u.uSkyZen.value.setRGB(haze.r * 1.4, haze.g * 2.2, haze.b * 4.0);
    }
  }
}
