// The Workshop — the Dev screen's lander, which replaced the Activity feed.
//
// What is pinned here, and why each would fail silently if it drifted:
//
//   * The view model (`AppView._workshopView`) groups the SAME cards the
//     Board draws by the server's themes, keyed the way the server keys them,
//     and never loses a card: one the server has not placed yet lands under
//     "Being placed" (marked on the row), one its placer declined under "Not
//     yet grouped", one they name but the board no longer has is not drawn,
//     and the viewer's own private session is placed by the issue it links.
//   * The strips, in the order a returning member reads them: what changed
//     since they were last here, the app's state folded into a dashboard,
//     the proposals waiting on THIS viewer's vote (pinned whatever the
//     filters say) and one unclaimed issue to pick up. The baseline "since"
//     is measured against is read once per page session.
//   * The shared filter bar narrows the themes, and the Workshop's own
//     `theme` filter is what "Open on Board" hands the kanban.
//   * A row unfolds into the Activity entry byte-for-byte — `.dev-feed-entry`
//     around the dense card, the GitHub slot and the app thread — so the
//     sheet CSS and the module's two fillers find the markup they expect.
//   * The modes, the routes and the declared checks name the Workshop and
//     resolve the retired names (feed, list, /activity) onto it.
//
// Run with: node --test tests/dev-workshop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { workshopHtml, kanbanHtml } = require('./lib/dev-card-html');
const { loadTsx } = require('./lib/render-tsx');
const { tokenize } = require('./helpers/html-tokens');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
// The scroller the rail sticks inside: it carries `.platform-safe-scroll`,
// which is what reserves the home-indicator strip the gap must NOT re-add.
const BOARD_FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
// The shell tree, for the out-of-frost portal host the fixed rail needs.
const SHELL = read('frontend/src/Shell.tsx');
// The row, the open sheet and the fold between them: shared with the Board's columns.
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');
const CARD_TSX = read('frontend/src/features/dev-board/card/dev-card.tsx');
const CSS = read('public/css/app.css');
const VIEW_TABS = read('frontend/src/features/improve/view-tabs.tsx');
// The toolbar, which renders the shared filter strip's host inside this pane.
const ACTIONS_ROW = read('frontend/src/features/dev-board/actions-row.tsx');
const dapp = JSON.parse(read('dapp.json'));

function makeAppView(over) {
  const o = over || {};
  const store = o.localStorage || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: o.App || { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout: o.setTimeout || setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    // A no-op by default, as it always was. `sessionStore` opts one test
    // group into a REAL one: the per-app filter set lives here, so whether a
    // filter change is persisted is only observable against a store that
    // remembers (#1787).
    sessionStorage: o.sessionStore ? {
      getItem: (k) => (k in o.sessionStore ? o.sessionStore[k] : null),
      setItem: (k, v) => { o.sessionStore[k] = String(v); },
      removeItem: (k) => { delete o.sessionStore[k]; },
    } : {
      getItem: () => null, setItem: () => {}, removeItem: () => {},
    },
    location: o.location || { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    // Globals a code path reads as bare identifiers at call time — the "+"
    // wiring wants the real AbortController and a PlatformUI to ask about
    // touch. Absent by default, as they always were.
    ...(o.globals || {}),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  vm.runInContext(`Date.now = () => ${FIXED_NOW};`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  return AppView;
}

// #2176: the dashboard counts CALENDAR weeks (Monday 00:00 UTC), so a
// fixture "two days ago" would land in last week on a Monday and in this
// week on a Wednesday. The clock is held at a Wednesday noon for the whole
// file, in the host (these helpers) and in every sandbox (makeAppView), so
// the fixtures mean the same thing whatever day the suite runs on.
const FIXED_NOW = Date.parse('2026-09-16T12:00:00Z');
Date.now = () => FIXED_NOW;
const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// Values built inside the vm realm carry that realm's prototypes, which trips
// deepStrictEqual — round-trip through JSON before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A loaded board: two issues, a proposal awaiting the viewer's vote, a merge. */
function seed(AppView) {
  AppView._ghIssues = [
    { number: 12, title: 'Dark mode resets', createdAt: at(2), updatedAt: at(1), lastMessageAt: at(1), user: 'alice', htmlUrl: 'https://github.com/x/y/issues/12' },
    { number: 13, title: 'Keyboard voting', createdAt: at(20), updatedAt: at(9), lastMessageAt: null, user: 'bob', htmlUrl: 'https://github.com/x/y/issues/13' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 41, pr_title: 'Persist the theme', status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 40, pr_title: 'Landed thing', status: 'merged', username: 'alice',
    created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 1;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._devDataReady = true;
}

// RELATIVE TO NOW, NOT A WALL-CLOCK DATE. These two stamps were pinned to
// 2026-09-06, which was inside `relStamp`'s seven-day relative window on the
// day they were written and outside it a week later: the footnote assertion
// wants "drafted 2d ago" and started getting "drafted Sep 6" at exactly the
// REL_FLOOR_MS boundary, with nothing about the grouping having changed. A
// suite that starts failing because time passed blocks every merge in the
// repository, so the fixture moves with the clock and only the copy is pinned.
const themes = (list, extra) => ({
  slug: 'demo-app', source: 'ai', generatedAt: at(2), discoveredAt: at(2),
  stale: false, pending: false, pendingStage: null, lastError: null, coverage: null, unplaced: [],
  at: Date.now(), themes: list, ...(extra || {}),
});

// ── item keys ────────────────────────────────────────────────────────

test('_workshopItemKey speaks the server\'s vocabulary', () => {
  const AppView = makeAppView();
  assert.equal(AppView._workshopItemKey('issue', { number: 12 }), 'issue:12');
  assert.equal(AppView._workshopItemKey('proposal', { id: 34 }), 'session:34');
  assert.equal(AppView._workshopItemKey('shared-session', { id: 56 }), 'session:56');
  assert.equal(AppView._workshopItemKey('my-session', { id: 57 }), 'session:57');
  assert.equal(AppView._workshopItemKey('gov', { id: 5 }), 'gov:5');
  assert.equal(AppView._workshopItemKey('merged', { id: 78, row_type: 'pr' }), 'session:78');
  assert.equal(AppView._workshopItemKey('merged', { id: 9, row_type: 'close_issue', payload: { issueNumber: 12 } }), 'issue:12');
  assert.equal(AppView._workshopItemKey('issue', {}), null);
});

// ── grouping ─────────────────────────────────────────────────────────

test('cards land in their theme, by lane, and nothing is lost', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 'theming', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] },
    { id: 'ghost', name: 'Ghost', description: '', saying: '', items: ['issue:999'] },
  ]);
  const v = AppView._workshopView();
  assert.equal(v.loading, false);
  assert.equal(v.slug, 'demo-app');
  assert.equal(v.canPost, true);
  const names = v.themes.map((t) => t.name);
  assert.deepEqual(names, ['Theming', 'Being placed'],
    'a theme whose every card is gone is not drawn; the card the server has not placed yet is on its way');
  const theming = v.themes[0];
  assert.equal(theming.saying, 'Dark mode should stick.');
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(plain(lane(theming, 'review').rows.map((r) => r.key)), ['proposal:34']);
  assert.deepEqual(plain(lane(theming, 'open').rows.map((r) => r.key)), ['issue:12']);
  assert.deepEqual(plain(lane(theming, 'shipped').rows.map((r) => r.key)), ['merged:78']);
  assert.deepEqual(plain(theming.counts), { open: 1, underway: 0, review: 1, shipped: 1, fresh: 0 });
  assert.deepEqual(plain(theming.people), ['alice', 'carol'], 'alice filed and shipped, carol proposed');
  const rest = v.themes[1];
  assert.equal(rest.ungrouped, true);
  assert.equal(rest.placing, 1);
  assert.deepEqual(plain(lane(rest, 'open').rows.map((r) => r.key)), ['issue:13']);
  assert.equal(lane(rest, 'open').rows[0].placing, true, 'the row says so');
  assert.equal(v.meta.placing, 1);
  // Lanes are in stage order, review first.
  assert.deepEqual(plain(theming.lanes.map((l) => l.key)), ['review', 'underway', 'open', 'shipped']);

  // The server's placer declined it: not on its way, not yet grouped.
  AppView._workshopThemes.unplaced = ['issue:13'];
  const declined = AppView._workshopView();
  assert.deepEqual(declined.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  assert.equal(declined.themes[1].placing, 0);
  assert.equal(lane(declined.themes[1], 'open').rows[0].placing, undefined);
  assert.match(declined.themes[1].description, /count towards the next re-draft/);
});

test('the viewer\'s own private session is placed by the issue it links; without one it waits, unmarked', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [
    { id: 57, session_title: 'Fixing dark mode', status: 'active', linked_issues: ['12'], created_at: at(1), last_activity_at: at(0) },
    { id: 58, session_title: 'Something else', status: 'active', linked_issues: [], created_at: at(1), last_activity_at: at(0) },
  ];
  AppView._workshopThemes = themes([{ id: 'theming', name: 'Theming', items: ['issue:12', 'session:34', 'session:78', 'issue:13'] }]);
  const v = AppView._workshopView();
  const lane = (t, k) => t.lanes.find((l) => l.key === k);
  assert.deepEqual(v.themes.map((t) => t.name), ['Theming', 'Not yet grouped']);
  assert.deepEqual(plain(lane(v.themes[0], 'underway').rows.map((r) => r.key)), ['my-session:57'],
    'the linked session sits with its issue, though the server never saw it');
  assert.deepEqual(plain(lane(v.themes[1], 'underway').rows.map((r) => r.key)), ['my-session:58']);
  assert.equal(lane(v.themes[1], 'underway').rows[0].placing, undefined, 'a private session is never "being placed": the server cannot see it');
  assert.equal(v.themes[1].placing, 0);
});

test('a failed themes fetch is no themes, not themes that cover nothing', async () => {
  const AppView = makeAppView({ fetch: async () => { throw new Error('offline'); } });
  seed(AppView);
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(AppView._workshopThemes.failed, true);
  assert.equal(AppView._workshopThemeData(), null);
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.themes.map((t) => t.name)), ['Everything on the board']);
  assert.equal(v.meta.source, null);
});

test('before the themes arrive, everything sits under one group rather than a false "not yet grouped"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 1);
  assert.equal(v.themes[0].name, 'Everything on the board');
  assert.equal(v.meta.source, null);
});

test('another app\'s themes never group this app\'s cards', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 'x', name: 'X', items: ['issue:12'] }]), slug: 'other-app' };
  const v = AppView._workshopView();
  assert.equal(v.themes[0].name, 'Everything on the board');
});

test('a row carries the thread and the GitHub slot the Activity entry carried', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'session:34'] }]);
  const v = AppView._workshopView();
  const t = v.themes[0];
  const issue = t.lanes.find((l) => l.key === 'open').rows[0];
  assert.equal(issue.commentsFor, 12);
  assert.deepEqual(plain(issue.thread), { type: 'issue', ref: 12 });
  const proposal = t.lanes.find((l) => l.key === 'review').rows[0];
  assert.deepEqual(plain(proposal.thread), { type: 'session', ref: 34 });
  assert.equal(proposal.commentsFor, undefined, 'only an issue has a repository conversation');
});

test('the lane cap counts what it hides, for "Open on Board"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues = Array.from({ length: 12 }, (_, i) => ({
    number: 100 + i, title: `Issue ${i}`, createdAt: at(30), updatedAt: at(30), user: 'bob',
  }));
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  const open = v.themes[0].lanes.find((l) => l.key === 'open');
  assert.equal(open.rows.length, AppView.WORKSHOP_LANE_MAX);
  assert.equal(open.more, 12 - AppView.WORKSHOP_LANE_MAX);
  assert.equal(v.themes[0].counts.open, 12, 'the count is the true one');
});

// ── the strips ───────────────────────────────────────────────────────

test('the vote strip pins what is owed to the viewer, whatever the filters say', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  let v = AppView._workshopView();
  assert.equal(v.votes.count, 1);
  assert.deepEqual(plain(v.votes.rows.map((r) => r.key)), ['vote:proposal:34']);
  // #1902: the row carries its thread, so the open card draws a reply box —
  // the same shape the "mine" lane's rows have.
  assert.deepEqual(plain(v.votes.rows[0].thread), { type: 'session', ref: 34 });
  // Voted → not owed.
  AppView._proposals[0].my_vote = 'yes';
  v = AppView._workshopView();
  assert.equal(v.votes.count, 0);
  // Owed but filtered out of the themes: still owed.
  AppView._proposals[0].my_vote = null;
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark mode' };
  v = AppView._workshopView();
  assert.equal(v.votes.count, 1, 'a vote owed is owed whatever the board is narrowed to');
  assert.equal(v.meta.filtered, true);
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'review').rows.length, 0,
    'while the theme itself is narrowed');
  assert.equal(v.discussion, null, 'and the discussion row is dropped, as the feed dropped it');
});

test('the dashboard is drawn every visit; "since" needs a baseline read once', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const first = AppView._workshopView();
  assert.equal(first.since, null, 'a first visit has nothing to be since');
  // #1787: this was `welcome`, and it was drawn ONLY here. "What is this
  // project working on" is a returning member's question too, so the same
  // numbers are drawn every visit, folded, with the rest of the app's state.
  assert.equal(first.dashboard.open, 3);
  assert.equal(first.dashboard.themes, 1);
  assert.equal(first.dashboard.votesWaiting, 1);
  assert.equal(first.dashboard.shippedWeek, 1);
  assert.equal(first.dashboard.people, 1, 'from the merge context, not a new request');

  // A new page session, a week later than the stamp the first one wrote.
  const store = {};
  store[`${AppView.WORKSHOP_SEEN_KEY}:demo-app`] = String(Date.now() - 5 * 86400000);
  const Later = makeAppView({ localStorage: store });
  seed(Later);
  Later._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = Later._workshopView();
  assert.ok(v.dashboard, 'and it is still there on a return visit');
  assert.ok(v.since, 'a baseline exists');
  assert.equal(v.since.opened, 1, 'issue 12 was filed two days ago; issue 13 twenty days ago');
  assert.equal(v.since.proposed, 1);
  assert.equal(v.since.shipped, 1);
  assert.deepEqual(plain(v.since.rows.map((r) => r.key).sort()), ['since:issue:12', 'since:merged:78', 'since:proposal:34']);
  assert.equal(v.themes[0].counts.fresh, 1, 'and the theme counts its new arrivals');
  assert.equal(v.themes[0].lanes.find((l) => l.key === 'open').rows[0].fresh, true);
  // The stamp advanced on that first read, and the baseline is held for the
  // page session: a later repaint compares against the same point.
  assert.ok(Number(store[`${Later.WORKSHOP_SEEN_KEY}:demo-app`]) > Date.now() - 1000);
  assert.equal(Later._workshopView().since.opened, 1);
});

test('the discussion card has a pane of its own, and an eyebrow saying what it is', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView);
  // It used to sit bare between the strips — the one block on the lander
  // with no surface of its own, which read as a stray row of the pane above
  // it. Every block is an eyebrow and what is under it now.
  assert.match(html, /<section class="dev-ws-strip" data-ws-discussion=""><div class="dev-ws-strip-head"><span class="dev-ws-eyebrow">Talk about the app<\/span><\/div>/);
  assert.match(html, /data-ws-discussion=""[\s\S]*?class="dev-ws-discussion"[\s\S]*?data-discussion-row/);
});

test('the discussion row is drawn as a row of its own', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = null;
  const v = AppView._workshopView();
  assert.equal(v.discussion.key, 'discussion');
  assert.equal(v.discussion.card.attrs['data-discussion-row'], '1');
});

test('the discussion row leads with what it is, not with the last thing said', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._discussionSummary = {
    slug: 'demo-app', content: 'Should the board default to the workshop?',
    username: 'dana', createdAt: at(0),
  };
  const card = AppView._workshopView().discussion.card;
  // The Board's card has always been this way round; the row was inside out,
  // so the one heading on the lander that never changes changed every time
  // somebody spoke (#1787).
  assert.equal(card.title.text, 'General discussion');
  assert.equal(plain(card.meta)[0].s, 'dana: Should the board default to the workshop?');

  AppView._discussionSummary = null;
  assert.equal(plain(AppView._workshopView().discussion.card.meta)[0].s,
    'Talk with everyone building this app',
    'and with nothing said yet the standing description takes the preview line');
});

test('the capture deep link names the first issue row to unfold', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['session:34', 'issue:12'] }]);
  assert.equal(AppView._workshopView().autoExpand, null);
  AppView._workshopShot = 'feed-comments';
  assert.deepEqual(plain(AppView._workshopView().autoExpand), { theme: 't', key: 'issue:12' });
});

test('every return path states `loading`, because the store merges', () => {
  const AppView = makeAppView();
  AppView._devDataReady = false;
  assert.equal(AppView._workshopView().loading, true);
  seed(AppView);
  assert.equal(AppView._workshopView().loading, false);
});

// ── the theme filter ─────────────────────────────────────────────────

test('the theme filter narrows by membership, and widens when it cannot be applied', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[0], f), true);
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), false);
  assert.equal(AppView._devCardMatches('proposal', AppView._proposals[0], f), false);
  assert.equal(AppView._devCardMatches('proposal', { id: 99, linked_issues: ['12'], status: 'promoted' }, f), true,
    'a card the themes do not name is in the theme of the issue it links, as on the Workshop');
  assert.equal(AppView._devCardMatches('proposal', { id: 98, linked_issues: [] }, f), false);
  AppView._workshopThemes = null;
  assert.equal(AppView._devCardMatches('issue', AppView._ghIssues[1], f), true,
    'no themes loaded → the filter cannot hide anything');
  AppView._kanbanFilters = f;
  assert.equal(AppView._kanbanFiltersActive(), true);
  assert.equal(AppView._kanbanFilterCount(), 1);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  assert.deepEqual(plain(AppView._kanbanActiveChips().map((c) => [c.key, c.label])), [['theme', 'Theme: Theming']]);
  AppView._dismissKanbanFilter('theme');
  assert.equal(AppView._kanbanFilters.theme, null);
});

// ── the follow-up to #1787: two panes, and a described app ───────────

test('the numbers are tiles, and the pane always has a sentence under them', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  const html = workshopHtml(AppView);
  // Four integers read out as prose is the slowest form they can take, so
  // they are tiles.
  assert.match(html, /data-ws-dash-cell="open"><b>3<\/b>open items/);
  assert.match(html, /data-ws-dash-cell="shipped"[^>]*><b>1<\/b>shipped this week/);
  assert.match(html, /data-ws-dash-cell="votes"><b>1<\/b>waiting on a vote/);
  assert.match(html, /data-ws-dash-cell="unclaimed"><b>2<\/b>with nobody on them/);

  // And the derived sentence is back UNDER them. Round four trimmed it to
  // the two things a tile cannot show and let it render nothing when it
  // could say neither — right about the duplication, wrong about the
  // outcome: an app can sit a long time with no model paragraph, and a
  // heading over four tiles and no sentence reads as a broken feature
  // rather than a deliberate silence.
  assert.match(html, /class="dev-ws-strip-text">3 open items across 1 category\./);
  assert.ok(!html.includes('most of the movement'),
    'but still no unearned superlative: two untouched issues are the absence of movement');
});

test('the derived sentence says something even when it can compare nothing', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  // A paged history refuses to compare weeks and this board has no busiest,
  // so the two clauses round four kept are both silent. The pane still has
  // a sentence.
  AppView._mergedHasMore = true;
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-dash-cell="open"/, 'the tiles carry the state');
  assert.match(html, /class="dev-ws-strip-text">[^<]+/, 'and the paragraph is rendered');
  assert.match(html, /At least 1 change landed this week\./, 'a floor, and no rate');
});

test('a paged merge history states a floor and no rate at all', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);

  // Both weeks are counted from the same page, and the EARLIER one is the
  // half that falls off the end. So a truncated page used to read as a
  // drought that never happened: an app merging twenty a week was told "20
  // landed this week, the first in a fortnight". `At least` was already on
  // the count and never helped, because the fault was in the comparison.
  AppView._mergedHasMore = true;
  const paged = workshopHtml(AppView);
  assert.ok(!paged.includes('fortnight'), 'no drought is claimed off a partial page');
  assert.ok(!paged.includes('the week before'), 'and no rate either');
  // The floor is said in one character, on the tile itself.
  assert.match(paged, /data-ws-dash-cell="shipped"[^>]*><b>1\+<\/b>/);
  assert.match(paged, /title="At least this many/);

  // With the whole history in hand the comparison is real, and stands.
  AppView._mergedHasMore = false;
  const whole = workshopHtml(AppView);
  assert.match(whole, /data-ws-dash-cell="shipped"[^>]*><b>1<\/b>/, 'no marker');
  assert.ok(!whole.includes('title="At least this many'), 'and no floor tooltip');
  assert.match(whole, /1 change landed this week, the first in a fortnight\./);
});

test('busiest names the theme that is MOVING, and stays quiet without a clear leader', () => {
  const AppView = makeAppView();
  const t = (name, counts) => ({ name, counts: { open: 0, underway: 0, review: 0, shipped: 0, fresh: 0, ...counts } });

  // The bug: it sorted on `lastActive`, so ONE comment ten minutes ago on a
  // ten-item theme beat a hundred-item one and the sentence told the group
  // their work was somewhere it was not.
  assert.equal(
    AppView._busiestTheme([t('Quiet', { open: 90 }), t('Busy', { underway: 4, review: 2 })]),
    'Busy',
    'a big backlog is not movement; four underway and two in review is',
  );

  // Open items alone never win it.
  assert.equal(AppView._busiestTheme([t('Backlog', { open: 200 })]), null);

  // Neither does a near-tie: "most of the movement" is a strong claim.
  assert.equal(
    AppView._busiestTheme([t('A', { underway: 4 }), t('B', { underway: 3 })]),
    null,
    'within 1.5x is not "most"',
  );
  assert.equal(AppView._busiestTheme([t('A', { underway: 6 }), t('B', { underway: 3 })]), 'A');

  // Nor a board where almost nothing is in flight at all.
  assert.equal(AppView._busiestTheme([t('A', { shipped: 2 })]), null, 'under the floor');
  assert.equal(AppView._busiestTheme([t('A', { shipped: 3 })]), 'A');
  assert.equal(AppView._busiestTheme([]), null);
});

test('the model\'s paragraph is what the pane says, when there is one', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes(
    [{ id: 't', name: 'Theming', items: ['issue:12'] }],
    { digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.' },
  );
  const html = workshopHtml(AppView);
  assert.match(html, /In the last week, alice finished the sign-in work\. Bob is on the mail templates now\./);
  // …and the derived sentence is what runs when there is none: no model, no
  // draft yet, or a call that failed. Same relationship the category grouping
  // has to the drafted themes.
  assert.ok(!html.includes('open items across'), 'the derived one stands down');
  // And the footnote says which of the two is on screen, so "the summarizer
  // looks broken" and "no draft yet" are distinguishable without reading the
  // database.
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const derived = workshopHtml(AppView);
  assert.match(derived, /3 open items across 1 category\./);
  assert.match(derived, /Worked out from the board; the model writes one on the next pass\./);

  // And when the last attempt FAILED, the footnote says why. That failure
  // used to be a log line and a day of silence, which is what the report
  // "could something be up with the summarizer?" cost to answer.
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }],
    { digestError: 'Workshop digest response hit the output limit before it finished' });
  const failed = workshopHtml(AppView);
  assert.match(failed, /could not be written \(Workshop digest response hit the output limit before it finished\); it is retried within the hour/);
  assert.ok(!failed.includes('the model writes one on the next pass'), 'not also the neutral line');
});

test('the digest survives the fetch that loads it', async () => {
  // The seam every test above steps over. They seed `_workshopThemes` with
  // the CACHE shape directly, so `_loadWorkshopThemes` — the only thing that
  // writes that cache in a browser — is never on the path, and the field it
  // dropped was the one field the pane degrades silently on. #1803 shipped
  // the consumer (`tData.digest`) without the producer, and the derived
  // sentence made a paragraph that never arrived look exactly like a model
  // that had not run yet, through two rounds of fixes to the stages above.
  //
  // So this one asserts ACROSS the normaliser, not beside it: the response
  // body goes in, the rendered pane comes out.
  const digest = 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.';
  const body = {
    themes: [{ id: 't', name: 'Theming', items: ['issue:12'] }],
    source: 'ai', generatedAt: '2026-09-06T00:00:00Z', discoveredAt: '2026-09-06T00:00:00Z',
    stale: false, pending: false, pendingStage: null, lastError: null,
    coverage: null, unplaced: [], digest, digestError: null,
  };
  const AppView = makeAppView({ fetch: async () => ({ ok: true, json: async () => body }) });
  seed(AppView);
  // The load repaints the live surface on the way out; this test is about
  // what it CACHED and what the pane makes of it, not about the DOM.
  AppView._repaintBoardSurface = () => {};
  await AppView._loadWorkshopThemes('demo-app');

  assert.equal(AppView._workshopThemes.digest, digest, 'the normaliser keeps it');
  const html = workshopHtml(AppView);
  assert.match(html, /alice finished the sign-in work/);
  assert.ok(!html.includes('open items across'), 'and the derived sentence stands down');
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  // A response with no paragraph still reads as one: null, not undefined,
  // so the footnote picks the neutral line rather than the failure one.
  const empty = makeAppView({ fetch: async () => ({ ok: true, json: async () => ({ ...body, digest: null }) }) });
  seed(empty);
  empty._repaintBoardSurface = () => {};
  await empty._loadWorkshopThemes('demo-app');
  assert.equal(empty._workshopThemes.digest, null);
  assert.match(workshopHtml(empty), /3 open items across 1 category\./);
});

// ── the three digest cards ───────────────────────────────────────────

/** A workshop-themes response body, with whatever digest shape a test wants. */
const responseBody = (over) => ({
  themes: [{ id: 't', name: 'Theming', items: ['issue:12'] }],
  source: 'ai', generatedAt: '2026-09-06T00:00:00Z', discoveredAt: '2026-09-06T00:00:00Z',
  stale: false, pending: false, pendingStage: null, lastError: null,
  coverage: null, unplaced: [], digest: null, digestCards: null, digestError: null,
  ...(over || {}),
});

async function loadWith(body) {
  const AppView = makeAppView({ fetch: async () => ({ ok: true, json: async () => body }) });
  seed(AppView);
  AppView._repaintBoardSurface = () => {};
  await AppView._loadWorkshopThemes('demo-app');
  return AppView;
}

