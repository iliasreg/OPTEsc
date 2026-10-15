// Plan image -> OPTEsc site grid (walls, doors, exits, zones).
//
// Two stages so the editor can re-run the second one cheaply:
//   1. readPlan(imageData, params)  pixels -> base wall grid (+ scale)
//   2. segment(base, edits, params) wall grid -> zones, doors, exits, site JSON
//
// Coordinates: grid cell (gx, gy), gx to the right, gy down (image order).
// Metres: x = gx * cell_m, y = gy * cell_m from the grid's top-left corner.

export const DEFAULTS = {
  planWidthM: 40,     // real width of the building's outer walls, in metres
  pxPerM: 0,          // known scale (vector plans); overrides planWidthM when set
  cellM: 0.25,        // grid resolution
  lineFilterPx: 0,    // ignore dark strokes thinner than this (0 = auto)
  wallFill: 0.15,     // share of a cell that must be wall pixels to count as wall
  maxDoorM: 1.2,      // gaps up to this width are doors between rooms
  maxJambM: 0.7,      // a door opening is at most this deep (wall thickness plus frame)
  maxOpeningM: 5,     // outer-wall gaps up to this width are exits (roller doors)
  minRoomM2: 0.8,     // smaller enclosed areas are merged into neighbours
  windowInk: 0.08,    // gaps crossed by this much thin linework are windows, not doors
};

import { zoneAreas, measureDoor, exitDistances, egressSummary, findIssues } from './analyze.js';

// Cell kinds in the grid layer.
export const KIND = { OUTSIDE: 0, FLOOR: 1, WALL: 2, DOOR: 3, EXIT: 4, WINDOW: 5 };
// Editor overrides.
export const EDIT = { NONE: 0, WALL: 1, FLOOR: 2, DOOR: 3 };

// ---------- stage 1: pixels -> wall grid ----------

