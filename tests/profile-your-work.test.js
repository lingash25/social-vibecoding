'use strict';

// Profile's "Your work" (UI overhaul): Your changes, Your requests and Your
// votes, three rows on Me and three views of one screen
// (frontend/src/features/profile/my-proposals.tsx, `#profile-proposals-screen`).
//
//   - the server's numbers and rows (src/routes/profile.js: the summary's
//     in-progress count and GET /api/me/requests; the SQL itself runs in
//     tests/me-requests-postgres.test.js);
//   - what each view says, from ./profile-store.js;
//   - the screen: hidden and empty in the prerender, one view at a time, the
//     long groups folded, and Suggest an improvement at the foot of Your requests;
//   - the router's three addresses.
//
// Run with: node --test tests/profile-your-work.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const SCREEN = 'frontend/src/features/profile/my-proposals.tsx';
const NOW = Date.parse('2026-09-23T12:00:00Z');

// ── The server ─────────────────────────────────────────────────────────

test('the summary counts what is in progress: in an agent session or up for a vote', () => {
  const profile = require('../src/routes/profile');
  assert.equal(profile.shapeSummary({ counts: { merged: 9, in_progress: 2 } }).inProgress, 2);
  const sql = read('src/routes/profile.js');
  // A merged change still going live (live_at null) is in progress too.
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE cs\.status IN \(\s*'active', 'paused', 'promoted', 'merging'\s*\) OR \(cs\.status = 'merged' AND cs\.live_at IS NULL\)\)::int AS in_progress,/);
});

