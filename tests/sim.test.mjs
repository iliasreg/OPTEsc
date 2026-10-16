// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { simulate, worstFire, weidmann, prepare, STATE } from '../frontend/src/sim.js';

// A walled room of W x H metres with exit doors given as [side, from_m, to_m] on 25 cm cells.
function room(W, H, exits) {
  const c = 0.25, w = W / c + 4, h = H / c + 4;
  const grid = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += x < 1 || y < 1 || x >= w - 1 || y >= h - 1 ? 'o' : x < 2 || y < 2 || x >= w - 2 || y >= h - 2 ? '#' : '.';
    grid.push(row.split(''));
  }
  const doors = exits.map(([side, a, b], k) => {
    const cells = [];
    for (let m = a; m < b; m += c) {
      const u = 2 + Math.round(m / c);
      const [x, y] = side === 'N' ? [u, 1] : side === 'S' ? [u, h - 2] : side === 'W' ? [1, u] : [w - 2, u];
      grid[y][x] = 'E';
      cells.push([x, y]);
    }
    const [sx, sy] = cells.reduce(([p, q], [x, y]) => [p + x, q + y], [0, 0]);
    return { id: `D${k + 1}`, x: (sx / cells.length + 0.5) * c, y: (sy / cells.length + 0.5) * c, width_m: b - a, is_exit: true, connects: ['outside', 'Z1'], cells };
  });
  const zone_ids = grid.map((r) => r.map((ch) => (ch === '.' ? 1 : 0)));
  return {
    grid: { cell_m: c, w, h, cells: grid.map((r) => r.join('')), zone_ids },
    zones: [{ id: 'Z1', name: 'Hall', type: 'production', area_m2: W * H, centroid: [w * c / 2, h * c / 2] }],
    doors,
    exits: doors.map((d) => d.id),
  };
}

test('Weidmann speed drops with crowding', () => {
  assert.equal(weidmann(0), 1);
  assert.ok(weidmann(2) < 0.6 && weidmann(2) > 0.4);
  assert.equal(weidmann(10), 0.1);
});

test('one 1 m exit lets out 0.92 people per second (C/VM2 eq. 3.4, effective width 0.7 m)', () => {
  const site = room(12, 12, [['S', 5.5, 6.5]]);
  const r = simulate(site, { scenario: 'none', people: { Z1: 100 }, preMove: [0, 0] });
  const m = r.metrics;
  assert.equal(m.out, 100);
  const outs = r.people.map((p) => p.out_s).sort((a, b) => a - b);
  const flow = 80 / (outs[89] - outs[9]); // middle 80 people, once the queue has formed
  assert.ok(flow > 0.92 * 0.9 && flow < 0.92 * 1.1, `flow ${flow.toFixed(2)} p/s`);
  assert.ok(m.doors[0].max_queue > 5, 'a queue forms at the door');
});

test('legacy grid model: a fire at one exit sends everyone to the other', () => {
  const site = room(20, 8, [['W', 3, 5], ['E', 3, 5]]);
  const r = simulate(site, { fireModel: 'grid', fire: [1.2, 5], fireSpeed: 0.5, fireDoorDelay: 0, people: { Z1: 30 }, preMove: [5, 5] });
  assert.equal(r.metrics.out + r.metrics.overcome, 30);
  const west = r.metrics.exits.find((e) => e.id === 'D1');
  assert.ok(west.people <= 2, `${west.people} people used the exit on fire`);
});

test('no exit means everyone is trapped', () => {
  const site = room(6, 6, []);
  const r = simulate(site, { fire: [1, 1], fireSpeed: 1e-4, smokeSpeed: 1e-4, people: { Z1: 5 }, maxTime: 30 });
  assert.equal(r.metrics.trapped, 5);
  assert.ok(r.people.every((p) => p.state === STATE.TRAPPED));
});

test('sample factory: every fire start runs, same seed gives the same result', () => {
  const site = JSON.parse(fs.readFileSync(new URL('../data/samples/factory_site.json', import.meta.url)));
  const g = prepare(site);
  const a = simulate(g, { fire: 'Z2', seed: 3 }), b = simulate(g, { fire: 'Z2', seed: 3 });
  assert.deepEqual(a.metrics, b.metrics);
  assert.ok(a.metrics.people > 20);
  const wf = worstFire(g);
  assert.equal(wf.runs.length, site.zones.length);
  for (const run of wf.runs) assert.ok(run.last_out_s > 0);
});
