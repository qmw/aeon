// AEON — the camera rig and the pointer. This is the file that decides the game is a game.
//
// The rig is a Civ orbit: a focus point that slides along the ground, a yaw, and one zoom scalar
// that drives BOTH distance and pitch. Zoomed in you get a 3/4 board read at ~53 degrees with ~15
// hexes across the frame; pulling out swings toward 74 degrees and a map. Nothing here is a
// free-flying camera — pitch is derived, roll does not exist, and the focus is clamped inside the
// map in continuous axial space, so the board can never leave the frame.
//
// Framing on load is derived, never hard-coded. With a Game present it weights the player's
// capital against the unit it just picked up and parks that point on a chosen pixel, so the
// opening screenshot IS the opening turn; without one it scores the map for somewhere worth
// playing (river, coast a few hexes off, a range in front of the camera). Yaw is fixed near -z
// because that is where sky.js's sun lands: light travels toward +x/+z, so at this heading shadows
// rake across the frame to the lower right instead of hiding behind their casters.
//
// Picking is a ray march against terrain.heightAt, not a raycast — the terrain is one 300k-tri
// merged mesh and BVH-less raycasting it per mousemove is not affordable in software GL. 30-odd
// height samples plus a bisection lands sub-centimetre, and water tiles resolve on the sea plane.
import * as THREE from 'three';
import { axialToWorld, worldToAxial, DIRS, hexDistance, spiral } from '../world/hex.js';
import { Grid } from '../render/grid.js';

