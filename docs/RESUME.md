# Resume notes — paused 2026-08-26 (end of phase 14)

## State
The gate is a **tournament**, not a score. Each attempt is rendered at 1600x900, put side by side
with the reigning champion frame, and shown to two independent judges with the labels in opposite
order so position cannot bias them. It is accepted only if **both** judges pick the challenger;
otherwise `git` reverts it and the champion stands. There is no current score and no referee —
absolute scoring was retired at the start of phase 11 (see *Why scoring was retired*).

- Champion build = `HEAD` (`27d8a1b`, the shallows revert; the last change that is actually IN the
  build is the vegetation pair `d831603` + `73bb610`).
- **`shots/champion.png` is STALE and this is the first thing to fix.** Its last update is the
  phase-13 promotion commit `8150653`, so it is a frame of a build without the accepted vegetation
  work. The three phase-14 water challengers were therefore compared against the wrong champion.
  Re-shoot it from `HEAD` before running anything: `node tools/shot.mjs shots/champion.png 1600 900`.
  `shots/final-hero.png` is the released capture of the same build and framing and differs only by
  TAA jitter, so copying it is also acceptable.
- `node tools/sim.mjs` passes: 260 turns in 3247 ms (worst turn 14 ms), 26 cities, pop 4->341, 57
  units, techs 28/32/32/32, 310 buildings, 11 wars and 6 peaces, 14449 pathed tiles with 0 read
  through fog, culture victory to Vellum.
- `npx vite build` succeeds: 25 modules, 1298.39 kB / 398.05 kB gzipped, 1.01 s. GitHub Actions
  (`.github/workflows/pages.yml`) runs `npm run build` then `npm test` on every push to `main` and
  deploys `dist/` to https://qmw.github.io/aeon/.
- Released frames, all 1600x900 and all captured `blank:false errors:[]`:
  `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png` (directed via
  `?shot=hero|wide|close`), and `shots/final-unit-closeup.png`, shot through the `?cam=` override at
  `62.46,3.35,75.09,62.46,1.05,66.39` — the selected Aurelia warrior at about seven metres, framed
  clear of the HUD panels with the keep in the same shot for scale.

### The objective gate still PASSES — with one hundredth of headroom
```
node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand \
  620,700,240,160:near-sand 1200,300,240,160:water
```
| region | mean | sat | hue | HF_rms | MID/HF |
|---|---|---|---|---|---|
| far-rock | 116.1 | 0.292 | 33.1 | 13.68 | 1.05 |
| mid-sand | 99.7 | 0.415 | 67.0 | 21.83 | 1.16 |
| near-sand | 123.2 | 0.416 | 51.5 | 21.99 | 1.25 |
| water | 129.2 | 0.380 | 210.2 | 9.09 | 1.19 |

near/far HF ramp **1.61** (need >= 1.6), crushed 0.07, blown 0.00, `"gate": "PASS"`,
`"failures": []`.

**Two margins are now knife-thin and you must plan around both.**

- **near-sand HF_rms 21.99 against a hard ceiling of 22.00** (`tools/metrics.mjs:52`, `HF: [12,22]`,
  strict `>`). Both sand boxes contain trees, and the phase-14 canopy work put detail energy
  straight back into them: mid-sand went 21.40 -> 21.83, near-sand 21.96 -> 21.99. Any pass that
  adds high-frequency structure in the near field fails the gate unless it removes some first.
- **near/far ramp 1.61 against a floor of 1.60.** The ramp is `near-sand HF / far-rock HF`, and it
  only survives because far-rock also drifted down (13.75 -> 13.68). Sharpening the mountains fails
  the ramp; softening the near field fails it too, from the other side. This is a scissors.

The four standard boxes remain mis-sited, and a passing gate that points at the wrong biome is more
dangerous than a failing one, not less: at the hero framing `700,430,200,140` ("mid-sand") contains
no sand at all — a forest tile, a farm and the corner of a city banner, which is why it reads hue
67 — and `620,700,240,160` ("near-sand") is roughly 40% dune, the rest sward, trees and a strip of
river. **Re-siting these two boxes is still the highest-value tooling work available**, and it is
now urgent, because the box whose ceiling you are 0.01 away from is not measuring sand.

The real evidence is the hand-sited control boxes, recorded every phase:

