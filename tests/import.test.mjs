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
  const site = {zones:[{id:'Z1'}]};
  const context = vm.createContext({
    welcome:null, sceneReady:Promise.resolve(),state:{site},
    document:{visibilityState:'visible'},requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),
    $: id => elements[id], console: { error() {} },
    viewer: {site,renderer: {setAnimationLoop() {}}, _tick() {},_resize() {}},
    setStatus: (...args) => statuses.push(args),
    loadDxf: async (text, name) => loaded.push(['dxf', text, name]),
    loadPdf: async (...args) => loaded.push(['pdf', args[1]]),
    loadImage: async (...args) => loaded.push(['image', args[1]]),
    loadSiteJson() {}, openIfc() {},
    URL: { createObjectURL: () => 'blob:plan', revokeObjectURL() {} },
    PLAN_FILE: /\.(dxf|pdf|png|jpe?g|webp|bmp|gif)$/i,
  });
  vm.runInContext(main.slice(main.indexOf('let importGeneration'), main.indexOf('// Render the DXF')), context);
  vm.runInContext(main.slice(main.indexOf("$('file').addEventListener"), main.indexOf('async function loadSample')), context);
  return { listeners, statuses, loaded };
}
const send = (h, pathway, file) => (pathway === 'picker'
  ? h.listeners['file:change']({ target: { files: [file], value: file.name } })
  : h.listeners['main:drop']({ preventDefault() {}, dataTransfer: { files: [file] } }));

for (const pathway of ['picker', 'drop']) {
  test(`${pathway} rejects anything but a DXF, a PDF or an image, before reading`, async () => {
    for (const name of ['site.json', 'plan.svg', 'plan.ifc', 'plan.dwg', 'plan.txt', 'dxf', 'plan.dxf.json', 'plan.pdf.exe', '']) {
      const h = harness();
      let reads = 0;
      const file = { name, type: 'image/png', text: async () => { reads++; return '{}'; }, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } };
      send(h, pathway, file);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 0, name);
      assert.deepEqual(h.statuses, [['Open a plan as DXF, PDF or an image (PNG, JPG).', true]], name);
      assert.equal(h.loaded.length, 0);
    }
  });
  test(`${pathway} reads DXF, PDF and images by their extension, whatever the MIME type`, async () => {
    for (const [name, want] of [['Floor.DXF', ['dxf', 'DXF text', 'Floor']], ['plan.PDF', ['pdf', 'plan']], ['scan.png', ['image', 'scan']], ['photo.JPG', ['image', 'photo']], ['plan.jpeg', ['image', 'plan']]]) {
      const h = harness();
      send(h, pathway, { name, type: '', text: async () => 'DXF text', arrayBuffer: async () => new ArrayBuffer(4) });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(h.loaded, [want], name);
    }
  });
}

test('the plan picker offers DXF, PDF and images; the exports remain', () => {
  assert.match(html, /id="file"[^>]*accept="\.dxf,\.pdf,\.png,\.jpg/);
  assert.match(main, /loadPdf/);
  assert.match(main, /loadImage/);
  assert.doesNotMatch(main, /loadSiteJson|aiWallFinder|findWalls/);
  for (const id of ['export', 'export-ifc', 'check-ifc']) assert.ok(html.includes(`id="${id}"`));
});
