// AEON — integrator. Owns the renderer, the light rig, the boot order and the frame loop.
// Every visual and rules decision belongs to a module; this file only wires them together in
// the order the contract specifies, boots a real match, and hands the frame to post.js.
//
// Boot order is not arbitrary and each step depends on the one above it:
//   terrain -> water/sky -> units + fx -> Game (played forward) -> attach the sinks -> HUD -> Input.
// units.js and fx.js are the only two things the rules layer can see: Game pushes the whole board
// through opts.units / opts.fx in pushRender(). Input builds the hex overlay and owns the camera,
// so it comes last and has the final say on framing.
import * as THREE from 'three';
import { generateMap } from './world/mapgen.js';
import { axialToWorld, hexDistance } from './world/hex.js';

const canvas = document.getElementById('c');
// antialias:false on purpose — post.js renders the scene into its own HDR target, so the
// default framebuffer's MSAA would cost a full multisample resolve and never be sampled.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// Pixel ratio capped at 1. This frame is fill-bound, not draw-call-bound: the scene HDR target,
// the bloom pyramid and the grade pass's 16 depth taps all scale with its square, so 1.5 on a
// retina panel costs 2.25x for an image bloom and FXAA have already softened past the point where
// it shows. See docs/CONTRACT.md, Performance.
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // fallback only; sky/post switch this off
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
// PCF, not PCFSoft: r185 deprecated PCFSoftShadowMap and silently downgrades it to this anyway,
// printing a warning into every console it loads in. sky.js sizes and biases the map.
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);         // sky.js replaces this with the dome
// FOV/position here are a fallback: input.js is the camera rig and overrides both. near/far stay
// tight because post.js reconstructs view position from the depth texture and a 0.5..1200 range
// throws away the precision its AO and contact shadows need.
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 2, 800);

export const map = generateMap({ w: 64, h: 44, seed: 20260821 });

// How many turns the opening is played out before the player takes the seat. A 4X screenshot of
// turn 1 is one settler on an empty continent; this is a match in progress — five towns, borders
// drawn, an army in the field, two thirds of the map still under cloud — which is what the frame
// has to read as. The turns are genuinely simulated, not staged: same Game, same AI, same fog.
// 32 is where this seed has both the towns and units standing outside their walls; nothing in the
// wiring depends on the number, and any value from ~20 up gives a playable board.
const OPENING_TURNS = 32;

// Fallback focus: the height-weighted centroid of the peaks, used for the light rig and for the
// camera only if input.js fails to load.
const focus = new THREE.Vector3();
{
  let wsum = 0;
  for (const t of map.tiles) {
    if (t.height < 3.4) continue;
    const w = t.height * t.height, p = axialToWorld(t.q, t.r);
    focus.x += p.x * w; focus.z += p.z * w; wsum += w;
  }
  focus.divideScalar(wsum || 1);
}
camera.position.set(focus.x + 10, focus.y + 26, focus.z + 34);
camera.lookAt(focus);

// ---------------------------------------------------------------------- light rig
// Created here because sky.js drives it (colour, intensity, and a per-frame fitted shadow
// frustum) and terrain.js reads it for its shadow bias. Everything below is a fallback for
// the case where sky.js fails to import.
const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
sun.position.set(-70, 40, -25); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 360;
const sc = sun.shadow.camera; sc.left = sc.bottom = -80; sc.right = sc.top = 80; sc.updateProjectionMatrix();
const hemi = new THREE.HemisphereLight(0x9ec9ff, 0x2a2318, 1.0);
sun.target.position.copy(focus); sun.target.updateMatrixWorld();
scene.add(sun, sun.target, hemi);

// Every module now exists, so these are static imports: a bundler cannot see through
// import(variable), and the @vite-ignore dynamic version silently shipped a production build
// with none of the render modules in it. Kept in one place so the wiring below is unchanged.
import * as mTerrain from './render/terrain.js';
import * as mWater from './render/water.js';
import * as mSky from './render/sky.js';
import * as mPost from './render/post.js';
import * as mUnits from './render/units.js';
import * as mFx from './render/fx.js';
import * as mHud from './ui/hud.js';
import * as mGame from './game/turn.js';
import * as mAi from './game/ai.js';
import * as mInput from './game/input.js';

