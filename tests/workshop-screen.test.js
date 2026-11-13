'use strict';

// The Workshop screen (#workshop): every app you have, with how much of its
// own Workshop page is addressed to you.
//
// Three things can go wrong here, and this file is organised around them.
//
// 1. THE TWO NUMBERS CAN DRIFT FROM WHAT THEY COUNT. The populations are
//    defined by `AppView._workshopView()` in public/js/app-view.js, which
//    builds them from the board's own endpoints; the screen's counts come out
//    of Postgres instead, in one query. Two derivations of one definition is
//    exactly the shape that rots, so the assertions below pin the query
//    against the statuses and predicates those endpoints use rather than
//    against a number somebody typed.
//    It rotted once already, and the `issues` table is where. That table
//    holds governance proposals AND a `general` twin row per request filed
//    through the platform, so a query over it with no `kind` predicate counts
//    the whole request board as votes owed — which is what put forty-six
//    votes waiting on an app whose board had three open requests. The kinds
//    are pinned below too: in this query, and in each of the four places the
//    list is still written out by hand.
//
// 2. THE QUERY CAN ANSWER FOR THE WRONG VIEWER. Every predicate names `$1`;
//    with a NULL viewer `IS DISTINCT FROM` is true for every row and the
//    "needs you" count becomes "every promoted proposal on the platform".
//    The route refuses an anonymous caller for that reason, and that refusal
//    is asserted here rather than left to the middleware.
//
// 3. THE SCREEN CAN BREAK HYDRATION. It ships hidden and empty; a first
//    render that draws rows would mismatch the prerendered document, which
//    console.errors, which fails every proposal check on every route.
//
// Run with: node --test tests/workshop-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderComponent, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const route = require('../src/routes/workshop-overview');
const { botRequestedBySql } = require('../src/services/bot-requested-by');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const sheetTsx = read('frontend/src/features/app-context/app-context-sheet.tsx');

// ── 1. The counts query counts what the lander counts ──────────────────

