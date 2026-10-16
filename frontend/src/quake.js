// Earthquake damage on an OPTEsc site grid. Pure module: runs in the page, the simulation
// worker and Node.
//
// The building's damage state comes from HAZUS (FEMA): for the chosen structure type and
// seismic design level, equivalent-PGA fragility curves give the chance of Slight, Moderate,
// Extensive and Complete damage, and a share of Complete damage collapses. Casualties follow
// the HAZUS indoor rates for that state (sim.js). The ground shakes for a while and an
// aftershock follows a minute or two later, while people are leaving.
// What that state looks like on the plan is an illustration: walls are cut into panels of at
// most 4 m between corners and junctions, and a share of them comes down for the damage state
// (weaker panels first: thin, long, exterior, beside a door). A panel topples out of its plane
// during the strong shaking and spreads rubble over about 60% of its height on the side it
// falls; its footprint becomes a rubble mound people can climb over. Door frames jam more often
// as damage grows, and always beside a collapse. Tall unanchored shelving and cabinets overturn
// (median 0.3 g) and their contents spill over a band as wide as they are tall.
//
// Everything is drawn from one seeded random stream, so a run can be repeated exactly.

import { rng } from './sim.js';

// Peak ground acceleration (g) and length of strong shaking (s), roughly EMS-98 intensities
// VI, VII-VIII, IX and X. Durations are illustrative.
export const QUAKE_LEVELS = {
  moderate: { label: 'Moderate', pga: 0.15, duration: 15 },
  strong: { label: 'Strong', pga: 0.3, duration: 25 },
  severe: { label: 'Severe', pga: 0.5, duration: 40 },
  extreme: { label: 'Extreme', pga: 0.8, duration: 45 },
};

// Building damage (Hazus Earthquake Model Technical Manual, FEMA, Hazus 6.1): equivalent-PGA
// structural fragility, median PGA (g) for Slight, Moderate, Extensive and Complete damage,
// lognormal beta 0.64 (Tables 5-37 to 5-40, reference spectrum: large western US event on
// soil); the share of Complete damage that collapses (Table 12-8); indoor casualty rates in %
// for severity 1 (treated, not admitted), 2 (hospital), 3 (life-threatening), 4 (dead)
// (Tables 12-3 to 12-7). Unreinforced masonry is not allowed by moderate or high codes.
export const BUILDINGS = {
  W1: { label: 'Wood frame', collapse: 0.03, codes: { high: [0.26, 0.55, 1.28, 2.01], moderate: [0.24, 0.43, 0.91, 1.34], low: [0.2, 0.34, 0.61, 0.95], pre: [0.18, 0.29, 0.51, 0.77] } },
  S1L: { label: 'Steel moment frame', collapse: 0.08, codes: { high: [0.19, 0.31, 0.64, 1.49], moderate: [0.15, 0.22, 0.42, 0.8], low: [0.12, 0.17, 0.3, 0.48], pre: [0.09, 0.13, 0.22, 0.38] } },
  S3: { label: 'Light metal building', collapse: 0.03, codes: { high: [0.15, 0.26, 0.54, 1.0], moderate: [0.13, 0.19, 0.33, 0.6], low: [0.1, 0.13, 0.2, 0.38], pre: [0.08, 0.1, 0.16, 0.3] } },
  C1L: { label: 'Concrete moment frame', collapse: 0.13, codes: { high: [0.21, 0.35, 0.7, 1.37], moderate: [0.16, 0.23, 0.41, 0.77], low: [0.12, 0.15, 0.27, 0.45], pre: [0.1, 0.12, 0.21, 0.36] } },
  C2L: { label: 'Concrete shear walls', collapse: 0.13, codes: { high: [0.24, 0.45, 0.9, 1.55], moderate: [0.18, 0.3, 0.49, 0.87], low: [0.14, 0.19, 0.3, 0.52], pre: [0.11, 0.15, 0.24, 0.42] } },
  PC1: { label: 'Precast concrete tilt-up', collapse: 0.15, codes: { high: [0.2, 0.35, 0.72, 1.25], moderate: [0.18, 0.24, 0.44, 0.71], low: [0.13, 0.17, 0.25, 0.45], pre: [0.11, 0.14, 0.21, 0.35] } },
  RM1L: { label: 'Reinforced masonry', collapse: 0.13, codes: { high: [0.3, 0.46, 0.93, 1.57], moderate: [0.22, 0.3, 0.5, 0.85], low: [0.16, 0.2, 0.29, 0.54], pre: [0.13, 0.16, 0.24, 0.43] } },
  URML: { label: 'Unreinforced masonry', collapse: 0.15, codes: { low: [0.14, 0.2, 0.32, 0.46], pre: [0.13, 0.17, 0.26, 0.37] } },
};
export const DAMAGE_STATES = ['none', 'slight', 'moderate', 'extensive', 'complete'];
export const HAZUS_BETA = 0.64;
// indoor casualty rates (%), severity 1 to 4, by damage state; URML has its own rows
const RATES = {
  slight: [0.05, 0, 0, 0],
  moderate: [0.25, 0.03, 0, 0],
  extensive: [1, 0.1, 0.001, 0.001],
  complete: [5, 1, 0.01, 0.01],
  collapse: [40, 20, 5, 10],
};
const RATES_BY_TYPE = {
  moderate: { S1L: [0.2, 0.025, 0, 0], S3: [0.2, 0.025, 0, 0], RM1L: [0.2, 0.025, 0, 0], URML: [0.35, 0.4, 0.001, 0.001] },
  extensive: { URML: [2, 0.2, 0.002, 0.002] },
  complete: { URML: [10, 2, 0.02, 0.02] },
  collapse: { W1: [40, 20, 3, 5], S3: [40, 20, 3, 5] },
};
export function casualtyRates(type, ds, collapsed) {
  const key = ds === 'complete' && collapsed ? 'collapse' : ds;
  if (key === 'none') return [0, 0, 0, 0];
  return (RATES_BY_TYPE[key]?.[type] || RATES[key]).map((r) => r / 100);
}

