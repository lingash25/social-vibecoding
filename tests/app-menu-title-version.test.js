// The Homeroom menu says what it is, what is running, and which links leave
// (#5927, items 4, 5 and 9).
//
//  - a title, "Feedback & info", over the app's name, which was the whole
//    label before and named the subject rather than the panel;
//  - the running version at the foot, in About's own words, for whoever is
//    about to report a bug: the app's on an app, Homeroom's on Homeroom, and
//    "deploying…" while a new build of an app goes out;
//  - a link out of Homeroom ends in the external-link glyph, not a chevron.
//
// Rendered through the real sheet on the same store instances it reads.
//
// Run with: node --test tests/app-menu-title-version.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
const initialImprove = { ...ui.improveStore.get() };
const initialContext = { ...ui.appContextStore.get() };

function renderSheet(improve, context = { open: true }) {
  ui.improveStore.set({ ...initialImprove, ...improve });
  ui.appContextStore.set({ ...initialContext, ...context });
  try {
    return renderToHtml(createElement(ui.AppsSwitcherSheet));
  } finally {
    ui.improveStore.set(initialImprove);
    ui.appContextStore.set(initialContext);
  }
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
const textOf = (html, id) => {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  return m ? m[1] : null;
};

test('the menu has a title that says what it is, with the app name under it', () => {
  const html = renderSheet({ target: 'app', slug: 'bread-bot', name: 'Bread Bot' });
  assert.equal(message('agent:appContext.title'), 'Feedback & info');
  assert.match(html, new RegExp(`id="apps-switcher-title"[^>]*>${escape('Feedback & info')}<`));
  const title = html.indexOf('id="apps-switcher-title"');
  const name = html.indexOf('>Bread Bot<');
  assert.ok(title > 0 && name > title, 'the app name follows the title, as its secondary line');
});

test('the closed menu (the prerender) carries no version line', () => {
  const html = renderSheet({ target: 'app', slug: 'bread-bot', version: 'a1b2c3d' }, { open: false });
  assert.doesNotMatch(html, /app-menu-version/);
});

test('the open menu names the running version, the app\'s or Homeroom\'s', () => {
  const app = renderSheet({ target: 'app', slug: 'bread-bot', version: 'a1b2c3d' });
  assert.equal(textOf(app, 'app-menu-version'),
    message('agent:appContext.about.version.app', { version: 'a1b2c3d' }));

  const deploying = renderSheet({ target: 'app', slug: 'bread-bot', version: 'a1b2c3d', deploying: true });
  assert.equal(textOf(deploying, 'app-menu-version'),
    message('agent:appContext.about.version.appDeploying', { version: 'a1b2c3d' }));

  const platform = renderSheet({ target: 'platform', slug: 'homeroom', version: 'f00ba47' });
  assert.equal(textOf(platform, 'app-menu-version'),
    message('agent:appContext.about.version.platform', { version: 'f00ba47' }));

  const unknown = renderSheet({ target: 'app', slug: 'bread-bot', version: null });
  assert.doesNotMatch(unknown, /app-menu-version/, 'no version known, no line');
});

test('rows inside Homeroom keep the chevron; links out carry the external mark', () => {
  const html = renderSheet({ target: 'app', slug: 'bread-bot', name: 'Bread Bot' });
  const workshop = html.slice(html.indexOf('id="app-menu-row-workshop"'), html.indexOf('</a>', html.indexOf('id="app-menu-row-workshop"')));
  assert.doesNotMatch(workshop, /data-external-mark/, 'Go to community stays inside Homeroom');

  const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const privacy = SHEET.slice(SHEET.indexOf('id="app-menu-privacy"'), SHEET.indexOf('</a>', SHEET.indexOf('id="app-menu-privacy"')));
  assert.match(privacy, /<ExternalMark /, 'Privacy opens Homeroom\'s notice in a new tab');
  assert.match(SHEET, /external=\{homeroomOffer\.via === 'browser'\}/,
    'Add Homeroom is marked when it opens the system browser');
  const ABOUT = read('frontend/src/features/app-context/about-pane.tsx');
  const code = ABOUT.slice(ABOUT.indexOf('id="improve-row-github"'), ABOUT.indexOf('</a>', ABOUT.indexOf('id="improve-row-github"')));
  assert.match(code, /<ExternalMark \/>/, 'the About pane\'s Code row leaves for the repository');
  assert.ok(message('agent:appContext.opensOutside'), 'the mark has words for a screen reader');
});

test('Homeroom\'s line names the build this document loaded, not the newer one on the server', (t) => {
  const previousWindow = global.window;
  t.after(() => { global.window = previousWindow; });
  // The server has deployed f00ba47 (the about read, the published row); this
  // tab is still running the shell it loaded, a1d5a1e.
  global.window = { ...(previousWindow || {}), App: { loadedPlatformSha: 'a1d5a1e0000000000000000000000000000000ff' } };
  const loaded = renderSheet({ target: 'platform', slug: 'homeroom', version: 'f00ba47' });
  assert.equal(textOf(loaded, 'app-menu-version'),
    message('agent:appContext.about.version.platform', { version: 'a1d5a1e' }));

  // Nothing recorded at boot: the server's figure is the fallback.
  global.window = { ...(previousWindow || {}), App: { loadedPlatformSha: null } };
  const fallback = renderSheet({ target: 'platform', slug: 'homeroom', version: 'f00ba47' });
  assert.equal(textOf(fallback, 'app-menu-version'),
    message('agent:appContext.about.version.platform', { version: 'f00ba47' }));

  // An app's line is the app's own version, whatever Homeroom loaded.
  global.window = { ...(previousWindow || {}), App: { loadedPlatformSha: 'a1d5a1e0000000000000000000000000000000ff' } };
  const app = renderSheet({ target: 'app', slug: 'bread-bot', version: 'b0b0b0b' });
  assert.equal(textOf(app, 'app-menu-version'),
    message('agent:appContext.about.version.app', { version: 'b0b0b0b' }));
});