function dropTextBlobs(m, w, h, boxes) {
  const seen = new Uint8Array(w * h), stack = [], comp = [];
  for (const [bx0, by0, bx1, by1] of boxes) {
    const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(w - 1, Math.ceil(bx1)), y1 = Math.min(h - 1, Math.ceil(by1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const s = y * w + x;
      if (!m[s] || seen[s]) continue;
      comp.length = 0; stack.push(s); seen[s] = 1;
      let inside = true;
      while (stack.length) {
        const c = stack.pop(), cx = c % w, cy = (c - cx) / w;
        comp.push(c);
        if (cx < x0 - 1 || cx > x1 + 1 || cy < y0 - 1 || cy > y1 + 1) { inside = false; if (comp.length > 50000) break; }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy, n = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      stack.length = 0;
      if (inside) for (const c of comp) m[c] = 0;
    }
  }
  return m;
}

export function readPlan(img, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const { width: w, height: h, data } = img;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    // transparent pixels count as white paper
    gray[i] = Math.round((0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a));
  }
  // walls are drawn dark; colour-filled rooms must not pull the threshold up into the floor tints
  const thr = Math.min(otsu(gray), 160);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i] <= thr ? 1 : 0;

  const k = p.lineFilterPx > 0 ? Math.round(p.lineFilterPx) : autoLineFilter(dark, w, h);
  // morphological opening removes text, door arcs and thin outlines, keeps walls
  let walls;
  if (p.wallMask) {
    // walls found by the AI wall finder (one byte per pixel, 1 = wall); the drawing still gives
    // the thin linework for door leaves and window glazing
    walls = p.wallMask;
  } else {
    walls = k > 1 ? dilate(erode(dark, w, h, k, k, 0), w, h, k, k) : dark;
    // large bold text survives the opening: drop wall blobs that lie wholly inside a text box
    if (p.nameBoxes?.length) walls = dropTextBlobs(walls === dark ? dark.slice() : walls, w, h, p.nameBoxes);
  }

  // bounding box of wall pixels sets the scale
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (walls[y * w + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error('No walls found in this image. Try a lower line filter or a cleaner plan.');

  const scaleKnown = p.pxPerM > 0;
  const pxPerM = scaleKnown ? p.pxPerM : (maxX - minX + 1) / p.planWidthM;
  const cellPx = p.cellM * pxPerM;
  const margin = Math.max(2, Math.ceil(1.5 / p.cellM)); // room for door arcs drawn outside
  const x0 = minX - margin * cellPx, y0 = minY - margin * cellPx;
  const gw = Math.ceil((maxX - minX + 1) / cellPx) + 2 * margin;
  const gh = Math.ceil((maxY - minY + 1) / cellPx) + 2 * margin;

  // integral image for fast per-cell wall share
  const wallSum = integral(walls, w, h);
  // all linework, thin lines included, except printed text when its boxes are known
  let inkDark = dark;
  if (p.textBoxes?.length) {
    inkDark = dark.slice();
    for (const [bx0, by0, bx1, by1] of p.textBoxes) {
      for (let y = Math.max(0, Math.floor(by0)); y < Math.min(h, Math.ceil(by1)); y++) inkDark.fill(0, y * w + Math.max(0, Math.floor(bx0)), y * w + Math.min(w, Math.ceil(bx1)));
    }
  }
  const inkSum = integral(inkDark, w, h);
  const wall = new Uint8Array(gw * gh);
  const ink = new Float32Array(gw * gh); // share of thin linework per cell (window glazing, door arcs)
  const wallShare = new Float32Array(gw * gh); // share of wall pixels per cell, for sub-cell measurements
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const ax = Math.round(x0 + gx * cellPx), ay = Math.round(y0 + gy * cellPx);
    const bx = Math.round(x0 + (gx + 1) * cellPx), by = Math.round(y0 + (gy + 1) * cellPx);
    const area = Math.max(1, (bx - ax) * (by - ay));
    const wv = wallSum(ax, ay, bx, by);
    wallShare[gy * gw + gx] = wv / area;
    if (wv / area >= p.wallFill) wall[gy * gw + gx] = 1;
    ink[gy * gw + gx] = Math.max(0, inkSum(ax, ay, bx, by) - wv) / area;
  }

  return {
    w: gw, h: gh, wall, ink, wallShare, params: p,
    source: { widthPx: w, heightPx: h, pxPerM, cellPx, originPx: [x0, y0], lineFilterPx: k, wallsFrom: p.wallMask ? 'ai' : 'drawing', threshold: thr, scaleKnown, wallPx: medianThickness(walls, w, h), spanPx: maxX - minX + 1 },
    wallMask: walls, // pixel wall mask, for sub-cell measurements
  };
}

// ---------- stage 2: wall grid -> zones, doors, exits ----------

export function segment(base, edits = null, params = {}) {
  const p = { ...base.params, ...params };
  const { w, h } = base;
  const n = w * h;
  const wall = new Uint8Array(n);
  const painted = new Uint8Array(n); // user-painted doors
  for (let i = 0; i < n; i++) {
    const e = edits ? edits[i] : 0;
    wall[i] = e === EDIT.WALL ? 1 : e === EDIT.NONE ? base.wall[i] : 0;
    painted[i] = e === EDIT.DOOR ? 1 : 0;
  }

  // door gaps: short openings through a wall, found along rows and columns (see doorGaps)
  const doorGap = doorGaps(wall, w, h, Math.round(p.maxDoorM / p.cellM) + 1, Math.ceil(p.maxJambM / p.cellM), Math.max(2, Math.round(0.25 / p.cellM)));
  // a square closing of size k fills gaps up to k-1 cells wide
  const ko = Math.max(5, Math.ceil(p.maxOpeningM / p.cellM) + 1) | 1;
  const closedBig = close(wall, w, h, ko);

  // footprint = everything not reachable from the border through the big-closed mask
  const outside = flood(w, h, (i) => !closedBig[i], borderSeeds(w, h));
  const inFoot = (i) => !outside[i];

  // wide outer openings: free cells inside the footprint that touch the outside
  // directly (a wall of any thickness keeps interior cells one step away)
  const nearOut = dilate(outside, w, h, 3, 3);
  const wideExit = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (inFoot(i) && nearOut[i] && !wall[i] && !doorGap[i]) wideExit[i] = 1;

  // rooms: free cells inside the footprint, split at door gaps
  const barrier = (i) => wall[i] || doorGap[i] || painted[i] || wideExit[i] || outside[i];
  const zone = new Int32Array(n).fill(-1);
  const minCells = p.minRoomM2 / (p.cellM * p.cellM);
  const rooms = components(w, h, (i) => !barrier(i)).filter((c) => c.length >= minCells);
  rooms.sort((a, b) => b.length - a.length);
  rooms.forEach((c, k) => { for (const i of c) zone[i] = k + 1; });
  // open-plan spaces with several room names in them are split between the names
  const labels = toGridLabels(p.labels, base, zone, w, h);
  const zoneCount = splitByLabels(zone, w, h, rooms.length, labels, minCells, p);

  // gap cells: candidate doors
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) kind[i] = outside[i] ? KIND.OUTSIDE : wall[i] ? KIND.WALL : KIND.FLOOR;
  const gap = (i) => !wall[i] && inFoot(i) && (doorGap[i] || painted[i] || wideExit[i]);
  const doors = [];
  const ambiguous = []; // gaps whose glazing ink is close to the window threshold
  for (const comp of components(w, h, gap)) {
    const links = new Set();
    let hasPaint = false, inkSum = 0;
    const sides = [0, 0, 0, 0]; // room cells touching the gap from -x, +x, -y, +y
    for (const i of comp) {
      if (painted[i]) hasPaint = true;
      inkSum += base.ink ? base.ink[i] : 0;
      const x = i % w;
      if (x > 0 && zone[i - 1] > 0) sides[0]++;
      if (x < w - 1 && zone[i + 1] > 0) sides[1]++;
      if (i >= w && zone[i - w] > 0) sides[2]++;
      if (i < n - w && zone[i + w] > 0) sides[3]++;
      forNeighbours(i, w, h, (j) => {
        if (outside[j] && !wall[j]) links.add(0);
        else if (zone[j] > 0) links.add(zone[j]);
      });
    }
    const inkMean = inkSum / comp.length;
    // glazing lines make a window, unless a door leaf and swing arc are drawn beside the gap
    const isWindow = !hasPaint && inkMean >= p.windowInk
      && !(base.ink && (measureDoor(base, { w, h, zone, kind, params: p }, { cells: comp }).swing?.confidence ?? 0) >= 0.5);
    if (base.ink && !hasPaint && links.size >= 1 && inkMean > p.windowInk * 0.6 && inkMean < p.windowInk * 1.6) {
      ambiguous.push({ cells: comp, inkMean, chosen: isWindow ? 'window' : 'door' });
    }
    if (isWindow) {
      // glazing lines across the gap: a window, closed for walking
      for (const i of comp) kind[i] = KIND.WINDOW;
    } else if (links.size >= 2 || (hasPaint && links.size >= 1) || (links.size === 1 && !links.has(0) && ((sides[0] && sides[1]) || (sides[2] && sides[3])))) {
      // the last case: a doorway with the same room on both sides (two rooms already joined elsewhere)
      const isExit = links.has(0);
      for (const i of comp) kind[i] = isExit ? KIND.EXIT : KIND.DOOR;
      doors.push({ cells: comp, links: [...links].sort((a, b) => a - b), isExit });
    }
    // other gap cells are corners or alcoves: they join a room below
  }

  // give leftover free cells inside the footprint to the nearest room
  const queue = [];
  for (let i = 0; i < n; i++) if (zone[i] > 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    forNeighbours(i, w, h, (j) => {
      if (zone[j] === -1 && kind[j] === KIND.FLOOR && inFoot(j)) { zone[j] = zone[i]; queue.push(j); }
    });
  }
  for (let i = 0; i < n; i++) {
    if (zone[i] === -1 && kind[i] === KIND.FLOOR) kind[i] = KIND.OUTSIDE; // unreachable pocket
    if (kind[i] !== KIND.FLOOR) zone[i] = 0;
  }

  // where two rooms meet with no wall or door between them (open plan)
  const shared = new Map();
  for (let i = 0; i < n; i++) {
    if (zone[i] <= 0) continue;
    for (const j of [i + 1, i + w]) {
      if (j >= n || (j === i + 1 && (i + 1) % w === 0) || zone[j] <= 0 || zone[j] === zone[i]) continue;
      const a = Math.min(zone[i], zone[j]), b = Math.max(zone[i], zone[j]);
      shared.set(a * 65536 + b, (shared.get(a * 65536 + b) || 0) + 1);
    }
  }
  const openings = [...shared].map(([k, cells]) => ({ zones: [Math.floor(k / 65536), k % 65536], length_m: cells * p.cellM }));

  const { labels: _l, wallMask: _w, textBoxes: _t, nameBoxes: _n, ...plain } = p; // per-image data stays out of the site JSON
  return { w, h, kind, zone, doors, openings, ambiguous, zoneCount, params: plain, labelCells: labels, doorGap };
}