test('your requests: each says where it stands, and the counts are the whole set\'s', () => {
  const profile = require('../src/routes/profile');
  const row = (number, over) => ({
    number, title: `Request ${number}`, created_at: '2026-09-20T10:00:00Z',
    app_slug: 'run-club', app_name: 'Run Club', self_hosted: false,
    shipped: false, closed: false, underway: false, total: 9, done: 3, ...over,
  });
  const body = profile.shapeRequests([
    row(1),
    row(2, { underway: true }),
    row(3, { shipped: true, underway: true }),
    row(4, { closed: true }),
    row(5, { app_slug: 'usernode-2d5619', app_name: 'usernode', self_hosted: true }),
  ]);
  assert.deepEqual(body.requests.map((r) => [r.number, r.state, r.appName]), [
    [1, 'waiting', 'Run Club'],
    [2, 'underway', 'Run Club'],
    [3, 'shipped', 'Run Club'],
    [4, 'closed', 'Run Club'],
    [5, 'waiting', 'Homeroom'],
  ], 'shipped wins over under way; the platform\'s own are Homeroom\'s');
  assert.equal(body.open, 6);
  assert.equal(body.done, 3);
  assert.equal(body.truncated, true, 'nine in all, five shown');
  assert.deepEqual(profile.shapeRequests([]), { requests: [], open: 0, done: 0 });
  // Staging's demo fills an empty list only, with one of each standing.
  const demo = profile.withDemoRequests({ requests: [], open: 0, done: 0 }, { slug: 'usernode-2d5619' }, NOW);
  assert.deepEqual(demo.requests.map((r) => r.state), ['waiting', 'underway', 'shipped']);
  assert.equal(demo.open, 2);
  const real = { requests: [{ number: 7 }], open: 1, done: 0 };
  assert.equal(profile.withDemoRequests(real, { slug: 'x' }), real, 'real rows win');
  // Me-scoped, and registered behind the signed-in gate.
  assert.match(read('src/routes/profile.js'), /router\.get\('\/api\/me\/requests', requireUser,/);
});

test('your votes can link a group decision to its page', () => {
  const kudos = read('src/routes/kudos.js');
  assert.match(kudos, /i\.github_issue_number AS issue_number, i\.title AS issue_title, i\.kind AS issue_kind, i\.id AS issue_id,/);
  assert.equal((kudos.match(/NULL::int AS issue_id,/g) || []).length, 3, 'every other arm lines up with a NULL');
  assert.match(kudos, /item\.issue = \{ id: r\.issue_id, number: r\.issue_number, title: r\.issue_title, kind: r\.issue_kind \};/);
});

// ── What each view says ────────────────────────────────────────────────

test('Your changes: in progress (either kind, newest first), then merged, then closed', () => {
  const { proposalsView } = loadTsx(STORE);
  const row = (id, at, title) => ({ sessionId: id, title, appSlug: 'run-club', appName: 'Run Club', at });
  const view = proposalsView({
    proposals: {
      openForVote: [row(2, '2026-09-22T10:00:00Z', 'Fix pace rounding')],
      inProgress: [row(1, '2026-09-23T10:00:00Z', 'Dark mode for run logs')],
      merged: [row(3, '2026-09-21T12:00:00Z', 'Pace calculator')],
      closed: [row(4, '2026-08-01T12:00:00Z', 'Leaderboard badges')],
    },
  }, NOW);
  assert.deepEqual(view.sections.map((s) => s.label), ['In progress', 'Live', 'Closed']);
  assert.deepEqual(view.sections[0].rows.map((r) => [r.title, r.meta, r.href]), [
    ['Dark mode for run logs', 'Run Club · in progress', '#app/run-club/dev/sessions/1'],
    ['Fix pace rounding', 'Run Club · waiting for approval', '#app/run-club/dev/proposals/2'],
  ]);
  assert.equal(view.sections[1].rows[0].meta, 'Run Club · 2 days ago');
  assert.equal(view.sections[2].rows[0].meta, 'Run Club · closed without going live');
  assert.equal(proposalsView(null).loaded, false, 'a read that has not answered is not "nothing started"');
  assert.equal(proposalsView({ proposals: { inProgress: [], merged: [] } }).empty, true);
});

test('Your changes: one list across projects, each row led by its project\'s icon (#3364)', () => {
  const profile = require('../src/routes/profile');
  // The server carries the icon beside the name; an image id that is not a
  // plain id never becomes a URL.
  assert.match(profile.MY_PROPOSALS_SQL, /a\.slug AS app_slug, a\.name AS app_name, a\.icon_emoji, a\.icon_image_id/);
  const shaped = profile.shapeProposals([
    { section: 'inProgress', session_id: 1, title: 'A', app_slug: 'run-club', app_name: 'Run Club', icon_emoji: '🏃', icon_image_id: null, status: 'active', at: null },
    { section: 'merged', session_id: 2, title: 'B', app_slug: 'whiteboard', app_name: 'Whiteboard', icon_emoji: null, icon_image_id: 'abc_1', status: 'merged', at: null },
    { section: 'merged', session_id: 3, title: 'C', app_slug: 'odd', app_name: 'Odd', icon_emoji: null, icon_image_id: '../x', status: 'merged', at: null },
  ]).proposals;
  assert.deepEqual([shaped.inProgress[0].appIconEmoji, shaped.inProgress[0].appIconUrl], ['🏃', null]);
  assert.deepEqual(shaped.merged.map((r) => r.appIconUrl), ['/app-icons/abc_1', null]);
  const demo = profile.withDemoProposals({ openForVote: [], inProgress: [], merged: [], closed: [] },
    { slug: 'usernode-2d5619', name: 'Homeroom', icon_emoji: '🏠', icon_image_id: null }, NOW);
  assert.equal(demo.inProgress[0].appIconEmoji, '🏠');

  // The view hands each row its project in app-card.js's field names.
  const { proposalsView } = loadTsx(STORE);
  const view = proposalsView({
    proposals: {
      inProgress: [
        { sessionId: 1, title: 'Dark mode', appSlug: 'run-club', appName: 'Run Club', appIconEmoji: '🏃', at: '2026-09-23T10:00:00Z' },
      ],
      openForVote: [
        { sessionId: 2, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', appIconUrl: '/app-icons/abc', at: '2026-09-22T10:00:00Z' },
      ],
    },
  }, NOW);
  assert.equal(view.sections.length, 1, 'both projects share the one In progress group');
  assert.deepEqual(view.sections[0].rows.map((r) => r.app), [
    { slug: 'run-club', name: 'Run Club', icon_emoji: '🏃', icon_url: null },
    { slug: 'whiteboard', name: 'Whiteboard', icon_emoji: null, icon_url: '/app-icons/abc' },
  ]);

  // The screen draws the tile ahead of each row: emoji, image, or the letter.
  const mod = loadTsx(SCREEN);
  mod.profileProposalsStore.set({
    open: true, kind: 'changes', error: false,
    data: { changes: { proposals: {
      inProgress: [
        { sessionId: 1, title: 'Dark mode', appSlug: 'run-club', appName: 'Run Club', appIconEmoji: '🏃', at: '2026-09-23T10:00:00Z' },
        { sessionId: 3, title: 'Tags', appSlug: 'notes', appName: 'Notes', at: '2026-09-21T10:00:00Z' },
      ],
      openForVote: [
        { sessionId: 2, title: 'Lasso', appSlug: 'whiteboard', appName: 'Whiteboard', appIconUrl: '/app-icons/abc', at: '2026-09-22T10:00:00Z' },
      ],
    } } },
  });
  const out = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  assert.equal((out.match(/data-profile-work-group=/g) || []).length, 1);
  assert.match(out, /data-icon="emoji" data-profile-work-app="run-club" title="Run Club" aria-hidden="true">[\s\S]*?🏃/);
  assert.match(out, /data-icon="image" data-profile-work-app="whiteboard" title="Whiteboard" aria-hidden="true"><img src="\/app-icons\/abc"/);
  assert.match(out, /data-icon="letter" data-profile-work-app="notes" title="Notes" aria-hidden="true">N</);
  mod.profileProposalsStore.set({ open: false, kind: 'changes', data: {}, error: false });
});

test('Your requests: open, then done, each opening the request', () => {
  const { requestsView } = loadTsx(STORE);
  const view = requestsView({
    requests: [
      { number: 11, title: 'Export runs to CSV', appSlug: 'run-club', appName: 'Run Club', state: 'underway' },
      { number: 12, title: 'Bigger tap targets', appSlug: 'game-corner', appName: 'Game Corner', state: 'waiting' },
      { number: 21, title: 'Show times in my time zone', appSlug: 'usernode-2d5619', appName: 'Homeroom', state: 'shipped' },
      { number: 13, title: null, appSlug: 'javascript:1', appName: 'Odd', state: 'closed' },
    ],
    truncated: true,
  });
  assert.deepEqual(view.sections.map((s) => [s.label, s.rows.map((r) => r.meta)]), [
    ['Open', ['Run Club · someone is on it', 'Game Corner · nobody on it yet']],
    ['Done', ['Homeroom · live', 'Odd · closed']],
  ]);
  assert.equal(view.sections[0].rows[0].href, '#app/run-club/dev/issues/11');
  assert.equal(view.sections[1].rows[1].href, null, 'no address built from a slug the shell would not route');
  assert.equal(view.sections[1].rows[1].title, 'Request #13');
  assert.equal(view.truncated, true);
  assert.equal(requestsView(undefined).loaded, false);
});

test('Your votes: still open, then decided, each saying your vote as it stands', () => {
  const { votesView } = loadTsx(STORE);
  const view = votesView({
    items: [
      { type: 'pr_vote', vote: 'yes', status: 'promoted', app: { slug: 'run-club', name: 'Run Club' },
        pr: { sessionId: 31, number: 40, title: 'Weekly distance leaderboard' } },
      { type: 'proposal_vote', vote: 'yes', status: 'open', app: { slug: 'run-club', name: 'Run Club' },
        issue: { id: 77, number: null, title: 'Rename to Run Crew', kind: 'rename' } },
      { type: 'pr_vote', vote: 'yes', status: 'merged', app: { slug: 'run-club', name: 'Run Club' },
        pr: { sessionId: 32, title: 'Route map on the run page' } },
      { type: 'pr_vote', vote: 'no', status: 'archived', app: { slug: 'game-corner', name: 'Game Corner' },
        pr: { sessionId: 33, title: 'Timer sounds' } },
      { type: 'kudos', app: { slug: 'x', name: 'X' } },
    ],
    nextBefore: '2026-09-01T00:00:00Z',
  });
  assert.deepEqual(view.sections.map((s) => [s.label, s.rows.map((r) => [r.title, r.meta, r.href])]), [
    ['Still open', [
      ['Weekly distance leaderboard', 'Run Club · you voted yes', '#app/run-club/dev/proposals/31'],
      ['Rename to Run Crew', 'Run Club · you voted yes', '#app/run-club/dev/governance/77'],
    ]],
    ['Decided', [
      ['Route map on the run page', 'Run Club · you voted yes · live', '#app/run-club/dev/proposals/32'],
      ['Timer sounds', 'Game Corner · you voted no · closed', '#app/game-corner/dev/proposals/33'],
    ]],
  ], 'kudos are not votes');
  assert.equal(view.more, true);
  assert.equal(votesView({ items: [] }).empty, true);
});

test('Your votes: a change still open says what happens next (#4003)', () => {
  const { votesView } = loadTsx(STORE);
  const row = (status, progress) => ({
    type: 'pr_vote', vote: 'yes', status, app: { slug: 'run-club', name: 'Run Club' },
    pr: { sessionId: 31, title: 'T' }, ...(progress ? { progress } : {}),
  });
  const metaOf = (item) => votesView({ items: [item] }).sections[0].rows[0].meta;
  const open = { votesDone: true };
  assert.equal(metaOf(row('promoted', { yes: 1, required: 2, checkState: 'passing' })),
    'Run Club · you voted yes · needs 1 more approval');
  assert.equal(metaOf(row('promoted', { yes: 0, required: 3, checkState: 'pending' })),
    'Run Club · you voted yes · needs 3 more approvals');
  assert.equal(metaOf(row('promoted', { yes: 1, required: 2, lazy: true })),
    'Run Club · you voted yes · goes live after a wait if nobody objects');
  assert.equal(metaOf(row('promoted', { ...open, yes: 1, required: 1, needsMember: true })),
    'Run Club · you voted yes · needs another member\u2019s yes');
  assert.equal(metaOf(row('promoted', { ...open, yes: 2, required: 2, checkState: 'pending' })),
    'Run Club · you voted yes · approved, checks running');
  assert.equal(metaOf(row('promoted', { ...open, yes: 2, required: 2, checkState: null })),
    'Run Club · you voted yes · approved, checks running');
  assert.equal(metaOf(row('promoted', { ...open, yes: 3, required: 2, checkState: 'failing' })),
    'Run Club · you voted yes · approved, checks failing');
  assert.equal(metaOf(row('promoted', { ...open, yes: 2, required: 2, checkState: 'passing' })),
    'Run Club · you voted yes · approved, waiting to merge');
  assert.equal(metaOf(row('promoted')), 'Run Club · you voted yes', 'no progress, nothing claimed');
  assert.equal(metaOf(row('merging')), 'Run Club · you voted yes · merging');
  assert.equal(metaOf(row('going_live')), 'Run Club · you voted yes · going live');
});

// ── The screen ─────────────────────────────────────────────────────────

test('the screen ships hidden and empty, one root for all three views', () => {
  const mod = loadTsx(SCREEN);
  const html = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  assert.match(html, /^<main id="profile-proposals-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll"[^>]*data-profile-work="changes">/);
  assert.doesNotMatch(html, /data-profile-work-group|Loading/, 'nothing but the frame until it is opened');
  assert.equal(mod.workKind('votes'), 'votes');
  assert.equal(mod.workKind('anything'), 'changes');
  assert.deepEqual(mod.WORK_TITLES, { changes: 'Your changes', requests: 'Your requests', votes: 'Your votes' });
});

test('each view draws its own groups; long ones fold; Your requests ends on Suggest an improvement', () => {
  const mod = loadTsx(SCREEN);
  const html = () => renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  const merged = Array.from({ length: 7 }, (_, i) => ({
    sessionId: 100 + i, title: `Merged ${i}`, appSlug: 'run-club', appName: 'Run Club', at: '2026-09-20T10:00:00Z',
  }));
  mod.profileProposalsStore.set({
    open: true, kind: 'changes', error: false,
    data: { changes: { proposals: { inProgress: [], openForVote: [], merged, closed: [] } } },
  });
  let out = html();
  assert.match(out, /data-profile-work-group="merged"/);
  assert.equal((out.match(/Merged \d/g) || []).length, mod.FOLD_AT, 'five, then the fold');
  assert.match(out, /data-profile-work-all="merged"[\s\S]*?Show all live/);

  mod.profileProposalsStore.set({
    kind: 'requests',
    data: { requests: { requests: [{ number: 1, title: 'Export runs', appSlug: 'run-club', appName: 'Run Club', state: 'waiting' }] } },
  });
  out = html();
  assert.match(out, /data-profile-work="requests"/);
  assert.match(out, /Export runs/);
  assert.match(out, /data-profile-work-ask=""[^>]*>Suggest an improvement</);
  assert.match(read(SCREEN), /onClick=\{\(\) => \{ \(window as any\)\.App\?\.openFeedbackModal\?\.\(\); \}\}/);

  mod.profileProposalsStore.set({ kind: 'votes', data: {} });
  assert.match(html(), /Loading…/, 'a view whose read has not answered says so');
  mod.profileProposalsStore.set({ open: false, kind: 'changes', data: {}, error: false });
});

test('the controller reads the view it was opened on, and drops an answer for another', async () => {
  const mod = loadTsx(SCREEN);
  const { profileProposalsController: ctl, profileProposalsStore: store } = mod;
  const prior = { fetch: globalThis.fetch, location: globalThis.location };
  const asked = [];
  let release;
  globalThis.location = { search: '' };
  globalThis.fetch = (url) => {
    asked.push(url);
    return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ items: [] }) }); });
  };
  try {
    const pending = ctl.open('votes');
    assert.deepEqual(asked, ['/api/me/history?type=votes&limit=50']);
    assert.equal(ctl.isOpen('votes'), true);
    assert.equal(ctl.isOpen('requests'), false);
    // The viewer moves on to Your requests before the votes answer.
    store.set({ kind: 'requests' });
    release();
    await pending;
    assert.equal(store.get().data.votes, undefined, 'the votes answer does not paint into Your requests');
    globalThis.fetch = async (url) => { asked.push(url); return { ok: true, json: async () => ({ requests: [] }) }; };
    await ctl.open('requests');
    assert.equal(asked[asked.length - 1], '/api/me/requests');
    assert.deepEqual(store.get().data.requests, { requests: [] });
    ctl.close();
  } finally {
    globalThis.fetch = prior.fetch;
    if (prior.location === undefined) delete globalThis.location; else globalThis.location = prior.location;
  }
});

