'use strict';

// Homeroom bot parity, P6: a red check that is not the change's, worked past
// as a person would (services/homeroom-bot-flaky-checks.js). The pure pieces
// (which test failed, the ladder's next step, the request filed, the card),
// and runChecksFix driven down the not_change path on Homeroom's own change
// with the ladder stubbed: where it is asked, and what is handed over when
// it cannot carry on.
//
// Run with: node --test tests/bot-parity-p6-ladder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const flaky = require('../src/services/homeroom-bot-flaky-checks');
const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const { UNIT_CHECK_NAME, UNIT_CHECK_PATH } = require('../src/services/unit-suite-row');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const EM = String.fromCharCode(0x2014);

const unitRow = (details, extra = {}) => ({
  index: -3, name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, status: 'fail', advisory: false,
  failureReason: 'tests/kudos.test.js (1): kudos are counted once', ...(details ? { failureDetails: details } : {}), ...extra,
});

// ── Which test failed ───────────────────────────────────────────────────

test('the failing tests are read off the check output: the unit suite\'s own tests, and any other blocking check', () => {
  const rows = [
    { name: 'Home loads', path: '/', status: 'pass' },
    unitRow([{ file: 'tests/kudos.test.js', test: 'kudos are counted once', excerpt: `Failing subtests (1): once\n${EM} once ${EM}\n  error: 'Expected values to be strictly equal:'\n  at Object.<anonymous>` }]),
    { name: 'Unit suite (advisory)', status: 'fail', advisory: true, failureReason: 'not graduated' },
    { name: 'Vote button shows the count', path: '/#vote', status: 'fail', failureReason: 'locator.click: Timeout 5000ms exceeded.\nwaiting for button' },
  ];
  const tests = flaky.identifyTests(rows);
  assert.deepEqual(tests, [
    { name: 'kudos are counted once', file: 'tests/kudos.test.js', error: 'Expected values to be strictly equal:' },
    { name: 'Vote button shows the count', file: '/#vote', error: 'locator.click: Timeout 5000ms exceeded.' },
  ]);
  for (const t of tests) assert.ok(!t.error.includes(EM), 'no em dash in what is quoted');
  // Names only, when the run kept no excerpts.
  assert.deepEqual(flaky.identifyTests([unitRow(null)]), [{ name: 'kudos are counted once', file: 'tests/kudos.test.js', error: '' }]);
  // A suite that never ran names no test; JSON text is read too.
  assert.deepEqual(flaky.identifyTests(JSON.stringify([unitRow(null, { couldNotRun: true })])), []);
  // One more than the most it takes on, to say there were too many.
  const many = flaky.identifyTests([unitRow([1, 2, 3, 4, 5].map((n) => ({ file: 'tests/a.test.js', test: `test ${n}`, excerpt: 'error: x' })))]);
  assert.equal(many.length, flaky.MAX_TESTS + 1);
});

test('a test is the same test however it was reported', () => {
  assert.equal(flaky.testKey({ file: 'tests/A.test.js', name: '  kudos   are counted once ' }), flaky.testKey({ file: 'tests/a.test.js', name: 'Kudos are counted once' }));
  assert.ok(flaky.sameTests([{ name: 'x', file: 'f' }], [{ name: 'X', file: 'F' }, { name: 'y' }]));
  assert.ok(!flaky.sameTests([{ name: 'z' }], [{ name: 'x' }]));
  assert.ok(!flaky.sameTests([], [{ name: 'x' }]), 'nothing failing is not the same failure');
});

// ── The ladder ──────────────────────────────────────────────────────────

