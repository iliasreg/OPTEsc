// Vector plans: DXF (exact units) and PDF (scale from a "1:100" note or typed in).
// Both are drawn onto a canvas at a known pixels-per-metre, so the same plan reader
// runs on them, and their text gives room names and printed areas.

const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 }; // $INSUNITS -> metres
const WALL_LAYER = /wall|mur|wand|muro|parete|a-wall|walls/i;
const AREA_RE = /(\d+(?:[.,]\d+)?)\s*(?:m²|m2|sq\.?\s*m|㎡)/i;

// ---------- DXF ----------

export function parseDxf(text) {
  if (!/^\s*0\r?\nSECTION\s*$/m.test(text) || !/^\s*0\r?\nEOF\s*$/m.test(text)) throw new Error('Invalid DXF: expected an ASCII DXF drawing.');
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
  let units = 0;
  const blocks = new Map();
  const entities = [];
  let section = null, block = null, cur = null;
  const flush = () => { if (cur) (block ? block.entities : entities).push(cur); cur = null; };
  for (let k = 0; k < pairs.length; k++) {
    const [code, val] = pairs[k];
    if (code === 0) {
      flush();
      if (val === 'SECTION') { section = pairs[k + 1]?.[1]; continue; }
      if (val === 'ENDSEC') { section = null; continue; }
      if (section === 'BLOCKS' && val === 'BLOCK') { block = { name: '', base: [0, 0], entities: [] }; cur = { type: 'BLOCKHDR' }; continue; }
      if (section === 'BLOCKS' && val === 'ENDBLK') { if (block) blocks.set(block.name, block); block = null; continue; }
      if (section === 'ENTITIES' || (section === 'BLOCKS' && block)) cur = { type: val, layer: '0', pts: [], bulges: [], edges: [] };
      continue;
    }
    if (section === 'HEADER' && val === '$INSUNITS') { units = parseInt(pairs[k + 1][1], 10); continue; }
    if (!cur) continue;
    if (cur.type === 'BLOCKHDR') {
      if (code === 2) block.name = val;
      if (code === 10) block.base[0] = +val;
      if (code === 20) block.base[1] = +val;
      continue;
    }
    readCode(cur, code, val);
  }
  flush();
  return { units, blocks, entities };
}

function readCode(e, code, val) {
  const v = parseFloat(val);
  switch (code) {
    case 8: e.layer = val; break;
    case 1: case 3: e.text = (e.text || '') + val; break;
    case 2: e.name = val; break;
    case 10:
      if (e.type === 'HATCH' && e.inEdges) e.edges.push({ x: v });
      else e.pts.push([v, 0]);
      break;
    case 20:
      if (e.type === 'HATCH' && e.inEdges) e.edges[e.edges.length - 1].y = v;
      else if (e.pts.length) e.pts[e.pts.length - 1][1] = v;
      break;
    case 11: e.x2 = v; break;
    case 21: e.y2 = v; break;
    case 40: e.r = e.r ?? v; e.h = e.h ?? v; break;
    case 41: e.sx = v; break;
    case 42: if (e.type === 'LWPOLYLINE' || e.type === 'VERTEX') e.bulges[e.pts.length - 1] = v; else e.sy = v; break;
    case 50: e.a0 = v; e.rot = v; break;
    case 51: e.a1 = v; break;
    case 70: e.flags = parseInt(val, 10); break;
    case 91: if (e.type === 'HATCH') { e.inEdges = true; e.hatchPaths = (e.hatchPaths || 0); } break;
    case 92: if (e.type === 'HATCH') { e.hatchPaths++; e.edges.push({ newPath: true }); } break;
    default:
  }
}

