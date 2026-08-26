# Resume notes — paused 2026-08-26 (end of phase 13)

## State
The gate is a **tournament**, not a score. Each attempt is rendered at 1600x900, put side by side
with the reigning champion frame, and shown to two independent judges with the labels in opposite
order so position cannot bias them. It is accepted only if **both** judges pick the challenger;
otherwise `git` reverts it and the champion stands. There is no current score and no referee —
absolute scoring was retired at the start of phase 11 (see *Why scoring was retired*).

- Champion build = `HEAD` (`8150653`, the ripple pass). Champion frame = `shots/champion.png`
  (tracked, updated by the promotion commit). `shots/final-hero.png` is the released capture of the
  same build and framing — a separate capture, so it differs from `champion.png` by TAA jitter only.
- `node tools/sim.mjs` passes: 260 turns in 3417 ms (worst turn 14 ms), 26 cities, pop 4->341, 57
  units, techs 28/32/32/32, 310 buildings, 11 wars and 6 peaces, 14449 pathed tiles with 0 read
  through fog, culture victory to Vellum.
- `npx vite build` succeeds: 25 modules, 1296.68 kB / 397.36 kB gzipped, 495 ms. GitHub Actions
  (`.github/workflows/pages.yml`) runs `npm run build` then `npm test` on every push to `main` and
  deploys `dist/` to https://qmw.github.io/aeon/.
- Released frames, all 1600x900 and all captured `blank:false errors:[]`:
  `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png` (directed via
  `?shot=hero|wide|close`), and `shots/final-unit-closeup.png`, shot through the `?cam=` override at
  `62.46,3.35,75.09,62.46,1.05,66.39` — the selected Aurelia warrior at about seven metres, framed
  clear of the HUD panels with the keep in the same shot for scale.

### The objective gate PASSES for the first time
```
node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand \
  620,700,240,160:near-sand 1200,300,240,160:water
```
| region | mean | sat | hue | HF_rms | MID/HF |
|---|---|---|---|---|---|
| far-rock | 116.1 | 0.291 | 33.2 | 13.75 | 1.04 |
| mid-sand | 97.3 | 0.424 | 66.9 | 21.40 | 1.14 |
| near-sand | 122.1 | 0.416 | 52.0 | 21.96 | 1.24 |
| water | 129.2 | 0.380 | 210.2 | 9.08 | 1.19 |

near/far HF ramp **1.60** (need >= 1.6), crushed 0.07, blown 0.00, `"gate": "PASS"`,
`"failures": []`. Phase 12 failed three checks (mid-sand HF 23.04, near-sand HF 22.24, near-sand
MID/HF 1.34); phase 10 failed seven.

**The PASS is weaker evidence than it looks, and you should know why before you trust it.** Two of
the four standard boxes are still mis-sited at the hero framing: `700,430,200,140` ("mid-sand")
contains no sand at all — a forest tile, a farm and the corner of a city banner, which is why it
reads hue 66.9 — and `620,700,240,160` ("near-sand") is roughly 40% dune, the rest sward, trees and
a strip of river. **Re-siting these two boxes is still the single most useful piece of tooling work
available**, and it is now more urgent, not less, because a passing gate that points at the wrong
biome will happily certify a regression.

The real evidence is hand-sited control boxes on the same frame, which is why they are recorded here
every phase:

| box | phase 12 | phase 13 | verdict |
|---|---|---|---|
| `545,765,80,80` clean dune — HF_rms | 17.84 | 17.65 | inside 12-22 both phases |
| `545,765,80,80` clean dune — MID/HF | **1.82** | **1.09** | the corduroy is gone |
| `545,765,80,80` clean dune — sat / hue | 0.351 / 35.1 | **0.319** / 35.0 | now inside desert 0.24-0.34 |
| `520,300,140,110` near grass — HF_rms | **22.40** | **19.83** | now under the 22 ceiling |
| `520,300,140,110` near grass — sat / hue | 0.431 / 66.9 | 0.429 / 66.9 | unchanged, still hot and yellow |
| `660,180,140,110` far grass — sat / hue | 0.293 / 98.3 | 0.294 / 98.0 | aerial perspective still correct |

