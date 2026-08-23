// AEON — procedural world generator.
//
// Deterministic from `seed`, ~150ms for 64x44. Pipeline:
//   1. plates     — 11 drifting Voronoi plates. One hero convergent pair is planted across the
//                   middle of the map so the playable centre always gets a real cordillera.
//   2. orogeny    — convergent boundaries raise ranges with an asymmetric cross-section and a
//                   WIDE foothill skirt (~6 hexes); divergent ones rift; ocean-ocean convergence
//                   builds island arcs; the oceanic side of a subduction zone gets a trench.
//   3. erosion    — thermal talus + 4 rounds of stream-power incision (flow-accumulation driven),
//                   which turns raw uplift into ridgelines, V-valleys and talus fans.
//   4. coastline  — a crinkle band applied only near the future shoreline: bays, capes, fjords,
//                   skerries, so the silhouette is never a noise blob.
//   5. hypsometry — land elevation is the PERCENTILE RANK of the eroded field (a monotone
//                   transform: it cannot introduce spatial artefacts) pushed through an Earth-like
//                   hypsometric curve, then diffused once. That is what puts real ground between
//                   the coastal plain and the summits instead of a pancake with a wall on it.
//   6. shelf      — ocean depth from distance-to-coast: shallow shelf, shelf break, abyss.
//   7. climate    — latitude bands (equator biased toward the near field) + altitude lapse +
//                   two-way prevailing-wind moisture transport driven by REAL altitude, so rain
//                   falls on the windward face and the lee runs to desert.
//  7b. surface    — the drawn height field: hypsometric curve + lowland swales + crest relief +
//                   dunes on arid ground. Built BEFORE the hydrology, because water routed on a
//                   different surface than the one you draw comes out as parallel rills.
//   8. hydrology  — priority-flood, lakes WITH OUTLETS (flow routes across a lake surface and
//                   leaves at the spill point), corner-lattice D8 flow accumulation, rivers on hex
//                   EDGES with discharge-scaled width, no open channel above the rock line,
//                   floodplain corridors, gorge incision, estuaries at the mouths.
//   9. biomes     — Whittaker table + altitude bands (lowland -> hills -> alpine tundra -> rock ->
//                   snow), forest/grass split by a woodland mask so forests have edges and
//                   clearings, and a hard rule that peaks always sit inside a foothill ring.
//  10. detail     — continents, features and resources by biome plausibility.
//
// Tile: { q, r, i, elev 0..1, height (world y, 0 for water), biome, temp, moist,
//         river (6-bit edge mask), riverFlow 0..1, resource|null, feature|null, continent }

import { fbm2, mulberry32, hash2 } from '../core/rng.js';
import { DIRS } from './hex.js';

export const BIOMES = ['ocean', 'coast', 'beach', 'grass', 'plains', 'desert', 'tundra', 'snow', 'forest', 'jungle', 'hills', 'mountain'];
const OCEAN = 0, COAST = 1, BEACH = 2, GRASS = 3, PLAINS = 4, DESERT = 5, TUNDRA = 6, SNOW = 7, FOREST = 8, JUNGLE = 9, HILLS = 10, MOUNTAIN = 11;

const SQRT3 = Math.sqrt(3);
const SEA = 0.42;                // sea level in elev space (consumers read map.seaLevel)
const LAND_FRACTION = 0.365;     // fraction of the grid above sea level, before lakes
const PEAK_Y = 6.4;              // world height of the highest summit (drives shadow length)
const LAT_EQ = 0.76;             // row fraction where the equator sits; poleward toward r = 0
const LAT_SPAN = 0.86;           // rows-fraction from the equator to the pole

// Band thresholds as percentiles of the land hypsometry. Hills get a generous share because a
// 4X map reads as terrain, not as a plain with a fence across it.
const P_HILL = 0.700, P_MOUNT = 0.893, P_SNOW = 0.966;

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const bell = (x, c, s) => { const t = (x - c) / s; return Math.exp(-t * t); };
const ridge = (x, y, o) => 1 - Math.abs(fbm2(x, y, o) * 2 - 1);   // 0..1, creases at the top

// Earth-like hypsometric curve. u is the land percentile rank, result is 0..1 of PEAK_Y:
// broad coastal plains, a long rolling middle, a compact hill belt, a thin band of summits.
const hyp = u => 0.185 * Math.pow(u, 1.30) + 0.815 * Math.pow(u, 5.2);

// A corner of a flat-top hex (index c = angle 60c) lands on an integer lattice:
//   X = 3q + CX[c],  Y = 2r + q + CY[c]  — the 3 hexes meeting there agree on one key.
const CX = [2, 1, -1, -2, -1, 1];
const CY = [0, 1, 1, 0, -1, -1];
// DIRS runs clockwise, so edge d of a hex is bounded by corners ECA[d] and ECB[d].
const ECA = [0, 5, 4, 3, 2, 1];
const ECB = [1, 0, 5, 4, 3, 2];

// --- binary min-heap (float key, int payload), shared by every priority flood ---
function heap(cap) {
  const k = new Float64Array(cap), v = new Int32Array(cap);
  let n = 0;
  return {
    get size() { return n; },
    push(key, val) {
      let i = n++; k[i] = key; v[i] = val;
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; const tk = k[p], tv = v[p]; k[p] = k[i]; v[p] = v[i]; k[i] = tk; v[i] = tv; i = p; }
    },
    pop() {
      const top = v[0]; n--;
      if (n > 0) {
        k[0] = k[n]; v[0] = v[n];
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let s = i;
          if (l < n && k[l] < k[s]) s = l;
          if (r < n && k[r] < k[s]) s = r;
          if (s === i) break;
          const tk = k[s], tv = v[s]; k[s] = k[i]; v[s] = v[i]; k[i] = tk; v[i] = tv; i = s;
        }
      }
      return top;
    },
  };
}

// Priority flood (Barnes 2014): lift every cell to the lowest spill level that still drains to
// a seed, so afterwards every non-seed cell has a strictly downhill path out.
function fillDepressions(elev, seeds, adjStart, adjList, count, eps, out) {
  const filled = out || new Float32Array(count);
  const done = new Uint8Array(count);
  const H = heap(count + 8);
  for (let i = 0; i < count; i++) if (seeds[i]) { filled[i] = elev[i]; done[i] = 1; H.push(elev[i], i); }
  while (H.size) {
    const i = H.pop();
    for (let a = adjStart[i]; a < adjStart[i + 1]; a++) {
      const j = adjList[a];
      if (j < 0 || done[j]) continue;
      done[j] = 1;
      filled[j] = elev[j] > filled[i] ? elev[j] : filled[i] + eps;
      H.push(filled[j], j);
    }
  }
  for (let i = 0; i < count; i++) if (!done[i]) filled[i] = elev[i];
  return filled;
}