// Room-name labels (image pixels) -> zone cells. A label sitting on furniture lines or a wall
// snaps to the nearest room cell within 1 m.
function toGridLabels(labels, base, zone, w, h) {
  if (!labels?.length) return [];
  const { originPx: [ox, oy], cellPx } = base.source;
  const r = Math.ceil(1 / base.params.cellM);
  const out = [];
  for (const l of labels) {
    const gx = Math.floor((l.x - ox) / cellPx), gy = Math.floor((l.y - oy) / cellPx);
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || zone[y * w + x] <= 0) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = y * w + x; }
    }
    if (best >= 0) out.push({ ...l, cell: best });
  }
  return out;
}

// Split every zone that holds two or more room labels. First try straight cuts between wall ends
// (the line where a wall stops is where people see one room end); the shortest cut that separates
// the labels wins. When no such cut exists (one big open floor), the floor is shared out by
// walking distance to each label. Returns the new zone count.
function splitByLabels(zone, w, h, count, labels, minCells, p) {
  if (labels.length < 2) return count;
  const maxCut = Math.round(8 / p.cellM), reach = Math.max(1, Math.round(0.4 / p.cellM));
  const minRoomCells = Math.max(minCells, 1 / (p.cellM * p.cellM)); // a named room cut off is at least 2 m²
  let next = count + 1;
  for (let z = 1; z <= count; z++) {
    const mine = labels.filter((l) => zone[l.cell] === z);
    if (new Set(mine.map((l) => l.cell)).size < 2) continue;
    const cells = [];
    for (let i = 0; i < zone.length; i++) if (zone[i] === z) cells.push(i);
    split(cells, mine, z);
  }
  return next - 1;

  function split(cells, mine, id) {
    mine = mine.filter((l, k) => mine.findIndex((m) => m.cell === l.cell) === k);
    if (mine.length < 2) return;
    const inPart = new Uint8Array(zone.length);
    for (const i of cells) inPart[i] = 1;
    let best = null;
    const keep = Math.round(0.6 / p.cellM); // a cut never passes this close to a room name
    for (const cut of cutCandidates(inPart, cells)) {
      if (best && cut.score >= best.score) continue;
      if (mine.some((l) => cut.cells.some((i) => Math.abs((i % w) - (l.cell % w)) <= keep && Math.abs(((i / w) | 0) - ((l.cell / w) | 0)) <= keep))) continue;
      const parts = partsWithout(inPart, cells, cut.cells);
      const groups = parts.filter((pt) => mine.some((l) => pt.has(l.cell)));
      if (groups.length < 2 || groups.some((pt) => pt.size < 2 * minRoomCells)) continue;
      best = { ...cut, parts };
    }
    let pieces;
    if (best) {
      pieces = best.parts.map((pt) => [...pt]);
      // cut cells and unlabelled scraps join the labelled piece next to them
      const labelled = pieces.filter((pc) => mine.some((l) => pc.includes(l.cell)));
      pieces = growInto(labelled, cells, inPart);
    } else {
      pieces = growInto(mine.map((l) => [l.cell]), cells, inPart);
    }
    pieces.forEach((pc, k) => {
      const nid = k === 0 ? id : next++;
      for (const i of pc) zone[i] = nid;
      split(pc, mine.filter((l) => pc.includes(l.cell)), nid);
    });
  }

  // straight row/column runs across the part, kept where the run's ends change (a wall corner)
  function cutCandidates(inPart, cells) {
    const out = [];
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (const i of cells) { const x = i % w, y = (i / w) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    for (const horiz of [true, false]) {
      const [A0, A1, B0, B1] = horiz ? [minY, maxY, minX, maxX] : [minX, maxX, minY, maxY];
      const at = horiz ? (b, a) => a * w + b : (b, a) => b * w + a;
      const runsAt = (a) => {
        const runs = [];
        let b = B0;
        while (b <= B1) {
          if (!inPart[at(b, a)]) { b++; continue; }
          let e = b; while (e <= B1 && inPart[at(e, a)]) e++;
          runs.push(`${b},${e}`); b = e;
        }
        return runs;
      };
      const all = [];
      for (let a = A0; a <= A1; a++) all.push(runsAt(a));
      for (let a = A0; a <= A1; a++) {
        const prev = new Set(all[a - A0 - 1] || []), nextRow = new Set(all[a - A0 + 1] || []);
        for (const k of all[a - A0]) {
          const [s0, e] = k.split(',').map(Number);
          if (e - s0 > maxCut || (prev.has(k) && nextRow.has(k))) continue; // middle of a band of identical runs
          // both ends must be wall corners: the boundary turns there instead of running straight on
          const corner = (b) => {
            for (let t = 1; t <= reach; t++) if (inPart[at(b, a - t)] || inPart[at(b, a + t)]) return true;
            return false;
          };
          if (!corner(s0 - 1) || !corner(e)) continue;
          const cc = [];
          for (let t = s0; t < e; t++) cc.push(at(t, a));
          out.push({ cells: cc, len: e - s0 });
        }
      }
    }
    // shorter cuts first; among similar ones prefer a cut midway between the labels it separates
    for (const c of out) c.score = c.len;
    return out.sort((a, b) => a.score - b.score);
  }

  function partsWithout(inPart, cells, cut) {
    const blocked = new Set(cut), seen = new Uint8Array(zone.length), parts = [];
    for (const s of cells) {
      if (seen[s] || blocked.has(s)) continue;
      const part = new Set([s]); seen[s] = 1;
      const q = [s];
      while (q.length) {
        const i = q.pop();
        forNeighbours(i, w, h, (j) => { if (inPart[j] && !seen[j] && !blocked.has(j)) { seen[j] = 1; part.add(j); q.push(j); } });
      }
      parts.push(part);
    }
    return parts;
  }

  // Shares the part out by walking distance from each seed, where a step through a narrow place
  // costs more than a step across open floor. Pieces then meet at narrowings (doorways, the gap
  // between two wall ends) when there are any, and halfway between the labels when there are none.
  function growInto(seeds, cells, inPart) {
    const cap = Math.max(2, Math.round(0.8 / p.cellM));
    const clear = new Int32Array(zone.length);
    const q = [];
    for (const i of cells) {
      let edge = false;
      forNeighbours(i, w, h, (j) => { if (!inPart[j]) edge = true; });
      if (edge) { clear[i] = 1; q.push(i); }
    }
    for (let h0 = 0; h0 < q.length; h0++) {
      const i = q[h0];
      forNeighbours(i, w, h, (j) => { if (inPart[j] && !clear[j]) { clear[j] = clear[i] + 1; q.push(j); } });
    }
    const owner = new Int32Array(zone.length).fill(-1);
    const dist = new Float64Array(zone.length).fill(Infinity);
    const heap = [];
    const hpush = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const pa = (k - 1) >> 1; if (heap[pa][0] <= d) break; [heap[k], heap[pa]] = [heap[pa], heap[k]]; k = pa; } };
    const hpop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; let k = 0;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[k], heap[m]] = [heap[m], heap[k]]; k = m; }
      }
      return top;
    };
    seeds.forEach((pc, k) => { for (const i of pc) { owner[i] = k; dist[i] = 0; hpush(0, i); } });
    while (heap.length) {
      const [d, i] = hpop();
      if (d > dist[i]) continue;
      forNeighbours(i, w, h, (j) => {
        if (!inPart[j]) return;
        const nd = d + 1 + 4 * Math.max(0, cap - clear[j]) / cap;
        if (nd < dist[j]) { dist[j] = nd; owner[j] = owner[i]; hpush(nd, j); }
      });
    }
    const out = seeds.map(() => []);
    for (const i of cells) if (owner[i] >= 0) out[owner[i]].push(i);
    return out;
  }
}

