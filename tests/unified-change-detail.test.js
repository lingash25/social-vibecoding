const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function context(user = { id: 42, username: 'Builder' }) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams };
  c.window = c;
  vm.createContext(c);
  for (const path of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path, 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._ghIssues = [{ number: 1993, title: 'Wait for authentication before opening previews' }];
  return c.av;
}

const failing = { id: 4073, user_id: 42, username: 'Builder', status: 'active',
  source: 'cli_handoff', proposal_state: 'failed', linked_issues: [1993],
  session_title: 'Authenticate previews', pr_title: 'Authenticate previews',
  staging_url: 'https://preview.example', check_state: 'failing',
  checks_commit_sha: 'a'.repeat(40), checks_base_sha: 'b'.repeat(40),
  test_results: [{ name: 'Preview login', path: '/preview', status: 'fail', failureReason: 'Expected app, received login' }],
  created_at: '2026-09-11T12:00:00Z' };
const row = (v, key) => v.body.details.ledger.find((r) => r.key === key);

test('underway and review share context, sections and check explanations', () => {
  const av = context();
  for (const status of ['active', 'promoted']) {
    const v = av._topicViewFor(status === 'active' ? 'session' : 'proposal', { ...failing, status });
    assert.equal(v.body.issues[0].title, av._ghIssues[0].title);
    assert.equal(v.body.issueOptions[0].title, av._ghIssues[0].title);
    assert.match(v.body.issues[0].href, /dev\/issues\/1993$/);
    assert.equal(row(v, 'checks').fails[0].reason, 'Expected app, received login');
    assert.ok(row(v, 'checks').actions.some((a) => /re-run/i.test(a.label)));
    assert.ok(v.body.testing);
    assert.equal(v.body.workspace, failing.id);
    assert.equal(v.body.build.kind, 'owner', 'the Build door is on the card');
  }
});

test('an underway change can always be submitted for review (#3173, #3043)', () => {
  // Submitting opens the vote; the merge gate requires passing checks on the
  // exact reviewed commit however the vote goes. So no check state, preview
  // state or managed-handoff state disables the button any more. The
  // managed-handoff wait was what stranded #3161 and #3163: checked, green,
  // then paused and their previews reclaimed, with "needs staging and checks
  // to finish" and nothing left running that could finish.
  const av = context();
  const action = (patch) => av._topicViewFor('session', { ...failing, ...patch })
    .card.actions.find((a) => a.key === 'propose-change');

  for (const patch of [
    {}, // failing checks, managed handoff
    { check_state: 'error' },
    { check_state: 'pending', proposal_state: 'checking' },
    { check_state: 'passing', proposal_state: 'ready' },
    { check_state: 'passing', proposal_state: 'deploying', status: 'paused', staging_url: null },
    { status: 'paused' },
    { check_state: 'passing', proposal_state: 'ready', busy: true },
    { check_state: 'passing', proposal_state: 'ready', checks_base_verdict: 'superseded' },
    { source: null, proposal_state: undefined, check_state: 'failing' },
  ]) {
    assert.equal(action(patch).disabled, false, `enabled: ${JSON.stringify(patch)}`);
    assert.equal(action(patch).label, 'Submit for review');
  }

  // Only a submission already in flight holds it, so a double click cannot
  // submit twice.
  av._changeActions.set(failing.id, 'promote');
  assert.equal(action({}).disabled, true);
  assert.equal(action({}).label, 'Submitting…');
  av._changeActions.delete(failing.id);

  const review = av._topicViewFor('proposal', { ...failing, status: 'promoted' });
  assert.equal(row(review, 'review'), undefined);
  assert.ok(review.card.actions.some((a) => a.key === 'yes'));
});

