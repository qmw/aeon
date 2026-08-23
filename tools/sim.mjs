// AEON — headless match check.  Run: node tools/sim.mjs [turns] [seed]
//
// Two things are under test here, and the second one is the reason this file is long.
//
// 1. The simulation. 100 turns, four seats, hard invariants every turn (finite yields, legal
//    tiles, index integrity, one unit per tile, prerequisite-ordered research).
// 2. That the simulation is actually RUNNING. A test that a dead AI, dead combat and dead growth
//    all sail through is not a test, it is a rubber stamp — so every claim below is pinned to a
//    counter that goes to zero the moment the code behind it is deleted:
//      aiTurn() stubbed out       -> aiMoves / aiFounded / aiAttacks collapse
//      combat damage forced to 0  -> defenderDeaths collapses
//      city growth disabled       -> no city ever reaches pop 5 (founding cannot fake it)
//      fog-blind pathfinding      -> truthPeeks fires
//      unit roles collapsed       -> the reachability sweep leaves units uncovered
//
// The human seat is driven ONLY through the surface the shipped UI actually touches, verified by
// grep: selectTile (input.js _select), endTurn (input.js Space / hud.js button), setResearch
// (hud.js tech tree) and a dispatched `aeon:action` CustomEvent (hud.js act). Nothing here calls
// commandTo or action() directly. If a button is dead in the browser, it is dead here too.
import { generateMap } from '../src/world/mapgen.js';
import { Game } from '../src/game/turn.js';
import { mulberry32 } from '../src/core/rng.js';
import { hexDistance, spiral } from '../src/world/hex.js';
import * as R from '../src/game/rules.js';

const TURNS = +(process.argv[2] ?? 100), SEED = +(process.argv[3] ?? 20260821);
const fail = [];
const check = (ok, msg) => { if (!ok && fail.length < 12) fail.push(msg); return ok; };
const finite = v => typeof v === 'number' && Number.isFinite(v);

// The one piece of browser surface the game uses: hud.js fires its action bar as a window event.
// Installing a real EventTarget rather than stubbing the game's listener means the wire itself
// is under test — if nothing in the repo listens for `aeon:action`, every button below is inert.
const bus = new EventTarget();
globalThis.addEventListener = (t, f) => bus.addEventListener(t, f);
globalThis.dispatchEvent = e => bus.dispatchEvent(e);

// ---- static tables: prerequisites exist, never point forward, and unlock real things
for (const [k, t] of Object.entries(R.TECHS)) for (const p of t.pre)
  check(R.TECHS[p] && R.TECHS[p].era <= t.era, `tech ${k} has bad prereq ${p}`);
for (const [k, u] of Object.entries(R.UNITS)) check(!u.tech || R.TECHS[u.tech], `unit ${k} needs unknown tech ${u.tech}`);
for (const [k, b] of Object.entries(R.BUILDINGS)) {
  check(!b.tech || R.TECHS[b.tech], `building ${k} needs unknown tech ${b.tech}`);
  check(!b.needs || R.BUILDINGS[b.needs], `building ${k} needs unknown building ${b.needs}`);
}

const map = generateMap({ w: 64, h: 44, seed: SEED });

// A recording stand-in for render/units.js and render/fx.js. It exists so the fog is tested where
// it is actually spent: turn.js only pushes an entity to the renderer when the human civ can see
// it, and this catches the moment it pushes one it cannot. Without a sink here, pushRender —
// the whole reason hidden enemies are hidden — never runs during the test at all.
const idx = (q, r) => map.get(q, r)?.i ?? -1;
const sink = {
  vis: null, adds: 0, moves: 0, removes: 0, leaks: 0, foreignShown: 0, civOf: new Map(),
  setVisibility(v) { this.vis = v; },
  add(spec) {
    this.adds++; this.civOf.set(spec.id, spec.civ);
    if (spec.civ === 0 || !this.vis) return;
    this.foreignShown++;
    if (this.vis[idx(spec.q, spec.r)] === 0) this.leaks++;   // drawn on ground we have never seen
  },
  remove(id) { this.removes++; this.civOf.delete(id); },
  moveUnit(id, path) {
    this.moves++;
    if (this.civOf.get(id) === 0 || !this.vis) return;
    for (const p of path) if (this.vis[idx(p.q, p.r)] === 0) this.leaks++;
  },
};
const game = new Game(map, { units: sink, fx: sink });
const rng = mulberry32(SEED ^ 0x9e3779b9);

