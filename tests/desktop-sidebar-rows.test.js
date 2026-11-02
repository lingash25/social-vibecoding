'use strict';

// D (18 Oct 2026) — on a desktop, from 768px, the rail is one sidebar of
// rows: Home, Discover and Messages, then your communities under a
// Communities heading (five, then the Communities tab as their "All 13
// communities" row), then Pinned and Recent apps, and you at the foot. The
// header's name is a name there, not the switcher, and All communities has a
// search at its head the heading's hover search opens. v3 (212px, its nested
// rows, All communities as one page) is ./desktop-sidebar-nested.test.js.
//
// What is pinned, each a way it could quietly go back:
//
//   1. WHICH FIVE: this device's order, a community opened from outside it
//      coming in at the top, a listed one never moving, only yours listed.
//   2. THE MARKUP: the section between Messages and the Communities tab, its
//      heading and search in the prerender and no rows; the All row's face.
//   3. THE PRESSES: a row switches in place; the lit one climbs its page and
//      stops at its Hub; the search asks the screen to focus its box.
//   4. THE WIDTH: one 768px block in app.css, after the rail's own; the
//      phone's bar untouched below it, the header's switcher there too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const RAIL = 'frontend/src/features/nav/rail-communities.tsx';

test('which five: this device\'s order, then the most recently active of yours', () => {
  const { railCommunities, noteOpened, RAIL_COMMUNITIES } = loadTsx(RAIL);
  assert.equal(RAIL_COMMUNITIES, 5);
  const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(railCommunities([], null), [], 'nothing before the list is read');
  assert.deepEqual(railCommunities([], list), ['a', 'b', 'c', 'd', 'e'], 'the most recently active, to begin with');
  assert.deepEqual(railCommunities(['f', 'x', 'b'], list), ['f', 'b', 'a', 'c', 'd'],
    'the kept order first, less a community you left (x), then the rest');
  // Opening one from outside the five brings it in at the top; the last goes.
  assert.deepEqual(noteOpened(['a', 'b', 'c', 'd', 'e'], 'g', list), ['g', 'a', 'b', 'c', 'd']);
  // Unless its app is still running: then the last one whose app is not.
  assert.deepEqual(noteOpened(['a', 'b', 'c', 'd', 'e'], 'g', list, 5, ['e']), ['g', 'a', 'b', 'c', 'e']);
  assert.deepEqual(noteOpened(['a', 'b', 'c', 'd', 'e'], 'g', list, 5, ['d', 'e', 'c']), ['g', 'a', 'c', 'd', 'e']);
  assert.deepEqual(noteOpened(['a', 'b'], 'g', list, 5, ['a', 'b']), ['g', 'a', 'b'], 'room for it, nothing goes');
  // A listed one keeps its row, so nothing moves under the pointer.
  assert.equal(noteOpened(['a', 'b', 'c', 'd', 'e'], 'c', list), null);
  // A page you are only visiting is not one of yours.
  assert.equal(noteOpened(['a', 'b'], 'stranger', list), null);
  assert.equal(noteOpened(['a', 'b'], null, list), null);
});

test('the markup: the section sits between Home and the Communities tab, its heading and search prerendered', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  const at = (id) => html.indexOf(`id="${id}"`);
  // #6019: Communities is the second tab now, so its rows follow Home.
  assert.ok(at('platform-tab-home') < at('platform-rail-pinned'), 'the pinned ones first');
  assert.ok(at('platform-rail-pinned') < at('platform-rail-communities'));
  assert.ok(at('platform-rail-communities') < at('platform-tab-workshop'));
  assert.match(html, /<div id="platform-rail-communities" class="platform-rail-communities" role="group" aria-labelledby="platform-rail-communities-label">/);
  assert.match(html, new RegExp(`<span id="platform-rail-communities-label" class="platform-rail-head-label">${message('core:rail.communities')}</span>`));
  assert.match(html, new RegExp(`<a id="platform-rail-search" class="platform-rail-search" href="#communities" aria-label="${message('core:rail.search')}"`));
  assert.doesNotMatch(html, /data-rail-community=/, 'no rows before the community list is read');
  // The All row's face rides in the Communities tab, for app.css to show.
  const tab = html.slice(at('platform-tab-workshop'), html.indexOf('</a>', at('platform-tab-workshop')));
  assert.match(tab, /class="platform-tab-glyph platform-tab-all-glyph"/);
  assert.match(tab, new RegExp(`<span class="platform-tab-all-label">${message('core:rail.allPlain')}</span>`), 'before the count is known');
  assert.doesNotMatch(tab, /platform-tab-all-votes/, 'a zero says nothing');
  // The tab keeps no label of its own on All communities, as before.
  assert.doesNotMatch(tab.slice(0, tab.indexOf('>')), /aria-label=/);
});

