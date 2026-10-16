// Fire and evacuation simulation on an OPTEsc site JSON. Pure module: runs in the page,
// in a Web Worker (simworker.js) and in Node (tests, batch runs). docs/simulation-method.md
// gives the method, its sources and its limits.
//
// Fire and smoke (fireModel 'zone', the default): a two-zone model of every room (firemodel.js)
// with the C/VM2 design fire, detection, sprinklers, and ISO 13571 doses for each person.
// The older 'grid' model (fire and smoke fronts at set speeds) is kept for comparison only.
// Warning and reaction (C/VM2 3.2): the alarm sounds when a detector or sprinkler responds,
// occupants are told 30 s later, then start after the pre-travel time for the building use
// (C/VM2 Table 3.3, in or away from the room of origin), varied person to person (lognormal).
// Anyone whose own room fills with smoke below head height goes at once.
// Movement: speed falls with crowd density as in the SFPE handbook, S = k (1 - a D) (k 1.4,
// a 0.266, C/VM2 eq. 3.2), and with smoke (Jin's irritant-smoke data); a door lets through
// 1.32 people per second per metre of effective width (its width less 0.15 m each side, C/VM2
// eq. 3.4 at 1.9 people/m2), at most 50 a minute through a self-closing leaf (C/VM2 3.2.5).
// Route choice: people familiar with the building take the nearest exit; where the public
// does not know the building, half head for the main entrance (C/VM2 3.2.7) unless a voice
// alarm directs them, and anyone turns back to the nearest exit when their way is blocked
// or smoke reaches them.
// Furniture, machines and stairs read from the drawing are obstacles people walk around;
// fire and smoke still cross them (furniture burns, smoke passes over it). When the stairs
// lead down to an exit (an upper floor), reaching a flight counts as leaving the floor.
// People differ (PROFILES): older people and people with a walking aid or a wheelchair are
// slower, react later and take more room in a crowd and at doors. Wheelchair users cannot
// take the stairs or pass doors narrower than 0.75 m; when only the stairs lead out they
// wait for help at the stair landing.
// Earthquake (scenario 'earthquake', see quake.js): no fire; walls, door frames and tall
// furniture fail during the shaking and the aftershock. Most people drop, take cover and hold
// on until the shaking stops, then leave; some run at once and walk while the floor moves.
// Anyone under falling rubble is likely to be injured (less so under a table). Rubble slows
// walkers and stops walking frames and wheelchairs; a jammed door stops everyone; a fallen
// outer wall is a way out for those who can climb the rubble.

import { objectCells } from './objects.js';
import { quakeDamage, shakeAt, casualtyRates } from './quake.js';
import { roomNetwork, zoneFire, conditions, fedStep, roomASET, FIRE_DEFAULTS, TENABILITY } from './firemodel.js';

export const SIM_DEFAULTS = {
  dt: 0.2, // seconds per step
  maxTime: 900, // stop after this many seconds
  fireSpeed: 0.05, // m/s the flames spread over the floor (0.02 slow, 0.05 medium, 0.1 fast)
  fireDoorDelay: 180, // s a closed door holds the fire back
  smokeSpeed: 0.5, // m/s the smoke front travels under the ceiling
  smokeDoorDelay: 15, // s a door holds the smoke back
  smokeFill: 6, // s per metre of room size (square root of area) to fill a room with smoke
  doseTime: 90, // s in thick smoke before someone is overcome
  doorFlow: 1.3, // people per second per metre of door width
  speed: [0.8, 1.6, 1.2, 0.2], // adults' free walking speed: range, then mean and spread (m/s)
  hrrpua: FIRE_DEFAULTS.hrrpua,
  preMove: [10, 60], // s before people react (in the room on fire: a third of that)
  navEvery: 2, // s between route updates
  frameEvery: 0.5, // s between recorded frames
  seed: 1,
  density: null, // people per m2 by room type, overrides DENSITY
  mix: null, // share of each profile, e.g. MIXES.public; null: everyone an adult
  stairsOut: false, // the stairs lead down to an exit (this floor is above the ground floor)
  scenario: 'fire', // or 'earthquake'
  quakeLevel: 'strong', // QUAKE_LEVELS in quake.js
  building: 'C1L', // HAZUS building type (quake.js BUILDINGS)
  design: 'low', // seismic design level: 'pre', 'low', 'moderate', 'high'
  exposure: { sheltered: 0.3, running: 2 }, // relative injury risk away from falling elements (assumed, see below)
  coverShare: 0.65, // share of walkers who take cover until the shaking stops; the rest run
  wallHeight: 2.6, // m, for how far falling walls reach
  fireModel: 'zone', // 'zone' (two-zone, firemodel.js) or 'grid' (legacy fronts)
  use: 'office', // OCCUPANCY: what the building is used for (pre-travel times, familiarity)
  alarm: 'standard', // 'standard' (bells, sirens) or 'voice' (spoken messages)
  growth: 'fast', // design fire growth (firemodel.js FIRE_GROWTH)
  detection: 'smoke', // 'smoke', 'heat' or 'none'
  sprinklers: 'none', // 'none', 'quick' or 'standard'
  interiorDoors: 'open', // 'open' or 'closed'
  ceiling: 3.0, // m
  notification: 30, // s from the alarm to warning the occupants (C/VM2 3.2.2)
  preSpread: 0.3, // lognormal sigma of each person's pre-travel time around the C/VM2 value
  people: null, // { zoneId: count } overrides the density
  total: null, // everyone in the building, shared out by the density
};

// Who the occupants are. Speeds on the level in m/s; pre: reaction time multiplier; space:
// room taken in a crowd and at a door, in adults. Adults: SIM_DEFAULTS.speed. Walking aids
// and wheelchairs: Boyce, Shields & Silcock (1999), Fire Technology 35(1), measured means of
// 0.81 m/s with a stick, 0.94 with crutches, 0.57 with a walking frame, 0.69 in a manual and
// 0.89 in an electric wheelchair. Older adults: slower comfortable gait than younger adults
// (Bohannon 1997, Age and Ageing 26(1)) and slower to start moving.
export const PROFILES = {
  adult: { label: 'Adults', speed: null, pre: 1, space: 1, stairs: true, rubble: true },
  older: { label: 'Older people', speed: [0.8, 1.2], pre: 1.3, space: 1, stairs: true, rubble: true },
  aid: { label: 'People with a walking aid', speed: [0.5, 0.95], pre: 1.5, space: 1.5, stairs: true, rubble: false },
  wheelchair: { label: 'Wheelchair users', speed: [0.6, 0.9], pre: 1.5, space: 2.5, stairs: false, rubble: false, minDoor: 0.75 },
};
// Typical mixes: a working site, a building open to the public, a care home or hospital ward.
export const MIXES = {
  workforce: { adult: 0.93, older: 0.03, aid: 0.03, wheelchair: 0.01 },
  public: { adult: 0.72, older: 0.16, aid: 0.07, wheelchair: 0.05 },
  care: { adult: 0.25, older: 0.3, aid: 0.3, wheelchair: 0.15 },
};

// Pre-travel activity times in seconds (NZ Verification Method C/VM2, Table 3.3): in the room
// of origin and away from it; with a voice alarm where the table gives one. familiar: the
// occupants know the building (they take the nearest exit; others head for the main entrance).
export const OCCUPANCY = {
  office: { label: 'Offices, factories, warehouses', origin: 30, remote: 60, familiar: true },
  retail: { label: 'Shops, restaurants, exhibitions', origin: 60, remote: 120, voice: [30, 60], familiar: false },
  hotel: { label: 'Hotels (guests asleep)', origin: 60, remote: 600, voice: [60, 300], familiar: false },
  apartment: { label: 'Apartments (people asleep)', origin: 60, remote: 300, familiar: true },
  clinic: { label: 'Clinics, day care', origin: 60, remote: 120, familiar: false },
  care: { label: 'Hospitals, care homes', origin: 180, remote: 1800, familiar: false },
};

// People per m2 by room type. Factory figures from typical staffing (one person per 20 to
// 50 m2 of production floor); offices and canteens from occupant load tables (NFPA 101 7.3.1.2
// gives 9.3 m2 per person for offices and 1.4 for dining; these are lower, for a normal shift).
export const DENSITY = {
  production: 1 / 25, storage: 1 / 100, office: 1 / 10, loading_bay: 1 / 50, corridor: 0,
  welfare: 1 / 5, bedroom: 1 / 8, living: 1 / 12, kitchen: 1 / 12, bathroom: 0, circulation: 0,
  outdoor: 0, technical: 0, unknown: 1 / 30,
};

