'use strict';

// Homeroom bot parity (P1-P9): the staging preview's three private threads
// with Homeroom bot (services/staging-messages.js ensureBotParityThreads),
// which the before & after shots open: a conversation there with its new
// cards, since a staging copy's bot never runs its model.
//
//   - opening the demo DM gives the viewer three open private threads, each
//     named by their own first words in it, once (a second opening adds none);
//   - the bot's replies carry the cards as stored messages: options with the
//     "Looked at" line, a question set, a batch with its roll-up, a note
//     delivered to a build, and an investigation whose times are real;
//   - each of those cards draws with its own component, every id in the
//     catalog, so the shots never meet a blank card;
//   - the DM's newest message is still the one it was (the demo's story).
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `bot_parity_seed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

globalThis.window = globalThis.window || {
  App: { user: { id: 9, username: 'viewer' } },
  location: { search: '', hash: '#homeroom-bot' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const COMPONENTS = Object.freeze({
  options: ['options.tsx', 'OptionsCard'],
  questions: ['questions.tsx', 'QuestionsCard'],
  batch: ['batch.tsx', 'BatchCard'],
  build_note: ['build-note.tsx', 'BuildNoteCard'],
  investigation: ['investigation.tsx', 'InvestigationCard'],
});

function drawCard(message, card) {
  const [file, name] = COMPONENTS[card.type];
  const mod = loadTsx(`frontend/src/features/messages/bot-cards/${file}`, {
    stubs: {
      '../../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
      '../../../lib/i18n/runtime': { getLanguage: () => 'en-US' },
      './index': { decideCard: async () => ({ ok: true }), sayAsMe: async () => {} },
    },
  });
  return renderToHtml(createElement(mod[name], { message, conversationId: message.conversationId, card }));
}

test('the staging preview\'s private threads with Homeroom bot, with their new cards', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const staging = require('../src/services/staging-messages');
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  t.after(() => { if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env; });
  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('parity-viewer', 'x', TRUE) RETURNING id, username`,
  );

  const conversationId = await staging.ensureBotDmFixture(pool, viewer);
  assert.ok(conversationId, 'the demo DM is there');
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [conversationId]);
  await staging.ensureBotDmFixture(pool, viewer);
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [conversationId]);
  assert.equal(after.rows[0].n, before.rows[0].n, 'a second opening sends nothing');

  const { rows: threads } = await pool.query(
    `SELECT p.root_message_id, p.kind, p.state, m.metadata->'homeroomBot'->>'kind' AS root_kind,
            (SELECT f.content FROM conversation_messages f
              WHERE f.thread_root_id = p.root_message_id AND f.sender_id = $1 ORDER BY f.id LIMIT 1) AS first_own
       FROM private_threads p JOIN conversation_messages m ON m.id = p.root_message_id
      WHERE p.user_id = $1 ORDER BY p.root_message_id`,
    [viewer.id],
  );
  assert.equal(threads.length, 3, 'three private threads');
  for (const thread of threads) {
    assert.deepEqual([thread.kind, thread.state, thread.root_kind], ['ask', 'open', 'opened_thread']);
    assert.match(thread.first_own, /^Staging demo: /, 'named by the viewer\'s own first words, obviously fake');
  }

  const { rows: replies } = await pool.query(
    `SELECT id, conversation_id, thread_root_id, content, metadata FROM conversation_messages
      WHERE conversation_id = $1 AND thread_root_id = ANY($2::int[]) AND metadata->'homeroomBot' ? 'card'
      ORDER BY id`,
    [conversationId, threads.map((th) => th.root_message_id)],
  );
  const cards = replies.map((r) => r.metadata.homeroomBot.card);
  assert.deepEqual(cards.map((c) => c.type), ['options', 'questions', 'batch', 'build_note', 'investigation']);
  const options = replies[0].metadata.homeroomBot;
  assert.equal(options.looked.items.length, 3, 'the options reply says what it looked at');
  const investigation = cards[4];
  assert.ok(Date.parse(investigation.nextAt) > Date.now(), 'its next check-in is ahead');
  assert.ok(investigation.checkins.every((c) => Date.parse(c.at) < Date.now()), 'its check-ins are behind');
  assert.equal(investigation.checkins[0].hoursAgo, undefined, 'stored with real times only');

  for (const row of replies) {
    const card = row.metadata.homeroomBot.card;
    const message = {
      id: Number(row.id), conversationId: Number(row.conversation_id), content: row.content, deleted: false,
      createdAt: new Date().toISOString(), sender: { id: 2, username: 'homeroom_bot', bot: true },
      attachments: [], objects: [], reactions: [], threadRootId: Number(row.thread_root_id),
      metadata: { homeroomBot: row.metadata.homeroomBot },
    };
    const html = drawCard(message, card);
    assert.ok(html.length > 200, `the ${card.type} card draws`);
    assert.doesNotMatch(html, /botCards\.|messages:/, `every ${card.type} id is in the catalog`);
    assert.doesNotMatch(html, /—|gray-|indigo-/);
  }

  const page = await conversations.listMessages(pool, viewer, conversationId, {});
  const main = [...(page.messages || page)].sort((a, b) => a.id - b.id);
  assert.equal(main.at(-1).metadata?.homeroomBot?.issueNumber, 18, 'the DM still ends with the demo\'s story card');
});
