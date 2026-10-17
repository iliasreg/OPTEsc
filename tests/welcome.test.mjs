import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readTheme, applyTheme } from '../frontend/src/theme.js';

// Small DOM harness: exercise actual module handlers without browser dependencies.
function harness(saved = 'dark') {
  const elements = new Map();
  class Element {
    dataset = {}; attributes = {}; hidden = false; inert = false; value = ''; textContent = ''; listeners = {};
    classList = { add() {}, remove() {} };
    set id(value) { this._id = value; if (value) elements.set(value, this); }
    get id() { return this._id; }
    constructor(id = '') { this.id = id; }
    set innerHTML(html) { this.html = html; for (const match of html.matchAll(/id="([^"]+)"/g)) new Element(match[1]); }
    get innerHTML() { return this.html; }
    append() {} prepend() {} focus() { document.activeElement = this; }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(k, fn) { this.listeners[k] = fn; }
    fire(k, extra = {}) { return this.listeners[k]?.({ preventDefault() {}, ...extra }); }
    click() { this.fire('click'); }
    querySelector(selector) { return document.querySelector(selector); }
  }
  const document = {
    body: new Element(), documentElement: new Element(), activeElement: null,
    createElement: () => new Element(), getElementById: id => elements.get(id),
    querySelector: selector => elements.get(selector.replace(/^#/, '')),
    querySelectorAll: () => ['main', 'workspace-toolbar', 'workspace-panel', 'workspace-internal'].map(id => elements.get(id)),
  };
  ['main', 'workspace-toolbar', 'workspace-panel', 'workspace-internal'].forEach(id => new Element(id));
  const data = new Map([['optesc-theme', saved]]);
  const window = { localStorage: { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) } };
  let observe;
  const context = vm.createContext({ document, window, readTheme, applyTheme,
    MutationObserver: class { constructor(fn) { observe = fn; } observe() {} },
  });
  const source = fs.readFileSync(new URL('../frontend/src/welcome.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\n/m, '').replace('export function', 'function'), context);
  const files = [], samples = [];
  const ui = context.initWelcome({ onFile: file => files.push(file), onSample: () => samples.push(true) });
  return { ui, document, elements, files, samples, data, observe: () => observe?.(), get: id => elements.get(id) };
}

test('screen CSS excludes hidden controls and preserves reduced-motion and mobile layouts', () => {
  const css = fs.readFileSync(new URL('../frontend/welcome.css', import.meta.url), 'utf8');
  assert.match(css, /body:not\(\[data-screen="workspace"\]\)[^{]*#main/);
  assert.match(css, /#workspace-toolbar/);
  assert.match(css, /#workspace-panel/);
  assert.match(css, /display:\s*none\s*!important/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /max-width:\s*760px/);
  const h = harness();
  assert.doesNotMatch(h.get('welcome').innerHTML, /<footer|Turn a floor plan into a 3D building|A planning prototype/);
});

test('home theme persists and follows workspace theme changes without mutation loops', () => {
  const h = harness('light');
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  assert.match(h.get('welcome-logo').src, /black\.png$/);
  h.get('welcome-theme').click();
  assert.equal(h.document.documentElement.dataset.theme, 'dark');
  assert.equal(h.data.get('optesc-theme'), 'dark');
  assert.match(h.get('welcome-logo').src, /white\.png$/);
  h.document.documentElement.dataset.theme = 'light';
  h.observe();
  assert.match(h.get('welcome-logo').src, /black\.png$/);
  assert.equal(h.get('welcome-theme').textContent, 'Dark mode');
});

test('picker and drop delegate valid plans without claiming completion', () => {
  const h = harness(), file = { name: 'Plan.DXF', size: 10 };
  h.get('welcome-file').files = [file];
  h.get('welcome-file').fire('change');
  assert.equal(h.files[0], file);
  assert.equal(h.document.body.dataset.screen, 'home');
  for (const extension of ['pdf','png','jpg','jpeg','webp','bmp','gif']) {
    const dropped = {name: `plan.${extension}`, size: 1};
    h.get('welcome-drop').fire('drop', {dataTransfer: {files: [dropped]}});
    assert.equal(h.files.at(-1), dropped);
  }
  const count = h.files.length;
  for (const file of [{name:'bad.exe',size:1},{name:'empty.pdf',size:0}]) {
    h.get('welcome-file').files = [file];
    h.get('welcome-file').fire('change');
    assert.ok(h.get('welcome-message').textContent.length > 0);
    h.get('welcome-drop').fire('drop', {dataTransfer: {files:[file]}});
    assert.equal(h.files.length, count);
  }
  h.get('welcome-file').files = [];
  h.get('welcome-file').fire('change');
  h.get('welcome-drop').fire('drop', {dataTransfer: {files:[]}});
  assert.equal(h.files.length, count);
  h.get('welcome-sample').click();
  assert.equal(h.samples.length, 1);
  assert.equal(h.document.body.dataset.screen, 'home');
});

test('welcome starts home and only explicit completion exposes the workspace', () => {
  const h = harness();
  assert.equal(h.document.body.dataset.screen, 'home');
  assert.equal(h.get('main').inert, true);
  assert.equal(h.get('welcome').hidden, false);
  assert.equal(h.files.length + h.samples.length, 0);
  h.ui.showLoading('factory.dxf');
  assert.equal(h.document.body.dataset.screen, 'loading');
  assert.equal(h.get('welcome-loading').hidden, false);
  assert.equal(h.get('welcome-loading-name').textContent, 'factory.dxf');
  assert.equal(h.get('welcome-loading').getAttribute('role'), 'status');
  assert.equal(h.get('main').inert, true);
  h.ui.showWorkspace();
  assert.equal(h.document.body.dataset.screen, 'workspace');
  assert.equal(h.get('welcome').hidden, true);
  assert.equal(h.get('main').inert, false);
  h.ui.showError('Cannot read this plan.');
  assert.equal(h.document.body.dataset.screen, 'home');
  assert.equal(h.get('welcome-message').textContent, 'Cannot read this plan.');
  assert.equal(h.get('main').inert, true);
  h.ui.showHome();
  assert.equal(h.get('welcome-message').textContent, '');
});
