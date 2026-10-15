// Measurements and checks on a segmented plan: net areas, door widths and swing,
// the room-and-door graph, exit travel distances and the list of things to check.
import { KIND } from './plan2grid.js';

export const EGRESS_DEFAULTS = {
  // UK Approved Document B, industrial (normal hazard), escape in more than one direction.
  // NFPA 101 allows 61 m (200 ft) for general industrial without sprinklers, 76 m with.
  maxTravelM: 45,
  minDoorM: 0.8, // NFPA 101 7.2.1.2.3: 32 in (0.81 m) clear width
};

// Net floor area per zone. Zone cells count fully; a wall cell that touches the zone adds
// its non-wall share (the strip of floor between the cell edge and the wall face).
export function zoneAreas(base, seg) {
  const { w, h, zone, kind } = seg;
  const c2 = seg.params.cellM ** 2;
  const area = new Float64Array(seg.zoneCount + 1);
  for (let i = 0; i < w * h; i++) {
    if (zone[i] > 0) { area[zone[i]] += c2; continue; }
    if (kind[i] !== KIND.WALL || !base.wallShare) continue;
    const near = new Set();
    neighbours(i, w, h, (j) => { if (zone[j] > 0) near.add(zone[j]); });
    if (!near.size) continue;
    const free = Math.max(0, 1 - base.wallShare[i]) * c2 / near.size;
    for (const z of near) area[z] += free;
  }
  return area;
}

// Width, orientation and swing of one door from the cells of its gap.
export function measureDoor(base, seg, door) {
  const { w, h, zone, kind } = seg;
  const c = seg.params.cellM;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const i of door.cells) {
    const x = i % w, y = (i / w) | 0;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // the gap runs along x when it is wider than deep
  const alongX = maxX - minX >= maxY - minY;
  const len = alongX ? maxX - minX + 1 : maxY - minY + 1;
  const ws = base.wallShare;
  const share = (x, y) => (x < 0 || y < 0 || x >= w || y >= h || !ws ? 1 : Math.min(1, ws[y * w + x]));
  // free part of a flanking wall cell: least free share across the wall's thickness
  const flankFree = (fx, fy) => {
    let free = 1;
    for (let t = alongX ? minY : minX; t <= (alongX ? maxY : maxX); t++) {
      const sh = alongX ? share(fx, t) : share(t, fy);
      if (sh > 0.3) free = Math.min(free, 1 - sh);
    }
    return free === 1 ? 0 : free;
  };
  const fStart = ws ? (alongX ? flankFree(minX - 1, 0) : flankFree(0, minY - 1)) : 0;
  const fEnd = ws ? (alongX ? flankFree(maxX + 1, 0) : flankFree(0, maxY + 1)) : 0;
  let width = (len + fStart + fEnd) * c;
  const px = pixelWidth(base, alongX, minX, minY, maxX, maxY, c);
  if (px) width = px;

  // swing: the arc and leaf are thin linework in the square on one side of the gap
  const ink = base.ink;
  const result = { width_m: width, along: alongX ? 'x' : 'y', swing: null };
  if (!ink) return result;
  const L = len + 1;
  // ink at (u along the gap from its start, depth v >= 1 away from the gap) on side +1 or -1
  const at = (u, v, side) => {
    const x = alongX ? minX + u : side > 0 ? maxX + v : minX - v;
    const y = alongX ? (side > 0 ? maxY + v : minY - v) : minY + u;
    if (x < 0 || y < 0 || x >= w || y >= h || kind[y * w + x] === KIND.WALL) return 0;
    return ink[y * w + x];
  };
  const square = (side) => {
    let total = 0, rows = 0, deepU = 0, deepS = 0, shallowU = 0, shallowS = 0;
    for (let v = 1; v <= L; v++) {
      let row = 0;
      for (let u = -1; u <= len; u++) {
        const q = at(u, v, side);
        row += q;
        if (v > L / 2) { deepU += u * q; deepS += q; } else { shallowU += u * q; shallowS += q; }
      }
      total += row;
      if (row > 0.02) rows++;
    }
    return { total, coverage: rows / L, deep: deepS ? deepU / deepS : null, shallow: shallowS ? shallowU / shallowS : null };
  };
  const A = square(-1), B = square(+1);
  const sideB = B.total > A.total;
  const S = sideB ? B : A, O = sideB ? A : B;
  // an arc reaches every depth of the square; text or furniture usually doesn't
  if (S.total < 0.04 * L || S.coverage < 0.6 || S.deep === null || S.shallow === null) return result;
  // the deep half of the drawing (leaf + top of the arc) sits nearer the hinge than the shallow half
  const hingeAtStart = S.deep < S.shallow;
  const mid = alongX ? (minY + maxY + 1) / 2 : (minX + maxX + 1) / 2;
  const hingeU = hingeAtStart ? -fStart : len + fEnd;
  const hinge = alongX ? [minX + hingeU, mid] : [mid, minY + hingeU];
  // zone on the swing side, a little past the gap
  const probe = alongX
    ? [Math.round((minX + maxX) / 2), sideB ? maxY + 2 : minY - 2]
    : [sideB ? maxX + 2 : minX - 2, Math.round((minY + maxY) / 2)];
  const pz = probe[0] >= 0 && probe[1] >= 0 && probe[0] < w && probe[1] < h ? zone[probe[1] * w + probe[0]] : 0;
  const pk = probe[0] >= 0 && probe[1] >= 0 && probe[0] < w && probe[1] < h ? kind[probe[1] * w + probe[0]] : KIND.OUTSIDE;
  result.swing = {
    into: pz > 0 ? `Z${pz}` : pk === KIND.OUTSIDE ? 'outside' : null,
    toward: alongX ? (sideB ? '+y' : '-y') : (sideB ? '+x' : '-x'),
    hinge: hinge.map((v) => v * c),
    confidence: Math.round(((S.total - O.total) / (S.total + O.total)) * Math.min(1, S.coverage / 0.8) * 100) / 100,
  };
  return result;
}

