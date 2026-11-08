// The glass look: the second value of the head's skin switch (the first is
// the brand look, tests/new-look.test.js). `window.Skin` keeps the choice on
// the device under 'homeroom:skin' and sets data-skin="glass" on <html>
// before first paint; `?skin=` pins a look for one load, for the capture
// runner; app.css draws the look from the attribute in light AND dark.
//
// Run with: node --test tests/glass-skin.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const headSrc = () => read('frontend', 'src', 'head.html');
const settingsJs = () => read('frontend', 'src', 'features', 'settings', 'settings.js');
const experimentalSrc = () => read('frontend', 'src', 'features', 'settings', 'sections', 'experimental.tsx');

// The Skin module's own source: from its assignment to the end of its IIFE
// (the same slice tests/new-look.test.js takes).
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage,
// `search` is the page's query string, `broken` makes storage throw.
function runSkin({ stored = null, search = '', broken = false } = {}) {
  const store = new Map(stored === null ? [] : [['homeroom:skin', stored]]);
  const attrs = new Map();
  const listeners = [];
  const localStorage = {
    getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('blocked'); store.delete(k); },
  };
  const window = {
    localStorage,
    location: { search },
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document, URLSearchParams });
  return { Skin: window.Skin, store, attrs, listeners };
}

// ── The inline head module ───────────────────────────────────────────────

test('glass is stored and applied like brand', () => {
  const { Skin, store, attrs } = runSkin();
  Skin.set('glass');
  assert.equal(store.get('homeroom:skin'), 'glass');
  assert.equal(attrs.get('data-skin'), 'glass');
  assert.equal(Skin.get(), 'glass');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false);
  assert.equal(attrs.has('data-skin'), false);
});

test('a stored glass is on <html> as soon as the module runs', () => {
  assert.equal(runSkin({ stored: 'glass' }).attrs.get('data-skin'), 'glass');
});

test('brand still works beside glass', () => {
  const { Skin, attrs } = runSkin({ stored: 'glass' });
  Skin.set('brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('?skin= pins the look for this load and stores nothing', () => {
  const r = runSkin({ stored: 'brand', search: '?skin=glass' });
  assert.equal(r.attrs.get('data-skin'), 'glass');
  assert.equal(r.Skin.get(), 'glass');
  assert.equal(r.store.get('homeroom:skin'), 'brand', 'the pin is for this load only');
  const off = runSkin({ stored: 'glass', search: '?skin=standard' });
  assert.equal(off.attrs.has('data-skin'), false, 'standard pins the standard look over a stored one');
  assert.equal(runSkin({ search: '?skin=neon' }).Skin.get(), 'standard', 'an unknown pin is ignored');
});

// ── The settings switch ──────────────────────────────────────────────────

test('Settings › Experimental carries the Glass look switch under New look', () => {
  const src = experimentalSrc();
  assert.match(src, /<SwitchRow id="glass-look-enabled">/);
  assert.ok(src.indexOf('id="new-look-enabled"') < src.indexOf('id="glass-look-enabled"'));
  assert.ok(src.indexOf('id="glass-look-enabled"') < src.indexOf('id="settings-local-agents-section"'));
  assert.match(src, /settings:experimental\.glassLook\.label/);
  assert.match(src, /settings:experimental\.glassLook\.description/);
});

test('settings.js saves and paints the glass switch through window.Skin', () => {
  const src = settingsJs();
  assert.match(src, /getElementById\('glass-look-enabled'\)/);
  assert.match(src, /window\.Skin\?\.set\?\.\(e\.target\.checked \? 'glass' : 'standard'\)/, 'the change is the save');
  assert.match(src, /window\.Skin\?\.get\?\.\(\) === 'glass'/, 'the pane paints the stored choice');
});

test('the glass switch copy is English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.glassLook.label', 'experimental.glassLook.description']) {
    assert.ok(en[key], `${key} exists`);
    assert.equal(typeof en[key].text, 'string');
    assert.ok(en[key].description.length > 20, `${key} says where it appears`);
  }
  assert.match(en['experimental.glassLook.description'].text, /Albert Sans/);
});
