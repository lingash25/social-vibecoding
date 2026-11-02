'use strict';

// #4488: a complicated change is checked with its requester first, and its
// screens are reviewed once it is built.
//
// The triage of a request on a project that already exists can label a
// `ready` verdict `complicated` (a new screen or kind of thing, a change to
// how people get around or what it stores, two quite different ways to do
// it, or large). Such a change is not built at once: its build slot drafts
// the spec first, with its before and after screens, and it is shown to its
// requester with Build it and Change something, on the request (shared with
// the group, and on GitHub) and as the plan card in their DM with the bot.
// It never builds without an answer. Build it builds exactly that spec, with
// the choices in its build note; Change something posts their words on the
// request and plans it again. Once built, its screens go through the check
// round a first version gets. Small changes still go straight to a proposal,
// and first versions are exactly as they were.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-complicated.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const configs = require('../src/services/bot-configs');
const { tapsNow } = require('./lib/bot-replies');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const fence = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const PLAN = {
  bullets: ['A weekly leaderboard tab', 'Points for each chore done'],
  questions: [{ question: 'Who shows on the leaderboard?', answers: ['Everyone in the flat', 'Only people who opt in'] }],
};
const REVIEWER = { model: 'anthropic/claude-opus-5.5', maxRounds: 3, budgetMinutes: 25 };
const CURRENT = {
  id: 11, key: 'fv', label: 'First versions', version: 1, role: 'current',
  recipe: { models: { triage: 'z/glm', spec: 'a/opus', build: 'z/glm' }, reviewer: REVIEWER, pack: null },
};

// ── The triage ──

test('the triage labels a ready change complicated only when it says so, and only a ready one', () => {
  const ready = (extra) => bot.parseVerdict(fence({ verdict: 'ready', build_note: 'Add a leaderboard tab.', ...extra }));
  const yes = ready({ complicated: true, plan: PLAN.bullets, choices: PLAN.questions });
  assert.equal(yes.verdict, 'ready');
  assert.equal(yes.complicated, true);
  assert.deepEqual(yes.plan, PLAN, 'its plan and choices, as a first version\'s are read');
  assert.equal(ready({}).complicated, false, 'no label: built straight away');
  assert.equal(ready({ complicated: 'yes' }).complicated, false, 'only a real true');
  const question = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which tab?', default: 'A', answers: ['A', 'B'],
    blocker: 'user_facing', why_default_fails: 'x', complicated: true,
  }));
  assert.equal(question.complicated, false, 'a question is never complicated');
  assert.equal(bot.parseVerdict(fence({ verdict: 'person', reason: 'x', complicated: true })).complicated, false);
});

test('the triage prompt says what counts as complicated, leaning towards building straight away', () => {
  const md = read('src/prompts/homeroom-bot-triage.md');
  const flat = md.replace(/\s+/g, ' ');
  assert.match(flat, /Then set `complicated`, leaning towards false: a `ready` change becomes a proposal with before and after screenshots, which is its check\. True ONLY when, on an existing app, it:/);
  assert.match(md, /- adds a new screen or a new kind of thing to the app \(a leaderboard, sign-up, a new tab\);/);
  assert.match(md, /- changes how people get around the app, or what it stores;/);
  assert.match(md, /- could reasonably be done two quite different ways, so a quick look first saves a wasted build;/);
  assert.match(md, /- is large: several screens at once, or more than about a day's work for a person\./);
  assert.match(flat, /Copy changes, fixes, small tweaks and requests that spell out exactly what to do are never complicated\./);
  // #5224: the plan's lines stay short, one point each, in the requester's words.
  assert.match(md, /"plan": \["a first version or complicated change: 3 to 5 short lines, one point each, at most 60 characters, what people will see or do"\]/);
  assert.match(flat, /No file names, code, tests, catalogs or other build steps: those belong in `build_note`\./);
  assert.match(md, /"complicated": true \(verdict ready, by the test above; never a first version\),/);
  const triage = read('src/services/homeroom-bot.js');
  assert.match(triage, /if \(v\.complicated && requester\?\.firstVersion\) v = \{ \.\.\.v, complicated: false \};/,
    'a first version drops the label');
  assert.match(triage, /plan: parsed\.plan, aboutPlatform: !!parsed\.platform, complicated: !!parsed\.complicated,/, 'recorded on the run');
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS complicated BOOLEAN;/);
});

test('a complicated plan counts against the daily questions and notes; a small change does not', async () => {
  const seen = [];
  const counting = (n) => ({ async query(sql, params) { seen.push([String(sql), params]); return { rows: [{ cnt: n }] }; } });
  assert.equal(await bot.planTripwire(counting(10), 2), 'question_tripwire');
  assert.equal(await bot.planTripwire(counting(9), 2), null);
  assert.ok(seen.some(([sql]) => /verdict = ANY\(\$2::text\[\]\) OR complicated IS TRUE/.test(sql)), 'plans asked count as questions do');
  const src = read('src/services/homeroom-bot.js');
  // (Homeroom bot parity, P4: the request it decides for, which a batch may raise the hold for.)
  assert.match(src, /const caps = await simulateCaps\(pool, bot, app\.id, v\.verdict, settings, \{ issueNumber \}\)\n\s+\|\| \(v\.complicated \? await planTripwire\(pool, app\.id\) : null\);/,
    'only a complicated change: a small one is not asked about');
  assert.match(live.heldText({ cap: 'question_tripwire', verdict: 'plan', limit: 10, project: 'Chores' }),
    /^Homeroom bot has a plan for this request, but it has already posted 10 questions and notes on Chores today\./);
});

// ── What it says ──

