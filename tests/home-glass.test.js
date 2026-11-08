// Home in the one frame, under the glass look (docs/superpowers/plans/
// 2026-11-08-one-frame-glass-foundation.md, Task 6). The standard Home is
// untouched: HomeScreen swaps the body of #home-body for <HomeGlass/> only
// after mount, when the device's look is glass (lib/skin.ts), so the first
// render still matches the prerendered document. HomeGlass keeps the nodes
// the legacy home.js writes into, hidden, and says nothing for a zero.
//
// Run with: node --test tests/home-glass.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, createElement } = require('./lib/render-tsx');
const { shapeNeedsFeed } = require('../src/routes/workshop-overview');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HOME_GLASS = 'frontend/src/features/home/glass/home-glass.tsx';

// A store the way lib/plain-store.js shapes one, holding `state` for good.
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

// The modules HomeGlass reads, stubbed by the specifier it imports them as.
function homeStubs({ pins = [], joined = [], owed = {}, directory = [], apps = [] } = {}) {
  return {
    '../grid-store': { gridStore: fixedStore({ ready: true, view: 'grid', editing: false, items: apps }) },
    '../home-pins-store': {
      homePinsStore: fixedStore({ ready: true, pins, joined, owed }),
      loadHomePins: async () => {},
    },
    '../app-grid': { AppGrid: () => createElement('div', { id: 'app-list' }, 'grid') },
    '../communities-to-join': { readDirectory: async () => directory },
  };
}
const render = (props, stubs) => renderComponent(HOME_GLASS, 'HomeGlass', props, { stubs, cache: false });

test('HomeScreen draws the glass body only after mount, for a signed-in viewer, from useSkin', () => {
  const src = read('frontend', 'src', 'features', 'home', 'index.tsx');
  assert.match(src, /import \{ useSkin \} from '\.\.\/\.\.\/lib\/skin'/);
  assert.match(src, /const skin = useSkin\(\)/);
  assert.match(src, /skin === 'glass' && viewer \? \(\s*<HomeGlass/, 'the glass body is the branch, never the first render');
  assert.match(src, /useEffect\(\(\) => whenPlatformViewer\(\(\) => setViewer\(true\)\), \[\]\)/,
    'and only for a viewer the member APIs answer: the landing and the waiting room keep the standard body');
  assert.match(src, /id="home-apps-section"/, 'the standard body is still there');
});

test('HomeGlass keeps the nodes home.js writes to, hidden, and marks itself', () => {
  const html = render({}, homeStubs());
  for (const id of ['home-communities-section', 'home-featured-list', 'home-join-section']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), id);
  }
  assert.match(html, /data-home-glass=""/);
  assert.match(html, /id="home-apps-section"/, 'the apps keep their section id for the declared checks');
  assert.match(html, /id="app-list"/, 'the launcher grid is reused');
});

test('an empty Needs you group is not drawn and a zero says nothing', () => {
  const html = render({ initialFeed: [] }, homeStubs({
    pins: [{ slug: 'game-corner', name: 'Game Corner', iconUrl: null, iconEmoji: null, iconColor: null, member: true }],
    owed: { 'game-corner': 0 },
  }));
  assert.doesNotMatch(html, />Needs you</);
  assert.doesNotMatch(html, /0 to vote/);
  assert.doesNotMatch(html, />Pinned apps</, 'no pinned apps: no empty pane (a zero says nothing)');
  assert.match(html, /id="home-apps-section"[^>]*hidden/, 'but the section the checks select on stays, hidden');
  assert.match(html, /Game Corner/);
  assert.doesNotMatch(html, /data-tone="you"/, 'nothing waits for the viewer, so nothing is blue');
});