// Build the site JSON shared with the simulation, heatmap and camera layers.
export function toSite(base, seg, meta = {}) {
  const { w, h, kind, zone, params: p } = seg;
  const c = p.cellM;
  const chars = ['o', '.', '#', 'D', 'E', 'W'];
  const rows = [], zoneRows = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    const zr = [];
    for (let x = 0; x < w; x++) { s += chars[kind[y * w + x]]; zr.push(zone[y * w + x]); }
    rows.push(s); zoneRows.push(zr);
  }
  const prev = new Map((meta.zones || []).map((z) => [z.id, z]));
  const areas = zoneAreas(base, seg);
  const zones = [];
  for (let k = 1; k <= seg.zoneCount; k++) {
    let count = 0, sx = 0, sy = 0;
    for (let i = 0; i < w * h; i++) if (zone[i] === k) { count++; sx += i % w; sy += (i / w) | 0; }
    if (!count) continue;
    const id = `Z${k}`;
    const old = prev.get(id) || {};
    zones.push({
      id,
      name: old.name || `Zone ${k}`,
      ...(old.name_src ? { name_src: old.name_src } : {}),
      type: old.type || 'unknown',
      area_m2: round2(areas[k]),
      grid_area_m2: round2(count * c * c),
      centroid: [round2((sx / count + 0.5) * c), round2((sy / count + 0.5) * c)],
      polygon: outline(zone, w, h, k).map(([x, y]) => [round2(x * c), round2(y * c)]),
    });
  }
  const doors = seg.doors.map((d, k) => {
    let sx = 0, sy = 0;
    for (const i of d.cells) { sx += i % w; sy += (i / w) | 0; }
    const m = measureDoor(base, seg, d);
    return {
      id: `D${k + 1}`,
      x: round2((sx / d.cells.length + 0.5) * c),
      y: round2((sy / d.cells.length + 0.5) * c),
      width_m: round2(m.width_m),
      along: m.along,
      connects: d.links.map((z) => (z === 0 ? 'outside' : `Z${z}`)),
      is_exit: d.isExit,
      swing: m.swing && { ...m.swing, hinge: m.swing.hinge.map(round2) },
      cells: d.cells.map((i) => [i % w, (i / w) | 0]),
    };
  });
  return {
    version: 1,
    id: meta.id || 'site-1',
    name: meta.name || 'Imported plan',
    units: 'm',
    grid: {
      cell_m: c, w, h,
      legend: { o: 'outside', '.': 'floor', '#': 'wall', D: 'door', E: 'exit door', W: 'window' },
      cells: rows,
      zone_ids: zoneRows,
    },
    zones,
    doors,
    exits: doors.filter((d) => d.is_exit).map((d) => d.id),
    // rooms that meet with no wall or door between them (open plan; the line between them is estimated)
    openings: (seg.openings || []).map((o) => ({ between: o.zones.map((z) => `Z${z}`), length_m: round2(o.length_m) })),
    pois: [], cameras: [], signs: [], extinguishers: [],
    source: {
      image: meta.image || null,
      kind: meta.kind || 'raster',
      scale_known: !!base.source.scaleKnown,
      walls_from: base.source.wallsFrom || 'drawing',
      px_per_m: round2(base.source.pxPerM),
      origin_px: base.source.originPx.map(round2),
      params: p,
    },
  };
}

