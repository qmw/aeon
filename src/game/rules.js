// AEON — rules data. Pure tables and tiny pure helpers: no state, no imports, node-safe.
// Everything the simulation is allowed to be opinionated about lives here, so turn.js stays
// mechanism and ai.js stays policy. Yields are always the 5-vector [food, prod, gold, sci, cult].

export const ERAS = ['Ancient', 'Classical', 'Medieval', 'Industrial'];
export const Y0 = [0, 0, 0, 0, 0];

// ------------------------------------------------------------------- tile yields
export const BIOME_Y = {
  ocean:    [1, 0, 1, 0, 0],
  coast:    [2, 0, 2, 0, 0],
  beach:    [1, 0, 1, 0, 0],
  grass:    [3, 0, 0, 0, 0],
  plains:   [2, 1, 0, 0, 0],
  desert:   [0, 0, 0, 0, 0],
  tundra:   [1, 0, 0, 0, 0],
  snow:     [0, 0, 0, 0, 0],
  forest:   [1, 2, 0, 0, 0],
  jungle:   [2, 1, 0, 0, 0],
  hills:    [1, 2, 0, 0, 0],
  mountain: [0, 0, 0, 0, 0],
};
export const FEATURE_Y = {
  lake: [1, 0, 1, 0, 0], ice: [0, 0, 0, 0, 0], reef: [1, 1, 0, 0, 0],
  delta: [2, 0, 1, 0, 0], floodplains: [2, 0, 1, 0, 0], oasis: [3, 0, 1, 0, 0],
  marsh: [-1, 0, 0, 0, 0], volcano: [0, 0, 0, 0, 1],
};
export const RESOURCE_Y = {
  wheat: [2, 0, 0, 0, 0], cattle: [1, 1, 0, 0, 0], sheep: [1, 1, 0, 0, 0],
  horses: [0, 1, 0, 0, 0], wine: [0, 0, 2, 0, 1], ivory: [0, 1, 1, 0, 0],
  oil: [0, 2, 0, 0, 0], incense: [0, 0, 2, 0, 1], gold: [0, 0, 3, 0, 0],
  deer: [1, 1, 0, 0, 0], furs: [0, 0, 2, 0, 0], silver: [0, 0, 3, 0, 0],
  iron: [0, 2, 0, 0, 0], silk: [0, 0, 2, 0, 1], dyes: [0, 0, 2, 0, 1],
  bananas: [2, 0, 0, 0, 0], spices: [0, 0, 2, 0, 0], cocoa: [0, 0, 2, 0, 0],
  gems: [0, 0, 3, 0, 0], copper: [0, 1, 1, 0, 0], stone: [0, 2, 0, 0, 0],
  marble: [0, 1, 1, 0, 1], crabs: [1, 0, 1, 0, 0], pearls: [0, 0, 2, 0, 0],
  fish: [2, 0, 0, 0, 0], whales: [1, 1, 1, 0, 0],
};

// --------------------------------------------------------------------- movement
// Infinity = impassable to everything. Water is cost 1 but gated behind embarkation.
export const MOVE_COST = {
  ocean: 1, coast: 1, beach: 1, grass: 1, plains: 1, desert: 1, tundra: 1, snow: 1,
  forest: 2, jungle: 2, hills: 2, mountain: Infinity,
};
export const isWater = t => t.height === 0;
export const impassable = t => t.biome === 'mountain';
// What the pathfinder charges for a step into ground the moving civ has never seen. Unexplored
// terrain is a guess, not a lookup: slightly worse than open ground so a planner prefers a known
// road, cheap enough that it will still walk into the dark. See Game.planCost.
export const UNKNOWN_COST = 1.3;
// Where a unit is allowed to stand. Ships live on water and nowhere else; a land unit may only
// wade onto the shelf once it has Sailing, and only cross deep ocean once it has Astronomy —
// which is what keeps the first two eras of war on one landmass.
export const seaOk = (def, t, techs) => def.sea ? isWater(t)
  : !isWater(t) || (techs.has('sailing') && (t.biome !== 'ocean' || techs.has('astronomy')));