const K = { OUTSIDE: 0, FLOOR: 1, WALL: 2, DOOR: 3, EXIT: 4, WINDOW: 5, OBSTACLE: 6, STAIR: 7 };
const KIND_OF = { o: 0, '.': 1, '#': 2, D: 3, E: 4, W: 5 };
export const STATE = { WAITING: 0, MOVING: 1, OUT: 2, OVERCOME: 3, TRAPPED: 4, ASSIST: 5, INJURED: 6, KILLED: 7 };

// Someone a falling wall panel or a toppling piece of furniture lands on: shares of severity 1
// to 4 (treated and released, hospital, life-threatening, dead). Assumed: HAZUS gives rates for
// the whole building, not for each falling element. Cover under a sturdy table shifts them to
// the lighter end. Impact comes when the element reaches the floor (quakeview.js draws the fall).
export const HIT_SEVERITY = {
  wall: [0.2, 0.3, 0.25, 0.25],
  topple: [0.55, 0.3, 0.1, 0.05],
  sheltered: [0.6, 0.3, 0.08, 0.02],
};
const IMPACT_S = { wall: 1.0, topple: 0.8 };

// The grid, zones and doors of a site in the form the simulation uses.
export function prepare(site, opts = {}) {
  const g = site.grid;
  const w = g.w, h = g.h, c = g.cell_m;
  const kind = new Uint8Array(w * h), zone = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = g.cells[y], zr = g.zone_ids[y];
    for (let x = 0; x < w; x++) { kind[y * w + x] = KIND_OF[row[x]] ?? 0; zone[y * w + x] = zr[x]; }
  }
  const allowed = Array.isArray(site.evacuationExitIds) ? new Set(site.evacuationExitIds) : null;
  const doorOf = new Int32Array(w * h).fill(-1);
  const doors = (site.doors || []).map((d, k) => {
    for (const [x, y] of d.cells || []) doorOf[y * w + x] = k;
    return { id: d.id, width: Math.max(0.5, d.width_m || 0.9), exit: !!d.is_exit && (!allowed || allowed.has(d.id)), x: d.x, y: d.y, connects: d.connects || [], leaf: !!d.swing };
  });
  if (allowed) for (let i = 0; i < kind.length; i++) {
    if (kind[i] === K.EXIT && !doors[doorOf[i]]?.exit) kind[i] = K.DOOR;
  }
  // furniture and stair footprints: floor people cannot stand on (doorways stay open)
  for (const o of site.objects || []) {
    if (o.kind === 'ramp' || (o.kind === 'object' && (o.height_m ?? 1) < 0.3)) continue;
    const to = o.kind === 'stair' && opts.stairsOut ? K.STAIR : K.OBSTACLE;
    for (const i of objectCells(g, o)) if (kind[i] === K.FLOOR) kind[i] = to;
  }
  const zones = site.zones.map((z) => ({ ...z, k: Number(z.id.slice(1)) }));
  const zoneByK = new Map(zones.map((z) => [z.k, z]));
  return { w, h, c, kind, zone, doorOf, doors, zones, zoneByK, openings: site.openings || [] };
}

const walkable = (k) => k === K.FLOOR || k === K.DOOR || k === K.EXIT;
// fire and smoke also cross furniture
const open = (k) => walkable(k) || k === K.OBSTACLE || k === K.STAIR;

// Nearest walkable cell to a point in metres (rings outwards, up to 3 m).
export function nearestWalkable(g, x, y) {
  const cx = Math.floor(x / g.c), cy = Math.floor(y / g.c);
  const R = Math.ceil(3 / g.c);
  for (let r = 0; r <= R; r++) {
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const i = ny * g.w + nx;
      if (g.kind[i] !== K.FLOOR) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// Where the fire starts: a zone id ("Z3", its middle), a point [x, y] in metres, or a cell index.
export function fireCell(g, at) {
  if (typeof at === 'number') return at;
  if (Array.isArray(at)) return nearestWalkable(g, at[0], at[1]);
  const z = g.zones.find((q) => q.id === at);
  if (!z) throw new Error(`No zone ${at}`);
  let i = nearestWalkable(g, z.centroid[0], z.centroid[1]);
  if (i >= 0 && g.zone[i] === z.k) return i;
  // centroid outside its own room (an L-shaped room): the room cell closest to it
  let bd = Infinity;
  for (let j = 0; j < g.w * g.h; j++) {
    if (g.zone[j] !== z.k || g.kind[j] !== K.FLOOR) continue;
    const dx = ((j % g.w) + 0.5) * g.c - z.centroid[0], dy = (((j / g.w) | 0) + 0.5) * g.c - z.centroid[1];
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; i = j; }
  }
  return i;
}

// Arrival time of something spreading over walkable cells from `start` at `speed` m/s,
// held for `doorDelay` s when it crosses into a door (exit doors too).
function spreadTimes(g, start, speed, doorDelay) {
  const { w, h, c, kind, doorOf } = g;
  const t = new Float64Array(w * h).fill(Infinity);
  const heap = new MinHeap();
  t[start] = 0; heap.push(0, start);
  const step = c / speed, diag = step * Math.SQRT2;
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > t[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!open(kind[j])) continue;
      if (dx && dy && (!open(kind[y * w + nx]) || !open(kind[ny * w + x]))) continue;
      let nd = d + (dx && dy ? diag : step);
      if (doorOf[j] >= 0 && doorOf[i] !== doorOf[j]) nd += doorDelay;
      if (nd < t[j]) { t[j] = nd; heap.push(nd, j); }
    }
  }
  return Float32Array.from(t);
}

// Fire and smoke: the two-zone model of each room, or the legacy grid fronts.
export function hazard(g, start, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  if (o.fireModel !== 'grid') return zoneHazard(g, start, o);
  const fireT = spreadTimes(g, start, o.fireSpeed, o.fireDoorDelay);
  const smokeT = spreadTimes(g, start, o.smokeSpeed, o.smokeDoorDelay);
  // time for a room to fill: grows with the room's size; cells outside rooms (doors) fill fast
  const tau = new Float32Array(g.w * g.h);
  const tauOf = new Map(g.zones.map((z) => [z.k, Math.min(300, Math.max(15, Math.sqrt(z.area_m2 || z.grid_area_m2 || 20) * o.smokeFill))]));
  for (let i = 0; i < tau.length; i++) tau[i] = tauOf.get(g.zone[i]) ?? 20;
  return { start, fireT, smokeT, tau };
}

// The zone model's hazard on the grid: which room each cell belongs to, and where the flames
// are (the fire area, 250 kW/m2, grows round the start point; at flashover the whole room).
function zoneHazard(g, start, o) {
  const { w, h, c } = g;
  const site = { zones: g.zones, doors: g.doors.map((d) => ({ id: d.id, width_m: d.width, connects: d.connects, swing: d.leaf })), openings: g.openings };
  const net = roomNetwork(site, o);
  const roomOf = new Int32Array(w * h).fill(-1);
  const idx = new Map(g.zones.map((z, k) => [z.k, k]));
  for (let i = 0; i < w * h; i++) {
    if (g.zone[i] > 0) roomOf[i] = idx.get(g.zone[i]) ?? -1;
    else if (g.doorOf[i] >= 0) {
      const inner = g.doors[g.doorOf[i]].connects.find((z) => z !== 'outside');
      roomOf[i] = inner ? net.index.get(inner) ?? -1 : -1;
    }
  }
  const origin = roomOf[start];
  const z = zoneFire(net, Math.max(0, origin), o);
  // flames: a disc growing with the heat release rate, on the floor of the room of origin
  const fireT = new Float32Array(w * h).fill(Infinity);
  const sx = (start % w) + 0.5, sy = ((start / w) | 0) + 0.5;
  const radius = new Float32Array(z.t);
  for (let s = 0; s < z.t; s++) radius[s] = Math.sqrt(z.Q[s] / o.hrrpua / Math.PI);
  for (let i = 0; i < w * h; i++) {
    if (roomOf[i] !== origin || !open(g.kind[i])) continue;
    const d = Math.hypot((i % w) + 0.5 - sx, ((i / w) | 0) + 0.5 - sy) * c;
    let s = 0;
    while (s < z.t && radius[s] < d) s++;
    let ft = s < z.t ? s : Infinity;
    if (z.flashoverAt != null) ft = Math.min(ft, z.flashoverAt);
    fireT[i] = ft;
  }
  // smoke level per room and second, looked up for every cell when routes are worked out
  const smokeLvl = new Float32Array(net.rooms.length * z.t);
  for (let k = 0; k < net.rooms.length; k++) for (let s = 0; s < z.t; s++) {
    const cnd = conditions(z, k, s);
    smokeLvl[k * z.t + s] = cnd.inLayer ? Math.min(1, cnd.extinction / 1.2) : 0;
  }
  // how far from the fire people keep: the flames, plus the distance at which their radiation
  // (a point source carrying the radiative fraction of the heat release) falls to 2.5 kW/m2
  const keepOut = new Float32Array(z.t);
  for (let s = 0; s < z.t; s++) keepOut[s] = radius[s] + Math.sqrt((o.chiRad ?? 0.35) * z.Q[s] / (4 * Math.PI * TENABILITY.radiant));
  const fireDist = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) if (roomOf[i] === origin) fireDist[i] = Math.hypot((i % w) + 0.5 - sx, ((i / w) | 0) + 0.5 - sy) * c;
  return { kind: 'zone', start, fireT, roomOf, zone: z, net, aset: roomASET(z, net), smokeLvl, keepOut, fireDist };
}

