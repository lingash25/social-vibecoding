'use strict';

// Homeroom bot parity, P6: a check that is not the change's, worked past as a
// person would (services/homeroom-bot-flaky-checks.js), against the full
// PostgreSQL schema. GitHub's filing, the bot's queue, the sync with main, the
// recheck and the DM are stubs; the rows are real. A flaky test is filed on
// Homeroom's board once however many changes fail it; an open request that
// names a test is used instead of a new one; at most three fixes are built at
// once; the fix merging runs the waiting changes' checks again; and a change
// still red with its fix in goes to a person, with the evidence.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p6-flaky-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const flaky = require('../src/services/homeroom-bot-flaky-checks');
const { UNIT_CHECK_NAME, UNIT_CHECK_PATH } = require('../src/services/unit-suite-row');

const SLUG = 'usernode-2d5619';
const HEAD = 'a'.repeat(40);

const unitFailing = (tests) => [
  { name: 'Home loads', path: '/', status: 'pass' },
  {
    index: -3, name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, status: 'fail', advisory: false,
    failureReason: tests.map((t) => `${t.file} (1): ${t.test}`).join(' | '),
    failureDetails: tests.map((t) => ({ file: t.file, test: t.test, excerpt: `  error: '${t.error || 'Expected values to be strictly equal:'}'\n  at x` })),
  },
];

