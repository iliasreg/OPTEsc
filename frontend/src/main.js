import { DEFAULTS, EDIT, readPlan, segment, toSite, analyzeSite } from './plan2grid.js';
import { Viewer, TYPE_COLORS, DIST_COLORS, zoneColor } from './viewer3d.js';
import { Editor } from './editor2d.js';
import { renderDxf, renderPdf, textHints } from './vector.js';
import { readPlanText } from './ocr.js';
import { siteToIfc } from './ifc.js';
import { initSim } from './simui.js';
import { placeObjects } from './objects.js';

const $ = (id) => document.getElementById(id);
const ZONE_TYPES = Object.keys(TYPE_COLORS);

// The sample factory in three formats. The image has no text layer: its room names and printed
// areas are given here; the DXF and the PDF carry them as text.
const px = (m) => 60 + m * 30; // sample image: 60 px margin, 30 px per metre
const SAMPLES = {
  dxf: { url: './samples/factory_plan.dxf' },
  pdf: { url: './samples/factory_plan.pdf' },
  png: {
    url: './samples/factory_plan.png', widthM: 40.3,
    hints: [
      ['Office A', 'office', 2.5, 5, 46.7], ['Office B', 'office', 7.5, 5, 47.4], ['Corridor', 'corridor', 5, 11, 18.1],
      ['Lockers', 'welfare', 2.5, 18, 56.2], ['Canteen', 'welfare', 7.5, 18, 57.1], ['Production hall', 'production', 20, 13, 563.5],
      ['Storage', 'storage', 29, 4, 86.4], ['Loading bay', 'loading_bay', 37, 4, 50.7],
    ].map(([name, type, x, y, a]) => ({ name, type, x: px(x), y: px(y), printedArea: a })),
  },
};
// what can be opened: drawings (DXF, PDF) and pictures of a plan
const PLAN_FILE = /\.(dxf|pdf|png|jpe?g|webp|bmp|gif)$/i;

const state = { source: null, base: null, edits: null, seg: null, site: null, plan: null, dist: null, name: 'Imported plan', image: null, kind: 'dxf', pxPerM: 0, hints: [], unitsGuessed: null, scaleFrom: 'typed', scaleCount: 0 };

const viewer = new Viewer($('view3d'), { onPick: (id, point) => sim.pick(id, point) || selectZone(id) });
const sim = initSim({ viewer, getSite: () => state.site, setStatus: (m, e) => setStatus(m, e) });
const editor = new Editor($('edit-canvas'), { onChange: () => resegment() });

// ---------- loading ----------

// Render the DXF to a canvas with its scale and text.
function loadCanvas(cv, { name, kind, pxPerM = 0, hints = [], textBoxes = [], unitsGuessed = null, note = '', objects = [], frame = null }) {
  state.source = cv;
  state.frame = frame;
  state.objectsPx = objects;
  state.name = name;
  state.image = name;
  state.kind = kind;
  state.pxPerM = pxPerM;
  state.hints = hints;
  state.textBoxes = textBoxes;
  state.unitsGuessed = unitsGuessed;
  state.site = null;
  $('p-width').disabled = pxPerM > 0;
  if (pxPerM > 0) state.scaleFrom = 'drawing';
  // Use a 10 cm grid when the rendered drawing is sharp enough.
  $('p-cell').value = pxPerM > 0 ? Math.min(0.25, Math.max(0.1, Math.ceil(4 / pxPerM / 0.05) * 0.05)).toFixed(2) : 0.25;
  $('scale-note').textContent = pxPerM > 0 ? note : scaleNote();
  // the width field shows only when the plan gives no scale of its own
  document.body.dataset.planScale = pxPerM > 0 ? 'known' : 'unknown';
  process();
}

// Raster plans: 10 cm cells when the image is sharp enough, never coarser than 25 cm.
function cellForScale(pxPerM) {
  return Math.min(0.25, Math.max(0.1, Math.ceil(4 / pxPerM / 0.05) * 0.05));
}

