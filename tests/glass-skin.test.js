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

// ── The stylesheet ───────────────────────────────────────────────────────
//
// The glass block sits BEFORE the brand block (which stays last, as its own
// tests pin) and after a small unscoped section of token defaults, so a
// primitive that reads --surface or --acc renders sanely under every look.

const appCss = () => read('public', 'css', 'app.css');
const GLASS_MARK = '/* ── THE GLASS LOOK';
const BRAND_MARK = '/* ── THE NEW LOOK, AN EXPERIMENT';
const DEFAULTS_MARK = '/* ── SKIN TOKEN DEFAULTS';

function glassBlock() {
  const css = appCss();
  const at = css.indexOf(GLASS_MARK);
  const end = css.indexOf(BRAND_MARK);
  assert.ok(at > 0, 'app.css carries the glass block');
  assert.ok(end > at, 'the glass block ends where the brand block begins');
  return css.slice(at, end);
}

// Every selector of a block, with comments and the @media / @supports
// wrappers (which only narrow where a rule applies) stripped.
function selectorsOf(block) {
  const flat = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(media|supports)[^{]*\{/g, '');
  const out = [];
  for (const rule of flat.split('}').map((r) => r.trim()).filter(Boolean)) {
    const head = rule.slice(0, rule.indexOf('{')).trim();
    if (!head) continue;
    for (const sel of head.split(',').map((s) => s.trim())) out.push(sel);
  }
  return out;
}

test('Albert Sans is served from our own origin with its licence and provenance beside it', () => {
  for (const f of ['AlbertSans-Variable.woff2', 'AlbertSans-Variable-latin-ext.woff2', 'LICENSE.txt', 'README.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'fonts', 'albert-sans', f)), `public/fonts/albert-sans/${f}`);
  }
  const block = glassBlock();
  assert.match(block, /url\('\/fonts\/albert-sans\/AlbertSans-Variable\.woff2'\) format\('woff2'\)/);
  assert.match(block, /url\('\/fonts\/albert-sans\/AlbertSans-Variable-latin-ext\.woff2'\) format\('woff2'\)/);
  assert.match(read('public', 'fonts', 'albert-sans', 'README.md'), /sha384/);
  assert.match(read('public', 'fonts', 'albert-sans', 'LICENSE.txt'), /SIL Open Font License/);
});

test('every rule of the glass block is scoped to html[data-skin="glass"]', () => {
  const sels = selectorsOf(glassBlock());
  assert.ok(sels.length > 4, 'the block is read whole');
  for (const sel of sels) {
    assert.ok(sel === '@font-face' || sel.startsWith('html[data-skin="glass"]'), `"${sel}" must start from the flag`);
  }
});

test('the glass block draws dark too', () => {
  assert.match(glassBlock(), /html\[data-skin="glass"\]\.dark\s*\{/);
});

test('the glass block redeclares none of the counted wallpaper or frost tokens', () => {
  const block = glassBlock();
  for (const token of ['--home-ground:', '--home-wallpaper:', '--home-washes:', '--home-star:', '--home-grain:', '--dc-sheet-fill:', '--dc-frost:']) {
    assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
  }
});

test('without backdrop-filter the surface is opaque', () => {
  const block = glassBlock();
  const at = block.indexOf('@supports not (backdrop-filter: blur(1px))');
  assert.ok(at > 0, 'a fallback for browsers without backdrop-filter');
  const fallback = block.slice(at);
  assert.match(fallback, /html\[data-skin="glass"\]\s*\{[^}]*--surface:\s*#fbfbfd/);
  assert.match(fallback, /html\[data-skin="glass"\]\.dark\s*\{[^}]*--surface:\s*#171a2b/);
});

test('the token defaults come first, then the glass block, then the brand block last', () => {
  const css = appCss();
  const d = css.indexOf(DEFAULTS_MARK);
  const g = css.indexOf(GLASS_MARK);
  const b = css.indexOf(BRAND_MARK);
  assert.ok(d > 0 && d < g && g < b, 'defaults < glass < brand');
  const defaults = css.slice(d, g);
  for (const token of ['--surface:', '--ink:', '--mut:', '--acc:', '--acc-ink:', '--lit:', '--lit-t:', '--ok:', '--ok-t:', '--wait:', '--wait-t:', '--bad:', '--bad-t:', '--ring:', '--glow:', '--glass-blur:']) {
    assert.ok(defaults.includes(token), `${token} has a default for the standard look`);
  }
  assert.match(defaults, /\n\.dark\s*\{/, 'and dark defaults');
});

test('the glass look sets the typeface on the root, with a system fallback', () => {
  assert.match(glassBlock(), /html\[data-skin="glass"\]\s*\{[^}]*font-family:\s*'Albert Sans',\s*system-ui/);
});

// ── useSkin(): the look, read by an island after it mounts ─────────────
//
// An island that draws a look must not read data-skin on its first render:
// the prerendered document is skin-agnostic, so a first render that
// differed would be a hydration mismatch (a console error, which fails
// proposal checks). The hook answers 'standard' until mounted, then the
// live value from window.Skin.

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('useSkin reads standard on the first render and currentSkin reads window.Skin', () => {
  const mod = loadTsx('frontend/src/lib/skin.ts');
  assert.equal(mod.currentSkin(), 'standard', 'no window.Skin in the test: the standard look');
  const html = renderToHtml(createElement(() => createElement('i', null, mod.useSkin())));
  assert.equal(html, '<i>standard</i>');
  globalThis.window = { Skin: { get: () => 'glass', onChange() {} } };
  try {
    assert.equal(mod.currentSkin(), 'glass');
    assert.equal(renderToHtml(createElement(() => createElement('i', null, mod.useSkin()))), '<i>standard</i>',
      'the first render stays standard even when the device has a look on');
  } finally {
    delete globalThis.window;
  }
});

test('useSkin subscribes through window.Skin.onChange after mount', () => {
  const src = read('frontend', 'src', 'lib', 'skin.ts');
  assert.match(src, /useEffect\(/);
  assert.match(src, /window\.Skin\?\.onChange\?\.\(/);
  assert.match(src, /useState<Skin>\('standard'\)/);
});
