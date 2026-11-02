'use strict';

// Homeroom bot parity, P9: investigations that run for days. See ./index.js
// for this module's shape.
//
// Some questions are answered by watching: a check that fails now and then,
// whether a change helped, how a feature is used over a week. The bot can
// offer one (start_investigation): a goal on one project the person can
// build on, a check-in every few hours (6 by default, 1 to 24), for up to so
// many days (5, at most 14), within its own budget ($3, at most $10). It
// puts a card under its reply (type 'investigation', state 'proposed') with
// Start and Not now; nothing runs or spends until they tap Start
// (../homeroom-bot-cards/investigation.js). At most MAX_RUNNING of one
// person's run at once.
//
// From Start, the bot-investigation machine owns it
// (src/workflow/bot-investigation/): each check-in is ONE look into the
// project's code (./look-into.js lookInto, on the platform's cheap model),
// asked the goal, the notes so far and what changed since the last check-in.
// What it found is added to the notes, a short update is said in the same
// thread (ringing only when it found something worth acting on), and the
// card shows day N of M, what is spent of the budget, the next check-in and
// the last three. It ends when a look says the question is answered, the
// budget or the days run out, they tap Stop, the bot is turned off or stops
// working on the project; the card then says why. Every check-in counts
// toward their building time like any look, and its own budget is theirs to
// see on the card in money (the bot's chat words never name money).

const log = require('../logger');
const { withoutEmDashes } = require('../em-dashes');
const rules = require('../../workflow/rules/investigation.ts');

const TOOL = 'start_investigation';
const READ = 'read_investigation';
const MACHINE = 'bot-investigation';
const MAX_NOTES_CHARS = 16000;
const CARD_NOTES_CHARS = 3000;
const CARD_CHECKINS = 3;
const MAX_LINE_CHARS = 200;