export const EMBARK_DEF = 0.4;   // troops at sea are cargo: they defend at 40% and cannot attack
// A city can never work a peak, and nobody works an icefield.
export const workable = t => t.biome !== 'mountain' && t.feature !== 'ice';

// -------------------------------------------------------------------- combat
// Fraction added to a defender's strength for standing here.
export const DEFENSE = { hills: 0.30, forest: 0.25, jungle: 0.25, mountain: 0.50, snow: 0, marsh: -0.10 };
export const SIEGE_BONUS = 0.75;   // what a siege engine adds when the target is a city
export const PROMOTIONS = ['Veteran', 'Elite', 'Champion', 'Legendary'];
export const XP_STEPS = [10, 30, 60, 100];

// Civ-style exponential ratio curve: a 25-point strength edge roughly doubles damage dealt.
// Clamped so a hopeless attack still chips 1 HP and a crushing one never exceeds a one-shot.
export function combatDamage(att, def, roll) {
  const d = Math.max(-90, Math.min(90, att - def));
  return Math.max(1, Math.min(100, Math.round(30 * Math.exp(d / 25) * (0.9 + 0.2 * roll))));
}

// ---------------------------------------------------------------------- units
// `art` names the model render/units.js should draw when it has no mesh of its own for that
// unit yet — a frigate reads as a ship rather than as a spearman standing on the sea.
// str = melee strength (also the defence value). rng/range present = ranged attacker.
// civilian units never fight; a settler consumes itself founding a city.
export const UNITS = {
  settler:    { cost: 50,  mp: 2, str: 0,  sight: 2, civilian: true, role: 'civilian', name: 'Settler' },
  scout:      { cost: 25,  mp: 3, str: 5,  sight: 3, role: 'recon', name: 'Scout' },
  warrior:    { cost: 30,  mp: 2, str: 8,  sight: 2, role: 'melee', name: 'Warrior' },
  archer:     { cost: 40,  mp: 2, str: 6,  rng: 12, range: 2, sight: 2, role: 'ranged', tech: 'archery', name: 'Archer' },
  spearman:   { cost: 42,  mp: 2, str: 12, sight: 2, role: 'anticav', vs: { mounted: 1.5 }, tech: 'bronze_working', name: 'Spearman' },
  horseman:   { cost: 52,  mp: 4, str: 14, sight: 2, role: 'mounted', tech: 'horseback_riding', name: 'Horseman' },
  swordsman:  { cost: 58,  mp: 2, str: 17, sight: 2, role: 'melee', tech: 'iron_working', name: 'Swordsman' },
  catapult:   { cost: 66,  mp: 2, str: 10, rng: 22, range: 2, siege: true, sight: 2, role: 'siege', tech: 'mathematics', name: 'Catapult' },
  pikeman:    { cost: 72,  mp: 2, str: 22, sight: 2, role: 'anticav', vs: { mounted: 1.6 }, tech: 'feudalism', name: 'Pikeman' },
  knight:     { cost: 84,  mp: 4, str: 28, sight: 3, role: 'mounted', tech: 'chivalry', name: 'Knight' },
  crossbowman:{ art: 'archer', cost: 82,  mp: 2, str: 18, rng: 32, range: 2, sight: 2, role: 'ranged', tech: 'machinery', name: 'Crossbowman' },
  trebuchet:  { cost: 92,  mp: 2, str: 16, rng: 36, range: 2, siege: true, sight: 2, role: 'siege', tech: 'engineering', name: 'Trebuchet' },
  musketman:  { art: 'spearman', cost: 112, mp: 2, str: 38, sight: 2, role: 'melee', vs: { mounted: 1.25 }, tech: 'gunpowder', name: 'Musketman' },
  cannon:     { art: 'catapult', cost: 134, mp: 2, str: 28, rng: 50, range: 2, sight: 2, siege: true, role: 'siege', tech: 'metallurgy', name: 'Cannon' },
  rifleman:   { art: 'spearman', cost: 158, mp: 2, str: 54, sight: 2, role: 'melee', tech: 'industrialization', name: 'Rifleman' },
  // Navy. sea:true means water-only — they cannot be built inland, cannot take a city, and the
  // melee ones cannot even touch a land tile. Their job is to own the shelf and shell the coast.
  galley:     { art: 'trireme', cost: 44,  mp: 4, str: 12, sight: 3, sea: true, role: 'naval', tech: 'sailing', name: 'Galley' },
  quinquereme:{ art: 'trireme', cost: 74,  mp: 4, str: 14, rng: 20, range: 2, sight: 3, sea: true, role: 'naval_ranged', tech: 'mathematics', name: 'Quinquereme' },
  caravel:    { art: 'trireme', cost: 98,  mp: 5, str: 30, sight: 4, sea: true, role: 'naval', tech: 'astronomy', name: 'Caravel' },
  frigate:    { art: 'trireme', cost: 132, mp: 5, str: 34, rng: 44, range: 2, sight: 4, sea: true, role: 'naval_ranged', tech: 'metallurgy', name: 'Frigate' },
  ironclad:   { art: 'trireme', cost: 176, mp: 6, str: 62, sight: 4, sea: true, role: 'naval', tech: 'industrialization', name: 'Ironclad' },
};

