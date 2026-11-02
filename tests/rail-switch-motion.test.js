'use strict';

// A press on the desktop rail is a TAB SWITCH, and it swaps the page in place
// (#2797). And the platform's own row opens on a plain Workshop panel, with no
// ✕ to step out of an app it is not (#2799).
//
// #2797, measured frame by frame on the built shell (1280x900): Discover,
// Home, Workshop and Me each ran the kit's fade-through — a View Transition
// over the whole document, for whose length the header and the rail are
// pinned SNAPSHOT images over a substitute ground. Messages ran none: its
// hashchange re-entry called navigateToMessages a second time 14ms later,
// whose 'none' skipped the pending transition. Messages was also the one tab
// reported as never popping. After this change every rail press resolves to
// 'none', and every captured frame of the header, the rail and the wallpaper
// star behind the bell matched its settled state from the first frame on.
//
// Run with: node --test tests/rail-switch-motion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { message } = require('./lib/platform-i18n');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness({ wide = true, railHidden = false } = {}) {
  const nodes = new Map();
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'home-screen' ? [] : ['hidden']);
    if (id === 'platform-tabs' && !railHidden) classes.delete('hidden');
    const attrs = new Map();
    const el = {
      id,
      classList: {
        add: (v) => classes.add(v),
        remove: (v) => classes.delete(v),
        contains: (v) => classes.has(v),
        toggle(v, on) { if (on) classes.add(v); else classes.delete(v); },
      },
      setAttribute: (n, v) => attrs.set(n, v),
      getAttribute: (n) => attrs.get(n),
      addEventListener() {},
    };
    nodes.set(id, el);
    return el;
  }
  const AppView = { appData: null, launchRecordFor: () => null };
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'), URL, URLSearchParams, console,
    history: { pushState() {}, replaceState() {} },
    document: { title: '', getElementById: element, querySelector: () => null, addEventListener() {} },
    addEventListener() {},
    localStorage: { getItem: () => null },
    matchMedia: (q) => ({ matches: q === '(min-width: 768px)' ? wide : false }),
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    AppView,
  });
  context.window = context;
  vm.runInContext(read('public/js/app.js'), context);
  return { App: context.App, AppView, element, context };
}

// ── #2797: a rail press swaps in place ───────────────────────────────────

test('a push into any of the rail\'s places is a cut on the desktop layout', () => {
  const { App, element } = harness();
  // #6019: AI is the Messages screen's bot chat, and Discover a page of
  // Home's that pushes in like any other page.
  for (const id of ['home-screen', 'messages-screen', 'workshop-screen', 'profile-screen']) {
    const screen = element(id);
    assert.equal(App._entryTransition('push', screen), 'none', `${id} is a tab switch`);
    assert.equal(screen.getAttribute('data-entered'), 'none',
      'the stamp is the RESOLVED type, so a check reads what actually ran');
  }
});

test('Home from the rail is a cut too, but backing out of an app still zooms', () => {
  const { App, element } = harness();
  const appView = element('app-view');
  // No app on screen: the kit's zoom-out has no card to shrink and would fall
  // back to a full-page transition, which is the thing a tab press must not run.
  assert.equal(App._entryTransition('zoom-out', appView), 'none');
  // An app's view on screen (its Workshop, rail up): shrinking it into its
  // tile is the way out of an app, not a tab switch.
  appView.classList.remove('hidden');
  assert.equal(App._entryTransition('zoom-out', appView), 'zoom-out');
});

test('everything that is not a rail switch keeps its motion', () => {
  const { App, element } = harness();
  // A drill-in within a tab goes somewhere; it keeps its push.
  for (const id of ['settings-screen', 'leaderboard-screen', 'agent-session-screen', 'admin-screen']) {
    assert.equal(App._entryTransition('push', element(id)), 'push', `${id} is a drill-in`);
  }
  assert.equal(App._entryTransition('zoom-in', element('app-view')), 'zoom-in', 'opening an app still zooms');
});