test('flaky checks: filed once, built outside the slots, and the waiting changes run their checks again once fixed', { timeout: 180000 }, async (t) => {
  const root = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.query('SELECT 1'); } catch (err) {
    await root.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_p6_${crypto.randomBytes(6).toString('hex')}`;
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await root.query(`DROP DATABASE ${name}`);
    await root.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [bot] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username");
  const { rows: [ada] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id, username");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', $1, 'running', 'https://github.com/Usernode-Labs/social-vibecoding')
     RETURNING id, slug, name, repo_url`, [SLUG]);
  const { rows: [other] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Plant pal', 'plant-pal', 'running', 'https://github.com/usernode-bot/plant-pal')
     RETURNING id, slug, name, repo_url`);
  let nextNumber = 6100;
  const request = async (title, body = '', state = 'open', where = app) => {
    const number = ++nextNumber;
    await pool.query('INSERT INTO requests (app_id, number, title, body, state) VALUES ($1, $2, $3, $4, $5)', [where.id, number, title, body, state]);
    return number;
  };
  const change = async (issue, tests, where = app) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, check_state, checks_commit_sha,
                                  reviewed_head_sha, test_results, pr_number, promoted_at)
       VALUES ($1, $2, $3, 'promoted', $4::int[], 'failing', $5, $5, $6::jsonb, $7, NOW()) RETURNING id`,
      [where.id, bot.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, [issue], HEAD, JSON.stringify(unitFailing(tests)), issue + 1000]);
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id, issue_number) DO NOTHING`, [where.id, issue, ada.id, `Request ${issue}`]);
    return { id: Number(s.id), app_id: where.id, linked_issues: [issue] };
  };

  // The stubs, and what each was asked.
  const filed = [];
  const owed = [];
  const sent = [];
  const patched = [];
  const lines = [];
  const synced = [];
  const rechecked = [];
  let messageIds = 9000;
  const syncAnswer = new Map();
  const deps = {
    bot,
    botSvc: {
      PLATFORM_SELF_APP_SLUG: SLUG,
      async platformAppSlugs() { return [SLUG]; },
      async readSettings() { return { mode: 'shadow' }; },
    },
    github: {
      isEnabled: () => true,
      async createIssue(_owner, _repo, { title, body }) {
        const number = ++nextNumber;
        await pool.query('INSERT INTO requests (app_id, number, title, body) VALUES ($1, $2, $3, $4)', [app.id, number, title, body]);
        filed.push({ number, title, body });
        return { number, title };
      },
    },
    ws: { async sendSystemMessage() { return {}; }, pushIssueUpdate() {}, pushConversationEvent() { return 1; } },
    enqueue: async (args) => { owed.push(args); return { owed: true }; },
    live: {
      isLiveFor: () => true,
      async postOnProposal(args) { lines.push({ sessionId: args.sessionId, kind: args.kind, text: args.text }); return { postId: 1, thread: true }; },
    },
    dm: {
      async requesterOf(_pool, appId, issueNumber) {
        return { userId: ada.id, username: 'ada', hasPlatformAccess: true, issueTitle: `Request ${issueNumber}`, firstVersion: false };
      },
      hasBot: () => true,
      async botAccount() { return bot; },
      async cardShown() { return null; },
      async sendDm(_pool, args) { messageIds += 1; sent.push({ ...args, messageId: messageIds }); return { messageId: messageIds, conversationId: 1 }; },
    },
    cards: { async setCardState(_pool, messageId, card) { patched.push({ messageId, card }); return true; } },
    fixedCheckSync: {
      async syncOne({ candidate, wait }) {
        synced.push({ sessionId: candidate.id, keys: candidate.keys, trigger: candidate.trigger, wait });
        return syncAnswer.get(candidate.id) || { synced: false, requested: true, why: null };
      },
    },
    stagingRecovery: { async recheckSessionChecks(args) { rechecked.push({ sessionId: Number(args.session.id), reason: args.reason }); return 'rechecked'; } },
  };
  const incidentsOf = async (sessionId) => (await pool.query(
    `SELECT metadata FROM events WHERE event_type = 'platform_incident' AND session_id = $1 ORDER BY id`, [sessionId]))
    .rows.map((r) => `${r.metadata.kind}:${r.metadata.outcome || ''}`);
  const waitOf = (sessionId) => flaky.waitOf(pool, sessionId);
  const notChange = (c) => flaky.onNotChange(pool, {}, { app, session: c, head: HEAD, failing: [{ name: UNIT_CHECK_NAME }], runId: null, syncWhy: 'already_tried', deps });

  const KUDOS = { file: 'tests/kudos.test.js', test: 'kudos are counted once' };
  const a = await change(50, [KUDOS]);
  const b = await change(51, [KUDOS]);

  await t.test('the first change red on a flaky test files it on Homeroom\'s board, as the bot, and has it built', async () => {
    const out = await notChange(a);
    assert.deepEqual(out, { carriedOn: true, acted: 'checks_flake_filed' });
    assert.equal(filed.length, 1);
    assert.equal(filed[0].title, 'Flaky check: kudos are counted once');
    assert.match(filed[0].body, /fails without the change too/);
    assert.ok(!filed[0].body.includes('Request 50'), 'nothing of the change\'s own request goes on the public board');
    const { rows: flakes } = await pool.query('SELECT * FROM homeroom_bot_flake_fixes');
    assert.equal(flakes.length, 1);
    assert.equal(flakes[0].state, 'building');
    assert.equal(flakes[0].filed, true);
    assert.equal(flakes[0].issue_number, filed[0].number);
    const { rows: [platformRow] } = await pool.query('SELECT created_by, payload FROM issues WHERE app_id = $1 AND github_issue_number = $2', [app.id, filed[0].number]);
    assert.equal(platformRow.created_by, bot.id, 'filed as the bot');
    assert.deepEqual(owed, [{ appId: app.id, issueNumber: filed[0].number, reason: flaky.FIX_REASON, db: pool, key: `flaky-fix:${flakes[0].id}` }]);
    assert.equal(await flaky.exemptFromAppCap(pool, app.id, filed[0].number), true, 'outside its project\'s slots');
    assert.equal(await flaky.exemptFromAppCap(pool, app.id, 50), false, 'and nothing else is');
    const wait = await waitOf(a.id);
    assert.equal(wait.stage, 'fixing');
    assert.deepEqual(wait.flake_ids, [flakes[0].id]);
    assert.deepEqual(await incidentsOf(a.id), ['checks_fixing_flake:filed', 'checks_fixing_flake:building']);
    // The requester's card, quietly, in the request's story.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, ada.id);
    assert.equal(sent[0].moment, null, 'it rings nothing');
    assert.equal(sent[0].metadata.card.type, 'checks_green');
    assert.equal(sent[0].metadata.card.state, 'working');
    assert.deepEqual(sent[0].metadata.card.fix, { project: SLUG, number: filed[0].number });
    assert.equal(wait.card_message_id, sent[0].messageId);
    // One line where the group votes.
    assert.deepEqual(lines.map((l) => [l.sessionId, l.kind]), [[a.id, 'checks_flake']]);
  });

  await t.test('a second change red on the same test joins that fix: never a second request', async () => {
    const out = await notChange(b);
    assert.equal(out.carriedOn, true);
    assert.equal(filed.length, 1, 'filed once');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_flake_fixes')).rows[0].n, 1);
    assert.equal(owed.length, 1, 'asked to build once');
    assert.deepEqual((await waitOf(b.id)).flake_ids, (await waitOf(a.id)).flake_ids);
    assert.deepEqual(await incidentsOf(b.id), ['checks_fixing_flake:joined']);
    // And the first one, looked at again, just waits.
    assert.deepEqual(await notChange(a), { carriedOn: true, acted: 'checks_flake_waiting' });
    assert.equal(filed.length, 1);
  });

  await t.test('an open request that already names the test is the fix, not a new one', async () => {
    const VOTE = { file: 'tests/votes.test.js', test: 'the vote button shows the count' };
    const named = await request('Vote count flickers', 'In CI, "the vote button shows the count" fails now and then.');
    const c = await change(52, [VOTE]);
    const out = await notChange(c);
    assert.deepEqual(out, { carriedOn: true, acted: 'checks_flake_found' });
    assert.equal(filed.length, 1, 'nothing filed');
    const { rows: [f] } = await pool.query('SELECT * FROM homeroom_bot_flake_fixes WHERE issue_number = $1', [named]);
    assert.equal(f.filed, false);
    assert.equal(f.state, 'building');
    assert.equal(owed.length, 2);
  });

  let waitingFlake;
  await t.test('at most three fixes are built at once: the next waits its turn', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_flake_fixes (test_key, test_name, app_id, issue_number, filed, state)
       VALUES ('tests/x.test.js::x', 'x', $1, 6099, TRUE, 'building')`, [app.id]);
    const d = await change(53, [{ file: 'tests/feed.test.js', test: 'the feed pages by cursor' }]);
    const out = await notChange(d);
    assert.equal(out.carriedOn, true);
    assert.equal(filed.length, 2, 'filed: no request named it');
    waitingFlake = (await pool.query("SELECT * FROM homeroom_bot_flake_fixes WHERE test_name = 'the feed pages by cursor'")).rows[0];
    assert.equal(waitingFlake.state, 'waiting');
    assert.equal(owed.length, 2, 'not asked to build yet');
    assert.equal(await flaky.exemptFromAppCap(pool, app.id, waitingFlake.issue_number), false, 'and not exempt until it is');
    const card = sent.at(-1).metadata.card;
    assert.ok(card.steps.some((s) => s.state === 'now' && /Waiting its turn/.test(s.what)));
  });

  await t.test('the fix merges: every change that waited on it runs its checks again, and the next fix starts', async () => {
    syncAnswer.set(b.id, { synced: false, why: 'level' });
    const kudos = (await pool.query("SELECT * FROM homeroom_bot_flake_fixes WHERE test_name = 'kudos are counted once'")).rows[0];
    const out = await flaky.fixMerged(pool, {}, { appId: app.id, issues: [kudos.issue_number], sessionId: 7777, deps });
    assert.deepEqual(out.map((o) => [o.sessionId, o.how]).sort(), [[a.id, 'synced'], [b.id, 'rechecked']].sort());
    assert.deepEqual(synced.map((s) => s.sessionId).sort(), [a.id, b.id].sort());
    assert.ok(synced.every((s) => s.trigger === 'bot_fix' && s.wait === false && s.keys[0] === `homeroom_bot:flake:${kudos.id}`));
    assert.deepEqual(rechecked, [{ sessionId: b.id, reason: 'manual-recheck' }], 'level with main: its checks run again as they are');
    const done = (await pool.query('SELECT * FROM homeroom_bot_flake_fixes WHERE id = $1', [kudos.id])).rows[0];
    assert.equal(done.state, 'merged');
    assert.equal(done.merged_session_id, 7777);
    assert.ok(done.ended_at);
    assert.equal((await waitOf(a.id)).stage, 'rechecking');
    assert.equal((await waitOf(b.id)).stage, 'rechecking');
    assert.ok(patched.some((p) => p.messageId === (sent[0].messageId) && p.card.steps.some((s) => s.state === 'now' && /with the fix/.test(s.what))));
    // A slot freed: the waiting fix starts, outside its project's slots.
    const started = (await pool.query('SELECT state FROM homeroom_bot_flake_fixes WHERE id = $1', [waitingFlake.id])).rows[0];
    assert.equal(started.state, 'building');
    assert.equal(owed.at(-1).issueNumber, waitingFlake.issue_number);
    // Merged again (the sweep after the bot's own hook): nothing twice.
    assert.deepEqual(await flaky.fixMerged(pool, {}, { appId: app.id, issues: [kudos.issue_number], deps }), []);
  });

  await t.test('green: the card says so, quietly, and the ladder ends', async () => {
    assert.equal(await flaky.noteGreen(pool, a.id, { deps }), true);
    const wait = await waitOf(a.id);
    assert.equal(wait.stage, 'green');
    assert.ok(wait.ended_at);
    const last = patched.filter((p) => p.messageId === wait.card_message_id).at(-1);
    assert.equal(last.card.state, 'green');
    assert.equal(await flaky.noteGreen(pool, a.id, { deps }), false, 'once');
    assert.ok((await incidentsOf(a.id)).includes('checks_fixing_flake:green'));
  });

  await t.test('still red with its fix in, on the same head: a person, with the evidence, and the requester hears it once', async () => {
    await pool.query("UPDATE chat_sessions SET checks_checked_at = NOW() + INTERVAL '1 second' WHERE id = $1", [b.id]);
    const before = sent.length;
    const out = await flaky.sweep(pool, {}, { deps });
    assert.ok(out && out.person >= 1, JSON.stringify(out));
    const wait = await waitOf(b.id);
    assert.equal(wait.stage, 'person');
    assert.equal(wait.why, 'still_fails');
    assert.ok((await incidentsOf(b.id)).includes('checks_not_change:'), 'admins hear it as before');
    const line = lines.filter((l) => l.sessionId === b.id).at(-1);
    assert.equal(line.kind, 'checks_not_change');
    assert.match(line.text, /asked for the check to be fixed \(#\d+\), but the fix for the failing check is in, and this change's checks still fail/);
    const rang = sent.slice(before).filter((s) => s.metadata.kind === 'needs_look');
    assert.equal(rang.length, 1, 'the end rings');
    assert.equal(rang[0].userId, ada.id);
    assert.equal(patched.filter((p) => p.messageId === wait.card_message_id).at(-1).card.state, 'person');
  });

  await t.test('off Homeroom\'s own projects, and for a fix\'s own change, it hands over as before', async () => {
    const elsewhere = await change(54, [KUDOS], other);
    assert.equal(await flaky.onNotChange(pool, {}, { app: other, session: elsewhere, head: HEAD, failing: [], deps }), null);
    const feed = (await pool.query("SELECT * FROM homeroom_bot_flake_fixes WHERE test_name = 'the feed pages by cursor'")).rows[0];
    const fixChange = await change(feed.issue_number, [{ file: 'tests/other.test.js', test: 'something else entirely here' }]);
    assert.equal(await notChange(fixChange), null, 'never a fix for a fix');
    assert.equal((await pool.query('SELECT state FROM homeroom_bot_flake_fixes WHERE id = $1', [feed.id])).rows[0].state, 'failed',
      'and the fix it was is over: its waiting changes go to a person');
  });

  await t.test('a change waiting on a fix is not withdrawn as a stale red change', async () => {
    const redChanges = require('../src/services/homeroom-bot-red-changes');
    const stale = async (issue) => {
      const c = await change(issue, [KUDOS]);
      await pool.query("UPDATE chat_sessions SET last_activity_at = NOW() - INTERVAL '4 days' WHERE id = $1", [c.id]);
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha, created_at)
         VALUES ($1, $2, 'live', 'person', $3, $4, NOW() - INTERVAL '4 days')`, [app.id, issue, c.id, HEAD]);
      return c;
    };
    const waiting = await stale(60);
    const plain = await stale(61);
    await pool.query(
      `INSERT INTO events (app_id, session_id, event_type, metadata) VALUES ($1, $2, 'platform_incident', '{"kind":"checks_fixing_flake","outcome":"filed"}')`,
      [app.id, waiting.id]);
    const archived = [];
    const out = await redChanges.sweepStaleRedChanges(pool, {
      appId: app.id,
      deps: {
        sessionLifecycle: { async archiveSession({ sessionId }) { archived.push(sessionId); return { archived: true }; } },
        ws: { async sendSystemMessage() {} },
      },
    });
    assert.ok(out.withdrawn.includes(plain.id), 'a plain stale red change still goes');
    assert.ok(!out.withdrawn.includes(waiting.id), 'one waiting on its check\'s fix stays');
  });
});