// Smoke thickness 0 (clear) to 1 (cannot see a hand) in cell i at time t.
export function smokeAt(hz, i, t) {
  if (hz.kind === 'zone') {
    const k = hz.roomOf[i];
    if (k < 0) return 0;
    const n = hz.zone.t;
    return hz.smokeLvl[k * n + Math.max(0, Math.min(n - 1, Math.floor(t)))];
  }
  if (!hz.smokeT) return 0;
  const a = t - hz.smokeT[i];
  return a <= 0 ? 0 : 1 - Math.exp(-a / hz.tau[i]);
}
export const fireAt = (hz, i, t) => hz.fireT[i] <= t;
// Conditions at 2 m in the room of cell i (zone model only).
export const roomAt = (hz, i, t) => (hz.kind === 'zone' && hz.roomOf[i] >= 0 ? conditions(hz.zone, hz.roomOf[i], t) : null);

// Seeded random numbers (mulberry32) so a run can be repeated exactly.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Who is in the building and where they stand when the alarm goes.
export function placePeople(g, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  const dens = { ...DENSITY, ...(o.density || {}) };
  const rand = rng(o.seed * 7919 + 13);
  const cells = new Map();
  for (let i = 0; i < g.w * g.h; i++) {
    if (g.kind[i] !== K.FLOOR || g.zone[i] <= 0) continue;
    if (!cells.has(g.zone[i])) cells.set(g.zone[i], []);
    cells.get(g.zone[i]).push(i);
  }
  const expect = (z) => (z.area_m2 || cells.get(z.k).length * g.c * g.c) * (dens[z.type] ?? dens.unknown);
  const live = g.zones.filter((z) => cells.get(z.k)?.length);
  // a set total is shared out by the same densities (largest remainders)
  let share = null;
  if (o.total != null) {
    let e = live.map(expect);
    if (!e.some((v) => v > 0)) e = live.map((z) => cells.get(z.k).length);
    const sum = e.reduce((a, b) => a + b, 0) || 1;
    const q = e.map((v) => (v * o.total) / sum);
    const n = q.map(Math.floor);
    let left = o.total - n.reduce((a, b) => a + b, 0);
    q.map((v, i) => [v - n[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { n[i]++; left--; } });
    share = new Map(live.map((z, i) => [z.id, n[i]]));
  }
  const people = [];
  for (const z of live) {
    const list = cells.get(z.k);
    let n = o.people?.[z.id] ?? share?.get(z.id);
    if (n == null) {
      const e = expect(z);
      n = Math.floor(e) + (rand() < e % 1 ? 1 : 0);
    }
    for (let k = 0; k < n; k++) {
      // keep away from walls when the room allows: pick the cell with the most floor around it of a few tries
      let best = list[(rand() * list.length) | 0], bestFree = -1;
      for (let tries = 0; tries < 4; tries++) {
        const i = list[(rand() * list.length) | 0];
        const free = freeAround(g, i);
        if (free > bestFree) { best = i; bestFree = free; }
      }
      const x = (best % g.w + rand()) * g.c, y = (((best / g.w) | 0) + rand()) * g.c;
      people.push({ zone: z.id, x, y, profile: 'adult', speed: freeSpeed(o.speed, rand), pre: o.preMove[0] + rand() * (o.preMove[1] - o.preMove[0]), preMul: 1, lnPre: normal(rand) });
    }
  }
  if (o.mix) assignProfiles(people, o.mix, o.seed);
  return people;
}

// Adults' free walking speed: a normal distribution cut to its range ([min, max, mean, sd]), or
// uniform over [min, max]. Design speed in C/VM2 is 1.2 m/s.
function freeSpeed(sp, rand) {
  if (sp.length < 4) return sp[0] + rand() * (sp[1] - sp[0]);
  for (let k = 0; k < 20; k++) { const v = sp[2] + sp[3] * normal(rand); if (v >= sp[0] && v <= sp[1]) return v; }
  return sp[2];
}
function normal(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Give each person a profile: exact shares of the total (largest remainders), spread at random
// over the building. A separate random stream, so the places people stand do not change.
export function assignProfiles(people, mix, seed = 1) {
  const rand = rng(seed * 104729 + 7);
  const names = Object.keys(PROFILES).filter((p) => mix[p] > 0);
  const sum = names.reduce((t, p) => t + mix[p], 0) || 1;
  const q = names.map((p) => (mix[p] / sum) * people.length);
  const n = q.map(Math.floor);
  let left = people.length - n.reduce((a, b) => a + b, 0);
  q.map((v, i) => [v - n[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { n[i]++; left--; } });
  const order = people.map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) { const j = (rand() * (k + 1)) | 0; [order[k], order[j]] = [order[j], order[k]]; }
  let at = 0;
  names.forEach((name, i) => {
    const pr = PROFILES[name];
    for (let c = 0; c < n[i]; c++) {
      const p = people[order[at++]];
      p.profile = name;
      if (pr.speed) p.speed = pr.speed[0] + rand() * (pr.speed[1] - pr.speed[0]);
      p.pre *= pr.pre;
      p.preMul = pr.pre;
    }
  });
  return people;
}
function freeAround(g, i) {
  const x = i % g.w, y = (i / g.w) | 0, r = Math.max(1, Math.round(0.3 / g.c));
  let n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && g.kind[ny * g.w + nx] === K.FLOOR) n++;
  }
  return n;
}

// Seconds to walk out from every cell at time t, steering around fire and smoke.
// isTarget(i): where the way out ends; passable(i): cells this kind of person can use.
// need: when given (a Uint8Array marking cells, and their count), the search stops once every
// marked cell is settled. It runs outwards from the exits, so every cell nearer an exit than a
// marked one is settled too: people walking downhill towards an exit only ever read final values.
// maxSmoke: cells with at least this much smoke count as closed (projected guidance).
export function routeField(g, hz, t, field, isTarget = (i) => g.kind[i] === K.EXIT, passable = (i) => walkable(g.kind[i]), need = null, maxSmoke = Infinity) {
  const { w, h, c } = g, n = w * h;
  let left = need ? need.count : -1;
  field.fill(Infinity);
  const heap = new MinHeap();
  // worked out once per cell, not once per neighbour: open cells, and the cost per metre
  // (slower in smoke, and people turn away from smoke they can see)
  const ok = new Uint8Array(n), cost = new Float64Array(n);
  // close to the fire (zone model): its radiant heat is painful (over 2.5 kW/m2), so people go
  // round it where they can and pass it only when there is no other way; worked out a little
  // ahead, as the fire grows while they walk
  const near = hz.keepOut ? hz.keepOut[Math.max(0, Math.min(hz.keepOut.length - 1, Math.floor(t + 10)))] : -1;
  for (let i = 0; i < n; i++) if (passable(i) && hz.fireT[i] > t + 2 && !(smokeAt(hz, i, t) >= maxSmoke)) {
    ok[i] = 1; cost[i] = 1 + 4 * smokeAt(hz, i, t);
    if (hz.fireDist && hz.fireDist[i] < near) cost[i] *= 20;
    if (hz.rubbleT && hz.rubbleT[i] <= t) cost[i] *= 3; // climbing over rubble
  }
  for (let i = 0; i < n; i++) if (ok[i] && isTarget(i)) { field[i] = 0; heap.push(0, i); }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > field[i]) continue;
    if (need && need.mark[i]) { need.mark[i] = 0; if (--left <= 0) return true; }
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!ok[j]) continue;
      if (dx && dy && (!ok[y * w + nx] || !ok[ny * w + x])) continue;
      const nd = d + (dx && dy ? Math.SQRT2 : 1) * c * 0.5 * (cost[i] + cost[j]);
      if (nd < field[j]) { field[j] = nd; heap.push(nd, j); }
    }
  }
  return false;
}