// Shortest walking distance from every walkable cell to the nearest exit (metres).
// 8-connected, no cutting corners past walls. Infinity = no way out.
export function exitDistances(seg) {
  const { w, h, kind } = seg;
  const c = seg.params.cellM;
  const walk = (i) => kind[i] === KIND.FLOOR || kind[i] === KIND.DOOR || kind[i] === KIND.EXIT;
  const dist = new Float64Array(w * h).fill(Infinity);
  const heap = new MinHeap();
  for (let i = 0; i < w * h; i++) if (kind[i] === KIND.EXIT) { dist[i] = 0; heap.push(0, i); }
  const D = Math.SQRT2 * c;
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!walk(j)) continue;
      if (dx && dy && (!walk(y * w + nx) || !walk(ny * w + x))) continue;
      const nd = d + (dx && dy ? D : c);
      if (nd < dist[j]) { dist[j] = nd; heap.push(nd, j); }
    }
  }
  return dist;
}

// Things a person should check before trusting the model.
export function findIssues(site, seg, base, dist, opts) {
  const o = { ...EGRESS_DEFAULTS, ...opts };
  const out = [];
  const add = (severity, code, message, at = null, ref = null) => out.push({ severity, code, message, at, ref });
  const { w, h } = seg;
  const c = seg.params.cellM;

  if (!base.source.scaleKnown) {
    const n = o.scaleCount;
    if (o.scaleFrom === 'rooms') add('info', 'scale-from-rooms', `The scale was set from ${n} room size${n > 1 ? 's' : ''} printed on the plan.`);
    else if (o.scaleFrom === 'doors') add('warning', 'scale-from-doors', `The scale was estimated from ${n} doors, assuming door openings are about 0.9 m wide. Type the building width or one room's size to confirm it.`);
    else if (o.scaleFrom === 'walls') add('warning', 'scale-guessed', 'The scale is a rough guess from wall thickness. Type the building width, or set it from a room with a known size.');
    else add('warning', 'scale-typed', `The scale comes from the building width you typed (${seg.params.planWidthM} m). Measure one known dimension to confirm it.`);
  }
  if (base.source.unitsGuessed) add('warning', 'units-guessed', `The drawing has no units, so ${base.source.unitsGuessed} were assumed.`);

  const doorsOf = new Map(site.zones.map((z) => [z.id, []]));
  for (const d of site.doors) for (const z of d.connects) doorsOf.get(z)?.push(d);
  for (const op of site.openings || []) for (const z of op.between) doorsOf.get(z)?.push(op); // open plan

  for (const z of site.zones) {
    if (!doorsOf.get(z.id).length) {
      add('critical', 'no-door', `${z.name} has no door. People there cannot leave, or a door was missed.`, z.centroid, z.id);
    }
    if (z.area_m2 < 4) add('info', 'small-room', `${z.name} is only ${z.area_m2} m². It may be a duct, a cupboard or furniture.`, z.centroid, z.id);
    if (z.merged_labels) {
      add('warning', 'merged-rooms', `${z.merged_labels.join(' and ')} read as one room: a wide opening joins them. Paint a door across it in Fix plan to split them.`, z.centroid, z.id);
    }
    if (z.printed_area_m2) {
      const measured = z.printed_group_area_m2 ?? z.area_m2;
      const what = z.printed_covers ? `${z.name} with the open space around it` : z.name;
      const diff = (measured - z.printed_area_m2) / z.printed_area_m2;
      if (Math.abs(diff) > 0.1) {
        add('warning', 'area-mismatch', `${what} measures ${measured} m² but the plan says ${z.printed_area_m2} m² (${Math.round(diff * 100)}%). Check the scale or the walls.`, z.centroid, z.id);
      }
    }
    const e = site.egress?.zones?.[z.id];
    if (e && !Number.isFinite(e.max_m)) {
      add('critical', 'no-exit-route', `${z.name} has no route to an exit.`, z.centroid, z.id);
    } else if (e && e.max_m > o.maxTravelM) {
      add('warning', 'travel-distance', `${z.name}: the farthest point is ${e.max_m} m from an exit, over the ${o.maxTravelM} m limit.`, e.worst, z.id);
    }
  }
  if (!site.exits.length) add('critical', 'no-exit', 'No exit found. Mark the exit doors in Fix plan.');

  for (const d of site.doors) {
    if (d.width_m < o.minDoorM) {
      add(d.is_exit ? 'warning' : 'info', 'narrow-door', `${d.id} is ${d.width_m} m wide. Doors on an escape route need about ${o.minDoorM} m clear width.`, [d.x, d.y], d.id);
    }
    if (d.is_exit && d.width_m > 2.5 && !d.swing) {
      // roller / sectional doors don't count as escape doors
      add('info', 'wide-exit', `${d.id} is a ${d.width_m} m opening, likely a roller door. It usually doesn't count as an escape exit.`, [d.x, d.y], d.id);
    } else if (!d.swing) {
      add('info', 'swing-unknown', `${d.id}: no door leaf drawn, so the swing direction is unknown.`, [d.x, d.y], d.id);
    } else {
      if (d.swing.confidence < 0.4) add('info', 'swing-unsure', `${d.id}: swing direction is unsure (${Math.round(d.swing.confidence * 100)}%).`, [d.x, d.y], d.id);
      if (d.is_exit && d.swing.into !== 'outside') {
        add('warning', 'exit-swings-in', `Exit ${d.id} opens inwards. Exit doors for more than 50 people or high-hazard areas must open outwards (NFPA 101 7.2.1.4.2).`, [d.x, d.y], d.id);
      }
    }
  }
  for (const a of seg.ambiguous || []) {
    let sx = 0, sy = 0;
    for (const i of a.cells) { sx += i % w; sy += (i / w) | 0; }
    const at = [round2((sx / a.cells.length + 0.5) * c), round2((sy / a.cells.length + 0.5) * c)];
    add('info', 'door-or-window', `This gap could be a ${a.chosen === 'window' ? 'door' : 'window'}; it was read as a ${a.chosen}.`, at);
  }
  void h;
  const order = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  out.forEach((x, k) => { x.id = `I${k + 1}`; });
  return out;
}

