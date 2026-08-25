# Resume notes — paused 2026-08-25 (end of phase 10)

## State
The referee scores the whole frame on six independent axes. Standing frame at HEAD:

| axis | score | what it measures |
|---|---|---|
| lighting | **20** / 30 | cast shadows landing, contact AO, one unifying sun, shadow hue near the lit hue |
| material | **8** / 20 | world-space detail shrinking with distance, no confetti, no flat-matte |
| readability | **9** / 15 | hex grid legible everywhere incl. mountains, biomes distinguishable |
| units | **6** / 15 | silhouettes nameable at gameplay zoom, grounded, not clay |
| colour | **6** / 10 | palette compliance, no cast, aerial perspective lighter-cooler-desaturated |
| finish | **8** / 10 | no mesh holes, blown voids, aliasing, streaks, z-fighting, clipped UI |
| **total** | **57** / 100 | best recorded; scored on `shots/verify-57.png`, which is the same build as the released frames |

- `node tools/sim.mjs` passes: 260 turns, 26 cities, pop 4->341, 57 units, the 32-tech tree exhausted by
  three of four civs, 11 wars and 6 peaces, 14449 pathed tiles with 0 read through fog,
  culture victory to Vellum. Worst turn 15 ms.
- `npx vite build` succeeds; GitHub Actions rebuilds `dist/` on push and deploys it.
- Released frames: `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png`
  (1600x900, directed via `?shot=hero|wide|close`; each captured `blank:false errors:[]`).
- The objective gate still **FAILS** on the released frame:

  `node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
  620,700,240,160:near-sand 1200,300,240,160:water`

  | region | mean | sat | hue | HF_rms | MID/HF |
  |---|---|---|---|---|---|
  | far-rock | 121.3 | 0.317 | 34.5 | 14.64 | 1.00 |
  | mid-sand | 100.0 | **0.460** | 65.5 | **23.69** | 1.10 |
  | near-sand | 116.8 | **0.467** | 51.5 | **22.61** | **1.36** |
  | water | 131.1 | 0.421 | 209.2 | **3.52** | **3.92** |

  near/far HF ramp **1.54** (need >= 1.6) - crushed 0.07 - blown 0.00. Seven failures: mid-sand and
  near-sand HF over the 22 confetti ceiling, near-sand MID/HF over 1.3 (blurry blobs), near-sand
  saturation over the 0.46 ceiling, water HF under the 7 floor and its MID/HF at 3.92 (a flat sheet
  with no material at all), and the ramp. Clipping and shadow-hue coherence are the two things that
  pass cleanly. The water box lands on open sea clear of the notification rail — check that before
  trusting any number from it.

## Outstanding defects, in referee priority order
1. **Ground material is screen-space, not world-space** (material 8/20, the weakest axis). The
   referee measured the near/far HF ramp at 1.34–1.59 across its own boxes against the 1.6
   requirement, near sand and hills at HF 26–29 (confetti), and the far plain collapsed the other way
   to HF 5 at MID/HF 2.13 (blurry nothing); the gate's standard boxes on the released frame give ramp
   1.54 and near/mid sand HF 22.6/23.7. Both ends are the same bug: detail drawn at pixel scale
   instead of at a fixed world size. One triplanar world-space detail set with honest mips fixes both
   at once — per-region noise never will.
2. **The hex grid vanishes across the mountain band** — roughly a third of the frame with no
   clickable tile boundary. Art-bible non-negotiable #1, and still broken after five dedicated
   passes. Terrain must leave value headroom, the grid must adapt alpha to the surface, post must
   crush neither.
3. **Mountains are intersecting flat shards.** Hard polygon seams, adjacent faces disagreeing about
   the sun direction, paper-white snow caps and a milky near-white void at the summits. Light
   describes no volume up there.
4. **Land saturation runs hot against the locked palette.** Grass measures 0.45–0.55 against the
   bible's 0.30–0.42, sand 0.42–0.47 against desert's 0.24–0.34, and open ocean sits at coast
   brightness instead of #123A63. The palette is documented; it is simply not being hit.
5. **Rivers read as hard-edged unlit cyan cutouts** with a translucent slab over the tiles. Bed the
   channel into the terrain, light it, delete the slab.
6. **Units still do not name themselves at gameplay zoom** (6/15, up from 3/15). In
   `final-close.png` the figures resolve into sword-and-shield soldiers; in `final-hero.png` — the
   distance a player actually plays at — an occupied tile is a strength badge and a contact ring
   over a mound.

## What is working — do not re-roll it
One unifying warm key with the shadow hue within 1–3° of the lit hue; correct aerial perspective on
land; the hex grid on grass, sand and plains; coast foam; the Aurelia keep silhouette; the HUD with
zero clipping; crushed 0.07 / blown 0.00.

## Phase 10: the gate loosened, and the best frame came back
Phase 9's gate — accept only if **no axis drops and one gains ≥ 2** — had reverted the best frame
the project ever rendered (units a2: +8 total across three axes, −1 material). Phase 10 replaced it
with a bounded trade: **accept if the total gains ≥ 3 and no axis drops by more than 1**, judge
noise being worth about a point.

| pass | attempts | outcome |
|---|---|---|
| units (restore a2) | 1 | **accepted**, 49 → **57** — units 3 → 6, lighting 18 → 20, finish 5 → 8, material 9 → 8 |
| mountains | 3 | all reverted (`c2178e0`) |
| terrain/post material | 3 | all reverted (`f925287`) |
| water | 3 | all reverted (`ea993fb`) |

The loosened gate did exactly one thing and did it well: it let back in a change the strict rule had
thrown away, worth +8. It then held against nine attempts on the three biggest defects, none of
which cleared +3. Attempt frames are kept as `shots/p10-<pass>-a<n>.png` next to
`shots/revert-check-<pass>.png`, so the next phase can see what has already been tried on mountains,
material and water before trying it again.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 → 34 → 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain (34 → 50 → 57).
- One-sided metric targets get gamed: "HF_rms ≥ 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- A gate has to be able to ratchet. A strict per-axis "no axis may drop" rule against a judge whose
  per-axis noise is about ±1 rejects every real trade — it cost this project its best frame for two
  phases. Bounded trade (Σ ≥ +3, no single axis worse than −1) ratchets without letting an axis be
  quietly sold off.
- Three consecutive passes reverting nine of nine attempts is the gate working, not the gate stuck —
  but it also says the remaining defects are not one-file fixes. Mountains, material and water each
  failed alone; the ranked list above is coupled (grid legibility depends on terrain value headroom,
  which depends on the grade).
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