// With no scale on an image or a PDF, use what the plan itself says: printed room sizes first,
// door widths second (doors are about 0.9 m), wall thickness last (about 0.2 m).
function autoScale() {
  if (state.pxPerM || state.scaleFrom === 'typed') return;
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const weightedMedian = (vw) => {
    const b = [...vw].sort((x, y) => x[0] - y[0]), half = b.reduce((t, [, w]) => t + w, 0) / 2;
    let acc = 0;
    for (const [v, w] of b) if ((acc += w) >= half) return v;
    return b[b.length - 1][0];
  };
  for (let round = 0; round < 8; round++) {
    const s = state.site;
    const open = new Set((s.openings || []).flatMap((o) => o.between));
    let rooms = s.zones.filter((z) => z.printed_area_m2 && !z.merged_labels && z.area_m2 > 0.5 && z.type !== 'outdoor');
    // walled rooms are measured best, when there are enough of them for a median to outvote one misread size
    if (rooms.filter((z) => !open.has(z.id)).length >= 3) rooms = rooms.filter((z) => !open.has(z.id));
    const doors = s.doors.filter((d) => d.swing && d.swing.confidence >= 0.5 && d.width_m > 0.3 && d.width_m < 2);
    let k;
    // each room votes with its printed size: a misread size has usually lost a digit and is small,
    // so a well-read large room is not outvoted by two misread small ones
    if (rooms.length) { k = weightedMedian(rooms.map((z) => [Math.sqrt(z.printed_area_m2 / (z.printed_group_area_m2 ?? z.area_m2)), z.printed_area_m2])); state.scaleFrom = 'rooms'; state.scaleCount = rooms.length; }
    else if (doors.length >= 2) {
      // move only part of the way each round, as the doors found change with the scale
      k = (0.9 / median(doors.map((d) => d.width_m))) ** 0.7;
      state.scaleFrom = 'doors'; state.scaleCount = doors.length;
    } else { state.scaleFrom = 'walls'; break; }
    k = Math.min(2, Math.max(0.5, k));
    if (Math.abs(k - 1) < 0.01) break;
    const width = parseFloat($('p-width').value) * k;
    $('p-width').value = width.toFixed(2);
    $('p-cell').value = cellForScale(state.base.source.spanPx / width).toFixed(2);
    process();
  }
  $('scale-note').textContent = scaleNote();
  resegment();
}

// A picture of a plan: walls from the drawing, room names read from the image (offline), scale
// from the printed room sizes, the doors or the walls unless the width is given.
async function loadImage(src, name, widthM, hints = [], { ocr = !hints.length } = {}) {
  setStatus('Reading plan…');
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * scale);
  cv.height = Math.round(img.naturalHeight * scale);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  state.scaleFrom = widthM ? 'typed' : 'walls';
  if (widthM) $('p-width').value = widthM;
  loadCanvas(cv, { name, kind: 'raster', hints: hints.map((h) => ({ ...h, x: h.x * scale, y: h.y * scale })) });
  if (!widthM && state.base) {
    // first guess: walls are about 0.2 m thick
    const pxPerM = Math.max(5, state.base.source.wallPx / 0.2);
    $('p-width').value = (state.base.source.spanPx / pxPerM).toFixed(2);
    $('p-cell').value = cellForScale(pxPerM).toFixed(2);
    process();
  }
  if (ocr) {
    // nothing moves on screen meanwhile: pause the 3D view so the text reader gets the processor
    viewer.renderer.setAnimationLoop(null);
    try {
      const t = await readPlanText(cv, setStatus).finally(() => viewer.renderer.setAnimationLoop(() => viewer._tick()));
      state.hints = t.labels;
      state.textBoxes = t.textBoxes;
      if (!state.pxPerM && state.scaleFrom !== 'typed') process();
      else resegment();
      const n = t.labels.filter((l) => l.name).length;
      setStatus(`Read ${n} room name${n === 1 ? '' : 's'} on the plan.`);
    } catch (err) {
      setStatus(`Could not read the text on the plan (${err.message}). Rooms are unnamed.`, true);
      console.error(err);
    }
  }
  autoScale();
}

// A PDF drawing: its lines and text; the scale from a note such as "1:100" when there is one.
async function loadPdf(buffer, name) {
  setStatus('Reading PDF…');
  const r = await renderPdf(buffer);
  if (!r.pxPerM) state.scaleFrom = 'walls';
  loadCanvas(r.canvas, {
    name, kind: 'pdf', pxPerM: r.pxPerM, hints: textHints(r.texts, r.pxPerM || 30),
    textBoxes: r.texts.map((t) => t.box),
    note: r.scaleDenom ? `Scale 1:${r.scaleDenom} read from the drawing.` : '',
  });
  if (!r.pxPerM) autoScale();
}

