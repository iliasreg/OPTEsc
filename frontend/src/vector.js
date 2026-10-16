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
function flatten(dxf) {
  const out = { lines: [], fills: [], texts: [] };
  const walk = (ents, tf, depth, inheritLayer) => {
    let poly = null;
    for (const e of ents) {
      const layer = e.layer === '0' && inheritLayer ? inheritLayer : e.layer;
      const P = ([x, y]) => tf(x, y);
      switch (e.type) {
        case 'LINE':
          if (e.pts[0]) out.lines.push({ layer, pts: [P(e.pts[0]), tf(e.x2, e.y2)] });
          break;
        case 'LWPOLYLINE':
          out.lines.push({ layer, pts: bulgePts(e.pts, e.bulges, e.flags & 1).map(P), closed: !!(e.flags & 1) });
          break;
        case 'POLYLINE': poly = { layer, pts: [], bulges: [], closed: !!(e.flags & 1) }; break;
        case 'VERTEX': if (poly && e.pts[0]) { poly.pts.push(e.pts[0]); poly.bulges[poly.pts.length - 1] = e.bulges[0]; } break;
        case 'SEQEND':
          if (poly) out.lines.push({ layer: poly.layer, pts: bulgePts(poly.pts, poly.bulges, poly.closed).map(P), closed: poly.closed });
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
          out.lines.push({ layer, pts, arc: true });
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
          walk(b.entities, inner, depth + 1, layer);
          break;
        }
        default:
      }
    }
  };
  walk(dxf.entities, (x, y) => [x, y], 0, null);
  return out;
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
  return {
    canvas: cv, pxPerM, texts,
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