// Flatten entities (with block inserts) into polylines, arcs and texts in drawing units.
// Each line keeps the top-level insert it came from (`ins`) and the block names on the way
// down (`block`), so a chair drawn as a block stays one object.
function flatten(dxf) {
  const out = { lines: [], fills: [], texts: [] };
  let inserts = 0;
  const walk = (ents, tf, depth, inheritLayer, ins = null, block = '') => {
    let poly = null;
    const tag = (o) => (ins == null ? o : Object.assign(o, { ins, block }));
    for (const e of ents) {
      const layer = e.layer === '0' && inheritLayer ? inheritLayer : e.layer;
      const P = ([x, y]) => tf(x, y);
      switch (e.type) {
        case 'LINE':
          if (e.pts[0]) out.lines.push(tag({ layer, pts: [P(e.pts[0]), tf(e.x2, e.y2)] }));
          break;
        case 'LWPOLYLINE':
          out.lines.push(tag({ layer, pts: bulgePts(e.pts, e.bulges, e.flags & 1).map(P), closed: !!(e.flags & 1) }));
          break;
        case 'POLYLINE': poly = { layer, pts: [], bulges: [], closed: !!(e.flags & 1) }; break;
        case 'VERTEX': if (poly && e.pts[0]) { poly.pts.push(e.pts[0]); poly.bulges[poly.pts.length - 1] = e.bulges[0]; } break;
        case 'SEQEND':
          if (poly) out.lines.push(tag({ layer: poly.layer, pts: bulgePts(poly.pts, poly.bulges, poly.closed).map(P), closed: poly.closed }));
          poly = null;
          break;
        case 'ARC': case 'CIRCLE': {
          const [cx, cy] = e.pts[0] || [0, 0];
          let a0 = e.type === 'CIRCLE' ? 0 : e.a0 ?? 0, a1 = e.type === 'CIRCLE' ? 360 : e.a1 ?? 360;
          if (a1 < a0) a1 += 360;
          const n = Math.max(8, Math.ceil((a1 - a0) / 6));
          const pts = [];
          for (let k = 0; k <= n; k++) {
            const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
            pts.push(tf(cx + e.r * Math.cos(a), cy + e.r * Math.sin(a)));
          }
          out.lines.push(tag({ layer, pts, arc: true, ...(e.type === 'CIRCLE' ? { circle: true } : {}) }));
          break;
        }
        case 'TEXT': case 'MTEXT':
          if (e.pts[0] && e.text) out.texts.push({ layer, text: cleanText(e.text), at: P(e.pts[0]) });
          break;
        case 'HATCH': {
          // polyline boundaries (and line edges) only
          let path = [];
          const paths = [];
          for (const ed of e.edges) {
            if (ed.newPath) { if (path.length) paths.push(path); path = []; continue; }
            if (ed.x !== undefined && ed.y !== undefined) path.push(tf(ed.x, ed.y));
          }
          if (path.length) paths.push(path);
          for (const pth of paths) if (pth.length >= 3) out.fills.push({ layer, pts: pth });
          break;
        }
        case 'INSERT': {
          const b = dxf.blocks.get(e.name);
          if (!b || depth > 8 || !e.pts[0]) break;
          const [ix, iy] = e.pts[0];
          const sx = e.sx ?? 1, sy = e.sy ?? 1, r = ((e.rot ?? 0) * Math.PI) / 180;
          const cos = Math.cos(r), sin = Math.sin(r);
          const inner = (x, y) => {
            const lx = (x - b.base[0]) * sx, ly = (y - b.base[1]) * sy;
            return tf(ix + lx * cos - ly * sin, iy + lx * sin + ly * cos);
          };
          walk(b.entities, inner, depth + 1, layer, ins ?? inserts++, block ? `${block}/${e.name}` : e.name);
          break;
        }
        default:
      }
    }
  };
  walk(dxf.entities, (x, y) => [x, y], 0, null);
  return out;
}

// ---------- objects and stairs ----------
//
// Furniture, machines and stairs are thin linework, so the wall reader drops them. They are
// read here from the vector data instead: by layer or block name (AIA, French, German,
// Spanish, Italian, Dutch conventions), and stairs also by their shape (a run of evenly
// spaced parallel treads), so a flight drawn on an unnamed layer is still found.