// ---- dead content sweep: walk a civ up the tech tree and ask for the best unit of every role at
// every step. Anything the shopping function can never name is content that ships and never
// appears — which is exactly what a single-scalar bestUnit() did to five of these twenty units.
{
  const fakeCiv = { i: 0, techs: new Set() }, reachable = new Set();
  const sweep = () => {
    for (const [sea, roles] of [[false, R.ROLES], [true, R.NAVAL_ROLES]]) {
      for (const role of roles) { const k = game.bestUnit(fakeCiv, sea, role); if (k) reachable.add(k); }
      const any = game.bestUnit(fakeCiv, sea); if (any) reachable.add(any);
    }
  };
  sweep();
  for (const t of [...R.TECH_LIST].sort((a, b) => R.TECHS[a].cost - R.TECHS[b].cost)) { fakeCiv.techs.add(t); sweep(); }
  const dead = Object.keys(R.UNITS).filter(k => !R.UNITS[k].civilian && !reachable.has(k));
  check(dead.length === 0, `units that can never be produced: ${dead.join(',')}`);
}

// ---------------------------------------------------------------- instrumentation
// Every wrapper below counts something the assertions at the bottom depend on. None of them
// change behaviour: each one calls straight through.
const raw = {
  order: game.orderMove.bind(game), attack: game.attack.bind(game), found: game.foundCity.bind(game),
  capture: game.captureCity.bind(game), path: game.findPath.bind(game), enter: game.enterCost.bind(game),
  peace: game.makePeace.bind(game), war: game.declareWar.bind(game),
};
const rawUpgrade = game.upgradeUnit.bind(game);
const n = { aiMoves: 0, aiFounded: 0, aiAttacks: 0, defenderDeaths: 0, captures: 0, peaces: 0, wars: 0, pathTiles: 0, darkTiles: 0, upgrades: 0 };
let peeks = 0, blindShots = 0, truthPeeks = 0, truceBreaks = 0, planning = false;

// Fog honesty, part one: no order and no shot may land on a tile that civ has never seen.
game.orderMove = (u, q, r) => { const t = game.at(q, r); if (t && game.civs[u.civ].vis[t.i] === 0) peeks++; return raw.order(u, q, r); };
game.attack = (u, i) => {
  const def = game.unitOn(i);
  if (game.civs[u.civ].vis[i] !== 2) blindShots++;
  if (u.civ !== 0) n.aiAttacks++;
  const out = raw.attack(u, i);
  if (def && def.dead) n.defenderDeaths++;                  // combat that cannot kill is not combat
  return out;
};
// Fog honesty, part two: the ROUTE, not just the destination. enterCost is ground truth; if the
// planner ever asks it about a tile the moving civ has not seen, the A* is reading the map
// through the fog. Unexplored tiles are priced by Game.planCost as a guess instead — deliberate,
// and measured below as darkTiles: a civ is allowed to march into the dark, not to see into it.
game.enterCost = (u, i, j, d) => { if (planning && game.civs[u.civ].vis[j] === 0) truthPeeks++; return raw.enter(u, i, j, d); };
game.findPath = (u, goal) => {
  planning = true;
  const p = raw.path(u, goal);
  planning = false;
  if (p) { const v = game.civs[u.civ].vis; for (const j of p) { n.pathTiles++; if (v[j] === 0) n.darkTiles++; } }
  return p;
};
game.foundCity = (civ, t) => { if (civ.i !== 0) n.aiFounded++; return raw.found(civ, t); };
game.upgradeUnit = (u, by) => { const ok = rawUpgrade(u, by); if (ok) n.upgrades++; return ok; };
game.captureCity = (c, civ) => { n.captures++; return raw.capture(c, civ); };
game.makePeace = (a, b) => { n.peaces++; return raw.peace(a, b); };
game.declareWar = (a, b) => {
  // A truce is binding. Catching a break here rather than in a hand-cranked unit test means the
  // real turn loop is what proves it, not a function called in isolation.
  if (a.i !== b.i && !a.atWar.has(b.i)) { n.wars++; if (a.truce.get(b.i) > game.state.turn || b.truce.get(a.i) > game.state.turn) truceBreaks++; }
  return raw.war(a, b);
};

