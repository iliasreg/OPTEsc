// Verification of the movement model, in the spirit of the RiMEA guideline's tests for
// microscopic evacuation models (corridor speed, reaction times, corners, speed distribution,
// exit capacity, route choice). Acceptance limits are stated in each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, placePeople, prepare, sfpe, STATE } from '../frontend/src/sim.js';
import { hall } from './hall.mjs';

const off = 0.5; // hall() puts the inside of the walls half a metre from the grid origin
const none = { scenario: 'none' };

test('V1 corridor: one person at 1.33 m/s covers 40 m in 26 to 34 s', () => {
  const site = hall(40, 2, { exits: [[0, 2]] });
  const placed = [{ zone: 'Z1', x: off + 0.2, y: off + 1, speed: 1.33, pre: 0 }];
  const m = simulate(site, { ...none, placed, frameEvery: 0.2 }).metrics;
  assert.equal(m.out, 1);
  assert.ok(m.last_out_s >= 26 && m.last_out_s <= 34, `${m.last_out_s} s`);
});

test('V2 speed falls with crowd density as the SFPE relation (C/VM2 eq. 3.2)', () => {
  // S = 1.4 (1 - 0.266 D), capped at 1.2 m/s: the share of the free speed
  for (const [D, want] of [[0.3, 1], [0.54, 1], [1, 0.857], [1.9, 0.586], [3, 0.233]]) {
    const S = Math.min(1.2, 1.4 * (1 - 0.266 * D));
    assert.ok(Math.abs(sfpe(D) - S / 1.2) < 0.01 && Math.abs(sfpe(D) - want) < 0.01, `D ${D}: ${sfpe(D)}`);
  }
  assert.ok(sfpe(3.8) < 0.06);
});

test('V3 reaction times: nobody sets off before their pre-movement time, everyone soon after', () => {
  const site = hall(12, 8);
  const placed = Array.from({ length: 10 }, (_, k) => ({ zone: 'Z1', x: off + 1 + k, y: off + 6, speed: 1.2, pre: 5 + 7 * k }));
  const r = simulate(site, { ...none, placed, frameEvery: 0.2 });
  placed.forEach((p, k) => {
    const first = r.frames.state.findIndex((st) => st[k] !== STATE.WAITING);
    const t = r.frames.times[first];
    assert.ok(t >= p.pre - 1e-6 && t <= p.pre + 0.5, `person ${k}: pre ${p.pre}, moved at ${t}`);
  });
});

test('V4 round a corner: everyone gets out and nobody ever cuts through a wall', () => {
  // a 2 m corridor along the north wall to the exit, reached through a 2 m gap at its west end
  const site = hall(14, 10, { exits: [[0, 2]], inner: [[6, 2, 10, null, null]] });
  const g = site.grid, w = g.w, c = g.cell_m;
  const cells = g.cells.map((r) => r.split(''));
  for (let x = 2 + Math.round(2 / c); x < w - 2; x++) cells[2 + Math.round(2 / c)][x] = '#';
  site.grid.cells = cells.map((r) => r.join(''));
  site.grid.zone_ids = cells.map((r) => r.map((ch) => (ch === '.' ? 1 : 0)));
  // people in the south-west room: north through the gap at the west end, then east along the corridor
  const placed = Array.from({ length: 20 }, (_, k) => ({ zone: 'Z1', x: off + 1 + (k % 4) * 1.1, y: off + 4 + Math.floor(k / 4) * 1.1, speed: 1.2, pre: 0 }));
  const r = simulate(site, { ...none, placed, frameEvery: 0.2 });
  assert.equal(r.metrics.out, 20);
  const pg = prepare(site);
  for (const pos of r.frames.pos) for (let k = 0; k < 20; k++) {
    const i = Math.floor(pos[2 * k + 1] / c) * w + Math.floor(pos[2 * k] / c);
    assert.ok(pg.kind[i] !== 2 && pg.kind[i] !== 0, 'inside a wall');
  }
});

test('V5 free walking speeds follow the set distribution (adults: mean 1.2, sd 0.2, 0.8 to 1.6 m/s)', () => {
  const g = prepare(hall(40, 40));
  const sp = placePeople(g, { total: 2000 }).map((p) => p.speed);
  const mean = sp.reduce((a, b) => a + b, 0) / sp.length;
  const sd = Math.sqrt(sp.reduce((a, b) => a + (b - mean) ** 2, 0) / sp.length);
  assert.ok(Math.abs(mean - 1.2) < 0.03, `mean ${mean}`);
  assert.ok(sd > 0.15 && sd < 0.21, `sd ${sd}`);
  assert.ok(Math.min(...sp) >= 0.8 && Math.max(...sp) <= 1.6);
});

test('V6 exit capacity: flow grows with the effective width (C/VM2 eq. 3.4)', () => {
  const flow = (width) => {
    const site = hall(16, 16, { exits: [[7, 7 + width]] });
    const r = simulate(site, { ...none, people: { Z1: 150 }, preMove: [0, 0] });
    const outs = r.people.map((p) => p.out_s).sort((a, b) => a - b);
    return 100 / (outs[124] - outs[24]);
  };
  for (const width of [1, 2]) {
    const want = (1 - 0.266 * 1.9) * 1.4 * 1.9 * (width - 0.3);
    const got = flow(width);
    assert.ok(Math.abs(got - want) / want < 0.12, `${width} m: ${got.toFixed(2)} vs ${want.toFixed(2)} p/s`);
  }
});

test('V7 a large room empties about twice as slowly through two exits as through four', () => {
  const run = (exits) => simulate(hall(30, 20, { exits }), { ...none, people: { Z1: 300 }, preMove: [0, 0] }).metrics.all_out_s;
  const four = run([[2, 3], [7, 8], [12, 13], [17, 18]]), two = run([[2, 3], [17, 18]]);
  assert.ok(two / four > 1.6 && two / four < 2.4, `${two} s vs ${four} s`);
});

test('V8 route choice: people familiar with the building use the nearest exit; the unwarned public crowds the main entrance', () => {
  // two exits on the east wall, one wide (the main entrance) one narrow
  const site = hall(20, 20, { exits: [[1, 3], [17, 18.2]] });
  const share = (opts) => {
    const m = simulate(site, { people: { Z1: 120 }, fire: [1, 19], growth: 'slow', ...opts }).metrics;
    const main = m.exits.find((e) => e.id === 'D1').people;
    return main / m.out;
  };
  const familiar = share({ use: 'office' }), pub = share({ use: 'retail' }), voice = share({ use: 'retail', alarm: 'voice' });
  assert.ok(pub > familiar + 0.1, `public ${pub.toFixed(2)} vs staff ${familiar.toFixed(2)}`);
  assert.ok(Math.abs(voice - familiar) < 0.08, `voice alarm ${voice.toFixed(2)} vs staff ${familiar.toFixed(2)}`);
});
