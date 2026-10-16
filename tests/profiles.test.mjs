// Different people: older people, walking aids, wheelchair users; stairs and narrow doors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { simulate, placePeople, prepare, assignProfiles, MIXES, PROFILES, STATE } from '../frontend/src/sim.js';
import { hall } from './hall.mjs';

const only = (p) => ({ [p]: 1 });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// no hazard: movement only
const calm = { scenario: 'none', preMove: [5, 20] };

test('profiles are shared out exactly and the places people stand do not change', () => {
  const g = prepare(hall(20, 12));
  for (const [name, mix] of Object.entries(MIXES)) {
    for (const total of [1, 7, 40, 133]) {
      const plain = placePeople(g, { total });
      const mixed = placePeople(g, { total, mix });
      assert.deepEqual(mixed.map((p) => [p.x, p.y]), plain.map((p) => [p.x, p.y]), name);
      const n = {};
      for (const p of mixed) n[p.profile] = (n[p.profile] || 0) + 1;
      const sum = Object.values(mix).reduce((a, b) => a + b, 0);
      for (const [p, share] of Object.entries(mix)) assert.ok(Math.abs((n[p] || 0) - (share / sum) * total) < 1 + 1e-9, `${name} ${p} ${total}`);
    }
  }
  // the same seed gives the same people
  assert.deepEqual(assignProfiles(placePeople(g, { total: 30 }), MIXES.care, 3), assignProfiles(placePeople(g, { total: 30 }), MIXES.care, 3));
});

test('slower profiles take longer to get out of the same hall', () => {
  const site = hall(20, 12);
  const t = {};
  for (const p of Object.keys(PROFILES)) {
    const m = simulate(site, { ...calm, total: 20, mix: only(p) }).metrics;
    assert.equal(m.out, 20, p);
    t[p] = m.all_out_s;
  }
  assert.ok(t.adult < t.older && t.older < t.aid, JSON.stringify(t));
  assert.ok(t.adult < t.wheelchair, JSON.stringify(t));
});

test('a wheelchair takes more of a door than a walker: queues last longer', () => {
  const site = hall(12, 8, { exits: [[3, 3.9]] });
  const walk = simulate(site, { ...calm, total: 30, mix: only('aid') }).metrics;
  const roll = simulate(site, { ...calm, total: 30, mix: only('wheelchair') }).metrics;
  assert.ok(roll.doors[0].wait_s > walk.doors[0].wait_s, `${roll.doors[0].wait_s} vs ${walk.doors[0].wait_s}`);
});

test('a door narrower than 0.75 m stops wheelchairs, not walkers', () => {
  const site = hall(12, 8, { exits: [[3, 3.5]] });
  const m = simulate(site, { ...calm, total: 20, mix: { adult: 0.5, wheelchair: 0.5 }, maxTime: 300 }).metrics;
  assert.equal(m.profiles.adult.out, 10);
  assert.equal(m.profiles.wheelchair.out, 0);
  assert.equal(m.profiles.wheelchair.trapped, 10);
});

test('upper floor: walkers leave by the stairs, wheelchair users wait for help at the landing', () => {
  // no exit door at all: only a stair flight in the middle of the hall
  const stair = { kind: 'stair', polygon: rect(8, 3, 11, 4.2), treads: 11 };
  const site = { ...hall(16, 8, { exits: [] }), objects: [] };
  site.objects = hall(16, 8, { exits: [], objects: [stair] }).objects;
  const r = simulate(site, { ...calm, total: 30, mix: { adult: 0.5, older: 0.2, wheelchair: 0.3 }, stairsOut: true });
  const m = r.metrics;
  assert.equal(m.profiles.adult.out + m.profiles.older.out, 21);
  assert.equal(m.via_stairs, 21);
  assert.equal(m.assist, 9);
  assert.equal(m.profiles.wheelchair.assist, 9);
  // they wait next to the flight, not on it
  const last = r.frames.pos[r.frames.pos.length - 1];
  r.people.forEach((p, k) => {
    if (p.state !== STATE.ASSIST) return;
    const [x, y] = [last[2 * k] - 0.5, last[2 * k + 1] - 0.5];
    assert.ok(x > 7.4 && x < 11.6 && y > 2.4 && y < 4.8, `waiting at ${x},${y}`);
  });
  // ground floor (stairs lead up): the flight is an obstacle and nobody can leave
  const ground = simulate(site, { ...calm, total: 30, mix: MIXES.public, maxTime: 60 }).metrics;
  assert.equal(ground.out, 0);
  assert.equal(ground.via_stairs, 0);
});

test('sample factory: the four mixes all run, and harder mixes take longer', () => {
  const site = JSON.parse(fs.readFileSync(new URL('../data/samples/factory_site.json', import.meta.url), 'utf8'));
  const t = Object.keys(MIXES).map((k) => simulate(site, { fire: 'Z1', total: 80, mix: MIXES[k] }).metrics);
  for (const m of t) assert.equal(m.out + m.overcome + m.trapped + m.assist, 80);
  assert.ok(t[0].p95_out_s <= t[2].p95_out_s, `${t[0].p95_out_s} vs ${t[2].p95_out_s}`);
});

test('people waiting for help at the stairs keep breathing smoke, and the run says by when help is needed', () => {
  const stair = { kind: 'stair', polygon: rect(8, 3, 11, 4.2), treads: 11 };
  const site = hall(16, 8, { exits: [], objects: [stair] });
  // a quick fire next to the flight: smoke reaches the landing soon
  const r = simulate(site, { fire: [12.5, 4], total: 20, mix: { adult: 0.5, wheelchair: 0.5 }, stairsOut: true, ceiling: 2.6 });
  const m = r.metrics;
  assert.equal(m.profiles.adult.out, 10);
  assert.equal(m.profiles.wheelchair.out, 0);
  assert.ok(m.help_by_s != null && m.help_by_s > 0, `help by ${m.help_by_s}`);
  assert.ok(r.people.filter((p) => p.profile === 'wheelchair').some((p) => p.dose > 0), 'they breathed smoke while waiting');
  // a calm fire far away: they can wait out the whole horizon
  const calmRun = simulate(site, { ...calm, total: 20, mix: { adult: 0.5, wheelchair: 0.5 }, stairsOut: true }).metrics;
  assert.equal(calmRun.assist, 10);
  assert.equal(calmRun.help_by_s, null);
});