test('the Review row says what submitting now means, one sentence per condition (#3173)', () => {
  // The five blocked reasons became notes. Each still names its OWN
  // condition, because that is what lets a reader tell whether waiting
  // would change anything, and none promises a merge the gate would refuse.
  const av = context();
  const state = (patch) => av.changeSubmissionState({ ...failing, ...patch });
  const reviewRow = (patch) => row(av._topicViewFor('session', { ...failing, ...patch }), 'review');

  const cases = {
    failing: [{}, /checks are failing\. You can submit it now; it can merge only after a fix passes them/, 'warn'],
    error: [{ check_state: 'error' }, /checks could not run\. You can submit it now; it can merge only once they run and pass/, 'warn'],
    uploaded: [{ proposal_state: 'uploaded', check_state: null }, /uploaded but has not been submitted for checks yet/, 'mute'],
    draft: [{ proposal_state: 'draft', check_state: null }, /no committed changes to submit yet/, 'mute'],
    running: [{ proposal_state: 'checking', check_state: 'pending' }, /Its checks keep running, and it can merge only once they pass/, 'ok'],
    idle: [{ proposal_state: 'deploying', check_state: 'passing', staging_url: null }, /preview was closed while idle; submitting rebuilds it and runs the checks again/, 'ok'],
    ready: [{ proposal_state: 'ready', check_state: 'passing' }, /^Ready to submit for review\.$/, 'ok'],
  };
  const notes = [];
  for (const [name, [patch, note, tone]] of Object.entries(cases)) {
    const st = state(patch);
    assert.equal(st.kind, 'ready', name);
    assert.match(st.note, note, name);
    assert.equal(st.tone, tone, name);
    assert.equal(reviewRow(patch).text.join(''), st.note, `${name}: the Review row carries it`);
    assert.equal(reviewRow(patch).tone, tone, `${name}: in its tone`);
    notes.push(st.note);
  }
  assert.equal(new Set(notes).size, notes.length, 'one sentence per condition');
  for (const n of notes) assert.doesNotMatch(n, /submit anyway|will merge/i);
});

test('an ordinary session submits whatever its checks say (#2074, #3173)', () => {
  const av = context();
  const ordinary = { ...failing, source: null, proposal_state: undefined };
  for (const check_state of ['pending', null, undefined, 'passing', 'failing', 'error']) {
    assert.equal(av.changeSubmissionState({ ...ordinary, check_state, pr_number: 12 }).kind, 'ready',
      `check_state ${String(check_state)}`);
  }
  assert.equal(av.changeSubmissionState({ ...ordinary, check_state: 'passing', busy: true }).kind,
    'ready', 'and a build in flight is the same kind of not-yet');
});

test('a change with nothing committed says so, and the server refuses it (#2379, #3173)', () => {
  const av = context();
  const blank = { ...failing, source: null, proposal_state: undefined,
    pr_number: null, staging_url: null, check_state: null, test_results: [] };
  const state = (patch) => av.changeSubmissionState({ ...blank, ...patch });
  const noChanges = /no committed changes to submit yet/;

  // A brand-new session: no pull request, no preview, no check ever started.
  // The button stays enabled (#3173); the note says what the server's 409
  // will say, so the refusal is not a surprise.
  assert.equal(state({}).kind, 'ready');
  assert.match(state({}).note, noChanges);
  assert.equal(av._topicViewFor('session', blank).card.actions
    .find((a) => a.key === 'propose-change').disabled, false, 'the button is not disabled');
  // The checks ran and found the branch level with main.
  assert.match(state({ check_state: 'skipped', check_error_detail: 'branch has no commits beyond main, so there is nothing to test' }).note, noChanges);

  // Any sign that something reached the branch is not that case.
  for (const patch of [{ check_state: 'pending' }, { pr_number: 12 }, { staging_url: 'https://preview.example' },
    { check_state: 'skipped', check_error_detail: 'GitHub is not configured' }]) {
    assert.doesNotMatch(state(patch).note, noChanges, JSON.stringify(patch));
  }
  // Managed handoffs read the server's revision state; imported PRs have
  // their own contract.
  assert.match(state({ source: 'cli_handoff', proposal_state: 'draft' }).note, noChanges);
  assert.match(state({ source: 'cli_handoff', proposal_state: 'uploaded' }).note, /uploaded but has not been submitted/);
  assert.doesNotMatch(state({ source: 'imported' }).note, noChanges);
});

test('before review the author reads the spec under About this change (#2371)', () => {
  const av = context();
  const draft = { ...failing, source: null, proposal_state: undefined, pr_body: null, pr_summary_md: null,
    spec_md: '# Authenticate previews\n\nWait for the session before opening a preview.' };
  const own = av._topicViewFor('session', draft);
  assert.ok(own.body.proposalBody, 'the spec stands in for the technical details');
  assert.match(own.body.proposalBody.html, /Authenticate previews/);
  assert.match(own.body.summaryHtml, /spec this change is built from is under Technical details/);

  // A real PR body wins, and a summary is never replaced.
  const withBody = av._topicViewFor('session', { ...draft, pr_body: 'The PR body', pr_summary_md: 'Previews wait for sign-in.' });
  assert.match(withBody.body.proposalBody.html, /The PR body/);
  assert.doesNotMatch(withBody.body.summaryHtml, /spec this change/);

  // Nobody else's change, and nothing once it is up for review.
  const readerView = context({ id: 99 })._topicViewFor('session', { ...draft, shared_at: '2026-09-11' });
  assert.equal(readerView.body.proposalBody, null);
  assert.doesNotMatch(readerView.body.summaryHtml, /spec this change/);
  const promoted = av._topicViewFor('proposal', { ...draft, status: 'promoted' });
  assert.doesNotMatch(promoted.body.summaryHtml || '', /spec this change/);
});

