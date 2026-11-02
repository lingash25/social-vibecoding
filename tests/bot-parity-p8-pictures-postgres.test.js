'use strict';

// Homeroom bot parity, P8 (pictures) and P2 (the compare card in a design
// thread), against the FULL PostgreSQL schema in a throwaway database,
// through the real code: make_pictures (homeroom-bot-thread-tools/
// pictures.js) over services/bot-pictures.js, the gallery and compare cards'
// taps (homeroom-bot-cards/), the designer's compare_versions and
// make_pictures (design-bot.js), and a build's pictures
// (bot-pictures.js generateForSession). The image model is a stubbed fetch,
// the media store an in-memory one, the chat model a script.
//
// What this pins:
//   1. Pictures are kept in the media store, referenced by their own rows,
//      billed to the PERSON (their week of building time counts them), and
//      shown to the chat's members only; the card carries ids, never bytes.
//   2. The weekly picture cap and a used-up week refuse before the model is
//      called.
//   3. A gallery's taps: Use it in the app (a screenshot a request can
//      carry), Propose as the featured picture (the card picture's vote),
//      Add to the design (the design thread's pictures, in the designer's
//      next prompt).
//   4. A build's picture is billed to whoever pays for the build; a build
//      nobody pays for makes none.
//   5. The compare card is stored on a design thread's reply, and Pick
//      patches it.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p8-pictures-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { memoryMediaStore } = require('./lib/media-store');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function png(width, height, salt) {
  const head = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt32BE(salt, 33);
  return head;
}

const CAPTURE = '<!doctype html><html><head></head><body><main><h1 class="title">Plots</h1><button class="save">Save</button></main></body></html>';

function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    seen.push(structuredClone(request.messages));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = (typeof step === 'function' ? step(request) : step).map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
    };
  };
}