function scaleNote() {
  const n = state.scaleCount;
  return {
    drawing: 'Scale read from the drawing.',
    typed: 'Scale from the building width you typed.',
    rooms: `Scale set from ${n} room size${n > 1 ? 's' : ''} printed on the plan.`,
    doors: `Scale estimated from ${n} doors, assuming 0.9 m door openings. Type the building width to confirm it.`,
    walls: 'Rough scale from wall thickness. Type the building width, or set it from a room.',
  }[state.scaleFrom] || '';
}

async function loadDxf(text, name) {
  setStatus('Reading DXF…');
  const r = renderDxf(text);
  const walls = r.layers.filter((l) => l.wall).map((l) => l.name);
  loadCanvas(r.canvas, {
    name, kind: 'dxf', pxPerM: r.pxPerM, hints: textHints(r.texts, r.pxPerM), unitsGuessed: r.unitsGuessed, objects: r.objects, frame: r.frame,
    note: `Exact scale from the DXF${r.unitsGuessed ? ` (units guessed: ${r.unitsGuessed})` : ''}. Wall layers: ${walls.join(', ') || 'none found'}.`,
  });
}

function process() {
  if (!state.source) return;
  const cv = state.source;
  try {
    const t0 = performance.now();
    state.base = readPlan(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height), { ...params(), textBoxes: state.textBoxes, nameBoxes: (state.hints || []).filter((h) => h.box).map((h) => [h.box[0] - 2, h.box[1] - 2, h.box[2] + 2, h.box[3] + 2]) });
    state.base.source.unitsGuessed = state.unitsGuessed;
    state.edits = new Uint8Array(state.base.w * state.base.h);
    state.carry = state.seg && state.site ? zoneAnchors() : null;
    state.seg = null;
    state.plan = cropPlan(cv, state.base);
    $('p-filter').placeholder = `auto (${state.base.source.lineFilterPx}px)`;
    if (state.pxPerM) $('p-width').value = ((state.base.wallMask ? wallSpanPx(state.base) : 0) / state.pxPerM).toFixed(1);
    resegment(true);
    setStatus(`Plan read in ${Math.round(performance.now() - t0)} ms`);
  } catch (err) {
    setStatus(err.message, true);
    console.error(err);
  }
}

function wallSpanPx(base) {
  const { wallMask: m, source: s } = base;
  let minX = s.widthPx, maxX = -1;
  for (let i = 0; i < m.length; i++) if (m[i]) { const x = i % s.widthPx; if (x < minX) minX = x; if (x > maxX) maxX = x; }
  return maxX - minX + 1;
}

function resegment(reframe = false) {
  if (!state.base) return;
  const prev = state.seg;
  state.seg = segment(state.base, state.edits, { ...params(), labels: (state.hints || []).filter((h) => h.name) });
  const zones = inheritZones(prev, state.site, state.seg);
  state.site = toSite(state.base, state.seg, { name: state.name, image: state.image, kind: state.kind, zones });
  applyHints();
  state.site.objects = placeObjects(state.site, state.base.source, state.objectsPx);
  // where site metres fall in the original drawing, for exports that overlay it in CAD:
  // X = x0 + k * x, Y = y0 - k * y (drawing units)
  const f = state.frame, src = state.base.source, c = state.site.grid.cell_m;
  if (f && state.pxPerM && src.cellPx) {
    const per = f.unitM * state.pxPerM;
    state.site.dxf_frame = { x0: f.minX + (src.originPx[0] - f.pad) / per, y0: f.maxY - (src.originPx[1] - f.pad) / per, k: src.cellPx / (c * per), units: f.units };
  }
  state.dist = analyzeSite(state.site, state.base, state.seg, { maxTravelM: params().maxTravelM, scaleFrom: state.scaleFrom, scaleCount: state.scaleCount });
  editor.set(state.base, state.edits, state.seg, state.plan);
  if (reframe) viewer.setSite(state.site, state.plan, state.dist);
  else keepCamera(() => viewer.setSite(state.site, state.plan, state.dist));
  renderInfo();
  sim.siteChanged();
}