test('readers cannot promote, sync, or open the private workspace', () => {
  const av = context({ id: 99 });
  const v = av._topicViewFor('session', { ...failing, shared_at: '2026-09-11' });
  assert.equal(v.body.workspace, null);
  assert.ok(!v.card.actions.some((a) => a.key === 'propose-change'));
  assert.ok(!v.body.details.ledger.some((r) => r.actions?.some((a) => a.key === 'sync-main')));
  assert.equal(v.body.transcript, null);
});

test('owner can sync before review, with busy and fork capabilities respected', () => {
  const av = context();
  const sync = (v) => v.body.details.ledger.flatMap((r) => r.actions || []).find((a) => a.key === 'sync-main');
  assert.ok(sync(av._topicViewFor('session', failing)));
  av._changeActions.set(failing.id, 'sync-main');
  assert.equal(sync(av._topicViewFor('session', failing)).disabled, true);
  assert.equal(sync(av._topicViewFor('session', { ...failing, source: 'imported', imported_pr_head_repo: 'someone/fork', repo_url: 'https://github.com/org/app' })), undefined);
});

test('underway freshness does not claim an automatic sync or scheduled merge is running', () => {
  const av = context();
  const v = av._topicViewFor('session', { ...failing, freshness_behind_by: 2, freshness_checked_at: failing.created_at });
  assert.equal(row(v, 'checks').label, 'Checks');
  assert.ok(v.body.details.ledger.some((r) => r.text.includes('2 commits behind main.')));
  assert.doesNotMatch(JSON.stringify(v.body.details.ledger), /automatic, now|automatic, after|retries the merge/);
});

// #2038 measures drift into the integration_* record and retired the sweep
// that kept freshness_* current, so a proposal up for vote usually has the
// first and not the second. The card used to read only the second — and
// said "not verified yet" under a merge gate that had just measured the
// proposal 3 commits behind (#2100). The Main row and the pill go through
// one reader, and that reader takes whichever measurement is newer.
test('the Main row reads the integration record when that is the measurement the gate has', () => {
  const av = context();
  const promoted = { ...failing, status: 'promoted', check_state: 'passing', proposal_state: 'ready' };
  const mainRow = (patch) => av._topicViewFor('proposal', { ...promoted, ...patch })
    .body.details.ledger.find((r) => ['main', 'behind', 'sync', 'conflict', 'mergeability'].includes(r.key));

  // Measured by the gate only: the count is reported, with the platform's
  // sync named as the next step — the same row a legacy measurement gets.
  const behind = mainRow({ integration_behind_by: 3, integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: true });
  assert.equal(behind.key, 'behind');
  assert.deepEqual(JSON.parse(JSON.stringify(behind.text)),
    [{ b: 'Syncing.', tone: 'warn' }, ' Main has moved 3 commits ahead; Homeroom is bringing this proposal up to date automatically.'],
    'what the reader needs: the platform is on it, and how far main has moved; the change page draws no chip to carry the count');
  assert.equal(behind.sub, null, 'and nobody is named under the label');
  const legacy = mainRow({ freshness_behind_by: 3, freshness_checked_at: '2026-09-14T12:42:29Z' });
  assert.deepEqual(behind.text, legacy.text, 'one measurement, one row, whichever column carried it');

  // Level with main by the same record: says so, rather than "unverified".
  const level = mainRow({ integration_behind_by: 0, integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: true });
  assert.match(level.text.join(' '), /Up to date with main/);

  // Nothing measured either way still reads as unknown, never as fine.
  const unknown = mainRow({});
  assert.match(unknown.text.join(' '), /not been verified yet/);

  // A row with both: the newer measurement wins in either direction, so a
  // live freshness patch that arrived after the record still shows through.
  const f = av._freshnessOf({
    integration_behind_by: 3, integration_measured_at: '2026-09-14T12:42:29Z',
    freshness_behind_by: 0, freshness_checked_at: '2026-09-14T12:00:00Z',
  });
  assert.equal(f.behindBy, 3, 'the gate measured after the sweep did');
  assert.equal(f.checkedAt, '2026-09-14T12:42:29Z');
  const g = av._freshnessOf({
    integration_behind_by: 3, integration_measured_at: '2026-09-14T12:00:00Z',
    freshness_behind_by: 0, freshness_checked_at: '2026-09-14T12:42:29Z',
  });
  assert.equal(g.behindBy, 0, 'a later freshness patch outranks an older record');

  // A real conflict measured by the gate carries its paths, and they are the
  // complete list — git named them, nobody estimated them.
  const c = av._freshnessOf({
    integration_measured_at: '2026-09-14T12:42:29Z', integration_merges_clean: false,
    integration_conflict_paths: ['src/a.js', 'src/b.js'],
  });
  assert.equal(c.mergeability, 'conflict');
  assert.deepEqual(c.files, ['src/a.js', 'src/b.js']);
  assert.equal(c.filesComplete, true);
});

