// AEON — opponent AI. One entry point, `aiTurn(game, civ)`, called once per AI civ per turn.
//
// The whole file obeys one rule: it may only read what `civ.vis` says the civ can see, plus
// `civ.memory`, which is what it saw on earlier turns and wrote down. It never iterates
// game.units or game.cities looking for things it has not spotted. That is the difference
// between an opponent and a cheat, and it is why the AI wanders early and gets sharp later.
import { hexDistance, spiral } from '../world/hex.js';
import * as R from './rules.js';

const MIL = t => !R.UNITS[t].civilian;
const SEA = t => !!R.UNITS[t].sea;

export function aiTurn(game, civ) {
  civ.memory ??= { cities: new Map(), lastScan: -1 };
  // Goals we failed to path to. Frontier tiles across water look inviting and cost a full
  // exhaustive A* every time; remembering the dead ends for 25 turns is most of the AI's budget.
  if (!civ.noGo || game.state.turn % 25 === 0) civ.noGo = new Set();
  scan(game, civ);

  const mine = game.units.filter(u => u.civ === civ.i && !u.dead);
  const cities = game.cities.filter(c => c.civ === civ.i);
  if (!cities.length && !mine.some(u => u.type === 'settler')) return;   // nothing left to steer

  const army = mine.filter(u => MIL(u.type));
  const foes = [...civ.memory.cities.values()].filter(c => c.civ !== civ.i);
  // Warmongering is gated on both force and reach: five units and a neighbour we can actually
  // walk to. Without the distance test the AI declares on somebody across an ocean and stalls.
  const near = foes.filter(c => cities.some(o => hexDistance(o.q, o.r, c.q, c.r) < 16));
  // A truce is binding: a civ that just signed peace may not redeclare until it lapses, which is
  // what stops the pair from flipping between war and peace every dozen turns.
  const open = c => !(civ.truce.get(c.civ) > game.state.turn);
  const wantWar = game.state.turn > 22 && army.length >= 5 && near.some(open);
  if (wantWar) for (const c of near) if (open(c) && army.length >= 5 + civ.atWar.size * 3) game.declareWar(civ, game.civs[c.civ]);

  const target = pickWarTarget(game, civ, cities, near);
  const land = army.filter(u => !SEA(u.type));
  const field = assignGarrisons(game, civ, cities, land);
  let settleSites = null;   // computed at most once per turn, and only if a settler exists

  for (const u of mine) {
    if (u.dead || u.mp <= 0) continue;
    if (u.type === 'settler') {
      settleSites ??= rankSites(game, civ, cities);
      runSettler(game, civ, u, cities, settleSites);
    } else if (u.type === 'scout') {
      explore(game, civ, u);
    } else {
      runSoldier(game, civ, u, cities, target, field);
    }
  }
  for (const c of cities) game.cityStrike(c);      // free shot at whatever is standing outside
  production(game, civ, cities, army, wantWar);
  treasury(game, civ, cities, wantWar, army);
}

// ------------------------------------------------------------------- memory
// Write down every city and every hostile unit currently in sight; forget nothing about
// cities (they do not move) and forget hostile positions the moment they leave sight.
function scan(game, civ) {
  const m = civ.memory;
  m.threats = [];
  for (const c of game.cities) if (civ.vis[c.i] === 2) m.cities.set(c.id, { id: c.id, q: c.q, r: c.r, i: c.i, civ: c.civ, pop: c.pop });
  for (const [id, rec] of m.cities) {                    // a razed or captured city updates on sight
    if (civ.vis[rec.i] !== 2) continue;
    const live = game.byCity.get(id);
    if (!live) m.cities.delete(id); else rec.civ = live.civ;
  }
  for (const u of game.units) {
    if (u.civ === civ.i || civ.vis[u.i] !== 2 || !MIL(u.type)) continue;
    m.threats.push({ q: u.q, r: u.r, i: u.i, civ: u.civ, str: R.UNITS[u.type].str, hp: u.hp });
  }
}

