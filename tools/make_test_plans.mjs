// Small DXF plans drawn the way different offices draw them, to check that objects and stairs
// are read from any of them, not just the sample factory.
//   node tools/make_test_plans.mjs tests/fixtures
// writes <name>.dxf and plans.json (what each plan holds: the truth the tests compare with).
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'tests/fixtures';
fs.mkdirSync(out, { recursive: true });

// ---------- a minimal ASCII DXF writer (R12 entities, LWPOLYLINE) ----------
class Dxf {
  constructor(unitsCode, scale) { this.units = unitsCode; this.k = scale; this.ents = []; this.blocks = []; }
  _p(code, v) { return `${code}\n${v}\n`; }
  line(layer, [x0, y0], [x1, y1], into = this.ents) {
    const k = this.k;
    into.push(`0\nLINE\n8\n${layer}\n10\n${x0 * k}\n20\n${-y0 * k}\n30\n0\n11\n${x1 * k}\n21\n${-y1 * k}\n31\n0\n`);
  }
  poly(layer, pts, closed = true, into = this.ents) {
    const k = this.k;
    let s = `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n`;
    for (const [x, y] of pts) s += `10\n${x * k}\n20\n${-y * k}\n`;
    into.push(s);
  }
  rect(layer, x, y, w, h, into) { this.poly(layer, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, into); }
  circle(layer, [x, y], r, into = this.ents) { const k = this.k; into.push(`0\nCIRCLE\n8\n${layer}\n10\n${x * k}\n20\n${-y * k}\n30\n0\n40\n${r * k}\n`); }
  arc(layer, [x, y], r, a0, a1, into = this.ents) { const k = this.k; into.push(`0\nARC\n8\n${layer}\n10\n${x * k}\n20\n${-y * k}\n30\n0\n40\n${r * k}\n50\n${a0}\n51\n${a1}\n`); }
  text(layer, [x, y], h, t) { const k = this.k; this.ents.push(`0\nTEXT\n8\n${layer}\n10\n${x * k}\n20\n${-y * k}\n30\n0\n40\n${h * k}\n1\n${t}\n`); }
  // a block drawn around (0, 0) in metres; returns the name
  block(name, draw) { const body = []; draw(body); this.blocks.push({ name, body }); return name; }
  insert(layer, name, [x, y], rot = 0) { const k = this.k; this.ents.push(`0\nINSERT\n8\n${layer}\n2\n${name}\n10\n${x * k}\n20\n${-y * k}\n30\n0\n50\n${-rot}\n`); }
  toString() {
    let s = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${this.units}\n0\nENDSEC\n`;
    s += '0\nSECTION\n2\nBLOCKS\n';
    for (const b of this.blocks) s += `0\nBLOCK\n8\n0\n2\n${b.name}\n70\n0\n10\n0\n20\n0\n30\n0\n${b.body.join('')}0\nENDBLK\n8\n0\n`;
    s += '0\nENDSEC\n0\nSECTION\n2\nENTITIES\n' + this.ents.join('') + '0\nENDSEC\n0\nEOF\n';
    return s;
  }
}

// walls as filled outlines: a list of [x0, y0, x1, y1] centre lines with gaps cut for doors
function walls(d, layer, list, t) {
  for (const [x0, y0, x1, y1] of list) {
    const h = t / 2;
    if (y0 === y1) d.rect(layer, Math.min(x0, x1) - h, y0 - h, Math.abs(x1 - x0) + t, t);
    else d.rect(layer, x0 - h, Math.min(y0, y1) - h, t, Math.abs(y1 - y0) + t);
  }
}
// a wall from a to b along x or y with door gaps [start, width] cut out
function cut(a, b, fixed, horizontal, gaps) {
  const segs = [];
  let s = a;
  for (const [g, w] of [...gaps].sort((p, q) => p[0] - q[0])) { if (g > s) segs.push([s, g]); s = g + w; }
  if (s < b) segs.push([s, b]);
  return segs.map(([p, q]) => (horizontal ? [p, fixed, q, fixed] : [fixed, p, fixed, q]));
}
// a straight flight of `n` treads, `going` apart, `width` wide, going +x (or +y) from (x, y)
function flight(d, layer, x, y, n, going, width, alongX = true, into) {
  for (let i = 0; i <= n; i++) {
    if (alongX) d.line(layer, [x + i * going, y], [x + i * going, y + width], into);
    else d.line(layer, [x, y + i * going], [x + width, y + i * going], into);
  }
  // stringers
  if (alongX) { d.line(layer, [x, y], [x + n * going, y], into); d.line(layer, [x, y + width], [x + n * going, y + width], into); }
  else { d.line(layer, [x, y], [x, y + n * going], into); d.line(layer, [x + width, y], [x + width, y + n * going], into); }
}
function doorLeaf(d, layer, hinge, w, a0) { d.line(layer, hinge, [hinge[0] + w * Math.cos((a0 * Math.PI) / 180), hinge[1] - w * Math.sin((a0 * Math.PI) / 180)]); d.arc(layer, [hinge[0], hinge[1]], w, a0, a0 + 90); }

const plans = [];

// 1. French office floor, millimetres: MURS / PORTES / MOBILIER / ESCALIER / SANITAIRE
{
  const d = new Dxf(4, 1000);
  const W = 24, H = 14;
  const L = 'MURS';
  walls(d, L, [
    ...cut(0, W, 0, true, []), ...cut(0, W, H, true, [[2, 1.2]]),
    ...cut(0, H, 0, false, []), ...cut(0, H, W, false, [[6, 1.0]]),
    ...cut(0, H, 8, false, [[3, 0.9], [10, 0.9]]), ...cut(0, 8, 7, true, [[3, 0.9]]),
    ...cut(8, W, 8, true, [[12, 0.9], [19, 0.9]]), ...cut(8, H, 16, false, []),
  ], 0.2);
  doorLeaf(d, 'PORTES', [8, 3], 0.9, 0);
  const desk = d.block('BUREAU_160', (b) => d.rect('0', -0.8, -0.4, 1.6, 0.8, b));
  const chair = d.block('CHAISE', (b) => { d.rect('0', -0.25, -0.25, 0.5, 0.5, b); d.line('0', [-0.25, -0.3], [0.25, -0.3], b); });
  const wc = d.block('WC', (b) => { d.rect('0', -0.2, -0.35, 0.4, 0.2, b); d.circle('0', [0, 0.05], 0.2, b); });
  const items = [];
  for (const [x, y] of [[11, 2], [11, 5], [14, 2], [14, 5], [19, 2], [19, 5]]) {
    d.insert('MOBILIER', desk, [x, y]); d.insert('MOBILIER', chair, [x, y + 0.9]);
    items.push(['table', x, y], ['seat', x, y + 0.9]);
  }
  d.insert('SANITAIRE', wc, [2, 1]); d.insert('SANITAIRE', wc, [3, 1]);
  items.push(['sanitary', 2, 1], ['sanitary', 3, 1]);
  // straight stair of 14 treads in the stair hall (x 17..21.2, y 10..11.2)
  flight(d, 'ESCALIER', 17, 10, 14, 0.28, 1.2, true);
  d.text('TEXTE', [10, 7], 0.3, 'BUREAUX 120 m2');
  plans.push({ name: 'office_fr', dxf: d, objects: items, stairs: [{ treads: 14, at: [17 + 7 * 0.28, 10.6] }] });
}

// 2. German school wing, centimetres: WAND / TUER / MOEBEL / TREPPE, loose tables, a U stair
{
  const d = new Dxf(5, 100);
  const W = 30, H = 16;
  walls(d, 'WAND', [
    ...cut(0, W, 0, true, []), ...cut(0, W, H, true, [[14, 1.5]]),
    ...cut(0, H, 0, false, [[7, 1.0]]), ...cut(0, H, W, false, []),
    ...cut(0, W, 9, true, [[4, 1.0], [12, 1.0], [20, 1.0]]),
    ...cut(0, 9, 10, false, []), ...cut(0, 9, 20, false, []),
  ], 0.25);
  const items = [];
  // tables as loose closed outlines on MOEBEL, 3 rows in each classroom
  for (const x0 of [1.5, 11.5]) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const x = x0 + c * 2.6, y = 1.5 + r * 2.2;
    d.rect('MOEBEL', x, y, 1.4, 0.7);
    items.push(['table', x + 0.7, y + 0.35]);
  }
  const shelf = d.block('REGAL_200', (b) => d.rect('0', -1, -0.2, 2, 0.4, b));
  d.insert('MOEBEL', shelf, [5, 8.4]); d.insert('MOEBEL', shelf, [15, 8.4]);
  items.push(['storage', 5, 8.4], ['storage', 15, 8.4]);
  // U stair: two flights of 9 treads side by side, a landing between
  flight(d, 'TREPPE', 22, 1, 9, 0.29, 1.3, false);
  flight(d, 'TREPPE', 23.5, 1, 9, 0.29, 1.3, false);
  d.rect('TREPPE', 22, 3.61, 2.8, 1.4);
  plans.push({ name: 'school_de', dxf: d, objects: items, stairs: [{ treads: 9, at: [22.65, 2.3] }, { treads: 9, at: [24.15, 2.3] }] });
}

// 3. Hotel floor in metres, AIA layers: A-WALL / A-DOOR / A-FURN / A-FLOR-STRS, rotated blocks, L stair
{
  const d = new Dxf(6, 1);
  const W = 28, H = 12;
  walls(d, 'A-WALL', [
    ...cut(0, W, 0, true, []), ...cut(0, W, H, true, [[26, 1.0]]),
    ...cut(0, H, 0, false, [[5, 1.2]]), ...cut(0, H, W, false, []),
    ...cut(0, W, 5, true, [[2, 0.9], [9, 0.9], [16, 0.9]]),
    ...cut(0, 5, 7, false, []), ...cut(0, 5, 14, false, []), ...cut(0, 5, 21, false, []),
  ], 0.2);
  const bed = d.block('BED-DOUBLE', (b) => { d.rect('0', -0.8, -1, 1.6, 2, b); d.rect('0', -0.7, -0.95, 0.6, 0.35, b); d.rect('0', 0.1, -0.95, 0.6, 0.35, b); });
  const ward = d.block('WARDROBE', (b) => d.rect('0', -0.6, -0.3, 1.2, 0.6, b));
  const items = [];
  for (const x of [3.5, 10.5, 17.5]) {
    d.insert('A-FURN', bed, [x, 2.2], 90); d.insert('A-FURN', ward, [x + 2.2, 4.3]);
    items.push(['bed', x, 2.2], ['storage', x + 2.2, 4.3]);
  }
  // L stair: 7 treads along x, landing, 6 treads along y
  flight(d, 'A-FLOR-STRS', 21.5, 6, 7, 0.27, 1.1, true);
  flight(d, 'A-FLOR-STRS', 23.39, 7.1, 6, 0.27, 1.1, false);
  plans.push({ name: 'hotel_aia', dxf: d, objects: items, stairs: [{ treads: 7, at: [22.45, 6.55] }, { treads: 6, at: [23.94, 7.9] }] });
}

// 4. Workshop with almost no layer discipline: walls on WALLS, everything else on layer 0.
//    The stair has to be found by its shape; the floor-tile grid and the racks must not be.
{
  const d = new Dxf(6, 1);
  const W = 30, H = 20;
  walls(d, 'WALLS', [
    ...cut(0, W, 0, true, [[4, 3.5]]), ...cut(0, W, H, true, [[20, 1.0]]),
    ...cut(0, H, 0, false, []), ...cut(0, H, W, false, [[10, 1.0]]),
    ...cut(0, 12, 12, false, [[6, 1.0]]), ...cut(0, 12, 12, true, []),
  ], 0.3);
  // stair to a mezzanine: 12 treads drawn as plain lines on layer 0
  for (let i = 0; i <= 12; i++) d.line('0', [20 + i * 0.25, 2], [20 + i * 0.25, 3.0]);
  // floor tiles 0.1 m apart and long rack lines 1.4 m apart: neither is a stair
  for (let i = 0; i < 20; i++) d.line('0', [2 + i * 0.1, 14], [3.5, 14 + i * 0.05]);
  for (let i = 0; i < 6; i++) d.line('0', [14, 6 + i * 1.4], [26, 6 + i * 1.4]);
  plans.push({ name: 'workshop_layer0', dxf: d, objects: [], stairs: [{ treads: 12, at: [21.5, 2.5] }] });
}

// 5. Walls, doors and notes only: nothing should be found.
{
  const d = new Dxf(4, 1000);
  walls(d, 'A-WALL', [...cut(0, 12, 0, true, []), ...cut(0, 12, 8, true, [[5, 1]]), ...cut(0, 8, 0, false, []), ...cut(0, 8, 12, false, [])], 0.2);
  doorLeaf(d, 'A-DOOR', [5, 8], 1, 0);
  const north = d.block('NORTH_ARROW', (b) => { d.circle('0', [0, 0], 0.5, b); d.line('0', [0, -0.5], [0, 0.5], b); });
  d.insert('A-ANNO', north, [14, 1]);
  d.text('A-ANNO', [4, 4], 0.3, 'HALL 90 m2');
  // dimension ticks drawn as lines on a DIM layer
  for (let i = 0; i < 10; i++) d.line('A-DIMS', [i * 0.3, -1], [i * 0.3, -1.6]);
  plans.push({ name: 'walls_only', dxf: d, objects: [], stairs: [] });
}

const truth = {};
for (const p of plans) {
  fs.writeFileSync(path.join(out, `${p.name}.dxf`), p.dxf.toString());
  truth[p.name] = { objects: p.objects.map(([category, x, y]) => ({ category, at: [x, -y] })), stairs: p.stairs.map((s) => ({ treads: s.treads, at: [s.at[0], -s.at[1]] })) };
}
fs.writeFileSync(path.join(out, 'plans.json'), JSON.stringify(truth, null, 1));
console.log(`wrote ${plans.length} plans to ${out}`);