const look = () => require('./look-into');
const clip = (value, max) => {
  const s = String(value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// ── Pure ───────────────────────────────────────────────────────────────────

const VENDOR_WORDS = Object.freeze({ deepseek: 'DeepSeek', glm: 'GLM', gpt: 'GPT', claude: 'Claude', qwen: 'Qwen', kimi: 'Kimi', gemini: 'Gemini' });

/** Pure: a model id as a person reads it ("deepseek/deepseek-v4.1-flash" is "DeepSeek V4.1 Flash"). */
function modelName(model) {
  const tail = String(model || '').split('/').pop().replace(/[:@].*$/, '');
  if (!tail) return null;
  return tail.split(/[-_]+/).filter(Boolean).map((w) => {
    const lower = w.toLowerCase();
    if (VENDOR_WORDS[lower]) return VENDOR_WORDS[lower];
    if (/^v?\d/.test(lower)) return lower.replace(/^v/, 'V');
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ').slice(0, 60);
}

/** Pure: the card a proposed investigation puts under the bot's reply. */
function proposedCard(row, app, model = null) {
  return {
    type: 'investigation', v: 1,
    investigationId: Number(row.id),
    state: 'proposed',
    goal: clip(row.goal, rules.MAX_GOAL_CHARS),
    project: { slug: app.slug, name: app.name || app.slug },
    everyHours: Number(row.every_hours), days: Number(row.days),
    budgetCents: Number(row.budget_cents), spentCents: 0,
    ...(modelName(model) ? { model: modelName(model) } : {}),
  };
}

/** Pure: what of the row the card shows: the last check-ins (time and one line) and the notes' end. */
function rowParts(inv) {
  const checkins = (Array.isArray(inv?.checkins) ? inv.checkins : [])
    .filter((c) => c && typeof c === 'object' && c.at)
    .slice(-CARD_CHECKINS)
    .map((c) => ({ at: String(c.at), line: clip(c.line || '', MAX_LINE_CHARS), ...(c.worth ? { worth: true } : {}), ...(c.skipped ? { skipped: true } : {}) }));
  const notes = String(inv?.notes || '').trim();
  return { checkins, notes: notes.length > CARD_NOTES_CHARS ? `…${notes.slice(-CARD_NOTES_CHARS)}` : notes };
}

/** Pure: when the last check-in that ran was, or null. */
function lastRanAt(checkins) {
  const ran = (Array.isArray(checkins) ? checkins : []).filter((c) => c && c.at && !c.skipped);
  return ran.length ? String(ran[ran.length - 1].at) : null;
}

// Why a check-in did not run, said on its row of the card's timeline.
const SKIP_LINES = Object.freeze({
  allowance: 'Skipped: your building time for the week is used up.',
  bot_budget: 'Skipped: Homeroom bot has used its own time for the week.',
});

// Its end, as the bot says it in the chat (none for a Stop: they did it).
const ENDED_WORDS = Object.freeze({
  answered: 'it found the answer',
  budget: 'it used all of its budget',
  days: 'it ran for all of its days',
  bot_off: 'Homeroom bot was turned off',
  paused: 'Homeroom bot stopped working on that project',
  gone: 'you can no longer build on that project',
  failed: 'its check-ins kept failing',
});

/** Pure: the bot's words when an investigation ends, or null for one they stopped. */
function endedText(reason, goal) {
  const why = ENDED_WORDS[reason];
  if (!why) return null;
  const about = clip(goal, 120);
  return withoutEmDashes(`Your investigation "${about}" has ended: ${why}. Its card has everything it found.`);
}

/** Pure: a check-in's short update in the chat. */
function updateText({ n, line, ok }) {
  const said = clip(line || '', MAX_LINE_CHARS) || (ok ? 'nothing new this time.' : 'this check-in did not finish.');
  return withoutEmDashes(`Check-in ${n} of your investigation: ${said}`);
}

// ── Reads and writes ─────────────────────────────────────────────────────

async function load(pool, id) {
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_investigations WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

async function runningCount(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM homeroom_bot_investigations WHERE user_id = $1 AND state = 'running'`, [userId],
  );
  return Number(rows[0]?.n) || 0;
}

/** One check-in on the row's timeline, and its findings in the notes: once per check-in. */
async function recordCheckin(pool, id, { n, seq, at, line, summary = null, ok = true, worth = false, skipped = false }) {
  const entry = { n, seq, at, line: clip(line || '', MAX_LINE_CHARS), ok: !!ok, ...(worth ? { worth: true } : {}), ...(skipped ? { skipped: true } : {}) };
  const text = summary ? `\n\nCheck-in ${n} (${at}):\n${String(summary).trim()}` : '';
  await pool.query(
    `UPDATE homeroom_bot_investigations
        SET checkins = checkins || jsonb_build_array($3::jsonb),
            notes = RIGHT(LTRIM(notes || $4, E'\n '), $5)
      WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(checkins) e WHERE (e->>'seq')::int = $2)`,
    [Number(id), Number(seq), JSON.stringify(entry), text, MAX_NOTES_CHARS],
  );
  return true;
}

function cards(deps) { return deps.cards || require('../homeroom-bot-cards'); }

// ── The machine's work (src/workflow/bot-investigation/services.ts) ────────

/**
 * `investigation.checkIn`: one check-in. Its gates, its look (on the item's
 * steps: a restart follows the turn), its notes and its update, each once.
 * Resolves what the machine decides from:
 *   { ran, failed?, answered?, worth?, costCents }  a look that ran (or failed)
 *   { stop }     'bot_off' | 'paused' | 'gone' | 'budget': it ends
 *   { skipped }  a gate held this one back: the next is asked as usual
 *   { busy }     another look of theirs was running: asked again soon
 */
async function checkIn(ctx, { pool, config, deps = {} }) {
  const id = Number(ctx.input?.id);
  const seq = Number(ctx.input?.seq);
  const n = Number(ctx.input?.n) || seq;
  const key = `investigation:${id}`;
  const steps = ctx.steps({ owner: `${MACHINE}/${key}` });
  steps.turnOwner = { machine: MACHINE, key, kind: ctx.kind || 'investigation.checkIn', workKey: ctx.key || `checkin:${seq}`, workId: ctx.workId || null };
  const inv = await load(pool, id);
  if (!inv || inv.state !== 'running') return { stop: 'gone', ran: false, costCents: 0 };
  const L = look();
  const done = await steps.once('look', async () => {
    const [user, app] = await Promise.all([L.personOf(pool, inv.user_id), L.appOf(pool, inv.app_id)]);
    if (!user || !app) return { stop: 'gone' };
    const found = await L.projectFor(pool, user, app.slug);
    if (found.error) return { stop: 'gone' };
    const botSvc = deps.botSvc || require('../homeroom-bot');
    const settings = await botSvc.readSettings(pool, { strict: true });
    const bot = deps.bot || await botSvc.ensureBotUser(pool, config);
    const refused = await L.gate(pool, { user, app, settings, bot, deps });
    if (refused) return refused.code === 'bot_off' || refused.code === 'paused' ? { stop: refused.code } : { skipped: refused.code };
    if (Number(inv.spent_cents) >= Number(inv.budget_cents)) return { stop: 'budget' };
    const started = await L.startLookRow(pool, {
      user, app, question: inv.goal, conversationId: inv.conversation_id, threadRootId: inv.thread_root_id,
      investigationId: id, checkin: seq,
    });
    if (started.busy) return { busy: true };
    const out = await (deps.lookInto || L.lookInto)(pool, config, {
      user, app, question: inv.goal, notes: inv.notes, since: lastRanAt(inv.checkins),
      deps: { ...deps, steps, settings, bot },
    });
    const row = await L.finishLook(pool, started.id, out);
    return {
      lookId: started.id, ok: !!out.ok, appName: app.name || app.slug, appSlug: app.slug,
      summary: out.ok ? out.summary : null, line: out.ok ? out.line : clip(out.error || '', MAX_LINE_CHARS),
      answered: !!(out.ok && out.answered), worth: !!(out.ok && out.worth),
      costUsd: Number.isFinite(out.costUsd) ? out.costUsd : (row?.cost_usd != null ? Number(row.cost_usd) : null),
      filesRead: out.ok ? Number(out.filesRead) || 0 : 0, checks: out.ok ? out.checks || [] : [], ms: Number(out.ms) || 0,
    };
  });
  const at = new Date().toISOString();
  if (done.stop || done.busy) return { stop: done.stop || null, busy: !!done.busy, ran: false, costCents: 0 };
  if (done.skipped) {
    await steps.once('skip', () => recordCheckin(pool, id, { n, seq, at, line: SKIP_LINES[done.skipped] || 'Skipped.', skipped: true }));
    return { skipped: done.skipped, ran: false, costCents: 0 };
  }
  const costCents = Number.isFinite(done.costUsd) && done.costUsd > 0 ? Math.ceil(done.costUsd * 100) : 0;
  const when = await steps.once('at', () => at);
  await steps.once('notes', () => recordCheckin(pool, id, {
    n, seq, at: when, line: done.line, summary: done.summary, ok: done.ok, worth: done.worth,
  }));
  await steps.once('post', async () => {
    const dm = deps.dm || require('../homeroom-bot-dm');
    const bot = deps.bot || await (deps.botSvc || require('../homeroom-bot')).ensureBotUser(pool, config);
    const items = done.ok ? L.lookedItems({ appName: done.appName, filesRead: done.filesRead, checks: done.checks }) : [];
    const sent = await dm.sendDm(pool, {
      bot, userId: Number(inv.user_id), content: updateText({ n, line: done.line, ok: done.ok }),
      idempotencyKey: `hrbot-investigation:${id}:${seq}`,
      threadRootId: inv.thread_root_id ? Number(inv.thread_root_id) : false,
      // Quiet, unless it found something worth acting on.
      moment: done.worth ? 'reply' : null,
      metadata: {
        kind: done.worth ? 'chat' : 'investigation_update', appSlug: done.appSlug, investigationId: id,
        ...(items.length ? { looked: { items, ms: done.ms } } : {}),
      },
    });
    return sent?.messageId ?? null;
  });
  return { ran: true, failed: !done.ok, answered: done.answered, worth: done.worth, costCents };
}

/** `investigation.card`: the card drawn from what the machine decided, with the row's check-ins and notes. */
async function drawCard(ctx, { pool, deps = {} }) {
  const inv = await load(pool, ctx.input?.id);
  if (!inv || !inv.card_message_id) return { drawn: false };
  const patch = ctx.input?.patch && typeof ctx.input.patch === 'object' ? ctx.input.patch : {};
  const drawn = await cards(deps).setCardState(pool, Number(inv.card_message_id), { ...patch, ...rowParts(inv) }, { userId: Number(inv.user_id), ws: deps.ws || null });
  return { drawn: !!drawn };
}

/**
 * `investigation.ended`: its card says why, a look a Stop cut off is ended
 * (its turn stopped, so their next look can start), and the end is said in
 * the chat once (not for a Stop: they did it).
 */
async function sayEnded(ctx, { pool, config, deps = {} }) {
  const id = Number(ctx.input?.id);
  const reason = String(ctx.input?.reason || '');
  const inv = await load(pool, id);
  if (!inv) return { said: false };
  await drawCard(ctx, { pool, deps });
  const { rows: cut } = await pool.query(
    `WITH ended AS (
       UPDATE homeroom_bot_looks SET state = 'failed', error = 'the investigation ended', ended_at = NOW()
        WHERE investigation_id = $1 AND state = 'running'
        RETURNING app_id, user_id
     )
     SELECT s.session_id FROM ended e JOIN homeroom_bot_look_sessions s ON s.app_id = e.app_id AND s.user_id = e.user_id`,
    [id],
  );
  for (const r of cut) {
    // eslint-disable-next-line no-await-in-loop
    await (deps.worker || require('../worker')).stopTurn(Number(r.session_id)).catch((err) => {
      log.warn('homeroom-bot-investigation', 'Could not stop a check-in\'s turn', { id, err: err.message });
    });
  }
  const text = endedText(reason, inv.goal);
  if (!text) return { said: false };
  const dm = deps.dm || require('../homeroom-bot-dm');
  const bot = deps.bot || await (deps.botSvc || require('../homeroom-bot')).ensureBotUser(pool, config);
  const sent = await dm.sendDm(pool, {
    bot, userId: Number(inv.user_id), content: text, idempotencyKey: `hrbot-investigation:${id}:ended`,
    threadRootId: inv.thread_root_id ? Number(inv.thread_root_id) : false,
    moment: reason === 'answered' ? 'reply' : null,
    metadata: { kind: reason === 'answered' ? 'chat' : 'investigation_update', investigationId: id },
  });
  return { said: !!sent?.messageId };
}

// ── The chat's tool ──────────────────────────────────────────────────────

const INVESTIGATION_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: TOOL,
    description: 'Offer an investigation that runs for days on a project they can build on: every few hours a helper '
      + 'looks into the code again with the notes so far and what changed, and posts a short update here, until the '
      + 'question is answered or its days or budget run out. For questions answered by watching over time (a check that '
      + 'fails now and then, whether a change helped). It puts a card with Start and Not now under your reply; nothing '
      + 'runs until they tap Start. Defaults: every 6 hours, up to 5 days, a $3 budget; change them only when they ask.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project, by its name or slug.' },
        goal: { type: 'string', description: 'What it should find out, in one or two sentences, in their words.' },
        everyHours: { type: 'integer', description: 'Hours between check-ins, 1 to 24 (default 6).' },
        days: { type: 'integer', description: 'Days it may run, 1 to 14 (default 5).' },
        budgetDollars: { type: 'number', description: 'Its budget in dollars, up to 10 (default 3).' },
      },
      required: ['project', 'goal'],
    },
  },
});

// What their investigations found, for the chat to answer from (its notes are
// on the card, which the chat model does not see): "File what it found".
const READ_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: READ,
    description: 'Read their investigations in this chat, newest first: each one\'s goal, project, whether it runs, '
      + 'its check-ins and everything its notes say it found. Use it before you answer about an investigation, and when '
      + 'they ask to file what one found (then offer_request for the most important thing it found).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
});
const READ_LIMIT = 3;
const READ_NOTES_CHARS = 5000;

async function readTool(pool, ctx) {
  const { rows } = await pool.query(
    `SELECT i.id, i.goal, i.state, i.ended_reason, i.every_hours, i.days, i.notes, i.checkins, i.started_at, i.next_at,
            a.slug, a.name
       FROM homeroom_bot_investigations i JOIN apps a ON a.id = i.app_id
      WHERE i.user_id = $1 AND ($2::int IS NULL OR i.conversation_id = $2) AND i.state IN ('running', 'ended')
      ORDER BY i.id DESC LIMIT $3`,
    [ctx.user.id, Number(ctx.conversationId) || null, READ_LIMIT],
  );
  if (!rows.length) return { ok: true, investigations: [], note: 'They have no investigation that has run in this chat.' };
  return {
    ok: true,
    investigations: rows.map((r) => {
      const notes = String(r.notes || '').trim();
      return {
        goal: r.goal, project: r.name || r.slug, state: r.state === 'ended' ? `ended (${r.ended_reason || 'ended'})` : 'running',
        checkIns: (Array.isArray(r.checkins) ? r.checkins : []).filter((c) => !c.skipped).length,
        ...(r.state === 'running' && r.next_at ? { nextCheckIn: new Date(r.next_at).toISOString() } : {}),
        found: notes.length > READ_NOTES_CHARS ? `…${notes.slice(-READ_NOTES_CHARS)}` : (notes || 'Nothing yet.'),
      };
    }),
  };
}

async function runTool(pool, ctx, args) {
  const spec = rules.investigationSpec(args);
  if (!spec.ok) return { ok: false, error: spec.error };
  const deps = ctx.deps || {};
  const L = look();
  const found = await L.projectFor(pool, ctx.user, spec.project);
  if (found.error) return { ok: false, error: found.error };
  const { app } = found;
  if (ctx.appIds && typeof ctx.appIds.add === 'function') ctx.appIds.add(Number(app.id));
  const bot = ctx.bot || await (deps.botSvc || require('../homeroom-bot')).ensureBotUser(pool, ctx.config || {});
  const refused = await L.gate(pool, { user: ctx.user, app, settings: ctx.settings, bot, deps, doing: 'investigation' });
  if (refused) return { ok: false, error: refused.error };
  if (await runningCount(pool, ctx.user.id) >= rules.MAX_RUNNING) {
    return { ok: false, error: `They already have ${rules.MAX_RUNNING} investigations running. One has to end, or be stopped from its card, first.` };
  }
  const messageId = Number(ctx.messageId) || null;
  let { rows } = await pool.query(
    `INSERT INTO homeroom_bot_investigations
       (user_id, app_id, conversation_id, source_message_id, thread_root_id, goal, every_hours, days, budget_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [ctx.user.id, app.id, ctx.conversationId || null, messageId,
      deps.threadRequest?.rootId || deps.threadRootId || null, spec.goal, spec.everyHours, spec.days, spec.budgetCents],
  );
  if (!rows.length && messageId) {
    ({ rows } = await pool.query('SELECT * FROM homeroom_bot_investigations WHERE source_message_id = $1', [messageId]));
  }
  const row = rows[0];
  if (!row) return { ok: false, error: 'It could not be set up just now.' };
  const model = require('../default-model').fromSettings(ctx.settings, ctx.config || {});
  ctx.card = proposedCard(row, app, model);
  ctx.investigationProposed = { id: Number(row.id) };
  return {
    ok: true, proposed: true, project: app.name || app.slug,
    everyHours: Number(row.every_hours), days: Number(row.days),
    note: 'A card with Start and Not now is under your reply. Nothing runs or costs anything until they tap Start. '
      + 'Say so in one or two short lines, how often it checks in and for how long; never name the budget in money (the card shows it).',
  };
}

module.exports = {
  tools: (ctx) => (ctx && ctx.user && ctx.settings && ctx.settings.mode !== 'off' ? [INVESTIGATION_TOOL, READ_TOOL] : []),
  run: async (pool, ctx, name, args) => {
    if (name === TOOL) return runTool(pool, ctx, args);
    if (name === READ) return readTool(pool, ctx);
    return undefined;
  },
  promptLines: (ctx) => (ctx && ctx.user && ctx.settings && ctx.settings.mode !== 'off' ? [
    '- Offer an investigation that runs for days (start_investigation) when a question about a project they can build',
    '  on is answered by watching over time: a check that fails now and then, whether a change helped. Every few hours',
    '  a helper looks again and you post a short update here. It puts a card under your reply; nothing runs until they',
    '  tap Start, so never say it has started. What one found is in read_investigation: read it before you answer',
    '  about one, and when they ask to file what it found, offer the most important thing as a request.',
  ] : []),
  // The machine's work.
  checkIn,
  drawCard,
  sayEnded,
  load,
  runningCount,
  recordCheckin,
  // Pure, for tests and the card.
  modelName,
  proposedCard,
  rowParts,
  lastRanAt,
  endedText,
  updateText,
  TOOL,
  READ,
  INVESTIGATION_TOOL,
  MAX_NOTES_CHARS,
};