// ------------------------------------------------------------------ settling
// Score every explored, unclaimed, reachable spot once per turn. The 4-tile spacing rule and
// the distance-from-home penalty together produce the sprawling-but-connected empire shape.
function rankSites(game, civ, cities) {
  const out = [];
  for (const t of game.map.tiles) {
    if (civ.vis[t.i] === 0) continue;
    if (R.isWater(t) || R.impassable(t) || t.biome === 'snow') continue;
    if (game.owner[t.i] >= 0 && game.owner[t.i] !== civ.i) continue;
    let home = Infinity;
    for (const c of cities) home = Math.min(home, hexDistance(c.q, c.r, t.q, t.r));
    if (home < 4) continue;
    if (cities.length && home > 14) continue;
    let near = Infinity;
    for (const c of civ.memory.cities.values()) near = Math.min(near, hexDistance(c.q, c.r, t.q, t.r));
    if (near < 4) continue;
    let s = 0, coast = 0;
    for (const p of spiral(t.q, t.r, 2)) {
      const nt = game.at(p.q, p.r); if (!nt) { s -= 2; continue; }
      if (civ.vis[nt.i] === 0) { s -= 1; continue; }
      s += game.tileScore(nt);
      if (nt.biome === 'coast') coast = 1;
    }
    out.push({ i: t.i, q: t.q, r: t.r, s: s + coast * 8 + (t.river ? 10 : 0) - (home === Infinity ? 0 : home * 1.2) });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, 12);
}

function runSettler(game, civ, u, cities, sites) {
  const here = game.tiles[u.i];
  const spaced = cities.every(c => hexDistance(c.q, c.r, u.q, u.r) >= 4) &&
                 [...civ.memory.cities.values()].every(c => hexDistance(c.q, c.r, u.q, u.r) >= 4);
  // Plant on the spot if this is a legal site and either it is one of the ranked picks or the
  // settler has been walking long enough that any legal ground beats another five turns of it.
  if (spaced && !R.isWater(here) && !R.impassable(here) && here.biome !== 'snow') {
    const ranked = sites.some(s => s.i === u.i);
    u.wander = (u.wander || 0) + 1;
    if (ranked || u.wander > 6 || !sites.length) { game.foundCity(civ, here); game.killUnit(u); return; }
  }
  const goal = sites.find(s => s.i !== u.i) || sites[0];
  if (goal) { if (!game.orderMove(u, goal.q, goal.r)) u.wander = 9; }
  else explore(game, civ, u);
}

// ----------------------------------------------------------------- exploring
// Head for the closest frontier: an explored tile that still touches the dark.
function explore(game, civ, u) {
  const def = R.UNITS[u.type];
  let best = -1, bd = Infinity;
  for (const t of game.map.tiles) {
    if (civ.vis[t.i] === 0 || R.impassable(t) || civ.noGo.has(t.i)) continue;
    if (!R.seaOk(def, t, civ.techs)) continue;              // a galley cannot scout a forest
    let edge = false;
    for (let d = 0; d < 6; d++) { const j = game.NB[t.i * 6 + d]; if (j >= 0 && civ.vis[j] === 0) { edge = true; break; } }
    if (!edge) continue;
    const dist = hexDistance(u.q, u.r, t.q, t.r);
    if (dist > 0 && dist < bd) { bd = dist; best = t.i; }
  }
  if (best < 0) { u.fortified = true; u.mp = 0; return; }      // world fully mapped: stand down
  const t = game.tiles[best];
  if (!game.orderMove(u, t.q, t.r)) { civ.noGo.add(best); u.mp = 0; u.goal = -1; }
}

// ------------------------------------------------------------------- warfare
const nearest = (list, u) => list.reduce((b, c) => (hexDistance(c.q, c.r, u.q, u.r) < hexDistance(b.q, b.r, u.q, u.r) ? c : b));
function pickWarTarget(game, civ, cities, near) {
  if (!civ.atWar.size || !cities.length) return null;
  let best = null, bd = Infinity;
  for (const c of near) {
    if (!civ.atWar.has(c.civ)) continue;
    for (const o of cities) {
      const d = hexDistance(o.q, o.r, c.q, c.r);
      if (d < bd) { bd = d; best = c; }
    }
  }
  return best;
}

