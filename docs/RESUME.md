# Resume notes — paused 2026-08-26 (end of phase 12)

## State
The gate is a **tournament**, not a score. Each attempt is rendered at 1600x900, put side by side
with the reigning champion frame, and shown to two independent judges with the labels in opposite
order so position cannot bias them. It is accepted only if **both** judges pick the challenger;
otherwise `git` reverts it and the champion stands. There is no current score and no referee —
absolute scoring was retired at the start of phase 11 (see *Why scoring was retired*).

- Champion build = `HEAD` (`fbddb26`, the sand pass). Champion frame = `shots/champion.png`
  (tracked, updated by the promotion commit). `shots/final-hero.png` is the released capture of the
  same build and framing — a separate capture, so it differs from `champion.png` by TAA jitter only.
- `node tools/sim.mjs` passes: 260 turns in 4.5 s (worst turn 42 ms), 26 cities, pop 4->341, 57
  units, the 32-tech tree exhausted by three of four civs, 11 wars and 6 peaces, 14449 pathed tiles
  with 0 read through fog, culture victory to Vellum.
- `npx vite build` succeeds: 25 modules, 1292 kB / 395 kB gzipped, 1.3 s. GitHub Actions rebuilds
  `dist/` on push and deploys it to https://qmw.github.io/aeon/.
- Released frames: `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png`
  (1600x900, directed via `?shot=hero|wide|close`; each captured `blank:false errors:[]`).
- The objective gate still **FAILS**, on the same three counts as last phase, by slightly less:

  `node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
  620,700,240,160:near-sand 1200,300,240,160:water`

  | region | mean | sat | hue | HF_rms | MID/HF |
  |---|---|---|---|---|---|
  | far-rock | 116.1 | 0.291 | 33.2 | 13.75 | 1.04 |
  | mid-sand | 95.8 | 0.428 | 66.9 | **23.04** | 1.06 |
  | near-sand | 119.3 | 0.428 | 52.1 | **22.24** | **1.34** |
  | water | 129.2 | 0.380 | 210.2 | 9.08 | 1.19 |

  near/far HF ramp **1.62** (need >= 1.6), crushed 0.08, blown 0.00. Phase 11 measured 14.12 /
  23.70 / 22.98 / 9.09 with ramp 1.63; phase 10 failed seven checks instead of three.

  **The two failing boxes are mis-sited and you should re-site them before believing the failure
  list.** At the hero framing `700,430,200,140` ("mid-sand") contains no sand at all — it is a
  forest tile, a farm and the corner of a city banner, which is why it reads hue 66.9. And
  `620,700,240,160` ("near-sand") is roughly 40% dune, the rest sward, trees, a hut and a strip of
  river. Hand-placed control boxes on this same frame:

  | box | HF_rms | MID/HF | sat | hue |
  |---|---|---|---|---|
  | `545,765,80,80` clean dune face | 17.84 ✓ | **1.82** ✗ | 0.351 | 35.1 |
  | `520,300,140,110` clean near grass | **22.40** ✗ | 0.99 ✓ | 0.431 | 66.9 |
  | `660,180,140,110` far grass | 11.09 (low) | 1.48 | 0.293 | 98.3 |

  Read together: the sand pass did what it claimed — the beach passes the confetti ceiling now and
  its remaining fault is the opposite one, nearly all its energy sitting in the 24 px ripple band.
  The near-field fizz that fails the gate is **grass**, not sand. This is the same class of bug as
  the water box landing on the notification rail at 1200x675 — the gate has been measuring the
  wrong biome and the last two phases' "near sand is confetti" conclusion inherits that error.

## Phase 12: what ran

| pass | outcome |
|---|---|
| tooling — `?cam=x,y,z,tx,ty,tz` parks the camera and freezes input, so unit work can be shot at close range (`3a89ab8`) | kept; not a tournament entry |
| units — a head under the helmet, a grip closing the fist to the crossguard, rounded boots not crates, a contact disc sized off the soles, eye line and moustache in the portrait (four commits, `38a65d4`..`5e3e11a`) | **lost the tournament, reverted whole** (`adf28de`) |
| terrain — sand loses the leopard blotches for a wind-ripple train that follows the fall line (`074dba0`) | accepted, **promoted to champion** (`fbddb26`) |

Six tournament passes have now run across phases 11 and 12: four accepted, two reverted. Both
reverts were units.

