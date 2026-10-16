// The "Fire drill" panel: start a fire, play it back in 3D and read what happened.
import { SimLayer, PEOPLE_COLORS } from './simview.js';
import { initProjectionEffects } from './projectioneffects.js';
import { simulate, worstFire } from './sim.js';
import { initExtinguisherTraining } from './extinguishertraining.js';
import { initDrillGuidance, siteFingerprint, drillExitIds } from './drillguidance.js';

const $ = (id) => document.getElementById(id);
const mmss = (s) => { if (s == null) return '–'; const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initSim({ viewer, getSite, setStatus }) {
  const layer = new SimLayer(viewer);
  const equipment = initExtinguisherTraining({viewer,getSite});
  initProjectionEffects(viewer,layer,equipment);
  const guidance = initDrillGuidance({ getSite, onHighlight: (event, site) => layer.highlight(event, site) });
  let revision = 0;
  let fireAt = null; // [x, y] when a spot was picked
  let picking = false, playing = false, last = 0, busy = false;
  let worker = null, nextId = 1, noWorker = false;
  const here = (cmd, site, opts, onProgress) => Promise.resolve().then(() => (cmd === 'run' ? simulate(site, opts) : worstFire(site, opts, onProgress)));
  const pending = new Map();

  function call(cmd, site, opts, onProgress) {
    if (noWorker) return here(cmd, site, opts, onProgress);
    try {
      worker ||= new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
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
  const simSite = (s) => ({ grid: s.grid, zones: s.zones.map(({ id, name, type, area_m2, grid_area_m2, centroid }) => ({ id, name, type, area_m2, grid_area_m2, centroid })), doors: s.doors.map(({ id, x, y, width_m, is_exit, connects, cells }) => ({ id, x, y, width_m, is_exit, connects, cells })) });
  function opts() {
    const total = parseInt($('sim-people').value, 10);
    return {
      fire: fireAt || $('sim-fire').value,
      fireSpeed: parseFloat($('sim-speed').value),
      total: Number.isFinite(total) && total >= 0 ? total : null,
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
    if (!s) return;
    const byArea = [...s.zones].sort((a, b) => b.area_m2 - a.area_m2);
    for (const z of byArea) sel.add(new Option(z.name, z.id));
    if (s.zones.some((z) => z.id === keep)) sel.value = keep;
  }

  async function run(fire = null) {
    const s = getSite();
    if (!s || busy) return;
    if (fire) { fireAt = null; $('sim-fire').value = fire; }
    if (!s.doors.some((d) => d.is_exit)) { setStatus('This plan has no exit yet. Paint a door on an outside wall in "Fix plan" first.', true); return; }
    stop();
    const token = revision;
    busy = true;
    setStatus('Running the fire drill…');
    const t0 = performance.now();
    try {
      const evacuationExitIds = drillExitIds(await siteFingerprint(s));
      if (token !== revision || s !== getSite()) return;
      equipment.setDrillActive(true);
      const r = await call('run', { ...simSite(s), evacuationExitIds }, opts());
      if (token !== revision || s !== getSite()) return;
      layer.show(r, s);
      guidance.start(r, s);
      showResult(r, s);
      $('player').hidden = false;
      $('pl-time').max = layer.duration;
      seek(0);
      play(true);
      setStatus(`Fire drill worked out in ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      if (token !== revision) return;
      equipment.setDrillActive(!!layer.result);
      setStatus(`Fire drill failed: ${err.message}`, true);
      console.error(err);
    } finally { busy = false; }
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
      const r = await call('worst', { ...simSite(s), evacuationExitIds }, o, (done, total) => setStatus(`Fire in room ${done} of ${total}…`));
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
      setStatus(`Tried a fire in each of ${r.runs.length} rooms with ${r.people} people. Showing the worst.`);
      $('sim-out').insertAdjacentHTML('beforeend', `<p id="sim-h3">Every fire start, worst first (click to replay)</p><ul class="simlist" id="sim-worst-list">${items}</ul>`);
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
    const door = new Map(s.doors.map((d) => [d.id, d]));
    const baseName = (d) => {
      const ends = (d.connects || []).map((c) => (c === 'outside' ? 'outside' : zname.get(c) || c));
      return d.is_exit ? `Exit from ${ends.find((e) => e !== 'outside') || d.id}` : `Door ${ends.join(' / ')}`;
    };
    // number doors that would otherwise share a name (two exits from the garage)
    const seen = new Map(), names = new Map();
    for (const d of s.doors) { const n = baseName(d); seen.set(n, (seen.get(n) || 0) + 1); names.set(d.id, [n, seen.get(n)]); }
    const doorName = (id) => {
      const [n, k] = names.get(id) || [id, 1];
      return esc(seen.get(n) > 1 ? `${n} (${k})` : n);
    };
    const harmed = m.overcome + m.trapped;
    const where = r.fire.zone ? zname.get(r.fire.zone) : 'the picked spot';
    let html = `<p>Sample drill exit policy: D9 only. D1 (loading shutter) and D11 (pending review) are excluded. This is not exit certification.</p><div id="sim-stats">
      <div class="${m.all_out_s == null ? 'bad' : ''}"><b>${m.all_out_s == null ? `${m.out} of ${m.people}` : mmss(m.all_out_s)}</b><span>${m.all_out_s == null ? 'got out' : `everyone out (${m.people} people)`}</span></div>
      <div><b>${mmss(m.p95_out_s)}</b><span>95% out</span></div>
      <div class="${m.overcome ? 'bad' : ''}"><b>${m.overcome}</b><span>overcome by smoke or fire</span></div>
      <div class="${m.trapped ? 'bad' : ''}"><b>${m.trapped}</b><span>trapped, no way out</span></div>
    </div>
    <p id="sim-h3">Rooms, fire in ${esc(where)}</p><ul class="simlist">`;
    const rows = m.zones.filter((z) => z.people || z.smoke_s != null).sort((a, b) => (a.margin_s ?? -1e9) - (b.margin_s ?? -1e9));
    for (const z of rows) {
      const lost = z.overcome + z.trapped;
      const cls = !z.people ? '' : lost || (z.margin_s != null && z.margin_s < 0) ? 'bad' : z.margin_s != null && z.margin_s < 60 ? 'warn' : '';
      const tag = lost ? `${lost} not out` : !z.people ? 'empty' : z.margin_s == null ? 'clear' : z.margin_s < 0 ? `${mmss(-z.margin_s)} late` : `${mmss(z.margin_s)} spare`;
      const detail = z.people
        ? `${z.people} ${z.people === 1 ? 'person' : 'people'}${z.clear_s != null ? `, out by ${mmss(z.clear_s)}` : ''}${z.smoke_s != null ? `, thick smoke by ${mmss(z.smoke_s)}` : ', smoke never thick'}`
        : `nobody here${z.smoke_s != null ? `, thick smoke by ${mmss(z.smoke_s)}` : ''}`;
      html += `<li class="${cls}"><span>${esc(z.name)}</span><span class="tag ${cls || (z.people ? 'ok' : '')}">${tag}</span><small>${detail}</small></li>`;
    }
    html += '</ul>';
    if (m.bottlenecks.length) {
      html += `<p id="sim-h3">Where people queued</p><ul class="simlist">`;
      for (const b of m.bottlenecks) html += `<li><span>${doorName(b.id)}</span><span class="tag warn">${b.max_queue} waiting</span><small>${b.width_m} m wide, ${b.people} people through, ${Math.round(b.wait_s)} s of waiting in all</small></li>`;
      html += '</ul>';
    }
    html += `<p id="sim-h3">Exits used</p><ul class="simlist">`;
    for (const e of m.exits) html += `<li><span>${doorName(e.id)}</span><span>${e.people}</span>${e.fire_s != null && e.fire_s < (m.last_out_s ?? 0) ? `<small>fire reaches it at ${mmss(e.fire_s)}</small>` : ''}</li>`;
    html += '</ul>';
    if (harmed) html += `<p style="color:var(--crit);font-size:13px;margin:8px 0 0">${harmed} ${harmed === 1 ? 'person did' : 'people did'} not get out. Shown in red (overcome) and amber (no way out) at the end of the playback.</p>`;
    $('sim-out').innerHTML = html;
  }

  // ---------- playback ----------
  function seek(t) {
    layer.setTime(t);
    $('pl-time').value = t;
    $('pl-clock').textContent = mmss(t);
    const n = layer.countsAt(t);
    guidance.playback(t, n);
    $('pl-counts').innerHTML = `<i style="background:${PEOPLE_COLORS.waiting}"></i>${n.waiting} not moving yet<i style="background:${PEOPLE_COLORS.moving}"></i>${n.moving} on the way<i style="background:#2f9e5b"></i>${n.out} out${n.overcome ? `<i style="background:${PEOPLE_COLORS.overcome}"></i>${n.overcome} overcome` : ''}${n.trapped ? `<i style="background:${PEOPLE_COLORS.trapped}"></i>${n.trapped} trapped` : ''}`;
  }
  function play(on) {
    playing = on && !!layer.result;
    viewer.setDrillLighting(playing);
    $('pl-play').textContent = playing ? '❚❚' : '▶';
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
  $('sim-worst').addEventListener('click', worst);
  $('sim-fire').addEventListener('change', () => { fireAt = null; });
  $('sim-pick').addEventListener('click', () => {
    picking = !picking;
    $('sim-pick').setAttribute('aria-pressed', picking);
    if (picking) setStatus('Click the floor in the 3D view where the fire starts');
  });
  $('pl-play').addEventListener('click', () => play(!playing));
  $('pl-time').addEventListener('input', (e) => { play(false); guidance.invalidate(); seek(parseFloat(e.target.value)); });
  $('pl-close').addEventListener('click', () => { stop(); layer.clear(); equipment.setDrillActive(false); $('player').hidden = true; });

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
