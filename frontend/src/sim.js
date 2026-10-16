// Fire and evacuation simulation on an OPTEsc site JSON. Pure module: runs in the page,
// in a Web Worker (simworker.js) and in Node (tests, batch runs).
//
// Fire: spreads over the floor from a start point at a set speed and is held up at each
// closed door. Smoke: travels ahead of the fire through rooms and doors, then each room
// fills over a time that grows with its size. Both are worked out once as arrival times,
// so any moment can be drawn without stepping the model again (fireAt, smokeAt).
// People: placed in rooms by how busy that type of room usually is, wait a short while
// before they react, then walk the quickest way out. The way out is worked out again every
// few seconds so people steer around smoke and fire. Walking speed drops in crowds
// (Weidmann 1993) and in smoke; doors let through at most 1.3 people per second per metre
// of width (SFPE Handbook specific flow), which is where queues form.
// Smoke dose adds up while people breathe it; a full dose means overcome.

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
  speed: [1.0, 1.5], // free walking speed range, m/s
  preMove: [10, 60], // s before people react (in the room on fire: a third of that)
  navEvery: 2, // s between route updates
  frameEvery: 0.5, // s between recorded frames
  seed: 1,
  density: null, // people per m2 by room type, overrides DENSITY
  people: null, // { zoneId: count } overrides the density
  total: null, // everyone in the building, shared out by the density
};

// People per m2 by room type. Factory figures from typical staffing (one person per 20 to
// 50 m2 of production floor); offices and canteens from occupant load tables (NFPA 101 7.3.1.2
// gives 9.3 m2 per person for offices and 1.4 for dining; these are lower, for a normal shift).
export const DENSITY = {
  production: 1 / 25, storage: 1 / 100, office: 1 / 10, loading_bay: 1 / 50, corridor: 0,
  welfare: 1 / 5, bedroom: 1 / 8, living: 1 / 12, kitchen: 1 / 12, bathroom: 0, circulation: 0,
  outdoor: 0, technical: 0, unknown: 1 / 30,
};

const K = { OUTSIDE: 0, FLOOR: 1, WALL: 2, DOOR: 3, EXIT: 4, WINDOW: 5 };
const KIND_OF = { o: 0, '.': 1, '#': 2, D: 3, E: 4, W: 5 };
export const STATE = { WAITING: 0, MOVING: 1, OUT: 2, OVERCOME: 3, TRAPPED: 4 };

// The grid, zones and doors of a site in the form the simulation uses.
export function prepare(site) {
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
    return { id: d.id, width: Math.max(0.5, d.width_m || 0.9), exit: !!d.is_exit && (!allowed || allowed.has(d.id)), x: d.x, y: d.y };
  });
  if (allowed) for (let i = 0; i < kind.length; i++) {
    if (kind[i] === K.EXIT && !doors[doorOf[i]]?.exit) kind[i] = K.DOOR;
  }
  const zones = site.zones.map((z) => ({ ...z, k: Number(z.id.slice(1)) }));
  const zoneByK = new Map(zones.map((z) => [z.k, z]));
  return { w, h, c, kind, zone, doorOf, doors, zones, zoneByK };
}

const walkable = (k) => k === K.FLOOR || k === K.DOOR || k === K.EXIT;

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
      if (!walkable(kind[j])) continue;
      if (dx && dy && (!walkable(kind[y * w + nx]) || !walkable(kind[ny * w + x]))) continue;
      let nd = d + (dx && dy ? diag : step);
      if (doorOf[j] >= 0 && doorOf[i] !== doorOf[j]) nd += doorDelay;
      if (nd < t[j]) { t[j] = nd; heap.push(nd, j); }
    }
  }
  return Float32Array.from(t);
}

