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
every invariant (3.4 s, worst turn 14 ms, 26 cities, pop 4→341, 57 units, 11 wars and 6 peaces,
14449 pathed tiles with 0 read through fog, culture victory to Vellum), and `npx vite build` ships
a 1297 kB / 397 kB gzipped static bundle in 0.5 s.

The **renderer** is closer than it was and still not there. Three phases now under a paired-comparison
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

Phase 13, the third phase under those rules, went 2 for 2:

| pass | outcome |
|---|---|
| units — the figure builder becomes a named-joint skeleton, so every part hangs off the joint it belongs to; then the helmet rim lifts off the eyes and the shield stops wearing the wood zone | accepted, and **promoted to champion** (`aa357c0`) |
| terrain — the ripple train stops being corduroy: a bounded phase field bends the crests, wind fetch gates their amplitude, and the blob band comes out of the sand relief | accepted, and **promoted to champion** (`8150653`) |

Eight tournament passes have now run across three phases: six accepted, two reverted. Both reverts
were units — and units has now won one, which is the first time that subsystem has survived the
tournament gate.

### The objective gate passes for the first time

`node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
620,700,240,160:near-sand 1200,300,240,160:water`

| region | phase 11 | phase 12 | now | bound |
|---|---|---|---|---|
| far-rock HF_rms | 14.12 | 13.75 | 13.75 | 12–22 ✓ |
| mid-sand HF_rms | 23.70 | 23.04 | **21.40** | ≤ 22 ✓ |
| near-sand HF_rms | 22.98 | 22.24 | **21.96** | ≤ 22 ✓ |
| near-sand MID/HF | 1.36 | 1.34 | **1.24** | ≤ 1.3 ✓ |
| water HF_rms / MID:HF | 9.09 / 1.19 | 9.08 / 1.19 | 9.08 / 1.19 | 7–15, 0.9–1.3 ✓ |
| near/far HF ramp | 1.63 | 1.62 | 1.60 | ≥ 1.6 ✓ |

`"gate": "PASS"`, `"failures": []`, 0.07 of the frame crushed and 0.00 blown. Phase 10 failed seven
checks, phases 11 and 12 failed three. This is the first release where it fails none.

**Read that PASS with the caveat it deserves.** Two of those four boxes are still mis-sited: at the
hero framing `700,430,200,140` ("mid-sand") contains no sand at all — it is a forest tile, a farm
and the corner of a city banner — and `620,700,240,160` ("near-sand") is roughly 40% dune and the
rest sward, trees and a strip of river. The gate passing is therefore weaker evidence than it looks.
The stronger evidence is hand-sited control boxes on the same frame, which move the same way and say
what actually changed:

| box | phase 12 | now | bible |
|---|---|---|---|
| `545,765,80,80` clean dune face — MID/HF | **1.82** | **1.09** | the corduroy is gone |
| `545,765,80,80` clean dune face — sat | 0.351 | **0.319** | desert 0.24–0.34 ✓ |
| `520,300,140,110` clean near grass — HF_rms | **22.40** | **19.83** | ≤ 22 ✓ |
| `660,180,140,110` far grass — sat / hue | 0.293 / 98.3 | 0.294 / 98.0 | aerial perspective still right |