const SQRT3 = Math.sqrt(3), WATER_Y = 0.10;
// A board camera, not a landscape one. 30 degrees of FOV is narrow enough that a hex at the top
// of the frame and a hex at the bottom are within ~15% of the same size — which is the only way
// tile counting works — and it costs nothing but distance to make up the coverage. The pitch band
// starts at 50 degrees so the opening frame is a 3/4 board read with no horizon in it at all;
// there is no pitch that both shows sky and keeps hexes uniform, and the board wins.
const FOV = 30;
const D_MIN = 14, D_MAX = 150;                                   // camera distance range
const P_MIN = 50 * Math.PI / 180, P_MAX = 74 * Math.PI / 180;    // pitch above the ground plane
const ZOOM0 = 0.262;                                             // opening: ~16 hexes across, 54 deg
const YAW0 = -0.05;                                              // heading that cross-lights the frame
const EDGE = 26;                                                 // edge-scroll band, px
// where the subject lands on screen, in NDC. Right of centre and a little high: the unit panel
// owns the bottom-left, the notification stack the top-right, and this keeps the subject clear
// of both while the board still fills the frame.
const AIM_X = -0.11, AIM_Y = -0.03;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export class Input {
  constructor(camera, renderer, map, terrain, opts = {}) {
    this.camera = camera; this.dom = renderer.domElement; this.map = map; this.terrain = terrain;
    camera.fov = FOV; camera.updateProjectionMatrix();   // the rig owns framing, lens included
    this.game = opts.game || null;

    this.focus = new THREE.Vector3();
    this.yaw = YAW0; this.zoom = ZOOM0; this.zoomT = ZOOM0; this.tilt = 0;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.px = -1; this.py = -1; this.ex = 0; this.ey = 0; this.pointerIn = false; this.pickDirty = false; this.moved = false;
    this.drag = null;
    this._v = new THREE.Vector3(); this._g = new THREE.Vector3(); this._g2 = new THREE.Vector3();
    this._cb = null;

    this.grid = new Grid(map, terrain);
    opts.scene?.add(this.grid.group);

    this._bind();
    if (this.game) {
      // open on the unit with the most movement left: the biggest, most readable move plate, and
      // the one the player would actually reach for first
      const mine = this.game.state.units.filter(u => u.civ === 0);
      const u = mine.sort((a, b) => b.mp - a.mp)[0];
      if (u) this._select(this.map.tiles[u.i]);
    } else this._demo();
    this._frame();
    this._place();
  }

  onPick(cb) { this._cb = cb; }

  // ------------------------------------------------------------------ framing
  // Score every land tile for "a screenshot taken here reads as a turn in progress" and take the
  // best: fresh water on or beside the tile, a coast within a few hexes, and a mountain mass in
  // FRONT of the camera (the dot with the view forward is what puts the range in the upper third).
  _frame() {
    const { map } = this, n = map.tiles.length;
    const fx = Math.sin(YAW0), fz = -Math.cos(YAW0);
    // A game in progress already knows where the interesting tile is: the player's capital, which
    // turn.js sited on the best yield it could find and surrounded with the opening kit. Frame
    // that and the load screenshot *is* the opening turn.
    const cap = this.game?.state.cities.find(c => c.civ === 0);
    const su = this.game?.state.selectedUnit;
    if (cap || su) {
      // split the difference between the capital and the unit under orders: both in frame, the
      // move plate near the middle, and the HUD's four corners left clear
      const a = cap ? axialToWorld(map.tiles[cap.i].q, map.tiles[cap.i].r) : axialToWorld(su.q, su.r);
      const b = su ? axialToWorld(su.q, su.r) : a;
      this.home = map.tiles[(cap ?? su).i];
      // weighted toward the city: it is the hero silhouette, and the unit only has to stay in frame
      return this._compose(a.x * 0.62 + b.x * 0.38, a.z * 0.62 + b.z * 0.38);
    }
    const dw = new Int16Array(n).fill(999), q = [];
    for (const t of map.tiles) if (t.height === 0) { dw[t.i] = 0; q.push(t); }
    for (let h = 0; h < q.length; h++) {
      const t = q[h];
      for (const d of DIRS) { const u = map.get(t.q + d.q, t.r + d.r); if (u && dw[u.i] > dw[t.i] + 1) { dw[u.i] = dw[t.i] + 1; q.push(u); } }
    }
    const peaks = map.tiles.filter(t => t.height > 0 && (t.biome === 'mountain' || t.biome === 'snow'));
    let best = null, bestS = -1e9;
    for (const t of map.tiles) {
      if (t.height === 0) continue;
      if (t.q < 6 || t.r < 6 || t.q > map.w - 7 || t.r > map.h - 7) continue;
      if (t.biome === 'mountain') continue;
      let s = 0;
      if (t.river) s += 4;
      for (const d of DIRS) { const u = map.get(t.q + d.q, t.r + d.r); if (u?.river) s += 1.1; }
      s += 6 * Math.exp(-Math.pow((dw[t.i] - 2.5) / 2.2, 2));      // near the coast, not on it
      const p = axialToWorld(t.q, t.r);
      for (const m of peaks) {
        const pm = axialToWorld(m.q, m.r), ax = pm.x - p.x, az = pm.z - p.z, L = Math.hypot(ax, az);
        if (L < 3 || L > 34) continue;
        s += m.height * (ax / L * fx + az / L * fz) * 0.9 * Math.exp(-L / 17);
      }
      if (s > bestS) { bestS = s; best = t; }
    }
    this.home = best;
    const bp = axialToWorld(best.q, best.r);
    this._compose(bp.x, bp.z);
  }

  // Park a world point on a chosen pixel. Solved by iteration rather than trigonometry because the
  // focus carries its own ground height: moving it changes the plane the next solve reads, so a
  // closed form is wrong by most of a hex on sloped ground. Three passes converge to sub-pixel.
  _compose(ax, az) {
    this.focus.set(ax, this._ground(ax, az), az);
    for (let k = 0; k < 4; k++) {
      this._place();
      if (!this._planeHit(AIM_X, AIM_Y, this._g2)) break;
      this.focus.x += ax - this._g2.x; this.focus.z += az - this._g2.z;
      this._clampFocus();
      this.focus.y = this._ground(this.focus.x, this.focus.z);
    }
    this._place();
  }

  // ------------------------------------------------------------------ rig
  // distance is geometric in the zoom scalar (every notch is the same ratio), pitch is a soft
  // curve on top of it: a shallow 3/4 at gameplay range, swinging top-down as the board opens up
  get dist() { return D_MIN * Math.pow(D_MAX / D_MIN, this.zoom); }
  get pitch() { return clamp(P_MIN + (P_MAX - P_MIN) * Math.pow(this.zoom, 1.3) + this.tilt, 0.18, 1.47); }

  _place() {
    const D = this.dist, p = this.pitch, f = this.focus;
    const dx = Math.sin(this.yaw), dz = -Math.cos(this.yaw), h = Math.cos(p) * D;
    this.camera.position.set(f.x - dx * h, f.y + Math.sin(p) * D, f.z - dz * h);
    this.camera.lookAt(f);
  }

  _ground(x, z) {
    const { q, r } = worldToAxial(x, z), t = this.map.get(q, r);
    if (!t) return WATER_Y;
    return t.height === 0 ? WATER_Y : (this.terrain?.heightAt(x, z) ?? t.height);
  }

  // continuous axial clamp — the map is a parallelogram, so a world AABB would let the camera
  // slide off two of its corners
  _clampFocus() {
    const f = this.focus;
    let q = (2 / 3) * f.x, r = -(1 / 3) * f.x + (SQRT3 / 3) * f.z;
    q = clamp(q, 2, this.map.w - 3); r = clamp(r, 2, this.map.h - 3);
    f.x = 1.5 * q; f.z = SQRT3 * (r + q / 2);
  }

  // ------------------------------------------------------------------ picking
  // march the eye ray down the height field, then bisect the crossing
  ray(cx, cy, out) {
    const cam = this.camera, o = cam.position;
    const d = this._v.set(cx, cy, 0.5).unproject(cam).sub(o).normalize();
    if (d.y > -0.02) return null;
    // enter the terrain slab from above: nothing on the map is taller than ~26
    let t = Math.max(0, (26 - o.y) / d.y), tEnd = (-3 - o.y) / d.y;
    let prev = t;
    for (let i = 0; i < 240 && t < tEnd; i++) {
      t = Math.min(tEnd, t + Math.max(0.30, t * 0.035));
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const cur = y - this._ground(x, z);
      if (cur <= 0) {
        let a = prev, b = t;
        for (let k = 0; k < 14; k++) {
          const m = (a + b) * 0.5;
          if (o.y + d.y * m - this._ground(o.x + d.x * m, o.z + d.z * m) > 0) a = m; else b = m;
        }
        return out.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      prev = t;
    }
    return null;
  }

  _ndc(e) {
    const r = this.dom.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }
  tileAt(cx, cy) {
    if (!this.ray(cx, cy, this._g)) return null;
    const { q, r } = worldToAxial(this._g.x, this._g.z);
    return this.map.get(q, r);
  }

  // ------------------------------------------------------------------ events
  _bind() {
    const dom = this.dom;
    const on = (el, ev, fn, o) => el.addEventListener(ev, fn, o);
    on(dom, 'contextmenu', e => e.preventDefault());
    on(dom, 'pointerdown', e => {
      dom.setPointerCapture?.(e.pointerId);
      this.pointerIn = true;
      const [x, y] = this._ndc(e);
      // grab the point on the FOCUS PLANE, not the terrain hit: the drag below tracks the same
      // plane, and mixing the two makes the world jump on the first pixel of movement
      this.drag = { btn: e.button, moved: 0, gx: 0, gz: 0, ok: false };
      if (e.button === 0 && this._planeHit(x, y, this._g)) { this.drag.gx = this._g.x; this.drag.gz = this._g.z; this.drag.ok = true; }
      this.vel.set(0, 0, 0);
    });
    on(dom, 'pointermove', e => {
      const [x, y] = this._ndc(e);
      this.px = x; this.py = y; this.pointerIn = true; this.pickDirty = true;
      this.ex = e.clientX; this.ey = e.clientY; this.moved = true;
      const g = this.drag;
      if (!g) return;
      g.moved += Math.abs(e.movementX ?? 0) + Math.abs(e.movementY ?? 0);
      if (g.btn === 0) {
        // grab the world: keep the ground point that was under the cursor under the cursor
        if (g.ok && g.moved > 3 && this._planeHit(x, y, this._g2)) {
          const dx = g.gx - this._g2.x, dz = g.gz - this._g2.z;
          this.focus.x += dx; this.focus.z += dz; this._clampFocus();
          const fl = this.dist;   // fling, capped so a fast flick cannot launch the board
          this.vel.set(clamp(dx * 9, -fl, fl), 0, clamp(dz * 9, -fl, fl));
        }
      } else {
        this.yaw -= (e.movementX ?? 0) * 0.0055;
        this.tilt = clamp(this.tilt - (e.movementY ?? 0) * 0.0032, -0.30, 0.34);
      }
    });
    const up = e => {
      const g = this.drag; this.drag = null;
      if (!g) return;
      if (g.btn === 0 && g.moved < 5) { const t = this.tileAt(...this._ndc(e)); this._select(t); }
    };
    on(dom, 'pointerup', up);
    on(dom, 'pointercancel', () => { this.drag = null; });
    on(dom, 'pointerleave', () => { this.pointerIn = false; this.grid.setHover(null); });
    on(dom, 'wheel', e => {
      e.preventDefault();
      const dz = clamp(e.deltaY * (e.deltaMode ? 0.04 : 0.0013), -0.14, 0.14);
      const before = this.zoomT;
      this.zoomT = clamp(this.zoomT + dz, 0, 1);
      // zooming in walks the focus toward whatever the cursor is over
      if (this.zoomT < before && this.ray(...this._ndc(e), this._g)) {
        this.focus.x += (this._g.x - this.focus.x) * 0.34;
        this.focus.z += (this._g.z - this.focus.z) * 0.34;
        this._clampFocus();
      }
    }, { passive: false });
    on(window, 'keydown', e => {
      if (typing(e.target)) return;       // the HUD owns the keyboard while a field has focus
      this.keys.add(e.code);
      if (e.code === 'Space') { e.preventDefault(); this.game?.endTurn?.(); }
      if (e.code === 'Escape') this._select(null);
      if (e.code === 'Home') this._frame();
    });
    on(window, 'keyup', e => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
  }

  // cheap ray/plane hit at the focus height — used while dragging, where a march would let the
  // grabbed point drift as the ground under it changes height
  _planeHit(cx, cy, out) {
    const cam = this.camera, o = cam.position;
    const d = this._v.set(cx, cy, 0.5).unproject(cam).sub(o).normalize();
    if (d.y > -0.02) return null;
    const t = (this.focus.y - o.y) / d.y;
    return out.set(o.x + d.x * t, this.focus.y, o.z + d.z * t);
  }

  _select(t) {
    this.grid.setSelected(t);
    this.game?.selectTile?.(t?.q, t?.r);
    if (!this.game) this._demoSel(t);
    this._cb?.(t, 'select');
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    const k = this.keys, D = this.dist;
    let fwd = 0, side = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) side += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1;
    if (k.has('KeyQ')) this.yaw -= dt * 0.9;
    if (k.has('KeyE')) this.yaw += dt * 0.9;
    if (k.has('KeyZ')) this.zoomT = clamp(this.zoomT - dt * 0.45, 0, 1);
    if (k.has('KeyX')) this.zoomT = clamp(this.zoomT + dt * 0.45, 0, 1);

    // edge scroll, but only once the pointer has actually moved in this session
    if (this.moved && this.pointerIn && !this.drag) {
      const w = this.dom.clientWidth, h = this.dom.clientHeight;
      if (this.ex < EDGE) side -= 1; else if (this.ex > w - EDGE) side += 1;
      if (this.ey < EDGE) fwd += 1; else if (this.ey > h - EDGE) fwd -= 1;
    }

    // pan in the camera's own basis: forward is the heading flattened onto the ground, right is
    // that turned 90 degrees. Speed scales with distance so a keypress always moves the board the
    // same fraction of the screen, zoomed in or out.
    const dx = Math.sin(this.yaw), dz = -Math.cos(this.yaw);   // forward
    const rx = -dz, rz = dx;                                   // right
    const L = Math.hypot(fwd, side), sp = L ? 0.62 * D / L : 0;
    const tvx = (dx * fwd + rx * side) * sp, tvz = (dz * fwd + rz * side) * sp;
    // one exponential does acceleration and momentum both: the target is zero when keys are up
    const m = 1 - Math.exp(-9 * dt);
    this.vel.x += (tvx - this.vel.x) * m;
    this.vel.z += (tvz - this.vel.z) * m;
    if (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 1e-3) {
      this.focus.x += this.vel.x * dt; this.focus.z += this.vel.z * dt; this._clampFocus();
    }

    this.zoom += (this.zoomT - this.zoom) * (1 - Math.exp(-8 * dt));
    const gy = this._ground(this.focus.x, this.focus.z);
    this.focus.y += (gy - this.focus.y) * (1 - Math.exp(-5 * dt));
    this._place();

    if (this.pickDirty && !this.drag) {
      this.pickDirty = false;
      const t = this.tileAt(this.px, this.py);
      if (t !== this.grid._hover) { this.grid.setHover(t); this.hoverI = t ? t.i : null; this._cb?.(t, 'hover'); }
    }
    this._sync();
    this.grid.update(dt, D);
  }

  // Mirror the live game onto the overlay. Everything the player sees is derived, never stored
  // twice: the ring is state.selected, the plate is a Dijkstra over Game.enterCost bounded by the
  // unit's remaining movement, the path is Game.findPath to whatever the cursor is over, and the
  // dashed rings are each city's owned border. Rebuilt only when the key changes, so a still
  // frame costs one string compare.
  _sync() {
    const g = this.game; if (!g) return;
    const s = g.state, u = s.selectedUnit;
    const key = `${s.turn}|${u ? u.id + ':' + u.mp + ':' + u.i : '-'}|${s.selected?.tile.i ?? -1}|${s.cities.length}`;
    if (key !== this._key) {
      this._key = key;
      this.grid.setSelected(s.selected?.tile ?? null);
      const work = [];
      for (const c of s.cities) if (c.civ === 0) for (const i of c.border) work.push(g.tiles[i]);
      this.grid.setWorkable(work);
      this._reachSet = u && u.civ === 0 && u.mp > 0 ? this._reach(u) : null;
      this.grid.setRange(this._reachSet ? this._reachSet.map(i => g.tiles[i]) : []);
      this._pkey = null;
    }
    // the path preview is the only thing that tracks the cursor, so it gets its own key
    const pk = `${key}|${this.hoverI ?? -1}`;
    if (pk === this._pkey) return;
    this._pkey = pk;
    if (!this._reachSet) { this.grid.setPath([]); return; }
    let goal = this.hoverI, p = null;
    // a hovered tile is an order even when it is several turns out — that is what the badge counts
    if (goal != null && goal !== u.i) p = g.findPath(u, goal);
    if (!p || !p.length) { goal = this._preview(u, this._reachSet); p = goal != null && goal !== u.i ? g.findPath(u, goal) : null; }
    if (!p || !p.length) { this.grid.setPath([]); return; }
    this.grid.setPath([g.tiles[u.i], ...p.map(i => g.tiles[i])], this._turns(u, p));
  }

  // turns to walk a path: this turn's remaining movement first, then whole turns at full speed
  _turns(u, p) {
    const g = this.game, NB = g.NB;
    let cur = u.i, cost = 0;
    for (const j of p) {
      let d = 0; while (d < 6 && NB[cur * 6 + d] !== j) d++;
      const c = d < 6 ? g.enterCost(u, cur, j, d) : 1;
      cost += isFinite(c) ? c : 1; cur = j;
    }
    if (cost <= u.mp) return 1;
    return 1 + Math.ceil((cost - u.mp) / Math.max(1, u.maxMp));
  }

  // every tile the unit can still enter this turn. Movement points are small (2-4), so the
  // frontier never exceeds a couple of dozen entries and a sorted array beats a real heap.
  _reach(u) {
    const g = this.game, NB = g.NB, best = new Map([[u.i, 0]]), fr = [u.i];
    while (fr.length) {
      fr.sort((a, b) => best.get(a) - best.get(b));
      const cur = fr.shift(), d = best.get(cur);
      for (let k = 0; k < 6; k++) {
        const j = NB[cur * 6 + k]; if (j < 0) continue;
        const c = g.enterCost(u, cur, j, k);
        const nd = d + c;
        if (!isFinite(nd) || nd > u.mp) continue;
        if (best.has(j) && best.get(j) <= nd) continue;
        best.set(j, nd); fr.push(j);
      }
    }
    return [...best.keys()];
  }

  // with no cursor on the board there is still an order worth showing: the furthest tile the unit
  // could walk to, which is what the player is about to click anyway
  _preview(u, reach) {
    const g = this.game, a = g.tiles[u.i];
    let bi = null, bd = 0;
    for (const i of reach) {
      const t = g.tiles[i], k = hexDistance(t.q, t.r, a.q, a.r);
      if (k > bd) { bd = k; bi = i; }
    }
    return bi;
  }

  // ------------------------------------------------------------------ standalone demo state
  // Until game/turn.js exists there is no unit to select, and an empty board does not read as a
  // turn. This puts a plausible one on the table: a settled site with its workable ring, a picked
  // unit with its move plate, and a queued path. It is fully replaced by _sync the moment a real
  // Game shows up.
  _demo() {
    if (this.game) return;
    const city = this.home;
    this.grid.setWorkable(spiral(city.q, city.r, 2)
      .map(a => this.map.get(a.q, a.r))
      .filter(t => t && t.biome !== 'mountain' && !(t.q === city.q && t.r === city.r)));
    // pick a unit a few hexes off the site, on land, downstream-ish of the camera
    let sel = null;
    for (const a of spiral(city.q, city.r, 4)) {
      const t = this.map.get(a.q, a.r);
      if (t && t.height > 0 && t.biome !== 'mountain' && hexDistance(a.q, a.r, city.q, city.r) === 3) { sel = t; break; }
    }
    this._select(sel || city);
  }

  _demoSel(t) {
    if (!t) { this.grid.setRange([]); this.grid.setPath([]); return; }
    // 3-move flood over passable land, the way a real move range is built
    const seen = new Map([[t.i, 0]]), out = [t], fr = [t];
    while (fr.length) {
      const c = fr.shift(), d = seen.get(c.i);
      if (d >= 3) continue;
      for (const dd of DIRS) {
        const u = this.map.get(c.q + dd.q, c.r + dd.r);
        if (!u || seen.has(u.i) || u.height === 0 || u.biome === 'mountain') continue;
        const cost = (u.biome === 'forest' || u.biome === 'jungle' || u.biome === 'hills') ? 2 : 1;
        if (d + cost > 3) continue;
        seen.set(u.i, d + cost); out.push(u); fr.push(u);
      }
    }
    this.grid.setRange(out);
    // and a queued path: walk the frontier tile furthest from the unit
    let far = t, fd = -1;
    for (const u of out) { const k = hexDistance(u.q, u.r, t.q, t.r); if (k > fd) { fd = k; far = u; } }
    const path = [t]; let cur = t;
    while (cur !== far && path.length < 8) {
      let nx = null, nb = 99;
      for (const dd of DIRS) {
        const u = this.map.get(cur.q + dd.q, cur.r + dd.r);
        if (!u || !seen.has(u.i)) continue;
        const k = hexDistance(u.q, u.r, far.q, far.r);
        if (k < nb) { nb = k; nx = u; }
      }
      if (!nx) break; path.push(nx); cur = nx;
    }
    this.grid.setPath(path, 1);
  }

  dispose() { this.grid.dispose(); }
}
