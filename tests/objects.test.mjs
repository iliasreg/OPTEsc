// Objects and stairs read from DXF plans drawn with different layer conventions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dxfObjects } from '../frontend/src/vector.js';

const dir = new URL('./fixtures/', import.meta.url);
const truth = JSON.parse(fs.readFileSync(new URL('plans.json', dir), 'utf8'));
const centre = (poly) => poly.reduce(([a, b], [x, y]) => [a + x / poly.length, b + y / poly.length], [0, 0]);
const near = (p, q, d) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= d;

for (const [name, t] of Object.entries(truth)) {
  test(`${name}: every object found once, in the right category, nothing extra`, () => {
    const found = dxfObjects(fs.readFileSync(new URL(`${name}.dxf`, dir), 'utf8'));
    const objects = found.filter((o) => o.kind === 'object');
    assert.equal(objects.length, t.objects.length);
    for (const o of t.objects) {
      const hit = objects.filter((f) => near(centre(f.polygon), o.at, 0.3));
      assert.equal(hit.length, 1, `${o.category} at ${o.at}`);
      assert.equal(hit[0].category, o.category);
    }
  });
  test(`${name}: every stair flight found with its step count`, () => {
    const stairs = dxfObjects(fs.readFileSync(new URL(`${name}.dxf`, dir), 'utf8')).filter((o) => o.kind === 'stair');
    assert.equal(stairs.length, t.stairs.length);
    for (const s of t.stairs) {
      const hit = stairs.find((f) => near(centre(f.polygon), s.at, 0.6));
      assert.ok(hit, `flight at ${s.at}`);
      assert.ok(Math.abs(hit.treads - s.treads) <= 1, `${hit.treads} steps, expected ${s.treads}`);
    }
  });
}

test('sample factory: the five machines on A-EQPM', () => {
  const found = dxfObjects(fs.readFileSync(new URL('../frontend/samples/factory_plan.dxf', import.meta.url), 'utf8'));
  assert.equal(found.filter((o) => o.category === 'machine').length, 5);
});

// A 12 m x 8 m hall, one exit in the east wall, and a row of machines across the middle
// with a 1.5 m gap: people walk round the machines, never through them.
test('simulation: people walk round furniture and still get out', async () => {
  const { simulate, prepare } = await import('../frontend/src/sim.js');
  const { objectCells } = await import('../frontend/src/objects.js');
  const c = 0.25, W = 12, H = 8, w = W / c + 4, h = H / c + 4;
  const cells = [], zone_ids = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += x < 1 || y < 1 || x >= w - 1 || y >= h - 1 ? 'o' : x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? '#' : '.';
    cells.push(row.split(''));
  }
  const exit = [];
  for (let y = 2 + 3 / c; y < 2 + 4 / c; y++) { cells[y][w - 2] = 'E'; exit.push([w - 2, y]); }
  for (let y = 0; y < h; y++) zone_ids.push(cells[y].map((ch) => (ch === '.' ? 1 : 0)));
  const off = 2 * c;
  const machine = (x0, y0, x1, y1) => ({ kind: 'object', category: 'machine', height_m: 1.6, polygon: [[off + x0, off + y0], [off + x1, off + y0], [off + x1, off + y1], [off + x0, off + y1]] });
  const site = {
    grid: { cell_m: c, w, h, cells: cells.map((r) => r.join('')), zone_ids },
    zones: [{ id: 'Z1', name: 'Hall', type: 'production', area_m2: W * H, centroid: [W / 2 + off, H / 2 + off] }],
    doors: [{ id: 'D1', x: (w - 1.5) * c, y: off + 3.5, width_m: 1, is_exit: true, connects: ['outside', 'Z1'], cells: exit }],
    objects: [machine(6, 0, 7, 3), machine(6, 4.5, 7, 8)],
  };
  const g = prepare(site);
  const blocked = new Set(site.objects.flatMap((o) => objectCells(site.grid, o)));
  assert.ok([...blocked].every((i) => g.kind[i] === 6), 'machine floor is an obstacle');
  const r = simulate(site, { fire: [1 + off, 1 + off], total: 40, fireSpeed: 0.01 });
  assert.equal(r.metrics.out, 40);
  for (const pos of r.frames.pos) for (let k = 0; k < pos.length; k += 2) {
    assert.ok(!blocked.has(Math.floor(pos[k + 1] / c) * w + Math.floor(pos[k] / c)), 'nobody inside a machine');
  }
  // with the gap closed, people west of the machines cannot reach the exit
  const shut = { ...site, objects: [machine(6, 0, 7, 8)] };
  const r2 = simulate(shut, { fire: [1 + off, 1 + off], total: 40, fireSpeed: 0.01, maxTime: 120 });
  assert.ok(r2.metrics.trapped > 0);
});