test('the plan is posted on the request and GitHub to read and answer; the build that follows does not post it again', () => {
  const text = live.planCommentText({ spec: '# Leaderboard\n\nA weekly leaderboard.', questions: PLAN.questions });
  assert.match(text, /^Homeroom bot wrote a plan for this request, with its before and after screens, and will build it once the person who asked for it says Build it\. On Homeroom they can reply "build it" on this request when it looks right, or say what to change and it will plan it again\./);
  assert.match(text, /One choice for them, or it goes with what it suggests:\n- Who shows on the leaderboard\? \(suggested: Everyone in the flat\)/);
  assert.match(text, /<details><summary>The plan<\/summary>\n\n# Leaderboard/);
  assert.doesNotMatch(text, /@/, 'nobody is @mentioned on GitHub');
  const card = live.specCard({ sessionId: 5, version: 1, spec: '# Leaderboard\n\nx', bot: { id: 1, username: 'homeroom_bot' }, asking: true });
  assert.equal(card.msgType, 'spec_share');
  assert.equal(card.metadata.specShare.sessionId, 5, 'its card opens the spec, with its screens');
  // One request, one story: the plan in a line, saying who it waits for.
  assert.equal(card.content, '📋 Plan v1: Leaderboard. Waiting for the person who asked for it to say Build it.');
  assert.equal(card.metadata.specShare.botNote, 'waiting');
  // A plan its requester said Build it to is not posted again: a note says so.
  assert.equal(live.approvedBuildHomeroomText({ requester: 'sam' }), '@sam said Build it. I\'m building it now.');
  assert.doesNotMatch(live.specCommentText('# Leaderboard', { approved: true }), /<details>/, 'not the spec a second time');
  assert.match(live.specCommentText('# Leaderboard'), /<details><summary>The plan<\/summary>/, 'every other build as before');
  // Progress is said untagged: its requester hears about the plan in their
  // chat with the bot, and a tag means the bot is asking you something.
  assert.equal(live.tagsPoster('plan'), false);
});

test('the DM card names the request, and its words say its screens are there', () => {
  const words = dm.planCardText({ appName: 'Chores', plan: { ...PLAN, complicated: true }, issueNumber: 12 });
  assert.match(words, /^Before I build \*\*Chores\*\* request #12, here's my plan:\n\n- A weekly leaderboard tab\n- Points for each chore done\n\nOne choice for you, or I'll go with what I suggest\.\n\nIts before and after screens are on the request\. Tap Build it when it looks right, or Change something\.$/);
  assert.match(dm.planCardText({ appName: 'Chores', plan: PLAN }), /^Here's my plan for \*\*Chores\*\*:/, 'a first version\'s, as it was');
  assert.equal(dm.isPlanGoWord('Build it!'), true);
  assert.equal(dm.isPlanGoWord('  yes please. '), true);
  assert.equal(dm.isPlanGoWord('build it but make it blue'), false);
  // Papote #3: said to the bot on the request, it is the same go word.
  assert.equal(dm.isPlanGoWord('@Homeroom bot build it'), true);
  assert.equal(dm.isPlanGoWord('@\u200bHomeroom bot build it'), true, 'as the composer writes the mention');
  assert.equal(dm.isPlanGoWord('@homeroom_bot, go ahead!'), true);
  assert.equal(dm.isPlanGoWord('@homeroom_bot_x build it'), false, 'somebody else\'s handle');
  assert.equal(dm.isPlanGoWord('@Homeroom bot status'), false);
  assert.equal(dm.isPlanGoWord('@Homeroom bot build it but make it blue'), false);
});

test('the plan card for an existing project says where its screens are and where changes go', () => {
  const { PlanCardView, COMPLICATED_PLAN_NOTE } = loadTsx('frontend/src/features/messages/bot-plan-view.tsx');
  const draw = (plan, props = {}) => renderToHtml(createElement(PlanCardView, { appName: 'Chores', plan, state: 'open', ...props }));
  const open = draw({ ...PLAN, complicated: true, spec: { sessionId: 5, version: 1 } });
  assert.match(open, /<p class="messages-bot-note mt-2\.5" data-bot-plan-note=""><svg[^>]*>[\s\S]*?<\/svg><span>Its before and after screens are on the request below\. What you ask to change is posted there, where the group can see it\.<\/span><\/p>/);
  assert.equal(message(COMPLICATED_PLAN_NOTE), 'Its before and after screens are on the request below. What you ask to change is posted there, where the group can see it.');
  assert.match(open, /data-bot-plan-build="">Build it<\/button>/);
  assert.match(open, /data-bot-plan-change="">Change something<\/button>/);
  assert.doesNotMatch(draw(PLAN), /data-bot-plan-note/, 'a first version\'s card is unchanged');
  assert.doesNotMatch(draw({ ...PLAN, complicated: true }, { state: 'built' }), /data-bot-plan-note/, 'only while it waits');
});

// 20 Oct 2026: the card asked for Build it to a plan it did not show. It shows it now.

test('a card whose triage gave no lines reads them off the plan it drafted', () => {
  const spec = [
    '# Stack each project\'s notifications under its two newest',
    '',
    'The sheet groups notifications by project. Each group shows two.',
    '',
    '## User-facing changes',
    '',
    '**Before and after** (numbered as on the screens):',
    '',
    '1. Each project\'s group shows its two newest notifications. The rest fold. (Tap the bell)',
    '',
    '### What changes',
    '',
    '- **One group per project, on every tab.** Unread, Messages and All group them.',
    '  - a detail of the point above',
    '- A `code` word and [a link](https://example.com) \u2014 said *plainly*.',
    '- **The newest project comes first.** Groups are ordered by their newest.',
    '- **A sixth line.** Past the card\'s five.',
    '',
    '### Design',
    '',
    '- **Not a change.** The brief is the build\'s.',
    '',
    '## Technical implementation',
    '',
    '- **Not for the card.**',
  ].join('\n');
  assert.deepEqual(live.specCardLines(spec), [
    'Stack each project\'s notifications under its two newest',
    'Each project\'s group shows its two newest notifications',
    'One group per project, on every tab',
    'A code word and a link: said plainly',
    'The newest project comes first',
  ], 'its title, then each top-level point of its user-facing half: its bold lead, else its first sentence');
  assert.deepEqual(live.specCardLines('# Plan\n\nIt adds a leaderboard tab. Then more.'), ['It adds a leaderboard tab'],
    'a bare "Plan" is not a line; with no points, the first sentence under the title');
  assert.deepEqual(live.specCardLines(''), []);
  assert.deepEqual(bot.complicatedPlanBullets(PLAN, spec), PLAN.bullets, 'the triage\'s lines, when it wrote them');
  assert.equal(bot.complicatedPlanBullets({ bullets: [] }, spec)[0], 'Stack each project\'s notifications under its two newest');
  assert.deepEqual(bot.complicatedPlanBullets({}, null), ['The change this request asks for, as the plan and its screens below show it']);
  assert.match(read('src/services/homeroom-bot.js'), /bullets: complicatedPlanBullets\(plan, drafted\.specMd\), questions, complicated: true,/);
});

test('a complicated plan keeps what makes it one as the chat reads it: its label and the spec it asks about', () => {
  // 20 Oct 2026: the chat's reader kept only the bullets and questions, so the
  // card's note never showed and the card had no spec to show.
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const plan = (p) => normalizeBotMeta({ homeroomBot: { kind: 'plan', issueNumber: 17, plan: p } })?.homeroomBot.plan;
  assert.deepEqual(plan({ ...PLAN, complicated: true, spec: { sessionId: 900832, version: '1' } }),
    { ...PLAN, complicated: true, spec: { sessionId: 900832, version: 1 } });
  assert.deepEqual(plan({ ...PLAN, complicated: true, spec: { sessionId: 'x', version: 1 } }), { ...PLAN, complicated: true },
    'a spec it cannot name is left off');
  assert.deepEqual(plan({ ...PLAN, spec: { sessionId: 5, version: 1 } }), PLAN, 'a first version\'s plan, as it was');
  assert.equal(plan({ bullets: [], complicated: true }), undefined, 'no lines, no plan');
});

test('the chat\'s plan card shows the plan it asks about, under its lines, and opens the whole of it', () => {
  const { PlanCardView, COMPLICATED_PLAN_NOTE_SHOWN } = loadTsx('frontend/src/features/messages/bot-plan-view.tsx');
  const planSpec = createElement('div', { 'data-test-plan-spec': '' });
  const draw = (props = {}) => renderToHtml(createElement(PlanCardView, {
    appName: 'Chores', plan: { ...PLAN, complicated: true, spec: { sessionId: 5, version: 1 } }, state: 'open', planSpec, ...props,
  }));
  const open = draw();
  assert.ok(open.indexOf('data-bot-plan-lines') < open.indexOf('data-test-plan-spec'), 'under its lines');
  assert.ok(open.indexOf('data-test-plan-spec') < open.indexOf('data-bot-plan-build'), 'above Build it');
  assert.equal(message(COMPLICATED_PLAN_NOTE_SHOWN), 'What you ask to change is posted on the request below, where the group can see it.');
  assert.match(open, /data-bot-plan-note=""><svg[^>]*>[\s\S]*?<\/svg><span>What you ask to change is posted on the request below, where the group can see it\.<\/span>/);
  assert.doesNotMatch(draw({ state: 'built' }), /data-test-plan-spec/, 'its answers take its place once built');
  assert.doesNotMatch(draw({ state: 'replaced' }), /data-test-plan-spec/, 'a replaced plan folds away');

  const { PlanSpec, PlanDocument } = loadTsx('frontend/src/features/messages/bot-plan-spec.tsx');
  const reading = renderToHtml(createElement(PlanSpec, { sessionId: 5, version: 1 }));
  assert.match(reading, /data-bot-plan-spec="reading"/);
  assert.match(reading, /<figure[^>]*aria-busy="true"[^>]*data-bot-plan-pictures=""/, 'the pictures hold their place while it is read');
  assert.match(reading, /<button type="button"[^>]*aria-expanded="false"[^>]*disabled=""[^>]*data-bot-plan-see=""><span>See the plan<\/span>/);
  assert.equal(message('messages:bot.plan.spec.hide'), 'Hide the plan');
  const doc = renderToHtml(createElement(PlanDocument, { read: { state: 'read', html: null, markdown: '# A plan\n\nIt adds a tab.' }, docKey: 'k' }));
  assert.match(doc, /data-bot-plan-doc="markdown"[\s\S]*It adds a tab\./, 'a markdown plan, drawn as the chat draws markdown');

  const host = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(host, /const spec = meta\.plan\.complicated \? meta\.plan\.spec : null;/, 'a complicated change\'s card only');
  assert.match(host, /planSpec=\{spec && Number\(spec\.sessionId\) > 0 && Number\(spec\.version\) > 0 \? <PlanSpec sessionId=\{Number\(spec\.sessionId\)\} version=\{Number\(spec\.version\)\} \/> : null\}/);
  const src = read('frontend/src/features/messages/bot-plan-spec.tsx');
  assert.match(src, /fetch\(`\/api\/sessions\/\$\{sessionId\}\/specs\/\$\{version\}`, \{ credentials: 'same-origin' \}\)/, 'the version the card names, which the bot shared');
});

test('Build it writes the plan and choices into the build note as the requester\'s, kept whole in the build prompt', () => {
  const chosen = [{ question: 'Who shows on the leaderboard?', answer: 'Only people who opt in' }];
  const note = bot.creatorChoiceNote(chosen, { bullets: PLAN.bullets, requester: true });
  assert.equal(note, [
    '',
    '',
    'Approved by the person who asked for it, who said Build it under this plan and its spec:',
    '- A weekly leaderboard tab',
    '- Points for each chore done',
    'The person who asked for it chose (where this differs from the spec\'s suggested answer, this wins):',
    '- Who shows on the leaderboard? Only people who opt in',
  ].join('\n'));
  assert.match(bot.creatorChoiceNote(chosen, { bullets: PLAN.bullets }), /Approved by the creator/, 'a first version\'s heads as they were');
  const long = `${'x'.repeat(5000)}${note}`;
  const split = live.splitApprovedPlan(long);
  assert.match(split.approved, /^Approved by the person who asked for it/);
  const prompt = live.planNoteText(long, false);
  assert.match(prompt, /- Who shows on the leaderboard\? Only people who opt in$/, 'never clipped off the end of a long note');
  assert.equal(live.planNoteText('short note', false), 'short note', 'a note nobody approved reads as it did');
  assert.match(bot.planChoicesNote(PLAN.questions), /shown to the person who asked for it BEFORE anything is built[\s\S]*- Who shows on the leaderboard\? Everyone in the flat \/ Only people who opt in$/);
});

test('its description says it was checked with its requester first', () => {
  assert.equal(live.checkedDescription('Adds a leaderboard.\n\nAsked for by @maya', 'maya'),
    'Adds a leaderboard.\n\nAsked for by @maya\n\nChecked with @maya first: they saw this plan and its screens and said Build it.');
  const once = live.checkedDescription('x', 'maya');
  assert.equal(live.checkedDescription(once, 'maya'), once, 'said once');
  assert.match(live.checkedDescription('x'), /Checked with the person who asked for it first/);
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /const description = credited && checkedFirst \? checkedDescription\(credited, askedBy\) : credited;/);
});

// ── What the verdict does ──

function fakePool(over = () => null) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push([String(sql), params]);
      const answered = over(String(sql), params);
      if (answered) return answered;
      if (/RETURNING id/.test(String(sql)) && /homeroom_bot_run_snapshots/.test(String(sql))) return { rows: [{ id: 321 }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function verdictArgs(over = {}) {
  const pool = over.pool || fakePool();
  return {
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'chores', name: 'Chores' },
    repo: { owner: 'o', repo: 'r' }, issueNumber: 12, issue: { title: 'Leaderboard' },
    parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.', complicated: true, plan: PLAN }, capSuppressed: null, runId: 900,
    seed: 's', seedReadAt: '2026-10-09T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
    ...over,
  };
}

function stubLive(t) {
  const real = { buildAndPropose: live.buildAndPropose, post: live.post };
  const seen = { built: [], posts: [] };
  live.post = async (a) => { seen.posts.push(a); return {}; };
  live.buildAndPropose = async (a) => { seen.built.push(a); return { ok: false, error: 'stop here', costUsd: 0 }; };
  t.after(() => Object.assign(live, real));
  return seen;
}

function stubConfigs(t, current = CURRENT) {
  const real = { currentVersion: configs.currentVersion, laterVersion: configs.laterVersion, finishLive: configs.finishLive };
  configs.currentVersion = async () => current;
  configs.laterVersion = async () => null;
  configs.finishLive = async () => true;
  t.after(() => Object.assign(configs, real));
}

test('a complicated ready verdict queues its plan, and builds nothing; a small one is queued to build as before', async (t) => {
  const seen = stubLive(t);
  const args = verdictArgs();
  assert.equal(await bot.actOnVerdict(args), 'plan_queued');
  assert.ok(args.pool.queries.some(([sql, p]) => /SET live_build_waiting_at = COALESCE\(live_build_waiting_at, NOW\(\)\)/.test(sql) && p[0] === 900),
    'it waits for the build slot, where its spec is drafted');
  assert.equal(seen.built.length, 0, 'nothing is built in the triage\'s turn');
  const small = verdictArgs({ parsed: { verdict: 'ready', buildNote: 'Fix the typo.', complicated: false } });
  assert.equal(await bot.actOnVerdict(small), 'build_queued');
});

test('a first version is planned with its creator exactly as before, whatever the label', async (t) => {
  stubLive(t);
  const sent = [];
  const args = verdictArgs({ firstVersion: true });
  args.deps.dm = { async sendPlanCard(_pool, a) { sent.push(a); return { messageId: 3 }; } };
  assert.equal(await bot.actOnVerdict(args), 'awaiting_go');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].plan.complicated, undefined, 'its card is a first version\'s');
  assert.ok(args.pool.queries.some(([sql]) => /SET awaiting_go_at = NOW\(\), plan = \$2/.test(sql)), 'awaitGo, as it was');
});