test('the ladder: as before off Homeroom, a fix to find or file, a wait while it is fixed, and a person only once it runs out', () => {
  const t1 = { name: 'kudos are counted once', file: 'tests/kudos.test.js' };
  const now = Date.parse('2026-11-01T12:00:00Z');
  const started = '2026-10-31T12:00:00Z';
  assert.deepEqual(flaky.nextStep({ platform: false, tests: [t1] }), { do: 'as_today', why: 'not_platform' });
  assert.deepEqual(flaky.nextStep({ ownFix: true, tests: [t1] }), { do: 'as_today', why: 'own_fix' }, 'never a fix for a fix');
  assert.deepEqual(flaky.nextStep({ tests: [t1], now }), { do: 'fix', tests: [t1] });
  assert.deepEqual(flaky.nextStep({ wait: { stage: 'synced', started_at: started }, tests: [t1], now }), { do: 'fix', tests: [t1] },
    'synced and still failing: step 2');
  assert.deepEqual(flaky.nextStep({ tests: [], now }), { do: 'person', why: 'no_test' });
  assert.deepEqual(flaky.nextStep({ tests: [t1, t1, t1], now }), { do: 'person', why: 'too_many' });
  assert.deepEqual(flaky.nextStep({ wait: { stage: 'fixing', started_at: started }, flakes: [{ state: 'building' }], tests: [t1], now }), { do: 'wait' });
  assert.deepEqual(flaky.nextStep({ wait: { stage: 'fixing', started_at: started }, flakes: [{ state: 'failed' }], tests: [t1], now }),
    { do: 'person', why: 'fix_failed' });
  assert.deepEqual(flaky.nextStep({ wait: { stage: 'rechecking', started_at: started }, flakes: [{ state: 'merged' }], tests: [t1], now }),
    { do: 'person', why: 'still_fails' }, 'its fix is in and it still fails');
  assert.deepEqual(flaky.nextStep({ wait: { stage: 'fixing', started_at: '2026-10-28T11:00:00Z' }, flakes: [{ state: 'building' }], tests: [t1], now }),
    { do: 'person', why: 'too_long' }, `after ${flaky.WAIT_DAYS} days`);
  for (const why of ['no_test', 'too_many', 'still_fails', 'fix_failed', 'fix_closed', 'fix_expired', 'too_long', 'not_live', 'no_board']) {
    assert.ok(!flaky.personWhy(why).includes(EM));
    assert.notEqual(flaky.personWhy(why), flaky.personWhy('?'), `${why} has words of its own`);
  }
});