const STAIR_RE = /stair|strs|escal|treppe|stufe|\btrap(pen)?\b|escada|escaler|\bmarches?\b|\bsteps?\b/i;
const RAMP_RE = /\bramp|rampe|rampa/i;
const FURN_LAYER = /furn|mobil|m[öo]e?bel|meub|muebl|arred|eqp|equip|machin|fixt|casework|plumb|sanit|appl|inventar|einricht|am[ée]nag|\bfur\b|\bmob\b/i;
const SKIP_LAYER = /wall|\bmur|wand|door|porte|t[üu]r\b|window|fen[eê]tre|fenster|anno|text|dim|cote|grid|axe|hatch|hach|title|cartouche|viewport|defpoints|\barea|room|space|zone|pi[eè]ce|raum|north|nord/i;
const SKIP_BLOCK = /door|porte|t[üu]r\b|window|fen[eê]tre|fenster|north|nord|arrow|fl[eè]che|section|title|cartouche|grid|axis|level|niveau|tag|label/i;
// [category, name pattern, height in metres]
export const OBJECT_TYPES = [
  ['seat', /chair|chaise|seat|si[eè]ge|stuhl|sofa|canap|couch|bench|banc|fauteuil|stool|tabouret|sessel/i, 0.9],
  ['table', /table|desk|bureau|tisch|schreib|workstation|poste|counter|comptoir|worktop|plan.?de.?travail|mesa|tavolo/i, 0.75],
  ['storage', /shelf|shelv|[ée]tag[eè]re|rack|rayonnage|cabinet|armoire|wardrobe|cupboard|placard|schrank|regal|locker|casier|filing|bookcase|biblioth|estanter/i, 2.0],
  ['bed', /\bbed|\blit\b|\bbett|\bcama\b|letto/i, 0.55],
  ['sanitary', /\bwc|toilet|lavabo|sink|[ée]vier|basin|bath|baignoire|shower|douche|urinal|bidet|wasch|dusche/i, 0.85],
  ['kitchen', /fridge|frigo|refrig|oven|\bfour\b|stove|cuisini[eè]re|\bhob\b|dishwash|lave.?vaisselle|k[üu]hl|\bherd\b/i, 0.9],
  ['machine', /machin|eqp|equip|press|lathe|\btour\b|cnc|robot|conveyor|convoyeur|compress|generat|transfo|boiler|chaudi|maschin/i, 1.6],
];
const RISER_M = 0.17; // typical riser height

function categoryOf(name) {
  for (const [cat, re, hgt] of OBJECT_TYPES) if (re.test(name)) return { category: cat, height_m: hgt };
  return null;
}

// Segments of a polyline in metres, y up (drawing frame).
function segsOf(line, k) {
  const out = [];
  for (let i = 0; i + 1 < line.pts.length; i++) out.push([line.pts[i][0] * k, line.pts[i][1] * k, line.pts[i + 1][0] * k, line.pts[i + 1][1] * k]);
  if (line.closed && line.pts.length > 2) {
    const a = line.pts[line.pts.length - 1], b = line.pts[0];
    out.push([a[0] * k, a[1] * k, b[0] * k, b[1] * k]);
  }
  return out;
}

function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Smallest rectangle around a set of points (its sides follow one hull edge).
// Returns { corners: [4 points], u: unit vector along the first side, len: [side u, side v] }.
export function minRect(points) {
  const hp = hull(points);
  if (hp.length < 2) return null;
  let best = null;
  for (let i = 0; i < hp.length; i++) {
    const a = hp[i], b = hp[(i + 1) % hp.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hp) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uy, u0, u1, v0, v1 } = best;
  const P = (u, v) => [u * ux - v * uy, u * uy + v * ux];
  return { corners: [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], u: [ux, uy], len: [u1 - u0, v1 - v0] };
}

