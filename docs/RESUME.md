# Resume notes — paused 2026-08-25 (end of phase 11)

## State
The gate is a **tournament**, not a score. Each attempt is rendered at 1600x900, put side by side
with the reigning champion frame, and shown to two independent judges with the labels in opposite
order so position cannot bias them. It is accepted only if **both** judges pick the challenger;
otherwise `git` reverts it and the champion stands. There is no current score and no referee —
absolute scoring was retired at the start of this phase (see *Why scoring was retired*).

- Champion build = `HEAD` (`74ecef7`). Champion frame = `shots/final-hero.png`; the local
  `shots/champion.png` is the same build and framing (gitignored, so the released hero frame is the
  copy that travels).
- `node tools/sim.mjs` passes: 260 turns in 3.3 s (worst turn 13 ms), 26 cities, pop 4->341, 57
  units, the 32-tech tree exhausted by three of four civs, 11 wars and 6 peaces, 14449 pathed tiles
  with 0 read through fog, culture victory to Vellum.
- `npx vite build` succeeds: 25 modules, 1289 kB / 394 kB gzipped, 0.5 s. GitHub Actions rebuilds
  `dist/` on push and deploys it.
- Released frames: `shots/final-hero.png`, `shots/final-wide.png`, `shots/final-close.png`
  (1600x900, directed via `?shot=hero|wide|close`; each captured `blank:false errors:[]`).
- The objective gate still **FAILS**, but on three counts instead of seven:

  `node tools/metrics.mjs shots/final-hero.png 200,120,200,140:far-rock 700,430,200,140:mid-sand
  620,700,240,160:near-sand 1200,300,240,160:water`

  | region | mean | sat | hue | HF_rms | MID/HF |
  |---|---|---|---|---|---|
  | far-rock | 115.3 | 0.290 | 33.1 | 14.12 | 1.01 |
  | mid-sand | 97.2 | 0.430 | 66.9 | **23.70** | 1.07 |
  | near-sand | 117.6 | 0.436 | 52.1 | **22.98** | **1.36** |
  | water | 129.2 | 0.380 | 210.2 | 9.09 | 1.19 |

  near/far HF ramp **1.63** (need >= 1.6) — passing for the first time in the project — crushed
  0.08, blown 0.00. The three remaining failures are all near-camera ground: mid-sand and near-sand
  HF over the 22 confetti ceiling, near-sand MID/HF over 1.3. Water, land saturation, the ramp and
  both ends of the histogram now pass clean. The water box lands on open sea clear of the
  notification rail — check that before trusting any number from it.

  For reference, the phase 10 release measured seven failures: ramp 1.54, water HF 3.52 at
  MID/HF 3.92, near-sand sat 0.467, mid/near-sand HF 23.69/22.61, near-sand MID/HF 1.36.

## Phase 11: the tournament, and what it unstuck

| pass | outcome |
|---|---|
| terrain/post — restore the massif palette + world-space summit structure the score gate had reverted | restored by hand (`6a17231`); this is the change that triggered the switch |
| terrain — rock gets its mineral chroma back, one warm family, strata stay value | accepted (`6fa36aa`) |
| water — a pixel band the sea can keep, glitter back in its lobe, the river's gravel slab becomes a wet margin | accepted (`1d9da36`) |
| massif — one closed summit mass per hex welded to the hex field, real instance normals, snow off the tonemap shoulder, a hex seam that survives on rock | accepted, **promoted to champion** (`a1d024f`) |
| units — helmet over the head, sword off the float, shield fitted, idle facing, no TAA ghosting | **lost the tournament, reverted whole** (`74ecef7`) |

Three of the four passes actually gated by a tournament landed, on defects that had eaten nine
straight attempts under scoring — mountains, terrain material and water each failed alone in phases
8-10 and each landed here.

### Why scoring was retired
The referee's per-axis noise was about a point and its whole-frame noise about three, which is the
size of a real improvement. Twice that noise threw away the best frame the project had rendered and
both had to be restored by hand: `14fb0ff` (units a2, discarded by phase 9's strict no-axis-drop
rule) and `6a17231` (the massif palette + summit structure, discarded by phase 10's 1-point axis
slack over readability noise). A gate that has to be manually overruled twice is not a gate.

Paired comparison removes the number entirely and asks the question the project is actually judged
on. It is far less noisy, and it has one property worth planning around: **a change that improves
one thing while visibly costing another will lose two votes.** The units pass was reverted whole for
that — the cast improved and something else in the frame did not survive the trade. Aim for a frame
that is unambiguously better everywhere, and change less rather than more.

## Outstanding defects, in priority order
Judge verdicts are not archived — only the accept/revert decision reaches git — so this list is what
the champion frame and the objective gate show, with the pass that lost the last comparison first.