let terrain = null;
if (mTerrain?.Terrain) { terrain = new mTerrain.Terrain(map, { renderer, scene, camera }); scene.add(terrain.group); }
else {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false); geo.rotateY(Math.PI / 6);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), map.tiles.length);
  mesh.castShadow = mesh.receiveShadow = true;
  const COLORS = { ocean: 0x123a63, coast: 0x1d5c8f, beach: 0xd9c79a, grass: 0x4f8f3a, plains: 0x9aa14e, desert: 0xd9c184, tundra: 0x9aa79b, snow: 0xe8f0f4, forest: 0x2f6b32, jungle: 0x27632a, hills: 0x6b7a3c, mountain: 0x8b8b8b };
  const m4 = new THREE.Matrix4(), col = new THREE.Color(), s = new THREE.Vector3();
  map.tiles.forEach((t, i) => {
    const p = axialToWorld(t.q, t.r); const hgt = Math.max(0.4, t.height);
    m4.makeTranslation(p.x, hgt / 2, p.z); m4.scale(s.set(0.98, hgt, 0.98));
    mesh.setMatrixAt(i, m4); mesh.setColorAt(i, col.setHex(COLORS[t.biome] ?? 0xff00ff));
  });
  scene.add(mesh);
}

const water = mWater?.Water ? new mWater.Water(map, { renderer, scene, camera }) : null; if (water) scene.add(water.group);
// sky before post: post.render reads sky.sunDir / hazeColor / sunColor every frame, and
// sky's constructor is what turns the renderer's own tonemap off.
const sky = mSky?.Sky ? new mSky.Sky(scene, renderer, { sun, hemi, camera, map }) : null;
const units = mUnits?.Units ? new mUnits.Units(map, { renderer, scene, camera }) : null; if (units) scene.add(units.group);
const fx = mFx?.FX ? new mFx.FX(map, { renderer, scene, camera, terrain }) : null; if (fx) scene.add(fx.group);

// ------------------------------------------------------------------------- the match
// Built with no render sinks, played forward, and only then connected — see the note above the
// pushRender() call below for why the sinks arrive late.
const game = mGame?.Game ? new mGame.Game(map) : null;
// units.js plants a staged warband and three invented cities on its first update so it has
// something to show with no gameplay module behind it. On top of a real match that is a lie —
// a second Aurelia, a pop-12 rival two hexes from the capital — so it goes.
if (game && units) units._demo = () => {};
if (game) {
  // civ 0 is the player's seat, so nothing normally moves it. Hand it to the same aiTurn the
  // opponents use for the opening only: it explores, settles and builds exactly as they do, and
  // the seat is free again the moment the loop ends.
  for (let k = 0; k < OPENING_TURNS; k++) { mAi?.aiTurn?.(game, game.civs[0]); game.endTurn(); }
}

// The opening ends with one order actually given. A board where every soldier is standing inside
// its own walls is a board with no turn in it — and the HUD shows the city panel for a unit on a
// city tile, so the frame loses the movement plate too. So march somebody out, through exactly the
// two clicks input.js sends: select the unit, then click the ground. Nothing here is staged state;
// it is the player's first move of the turn they have just been handed.
let opener = null;
if (game) {
  const R = game.state.rules, cap = game.cities.find(c => c.civ === 0 && c.capital) ?? game.cities.find(c => c.civ === 0);
  const troops = game.units
    .filter(u => u.civ === 0 && !u.dead && u.mp > 0 && !R.UNITS[u.type].civilian)
    .sort((a, b) => hexDistance(a.q, a.r, cap.q, cap.r) - hexDistance(b.q, b.r, cap.q, cap.r));
  const steps = [];
  for (const u of troops) for (let d = 0; d < 6; d++) {
    const j = game.NB[u.i * 6 + d], t = j >= 0 && map.tiles[j];
    if (!t || t.height === 0 || game.unitAt[j] >= 0 || game.cityAt[j] >= 0) continue;
    if (game.civs[0].vis[j] !== 2) continue;
    const c = game.enterCost(u, u.i, j, d);
    if (!isFinite(c) || c >= u.mp) continue;                 // strictly less: the step has to LEAVE movement
    // Score what the frame gets: movement still on the clock (the plate the player reads), the
    // capital in the same shot, and a step toward the camera (+z) so the figure stands in front
    // of the roofline instead of behind it. Two candidate tiles that would have read better —
    // open sand two hexes out, and the plain due north of the walls — are unreachable and
    // unusable respectively: the first costs the whole move, the second parks the figure under
    // Aurelia's floating banner, which is drawn in the HUD layer and cuts it in half.
    steps.push([(u.mp - c) * 2 - hexDistance(t.q, t.r, cap.q, cap.r) * 0.6
                + Math.sign(axialToWorld(t.q, t.r).z - axialToWorld(u.q, u.r).z) * 0.25, u, t]);
  }
  for (const [, u, dest] of steps.sort((a, b) => b[0] - a[0])) {
    game.selectTile(u.q, u.r); game.selectTile(dest.q, dest.r);
    if (game.state.selectedUnit === u && u.i === dest.i) { opener = u; break; }
  }
}

