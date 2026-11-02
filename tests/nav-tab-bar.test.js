'use strict';

// #platform-tabs — the shell's five sections as a permanent bar.
//
// Three things are checked here, and each one is a way the bar can be wrong
// while every structural test in the suite still passes:
//
//   1. THE MAP IS COMPLETE. Five tabs cover ten screen roots, so a root added
//      later falls through to "no tab" and the bar simply goes blank on it —
//      no throw, no failing selector, just a bar that stops answering where
//      you are. This asserts the map against App.SCREEN_IDS itself.
//   2. THE RENDER MATCHES THE PRERENDER. The bar is an island in a document
//      React hydrates, so a first client render that disagrees with the
//      prerendered markup console.errors, and a console error on any route
//      fails proposal checks. The initial store state has to produce exactly
//      the shipped markup: no `aria-current`, a hidden empty badge.
//   3. ONE PLACE DECIDES WHETHER IT IS THERE. Three unrelated code paths hide
//      it (a running app, chromeless, the signed-out shell) and they all go
//      through App._syncPlatformTabs. This runs the real function.
//
// The CSS reservation is checked too, because the bar is out of flow: nothing
// holds its band open automatically, and the rules that do are in a different
// file from the one that sets the bar's height.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const appSource = read('public/js/app.js');
const css = read('public/css/app.css');

// ── 1. The map ────────────────────────────────────────────────────────

test('every screen root but the app view belongs to a tab', () => {
  const { TAB_FOR_SCREEN } = loadTsx('frontend/src/features/nav/nav-store.js');
  const match = appSource.match(/SCREEN_IDS:\s*(\[[^\]]*\])/);
  assert.ok(match, 'App.SCREEN_IDS is an array literal in app.js');
  const roots = JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));

  const unmapped = roots.filter((id) => id !== 'app-view' && !TAB_FOR_SCREEN[id]);
  assert.deepEqual(unmapped, [],
    'screen roots with no tab — add them to TAB_FOR_SCREEN in features/nav/nav-store.js, '
    + 'or the bar goes blank on those routes: ' + unmapped.join(', '));

  // The other direction, so a root that is retired cannot leave a dead entry
  // pointing at nothing.
  const stale = Object.keys(TAB_FOR_SCREEN).filter((id) => !roots.includes(id));
  assert.deepEqual(stale, [], 'TAB_FOR_SCREEN names roots App.SCREEN_IDS does not');

  // #app-view is absent ON PURPOSE — the bar is hidden inside a running app —
  // and the assertion above would also pass if someone added it, so say it.
  assert.equal(TAB_FOR_SCREEN['app-view'], undefined,
    'the app view is not one of the platform\'s sections; the bar is hidden there');
});

test('the tabs are the ones the bar renders', () => {
  const { TAB_FOR_SCREEN, RAIL_TAB_FOR_SCREEN, tabForScreen } = loadTsx('frontend/src/features/nav/nav-store.js');
  const sections = [...new Set(Object.values(TAB_FOR_SCREEN))].sort();
  // #6019: each of the five is a screen's own tab. AI is its own page, and
  // stays lit over Main, the Messages screen's chat with the bot (the nav
  // store's `bot`). The desktop rail adds Discover's (29 Oct 2026).
  assert.deepEqual(sections, ['ai', 'home', 'me', 'messages', 'workshop']);
  assert.deepEqual({ ...RAIL_TAB_FOR_SCREEN }, { 'browse-screen': 'discover' });
  assert.equal(tabForScreen('browse-screen'), 'home', 'a phone lights Home on Discover');
  assert.equal(tabForScreen('browse-screen', true), 'discover', 'the rail lights its Discover tab');
  assert.equal(tabForScreen('home-screen', true), 'home', 'and answers as the phone everywhere else');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  const keys = [...bar.matchAll(/key: '([a-z]+)' as const/g)].map((m) => m[1]);
  // The rail's order is the markup's; app.css orders the phone's five.
  assert.deepEqual(keys, ['home', 'discover', 'messages', 'ai', 'workshop', 'me']);
  assert.match(bar, /const tab = routedTab === 'messages' && bot \? 'ai' : routedTab;/);
  assert.match(read('frontend/src/features/messages/store.ts'),
    /bot: !!state\.route\.open && !!botId && state\.route\.conversationId === botId,/);
});

// ── 2. The render ─────────────────────────────────────────────────────

test('the initial render is the markup the prerender ships', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});

  for (const key of ['home', 'discover', 'messages', 'ai', 'workshop', 'me']) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"`), `#platform-tab-${key} renders`);
  }
  assert.match(html, /id="platform-tabs"/);

  // NO tab is lit before the router has said anything. The store's INITIAL is
  // `tab: null` precisely so this render and the prerendered document agree.
  assert.doesNotMatch(html, /aria-current/,
    'a lit tab in the first render is a hydration mismatch against the prerender');

  // The badge is STRUCTURAL — always in the markup, hidden until it has a
  // count — so a declared check can select it on a cold document.
  assert.match(html, /id="platform-tabs-badge"/);
  assert.match(html, /class="platform-tab-badge hidden"/,
    'the badge ships hidden, with `hidden` constant in the class string');
  assert.doesNotMatch(html, /platform-tab-badge hidden"[^>]*>\s*\d/,
    'the badge ships empty');
});

test('Home is the one tab addressed as a path, so a modified click opens a tab', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html, /id="platform-tab-home"[^>]*href="\/"/);
  for (const [key, href] of [
    ['discover', '#apps'], ['messages', '#messages'], ['ai', '#homeroom-bot'],
    ['workshop', '#communities'], ['me', '#profile'],
  ]) {
    assert.match(html, new RegExp(`id="platform-tab-${key}"[^>]*href="${href.replace('#', '\\#')}"`));
  }
});

// ── 3. One place decides ──────────────────────────────────────────────

// A desktop window unless `phone`: a running app keeps the rail beside it
// there (App._railBesideApp, tests/nav-rail-pinned.test.js), and a phone's
// app takes the whole screen.
function harness({ phone = false } = {}) {
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
    },
    addEventListener() {},
    matchMedia: () => ({ matches: !phone, addEventListener() {} }),
    localStorage: { getItem: () => null },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  const lit = [];
  context.UsernodeReact = { nav: { setScreen: (id) => lit.push(id) } };
  return { App, context, lit, shown: () => App.Visibility.read('platform-tabs') };
}

test('loading app.js with no session hides the bar before React renders', () => {
  // `_applyBootScreen` runs at MODULE SCOPE — app.js is a classic script and
  // the React entry is a deferred module, so this is the last thing that
  // happens before hydration. The harness's document has no session, so the
  // resolver answers the landing screen and the bar is published away with
  // it. Nothing has to reset this for the tests below: they publish their own
  // answer by calling _syncPlatformTabs.
  const { shown } = harness();
  assert.equal(shown(), false);
});

test('the bar is up on a platform screen and down inside an app on a phone', () => {
  const { App, shown } = harness({ phone: true });
  App._syncPlatformTabs('messages-screen');
  assert.equal(shown(), true);
  App._syncPlatformTabs('app-view');
  assert.equal(shown(), false);
  // On a desktop the rail stays beside the running app.
  const desktop = harness();
  desktop.App._syncPlatformTabs('app-view');
  assert.equal(desktop.shown(), true);
});