test('its build slot drafts the spec only, then asks: DM card, request card and GitHub comment, and waits', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => {
    seen.built.push(a);
    return { ok: false, planned: true, sessionId: 55, specMd: '# Leaderboard\n\nA weekly board.', specVersion: 1, specHtml: '<ol data-changes></ol>', costUsd: 0.4 };
  };
  const pool = fakePool();
  const cards = [];
  const args = verdictArgs({ pool, complicated: true, plan: PLAN, parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' } });
  args.deps.dm = {
    async sendPlanCard(_pool, a) { cards.push(a); return { messageId: 31, conversationId: 4 }; },
    async requesterOf() { return { userId: 2, username: 'maya' }; },
  };
  assert.equal(await bot.buildLive(args), 'awaiting_go');
  assert.equal(seen.built.length, 1);
  assert.equal(seen.built[0].planOnly, true, 'the spec turn alone');
  assert.match(seen.built[0].buildNote, /^Add a leaderboard tab\.\n\nThis spec is shown to the person who asked for it BEFORE anything is built/);
  assert.equal(seen.built[0].review, undefined, 'nothing to review yet');
  const waited = pool.queries.find(([sql]) => /SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\), plan = \$2::jsonb/.test(sql));
  assert.ok(waited, 'it waits for Build it');
  assert.deepEqual(JSON.parse(waited[1][1]), { ...PLAN, complicated: true, spec: { sessionId: 55, version: 1 } });
  assert.equal(waited[1][2], '# Leaderboard\n\nA weekly board.', 'the spec Build it builds from');
  assert.ok(pool.queries.some(([sql, p]) => /SET shared_to_group_at = NOW\(\)/.test(sql) && p[0] === 55), 'readable by the group');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].plan.spec, { sessionId: 55, version: 1 });
  assert.equal(cards[0].plan.complicated, true);
  const post = seen.posts.find((p) => p.kind === 'plan');
  assert.ok(post, 'posted on the request and GitHub');
  assert.match(post.text, /will build it once the person who asked for it says Build it/);
  assert.equal(post.threadMessage.metadata.specShare.sessionId, 55);
  assert.equal(post.untag, 'maya', 'their DM reached them: the request does not ring them twice');
  assert.equal(post.dm, undefined);
  assert.ok(!pool.queries.some(([sql]) => /SET awaiting_go_at = NULL, live_build_waiting_at = NOW\(\)/.test(sql)), 'never builds without an answer');
});

