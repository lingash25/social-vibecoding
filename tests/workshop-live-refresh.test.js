'use strict';

// #5164: the quiet refresh on the two places that wait on the viewer.
//
// A proposal put up for a vote, or a change going live, reached the
// Communities screen and the project hub only on a page reload: the
// screen's own reads ran once at open, the socket burst's refresh never
// touched the Communities screen, and the hub's For you / Recently live
// cards only moved when a socket event named a row. These tests pin the
// three seams the fix adds: the controller's watch, the late-arrival
// correction's branch, and AppView.refreshHubLive.
//
// Run with: node --test tests/workshop-live-refresh.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const workshopTsx = read('frontend/src/features/workshop/index.tsx');
const hubTsx = read('frontend/src/features/dev-board/workshop/workshop.tsx');

function sliceMember(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  assert.ok(start >= 0, `${signature} is defined`);
  const close = '\n  },';
  const end = src.indexOf(close, start);
  return src.slice(start + 1, end + close.length);
}

// ── 1. The Communities screen: refreshActiveScreen reaches the controller ─

test('#5164: the late-arrival correction re-runs the workshop screen\'s quiet reads', () => {
  const start = appJs.indexOf('  refreshActiveScreen() {');
  assert.ok(start >= 0, 'App.refreshActiveScreen is defined');
  const body = appJs.slice(start, appJs.indexOf('\n  },', start));
  assert.match(body, /UsernodeReact\?\.workshop/,
    'the correction names the workshop controller');
  assert.match(body, /workshop\?\.isOpen\?\.\(\)/,
    'only while the screen is open');
  assert.match(body, /workshop\.refreshNeeds\?\.\(\)/,
    'through its own quiet reload, the same loader the screen runs');
});

test('#5164, #5462: the quiet reads and re-entry ask for the current answer, not the saved copy', () => {
  assert.match(workshopTsx, /fetch\(`\/api\/workshop\/counts\$\{demo\}`, \{ cache: 'no-cache' \}\)/,
    'counts, in the wantsFreshAnswer spelling the worker reads (#4177)');
  assert.match(workshopTsx, /fetch\(`\/api\/workshop\/needs-feed\$\{demo\}`, \{ cache: 'no-cache' \}\)/,
    'and the Needs you feed with it');
  // #5462: reload()'s re-entry read goes fresh the same way. The store
  // already holding a feed is what says this is a return — open() has
  // painted that kept copy, so waiting for the network costs no visible
  // time, and the saved copy the boot lane would answer with is exactly the
  // one a vote cast while the page was away leaves behind.
  assert.match(workshopTsx, /const fresh = workshopStore\.get\(\)\.feed != null;/,
    're-entry is read off the store, which feed: null marks until the first answer');
  assert.match(workshopTsx, /const opts = fresh \? \{ cache: 'no-cache' as const \} : undefined;/,
    'the conditional is the one spelling, shared by both reads');
  // The FIRST paint stays a boot read: opts is undefined there, so the fast
  // lane #5164 kept for the cold start is untouched.
  // #6591: the first entry's counts read shares a request already on its
  // way (lib/shared-read.ts), which keeps the boot lane; a re-entry sends
  // its own with the conditional mode.
  assert.match(workshopTsx, /const countsRead: Promise<unknown> = fresh\s*\? fetch\(`\/api\/workshop\/counts\$\{demo\}`, opts\)/,
    'reload() passes the conditional mode to a re-entry\'s counts read');
  assert.match(workshopTsx, /: sharedJson\(`\/api\/workshop\/counts\$\{demo\}`\);/,
    'and the first entry shares the read, asking for no fresh copy');
  assert.match(workshopTsx, /fetch\(`\/api\/workshop\/needs-feed\$\{demo\}`, opts\)\.catch/,
    'and to the Needs you feed with it');
});

// ── 2. The controller's watch is the interval and the return, nothing else ─