// Fire and smoke arrival times and how fast smoke thickens in each cell.
export function hazard(g, start, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  const fireT = spreadTimes(g, start, o.fireSpeed, o.fireDoorDelay);
  const smokeT = spreadTimes(g, start, o.smokeSpeed, o.smokeDoorDelay);
  // time for a room to fill: grows with the room's size; cells outside rooms (doors) fill fast
  const tau = new Float32Array(g.w * g.h);
  const tauOf = new Map(g.zones.map((z) => [z.k, Math.min(300, Math.max(15, Math.sqrt(z.area_m2 || z.grid_area_m2 || 20) * o.smokeFill))]));
  for (let i = 0; i < tau.length; i++) tau[i] = tauOf.get(g.zone[i]) ?? 20;
  return { start, fireT, smokeT, tau };
}

// Smoke thickness 0 (clear) to 1 (cannot see a hand) in cell i at time t.
export function smokeAt(hz, i, t) {
  const a = t - hz.smokeT[i];
  return a <= 0 ? 0 : 1 - Math.exp(-a / hz.tau[i]);
}
export const fireAt = (hz, i, t) => hz.fireT[i] <= t;

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
      people.push({ zone: z.id, x, y, speed: o.speed[0] + rand() * (o.speed[1] - o.speed[0]), pre: o.preMove[0] + rand() * (o.preMove[1] - o.preMove[0]) });
    }
  }
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
export function routeField(g, hz, t, field, maxSmoke = Infinity) {
  const { w, h, c, kind } = g;
  field.fill(Infinity);
  const heap = new MinHeap();
  const blocked = (i) => !walkable(kind[i]) || hz.fireT[i] <= t + 2 || (maxSmoke !== Infinity && smokeAt(hz, i, t) >= maxSmoke);
  // cost per metre: slower in smoke, and people turn away from smoke they can see
  const cost = (i) => 1 + 4 * smokeAt(hz, i, t);
  for (let i = 0; i < w * h; i++) if (kind[i] === K.EXIT && !blocked(i)) { field[i] = 0; heap.push(0, i); }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > field[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (blocked(j)) continue;
      if (dx && dy && (blocked(y * w + nx) || blocked(ny * w + x))) continue;
      const nd = d + (dx && dy ? Math.SQRT2 : 1) * c * 0.5 * (cost(i) + cost(j));
      if (nd < field[j]) { field[j] = nd; heap.push(nd, j); }
    }
  }
}

// Weidmann (1993) walking speed share at a crowd density of rho people per m2.
export const weidmann = (rho) => (rho <= 0.3 ? 1 : Math.max(0.1, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4))));