// Union-find clusters of segments whose bounding boxes come within `tol` metres.
function clusters(segs, tol) {
  const n = segs.length, parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const box = segs.map(([x0, y0, x1, y1]) => [Math.min(x0, x1) - tol, Math.min(y0, y1) - tol, Math.max(x0, x1) + tol, Math.max(y0, y1) + tol]);
  // sweep on x so big drawings stay fast
  const order = [...box.keys()].sort((a, b) => box[a][0] - box[b][0]);
  for (let s = 0; s < n; s++) {
    const i = order[s];
    for (let t = s + 1; t < n; t++) {
      const j = order[t];
      if (box[j][0] > box[i][2]) break;
      if (box[j][1] <= box[i][3] && box[j][3] >= box[i][1]) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  return [...groups.values()];
}

// Stair flights in a set of segments: at least `minTreads` parallel segments of about the
// same length (0.6 to 3 m), evenly spaced one tread apart (0.2 to 0.45 m), side by side.
// Returns [{ corners, u (direction of travel), treads, segs: [indices] }].
export function findFlights(segs, minTreads = 4) {
  const items = [];
  segs.forEach(([x0, y0, x1, y1], i) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 0.6 || L > 3) return;
    let a = Math.atan2(y1 - y0, x1 - x0);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    items.push({ i, L, a, mx: (x0 + x1) / 2, my: (y0 + y1) / 2 });
  });
  const used = new Set(), flights = [];
  // group by direction (2 degree bins, neighbours merged)
  const bins = new Map();
  for (const it of items) { const b = Math.round((it.a * 180) / Math.PI / 2) % 90; if (!bins.has(b)) bins.set(b, []); bins.get(b).push(it); }
  for (const [b, list0] of bins) {
    const list = [...list0, ...(bins.get((b + 1) % 90) || []).filter((it) => Math.abs(it.a - list0[0].a) < 0.06)];
    if (list.length < minTreads) continue;
    const a = list0[0].a, tx = Math.cos(a), ty = Math.sin(a); // tread direction
    const nx = -ty, ny = tx; // travel direction
    // sort along the travel direction, then grow runs of evenly spaced, overlapping treads
    list.sort((p, q) => (p.mx * nx + p.my * ny) - (q.mx * nx + q.my * ny));
    const pos = (p) => p.mx * nx + p.my * ny, along = (p) => p.mx * tx + p.my * ty;
    for (const seed of list) {
      if (used.has(seed.i)) continue;
      const run = [seed];
      let step = null;
      for (const q of list) {
        if (used.has(q.i) || run.includes(q)) continue;
        const last = run[run.length - 1];
        const d = pos(q) - pos(last);
        if (d < 0.15) continue;
        if (d > 0.5) break;
        if (Math.abs(q.L - seed.L) > 0.15 * seed.L || Math.abs(along(q) - along(seed)) > 0.25 * seed.L) continue;
        if (d < 0.2 || d > 0.45 || (step && Math.abs(d - step) > 0.25 * step)) continue;
        step ??= d;
        run.push(q);
      }
      if (run.length < minTreads || run.length > 31) continue;
      for (const q of run) used.add(q.i);
      const pts = run.flatMap((q) => { const s = segs[q.i]; return [[s[0], s[1]], [s[2], s[3]]]; });
      const r = minRect(pts);
      // the flight runs from its first nosing line to its last: one step between each pair
      const p0 = pos(run[0]), p1 = pos(run[run.length - 1]);
      const a0 = along(seed) - seed.L / 2, a1 = along(seed) + seed.L / 2;
      const P = (u, v) => [u * nx + v * tx, u * ny + v * ty];
      flights.push({ corners: [P(p0, a0), P(p1, a0), P(p1, a1), P(p0, a1)], u: [nx, ny], treads: run.length - 1, going_m: step, width_m: seed.L, segs: run.map((q) => q.i), rect: r });
    }
  }
  return flights;
}