test('"working" is the viewer\'s own work, in the lander\'s three shapes', () => {
  const sql = route.COUNTS_SQL;
  // The board's `_mySessions`: GET /api/me/active-sessions filtered to the
  // app, which selects `status IN ('active', 'promoted', 'paused')` with
  // `is_headless = FALSE` and which the board then narrows to active/paused.
  assert.match(sql, /my_sessions AS \(/);
  assert.match(sql, /cs\.status IN \('active', 'paused'\)/,
    'the viewer\'s dev sessions are the active and paused ones');
  assert.match(sql, /cs\.is_headless = FALSE/,
    'headless runs are not somebody\'s own work — /api/me/active-sessions excludes them too');
  // The board's `inReview` rows whose user_id is the viewer's: /promoted
  // returns 'promoted' AND 'merging', so a proposal mid-merge is still the
  // author's work in flight rather than vanishing off their row.
  assert.match(sql, /my_proposals AS \([\s\S]*?cs\.status IN \('promoted', 'merging'\)/);
  // #4538: a change Homeroom bot built from a request made for the viewer is
  // in that viewer's working count too, by the shared bot-request predicate
  // on $1 — the same one /promoted selects `requested_by_me` with, so the
  // Communities row and the strip it mirrors cannot disagree. OWED is
  // untouched: the bot is not the viewer, and the viewer still votes on it.
  assert.match(read('src/routes/workshop-overview.js'),
    /OR \$\{botRequestedBySql\('cs', '\$1'\)\}/,
    'the working predicate reads the shared fragment, spelled once');
  assert.match(route.MY_PROPOSALS_WHERE, /cs\.status IN \('promoted', 'merging'\)/);
  assert.ok(route.MY_PROPOSALS_WHERE.includes(botRequestedBySql('cs', '$1')),
    'the predicate is the shared fragment, not a second copy of the rule');
  assert.doesNotMatch(
    /const OWED_PROPOSALS_WHERE = `([\s\S]*?)`;/.exec(read('src/routes/workshop-overview.js'))[1],
    /botRequestedBySql/,
    'a bot change still counts as a vote owed (the bot is not the viewer)');
  // #2227's case: a governance proposal you opened is your work too.
  assert.match(sql, /my_governance AS \([\s\S]*?i\.status = 'open'[\s\S]*?i\.created_by = \$1/);
  // Summed, not unioned — the three statuses are disjoint, so nothing is
  // double counted and no DISTINCT is needed to say so.
  assert.match(sql, /COALESCE\(ms\.n, 0\) \+ COALESCE\(mp\.n, 0\) \+ COALESCE\(mg\.n, 0\)\) AS working/);
});

test('"needs" is the votes owed, on the lander\'s own predicate', () => {
  const sql = route.COUNTS_SQL;
  // `_devCardMatches(kind, it, { needsVote: true })`: a proposal needs your
  // vote when `status === 'promoted' && !my_vote` — NOT 'merging', which is
  // past the decision.
  assert.match(sql, /owed_proposals AS \([\s\S]*?cs\.status = 'promoted'/);
  assert.doesNotMatch(
    /owed_proposals AS \(([\s\S]*?)\n  \),/.exec(sql)[1],
    /merging/,
    'a proposal already merging is not a vote anybody still owes',
  );
  // And yours too (11 Nov 2026): proposing a change or opening a decision
  // is not your yes (governance-rules.ts), so your own is owed your vote
  // like anyone's, as the lander counts it.
  assert.doesNotMatch(/owed_proposals AS \(([\s\S]*?)\n  \),/.exec(sql)[1], /cs\.user_id IS DISTINCT FROM \$1/);
  assert.doesNotMatch(sql, /i\.created_by IS DISTINCT FROM \$1/);
  // Governance votes live in their own table and carry no epoch.
  assert.match(sql, /FROM issue_votes iv[\s\S]*?iv\.issue_id = i\.id AND iv\.user_id = \$1/);
});

test('a vote counts as cast only under the proposal\'s current approval epoch', () => {
  // services/pr-vote-revision.js owns that rule for eighteen call sites; a
  // nineteenth that spelled `pv.approval_epoch = cs.approval_epoch` by hand
  // would be a copy that stops tracking the definition. The interpolation is
  // why this query is in the reviewed dynamic SQL baseline.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/pr-vote-revision'\)/);
  assert.match(src, /\$\{currentVotePredicateSql\('pv', 'cs'\)\}/);
  const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');
  assert.ok(
    route.COUNTS_SQL.includes(currentVotePredicateSql('pv', 'cs')),
    'the rendered query carries the shared predicate, whatever it currently says',
  );
});

test('the two `issues` CTEs read governance proposals, never the request board', () => {
  // `issues` is two populations wearing one table name. Beside the governance
  // proposals it holds a `general` TWIN row per request filed through the
  // platform — the row that remembers who filed it, because GitHub files every
  // platform-authored issue as the bot. Nothing votes on a twin, and
  // `AppView._govProposals` drops them before the lander's deck ever sees one.
  // Counting them here is not a rounding error: a twin is only ever closed by
  // a passed close-issue vote, so it outlives its GitHub issue indefinitely
  // and the pile only grows.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/governance-kinds'\)/);
  assert.equal((src.match(/\$\{governanceKindsSql\('i'\)\}/g) || []).length, 2,
    'both `issues` CTEs interpolate the shared predicate rather than spelling the kinds out');

  const { GOVERNANCE_KINDS, governanceKindsSql } = require('../src/services/governance-kinds');
  const cte = (name) => new RegExp(`${name} AS \\(([\\s\\S]*?)\\n  \\)`).exec(route.COUNTS_SQL)[1];
  for (const name of ['my_governance', 'owed_governance']) {
    assert.ok(
      cte(name).includes(governanceKindsSql('i')),
      `${name} renders the shared predicate, whatever it currently says`,
    );
  }
  // Named, never negated: a sixth kind added to the table becomes a vote
  // somebody owes only once somebody lists it here, which is the safe
  // direction for a number that asks people to do something.
  assert.ok(!GOVERNANCE_KINDS.includes('general'),
    'the request board\'s twin kind is not a thing anybody votes on');
});

test('every hand-written copy of the governance kinds still agrees with the constant', () => {
  const { GOVERNANCE_KINDS } = require('../src/services/governance-kinds');
  const expected = [...GOVERNANCE_KINDS].sort();
  const quoted = (text) => (text.match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)).sort();

  // Four sites still spell the list out, on purpose. Three are static query
  // text, which scripts/check-sql.js validates against a real schema —
  // interpolating would move them into the reviewed dynamic-SQL baseline, a
  // weaker guarantee than the duplication costs. The fourth is browser script
  // with no module loader. Duplication is the cheaper trade only while
  // something notices drift, which is this test.
  const sqlCopies = [
    ...(read('src/routes/issues.js').match(/kind IN \([\s\S]*?\)/g) || []),
    ...(read('src/services/shared-objects.js').match(/kind IN \([\s\S]*?\)/g) || []),
  ];
  assert.equal(sqlCopies.length, 3,
    'a query reading `issues` by kind was added or removed; pin it here too');
  for (const copy of sqlCopies) assert.deepEqual(quoted(copy), expected);

  // And the client's, which is what the lander's "Needs your vote" deck is
  // actually built from. A kind missing there is a proposal nobody is asked
  // to vote on, however right the server's count is.
  const clientFilter = /_govProposals = [\s\S]*?\.filter\(\(i\) =>([\s\S]*?)\);/.exec(appViewJs);
  assert.ok(clientFilter, 'the client still filters `_govProposals` by kind');
  assert.deepEqual(quoted(clientFilter[1]), expected);
});

test('every predicate names the viewer, and the route refuses one it has not got', async () => {
  const sql = route.COUNTS_SQL;
  // Five populations, each gated on $1. Without this the anonymous case is
  // not a smaller answer, it is the whole platform's. #4538 added a ninth:
  // MY_PROPOSALS_WHERE's bot-request predicate, also on $1. #6019 added four
  // in OWED_PROPOSALS_WHERE (a ballot owed once: the viewer's rival, vote,
  // close and close vote) and one for the bot's questions; 5 Nov 2026, three
  // there (OWED_QUESTIONS_FROM: the chat's open ones, the stored states that
  // wait on the viewer's answer, and the chat's again so neither repeats).
  // 11 Nov 2026 took four away: nothing is owed less for being the
  // viewer's own (their change, a rival or a close vote of theirs, a
  // decision they opened), since proposing is not their yes.
  assert.equal((sql.match(/\$1/g) || []).length, 12,
    'the viewer appears in every CTE predicate and in the collaborator join');

  // The refusal itself, driven rather than grepped: `getPool` is called once
  // when the router is built, so a stub config is all it takes.
  const router = route.workshopOverviewRoutes({ databaseUrl: 'postgres://stub/stub' });
  const layer = router.stack.find((l) => l.route?.path === '/api/workshop/counts');
  assert.ok(layer, 'GET /api/workshop/counts is registered');
  let status = null;
  let body = null;
  await layer.route.stack[0].handle(
    { user: null, query: {}, params: {} },
    { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
    () => {},
  );
  assert.equal(status, 401, 'no session, no counts — never a platform-wide tally');
  assert.deepEqual(body, { error: 'Not authenticated' });
});

test('the visibility filter is GET /api/apps\'s, so the two lists cannot disagree', () => {
  const sql = route.COUNTS_SQL;
  assert.match(sql, /\(NOT a\.self_hosted OR \$2::boolean\)/);
  assert.match(sql, /\(\$3::boolean OR a\.view_visibility = 'public' OR me\.user_id IS NOT NULL\)/);
  // As /api/apps also does, a suspended app is left out for everyone: it
  // refuses to open, so a count, item or card for it would lead nowhere.
  for (const [name, q] of [['COUNTS_SQL', sql], ['ITEMS_SQL', route.ITEMS_SQL], ['NEEDS_FEED_SQL', route.NEEDS_FEED_SQL]]) {
    assert.match(q, /a\.moderation_suspended_at IS NULL\s+AND \(NOT a\.self_hosted OR \$2::boolean\)/,
      `${name} leaves out suspended apps`);
  }
  assert.match(read('src/routes/apps.js'), /WHERE a\.moderation_suspended_at IS NULL AND \(NOT a\.self_hosted OR \$1::boolean\)/);
  assert.match(read('src/routes/apps.js'), /\(NOT a\.self_hosted OR \$1::boolean\)/,
    'the clause this mirrors is still the one /api/apps applies');
  // And only apps with something on them are returned: the client reads a
  // missing slug as two zeroes, so a row per app would be payload for nothing.
  assert.match(sql, /\+ COALESCE\(op\.n, 0\) \+ COALESCE\(og\.n, 0\) \+ COALESCE\(oq\.n, 0\)\) > 0/);
});

test('#5023: the Workshop asks GET /api/apps for joined rows only, not the whole catalog', () => {
  const apps = read('src/routes/apps.js');
  assert.match(apps, /const joinedOnly = req\.query\.scope === 'joined' && userId != null;/);
  assert.match(apps, /AND \(NOT \$4::boolean OR cm\.user_id IS NOT NULL\)/,
    'the filter is the is_member column\'s own join, so a kept row is one the client kept before');
  assert.match(apps, /\[showSelfHosted, userId, isAdmin, joinedOnly\]/);
  // One Home (#6361): the switcher's list reads it; the Needs you page left
  // of the Communities screen reads no list of communities at all.
  assert.doesNotMatch(read('frontend/src/features/workshop/index.tsx'), /\/api\/apps/);
  assert.match(read('frontend/src/features/home/home-pins-store.ts'), /sharedJson<any>\('\/api\/apps\?scope=joined'\)/, 'and Home\'s All communities');
  for (const file of ['frontend/src/features/workshop/community-scope.ts']) {
    assert.match(read(file), /sharedJson<any>\(`\/api\/apps\?scope=joined\$\{/, `${file} reads the joined scope`);
  }
});

test('the demo overlay never overwrites a real count', () => {
  const { withDemoCounts, DEMO_COUNTS } = route;
  // `issues` survives the staging clone, so a preview can have genuine
  // governance rows against a slug the overlay also names.
  const real = { 'staging-demo-your-app': { working: 7, needs: 0 } };
  const out = withDemoCounts(real);
  assert.deepEqual(out['staging-demo-your-app'], { working: 7, needs: 0 });
  assert.deepEqual(out['staging-demo-emoji-icon'], DEMO_COUNTS['staging-demo-emoji-icon']);
  assert.ok(Object.keys(DEMO_COUNTS).includes('staging-demo-your-app'),
    'the one demo row Home.isYours accepts has to be one of these, or the '
    + 'declared checks read a screen of zeroes');
  // Keyed to persisted catalog fixtures, so a rename cannot leave the
  // workshop's sample counts pointing at nonexistent apps.
  const appsJs = read('src/services/staging-apps.js');
  for (const slug of Object.keys(DEMO_COUNTS)) {
    assert.ok(appsJs.includes(`'${slug}'`),
      `${slug} is still a stored catalog fixture`);
  }
});

// ── 2. The screen ──────────────────────────────────────────────────────

test('the prerendered page is hidden and empty, and draws the feed only while open (One Home, #6361)', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  assert.match(html, /<main id="workshop-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a CONSTANT class string — '
    + 'useVisibilityHiddenClass writes that class, so React must not re-render it');
  assert.doesNotMatch(html, /data-workshop-pane=/, 'the feed is client data: nothing of it in the first render');
  // The Communities screen's list is gone, with every id the shell shipped
  // for it: Home holds your communities now.
  assert.doesNotMatch(html, /id="workshop-(?:list|empty|search)"/);
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /\{state\.open \? \(\s*<div data-workshop-pane="needs">\s*<ReviewFlow/);
  assert.match(src, /onDone=\{leaveNeeds\}/, 'the reel done is the way back to Home');
  assert.match(src, /function leaveNeeds\(\): void \{[\s\S]*?if \(app\?\._stepBackTo\?\.\('\/'\)\) return;[\s\S]*?app\.navigateHome\(\);/);
  // The document the shell actually ships agrees.
  const shipped = read('public/index.html');
  assert.match(shipped, /<main id="workshop-screen" class="hidden /);
  assert.doesNotMatch(shipped, /id="workshop-(?:list|empty|search)"/);
});

test('groupRows: three sections in order, empty ones left out, an unknown audience read as open', () => {
  const { groupRows, SECTIONS, SECTION_LIMIT } = loadTsx('frontend/src/features/workshop/sections.ts');
  // A section's label is a message id; the words are what the English catalog holds for it.
  assert.deepEqual(SECTIONS.map((s) => [s.key, s.label]),
    [['open', 'communities:sections.open.label'], ['invited', 'communities:sections.invited.label'], ['solo', 'communities:sections.solo.label']]);
  assert.deepEqual(SECTIONS.map((s) => [s.key, message(s.label)]),
    [['open', 'Public communities'], ['invited', 'Private communities'], ['solo', 'Just you']]);
  assert.equal(SECTION_LIMIT, 3, 'three most recent, then "Show N more"');
  const out = groupRows([
    { slug: 'a', audience: 'solo', last_active_at: '2026-09-02T00:00:00Z', working: 0, needs: 0 },
    { slug: 'b', audience: 'open', last_active_at: '2026-09-01T00:00:00Z', working: 0, needs: 0 },
    { slug: 'c', audience: 'mystery', last_active_at: '2026-09-03T00:00:00Z', working: 0, needs: 0 },
    { slug: 'd', audience: 'solo', last_active_at: '2026-09-04T00:00:00Z', working: 0, needs: 0 },
  ]);
  assert.deepEqual(out.map((s) => [s.key, s.rows.map((r) => r.slug)]),
    [['open', ['c', 'b']], ['solo', ['d', 'a']]],
    'no Private communities section when there are none, and a row is never dropped');
});

test('"Show N more" reveals five at a time, then folds back (#3269)', () => {
  const { sectionFold, SECTION_STEP } = loadTsx('frontend/src/features/workshop/sections.ts');
  assert.equal(SECTION_STEP, 5);
  // Twelve rows: 3, then 8, then 12, then back to 3.
  let fold = sectionFold(12, 3);
  assert.deepEqual(fold, { shown: 3, label: 'Show 5 more', next: 8 });
  fold = sectionFold(12, fold.next);
  assert.deepEqual(fold, { shown: 8, label: 'Show 4 more', next: 13 }, 'the last press names what is left');
  fold = sectionFold(12, fold.next);
  assert.deepEqual(fold, { shown: 12, label: 'Show fewer', next: 3 });
  assert.deepEqual(sectionFold(12, fold.next), { shown: 3, label: 'Show 5 more', next: 8 });
  // Three or fewer: no fold at all.
  assert.deepEqual(sectionFold(3, 3), { shown: 3, label: null, next: 3 });
  assert.equal(sectionFold(0, 3).label, null);
});

test('opening Needs you while the community list reads the counts asks for them once (#6591)', async () => {
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  // A window before the load, so the scope publishes its loader beside the
  // page's controller: the two then share one lib/shared-read.ts, as in the
  // shell's bundle.
  global.window = {};
  try {
    const { workshopController, workshopStore } = loadTsx('frontend/src/features/workshop/index.tsx');
    const scope = global.window.UsernodeReact.communityScope;
    const pending = [];
    global.fetch = (url, opts) => new Promise((resolve) => { pending.push({ url: String(url), cache: opts && opts.cache, resolve }); });
    const counts = (needs) => ({ ok: true, json: async () => ({ counts: { a: { working: 0, needs } } }) });
    const feed = { ok: true, json: async () => ({ items: [], max: 0 }) };
    const apps = { ok: true, json: async () => ({ apps: [{ slug: 'a', name: 'A', is_member: true }] }) };
    const settle = (answer) => {
      for (const read of pending.splice(0)) {
        read.resolve(read.url === '/api/workshop/counts' ? answer
          : read.url === '/api/workshop/needs-feed' ? feed : apps);
      }
    };
    const asked = (url) => pending.filter((read) => read.url === url).length;

    // A page load that lands on Needs you: the sidebar's list and the page
    // ask in the same moment.
    const listed = scope.loadCommunities();
    const opened = workshopController.open();
    assert.equal(asked('/api/workshop/counts'), 1, 'one request serves the list and the page');
    assert.equal(asked('/api/workshop/needs-feed'), 1, 'the feed is the page\'s own read');
    settle(counts(2));
    await Promise.all([listed, opened]);
    assert.deepEqual(workshopStore.get().feed, []);
    assert.equal(workshopStore.get().feedError, false);

    // NOTHING IS KEPT: a re-entry asks the server for itself, past any saved
    // copy, even while another read of the same address is on its way.
    workshopController.close();
    const again = scope.loadCommunities(true);
    const reopened = workshopController.open();
    const reads = pending.filter((read) => read.url === '/api/workshop/counts');
    assert.equal(reads.length, 2, 'a re-entry may follow a vote, so it does not take another reader\'s request');
    assert.deepEqual(reads.map((read) => read.cache), ['no-cache', 'no-cache']);
    settle(counts(1));
    await Promise.all([again, reopened]);

    // And the quiet refresh after a change never shares either.
    const forced = scope.loadCommunities(true);
    const quiet = workshopController.refreshNeeds();
    assert.equal(asked('/api/workshop/counts'), 2);
    settle(counts(0));
    await Promise.all([forced, quiet]);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

test('a first entry whose shared counts read fails still draws the feed (#6591)', async () => {
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const { workshopController, workshopStore } = loadTsx('frontend/src/features/workshop/index.tsx');
    const asked = [];
    global.fetch = async (url) => {
      asked.push(String(url));
      if (url === '/api/workshop/counts') return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ items: [], max: 0 }) };
    };
    await workshopController.open();
    assert.deepEqual(asked, ['/api/workshop/counts', '/api/workshop/needs-feed']);
    assert.equal(workshopStore.get().feedError, false, 'the counts are the optional half');
    workshopController.close();
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

test('the controller reads the feed and the counts, survives losing the counts, and says when the feed is lost (One Home, #6361)', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const asked = [];
    const answers = new Map([
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts: { a: { working: 0, needs: 1 } } }) }],
      ['/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(1, 0)], max: 60 }) }],
    ]);
    global.fetch = async (url) => { asked.push(url); return answers.get(url) || { ok: false, json: async () => ({}) }; };
    await workshopController.open();
    assert.equal(workshopStore.get().open, true);
    assert.deepEqual(asked, ['/api/workshop/counts', '/api/workshop/needs-feed'],
      'the two reads, and no list of communities: that is Home\'s now');
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [1]);
    assert.equal(workshopStore.get().feedError, false);
    assert.equal(workshopStore.get().feedCapped, false);

    // THE COUNTS ARE THE OPTIONAL HALF: the feed is the page.
    answers.set('/api/workshop/counts', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [1]);
    assert.equal(workshopStore.get().feedError, false);

    // LOSING THE FEED is the feed's own error state, which offers it again.
    answers.set('/api/workshop/needs-feed', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().feedError, true);
    assert.deepEqual(workshopStore.get().feed, []);

    // A LOAD THAT LANDS AFTER THE VIEWER LEFT PUBLISHES NOTHING. `open` is
    // the liveness flag, not decoration.
    answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(2, 0)], max: 60 }) });
    workshopStore.set({ feed: [item(9, 0)], feedError: false });
    const inFlight = workshopController.reload();
    workshopController.close();
    await inFlight;
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [9],
      'the feed is left as it was, so a re-entry paints it at once');
    assert.equal(workshopController.isOpen(), false);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── 3. The route in, and the way back out ──────────────────────────────

test('#4794: a quiet re-read keeps the feed fresh, and a vote cast in it stays cast', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const countsFor = (ids) => ({ a: { working: 0, needs: ids.length, owed: ids.map((id) => `proposal:${id}@2`) } });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const answers = new Map();
    const reads = [];
    global.fetch = async (url) => {
      reads.push(url);
      return answers.get(url) || { ok: false, json: async () => ({}) };
    };
    const feedAnswer = (items) => answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items, max: 0 }) });
    const countsAnswer = (counts) => answers.set('/api/workshop/counts', { ok: true, json: async () => ({ counts }) });
    feedAnswer([item(7, 2), item(8, 2)]);
    countsAnswer(countsFor([7, 8]));

    await workshopController.open();
    assert.equal(workshopStore.get().feed.length, 2);

    // THE QUIET RE-READ: the counts and the feed.
    reads.length = 0;
    feedAnswer([item(8, 2)]);
    countsAnswer(countsFor([8]));
    await workshopController.refreshNeeds();
    assert.deepEqual(reads, ['/api/workshop/counts', '/api/workshop/needs-feed']);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the feed takes the fresh answer, without a skeleton or a flash');

    // A READ THAT FAILS LEAVES THE FEED AS IT WAS. Offline is a state.
    answers.set('/api/workshop/needs-feed', { ok: false, json: async () => ({}) });
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8], 'the feed is untouched');
    assert.equal(workshopStore.get().feedError, false);

    // A VOTE CAST IN THE FEED TAKES ITS CARD OUT AT ONCE, and every later
    // read keeps it out at the epoch it was voted at.
    feedAnswer([item(7, 2), item(8, 2)]);
    await workshopController.reload();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);
    workshopController.answered(7, 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the answered card leaves the store while the viewer is still in the feed');
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'a read issued before the vote and landing after it cannot bring it back');
    // A NEWER EPOCH PASSES: the card changed under the vote and asks again.
    feedAnswer([item(7, 3), item(8, 2)]);
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // LEFT THE PAGE: a re-read fetches nothing, and the answered set is
    // dropped with the visit — a fresh visit starts from the server's word.
    workshopController.close();
    reads.length = 0;
    await workshopController.refreshNeeds();
    assert.deepEqual(reads, [], 'a closed page fetches nothing');
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

test('#5164: the open screen quietly re-reads what waits, and stops when it closes', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore, WORKSHOP_REFRESH_MS } = mod;
  assert.equal(WORKSHOP_REFRESH_MS, 30000, 'the quiet interval is about half a minute');
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  const priorDocument = global.document;
  const apps = [{ slug: 'a', name: 'A', is_member: true }];
  const counts = { a: { working: 1, needs: 0 } };
  try {
    const reads = [];
    const answers = new Map([
      ['/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) }],
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts }) }],
      ['/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [], max: 0 }) }],
    ]);
    global.fetch = async (url, opts) => {
      reads.push([url, opts && opts.cache]);
      return answers.get(url) || { ok: false, json: async () => ({}) };
    };
    let visibility = 'visible';
    const visibilityListeners = new Set();
    global.document = {
      get visibilityState() { return visibility; },
      addEventListener(kind, fn) { if (kind === 'visibilitychange') visibilityListeners.add(fn); },
      removeEventListener(kind, fn) { visibilityListeners.delete(fn); },
    };
    const timers = [];
    let nextId = 1;
    global.window = {
      Home: { isJoined: (app) => !!(app && app.is_member) },
      setInterval(fn, ms) { const id = nextId++; timers.push({ id, fn, ms }); return id; },
      clearInterval(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    };
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await workshopController.open();
    assert.equal(workshopStore.get().open, true);
    assert.equal(timers.length, 1, 'the open screen runs ONE quiet timer');
    assert.equal(timers[0].ms, WORKSHOP_REFRESH_MS);
    assert.equal(visibilityListeners.size, 1, 'and listens for the tab coming back');

    // A VISIBLE TICK re-reads exactly the quiet reads, asking for the
    // CURRENT answer rather than the worker's saved copy.
    reads.length = 0;
    timers[0].fn();
    await settle();
    assert.deepEqual(reads, [
      ['/api/workshop/counts', 'no-cache'],
      ['/api/workshop/needs-feed', 'no-cache'],
    ]);

    // A HIDDEN TAB reads nothing: the return listener catches up instead.
    visibility = 'hidden';
    reads.length = 0;
    timers[0].fn();
    await settle();
    assert.deepEqual(reads, []);

    // RETURNING TO THE TAB reads at once, not at the next tick.
    visibility = 'visible';
    reads.length = 0;
    for (const fn of visibilityListeners) fn();
    await settle();
    assert.deepEqual(reads.map(([url]) => url), ['/api/workshop/counts', '/api/workshop/needs-feed']);

    // RE-ENTRY never stacks a second timer; leaving stops the watch.
    await workshopController.open();
    assert.equal(timers.length, 1, 'a second open replaces the timer, never adds one');
    workshopController.close();
    assert.equal(timers.length, 0, 'closing the screen stops the timer');
    assert.equal(visibilityListeners.size, 0, 'and its listener');
  } finally {
    if (priorDocument === undefined) delete global.document; else global.document = priorDocument;
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

test('coming back from an app re-reveals the screen', () => {
  // `_inWorkshop` and workshopController.isOpen() both stay true while the
  // viewer is inside an app they opened from here — navigateToApp reveals
  // #app-view through the kit's `after` callback, not through an exit chain,
  // so nothing clears either. A re-entry guard built on those would refuse
  // the one navigation this screen exists to support: the way back.
  const body = /\n  navigateToWorkshop\(\) \{([\s\S]*?)\n  \},/.exec(appJs);
  assert.ok(body, 'navigateToWorkshop is defined');
  assert.match(body[1], /if \(App\._inWorkshop && !App\.currentApp\) return;/,
    'the guard is the PAIR: the flag set, and no app on screen');
  assert.doesNotMatch(body[1], /workshop\?\.isOpen/,
    'not the island, which cannot tell "here" from "came from here"');
  // And both halves are written before the transition, because popstate and
  // hashchange land in the same tick — `_revealedScreen` is only assigned
  // inside the callback and would let the second run straight through.
  const beforeTransition = body[1].slice(0, body[1].indexOf('PlatformUI.transition('));
  assert.match(beforeTransition, /App\._inWorkshop = true;/);
  assert.match(beforeTransition, /App\.currentApp = null;/);
  // The other half of the same fact: nothing on the way into an app clears
  // the flag, so the pair above is what tells "here" from "came from here".
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const chain = enter.slice(0, enter.indexOf('PlatformUI.transition('));
  assert.doesNotMatch(chain, /_exitWorkshop/,
    'entering an app must not clear _inWorkshop — the way back reads it');
});

test('#needs is the Needs you page; #communities and #workshop land on Home, or here with ?ws=needs (One Home, #6361)', () => {
  assert.match(appJs, /if \(parts\[0\] === 'needs'\) \{[\s\S]*?App\.navigateToWorkshop\(\);\s*return;\s*\}/);
  const old = /if \(parts\[0\] === 'communities' \|\| parts\[0\] === 'workshop'\) \{([\s\S]*?)\n      \}\n/.exec(appJs);
  assert.ok(old, 'the old addresses are still read');
  assert.match(old[1], /new URLSearchParams\(location\.search\)\.get\('ws'\) === 'needs'\s*\|\| new URLSearchParams\(fragQuery\)\.get\('ws'\) === 'needs';/);
  assert.match(old[1], /history\.replaceState\(null, '', App\._rootUrl\('#needs'\)\);[\s\S]*?App\.navigateToWorkshop\(\);\s*return;/,
    'rewritten in place, so no Back step is added');
  assert.match(old[1], /history\.replaceState\(null, '', App\._rootUrl\(''\)\);[\s\S]*?App\.navigateHome\(\);\s*return;/);
  assert.match(appJs, /case 'needs': return 'workshop-screen';/, 'a cold boot paints the page it will land on');
  assert.match(appJs, /navigateToWorkshop\(\) \{/);
  assert.match(appJs, /_exitWorkshop\(\) \{[\s\S]*?App\._inWorkshop = false;/);
  assert.match(appJs, /App\.setHeaderTitle\(PlatformI18n\.t\('shell:title\.needs'\)\)/);
  assert.equal(message('shell:title.needs'), 'Needs you');
  // A page under Home: its tab is Home's, and the header's arrow goes up to it.
  assert.match(appJs, /'workshop-screen': \['arrow', '\/'\],/);
  assert.match(read('frontend/src/features/nav/nav-store.js'), /'workshop-screen': 'home',/);
  // The vote digest opens it, and Home's tile does while a vote waits.
  assert.match(read('frontend/src/features/notifications/notifications.js'),
    /item\.kind === 'vote_digest' && !item\.appSlug\) \{[\s\S]{0,200}window\.location\.hash = '#needs';/);
  assert.match(read('frontend/src/features/home/pinned-communities.tsx'), /href="#needs"\s+id="home-needs-tile"/);
  // The app menu keeps the SCOPED entrance, the project's own hub (#2761).
  assert.match(sheetTsx, /communityRowHref\(slug: string \| null \| undefined, owed: number \| null\): string \{[\s\S]*?: `#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/hub`;[\s\S]*?href=\{communityRowHref\(slug, owed\)\}/,
    "and the app's menu links out to it, scoped");
  assert.match(sheetTsx, /id="app-menu-row-workshop"/, 'as a row');
  assert.ok(!/AppViewTabs/.test(sheetTsx), 'and not as a toggle segment');
});

test('the ✕ knows the page the app was opened from, and forgets it with the visit', () => {
  // The breadcrumb this replaced said '#workshop' when the Workshop screen was
  // the origin and nothing otherwise, so the ✕ went Home from every other
  // page — a thread, Discover, Me. The ✕ now goes back to whichever page it
  // was (App.closeApp, driven for real in tests/app-close-origin.test.js);
  // what is pinned here is who writes that memory and who clears it.
  assert.ok(!/_appBackHref/.test(appJs), 'the Workshop-only breadcrumb is retired');
  assert.match(appJs, /^ {2}_appReturn: null,$/m,
    'the slot is declared on App with the prose that says who owns it');
  // Written as an app's App tab is about to come on screen, BEFORE its
  // entry is pushed over the page it was opened from — by navigateToApp…
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const noted = enter.indexOf("if (initialRoute.tab === 'app') App._noteAppReturn(slug);");
  const pushed = enter.indexOf('App.updateHash({ ref: initialRoute.ref });');
  assert.ok(noted > 0 && pushed > noted, 'noted before the app\'s own address is written');
  assert.ok(enter.indexOf('App._pinAppReturn();') > pushed, 'and pinned once it has been');
  // …and by switchTab, when the app's own Workshop hands over to the app.
  const sw = appJs.slice(appJs.indexOf('  async switchTab('));
  assert.match(sw, /if \(tab === 'app' && App\.currentTab !== 'app' && !options\?\.replaceRoute\) \{\s*App\._noteAppReturn\(App\.currentApp\);/);
  // One clearer: revealing any other screen ends the visit it was about.
  assert.match(appJs, /if \(revealId !== 'app-view'\) App\._appReturn = null;/,
    'revealing any other screen ends the app visit it was about');
  // The ✕ is App.closeApp's, ahead of the handler's own href-following rule —
  // which still serves every ARROW: the href IS the answer, and home is the
  // fallback for a screen that named no parent.
  const handler = appJs.slice(appJs.indexOf("document.getElementById('back-btn').addEventListener('click'"));
  const close = handler.indexOf("if (App.currentApp && App.currentTab === 'app' && App.closeApp()) return;");
  const follow = handler.indexOf("if (href && href.startsWith('#') && href.length > 1) {");
  assert.ok(close > 0 && follow > close, 'the ✕ is claimed before the href is followed');
  // The mixed address a fragment produces — /app/<slug>/workshop#workshop —
  // is still healed to /#workshop by restoreFromHash.
  assert.match(appJs, /if \(rawHash && pathRoute && !rawHash\.startsWith\('app\/'\)\) \{/);
});

test('the Dev lander needs no back arrow, because the rail is beside it', () => {
  // IT HAD ONE, and it was the whole of the way out: `App._appBackHref` said
  // the app had been opened from the Workshop screen, and the lander
  // published a ← to it. That was the best available answer on a surface
  // with no rail — and it only pointed anywhere at all for readers who
  // arrived by that one route.
  //
  // The rail is there now (#2718 review). The app's Workshop is a platform
  // screen scoped to one app, App._syncPlatformTabs keeps the bar up on it
  // and lights the Workshop tab, and that tab lands on the very screen the
  // arrow pointed at — for everyone, however they got here.
  assert.ok(!appViewJs.includes("App.setBackIcon?.('arrow', App._appBackHref)"),
    'the lander publishes no arrow of its own');
  assert.match(appViewJs, /App\.setBackIcon\?\.\('none'\);/,
    'and the sub-view reset is an empty slot, not the house');
  // The reset still sits ABOVE the branches, so the session's own ← survives
  // it and nothing else inherits that arrow. #2770 moved its destination: a
  // change is an agent conversation, so it hangs off Messages, not the board.
  const reset = appViewJs.indexOf("App.setBackIcon?.('none');");
  const session = appViewJs.indexOf("if (subTab === 'sessions' && ref) {");
  assert.ok(reset > 0 && session > reset,
    'the reset leads, so every sub-view that wants a slot claims it after');
  const sessionBranch = appViewJs.slice(session, appViewJs.indexOf('\n    }', session));
  assert.match(sessionBranch, /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'and a session leads with a real ← up to Messages (#2770)');
  // The ✕ is the app TAB's alone (on a phone, or with the rail not kept
  // beside it), and it lands wherever the visit began.
  assert.match(read('public/js/app.js'), /return \['close', App\._closeAppHref\(\)\];/);
  // An arrow WITH an href is what turns the phone's back gesture on — still
  // true, and still what the session sub-view relies on.
  assert.match(read('frontend/src/features/header/native-back-navigation.ts'),
    /mode === 'arrow' && !!href/);
});

// ── One Workshop, two scopes (#2718 review) ────────────────────────────

test('the app\'s own Workshop keeps the rail, and lights the tab it came through', () => {
  // "should preserve the side bar. It doesn't need a back button anymore
  // because of the side bar."
  //
  // #app-view is TWO screens behind one id: the running app, which takes the
  // whole window because that is what makes it feel like a program, and on
  // the `dev` tab the platform's own Workshop for that app. The second is a
  // platform screen that happens to be scoped, and hiding the rail there left
  // it as the one such screen with no navigation at all.
  const appJs = read('public/js/app.js');
  const sync = appJs.slice(appJs.indexOf('  _syncPlatformTabs(revealId) {'));
  const body = sync.slice(0, sync.indexOf('\n  },\n'));
  assert.match(body, /const inApp = screen === 'app-view' && App\.currentTab === 'app';/,
    'the app itself covers the rail; its Workshop does not');
  // …except on a desktop, where the rail stays beside it by default (#3319,
  // tests/nav-rail-pinned.test.js).
  assert.match(body, /!!screen && !App\.chromeless && \(!inApp \|\| railPinned\),/);
  // The Workshop tab is lit, so the rail knows where you are — except on the
  // app's DISCUSSION, which is a row in the Messages inbox and lights that
  // instead (#2718 review).
  // (A thread opened from the Homeroom bot tab's page lights that tab: App._isBotTopic.)
  assert.match(body, /\? \(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/,
    'and the Workshop tab is lit, so the rail knows where you are');

  // A TAB HOP inside the app crosses that line without a screen reveal, so
  // it is the only other place that has to re-sync.
  const hop = appJs.slice(appJs.indexOf('  async switchTab(tab, ref, subTab, options) {'));
  assert.match(hop.slice(0, hop.indexOf('\n  },\n')),
    /if \(App\._isScreenVisible\?\.\('app-view'\)\) App\._syncPlatformTabs\('app-view'\);/,
    'the rail moves with the tab');

  // And the Workshop's lander ends ABOVE the platform's bar: its floor takes
  // off the larger of that bar and the home-indicator strip. (The Workshop's
  // own tabs used to float at the foot and ride on the bar; they sit at the
  // head of the page now, #2767, so the floor is the only thing that has to
  // know about it.)
  const css = read('public/css/app.css');
  assert.match(css,
    /--ws-area: calc\([\s\S]*?max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)\s*\);/);
});

test('the app\'s own Workshop switches communities through Your communities, the same switcher the tab opens (#852)', () => {
  // "should preserve the app switcher". The all-apps screen's chip says "All"
  // and picking a community goes to its hub; on a project page the coloured
  // header's name and ⌄ open the same switcher, whose All communities row is
  // the way back up. The in-page "Which project?" panel it replaced is gone.
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.doesNotMatch(ws, /AppWorkshopScope|workshop-chrome/, 'no panel of the page\'s own');
  assert.match(header, /id="header-app-switch"\n\s+type="button"[\s\S]{0,600}onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/);
  // The page reads the app's name and artwork from the store the header's
  // tile reads, so the two cannot disagree about which community this is.
  assert.match(ws, /const app = useStoreState\(improveStore\);/);
  assert.match(ws, /name=\{app\.name \|\| undefined\}/);

  // ALL COMMUNITIES IS THE WAY BACK UP, and the page the tab reopened is
  // forgotten. One Home (#6361): it is Home's, Pinned communities with its
  // All communities open, where the Communities screen's list was.
  assert.match(scope, /if \(!slug\) \{\s*setScope\(null\);\s*try \{ app\?\._forgetWorkshopView\?\.\(\); \}[\s\S]{0,200}home\.showCommunities\(\{ all: true \}\);/);
  assert.doesNotMatch(scope, /openDrawerList|requestOuter/);
  // The community you are already on goes nowhere: re-navigating to the
  // current route would throw the page's scroll away, and it stays on the
  // place it shows. Another one opens on the place you were on, when it has
  // it: a switch keeps your page, as the phone's drawer does.
  assert.match(scope, /if \(onPage\) return;\s*landKeepingPlace\(slug\);\s*void app\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.doesNotMatch(scope, /_landOnHub/, 'a switch is not a door to the hub');
  // Its open flag is its own store's, not workshopStore's: the header and
  // the tab bar are other React roots.
  assert.match(scope, /switcher: SwitcherFrom \| null;/);
  // The list loads on open, and never during render.
  assert.match(scope, /communityScopeStore\.set\(\{ switcher: from, anchor \}\);\s*void loadCommunities\(\);/);
  assert.match(scope, /sharedJson<any>\(`\/api\/apps\?scope=joined\$\{q\.replace\('\?', '&'\)\}`/);
});

// ── 4. The rows behind the counts (#3051) ──────────────────────────────
//
// The all-apps screen's two tabs list, item by item, what its two numbers
// count. The failure this section exists for is the one section 1 guards
// against for the counts: a SECOND spelling of the populations that drifts,
// so a row says "3 votes waiting" over a tab that lists two.

test('#3051: the items query reads the counts\' own five predicates, once each', () => {
  const src = read('src/routes/workshop-overview.js');
  // One definition per population, interpolated into both queries.
  for (const name of ['MY_SESSIONS_WHERE', 'MY_PROPOSALS_WHERE', 'MY_GOVERNANCE_WHERE',
    'OWED_PROPOSALS_WHERE', 'OWED_GOVERNANCE_WHERE', 'OWED_QUESTIONS_WHERE']) {
    assert.equal((src.match(new RegExp(`const ${name} = `, 'g')) || []).length, 1, `${name} is defined once`);
    // The owed populations are read a third time, by the Needs you feed
    // (#3270), so the tab's cards and the counts beside it cannot disagree,
    // and a fourth by the same feed counted per project
    // (OWED_BY_COMMUNITY_SQL), so a per-project count agrees with that feed
    // about what is waiting and where.
    const reads = name.startsWith('OWED_') ? 4 : 2;
    assert.equal((src.match(new RegExp(`\\$\\{${name}\\}`, 'g')) || []).length, reads,
      `${name} is read by COUNTS_SQL and ITEMS_SQL alike${reads === 4 ? ', and by NEEDS_FEED_SQL and OWED_BY_COMMUNITY_SQL' : ''}`);
  }
  assert.equal((src.match(/\$\{VISIBLE_APP_WHERE\}/g) || []).length, 5,
    'and all four apply GET /api/apps\'s visibility filter, as does the fifth read beside them, what went live this week (LIVE_FEED_SQL)');
  // The per-project count is the feed's own membership rule too.
  assert.match(route.OWED_BY_COMMUNITY_SQL,
    /JOIN community_members cm ON cm\.community_id = a\.community_id AND cm\.user_id = \$1/);
  const items = route.ITEMS_SQL;
  assert.ok(items.includes(require('../src/services/pr-vote-revision').currentVotePredicateSql('pv', 'cs')));
  assert.equal((items.match(new RegExp(require('../src/services/governance-kinds')
    .governanceKindsSql('i').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2,
  'both `issues` branches read governance proposals, never the request board');
  // Six branches, in the order the sections are named: #6019 added the bot's
  // open questions to what is owed.
  const sections = [...items.matchAll(/SELECT '(working|needs)'/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['working', 'working', 'working', 'needs', 'needs', 'needs']);
});

test('#3051: the items read is bounded per app and in all', () => {
  const sql = route.ITEMS_SQL;
  assert.match(sql, /PARTITION BY it\.app_id, it\.section/);
  assert.match(sql, /WHERE r\.rn <= \$4/);
  assert.match(sql, /LIMIT \$5/);
  // Newest-first rank ahead of slug, so the overall cap trims every app's
  // oldest rows before it drops any app's newest.
  assert.match(sql, /ORDER BY r\.rn, a\.slug, r\.section/);
  assert.ok(route.ITEMS_PER_APP > 0 && route.ITEMS_PER_APP <= 10);
  assert.ok(route.ITEMS_TOTAL > 0 && route.ITEMS_TOTAL <= 500);
});

test('#3051: GET /api/workshop/items refuses an anonymous caller', async () => {
  const router = route.workshopOverviewRoutes({ databaseUrl: 'postgres://stub/stub' });
  const layer = router.stack.find((l) => l.route?.path === '/api/workshop/items');
  assert.ok(layer, 'GET /api/workshop/items is registered');
  assert.ok(layer.route.methods.get && Object.keys(layer.route.methods).length === 1, 'and it only reads');
  let status = null;
  let body = null;
  await layer.route.stack[0].handle(
    { user: null, query: {}, params: {} },
    { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
    () => {},
  );
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'Not authenticated' });
});

test('#3051: rows group by app and section, and the demo agrees with the demo counts', () => {
  const at = new Date('2026-09-24T09:00:00Z');
  const grouped = route.groupItems([
    { slug: 'a', section: 'working', kind: 'session', id: '4', title: 'T', status: 'active', at },
    { slug: 'a', section: 'needs', kind: 'governance', id: 5, title: null, status: 'rename', at: null },
    { slug: 'b', section: 'needs', kind: 'proposal', id: 6, title: 'P', status: 'promoted', at },
  ]);
  assert.deepEqual(grouped.a.working, [{ kind: 'session', id: 4, title: 'T', status: 'active', at: at.toISOString() }]);
  assert.deepEqual(grouped.a.needs.map((i) => [i.id, i.title, i.at]), [[5, '', null]]);
  assert.deepEqual(grouped.b.working, []);
  // The demo rows sit under the demo counts, so the preview's row and tab agree.
  for (const [slug, slot] of Object.entries(route.DEMO_ITEMS)) {
    assert.equal(slot.working.length, route.DEMO_COUNTS[slug].working, `${slug} working`);
    assert.equal(slot.needs.length, route.DEMO_COUNTS[slug].needs, `${slug} needs`);
  }
  const real = { 'staging-demo-your-app': { working: [], needs: [] } };
  assert.deepEqual(route.withDemoItems(real)['staging-demo-your-app'], { working: [], needs: [] },
    'real rows win, as they do for the counts');
});

test('#6276: the Needs you pane draws the review flow instead of the old feed', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));
  mod.workshopStore.set({
    open: true, error: false, tab: 'needs', scopeOpen: false,
    rows: [{ slug: 'garden', name: 'Garden', working: 0, needs: 2 }],
    feed: [{ kind: 'proposal', id: 8, title: 'Item 8', app: { slug: 'garden', name: 'GARDEN' } }],
    feedError: false, feedCapped: false,
  });
  const out = html();
  const pane = out.slice(out.indexOf('data-workshop-pane="needs"'));
  assert.match(pane, /data-review-flow=""/, 'the review flow draws the feed');
  assert.doesNotMatch(pane, /data-needs-reel|data-ws-rail-btn|workshop-reel-card/, 'the old deck is gone');
  mod.workshopStore.set({ open: false, tab: 'status', rows: null, feed: null, feedError: false });
});

test('#6344: a feed of only decisions and questions lists them instead of saying nothing waits', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));
  mod.workshopStore.set({
    open: true, error: false, tab: 'needs', scopeOpen: false,
    rows: [{ slug: 'garden', name: 'Garden', working: 0, needs: 2 }],
    feed: [
      { kind: 'governance', id: 9, title: 'Rename the app to Recipe Box', app: { slug: 'garden', name: 'Garden' } },
      { kind: 'question', id: 15, title: '', number: 7, app: { slug: 'garden', name: 'Garden' } },
    ],
    feedError: false, feedCapped: false,
  });
  const out = html();
  const pane = out.slice(out.indexOf('data-workshop-pane="needs"'));
  assert.match(pane, /data-needs-pages="2"/, 'both waiting items are drawn');
  assert.match(pane, /data-needs-page-row="governance:9"/);
  assert.match(pane, /data-needs-page-row="question:15"/);
  assert.match(pane, /href="#app\/garden\/dev\/governance\/9"/, 'a group decision opens its own page');
  assert.match(pane, /href="#app\/garden\/dev\/issues\/7"/, 'a question opens its request\'s page');
  assert.match(pane, /Group decision in Garden/);
  assert.match(pane, /Question from Homeroom bot in Garden/);
  assert.doesNotMatch(pane, /data-needs-empty/, 'it no longer says nothing is waiting');
  mod.workshopStore.set({ open: false, tab: 'status', rows: null, feed: null, feedError: false });
});

test('#3270: the page reads the feed, never your own items, and marks a capped read', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const answers = new Map([
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts: { a: { working: 0, needs: 2 } } }) }],
      ['/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(1, 0), item(2, 0)], max: 2 }) }],
    ]);
    const asked = [];
    global.fetch = async (url) => { asked.push(url); return answers.get(url) || { ok: false, json: async () => ({}) }; };
    await workshopController.open();
    assert.ok(!asked.includes('/api/workshop/items'), 'your own items are Profile\'s now, not this page\'s');
    assert.ok(asked.includes('/api/workshop/needs-feed'));
    assert.equal(workshopStore.get().feed.length, 2);
    assert.equal(workshopStore.get().feedCapped, true, 'the read stopped at its bound');
    workshopController.close();
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── #4417: By category leads with the project's topics ────────────────

test('By category: Topics, then Other categories, each topic with a door to its channel', () => {
  const WS = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const { orderThemesStable } = loadTsx(WS);
  const theme = (id, people, extra = {}) => ({
    id, people: Array.from({ length: people }, (_, i) => `u${i}`), lastActive: 0, counts: { open: 0 }, ...extra,
  });
  const topic = (id, people) => theme(id, people, { topic: { key: id, handle: id } });
  // The topics lead in the server's order (dapp.json's), whatever the sort;
  // the other categories sort among themselves; "Not yet grouped" stays last.
  const themes = [topic('onboarding', 1), theme('a', 2), topic('infra', 9), theme('b', 7), theme('z', 0, { ungrouped: true })];
  assert.deepEqual(orderThemesStable(null, themes, 'people').map((t) => t.id), ['onboarding', 'infra', 'b', 'a', 'z']);
  const held = { key: 'people', ids: ['b', 'a', 'infra', 'onboarding', 'z'] };
  assert.deepEqual(orderThemesStable(held, themes, 'people').map((t) => t.id).slice(0, 2), ['onboarding', 'infra'],
    'a held order never moves a topic down');

  const src = read(WS);
  // Two headings, and only when the project has topics: one without draws
  // its categories as it always did.
  assert.match(src, /\{themes\.some\(\(theme\) => theme\.topic\) \? \(\s*<SectionHeader className="pt-3" data-ws-themes-head="topics">\{t\('project:allItems\.themes\.topics'\)\}<\/SectionHeader>/);
  assert.equal(message('project:allItems.themes.topics'), 'Topics');
  assert.match(src, /themes\.some\(\(x\) => x\.topic\) && !theme\.topic && \(i === 0 \|\| themes\[i - 1\]\.topic\) \? \(\s*<SectionHeader className="pt-3" data-ws-themes-head="other">\{t\('project:allItems\.themes\.other'\)\}<\/SectionHeader>/);
  assert.equal(message('project:allItems.themes.other'), 'Other categories');
  // A topic card's foot is "Discuss in #name ›": an anchor with the channel's
  // own address, which opens it on the page and leaves the card shut.
  assert.match(src, /className="dev-ws-link dev-ws-topic-link"\s*data-ws-topic-channel=\{theme\.topic\.handle\}\s*href=\{placeHref\(slug, channelPlace\(theme\.topic\.handle\)\)\}/);
  assert.match(src, /\{t\('project:allItems\.theme\.discuss', \{ channel: theme\.topic\.handle \}\)\}/);
  assert.equal(message('project:allItems.theme.discuss', { channel: 'onboarding' }), 'Discuss in #onboarding ›');
  assert.match(src, /e\.stopPropagation\(\);/);
});

test('the Topics dialog: handles from names, and each row says its channel and its count', () => {
  const { handleFromName, topicRowLine } = loadTsx('frontend/src/features/dialogs/topics.tsx');
  assert.equal(handleFromName('Homeroom bot'), 'homeroom-bot');
  assert.equal(handleFromName('  Proposal  pipeline! '), 'proposal-pipeline');
  assert.equal(handleFromName('3D printing'), 'd-printing', 'a handle starts with a letter');
  assert.equal(handleFromName('Café'), 'cafe');
  const t = { kind: 'topic', key: 'onboarding', handle: 'onboarding', state: 'live', requests: 9 };
  assert.equal(topicRowLine(t), '#onboarding · 9 requests');
  assert.equal(topicRowLine({ ...t, requests: 1 }), '#onboarding · 1 request');
  assert.equal(topicRowLine({ ...t, requests: 0 }), '#onboarding', 'a zero says nothing');
  assert.equal(topicRowLine({ ...t, state: 'archived' }), '#onboarding · archived');
  assert.equal(topicRowLine({ ...t, handle: 'signup', state: 'merged', merged_into: 'onboarding' }, [t]),
    '#signup · merged into #onboarding');
});

// ── #4486: All items, a project Workshop's page ───────────────────────
//
// Not this screen, but the page its rows lead to: the project's All items,
// whose rows open the item's page in the panel the Workshop tab uses, and
// whose one-row head and pipeline stay on screen down a long column.

const workshopTsx = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const kanbanTsx = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const appCss = read('public/css/app.css');

test('#4486: a row on All items opens its page beside the board on a wide window, and a tab change closes it', () => {
  // The same panel, from the same handler: a plain click on a wide window,
  // anything else the row's own link (a phone: the page takes the screen).
  assert.match(workshopTsx, /if \(!sideWide\) return;\s*event\.preventDefault\(\);\s*setSideItem/);
  assert.match(workshopTsx, /<DevKanban openKey=\{sideKey\} onOpen=\{openItem\} \/>/, 'the board’s rows');
  assert.match(workshopTsx, /<WorkList rows=\{rows\} slug=\{slug\} openKey=\{openKey\} onOpen=\{onOpen\} variant="board" category=\{false\} \/>/,
    'and By category’s');
  // 16 Oct 2026: and from the bot's slots page (?ws=bot), one `sideOpen`.
  assert.match(workshopTsx, /const sideOpen = !!sideItem && \(tab === 'workshop' \|\| tab === 'all' \|\| tab === 'bot'\);/);
  assert.match(workshopTsx, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/);
  assert.match(workshopTsx, /data-ws-side-open=\{sideOpen \? '' : undefined\}/);
  // It closes whenever the tab changes, and when the window narrows.
  assert.match(workshopTsx, /useEffect\(\(\) => \{\s*setSideItem\(null\);\s*if \(tab !== 'workshop'\) setOpenWeek\(null\);\s*\}, \[tab\]\);/);
  assert.match(workshopTsx, /useEffect\(\(\) => \{\s*if \(!sideWide\) setSideItem\(null\);\s*\}, \[sideWide\]\);/);
  // #6208: the list keeps its reading width at the 24px inset and the panel
  // takes the room it leaves (the width body defines, which the portalled
  // panel reads too). The old centring margin is gone.
  assert.match(appCss, /#dev-workshop:has\(> \.dev-ws\[data-ws-side-open\]\) \{\s*margin-inline-start: 24px; margin-inline-end: 0;\s*max-width: var\(--dev-ws-side-list-w\);\s*\}/);
  assert.ok(!/1352px/.test(appCss), 'the centring formula is gone');
  // The board keeps its place beside it: 316px columns, scrolling sideways,
  // the tapped column brought beside the panel and the strip following.
  assert.match(appCss, /#dev-workshop\.dev-ws-has-board:has\(> \.dev-ws\[data-ws-side-open\]\) \{ margin-inline-start: 24px; max-width: var\(--dev-ws-side-list-w\); \}/);
  assert.match(appCss, /\.dev-ws\[data-ws-side-open\] :is\(#dev-kanban, \.dev-kanban-stages\) \{ grid-template-columns: repeat\(4, 316px\); \}/);
  assert.match(workshopTsx, /if \(c\.right > b\.right\) board\.scrollLeft \+= Math\.ceil\(c\.right - b\.right\);\s*else if \(c\.left < b\.left\) board\.scrollLeft -= Math\.ceil\(b\.left - c\.left\);\s*syncStrip\(board\);/);
});

test('#4486: the one-row head and the pipeline pin together under the project’s tabs', () => {
  // Both live in the pane head, which is what pins (position: sticky, under
  // the tabs at the measured offset), so the column names stay on screen.
  const head = workshopTsx.slice(workshopTsx.indexOf('<div className="dev-ws-pane-head">'), workshopTsx.indexOf('<div className="dev-ws-pane-body">'));
  assert.match(head, /<div className="dev-ws-allbar" data-ws-allbar="">\s*<PageBack[\s\S]*?eyebrow=\{false\}[\s\S]*?<GroupStrip group=\{group\} \/>[\s\S]*?<DevActionsRow/);
  assert.match(head, /\{group === 'stage' \? <StageStrip \/> : null\}/);
  assert.match(appCss, /\.dev-ws-pane-head \{\s*position: sticky; top: 0; z-index: 20;/);
  assert.match(appCss, /#dev-workshop \.dev-ws-pane-head \{\s*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\);/);
  // Pinned, on By stage, the row and the steps take the sheet's colour.
  assert.match(appCss, /#dev-workshop\.dev-ws-has-board \.dev-ws\[data-ws-head-pinned\] \.dev-ws-pane-head \{\s*background-color: var\(--dc-sheet-solid\);/);
  // The strip cannot share a sideways scroller with the board (that box
  // would be what it pinned to), so it follows the board's scroll instead.
  assert.match(kanbanTsx, /export function syncStrip\(board: HTMLElement \| null\): void \{/);
  assert.match(appCss, /\.dev-kanban-stages \{[^}]*overflow: hidden;/);
  // On a phone (#5029) the search keeps its own line and the switch and the
  // filters share the one under it. #5820: the chips no longer fill that
  // space beside the switch — they size to their icons and `margin-left:
  // auto` pushes them to the right edge, so the grouping stays left and the
  // filters read as the other group.
  assert.match(appCss, /@media \(max-width: 639px\) \{[\s\S]*?\.dev-ws-allbar #dev-kanban-search \{ flex-basis: 100%; max-width: none; min-width: 0; \}[\s\S]*?\.dev-ws-allbar #dev-filter-chips \{ flex: 0 1 auto; margin-inline-start: auto; min-width: 0; /);
});

// ── 4. #5463: a vote saved elsewhere marks the kept feed and the counts ─

test('#5463: a vote saved elsewhere takes the card down at once, open or not', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore, publishVoteSaved } = mod;
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const answers = new Map();
    global.fetch = async (url) => answers.get(url) || { ok: false, json: async () => ({}) };
    // THE READS STILL ANSWER THE PRE-VOTE COPY: the whole point is that the
    // saved vote is applied without waiting for a read that knows it.
    answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(7, 2), item(8, 2)], max: 0 }) });
    answers.set('/api/workshop/counts', { ok: true, json: async () => ({ counts: {} }) });

    await workshopController.open();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // THE VOTE IS SAVED ON THE CHANGE'S OWN PAGE, and the card does not wait
    // for a read.
    publishVoteSaved(7, 'yes', 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8], 'the card leaves the feed at once');

    // A READ ISSUED BEFORE THE VOTE AND LANDING AFTER IT does not bring it back.
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8]);
    await workshopController.reload();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8]);

    // A NEWER EPOCH PASSES: the card changed under the vote and asks again.
    answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(7, 3), item(8, 2)], max: 0 }) });
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // THE VOTE SAVED WHILE THE PAGE IS CLOSED strips the kept copy too, so
    // the first paint on return is already right.
    workshopController.close();
    workshopStore.set({ feed: [item(7, 2), item(8, 2)] });
    publishVoteSaved(8, 'yes', 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7], 'stripped while closed');
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── 5. #5462: the return to Communities reads fresh ────────────────────

test('#5462: re-entry asks no-cache, so a voted card stays gone after coming back', async () => {
  // The worker's boot lane answers a read whose network leg misses its
  // deadline with the saved copy; `close()` has cleared the answered set, so
  // without a fresh read the card voted while away is drawn as owed again.
  // This mock IS the worker: a boot read (no cache mode) answers the
  // PRE-VOTE copy, a `no-cache` read answers what the server holds now.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = {};
  try {
    const reads = [];
    const stale = { items: [item(7, 2), item(8, 2)], max: 0 };
    const current = { items: [item(8, 2)], max: 0 };
    global.fetch = async (url, opts) => {
      const cache = opts && opts.cache;
      reads.push([url, cache]);
      const freshNow = cache === 'no-cache';
      if (url === '/api/workshop/counts') return { ok: true, json: async () => ({ counts: {} }) };
      return { ok: true, json: async () => (freshNow ? current : stale) };
    };

    // THE FIRST ENTRY KEEPS THE BOOT LANE (#5164).
    await workshopController.open();
    assert.deepEqual(reads, [
      ['/api/workshop/counts', undefined],
      ['/api/workshop/needs-feed', undefined],
    ], 'the cold first paint keeps the worker\'s fast lane');
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // THE VOTE, then the trip back: close() drops the answered set, so the
    // re-entry cannot lean on it and has to ask the server.
    workshopController.answered(7, 2);
    workshopController.close();
    reads.length = 0;
    await workshopController.open();
    assert.deepEqual(reads, [
      ['/api/workshop/counts', 'no-cache'],
      ['/api/workshop/needs-feed', 'no-cache'],
    ], 'the re-entry reads carry no-cache');
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the voted card stays gone after the trip back');
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── #6380: the column's "Open in workshop" lands here ─────────────────
//
// The ⋯ beside the Homeroom bot's list leaves the request, change or
// decision for this tab (side-panel/controller.ts openInWorkshop), and the
// Workshop opens it in the panel beside its list as its own row would.

test('#6380: the Workshop takes the item the column left for it, and sets that page open', () => {
  assert.match(workshopTsx, /import \{ takeWorkshopPanelItem, WORKSHOP_SIDE_QUERY \} from '\.\/panel-target';/);
  // The breakpoint is the one place's now, asked by the column too.
  assert.match(workshopTsx, /const sideWide = useMediaFlag\(WORKSHOP_SIDE_QUERY\);/);
  assert.doesNotMatch(workshopTsx, /const SIDE_QUERY = /);
  // Taken only where the panel can be, and into the panel's item.
  assert.match(workshopTsx, /if \(!v\.slug \|\| tab !== 'workshop' \|\| !sideWide \|\| !pageShown\) return;\s*const slug = v\.slug;\s*void takeWorkshopPanelItem\(slug\)\.then\(\(ref\) => \{\s*if \(live && ref && slug === v\.slug\) setSideItem\(ref\);/);
  // And a page already up takes it too, a turn later, from the event.
  assert.match(workshopTsx, /window\.addEventListener\('usernode:workshop-panel-target', onTarget\);/);
  assert.match(workshopTsx, /\}, \[v\.slug, tab, sideWide, pageShown\]\);/);
  // It runs AFTER the resets that would wipe it: a page mounting straight
  // onto the stash keeps it.
  const at = workshopTsx.indexOf('takeWorkshopPanelItem(slug)');
  assert.ok(at > workshopTsx.indexOf('}, [v.slug]);\n  // A deep link'), 'after the project reset');
  assert.ok(at > workshopTsx.indexOf("}, [pageShown]);"), 'and after the page-shown reset');
});