test('a plan that could not be written is said on the request, and nothing waits or builds', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => { seen.built.push(a); return { ok: false, planned: false, error: 'no plan could be written (timeout)', costUsd: 0.1 }; };
  const pool = fakePool();
  const args = verdictArgs({ pool, complicated: true, plan: PLAN });
  args.deps.dm = { async sendPlanCard() { throw new Error('not reached'); }, async requesterOf() { return null; } };
  assert.equal(await bot.buildLive(args), 'build_failed');
  assert.ok(seen.posts.some((p) => p.kind === 'build_failed'));
  assert.ok(!pool.queries.some(([sql]) => /awaiting_go_at = NOW\(\)/.test(sql)));
});

test('a run already waiting for Build it under one plan is never asked about a second (turnly #6)', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => {
    seen.built.push(a);
    return { ok: false, planned: true, sessionId: 56, specMd: '# Another leaderboard', specVersion: 1, costUsd: 0.4 };
  };
  // Another drafting of the same run put its plan to the requester first.
  const pool = fakePool((sql) => (/SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\)/.test(sql) ? { rows: [], rowCount: 0 } : null));
  const args = verdictArgs({ pool, complicated: true, plan: PLAN, parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' } });
  const cards = [];
  args.deps.dm = { async sendPlanCard(_pool, a) { cards.push(a); return { messageId: 32 }; }, async requesterOf() { return null; } };
  assert.equal(await bot.buildLive(args), 'already_built');
  const waited = pool.queries.find(([sql]) => /SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\)/.test(sql));
  assert.match(waited[0], /AND awaiting_go_at IS NULL/, 'only a run no plan waits on yet');
  assert.deepEqual(cards, [], 'no second DM card');
  assert.ok(!seen.posts.some((p) => p.kind === 'plan'), 'and no second plan on the request');
});

