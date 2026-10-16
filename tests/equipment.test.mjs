// Projectors and cameras: every sign spot reachable, every door and nearly all the floor seen,
// on the sample factory and on halls of other sizes and layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { equipmentPlan, projectionTargets, reaches, cameraView, perceivedHazard, assignSigns, signScene, PROJECTOR, CAMERA } from '../frontend/src/equipment.js';
import { prepare, simulate } from '../frontend/src/sim.js';
import { planPdf, planDxf } from '../frontend/src/planexport.js';
import { dxfObjects } from '../frontend/src/vector.js';
import { hall } from './hall.mjs';

const factory = JSON.parse(fs.readFileSync(new URL('../data/samples/factory_site.json', import.meta.url), 'utf8'));
const sites = {
  factory,
  'small office': hall(10, 8),
  'big hall, two exits': hall(60, 40, { exits: [[5, 7], [30, 32]] }),
  'hall split by a wall with a door': hall(30, 20, { exits: [[3, 5]], inner: [[15, 0, 20, 9, 10]] }),
  'long corridor': hall(80, 3, { exits: [[0.5, 2.5]] }),
};

for (const [name, site] of Object.entries(sites)) {
  test(`${name}: every sign spot has a projector within reach, none over capacity`, () => {
    const plan = equipmentPlan(site, { wallHeight: 3 });
    assert.ok(plan.targets.length > 0);
    assert.equal(plan.coverage.targets, 1, `missed ${plan.coverage.targets_missed}`);
    const g = prepare(site), byId = new Map(plan.targets.map((t) => [t.id, t]));
    for (const p of plan.projectors) {
      assert.ok(p.targets.length <= PROJECTOR.images);
      for (const id of p.targets) assert.ok(reaches(g, p, byId.get(id)), `${p.id} cannot reach ${id}`);
    }
    // no projector is idle, and they are not one per sign
    assert.ok(plan.projectors.every((p) => p.targets.length > 0));
    if (plan.targets.length >= 6) assert.ok(plan.projectors.length < plan.targets.length);
  });

  test(`${name}: cameras see every door and nearly all the floor of every room`, () => {
    const plan = equipmentPlan(site, { wallHeight: 3 });
    assert.equal(plan.coverage.doors, 1, `unseen ${plan.coverage.doors_unseen}`);
    assert.ok(plan.coverage.floor >= CAMERA.floorShare, `${plan.coverage.floor}`);
    for (const [z, v] of Object.entries(plan.coverage.rooms)) assert.ok(v >= CAMERA.floorShare - 0.02, `${z}: ${v}`);
    // what cameraView reports agrees: the floor just inside each door is seen
    const seen = cameraView(site, plan.cameras), { w, cell_m: c, cells } = site.grid;
    for (const d of site.doors) {
      let ok = false;
      for (let y = Math.floor((d.y - 1) / c); y <= Math.floor((d.y + 1) / c); y++) for (let x = Math.floor((d.x - 1) / c); x <= Math.floor((d.x + 1) / c); x++) ok ||= cells[y]?.[x] === '.' && !!seen[y * w + x];
      assert.ok(ok, `door ${d.id}`);
    }
  });
}

test('the same plan gives the same equipment', () => {
  const a = equipmentPlan(factory), b = equipmentPlan(factory);
  assert.deepEqual(a.projectors, b.projectors);
  assert.deepEqual(a.cameras, b.cameras);
});

test('a projector does not reach through a wall, nor a floor spot seen too flat', () => {
  const site = hall(30, 20, { exits: [[3, 5]], inner: [[15, 0, 20, 9, 10]] }), g = prepare(site);
  const off = 0.5, z = 2.75;
  const floor = { surface: 'floor', x: 20 + off, y: 4 + off, z: 0 };
  assert.ok(reaches(g, { x: 18 + off, y: 4 + off, z }, floor));
  assert.ok(!reaches(g, { x: 12 + off, y: 4 + off, z }, floor), 'through the partition');
  assert.ok(!reaches(g, { x: 28 + off, y: 4 + off, z }, floor), '8 m away at 2.75 m high: too flat');
});