test('the pane opens on Open alone, and the older windows are a walk back', async () => {
  const cards = {
    lastWeek: 'Kubernetes deploys, staging previews and email recovery, plus a Workshop pass.',
    thisWeek: 'The Workshop summary became three cards and mail now sends from a no-reply address.',
    open: 'Mostly mobile layout, the voting flow and a long tail of preview reliability.',
  };
  const AppView = await loadWith(responseBody({ cards: undefined, digestCards: cards }));
  assert.deepEqual(plain(AppView._workshopThemes.digestCards),
    { ...cards, older: [], firstWeek: null },
    'the normaliser keeps all three, and says the walk has no earlier steps');

  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-cards/);
  assert.ok(html.includes(cards.open), 'the present is what is drawn');
  for (const key of ['lastWeek', 'thisWeek']) {
    assert.ok(!html.includes(`data-ws-card="${key}"`), `${key} waits behind the control`);
    assert.ok(!html.includes(cards[key]), `and so does ${key}'s line`);
  }
  // The pane opens on the PRESENT and nothing else. All three windows used
  // to be drawn at once, which spent three cards of vertical space before
  // the board on two questions most readers were not asking — and was also
  // the whole history the lander could ever show. `open` is the default and
  // every earlier window is one press behind "Show past week".
  const order = [...html.matchAll(/data-ws-card="([a-zA-Z:0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['open'], 'only the present is drawn');
  const titles = [...html.matchAll(/dev-ws-card-title[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Open issues']);
  assert.match(html, /data-ws-week-more=""/, 'and the step back is offered');
  // BELOW the stack. It grew upwards first, which read like a timeline and
  // pushed the card you were looking at down the screen on every press; the
  // present stays put now and the history unrolls under it.
  assert.ok(html.indexOf('data-ws-card="open"') < html.indexOf('data-ws-week-more'));

  // The walk itself is the view model's, so the order and the titles are
  // pinned where the component cannot quietly re-sort them. Newest first,
  // which is the order they are drawn top to bottom.
  const weeks = AppView._workshopView().dashboard.weeks;
  assert.deepEqual(plain(weeks.map((w) => w.key)), ['open', 'thisWeek', 'lastWeek']);
  assert.deepEqual(plain(weeks.map((w) => w.title)), ['Open issues', 'This week', 'Last week']);

  // The tiles stay: the cards answer "what", the tiles still answer "how
  // much", and neither is a restatement of the other.
  assert.match(html, /data-ws-dash-cell="open"/);
  // And the cards sit IMMEDIATELY after the tiles inside the pane. That
  // adjacency is not decoration: dapp.json's declared check for this screen
  // selects `.dev-ws-dash + [data-ws-cards]`, and a wrapper slipped between
  // them would break the gate in staging with nothing here to say why.
  assert.match(html, /class="dev-ws-dash"[^>]*>.*?<\/div><div class="dev-ws-cards"/s,
    'the declared check selects the cards as the tiles\u2019 next sibling');
  // And the derived sentence stands down, as it does for the paragraph.
  assert.ok(!html.includes('open items across'), 'no count sentence beside the cards');
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');
});

test('a card is one line: an aligned label column and its sentence, no separator', async () => {
  const AppView = await loadWith(responseBody({
    digestCards: {
      lastWeek: 'the Dev screen became a styled Workshop, alongside many bug fixes.',
      thisWeek: 'summary cards got shorter, plus preview and sign-in work.',
      open: 'mostly QA triage, with older proposals still awaiting votes.',
    },
  }));
  const html = workshopHtml(AppView);

  // The title and the line are ADJACENT siblings. dapp.json's declared check
  // selects `.dev-ws-card-title + .dev-ws-card-line`, so anything rendered
  // between them would pass locally and fail the gate.
  assert.match(html, /<h4 class="dev-ws-card-title">Open issues<\/h4><p class="dev-ws-card-line">/,
    'nothing rendered between the label and the sentence');

  // NO separator, in either form. It was a CSS middot; with the labels in a
  // fixed column it was a second separator doing the column's job, and on the
  // short "Open" label it left a dot floating away from its word.
  const block = html.slice(html.indexOf('data-ws-cards'), html.indexOf('</div>', html.indexOf('data-ws-cards')));
  assert.ok(block.includes('data-ws-card="open"'), 'found the cards block');
  assert.ok(!block.includes('\u00B7'), 'no separator in the markup');
  assert.ok(!/\.dev-ws-card-title::(after|before)/.test(CSS), 'and none in the stylesheet either');

  // The fixed column is what makes the sentences share a left edge — the
  // whole reason the one-line layout is worth having. 84px cleared the three
  // original labels; the walk back adds "12 weeks ago" over a date range, so
  // the column is wider and the label is a stack.
  assert.match(CSS, /\.dev-ws-card-title \{[^}]*width: 104px;/, 'a column, not shrink-to-fit');
  assert.match(CSS, /\.dev-ws-card-title \{[^}]*flex-direction: column;/, 'the range sits under the name');
  assert.match(CSS, /\.dev-ws-card-title \{[^}]*color: var\(--accent\);/);
  assert.match(CSS, /\.dev-ws-card-title \{[^}]*font-size: 13\.5px;/);
  // Centred, not baseline: the label holds a two-row sentence rather than
  // sitting against its first line.
  assert.match(CSS, /\.dev-ws-card \{[^}]*align-items: center;/);

  // The lift, on the cards AND the four tiles. Both sit on the translucent
  // strip; --dc-sheet is #ffffff, so the inset hairline alone read flat.
  for (const sel of ['dev-ws-card', 'dev-ws-dash-cell']) {
    const rule = CSS.slice(CSS.indexOf(`.${sel} {`));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.ok(/var\(--app-sheet-line\) inset/.test(body), `${sel} keeps its hairline`);
    assert.ok(/var\(--app-sheet-shadow-near\)/.test(body) && /var\(--app-sheet-shadow-far\)/.test(body),
      `${sel} is lifted off the strip`);
  }
  // Both tokens must EXIST: one invalid var() voids the whole box-shadow,
  // hairline included, and the card renders with no outline at all.
  assert.match(CSS, /--app-sheet-shadow-near:/);
  assert.match(CSS, /--app-sheet-shadow-far:/);
  assert.match(CSS, /--accent:/);

  // Still a white card on a theme-aware token, not a literal.
  assert.match(CSS, /\.dev-ws-card \{[^}]*background-color: var\(--dc-sheet\);/);
  assert.match(CSS, /--dc-sheet: #ffffff;/);

  // AND THE ONE-LINE CARD IS A WIDE-VIEWPORT LAYOUT. It always was: a 104px
  // label column against a 14px sentence leaves ~250px of text on a 402px
  // phone, so every card wrapped to three rows and the "column of labels"
  // was a column of labels each floating beside a paragraph. Below 420px the
  // card stacks, which is the same information in two rows instead of four.
  const stack = CSS.slice(CSS.indexOf('@media (max-width: 419px)'));
  assert.match(stack.slice(0, 400), /\.dev-ws-card \{[^}]*flex-direction: column;/);
  assert.match(stack.slice(0, 400), /\.dev-ws-card-title \{[^}]*width: auto;/);

  // The dates only where the NAME stops being one: "This week" needs no
  // caption, "5 weeks ago" is arithmetic the reader should not have to do.
  const walk = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(walk, /w\.key\.startsWith\('week:'\)/, 'the range is drawn for the numbered windows only');
  assert.match(walk, /endMs - 86400000/, 'and an exclusive end is captioned with the Sunday before it');
});
test('an empty window draws no card at all', async () => {
  // The "(if any)" of the design. An empty string is how the server says the
  // window held nothing — a Monday morning, a board with nothing open — and
  // a card saying "nothing landed" is worse than no card, because it takes
  // the same space to say less.
  const AppView = await loadWith(responseBody({
    digestCards: { lastWeek: 'Kubernetes deploys and staging previews.', thisWeek: '', open: '' },
  }));
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-card="lastWeek"/);
  assert.ok(!html.includes('data-ws-card="thisWeek"'), 'no card for a week with nothing in it');
  assert.ok(!html.includes('data-ws-card="open"'));
  assert.ok(!html.includes('open items across'), 'and still no derived sentence');

  // All three empty is not a card set at all, so the pane falls through
  // rather than rendering an empty box with three titles in it.
  const none = await loadWith(responseBody({ digestCards: { lastWeek: '', thisWeek: '', open: '' } }));
  assert.equal(none._workshopThemes.digestCards, null);
  assert.ok(!workshopHtml(none).includes('data-ws-cards'));
  assert.match(workshopHtml(none), /3 open items across 1 category\./, 'the derived sentence is back');
});

test('a row written before the cards still says its paragraph', async () => {
  // The rolling-deploy state, and it lasts until each app's next reconcile:
  // the digest prompt version bump is what re-asks for the fields, and they
  // cannot be recovered from the prose, so `digest` alone has to keep
  // working. Paragraph over derived sentence, cards over paragraph.
  const AppView = await loadWith(responseBody({
    digest: 'In the last week, alice finished the sign-in work. Bob is on the mail templates now.',
  }));
  const html = workshopHtml(AppView);
  assert.ok(!html.includes('data-ws-cards'), 'no cards to draw');
  assert.match(html, /alice finished the sign-in work/);
  // The healthy case says NOTHING now: provenance under every working board
  // answered a question nobody had asked and cost a line to do it.
  assert.ok(!html.includes('data-ws-digest-note'), 'no caption on the ordinary case');

  // And when a row has both, the cards win — that is the direction of the
  // upgrade, and the paragraph is only ever the flattened same answer.
  const both = await loadWith(responseBody({
    digest: 'The flattened paragraph.',
    digestCards: { lastWeek: 'The last-week line.', thisWeek: '', open: '' },
  }));
  const bothHtml = workshopHtml(both);
  assert.match(bothHtml, /The last-week line\./);
  assert.ok(!bothHtml.includes('data-ws-digest-note'), 'and no provenance caption');
  assert.ok(!bothHtml.includes('The flattened paragraph.'), 'the prose form is not drawn beside them');
});

test('a malformed digestCards is no cards, not a broken pane', async () => {
  // Everything the server sends is normalised field by field here, and this
  // is the reason: a shape the renderer did not expect must degrade to the
  // paragraph, never throw inside the pane.
  for (const bad of ['a string', 42, [], { lastWeek: 7 }, { nope: 'x' }]) {
    const AppView = await loadWith(responseBody({ digestCards: bad, digest: 'The paragraph.' }));
    assert.equal(AppView._workshopThemes.digestCards, null, `${JSON.stringify(bad)} is not a card set`);
    assert.match(workshopHtml(AppView), /The paragraph\./);
  }
});

test('themes all start collapsed, and a deep link is what opens one', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13'] }]);
  // The first theme used to open itself. A lander whose every theme is shut
  // IS a list of headings, and a list of headings is what this screen is for.
  const shut = workshopHtml(AppView, 'all');
  assert.match(shut, /data-ws-theme="t"/);
  assert.ok(!shut.includes('dev-ws-theme-body'), 'nothing is opened for you');
  assert.ok(!shut.includes('dev-ws-theme-open'));

  // Which means the lanes are only reachable by tapping — so there is a URL
  // that reaches them, and the declared check for them rides it.
  AppView._workshopShot = 'themes';
  const open = workshopHtml(AppView, 'all');
  assert.match(open, /dev-ws-theme dev-ws-theme-open/);
  assert.match(open, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-row[^"]*"/);
  assert.ok(!open.includes('dev-feed-entry'), 'the theme only: every row in it stays folded');
  const check = dapp.tests.find((t) => /dev-ws-theme-body/.test(t.expectSelector || ''));
  assert.match(check.path, /shot=themes/);
});

test('since-your-last-visit sits with the other things addressed to you', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView);
  // It was a line under the tiles, inside "Where the app is", and that pane
  // answers a question about the APP. A list of what moved for this reader
  // is the same kind of thing as a vote they owe, so it rides the pane that
  // holds those — under the free-to-take lane, as the one item there that is
  // a record rather than a request.
  assert.match(html, /<section class="dev-ws-strip" data-ws-dashboard="">/, 'not on the dashboard any more');
  // SHOWN, not offered. It WAS one collapsed line with a caret, on the
  // reasoning that most visits do not need the fact; what that produced was
  // a strip nobody opened — the count said something had moved and the rows
  // saying WHAT were a press away, so the one block on the lander addressed
  // to this reader personally was also the only one they had to ask for.
  // The pane is open now and the LIST'S LENGTH is what is bargained: the
  // newest three, then `Show older`, which is the week walk's own bargain
  // one pane up.
  assert.match(html, /<section class="dev-ws-strip" data-ws-since="">/, 'a pane, always');
  assert.match(html, /class="dev-ws-since-head" data-ws-since-head=""/);
  assert.match(html, /class="dev-ws-since-label">Since your last visit<\/span><span class="dev-ws-since-n">3</);
  assert.ok(!html.includes('3d ago: 1 change landed'), 'and the summary line stays gone');
  assert.ok(!html.includes('dev-ws-since-line'), 'the old line is retired');
  // NOT A BUTTON, and nothing left that says it is one: a row that reads as
  // tappable and opens nothing is worse than a plain heading.
  assert.ok(!html.includes('data-ws-since-btn'), 'the disclosure is gone');
  assert.ok(!html.includes('dev-ws-since-chev'), 'and so is its caret');
  // Comments stripped: the rule that replaced it NAMES the old selector to say
  // what it replaces, and prose naming a selector is not the selector.
  assert.ok(!/\.dev-ws-since-row/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the pressable row rule went with it');
  // Three rows, because that is what the fixture has. The reveal is drawn
  // whatever the count (#2183, pinned below): with three new rows and one
  // the reader has already seen, it has somewhere to go.
  assert.equal((html.match(/data-ws-row="since:/g) || []).length, 3);
  assert.match(html, /data-ws-since-more=""(?! disabled)/, 'Show older, live, at exactly three');
  // The week walk's reveal keeps its own shape: centred under the stack of
  // full-width cards it belongs to.
  assert.match(CSS, /\.dev-ws-reveal-start \{[^}]*justify-content: flex-start;/);
  assert.match(CSS, /\.dev-ws-reveal \{[^}]*justify-content: center;/);
  assert.match(CSS, /\.dev-ws-reveal\[aria-expanded="true"\] \.dev-ws-reveal-chev \{[^}]*rotate\(180deg\)/,
    'the caret turns over once the rows are up');
  // Last on the status tab: everything above it is what the app IS, and
  // this is what changed for one reader.
  assert.ok(html.indexOf('data-ws-mine') < html.indexOf('data-ws-since'));
  // The sentence is NOT the button's label. `.gc-vote-btn` is a 24px
  // fixed-height pill sized for two or three words; carrying the whole
  // sentence in it set a min-content width wider than a phone and took the
  // entire lander into horizontal overflow. "Show 3" is what that pill is
  // for, and the sentence is the lane's note.
  assert.ok(!CSS.includes('.dev-ws-since-btn {'), 'the bespoke row is retired');
  assert.ok(!html.includes('1 change landed, 1 new issue, 1 new proposal</button>'));
});

// ── #2097: the heading's rules have to follow its markup ─────────────

test('the since heading is styled: each class it emits has a rule, and the count is a pill beside the label', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView);
  // The label and the count are two elements with nothing between them: the
  // air is the heading's flex gap, not a text space and not a margin of the
  // pill's own. So the moment the rules go, the markup reads as exactly what
  // it is — two inline spans — and the strip says "Since your last visit2".
  // That is what #2080 shipped: it rewrote the Needs-you tab and took these
  // rules out with that tab's CSS, while the strip had moved to Current
  // status in #2065 and its markup went on emitting the classes. Every
  // assertion above matched the markup and none of them looked for the
  // rules; this one does.
  const head = html.match(/<div class="dev-ws-since-head" data-ws-since-head="">([\s\S]*?)<\/div>/);
  assert.ok(head, 'the heading is drawn');
  const classes = [...head[1].matchAll(/<span class="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(classes, ['dev-ws-since-label', 'dev-ws-since-n'], 'the label, then the count, as two elements');
  // #2183: Clear rides the far end of the same row, after the count, and
  // there is still nothing between the label and the count but the gap.
  assert.match(head[1], /<\/span><span class="dev-ws-since-n">3<\/span><button type="button" class="dev-ws-since-clear" data-ws-since-clear="">Clear<\/button>$/,
    'label, count, Clear');
  // Comments stripped: a selector named in prose is not a selector.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const cls of ['dev-ws-since-head', ...classes, 'dev-ws-since-more']) {
    assert.match(stripped, new RegExp(`\\.${cls} \\{`), `.${cls} has a rule`);
  }
  assert.match(stripped, /\.dev-ws-since-head \{[^}]*display: flex;[^}]*gap: 8px;/,
    'the heading lays the two out with a gap');
  assert.match(stripped, /\.dev-ws-since-n \{[^}]*border-radius: 999px;/, 'the count is a pill');
  assert.match(stripped, /\.dev-ws-since-n \{[^}]*background: var\(--brand-tint\); color: var\(--brand-ink\);/,
    'in the brand tint, as it was');
});

test('the vote deck is its own tab; the unclaimed suggestion stays with the status', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView);
  // Voting is a SCREEN now. A decision deserves the whole of one and nothing
  // else competing for the tap; as one lane of three it read as one errand
  // among several. What is left in this strip is the thing that is not a
  // decision — an issue nobody has claimed.
  assert.ok(!html.includes('data-ws-votes'), 'the vote lane is gone from the status tab');
  assert.ok(!html.includes('data-ws-lane="next"'), 'and so is the free-to-take lane');
  assert.ok(!html.includes('data-ws-needs'), 'the deck is not drawn here either');
  // Both are QUESTIONS, so both are the Needs-you queue: the proposals owed
  // a vote first, the unclaimed issues behind them.
  const q = AppView._workshopView().queue;
  assert.deepEqual(plain(q.map((r) => r.kind)), ['vote', 'claim', 'claim']);
  // The claim question INVITES rather than interrogates: "Do you want to pick
  // this up?" reads as a duty being assigned, and the thing on offer is a
  // try, not a commitment.
  assert.deepEqual(plain(q.map((r) => r.ask)),
    ['Should this change go in?', 'Want to give this one a try?', 'Want to give this one a try?']);
  // And a claim carries ONE positive answer, not a pair. "No" and "Skip" were
  // the same press wearing two labels — neither recorded anything, both moved
  // the deck on — so the row no longer offers a `no` at all.
  assert.deepEqual(plain(q.filter((r) => r.kind === 'claim').map((r) => r.no)), [null, null]);
  assert.deepEqual(plain(q.filter((r) => r.kind === 'claim').map((r) => r.yes && r.yes.label)),
    ["Let's take it", "Let's take it"]);
  // The heading states the fact; the offer is the line under it. "Why not
  // give it a try?" did both at once and coaxed while it did.
  assert.ok(!html.includes('Free to take, if you want to try solving an issue.'),
    'the lane and its offer line went with it');
  // The declared check walks to a vote button; it rides the Needs-you tab
  // now, which `?ws=needs` reaches.
  const needs = workshopHtml(AppView, 'needs');
  assert.match(needs, /data-ws-needs=""[\s\S]*?data-ws-rail-btn="vote"/);
});

test('a quiet theme is not told it has never been built in', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'issue:13', 'session:78'] }]);
  const html = workshopHtml(AppView, 'all');
  // "nobody building yet" said something the data cannot know: the condition
  // is only that nothing is in flight RIGHT NOW, so a theme that shipped a
  // dozen changes read identically to one nobody has ever touched.
  assert.ok(!html.includes('nobody building yet'));
  assert.match(html, /1 shipped this week, nothing in flight now/);

  // …and with nothing shipped either, it says only what it knows.
  AppView._merged = [];
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  assert.match(workshopHtml(AppView, 'all'), /1 involved · nothing in flight right now/);
});

// ── the stylesheet has to PARSE, not merely contain the right text ───