function runSoldier(game, civ, u, cities, target, field) {
  const def = R.UNITS[u.type], reach = def.range || 1;

  // 1. Shoot or charge anything already in reach that we can beat.
  let hit = null, hs = -Infinity;
  for (const p of spiral(u.q, u.r, reach)) {
    const t = game.at(p.q, p.r); if (!t || civ.vis[t.i] !== 2) continue;
    if (!game.canAttackTile(u, t.i)) continue;               // wrong element, or nothing hostile there
    const foe = game.unitOn(t.i), fc = game.cityOn(t.i);
    if (foe && foe.civ !== civ.i && civ.atWar.has(foe.civ)) {
      const odds = game.atkStrength(u, t.i) - game.defStrength(foe, u);
      // Ranged units never take a return hit, so they fire on worse odds than melee accepts.
      if (odds > (def.rng ? -14 : -2) && odds > hs) { hs = odds; hit = t.i; }
    } else if (fc && fc.civ !== civ.i && civ.atWar.has(fc.civ)) {
      let odds = game.atkStrength(u, t.i) - game.cityStrength(fc);
      if (fc.hp < fc.maxHp * 0.45) odds += 45;              // the walls are down: take it
      if ((odds > -6 || (def.rng && odds > -26)) && odds > hs) { hs = odds; hit = t.i; }
    }
  }
  if (hit !== null) { game.attack(u, hit); return; }

  // 1b. A fleet has no garrison duty and no border to hold: it patrols the coast it can see,
  //     which both screens the home shelf and finds the neighbours across the water.
  if (SEA(u.type)) { explore(game, civ, u); return; }

  // 1c. Badly hurt and nothing worth hitting: pull back into the fortification and heal. Units
  //     that keep charging at 20 HP are why an AI can lose a war it was winning.
  if (u.hp < 40 && !cities.some(c => c.i === u.i)) {
    const home = cities.length ? nearest(cities, u) : null;
    if (home && hexDistance(u.q, u.r, home.q, home.r) > 1 && game.orderMove(u, home.q, home.r)) return;
    u.fortified = true; u.mp = 0; return;
  }

  // 2. If this unit drew garrison duty, it walks home and digs in. Exactly one unit per city
  //    gets that job (see assignGarrisons), so the rest are free to be an army.
  if (u.garrison >= 0) {
    const c = game.byCity.get(u.garrison);
    if (c && c.civ === civ.i) {
      // Standing on the city it defends: dig earthworks first, then hold them.
      if (u.i === c.i) { if (!game.entrench(u)) { u.fortified = true; u.mp = 0; } return; }
      if (game.orderMove(u, c.q, c.r)) return;
    }
  }

  // 3. March on the war target — but only with a real stack, never by dribbling units in.
  if (target && field.length >= 3) { if (game.orderMove(u, target.q, target.r)) return; }

  // 4. Otherwise screen the border: sit on the best owned tile near the frontier, dug in.
  const threat = civ.memory.threats[0];
  if (threat && civ.atWar.has(threat.civ) && hexDistance(u.q, u.r, threat.q, threat.r) < 8) {
    if (game.orderMove(u, threat.q, threat.r)) return;
  }
  if (!civ.atWar.size && u.mp > 0 && field.length > 1) { explore(game, civ, u); return; }
  u.fortified = true; u.mp = 0;
}

