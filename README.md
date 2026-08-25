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
every invariant (4.5 s, worst turn 42 ms, 26 cities, 14449 pathed tiles with 0 read through fog),
and `npx vite build` ships a 1292 kB / 395 kB gzipped static bundle in 1.3 s.

The **renderer** is closer than it was and still not there. Two phases now under a paired-comparison
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

Phase 12, the second phase under those rules:

| pass | outcome |
|---|---|
| terrain — sand loses the leopard blotches for a wind-ripple train that follows the fall line | accepted, and **promoted to champion** (`fbddb26`) |
| units — a head under the helmet, a grip closing the hand to the crossguard, rounded boots, a contact disc sized off the soles | **lost, reverted whole** (`adf28de`) |
| tooling — `?cam=x,y,z,tx,ty,tz` parks the camera so unit work can be shot at close range | kept; not a tournament entry |

Six tournament passes have now run across two phases: four accepted, two reverted. Both reverts
were units.

The accepted sand pass is worth reading (`074dba0`) because it is the shape of a change that wins
one of these. Every band the sand wears became a harmonic of **one scalar phase** — a plane in
world space, bent onto the contour by the surface height term — so the 5.5 u dune crest and the
0.35 u ripple cannot beat each other into moiré, and a scalar has no winding number so no crest can
pinch into the starburst that killed the previous ripple ladder. The two isotropic Voronoi cell
fields underneath (24 px and 10 px) were **deleted rather than damped**: an isotropic cell field
does not become a desert by tuning.

The objective gate agrees the frame moved, and still fails on the same three counts:

`node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
620,700,240,160:near-sand 1200,300,240,160:water`

| region | phase 11 | now | bound |
|---|---|---|---|
| far-rock HF_rms | 14.12 | 13.75 | 12–22 ✓ |
| mid-sand HF_rms | 23.70 | **23.04** | ≤ 22 ✗ |
| near-sand HF_rms | 22.98 | **22.24** | ≤ 22 ✗ |
| near-sand MID/HF | 1.36 | **1.34** | ≤ 1.3 ✗ |
| near-sand sat | 0.436 | 0.428 | ≤ 0.46 ✓ |
| water HF_rms / MID:HF | 9.09 / 1.19 | 9.08 / 1.19 | 7–15, 0.9–1.3 ✓ |
| near/far HF ramp | 1.63 | 1.62 | ≥ 1.6 ✓ |

0.08 of the frame crushed, 0.00 blown. Three failures, down from seven at the phase 10 release.

The catch is the one a paired comparison is supposed to have: it punishes a change that improves one
thing while visibly costing another, which is most changes. Both units passes were reverted whole
for exactly that.

### What is still weakest

Judge verdicts are not archived — only the accept/revert decision reaches git — so this is the
outstanding list as the champion frame and the objective gate show it, with the pass that lost the
last comparison at the top. `shots/final-hero.png` is a capture of the champion build at the
champion framing — `shots/champion.png` is the reference copy the next challenger is compared
against, and the two differ only by TAA jitter.

1. **Units are giants with detached weapons.** Two units passes have now lost the tournament back
   to back. In `final-close.png` the two garrison soldiers stand as tall as Aurelia's keep tower,
   and each one's sword and shield hang in the air clear of the torso with no arm between them —
   the legs disappear into the contact pool. In `final-wide.png` a soldier standing alone on open
   sand is as tall as the keep tower of Vantis across the frame from him. At the hero framing the
   same figure is a cream shield disc, a blue oval and a grey blade lying flat on the ground beside
   it: scattered props, not a warrior. Two things the next attempt should know. The reverted
   phase-12 work (`5e3e11a`) used the new `?cam=` close-up and genuinely fixed construction at
   three metres — a head under the helmet, a grip closing the fist to the crossguard, rounded
   boots, a contact disc sized off the soles — and still lost both votes, so the cost is somewhere
   other than construction. And no units pass since `33dec79` has touched scale at all; that one
   was reverted under phase 9's Pareto gate and has never been re-run against a tournament.
2. **The near field's confetti is grass, not sand — and the gate boxes are measuring the wrong
   biome.** All three surviving failures live in the two boxes named `mid-sand` and `near-sand`,
   and at the hero framing neither box is mostly sand. `700,430,200,140` contains no sand at all:
   it is a forest tile, a farm and the corner of a city banner (hue 66.9, i.e. olive). A clean dune
   face measures HF_rms **17.84 — comfortably inside the ceiling** — at MID/HF 1.82, while a clean
   grass box measures HF_rms **22.40, over it**, at MID/HF 0.99. So the sand pass did what it
   claimed and the sward is what fizzes now: a speckle of pale green over dark at cloud-shadow
   scale. Sand's own remaining fault is the opposite one — with the cell fields gone, nearly all of
   its energy sits in the 24 px ripple band, which reads as corduroy where the crests cross a
   slope. Re-site the boxes before trusting the failure list.
3. **Mountains are the right shape on the wrong rock.** The massif has a closed summit mass per
   hex, correct instance normals and a hex seam that survives on rock — all real gains from phase
   11. They still read as tan sandstone fins: far-rock measures saturation 0.291 at hue 33° against
   the locked mountain `#7A7368` (sat 0.08–0.18), shard edges stay hard, and the snow caps are flat
   paper-white patches rather than lit volume.
4. **Per-biome palette compliance.** Whole-frame saturation is inside the metrics band, but the
   bible is written per biome: near grass measures sat 0.431 at hue 67° against `#5C7A3A`'s
   0.30–0.42 at ~88°, a clean dune face 0.351 against desert's 0.24–0.34, and open ocean at mean
   129 is nearer coast brightness than the specified `#123A63`. Far grass, by contrast, measures
   0.293 at hue 98° — the aerial perspective is right; it is the near end that is warm and hot.
5. **Rivers.** The translucent slab is thinner and the bank is a wet margin now, but the channel is
   still a chain of flat angular plates laid along the hex edges rather than a bed cut into the
   terrain, and it takes no sun.
6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection — a
   warrior with 1 movement point and a six-tile reach set, `uDim` at 0.11 — and none of it is
   legible in the frame. The range plate is a 0.28 cool multiply and the focus dim is 11%; under
   the golden-hour grade at hero zoom, a player cannot see where the selected unit can go.
7. **The hex seam on rock is present but faint.** Non-negotiable #1 is no longer outright broken
   across the mountain band — but the line there is far weaker than on grass and it loses wherever
   the rock goes bright.

No one has yet put this frame beside a real Civ VI screenshot under the tournament rules; the last
time that comparison was run, the judge picked the real one immediately. The measurements, the
per-phase record and the gate designs that ratcheted versus the ones that stalled are in
`docs/RESUME.md` — that record may still be the most useful thing in this repo.

Contributions welcome — `docs/ART-BIBLE.md` (the locked direction) and `tools/metrics.mjs` (the
objective gate) are the two things to read first.