test('no comment in app.css closes early, and no rule has prose for a selector', () => {
  // #1793 shipped an open-state block whose comment carried a second
  // terminator. The comment closed four lines early, the prose that followed
  // became a qualified rule's prelude — and a prelude runs to the first brace,
  // so it swallowed the three rules under it as one invalid selector and the
  // browser dropped all of them. The open row kept its four corners and the
  // entry kept its own frosted ring: the two boxes the block was written to
  // remove, shipped as the fix for them.
  //
  // Every other CSS assertion in this file is a regex over the TEXT, so they
  // all matched while the browser was discarding the rules. These two look at
  // the structure instead.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  assert.ok(!stripped.includes('*/'),
    'a comment terminator outside a comment means an earlier comment closed before it meant to');

  const bad = [];
  let depth = 0;
  let buf = '';
  for (const ch of stripped) {
    if (ch === '{') {
      if (depth === 0 && /[`—]/.test(buf)) bad.push(buf.trim().replace(/\s+/g, ' ').slice(0, 70));
      depth += 1;
      buf = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buf = '';
    } else if (depth === 0) {
      buf += ch;
    }
  }
  // A backtick or an em dash is prose. Neither can appear in a CSS selector,
  // and both are everywhere in this file's comments — so one in a prelude is
  // a comment that leaked into the cascade.
  assert.deepEqual(bad, [], 'these selectors are prose, so the rules under them are being dropped');
});

// ── #1787: the dashboard, and the one thing to pick up ───────────────

test('the dashboard reads a rate, not just a count, and says when it is a floor', () => {
  const AppView = makeAppView();
  seed(AppView);
  // #2176: the weeks are calendar weeks (Monday 00:00 UTC), so the fixtures
  // sit relative to this week's Monday rather than to today.
  const monday = AppView._weekStart(Date.now());
  const iso = (ms) => new Date(ms).toISOString();
  AppView._merged = [
    { id: 78, pr_number: 40, pr_title: 'This week', status: 'merged', username: 'alice', merged_at: iso(monday + 3600000), created_at: iso(monday + 3600000), row_type: 'pr' },
    { id: 79, pr_number: 39, pr_title: 'Also this week', status: 'merged', username: 'bob', merged_at: iso(monday + 7200000), created_at: iso(monday + 7200000), row_type: 'pr' },
    { id: 80, pr_number: 38, pr_title: 'Last week', status: 'merged', username: 'bob', merged_at: iso(monday - 3 * 86400000), created_at: iso(monday - 3 * 86400000), row_type: 'pr' },
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 2);
  assert.equal(d.shippedPrevWeek, 1, 'the week before, from the same source, so the two compare');
  assert.equal(d.partial, false);

  // The merged history is paged. With more behind it the counts are floors,
  // and the view has to say so rather than reporting a page as the record.
  AppView._mergedHasMore = true;
  assert.equal(AppView._workshopView().dashboard.partial, true);
});

test('#1922: the server\'s whole-history week counts replace the page count and its "+"', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  // A full page with more behind it — the case that used to read "20+".
  AppView._mergedHasMore = true;
  AppView._mergedShipped = { week: 34, prevWeek: 27 };
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 34, 'the real number, not what the page holds');
  assert.equal(d.shippedPrevWeek, 27, 'the week before, from the same count');
  assert.equal(d.partial, false, 'an exact count is never a floor');
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-dash-cell="shipped"[^>]*><b>34<\/b>/, 'no "+" on the tile');
  assert.ok(!html.includes('title="At least this many'), 'and no floor tooltip');

  // An older server sends no counts: the page is counted and flagged, as before.
  AppView._mergedShipped = null;
  const fallback = AppView._workshopView().dashboard;
  assert.equal(fallback.partial, true);
  assert.notEqual(fallback.shippedWeek, 34);
});

test('#1922: the loader keeps the server\'s week counts, and only well-formed ones', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8');
  assert.match(src, /const shipped = mergedData\.shipped;\s*AppView\._mergedShipped = shipped\s*&& Number\.isFinite\(shipped\.week\) && Number\.isFinite\(shipped\.prevWeek\)/);
  assert.match(src, /partial: !serverShipped && !!AppView\._mergedHasMore,/);
});

test('"try taking this one next" names an open issue nobody is on', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Issue 12 is the more recent of the two, so it is the one offered.
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:12');
  assert.equal(AppView._workshopView().dashboard.unclaimed, 2);

  // A live claim, a running session or an assignee all take it out.
  AppView._ghIssues[0].in_progress = { claims: [{ username: 'dana' }] };
  assert.equal(AppView._workshopView().nextUp.key, 'next:issue:13', 'the claimed one is skipped');
  AppView._ghIssues[1].assignee = { top: 'erin' };
  assert.equal(AppView._workshopView().nextUp, null);
  assert.equal(AppView._workshopView().dashboard.unclaimed, 0);
});

test('#1934: the rest of the unclaimed issues are the rest of the deck', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12', 'issue:13'] }]);
  const v = AppView._workshopView();
  // Two unclaimed issues: 12 is offered, 13 is the "more".
  assert.equal(v.nextUp.key, 'next:issue:12');
  // Joined: the arrays come from the AppView sandbox's own realm.
  assert.equal(v.nextMore.map((r) => r.key).join(','), 'next:issue:13', 'same order, same next: keys');
  // #1934's "Show N more" list became a sideways deck, and then the whole
  // lane moved: an unclaimed issue asks "will you take this?", which is the
  // same shape of question as "should this go in?", so both are the
  // Needs-you queue with the issues behind the proposals.
  assert.ok(!workshopHtml(AppView).includes('data-ws-lane="next"'),
    'nothing on the status tab any more');
  assert.deepEqual(plain(v.queue.filter((r) => r.kind === 'claim').map((r) => r.key)),
    ['need:issue:12', 'need:issue:13'], 'same order, behind the votes');
  // The feed draws EVERY item (the fillers and the deep links need the rows
  // in the DOM), votes first. The question itself is on the Vote sheet,
  // which opens on a press; at rest an item says what kind of thing it is.
  const needs = workshopHtml(AppView, 'needs');
  assert.match(needs, /data-ws-item="vote:[^"]+" data-ws-kind="vote"[\s\S]*?Proposal · needs your vote/, 'the first item is a vote');
  assert.match(needs, /data-ws-kind="claim"[\s\S]*?Open issue · nobody on it/, 'the claims follow');
  assert.ok(!needs.includes('data-ws-ask-q'), 'the question is on the sheet, not on the item');
  assert.ok(!needs.includes('data-ws-next-more'), 'the vertical reveal is long retired');

  // Capped like a theme lane.
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'public/js/app-view.js'), 'utf8'),
    /idle\.slice\(1, 1 \+ AppView\.WORKSHOP_LANE_MAX\)/);

  // One unclaimed issue → one claim question in the queue.
  AppView._ghIssues[1].assignee = { top: 'erin' };
  const one = AppView._workshopView();
  assert.equal(one.nextMore.length, 0);
  assert.equal(one.queue.filter((r) => r.kind === 'claim').length, 1);
});

test('#1934: a filter drops the "more" along with the suggestion', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark' };
  assert.equal(AppView._workshopView().nextMore.length, 0);
});

test('an issue already being worked on is never the one offered', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A promoted proposal against issue 12 moves it into the `underway` lane.
  // It carries no claim and no assignee, so only the LANE rules it out — and
  // offering it would name a card the viewer can see being built two strips
  // further down the same page.
  AppView._proposals[0].linked_issues = ['12'];
  const v = AppView._workshopView();
  assert.equal(v.nextUp.key, 'next:issue:13', 'the quiet one, not the busy one');
  assert.equal(v.dashboard.unclaimed, 1);
});

test('the suggestion stands down while a filter is active', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'dark' };
  // A narrowed board is somebody looking for something specific; offering
  // them a different card is an interruption, not an invitation.
  assert.equal(AppView._workshopView().nextUp, null);
});

test('the strips are ordered for a returning member: state, then what to do, then what changed', () => {
  const store = {};
  // Keep the three-day-old proposal strictly after the last visit instead
  // of relying on whether seed() happens in a later clock millisecond.
  store[`${'workshopSeen'}:demo-app`] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const html = workshopHtml(AppView);
  const order = ['data-ws-dashboard', 'data-ws-discussion', 'data-discussion-row', 'data-ws-since-head']
    .map((k) => html.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `every strip is drawn: ${JSON.stringify(order)}`);
  assert.deepEqual(order.slice().sort((a, b) => a - b), order,
    'where the app is, where to talk, and then the one line about what changed');
  // The order changed with the "since" move: the pane used to lead with what
  // had moved for this reader, which put a personal footnote above the app's
  // own state. What is left on this tab is the app itself, the door to its
  // chat, and one line about what changed — the questions are a tab away.
  assert.ok(!/class="dev-ws-link"[^>]*aria-expanded/.test(html), 'no unsized text link toggles this pane');
  assert.match(html, /class="dev-ws-since-head" data-ws-since-head=""/,
    'the since block is a pane with a heading, not a disclosure');
  assert.match(html, /class="dev-ws-since-n">3</, 'with the count on it');
  assert.ok(!html.includes('waiting on votes ·'), 'and the bare number line is gone');
});

// ── #1787: the row is the card, folded ───────────────────────────────

test('a folded row\'s last line carries the card\'s state, in the tone the pill already had, with the vote at its right', () => {
  const AppView = makeAppView();
  seed(AppView);
  // #1442's case: green checks on a proposal that no longer merges. The one
  // fact that decides whether it can land at all.
  AppView._proposals[0].mergeability = 'conflict';
  AppView._proposals[0].mergeability_files = ['src/a.js', 'src/b.js'];
  // Folded rows live in the theme lanes now that the vote strip is a tab of
  // its own, and a theme ships shut — `?shot=themes` is the URL that opens
  // the first one, which is what the declared check for the lanes rides.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');

  assert.match(html, /<span class="dev-ws-row-band">/,
    'the row has a last line of its own: the card\'s status row and facts row in one');
  // The row's state line is the BAR, and the bar is the vote. The fact that
  // decides whether it can land at all rides beside it as a red tag — which
  // the row already had a seat for, because RowBand draws the card's state
  // chips after the pill at both sizes.
  assert.match(html, /class="dev-ws-row-state dev-ws-row-state-progress"[^>]*>Vote · \d+\/\d+</,
    'the state line carries the vote, in the vote\u2019s tone');
  // The blocker is a red tag on the row's META line — beside the number and
  // the author, with the item's own tags — not on the band. The band is the
  // vote and the Vote button, at both sizes.
  assert.match(html, /<span class="dev-badge [^"]*red[^"]*"[^>]*>Conflicts with main · 2 files<\/span>/);
  assert.ok(html.indexOf('Conflicts with main') < html.indexOf('dev-ws-row-band'),
    'the tag is above the band, on the meta line');
  assert.ok(!html.includes('dev-ws-row-pill'),
    'it is no longer flattened to plain text in the grey the author\'s name wears');

  // The line is clipped to one for the same reason the dense card's rows are:
  // a row that grew with its state would break the column's rhythm. The vote
  // button sits at its right end, where the card's bar puts it.
  assert.match(CSS, /\.dev-ws-row-band \{[^}]*flex-wrap: nowrap;[^}]*overflow: hidden;/);
  assert.match(CSS, /\.dev-ws-row-band > \.dev-ws-row-trailing \{ margin-left: auto; \}/);
  assert.match(html, /<span class="dev-ws-row-band">[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/,
    'the vote rides the last line, not the row\'s middle-right');
  // It does NOT stand down when the row opens any more — see the open-state
  // test below. The head is identical in both sizes, and the duplicate is the
  // card's band, not this one.
  assert.ok(!/\.dev-ws-row-open \.dev-ws-row-band \{ display: none/.test(CSS));
});

test('an open row IS the Board\'s card, not a headless copy under a row', () => {
  const unfolded = FOLD.slice(FOLD.indexOf('function UnfoldedRow'), FOLD.indexOf('function voteSpecs'));
  assert.match(unfolded, /<DevCard model=\{card\} actionEnd=\{placement \? openBtn : undefined\} headEnd=\{<FoldMark open onClick=\{onFold\} \/>\} \/>/);

  // #1799 kept the compressed row as a head and hid the card's head, meta and
  // status band so they would not repeat it — which made the open state a
  // third object belonging to neither size. Those rules are GONE, and the card
  // keeps every bit of chrome the Board gives it.
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-head/.test(CSS), 'the head is drawn');
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-meta/.test(CSS), 'the meta line is drawn');
  assert.ok(!/\.dev-ws-rowwrap-open[^{]*\.dev-card-status/.test(CSS), 'the status band is drawn');
  assert.ok(!/dev-ws-rowwrap-open > \.dev-feed-entry > div:is\(\.dev-card-dense\)/.test(CSS),
    'and the card is not de-chromed');

  // The wrapper renders ONE of the two, never both.
  const wrap = FOLD.slice(FOLD.indexOf('function CardRowView'));
  assert.match(wrap, /\{open \? \(/);
  assert.match(wrap, /<UnfoldedRow row=\{row\}/);
  assert.match(wrap, /<FoldedRow row=\{row\}/);
  assert.ok(wrap.indexOf('<UnfoldedRow') < wrap.indexOf('<FoldedRow'), 'open first, folded in the else');

  // Clicking the open card closes it. The delegated #dev-body handler is
  // bound BELOW the portal's React root, so a synthetic stopPropagation here
  // would arrive after it had navigated; the hooks used to come off the open
  // card's model for that reason. The handler now stands aside for any click
  // inside a fold wrapper instead, so the model keeps the hooks the checks
  // select on, at BOTH sizes, and the Board's columns can fold the same way.
  assert.match(APP_VIEW_SRC, /if \(AppView\._inFoldWrapper\(e\)\) return;/);
  assert.ok(!/function withoutOpenHooks/.test(FOLD) && !/withoutOpenHooks/.test(WORKSHOP), 'nothing strips them any more');
  assert.match(FOLD, /\{\.\.\.itemHooks\(c\)\}/, 'the folded row carries the item\u2019s hooks too');
  assert.ok(!/onCollapse/.test(FOLD), 'and there is no Collapse control');
});

test('a theme head counts its people AND how much is still open in it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  const html = workshopHtml(AppView, 'all');
  // Two issues open + one proposal in review = 3. The merge is NOT counted:
  // the number answers "how much is left in here", and shipped work is not.
  assert.match(
    html,
    /<span class="dev-ws-stat"><b>\d+<\/b>(?:person|people)<\/span><span class="dev-ws-stat"><b>3<\/b>items<\/span>/,
    'people and items, side by side',
  );
  assert.match(CSS, /\.dev-ws-stat \+ \.dev-ws-stat \{[^}]*border-left:/, 'divided by a hairline');
});

test('a theme wears the glyph the model chose, or its initial when there is none', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', icon: '🎮', items: ['issue:12'] }]);
  assert.match(workshopHtml(AppView, 'all'), /<span class="dev-ws-theme-icon" aria-hidden="true">🎮<\/span>Game Corner/);

  // A row written before icons existed, or an answer the sanitiser rejected:
  // the initial on the name's own swatch, which reads as chosen where a
  // hashed-from-the-name emoji would be stable and meaningless.
  AppView._workshopThemes = themes([{ id: 't', name: 'Game Corner', items: ['issue:12'] }]);
  assert.match(
    workshopHtml(AppView, 'all'),
    /class="dev-ws-theme-icon dev-ws-theme-icon-letter"[^>]*>G<\/span>Game Corner/,
  );
});

test('"Shipped this week" opens folded, so a theme opens on what still needs someone', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }]);
  // Every theme starts shut, so the lanes are only on the page behind the
  // deep link that opens one. It names a theme and no row, which is exactly
  // the state this is about.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');
  assert.match(html, /data-ws-lane="shipped"/, 'the lane is still drawn — the fold is not a removal');
  assert.match(html, /<h4 class="dev-ws-lane-title" role="button" tabindex="0" aria-expanded="false">/,
    'and it is a disclosure, closed');
  assert.ok(!html.includes('Landed thing'),
    'the merge it holds is not in the DOM until someone opens the lane');
  assert.match(html, /<span class="dev-ws-lane-n">1<\/span>/,
    'but the count rides in the heading, so the fold never hides how much is in there');
  // Every other lane is unaffected.
  assert.match(html, /data-ws-lane="open"[\s\S]{0,400}?class="dev-ws-row[^"]*"/);
});

// ── #1787: a filter changed ON THE WORKSHOP has to stick ─────────────
//
// Both halves of a filter change — persist it, and tell the bar what it now
// says — used to sit inside `_repaintKanbanBoard`, which the Workshop never
// reaches. So on this surface a filter was a scratch value: nothing saved it,
// the next `_repaintDevBody` reloaded the stored set over it, and the chip row
// never moved, so a chip's × widened the themes and stayed on screen.

test('a filter set on the Workshop is persisted, and clearing it is persisted too', () => {
  const store = {};
  const AppView = makeAppView({ sessionStore: store });
  seed(AppView);
  assert.equal(AppView._getViewMode(), 'workshop', 'the Workshop is the default surface');

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, 'high',
    'the Workshop path saves — _repaintKanbanBoard is not the only funnel');

  AppView._dismissKanbanFilter('priority');
  assert.equal(AppView._loadKanbanFilters('demo-app').priority, null,
    'and the clear is saved, so the next repaint cannot put it back');
});

test('the Workshop republishes the filter bar, so a chip\'s × actually clears the chip', () => {
  const AppView = makeAppView({
    document: {
      getElementById: (id) => (id === 'dev-kanban-filterbar' ? {} : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
  });
  seed(AppView);
  const published = [];
  AppView._publishKanbanFilters = (v) => published.push(plain(v));

  AppView._kanbanFilters.priority = 'high';
  AppView._repaintBoardSurface();
  assert.equal(published.length, 1, 'the Workshop tells the bar a filter went on');
  assert.equal(published[0].count, 1);

  AppView._dismissKanbanFilter('priority');
  assert.equal(published.length, 2);
  assert.equal(published[1].count, 0, 'and that it came back off');
  assert.deepEqual(published[1].chips, [], 'the chip row is emptied, not left showing a dead chip');
});

test('the Workshop restores the stored filters on an app switch, not on every repaint', () => {
  const AppView = makeAppView();
  // The slug the in-memory set belongs to is what tells a repaint apart from
  // an app switch. Unguarded, `_repaintDevBody` reloaded on every paint and
  // discarded whatever the viewer had just done here.
  assert.equal(AppView._kanbanFiltersSlug, null, 'nothing loaded yet');
  const branch = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('<div id="dev-workshop"></div>'));
  assert.match(branch.slice(0, branch.indexOf('_rerenderWorkshop();')),
    /if \(AppView\._kanbanFiltersSlug !== App\.currentApp\) \{\s*\n\s*AppView\._kanbanFilters = AppView\._loadKanbanFilters\(App\.currentApp\);/,
    'the reload is behind the slug guard');
});

test('the theme filter constrains sessions too, not just issues and proposals', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  const f = { ...AppView._defaultKanbanFilters(), theme: 't' };
  // A session sits in a theme by the issue it links, exactly as the Workshop
  // places it. It used to return `true` before the theme check ran at all, so
  // with a theme selected every session matched every theme and a theme's
  // Underway lane showed other themes' work.
  assert.equal(AppView._devCardMatches('session', { id: 90, linked_issues: ['12'] }, f), true);
  assert.equal(AppView._devCardMatches('session', { id: 91, linked_issues: ['13'] }, f), false);
  assert.equal(AppView._devCardMatches('session', { id: 92, linked_issues: [] }, f), false);
  // Priority and category stay a no-op there — a session carries neither.
  const byPriority = { ...AppView._defaultKanbanFilters(), priority: 'high' };
  assert.equal(AppView._devCardMatches('session', { id: 93, linked_issues: [] }, byPriority), true);
});

test('"Open on Board" narrows the board to the theme and goes there by hash', () => {
  const AppView = makeAppView({ location: { search: '', hash: '', href: 'http://localhost/' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12'] }]);
  AppView.openBoardForTheme('t');
  assert.equal(AppView._kanbanFilters.theme, 't');
  assert.equal(AppView._loadKanbanFilters('demo-app').theme, null,
    'sessionStorage is stubbed empty here; the write is the module\'s _saveKanbanFilters');
});

// ── the component ────────────────────────────────────────────────────

test('the Workshop renders its strips, its themes and its folded rows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'Looks.', saying: 'Dark mode should stick.', items: ['issue:12', 'session:34', 'session:78'] }]);
  // Themes start shut; `?shot=themes` is the URL that opens one with every
  // row in it still folded, which is what the lanes below are asserted on.
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');
  // The folded row is a row and not a card: the card's own Vote button sits
  // INSIDE it at the trailing edge, which is why the row is a div with the
  // button role and not a <button>. A proposal row lives in its theme's
  // review lane now that the vote strip is a tab of its own.
  assert.match(html, /<div role="button" tabindex="0" class="dev-ws-row[^"]*"[^>]*data-ws-row="proposal:34"[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/,
    'a proposal row is the folded row with the vote button inside it');
  assert.ok(!/<button[^>]*>[^<]*<button/.test(html), 'and no button nests in a button');
  // "Open on Board" sits at the bottom of the theme, not under a lane.
  assert.match(html, /<div class="dev-ws-theme-more">[\s\S]*?Open on Board ›/);
  assert.ok(!/dev-ws-more[\s\S]{0,80}Open on Board/.test(html), 'no lane carries its own');
  // The dashboard and the discussion are the OTHER tab's; this one is the
  // board and only the board.
  assert.ok(!html.includes('data-ws-dashboard'), 'the dashboard is not on this tab');
  assert.ok(!html.includes('data-discussion-row'), 'nor the discussion row');
  assert.match(workshopHtml(AppView), /data-ws-dashboard=""/, 'they are on Current status');
  assert.match(html, /data-ws-theme="t"/, 'the theme');
  assert.match(html, /Dark mode should stick\./, 'with its saying');
  // The first theme opens by default, and its rows are folded disclosures.
  // Each carries the item's own hook — `data-issue-row` on an issue's — so
  // the lookups and the checks that name an item by it find the row too;
  // the delegated #dev-body handler stands aside inside a fold wrapper
  // (card/fold.tsx's header), so the hook no longer opens it full-screen.
  assert.match(html, /<div role="button" tabindex="0" class="dev-ws-row[^"]*"[^>]*data-ws-row="issue:12"/);
  assert.match(html, /<div role="button"[^>]*data-ws-row="issue:12"[^>]*data-issue-row="12"/, 'the folded row carries the issue-row hook');
  assert.match(html, /data-ws-lane="review"/);
  assert.match(html, /data-ws-lane="shipped"/);
  assert.ok(!html.includes('dev-feed-entry'), 'nothing is unfolded on a plain paint');
  assert.match(html, /aria-pressed="true">By people</, 'the default order is by people');
});

test('a folded row wears the card\u2019s own edge, number and glyph, and no chevron', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', items: ['issue:12', 'session:34'] }]);
  AppView._workshopShot = 'themes';
  const html = workshopHtml(AppView, 'all');

  // The EDGE, from the card's own edgeFor: an issue with no state wears its
  // type's amber, a proposal wears its BAR's tone. The row used to carry that
  // colour as a tinted icon tile the card does not have, so one item opened
  // on a different mark at each size.
  //
  // This proposal is mid-checks and used to wear `neutral`, because the bar
  // said "Checks starting…". The bar is the vote now, so the edge follows the
  // vote — which is the edge doing its job, not a regression: the colour down
  // the side of a row answers the same question the bar does.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="attention"[^>]*data-ws-row="issue:12"/);
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="vote"[^>]*data-ws-row="proposal:34"/);
  assert.match(CSS, /\.dev-ws-row\[data-edge="vote"\]\s+\{ --dev-edge: var\(--accent\); \}/);
  assert.match(CSS, /\.dev-ws-row \{[^}]*inset var\(--dev-edge-w\) 0 0 color-mix/,
    'drawn as the card draws it: an inset shadow at the same width, not a border');

  // The NUMBER: the card's own meta line, node for node (metaLineNodes), so
  // the row's number is the same link the card's is, "PR#41" and "#12" alike.
  // (The row used to re-derive it and matched only "#41", so every proposal
  // row was missing the thing people cite it by.)
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*" target="_blank" rel="noopener" class="font-mono[^"]*"[^>]*>PR#41<\/a>/);
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*" target="_blank" rel="noopener" class="font-mono[^"]*"[^>]*>#12<\/a>/, 'and an issue is unchanged');
  assert.match(FOLD, /<span className="dev-ws-row-meta">\{metaLineNodes\(c\)\}<\/span>/, 'one builder for both sizes');
  assert.match(FOLD, /closest\('a, button'\)\) return;/, 'a click on the link is the link\'s, not the row\'s');

  // The GLYPH. Same 22px box, no tile, same 18px mark as the card's.
  assert.match(CSS, /\.dev-ws-row-head > \.dev-card-icon \{[^}]*width: 22px;[^}]*background: transparent/);
  assert.match(CSS, /\.dev-ws-row-head > \.dev-card-icon > svg \{ width: 18px; height: 18px; \}/);

  // And no chevron: it promises a destination the row does not have.
  const rows = html.split('data-ws-row="').slice(1);
  assert.ok(rows.length, 'there are folded rows to check');
  for (const r of rows) {
    assert.ok(!r.slice(0, r.indexOf('</div>')).includes('dev-ws-chev'), 'a folded row draws no chevron');
  }
  assert.match(html, /dev-ws-theme-foot[\s\S]*?dev-ws-chev/, 'a theme header still does');
});

test('the card\u2019s facts line keeps its chips instead of flattening them', () => {
  // "Closes #1575 · @alice · design" was drawn as muted text with a dot
  // between, so the two facts most worth not skipping on a proposal card
  // read as a byline. The Workshop's folded row kept them as chips, which
  // is the treatment that won.
  assert.ok(!/\.dev-card-status > \.dev-badge \{[^}]*background: transparent/.test(CSS),
    'the flattening is gone');
  assert.ok(!/\.dev-card-status > \.dev-badge \+ \.dev-badge::before/.test(CSS),
    'and so is the dot that stood in for the gap between pills');
  assert.match(CSS, /:is\(\.dev-card-status, \.dev-card-facts\) > \.dev-badge \{\s*height: 19px;/);
  // The facts are a row of their own under the status row now, clipped at
  // one line and tabbed in with the meta line; the one band with a break in
  // it, and the 60px it clipped at, are gone.
  assert.match(CSS, /\.dev-card-badges\.dev-card-facts \{[^}]*max-height: 22px;/);
  assert.match(CSS, /\.dev-card-head:has\(> \.dev-card-icon\) ~ \.dev-card-facts \{ padding-left: 30px; \}/);
  assert.ok(!/max-height: 60px;/.test(CSS));
  assert.ok(!/dev-card-band-break|dev-card-status-end/.test(CSS));
});

test('Open card builds the topic screen\u2019s own sections, without navigating', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Resolved from the CARD KEY alone. There is no `_devTopic` and there must
  // not be one: opening a card in place is not navigation, and the topic
  // store holds the one screen the app is actually on.
  const body = AppView._workshopCardBody('proposal:34');
  assert.ok(body, 'a live proposal resolves');
  assert.ok('details' in body, 'the ledger the topic screen draws');
  assert.ok('aboutTitle' in body, 'and the About sheet\u2019s heading');
  assert.equal(body.comments, false,
    'but not the GitHub host: #dev-issue-comments is a singleton id and the sheet already carries both threads');
  assert.equal(AppView._devTopic, null, 'and nothing navigated');

  assert.equal(AppView._workshopCardBody('issue:12').issueBodyHtml !== undefined, true, 'issues too');
  assert.equal(AppView._workshopCardBody('proposal:99999'), null, 'an item the board no longer holds');
  assert.equal(AppView._workshopCardBody('nonsense'), null, 'and a key that is not one');

  // The sheet renders it under the card, and the toggle rides in the card's
  // own action band — the Board's seat too — rather than in a strip below it.
  const unfolded = FOLD.slice(FOLD.indexOf('function UnfoldedRow'), FOLD.indexOf('function voteSpecs'));
  assert.match(unfolded, /actionEnd=\{placement \? openBtn : undefined\}/, 'the band seat, on both surfaces');
  assert.match(unfolded, /detail: placement = 'actions',/, 'and it is the default, so the Workshop passes nothing');
  assert.match(unfolded, /<TopicBodySections body=\{detail\} \/>/);
  assert.match(unfolded, /detail \? 'Close card' : 'Open card'/);
  assert.match(unfolded, /readAppView<TopicBody>\('_workshopCardBody', key\)/,
    'built on demand: a lander of forty rows must not build forty topic bodies to draw none');
  assert.ok(!unfolded.includes('Open card \u203a'), 'the link out is no longer what "Open card" means');
});

test('the open card collapses on a click at the card, not at what it opened', () => {
  // The wrapper's click closes the row. With a ledger, a thread and a comment
  // list open under the card there is a lot of prose to land on, and
  // collapsing the item because somebody selected a word in it loses their
  // place — so the three regions below the card are excluded alongside the
  // controls. `details` is the merge-requirements checklist (#2128): a
  // disclosure the reader taps open, not a place to fold from.
  const view = FOLD.slice(FOLD.indexOf('function CardRowView'));
  for (const sel of ['a', 'button', 'input', 'textarea', 'select', 'form', 'details',
    '\\[data-attr-chip\\]', '\\[data-issue-chip\\]',
    '\\.dev-ws-detail', '\\.dev-feed-thread', '\\.dev-feed-comments']) {
    assert.match(view, new RegExp(sel), `the guard excludes ${sel}`);
  }
  assert.match(view, /el\.closest\(/, 'and it is a closest() test, not a target equality one');
});

test('the vote badge is a ring AND the count in words, and cannot be closed', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals = [
    { id: 71, pr_number: 71, pr_title: 'A', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: 'yes' },
    { id: 72, pr_number: 72, pr_title: 'B', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: null },
    { id: 73, pr_number: 73, pr_title: 'C', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(3), promoted_at: at(3), linked_issues: [], my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.equal(v.votes.count, 2);
  assert.equal(v.votes.total, 3);

  const html = workshopHtml(AppView, 'needs');
  // THE RING IS GONE, and so are the words that counted the debt. A feed
  // has one counter — where you are in it — and the eyebrow says what the
  // item in front of you IS, not how many are behind it. The total shows
  // once, on the end card, which is the only place it is news.
  assert.ok(!html.includes('dev-ws-vote-ring'), 'no ring');
  assert.ok(!/proposals? needs? your vote</.test(html), 'no debt in words');
  assert.match(html, /class="dev-ws-eyebrow">Proposal · needs your vote</, 'the kind, per item');
  assert.match(html, /class="dev-ws-item-of">1 \/ \d+</, 'and the place in the feed');
  assert.ok(!html.includes('dev-ws-needs-count'), 'the strip-head pair is retired');
  assert.ok(!CSS.includes('.dev-ws-needs-count {'), 'and so is its rule');
  assert.ok(!CSS.includes('.dev-ws-needs-end {'), 'and the wrapper it sat in');
  assert.ok(!CSS.includes('.dev-ws-vote-ring {'), 'and the ring\'s');

  // And no ×. A count that can be closed is a count somebody stops seeing
  // while it is still true.
  assert.ok(!html.includes('data-ws-needs-close'), 'the dismissal is gone');
  assert.ok(!WORKSHOP.includes('ws-needs-you-dismissed'), 'and so is the key it wrote');
});

test('an item names its kind; no sentence counts what is owed', () => {
  const AppView = makeAppView();
  seed(AppView);
  const html = workshopHtml(AppView, 'needs');
  assert.match(html, /class="dev-ws-eyebrow">Proposal · needs your vote</);
  assert.ok(!/1 proposal needs your vote</.test(html), 'the sentence that counted the debt is gone');
});

test('a governance proposal you opened is your work in flight too (#2227)', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [];
  AppView._proposals = [];
  AppView._govProposals = [
    { id: 701, kind: 'close_issue', title: 'Close issue #12: "Stale thing"', created_by: 1,
      created_by_username: 'me', created_at: at(1), last_message_at: at(1), my_vote: null, status: 'open' },
    { id: 702, kind: 'close_issue', title: 'Close issue #13: "Theirs"', created_by: 9,
      created_by_username: 'carol', created_at: at(2), last_message_at: at(2), my_vote: null, status: 'open' },
  ];
  const v = AppView._workshopView();
  assert.deepEqual(plain(v.mine.rows).map((r) => r.key), ['mine:gov:701'],
    'mine, not theirs');
  assert.ok(!plain(v.votes.rows).some((r) => r.key.includes('gov:701')),
    'and not also owed a vote in the pane below');
  assert.ok(plain(v.votes.rows).some((r) => r.key.includes('gov:702')), 'theirs is still waiting on you');
  assert.match(workshopHtml(AppView), /data-ws-lane="mine"/);
});

test('the viewer\u2019s own work in flight leads the lander', () => {
  const AppView = makeAppView();
  seed(AppView);
  // A session of mine, a proposal of mine, and one of somebody else's.
  AppView._mySessions = [{ id: 51, session_title: 'Bottom tabs', pr_number: null, last_activity_at: at(0) }];
  AppView._proposals = [
    { id: 61, pr_number: 61, pr_title: 'Mine', status: 'promoted', username: 'me', user_id: 1,
      created_at: at(2), promoted_at: at(2), last_message_at: at(2), linked_issues: [], my_vote: null },
    { id: 62, pr_number: 62, pr_title: 'Theirs', status: 'promoted', username: 'carol', user_id: 9,
      created_at: at(1), promoted_at: at(1), last_message_at: at(1), linked_issues: [], my_vote: null },
  ];
  const v = AppView._workshopView();
  assert.equal(v.mine.count, 2, 'my session and my proposal, not theirs');
  // And the vote strip does not repeat it. "Waiting on you" asks whether you
  // have voted, not whose it is, so a promoted proposal of your own answered
  // both panes and appeared twice, one under the other.
  assert.ok(!plain(v.votes.rows).some((r) => r.key.includes('proposal:61')),
    'your own proposal is not also owed a vote from you');
  assert.equal(v.votes.count, 1, 'only theirs');
  assert.equal(v.mine.shown, AppView.WORKSHOP_MINE_MAX);
  assert.deepEqual(plain(v.mine.rows).map((r) => r.key), ['mine:my-session:51', 'mine:proposal:61'],
    'most recently active first, and keyed apart from the same card elsewhere');

  const html = workshopHtml(AppView);
  // Second only to the app's own numbers on the status tab. The questions
  // addressed to this viewer are a tab of their own now, so what is left
  // here is: what the app is, then what YOU have in flight.
  assert.ok(html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-mine'));
  assert.ok(html.indexOf('data-ws-mine') < html.indexOf('data-ws-discussion'), 'and it leads the rest');
  assert.match(html, /data-ws-lane="mine"/);
  assert.match(html, /What you are working on/);

  // Unfiltered, exactly like the vote strip: a filter that hid your own work
  // would hide the one thing on this screen you cannot find another way.
  AppView._kanbanFilters = { ...AppView._kanbanFilters, q: 'nothing matches this' };
  assert.equal(AppView._workshopView().mine.count, 2, 'a search does not hide your own work');
});

test('#1887: a card about your own session opens the CARD, with the session a link inside it', () => {
  // Opening a card about your own session used to navigate to the session
  // — the row's page link and the delegated #dev-body handler both went to
  // /dev/sessions/<id>. It is a card like every other now: the row unfolds
  // it in place, the change's page is the open card's pill (#1886), and the
  // session is a link INSIDE the open card — the one line under the sheet.
  const mine = { id: 51, session_title: 'Bottom tabs', status: 'active', pr_number: null, linked_issues: [],
    created_at: at(1), last_activity_at: at(0) };
  const AppView = makeAppView();
  seed(AppView);
  AppView._mySessions = [{ ...mine }];
  const v = AppView._workshopView();
  const row = v.mine.rows.find((r) => r.t === 'card' && r.card.attrs['data-session-chip'] === '51');
  assert.ok(row, 'the session is on the lander, carrying the hook the checks name it by');
  assert.equal(row.key, 'mine:my-session:51');

  // Folded, it is a disclosure like every other row: no destination of its
  // own, and nothing on the lander links to the session.
  const folded = workshopHtml(AppView);
  assert.match(folded, /class="dev-ws-row[^"]*"[^>]*aria-expanded="false"[^>]*data-ws-row="mine:my-session:51"[^>]*data-session-chip="51"/);
  assert.ok(!folded.includes('/dev/sessions/51'), 'folded, the session is linked from nowhere');
  assert.ok(!folded.includes('dev-ws-sheet-actions'), 'and there is no line under a row to carry a link');

  // Unfolded — through the deep link the declared check uses — it is the
  // card: its pill in the action band, and under the sheet one line, the
  // session's.
  AppView._workshopShot = 'mine-session';
  assert.deepEqual(plain(AppView._workshopView().autoExpand), { theme: 'mine', key: 'mine:my-session:51' });
  const open = workshopHtml(AppView);
  assert.match(open, /data-ws-lane="mine"><div class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet" data-ws-sheet="mine:my-session:51"><div class="[^"]*dev-card-dense"[^>]*data-session-chip="51"/,
    'the open card, hook intact');
  // The change's page is the pill's, not a line under the sheet (#1886):
  // "Open card" opens the card's sections here, and once they are open the
  // same pill is "Open page ›", the link to the change's page.
  assert.match(open, /<button type="button" class="gc-vote-btn dev-ws-open-btn" aria-expanded="false" data-ws-open-card="mine:my-session:51">Open card<\/button>/,
    'the open card carries the pill');
  assert.match(FOLD, /\) : detail && href \? \(\s*<a className="gc-vote-btn dev-ws-open-btn" href=\{href\} data-ws-open-card=\{row\.key\}>\{'Open page ›'\}<\/a>/,
    'and open, the pill is the page link');
  assert.ok(!open.includes('Open on its own page'), 'no page link under the sheet');
  // Under the sheet, the session — alone. #2030's point was that two
  // controls both reading "Open" confused; the session is a different
  // destination from the page the pill opens, so it keeps its own link,
  // and it is the one thing the line holds: no separator, nothing beside it.
  assert.match(open, /<div class="dev-ws-sheet-actions"><a href="#app\/demo-app\/dev\/sessions\/51" class="dev-ws-link" data-ws-open-session="mine:my-session:51">Open session ›<\/a><\/div><\/div>/,
    'the session link is the line under the sheet, and the last thing in it');
  assert.equal((open.match(/class="dev-ws-link"/g) || []).length, 1, 'one link under the sheet');
  assert.equal((open.match(/\/dev\/sessions\/51/g) || []).length, 1, 'the session is linked once, inside the open card');
  assert.ok(!open.includes('dev-ws-sheet-sep') && !FOLD.includes('dev-ws-sheet-sep') && !/dev-ws-sheet-sep/.test(CSS),
    'the separator went with the second link');
  assert.match(CSS, /\.dev-ws-sheet-actions \{ display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; \}/,
    'the line keeps its rule — #1886 dropped it with the page link; this link is why it is back');

  // The helpers, from the bundle: the card's page is the change's, and only
  // a hook for one of YOUR sessions names a session — an imported PR of
  // yours has no dev chat, and nobody else's session is yours to open.
  const { openHref, sessionHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  assert.equal(openHref('demo-app', row.card), '#app/demo-app/dev/proposals/51');
  assert.equal(sessionHref('demo-app', row.card), '#app/demo-app/dev/sessions/51');
  for (const hook of ['data-shared-session-row', 'data-proposal-row', 'data-issue-row', 'data-gov-row']) {
    assert.equal(sessionHref('demo-app', { attrs: { [hook]: '51' } }), null, `${hook} is not a session of yours`);
  }
  assert.equal(sessionHref('', row.card), null, 'and no app, no route');

  // A tap outside a fold — the delegated #dev-body handler — opens the
  // change's page too, never the session (#2020). The session's own route
  // stays for the links that hold it: the one above, and a bookmark.
  const click = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf("const sessionChip = e.target.closest('[data-session-chip]');"));
  assert.match(click.slice(0, 400), /AppView\.openTopic\('proposal', parseInt\(sessionChip\.dataset\.sessionChip, 10\)\);/);
  assert.ok(!/switchTab\('dev', parseInt\((?:sessionChip|el)\.dataset\.sessionChip, 10\), 'sessions'\)/.test(APP_VIEW_SRC),
    'no card hook navigates to the session any more');

  // On the Board the open card's "Open card" is the change's page as well,
  // and there is no line under the card: that page carries the workspace.
  const board = makeAppView({ location: { search: '?cards=open', hash: '', href: 'http://localhost/?cards=open' } });
  seed(board);
  board._mySessions = [{ ...mine }];
  const bh = kanbanHtml(board);
  assert.match(bh, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/proposals\/51" data-ws-open-card="my-session:51">Open card<\/a>/);
  assert.ok(!bh.includes('/dev/sessions/51'), 'the Board links the session from nowhere');

  // Declared: the deep link, on the Workshop, reaching the link. RETARGETED
  // from the text-only board check that owned the busy mock row rather than
  // added: the manifest sits at its ceiling (services/app-manifest.js keeps
  // 20 slots clear of MAX_DECLARED_TESTS), so one check owns that row before
  // and after — as the card it opens into, with the session inside it. The
  // selector walks the markup above: the lane, the open wrapper, the sheet,
  // the card by its hook, and the line under it — a later sibling of the
  // card, past the thread — holding the session link alone (the page link
  // it once had to pass on the way is the pill's now, #1886).
  const check = dapp.tests.find((t) => /#1887/.test(t.name));
  assert.ok(check, 'a declared check pins it');
  assert.equal(check.path, '/?demo=1&shot=mine-session#app/usernode-2d5619/workshop');
  assert.equal(check.expectSelector,
    '#dev-workshop [data-ws-lane="mine"] > .dev-ws-rowwrap-open > .dev-ws-sheet > .dev-card-dense[data-session-chip] ~ .dev-ws-sheet-actions > a.dev-ws-link[data-ws-open-session][href*="/dev/sessions/"]');
  assert.equal(check.expectText, '[Mock] Busy own session', 'the busy mock row, which the retargeted check always read');
  assert.ok(!dapp.tests.some((t) => /Busy own session card renders/.test(t.name)), 'retargeted, not duplicated');
  assert.match(APP_VIEW_SRC, /if \(shot === 'mine-session'\) \{\s*AppView\._workshopShot = 'mine-session';\s*\}/,
    'the shot is read where the other Workshop shots are');
});

test('the band is Open card\u2019s one seat: the facts-line seat and its inline-actions path are gone', () => {
  // `statusLead` put a caller's control at the right end of the facts line
  // and moved the card's own pills up beside it. Nothing passed one once the
  // Workshop's open card took the band seat, and with the facts as a row of
  // their own there is no line for it to end. One seat, one drawing.
  assert.ok(!CARD_TSX.includes('statusLead'));
  assert.ok(!CARD_TSX.includes('inlineActions'));
  assert.ok(!CARD_TSX.includes('dev-card-status-end'));
  assert.match(FOLD, /export type DetailPlacement = 'actions' \| false;/);
});

test('the status row and the facts row are two elements, not one band with a break in it', () => {
  // The bar with the vote at its right spans the card; the facts under it
  // are tabbed in. A dense card always emits the status row (flagged empty
  // when it has no bar and no vote, so the sibling chain the checks walk
  // stays intact) and the facts row only with something visible in it.
  assert.match(CARD_TSX, /<div className="dev-card-badges dev-card-status" data-empty=\{pill \|\| voteBtn \? undefined : '1'\}>\{pill\}\{voteBtn\}<\/div>/);
  assert.match(CARD_TSX, /const factsShown = kept\.length > 0;/);
  assert.match(CARD_TSX, /const factsRow = dense && factsShown \? \(\s*<div className="dev-card-badges dev-card-facts">/);
  assert.ok(!CARD_TSX.includes('dev-card-band-break'));
});

test('one hover for both sizes, and a facts line that is not clipped', () => {
  // The row took `--state-neutral-bg` and the card took `hover:bg-zinc-50`,
  // so two sizes of one object hovered to two different greys. Hard-coding
  // the colour in app.css could not have fixed it: `zinc` is overridden in
  // tailwind.config.js, so a hex from the stock palette would be a THIRD
  // grey. The row wears the card's own utilities instead.
  assert.match(FOLD, /className=\{`dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800/);
  assert.ok(!/\.dev-ws-row:hover \{[^}]*background:/.test(CSS), 'app.css no longer sets the fill');
  assert.ok(!/\.dev-ws-row:hover \{/.test(CSS), 'and no hover rule of its own at all: the fill utility is the whole hover, as it is on the card');

  // The card's status row clips at the bar's 30px and its facts row at one
  // 22px line; each is its own element, so neither can clip the other's
  // bottom edge the way the one wrapping band with a break in it once did.
  assert.match(CSS, /\.dev-card-badges\.dev-card-status \{[^}]*max-height: 30px;/);
  assert.match(CSS, /\.dev-card-badges\.dev-card-facts \{[^}]*max-height: 22px;/);
  assert.ok(!/dev-card-band-break/.test(CSS), 'the break, and the line it cost, are gone');
});

test('every owed vote is in the deck, not on a filtered board', () => {
  const AppView = makeAppView();
  seed(AppView);
  // Five owed proposals against a cap of three.
  AppView._proposals = [1, 2, 3, 4, 5].map((n) => ({
    id: 100 + n, pr_number: 200 + n, pr_title: `Waiting ${n}`, status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }));
  const v = AppView._workshopView();
  assert.equal(v.votes.count, 5);
  assert.equal(v.votes.shown, AppView.WORKSHOP_VOTES_MAX);
  assert.equal(v.votes.rows.length, 5, 'EVERY owed row is published, not just the visible ones');

  const html = workshopHtml(AppView, 'needs');
  // ONE at a time, and the deck says how many there are. The cap that drew
  // three and hid two behind "2 more waiting on you" is gone, and so is the
  // list: a decision gets the whole screen, and `votes.shown` no longer
  // decides anything that is drawn (it stays on the view model).
  // Seven: five proposals owed a vote, then the two unclaimed issues behind
  // them. The deck is one queue of questions, not two lists.
  // Seven in the queue, and the count rides the head: the back/forward pair
  // is gone, because Skip is the only way forward a decision screen needs.
  assert.match(html, /class="dev-ws-item-of">1 \/ 7</, 'the feed counts the whole queue');
  assert.equal((html.match(/ data-ws-item="(?:vote|need):/g) || []).length, 7, 'and every item is in the DOM');
  // Plus the end card after them (#2172): one more snap slot, not a footer,
  // and not one of the seven the counter counts.
  assert.equal((html.match(/ data-ws-item="/g) || []).length, 8, 'and the end card is the slot after the last');
  assert.ok(!html.includes('data-ws-needs-nav'), 'no pager under the answers');
  assert.equal((html.match(/dev-card-dense|dev-card-topic/g) || []).length, 0,
    'and no dense card: an item is its title, the sentence a voter reads, and the caption');
  assert.ok(!html.includes('data-ws-votes-more'), 'and there is no second disclosure');
  assert.ok(!/5 proposals need your vote/.test(html), 'no count in words: the counter is the count');

  // Every row in the DOM is also what keeps the two legacy fillers working:
  // `_wireFeedComments` observes hosts it can only find if they are rendered,
  // and the `?shot=` deep link can name a row that is not the visible one.
  assert.match(WORKSHOP, /every row stays in the DOM/);

  // It used to set a board filter and navigate: it left the lander, changed
  // the view mode, and Back was the only way home — to read a list the strip
  // was already showing the top of.
  assert.ok(!APP_VIEW_SRC.includes('openBoardNeedingVote'), 'the navigation is gone');
  assert.ok(!WORKSHOP.includes('openBoardNeedingVote'), 'and nothing still calls it');
});

test('#2172: one card past the last item is the summary, and it is the screen when there is nothing', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._proposals = [1, 2, 3].map((n) => ({
    id: 100 + n, pr_number: 200 + n, pr_title: `Waiting ${n}`, status: 'promoted', username: 'carol',
    created_at: at(3), promoted_at: at(3), last_message_at: at(3), linked_issues: [], my_vote: null,
    votes_for: 1, votes_against: 0, yes_count: 1, no_count: 0,
  }));
  const v = AppView._workshopView();
  assert.equal(v.queue.length, 5, 'three votes and the two unclaimed issues');
  const html = workshopHtml(AppView, 'needs');
  // THE LAST SLOT IN THE SCROLLER, after every item, with the item's own
  // class so it is the same height and the same snap point: a swipe past the
  // end lands on it the way a swipe landed on each decision.
  const scroll = /data-ws-feed=""[\s\S]*?<\/section><\/div>/.exec(html);
  assert.ok(scroll, 'the scroller');
  const slots = scroll[0].match(/<section class="dev-ws-item[^"]*" data-ws-item="([^"]+)"/g);
  assert.equal(slots.length, 6, 'five items and the end card');
  assert.match(slots[5], /class="dev-ws-item dev-ws-needs-done" data-ws-item="done"/, 'and the end card is LAST');
  assert.match(html, /data-ws-item="done" data-ws-kind="done" data-ws-done-acted="0" data-ws-done-left="5"/,
    'it says how many this pass answered and how many it passed over');
  // The counter and the progress line count the decisions only: the end card
  // is where you are once they are behind you, not a sixth decision.
  assert.match(html, /class="dev-ws-item-of">1 \/ 5</);
  assert.ok(!/class="dev-ws-item-of">6 \//.test(html), 'the end card has no counter');
  // Nothing answered yet and five passed over: the headline says "for now",
  // the line under it says what is still waiting, and there is a way back
  // to it as well as the way back to the lander.
  assert.match(html, /dev-ws-needs-done-line">That’s it for now\.</);
  assert.match(html, /dev-ws-needs-done-sub">5 are still waiting on you above\.</);
  assert.match(html, /dev-ws-done-cta"[^>]*>See what changed this week</, 'the way back to the lander');
  assert.match(html, /dev-ws-done-back" data-ws-done-back=""[^>]*>Back to the first one waiting</, 'and back up the feed');
  // The ring states where the viewer stands against everything they could
  // vote on: three promoted, none answered.
  assert.match(html, /dev-ws-done-ring[\s\S]*?aria-label="0 of 3 open proposals voted on"/);
  // THE RAIL ON THE END CARD is the move pair alone, so the way back up stays
  // where the thumb learned it is and the stage keeps its width on a wide
  // window; the item rail is drawn only for an item.
  assert.match(WORKSHOP, /<aside className="dev-ws-rail dev-ws-rail-end" data-ws-rail="" aria-label="The end of the feed">\s*\{moveRow\}/);
  assert.match(WORKSHOP, /const row = i < n \? items\[i\] : null;/, 'index n is the end card, with no row');
  assert.match(WORKSHOP, /const idx = key === END_KEY \? items\.length : items\.findIndex/,
    'a reader on the end card stays on it when rows arrive or leave above');
  assert.match(WORKSHOP, /const c = Math\.min\(Math\.max\(idx, 0\), items\.length\);/, 'a swipe can land on it');
  // The way the check reaches it: the route opens ON the end card, instantly.
  assert.match(WORKSHOP, /\.get\('shot'\) === 'needs-end'/);
  assert.match(WORKSHOP, /const \[endOnOpen\] = useState\(wantsEnd\);/, 'read once, at mount');
  assert.match(WORKSHOP, /useRef<string \| null>\(endOnOpen \? END_KEY : null\)/);
  const check = dapp.tests.find((t) => /shot=needs-end/.test(t.path));
  assert.ok(check, 'a declared check rides that route');
  assert.match(check.expectSelector, /\[data-ws-kind="vote"\] ~ \[data-ws-item="done"\]\[data-ws-kind="done"\]/,
    'and walks past a vote item to the end card');
  // The copy: no em dashes, and each class the card emits has a rule.
  const card = /<section class="dev-ws-item dev-ws-needs-done"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(!card.includes('—'), 'no em dash in what the reader is shown');
  for (const cls of ['dev-ws-needs-done', 'dev-ws-done-ring', 'dev-ws-needs-done-line', 'dev-ws-needs-done-sub', 'dev-ws-done-cta', 'dev-ws-done-back']) {
    assert.ok(new RegExp(`\\.${cls}\\b[^{]*\\{`).test(CSS), `${cls} has a rule`);
  }

  // WITH NOTHING IN THE QUEUE it is the whole screen, as the empty state was:
  // the caught-up line, no way back up (there is nothing above), no rail.
  AppView._proposals = [];
  AppView._ghIssues = [];
  const empty = workshopHtml(AppView, 'needs');
  const only = empty.match(/ data-ws-item="/g) || [];
  assert.equal(only.length, 1, 'the end card alone');
  assert.match(empty, /dev-ws-needs-done-line">You’re all caught up\.</);
  assert.match(empty, /Every proposal you can vote on has your answer, and every open issue has somebody on it\./);
  assert.ok(!empty.includes('data-ws-done-back'), 'nothing to go back to');
  assert.ok(!empty.includes('data-ws-rail'), 'and no rail');
});

test('the footnote says what is actually happening to the category grouping', () => {
  // The first cut said "once an AI model is available" while the model was
  // mid-draft — on exactly the first visit after a deploy. Four states now.
  const AppView = makeAppView();
  seed(AppView);
  const cat = (extra) => ({
    slug: 'demo-app', source: 'category', generatedAt: null, stale: true, pending: false, lastError: null,
    at: Date.now(), themes: [{ id: 'c', name: 'Uncategorised', description: '', saying: '', items: ['issue:12', 'issue:13', 'session:34', 'session:78'] }],
    ...extra,
  });
  AppView._workshopThemes = cat({ pending: true });
  let html = workshopHtml(AppView, 'all');
  assert.match(html, /drafting categories…/, 'pending on the category grouping says so in the eyebrow');
  assert.match(html, /Categories are being drafted from the board now\./);
  assert.ok(!html.includes('regrouping…'), 'and does not claim a regroup of categories that do not exist yet');

  AppView._workshopThemes = cat({ lastError: 'boom' });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /The last attempt to draft categories failed \(boom\)\./);

  AppView._workshopThemes = cat({});
  html = workshopHtml(AppView, 'all');
  assert.match(html, /No AI model is configured, so items are grouped by their voted category\./);
  assert.ok(!html.includes('drafted once an AI model is available'), 'the misleading copy is gone');

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'placement', coverage: { total: 4, placed: 1, unplaced: 0, pending: 3 } });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /placing new cards…/, 'pending placement on real categories says so');
  // The stamp has to sit inside `relStamp`'s relative window for that copy to
  // be the copy under test at all. Pinned here so a fixture that drifts out of
  // it fails as "the fixture went stale" rather than as a grouping bug — which
  // is how it read the first time, a week after the date was hardcoded.
  const REL_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;
  const stamp = Date.parse(themes([], {}).discoveredAt);
  assert.ok(Date.now() - stamp < REL_FLOOR_MS,
    'the fixture stamp is relative to now, not a wall-clock date that ages out');
  assert.match(APP_VIEW_SRC, /const REL_FLOOR_MS = 7 \* 24 \* 60 \* 60 \* 1000;/,
    'and that window is still seven days where relStamp defines it');
  assert.match(html, /Categories were drafted \d+[hd] ago and are re-drafted daily, or sooner when a tenth of the board changes\./);
  assert.match(html, /3 new cards are being placed\./);
  // The name is preceded by the theme's glyph now (#1787); the pin is still
  // on the COPY, which is what these four states are about.
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Being placed<\/div>/);
  // The row's marker: the pseudo-theme is folded on a plain paint, so the
  // marker is pinned at the source, on the folded row.
  assert.match(FOLD, /\{row\.placing \? <span className="dev-ws-placing"[^>]*>placing…<\/span> : null\}/);
  assert.match(CSS, /\.dev-ws-placing \{/);

  AppView._workshopThemes = themes([{ id: 't', name: 'Theming', description: 'd', saying: 's', items: ['issue:12'] }],
    { pending: true, pendingStage: 'discovery', unplaced: ['issue:13', 'session:34', 'session:78'], coverage: { total: 4, placed: 1, unplaced: 3, pending: 0 }, lastError: 'placement: boom' });
  html = workshopHtml(AppView, 'all');
  assert.match(html, /re-drafting categories…/, 'a pending discovery on real categories is a re-draft');
  assert.match(html, /3 cards did not fit a category and wait for the next draft\./);
  assert.match(html, /The last attempt failed \(placement: boom\); it is retried shortly\./);
  assert.match(html, /<div class="dev-ws-theme-name">(?:<span class="dev-ws-theme-icon[^>]*>[^<]*<\/span>)?Not yet grouped<\/div>/);
  assert.ok(!html.includes('dev-ws-placing'), 'declined cards wear no marker');
});

test('a workshop_update over the WS re-fetches past the throttle, for the open app only', async () => {
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'ai', pending: false, coverage: { total: 0, placed: 0, unplaced: 0, pending: 0 }, unplaced: [] }) }; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'a fresh answer is not re-fetched inside the throttle');
  AppView.applyWorkshopUpdate({ appSlug: 'other-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'another app\'s grouping is not this page\'s');
  AppView.applyWorkshopUpdate({ appSlug: 'demo-app', stage: 'placement' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, 'the server wrote a grouping: fetch it now');
  assert.deepEqual(plain(AppView._workshopThemes.coverage), { total: 0, placed: 0, unplaced: 0, pending: 0 });
  // And the WS dispatch reaches it.
  const APP_SRC = read('public/js/app.js');
  assert.match(APP_SRC, /case 'workshop_update':\s*App\.handleWorkshopUpdate\(data\);/);
  assert.match(APP_SRC, /AppView\.applyWorkshopUpdate\(data\)/);
  const WS_SRC = read('src/services/ws.js');
  assert.match(WS_SRC, /function pushWorkshopUpdate\(data\) \{\s*broadcastGlobalScoped\(\{ type: 'workshop_update'/);
  assert.match(WS_SRC, /function pushSessionUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'a session change reaches the board listeners');
  assert.match(WS_SRC, /function pushIssueUpdate\(data\) \{[\s\S]*?noteBoardChange\(data\);\s*\}/, 'and so does an issue change');
});

test('the theme poll follows a widening schedule that outlasts a full draft, then stops', async () => {
  // Haiku takes tens of seconds on a full board; four polls six seconds apart
  // gave up first and left the category grouping in place until the next
  // navigation.
  const total = AppView_pollTotal();
  assert.ok(total >= 120000, `the schedule must cover well over a minute, got ${total}ms`);
  assert.ok(total <= 5 * 60000, 'and stop within a few minutes');
  assert.match(APP_VIEW_SRC, /n < AppView\.WORKSHOP_POLL_MS\.length/, 'the poll count is the schedule length');
  assert.match(APP_VIEW_SRC, /AppView\.WORKSHOP_POLL_MS\[n\]/, 'and each wait reads its slot');

  const timers = [];
  let calls = 0;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true, lastError: 'boom' }) }; },
    // Capture the scheduled waits instead of sleeping through them.
    setTimeout: (_fn, ms) => { timers.push(ms); return 0; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(AppView._workshopThemes.lastError, 'boom', 'the failure reason is carried');
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]]);
  AppView._workshopThemes = null;
  await AppView._loadWorkshopThemes('demo-app', AppView.WORKSHOP_POLL_MS.length);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0]], 'past the schedule, no further poll');
});

test('a board reload during a draft joins the running poll chain instead of starting another', async () => {
  // Every WS-driven _loadDevFeed lands at attempt 0. While a draft is pending
  // and a re-fetch is already scheduled, that call must not fetch again or
  // schedule a second chain — the themes endpoint rebuilds the server's
  // input on every GET, which is what the per-slug throttle exists to bound.
  const timers = [];
  let calls = 0;
  let nextId = 1;
  const AppView = makeAppView({
    fetch: async () => { calls++; return { ok: true, json: async () => ({ themes: [], source: 'category', pending: true }) }; },
    setTimeout: (_fn, ms) => { timers.push(ms); return nextId++; },
  });
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  await AppView._loadWorkshopThemes('demo-app', 0);
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 1, 'the reloads did not fetch again');
  assert.equal(timers.length, 1, 'and scheduled nothing');
  // The chain itself advances: the scheduled step clears the timer first.
  AppView._workshopPollTimer = null;
  await AppView._loadWorkshopThemes('demo-app', 1);
  assert.equal(calls, 2);
  assert.deepEqual(timers, [AppView.WORKSHOP_POLL_MS[0], AppView.WORKSHOP_POLL_MS[1]]);
  // A different app is never held back by this one's chain.
  AppView._workshopThemes = { ...AppView._workshopThemes, slug: 'other-app' };
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(calls, 3);
});

function AppView_pollTotal() {
  const m = APP_VIEW_SRC.match(/WORKSHOP_POLL_MS:\s*\[([^\]]+)\]/);
  assert.ok(m, 'WORKSHOP_POLL_MS is a literal array');
  return m[1].split(',').map((x) => parseInt(x.trim(), 10)).reduce((a, b) => a + b, 0);
}

test('an unfolded row is the Activity entry: the sheet, the card, the slot, the thread', () => {
  // The component unfolds from state, so pin the markup at the source: the
  // entry wrapper and its three children, in the order the feed drew them.
  const unfolded = FOLD.slice(FOLD.indexOf('function UnfoldedRow'), FOLD.indexOf('function voteSpecs'));
  assert.match(unfolded, /className="dev-feed-entry dev-ws-sheet"/, 'the sheet wrapper the feed used');
  assert.match(unfolded, /<DevCard model=\{card\} actionEnd=\{placement \? openBtn : undefined\} headEnd=\{<FoldMark open onClick=\{onFold\} \/>\} \/>/, 'the same card builder');
  // Minus the rail chevron: inside a fold a click on the card folds it, so the
  // Board's "this opens" mark would promise a destination the card no longer
  // has. Everything else on the model is the Board's, untouched.
  assert.match(unfolded, /const card: DevCardModel = \{ \.\.\.row\.card, rail: \{ \.\.\.row\.card\.rail, chevron: false \} \};/);
  assert.match(unfolded, /className="dev-feed-comments" data-comments-for=\{String\(row\.commentsFor\)\}/,
    'the GitHub slot, rendered empty for _fillFeedComments');
  assert.match(unfolded, /<FeedThread slug=\{slug\} type=\{row\.thread\.type\} refId=\{row\.thread\.ref\} canPost=\{canPost\} \/>/,
    'the app thread with its reply box');
  assert.ok(unfolded.indexOf('<DevCard') < unfolded.indexOf('dev-feed-comments')
    && unfolded.indexOf('dev-feed-comments') < unfolded.indexOf('<FeedThread'), 'in the feed\'s order');
  // And the module's fillers are re-run when the set of unfolded rows changes.
  assert.match(WORKSHOP, /callAppView\('_wireFeedComments', host\)/);
  assert.match(WORKSHOP, /callAppView\('_fillKudosHosts', host\)/);
});

test('the open sheet is a DIRECT child of the wrapper, the way the check selects it', () => {
  // The declared check reads
  //
  //   #dev-workshop .dev-ws-rowwrap-open > .dev-feed-entry
  //     > .gc-vote-item.dev-card-dense[data-edge] ~ .dev-feed-thread ...
  //
  // and the two `>` in it are the whole point of this test. Hanging the
  // close-on-click handler on a plain <div> wrapped around the sheet is a
  // one-line change that renders identically, reviews as harmless and breaks
  // that selector — it did, on the first submission of #1787's third round.
  // The source-text test above cannot see it, because the extra element is in
  // CardRowView and not in UnfoldedRow. So resolve the spine against the real
  // markup instead: nothing may sit between the wrapper, the sheet and the
  // card.
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['session:34', 'issue:12'] }]);
  AppView._workshopShot = 'feed-comments';

  const els = tokenize(workshopHtml(AppView, 'all')).filter((t) => t.kind === 'open');
  const classOf = (t) => {
    const a = (t.attrs || []).find((x) => x.name.toLowerCase() === 'class');
    return a ? String(a.value).split(/\s+/) : [];
  };
  const attr = (t, n) => (t.attrs || []).some((x) => x.name.toLowerCase() === n);

  const i = els.findIndex((t) => classOf(t).includes('dev-ws-rowwrap-open'));
  assert.ok(i >= 0, 'the capture deep link opens a row');

  const sheet = els[i + 1];
  assert.ok(classOf(sheet).includes('dev-feed-entry'),
    'the sheet is the wrapper\'s first child, with no element between them');

  const card = els[i + 2];
  assert.ok(classOf(card).includes('dev-card-dense'),
    'and the Board\'s dense card is the sheet\'s first child');
  assert.ok(attr(card, 'data-edge'), 'still carrying its state edge');

  // The fold is the other half: while a row is open its compressed form is
  // not drawn at all, so nothing can match `.dev-ws-rowwrap-open .dev-ws-row`.
  const inside = els.slice(i + 1).findIndex((t) => classOf(t).includes('dev-ws-rowwrap'));
  const end = inside === -1 ? els.length : i + 1 + inside;
  assert.ok(!els.slice(i, end).some((t) => classOf(t).includes('dev-ws-row')),
    'the compressed row is gone while the card is up');
});

test('the sheet CSS moved host with the entry, and the Workshop has its own', () => {
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /^\s*(\.dark\s+)?#dev-feed\b/.test(l));
  assert.deepEqual(rules, [], 'no rule is scoped to the retired #dev-feed');
  assert.match(CSS, /#dev-workshop \.dev-feed-entry \{/);
  assert.match(CSS, /#dev-workshop \.dev-feed-thread \{/);
  // The bottom is `--ws-gap` now, not 12px: it is the same air the sticky rail
  // rests on, so the gap under the bar is identical whether the lander fills
  // the scroller (rail at its bottom edge, padding decides) or overflows it
  // (rail stuck, `bottom` decides). At 12 against 8 they differed by 4px
  // depending on the tab. The sides are unchanged.
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding: 8px 4px var\(--ws-gap, 8px\); \}/);
  assert.match(CSS, /\.dev-ws-theme-head \{/);
  assert.match(CSS, /\.dev-ws-row \{/);
});

// ── modes, routes, the strip, the checks ─────────────────────────────

test('workshop replaced feed as a mode, and the retired names resolve onto it', () => {
  const AppView = makeAppView();
  assert.deepEqual(plain(AppView.VIEW_MODES), ['workshop']);
  assert.equal(AppView._migrateViewMode('feed'), 'workshop');
  assert.equal(AppView._migrateViewMode('list'), 'workshop');
  // 'pm' and 'report' were board-shaped and resolved to the Board; the Board
  // mode has retired in turn, so the chain ends at the one mode left — as does
  // 'kanban' itself, which is what a viewer who last left the Dev screen on
  // the Board still has stored.
  assert.equal(AppView._migrateViewMode('pm'), 'workshop');
  assert.equal(AppView._migrateViewMode('report'), 'workshop');
  assert.equal(AppView._migrateViewMode('kanban'), 'workshop');
  assert.equal(AppView._getViewMode(), 'workshop', 'the default on every width');
  assert.ok(!APP_VIEW_SRC.includes('_rerenderFeed()'), 'the feed renderer is gone');
  assert.ok(!APP_VIEW_SRC.includes('_feedView()'), 'and its view model');
  assert.match(APP_VIEW_SRC, /_rerenderWorkshop\(\)/);
});

test('the strip is App | Workshop, and the Workshop is an anchor at its route', () => {
  assert.match(VIEW_TABS, /data-context-row="app"[\s\S]*data-context-row="workshop"/);
  assert.match(VIEW_TABS, /href=\{slug \? `#app\/\$\{slug\}\/workshop` : '#'\}/);
  assert.ok(!VIEW_TABS.includes('data-context-row="activity"'), 'the Activity segment retired');
  assert.ok(!VIEW_TABS.includes('data-context-row="board"'),
    'and the Board segment after it — the Workshop and the kanban are one '
    + 'screen in two layouts, so the layout is not a destination in the strip');
  assert.match(VIEW_TABS, />Workshop</);
});

test('the declared checks cover the lander, its strips and an unfolded row', () => {
  const byName = (re) => dapp.tests.find((t) => re.test(t.name || ''));
  const lands = byName(/lands on the Workshop, which leads with its number tiles/);
  assert.ok(lands && lands.expectSelector.includes('#dev-workshop'));
  // Extended rather than added: the manifest keeps 20 of its 580 slots clear
  // and was already at that working ceiling, so a new entry would have failed
  // the check-count guard. Same intent, one level deeper.
  assert.match(lands.expectSelector, /\[data-ws-dash-cell="open"\]/);
  // The summary cards ride the ROUTE check rather than a slot of their own:
  // the manifest keeps 20 of its 580 clear and was already at that working
  // ceiling, so a new entry would fail the check-count guard in
  // tests/proposal-tests-manifest.test.js. Deepening the check that already
  // owns "this route lands on the lander" is the same claim, further in.
  //
  // What it pins moved with the feature. It used to be the three windows in
  // order, all drawn at once; the pane opens on `open` alone now, with the
  // step back above it, so THAT is the default state a gate can assert —
  // asserting the older windows would mean scripting a click in a check that
  // can only select.
  //
  // A PLAIN CHAIN, deliberately. The `:has()` note below is not about that
  // one selector — it is the standing rule for this manifest, learned from
  // six straight gate failures against a selector that resolved perfectly in
  // this repo's own Chromium.
  const route = byName(/is the card area grouped by theme/);
  assert.ok(route && /\[data-ws-cards\] > \[data-ws-card="open"\]/
    .test(route.expectSelector), 'the present is what the gate can select');
  assert.ok(!route.expectSelector.includes(':has('), 'no :has() on a gate that blocks merge');

  const themesCheck = byName(/renders its themes into #dev-workshop/);
  assert.ok(themesCheck && /\.dev-ws-row\[role="button"\]\[aria-expanded\]/.test(themesCheck.expectSelector));
  const demo = byName(/A demo theme names the mock rows/);
  assert.ok(demo && demo.expectSelector.includes('[data-ws-theme="demo-voting"]'));
  // The vote gate rides the Needs-you tab now, which `?ws=` reaches — the
  // platform's own rule for a screen that is otherwise behind a tap.
  const votes = byName(/Needs-you tab is a feed of one decision per screen/);
  assert.ok(votes && /\[data-ws-needs\] > \[data-ws-rail\] > button\[data-ws-rail-btn="vote"\]/.test(votes.expectSelector));
  assert.match(votes.path, /[?&]ws=needs/, 'and the URL names the tab');
  const unfolded = byName(/A Workshop row unfolds into the Activity sheet/);
  assert.ok(unfolded && /shot=feed-comments/.test(unfolded.path), 'the unfolded-row checks ride the capture deep link');
  // NOT extended with a `:has()` for the Open card toggle, though it was
  // once. That selector resolves in this repo's own Chromium against the
  // component's real markup — verified — and failed 6 of 6 runs on the
  // proposal gate, where the plain chain around it had passed for two
  // rounds. The difference was never reproduced here, and a gate that
  // blocks merge is the wrong place to keep a selector nobody can explain.
  // The toggle is pinned against rendered markup in this file instead.
  assert.ok(!unfolded.expectSelector.includes('data-ws-open-card'));

  // The preview moved to the facts line and then back to the action band —
  // at its right end, just before the hamburger — and the declared check
  // moved with it each time. This is the sweep that was missed the first time: the unit
  // tests for the new position were all updated and dapp.json was not, so
  // the gate found it instead.
  const preview = byName(/Preview is a labelled pill/);
  assert.ok(preview, 'the board still pins where the preview lives');
  assert.match(preview.expectSelector, /\.gc-card-actions > \.gc-vote-btn-preview:not\(\.gc-vote-btn-icon\) \+ \.dev-card-menu-btn\[data-card-menu\]:last-child/);
  for (const t of dapp.tests) {
    assert.ok(!/dev-card-status-end[^,]*gc-vote-btn-preview/.test(t.expectSelector || ''),
      `${t.name}: no check still looks for the preview on the facts line`);
    assert.ok(!/#dev-(kanban|body)[^,]*gc-explore-chat-btn/.test(t.expectSelector || ''),
      `${t.name}: nor for Explore on a card face`);
  }
  const strip = byName(/two views in order: App, then Workshop/);
  assert.ok(strip && /workshop/.test(strip.expectSelector)
    && !/board/.test(strip.expectSelector),
    'the order check lost its Board segment along with the segment');
  // The board route keeps a check of its own, because removing a segment can
  // leave a segmented control with NOTHING selected — which reads as broken
  // rather than as "you are somewhere else". It marks Workshop there instead.
  //
  // A PLAIN CHAIN, for the reason this file gives above: `:has()` resolved
  // perfectly in this repo's own Chromium and failed 6 of 6 runs on the gate.
  // The ABSENCE of the Board segment is pinned in the unit tests (this file,
  // dev-board-island, improve-session-segment) rather than in a selector that
  // blocks merge.
  const onBoard = byName(/marks Workshop on the board route/);
  assert.ok(onBoard && /\[data-context-row="workshop"\]\[aria-current="page"\]/
    .test(onBoard.expectSelector), 'the strip is never blank on the board route');
  assert.match(onBoard.path, /#app\/[\w-]+\/board$/, 'and the URL names that route');
  assert.ok(!onBoard.expectSelector.includes(':has('),
    'no :has() on a gate that blocks merge');
  for (const t of dapp.tests) {
    assert.ok(!/#dev-feed\b/.test(t.expectSelector || ''), `${t.name}: no check selects the retired #dev-feed`);
  }
});

// A check that names ONE card's text cannot ride the lander's route.
// ThemeCard draws its lanes only while it is unfolded, and DevWorkshop
// unfolds exactly the first theme, so at most a quarter of the board's cards
// are in the DOM here. Which quarter is not fixed either: the staging demo
// grouping deals the real items round-robin into four themes
// (services/workshop-themes.js) and sortThemes puts whichever of them has the
// most distinct people first, both of which move as the board moves.
//
// So such a check passes or fails by the hour rather than by the diff. #1704
// moved thirty-seven board-card checks onto #app/<slug>/board for exactly
// this reason and left five behind; two of them ("Shared demo session renders
// in the In progress area" and "Shared session cards show the owner
// subtitle") passed on #1704 and #1709 and were red on #1623 and #1710 with
// the same manifest. The Board's In-progress column renders every card, which
// is what all five names describe.
test('no declared check asserts a card\'s text at the lander\'s own route', () => {
  const lander = /^\/\?demo=1#app\/[\w-]+\/(dev|workshop)$/;
  const offenders = dapp.tests
    .filter((t) => lander.test(t.path) && t.expectText && !t.expectSelector)
    .map((t) => `${t.name} (${t.path})`);
  assert.deepEqual(offenders, [],
    'these assert one card\'s text where only the first theme\'s rows render — address the Board route');
});

// ── The grouping tabs: the same board, two ways ──────────────────────────
//
// The eyebrow here used to be a bare "12 categories" — a count of a grouping
// the viewer had no say in. These cover the control it became, and the one
// thing that makes the stage pane cheap: it renders the SAME <DevKanban/> the
// Board view mode does, from the same published view model, so nothing about
// the board is re-derived or duplicated.

test('the grouping is a two-tab control, and category is what an untouched Workshop shows', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  assert.equal(AppView._getWorkshopGroup(), 'category');
  const html = workshopHtml(AppView, 'all');
  const cat = html.indexOf('data-ws-group="category"');
  const stage = html.indexOf('data-ws-group="stage"');
  assert.ok(cat > 0 && stage > cat, 'both tabs render, category first');
  assert.match(html.slice(cat, cat + 400), /aria-selected="true"/,
    'the category tab is the selected one by default');
  assert.ok(html.includes('By category') && html.includes('By stage'), 'the labels');
  // The tabs sit UNDER the general discussion and the summary strip, which is
  // the whole arrangement: those are facts about the app, not about how you
  // are sorting it, so they do not move when the pane does.
  assert.ok(html.indexOf('data-ws-dashboard') < cat,
    'the summary strip is above the tabs');
  // ...and the category pane is unchanged: its own sort chips and its themes.
  assert.ok(html.includes('dev-ws-themes'), 'the theme list still renders');
  assert.ok(html.includes('dev-ws-sort-opts'), 'and its sort chips');

  // The pane says what it holds, above the tabs. Everything above this point
  // on the lander is a selection — your work, what needs you, what moved —
  // and the tabs alone named the CHOICE without naming what the choice is
  // being made about.
  assert.match(html, /class="dev-ws-eyebrow dev-ws-pane-eyebrow">All items<\/span><div class="dev-ws-group"/);
  // The declared check selects `.dev-ws-group + #dev-actions`, so the title
  // goes BEFORE the tabs and the adjacency it gates on survives.
  const gate = dapp.tests.find((t) => /\.dev-ws-group \+ #dev-actions/.test(t.expectSelector || ''));
  assert.ok(gate, 'the declared check still names that adjacency');
  assert.match(html, /class="dev-ws-group"[\s\S]*?<\/div><div id="dev-actions"/);

  // The sort row's eyebrow leads with the count of NAMED categories —
  // "Not yet grouped" is a holding pen, not one of them. (This fixture's
  // themes are shaped for the tab assertions above and name no drawable
  // card, so the count here is 0; the singular/plural agreement is pinned
  // in the test below, against a board that has one.)
  const sort = html.slice(html.indexOf('class="dev-ws-sort"'), html.indexOf('dev-ws-themes'));
  assert.match(sort, /class="dev-ws-eyebrow">\d+ categor/);
});

test('the sort row reports the state of the grouping after the count', () => {
  // The second half of that eyebrow: the part the list under it cannot say
  // for itself. Appended to the count, one clause per thing to report.
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), source: 'category' };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · grouped by category for now</);
  AppView._workshopThemes = { ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · re-drafting categories…</);
  AppView._workshopThemes = {
    ...themes([{ id: 't', name: 'T', items: ['issue:12'] }]), pending: true, pendingStage: 'placement',
  };
  assert.match(workshopHtml(AppView, 'all'), /class="dev-ws-eyebrow">1 category · placing new cards…</);
});

test('"By stage" swaps the pane for the board\'s own columns, and keeps everything above it', () => {
  const store = { devWorkshopGroup: 'stage' };
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  assert.equal(AppView._getWorkshopGroup(), 'stage');
  const html = workshopHtml(AppView, 'all');
  // The board, rendered INSIDE the Workshop — the same node ids the standalone
  // Board mode draws, because it is the same component.
  assert.ok(html.includes('id="dev-kanban"'), 'the board renders in the pane');
  assert.ok(html.includes('data-ws-stage'), 'inside the stage wrapper');
  const stage = html.indexOf('data-ws-group="stage"');
  assert.match(html.slice(stage, stage + 400), /aria-selected="true"/,
    'and the stage tab is the selected one');
  // The category pane is GONE, not merely hidden: two groupings of one board
  // on screen at once is the thing the tabs exist to stop.
  assert.ok(!html.includes('dev-ws-themes'), 'no theme list under the stage tab');
  assert.ok(!html.includes('dev-ws-sort-opts'), 'and no category sort chips');
  // The tiles and the discussion used to sit above this pane on the same
  // scroll, and the assertion here was that switching grouping did not cost
  // them. They are a TAB of their own now — the lander's three destinations
  // are the bar at the bottom — so what has to hold is that the grouping
  // choice is a control WITHIN one destination and does not move you off it.
  assert.ok(!html.includes('data-ws-dashboard'), 'the status strip is its own tab');
  assert.match(html, /data-ws-tab-btn="all" aria-selected="true"/, 'and All items is still the tab you are on');
});

test('the stage pane is the SAME board component, not a second one', () => {
  const AppView = makeAppView({ localStorage: { devWorkshopGroup: 'stage' } });
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  // Rendered standalone (the Board view mode) and nested (the stage pane), the
  // columns are byte-identical — so every card action, the mobile column tabs
  // and the filter bar work on both without a line of their own.
  const nested = workshopHtml(AppView, 'all');
  const standalone = kanbanHtml(AppView);
  const board = standalone.slice(standalone.indexOf('<div id="dev-kanban"'));
  assert.ok(board.length > 200, 'the standalone board rendered something');
  assert.ok(nested.includes(board), 'the nested pane contains it verbatim');
  // And the source says so: one import of the board component, no re-derived
  // columns of the Workshop's own.
  assert.match(WORKSHOP, /import \{ DevKanban \} from '\.\.\/card\/dev-kanban'/);
});

test('the board view model is built only for the pane that shows it', () => {
  // `_kanbanView()` buckets, orders and filters every card on the board.
  // Doing that on every Workshop repaint for a pane nobody is looking at is
  // the regression this guards.
  const src = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _rerenderWorkshop()'));
  const body = src.slice(0, src.indexOf('\n  _fmtCountdown('));
  const call = body.indexOf('AppView._kanbanView()');
  assert.ok(call > 0, '_rerenderWorkshop publishes the board');
  const guard = body.lastIndexOf("if (group === 'stage')", call);
  assert.ok(guard > 0 && guard < call, 'behind the stage guard');
  // Published BEFORE the Workshop mounts: the board draws from inside the
  // Workshop's tree, so a store still holding the previous board would paint
  // one frame of it.
  assert.ok(call < body.indexOf('react.mountWorkshop('),
    'and published before the mount');
});

test('the tabs are no longer additive: the Board view mode retired onto them', () => {
  // The #1995-era decision was that the grouping tabs were ADDITIVE and the
  // standalone board was untouched, and this test existed because "the next
  // change to this screen is the one that would quietly drop the standalone
  // board". That change is this one, and it is not quiet: the stage pane
  // renders the same <DevKanban/> from the same published view model, so the
  // Board view mode was a second surface for something the lander contains.
  assert.match(APP_VIEW_SRC, /VIEW_MODES: \['workshop'\]/, 'one dev view mode');
  assert.ok(!/VIEW_MODES: \['workshop', 'kanban'\]/.test(APP_VIEW_SRC),
    'the Board mode is gone from the list, not merely unreachable by default');
  assert.match(APP_VIEW_SRC, /kanban: 'workshop'/,
    'and a stored preference naming it migrates rather than being forgotten');
  assert.ok(!/data-context-row="board"/.test(VIEW_TABS),
    'the Improve panel offers no Board segment');
  // WHAT IS NOT REMOVED. The columns, the route and the old deep link all
  // still resolve — onto the stage pane — and the standalone surface's own
  // code is still here, now unreachable, to be swept separately rather than
  // torn out alongside a routing change.
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-kanban-board"><\/div>'/);
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-workshop"><\/div>'/);
  assert.match(APP_VIEW_SRC, /_overrideWorkshopGroup\(group\) \{/,
    'the retired board ROUTE has a landing');
  const board = dapp.tests.find((t) => /board resolves onto the stage pane/.test(t.name || ''));
  assert.ok(board && /\[data-ws-stage\]/.test(board.expectSelector),
    'and a declared check proves that landing draws the columns');
});

test('the grouping preference lasts, and an unknown stored value is category', () => {
  const store = {};
  const AppView = makeAppView({ localStorage: store });
  AppView._setWorkshopGroup('stage');
  assert.equal(store.devWorkshopGroup, 'stage', 'persisted, and to localStorage');
  assert.equal(AppView._getWorkshopGroup(), 'stage');
  AppView._setWorkshopGroup('nonsense');
  assert.equal(AppView._getWorkshopGroup(), 'category', 'an unknown mode falls back');
  store.devWorkshopGroup = 'themes';
  assert.equal(AppView._getWorkshopGroup(), 'category', 'and so does an unknown stored one');
});

test('a retired Board preference opens on the columns, not on the categories', () => {
  // The other half of retiring the Board VIEW MODE. RETIRED_VIEW_MODES stops a
  // stored 'kanban' naming a mode that no longer exists — but on its own it
  // forgets what the viewer actually chose, which was the COLUMNS, and hands
  // them the categories instead. The three board-shaped values therefore open
  // on the stage pane.
  for (const mode of ['kanban', 'pm', 'report']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._getViewMode(), 'workshop', `${mode} migrates to the one mode left`);
    assert.equal(AppView._getWorkshopGroup(), 'stage', `${mode} still opens on the columns`);
  }
  // The Workshop's own predecessors get its own default pane: those viewers
  // never chose columns.
  for (const mode of ['feed', 'list', 'workshop']) {
    const AppView = makeAppView({ localStorage: { devViewMode: mode } });
    assert.equal(AppView._getWorkshopGroup(), 'category', `${mode} lands on the lander`);
  }
  // A grouping the viewer actually chose outranks the migration — it is read
  // first, so the migration only ever fills a gap.
  const chosen = makeAppView({
    localStorage: { devViewMode: 'kanban', devWorkshopGroup: 'category' },
  });
  assert.equal(chosen._getWorkshopGroup(), 'category');
  // READ-TIME, like every other migration here: nothing is written back, so
  // the day they pick a pane that choice is what persists.
  const store = { devViewMode: 'kanban' };
  const fresh = makeAppView({ localStorage: store });
  assert.equal(fresh._getWorkshopGroup(), 'stage');
  assert.ok(!('devWorkshopGroup' in store), 'the migration stores nothing');
});

test('reaching the retired Board takes BOTH answers: the All items tab and the stage pane', () => {
  // THE BUG THIS GUARDS, which cost a full round of the merge gate. Those
  // columns are the `stage` grouping OF THE `all` TAB. A first attempt set the
  // grouping alone — and the lander then opens on its DEFAULT tab, where the
  // grouping control is not rendered at all, so the pane never mounts and all
  // 69 declared checks that select #dev-kanban on a board route failed at once.
  // Every way in has to supply both halves, and the test above proves that
  // ('all', 'stage') is what puts the board's own markup on screen verbatim.
  const at = (o) => {
    const A = makeAppView(o);
    return [A._workshopTab(), A._getWorkshopGroup()].join('/');
  };
  const loc = (search) => ({
    location: { search, hash: '', href: `http://localhost/${search}` },
  });

  // 1. The route alias, driven exactly as app.js's restoreFromHash drives it.
  const route = makeAppView({ localStorage: {} });
  route._overrideWorkshopTab('all');
  route._overrideWorkshopGroup('stage');
  assert.equal([route._workshopTab(), route._getWorkshopGroup()].join('/'),
    'all/stage', '#app/<slug>/board');

  // 2. The retired deep link, which named one thing and meant two.
  assert.equal(at(loc('?view=kanban')), 'all/stage', '?view=kanban');

  // 3. The stored preference of somebody who last left the Dev screen on it.
  for (const mode of ['kanban', 'pm', 'report']) {
    assert.equal(at({ localStorage: { devViewMode: mode } }), 'all/stage', mode);
  }

  // ...and none of those three may drag anybody else onto the board.
  assert.equal(at({ localStorage: {} }), 'status/category', 'the lander default');
  assert.equal(at({ localStorage: { devViewMode: 'feed' } }), 'status/category',
    'the Workshop replaced feed: that viewer never chose columns');

  // The parameters still being offered, and the viewer's own taps, outrank
  // every hop above — each half independently.
  assert.equal(at(loc('?view=kanban&ws=needs')), 'needs/stage', 'an explicit tab wins');
  assert.equal(at(loc('?view=kanban&group=category')), 'all/category', 'an explicit pane wins');
  assert.equal(at({
    localStorage: { devViewMode: 'kanban', devWorkshopTab: 'needs', devWorkshopGroup: 'category' },
  }), 'needs/category', 'and choices they have actually made win over the migration');
});

test('the grouping strip is the lander\'s own tab control, not a second vocabulary', () => {
  // Two tab strips two rows apart on one screen. They were drawn in two
  // vocabularies: the bar above in a raised track with a periwinkle selected
  // pill, this one in a recessed `--dc-strip` rail with a hairline and a
  // selected half painted in the plain sheet with a drop shadow. The geometry
  // already agreed (round rail, 2px between the halves) — only the colour did
  // not, which is the half a reader actually sees.
  assert.match(CSS, /\.dev-ws-group \{[^}]*border-radius: 999px/);
  assert.match(CSS, /\.dev-ws-group \{[^}]*background: var\(--dc-sheet-raise\)/,
    'the same track surface as .dev-ws-tabtrack');
  const track = /\.dev-ws-group \{([^}]*)\}/.exec(CSS);
  assert.ok(track, 'the rail rule exists');
  assert.ok(!/box-shadow/.test(track[1]), 'and no ring around it, as the bar has none');
  // THE SELECTED HALF IS THE BAR'S OWN THREE TOKENS, so the two controls
  // cannot drift apart the next time either is tuned. The bar spends them
  // across two rules since #2063 — the ink on the selected tab, the fill and
  // the hairline on the marker that slides between them — and this strip
  // paints all three on the selected half itself. That difference is
  // deliberate and is the whole of it: a two-state switch has neither the
  // measuring machinery the sliding marker needs nor a use for it.
  const on = /\.dev-ws-group-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(CSS);
  const barOn = /\.dev-ws-tab\[aria-selected="true"\] \{([^}]*)\}/.exec(CSS);
  const marker = /\.dev-ws-tab-marker \{([^}]*)\}/.exec(CSS);
  assert.ok(on && barOn && marker, 'all three rules exist');
  assert.ok(on[1].includes('color: var(--brand-ink)'));
  assert.ok(barOn[1].includes('color: var(--brand-ink)'), 'which is the bar\'s own ink');
  for (const decl of ['background: var(--brand-tint)', 'box-shadow: inset 0 0 0 1px var(--brand-line)']) {
    assert.ok(on[1].includes(decl), `the grouping tab carries \`${decl}\``);
    assert.ok(marker[1].includes(decl), 'and so does the marker, which is where it comes from');
  }
  assert.ok(!/var\(--dc-sheet\)/.test(on[1]), 'the plain-sheet fill is gone');
  // WHAT STAYS DIFFERENT IS THE WIDTH, and that is the real distinction from
  // the sort chips a row below: full width of the reading column, split
  // evenly. `flex: 1 1 0`, not `1 1 auto` — on `auto` the halves would be
  // sized by their labels, so "By category" would take more than "By stage".
  assert.match(CSS, /\.dev-ws-group-tab \{[^}]*flex: 1 1 0/);
  assert.ok(!/\.dev-ws-group \{[^}]*align-self: flex-start/.test(CSS),
    'and the rail itself is not shrunk to its content');
  // A token that does not resolve is a silently wrong colour, not an error —
  // and inside a box-shadow list one bad var() voids the whole declaration.
  for (const token of ['--dc-sheet-raise', '--brand-tint', '--brand-ink', '--brand-line',
    '--text-muted', '--text-primary']) {
    assert.ok(CSS.includes(`${token}:`), `${token} is defined`);
  }
});

