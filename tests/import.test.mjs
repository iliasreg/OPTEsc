import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseDxf } from '../frontend/src/vector.js';

test('DXF parser rejects disguised non-DXF content', () => {
  for (const text of ['{}', '%PDF-1.7', '<svg/>', '', 'arbitrary text']) {
    assert.throws(() => parseDxf(text), /Invalid DXF/);
  }
  const sample = fs.readFileSync(new URL('../frontend/samples/factory_plan.dxf', import.meta.url), 'utf8');
  assert.ok(parseDxf(sample).entities.length > 0);
});

const main = fs.readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');

// Exercise the actual picker/drop handlers without requiring WebGL.
function harness() {
  const listeners = {}, statuses = [], loaded = [];
  const elements = Object.fromEntries(['file', 'main'].map(id => [id, {
    addEventListener: (event, fn) => { listeners[`${id}:${event}`] = fn; },
    classList: { add() {}, remove() {} },
  }]));
  const context = vm.createContext({
    $: id => elements[id], console: { error() {} },
    setStatus: (...args) => statuses.push(args),
    loadDxf: (...args) => loaded.push(args),
    loadSiteJson() {}, loadPdf() {}, openIfc() {}, loadImage() {},
    URL: { createObjectURL() { throw new Error('Unexpected image read'); } },
  });
  vm.runInContext(main.slice(main.indexOf("$('file').addEventListener"), main.indexOf('async function loadSample')), context);
  return { listeners, statuses, loaded };
}

for (const pathway of ['picker', 'drop']) {
  test(`${pathway} rejects every non-DXF before reading, including Site JSON`, async () => {
    for (const name of ['site.json', 'plan.pdf', 'plan.png', 'plan.jpg', 'plan.svg', 'plan.ifc', 'plan.dwg', 'plan.txt', 'dxf', 'plan.dxf.json', '']) {
      const h = harness();
      let reads = 0;
      const file = { name, type: 'image/png', text: async () => { reads++; return '{}'; }, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } };
      if (pathway === 'picker') h.listeners['file:change']({ target: { files: [file], value: name } });
      else h.listeners['main:drop']({ preventDefault() {}, dataTransfer: { files: [file] } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 0, name);
      assert.deepEqual(h.statuses, [['Only DXF (.dxf) plans are supported.', true]], name);
      assert.equal(h.loaded.length, 0);
    }
  });
  test(`${pathway} reads case-insensitive DXF regardless of MIME`, async () => {
    const h = harness();
    const file = { name: 'Floor.DXF', type: '', text: async () => 'DXF text' };
    if (pathway === 'picker') h.listeners['file:change']({ target: { files: [file], value: file.name } });
    else h.listeners['main:drop']({ preventDefault() {}, dataTransfer: { files: [file] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.loaded, [['DXF text', 'Floor']]);
  });
}

test('active import UI and loaders are DXF-only, exports remain', () => {
  assert.match(html, /id="file"[^>]*accept="\.dxf"/);
  assert.doesNotMatch(html, /value="(?:pdf|png)"|id="(?:p-ai|ai-row)"/);
  assert.doesNotMatch(main, /loadImage|loadPdf|loadSiteJson|renderPdf|aiWallFinder|findWalls|readPlanText/);
  for (const id of ['export', 'export-ifc', 'check-ifc']) assert.ok(html.includes(`id="${id}"`));
});