// Add the room-and-door graph, exit travel distances and the issue list.
// Call after names and printed areas are known. Returns the distance grid for display.
export function analyzeSite(site, base, seg, opts = {}) {
  const dist = exitDistances(seg);
  site.egress = { limit_m: opts.maxTravelM ?? 45, ...egressSummary(seg, dist, site.zones) };
  site.graph = {
    nodes: [...site.zones.map((z) => ({ id: z.id, name: z.name, type: z.type, area_m2: z.area_m2 })), { id: 'outside', name: 'Outside' }],
    edges: [
      ...site.doors.map((d) => ({ door: d.id, a: d.connects[0], b: d.connects[1] ?? d.connects[0], width_m: d.width_m, is_exit: d.is_exit, opens_into: d.swing?.into ?? null })),
      ...(site.openings || []).map((o) => ({ open: true, a: o.between[0], b: o.between[1], width_m: o.length_m })),
    ],
  };
  site.issues = findIssues(site, seg, base, dist, opts);
  return dist;
}

// ---------- helpers ----------

// Door openings. A cell is in a door gap when, along a row (or column), it sits in a free run of at
// most `maxRun` cells with wall at both ends, and that same narrow run (same ends, +-1 cell) lasts at
// most `maxDepth` cells across, opening into wider space on both sides. Corridors and small rooms
// are narrow too, but they stay narrow for longer than a wall is thick, so they are not doors.
function doorGaps(wall, w, h, maxRun, maxDepth, reach) {
  const out = new Uint8Array(w * h);
  scan(w, h, (u, v) => v * w + u);
  scan(h, w, (u, v) => u * w + v);
  return out;

  // u runs along the opening, v across it
  function scan(U, V, at) {
    const ra = new Int32Array(U * V).fill(-1), rb = new Int32Array(U * V);
    const key = (u, v) => v * U + u;
    for (let v = 0; v < V; v++) {
      let u = 0;
      while (u < U) {
        if (wall[at(u, v)]) { u++; continue; }
        let b = u; while (b < U && !wall[at(b, v)]) b++;
        if (u > 0 && b < U && b - u <= maxRun) for (let k = u; k < b; k++) { ra[key(k, v)] = u; rb[key(k, v)] = b; }
        u = b;
      }
    }
    // free run length through (u, v), Infinity when it reaches the grid edge
    const runLen = (u, v) => {
      if (wall[at(u, v)]) return 0;
      let a = u, b = u;
      while (a > 0 && !wall[at(a - 1, v)]) a--;
      while (b < U - 1 && !wall[at(b + 1, v)]) b++;
      return a === 0 || b === U - 1 ? Infinity : b - a + 1;
    };
    for (let u = 0; u < U; u++) {
      let v = 0;
      while (v < V) {
        if (ra[key(u, v)] < 0) { v++; continue; }
        const v0 = v, a = ra[key(u, v)], b = rb[key(u, v)];
        let pa = a, pb = b;
        v++;
        while (v < V && ra[key(u, v)] >= 0 && Math.abs(ra[key(u, v)] - pa) <= 1 && Math.abs(rb[key(u, v)] - pb) <= 1) { pa = ra[key(u, v)]; pb = rb[key(u, v)]; v++; }
        if (v - v0 > maxDepth || v0 === 0 || v === V) continue;
        const len = b - a;
        // both sides must open into something wider: a room, a corridor, the outside
        if (!(runLen(u, v0 - 1) > len && runLen(u, v) > len)) continue;
        // and the walls either side of the opening must end there (jambs). If both run on past it,
        // this is a passage between two walls, not an opening through one.
        const jambEnds = (vv, ea, eb) => !(wall[at(ea - 1, vv)] && wall[at(eb, vv)]);
        if (!(jambEnds(v0 - 1, a, b) && jambEnds(v, pa, pb))) continue;
        // each side is either a jamb (its wall carries on away from the opening at every depth)
        // or a wall running across the opening and past it on both sides
        const side = (dir) => {
          let jamb = true;
          for (let k = v0; k < v && jamb; k++) {
            const e = dir < 0 ? ra[key(u, k)] - 1 : rb[key(u, k)];
            for (let t = 0; t < reach; t++) { const x = e + dir * t; if (x < 0 || x >= U || !wall[at(x, k)]) { jamb = false; break; } }
          }
          if (jamb) return true;
          const e0 = dir < 0 ? a - 1 : b, e1 = dir < 0 ? pa - 1 : pb;
          return wall[at(e0, v0 - 1)] && wall[at(e1, v)];
        };
        if (side(-1) && side(1)) for (let k = v0; k < v; k++) out[at(u, k)] = 1;
      }
    }
  }
}

