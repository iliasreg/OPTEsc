import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as equipment from '../frontend/src/equipment.js';
const { equipmentPlan } = equipment;
import { planPdf, planDxf, planText } from '../frontend/src/planexport.js';

// The historical JSON fixture predates the browser DXF's door numbering.
const factory = JSON.parse(fs.readFileSync(new URL('../data/samples/factory_site.json', import.meta.url)));
const exitIds = ['D1', 'D9', 'D11'];
let exitIndex = 0;
for (const d of factory.doors) d.id = d.is_exit ? exitIds[exitIndex++] : `INNER-${d.id}`;

test('equipment planning uses explicit approved exits for targets and placement reasons without changing geometry', () => {
  const before = JSON.stringify(factory);
  const plan = equipmentPlan(factory, { evacuationExitIds: ['D9'] });
  assert.deepEqual(plan.targets.filter(t => t.kind === 'lintel').map(t => t.door), ['D9']);
  const reasons = [...plan.projectors, ...plan.cameras].map(d => d.reason).join(' ');
  assert.doesNotMatch(reasons, /exit(?:s)? D1\b|exit(?:s)? D11\b/);
  assert.match(reasons, /exit D9\b/);
  assert.equal(JSON.stringify(factory), before);
});

test('PDF and DXF drawing labels and narratives distinguish approved and excluded candidates', () => {
  const plan = equipmentPlan(factory, { evacuationExitIds: ['D9'] });
  const pdf = Buffer.from(planPdf(factory, plan)).toString('latin1');
  const dxf = planDxf(factory, plan);
  const pdfText = [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1].replace(/\\([\\()])/g, '$1')).join(' ');
  for (const text of [pdfText, dxf]) {
    assert.match(text, /EXIT D9\b/);
    assert.doesNotMatch(text, /\bEXIT D1\b|\bEXIT D11\b/);
    assert.match(text, /EXCLUDED D1\b/);
    assert.match(text, /EXCLUDED D11\b/);
    assert.match(text, /Reviewed software-drill exits: D9/);
  }
  assert.match(JSON.stringify(planText(factory, plan)), /Excluded candidates: D1, D11/);
});

test('browser planning binds the exact geometry and fails closed even with spoofed exit IDs', async () => {
  assert.equal(typeof equipment.reviewedEquipmentPlan, 'function');
  const site = structuredClone(factory);
  site.evacuationExitIds = ['D9'];
  const before = JSON.stringify(site);
  const plan = await equipment.reviewedEquipmentPlan(site, { evacuationExitIds: ['D9'] });
  assert.deepEqual(plan.exitPolicy.approved, []);
  assert.equal(plan.exitPolicy.reviewed, false);
  assert.ok(!plan.targets.some(t => t.kind === 'lintel'));
  assert.ok(plan.targets.every(t => !t.dir));
  assert.doesNotMatch(plan.projectors.map(p => p.reason).join(' '), /pointing everyone.*exit/);
  const pdf = Buffer.from(planPdf(site, plan)).toString('latin1');
  const arrowPaths = pdf.split('\n').filter(line => line.endsWith(' h f') && (line.match(/ l\b/g) || []).length === 6);
  assert.equal(arrowPaths.length, 1, 'only the legend may draw an arrow when no route is approved');
  for (const text of [pdf, planDxf(site, plan)]) {
    assert.doesNotMatch(text, /EXIT D(?:1|9|11)\b/);
    for (const id of ['D1', 'D9', 'D11']) assert.ok(text.includes(`UNREVIEWED ${id}`));
    assert.ok(text.includes('No reviewed exit policy'));
  }
  assert.equal(JSON.stringify(site), before);
});

test('browser PDF and DXF handlers await policy-bound planning and export its captured site', async () => {
  const source = fs.readFileSync(new URL('../frontend/src/simui.js', import.meta.url), 'utf8');
  for (const id of ['export-pdf', 'export-dxf']) {
    let handler;
    const saved = [], statuses = [], site = { name: 'captured' }, plan = { approved: 'D9' };
    const context = vm.createContext({
      document: { addEventListener: (_, fn) => { handler = fn; } },
      ensureKit: async () => ({ site, plan, summary: 'bound' }),
      getSite: () => ({ name: 'later plan' }),
      planPdf: (s, p) => { assert.equal(s, site); assert.equal(p, plan); return 'pdf'; },
      planDxf: (s, p) => { assert.equal(s, site); assert.equal(p, plan); return 'dxf'; },
      save: (...args) => saved.push(args), slug: () => 'site',
      setStatus: (...args) => statuses.push(args), console: { error() {} },
    });
    vm.runInContext(source.slice(source.indexOf('  // View → Export'), source.indexOf("  $('t-projections')")), context);
    await handler({ target: { id } });
    assert.equal(saved.length, 1, JSON.stringify(statuses));
  }
});