// Objects and stairs of a flattened drawing, in metres in the drawing frame (y up).
export function extractObjects(flat, unitM) {
  const k = unitM;
  const lines = flat.lines.filter((l) => l.pts.length >= 2 && !SKIP_LAYER.test(l.layer) && !(l.block && SKIP_BLOCK.test(l.block)));
  const isStair = (l) => STAIR_RE.test(l.layer) || (l.block && STAIR_RE.test(l.block));
  const isRamp = (l) => RAMP_RE.test(l.layer) || (l.block && RAMP_RE.test(l.block));
  const objects = [];

  // 1. stairs: named stair linework, clustered (treads rarely touch each other)
  const stairLines = lines.filter(isStair), taken = new Set();
  const stairSegs = [], segLine = [];
  stairLines.forEach((l) => { for (const s of segsOf(l, k)) { stairSegs.push(s); segLine.push(l); } });
  for (const group of clusters(stairSegs, 0.45)) {
    const segs = group.map((i) => stairSegs[i]);
    const flights = findFlights(segs, 3);
    for (const f of flights) objects.push(stairObject(f, 'layer'));
    if (!flights.length) {
      // a stair symbol without readable treads: keep its outline
      const r = minRect(segs.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]]));
      if (r && r.len[0] * r.len[1] > 0.5) {
        const along = r.len[0] >= r.len[1] ? 0 : 1;
        const c = along ? [r.corners[1], r.corners[2], r.corners[3], r.corners[0]] : r.corners;
        const L = r.len[along];
        objects.push({ kind: 'stair', source: 'layer', polygon: c, treads: Math.max(3, Math.round(L / 0.28)), going_m: 0.28, width_m: r.len[1 - along] });
      }
    }
    for (const i of group) taken.add(segLine[i]);
  }
  // ramps: one outline each
  for (const group of groupLines(lines.filter((l) => !taken.has(l) && isRamp(l)), k, 0.3)) {
    const r = minRect(group.flatMap((l) => segsOf(l, k).flatMap((s) => [[s[0], s[1]], [s[2], s[3]]])));
    if (r && r.len[0] * r.len[1] > 1) objects.push({ kind: 'ramp', source: 'layer', polygon: r.corners });
    for (const l of group) taken.add(l);
  }

  // 2. stairs by shape among the other linework (stairs drawn on layer 0 or a furniture layer)
  const rest = lines.filter((l) => !taken.has(l));
  const restSegs = [], restLine = [];
  rest.forEach((l) => { if (l.arc) return; for (const s of segsOf(l, k)) { restSegs.push(s); restLine.push(l); } });
  for (const f of findFlights(restSegs, 5)) {
    objects.push(stairObject(f, 'shape'));
    for (const i of f.segs) taken.add(restLine[i]);
    // stringers and the walking line inside the flight belong to it too
    const r = f.corners;
    restSegs.forEach((s, i) => { if (insideQuad(r, (s[0] + s[2]) / 2, (s[1] + s[3]) / 2, 0.1)) taken.add(restLine[i]); });
  }

  // 3. furniture and machines: one object per block insert, or per connected group of lines
  const furn = lines.filter((l) => !taken.has(l) && (FURN_LAYER.test(l.layer) || (l.block && categoryOf(l.block))));
  const byInsert = new Map(), loose = [];
  for (const l of furn) {
    if (l.ins != null) { if (!byInsert.has(l.ins)) byInsert.set(l.ins, []); byInsert.get(l.ins).push(l); } else loose.push(l);
  }
  const groups = [...byInsert.values(), ...groupLines(loose, k, 0.02)];
  for (const g of groups) {
    const pts = g.flatMap((l) => l.pts.map(([x, y]) => [x * k, y * k]));
    const r = minRect(pts);
    if (!r) continue;
    const [a, b] = r.len, area = a * b;
    if (area < 0.04 || Math.max(a, b) > 25 || Math.min(a, b) < 0.05) continue;
    const name = `${g[0].block || ''} ${g[0].layer}`;
    const cat = categoryOf(g[0].block || '') || categoryOf(g[0].layer) || guessCategory(a, b, g[0].layer);
    // a single closed outline keeps its own shape (L-shaped desks, round tables)
    const own = g.length === 1 && (g[0].closed || g[0].circle) && g[0].pts.length >= 3 ? g[0].pts.map(([x, y]) => [x * k, y * k]) : null;
    objects.push({ kind: 'object', category: cat.category, height_m: cat.height_m, name: name.trim(), polygon: own && own.length <= 64 ? own : r.corners });
  }
  return objects;
}

function stairObject(f, source) {
  return { kind: 'stair', source, polygon: f.corners, treads: f.treads, going_m: round3(f.going_m), width_m: round3(f.width_m), rise_m: round3(f.treads * RISER_M) };
}
const round3 = (v) => Math.round(v * 1000) / 1000;

function groupLines(lines, k, tol) {
  const segs = [], owner = [];
  lines.forEach((l, i) => { for (const s of segsOf(l, k)) { segs.push(s); owner.push(i); } });
  const out = [];
  for (const g of clusters(segs, tol)) out.push([...new Set(g.map((i) => owner[i]))].map((i) => lines[i]));
  return out;
}

function guessCategory(a, b, layer) {
  const big = a * b, thin = Math.min(a, b);
  if (/eqp|equip|machin/i.test(layer) || big > 6) return { category: 'machine', height_m: 1.6 };
  if (thin < 0.7 && Math.max(a, b) > 1.2) return { category: 'storage', height_m: 2.0 };
  if (big < 0.5) return { category: 'seat', height_m: 0.9 };
  return { category: 'table', height_m: 0.75 };
}