// summed-area table; returns sum over [ax,bx) x [ay,by)
function integral(mask, w, h) {
  const t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      t[(y + 1) * (w + 1) + x + 1] = t[y * (w + 1) + x + 1] + row;
    }
  }
  return (ax, ay, bx, by) => {
    ax = clamp(ax, 0, w); bx = clamp(bx, 0, w); ay = clamp(ay, 0, h); by = clamp(by, 0, h);
    return t[by * (w + 1) + bx] - t[ay * (w + 1) + bx] - t[by * (w + 1) + ax] + t[ay * (w + 1) + ax];
  };
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return Math.min(thr, 200);
}

// Typical wall thickness in pixels (median over wall pixels of the shorter of the two runs).
function medianThickness(mask, w, h) {
  const hr = new Uint16Array(w * h), hist = new Float64Array(256);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) { x++; continue; }
      let e = x; while (e < w && mask[y * w + e]) e++;
      for (let i = x; i < e; i++) hr[y * w + i] = e - x;
      x = e;
    }
  }
  let total = 0;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) { y++; continue; }
      let e = y; while (e < h && mask[e * w + x]) e++;
      for (let i = y; i < e; i++) { hist[Math.min(255, hr[i * w + x], e - y)]++; total++; }
      y = e;
    }
  }
  let acc = 0;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= total / 2) return t; }
  return 0;
}