test('pictures and the compare card against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `bot_pictures_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  require('../src/services/app-numbers').setPool?.(pool);
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const conversations = require('../src/services/conversations');
  const dm = require('../src/services/homeroom-bot-dm');
  const pictures = require('../src/services/bot-pictures');
  const tool = require('../src/services/homeroom-bot-thread-tools/pictures');
  const cards = require('../src/services/homeroom-bot-cards');
  const designs = require('../src/services/design-threads');
  const designBot = require('../src/services/design-bot');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
       RETURNING id, username`,
      [username, synthetic],
    );
    return { id: row.id, username: row.username, isAdmin: false };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('pic_ada');
  const sam = await user('pic_sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Pear club', 'pic-pear-club', 'running', $1, 'https://github.com/usernode-bot/pic-pear-club', 'public', 'public')
     RETURNING id`,
    [ada.id],
  );
  const { rows: [app] } = await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [app.community_id, ada.id]);
  const config = { selfAppSlug: 'pic-pear-club', openrouterApiBase: 'https://or.test/api/v1', openrouterOrigin: 'https://test' };

  const store = memoryMediaStore();
  const asked = [];
  let salt = 0;
  const imageFetch = async (requestUrl, init) => {
    asked.push(JSON.parse(init.body));
    salt += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png(1024, 1024, salt).toString('base64')}` } }] } }],
      usage: { cost: 0.04 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const botSpend = [];
  const pictureDeps = {
    store, fetch: imageFetch, apiKey: 'sk-test', bot,
    limits: { checkBudget: async () => ({}), recordSpend: async (_p, id, cents) => { botSpend.push([id, cents]); } },
    managedKeys: { usesIncludedKey: async () => true },
    domain: 'h.test',
  };
  const settings = {
    mode: 'shadow', perPerson: 2, pictureWeeklyCap: 6, userWeeklyCents: 5000, adminWeeklyCents: 10000,
    imageModel: 'google/gemini-2.5-flash-image',
  };
  const ws = { pushConversationEvent: () => 0 };
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const conversationId = Number(opened.conversationId);

  let card;
  await t.test('make_pictures keeps every picture in the media store, billed to the person, for the chat\'s members', async () => {
    const ctx = { user: ada, settings, config, conversationId, deps: { pictures: pictureDeps } };
    const out = await tool.run(pool, ctx, 'make_pictures', {
      prompt: 'A pear on a wooden table', count: 2, variants: ['light', 'dark'], for: 'featured', project: 'Pear club',
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.made, 4);
    assert.deepEqual(out.labels, ['A · light', 'A · dark', 'B · light', 'B · dark']);
    assert.equal(asked.length, 4);
    assert.ok(asked.every((b) => b.provider.data_collection === 'deny' && b.messages[0]));
    const textOf = (content) => (typeof content === 'string' ? content : content[0].text);
    assert.ok(asked.every((b) => textOf(b.messages[0].content).startsWith(pictures.CONTENT_RULES)), 'every prompt starts with the content rules');
    assert.equal(asked.filter((b) => Array.isArray(b.messages[0].content)).length, 2, 'each dark one is drawn from its light one');
    card = ctx.card;
    assert.equal(card.type, 'gallery');
    assert.equal(card.canFeature, true, 'the project\'s creator may propose its card picture');
    assert.deepEqual(card.project, { slug: 'pic-pear-club', name: 'Pear club' });
    assert.doesNotMatch(JSON.stringify(card), /base64|data:/, 'no bytes in the card');

    const { rows: [row] } = await pool.query('SELECT * FROM homeroom_bot_pictures');
    assert.equal(row.payer_user_id, ada.id, 'the person pays');
    assert.equal(row.conversation_id, conversationId);
    assert.equal(row.app_id, app.id);
    assert.equal(row.purpose, 'featured');
    assert.equal(row.images, 4);
    assert.equal(Number(row.cost_usd), 0.16);
    const { rows: images } = await pool.query('SELECT id, letter, variant, object_key, width, height FROM homeroom_bot_picture_images ORDER BY letter, variant DESC');
    assert.equal(images.length, 4);
    for (const im of images) {
      assert.match(im.object_key, /^media\/sha256\/[a-f0-9]{64}$/);
      assert.ok(store.files.has(im.object_key), 'in the media store');
      assert.deepEqual([im.width, im.height], [1024, 1024]);
    }
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 16, 'their week of building time counts it');
    assert.equal(await pictures.picturesThisWeek(pool, ada.id), 4);
    assert.deepEqual(botSpend, [[bot.id, 16]], 'and the bot\'s own spend, as every call of its is');
    // The chat's members only.
    assert.ok(await pictures.imageForMember(pool, { userId: ada.id, id: card.images[0].id }));
    assert.equal(await pictures.imageForMember(pool, { userId: sam.id, id: card.images[0].id }), null);
    const row0 = await pictures.imageForMember(pool, { userId: ada.id, id: card.images[0].id });
    assert.equal((await pictures.imageBytes(config, row0, { store })).readUInt32BE(16), 1024);
  });

  await t.test('a picture is served from the media store to the chat\'s members, and to nobody else', async (tt) => {
    tt.mock.method(require('../src/services/media-store'), 'getStore', () => store);
    const express = require('express');
    const { conversationRoutes } = require('../src/routes/conversations');
    const server = express();
    server.use((req, _res, next) => { req.user = req.headers['x-test-user'] === 'sam' ? sam : ada; next(); });
    server.use(conversationRoutes(config, { pool }));
    const listening = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
    tt.after(() => new Promise((resolve) => listening.close(resolve)));
    const at = `http://127.0.0.1:${listening.address().port}${card.images[0].url}`;
    const mine = await fetch(at);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'image/png');
    assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
    assert.match(mine.headers.get('cache-control'), /^private/);
    assert.equal(Buffer.from(await mine.arrayBuffer()).readUInt32BE(16), 1024);
    assert.equal((await fetch(at, { headers: { 'x-test-user': 'sam' } })).status, 404, 'not in the chat');
    assert.equal((await fetch(`http://127.0.0.1:${listening.address().port}/api/conversations/homeroom-bot/pictures/nope`)).status, 404);
  });

  await t.test('the weekly picture cap and a used-up week refuse before the model is called', async () => {
    const before = asked.length;
    const ctx = { user: ada, settings, config, conversationId, deps: { pictures: pictureDeps } };
    const tooMany = await tool.run(pool, ctx, 'make_pictures', { prompt: 'A pear', count: 3 });
    assert.match(tooMany.error, /^You have 2 pictures left this week: ask for that many or fewer\./);
    const spent = await tool.run(pool, { ...ctx, settings: { ...settings, userWeeklyCents: 10 } }, 'make_pictures', { prompt: 'A pear' });
    assert.match(spent.error, /Your building time for this week is used up/);
    const rules = await tool.run(pool, ctx, 'make_pictures', { prompt: 'A pear holding a gun' });
    assert.match(rules.error, /content rules/);
    assert.equal(asked.length, before, 'nothing was asked of the model');
    assert.equal(await pictures.picturesThisWeek(pool, ada.id), 4, 'nothing was counted');
  });

  let messageId;
  await t.test('Use it in the app keeps the picture as a screenshot a request can carry, and the card says so', async () => {
    const sent = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Here are four pictures of a pear.', threadRootId: false, moment: null,
      metadata: { kind: 'chat', card },
    });
    messageId = sent.messageId;
    const out = await cards.decide(pool, config, { user: ada, messageId, action: 'use', value: card.images[0].id, deps: { ...pictureDeps, ws } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.url, /^https:\/\/h\.test\/issue-images\/[a-f0-9]{32}$/);
    const id = out.url.split('/').pop();
    const { rows: [shot] } = await pool.query('SELECT user_id, content_type, size_bytes, data FROM issue_screenshots WHERE id = $1', [id]);
    assert.equal(shot.user_id, ada.id);
    assert.equal(shot.content_type, 'image/png');
    assert.equal(shot.data.readUInt32BE(16), 1024);
    const { rows: [msg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [messageId]);
    assert.deepEqual(msg.metadata.homeroomBot.card.used, [{ id: card.images[0].id, url: out.url }]);
    // Somebody not in the chat cannot tap it.
    assert.equal((await cards.decide(pool, config, { user: sam, messageId, action: 'use', value: card.images[0].id, deps: { ...pictureDeps, ws } })).status, 404);
  });

  await t.test('Propose A as the featured picture opens the card picture\'s vote, its dark one with it', async () => {
    const out = await cards.decide(pool, config, { user: ada, messageId, action: 'feature', value: card.images[0].id, deps: { ...pictureDeps, ws } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.proposal.href, /^#app\/pic-pear-club\/dev\/governance\/\d+$/);
    const { rows: [issue] } = await pool.query("SELECT id, kind, payload, created_by FROM issues WHERE kind = 'featured_illustration'");
    assert.equal(issue.created_by, ada.id);
    assert.match(issue.payload.proposed.url, /^\/app-illustrations\/[a-f0-9]{32}$/);
    assert.match(issue.payload.proposed.darkUrl, /^\/app-illustrations\/[a-f0-9]{32}$/);
    const { rows: [held] } = await pool.query('SELECT content_type, data, dark_data FROM app_illustration_proposals WHERE issue_id = $1', [issue.id]);
    assert.equal(held.content_type, 'image/png');
    assert.ok(held.data.length > 0 && held.dark_data.length > 0);
    const { rows: [msg] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [messageId]);
    assert.equal(msg.metadata.homeroomBot.card.featured.letter, 'A');
    // Not theirs to propose: somebody who is not the project's.
    const samChat = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const theirs = await dm.sendDm(pool, { bot, userId: sam.id, content: 'Pictures.', threadRootId: false, moment: null, metadata: { kind: 'chat', card } });
    assert.ok(samChat && theirs.messageId);
    const refused = await cards.decide(pool, config, { user: sam, messageId: theirs.messageId, action: 'feature', value: card.images[2].id, deps: { ...pictureDeps, ws } });
    assert.equal(refused.ok, false);
    assert.ok([403, 404].includes(refused.status), JSON.stringify(refused));
  });

  await t.test('a build\'s picture is billed to whoever pays for the build; one nobody pays for makes none', async () => {
    const { rows: [own] } = await pool.query('INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, sam.id]);
    const made = await pictures.generateForSession(pool, config, { sessionId: own.id, prompt: 'A pear for the hero', aspect: 'wide', deps: { ...pictureDeps, homeroomBot: { readSettings: async () => settings } } });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.image.contentType, 'image/png');
    assert.equal(asked[asked.length - 1].image_config.aspect_ratio, '16:9');
    const { rows: [paid] } = await pool.query('SELECT payer_user_id, session_id, purpose FROM homeroom_bot_pictures WHERE session_id = $1', [own.id]);
    assert.deepEqual([paid.payer_user_id, paid.purpose], [sam.id, 'build'], 'their own session: they pay');
    // The bot's build of Ada's request: Ada's week pays.
    const { rows: [built] } = await pool.query('INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, bot.id]);
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 5, $2)', [app.id, ada.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, charged, build_session_id) VALUES ($1, 5, 'live', 'ready', TRUE, $2)`,
      [app.id, built.id],
    );
    assert.deepEqual(await pictures.sessionPayer(pool, built.id), { sessionId: built.id, appId: app.id, payerId: ada.id });
    // A shadow build: nobody pays, so nothing is made.
    const { rows: [shadow] } = await pool.query('INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, charged, build_session_id) VALUES ($1, 6, 'shadow', 'ready', FALSE, $2)`,
      [app.id, shadow.id],
    );
    const none = await pictures.generateForSession(pool, config, { sessionId: shadow.id, prompt: 'A pear', deps: { ...pictureDeps, homeroomBot: { readSettings: async () => settings } } });
    assert.equal(none.status, 402);
  });

  // ── P2 and P8 in a design thread ────────────────────────────────────────
  const deps = {
    bot,
    github: { isEnabled: () => true, safeMention: (s) => s },
    ws: { sendSystemMessage: async () => null, sendBotMessage: async () => ({ id: 1 }), pushIssueUpdate: () => {}, pushConversationEvent: () => 0 },
  };
  let design;
  await t.test('the designer\'s comparison is a card on its reply, and Pick patches it', async () => {
    const started = await designs.startDesign(pool, config, {
      user: ada, html: CAPTURE, surface: 'platform', title: 'Plots', width: 390, height: 844, deps,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    design = await designs.designFor(pool, { userId: ada.id, rootId: started.rootId });
    const ask = async (content) => (await conversations.sendMessage(pool, ada, design.conversationId, { content, thread_root_id: design.rootId })).message;
    await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: design.conversationId, message: await ask('make the title bigger'), design,
      deps: {
        ...deps, apiKey: 'sk-test', seesImages: false,
        chat: scripted([
          [['edit_design', { edits: [{ find: '<h1 class="title">', replace: '<h1 class="title" style="font-size:40px">' }], note: 'A bigger title' }]],
          [['reply', { text: 'The title is bigger.' }]],
        ]),
      },
    });
    design = await designs.designFor(pool, { userId: ada.id, rootId: design.rootId });
    assert.equal(design.latest, 2);
    const seen = [];
    const sent = await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: design.conversationId, message: await ask('show it next to how it looks now'), design,
      deps: {
        ...deps, apiKey: 'sk-test', seesImages: false,
        chat: scripted([
          [['compare_versions', { versions: [2], now: true, labels: ['Bigger title'] }]],
          [['reply', { text: 'Here they are side by side: pick the one you like.' }]],
        ], seen),
      },
    });
    assert.match(seen[0][0].content, /call\n {2}compare_versions/);
    const { rows: [reply] } = await pool.query('SELECT content, thread_root_id, metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(reply.thread_root_id, design.rootId);
    assert.equal(reply.content, 'Here they are side by side: pick the one you like.');
    assert.deepEqual(reply.metadata.homeroomBot.card, {
      type: 'compare', v: 1, rootId: design.rootId, title: 'Plots', picked: null,
      items: [{ version: 'now', label: 'Now' }, { version: 2, label: 'Bigger title' }],
    });
    assert.equal((await designs.designFor(pool, { userId: ada.id, rootId: design.rootId })).latest, 2, 'a comparison makes no version');
    const picked = await cards.decide(pool, config, { user: ada, messageId: sent.messageId, action: 'pick', value: 2, deps: { ws } });
    assert.deepEqual(picked, { ok: true, picked: 2 });
    const { rows: [after] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    assert.equal(after.metadata.homeroomBot.card.picked, 2);
    assert.equal((await cards.decide(pool, config, { user: ada, messageId: sent.messageId, action: 'pick', value: 3, deps: { ws } })).status, 404);
  });

  await t.test('pictures in a design thread: a gallery for the design, Add to the design, and the designer is told', async () => {
    const message = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'make a pear picture for the top', thread_root_id: design.rootId })).message;
    const sent = await designBot.answer(pool, config, {
      bot, user: ada, settings: { ...settings, pictureWeeklyCap: 20 }, conversationId: design.conversationId, message, design,
      deps: {
        ...deps, apiKey: 'sk-test', seesImages: false, pictures: pictureDeps,
        chat: scripted([
          [['make_pictures', { prompt: 'A pear, flat illustration' }]],
          [['reply', { text: 'Here is a pear for the top of the screen.' }]],
        ]),
      },
    });
    const { rows: [reply] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [sent.messageId]);
    const gallery = reply.metadata.homeroomBot.card;
    assert.equal(gallery.type, 'gallery');
    assert.equal(gallery.designRootId, design.rootId);
    assert.equal(gallery.purpose, 'design');
    const added = await cards.decide(pool, config, { user: ada, messageId: sent.messageId, action: 'design', value: gallery.images[0].id, deps: { ...pictureDeps, ws } });
    assert.equal(added.ok, true, JSON.stringify(added));
    const { rows: [thread] } = await pool.query('SELECT pictures FROM design_threads WHERE private_thread_id = $1', [design.threadId]);
    assert.deepEqual(thread.pictures.map((p) => p.id), [gallery.images[0].id]);
    // The next turn's prompt names it, by its address.
    const seen = [];
    const next = (await conversations.sendMessage(pool, ada, design.conversationId, { content: 'Add picture A to the design.', thread_root_id: design.rootId })).message;
    await designBot.answer(pool, config, {
      bot, user: ada, settings, conversationId: design.conversationId, message: next, design,
      deps: { ...deps, apiKey: 'sk-test', seesImages: false, chat: scripted([[['reply', { text: 'Done.' }]]], seen) },
    });
    assert.match(seen[0][0].content, new RegExp(`- Picture A: /api/conversations/homeroom-bot/pictures/${gallery.images[0].id} \\(1024 by 1024\\)`));
  });
});