test('signs and lintels sit where the 3D projections are drawn', () => {
  const targets = projectionTargets(factory);
  const exits = factory.doors.filter((d) => d.is_exit);
  for (const d of exits) assert.equal(targets.filter((t) => t.kind === 'lintel' && t.door === d.id).length, 1, d.id);
  for (const t of targets) assert.ok(t.surface === 'wall' || factory.grid.cells[Math.floor(t.y / factory.grid.cell_m)][Math.floor(t.x / factory.grid.cell_m)] === '.');
});

test('the projections only know what a camera has seen, a few seconds later', () => {
  const n = 6, seen = Uint8Array.from([1, 1, 0, 0, 1, 0]);
  const hz = { fireT: Float32Array.from([50, 60, 10, Infinity, Infinity, Infinity]), rubbleT: Float32Array.from([Infinity, Infinity, Infinity, 5, 7, 8]), blockT: new Float32Array(n).fill(Infinity) };
  const p = perceivedHazard(hz, seen, 5);
  // the fire started unseen at cell 2; it is known once a camera sees it at cell 0 (t 50 + 5)
  assert.equal(p.seenAt, 55);
  assert.deepEqual([...p.fireT].slice(0, 3), [55, 60, 55]);
  // rubble only where seen
  assert.deepEqual([...p.rubbleT].slice(3), [Infinity, 12, Infinity]);
});

test('each sign on show is matched to the projector that covers its spot', () => {
  const plan = equipmentPlan(factory);
  const shown = plan.targets.filter((t) => t.surface === 'floor').map((t) => ({ x: t.x + 0.3, y: t.y - 0.2 }));
  for (const s of assignSigns(plan, shown)) assert.ok(s.projector, `${s.x},${s.y}`);
});

