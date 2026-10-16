// Earthquake: falling walls, jammed doors, toppling shelves, and how people get out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { simulate, prepare, STATE, MIXES } from '../frontend/src/sim.js';
import { quakeDamage, wallPanels, fragility, phi, shakeAt, QUAKE_LEVELS, BUILDINGS, casualtyRates } from '../frontend/src/quake.js';
import { hall } from './hall.mjs';

const factory = JSON.parse(fs.readFileSync(new URL('../data/samples/factory_site.json', import.meta.url), 'utf8'));
// two rooms side by side, a partition with a door between them, the exit in the east wall
const twoRooms = () => hall(20, 10, { exits: [[4, 5]], inner: [[10, 0, 10, 4, 5]] });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test('fragility: a normal CDF in log PGA, rising with the shaking', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-7 && Math.abs(phi(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(fragility(0.4, 0.4, 0.6) - 0.5) < 1e-7);
  assert.ok(fragility(0.15, 0.6, 0.6) < fragility(0.3, 0.6, 0.6) && fragility(0.3, 0.6, 0.6) < fragility(0.5, 0.6, 0.6));
  const q = { pga: 0.3, duration: 20, aftershock: { t: 100, pga: 0.15, duration: 8 } };
  assert.equal(shakeAt(q, -1), 0);
  assert.equal(shakeAt(q, 8), 1);
  assert.equal(shakeAt(q, 60), 0);
  assert.ok(shakeAt(q, 104) > 0 && shakeAt(q, 104) <= 0.5);
});

test('walls are cut into panels of at most 4 m; corners are left standing', () => {
  for (const site of [factory, twoRooms()]) {
    const g = prepare(site);
    const panels = wallPanels(g);
    assert.ok(panels.length > 4);
    for (const p of panels) assert.ok(p.length_m <= 4 + 1e-9 && p.length_m >= 1, `${p.length_m}`);
  }
});

test('stronger quakes bring down more walls; the same seed gives the same damage', () => {
  for (const site of [factory, twoRooms()]) {
    const g = prepare(site);
    const down = {};
    for (const level of Object.keys(QUAKE_LEVELS)) {
      down[level] = 0;
      for (let seed = 1; seed <= 15; seed++) down[level] += quakeDamage(g, [], { level, seed }).panels.filter((p) => p.t != null).length;
    }
    assert.ok(down.moderate < down.strong && down.strong < down.severe, JSON.stringify(down));
    const a = quakeDamage(g, [], { level: 'strong', seed: 4 }), b = quakeDamage(g, [], { level: 'strong', seed: 4 });
    assert.deepEqual(a.panels, b.panels);
    assert.deepEqual(a.events.map((e) => [e.type, e.id, e.t]), b.events.map((e) => [e.type, e.id, e.t]));
  }
});

test('walls fall while the ground shakes, rubble lies on the floor next to them', () => {
  const g = prepare(factory);
  for (let seed = 1; seed <= 10; seed++) {
    const d = quakeDamage(g, [], { level: 'severe', seed });
    for (const p of d.panels.filter((x) => x.t != null)) {
      assert.ok(shakeAt(d.quake, p.t) > 0, `${p.id} fell at ${p.t} with no shaking`);
      const reach = Math.round((0.6 * 2.6) / g.c) + Math.max(p.rect[2], p.rect[3]);
      for (const i of p.debris) {
        const x = i % g.w, y = (i / g.w) | 0;
        const dx = Math.max(p.rect[0] - x, 0, x - (p.rect[0] + p.rect[2] - 1)), dy = Math.max(p.rect[1] - y, 0, y - (p.rect[1] + p.rect[3] - 1));
        assert.ok(Math.max(dx, dy) <= reach && Number.isFinite(d.rubbleT[i]));
      }
    }
  }
});

test('tall shelves topple; low tables and heavy machines do not', () => {
  const site = twoRooms();
  site.objects = hall(20, 10, { objects: [
    { id: 'O1', kind: 'object', category: 'storage', height_m: 2.0, polygon: rect(2, 0.2, 6, 0.6) },
    { id: 'O2', kind: 'object', category: 'table', height_m: 0.75, polygon: rect(3, 4, 4.6, 4.8) },
    { id: 'O3', kind: 'object', category: 'machine', height_m: 1.6, polygon: rect(12, 2, 15, 4) },
  ] }).objects;
  const g = prepare(site);
  let shelf = 0, table = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const d = quakeDamage(g, site.objects, { level: 'severe', seed });
    shelf += d.topples.filter((t) => t.id === 'O1').length;
    table += d.topples.filter((t) => t.id === 'O2' || t.id === 'O3').length;
    for (const t of d.topples) assert.ok(Math.abs(t.dir[1]) > 0.99, 'falls across its narrow side');
  }
  assert.ok(shelf >= 12, `shelf fell ${shelf} of 20`);
  assert.equal(table, 0);
});

