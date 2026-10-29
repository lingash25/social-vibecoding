'use strict';

// #6016: the open change page follows its change through testing, going live
// and live, or says it could not go live, without being reopened — including
// when the update that moved it names the project and not the change.
// #5933 was the page stuck on "Going live" until it was reopened.
//
// The real public/js/app-view.js (and merge-status.js) runs in a vm, exactly
// as tests/change-submission-live-state.test.js does. Only the network is
// replaced: the fake server holds change 42's row, the board reads copy it into
// AppView's lists, and page reads answer it. The release events go through
// public/js/app.js's real handlers, in their own vm with this AppView.
//
// What the page shows is read through the page's own view code over the row
// its ChangeDetail holds: a `change-detail-refresh` listener follows
// topic-head.tsx's contract (an id re-reads, `{ id, row }` adopts,
// `{ id, patch }` merges).
//
// Run with: node --test tests/change-page-live-states.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ID = 42;
const SLUG = 'demo';

const row = (patch = {}) => ({
  id: ID, user_id: 7, username: 'alice', status: 'promoted',
  proposal_state: 'ready', check_state: 'passing',
  deployment_state: null, live_at: '2026-10-01T00:00:00Z',
  yes_count: 2, no_count: 0, created_at: '2026-10-01T00:00:00Z',
  session_title: 'A change', linked_issues: [], ...patch,
});