| box | phase 12 | phase 13 | phase 14 | verdict |
|---|---|---|---|---|
| `545,765,80,80` clean dune — HF_rms | 17.84 | 17.65 | 17.65 | unchanged; terrain untouched |
| `545,765,80,80` clean dune — MID/HF | **1.82** | **1.09** | 1.09 | corduroy stays gone |
| `545,765,80,80` clean dune — sat / hue | 0.351 / 35.1 | 0.319 / 35.0 | 0.319 / 35.0 | inside desert 0.24-0.34 |
| `520,300,140,110` near grass — HF_rms | **22.40** | 19.83 | 19.70 | under the 22 ceiling |
| `520,300,140,110` near grass — sat / hue | 0.431 / 66.9 | 0.429 / 66.9 | 0.429 / 66.8 | still hot and yellow |
| `660,180,140,110` far grass — sat / hue | 0.293 / 98.3 | 0.294 / 98.0 | 0.292 / 98.7 | aerial perspective correct |

The dune box is byte-for-byte identical across phases 13 and 14, which is the check that phase 14
touched only the props and not the ground under them.

## Phase 14: what ran

| pass | outcome |
|---|---|
| veg — canopies become clustered crowns: per-lobe value and sky occlusion, a third silhouette per biome, no lollipops on crags (`d831603`); then canopy masses get their own normals, conifer tiers step, the acacia stops being a tarp (`73bb610`) | **accepted** |
| water — carry the swell across the shelf, comb the seabed with a shoaling caustic set, narrow the surf, take the cool haze off the beach apron (`4473b38`) | folded into the next attempt |
| water — the shelf gets its wave read from underneath: shoaling bands in the optical path, a combed caustic net on a rippled bed, violet haze off the swash (`65c8304`) | folded into the next attempt |
| water — the wave field carries across the shelf on a depth window, the surf scallops and narrows, the swash stops veiling the sand (`6181f0c`) | **reverted** (`27d8a1b`) |

Ten tournament passes have now run across phases 11-14: **seven accepted, three reverted** — two
units, one water.

### The veg pass, and why it won
Two commits, one file, +132/-54 net. Neither of them tuned a value; both changed what a tree *is*.

- **`fin()` was blending every foliage vertex toward one centroid for the whole tree.** Five
  modelled lobes therefore shared one value gradient, so none of the modelling reached the screen
  and a crown came back as a smooth green egg with facets. The fix carries a per-primitive centre
  (`P.ct`, pushed by `ring()` and `blob()`) and rounds each vertex toward the centre of the lobe or
  the branch tier that owns it. The seams between masses go dark on their own; that is the entire
  clustered-crown read.
- **`TREES.mountain` and `TREES.snow` are now 0.** A summit is a modelled mass above the treeline,
  but the scatter seats its trees on the HEX FIELD under it — so those instances came out as lone
  bright-green lollipops glued to a bare cliff a thousand metres above anything that grows. The
  crag and treeline density factors also had their 0.85/0.90 coefficients raised to 1.0, so "no
  forest on a crag" now closes instead of leaving one or two survivors, which is the worst possible
  count: one tree alone on a cliff face is more obviously fake than fifty.
- Per-lobe exposure (`v` in `crown()`), a third silhouette per biome (conifer C, broadleaf C — a
  spreading oak with two long limbs), conifer tiers as offset skirts with a dark hem and a bright
  shoulder rather than slices of one cone, and yaw moved off `h5` onto its own hash `h8` — they had
  shared a hash, so every conifer-A on the map faced the same half of the compass.
- The per-vertex lobe jitter came DOWN, from +-45% to +-22%. Half a radius of jitter turns a lobe
  into a spiked star and five of those is the crumpled-cabbage read. The irregular silhouette has to
  come from where the lobes SIT, not from stabbing each one.

### The water passes, and why they lost
Three attempts, all on `src/render/water.js`, all reverted as one. The ideas were sound physics —
inside a shoal a swell refracts until its crests lie parallel to the coast, so an isoline of the
distance field is already a crest line; a wave that feels the bottom shortens, so the set compresses
as it comes ashore, and that compression is the depth cue; over sand nine tenths of the pixel is
transmitted bed light, so a wave read has to arrive THROUGH the column rather than as a brightness
gain on top of it. The last attempt was careful, too: the bar term is a *window* on depth
(`smoothstep(0.14,0.38,d) * (1-smoothstep(0.36,0.68,d))`) precisely so it lifts only the shelf and
leaves the harbour pool and the open sea — both of which had already won their own rounds —
untouched.