test('private changes retain sharing controls and do not pretend to have a public discussion', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  assert.ok(av._cardMenuItems(v.card.rail.menuKey).some((a) => a.label === 'Make visible'));
  assert.match(v.body.discussion, /workspace stays private/);
});

test('actual shared component renders the entire card and escapes the issue title', () => {
  const av = context();
  av._ghIssues[0].title = '<script>issue</script>';
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const v = av._topicViewFor('session', failing);
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: failing, conversation: true }));
  // The Needs-you page: the summary, the issues line, the steps sheet (with
  // the failing check's reason behind its door), and the Discussion. The
  // Build is a pill that LEAVES this page (#2605), not a sheet on it.
  for (const label of ['Addresses', 'Where it stands', 'Discussion', 'Expected app, received login', 'Checks']) assert.ok(html.includes(label), `${label} is on the page`);
  assert.ok(html.includes('&lt;script&gt;issue&lt;/script&gt;'));
  assert.ok(!html.includes('<script>issue</script>'));
  assert.match(html, />Edit issues</, 'the owner can manage associations after creation');
  // The issue is a chip on the "Addresses" line, in the Needs-you chip's
  // accent tint: the number bold, the title after it, the issue's own page
  // behind it.
  assert.match(html, /<a href="[^"]*\/dev\/issues\/1993" class="dev-ws-chip dev-ws-chip-info dev-topic-issue" data-issue-ref="1993"[^>]*><b>#1993<\/b><span>&lt;script&gt;issue&lt;\/script&gt;<\/span><\/a>/);
  assert.match(html, /class="dev-topic-hero-issues-k">Addresses</);
  assert.doesNotMatch(html, /dev-issue-ref/, 'the event-box row is the ISSUE page\u2019s (AddressedBy), not the change page\u2019s');
  // #2193: a long title truncates instead of scrolling the page sideways.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const chipRule = css.match(/\.dev-topic-issue > span \{[^}]*\}/);
  assert.ok(chipRule, 'the issue chip\u2019s title rule exists');
  assert.match(chipRule[0], /text-overflow: ellipsis/);
  assert.match(chipRule[0], /white-space: nowrap/);
  // No tabs and no Build sheet: the Discussion is the ONE sheet under the
  // card, and the Build door is a pill that navigates to the dev session's
  // own page (#2605).
  assert.doesNotMatch(html, /role="tablist"/);
  assert.match(html, /<section class="dev-topic-sheet dev-conversation" data-change-conversation="4073" aria-label="Discussion">/);
  assert.doesNotMatch(html, /data-change-build/, 'no Build sheet under the Discussion');
  assert.doesNotMatch(html, /aria-label="Build"/);
  assert.doesNotMatch(html, /id="dc-view"/, 'the dev session is not embedded in the card page');
  assert.equal((html.match(/>Continue building</g) || []).length, 1, 'the Build door is one pill on the card');
  assert.ok(!html.includes('Open discussion'));
  assert.doesNotMatch(html, />Activity</, 'Activity is gone: the meta line carries its stamp');
});