### The accepted pass, and why it is the shape of a winner
`074dba0` is 65 lines added, 40 removed, in one file. Every band the sand wears became a harmonic
of **one scalar phase** `sPh = x*0.63 + z*0.78 - y*1.30`: a plane in world space, so its level sets
*are* the crests, and because the world-Y term is evaluated on the surface they bend onto the
contour wherever the ground slopes and hold the wind's bearing on a flat pan. Two properties come
free — a scalar has no winding number, so no crest can pinch into the starburst singularity that
killed the previous ripple ladder; and sinusoids of the same phase are harmonics, so the 5.5 u dune
and the 0.35 u ripple cannot beat each other into moire. The two isotropic Voronoi cell fields
underneath (24 px and 10 px) were **deleted rather than damped**: an isotropic cell field does not
become a desert by tuning. Rock's far-field grain floors came down in the same pass (0.55 -> 0.22
and 0.40 -> 0.16) because the ramp is a ratio and the near end could no longer clear 1.6x a far end
still carrying sub-pixel grain.

The trap it documents, which cost a full iteration: writing the phase as `dot(vWP.xz, someDir)`
with `someDir` varying per fragment. A direction that turns, dotted into a position 50 units from
the origin, scrambles the phase by tens of radians per unit and grows a fan wherever the direction
crosses a zero — starburst hatching over the whole beach, from one wrong line.

### The units pass, and what it tells the next one
`?cam=` was added specifically because eight previous unit attempts had iterated on something the
author could not see at 40 px. It worked as tooling: the pass that used it genuinely fixed
construction at close range — the head stopped being sunk into the chest to its own eye line, the
fist closed onto the crossguard so the blade no longer began in mid-air, the boots stopped being
sky-facing crates, the contact disc stopped pooling darkness between the legs. **And it still lost
both votes.** So the cost is somewhere other than construction, and finding it is the job. Two more
facts: none of the phase-11 or phase-12 units commits touched **scale** (`h: 1.30`, `foot: 0.24`
are untouched), and the one attempt that ever did — `33dec79`, "a soldier is smaller than the keep
he garrisons" — was reverted under phase 9's Pareto gate and has never been re-run under a
tournament.

### Why scoring was retired
The referee's per-axis noise was about a point and its whole-frame noise about three, which is the
size of a real improvement. Twice that noise threw away the best frame the project had rendered and
both had to be restored by hand: `14fb0ff` (units a2, discarded by phase 9's strict no-axis-drop
rule) and `6a17231` (the massif palette + summit structure, discarded by phase 10's 1-point axis
slack over readability noise). A gate that has to be manually overruled twice is not a gate.

Paired comparison removes the number entirely and asks the question the project is actually judged
on. It is far less noisy, and it has one property worth planning around: **a change that improves
one thing while visibly costing another will lose two votes.** Aim for a frame that is
unambiguously better everywhere, and change less rather than more.

## Outstanding defects, in priority order
Judge verdicts are not archived — only the accept/revert decision reaches git — so this list is what
the champion frame and the objective gate show, with the pass that lost the last comparison first.

1. **Units are giants with detached weapons.** Two units passes have now lost back to back. In
   `final-close.png` the two garrison soldiers stand as tall as Aurelia's keep tower, and each
   one's sword and shield hang in the air clear of the torso with no arm between them; the legs
   disappear into the contact pool. In `final-wide.png` a soldier standing alone on open sand is
   as tall as the keep tower of Vantis across the frame from him. At the hero framing the same
   figure resolves to a cream shield disc, a blue oval and a grey blade lying flat on the ground —
   scattered props, not a warrior. See
   *The units pass* above before re-trying: construction is not the remaining cost, and scale has
   not been attempted under a tournament.
2. **The near field's confetti is grass, and the gate boxes are wrong.** All three surviving
   failures live in two boxes that are not mostly sand at this framing (numbers above). A clean
   dune face passes the ceiling at HF 17.84; a clean grass box fails it at 22.40. The sward is a
   speckle of pale green over dark at cloud-shadow scale — that is the material to fix, and the
   boxes want re-siting first so the fix can be measured. Sand's own remaining fault is the
   opposite one: MID/HF 1.82 on a clean dune face, i.e. almost all its energy in the 24 px ripple
   band, which reads as corduroy where the crests cross a slope.
