# Resume notes — paused 2026-08-23

## State
- Whole-frame referee score: **50/100** (baseline before phase 7 was 34).
- `node tools/sim.mjs` passes: 260 turns, 26 cities, 32 techs, 11 wars, culture victory.
- Latest frame: `shots/pause-state.png` (also `shots/p7-state.png` at full 1600x900).
- Phase 8 was stopped mid bug-sweep. The tree renders clean and the sim passes; the partial
  bug-sweep edits to terrain.js / water.js / grid.js are committed as WIP.

## To restart
1. Start the dev server (nothing else needs it running):
   `cd /home/piotr/looping_opus_5_test && setsid nohup npx vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &`
2. Confirm it renders: `node tools/shot.mjs shots/check.png 1600 900`  (~2 min, waits for TAA convergence)
3. Resume phase 8 where it stopped:
   Workflow({scriptPath: "/home/piotr/.claude/projects/-home-piotr-looping-opus-5-test/84ea964d-d52e-4edb-b9b4-0c17044a7b69/workflows/scripts/aeon-phase8-bugs-then-craft-wf_7c4f128b-3ca.js", resumeFromRunId: "wf_7c4f128b-3ca"})

## What was learned (do not re-litigate)
- Parallel agents on shared visual files oscillate: phases 1-6 went 61 -> 34 -> 22. Sequential
  single-owner passes with a git revert gate produced the only monotonic gain (34 -> 50).
- One-sided metric targets get gamed: "HF_rms >= 12" was met by spraying per-pixel noise.
  `tools/metrics.mjs` now bounds detail on both sides and requires a near/far detail ramp.
- The screenshot harness must wait on rendered-frame count, not wall-clock: at ~1 fps under
  software WebGL a timed wait captures an unconverged TAA frame, which produced dozens of
  bogus "near-field is blurry" critiques.
- `?nopost=1` renders the raw scene — the fastest way to tell a shading bug from a post bug.

## Outstanding, in referee priority order
1. Hex grid invisible on the mountain massif (art-bible non-negotiable #1).
2. Material detail does not shrink with distance (near/far HF ramp ~1.3-1.4, needs >= 1.6);
   mid-sand reads as per-pixel confetti (HF ~24 vs 22 ceiling).
3. Units are clay — nothing nameable from silhouette, no contact AO. Lowest-scoring subsystem in every pass.
4. Violet/mauve slab over the coastal shallows; rivers still read as flat cyan ribbons.
5. Mountain mesh: blown white voids, holes, self-intersecting shells, terraced banding instead of strata.