test('issue and governance topic bodies are not rebuilt as proposals without a session', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  const previousWindow = global.window;
  global.window = { AppView: { _topicViewFor() { throw new Error('Non-session topic rebuilt as proposal'); } } };
  try {
    const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
    const html = renderToHtml(createElement(ChangeDetail, { card: v.card, body: { ...v.body, comments: true }, item: null }));
    assert.match(html, /id="dev-issue-comments"/);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('detail refresh uses the lifecycle endpoint and preserves demo context', async () => {
  const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const requests = [];
  let roster = 0;
  global.window = { AppView: { appData: { slug: 'example' }, _demoQS: () => '?demo=1',
    _invalidateVoteRoster() {}, _loadVoteRoster() { roster++; } } };
  const signal = new AbortController().signal;
  try {
    for (const status of ['active', 'paused', 'promoted', 'merging', 'merged']) {
      const session = { id: 123, status };
      const review = ['promoted', 'merging', 'merged'].includes(status);
      global.fetch = async (url, options) => {
        requests.push(url);
        assert.equal(options.signal, signal);
        return { ok: true, json: async () => review ? { proposal: session } : { session } };
      };
      assert.deepEqual(await readChangeDetail(session, true, signal), session);
      assert.equal(requests.at(-1), review ? '/api/apps/example/proposals/123?demo=1' : '/api/sessions/123/details?demo=1');
    }
    assert.equal(requests.length, 5, 'one authoritative detail request per refresh');
    assert.equal(roster, 3);
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'Unavailable' }) });
    await assert.rejects(readChangeDetail({ id: 123, status: 'active' }, true, signal), /Unavailable/);
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('Open card links use one detail route regardless of ownership or origin', () => {
  const { openHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  for (const hook of ['data-session-chip', 'data-shared-session-row', 'data-proposal-row']) {
    assert.equal(openHref('example', { attrs: { [hook]: '4073' } }), '#app/example/dev/proposals/4073');
  }
});

test('server-side change link producers use the same detail route', () => {
  for (const file of [
    'src/services/mcp-tools.js',
    'src/services/external-agent-tasks.js',
    'src/routes/proposal-handoff.js',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\/dev\/sessions\/\$\{/,
      `${file} must not turn a proposal or underway-card link into a workspace link`);
  }
});

test('declared Improve checks expect real session rows on the full change route', () => {
  const manifest = JSON.parse(fs.readFileSync('dapp.json', 'utf8'));
  const check = manifest.tests.find((item) =>
    String(item.name || '').includes('Real sessions still render beside it'));
  assert.ok(check, 'the mixed work-order/session fixture remains covered');
  assert.match(check.expectSelector, /\/dev\/proposals\//);
  assert.doesNotMatch(check.expectSelector, /\/dev\/sessions\//);
});

test('the same detail URL resolves native/imported underway work and changes lifecycle after promotion', () => {
  const av = context();
  av._mySessions = [{ ...failing }];
  av._sharedSessions = [{ ...failing, id: 4074, user_id: 99, source: 'imported', shared_at: '2026-09-11' }];
  for (const id of [4073, 4074]) {
    const item = av._findItem('proposal', id);
    assert.equal(item.id, id);
    assert.ok(row(av._topicViewFor('proposal', item), 'review'), 'underway readiness, not review voting');
  }
  av._proposals = [{ ...failing, status: 'promoted' }];
  assert.equal(av._findItem('proposal', 4073).status, 'promoted');
  assert.equal(row(av._topicViewFor('proposal', av._findItem('proposal', 4073)), 'review'), undefined);
  av._mySessions = [];
  assert.equal(av._findItem('session', 4073).status, 'promoted', 'legacy shared link still resolves');
});

test('all change routes mount the full card, leaving discussion loading to its privacy-aware tab', () => {
  const av = context();
  av._devTopic = { kind: 'proposal', id: failing.id };
  av._mySessions = [{ ...failing }];
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const calls = [];
  const c = { AppView: av, document: { getElementById: () => ({}) },
    GroupChat: { mountThread: () => calls.push('public'), unmountThread: () => calls.push('detach') } };
  av._reactDevBoard = () => ({ publishTopicHead() {}, mountChangePage: () => calls.push('change') });
  const method = source.slice(source.indexOf('  _mountTopicThread() {'), source.indexOf('\n  // Open a topic full-screen.', source.indexOf('  _mountTopicThread() {'))).trim().replace(/,$/, '');
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
  av._mySessions[0].shared_at = '2026-09-11';
  calls.length = 0;
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
});

test('the Build door distinguishes owners, published transcripts, private chats and imports', () => {
  const av = context();
  const door = (view, item) => ({ ...view._buildDoorView(item) });
  assert.deepEqual(door(av, failing), { kind: 'owner', label: 'Continue building' });
  assert.deepEqual(door(av, { ...failing, status: 'promoted' }), { kind: 'owner', label: 'Open build' });
  assert.equal(av._buildDoorView({ ...failing, source: 'imported' }), null);
  assert.equal(av._buildDoorView(null), null);
  // Somebody else's change: only an explicitly published chat is a door.
  const reader = context({ id: 99 });
  assert.equal(reader._buildDoorView(failing), null);
  assert.deepEqual(door(reader, { ...failing, transcript_shared: true }),
    { kind: 'published', label: 'Read the build' });
  assert.deepEqual(door(reader, { ...failing, transcript_shared_at: '2026-09-11' }),
    { kind: 'published', label: 'Read the build' });
  assert.equal(reader._buildDoorView({ ...failing, transcript_shared: true, source: 'imported' }), null);
  // The card's pill is built from exactly that.
  assert.equal(av._topicViewFor('session', failing).body.build.label, 'Continue building');
  assert.equal(reader._topicViewFor('session', { ...failing, transcript_shared: true }).body.build.label,
    'Read the build');
});

test('the Discussion is the only sheet a change page draws, for a reader as for its author', () => {
  const { ChangeConversation } = loadTsx('frontend/src/features/dev-board/topic/conversation.tsx');
  const av = context();
  const own = av._topicViewFor('session', failing).body;
  const other = context({ id: 99 })._topicViewFor('session', { ...failing, shared_at: '2026-09-11', transcript_shared: true }).body;
  for (const body of [own, other]) {
    const html = renderToHtml(createElement(ChangeConversation, { item: failing, body }));
    assert.match(html, /data-change-conversation="4073" aria-label="Discussion"/);
    assert.doesNotMatch(html, /data-change-build/, 'the Build sheet is gone');
    assert.doesNotMatch(html, /id="dc-view"/, 'no workspace is embedded under the discussion');
    assert.doesNotMatch(html, /data-transcript-body/, 'no published chat is embedded either');
  }
});

test('Continue building navigates to the dev session page from every surface', () => {
  const av = context();
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const method = source.slice(source.indexOf('  openChangeWorkspace(id) {'), source.indexOf('\n  /**', source.indexOf('  openChangeWorkspace(id) {'))).trim().replace(/,$/, '');
  const events = [], routes = [];
  av.openProposalSession = (id) => routes.push(id);
  // The card page used to be the one surface that kept the reader put, by
  // dispatching `change-workspace-open` when its Build sheet was mounted.
  // #2605: there is no sheet and no event — the route is the only answer.
  const c = { AppView: av, document: { querySelector: () => ({}) },
    window: { dispatchEvent: (event) => events.push(event) }, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } } };
  const open = vm.runInNewContext(`({ ${method} }).openChangeWorkspace`, c);
  open(4073);
  assert.deepEqual(events, [], 'nothing is dispatched at the page');
  assert.deepEqual(routes, [4073]);
  assert.ok(!/dispatchEvent\(new CustomEvent\('change-workspace-open'/.test(source),
    'the event has no publisher left');
});

test('an old ?conversation=workspace link lands on the dev session page', () => {
  const av = context();
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const method = source.slice(source.indexOf('  _redirectLegacyBuildLink(item) {'), source.indexOf('\n  _showExplorePill', source.indexOf('  _redirectLegacyBuildLink(item) {'))).trim().replace(/,$/, '');
  const routes = [];
  av.openChangeWorkspace = (id) => routes.push(id);
  let search = '?conversation=workspace';
  const c = { AppView: av, URLSearchParams,
    window: { get location() { return { search }; } } };
  const redirect = vm.runInNewContext(`({ ${method} })._redirectLegacyBuildLink`, c);
  assert.equal(redirect(failing), true);
  assert.deepEqual(routes, [4073]);
  // The spelling that preceded it.
  search = '?conversation=build';
  routes.length = 0;
  assert.equal(redirect(failing), true);
  assert.deepEqual(routes, [4073]);
  // Any other panel, or none, keeps the card page.
  for (const other of ['?conversation=discussion', '?conversation=activity', '']) {
    search = other;
    routes.length = 0;
    assert.equal(redirect(failing), false);
    assert.deepEqual(routes, []);
  }
  // And a change with nothing to open stays put rather than bouncing a
  // reader to a session page they cannot see.
  search = '?conversation=workspace';
  routes.length = 0;
  assert.equal(redirect({ ...failing, source: 'imported' }), false);
  const reader = context({ id: 99 });
  reader.openChangeWorkspace = (id) => routes.push(id);
  const readerRedirect = vm.runInNewContext(`({ ${method} })._redirectLegacyBuildLink`,
    { AppView: reader, URLSearchParams, window: { get location() { return { search }; } } });
  assert.equal(readerRedirect(failing), false, "somebody else's private change keeps its page");
  assert.equal(readerRedirect({ ...failing, transcript_shared: true }), true,
    'a published chat is a door, so the link follows it');
  assert.deepEqual(routes, [4073]);
});

test('the owner\u2019s underway session resolves to a body carrying its change id', () => {
  // This went through `_workshopCardBody`, the card-key adapter the Workshop's
  // in-place open used. #1884 round two sends "Open card" to the item's page
  // on both surfaces, so that adapter is gone and the claim is made where it
  // always actually lived — `_topicViewFor`, which the page itself builds
  // from.
  const av = context(); av._mySessions = [failing];
  assert.equal(av._topicViewFor('session', av._findItem('session', 4073)).body.changeId, 4073);
});


test('full card has one submission, one preview, contextual recovery and an independent More menu', () => {
  const av = context();
  const item = { ...failing, pr_url: 'https://github.com/example/app/pull/12', check_state: 'passing', proposal_state: 'ready' };
  const compact = av._mySessionCardModel(item);
  const compactMenu = av._cardMenuItems(compact.rail.menuKey);
  const v = av._topicViewFor('session', item);
  assert.equal(v.card.actions.filter((a) => a.key === 'propose-change').length, 1);
  assert.equal(v.card.actions.filter((a) => a.preview).length, 1);
  assert.equal(v.card.rail.preview, null);
  assert.equal(row(v, 'review').actions, undefined);
  const menu = av._cardMenuItems(v.card.rail.menuKey);
  assert.equal(menu.filter((a) => /GitHub/.test(a.label)).length, 1);
  assert.ok(menu.some((a) => a.label === 'Make visible'));
  assert.ok(!menu.some((a) => ['View checks', 'Re-run checks', 'Open session'].includes(a.label)));
  assert.ok(compactMenu.some((a) => a.label === 'View checks'));
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item, conversation: true }));
  assert.equal((html.match(/>Submit for review</g) || []).length, 1);
  assert.equal((html.match(/>Continue building</g) || []).length, 1, 'one Build door, the pill on the card');
  assert.doesNotMatch(html, /dev-topic-gh/);
});

test('merged card opens the live app instead of an expired preview', () => {
  const av = context();
  const v = av._topicViewFor('proposal', { ...failing, status: 'merged' });
  assert.ok(v.card.actions.some((a) => a.label === 'Open app'));
  assert.ok(!v.card.actions.some((a) => a.preview || a.key === 'propose-change'));
});


test('the change page has no panel to auto-open, and says so in its source', () => {
  // The Build sheet's auto-open rules (the author's own underway change,
  // `?conversation=workspace`, a shared session's published chat) went with
  // the sheet in #2605 — a page cannot open a panel it does not have. What
  // is left of the module is the Discussion.
  const src = fs.readFileSync('frontend/src/features/dev-board/topic/conversation.tsx', 'utf8');
  for (const gone of ['initialBuildOpen', 'initialConversationTab', 'workspaceKind',
    'addEventListener', 'data-change-build', 'dc-view', 'data-transcript-body']) {
    assert.ok(!src.includes(gone), `${gone} is gone from the conversation module`);
  }
  const mod = loadTsx('frontend/src/features/dev-board/topic/conversation.tsx');
  // #2842: `agentDoor` picks the band's existing Build / Explore spec for
  // the sheet's "work with the AI agent" line; it opens no panel.
  assert.deepEqual(Object.keys(mod).sort(), ['ChangeConversation', 'agentDoor', 'mountChangeDiscussion']);
});

test('the issue picker normalizes, searches and ranks the local issue catalog', () => {
  const { normalizeLinkedIssues, parseExactIssueNumber, filterIssueOptions } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.deepEqual(normalizeLinkedIssues([27, 12, 27, 0, Number.NaN]), [12, 27]);
  assert.deepEqual(parseExactIssueNumber('#27'), { issue: 27, error: '' });
  assert.deepEqual(parseExactIssueNumber('authentication'), { issue: null, error: '' });
  assert.match(parseExactIssueNumber('2147483648').error, /too large/);

  const options = [
    { n: 91, title: 'Preview authentication', href: '#91' },
    { n: 19, title: 'Authentication status', href: '#19' },
    { n: 1993, title: 'Wait for authentication before opening previews', href: '#1993' },
    { n: 199, title: 'Unrelated', href: '#199' },
  ];
  assert.deepEqual(filterIssueOptions('auth', options, []).map((issue) => issue.n), [19, 91, 1993],
    'title prefix sorts ahead of a title-body match');
  assert.deepEqual(filterIssueOptions('#19', options, [19]).map((issue) => issue.n), [199, 1993],
    'selected issues are excluded and number-prefix matches remain ranked');
  assert.deepEqual(filterIssueOptions('', options, []), [], 'an empty search never opens a giant list');
});

test('the issue picker computes bounded add/remove deltas for the existing PATCH route', () => {
  const { linkedIssueDelta } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.deepEqual(linkedIssueDelta([12, 27, 44], [27, 50, 50]), {
    addIssues: [50], removeIssues: [12, 44],
  });

  const src = fs.readFileSync('frontend/src/features/dev-board/topic/topic-head.tsx', 'utf8');
  assert.match(src, /Search by number or title/);
  assert.match(src, /aria-label={`Remove #\$\{issue\.n}: \$\{issue\.title}`}/);
  assert.match(src, /event\.key === 'Escape'/);
  assert.match(src, /if \(suggestions\[0\]\) addIssue/);
  assert.match(src, /disabled=\{saving \|\| !changed\}/);
  assert.match(src, /JSON\.stringify\(\{ addIssues, removeIssues \}\)/);
});

test('an unlinked owner gets the empty editor affordance while a reader sees no empty aside', () => {
  const av = context();
  const item = { ...failing, linked_issues: [] };
  const v = av._topicViewFor('session', item);
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item, conversation: true }));
  assert.match(html, /No issues linked yet/);
  assert.match(html, />Add issue</);

  const reader = context({ id: 99 });
  const readView = reader._topicViewFor('session', item);
  const readHtml = renderToHtml(createElement(ChangeDetail, {
    ...readView, item, conversation: true,
  }));
  assert.doesNotMatch(readHtml, /No issues linked yet|Issues this change addresses|Edit issues/);
});