It still lost. **The lesson is not "the physics was wrong", it is that the shelf was not the frame's
problem.** Three passes were spent adding texture to a band that no judge had complained about,
while the river running through the middle of every close frame is still a flat plate. Pick the
defect that is visible in the frame the tournament is judged on, not the one that is most
interesting to model.

### Why scoring was retired
The referee's per-axis noise was about a point and its whole-frame noise about three, which is the
size of a real improvement. Twice that noise threw away the best frame the project had rendered and
both had to be restored by hand: `14fb0ff` (units a2, discarded by phase 9's strict no-axis-drop
rule) and `6a17231` (the massif palette + summit structure, discarded by phase 10's 1-point axis
slack over readability noise). A gate that has to be manually overruled twice is not a gate.

Paired comparison removes the number entirely and asks the question the project is actually judged
on. It is far less noisy, and it has one property worth planning around: **a change that improves
one thing while visibly costing another will lose two votes.** Aim for a frame that is
unambiguously better everywhere, and change less rather than more — or, as phases 13 and 14 both
showed, change the representation so that there is no trade to make.

## Outstanding defects, in priority order
Judge verdicts are not archived — only the accept/revert decision reaches git — so this list is what
the released frames and the objective gate show.

1. **Units are giants, and scale has still never been attempted under a tournament.** This is the
   worst defect in the project and the one with the clearest evidence.

   Construction is **done** — do not re-fix it. In `final-unit-closeup.png` the sword has an arm
   behind it running shoulder -> elbow -> fist -> crossguard, the shield hangs on the left arm,
   there is a face with a moustache under the helmet rim, and the feet are boots.

   Scale is untouched and wrong. In `final-unit-closeup.png` the warrior standing beside Aurelia's
   keep is **taller than the keep**: his helmet clears the stone curtain entirely and his shoulders
   sit at the mid-height of the red-roofed tower. In `final-wide.png` a lone soldier on open sand is
   a dark monolith larger than the buildings of the town two hexes away, and in `final-close.png`
   the two garrison figures dwarf everything inside the walls.

   **The knob is not the one the old notes name.** The foot-soldier multiplier in the scale ladder
   (`src/render/units.js` ~2156, `... : 2.55`) is identical on both sides of the phase-13 rewrite.
   And `def.h` is no longer a scale at all — after that rewrite it survives only as a
   portrait-framing hint (`units.js:3494`), so tuning it changes the unit portrait and nothing else.

   **And the ladder has always been solved against the wrong reference.** Read the comment above
   that line: eight rounds of measurement, every one targeting the soldier's projected height as a
   fraction of a **hex** (0.55 of one, ~58 px at the shipped framing). Not once against a
   **building**. A hex is ground; a keep is the thing standing next to him in the frame, and
   soldier-against-keep is the comparison a judge makes without being asked. Measure that ratio off
   `final-unit-closeup.png` first, decide what it should be, and solve the ladder for it.
   `33dec79` ("a soldier is smaller than the keep he garrisons") is the one pass that ever tried; it
   was reverted under phase 9's Pareto gate and has never been re-run under a tournament.

2. **Rivers are flat plates, and at wide zoom they read as ice.** Promoted from #5 — the wide frame
   makes this worse than last release described. In `final-wide.png` the reach below Aurelia is a
   broad pale-blue sheet with hard polygonal edges lying on top of the sand; the honest read is a
   glacier or spilled paint, not a river. In `final-close.png` the same reach is a hard-edged cyan
   quad plus a second small blue rectangle beside the unit badge, both plainly decals on the ground,
   and green props still intersect the water. The channel is a chain of flat plates laid along hex
   edges rather than a bed cut into the terrain, and it takes no sun.

   This is the defect the three water passes should have gone after. It is in the middle of two of
   the four released frames.

3. **Shields read as gold rings at wide zoom.** Unchanged from last release. In `final-wide.png` the
   Iridon pair and the Vantis garrison resolve to figures carrying large gold hoops, because a round
   shield seen near edge-on keeps its bright rim and loses its face entirely — the rim is doing all
   the reading. Cheap and isolated next to defect 1, and the kind of single-symptom fix that can win
   a tournament outright because nothing else moves.

