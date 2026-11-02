'use strict';

// Homeroom bot parity, P4: working through many requests at once.
//
// "Work through these" puts a table card under the bot's reply with what it
// last found on each request (services/homeroom-bot-batches.js readOf), and
// its Build starts the ready ones (homeroom-bot-cards/batch.js), after which
// the card is a roll-up of their tracks (rollupOf). A project's owner (or an
// admin) working through its requests raises two holds for the batch's own
// requests only: the per-person limit, read by the lane's picks
// (bot-lane/facts.ts BATCH_RAISES_SQL), and the bot's open changes on the
// project (homeroom-bot.js simulateCaps). These pin the pure parts; the
// lifecycle against the schema is tests/bot-parity-p4-batch-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const batches = require('../src/services/homeroom-bot-batches');
const tool = require('../src/services/homeroom-bot-thread-tools/batch');
const cardHandler = require('../src/services/homeroom-bot-cards/batch');
const threadTools = require('../src/services/homeroom-bot-thread-tools');
const loop = require('../src/workflow/rules/bot-loop.ts');
const laneFacts = require('../src/workflow/bot-lane/facts.ts');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('numbersOf: positive request numbers, once each, at most twenty', () => {
  assert.deepEqual(batches.numbersOf([3, '#4', '5', 3, 0, -1, 2.5, 'x', null]), [3, 4, 5]);
  assert.equal(batches.numbersOf(Array.from({ length: 30 }, (_, i) => i + 1)).length, 20);
  assert.deepEqual(batches.numbersOf('3,4'), []);
});

test('readOf: work under way wins, a verdict counts while it is fresh, anything else is read again', () => {
  const read = (o) => batches.readOf({ now: NOW, ...o });
  // The request's track first.
  assert.deepEqual(read({ track: { state: 'live' } }), { read: 'done', note: null, why: 'live' });
  assert.deepEqual(read({ track: { state: 'done_elsewhere' } }).read, 'done');
  assert.equal(read({ track: { state: 'closed' } }).closed, true);
  for (const state of ['building', 'checks', 'vote', 'going_live']) assert.equal(read({ track: { state } }).read, 'underway', state);
  assert.deepEqual(read({ track: { state: 'queued', step: 'build' } }), { read: 'underway', note: null, why: 'build_queued' });
  assert.equal(read({ track: { state: 'queued', step: null } }).read, 'reading');
  assert.equal(read({ track: { state: 'planning' } }).read, 'reading');
  assert.deepEqual(read({ track: { state: 'waiting', why: 'plan' } }), { read: 'ready', note: null, why: 'plan' });
  assert.deepEqual(read({ track: { state: 'held', why: 'slots' } }), { read: 'ready', note: null, why: 'held' });
  assert.deepEqual(read({ track: { state: 'held', why: 'allowance' } }).why, 'allowance');
  const asked = { verdict: 'question', question: 'Which colour?', created_at: ago(DAY) };
  assert.deepEqual(read({ track: { state: 'waiting', why: 'question' }, run: asked }), { read: 'question', note: 'Which colour?', why: null });
  // A look owed or under way, with no track yet.
  assert.equal(read({ queued: true }).read, 'reading');
  // The newest verdict, while fresh.
  assert.equal(read({ run: { verdict: 'ready', created_at: ago(DAY) } }).read, 'ready');
  assert.deepEqual(read({ run: { verdict: 'person', reason: 'Needs a vote on pricing', created_at: ago(DAY) } }),
    { read: 'person', note: 'Needs a vote on pricing', why: null });
  assert.deepEqual(read({ run: { verdict: 'empty', reason: 'It is already there', created_at: ago(DAY) } }),
    { read: 'done', note: 'It is already there', why: 'empty' });
  assert.equal(read({ run: asked }).read, 'question');
  // Stale: too old, or a person wrote on it since.
  assert.equal(read({ run: { verdict: 'ready', created_at: ago(20 * DAY) } }).read, 'unread');
  assert.equal(read({ run: { verdict: 'ready', created_at: ago(2 * DAY) }, personAt: ago(DAY) }).read, 'unread');
  assert.equal(read({ run: { verdict: 'ready', created_at: ago(DAY) }, personAt: ago(2 * DAY) }).read, 'ready');
  // A stopped build's request reads its verdict again.
  assert.equal(read({ track: { state: 'stopped' }, run: { verdict: 'ready', created_at: ago(DAY) } }).read, 'ready');
  assert.equal(read({}).read, 'unread');
  // The bot's own words are clipped, never left to run on.
  assert.ok(read({ run: { verdict: 'person', reason: 'x'.repeat(900), created_at: ago(DAY) } }).note.length <= 240);
});