export function generateMap({ w = 64, h = 44, seed = 1337 } = {}) {
  const n = w * h;
  const rand = mulberry32(seed >>> 0);
  const idx = (q, r) => r * w + q;
  const inBounds = (q, r) => q >= 0 && r >= 0 && q < w && r < h;
  const QOF = new Int32Array(n), ROF = new Int32Array(n);

  // flat neighbour table (-1 = off map): no per-tile allocation anywhere downstream
  const NB = new Int32Array(n * 6).fill(-1);
  const WX = new Float32Array(n), WZ = new Float32Array(n);
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) {
    const i = idx(q, r);
    QOF[i] = q; ROF[i] = r;
    WX[i] = 1.5 * q; WZ[i] = SQRT3 * (r + q * 0.5);
    for (let d = 0; d < 6; d++) { const nq = q + DIRS[d].q, nr = r + DIRS[d].r; if (inBounds(nq, nr)) NB[i * 6 + d] = idx(nq, nr); }
  }
  const MW = 1.5 * (w - 1), MH = SQRT3 * (h - 1);
  const CXW = MW * 0.5, CZW = SQRT3 * ((h - 1) + (w - 1) * 0.5) * 0.5;
  const hexStart = new Int32Array(n + 1);                    // CSR view of NB
  for (let i = 0; i <= n; i++) hexStart[i] = i * 6;

  // ---------------------------------------------------------------- 1. plates
  // The hero pair is planted either side of a line that crosses the middle of the map slightly
  // beyond the default camera target, so the main cordillera always lands in the mid-distance
  // with room for its foothills, its rivers and a coastal plain in front of it. Everything else
  // is scattered, which is what supplies the margins with arcs, rifts and trenches.
  const px = [], pz = [], pvx = [], pvz = [], pCont = [], pBase = [];
  const addPlate = (x, z, vx, vz, cont) => {
    px.push(x); pz.push(z); pvx.push(vx); pvz.push(vz); pCont.push(cont);
    pBase.push(cont ? 0.17 + rand() * 0.05 : -0.42 - rand() * 0.10);
  };
  const ORO_Z = SQRT3 * (16 + w * 0.25);       // world z of the hero belt ~ tile row 16
  const tilt = (rand() - 0.5) * 0.80;          // +-23 degrees, so the range is never dead level
  const HNX = Math.sin(tilt), HNZ = Math.cos(tilt);
  {
    const R = 33;
    addPlate(CXW + HNX * R, ORO_Z + HNZ * R, -HNX * 1.30, -HNZ * 1.30, 1);
    addPlate(CXW - HNX * R, ORO_Z - HNZ * R, HNX * 1.15, HNZ * 1.15, 1);
  }
  for (let tries = 0; px.length < 11 && tries < 900; tries++) {
    const x = (rand() * 1.34 - 0.17) * MW, z = (rand() * 1.34 - 0.17) * MH;
    let ok = true;
    // nothing may squat on the hero boundary across the playable middle, or the Voronoi cell it
    // steals moves the whole cordillera somewhere the camera never looks
    if (Math.abs((x - CXW) * HNX + (z - ORO_Z) * HNZ) < 26 && Math.abs(x - CXW) < 0.42 * MW) continue;
    for (let k = 0; k < px.length; k++) { const dx = x - px[k], dz = z - pz[k]; if (dx * dx + dz * dz < 22 * 22) { ok = false; break; } }
    if (!ok) continue;
    const ang = rand() * Math.PI * 2, s = 0.55 + rand() * 0.85;
    // plates near the middle skew continental so the main landmass sits under the camera
    const dc = Math.hypot(x - CXW, z - CZW) / 60;
    addPlate(x, z, Math.cos(ang) * s, Math.sin(ang) * s, rand() < 0.82 - dc * 0.70 ? 1 : 0);
  }
  const NPL = px.length;

  // -------------------------------------------------- 2. orogeny + base relief
  // fbm option objects are hoisted: constant per pass, and allocating one per tile was the
  // single biggest source of GC churn in this file.
  const oWarpA = { octaves: 4, seed: seed + 11 }, oWarpB = { octaves: 4, seed: seed + 23 };
  const oCrest = { octaves: 4, seed: seed + 91 }, oSeg = { octaves: 3, seed: seed + 137 };
  const oGA = { octaves: 3, seed: seed + 5 }, oGB = { octaves: 3, seed: seed + 7 };
  const oCont = { octaves: 5, seed }, oDet = { octaves: 5, seed: seed + 313 };
  const oIsl = { octaves: 4, seed: seed + 555 }, oCrink = { octaves: 4, seed: seed + 881 };
  const oShelf = { octaves: 3, seed: seed + 1201 }, oWood = { octaves: 3, seed: seed + 2027 };

  const E = new Float32Array(n), UP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nx = WX[i] / MW, nz = WZ[i] / MH;
    // domain warp: plate boundaries become organic curves instead of Voronoi straight lines
    const wx = WX[i] + (fbm2(nx * 2.3, nz * 2.3, oWarpA) - 0.5) * 13 + (fbm2(nx * 6.1, nz * 6.1, oWarpA) - 0.5) * 5.5;
    const wz = WZ[i] + (fbm2(nx * 2.3 + 5.7, nz * 2.3 + 2.3, oWarpB) - 0.5) * 13 + (fbm2(nx * 6.1 + 1.7, nz * 6.1, oWarpB) - 0.5) * 5.5;

    let p1 = 0, p2 = 0, d1 = 1e9, d2 = 1e9;
    for (let k = 0; k < NPL; k++) {
      const dx = wx - px[k], dz = wz - pz[k], d = dx * dx + dz * dz;
      if (d < d1) { d2 = d1; p2 = p1; d1 = d; p1 = k; }
      else if (d < d2) { d2 = d; p2 = k; }
    }
    d1 = Math.sqrt(d1); d2 = Math.sqrt(d2);
    const bd = (d2 - d1) * 0.5;                        // ~ distance to the plate boundary

    // relative plate motion resolved on the p1 -> p2 axis: positive = converging
    let ax = px[p2] - px[p1], az = pz[p2] - pz[p1];
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    const conv = (pvx[p1] - pvx[p2]) * ax + (pvz[p1] - pvz[p2]) * az;
    const cc = pCont[p1] + pCont[p2];

    // Asymmetric cross-section: steep on one flank, long ramp on the other. Which flank a cell
    // sits on is exactly "which plate owns it", so this costs nothing.
    const steep = cc === 1 ? !pCont[p1] : p1 < p2;
    const bdC = bd * (steep ? 1.55 : 0.66);
    const crest = Math.exp(-bdC / 1.55);                     // ~3-4 hex wide spine
    // The skirt is the whole point: an exponential ramp ~6 hexes deep on each side, carrying
    // roughly a third of the crest amplitude, so elevation RAMPS into the range.
    const foot = Math.exp(-bd / 9.0);
    const apron = Math.exp(-bd / 20.0);                      // the broad tectonic swell under it

    // along-strike variation: ridged noise creases the crest into peaks and passes, and a
    // slower band breaks the belt into massifs separated by real saddles you could walk through.
    const rg = 0.30 + 0.90 * ridge(wx * 0.115, wz * 0.115, oCrest);
    const seg = 0.22 + 1.05 * fbm2(wx * 0.040 + 12.3, wz * 0.040 + 4.1, oSeg);

    let up = 0;
    if (conv > 0.02) {
      const c = conv;
      if (cc === 2) up = c * (crest * 1.70 * rg * seg + foot * 0.62 * seg + apron * 0.19);   // collision
      else if (cc === 1) up = pCont[p1]
        ? c * (crest * 1.45 * rg * seg + foot * 0.52 * seg + apron * 0.16)                   // cordillera
        : -c * (crest * 0.55 + foot * 0.05);                                                 // trench
      else up = c * (crest * 1.32 * rg * seg + foot * 0.14 - apron * 0.08);                  // island arc
    } else if (conv < -0.02) {
      const c = -conv;
      if (cc === 2) up = -c * crest * 0.42 + c * foot * 0.26;                                // rift + shoulders
      else if (cc === 0) up = c * crest * 0.26 - c * foot * 0.10;                            // mid-ocean ridge
      else up = -c * crest * 0.10;                                                           // passive margin
    }
    UP[i] = up;

    // plate crust height, cross-faded over the boundary so cells never show as facets
    const base = lerp(pBase[p2], pBase[p1], 0.5 + 0.5 * sstep(0, 10, bd));
    // continent-scale shape, domain warped so the silhouette is not a noise circle
    const gx = nx * 2.9 + (fbm2(nx * 1.6 + 9.1, nz * 1.6, oGA) - 0.5) * 1.05;
    const gz = nz * 2.9 + (fbm2(nx * 1.6, nz * 1.6 + 4.4, oGB) - 0.5) * 1.05;
    const cont = (fbm2(gx, gz, oCont) - 0.5) * 0.60;
    const det = (fbm2(nx * 8.5, nz * 8.5, oDet) - 0.5) * 0.085;
    // old cratonic swells: broad, rounded uplands well away from the orogen, which is what
    // stops continental interiors from reading as one flat table
    const sw = ridge(nx * 4.1 + 17.3, nz * 4.1 + 6.5, oSeg);
    const swell = sw * sw * 0.22 * (pCont[p1] ? 1 : 0.25);
    // sparse ridged chains: barely dent continents, surface as archipelagos out at sea
    const sm = ridge(nx * 7.2 + 3.3, nz * 7.2 + 9.1, oIsl);
    const isl = Math.pow(sm, 1.75) * (pCont[p1] ? 0.05 : 0.82);

    // Drown the rim so the map always has a real ocean edge. The far (low r) margin is drowned
    // harder: that band sits on the horizon from the default camera, and open water reading into
    // the haze is worth far more there than another five rows of land.
    const q = QOF[i], r = ROF[i];
    const m = Math.min(sstep(2.0, 9.0, r), sstep(1.0, 5.0, h - 1 - r), sstep(0.6, 4.0, q), sstep(0.6, 4.0, w - 1 - q));
    E[i] = lerp(-0.52, base + cont + det + up + isl + swell, m);
  }

  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) rank[i] = i;
  const byE = (a, b) => E[a] - E[b];

  // -------------------------------------------------------------- 3. erosion
  // Thermal talus gives ranges a scree skirt; stream-power incision cuts the valleys that make
  // a ridgeline read as a ridgeline. Four rounds is where it stops changing visibly.
  {
    const tmp = new Float32Array(n);
    const seeds = new Uint8Array(n), filled = new Float32Array(n), acc = new Float32Array(n);
    const down = new Int32Array(n), order = Array.from(rank);
    const sorted = Array.from(rank).sort(byE);
    const seaT = E[sorted[n - Math.round(LAND_FRACTION * n)]];

    for (let round = 0; round < 4; round++) {
      // (a) thermal: anything above the angle of repose slides onto its lowest neighbour
      for (let pass = 0; pass < 2; pass++) {
        tmp.set(E);
        for (let i = 0; i < n; i++) {
          let low = -1, lowE = E[i];
          for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && E[j] < lowE) { lowE = E[j]; low = j; } }
          if (low < 0) continue;
          const dh = E[i] - lowE;
          if (dh > 0.058) { const mv = (dh - 0.058) * 0.34; tmp[i] -= mv; tmp[low] += mv; }
        }
        E.set(tmp);
      }
      // (b) hydraulic: flow accumulation on the depression-filled field, then incise
      for (let i = 0; i < n; i++) seeds[i] = (E[i] <= seaT || QOF[i] === 0 || ROF[i] === 0 || QOF[i] === w - 1 || ROF[i] === h - 1) ? 1 : 0;
      fillDepressions(E, seeds, hexStart, NB, n, 1e-5, filled);
      for (let i = 0; i < n; i++) {
        acc[i] = 1; down[i] = -1;
        if (seeds[i]) continue;
        let best = -1, bestE = filled[i];
        for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && filled[j] < bestE) { bestE = filled[j]; best = j; } }
        down[i] = best;
      }
      order.sort((a, b) => filled[b] - filled[a]);
      for (let k = 0; k < n; k++) { const c = order[k], d = down[c]; if (d >= 0) acc[d] += acc[c]; }
      for (let i = 0; i < n; i++) {
        const d = down[i]; if (d < 0 || E[i] <= seaT) continue;
        const slope = filled[i] - filled[d];
        if (slope <= 0) continue;
        const cut = Math.min(slope * 0.34, 0.032 * Math.sqrt(acc[i]) * slope);
        E[i] -= cut;
      }
    }
  }

  // ------------------------------------------------------------- 4. coastline
  // A crinkle applied ONLY inside a band around the future sea level: it cuts bays, fjords,
  // capes and offshore skerries into the silhouette without punching holes through the
  // interior. It runs after erosion, otherwise the talus sweeps would sand it flat again.
  {
    const sorted = Array.from(rank).sort(byE);
    const T = E[sorted[n - Math.round(LAND_FRACTION * n)]];
    const src = Float32Array.from(E);
    for (let i = 0; i < n; i++) {
      const nx = WX[i] / MW, nz = WZ[i] / MH;
      const coarse = (fbm2(nx * 4.6 + 2.7, nz * 4.6 + 8.2, oCrink) - 0.5) * 2;
      const fine = (fbm2(nx * 13.0 + 31, nz * 13.0 + 7, oCrink) - 0.5) * 2;
      const fjord = (ridge(nx * 8.0 + 3, nz * 8.0 + 11, oCrink) - 0.5) * 2;
      E[i] += (coarse * 0.120 + fine * 0.072 + fjord * 0.062) * bell(src[i], T, 0.135);
    }
  }

  // ------------------------------------------------ 5. sea level + hypsometry
  // Land elevation is the PERCENTILE RANK of the eroded field, not its raw value. Rank is a
  // monotone transform, so it cannot invent a bump or move a ridge one hex; all it does is fix
  // the distribution. The old raw normalisation left half the land inside the bottom 3% of the
  // range — a pancake with a wall on it. This puts real ground in the middle of the curve, and
  // one gentle diffusion pass afterwards turns the last rank staircase into foothill ramps.
  const elev = new Float32Array(n), water = new Uint8Array(n), land01 = new Float32Array(n);
  let U_HILL = 0.60, U_MOUNT = 0.88, U_SNOW = 0.96;
  {
    const sorted = Array.from(rank).sort(byE);
    const seaCount = n - Math.round(LAND_FRACTION * n);
    const landCount = n - seaCount;
    for (let k = 0; k < seaCount; k++) { const i = sorted[k]; elev[i] = SEA * (k / seaCount); water[i] = 1; }
    for (let k = seaCount; k < n; k++) land01[sorted[k]] = (k - seaCount) / Math.max(1, landCount - 1);

    // diffusion: 8:1 self-to-neighbour, water counted as 0. Shorelines gain a gentle apron and
    // isolated rank spikes get tied back down to the massif they belong to.
    const ub = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      ub.set(land01);
      for (let i = 0; i < n; i++) {
        if (water[i]) continue;
        let s = ub[i] * 8, c = 8;
        for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0) { s += water[j] ? 0 : ub[j]; c++; } }
        land01[i] = s / c;
      }
    }
    // rescale back to a full 0..1 span, then read the band thresholds off the real distribution
    let lo = 1, hi = 0;
    for (let k = seaCount; k < n; k++) { const v = land01[sorted[k]]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const inv = 1 / Math.max(1e-4, hi - lo);
    const vals = new Float64Array(landCount);
    for (let k = seaCount; k < n; k++) {
      const i = sorted[k];
      land01[i] = clamp01((land01[i] - lo) * inv);
      elev[i] = SEA + (1 - SEA) * land01[i];
      vals[k - seaCount] = land01[i];
    }
    vals.sort();
    const pc = f => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))];
    U_HILL = pc(P_HILL); U_MOUNT = pc(P_MOUNT); U_SNOW = pc(P_SNOW);
  }

  // ------------------------------------------------------------ 6. ocean shelf
  // Depth from distance-to-coast, not from the elevation rank: a broad shallow shelf, a shelf
  // break a few tiles out, then abyss. Consumers derive water depth straight from elev.
  const distToLand = new Int32Array(n).fill(63);
  {
    const bfs = new Int32Array(n); let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (!water[i]) { distToLand[i] = 0; bfs[tail++] = i; }
    while (head < tail) {
      const i = bfs[head++];
      if (distToLand[i] >= 14) continue;
      for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && distToLand[j] > distToLand[i] + 1) { distToLand[j] = distToLand[i] + 1; bfs[tail++] = j; } }
    }
    for (let i = 0; i < n; i++) {
      if (!water[i]) continue;
      const d = distToLand[i];
      const shelf = 0.26 + 0.72 * Math.exp(-(d - 1) / 2.4);
      const nse = (fbm2(WX[i] / MW * 9.0 + 4.4, WZ[i] / MH * 9.0 + 1.9, oShelf) - 0.5) * 0.10;
      // keep a little of the tectonic signal so trenches and ridges still read on the sea floor
      elev[i] = SEA * clamp01(lerp(shelf, elev[i] / SEA, 0.30) + nse);
    }
  }

  // -------------------------------------------------------------- 7. climate
  // The equator is biased toward the near field, so the default camera looks across a lush warm
  // foreground, into a subtropical belt where the cordillera sits, and out to boreal forest and
  // cold sea on the horizon. That is a climate gradient you can read in one frame.
  const latOf = r => clamp01(Math.abs(r / (h - 1) - LAT_EQ) / LAT_SPAN);
  // Real altitude, 0..1 of PEAK_Y. Both the lapse rate and the orographic lift have to run off
  // this and not off `elev`: elev is a percentile, so a coastal plain at rank 0.3 would read as
  // a third of the way up a mountain and wring the air dry before it ever reached the range.
  const alt = new Float32Array(n);
  for (let i = 0; i < n; i++) alt[i] = water[i] ? 0 : hyp(land01[i]);
  const temp = new Float32Array(n), moist = new Float32Array(n), tempSea = new Float32Array(n);
  const oWob = { octaves: 3, seed: seed + 404 }, oMoist = { octaves: 4, seed: seed + 991 };
  for (let i = 0; i < n; i++) {
    const lat = latOf(ROF[i]);
    const wob = (fbm2(WX[i] / MW * 3.4 + 21, WZ[i] / MH * 3.4 + 8, oWob) - 0.5) * 0.16;
    // altitude lapse rate is strong: it is what puts alpine tundra and bare rock under the snow
    tempSea[i] = clamp01(1.05 - Math.pow(lat, 1.35) * 1.25 + wob);
    temp[i] = clamp01(tempSea[i] - alt[i] * 1.38);
  }
  {
    // Prevailing winds carry humidity along each row: tropical easterlies, mid-latitude
    // westerlies, polar easterlies. Water evaporates, upslopes wring it out -> rain shadows.
    // A weaker counter-flow runs the other way so a wide continent is watered from both coasts,
    // but it is deliberately weak: a rain shadow you can see is the single most legible cue
    // that a world was simulated rather than sprinkled.
    const rain = new Float32Array(n);
    const windPass = (flip, weight) => {
      for (let r = 0; r < h; r++) {
        const lat = latOf(r);
        const dir = flip * ((lat < 0.33 || lat > 0.70) ? -1 : 1);   // +1 = wind blows toward +q
        const q0 = dir > 0 ? 0 : w - 1, q1 = dir > 0 ? w : -1;
        // Hadley/Ferrel banding: ITCZ downpours, subtropical desert belt, mid-latitude storms
        const cell = 1 + 0.34 * bell(lat, 0, 0.18) - 0.54 * bell(lat, 0.34, 0.12) + 0.18 * bell(lat, 0.62, 0.15);
        let hum = 0.68, prev = 0, crest = 0;
        for (let q = q0; q !== q1; q += dir) {
          const i = idx(q, r);
          if (water[i]) {
            hum += (0.30 + 0.34 * temp[i]) * (1 - hum);
            rain[i] += 0.115 * weight; prev = 0; crest = 0;
          } else {
            const a = alt[i];
            const rise = Math.max(0, a - prev);
            if (a > crest) crest = a;
            // orographic lift dumps rain on the windward face; the lee stays dry until the air
            // has descended well below the crest it just crossed
            const lee = clamp01((crest - a) * 3.0);
            const dropped = hum * (0.075 + rise * 2.6) * cell * (1 - 0.80 * lee);
            hum = Math.max(0, hum - dropped * 0.45);          // most of it is transpired back
            rain[i] += dropped * (1 - 0.55 * lee) * weight;
            prev = a;
            crest -= 0.019;                                    // the shadow fades downwind
            if (crest < a) crest = a;
          }
        }
      }
    };
    windPass(1, 1.0);
    windPass(-1, 0.30);
    for (let i = 0; i < n; i++) {
      if (water[i]) { moist[i] = 1; continue; }
      const lat = latOf(ROF[i]);
      const nse = fbm2(WX[i] / MW * 5.5 + 63, WZ[i] / MH * 5.5 + 17, oMoist) - 0.5;
      moist[i] = clamp01(clamp01(rain[i] * 9.0) * 0.78 + nse * 0.24 + 0.02
        + 0.14 * bell(lat, 0, 0.17) - 0.24 * bell(lat, 0.34, 0.11));
    }
    // one light neighbour blur kills row banding without erasing the rain shadows
    const mb = Float32Array.from(moist);
    for (let i = 0; i < n; i++) {
      if (water[i]) continue;
      let s = mb[i] * 2.8, c = 2.8;
      for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0) { s += mb[j]; c++; } }
      moist[i] = s / c;
    }
  }

  // ------------------------------------------------------- 7b. the world surface
  // This has to happen BEFORE the hydrology, not after it. Flow routed on the smooth rank field
  // and then drawn on an undulating mesh produces a comb of parallel rills that never converge
  // and that visibly cross the ridges they should be running around. Build the real surface
  // first, then let the water find its way down THAT.
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i]) continue;
    const u = land01[i];
    // Lowland relief. Rank plus its diffusion pass produces a beautifully graded surface and a
    // dull one; these two octaves put the swales, spurs and dry valleys back in — which is also
    // what gives the drainage something to converge into.
    const und = ((fbm2(WX[i] * 0.26 + 5, WZ[i] * 0.26 + 9, oDet) - 0.5) * 0.62
      + (fbm2(WX[i] * 0.076 + 21, WZ[i] * 0.076 + 3, oGA) - 0.5) * 2.10) * (1 - u * 0.62);
    // Crest relief. The rank transform sands the summits into a plateau, so the high country
    // gets its ridged field back on top — peaks, cols and buttresses, fading out below the
    // hill line.
    const alp = sstep(U_HILL, 1.0, u);
    const crest = (ridge(WX[i] * 0.34 + 3.1, WZ[i] * 0.34 + 7.7, oCrest) - 0.46) * 2.6 * alp * alp;
    // Dunes and dry-wash ridges: with no root mat to hold it down, arid ground carries far more
    // surface relief than a meadow does, and it is the only thing that stops a desert basin from
    // rendering as one flat sheet of beige.
    const dune = (ridge(WX[i] * 0.175 + 41, WZ[i] * 0.185 + 17, oIsl) - 0.42) * 1.35
      * clamp01(1.30 - 1.7 * moist[i]) * (1 - u * 0.8);
    height[i] = 0.22 + hyp(u) * PEAK_Y + und + crest + dune;
  }

  // ------------------------------------------------------------ 8. hydrology
  // (a) fill depressions on the hex field; whatever is still under its spill level is a lake.
  //     Lakes are kept to low ground: every renderer floats a lake surface just under its rim
  //     and sinks the bed toward ocean depth, so an upland tarn would punch a visible pit into
  //     the hillside. Basins above the line are simply filled to their spill level instead,
  //     which is also what keeps the drainage continuous through them.
  const seedsHex = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (water[i] || QOF[i] === 0 || ROF[i] === 0 || QOF[i] === w - 1 || ROF[i] === h - 1) seedsHex[i] = 1;
  let filled = fillDepressions(height, seedsHex, hexStart, NB, n, 1e-4);
  const feature = new Array(n).fill(null);
  const isLake = new Uint8Array(n);
  let lakes = 0;
  for (let i = 0; i < n; i++) {
    if (water[i] || filled[i] - height[i] < 0.08) continue;
    if (land01[i] > U_HILL * 0.62) { height[i] = filled[i]; continue; }
    water[i] = 1; isLake[i] = 1; feature[i] = 'lake'; moist[i] = 1; land01[i] = 0; lakes++;
  }
  if (lakes) {   // lakes rewired the drainage — refill so rivers terminate at them
    for (let i = 0; i < n; i++) if (water[i]) seedsHex[i] = 1;
    filled = fillDepressions(height, seedsHex, hexStart, NB, n, 1e-4);
  }

  // (b) rivers live on hex EDGES, so route the flow across the dual corner lattice
  const KH = 2 * h + w + 6, KW = 3 * w + 6;
  const ctab = new Int32Array(KW * KH).fill(-1);
  const maxC = 3 * n;
  const cSum = new Float32Array(maxC), cCnt = new Uint8Array(maxC), cSea = new Uint8Array(maxC), cMoist = new Float32Array(maxC), cAlt = new Float32Array(maxC);
  let nc = 0;
  const cornerId = (q, r, c) => {
    const key = (3 * q + CX[c] + 2) * KH + (2 * r + q + CY[c] + 2);
    const id = ctab[key];
    return id < 0 ? (ctab[key] = nc++) : id;
  };
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) {
    const i = idx(q, r);
    for (let c = 0; c < 6; c++) {
      const id = cornerId(q, r, c);
      cSum[id] += filled[i]; cCnt[id]++; cMoist[id] += moist[i]; cAlt[id] += alt[i];
      // Only the OCEAN terminates a river. A lake is a flat reach in the middle of the network:
      // flow crosses its surface and leaves at the spill point, which is what gives every lake
      // an outlet instead of a dead end.
      if (water[i] && !isLake[i]) cSea[id] = 1;
    }
  }
  // DIRS[d] and DIRS[d+3] are opposites, so d < 3 visits every shared edge exactly once
  const eT = new Int32Array(3 * n), eD = new Uint8Array(3 * n), eA = new Int32Array(3 * n), eB = new Int32Array(3 * n);
  let ne = 0;
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) {
    const i = idx(q, r);
    for (let d = 0; d < 3; d++) {
      if (NB[i * 6 + d] < 0) continue;
      eA[ne] = cornerId(q, r, ECA[d]); eB[ne] = cornerId(q, r, ECB[d]); eT[ne] = i; eD[ne] = d; ne++;
    }
  }
  const cElev = new Float32Array(nc);
  for (let c = 0; c < nc; c++) { cElev[c] = cSum[c] / cCnt[c]; if (cCnt[c] < 3) cSea[c] = 1; }

  const cStart = new Int32Array(nc + 1);
  for (let e = 0; e < ne; e++) { cStart[eA[e] + 1]++; cStart[eB[e] + 1]++; }
  for (let c = 0; c < nc; c++) cStart[c + 1] += cStart[c];
  const cAdj = new Int32Array(cStart[nc]), cAdjE = new Int32Array(cStart[nc]), fp = Int32Array.from(cStart);
  for (let e = 0; e < ne; e++) {
    cAdj[fp[eA[e]]] = eB[e]; cAdjE[fp[eA[e]]++] = e;
    cAdj[fp[eB[e]]] = eA[e]; cAdjE[fp[eB[e]]++] = e;
  }
  const cFilled = fillDepressions(cElev, cSea, cStart, cAdj, nc, 1e-5);

  // steepest descent + flow accumulation (one high-to-low pass is exact on a filled field)
  const down = new Int32Array(nc).fill(-1), downE = new Int32Array(nc).fill(-1);
  const acc = new Float32Array(nc), strahler = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) {
    if (cSea[c]) continue;
    // Runoff generated on this corner. High ground yields far more of it than lowland: it
    // catches the orographic rain, it stores snow, and almost nothing evaporates or transpires
    // back out of bare rock. That is what forces headwaters into the range instead of letting
    // them appear halfway across a forest where the catchment finally got big enough.
    const ca = cAlt[c] / cCnt[c];
    acc[c] = 0.30 + 0.72 * (cMoist[c] / cCnt[c]) + 2.1 * ca * ca;
    let best = -1, bestE = cFilled[c], bestEdge = -1;
    for (let a = cStart[c]; a < cStart[c + 1]; a++) {
      const j = cAdj[a];
      if (cFilled[j] < bestE) { bestE = cFilled[j]; best = j; bestEdge = cAdjE[a]; }
    }
    down[c] = best; downE[c] = bestEdge;
  }
  const ord = new Array(nc);
  for (let c = 0; c < nc; c++) ord[c] = c;
  ord.sort((a, b) => cFilled[b] - cFilled[a]);
  for (let k = 0; k < nc; k++) { const c = ord[k], d = down[c]; if (d >= 0) acc[d] += acc[c]; }

  // Threshold on a percentile of land corners. Accumulation only grows downstream, so every
  // selected corner's whole path to the sea is selected too — rivers cannot break mid-course.
  const accLand = [];
  for (let c = 0; c < nc; c++) if (!cSea[c] && down[c] >= 0) accLand.push(acc[c]);
  accLand.sort((a, b) => a - b);
  const RT = accLand.length ? accLand[Math.floor(0.892 * accLand.length)] : 1e9;
  const accMax = accLand.length ? accLand[accLand.length - 1] : 1;

  // Strahler order over the selected network only: two equal orders meeting promote.
  // No open channel above the rock line: the discharge still counts (the whole catchment feeds
  // the trunk), it simply is not drawn as a river until it leaves the crags. Altitude falls
  // monotonically downstream, so cutting the top can never break a chain — it just puts every
  // headwater where a headwater belongs, at the foot of the range.
  const ALT_RIV = hyp(U_MOUNT);
  const isRiv = c => !cSea[c] && down[c] >= 0 && acc[c] >= RT && cAlt[c] / cCnt[c] < ALT_RIV;
  for (let k = 0; k < nc; k++) {
    const c = ord[k];
    if (!isRiv(c)) continue;
    if (strahler[c] === 0) strahler[c] = 1;
    const d = down[c];
    if (d < 0 || cSea[d]) continue;
    if (strahler[c] > strahler[d]) strahler[d] = strahler[c];
    else if (strahler[c] === strahler[d] && strahler[d] < 7) strahler[d] = strahler[d] + 1;
  }

  // Every river corner drains to exactly one outlet, so the network is a forest. Label each
  // corner with its outlet and drop whole trees shorter than three edges: a one-edge scratch of
  // water beside the coast reads as a rendering artefact, not as a river.
  const root = new Int32Array(nc).fill(-1), rootCnt = new Int32Array(nc);
  for (let k = nc - 1; k >= 0; k--) {          // ord is high -> low, so this walks low -> high
    const c = ord[k]; if (!isRiv(c)) continue;
    const d = down[c];
    root[c] = (d >= 0 && isRiv(d)) ? root[d] : c;
  }
  for (let c = 0; c < nc; c++) if (isRiv(c)) rootCnt[root[c]]++;
  const keep = c => isRiv(c) && rootCnt[root[c]] >= 3;

  // width ~ sqrt(discharge): a first-order brook and a trunk river must not look the same
  const sqRT = Math.sqrt(RT), sqMax = Math.sqrt(accMax * 0.62);
  const river = new Uint8Array(n), riverFlow = new Float32Array(n), riverOrd = new Uint8Array(n);
  const mark = (e, f, so) => {
    const i = eT[e], d = eD[e], j = NB[i * 6 + d];
    if (!water[i]) { river[i] |= 1 << d; if (f > riverFlow[i]) riverFlow[i] = f; if (so > riverOrd[i]) riverOrd[i] = so; }
    if (j >= 0 && !water[j]) { river[j] |= 1 << ((d + 3) % 6); if (f > riverFlow[j]) riverFlow[j] = f; if (so > riverOrd[j]) riverOrd[j] = so; }
  };
  for (let c = 0; c < nc; c++) {
    if (!keep(c)) continue;
    const f = Math.pow(clamp01((Math.sqrt(acc[c]) - sqRT) / Math.max(1e-3, sqMax - sqRT)), 0.70) * 0.80 + 0.20;
    if (downE[c] >= 0) mark(downE[c], f, strahler[c]);
    // Estuary. A corner counts as "sea" the moment ANY of its three hexes is ocean, which would
    // otherwise strand every river one edge short of the shoreline, ending it in open field.
    // When the corner downstream is such a corner, walk the last edge — the one with exactly
    // one wet side — by hand, so the channel always reaches the water.
    const c2 = down[c];
    if (c2 < 0 || !cSea[c2]) continue;
    let pick = -1, pickY = Infinity;
    for (let a = cStart[c2]; a < cStart[c2 + 1]; a++) {
      const e = cAdjE[a], i = eT[e], j = NB[i * 6 + eD[e]];
      if (j < 0 || water[i] === water[j]) continue;
      const y = cFilled[cAdj[a]];
      if (y < pickY) { pickY = y; pick = e; }
    }
    if (pick >= 0) mark(pick, f, strahler[c]);
  }

  // riparian corridor: wetter banks, floodplains in dry valleys, deltas where a trunk meets sea
  const arid = new Uint8Array(n), delta = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] || !river[i]) continue;
    if (moist[i] < 0.34 && temp[i] > 0.42) arid[i] = 1;
    moist[i] = clamp01(moist[i] + 0.15 + 0.12 * riverFlow[i]);
    let touchesSea = false;
    for (let d = 0; d < 6; d++) {
      const j = NB[i * 6 + d]; if (j < 0) continue;
      if (!water[j]) moist[j] = clamp01(moist[j] + 0.05);
      else if (!isLake[j]) touchesSea = true;
    }
    if (touchesSea && riverFlow[i] > 0.45 && land01[i] < U_HILL * 0.6) delta[i] = 1;
  }

  // ------------------------------------------------------------- 9. biomes
  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i]) { biome[i] = OCEAN; continue; }
    const t = temp[i], mo = moist[i], u = land01[i];
    const jit = (hash2(QOF[i], ROF[i], seed + 61) - 0.5) * 0.030 * (1 - U_HILL);   // irregular lines
    if (u > U_MOUNT + jit) {
      // Dapple the snow line hard. A solid white core ringed by crags disappears behind the
      // rock silhouette from any low camera; interleaving snowfields with bare rock across the
      // top band is both what a real summit looks like and what actually reads as white.
      const sj = (hash2(QOF[i], ROF[i], seed + 173) - 0.5) * 0.062;
      biome[i] = (u > U_SNOW + sj || tempSea[i] < 0.16) ? SNOW : MOUNTAIN; continue;
    }
    if (u > U_HILL + jit * 1.8) {                                    // foothills, then alpine
      const alpine = u > lerp(U_HILL, U_MOUNT, 0.72);
      biome[i] = (t < 0.15 || (alpine && t < 0.24)) ? TUNDRA : HILLS; continue;
    }
    // woodland mask: clumps forests and cuts clearings into them, so the canopy has an edge
    const wood = (fbm2(WX[i] * 0.21 + 4.4, WZ[i] * 0.21 + 9.7, oWood) - 0.5) * 0.34;
    if (t < 0.11) biome[i] = SNOW;
    else if (t < 0.28) biome[i] = mo > 0.34 + wood ? FOREST : TUNDRA;   // taiga / tundra
    else if (mo < 0.20) biome[i] = t > 0.48 ? DESERT : PLAINS;          // hot desert / cold steppe
    else if (mo < 0.46) biome[i] = PLAINS;
    else if (t > 0.74 && mo > 0.74 + wood) biome[i] = JUNGLE;
    else if (mo < 0.64 + wood) biome[i] = GRASS;
    else biome[i] = FOREST;
  }
  // majority filter: removes salt-and-pepper single tiles, which is what keeps the map readable
  // from a shallow camera angle. Only climate biomes move; relief bands stay put.
  {
    const isClimate = b => b >= GRASS && b <= JUNGLE;
    const src = new Uint8Array(n), tally = new Int32Array(12);
    for (let pass = 0; pass < 2; pass++) {
      src.set(biome);
      for (let i = 0; i < n; i++) {
        if (!isClimate(src[i])) continue;
        tally.fill(0);
        let same = 0, bestB = -1, bestC = 0;
        for (let d = 0; d < 6; d++) {
          const j = NB[i * 6 + d]; if (j < 0 || !isClimate(src[j])) continue;
          if (src[j] === src[i]) { same++; continue; }
          const c = ++tally[src[j]];
          if (c > bestC) { bestC = c; bestB = src[j]; }
        }
        if (same === 0 && bestC >= 3) biome[i] = bestB;
      }
    }
  }
  // Floodplain corridors. A trunk river keeps its own valley floor open — annual flood, fresh
  // silt, no closed canopy — so the water stays legible from the air instead of disappearing
  // under a solid roof of trees the moment it leaves the hills.
  for (let i = 0; i < n; i++) {
    if (water[i] || !river[i] || riverFlow[i] < 0.26) continue;
    if (biome[i] !== FOREST && biome[i] !== JUNGLE) continue;
    if (land01[i] > U_HILL * 0.62) continue;
    if (hash2(QOF[i], ROF[i], seed + 313) < 0.34) continue;
    biome[i] = GRASS;
  }

  // Snow only survives where it is fully enclosed by rock: every icecap therefore wears a bare
  // stone collar, and grass albedo can never sit one hex step from snow albedo.
  {
    const src = new Uint8Array(n);
    for (let pass = 0; pass < 2; pass++) {
      src.set(biome);
      for (let i = 0; i < n; i++) {
        if (src[i] !== SNOW || tempSea[i] < 0.16) continue;
        for (let d = 0; d < 6; d++) {
          const j = NB[i * 6 + d];
          if (j >= 0 && src[j] !== SNOW && src[j] !== MOUNTAIN) { biome[i] = MOUNTAIN; break; }
        }
      }
    }
  }
  // Hard rule: high ground never touches lowland directly. Every mountain/snow tile is ringed
  // by hills or alpine tundra, so the eye always reads forest -> hills -> tundra -> rock -> snow
  // instead of grass butting straight into a white peak.
  {
    const src = new Uint8Array(n);
    for (let pass = 0; pass < 2; pass++) {
      src.set(biome);
      for (let i = 0; i < n; i++) {
        if (water[i] || src[i] === MOUNTAIN || src[i] === SNOW || src[i] === HILLS || src[i] === TUNDRA) continue;
        let high = false;
        for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && (src[j] === MOUNTAIN || src[j] === SNOW)) { high = true; break; } }
        if (high) {
          biome[i] = temp[i] < 0.30 ? TUNDRA : HILLS;
          land01[i] = Math.max(land01[i], U_HILL * (1.02 + 0.40 * hash2(QOF[i], ROF[i], seed + 91)));
          elev[i] = SEA + (1 - SEA) * land01[i];
          height[i] = Math.max(height[i], 0.22 + hyp(land01[i]) * PEAK_Y);
        }
      }
    }
  }

  // continental shelf: shallow coast ringing every landmass
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    if (isLake[i]) { biome[i] = COAST; continue; }
    if (distToLand[i] === 1 || (distToLand[i] === 2 && elev[i] > SEA * 0.80)) biome[i] = COAST;
  }
  // Beaches are strand plains, not a border decoration: only low, gentle, warm-enough shores get
  // sand, and a noise gate breaks the ring so headlands stay rocky and bays keep their beach.
  for (let i = 0; i < n; i++) {
    if (water[i] || biome[i] === MOUNTAIN || biome[i] === HILLS || biome[i] === SNOW || biome[i] === TUNDRA) continue;
    if (land01[i] > U_HILL * 0.26 || temp[i] < 0.24) continue;
    let coastal = false, steep = 0;
    for (let d = 0; d < 6; d++) {
      const j = NB[i * 6 + d]; if (j < 0) continue;
      if (water[j] && !isLake[j]) coastal = true;
      else if (!water[j] && land01[j] > steep) steep = land01[j];
    }
    if (!coastal || steep > U_HILL * 0.62) continue;
    const gate = fbm2(WX[i] * 0.42 + 71, WZ[i] * 0.42 + 13, oCrink);
    if (gate > 0.50) biome[i] = BEACH;
  }

  // landmass ids by flood fill, 1 = largest
  const continent = new Int32Array(n);
  const groups = [];
  {
    const stack = [];
    let id = 0;
    for (let s = 0; s < n; s++) {
      if (water[s] || continent[s]) continue;
      id++; let size = 0, sq = 0, sr = 0;
      continent[s] = id; stack.push(s);
      while (stack.length) {
        const i = stack.pop(); size++; sq += QOF[i]; sr += ROF[i];
        for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && !water[j] && !continent[j]) { continent[j] = id; stack.push(j); } }
      }
      groups.push({ id, size, q: Math.round(sq / size), r: Math.round(sr / size) });
    }
    groups.sort((a, b) => b.size - a.size);
    const remap = new Int32Array(id + 1);
    groups.forEach((g, k) => { remap[g.id] = k + 1; g.id = k + 1; });
    for (let i = 0; i < n; i++) if (continent[i]) continent[i] = remap[continent[i]];
  }

  // ------------------------------------------------- 10. features and resources
  for (let i = 0; i < n; i++) {
    if (feature[i]) continue;
    const rn = hash2(QOF[i], ROF[i], seed + 777), b = biome[i];
    if (water[i]) {
      if (temp[i] < 0.075) feature[i] = 'ice';
      else if (b === COAST && temp[i] > 0.60 && distToLand[i] === 1 && rn < 0.12) feature[i] = 'reef';
      continue;
    }
    if (delta[i]) feature[i] = 'delta';
    else if (arid[i] && b !== HILLS && b !== MOUNTAIN && b !== SNOW) feature[i] = 'floodplains';
    else if (b === DESERT && !river[i] && rn < 0.040) feature[i] = 'oasis';
    else if ((b === GRASS || b === PLAINS) && moist[i] > 0.66 && land01[i] < U_HILL * 0.3 && rn < 0.17) feature[i] = 'marsh';
    else if (b === MOUNTAIN && UP[i] > 0.34 && rn > 0.962) feature[i] = 'volcano';
  }

  // weighted tables — plausibility per biome, nothing exotic where it does not belong
  const RES = [];
  RES[GRASS] = [['wheat', 3], ['cattle', 3], ['sheep', 2], ['horses', 2], ['wine', 1]];
  RES[PLAINS] = [['wheat', 3], ['horses', 3], ['cattle', 2], ['sheep', 2], ['ivory', 1]];
  RES[DESERT] = [['oil', 2], ['incense', 2], ['gold', 1], ['sheep', 1]];
  RES[TUNDRA] = [['deer', 3], ['furs', 2], ['oil', 2], ['silver', 1]];
  RES[SNOW] = [['oil', 2], ['furs', 1]];
  RES[FOREST] = [['deer', 3], ['furs', 2], ['iron', 2], ['silk', 1], ['dyes', 1]];
  RES[JUNGLE] = [['bananas', 3], ['spices', 2], ['dyes', 2], ['cocoa', 2], ['gems', 1]];
  RES[HILLS] = [['iron', 3], ['copper', 2], ['stone', 2], ['sheep', 2], ['marble', 1], ['gems', 1], ['wine', 1]];
  RES[MOUNTAIN] = [['silver', 2], ['gems', 1], ['gold', 1], ['marble', 1]];
  RES[BEACH] = [['crabs', 2], ['pearls', 1]];
  RES[COAST] = [['fish', 4], ['crabs', 2], ['pearls', 1], ['whales', 1]];
  RES[OCEAN] = [['whales', 2], ['fish', 1], ['oil', 1]];
  const resource = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (feature[i] === 'oasis' || feature[i] === 'ice') continue;
    const table = RES[biome[i]]; if (!table) continue;
    if (hash2(QOF[i], ROF[i], seed + 1234) > (water[i] ? 0.085 : 0.16)) continue;
    let clash = false;
    for (let d = 0; d < 6; d++) { const j = NB[i * 6 + d]; if (j >= 0 && resource[j]) { clash = true; break; } }
    if (clash) continue;
    let total = 0; for (const e of table) total += e[1];
    let pick = hash2(QOF[i], ROF[i], seed + 4321) * total;
    for (const e of table) { pick -= e[1]; if (pick <= 0) { resource[i] = e[0]; break; } }
  }

  // Gorge incision: a river cuts down into its bed and can never be left perched high above the
  // bank opposite. Two relaxation passes keep the ribbon inside its valley on steep ground.
  for (let i = 0; i < n; i++) if (river[i] && !water[i]) height[i] -= 0.12 + 0.55 * riverFlow[i];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (!river[i] || water[i]) continue;
      for (let d = 0; d < 6; d++) {
        if (!(river[i] & (1 << d))) continue;
        const j = NB[i * 6 + d]; if (j < 0 || water[j]) continue;
        const gap = height[i] - height[j];
        if (gap > 1.1) height[i] -= (gap - 1.1) * 0.5;
        else if (gap < -1.1) height[j] -= (-gap - 1.1) * 0.5;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!water[i] && height[i] < 0.16) height[i] = 0.16;

  // ------------------------------------------------------------- materialise
  const tiles = new Array(n);
  for (let i = 0; i < n; i++) {
    tiles[i] = {
      q: QOF[i], r: ROF[i], i,
      elev: elev[i],
      height: water[i] ? 0 : height[i],
      biome: BIOMES[biome[i]],
      temp: temp[i],
      moist: moist[i],
      river: river[i],
      riverFlow: riverFlow[i],
      riverOrder: riverOrd[i],
      resource: resource[i],
      feature: feature[i],
      continent: continent[i],
    };
  }
  const get = (q, r) => (inBounds(q, r) ? tiles[idx(q, r)] : null);
  return { w, h, seed, seaLevel: SEA, tiles, get, inBounds, rand, continents: groups };
}

