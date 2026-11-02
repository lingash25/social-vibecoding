'use strict';

// #3624: the Homeroom bot's DM against the full PostgreSQL schema.
//
// What only a real database can show: the bot's DM is a direct
// conversation both people are already in (no invitation), a person who
// blocked the bot gets none, a message's metadata is the platform's alone
// and reaches a reader only on the bot's own messages, a request's question
// lands in its requester's DM with its suggested answers, an answer given
// there is posted on the request and closes the question, the weekly
// allowance is summed per requester, and a project's description is filed
// as its first-version request once it runs. #3698: the bot's post on a
// request tags its requester exactly when their DM did not reach them, so
// the news reaches them once, and never somebody who blocked the bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons: capture what the module
// hands them. handleMessage is the app-thread write a DM answer goes
// through; here it records the post and answers like the real one.
const events = [];
const threadPosts = [];
const issueUpdates = [];
const systemMessages = [];
let threadAllowed = true;
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { events.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
    pushToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    pushNotificationToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    async handleMessage(_pool, client, msg) {
      if (!threadAllowed) return { ok: false, code: 'not_collaborator' };
      threadPosts.push({ userId: client.user.id, appId: client.appId, viaBotDm: client.viaBotDm === true, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    // The bot's message in a request's thread, written as the real one
    // writes it, so a mention notification has a row to point at (#3698).
    async sendBotMessage(db, appId, { user: from, content, metadata = null, thread, msgType = 'message' }) {
      const { rows: [row] } = await db.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [appId, from.id, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref],
      );
      return { id: row.id, createdAt: row.created_at };
    },
    pushIssueUpdate(data) { issueUpdates.push(data); },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const homeroomBot = require('../src/services/homeroom-bot');

test('the Homeroom bot DM against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_dm_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  // An answer in the DM owes its request a look, by its bot-request
  // instance (its queue row the projection): the workflow runtime runs
  // here, on this database, its pipeline only (no timers, no work).
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  t.after(async () => {
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent
  // #5104: accounts start out reachable only by people they share a project
  // with, and out of searches. This file's people are strangers who write
  // to, invite and find each other, which is what it pins, so here they
  // start out open; tests/contact-privacy-postgres.test.js pins the defaults.
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone',
                                      ALTER COLUMN profile_discoverable SET DEFAULT TRUE`);
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });
  // The bot's queue is bot-request's projection: a test clears it as the
  // machines would have none (each request's instance, its pending events
  // and work, its row), written as the kernel writes.
  const forgetRequests = async (appId = null) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      const keys = appId == null ? 'request:%' : `request:${Number(appId)}:%`;
      await c.query("DELETE FROM wf_work WHERE machine = 'bot-request' AND key LIKE $1", [keys]);
      await c.query("DELETE FROM wf_events WHERE machine = 'bot-request' AND key LIKE $1 AND status = 'pending'", [keys]);
      await c.query("DELETE FROM wf_instances WHERE machine = 'bot-request' AND key LIKE $1", [keys]);
      await c.query('DELETE FROM homeroom_bot_queue WHERE $1::int IS NULL OR app_id = $1', [appId]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };

  // The bot works for anybody Homeroom has let in (homeroom-bot-dm.js
  // hasBot): each person carries it as req.user does.
  let seq = 0;
  async function user(prefix, { synthetic = false, access = true } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', $3, $2) RETURNING id, username, has_platform_access AS "hasPlatformAccess"`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic, access],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Seed swap', 'seed-swap', 'running', $1, 'https://github.com/usernode-bot/seed-swap') RETURNING *`,
    [ada.id],
  );

  await t.test('schema: the settings are seeded, and the DM index and briefs are private', async () => {
    const { rows } = await pool.query(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('homeroom_bot_dm_users', 'homeroom_bot_user_weekly_cents') ORDER BY key`,
    );
    assert.deepEqual(rows, [
      { key: 'homeroom_bot_user_weekly_cents', value: '5000' },
    ], 'the DM list is retired: the bot works for everybody let in');
    for (const table of ['homeroom_bot_dm_messages', 'homeroom_bot_first_versions', 'homeroom_bot_dm_projects']) {
      const { rows: [c] } = await pool.query(`SELECT obj_description('${table}'::regclass, 'pg_class') AS comment`);
      assert.equal(c.comment, 'staging:private', table);
    }
  });

  await t.test('the bot\'s DM opens with both people in it, once, and never for somebody who blocked it', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(opened.created, true);
    const again = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(again.conversationId, opened.conversationId, 'one DM per person');
    assert.equal(again.created, false);
    const { rows: members } = await pool.query(
      'SELECT user_id, status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
      [opened.conversationId],
    );
    assert.deepEqual(members.map((m) => m.status), ['member', 'member'], 'nobody is left invited');
    const { rows: invites } = await pool.query(
      `SELECT 1 FROM notifications WHERE conversation_id = $1 AND kind = 'conversation_invite'`, [opened.conversationId],
    );
    assert.equal(invites.length, 0, 'and nobody is asked to accept');

    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [sam.id, bot.id]);
    assert.equal(await conversations.ensureAdmittedDirect(pool, bot.id, sam.id), null, 'blocking the bot turns it off');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [sam.id]);
  });

  await t.test('a person opening a DM with the bot gets the same conversation, already open', async () => {
    const mine = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = await conversations.createDirect(pool, ada, bot.id);
    assert.equal(asked.conversationId, mine.conversationId);
    assert.deepEqual(asked.notifications, []);
  });

  await t.test('metadata is the platform\'s: written beside the input, read only on the bot\'s messages', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const fromBot = await conversations.sendMessage(pool, { id: bot.id }, conversationId, { content: 'Which colour?' }, {
      metadata: { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } },
    });
    assert.deepEqual(fromBot.message.metadata, { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } });
    assert.equal(fromBot.message.sender.bot, true, 'the bot is marked as one');
    // A request body that carries metadata (the route spreads req.body
    // into the input) writes none.
    const fromAda = await conversations.sendMessage(pool, ada, conversationId, {
      content: 'Green', metadata: { homeroomBot: { kind: 'question' } },
    });
    assert.equal(fromAda.message.metadata, undefined);
    assert.equal(fromAda.message.sender.bot, undefined);
    const { rows: [stored] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [fromAda.message.id]);
    assert.deepEqual(stored.metadata, {});
  });

  await t.test('#3707: the bot quotes the message it answers: only the person\'s own, in their DM, still there to read', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = await conversations.sendMessage(pool, ada, conversationId, { content: 'Can you sort my list?' });
    // B4: an answer to what she wrote rings as a reply.
    const answered = await dm.sendDm(pool, { bot, userId: ada.id, content: 'On it.', replyToId: asked.message.id, moment: 'reply' });
    const said = await conversations.getMessage(pool, ada, conversationId, answered.messageId);
    assert.equal(said.reply.id, asked.message.id);
    assert.equal(said.reply.content, 'Can you sort my list?');
    assert.equal(said.reply.sender.id, ada.id);
    const { rows: [bell] } = await pool.query(
      'SELECT kind, detail FROM notifications WHERE user_id = $1 AND conversation_message_id = $2', [ada.id, answered.messageId],
    );
    assert.equal(bell.kind, 'conversation_reply', 'she hears the bot replied to her, as from a person');
    assert.equal(bell.detail, 'hrbot:reply:', 'worded as the bot\'s answer');

    // Anything else is left off, never the message.
    const samDm = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const elsewhere = await conversations.sendMessage(pool, sam, samDm.conversationId, { content: 'Not Ada\'s' });
    const deleted = await conversations.sendMessage(pool, ada, conversationId, { content: 'Never mind' });
    await conversations.deleteMessage(pool, ada, conversationId, deleted.message.id);
    for (const [why, replyToId] of [
      ['a message in another conversation', elsewhere.message.id],
      ['the bot\'s own message', answered.messageId],
      ['a message she deleted', deleted.message.id],
      ['no message at all', 'x'],
    ]) {
      const sent = await dm.sendDm(pool, { bot, userId: ada.id, content: `Plain: ${why}`, replyToId });
      assert.ok(sent?.messageId, why);
      const msg = await conversations.getMessage(pool, ada, conversationId, sent.messageId);
      assert.equal(msg.content, `Plain: ${why}`, why);
      assert.equal(msg.reply, null, why);
    }
  });

  await t.test('nothing reaches a DM for somebody Homeroom has not let in yet, nor a synthetic account', async () => {
    await setting('homeroom_bot_mode', 'shadow');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 7, $2, 'Sort by date')`,
      [app.id, ada.id],
    );
    const waiting = await user('waiting', { access: false });
    const demo = await user('demo_requester', { synthetic: true });
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
         ($1, 5, $2, 'Not let in'), ($1, 6, $3, 'Synthetic')`,
      [app.id, waiting.id, demo.id],
    );
    for (const issueNumber of [5, 6]) {
      assert.equal(await dm.dmRecipient(pool, app.id, issueNumber), null, `#${issueNumber}`);
      const sent = await dm.relayIssuePost({
        pool, app, issueNumber, kind: 'question', postId: issueNumber, bot,
        dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
      });
      assert.equal(sent, null, `#${issueNumber}`);
    }
  });

  await t.test('a question reaches its requester\'s DM with the answers to tap, and an answer is posted on the request', async () => {
    assert.deepEqual(await dm.dmRecipient(pool, app.id, 7), { userId: ada.id, username: ada.username },
      'she is told in her DM, so the post on the request leaves her untagged');
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
    });
    assert.ok(sent.messageId);
    const message = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.match(message.content, /Seed swap.*request #7: Sort by date/);
    assert.match(message.content, /Newest first\?/);
    assert.deepEqual(message.metadata.homeroomBot.answers, ['Newest first', 'Oldest first']);
    assert.equal(message.metadata.homeroomBot.status, 'open');
    assert.equal(message.metadata.homeroomBot.mirrors, true, 'the reader is told answers are public');
    assert.equal(message.reply, null, 'a request filed on its page did not start in the DM: nothing to quote');

    // The same post relayed twice (a retry) sends once.
    const retry = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first'] },
    });
    assert.equal(retry.messageId, sent.messageId);

    // Ada taps "Oldest first": an ordinary message quoting the question.
    const answer = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'Oldest first', reply_to_id: sent.messageId,
    });
    threadPosts.length = 0;
    const from = events.length;
    const ack = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: answer.message });
    // #3684: the bot typed in her DM while it answered, through the same
    // audience gate as a person's typing, and stopped once the answer was out.
    const order = events.slice(from).filter((e) => e.payload.conversationId === sent.conversationId)
      .map((e) => (e.payload.type === 'conversation_typing' ? `typing:${e.payload.typing}` : e.payload.type));
    assert.equal(order[0], 'typing:true');
    assert.equal(order.at(-1), 'typing:false');
    assert.ok(order.lastIndexOf('conversation_message_created') < order.indexOf('typing:false'), 'stopped after the answer');
    const typed = events.slice(from).find((e) => e.payload.type === 'conversation_typing');
    assert.equal(typed.payload.userId, bot.id);
    assert.ok(typed.memberIds.includes(ada.id), 'to her');
    assert.equal(threadPosts.length, 1, 'posted on the request');
    assert.equal(threadPosts[0].userId, ada.id, 'as her own message');
    assert.deepEqual(threadPosts[0].msg.thread, { type: 'issue', ref: 7 });
    assert.match(threadPosts[0].msg.content, /^Oldest first\n\n\(Answered in a chat with Homeroom bot\.\)$/);
    const after = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.equal(after.metadata.homeroomBot.status, 'answered');
    assert.equal(after.metadata.homeroomBot.answer, 'Oldest first');
    const thanks = await conversations.getMessage(pool, ada, sent.conversationId, ack.messageId);
    assert.match(thanks.content, /public discussion/, 'and the bot says where it went');
    assert.equal(thanks.reply.id, answer.message.id, 'quoting the answer it took');
  });

  // #6019: this chat is private. An answer she TYPES is drafted under the
  // bot's reply, and goes on the request only when she taps Post it; a
  // suggested answer tapped (above) is posted at once, the tap being her
  // choice to.
  await t.test('#6019: a typed answer waits under the reply for Post it, and Post it posts it, once', async () => {
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 60191, bot,
      dm: { question: 'Which date, created or edited?', answers: ['Created', 'Edited'] },
    });
    const typed = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'whichever was changed last', reply_to_id: sent.messageId,
    });
    threadPosts.length = 0;
    const draft = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: typed.message });
    assert.equal(threadPosts.length, 0, 'nothing is public before the tap');
    const card = await conversations.getMessage(pool, ada, sent.conversationId, draft.messageId);
    assert.deepEqual(card.metadata.homeroomBot.answers, ['Post it', 'Keep it private']);
    assert.equal(card.metadata.homeroomBot.status, 'open');
    assert.match(card.content, /^This chat is private\. Want me to post this on request #7's public discussion, as you\?\n\n\*\*Seed swap\*\* · request #7:\n\n> whichever was changed last$/);
    assert.equal((await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId)).metadata.homeroomBot.status, 'open',
      'the question is still open: nothing answered it yet');
    const mayor = require('../src/services/homeroom-bot-mayor');
    const settings = await require('../src/services/homeroom-bot').readSettings(pool);
    // Post it posts as she would in the request's discussion: as a member.
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) SELECT community_id, $2 FROM apps WHERE id = $1 ON CONFLICT DO NOTHING',
      [app.id, ada.id],
    );
    const tap = async () => mayor.decideOffer(pool, {}, {
      bot, user: ada, settings, deps: {},
      message: (await conversations.sendMessage(pool, ada, sent.conversationId, { content: 'Post it', reply_to_id: draft.messageId })).message,
    });
    await tap();
    assert.equal(threadPosts.length, 1, 'posted on the request');
    assert.equal(threadPosts[0].userId, ada.id, 'as her own message');
    assert.match(threadPosts[0].msg.content, /^whichever was changed last\n\n\(Answered in a chat with Homeroom bot\.\)$/);
    assert.equal((await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId)).metadata.homeroomBot.status, 'answered',
      'and it answers the question it was written under');
    await tap();
    assert.equal(threadPosts.length, 1, 'decided once');
  });

  await t.test('the verdicts export says whether a run\'s question reached the DM, and whether it was answered there', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 8, $2, 'Dark mode')`,
      [app.id, ada.id],
    );
    const { rows: [asked] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, question, question_answers)
       VALUES ($1, 8, 'live', 'question', 'Follow the system setting?', $2) RETURNING id`,
      [app.id, JSON.stringify(['Follow the system', 'Always dark', 'A toggle'])],
    );
    const { rows: [quiet] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, question, question_answers)
       VALUES ($1, 8, 'live', 'question', 'Which page?', $2) RETURNING id`,
      [app.id, JSON.stringify(['Home'])],
    );
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 8, kind: 'question', runId: asked.id, postId: 81, bot,
      dm: { question: 'Follow the system setting?', answers: ['Follow the system', 'Always dark', 'A toggle'] },
    });
    const exported = async () => {
      const rows = [];
      for await (const chunk of homeroomBot.iterateRunsForExport(pool, { app: app.slug })) rows.push(...chunk);
      const cols = homeroomBot.EXPORT_COLUMNS;
      const pick = (id, col) => homeroomBot.exportRow(rows.find((r) => r.id === id))[cols.indexOf(col)];
      return { pick };
    };
    let { pick } = await exported();
    assert.equal(pick(asked.id, 'question_answers'), 'Follow the system | Always dark | A toggle');
    assert.match(pick(asked.id, 'dm_sent_at'), /^\d{4}-\d\d-\d\dT/, 'sent to her DM');
    assert.equal(pick(asked.id, 'dm_answered_at'), '', 'not answered yet');
    assert.equal(pick(quiet.id, 'dm_sent_at'), '', 'a run whose news never reached a DM');
    assert.equal(pick(quiet.id, 'question_answers'), 'Home');

    const answer = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'Always dark', reply_to_id: sent.messageId,
    });
    await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: answer.message });
    ({ pick } = await exported());
    assert.match(pick(asked.id, 'dm_answered_at'), /^\d{4}-\d\d-\d\dT/, 'answered from the DM');
    const cols = homeroomBot.EXPORT_COLUMNS;
    assert.ok(cols.indexOf('question_answers') > cols.indexOf('build_session_id'), 'appended after every older column');
  });

  // #3624 stage 2: with the model on (the default), a message that does not
  // quote the bot is read by it (homeroom-bot-mayor-postgres.test.js). These
  // two are the stage-1 path, which the switch below still gives.
  await t.test('newer news on a request closes its open question; a reply with nothing open gets the help', async () => {
    await setting('homeroom_bot_dm_chat', 'off');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 3, bot, dm: { question: 'Show dates?', answers: ['Yes'] },
    });
    await dm.relayIssuePost({ pool, app, issueNumber: 7, kind: 'spec', postId: 4, bot, dm: { building: true } });
    const closed = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(closed.metadata.homeroomBot.status, 'closed');
    const hello = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'hello?' });
    threadPosts.length = 0;
    const help = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: hello.message });
    assert.equal(threadPosts.length, 0, 'nothing is posted on a request');
    const text = await conversations.getMessage(pool, ada, asked.conversationId, help.messageId);
    assert.equal(text.content, dm.HELP_TEXT);
    assert.equal(text.reply.id, hello.message.id);
  });

  await t.test('with the model on, free text goes to it; a reply quoting a question still goes to the request', async () => {
    await setting('homeroom_bot_dm_chat', 'on');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 31, bot, dm: { question: 'Font?', answers: ['Serif'] },
    });
    const turns = [];
    const mayor = {
      async decideOffer() { return null; },
      async runDmTurn(_pool, _config, args) { turns.push(args.message.content); return { model: true }; },
    };
    const free = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'what are you working on?' });
    threadPosts.length = 0;
    assert.deepEqual(await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: free.message, deps: { mayor } }), { model: true });
    assert.deepEqual(turns, ['what are you working on?']);
    assert.equal(threadPosts.length, 0, 'a question to the bot is not posted on a request as an answer');
    const quoting = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'Serif', reply_to_id: asked.messageId });
    await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: quoting.message, deps: { mayor } });
    assert.deepEqual(turns, ['what are you working on?'], 'a tapped answer never waits on the model');
    assert.equal(threadPosts.length, 1);
    const { rows: [queued] } = await pool.query(
      'SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7', [app.id],
    );
    assert.deepEqual(queued, { priority: 0, reason: 'dm_answer' }, 'an answer puts its request at the front of the queue');
    await forgetRequests(app.id);
  });

  await t.test('an answer the request cannot take (not a member) is said, and the question stays open', async () => {
    await setting('homeroom_bot_dm_chat', 'off');
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 5, bot, dm: { question: 'Colour?', answers: ['Green'] },
    });
    const reply = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'Green' });
    threadAllowed = false;
    try {
      const said = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: reply.message });
      const text = await conversations.getMessage(pool, ada, asked.conversationId, said.messageId);
      assert.match(text.content, /couldn't post that/);
      assert.equal(text.reply.id, reply.message.id);
    } finally {
      threadAllowed = true;
    }
    const still = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(still.metadata.homeroomBot.status, 'open');
    await setting('homeroom_bot_dm_chat', 'on');
  });

  await t.test('the weekly building time sums the runs each person pays for this week', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd)
       VALUES ($1, 7, 'live', 'ready', 0.40, 12.10), ($1, 7, 'live', 'question', 0.50, NULL)`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, created_at)
       VALUES ($1, 7, 'live', 'ready', 99, NOW() - INTERVAL '14 days')`,
      [app.id],
    );
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 1300, 'last week\'s run is not counted');
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 5000 }, ada.id), false);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200 }, ada.id), true);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 0 }, ada.id), false, '0 is no cap');
    // An admin's week is the per-admin cap, in place of the per-person one.
    await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [ada.id]);
    try {
      assert.equal(await dm.weeklyCapCents(pool, { userWeeklyCents: 1200, adminWeeklyCents: 5000 }, ada.id), 5000);
      assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200, adminWeeklyCents: 5000 }, ada.id), false);
      assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 5000, adminWeeklyCents: 1200 }, ada.id), true);
      assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200, adminWeeklyCents: 0 }, ada.id), false, '0 is no cap for an admin');
      assert.equal(await dm.allowanceLow(pool, { userWeeklyCents: 5000, adminWeeklyCents: 1500 }, ada.id), true);
    } finally {
      await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [ada.id]);
    }
    assert.equal(await dm.weeklyCapCents(pool, { userWeeklyCents: 1200, adminWeeklyCents: 5000 }, ada.id), 1200);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200, adminWeeklyCents: 5000 }, ada.id), true,
      'everyone else keeps the per-person cap');
    assert.equal(await dm.weeklySpentCents(pool, sam.id), 0);

    // What the bot caused itself (a restart's look, fixing its own checks) is
    // nobody's building time; a look Sam asked for on Ada's request is his.
    const { rows: extra } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, charged, payer_user_id)
       VALUES ($1, 7, 'live', 'ready', 3.00, FALSE, NULL), ($1, 7, 'live', 'ready', 2.00, TRUE, $2)
       RETURNING id`,
      [app.id, sam.id],
    );
    // And chatting is not building: her DM's answers never count.
    const { rows: [turn] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_turns (user_id, cost_usd) VALUES ($1, 7.00) RETURNING id`,
      [ada.id],
    );
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 1300, 'unchanged: neither the free run, his run nor her chat');
    assert.equal(await dm.weeklySpentCents(pool, sam.id), 200, 'whoever asks pays');
    assert.equal(await dm.allowanceLow(pool, { userWeeklyCents: 1500 }, ada.id), true, 'under a fifth of the week left');
    assert.equal(await dm.allowanceLow(pool, { userWeeklyCents: 5000 }, ada.id), false);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = ANY($1::int[])', [extra.map((r) => r.id)]);
    await pool.query('DELETE FROM homeroom_bot_dm_turns WHERE id = $1', [turn.id]);
  });

  // Filing as the project's making does (app.firstRequest), its steps kept
  // in memory.
  const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');
  const fileFor = (appId, github) => {
    const kept = { value: null };
    return dm.fileFirstRequest(pool, {}, appId, { steps: makeSteps({ resumeFrom: null, checkpoint: async (v) => { kept.value = v; } }), deps: { github } });
  };

  await t.test('a project\'s description is filed as its first version, under its creator', async () => {
    const { rows: [project] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Chore wheel', 'chore-wheel', 'creating', $1) RETURNING *`,
      [ada.id],
    );
    const started = await dm.startFirstVersion(pool, {}, {
      app: project, user: ada, brief: 'Who does the dishes this week, decided fairly for the four of us.',
    });
    assert.ok(started.conversationId, 'and the DM says so');
    const { rows: [record] } = await pool.query(
      'SELECT user_id, status, bot_builds FROM homeroom_bot_first_versions WHERE app_id = $1', [project.id],
    );
    assert.deepEqual(record, { user_id: ada.id, status: 'waiting', bot_builds: true }, 'the bot builds it for her');
    const live = require('../src/services/homeroom-bot-live');
    assert.ok(live.isLiveFor(await homeroomBot.readSettings(pool), project), 'live, as every project is');

    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
    };
    // Its making files it once its setup has made the repository.
    await pool.query(`UPDATE apps SET repo_url = 'https://github.com/usernode-bot/chore-wheel' WHERE id = $1`, [project.id]);
    const filed = await fileFor(project.id, github);
    assert.deepEqual(filed, { issueNumber: 1 });
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'First version of Chore wheel');
    assert.match(created[0].body, /^\*\*Source:\*\* Homeroom user \(ada_\d+\)/);
    assert.match(created[0].body, /dishes this week/);
    const requester = await dm.requesterOf(pool, project.id, 1);
    assert.equal(requester.userId, ada.id);
    assert.equal(requester.firstVersion, true);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1', [project.id]);
    assert.equal(issue.created_by, ada.id);
    assert.deepEqual(await fileFor(project.id, github), { skipped: 'filed' }, 'filed once');
    assert.equal(created.length, 1);
  });

  await t.test('anybody else\'s description is filed as the first request too, and the bot is left out of it', async () => {
    // Sam is not let in yet, so the bot does not work for him: the same
    // record and filing, and nothing of the bot's (no DM, no requester row,
    // no wake, no failure DM).
    const { rows: [project] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Book club', 'book-club', 'creating', $1) RETURNING *`,
      [sam.id],
    );
    const before = events.length;
    const started = await dm.startFirstVersion(pool, {}, {
      app: project, user: { ...sam, hasPlatformAccess: false }, brief: 'Pick a book each month, read it together, and talk about it here.',
    });
    assert.equal(started, null, 'no DM to open');
    assert.equal(events.length, before, 'nothing pushed to anybody');
    const { rows: [recorded] } = await pool.query(
      'SELECT user_id, status, bot_builds FROM homeroom_bot_first_versions WHERE app_id = $1', [project.id],
    );
    assert.deepEqual(recorded, { user_id: sam.id, status: 'waiting', bot_builds: false });

    const woken = [];
    const realNote = homeroomBot.noteIssueActivity;
    homeroomBot.noteIssueActivity = (args) => { woken.push(args); };
    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (x) => x,
      async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
    };
    try {
      await pool.query(
        `UPDATE apps SET status = 'running', repo_url = 'https://github.com/usernode-bot/book-club' WHERE id = $1`,
        [project.id],
      );
      issueUpdates.length = 0;
      const filed = await fileFor(project.id, github);
      assert.deepEqual(filed, { issueNumber: 1 }, 'its making files it, the bot\'s or not');
    } finally {
      homeroomBot.noteIssueActivity = realNote;
    }
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'First version of Book club');
    assert.match(created[0].body, /^\*\*Source:\*\* Homeroom user \(sam_\d+\)/);
    assert.match(created[0].body, /read it together/);
    assert.match(created[0].body, /sam_\d+ described this when they created the project\.\n\n<!-- homeroom-first-version:app-\d+ -->$/,
      'and its marker, which GitHub does not show');
    assert.doesNotMatch(created[0].body, /Homeroom bot/);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1', [project.id]);
    assert.equal(issue.created_by, sam.id, 'under its creator');
    assert.equal(issueUpdates.length, 1, 'the board hears of it');
    assert.equal(await dm.requesterOf(pool, project.id, 1), null, 'no requester row: the bot\'s news has nowhere to go');
    assert.deepEqual(woken, [], 'the bot is not woken for it');
    const { rows: [after] } = await pool.query(
      'SELECT status, issue_number FROM homeroom_bot_first_versions WHERE app_id = $1', [project.id],
    );
    assert.deepEqual(after, { status: 'filed', issue_number: 1 });
  });

  await t.test('a project somebody the bot works for imports, forks or makes without a description is recorded, with nothing filed', async () => {
    const make = async (slug, by) => (await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $1, 'creating', $2) RETURNING *`, [slug, by.id],
    )).rows[0];
    const imported = await make('ada-import', ada);
    const forked = await make('ada-fork', ada);
    const blank = await make('ada-blank', ada);
    const samImport = await make('sam-import', sam);
    assert.equal(await dm.noteProjectMade(pool, { app: imported, user: ada, origin: 'import' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: forked, user: ada, origin: 'fork' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: blank, user: ada, origin: 'blank' }), true);
    assert.equal(await dm.noteProjectMade(pool, { app: imported, user: ada, origin: 'import' }), false, 'recorded once');
    assert.equal(await dm.noteProjectMade(pool, { app: samImport, user: { ...sam, hasPlatformAccess: false }, origin: 'import' }), false,
      'not let in yet: nothing recorded');
    assert.equal(await dm.noteProjectMade(pool, { app: samImport, user: ada, origin: 'template' }), false, 'an origin it does not know');

    const { rows: made } = await pool.query(
      `SELECT a.slug, p.user_id, p.origin FROM homeroom_bot_dm_projects p JOIN apps a ON a.id = p.app_id ORDER BY p.created_at, a.id`,
    );
    assert.deepEqual(made.map((r) => [r.slug, r.user_id, r.origin]), [
      ['ada-import', ada.id, 'import'],
      ['ada-fork', ada.id, 'fork'],
      ['ada-blank', ada.id, 'blank'],
    ], 'with who made each and how');
    assert.ok(await dm.importedAt(pool, imported.id) instanceof Date, 'where an import\'s backlog ends');
    assert.equal(await dm.importedAt(pool, forked.id), null, 'a fork arrives with no issues to hold back');
    const { rows: filed } = await pool.query(
      'SELECT app_id FROM homeroom_bot_first_versions WHERE app_id = ANY($1::int[])', [[imported.id, forked.id, blank.id]],
    );
    assert.deepEqual(filed, [], 'nothing to file as a first request');

    // Triage again takes an import's backlog: past the live check on every
    // project (these have no repository yet), where a paused one is refused.
    assert.equal((await homeroomBot.retriageApp(pool, { slug: 'ada-import' })).status, 404);
    assert.equal((await homeroomBot.retriageApp(pool, { slug: 'sam-import' })).status, 404);
    await setting('homeroom_bot_paused_apps', JSON.stringify(['sam-import']));
    assert.equal((await homeroomBot.retriageApp(pool, { slug: 'sam-import' })).status, 409);
    await setting('homeroom_bot_paused_apps', '[]');
  });

  await t.test('a staging preview has a bot DM with a question open, at its own address, once', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const viewer = await user('viewer');
      const first = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      const again = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      assert.equal(first, again);
      assert.notEqual(first, staging.BOT_DM_LEGACY_ID);
      const page = await conversations.listMessages(pool, viewer, first, {});
      const messages = page.messages || page;
      // #3624 stage 2: a question, and a request it offers to file. #3707:
      // the offer answers the viewer's ask, between them, and quotes it.
      // B6: a new project's plan and a request with two questions. #3736:
      // #3870: a change ready to try, saying what it is, just before them,
      // then two activity cards (tests/homeroom-bot-activity-postgres.test.js).
      // #4046: before the plan, a plan built already with the card under it,
      // and the waiting plan's own card. #4097 follow-up: before the ready
      // card, a build that did not finish, with its Try again button. #4231:
      // then a new project's first version gone live, with Open, Open
      // community and Invite people.
      // #4488: and, after the two questions, a complicated change's plan.
      // One story: and, after them, a request whose card is its thread's
      // root, with its question also shown in the main chat (its quiet
      // lines stay in the thread).
      // Homeroom bot parity (P1-P9): and, after the complicated change's plan,
      // three private threads' lines in the main chat (their replies, with the
      // new cards, stay in the threads: tests/bot-parity-staging-seed-postgres.test.js).
      assert.equal(messages.length, 19, 'one question, one ask, one offer, a built plan and its card, a plan and its card, two questions, a complicated change\'s plan, three private threads, a stuck build, a first version live, a ready card and two cards, then a story\'s card and its question, not one per visit');
      const sorted = [...messages].sort((a, b) => a.id - b.id);
      const [storyCard, storyQuestion] = sorted.slice(-2);
      assert.equal(storyCard.metadata.homeroomBot.kind, 'activity');
      assert.equal(storyCard.thread.replyCount, 5, 'four quiet lines and the question');
      assert.equal(storyQuestion.threadRootId, storyCard.id);
      assert.deepEqual([storyQuestion.metadata.homeroomBot.moment, storyQuestion.metadata.homeroomBot.alsoInChat], ['needs_you', true]);
      const storyThread = await conversations.listThread(pool, viewer, first, storyCard.id, {});
      assert.deepEqual(storyThread.messages.slice(0, 2).map((m) => m.content),
        ['You suggested this on Staging demo app\'s page. It\'s request #18.', 'Reading it.']);
      const [question, ask, offer, built, building, planCard, plan, two, complicated, ...afterPlan] = sorted.slice(0, -2);
      const threads = afterPlan.slice(0, 3);
      const [stuck, firstLive, ready, ...cards] = afterPlan.slice(3);
      assert.deepEqual(threads.map((m) => [m.content, m.metadata.homeroomBot.kind, m.thread?.replyCount]),
        [['New thread.', 'opened_thread', 4], ['New thread.', 'opened_thread', 4], ['New thread.', 'opened_thread', 2]]);
      assert.deepEqual([complicated.metadata.homeroomBot.kind, complicated.metadata.homeroomBot.firstVersion, complicated.metadata.homeroomBot.plan.complicated],
        ['plan', false, true]);
      assert.match(complicated.content, /^Before I build \*\*Staging demo app\*\* request #17, here's my plan:/);
      assert.equal(firstLive.metadata.homeroomBot.kind, 'merged');
      assert.equal(firstLive.metadata.homeroomBot.firstVersion, true);
      assert.deepEqual(firstLive.metadata.homeroomBot.actions.map((a) => a.label), ['Open Staging demo plants', 'Open community', 'Invite people']);
      assert.match(firstLive.content, /^\*\*Staging demo plants\*\*, its first version\n\nYour first version is live\. Open Staging demo plants to try it\.$/);
      assert.equal(stuck.metadata.homeroomBot.kind, 'build_failed');
      assert.equal(stuck.metadata.homeroomBot.status, 'open');
      assert.deepEqual(stuck.metadata.homeroomBot.actions, [{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }]);
      assert.match(stuck.content, /^\*\*Staging demo app\*\* · request #13: Staging demo, a print view\n\n.*Reply here and I'll try again\.$/s);
      assert.deepEqual(cards.map((m) => m.metadata.homeroomBot.kind), ['activity', 'activity']);
      assert.deepEqual([built.metadata.homeroomBot.kind, built.metadata.homeroomBot.status, built.metadata.homeroomBot.choices],
        ['plan', 'answered', ['Each runner picks their own goal']]);
      assert.deepEqual([building.metadata.homeroomBot.kind, building.metadata.homeroomBot.appName], ['activity', 'Staging demo run club']);
      assert.equal(building.content, 'Building it now. I\'ll tell you when it\'s ready to try.');
      assert.equal(building.metadata.homeroomBot.thanks, true);
      assert.deepEqual([planCard.metadata.homeroomBot.kind, planCard.metadata.homeroomBot.appName, planCard.metadata.homeroomBot.issueNumber],
        ['activity', 'Staging demo plants', 1], 'the waiting plan\'s own card, above it');
      assert.equal(ready.metadata.homeroomBot.kind, 'proposal');
      assert.equal(ready.metadata.homeroomBot.changeTitle, 'Staging demo: a calmer colour for finished items');
      assert.match(ready.content, /^\*\*Staging demo app\*\* · request #11: Staging demo, grey out finished items\n\nIt's ready to try\./);
      assert.equal(plan.metadata.homeroomBot.kind, 'plan');
      assert.equal(plan.metadata.homeroomBot.status, 'open');
      assert.equal(plan.metadata.homeroomBot.plan.bullets.length, 3);
      assert.deepEqual(plan.metadata.homeroomBot.plan.questions[0].answers, ['In the app', 'Phone alert']);
      assert.match(plan.content, /^Here's my plan for \*\*Staging demo plants\*\*:/);
      assert.equal(two.metadata.homeroomBot.kind, 'question');
      assert.equal(two.metadata.homeroomBot.questions.length, 2);
      assert.match(two.metadata.homeroomBot.lead, /I have two questions before I build this:$/);
      assert.equal(question.metadata.homeroomBot.kind, 'question');
      assert.equal(question.metadata.homeroomBot.status, 'open');
      assert.deepEqual(question.metadata.homeroomBot.answers, ['Newest first', 'Oldest first', 'Let me pick each time']);
      assert.match(question.content, /Staging demo/);
      assert.equal(question.reply, null, 'news about a request filed elsewhere quotes nothing');
      assert.equal(ask.sender.id, viewer.id, 'the ask is the viewer\'s own');
      assert.match(ask.content, /^Staging demo: /);
      assert.equal(offer.metadata.homeroomBot.kind, 'confirm');
      assert.deepEqual(offer.metadata.homeroomBot.answers, ['File it', 'Not now']);
      assert.notEqual(offer.metadata.homeroomBot.mirrors, true, 'an offer posts nothing, so it says nothing is public');
      assert.match(offer.content, /Staging demo, add a dark mode/);
      assert.equal(offer.reply.id, ask.id, 'the offer quotes the ask it answers');
      assert.equal(offer.reply.content, ask.content);
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'never a question the bot waits on: nothing is posted anywhere');
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });

  await t.test('somebody Homeroom has not let in yet who writes to the bot hears why it does not answer', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const hi = await conversations.sendMessage(pool, sam, conversationId, { content: 'hi' });
    const from = events.length;
    const said = await dm.noteUserMessage(pool, {}, { user: { ...sam, hasPlatformAccess: false }, conversationId, message: hi.message });
    const text = await conversations.getMessage(pool, sam, conversationId, said.messageId);
    assert.equal(text.content, dm.NOT_ENABLED_TEXT);
    assert.equal(text.content, 'I\'m not taking requests from your account yet. I will as soon as Homeroom lets your account in.');
    assert.equal(text.reply.id, hi.message.id);
    assert.ok(!events.slice(from).some((e) => e.payload.type === 'conversation_typing'), 'no typing for a canned line');
  });

  await t.test('#3698: the post on a request tags its requester exactly when their DM did not reach them, never one who blocked the bot', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const io = require('../src/services/ws');
    const github = { async createIssueComment() { return { id: 1, created_at: '2026-10-02T12:00:00Z' }; } };
    const repo = { owner: 'usernode-bot', repo: 'seed-swap' };
    const told = await user('told');
    const failed = await user('failed');
    const gone = await user('gone');
    const blocker = await user('blocker');
    const unrecorded = await user('unrecorded');

    // One request per requester, its news posted the way a live verdict
    // posts it: tagging whoever filed it and whoever took part (Sam).
    let issueNumber = 3698;
    const postFor = async (requester, db = pool) => {
      issueNumber += 1;
      await pool.query(
        `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, 'Tags')`,
        [app.id, issueNumber, requester.id],
      );
      // News that is a DM message of its own (homeroom-bot-dm.js cardOnly):
      // "I'm building it now" is the card's to say, and is never sent.
      const posted = await live.post({
        pool: db, github, ws: io, app, repo, issueNumber, kind: 'empty', text: 'Nothing to build.',
        sender: bot, senderId: bot.id, mentions: [requester.username, sam.username], dm: { reason: 'Nothing named.' },
      });
      assert.equal(posted.thread, true);
      const { rows: [thread] } = await pool.query(
        `SELECT id, content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = $2`,
        [app.id, issueNumber],
      );
      // Everything that rang for the requester (nothing else ever did), and
      // what rang for Sam on this post.
      const { rows: bells } = await pool.query(
        'SELECT kind, chat_message_id, conversation_message_id FROM notifications WHERE user_id = $1 ORDER BY id',
        [requester.id],
      );
      const { rows: samBells } = await pool.query(
        'SELECT kind FROM notifications WHERE user_id = $1 AND chat_message_id = $2', [sam.id, thread.id],
      );
      assert.deepEqual(samBells.map((b) => b.kind), ['mention'], 'everybody else on the post is tagged as before');
      const { rows: dms } = await pool.query(
        `SELECT m.id FROM conversation_messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
          WHERE m.sender_id = $2`,
        [requester.id, bot.id],
      );
      return { thread, bells, dms: dms.map((r) => r.id) };
    };
    const onlyDm = (seen, why) => {
      assert.equal(seen.thread.content, `@${sam.username} Nothing to build.`, `${why}: not tagged on the request`);
      assert.equal(seen.dms.length, 1, `${why}: told in the DM`);
      // Nothing to build rings in the DM, once, as Needs you (contract
      // 2.1: `empty` is a needs_you moment): the post tags nobody for it.
      assert.deepEqual(seen.bells.map((b) => [b.kind, b.chat_message_id]), [['build_needs_you', null]], `${why}: the DM's bell, not a mention`);
    };
    const onlyMention = (seen, who, why) => {
      assert.equal(seen.thread.content, `@${who.username} @${sam.username} Nothing to build.`, `${why}: tagged on the request`);
      assert.deepEqual(seen.dms, [], `${why}: nothing in a DM`);
      assert.deepEqual(seen.bells, [{ kind: 'mention', chat_message_id: seen.thread.id, conversation_message_id: null }],
        `${why}: one bell, the post's mention`);
    };

    // The DM reached them: it is where the news rings, and only there.
    onlyDm(await postFor(told), 'told in the DM');

    // The relay failed: the post's mention is how the news reaches them.
    const relay = dm.relayIssuePost;
    dm.relayIssuePost = async () => { throw new Error('relay down'); };
    try {
      onlyMention(await postFor(failed), failed, 'the relay threw');
    } finally {
      dm.relayIssuePost = relay;
    }

    // They left the bot's DM: the bot does not open it again for news, so
    // the post tags them.
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, gone.id);
    assert.ok(await conversations.leave(pool, gone, conversationId));
    onlyMention(await postFor(gone), gone, 'left the bot\'s DM');

    // They blocked the bot: nothing from it, here or in a DM.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [blocker.id, bot.id]);
    const blocked = await postFor(blocker);
    assert.equal(blocked.thread.content, `@${sam.username} Nothing to build.`, 'not tagged');
    assert.deepEqual(blocked.dms, [], 'no DM');
    assert.deepEqual(blocked.bells, [], 'and nothing rings');

    // The DM reached them but could not be recorded after: it still did,
    // so the post must not ring a second time.
    const flaky = {
      query: (sql, params) => (/INSERT INTO homeroom_bot_dm_messages/.test(String(sql))
        ? Promise.reject(new Error('could not record')) : pool.query(sql, params)),
      connect: () => pool.connect(),
    };
    onlyDm(await postFor(unrecorded, flaky), 'told, but not recorded');
  });

  // WP1 (#6): on 3 October a second build of Plant Pal #1 said "I'm building
  // this now" in the DM after the first build had said "It's built". A
  // build's news that something newer answered or overtook is not sent, and
  // the post on the request does not ring for it either.
  await t.test('WP1 (#6): a build\'s news is not sent once another proposal answers its request, or a newer look overtook it', async () => {
    const live = require('../src/services/homeroom-bot-live');
    const io = require('../src/services/ws');
    const github = { async createIssueComment() { return { id: 1, created_at: '2026-10-03T16:48:00Z' }; } };
    const repo = { owner: 'usernode-bot', repo: 'seed-swap' };
    const pip = await user('pip');
    const requester = (issueNumber) => pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, $2, $3, 'Watering log')`,
      [app.id, issueNumber, pip.id],
    );
    const runOf = async (issueNumber, { verdict = 'ready', proposal = null, ago = 0 } = {}) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, created_at)
       VALUES ($1, $2, 'live', $3, $4, NOW() - make_interval(secs => $5)) RETURNING id`,
      [app.id, issueNumber, verdict, proposal, ago],
    )).rows[0].id;
    const proposalOf = async (issueNumber, status) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues, promoted_at)
       VALUES ($1, $2, 'dev/homeroom_bot-x', $3, $4, NOW()) RETURNING id`,
      [app.id, bot.id, status, [issueNumber]],
    )).rows[0].id;
    const dms = async () => (await pool.query(
      `SELECT m.content FROM conversation_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.sender_id = $2 ORDER BY m.id`,
      [pip.id, bot.id],
    )).rows.map((r) => r.content);
    const bells = async () => (await pool.query('SELECT kind FROM notifications WHERE user_id = $1', [pip.id])).rows;

    // Run A built request #3783 and its proposal is up for a vote; run B, a
    // second build of the same request, then wrote its plan.
    await requester(3783);
    const first = await proposalOf(3783, 'promoted');
    const a = await runOf(3783, { proposal: first, ago: 600 });
    const b = await runOf(3783, { ago: 300 });
    const stale = await dm.relayIssuePost({ pool, app, issueNumber: 3783, kind: 'spec', runId: b, postId: 37831, bot, dm: { building: true } });
    assert.deepEqual({ stale: stale.stale, messageId: stale.messageId, username: stale.username },
      { stale: true, messageId: null, username: pip.username });
    assert.equal(await dm.untaggedRequester(pool, { appId: app.id, issueNumber: 3783, bot, told: stale }), pip.username,
      'the post on the request leaves her untagged too');
    for (const [kind, extra] of [['proposal', { link: 'https://x/6191', sessionId: 6191 }], ['build_failed', { reason: 'x' }]]) {
      const sent = await dm.relayIssuePost({ pool, app, issueNumber: 3783, kind, runId: b, postId: 37832, bot, dm: extra });
      assert.equal(sent.stale, true, kind);
    }
    assert.deepEqual(await dms(), [], 'none of the second build\'s news reached her');
    // Said through the post, as a live build says it: on the request, and
    // never rung for her.
    const posted = await live.post({
      pool, github, ws: io, app, repo, issueNumber: 3783, kind: 'spec', runId: b, text: 'Building it now.',
      sender: bot, senderId: bot.id, mentions: [pip.username, sam.username], dm: { building: true },
    });
    assert.equal(posted.thread, true);
    const { rows: [thread] } = await pool.query(
      `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 3783`, [app.id],
    );
    assert.equal(thread.content, `@${sam.username} Building it now.`);
    assert.deepEqual(await bells(), []);
    assert.deepEqual(await dms(), []);

    // Run A's own proposal is still told, though run B is newer: it is the
    // one people vote on, and its news must reach her (B4: once it is ready
    // to try, its checks passed).
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [first]);
    const told = await dm.relayIssuePost({
      pool, app, issueNumber: 3783, kind: 'proposal', runId: a, postId: 37833, bot,
      dm: { link: `https://app.onhomeroom.com/#app/seed-swap/dev/proposals/${first}`, sessionId: first },
    });
    assert.ok(told.messageId);
    assert.equal(told.stale, undefined);
    assert.equal((await dms()).length, 1);

    // A proposal merged before this run's verdict is an earlier change, not
    // an answer to this one: its news goes out.
    await requester(3784);
    const earlier = await proposalOf(3784, 'merged');
    await pool.query(`UPDATE chat_sessions SET merged_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [earlier]);
    await runOf(3784, { proposal: earlier, ago: 86400 * 2 });
    const later = await runOf(3784);
    const going = await dm.relayIssuePost({ pool, app, issueNumber: 3784, kind: 'spec', runId: later, postId: 37841, bot, dm: { building: true } });
    // A later request on the same issue is news: not stale, and on its card
    // (homeroom-bot-dm.js cardOnly), never a message of its own.
    assert.deepEqual([going.stale, going.quiet, going.messageId], [undefined, true, null], 'a later request on the same issue is news, on its card');

    // A plan or a failure a newer look overtook is not sent; with no other
    // proposal anywhere, the run's own proposal is.
    await requester(3785);
    const overtaken = await runOf(3785, { ago: 300 });
    await runOf(3785, { verdict: 'question' });
    assert.equal((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'spec', runId: overtaken, postId: 37851, bot, dm: { building: true } })).stale, true);
    assert.equal((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'build_failed', runId: overtaken, postId: 37852, bot, dm: { reason: 'x' } })).stale, true);
    assert.ok((await dm.relayIssuePost({ pool, app, issueNumber: 3785, kind: 'proposal', runId: overtaken, postId: 37853, bot, dm: { link: 'https://x/1' } })).messageId);
  });

  // WP1 (#9): a build a restart interrupted is started again. Its card and
  // the tray say it is building; nothing else is sent ("Nothing you need to
  // do." was the case for saying nothing).
  await t.test('WP1 (#9): a build started again after a restart is not a message', async () => {
    const kit = await user('kit');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 3786, $2, 'Reminders')`,
      [app.id, kit.id],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 3786, 'live', 'ready') RETURNING id`, [app.id],
    );
    assert.equal(await dm.noteBuildRestarted(pool, { app, issueNumber: 3786, runId: run.id }), null);
    const { rows } = await pool.query(
      `SELECT m.id FROM conversation_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.sender_id = $2`,
      [kit.id, bot.id],
    );
    assert.deepEqual(rows, [], 'nothing reached her DM');
  });

  await t.test('#4097 follow-up: where it is stuck it says what to tap, and only its newest message\'s suggestions stay live', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 4097, $2, 'Print view'), ($1, 4098, $2, 'Dark mode')`,
      [app.id, ada.id],
    );
    const read = async (sent) => (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [sent.messageId])).rows[0].metadata.homeroomBot;
    // A decision the bot waits on: never retired by what it says next.
    const decision = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Want me to file this?',
      metadata: { kind: 'confirm', actionId: 1, actions: [{ id: 'yes', label: 'File it', style: 'primary', type: 'server' }], status: 'open' },
    });
    const failed = await dm.relayIssuePost({ pool, app, issueNumber: 4097, kind: 'build_failed', postId: 40971, bot, dm: { reason: 'the build ran past its time limit' } });
    let meta = await read(failed);
    assert.deepEqual(meta.actions, [{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }], 'Try again, sent quoting it');
    assert.equal(meta.status, 'open');
    const blocked = await dm.relayIssuePost({ pool, app, issueNumber: 4098, kind: 'blocked', postId: 40981, bot, dm: { reason: 'it does not say which screen' } });
    meta = await read(blocked);
    assert.deepEqual(meta.actions, [{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }], 'Add detail, quoted in the composer');
    assert.equal(meta.mirrors, true, 'and what they write is posted on the request, which the reply bar says');
    // One story (contract 2.3): news about ANOTHER request leaves Try again
    // be; it stays until it is used or newer news about the same request.
    assert.equal((await read(failed)).status, 'open', 'news about another request: Try again stays');

    const chat = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'It is waiting its turn.', moment: 'reply',
      metadata: { kind: 'chat', actions: dm.promptActions(['How long will it take?']), status: 'open' },
    });
    assert.equal((await read(blocked)).status, 'open', 'a general reply leaves Add detail be');
    assert.equal((await read(chat)).status, 'open', 'the newest message keeps its own');
    // Newer news about the same request replaces them, and says why.
    await dm.relayIssuePost({ pool, app, issueNumber: 4097, kind: 'build_failed', postId: 40972, bot, dm: { reason: 'it produced no change' } });
    const replaced = await read(failed);
    assert.equal(replaced.status, 'closed');
    assert.equal(replaced.closedWhy, 'No longer needed');
    assert.equal((await read(decision)).status, 'open', 'an offer is a decision, not a suggestion');
    await dm.sendDm(pool, { bot, userId: ada.id, content: 'Plain words.' });
    assert.equal((await read(chat)).status, 'closed');
    assert.equal(await dm.settlePrompt(pool, { botId: bot.id, userId: ada.id, conversationId: chat.conversationId, content: 'How long will it take?' }), false,
      'a retired suggestion is not settled by typing its words');
  });

  // #4974: when someone replies on a request's public discussion after the
  // bot asked them something in their DM, the ask is settled from there —
  // the question reads answered, a stop's buttons go, the tray stops calling
  // it Needs you — and one quiet line in the request's thread says what was
  // replied. Only the first reply after an ask adds a line.
  await t.test('a reply on the request settles the ask it answers, and says so quietly in its thread', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES
         ($1, 5010, $2, 'Plant shelf'), ($1, 5011, $3, 'Dark mode'), ($1, 5012, $2, 'Print view'), ($1, 5013, $2, 'Label sheet')`,
      [app.id, ada.id, sam.id],
    );
    const readMeta = async (messageId) => (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [messageId])).rows[0].metadata.homeroomBot;
    const askRow = async (messageId) => (await pool.query('SELECT question_status, answered_at FROM homeroom_bot_dm_messages WHERE message_id = $1', [messageId])).rows[0];

    // Her own reply settles the question it answers.
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 5010, kind: 'question', postId: 50101, bot,
      dm: { question: 'Which shelf?', answers: ['Top', 'Bottom'] },
    });
    assert.equal((await askRow(asked.messageId)).question_status, 'open');
    const from = events.length;
    const noted = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5010, userId: ada.id, chatMessageId: 99001,
      content: 'The top one', createdAt: new Date(),
    });
    assert.equal(noted.settled.length, 1, 'the open question is what the reply settled');
    assert.equal((await askRow(asked.messageId)).question_status, 'answered');
    assert.ok((await askRow(asked.messageId)).answered_at, 'and it says when');
    assert.deepEqual([(await readMeta(asked.messageId)).status, (await readMeta(asked.messageId)).answeredOnRequest], ['answered', true]);
    assert.ok(noted.line?.messageId, 'one quiet line, in the request\'s thread');
    const line = await conversations.getMessage(pool, ada, asked.conversationId, noted.line.messageId);
    assert.equal(line.content, `You replied on the request's discussion: “The top one”`);
    assert.equal(line.metadata.homeroomBot.step, 'replied');
    assert.equal(line.metadata.homeroomBot.issueNumber, 5010);
    assert.equal(line.metadata.homeroomBot.moment, undefined, 'it rings nothing');
    assert.equal(line.threadRootId, asked.messageId, 'no card yet, so the thread hangs off the ask it settled');
    assert.deepEqual((await pool.query('SELECT 1 FROM notifications WHERE conversation_message_id = $1', [noted.line.messageId])).rows, [],
      'and no bell for it');
    assert.ok(events.slice(from).some((e) => e.userId === ada.id && e.payload.type === 'homeroom_bot_work_changed'),
      'the tray is told to look again');

    // A second reply after it settles nothing and adds no line.
    const again = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5010, userId: ada.id, chatMessageId: 99002,
      content: 'Also the middle shelf', createdAt: new Date(),
    });
    assert.equal(again.settled.length, 0);
    assert.equal(again.line, null, 'only the first reply after an ask is said');

    // Somebody else's reply names them, and settles their ask the same way.
    const askedSam = await dm.relayIssuePost({
      pool, app, issueNumber: 5011, kind: 'question', postId: 50111, bot,
      dm: { question: 'Follow the system setting?', answers: ['Follow it', 'A toggle'] },
    });
    // The reply's stamp reaches settleMirroredAsks as a JS Date, cut to the
    // millisecond (ws.js hands it the chat_messages row's created_at). Reading
    // the ask's own stamp back through the pool hands the same shape: this
    // reply lands in the ask's own millisecond and must still settle it.
    const askStamp = (await pool.query('SELECT created_at FROM homeroom_bot_dm_messages WHERE message_id = $1', [askedSam.messageId])).rows[0].created_at;
    const theirs = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5011, userId: ada.id, chatMessageId: 99003,
      content: 'A toggle, please', createdAt: askStamp,
    });
    assert.equal(theirs.settled.length, 1);
    const theirLine = await conversations.getMessage(pool, sam, askedSam.conversationId, theirs.line.messageId);
    assert.equal(theirLine.content, `@${ada.username} replied on the request's discussion: “A toggle, please”`);
    assert.ok(events.slice(from).some((e) => e.userId === sam.id && e.payload.type === 'homeroom_bot_work_changed'));

    // The bot's own post on a request is never an answer, and a reply from
    // before an ask does not settle the ask that came after it.
    const askedAgain = await dm.relayIssuePost({
      pool, app, issueNumber: 5012, kind: 'question', postId: 50121, bot,
      dm: { question: 'Print which page?', answers: ['All'] },
    });
    const byBot = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5012, userId: bot.id, chatMessageId: 99004, content: 'On it', createdAt: new Date(),
    });
    assert.equal(byBot, null, 'a synthetic account never counts as a reply');
    assert.equal((await askRow(askedAgain.messageId)).question_status, 'open', 'and its ask stays open');
    const earlier = new Date(Date.now() - 60_000);
    const late = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5012, userId: ada.id, chatMessageId: 99005, content: 'All of them', createdAt: earlier,
    });
    assert.equal(late.settled.length, 0, 'a reply from before the ask settles nothing');
    assert.equal((await askRow(askedAgain.messageId)).question_status, 'open');

    // A DM answer settles a stop with its buttons the same way: her words
    // go to the request as hers, marked as relayed from the DM, the buttons
    // go, and the tray stops calling it Needs you.
    const stopped = await dm.relayIssuePost({
      pool, app, issueNumber: 5013, kind: 'blocked', postId: 50131, bot,
      dm: { reason: 'it does not say which printer' },
    });
    const stopMeta = await readMeta(stopped.messageId);
    assert.equal(stopMeta.status, 'open');
    assert.deepEqual(stopMeta.actions, [{ id: 'add_detail', label: 'Add detail', style: 'primary', type: 'reply' }]);
    const posts = threadPosts.length;
    const posted = await dm.postOnRequest(pool, {
      user: ada,
      target: { app_id: app.id, issue_number: 5013, message_id: stopped.messageId, conversation_id: stopped.conversationId, kind: 'blocked', question_status: null },
      text: 'It is the office one',
    });
    assert.equal(posted.ok, true);
    assert.equal(threadPosts.length, posts + 1, 'her words went to the request as hers');
    assert.equal(threadPosts[posts].userId, ada.id);
    assert.equal(threadPosts[posts].viaBotDm, true, 'marked as relayed from her DM, so it never counts as a reply');
    assert.deepEqual(threadPosts[posts].msg.thread, { type: 'issue', ref: 5013 });
    assert.equal((await askRow(stopped.messageId)).question_status, null, 'a stop is not a question');
    assert.ok((await askRow(stopped.messageId)).answered_at);
    const closedMeta = await readMeta(stopped.messageId);
    assert.deepEqual([closedMeta.status, closedMeta.answeredOnRequest], ['closed', true]);
    // Settled from the DM, it needs no quiet line from the discussion.
    const after = await dm.noteRequestReply(pool, {
      appId: app.id, issueNumber: 5013, userId: ada.id, chatMessageId: 99006, content: 'It is the office one', createdAt: new Date(),
    });
    assert.equal(after.settled.length, 0);
    assert.equal(after.line, null);
  });

  // #6019: Main is one conversation. What the bot says about a request is
  // said there, beside the request's card, and folds into one row per
  // request (bot-news-line.tsx foldBotNews); the moments that ring count
  // once and quiet lines count as nothing unread. A thread opened under a
  // card before this (or by the person replying under it) keeps its replies.
  await t.test('one conversation: a request\'s news is said in Main beside its card, quiet lines count nothing', async () => {
    const activity = require('../src/services/homeroom-bot-activity');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 5001, $2, 'Plant photos')`,
      [app.id, ada.id],
    );
    const requester = await dm.requesterOf(pool, app.id, 5001);
    const card = await activity.startCard(pool, { app, issueNumber: 5001, requester, bot, jobKey: 'story-5001' });
    assert.ok(card?.messageId, 'every request gets a card, however it was asked');
    const conversationId = card.conversationId;
    const viewer = { id: ada.id, username: ada.username };
    const read0 = (await conversations.getConversation(pool, viewer, conversationId)).unreadCount;

    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 5001, kind: 'question', postId: 50011, bot,
      dm: { question: 'Which camera?', answers: ['Front', 'Back'] },
    });
    const building = await dm.relayIssuePost({ pool, app, issueNumber: 5001, kind: 'spec', postId: 50012, bot, dm: { building: true, plan: 'A photo per plant' } });
    const question = await conversations.getMessage(pool, viewer, conversationId, asked.messageId);
    assert.equal(question.threadRootId, null, 'the question is said in Main, not under the card');
    const meta = question.metadata.homeroomBot;
    assert.deepEqual([meta.moment, meta.said, meta.alsoInChat, meta.threadRootId, meta.requestTitle, meta.appName],
      ['needs_you', 'question', undefined, undefined, 'Plant photos', 'Seed swap']);
    assert.ok(!question.content.includes('request #5001'), 'its row names the request; the words do not repeat it');
    const step = await conversations.getMessage(pool, viewer, conversationId, building.messageId);
    assert.equal(step.content, 'Plan: A photo per plant. I\'m building it now.');
    assert.equal(step.threadRootId, null);
    assert.equal(step.metadata.homeroomBot.moment, undefined, 'a quiet line');
    assert.equal(step.metadata.homeroomBot.quiet, true, 'marked quiet, so it counts as nothing unread');
    assert.deepEqual(step.metadata.homeroomBot.actions.map((a) => a.label), ['Read the plan']);
    const { rows: rang } = await pool.query(
      'SELECT kind FROM notifications WHERE user_id = $1 AND conversation_message_id = ANY($2::int[]) ORDER BY id',
      [ada.id, [asked.messageId, building.messageId]],
    );
    assert.deepEqual(rang.map((r) => r.kind), ['build_needs_you'], 'the question rings; the quiet line does not');

    // Main: the card, the moment and the quiet line, one after another.
    const main = await conversations.listMessages(pool, viewer, conversationId, {});
    const ids = main.messages.map((m) => m.id);
    assert.ok(ids.includes(card.messageId) && ids.includes(asked.messageId) && ids.includes(building.messageId));
    const root = main.messages.find((m) => m.id === card.messageId);
    assert.ok(!root.thread || !root.thread.replyCount, 'the card opens no thread of its own');
    const after = await conversations.getConversation(pool, viewer, conversationId);
    assert.equal(after.unreadCount, read0 + 1, 'the moment counts once; the quiet line not at all');
    assert.equal(after.latestMessage.id, building.messageId, 'the newest thing said in Main');
    // Read where it is shown: a main-chat position, and its bell row goes.
    await conversations.markRead(pool, viewer, conversationId, asked.messageId);
    assert.equal((await conversations.getConversation(pool, viewer, conversationId)).unreadCount, 0);
    const { rows: unreadBells } = await pool.query(
      'SELECT 1 FROM notifications WHERE user_id = $1 AND conversation_message_id = $2 AND read_at IS NULL', [ada.id, asked.messageId],
    );
    assert.equal(unreadBells.length, 0);

    // The person replies under the card: that is a thread of theirs, about
    // the request, and the bot answers in it.
    const reply = await conversations.sendMessage(pool, viewer, conversationId, { content: 'The back one', thread_root_id: card.messageId });
    assert.equal(reply.message.threadRootId, card.messageId);
    const about = await dm.threadRequest(pool, { userId: ada.id, conversationId, message: reply.message });
    assert.deepEqual([about.issueNumber, about.title, about.rootId], [5001, 'Plant photos', card.messageId]);
    assert.equal(await dm.threadRootFor(pool, { conversationId, userId: ada.id, replyToId: reply.message.id }), card.messageId,
      'what the bot says back goes in the same thread');

    // A request from before threads has no card: the chat opens its story on
    // its oldest message, and a reply written there is about it all the same.
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 5003, $2, 'Print view')`,
      [app.id, ada.id],
    );
    const old = await dm.sendDm(pool, {
      bot, userId: ada.id, threadRootId: false, content: 'I can\'t build this as written.',
      metadata: { kind: 'blocked', appSlug: app.slug, appName: 'Seed swap', issueNumber: 5003 },
    });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind)
       VALUES ($1, $2, $3, $4, 5003, 'blocked') ON CONFLICT (message_id) DO NOTHING`,
      [old.messageId, ada.id, conversationId, app.id],
    );
    const underOld = await conversations.sendMessage(pool, viewer, conversationId, { content: 'The print screen', thread_root_id: old.messageId });
    const aboutOld = await dm.threadRequest(pool, { userId: ada.id, conversationId, message: underOld.message });
    assert.deepEqual([aboutOld?.issueNumber, aboutOld?.title, aboutOld?.rootId], [5003, 'Print view', old.messageId]);
    const plain = await dm.sendDm(pool, { bot, userId: ada.id, threadRootId: false, content: 'Hello.', metadata: { kind: 'chat' } });
    const underPlain = await conversations.sendMessage(pool, viewer, conversationId, { content: 'hi', thread_root_id: plain.messageId });
    assert.equal(await dm.threadRequest(pool, { userId: ada.id, conversationId, message: underPlain.message }), null,
      'a thread under words about no request is no request\'s');

    // The main list draws the bot's news as one-line rows, never their cards:
    // it sends those rows without them, so the page answers without filling
    // (and, for a request card, asking GitHub about) cards nobody sees there.
    // The request's story keeps them, and so does the bot's conversation.
    const say = async (meta, threadRoot = null) => {
      const { rows: [m] } = await pool.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, thread_root_id)
         VALUES ($1, $2, 'words', $3, $4) RETURNING id`,
        [conversationId, bot.id, JSON.stringify({ homeroomBot: { appSlug: app.slug, appName: app.name, ...meta } }), threadRoot],
      );
      await pool.query(
        `INSERT INTO conversation_message_objects (message_id, position, object_type, app_id, object_ref) VALUES ($1, 0, 'app', $2, $2)`,
        [m.id, app.id],
      );
      return m.id;
    };
    const storyCard = await say({ kind: 'activity', issueNumber: 5002 });
    const ringing = await say({ kind: 'merged', moment: 'live', alsoInChat: true, issueNumber: 5002, threadRootId: storyCard }, storyCard);
    const talk = await say({ kind: 'chat' });
    const listed = await conversations.listMessages(pool, viewer, conversationId, { limit: 50 });
    const cardsOf = (id) => listed.messages.find((m) => m.id === id)?.objects?.length;
    assert.equal(cardsOf(storyCard), 0, 'a request\'s row comes without its card');
    assert.equal(cardsOf(ringing), 0);
    assert.equal(cardsOf(talk), 1, 'the bot\'s conversation keeps its cards');
    const around = await conversations.listMessages(pool, viewer, conversationId, { around: storyCard, limit: 10 });
    assert.equal(around.messages.find((m) => m.id === storyCard).objects.length, 0, 'a permalink window too');
    const story = await conversations.listThread(pool, viewer, conversationId, storyCard, {});
    assert.equal(story.root.objects.length, 1, 'the story keeps the request\'s card');
    assert.equal(story.messages.find((m) => m.id === ringing).objects.length, 1);

    // People-to-people direct chats keep no threads.
    const people = await conversations.createDirect(pool, ada, sam.id);
    const peopleId = people.conversationId || people.conversation?.id;
    const first = await conversations.sendMessage(pool, viewer, peopleId, { content: 'hi sam' });
    assert.deepEqual(await conversations.listThread(pool, viewer, peopleId, first.message.id, {}), { error: 'threads_not_supported' });
    assert.deepEqual(await conversations.sendMessage(pool, viewer, peopleId, { content: 'x', thread_root_id: first.message.id }),
      { error: 'threads_not_supported' });
  });
});
