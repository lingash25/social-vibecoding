'use strict';

// Homeroom bot parity, P5: notes into a running build, against the full
// schema. A note waits on the build's run and session; the build's Stop hook
// takes it through the internal route (each note once, its card told), a
// note whose build ended first is missed (its card offering the change's
// next update), and Stop and redo stops the build as the requester or the
// project's owner and starts the request again (the stop and the queue
// stubbed here: they are the workflow's).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p5-steer-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'bot-parity-p5-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bot-parity-p5-secret';

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const pushes = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(ids, event) { pushes.push({ ids, event }); return ids.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    pushIssueUpdate() {},
  },
};

test('notes into a running build, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bp_p5_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  require('../src/db/pool').getPool = () => pool;
  let server = null;
  t.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const steer = require('../src/services/homeroom-bot-steer');
  const conversations = require('../src/services/conversations');
  const platformJwt = require('../src/services/platform-jwt');

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
  const olly = await user('olly');
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Gym Tracker', 'gym-tracker', 'running', $1, 'https://github.com/usernode-bot/gym-tracker', 'public', 'public') RETURNING id`,
    [olly.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  for (const u of [olly, ada, sam]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, u.id]);
  }
  // Ada asked for #12; the bot is building it in session `build`.
  await pool.query(
    'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 12, $2, $3)',
    [app.id, ada.id, 'Dark mode'],
  );
  let build = null;
  await asKernel(async (c) => {
    ({ rows: [build] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/homeroom_bot-12') RETURNING id`,
      [app.id, bot.id],
    ));
  });
  const { rows: [buildRun] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
     VALUES ($1, 12, 'live', 'ready', $2) RETURNING id`,
    [app.id, build.id],
  );

  // ── Who may steer, and what is under way ──
  assert.deepEqual(await steer.buildUnderWay(pool, app.id, 12), { runId: buildRun.id, sessionId: build.id, running: true });
  assert.equal(await steer.buildUnderWay(pool, app.id, 13), null);
  assert.deepEqual(await steer.maySteer(pool, { app, user: ada, issueNumber: 12 }), { ok: true, theirs: true, manages: false });
  assert.deepEqual(await steer.maySteer(pool, { app, user: olly, issueNumber: 12 }), { ok: true, theirs: false, manages: true });
  assert.deepEqual(await steer.maySteer(pool, { app, user: sam, issueNumber: 12 }), { ok: false, theirs: false, manages: false });
  assert.equal(await steer.mayStopBotBuild(pool, build.id, ada), true, 'whoever asked for it');
  assert.equal(await steer.mayStopBotBuild(pool, build.id, olly), true, 'the project\'s owner');
  assert.equal(await steer.mayStopBotBuild(pool, build.id, sam), false, 'nobody else');
  let other = null;
  await asKernel(async (c) => {
    ({ rows: [other] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/sam') RETURNING id`,
      [app.id, sam.id],
    ));
  });
  assert.equal(await steer.mayStopBotBuild(pool, other.id, olly), false, 'never a person\'s own session');

  // ── A note, taken by the build's Stop hook once ──
  const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const noteId = await steer.addNote(pool, {
    app, issueNumber: 12, build: await steer.buildUnderWay(pool, app.id, 12), user: ada, note: 'Use the brand blue for it.', conversationId,
  });
  const card = { type: 'build_note', v: 1, state: 'waiting', noteId, project: app.slug, number: 12, note: 'Use the brand blue for it.' };
  const { rows: [msg] } = await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata) VALUES ($1, $2, 'Sent.', $3) RETURNING id`,
    [conversationId, bot.id, JSON.stringify({ homeroomBot: { kind: 'chat', card } })],
  );
  // The internal route the hook calls, with the build turn's own token.
  const appServer = express();
  appServer.use(express.json());
  appServer.use(require('../src/routes/internal').internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  server = await new Promise((resolve) => { const s = appServer.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const take = (sessionId, token) => fetch(`${base}/api/internal/sessions/${sessionId}/build-notes/take`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{}',
  });
  assert.equal((await take(build.id, null)).status, 401);
  assert.equal((await take(build.id, platformJwt.signWorkerToken({ sessionId: other.id }))).status, 403, 'another session\'s token');
  assert.equal((await take(build.id, platformJwt.signIssuesReadToken({ sessionId: build.id }))).status, 401, 'a read-only token');
  pushes.length = 0;
  const first = await take(build.id, platformJwt.signWorkerToken({ sessionId: build.id }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, notes: [{ note: 'Use the brand blue for it.', by: ada.username }] });
  // An OpenRouter build's declaration token asks the same way.
  const second = await take(build.id, platformJwt.signVisibleChangesToken({ sessionId: build.id }));
  assert.deepEqual(await second.json(), { ok: true, notes: [] }, 'each note is handed over once');
  const { rows: [delivered] } = await pool.query('SELECT state, delivered_at, message_id FROM homeroom_bot_build_notes WHERE id = $1', [noteId]);
  assert.equal(delivered.state, 'delivered');
  assert.ok(delivered.delivered_at);
  assert.equal(delivered.message_id, msg.id, 'its card was found, and kept');
  const { rows: [told] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [msg.id]);
  assert.equal(told.metadata.homeroomBot.card.state, 'delivered');
  assert.equal(told.metadata.homeroomBot.card.note, 'Use the brand blue for it.', 'the rest of the card stays');
  assert.ok(pushes.some((p) => p.event.messageId === msg.id), 'every open tab is told');
  // Another build's session takes nothing of this one's.
  assert.deepEqual(await steer.takeNotes(pool, other.id), []);

  // ── A note whose build finished first is missed, and offers the change ──
  const missedId = await steer.addNote(pool, {
    app, issueNumber: 12, build: await steer.buildUnderWay(pool, app.id, 12), user: ada, note: 'And a dark header.', conversationId,
  });
  let change = null;
  await asKernel(async (c) => {
    ({ rows: [change] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name, linked_issues) VALUES ($1, $2, 'promoted', 'dev/homeroom_bot-12b', ARRAY[12]) RETURNING id`,
      [app.id, bot.id],
    ));
  });
  await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [buildRun.id, change.id]);
  assert.equal(await steer.buildUnderWay(pool, app.id, 12), null, 'built: nothing under way');
  const { rows: [missedMsg] } = await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata) VALUES ($1, $2, 'Sent.', $3) RETURNING id`,
    [conversationId, bot.id, JSON.stringify({ homeroomBot: { kind: 'chat', card: { ...card, noteId: missedId } } })],
  );
  assert.equal(await steer.settleNotes(pool, { appId: app.id }), 1);
  assert.equal(await steer.settleNotes(pool, { appId: app.id }), 0, 'once');
  const { rows: [missed] } = await pool.query('SELECT state FROM homeroom_bot_build_notes WHERE id = $1', [missedId]);
  assert.equal(missed.state, 'missed');
  const { rows: [missedCard] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [missedMsg.id]);
  assert.deepEqual([missedCard.metadata.homeroomBot.card.state, missedCard.metadata.homeroomBot.card.change], ['missed', { sessionId: change.id }]);
  // Put it in the next update: revise_proposal's path, posted as theirs.
  const revised = [];
  const reviseProposal = async (_pool, ctx, args) => { revised.push({ user: ctx.user.id, inPublic: ctx.inPublic, ...args }); return { ok: true }; };
  const row = await steer.noteRow(pool, missedId);
  const forwarded = await steer.forward(pool, {}, { row, user: ada, card: missedCard.metadata.homeroomBot.card, deps: { reviseProposal, settings: {} } });
  assert.deepEqual(forwarded, { ok: true, patch: { state: 'forwarded' } });
  assert.deepEqual(revised, [{ user: ada.id, inPublic: true, proposal: change.id, change: 'And a dark header.' }]);
  assert.equal((await steer.forward(pool, {}, { row: await steer.noteRow(pool, missedId), user: ada, deps: { reviseProposal } })).status, 409);

  // ── Stop and redo ──
  let build2 = null;
  await asKernel(async (c) => {
    ({ rows: [build2] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/homeroom_bot-14') RETURNING id`,
      [app.id, bot.id],
    ));
  });
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 14, $2)', [app.id, ada.id]);
  const { rows: [run14] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id) VALUES ($1, 14, 'live', 'ready', $2) RETURNING id`,
    [app.id, build2.id],
  );
  const offer = async (by) => steer.noteRow(pool, await steer.addNote(pool, {
    app, issueNumber: 14, build: await steer.buildUnderWay(pool, app.id, 14), user: by, note: 'Start over with a list, not a grid.',
    conversationId, kind: 'redo', state: 'offered',
  }));
  const stops = [];
  const posts = [];
  const queued = [];
  const deps = (stopped = true) => ({
    stopTurn: async (args) => { stops.push(args); return stopped ? { status: 200, body: { ok: true, stopped: true } } : null; },
    dm: { ...require('../src/services/homeroom-bot-dm'), postOnRequest: async (_pool, args) => { posts.push(args); return { ok: true }; } },
    botSvc: { enqueueFront: async (_pool, args) => { queued.push(args); return { owed: true }; } },
  });
  // A stop that does not land changes nothing.
  const failing = await offer(ada);
  const refused = await steer.redo(pool, {}, { row: failing, user: ada, deps: deps(false) });
  assert.equal(refused.status, 503);
  assert.equal((await steer.noteRow(pool, failing.id)).state, 'offered');
  assert.equal(await steer.redoAsked(pool, run14.id), false);
  assert.equal(queued.length, 0);
  // Ada's tap: stopped as her, her note on the request as hers, the request first in the queue on her own time.
  const redone = await steer.redo(pool, {}, { row: failing, user: ada, message: { id: msg.id }, deps: deps() });
  assert.deepEqual(redone, { ok: true, patch: { state: 'redone', posted: true } });
  assert.deepEqual(stops.at(-1), { sessionId: build2.id, by: ada.username });
  assert.equal(posts[0].text, 'Start over with a list, not a grid.');
  assert.deepEqual([posts[0].target.app_id, posts[0].target.issue_number], [app.id, 14]);
  assert.deepEqual(queued.map((q) => [q.issueNumber, q.reason, q.userId, q.payerId]), [[14, 'dm_redo', ada.id, null]]);
  assert.equal(await steer.redoAsked(pool, run14.id), true, 'its lost build says nothing on the request');
  assert.equal((await steer.redo(pool, {}, { row: await steer.noteRow(pool, failing.id), user: ada, deps: deps() })).status, 409, 'once');
  // Keep going: the note goes into the running build instead.
  const kept = await offer(ada);
  assert.deepEqual(await steer.keep(pool, { row: kept, user: ada }), { ok: true, patch: { state: 'waiting', kept: true } });
  assert.deepEqual((await steer.takeNotes(pool, build2.id)).map((n) => n.note), ['Start over with a list, not a grid.']);
  // The build ended before the tap: nothing to stop.
  const late = await offer(ada);
  await asKernel((c) => c.query("UPDATE chat_sessions SET status = 'archived' WHERE id = $1", [build2.id]));
  assert.deepEqual(await steer.redo(pool, {}, { row: late, user: ada, deps: deps() }), { ok: true, gone: true, patch: { state: 'gone' } });
  assert.equal((await steer.noteRow(pool, late.id)).state, 'gone');
  // A redo whose note could not be posted on the request carries it to the next build.
  await asKernel(async (c) => {
    ({ rows: [build2] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/homeroom_bot-14b') RETURNING id`,
      [app.id, bot.id],
    ));
  });
  await pool.query('UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1', [run14.id, 'lost: Stopped']);
  const { rows: [run14b] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id) VALUES ($1, 14, 'live', 'ready', $2) RETURNING id`,
    [app.id, build2.id],
  );
  const carried = await offer(olly);
  const noPost = deps();
  noPost.dm = { ...noPost.dm, postOnRequest: async () => ({ ok: false, why: 'join' }) };
  const redoneCarried = await steer.redo(pool, {}, { row: carried, user: olly, deps: noPost });
  assert.deepEqual(redoneCarried.patch, { state: 'redone', posted: false });
  assert.equal(queued.at(-1).payerId, olly.id, 'the owner redoing somebody else\'s request pays for it');
  await pool.query('UPDATE homeroom_bot_runs SET build_ok = FALSE, build_error = $2 WHERE id = $1', [run14b.id, 'lost: Stopped']);
  let build3 = null;
  await asKernel(async (c) => {
    ({ rows: [build3] } = await c.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', 'dev/homeroom_bot-14c') RETURNING id`,
      [app.id, bot.id],
    ));
  });
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id) VALUES ($1, 14, 'live', 'ready', $2)`,
    [app.id, build3.id],
  );
  assert.deepEqual((await steer.takeNotes(pool, build3.id)).map((n) => n.note), ['Start over with a list, not a grid.'],
    'the request\'s next build is handed it');
  // Somebody who may not steer is refused, and nothing stops.
  const before = stops.length;
  const samsOffer = await offer(sam);
  assert.equal((await steer.redo(pool, {}, { row: samsOffer, user: sam, deps: deps() })).status, 403);
  assert.equal(stops.length, before);
});
