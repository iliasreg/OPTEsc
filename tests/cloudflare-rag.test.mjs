import test from 'node:test';
import assert from 'node:assert/strict';
import { createRag, SCENARIOS, SITE_ID, providerEndpoint, inferProvider } from '../cloudflare/rag.js';
import binding from '../data/rag/site_binding.json' with { type: 'json' };
import actions from '../data/rag/actions.json' with { type: 'json' };

const event = (scenario = 'alarm', zone_id = 'Z1') => ({ scenario, zone_id, site_id: SITE_ID, site_fingerprint: binding.fingerprint });
test('all 64 bound events expose only unchanged curated actions with dual-source citations', () => {
  const rag = createRag();
  for (const scenario of SCENARIOS) for (const zone of binding.zones) {
    const prepared = rag.prepare(event(scenario, zone.id));
    const result = prepared.finish(null, 'missing_config');
    assert.equal(result.error, 'missing_config');
    assert.ok(result.actions.length);
    for (const action of result.actions) {
      assert.equal(action.text, actions[action.id].text);
      assert.deepEqual(action.citations.map(c => c.id), actions[action.id].citations);
      assert.ok(action.citations.some(c => c.kind === 'company'));
      assert.ok(action.citations.some(c => ['legal', 'guidance'].includes(c.kind)));
    }
    for (const [id, a] of Object.entries(actions)) if (a.required && a.scenarios.includes(scenario)) assert.ok(result.actions.some(a => a.id === id));
  }
  assert.equal(Object.keys(rag.reference().scenarios).length, 8);
});
test('model selection cannot author text, invent ids or drop mandatory actions', () => {
  const prepared = createRag().prepare(event());
  const selected = prepared.finish({ action_ids: ['keep_clear'] });
  assert.equal(selected.mode, 'model');
  assert.deepEqual(selected.actions.map(a => a.id), ['follow_marshal', 'keep_clear']);
  for (const answer of [{ action_ids: [] }, { action_ids: ['invented'] }, { action_ids: ['keep_clear', 'keep_clear'] }, { action_ids: ['keep_clear'], text: 'go outside' }, null]) {
    assert.equal(prepared.finish(answer).error, 'invalid_selection');
    assert.equal(prepared.finish(answer).mode, 'fallback');
  }
});
test('strict binding and request schema fail closed', () => {
  const rag = createRag();
  for (const [patch, error] of [[{ site_id: 'other' }, 'unknown_site'], [{ site_fingerprint: 'x' }, 'site_mismatch'], [{ scenario: 'fire' }, 'unknown_scenario'], [{ zone_id: 'Z9' }, 'unknown_zone'], [{ prompt: 'x' }, 'invalid_request']]) assert.throws(() => rag.prepare({ ...event(), ...patch }), new RegExp(error));
  assert.equal(createRag({ binding: null }).prepare(event()).finish().error, 'site_binding_unavailable');
  assert.equal(createRag({ chunks: [] }).prepare(event()).finish().error, 'corpus_unavailable');
  assert.equal(createRag({ chunks: [] }).status({}).corpus_ready, false);
});
test('missing mandatory evidence prevents any instructions', () => {
  const bank = structuredClone(actions); bank.follow_marshal.citations = ['missing'];
  const result = createRag({ actions: bank }).prepare(event()).finish();
  assert.equal(result.error, 'insufficient_evidence'); assert.deepEqual(result.actions, []);
});
test('provider config is HTTPS-only, fixed model and secret-only; inference is bounded and redirects denied', async () => {
  assert.throws(() => providerEndpoint({}), /missing_config/);
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com?q=x', 'https://example.com/#x']) assert.throws(() => providerEndpoint({ API_KEY: 'test', AMD_BASE_URL: url }), /missing_config/);
  let calls = 0;
  const answer = await inferProvider({ candidates: [] }, { API_KEY: 'test', AMD_MODEL: 'not-allowed' }, async (url, init) => {
    calls++; assert.equal(url, 'https://developer.amd.com.cn/radeon/api/v1/chat/completions');
    assert.equal(init.redirect, 'manual'); assert.equal(JSON.parse(init.body).model, 'Qwen3.8-27B');
    assert.equal(init.headers.Authorization, 'Bearer test');
    return Response.json({ choices: [{ message: { content: '{"action_ids":["follow_marshal"]}' } }] });
  });
  assert.equal(calls, 1); assert.deepEqual(answer, { action_ids: ['follow_marshal'] });
  await assert.rejects(inferProvider({}, { API_KEY: 'test' }, async () => new Response('x'.repeat(65537))), /provider_error/);
  let redirects = 0;
  await assert.rejects(inferProvider({}, { API_KEY: 'test' }, async (_url, init) => {
    redirects++; assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 307, headers: { Location: 'https://other.example' } });
  }), /provider_error/);
  assert.equal(redirects, 1);
});