Both terrain defects named at the end of phase 12 are genuinely fixed, not merely re-measured.

## Phase 13: what ran

| pass | outcome |
|---|---|
| units — replace the figure builder with a named-joint skeleton so parts hang off the joint they belong to (`3bc7848`), then lift the helmet rim off the eyes and take the shield off the wood zone (`cc532fb`) | accepted, **promoted to champion** (`aa357c0`) |
| terrain — the ripple train stops being corduroy: bounded phase field, wind fetch, blob band out of the sand relief (`79e4f12`) | accepted, **promoted to champion** (`8150653`) |

Two entries, two accepts, no reverts — the first clean phase the project has had. Eight tournament
passes have now run across phases 11-13: **six accepted, two reverted**, both reverts units.

### The units pass, and the thing to carry forward
Three units attempts had lost in a row (phases 11 and 12) before this one. What finally worked was
not another round of part-tweaking: `3bc7848` **replaced the builder**, 371 insertions against 376
deletions in one file, so that every part is authored as a child of a named joint (`chest`, `head`,
`handR`, ...) instead of being placed in figure space and hoped into position. The previous passes
had been fixing the *symptoms* of parts placed in the wrong space — a sword starting in mid-air, a
shield hovering clear of the torso, a helmet behind the skull — one at a time, and each fix broke
the neighbour it was measured against. The structural change fixed all of them at once, which is
also why it could win a paired comparison: nothing visibly got worse.

That is the general lesson and it is worth more than the units result: **when three consecutive
passes each fix one symptom and lose, the bug is the representation, not the values.**

### The terrain pass, and the trap it closes
`79e4f12` is 46 lines added, 8 removed, one file. Phase 12 put every sand band on one scalar phase
`sPh` and that killed the moire, but a single global wavenumber over a whole quadrant is a comb
drawn edge to edge — corduroy. Two fixes, both of which stay on a scalar:

- **A bounded phase field bends the train.** The local wavefront normal is `k + grad(phi)`, so
  adding ~13 rad of noise on the 4-6 u band and ~5 on the 1-3 u band swings the heading about 15
  degrees and wanders the wavelength ~20%. This is the *safe* way to turn a wave, and the
  distinction is the whole trap: a varying **direction** dotted into position scrambles the phase by
  tens of radians per unit and fans into starburst at every zero crossing (this cost phase 12 a full
  iteration); a varying phase **offset** cannot, because `grad(phi)` is bounded by construction.
- **Fetch gates the amplitude.** Ripples build where the pan tilts into the wind and die in the
  sheltered slacks, so the train is patchy rather than continuous. `sRip` carries the gate, so relief,
  trough grit and sheen all fade together.

Contrast then moved off the 24 px ripple (0.17 -> 0.115 in relief) and onto the 385 px dune
(0.30 -> 0.38): the ripple sits on the band `MID_rms` band-passes, the dune is invisible to both
metrics and reads as form. The same pass found that the blob field phase 12 deleted from sand's
*albedo* had simply moved into its *normal* — `nMic` at 3.40 gain in the relief — and subtracted it
there too, and dropped the sward's 3 px band from 0.62 to 0.46, which is what brought near grass
under the ceiling.

### Why scoring was retired
The referee's per-axis noise was about a point and its whole-frame noise about three, which is the
size of a real improvement. Twice that noise threw away the best frame the project had rendered and
both had to be restored by hand: `14fb0ff` (units a2, discarded by phase 9's strict no-axis-drop
rule) and `6a17231` (the massif palette + summit structure, discarded by phase 10's 1-point axis
slack over readability noise). A gate that has to be manually overruled twice is not a gate.