// Counter matrix, read off the `vs` fields above. A pikeman is anti-cavalry whether it charges
// a knight or receives one, so the multiplier applies from either side of the fight — which is
// the whole reason a 22-strength pikeman is worth building after a 28-strength knight exists.
export const counter = (mine, theirs) => (mine.vs && theirs && mine.vs[theirs.role]) || 1;
// Roles the AI shops by. Asking for "the best unit" and getting the single highest scalar is how
// five of the twenty units in this table stopped being buildable; asking per role fixes it.
export const ROLES = ['melee', 'anticav', 'mounted', 'ranged', 'siege', 'recon'];
export const NAVAL_ROLES = ['naval', 'naval_ranged'];

// ------------------------------------------------------------------ buildings
// y = flat yield added to the city. def = added city defence strength.
// district:true costs more, needs a free ring tile, and pays +1 of `adj.y` per neighbouring
// tile whose biome is in adj.b — that is the whole district system, no separate subsystem.
export const BUILDINGS = {
  monument:   { cost: 32,  y: [0, 0, 0, 0, 2], name: 'Monument' },
  granary:    { cost: 42,  y: [2, 0, 0, 0, 0], tech: 'pottery', name: 'Granary' },
  walls:      { cost: 46,  y: [0, 0, 0, 0, 1], def: 8, tech: 'masonry', name: 'Walls' },
  barracks:   { cost: 50,  y: [0, 1, 0, 0, 0], def: 3, tech: 'bronze_working', xp: 3, name: 'Barracks' },
  library:    { cost: 56,  y: [0, 0, 0, 3, 0], tech: 'writing', name: 'Library' },
  harbor:     { cost: 60,  y: [1, 0, 2, 0, 0], tech: 'sailing', coastal: true, district: true,
                adj: { b: ['coast', 'ocean'], y: [0, 0, 1, 0, 0] }, name: 'Harbour' },
  market:     { cost: 64,  y: [0, 0, 4, 0, 0], tech: 'currency', name: 'Market' },
  temple:     { cost: 66,  y: [0, 0, 0, 1, 3], tech: 'philosophy', name: 'Temple' },
  encampment: { cost: 70,  y: [0, 2, 0, 0, 0], tech: 'construction', def: 5, district: true,
                adj: { b: ['hills', 'mountain'], y: [0, 1, 0, 0, 0] }, name: 'Encampment' },
  aqueduct:   { cost: 78,  y: [3, 0, 0, 0, 0], tech: 'construction', name: 'Aqueduct' },
  workshop:   { cost: 92,  y: [0, 3, 0, 0, 0], tech: 'engineering', name: 'Workshop' },
  campus:     { cost: 96,  y: [0, 0, 0, 3, 0], tech: 'education', district: true,
                adj: { b: ['mountain', 'jungle'], y: [0, 0, 0, 1, 0] }, name: 'Campus' },
  university: { cost: 108, y: [0, 0, 0, 5, 1], tech: 'education', needs: 'library', name: 'University' },
  bank:       { cost: 116, y: [0, 0, 6, 0, 0], tech: 'banking', needs: 'market', name: 'Bank' },
  observatory:{ cost: 120, y: [0, 0, 0, 4, 1], tech: 'astronomy', name: 'Observatory' },
  press:      { cost: 124, y: [0, 0, 0, 3, 3], tech: 'printing', name: 'Printing Press' },
  sewer:      { cost: 128, y: [4, 0, 0, 0, 0], tech: 'sanitation', needs: 'aqueduct', name: 'Sewer' },
  stock:      { cost: 140, y: [0, 0, 8, 1, 0], tech: 'economics', needs: 'bank', name: 'Exchange' },
  factory:    { cost: 156, y: [0, 6, 0, 0, 0], tech: 'industrialization', needs: 'workshop', name: 'Factory' },
  rail_yard:  { cost: 172, y: [0, 4, 3, 0, 0], tech: 'railroad', needs: 'factory', name: 'Rail Yard' },
};

