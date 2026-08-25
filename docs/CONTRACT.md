# AEON — module contract (single source of truth)

Stack: Three.js r185 + Vite. Dev server already running on http://localhost:5173 (do not start another).
Screenshot: `node tools/shot.mjs shots/<name>.png 1600 900 4000` → prints JSON `{bytes, blank, fps, errors}`.
No external asset downloads. All textures/materials are generated procedurally in code (canvas2d / noise / shaders).

## File ownership (never edit a file you do not own)
- `src/main.js` — integrator only.
- `src/world/hex.js`, `src/core/rng.js` — shared, stable. Read, don't change.
- `src/world/mapgen.js` — worldgen agent
- `src/render/terrain.js` — terrain agent
- `src/render/sky.js`, `src/render/post.js` — sky/lighting/post agent
- `src/render/water.js` — water agent
- `src/render/units.js` — units/cities agent
- `src/render/grid.js` — camera/input agent (built and owned by `game/input.js`)
- `src/render/fx.js` — vfx/fog-of-war agent (unclaimed; the fog-of-war layers were written by the integrator)
- `src/ui/hud.js`, `src/ui/hud.css` — UI agent
- `src/game/rules.js`, `src/game/turn.js`, `src/game/ai.js` — gameplay agent
- `src/game/input.js` — camera/input agent

## Interfaces
```js
// world/mapgen.js
generateMap({w,h,seed}) -> { w, h, seed, seaLevel, tiles[], get(q,r), inBounds(q,r) }
// tile: { q, r, i, elev 0..1, height (world y, 0 for water), biome, temp, moist,
//         river (0..63 edge bitmask), riverFlow, resource|null, feature|null, continent }
// biome ∈ ocean|coast|beach|grass|plains|desert|tundra|snow|forest|jungle|hills|mountain

// render/terrain.js
new Terrain(map) -> { group: THREE.Object3D, update(dt, camera), heightAt(x,z), dispose() }

// render/water.js
new Water(map) -> { group, update(dt, camera, sunDir) }

// render/sky.js
new Sky(scene, renderer) -> { update(dt), sunDir: THREE.Vector3, setTimeOfDay(t01) }
// render/post.js
new Post(renderer, scene, camera) -> { render(dt), setSize(w,h) }  // owns the render call when present

// render/units.js
new Units(map, {camera}) -> { group, add(spec), remove(id), moveUnit(id, path), update(dt) }
//   spec: { id, kind:'unit'|'city', type, unit, civ, team, color, q, r, name, hp, pop, ... }
//   Units.update() plants a staged demo warband on its first frame when nothing has been added;
//   main.js disables that (`units._demo = () => {}`) whenever a real Game is running.
// render/fx.js
new FX(map, {terrain}) -> { group, update(dt), setVisibility(Uint8Array /* 0 hidden,1 fogged,2 visible */) }
//   Two sheets over one hex lattice: a ground dim over explored-but-fogged tiles, a cloud deck
//   ~2.4 above the ground over unexplored ones. Needs `terrain` for its welded corner heights.
// render/grid.js  (constructed BY input.js, which adds grid.group to the scene itself)
new Grid(map, terrain) -> { group, setHover(t), setSelected(t), setRange(tiles), setWorkable(tiles),
                            setPath(tiles, turns), update(dt, camDist) }
// ui/hud.js
new HUD(state, {game, camera, map}) -> { mount(), update(state) }   // DOM overlay, no Three.js
//   Reads game.state directly when a game is passed. Buttons: endTurn -> game.endTurn(),
//   action bar -> `aeon:action` CustomEvent (turn.js listens), zoom rail -> `aeon:zoom` (main.js).
// game/turn.js
new Game(map, {units, fx}) -> { state, endTurn(), selectTile(q,r), findPath(u,goal),
                                enterCost(u,i,j,d), NB, tiles, pushRender() }
//   opts.units / opts.fx are the ONLY renderer bridge, driven by pushRender(). They may be
//   attached after construction (main.js plays the opening turns before connecting them).
// game/input.js
new Input(camera, renderer, map, terrain, {game, scene}) -> { update(dt), onPick(cb), zoom, zoomT }
//   Owns the camera rig, the picking ray and render/grid.js. Framing: _frame() + _place().
```