Paired comparison removes the number entirely and asks the question the project is actually judged
on. It is far less noisy, and it has one property worth planning around: **a change that improves
one thing while visibly costing another will lose two votes.** Aim for a frame that is
unambiguously better everywhere, and change less rather than more — or, as phase 13 showed, change
the representation so that there is no trade to make.

## Outstanding defects, in priority order
Judge verdicts are not archived — only the accept/revert decision reaches git — so this list is what
the champion frame and the objective gate show.

1. **Units are still giants — but they are no longer broken giants.** The diagnosis changed this
   phase and the next attempt must not re-fix what is already fixed. Construction is **done**: in
   `final-close.png` and `final-unit-closeup.png` the sword has an arm behind it running shoulder ->
   elbow -> fist -> crossguard, the shield hangs on the left arm, and there is a face with a
   moustache under the helmet rim. **Scale is the remaining fault and has still never been attempted
   under a tournament.** In `final-close.png` the two garrison soldiers stand as tall as the stone
   body of Aurelia's keep tower; in `final-wide.png` a soldier alone on open sand reads as a dark
   monolith the size of a town.

   **The knob is not the one the old notes name.** The foot-soldier multiplier in the scale ladder
   (`units.js` ~2156, `... : 2.55`) is identical on both sides of the rewrite, so scale genuinely
   did not move this phase. And `def.h` is no longer a scale at all — after the rewrite it survives
   only as a portrait-framing hint (`units.js:3494`), so the phase-12 note's "`h: 1.30` is
   untouched" is doubly wrong: 1.30 was the *spearman*, and `h` no longer sets height for anyone.
   Tuning it will change the unit portrait and nothing else.

   **And the ladder has always been solved against the wrong reference.** Read the comment above
   that line: eight rounds of measurement, every one of them targeting the soldier's projected
   height as a fraction of a **hex** — 0.55 of one, ~58 px at the shipped framing. Not once against
   a **building**. A hex is ground; a keep is the thing standing next to him in the frame, and
   soldier-against-keep is the comparison a judge makes without being asked. Measure that ratio
   first, decide what it should be, and solve the ladder for it. `33dec79` ("a soldier is smaller
   than the keep he garrisons") is the one pass that ever tried; it was reverted under phase 9's
   Pareto gate and has never been re-run under a tournament.

2. **Shields read as rings at wide zoom.** New this release, off `final-wide.png`: the Iridon pair
   and the Vantis garrison resolve to figures carrying large gold hoops, because a round shield seen
   near edge-on keeps its bright rim and loses its face entirely. The rim is doing all the reading.
   Cheap and low-risk next to defect 1, and it is the kind of single-symptom fix that can win a
   tournament outright because nothing else moves.
3. **Mountains are the right shape and the right hue on the wrong rock.** Closed summit mass per
   hex, correct instance normals and a hex seam that survives on rock are real gains from phase 11.
   The fault is **chroma, not hue**: far-rock measures sat 0.291 at hue 33.2 against the locked
   mountain `#7A7368`, whose own hue is 37 degrees and whose sat band is 0.08-0.18. It is the right
   colour at twice the saturation, which is exactly why it reads as tan sandstone. (Earlier notes
   framed this as a hue error; it is not.) Shard edges also stay hard and the snow caps are flat
   paper-white patches rather than lit volume.
4. **Per-biome palette compliance — now grass only.** Sand came into band this phase (0.319 against
   desert's 0.24-0.34). Near grass did not: sat 0.429 at hue 66.9 against `#5C7A3A`'s 0.30-0.42 at
   ~88 degrees, i.e. marginally over-saturated and 21 degrees too yellow. Far grass measures 0.294
   at hue 98.0, so the aerial perspective is right and it is the near end that is warm and hot. Open
   ocean at mean 129 is still nearer coast brightness than the specified `#123A63`.
5. **Rivers.** The translucent slab is thinner and the bank is a wet margin, but the channel is
   still a chain of flat angular plates laid along the hex edges rather than a bed cut into the
   terrain, and it takes no sun. In `final-close.png` the reach below Aurelia carries a hard-edged
   blue quad that reads as a decal lying on the ground rather than as water. Green props still
   intersect it in that reach.
6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection —
   `selectedUnit` warrior, `mp` 1, six-tile reach set, `grid.uDim` 0.11 — and none of it is legible
   in the capture. The range plate is a 0.28 cool multiply (`grid.js`, `rng * 0.28 * fe`), the focus
   dim is 11%, and under the golden-hour grade at hero zoom a player cannot see where the selected
   unit can go. Non-negotiable #1 is about seeing the tiles you click; this is the same complaint
   one level up.
7. **The hex seam on rock is present but faint.** No longer outright broken across the mountain
   band, but the line there is far weaker than on grass and it loses wherever the rock goes bright.

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
- Re-siting the two mis-sited metrics boxes (above) is now the highest-value tooling task, because
  the gate reads PASS while pointing at the wrong biome.

## What is working — do not re-roll it
One unifying warm key with the shadow hue within a couple of degrees of the lit hue; correct aerial
perspective on land (far grass 0.294/98.0 against near 0.429/66.9); the hex grid on grass, sand and
plains; coast foam and the shore read; the open sea's swell band and its glitter lobe; the massif's
closed summit masses; the sand's directional dune train and its bent, fetch-gated ripple; the
figure's joint hierarchy — arms that connect a shoulder to a weapon, a face under the helmet; the
Aurelia keep silhouette; the HUD with zero clipping; crushed 0.07 / blown 0.00.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 -> 34 -> 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain.
- One-sided metric targets get gamed: "HF_rms >= 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- **A scoring gate is only as good as its noise floor.** A judge with +-3 on the total cannot
  adjudicate a +2 change; it will reject real work and occasionally accept regressions.
- **Paired comparison removes the noise instead of budgeting for it.** Two judges with the labels
  swapped kills position bias. Phases 11-13 accepted six passes on defects that had gone 0-for-9
  under scoring.
- The price of paired comparison is that partial wins lose. Anything visibly worse anywhere loses a
  vote and the attempt dies. Change less.
- **When three consecutive passes each fix one symptom and lose, the bug is the representation.**
  Units went 0-for-3 on part-by-part fixes and won the moment the builder was replaced with a joint
  hierarchy. A pass that removes the trade-off beats a pass that tunes it.
- **A gate is only as good as where it points, and this is true of a PASS as well as a FAIL.** The
  water box at 1200x675 and both sand boxes at 1600x900 have measured a biome other than the one
  they are named for. Crop and LOOK at every metrics box before you tune against its number — or
  before you believe it when it goes green.
- **Calibrate a size against what stands next to it, not against the ground.** The unit scale
  ladder has been re-measured eight times against soldier-versus-hex and is still wrong, because
  every judge reads soldier-versus-keep. Pick the reference the viewer's eye actually uses.
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
2. Confirm it renders: `node tools/shot.mjs shots/check.png 1600 900` (~2 min, waits for TAA convergence)
3. Read `docs/ART-BIBLE.md` (LOCKED) and `docs/CONTRACT.md` before touching any renderer file.
4. `?cam=x,y,z,tx,ty,tz` parks the camera for close-up work. The released unit close-up is
   `node tools/shot.mjs shots/closeup.png 1600 900 3500 "http://localhost:5173/?cam=62.46,3.35,75.09,62.46,1.05,66.39"`
   — that framing puts the selected warrior clear of every HUD panel with the keep behind him for
   scale, which is exactly the comparison defect 1 needs.
5. The frame to beat is `shots/champion.png` (= `shots/final-hero.png`). Shoot the challenger at the
   same size and framing, show both to two judges with the labels in opposite order, and keep it
   only if both pick it.