// ------------------------------------------------------------------- human seat
// hud.js act(): every button on the action bar ends up as this event and nothing else.
const press = key => dispatchEvent(new CustomEvent('aeon:action', { detail: key }));
const did = { moved: 0, founded: 0, fortified: 0, entrenched: 0, produced: 0, bought: 0, researched: 0, struck: 0 };

function humanSeat(g) {
  const me = g.state.player;
  // Click a node in the tech tree (hud.js buildTree). setResearch is the method that has to say
  // no to everything whose prerequisites are missing, and it is the only way in.
  const legal = R.TECH_LIST.filter(t => !me.techs.has(t) && R.TECHS[t].pre.every(p => me.techs.has(p)));
  const wanted = legal[(rng() * legal.length) | 0];
  if (wanted && g.setResearch(me, wanted)) did.researched++;
  const blocked = R.TECH_LIST.find(t => !me.techs.has(t) && !R.TECHS[t].pre.every(p => me.techs.has(p)));
  if (blocked) check(!g.setResearch(me, blocked), `setResearch accepted ${blocked} with prerequisites missing`);
  check(!g.setResearch(me, 'time_travel'), 'setResearch accepted a tech that does not exist');

  for (const u of g.state.units.filter(x => x.civ === 0 && !x.dead)) {
    g.selectTile(u.q, u.r);                                  // left click on the unit
    if (g.state.selectedUnit !== u) continue;
    if (u.type === 'settler') {
      const before = g.cities.length;
      press('found');
      if (g.cities.length > before) { did.founded++; continue; }
    }
    // Read the board the way a player does — only tiles this civ has explored — and click one.
    // With a unit up, that click IS the move order; there is no other verb for it in the UI.
    const opts = spiral(u.q, u.r, 4).filter(p => { const t = g.at(p.q, p.r); return t && me.vis[t.i] > 0 && t.i !== u.i; });
    const pick = opts[(rng() * opts.length) | 0];
    const from = u.i;
    if (pick) g.selectTile(pick.q, pick.r);
    if (u.i !== from) { did.moved++; continue; }
    if (u.dead) continue;
    g.selectTile(u.q, u.r);
    const forts = g.forts.size;
    press('build');
    if (g.forts.size > forts) { did.entrenched++; continue; }
    press('fortify');
    if (u.fortified) did.fortified++;
  }

  // City buttons. Each one is observed through the world, not through a return value, because
  // that is all hud.js gets back from dispatchEvent — if the listener is gone, these stay zero.
  const city = g.cities.find(c => c.civ === 0 && c.capital) ?? g.cities.find(c => c.civ === 0);
  if (city) {
    g.selectTile(city.q, city.r);
    if (g.state.turn % 7 === 0) {
      const head = city.queue[0];
      press('produce');
      if (city.queue[0] !== head) did.produced++;
    }
    if (me.gold > 250) {
      const gold = me.gold;
      press('buy');
      if (me.gold < gold) did.bought++;
    }
    if (me.atWar.size) { press('strike'); if (city.struck === g.state.turn) did.struck++; }
  }
}

// ---- an enemy city may never be bought with the enemy's own gold. hud.js used to hand
// buyProduction whatever city was selected, which spent THEIR treasury on THEIR walls.
let exploitRan = false;
function exploitCheck(g) {
  // Only a city the player can actually see is a city the player can actually click.
  const foe = g.cities.find(c => c.civ !== 0 && g.state.player.vis[c.i] > 0); if (!foe) return;
  exploitRan = true;
  // Stake the victim so the guard is what refuses the purchase, not an empty enemy treasury.
  const owner = g.civs[foe.civ], purse = owner.gold = 9999, prod = foe.prod;
  g.selectTile(undefined, undefined);                        // Escape, so the click is a select
  g.selectTile(foe.q, foe.r);
  press('buy');
  check(g.civs[foe.civ].gold === purse && foe.prod === prod, 'the action bar spent an enemy treasury');
  check(g.buyProduction(foe) === false, 'buyProduction let the player rush a foreign city');
  check(g.civs[foe.civ].gold === purse, 'buyProduction charged a foreign treasury');
  check(foe.prod === prod, 'buyProduction advanced a foreign build');
  owner.gold = 40;
}