// Zone ids are renumbered on every run; carry names and types over to the new zone
// that overlaps each old zone the most.
function inheritZones(prev, site, seg) {
  if (!prev && state.carry) {
    // the plan was re-read on a new grid: find each old zone again by an image pixel inside it
    const src = state.base.source, out = [];
    for (const z of state.carry) {
      const gx = Math.floor((z.px - src.originPx[0]) / src.cellPx), gy = Math.floor((z.py - src.originPx[1]) / src.cellPx);
      const id = seg.zone[gy * seg.w + gx];
      if (id > 0 && !out.some((o) => o.id === `Z${id}`)) out.push({ id: `Z${id}`, name: z.name, type: z.type, name_src: z.name_src });
    }
    state.carry = null;
    return out;
  }
  if (!prev || !site || prev.w !== seg.w || prev.h !== seg.h) return site?.zones || [];
  const overlap = new Map();
  for (let i = 0; i < seg.zone.length; i++) {
    const a = prev.zone[i], b = seg.zone[i];
    if (a > 0 && b > 0) overlap.set(a * 65536 + b, (overlap.get(a * 65536 + b) || 0) + 1);
  }
  const best = new Map(); // old id -> [new id, cells]
  for (const [key, n] of overlap) {
    const a = Math.floor(key / 65536), b = key % 65536;
    if (!best.has(a) || best.get(a)[1] < n) best.set(a, [b, n]);
  }
  const out = [];
  for (const z of site.zones.filter(keepName)) {
    const m = best.get(Number(z.id.slice(1)));
    if (m) out.push({ id: `Z${m[0]}`, name: z.name, type: z.type, name_src: z.name_src });
  }
  return out;
}

// "Zone 7" is only a number; ids change on every run, so such names are not carried over.
const keepName = (z) => !/^Zone \d+$/.test(z.name) || z.type !== 'unknown';

