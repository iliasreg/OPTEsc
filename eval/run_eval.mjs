// OPTEsc plan reader evaluation. Drives the real page in a headless browser so the numbers come
// from exactly the code users run.
//   1. Sample factory (DXF, PDF, PNG) against its known geometry: room areas, door widths, swing.
//   2. Real floor plans opened with no scale and no hints: rooms found, names read, and areas
//      against the sizes printed on the plan.
//   3. Every IFC export checked by two independent readers: IfcOpenShell and web-ifc.
// Usage: (serve frontend/ on a port, e.g. `python3 -m http.server 8765 -d frontend`)
//        cd eval && npm i && node run_eval.mjs [--url http://localhost:8765/] [--chromium /path]
// Writes eval/out/results.json, eval/out/report.md and the IFC files.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('--url', 'http://localhost:8765/');
const OUT = path.join(here, 'out');
await mkdir(path.join(OUT, 'cache'), { recursive: true });

const browser = await chromium.launch({ executablePath: arg('--chromium', process.env.CHROMIUM_PATH), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
// --walls http://localhost:8766 scores the page with the AI wall finder (tools/wall_server.py) running
const WALLS = arg('--walls', '');
await page.goto(WALLS ? `${URL_}?walls=${encodeURIComponent(WALLS)}` : `${URL_}?walls=http://127.0.0.1:9`);
await page.waitForFunction(() => window.optesc?.state?.site);

const pct = (a, b) => Math.round(((a - b) / b) * 1000) / 10;
const results = { date: new Date().toISOString(), synthetic: {}, real: {}, ifc: {} };

// ---------- 1. synthetic sample ----------
const truth = JSON.parse(await readFile(path.join(here, '../data/samples/factory_truth.json'), 'utf8'));
for (const kind of process.argv.includes('--plans') ? [] : ['dxf', 'pdf', 'png']) {
  await page.evaluate((k) => optesc.loadSample(k), kind);
  await page.waitForTimeout(500);
  const site = await page.evaluate(() => optesc.state.site);
  // rooms: by name (merged rooms are compared with the sum of their parts)
  const rooms = site.zones.filter((z) => !z.name.startsWith('Zone ')).map((z) => {
    const parts = z.name.split(' + ').map((n) => truth.rooms.find((r) => r.name.toLowerCase() === n.toLowerCase()));
    const t = parts.every(Boolean) ? parts.reduce((a, r) => a + r.net_area_m2, 0) : null;
    return { name: z.name, measured: z.area_m2, truth: t && Math.round(t * 100) / 100, error_pct: t && pct(z.area_m2, t), merged: parts.length > 1 };
  });
  // doors: the plan origin differs per format, so find the shift that lines most doors up
  const votes = new Map();
  for (const d of site.doors) for (const t of truth.doors) {
    const k = `${Math.round((d.x - t.centre[0]) * 10)},${Math.round((d.y - t.centre[1]) * 10)}`;
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  const [ox, oy] = [...votes].sort((a, b) => b[1] - a[1])[0][0].split(',').map((v) => v / 10);
  const doors = truth.doors.map((t) => {
    const d = site.doors.map((d) => ({ d, r: Math.hypot(d.x - ox - t.centre[0], d.y - oy - t.centre[1]) })).sort((a, b) => a.r - b.r)[0];
    if (!d || d.r > 0.6) {
      // a wide opening with no leaf is an archway, not a door: it is an opening between the two rooms
      // (or joins them into one, flagged, when they have no names to split them by)
      const archway = t.swing_side == null && t.width_m > 1.2 && (site.openings?.length > 0 || site.zones.some((z) => z.merged_labels));
      return { truth: t, found: false, archway };
    }
    const s = d.d.swing;
    const side = s?.toward ? (s.toward[0] === '+' ? 1 : -1) : null;
    const hingeErr = s?.hinge && t.hinge ? Math.hypot(s.hinge[0] - ox - t.hinge[0], s.hinge[1] - oy - t.hinge[1]) : null;
    return {
      id: d.d.id, found: true, width: d.d.width_m, truth_width: t.width_m, width_err_m: Math.round((d.d.width_m - t.width_m) * 100) / 100,
      swing_truth: t.swing_side, swing_found: side, swing_ok: t.swing_side == null ? side == null : side === t.swing_side,
      hinge_ok: t.hinge ? hingeErr != null && hingeErr < 0.3 : null,
    };
  });
  results.synthetic[kind] = { rooms, doors, issues: site.issues.map((i) => `${i.severity} ${i.code}${i.target ? ' ' + i.target : ''}`) };
  results.ifc[`sample_${kind}`] = await exportIfc(`sample_${kind}`);
}

// ---------- 2. real plans ----------
// Opened the way a user would: no scale, no hints. Names, sizes and scale come from the plan itself.
const norm = (t) => (t || '').normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();
const nameOk = (want, got) => { const a = norm(want), b = norm(got); return !!a && !!b && (b.includes(a) || a.includes(b)); };
const mime = (buf) => buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
const real = JSON.parse(await readFile(path.join(here, arg('--plans', 'real_plans.json')), 'utf8'));
for (const plan of real.plans) {
  let file = plan.file;
  if (!file) {
    file = path.join(OUT, 'cache', `${plan.id}.png`);
    try { await access(file); } catch {
      const r = await fetch(plan.url);
      if (!r.ok) { results.real[plan.id] = { error: `download failed: ${r.status}` }; continue; }
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    }
  }
  let buf;
  try { buf = await readFile(file); } catch { results.real[plan.id] = { error: 'plan file not available here' }; continue; }
  const dataUrl = `data:${mime(buf)};base64,${buf.toString('base64')}`;
  const out = await page.evaluate(async ({ dataUrl, name, pts }) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const k = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    await optesc.loadImage(dataUrl, name);
    const s = optesc.state.site, b = optesc.state.base.source;
    const at = (p) => { const id = s.grid.zone_ids[Math.floor((p.y * k - b.originPx[1]) / b.cellPx)]?.[Math.floor((p.x * k - b.originPx[0]) / b.cellPx)]; return s.zones.find((z) => z.id === `Z${id}`); };
    return {
      width_m: Number(document.getElementById('p-width').value), scale_from: optesc.state.scaleFrom, walls_from: s.source.walls_from, zones: s.zones.length,
      named: s.zones.filter((z) => z.name_src === 'plan').length,
      rooms: pts.map((p) => { const z = at(p); return z ? { zone: z.id, zone_name: z.name, measured: z.area_m2 } : { zone: null }; }),
      doors: s.doors.length, issues: s.issues.map((i) => `${i.severity} ${i.code}`),
    };
  }, { dataUrl, name: plan.id, pts: plan.rooms.map((r) => ({ x: r.x, y: r.y })) });
  const zoneOf = new Map(plan.rooms.map((r, i) => [r, out.rooms[i]]));
  const count = new Map();
  for (const r of out.rooms) if (r.zone) count.set(r.zone, (count.get(r.zone) || 0) + 1);
  const rooms = plan.rooms.map((r) => {
    const z = zoneOf.get(r);
    const own = z.zone && count.get(z.zone) === 1;
    let measured = z.measured ?? null;
    if (own && r.area_covers) for (const c of r.area_covers) { const o = zoneOf.get(plan.rooms.find((x) => x.name === c)); if (o?.zone && o.zone !== z.zone) measured += o.measured; }
    return {
      name: r.name ?? r.what, readable: r.name != null, found: !!own, zone_name: z.zone_name ?? null,
      named_ok: r.name == null ? null : own && nameOk(r.name, z.zone_name),
      printed: r.area ?? null, measured: measured && Math.round(measured * 100) / 100,
      error_pct: own && r.area ? pct(measured, r.area) : null, covers: r.area_covers ?? null,
    };
  });
  results.real[plan.id] = { source: plan.source, walls_from: out.walls_from, width_m: out.width_m, scale_from: out.scale_from, zones: out.zones, doors: out.doors, issues: out.issues, rooms };
  await page.screenshot({ path: path.join(OUT, `${plan.id}.png`) });
  results.ifc[plan.id] = await exportIfc(plan.id);
}

async function exportIfc(id) {
  const { text, webifc } = await page.evaluate(async () => {
    const text = optesc.siteToIfc(optesc.state.site);
    const { loadIfc } = await import('./src/ifcview.js');
    const { counts } = await loadIfc(new TextEncoder().encode(text));
    return { text, webifc: counts };
  });
  const file = path.join(OUT, `${id}.ifc`);
  await writeFile(file, text);
  let ifcopenshell = null;
  try { ifcopenshell = JSON.parse(execFileSync('python3', [path.join(here, 'ifc_check.py'), file], { encoding: 'utf8' })); } catch (e) { ifcopenshell = { error: 'IfcOpenShell not available: pip install ifcopenshell' }; }
  return { webifc, ifcopenshell };
}

await browser.close();
const tag = (process.argv.includes('--plans') ? path.basename(arg('--plans'), '.json') + '_' : '') + (WALLS ? 'ai_' : '');
await writeFile(path.join(OUT, tag + 'results.json'), JSON.stringify(results, null, 2));

// ---------- report ----------
const L = ['# OPTEsc plan reader: evaluation', '', `Run ${results.date}.`, '', '## Sample factory (known geometry)', ''];
for (const [k, r] of Object.entries(results.synthetic)) {
  const errs = r.rooms.filter((x) => x.error_pct != null).map((x) => Math.abs(x.error_pct));
  const dw = r.doors.filter((d) => d.found).map((d) => Math.abs(d.width_err_m));
  L.push(`**${k.toUpperCase()}**: rooms within ${Math.max(...errs)}% (mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)}%), ` +
    `${r.doors.filter((d) => d.found).length}/${r.doors.filter((d) => !d.archway).length} doors found, widths within ${Math.max(...dw).toFixed(2)} m, ` +
    `swing side right ${r.doors.filter((d) => d.swing_ok).length}/${r.doors.filter((d) => !d.archway).length}, hinge right ${r.doors.filter((d) => d.hinge_ok).length}/${r.doors.filter((d) => d.hinge_ok != null).length}.`, '');
  L.push('| Room | Measured m² | True m² | Error |', '|---|---|---|---|', ...r.rooms.map((x) => `| ${x.name} | ${x.measured} | ${x.truth ?? '?'} | ${x.error_pct ?? '?'}% |`), '');
  const arch = r.doors.filter((d) => d.archway);
  if (arch.length) L.push(`Open archways (no door leaf) are read as openings between rooms, not doors: ${arch.map((d) => `${d.truth.width_m} m at ${d.truth.centre}`).join(', ')}.`, '');
  const bad = r.doors.filter((d) => !d.archway && (!d.found || !d.swing_ok || d.hinge_ok === false));
  if (bad.length) L.push('Door misses: ' + bad.map((d) => d.found ? `${d.id} (swing ${d.swing_found ?? 'not seen'} vs ${d.swing_truth ?? 'none'}${d.hinge_ok === false ? ', hinge wrong' : ''})` : `door at ${d.truth.centre} not found`).join('; ') + '.', '');
}
L.push('## Real plans (opened with no scale and no hints)', '');
for (const [k, r] of Object.entries(results.real)) {
  if (r.error) { L.push(`**${k}**: ${r.error}`, ''); continue; }
  const found = r.rooms.filter((x) => x.found).length, readable = r.rooms.filter((x) => x.readable);
  const errs = r.rooms.filter((x) => x.error_pct != null).map((x) => Math.abs(x.error_pct)).sort((a, b) => a - b);
  L.push(`**${k}**: ${found}/${r.rooms.length} rooms found on their own, ${readable.filter((x) => x.named_ok).length}/${readable.length} readable names right, scale from ${r.scale_from} (width ${r.width_m} m), walls from ${r.walls_from}` +
    (errs.length ? `, area error median ${errs[Math.floor(errs.length / 2)]}%, worst ${errs[errs.length - 1]}% over ${errs.length} printed rooms.` : '.'), '');
  L.push('| Room on plan | Found as | Printed m² | Measured m² | Error |', '|---|---|---|---|---|',
    ...r.rooms.map((x) => `| ${x.name}${x.readable ? '' : ' (name not readable)'} | ${x.found ? x.zone_name : x.zone_name ? `merged into ${x.zone_name}` : 'not found'} | ${x.printed ?? '-'}${x.covers ? ` (with ${x.covers.join(', ')})` : ''} | ${x.measured ?? '-'} | ${x.error_pct ?? '-'}${x.error_pct != null ? '%' : ''} |`), '');
}
L.push('## IFC export read by independent tools', '', '| Plan | web-ifc walls/doors/windows/spaces | IfcOpenShell rule issues | IfcOpenShell geometry |', '|---|---|---|---|');
for (const [k, r] of Object.entries(results.ifc)) {
  const w = r.webifc, o = r.ifcopenshell;
  L.push(`| ${k} | ${w.walls}/${w.doors}/${w.windows}/${w.spaces} | ${o.error ?? o.validation_issues.length} | ${o.error ? '-' : `${o.geometry_ok} built, ${o.geometry_failed.length} failed`} |`);
}
await writeFile(path.join(OUT, tag + 'report.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