test('the summary counts each read, and says nothing of a zero', () => {
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => ({ number: i + 1, read: 'ready' })),
    { number: 10, read: 'question' }, { number: 11, read: 'question' }, { number: 12, read: 'done' },
  ];
  const counts = batches.countsOf(rows);
  assert.equal(counts.total, 12);
  assert.equal(counts.ready, 9);
  assert.equal(counts.person, 0);
  assert.equal(batches.summaryOf(counts), '12 requests · 9 ready · 2 questions · 1 done');
  assert.equal(batches.summaryOf(batches.countsOf([{ number: 1, read: 'question' }])), '1 request · 1 question');
  assert.ok(!batches.summaryOf(counts).includes('—'));
});

test('rollupOf: the started requests\' tracks, counted; one with no track yet is waiting; active ones hold the batch', () => {
  const tracks = new Map([
    [1, { state: 'live', title: 'Dark mode' }], [2, { state: 'going_live' }], [3, { state: 'vote' }], [4, { state: 'checks' }],
    [5, { state: 'building' }], [6, { state: 'planning' }], [7, { state: 'held' }], [8, { state: 'stopped' }], [9, { state: 'waiting' }],
  ]);
  const roll = batches.rollupOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], tracks);
  assert.deepEqual(roll.counts, { live: 2, ready: 1, checks: 1, building: 2, waiting: 3, stopped: 1, total: 10 });
  // checks, building, planning, held, and #10 with no track (queued).
  assert.equal(roll.active, 5);
  assert.deepEqual(roll.progress[0], { number: 1, state: 'live', title: 'Dark mode' });
  assert.deepEqual(roll.progress[9], { number: 10, state: 'waiting' });
  // Everything settled: the batch ends.
  assert.equal(batches.rollupOf([1, 3, 8], tracks).active, 0);
});

test('the lane: a running batch\'s request may go past the per-person limit and the project\'s builds, up to its raise; nothing else does', () => {
  assert.deepEqual(loop.raisedOf([
    { app_id: 7, issue_number: 1, per_person: 6 }, { app_id: 7, issue_number: 2, per_person: 9 }, { app_id: 8, issue_number: 1, per_person: 0 },
  ]), { '7:1': 6, '7:2': 6 }, 'never past MAX_PER_PERSON, and a zero raises nothing');
  const inUse = [1, 2, 3].map(() => ({ kind: 'build', appId: 7, person: 'u5' }));
  const builds = [
    { app_id: 7, issue_number: 11, person_id: 5 },
    { app_id: 7, issue_number: 12, person_id: 5 },
    { app_id: 7, issue_number: 13, person_id: 5 },
  ];
  // Without a raise: the person has three going and the project three building.
  assert.deepEqual(loop.pickLiveBuilds(builds, { inUse, slots: 10, perPerson: 3 }), []);
  // The batch raised #11 and #12 to six: both start; #13 is not the batch's.
  const raised = { '7:11': 6, '7:12': 6 };
  assert.deepEqual(loop.pickLiveBuilds(builds, { inUse, slots: 10, perPerson: 3, raised }).map((p) => p.issue_number), [11, 12]);
  // Reads too, counting what runs; and never past the raise.
  const reads = [
    { app_id: 7, issue_number: 11, person_id: 5, follow_up_session_id: 99 },
    { app_id: 7, issue_number: 14, person_id: 5, follow_up_session_id: 98 },
  ];
  const six = Array.from({ length: 6 }, () => ({ kind: 'followUp', appId: 7, person: 'u5' }));
  assert.deepEqual(loop.pickLive(reads, { inUse: inUse.map((s) => ({ ...s, kind: 'followUp' })), slots: 5, perPerson: 3, raised }).map((p) => p.issue_number), [11]);
  assert.deepEqual(loop.pickLive(reads, { inUse: six, slots: 5, perPerson: 3, raised }), []);
  // The raise is read where the lane reads its facts, from running batches only.
  assert.match(laneFacts.BATCH_RAISES_SQL, /b\.state = 'running' AND b\.ends_at > NOW\(\)/);
  assert.match(laneFacts.BATCH_RAISES_SQL, /unnest\(b\.started_numbers\)/);
});