test('the presses: a row switches in place, the lit one climbs to its Hub and stops', () => {
  const src = read(RAIL);
  // From its app, the row goes to its page; on its page, up the page.
  // A press is a place switch, a cut like the tabs (pressPlace, 1 Nov 2026).
  assert.match(src, /if \(onPage === slug\) pressLitTab\(screen, \{ stopAtCommunity: true \}\);\s*else pressPlace\(\(\) => goToCommunity\(slug\)\);/);
  assert.match(src, /const href = `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop`;[\s\S]*?href=\{href\}/, 'a modified click opens its page');
  assert.match(src, /onPage: screen === 'app-view' && tab === 'workshop' \? scoped : null,/);
  // The ladder's root step is All communities; the row stops short of it.
  const calls = [];
  const mod = loadTsx('frontend/src/features/workshop/tab-ladder.ts', {
    stubs: { './community-scope': { goToCommunity: (slug) => calls.push(slug) } },
  });
  const had = { window: global.window, document: global.document };
  global.window = {
    App: { currentApp: 'notes' },
    AppView: { _onProjectPage: () => true },
    location: { hash: '' },
    PlatformUI: { scrollElement: (el) => el },
    matchMedia: () => ({ matches: false }),
  };
  global.document = { getElementById: () => null };
  try {
    assert.equal(mod.pressLitTab('app-view', { stopAtCommunity: true }), 'none');
    assert.deepEqual(calls, [], 'never All communities');
    assert.equal(mod.pressLitTab('app-view'), 'root', 'the tab itself still goes there');
    assert.deepEqual(calls, [null]);
  } finally {
    global.window = had.window;
    global.document = had.document;
  }
});

