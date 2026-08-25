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
every invariant, and `npx vite build` ships a static bundle.

The **renderer** is closer than it was, and still not there. A referee agent scores the frame against
a real Civilization VI screenshot on six independent axes; the current frame stands at **57/100**:

| lighting | material | readability | units | colour | finish | total |
|---|---|---|---|---|---|---|
| 20/30 | **8/20** | 9/15 | 6/15 | 6/10 | 8/10 | **57/100** |

What holds up: one unifying warm key with the shadow hue within a couple of degrees of the lit hue,
correct aerial perspective on land, the hex grid on grass, sand and plains, coast foam, the keep
silhouette, a HUD with no clipping anywhere, and clean ends of the histogram — 0.07 of the frame
crushed, none of it blown.

What does not, in the referee's priority order:

1. **Ground material is screen-space, not world-space.** The near/far detail ramp measures 1.54
   against a 1.6 requirement, near and mid sand run HF 22.6 and 23.7 against a 22 confetti ceiling,
   and the referee finds the far plain collapsed the other way, to HF 5 at MID/HF 2.13 — blurry
   nothing. Both ends are one bug: detail drawn at pixel scale instead of at a fixed world size.
   Weakest axis at 8/20.
2. **The hex grid vanishes across the mountain band** — about a third of the frame with no clickable
   tile boundary, in a game played by clicking tiles. Art-bible non-negotiable #1.
3. **Mountains are intersecting flat shards.** Hard polygon seams, adjacent faces disagreeing about
   where the sun is, paper-white snow caps and a milky near-white void where the summits should have
   volume.
4. **Land saturation runs hot against the locked palette** — grass measures 0.45–0.55 against a
   0.30–0.42 spec, sand 0.42–0.47 against desert's 0.24–0.34 — and open ocean sits at coast
   brightness instead of the specified `#123A63`.
5. **Rivers read as hard-edged unlit cyan cutouts**, with a translucent slab laid over the tiles
   instead of a channel cut into them.
6. **Units still do not name themselves at gameplay zoom** (6/15, up from 3/15). Close up they
   resolve into sword-and-shield soldiers; at the distance the hero frame is played at, an occupied
   tile is a strength badge and a contact ring over a mound.

Blind judging still picks the real Civ VI immediately, and the objective gate agrees:
`tools/metrics.mjs` on the shipped `shots/final-hero.png` reports **FAIL** on seven counts. All of it
is written up with the measurements behind it, in priority order, in `docs/RESUME.md`.

Ten phases in, the whole-frame score went 61 → 34 → 22 under parallel agents, then climbed to 50
under sequential single-owner passes with a revert gate, and to 57 once that gate stopped rejecting
every trade. The most useful thing in this repo may be that record: `docs/RESUME.md` documents which
gate designs ratcheted and which stalled — including one so strict it discarded the best frame the
project had ever rendered over a single point on a single axis, and the looser rule that had to put
it back. The three passes since have reverted nine attempts out of nine: the remaining defects are
coupled, and none of them is a one-file fix.

Contributions welcome — `docs/ART-BIBLE.md` (the locked direction) and `tools/metrics.mjs` (the
objective gate) are the two things to read first.