test('work_through is offered in a private chat with the bot, never in a project\'s chat, with its prompt lines', () => {
  const ctx = { user: { id: 3 }, deps: {} };
  assert.deepEqual(tool.tools(ctx).map((t) => t.function.name), ['work_through']);
  assert.deepEqual(tool.tools({ ...ctx, inPublic: true }), []);
  assert.deepEqual(tool.tools({}), []);
  assert.ok(threadTools.toolsFor(ctx).some((t) => t.function.name === 'work_through'));
  const lines = tool.promptLines(ctx).join('\n');
  assert.match(lines, /work_through/);
  assert.match(lines, /Nothing is built until they tap Build/);
  assert.ok(!lines.includes('—'));
  assert.equal(tool.WORK_THROUGH.function.parameters.properties.numbers.maxItems, 20);
});

test('work_through: names the project and either numbers or "mine"; one table per turn', async () => {
  assert.match(tool.argsOf({}).error, /which project/);
  assert.match(tool.argsOf({ project: 'gym' }).error, /Name the requests/);
  assert.deepEqual(tool.argsOf({ project: 'gym', numbers: [4, 4, 5] }), { project: 'gym', numbers: [4, 5], which: null });
  assert.deepEqual(tool.argsOf({ project: 'gym', which: 'mine' }), { project: 'gym', numbers: [], which: 'mine' });
  const out = await tool.workThrough({}, { batch: 1, user: { id: 1 } }, { project: 'gym', which: 'mine' });
  assert.deepEqual(out, { ok: false, error: 'One table per turn.' });
  // A project they cannot see reads nothing.
  const mayor = { findApp: async () => ({ id: 2, slug: 'gym' }), canView: async () => false };
  const refused = await tool.workThrough({}, { user: { id: 1 }, deps: { mayor } }, { project: 'gym', numbers: [1] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /No such project/);
});

test('work_through puts the batch card under the reply, and only reads it started back its words', async () => {
  const card = { type: 'batch', v: 1, state: 'proposed', batchId: 41, label: '3 requests · 2 ready · 1 being read' };
  const proposed = [];
  const fake = {
    async propose(_pool, args) {
      proposed.push(args);
      return {
        ok: true, batchId: 41, card, counts: { ready: 2 }, queued: [9], unknown: [77], closed: [],
        raise: { perPerson: 6, proposalsPerApp: 10, as: 'owner' },
        rows: [
          { number: 7, title: 'Dark mode', read: 'ready' }, { number: 8, title: 'Export', read: 'ready' },
          { number: 9, title: 'Search', read: 'reading' },
        ],
      };
    },
  };
  const mayor = { findApp: async () => ({ id: 2, slug: 'gym', name: 'Gym Tracker' }), canView: async () => true };
  const ctx = { user: { id: 1 }, settings: { perPerson: 3 }, conversationId: 5, appIds: new Set(), deps: { batches: fake, mayor } };
  const out = await tool.workThrough({}, ctx, { project: 'Gym Tracker', numbers: [7, 8, 9, 77] });
  assert.equal(out.ok, true);
  assert.equal(ctx.card, card, 'the card goes under the reply');
  assert.equal(ctx.batchQueued, true, 'the reads it queued come back: saying so is true');
  assert.equal(ctx.batch, 41);
  assert.deepEqual(proposed[0].numbers, [7, 8, 9, 77]);
  assert.equal(proposed[0].conversationId, 5);
  assert.deepEqual(out.notRequests, [77]);
  assert.match(out.readingNow, /#9/);
  assert.match(out.raised, /up to 6 of these at once and hold up to 10/);
  assert.match(out.shown, /Build for the 2 ready ones/);
  assert.ok(ctx.appIds.has(2));
});

test('the claims check accepts what a batch started this turn, and only then', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const pool = { query: async () => ({ rows: [] }) };
  const said = 'I\'ll get back to you once I have read them.';
  const base = { user: { id: 1 }, appIds: new Set() };
  assert.deepEqual((await mayor.claimProblems(pool, base, said)).map((p) => p.kind), ['promised']);
  assert.deepEqual(await mayor.claimProblems(pool, { ...base, batchQueued: true }, said), []);
  assert.deepEqual((await mayor.claimProblems(pool, base, 'I\'ve started reading the other three.')).map((p) => p.kind), ['started']);
  assert.deepEqual(await mayor.claimProblems(pool, { ...base, batchQueued: true }, 'I\'ve started reading the other three.'), []);
});

test('the card\'s taps: Build starts the batch, refresh reads it again, only the batch\'s owner, nothing else', async () => {
  const calls = [];
  const fake = {
    async batchRow(_pool, id) { return id === 41 ? { id: 41, user_id: 1, state: 'proposed', message_id: null } : null; },
    async start(_pool, _config, args) { calls.push(['start', args.batch.id, args.message.id]); return { ok: true, patch: { state: 'running' } }; },
    async refreshBatch(_pool, id) { calls.push(['refresh', id]); },
  };
  const deps = { batches: fake };
  const message = { id: 300, conversationId: 5, botId: 2 };
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 9 }, card: { batchId: 41 }, action: 'build', message, deps }),
    { ok: false, status: 404, error: 'No such card' });
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card: { batchId: 40 }, action: 'build', message, deps }),
    { ok: false, status: 404, error: 'No such card' });
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card: { batchId: 41 }, action: 'build', message, deps }),
    { ok: true, patch: { state: 'running' } });
  assert.equal((await cardHandler.decide({}, {}, { user: { id: 1 }, card: { batchId: 41 }, action: 'burn', message, deps })).status, 400);
  assert.deepEqual(await cardHandler.decide({}, {}, { user: { id: 1 }, card: { batchId: 41 }, action: 'refresh', message, deps }),
    { ok: true, state: 'proposed' });
  assert.deepEqual(calls, [['start', 41, 300]]);
});