// SFPE walking speed share at a crowd density of rho people per m2: S = k (1 - a D), k 1.4,
// a 0.266 (C/VM2 eq. 3.2), relative to the 1.2 m/s cap it reaches at 0.54 people/m2; people
// stop at about 3.8 people/m2.
export const sfpe = (rho) => (rho <= 0.54 ? 1 : Math.max(0.05, (1 - 0.266 * rho) / (1 - 0.266 * 0.54)));

// Weidmann (1993) walking speed share at a crowd density of rho people per m2.
export const weidmann = (rho) => (rho <= 0.3 ? 1 : Math.max(0.1, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4))));

// Run one fire or earthquake. Returns the people, recorded frames, the hazard and the results.
export function simulate(site, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  // long pre-travel times (hotels, care homes) need a longer run
  if (opts.maxTime == null) o.maxTime = Math.max(o.maxTime, (OCCUPANCY[o.use]?.remote ?? 0) + 600);
  const g = site.w ? site : prepare(site, o);
  const { w, h, c } = g;
  const quake = o.scenario === 'earthquake';
  let start = -1, hz, dmg = null;
  if (quake) {
    dmg = quakeDamage(g, site.objects || [], { level: o.quakeLevel, building: o.building, design: o.design, seed: o.seed, wallHeight: o.wallHeight });
    const never = () => new Float32Array(w * h).fill(Infinity);
    hz = { start: -1, fireT: never(), smokeT: never(), tau: new Float32Array(w * h).fill(20), rubbleT: dmg.rubbleT, blockT: dmg.blockT };
  } else if (o.scenario === 'none') {
    // no hazard at all: movement only (verification tests, drills of the walk alone)
    const never = () => new Float32Array(w * h).fill(Infinity);
    hz = { kind: 'none', start: -1, fireT: never(), smokeT: never(), tau: new Float32Array(w * h).fill(20) };
  } else {
    start = fireCell(g, o.fire ?? g.zones[0].id);
    if (start < 0) throw new Error('No floor near the fire start');
    // the fire does not depend on the people: a batch of runs can share it
    hz = o.hazard && o.hazard.start === start ? o.hazard : hazard(g, start, o);
  }
  const people = o.placed || placePeople(g, o);
  const N = people.length;
  const zoneFire = start >= 0 ? g.zone[start] : -1;

  const px = new Float32Array(N), py = new Float32Array(N), state = new Uint8Array(N);
  const dose = new Float32Array(N), outAt = new Float32Array(N).fill(NaN), pre = new Float32Array(N);
  const waited = new Float32Array(N), walked = new Float32Array(N);
  const exitUsed = new Int32Array(N).fill(-1);
  const zoneModel = !quake && hz.kind === 'zone';
  const use = OCCUPANCY[o.use] || OCCUPANCY.office;
  const [preOrigin, preRemote] = o.alarm === 'voice' && use.voice ? use.voice : [use.origin, use.remote];
  // occupants are warned 30 s after the alarm; with no detection, when smoke in the room of
  // origin comes down to head height and someone raises the alarm by hand
  let warned = null;
  if (zoneModel) {
    const z = hz.zone;
    if (z.warned != null) warned = z.warned;
    else { const b = hz.aset[z.origin]?.layerBelow2m; warned = b == null ? Infinity : b + o.notification; }
  }
  people.forEach((p, k) => {
    px[k] = p.x; py[k] = p.y;
    if (zoneModel) {
      // C/VM2 pre-travel time for this building use, varied person to person around it
      const inOrigin = hz.roomOf[cellOf(p.x, p.y)] === hz.zone.origin;
      pre[k] = warned + (inOrigin ? preOrigin : preRemote) * Math.exp(o.preSpread * (p.lnPre ?? 0)) * (p.preMul ?? 1);
    } else {
      // people in the burning room notice at once
      pre[k] = g.zone[cellOf(p.x, p.y)] === zoneFire ? p.pre / 3 : p.pre;
    }
  });
  const fedCO = new Float32Array(N), fedHeat = new Float32Array(N), overLimit = new Uint8Array(N);
  // where each person starts, and the last moment anyone is in each room (escape-route RSET)
  const lastIn = new Float32Array(g.zones.length).fill(-1);
  const zoneIdx = new Map(g.zones.map((z, k) => [z.k, k]));
  // earthquake: who takes cover until the shaking stops (wheelchair users brake and stay),
  // who runs at once; and the floor under and around tables, where cover protects
  const covering = new Uint8Array(N), sheltered = new Uint8Array(w * h);
  if (quake) {
    const qr = rng(o.seed * 6007 + 3);
    people.forEach((p, k) => {
      const pr = PROFILES[p.profile] || PROFILES.adult;
      covering[k] = !pr.stairs || qr() < o.coverShare ? 1 : 0;
      // the alarm is the shaking itself: runners go within seconds, the others once it stops
      pre[k] = covering[k] ? dmg.quake.duration + (5 + 20 * qr()) * pr.pre : 1 + 3 * qr();
    });
    const r = Math.ceil(0.5 / c);
    for (const ob of site.objects || []) if (ob.kind === 'object' && ob.category === 'table') {
      for (const i of objectCells(g, ob)) {
        const x = i % w, y = (i / w) | 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) sheltered[(y + dy) * w + x + dx] = 1;
      }
    }
  }
  const hurt = rng(o.seed * 9173 + 5);
  const injuredBy = new Uint8Array(N); // 1 falling wall, 2 falling furniture, 3 shaking
  // Earthquake casualties (HAZUS indoor casualty rates for the building's damage state): the
  // expected number at each severity is the rate times the number of people inside. Whoever is
  // under a wall or a piece of furniture when it lands is hit (HIT_SEVERITY), wherever they
  // walked to by then. The rest of the HAZUS count, less the hits expected where people stand
  // at the start, falls on the others by exposure: less likely sheltering under a table, more
  // likely for those on the move during the shaking (assumed weights). Severity 1 (treated and
  // released) slows people down; 2 and 3 leave them unable to move; 4 is dead.
  const severity = new Uint8Array(N), hurtAt = new Float32Array(N).fill(Infinity), slowed = new Float32Array(N).fill(1);
  const hitShares = (type, k, i) => (covering[k] && sheltered[i] ? HIT_SEVERITY.sheltered : HIT_SEVERITY[type === 'wall' ? 'wall' : 'topple']);
  const drawSeverity = (shares) => { let u = hurt(); for (let s = 4; s >= 1; s--) { if (u < shares[s - 1]) return s; u -= shares[s - 1]; } return 1; };
  if (quake) {
    const rates = casualtyRates(o.building, dmg.quake.damage, dmg.quake.collapsed);
    const hitAt = new Map(); // cell -> what falls on it first
    for (const ev of dmg.events) if (ev.type !== 'door') for (const i of ev.cells) if (!hitAt.has(i)) hitAt.set(i, ev);
    const expectedHits = [0, 0, 0, 0], others = [];
    people.forEach((p, k) => {
      const i = cellOf(p.x, p.y), ev = hitAt.get(i);
      if (ev) hitShares(ev.type, k, i).forEach((s, j) => { expectedHits[j] += s; });
      else others.push(k);
    });
    const left = rates.map((r, j) => Math.max(0, r * N - expectedHits[j]));
    const wt = others.map((k) => (covering[k] ? (sheltered[cellOf(people[k].x, people[k].y)] ? o.exposure.sheltered : 1) : o.exposure.running));
    const sumW = wt.reduce((a, b) => a + b, 0) || 1;
    others.forEach((k, n) => {
      let u = hurt(), sev = 0;
      for (let s = 4; s >= 1 && !sev; s--) { const ps = Math.min(1, (left[s - 1] * wt[n]) / sumW); if (u < ps) sev = s; else u -= ps; }
      if (!sev) return;
      severity[k] = sev;
      hurtAt[k] = dmg.quake.duration * (0.15 + 0.5 * hurt());
      injuredBy[k] = 3;
    });
  }
  const impacts = []; // walls and furniture on their way down: when they land, and where
  const hits = []; // who they landed on
  function cellOf(x, y) { return Math.min(h - 1, Math.max(0, Math.floor(y / c))) * w + Math.min(w - 1, Math.max(0, Math.floor(x / c))); }

  // door capacity: specific flow over the effective width (C/VM2 eq. 3.4: 1.32 people/s/m at
  // 1.9 people/m2, less 0.15 m each side), at most 50 a minute per self-closing leaf; the
  // legacy grid model keeps its flow over the full width
  const doorTokens = new Float32Array(g.doors.length);
  const doorRate = g.doors.map((d) => {
    if (o.fireModel === 'grid' && !quake) return o.doorFlow * d.width;
    const f = (1 - 0.266 * 1.9) * 1.4 * 1.9 * Math.max(0.2, d.width - 0.3);
    return d.leaf ? Math.min(f, (50 / 60) * (d.width > 1.3 ? 2 : 1)) : f;
  });
  const doorCount = new Int32Array(g.doors.length), doorQueue = new Int32Array(g.doors.length);
  const doorWait = new Float32Array(g.doors.length), doorMaxQ = new Int32Array(g.doors.length);
  const holder = new Int32Array(N).fill(-1); // the door each person is passing through

  // crowd density in 1 m blocks
  const bs = Math.max(1, Math.round(1 / c)), bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
  const crowd = new Float32Array(bw * bh), blockArea = (bs * c) ** 2;

  // who uses which way out. Ways out differ by what a person can get over: stairs (when
  // they lead down), rubble, and doors narrower than a wheelchair. One route field for each
  // different set of abilities in the building; wheelchair users with no step-free way out
  // head for a stair landing to wait for help.
  const prof = people.map((p) => PROFILES[p.profile] || PROFILES.adult);
  const space = Float32Array.from(prof, (p) => p.space);
  const narrow = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (g.doorOf[i] >= 0 && g.doors[g.doorOf[i]].width < PROFILES.wheelchair.minDoor) narrow[i] = 1;
  const isStair = (i) => g.kind[i] === K.STAIR;
  const hasStairs = g.kind.includes(K.STAIR), hasNarrow = narrow.includes(1);
  const hasRubble = !!hz.rubbleT && hz.rubbleT.some(Number.isFinite);
  // (times are stored as 32-bit floats: compare with a small tolerance, or an event that
  // happens now would not count until the next route update)
  const rubbleAt = (i) => hz.rubbleT && hz.rubbleT[i] <= t + 1e-3;
  const shutAt = (i) => hz.blockT && hz.blockT[i] <= t + 1e-3;
  // a fallen outer wall: its rubble next to open ground is a way out
  const breach = new Uint8Array(w * h);
  if (hasRubble) for (let i = 0; i < w * h; i++) {
    if (g.kind[i] !== K.WALL && g.kind[i] !== K.WINDOW) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || g.kind[ny * w + nx] === K.OUTSIDE) { breach[i] = 1; break; }
    }
  }
  const routes = new Map(); // ability key -> route fields
  const routeOf = prof.map((p) => {
    const can = { stairs: p.stairs || !hasStairs, rubble: p.rubble !== false || !hasRubble, wide: !!p.minDoor && hasNarrow };
    const key = `${+can.stairs}${+can.rubble}${+can.wide}`;
    if (!routes.has(key)) {
      const passable = (i) => {
        if (shutAt(i)) return false;
        if (rubbleAt(i)) return can.rubble && g.kind[i] !== K.OUTSIDE;
        return (walkable(g.kind[i]) && !(can.wide && narrow[i])) || (can.stairs && isStair(i));
      };
      const target = (i) => (g.kind[i] === K.EXIT && !(can.wide && narrow[i])) || (can.stairs && isStair(i)) || (can.rubble && breach[i] && rubbleAt(i));
      const landing = (i) => {
        if (!passable(i) || isStair(i)) return false;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && isStair(ny * w + nx)) return true;
        }
        return false;
      };
      routes.set(key, { field: new Float64Array(w * h), passable, target, landingField: !can.stairs && hasStairs ? new Float64Array(w * h) : null, landing, can, primaryField: null });
    }
    return routes.get(key);
  });
  // Route choice. Where the public does not know the building and no voice alarm tells them
  // otherwise, half head for the main entrance (the widest exit), as C/VM2 3.2.7 assumes;
  // they keep to it until it is blocked or smoke reaches them, then take the nearest exit.
  const exitDoors = g.doors.map((d, k) => [d, k]).filter(([d]) => d.exit);
  const primaryDoor = exitDoors.length > 1 ? exitDoors.reduce((a, b) => (b[0].width > a[0].width ? b : a))[1] : -1;
  const toPrimary = new Uint8Array(N);
  if (!quake && primaryDoor >= 0 && !(OCCUPANCY[o.use] || OCCUPANCY.office).familiar && o.alarm !== 'voice') {
    const pr = rng(o.seed * 4421 + 9);
    for (let k = 0; k < N; k++) if (pr() < 0.5) {
      toPrimary[k] = 1;
      const r = routeOf[k];
      r.primaryField ??= new Float64Array(w * h);
    }
  }
  const viaStairs = new Uint8Array(N);
  // the cells of everyone still inside (with their neighbours, for the first step): the route
  // search can stop once these are settled
  const needMark = new Uint8Array(w * h);
  const needFor = (r) => {
    needMark.fill(0);
    let count = 0;
    for (let k = 0; k < N; k++) {
      if (routeOf[k] !== r || (state[k] !== STATE.WAITING && state[k] !== STATE.MOVING)) continue;
      const i = cellOf(px[k], py[k]);
      if (!needMark[i]) { needMark[i] = 1; count++; }
    }
    return count ? { mark: needMark, count } : null;
  };
  // Routes depend on time only through the smoke in each room and the size of the fire: they
  // are worked out again when either has changed enough to matter, or when someone stands
  // outside the part of the building the last (stopped-early) search covered.
  let lastSig = '';
  const signature = () => {
    if (hz.kind !== 'zone') return null;
    const n = hz.zone.t, s0 = Math.max(0, Math.min(n - 1, Math.floor(t)));
    let sig = `${Math.round(hz.keepOut[Math.min(n - 1, Math.floor(t + 10))] * 2)}`;
    for (let k = 0; k < hz.net.rooms.length; k++) sig += `,${Math.round(hz.smokeLvl[k * n + s0] * 20)}`;
    return sig + `|${Math.round(t / 30)}`; // and at least every 30 s
  };
  const navigate = (force = true) => {
    const sig = signature();
    if (!force && sig != null && sig === lastSig) return false;
    lastSig = sig;
    for (const r of routes.values()) {
      // a full search when the stop rule cannot apply (nobody of this kind inside)
      const need = () => needFor(r);
      r.partial = routeField(g, hz, t, r.field, r.target, r.passable, need());
      if (r.landingField) r.partial = routeField(g, hz, t, r.landingField, r.landing, r.passable, need()) || r.partial;
      if (r.primaryField) r.partial = routeField(g, hz, t, r.primaryField, (i) => g.doorOf[i] === primaryDoor && g.kind[i] === K.EXIT && !(r.can.wide && narrow[i]), r.passable, need()) || r.partial;
    }
    return true;
  };
  const events = dmg ? dmg.events : [];
  let nextEvent = 0;
  const frames = [];
  const fPos = [], fState = [];
  let nextNav = 0, nextFrame = 0, t = 0, navAt = -Infinity;
  const navEvery = Math.max(o.navEvery, Math.min(10, (w * h) / 40000));
  const record = () => {
    const pos = new Float32Array(N * 2);
    for (let k = 0; k < N; k++) { pos[2 * k] = px[k]; pos[2 * k + 1] = py[k]; }
    fPos.push(pos); fState.push(state.slice()); frames.push(t);
  };

  let active = N;
  for (; t <= o.maxTime + 1e-9; t += o.dt) {
    t = Math.round(t * 1000) / 1000;
    // walls, frames and shelves that give way now: who is under them, and new routes for all
    let changed = false;
    while (nextEvent < events.length && events[nextEvent].t <= t + 1e-9) {
      const ev = events[nextEvent++];
      changed = true;
      if (ev.type !== 'door') impacts.push({ at: ev.t + (IMPACT_S[ev.type] ?? 1), type: ev.type, id: ev.id, zones: ev.zones, cells: new Set(ev.cells) });
    }
    // what lands now hits everyone still inside under it
    for (let n = impacts.length - 1; n >= 0; n--) {
      const im = impacts[n];
      if (im.at > t + 1e-9) continue;
      impacts.splice(n, 1);
      let hit = 0, dead = 0;
      for (let k = 0; k < N; k++) {
        if (state[k] !== STATE.WAITING && state[k] !== STATE.MOVING && state[k] !== STATE.ASSIST) continue;
        const i = cellOf(px[k], py[k]);
        if (!im.cells.has(i)) continue;
        const sev = drawSeverity(hitShares(im.type, k, i));
        if (sev >= severity[k]) { severity[k] = sev; injuredBy[k] = im.type === 'wall' ? 1 : 2; }
        hurtAt[k] = Math.min(hurtAt[k], t);
        hit++; if (severity[k] === 4) dead++;
      }
      if (hit) hits.push({ t: round1(t), type: im.type, id: im.id, zones: im.zones, people: hit, killed: dead });
    }
    // casualties as they happen (people already outside are spared)
    if (quake) for (let k = 0; k < N; k++) {
      if (!severity[k] || hurtAt[k] > t + 1e-9 || state[k] === STATE.OUT || state[k] === STATE.OVERCOME || state[k] === STATE.INJURED || state[k] === STATE.KILLED) continue;
      if (severity[k] === 1) { slowed[k] = 0.7; continue; }
      if (state[k] !== STATE.ASSIST) active--;
      state[k] = severity[k] === 4 ? STATE.KILLED : STATE.INJURED; outAt[k] = t;
    }
    // with no smoke (an earthquake) the ways out only change when something falls
    // routes are only needed while someone is on the move (in a hotel at night nobody moves
    // for minutes); a person who sets off finds fresh routes waiting for them
    const due = t >= nextNav;
    let moving = false;
    for (let k = 0; k < N && !moving; k++) moving = state[k] === STATE.MOVING;
    if (changed || t === 0) { navigate(); navAt = t; }
    else if (due && moving && !quake && navigate(false)) navAt = t;
    if (due) nextNav += navEvery;
    crowd.fill(0);
    for (let k = 0; k < N; k++) if (state[k] <= STATE.MOVING) {
      const i = cellOf(px[k], py[k]);
      crowd[((((i / w) | 0) / bs) | 0) * bw + (((i % w) / bs) | 0)] += space[k];
    }
    for (let d = 0; d < doorTokens.length; d++) doorTokens[d] = Math.min(Math.max(1, doorRate[d]), doorTokens[d] + doorRate[d] * o.dt);
    doorQueue.fill(0);

    let stuck = 0;
    for (let k = 0; k < N; k++) {
      // people waiting for help at the stairs are still in the building: they keep breathing
      // smoke for as long as the drill runs
      if (state[k] >= STATE.OUT && state[k] !== STATE.ASSIST) continue;
      let i = cellOf(px[k], py[k]);
      const s = smokeAt(hz, i, t);
      const cnd = zoneModel ? roomAt(hz, i, t) : null;
      if (cnd) {
        // ISO 13571 doses at 2 m: CO (with CO2 hyperventilation) and convected heat
        const d = fedStep(cnd, o.dt);
        fedCO[k] += d.co; fedHeat[k] += d.heat;
        dose[k] = Math.max(fedCO[k], fedHeat[k]);
        if (dose[k] > TENABILITY.fed) overLimit[k] = 1;
      } else dose[k] += (s * s * o.dt) / o.doseTime;
      if (zoneModel && state[k] <= STATE.MOVING) {
        const r = hz.roomOf[i];
        if (r >= 0 && t > lastIn[r]) lastIn[r] = t;
      }
      // incapacitated at a full dose (FED 1, the median), in a flashover, or in the flames
      if (dose[k] >= 1 || hz.fireT[i] <= t - 5 || cnd?.flashover) {
        if (state[k] !== STATE.ASSIST) active--;
        state[k] = STATE.OVERCOME; outAt[k] = t; continue;
      }
      if (state[k] === STATE.ASSIST) continue;
      if (state[k] === STATE.WAITING) {
        // smoke down to head height in your own room, or flames close by: you go now
        const cue = zoneModel ? cnd?.inLayer || hz.fireDist[i] < 3 * hz.keepOut[Math.min(hz.keepOut.length - 1, Math.floor(t))] : s >= 0.1;
        if (t < pre[k] && !cue && hz.fireT[i] > t + 10) continue;
        state[k] = STATE.MOVING;
        if (t - navAt > navEvery && navigate(false)) navAt = t;
      }
      // the way out this person can use: stairs for those who can take them; step-free for
      // wheelchair users, or a stair landing to wait for help when nothing step-free is left
      // standing where the last, stopped-early search did not reach: search again in full
      if (routeOf[k].partial && !Number.isFinite(routeOf[k].field[i])) { navigate(); navAt = t; }
      let f = routeOf[k].field, toLanding = false;
      if (toPrimary[k]) {
        const pf = routeOf[k].primaryField;
        if (Number.isFinite(pf[i]) && !(cnd?.inLayer)) f = pf;
        else toPrimary[k] = 0; // blocked, or in smoke: the nearest way out from now on
      }
      const lf = routeOf[k].landingField;
      if (!Number.isFinite(f[i]) && lf && Number.isFinite(lf[i])) { f = lf; toLanding = true; }
      if (toLanding && f[i] === 0) { state[k] = STATE.ASSIST; outAt[k] = t; active--; continue; }
      if (!Number.isFinite(f[i])) {
        // no way out right now; stay put and hope the route opens (counted as trapped at the end)
        waited[k] += o.dt;
        stuck++;
        continue;
      }
      const b = ((((i / w) | 0) / bs) | 0) * bw + (((i % w) / bs) | 0);
      const rho = (crowd[b] - space[k]) / blockArea;
      // the SFPE relation is for moving crowds; in a queue the door sets the pace, so density is
      // taken at most at the 1.9 people/m2 the hydraulic method assumes at a constriction
      let v = people[k].speed * (o.fireModel === 'grid' && !quake ? weidmann(rho) : sfpe(Math.min(rho, 1.9)));
      // in smoke: slower as it thickens (Jin's irritant smoke: about 0.3 m/s at 0.5 /m)
      v *= cnd ? Math.max(0.25, 1 - 1.5 * cnd.extinction) : Math.max(0.3, 1 - 0.7 * s);
      if (quake) {
        // hard to keep your feet while the floor moves; slow going over rubble
        const shake = dmg.quake.pga * shakeAt(dmg.quake, t);
        v *= Math.max(0.15, 1 - 1.7 * shake);
        if (rubbleAt(i)) v *= 0.35;
        v *= slowed[k];
      }
      let left = v * o.dt;
      let guard = 0;
      while (left > 1e-6 && guard++ < 64) {
        if (g.kind[i] === K.EXIT || isStair(i) || f[i] === 0) break;
        // next cell: the neighbour with the quickest way out
        const x = i % w, y = (i / w) | 0;
        let next = -1, best = f[i];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (f[j] < best && (!(dx && dy) || (Number.isFinite(f[y * w + nx]) && Number.isFinite(f[ny * w + x])))) { best = f[j]; next = j; }
        }
        if (next < 0) break;
        // stepping into a door takes a place in its flow
        const dn = g.doorOf[next];
        if (dn >= 0 && holder[k] !== dn) {
          if (doorTokens[dn] < 1) { doorQueue[dn]++; waited[k] += o.dt; doorWait[dn] += o.dt; break; }
          // a wheelchair takes the door's flow of 2.5 people: those behind wait longer
          doorTokens[dn] -= space[k]; holder[k] = dn; doorCount[dn]++;
          if (g.doors[dn].exit) exitUsed[k] = dn;
        } else if (dn < 0) holder[k] = -1;
        const tx = ((next % w) + 0.5) * c, ty = (((next / w) | 0) + 0.5) * c;
        const ex = tx - px[k], ey = ty - py[k], dist = Math.hypot(ex, ey);
        if (dist <= left) { px[k] = tx; py[k] = ty; left -= dist; walked[k] += dist; i = next; }
        else { px[k] += (ex / dist) * left; py[k] += (ey / dist) * left; walked[k] += left; left = 0; i = cellOf(px[k], py[k]); }
      }
      if (toLanding && f[i] === 0) { state[k] = STATE.ASSIST; outAt[k] = t; active--; }
      else if (g.kind[i] === K.EXIT || isStair(i) || f[i] === 0) { state[k] = STATE.OUT; outAt[k] = t; active--; viaStairs[k] = isStair(i) ? 1 : 0; }
    }
    if (t >= nextFrame - 1e-9) { record(); nextFrame += o.frameEvery; }
    for (let d = 0; d < doorQueue.length; d++) if (doorQueue[d] > doorMaxQ[d]) doorMaxQ[d] = doorQueue[d];
    if (!active) break;
    // earthquake, no smoke: once everyone left is shut in and nothing more will fall, nothing changes
    if (quake && stuck >= active && nextEvent >= events.length && !impacts.length) break;
  }
  if (frames[frames.length - 1] !== t) record();
  for (let k = 0; k < N; k++) if (state[k] <= STATE.MOVING) state[k] = STATE.TRAPPED;
  // how long people waiting at the stairs can hold on: their smoke dose carried on past the
  // end of the run, up to maxTime (null: still fine then)
  let helpBy = null;
  for (let k = 0; k < N; k++) if (state[k] === STATE.ASSIST) {
    const i = cellOf(px[k], py[k]);
    let d = dose[k];
    for (let u = t; u <= o.maxTime; u += 1) {
      const s = smokeAt(hz, i, u);
      d += (s * s) / o.doseTime;
      if (d >= 1 || hz.fireT[i] <= u - 5) { helpBy = helpBy == null ? u : Math.min(helpBy, u); break; }
    }
  }
  // the final frame shows who never got out
  fState[fState.length - 1] = state.slice();

  const metrics = summarise(g, hz, people, { state, outAt, dose, waited, walked, exitUsed, doorCount, doorWait, doorMaxQ, viaStairs, helpBy, injuredBy, covering, quake: dmg, fedCO, fedHeat, overLimit, lastIn, warned, severity, t, o });
  return {
    fire: quake || o.scenario === 'none' ? null : { cell: start, x: ((start % w) + 0.5) * c, y: (((start / w) | 0) + 0.5) * c, zone: g.zoneByK.get(zoneFire)?.id || null },
    quake: dmg && { ...dmg.quake, panels: dmg.panels.filter((p) => p.t != null), topples: dmg.topples, events: dmg.events, hits },
    hazard: hz,
    fireModel: zoneModel ? { alarm: hz.zone.alarm, warned, sprinkler: hz.zone.sprinklerAt, flashover: hz.zone.flashoverAt, Q: hz.zone.Q, aset: hz.aset } : null,
    people: people.map((p, k) => ({ zone: p.zone, profile: p.profile || 'adult', start: [p.x, p.y], pre: pre[k], speed: p.speed, state: state[k], out_s: outAt[k], dose: dose[k], severity: severity[k] })),
    frames: { every: o.frameEvery, times: frames, pos: fPos, state: fState },
    metrics,
    params: { ...o, placed: undefined },
  };
}