test('?group=stage is a deep link to the pane, and a tap retires it', () => {
  const store = {};
  const AppView = makeAppView({
    localStorage: store,
    location: { search: '?group=stage', hash: '', href: 'http://localhost/?group=stage' },
  });
  assert.equal(AppView._getWorkshopGroup(), 'stage', 'the URL wins over the empty preference');
  // The preference still wins once the viewer states one — otherwise ?group=
  // would keep overriding every later tap, which is the bug `_setViewMode`
  // already carries a comment about.
  AppView._setWorkshopGroup('category');
  assert.equal(AppView._getWorkshopGroup(), 'category', 'a tap retires the override');
  assert.equal(store.devWorkshopGroup, 'category');
  // A junk value is not a pane.
  const junk = makeAppView({ location: { search: '?group=lanes', hash: '', href: 'http://x/' } });
  assert.equal(junk._getWorkshopGroup(), 'category');
});

test('the stage pane runs edge to edge, and not by a 100vw full-bleed', () => {
  // #dev-workshop is a 760px reading column, which is right for one-line
  // rows and wrong for four side-by-side columns: bounded there the board is
  // a horizontal scroller before it is a board.
  assert.match(CSS, /#dev-workshop \{ max-width: 760px/, 'the column bound exists');
  assert.match(CSS, /#dev-workshop:has\(\.dev-ws-board\) \{ max-width: none; \}/,
    'and comes off when the board is up');
  // ...and goes back on to every OTHER child, so only the working PANE widens
  // — the toolbar, the tabs and the board travel together now, so the pane is
  // the unit that grows rather than the board wrapper inside it.
  //
  // IT HAS TO REACH THROUGH THE TAB BODY, and that is the bug this pins. The
  // rule once bound every direct child of `.dev-ws` except the pane; the tabs
  // put the pane one level deeper, inside `.dev-ws-tabbody`, so the bound
  // landed on the WRAPPER and the board was cramped to the reading column
  // from outside it. Measured at 1440: the pane stayed 760 while `.dev-ws`
  // itself had already widened to 1432, which is the shape of a bound applied
  // one level too high. Both halves are asserted, because dropping either
  // brings it back — the first for the rail and anything else that stays a
  // direct child, the second for the pane inside the body.
  assert.match(CSS,
    /#dev-workshop:has\(\.dev-ws-board\) > \.dev-ws > :not\(\.dev-ws-tabbody\),/);
  assert.match(CSS,
    /#dev-workshop:has\(\.dev-ws-board\) > \.dev-ws > \.dev-ws-tabbody > :not\(\.dev-ws-pane\) \{[^}]*max-width: 760px/);
  // Widening it must not DISSOLVE it. An earlier cut stripped the pane's sheet,
  // radius and padding on By stage, on the argument that a card face is a
  // frame drawn around the whole window; what that produced was the pane
  // vanishing and the sticky head's fill left behind as a bare rectangle over
  // the controls alone, with the board below belonging to no pane at all.
  const stageRules = CSS.slice(CSS.indexOf('#dev-workshop:has(.dev-ws-board) { max-width: none; }'),
    CSS.indexOf('.dev-ws-sort {'));
  assert.ok(!/\.dev-ws-pane \{[^}]*(border-radius: 0|background: none|padding: 0)/.test(stageRules),
    'the pane keeps its card face at every width');
  // The rejected alternative, pinned so it does not come back: 100vw counts
  // the scrollbar #dev-forum-scroll always has, so a negative-margin
  // full-bleed overflows by its width and adds a horizontal scrollbar.
  // Comments stripped first — the block explains WHY 100vw was rejected, and
  // the prose naming it is not the declaration this forbids.
  const block = CSS.slice(CSS.indexOf('.dev-ws-group {'), CSS.indexOf('.dev-ws-sort {'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\d+vw/.test(block), 'no viewport-width full-bleed declaration');
  // #dev-body drops to 4px of side padding for the Workshop, which reads as
  // a clipped edge once the board spans the window: 4 + 8 restores the 12px
  // the standalone board gets from #dev-body's own px-3.
  // The bottom is `--ws-gap` now, not 12px: it is the same air the sticky rail
  // rests on, so the gap under the bar is identical whether the lander fills
  // the scroller (rail at its bottom edge, padding decides) or overflows it
  // (rail stuck, `bottom` decides). At 12 against 8 they differed by 4px
  // depending on the tab. The sides are unchanged.
  assert.match(CSS, /#dev-body:has\(> #dev-workshop\) \{ padding: 8px 4px var\(--ws-gap, 8px\); \}/);
  assert.match(CSS, /\.dev-ws-board \{ padding: 2px 8px 0; \}/);
});

// ── The working pane: the controls, the switch, and what they act on ─────

test('the toolbar renders inside the Workshop pane, above the tabs', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([
    { id: 't1', title: 'Voting', items: [{ kind: 'issue', number: 12 }] },
  ]);
  const html = workshopHtml(AppView, 'all');
  const pane = html.indexOf('data-ws-pane');
  const head = html.indexOf('dev-ws-pane-head');
  const actions = html.indexOf('id="dev-actions"');
  const tabs = html.indexOf('data-ws-group="category"');
  const themesList = html.indexOf('dev-ws-themes');
  assert.ok(pane > 0, 'the pane renders');
  assert.ok(pane < head && head < tabs, 'the sticky head is the pane’s first child');
  // THE TABS LEAD. They decide what the search is searching, so the control
  // that sets the scope comes before the one that acts within it; the other
  // way round the pane had to be read bottom-up.
  assert.ok(tabs < actions, 'the tab strip sits above the toolbar');
  assert.ok(actions < themesList, 'and both above what they act on');
  // The two controls the toolbar exists for.
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'the filter host comes with it');
  assert.ok(html.includes('id="dev-plus-btn"'), 'and the "+"');
  // Everything ABOVE the pane stays outside it: those strips are facts about
  // the app, not things the search narrows.
  assert.ok(html.indexOf('data-ws-dashboard') < pane, 'the summary strip is above the pane');
  assert.ok(html.indexOf('data-discussion-row') < pane, 'and so is the discussion');
});

test('a search that matches nothing keeps the pane on screen, with the search box in it (#2090)', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't1', name: 'Voting', items: ['issue:12'] }]);
  AppView._kanbanFilters = { ...AppView._defaultKanbanFilters(), q: 'nothing matches this' };
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 0, 'no theme has a row left to draw');
  assert.equal(v.meta.filtered, true);
  const html = workshopHtml(AppView, 'all');
  // THE PANE STAYS. It was gated on having a theme to draw, so a search that
  // matched nothing unmounted the whole pane — the grouping tabs, the "+",
  // and the toolbar whose host the search field lives in. The one control
  // that could undo the search left the screen with the rows, and the viewer
  // was stuck on a board they could not widen back out.
  assert.ok(html.includes('data-ws-pane'), 'the pane renders');
  assert.ok(html.includes('id="dev-actions"'), 'with its toolbar');
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'and the host the search box fills');
  assert.ok(html.includes('id="dev-plus-btn"'), 'and the "+"');
  assert.ok(html.includes('data-ws-group="category"'), 'and the grouping tabs');
  // The rows' place says why they are gone, UNDER the controls it is about.
  assert.match(html, /data-ws-empty=""[^>]*>Nothing here matches the current search and filters\./);
  assert.ok(html.indexOf('id="dev-actions"') < html.indexOf('data-ws-empty'), 'beneath the toolbar');
  assert.ok(html.indexOf('dev-ws-pane-body') < html.indexOf('data-ws-empty'), 'in the pane body');
  // And nothing pretends there is a list: no sort row over an empty list, no
  // "0 categories", no footnote about how they were drafted.
  assert.ok(!html.includes('dev-ws-sort'), 'no sort row');
  assert.ok(!html.includes('dev-ws-themes'), 'no empty theme list');
  assert.ok(!html.includes('dev-ws-foot-note'), 'no grouping footnote');
  // Widen the search back out and the list is back, the note gone.
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  const back = workshopHtml(AppView, 'all');
  assert.ok(back.includes('dev-ws-themes'), 'the themes return');
  assert.ok(!back.includes('data-ws-empty'), 'and the note goes');
  // The declared check runs this state in a browser: the pane opened already
  // narrowed to a search nothing matches, through `?q=` (app-view.js, where
  // the seed is consumed on the first load so it can never hold a cleared
  // search). The note is what proves the search applied — without it the box
  // alone would pass on a pane the URL never narrowed.
  const check = dapp.tests.find((t) => /[?&]q=/.test(t.path || ''));
  assert.ok(check, 'a declared check opens the pane narrowed by ?q=');
  assert.match(check.path, /[?&]ws=all\b/, 'on All items');
  assert.match(check.expectSelector, /\[data-ws-pane\] > \.dev-ws-pane-head #dev-actions #dev-kanban-filterbar #dev-kanban-search$/,
    'and expects the search box, in the pane head');
  assert.equal(check.expectText, 'Nothing here matches the current search and filters.');
});