// One image pixel inside each zone (the zone cell nearest its centroid), so zones survive a re-read.
function zoneAnchors() {
  const { site, seg, base } = state, src = base.source, c = seg.params.cellM;
  return site.zones.filter(keepName).map((z) => {
    const id = Number(z.id.slice(1));
    let best = null, bd = Infinity;
    const cx = z.centroid[0] / c, cy = z.centroid[1] / c;
    for (let i = 0; i < seg.zone.length; i++) {
      if (seg.zone[i] !== id) continue;
      const d = (i % seg.w + 0.5 - cx) ** 2 + (Math.floor(i / seg.w) + 0.5 - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best == null ? null : { px: src.originPx[0] + (best % seg.w + 0.5) * src.cellPx, py: src.originPx[1] + (Math.floor(best / seg.w) + 0.5) * src.cellPx, name: z.name, type: z.type, name_src: z.name_src };
  }).filter(Boolean);
}

// Name, type and printed area for the zone under each hint point (image pixels).
function applyHints() {
  const { site, base } = state;
  if (!base.source.cellPx) return;
  for (const h of state.hints || []) {
    const gx = Math.floor((h.x - base.source.originPx[0]) / base.source.cellPx);
    const gy = Math.floor((h.y - base.source.originPx[1]) / base.source.cellPx);
    // a label drawn over a wall or furniture still names the nearest room within a metre
    let id = site.grid.zone_ids[gy]?.[gx], r = Math.ceil(1 / site.grid.cell_m);
    for (let d = 1; !id && d <= r; d++) {
      for (let dy = -d; dy <= d && !id; dy++) for (let dx = -d; dx <= d && !id; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === d) id = site.grid.zone_ids[gy + dy]?.[gx + dx];
      }
    }
    const z = id && site.zones.find((z) => z.id === `Z${id}`);
    if (!z) continue;
    (z.labels ??= []).push(h);
  }
  for (const z of site.zones) {
    const named = (z.labels || []).filter((h) => h.name);
    if (named.length && (z.name.startsWith('Zone ') || z.name_src === 'plan')) {
      // two room labels in one zone: an opening joined them; keep both names and the summed area
      Object.assign(z, { name: named.map((h) => h.name).join(' + '), type: named[0].type || z.type, name_src: 'plan' });
    } else if (!named.length && z.name_src === 'plan') {
      // its labels now sit in other rooms (the re-read split it): it is unnamed again
      Object.assign(z, { name: `Zone ${z.id.slice(1)}`, type: 'unknown' });
      delete z.name_src;
    }
    // sizes under the room names; a size with no name next to it only when no name carries one
    // (plans often print the same size twice, in metres and in feet)
    let areas = named.filter((h) => h.printedArea).map((h) => h.printedArea);
    if (!areas.length) areas = (z.labels || []).filter((h) => h.printedArea).map((h) => h.printedArea).slice(0, 1);
    if (areas.length && !z.printed_area_m2) z.printed_area_m2 = Math.round(areas.reduce((a, b) => a + b, 0) * 100) / 100;
    if (named.length > 1) z.merged_labels = named.map((h) => h.name);
    delete z.labels;
  }
  // A printed area can cover an open-plan space that the labels split (VARDAGSRUM 41 m² holding
  // the dining and kitchen labels too). Compare it with the whole space when that fits better.
  const byId = new Map(site.zones.map((z) => [z.id, z]));
  for (const z of site.zones) {
    if (!z.printed_area_m2) continue;
    const group = [z];
    for (let grew = true; grew;) {
      grew = false;
      for (const o of site.openings || []) {
        const [a, b] = o.between.map((id) => byId.get(id));
        for (const [x, y] of [[a, b], [b, a]]) {
          if (group.includes(x) && !group.includes(y) && !y.printed_area_m2) { group.push(y); grew = true; }
        }
      }
    }
    if (group.length < 2) continue;
    const sum = group.reduce((t, g) => t + g.area_m2, 0);
    if (Math.abs(sum - z.printed_area_m2) < Math.abs(z.area_m2 - z.printed_area_m2)) {
      z.printed_covers = group.map((g) => g.id);
      z.printed_group_area_m2 = Math.round(sum * 100) / 100;
    }
  }
}

function keepCamera(fn) {
  const pos = viewer.camera.position.clone(), target = viewer.orbit.target.clone();
  fn();
  viewer.camera.position.copy(pos);
  viewer.orbit.target.copy(target);
  viewer.orbit.update();
}

// Plan image cropped to the grid area, used as floor overlay and editor backdrop.
function cropPlan(src, base) {
  const { cellPx, originPx } = base.source;
  const sw = base.w * cellPx, sh = base.h * cellPx;
  const k = Math.min(1, 2048 / Math.max(sw, sh));
  const cv = document.createElement('canvas');
  cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(src, originPx[0], originPx[1], sw, sh, 0, 0, cv.width, cv.height);
  return cv;
}

async function openIfc(buffer, name) {
  setStatus('Opening IFC with web-ifc…');
  const { loadIfc } = await import('./ifcview.js');
  const { group, counts } = await loadIfc(buffer);
  viewer.showIfc(group);
  setTab('3d');
  setStatus(`web-ifc read ${name}: ${counts.walls} walls, ${counts.doors} doors, ${counts.windows} windows, ${counts.spaces} spaces.`);
}

// ---------- UI ----------

function params() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    planWidthM: num('p-width', DEFAULTS.planWidthM),
    pxPerM: state.pxPerM || 0,
    cellM: num('p-cell', DEFAULTS.cellM),
    maxDoorM: num('p-door', DEFAULTS.maxDoorM),
    lineFilterPx: num('p-filter', 0),
    maxTravelM: num('p-travel', 45),
  };
}