test('imported underway PR archive is owner-only and works from compact and full cards', async () => {
  const item = { ...failing, source: 'imported', pr_number: 17, pr_title: 'Imported work' };
  const av = context();
  const calls = [];
  av._archiveSession = async (...args) => { calls.push(args); return true; };
  av._loadDevFeed = async () => calls.push('refresh');
  av._renderTopicHead = () => calls.push('head');
  for (const status of ['active', 'paused']) {
    const current = { ...item, status };
    for (const card of [av._mySessionCardModel(current), av._topicViewFor('session', current).card]) {
      const actions = av._cardMenuItems(card.rail.menuKey).filter((a) => a.icon === 'archive');
      assert.equal(actions.length, 1);
      assert.equal(actions[0].label, 'Archive PR');
      await actions[0].act();
    }
  }
  assert.deepEqual(calls[0], [item.id, 'Imported work', true]);
  assert.equal(calls.filter((x) => x === 'refresh').length, 4);
  const other = context({ id: 99 });
  const readOnly = context(); readOnly.appData.can_collaborate = false;
  for (const viewer of [other, readOnly]) {
    const v = viewer._topicViewFor('session', item);
    assert.ok(!viewer._cardMenuItems(v.card.rail.menuKey).some((a) => a.icon === 'archive'));
  }
});

