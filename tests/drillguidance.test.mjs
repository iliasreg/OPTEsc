import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { drillEvents, eventAt } from '../frontend/src/drillevents.js';
import { initDrillGuidance, siteFingerprint, referenceMatches } from '../frontend/src/drillguidance.js';
import { smokeAt } from '../frontend/src/sim.js';

globalThis.crypto ??= webcrypto;
const site = () => ({
  grid: { w: 6, h: 1, cell_m: 1, cells: ['..DD..'], zone_ids: [[1, 1, 0, 0, 2, 2]] },
  zones: [{ id: 'Z1', name: 'Actual workshop' }, { id: 'Z2', name: 'Actual office' }],
  doors: [{ id: 'D7', cells: [[2, 0], [3, 0]], connects: ['Z1', 'Z2'], width_m: 2, x: 3, y: 0, is_exit: false }],
});
const result = () => ({
  fire: { zone: 'Z1', cell: 0 },
  hazard: { fireT: [0, 100, 12, 22, 80, 90], smokeT: [0, 0, 0, 0, 30, 40], tau: [10, 10, 10, 10, 20, 20] },
  metrics: { bottlenecks: [{ id: 'D7', max_queue: 100 }], overcome: 99 },
});

test('immediate actual room; no future event on forward or backward seeks', () => {
  const events = drillEvents(result(), site());
  assert.match(eventAt(events, 0).fact, /Actual workshop \(Z1\)/);
  assert.equal(eventAt(events, 0).id, 'alarm');
  assert.equal(eventAt(events, 20).id, 'door:D7');
  assert.equal(eventAt(events, 0).id, 'alarm');
  for (let t = 0; t < 100; t += 0.1) assert.ok(eventAt(events, t).time <= t);
});

test('wide door uses ALL cells, exact fireT <= t+2; smoke and queues are not blocks', () => {
  const r = result(), events = drillEvents(r, site());
  const door = events.find((e) => e.id === 'door:D7');
  assert.equal(door.time, 20);
  assert.notEqual(eventAt(events, 19.999).id, door.id);
  assert.equal(eventAt(events, 20).id, door.id);
  assert.ok([2, 3].every((i) => r.hazard.fireT[i] <= door.time + 2));
  assert.ok([2, 3].some((i) => r.hazard.fireT[i] > door.time - 0.001 + 2));
  r.hazard.fireT[3] = Infinity;
  assert.ok(!drillEvents(r, site()).some((e) => e.scenario === 'blocked_route'));
});

test('room smoke comes from its own floor smokeT and tau, not people aggregates', () => {
  const r = result(), e = drillEvents(r, site()).find((e) => e.id === 'smoke:Z2');
  assert.equal(e.time, 40 + 20 * Math.LN2);
  assert.ok(smokeAt(r.hazard, 5, e.time) >= 0.5 - 1e-12);
  assert.match(e.fact, /Actual office \(Z2\)/);
  assert.ok(!eventAt(drillEvents(r, site()), e.time - 0.01).fact.includes('Thick smoke covers at least half the floor of Actual office'));
});

test('rapid events coalesce with a five-second hold and deterministic seeking', () => {
  const events = [0, 1, 1.1, 2, 3, 6].map((time, i) => ({ time, id: i ? `e${i}` : 'alarm' }));
  assert.equal(eventAt(events, 4.99).id, 'alarm');
  assert.equal(eventAt(events, 5).id, 'e4');
  assert.equal(eventAt(events, 9.99).id, 'e4');
  assert.equal(eventAt(events, 10).id, 'e5');
  assert.equal(eventAt(events, 5).id, 'e4');
});

test('fingerprints reject renamed rooms, changed grids and changed door bindings', async () => {
  const s = site(), fingerprint = await siteFingerprint(s);
  const ref = { site_id: 'factory-demo-fr-v1', fingerprint };
  assert.equal(referenceMatches(ref, fingerprint), true);
  for (const mutate of [s => s.zones[0].name = 'Other factory', s => s.grid.cells[0] = '..D...', s => s.doors[0].connects = ['Z2', 'outside']]) {
    const other = site(); mutate(other);
    assert.equal(referenceMatches(ref, await siteFingerprint(other)), false);
  }
  assert.equal(referenceMatches({ ...ref, site_id: 'other' }, fingerprint), false);
});

function dom() {
  class Element {
    constructor() { this.textContent = ''; this.children = []; this.listeners = {}; this.checked = false; this.disabled = false; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const elements = new Map();
  globalThis.document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: () => new Element() };
  globalThis.window = { location: { href: 'http://localhost/' } };
  return id => document.getElementById(id);
}
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const actions = [{ id: 'alarm', text: 'Fixture cited action.', citations: [{ id: 'source', title: 'Fixture', section: '1', url: '/source', kind: 'company' }] }];
async function reference(s) {
  return { site_id: 'factory-demo-fr-v1', fingerprint: await siteFingerprint(s), scenarios: Object.fromEntries(['alarm', 'smoke', 'blocked_route'].map(id => [id, { actions }])) };
}

test('automatic local subtitles, one reference fetch, no cloud calls per frame; mismatched plan keeps facts only', async () => {
  const $ = dom(); let s = site(); const ref = await reference(s), requests = [];
  globalThis.fetch = async url => { requests.push(url); return { ok: true, json: async () => ref }; };
  const g = initDrillGuidance({ getSite: () => s });
  g.siteChanged(); await flush(); g.start(result(), s);
  assert.match($('rag-fact').textContent, /Actual workshop/);
  assert.match($('rag-action').textContent, /Fixture cited action/);
  for (let t = 0; t <= 30; t += 0.1) g.playback(t, { out: 0, overcome: 9, trapped: 2 });
  assert.deepEqual(requests, ['/api/drill-reference']);
  g.playback(0); assert.match($('rag-fact').textContent, /Fire starts/);
  // Same object mutation must not reuse a previously valid company binding.
  s.zones[0].name = 'Different building';
  g.start(result(), s); await flush();
  assert.match($('rag-fact').textContent, /Different building/);
  assert.doesNotMatch($('rag-action').textContent, /Fixture cited action/);
  assert.match($('rag-status').textContent, /Company guidance unavailable/);
  assert.equal($('rag-instructions').children.length, 0);
  g.stop(); assert.equal($('drill-subtitle').hidden, true);
});

test('opt-in cloud response after seek/stop cannot replace current facts or actions', async () => {
  const $ = dom(), s = site(), ref = await reference(s); let respond, posts = 0;
  globalThis.fetch = async (url) => {
    if (url === '/api/drill-reference') return { ok: true, json: async () => ref };
    posts++;
    return new Promise(resolve => { respond = () => resolve({ ok: true, json: async () => ({ site_id: ref.site_id, zone_id: 'Z1', scenario: 'alarm', mode: 'model', actions: [{ ...actions[0], text: 'STALE CLOUD' }] }) }); });
  };
  const g = initDrillGuidance({ getSite: () => s });
  g.siteChanged(); await flush(); g.start(result(), s);
  $('rag-enable').checked = true; $('rag-enable').listeners.change();
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(posts, 1);
  g.invalidate(); g.playback(20); respond(); await flush();
  assert.match($('rag-fact').textContent, /Door D7/);
  assert.doesNotMatch($('rag-action').textContent, /STALE/);
  g.stop(); await flush(); assert.equal($('drill-subtitle').hidden, true);
});