// One draw of the building's damage state for a peak ground acceleration.
export function drawDamage(type, code, pga, u, uc) {
  const b = BUILDINGS[type] || BUILDINGS.C1L;
  const med = b.codes[code] || b.codes.pre || Object.values(b.codes)[0];
  let ds = 0;
  for (let k = 0; k < 4; k++) if (u < fragility(pga, med[k], HAZUS_BETA)) ds = k + 1;
  const state = DAMAGE_STATES[ds];
  return { state, collapsed: state === 'complete' && uc < b.collapse, probabilities: med.map((m) => fragility(pga, m, HAZUS_BETA)) };
}

// Wall panels that come down for a building damage state: an illustration of what that
// state looks like (HAZUS describes damage for the whole building, not wall by wall), the
// weaker panels first. Shares of thin partitions and of other walls.
const PANEL_SHARE = { none: [0, 0], slight: [0, 0], moderate: [0.05, 0], extensive: [0.25, 0.05], complete: [0.5, 0.25], collapse: [0.85, 0.7] };

export const QUAKE_DEFAULTS = {
  level: 'strong',
  building: 'C1L', // BUILDINGS
  design: 'low', // 'pre', 'low', 'moderate' or 'high' seismic code
  wallHeight: 2.6, // m
  panelMax: 4, // m: longest wall panel between supports
  beta: 0.6, // fragility dispersion
  aftershock: true,
  rubbleSpread: 0.6, // rubble reaches this share of the wall height from the wall face
};

const KIND = { OUTSIDE: 0, FLOOR: 1, WALL: 2, DOOR: 3, EXIT: 4, WINDOW: 5 };
const TOPPLES = new Set(['storage', 'other']);

// Standard normal cumulative distribution (Abramowitz-Stegun 7.1.26, error < 1.5e-7).
export function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export const fragility = (pga, median, beta) => (pga <= 0 ? 0 : phi(Math.log(pga / median) / beta));

// Shaking strength 0..1 at time t: a quick rise, strong shaking, a slow fade; then the aftershock.
export function shakeAt(q, t) {
  const env = (t0, d) => {
    const u = (t - t0) / d;
    if (u < 0 || u > 1.3) return 0;
    if (u < 0.15) return u / 0.15;
    if (u < 0.6) return 1;
    return Math.max(0, 1 - (u - 0.6) / 0.7);
  };
  let s = env(0, q.duration);
  if (q.aftershock) s = Math.max(s, env(q.aftershock.t, q.aftershock.duration) * (q.aftershock.pga / q.pga));
  return s;
}