test('what waits for the viewer is the first group, each row ending in the word that says what to do', () => {
  // Rows shaped by the server's own shapeNeedsFeed, so the contract the
  // screen reads (approve, waitingOn, app.slug/name) cannot drift from it.
  const feed = shapeNeedsFeed([
    { kind: 'proposal', id: 7, title: 'Shorter Home on phones', number: 6412, slug: 'homeroom', name: 'Homeroom', waiting_on: null },
    { kind: 'proposal', id: 8, title: 'A header colour', number: 6413, slug: 'pourover', name: 'Pourover Coffee', waiting_on: ['checks'] },
    { kind: 'governance', id: 9, title: 'Who decides', number: 12, slug: 'pourover', name: 'Pourover Coffee', waiting_on: null },
  ]);
  const html = render({ initialFeed: feed }, homeStubs({
    pins: [{ slug: 'pourover', name: 'Pourover Coffee', iconUrl: null, iconEmoji: null, iconColor: null, member: true }],
    owed: { pourover: 2 },
    apps: [{ app: { slug: 'game-corner', name: 'Game Corner', demo: false } }],
  }));
  assert.match(html, />Pinned apps</, 'with a pinned app the group is drawn');
  const needs = html.indexOf('Needs you');
  const apps = html.indexOf('id="home-apps-section"');
  assert.ok(needs > -1 && needs < apps, 'Needs you comes before the apps');
  assert.match(html, /Shorter Home on phones/);
  assert.equal((html.match(/data-tone="you"[^>]*>Vote</g) || []).length, 2, 'an ordinary owed vote says Vote, in blue');
  assert.match(html, /data-tone="waiting"[^>]*>Checks</, 'a change waiting on its checks says so, in amber');
  assert.match(html, /data-tone="you"[^>]*>2 to vote</, 'a community row says how many wait');
  assert.match(html, /3 decisions wait for you/, 'the side column counts them');
});

test('a change whose Yes is the viewer\'s alone says Approve', () => {
  const src = read('src', 'routes', 'workshop-overview.js');
  assert.match(src, /approvedAlone\(row\) \? \{ approve: true \}/, 'the server\'s own flag');
  const html = render({ initialFeed: [{ kind: 'proposal', id: 1, title: 'Mine', number: 3, approve: true, app: { slug: 'solo', name: 'Solo', icon_url: null, icon_emoji: null } }] }, homeStubs());
  assert.match(html, /data-tone="you"[^>]*>Approve</);
});

test('every row is a door, not a page load, and Join is a word on the row', () => {
  const src = read('frontend', 'src', 'features', 'home', 'glass', 'home-glass.tsx');
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/, 'cmd-click and middle-click keep the href');
  assert.match(src, /AppView\?\._landOnHub\?\.\(slug\)/, 'a community row lands on the hub');
  assert.match(src, /AppView\?\._landOnTab\?\.\(slug, 'needs'\)/, 'a Needs you row lands on Needs you');
  assert.match(src, /App\?\.navigateToApp\?\.\(slug, 'dev'\)/);
  const html = render({
    initialFeed: [],
    initialDirectory: [{ slug: 'game-corner', name: 'Game Corner', member_count: 12 }, { slug: 'solo', name: 'Solo', member_count: 1 }],
  }, homeStubs());
  assert.match(html, /data-tone="none"[^>]*>Join</, 'Join is the row\'s word, not a button inside the link');
  assert.doesNotMatch(html, /<a[^>]*>(?:(?!<\/a>).)*<button/s, 'no button inside an anchor');
  assert.match(html, /12 members/, 'a count on a row is a phrase');
  assert.match(html, /1 member</);
});

test('the words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'home.json'));
  for (const k of ['glass.title', 'glass.purpose', 'glass.make', 'glass.needs', 'glass.pinnedApps', 'glass.yourCommunities',
    'glass.toJoin', 'glass.join', 'glass.vote', 'glass.approve', 'glass.waiting.checks', 'glass.waiting.conflict',
    'glass.toVote_one', 'glass.toVote_other', 'glass.thisWeek',
    'glass.decisions_one', 'glass.decisions_other', 'glass.communities_one', 'glass.communities_other']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
  }
  assert.doesNotMatch(read('frontend', 'src', 'features', 'home', 'glass', 'home-glass.tsx'), />[A-Z][a-z]+ [a-z]+</, 'no English literal in the component');
});