// ------------------------------------------------------------------------ run
const capitals = game.cities.map(c => c.id);
const pop0 = game.cities.reduce((a, c) => a + c.pop, 0);
const t0 = Date.now();
let slowest = 0, maxGold = 0, maxPop = 0;

for (let turn = 0; turn < TURNS; turn++) {
  const tt = Date.now();
  humanSeat(game);
  if (turn > 20 && !exploitRan) exploitCheck(game);
  // Snapshot where every AI unit is standing, then let the AI have its turn inside endTurn.
  const before = new Map(game.units.filter(u => u.civ !== 0).map(u => [u.id, u.i]));
  game.selectTile(undefined, undefined);                     // Escape: drop the selection first
  game.endTurn();
  for (const u of game.units) if (u.civ !== 0 && before.has(u.id) && before.get(u.id) !== u.i) n.aiMoves++;
  slowest = Math.max(slowest, Date.now() - tt);
  if (Date.now() - t0 > 60000) { fail.push(`ran over 60s at turn ${turn}`); break; }

  // ---- per-turn invariants
  for (const civ of game.civs) {
    if (!check(finite(civ.gold) && finite(civ.science) && finite(civ.progress) && finite(civ.faith), `NaN economy on ${civ.name}`)) break;
    check(civ.gold >= 0 && finite(civ.upkeep ?? 0), `bad treasury on ${civ.name}: ${civ.gold}/${civ.upkeep}`);
    check(civ.vis.every(v => v <= 2), `bad visibility value for ${civ.name}`);
    check(civ.era >= 0 && civ.era < R.ERAS.length, `bad era ${civ.era} for ${civ.name}`);
    check([...civ.atWar].every(o => game.civs[o].atWar.has(civ.i)), `one-sided war for ${civ.name}`);
    maxGold = Math.max(maxGold, civ.gold);
  }
  for (const c of game.cities) {
    check(finite(c.food) && finite(c.prod) && finite(c.pop) && c.pop >= 1, `bad city ${c.name} pop=${c.pop} food=${c.food}`);
    check(c.yields.every(v => finite(v) && v >= 0), `bad yield in ${c.name}: ${c.yields}`);
    check(game.cityAt[c.i] === c.id, `city index desync at ${c.name}`);
    check(c.queue.length <= 6, `runaway queue in ${c.name} (${c.queue.length})`);
    maxPop = Math.max(maxPop, c.pop);
  }
  for (const u of game.units) {
    const t = game.tiles[u.i], def = R.UNITS[u.type];
    check(!R.impassable(t), `${u.name} standing on ${t.biome} at ${u.q},${u.r}`);
    check(R.seaOk(def, t, game.civs[u.civ].techs), `${u.name} illegally on ${t.biome} at ${u.q},${u.r}`);
    check(u.embarked === (R.isWater(t) && !def.sea), `${u.name} embark flag desync at ${u.q},${u.r}`);
    check(game.unitAt[u.i] === u.id, `unit index desync for ${u.name} ${u.q},${u.r}`);
    check(finite(u.hp) && u.hp > 0 && u.hp <= 100, `bad hp ${u.hp} on ${u.name}`);
    check(u.mp <= u.maxMp && u.mp >= 0, `bad mp ${u.mp} on ${u.name}`);
    // Earthworks are a hole in the ground, not a deed: whoever takes the tile razes them.
    check(!game.forts.has(u.i) || game.forts.get(u.i) === u.civ, `${u.name} is holding civ ${game.forts.get(u.i)}'s earthworks at ${u.q},${u.r}`);
  }
  const seen = new Set();
  for (const u of game.units) { check(!seen.has(u.i), `two units share tile ${u.q},${u.r}`); seen.add(u.i); }
  // Earthworks belong to whoever dug them, and to nobody after that.
  for (const [i, ci] of game.forts) check(ci >= 0 && ci < game.civs.length, `fort at ${i} owned by civ ${ci}`);
  // The event log is part of the fog. Every entry that is about a place carries that tile, so
  // this is exact: nothing that happened on ground the player has never seen may appear in it.
  // (Wars, peace and the fall of a civ are worldwide news and carry no tile.)
  for (const l of game.state.log)
    check(l.i === undefined || game.state.player.vis[l.i] > 0, `the log reported an unseen tile: "${l.msg}"`);
  const r = game.state.research;
  check(finite(r.progress) && r.progress >= 0 && r.progress <= 1 && finite(r.eta), `bad research readout ${JSON.stringify(r)}`);
  if (fail.length) break;
}