## Boot order (src/main.js)
terrain -> water -> sky -> units -> fx -> Game (+ opening turns) -> attach units/fx -> HUD -> Input -> Post.
The match is played forward `OPENING_TURNS` before the sinks are attached, so the loaded view is a
turn in progress rather than turn 1; `aiTurn` drives civ 0 for those turns only.

## Performance (measured, 1600x900, swiftshader)
`window.__fps` used to be `frames / sum(min(dt, 0.05))`, which cannot report below 20 no matter how
slow the page is — that is where "15-25 fps is normal" came from. It now measures real elapsed time
and also publishes `window.__mspf`. The truth on this box after phase 3: **~1.76 s per frame**
(0.57 fps), up from ~1.0-1.3 s in phase 2. Attribution, each measured on a fresh page by hiding one
group and reading `__mspf`:

| what | ms |
|---|---|
| terrain.group | ~760 |
| water + units + fx + grid | ~480 |
| post chain (scene RT, bloom pyramid, grade, TAA, present) | ~330 |
| shadow pass (2048², fitted to ~32 units, 1.58 cm/texel) | ~220 |
| empty scene: sky dome + post + present | ~95 |

Only ~530 ms of that is fill (quartering the viewport to 800x450 buys 530 ms and no more). The rest
is geometry: **2.09 M triangles per main pass, 3.28 M with the shadow pass**, because every scatter
layer is one map-wide InstancedMesh with no per-instance culling — `terrain-broadleaf-a` alone is
320 k tris, `terrain-scree-0` 256 k, `terrain-contact-static` 233 k, `terrain-scrub` 189 k, and the
gameplay camera can see about 25 of the map's 2816 tiles. Culling instances to the view (and to the
shadow frustum) is the one change with an order of magnitude in it; nothing in main.js or post.js
moves this number.

## Quality bar (what the critic scores)
Reference target: Civilization VI/VII in-game screenshots. Judged on: silhouette readability,
material variety, believable lighting + shadow contact, atmospheric depth (aerial perspective/fog),
color grading, edge quality (no aliasing/z-fighting/seams), coherent art direction, UI typography and layout.
Placeholder-looking flat-shaded blocks, uniform matte color, missing shadows, or muddy contrast = automatic fail.

## Screenshot harness (updated)
`node tools/shot.mjs shots/<name>.png 1600 900` now WAITS for `window.__frameCount >= 60` (override with
`SHOT_FRAMES=N`), because TAA needs history and this box renders ~1 fps under software WebGL.
A screenshot therefore takes ~2 minutes. Do not shorten it — a wall-clock wait captures an unconverged,
ghosted frame and every "near-field is blurry" critique traces back to that.
main.js reads `?shot=hero|wide|close` off the URL and parks input.js's rig on one of three directed
framings (no query = hero); pass the URL as shot.mjs's 5th argument, e.g.
`node tools/shot.mjs shots/x.png 1600 900 3500 "http://localhost:5173/?shot=wide"`.
The frame loop runs a FIXED 1/60 timestep, not wall-clock dt: at 1 fps a wall-clock dt walks half a
second of animation between the frames post.js's TAA is blending, which is what turned banners into
translucent smears and wave crests into streaks in every phase-3 capture.
`window.__fps` is honest wall-clock fps (software rasteriser; a real GPU is orders of magnitude faster).
Keep scene triangles under ~1.5M and the post chain lean, but do NOT sacrifice image quality for
swiftshader fps — the target platform is a real GPU.

## Debug flags (src/main.js)
- `?nopost=1` — render the raw scene with post disabled. Fastest way to tell a shading bug from a post bug.
- `?time=0.35` — force the sun angle (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset).
- `?cam=x,y,z,tx,ty,tz` — park the camera at a position looking at a target and freeze input.
  Units are ~40px tall at gameplay zoom; use this to shoot a close-up of what you are editing, e.g.
  `node tools/shot.mjs shots/closeup.png 900 600 1000 "http://localhost:5173/?cam=62,8,86,60,2,76"`
  Always check the gameplay-zoom frame too — a unit that reads at 3 metres still has to read at 40px.
