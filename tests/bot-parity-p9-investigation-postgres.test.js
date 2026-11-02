'use strict';

// Homeroom bot parity, P3 and P9, against the full PostgreSQL schema: a
// look_into from a chat, run as the bot-look machine's work (inline, and
// posted when the chat stopped waiting), and an investigation's whole life
// on the bot-investigation machine: offered, started from its card, a
// check-in (its look faked), the next one by its deadline, Stop, and its
// ends by answer, budget and the bot turned off. The worker turn is the one
// thing faked (lookInto), with the chat's sending (sendDm) and the sockets.
// What is checked is everything around it: the rows, the card under the
// reply, the posts, the money, and that a check-in never runs twice across
// a failure, a replayed deadline or a new process.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-parity-p9-investigation-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { botInvestigation, MACHINE, investigationKey, WORK } = require('../src/workflow/bot-investigation/machine.ts');
const { botInvestigationServices } = require('../src/workflow/bot-investigation/services.ts');
const { botLook, MACHINE: LOOK_MACHINE } = require('../src/workflow/bot-look/machine.ts');
const { botLookServices } = require('../src/workflow/bot-look/services.ts');
const look = require('../src/services/homeroom-bot-thread-tools/look-into');
const inv = require('../src/services/homeroom-bot-thread-tools/investigate');
const cards = require('../src/services/homeroom-bot-cards');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HOUR = 60 * 60 * 1000;

