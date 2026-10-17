import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { GuidanceGate } from '../cloudflare/worker.js';
import { SITE_ID, SCENARIOS } from '../cloudflare/rag.js';
import binding from '../data/rag/site_binding.json' with { type: 'json' };
const origin = 'https://demo.example';
const event = (scenario = 'alarm', zone_id = 'Z1') => ({ site_id: SITE_ID, site_fingerprint: binding.fingerprint, scenario, zone_id });
const request = (payload = event(), headers = {}, method = 'POST', path = '/api/guidance') => new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }) });
function storage() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(query, ...params) { const rows = db.prepare(query).all(...params); return { toArray: () => rows }; } }, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
function setup(options = {}) {
  const saved = options.storage ?? storage();
  let calls = 0;
  const env = { PUBLIC_BASE_URL: origin, API_KEY: 'unit-test-only', ASSETS: { fetch: async () => new Response('asset') }, ...options.env };
  // Only tests replace the provider transport; no external calls or credentials.
  const provider = async (...args) => { calls++; return options.provider ? options.provider(...args) : Response.json({ choices: [{ message: { content: '{"action_ids":["follow_marshal"]}' } }] }); };
  const gate = new GuidanceGate({ storage: saved }, env, provider, options.now ?? Date.now);
  const names = [];
  env.GUIDANCE = { idFromName(name) { names.push(name); return name; }, get() { return { fetch: req => gate.fetch(req) }; } };
  return { env, gate, saved, names, calls: () => calls };
}
test('public routes and same-origin validated guidance use one global gate, not IP headers', async () => {
  const s = setup();
  for (const path of ['/api/rag-status', '/api/drill-reference', '/healthz']) {
    const response = await worker.fetch(new Request(origin + path), s.env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(!(await response.text()).includes('unit-test-only'));
  }
  const result = await worker.fetch(request(), s.env); assert.equal((await result.json()).mode, 'model');
  await worker.fetch(request(event(), { 'X-Forwarded-For': 'other-client' }), s.env);
  assert.equal(s.calls(), 1); assert.equal(new Set(s.names).size, 1);
  assert.equal(await (await worker.fetch(new Request(origin + '/index.html'), s.env)).text(), 'asset');
  assert.equal((await worker.fetch(new Request(origin + '/api/unknown'), s.env)).status, 404);
  assert.equal((await worker.fetch(new Request(origin + '/api/guidance'), s.env)).status, 405);
});
test('origin, metadata, content-type, strict schema and actual streamed-byte limit reject before provider', async () => {
  const s = setup();
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) assert.equal((await worker.fetch(request(event(), headers), s.env)).status, 403);
  const media = await worker.fetch(request(event(), { 'Content-Type': 'text/plain' }), s.env);
  assert.equal(media.status, 415); assert.equal((await media.json()).error, 'json_required');
  const malformed = await worker.fetch(request('{'), s.env);
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, 'invalid_json');
  assert.equal((await worker.fetch(request({ ...event(), extra: 'x' }), s.env)).status, 400);
  assert.equal((await worker.fetch(request(event('bad')), s.env)).status, 400);
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024)); c.enqueue(new Uint8Array(1025)); c.close(); } });
  const streamed = new Request(origin + '/api/guidance', { method: 'POST', duplex: 'half', headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '1' }, body });
  assert.equal((await worker.fetch(streamed, s.env)).status, 413);
  assert.equal(s.calls(), 0);
  assert.equal((await worker.fetch(new Request('https://evil.example/api/rag-status'), s.env)).status, 403);
  assert.equal((await worker.fetch(request(), { ...s.env, PUBLIC_BASE_URL: origin + '/' })).status, 503);
});
test('global rolling-hour quota survives object recreation; failures are not cached', async () => {
  let now = 10_000_000;
  const s = setup({ now: () => now, provider: async () => new Response('failure', { status: 503 }) });
  for (let i = 0; i < 60; i++) {
    const r = await (await s.gate.fetch(request())).json(); assert.equal(r.error, 'provider_error'); assert.ok(r.actions.length);
  }
  assert.equal(s.calls(), 60);
  const restarted = setup({ storage: s.saved, now: () => now });
  let r = await (await restarted.gate.fetch(request())).json();
  assert.equal(r.error, 'quota_exceeded'); assert.ok(r.actions.length); assert.equal(restarted.calls(), 0);
  now += 3_600_000;
  assert.equal((await (await restarted.gate.fetch(request())).json()).mode, 'model');
});
test('at most two persistent concurrent leases; rejected work consumes no provider calls', async () => {
  const resolvers = [];
  const s = setup({ provider: () => new Promise(resolve => resolvers.push(resolve)) });
  const first = s.gate.fetch(request(event('alarm', 'Z1')));
  const second = s.gate.fetch(request(event('alarm', 'Z2')));
  while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
  const restarted = setup({ storage: s.saved });
  const r = await (await restarted.gate.fetch(request(event('alarm', 'Z3')))).json();
  assert.equal(r.error, 'provider_busy'); assert.ok(r.actions.length); assert.equal(restarted.calls(), 0);
  for (const resolve of resolvers) resolve(Response.json({ choices: [{ message: { content: '{"action_ids":["follow_marshal"]}' } }] }));
  await Promise.all([first, second]);
  assert.equal((await (await restarted.gate.fetch(request(event('alarm', 'Z3')))).json()).mode, 'model');
});
test('interrupted leases expire conservatively without resetting rolling usage', async () => {
  let now = 1_000_000;
  const s = setup({ now: () => now });
  assert.ok(s.gate.reserve().id); assert.ok(s.gate.reserve().id);
  const restarted = setup({ storage: s.saved, now: () => now });
  now += 64_999;
  assert.equal((await (await restarted.gate.fetch(request())).json()).error, 'provider_busy');
  now++;
  assert.equal((await (await restarted.gate.fetch(request())).json()).mode, 'model');
  assert.equal(s.saved.sql.exec('SELECT COUNT(*) AS n FROM provider_attempts').toArray()[0].n, 3);
});
test('missing configuration and gate outages keep cited fallbacks without leaking secrets', async () => {
  const s = setup({ env: { API_KEY: undefined } });
  assert.equal((await (await worker.fetch(request(), s.env)).json()).error, 'missing_config');
  assert.equal(s.saved.sql.exec('SELECT COUNT(*) AS n FROM provider_attempts').toArray()[0].n, 0);
  s.env.GUIDANCE.get = () => { throw new Error('do-not-leak'); };
  const result = await (await worker.fetch(request(), s.env)).json();
  assert.equal(result.error, 'provider_error'); assert.ok(result.actions.length);
  assert.ok(!JSON.stringify(result).includes('do-not-leak'));
});
test('validated event cache persists, has only 64 keys, invalid model responses never poison it', async () => {
  const s = setup({ provider: async (_url, init) => {
    const prompt = JSON.parse(JSON.parse(init.body).messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action_ids: prompt.candidates.map(c => c.id) }) } }] });
  } });
  // Advance time to exercise every finite key without exceeding the hourly budget.
  let now = 0; s.gate.now = () => now;
  for (const scenario of SCENARIOS) for (const zone of binding.zones) {
    now += 3_600_001;
    assert.equal((await (await s.gate.fetch(request(event(scenario, zone.id)))).json()).mode, 'model');
  }
  assert.equal(s.saved.sql.exec('SELECT COUNT(*) AS n FROM event_cache').toArray()[0].n, 64);
  const restarted = setup({ storage: s.saved });
  assert.equal((await (await restarted.gate.fetch(request())).json()).mode, 'model'); assert.equal(restarted.calls(), 0);
  // A corrupt or stale cache entry cannot inject instructions or bypass selection checks.
  s.saved.sql.exec('UPDATE event_cache SET selection = ? WHERE event_key = ?', '{"action_ids":["invented"]}', 'alarm:Z1');
  assert.equal((await (await restarted.gate.fetch(request())).json()).mode, 'model'); assert.equal(restarted.calls(), 1);
  const invalid = setup({ provider: async () => Response.json({ choices: [{ message: { content: '{"action_ids":["invented"]}' } }] }) });
  for (let i = 0; i < 2; i++) assert.equal((await (await invalid.gate.fetch(request())).json()).error, 'invalid_selection');
  assert.equal(invalid.calls(), 2);
});