test('nobody who cannot climb rubble walks onto it; nobody walks through a jammed door', () => {
  const site = twoRooms();
  for (let seed = 1; seed <= 12; seed++) {
    const r = simulate(site, { scenario: 'earthquake', quakeLevel: 'severe', seed, total: 40, mix: { adult: 0.4, aid: 0.3, wheelchair: 0.3 } });
    const { rubbleT, blockT } = r.hazard, g = site.grid, c = g.cell_m;
    const cell = (pos, k) => Math.floor(pos[2 * k + 1] / c) * g.w + Math.floor(pos[2 * k] / c);
    const { times, pos } = r.frames;
    for (let f = 1; f < times.length; f++) {
      r.people.forEach((p, k) => {
        const a = cell(pos[f - 1], k), b = cell(pos[f], k);
        if (a === b) return;
        if (p.profile !== 'adult') assert.ok(!(rubbleT[b] <= times[f - 1]), `seed ${seed}: ${p.profile} onto rubble`);
        assert.ok(!(blockT[b] <= times[f - 1]), `seed ${seed}: through a jammed door`);
      });
    }
    const m = r.metrics;
    assert.equal(m.out + m.injured + m.trapped + m.overcome + m.assist, 40);
  }
});

test('damage states come out as often as the HAZUS fragility curves say', () => {
  const g = prepare(twoRooms());
  for (const [building, design, level] of [['C1L', 'low', 'strong'], ['URML', 'pre', 'severe'], ['W1', 'high', 'severe']]) {
    const runs = 400, count = [0, 0, 0, 0];
    let p = null;
    for (let seed = 1; seed <= runs; seed++) {
      const q = quakeDamage(g, [], { level, building, design, seed }).quake;
      p = q.p_damage;
      const ds = ['slight', 'moderate', 'extensive', 'complete'].indexOf(q.damage);
      for (let k = 0; k <= ds; k++) count[k]++;
    }
    // share of runs at or beyond each state, against P(ds >= k) = Phi(ln(PGA/median)/0.64)
    count.forEach((n, k) => assert.ok(Math.abs(n / runs - p[k]) < 0.07, `${building} ${design} ${level} state ${k + 1}: ${(n / runs).toFixed(2)} vs ${p[k].toFixed(2)}`));
  }
  // HAZUS Table 5-40, pre-code URML: complete damage at a median of 0.37 g
  assert.ok(Math.abs(fragility(0.37, BUILDINGS.URML.codes.pre[3], 0.64) - 0.5) < 1e-9);
});

test('casualties average out to the HAZUS indoor rates for the damage drawn', () => {
  const site = hall(30, 30, { exits: [[14, 16]] });
  const N = 300, runs = 60, got = [0, 0, 0, 0], want = [0, 0, 0, 0];
  for (let seed = 1; seed <= runs; seed++) {
    const m = simulate(site, { scenario: 'earthquake', quakeLevel: 'severe', building: 'C1L', design: 'low', seed, total: N, frameEvery: 1e9, maxTime: 60 }).metrics;
    const rates = casualtyRates('C1L', m.quake.damage, m.quake.collapsed);
    m.quake.severity.forEach((n, k) => { got[k] += n; want[k] += rates[k] * N; });
  }
  // severity 1 and 2 are frequent enough to compare run averages
  for (const k of [0, 1]) assert.ok(want[k] > 0 && Math.abs(got[k] - want[k]) / want[k] < 0.2, `severity ${k + 1}: ${got[k]} vs ${want[k].toFixed(0)}`);
});

test('those who run during the shaking are hurt more often than those who take cover', () => {
  let ran = 0, cov = 0, hurtRan = 0, hurtCov = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const m = simulate(factory, { scenario: 'earthquake', quakeLevel: 'severe', building: 'URML', design: 'pre', seed, total: 80, mix: MIXES.workforce, frameEvery: 1e9 }).metrics;
    ran += m.quake.ran; cov += 80 - m.quake.ran;
    hurtRan += m.quake.injured_running; hurtCov += m.quake.injured_covering;
    assert.equal(m.quake.severity.reduce((a, b) => a + b, 0), m.quake.by_wall + m.quake.by_furniture + m.quake.by_shaking);
  }
  assert.ok(hurtRan / ran > hurtCov / cov, `running ${hurtRan}/${ran}, cover ${hurtCov}/${cov}`);
});

test('a fallen outer wall is a way out for walkers when the doors are gone', () => {
  // no door at all: only a collapse can let anyone out
  const site = hall(16, 8, { exits: [] });
  let escaped = 0, wheels = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = simulate(site, { scenario: 'earthquake', quakeLevel: 'severe', building: 'URML', design: 'pre', seed, total: 20, mix: { adult: 0.8, wheelchair: 0.2 }, maxTime: 400 });
    escaped += r.metrics.profiles.adult.out;
    wheels += r.metrics.profiles.wheelchair.out;
  }
  assert.ok(escaped > 0);
  assert.equal(wheels, 0);
});

test('a moderate quake: the building mostly holds and everyone gets out', () => {
  let out = 0;
  for (let seed = 1; seed <= 5; seed++) out += simulate(factory, { scenario: 'earthquake', quakeLevel: 'moderate', seed, total: 60 }).metrics.out;
  assert.ok(out >= 0.97 * 300, `${out} of 300`);
});