// Run one fire. Returns the people, recorded frames, the fire and smoke times, and the results.
export function simulate(site, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  const g = site.w ? site : prepare(site);
  const start = fireCell(g, o.fire ?? g.zones[0].id);
  if (start < 0) throw new Error('No floor near the fire start');
  const hz = hazard(g, start, o);
  const people = o.placed || placePeople(g, o);
  const N = people.length;
  const { w, h, c } = g;
  const zoneFire = g.zone[start];

  const px = new Float32Array(N), py = new Float32Array(N), state = new Uint8Array(N);
  const dose = new Float32Array(N), outAt = new Float32Array(N).fill(NaN), pre = new Float32Array(N);
  const waited = new Float32Array(N), walked = new Float32Array(N);
  const exitUsed = new Int32Array(N).fill(-1);
  people.forEach((p, k) => {
    px[k] = p.x; py[k] = p.y;
    // people in the burning room notice at once
    pre[k] = g.zone[cellOf(p.x, p.y)] === zoneFire ? p.pre / 3 : p.pre;
  });
  function cellOf(x, y) { return Math.min(h - 1, Math.max(0, Math.floor(y / c))) * w + Math.min(w - 1, Math.max(0, Math.floor(x / c))); }

  // door capacity: each door lets through doorFlow * width people per second
  const doorTokens = new Float32Array(g.doors.length);
  const doorRate = g.doors.map((d) => o.doorFlow * d.width);
  const doorCount = new Int32Array(g.doors.length), doorQueue = new Int32Array(g.doors.length);
  const doorWait = new Float32Array(g.doors.length), doorMaxQ = new Int32Array(g.doors.length);
  const holder = new Int32Array(N).fill(-1); // the door each person is passing through

  // crowd density in 1 m blocks
  const bs = Math.max(1, Math.round(1 / c)), bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
  const crowd = new Uint16Array(bw * bh), blockArea = (bs * c) ** 2;

  const field = new Float64Array(w * h);
  const frames = [];
  const fPos = [], fState = [];
  let nextNav = 0, nextFrame = 0, t = 0;
  const navEvery = Math.max(o.navEvery, Math.min(10, (w * h) / 40000));
  const record = () => {
    const pos = new Float32Array(N * 2);
    for (let k = 0; k < N; k++) { pos[2 * k] = px[k]; pos[2 * k + 1] = py[k]; }
    fPos.push(pos); fState.push(state.slice()); frames.push(t);
  };

  let active = N;
  for (; t <= o.maxTime + 1e-9; t += o.dt) {
    t = Math.round(t * 1000) / 1000;
    if (t >= nextNav) { routeField(g, hz, t, field); nextNav += navEvery; }
    crowd.fill(0);
    for (let k = 0; k < N; k++) if (state[k] <= STATE.MOVING) {
      const i = cellOf(px[k], py[k]);
      crowd[((((i / w) | 0) / bs) | 0) * bw + (((i % w) / bs) | 0)]++;
    }
    for (let d = 0; d < doorTokens.length; d++) doorTokens[d] = Math.min(Math.max(1, doorRate[d]), doorTokens[d] + doorRate[d] * o.dt);
    doorQueue.fill(0);

    for (let k = 0; k < N; k++) {
      if (state[k] >= STATE.OUT) continue;
      let i = cellOf(px[k], py[k]);
      const s = smokeAt(hz, i, t);
      dose[k] += (s * s * o.dt) / o.doseTime;
      // flames hurt once they have taken hold (a few seconds after reaching the spot)
      if (dose[k] >= 1 || hz.fireT[i] <= t - 5) { state[k] = STATE.OVERCOME; outAt[k] = t; active--; continue; }
      if (state[k] === STATE.WAITING) {
        if (t < pre[k] && s < 0.1 && hz.fireT[i] > t + 10) continue;
        state[k] = STATE.MOVING;
      }
      if (!Number.isFinite(field[i])) {
        // no way out right now; stay put and hope the route opens (counted as trapped at the end)
        waited[k] += o.dt;
        continue;
      }
      const b = ((((i / w) | 0) / bs) | 0) * bw + (((i % w) / bs) | 0);
      const v = people[k].speed * weidmann((crowd[b] - 1) / blockArea) * Math.max(0.3, 1 - 0.7 * s);
      let left = v * o.dt;
      let guard = 0;
      while (left > 1e-6 && guard++ < 64) {
        if (g.kind[i] === K.EXIT) break;
        // next cell: the neighbour with the quickest way out
        const x = i % w, y = (i / w) | 0;
        let next = -1, best = field[i];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (field[j] < best && (!(dx && dy) || (Number.isFinite(field[y * w + nx]) && Number.isFinite(field[ny * w + x])))) { best = field[j]; next = j; }
        }
        if (next < 0) break;
        // stepping into a door takes a place in its flow
        const dn = g.doorOf[next];
        if (dn >= 0 && holder[k] !== dn) {
          if (doorTokens[dn] < 1) { doorQueue[dn]++; waited[k] += o.dt; doorWait[dn] += o.dt; break; }
          doorTokens[dn] -= 1; holder[k] = dn; doorCount[dn]++;
          if (g.doors[dn].exit) exitUsed[k] = dn;
        } else if (dn < 0) holder[k] = -1;
        const tx = ((next % w) + 0.5) * c, ty = (((next / w) | 0) + 0.5) * c;
        const ex = tx - px[k], ey = ty - py[k], dist = Math.hypot(ex, ey);
        if (dist <= left) { px[k] = tx; py[k] = ty; left -= dist; walked[k] += dist; i = next; }
        else { px[k] += (ex / dist) * left; py[k] += (ey / dist) * left; walked[k] += left; left = 0; i = cellOf(px[k], py[k]); }
      }
      if (g.kind[i] === K.EXIT) { state[k] = STATE.OUT; outAt[k] = t; active--; }
    }
    if (t >= nextFrame - 1e-9) { record(); nextFrame += o.frameEvery; }
    for (let d = 0; d < doorQueue.length; d++) if (doorQueue[d] > doorMaxQ[d]) doorMaxQ[d] = doorQueue[d];
    if (!active) break;
  }
  if (frames[frames.length - 1] !== t) record();
  for (let k = 0; k < N; k++) if (state[k] <= STATE.MOVING) state[k] = STATE.TRAPPED;
  // the final frame shows who never got out
  fState[fState.length - 1] = state.slice();

  const metrics = summarise(g, hz, people, { state, outAt, dose, waited, walked, exitUsed, doorCount, doorWait, doorMaxQ, t, o });
  return {
    fire: { cell: start, x: ((start % w) + 0.5) * c, y: (((start / w) | 0) + 0.5) * c, zone: g.zoneByK.get(zoneFire)?.id || null },
    hazard: hz,
    people: people.map((p, k) => ({ zone: p.zone, start: [p.x, p.y], pre: pre[k], speed: p.speed, state: state[k], out_s: outAt[k], dose: dose[k] })),
    frames: { every: o.frameEvery, times: frames, pos: fPos, state: fState },
    metrics,
    params: { ...o, placed: undefined },
  };
}

