import { rag, inferProvider, providerEndpoint, readBounded } from './rag.js';

const HOUR = 3_600_000;
const LEASE = 65_000; // Provider transport has a 60 s abort deadline, including its body.
const GLOBAL_GATE = 'optesc-global-guidance-v1';
const reply = (payload, status = 200, headers = {}) => Response.json(payload, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const requestErrors = new Set(['invalid_json', 'invalid_request', 'unknown_site', 'unknown_scenario', 'site_mismatch', 'unknown_zone']);

function publicOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:' || url.origin !== env.PUBLIC_BASE_URL || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}
function allowed(request, origin) {
  if (new URL(request.url).origin !== origin) return false;
  const supplied = request.headers.get('Origin');
  if (supplied !== null && supplied !== origin) return false;
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  return request.method !== 'POST' || supplied === origin;
}
async function parseSituation(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('json_required');
  const length = request.headers.get('Content-Length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > 2048) throw new Error('body_too_large');
  const text = await readBounded(request.body, 2048);
  try { return JSON.parse(text); } catch { throw new Error('invalid_json'); }
}
function errorResponse(error) {
  const message = error?.message;
  if (message === 'body_too_large') return reply({ error: message }, 413);
  if (message === 'json_required') return reply({ error: message }, 415);
  if (requestErrors.has(message)) return reply({ error: message }, 400);
  return reply({ error: 'service_unavailable' }, 503);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/') && path !== '/api' && path !== '/healthz') {
      if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
      return env.ASSETS.fetch(request);
    }
    const origin = publicOrigin(env);
    if (!origin) return reply({ error: 'service_unavailable' }, 503);
    if (!allowed(request, origin)) return reply({ error: 'forbidden_origin' }, 403);
    const method = path === '/api/guidance' ? 'POST' : 'GET';
    if (!['/api/guidance', '/api/rag-status', '/api/drill-reference', '/healthz'].includes(path)) return reply({ error: 'not_found' }, 404);
    if (request.method !== method) return reply({ error: 'method_not_allowed' }, 405, { Allow: method });
    if (path === '/healthz') return reply({ status: 'ok' });
    if (path === '/api/rag-status') return reply(rag.status(env));
    if (path === '/api/drill-reference') return reply(rag.reference());
    let prepared;
    try {
      const situation = await parseSituation(request);
      prepared = rag.prepare(situation);
      if (!prepared.ready) return reply(prepared.finish());
      const id = env.GUIDANCE.idFromName(GLOBAL_GATE);
      return await env.GUIDANCE.get(id).fetch(new Request('https://gate.internal/api/guidance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(situation),
      }));
    } catch (error) {
      // A gate outage must never remove deterministic, cited drill instructions.
      if (prepared) return reply(prepared.finish(null, 'provider_error'));
      return errorResponse(error);
    }
  },
};

// One SQLite-backed instance for all visitors. Reservation and cache operations
// are synchronous: no fetch/await can interleave the check and reservation.
export class GuidanceGate {
  constructor(state, env, fetcher = fetch, now = Date.now) {
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.sql.exec('CREATE TABLE IF NOT EXISTS provider_attempts (id TEXT PRIMARY KEY, started INTEGER NOT NULL, active_until INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS event_cache (event_key TEXT PRIMARY KEY, signature TEXT NOT NULL, selection TEXT NOT NULL)');
  }
  reserve() {
    return this.storage.transactionSync(() => {
      const now = this.now();
      this.sql.exec('DELETE FROM provider_attempts WHERE started <= ? AND active_until <= ?', now - HOUR, now);
      const { attempts, active } = this.sql.exec('SELECT COUNT(*) AS attempts, COALESCE(SUM(CASE WHEN active_until > ? THEN 1 ELSE 0 END), 0) AS active FROM provider_attempts', now).toArray()[0];
      if (active >= 2) return { error: 'provider_busy' };
      if (attempts >= 60) return { error: 'quota_exceeded' };
      const id = crypto.randomUUID();
      this.sql.exec('INSERT INTO provider_attempts (id, started, active_until) VALUES (?, ?, ?)', id, now, now + LEASE);
      return { id };
    });
  }
  async fetch(request) {
    if (new URL(request.url).pathname !== '/api/guidance') return reply({ error: 'not_found' }, 404);
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    let prepared;
    try { prepared = rag.prepare(await parseSituation(request)); }
    catch (error) { return errorResponse(error); }
    if (!prepared.ready) return reply(prepared.finish());
    let reservation;
    try {
      // Check config before budgeting; a missing secret never costs a reservation.
      try { providerEndpoint(this.env); } catch { return reply(prepared.finish(null, 'missing_config')); }
      const cached = this.sql.exec('SELECT signature, selection FROM event_cache WHERE event_key = ?', prepared.key).toArray()[0];
      if (cached) {
        let answer;
        try { answer = JSON.parse(cached.selection); } catch { /* Invalid persisted selections are never trusted. */ }
        if (cached.signature === prepared.signature && prepared.valid(answer)) return reply(prepared.finish(answer));
        this.sql.exec('DELETE FROM event_cache WHERE event_key = ?', prepared.key);
      }
      reservation = this.reserve();
      if (reservation.error) return reply(prepared.finish(null, reservation.error));
      let answer;
      try { answer = await inferProvider(prepared.prompt, this.env, this.fetcher); }
      catch { return reply(prepared.finish(null, 'provider_error')); }
      const result = prepared.finish(answer);
      if (result.mode === 'model') {
        // Only validated 8 scenarios × 8 zones can enter this table. Persist IDs,
        // not generated text; rebuild current citations and required actions on read.
        this.sql.exec('INSERT OR REPLACE INTO event_cache (event_key, signature, selection) VALUES (?, ?, ?)', prepared.key, prepared.signature, JSON.stringify(answer));
      }
      return reply(result);
    } catch { return reply(prepared.finish(null, 'provider_error')); }
    finally {
      if (reservation?.id) this.sql.exec('UPDATE provider_attempts SET active_until = 0 WHERE id = ?', reservation.id);
    }
  }
}