3. **Mountains are the right shape on the wrong rock.** Closed summit mass per hex, correct
   instance normals and a hex seam that survives on rock are all real gains from phase 11. They
   still read as tan sandstone fins: far-rock measures sat 0.291 at hue 33 against the locked
   mountain `#7A7368` (sat 0.08-0.18), shard edges stay hard, and the snow caps are flat
   paper-white patches rather than lit volume.
4. **Per-biome palette compliance.** Whole-frame saturation is inside the metrics band, but the
   bible is written per biome: near grass 0.431 at hue 67 against `#5C7A3A`'s 0.30-0.42 at ~88, a
   clean dune face 0.351 against desert's 0.24-0.34, open ocean at mean 129 nearer coast brightness
   than the specified `#123A63`. Far grass measures 0.293 at hue 98 — the aerial perspective is
   right; it is the near end that is warm and hot.
5. **Rivers.** The translucent slab is thinner and the bank is a wet margin, but the channel is
   still a chain of flat angular plates laid along the hex edges rather than a bed cut into the
   terrain, and it takes no sun. Green props still intersect it in the Aurelia reach.
6. **The order overlay does not read at gameplay zoom.** The hero frame ships a live selection —
   probed in the running page: `selectedUnit` warrior, `mp` 1, six-tile reach set, `grid.uDim`
   0.11 — and none of it is legible in the capture. The range plate is a 0.28 cool multiply
   (`grid.js`, `rng * 0.28 * fe`), the focus dim is 11%, and under the golden-hour grade at hero
   zoom a player cannot see where the selected unit can go. Non-negotiable #1 is about seeing the
   tiles you click; this is the same complaint one level up.
7. **The hex seam on rock is present but faint.** No longer outright broken across the mountain
   band, but the line there is far weaker than on grass and it loses wherever the rock goes bright.

No one has yet put the champion frame beside a real Civ VI screenshot under tournament rules. The
last time that comparison was run the judge picked the real one immediately, and nothing here
suggests that has changed.

## Housekeeping worth someone's decision
- `tools/` carries ~70 committed single-letter scratch probes (`_gknob.mjs`, `_w8d.mjs`, ...) left
  by past agents. `3a83f55` dropped one batch; the rest are still there and none is referenced by
  `sim.mjs`, `shot.mjs`, `metrics.mjs` or `insp.mjs`.
- `shots/` carries ~900 committed-or-not intermediate captures. `.gitignore` keeps all but
  `final-*`, `converged`, `champion` and `p7-state` out of git, so this is disk, not repo weight.

## What is working — do not re-roll it
One unifying warm key with the shadow hue within a couple of degrees of the lit hue; correct aerial
perspective on land (far grass 0.293/98 against near 0.431/67); the hex grid on grass, sand and
plains; coast foam and the shore read; the open sea's swell band and its glitter lobe; the massif's
closed summit masses; the sand's directional dune train (new this phase); the Aurelia keep
silhouette; the HUD with zero clipping; crushed 0.08 / blown 0.00.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 -> 34 -> 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain.
- One-sided metric targets get gamed: "HF_rms >= 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- **A scoring gate is only as good as its noise floor.** A judge with +-3 on the total cannot
  adjudicate a +2 change; it will reject real work and occasionally accept regressions.
- **Paired comparison removes the noise instead of budgeting for it.** Two judges with the labels
  swapped kills position bias. Phases 11-12 accepted four passes on defects that had gone 0-for-9
  under scoring.
- The price of paired comparison is that partial wins lose. Anything visibly worse anywhere loses a
  vote and the attempt dies. Change less.
- **A gate is only as good as where it points.** Both the water box at 1200x675 and the two sand
  boxes at 1600x900 have measured a biome other than the one they are named for. Crop and LOOK at
  every metrics box before you tune against its number.
- Superposed sinusoids with noise-modulated phase are an interference-pattern generator. If a
  material needs more than one wave, make them harmonics of one scalar phase.
- Close-range tooling fixes close-range bugs only: `?cam=` did exactly what it was added for and
  the pass using it still lost at gameplay zoom. Always verify at 40 px; the tournament is judged
  there.
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
4. `?cam=x,y,z,tx,ty,tz` parks the camera for close-up work, e.g.
   `node tools/shot.mjs shots/closeup.png 900 600 1000 "http://localhost:5173/?cam=62,8,86,60,2,76"`.
5. The frame to beat is `shots/champion.png` (= `shots/final-hero.png`). Shoot the challenger at the
   same size and framing, show both to two judges with the labels in opposite order, and keep it
   only if both pick it.
