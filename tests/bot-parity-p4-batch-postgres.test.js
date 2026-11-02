'use strict';

// Homeroom bot parity, P4: a batch's lifecycle against the full schema.
//
// work_through's table (services/homeroom-bot-batches.js propose) read from
// the bot's records, the reads it queues, its Build (start) with the starts
// stubbed, the raise it records for the project's owner, the two holds that
// read that raise (the lane's BATCH_RAISES_SQL, the proposal hold in
// homeroom-bot.js simulateCaps), and the roll-up patched onto its card.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p4-batch-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// What a card's patch tells the open tabs.
const pushes = [];
const ws = { pushConversationEvent(ids, event) { pushes.push({ ids, event }); return ids.length; }, pushToUser() { return 1; } };

test('a batch against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bp_p4_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const batches = require('../src/services/homeroom-bot-batches');
  const homeroomBot = require('../src/services/homeroom-bot');
  const loop = require('../src/workflow/rules/bot-loop.ts');
  const laneFacts = require('../src/workflow/bot-lane/facts.ts');
  const conversations = require('../src/services/conversations');

  const asKernel = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };
  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return { ...rows[0], isAdmin: false };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Gym Tracker', 'gym-tracker', 'running', $1, 'https://github.com/usernode-bot/gym-tracker', 'public', 'public') RETURNING id`,
    [ada.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  for (const u of [ada, sam]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, u.id]);
  }
  async function request(n, title, { by = ada, status = 'open' } = {}) {
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, created_by, status) VALUES ($1, $2, $3, $4, $5)`,
      [app.id, n, title, by.id, status],
    );
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, $4)',
      [app.id, n, by.id, title],
    );
  }
  // A run as the bot records one: a ready verdict is held by a limit, or its
  // build failed, or it waits its turn (`waiting`), never just ready.
  async function run(n, verdict, { daysAgo = 1, question = null, reason = null, cap = null, failed = false, waiting = false } = {}) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, question, reason, created_at, cap_suppressed,
                                     build_ok, build_error, live_build_waiting_at)
       VALUES ($1, $2, 'live', $3, $4, $5, NOW() - make_interval(days => $6), $7,
               CASE WHEN $8 THEN FALSE END, CASE WHEN $8 THEN 'could not build: the checks failed' END,
               CASE WHEN $9 THEN NOW() END) RETURNING id`,
      [app.id, n, verdict, question, reason, daysAgo, cap, failed, waiting],
    );
    return r.id;
  }
  await request(1, 'Dark mode');
  await run(1, 'ready', { cap: 'proposals_per_app' });
  await request(2, 'Rest timer');
  await run(2, 'question', { question: 'Should it beep?' });
  await request(3, 'Pricing page');
  await run(3, 'person', { reason: 'The group decides prices.' });
  await request(4, 'Old export');
  await run(4, 'empty', { reason: 'It is already there.' });
  await request(5, 'Search');
  await request(6, 'Closed one', { status: 'closed' });
  await request(7, 'Stale one');
  await run(7, 'ready', { daysAgo: 20, failed: true });
  await request(8, 'Sam asked', { by: sam });
  await run(8, 'ready', { failed: true });
  await request(9, 'On its way');
  await run(9, 'ready', { waiting: true });

  // What the batch's reads and starts would have done, recorded.
  const owed = [];
  const botSvc = {
    async enqueueFront(_pool, args) { owed.push(args); return { owed: true }; },
    async readSettings() { return settings; },
  };
  const settings = { mode: 'live', perPerson: 3, pausedApps: [] };
  const deps = {
    botSvc,
    liveSvc: { isLiveFor: () => true },
    dm: { ...require('../src/services/homeroom-bot-dm'), overWeeklyAllowance: async () => false },
    ws,
  };

  // ── The table ──
  const proposed = await batches.propose(pool, {
    app, user: ada, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 99], settings, conversationId: null, deps,
  });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const reads = Object.fromEntries(proposed.rows.map((r) => [r.number, r.read]));
  assert.deepEqual(reads, { 1: 'ready', 2: 'question', 3: 'person', 4: 'done', 5: 'reading', 7: 'reading', 8: 'ready', 9: 'underway' });
  assert.equal(proposed.rows.find((r) => r.number === 1).why, 'held', 'ready, held by a limit');
  assert.deepEqual(proposed.unknown, [99]);
  assert.deepEqual(proposed.closed, [6]);
  // The reads it queued: at the front, as her, her own requests on her own time.
  assert.deepEqual(owed.map((o) => [o.issueNumber, o.reason, o.userId, o.payerId]), [[5, 'batch_read', ada.id, null], [7, 'batch_read', ada.id, null]]);
  assert.equal(proposed.card.type, 'batch');
  assert.equal(proposed.card.state, 'proposed');
  assert.equal(proposed.card.label, '8 requests · 2 ready · 1 question · 1 for the group · 1 done · 1 under way · 2 being read');
  assert.deepEqual(proposed.card.raise, { perPerson: 6, proposalsPerApp: 10, as: 'owner' });
  assert.equal(proposed.card.requests.find((r) => r.number === 2).note, 'Should it beep?');
  const { rows: [row] } = await pool.query('SELECT * FROM homeroom_bot_batches WHERE id = $1', [proposed.batchId]);
  assert.deepEqual(row.numbers, [1, 2, 3, 4, 5, 7, 8, 9]);
  assert.equal(row.state, 'proposed');
  assert.equal(row.per_person, null, 'nothing is raised before Build');

  // "Mine": her own open requests nobody has taken.
  await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 3, $2)', [app.id, sam.id]);
  const mine = await batches.requestsFor(pool, { app, user: ada, which: 'mine' });
  assert.deepEqual(mine.numbers, [1, 2, 4, 5, 7, 9], 'not the closed one, not the claimed one, not Sam\'s');
  // A member who does not run the project raises nothing.
  assert.equal(await batches.raiseFor(pool, app, sam, settings), null);

  // ── Build ──
  const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const { rows: [msg] } = await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
     VALUES ($1, $2, 'Here they are.', $3) RETURNING id`,
    [conversationId, bot.id, JSON.stringify({ homeroomBot: { kind: 'chat', card: proposed.card } })],
  );
  const message = { id: msg.id, conversationId, botId: bot.id };
  const starts = [];
  const startRequest = async (_pool, ctx, args) => {
    starts.push({ ...args, user: ctx.user.id, bot: ctx.bot.id, started: ctx.started || null });
    if (args.number === 8) return { ok: false, error: 'Only whoever asked for it, or a member, can ask you to start it.' };
    return { ok: true, queued: 'At the front of your queue.' };
  };
  const startDeps = { ...deps, startRequest, mayor: { ...require('../src/services/homeroom-bot-mayor') } };
  // Not hers: refused.
  const notHers = await batches.start(pool, {}, { batch: row, user: sam, message, deps: startDeps });
  assert.equal(notHers.status, 404);
  const started = await batches.start(pool, {}, { batch: row, user: ada, message, deps: startDeps });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(starts.map((s) => [s.project, s.number, s.user, s.bot, s.started]),
    [['gym-tracker', 1, ada.id, bot.id, null], ['gym-tracker', 8, ada.id, bot.id, null]],
    'each ready one, as start_request starts one: its own turn\'s context, as her');
  assert.equal(started.patch.state, 'running');
  assert.deepEqual(started.patch.started, [1]);
  assert.deepEqual(started.patch.refused.map((r) => r.number), [8]);
  assert.deepEqual(started.patch.raise, { perPerson: 6, proposalsPerApp: 10, as: 'owner' });
  assert.equal(started.patch.rollup.total, 1);
  const { rows: [running] } = await pool.query('SELECT *, ends_at - started_at AS span FROM homeroom_bot_batches WHERE id = $1', [row.id]);
  assert.equal(running.state, 'running');
  assert.deepEqual(running.started_numbers, [1]);
  assert.equal(running.per_person, 6);
  assert.equal(running.proposals_per_app, 10);
  assert.equal(running.message_id, msg.id);
  assert.equal(running.span.days, 3);
  // A second tap starts nothing.
  const again = await batches.start(pool, {}, { batch: running, user: ada, message, deps: startDeps });
  assert.deepEqual(again, { ok: false, status: 409, error: 'This batch has already started.' });
  const twice = await batches.start(pool, {}, { batch: row, user: ada, message, deps: startDeps });
  assert.equal(twice.status, 409, 'nor a tap that raced it');
  assert.equal(starts.length, 2);

  // ── The lane's raise: the batch's started requests, while it runs ──
  const raised = loop.raisedOf((await pool.query(laneFacts.BATCH_RAISES_SQL)).rows);
  assert.deepEqual(raised, { [`${app.id}:1`]: 6 });

  // ── The proposal hold: five of the bot's changes open on the project ──
  await asKernel(async (c) => {
    for (let i = 0; i < 5; i += 1) {
      await c.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, linked_issues)
         VALUES ($1, $2, 'promoted', $3, ARRAY[$4]::int[])`,
        [app.id, bot.id, `bot-${i}`, 100 + i],
      );
    }
  });
  const caps = (n) => homeroomBot.simulateCaps(pool, bot, app.id, 'ready', settings, n == null ? {} : { issueNumber: n });
  assert.equal(await caps(null), 'proposals_per_app', 'no request named: the ordinary hold');
  assert.equal(await caps(8), 'proposals_per_app', 'a request the batch did not start');
  assert.equal(await caps(1), null, 'the batch\'s own request goes past five');
  await asKernel(async (c) => {
    for (let i = 5; i < 10; i += 1) {
      await c.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, linked_issues)
         VALUES ($1, $2, 'promoted', $3, ARRAY[$4]::int[])`,
        [app.id, bot.id, `bot-${i}`, 100 + i],
      );
    }
  });
  assert.equal(await caps(1), 'proposals_per_app', 'but never past the batch\'s ten');

  // ── The roll-up, patched onto the card from the records ──
  pushes.length = 0;
  const refreshed = await batches.refreshBatch(pool, row.id, { deps: { ws } });
  assert.equal(refreshed.ended, false);
  const { rows: [after] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [msg.id]);
  const card = after.metadata.homeroomBot.card;
  assert.equal(card.state, 'running');
  assert.equal(card.rollup.total, 1);
  assert.deepEqual(card.progress.map((p) => p.number), [1]);
  assert.equal(card.requests.length, 8, 'the patch keeps the rest of the card');
  assert.ok(pushes.some((p) => p.event.type === 'conversation_message_updated' && p.event.messageId === msg.id));
  // Read again with nothing changed: no push.
  pushes.length = 0;
  const same = await batches.refreshBatch(pool, row.id, { deps: { ws } });
  assert.equal(same.patched, false);
  assert.equal(pushes.length, 0);

  // ── Its time is up: it ends, and so does its raise ──
  await pool.query("UPDATE homeroom_bot_batches SET ends_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [row.id]);
  const swept = await batches.sweep(pool, { ws });
  assert.deepEqual(swept, { refreshed: 1, ended: 1, patched: 1 });
  const { rows: [ended] } = await pool.query('SELECT state, ended_at FROM homeroom_bot_batches WHERE id = $1', [row.id]);
  assert.equal(ended.state, 'done');
  assert.ok(ended.ended_at);
  const { rows: [endedMsg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [msg.id]);
  assert.equal(endedMsg.metadata.homeroomBot.card.state, 'done');
  assert.deepEqual(loop.raisedOf((await pool.query(laneFacts.BATCH_RAISES_SQL)).rows), {});
  assert.equal(await batches.proposalsPerAppFor(pool, app.id, 1, 5), 5);
  assert.equal(await batches.sweep(pool, { ws }), null, 'nothing left running');

  // ── A table not built yet: a row being read says what its read found ──
  const reading = await batches.propose(pool, { app, user: ada, numbers: [5], settings, conversationId, deps });
  assert.equal(reading.card.requests[0].read, 'reading');
  await asKernel((c) => c.query("INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 5, 0, 'batch_read')", [app.id]));
  const { rows: [readingMsg] } = await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata) VALUES ($1, $2, 'Reading.', $3) RETURNING id`,
    [conversationId, bot.id, JSON.stringify({ homeroomBot: { kind: 'chat', card: reading.card } })],
  );
  assert.deepEqual(await batches.refreshBatch(pool, reading.batchId, { deps: { ws } }), { ended: false, patched: false }, 'still being read');
  assert.equal((await batches.batchRow(pool, reading.batchId)).message_id, readingMsg.id, 'its card was found, and kept');
  await asKernel((c) => c.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 5', [app.id]));
  await run(5, 'person', { reason: 'The group should pick the search engine.' });
  assert.deepEqual(await batches.refreshBatch(pool, reading.batchId, { deps: { ws } }), { ended: false, patched: true });
  const { rows: [readMsg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [readingMsg.id]);
  assert.deepEqual(readMsg.metadata.homeroomBot.card.requests.map((r) => [r.number, r.read, r.note]),
    [[5, 'person', 'The group should pick the search engine.']]);
  assert.equal(readMsg.metadata.homeroomBot.card.label, '1 request · 1 for the group');
  assert.equal(readMsg.metadata.homeroomBot.card.state, 'proposed');

  // ── A request nobody can start is a refusal of the whole tap ──
  const none = await batches.propose(pool, { app, user: ada, numbers: [2, 3], settings, deps });
  const { rows: [noneRow] } = await pool.query('SELECT * FROM homeroom_bot_batches WHERE id = $1', [none.batchId]);
  const nothing = await batches.start(pool, {}, { batch: noneRow, user: ada, message, deps: startDeps });
  assert.deepEqual(nothing, { ok: false, status: 409, error: 'None of them is ready to build right now.' });
  // An empty ask, or only closed requests, makes no batch.
  assert.equal((await batches.propose(pool, { app, user: ada, numbers: [6], settings, deps })).ok, false);
  const lee = await user('lee');
  assert.match((await batches.propose(pool, { app, user: lee, which: 'mine', settings, deps })).error, /no open requests of their own/);
  // Sam's own is his #8.
  assert.deepEqual((await batches.requestsFor(pool, { app, user: sam, which: 'mine' })).numbers, [8]);
});
