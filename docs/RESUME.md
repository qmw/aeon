# Resume notes — paused 2026-08-25 (end of phase 9)

## State
Referee scores the whole frame on six independent axes. Standing frame at HEAD:

| axis | score | what it measures |
|---|---|---|
| lighting | **18** / 30 | cast shadows landing, contact AO, one unifying sun, shadow hue within ~10° of lit hue |
| material | **9** / 20 | world-space detail shrinking with distance, no confetti, no flat-matte |
| readability | **8** / 15 | hex grid legible everywhere incl. mountains, biomes distinguishable |
| units | **3** / 15 | silhouettes nameable at gameplay zoom, grounded, not clay |
| colour | **6** / 10 | palette compliance, no cast, aerial perspective lighter-cooler-desaturated |
| finish | **5** / 10 | no mesh holes, blown voids, aliasing, streaks, z-fighting, clipped UI |
| **total** | **49** / 100 | |

- `node tools/sim.mjs` passes: 260 turns, 26 cities, 32 techs, 11 wars, culture victory.
- `npx vite build` succeeds; the site deploys from `dist/`.
- Latest frames: `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png` (1600x900,
  directed via `?shot=hero|wide|close`; each captured `blank:false errors:[]`).
- The objective gate still **FAILS** on the released frame. Measured on `shots/final-hero.png`
  (`node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand 620,760,200,140:near-sand 1150,200,240,160:water`):

  | region | mean | sat | hue | HF_rms | MID/HF |
  |---|---|---|---|---|---|
  | far-rock | 121.3 | 0.317 | 34.5 | 14.64 | 1.00 |
  | mid-sand | 100.0 | 0.460 | 65.5 | **23.69** | 1.10 |
  | near-sand | 106.9 | **0.469** | 48.9 | 20.51 | **1.40** |
  | water | 108.7 | 0.391 | 211.6 | 13.44 | 0.92 |

  near/far HF ramp **1.40** (need ≥ 1.6) · crushed 0.08 · blown 0.00. Four failures: mid-sand HF over
  the 22 confetti ceiling, near-sand MID/HF over 1.3 (blurry blobs), near-sand saturation over 0.46,
  and the ramp. Clipping and shadow-hue coherence are the two things that do pass cleanly.

## Phase 9: six attempts, six reverts
Phase 9 replaced the single noisy total with a per-axis Pareto gate — accept only if **no axis drops
and at least one gains ≥ 2**. It ran a coherent look pass (terrain + post + water + grid together,
because the failures were coherence failures no single file could fix) and a units rebuild.

| attempt | total | why it was rejected |
|---|---|---|
| look a1 | 48 | material 9 → 8 |
| look a2 | 39 | lighting 18 → 12, readability 8 → 7, finish 5 → 3 |
| look a3 | 47 | lighting 18 → 17, material 9 → 8, colour 6 → 5 |
| units a1 | 44 | material 9 → 6, lighting 18 → 15 |
| units a2 | **57** | units 3 → 6, lighting 18 → 20, finish 5 → 8 — but material 9 → 8 |
| units a3 | 52 | units 3 → 6 — but readability 8 → 7 |

Read that table before designing phase 10. **The gate reverted the best frame this project has ever
rendered.** units a2 gained +8 total across three axes and lost one point of material; the rule as
written threw it away. A strict "no axis may drop" gate on a judge whose per-axis noise is about ±1
cannot ratchet — it rejects every real trade. Phase 10 should either allow a bounded trade
(e.g. accept if Σ gains ≥ Σ losses + 2 and no axis drops by more than 1), score each attempt twice
and compare means, or freeze the axes an attempt is not allowed to touch and only gate those.

## Outstanding defects, in referee priority order
1. **Units are not units at gameplay zoom.** Compare the three released frames: in `final-close.png`
   the figures resolve into sword-and-shield soldiers, but in `final-hero.png` — the distance a player
   actually plays at — an occupied tile is a strength badge and a contact ring over a mound, and
   nothing about the silhouette names the unit. Lowest axis (3/15) and the one thing no Civ VI frame
   lacks. Seven rebuilds have now been reverted; the silhouette work in `units a2` (commit `3263c7f`,
   reverted in `194d198`) scored the best units axis yet and is the place to restart, not from zero.
2. **Material is screen-space, not world-space.** Sand reads as blurry pale lozenges, grass as bright
   confetti. On the released frame the near/far HF ramp is 1.40 against a ≥ 1.6 gate, mid-sand HF is
   23.69 against a 22 ceiling, and near-sand MID/HF is 1.40 against a 1.3 ceiling — detail is being
   drawn at pixel scale and blurred at blob scale at the same time. Needs one mipped world-space
   detail set, not per-region noise.
3. **Hex grid absent on mountain and rock** (crop `150,80,180,140`) — art-bible non-negotiable #1,
   still broken after four dedicated passes. Terrain must leave value headroom, grid must adapt alpha
   to the surface, post must crush neither.
4. **River reads as a cyan cutout** around `700-840,250-360`: hard-edged, unlit, with a translucent
   grey-blue slab quad over the tiles. Bed it into the terrain, light it, delete the slab.
5. **Grass and shallows are acid.** Lit grass measures sat 0.475–0.55 and shallows 0.578 against the
   bible's 0.30–0.42; near-sand measures 0.469 against the gate's 0.46 ceiling. The palette is
   documented, it is just not being hit.
6. **Shadowed rock is flat matte** (shadowed flank at `120,200` measures HF 3.77), plus a hard-edged
   white snow decal and a black skirt gap near `115,70`.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 → 34 → 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain (34 → 50).
- One-sided metric targets get gamed: "HF_rms ≥ 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- A per-axis gate stops axes being traded away silently, but a *strict* one cannot ratchet against a
  noisy judge — see the phase 9 table above.
- The screenshot harness must wait on rendered-frame count, not wall-clock: at ~1 fps under
  software WebGL a timed wait captures an unconverged TAA frame, which produced dozens of
  bogus "near-field is blurry" critiques.
- `?nopost=1` renders the raw scene — the fastest way to tell a shading bug from a post bug.
- The standard metrics boxes assume a 1600x900 capture. At the 1200x675 fast-loop size `620,760` is
  off-canvas and `1150,200` lands on the notification rail, so the gate silently measures UI.

## To restart
1. Dev server (nothing else needs it running):
   `setsid nohup npx vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &`
2. Confirm it renders: `node tools/shot.mjs shots/check.png 1600 900` (~2 min, waits for TAA convergence)
3. Read `docs/ART-BIBLE.md` (LOCKED) and `docs/CONTRACT.md` before touching any renderer file.