// Only now are the render sinks connected. pushRender() is the whole bridge to the renderer, and
// running it once at the end pushes the board as it stands — every spawn, death and this last
// order already resolved — instead of replaying all of it through a renderer that has not had its
// first frame yet (units.js queues add() until then, and drops the moves that follow).
if (game) { game.opts.units = units; game.opts.fx = fx; game.pushRender(); }

const hud = mHud?.HUD ? new mHud.HUD(game?.state ?? { map }, { game, camera, map }) : null; hud?.mount?.();
// Input owns the camera rig, the picking ray and the hex overlay (it builds render/grid.js and
// adds it to the scene itself), so it is constructed last and gets the scene to put it in.
const input = mInput?.Input ? new mInput.Input(camera, renderer, map, terrain, { game, hud, units, fx, scene }) : null;
const post = mPost?.Post ? new mPost.Post(renderer, scene, camera, { sky }) : null;

// ------------------------------------------------------------------- shot direction
// Three framings of ONE board — same seed, same 32 opening turns, same order given. `?shot=`
// picks one; no query is the hero frame, because the frame the game loads on is the frame it is
// judged on. The numbers are a zoom notch on input.js's rig plus the ground point the rig orbits:
//   hero  — 3/4 gameplay. The soldier under orders and his move plate centre-frame, Aurelia's
//           walls below him, Calyx up the river and Solmere on the far shore, the range in the
//           top-left haze, open sea top-right. This is the diagonal the whole composition rides.
//           0.300/62.3, not the 0.225/64.3 it shipped at: at that notch the pitch/FOV pair puts
//           the top of frame on ground only 24 units ahead of the camera, which is inside the
//           mountain wall — the range was in shot with every summit cropped off, so it read as
//           a brown cliff at the frame edge instead of as distance. One notch out and 2 units
//           of focus north puts the peaks at y~150-300 with haze over them, and it is also what
//           lifts Solmere clear of the End Turn panel (screen x 1161 against the panel's 1292).
//   wide  — the settled world: five towns, their borders, the mountain wall and the cloud edge
//           where the map stops being explored.
//   close — the capital at portrait range: curtain wall, farm belt, banner, garrison.
const SHOTS = { hero: [0.300, 59.8, 62.3], wide: [0.400, 59.0, 68.0], close: [0.072, 62.1, 66.4] };

// input.js opens on whichever unit holds the most movement, which at turn 32 is a scout eight
// hexes deep in the fog — it drags the frame off the capital and hands the panel a unit with
// nothing around it. Pick the order the player would actually give: the soldier that just marched
// out of the walls, so the frame carries the city, its borders, the selection ring and a live
// movement plate in one read.
if (game && input) {
  const cap = game.cities.find(c => c.civ === 0 && c.capital) ?? game.cities.find(c => c.civ === 0);
  const R = game.state.rules;
  const rank = u => hexDistance(u.q, u.r, cap.q, cap.r)
    + (R.UNITS[u.type].civilian ? 6 : 0)          // a settler's panel has no combat line to read
    + (game.cityAt[u.i] >= 0 ? 8 : 0);            // inside the city the HUD shows the city instead
  const pick = opener ?? game.units.filter(u => u.civ === 0 && !u.dead && u.mp > 0).sort((a, b) => rank(a) - rank(b))[0];
  if (pick) input._select(map.tiles[pick.i]);

  const [z, fx, fz] = SHOTS[new URLSearchParams(location.search).get('shot')] ?? SHOTS.hero;
  input.zoom = input.zoomT = z;
  // Set the orbit point directly rather than through _frame(): the framing here is directed, not
  // solved, and _frame()'s capital/unit blend cannot put a mountain range in the top-left corner.
  // focus.y has to be the ground under it or the rig pitches into the hillside.
  input.focus.set(fx, input._ground(fx, fz), fz);
  input._place();
}