test('chromeless takes the bar with the header', () => {
  const { App, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  App.setChromeless(true);
  assert.equal(shown(), false, 'setChromeless must re-decide, not only hide the header');
  App.setChromeless(false);
  assert.equal(shown(), true);
});

test('the signed-out shell has nothing to tab to', () => {
  const { App, context, shown } = harness();
  App._syncPlatformTabs('home-screen');
  assert.equal(shown(), true);
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(shown(), false);
  context.AuthScreens._current = null;
  App._syncPlatformTabs();
  assert.equal(shown(), true);
});

test('a plain "/" boot never swaps screens, and the bar is still up', () => {
  // `_revealedScreen` is null until the first swap, and restoreFromHash's
  // no-hash branch is already-on-home: it calls Home.load() without one. A
  // null read as "no section" would hide the bar on the most-visited route.
  const { App, shown, lit } = harness();
  assert.equal(App._revealedScreen, null);
  App._syncPlatformTabs();
  assert.equal(shown(), true);
  assert.equal(lit.at(-1), 'home-screen');
});

test('the section is published even when the bar is down', () => {
  // Otherwise the store keeps the last one and the bar returns lighting a tab
  // the viewer has since left.
  //
  // THE RAW SCREEN, not the tab, and not null for the app view: the bar has
  // no tab for #app-view and goes away there, but the HEADER reads the same
  // publication to know it is inside an app (its left slot becomes a close
  // button, the app's tile appears beside its name). features/nav/mount.ts
  // derives the tab from it; only the signed-out screens publish nothing.
  const { App, context, lit } = harness({ phone: true });
  App._syncPlatformTabs('workshop-screen');
  assert.equal(lit.at(-1), 'workshop-screen');
  App._syncPlatformTabs('app-view');
  assert.equal(lit.at(-1), 'app-view');
  assert.equal(App.Visibility.read('platform-tabs'), false, 'and the bar is still down');
  context.AuthScreens = { _current: 'landing' };
  App._syncPlatformTabs();
  assert.equal(lit.at(-1), null, 'the signed-out screens are the one nothing');
});

test('a cold boot into an app or the signed-out shell never paints the bar', () => {
  for (const [hash, pathname, signedIn] of [
    ['#app/some-app', '/', true],
    ['#login', '/', false],
    ['', '/app/some-app', true],
  ]) {
    // A phone: an app covers the bar there. The desktop is below.
    const { App, shown } = harness({ phone: true });
    // The real resolver decides; only the DOM half of the reveal is stubbed,
    // because this harness has no elements for it to toggle.
    const target = App._bootScreenFor(hash, pathname, signedIn);
    assert.ok(target === 'app-view' || target.startsWith('auth-'),
      `${pathname}${hash} resolves to ${target}`);
    App._revealBootScreen = () => {};
    App._bootScreenFor = () => target;
    App._applyBootScreen();
    assert.equal(shown(), false, `${pathname}${hash} painted the bar before the router ran`);
  }

  // ...and a cold boot onto a platform screen leaves the store ALONE, so the
  // bar paints with the document rather than a frame later. Nothing published
  // means "whatever the markup shipped", which is visible.
  const { App, context, shown } = harness();
  delete context.__usernodeVisibility.visible['platform-tabs'];
  App._revealBootScreen = () => {};
  App._bootScreenFor = () => 'workshop-screen';
  App._applyBootScreen();
  assert.equal(shown(), undefined);

  // ...and so does a cold boot into an app on a DESKTOP, whose rail stays
  // beside it: hiding it would only have the router bring it back, sliding
  // the app a rail's width right. The signed-out shell still hides it.
  for (const [target, left] of [['app-view', true], ['auth-landing', false]]) {
    const desktop = harness();
    delete desktop.context.__usernodeVisibility.visible['platform-tabs'];
    desktop.App._revealBootScreen = () => {};
    desktop.App._bootScreenFor = () => target;
    desktop.App._applyBootScreen();
    assert.equal(desktop.shown(), left ? undefined : false, target);
  }
});

// ── The band the bar covers ───────────────────────────────────────────

test('the bar spends the home-indicator inset exactly once', () => {
  // The bar is fused to the bottom edge, so its own lower padding covers the
  // strip and `--platform-tabs-h` counts it. Every consumer then takes
  // `max()` of the two rather than adding them — adding is the #4149 bug
  // (`--ws-bar`'s comment above documents the same trap from the other side).
  // #2766: what the bar spends is `--platform-tabs-inset` — the inset itself
  // everywhere but iOS — and the band tokens count that same figure, so the
  // screens clear exactly the bar that is drawn.
  assert.match(css, /\.platform-tabs\s*\{[^}]*padding-bottom:\s*var\(--platform-tabs-inset\)/,
    '.platform-tabs spends the inset itself');
  assert.match(css, /--platform-tabs-inset: var\(--platform-safe-bottom\);/,
    'by default the bar spends the whole inset');
  assert.match(css, /--platform-tabs-h:\s*calc\(56px \+ var\(--platform-tabs-inset, 0px\)\)/,
    'the token is the bar\'s FULL outer height, inset included');

  for (const rule of ['.platform-safe-scroll', '.platform-safe-bar', '.home-body-fill']) {
    const block = css.slice(css.indexOf(`${rule} {`));
    const decl = block.slice(0, block.indexOf('}'));
    assert.match(decl, /max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)/,
      `${rule} must clear the bar and the inset with max(), never both stacked`);
  }
});