test('the router: three addresses no username can have, one screen, the bar named for the view', () => {
  const app = read('public/js/app.js');
  assert.match(app, /PROFILE_WORK: \{\s*proposals: 'changes',\s*'your-changes': 'changes',\s*'your-requests': 'requests',\s*'your-votes': 'votes',\s*\},/);
  assert.match(app, /if \(parts\[0\] === 'profile' && App\.PROFILE_WORK\[parts\[1\]\]\) \{[\s\S]{0,600}?App\.navigateToProfileProposals\(App\.PROFILE_WORK\[parts\[1\]\]\);/);
  assert.match(app, /App\.setHeaderTitle\(App\.PROFILE_WORK_TITLES\[view\]\);/);
  assert.match(app, /window\.UsernodeReact\?\.profileProposals\?\.open\?\.\(view\);/);
  // The dialog's "See your requests" lands on the view.
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'), /const SEE_MINE_ROUTE = '#profile\/your-requests';/);
});

// ── The layout (#3498) ─────────────────────────────────────────────────
//
// "Your requests + your votes sections are misformatted (gray, behind
// sidebar) on desktop." The screen arrived after app.css's per-screen route
// lists and was on none of them, so the body kept its gray `bg-zinc-100`
// instead of the wallpaper, the bar kept its zinc-200 surface, and the page
// was not moved over for the desktop rail: its column centred in the whole
// window and, from a laptop width down, began under the rail. The column
// also passed its lists `mx-0` (Profile's arrangement) without Profile's
// `px-4` gutter, so the cards ran edge to edge on a phone.

const CSS = read('public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');

// Every selector in app.css, comments stripped, as written before its `{`.
const SELECTORS = (CSS.match(/[^{}]+(?=\{)/g) || []).map((s) => s.trim());

test('#3498: every wallpaper and bar rule that names Workshop names Your work too', () => {
  // The rules keyed on a visible screen root: `body:has(:is(<roots>):not(.hidden))`.
  const routeRules = SELECTORS.filter((sel) => /body:has\(:is\([^)]*#workshop-screen[^)]*\):not\(\.hidden\)\)/.test(sel));
  // The light and dark ground, their 640px layer sets and the launch cover
  // (5); the cleared bar, its glass, its clip and its faked layer (4).
  assert.equal(routeRules.length, 9, 'the nine route rules that name #workshop-screen are found');
  for (const sel of routeRules) {
    assert.ok(sel.includes('#profile-proposals-screen'),
      `${sel.replace(/\s+/g, ' ').slice(0, 90)}… also names #profile-proposals-screen`);
  }
  const ground = routeRules.filter((sel) => !sel.includes('#platform-header'));
  assert.equal(ground.length, 5, 'so the page paints the wallpaper, not the gray body');
  const bar = routeRules.filter((sel) => sel.includes('#platform-header'));
  assert.equal(bar.length, 4, 'and the bar wears the same glass as on Workshop');
});

test('#3498: on a desktop the screen moves over for the rail like its siblings', () => {
  const desktop = CSS.slice(CSS.indexOf('--platform-rail-w: var(--platform-rail-full);'));
  const at = desktop.indexOf(':is(#home-screen, #browse-screen, #workshop-screen');
  assert.ok(at > 0, 'the rail\'s list of screens that move over is found');
  const rule = desktop.slice(at, desktop.indexOf('}', at));
  const roots = rule.slice(0, rule.indexOf('{'));
  assert.match(roots, /#profile-proposals-screen/, 'Your changes, requests and votes clear the rail');
  assert.match(rule, /padding-left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter\)\);/);
});

test('#3498: the column is Profile\'s, gutter and all, so its mx-0 lists keep a margin', () => {
  const profileRoot = read('frontend/src/features/profile/index.tsx')
    .match(/<div id="profile-root" className="([^"]+)">/);
  assert.ok(profileRoot, 'Profile\'s column is found');
  assert.match(profileRoot[1], /\bpx-4\b/, 'Profile\'s column carries the gutter its mx-0 lists rely on');
  const mod = loadTsx(SCREEN);
  const html = renderToHtml(createElement(mod.ProfileProposalsScreen, {}));
  const column = html.match(/^<main id="profile-proposals-screen"[^>]*><div class="([^"]+)">/);
  assert.ok(column, 'the screen\'s column is found');
  assert.equal(column[1], profileRoot[1], 'the same column as #profile-root, class for class');
  assert.match(read(SCREEN), /<GroupedList className="mx-0" tone="plane">/,
    'the lists still pass mx-0, which is why the column owns the gutter');
});