// Stroke thickness of each dark pixel = min(horizontal run, vertical run).
// Walls are the thick strokes; pick a filter just under the thinnest wall class.
function autoLineFilter(dark, w, h) {
  const hr = new Uint16Array(w * h), vr = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!dark[y * w + x]) { x++; continue; }
      let e = x; while (e < w && dark[y * w + e]) e++;
      for (let i = x; i < e; i++) hr[y * w + i] = e - x;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!dark[y * w + x]) { y++; continue; }
      let e = y; while (e < h && dark[e * w + x]) e++;
      for (let i = y; i < e; i++) vr[i * w + x] = e - y;
      y = e;
    }
  }
  const hist = new Float64Array(64);
  let total = 0;
  for (let i = 0; i < w * h; i++) if (dark[i]) {
    const t = Math.min(hr[i], vr[i]);
    if (t >= 3) { hist[Math.min(t, 63)]++; total++; }
  }
  if (!total) return 1;
  let acc = 0, tLow = 3;
  for (let t = 0; t < 64; t++) { acc += hist[t]; if (acc >= 0.08 * total) { tLow = t; break; } }
  return Math.max(3, Math.min(15, Math.floor(tLow * 0.75)));
}

// separable square min/max filters; `pad` is the value used outside the image
function erode(src, w, h, kx, ky, pad = 0) { return morph(src, w, h, kx, ky, true, pad); }
function dilate(src, w, h, kx, ky) { return morph(src, w, h, kx, ky, false, 0); }
function morph(src, w, h, kx, ky, isMin, pad) {
  const rx = kx >> 1, ry = ky >> 1;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // running count of ones in the window
    let cnt = 0, len = 0;
    for (let x = -rx; x <= rx; x++) { len++; cnt += x < 0 || x >= w ? pad : src[y * w + x]; }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = isMin ? (cnt === len ? 1 : 0) : (cnt > 0 ? 1 : 0);
      const xo = x - rx, xi = x + rx + 1;
      cnt -= xo < 0 || xo >= w ? pad : src[y * w + xo];
      cnt += xi < 0 || xi >= w ? pad : src[y * w + xi];
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0, len = 0;
    for (let y = -ry; y <= ry; y++) { len++; cnt += y < 0 || y >= h ? pad : tmp[y * w + x]; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = isMin ? (cnt === len ? 1 : 0) : (cnt > 0 ? 1 : 0);
      const yo = y - ry, yi = y + ry + 1;
      cnt -= yo < 0 || yo >= h ? pad : tmp[yo * w + x];
      cnt += yi < 0 || yi >= h ? pad : tmp[yi * w + x];
    }
  }
  return out;
}