function summarise(g, hz, people, r) {
  const N = people.length;
  const out = [], byZone = new Map();
  let overcome = 0, trapped = 0, maxDose = 0;
  for (let k = 0; k < N; k++) {
    if (r.state[k] === STATE.OUT) out.push(r.outAt[k]);
    if (r.state[k] === STATE.OVERCOME) overcome++;
    if (r.state[k] === STATE.TRAPPED) trapped++;
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
  const zones = g.zones.map((z) => {
    const ts = [];
    for (let i = 0; i < g.w * g.h; i++) if (g.zone[i] === z.k && g.kind[i] === K.FLOOR) ts.push(hz.smokeT[i] + hz.tau[i] * Math.LN2);
    ts.sort((a, b) => a - b);
    const untenable = ts.length ? ts[(ts.length / 2) | 0] : Infinity;
    const e = byZone.get(z.id) || { people: 0, out: 0, overcome: 0, trapped: 0, last_out_s: 0 };
    const clear = e.people ? (e.out === e.people ? e.last_out_s : null) : 0;
    return {
      id: z.id, name: z.name, type: z.type, ...e,
      clear_s: clear == null ? null : round1(clear),
      smoke_s: Number.isFinite(untenable) ? round1(untenable) : null,
      margin_s: clear == null || !Number.isFinite(untenable) ? null : round1(untenable - clear),
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

// Run a fire in the middle of every room with the same people and rank the results.
export function worstFire(site, opts = {}, onProgress = null) {
  const g = site.w ? site : prepare(site);
  const placed = placePeople(g, opts);
  const runs = [];
  const zones = g.zones.filter((z) => fireCell(g, z.id) >= 0);
  zones.forEach((z, n) => {
    const r = simulate(g, { ...opts, fire: z.id, placed, frameEvery: 1e9 });
    const m = r.metrics;
    runs.push({ fire: z.id, name: z.name, harmed: m.overcome + m.trapped, overcome: m.overcome, trapped: m.trapped, last_out_s: m.last_out_s, p95_out_s: m.p95_out_s, max_dose: m.max_dose });
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