test('#5164: the watch is a visible-only interval plus the return to the tab', () => {
  assert.match(workshopTsx, /WORKSHOP_REFRESH_MS = 30_000/);
  const watch = workshopTsx.slice(workshopTsx.indexOf('function startWatch()'), workshopTsx.indexOf('function stopWatch()'));
  assert.match(watch, /visibilityState === 'visible'/, 'a hidden tab is skipped');
  assert.match(watch, /refreshNeeds/, 'the tick is the controller\'s own quiet reload');
  assert.match(workshopTsx, /document\.addEventListener\('visibilitychange', watchVisibility\)/,
    'the return to the tab is a listener, not a second timer');
  assert.match(workshopTsx, /typeof document === 'undefined'\) return/,
    'the node tests, which fake only window, never leave a timer running');
  assert.match(workshopTsx, /startWatch\(\);\n    return workshopController\.reload\(\)/,
    'open() starts the watch');
  assert.match(workshopTsx, /answeredVotes\.clear\(\);\n    stopWatch\(\)/,
    'close() stops it');
});

// ── 3. The hub: AppView.refreshHubLive, run behaviourally ──────────────

function hubHarness({ appData = true, tab = 'dev', subTab = 'forum', hidden = false, ready = true } = {}) {
  const loads = [];
  const intents = [];
  const sandbox = {
    document: { hidden },
    App: {
      currentTab: tab,
      currentSubTab: subTab,
      _announceRefreshIntent: () => { intents.push(1); },
    },
    AppView: {
      appData: appData ? { slug: 'demo' } : null,
      _devDataReady: ready,
      _loadDevFeed: (opts) => { loads.push(opts); return Promise.resolve(true); },
      // #6001: the tick also hands a moved row to a change open beside the
      // hub. What that does is #6001's own suite; here it is just a call.
      _refreshOpenChangeFromBoard: () => {},
    },
    Set,
    Promise,
  };
  vm.createContext(sandbox);
  const member = sliceMember(appViewJs, 'refreshHubLive({ whole = false } = {}) {');
  vm.runInContext(`Object.assign(AppView, {\n${member}});`, sandbox);
  return { loads, intents, call: (opts) => sandbox.AppView.refreshHubLive(opts) };
}

test('#5164: refreshHubLive re-reads the hub\'s two parts, behind its guards', () => {
  const h = hubHarness();
  h.call();
  // The parts Set is made inside the vm, so it is compared by its items.
  assert.equal(h.loads.length, 1, 'one load per tick');
  assert.deepEqual([...h.loads[0].parts], ['promoted', 'merged'],
    'a tick reads the tallies and the merged list, the parts For you and Recently live draw from');
  assert.equal(h.intents.length, 1, 'it announces a refresh: the worker\'s boot lane shuts for it');
});

test('#5164: returning to the tab re-reads the whole board', () => {
  const h = hubHarness();
  h.call({ whole: true });
  assert.deepEqual(h.loads, [null], 'whole is the ordinary full reload');
  assert.equal(h.intents.length, 1);
});

test('#5164: refreshHubLive does nothing off its places', () => {
  for (const [name, opts] of [
    ['no app open', { appData: false }],
    ['not the dev tab', { tab: 'home' }],
    ['not a hub place (a topic page)', { subTab: 'topic' }],
    ['hidden tab', { hidden: true }],
    ['board not loaded once yet', { ready: false }],
  ]) {
    const h = hubHarness(opts);
    assert.equal(h.call(), undefined, name);
    assert.deepEqual(h.loads, [], `${name}: no load`);
    assert.deepEqual(h.intents, [], `${name}: nothing announced`);
  }
});

// ── 4. The hub's polling effect ────────────────────────────────────────

test('#5164: the hub\'s effect polls while its own places are up, and cleans up', () => {
  assert.match(hubTsx, /HUB_REFRESH_MS = 30_000/);
  const effect = hubTsx.slice(hubTsx.indexOf('THE HUB\'S QUIET REFRESH'), hubTsx.indexOf('const group = useWorkshopGroup();'));
  assert.ok(effect.includes("tab === 'status' || tab === 'needs' || tab === 'workshop'"),
    'the hub\'s own places only: a channel, All items and the plan do not poll');
  assert.match(effect, /visibilityState !== 'visible'\) return/, 'a hidden tab is skipped');
  assert.match(effect, /getClientRects\(\)\.length/, 'an unmounted host is skipped, as hub-cards.tsx does');
  assert.match(effect, /callAppView\('refreshHubLive'\)/, 'the tick goes through AppView');
  assert.match(effect, /callAppView\('refreshHubLive', \{ whole: true \}\)/,
    'the return to the tab re-reads the whole board');
  assert.match(effect, /removeEventListener\('visibilitychange', onReturn\)/,
    'the effect cleans up after itself');
  assert.match(effect, /clearInterval\(timer\)/);
});