// -------------------------------------------------------------------- late game
// The economy only fails late: an empire that has finished every building in every city mints
// gold with nothing left to buy, and 100 turns never gets there. So the same match keeps running,
// AI-only from here, out to LATE — which is where the treasury, the era ceiling and the WEALTH
// queue actually get tested instead of assumed.
const LATE = Math.max(TURNS, 260);
let wealthCities = 0;
for (let turn = game.state.turn; turn < LATE && !fail.length; turn++) {
  game.endTurn();
  for (const c of game.cities) {
    if (c.queue[0]?.kind !== 'gold') continue;
    wealthCities++;
    // A city parked on Wealth still has to be a place gold can go, or the treasury dead-ends.
    check(Number.isFinite(game.buyCost(c)), `${c.name} sells its hammers and cannot be rushed`);
  }
  for (const civ of game.civs) { maxGold = Math.max(maxGold, civ.gold); check(finite(civ.gold) && civ.gold >= 0, `NaN treasury on ${civ.name} at turn ${turn}`); }
  for (const c of game.cities) maxPop = Math.max(maxPop, c.pop);
  for (const u of game.units) check(!R.impassable(game.tiles[u.i]), `${u.name} on a peak at turn ${turn}`);
}
check(wealthCities > 0, 'no city ever ran out of things to build, so the gold sink was never tested');
check(Math.max(...game.civs.map(c => c.era)) >= 2, `nobody left the classical era in ${LATE} turns`);

// ---- the AI has to have played. Every one of these is zero if aiTurn() returns immediately.
check(n.aiMoves > 50, `the AI never moved a unit (${n.aiMoves} steps)`);
check(n.aiFounded > 0, 'the AI never founded a city');
check(n.aiAttacks > 0, 'the AI never attacked anything');
check(game.cities.filter(c => c.civ !== 0).length > game.civs.length, `the AI never expanded (${game.cities.length} cities total)`);

// ---- combat has to be lethal. The old check counted battles and asserted nothing about them,
// so zeroing the damage roll still passed.
check(n.defenderDeaths > 0, `${n.aiAttacks} attacks and no defender ever died`);

// ---- cities have to GROW. Summed population cannot tell growth from settling: ten new cities at
// pop 1 beat one capital at pop 9. A single city reaching pop 5 can only be growth.
check(maxPop >= 5, `no single city ever grew past pop ${maxPop}`);
check(capitals.some(id => (game.byCity.get(id)?.pop ?? 0) >= 4), 'not one starting capital grew');

// ---- research, buildings, fog, treasury
const techs = game.civs.map(c => c.techs.size);
const built = game.cities.reduce((a, c) => a + c.buildings.size, 0);
check(Math.min(...techs) >= 3, `a civ researched almost nothing (${techs})`);
check(Math.max(...techs) >= 8, `research stalled everywhere (${techs})`);
check(built > 0, 'no buildings were ever completed');
check(peeks === 0, `${peeks} orders were given to never-explored tiles`);
check(blindShots === 0, `${blindShots} attacks were made on unseen tiles`);
check(truthPeeks === 0, `${truthPeeks} A* steps read real terrain through the fog`);
check(truceBreaks === 0, `${truceBreaks} wars were declared inside a binding truce`);
check(maxGold < 8000, `gold compounded to ${Math.round(maxGold)} with nothing to spend it on`);