// QA 2026-09-24: "Up to date with main." followed, on the next line, by "The
// author must update this branch in their fork, then push the changes." The
// fork line went under every fork proposal's Main row, whatever the row said.
test('the fork instruction appears only when the fork actually needs updating', () => {
  const av = context();
  const fork = { ...failing, status: 'promoted', source: 'imported', check_state: 'passing',
    proposal_state: 'ready', imported_pr_head_repo: 'someone/fork', repo_url: 'https://github.com/org/app' };
  const footOf = (v) => {
    const main = v.body.details.ledger.find((r) => ['sync', 'behind', 'conflict', 'mergeability', 'main'].includes(r.key));
    return (main.foot || []).filter(Array.isArray).map((f) => f.map((x) => (typeof x === 'string' ? x : x.b)).join('')).join(' ');
  };
  const current = av._topicViewFor('proposal', { ...fork, freshness_behind_by: 0, freshness_checked_at: failing.created_at });
  assert.ok(current.body.details.ledger.some((r) => r.text.includes('Up to date with main.')));
  assert.doesNotMatch(footOf(current), /must update this branch/, 'an up-to-date fork is not told to update');
  const behind = av._topicViewFor('proposal', { ...fork, freshness_behind_by: 3, freshness_checked_at: failing.created_at });
  assert.match(footOf(behind), /must update this branch in their fork/, 'a fork that is behind still is');
});
