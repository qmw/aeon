# AEON

A Civilization-style turn-based 4X strategy game that runs in the browser. Three.js, no game engine,
no external art: every texture, mesh, shader and icon is generated in code at load time.

**[Play it](https://qmw.github.io/aeon/)** · MIT licensed

![AEON](shots/final-hero.png)

## What's in it

**World.** Procedural generation with tectonic plates, orogenic uplift producing connected mountain
ranges, latitude/altitude climate with prevailing-wind moisture transport and rain shadows, hydraulic
erosion, and a drainage network solved by flow accumulation — rivers run mountain-to-sea along hex
edges, merge at confluences, and widen downstream. Biomes follow from temperature and moisture rather
than being painted on. Deterministic from a seed; a 64×44 map generates in about 30 ms.

**Game.** Hex grid with A* pathfinding over terrain movement costs, cities that work tiles and grow,
production queues, buildings and districts, culture-driven border expansion, a 32-tech tree across
four eras, ranged and melee combat with terrain and flanking modifiers, promotions, embarkation,
per-civ fog of war, and AI opponents that explore, settle, expand, research, declare war and make
peace — using their own fog state, without omniscience.

**Rendering.** Merged-geometry hex terrain with procedural biome splatting and instanced vegetation,
atmospheric scattering sky with drifting cloud shadows, a water shader with depth-ramped colour,
fresnel reflection, shore foam and river channels, cascaded shadow maps with a fitted frustum, and a
post chain doing GTAO, bloom, TAA and filmic grading.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static bundle in dist/
npm test         # 260-turn headless simulation
```

`npm test` plays a full match with no renderer and asserts the invariants — no NaN yields, techs
unlock in prerequisite order, paths never cross impassable terrain, AI never reads through fog.

## Controls

WASD or edge-scroll to pan · wheel to zoom · Q/E to rotate · click to select · Space to end turn ·
Escape to deselect · T for the tech tree

## How it was built

Written by Claude Code as an experiment in multi-agent development: subsystem agents building in
parallel against a fixed module contract, each judged by a separate art-director agent comparing the
rendered frame against shipping Civilization VI screenshots, looping until the critic stopped
rejecting.

Two things turned out to matter more than the fan-out:

- **Objective gates beat opinions.** `tools/metrics.mjs` measures per-region detail energy, blob
  energy, hue, saturation and clipping on a screenshot. An early one-sided target ("detail energy
  ≥ 12") was promptly satisfied by spraying per-pixel noise, so the gate now bounds detail on both
  sides and requires it to shrink with distance — a property screen-space noise cannot fake.
- **Accept/revert beats stacking.** Parallel agents each improved their own subsystem while
  collectively degrading the frame, oscillating for six passes. Switching to sequential single-owner
  passes, with a referee scoring the whole frame and `git` reverting anything that lowered it,
  produced the only monotonic gain.

`tools/shot.mjs` screenshots the running game headlessly and waits on rendered-frame count rather
than wall-clock — under software WebGL a timed wait captures an unconverged TAA frame, which
generated a long run of bogus "the near field is blurry" critiques before anyone noticed.

`docs/ART-BIBLE.md` holds the locked art direction, `docs/CONTRACT.md` the module interfaces, and
`docs/CRITIQUE-phase*.md` every critic report, unedited.

## Status

The **game** is done: a full match plays start to finish, the 260-turn headless simulation passes
every invariant (3.2 s, worst turn 14 ms, 26 cities, pop 4→341, 57 units, 11 wars and 6 peaces,
14449 pathed tiles with 0 read through fog, culture victory to Vellum), and `npx vite build` ships
a 1298 kB / 398 kB gzipped static bundle in 1.0 s.

The **renderer** is closer than it was and still not there. Four phases now under a paired-comparison
gate, after ten under a scoring one.

### Scoring is retired; the gate is a tournament

For ten phases a referee agent scored the frame 0–100 against a real Civilization VI screenshot on
six axes, and a change was kept if the number went up. The problem was noise — about a point per
axis and about three on the total, which is the size of a real improvement. Twice the score gate
threw away the best frame the project had ever rendered and both had to be restored by hand
(`14fb0ff`, `6a17231`); three consecutive phases then reverted nine attempts out of nine.

Every attempt is now put **side by side against the reigning champion frame** and shown to two
independent judges, with the labels in opposite order so position cannot bias them. It is kept only
if **both** judges pick the challenger. Nobody is asked for a number — they are asked the only
question this project is actually judged on: which of these two is better.

Phase 14, the fourth phase under those rules, went 1 for 2:

| pass | outcome |
|---|---|
| vegetation — canopies become clustered crowns: per-lobe value and sky occlusion, a third silhouette per biome, conifer tiers that step instead of sliding down one smooth cone, foliage normals rounded per-lobe rather than to the whole tree, and trees taken off mountain and snow entirely | **accepted** (`d831603`, `73bb610`) |
| water — three attempts to give the shelf a wave read: carry the swell across the shelf on a depth window, comb the seabed with a shoaling caustic set, scallop and narrow the surf, take the violet haze off the swash | **reverted** (`27d8a1b`) |

Ten tournament passes have now run across four phases: seven accepted, three reverted. The reverts
are two units and one water.

The vegetation win is the same shape as the phase-13 units win, and that is now a pattern worth
naming: both were **representation** changes, not value changes. The lollipop-on-a-cliff was not a
density number to tune, it was `TREES.mountain = 0.3` seating trees on the hex field under a
modelled summit; the smooth-green-egg canopy was not a shading number, it was `fin()` blending five
modelled lobes toward one centroid so none of the modelling reached the screen. Both fixes deleted
the trade-off instead of tuning it, which is why neither cost a vote.

The water attempts are the counter-example. Each was a real physical idea — refracted crest lines
on isolines of the distance field, shallow-water shortening, the wave read arriving *through* the
column rather than on top of it — and each one bought shelf texture at the price of something the
judges already liked. That is exactly the failure mode a paired gate is built to catch.

### The objective gate still passes

`node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
620,700,240,160:near-sand 1200,300,240,160:water`

| region | phase 12 | phase 13 | now | bound |
|---|---|---|---|---|
| far-rock HF_rms | 13.75 | 13.75 | 13.68 | 12–22 ✓ |
| mid-sand HF_rms | 23.04 | 21.40 | **21.83** | ≤ 22 ✓ |
| near-sand HF_rms | 22.24 | 21.96 | **21.99** | ≤ 22 ✓ |
| near-sand MID/HF | 1.34 | 1.24 | 1.25 | ≤ 1.3 ✓ |
| water HF_rms / MID:HF | 9.08 / 1.19 | 9.08 / 1.19 | 9.09 / 1.19 | 7–15, 0.9–1.3 ✓ |
| near/far HF ramp | 1.62 | 1.60 | 1.61 | ≥ 1.6 ✓ |

`"gate": "PASS"`, `"failures": []`, 0.07 of the frame crushed and 0.00 blown.

**But read the headroom, not the verdict.** Both sand boxes contain trees, and the new canopy
structure put detail energy straight back into them: near-sand is at **21.99 against a ceiling of
22.00**. The gate passes by one hundredth. The next pass that touches vegetation, or anything else
that adds high-frequency structure in the near field, will fail this gate unless it takes energy out
somewhere else first.

The hand-sited control boxes confirm that the terrain itself did not move — only the props on it:

| box | phase 13 | now | reading |
|---|---|---|---|
| `545,765,80,80` clean dune — HF / MID:HF / sat | 17.65 / 1.09 / 0.319 | 17.65 / 1.09 / 0.319 | identical; sand untouched |
| `520,300,140,110` near grass — HF_rms | 19.83 | 19.70 | still under the 22 ceiling |
| `520,300,140,110` near grass — sat / hue | 0.429 / 66.9 | 0.429 / 66.8 | unchanged, still hot and yellow |
| `660,180,140,110` far grass — sat / hue | 0.294 / 98.0 | 0.292 / 98.7 | aerial perspective still correct |

### One process defect to fix before the next phase

`shots/champion.png` was **not** re-shot when the vegetation pass was accepted — its last update is
the phase-13 promotion commit (`8150653`). So the three water challengers were compared against a
champion frame rendered from a build that did not contain the accepted vegetation work. The water
result is probably still right — three attempts lost, and none of them lost on a tree — but the
comparison was not clean, and the next phase must promote the frame with the pass.

### What is still weakest

Judge verdicts are not archived — only the accept/revert decision reaches git — so this is the
outstanding list as the released frames and the objective gate show it, worst first.

1. **Units are giants. This is now the single worst thing in the project and it has still never
   been attempted under a tournament.** Construction is genuinely fixed and must not be re-fixed:
   in `final-unit-closeup.png` the sword has an arm behind it running shoulder → elbow → fist →
   crossguard, the shield hangs on the left arm, and there is a face with a moustache under the
   helmet rim. **Scale was never touched.** In that same frame the warrior standing beside
   Aurelia's keep is *taller than the keep* — his helmet clears the stone curtain and his shoulders
   sit at the mid-height of the red-roofed tower. In `final-wide.png` a lone soldier on open sand is
   a dark monolith larger than the buildings of the town two hexes away. The foot-soldier multiplier
   in the scale ladder is `2.55` and has been re-solved eight times, every round against the
   soldier's projected height as a fraction of a **hex** (0.55 of one). Never once against a
   **building** — and a building is what he stands next to in every frame a judge looks at. Note
   also that `def.h` is no longer a scale knob at all: after the phase-13 rewrite it survives only
   as a portrait-framing hint (`units.js:3494`), so the older notes' `h:` values are a dead
   parameter. `33dec79` ("a soldier is smaller than the keep he garrisons") is the only pass that
   ever attacked scale; it died under phase 9's Pareto gate and has never been re-run.
2. **Rivers are flat plates, and at wide zoom they read as ice.** Worse than last release's
   description, not better. In `final-wide.png` the reach below Aurelia is a broad pale-blue sheet
   with hard polygonal edges lying on top of the sand — it reads as a glacier, not a river. In
   `final-close.png` the same reach is a hard-edged cyan quad and a second small blue rectangle
   beside the unit badge, both plainly decals on the ground. The channel is still a chain of flat
   plates laid along hex edges rather than a bed cut into the terrain, and it takes no sun.
3. **Shields read as gold rings at wide zoom.** Unchanged. In `final-wide.png` the Iridon pair and
   the Vantis garrison resolve to figures carrying large gold hoops, because a round shield seen
   near edge-on keeps its bright rim and loses its face. The rim is doing all the reading. Cheap and
   isolated — the kind of single-symptom fix that can win a tournament outright.
4. **Mountains are the right shape and the right hue on the wrong rock.** Closed summit mass per
   hex and correct instance normals are real gains from phase 11. The fault is **chroma, not hue**:
   far-rock measures sat 0.292 at hue 33.1 against the locked mountain `#7A7368`, whose own hue is
   37° and whose sat band is 0.08–0.18. Right colour at twice the saturation, which is why the range
   reads as tan sandstone canyon rather than alpine rock. Shard edges stay hard and the snow caps
   are flat paper-white patches rather than lit volume.
5. **Per-biome palette compliance, still grass-only.** Sand is in band (0.319 against desert's
   0.24–0.34) and far grass is correct (0.292 at hue 98.7). Near grass is not: **sat 0.429 at hue
   66.8** against `#5C7A3A`'s 0.30–0.42 at ~88°, i.e. marginally over-saturated and 21° too yellow.
   Open ocean at mean 129 is still nearer coast brightness than the specified `#123A63`.
6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection — a
   warrior with 1 movement point and a six-tile reach set, `uDim` at 0.11 — and none of it is
   legible in the capture. The range plate is a 0.28 cool multiply and the focus dim is 11%; under
   the golden-hour grade at hero zoom, a player cannot see where the selected unit can go.
   Non-negotiable #1 is about seeing the tiles you click; this is the same complaint one level up.
7. **The hex seam on rock is present but faint.** No longer broken across the mountain band, but the
   line there is far weaker than on grass and it loses wherever the rock goes bright.
8. **Near-sand HF headroom is 0.01.** Not a visual defect, a gate defect — and the two mis-sited
   boxes make it worse. At the hero framing `700,430,200,140` ("mid-sand") contains no sand at all
   — a forest tile, a farm and the corner of a city banner — and `620,700,240,160` ("near-sand") is
   roughly 40% dune, the rest sward, trees and a strip of river. Re-siting those two boxes is the
   highest-value tooling work available, because a gate that passes while pointing at the wrong
   biome will happily certify a regression.

No one has yet put this frame beside a real Civ VI screenshot under the tournament rules; the last
time that comparison was run, the judge picked the real one immediately. The measurements, the
per-phase record and the gate designs that ratcheted versus the ones that stalled are in
`docs/RESUME.md` — that record may still be the most useful thing in this repo.

Contributions welcome — `docs/ART-BIBLE.md` (the locked direction) and `tools/metrics.mjs` (the
objective gate) are the two things to read first.