test('the request it files says only what the platform\'s own check said, and finds itself again', () => {
  const t1 = { name: 'kudos are counted once', file: 'tests/kudos.test.js', error: 'Expected values to be strictly equal:' };
  assert.equal(flaky.flakeTitle(t1), 'Flaky check: kudos are counted once');
  const body = flaky.flakeBody(t1);
  assert.match(body, /The check "kudos are counted once" \(tests\/kudos\.test\.js\) failed on a change of Homeroom bot's that does not touch it/);
  assert.match(body, /it fails without the change too/);
  assert.match(body, / {4}Expected values to be strictly equal:/);
  assert.match(body, /Do not loosen it, skip it or delete it\./);
  assert.ok(body.includes(flaky.flakeMarker(t1)));
  assert.equal(flaky.flakeMarker(t1), flaky.flakeMarker({ name: 'Kudos are counted once ', file: 'tests/KUDOS.test.js' }));
  assert.ok(!body.includes(EM));
  assert.ok(flaky.flakeTitle({ name: 'x'.repeat(400) }).length <= 200);
});

// ── The card ────────────────────────────────────────────────────────────

const CHANGE = { id: 5001, slug: 'usernode-2d5619', pr_number: 6120 };

test('the card follows it: synced, then the fix, then green; or the person it ends with', () => {
  const synced = flaky.cardFor({ wait: { stage: 'synced', synced: true }, change: CHANGE, platformSlug: 'usernode-2d5619' });
  assert.equal(synced.type, 'checks_green');
  assert.equal(synced.state, 'working');
  assert.deepEqual(synced.steps.map((s) => s.state), ['now', 'todo']);
  assert.deepEqual(synced.change, { project: 'usernode-2d5619', sessionId: 5001, prNumber: 6120 });
  assert.equal(synced.fix, undefined);

  const flakes = [{ issue_number: 6131, filed: true, test_name: 'kudos are counted once', state: 'building', project: 'usernode-2d5619', fixSessionId: 7002, fixPrNumber: 6133 }];
  const wait = { stage: 'fixing', synced: true, tests: [{ name: 'kudos are counted once' }] };
  const fixing = flaky.cardFor({ wait, flakes, change: CHANGE, platformSlug: 'usernode-2d5619' });
  assert.equal(fixing.state, 'working');
  assert.deepEqual(fixing.steps.map((s) => [s.state, s.what]), [
    ['done', 'Brought it up to date with main: the check still failed'],
    ['done', 'Found the failing check: "kudos are counted once". It fails without this change too'],
    ['done', 'Filed it on Homeroom\'s board: "Flaky check: kudos are counted once"'],
    ['now', 'Fixing #6131: the fix goes to a vote on Homeroom'],
    ['todo', 'Run this change\'s checks again once the fix is in'],
  ]);
  assert.deepEqual(fixing.steps[2].request, { project: 'usernode-2d5619', number: 6131 });
  assert.deepEqual(fixing.fix, { project: 'usernode-2d5619', number: 6131, sessionId: 7002, prNumber: 6133 });

  const green = flaky.cardFor({ wait: { ...wait, stage: 'green' }, flakes: [{ ...flakes[0], state: 'merged' }], change: CHANGE, platformSlug: 'usernode-2d5619' });
  assert.equal(green.state, 'green');
  assert.ok(green.steps.every((s) => s.state === 'done'), 'nothing left under way');
  assert.equal(green.steps.at(-1).what, 'Its checks pass now: it carries on to its vote');

  const person = flaky.cardFor({ wait: { ...wait, stage: 'person', why: 'fix_failed' }, flakes: [{ ...flakes[0], state: 'failed' }], change: CHANGE, platformSlug: 'usernode-2d5619' });
  assert.equal(person.state, 'person');
  assert.equal(person.steps.at(-1).state, 'failed');
  assert.match(person.steps.at(-1).what, /^A person needs to look at it: the fix for the failing check did not go through$/);
  assert.ok(!person.steps.some((s) => s.state === 'todo' || s.state === 'now'));

  const found = flaky.cardFor({ wait: { stage: 'fixing', synced: false, tests: [] }, flakes: [{ ...flakes[0], filed: false, state: 'waiting' }], change: CHANGE, platformSlug: 'usernode-2d5619', syncWhy: 'level' });
  assert.deepEqual(found.steps.map((s) => s.what).slice(0, 3), [
    'It was already up to date with main',
    'Found it on Homeroom\'s board already: #6131',
    'Waiting its turn: other checks like it are being fixed first',
  ]);
  for (const card of [synced, fixing, green, person, found]) {
    for (const s of card.steps) assert.ok(!s.what.includes(EM), s.what);
  }
});

test('what the change\'s own discussion hears, with what was tried', () => {
  assert.equal(flaky.fixingText({ flakes: [{ issue_number: 6131 }] }),
    'This change\'s failing check fails without it too, so I\'m getting the check itself fixed (request #6131 on Homeroom\'s board). Its checks run again once that fix is in, and the votes it has keep counting.');
  assert.equal(flaky.personText({ wait: { synced: true }, flakes: [{ issue_number: 6131 }], why: 'still_fails', failingCount: 1 }),
    'The failing check on this change isn\'t caused by it: it fails without it too. I brought it up to date with main and asked for the check to be fixed (#6131), but the fix for the failing check is in, and this change\'s checks still fail. I\'ve flagged it to Homeroom\'s admins, who look after the checks.');
  assert.match(flaky.personText({ why: 'no_test', failingCount: 2 }), /they fail without it too\. I couldn't tell which check fails/);
});

// ── Where it is wired ───────────────────────────────────────────────────

test('runChecksFix asks the ladder where a not_change hand-off was, and the slots, the sweep and a merge read it', () => {
  const src = read('src/services/homeroom-bot.js');
  const fix = src.slice(src.indexOf('async function runChecksFix('), src.indexOf('function checksRetryError('));
  assert.match(fix, /flakyChecks\(deps\)\.onNotChange\(pool, config, \{\n\s+app, session, head, failing, runId, syncWhy, deps,/);
  assert.match(fix, /if \(ladder\?\.carriedOn\) \{/);
  assert.match(fix, /text: ladder\?\.text \|\| followup\.checksNotChangeText\(/);
  assert.match(fix, /flakyChecks\(deps\)\.onSynced\(pool, \{ app, session, head, failing, runId, deps \}\)/);
  // The carry-on check comes before a paid turn, after the hand-off is defined.
  const carry = fix.indexOf('.carriesOn(pool, { app, sessionId: session.id, failing, broken })');
  assert.ok(carry > fix.indexOf('const handOff = async') && carry < fix.indexOf('followup.runFollowUpTurn('));
  // The infra skip stands first, untouched.
  assert.ok(fix.indexOf('if (followup.checksLookLikeInfra(checks)) {') < fix.indexOf('flakyChecks('));
  const caps = src.slice(src.indexOf('async function simulateCaps('), src.indexOf('async function simulateCaps(') + 1600);
  assert.match(caps, /flakyChecks\(\)\.exemptFromAppCap\(pool, appId, issueNumber\)/);
  // (Merged with P4: a batch may raise the number its own requests are held at, perApp.)
  assert.match(caps, /if \(!exempt && await openBotProposalCount\(pool, bot, appId\) >= perApp\) return 'proposals_per_app';/);
  assert.match(caps, /if \(await openBotProposalTotal\(pool, bot\) >= botProposalCeiling\(settings\)\) return 'proposals_total';/,
    'the bot-wide ceiling still holds');
  assert.equal((src.match(/simulateCaps\(pool, bot, app\.id, [^)]*, settings, \{ issueNumber \}\)/g) || []).length, 3,
    'a read, a reused verdict and a plan from an early look pass the request');
  assert.match(src, /await each\('flakyChecks', \(\) => flakyChecks\(deps\)\.sweep\(pool, config, \{ deps \}\)\);/);
  assert.match(src, /await flakyChecks\(deps\)\.fixMerged\(pool, null, \{ appId, issues, sessionId: Number\(merged\.id\), deps \}\);/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /require\('\.\/homeroom-bot-flaky-checks'\)\.noteGreen\(pool, id, \{ deps \}\);/);
  const red = read('src/services/homeroom-bot-red-changes.js');
  assert.match(red, /e\.metadata->>'kind' = ANY\(\$4::text\[\]\)/);
  assert.match(red, /\[NOT_CHANGE_KIND, FLAKE_KIND\]/);
  assert.equal(require('../src/services/platform-incidents').KINDS.CHECKS_FIXING_FLAKE, flaky.INCIDENT_KIND);
});

test('a flaky check\'s fix is not held by its project\'s five slots; anything else still is', async () => {
  const slots = Array.from({ length: bot.PROPOSALS_PER_APP_CAP }, (_, i) => ({ kind: 'proposal', session_id: 100 + i }));
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM homeroom_bot_flake_fixes/.test(s)) return { rows: Number(params[1]) === 61 ? [{ '?column?': 1 }] : [] };
      if (/'proposal' AS kind/.test(s)) return { rows: slots };
      if (/COUNT\(\*\)::int AS cnt FROM chat_sessions/.test(s)) return { rows: [{ cnt: 5 }] };
      return { rows: [] };
    },
  };
  const BOT = { id: 77, username: 'homeroom_bot' };
  assert.equal(await bot.simulateCaps(pool, BOT, 1, 'ready', {}, { issueNumber: 60 }), 'proposals_per_app');
  assert.equal(await bot.simulateCaps(pool, BOT, 1, 'ready', {}, { issueNumber: 61 }), null, 'the fix is built');
  assert.equal(await bot.simulateCaps(pool, BOT, 1, 'ready', {}), 'proposals_per_app', 'no request named, no exemption');
});

// ── runChecksFix down the not_change path, on Homeroom's own change ──────

const APP = { id: 9, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', self_hosted: true };
const BOT = { id: 77, username: 'homeroom_bot' };
const HEAD = 'a'.repeat(40);
const ITEM = { id: 31, app_id: 9, issue_number: 50, priority: 1, reason: bot.CHECKS_REASON, thread_seen_at: null };
const NOT_CHANGE = { lastResultText: '```json\n{"action":"person","cause":"not_change","reply":"The kudos test fails on main too."}\n```', pushOk: true, sha: HEAD };

function harness({ ladder = null, carry = null, result = NOT_CHANGE } = {}) {
  const calls = { queries: [], exec: [], onProposal: [], posts: [], flaky: [] };
  const row = {
    id: 5001, app_id: 9, linked_issues: [50], check_state: 'failing', checks_commit_sha: HEAD, reviewed_head_sha: HEAD,
    test_results: [unitRow(null), ...Array.from({ length: 40 }, (_, i) => ({ name: `check ${i}`, path: '/', status: 'pass' }))],
    slug: APP.slug, name: APP.name, repo_url: APP.repo_url, looked: false,
  };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT id, status, pr_number FROM chat_sessions/.test(s)) return { rows: [{ id: 5001, status: 'promoted', pr_number: 82 }] };
      if (/SELECT id, thread_seen_at FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 800, thread_seen_at: null }] };
      if (/AS looked/.test(s)) return { rows: [row] };
      if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
        return { rows: [{ id: 5001, user_id: 77, app_id: 9, status: 'promoted', branch_name: 'dev/homeroom_bot-5001', pr_number: 82, reviewed_head_sha: HEAD, app_slug: APP.slug, repo_url: APP.repo_url }] };
      }
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(s)) return { rows: [{ n: 0 }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 901 }] };
      if (/FROM platform_settings/.test(s)) return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 50, title: 'Count kudos once', body: 'please', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(id, opts) { calls.exec.push({ id, opts }); return result; },
      async stopTurn() {},
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; }, estimateRequestedModelCost: () => null },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; }, async loadProposalThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), error: null, estimatedCostUsd: 0.02 }; },
    },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    domain: 'app.onhomeroom.com',
    votes: { async reconcileNativeReviewedHead() { return { enforced: true }; } },
    fixedCheckSync: {
      declinedWords: require('../src/services/fixed-check-sync').declinedWords,
      async syncBeforeFix() { return { synced: false, why: 'own_failure' }; },
      async syncBeforeHandOff() { return { synced: false, why: 'already_tried' }; },
    },
    flakyChecks: {
      async onNotChange(_pool, _config, args) { calls.flaky.push({ onNotChange: { sessionId: args.session.id, head: args.head, syncWhy: args.syncWhy, failing: args.failing.length } }); return ladder; },
      async onSynced(_pool, args) { calls.flaky.push({ onSynced: args.session.id }); return { stage: 'synced' }; },
      async carriesOn(_pool, args) { calls.flaky.push({ carriesOn: args.sessionId }); return carry; },
    },
  };
  return { pool, deps, calls };
}