test('looks into code and investigations, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_parity_p9_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  const runtimes = [];
  t.after(async () => {
    for (const rt of runtimes) await rt.stop().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function person(prefix, { synthetic = false } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic]);
    return { id: Number(u.id), username: u.username, isAdmin: false };
  }
  const bot = await person('homeroom_bot', { synthetic: true });
  const ada = await person('ada');
  const sam = await person('sam');
  async function project(slug, owner, { visibility = 'public' } = {}) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $5) RETURNING *`,
      [slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), slug, owner.id, `https://github.com/acme/${slug}`, visibility]);
    return a;
  }
  const gym = await project('gym-tracker', ada);
  const secret = await project('secret-garden', sam, { visibility: 'private' });
  const paused = await project('paused-pond', ada);
  const { rows: [conv] } = await pool.query(`INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`, [ada.id]);
  const conversationId = Number(conv.id);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [conversationId, ada.id, bot.id]);
  async function said(sender, content, metadata = {}) {
    const { rows: [m] } = await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata) VALUES ($1, $2, $3, $4) RETURNING id`,
      [conversationId, sender.id, content, JSON.stringify(metadata)]);
    return Number(m.id);
  }

  // ── Fakes: the worker turn, the chat's sending, the sockets, the gates' outside reads ──
  const settings = { mode: 'live', pausedApps: ['paused-pond'] };
  const looks = [];
  const lookScripts = [];
  const posts = [];
  let failPosts = 0;
  const deps = {
    settings,
    live: { isLiveFor: () => true },
    limits: { checkBudget: async () => ({}) },
    botSvc: { readSettings: async () => settings, ensureBotUser: async () => bot },
    bot,
    ws: { pushConversationEvent: () => 1 },
    worker: { stopTurn: async () => {} },
    dm: {
      overWeeklyAllowance: async () => false,
      async sendDm(_pool, args) {
        if (failPosts > 0) { failPosts -= 1; throw new Error('the chat could not take it just now'); }
        posts.push(args);
        return { messageId: 9000 + posts.length };
      },
    },
    async lookInto(_pool, _config, args) {
      looks.push({ question: args.question, notes: args.notes, since: args.since, app: args.app.slug, user: args.user.id });
      const next = lookScripts.shift() || {};
      return {
        ok: true, summary: 'The sync check fails when two saves land in the same second.', line: 'Two saves in one second.',
        answered: false, worth: false, filesRead: 3, files: ['src/sync.js', 'src/store.js', 'test/sync.test.js'], checks: [],
        ms: 90000, costUsd: 0.12, model: 'deepseek/deepseek-v4.1-flash', ...next,
      };
    },
  };
  const real = { ...botInvestigationServices({ config: {}, pool, deps }), ...botLookServices({ config: {}, pool, deps }) };
  const services = Object.fromEntries(Object.entries(real).map(([k, h]) => [k, { ...h, backoffMs: () => 0 }]));
  const runtimeNow = () => {
    const rt = createRuntime({ pool, machines: [botInvestigation(), botLook()], services, pollMs: 50, publish: async () => {} });
    runtimes.push(rt);
    return rt;
  };
  let rt = runtimeNow();
  const round = async (r = rt) => { await r.drain(); const n = await r.runServices(); await r.drain(); return n; };
  const settle = async (r = rt) => {
    for (let i = 0; i < 40; i += 1) if (!(await round(r))) return;
    assert.fail('the work never settled');
  };
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try { await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT'); } finally { cl.release(); }
  };
  const fire = async (id, r = rt) => {
    await asTransition((cl) => cl.query(
      'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2 AND deadline_at IS NOT NULL', [MACHINE, investigationKey(id)]));
    assert.ok((await r.fireTimers()) >= 1, 'a deadline was due');
    await settle(r);
  };
  const row = async (id) => (await pool.query('SELECT * FROM homeroom_bot_investigations WHERE id = $1', [id])).rows[0];
  const inst = async (id) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, investigationKey(id)])).rows[0];
  const cardOf = async (messageId) => (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [messageId])).rows[0].metadata.homeroomBot.card;
  const checkInItems = async (id) => (await pool.query(
    'SELECT work_key, status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at', [MACHINE, investigationKey(id), WORK.checkIn])).rows;
  const ctxFor = (user, messageId, extra = {}) => ({
    user, settings, config: {}, bot, deps: { ...deps, ...extra }, conversationId, messageId, appIds: new Set(),
  });
  // An investigation offered in the chat, its card under the bot's reply.
  async function offer(user = ada, args = {}) {
    const asked = await said(user, 'Can you keep an eye on the flaky sync check?');
    const ctx = ctxFor(user, asked);
    const out = await inv.run(pool, ctx, 'start_investigation', { project: 'gym-tracker', goal: 'Find out why the sync check fails now and then.', ...args });
    assert.equal(out.ok, true, JSON.stringify(out));
    const reply = await said(bot, 'I can watch it for a few days.', { homeroomBot: { kind: 'chat', card: ctx.card } });
    return { id: ctx.card.investigationId, reply, ctx, asked };
  }
  const tap = (user, messageId, action) => cards.decide(pool, {}, { user, messageId, action, deps });

  // ── P3: a look from the chat ─────────────────────────────────────────

  await t.test('a look the chat waits for comes back inline, with what it looked at, and counts as building time', async () => {
    const messageId = await said(ada, 'How does the sync work?');
    const ctx = ctxFor(ada, messageId, { lookPollMs: 1, lookSleep: () => settle() });
    const out = await look.run(pool, ctx, 'look_into', { project: 'Gym Tracker', question: 'How does the sync decide which save wins?' });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.summary, 'The sync check fails when two saves land in the same second.');
    assert.deepEqual(out.filesRead, { count: 3, some: ['src/sync.js', 'src/store.js', 'test/sync.test.js'] });
    assert.deepEqual(ctx.looked, [{ what: 'Read 3 files in Gym Tracker' }]);
    assert.ok(!ctx.lookRunning);
    const { rows: [r] } = await pool.query('SELECT * FROM homeroom_bot_looks WHERE message_id = $1', [messageId]);
    assert.equal(r.state, 'done');
    assert.equal(r.deliver, 'inline');
    assert.equal(Number(r.cost_usd), 0.12);
    assert.equal(posts.length, 0, 'nothing is posted for a look the chat answered with');
    assert.equal((await pool.query(`SELECT state FROM wf_instances WHERE machine = $1`, [LOOK_MACHINE])).rows[0].state, 'done');
    assert.equal(await require('../src/services/homeroom-bot-dm').weeklySpentCents(pool, ada.id), 12, 'its cost is their building time');
    // Asked again by a retry of the same answer: the same look, not a second.
    const again = await look.run(pool, ctxFor(ada, messageId, { lookPollMs: 1, lookSleep: () => settle() }), 'look_into', { project: 'gym-tracker', question: 'How does the sync decide which save wins?' });
    assert.equal(again.ok, true);
    assert.equal(looks.length, 1);
  });

  await t.test('a look that outlasts the wait goes on, says so this turn, and is posted in the chat when it ends', async () => {
    const before = posts.length;
    const messageId = await said(ada, 'Why does the sync check fail?');
    const ctx = ctxFor(ada, messageId, { lookWaitMs: 0 });
    const out = await look.run(pool, ctx, 'look_into', { project: 'gym-tracker', question: 'Why does the sync check fail now and then?' });
    assert.equal(out.running, true);
    assert.equal(ctx.lookRunning, true, 'the claims check may let "I\'ll post what I find here" through');
    assert.equal((await pool.query('SELECT deliver FROM homeroom_bot_looks WHERE message_id = $1', [messageId])).rows[0].deliver, 'post');
    await settle();
    assert.equal(posts.length, before + 1);
    const post = posts.at(-1);
    assert.match(post.content, /^I finished looking into it in Gym Tracker\.\n\nThe sync check fails/);
    assert.equal(post.replyToId, messageId);
    assert.equal(post.moment, 'reply');
    assert.equal(post.idempotencyKey, `hrbot-look:${(await pool.query('SELECT id FROM homeroom_bot_looks WHERE message_id = $1', [messageId])).rows[0].id}`);
    assert.deepEqual(post.metadata.looked.items, [{ what: 'Read 3 files in Gym Tracker' }]);
    assert.ok(Number((await pool.query('SELECT posted_message_id FROM homeroom_bot_looks WHERE message_id = $1', [messageId])).rows[0].posted_message_id) > 0);
    // A retry of that same answer neither waits again nor looks again.
    const retried = await look.run(pool, ctxFor(ada, messageId), 'look_into', { project: 'gym-tracker', question: 'Why does the sync check fail now and then?' });
    assert.equal(retried.ok, true);
    assert.match(retried.note, /posted in this chat already/);
    assert.equal(posts.length, before + 1);
  });

  await t.test('a look is refused: someone else\'s private project, a paused one, the bot off, one already running', async () => {
    const m = await said(ada, 'look');
    assert.match((await look.run(pool, ctxFor(ada, m), 'look_into', { project: 'secret-garden', question: 'How does watering work?' })).error, /No such project/);
    assert.match((await look.run(pool, ctxFor(ada, m), 'look_into', { project: 'paused-pond', question: 'How does the pond fill?' })).error, /not working on that project/);
    const off = { ...ctxFor(ada, m), settings: { mode: 'off' } };
    assert.match((await look.run(pool, off, 'look_into', { project: 'gym-tracker', question: 'How does the sync work?' })).error, /turned off/);
    const { rows: [busy] } = await pool.query(
      `INSERT INTO homeroom_bot_looks (user_id, app_id, question) VALUES ($1, $2, 'another') RETURNING id`, [ada.id, gym.id]);
    assert.match((await look.run(pool, ctxFor(ada, m), 'look_into', { project: 'gym-tracker', question: 'How does the sync work?' })).error, /still running/);
    await pool.query(`UPDATE homeroom_bot_looks SET state = 'failed' WHERE id = $1`, [busy.id]);
  });

  await t.test('a person\'s look session is never the project\'s triage session', async () => {
    const session = await look.lookSession(pool, {}, { bot, app: gym, user: ada, model: 'deepseek/deepseek-v4.1-flash' });
    assert.equal(session.branch_name, 'main');
    const again = await look.lookSession(pool, {}, { bot, app: gym, user: ada, model: 'deepseek/deepseek-v4.1-flash' });
    assert.equal(again.id, session.id, 'one per person and project');
    const triage = await require('../src/services/homeroom-bot').ensureBotSession(pool, {}, bot, gym);
    assert.notEqual(triage.id, session.id);
  });

  // ── P9: an investigation ─────────────────────────────────────────────

  await t.test('offered, nothing runs; Not now sets it aside', async () => {
    const { id, reply, ctx } = await offer();
    assert.equal(ctx.card.state, 'proposed');
    assert.deepEqual([ctx.card.everyHours, ctx.card.days, ctx.card.budgetCents], [6, 5, 300]);
    assert.equal((await row(id)).state, 'proposed');
    assert.equal(await inst(id), undefined, 'no instance before Start');
    assert.equal((await tap(sam, reply, 'start')).status, 404, 'only its owner taps it');
    const out = await tap(ada, reply, 'not_now');
    assert.equal(out.ok, true);
    assert.equal((await row(id)).state, 'declined');
    assert.equal((await cardOf(reply)).state, 'declined');
    assert.equal((await tap(ada, reply, 'start')).status, 409);
  });

  let first;
  await t.test('Start runs the first check-in at once: notes, a quiet update, the card, the money', async () => {
    const before = { looks: looks.length, posts: posts.length };
    first = await offer();
    const out = await tap(ada, first.reply, 'start');
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal((await cardOf(first.reply)).state, 'running');
    await settle();
    const r = await row(first.id);
    assert.equal(r.state, 'running');
    assert.equal(r.spent_cents, 12);
    assert.equal(Number(r.card_message_id), first.reply);
    assert.equal(r.checkins.length, 1);
    assert.match(r.notes, /^Check-in 1 \(.+\):\nThe sync check fails when two saves land in the same second\.$/);
    assert.ok(Math.abs(new Date(r.next_at).getTime() - Date.now() - 6 * HOUR) < 60000, 'the next one six hours on');
    assert.equal(looks.length, before.looks + 1);
    assert.deepEqual(looks.at(-1), { question: 'Find out why the sync check fails now and then.', notes: '', since: null, app: 'gym-tracker', user: ada.id });
    assert.equal(posts.length, before.posts + 1);
    assert.match(posts.at(-1).content, /^Check-in 1 of your investigation: Two saves in one second\./);
    assert.equal(posts.at(-1).moment, null, 'nothing worth acting on: it rings nothing');
    assert.equal(posts.at(-1).idempotencyKey, `hrbot-investigation:${first.id}:1`);
    const card = await cardOf(first.reply);
    assert.equal(card.state, 'running');
    assert.equal(card.spentCents, 12);
    assert.equal(card.checkinsDone, 1);
    assert.equal(card.checkins.length, 1);
    assert.equal(card.checkins[0].line, 'Two saves in one second.');
    assert.match(card.notes, /two saves land in the same second/);
    assert.equal((await inst(first.id)).state, 'waiting');
    assert.ok((await inst(first.id)).deadline_at, 'its next check-in is the instance\'s deadline');
    // Counted as their building time, with the chat's looks.
    assert.equal(await require('../src/services/homeroom-bot-dm').weeklySpentCents(pool, ada.id), 36);
  });

  await t.test('its deadline runs the next check-in, with the notes and the time of the last; worth acting on rings', async () => {
    lookScripts.push({ worth: true, line: 'It failed again at 3am: two saves in one second.' });
    await fire(first.id);
    assert.deepEqual((await checkInItems(first.id)).map((w) => w.work_key), ['checkin:1', 'checkin:2']);
    const asked = looks.at(-1);
    assert.match(asked.notes, /Check-in 1/);
    assert.equal(asked.since, (await row(first.id)).checkins[0].at);
    assert.equal(posts.at(-1).moment, 'reply');
    assert.equal(posts.at(-1).metadata.kind, 'chat');
    assert.equal((await row(first.id)).spent_cents, 24);
    assert.equal((await cardOf(first.reply)).checkins.length, 2);
    // A deadline is fired once per version: nothing is due, nothing runs twice.
    assert.equal(await rt.fireTimers(), 0);
    await settle();
    assert.equal((await checkInItems(first.id)).length, 2);
  });

  await t.test('Stop ends it: the card says so, nothing more runs, nothing is said', async () => {
    const before = posts.length;
    const out = await tap(ada, first.reply, 'stop');
    assert.equal(out.ok, true);
    await settle();
    const r = await row(first.id);
    assert.deepEqual([r.state, r.ended_reason, r.next_at], ['ended', 'stopped', null]);
    assert.equal((await inst(first.id)).state, 'ended');
    assert.equal((await inst(first.id)).deadline_at, null);
    const card = await cardOf(first.reply);
    assert.deepEqual([card.state, card.endedReason, card.nextAt], ['ended', 'stopped', null]);
    assert.equal(posts.length, before, 'a Stop is theirs: no message');
    assert.equal((await tap(ada, first.reply, 'stop')).status, 409);
    // What it found, for the chat to answer "File what it found" from.
    const read = await inv.run(pool, ctxFor(ada, await said(ada, 'File what the investigation found')), 'read_investigation', {});
    assert.equal(read.ok, true);
    const mine = read.investigations.find((i) => i.goal === 'Find out why the sync check fails now and then.' && i.checkIns === 2);
    assert.ok(mine, JSON.stringify(read));
    assert.equal(mine.state, 'ended (stopped)');
    assert.match(mine.found, /Check-in 1[\s\S]*Check-in 2/);
    const theirs = await inv.run(pool, ctxFor(sam, await said(sam, 'what did it find?')), 'read_investigation', {});
    assert.deepEqual(theirs.investigations, [], 'only their own');
  });

  await t.test('a check-in that failed after its look carries on from its checkpoint: one look, one note, one update', async () => {
    const { id, reply } = await offer();
    const before = { looks: looks.length, posts: posts.length };
    failPosts = 1;
    await tap(ada, reply, 'start');
    await settle();
    assert.equal(looks.length, before.looks + 1, 'the look ran once across both tries');
    assert.equal(posts.length, before.posts + 1, 'and its update was said once');
    const items = await pool.query('SELECT attempt_count, status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3', [MACHINE, investigationKey(id), WORK.checkIn]);
    assert.equal(items.rows[0].attempt_count, 2);
    assert.equal((await row(id)).checkins.length, 1);
    assert.equal((await row(id)).spent_cents, 12);
    // At most two of one person's at once: a third cannot start, nor be offered.
    const second = await offer();
    assert.equal((await tap(ada, second.reply, 'start')).ok, true);
    await settle();
    const m = await said(ada, 'and another one');
    assert.match((await inv.run(pool, ctxFor(ada, m), 'start_investigation', { project: 'gym-tracker', goal: 'Watch the sign-up errors too.' })).error, /already have 2 investigations running/);
    await pool.query(`UPDATE homeroom_bot_investigations SET state = 'proposed' WHERE id = $1`, [first.id]);
    assert.equal((await tap(ada, first.reply, 'start')).status, 409, 'a card cannot start a third');
    await pool.query(`UPDATE homeroom_bot_investigations SET state = 'ended' WHERE id = $1`, [first.id]);
    for (const r of [reply, second.reply]) await tap(ada, r, 'stop');
    await settle();
  });

  await t.test('a check-in owed when the process went is run by the next one, once', async () => {
    const { id, reply } = await offer();
    const before = looks.length;
    await tap(ada, reply, 'start');
    await rt.drain();                    // Started decided: its check-in is owed
    assert.equal((await checkInItems(id))[0].status, 'queued');
    await rt.stop();                     // the process goes
    rt = runtimeNow();                   // and a new one starts
    await settle();
    assert.equal(looks.length, before + 1);
    assert.equal((await row(id)).checkins.length, 1);
    assert.equal((await inst(id)).state, 'waiting');
    await tap(ada, reply, 'stop');
    await settle();
  });

  await t.test('it ends on its own: answered, out of budget, the bot turned off; each said once, the card says why', async () => {
    // Answered.
    const a = await offer();
    lookScripts.push({ answered: true, line: 'Found it: two saves in one second.' });
    await tap(ada, a.reply, 'start');
    await settle();
    assert.deepEqual([(await row(a.id)).state, (await row(a.id)).ended_reason], ['ended', 'answered']);
    assert.match(posts.at(-1).content, /has ended: it found the answer/);
    assert.equal(posts.at(-1).moment, 'reply');
    assert.equal((await cardOf(a.reply)).endedReason, 'answered');
    // Out of budget.
    const b = await offer(ada, { budgetDollars: 0.25 });
    lookScripts.push({ costUsd: 0.3 });
    await tap(ada, b.reply, 'start');
    await settle();
    assert.deepEqual([(await row(b.id)).ended_reason, (await row(b.id)).spent_cents], ['budget', 30]);
    assert.match(posts.at(-1).content, /used all of its budget/);
    assert.equal(posts.at(-1).moment, null);
    // The bot turned off between check-ins: the next one ends it, and runs no look.
    const c = await offer();
    await tap(ada, c.reply, 'start');
    await settle();
    const looked = looks.length;
    settings.mode = 'off';
    try {
      await fire(c.id);
    } finally { settings.mode = 'live'; }
    assert.equal(looks.length, looked);
    assert.deepEqual([(await row(c.id)).state, (await row(c.id)).ended_reason], ['ended', 'bot_off']);
    assert.match(posts.at(-1).content, /Homeroom bot was turned off/);
    // Said once: the end's work again changes nothing.
    const n = posts.filter((p) => p.idempotencyKey === `hrbot-investigation:${c.id}:ended`).length;
    assert.equal(n, 1);
  });

  await t.test('a paused project and a gone one are refused at the offer', async () => {
    const m = await said(ada, 'watch the pond');
    assert.match((await inv.run(pool, ctxFor(ada, m), 'start_investigation', { project: 'paused-pond', goal: 'Find out why the pond drains.' })).error, /not working on that project just now, so it cannot run an investigation on it/);
    assert.match((await inv.run(pool, ctxFor(ada, m), 'start_investigation', { project: 'secret-garden', goal: 'Find out why the garden dries.' })).error, /No such project/);
    assert.match((await inv.run(pool, ctxFor(ada, m), 'start_investigation', { project: 'gym-tracker', goal: 'Watch the sync check.', everyHours: 48 })).error, /1 to 24 hours/);
    void paused; void secret;
  });
});
