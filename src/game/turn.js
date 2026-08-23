// AEON — the game itself. Owns every piece of mutable match state: civs, cities, units,
// tile ownership, per-civ fog, research and the turn pump. Renderer-agnostic and DOM-free so
// tools/sim.mjs can run it headlessly; the only outside world it touches is the two optional
// sinks main.js hands it (opts.units for figures, opts.fx for the fog overlay).
//
// Coordinate rule: everything internal addresses tiles by their flat index `t.i`. q/r only
// appear on the public API and in what gets handed to the renderer.
import { DIRS, hexDistance, spiral } from '../world/hex.js';
import { mulberry32 } from '../core/rng.js';
import { aiTurn } from './ai.js';
import * as R from './rules.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Game {
  constructor(map, opts = {}) {
    this.map = map; this.opts = opts;
    const tiles = this.tiles = map.tiles, n = this.n = tiles.length;
    this.rng = mulberry32((map.seed * 2654435761) >>> 0);

    // Flat neighbour table: the A* inner loop and every adjacency query read this, never map.get.
    this.NB = new Int32Array(n * 6).fill(-1);
    for (const t of tiles) for (let d = 0; d < 6; d++) {
      const nt = map.get(t.q + DIRS[d].q, t.r + DIRS[d].r);
      if (nt) this.NB[t.i * 6 + d] = nt.i;
    }

    this.owner = new Int32Array(n).fill(-1);    // tile -> civ index
    this.cityAt = new Int32Array(n).fill(-1);   // tile -> city id
    this.unitAt = new Int32Array(n).fill(-1);   // tile -> unit id (one unit per tile, see move())
    this.workedBy = new Int32Array(n).fill(-1); // tile -> city id currently working it

    // A* scratch, allocated once. `stamp` avoids clearing 2816 slots per search.
    this.gs = new Float64Array(n); this.cf = new Int32Array(n);
    this.stamp = new Int32Array(n); this.mark = 0;
    // lazy-deletion A*: a node can be re-pushed on a better g, so the heap outgrows n.
    this.hq = new Int32Array(n * 4); this.hf = new Float64Array(n * 4); this.hn = 0;

    this.units = []; this.cities = [];
    this.byUnit = new Map(); this.byCity = new Map();
    this.nextUnit = 1; this.nextCity = 1;
    this.rendered = new Map();                  // render id -> last {q,r} pushed
    // Field fortifications, tile index -> the civ whose engineers dug them. Ownership matters:
    // earthworks are a hole in the ground, not a deed, so they only help the side that built
    // them and any enemy who walks over them razes them (see place()).
    this.forts = new Map();

    this.civs = R.CIVS.map((c, i) => ({
      i, name: c.name, adj: c.adj, color: c.color, human: i === 0,
      gold: 40, science: 0, culture: 0, era: 0, alive: true,
      techs: new Set(), researching: null, progress: 0, faith: 0,
      income: [0, 0, 0, 0, 0],                  // last-turn totals: food surplus, prod, gold, sci, cult
      yields: { food: 0, prod: 0, gold: 0, science: 0, culture: 0 },   // same numbers, keyed, for the HUD
      vis: new Uint8Array(n), founded: 0, atWar: new Set(), truce: new Map(),
    }));
    for (const c of this.civs) this.pickResearch(c);

    this.state = {
      map, turn: 1, year: -4000, era: 0, eraName: R.ERAS[0],
      civs: this.civs, player: this.civs[0], cities: this.cities, units: this.units,
      selected: null, selectedUnit: null, log: [], visibility: this.civs[0].vis,
      // Live research readout for the HUD, mutated in place so no frame allocates.
      research: { id: null, name: '', progress: 0, eta: 0 },
      mode: null,                               // 'move' | 'attack': a HUD button waiting for a tile
      rules: R, winner: null, victory: null,
    };
    // pair key -> turn of the last blow between those two civs; drives the peace check.
    this.lastFight = new Map();

    this.setupStarts();
    for (const c of this.civs) this.recomputeVis(c);
    this.publishResearch();
    this.pushRender();

    // The HUD's action bar fires `aeon:action` with a verb in event.detail (ui/hud.js). Listening
    // here rather than waiting for a listener in the UI or input layer means the buttons work
    // whichever of those files is wired: this is the file that owns the verbs. Guarded because
    // tools/sim.mjs runs in node, where there is no global addEventListener unless it installs one.
    if (typeof addEventListener === 'function') addEventListener('aeon:action', e => this.action(e.detail));
  }

  // ------------------------------------------------------------------ helpers
  tile(i) { return this.tiles[i]; }
  at(q, r) { return this.map.get(q, r); }
  unitOn(i) { const id = this.unitAt[i]; return id < 0 ? null : this.byUnit.get(id); }
  cityOn(i) { const id = this.cityAt[i]; return id < 0 ? null : this.byCity.get(id); }
  // `i` is the tile the entry is about, when it is about one: the HUD can jump to it, and it is
  // what makes the fog rule below checkable without matching strings.
  // Two engineers digging in on the same turn is two events and one line of news. Collapsing a
  // repeat of the same message on the same turn keeps the notification stack from shipping a
  // literal duplicate ('Aeonian engineers raise earthworks.' twice, both T30) into the frame.
  log(msg, i) { const l = this.state.log; if (l[0]?.msg === msg && l[0].turn === this.state.turn) return; l.unshift({ turn: this.state.turn, msg, i }); if (l.length > 40) l.pop(); }
  // The log is the player's newspaper, not an omniscient feed. Anything that happens on foreign
  // ground is only news if the player was part of it or could see where it happened — otherwise
  // turn one reports every rival capital by name and the fog might as well not exist.
  logAt(i, msg, ...civs) { if (civs.includes(0) || this.civs[0].vis[i] === 2) this.log(msg, i); }

  // Yield of a tile as [f,p,g,s,c], written into `out` so the per-turn pass never allocates.
  yieldOf(t, out) {
    const b = R.BIOME_Y[t.biome] || R.Y0;
    for (let k = 0; k < 5; k++) out[k] = b[k];
    const f = t.feature && R.FEATURE_Y[t.feature]; if (f) for (let k = 0; k < 5; k++) out[k] += f[k];
    const res = t.resource && R.RESOURCE_Y[t.resource]; if (res) for (let k = 0; k < 5; k++) out[k] += res[k];
    if (t.river) { out[2] += 1; out[0] += 1; }             // fresh water: trade and irrigation
    if (out[0] < 0) out[0] = 0;
    return out;
  }
  // Single scalar used everywhere a tile has to be compared to another tile.
  tileScore(t) { const y = this.yieldOf(t, SC); return y[0] * 2.2 + y[1] * 1.8 + y[2] * 0.8 + y[3] * 1.2 + y[4] * 0.9; }

  // --------------------------------------------------------------- match setup
  setupStarts() {
    const { tiles } = this;
    // Score every legal city site once: local yield in a 2-ring, plus the classic coastal and
    // fresh-water sweeteners. Then take the four best that are 9+ tiles apart, so no civ opens
    // inside another's second ring and the map has room for a land war.
    const score = new Float64Array(this.n).fill(-1);
    for (const t of tiles) {
      if (R.isWater(t) || R.impassable(t) || t.biome === 'snow') continue;
      let s = 0, coast = 0;
      for (const p of spiral(t.q, t.r, 2)) {
        const nt = this.at(p.q, p.r); if (!nt) { s -= 3; continue; }
        s += this.tileScore(nt) * (hexDistance(t.q, t.r, p.q, p.r) === 1 ? 1.4 : 1);
        if (nt.biome === 'coast') coast = 1;
      }
      score[t.i] = s + coast * 10 + (t.river ? 12 : 0);
    }
    const order = [...tiles].filter(t => score[t.i] > 0).sort((a, b) => score[b.i] - score[a.i]);
    const picks = [];
    for (const t of order) {
      if (picks.length === this.civs.length) break;
      if (picks.some(p => hexDistance(p.q, p.r, t.q, t.r) < 9)) continue;
      picks.push(t);
    }
    // Degenerate map (tiny continent): fall back to any land, spaced as far as it allows.
    for (let d = 8; picks.length < this.civs.length && d > 1; d--)
      for (const t of order) {
        if (picks.length === this.civs.length) break;
        if (!picks.includes(t) && !picks.some(p => hexDistance(p.q, p.r, t.q, t.r) < d)) picks.push(t);
      }

    picks.forEach((t, ci) => {
      const civ = this.civs[ci];
      this.revealHomeland(civ, t);
      this.foundCity(civ, t);
      // Opening kit: a warrior to hold the capital, a scout to find the neighbours, a settler
      // for city two. Placed on the best free ring tile so nothing spawns on a peak.
      for (const [type, want] of [['warrior', 1], ['scout', 1], ['settler', 1]]) {
        for (let k = 0; k < want; k++) {
          const spot = this.freeSpotNear(t.i, civ);
          if (spot >= 0) this.spawnUnit(civ, type, spot);
        }
      }
    });
    this.log('The first cities rise.');
  }

  // A civ starts knowing the six-hex bowl it woke up in and nothing else: level 1 (explored,
  // fogged) terrain, no foreign unit or city until something of ours actually looks. Everything
  // past that ring is genuinely dark, which is what gives scouts, settle-site ranking and the
  // AI's frontier search real work. Symmetric across all four civs.
  revealHomeland(civ, start) {
    for (const p of spiral(start.q, start.r, 6)) { const t = this.at(p.q, p.r); if (t) civ.vis[t.i] = 1; }
  }

  // Nearest free tile of the right element: land for an army, water for a fleet.
  freeSpotNear(i, civ, sea = false) {
    const c = this.tiles[i];
    for (let rad = 0; rad <= 3; rad++) for (const p of spiral(c.q, c.r, rad)) {
      const t = this.at(p.q, p.r);
      if (!t || R.impassable(t) || this.unitAt[t.i] >= 0) continue;
      if (R.isWater(t) !== sea) continue;
      if (hexDistance(c.q, c.r, p.q, p.r) !== rad) continue;
      return t.i;
    }
    return -1;
  }

  // ----------------------------------------------------------------- entities
  // Whoever ends up standing on a tile owns what is dug into it, and an enemy's trench is
  // filled in rather than inherited. Both ways a unit can arrive on a tile route through here.
  takeGround(i, civ) { if (this.forts.has(i) && this.forts.get(i) !== civ) this.forts.delete(i); }

  spawnUnit(civ, type, i) {
    const d = R.UNITS[type];
    const t = this.tiles[i];
    this.takeGround(i, civ.i);
    const u = {
      id: this.nextUnit++, rid: 'u', civ: civ.i, type, name: d.name,
      q: t.q, r: t.r, i, hp: 100, mp: d.mp, maxMp: d.mp, sight: d.sight,
      moved: false, fortified: false, embarked: R.isWater(t) && !d.sea, xp: 0, promo: 0,
      goal: -1, path: null, trail: null, home: null,
    };
    u.rid = 'u' + u.id;
    this.units.push(u); this.byUnit.set(u.id, u); this.unitAt[i] = u.id;
    return u;
  }

  killUnit(u) {
    if (this.unitAt[u.i] === u.id) this.unitAt[u.i] = -1;
    const k = this.units.indexOf(u); if (k >= 0) this.units.splice(k, 1);
    this.byUnit.delete(u.id); u.dead = true;
    if (this.state && this.state.selectedUnit === u) this.state.selectedUnit = null;
  }

  foundCity(civ, t) {
    const list = R.CIVS[civ.i].cities;
    const city = {
      id: this.nextCity++, rid: '', civ: civ.i, name: list[civ.founded % list.length] + (civ.founded >= list.length ? ' II' : ''),
      q: t.q, r: t.r, i: t.i, pop: 1, food: 0, prod: 0, cultureStore: 0,
      buildings: new Set(), queue: [], border: new Set([t.i]), worked: [],
      hp: R.cityMaxHp(1), maxHp: R.cityMaxHp(1), yields: [0, 0, 0, 0, 0], capital: civ.founded === 0,
    };
    city.rid = 'c' + city.id;
    civ.founded++;
    this.cities.push(city); this.byCity.set(city.id, city);
    this.cityAt[t.i] = city.id; this.owner[t.i] = civ.i;
    // A new city owns its first ring outright — otherwise turn one has nothing to work.
    for (const p of spiral(t.q, t.r, 1)) {
      const nt = this.at(p.q, p.r);
      if (nt && this.owner[nt.i] < 0) { this.owner[nt.i] = civ.i; city.border.add(nt.i); }
    }
    this.chooseProduction(city);
    this.logAt(t.i, `${civ.name} founds ${city.name}.`, civ.i);
    return city;
  }

  captureCity(city, civ) {
    const old = this.civs[city.civ];
    city.civ = civ.i; city.pop = Math.max(1, city.pop - 1); city.capital = false;
    city.hp = city.maxHp = R.cityMaxHp(city.pop);
    city.queue.length = 0; city.buildings.delete('walls');
    for (const i of city.border) this.owner[i] = civ.i;
    this.chooseProduction(city);
    this.logAt(city.i, `${civ.name} captures ${city.name} from ${old.name}!`, civ.i, old.i);
    if (!this.cities.some(c => c.civ === old.i)) {
      old.alive = false;
      // A dead civ is nobody's enemy: leaving its wars in the survivors' sets keeps them
      // permanently "at war" with a corpse, which is what a war state must never mean.
      for (const o of old.atWar) this.civs[o].atWar.delete(old.i);
      old.atWar.clear();
      this.log(`${old.name} is destroyed.`);
    }
  }

  // ------------------------------------------------------------- pathfinding
  // Cost of stepping i -> j across direction d. Infinity means "never", which is how mountains,
  // un-embarkable water and enemy-held tiles leave the search space entirely.
  enterCost(u, i, j, d) {
    const t = this.tiles[j];
    if (R.impassable(t)) return Infinity;
    const water = R.isWater(t);
    if (!R.seaOk(R.UNITS[u.type], t, this.civs[u.civ].techs)) return Infinity;
    const occ = this.unitAt[j];
    if (occ >= 0) { const o = this.byUnit.get(occ); if (o.civ !== u.civ) return Infinity; }
    const cid = this.cityAt[j];
    if (cid >= 0 && this.byCity.get(cid).civ !== u.civ) return Infinity;
    let c = R.MOVE_COST[t.biome];
    if (this.tiles[i].river & (1 << d)) c += 1;             // fording costs a turn's worth of grief
    if (!R.UNITS[u.type].sea && water !== u.embarked) c += 1; // embark / disembark
    if (occ >= 0) c += 3;                                    // friendly unit: pass through, don't stop
    return c;
  }

  // What the *planner* is allowed to believe a step costs. enterCost above is ground truth and
  // stays that way — it is what actually executes a step — but routing a march with it lets a civ
  // steer around a mountain range it has never laid eyes on. So: seen tiles cost what they cost,
  // unseen tiles cost a flat guess, and the lie is found out at move time, when moveAlong charges
  // the real enterCost, aborts, and re-plans next turn with the tile now inside somebody's sight.
  planCost(u, i, j, d) {
    return this.civs[u.civ].vis[j] === 0 ? R.UNKNOWN_COST : this.enterCost(u, i, j, d);
  }

  // A* over the hex grid. Returns an array of tile indices (goal last, start excluded) or null.
  findPath(u, goal) {
    if (goal === u.i) return [];
    const { NB, gs, cf, stamp, hq, hf } = this;
    const vis = this.civs[u.civ].vis;
    const m = ++this.mark; this.hn = 0;
    const gt = this.tiles[goal];
    const h = i => { const t = this.tiles[i]; return hexDistance(t.q, t.r, gt.q, gt.r); };
    gs[u.i] = 0; cf[u.i] = -1; stamp[u.i] = m;
    this.hpush(u.i, h(u.i));
    let guard = 0;
    while (this.hn > 0 && guard++ < 60000) {
      const cur = this.hpop();
      if (cur === goal) {
        const out = []; for (let k = goal; k !== u.i; k = cf[k]) out.push(k);
        return out.reverse();
      }
      for (let d = 0; d < 6; d++) {
        const j = NB[cur * 6 + d]; if (j < 0) continue;
        let c = this.planCost(u, cur, j, d);
        // The goal itself may be an enemy-held tile: that is an attack order, not a block. It is
        // only ever that, though — a peak or an un-sailable sea is never a legal destination, and
        // the exception needs eyes on the target, or it is a way to read the fog through A*.
        if (c === Infinity) { if (j !== goal || vis[j] !== 2 || !this.canAttackTile(u, j)) continue; c = 1; }
        const g = gs[cur] + c;
        if (stamp[j] === m && g >= gs[j]) continue;
        stamp[j] = m; gs[j] = g; cf[j] = cur;
        this.hpush(j, g + h(j));
      }
    }
    return null;
  }
  hpush(i, f) {
    const { hq, hf } = this; if (this.hn >= hq.length) return; let k = this.hn++;
    hq[k] = i; hf[k] = f;
    while (k > 0) { const p = (k - 1) >> 1; if (hf[p] <= hf[k]) break; const ti = hq[p], tf = hf[p]; hq[p] = hq[k]; hf[p] = hf[k]; hq[k] = ti; hf[k] = tf; k = p; }
  }
  hpop() {
    const { hq, hf } = this, top = hq[0]; const last = --this.hn;
    hq[0] = hq[last]; hf[0] = hf[last];
    let k = 0;
    for (;;) {
      const l = k * 2 + 1, r = l + 1; let s = k;
      if (l < last && hf[l] < hf[s]) s = l;
      if (r < last && hf[r] < hf[s]) s = r;
      if (s === k) break;
      const ti = hq[s], tf = hf[s]; hq[s] = hq[k]; hf[s] = hf[k]; hq[k] = ti; hf[k] = tf; k = s;
    }
    return top;
  }

  // ---------------------------------------------------------------- movement
  dirTo(i, j) { for (let d = 0; d < 6; d++) if (this.NB[i * 6 + d] === j) return d; return -1; }
  // A tile is in enemy zone of control if any adjacent tile holds a hostile military unit.
  inZoc(u, i) {
    for (let d = 0; d < 6; d++) {
      const j = this.NB[i * 6 + d]; if (j < 0) continue;
      const o = this.unitOn(j);
      if (o && o.civ !== u.civ && !R.UNITS[o.type].civilian) return true;
    }
    return false;
  }

  place(u, j) {
    this.unitAt[u.i] = -1;
    this.takeGround(j, u.civ);
    u.i = j; const t = this.tiles[j];
    u.q = t.q; u.r = t.r; u.embarked = R.isWater(t) && !R.UNITS[u.type].sea;
    this.unitAt[j] = u.id;
    // Sight travels with the unit, mid-turn. Without this a unit could walk into ground its own
    // civ has not looked at and fight what it finds there, which is a peek by another name.
    const v = this.civs[u.civ].vis, rad = u.sight + (t.biome === 'hills' ? 1 : 0);
    for (const p of spiral(t.q, t.r, rad)) { const nt = this.at(p.q, p.r); if (nt) v[nt.i] = 2; }
  }

  // Walk `path` as far as this turn's movement points allow. Returns true if anything happened.
  // The unit stops on contact: a hostile occupant at the next step is attacked instead of entered.
  moveAlong(u, path) {
    if (!path || !path.length) return false;
    let acted = false;
    u.trail = u.trail || [];
    while (path.length && u.mp > 0) {
      const j = path[0], d = this.dirTo(u.i, j);
      if (d < 0) break;
      const occ = this.unitOn(j), city = this.cityOn(j);
      if ((occ && occ.civ !== u.civ) || (city && city.civ !== u.civ)) {
        if (!R.UNITS[u.type].civilian) { this.attack(u, j); acted = true; }
        path.length = 0; break;
      }
      if (occ) break;                                        // friendly traffic jam: wait a turn
      const c = this.enterCost(u, u.i, j, d);
      if (c === Infinity) { path.length = 0; break; }
      const zocBefore = this.inZoc(u, u.i);
      path.shift();
      this.place(u, j);
      u.trail.push({ q: u.q, r: u.r });
      u.mp = Math.max(0, u.mp - c);
      if (zocBefore && this.inZoc(u, j)) u.mp = 0;            // disengaging ends the move
      u.moved = true; u.fortified = false; acted = true;
    }
    u.path = path.length ? path : null;
    if (!u.path) u.goal = -1;
    return acted;
  }

  // Public order: send a unit to a tile, this turn and every turn after until it arrives.
  orderMove(u, q, r) {
    const t = this.at(q, r); if (!t || u.dead) return false;
    u.goal = t.i;
    const path = this.findPath(u, t.i);
    if (!path) { u.goal = -1; return false; }
    return this.moveAlong(u, path);
  }
  // Resume standing orders at the start of a civ's turn.
  resumeOrders(civ) {
    for (const u of this.units) {
      if (u.civ !== civ.i || u.goal < 0 || u.mp <= 0) continue;
      const path = u.path && u.path.length ? u.path : this.findPath(u, u.goal);
      if (!path) { u.goal = -1; u.path = null; continue; }
      this.moveAlong(u, path);
    }
  }

  // ------------------------------------------------------------------ combat
  atkStrength(u, defTile) {
    const d = R.UNITS[u.type];
    let s = (d.rng || d.str) * (1 + 0.1 * u.promo) * (0.5 + 0.5 * u.hp / 100);
    const foe = this.unitOn(defTile);
    if (foe) s *= R.counter(d, R.UNITS[foe.type]);                      // pikes into horses
    if (d.siege && this.cityAt[defTile] >= 0) s *= 1 + R.SIEGE_BONUS;   // engines are for walls
    if (!d.rng) {
      // Flanking: every other friendly unit already touching the defender helps, capped at +30%.
      let flank = 0;
      for (let k = 0; k < 6; k++) {
        const j = this.NB[defTile * 6 + k]; if (j < 0) continue;
        const o = this.unitOn(j);
        if (o && o !== u && o.civ === u.civ && !R.UNITS[o.type].civilian) flank++;
      }
      s *= 1 + Math.min(0.3, flank * 0.1);
      const dir = this.dirTo(u.i, defTile);
      if (dir >= 0 && (this.tiles[u.i].river & (1 << dir))) s *= 0.85;   // attacking across water
    }
    return s;
  }
  defStrength(u, att = null) {
    const t = this.tiles[u.i], d = R.UNITS[u.type];
    let s = d.str * (1 + 0.1 * u.promo) * (0.5 + 0.5 * u.hp / 100);
    if (att) s *= R.counter(d, R.UNITS[att.type]);            // a pike wall receives a charge too
    if (u.embarked && !d.sea) return s * R.EMBARK_DEF;        // caught mid-crossing: no terrain, no dig-in
    s *= 1 + (R.DEFENSE[t.biome] || 0) + (t.feature === 'marsh' ? -0.1 : 0) + (this.forts.get(u.i) === u.civ ? R.FORT_DEF : 0);
    if (u.fortified) s *= 1.25;
    const city = this.cityOn(u.i);
    if (city && city.civ === u.civ) s += this.cityStrength(city) * 0.25;
    return s;
  }
  cityStrength(city) {
    let def = 0;
    for (const b of city.buildings) def += R.BUILDINGS[b].def || 0;
    return 8 + 1.5 * city.pop + def + 4 * this.civs[city.civ].era;
  }

  // Can this unit legally strike that tile at all — element, cargo state and a hostile on it?
  // findPath, moveAlong, attack and the AI all ask this one question, so they can never disagree.
  canAttackTile(u, i) {
    const d = R.UNITS[u.type];
    if (d.civilian) return false;
    if (u.embarked && !d.sea) return false;                  // troops at sea are cargo
    if (d.sea && !d.rng && !R.isWater(this.tiles[i])) return false;   // melee ships cannot storm a beach
    const o = this.unitOn(i), c = this.cityOn(i);
    const foe = o && o.civ !== u.civ ? o.civ : c && c.civ !== u.civ ? c.civ : -1;
    if (foe < 0) return false;
    // A truce is binding, and binding means the shooting stops — not that you may fire the first
    // shot and call it a declaration. Enforced here so the AI, the pathfinder and the player's
    // click all get the same answer.
    const me = this.civs[u.civ];
    return me.atWar.has(foe) || !(me.truce.get(foe) > this.state.turn);
  }

  attack(att, target) {
    const d = R.UNITS[att.type];
    if (d.civilian || att.mp <= 0) return;
    if (!this.canAttackTile(att, target)) return;
    const dist = hexDistance(att.q, att.r, this.tiles[target].q, this.tiles[target].r);
    const ranged = !!d.rng;
    if (dist > (ranged ? d.range : 1)) return;
    const def = this.unitOn(target), city = this.cityOn(target);
    const enemyCiv = def ? def.civ : city ? city.civ : -1;
    if (enemyCiv < 0 || enemyCiv === att.civ) return;
    this.declareWar(this.civs[att.civ], this.civs[enemyCiv]);

    const a = this.atkStrength(att, target);
    const dS = def ? this.defStrength(def, att) : this.cityStrength(city);
    const dmg = R.combatDamage(a, dS, this.rng());
    att.mp = 0; att.moved = true; att.fortified = false; att.xp += 2;

    if (def) {
      def.hp -= dmg;
      if (!ranged) att.hp -= Math.round(R.combatDamage(dS, a, this.rng()) * 0.8);
      def.xp += 1; this.promote(def);
      if (def.hp <= 0) {
        this.logAt(target, `${this.civs[att.civ].adj} ${d.name} destroys a ${this.civs[def.civ].adj} ${def.name}.`, att.civ, def.civ);
        this.killUnit(def);
        // Melee takes the ground it just cleared, if the ground is enterable at all.
        if (!ranged && att.hp > 0 && this.cityAt[target] < 0 && R.seaOk(d, this.tiles[target], this.civs[att.civ].techs)) {
          const dir = this.dirTo(att.i, target);
          if (dir >= 0 && this.enterCost(att, att.i, target, dir) !== Infinity) { this.place(att, target); att.trail = [{ q: att.q, r: att.r }]; }
        }
      }
    } else {
      city.hp -= dmg; city.hurt = this.state.turn;      // a city under fire does not repair itself
      if (!ranged) att.hp -= Math.round(R.combatDamage(dS, a, this.rng()) * 0.6);
      if (city.hp <= 0) {
        if (ranged) city.hp = 1;                             // artillery cannot take a city alone
        else { this.captureCity(city, this.civs[att.civ]); this.place(att, target); att.trail = [{ q: att.q, r: att.r }]; }
      }
    }
    this.promote(att);
    if (att.hp <= 0) { this.logAt(att.i, `${this.civs[att.civ].adj} ${att.name} is lost in the assault.`, att.civ); this.killUnit(att); }
  }
  promote(u) {
    while (u.promo < R.XP_STEPS.length && u.xp >= R.XP_STEPS[u.promo]) u.promo++;
  }

  // ------------------------------------------------------------ war and peace
  pair(a, b) { return a < b ? a * 8 + b : b * 8 + a; }
  declareWar(a, b) {
    if (a.i === b.i) return;
    if (!a.atWar.has(b.i)) this.log(`${a.name} and ${b.name} are at war.`);
    a.atWar.add(b.i); b.atWar.add(a.i);
    this.lastFight.set(this.pair(a.i, b.i), this.state.turn);
  }
  // Wars end. Either the shooting stopped (PEACE_TURNS quiet turns) or one side has no army
  // left to shoot with; both cases bind the pair to a truce so nobody redeclares next turn.
  makePeace(a, b) {
    a.atWar.delete(b.i); b.atWar.delete(a.i);
    const until = this.state.turn + R.TRUCE_TURNS;
    a.truce.set(b.i, until); b.truce.set(a.i, until);
    this.lastFight.delete(this.pair(a.i, b.i));
    this.log(`${a.name} and ${b.name} make peace.`);
  }
  hasArmy(ci) { return this.units.some(u => u.civ === ci && !R.UNITS[u.type].civilian); }
  peaceCheck() {
    for (const a of this.civs) {
      if (!a.alive) continue;
      for (const bi of [...a.atWar]) {
        const b = this.civs[bi];
        if (!b || !b.alive) { a.atWar.delete(bi); b?.atWar.delete(a.i); continue; }
        if (b.i < a.i) continue;                              // handle each pair once
        const quiet = this.state.turn - (this.lastFight.get(this.pair(a.i, b.i)) ?? 0);
        if (quiet >= R.PEACE_TURNS || !this.hasArmy(a.i) || !this.hasArmy(b.i)) this.makePeace(a, b);
      }
    }
  }

  // A city shoots once a turn at the strongest besieger it can see. This is the only defence a
  // city has that does not need a garrison, and it is what makes walls worth building.
  cityStrike(city) {
    const civ = this.civs[city.civ];
    if (city.struck === this.state.turn || !civ.atWar.size) return false;
    let best = null, bs = -1;
    for (const p of spiral(city.q, city.r, 2)) {
      const t = this.at(p.q, p.r); if (!t || civ.vis[t.i] !== 2) continue;
      const u = this.unitOn(t.i);
      if (!u || !civ.atWar.has(u.civ)) continue;
      const s = this.defStrength(u); if (s > bs) { bs = s; best = u; }
    }
    if (!best) return false;
    city.struck = this.state.turn;
    this.lastFight.set(this.pair(city.civ, best.civ), this.state.turn);
    // Capped on purpose: a city that one-shots the siege train every turn means no city ever
    // falls, and a 4X where the map cannot change hands is a screensaver.
    best.hp -= Math.min(22, R.combatDamage(this.cityStrength(city) * 0.5, bs, this.rng()));
    if (best.hp <= 0) { this.logAt(best.i, `${city.name} destroys a ${this.civs[best.civ].adj} ${best.name}.`, city.civ, best.civ); this.killUnit(best); }
    return true;
  }

  // ------------------------------------------------------------ fog of war
  // 0 hidden, 1 explored-but-fogged, 2 visible. Recomputed from scratch every turn from the
  // civ's own units and cities — no civ ever reads another civ's array, which is what keeps the
  // AI honest.  ponytail: radial sight, no line-of-sight blocking; add ridge occlusion if it matters.
  recomputeVis(civ) {
    const v = civ.vis;
    for (let i = 0; i < v.length; i++) if (v[i] === 2) v[i] = 1;
    const light = (q, r, rad) => {
      for (const p of spiral(q, r, rad)) { const t = this.at(p.q, p.r); if (t) v[t.i] = 2; }
    };
    for (const u of this.units) if (u.civ === civ.i) light(u.q, u.r, u.sight + (this.tiles[u.i].biome === 'hills' ? 1 : 0));
    for (const c of this.cities) if (c.civ === civ.i) light(c.q, c.r, 3);
  }
  sees(civ, i) { return civ.vis[i] === 2; }

  // ------------------------------------------------------------- city economy
  // Pick the `pop` best tiles this city owns that no other city already works.
  assignWork(city) {
    for (const i of city.worked) if (this.workedBy[i] === city.id) this.workedBy[i] = -1;
    const cands = [];
    for (const i of city.border) {
      const t = this.tiles[i];
      if (i === city.i || !R.workable(t) || this.workedBy[i] >= 0) continue;
      if (this.owner[i] !== city.civ) continue;
      cands.push(i);
    }
    cands.sort((a, b) => this.tileScore(this.tiles[b]) - this.tileScore(this.tiles[a]));
    city.worked = cands.slice(0, city.pop);
    for (const i of city.worked) this.workedBy[i] = city.id;
  }

  cityYields(city) {
    const y = city.yields; y[0] = y[1] = y[2] = y[3] = y[4] = 0;
    const c = this.yieldOf(this.tiles[city.i], SC);
    // The centre tile is always worth settling on: a guaranteed floor of 2 food / 1 hammer / 1 gold.
    y[0] += Math.max(2, c[0]); y[1] += Math.max(1, c[1]); y[2] += Math.max(1, c[2]); y[3] += c[3]; y[4] += c[4];
    for (const i of city.worked) { const w = this.yieldOf(this.tiles[i], SC); for (let k = 0; k < 5; k++) y[k] += w[k]; }
    for (const b of city.buildings) {
      const def = R.BUILDINGS[b];
      for (let k = 0; k < 5; k++) y[k] += def.y[k];
      if (def.adj) {                                          // district adjacency
        let n = 0;
        for (let d = 0; d < 6; d++) { const j = this.NB[city.i * 6 + d]; if (j >= 0 && def.adj.b.includes(this.tiles[j].biome)) n++; }
        for (let k = 0; k < 5; k++) y[k] += def.adj.y[k] * n;
      }
    }
    y[3] += 1 + city.pop * 0.5;                               // population itself does research
    y[4] += city.capital ? 1 : 0;
    return y;
  }

  canBuild(city, kind, key) {
    const civ = this.civs[city.civ];
    const def = kind === 'unit' ? R.UNITS[key] : R.BUILDINGS[key];
    if (!def) return false;
    if (def.tech && !civ.techs.has(def.tech)) return false;
    if (kind === 'unit' && def.sea && !this.nearWater(city.i)) return false;
    if (kind === 'building') {
      if (city.buildings.has(key)) return false;
      if (def.needs && !city.buildings.has(def.needs)) return false;
      if (def.coastal && !this.nearWater(city.i)) return false;
    }
    return true;
  }
  nearWater(i) {
    for (let d = 0; d < 6; d++) { const j = this.NB[i * 6 + d]; if (j >= 0 && R.isWater(this.tiles[j])) return true; }
    return false;
  }

  // Default build order, used for the player's cities too so an idle queue never wastes hammers.
  chooseProduction(city) {
    const civ = this.civs[city.civ];
    const own = this.cities.filter(c => c.civ === civ.i).length;
    const mil = this.units.filter(u => u.civ === civ.i && !R.UNITS[u.type].civilian).length;
    const settlers = this.units.filter(u => u.civ === civ.i && u.type === 'settler').length;
    if (mil < own + 1) { const best = this.bestUnit(civ, false, null, this.threatMix(civ)); if (best) return void city.queue.push({ kind: 'unit', key: best }); }
    if (own < 6 && settlers < 2 && city.pop >= 2) return void city.queue.push({ kind: 'unit', key: 'settler' });
    // Cheapest useful building first: it is the fastest route to compounding yields.
    const opts = Object.keys(R.BUILDINGS).filter(k => this.canBuild(city, 'building', k));
    if (opts.length) { opts.sort((a, b) => R.BUILDINGS[a].cost - R.BUILDINGS[b].cost); return void city.queue.push({ kind: 'building', key: opts[0] }); }
    // Army capped and every building up: hammers become gold. Without this sink a finished city
    // builds units forever and the map silts up with idle armies nobody can pay for.
    city.queue.push(mil < own + 3 ? { kind: 'unit', key: this.bestUnit(civ) ?? 'warrior' } : WEALTH);
  }
  // Best buildable unit of one element, optionally of one role and optionally measured against
  // the enemy mix this civ has actually seen. A single scalar max is what made five of the twenty
  // units in the table unbuildable — the pikeman unlocks *after* the knight it exists to stop, so
  // it can only ever win a comparison that knows what it is being asked to fight.
  bestUnit(civ, sea = false, role = null, threat = null) {
    let best = null, bs = -1;
    for (const [k, d] of Object.entries(R.UNITS)) {
      if (d.civilian || !!d.sea !== sea || (d.tech && !civ.techs.has(d.tech))) continue;
      if (role && d.role !== role) continue;
      let s = (d.rng || d.str) + d.mp;
      // Weight by what the counter multiplier is actually worth against the observed army.
      if (threat) { let bonus = 0; for (const r in threat) bonus += threat[r] * (R.counter(d, { role: r }) - 1); s *= 1 + bonus; }
      if (s > bs) { bs = s; best = k; }
    }
    return best;
  }
  // Fraction of the enemy units this civ can see (or remembers) that are of each role. The AI's
  // shopping list is built from it, so a knight rush is answered with pikes and not more knights.
  threatMix(civ) {
    const mix = {}; let n = 0;
    for (const u of this.units) {
      if (u.civ === civ.i || civ.vis[u.i] !== 2) continue;    // fog-honest: only what we can see now
      const role = R.UNITS[u.type].role;
      mix[role] = (mix[role] || 0) + 1; n++;
    }
    if (n) for (const r in mix) mix[r] /= n;
    return mix;
  }

  cityTick(city) {
    const civ = this.civs[city.civ];
    this.assignWork(city);
    const y = this.cityYields(city);

    // --- food and growth
    const surplus = y[0] - city.pop * 2;
    city.food += surplus;
    if (city.food < 0) {
      city.food = 0;
      if (city.pop > 1) { city.pop--; this.logAt(city.i, `${city.name} starves back to ${city.pop}.`, city.civ); }
    } else if (city.food >= R.foodToGrow(city.pop)) {
      city.food -= R.foodToGrow(city.pop); city.pop++;
      city.maxHp = R.cityMaxHp(city.pop); city.hp = Math.min(city.maxHp, city.hp + 10);
    }

    // --- production
    city.prod += Math.max(1, y[1]);
    if (!city.queue.length) this.chooseProduction(city);
    // Priorities are always prepended, so the tail is stale by definition: six deep is a plan,
    // twelve deep is a backlog nobody will ever reach.
    if (city.queue.length > 6) city.queue.length = 6;
    const job = city.queue[0];
    // Selling hammers is deliberately a bad trade: half a gold each. A city with nothing left to
    // build used to mint money at par, which is most of how an AI treasury reached five digits.
    if (job && job.kind === 'gold') { civ.gold += city.prod * R.WEALTH_RATE; city.prod = 0; }
    else if (job) {
      const def = job.kind === 'unit' ? R.UNITS[job.key] : R.BUILDINGS[job.key];
      if (!def || !this.canBuild(city, job.kind, job.key)) city.queue.shift();
      else if (city.prod >= def.cost) {
        city.prod -= def.cost; city.queue.shift();
        if (job.kind === 'building') {
          city.buildings.add(job.key);
          if (job.key === 'walls') city.maxHp = city.hp = R.cityMaxHp(city.pop) + 40;
          this.logAt(city.i, `${city.name} completes ${def.name}.`, city.civ);
        } else {
          const spot = this.freeSpotNear(city.i, civ, !!R.UNITS[job.key].sea);
          if (spot >= 0) {
            const u = this.spawnUnit(civ, job.key, spot);
            for (const b of city.buildings) u.xp += R.BUILDINGS[b].xp || 0;
            this.promote(u); u.home = city.id;
          } else city.prod += def.cost;                       // nowhere to stand: hold the hammers
        }
      }
    }

    // --- culture and borders
    city.cultureStore += y[4] + 1;
    const need = R.cultureToExpand(city.border.size);
    if (city.cultureStore >= need) {
      city.cultureStore -= need;
      let best = -1, bs = -Infinity;
      for (const p of spiral(city.q, city.r, 3)) {
        const t = this.at(p.q, p.r);
        if (!t || this.owner[t.i] >= 0 || city.border.has(t.i)) continue;
        const s = this.tileScore(t) - hexDistance(city.q, city.r, t.q, t.r) * 1.5;
        if (s > bs) { bs = s; best = t.i; }
      }
      if (best >= 0) { this.owner[best] = civ.i; city.border.add(best); }
    }

    // --- city repairs itself only in a turn nobody shot at it
    if (city.hp < city.maxHp && city.hurt !== this.state.turn) city.hp = Math.min(city.maxHp, city.hp + 8);

    civ.income[0] += surplus; civ.income[1] += y[1]; civ.income[2] += y[2]; civ.income[3] += y[3]; civ.income[4] += y[4];
    civ.gold += y[2]; civ.science += y[3]; civ.culture += y[4];
    civ.progress += y[3];
  }

  // ---------------------------------------------------------------- research
  pickResearch(civ) {
    const avail = R.TECH_LIST.filter(t => !civ.techs.has(t) && R.TECHS[t].pre.every(p => civ.techs.has(p)));
    if (!avail.length) { civ.researching = null; return; }
    avail.sort((a, b) => R.TECHS[a].cost - R.TECHS[b].cost);
    civ.researching = avail[0];
  }
  // The HUD's research line, mutated in place. Called wherever progress or choice can change.
  publishResearch() {
    const p = this.state.player, r = this.state.research, t = p.researching;
    if (!t) { r.id = null; r.name = 'Future Era'; r.progress = 1; r.eta = 0; return; }
    const cost = R.TECHS[t].cost, rate = Math.max(1, p.income[3]);
    r.id = t; r.name = R.techName(t);
    r.progress = clamp(p.progress / cost, 0, 1);
    r.eta = Math.max(1, Math.ceil((cost - p.progress) / rate));
  }
  researchTick(civ) {
    if (!civ.researching) this.pickResearch(civ);
    const t = civ.researching; if (!t) return;
    if (civ.progress >= R.TECHS[t].cost) {
      civ.progress -= R.TECHS[t].cost;
      civ.techs.add(t);
      civ.era = Math.max(civ.era, R.TECHS[t].era);
      if (civ.human) this.log(`Researched ${R.techName(t)}.`);
      this.pickResearch(civ);
    }
  }

  // ------------------------------------------------------------- world tick
  worldTick() {
    for (const civ of this.civs) civ.income.fill(0);
    for (const city of this.cities) if (this.civs[city.civ].alive) this.cityTick(city);
    for (const civ of this.civs) {
      if (!civ.alive) continue;
      this.researchTick(civ);
      // Faith is the slow half of culture: it buys nothing, it counts toward a culture victory.
      civ.faith += Math.round(civ.income[4] * R.FAITH_RATE);
      // Upkeep: four units ride free, the rest draw wages, and every building charges maintenance.
      // Both halves matter. Wages are what stops runaway AI unit spam; maintenance is what stops a
      // finished empire compounding its treasury to five digits with nothing left to buy.
      const own = this.units.filter(u => u.civ === civ.i);
      let wages = 0, free = R.FREE_UNITS;
      for (const u of own) { if (free > 0) { free--; continue; } wages += R.wage(R.UNITS[u.type]); }
      let bld = 0, towns = 0; for (const c of this.cities) if (c.civ === civ.i) { bld += c.buildings.size; towns++; }
      civ.upkeep = wages + bld * R.BUILDING_UPKEEP;
      civ.income[2] -= civ.upkeep;                            // the HUD's gold line is net, not gross
      civ.gold -= civ.upkeep;
      // Inflation. See rules.goldCeiling: the sinks above are what keep a living empire under it.
      const cap = R.goldCeiling(towns);
      if (civ.gold > cap) civ.gold = cap + (civ.gold - cap) * 0.6;
      const y = civ.yields;
      y.food = civ.income[0]; y.prod = civ.income[1]; y.gold = civ.income[2]; y.science = civ.income[3]; y.culture = civ.income[4];
      if (civ.gold < 0) {
        const victim = own.filter(u => !R.UNITS[u.type].civilian).sort((a, b) => R.UNITS[a.type].cost - R.UNITS[b.type].cost)[0];
        if (victim) { this.killUnit(victim); civ.gold = 5; } else civ.gold = 0;
      }
    }
    // Units: heal, then refresh for the turn that is about to start.
    for (const u of this.units) {
      if (!u.moved && u.hp < 100 && !u.embarked) {          // nobody recovers mid-crossing
        const city = this.cityOn(u.i);
        u.hp = Math.min(100, u.hp + (city && city.civ === u.civ ? 25 : this.owner[u.i] === u.civ ? 15 : 8));
      }
      u.mp = u.maxMp; u.moved = false; u.trail = null;
    }
    this.peaceCheck();
    const p = this.state.player;
    this.state.era = p.era; this.state.eraName = R.ERAS[p.era];
    this.state.year = -4000 + this.state.turn * 40;
    this.publishResearch();
    this.checkVictory();
  }

  // Three ways to win, all read off counters the game already keeps.
  checkVictory() {
    if (this.state.winner) return;
    const alive = this.civs.filter(c => c.alive);
    let win = null, how = '';
    if (alive.length === 1) { win = alive[0]; how = 'Domination'; }
    for (const c of alive) {
      if (win) break;
      if (R.scienceWin(c.techs.size)) { win = c; how = 'Science'; }
      else if (c.culture + c.faith >= R.CULTURE_WIN) { win = c; how = 'Culture'; }
    }
    if (!win) return;
    this.state.winner = win.name; this.state.victory = how;
    this.log(`${win.name} wins a ${how} victory.`);
  }

  // ------------------------------------------------------------------- pump
  endTurn() {
    this.state.mode = null;
    for (let c = 1; c < this.civs.length; c++) if (this.civs[c].alive) aiTurn(this, this.civs[c]);
    this.worldTick();
    this.state.turn++;
    for (const civ of this.civs) if (civ.alive) this.recomputeVis(civ);
    this.resumeOrders(this.civs[0]);
    this.state.visibility = this.civs[0].vis;
    this.pushRender();
    return this.state;
  }

  // ------------------------------------------------- public API for ui/input
  // The one click the input layer sends (input.js _select). It is therefore also where playing
  // the game has to happen: a click with one of my units already selected is an ORDER, not a
  // second selection. Without this the player can end turns and nothing else.
  selectTile(q, r) {
    const t = this.at(q, r);
    if (!t) { this.state.selected = null; this.state.selectedUnit = null; this.state.mode = null; return null; }
    const prev = this.state.selectedUnit;
    // Only a friendly UNIT blocks the order — that click picks the next unit up instead, since
    // nothing may stack. A friendly city is a destination like any other: garrisoning is a move,
    // and `selected` carries the city alongside the unit so the HUD still gets its panel.
    const held = this.unitOn(t.i);
    const ours = held && held.civ === 0;
    let ordered = false;
    if (prev && !prev.dead && prev.civ === 0 && t.i !== prev.i && !ours) ordered = this.commandTo(q, r);

    const unit = this.unitOn(t.i);                            // re-read: the order may have moved it
    const sel = { tile: t, unit, city: this.cityOn(t.i), owner: this.owner[t.i], ordered };
    this.state.selected = sel;
    if (unit && unit.civ === 0) this.state.selectedUnit = unit;
    // Keep the unit you just gave an order to. Losing the selection after every step is what
    // makes a hex game feel broken, and a failed order should not cost you the unit either.
    else if (prev && !prev.dead && prev.civ === 0 && (ordered || !unit)) this.state.selectedUnit = prev;
    else this.state.selectedUnit = null;
    return sel;
  }
  // The city the action bar is talking about: the selected one if the player owns it, else the
  // one the selected unit came out of, else the capital. Never a foreign city.
  activeCity() {
    const sel = this.state.selected?.city;
    if (sel && sel.civ === 0) return sel;
    const u = this.state.selectedUnit, home = u && u.home != null ? this.byCity.get(u.home) : null;
    if (home && home.civ === 0) return home;
    return this.cities.find(c => c.civ === 0 && c.capital) ?? this.cities.find(c => c.civ === 0) ?? null;
  }

  // The single entry point for the HUD action bar and its hotkeys. Verbs that need a target
  // arm state.mode and let the next commandTo() consume it; the rest act immediately.
  // Returns true when something actually happened, so a UI can refuse the click.
  action(kind) {
    const u = this.state.selectedUnit, city = this.activeCity();
    // One click can arrive here more than once: hud.js runs some verbs directly AND dispatches
    // `aeon:action` for all of them, and the input layer may listen for that event too. The first
    // arrival wins and the echoes are dropped, or a Purchase gets charged twice. The signature is
    // verb + target, so two different units fortifying in the same millisecond are not an echo.
    const now = Date.now(), sig = `${kind}:${u ? u.id : 0}:${city ? city.id : 0}`;
    if (sig === this._actSig && now - this._actAt < 60) return false;
    this._actSig = sig; this._actAt = now;
    switch (kind) {
      case 'move': case 'attack': this.state.mode = u && !u.dead ? kind : null; return !!this.state.mode;
      case 'fortify': return this.fortify(u);
      case 'found':   return this.foundHere(u);
      case 'build':   return this.entrench(u);
      case 'produce': return city ? this.cycleProduction(city) : false;
      case 'buy':     return city ? this.buyProduction(city) : false;
      case 'manage':  if (!city) return false; this.assignWork(city); this.pushRender(); return true;
      // No HUD button dispatches this yet, but the AI upgrades every turn: the verb exists so the
      // player is never locked out of something the opponent can do.
      case 'upgrade': { if (!this.upgradeUnit(u)) return false; this.pushRender(); return true; }
      case 'walls':   return city ? this.setProduction(city, 'building', 'walls') : false;
      case 'strike':  { if (!city || !this.cityStrike(city)) return false; this.pushRender(); return true; }
    }
    return false;
  }
  // Turn-driven game: nothing changes between turns. main.js calls this every frame anyway.
  update() {}

  // Dig a field fortification: a whole turn's movement for a permanent +25% defence on the tile.
  entrench(u = this.state.selectedUnit) {
    // Nobody digs a trench at sea: no civilians, no cargo mid-crossing, and no ships.
    if (!u || u.dead || R.UNITS[u.type].civilian || R.UNITS[u.type].sea || u.embarked || u.mp < u.maxMp) return false;
    if (this.forts.get(u.i) === u.civ) return this.fortify(u);   // already dug: just hold it
    this.forts.set(u.i, u.civ); u.mp = 0; u.moved = true; u.fortified = true;
    this.logAt(u.i, `${this.civs[u.civ].adj} engineers raise earthworks.`, u.civ);
    return true;
  }
  // Cycle this city's current item through everything it can legally build. Hammers carry over,
  // exactly as they do in Civ when you switch a queue that has not finished.
  cycleProduction(city) {
    const opts = [];
    for (const k of Object.keys(R.UNITS)) if (this.canBuild(city, 'unit', k)) opts.push({ kind: 'unit', key: k });
    for (const k of Object.keys(R.BUILDINGS)) if (this.canBuild(city, 'building', k)) opts.push({ kind: 'building', key: k });
    opts.push(WEALTH);                                       // ...or sell the hammers for gold
    const cur = city.queue[0];
    const at = cur ? opts.findIndex(o => o.kind === cur.kind && o.key === cur.key) : -1;
    city.queue[0] = opts[(at + 1) % opts.length];
    return true;
  }
  // The one call an input agent needs: click a tile with a unit selected and this does the
  // right thing — walk, attack, or (for a settler on open ground) plant a city.
  commandTo(q, r) {
    const u = this.state.selectedUnit;
    if (!u || u.dead || u.civ !== 0) return false;
    const t = this.at(q, r); if (!t) return false;
    // You may march into ground you have merely explored, never into ground you have never seen.
    // The fog stops at the renderer for a human, but the order path has to enforce it too.
    if (this.civs[0].vis[t.i] === 0) return false;
    const mode = this.state.mode; this.state.mode = null;
    // Armed attack mode refuses anything that is not a legal target, so a mis-click never
    // marches the unit into the open instead of shooting.
    if (mode === 'attack' && !this.canAttackTile(u, t.i)) return false;
    // In reach and hostile? Shoot it. Ranged units never step onto the tile they are firing at,
    // and a melee unit walking into one attacks on arrival (see moveAlong).
    const reach = R.UNITS[u.type].range || 1;
    if (hexDistance(u.q, u.r, q, r) <= reach && this.sees(this.civs[0], t.i) && this.canAttackTile(u, t.i)) {
      this.attack(u, t.i); this.pushRender(); return true;
    }
    const ok = this.orderMove(u, q, r);
    this.pushRender();
    return ok;
  }
  fortify(u = this.state.selectedUnit) {
    if (!u || u.dead || u.embarked) return false;
    u.fortified = true; u.mp = 0; u.goal = -1; u.path = null;
    return true;
  }
  foundHere(u = this.state.selectedUnit) {
    if (!u || u.type !== 'settler') return false;
    const t = this.tiles[u.i];
    if (R.isWater(t) || R.impassable(t)) return false;
    if (this.cities.some(c => hexDistance(c.q, c.r, t.q, t.r) < 4)) return false;
    this.foundCity(this.civs[u.civ], t);
    this.killUnit(u); this.state.selectedUnit = null;
    this.recomputeVis(this.civs[u.civ]); this.pushRender();
    return true;
  }
  // What a purchase would actually buy here. A city that has finished everything parks its queue
  // on WEALTH, and WEALTH has no price — so the treasury of a mature empire had nothing to spend
  // on and compounded forever. Pricing the swap instead is the sink: gold turns back into a build.
  buyJob(city) {
    const head = city.queue[0];
    if (head && head.kind !== 'gold') return head;
    let best = null, bc = Infinity;
    for (const k of Object.keys(R.BUILDINGS))
      if (this.canBuild(city, 'building', k) && R.BUILDINGS[k].cost < bc) { bc = R.BUILDINGS[k].cost; best = { kind: 'building', key: k }; }
    if (best) return best;
    const civ = this.civs[city.civ];
    const k = this.bestUnit(civ, false, null, this.threatMix(civ));
    return k ? { kind: 'unit', key: k } : null;
  }
  // 4 gold per missing hammer, so buying is always worse value than building and only ever worth
  // it under pressure — which is exactly when the AI reaches for it.
  buyCost(city) {
    const job = this.buyJob(city); if (!job) return Infinity;
    const def = job.kind === 'unit' ? R.UNITS[job.key] : R.BUILDINGS[job.key];
    if (!def) return Infinity;
    return Math.max(0, Math.ceil((def.cost - city.prod) * R.BUY_RATE));
  }
  // `by` is the civ picking up the bill and it defaults to the human, because the only caller that
  // ever passes an arbitrary city is the UI. Selecting an enemy city and pressing Purchase used to
  // spend *their* gold on *their* walls; the guard lives here so no caller can route around it.
  buyProduction(city, by = this.state.player) {
    if (!city || !by || by.i !== city.civ) return false;
    const civ = this.civs[city.civ], job = this.buyJob(city), cost = this.buyCost(city);
    if (!job || !Number.isFinite(cost) || civ.gold < cost) return false;
    if (city.queue[0] !== job) city.queue.unshift(job);       // swap off WEALTH before paying
    civ.gold -= cost;
    city.prod = (job.kind === 'unit' ? R.UNITS[job.key] : R.BUILDINGS[job.key]).cost;
    return true;
  }

  // Gold's other sink, and the reason a rich empire is dangerous rather than merely rich: a
  // veteran re-equips instead of going obsolete. HP, XP and promotions all carry across, which is
  // what makes an upgraded army worth more than the same hammers spent on fresh recruits.
  upgradeTo(u) {
    const d = R.UNITS[u.type];
    const best = this.bestUnit(this.civs[u.civ], !!d.sea, d.role);
    return best && best !== u.type && R.UNITS[best].cost > d.cost ? best : null;
  }
  upgradeCost(u) { const to = this.upgradeTo(u); return to ? R.upgradeFee(R.UNITS[u.type], R.UNITS[to]) : Infinity; }
  upgradeUnit(u, by = this.state.player) {
    if (!u || u.dead || !by || by.i !== u.civ) return false;
    const civ = this.civs[u.civ], to = this.upgradeTo(u), cost = this.upgradeCost(u);
    if (!to || civ.gold < cost) return false;
    const d = R.UNITS[to];
    civ.gold -= cost;
    u.type = to; u.name = d.name; u.maxMp = d.mp; u.mp = 0; u.sight = d.sight;   // re-equipping takes the turn
    u.fortified = false;
    return true;
  }

  setProduction(city, kind, key) {
    if (!this.canBuild(city, kind, key)) return false;
    city.queue.unshift({ kind, key }); return true;
  }
  setResearch(civ, tech) {
    const c = typeof civ === 'number' ? this.civs[civ] : civ;
    const def = R.TECHS[tech];
    if (!c || !def || c.techs.has(tech) || !def.pre.every(p => c.techs.has(p))) return false;
    c.researching = tech;
    if (c === this.state.player) this.publishResearch();
    return true;
  }

  // ------------------------------------------------------------ render bridge
  // Diffs live entities against what was last pushed. units.js only ever sees add/moveUnit/
  // remove, all optional-chained, so this file works whether or not that agent has landed yet.
  pushRender() {
    const U = this.opts.units, FX = this.opts.fx;
    const vis = this.civs[0].vis;
    FX?.setVisibility?.(vis); U?.setVisibility?.(vis);
    if (!U) return;
    const seen = new Set();
    // Everything below is filtered through civ 0's own fog. The AI has always been honest about
    // what it can see; the human was not, because every entity was pushed to the renderer
    // unconditionally and the board was readable from turn one.
    for (const c of this.cities) {
      const prev = this.rendered.get(c.rid), mine = c.civ === 0;
      if (!prev && !mine && vis[c.i] !== 2) continue;         // never laid eyes on it: not on our map
      seen.add(c.rid);
      if (prev && !mine && vis[c.i] !== 2) continue;          // remembered, not observed: leave it be
      const spec = { id: c.rid, kind: 'city', type: 'city', civ: c.civ, team: c.civ, color: this.civs[c.civ].color, q: c.q, r: c.r, name: c.name, pop: c.pop, prod: Math.round(c.yields[1]), hp: c.hp, maxHp: c.maxHp, buildings: [...c.buildings], capital: c.capital };
      if (!prev) U.add?.(spec);
      else if (prev.q !== c.q || prev.r !== c.r || prev.pop !== c.pop || prev.civ !== c.civ) { U.remove?.(c.rid); U.add?.(spec); }
      this.rendered.set(c.rid, { i: c.i, q: c.q, r: c.r, pop: c.pop, civ: c.civ });
    }
    for (const u of this.units) {
      const prev = this.rendered.get(u.rid), mine = u.civ === 0;
      if (!mine && vis[u.i] !== 2) {
        // Out of sight. The figure stays standing wherever we last actually saw it — a player's
        // map is allowed to remember — but the moment we are looking at that spot and it is empty,
        // the ghost goes. Either way its real position is never leaked.
        if (prev && vis[prev.i] !== 2) { seen.add(u.rid); prev.hidden = true; }
        continue;
      }
      seen.add(u.rid);
      // `type` is the model to draw (rules.art falls back to a mesh units.js already has);
      // `unit` is the real type, for whoever wants the truth.
      const d = R.UNITS[u.type];
      const spec = { id: u.rid, kind: 'unit', type: d.art ?? u.type, unit: u.type, civ: u.civ, team: u.civ,
        color: this.civs[u.civ].color, q: u.q, r: u.r, name: u.name, hp: u.hp, promo: u.promo, embarked: u.embarked, fortified: u.fortified };
      if (!prev) U.add?.(spec);
      else if (prev.type !== u.type) { U.remove?.(u.rid); U.add?.(spec); }   // re-equipped: new figure
      // A unit that walked back into view teleports rather than replaying a march we never saw.
      else if (prev.q !== u.q || prev.r !== u.r) U.moveUnit?.(u.rid, !prev.hidden && u.trail && u.trail.length ? u.trail : [{ q: u.q, r: u.r }]);
      this.rendered.set(u.rid, { i: u.i, q: u.q, r: u.r, type: u.type });
    }
    for (const id of [...this.rendered.keys()]) if (!seen.has(id)) { U.remove?.(id); this.rendered.delete(id); }
    U.sync?.(this.state);
  }
}

const SC = [0, 0, 0, 0, 0];   // shared yield scratch — every yield read is synchronous
const WEALTH = { kind: 'gold', key: 'wealth', name: 'Wealth' };   // shared: a queue entry with no state
export default Game;