async function run(t, h) {
  const saved = { post: live.post, advanceSeen: live.advanceSeen, postOnProposal: live.postOnProposal, mentionTargets: live.mentionTargets };
  t.after(() => Object.assign(live, saved));
  live.post = async (args) => { h.calls.posts.push(args); return { githubCreatedAt: '2026-10-01T12:05:00Z' }; };
  live.postOnProposal = async (args) => { h.calls.onProposal.push(args); return { postId: 1, thread: true }; };
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  h.look = bot._newLookForTests({ owner: { machine: 'bot-request', key: `request:${APP.id}:${ITEM.issue_number}`, kind: 'bot.look' } });
  return bot._runInLookForTests(h.look, () => bot.runTriage(h.pool, {}, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: { mode: 'shadow', turnSeconds: 1200, turnInputTokens: 10_000_000 }, deps: h.deps,
  }));
}

test('a fix on its way: no incident, no admins, one ladder step, and the head is looked at', async (t) => {
  const h = harness({ ladder: { carriedOn: true, acted: 'checks_flake_filed' } });
  const out = await run(t, h);
  assert.equal(out.acted, 'checks_flake_filed');
  assert.deepEqual(h.calls.flaky.map((c) => Object.keys(c)[0]), ['carriesOn', 'onNotChange']);
  assert.deepEqual(h.calls.flaky[1].onNotChange, { sessionId: 5001, head: HEAD, syncWhy: 'already_tried', failing: 1 });
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO events/.test(q.s) && /checks_not_change/.test(JSON.stringify(q.params))),
    'not handed to admins');
  assert.deepEqual(h.calls.onProposal, [], 'the ladder says its own line');
  assert.equal(h.calls.posts.length, 0);
  assert.ok(h.calls.queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'the run that looked is recorded');
});