test('the bar sits lower on iOS, and only there (#2766)', () => {
  const rule = /html\.un-ios \{\s*--platform-tabs-inset: ([^;]+);\s*\}/.exec(css);
  assert.ok(rule, 'iOS gets its own, smaller share of the home-indicator strip');
  assert.equal(rule[1], 'max(0px, calc(var(--platform-safe-bottom, 0px) - 14px))',
    'all but 14px of the strip, never negative when the inset is thin');
  assert.doesNotMatch(css, /html\.un-android[^{]*\{[^}]*--platform-tabs-inset/,
    'Android\'s inset is the navigation bar: borrowing from it puts the tabs under it');
});

test('an installed Android app spends the navigation bar\'s full height (#2755)', () => {
  const block = /@media \(display-mode: standalone\), \(display-mode: fullscreen\) \{\s*html\.un-android,\s*html\.un-android #app-view\[data-app-surface="platform"\] \{\s*--platform-safe-bottom: ([^;]+);/.exec(css);
  assert.ok(block, 'standalone Android restates the inset on both the root and the platform surface');
  assert.equal(block[1],
    'max(var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)), env(safe-area-max-inset-bottom, 0px))',
    'the larger of the live inset and the navigation bar\'s full height, still in the kit form');
});

test('a drag that starts on the bar never pans the document (#2771)', () => {
  assert.match(css, /\.platform-tabs\s*\{[^}]*touch-action: none;/);
});

test('the same five tabs stand up at desktop, and the band goes away', () => {
  // A bottom bar is a PHONE shape: at 1280px its five tabs sit 250px apart
  // along the foot of the window, which is a row of unrelated buttons rather
  // than a set of places. Slack, Discord, Teams and Telegram Desktop all turn
  // the same bar into a left rail, and so does this.
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY');
  assert.ok(at > 0, 'the desktop block must exist, at the shell\'s own md breakpoint');
  const block = css.slice(at, css.indexOf('\n}\n', at));

  // TWO TOKENS, NOT ONE (#2718 review). `--platform-rail-full` is how wide
  // the rail IS and never changes; `--platform-rail-w` is how much width it
  // RESERVES, and goes to 0 while it is folded or peeking. One number for
  // both drew a 17px sliver — padding and a border around a zero-width
  // column — the first time the rail was peeked over a folded desktop.
  // #4417: 76px, the strip's; from 768px, every width the rail is drawn at,
  // the sidebar of rows sets it again (212px, tests/desktop-sidebar-rows).
  assert.match(css, /--platform-rail-full: 76px;/, 'the rail has a width');
  assert.match(css, /body \{\n    --platform-rail-full: 212px;\n  \}/, 'which the sidebar sets');
  assert.match(block, /--platform-rail-w: var\(--platform-rail-full\);/,
    'and reserves it while it is up');
  assert.match(block, /--platform-tabs-h: var\(--platform-safe-bottom\);/,
    'and the band at the foot is the home-indicator inset and nothing else');
  assert.match(block, /width: var\(--platform-rail-full\);/,
    'the bar is DRAWN at the full width, never at the reserved one');
  // A FLEX COLUMN, not the phone's grid (#2718 review). Same arrangement —
  // rows at their natural height, packed from the top — said the way that
  // lets Me claim the leftover space at the foot with `margin-top: auto`. In
  // a grid with `align-content: start` an auto margin moves an item only
  // inside its own `max-content` row, which is no movement at all.
  assert.match(block, /display: flex;\s*\n\s*flex-direction: column;/,
    'and stops being five equal columns');
  // The auto margin is on the rule drawn above Me (#2800), which Me follows.
  assert.match(block, /\.platform-tabs::after \{[^}]*order: 1;[^}]*margin: auto 4px 6px;/,
    'Me is the rail\'s foot: the four above are places, this is the reader');
  assert.match(block, /\.platform-rail-settings \{\s*\n\s*order: 2;\s*\}\s*#platform-tab-me \{\s*\n\s*order: 3;/,
    'and your settings, then you, come after the rule');
  // A GUTTER AFTER THE RAIL, MIRRORED ON THE FAR EDGE (#2718 review). The
  // rail's hairline was the content's left margin, so a card began where the
  // rail ended while the page had air on the right and none on the left — a
  // centred column inside then centred a gutter's width left of the window's
  // middle. Spending the same figure on both sides is what fixes that, and
  // 1.5rem is the shell's own outer gutter rather than a number for this edge.
  assert.match(block, /padding-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/,
    'the screens move over by PADDING, so nothing about the flex chain moves');
  assert.match(block, /padding-inline-end: var\(--platform-gutter\);/,
    'and the same figure is spent on the far edge');
  assert.match(block, /--platform-gutter: 1\.5rem;/);
  // …and the app view is NOT one of the roots in that list: an app covers the
  // rail, which is what "the app is the whole window" means. The prose above
  // the rule says so, so the check is on the selector itself.
  const roots = block.slice(block.indexOf('  :is(#home-screen'), block.indexOf('padding-inline-start: calc('));
  assert.doesNotMatch(roots, /#app-view/, 'an app covers the rail');
  assert.match(roots, /#messages-screen/, 'every platform root does move over');
  // QA 2026-09-24 Q23: the agent session's own screen drew from the window's
  // edge, under the rail, with its chips and the start of its composer
  // unreachable there.
  assert.match(roots, /#agent-session-screen/, 'the agent session screen moves over too');
  // IT MOVES OVER ANYWAY WHILE ITS RAIL IS UP (#2718 review), through a rule
  // of its own keyed off the bar rather than off the screen id — because
  // `#app-view` is two screens behind one id, and only one of them covers the
  // rail. Keyed off the bar and not off the tab, because the bar is already
  // the answer to that question.
  assert.match(block,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) #app-view \{\s*padding-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
  // The parked strip is not drawn on the desktop: a running app keeps its
  // App row, with its dot, under its community in the sidebar.
  assert.match(block, /#platform-parked \{\s*display: none;\s*\}/);
  assert.doesNotMatch(block, /\.platform-parked(?:-open|-pill)? \{/, 'so nothing styles it there');
});

test('the folded rail peeks back on hover, and reserves nothing while it does', () => {
  // A rail the viewer folded comes back on hover and stops spending width
  // while they work. NOT over a running app (#3138): the next test.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /id="platform-rail-peek"/, 'a hot zone starts it');
  // ONE QUESTION decides the zone: the viewer folded a rail the ROUTE has.
  // `visible` is false over a running app, chromeless and signed out alike —
  // places with no rail of their own to bring back.
  assert.match(bar, /\{visible && !railOpen && !runningApp \? \(/,
    'it exists only where a rail the route has was folded by hand, and never over a running app');
  assert.match(bar, /const runningApp = screen === 'app-view' && !tab;/,
    'a running app is the app view with no tab lit; its Workshop lights one');
  // NOT a bare `screen === 'app-view'`: the app view is two screens, and on
  // its Workshop the rail is UP. This strip is `z-index: 39` against the
  // rail's 30, so rendering it there lays an invisible 18px column down the
  // left edge of the tabs and swallows the press meant for the one under the
  // pointer.
  assert.ok(!bar.includes("{screen === 'app-view' ? ("),
    'the app view alone is not the question');
  // THE PEEK IS NOT THE BAR'S VISIBILITY. The router still says hidden, the
  // screens reserve no band, and the app is full width; this is an overlay
  // on top of that answer.
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/);
  assert.match(bar, /const collapsed = !visible \|\| !railOpen;/);
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-peek', collapsed && peek\);/);
  assert.match(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\)/,
    'a peeking bar reserves nothing — reflowing the app under the pointer '
    + 'that revealed it is the bug this excludes');
  // A phone has no pointer to hover with, and an invisible strip down the
  // left edge of a touch screen eats the swipe that goes back.
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.platform-rail-peek \{ display: none; \}/);
  // A fade, not a slide: a rail that slides in races the pointer that
  // summoned it and arrives under it.
  assert.match(css, /animation: platform-rail-peek-in 140ms ease-out;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}animation: none;/);
});

// #3138: on a desktop with an app open, the pointer drifting to the
// window's left edge (an app's own menus, lists and scrollbars put it there
// all the time) brought the rail up over the app. The hot zone is the only
// thing at the edge that starts a peek, so with no zone over a running app,
// a hover at x=2 cannot open the sidebar. That holds now the rail stays
// beside a running app on the desktop and can be folded there: the way back
// is #sidebar-toggle in the header. Rendered for real, across every
// arrangement. `tab` is what the router lights: nothing for a running app,
// Workshop (or Messages) for the app view's own platform screens.
function renderTabsAt({ screen, tab = null, visible, railOpen }) {
  const navMod = loadTsx('frontend/src/features/nav/nav-store.js');
  navMod.navStore.set({ screen, tab, railOpen });
  const { PlatformTabs } = loadTsx('frontend/src/features/nav/tab-bar.tsx', {
    stubs: {
      './nav-store.js': navMod,
      '../../lib/visibility-store': {
        useVisibility: (id, initial) => (id === 'platform-tabs' ? visible : initial),
      },
    },
  });
  const React = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: [path.join(ROOT, 'frontend')] }));
  return renderToStaticMarkup(React.createElement(PlatformTabs));
}

test('hovering the window\'s left edge over a running app never opens the sidebar (#3138)', () => {
  const zone = /id="platform-rail-peek"/;
  // A RUNNING APP whose rail the router hides (a phone, or "Keep sidebar
  // open in apps" off). No hot zone, whether or not the viewer folded the
  // rail before opening it — `railOpen` outlives the screen, and a fold made
  // on Home must not bring the zone into the app.
  assert.doesNotMatch(renderTabsAt({ screen: 'app-view', visible: false, railOpen: true }), zone,
    'a running app has no edge hot zone');
  assert.doesNotMatch(renderTabsAt({ screen: 'app-view', visible: false, railOpen: false }), zone,
    'nor after the rail was folded somewhere else');
  // A RUNNING APP WITH THE RAIL BESIDE IT (the desktop default): folded,
  // still no zone. The app has the window and the toggle brings the rail back.
  assert.doesNotMatch(renderTabsAt({ screen: 'app-view', visible: true, railOpen: false }), zone,
    'a rail folded beside a running app does not come back from the edge');
  // Chromeless and signed out: no rail behind the edge to bring back.
  assert.doesNotMatch(renderTabsAt({ screen: null, visible: false, railOpen: false }), zone);
  // UNCHANGED ELSEWHERE: a rail folded by hand on a platform screen (or an
  // app's Workshop, where the rail is up) still peeks back from the edge…
  assert.match(renderTabsAt({ screen: 'home-screen', tab: 'home', visible: true, railOpen: false }), zone);
  assert.match(renderTabsAt({ screen: 'app-view', tab: 'workshop', visible: true, railOpen: false }), zone);
  // …and an open rail has nothing to peek, so no strip over its tabs.
  assert.doesNotMatch(renderTabsAt({ screen: 'home-screen', tab: 'home', visible: true, railOpen: true }), zone);
  assert.doesNotMatch(renderTabsAt({ screen: 'app-view', tab: 'workshop', visible: true, railOpen: true }), zone);
  assert.doesNotMatch(renderTabsAt({ screen: 'app-view', visible: true, railOpen: true }), zone);
});

test('the explicit way to bring the rail back stays the sidebar toggle (#3138)', () => {
  // Removing the hover over a running app leaves the explicit controls as
  // they were: the toggle still docks a folded rail on a press, and still
  // peeks it when pointed at (it only exists where the route has a rail).
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  assert.match(toggle, /navStore\.set\(\{ railOpen: !navStore\.get\(\)\.railOpen, peek: false, peekOut: false \}\);/);
  // N21 (19 Oct polish board): and the press slides the rail (./rail-slide.ts).
  assert.match(toggle, /onClick=\{\(\) => slideRail\(\(\) => \{\s*clearPeekTimer\(\);/);
  assert.match(toggle, /onPointerEnter=\{railOpen \? undefined : enterPeekByMouse\}/);
  // …and it is drawn only where the rail is the ROUTE's, never because a
  // peek took `hidden` off it. Beside a running app on the desktop the rail
  // is the route's, so the toggle is there in the ✕'s place.
  assert.match(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-route-hidden\)\) \.platform-sidebar-toggle/);
});

test('every screen change clears the peek, and nothing else does', () => {
  // That is what a peek is FOR: you reveal the rail over an app to leave it,
  // and the thing you tapped has now happened. Leaving it set would hand the
  // next screen an overlay rail on top of its own.
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount,
    /setScreen\(screenId: string \| null, tabOverride\?: string \| null\) \{[\s\S]{0,1400}peek: false/);
  // THE OVERRIDE IS FOR ONE SCREEN (#2718 review): `#app-view` is the running
  // app, which lights nothing, AND the platform's Workshop for that app,
  // which lights Workshop. TAB_FOR_SCREEN cannot say so — a screen in that
  // map is a tab ROOT, and tests/header-back-home.test.js derives "shows no
  // back control" from being in it, which the app view's ✕ contradicts.
  assert.match(mount, /tab: tabOverride \|\| \(screen \? tabForScreen\(screen, railLayout\(\)\) : null\),/);
  // The rail's width decides Discover's light (29 Oct 2026), and a window
  // resized across it moves the light, unless the router named the tab.
  assert.match(mount, /tabNamed = !!tabOverride;/);
  assert.match(mount, /window\.matchMedia\?\.\(SIDEBAR_ROWS_QUERY\)\.addEventListener\?\.\('change', \(\) => \{\n      const \{ screen, tab \} = navStore\.get\(\);\n      if \(!screen \|\| tabNamed\) return;/);
  assert.match(read('public/js/app.js'),
    /screen === 'app-view' && !inApp\s*\n\s*\? \(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/,
    'and app.js is the one place that decides which of the two it is');
  // ON A CHANGE, not on every call. Re-asserting the screen you are already
  // on is not navigation, and clearing there yanks the rail out from under
  // the pointer that summoned it — measured with a harness that re-asserted
  // the current screen on a 100ms timer, which made the rail strobe at
  // exactly that rate. Nothing in the shipped router does that today; the
  // guard is here so that nothing ever can.
  assert.match(mount, /const changed = navStore\.get\(\)\.screen !== screen;/);
  assert.match(mount, /\.\.\.\(changed \? \{ peek: false, peekOut: false \} : null\),/);
});

test('the desktop rail folds by hand, and a phone can never lose its bar', () => {
  // #2718 review: "the sidebar toggle button is missing on desktop". Every
  // host in the study that draws a persistent rail also draws a way to fold
  // it, in the window's top-left corner.
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  const navStoreSrc = read('frontend/src/features/nav/nav-store.js');
  const header = read('frontend/src/features/header/platform-header.tsx');

  // THE STATE SHIPS OPEN, which is what makes it safe to hold in the nav
  // store at all: the prerendered document carries a visible bar, so the
  // first client render agrees with it and hydration is silent.
  assert.match(navStoreSrc, /railOpen: true,/);
  assert.match(toggle, /aria-pressed=\{railOpen \? 'true' : 'false'\}/,
    'the state is on the control, so the label can stay the ACTION');
  assert.match(toggle, /aria-label=\{railOpen \? t\('core:rail\.hideSidebar'\) : t\('core:rail\.showSidebar'\)\}/);
  assert.deepEqual([message('core:rail.hideSidebar'), message('core:rail.showSidebar')], ['Hide sidebar', 'Show sidebar']);
  assert.match(toggle, /aria-controls="platform-tabs"/);

  // IT IS UNSEEN WHERE THE ROUTE HAS NO RAIL — inside an app, chromeless,
  // signed out — because a toggle for a thing that is not there is a dead
  // control, and an app's rail comes back by pointing at the window's edge.
  // BUT THAT IS CSS'S ANSWER, not a `return null`: see the hydration note
  // further down, and the selector asserted with it.
  assert.ok(!/^import .*visibility-store/m.test(toggle),
    'the route may not reach this component through anything render-time');
  assert.ok(!/^\s*(if \(.*\) )?return null;/m.test(toggle), 'it always renders');

  // IT LIVES IN THE MEASURED LEFT GROUP, so use-header-layout.ts counts it
  // without being told: that hook decides whether the title can centre from
  // the group's inner edge, and a control outside the group is 28px of room
  // it would hand to the title.
  assert.match(header, /<SidebarToggle \/>/);

  // NOTHING ABOUT THE MARKUP VARIES WITH THE RAIL (#2718 review). Both this
  // group's class and the toggle's existence were computed from
  // `useVisibility('platform-tabs')` during render — a store public/js/app.js
  // publishes before this deferred bundle hydrates — so the prerender and the
  // first client render disagreed, and React threw #418 on every route. A
  // console error on any route fails every declared check.
  assert.match(header, /className=\{LEFT_GROUP_CLASS\}/, 'a constant, rendered once');
  assert.match(header, /const LEFT_GROUP_CLASS = '[^']*platform-header-left';/);
  // The header still READS a visibility flag — its own — and that is fine
  // because it spends it through `useHiddenClass`, a ref effect that runs
  // after hydration has already agreed with the prerender. The rule is not
  // "never read the store", it is "never let a read reach the markup".
  const reads = header.match(/^\s*const \w+ = useVisibility\(/gm) || [];
  assert.equal(reads.length, 1, 'one read, and it is not the rail\u2019s');
  assert.match(header, /const visible = useVisibility\('platform-header', true\);\n\s*useHiddenClass\(headerRef, !visible\);/);

  // A PHONE'S BAR IS AT THE FOOT OF THE SCREEN and is the only navigation
  // there is. Folding must never reach it — so the fold is a CLASS that
  // app.css acts on inside the desktop media query and nowhere else, rather
  // than the `hidden` the router uses. A desktop window narrowed to a phone
  // gets its bar back with no store watching the viewport.
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /useClassToggle\(barRef, 'platform-tabs-folded', !railOpen\);/);
  const folded = css.indexOf('.platform-tabs.platform-tabs-folded:not(.platform-tabs-peek)');
  assert.ok(folded > 0, 'a folded rail is not drawn');
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', folded) > 0);
  // …and it is not drawn only while it is not peeking, which is what makes
  // the hot zone at the window's edge the way back from folded.
  // N21: and drawn while it slides away (`platform-tabs-leaving`).
  assert.match(css.slice(folded, folded + 140), /:not\(\.platform-tabs-peek\):not\(\.platform-tabs-leaving\) \{\s*display: none;/);
  // The toggle itself is desktop-only by the same mechanism, and the group
  // that holds it goes with it when the back slot is empty — an
  // empty-but-present flex item still reserves the header's own `gap-4`,
  // which put the wordmark 16px in from the edge of every root screen the
  // first time this was tried. The id beats Tailwind's own `.flex`, which
  // wins equal-specificity conflicts because app.css loads first.
  assert.match(css, /\.platform-sidebar-toggle \{\n  display: none;\n\}/);
  // All three questions are CSS's, and none is part of hydration: does the
  // rail exist (`#platform-tabs.hidden`), is there room for it (the media
  // query), and has the group anything in it (`:has(> #back-btn.hidden)` —
  // #4703's merged places button excepted, which is the group's fourth
  // possible contents).
  assert.match(css,
    /#platform-header \.platform-header-left:has\(> #back-btn\.hidden\):not\(:has\(> \.header-places-btn\)\):not\(:has\(> \.nav-drawer-back\)\) \{\s*\n\s*display: none;/);
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-route-hidden\)\) #platform-header\s*\n\s*\.platform-header-left:has\(> #back-btn\.hidden\) \{\s*\n\s*display: flex;/,
    '…unless the toggle is in it, which needs both a rail and the width');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-route-hidden\)\) \.platform-sidebar-toggle \{\s*\n\s*display: inline-flex;/,
    'which is what replaces the `return null` the component used to do');
  // FOLDED RESERVES NOTHING, and only on the desktop layout.
  const zero = css.indexOf('body:has(#platform-tabs.platform-tabs-folded)');
  assert.ok(zero > 0);
  assert.ok(css.lastIndexOf('@media (min-width: 768px) {', zero) > 0,
    'the zeroing rule is inside the desktop block, so a phone never sees it');
  assert.match(css.slice(zero, zero + 120), /\{\s*--platform-rail-w: 0px;/);
});

test('a peek over a running app never brings the sidebar toggle into the app\'s strip', () => {
  // THE BUG: the peek takes `hidden` off #platform-tabs over a running app,
  // and the toggle's rule asked `#platform-tabs:not(.hidden)` alone — so
  // pointing at the window's left edge inside an app drew the toggle into the
  // app's own strip, pushed ✕, the tile and the name 34px right, and a press
  // on it folded the docked rail behind the app.
  //
  // The ROUTE'S answer rides beside the peek's as its own class, applied
  // through a ref like the others (never a rendered className, so nothing
  // about it can reach hydration)…
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /useClassToggle\(barRef, 'platform-tabs-route-hidden', !visible\);/);
  assert.match(bar, /useHiddenClass\(barRef, !visible && !peek\);/,
    'while `hidden` is still the OR of the route and the peek, so the peek works');
  // …and every rule that decides whether the toggle EXISTS reads it. A rail
  // the viewer folded is still the route's rail, so its toggle stays: that is
  // how the fold comes undone.
  const decides = css.match(/body:has\(#platform-tabs:not\(\.hidden\)[^)]*\)[^{]*(?:platform-sidebar-toggle|platform-header-left)[^{]*\{/g) || [];
  assert.equal(decides.length, 2, 'the toggle\'s own rule and its group\'s');
  for (const rule of decides) {
    assert.match(rule, /:not\(\.platform-tabs-route-hidden\)/, rule);
    assert.doesNotMatch(rule, /platform-tabs-folded|platform-tabs-peek/,
      'folding and peeking are not what decides it: the route is');
  }
});

test('the reservation is keyed off the bar\'s own hidden class', () => {
  // No second flag to keep in step: the island publishes `hidden` and the
  // screens read it, the same shape the wallpaper's route test uses.
  // The rail's width is keyed off it with the keyboard up as well: the
  // keys cover the rail's foot and take nothing from it (iPhone Duo,
  // tests/keyboard-keeps-sidebar.test.js).
  assert.match(css, /\n  body:has\(#platform-tabs:not\(\.hidden\)\) \{/);
  // Declared on `body` in BOTH branches. A custom property's var()s are
  // substituted on the element it is declared on, so a `:root` declaration
  // would bake in `:root`'s value and never see the override — which is also
  // why the parked strip's rule spells both terms out rather than adding 52px
  // to `--platform-bar-h`.
  assert.match(css, /\nbody \{\n(?:  \/\*[^]*?\*\/\n)?  --platform-bar-h: 0px;/);
  assert.match(css, /--platform-tabs-h: 0px;/);
  assert.match(css, /--platform-rail-w: 0px;\n  --platform-gutter: 0px;\n\}/,
    'and the rail costs a phone no width at all, nor the gutter beside it');
  assert.match(css,
    /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\) \{\s*--platform-tabs-h: calc\(52px \+ 56px \+ var\(--platform-tabs-inset, 0px\)\);/,
    'the strip adds its own band, and only while the bar is there to sit on '
    + 'for real rather than peeking over an app');
  assert.match(css, /\.platform-parked \{[^}]*bottom: var\(--platform-bar-h, 0px\);/,
    'and it rests ON the bar, so neither reserves the home-indicator twice');
  assert.match(css, /html\.un-kb #platform-tabs \{\s*display: none;/,
    'the keyboard takes the bar with it');
});

// ── The seam, and the foot (#2718 review) ──────────────────────────────

test('the bar and the rail meet as one surface, squared and ruled', () => {
  // The header is `rounded-b-2xl`, which is right while it floats over the
  // page with nothing under its corners. The rail arrives directly beneath
  // its LEFT one, so that 1rem curve cut a bite out of the top of a surface
  // made of the same material — one pane with a chip out of it.
  const at = css.indexOf('WHERE THE BAR MEETS THE RAIL');
  assert.ok(at > 0, 'the rule states its reason');
  const block = css.slice(at, css.indexOf('\n  }\n', css.indexOf('.platform-tabs:not(.platform-tabs-folded)', at)));
  assert.match(block, /#platform-header \{\s*\n\s*border-end-start-radius: 0;/,
    'square on the left');
  assert.doesNotMatch(block, /border-bottom-right-radius/,
    'and only on the left: the right corner still has page under it');
  assert.match(block, /\.platform-tabs:not\(\.platform-tabs-folded\) \{\s*\n\s*border-top: 1px solid var\(--app-sheet-line\);/,
    'a hairline across the seam, on the RAIL — a border under the header '
    + 'would run the window\'s whole width and divide the bar from the page too');
  // Keyed off the rail OCCUPYING its column. A folded rail is not there, so
  // the corner keeps its curve; a folded rail peeking is an overlay with the
  // page still underneath, where the curve is right for the same reason it
  // is right over an app.
  assert.match(block, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-folded\)\)/);
});

test('the desktop band tokens are not outranked by the phone\'s', () => {
  // `:has()` takes the specificity of its most specific ARGUMENT, so the
  // phone rule — whose argument carries one class more — outranked the
  // desktop block and `--platform-bar-h` / `--platform-tabs-h` never once
  // applied. Measured at 1280: `calc(56px + 0px)` and `calc(52px + 56px +
  // 0px)`. The parked strip is placed at `bottom: var(--platform-bar-h)`, so
  // the app you left floated 56px above the bottom-left corner instead of
  // resting in it, and every desktop screen reserved 108px of band at its
  // foot for a bar that is a rail down the side.
  const at = css.indexOf('THE BAND TOKENS NEED THE OTHER RULE\'S SELECTOR, EXACTLY');
  assert.ok(at > 0, 'the rule states its reason');
  const block = css.slice(at, css.indexOf('\n  }\n', css.indexOf(':has(#platform-parked', at)));
  // Character for character with the rule it has to beat, which is also the
  // right selector on its own terms: a PEEKING rail reserves nothing.
  assert.match(block, /html:not\(\.un-kb\) body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\) \{\s*\n\s*--platform-bar-h: 0px;\s*\n\s*--platform-tabs-h: var\(--platform-safe-bottom\);/);
  assert.match(block, /:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\)\):has\(#platform-parked:not\(\.hidden\)\)/);
  // On the desktop the parked strip is not drawn at all (the sidebar's App
  // rows are the way back), so nothing rests it on the rail's foot.
  assert.doesNotMatch(css, /--platform-rail-foot-h/);
});

test('a tab label has room for its descenders', () => {
  // `.platform-tab` sets `line-height: 13px` as an absolute — right for the
  // 11px caption under a phone glyph, two pixels short for the rail's 15px
  // row. With `overflow: hidden` on the label the tail of a `g` or a `p` was
  // sliced off flat. Measured at 1280: an 18px ink box in a 13px line box.
  const label = css.slice(css.indexOf('\n.platform-tab-label {'));
  assert.match(label.slice(0, label.indexOf('\n}')), /line-height: 1\.35;/,
    'a unitless multiplier is the one value correct at both sizes');
});

test('the Messages count is the quiet one: grey, on the glyph\'s corner on the phone, at the row\'s end beside it (#2912, #4417)', () => {
  // Grey is "new to read" (#18, 19 Oct 2026 polish board): this is where an
  // unread message is counted, and the bell's red no longer counts plain
  // messages at all (notifications.js _badgeTotal), so one message lights
  // one number. The bell keeps the red (#notifications-badge is not touched).
  const phone = css.match(/\n\.platform-tab-badge \{[^}]*\}/);
  assert.ok(phone, 'the badge has its base (phone) rule');
  assert.match(phone[0], /background: var\(--text-faint, #8e8e93\);/,
    'a grey disc on the phone, one value in both themes');
  assert.doesNotMatch(phone[0], /--danger|#ef4444/, 'the red is the bell\'s alone');
  assert.match(phone[0], /position: absolute;\s*top: -3px;\s*inset-inline-start: calc\(100% - 7px\);/,
    'and it keeps its place on the glyph\'s corner');

  // From 768px the sidebar of rows draws a row, and the count sits at its
  // far end, the size of a row's other counts (the strip that kept it on
  // the glyph's corner is gone, and its offsets with it).
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  const row = block.match(/\n {2}\.platform-tab-badge,\n {2}\.platform-tab-votes,\n {2}\.platform-tab-all-votes \{[^}]*\}/);
  assert.ok(row, 'the sidebar places the badge inside its block');
  assert.match(row[0], /position: static;\s*order: 2;/);
  const rail = css.slice(css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY'));
  assert.doesNotMatch(rail.slice(0, rail.indexOf('\n}\n')), /\n {2}\.platform-tab-badge \{/, 'no corner offsets left over');

  // THE MARKUP DOES NOT MOVE, which is what lets the phone keep its anchor
  // and the declared checks keep finding the badge inside the Messages tab.
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html,
    /id="platform-tab-messages"[^>]*><span class="platform-tab-mark"><svg[^>]*class="platform-tab-glyph"[\s\S]*?<\/svg><span id="platform-tabs-badge"/,
    'the badge is still the glyph wrapper\'s child, inside #platform-tab-messages');
});

test('the Messages tab cannot be dead, whatever the flag says', () => {
  // navigateToMessages returns EARLY when `_inMessages` is set — routing the
  // island and revealing nothing, because the screen is supposed to be up
  // already. Only navigateToWorkshop and the global-chat route cleared that
  // flag, so Messages → Home → Messages found it still true, took the early
  // return and did nothing at all.
  const appJs = read('public/js/app.js');
  const reveal = appJs.slice(appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {'));
  assert.match(reveal.slice(0, reveal.indexOf('\n  },\n')),
    /if \(revealId !== 'messages-screen' && App\._inMessages\) App\._exitMessages\(\);/,
    'one clearer, at the choke point every reveal passes through — the same '
    + 'place and the same reasoning as `_appBackHref` beside it');
  // And the early return asks the SCREEN, not just the flag.
  assert.match(appJs,
    /if \(App\._inMessages && App\._isScreenVisible\('messages-screen'\) && messages\?\.isOpen\?\.\(\)\)/);
});

test('an app\'s channel belongs to its community, and a change to Messages', () => {
  // `dev/chat` is the project's CHANNEL. It was a row in the Messages inbox
  // (#2718 review) and lit Messages; the channels live on each community's
  // hub now, so it lights Communities and its chevron goes up to the hub. A
  // dev session is still an agent conversation (#2770), a thread of Messages.
  assert.match(read('public/js/app.js'),
    /screen === 'app-view' && !inApp\s*\n\s*\? \(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/);
  const appJs = read('public/js/app.js');
  const pred = appJs.slice(appJs.indexOf('  _isMessagesThread() {'));
  assert.match(pred.slice(0, pred.indexOf('\n  },')),
    /return App\.currentTab === 'dev' && App\.currentSubTab === 'sessions';/,
    'a dev session alone is a thread of Messages');
  assert.match(appJs, /_isChannelThread\(\) \{\s*return App\.currentTab === 'dev' && App\.currentSubTab === 'chat';/);
  assert.match(appJs, /if \(App\._isMessagesThread\(\)\) return \['arrow', '#messages'\];/,
    'and the back slot agrees with the tab that lights');
  assert.match(appJs, /if \(App\._isChannelThread\(\)\) return \['arrow', App\._hubHref\(App\.currentApp\)\];/,
    'the channel\'s way up is its hub');
  assert.match(appJs, /_hubHref\(slug\) \{\s*return slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#communities';/,
    'a hash, because the back button follows only a hash');
  const appView = read('public/js/app-view.js');
  const branch = appView.slice(appView.indexOf("if (subTab === 'chat') {"));
  assert.match(branch.slice(0, branch.indexOf('\n    }')),
    /App\.setBackIcon\?\.\('arrow', App\._hubHref\?\.\(App\.currentApp\) \|\| '#communities'\);/,
    'a level inside the hub shows the way up to it');
  // A CHANGE IS AN AGENT CONVERSATION (#2770): its screen hangs off Messages
  // the same way, rather than off the board it used to point at.
  const session = appView.slice(appView.indexOf("if (subTab === 'sessions' && ref) {"));
  assert.match(session.slice(0, session.indexOf('\n    }')),
    /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'a dev session shows the way up to Messages');
});

// ── #2824: the lit tab's sliding marker ───────────────────────────────

test('the marker ships bare, so the first render matches the prerender', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  const marker = html.match(/<span[^>]*class="platform-tabs-marker"[^>]*>/);
  assert.ok(marker, 'the marker is part of the bar\'s markup');
  assert.match(marker[0], /aria-hidden="true"/, 'aria-current already announces the lit tab');
  assert.doesNotMatch(marker[0], /style=|data-marker-at|data-marker-slide/,
    'unmeasured: no geometry and not visible, or hydration disagrees and it slides in from the edge');
  // Rendered BEFORE the tabs so it paints behind them.
  assert.ok(html.indexOf('platform-tabs-marker') < html.indexOf('id="platform-tab-home"'));
});

test('the marker hugs the lit tab\'s glyph and label, and an unlaid-out bar keeps the last box', () => {
  const { markerBoxFor } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  const cell = { offsetLeft: 150, offsetTop: 0, offsetWidth: 72, offsetHeight: 56 };
  // "Workshop": a 56px label under a 22px glyph, centred in a 72px cell.
  assert.deepEqual(
    { ...markerBoxFor(cell, { left: 8, top: 9, width: 56, height: 37 }) },
    { x: 150, y: 4, w: 72, h: 45 },
    '8px either side of the label, 5px over the glyph, 3px under the label',
  );
  // "Home": narrower than the floor, so the pill is 58px, still centred.
  assert.deepEqual(
    { ...markerBoxFor(cell, { left: 20, top: 9, width: 32, height: 37 }) },
    { x: 157, y: 4, w: 58, h: 45 },
    'a short label still gets a pill, not a capsule',
  );
  // A label wider than its cell: the pill follows it past the cell's edges
  // (the tab keeps the cell as its target; only the fill is wider).
  assert.equal(markerBoxFor(cell, { left: 2, top: 9, width: 68, height: 37 }).w, 84);
  // Nothing measurable inside: the old geometry, the cell inset 4px.
  assert.deepEqual(
    { ...markerBoxFor(cell) },
    { x: 154, y: 4, w: 64, h: 48 },
  );
  assert.deepEqual({ ...markerBoxFor(cell, { left: 0, top: 0, width: 0, height: 0 }) }, { x: 154, y: 4, w: 64, h: 48 });
  assert.equal(markerBoxFor({ offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 }), null,
    'a hidden bar (an app, the keyboard) has no geometry to report');
  // iPhone Duo's side strip: a 64px column whose cells are its whole width.
  // The pill keeps to the cell, inset 4px a side, and hugs only up and down;
  // sized by "Communities" it was 71px and ran past the column's sides.
  const stripCell = { offsetLeft: 0, offsetTop: 230, offsetWidth: 64, offsetHeight: 54 };
  assert.deepEqual(
    { ...markerBoxFor(stripCell, { left: 4, top: 8, width: 56, height: 36 }, true) },
    { x: 4, y: 233, w: 56, h: 44 },
  );
  assert.deepEqual(
    { ...markerBoxFor(stripCell, { left: 18, top: 8, width: 28, height: 36 }, true) },
    { x: 4, y: 233, w: 56, h: 44 },
    'a short label fills the cell the same',
  );
});

test('only a selection change slides, the Workshop\'s way (#2824)', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(src, /slide: !!prev && selectionChanged/,
    'the first placement and a re-measure land; only a new tab slides');
  assert.match(src, /new ResizeObserver\(\(\) => \{ if \(!cancelSlide\) measure\(false\); \}\)/);
  assert.match(src, /const selector = target === APP_TARGET \? '\.platform-side-app\[aria-current="page"\]' : '\.platform-tab\[aria-current="page"\]';/,
    'the marker follows the same attribute the declared checks and screen readers read');
  assert.match(src, /querySelector<HTMLElement>\(selector\)/);
});

// #3046: on the phone a tab press swaps the whole screen synchronously, so
// the first frame after it is the expensive one. A transition written in that
// frame had spent its duration before anything painted and showed only the
// tail of the slide. The slide therefore starts two frames out.
test('a slide waits out the screen swap\'s frame before it starts (#3046)', () => {
  const { afterNextFrame } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  const queue = [];
  let nextId = 0;
  const raf = (cb) => { queue.push(cb); nextId += 1; return nextId; };
  const cancelled = [];
  const caf = (id) => cancelled.push(id);
  let ran = 0;
  afterNextFrame(() => { ran += 1; }, raf, caf);
  assert.equal(ran, 0, 'not in the press\'s own task');
  queue.shift()();
  assert.equal(ran, 0, 'not at the start of the swap\'s frame either — that write lands in it');
  queue.shift()();
  assert.equal(ran, 1, 'once the swap\'s frame has been produced');

  // A second press before it starts cancels the first slide.
  let ran2 = 0;
  const cancel = afterNextFrame(() => { ran2 += 1; }, raf, caf);
  queue.shift()();
  cancel();
  assert.deepEqual(cancelled, [4], 'the pending second frame is cancelled');
  assert.equal(ran2, 0);

  // No rAF (a test environment, a worker): it runs at once.
  let ran3 = 0;
  afterNextFrame(() => { ran3 += 1; }, undefined, undefined);
  assert.equal(ran3, 1);

  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const hook = src.slice(src.indexOf('function useTabMarker('), src.indexOf('export function PlatformTabs()'));
  assert.match(hook, /cancelSlide = afterNextFrame\(\(\) => \{\s*cancelSlide = null;\s*measure\(true\);/,
    'a move from a marked tab re-measures and slides after the frame');
  assert.match(hook, /new ResizeObserver\(\(\) => \{ if \(!cancelSlide\) measure\(false\); \}\)/,
    'the observer\'s delivery on observe() cannot land the marker ahead of its pending slide');
  assert.match(hook, /cancelSlide\?\.\(\);/, 'a tab change or unmount cancels a pending slide');
});

test('the marker is the Workshop\'s blue, on the Workshop\'s curve, phone only', () => {
  const rule = css.match(/\.platform-tabs-marker \{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /position: absolute;/);
  assert.match(rule[0], /background: var\(--lit-tint\);/);
  assert.match(rule[0], /box-shadow: inset 0 0 0 1px var\(--lit-line\);/);
  assert.match(rule[0], /opacity: 0;/, 'hidden until measured');
  assert.match(rule[0], /transform-origin: 0 0;/, 'the slide scales from the corner its translate places');
  assert.match(css, /\.platform-tabs-marker\[data-marker-at\] \{ opacity: 1; \}/);
  assert.match(css, /\.platform-tab \{\s*position: relative;\s*z-index: 1;\s*\}/,
    'the tabs sit over the marker');
  // The rail keeps its row fill; the marker is not drawn there.
  const desktop = css.slice(css.indexOf('The rail keeps its own fill on the lit row'));
  assert.match(desktop.slice(0, 200), /\.platform-tabs-marker \{\s*display: none;\s*\}/);
  // The Workshop strip's duration and curve, as an animation now (#3259).
  const { MARKER_SLIDE } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  assert.deepEqual({ ...MARKER_SLIDE }, { duration: 260, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  assert.match(css, /\.dev-ws-tab-marker\[data-ws-marker-slide\] \{[^}]*cubic-bezier\(\.32, \.72, 0, 1\)/,
    'the curve is still the Workshop strip\'s');
});

// ── #3259: the slide starts before the swap, and the swap waits for it ──

// Measured in the iOS simulator: with the slide written two frames after the
// swap began, its first frames landed in the swap's long ones and it appeared
// half-way across. A press now slides first and the navigation waits until
// the slide is running on the compositor.
test('the slide is transform only, a FLIP from the box it leaves (#3259)', () => {
  const { slideKeyframes, shownBox } = loadTsx('frontend/src/features/nav/tab-bar.tsx');
  const [start, end] = slideKeyframes({ x: 150, y: 4, w: 88, h: 45 }, { x: 290, y: 4, w: 58, h: 45 });
  assert.equal(start, 'translate(150px, 4px) scale(1.5172, 1)', 'starts looking like the box it leaves');
  assert.equal(end, 'translate(290px, 4px) scale(1, 1)', 'and ends as laid out');
  assert.deepEqual(
    start.match(/[a-z]+\(/g), end.match(/[a-z]+\(/g),
    'both ends spell the same functions, so they interpolate one by one',
  );
  // A press during a slide starts the next one from where the pill IS.
  assert.deepEqual(
    { ...shownBox({ x: 290, y: 4, w: 58, h: 45 }, 'matrix(1.2, 0, 0, 1, 210.5, 4)') },
    { x: 210.5, y: 4, w: 69.6, h: 45 },
  );
  assert.deepEqual({ ...shownBox({ x: 1, y: 2, w: 3, h: 4 }, 'none') }, { x: 1, y: 2, w: 3, h: 4 });

  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const hook = src.slice(src.indexOf('function useTabMarker('), src.indexOf('function goToTab('));
  assert.match(hook, /el\.animate\(\[\{ transform: start \}, \{ transform: end \}\], \{\s*duration: MARKER_SLIDE\.duration,\s*easing: MARKER_SLIDE\.easing,\s*\}\);/,
    'no delay and no fill: a delayed animation was not handed to the compositor');
  assert.match(hook, /if \(!box \|\| !from \|\| !box\.slide \|\| !motionWelcome\(\)\) return;/,
    'only a selection change slides, and reduced motion gets none');
  assert.doesNotMatch(css, /\.platform-tabs-marker\[data-marker-slide\]/, 'no transition of width and height on the main thread');
  assert.doesNotMatch(src, /'data-marker-slide'/);
});

test('a press navigates once the frame that lights the tab is painted, not after the slide starts (#3259, polish #2)', async () => {
  const { schedulePress, PRESS_SETTLE_MS } = loadTsx('frontend/src/features/nav/tab-press.ts');
  const src = read('frontend/src/features/nav/tab-press.ts');
  assert.doesNotMatch(src, /export const SLIDE_START_WAIT_MS|started\(\)|\.then\(/,
    'polish #2: waiting for the slide held the old screen up for 120 to 205ms');
  const frames = [];
  const raf = (cb) => { frames.push(cb); return frames.length; };
  const caf = (id) => { frames[id - 1] = null; };
  const frame = () => { const due = frames.splice(0); for (const cb of due) if (cb) cb(); };
  const timers = [];
  const clock = {
    set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clear: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const fire = (ms) => { for (const t of timers) if (t.ms === ms && t.fn) { const fn = t.fn; t.fn = null; fn(); } };

  // The press's own frame, then the task after it.
  const holder = { current: null };
  let went = 0;
  schedulePress(holder, 'discover', () => { went += 1; }, () => {}, raf, caf, clock);
  assert.equal(went, 0, 'not in the press\'s own task: the lit tab paints first');
  frame();
  assert.equal(went, 0, 'not inside the frame either: that is where #3259 saw the slide shown from its middle');
  fire(0);
  assert.equal(went, 1, 'the task after the frame');
  frame();
  fire(0);
  assert.equal(went, 1, 'once');

  // Without frames (a test environment) it goes at once.
  const bare = { current: null };
  let bareWent = 0;
  schedulePress(bare, 'home', () => { bareWent += 1; }, () => {}, undefined, undefined, clock);
  assert.equal(bareWent, 1);

  // A second press before the first navigates replaces it, frame or task.
  const twice = { current: null };
  const gone = [];
  schedulePress(twice, 'discover', () => gone.push('discover'), () => {}, raf, caf, clock);
  schedulePress(twice, 'me', () => gone.push('me'), () => {}, raf, caf, clock);
  frame();
  fire(0);
  assert.deepEqual(gone, ['me']);
  const late = { current: null };
  const lateGone = [];
  schedulePress(late, 'discover', () => lateGone.push('discover'), () => {}, raf, caf, clock);
  frame();
  schedulePress(late, 'me', () => lateGone.push('me'), () => {}, raf, caf, clock);
  fire(0);
  frame();
  fire(0);
  assert.deepEqual(lateGone, ['me'], 'a press waiting on its task is called off too');

  // Unanswered, the bar goes back to the router's tab; answered, it stays.
  const lost = { current: null };
  let settled = 0;
  schedulePress(lost, 'messages', () => {}, () => { settled += 1; }, raf, caf, clock);
  frame();
  fire(0);
  fire(PRESS_SETTLE_MS);
  assert.equal(settled, 1);
  assert.equal(lost.current, null);
  const answered = { current: null };
  let settledAnswered = 0;
  const entry = schedulePress(answered, 'messages', () => {}, () => { settledAnswered += 1; }, raf, caf, clock);
  frame();
  fire(0);
  entry.cancel();
  answered.current = null;
  fire(PRESS_SETTLE_MS);
  assert.equal(settledAnswered, 0);
});

test('a plain press on another tab lights it and slides first; the router answers after (#3259)', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(src, /onClick=\{\(event\) => onTabClick\(event, key, href\)\}/);
  assert.match(src, /aria-current=\{lit === key \? 'page' : undefined\}/,
    'the pressed tab is lit until the router answers');
  const click = src.slice(src.indexOf('const onTabClick = '), src.indexOf('return (', src.indexOf('const onTabClick = ')));
  assert.match(click, /if \(nav\?\.isNativeClick\?\.\(event\)\) return;/, 'a modified click stays the browser\'s');
  assert.match(click, /if \(key !== lit && press\(event\.currentTarget, key, \(\) => goToTab\(key, href\), fallback\)\) \{\s*event\.preventDefault\(\);/);
  const press = src.slice(src.indexOf('const press = (el: HTMLElement'), src.indexOf('return { box, lit, markerRef, press };'));
  assert.ok(press.indexOf('place(el, true);') < press.indexOf('schedulePress('), 'the pill moves in the press\'s own task');
  assert.match(press, /schedulePress\(pending, key, go, \(\) => setPressed\(null\), undefined, undefined, undefined, fallback\);/);
  // The three roads the clicks take at once, taken late.
  const go = src.slice(src.indexOf('function goToTab('), src.indexOf('export function PlatformTabs()'));
  assert.match(go, /app\.navigateHome\(\{ viaTab: true \}\);/);
  assert.match(go, /if \(key === 'workshop' && app\?\.resumeWorkshopView\?\.\(\)\) return;/);
  assert.match(go, /window\.location\.assign\(href\);/);
  // The router lighting the pressed tab answers the press.
  assert.match(src, /if \(!pending\.current \|\| pending\.current\.key !== tab\) return;\s*pending\.current\.cancel\(\);\s*pending\.current = null;\s*setPressed\(null\);/);
});

// ── #5730: a Communities press from Me or Discover lands on Communities ──
//
// Pressed from Me (#profile) or Discover (#apps), the Communities tab could
// light for a moment and then slide back: the resume it runs
// (App.resumeWorkshopView) hands off to navigateToApp, and the phone's list
// road (goToCommunity(null)) needs a community to open over, so neither
// necessarily reveals a screen. The router never lit `workshop`, and
// schedulePress's settle put the pill back. That press now carries a fallback
// — the All communities page, which is an ordinary address and always lands —
// and the fallback is given the same wait again rather than settling.

/** The fake frames, the fake clock and `fire(ms)` the press tests drive. */
function pressClock() {
  const frames = [];
  const raf = (cb) => { frames.push(cb); return frames.length; };
  const caf = (id) => { frames[id - 1] = null; };
  const frame = () => { const due = frames.splice(0); for (const cb of due) if (cb) cb(); };
  const timers = [];
  const clock = {
    set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clear: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  // Only the timers that are due NOW: one a callback arms is the NEXT wait.
  const fire = (ms) => {
    for (const t of timers.slice()) if (t.ms === ms && t.fn) { const fn = t.fn; t.fn = null; fn(); }
  };
  return { raf, caf, frame, clock, fire };
}

for (const from of ['me', 'discover']) {
  test(`#5730: a Communities press from ${from} that reveals nothing falls back, then stays lit`, () => {
    const { schedulePress, PRESS_SETTLE_MS } = loadTsx('frontend/src/features/nav/tab-press.ts');
    const { raf, caf, frame, clock, fire } = pressClock();
    const holder = { current: null };
    const fellBack = [];
    let settled = 0;
    const went = [];
    const entry = schedulePress(
      holder, 'workshop',
      () => went.push(from), // the resume road, which lit nothing
      () => { settled += 1; },
      raf, caf, clock,
      () => fellBack.push(from),
    );
    assert.deepEqual(went, [], 'the press navigates a frame late');
    frame();
    fire(0);
    assert.deepEqual(went, [from], 'the tab\'s own navigation ran');
    assert.deepEqual(fellBack, [], 'and the press is given its wait first');

    // THE WAIT RUNS OUT: the fallback, once, and no settle.
    fire(PRESS_SETTLE_MS);
    assert.deepEqual(fellBack, [from], 'the fallback runs when the route does not answer');
    assert.equal(settled, 0, 'the pill does not go back at the first settle');
    assert.equal(holder.current, entry, 'the press is still waiting for the router');

    // The router then lights Communities, which answers the press.
    entry.cancel();
    holder.current = null;
    fire(PRESS_SETTLE_MS);
    assert.equal(settled, 0, 'answered after the fallback, the pill never moves back');
    assert.deepEqual(fellBack, [from], 'once');
  });
}

test('#5730: a fallback that is not answered still settles, and runs only once', () => {
  const { schedulePress, PRESS_SETTLE_MS } = loadTsx('frontend/src/features/nav/tab-press.ts');
  const { raf, caf, frame, clock, fire } = pressClock();
  const holder = { current: null };
  let fellBack = 0;
  let settled = 0;
  schedulePress(holder, 'workshop', () => {}, () => { settled += 1; }, raf, caf, clock, () => { fellBack += 1; });
  frame();
  fire(0);
  fire(PRESS_SETTLE_MS);
  assert.equal(fellBack, 1, 'the fallback runs at the first settle');
  assert.equal(settled, 0, 'and the press gets a second wait');
  fire(PRESS_SETTLE_MS);
  assert.equal(fellBack, 1, 'only once, however long it waits');
  assert.equal(settled, 1, 'then the bar goes back to the router\'s tab');
  assert.equal(holder.current, null, 'and the press is over');
});

test('#5730: a newer press calls off the fallback waiting on the first', () => {
  const { schedulePress, PRESS_SETTLE_MS } = loadTsx('frontend/src/features/nav/tab-press.ts');
  const { raf, caf, frame, clock, fire } = pressClock();
  const holder = { current: null };
  let fellBack = 0;
  schedulePress(holder, 'workshop', () => {}, () => {}, raf, caf, clock, () => { fellBack += 1; });
  frame();
  fire(0);
  // The person presses another tab while Communities is still unanswered.
  schedulePress(holder, 'discover', () => {}, () => {}, raf, caf, clock);
  fire(PRESS_SETTLE_MS);
  assert.equal(fellBack, 0, 'the abandoned press never falls back');
});

test('#5730: only a Communities press carries a fallback, guarded on the screen it left', () => {
  const src = read('frontend/src/features/nav/tab-bar.tsx');
  const click = src.slice(src.indexOf('const onTabClick = '), src.indexOf('return (', src.indexOf('const onTabClick = ')));
  assert.match(click, /const left = navStore\.get\(\)\.screen;\s*const fallback = key === 'workshop'\s*\? \(\) => \{ if \(navStore\.get\(\)\.screen === left\) openCommunitiesPage\(\); \}\s*: undefined;/,
    'captured at press time, and it acts only if that is still the screen on show');
  assert.match(click, /press\(event\.currentTarget, key, \(\) => goToTab\(key, href\), fallback\)/,
    'the press is given it; every other tab passes none');
  // The fallback is the page, not the drawer's road that just failed.
  const open = src.slice(src.indexOf('function openCommunitiesPage('), src.indexOf('export function PlatformTabs()'));
  assert.match(open, /App\?\._forgetWorkshopView\?\.\(\)/, 'the community that did not open is forgotten');
  assert.match(open, /if \(window\.location\.hash !== '#communities'\) window\.location\.hash = '#communities';/,
    'the address that always routes to the All communities page');
  assert.doesNotMatch(open, /goToCommunity\(/, 'never the phone drawer road that revealed nothing');
  assert.doesNotMatch(open, /console\./, 'a console error fails proposal checks');
  // The desktop sidebar of rows is a hash route that always lands: unchanged.
  assert.match(click, /if \(key === 'workshop' && sidebarRows\) \{\s*event\.preventDefault\(\);\s*if \(screen === 'workshop-screen'\) pressLitTab\(screen\);\s*else goToCommunity\(null\);\s*return;\s*\}/);
});

// ── #4417: the desktop strip, and where its apps went ───────────────────
//
// The 224px rail of rows and Recents (#2802) became a 76px strip: the four
// sections as an icon over a label, a line, the five apps used most
// recently, then you at the foot. The conversations Recents listed are
// Messages' own list. From 768px the strip is the sidebar of rows now, and
// since 18 Oct 2026 each community's app is the first row under it, so the
// strip's Pinned and Recent apps went: a pin is a community's
// (frontend/src/features/nav/rail-pinned.tsx) and a running app keeps its
// App row under its community (rail-communities.tsx,
// tests/desktop-sidebar-apps.test.js).

const PINNED = 'frontend/src/features/nav/rail-pinned.tsx';
const RAIL = 'frontend/src/features/nav/rail-communities.tsx';

test('the sidebar: the sections as rows, the pinned communities above yours, then you at the foot', () => {
  // The strip's icon over a label went with the strip: from 768px a section
  // is a row, its glyph then its name.
  const rail = css.slice(css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY'));
  assert.doesNotMatch(rail.slice(0, rail.indexOf('\n}\n')), /\n {2}\.platform-tab \{[^}]*flex-direction: column;/,
    'no icon over a label left over');
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  const tab = block.match(/\n {2}\.platform-tab \{[^}]*\}/)[0];
  assert.match(tab, /flex-direction: row;/, 'a row');
  assert.match(tab, /height: 36px;/);
  assert.match(tab, /font-size: 14px;/);
  // Recents are gone, and so are the strip's apps: the pins sit above your
  // communities, and nothing lists apps apart from them.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.doesNotMatch(bar, /RecentsList|recents-list|StripApps/);
  assert.match(bar, /key === 'workshop' \? <RailPinned key="pinned" \/> : null,\n[\s\S]*?key === 'workshop' \? <RailCommunities key="communities" shown=\{railShown\} \/> : null,/);
  for (const gone of [
    'frontend/src/features/nav/recents.ts', 'frontend/src/features/nav/recents-list.tsx', 'tests/nav-recents.test.js',
    'frontend/src/features/nav/strip-apps.tsx',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} is retired`);
  }
  assert.doesNotMatch(css, /\.platform-recents?\b/, 'and its styles with it');
  assert.doesNotMatch(css, /\.platform-strip-/, 'and the strip apps\' with theirs');
  // The phone's bar is unchanged: five equal cells, no pins.
  assert.match(css, /\.platform-tab-all-votes,\n\.platform-rail-pinned \{\n {2}display: none;\n\}/);
});

// #5323: the "Pin here" slot is the one row the Pinned section draws while a
// My apps tile is in the air, after the pins; a refused drop says so in
// words. It un-hides an empty section so there is somewhere to drop, and it
// is gone again when the gesture is over.
test('#5323: the drop row renders only while a drag is up', () => {
  const src = read(PINNED);
  assert.match(src, /const \{ drop \} = useStoreState\(pinDropStore\);/,
    'the slot answers the drag state, never its own guess');
  assert.match(src, /data-rail-pin-drop=""/);
  assert.match(src, /data-drop-state=\{drop\}/);
  assert.match(src, /core:rail\.pin\.here/);
  assert.match(src, /core:rail\.pin\.already/);
  assert.match(src, /core:rail\.pin\.full/);
  // The slot holds an empty section open: hidden only when there are no pins
  // AND no drop.
  assert.match(src, /useHiddenClass\(ref, items\.length === 0 && !drop\);/);
  assert.match(css, /\.platform-rail-pin-drop\[data-drop-state='ok'\]/,
    'the lit fill is the drop-accepted state');
  // The refused words are drawn muted, so the slot never looks like an
  // accepted drop.
  const dropRule = css.match(/\n {2}\.platform-rail-pin-drop \{[^}]*\}/)[0];
  assert.match(dropRule, /color: var\(--text-muted\);/);
  // Home's drag recognizer drops on this section and lands on its slot.
  const home = read('frontend/src/features/home/home.js');
  assert.match(home, /const strip = document\.getElementById\('platform-rail-pinned'\);\n\s*if \(!strip \|\| typeof strip\.getBoundingClientRect !== 'function'\) return false;/);
  assert.match(home, /const drop = strip\.querySelector\('\[data-rail-pin-drop\]'\);/);
});

// #5323: unpin two ways — the row's right-click menu (any community of
// yours has it, ./pin-actions.ts), and a mouse drag back out of the sidebar. The ghost is React state only,
// portaled to the body, so the prerender ships nothing of it; the click a
// release leaves behind must not open the community.
test('#5323: a pinned row carries the Unpin menu and the drag-out path', () => {
  const src = read(PINNED);
  const row = read(RAIL);
  assert.match(row, /\{\.\.\.\(yours \? \{\s*onContextMenu: \(event: MouseEvent<HTMLAnchorElement>\) => \{\s*openPinMenu\(event, \{ slug, name, iconUrl: icon\.icon_url, iconEmoji: icon\.icon_emoji \}, href\);/,
    'the menu opens on the row itself, a pinned one among them');
  const actions = read('frontend/src/features/nav/pin-actions.ts');
  assert.match(actions, /kit\.menu\(\{/, 'the kit presents it, as a My apps tile\'s menu is presented');
  assert.match(actions, /label: isPinned\(target\.slug\) \? t\('core:rail\.pin\.unpin'\) : t\('core:rail\.pin\.add'\)/);
  assert.match(actions, /label: t\('core:rail\.pin\.newTab'\)/, 'and the link\'s own Open in new tab');
  assert.match(src, /if \(!insideTabs\(event\.clientX, event\.clientY\)\) unpinApp\(drag\.app\.slug, navStore\.get\(\)\.viewer\);/, 'the drag out unpins');
  // The drag-out is mouse-only, past a small threshold, with capture.
  assert.match(src, /event\.pointerType !== 'mouse'/);
  assert.match(src, /Math\.hypot\(event\.clientX - drag\.startX, event\.clientY - drag\.startY\) <= 6/);
  assert.match(src, /setPointerCapture\(event\.pointerId\)/);
  // The ghost follows the pointer, portaled out of the sidebar, and carries
  // the caption only while it is outside #platform-tabs.
  assert.match(src, /createPortal\(/);
  assert.match(src, /data-unpin=\{ghost\.unpin \? 'true' : undefined\}/);
  assert.match(src, /platform-rail-pin-ghost-caption/);
  assert.match(src, /document\.body,/);
  // Escape aborts; the release outside unpins and swallows the click, which
  // the row asks about before it navigates.
  assert.match(src, /event\.key !== 'Escape'/);
  assert.match(src, /swallowClickRef\.current = true/);
  assert.match(read(RAIL), /if \(pin\?\.swallowClick\(\)\) \{\s*event\.preventDefault\(\);\s*return;\s*\}/);
  // Ghost and slot are React state and store state with empty initials, so
  // the prerendered section ships none of it, and it reads no storage during
  // a render (the stored pins are read in effects and by mount.ts when the
  // viewer is named).
  assert.doesNotMatch(src.slice(src.indexOf('export function RailPinned')), /localStorage/);
  assert.match(css, /\.platform-rail-pin-ghost \{[^}]*pointer-events: none;/,
    'the ghost never becomes the hit-test');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.platform-rail-pin-ghost \{ transform: translate\(-50%, -50%\); \}\s*\}/,
    'no scale on the ghost when motion is reduced');
});

test('the still-open dot only on the apps kept alive, said aloud; the app on screen lit', () => {
  const src = read(RAIL);
  assert.match(src, /const live = useLiveAppSlugs\(\);/, 'read off the frame store\'s kept frames');
  assert.match(src, /\{running \? <LiveAppDot className="platform-rail-live" \/> : null\}/);
  assert.match(src, /aria-label=\{running \? listText\(\[appName, liveAppLabel\(\)\]\) : appName\}/);
  assert.equal(message('core:liveApp.stillOpen'), 'still open');
  assert.equal(message('core:rail.app'), 'App');
  assert.equal(message('core:rail.appOf', { name: 'Chess' }), 'Chess app');
  assert.match(src, /aria-current=\{onApp === slug \? 'page' : undefined\}/);
  // Nothing before mount: the prerender ships the pinned section with its
  // heading, no rows, and hidden.
  const html = renderComponent(PINNED, 'RailPinned', {});
  assert.equal(html, '<div id="platform-rail-pinned" class="platform-rail-pinned hidden" role="group" aria-labelledby="platform-rail-pinned-label">'
    + '<div class="platform-rail-head"><span id="platform-rail-pinned-label" class="platform-rail-head-label">Pinned</span></div></div>');
  // A closed app shrinks into its App row, and a resumed one grows out of it.
  const motion = read('frontend/src/features/nav/resume-motion.ts');
  assert.match(motion, /doc\.querySelectorAll\('#platform-tabs a\.platform-rail-app\[data-rail-app\]'\)/);
});

test('#3096: an app is lit only while it is the screen on show', () => {
  const { currentAppOnScreen } = loadTsx('frontend/src/features/app-frame/live-apps.tsx');
  const lit = (screen, tab, frameSlug = 'notes') => currentAppOnScreen({ frameSlug, screen, tab });
  assert.equal(lit('app-view', null), 'notes', 'in the app');
  for (const [screen, tab] of [
    ['messages-screen', 'messages'], ['browse-screen', 'discover'], ['workshop-screen', 'workshop'],
    ['profile-screen', 'me'], ['settings-screen', 'me'], ['home-screen', 'home'],
  ]) assert.equal(lit(screen, tab), null, `${screen} lights no app`);
  assert.equal(lit('app-view', 'workshop'), null, 'the app\'s Workshop');
  assert.equal(lit(null, null), null);
  assert.equal(lit('app-view', null, ''), null, 'no frame mounted');
});

test('blocking forgets only that app from Resume and the persisted recent apps', () => {
  const previousWindow = global.window;
  const storage = new Map();
  global.window = { localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } };
  try {
    const { parkedStore } = loadTsx('frontend/src/features/nav/mount.ts');
    const nav = window.UsernodeReact.nav;
    nav.setViewer('ana');
    nav.park({ slug: 'allowed', name: 'Allowed' });
    nav.park({ slug: 'blocked', name: 'Blocked' });
    nav.forget('blocked');
    assert.equal(parkedStore.get().app, null);
    const recents = () => JSON.parse(storage.get('usernode_recent_apps_v1'));
    assert.equal(recents().owner, 'ana');
    assert.deepEqual(recents().apps.map((app) => app.slug), ['allowed']);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('recent apps are remembered per account, and an app appears once, at the front', () => {
  const storage = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  try {
    const mod = loadTsx('frontend/src/features/nav/recent-apps-store.js');
    mod.rememberRecentApp({ slug: 'a', name: 'A' }, 'ana', '2026-09-20T01:00:00Z');
    mod.rememberRecentApp({ slug: 'b', name: 'B' }, 'ana', '2026-09-20T02:00:00Z');
    mod.rememberRecentApp({ slug: 'a', name: 'A' }, 'ana', '2026-09-20T03:00:00Z');
    assert.deepEqual(mod.recentAppsStore.get().apps.map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readRecentApps('ana').map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readRecentApps('bo'), [], 'another account sees none of it');
  } finally {
    delete global.window;
  }
  const mount = read('frontend/src/features/nav/mount.ts');
  assert.match(mount, /if \(app && app\.slug\) rememberRecentApp\(app, navStore\.get\(\)\.viewer\);/);
});

test('#2795, #2798: the peeked strip is the frosted one and fades; a blue hover on the tabs', () => {
  const peek = css.slice(css.indexOf('  .platform-tabs.platform-tabs-peek {'));
  const rule = peek.slice(0, peek.indexOf('}'));
  assert.match(rule, /background-color: var\(--dc-sheet-solid\);/);
  assert.match(rule, /transition: opacity 200ms ease-in;/);
  assert.match(css,
    /@media \(hover: hover\) \{\s*\.platform-tab:not\(\[aria-current="page"\]\):hover \{\s*background: color-mix\(in srgb, var\(--lit-tint\) 55%, transparent\);/);
});

test('the folded Duo\'s corner shifts the bar\'s cells, never its shape (6072)', () => {
  assert.match(css, /html\[data-side-corner="right"\] #platform-tabs \{\s*padding-right: var\(--platform-corner-w, 0px\);/);
  assert.match(css, /html\[data-side-corner="left"\] #platform-tabs \{\s*padding-left: var\(--platform-corner-w, 0px\);/);
  // The corner keeps the phone's five-cell bar: the strip's column layout is
  // keyed on data-side-strip, and the two facts are never set together.
  const at = css.indexOf('THE SIDE CORNER — iPhone Duo');
  const corner = css.slice(at, css.indexOf('/* ── #platform-parked — the app you left', at));
  assert.ok(at > 0 && corner.length > 0, 'the corner block is in app.css');
  assert.doesNotMatch(corner, /data-side-strip/);
  assert.doesNotMatch(corner, /flex-direction: column/);
});