export function egressSummary(seg, dist, zones) {
  const { w, zone } = seg;
  const c = seg.params.cellM;
  const per = {};
  for (const z of zones) per[z.id] = { max_m: -1, worst: null };
  let overall = 0;
  for (let i = 0; i < dist.length; i++) {
    if (zone[i] <= 0) continue;
    const e = per[`Z${zone[i]}`];
    if (!e) continue;
    const d = dist[i];
    if (d > e.max_m) { e.max_m = d; e.worst = [round2((i % w + 0.5) * c), round2((((i / w) | 0) + 0.5) * c)]; }
  }
  for (const e of Object.values(per)) {
    if (Number.isFinite(e.max_m)) { e.max_m = round2(e.max_m); overall = Math.max(overall, e.max_m); }
    else e.max_m = null;
  }
  // JSON has no Infinity: unreachable zones get max_m null
  for (const e of Object.values(per)) if (e.max_m === null) e.max_m = Infinity;
  return { max_travel_m: overall, zones: per };
}

// Clear width of a gap measured on the pixel wall mask: the shortest wall-to-wall run
// along the gap, over lines spread across the wall's thickness.
function pixelWidth(base, alongX, minX, minY, maxX, maxY, c) {
  const m = base.wallMask, src = base.source;
  if (!m || !src.cellPx) return null;
  const W = src.widthPx, H = src.heightPx, cp = src.cellPx, [ox, oy] = src.originPx;
  const toPx = (g, o) => o + g * cp;
  const cx = Math.round(toPx((minX + maxX + 1) / 2, ox)), cy = Math.round(toPx((minY + maxY + 1) / 2, oy));
  const t0 = alongX ? toPx(minY, oy) : toPx(minX, ox), t1 = alongX ? toPx(maxY + 1, oy) : toPx(maxX + 1, ox);
  const maxRun = (Math.max(maxX - minX, maxY - minY) + 4) * cp;
  let best = Infinity;
  for (let k = 1; k < 8; k++) {
    const t = Math.round(t0 + ((t1 - t0) * k) / 8);
    const wall = (u) => {
      const x = alongX ? u : t, y = alongX ? t : u;
      return x < 0 || y < 0 || x >= W || y >= H || m[y * W + x];
    };
    const start = alongX ? cx : cy;
    if (wall(start)) continue;
    let a = start, b = start;
    while (!wall(a - 1) && start - a < maxRun) a--;
    while (!wall(b + 1) && b - start < maxRun) b++;
    // only count lines that hit wall on both sides (inside the wall's thickness)
    if (start - a >= maxRun || b - start >= maxRun) continue;
    best = Math.min(best, b - a + 1);
  }
  return Number.isFinite(best) ? best / src.pxPerM : null;
  void c;
}

function neighbours(i, w, h, fn) {
  const x = i % w, y = (i / w) | 0;
  if (x > 0) fn(i - 1);
  if (x < w - 1) fn(i + 1);
  if (y > 0) fn(i - w);
  if (y < h - 1) fn(i + w);
}
const round2 = (v) => Math.round(v * 100) / 100;

class MinHeap {
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