test('Build it builds exactly the approved spec, with its screens, reviewed as a first version is, and says it was checked', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  const args = verdictArgs({
    complicated: true, plan: { ...PLAN, complicated: true }, presetSpec: '# Leaderboard', presetSpecHtml: '<ol data-changes></ol>',
    parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' },
  });
  await bot.buildLive(args);
  const built = seen.built[0];
  assert.equal(built.planOnly, undefined, 'a real build');
  assert.equal(built.presetSpec, '# Leaderboard', 'the spec is not drawn again');
  assert.equal(built.presetSpecHtml, '<ol data-changes></ol>');
  assert.equal(built.checkedFirst, true);
  assert.deepEqual(built.review.reviewer, REVIEWER, 'the first-version configuration\'s reviewer and budget');
  assert.deepEqual(built.review.owner, { botRunId: 900 });
  assert.equal(await built.review.budgetCheck(), null, 'the bot\'s allowance, as a first version\'s');

  // The same build, small: no review, nothing checked.
  const small = stubLive(t);
  await bot.buildLive(verdictArgs({ parsed: { verdict: 'ready', buildNote: 'Fix the typo.' } }));
  assert.equal(small.built[0].review, undefined, 'a small change gets no check round');
  assert.equal(small.built[0].checkedFirst, undefined);
  assert.equal(small.built[0].planOnly, undefined);

  // With no reviewer in the configuration, it is built and proposed as it is (fails open).
  const none = stubLive(t);
  stubConfigs(t, { ...CURRENT, recipe: { ...CURRENT.recipe, reviewer: null } });
  await bot.buildLive(args);
  assert.equal(none.built[0].review, null);
  assert.equal(await bot.complicatedReview({}, { runId: 1, bot: { id: 1 } }), null);
});

test('a first version labelled complicated is built exactly as a first version', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  const real = configs.spawnSideBuilds;
  configs.spawnSideBuilds = async () => ({ derived: 0, trials: 0, skipped: 0 });
  t.after(() => { configs.spawnSideBuilds = real; });
  await bot.buildLive(verdictArgs({ firstVersion: true, complicated: true, plan: PLAN }));
  assert.equal(seen.built[0].planOnly, undefined);
  assert.equal(seen.built[0].checkedFirst, undefined);
  assert.equal(seen.built[0].presetSpecHtml, undefined);
  assert.deepEqual(seen.built[0].review.reviewer, REVIEWER, 'its own review, from its own configuration');
});

// #4662: a plan kept from a build a restart interrupted carries its HTML
// beside its markdown, and the build resumes from it whatever the change's
// size: the version people open keeps its tabs and its screens. A complicated
// change still prefers the exact spec its requester approved.
test('a kept plan\'s screens ride along an ordinary resumed build, unreviewed and unchecked', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  await bot.buildLive(verdictArgs({
    presetSpec: '# Kept', presetSpecHtml: '<article data-spec><h1>Kept</h1></article>',
    parsed: { verdict: 'ready', buildNote: 'Fix the typo.' },
  }));
  const built = seen.built[0];
  assert.equal(built.presetSpec, '# Kept', 'built from the kept plan');
  assert.equal(built.presetSpecHtml, '<article data-spec><h1>Kept</h1></article>', 'its screens are kept');
  assert.equal(built.review, undefined, 'no check round: the change is not complicated');
  assert.equal(built.checkedFirst, undefined, 'and not checked first');

  // Where the kept HTML comes from: startBuild reads the whole run, its
  // column with it, and buildOne falls back to it when the plan is not
  // complicated and its approved screens cannot be read.
  const src = read('src/services/homeroom-bot.js');
  const start = src.slice(src.indexOf('async function startBuild('), src.indexOf('const r = await buildOne(pool, config, { bot, app, run, settings'));
  assert.match(start, /'SELECT \* FROM homeroom_bot_runs WHERE id = \$1', \[Number\(runId\)\]/, 'startBuild reads it');
  assert.match(src, /run\.complicated === true \? await approvedSpecHtml\(pool, run\.plan\) : null\) \|\| run\.build_spec_html \|\| null/,
    'buildOne falls back to the run\'s kept HTML');
});

test('buildAndPropose\'s plan-only mode stops after the spec, and a preset spec keeps its screens', () => {
  const src = read('src/services/homeroom-bot-live.js');
  const body = src.slice(src.indexOf('async function buildAndPropose('), src.indexOf('async function reviewLanded('));
  const planOnly = body.indexOf('if (planOnly) {');
  assert.ok(planOnly > body.indexOf('const skippedEarly = await skipNow();'), 'after the spec, its block and its skip check');
  assert.ok(planOnly < body.indexOf('await onSpec('), 'before the spec is posted as being built');
  assert.ok(planOnly < body.indexOf('const runBuildTurn = buildTurnRunner('), 'and before any build turn');
  assert.match(body, /specHtml: presetSpecHtml \? String\(presetSpecHtml\) : null, model: specModel \|\| model,/);
});

// ── Against the full schema ──