function summarise(g, hz, people, r) {
  const N = people.length;
  const out = [], byZone = new Map();
  let overcome = 0, trapped = 0, assist = 0, injured = 0, killed = 0, maxDose = 0;
  const byProfile = {};
  for (let k = 0; k < N; k++) {
    if (r.state[k] === STATE.OUT) out.push(r.outAt[k]);
    if (r.state[k] === STATE.OVERCOME) overcome++;
    if (r.state[k] === STATE.TRAPPED) trapped++;
    if (r.state[k] === STATE.ASSIST) assist++;
    if (r.state[k] === STATE.INJURED) injured++;
    if (r.state[k] === STATE.KILLED) killed++;
    const pf = (byProfile[people[k].profile || 'adult'] ??= { people: 0, out: 0, overcome: 0, trapped: 0, assist: 0, injured: 0, killed: 0, last_out_s: null });
    pf.people++;
    if (r.state[k] === STATE.OUT) { pf.out++; pf.last_out_s = round1(Math.max(pf.last_out_s ?? 0, r.outAt[k])); }
    if (r.state[k] === STATE.OVERCOME) pf.overcome++;
    if (r.state[k] === STATE.TRAPPED) pf.trapped++;
    if (r.state[k] === STATE.ASSIST) pf.assist++;
    if (r.state[k] === STATE.INJURED) pf.injured++;
    if (r.state[k] === STATE.KILLED) pf.killed++;
    maxDose = Math.max(maxDose, r.dose[k]);
    const z = people[k].zone;
    if (!byZone.has(z)) byZone.set(z, { people: 0, out: 0, overcome: 0, trapped: 0, last_out_s: 0 });
    const e = byZone.get(z);
    e.people++;
    if (r.state[k] === STATE.OUT) { e.out++; e.last_out_s = round1(Math.max(e.last_out_s, r.outAt[k])); }
    if (r.state[k] === STATE.OVERCOME) e.overcome++;
    if (r.state[k] === STATE.TRAPPED) e.trapped++;
  }
  out.sort((a, b) => a - b);
  const pct = (p) => (out.length ? out[Math.min(out.length - 1, Math.ceil(p * out.length) - 1)] : null);
  // time each room becomes hard to stay in: half its floor in smoke thick enough to slow people (0.5)
  const zones = g.zones.map((z, zk) => {
    let untenable = Infinity;
    if (hz.kind === 'zone') untenable = hz.aset[zk]?.aset ?? Infinity;
    else if (hz.smokeT) {
      const ts = [];
      for (let i = 0; i < g.w * g.h; i++) if (g.zone[i] === z.k && g.kind[i] === K.FLOOR) ts.push(hz.smokeT[i] + hz.tau[i] * Math.LN2);
      ts.sort((a, b) => a - b);
      untenable = ts.length ? ts[(ts.length / 2) | 0] : Infinity;
    }
    const e = byZone.get(z.id) || { people: 0, out: 0, overcome: 0, trapped: 0, last_out_s: 0 };
    const clear = e.people ? (e.out === e.people ? e.last_out_s : null) : 0;
    return {
      id: z.id, name: z.name, type: z.type, ...e,
      clear_s: clear == null ? null : round1(clear),
      smoke_s: Number.isFinite(untenable) ? round1(untenable) : null,
      margin_s: clear == null || !Number.isFinite(untenable) ? null : round1(untenable - clear),
      // ASET (zone model): when the room stops being tenable at 2 m, and why; RSET: the last
      // moment anyone was in it on their way out
      aset_s: Number.isFinite(untenable) ? round1(untenable) : null,
      aset_cause: hz.kind === 'zone' ? hz.aset[zk]?.cause ?? null : null,
      rset_s: r.lastIn && r.lastIn[zk] >= 0 ? round1(r.lastIn[zk]) : null,
    };
  });
  const doors = g.doors.map((d, k) => ({
    id: d.id, exit: d.exit, width_m: d.width, people: r.doorCount[k], max_queue: r.doorMaxQ[k],
    wait_s: round1(r.doorWait[k]),
  }));
  const bottlenecks = doors.filter((d) => d.wait_s > 0).sort((a, b) => b.wait_s - a.wait_s).slice(0, 3);
  return {
    people: N,
    out: out.length,
    overcome,
    trapped,
    assist, // waiting for help at a stair landing
    help_by_s: r.helpBy == null ? null : round1(r.helpBy), // the first of them is overcome then without help
    injured, // hurt too badly to move (falling wall, furniture, or a fall)
    killed,
    over_limit: r.overLimit ? r.overLimit.reduce((a, b) => a + b, 0) : 0, // exposed past FED 0.3
    fire: hz.kind === 'zone' ? {
      alarm_s: hz.zone.alarm == null ? null : round1(hz.zone.alarm),
      warned_s: Number.isFinite(r.warned) ? round1(r.warned) : null,
      sprinkler_s: hz.zone.sprinklerAt == null ? null : round1(hz.zone.sprinklerAt),
      flashover_s: hz.zone.flashoverAt == null ? null : round1(hz.zone.flashoverAt),
      peak_kw: Math.round(Math.max(...hz.zone.Q)),
    } : null,
    quake: r.quake && {
      walls_down: r.quake.panels.filter((p) => p.t != null).length,
      walls: r.quake.panels.length,
      doors_jammed: r.quake.events.filter((e) => e.type === 'door').length,
      furniture_down: r.quake.topples.length,
      ran: r.covering.reduce((a, b) => a + (b ? 0 : 1), 0),
      injured_running: people.filter((_, k) => r.severity[k] && !r.covering[k]).length,
      injured_covering: people.filter((_, k) => r.severity[k] && r.covering[k]).length,
      by_wall: r.injuredBy.reduce((a, b) => a + (b === 1 ? 1 : 0), 0),
      by_furniture: r.injuredBy.reduce((a, b) => a + (b === 2 ? 1 : 0), 0),
      by_shaking: r.injuredBy.reduce((a, b) => a + (b === 3 ? 1 : 0), 0),
      building: r.quake.quake.building, design: r.quake.quake.design, damage: r.quake.quake.damage, collapsed: r.quake.quake.collapsed,
      p_damage: r.quake.quake.p_damage.map((x) => Math.round(x * 1000) / 1000),
      // HAZUS severities: 1 treated and released, 2 hospital, 3 life-threatening, 4 dead
      severity: [1, 2, 3, 4].map((s) => r.severity.reduce((a, b) => a + (b === s ? 1 : 0), 0)),
    },
    via_stairs: r.viaStairs.reduce((a, b) => a + b, 0),
    profiles: byProfile,
    all_out_s: out.length === N && N ? round1(out[N - 1]) : null,
    last_out_s: out.length ? round1(out[out.length - 1]) : null,
    p95_out_s: N ? (out.length >= Math.ceil(0.95 * N) ? round1(out[Math.ceil(0.95 * N) - 1]) : null) : null,
    median_out_s: out.length ? round1(pct(0.5)) : null,
    max_dose: Math.round(maxDose * 100) / 100,
    exits: g.doors.map((d, k) => ({ id: d.id, k, exit: d.exit })).filter((d) => d.exit).map((d) => ({ id: d.id, people: r.exitUsed.filter((x) => x === d.k).length, fire_s: Number.isFinite(minFire(g, hz, d.k)) ? round1(minFire(g, hz, d.k)) : null })),
    zones,
    doors,
    bottlenecks,
    ended_s: round1(r.t),
  };
}
function minFire(g, hz, k) {
  let m = Infinity;
  for (let i = 0; i < g.doorOf.length; i++) if (g.doorOf[i] === k) m = Math.min(m, hz.fireT[i]);
  return m;
}
const round1 = (v) => Math.round(v * 10) / 10;