test('Build is refused for a batch that is not the person\'s, or that started already', async () => {
  const user = { id: 1 };
  assert.equal((await batches.start({}, {}, { batch: { id: 1, user_id: 2, state: 'proposed' }, user })).status, 404);
  assert.deepEqual(await batches.start({}, {}, { batch: { id: 1, user_id: 1, state: 'running' }, user }),
    { ok: false, status: 409, error: 'This batch has already started.' });
});

test('the proposal hold reads a running batch\'s raise for its own requests, and fails to the ordinary hold', async () => {
  const seen = [];
  const pool = (cap) => ({ async query(sql, params) { seen.push(params); return { rows: [{ cap }] }; } });
  assert.equal(await batches.proposalsPerAppFor(pool(10), 7, 12, 5), 10);
  assert.deepEqual(seen.at(-1), [7, 12]);
  assert.equal(await batches.proposalsPerAppFor(pool(null), 7, 12, 5), 5, 'no batch: the ordinary hold');
  assert.equal(await batches.proposalsPerAppFor(pool(3), 7, 12, 5), 5, 'a raise never lowers it');
  assert.equal(await batches.proposalsPerAppFor(pool(10), 7, null, 5), 5, 'no request: no raise');
  const broken = { async query() { throw new Error('down'); } };
  assert.equal(await batches.proposalsPerAppFor(broken, 7, 12, 5), 5);
  // simulateCaps passes the request it decides for.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.equal((src.match(/simulateCaps\(pool, bot, app\.id, [^)]*\{ issueNumber \}\)/g) || []).length, 3);
});

test('a refresh never costs its caller: a missing pool or a bad app does nothing', () => {
  assert.doesNotThrow(() => batches.noteRequestChanged(null, 3, 4));
  assert.doesNotThrow(() => batches.noteRequestChanged({ query: async () => ({}) }, 'x', 4));
});