test('the phone slides nowhere (#2896, #2775), and a desktop route with no rail keeps its push', () => {
  // Below the breakpoint every push and pop is a cut — tab roots and drill-ins
  // alike — and the stamp says so.
  const phone = harness({ wide: false });
  for (const id of ['browse-screen', 'settings-screen', 'leaderboard-screen']) {
    const screen = phone.element(id);
    assert.equal(phone.App._entryTransition('push', screen), 'none', `${id} swaps in place`);
    assert.equal(screen.getAttribute('data-entered'), 'none');
  }
  assert.equal(phone.App._entryTransition('pop', phone.element('home-screen')), 'none');
  // Opening an app from its tile is not a page slide; it still zooms.
  assert.equal(phone.App._entryTransition('zoom-in', phone.element('app-view')), 'zoom-in');
  // Inside a running app the rail is down; leaving it is not a rail press.
  const inApp = harness({ railHidden: true });
  assert.equal(inApp.App._entryTransition('push', inApp.element('browse-screen')), 'push');
});

test('the rail roots agree with the tab bar\'s own map', () => {
  // TAB_FOR_SCREEN maps every screen to the tab that lights for it; the roots
  // are the screens a tab NAVIGATES to, which is the five whose tab maps to
  // themselves being the first screen listed for it.
  const { App } = harness();
  const nav = read('frontend/src/features/nav/nav-store.js');
  const body = nav.match(/TAB_FOR_SCREEN = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  const firstForTab = new Map();
  for (const m of body.matchAll(/'([a-z-]+)': '([a-z]+)'/g)) {
    if (!firstForTab.has(m[2])) firstForTab.set(m[2], m[1]);
  }
  // The rail's own tabs too (29 Oct 2026): Discover is one there, and this
  // list is only read at the rail's width.
  const railBody = nav.match(/RAIL_TAB_FOR_SCREEN = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
  for (const m of railBody.matchAll(/'([a-z-]+)': '([a-z]+)'/g)) {
    if (!firstForTab.has(m[2])) firstForTab.set(m[2], m[1]);
  }
  assert.deepEqual([...App._RAIL_ROOTS].sort(), [...firstForTab.values()].sort());
});

// ── #2799: the platform's own Workshop has no ✕ ──────────────────────────

test('the platform\'s own row shows no ✕ on its Workshop', () => {
  const { App, AppView } = harness();
  App.currentApp = 'homeroom';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  // Before its record loads, the launcher's cached row answers — navigateToApp
  // reveals the view (and publishes this slot) before AppView.open resolves.
  AppView.launchRecordFor = (slug) => (slug === 'homeroom' ? { slug, self_hosted: true } : null);
  assert.deepEqual([...App._backSlotFor('app-view')], ['none']);
  // …and once it has, the loaded record does.
  AppView.launchRecordFor = () => null;
  AppView.appData = { slug: 'homeroom', self_hosted: true };
  assert.deepEqual([...App._backSlotFor('app-view')], ['none']);
});

test('no app\'s Workshop has a ✕ — only the running app does — and a channel keeps its chevron to its hub', () => {
  // #2740 review: an app's Workshop has NO back control. #2799 made that true
  // for the platform's own row and left every other app's Workshop wearing a
  // "Close app" ✕ that OPENED the app it claimed to close.
  // A phone, where the running app below has its ✕; on a desktop its rail
  // stays beside it and the corner is the sidebar toggle (checked last).
  const { App, AppView } = harness({ wide: false });
  App.currentApp = 'todo';
  App.currentTab = 'dev';
  App.currentSubTab = 'forum';
  AppView.appData = { slug: 'todo', self_hosted: false };
  assert.deepEqual([...App._backSlotFor('app-view')], ['none'], 'an app\'s Workshop, like the platform\'s');
  // A card opened in it is empty here too: the header derives its ‹ back to
  // the Workshop from the route (features/header/platform-header.tsx).
  App.currentSubTab = 'topic';
  assert.deepEqual([...App._backSlotFor('app-view')], ['none']);
  // The RUNNING app keeps its ✕, and it names where the ✕ goes: Home, with
  // nowhere else to return to…
  App.currentTab = 'app';
  App.currentSubTab = null;
  assert.deepEqual([...App._backSlotFor('app-view')], ['close', '/']);
  // …or the page it was opened from (App.closeApp; tests/app-close-origin.test.js).
  App._appReturn = { slug: 'todo', url: '/#messages/5', depth: null, pushes: null };
  assert.deepEqual([...App._backSlotFor('app-view')], ['close', '/#messages/5']);
  // On a desktop the running app keeps the rail, and the corner is empty
  // for the sidebar toggle (App._railBesideApp, tests/nav-rail-pinned.test.js).
  const desktop = harness();
  desktop.App.currentApp = 'todo';
  desktop.App.currentTab = 'app';
  desktop.AppView.appData = { slug: 'todo', self_hosted: false };
  assert.deepEqual([...desktop.App._backSlotFor('app-view')], ['none']);
  // A project's channel hangs off its community's hub now, not Messages.
  App.currentApp = 'homeroom';
  App.currentTab = 'dev';
  App.currentSubTab = 'chat';
  assert.deepEqual([...App._backSlotFor('app-view')], ['arrow', '#app/homeroom/workshop']);
  // A change is still an agent conversation, a thread of Messages (#2770).
  App.currentSubTab = 'sessions';
  assert.deepEqual([...App._backSlotFor('app-view')], ['arrow', '#messages']);
});

// ── #2880, #2881: the Workshop tab into and out of an app's Workshop ─────
//
// Since #2776 the Workshop tab returns to the app Workshop you left, which is
// #app-view, not #workshop-screen — so the press ran navigateToApp's
// 'zoom-in', growing the app's tile out of Home (#2881) and, with no tile on
// screen (every other tab, and the platform's own row everywhere), falling
// back to the kit's full-page 'push': the fade-through #2797 took off the
// five roots, header and rail swapped for snapshots (#2880). Home pressed
// from an app's Workshop shrank the page into its tile. Measured frame by
// frame on the built shell (1280x900 and 390x844): after this change the
// press cuts on the desktop rail — and, since #2775, on the phone too, like
// every other tab there — and no frame shows an empty #app-view, the previous visit's board,
// or a 72px sliver of skeleton.

test('a tab press into or out of an app view is a tab switch: a cut on the rail and on the phone', () => {
  const wide = harness();
  const appView = wide.element('app-view');
  assert.equal(wide.App._entryTransition('zoom-in', appView, true), 'none', 'Workshop resumed from the rail');
  appView.classList.remove('hidden');
  assert.equal(wide.App._entryTransition('zoom-out', appView, true), 'none', 'Home pressed on an app\'s Workshop');
  assert.equal(appView.getAttribute('data-entered'), 'none', 'the stamp is what ran');

  const phone = harness({ wide: false });
  const phoneView = phone.element('app-view');
  assert.equal(phone.App._entryTransition('zoom-in', phoneView, true), 'none',
    'the phone\'s other tabs cut (#2775); this one does too, rather than growing a tile');
  phoneView.classList.remove('hidden');
  assert.equal(phone.App._entryTransition('zoom-out', phoneView, true), 'none',
    'and Home cuts, as it does from every other tab');
});

test('everything that is not a tab press still zooms: a tile, a notification, Back out of an app', () => {
  const { App, element } = harness();
  const appView = element('app-view');
  assert.equal(App._entryTransition('zoom-in', appView), 'zoom-in', 'a tile on Home still grows into the app');
  appView.classList.remove('hidden');
  assert.equal(App._entryTransition('zoom-out', appView), 'zoom-out', 'and leaving by the ✕ shrinks back');
  assert.equal(App._entryTransition('zoom-out', appView, false), 'zoom-out');
});

test('the Workshop tab\'s resume marks its navigation a tab press, for exactly its synchronous length', () => {
  const { App } = harness();
  const seen = [];
  App._readWorkshopView = () => ({ slug: 'notes-ab12', path: '/app/notes-ab12/workshop' });
  App._routeSearch = () => '';
  App.restoreFromHash = () => { seen.push(App._tabPress); };
  assert.equal(App.resumeWorkshopView(), true);
  assert.deepEqual(seen, [true], 'the router ran inside the press');
  assert.equal(App._tabPress, false, 'and nothing after it inherits the flag');
  // Even when routing throws, the flag does not outlive the press.
  App.restoreFromHash = () => { throw new Error('boom'); };
  assert.throws(() => App.resumeWorkshopView(), /boom/);
  assert.equal(App._tabPress, false);
});

test('navigateHome is a tab press only when the Home tab says so — never from an Event', () => {
  const src = read('public/js/app.js');
  const body = src.slice(src.indexOf('  navigateHome(opts) {'), src.indexOf('\n  },', src.indexOf('  navigateHome(opts) {')));
  assert.match(body, /const viaTab = !!\(opts && opts\.viaTab === true\);/);
  assert.match(body, /type: App\._entryTransition\('zoom-out', av, viaTab && !\(leavingSlug && App\._stripShowsRunning\(leavingSlug\)\)\)/);
  const tabBar = read('frontend/src/features/nav/tab-bar.tsx');
  const home = tabBar.slice(tabBar.indexOf('function onHomeClick('), tabBar.indexOf('\n}\n', tabBar.indexOf('function onHomeClick(')));
  assert.match(home, /\.navigateHome\?\.\(\{ viaTab: true \}\)/, 'the Home tab is the caller that says so');
});

// 1 Nov 2026: iPhone Duo's strip keeps the tabs up over a running app, with
// the app among them, and every other tab pressed there carries the app into
// its tile (the stand-in card). Home's press cut: the card leaves the shrink
// to navigateHome's zoom-out, which the press turned off. There, and only
// there, Home keeps its zoom-out, into the strip's tile.
test('Home pressed on the Duo\'s strip out of a running app keeps its zoom into the app\'s tile', () => {
  const src = read('public/js/app.js');
  const body = src.slice(src.indexOf('  navigateHome(opts) {'), src.indexOf('\n  },', src.indexOf('  navigateHome(opts) {')));
  assert.match(body, /type: App\._entryTransition\('zoom-out', av, viaTab && !\(leavingSlug && App\._stripShowsRunning\(leavingSlug\)\)\)/);

  const { App, context } = harness({ wide: false });
  let rows = [];
  context.document.querySelectorAll = (sel) => {
    assert.equal(sel, '#platform-tabs .platform-side-app[aria-current="page"]', 'the lit row, the app on screen');
    return rows;
  };
  const row = (slug, drawn) => ({
    getAttribute: (name) => (name === 'data-side-app' ? slug : null),
    getClientRects: () => ({ length: drawn ? 1 : 0 }),
  });
  rows = [row('notes-ab12', true)];
  assert.equal(App._stripShowsRunning('notes-ab12'), true);
  assert.equal(App._stripShowsRunning('chess-cd34'), false, 'another app');
  rows = [row('notes-ab12', false)];
  assert.equal(App._stripShowsRunning('notes-ab12'), false, 'off the strip the row is never drawn');
  rows = [];
  assert.equal(App._stripShowsRunning('notes-ab12'), false, 'the app\'s Workshop: no running app in the strip');
  delete context.document.querySelectorAll;
  assert.equal(App._stripShowsRunning('notes-ab12'), false, 'unreadable answers no');
});

// 1 Nov 2026: a community pressed in the sidebar went through navigateToApp's
// zoom with nothing on screen to grow out of, and the kit fell back to its
// sliding page transition: the old page, sidebar and all, slid left over the
// new sidebar (recorded on iPhone Duo held sideways; a desktop window too).
test('a community pressed in the sidebar is a place switch: it cuts, like the tabs', () => {
  const rail = read('frontend/src/features/nav/rail-communities.tsx');
  assert.match(rail, /if \(onPage === slug\) pressLitTab\(screen, \{ stopAtCommunity: true \}\);\s+else pressPlace\(\(\) => goToCommunity\(slug\)\);/);
  const press = rail.slice(rail.indexOf('export function pressPlace('), rail.indexOf('\n}\n', rail.indexOf('export function pressPlace(')));
  assert.match(press, /if \(app\) app\._tabPress = true;\s+try \{\s+navigate\(\);\s+\} finally \{\s+if \(app\) app\._tabPress = false;\s+\}/,
    'the router\'s own mark, for exactly the press');
  // The mark only counts if the press reaches navigateToApp in the same task.
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  const go = scope.slice(scope.indexOf('export function goToCommunity('), scope.indexOf('\n}\n', scope.indexOf('export function goToCommunity(')));
  assert.doesNotMatch(go, /\bawait\b|setTimeout|requestAnimationFrame/);
  assert.match(go, /void app\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  // …and a press marked so is a cut on the rail's layout (the test above).
  const { App, element } = harness();
  App._tabPress = true;
  assert.equal(App._entryTransition('zoom-in', element('app-view'), App._tabPress === true), 'none');
});

test('a tab press into an app\'s Workshop reveals it when its record lands, not empty before', async () => {
  const src = read('public/js/app.js');
  const nav = src.slice(src.indexOf('  async navigateToApp('), src.indexOf('\n  navigateHome(opts) {'));
  // The press reads the flag before the first await, where the transition used to start.
  assert.ok(nav.indexOf('const viaTab = App._tabPress === true;') < nav.indexOf('await'),
    'read synchronously, inside resumeWorkshopView\'s window');
  assert.match(nav, /if \(!viaTab\) reveal\(\);/, 'every other entry reveals at once, as before');
  // The press holds the outgoing screen for the record, bounded, then reveals
  // in the same task switchTab mounts the Dev frame in.
  assert.match(nav, /if \(viaTab\) \{\s*await Promise\.race\(\[\s*load\.promise,\s*new Promise\(\(resolve\) => setTimeout\(resolve, App\._TAB_REVEAL_WAIT_MS\)\),\s*\]\);/);
  assert.match(nav, /if \(App\.currentApp !== slug \|\| generation !== App\._appNavigationGeneration\) return false;\s*reveal\(\);/,
    'a press overtaken by another navigation never shows');
  const { App } = harness();
  assert.ok(App._TAB_REVEAL_WAIT_MS > 0 && App._TAB_REVEAL_WAIT_MS <= 300, 'a press never seems ignored for long');
});

test('coming back to an app\'s Workshop from another screen retires the last visit\'s board first', () => {
  const src = read('public/js/app.js');
  const nav = src.slice(src.indexOf('  async navigateToApp('), src.indexOf('\n  navigateHome(opts) {'));
  assert.match(nav, /const staleDev = initialRoute\.tab === 'dev' && !App\._isScreenVisible\('app-view'\);/);
  // Outside the transition's callback: a View Transition runs that callback
  // frames later, after switchTab may have mounted this visit's board.
  assert.match(nav, /const reveal = \(\) => \{\s*if \(staleDev\) AppView\._teardownDevRoots\(\);\s*enter\(\);\s*\};/);
  const enter = nav.slice(nav.indexOf('const enter = () => PlatformUI.transition('), nav.indexOf('const reveal = () =>'));
  assert.doesNotMatch(enter, /_teardownDevRoots/, 'never from inside the deferred callback');
});

test('the Workshop\'s loading state fills its column, and hands off to the Workshop\'s own skeleton unseen', () => {
  const css = read('public/css/app.css');
  assert.match(css, /#dev-workshop \{ max-width: 760px; margin: 0 auto; width: 100%; \}/,
    'a flex item centred by auto margins shrinks to its content without it — the 72px sliver');
  const frame = read('frontend/src/features/dev-board/board-frame.tsx');
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const frameRows = Number(/skeletonListHtml\((\d+)\)/.exec(frame.slice(frame.indexOf('const DEV_BODY_WORKSHOP_INITIAL')))[1]);
  const ownRows = Number(/<CardSkeleton n=\{(\d+)\} label=\{t\('project:page\.loading'\)\}/.exec(workshop)[1]);
  assert.equal(frameRows, ownRows, 'the frame\'s placeholder and the Workshop\'s loading state draw the same rows');
  assert.equal(message('project:page.loading'), 'Loading the workshop');
});