// ---- the fog has to reach the renderer, not just the AI. Every figure handed to units.js is
// filtered through civ 0's own visibility, so a foreign unit is never drawn onto ground the
// player has not seen — and the filter is not simply "hide everything", or foreignShown is 0.
check(sink.vis === game.civs[0].vis, 'the renderer was never handed a visibility buffer');
check(sink.leaks === 0, `${sink.leaks} foreign figures were drawn on never-explored tiles`);
check(sink.foreignShown > 0, 'no enemy was ever drawn, so the fog filter hides everything');
check(sink.adds > 0 && sink.moves > 0, `the render bridge went quiet (${sink.adds} adds, ${sink.moves} moves)`);
check(n.upgrades > 0, 'gold never re-equipped a single unit');

// ---- the player's own verbs have to have done something, or the UI is decoration
check(did.moved > 20, `clicking a tile never moved the player's unit (${did.moved})`);
check(did.founded > 0, 'the Found button never planted a city');
check(did.fortified > 0 && did.entrenched > 0, `Fortify/Build never fired (${did.fortified}/${did.entrenched})`);
check(did.produced > 0, 'the Produce button never changed a build');
check(did.researched > 0, 'setResearch never accepted a tech');
check(exploitRan, 'never got to test the foreign-city purchase guard');

// ---- the truce gate itself. truceBreaks above proves no war was declared inside one during the
// run; this proves the rule that stops it is present, on the single function every attack path
// goes through, rather than hoping two hostile units happened to stand next to each other.
{
  const a = game.civs[0], b = game.civs.find(c => c.i !== 0 && c.alive);
  const u = game.units.find(x => x.civ === 0 && !R.UNITS[x.type].civilian && !x.embarked);
  const target = b && game.cities.find(c => c.civ === b.i);
  check(!!(b && u && target), 'no surviving rival to test the truce against');
  if (b && u && target) {
    game.declareWar(a, b);
    check(a.atWar.has(b.i) && b.atWar.has(a.i), 'declareWar did not stick');
    check(game.canAttackTile(u, target.i), 'a declared war would not let anyone open fire');
    game.makePeace(a, b);
    check(!a.atWar.has(b.i) && !b.atWar.has(a.i), 'makePeace left the war running');
    check(a.truce.get(b.i) > game.state.turn, 'peace left no truce behind');
    check(!game.canAttackTile(u, target.i), 'a binding truce did not stop the shooting');
  }
}

// ---- same seed, same match. Cheap guard against an un-seeded Math.random creeping in.
{
  const hash = () => {
    const g = new Game(generateMap({ w: 40, h: 28, seed: SEED }));
    for (let i = 0; i < 15; i++) g.endTurn();
    return `${g.cities.length}/${g.units.length}/${g.civs.map(c => Math.round(c.gold) + ':' + c.techs.size).join(',')}`;
  };
  check(hash() === hash(), 'two runs of the same seed diverged');
}

const ms = Date.now() - t0;
if (fail.length) { console.error('FAIL ' + fail.join(' | ')); process.exit(1); }
const pop1 = game.cities.reduce((a, c) => a + c.pop, 0);
console.log(`sim OK turn=${game.state.turn} ${ms}ms (worst ${slowest}ms) | cities ${game.cities.length} pop ${pop0}->${pop1} (max ${maxPop}) | units ${game.units.length} | techs ${techs.join('/')} era ${game.civs.map(c => c.era).join('/')} | buildings ${built} gold<=${Math.round(maxGold)} | AI ${n.aiMoves} moves ${n.aiFounded} cities ${n.aiAttacks} attacks ${n.defenderDeaths} kills ${n.captures} captures ${n.upgrades} upgrades | render ${sink.adds}/${sink.moves}/${sink.removes} a/m/r (${sink.foreignShown} foreign, ${sink.leaks} leaked) | wars ${n.wars} peaces ${n.peaces} | player ${did.moved} moves ${did.founded} cities ${did.produced} builds ${did.bought} rushes ${did.struck} strikes | paths ${n.pathTiles} tiles (${(100 * n.darkTiles / Math.max(1, n.pathTiles)).toFixed(1)}% into the dark, 0 read through it) | winner ${game.state.winner ?? 'none'}${game.state.victory ? ' (' + game.state.victory + ')' : ''}`);