1. **Units are giants with no arms.** The one pass since the champion was crowned was a units pass
   and it lost. Scale is the loudest part: in `final-close.png` the garrison soldier stands as tall
   as Aurelia's keep tower, and in `final-wide.png` a single soldier is the height of the walled
   town beside him. His sword and shield hang at his sides with no arm reaching either one. At
   gameplay distance the same figure collapses to a strength badge and a contact ring over a mound.
   Two things to know before re-trying this: the three commits still in history at `07601c1` fixed
   the helmet, the sword and the shield and still lost the comparison, so find what else they cost;
   and none of them touched scale. The one attempt that did (`33dec79`, "a soldier is smaller than
   the keep he garrisons") was reverted under phase 9's Pareto gate and has never been re-run
   against a tournament.
2. **The near field is confetti over blobs.** All three surviving gate failures are in the two sand
   boxes nearest the camera: HF 23.70 and 22.98 against a 22 ceiling, MID/HF 1.36 against 1.3. The
   distance falloff is finally fixed (ramp 1.63), so this is no longer the old "screen-space
   material" bug across the whole frame — it is one band. Near ground reads as leopard-spot
   mottling at cloud-shadow scale with pixel fizz on top, instead of grain at a nameable world size.
3. **Mountains are the right shape on the wrong rock.** The massif pass gave them a closed summit
   mass per hex, correct instance normals and a hex seam that survives on rock — all new, all real.
   They now read as tan sandstone wedges: far-rock measures sat 0.29 at hue 33 against the locked
   mountain `#7A7368` (sat 0.08-0.18), shard edges stay hard, and the snow caps are flat
   paper-white triangles rather than lit volume.
4. **Per-biome palette compliance.** Whole-frame saturation is inside the metrics band now, but the
   bible is written per biome and sand at 0.43 is well over desert's 0.24-0.34. Open ocean at mean
   129 is nearer coast brightness than the specified `#123A63`.
5. **Rivers.** The translucent slab is thinner and the bank is a wet margin now, but the channel is
   still a chain of flat angular plates laid along the hex edges rather than a bed cut into the
   terrain, and it takes no sun. Green props also intersect it in the Aurelia reach.
6. **The hex seam on rock is present but faint.** Non-negotiable #1 is no longer outright broken
   across the mountain band, which is new — but the line there is far weaker than on grass and it
   loses wherever the rock goes bright.

No one has yet put the champion frame beside a real Civ VI screenshot under tournament rules. The
last time that comparison was run the judge picked the real one immediately, and nothing here
suggests that has changed.

## What is working — do not re-roll it
One unifying warm key with the shadow hue within a couple of degrees of the lit hue; correct aerial
perspective on land; the hex grid on grass, sand and plains; coast foam and the shore read; the open
sea's swell band and its glitter lobe (new this phase, and the water region passes the gate for the
first time); the massif's closed summit masses; the Aurelia keep silhouette; the HUD with zero
clipping; crushed 0.08 / blown 0.00.

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 -> 34 -> 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain.
- One-sided metric targets get gamed: "HF_rms >= 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- **A scoring gate is only as good as its noise floor.** A judge with +-3 on the total cannot
  adjudicate a +2 change; it will reject real work and occasionally accept regressions. Every
  variant of the score gate this project tried — no-axis-drop, Pareto, bounded trade — was an
  attempt to work around noise it could not remove.
- **Paired comparison removes the noise instead of budgeting for it.** "Which of these two is
  better" is a far easier question than "how many points is this out of 100", and two judges with
  the labels swapped kills position bias. Phase 11 accepted three passes on defects that had gone
  0-for-9 under scoring.
- The price of paired comparison is that partial wins lose. There is no "+3 total, -1 on one axis"
  any more; anything visibly worse anywhere loses a vote and the attempt dies. Change less.
- The screenshot harness must wait on rendered-frame count, not wall-clock: at ~1 fps under
  software WebGL a timed wait captures an unconverged TAA frame, which produced dozens of bogus
  "near-field is blurry" critiques.
- `?nopost=1` renders the raw scene — the fastest way to tell a shading bug from a post bug.
- The standard metrics boxes assume a 1600x900 capture. At the 1200x675 fast-loop size `620,760` is
  off-canvas and `1150,200` lands on the notification rail, so the gate silently measures UI.

## To restart
1. Dev server (nothing else needs it running):
   `setsid nohup npx vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &`
2. Confirm it renders: `node tools/shot.mjs shots/check.png 1600 900` (~2 min, waits for TAA convergence)
3. Read `docs/ART-BIBLE.md` (LOCKED) and `docs/CONTRACT.md` before touching any renderer file.
4. The frame to beat is `shots/final-hero.png`. Shoot the challenger at the same size and framing,
   show both to two judges with the labels in opposite order, and keep it only if both pick it.