4. **Mountains are the right shape and the right hue on the wrong rock.** Closed summit mass per
   hex, correct instance normals and a hex seam that survives on rock are real gains from phase 11.
   The fault is **chroma, not hue**: far-rock measures sat 0.292 at hue 33.1 against the locked
   mountain `#7A7368`, whose own hue is 37 degrees and whose sat band is 0.08-0.18. It is the right
   colour at twice the saturation, which is exactly why the range reads as a tan sandstone canyon
   rather than alpine rock. Shard edges also stay hard and the snow caps are flat paper-white
   patches rather than lit volume. **Careful:** desaturating rock is safe for the gate, but
   sharpening it is not — far-rock HF is the denominator of the 1.61 ramp.

5. **Per-biome palette compliance — grass only.** Sand is in band (0.319 against desert's 0.24-0.34)
   and far grass is correct (0.292 at hue 98.7, so the aerial perspective is right). Near grass is
   not: sat 0.429 at hue 66.8 against `#5C7A3A`'s 0.30-0.42 at ~88 degrees, i.e. marginally
   over-saturated and 21 degrees too yellow. Open ocean at mean 129 is still nearer coast brightness
   than the specified `#123A63`.

6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection —
   `selectedUnit` warrior, `mp` 1, six-tile reach set, `grid.uDim` 0.11 — and none of it is legible
   in the capture. The range plate is a 0.28 cool multiply (`grid.js`, `rng * 0.28 * fe`), the focus
   dim is 11%, and under the golden-hour grade at hero zoom a player cannot see where the selected
   unit can go. Non-negotiable #1 is about seeing the tiles you click; this is the same complaint
   one level up.

7. **The hex seam on rock is present but faint.** No longer outright broken across the mountain
   band, but the line there is far weaker than on grass and it loses wherever the rock goes bright.

8. **Gate defects** (not visual, but they will decide the next phase): near-sand HF headroom is
   0.01, the near/far ramp headroom is 0.01 in the opposite direction, and two of the four boxes
   measure a biome other than the one they are named for. See *The objective gate* above.

No one has yet put the champion frame beside a real Civ VI screenshot under tournament rules. The
last time that comparison was run the judge picked the real one immediately, and nothing here
suggests that has changed.

## Housekeeping worth someone's decision
- `tools/` carries **67 committed single-letter scratch probes** (`_u5force6.mjs`, `_w8d.mjs`, ...)
  left by past agents, against 6 real tools (`sim`, `shot`, `metrics`, `insp`, `tfps`, `tzoom`).
  `3a83f55` dropped one batch; none of the rest is referenced by anything. This is a one-line
  `git rm` and nobody has been willing to own it.
- `shots/` carries ~900 intermediate captures. `.gitignore` keeps all but `final-*`, `converged`,
  `champion` and `p7-state` out of git, so this is disk, not repo weight.
- Re-siting the two mis-sited metrics boxes (above) is the highest-value tooling task.
- **Promotion is a manual step and it was missed this phase.** When a pass is accepted, re-shoot
  `shots/champion.png` from the accepted build and commit it, or the next challenger is judged
  against a frame from a build that no longer exists.

## What is working — do not re-roll it
One unifying warm key with the shadow hue within a couple of degrees of the lit hue; correct aerial
perspective on land (far grass 0.292/98.7 against near 0.429/66.8); the hex grid on grass, sand and
plains; coast foam and the shore read; the open sea's swell band and its glitter lobe; the massif's
closed summit masses; the sand's directional dune train and its bent, fetch-gated ripple; canopies
that read as clustered lobed crowns with per-lobe value, stepped conifer tiers and three silhouettes
per biome; a treeline that closes; the figure's joint hierarchy — arms that connect a shoulder to a
weapon, a face under the helmet; the Aurelia keep silhouette; the HUD with zero clipping; crushed
0.07 / blown 0.00.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 -> 34 -> 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain.
- One-sided metric targets get gamed: "HF_rms >= 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- **A scoring gate is only as good as its noise floor.** A judge with +-3 on the total cannot
  adjudicate a +2 change; it will reject real work and occasionally accept regressions.
- **Paired comparison removes the noise instead of budgeting for it.** Two judges with the labels
  swapped kills position bias. Phases 11-14 accepted seven passes on defects that had gone 0-for-9
  under scoring.
- The price of paired comparison is that partial wins lose. Anything visibly worse anywhere loses a
  vote and the attempt dies. Change less.
- **When three consecutive passes each fix one symptom and lose, the bug is the representation.**
  Units went 0-for-3 on part-by-part fixes and won the moment the builder was replaced with a joint
  hierarchy. Vegetation won the same way: the crown was not a shading value, it was `fin()`
  averaging five lobes to one centroid. A pass that removes the trade-off beats a pass that tunes it.
- **Attack the defect that is in the frame, not the one that is most interesting to model.** Phase
  14 spent three passes giving the shelf a wave read — good physics, band nobody had complained
  about — while a flat blue plate sat in the middle of two of the four released frames.
- **A gate is only as good as where it points, and this is true of a PASS as well as a FAIL.** The
  water box at 1200x675 and both sand boxes at 1600x900 have measured a biome other than the one
  they are named for. Crop and LOOK at every metrics box before you tune against its number — or
  before you believe it when it goes green.
- **A gate with 0.01 of headroom is a tripwire, not a gate.** Check both margins before you start:
  near-sand HF is 0.01 under its ceiling and the near/far ramp is 0.01 over its floor, and they move
  in opposite directions.
- **Calibrate a size against what stands next to it, not against the ground.** The unit scale
  ladder has been re-measured eight times against soldier-versus-hex and is still wrong, because
  every judge reads soldier-versus-keep. Pick the reference the viewer's eye actually uses.
- **A silhouette gets its irregularity from where the masses SIT, not from jittering each one.**
  +-45% per-vertex jitter on a canopy lobe makes a spiked star; five of those is a crumpled cabbage.
  Phase 14 halved the jitter and moved the variation to lobe placement.
- **The worst count of a bad prop is one.** A crag that kept 15% of its trees kept one or two, and a
  single tree on a bare cliff is more obviously fake than a forest. Density factors that mean "none"
  must reach zero.
- Superposed sinusoids with noise-modulated phase are an interference-pattern generator. If a
  material needs more than one wave, make them harmonics of one scalar phase.
- **Bend a wave with a phase offset, never with a direction.** `grad(phi)` from a noise field is
  bounded, so the crests curve; a per-fragment direction dotted into a world position 50 units from
  the origin scrambles the phase by tens of radians per unit and fans into starburst at every zero
  crossing.
- **Deleting a band from albedo does not delete it from the material.** Phase 12 removed sand's blob
  field from the colour and phase 13 found the same blobs still in the normal at 3.40 gain. Check
  every channel a band touches.
- Close-range tooling fixes close-range bugs only: `?cam=` did exactly what it was added for and the
  phase-12 pass using it still lost at gameplay zoom. Always verify at 40 px; the tournament is
  judged there.
- The screenshot harness must wait on rendered-frame count, not wall-clock: at ~1 fps under
  software WebGL a timed wait captures an unconverged TAA frame.
- `?nopost=1` renders the raw scene — the fastest way to tell a shading bug from a post bug.
- The standard metrics boxes assume a 1600x900 capture. At the 1200x675 fast-loop size `620,760` is
  off-canvas and `1150,200` lands on the notification rail.

## To restart
1. Dev server (nothing else needs it running):
   `setsid nohup npx vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &`
2. **Re-shoot the champion frame first** — it is stale (see *State*):
   `node tools/shot.mjs shots/champion.png 1600 900` (~2 min, waits for TAA convergence)
3. Read `docs/ART-BIBLE.md` (LOCKED) and `docs/CONTRACT.md` before touching any renderer file.
4. `?cam=x,y,z,tx,ty,tz` parks the camera for close-up work. The released unit close-up is
   `node tools/shot.mjs shots/closeup.png 1600 900 3500 "http://localhost:5173/?cam=62.46,3.35,75.09,62.46,1.05,66.39"`
   — that framing puts the selected warrior clear of every HUD panel with the keep behind him for
   scale, which is exactly the comparison defect 1 needs.
5. Shoot the challenger at the same size and framing as the champion, show both to two judges with
   the labels in opposite order, and keep it only if both pick it. If it is accepted, **promote the
   frame in the same commit**.