// ---------------------------------------------------------------- production
// The AI only ever *prepends* to a queue: game.chooseProduction is the sane default, and this is
// the override for the four things a default cannot know — that we still have not seen the map,
// that a war is coming, that there is water worth owning, or that there is land worth taking.
function production(game, civ, cities, army, wantWar) {
  const settlers = game.units.filter(u => u.civ === civ.i && u.type === 'settler').length;
  const scouts = game.units.filter(u => u.civ === civ.i && u.type === 'scout').length;
  const ships = game.units.filter(u => u.civ === civ.i && SEA(u.type)).length;
  // What the neighbours are actually fielding, as far as we can see it. Shopping against this
  // instead of against a single strength number is the only reason the anti-cavalry line, the
  // crossbow and the ranged hulls ever get built: they all unlock behind something stronger.
  const mix = game.threatMix(civ);
  const has = f => army.some(u => f(R.UNITS[u.type]));
  const nextUnit = () => {
    if ((mix.mounted || 0) > 0.2 && !has(d => d.vs && d.vs.mounted)) return game.bestUnit(civ, false, 'anticav');
    if (!has(d => d.rng)) return game.bestUnit(civ, false, 'ranged') ?? game.bestUnit(civ, false, 'siege');
    if (civ.atWar.size && !has(d => d.siege)) return game.bestUnit(civ, false, 'siege');
    return game.bestUnit(civ, false, null, mix);
  };
  // Hulls alternate: one to hold the shelf, one to shell the coast. A fleet of a single type is
  // how a navy that owns the water still cannot hurt anything standing on the beach.
  const nextShip = () => game.bestUnit(civ, true, ships % 2 ? 'naval_ranged' : 'naval') ?? game.bestUnit(civ, true);
  // Prepend unless it is already somewhere in the queue. Without that check two priorities sit
  // there shoving each other off the head every turn and the queue grows without bound.
  const want = (c, kind, key) => {
    if (!key || !game.canBuild(c, kind, key) || c.queue.some(j => j.kind === kind && j.key === key)) return false;
    c.queue.unshift({ kind, key }); return true;
  };
  for (const c of cities) {
    // Two scouts up front: the AI cannot settle or fight what it has never looked at, and a
    // 25-hammer scout buys more of the map than anything else it could be building on turn 5.
    if (scouts < 2 && game.state.turn < 40 && want(c, 'unit', 'scout')) continue;
    // A war needs a real army, not a garrison plus two: at peace one spare unit per city, at war
    // six, which is the difference between raiding a border and actually taking a city.
    const needMil = army.length < cities.length + (civ.atWar.size ? 6 : 1);
    if (needMil && want(c, 'unit', nextUnit())) continue;
    // One hull per coastal city, and only once the land army is covered: ships own the shelf and
    // shell the coast, but a fleet built instead of spearmen loses the land war that decides it.
    if (!needMil && ships < cities.length && want(c, 'unit', nextShip())) continue;
    if (!civ.atWar.size && cities.length < 6 && settlers === 0 && c.pop >= 3 && want(c, 'unit', 'settler')) continue;
    if (wantWar) want(c, 'building', 'walls');
  }
}

// Exactly one defender per city, picked by walking distance, so garrison duty never eats the
// whole army. Returns the units that are left over — the field force.
function assignGarrisons(game, civ, cities, army) {
  for (const u of army) u.garrison = -1;
  const free = army.slice();
  for (const c of cities) {
    const held = game.unitOn(c.i);
    if (held && held.civ === civ.i && MIL(held.type)) { held.garrison = c.id; const k = free.indexOf(held); if (k >= 0) free.splice(k, 1); continue; }
    let best = null, bd = Infinity;
    for (const u of free) { const d = hexDistance(u.q, u.r, c.q, c.r); if (d < bd) { bd = d; best = u; } }
    if (best) { best.garrison = c.id; free.splice(free.indexOf(best), 1); }
  }
  return free;
}

// Gold does nothing until it is spent. Buy the front of a queue when the treasury is deep or
// the war is on and the item is nearly done anyway. buyCost prices the swap off WEALTH for a
// city that has finished everything, so a mature empire keeps having somewhere to put its money.
function treasury(game, civ, cities, wantWar, army) {
  if (civ.gold < 120) return;
  const urgent = civ.atWar.size || wantWar;
  const reserve = urgent ? 40 : 120;
  // Wages are real: rushing hulls and horsemen you cannot pay for is how an AI buys its way into
  // disbanding the army next turn. Past this size the treasury only ever rushes buildings.
  const bloated = army.length > cities.length * 3 + 4;
  const picks = cities
    .map(c => ({ c, cost: game.buyCost(c), job: game.buyJob(c) }))
    .filter(x => x.job && Number.isFinite(x.cost) && x.cost > 0 && !(bloated && x.job.kind === 'unit'))
    .sort((a, b) => a.cost - b.cost);
  for (const p of picks) { if (p.cost > civ.gold - reserve) break; game.buyProduction(p.c, civ); }
  // Whatever is left re-equips the army, oldest kit first. This is where a mature treasury goes
  // once every city has been built out, and it is why the AI's late army is not a museum.
  if (civ.gold < reserve + 60) return;
  const stale = army.map(u => ({ u, cost: game.upgradeCost(u) })).filter(x => Number.isFinite(x.cost)).sort((a, b) => a.cost - b.cost);
  for (const s of stale) { if (s.cost > civ.gold - reserve) break; game.upgradeUnit(s.u, civ); }
}