test('the search: All communities, with its box focused and lit once it shows', () => {
  const calls = [];
  const search = loadTsx('frontend/src/features/workshop/communities-search.ts', {
    stubs: { './community-scope': { goToCommunity: (slug) => calls.push(slug) } },
  });
  assert.equal(search.communitiesSearchStore.get().asked, 0);
  search.openCommunitiesSearch();
  search.openCommunitiesSearch();
  assert.equal(search.communitiesSearchStore.get().asked, 2, 'each press is a new request');
  assert.deepEqual(calls, [null, null]);
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /if \(!state\.open \|\| !wide \|\| asked <= answered\.current\) return undefined;/, 'answered once, on the open screen');
  assert.match(screen, /input\.focus\(\{ preventScroll: true \}\);/);
  assert.match(screen, /onBlur=\{\(\) => setLit\(false\)\}/, 'lit until focus leaves');
  assert.match(screen, /placeholder=\{t\('communities:drawer\.search\.placeholder'\)\}/, 'the drawer\'s words');
  assert.match(screen, /\{state\.tab === 'needs' \? \(/, 'v3: Needs you is its own page, not beside the list');
  assert.match(screen, /if \(state\.tab !== 'status'\) workshopController\.setTab\('status'\);/, 'the search is at the list\'s head');
});

test('the width: one block on every desktop window, from 768px; the phone\'s bar and the header\'s switcher below it', () => {
  const { SIDEBAR_ROWS_QUERY } = loadTsx('frontend/src/features/nav/sidebar-rows.ts');
  // It began at 1024px, but the strip and its column below that were 340px
  // where the sidebar holding the same things is 212px.
  assert.equal(SIDEBAR_ROWS_QUERY, '(min-width: 768px)');
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-communities,\n\.platform-rail-conversations,\n\.platform-tab-all-glyph,\n\.platform-tab-all-label,\n\.platform-tab-all-votes,\n\.platform-rail-pinned \{\n  display: none;\n\}/,
    'nothing of it is drawn outside the block');
  const at = css.indexOf('@media (min-width: 768px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  assert.ok(at > 0, 'the block');
  // After the rail's own 768px block, so at the same width it wins.
  assert.ok(at > css.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY ENTIRELY.'), 'after the rail\'s block');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(block, /body \{\n    --platform-rail-full: 212px;\n  \}/, 'the token everything placed by the strip reads');
  assert.match(block, /\.platform-rail-communities:hover \.platform-rail-search,\n  \.platform-rail-communities:has\(\+ #platform-tab-workshop:hover\) \.platform-rail-search,\n  \.platform-rail-search:focus-visible \{\n    opacity: 1;/,
    'the search shows over the section and All');
  assert.match(block, /@media \(hover: none\) \{\n    \.platform-rail-search \{ opacity: 1; \}/, 'and stays where there is no hover');
  assert.match(block, /\.platform-tabs:has\(\.platform-rail-community\[aria-current="page"\]\) #platform-tab-workshop\[aria-current="page"\] \{/,
    'a community\'s own row is lit on its page, not All');
  // The header's name: the switcher on a phone, a name beside the sidebar.
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.match(header, /const appSwitch = communityPage && !sidebarRows;/);
  assert.match(header, /const allAppsSwitcher = screen === 'workshop-screen' && !sidebarRows;/);
  // The tab's own name follows what it shows.
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /\? \(sidebarRows \? undefined : communitiesAriaLabel\(scoped, votes\)\)/);
  // v3: there is no section column beside the sidebar, which nests the
  // places; since the strip went, there is none at all.
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/nav/section-column.tsx')), 'the column is gone');
  assert.doesNotMatch(read('frontend/src/Shell.tsx'), /SectionColumn|platform-section-column/);
});

test('the apps: none apart from their communities; Pinned, above them, only while something is pinned', () => {
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.doesNotMatch(bar, /StripApps/, 'no Pinned and Recent apps sections');
  const src = read('frontend/src/features/nav/rail-pinned.tsx');
  assert.match(src, /<span id="platform-rail-pinned-label" className="platform-rail-head-label">\{t\('core:rail\.pinned'\)\}<\/span>/);
  assert.match(src, /useHiddenClass\(ref, items\.length === 0 && !drop\);/);
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-pinned:not\(\.hidden\) \{\n    display: flex;/, 'drawn in the block once shown');
  assert.equal(message('core:rail.pinned'), 'Pinned');
});

test('#6025: the community rows drag onto My apps while Home is on show', () => {
  const mod = loadTsx(RAIL);
  assert.equal(mod.RAIL_DRAG_ITEMS, '.platform-rail-community[data-rail-community]',
    'the rows, not their App line or the places under them');

  // A rendered row carries the slug the recognizer reads, and its open tag is
  // unchanged: the browser's own link drag, which would otherwise take the
  // pointer, is refused on the node (a ref) rather than as an attribute.
  const html = renderComponent(RAIL, 'RailCommunityRow', {
    slug: 'block-game',
    here: { sidebarRows: true, screen: 'home-screen', onPage: null, onApp: null, live: [] },
  });
  assert.match(html, /data-rail-community="block-game"/);
  assert.doesNotMatch(html, /draggable/, 'no attribute on the row');

  const src = read(RAIL);
  assert.match(src, /const dragToHome = !pin && sidebarRows && screen === 'home-screen';/,
    'a section row, and only while Home is on show');
  assert.match(src, /ref=\{\(el\) => \{\n {10}if \(el\) el\.draggable = !dragToHome;/,
    'the node refuses the link drag while the row can be dragged onto My apps');
  assert.match(src, /const onHome = here\.sidebarRows && here\.screen === 'home-screen';/,
    'only while the sidebar holds and Home is the screen on show');
  assert.match(src, /ref=\{railRef\}/, 'the section the recognizer attaches to');
  assert.match(src, /_attachDiscoverPlacement\?\.\(el, \{ itemSelector: RAIL_DRAG_ITEMS \}\)/);
  assert.match(src, /return Home\?\._attachDiscoverPlacement\?\.\([^)]*\) \|\| undefined;/,
    'leaving Home, or dropping below 768px, hands the detach back');
  const section = src.slice(src.indexOf('export function RailCommunities'));
  assert.match(section, /id="platform-rail-communities"/);
  assert.doesNotMatch(section, /platform-rail-pinned[\s\S]*_attachDiscoverPlacement/,
    'a pinned row keeps its own drag-out to unpin');

  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-community\.un-reorder-ghost \{\n    background: var\(--bg-primary\);\n    border-radius: 10px;\n  \}/,
    'the floating copy is solid, so it reads over the grid');
});