// closing on a zero-padded copy so the image border does not act as a wall
function close(src, w, h, k) {
  const r = (k >> 1) + 1, pw = w + 2 * r, ph = h + 2 * r;
  const pad = new Uint8Array(pw * ph);
  for (let y = 0; y < h; y++) pad.set(src.subarray(y * w, y * w + w), (y + r) * pw + r);
  const c = erode(dilate(pad, pw, ph, k, k), pw, ph, k, k, 0);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(c.subarray((y + r) * pw + r, (y + r) * pw + r + w), y * w);
  return out;
}

function forNeighbours(i, w, h, fn) {
  const x = i % w, y = (i / w) | 0;
  if (x > 0) fn(i - 1);
  if (x < w - 1) fn(i + 1);
  if (y > 0) fn(i - w);
  if (y < h - 1) fn(i + w);
}
function touches(i, w, h, pred) {
  let hit = false;
  forNeighbours(i, w, h, (j) => { if (pred(j)) hit = true; });
  return hit;
}
function borderSeeds(w, h) {
  const s = [];
  for (let x = 0; x < w; x++) s.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) s.push(y * w, y * w + w - 1);
  return s;
}
function flood(w, h, pass, seeds) {
  const seen = new Uint8Array(w * h);
  const q = [];
  for (const s of seeds) if (pass(s) && !seen[s]) { seen[s] = 1; q.push(s); }
  for (let k = 0; k < q.length; k++) {
    forNeighbours(q[k], w, h, (j) => { if (!seen[j] && pass(j)) { seen[j] = 1; q.push(j); } });
  }
  return seen;
}
function components(w, h, pass) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !pass(i)) continue;
    const comp = [i];
    seen[i] = 1;
    for (let k = 0; k < comp.length; k++) {
      forNeighbours(comp[k], w, h, (j) => { if (!seen[j] && pass(j)) { seen[j] = 1; comp.push(j); } });
    }
    out.push(comp);
  }
  return out;
}

// Outer boundary of a labelled region as a polygon of grid-corner points.
function outline(label, w, h, k) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === k;
  const next = new Map(); // "x,y" -> list of [x,y] end points (clockwise edges)
  const add = (ax, ay, bx, by) => {
    const key = ax + ',' + ay;
    if (!next.has(key)) next.set(key, []);
    next.get(key).push([bx, by]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  let best = [];
  while (next.size) {
    const [startKey] = next.keys();
    const loop = [];
    let key = startKey;
    while (next.has(key)) {
      const list = next.get(key);
      const pt = list.pop();
      if (!list.length) next.delete(key);
      loop.push(key.split(',').map(Number));
      key = pt[0] + ',' + pt[1];
      if (key === startKey) break;
    }
    if (loop.length > best.length) best = loop;
  }
  // drop collinear points
  const out = [];
  for (let i = 0; i < best.length; i++) {
    const a = best[(i - 1 + best.length) % best.length], b = best[i], c = best[(i + 1) % best.length];
    if ((b[0] - a[0]) * (c[1] - b[1]) !== (b[1] - a[1]) * (c[0] - b[0])) out.push(b);
  }
  return out;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (v) => Math.round(v * 100) / 100;