// Wall panels: straight runs of wall (and window) cells, split into pieces of at most
// `panelMax` metres. Corners and short piers are stiff and left out.
export function wallPanels(g, panelMax = 4) {
  const { w, h, c, kind } = g;
  const isWall = (k) => k === KIND.WALL || k === KIND.WINDOW;
  const panels = [];
  for (const [x, y, rw, rh] of mergeRects(kind, w, h, isWall)) {
    const horiz = rw >= rh;
    const run = horiz ? rw : rh, thick = horiz ? rh : rw;
    if (run * c < Math.max(1, 2.5 * thick * c)) continue;
    const n = Math.ceil((run * c) / panelMax);
    for (let k = 0; k < n; k++) {
      const a = Math.round((k * run) / n), b = Math.round(((k + 1) * run) / n);
      const r = horiz ? [x + a, y, b - a, rh] : [x, y + a, rw, b - a];
      const cells = [];
      for (let yy = r[1]; yy < r[1] + r[3]; yy++) for (let xx = r[0]; xx < r[0] + r[2]; xx++) cells.push(yy * w + xx);
      // what lies on each long side: outside, floor, and doors at the panel's ends
      const side = (s) => {
        let out = 0, floor = 0;
        for (let u = 0; u < (horiz ? r[2] : r[3]); u++) {
          const xx = horiz ? r[0] + u : s < 0 ? r[0] - 1 : r[0] + r[2];
          const yy = horiz ? (s < 0 ? r[1] - 1 : r[1] + r[3]) : r[1] + u;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) { out++; continue; }
          const kk = kind[yy * w + xx];
          if (kk === KIND.OUTSIDE) out++;
          else if (kk === KIND.FLOOR || kk === KIND.DOOR || kk === KIND.EXIT) floor++;
        }
        return { out, floor };
      };
      const ends = [];
      for (const s of [-1, 1]) for (let u = 0; u < thick; u++) {
        const xx = horiz ? (s < 0 ? r[0] - 1 : r[0] + r[2]) : r[0] + u;
        const yy = horiz ? r[1] + u : s < 0 ? r[1] - 1 : r[1] + r[3];
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) ends.push(yy * w + xx);
      }
      panels.push({
        rect: r, horiz, cells, length_m: (b - a) * c, thick_m: thick * c,
        sides: { [-1]: side(-1), [1]: side(1) },
        nextToDoor: ends.some((i) => kind[i] === KIND.DOOR || kind[i] === KIND.EXIT),
        doorCells: ends.filter((i) => kind[i] === KIND.DOOR || kind[i] === KIND.EXIT),
      });
    }
  }
  return panels;
}

// Median PGA (g) at which a panel collapses.
function panelMedian(p, wallHeight) {
  let m = p.thick_m <= 0.17 ? 0.42 : p.thick_m <= 0.27 ? 0.6 : 0.8; // partition, inner, outer wall
  m *= Math.min(1.2, Math.max(0.7, (3 / p.length_m) ** 0.3)); // long free spans are weaker
  m *= Math.sqrt(2.6 / wallHeight); // so are tall ones
  if (p.sides[-1].out + p.sides[1].out > 0) m *= 0.85; // exterior: free on one side
  if (p.nextToDoor) m *= 0.85; // an opening at its end
  return m;
}