// --------------------------------------------------------------------- techs
// 32 techs, 4 eras, strict prerequisites. Unlocks are derived below from the unit/building
// tables so a new unit never needs a second edit here.
export const TECHS = {
  agriculture:      { era: 0, cost: 22,  pre: [] },
  pottery:          { era: 0, cost: 30,  pre: ['agriculture'] },
  animal_husbandry: { era: 0, cost: 32,  pre: ['agriculture'] },
  mining:           { era: 0, cost: 34,  pre: ['agriculture'] },
  archery:          { era: 0, cost: 38,  pre: ['animal_husbandry'] },
  sailing:          { era: 0, cost: 40,  pre: ['pottery'] },
  writing:          { era: 0, cost: 44,  pre: ['pottery'] },
  masonry:          { era: 0, cost: 46,  pre: ['mining'] },
  bronze_working:   { era: 0, cost: 50,  pre: ['mining'] },
  the_wheel:        { era: 0, cost: 54,  pre: ['animal_husbandry'] },

  irrigation:       { era: 1, cost: 104,  pre: ['pottery', 'masonry'] },
  horseback_riding: { era: 1, cost: 112,  pre: ['the_wheel', 'archery'] },
  iron_working:     { era: 1, cost: 120,  pre: ['bronze_working'] },
  currency:         { era: 1, cost: 127,  pre: ['writing', 'the_wheel'] },
  mathematics:      { era: 1, cost: 138, pre: ['writing', 'masonry'] },
  philosophy:       { era: 1, cost: 148, pre: ['writing'] },
  construction:     { era: 1, cost: 159, pre: ['masonry', 'irrigation'] },
  chivalry:         { era: 1, cost: 172, pre: ['horseback_riding', 'iron_working'] },

  engineering:      { era: 2, cost: 304, pre: ['construction', 'mathematics'] },
  feudalism:        { era: 2, cost: 328, pre: ['chivalry'] },
  astronomy:        { era: 2, cost: 352, pre: ['philosophy', 'sailing'] },
  education:        { era: 2, cost: 384, pre: ['philosophy', 'currency'] },
  machinery:        { era: 2, cost: 416, pre: ['engineering', 'iron_working'] },
  banking:          { era: 2, cost: 448, pre: ['currency', 'education'] },
  guilds:           { era: 2, cost: 480, pre: ['feudalism', 'banking'] },
  printing:         { era: 2, cost: 512, pre: ['education', 'machinery'] },

  gunpowder:        { era: 3, cost: 798, pre: ['machinery', 'guilds'] },
  metallurgy:       { era: 3, cost: 855, pre: ['gunpowder'] },
  economics:        { era: 3, cost: 912, pre: ['banking', 'printing'] },
  sanitation:       { era: 3, cost: 969, pre: ['economics', 'astronomy'] },
  industrialization:{ era: 3, cost: 1064, pre: ['metallurgy', 'economics'] },
  railroad:         { era: 3, cost: 1178, pre: ['industrialization', 'sanitation'] },
};