// Many runs of the same emergency with different people (where they stand, how fast they
// walk, how long they take to react, who they are) and, for an earthquake, different damage:
// the spread of evacuation times, and for each room the time it stays tenable (ASET, from
// the fire model) against the time the last person passes through it (RSET), at the 95th
// percentile of the runs. A room passes when its ASET exceeds that RSET.
export function assess(site, opts = {}, runs = 20, onProgress = null) {
  const o = { ...SIM_DEFAULTS, ...opts };
  if (opts.maxTime == null) o.maxTime = Math.max(o.maxTime, (OCCUPANCY[o.use]?.remote ?? 0) + 600);
  const g = site.w ? site : prepare(site, o);
  const quake = o.scenario === 'earthquake', none = o.scenario === 'none';
  let hz = null;
  if (!quake && !none) {
    const start = fireCell(g, o.fire ?? g.zones[0].id);
    hz = hazard(g, start, o);
  }
  const all = [];
  for (let n = 0; n < runs; n++) {
    const r = simulate(g, { ...opts, maxTime: o.maxTime, seed: (o.seed ?? 1) * 1000 + n + 1, frameEvery: 1e9, hazard: hz });
    all.push(r.metrics);
    onProgress?.(n + 1, runs);
  }
  const q = (xs, p) => {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : null;
  };
  const harmed = all.map((m) => m.overcome + m.trapped + m.assist + (m.injured || 0) + (m.killed || 0));
  // a run where someone never got out has no evacuation time: it counts as the worst
  const evac = all.map((m) => (m.all_out_s == null ? Infinity : m.all_out_s));
  const rooms = g.zones.map((z, k) => {
    const rs = all.map((m) => m.zones[k]?.rset_s).filter((x) => x != null);
    const aset = all[0].zones[k]?.aset_s ?? null;
    const asets = all.map((m) => m.zones[k]?.aset_s ?? Infinity);
    const fails = all.filter((m, i) => m.zones[k]?.rset_s != null && m.zones[k].rset_s > asets[i]).length;
    const rset95 = q(rs, 0.95);
    return {
      id: z.id, name: z.name, aset, aset_cause: all[0].zones[k]?.aset_cause ?? null,
      used: rs.length, rset50: q(rs, 0.5), rset95,
      margin95: aset == null || rset95 == null ? null : Math.round((aset - rset95) * 10) / 10,
      p_fail: rs.length ? fails / runs : 0,
    };
  });
  const sum = (f) => all.reduce((t, m) => t + f(m), 0);
  return {
    runs,
    evacuation: { p50: q(evac, 0.5), p95: q(evac, 0.95), worst: Math.max(...evac), all_out_runs: evac.filter(Number.isFinite).length },
    harmed: { mean: Math.round((harmed.reduce((a, b) => a + b, 0) / runs) * 10) / 10, max: Math.max(...harmed), runs_with_harm: harmed.filter((x) => x > 0).length },
    over_limit: { runs_with: all.filter((m) => m.over_limit > 0).length, mean: Math.round((sum((m) => m.over_limit) / runs) * 10) / 10 },
    people: all[0].people,
    fire: all[0].fire,
    // who did not get out, per run on average, by profile and outcome; and doors a wheelchair cannot pass
    profiles: Object.fromEntries(Object.keys(PROFILES).map((p) => [p, ['people', 'out', 'overcome', 'trapped', 'assist', 'injured', 'killed'].reduce((t, key) => {
      t[key] = Math.round((all.reduce((a, m) => a + (m.profiles[p]?.[key] || 0), 0) / runs) * 10) / 10;
      return t;
    }, {})]).filter(([, v]) => v.people > 0)),
    narrow_doors: g.doors.filter((d) => d.width < PROFILES.wheelchair.minDoor).map((d) => d.id),
    doors_jammed: quake ? Math.round((all.reduce((a, m) => a + m.quake.doors_jammed, 0) / runs) * 10) / 10 : 0,
    // earthquake: how often each damage state came up, and injuries per run by severity
    quake: quake ? {
      states: all.reduce((t, m) => { t[m.quake.damage] = (t[m.quake.damage] || 0) + 1; return t; }, {}),
      collapsed: all.filter((m) => m.quake.collapsed).length,
      severity: [0, 1, 2, 3].map((k) => all.reduce((t, m) => t + m.quake.severity[k], 0) / runs),
    } : null,
    rooms,
    ok: rooms.every((r) => r.margin95 == null || r.margin95 >= 0) && harmed.filter((x) => x > 0).length <= runs * 0.05,
  };
}

// Run a fire in the middle of every room with the same people and rank the results.
export function worstFire(site, opts = {}, onProgress = null) {
  const g = site.w ? site : prepare(site, opts);
  const placed = placePeople(g, opts);
  const runs = [];
  const zones = g.zones.filter((z) => fireCell(g, z.id) >= 0);
  zones.forEach((z, n) => {
    const r = simulate(g, { ...opts, fire: z.id, placed, frameEvery: 1e9 });
    const m = r.metrics;
    runs.push({ fire: z.id, name: z.name, harmed: m.overcome + m.trapped + m.assist, overcome: m.overcome, trapped: m.trapped, last_out_s: m.last_out_s, p95_out_s: m.p95_out_s, max_dose: m.max_dose });
    onProgress?.(n + 1, zones.length);
  });
  // worst first: most people harmed, then the longest time to get everyone out, then smoke breathed
  runs.sort((a, b) => b.harmed - a.harmed || (b.last_out_s ?? 1e9) - (a.last_out_s ?? 1e9) || b.max_dose - a.max_dose);
  return { people: placed.length, runs };
}

export class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= k.length) break;
        if (m + 1 < k.length && k[m + 1] < k[m]) m++;
        if (k[m] >= lk) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