test('an empty board still gets the All items pane, and the note names the "+" that is in it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._merged = [];
  AppView._mergedTotal = 0;
  const v = AppView._workshopView();
  assert.equal(v.themes.length, 0);
  assert.deepEqual(plain(v.emptyNote), { loadFailed: false, filtered: false });
  const html = workshopHtml(AppView, 'all');
  assert.ok(html.includes('data-ws-pane'), 'the pane renders');
  assert.ok(html.includes('id="dev-kanban-filterbar"'), 'with the toolbar');
  assert.ok(html.includes('id="dev-plus-btn"'), 'and the "+" the note points at');
  assert.match(html, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /);
  assert.doesNotMatch(html, /Nothing here matches/, 'no filter is on, so it does not blame one');
  // The status tab keeps its own copy of the note, over the strips.
  const status = workshopHtml(AppView, 'status');
  assert.match(status, /data-ws-empty=""[^>]*>Nothing on the board yet\. Press /);
  assert.ok(!status.includes('data-ws-pane'), 'and no pane: that is the All items tab');
});

test('exactly one surface draws the toolbar, so its ids stay unique', () => {
  // #dev-actions, #dev-plus-btn and #dev-plus-menu are ids. Two copies on
  // screen would break _wirePlusMenu, which looks both up by getElementById.
  const FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
  assert.match(FRAME, /mode === 'workshop' \? null : \(\s*<DevActionsRow/,
    'the frame draws none on the Workshop');
  assert.match(WORKSHOP, /<DevActionsRow/, 'and the Workshop draws its own');
  // Neither file spells the markup itself any more.
  const ACTIONS = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(ACTIONS, /id="dev-actions"/, 'the markup has one home');
  assert.ok(!FRAME.includes('id="dev-actions"'), 'not the frame');
  assert.ok(!WORKSHOP.includes('id="dev-actions"'), 'and not the Workshop');
});

test('the "+" is re-wired when the toolbar changes surface', () => {
  // _wirePlusMenu ran ONCE, from renderDevView, because the row never moved.
  // It has two homes now, so a view switch unmounts one button and mounts
  // another and the listeners are left on a node that is gone — a "+" that
  // silently stops opening.
  assert.match(APP_VIEW_SRC, /_rewirePlusMenu\(\) \{/, 'there is a re-wire');
  const body = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _repaintDevBody() {'));
  const scoped = body.slice(0, body.indexOf('\n  _renderLockedNotice('));
  assert.equal((scoped.match(/AppView\._rewirePlusMenu\(\)/g) || []).length, 2,
    'called on BOTH branches — either switch can move the row');
  // Idempotent by construction: it aborts the previous controller first.
  assert.match(APP_VIEW_SRC, /AppView\._plusMenuAbort\?\.abort\(\);/);
});

test('the toolbar’s props cross roots through a store, not the view model', () => {
  // The Workshop is a separate React root from the frame that receives those
  // props, so they are published once at mountBoard.
  const MOUNT = read('frontend/src/features/dev-board/mount.ts');
  const STORE = read('frontend/src/features/dev-board/actions-store.ts');
  assert.match(MOUNT, /publishDevActions\(\{/, 'seeded where the frame is mounted');
  assert.match(WORKSHOP, /useDevActions\(\)/, 'and read by the Workshop');
  // Identity-cached: mountBoard runs on every navigation back onto the Dev
  // screen, and a fresh object each time would re-render the "+" menu for no
  // change. (A snapshot that is !== the last one is what re-renders.)
  assert.match(STORE, /if \(same\) return;/, 'unchanged props publish nothing');
  // NOT folded into _workshopView(): those are app permissions, and that view
  // model is rebuilt from the card caches on every repaint.
  assert.ok(!/canCollaborate/.test(APP_VIEW_SRC.slice(
    APP_VIEW_SRC.indexOf('  _workshopView()'),
    APP_VIEW_SRC.indexOf('  _workshopView()') + 4000)),
    'the workshop view model carries no permission flags');
});

test('the pane head pins, and the pane does not clip what must escape it', () => {
  assert.match(CSS, /\.dev-ws-pane-head \{[^}]*position: sticky/);
  assert.match(CSS, /\.dev-ws-pane-head \{[^}]*top: 0/);
  // The head wears the PANE'S OWN face, not a solid fill: this is one surface
  // with a part of it pinned, not a separate bar laid over it. What passes
  // under stays readable because the frost blurs it — and the filter has to be
  // RE-DECLARED here, not inherited, because a backdrop-filter applies to what
  // is behind the element it is set on, and these rows are inside the pane.
  // ONE FACE, painted by the two PARTS and not by the pane. A fill on the pane
  // with a second one on the head stacked 50% on 50% — measurably lighter
  // across the controls (251,251,252 against the body's 250,250,252) — and
  // because a backdrop-filter makes an element a backdrop root, the head's
  // frost was a SECOND frost over the pane's, so the two could not be squared
  // by tuning the fill either. Head and body now carry the same fill over the
  // same backdrop, which makes them equal by construction.
  assert.match(CSS,
    /\.dev-ws-pane-head, \.dev-ws-pane-body \{[^}]*background-color: var\(--dc-sheet-fill\)[^}]*backdrop-filter: var\(--dc-frost\)/);
  const paneDecls = CSS.slice(CSS.indexOf('.dev-ws-pane {'),
    CSS.indexOf('}', CSS.indexOf('.dev-ws-pane {')));
  assert.ok(!/background|backdrop-filter/.test(paneDecls),
    'the pane paints nothing itself — that is what stops the two stacking');
  // The head's frost still works on the rows, because the body is its SIBLING:
  // what scrolls inside the body passes through the head's backdrop.
  assert.match(WORKSHOP, /className="dev-ws-pane-head"[\s\S]*?className="dev-ws-pane-body"/,
    'head and body are siblings, head first');
  for (const token of ['--dc-sheet-fill', '--dc-frost', '--dc-sheet']) {
    assert.ok(CSS.includes(`${token}:`), `${token} is defined`);
  }
  // ...and where there is no backdrop-filter the fill is ALL there is, so it
  // falls back opaque. 50% white with rows sliding crisply under it is the
  // rendering fault the frost prevents, not a slightly flatter bar. Every
  // other frosted surface in this file carries the same guard.
  // Both halves go opaque TOGETHER — staying the same colour as each other
  // matters more here than either one's material.
  assert.match(CSS,
    /@supports not \(\(backdrop-filter[^{]*\{\s*\.dev-ws-pane-head, \.dev-ws-pane-body \{ background-color: var\(--dc-sheet\); \}/,
    'head and body fall back to the same opaque fill');
  // On By stage the BAR spans the window — it is a pinned edge, and one that
  // stopped short of the board under it would look like a mistake — but what
  // sits IN it keeps the reading column. The exact bound is asserted below,
  // with the gutter correction that keeps it from growing on the switch.
  // Two things inside this subtree must escape the pane's box: the "+" menu is
  // absolutely positioned, and sticky does not work under a clipping ancestor.
  assert.match(CSS, /\.dev-ws-pane \{[^}]*overflow: visible/);
  assert.ok(!/overflow: hidden/.test(paneDecls), 'never clipped to hide the radius');
  // The controls must not GROW when you switch panes. On By stage they are
  // bounded to the reading column MINUS the head's own gutter — bounding to
  // the column's outer width made them 20px wider there (740 against 760),
  // a toolbar that changed size on a tab click.
  assert.match(CSS,
    /#dev-workshop:has\(\.dev-ws-board\) \.dev-ws-pane-head > \* \{[\s\S]*?max-width: calc\(760px - 20px\)/);
});

test('the declared stage check still describes the pane it has to walk', () => {
  // It broke once, and silently: the check merged with the grouping tabs, and
  // the working pane then moved `.dev-ws-board` inside `.dev-ws-pane-body`
  // while the selector still read `.dev-ws-group + .dev-ws-board` — an
  // adjacency that only held while both were direct children of `.dev-ws`.
  // Nothing locally noticed, because a declared selector is a STRING here and
  // only the staging gate resolves it.
  //
  // So this asserts the chain against the same source the checks walk: every
  // class in it must be one the component actually renders, in the nesting
  // order it renders them.
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => /group=stage/.test(t.path || '')
    && /dev-ws-board/.test(t.expectSelector || ''));
  assert.ok(check, 'the stage check exists');
  assert.ok(!/\.dev-ws-group \+ \.dev-ws-board/.test(check.expectSelector),
    'the retired adjacency is gone');
  assert.match(check.expectSelector, /\[data-ws-pane\] > \.dev-ws-pane-body > \.dev-ws-board/,
    'it walks head-and-body pane, as the component renders it');
  // ...and the component really does nest them that way.
  assert.match(WORKSHOP, /className="dev-ws-pane-body"[\s\S]{0,400}className="dev-ws-board"/);
});

test('the ?ws= deep link survives arriving AFTER the first paint', () => {
  // THE BUG THIS PINS COST A WHOLE CHECK CYCLE. The tab was seeded from the
  // publish alone — `useState(() => v.tab || 'status')` — and that initialiser
  // runs against whatever the store holds AT MOUNT, which is
  // EMPTY_WORKSHOP_VIEW. The legacy module publishes `_workshopView()` after
  // its data load, so on a cold open `v.tab` is undefined in that first frame
  // and the deep link was dropped on the floor: every `?ws=all` route landed
  // on Current status, and 25 declared checks failed on routes that read
  // perfectly. `autoExpand` has carried a late-arrival effect since it
  // shipped, which is precisely why `?shot=themes` worked where `?ws=` did
  // not.
  //
  // Asserted as source text because nothing here runs effects: these tests
  // render statically, so the only local witness to an effect is the code.
  assert.match(WORKSHOP, /const \[tab, setTab\] = useState<TabKey>\(\(\) => v\.tab \|\| 'status'\);/,
    'the seed still paints the right tab on the first frame when the view is already there');
  assert.match(
    WORKSHOP,
    /const deepTabApplied = useRef<boolean>\(!!v\.tab\);\s*useEffect\(\(\) => \{\s*if \(deepTabApplied\.current \|\| !v\.tab\) return;\s*deepTabApplied\.current = true;\s*setTab\(v\.tab\);\s*\}, \[v\.tab\]\);/,
    'and an effect applies it when the publish lands later',
  );
  // The ref is not decoration. `v.tab` reads the URL, so it never changes for
  // the life of the page, while `_rerenderWorkshop()` republishes on every
  // data change — an unguarded effect would yank a reader who had tapped
  // another tab back to the deep-linked one on the next refresh.
  assert.ok(/deepTabApplied\.current \|\| !v\.tab/.test(WORKSHOP),
    'applied once, so a later republish cannot override the reader');
});

test('the phone rail is fixed to the real viewport, not to its container', () => {
  // THREE FIXES FAILED HERE BEFORE THIS ONE, and they failed the same way:
  // the bar's resting place was derived from the container it sat in, so it
  // depended on `--ws-area`'s viewport arithmetic, the flex chain filling,
  // `.platform-safe-scroll`'s padding and `100dvh` — every one of which
  // behaved differently on a real iOS PWA than in a headless Chromium, where
  // all three measured correct. A fixed element depends on none of them.
  //
  // `position: fixed` was the ORIGINAL design and was abandoned because the
  // Dev frame's `.dc-lift-strip` carries a `backdrop-filter`, which
  // establishes a containing block for fixed descendants — so `bottom` meant
  // the bottom of a frosted panel. The bar is portalled out of that frost now,
  // which is what makes the keyword mean the screen again.
  const rail = /\n\.dev-ws-tabs \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(rail, 'the rail rule exists');
  assert.match(rail[1], /position: fixed;/, 'pinned to the viewport');
  // Comments stripped: the block above NAMES `position: sticky` to say what it
  // replaces, and prose naming a declaration is not the declaration — the
  // third absence check in this file to need saying so.
  const railDecls = rail[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/position: sticky/.test(railDecls), 'not to its container');
  // A FLOATING PILL, RESTING LOW. It went edge-to-edge for one round, on the
  // reasoning that a surface reaching the physical edge is what iOS does with
  // its own tab bars. It is — but it is not what this app wants: the shape
  // that reads right here is the oval, and the complaint was never the shape.
  // It was that the oval sat too high, reserving the whole gesture inset.
  assert.match(rail[1], /border-radius: 999px;/, 'a pill, not a strip');
  assert.match(rail[1], /left: 10px; right: 10px;/, 'inset from the side edges');
  assert.match(rail[1], /bottom: var\(--ws-lift\);/, 'and floating on the lift');
  // THE LIFT IS NOT THE WHOLE INSET. 34px is Apple's GESTURE zone; the
  // indicator GRAPHIC is a thin line about 8px off the bottom. Reserving all
  // of it is what made the pill read as stopping short of the phone.
  // Trimmed twice, the second time from a preview on a real phone rather than
  // a guess. There is little further to go: the indicator LINE sits about 8px
  // up and is roughly 5px tall, so its top edge is near 13px — 14px is the
  // last value with visible air between the two.
  assert.match(CSS, /--ws-lift: max\(8px, calc\(var\(--platform-safe-bottom, 0px\) - 20px\)\);/);
  // `max()` because a device with no indicator reports 0, and `0 - 16px` would
  // tuck the pill off the bottom of the screen.
  const lift = /--ws-lift: ([^;]+);/.exec(CSS);
  assert.match(lift[1], /^max\(/, 'the floor is a max, not a bare subtraction');
  // The inset is spent ONCE in the bar rule — inside the lift, via the token.
  const insetSpends = (rail[1].replace(/\/\*[\s\S]*?\*\//g, '').match(/--platform-safe-bottom/g) || []).length;
  assert.equal(insetSpends, 0, 'the bar reads the lift, not the inset directly');
  // `order` survives for the single render before the portal takes over.
  assert.match(rail[1], /^\s*order: 1;$/m);

  // THE PORTAL, and the two rules that keep it honest.
  assert.match(WORKSHOP, /import \{ createPortal \} from 'react-dom';/);
  assert.match(WORKSHOP, /function useRailHost\(\): HTMLElement \| null \{/);
  // Null until after mount, so the FIRST render is always the in-place one and
  // never disagrees with prerendered markup — a hydration mismatch is a
  // console error, and a console error on any route fails proposal checks.
  assert.match(WORKSHOP, /const \[host, setHost\] = useState<HTMLElement \| null>\(null\);/);
  // ONE SPELLING OF THE BREAKPOINT. It was written out at this call site; the
  // ask composer needs the same query to know whether to open expanded, and
  // two literals of one decision is how they drift apart from each other and
  // from app.css's `@media (min-width: 700px)` block.
  assert.match(WORKSHOP, /const WIDE_QUERY = '\(min-width: 700px\)';/);
  assert.match(WORKSHOP, /useEffect\(\(\) => \{[\s\S]{0,400}?matchMedia\(WIDE_QUERY\)/,
    'the host is resolved in an effect, not during render');
  // Null above the breakpoint too: up there the strip is the segmented control
  // in flow at the head of the column, and there is nothing to lift out.
  assert.match(WORKSHOP, /setHost\(mq\.matches \? null : document\.getElementById\('dev-ws-rail-host'\)\);/);
  assert.match(WORKSHOP, /\{railHost \? createPortal\(railNode, railHost\) : null\}/);
  assert.match(WORKSHOP, /\{railHost \? null : railNode\}/,
    'and the same node renders in place when there is no host');

  // THE HOST IS OUTSIDE THE FROST. This is the whole mechanism: if it ever
  // moves inside `.dc-lift`, `fixed` silently starts resolving against the
  // frosted panel again and the bug returns with no test to catch it.
  // It is rendered at the shell's TOP LEVEL — six-space indent, sibling of the
  // islands — which is what puts it outside every frame the Dev board mounts
  // at runtime. Shell.tsx renders no `.dc-lift` element itself; the frosted
  // wrappers all come from features/dev-board, below #app-view.
  //
  // Ancestry is a DOM property and a source file cannot assert it, so the real
  // check is the harness walking the rail's live ancestor chain for anything
  // with transform / filter / backdrop-filter / contain. This pins the half
  // that IS expressible: the host stays where the shell put it.
  assert.match(SHELL, /^      <div id="dev-ws-rail-host" \/>$/m,
    'the host is a top-level child of the shell body');
  assert.match(SHELL, /<Island name="LegacyPortals"><LegacyPortals \/><\/Island>[\s\S]*?<div id="dev-ws-rail-host" \/>/,
    'and sits with the other end-of-body anchors');

  // THE BAR IS OUT OF FLOW, so nothing reserves its space automatically and
  // three rules have to agree about its footprint. It is one token, so they
  // agree by construction rather than by being remembered.
  // The token is the bar's BOX, not its footprint: its own lower padding
  // covers the home-indicator strip, and below `.dev-ws` that strip is already
  // held open by `.platform-safe-scroll`. Counting it here too reserved it
  // twice — measured, 51px of slack above the bar at a 34px inset against 17px
  // at zero. Box only gives 9px at both.
  assert.match(CSS, /--ws-bar: 72px;/);
  assert.ok(!/--ws-bar: calc\(72px \+ var\(--platform-safe-bottom/.test(CSS),
    'the inset is reserved below the bar, not inside this token');
  // The fitted deck ends above the bar...
  const area = /\.dev-ws \{[\s\S]*?--ws-area: calc\(([\s\S]*?)\);/.exec(CSS);
  assert.ok(area, 'the floor exists');
  assert.match(area[1], /var\(--ws-bar\)/, 'the floor takes the bar off');
  assert.match(area[1], /var\(--ws-lift\)/, 'and the air it floats on');
  // AND `--ws-fit` IS A SECOND, DIFFERENT QUANTITY beside it, not the floor
  // plus something: where `.dev-ws` ends when the chain above it has a
  // definite height — the reading area less `.platform-safe-scroll`'s
  // reservation and `#dev-body`'s bottom padding, which are the two things
  // below it. The pill overlays the last `--ws-bar` of that, as it overlays
  // every tab. The two coincide only at a zero inset: at 34px the pill lifts
  // by 14 and the scroller gives back 34.
  const fit = /--ws-fit: calc\(([\s\S]*?)\);/.exec(CSS);
  assert.ok(fit, 'the fitted box exists');
  assert.match(fit[1], /var\(--ws-gap\)/);
  assert.match(fit[1], /var\(--platform-safe-bottom, 0px\)/);
  assert.ok(!/--ws-bar|--ws-lift/.test(fit[1]),
    'it is the box the pill sits ON, so it names neither the pill nor its air');
  // ...and a scrolling tab's last card clears one.
  // WHAT SITS BETWEEN `.dev-ws`'s FOOT AND THE PILL'S TOP. Subtracting the
  // inset is what makes the remaining air independent of it — it works out to
  // `--ws-gap` exactly, whatever the device reports. Measured, the version
  // without it gave 0px of air at a 0 inset and 34px at a 34px one: the
  // composer touching the pill on one phone and floating clear of it on
  // another.
  assert.match(CSS, /padding-bottom: calc\(var\(--ws-bar\) \+ var\(--ws-lift\) - var\(--platform-safe-bottom, 0px\)\);/);
  // AND NEEDS YOU IS NO LONGER EXEMPT. It was, while the rail sat in flow and
  // took its own space; a fixed bar overlays every tab equally. With the
  // exemption left in, the deck filled to the foot of `.dev-ws` and the
  // composer ran 63px UNDER the bar — measured, not predicted.
  assert.ok(!/\.dev-ws\[data-ws-tab="needs"\] > \.dev-ws-tabbody \{ padding-bottom: 0/.test(
    CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'every tab owes the same clearance because every tab has the same thing on top');
  // ABOVE THE BREAKPOINT the bar is back in flow at the head of the column, so
  // it takes its own space and the floor must not subtract it again.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide block exists');
  assert.match(wide[1], /--ws-area: calc\([\s\S]*?- var\(--ws-gap\)\n?\s*\);/,
    'the wide floor takes only the air off');
  assert.ok(!/--ws-bar/.test(wide[1].replace(/\/\*[\s\S]*?\*\//g, '')),
    'and not the bar, which is in flow up there');

  // Still NOT `.platform-safe-bar`: that rule puts the inset inside the
  // element's own padding, which on this pill landed 8px under the tabs
  // against 6px over them. The bar floats; the inset belongs in the offset.
  assert.ok(!/dev-ws-tabs platform-safe-bar/.test(WORKSHOP),
    'the floating pill carries the inset in its offset, not in its padding');
});

test('the ask composer keeps a visible send, and opens with it in the bottom-right corner', () => {
  // The whole controls row used to sit behind focus, which took the send
  // circle with it and left a card that looked like a text box and nothing
  // else — no sign it would do anything. The card has no shut state any
  // more, so the circle has ONE home: the bottom-right corner, where
  // `.dc-card-row` puts the dev session's own.
  const send = /const sendBtn = \(([\s\S]*?)\n  \);/.exec(WORKSHOP);
  assert.ok(send, 'the circle is written ONCE, so its two homes cannot drift');
  assert.match(send[1], /className="dc-send-btn dc-circle-send dev-ws-ask-send"/);
  assert.match(send[1], /disabled=\{!draft\.trim\(\) \|\| !target \|\| inFlight\}/);
  const line = /<div className="dev-ws-ask-line">([\s\S]*?)<\/div>/.exec(WORKSHOP);
  assert.ok(line, 'the composer has a resting line');
  assert.match(line[1], /id="dev-ws-ask-input"/, 'the field is on it');
  assert.ok(!/\{expanded/.test(WORKSHOP),
    'nothing in the composer waits for a tap: the controls row is always there');
  const row = /<div className="dev-ws-ask-row">([\s\S]*?)\n          <\/div>/.exec(WORKSHOP);
  assert.ok(row, 'the controls row is written once, ungated');
  assert.match(row[1], /data-ws-ask-model/, 'the model picker is in it');
  assert.match(row[1], /\{sendBtn\}/, 'and the circle, as the row\'s last child');
  assert.ok(row[1].indexOf('data-ws-ask-model') < row[1].indexOf('{sendBtn}'),
    'model left, send right');
  // `margin-left: auto` rather than `justify-content`: the picker beside it
  // has to keep shrinking (a <select>'s intrinsic width is its longest
  // option), and with no picker at all the circle is the row's only child and
  // the auto margin still pins it right. Measured at 1280x900: the circle
  // rests 14px from the card's right edge and 12px from its bottom, which is
  // the card's own padding on both sides.
  assert.match(CSS, /\.dev-ws-ask-row > \.dev-ws-ask-send \{ margin-left: auto; \}/);
});

test('the filter host asks to be filled, because the repaint that fills it runs too early', () => {
  // THE ORDER IS THE BUG. `_repaintDevBody()`'s Workshop branch creates an
  // empty `#dev-workshop` and then calls `_renderKanbanFilterBar()` — but
  // `#dev-kanban-filterbar` is a node of the TOOLBAR, which the Workshop's
  // All-items pane renders, so on the first visit of a page session the
  // filler ran against a host that did not exist yet, returned at its own
  // guard, and the search field appeared only on whatever repaint happened to
  // come next: a WebSocket push, or a pull-to-refresh. "The search is missing
  // for a few seconds and then it is there."
  assert.match(APP_VIEW_SRC, /body\.innerHTML = '<div id="dev-workshop"><\/div>';[\s\S]*?AppView\._renderKanbanFilterBar\(\);/,
    'the module still fills the strip on the repaint — this is that ordering');
  assert.match(APP_VIEW_SRC, /_renderKanbanFilterBar\(\) \{\s*const el = document\.getElementById\('dev-kanban-filterbar'\);\s*if \(!el\) return;/,
    'and it is a no-op when the host is absent, which is why nothing was drawn');
  // So the host asks for itself, on the effect after it mounts.
  assert.match(ACTIONS_ROW, /<div id="dev-kanban-filterbar"/, 'the toolbar owns the host');
  assert.match(ACTIONS_ROW, /queueMicrotask\(\(\) => \{ if \(live\) callAppView\('_renderKanbanFilterBar'\); \}\);/);
  // IN A MICROTASK, and that is React's own instruction rather than a taste.
  // The mount publishes inside `flushSync`, and a `flushSync` raised while
  // React is still committing answers with "flushSync was called from inside
  // a lifecycle method… Consider moving this call to a scheduler task or
  // micro task" — an effect body is inside that commit, passive or not.
  // Checked both ways in a browser on a development React build: from the
  // effect body it fires, from the microtask it does not.
  assert.match(read('frontend/src/lib/legacy-portals.tsx'), /function commit\(\): void \{\s*flushSync\(publish\);/,
    'the synchronous publish the mount goes through');
  assert.ok(!/useLayoutEffect/.test(ACTIONS_ROW), 'and the effect is passive, not a layout one');
  // Cancelled on unmount, so a row torn down inside the same tick does not
  // mount a portal into a host that has already been discarded.
  assert.match(ACTIONS_ROW, /return \(\) => \{ live = false; \};/);
  // Nothing waits on it: the host holds the field's row open from the
  // frame's first paint, so arriving a beat later shifts nothing under it.
  assert.match(ACTIONS_ROW, /id="dev-kanban-filterbar" className="flex-1 min-w-0 min-h-8"/);
});

test('the "+" asks to be wired when its row mounts, because the module wires it before the row exists (#2141)', () => {
  // THE ORDER IS THE BUG, AGAIN, one line further down the same branch. The
  // module wires the button from `_repaintDevBody`, on the line after
  // `_rerenderWorkshop()` — by id, so it is a no-op while the button is not
  // in the DOM.
  assert.match(APP_VIEW_SRC, /AppView\._rerenderWorkshop\(\);\s*AppView\._rewirePlusMenu\(\);/,
    'the module wires on the repaint, after the Workshop publish');
  assert.match(APP_VIEW_SRC, /_wirePlusMenu\(content\) \{\s*const btn = document\.getElementById\('dev-plus-btn'\);\s*const menu = document\.getElementById\('dev-plus-menu'\);\s*if \(!btn \|\| !menu\) return;/,
    'and it returns at its own guard when the "+" is absent');
  // Two ways the row arrives AFTER that line. A tap on All items mounts the
  // pane from React state, and the module side of the tap only persists the
  // choice — nothing re-runs the wiring.
  assert.match(WORKSHOP, /onClick=\{\(\) => \{ setTab\(t\.key\); callAppView\('_setWorkshopTab', t\.key\); \}\}/);
  const setTab = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _setWorkshopTab(key) {'));
  const setTabBody = setTab.slice(0, setTab.indexOf('\n  },'));
  assert.match(setTabBody, /localStorage\.setItem\(AppView\.WORKSHOP_TAB_KEY, next\)/);
  assert.ok(!/_rewirePlusMenu|_repaintDevBody|_rerenderWorkshop/.test(setTabBody),
    'the tab is persisted, not repainted');
  // And a deep-linked or remembered `ws=all` reaches a cold Workshop through
  // the late-arrival effect on `v.tab`: a state update raised inside a
  // passive effect is scheduled at default priority, so the pane lands a task
  // AFTER the synchronous publish the module's call follows.
  assert.match(WORKSHOP, /useState<TabKey>\(\(\) => v\.tab \|\| 'status'\)/);
  assert.match(WORKSHOP, /useEffect\(\(\) => \{\s*if \(deepTabApplied\.current \|\| !v\.tab\) return;\s*deepTabApplied\.current = true;\s*setTab\(v\.tab\);\s*\}, \[v\.tab\]\);/);
  // So the row asks for itself, from the mount effect that already asks for
  // the filter strip.
  const effect = ACTIONS_ROW.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\);/);
  assert.ok(effect, 'the mount effect');
  assert.match(effect[0], /callAppView\('_rewirePlusMenu'\);/);
  // In the effect BODY, not the microtask: the wiring binds listeners and
  // flushes nothing through React, so there is nothing for a microtask to
  // keep out of the commit, and the nodes it looks up are committed by the
  // time any effect runs. The strip keeps its microtask; see the test above.
  assert.match(effect[0], /queueMicrotask\(\(\) => \{ if \(live\) callAppView\('_renderKanbanFilterBar'\); \}\);\s*callAppView\('_rewirePlusMenu'\);/);
  const wire = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  _wirePlusMenu(content) {'));
  const wireBody = wire.slice(0, wire.indexOf('\n  },'));
  assert.ok(!/_reactDevBoard|publish|flushSync|innerHTML/.test(wireBody), 'listeners only');
  assert.match(wireBody, /AppView\._plusMenuAbort\?\.abort\(\);/,
    'and re-entrant: the previous handlers go before the next ones bind');
});

test('re-running the wiring from the row is safe: nothing bound while the "+" is absent, one live handler once it is', () => {
  // The module half of the fix above, executed: the sequence the row's mount
  // now produces is "the module called with no button, then the row called
  // with one, then the module again on the next repaint", and every step has
  // to leave at most one handler on the node. Real EventTargets, so the
  // `{ signal }` each listener carries is honoured by the dispatch.
  const target = () => {
    const node = new EventTarget();
    node.click = () => node.dispatchEvent(new Event('click'));
    node.attrs = {};
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.querySelector = () => null;
    node.querySelectorAll = () => [];
    return node;
  };
  const content = target();
  const btn = target();
  const menu = target();
  const cls = new Set(['hidden']);
  menu.classList = {
    add: (c) => { cls.add(c); },
    remove: (c) => { cls.delete(c); },
    contains: (c) => cls.has(c),
    toggle: (c) => (cls.has(c) ? (cls.delete(c), false) : (cls.add(c), true)),
  };
  const present = { 'app-content': content };
  const AppView = makeAppView({
    document: {
      getElementById: (id) => present[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    globals: { AbortController, PlatformUI: { isTouch: () => false } },
  });
  AppView.refreshDevChatSecretsState = () => {};
  // 1. The button is not in the DOM (the lander is on Current status, or a
  //    cold Workshop is on its first frame): the module's call binds nothing.
  AppView._rewirePlusMenu();
  assert.equal(AppView._plusMenuAbort, undefined, 'nothing bound, so nothing to abort');
  // 2. The row mounts and asks: the button opens the menu.
  present['dev-plus-btn'] = btn;
  present['dev-plus-menu'] = menu;
  AppView._rewirePlusMenu();
  btn.click();
  assert.equal(cls.has('hidden'), false, 'the menu opens');
  assert.equal(btn.attrs['aria-expanded'], 'true');
  // 3. The module's own repaint call lands on top: still one handler, so a
  //    click toggles once (shut) rather than twice (shut, then open again).
  AppView._rewirePlusMenu();
  btn.click();
  assert.equal(cls.has('hidden'), true, 'closes: one toggle, not two');
  assert.equal(btn.attrs['aria-expanded'], 'false');
  btn.click();
  assert.equal(cls.has('hidden'), false, 'and opens again');
});

test('Needs you is a fitted screen on a phone, in the page-scrolling layout too', () => {
  // MEASURED, in the harness that loads the real generated shell and the real
  // app.css at 402x874, with a nine-paragraph summary on the card, at a 34px
  // home-indicator inset and at none.
  //
  // NATIVE layout (bounded #dev-forum-scroll): the deck refused to shrink and
  // the lander grew instead — `.dev-ws` 1803px tall, the composer 910px below
  // the fold — because `.dev-ws` is a flex ITEM whose automatic minimum size
  // is its content, and it was the one link in the chain without
  // `min-height: 0`.
  assert.match(CSS, /#dev-workshop > \.dev-ws\[data-ws-tab="needs"\] \{ min-height: 0; \}/);
  // ONLY that tab: the other two are meant to grow and scroll inside
  // #dev-forum-scroll, and `.dev-ws-tabbody` is not a scroller itself, so
  // shrinking them would clip what they hold rather than make it reachable.
  assert.ok(!/#dev-workshop > \.dev-ws \{[^}]*min-height: 0/.test(CSS),
    'the rule is scoped to the fitted tab');
  // BROWSER layout (`html[data-browser-scroller]`, which is what a mobile
  // browser gets): every height below the scroller is `auto` there, so
  // `--ws-area` is only a floor and a long card pushed the composer under the
  // fold with nothing pinned — while a SHORT one stopped EARLY, because the
  // floor is not the same number as the clearance `.dev-ws-tabbody` reserves:
  // 79px of dead air under the composer at a zero inset and 51px at 34,
  // against the native layout's 8 at both. The tab takes `--ws-fit` as a
  // definite height instead — the box the native chain arrives at on its own
  // — and both layouts then land the composer 7-8px under the pill, tall card
  // or short, at either inset.
  const fitted = /@media \(max-width: 699\.98px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(fitted, 'the phone-only block exists');
  assert.match(fitted[1], /html\[data-browser-scroller\] \.dev-ws\[data-ws-tab="needs"\] \{[\s\S]*?height: var\(--ws-fit\);[\s\S]*?min-height: var\(--ws-fit\);/);
  // Scoped to the PHONE as well as to the layout, and that is load-bearing:
  // `data-browser-scroller` is set on any coarse pointer (MOBILE_PAGE_QUERY),
  // tablets included, and above 700px `--ws-area` no longer takes the bar off
  // — so `--ws-fit` would be a bar too tall up there.
  assert.match(read('frontend/src/lib/browser-scroll.ts'),
    /MOBILE_PAGE_QUERY = '\(max-width: 767px\), \(hover: none\) and \(pointer: coarse\)';/,
    'which is why the layout attribute alone is not a phone');
  // What scrolls when the card is long is the card's own pane; the answers,
  // the page arrows and the ask box are the fitted parts and stay put.
  assert.match(CSS, /\.dev-ws-needs-scroll \{[\s\S]*?overflow-y: auto;/);
});

test('the ask card is padded evenly, so its resting line sits on its own middle', () => {
  // `.dc-card` ships `0.875rem 1rem 0.625rem` — 14 over, 10 under — which is
  // right for the dev session's composer, a tall field with controls beneath
  // it. Here, at rest, the card holds ONE line, and 14 against 10 put that
  // line 2px below the middle of its own box. That is what "the ask box sits
  // slightly low" was. Measured at 402x874: a 58px card with a 34px line
  // starting at 14.
  assert.match(CSS, /\.dev-ws-ask-composer \{[^}]*padding: 12px 14px;/);
  assert.match(CSS, /\.dc-card \{[\s\S]*?padding: 0\.875rem 1rem 0\.625rem;/,
    'the session card keeps its own, which is why this is an override rather than a change');
});

test('since-your-last-visit shows three and reveals the rest, like the week walk', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  // Four merges instead of one, so the strip holds more than it draws.
  AppView._merged = [40, 39, 38, 37].map((n, i) => ({
    id: 78 - i, pr_number: n, pr_title: `Landed ${n}`, status: 'merged', username: 'alice',
    created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }));
  AppView._mergedTotal = 4;
  const html = workshopHtml(AppView);
  assert.match(html, /class="dev-ws-since-n">6</, 'the count is the whole list');
  assert.equal((html.match(/data-ws-row="since:/g) || []).length, 3, 'three are drawn');
  // The week walk's own control: centred under a stack of full-width rows,
  // caret DOWN at what it is about to show. Not `.dev-ws-reveal-start`, whose
  // lane indent belongs to a left-aligned column of type.
  assert.match(html, /class="dev-ws-reveal dev-ws-since-more" data-ws-since-more=""/);
  assert.ok(html.includes('Show older'));
  assert.ok(!html.includes('dev-ws-reveal-start'), 'centred, as the week walk is');
  // No "show fewer" — this is one pane with a way to ask for more, not a
  // thing being opened and shut. The week walk's note is the same argument.
  assert.ok(!html.includes('Show fewer'));
  // An empty list is a heading over nothing, so it says so instead. A
  // baseline of NOW rather than an emptied board: "nothing moved since you
  // were last here" is a statement about the window, and the window is what
  // the reader controls.
  const fresh = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now()) } });
  seed(fresh);
  const quiet = workshopHtml(fresh);
  assert.match(quiet, /data-ws-since-none=""/);
  assert.ok(quiet.includes('Nothing has changed since you were last here.'));
  // #2183: the way down is still there on a quiet day — that is the day the
  // reader most wants it — and live, because everything on the board is
  // now on the far side of the line.
  assert.match(quiet, /data-ws-since-more=""(?! disabled)/);
});

// ── #2183: Clear, and a Show older that is always there ──────────────

test('since-your-last-visit publishes the rest of the list as "seen", newest first', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  const v = AppView._workshopView();
  // Issue 13 was filed twenty days ago and last touched nine days ago: on
  // the far side of the line, so it is the one row the reader has seen.
  assert.deepEqual(plain(v.since.rows.map((r) => r.key).sort()), ['since:issue:12', 'since:merged:78', 'since:proposal:34']);
  assert.deepEqual(plain(v.since.seen.rows.map((r) => r.key)), ['seen:issue:13']);
  assert.equal(v.since.seen.total, 1);
  assert.ok(!v.since.seen.rows[0].fresh, 'nothing on that side is new');
  // `through` is the newest stamp among the new rows — what Clear moves the
  // line up to, so a row a clock put a moment ahead goes with the rest.
  assert.equal(v.since.through, Date.parse(AppView._ghIssues[0].updatedAt), 'issue 12, touched a day ago, is the newest');
  assert.ok(v.since.through > v.since.baseline);
  assert.ok(v.since.through <= Date.now());

  // The seen list is the SAME activity list below the line, newest first,
  // capped like the new one: thirty-five merges from before the visit draw
  // as thirty, with the whole rest counted.
  const many = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) } });
  seed(many);
  many._merged = Array.from({ length: 35 }, (_, i) => ({
    id: 200 + i, pr_number: 300 + i, pr_title: `Old ${i}`, status: 'merged', username: 'alice',
    created_at: at(10 + i), merged_at: at(10 + i), last_message_at: at(10 + i), row_type: 'pr',
  }));
  many._mergedTotal = 35;
  const mv = many._workshopView();
  assert.equal(mv.since.seen.rows.length, many.WORKSHOP_SEEN_MAX);
  assert.equal(many.WORKSHOP_SEEN_MAX, 30);
  assert.equal(mv.since.seen.total, 36, 'the thirty-five merges and issue 13');
  assert.equal(mv.since.seen.rows[0].key, 'seen:issue:13', 'nine days ago comes before ten');
  assert.equal(mv.since.seen.rows[1].key, 'seen:merged:200');
});

test('Clear moves the baseline to now, persists it, and the rows move under Show older', () => {
  const store = {};
  store['workshopSeen:demo-app'] = String(Date.now() - 3.5 * 86400000);
  const AppView = makeAppView({ localStorage: store });
  seed(AppView);
  const before = AppView._workshopView();
  assert.equal(before.since.rows.length, 3);
  const html = workshopHtml(AppView);
  assert.match(html, /<button type="button" class="dev-ws-since-clear" data-ws-since-clear="">Clear<\/button>/,
    'live, because there is something to clear');

  AppView._workshopClearSince('demo-app', before.since.through);
  const after = AppView._workshopView();
  assert.equal(after.since.rows.length, 0, 'nothing is new any more');
  assert.ok(after.since.baseline >= before.since.through, 'the line moved up to now');
  assert.ok(after.since.baseline >= Date.now() - 1000);
  // The three cleared rows are on the seen side now, newest first, ahead
  // of the one that was already there.
  assert.deepEqual(plain(after.since.seen.rows.map((r) => r.key)),
    ['seen:issue:12', 'seen:merged:78', 'seen:proposal:34', 'seen:issue:13']);
  assert.equal(after.since.seen.total, 4);
  assert.equal(after.themes.length ? after.themes[0].counts.fresh : 0, 0, 'the "new" marks go with it');
  // Persisted the way the baseline is: the SAME localStorage key, so a
  // reload does not bring the list back...
  assert.equal(store['workshopSeen:demo-app'], String(after.since.baseline));
  // ...and held in memory for the page session, so a WS-driven repaint
  // compares against the new line rather than re-reading the old one.
  assert.equal(AppView._workshopSince['demo-app'], after.since.baseline);
  const cleared = workshopHtml(AppView);
  assert.match(cleared, /data-ws-since-none=""/);
  assert.match(cleared, /<button type="button" class="dev-ws-since-clear" data-ws-since-clear="" disabled="">Clear<\/button>/,
    'disabled rather than absent, so the row does not reflow');
  assert.match(cleared, /data-ws-since-more=""(?! disabled)/, 'and the way back to what was cleared is live');

  // A row a server clock put a moment in the future is cleared with the
  // rest: the stamp is the newer of now and `through`.
  const ahead = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) } });
  seed(ahead);
  const soon = new Date(Date.now() + 60000).toISOString();
  ahead._ghIssues[0].updatedAt = soon;
  ahead._ghIssues[0].lastMessageAt = soon;
  const av = ahead._workshopView();
  assert.ok(av.since.through > Date.now(), 'the fixture is ahead of the clock');
  ahead._workshopClearSince('demo-app', av.since.through);
  assert.equal(ahead._workshopView().since.rows.length, 0);
  assert.equal(ahead._workshopSince['demo-app'], av.since.through);

  // The slug defaults to the current app.
  const idle = makeAppView();
  idle._workshopClearSince();
  assert.ok(idle._workshopSince['demo-app'] > 0);
});

test('Show older is always drawn: it walks the new rows, then the seen ones, and disables when spent', () => {
  // The control, in the markup, on every branch: the count pinned above,
  // the quiet day pinned with the reveal, and here a board with NOTHING on
  // either side of the line — the one case where it is disabled.
  const bare = makeAppView({ localStorage: { 'workshopSeen:demo-app': String(Date.now() - 3.5 * 86400000) } });
  seed(bare);
  bare._ghIssues = []; bare._proposals = []; bare._merged = []; bare._mergedTotal = 0;
  const v = bare._workshopView();
  assert.ok(v.since, 'a baseline exists');
  assert.equal(v.since.rows.length, 0);
  assert.equal(v.since.seen.rows.length, 0);
  const html = workshopHtml(bare);
  assert.match(html, /class="dev-ws-reveal dev-ws-since-more" data-ws-since-more="" disabled=""/,
    'drawn, and disabled: a control that is sometimes there is one nobody learns to reach for');
  assert.match(html, /data-ws-since-clear="" disabled=""/);

  // The walk itself is state, which a static render cannot press, so the
  // source is pinned: new rows first, three a press, then across the line.
  assert.match(WORKSHOP, /const \[seenShown, setSeenShown\] = useState\(0\);/, 'nothing seen is drawn until asked for');
  assert.match(WORKSHOP, /if \(v\.since\.rows\.length > sinceShown\) setSinceShown\(sinceShown \+ SINCE_STEP\);\s*else setSeenShown\(seenShown \+ SINCE_STEP\);/,
    'the new rows are exhausted before the seen ones are drawn');
  assert.match(WORKSHOP, /v\.since\.rows\.length > sinceShown \|\| v\.since\.seen\.rows\.length > seenShown/,
    'and the button is live while either side has more');
  assert.match(WORKSHOP, /disabled=\{!sinceMore\}/);
  // Clear folds the walk back to its start and hands the stamp to AppView,
  // which owns the baseline and its storage.
  assert.match(WORKSHOP, /const clearSince = \(\) => \{[\s\S]*?setSinceShown\(SINCE_FIRST\);\s*setSeenShown\(0\);[\s\S]*?callAppView\('_workshopClearSince', slug, v\.since\.through\);/);
  // The seen rows sit under a mark saying which side of the line they are
  // on, with the whole rest counted, in the same fold and the same
  // one-open-at-a-time scope as the rows above.
  assert.match(WORKSHOP, /seenShown > 0 && v\.since\.seen\.rows\.length \? \(\s*<>\s*<div className="dev-ws-since-seen" data-ws-since-seen="">\s*<span className="dev-ws-since-seen-label">Seen before<\/span>\s*<span className="dev-ws-since-seen-n">\{v\.since\.seen\.total\}<\/span>/);
  assert.match(WORKSHOP, /v\.since\.seen\.rows\.slice\(0, seenShown\)\.map\(\(row\) => \(row\.t === 'card' \? \(\s*<CardRowView[\s\S]*?open=\{openRows\.since === row\.key\}/);
  assert.ok(!html.includes('data-ws-since-seen'), 'the mark is not drawn over nothing');
  // Every class the block emits has a rule (the #2097 lesson), including
  // the disabled state the reveal did not have before.
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const cls of ['dev-ws-since-clear', 'dev-ws-since-seen', 'dev-ws-since-seen-label', 'dev-ws-since-seen-n']) {
    assert.match(stripped, new RegExp(`\\.${cls} \\{`), `.${cls} has a rule`);
  }
  assert.match(stripped, /\.dev-ws-reveal:disabled \{[^}]*cursor: default;/);
  assert.match(stripped, /\.dev-ws-since-clear:disabled \{[^}]*cursor: default;/);
  assert.match(stripped, /\.dev-ws-since-clear \{[^}]*margin-left: auto;/, 'pushed to the far end of the heading row');
  // No em dashes in what the reader sees.
  for (const copy of ['Clear', 'Show older', 'Seen before']) assert.ok(!copy.includes('\u2014'));
});

test('the since-list controls have a declared check on Current status, through a URL that gives the page a last visit', () => {
  // The list is drawn only for a returning reader, and the checks run in a
  // fresh browser — so a first visit, with the dashboard alone, is what
  // they would see. `?shot=since-visit` seeds the baseline in memory a month
  // back, before the first paint reads it, and writes nothing to storage.
  assert.match(APP_VIEW_SRC, /if \(shot === 'since-visit'\) \{\s*AppView\._workshopSince\[slug\] = Date\.now\(\) - 30 \* 86400000;\s*\}/);
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopSince['demo-app'] = Date.now() - 30 * 86400000;
  const v = AppView._workshopView();
  assert.ok(v.since, 'seeded, the pane is drawn');
  assert.equal(AppView._workshopBaseline('demo-app'), AppView._workshopSince['demo-app'], 'and the memory copy is what the paint reads');
  const check = dapp.tests.find((t) => /data-ws-since-clear/.test(t.expectSelector || ''));
  assert.ok(check, 'declared');
  assert.match(check.path, /^\/\?demo=1&shot=since-visit#app\/usernode-2d5619\/workshop$/, 'the Current status tab, which is where the strip lives');
  assert.match(check.expectSelector, /\[data-ws-since\] > \.dev-ws-since-head:has\(> \.dev-ws-since-n \+ button\[data-ws-since-clear\]\) ~ button\.dev-ws-since-more\[data-ws-since-more\]/);
  assert.equal(check.expectText, 'Show older');
});

test('the composer shows its model picker and send circle at every width', () => {
  // It used to open expanded above the breakpoint and stay one line on a
  // phone until the field was tapped. The tap was the problem: a picker
  // behind it was a picker nobody knew was there. So there is no collapsed
  // state and no `focused` flag to seed, or to lose again on blur.
  assert.ok(!/const expanded = /.test(WORKSHOP), 'no expanded/collapsed state');
  assert.ok(!/setFocused\(/.test(WORKSHOP), 'and no focus flag driving one');
  assert.match(WORKSHOP, /const wide = useWideLayout\(\);/);
  // READ AT MOUNT, unlike `useRailHost` — nothing here is prerendered (the
  // Workshop mounts client-side into a host `_repaintDevBody()` creates), so
  // there is no first paint to disagree with, and a collapsed frame followed
  // a tick later by an expanded one is a flash on every visit.
  assert.match(WORKSHOP, /const \[wide, setWide\] = useState\(matchesWide\);/);
  // And guarded, because the render this suite does happens in node, where
  // there is no matchMedia at all.
  assert.match(WORKSHOP, /typeof window !== 'undefined' && typeof window\.matchMedia === 'function'/);
});

test('the sheets move, stop above the keyboard, and More opens the card page', () => {
  // OPEN AND CLOSE ANIMATE. A sheet unmounts when it closes, so the leave
  // needs the element kept for the animation's length: `leaving` holds the
  // kind, `[data-ws-leaving]` marks it, and a timer drops it — instantly
  // where motion is unwelcome, because app.css runs no animation there.
  assert.match(WORKSHOP, /const \[leaving, setLeaving\] = useState<SheetKind \| null>\(null\);/);
  // Never on the end card, which has no item for a sheet to be about (#2172).
  assert.match(WORKSHOP, /const shown = row \? \(sheet \|\| leaving\) : null;/);
  assert.match(WORKSHOP, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(CSS, /\.dev-ws-sheet-modal\[data-ws-leaving\] > \.dev-ws-sheet-card \{\s*animation-name: var\(--ws-sheet-out\)/);
  assert.match(CSS, /@keyframes dev-ws-sheet-up \{ from \{ transform: translateY\(100%\); \}/);
  // A panel slides in from the side it lives on; a popover pops. Same rule,
  // different names, set where the panel and the popover are declared.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS)[1];
  assert.match(wide, /--ws-sheet-in: dev-ws-panel-in; --ws-sheet-out: dev-ws-panel-out;/);
  assert.match(wide, /--ws-sheet-in: dev-ws-pop-in; --ws-sheet-out: dev-ws-pop-out;/);
  // THE KEYBOARD. Fixed elements are laid out against the layout viewport,
  // which the on-screen keyboard does not shrink, so the card's floor — and
  // the field on it — sat under the keys. The visual viewport does shrink;
  // the difference lifts the sheet's floor, only while a sheet is up and only
  // below the breakpoint.
  assert.match(WORKSHOP, /window\.innerHeight - vv\.height - vv\.offsetTop/);
  assert.match(WORKSHOP, /\}, \[sheet, wide\]\);/);
  assert.match(CSS, /\.dev-ws-sheet-modal \{\s*position: fixed; inset: 0; z-index: 30;[\s\S]*?bottom: var\(--ws-kb, 0px\);/);
  assert.match(CSS, /\.dev-ws-needs\[data-ws-kb\] \.dev-ws-sheet-card \{ max-height: 100%; \}/);
  assert.match(CSS, /padding: 8px 16px calc\(12px \+ var\(--platform-safe-bottom, 0px\)\);/,
    'and the floor clears the home indicator');
  // OPEN CARD. The item is the whole screen, so the card's own page is a row
  // under More; the href rides on the trigger and app-view.js reads it.
  assert.match(WORKSHOP, /data-card-menu-open=\{cardHref \|\| undefined\}/);
  assert.match(WORKSHOP, /const cardHref = row \? openHref\(slug, row\.card\) : null;/);
  const appView = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(appView, /trigger\.dataset\.cardMenuOpen/);
  // The row is part of the ONE descriptor list every reader of the menu
  // uses, so a row's index means the same thing in the menu that opened and
  // in the refreshed one under it — prepending it in only the opener once
  // sent the first row's click to the wrong descriptor on a desktop.
  assert.match(appView, /_cardMenuItems\(key, own\)/);
  assert.match(appView, /_cardMenuItems\(open\.key, open\.own\)/);
  assert.match(appView, /label: 'Open card',/);
});

test('the lander fills its scroller without a percentage in the floor', () => {
  // THE BUG THIS PINS SHIPPED TWICE AND WAS INVISIBLE TO EVERY LOCAL CHECK.
  // The floor was `min-height: max(100%, var(--ws-area))`. FIREFOX does not
  // apply it: measured on the running app (Gecko 155), `.dev-ws` computed
  // `min-height: max(100%, 806.5px)` and used a height of 649px, leaving
  // 121px of unused scroller beneath it. A sticky bar cannot sit below its
  // own parent's bottom edge, so the rail rested there — and three rounds of
  // tuning `--ws-gap` and `bottom` moved numbers that were never the problem.
  // Chromium applies the same declaration correctly, so a headless harness
  // reported 8px while the app floated. The percentage is indefinite here and
  // the two engines disagree about what that does to the whole `max()`.
  //
  // So the rule is: NO PERCENTAGE IN THIS FLOOR, in either layout.
  assert.ok(!/\.dev-ws \{ min-height: max\(100%/.test(CSS),
    'the percentage floor is gone — Firefox drops it');
  assert.match(CSS, /html\[data-browser-scroller\] \.dev-ws \{ min-height: var\(--ws-area\); \}/,
    'the browser layout gets the viewport floor as a plain length');
  // The native layout does not use a floor at all: the scroller has a definite
  // height there, so the chain flexes and the lander takes what is left. That
  // also drops the dependency on --platform-header-h being right, and on how
  // much chrome sits above #dev-body (measured: 47px, which no viewport
  // subtraction knew about).
  assert.match(CSS, /#dev-forum-scroll:has\(> #dev-body > #dev-workshop\) \{ display: flex; flex-direction: column; \}/);
  // Both selectors carry TWO rules each (the padding one above shares
  // `#dev-body:has(> #dev-workshop)`), so match the block that actually holds
  // the flex declarations rather than the first block that matches the name.
  for (const sel of ['#dev-body:has\\(> #dev-workshop\\)', '#dev-workshop:has\\(> \\.dev-ws\\)']) {
    const blocks = [...CSS.matchAll(new RegExp(sel + ' \\{([^}]*)\\}', 'g'))].map((m) => m[1]);
    assert.ok(blocks.length, `${sel} has a rule`);
    const flexed = blocks.find((b) => /flex: 1 1 auto/.test(b));
    assert.ok(flexed, `${sel} is part of the flex chain`);
    assert.match(flexed, /min-height: 0/);
  }
  // And the width is explicit, because `#dev-workshop` centres with
  // `margin: 0 auto` and auto margins on a flex column's cross axis ABSORB
  // the free space instead of stretching. Without it the pane collapsed to
  // content: measured 760 -> 640 on By category and 1432 -> 310 on By stage.
  assert.match(CSS, /#dev-workshop:has\(> \.dev-ws\) \{[^}]*width: 100%/);
  assert.match(CSS, /#dev-workshop > \.dev-ws \{ flex: 1 1 auto; width: 100%; \}/);
});

test('the ask box is a sheet on a phone and a panel on a wide window', () => {
  // It was floating well clear of the bar, for two different reasons.
  //
  // ON A PHONE the deck filled its box exactly and the box stopped 80px
  // short: `.dev-ws-tabbody` reserves the rail's height so the last card of a
  // SCROLLING tab can be read clear of a bar that overlays it. Needs you does
  // not scroll under the rail — it is one fitted decision per screen — so
  // that clearance was dead space pushing the composer up. Measured at
  // 402x874: 90px between the ask box and the bar. The clearance now lifts on
  // that tab alone.
  // THAT EXEMPTION IS GONE, and its reasoning with it. It read: the deck is
  // fitted, nothing ever passes beneath the rail, so the clearance is dead
  // space pushing the composer up — 90px of it at 402x874. True while the rail
  // sat IN FLOW and took its own space at the foot of the column. The bar is
  // fixed now and overlays every tab equally, fitted or not: with the
  // exemption still in, the deck filled to the foot of `.dev-ws` and the
  // composer ran 63px UNDER the bar. The deck instead ends above it because
  // `--ws-area` subtracts `--ws-bar`, which is what keeps the composer clear
  // without a per-tab special case — measured 9px above the bar at a 0px inset
  // and at a 34px one, which is the point: one number, both devices.
  assert.ok(!/\.dev-ws\[data-ws-tab="needs"\] > \.dev-ws-tabbody \{ padding-bottom: 0/.test(
    CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  // ON A WIDE WINDOW there is no ask box at the floor any more. The ask is a
  // PANEL beside the rail, the stage is a row — card, rail, panel — and the
  // item's card is what takes the height. Its rules ride the one wide block
  // the strip already has, because that block is the breakpoint.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide block exists');
  assert.match(wide[1], /THE FEED ON A WIDE WINDOW: THE STAGE/, 'and the feed\'s rules are in it, not in a second one');
  assert.match(wide[1], /\.dev-ws-needs \{\s*flex-direction: row;/, 'the lander is a row: card, rail, panel');
  assert.match(wide[1], /\.dev-ws-sheet-ask, \.dev-ws-sheet-comments \{\s*position: relative; inset: auto; flex: 0 0 400px;/,
    'ask and comments are panels');
  assert.match(wide[1], /\.dev-ws-sheet-vote \{ position: absolute;/, 'and the vote is a popover on its button');
  assert.ok(!/\.dev-ws-needs > \.dev-ws-ask/.test(CSS), 'nothing pins an ask box to the floor');
  // Both now measure 10px above the bar — `.dev-ws`'s own column gap, which is
  // the floor for anything sitting directly above the rail.
});

test('the feed answers on the Vote sheet and moves by swipe, arrows or keys', () => {
  // THE ANSWERS ARE ON THE SHEET. The rail's Vote control opens the question
  // and records nothing by itself — a thumbs-up on a rail reads as "like",
  // and a queue answered by reflex is answered carelessly. Yes and No sit
  // together on the sheet with the tally, and Decide later closes it.
  assert.ok(!/data-ws-answer-btn="skip"/.test(WORKSHOP), 'skip is gone from the answers');
  assert.ok(!/dev-ws-answer-skip/.test(WORKSHOP), 'and so is its button');
  assert.match(WORKSHOP, /data-ws-rail-btn="vote"[\s\S]{0,400}?onClick=\{\(\) => toggleSheet\('vote'\)\}/, 'Vote opens the sheet');
  assert.match(WORKSHOP, /data-ws-answer-btn="yes"[\s\S]{0,160}?onClick=\{\(\) => answer\('yes'\)\}/, 'Yes is on the sheet');
  assert.match(WORKSHOP, /data-ws-answer-btn="no"[\s\S]{0,160}?onClick=\{\(\) => answer\('no'\)\}/, 'and so is No');
  // NOTHING ADVANCES ON ITS OWN. The deck used to jump half a second after a
  // vote, which in a feed reads as the card vanishing under the press: the
  // row is pinned in place with its confirmation until you move on.
  assert.ok(!/window\.setTimeout\(\(\) => setAt\(i \+ 1\)/.test(WORKSHOP), 'no auto-advance');
  assert.match(WORKSHOP, /pinsRef\.current\.set\(row\.key, \{ row, index: i \}\);/, 'the answered row is pinned');
  // AND STAYS PINNED. The pins used to be dropped once the next card had
  // settled, which removed the voted row from ABOVE the one in view: every
  // index after it moved, the counter re-numbered, the index-keyed tint
  // flipped, and the scroll correction — a `scrollTop` assignment under the
  // scroller's `scroll-behavior: smooth` — animated the card back into place.
  // That was "the card I just arrived on resets a second later".
  assert.ok(!/dropPins|settleRef/.test(WORKSHOP), 'no pin is dropped on a move');
  assert.match(WORKSHOP, /const tintRef = useRef<Map<string, 'a' \| 'b'>>\(new Map\(\)\);/,
    'a row\'s tint is decided once, from where it first stood');
  assert.match(WORKSHOP, /tint=\{tints\[k\]\}/);
  assert.match(WORKSHOP, /tint = prev === 'a' \? 'b' : 'a'; seen\.set\(r\.key, tint\);/,
    'a row seen for the first time takes the opposite of the row above it');
  assert.ok(!/data-ws-tint=\{index % 2/.test(WORKSHOP), 'and never from the index of the moment');
  assert.match(WORKSHOP, /el\.style\.scrollBehavior = 'auto';\s*el\.scrollTop = idx \* el\.clientHeight;\s*el\.style\.scrollBehavior = '';/,
    'a position correction is instant, whatever the scroller\'s own behaviour');
  assert.match(WORKSHOP, /Voted \$\{voted\} · \$\{wide \? 'press ↓ or scroll' : 'swipe up'\} for the next/,
    'and the eyebrow becomes the confirmation');
  // THE ARROWS: icon buttons with a NAME, since a chevron alone has none,
  // disabled at the ends rather than wrapping. Hidden on a phone, where the
  // swipe is the move; on a wide window they do what the wheel does.
  assert.match(WORKSHOP, /<div className="dev-ws-move" data-ws-move-row="">/);
  for (const [dir, guard, name] of [
    ['prev', /disabled=\{i <= 0\}/, /aria-label="Previous"/],
    // `n`, not `n - 1`: the end card is the last slot (#2172).
    ['next', /disabled=\{i >= n\}/, /aria-label="Next"/],
  ]) {
    const btn = new RegExp(`data-ws-move="${dir}"[\\s\\S]{0,240}?</button>`).exec(WORKSHOP);
    assert.ok(btn, `the ${dir} control exists`);
    assert.match(btn[0], guard, `${dir} is disabled at its end rather than wrapping`);
    assert.match(btn[0], name, `${dir} is named`);
  }
  assert.match(CSS, /\.dev-ws-move \{ display: none; \}/, 'no arrows on a phone');
  // The count rides each item's own top line beside its eyebrow: it answers
  // "where am I" for the thing in front of you.
  assert.match(WORKSHOP, /className="dev-ws-item-of">\{`\$\{index \+ 1\} \/ \$\{count\}`\}/);
  // THE KEYS, every one also a button on the rail, ignored while a field has
  // focus, and listed only where a keyboard is likely (app.css hides the
  // legend on a phone).
  assert.match(WORKSHOP, /if \(t && \(t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA'/, 'typing is typing');
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'v' || k === 'V'", "'a' || k === 'A'", "'c' || k === 'C'", "'t' || k === 'T'", "'m' || k === 'M'", "'Escape'"]) {
    assert.ok(WORKSHOP.includes(`k === ${key}`), `${key} is bound`);
  }
  assert.match(CSS, /\.dev-ws-keys \{ display: none; \}/, 'the legend is off on a phone');
  // NO WRAP, and no reordering: the ends are the ends, the counter says
  // which one you are at, and you walk back yourself.
  // `n`, the end card's slot, is the last a press reaches (#2172).
  assert.match(WORKSHOP, /const idx = Math\.min\(Math\.max\(i \+ delta, 0\), n\);/);
  assert.ok(!/setSkipped/.test(WORKSHOP), 'the re-queue went with the button it belonged to');
  assert.match(WORKSHOP, /const live = rows\.filter\(\(r\): r is QueueRow => r\.t === 'card'\);/,
    'the feed keeps the order it was published in');
});

test('the lander opens on the tab you last used', () => {
  // Three tabs are three different jobs, and the one you want is usually the
  // one you wanted last time — somebody working the vote queue landed on the
  // digest every single visit. Stored per browser: it is a reading position,
  // not a setting, and it reuses the mechanism the grouping already has.
  assert.match(APP_VIEW_SRC, /WORKSHOP_TAB_KEY: 'devWorkshopTab',/);
  const read = /_workshopTab\(\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(read, '_workshopTab resolves it');
  // ORDER MATTERS: the deep link wins, then what you chose, then the default.
  // A declared check runs against an empty localStorage, so `?ws=` losing to
  // a stored value would make every one of them assert the wrong tab.
  assert.match(read[1], /const url = AppView\._workshopTabParam\(\);\s*if \(url\) return url;/);
  assert.match(read[1], /localStorage\.getItem\(AppView\.WORKSHOP_TAB_KEY\)/);
  assert.match(read[1], /return 'status';/);
  // And an explicit tap retires the URL override, exactly as the grouping
  // does — otherwise `?ws=` would keep winning over every later press.
  const write = /_setWorkshopTab\(key\) \{([\s\S]*?)\n  \},/.exec(APP_VIEW_SRC);
  assert.ok(write, '_setWorkshopTab stores it');
  assert.match(write[1], /AppView\._workshopTabUrlOverride = null;/);
  assert.match(write[1], /localStorage\.setItem\(AppView\.WORKSHOP_TAB_KEY, next\)/);
  // The view model publishes the RESOLVED tab, not the raw parameter.
  assert.match(APP_VIEW_SRC, /tab: AppView\._workshopTab\(\),/);
  assert.match(WORKSHOP, /onClick=\{\(\) => \{ setTab\(t\.key\); callAppView\('_setWorkshopTab', t\.key\); \}\}/);
});

test('a category card is raised off the pane it sits on', () => {
  // It took `--dc-sheet-fill`, the SAME value as the pane beneath it, so in
  // dark mode the card was rgba(28,28,30,.72) on rgba(28,28,30,.72) with only
  // a 12%-white hairline between them. Light mode got away with it because
  // its hairline is 10% BLACK on near-white, which reads far harder.
  assert.match(CSS, /--dc-sheet-raise: #ffffff;/, 'light');
  assert.match(CSS, /--dc-sheet-raise: #2c2c2e;/, 'dark, one step up the same ramp as the sheet');
  const card = /\.dev-ws-theme \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(card, 'the card rule exists');
  assert.match(card[1], /background-color: var\(--dc-sheet-raise\);/);
  // Opaque, so no frost: it blurs what is BEHIND, and what is behind is a
  // pane of one flat colour — a compositing layer per card for nothing.
  assert.ok(!/backdrop-filter/.test(card[1]), 'the frost went with it');
});

test('a wide window reads the tabs at the top, as a segmented control', () => {
  // THE PILL IS A PHONE CONVENTION. Pinned to the floor of a 900px window it
  // puts the switch as far from the reading as the window allows, and the eye
  // crosses the whole height to use it. Above 700px — the breakpoint the deck
  // already uses, so the two stay in step — the bar comes off the floor.
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(wide, 'the wide-screen block exists');
  // ONE block at this breakpoint, not two: a second would sit below the deck
  // rules and the regex above would read only the first, so a rule could be
  // added here and silently go unchecked.
  assert.equal((CSS.match(/@media \(min-width: 700px\) \{/g) || []).length, 1,
    'the breakpoint is written once');

  // NOT AN UNDERLINED ROW. That shape separates by RULE where this product
  // separates by figure and ground — the distinction @/components/ui/tabs.tsx
  // spells out where it retired the same underline from the Leaderboard's
  // strip — and it reads as a code-hosting tool bolted to a consumer one.
  // Comments stripped first: the block above explains WHY the underline went,
  // and prose naming it is not the declaration this forbids.
  const decls = wide[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/border-bottom: 2px solid/.test(decls), 'no underline on the tab');
  assert.ok(!/border-bottom-color: var\(--brand-ink\)/.test(decls),
    'and none carrying the accent under the selected one');

  const rail = /\.dev-ws-tabs \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(rail, 'the rail is restyled for width');
  // `order: 0` is the whole move — the nav is already first in the DOM, so
  // dropping the phone's `order: 1` paints it where it is written.
  assert.match(rail[1], /order: 0;/, 'it paints where it is written');
  // RELATIVE, not static: nothing to stick to at the head of a column, but the
  // bar must stay the containing block for the selection marker and the
  // element its tabs' offsetLeft/offsetTop resolve against.
  assert.match(rail[1], /position: relative;/, 'still the containing block for the marker');
  // THE PHONE BAR'S BOX DOES NOT COME UP HERE, and all three of these are
  // regressions, not tidying. `left/right/bottom` place a FIXED pill against
  // the viewport; `position: relative` does not ignore them, it SHIFTS by
  // them — so the strip sat 10px right of the column it aligns to and 8px
  // (`--ws-lift`) above its own place in the flow. Measured in Chromium at
  // 1280px: 2px of air above the strip and 18px below, against the 10 and 10
  // the two rules here declare. `max-width`/`margin-inline` leak the same way
  // and cost the alignment below — 740px with auto side margins is a
  // shrink-to-fit box that has already centred itself, and nothing can be
  // left-aligned inside one.
  assert.match(rail[1], /inset: auto;/, 'the fixed offsets do not follow it into the flow');
  assert.match(rail[1], /max-width: none;/, "and neither does the pill's width bound");
  assert.match(rail[1], /\n    margin: 0;/, 'nor its auto side margins');
  // LEFT-ALIGNED, not centred. The pill inside is content-width, so whatever
  // positions the pill decides where the strip appears — and the nav spans the
  // same reading column the pane below it does, so `flex-start` puts the
  // strip's left edge on the pane's left edge. Centred, it sat on the WINDOW's
  // centre line, which belongs to no edge on the screen at any width.
  assert.match(rail[1], /display: flex;\n    justify-content: flex-start;/,
    "the strip is left-aligned, on the reading column's own edge");
  // AND IT IS WHAT SETTLES THE SELECTION MARKER. The marker is placed from
  // `offsetLeft` against this nav, and under `justify-content: center` that
  // number is `(nav - pill) / 2` plus the tab's own — so it MOVED whenever the
  // nav's width did, for a tab that had not moved on screen. Switching the All
  // items pane between By category and By stage gives the nav two widths, and
  // the marker's coordinate jumped 158px for an unmoved tab, which the
  // transition then animated. At `flex-start` the pill sits at offset 0 and
  // the number is the tab's own, whatever the nav is doing.
  assert.ok(!/justify-content: center/.test(decls),
    'a centred strip re-expresses an unmoved tab every time the nav resizes');
  // FLEX, NOT `text-align: center`. An inline-level box placed by an INHERITED
  // property is one stray `text-align` on any ancestor away from moving on its
  // own — which is the class of bug this is fixing, not a shape to re-enter.
  assert.ok(!/text-align/.test(decls), 'nothing here positions by inheritance');
  assert.match(rail[1], /background: none; backdrop-filter: none;/,
    'the frost belongs to the floating phone bar, not to a strip in the flow');

  const track = /\.dev-ws-tabtrack \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(track, 'the track is the pill');
  // `inline-flex` so it hugs its three labels: a segmented control spanning
  // the reading column reads as a header bar rather than as a control, which
  // is the same reason SECTION_TABS_LIST is inline-flex.
  assert.match(track[1], /display: inline-flex;/, 'it hugs its labels');

  // THE AIR ABOVE AND BELOW IS ONE NUMBER. `.dev-ws` is a flex column with
  // `gap: 10px`, so a `margin-bottom` on the nav STACKS on it — 14px below
  // against the 8px of `#dev-body` padding above, which is the lopsided air
  // the strip sat in. The gap alone sets the bottom; the padding is raised to
  // match it, and neither side carries a number the other does not.
  assert.match(CSS, /\.dev-ws \{ display: flex; flex-direction: column; gap: 10px; \}/);
  assert.ok(!/margin-bottom: 4px;/.test(rail[1]), 'no margin stacked on the column gap');
  assert.match(wide[1], /#dev-body:has\(> #dev-workshop\) \{ padding-top: 10px; \}/,
    'and the space above equals it');
  assert.match(track[1], /border-radius: 9999px;/);
  // A TOKEN, NOT A LITERAL WHITE. The mock that sold this option hardcoded
  // #ffffff and rendered a glaring slab in dark mode; --dc-sheet-raise is the
  // raised surface the category cards already use and carries both values.
  assert.match(track[1], /background-color: var\(--dc-sheet-raise\);/);
  assert.ok(!/#fff/i.test(track[1]), 'no literal white to strand dark mode');

  const tab = /\.dev-ws-tab \{([\s\S]*?)\n  \}/.exec(wide[1]);
  assert.ok(tab, 'the tab is restyled too');
  // SECTION_TAB_BASE's geometry, transcribed: h-8, px-4, rounded-full.
  assert.match(tab[1], /height: 32px; padding: 0 16px;/);
  assert.match(tab[1], /border-radius: 9999px;/);
  assert.match(tab[1], /flex: 0 0 auto; flex-direction: row;/,
    'sized to its text, not a stretched third of the column');

  // THE SELECTED STATE IS NOT RESTATED AT THIS WIDTH. The phone's periwinkle
  // carries through, so the two widths are one control at two sizes. A desktop
  // override here would be the bug, not the fix.
  assert.ok(!/\.dev-ws-tab\[aria-selected="true"\]/.test(wide[1]),
    'the phone rule carries through');
  // THE PERIWINKLE MOVED TO THE MARKER, which is what lets the selection slide
  // instead of snapping: a background drawn by the tab itself can only appear
  // on one and vanish from another. The tab keeps the ink, which has nothing
  // to animate between.
  assert.match(CSS, /\.dev-ws-tab\[aria-selected="true"\] \{\s*color: var\(--brand-ink\);\s*\}/,
    'the selected tab is ink only');
  assert.match(CSS, /\.dev-ws-tab-marker \{[\s\S]*?background: var\(--brand-tint\);/,
    'and the fill is the marker, at both widths — it carries no breakpoint');

  // Nothing overlays the content any more, so the clearance that existed for a
  // bar floating over what scrolls beneath it is dead space here.
  assert.match(wide[1], /\.dev-ws-tabbody \{ padding-bottom: 0; \}/);

  // The markup half: the track exists and is inert on a phone, so the bar
  // there is byte-identical to what it was.
  assert.match(WORKSHOP, /<div className="dev-ws-tabtrack">/);
  assert.match(CSS, /\.dev-ws-tabtrack \{ display: contents; \}/,
    'the wrapper introduces no box on a phone');
});

test('the read-only demo check names the pane its proposal is actually on', () => {
  // #621 asserts one string — the seeded proposal's title — is on the demo
  // app's Dev tab. The rework put it behind two choices and `&ws=all` alone
  // was not enough, so the check went red and stayed red through a merge.
  //
  // ALL ITEMS DEFAULTS TO "BY CATEGORY", AND A CATEGORY CARD IS COLLAPSED.
  // It renders the category's name, its saying and its count chips; the lanes
  // holding item titles are behind `open`. So the title is not merely below
  // the fold on that pane — it is not in the document. By stage renders the
  // board's own columns, where every row is a card with its title.
  //
  // `&col=inreview` because the seed (src/db/migrate.js) inserts the proposal
  // `promoted`, which `_kanbanView` buckets into `inreview` — and at phone
  // width the board shows ONE column, so without it the check passes at
  // 1280px and fails at 402px depending on the runner's viewport. Measured
  // against the real components at 402, 800 and 1280: absent on category at
  // every width, absent on stage/issues at 402, present and painted on
  // stage/inreview at all three.
  const dapp = JSON.parse(read('dapp.json'));
  const found = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (typeof o.expectText === 'string' && o.expectText === 'Staging demo read-only proposal') found.push(o);
    Object.values(o).forEach(walk);
  };
  walk(dapp);
  assert.equal(found.length, 1, 'exactly one check asserts the seeded proposal');
  const p = found[0].path;
  assert.match(p, /[?&]ws=all(&|$)/, 'the tab, since the lander opens on Current status');
  assert.match(p, /[?&]group=stage(&|$)/, 'the pane that lists item titles');
  assert.match(p, /[?&]col=inreview(&|$)/, 'the column a promoted proposal buckets into');
  // The bucketing this leans on, pinned here so moving `promoted` to another
  // column fails locally rather than as a red check on somebody's proposal.
  assert.match(APP_VIEW_SRC, /key: 'inreview', title: 'In review'/);
  assert.match(APP_VIEW_SRC, /rows: cardRows\(kInReview, \(x\) => \(x\.kind === 'proposal'/);
});

test('the selection slides between tabs instead of snapping', () => {
  // ONE ELEMENT THAT MOVES, not a fill redrawn per tab. A background painted by
  // the selected tab can only appear on one and vanish from another; a single
  // marker can travel, which is what every other app's tab bar does.
  assert.match(WORKSHOP, /<span\s+className="dev-ws-tab-marker"/);
  assert.match(WORKSHOP, /aria-hidden="true"/);
  // It is decoration. `aria-selected` on the tab already announces the state,
  // so a box that claimed it too would say the same thing twice.
  const marker = /<span\s+className="dev-ws-tab-marker"[\s\S]*?\/>/.exec(WORKSHOP);
  assert.ok(marker, 'the marker is rendered');
  assert.ok(!/role=|tabIndex=/.test(marker[0]), 'decorative: no role, not focusable');

  // EVERY NUMBER IS MEASURED, none written down. That is what lets one
  // implementation serve the phone's equal-width 58px tabs and the desktop
  // strip's content-width 32px ones without a breakpoint of its own.
  assert.match(WORKSHOP, /function useTabMarker\(/);
  assert.match(WORKSHOP, /x: el\.offsetLeft, y: el\.offsetTop, w: el\.offsetWidth, h: el\.offsetHeight/);
  // useLayoutEffect, not useEffect: a paint between measuring and positioning
  // is a visible flash of the marker in the wrong place.
  // The span is a proximity bound, not a budget: what it pins is that the
  // observer is set up inside the SAME layout effect that measures, so the two
  // share a teardown. Widen it when the effect legitimately grows.
  assert.match(WORKSHOP, /useLayoutEffect\(\(\) => \{[\s\S]{0,1200}?ResizeObserver/,
    'measured in a layout effect, and re-measured on resize');
  // THE BAR IS A CALLBACK REF IN STATE, not a `useRef`. A ref object is stable,
  // so it can never wake this effect: on first open the workshop renders a
  // skeleton and there is no <nav> to measure; when the data lands the deps are
  // all unchanged, the effect never re-runs, and the marker stays at opacity 0.
  // Storing the node in state makes its arrival a dependency change. It also
  // makes `railHost` redundant — the portal remount unmounts and remounts the
  // bar, so setBar fires twice on its own with the right node each time.
  assert.match(WORKSHOP, /const \[bar, setBar\] = useState<HTMLElement \| null>\(null\);/);
  assert.match(WORKSHOP, /ref=\{setBar\}/);
  assert.match(WORKSHOP, /\}, \[bar, tab\]\);/);
  assert.ok(!/barRef/.test(WORKSHOP), 'no stable ref object gates the measurement');

  // NULL UNTIL MEASURED, so the marker renders hidden rather than at the left
  // edge — otherwise it slides in from nowhere on the first paint.
  assert.match(WORKSHOP, /\{\.\.\.\(markerBox \? \{ 'data-ws-marker-at': '' \} : \{\}\)\}/);
  assert.match(WORKSHOP, /style=\{markerBox \? \{/);
  assert.match(CSS, /\.dev-ws-tab-marker \{[\s\S]*?opacity: 0;[\s\S]*?\n\}/, 'hidden by default');
  assert.match(CSS, /\.dev-ws-tab-marker\[data-ws-marker-at\] \{ opacity: 1; \}/);

  // THE TRANSITION IS ON A SECOND ATTRIBUTE, and the two are not the same
  // question. `data-ws-marker-at` means MEASURED, which is what the opacity
  // above waits for; `data-ws-marker-slide` means the SELECTION is what moved,
  // which is the only case worth animating. Conflated, the marker animated
  // twice over for free: on the first placement, because `at` arrives in the
  // same commit as the transform and a cold open on All items therefore slid
  // it in from the nav's left edge at zero width — the very slide-in the
  // null-until-measured render exists to prevent — and on every re-measure,
  // because these are offsets into the bar, so a bar that moves or resizes
  // re-expresses a tab that has not budged.
  assert.match(WORKSHOP, /\{\.\.\.\(markerBox && markerBox\.slide \? \{ 'data-ws-marker-slide': '' \} : \{\}\)\}/);
  const base = /\.dev-ws-tab-marker \{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(base && !/transition/.test(base[1]), 'the base rule does not transition');
  assert.ok(!/\.dev-ws-tab-marker\[data-ws-marker-at\] \{[^}]*transition/.test(CSS),
    'being measured is not being moved to, and does not animate');
  const motion = /@media \(prefers-reduced-motion: no-preference\) \{\s*\.dev-ws-tab-marker\[data-ws-marker-slide\] \{([\s\S]*?)\n  \}/.exec(CSS);
  assert.ok(motion, 'and a selection change animates only where motion is welcome');
  assert.match(motion[1], /transform \.26s/);
  // width and height are in the list because the desktop segments are
  // content-width: "Current status" and "Needs you" differ, so a transform
  // alone would slide a box of the wrong size. On the phone they never change.
  assert.match(motion[1], /width \.26s/);
  assert.match(motion[1], /height \.26s/);

  // WHICH MEASUREMENT EARNS THE SLIDE, in the three places it is decided.
  // The effect depends on `tab`, so its own run IS the selection changing and
  // passes true; everything the ResizeObserver reports afterwards is the
  // layout moving under an unmoved tab and passes false.
  assert.match(WORKSHOP, /measure\(true\);/, 'the effect run is the tab changing');
  assert.match(WORKSHOP, /new ResizeObserver\(\(\) => measure\(false\)\)/,
    'a resize moved the bar, not the selection');
  // And the first placement snaps whatever asked for it: there is no previous
  // box, so there is nothing to have slid from. `!!prev` is what says so.
  assert.match(WORKSHOP, /slide: !!prev && selectionChanged/,
    'the first measurement has nowhere to slide from');
  // UNCHANGED GEOMETRY KEEPS THE PREVIOUS BOX. `ro.observe()` delivers once
  // immediately, on the same numbers the effect just measured; returning a new
  // object there would clear `slide` mid-animation and stop the slide dead.
  assert.match(WORKSHOP, /&& prev\.w === next\.w && prev\.h === next\.h\) return prev;/,
    'the observer’s first delivery must not replace an identical box');

  // THE BAR IS THE CONTAINING BLOCK AT BOTH WIDTHS, which is what makes
  // offsetLeft/offsetTop mean what the marker assumes. `fixed` gives it for
  // free on a phone; the wide rule has to ask for it.
  const rail = /\n\.dev-ws-tabs \{([\s\S]*?)\n\}/.exec(CSS);
  assert.match(rail[1], /position: fixed;/);
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(CSS);
  assert.match(wide[1], /position: relative;/);
  assert.ok(!/position: static;/.test(wide[1].replace(/\/\*[\s\S]*?\*\//g, '')),
    'static would send the marker and the measurement to some other ancestor');

  // The tabs sit above it. Without `position: relative` on them both are
  // static, and the marker — later in paint order for positioned elements —
  // would cover the labels.
  assert.match(CSS, /\.dev-ws-tab \{ position: relative; z-index: 1; \}/);
  assert.match(CSS, /\.dev-ws-tab-marker \{[\s\S]*?z-index: 0;/);
});

// ── #2176: the tiles count calendar weeks ────────────────────────────

test('#2176: "shipped this week" is the calendar week from Monday 00:00 UTC, not a trailing seven days', () => {
  const AppView = makeAppView();
  seed(AppView);
  const monday = AppView._weekStart(Date.now());
  assert.equal(new Date(monday).getUTCDay(), 1, 'the week starts on a Monday');
  assert.equal(monday % 86400000, 0, 'at midnight UTC');
  const iso = (ms) => new Date(ms).toISOString();
  const row = (id, ms) => ({
    id, pr_number: id, pr_title: `Merge ${id}`, status: 'merged', username: 'alice',
    merged_at: iso(ms), created_at: iso(ms), row_type: 'pr',
  });
  AppView._merged = [
    row(1, monday + 3600000),              // this week
    row(2, monday - 1000),                 // one second before Monday: last week
    row(3, monday - 7 * 86400000 + 1000),  // the first second of last week
    row(4, monday - 7 * 86400000 - 1000),  // the week before that: neither
  ];
  const d = AppView._workshopView().dashboard;
  assert.equal(d.shippedWeek, 1, 'only what landed since Monday');
  assert.equal(d.shippedPrevWeek, 2, 'the whole seven days before that Monday');
  const html = workshopHtml(AppView);
  assert.match(html, /data-ws-dash-cell="shipped" title="This calendar week, counted from Monday 00:00 UTC\."/,
    'the tile says which week it means');
});

// ── #2182: the viewer's strip stays on screen when it is empty ───────

test('#2182: "What you are working on" stays on screen with nothing in it, and says so', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  // Nothing of the viewer's: no session, and the proposal is somebody else's.
  AppView._mySessions = [];
  for (const p of AppView._proposals) p.user_id = 999;
  const v = AppView._workshopView();
  assert.equal(v.mine.viewer, true);
  assert.equal(v.mine.rows.length, 0);
  const html = workshopHtml(AppView);
  assert.ok(html.includes('data-ws-mine=""'), 'the strip is drawn');
  assert.match(html, /data-ws-lane="mine"><p class="[^"]*" data-ws-mine-empty="">You have no work going on\. Pick up an open item below, or start something from the \+ button\.<\/p>/,
    'with the note in the lane');
  assert.ok(!html.includes('data-ws-mine-more'), 'and no more-of-yours button');
  assert.ok(html.indexOf('data-ws-dashboard') < html.indexOf('data-ws-mine'), 'in its usual place');
  // The declared check reaches this state through ?shot=mine-empty, whatever
  // the demo seeded for the viewer.
  const Seeded = makeAppView();
  seed(Seeded);
  Seeded._mySessions = [{ id: 51, session_title: 'Bottom tabs', pr_number: null, last_activity_at: at(0) }];
  assert.ok(Seeded._workshopView().mine.rows.length > 0, 'the viewer has work');
  Seeded._workshopShot = 'mine-empty';
  assert.equal(Seeded._workshopView().mine.rows.length, 0);
  assert.ok(workshopHtml(Seeded).includes('data-ws-mine-empty=""'));
});

test('#2182: a guest has no strip to keep', () => {
  const AppView = makeAppView({ App: { user: null, currentApp: 'demo-app', currentSubTab: 'forum' } });
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 't', name: 'T', items: ['issue:12'] }]);
  const v = AppView._workshopView();
  assert.equal(v.mine.viewer, false);
  assert.ok(!workshopHtml(AppView).includes('data-ws-mine='), 'no empty strip for a reader with no work to have');
});

// ── #1933: the category chip on the Board's cards ───────────────────────
//
// The themes are the Workshop's grouping, and until now they were visible
// ONLY as that pane's headings: the Board's columns and the stage pane sort
// by state, and a card there said nothing about where the model had placed
// it. The chip is the theme's name on the card's meta line, looked up by the
// same key the server placed the card under.

test('#1933: a card names the auto-drafted category it was placed in, once the themes have arrived', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._sharedSessions = [
    { id: 56, session_title: 'Shared thing', status: 'active', shared_at: at(1), linked_issues: [], created_at: at(1), last_activity_at: at(0) },
  ];
  const chipOf = (card) => (card.badges || []).find((b) => b && b.key === 'theme') || null;

  // No themes yet: nothing is drawn, so a slow fetch never paints a wrong name.
  AppView._workshopThemes = null;
  assert.equal(chipOf(AppView._issueCardModel(AppView._ghIssues[0])), null);

  AppView._workshopThemes = themes([
    { id: 'theming', name: 'Theming', items: ['issue:12', 'session:34', 'session:56', 'session:78'] },
  ]);
  const issue = chipOf(AppView._issueCardModel(AppView._ghIssues[0]));
  assert.ok(issue, 'the issue the theme names carries the chip');
  assert.equal(issue.t, 'chip');
  assert.equal(issue.meta, true, 'it rides the meta line beside the priority / assignee / category tags');
  assert.equal(issue.label, 'Theming');
  assert.deepEqual(plain(issue.data), { 'data-theme-chip': 'theming' });
  assert.match(issue.cls, /^dev-badge /);
  assert.equal(issue.cls, `dev-badge ${AppView._categoryTint('theming').cls}`,
    'one category is one colour on every card, through the same hash the custom category chips use');
  assert.match(issue.title, /Category: Theming/);
  assert.doesNotMatch(issue.title, /—/, 'platform copy carries no em dashes');

  // Not named by any theme: no chip. A card the placer declined is simply
  // absent from every list, so it reads the same way.
  assert.equal(chipOf(AppView._issueCardModel(AppView._ghIssues[1])), null);

  // Every card kind the server keys: a proposal and a merge by their
  // chat_sessions row, a shared session likewise.
  assert.equal(chipOf(AppView._proposalCardModel(AppView._proposals[0])).label, 'Theming');
  assert.equal(chipOf(AppView._sharedSessionCardModel(AppView._sharedSessions[0])).label, 'Theming');
  assert.equal(chipOf(AppView._mergedRowModel(AppView._merged[0])).label, 'Theming');

  // And it reaches the Board's markup, on the card the columns draw.
  const html = kanbanHtml(AppView);
  assert.ok(html.includes('data-theme-chip="theming"'), 'the chip is in the kanban markup');
  assert.ok(/data-theme-chip="theming"[^>]*>Theming</.test(html), 'with the category\'s name as its text');
  // On the folded row the declared check selects through, under the item
  // hook the row carries (`data-issue-row`), not the open card's `data-ref-issue`.
  assert.match(html, /data-issue-row="12"[^]*?data-theme-chip="theming"/, 'inside the folded row for issue 12');
});

test('#1933: under the "By category" pane the chip is dropped, because the heading already says it', () => {
  const AppView = makeAppView();
  seed(AppView);
  AppView._workshopThemes = themes([{ id: 'theming', name: 'Theming', items: ['issue:12', 'session:34'] }]);
  const chipOf = (row) => (row.card.badges || []).find((b) => b && b.key === 'theme') || null;
  const lane = (t, k) => t.lanes.find((l) => l.key === k);

  AppView._getWorkshopGroup = () => 'category';
  const grouped = AppView._workshopView();
  assert.equal(chipOf(lane(grouped.themes[0], 'open').rows[0]), null, 'no chip under its own heading');
  assert.equal(chipOf(lane(grouped.themes[0], 'review').rows[0]), null);
  // The vote strip is not grouped by category, so its card keeps the name.
  assert.equal(grouped.votes.rows.length, 1);
  assert.equal(chipOf(grouped.votes.rows[0]).label, 'Theming');

  AppView._getWorkshopGroup = () => 'stage';
  const staged = AppView._workshopView();
  assert.equal(chipOf(lane(staged.themes[0], 'open').rows[0]).label, 'Theming', 'the stage pane sorts by state, so the chip stays');
});

test('#1933: the themes landing repaints whichever surface is up, not only the Workshop pane', async () => {
  const AppView = makeAppView({
    fetch: async () => ({ ok: true, json: async () => ({ themes: [{ id: 't', name: 'T', items: ['issue:12'] }], source: 'ai' }) }),
  });
  seed(AppView);
  let repaints = 0;
  AppView._repaintBoardSurface = () => { repaints += 1; };
  AppView._getViewMode = () => 'kanban';
  await AppView._loadWorkshopThemes('demo-app', 0);
  assert.equal(AppView._workshopThemes.themes.length, 1);
  assert.equal(repaints, 1, 'the board repaints so its cards can pick up their chips');
});

test('#1933: the declared check reads the chip off a demo issue card on the board', () => {
  const check = dapp.tests.find((t) => /#1933/.test(t.name || ''));
  assert.ok(check, 'declared');
  assert.match(check.path, /demo=1.*#app\/usernode-2d5619\/board$/);
  // `data-issue-row`, not `data-ref-issue`: the Board draws FOLDED rows, and
  // a folded row carries only the item hooks (fold.tsx ITEM_HOOKS), which is
  // the one the first run of this check learned the hard way.
  assert.match(check.expectSelector, /#dev-kanban \[data-issue-row="900001"\] \[data-theme-chip="demo-appearance"\]/);
  assert.equal(check.expectText, '[Mock] Appearance & theming');
  // The name and the placement it asserts are the staging demo theme's.
  const route = read('src/routes/workshop-themes.js');
  assert.ok(route.includes("id: 'demo-appearance'"));
  assert.ok(route.includes("name: '[Mock] Appearance & theming'"));
  assert.ok(/items: \['issue:900001'/.test(route));
});
