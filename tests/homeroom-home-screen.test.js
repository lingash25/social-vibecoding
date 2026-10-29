'use strict';

// "Add Homeroom to your home screen" in the mark menu (Evan, 20 Oct 2026): a
// plain row on a phone where Homeroom is not on the home screen yet. In the
// browser it shows the install banner's steps; in an app saved to the home
// screen, which has no Share button, it opens Homeroom in the browser at an
// address whose page puts the same steps up. Pinned here: who is offered it,
// the arrival address, the row and the sheet it opens, and how the shell
// knows an app's icon opened the window.
//
// Run with: node --test tests/homeroom-home-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const APP = read('public/js/app.js');
const en = JSON.parse(read('frontend/locales/en/agent.json'));

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/** A phone (or not) as the module samples it, then `fn` run inside it. */
function withHost({ ua = IPHONE, standalone = false, native = false, fromAppIcon = false, search = '', hash = '' }, fn) {
  const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const replaced = [];
  const nav = { userAgent: ua, maxTouchPoints: ua === IPHONE ? 5 : 0, standalone };
  const location = { pathname: '/', search, hash };
  globalThis.window = {
    matchMedia: (q) => ({ matches: standalone && /display-mode: standalone/.test(q) }),
    navigator: nav,
    usernode: native ? { isNative: true } : undefined,
    App: { launchedFromAppIcon: fromAppIcon },
    location,
    history: {
      state: { kept: true },
      replaceState: (state, _title, url) => { replaced.push({ state, url }); },
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try {
    return fn(replaced);
  } finally {
    globalThis.window = saved.window;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
    else delete globalThis.navigator;
  }
}

const load = () => loadTsx('frontend/src/features/mobile-install/homeroom-home-screen.ts');

test('offered on a phone where Homeroom is not on the home screen yet', () => {
  const m = load();
  withHost({}, () => assert.deepEqual(m.homeroomHomeScreen(), { os: 'ios', via: 'steps' }, 'Safari: the steps'));
  withHost({ standalone: true, fromAppIcon: true }, () => {
    assert.deepEqual(m.homeroomHomeScreen(), { os: 'ios', via: 'browser' }, 'an app\'s own icon: Homeroom in the browser');
  });
  withHost({ standalone: true }, () => assert.equal(m.homeroomHomeScreen(), null, 'Homeroom\'s own icon: it is there'));
  withHost({ native: true }, () => assert.equal(m.homeroomHomeScreen(), null, 'the native app'));
  withHost({ ua: MAC }, () => assert.equal(m.homeroomHomeScreen(), null, 'a laptop has no home screen'));
});

test('the arrival address: the steps once, the parameter off the address, the rest byte for byte', () => {
  let m = load();
  const opened = [];
  withHost({ standalone: true, fromAppIcon: true }, () => {
    globalThis.window.open = (...args) => opened.push(args);
    m.openHomeroomInBrowser();
  });
  assert.deepEqual(opened, [['/?home-screen=homeroom', '_blank', 'noopener']]);
  withHost({ search: '?token=a%2Bb&home-screen=homeroom', hash: '#x' }, (replaced) => {
    assert.equal(m.takeArrival(), true);
    assert.equal(m.takeArrival(), true, 'asked again, the same answer');
    assert.deepEqual(replaced, [{ state: { kept: true }, url: '/?token=a%2Bb#x' }], 'rewritten once, the state kept');
  });
  m = load();
  withHost({ search: '?token=abc' }, (replaced) => {
    assert.equal(m.takeArrival(), false);
    assert.deepEqual(replaced, [], 'an ordinary address is left alone');
  });
});

test('the row: after About, a plain row, steps in the browser and Homeroom from an app\'s window', () => {
  const row = SHEET.slice(SHEET.indexOf('id="app-menu-row-add-homeroom"'));
  assert.ok(SHEET.indexOf('id="app-menu-row-about"') < SHEET.indexOf('id="app-menu-row-add-homeroom"'));
  assert.match(SHEET, /\{homeroomOffer \? \(\s+<button\s+id="app-menu-row-add-homeroom"\s+type="button"\s+className=\{`\$\{ROW\} w-full text-left`\}/);
  assert.match(row, /if \(homeroomOffer\.via === 'browser'\) \{\s+openHomeroomInBrowser\(\);\s+void AppContext\.dismissForNav\(\);/,
    'the window opens in the tap itself, then the menu closes');
  assert.match(row, /void AppContext\.close\(\)\.then\(\(\) => setHomeroomSteps\(os\)\);/, 'the steps once the menu is down');
  assert.match(row, /<RowBody icon=\{<PhonePlusIcon \/>\} label=\{t\('agent:appContext\.row\.addHomeroom'\)\} external=\{homeroomOffer\.via === 'browser'\} \/>/);
  // Opening the browser leaves Homeroom, so that row ends in the external-link mark, not a chevron (#5927).
  assert.equal(en['appContext.row.addHomeroom'].text, 'Add Homeroom to your home screen');
  assert.equal(en['install.steps.title'].text, 'Add Homeroom to your home screen', 'the sheet it opens says the same');
  // Read after mount only, and the sheet is the banner's own.
  assert.match(SHEET, /const homeroomOffer = useMemo\(\(\) => \(mounted \? homeroomHomeScreen\(\) : null\), \[mounted, open\]\);/);
  assert.match(SHEET, /\{homeroomSteps \? <InstallStepsSheet os=\{homeroomSteps\} onClose=\{\(\) => setHomeroomSteps\(null\)\} \/> : null\}/);
  // On arrival, the steps come up after the boot settles, in the browser only.
  assert.match(SHEET, /if \(!takeArrival\(\)\) return undefined;[\s\S]{0,200}App\?\.bootSession\?\.\(\);[\s\S]{0,200}if \(live && offer\?\.via === 'steps'\) setHomeroomSteps\(offer\.os\);/);
});

test('the prerendered menu has no row: it is a fact about the phone, read after mount', () => {
  const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
  englishPlatformI18n();
  const html = renderToHtml(createElement(ui.AppsSwitcherSheet));
  assert.match(html, /id="app-menu-row-about"/);
  assert.doesNotMatch(html, /app-menu-row-add-homeroom|mobile-install-steps/);
});

test('the shell knows an app\'s own icon opened the window, from the address it opened at', () => {
  assert.match(APP, /App\._applySafeAreaShot\(\);\s+\/\/ Before anything moves the address: what opened this window\.\s+App\._noteLaunch\(\);/);
  const fn = APP.slice(APP.indexOf('_noteLaunch() {'), APP.indexOf('setChromeless(on) {'));
  assert.match(fn, /sessionStorage\.getItem\(KEY\) === '1'/, 'kept through a reload inside the window');
  assert.match(fn, /!App\._installedDisplay\(\)\s+\|\| !\/\^\\\/app\\\/\[a-z0-9\]\[a-z0-9-\]\{0,254\}\\\/full\\\/\?\$\/\.test\(location\.pathname\)/,
    'installed, and opened at an app\'s start_url');
  assert.equal(require('../src/services/app-install-manifest').buildManifest({ slug: 'x' }).start_url, '/app/x/full');
});