export const TECH_LIST = Object.keys(TECHS);
export const TECH_UNLOCKS = {};   // tech -> [{kind, key, name}]
for (const [key, u] of Object.entries(UNITS)) if (u.tech) (TECH_UNLOCKS[u.tech] ??= []).push({ kind: 'unit', key, name: u.name });
for (const [key, b] of Object.entries(BUILDINGS)) if (b.tech) (TECH_UNLOCKS[b.tech] ??= []).push({ kind: 'building', key, name: b.name });

export const techName = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// --------------------------------------------------------------------- civs
export const CIVS = [
  { name: 'Aeon',    adj: 'Aeonian',  color: 0x4fa8ff, cities: ['Aurelia', 'Vantis', 'Solmere', 'Iridon', 'Calyx', 'Thennos', 'Oriel', 'Vale'] },
  { name: 'Korrath', adj: 'Korrathi', color: 0xe0524a, cities: ['Kor Ashan', 'Drennik', 'Hollowmark', 'Skarn', 'Ravath', 'Tulmek', 'Vosk', 'Grenn'] },
  { name: 'Meridia', adj: 'Meridian', color: 0xf2c14a, cities: ['Meris', 'Oralen', 'Sunhold', 'Talvara', 'Cirene', 'Anthem', 'Lorne', 'Pella'] },
  { name: 'Vellum',  adj: 'Vellumite',color: 0x7ad6a0, cities: ['Vellumar', 'Quirren', 'Ashfold', 'Nemet', 'Brackwater', 'Suun', 'Idris', 'Cael'] },
];

// City growth curve and border cost — both deliberately shallow so a 100-turn game moves.
export const foodToGrow = pop => Math.round(14 + 9 * Math.pow(pop, 1.35));
export const cultureToExpand = claimed => Math.round(16 + 12 * Math.pow(claimed, 1.15));
export const cityMaxHp = pop => 100 + 8 * pop;

// --------------------------------------------------------------- war and peace
// ------------------------------------------------------------------- upkeep
// Gold has to leave the treasury as fast as it arrives or it compounds into a five-digit number
// with nothing to buy. Units cost wages, buildings cost maintenance, and both scale with what
// you own — so an empire's ceiling is its economy, not its hammer count.
export const FREE_UNITS = 4;
// Wages scale with what the unit is: a rifleman is not a warrior with a better gun, it is a
// standing professional army. cost/100 puts a warrior at 0.3/turn and an ironclad at 1.76.
export const wage = def => def.cost / 100;
export const BUILDING_UPKEEP = 0.35;
export const BUY_RATE = 4;       // gold per missing hammer when rushing a build
export const WEALTH_RATE = 0.5;  // a city selling its hammers gets half a gold for each one
// Re-equipping a veteran: a flat fee plus three gold per hammer of the difference. Cheaper than
// building the new unit outright, which is the point — you keep the promotions.
export const upgradeFee = (from, to) => 20 + 3 * Math.max(0, to.cost - from.cost);
// An empire cannot hoard past what its cities can actually guard and administer. Everything above
// the ceiling rots away each turn. This is a backstop, not the economy: maintenance, rush-buying
// and upgrades are what keep a played-out empire near it, and it only ever bites a runaway.
export const goldCeiling = cities => 600 + 300 * cities;

export const PEACE_TURNS = 12;   // turns without a blow before a war lapses back into peace
export const TRUCE_TURNS = 16;   // and how long that peace is binding before anyone may redeclare
export const FORT_DEF = 0.25;    // a field fortification, dug by a unit that spends a whole turn

// ------------------------------------------------------------------- victory
// Three ways to end a match. The thresholds are set from the 300-turn sim: a focused civ reaches
// one around turn 250-350, a distracted one never does.
export const FAITH_RATE = 0.5;      // faith accrues at half the culture rate
export const CULTURE_WIN = 7000;    // lifetime culture + faith, roughly a science pace
export const scienceWin = techs => techs >= TECH_LIST.length;
