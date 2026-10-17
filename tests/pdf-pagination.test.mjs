import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentPlan } from '../frontend/src/equipment.js';
import { planPdf, planText } from '../frontend/src/planexport.js';
import { hall } from './hall.mjs';

// The exporter uses uncompressed streams; validate the PDF structure without a CI dependency.
function readPdf(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const xref = Number(raw.match(/startxref\n(\d+)/)[1]);
  assert.ok(raw.slice(xref).startsWith('xref\n'));
  const objects = new Map();
  for (const [index, match] of [...raw.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].entries()) {
    const offset = Number(match[1]), id = index + 1;
    assert.ok(raw.slice(offset).startsWith(`${id} 0 obj\n`), `xref object ${id}`);
    objects.set(id, raw.slice(offset).split('\nendobj')[0]);
  }
  for (const object of objects.values()) {
    for (const match of object.split('\nstream\n')[0].matchAll(/\b(\d+) 0 R/g)) {
      assert.ok(objects.has(Number(match[1])), `dangling reference ${match[1]}`);
    }
  }
  const catalog = [...objects.values()].find((o) => /\/Type \/Catalog\b/.test(o));
  const root = Number(catalog.match(/\/Pages (\d+) 0 R/)[1]);
  const tree = objects.get(root), kids = [...tree.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)];
  assert.equal(kids.length, Number(tree.match(/\/Count (\d+)/)[1]));
  assert.equal(kids.length, [...objects.values()].filter((o) => /\/Type \/Page\b/.test(o)).length);
  return kids.map((kid) => {
    const page = objects.get(Number(kid[1]));
    assert.match(page, new RegExp(`/Parent ${root} 0 R`));
    const stream = objects.get(Number(page.match(/\/Contents (\d+) 0 R/)[1]));
    const content = stream.split('\nstream\n')[1].split('\nendstream')[0];
    assert.equal(content.length, Number(stream.match(/\/Length (\d+)/)[1]));
    const strings = [...content.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\([\\()])/g, '$1'));
    const text = new TextDecoder('windows-1252').decode(Uint8Array.from(strings.join(' '), (ch) => ch.charCodeAt(0)));
    return { content, text: text.replace(/\s+/g, ' ') };
  });
}

function assertExplanations(pages, expected) {
  const text = pages.map((p) => p.text).join(' ');
  assert.ok(text.includes('How they were placed, and why'));
  for (const [label, explanation] of expected.how) {
    assert.ok(text.includes(explanation), `missing method: ${label}`);
  }
  for (const [label, devices] of [['Projectors', expected.projectors], ['Cameras', expected.cameras]]) {
    assert.ok(text.includes(`${label} (${devices.length})`));
    for (const device of devices) {
      assert.ok(text.includes(`${device.id} ${device.head} — ${device.text}`), `missing schedule/reason: ${device.id}`);
    }
  }
  for (const warning of expected.warnings) assert.ok(text.includes(warning), `missing warning: ${warning}`);
}

test('large hall PDF preserves placement explanations and every device schedule on readable continuation pages', () => {
  const site = hall(100, 60), plan = equipmentPlan(site, { wallHeight: 3 });
  assert.equal(plan.projectors.length, 43);
  assert.equal(plan.cameras.length, 49);
  const pages = readPdf(planPdf(site, plan));
  assert.ok(pages.length > 1, 'large plan must use continuation pages, not drop its explanations');
  assert.ok(pages[0].text.includes('Legend'), 'plan and legend stay on the first page');
  assertExplanations(pages.slice(1), planText(site, plan));
  for (const page of pages.slice(1)) {
    for (const match of page.content.matchAll(/\/F[12] ([\d.]+) Tf/g)) {
      assert.ok(Number(match[1]) >= 9, `unreadable continuation text: ${match[1]} pt`);
    }
    for (const match of page.content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
      assert.ok(Number(match[2]) >= 28 && Number(match[2]) <= 841.89 - 28, 'text stays inside page margins');
    }
  }
});