test('a complicated change, end to end, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_complicated_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  // A changed plan owes its request a look (bot-request's Owed), which the
  // workflow runtime applies: it runs here, on this database, its pipeline
  // only (no timers, no work), so the queue row its instance holds appears.
  // Its legacy side reads the platform's pool, which is this one.
  const platform = require('../src/workflow/platform.ts');
  const dbPool = require('../src/db/pool');
  const realGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;
  t.after(async () => {
    await platform.stopWorkflow();
    dbPool.getPool = realGetPool;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });
  const mayor = require('../src/services/homeroom-bot-mayor');
  const conversations = require('../src/services/conversations');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Chores', 'chores', 'running', $1, 'private', 'private') RETURNING id`,
    [maya.id],
  );
  const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, maya.id]);
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
     VALUES ($1, 12, $2, 'Add a leaderboard', FALSE, 'A weekly leaderboard')`,
    [app.id, maya.id],
  );
  // The spec the plan stage drafted, on its own (put away) session.
  const { rows: [specSession] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, session_title) VALUES ($1, $2, 'archived', 'plan') RETURNING id`,
    [app.id, homeroomBot.id],
  );
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, content_html) VALUES ($1, 1, '# Leaderboard', '<ol data-changes></ol>')`,
    [specSession.id],
  );
  const SHOWN = { ...PLAN, complicated: true, spec: { sessionId: specSession.id, version: 1 } };
  const waitingRun = async () => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, complicated, plan, awaiting_go_at, build_spec_md)
     VALUES ($1, 12, 'live', 'ready', 'Add a leaderboard tab.', TRUE, $2::jsonb, NOW() - INTERVAL '1 minute', '# Leaderboard') RETURNING id`,
    [app.id, JSON.stringify(SHOWN)],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const planMessage = async (runId) => (await pool.query(
    `SELECT m.id, m.conversation_id, m.content, m.metadata->'homeroomBot' AS meta, m.id AS message_id
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.run_id = $1 AND d.kind = 'plan'`,
    [runId],
  )).rows[0];
  // Their words on the request, as the discussion's own route posts them.
  const ws = {
    pushConversationEvent() {},
    async handleMessage(_pool, { user: who, appId }, { content, thread }) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5)`,
        [appId, who.id, content, thread.type, thread.ref],
      );
      return { ok: true };
    },
  };

  let first;
  await t.test('its requester gets the plan card in their DM: not a first version, the request under it', async () => {
    first = await waitingRun();
    const sent = await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: first, plan: SHOWN, bot: homeroomBot });
    assert.ok(sent?.messageId);
    const card = await planMessage(first);
    assert.equal(card.meta.kind, 'plan');
    assert.equal(card.meta.firstVersion, false);
    assert.deepEqual(card.meta.plan, SHOWN);
    assert.match(card.content, /^Before I build \*\*Chores\*\* request #12, here's my plan:/);
    // The request's card goes under it (validated against GitHub, so not here).
    assert.match(read('src/services/homeroom-bot-dm.js'), /\.\.\.\(complicated \? \{ objects: cardsFor\(PLAN_KIND, \{\}, app, issueNumber\) \} : \{\}\),/);
  });

  await t.test('nothing builds without an answer, and "build it" from somebody else on the request is no answer', async () => {
    assert.equal((await runRow(first)).live_build_waiting_at, null);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'build it', 'issue', 12)`,
      [app.id, sam.id],
    );
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), false);
    assert.equal((await runRow(first)).live_build_waiting_at, null);
    await pool.query('DELETE FROM chat_messages WHERE app_id = $1', [app.id]);
  });

  await t.test('Build it from the DM builds exactly that plan: the spec it showed, its screens, the choices in the note', async () => {
    const card = await planMessage(first);
    const tapped = await mayor.decideOfferTap(pool, {}, { deps: { replies: tapsNow(pool) },
      user: maya, actionId: card.meta.actionId, choice: 'build', answers: ['Only people who opt in'],
    });
    assert.deepEqual(tapped, { ok: true, choice: 'build', label: 'Build it' });
    const run = await runRow(first);
    assert.equal(run.awaiting_go_at, null);
    assert.ok(run.live_build_waiting_at, 'its build waits its turn');
    assert.equal(run.build_spec_md, '# Leaderboard', 'built from the spec they saw (presetSpec)');
    assert.match(run.build_note, /\n\nApproved by the person who asked for it, who said Build it under this plan and its spec:\n- A weekly leaderboard tab\n- Points for each chore done\nThe person who asked for it chose \(where this differs from the spec's suggested answer, this wins\):\n- Who shows on the leaderboard\? Only people who opt in$/);
    assert.equal(await bot.approvedSpecHtml(pool, run.plan), '<ol data-changes></ol>', 'and its screens');
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1', [first, 'test: done']);
  });

  await t.test('"build it" from its requester on the request is Build it, and their card says so', async () => {
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Build it!', 'issue', 12)`,
      [app.id, maya.id],
    );
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), true);
    const after = await runRow(run);
    assert.ok(after.live_build_waiting_at);
    assert.match(after.build_note, /Who shows on the leaderboard\? Everyone in the flat$/, 'the suggested answer');
    const card = await planMessage(run);
    assert.deepEqual([card.meta.status, card.meta.chosen], ['answered', 'build']);
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1', [run, 'test: done']);
    await pool.query('DELETE FROM chat_messages WHERE app_id = $1', [app.id]);
  });

  // #6019: the chat with the bot is private, so Change something drafts
  // their words with Post it, and only the tap puts them on the request.
  await t.test('Change something drafts their words; Post it puts them on the request, ends the wait, and the next look plans with them again', async () => {
    const mayor = require('../src/services/homeroom-bot-mayor');
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    const card = await planMessage(run);
    const sent = await conversations.sendMessage(pool, maya, card.conversation_id, {
      content: 'Make it monthly, not weekly', reply_to_id: card.id,
    });
    const out = await dm.noteUserMessage(pool, {}, {
      user: maya, conversationId: card.conversation_id,
      message: { id: sent.messageId, content: 'Make it monthly, not weekly', reply: { id: card.id } },
      deps: { bot: homeroomBot, ws },
    });
    const offer = (await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [out.messageId])).rows[0];
    const actionId = offer.metadata.homeroomBot.actionId;
    assert.ok(actionId, 'a draft, with Post it');
    const { rows: early } = await pool.query(
      `SELECT 1 FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 12`, [app.id],
    );
    assert.equal(early.length, 0, 'nothing on the request before the tap');
    assert.ok((await runRow(run)).awaiting_go_at, 'and the plan still waits');

    const tapped = await mayor.decideOfferTap(pool, {}, {
      deps: { replies: tapsNow(pool, {}, { bot: homeroomBot, ws }) }, user: maya, actionId, choice: 'yes',
    });
    assert.equal(tapped.ok, true);
    const { rows: [said] } = await pool.query(
      'SELECT content FROM conversation_messages WHERE conversation_id = $1 AND sender_id = $2 ORDER BY id DESC LIMIT 1',
      [card.conversation_id, homeroomBot.id],
    );
    assert.equal(said.content, "Posted on Chores request #12's public discussion, as you. I'll plan it again with it and send the new plan here.");
    const { rows: posted } = await pool.query(
      `SELECT user_id, content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 12`, [app.id],
    );
    assert.equal(posted.length, 1, 'on the request, shared with the group');
    assert.equal(Number(posted[0].user_id), maya.id, 'as their own words');
    assert.match(posted[0].content, /^Make it monthly, not weekly\n\n\(Sent in a chat with Homeroom bot\.\)$/);
    const after = await runRow(run);
    assert.deepEqual([after.awaiting_go_at, after.build_ok, after.build_error, after.plan_change],
      [null, false, 'skipped: its requester asked to change the plan', null], 'nothing kept private');
    const closed = await planMessage(run);
    assert.deepEqual([closed.meta.status, closed.meta.changing], ['closed', true]);
    const { rows: [q] } = await pool.query('SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 12', [app.id]);
    assert.deepEqual(q, { priority: 0, reason: 'plan_change' }, 'read again next');
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 12 }), true, 'and planned with them again');
  });

  await t.test('a small change, or a complicated one already proposed, is not planned again', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 13, 'live', 'ready', 'x')`,
      [app.id],
    );
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 13 }), false);
    const { rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`, [app.id, homeroomBot.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, complicated, proposal_session_id)
       VALUES ($1, 14, 'live', 'ready', 'x', TRUE, $2)`,
      [app.id, proposal.id],
    );
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 14 }), false);
  });

  // ── Papote #3 (18 Oct 2026): "build it" said to the bot re-planned it ──
  //
  // Request #3 on Papote got four plans in a row: "@Homeroom bot status",
  // "try again" and "@Homeroom bot build it" each started a new look, which
  // retired the plan waiting for its requester and wrote the same one again.
  const settings = await bot.readSettings(pool);
  // Both can see it (the bot's tools ask), and Sam is a member, as on Papote.
  await pool.query("UPDATE apps SET view_visibility = 'public', collab_visibility = 'public' WHERE id = $1", [app.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, sam.id]);
  const ctx = (who) => ({
    bot: homeroomBot, user: who, settings, config: {}, deps: { domain: 'app.test' }, cards: [], appIds: new Set(),
  });
  const queued = async () => (await pool.query(
    'SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 12', [app.id],
  )).rows;
  // Each starts with no plan waiting, nothing queued and nothing said. The
  // queue is the workflow's (bot-request): its rows go as its kernel's.
  const fresh = async () => {
    await pool.query('UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, live_build_waiting_at = NULL, build_ok = COALESCE(build_ok, FALSE) WHERE app_id = $1', [app.id]);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      const keys = `request:${Number(app.id)}:%`;
      await c.query("DELETE FROM wf_work WHERE machine = 'bot-request' AND key LIKE $1", [keys]);
      await c.query("DELETE FROM wf_events WHERE machine = 'bot-request' AND key LIKE $1 AND status = 'pending'", [keys]);
      await c.query("DELETE FROM wf_instances WHERE machine = 'bot-request' AND key LIKE $1", [keys]);
      await c.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    await pool.query('DELETE FROM chat_messages WHERE app_id = $1', [app.id]);
  };
  const said = (who, content, { metadata = {}, ago = 0 } = {}) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, metadata, created_at)
     VALUES ($1, $2, $3, 'issue', 12, $4, NOW() - make_interval(secs => $5)) RETURNING id, created_at`,
    [app.id, who.id, content, JSON.stringify(metadata), ago],
  ).then((r) => r.rows[0]);
  // The plan's row in the request's discussion, as planBeforeBuilding posts it.
  const planRow = async (runId) => {
    const card = live.specCard({ sessionId: specSession.id, version: 1, spec: '# Leaderboard', bot: homeroomBot, asking: true, requester: 'maya' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, msg_type, metadata)
       VALUES ($1, $2, $3, 'issue', 12, $4, $5) RETURNING id`,
      [app.id, homeroomBot.id, card.content, card.msgType, JSON.stringify(card.metadata)],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, thread_message_id) VALUES ($1, 12, $2, 'plan', $3)`,
      [app.id, runId, row.id],
    );
    return row.id;
  };
  const rowOf = async (id) => (await pool.query(
    `SELECT content, metadata->'specShare'->>'botNote' AS note FROM chat_messages WHERE id = $1`, [id],
  )).rows[0];

  await t.test('papote #3: start_request from its requester under its plan is Build it, and nothing is read again', async () => {
    await fresh();
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    const row = await planRow(run);
    // Somebody else asking is told whose OK it waits on, and nothing starts.
    const other = await mayor.startRequest(pool, ctx(sam), { project: 'chores', number: 12 });
    assert.equal(other.ok, false);
    assert.match(other.error, /^Its plan waits for @maya to say Build it, and only they can\. Nothing was started; a new look would only plan it again\./);
    assert.ok((await runRow(run)).awaiting_go_at, 'still waiting');
    assert.deepEqual(await queued(), []);
    // Its requester asking is Build it, through the card they were sent.
    const own = await mayor.startRequest(pool, ctx(maya), { project: 'chores', number: 12 });
    assert.equal(own.ok, true);
    assert.match(own.built, /^That was Build it: the plan they were shown goes ahead as written, and it was not planned again\./);
    const after = await runRow(run);
    assert.equal(after.awaiting_go_at, null);
    assert.ok(after.live_build_waiting_at, 'its build waits its turn');
    assert.match(after.build_note, /Approved by the person who asked for it, who said Build it under this plan and its spec:/);
    const card = await planMessage(run);
    assert.deepEqual([card.meta.status, card.meta.chosen], ['answered', 'build']);
    assert.deepEqual(await queued(), [], 'no new look was queued');
    // Its row on the request says it is being built (live.notePlanRows).
    assert.deepEqual(await rowOf(row), { content: "📋 Plan v1: Leaderboard. I'm building it now.", note: 'building' });
    // Asked again while that build waits its turn: nothing new is queued, as a new look would replace it.
    const again = await mayor.startRequest(pool, ctx(maya), { project: 'chores', number: 12 });
    assert.equal(again.ok, true);
    assert.match(again.already, /^It is ready and its build is already on its way/);
    assert.deepEqual(await queued(), []);
    assert.equal(await mayor.pendingBuild(pool, app.id, 12), true);
  });

  await t.test('papote #3: request_detail says the plan waits for Build it, not "building now"', async () => {
    await fresh();
    await waitingRun();
    const mine = await mayor.requestDetail(pool, { user: maya, project: 'chores', number: 12, settings });
    assert.equal(mine.recentLooks[0].build, 'not building: its plan is written and waits for them to say Build it, and nothing is built until then');
    const theirs = await mayor.requestDetail(pool, { user: sam, project: 'chores', number: 12, settings });
    assert.equal(theirs.recentLooks[0].build, 'not building: its plan is written and waits for @maya to say Build it, and nothing is built until then');
  });

  await t.test('papote #3: what was said to the bot under a plan is not an answer to it, and "@Homeroom bot build it" is Build it', async () => {
    await fresh();
    const run = await waitingRun();
    await said(maya, '@​Homeroom bot status');
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), false,
      'nothing said to go ahead yet');
    assert.ok((await runRow(run)).awaiting_go_at);
    await said(maya, '@Homeroom bot build it');
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), true,
      'the question to the bot before it is no word about the plan');
    assert.ok((await runRow(run)).live_build_waiting_at);
  });

  await t.test('papote #3: the refresh reads past what people said to the bot', async () => {
    await fresh();
    const bots = await said(homeroomBot, 'Its plan is ready.', { ago: 40 });
    const plain = await said(sam, 'Looks good to me', { ago: 30 });
    await said(sam, '@homeroom_bot status?', { ago: 20 });
    await said(maya, 'And how long?', { metadata: { quote: { refMsgId: bots.id } }, ago: 10 });
    const seen = await bot.unaddressedActivityByIssue(pool, app.id, [12], homeroomBot.id);
    assert.equal(new Date(seen.get(12)).getTime(), new Date(plain.created_at).getTime(),
      'a mention of the bot and a Reply to it are left out; the rest counts');
    assert.deepEqual(await bot.unaddressedActivityByIssue(pool, app.id, [], homeroomBot.id), new Map());
  });

  await t.test('papote #3: change_plan plans it again with their words, and its row says a newer plan replaced it', async () => {
    await fresh();
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    const row = await planRow(run);
    const out = await mayor.replanRequest(pool, ctx(sam), { project: 'chores', number: 12 });
    assert.equal(out.ok, true);
    assert.match(out.replanning, /for @maya to say Build it\.$/);
    const after = await runRow(run);
    assert.deepEqual([after.awaiting_go_at, after.build_ok, after.build_error],
      [null, false, 'skipped: somebody asked to change the plan']);
    assert.deepEqual(await queued(), [{ priority: 0, reason: 'plan_change' }], 'read again next');
    assert.equal((await planMessage(run)).meta.actions?.length || 0, 0, 'its card\'s buttons went');
    assert.deepEqual(await rowOf(row), { content: '📋 Plan v1: Leaderboard. A newer plan replaced it.', note: 'replaced' });
    const none = await mayor.replanRequest(pool, ctx(maya), { project: 'chores', number: 12 });
    assert.match(none.error, /^No plan of yours waits for Build it on it/);
  });

  await t.test('papote #3: a plan that stopped waiting says so on the request, and only a waiting row changes', async () => {
    await fresh();
    const frames = [];
    const ws = { broadcast: (appId, frame) => frames.push([appId, frame]) };
    const read = await waitingRun();
    const readRow = await planRow(read);
    await bot.retireWaitingPlans(pool, { appId: app.id, issueNumber: 12, why: 'the request was read again', note: 'replaced', deps: { ws } });
    assert.equal((await rowOf(readRow)).note, 'replaced');
    assert.equal(frames.length, 1);
    assert.equal(frames[0][0], app.id);
    assert.equal(frames[0][1].type, 'chat_message_updated');
    assert.equal(frames[0][1].id, readRow);
    assert.equal(frames[0][1].metadata.specShare.botNote, 'replaced');
    assert.deepEqual(frames[0][1].thread, { type: 'issue', ref: 12 });
    const merged = await waitingRun();
    const mergedRow = await planRow(merged);
    await bot.retireWaitingPlans(pool, { appId: app.id, issueNumber: 12, why: 'merged', deps: { ws } });
    assert.deepEqual(await rowOf(mergedRow), { content: '📋 Plan v1: Leaderboard. It stopped waiting for Build it.', note: 'stopped' });
    assert.equal(await live.notePlanRows(pool, [read, merged], 'building', { ws }), 0, 'a row no longer waiting stays as it is');
    assert.equal(await live.notePlanRows(pool, [read], 'nonsense', { ws }), 0);
  });

  await t.test('papote #3: the rows of plans that stopped waiting before this say so once, on the next boot', async () => {
    await fresh();
    const { backfillPlanRows } = require('../src/db/migrate');
    const runWith = async (fields) => {
      const id = await waitingRun();
      await pool.query(`UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, ${fields} WHERE id = $1`, [id]);
      return planRow(id);
    };
    const readAgain = await runWith("build_ok = FALSE, build_error = 'skipped: the request was read again'");
    const changed = await runWith("build_ok = FALSE, build_error = 'skipped: its requester asked to change the plan'");
    const wentAhead = await runWith(`live_build_waiting_at = NOW(), plan = plan || '{"chosen": []}'::jsonb`);
    const aWeek = await runWith("build_ok = FALSE, build_error = 'skipped: nobody tapped Build it within a week'");
    const stillWaiting = await planRow(await waitingRun());
    assert.equal(await backfillPlanRows(pool), 4);
    assert.deepEqual(await rowOf(readAgain), { content: '📋 Plan v1: Leaderboard. A newer plan replaced it.', note: 'replaced' });
    assert.equal((await rowOf(changed)).note, 'replaced');
    assert.deepEqual(await rowOf(wentAhead), { content: "📋 Plan v1: Leaderboard. I'm building it now.", note: 'building' });
    assert.equal((await rowOf(aWeek)).note, 'stopped');
    assert.deepEqual(await rowOf(stillWaiting), { content: '📋 Plan v1: Leaderboard. Waiting for @maya to say Build it.', note: 'waiting' });
    assert.equal(await backfillPlanRows(pool), 0, 'once');
  });
});