for (const [name, site] of Object.entries(sites)) {
  test(`${name}: each projector lights only its own room; each camera watches its own room and no two face each other`, () => {
    const plan = equipmentPlan(site, { wallHeight: 3 }), g = prepare(site);
    const zoneAt = (x, y) => `Z${g.zone[Math.floor(y / g.c) * g.w + Math.floor(x / g.c)]}`;
    const byId = new Map(plan.targets.map((t) => [t.id, t]));
    for (const p of plan.projectors) {
      assert.equal(zoneAt(p.x, p.y), p.zone, p.id);
      for (const id of p.targets) assert.equal(byId.get(id).zone, p.zone, `${p.id} -> ${id}`);
      assert.ok(p.reason.length > 20, p.id);
    }
    for (const c of plan.cameras) {
      assert.equal(zoneAt(c.x, c.y), c.zone, c.id);
      assert.ok(['corner', 'wall', 'ceiling'].includes(c.mount) && c.reason.length > 20, c.id);
    }
    const look = (a, b) => Math.abs(((Math.atan2(b.y - a.y, b.x - a.x) - a.dir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < (25 * Math.PI) / 180;
    for (const a of plan.cameras) for (const b of plan.cameras) if (a !== b && a.zone === b.zone) assert.ok(!(look(a, b) && look(b, a)), `${a.id} and ${b.id} face each other`);
    // one camera per room unless the room needs more
    for (const z of site.zones) if ((z.area_m2 || 0) < 60) assert.ok(plan.cameras.filter((c) => c.zone === z.id).length <= 1, z.id);
  });
}

test('sample factory: every projector shows something once the alarm is raised, in fires and in an earthquake', () => {
  const plan = equipmentPlan(factory), seen = cameraView(factory, plan.cameras);
  const runs = [...factory.zones.map((z) => ({ fire: z.id })), { scenario: 'earthquake', quakeLevel: 'severe', building: 'URML', design: 'pre', seed: 3 }];
  for (const opts of runs) {
    const r = simulate(factory, { ...opts, frameEvery: 1e9, maxTime: 200 });
    const R = { ...r, hazard: perceivedHazard(r.hazard, seen) };
    const start = r.quake ? 1 : Math.min(r.fireModel.alarm ?? Infinity, R.hazard.seenAt ?? Infinity);
    for (const t of [start + 1, start + 40]) {
      const scene = signScene(plan, factory, R, t), lit = new Set();
      scene.forEach((s, k) => { if (s.show) lit.add(plan.targets[k].projector); });
      const idle = plan.projectors.filter((p) => !lit.has(p.id)).map((p) => p.id);
      assert.ok(idle.length <= 1, `${JSON.stringify(opts)} at ${t}: idle ${idle}`);
    }
    // before anyone knows, the projectors are off
    if (!r.quake) assert.ok(signScene(plan, factory, R, Math.max(0, start - 1)).every((s) => !s.show || s.show === 'training'));
  }
});

test('the PDF is one A3 page that names every projector and camera', () => {
  const plan = equipmentPlan(factory), bytes = planPdf({ ...factory, name: 'Sample factory' }, plan);
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
  assert.match(text, /\/MediaBox \[0 0 1190\.55 841\.89\]/);
  for (const d of [...plan.projectors, ...plan.cameras]) assert.ok(text.includes(`(${d.id})`), d.id);
  // the cross-reference table points at each object
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(xref).startsWith('xref'));
  for (const [n, off] of [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m, k) => [k + 1, Number(m[1])])) assert.ok(text.slice(off).startsWith(`${n} 0 obj`), `object ${n}`);
});

test('the DXF has a layer for each kind of device and a note for each one', () => {
  const plan = equipmentPlan(factory), dxf = planDxf({ ...factory, name: 'Sample factory' }, plan);
  const lines = dxf.split('\r\n').slice(0, -1);
  assert.equal(lines.length % 2, 0);
  for (const l of ['A-WALL', 'A-ANNO-PROJECTOR', 'A-ANNO-CAMERA', 'A-ANNO-SIGN', 'A-ANNO-NOTES']) assert.ok(lines.includes(l), l);
  for (const d of [...plan.projectors, ...plan.cameras]) assert.ok(dxf.includes(`${d.id} h`), d.id);
  assert.equal(lines.filter((l, k) => k % 2 === 1 && l === 'SEQEND').length, lines.filter((l, k) => k % 2 === 1 && l === 'POLYLINE').length);
  // in the drawing's own coordinates when the plan came from a DXF
  const framed = planDxf({ ...factory, dxf_frame: { x0: 1000, y0: 50000, k: 1000, units: 4 } }, plan);
  const p = plan.projectors[0];
  assert.ok(framed.includes(`\r\n10\r\n${+(1000 + 1000 * p.x - 250).toFixed(3)}\r\n`) || framed.includes(`${+(1000 + 1000 * p.x).toFixed(3)}`));
});

test('the DXF reads back as the same plan: furniture and stairs found again, devices left alone', () => {
  const site = { ...factory, objects: [
    { id: 'O1', kind: 'object', category: 'table', height_m: 0.75, polygon: [[5, 5], [6.6, 5], [6.6, 5.8], [5, 5.8]] },
    { id: 'O2', kind: 'object', category: 'machine', height_m: 1.6, polygon: [[20, 10], [23, 10], [23, 12], [20, 12]] },
    { id: 'S1', kind: 'stair', polygon: [[30, 3], [31.2, 3], [31.2, 6.4], [30, 6.4]] },
  ] };
  const plan = equipmentPlan(site), found = dxfObjects(planDxf(site, plan));
  assert.equal(found.filter((o) => o.kind === 'stair').length, 1);
  assert.equal(found.filter((o) => o.kind === 'object').length, 2, JSON.stringify(found.map((o) => o.category)));
  assert.ok(found.some((o) => o.category === 'machine'));
});
