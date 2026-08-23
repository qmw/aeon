# AEON art bible — LOCKED. Do not re-roll these decisions.

Five passes have oscillated instead of converging because each agent re-invents the look.
These are now fixed constraints. Improve execution, never re-decide direction.

## Reference frames
- `shots/converged.png` — the READABILITY reference. Hex grid legible, palette calm, silhouettes clear.
- `shots/final-hero.png` — the MATERIAL DENSITY reference (and a warning: its detail is screen-space noise).
The target is converged.png's readability WITH honest world-space material. Neither frame alone.

## Non-negotiables (an automatic reject if broken)
1. **The hex grid must be legible.** This is a turn-based strategy game; a player must see the tiles they
   click. One stroke per edge, world-space width, analytic AA, conforms to slope, fades over open water.
2. **World-space material, mipped.** Detail lives in the world, not on the monitor. Per-pixel confetti is
   a fail even when it scores well on detail energy.
3. **Everything is grounded.** Contact shadow or AO decal under every unit, prop, building and tree.
4. **Legible silhouettes.** A player names the unit type and the city size from shape alone at gameplay zoom.
5. **No UI clipping or overlap**, ever.

## Palette (golden hour, warm key / cool-but-not-navy shadow)
- grass      base #5C7A3A, value range 0.28-0.52, sat 0.30-0.42
- plains     base #97914E, value 0.35-0.58, sat 0.28-0.38
- desert     base #C6A874, value 0.45-0.70, sat 0.24-0.34
- tundra     base #8C9282, value 0.35-0.55, sat 0.12-0.22
- snow       base #DCE6EA, value 0.70-0.92, sat 0.04-0.12
- forest     base #3C5E31, value 0.20-0.40, sat 0.32-0.44
- jungle     base #35592B, value 0.18-0.38, sat 0.36-0.48
- hills      base #6E7440, value 0.30-0.50, sat 0.26-0.36
- mountain   base #7A7368, value 0.32-0.62, sat 0.08-0.18
- coast      #2E7C93, ocean #123A63, river #2C6E86
Sun key ~5600K warm. Shadow hue must stay within 10 degrees of the lit hue of the same surface —
never navy shadows on tan sand. Ambient is albedo-weighted with ground bounce.

## Measured targets — `node tools/metrics.mjs <shot> x,y,w,h:name ...` must print gate PASS
- land regions: HF_rms 12-22 AND MID/HF 0.9-1.3 (both bounds; HF alone is gameable with noise)
- water regions (name them `water*`): HF_rms 7-15, MID/HF 0.9-1.3
- near/far HF ramp >= 1.6 — detail must shrink with distance
- land saturation 0.28-0.46, crushedPct <= 0.30, blownPct <= 0.05
- aerial perspective: farther is LIGHTER, COOLER and LESS saturated. Never darker.

## Already good — keep, do not rewrite
Coastline foam and shore read; city keeps and their banners; the HUD (top bar, unit panel, notification
rail, minimap, end turn); rivers existing on the map; the notification/turn flow; the 260-turn sim.