test('the ladder ran out: handed over as before, with what was tried', async (t) => {
  const h = harness({ ladder: { person: true, why: 'no_test', text: 'The failing check on this change isn\'t caused by it. I tried things.' } });
  const out = await run(t, h);
  assert.equal(out.acted, 'checks_not_change');
  assert.ok(h.calls.queries.some((q) => /INSERT INTO events/.test(q.s) && /checks_not_change/.test(JSON.stringify(q.params))), 'admins hear it');
  assert.deepEqual(h.calls.onProposal.map((p) => [p.kind, p.text]), [['checks_not_change', 'The failing check on this change isn\'t caused by it. I tried things.']]);
});

test('not the ladder\'s (null): exactly as before', async (t) => {
  const h = harness({ ladder: null });
  const out = await run(t, h);
  assert.equal(out.acted, 'checks_not_change');
  assert.equal(h.calls.onProposal[0].text, followup.checksNotChangeText({ failingCount: 1 }));
});

test('the same check failing again after its sync needs no paid turn: it goes straight on', async (t) => {
  const h = harness({ carry: { why: 'The same check still fails once it is up to date with main.' }, ladder: { carriedOn: true, acted: 'checks_flake_found' } });
  const out = await run(t, h);
  assert.equal(out.acted, 'checks_flake_found');
  assert.equal(h.calls.exec.length, 0, 'no turn ran');
  assert.ok(h.calls.flaky.some((c) => c.onNotChange));
});