function insideQuad(q, x, y, tol = 0) {
  // q is a rectangle: test against its two side directions
  const [a, b, , d] = q;
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  const pu = ((x - a[0]) * ux + (y - a[1]) * uy) / lu, pv = ((x - a[0]) * vx + (y - a[1]) * vy) / lv;
  return pu >= -tol && pu <= lu + tol && pv >= -tol && pv <= lv + tol;
}

// Objects and stairs straight from DXF text, in metres (drawing frame, y up).
export function dxfObjects(text) {
  const dxf = parseDxf(text);
  const flat = flatten(dxf);
  return extractObjects(flat, unitOf(dxf, flat));
}

function unitOf(dxf, flat) {
  if (UNIT_M[dxf.units]) return UNIT_M[dxf.units];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of [...flat.lines, ...flat.fills]) for (const [x, y] of e.pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  return span > 2000 ? 0.001 : span > 300 ? 0.01 : 1;
}

function bulgePts(pts, bulges, closed) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    out.push(pts[i]);
    const b = bulges[i];
    if (!b || (!closed && i === n - 1)) continue;
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    const ang = 4 * Math.atan(b), d = Math.hypot(x1 - x0, y1 - y0);
    if (!d) continue;
    const r = d / (2 * Math.sin(ang / 2));
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const hgt = r * Math.cos(ang / 2);
    const nx = -(y1 - y0) / d, ny = (x1 - x0) / d;
    const cx = mx + nx * hgt, cy = my + ny * hgt;
    const s = Math.atan2(y0 - cy, x0 - cx);
    const steps = Math.max(4, Math.ceil(Math.abs(ang) / 0.1));
    for (let k = 1; k < steps; k++) {
      const a = s + (ang * k) / steps;
      out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)]);
    }
  }
  return out;
}

function cleanText(t) {
  return t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '').replace(/%%c/gi, 'ø').trim();
}

