'use strict';

// THE PHONE'S NAVIGATION DRAWER (Evan's design, 18 Oct 2026).
//
// Under 768px, under the Communities tab, a community's page is the deepest
// of three levels on one strip: your communities at 85%, the community's
// places at 80%, then the page. The header's arrow and the lit tab go up a
// level, a press on what peeks in goes to it, and the strip follows a
// finger, landing a quarter of the way into a level. The header moves with
// it: the community's colour blends in with depth, the arrow arrives from
// the right, titles drift the drawer's way, and from the places to a page
// only the page's name slides in. Desktop is untouched.
//
// These pin the numbers (drawer-math.ts), the store's moves and its Back
// record (drawer-store.ts), when the drawer applies and what it ships in
// the prerender (nav-drawer.tsx), and the seams it takes over: the header's
// arrow and title, the lit tab, the tray's edge swipe and the CSS.
//
// Run with: node --test tests/nav-drawer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DIR = 'frontend/src/features/nav-drawer';

const math = loadTsx(`${DIR}/drawer-math.ts`);

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≉ ${b}`);

test('the strip: 85% for your communities, 80% for the places, then the page', () => {
  assert.equal(math.OUTER_SHARE, 0.85);
  assert.equal(math.PLACES_SHARE, 0.8);
  assert.deepEqual([...math.LEVEL_AT], [0, 0.85, 1.65]);
  near(math.offsetAt(0), 0, 'level 0');
  near(math.offsetAt(1), 0.85, 'level 1');
  near(math.offsetAt(2), 1.65, 'level 2');
  near(math.offsetAt(0.5), 0.425, 'halfway to the places');
  near(math.offsetAt(1.5), 1.25, 'halfway to the page');
  for (const f of [0, 0.2, 0.5, 0.99, 1, 1.3, 1.75, 2]) near(math.depthAt(math.offsetAt(f)), f, `round trip at ${f}`);
  assert.equal(math.clampDepth(-1), 0);
  assert.equal(math.clampDepth(7), 2);
  assert.equal(math.clampDepth(NaN), 2, 'nonsense rests on the page');
});

test('a pan lands past a quarter of the way into a level, in the way the finger went', () => {
  const { landing, LEVEL_AT } = math;
  // From the places toward the page: a quarter of 0.8 is 0.2.
  assert.equal(landing(1, LEVEL_AT[1] + 0.19, -1), 1, 'short of a quarter: back where it was');
  assert.equal(landing(1, LEVEL_AT[1] + 0.21, -1), 2, 'past it: the page');
  // From the places toward your communities: a quarter of 0.85.
  assert.equal(landing(1, LEVEL_AT[1] - 0.2, 1), 1);
  assert.equal(landing(1, LEVEL_AT[1] - 0.22, 1), 0);
  // From the page at the edge, all the way across the places and a quarter more.
  assert.equal(landing(2, LEVEL_AT[2] - 0.21, 1), 1);
  assert.equal(landing(2, LEVEL_AT[1] - 0.22, 1), 0, 'a long pan goes two levels');
  assert.equal(landing(0, 0.1, 0), 0, 'no movement, no move');
  assert.equal(math.isPan(9, 2), true);
  assert.equal(math.isPan(7, 0), false, 'within the slop');
  assert.equal(math.isPan(12, 12), false, 'as much down as across is a scroll');
});

test('the header at a depth: colour, arrow, and the titles moving the drawer\'s way', () => {
  const slot = 44;
  const at0 = math.headerFrame(0, slot);
  assert.equal(at0.tint, 0, 'untinted on your communities');
  assert.equal(at0.back.opacity, 0, 'no arrow on the outermost level');
  assert.equal(at0.back.live, false);
  assert.equal(at0.back.x, 8, 'it waits 8px to the right');
  assert.deepEqual(at0.outer, { opacity: 1, x: -slot, y: 7 }, '"Communities" where the arrow is not');
  assert.equal(at0.inner.opacity, 0);
  assert.equal(at0.inner.x, 24, 'the name waits 24px to the right');

  const half = math.headerFrame(0.5, slot);
  assert.equal(half.tint, 0.5);
  assert.equal(half.outer.opacity, 0.5);
  assert.equal(half.outer.x, -slot - 6, 'going in, "Communities" drifts left');
  assert.equal(half.inner.x, 12, 'and the name arrives from the right');
  assert.equal(half.back.x, 4);

  const at1 = math.headerFrame(1, slot);
  assert.equal(at1.tint, 1);
  assert.equal(at1.back.opacity, 1);
  assert.equal(at1.back.live, true);
  assert.equal(at1.outer.opacity, 0);
  assert.deepEqual(at1.inner, { opacity: 1, x: 0, y: 7, subOpacity: 0, subX: 24, subY: -7 }, 'the name alone, centred');

  const mid = math.headerFrame(1.5, slot);
  assert.equal(mid.inner.x, 0, 'the name stays put');
  assert.equal(mid.inner.y, 3.5, 'rising to make room');
  assert.equal(mid.inner.subX, 12, 'the page slides in from the right');
  assert.equal(mid.inner.y + mid.inner.subY, 0, 'and cancels the rise, so it travels level');

  const at2 = math.headerFrame(2, slot);
  assert.deepEqual(at2.inner, { opacity: 1, x: 0, y: 0, subOpacity: math.SUB_OPACITY, subX: 0, subY: 0 });

  const calm = math.headerFrame(0.5, slot, true);
  assert.equal(calm.outer.x, -slot, 'Reduce Motion: crossfades in place');
  assert.equal(calm.inner.x, 0);
  assert.equal(calm.back.x, 0);
  assert.equal(calm.outer.opacity, 0.5, 'the fades stay');
});

test('another community keeps the place you were on when it has it, else its Hub', () => {
  const { keepPlace } = math;
  for (const p of ['status', 'needs', 'workshop', 'discussion']) assert.equal(keepPlace(p, null), p, `${p} is everywhere`);
  assert.equal(keepPlace('all', null), 'workshop', 'All items is under the Workshop');
  assert.equal(keepPlace('bot', null), 'workshop');
  assert.equal(keepPlace('plan', null), 'status', 'the plan is under the Hub');
  assert.equal(keepPlace('c:onboarding', ['onboarding', 'infra']), 'c:onboarding');
  assert.equal(keepPlace('c:onboarding', ['infra']), 'status', 'a topic it does not have');
  assert.equal(keepPlace('c:onboarding', null), 'status', 'or not known to have');
  assert.equal(keepPlace(undefined, null), 'status');
});

test('the store: one level at a time, the search first, nothing while it does not apply', () => {
  const store = loadTsx(`${DIR}/drawer-store.ts`);
  const placed = [];
  store.registerSurface({ place: (level, cut) => placed.push([level, cut]), outerList: () => null });
  store.go(1);
  assert.equal(store.drawerStore.get().level, 2, 'off: go does nothing');
  assert.equal(store.pressTab(), 'none');
  store.setOn(true);
  assert.equal(store.drawerStore.get().on, true);
  store.go(1, { cut: true });
  assert.equal(store.drawerStore.get().level, 1);
  assert.deepEqual(placed.at(-1), [1, true]);
  assert.equal(store.liveDepth(), 1, 'a cut puts the header there at once');
  store.back();
  assert.equal(store.drawerStore.get().level, 0, 'the arrow: up one level');
  store.setSearching(true);
  store.back();
  assert.equal(store.drawerStore.get().searching, false, 'a widened search narrows first');
  assert.equal(store.drawerStore.get().level, 0, 'and the strip has not moved');
  store.setSearching(true);
  assert.equal(store.drawerStore.get().searching, true);
  assert.equal(store.pressTab(), 'up', 'the lit tab narrows a widened search first');
  assert.equal(store.drawerStore.get().searching, false);
  assert.equal(store.drawerStore.get().level, 0);
  assert.equal(store.pressTab(), 'none', 'the outermost level has nowhere up to go');
  store.back();
  assert.equal(store.drawerStore.get().level, 0, 'nor has its arrow: your communities are the tab\'s top level');
  // #5611's settle: whatever a slide did, the header rests on the level's frame.
  store.go(2, { cut: true });
  store.setDepth(0);
  store.setMoving(true);
  store.setMoving(false);
  assert.equal(store.liveDepth(), 2, 'settling puts the header on the frame it rests at, whatever the slide did');
  store.go(2, { cut: true });
  assert.equal(store.pressTab(), 'up');
  assert.equal(store.drawerStore.get().level, 1, 'the page to its places');
  assert.equal(store.pressTab(), 'up');
  assert.equal(store.drawerStore.get().level, 0, 'the places to your communities');
  store.setSearching(true);
  store.go(1, { cut: true });
  assert.equal(store.drawerStore.get().searching, false, 'leaving level 0 ends the search');
  store.setSearching(true);
  assert.equal(store.drawerStore.get().searching, false, 'and it only widens level 0');
  store.setOn(false);
  assert.deepEqual(
    { ...store.drawerStore.get(), shown: undefined },
    { on: false, level: 2, searching: false, moving: false, pending: null, shown: undefined },
    'turned off, it starts again on the page',
  );
  assert.equal(store.liveDepth(), 2);
});

test('#5581: asked for the list, the drawer opens on your communities, not the page', () => {
  const store = loadTsx(`${DIR}/drawer-store.ts`);
  let recorded = 0;
  store.setBackRecords((close) => { recorded += 1; return () => {}; });
  store.requestOuter();
  store.setOn(true);
  assert.equal(store.drawerStore.get().level, 0, 'the list, as a sidebar');
  assert.equal(store.liveDepth(), 0, 'and the header is drawn for it at once');
  assert.equal(recorded, 1, 'and Back returns to the page it was opened over');
  store.setOn(false);
  store.setOn(true);
  assert.equal(store.drawerStore.get().level, 2, 'the request was spent: the next open is the page');
  // A request whose page never came does not outlive its moment.
  store.setOn(false);
  const now = Date.now;
  Date.now = () => 5_000;
  store.requestOuter();
  Date.now = () => 5_000 + 10_001;
  store.setOn(true);
  Date.now = now;
  assert.equal(store.drawerStore.get().level, 2, 'stale: ignored');
});

test('while it is off the page it holds a Back record, and a navigating press leaves it', () => {
  const src = read(`${DIR}/drawer-store.ts`);
  assert.match(src, /if \(level < 2\) holdBack\(\);\s*else if \(!opts\.viaBack\) letGoBack\(!!opts\.navigating\);/);
  assert.match(src, /release = pushRecord\(\(\) => \{\s*release = null;\s*go\(2, \{ viaBack: true \}\);\s*return true;\s*\}\);/,
    'Back returns to the page');
  assert.doesNotMatch(src, /lib\/back-stack'/, 'the store loads without a window: the island hands the push over');
  assert.match(read(`${DIR}/nav-drawer.tsx`), /setBackRecords\(\(close\) => pushDismissible\(close\)\);/);
  assert.match(src, /r\?\.\(navigating \? \{ navigating: true \} : undefined\);/);
  const island = read(`${DIR}/nav-drawer.tsx`);
  assert.match(island, /letGoBack\(true\);\s*openPlace\(slug, key\);\s*go\(2, \{ navigating: true \}\);/,
    'a place is a navigating press');
  assert.match(island, /letGoBack\(true\);\s*try \{ w\.AppView\?\._landOnTab\?\.\(row\.slug, keep\); \}[^\n]*\n\s*void w\.App\?\.navigateToApp\?\.\(row\.slug, 'dev'\);/,
    'so is another community, which opens on the place kept');
});

test('it applies on a phone, on a community\'s own page, and through a switch', () => {
  const { drawerApplies, NavDrawer } = loadTsx(`${DIR}/nav-drawer.tsx`);
  const page = { phone: true, screen: 'app-view', slug: 'notes', tab: 'dev', subTab: 'forum', viewMode: 'workshop', pending: false };
  assert.equal(drawerApplies(page), true);
  assert.equal(drawerApplies({ ...page, phone: false }), false, 'never at 768px and up');
  assert.equal(drawerApplies({ ...page, screen: 'messages-screen' }), false, 'another tab');
  assert.equal(drawerApplies({ ...page, tab: 'app' }), false, 'the running app');
  // Polish #23: an item opened from the community's pages keeps the drawer's
  // header and its swipe back; one opened from a conversation does not.
  assert.equal(drawerApplies({ ...page, subTab: 'topic' }), true, 'a card opened from the page (a deep link too)');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#app/notes/workshop' }), true);
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#messages/12' }), false, 'a card opened from Messages');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#homeroom-bot' }), false,
    'a thread opened from the Homeroom bot tab\'s page, which goes back there');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', viewMode: 'kanban' }), false, 'a card under the Kanban board');
  assert.equal(drawerApplies({ ...page, subTab: 'sessions' }), false, 'a change\'s own session');
  assert.equal(drawerApplies({ ...page, viewMode: 'kanban' }), false, 'the Kanban board');
  assert.equal(drawerApplies({ ...page, slug: null, tab: 'app', subTab: null, pending: true }), true,
    'a community picked on level 0, while the header\'s record is cleared for its load');
  assert.equal(renderToHtml(createElement(NavDrawer)), '', 'nothing in the prerender');
});

test('level 0 searches your communities by name, in the list\'s order, an exact name first (#5472)', () => {
  const { matchCommunities } = loadTsx(`${DIR}/outer-level.tsx`);
  const rows = [
    { slug: 'a', name: 'Type Racer Battle', working: 0, needs: 0 },
    { slug: 'b', name: 'Bay Area Restaurants', working: 0, needs: 0 },
    { slug: 'c-x', working: 0, needs: 0 },
  ];
  assert.deepEqual(matchCommunities(rows, '  bay ').map((r) => r.slug), ['b']);
  assert.deepEqual(matchCommunities(rows, 'A').map((r) => r.slug), ['a', 'b'], 'any case');
  assert.deepEqual(matchCommunities(rows, 'c-x').map((r) => r.slug), ['c-x'], 'a row with no name by its slug');
  assert.equal(matchCommunities(rows, '').length, 3);
  const gardens = [
    { slug: 'garden-swap', name: 'Garden Swap', working: 0, needs: 0 },
    { slug: 'garden', name: 'Garden', working: 0, needs: 0 },
  ];
  assert.deepEqual(matchCommunities(gardens, 'garden').map((r) => r.slug), ['garden', 'garden-swap'], 'the exact name leads');
  assert.deepEqual(matchCommunities(gardens, 'arden').map((r) => r.slug), ['garden-swap', 'garden'], 'a partial-only query keeps the list order');
  // The Communities screen's search (frontend/src/features/workshop/index.tsx)
  // shares the one rule: its one list (#5296) is narrowed with matchRows
  // too, from ./sections, where the drawer also reads it (importing the
  // screen back would be a cycle).
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /return matchRows\(inAudience, query\);/);
});

test('#5581: level 0 is one list under the page\'s audience chips, with no sections', async () => {
  const mod = loadTsx(`${DIR}/outer-level.tsx`);
  // The two reads the level asks for: three member apps, one per audience,
  // and counts that say nothing (so no Needs you row stands in the way).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/workshop/counts')) {
      return { ok: true, json: async () => ({ counts: {} }) };
    }
    return {
      ok: true,
      json: async () => ({
        apps: [
          { slug: 'solo-row', name: 'Just mine', audience: 'solo', is_member: true, last_active_at: '2026-10-16T12:00:00Z' },
          { slug: 'priv-row', name: 'Private one', audience: 'invited', is_member: true, member_count: 7, last_active_at: '2026-10-17T12:00:00Z' },
          { slug: 'pub-row', name: 'Public one', audience: 'open', is_member: true, member_count: 12, last_active_at: '2026-10-18T12:00:00Z' },
        ],
      }),
    };
  };
  const hadWindow = typeof globalThis.window !== 'undefined';
  if (!hadWindow) globalThis.window = {};
  try {
    await mod.readCommunities();
  } finally {
    globalThis.fetch = realFetch;
    if (!hadWindow) delete globalThis.window;
  }
  const html = renderToHtml(createElement(mod.OuterLevel, { current: null, searching: false, wanted: false, onPick() {}, listRef: null }));
  assert.doesNotMatch(html, /data-workshop-section=/, 'no sections in the drawer');
  assert.doesNotMatch(html, /data-workshop-more=/, 'and no "Show N more"');
  assert.deepEqual(
    [...html.matchAll(/data-nav-drawer-chip="([^"]+)"/g)].map((m) => m[1]),
    ['all', 'open', 'invited', 'solo'],
    'the page\'s chips, in the page\'s order',
  );
  assert.match(html, /aria-pressed="true"[^>]*data-nav-drawer-chip="all"|data-nav-drawer-chip="all"[^>]*aria-pressed="true"/,
    'All pressed on arrival');
  assert.match(html, /aria-label="All, 3 communities"/, 'each chip carries its count');
  const cards = [...html.matchAll(/data-nav-drawer-rows="([^"]*)"/g)];
  assert.equal(cards.length, 1, 'one card of rows');
  assert.equal(cards[0][1], 'all', 'and it says which chip it shows');
  const rest = html.slice(cards[0].index);
  assert.deepEqual(
    [...rest.matchAll(/data-workshop-app="([^"]+)"/g)].map((m) => m[1]),
    ['pub-row', 'priv-row', 'solo-row'],
    'every community in the one list, most recent first',
  );
  // And the source no longer names the sectioned drawing.
  assert.doesNotMatch(read(`${DIR}/outer-level.tsx`), /groupRows|<Section\b/);
});

// #5821: under the Needs you card the chips touched it. The drawer's list
// gets the same twelve the Communities screen keeps (section + .workshop-search),
// from the card's section to the chip row and only then.
test('#5821: the chips sit a 12px gap under the Needs you card', async () => {
  const mod = loadTsx(`${DIR}/outer-level.tsx`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/workshop/counts')) {
      return { ok: true, json: async () => ({ counts: { owed: { needs: 2, owed: ['a', 'b'] } } }) };
    }
    return {
      ok: true,
      json: async () => ({
        apps: [{ slug: 'owed', name: 'Owed one', audience: 'open', is_member: true, last_active_at: '2026-10-18T12:00:00Z' }],
      }),
    };
  };
  const hadWindow = typeof globalThis.window !== 'undefined';
  if (!hadWindow) globalThis.window = {};
  try {
    await mod.readCommunities();
  } finally {
    globalThis.fetch = realFetch;
    if (!hadWindow) delete globalThis.window;
  }
  const html = renderToHtml(createElement(mod.OuterLevel, { current: null, searching: false, wanted: false, onPick() {}, listRef: null }));
  // The section heads the chip row: the rule's selector needs them adjacent.
  assert.match(html, /<\/section><div[^>]*class="[^"]*\baudience-chips\b/,
    'the Needs you section is the chips\' previous sibling');
  const css = read('public/css/app.css');
  assert.match(css, /\.nav-drawer-outer-list section \+ \.audience-chips \{\s*margin-top: 12px;/,
    'twelve under the card, as the Communities screen keeps');
});

test('the header takes the drawer\'s arrow and titles only while it applies', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.match(header, /<HeaderPlace slug=\{backSlug\} name=\{appName \|\| ''\} \/>[\s\S]*?<DrawerBack \/>\s*<\/div>/,
    'the arrow in the places button\'s seat');
  assert.match(header, /-mb-2'\}\s*>\s*\{\/\*[\s\S]*?\*\/\}\s*<DrawerUntint \/>/, 'the untinted bar, first in the header');
  const title = read('frontend/src/features/header/header-title.tsx');
  assert.match(title, /const drawerOn = useDrawerMode\(\) !== null;/, 'either drawer, Communities\' or Messages\'');
  assert.match(title, /\{drawerOn \? <DrawerTitles \/> : \(/);
  const bar = read('frontend/src/features/dev-board/workshop/place-bar.tsx');
  assert.match(bar, /if \(drawerOn\) return null;\s*if \(!phone \|\| !slug \|\| mounted !== slug \|\| screen !== 'app-view'\) return null;/,
    'no places button while the drawer holds the places');
  const drawer = read(`${DIR}/header-drawer.tsx`);
  assert.match(drawer, /<button ref=\{ref\} type="button"/, 'a button: an href\'d arrow would turn on WebKit\'s history swipe');
  assert.doesNotMatch(drawer, /href=/);
  // Off, none of it renders: the prerendered header is untouched.
  const ui = loadTsx(`${DIR}/header-drawer.tsx`);
  assert.equal(renderToHtml(createElement(ui.DrawerBack)), '');
  assert.equal(renderToHtml(createElement(ui.DrawerUntint)), '');
  assert.equal(ui.pageLabel('c:onboarding'), '#onboarding');
  assert.equal(ui.pageLabel('discussion'), '#general');
  assert.equal(ui.pageLabel('workshop'), 'Workshop');
  assert.equal(ui.pageLabel('status'), 'Hub');
});

// Your communities are the Communities tab's top level, so they have no back
// arrow, as Messages' list has none (#5611 gave them one; it is gone again).
// The arrow there is out of reach, so focus that pressed it on the places
// moves onto the community you are on in the list.
test('your communities have no back arrow; the places and the page keep theirs', () => {
  const drawer = read(`${DIR}/header-drawer.tsx`);
  assert.match(drawer, /label=\{level === 2 \? t\('core:header\.drawer\.toPlaces', \{ community: shown\.name \}\) : t\('core:header\.drawer\.toCommunities'\)\}/,
    'the page: to the places; the places: to your communities');
  assert.doesNotMatch(drawer, /t\('core:header\.back'\)/, 'no label for an arrow on your communities');
  const island = read(`${DIR}/nav-drawer.tsx`);
  assert.match(island, /if \(level !== 0\) return;[\s\S]{0,200}matches\?\.\('\[data-nav-drawer-back\]'\)/,
    'focus leaves the arrow when it goes out of reach');
  assert.equal(math.headerFrame(0, 44).back.opacity, 0);
  assert.equal(math.headerFrame(0, 44).back.live, false);
});

test('the lit tab and the left edge are the drawer\'s on a phone; the tray keeps the wide window', () => {
  const ladder = read('frontend/src/features/workshop/tab-ladder.ts');
  assert.match(ladder, /if \(drawerStore\.get\(\)\.on\) \{[\s\S]*?return pressDrawerTab\(\);\s*\}/);
  assert.match(ladder, /const PAGES_UNDER_A_PLACE = \['all', 'bot', 'plan'\];/, 'a page under a place goes to it first');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /useEdgeSwipe\(!placesInColumn && !drawerOn && !trayOpen && !!v\.slug && !v\.loading,/);
  const island = read(`${DIR}/nav-drawer.tsx`);
  assert.match(island, /const takesEdge = pageTakesEdge\(\);/, 'not the edge in Safari on an iPhone, where it is Back');
  assert.match(island, /if \(!swipeBackMayStart\(\{ x: touch\.clientX, takesEdge, sideways, rtl, width: window\.innerWidth \}\)\) return;/,
    'a swipe toward the page from anywhere on it that is not sideways UI (tests/nav-drawer-swipe.test.js)');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="PlatformTabs"><PlatformTabs \/><\/Island>\s*\{\/\*[\s\S]*?\*\/\}\s*<Island name="NavDrawer"><NavDrawer \/><\/Island>/);
});

test('it moves by transform only, and leaves #app-view untransformed at rest', () => {
  const island = read(`${DIR}/nav-drawer.tsx`);
  assert.match(island, /const restPage = \(\) => \{[\s\S]*?page\.style\.transition = '';\s*page\.style\.transform = '';/,
    'not translate(0): a transformed ancestor re-anchors fixed descendants');
  assert.match(island, /afterSlideStarts\(\(\) => \{/, 'a switch routes after the slide has started');
  // A gesture surface, not a page slide (tests/phone-no-page-slides.test.js).
  for (const file of ['nav-drawer.tsx', 'drawer-store.ts', 'header-drawer.tsx', 'outer-level.tsx']) {
    assert.doesNotMatch(read(`${DIR}/${file}`), /PlatformUI\.transition\(/, file);
  }
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('/* ── THE PHONE\'S NAVIGATION DRAWER'), css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .nav-drawer-places { transition: none; }'));
  assert.ok(block.length > 1000, 'the drawer\'s CSS block');
  const transitions = block.match(/transition:[^;]+;/g) || [];
  assert.deepEqual(transitions, ['transition: transform 300ms cubic-bezier(0.33, 1, 0.68, 1);'], 'transform only');
  assert.doesNotMatch(block, /transition-delay/);
  assert.match(block, /\.nav-drawer \{\s*position: fixed;[^}]*top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\)\);\s*bottom: var\(--platform-tabs-h, 0px\);/,
    'between the header\'s foot and the tab bar');
  assert.match(block, /@media \(max-width: 767\.98px\) \{\s*html\[data-nav-drawer\] body \{/, 'the header\'s rules are the phone\'s');
  assert.match(block, /color-mix\(in srgb, #fff calc\(var\(--nav-k, 1\) \* 100%\), var\(--nav-brand-ink\)\)/, 'the ink follows the depth');
  assert.match(css, /\.platform-header-left:has\(> #back-btn\.hidden\):not\(:has\(> \.header-places-btn\)\):not\(:has\(> \.nav-drawer-back\)\) \{\s*display: none;/,
    'the left group stays for the arrow');
});

test('its words are catalog entries', () => {
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  const communities = JSON.parse(read('frontend/locales/en/communities.json'));
  for (const key of ['header.drawer.toCommunities', 'header.drawer.toPlaces']) assert.ok(core[key] && core[key].description, key);
  for (const key of ['drawer.outer.name', 'drawer.places.name', 'drawer.peek.page', 'drawer.search.placeholder',
    'drawer.search.label', 'drawer.search.cancel', 'drawer.search.none']) {
    assert.ok(communities[key] && communities[key].description, key);
  }
});

// ── Messages on the same drawer ────────────────────────────────────────

test('Messages\' strip: the list at 85%, then the conversation; a quarter of the way lands', () => {
  const { MESSAGES_AT, offsetIn, depthIn, landingIn } = math;
  assert.deepEqual([...MESSAGES_AT], [0, 0.85]);
  near(offsetIn(MESSAGES_AT, 0.5), 0.425, 'halfway');
  near(depthIn(MESSAGES_AT, 0.85), 1, 'the conversation');
  for (const f of [0, 0.3, 1]) near(depthIn(MESSAGES_AT, offsetIn(MESSAGES_AT, f)), f, `round trip at ${f}`);
  assert.equal(landingIn(MESSAGES_AT, 0, 0.2, -1), 0, 'short of a quarter of 0.85');
  assert.equal(landingIn(MESSAGES_AT, 0, 0.22, -1), 1);
  assert.equal(landingIn(MESSAGES_AT, 1, 0.63, 1), 0, 'a quarter of 0.85 back toward the list');
  assert.equal(landingIn(MESSAGES_AT, 1, 0.65, 1), 1);
  // The Communities wrappers are the same rule on their own stops.
  assert.equal(math.landing(1, math.LEVEL_AT[1] + 0.21, -1), math.landingIn(math.LEVEL_AT, 1, math.LEVEL_AT[1] + 0.21, -1));
});

test('Messages\' header: no colour, and the conversation arrives with its line under it', () => {
  const at0 = math.headerFrame(0, 44, false, true);
  assert.equal(at0.tint, 0);
  assert.deepEqual(at0.outer, { opacity: 1, x: -44, y: 7 }, '"Messages", where the arrow is not');
  assert.equal(at0.back.opacity, 0);
  const half = math.headerFrame(0.5, 44, false, true);
  assert.equal(half.tint, 0, 'never a community\'s colour');
  assert.equal(half.outer.x, -44 - 6, 'going in, "Messages" drifts left');
  assert.equal(half.inner.x, 12, 'and the conversation arrives from the right');
  assert.equal(half.inner.subOpacity, math.SUB_OPACITY, 'with who it is with already under its name');
  assert.equal(half.inner.y, 0);
  const at1 = math.headerFrame(1, 44, false, true);
  assert.deepEqual(at1.inner, { opacity: 1, x: 0, y: 0, subOpacity: math.SUB_OPACITY, subX: 0, subY: 0 });
  assert.equal(at1.back.live, true);
  assert.equal(math.headerFrame(2, 44, false, true).inner.opacity, 1, 'a depth past 1 is the conversation');
});

test('Messages\' drawer holds the list, conversations and agent sessions, on a phone only', () => {
  const { messagesDrawerApplies } = loadTsx(`${DIR}/messages-drawer.ts`);
  const list = { phone: true, open: true, conversationId: null, appSlug: null, agent: null, threadRootId: null };
  assert.equal(messagesDrawerApplies(list), true);
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, activeKind: 'group' }), true);
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, activeKind: null }), true, 'before the conversation has loaded');
  assert.equal(messagesDrawerApplies({ ...list, phone: false }), false, 'never at 768px and up');
  assert.equal(messagesDrawerApplies({ ...list, open: false }), false, 'another screen');
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 1, activeKind: 'channel' }), false, 'a channel is its community\'s');
  assert.equal(messagesDrawerApplies({ ...list, appSlug: 'notes' }), false);
  // Evan, 18 Oct 2026: an agent session is the drawer's second level on a
  // phone too, so a swipe goes back to the list; a dev session still opens
  // on its project's page.
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'agent', id: 3 } }), true, 'an agent session');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'agent', id: 'new' } }), true, 'one not sent yet');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'chat', id: 'c-1' } }), false, 'a removed Global Chat thread is no thread');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'session', slug: 'notes', id: 4 } }), false, 'a dev session opens on its project\'s page');
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, threadRootId: 40 }), false, 'a reply thread is a level over its conversation');
  assert.equal(messagesDrawerApplies({ ...list, embedded: true }), false);
});

test('the Messages screen: the panes are the levels, the page drops its name, the arrow is the drawer\'s', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const agentWords = useAgentThreadWords\(snap\.route\.agent\);\s*const drawer = useMessagesDrawer\(layoutRef, snap\.route, snap\.active, snap\.messages, threadWords, agentWords\);/);
  assert.match(index, /\{drawer\.peek \? <ConversationPeek peek=\{drawer\.peek\} \/> : <ConversationThread \/>\}/);
  assert.match(index, /className=\{`messages-list-pane \$\{specBeside \? 'hidden' : drawer \? 'flex' : /, 'the list stays drawn beside a conversation');
  assert.match(index, /\{inDrawer \? null : channel/, 'no avatar in the sheet\'s title row');
  assert.match(index, /<div className="messages-peek-body" inert aria-hidden="true">/, 'the peek is a picture');
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /if \(\(state\.route\.conversationId \|\| state\.route\.agent\) && messagesDrawerApplies\(\{[\s\S]*?\}\)\) \{\s*app\.setBackIcon\?\.\('none'\);/,
    'no href\'d arrow, so WebKit\'s history swipe stays off');
  const drawer = read('frontend/src/features/messages/phone-drawer.tsx');
  // Polish #16: the panes start sliding in the release's own task, and the
  // address changes once the slide is running, in a task of its own; the
  // route's placement then finds them on their way, and a pane it swaps in
  // joins the slide where it is.
  const land = drawer.slice(drawer.indexOf('const landAt = '), drawer.indexOf('// ── A mouse on the list ──'));
  assert.match(land, /put\(MESSAGES_AT\[to\], true\);\s*messagesDepth\.slide\(to\);\s*if \(to === from\) return;\s*landing\.current = to;/,
    'the slide first, whichever way the pan lands');
  assert.match(land, /afterSlideStarts\(\(\) => \{ window\.setTimeout\(\(\) => openConversation\(id\), 0\); \}\);/,
    'a pan lands by opening the address, after the slide is running');
  assert.match(drawer, /if \(!first && landing\.current === level\) \{\s*\/\/[^\n]*\n\s*landing\.current = null;\s*put\(MESSAGES_AT\[level\], true\);\s*placed\.current = level;\s*return;\s*\}/,
    'the route confirms the slide rather than starting it again');
  assert.match(drawer, /if \(animate && running && running\.end === end\) \{\s*\/\/[^\n]*\n\s*if \(running\.el === el\) continue;/);
  assert.match(drawer, /run\(pane, el, running\.start, end, running\.t0, elapsed\)/,
    'the pane the route swaps in joins the slide the old one was on');
  assert.match(drawer, /const start = own && shown !== 'none' \? shown : at\(pane, from, w\);/,
    'otherwise a pane slides on from where it was');
  assert.match(drawer, /el\.animate\(\[\{ transform: start \}, \{ transform: end \}\], \{ duration: SLIDE_MS, easing: SLIDE_EASE \}\)/);
  assert.doesNotMatch(drawer, /\.style\.transition/, 'the conversation\'s pane is the kit\'s keyboard column, whose transition the kit owns');
  assert.match(drawer, /if \(!on \|\| \(level === 0 && !peekId\)\) return undefined;\s*const from = level;\s*const takesEdge = pageTakesEdge\(\);/);
  assert.match(drawer, /const pastEdge = rtl \? touch\.clientX < window\.innerWidth - EDGE_PX : touch\.clientX > EDGE_PX;\s*const sideways = pastEdge && startsOnSideways\(target, layout, window\);\s*if \(!swipeBackMayStart\(\{ x: touch\.clientX, takesEdge, sideways, rtl, width: window\.innerWidth \}\)\) return;/,
    'a conversation pans back from anywhere but sideways UI, as a page does (tests/nav-drawer-swipe.test.js)');
  const header = read(`${DIR}/header-drawer.tsx`);
  assert.match(header, /if \(mode === 'messages'\) return <BackDisc mode=\{mode\} label=\{t\('core:header\.drawer\.toMessages'\)\} onBack=\{messagesBack\} \/>;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\.messages-drawer > \.messages-list-pane \{\s*position: absolute; top: 0; bottom: 0; inset-inline-start: 0; width: 85%;/);
  assert.match(css, /\.messages-layout\.messages-drawer \.messages-list-scroll,\s*\.messages-layout\.messages-drawer \.messages-thread-scroll \{ touch-action: pan-y; \}/,
    'the list and the conversation hand a sideways drag on');
  const messages = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.ok(messages['drawer.peek.open'] && messages['drawer.peek.open'].description);
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  for (const key of ['header.drawer.messages', 'header.drawer.toMessages']) assert.ok(core[key] && core[key].description, key);
});

test('the phone\'s header names a conversation as its sheet does', () => {
  const { threadWords } = loadTsx('frontend/src/features/messages/index.tsx');
  const base = { id: 8, members: [], memberCount: 3, membershipStatus: 'member', title: 'Launch crew' };
  assert.deepEqual(threadWords({ ...base, kind: 'group', myRole: 'owner' }), { title: 'Launch crew', sub: '3 members · you own this group' });
  assert.deepEqual(threadWords({ ...base, kind: 'group', myRole: 'member', memberCount: 1 }), { title: 'Launch crew', sub: '1 member' });
  assert.equal(threadWords({ ...base, kind: 'group', membershipStatus: 'invited' }).sub, 'Invitation pending');
  const ada = { id: 3, username: 'ada' };
  assert.deepEqual(threadWords({ ...base, kind: 'direct', title: 'ada', peer: ada }), { title: 'ada', sub: 'Direct message' });
  assert.equal(threadWords({ ...base, kind: 'direct', title: 'ada', peer: ada, awaitingAcceptance: true }).sub, 'Request pending');
  const bot = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
  assert.deepEqual(threadWords({ ...base, kind: 'direct', title: 'homeroom_bot', peer: bot, homeroomBot: true }),
    { title: 'Homeroom bot', sub: 'Builds what you ask for' });
  // The sheet builds the same words from the same ids.
  const index = read('frontend/src/features/messages/index.tsx');
  const words = index.slice(index.indexOf('export function threadWords('), index.indexOf('function ThreadHeader('));
  const header = index.slice(index.indexOf('function ThreadHeader('), index.indexOf('/** The day a message was sent'));
  for (const id of ['header.subtitle.channel', 'header.subtitle.invited', 'header.subtitle.groupOwner', 'header.subtitle.group',
    'header.subtitle.requestPending', 'header.subtitle.direct', 'header.subtitle.homeroomBot']) {
    assert.ok(words.includes(`'messages:${id}'`) && header.includes(`'messages:${id}'`), id);
  }
});