/** The page's own view of the change, and the vm it runs in. */
function makePage() {
  const handlers = {};
  const server = { row: row() };
  const events = [];
  const page = { row: null };
  const sandbox = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Object, Array, String, Number, Set, Map, RegExp, Error,
    App: { user: { id: 7, username: 'alice' }, currentApp: SLUG, currentTab: 'dev', currentSubTab: 'topic' },
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {}, hidden: false },
    PlatformUI: { toast() {} },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    dispatchEvent(ev) { for (const fn of handlers[ev.type] || []) fn(ev); },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    relTime: () => 'just now',
    fetch: async (url) => {
      if (url.includes(`/api/apps/${SLUG}/proposals/${ID}`)) {
        return { ok: true, json: async () => ({ proposal: server.row }) };
      }
      if (url.includes(`/api/sessions/${ID}/details`)) {
        return { ok: true, json: async () => ({ session: server.row }) };
      }
      return { ok: true, json: async () => ({ votes: [], approvers: 0, required: 1 }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  for (const file of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(read(file), sandbox);
  }
  const av = vm.runInContext('AppView', sandbox);
  av.appData = { slug: SLUG, name: 'Demo' };
  av._devDataSlug = SLUG;
  av._devDataReady = true;
  av._devTopic = { kind: 'proposal', id: ID, title: 'A change' };
  av._devTopicInPanel = false;
  av._proposals = [];
  av._merged = [];
  av._voteRoster = {};
  av._proposalsCtx = { activeUsers: 3 };
  av._renderTopicHead = () => {};
  av._loadVoteRoster = async () => {};
  av._loadDevData = async () => { copyBoard(); return true; };
  av._loadDevFeed = async () => { copyBoard(); return true; };
  av._refreshTopicOnDemandRow = async () => {};
  av._whereHeld = () => 'promoted';

  function copyBoard() {
    av._proposals = [{ ...server.row }];
    av._merged = server.row.status === 'merged' ? [{ ...server.row }] : [];
  }
  copyBoard();

  sandbox.addEventListener('change-detail-refresh', (ev) => {
    const d = ev.detail;
    events.push(d);
    if (typeof d === 'number') {
      page.row = { ...server.row };
    } else if (d && d.row) {
      page.row = { ...d.row };
    } else if (d && d.patch) {
      page.row = { ...(page.row || {}), ...d.patch };
    }
  });

  // The page's first read is the row it opened on, and opening it records
  // where the board will compare against.
  page.row = { ...server.row };
  av._refreshOpenChangeFromBoard();

  return { av, sandbox, server, page, events, copyBoard };
}

/** public/js/app.js's release handlers, with this page's real AppView. */
function makeApp(page) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    relTime: () => 'just now',
    Home: { load: () => {} },
    AppView: page.av,
    Improve: { update: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, removeEventListener: () => {},
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }),
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
      documentElement: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '', pathname: '/', href: 'http://localhost/' },
    history: { replaceState() {}, pushState() {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { userAgent: 'node', serviceWorker: undefined },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: () => {}, removeEventListener: () => {},
    WebSocket: function WebSocketStub() {},
    URL, URLSearchParams, JSON, Date, Math, Promise, Object, Array, String, Number,
    Intl, Set, Map, RegExp, Error, TextEncoder, TextDecoder, btoa, atob,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.App = {
    user: { id: 7 }, currentApp: SLUG, currentTab: 'dev',
    _isScreenVisible: () => false, _announceRefreshIntent() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app.js')}\n;globalThis.__App = App;`, sandbox);
  return sandbox.__App;
}

const hero = (page) => page.av._topicHeroView('proposal', page.page.row).status;
const votes = (page) => page.av._changeVotesView(page.page.row, null).note.join(' ');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('checks passing, merging, merged, going live and live, in order', async () => {
  const page = makePage();
  const App = makeApp(page);

  // Checks passed: the verdict's own targeted read adopts the row.
  page.server.row = row({ status: 'promoted', check_state: 'passing' });
  page.copyBoard();
  await page.av.refreshDevData('checks', { ids: new Set([ID]), kinds: new Set(['checks']) });
  await settle();
  assert.equal(hero(page), page.av._waitingWords(page.page.row),
    'a passing change waits for approval, not for checks');
  assert.notEqual(hero(page), message('changes:page.hero.status.merging'));

  // Merging: the board reads the row and the open page hears it.
  page.server.row = row({ status: 'merging', deployment_state: null });
  await page.av.refreshDevData('session');
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.merging'));

  // Merged and going live: the merge put it on the board, the rollout pending.
  page.server.row = row({ status: 'merged', deployment_state: 'deploying', live_at: null });
  await page.av.refreshDevData('session');
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.goingLive'));
  assert.match(votes(page), new RegExp(message('changes:page.votes.note.goingLive').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Live: the release events name the app, never change 42 (#5933).
  page.server.row = row({ status: 'merged', deployment_state: 'deployed', live_at: '2026-10-29T09:00:00Z' });
  App.handleAppRedeployStatus({ appSlug: SLUG, deploying: false });
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.live'), 'the page is live, with no reopen');
  assert.match(votes(page), new RegExp(message('changes:page.votes.note.live').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  App.handleAppVersionChanged({ appSlug: SLUG, sha: 'b'.repeat(40) });
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.live'));
});

test('a board reload that names no change still moves the open one (#5933)', async () => {
  // Open beside the Workshop (the panel), what a person watches after a merge.
  const page = makePage();
  page.sandbox.App.currentSubTab = 'forum';
  page.av._devTopicInPanel = true;
  page.server.row = row({ status: 'promoted', deployment_state: null });
  page.copyBoard();
  // First look records where the page is.
  await page.av.refreshDevData('session');
  assert.equal(hero(page), page.av._waitingWords(page.page.row));

  page.server.row = row({ status: 'merged', deployment_state: 'deploying', live_at: null });
  await page.av.refreshDevData('session');
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.goingLive'));
  assert.equal(page.events.length, 1, 'exactly one patch reached the page');
  assert.ok(page.events[0].patch, 'and it was the board row, not a bare re-read');
});

test('a failed release says it could not go live', async () => {
  const page = makePage();
  page.sandbox.App.currentSubTab = 'forum';
  page.av._devTopicInPanel = true;
  page.server.row = row({ status: 'merged', deployment_state: 'deploying', live_at: null });
  page.copyBoard();
  await page.av.refreshDevData('session');

  // `deployment_kind: 'child'` is what makes a failed rollout the app's own
  // delivery (services/merge-followups), as a child app's always is.
  page.server.row = row({ status: 'merged', deployment_state: 'failed', deployment_kind: 'child', live_at: null });
  await page.av.refreshDevData('session');
  await settle();
  assert.equal(hero(page), message('changes:page.hero.status.notLiveYet'));
  assert.match(votes(page), new RegExp(message('changes:page.votes.note.failed').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a quiet reload tells the page nothing', async () => {
  const page = makePage();
  page.sandbox.App.currentSubTab = 'forum';
  page.av._devTopicInPanel = true;
  page.server.row = row({ status: 'merged', deployment_state: 'deploying', live_at: null });
  page.copyBoard();
  await page.av.refreshDevData('session');
  const after = page.events.length;
  await page.av.refreshDevData('session');
  await settle();
  assert.equal(page.events.length, after, 'the row did not move, so the page is not repainted');
});

test("another app's release moves nothing on this page", async () => {
  const page = makePage();
  const App = makeApp(page);
  page.server.row = row({ status: 'merged', deployment_state: 'deploying', live_at: null });
  page.copyBoard();
  await page.av.refreshDevData('session');
  const before = hero(page);
  const seen = page.events.length;

  App.handleAppVersionChanged({ appSlug: 'other', sha: 'c'.repeat(40) });
  App.handleAppRedeployStatus({ appSlug: 'other', deploying: false });
  await settle();
  assert.equal(hero(page), before);
  assert.equal(page.events.length, seen);
});