function renderInfo() {
  const s = state.site;
  const exits = s.doors.filter((d) => d.is_exit).length;
  $('stats').innerHTML = `
    <div><b>${s.zones.length}</b><span>zones</span></div>
    <div><b>${s.doors.length - exits}</b><span>doors</span></div>
    <div><b>${exits}</b><span>exits</span></div>
    <div><b>${s.egress.max_travel_m}</b><span>m to exit, max</span></div>`;
  const objs = s.objects || [], stairs = objs.filter((o) => o.kind === 'stair').length, furn = objs.filter((o) => o.kind === 'object').length;
  if (furn || stairs) $('stats').insertAdjacentHTML('beforeend', `<p class="objects-note">Also read from the drawing: ${furn} piece${furn === 1 ? '' : 's'} of furniture or machinery, ${stairs} stair flight${stairs === 1 ? '' : 's'}.</p>`);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const i of s.issues) counts[i.severity]++;
  $('issue-count').textContent = s.issues.length ? `${counts.critical} critical · ${counts.warning} warnings · ${counts.info} notes` : 'nothing to check';
  const il = $('issues');
  il.innerHTML = '';
  for (const is of s.issues) {
    const li = document.createElement('li');
    li.className = is.severity;
    li.tabIndex = 0;
    li.innerHTML = `<span class="sev">${is.severity === 'critical' ? '!' : is.severity === 'warning' ? '▲' : 'i'}<em>${is.severity}</em></span><span>${escapeHtml(is.message)}</span>`;
    const go = () => {
      for (const o of il.children) o.classList.toggle('sel', o === li);
      setTab('3d');
      viewer.focusIssue(is);
    };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    il.appendChild(li);
  }

  const list = $('zones');
  list.innerHTML = '';
  s.zones.forEach((z, i) => {
    const li = document.createElement('li');
    li.dataset.id = z.id;
    const e = s.egress.zones[z.id];
    const far = e && Number.isFinite(e.max_m) ? `${e.max_m} m to exit` : 'no exit route';
    const printed = z.printed_area_m2 ? ` · plan says ${z.printed_area_m2} m² (${pct(z.area_m2, z.printed_area_m2)})` : '';
    li.innerHTML = `<span class="sw" style="background:${zoneColor(z, i)}"></span>
      <input value="${escapeHtml(z.name)}" aria-label="Zone name">
      <select aria-label="Zone type">${ZONE_TYPES.map((t) => `<option ${t === z.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <small>${z.area_m2} m²${printed} · ${far}</small>`;
    if (z.printed_area_m2 && !state.pxPerM && !z.merged_labels) {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = 'Set scale from this room';
      b.title = `Rescale the plan so ${z.name} measures ${z.printed_area_m2} m²`;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); calibrate(z.id); });
      li.appendChild(b);
    }
    li.querySelector('input').addEventListener('change', (ev) => { z.name = ev.target.value; delete z.name_src; viewer.refresh(); });
    li.querySelector('select').addEventListener('change', (ev) => {
      z.type = ev.target.value;
      li.querySelector('.sw').style.background = zoneColor(z, i);
      viewer.refresh();
    });
    li.addEventListener('click', (ev) => { if (ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'SELECT') selectZone(z.id); });
    list.appendChild(li);
  });
  $('empty').hidden = true;
  $('dist-legend').innerHTML = `<span>exit</span>${DIST_COLORS.ramp.map((c) => `<i style="background:${c}"></i>`).join('')}<span>${s.egress.limit_m} m</span>
    <i style="background:${DIST_COLORS.over}"></i><span>over</span><i style="background:${DIST_COLORS.none}"></i><span>no route</span>`;
}

// Scale from one room whose area is printed on the plan: area grows with the square of the scale.
function calibrate(zoneId) {
  const zoneAtPixel = ([px, py]) => {
    const src = state.base.source;
    const id = state.site.grid.zone_ids[Math.floor((py - src.originPx[1]) / src.cellPx)]?.[Math.floor((px - src.originPx[0]) / src.cellPx)];
    return state.site.zones.find((z) => z.id === `Z${id}`);
  };
  let z = state.site.zones.find((x) => x.id === zoneId);
  if (!z?.printed_area_m2) return;
  const name = z.name, printed = z.printed_area_m2;
  // remember the room by an image pixel inside it; ids change when the plan is re-read
  const src = state.base.source, c = state.seg.params.cellM;
  const anchor = [src.originPx[0] + (z.centroid[0] / c) * src.cellPx, src.originPx[1] + (z.centroid[1] / c) * src.cellPx];
  for (let k = 0; k < 4 && z; k++) {
    const f = Math.sqrt(printed / z.area_m2);
    if (Math.abs(f - 1) < 0.002) break;
    $('p-width').value = (parseFloat($('p-width').value) * f).toFixed(2);
    process();
    z = zoneAtPixel(anchor);
  }
  setStatus(`Scale set from ${name} (${printed} m²): building width ${$('p-width').value} m.`);
  state.scaleFrom = 'typed';
  $('scale-note').textContent = `Scale set from ${name} (${printed} m² printed on the plan).`;
}

const pct = (a, b) => `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%`;

function selectZone(id) {
  const same = viewer.selected === id;
  viewer.highlight(same ? null : id);
  for (const li of $('zones').children) li.classList.toggle('sel', !same && li.dataset.id === id);
  if (!same && id) $('zones').querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setStatus(msg, err = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('err', err);
}

function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('[data-tabbtn]')) b.setAttribute('aria-selected', b.dataset.tabbtn === tab);
  if (tab === 'edit') editor.draw();
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function download(text, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  navigator.clipboard?.writeText(text).then(() => setStatus(`${filename} downloaded and copied to the clipboard`), () => setStatus(`${filename} downloaded`));
}

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) handleFile(f);
  e.target.value = '';
});
function handleFile(f) {
  if (!PLAN_FILE.test(f.name)) {
    setStatus('Open a plan as DXF, PDF or an image (PNG, JPG).', true);
    return;
  }
  const name = f.name.replace(/\.[^.]+$/, '');
  const fail = (err) => { setStatus(`Could not read ${f.name}: ${err.message}`, true); console.error(err); };
  const ext = f.name.split('.').pop().toLowerCase();
  if (ext === 'dxf') f.text().then((t) => loadDxf(t, name)).catch(fail);
  else if (ext === 'pdf') f.arrayBuffer().then((b) => loadPdf(b, name)).catch(fail);
  else loadImage(URL.createObjectURL(f), name, null).catch(fail);
}
const drop = $('main');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

async function loadSample(kind) {
  const s = SAMPLES[kind];
  if (!s) return;
  try {
    if (kind === 'dxf') await loadDxf(await (await fetch(s.url)).text(), 'Sample factory');
    if (kind === 'pdf') await loadPdf(await (await fetch(s.url)).arrayBuffer(), 'Sample factory');
    if (kind === 'png') await loadImage(s.url, 'Sample factory', s.widthM, s.hints);
  } catch (err) { setStatus(`Could not load the sample: ${err.message}`, true); console.error(err); }
}
$('sample').addEventListener('change', (e) => loadSample(e.target.value));
for (const id of ['p-width', 'p-cell', 'p-door', 'p-filter']) {
  $(id).addEventListener('change', () => {
    if (id === 'p-width') { state.scaleFrom = 'typed'; $('scale-note').textContent = scaleNote(); }
    state.source ? process() : resegment();
  });
}
$('p-travel').addEventListener('change', () => resegment());
$('p-height').addEventListener('input', (e) => { viewer.setWallHeight(parseFloat(e.target.value)); sim.equipment.refresh(); });
$('t-overlay').addEventListener('change', (e) => viewer.setOverlay(e.target.checked));
$('t-labels').addEventListener('change', (e) => viewer.setLabels(e.target.checked));
$('t-objects').addEventListener('change', (e) => viewer.setObjects(e.target.checked));
$('color-mode').addEventListener('change', (e) => {
  viewer.setColorMode(e.target.value);
  $('dist-legend').hidden = e.target.value !== 'distance';
});
for (const b of document.querySelectorAll('[data-tabbtn]')) b.addEventListener('click', () => setTab(b.dataset.tabbtn));
for (const b of document.querySelectorAll('button[data-mode]')) b.addEventListener('click', () => {
  if (!state.site) return;
  for (const o of document.querySelectorAll('button[data-mode]')) o.setAttribute('aria-pressed', o === b);
  document.body.dataset.mode = b.dataset.mode;
  viewer.setMode(b.dataset.mode);
});
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => {
  for (const o of document.querySelectorAll('[data-tool]')) o.setAttribute('aria-pressed', o === b);
  editor.tool = EDIT[b.dataset.tool];
});
$('brush').addEventListener('change', (e) => { editor.brush = parseInt(e.target.value, 10); });
$('undo').addEventListener('click', () => editor.undo());
$('clear').addEventListener('click', () => editor.clear());
const slug = () => state.site.name.replace(/\W+/g, '_').toLowerCase();
$('export').addEventListener('click', () => state.site && download(JSON.stringify(state.site, null, 1), `${slug()}_site.json`, 'application/json'));
$('export-ifc').addEventListener('click', () => state.site && download(siteToIfc(state.site, { wallHeight: parseFloat($('p-height').value) }), `${slug()}.ifc`, 'application/x-step'));
$('check-ifc').addEventListener('click', async () => {
  if (!state.site) return;
  const text = siteToIfc(state.site, { wallHeight: parseFloat($('p-height').value) });
  try { await openIfc(new TextEncoder().encode(text), `${slug()}.ifc`); } catch (err) { setStatus(`web-ifc could not read the export: ${err.message}`, true); }
});
if (!('exitPointerLock' in document)) document.querySelector('button[data-mode="walk"]').hidden = true;

document.body.dataset.tab ||= '3d';
document.body.dataset.mode ||= 'orbit';

// expose for debugging and tests
window.optesc = { state, sim, calibrate, viewer, editor, loadDxf, loadPdf, loadImage, loadSample, siteToIfc };
loadSample('dxf');