// water.js pulls the grade's haze/fog uniforms off these globals so the sea fades into the exact
// colour post fades the land into; units.js reads window.terrain and window.sky the same way.
Object.assign(window, { THREE, scene, camera, renderer, map, terrain, water, sky, units, fx, game, hud, input, post });

// hud.js's zoom rail fires this (its `input.zoom` is a scalar on the rig, not a method).
addEventListener('aeon:zoom', e => { if (input) input.zoomT = Math.max(0, Math.min(1, input.zoomT - e.detail * 0.10)); });

const sunDir = new THREE.Vector3();
// aeon-debug-flags: ?nopost=1 renders the raw scene, ?time=0.35 forces a sun angle.
// Debug switches for the screenshot harness — a broken frame is much faster to bisect with them.
const Q = new URLSearchParams(location.search);
if (Q.has('time')) sky?.setTimeOfDay(+Q.get('time'));
// aeon-cam-flag: ?cam=x,y,z,tx,ty,tz parks the camera anywhere and holds it there.
// Units are ~40px tall at gameplay zoom, which is too small to iterate on from a screenshot;
// this lets an author shoot a close-up of the thing they are actually editing.
if (Q.has('cam')) {
  const n = Q.get('cam').split(',').map(Number);
  if (n.length === 6 && n.every(Number.isFinite)) {
    camera.position.set(n[0], n[1], n[2]);
    camera.lookAt(n[3], n[4], n[5]);
    camera.updateMatrixWorld();
    if (input) { input.enabled = false; input.update = () => {}; }
  }
}
const usePost = post && !Q.has('nopost');
// post.js takes ownership of the tonemap and switches the renderer's off; without post there is
// no tonemap at all, which made raw debug shots read far darker than the pipeline they diagnose.
if (!usePost) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0; }

let last = performance.now(), acc = 0, frames = 0;
renderer.setAnimationLoop(() => {
  // FIXED TIMESTEP, not a wall-clock one. Every module animates on dt — waving flags, the water
  // normal scroll, cloud drift — and post.js resolves an exponential TAA history over the last
  // ~10 frames. On the target GPU that history spans 10/60 s and nothing in it moves far. On a
  // software rasteriser at 1 fps a wall-clock dt spans half a second of animation instead, and
  // the accumulation turns every banner into a translucent smear and every wave crest into a
  // streak — the "semi-transparent banner" and "smeared ghost streak" the critics kept finding
  // were the harness, not the shaders. Clamping to a 60 Hz step makes a slow frame advance the
  // world exactly as far as a fast one, so the captured image is the one the GPU would draw.
  const now = performance.now(), real = (now - last) / 1000, dt = Math.min(1 / 60, real); last = now;
  // The counter measures REAL elapsed time, not the clamped simulation dt. Dividing frames by the
  // clamped sum is what made this number read a healthy 20 on a box that was drawing one frame a
  // second: dt saturates at 0.05, so frames/acc can never come out below 1/0.05. Publish after a
  // full second so a frame that takes most of one still lands inside the window.
  acc += real; frames++; window.__frameCount = (window.__frameCount || 0) + 1;
  if (acc >= 1) { window.__fps = Math.round(frames / acc); window.__mspf = Math.round(1000 * acc / frames); acc = 0; frames = 0; }
  sky?.update(dt);
  terrain?.update?.(dt, camera);
  // one sun vector for everyone: sky's if it loaded, otherwise the light's own position
  water?.update?.(dt, camera, sky?.sunDir ?? sunDir.copy(sun.position).normalize());
  units?.update?.(dt); fx?.update?.(dt); input?.update?.(dt); game?.update?.(dt); hud?.update?.(game?.state);
  if (usePost) post.render(dt); else renderer.render(scene, camera);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false); post?.setSize?.(innerWidth, innerHeight);
});
window.__ready = true;