So both of last phase's named terrain defects are genuinely fixed, not merely re-measured: the sand's
energy came off the 24 px ripple band and onto the 385 px dune, and the grass speckle that was
failing the ceiling came down with it (the same pass dropped the sward's 3 px band from 0.62 to 0.46).

The catch is the one a paired comparison is supposed to have: it punishes a change that improves one
thing while visibly costing another, which is most changes. Both reverted units passes died for
exactly that.

### What is still weakest

Judge verdicts are not archived — only the accept/revert decision reaches git — so this is the
outstanding list as the champion frame and the objective gate show it, worst first.
`shots/final-hero.png` is a capture of the champion build at the champion framing;
`shots/champion.png` is the reference copy the next challenger is compared against, and the two
differ only by TAA jitter.

1. **Units are still giants — but they are no longer broken giants.** This is the one defect where
   the diagnosis changed this phase. The phase-13 skeleton pass fixed *construction*: in
   `final-close.png` and `final-unit-closeup.png` the sword now has an arm behind it running
   shoulder → elbow → fist → crossguard, the shield hangs on the left arm instead of floating
   beside the torso, and there is a face with a moustache under the helmet rim. **Scale was not
   touched and remains the fault.** In `final-close.png` the two garrison soldiers still stand as
   tall as the stone body of Aurelia's keep tower; in `final-wide.png` a soldier alone on open sand
   reads as a dark monolith the size of a town. The foot-soldier multiplier in the scale ladder
   is `2.55` on both sides of the rewrite, so scale genuinely did not move — and note that `def.h`
   is no longer a scale knob at all: after the rewrite it survives only as a portrait-framing hint
   (`units.js:3494`), so anyone acting on the older notes' `h:` values is tuning a dead parameter.
   The ladder has been re-solved eight times and every round targeted the same thing — the
   soldier's projected height as a fraction of a **hex** (0.55 of one, ~58 px at the shipped
   framing). It has never once been solved against a **building**, and a building is what he is
   standing next to in every frame a judge looks at. The only pass that ever attacked scale is
   `33dec79` ("a soldier is smaller than the keep he garrisons"), reverted under phase 9's Pareto
   gate and never re-run under a tournament.

2. **Shields read as rings at wide zoom.** New observation off `final-wide.png`: the Iridon pair and
   the Vantis garrison resolve to figures carrying large gold hoops, because the round shield seen
   near edge-on keeps its bright rim and loses its face. The rim is doing all the reading.
3. **Mountains are the right shape and the right hue on the wrong rock.** The massif has a closed
   summit mass per hex and correct instance normals — real gains from phase 11. What is wrong is
   chroma, not hue: far-rock measures **sat 0.291 at hue 33.2** against the locked mountain
   `#7A7368`, whose own hue is 37° and whose sat band is **0.08–0.18**. It is the right colour at
   twice the saturation, which is why it reads as tan sandstone. Shard edges also stay hard and the
   snow caps are flat paper-white patches rather than lit volume.
4. **Per-biome palette compliance, now grass-only.** Sand came into band this phase (0.319 against
   desert's 0.24–0.34). Near grass did not: it measures **sat 0.429 at hue 66.9** against `#5C7A3A`'s
   0.30–0.42 at ~88°, i.e. marginally over-saturated and 21° too yellow. Far grass measures
   0.294 at hue 98.0, so the aerial perspective is right and it is the near end that is warm and hot.
   Open ocean at mean 129 is still nearer coast brightness than the specified `#123A63`.
5. **Rivers.** The translucent slab is thinner and the bank is a wet margin now, but the channel is
   still a chain of flat angular plates laid along the hex edges rather than a bed cut into the
   terrain, and it takes no sun. In `final-close.png` the reach below Aurelia has a hard-edged blue
   quad in it that reads as a decal lying on the ground rather than as water.
6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection — a
   warrior with 1 movement point and a six-tile reach set, `uDim` at 0.11 — and none of it is
   legible in the frame. The range plate is a 0.28 cool multiply and the focus dim is 11%; under
   the golden-hour grade at hero zoom, a player cannot see where the selected unit can go.
   Non-negotiable #1 is about seeing the tiles you click; this is the same complaint one level up.
7. **The hex seam on rock is present but faint.** No longer outright broken across the mountain
   band, but the line there is far weaker than on grass and it loses wherever the rock goes bright.

No one has yet put this frame beside a real Civ VI screenshot under the tournament rules; the last
time that comparison was run, the judge picked the real one immediately. The measurements, the
per-phase record and the gate designs that ratcheted versus the ones that stalled are in
`docs/RESUME.md` — that record may still be the most useful thing in this repo.

Contributions welcome — `docs/ART-BIBLE.md` (the locked direction) and `tools/metrics.mjs` (the
objective gate) are the two things to read first.
