# Resume notes — paused 2026-08-26

## State
- Live: https://qmw.github.io/aeon/ · Repo: https://github.com/qmw/aeon (public, MIT)
- `main` is at `98b4a9c` "grounding: promoted to champion" — metric gate **PASS** (ramp 1.61),
  260-turn sim passes, `npx vite build` succeeds. This is the best verified state.
- Champion frame: `shots/champion.png`. Release frames: `shots/final-*.png`.
- Unfinished cliff-grid work is parked on branch **`wip/cliffgrid`**. It broke the gate
  (near/far ramp 0.93, mid-sand HF 24.6), so it was kept off `main` because `main` auto-deploys
  to the public link. Resume it there or discard it.

## How the loop works now (do not regress these)
1. **Tournament gate, not scores.** Every change is compared head to head against the reigning
   champion frame by two judges seeing the pair in opposite order; accepted only if BOTH pick it.
   Absolute 0-100 scoring had ~3 points of noise and twice reverted the best work in the project
   (both had to be recovered by hand from git).
2. **Sequential, single-owner.** Parallel agents on shared visual files oscillated for six phases
   (61 -> 34 -> 22). One agent at a time, with git revert on a loss, is what produced monotonic gains.
3. **Two-sided metric gate.** `tools/metrics.mjs` bounds detail energy on both sides and requires a
   near/far ramp >= 1.6. A one-sided target ("HF >= 12") was met by spraying per-pixel noise.
4. **Frame-count screenshots.** `tools/shot.mjs` waits for 60 rendered frames, not wall-clock; at
   ~1 fps under software WebGL a timed wait captures an unconverged TAA frame.
5. **Diagnose before briefing.** `?nopost=1` separates shading bugs from post bugs, `?cam=` shoots
   close-ups, `tools/probe3.mjs` dumps shadow flags. The units breakthrough came from replacing the
   figure builder with a named-joint skeleton after twelve patch attempts each traded one defect
   for another; the shadow "bug" was not a missing flag, since all 42 unit meshes already had it set.

## Score history
- Whole-frame referee: 34 -> 50 -> 57 -> 60, then the tournament replaced scoring.
- Tournament wins shipped: rock chroma, water surface, massif, sand, figure rewrite, sand ripple,
  vegetation, unit grounding + scale. Losses reverted: units x12 (before the rewrite), shallows, terrain x6.
- Blind jury vs remembered Civ VI frames: 41/44/48 (phase 4) -> 39/47 (phase 14). Civ VI still picked
  every time. The gap narrowed; it did not close.

## Outstanding, in jury/judge priority order
1. Hex grid smears across cliff faces instead of stepping down tile edges (see `wip/cliffgrid`).
   Art-bible non-negotiable #1 and the single most expensive recurring defect.
2. Rivers and lakes are opaque cutouts with hard aliased banks, no depth gradient, no reflection.
3. Ocean whitecaps are uniform in scale to the horizon — no distance falloff, no sun glint.
4. Far field collapses: distant mountains smear, distant trees flatten; reads as broken LOD rather
   than aerial perspective.
5. Unit pose variety — a stack of the same type still reads as clones.

## To restart
1. `setsid nohup npx vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &`
2. Verify: `node tools/shot.mjs shots/check.png 1600 900` (~2 min) and `node tools/metrics.mjs shots/check.png 200,120,200,140:far-rock 700,430,200,140:mid-sand 620,700,240,160:near-sand 1200,300,240,160:water`
3. Resume phase 15 (grounding already won; cliff grid and rivers remain):
   Workflow({scriptPath: "/home/piotr/.claude/projects/-home-piotr-looping-opus-5-test/84ea964d-d52e-4edb-b9b4-0c17044a7b69/workflows/scripts/aeon-phase15-grounding-wf_af5ddfcb-6ba.js", resumeFromRunId: "wf_af5ddfcb-6ba"})