// Callable from devtools: selfCheck() or selfCheck(map). Throws on a broken invariant.
export function selfCheck(map = globalThis.map) {
  const bad = [], B = new Set(BIOMES);
  let land = 0, riverEdges = 0, peak = 0;
  for (const t of map.tiles) {
    if (!Number.isFinite(t.elev) || !Number.isFinite(t.height) || !Number.isFinite(t.temp) || !Number.isFinite(t.moist)) bad.push(`NaN @${t.q},${t.r}`);
    if (!B.has(t.biome)) bad.push(`bad biome ${t.biome} @${t.q},${t.r}`);
    const isWater = t.height === 0;
    if (isWater) { if (t.biome !== 'ocean' && t.biome !== 'coast') bad.push(`water tile is ${t.biome} @${t.q},${t.r}`); }
    else {
      land++; peak = Math.max(peak, t.height);
      if (t.biome === 'ocean' || t.biome === 'coast') bad.push(`land tile is ${t.biome} @${t.q},${t.r}`);
      if (t.height <= 0) bad.push(`land at or below zero @${t.q},${t.r}`);
      // no lowland biome may share an edge with a peak — the foothill ring must hold
      if (t.biome !== 'hills' && t.biome !== 'tundra' && t.biome !== 'mountain' && t.biome !== 'snow') {
        for (const d of DIRS) {
          const o = map.get(t.q + d.q, t.r + d.r);
          if (o && (o.biome === 'mountain' || o.biome === 'snow')) { bad.push(`${t.biome} touches ${o.biome} @${t.q},${t.r}`); break; }
        }
      }
    }
    if (t.river) {
      if (isWater) bad.push(`river on water @${t.q},${t.r}`);
      if (t.river < 0 || t.river > 63) bad.push(`river mask out of range @${t.q},${t.r}`);
      if (!(t.riverFlow > 0 && t.riverFlow <= 1)) bad.push(`riverFlow out of range @${t.q},${t.r}`);
      for (let d = 0; d < 6; d++) {
        if (!(t.river & (1 << d))) continue;
        riverEdges++;
        const o = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
        if (o && o.height > 0 && !(o.river & (1 << ((d + 3) % 6)))) bad.push(`river edge not mirrored @${t.q},${t.r} d${d}`);
      }
    } else if (t.riverFlow !== 0) bad.push(`riverFlow without river @${t.q},${t.r}`);
    if (!isWater && t.continent === 0) bad.push(`land without continent @${t.q},${t.r}`);
    if (isWater && t.continent !== 0) bad.push(`water with continent @${t.q},${t.r}`);
  }
  if (bad.length) throw new Error('mapgen selfCheck failed: ' + bad.slice(0, 8).join(' | ') + (bad.length > 8 ? ` (+${bad.length - 8})` : ''));
  return { ok: true, tiles: map.tiles.length, land, riverEdges, peak: +peak.toFixed(2), continents: map.continents?.length ?? 0 };
}