// Draw a DXF onto a canvas. Wall layers are drawn solid and thick enough to read as walls.
export function renderDxf(text, { wallLayers = null, wallStrokeM = 0.12, maxPx = 2600 } = {}) {
  const dxf = parseDxf(text);
  const flat = flatten(dxf);
  const layerNames = [...new Set([...flat.lines, ...flat.fills].map((e) => e.layer))];
  const walls = new Set(wallLayers || layerNames.filter((l) => WALL_LAYER.test(l)));
  const guessed = !UNIT_M[dxf.units];
  // bounding box of geometry
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of [...flat.lines, ...flat.fills]) for (const [x, y] of e.pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) throw new Error('This DXF has no lines or polylines.');
  const span = Math.max(maxX - minX, maxY - minY);
  // no units in the header: guess from the size of the drawing
  const unitM = UNIT_M[dxf.units] ?? (span > 2000 ? 0.001 : span > 300 ? 0.01 : 1);
  const spanM = span * unitM;
  const pxPerM = Math.min(60, Math.max(15, maxPx / spanM));
  const pad = 40;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((maxX - minX) * unitM * pxPerM + 2 * pad);
  cv.height = Math.ceil((maxY - minY) * unitM * pxPerM + 2 * pad);
  const toPx = ([x, y]) => [pad + (x - minX) * unitM * pxPerM, pad + (maxY - y) * unitM * pxPerM]; // flip y
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#000';
  for (const f of flat.fills) {
    if (!walls.has(f.layer)) continue;
    ctx.beginPath();
    f.pts.forEach((p, k) => { const [x, y] = toPx(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
  }
  for (const l of flat.lines) {
    // closed outlines on a wall layer are the wall itself: fill them
    if (walls.has(l.layer) && l.closed && l.pts.length >= 3) {
      ctx.beginPath();
      l.pts.forEach((p, k) => { const [x, y] = toPx(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fill();
      continue;
    }
    // open lines on a wall layer are usually the two faces of a wall: thicken them so they merge
    const isWall = walls.has(l.layer) && !l.arc;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = isWall ? Math.max(2, wallStrokeM * pxPerM) : 1;
    ctx.beginPath();
    l.pts.forEach((p, k) => { const [x, y] = toPx(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (l.closed) ctx.closePath();
    ctx.stroke();
  }
  const texts = flat.texts.map((t) => ({ text: t.text, x: toPx(t.at)[0], y: toPx(t.at)[1] }));
  // objects and stairs, from metres back to canvas pixels
  const toPxM = ([x, y]) => toPx([x / unitM, y / unitM]);
  const objects = extractObjects(flat, unitM).map((o) => ({ ...o, polygon: o.polygon.map(toPxM) }));
  return {
    canvas: cv, pxPerM, texts, objects,
    layers: layerNames.map((name) => ({ name, wall: walls.has(name) })),
    unitsGuessed: guessed ? (unitM === 0.001 ? 'millimetres' : unitM === 0.01 ? 'centimetres' : 'metres') : null,
  };
}

// ---------- PDF ----------

let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

export async function renderPdf(buffer, { page: pageNo = 1, maxPx = 3000, scaleDenom = 0 } = {}) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: buffer }).promise;
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const zoom = maxPx / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale: zoom });
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const content = await page.getTextContent();
  const texts = content.items.filter((t) => t.str.trim()).map((t) => {
    const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
    const hgt = (t.height || Math.hypot(t.transform[2], t.transform[3])) * zoom;
    // box around the printed letters, so they are not mistaken for door leaves or glazing
    return { text: t.str.trim(), x, y, box: [x - 1, y - hgt * 1.05, x + t.width * zoom + 1, y + hgt * 0.3] };
  });
  // drawing scale from a note such as "1:100" or "SCALE 1 : 50"
  let denom = scaleDenom;
  if (!denom) {
    for (const t of texts) {
      const m = /\b1\s*:\s*(\d{2,4})\b/.exec(t.text);
      if (m) { denom = parseInt(m[1], 10); break; }
    }
  }
  // PDF user units are points: 72 per inch of paper
  const pxPerM = denom ? (zoom * 72) / 0.0254 / denom : 0;
  return { canvas: cv, pxPerM, texts, scaleDenom: denom || null, pages: doc.numPages };
}

// ---------- text -> label hints ----------

// Room names and printed areas from plan text, as hints at image pixels.
// An area text joins the closest name text within `joinPx`.
export function textHints(texts, pxPerM) {
  const names = [], areas = [];
  for (const t of texts) {
    const m = AREA_RE.exec(t.text);
    if (m) {
      areas.push({ x: t.x, y: t.y, area: parseFloat(m[1].replace(',', '.')) });
      const rest = t.text.replace(AREA_RE, '').trim();
      if (rest.length > 1) names.push({ x: t.x, y: t.y, name: rest });
    } else if (/[A-Za-zÀ-ÿ]{3,}/.test(t.text) && !/\b1\s*:\s*\d+/.test(t.text) && t.text.length < 40) {
      names.push({ x: t.x, y: t.y, name: t.text });
    }
  }
  const joinPx = (pxPerM || 30) * 2.5;
  const hints = names.map((n) => ({ name: titleCase(n.name), type: guessType(n.name), x: n.x, y: n.y }));
  for (const a of areas) {
    let best = null, bd = joinPx;
    for (const hnt of hints) {
      const d = Math.hypot(hnt.x - a.x, hnt.y - a.y);
      if (d < bd && hnt.printedArea === undefined) { bd = d; best = hnt; }
    }
    if (best) best.printedArea = a.area;
    else hints.push({ name: null, type: null, x: a.x, y: a.y, printedArea: a.area });
  }
  return hints;
}

function titleCase(s) {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : s;
}

const TYPES = [
  [/office|kontor|bureau|büro|meeting|reception/i, 'office'], [/stor|lager|warehouse|stock|klk|förråd/i, 'storage'],
  [/load|dock|bay|quai/i, 'loading_bay'], [/corridor|hall(?!$)|passage|entr|hallway|couloir/i, 'corridor'],
  [/production|workshop|atelier|factory|line|hall$/i, 'production'],
  [/canteen|kitchen|kök|wc|toilet|bath|locker|vestiaire|changing|rest|badrum|dusch|sovrum|vardagsrum/i, 'welfare'],
];
function guessType(name) {
  for (const [re, t] of TYPES) if (re.test(name)) return t;
  return 'unknown';
}