// ── The card, drawn ──

test('the batch card, proposed: a row per request with its read, Build the ready ones, Answer, Close, and the owner\'s raise', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { BatchCardView, batchOf, numberList } = loadTsx('frontend/src/features/messages/bot-cards/batch.tsx');
  const data = batchOf({
    type: 'batch', state: 'proposed', projectName: 'Gym Tracker',
    requests: [
      { number: 4, title: 'Dark mode', read: 'ready' },
      { number: 5, title: 'Export to CSV', read: 'ready', why: 'held' },
      { number: 6, title: 'Rest timer', read: 'question', note: 'Should it beep?' },
      { number: 7, title: 'Old bug', read: 'done', why: 'live' },
      { number: 8, title: null, read: 'reading' },
      { number: 'x', read: 'ready' },
    ],
    raise: { perPerson: 6, proposalsPerApp: 10, as: 'owner' },
  });
  assert.equal(data.requests.length, 5, 'a row with no number is dropped');
  const html = renderToHtml(createElement(BatchCardView, { data }));
  assert.match(html, /data-bot-batch="proposed"/);
  assert.match(html, />Requests on Gym Tracker</);
  assert.match(html, /5 requests · 2 ready · 1 question · 1 done · 1 being read/);
  assert.match(html, /data-bot-batch-row="6" data-bot-batch-read="question"/);
  assert.match(html, /Should it beep\?/);
  assert.match(html, /Ready, and waiting for a free slot\./);
  assert.match(html, />Request #8</);
  assert.match(html, /class="messages-bot-primary" data-bot-batch-action="build"><span>Build the 2<\/span>/);
  assert.match(html, /data-bot-batch-action="answer"><span>Answer the question<\/span>/);
  assert.match(html, /data-bot-batch-action="close"><span>Close #7<\/span>/);
  assert.match(html, /As the project&#x27;s owner, Build runs up to 6 of these at once for this batch\./);
  assert.ok(!/gray-|indigo-/.test(html));
  assert.equal(numberList([3, 7, 9], 'en'), '#3, #7, and #9');
  assert.equal(numberList([3], 'en'), '#3');
});

test('the batch card, running: the roll-up as a bar and a legend in words, each request\'s state, the raise said', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { BatchCardView, batchOf } = loadTsx('frontend/src/features/messages/bot-cards/batch.tsx');
  const data = batchOf({
    type: 'batch', state: 'running', projectName: 'Gym Tracker',
    requests: [{ number: 4, title: 'Dark mode', read: 'ready' }],
    rollup: { live: 2, ready: 3, checks: 1, building: 3, waiting: 0, stopped: 0, total: 9 },
    progress: [{ number: 4, state: 'live' }, { number: 5, state: 'ready', title: 'Export' }, { number: 6, state: 'building' }],
    raise: { perPerson: 6, proposalsPerApp: 10, as: 'owner' },
    refused: [{ number: 9, why: 'Their building time is used up.' }],
  });
  const html = renderToHtml(createElement(BatchCardView, { data }));
  assert.match(html, /data-bot-batch="running"/);
  assert.match(html, />Building on Gym Tracker</);
  assert.match(html, /2 live · 3 ready for your yes · 1 in checks · 3 building/);
  assert.ok(!/waiting/.test(html.replace(/data-[a-z-]+="[^"]*"/g, '')), 'a zero says nothing');
  assert.match(html, /data-bot-batch-segment="live"/);
  assert.match(html, /bg-\[color:var\(--state-ok\)\]/);
  assert.match(html, /data-bot-batch-segment="ready"[^>]*>|class="block h-full bg-violet-500/);
  assert.match(html, /width:22\.2/);
  assert.match(html, /#5 Export/);
  assert.match(html, /Ready for your yes/);
  assert.match(html, /6 at once: your limit for this batch, as the project&#x27;s owner\./);
  assert.match(html, /Could not start #9\./);
  assert.ok(!/data-bot-batch-action/.test(html), 'no buttons once it runs');
  const done = renderToHtml(createElement(BatchCardView, { data: { ...data, state: 'done' } }));
  assert.match(done, />Built on Gym Tracker</);
});
