import { drillEvents, eventAt } from './drillevents.js';
const SITE_ID = 'factory-demo-fr-v1';
const $ = (id) => document.getElementById(id);

function siteSnapshot(site) {
  return JSON.stringify({
    grid: site.grid,
    zones: site.zones.map(({ id, name }) => ({ id, name })),
    doors: site.doors.map(({ id, x, y, width_m, is_exit, connects }) => ({ id, x, y, width_m, is_exit, connects })),
  });
}
export async function siteFingerprint(site) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(siteSnapshot(site)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Software-drill policy only: D1 is a shutter; D11 awaits review.
export function drillExitIds(fingerprint) {
  if (fingerprint !== 'c1e4f38eb46b7fd8063e4576c0d5ceb160612bdcd1e092585fa1be0ee861f448') {
    throw new Error('No reviewed drill exit policy for this geometry. Reload the sample DXF; other plans need a site-specific exit policy.');
  }
  return ['D9'];
}

export const referenceMatches = (reference, fingerprint) => reference?.site_id === SITE_ID
  && typeof fingerprint === 'string' && reference.fingerprint === fingerprint;
const validActions = (actions) => Array.isArray(actions) && actions.length && actions.every((a) =>
  typeof a.text === 'string' && a.text.trim() && Array.isArray(a.citations) && a.citations.length
  && a.citations.every((c) => c && ['id', 'title', 'section', 'url'].every((k) => typeof c[k] === 'string')));

export function initDrillGuidance({ getSite, onHighlight = () => {} }) {
  const enabled = $('rag-enable'), status = $('rag-status'), output = $('rag-instructions');
  const overlay = $('drill-subtitle'), fact = $('rag-fact'), action = $('rag-action'), read = $('rag-read');
  let active = false, events = [], event = null, site = null, reference = null, fingerprint = null;
  let bindingGeneration = 0, generation = 0, controller = null, timer = null, spokenText = '', lastTime = 0;
  let referenceSite = null, referenceSnapshot = null, referencePromise = null, bindingMessage = 'Company guidance unavailable.';
  const cache = new Map();
  enabled.checked = false;
  function cancelSpeech() { window.speechSynthesis?.cancel(); }
  function invalidate() {
    generation++;
    clearTimeout(timer); timer = null;
    controller?.abort(); controller = null;
    cancelSpeech();
  }
  function render(actions = null, mode = '') {
    if (!active || !event) {
      overlay.hidden = true; output.replaceChildren(); read.disabled = true; spokenText = '';
      onHighlight(null, site);
      return;
    }
    overlay.hidden = false;
    onHighlight(event, site);
    fact.textContent = `SIMULATION · ${event.time.toFixed(1)} s — ${event.fact}`;
    const local = reference?.scenarios?.[event.scenario]?.actions;
    const selected = validActions(actions) ? actions : validActions(local) ? local : [];
    action.textContent = selected.length ? `Drill action: ${selected[0].text}`
      : 'Follow official alarms, trained responders and your approved site procedures.';
    $('rag-citations').textContent = selected.length
      ? `Action sources: ${[...new Set(selected[0].citations.map((c) => c.id))].join(' · ')} — full sources in Drill subtitles`
      : 'Company guidance unavailable · simulation facts only';
    status.textContent = selected.length ? `${mode || 'Fixed source-backed drill phrases — no model request.'} Sources support actions, not simulated facts.` : bindingMessage;
    output.replaceChildren();
    for (const item of selected) {
      const li = document.createElement('li'), p = document.createElement('p');
      p.textContent = item.text; li.append(p);
      for (const citation of item.citations) {
        const link = document.createElement('a');
        link.textContent = `${citation.id} — ${citation.title}, ${citation.section}`;
        try {
          const url = new URL(citation.url, window.location.href);
          if (['https:', 'http:'].includes(url.protocol)) {
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          }
        } catch { /* Invalid URLs remain readable evidence labels. */ }
        li.append(link, document.createElement('br'));
      }
      output.append(li);
    }
    spokenText = `${fact.textContent} ${action.textContent}`;
    read.disabled = !window.speechSynthesis || !window.SpeechSynthesisUtterance;
  }
  function modelRequest() {
    if (!active || !enabled.checked || !reference || !event?.zoneId) return;
    // Send only scenarios with a local evidence-backed action bank.
    if (!reference.scenarios?.[event.scenario]) return;
    const token = generation, selected = event, boundSite = site;
    const key = `${fingerprint}:${selected.scenario}:${selected.id}`;
    const current = () => generation === token && active && enabled.checked && event === selected && getSite() === boundSite;
    if (cache.has(key)) { render(cache.get(key).actions, cache.get(key).mode); return; }
    timer = setTimeout(async () => {
      if (!current()) return;
      const abort = new AbortController(); controller = abort;
      const timeout = setTimeout(() => abort.abort(), 65000);
      try {
        if (await siteFingerprint(boundSite) !== fingerprint || !current()) return;
        const response = await fetch('/api/guidance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
          body: JSON.stringify({ site_id: SITE_ID, site_fingerprint: fingerprint, zone_id: selected.zoneId, scenario: selected.scenario }),
        });
        if (!response.ok) throw new Error('Cloud unavailable');
        const data = await response.json(), actions = data.actions ?? data.instructions;
        if (!current() || await siteFingerprint(boundSite) !== fingerprint || !current()) return;
        if (data.site_id !== SITE_ID || data.zone_id !== selected.zoneId || data.scenario !== selected.scenario
          || !['model', 'fallback'].includes(data.mode) || !validActions(actions)) throw new Error('Invalid cloud response');
        const mode = data.mode === 'model' ? 'Model-selected draft actions.' : 'Deterministic fallback — not live inference.';
        cache.set(key, { actions, mode }); render(actions, mode);
      } catch {
        if (current()) status.textContent = 'Cloud unavailable; keeping fixed source-backed drill phrases.';
      } finally { clearTimeout(timeout); if (current()) controller = null; }
    }, 600);
  }
  function loadReference(s) {
    if (!s) return Promise.resolve();
    const snapshot = siteSnapshot(s);
    if (referenceSite === s && referenceSnapshot === snapshot && referencePromise) return referencePromise;
    referenceSite = s;
    referenceSnapshot = snapshot;
    const token = ++bindingGeneration;
    reference = null; fingerprint = null;
    bindingMessage = 'Company guidance unavailable while the plan binding is checked.';
    referencePromise = (async () => {
      try {
        const [hash, response] = await Promise.all([siteFingerprint(s), fetch('/api/drill-reference', { cache: 'no-store' })]);
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (token !== bindingGeneration || s !== getSite()) return;
        if (await siteFingerprint(s) !== hash || token !== bindingGeneration) return;
        fingerprint = hash;
        if (!referenceMatches(data, hash)) {
          bindingMessage = 'Company guidance unavailable: this plan does not match the fictional demo. Simulation facts remain available.';
        } else { reference = data; }
      } catch {
        if (token !== bindingGeneration) return;
        bindingMessage = 'Company guidance unavailable: local reference server could not be reached. Simulation facts remain available.';
      }
      if (token !== bindingGeneration) return;
      if (active) { render(); modelRequest(); }
      else status.textContent = reference ? 'Source-backed subtitles ready. Start a fire drill; cloud is optional.' : bindingMessage;
    })();
    return referencePromise;
  }
  function playback(t, counts) {
    if (!active) return;
    if (t < lastTime) invalidate();
    lastTime = t;
    const next = eventAt(events, t);
    if (next !== event) { invalidate(); event = next; render(); modelRequest(); }
    const text = counts ? `In the simulation now: ${counts.out} out, ${counts.overcome} overcome, ${counts.trapped} trapped${counts.injured ? `, ${counts.injured} hurt` : ''}${counts.killed ? `, ${counts.killed} dead` : ''}.` : '';
    if ($('rag-simulated').textContent !== text) $('rag-simulated').textContent = text;
  }
  function stop() {
    active = false; invalidate(); event = null; spokenText = '';
    onHighlight(null, site);
    overlay.hidden = true; output.replaceChildren(); read.disabled = true;
    $('rag-simulated').textContent = ''; status.textContent = 'Start a drill for automatic simulation subtitles.';
  }
  enabled.addEventListener('change', () => { invalidate(); render(); modelRequest(); });
  read.addEventListener('click', () => {
    if (!spokenText || read.disabled) return;
    cancelSpeech(); const utterance = new window.SpeechSynthesisUtterance(spokenText);
    utterance.lang = 'en-GB'; window.speechSynthesis.speak(utterance);
  });
  $('rag-silence').addEventListener('click', cancelSpeech);
  return {
    siteChanged() {
      stop(); enabled.checked = false; cache.clear(); bindingGeneration++;
      referenceSite = null; referencePromise = null; reference = null; fingerprint = null;
      void loadReference(getSite());
    },
    start(result, s) {
      stop(); site = s; active = true; lastTime = 0; events = drillEvents(result, s);
      void loadReference(s); playback(0);
    },
    playback, invalidate, stop,
  };
}