// The damage one quake does: which panels, door frames and shelves fail and when, and where
// the rubble lies. g: the prepared grid (sim.prepare); objects: site objects in metres.
export function quakeDamage(g, objects = [], opts = {}) {
  const o = { ...QUAKE_DEFAULTS, ...opts };
  const lv = QUAKE_LEVELS[o.level] || QUAKE_LEVELS.strong;
  const rand = rng((o.seed ?? 1) * 7349 + 11);
  const { w, h, c, kind } = g;
  const q = { level: o.level, label: lv.label, pga: lv.pga, duration: lv.duration, aftershock: null };
  if (o.aftershock) {
    q.aftershock = { t: Math.round(lv.duration + 50 + rand() * 60), pga: lv.pga * 0.5, duration: Math.round(lv.duration * 0.4) };
  }
  const rubbleT = new Float32Array(w * h).fill(Infinity);
  const blockT = new Float32Array(w * h).fill(Infinity);
  const events = [];
  const strongTime = (t0, d) => t0 + d * (0.15 + 0.5 * rand());
  const free = (i) => kind[i] === KIND.FLOOR || kind[i] === KIND.DOOR || kind[i] === KIND.EXIT || kind[i] === 6 || kind[i] === 7;

  // walls
  const panels = wallPanels(g, o.panelMax);
  const spread = Math.max(1, Math.round((o.rubbleSpread * o.wallHeight) / c));
  // the building's damage state (HAZUS), then which panels show it: a share of the partitions
  // and of the other walls, weaker panels (lower median) more likely to be among them
  const dmgDraw = drawDamage(o.building, o.design, q.pga, rand(), rand());
  Object.assign(q, { building: o.building, design: o.design, damage: dmgDraw.state, collapsed: dmgDraw.collapsed, p_damage: dmgDraw.probabilities });
  const [sharePart, shareWall] = PANEL_SHARE[dmgDraw.collapsed ? 'collapse' : dmgDraw.state];
  const ranked = panels.map((p, n) => ({ p, n, key: Math.log(rand() + 1e-12) * panelMedian(p, o.wallHeight) })).sort((a, b) => b.key - a.key);
  const parts = ranked.filter((r) => r.p.thick_m <= 0.17), walls = ranked.filter((r) => r.p.thick_m > 0.17);
  const fail = new Set([...parts.slice(0, Math.round(sharePart * parts.length)), ...walls.slice(0, Math.round(shareWall * walls.length))].map((r) => r.n));
  panels.forEach((p, n) => {
    const med = panelMedian(p, o.wallHeight);
    let t = null;
    if (fail.has(n)) t = strongTime(0, q.duration);
    // a damaged building sheds more in the aftershock
    else if (q.aftershock && (dmgDraw.state === 'extensive' || dmgDraw.state === 'complete') && rand() < fragility(q.aftershock.pga, med * 0.75, o.beta)) t = strongTime(q.aftershock.t, q.aftershock.duration);
    p.id = `W${n + 1}`;
    p.median_g = Math.round(med * 100) / 100;
    if (t == null) return;
    p.t = Math.round(t * 10) / 10;
    // which way it falls: an outer wall mostly outwards; otherwise towards the side with room
    const [a, b] = [p.sides[-1], p.sides[1]];
    let s;
    if (a.out || b.out) s = (a.out ? -1 : 1) * (rand() < 0.6 ? 1 : -1);
    else s = rand() < (b.floor + 1) / (a.floor + b.floor + 2) ? 1 : -1;
    p.side = s;
    const debris = [];
    for (const i of p.cells) { rubbleT[i] = Math.min(rubbleT[i], p.t); debris.push(i); }
    const [rx, ry, rw, rh] = p.rect;
    for (let u2 = 0; u2 < (p.horiz ? rw : rh); u2++) {
      for (let d = 1; d <= spread; d++) {
        const xx = p.horiz ? rx + u2 : s < 0 ? rx - d : rx + rw - 1 + d;
        const yy = p.horiz ? (s < 0 ? ry - d : ry + rh - 1 + d) : ry + u2;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
        const i = yy * w + xx;
        if (!free(i)) break; // the next wall stops the rubble
        rubbleT[i] = Math.min(rubbleT[i], p.t);
        debris.push(i);
      }
    }
    p.debris = debris;
    events.push({ t: p.t, type: 'wall', id: p.id, cells: debris, zones: zonesOf(g, debris) });
  });

  // door frames: racked by a collapse beside them, or by strong shaking alone
  // (illustrative: jamming grows with the damage state and with a collapse next to the frame)
  const jamShare = { none: 0, slight: 0, moderate: 0.05, extensive: 0.2, complete: 0.5 }[dmgDraw.state];
  g.doors.forEach((d, k) => {
    const cells = [];
    for (let i = 0; i < w * h; i++) if (g.doorOf[i] === k) cells.push(i);
    const beside = panels.filter((p) => p.t != null && p.doorCells.some((i) => g.doorOf[i] === k)).map((p) => p.t);
    if (rand() >= (beside.length ? Math.max(jamShare, 0.6) : jamShare)) return;
    const t = Math.round((beside.length ? Math.min(...beside) + 0.5 : strongTime(0, q.duration)) * 10) / 10;
    for (const i of cells) blockT[i] = Math.min(blockT[i], t);
    events.push({ t, type: 'door', id: d.id, door: k, cells, zones: zonesOf(g, cells) });
  });

  // tall shelving and cabinets overturn (median 0.3 g unanchored, after FEMA E-74 guidance
  // that tall unanchored furniture is a leading cause of earthquake injuries)
  const topples = [];
  for (const ob of objects) {
    // slender furniture only (shelves, cabinets, lockers): heavy squat machines stay put
    if (ob.kind !== 'object' || !TOPPLES.has(ob.category) || (ob.height_m ?? 0) < 1.5 || ob.polygon.length !== 4) continue;
    const [A, B, , D] = ob.polygon;
    const e1 = [B[0] - A[0], B[1] - A[1]], e2 = [D[0] - A[0], D[1] - A[1]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (ob.height_m < 2 * Math.min(l1, l2)) continue;
    if (rand() >= fragility(q.pga, 0.3, 0.5)) continue;
    // falls across its narrow side, towards the side with more floor
    const [long, short, ls] = l1 >= l2 ? [e1, e2, l2] : [e2, e1, l1];
    const nrm = [short[0] / ls, short[1] / ls];
    const t = Math.round(strongTime(0, q.duration) * 10) / 10;
    const band = (sgn) => {
      const cells = [];
      const H = ob.height_m;
      const base = sgn > 0 ? [A[0] + short[0], A[1] + short[1]] : A;
      for (let a = 0; a <= 1; a += c / Math.max(c, Math.hypot(...long)) / 2) for (let d = 0; d <= H; d += c / 2) {
        const x = base[0] + long[0] * a + nrm[0] * d * sgn, y = base[1] + long[1] * a + nrm[1] * d * sgn;
        const gx = Math.floor(x / c), gy = Math.floor(y / c);
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const i = gy * w + gx;
        if (free(i) && !cells.includes(i)) cells.push(i);
      }
      return cells;
    };
    const plus = band(1), minus = band(-1);
    const sgn = plus.length >= minus.length ? 1 : -1;
    const cells = sgn > 0 ? plus : minus;
    for (const i of cells) rubbleT[i] = Math.min(rubbleT[i], t);
    topples.push({ id: ob.id, t, dir: [nrm[0] * sgn, nrm[1] * sgn], height_m: ob.height_m, category: ob.category });
    events.push({ t, type: 'topple', id: ob.id, cells, zones: zonesOf(g, cells) });
  }

  events.sort((a, b) => a.t - b.t);
  return {
    quake: q, rubbleT, blockT, events, topples,
    panels: panels.map(({ id, rect, horiz, length_m, thick_m, median_g, t = null, side = 0, debris = [] }) => ({ id, rect, horiz, length_m, thick_m, median_g, t, side, debris })),
  };
}

function zonesOf(g, cells) {
  const z = new Set();
  for (const i of cells) if (g.zone[i] > 0) z.add(`Z${g.zone[i]}`);
  // a wall cell has no zone: name the rooms on either side
  if (!z.size) for (const i of cells) for (const j of [i - 1, i + 1, i - g.w, i + g.w]) if (g.zone[j] > 0) z.add(`Z${g.zone[j]}`);
  return [...z];
}

// Greedy merge of grid cells into rectangles [x, y, w, h].
function mergeRects(kind, w, h, pred) {
  const used = new Uint8Array(w * h);
  const rects = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (used[i] || !pred(kind[i])) continue;
    let rw = 1;
    while (x + rw < w && !used[i + rw] && pred(kind[i + rw])) rw++;
    let rh = 1;
    grow: while (y + rh < h) {
      for (let k = 0; k < rw; k++) {
        const j = (y + rh) * w + x + k;
        if (used[j] || !pred(kind[j])) break grow;
      }
      rh++;
    }
    for (let yy = 0; yy < rh; yy++) for (let k = 0; k < rw; k++) used[(y + yy) * w + x + k] = 1;
    rects.push([x, y, rw, rh]);
  }
  return rects;
}
