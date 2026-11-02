'use strict';

// Homeroom bot parity, P7: an admin's confirm card, round trip, against the
// full PostgreSQL schema. An admin tool's write is sealed by the turn
// (homeroom-bot-thread-tools/admin.js), shown on a card under the bot's
// reply, and run only by the admin's Confirm tap through the card route's
// own decide (homeroom-bot-cards/index.js, confirm.js): once, as them, on a
// one-action write grant. A second Confirm, an expired card, a card in
// another conversation and an admin who lost admin run nothing.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p7-confirm-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const admin = require('../src/services/homeroom-bot-thread-tools/admin');
const cards = require('../src/services/homeroom-bot-cards');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const CONFIG = { dataEncryptionKey: 'synthetic-test-key' };

test('a confirm card runs its sealed action once, as the admin, and nothing else does', { timeout: 120000 }, async (t) => {
  const root = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.query('SELECT 1'); } catch (err) {
    await root.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_p7_${crypto.randomBytes(6).toString('hex')}`;
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await root.query(`DROP DATABASE ${name}`);
    await root.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, { isAdmin = false, synthetic = false } = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_admin, is_synthetic)
     VALUES ($1, 'x', TRUE, $2, $3) RETURNING id, username`, [username, isAdmin, synthetic])).rows[0];
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada_admin', { isAdmin: true });
  const sam = await user('sam_member');
  const conversation = async (person) => {
    const { rows: [c] } = await pool.query("INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id", [person.id]);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status) VALUES ($1, $2, 'owner', 'member'), ($1, $3, 'member', 'member')`,
      [c.id, person.id, bot.id]);
    return Number(c.id);
  };
  const adaChat = await conversation(ada);
  const samChat = await conversation(sam);

  // What the shim was asked to do, and what the conversation was told.
  const shimLog = [];
  const said = [];
  const pushed = [];
  const deps = {
    openAdminMcp: async (opts) => {
      shimLog.push({ open: { kind: opts.kind, scopes: opts.scopes, userId: opts.userId } });
      return {
        async call(tool, input) {
          shimLog.push({ call: tool, input });
          return { isError: false, structured: { runId: 12, trials: 8, estimateUsd: 1.5, capUsd: input.capUsd }, text: '{}' };
        },
        async close(reason) { shimLog.push({ close: reason }); },
      };
    },
    dm: {
      async sendDm(_pool, args) { said.push(args); return { messageId: 1, conversationId: adaChat }; },
      async botAccount() { return bot; },
    },
    ws: { pushConversationEvent(ids, event) { pushed.push({ ids, event }); return 1; } },
  };

  // The turn seals it and puts the card under its reply.
  const prepare = async (conversationId, who = ada) => {
    const ctx = { user: { id: who.id, username: who.username, isAdmin: true }, config: CONFIG, conversationId, deps: {} };
    const out = await admin.run(pool, ctx, 'launch_bench_run', { suiteId: 3, models: ['z-ai/glm-5.3-flash'], stages: ['build'], capUsd: 7 });
    assert.equal(out.status, 'pending_confirmation');
    const { rows: [m] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
       VALUES ($1, $2, 'This launches a bench run once you tap Confirm.', $3) RETURNING id`,
      [conversationId, bot.id, JSON.stringify({ homeroomBot: { kind: 'chat', card: ctx.card } })]);
    return { messageId: Number(m.id), card: ctx.card };
  };
  const tap = (who, messageId, action = 'confirm') => cards.decide(pool, CONFIG, {
    user: { id: who.id, username: who.username, isAdmin: true }, messageId, action, deps,
  });
  const cardOn = async (messageId) => (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [messageId]))
    .rows[0].metadata.homeroomBot.card;

  const first = await prepare(adaChat);
  const { rows: [sealed] } = await pool.query('SELECT status, tool_name, sealed_input FROM homeroom_bot_admin_actions WHERE id = $1', [first.card.confirmId]);
  assert.equal(sealed.status, 'pending');
  assert.equal(sealed.tool_name, 'launch_bench_run');
  assert.ok(!JSON.stringify(sealed.sealed_input).includes('glm-5.3'), 'sealed, not stored in the clear');
  assert.equal(shimLog.length, 0, 'nothing ran when it was prepared');

  // Somebody else in no conversation of theirs taps it: no such card.
  const stranger = await tap(sam, first.messageId);
  assert.equal(stranger.ok, false);
  assert.equal(stranger.status, 404);

  // Confirm once: run as the admin, on a write grant, its outcome on the card and in the conversation.
  const ran = await tap(ada, first.messageId);
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.state, 'done');
  assert.equal(ran.result, 'Launched run 12: 8 trials, about $1.5 against a cap of $7.');
  assert.deepEqual(shimLog[0], { open: { kind: 'bot_admin', scopes: [READ_SCOPE, WRITE_SCOPE], userId: ada.id } });
  assert.deepEqual(shimLog[1], { call: 'launch_bench_run', input: { suiteId: 3, models: ['z-ai/glm-5.3-flash'], stages: ['build'], capUsd: 7 } },
    'byte for byte what the card showed');
  assert.equal(shimLog[2].close, 'action_done');
  const done = await cardOn(first.messageId);
  assert.equal(done.state, 'done');
  assert.equal(done.result, ran.result);
  assert.ok(pushed.some((p) => p.event.messageId === first.messageId), 'every open tab hears the card changed');
  assert.equal(said.length, 1);
  assert.equal(said[0].userId, ada.id);
  assert.equal(said[0].moment, null, 'quietly');
  assert.match(said[0].content, /^Confirmed: Launch a bench run\. Launched run 12/);
  assert.equal(said[0].metadata.kind, 'admin_result');
  const { rows: [after] } = await pool.query('SELECT status, result FROM homeroom_bot_admin_actions WHERE id = $1', [first.card.confirmId]);
  assert.equal(after.status, 'done');
  assert.equal(after.result.ok, true);

  // A second Confirm is refused, and nothing runs again.
  const again = await tap(ada, first.messageId);
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(shimLog.filter((l) => l.call).length, 1, 'it ran once');

  // An expired card is refused, and says so.
  const late = await prepare(adaChat);
  await pool.query(
    "UPDATE homeroom_bot_admin_actions SET created_at = NOW() - INTERVAL '20 minutes', expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1",
    [late.card.confirmId]);
  const expired = await tap(ada, late.messageId);
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 410);
  assert.equal((await cardOn(late.messageId)).state, 'expired');
  assert.equal(shimLog.filter((l) => l.call).length, 1);

  // An admin who lost admin cannot confirm: the row stays as it was.
  const kept = await prepare(adaChat);
  await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [ada.id]);
  const lost = await tap(ada, kept.messageId);
  assert.equal(lost.ok, false);
  assert.equal(lost.status, 403);
  assert.equal((await pool.query('SELECT status FROM homeroom_bot_admin_actions WHERE id = $1', [kept.card.confirmId])).rows[0].status, 'pending');
  assert.equal(shimLog.filter((l) => l.call).length, 1, 'still once');

  // A non-admin was never able to seal one either.
  const refused = await admin.run(pool, { user: { id: sam.id, isAdmin: true }, config: CONFIG, conversationId: samChat, deps: {} },
    'launch_bench_run', { suiteId: 3, models: ['m'], stages: ['build'], capUsd: 1 });
  assert.equal(refused.ok, false, 'the turn\'s copy of the person says admin; the database does not');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_admin_actions WHERE user_id = $1', [sam.id])).rows[0].n, 0);

  // Cancel, once admin again: dismissed, nothing runs.
  await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [ada.id]);
  const cancelled = await tap(ada, kept.messageId, 'cancel');
  assert.equal(cancelled.ok, true);
  assert.equal((await cardOn(kept.messageId)).state, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM homeroom_bot_admin_actions WHERE id = $1', [kept.card.confirmId])).rows[0].status, 'dismissed');
  assert.equal((await tap(ada, kept.messageId)).status, 409, 'and a cancelled card does not confirm');
  assert.equal(shimLog.filter((l) => l.call).length, 1);
});
