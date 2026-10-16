// The "Fire drill" panel: start a fire, play it back in 3D and read what happened.
import { SimLayer, PEOPLE_COLORS } from './simview.js';
import { QuakeView } from './quakeview.js';
import { initProjectionEffects } from './projectioneffects.js';
import { simulate, worstFire, assess, MIXES, PROFILES, OCCUPANCY } from './sim.js';
import { BUILDINGS } from './quake.js';
import { initExtinguisherTraining } from './extinguishertraining.js';
import { initDrillGuidance, siteFingerprint, drillExitIds } from './drillguidance.js';
import { DrillSound } from './drillsound.js';

const $ = (id) => document.getElementById(id);
// Bump when the simulation changes: the worker and the simulation it loads are fetched afresh.
const WORKER_VERSION = '2026-10-17b';
const mmss = (s) => { if (s == null) return '–'; const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initSim({ viewer, getSite, setStatus }) {
  const layer = new SimLayer(viewer, { QuakeView });
  const equipment = initExtinguisherTraining({viewer,getSite});
  initProjectionEffects(viewer,layer,equipment);
  const sound = new DrillSound();
  const guidance = initDrillGuidance({ getSite, onHighlight: (event, site) => layer.highlight(event, site) });
  let revision = 0;
  let fireAt = null; // [x, y] when a spot was picked
  let picking = false, playing = false, last = 0, busy = false;
  let worker = null, nextId = 1, noWorker = false;
  const here = (cmd, site, opts, onProgress) => Promise.resolve().then(() => (cmd === 'run' ? simulate(site, opts) : cmd === 'assess' ? assess(site, opts, opts.runs || 20, onProgress) : worstFire(site, opts, onProgress)));
  const pending = new Map();

  function call(cmd, site, opts, onProgress) {
    if (noWorker) return here(cmd, site, opts, onProgress);
    try {
      // versioned URL: a browser holding an older worker in its cache cannot reuse it
      worker ||= new Worker(new URL(`./simworker.js?v=${WORKER_VERSION}`, import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        if (e.data.progress) return p.onProgress?.(...e.data.progress);
        pending.delete(e.data.id);
        e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
      };
      // a page that may not start workers runs the drill itself
      worker.onerror = () => {
        noWorker = true; worker = null;
        for (const p of pending.values()) here(p.cmd, p.site, p.opts, p.onProgress).then(p.resolve, p.reject);
        pending.clear();
      };
    } catch { noWorker = true; worker = null; }
    if (!worker) return here(cmd, site, opts, onProgress);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, cmd, site, opts });
      worker.postMessage({ id, cmd, site, opts });
    });
  }

  // what the simulation needs from the site (the rest stays on the page)
  // building use, structure: options filled from the model's own tables
  for (const [k, u] of Object.entries(OCCUPANCY)) $('sim-use').add(new Option(u.label, k));
  for (const [k, b] of Object.entries(BUILDINGS)) $('sim-building').add(new Option(b.label, k));
  $('sim-building').value = 'C1L';
  // a building use suggests who is inside (still free to change)
  const USE_MIX = { office: 'workforce', retail: 'public', hotel: 'public', apartment: 'public', clinic: 'public', care: 'care' };
  $('sim-use').addEventListener('change', () => { $('sim-mix').value = USE_MIX[$('sim-use').value] || 'workforce'; });
  // unreinforced masonry is not built to moderate or high codes
  const designs = () => {
    const ok = BUILDINGS[$('sim-building').value].codes;
    for (const opt of $('sim-design').options) opt.disabled = !ok[opt.value];
    if (!ok[$('sim-design').value]) $('sim-design').value = Object.keys(ok).includes('low') ? 'low' : Object.keys(ok)[0];
  };
  $('sim-building').addEventListener('change', designs);
  // the 3D wall height follows the ceiling height
  $('sim-ceiling').addEventListener('change', () => { const v = parseFloat($('sim-ceiling').value); if (v > 0) { viewer.setWallHeight(v); const sl = document.getElementById('p-height'); if (sl) sl.value = v; } });
  const simSite = (s) => ({ grid: s.grid, openings: s.openings || [], zones: s.zones.map(({ id, name, type, area_m2, grid_area_m2, centroid }) => ({ id, name, type, area_m2, grid_area_m2, centroid })), doors: s.doors.map(({ id, x, y, width_m, is_exit, connects, cells, swing }) => ({ id, x, y, width_m, is_exit, connects, cells, swing })), objects: (s.objects || []).map(({ id, kind, category, height_m, polygon }) => ({ id, kind, category, height_m, polygon })) });
  function opts() {
    const total = parseInt($('sim-people').value, 10);
    return {
      fire: fireAt || $('sim-fire').value,
      scenario: $('sim-scenario').value,
      quakeLevel: $('sim-quake').value,
      building: $('sim-building').value,
      design: $('sim-design').value,
      wallHeight: viewer.wallHeight,
      use: $('sim-use').value,
      detection: $('sim-detect').value,
      sprinklers: $('sim-sprinklers').value,
      alarm: $('sim-alarm').value,
      interiorDoors: $('sim-doors').value,
      growth: $('sim-growth').value,
      ceiling: Math.max(2, parseFloat($('sim-ceiling').value) || 3),
      total: Number.isFinite(total) && total >= 0 ? total : null,
      mix: MIXES[$('sim-mix').value] || null,
      stairsOut: !$('sim-stairs-row').hidden && $('sim-stairs').checked,
    };
  }

  function siteChanged() {
    stop();
    guidance.siteChanged();
    void equipment.siteChanged();
    layer.clear();
    $('player').hidden = true;
    $('sim-out').innerHTML = '';
    fireAt = null;
    const s = getSite();
    const sel = $('sim-fire');
    const keep = sel.value;
    sel.innerHTML = '';
    $('sim-stairs-row').hidden = !(s?.objects || []).some((o) => o.kind === 'stair');
    if (!s) return;
    const byArea = [...s.zones].sort((a, b) => b.area_m2 - a.area_m2);
    for (const z of byArea) sel.add(new Option(z.name, z.id));
    if (s.zones.some((z) => z.id === keep)) sel.value = keep;
  }

  async function run(fire = null) {
    const s = getSite();
    if (!s || busy) return;
    sound.unlock(); // still inside the click: browsers allow sound from here on
    if (fire) { fireAt = null; $('sim-fire').value = fire; }
    if (!s.doors.some((d) => d.is_exit)) { setStatus('This plan has no exit yet. Paint a door on an outside wall in "Fix plan" first.', true); return; }
    stop();
    const token = revision;
    busy = true;
    const what = $('sim-scenario').value === 'earthquake' ? 'earthquake drill' : 'fire drill';
    setStatus(`Running the ${what}…`);
    const t0 = performance.now();
    try {
      const evacuationExitIds = drillExitIds(await siteFingerprint(s));
      if (token !== revision || s !== getSite()) return;
      equipment.setDrillActive(true);
      // nothing moves on screen meanwhile: pause the 3D view so the run gets the processor
      viewer.renderer.setAnimationLoop(null);
      let r;
      try { r = await call('run', { ...simSite(s), evacuationExitIds }, opts()); } finally { viewer.renderer.setAnimationLoop(() => viewer._tick()); }
      if (token !== revision || s !== getSite()) return;
      layer.show(r, s);
      sound.load(r);
      guidance.start(r, s);
      showResult(r, s);
      $('player').hidden = false;
      $('pl-time').max = layer.duration;
      seek(0);
      play(true);
      setStatus(`${what[0].toUpperCase()}${what.slice(1)} worked out in ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      if (token !== revision) return;
      equipment.setDrillActive(!!layer.result);
      setStatus(`The ${what} failed: ${err.message}`, true);
      console.error(err);
    } finally { busy = false; }
  }

  // Safety check: many runs, ASET against RSET for each room
  async function check() {
    const s = getSite();
    if (!s || busy) return;
    if (!s.doors.some((d) => d.is_exit)) { setStatus('This plan has no exit yet.', true); return; }
    stop();
    const token = revision;
    busy = true;
    const runs = 20;
    // nothing moves on screen meanwhile: pause the 3D view so the runs get the processor
    viewer.renderer.setAnimationLoop(null);
    try {
      const evacuationExitIds = drillExitIds(await siteFingerprint(s));
      if (token !== revision || s !== getSite()) return;
      const r = await call('assess', { ...simSite(s), evacuationExitIds }, { ...opts(), runs }, (done, total) => setStatus(`Safety check: run ${done} of ${total}…`));
      if (token !== revision || s !== getSite()) return;
      showCheck(r, s);
      setStatus(`Safety check done: ${runs} runs.`);
      document.querySelector('[data-panel="details"]')?.getAttribute('aria-pressed') !== 'true' && document.querySelector('[data-panel="details"]')?.click();
      document.querySelectorAll('#workspace-details details').forEach((d) => { if (d.textContent.includes('Drill results')) d.open = true; });
    } catch (err) {
      setStatus(`Safety check failed: ${err.message}`, true);
      console.error(err);
    } finally {
      busy = false;
      viewer.renderer.setAnimationLoop(() => viewer._tick());
    }
  }

  function showCheck(a, s) {
    const quake = $('sim-scenario').value === 'earthquake';
    const pct = (n) => `${Math.round((100 * n) / a.runs)}%`;
    const safe = a.runs - a.harmed.runs_with_harm;
    const headline = a.ok ? 'Safe: everyone got out in time.' : quake ? 'Not safe: people were hurt or could not get out.' : 'Not safe: the smoke can catch people before they get out.';
    let html = `<p class="headline ${a.ok ? 'ok' : 'bad'}">${headline}</p>
    <p class="simnote" style="margin-top:0">We ran the ${quake ? 'earthquake' : 'fire'} ${a.runs} times, each time with different people in different places.</p>
    <div id="sim-stats">
      <div class="${safe < a.runs ? 'bad' : ''}"><b>${safe} of ${a.runs}</b><span>times everyone got out unhurt</span></div>
      <div class="${a.harmed.max ? 'bad' : ''}"><b>${a.harmed.max}</b><span>people hurt or stuck, worst time</span></div>
      <div><b>${Number.isFinite(a.evacuation.p50) ? mmss(a.evacuation.p50) : '–'}</b><span>to get everyone out, usually</span></div>
      <div class="${a.evacuation.all_out_runs < a.runs ? 'bad' : ''}"><b>${Number.isFinite(a.evacuation.p95) ? mmss(a.evacuation.p95) : 'not all out'}</b><span>to get everyone out, slow case</span></div>
    </div>`;
    let tech = '';
    if (!quake) {
      const why = { visibility: 'smoke too thick to see', 'toxic gases': 'poisonous smoke', heat: 'too hot', 'radiant heat': 'heat from the smoke above', flashover: 'the room is on fire' };
      const rows = a.rooms.filter((r) => r.used || r.aset != null).sort((x, y) => (x.margin95 ?? 1e9) - (y.margin95 ?? 1e9));
      html += `<p id="sim-h3">Time to spare in each room</p><ul class="simlist">`;
      for (const r of rows) {
        const cls = r.margin95 == null ? '' : r.margin95 < 0 ? 'bad' : r.margin95 < 60 ? 'warn' : '';
        const tag = r.margin95 == null ? (r.aset == null ? 'stays safe' : 'nobody there') : r.margin95 < 0 ? `${mmss(-r.margin95)} too late` : `${mmss(r.margin95)} to spare`;
        const detail = `${r.aset == null ? 'Smoke never gets dangerous here' : `Dangerous after ${mmss(r.aset)} (${why[r.aset_cause] || r.aset_cause})`}${r.rset95 != null ? `; the last person leaves by ${mmss(r.rset95)}` : ''}.`;
        html += `<li class="${cls}"><span>${esc(r.name)}</span><span class="tag ${cls || 'ok'}">${tag}</span><small>${detail}</small></li>`;
      }
      html += '</ul>';
      tech += `<p>A room passes when it stays tenable (NZ C/VM2 limits at 2 m: visibility, ISO 13571 doses) longer than the 95th-percentile time of the last person through it (ASET &gt; RSET95). Runs where someone breathed smoke past FED 0.3: ${pct(a.over_limit.runs_with)}.</p>`;
      if (a.fire) tech += `<p>Design fire: ${a.fire.peak_kw >= 1000 ? `${(a.fire.peak_kw / 1000).toFixed(1)} MW` : `${a.fire.peak_kw} kW`} peak${a.fire.alarm_s != null ? `, detection at ${mmss(a.fire.alarm_s)}` : ', no automatic detection'}${a.fire.sprinkler_s != null ? `, sprinkler at ${mmss(a.fire.sprinkler_s)}` : ''}${a.fire.flashover_s != null ? `, flashover at ${mmss(a.fire.flashover_s)}` : ''}.</p>`;
    } else if (a.quake) {
      const d = a.quake;
      const words = { none: 'No damage', slight: 'Light damage', moderate: 'Moderate damage', extensive: 'Heavy damage', complete: 'Destroyed' };
      html += `<p id="sim-h3">What the earthquake did to the building</p><ul class="simlist">${Object.entries(words).filter(([k]) => d.states[k]).map(([k, w]) => `<li class="${k === 'complete' ? 'bad' : k === 'extensive' ? 'warn' : ''}"><span>${w}</span><span>${pct(d.states[k])} of runs</span></li>`).join('')}${d.collapsed ? `<li class="bad"><span>Building collapses</span><span>${pct(d.collapsed)} of runs</span></li>` : ''}</ul>`;
      const [s1, s2, s3, s4] = d.severity.map((n) => n.toFixed(1));
      html += `<p class="simnote">On average in each run: ${s1} slightly hurt, ${s2} sent to hospital, ${s3} badly hurt, ${s4} dead.</p>`;
      tech += '<p>Building damage, collapse and casualties follow HAZUS (FEMA) fragility curves and indoor casualty rates for the chosen structure and seismic design. Which walls fall is illustrative.</p>';
    }
    // why people did not get out: by who they are, with the likely reason
    const lost = Object.entries(a.profiles || {}).filter(([, v]) => v.people - v.out > 0.05);
    if (lost.length) {
      html += `<p id="sim-h3">Who did not get out (average per run)</p><ul class="simlist">`;
      for (const [p, v] of lost) {
        const why = [v.killed && `${v.killed} dead`, v.injured && `${v.injured} hurt`, v.overcome && `${v.overcome} overcome by smoke`, v.assist && `${v.assist} waiting for help at the stairs`, v.trapped && `${v.trapped} shut in`].filter(Boolean).join(', ');
        const hint = p === 'wheelchair' && v.trapped && a.narrow_doors.length ? ` These doors are too narrow for a wheelchair (under 75 cm): ${a.narrow_doors.join(', ')}.` : '';
        html += `<li class="bad"><span>${esc(PROFILES[p]?.label || p)}</span><span class="tag bad">${(v.people - v.out).toFixed(1)} of ${v.people}</span><small>${why}.${hint}</small></li>`;
      }
      html += '</ul>';
      if (quake && a.doors_jammed) html += `<p class="simnote">About ${Math.round(a.doors_jammed)} door${Math.round(a.doors_jammed) === 1 ? '' : 's'} jam in each run; people behind them are shut in.</p>`;
    }
    html += `<details class="tech"><summary>Technical details</summary>${tech}</details>`;
    $('sim-out').innerHTML = html;
  }

  async function worst() {
    const s = getSite();
    if (!s || busy) return;
    stop();
    const token = revision;
    busy = true;
    try {
      const o = opts();
      delete o.fire;
      const evacuationExitIds = drillExitIds(await siteFingerprint(s));
      if (token !== revision || s !== getSite()) return;
      equipment.setDrillActive(true);
      viewer.renderer.setAnimationLoop(null);
      let r;
      try { r = await call('worst', { ...simSite(s), evacuationExitIds }, o, (done, total) => setStatus(`Fire in room ${done} of ${total}…`)); } finally { viewer.renderer.setAnimationLoop(() => viewer._tick()); }
      if (token !== revision || s !== getSite()) return;
      const names = new Map(s.zones.map((z) => [z.id, z.name]));
      const items = r.runs.map((x) => {
        const cls = x.harmed ? 'bad' : '';
        const what = x.harmed ? `${x.harmed} not out` : `all out by ${mmss(x.last_out_s)}`;
        return `<li data-fire="${x.fire}" class="${cls}" tabindex="0"><span>Fire in ${esc(names.get(x.fire) || x.fire)}</span><span class="tag ${x.harmed ? 'bad' : 'ok'}">${what}</span></li>`;
      }).join('');
      busy = false;
      await run(r.runs[0].fire);
      if (token + 1 !== revision || s !== getSite()) return;
      setStatus(`Tried a fire in each of the ${r.runs.length} rooms. Showing the worst one.`);
      $('sim-out').insertAdjacentHTML('beforeend', `<p id="sim-h3">Each room on fire, worst first (click one to watch it)</p><ul class="simlist" id="sim-worst-list">${items}</ul>`);
      for (const li of $('sim-worst-list').children) {
        li.addEventListener('click', () => run(li.dataset.fire));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(li.dataset.fire); });
      }
    } catch (err) {
      equipment.setDrillActive(!!layer.result);
      setStatus(`Could not rank fire starts: ${err.message}`, true);
      console.error(err);
    } finally { busy = false; }
  }

  function showResult(r, s) {
    const m = r.metrics;
    const zname = new Map(s.zones.map((z) => [z.id, z.name]));
    const baseName = (d) => {
      const ends = (d.connects || []).filter((c) => c !== 'outside').map((c) => zname.get(c) || c);
      return d.is_exit ? `Exit from ${ends[0] || d.id}` : ends.length > 1 ? `Door between ${ends.join(' and ')}` : `Door ${d.id}`;
    };
    // number doors that would otherwise share a name (two exits from the garage)
    const seen = new Map(), names = new Map();
    for (const d of s.doors) { const n = baseName(d); seen.set(n, (seen.get(n) || 0) + 1); names.set(d.id, [n, seen.get(n)]); }
    const doorName = (id) => {
      const [n, k] = names.get(id) || [id, 1];
      return esc(seen.get(n) > 1 ? `${n} (${k})` : n);
    };
    const policy = '<p>Sample drill exit policy: D9 only. D1 (loading shutter) and D11 (pending review) are excluded. This is not exit certification.</p>';
    if (r.quake) return showQuake(r, s, doorName, policy);
    const lost = m.overcome + m.trapped + m.assist;
    const where = r.fire.zone ? zname.get(r.fire.zone) : 'the spot you picked';
    let html = `<p class="headline ${lost ? 'bad' : 'ok'}">${lost ? `${lost} of ${m.people} people did not get out.` : `Everyone got out in ${mmss(m.all_out_s)}.`}</p>
    <p class="simnote" style="margin-top:0">Fire in ${esc(where)}, ${m.people} people inside.</p>
    <div id="sim-stats">
      <div><b>${m.fire?.warned_s != null ? mmss(m.fire.warned_s) : 'never'}</b><span>the alarm rings</span></div>
      <div class="${m.all_out_s == null ? 'bad' : ''}"><b>${m.all_out_s == null ? `${m.out} of ${m.people}` : mmss(m.all_out_s)}</b><span>${m.all_out_s == null ? 'got out' : 'everyone is out'}</span></div>
      ${m.overcome ? `<div class="bad"><b>${m.overcome}</b><span>overcome by smoke or fire</span></div>` : ''}
      ${m.trapped ? `<div class="bad"><b>${m.trapped}</b><span>trapped, no way out</span></div>` : ''}
      ${m.assist ? `<div class="bad"><b>${m.assist}</b><span>waiting for help at the stairs${m.help_by_s != null ? `, needed by ${mmss(m.help_by_s)}` : ''}</span></div>` : ''}
    </div>
    <p id="sim-h3">Rooms</p><ul class="simlist">`;
    const rows = m.zones.filter((z) => z.people || z.smoke_s != null).sort((a, b) => (a.margin_s ?? -1e9) - (b.margin_s ?? -1e9));
    for (const z of rows) {
      const gone = z.overcome + z.trapped;
      const cls = !z.people ? '' : gone || (z.margin_s != null && z.margin_s < 0) ? 'bad' : z.margin_s != null && z.margin_s < 60 ? 'warn' : '';
      const tag = gone ? `${gone} not out` : !z.people ? 'empty' : z.margin_s == null ? 'safe' : z.margin_s < 0 ? `${mmss(-z.margin_s)} too late` : `${mmss(z.margin_s)} to spare`;
      const detail = z.people
        ? `${z.people} ${z.people === 1 ? 'person' : 'people'}${z.clear_s != null ? `, all out by ${mmss(z.clear_s)}` : ''}${z.smoke_s != null ? `; dangerous from ${mmss(z.smoke_s)}` : '; the smoke never gets dangerous'}.`
        : `Nobody here${z.smoke_s != null ? `; dangerous from ${mmss(z.smoke_s)}` : ''}.`;
      html += `<li class="${cls}"><span>${esc(z.name)}</span><span class="tag ${cls || (z.people ? 'ok' : '')}">${tag}</span><small>${detail}</small></li>`;
    }
    html += '</ul>';
    $('sim-out').innerHTML = html;
  }

  // Earthquake results: who got out, who was hurt and how, what came down.
  function showQuake(r, s, doorName, policy) {
    const m = r.metrics, q = m.quake, lost = m.injured + m.killed + m.trapped + m.assist;
    const zname = new Map(s.zones.map((z) => [z.id, z.name]));
    const words = { none: 'no damage', slight: 'light damage', moderate: 'moderate damage', extensive: 'heavy damage', complete: 'destroyed' };
    let html = `<p class="headline ${lost ? 'bad' : 'ok'}">${lost ? `${lost} of ${m.people} people did not get out.` : `Everyone got out in ${mmss(m.all_out_s)}.`}</p>
    <p class="simnote" style="margin-top:0">The building: ${words[q.damage] || q.damage}${q.collapsed ? ', and it collapses' : ''}.</p>
    <div id="sim-stats">
      ${m.killed ? `<div class="bad"><b>${m.killed}</b><span>dead</span></div>` : ''}
      <div class="${m.injured ? 'bad' : ''}"><b>${m.injured}</b><span>too hurt to walk out</span></div>
      <div class="${m.trapped ? 'bad' : ''}"><b>${m.trapped}</b><span>shut in by rubble or jammed doors</span></div>
      <div class="${m.all_out_s == null ? 'bad' : ''}"><b>${m.all_out_s == null ? `${m.out} of ${m.people}` : mmss(m.all_out_s)}</b><span>${m.all_out_s == null ? 'got out' : 'everyone is out'}</span></div>
      ${m.assist ? `<div class="bad"><b>${m.assist}</b><span>waiting for help at the stairs</span></div>` : ''}
    </div>`;
    const rows = m.zones.filter((z) => z.people);
    if (rows.length) {
      html += `<p id="sim-h3">Rooms</p><ul class="simlist">`;
      for (const z of rows) {
        const bad = z.people - z.out;
        html += `<li class="${bad ? 'bad' : ''}"><span>${esc(zname.get(z.id) || z.id)}</span><span class="tag ${bad ? 'bad' : 'ok'}">${bad ? `${bad} not out` : `out by ${mmss(z.last_out_s)}`}</span><small>${z.people} ${z.people === 1 ? 'person' : 'people'}</small></li>`;
      }
      html += '</ul>';
    }
    $('sim-out').innerHTML = html;
  }

  // ---------- playback ----------
  function seek(t) {
    layer.setTime(t);
    $('pl-time').value = t;
    $('pl-clock').textContent = mmss(t);
    const n = layer.countsAt(t);
    guidance.playback(t, n);
    const quake = !!layer.result?.quake;
    const dot = (color, n, label) => (n ? `<span><i style="background:${color}"></i>${n} ${label}</span>` : '');
    $('pl-counts').innerHTML = dot(PEOPLE_COLORS.waiting, n.waiting, quake ? 'taking cover' : 'not moving yet') + dot(PEOPLE_COLORS.moving, n.moving, 'on the way') + dot('#2f9e5b', n.out, 'out')
      + dot(PEOPLE_COLORS.overcome, n.overcome, 'overcome') + dot(PEOPLE_COLORS.trapped, n.trapped, 'trapped') + dot(PEOPLE_COLORS.assist, n.assist, 'waiting for help')
      + dot(PEOPLE_COLORS.injured, n.injured, 'hurt') + dot(PEOPLE_COLORS.killed, n.killed, 'dead');
    // what is sounding now, shown as well as heard
    const now = sound.state(t);
    $('pl-alarm').className = now ? 'on' : '';
    $('pl-alarm').textContent = now === 'alarm' ? 'Alarm ringing' : now === 'shaking' ? 'Shaking' : '';
    sound.update(t, playing);
  }
  function play(on) {
    playing = on && !!layer.result;
    viewer.setDrillLighting(playing);
    sound.update(layer.t, playing);
    $('pl-play').textContent = playing ? 'Pause' : 'Play';
    $('pl-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing) { if (layer.t >= layer.duration) seek(0); last = performance.now(); requestAnimationFrame(tick); }
  }
  function stop() { revision++; play(false); guidance.stop(); }
  function tick(now) {
    if (!playing) return;
    const dt = (now - last) / 1000;
    last = now;
    const t = Math.min(layer.duration, layer.t + dt * parseFloat($('pl-rate').value));
    seek(t);
    if (t >= layer.duration) play(false);
    else requestAnimationFrame(tick);
  }

  $('t-projections').addEventListener('change', e => { layer.setProjections(e.target.checked); equipment.setProjectionEnabled(e.target.checked); });
  $('sim-run').addEventListener('click', () => run());
  $('sim-check').addEventListener('click', check);
  const scenario = () => {
    document.body.dataset.scenario = $('sim-scenario').value;
    for (const b of document.querySelectorAll('button[data-scenario]')) b.setAttribute('aria-pressed', b.dataset.scenario === $('sim-scenario').value);
    if ($('sim-scenario').value === 'earthquake' && picking) { picking = false; $('sim-pick').setAttribute('aria-pressed', false); }
  };
  $('sim-scenario').addEventListener('change', scenario);
  scenario();
  $('sim-worst').addEventListener('click', worst);
  $('sim-fire').addEventListener('change', () => { fireAt = null; });
  $('sim-pick').addEventListener('click', () => {
    picking = !picking;
    $('sim-pick').setAttribute('aria-pressed', picking);
    if (picking) setStatus('Click the floor in the 3D view where the fire starts');
  });
  $('pl-play').addEventListener('click', () => { sound.unlock(); play(!playing); });
  $('pl-sound').addEventListener('click', () => {
    const on = $('pl-sound').getAttribute('aria-pressed') !== 'true';
    $('pl-sound').setAttribute('aria-pressed', on);
    $('pl-sound').textContent = on ? 'Sound on' : 'Sound off';
    if (on) sound.unlock();
    sound.setEnabled(on);
  });
  // Fire or Earthquake: two big buttons driving the hidden select
  for (const b of document.querySelectorAll('button[data-scenario]')) b.addEventListener('click', () => {
    $('sim-scenario').value = b.dataset.scenario;
    $('sim-scenario').dispatchEvent(new Event('change'));
  });
  $('pl-time').addEventListener('input', (e) => { play(false); guidance.invalidate(); seek(parseFloat(e.target.value)); });
  $('pl-close').addEventListener('click', () => { stop(); sound.silence(); $('pl-alarm').className = ''; layer.clear(); equipment.setDrillActive(false); $('player').hidden = true; });

  return {
    siteChanged,
    run,
    worst,
    layer, equipment,
    // the 3D view was clicked; returns true when the click started a fire
    pick(zoneId, point) {
      if (!picking || !point) return false;
      picking = false;
      $('sim-pick').setAttribute('aria-pressed', false);
      fireAt = point;
      if (zoneId) $('sim-fire').value = zoneId;
      run();
      return true;
    },
  };
}
