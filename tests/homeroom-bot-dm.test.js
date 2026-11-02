'use strict';

// #3624: the Homeroom bot in a DM, without a database.
//
// The contract pieces: a triage question and a follow-up ask carry their
// suggested answers (the default first); the settings hold the per-person
// weekly allowance; the bot works for anybody let in, and a project it builds
// for somebody is live; the bot's posts on a request carry `dm` to its
// requester's DM; what the DM says is plain and has no em dash; a request
// is held when its requester's allowance is spent; the create dialog sends
// the longer description; and the DM draws a question's answers with the
// line that says an answer is public.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const dm = require('../src/services/homeroom-bot-dm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DASH = /—/;

// ── The question contract ────────────────────────────────────────────────

const fence = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

test('a triage question carries its suggested answers, the default first, short and distinct', () => {
  const parsed = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which list do you mean?', default: 'The shopping list',
    answers: ['The to-do list', 'the shopping list', 'The shopping list', 'x'.repeat(200), 'Both lists', 'Neither', 'Another'],
    blocker: 'user_facing', why_default_fails: 'They are different screens.', build_note: 'Sort the shopping list.',
  }));
  assert.equal(parsed.verdict, 'question');
  assert.deepEqual(parsed.questionAnswers, ['The shopping list', 'The to-do list', 'Both lists', 'Neither'],
    'the default leads, duplicates and over-long lines are dropped, four at most');
});

test('a question with no answers list still offers its default', () => {
  const parsed = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which list?', default: 'The shopping list',
    blocker: 'user_facing', why_default_fails: 'Different screens.', build_note: 'x',
  }));
  assert.deepEqual(parsed.questionAnswers, ['The shopping list']);
  const ready = bot.parseVerdict(fence({ verdict: 'ready', build_note: 'Do it.' }));
  assert.equal(ready.questionAnswers, null, 'only a question has answers');
});

test('the triage prompt asks for answers a person can tap, in plain words', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /give `answers`: two to four short replies/);
  assert.match(prompt, /"answers": \[/);
  assert.match(prompt, /plain words, with no file names, code or jargon/);
});

test('a follow-up ask carries answers too; its other actions keep their shape', () => {
  const ask = followup.parseFollowUp(fence({ action: 'ask', reply: 'Darker or lighter?', answers: ['Darker', 'Lighter', 3] }));
  assert.deepEqual(ask.answers, ['Darker', 'Lighter']);
  const answer = followup.parseFollowUp(fence({ action: 'answer', reply: 'Because.' }));
  assert.equal(Object.hasOwn(answer, 'answers'), false);
  assert.match(followup.followUpPrompt({ seed: 's', replies: [] }), /"answers": \[/);
});

// ── Settings ─────────────────────────────────────────────────────────────

test('the per-person allowance defaults to $50, and there is no DM list to read', () => {
  const s = bot.parseSettings([
    { key: 'homeroom_bot_dm_users', value: JSON.stringify(['Evan', 'ada_2']) },
  ]);
  assert.equal(Object.hasOwn(s, 'dmUsers'), false, 'a row left over from the list is not read');
  assert.equal(s.userWeeklyCents, 5000);
  assert.equal(bot.parseSettings([{ key: 'homeroom_bot_user_weekly_cents', value: '-3' }]).userWeeklyCents, 0);
  assert.equal(s.adminWeeklyCents, 10000, 'an admin\'s defaults to $100');
  assert.equal(bot.parseSettings([{ key: 'homeroom_bot_admin_weekly_cents', value: '25000' }]).adminWeeklyCents, 25000);
});

test('an admin sets the allowance; a DM list is no longer a setting; anything else is refused', () => {
  const ok = bot.validateSettingsPatch({ dmUsers: ['@Evan', 'ada'], userWeeklyCents: 2000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [
    ['homeroom_bot_user_weekly_cents', '2000'],
  ], 'the list is not written');
  assert.deepEqual(bot.validateSettingsPatch({ dmUsers: ['evan'] }), { ok: false, error: 'Nothing to update' });
  assert.equal(bot.validateSettingsPatch({ userWeeklyCents: 1.5 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ userWeeklyCents: -1 }).ok, false);
  assert.deepEqual(bot.validateSettingsPatch({ adminWeeklyCents: 20000 }).updates, [['homeroom_bot_admin_weekly_cents', '20000']]);
  assert.equal(bot.validateSettingsPatch({ adminWeeklyCents: 1.5 }).ok, false);
  assert.equal(bot.validateSettingsPatch({ adminWeeklyCents: -1 }).ok, false);
});

test('a project the bot builds for somebody is live, as every app but a paused one is; never on staging', () => {
  const env = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  try {
    const settings = { mode: 'shadow', pausedApps: ['quiet'] };
    assert.equal(live.isLiveFor(settings, { slug: 'chore-wheel' }), true);
    assert.equal(live.isLiveFor(settings, { slug: 'other' }), true, 'no list to be on');
    assert.equal(live.isLiveFor(settings, { slug: 'quiet' }), false, 'paused');
    assert.equal(live.isLiveFor({ ...settings, mode: 'off' }, { slug: 'chore-wheel' }), false);
    process.env.USERNODE_ENV = 'staging';
    assert.equal(live.isLiveFor(settings, { slug: 'chore-wheel' }), false);
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

test('the bot talks in a DM to anybody let in, whatever its Mode', () => {
  const evan = { username: 'Evan', hasPlatformAccess: true };
  assert.equal(dm.hasBot({ mode: 'shadow' }, evan), true);
  assert.equal(dm.hasBot({ mode: 'off' }, evan), true,
    'Mode decides whether the bot works, not who it talks to');
  assert.equal(dm.hasBot({ mode: 'shadow' }, { username: 'evan' }), false, 'not let in yet');
  assert.equal(dm.isDmUser, undefined, 'the list check is gone');
});

test('hasBot: everyone with platform access has the bot', () => {
  const settings = { mode: 'shadow', dmUsers: ['evan'] };
  const ada = { username: 'ada', hasPlatformAccess: true };
  assert.equal(dm.hasBot(settings, ada), true, 'a list left in the settings silences nobody');
  assert.equal(dm.hasBot(settings, { username: 'evan', hasPlatformAccess: false }), false, 'nor lets anybody in');
  assert.equal(dm.hasBot(settings, { username: 'waiting', hasPlatformAccess: false }), false, 'still on the waitlist');
  assert.equal(dm.hasBot(settings, { username: 'boss', hasPlatformAccess: false, isAdmin: true }), true, 'an admin always has access');
  assert.equal(dm.hasBot(settings, { username: 'member', privateMember: true }), true, 'a private member may use the platform');
  assert.equal(dm.hasBot(settings, { username: 'homeroom_bot', hasPlatformAccess: true, isSynthetic: true }), false);
  assert.equal(dm.hasBot(settings, null), false);
  assert.equal(dm.hasBot(settings, { hasPlatformAccess: true }), false, 'nobody without a username');
  assert.equal(dm.hasBot(null, ada), false);
});

test('a first version gets the longer build clocks', () => {
  const app = { repo_url: 'https://github.com/usernode-bot/x' };
  const plain = bot.buildBudgets(app, {}, 60_000);
  const first = bot.buildBudgets(app, {}, 60_000, { firstVersion: true });
  assert.equal(first.turnBudgetMs, plain.turnBudgetMs * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
  assert.equal(first.specBudgetMs, plain.specBudgetMs * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
  assert.equal(bot.FIRST_VERSION_BUILD_TIME_FACTOR, 2, 'a starter template is small; only the change is larger');
});

// ── What the DM says ─────────────────────────────────────────────────────

const KINDS = {
  question: { question: 'Newest first?', answers: ['Yes'] },
  followup_ask: { question: 'Darker?', answers: ['Yes'] },
  spec: { building: true },
  proposal: { link: 'https://app.onhomeroom.com/#app/x/dev/proposals/9' },
  followup_revise: { summary: 'Made it darker.', link: 'https://app.onhomeroom.com/#app/x/dev/proposals/9' },
  blocked: { reason: 'There is no calendar to read.' },
  build_failed: { reason: 'tests failed' },
  person: { reason: 'It is a policy choice.' },
  followup_person: { reason: 'It is a policy choice.' },
  empty: { reason: 'Nothing here.' },
};

test('every kind the DM carries reads plainly, names the request, and has no em dash', () => {
  const context = { appName: 'Seed swap', issueNumber: 7, issueTitle: 'Sort by date', firstVersion: false };
  for (const [kind, payload] of Object.entries(KINDS)) {
    const text = dm.dmText(kind, payload, context);
    assert.ok(text, kind);
    assert.match(text, /^\*\*Seed swap\*\* · request #7: Sort by date/, kind);
    assert.doesNotMatch(text, DASH, kind);
  }
  assert.equal(dm.dmText('looking', {}, context), null, 'not every post is DM news');
  assert.match(dm.dmText('spec', {}, { ...context, firstVersion: true }), /^\*\*Seed swap\*\*, its first version\n\nI'm building the first version now/);
  assert.match(dm.dmText('proposal', KINDS.proposal, context), /See the preview, and approve it when you're happy with it: https:/);
  // B4: plain words in every kind: the change, never a proposal, a vote or its number.
  for (const [kind, payload] of Object.entries(KINDS)) {
    for (const group of [false, true]) {
      const words = dm.dmText(kind, payload, { ...context, group }).replace(/https?:\S+/g, '');
      assert.doesNotMatch(words, /proposal|vote|merged|PR #/i, kind);
    }
  }
  for (const text of [dm.HELP_TEXT, dm.NOT_ENABLED_TEXT, dm.mirroredText('x', { question: true })]) {
    assert.doesNotMatch(text, DASH);
  }
});

test('a build that did not finish says why in plain words, and that a reply here starts it again', () => {
  // 5 Oct 2026, Page Turners #3: "I tried to build this but couldn't finish
  // (the build ran past its time limit (finished after a restart)). A person
  // can pick it up from here." The requester was the person.
  const context = { appName: 'Page Turners', issueNumber: 3, issueTitle: 'Display location and host information for meetings', firstVersion: false };
  assert.equal(
    dm.dmText('build_failed', { reason: 'the build ran past its time limit (finished after a restart)' }, context),
    '**Page Turners** · request #3: Display location and host information for meetings\n\n'
      + 'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.',
  );
  const said = (reason, extra = {}) => dm.dmText('build_failed', { reason }, { ...context, ...extra }).split('\n\n')[1];
  assert.equal(said('the build ran past its time limit; last activity: npm test'),
    'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.');
  assert.equal(said('the platform restarted in the middle of each of its last 3 tries at building this'),
    'I couldn\'t finish building this: Homeroom restarted while I was working on it, 3 times in a row. Reply here and I\'ll try again.');
  assert.equal(said('the platform restarted while it was building, and the build was lost'),
    'I couldn\'t finish building this: Homeroom restarted while I was working on it. Reply here and I\'ll try again.');
  assert.equal(said('the build produced no change to propose (finished after a restart)'),
    'I couldn\'t finish building this: I ended up with no changes to show you. Reply here and I\'ll try again.');
  assert.equal(said('the change was built but could not be proposed: checks unavailable'),
    'I built this, but I couldn\'t put it up for approval. Reply here and I\'ll try again.');
  assert.equal(said('the build could not start (worker pool exhausted)'),
    'I couldn\'t get started on building this. Reply here and I\'ll try again.');
  assert.equal(said('the build turn failed (exit 1)'),
    'I couldn\'t finish building this: something went wrong while I was working on it. Reply here and I\'ll try again.');
  assert.equal(said(''),
    'I couldn\'t finish building this: something went wrong while I was working on it. Reply here and I\'ll try again.');
  // 14 Oct 2026 (newcomer run eight): a first version is named, and points
  // at the Try again under the message (tests/first-version-stopped.test.js).
  assert.equal(said('the build ran past its time limit', { firstVersion: true }),
    'I couldn\'t finish building Page Turners: it took longer than I\'m allowed. Tap Try again and I\'ll start over.');
  for (const reason of ['the build ran past its time limit (finished after a restart)', 'the build turn failed (exit 1)',
    'the change was built but could not be proposed: x', 'the platform restarted in the middle of each of its last 3 tries at building this']) {
    const text = said(reason);
    assert.doesNotMatch(text, /\(|time limit|finished after|exit 1|pick it up/, 'the run\'s own words are never quoted');
    assert.doesNotMatch(text, DASH);
  }
});

test('#20 (WP3): beside the proposal\'s card the news points at the card; the address is written out only without one', () => {
  const context = { appName: 'Seed swap', issueNumber: 7, issueTitle: 'Sort by date', firstVersion: false };
  const withCard = { ...KINDS.proposal, sessionId: 9 };
  // B4: on a project of theirs alone they approve it; with others, it goes live once it's approved.
  assert.equal(dm.dmText('proposal', withCard, context),
    '**Seed swap** · request #7: Sort by date\n\nIt\'s ready to try. Open the change below to see the preview, '
      + 'and approve it when you\'re happy with it.');
  assert.equal(dm.dmText('proposal', withCard, { ...context, group: true }),
    '**Seed swap** · request #7: Sort by date\n\nIt\'s ready to try. Open the change below to see the preview. '
      + 'It goes live once it\'s approved.');
  assert.deepEqual(dm.cardsFor('proposal', withCard, { id: 3 }, 7), [{ type: 'proposal', appId: 3, sessionId: 9 }],
    'the card it points at is the one that goes under it');
  const revised = dm.dmText('followup_revise', { ...KINDS.followup_revise, sessionId: 9 }, context);
  assert.match(revised, /I updated your change after the latest replies: Made it darker\.\n\nTake another look at it below\.$/);
  for (const text of [dm.dmText('proposal', withCard, context), revised]) {
    assert.doesNotMatch(text, /https?:|onhomeroom/, 'no raw address beside the card, in the DM or its push');
    assert.doesNotMatch(text, DASH);
  }
  // No card (no session to name): the address is the way to it.
  assert.match(dm.dmText('proposal', KINDS.proposal, context), /happy with it: https:\/\/app\.onhomeroom\.com\/#app\/x\/dev\/proposals\/9/);
  assert.match(dm.dmText('followup_revise', KINDS.followup_revise, context), /Take another look: https:/);
});

test('#20 (WP3): a message whose card cannot go says what it says without it', async (t) => {
  const conversations = require('../src/services/conversations');
  const saved = { ensureAdmittedDirect: conversations.ensureAdmittedDirect, sendMessage: conversations.sendMessage };
  t.after(() => Object.assign(conversations, saved));
  const sends = [];
  conversations.ensureAdmittedDirect = async () => ({ conversationId: 5, created: false });
  conversations.sendMessage = async (_pool, _user, _id, input) => {
    sends.push(input);
    return input.objects ? null : { messageId: 70, duplicate: true };
  };
  const sent = await dm.sendDm({ query: async () => ({ rows: [] }) }, {
    bot: { id: 1 }, userId: 2, content: 'Open the proposal below.', withoutCards: 'Open the proposal: https://x/9',
    objects: [{ type: 'proposal', appId: 3, sessionId: 9 }],
  });
  assert.equal(sent.messageId, 70);
  assert.deepEqual(sends.map((s) => [s.content, !!s.objects]), [['Open the proposal below.', true], ['Open the proposal: https://x/9', false]]);
  // relayIssuePost hands it the same news without the card: the address.
  const src = read('src/services/homeroom-bot-dm.js');
  assert.match(src, /withoutCards: dmText\(kind, \{ \.\.\.dm, sessionId: null \}, context\),/);
});

test('#7 (WP3): "live now" is said when the change is live, and the platform\'s own app has no app to open', async () => {
  const line = '**Plant Pal** · request #3: Watering reminders';
  // One story (contract 2.2): a first version is "your first version"; a
  // change is "it", in its request's thread, with Open {project} under it.
  assert.equal(dm.mergedText({ line, appName: 'Plant Pal', live: true }),
    `${line}\n\nYour first version is live. Open Plant Pal to try it.`);
  assert.equal(dm.mergedText({ line, appName: 'Plant Pal', live: false }),
    `${line}\n\nYour first version is going live now. Open Plant Pal in a few minutes to try it.`);
  assert.equal(dm.mergedText({ line, appName: 'Homeroom', live: false, platform: true }),
    `${line}\n\nIt's going live now. It will be live in a few minutes.`);
  assert.equal(dm.mergedText({ line, appName: 'Plant Pal', live: true, card: false }), `${line}\n\nIt's live.`);
  assert.equal(dm.mergedText({ line, appName: 'Plant Pal', live: true, change: true }),
    `${line}\n\nIt's live. Open Plant Pal to see it.`);
  assert.equal(dm.mergedText({ line, appName: 'Plant Pal', live: false, change: true }),
    `${line}\n\nIt's going live now. Open Plant Pal in a few minutes to see it.`);
  // In the request's thread, no line: the card above is the request.
  assert.equal(dm.mergedText({ line: null, appName: 'Plant Pal', live: true, change: true }), 'It\'s live. Open Plant Pal to see it.');
  for (const live of [true, false]) assert.doesNotMatch(dm.mergedText({ line, appName: 'Plant Pal', live }), DASH);
  // 5 October: the app opens from the message's own button, which no card
  // the bot cannot attach takes with it; the proposal is its card.
  assert.deepEqual(dm.cardsFor('merged', { sessionId: 9, appCard: true }, { id: 3 }, 7), [{ type: 'proposal', appId: 3, sessionId: 9 }]);
  assert.deepEqual(dm.cardsFor('merged', { sessionId: 9 }, { id: 3 }, 7), [{ type: 'proposal', appId: 3, sessionId: 9 }]);
  assert.deepEqual(dm.openAppAction({ slug: 'page-turners', appName: 'Page Turners' }),
    { id: 'open_app', label: 'Open Page Turners', style: 'primary', type: 'open', target: '#app/page-turners/app' });
  assert.equal(dm.openAppAction({ slug: '', appName: 'X' }), null);

  // It says live: the bot's change machine asks for it only once the
  // change is live (the merge-followups machine's toLive tells it), so
  // nothing here reads the app's health or waits for it.
  const src = read('src/services/homeroom-bot-dm.js');
  const merged = src.slice(src.indexOf('async function noteProposalMerged('), src.indexOf('// ── A person writing to the bot'));
  assert.match(merged, /^async function noteProposalMerged\(pool, session, \{ deps = \{\} \} = \{\}\)/);
  assert.match(merged, /const live = true;/);
  assert.doesNotMatch(merged, /probeHealth|liveAfterMerge/);
  const services = read('src/workflow/bot-change/services.ts');
  assert.match(services, /legacy\('services\/homeroom-bot-dm'\)\.noteProposalMerged\(pool, \{ id: Number\(input\.sessionId\) \},\s*\{ deps: \{ strict: true \} \}\)/);
});

test('an answer is posted on the request saying where it came from', () => {
  assert.equal(dm.mirroredText('Oldest first', { question: true }), 'Oldest first\n\n(Answered in a chat with Homeroom bot.)');
  assert.equal(dm.mirroredText('Also add dates'), 'Also add dates\n\n(Sent in a chat with Homeroom bot.)');
});

test('a description is something to build from only when it says something, and is kept to its limit', () => {
  assert.equal(dm.normalizeBrief('  short '), null);
  assert.equal(dm.normalizeBrief(42), null);
  assert.equal(dm.normalizeBrief('A list of chores for the house.\r\n'), 'A list of chores for the house.');
  assert.equal(dm.normalizeBrief('x'.repeat(5000)).length, dm.MAX_BRIEF_CHARS);
});

test('without the helper model, the suggested one-liner is the first sentence, cut at a word', async () => {
  assert.equal(dm.firstSentence('A chore wheel for the house. It is fair.'), 'A chore wheel for the house');
  const long = dm.firstSentence(`A ${'very '.repeat(30)}long sentence`, 40);
  assert.ok(long.length <= 40);
  assert.match(long, /…$/);
  const out = await dm.suggestShortDescription({
    name: 'Chore wheel', brief: 'Who does the dishes this week. Fairly.',
    deps: { llm: { async generateShortDescription() { throw new Error('offline'); } } },
  });
  assert.equal(out.description, 'Who does the dishes this week');
  const model = await dm.suggestShortDescription({
    name: 'Chore wheel', brief: 'Who does the dishes this week. Fairly.',
    deps: { llm: { async generateShortDescription() { return { description: 'A fair chore rota', usage: {}, model: 'm' }; } } },
  });
  assert.equal(model.description, 'A fair chore rota');
});

test('a staging copy never files a first version: a GitHub issue is an irreversible side effect', async () => {
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const pool = { async query() { throw new Error('nothing is read on staging'); } };
  try {
    assert.deepEqual(await dm.fileFirstRequest(pool, {}, 1, { steps: null }), { skipped: 'staging' });
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
});

test('the weekly allowance message is keyed by the platform week, which starts on Monday', () => {
  assert.equal(dm.weekKey(new Date('2026-10-01T12:00:00Z')), '20260928');
  assert.equal(dm.weekKey(new Date('2026-09-28T00:00:00Z')), '20260928');
  assert.equal(dm.weekKey(new Date('2026-09-27T23:59:00Z')), '20260921');
});

// ── The bot's posts carry the news to the DM ─────────────────────────────

test('a post with `dm` is relayed to the requester\'s DM; one without is not', async (t) => {
  const relayed = [];
  const real = dm.relayIssuePost;
  dm.relayIssuePost = async (args) => { relayed.push(args); return null; };
  t.after(() => { dm.relayIssuePost = real; });
  const pool = { async query(s) { return /INSERT INTO homeroom_bot_posts/.test(s) ? { rows: [{ id: 11 }] } : { rows: [] }; } };
  const github = { async createIssueComment() { return { id: 1, created_at: 'now' }; } };
  const ws = { async sendBotMessage() { return { id: 5 }; } };
  const sender = { id: 2, username: 'homeroom_bot' };
  const app = { id: 1, slug: 'seed-swap' };
  const repo = { owner: 'o', repo: 'r' };
  await live.post({ pool, github, ws, app, repo, issueNumber: 7, kind: 'looking', text: 'Looking.', sender });
  assert.equal(relayed.length, 0);
  await live.post({
    pool, github, ws, app, repo, issueNumber: 7, kind: 'question', text: 'Q?', sender, runId: 3,
    dm: { question: 'Q?', answers: ['A'] },
  });
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].kind, 'question');
  assert.equal(relayed[0].postId, 11, 'keyed by the post, so a retry sends once');
  assert.deepEqual(relayed[0].dm, { question: 'Q?', answers: ['A'] });
  // A relay that throws never fails the post.
  dm.relayIssuePost = async () => { throw new Error('boom'); };
  const posted = await live.post({ pool, github, ws, app, repo, issueNumber: 7, kind: 'spec', text: 'S', sender, dm: { building: true } });
  assert.equal(posted.postId, 11);
});

test('a live verdict hands its question, and its answers, to the DM', async () => {
  const says = [];
  const deps = {
    github: {}, ws: {},
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
  };
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  live.post = async (args) => { says.push(args); return {}; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  try {
    await bot.actOnVerdict({
      pool: { async query() { return { rows: [] }; } }, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {},
      parsed: { verdict: 'question', question: 'Which?', questionDefault: 'This', questionAnswers: ['This', 'That'] },
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm', deps,
    });
  } finally {
    live.post = realPost; live.advanceSeen = realSeen; live.mentionTargets = realTargets;
  }
  assert.equal(says.length, 1);
  assert.equal(says[0].kind, 'question');
  assert.deepEqual(says[0].dm, { question: 'Which?', answers: ['This', 'That'] });
});

test('a request whose requester spent the week\'s allowance is held, said once, and costs nothing', async (t) => {
  const queries = [];
  const pool = { async query(s, p) { queries.push({ s, p }); return { rows: [] }; } };
  const held = [];
  const deps = {
    github: {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 7, title: 'Sort', body: 'b', state: 'open' } }; },
    },
    worker: {}, agentTurn: {}, threadContext: {}, managedOpenRouter: {}, sessions: {}, activeWorkers: new Set(),
    limits: { async checkBudget() { return { ok: true }; } },
    ws: {}, sessionLifecycle: {},
    dm: {
      async recordRequester() { return { userId: 9, username: 'ada', firstVersion: false }; },
      async overWeeklyAllowance(_pool, settings, userId) { return settings.userWeeklyCents === 100 && userId === 9; },
      async noteOverAllowance(_pool, args) { held.push(args); },
    },
  };
  // The look decides what its end does with the debt (bot-request applies it).
  const look = bot._newLookForTests({});
  const out = await bot._runInLookForTests(look, () => bot.runTriage(pool, {}, {
    bot: { id: 2 }, app: { id: 1, slug: 'seed-swap', repo_url: 'https://github.com/o/r' },
    item: { id: 31, issue_number: 7 }, mode: 'shadow',
    settings: { mode: 'shadow', userWeeklyCents: 100 }, deps,
  }));
  assert.deepEqual(out, { ran: false, reason: 'user_allowance' });
  assert.equal(held.length, 1);
  // Held, not dropped: the debt keeps its place and waits for Monday.
  assert.equal(look.out.queue, 'held', 'the debt is held');
  const reset = new Date(look.out.until);
  assert.equal(reset.getUTCDay(), 1, 'until the week resets on Monday');
  assert.equal(reset.getUTCHours(), 0);
  assert.ok(!queries.some((q) => /homeroom_bot_queue/.test(q.s)), 'the queue row is never written here');
  assert.ok(!queries.some((q) => /INSERT INTO homeroom_bot_runs/.test(q.s)), 'no run, nothing spent');

  // A look the bot queued for itself (a restart's) is free: nobody's week holds it.
  queries.length = 0;
  held.length = 0;
  const free = await bot.runTriage(pool, {}, {
    bot: { id: 2 }, app: { id: 1, slug: 'seed-swap', repo_url: 'https://github.com/o/r' },
    item: { id: 32, issue_number: 7, reason: 'restart' }, mode: 'shadow',
    settings: { mode: 'shadow', userWeeklyCents: 100 }, deps,
  }).catch(() => null);
  assert.notDeepEqual(free, { ran: false, reason: 'user_allowance' });
  assert.equal(held.length, 0);
});

test('billing: whoever asked pays, and what the bot caused itself is charged to nobody', () => {
  assert.deepEqual(bot.billingOf({ reason: 'new' }, 'live'), { charged: true, payerUserId: null }, 'the requester, by default');
  assert.deepEqual(bot.billingOf({ reason: 'dm_start', payer_user_id: 12 }, 'live'), { charged: true, payerUserId: 12 });
  for (const reason of ['restart', 'checks_failing', 'budget_retry']) {
    assert.equal(bot.billingOf({ reason }, 'live').charged, false, reason);
  }
  assert.equal(bot.billingOf({ reason: 'new' }, 'shadow').charged, false, 'a shadow run is never charged');
});

test('the held message names no amount, and offers the group when there is one', () => {
  // #4097: led by the request's line, which Messages draws as its card, as
  // the rest of the request's news is; the words then say "it".
  const solo = dm.overAllowanceText({
    line: dm.requestLine({ appName: 'Plant Pal', issueNumber: 4, issueTitle: 'Sunday watering reminder' }), appName: 'Plant Pal',
  });
  // One story (contract 2.2's on_hold words).
  assert.equal(solo, '**Plant Pal** · request #4: Sunday watering reminder\n\nOn hold until Monday: your building time for this week is used up.');
  const group = dm.overAllowanceText({
    line: dm.requestLine({ appName: 'Supper Club', issueNumber: 9, issueTitle: 'Sunday host reminder' }), appName: 'Supper Club', group: true,
  });
  assert.equal(group, '**Supper Club** · request #9: Sunday host reminder\n\nOn hold until Monday: your building time for this week is used up. Someone else in Supper Club can ask me for it sooner.');
  assert.equal(dm.overAllowanceText({ appName: 'Plant Pal' }), 'On hold until Monday: your building time for this week is used up.', 'no line, the words alone');
  assert.doesNotMatch(solo + group, /\$/);
});

// ── The make screen and the DM screen ────────────────────────────────────

test('the make screen sends the longer description, never with an import', () => {
  // The create dialog that sent it is retired; Create opens the make screen
  // (frontend/src/features/first-session/make.tsx), which asks it of everyone.
  const { BRIEF_MIN, BRIEF_MAX, missingAnswer } = loadTsx('frontend/src/features/first-session/make.tsx');
  assert.equal(BRIEF_MIN, dm.MIN_BRIEF_CHARS, 'the client and server agree on the minimum');
  assert.equal(BRIEF_MAX, dm.MAX_BRIEF_CHARS, 'and on the maximum');
  assert.equal(missingAnswer('short', 'Chore wheel'), 'brief', 'under the minimum is asked for again, not sent');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/first-session/make.tsx'), 'utf8');
  assert.match(src, /maxLength=\{BRIEF_MAX\}/, 'the field stops at the maximum');
  // The description is the plain box or a template's sentence (`text`),
  // unless the choice is a ready-made app, which has nothing to build.
  assert.match(src, /audience,\s+\.\.\.\(ready \? \{ template: ready\.template \} : \{ brief: text\.trim\(\), \.\.\.\(starter \? \{ template: starter\.template \} : \{\}\) \}\),/,
    'a ready-made app has nothing to build; a game preset sends its starter beside the brief');
  // The import sends its repository, and no description to build from.
  const imp = src.slice(src.indexOf('const importRepo = useCallback('), src.indexOf('const formClass ='));
  assert.match(imp, /postCreateApp\(\{ name: repoName, audience: 'invited', repoUrl, from: entry \}\)/);
  assert.doesNotMatch(imp, /brief/);
});

test('the short description is suggested for everyone making a project, and every description is filed', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');
  const suggest = routes.slice(routes.indexOf("router.post('/api/apps/suggest-description'"), routes.indexOf("router.post('/api/apps', "));
  assert.match(suggest, /router\.post\('\/api\/apps\/suggest-description', feedbackTitleLimiter, sameOriginBrowserOnly, async/,
    'the limiter, then the same-origin guard, as before');
  assert.match(suggest, /if \(!req\.user\) return res\.status\(401\)/, 'any signed-in person');
  assert.doesNotMatch(suggest, /isEnabledFor/, 'no longer only for somebody the bot builds for');
  // POST /api/apps hands every description (never an import's) to the
  // first-request record, which decides whether the bot builds it.
  const create = routes.slice(routes.indexOf("router.post('/api/apps', "));
  // Owed with the project, in the route's transaction (its making files it),
  // then said (startFirstVersion: the bot's DM, the early plan).
  assert.match(create, /const owesFirstVersion = !readyMade && !!homeroomBotDm\.normalizeBrief\(req\.body\.brief\);/);
  // 1 Nov 2026 (C2.4): with the design it is made from, when it is.
  assert.match(create, /homeroomBotDm\.recordFirstVersion\(db, pool, config, \{\s+app: appRow, user: req\.user, brief: req\.body\.brief, design: fromDesign,\s+\}\)/);
  assert.match(create, /if \(owesFirstVersion\) \{[\s\S]{0,200}startFirstVersion\(pool, config, \{/);
  // #3624: a ready-made app or a project with no description is recorded for
  // the bot instead, and so is a fork (an import was, before importing from
  // GitHub was paused).
  assert.match(create, /\} else \{\s*try \{\s*await homeroomBotDm\.noteProjectMade\(pool, \{\s*app: appRow, user: req\.user, origin: 'blank',/);
  const fork = routes.slice(routes.indexOf("router.post('/api/apps/:slug/fork'"), routes.indexOf("router.get('/api/apps/:slug'"));
  // Recorded for the bot; its insert started its copy (src/workflow/app-creation/).
  assert.match(fork, /noteProjectMade\(pool, \{ app: appRow, user: req\.user, origin: 'fork' \}\)/);
  assert.match(fork, /forked_from, upstream\)\s+VALUES \(\$1, \$2, \$3, 'creating', 'private', 'private', \$4::jsonb, \$5::jsonb\)/);
  // Every project is live, so nothing reads who made which any more; what
  // was made without a description is recorded only for somebody the bot
  // works for, and an import's record is what holds its backlog back.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'homeroom-bot-dm.js'), 'utf8');
  assert.doesNotMatch(src, /function projectsMadeFor|function firstVersionAppSlugs/);
  const made = src.slice(src.indexOf('async function noteProjectMade('), src.indexOf('// ── Sending'));
  assert.match(made, /if \(!hasBot\(settings, user\)\) return false;\n  const \{ rowCount \} = await pool\.query\(\n    `INSERT INTO homeroom_bot_dm_projects \(app_id, user_id, origin\) VALUES \(\$1, \$2, \$3\)/);
  assert.match(made, /SELECT created_at FROM homeroom_bot_dm_projects WHERE app_id = \$1 AND origin = 'import'/);
  // The bot's wake is only for a first version it builds.
  assert.match(src, /if \(botBuilds\) settingsModule\(\)\.noteIssueActivity\(/);
  assert.match(src, /if \(!last\) throw err;\n    if \(botBuilds\) \{/, 'no DM about a request the bot never took on');
  // Filed by the project's making, whatever the bot's mode: no sweep, on
  // the leader or in the bot's refresh, files it a second way.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /first-request-sweep|sweepFirstVersions/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'homeroom-bot.js'), 'utf8'), /sweepFirstVersions/);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS bot_builds BOOLEAN NOT NULL DEFAULT TRUE;/);
});

test('a question in the DM draws its answers, the default marked, and says an answer is public', () => {
  const { BotQuestion } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {} } },
  });
  const message = {
    id: 5, conversationId: 3, content: 'Q', createdAt: 'now', reactions: [], attachments: [], objects: [],
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: {
      kind: 'question', appName: 'Seed swap', issueNumber: 7, question: 'Newest first?',
      answers: ['Newest first', 'Oldest first'], status: 'open', mirrors: true,
    } },
  };
  const html = renderToHtml(createElement(BotQuestion, { message, conversationId: 3 }));
  assert.match(html, /data-bot-answer="default"[^>]*><span>Newest first<\/span><span class="messages-bot-default">suggested<\/span>/);
  assert.match(html, /Oldest first/);
  // One request, one story (spec 2.3): an answer of one's own is "Write my own".
  assert.match(html, /Write my own/);
  assert.doesNotMatch(html, /Something else/);
  assert.match(html, /posted on Seed swap request #7’s public discussion, where the group can see it/);

  const answered = { ...message, metadata: { homeroomBot: { ...message.metadata.homeroomBot, status: 'answered', answer: 'Oldest first' } } };
  const after = renderToHtml(createElement(BotQuestion, { message: answered, conversationId: 3 }));
  assert.doesNotMatch(after, /Write my own/, 'no buttons once answered');
  assert.match(after, /<dt class="messages-bot-choice-label">You answered<\/dt><dd><span class="messages-bot-chosen">Oldest first<\/span><\/dd>/, '#4197: the answer as a chip, not a button');

  const person = { ...message, sender: { id: 4, username: 'ada' } };
  assert.equal(renderToHtml(createElement(BotQuestion, { message: person, conversationId: 3 })), '', 'only the bot\'s own');

  // #3624 stage 2: an offer to file a request takes the same buttons, but
  // nothing is posted until File it, so no public note, no "suggested", and
  // no Write my own (typing is read by the bot).
  const offer = { ...message, metadata: { homeroomBot: {
    kind: 'confirm', appName: 'Seed swap', question: 'File this as a request on Seed swap?',
    answers: ['File it', 'Not now'], status: 'open',
  } } };
  const offered = renderToHtml(createElement(BotQuestion, { message: offer, conversationId: 3 }));
  // #11 (WP3): the pair is named by the offer's own question, since an offer
  // to withdraw a proposal draws the same pair.
  assert.match(offered, /aria-label="File this as a request on Seed swap\?"/);
  assert.match(offered, /<span>File it<\/span><\/button>/);
  assert.match(offered, /<span>Not now<\/span>/);
  assert.doesNotMatch(offered, /suggested|Write my own|public discussion/);
  // #3770: File it is the act, filled in the accent, and Not now the neutral
  // fill beside it. Not `.messages-bot-other`, which the declared check
  // (homeroom-bot-dm-question) reads as a Something else.
  assert.match(offered, /<button type="button" class="messages-bot-primary" data-bot-answer="default"><span>File it<\/span><\/button><button type="button" class="messages-bot-secondary" data-bot-answer="other"><span>Not now<\/span><\/button><\/div>/);
  assert.match(html, /<button type="button" data-bot-answer="default"><span>Newest first<\/span>/);
  assert.doesNotMatch(html, /messages-bot-primary|messages-bot-secondary/, 'a question\'s answers keep one look: none of them is the act');
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-bot-answers \.messages-bot-primary \{ color: var\(--accent-ink\); background: var\(--accent\); \}/);
  assert.match(css, /\.messages-bot-answers \.messages-bot-other,\s*\.messages-bot-answers \.messages-bot-secondary \{\s*color: var\(--text-secondary\);\s*background: var\(--dc-raised\);/);
  const check = JSON.parse(read('dapp.json')).tests.find((t) => t.id === 'homeroom-bot-dm-question');
  assert.match(check.expectSelector, /\[aria-label\^="File this"\] > button:last-child:not\(\.messages-bot-other\)/);
  const chose = { ...offer, metadata: { homeroomBot: { ...offer.metadata.homeroomBot, status: 'answered', answer: 'File it' } } };
  assert.match(renderToHtml(createElement(BotQuestion, { message: chose, conversationId: 3 })), /You chose: File it/);
});

test('B3: an offer\'s buttons are real: drawn from its actions, pressed once, then one quiet line', async () => {
  const taps = [];
  const { BotQuestion, MIRRORED_KINDS, mirrorsReplies } = loadTsx('frontend/src/features/messages/bot-question.tsx', {
    stubs: { './store': { answerBotQuestion() {}, scopeKey: () => 'k', setReply() {}, async tapBotAction(m, a) { taps.push(a.id); } } },
  });
  const offer = {
    id: 5, conversationId: 3, content: 'Here is the request I\'d file.', createdAt: 'now', reactions: [], attachments: [], objects: [],
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: {
      kind: 'confirm', appName: 'Plant Pal', question: 'File this as a request on Plant Pal?', status: 'open', actionId: 41,
      answers: ['File it', 'Not now'],
      actions: [
        { id: 'yes', label: 'File it', style: 'primary', type: 'server' },
        { id: 'no', label: 'Not now', style: 'secondary', type: 'server' },
      ],
    } },
  };
  const html = renderToHtml(createElement(BotQuestion, { message: offer, conversationId: 3 }));
  // The same look and the same structure the declared check reads.
  assert.match(html, /aria-label="File this as a request on Plant Pal\?"/);
  assert.match(html, /<button type="button" class="messages-bot-primary" data-bot-answer="default"><span>File it<\/span><\/button><button type="button" class="messages-bot-secondary" data-bot-answer="other"><span>Not now<\/span><\/button><\/div>/);
  assert.doesNotMatch(html, /Something else|public discussion/);
  // Decided, here or on another device: the buttons go, one line stays.
  const chose = { ...offer, metadata: { homeroomBot: { ...offer.metadata.homeroomBot, status: 'answered', answer: 'File it', chosen: 'yes' } } };
  const after = renderToHtml(createElement(BotQuestion, { message: chose, conversationId: 3 }));
  assert.doesNotMatch(after, /<button/);
  assert.match(after, /<p class="messages-bot-answered">You chose File it<\/p>/);

  // A reply is public only for a question, or news that asks for a reply;
  // never for an activity card or a ready message, whatever older messages say.
  assert.equal(mirrorsReplies({ kind: 'question', mirrors: true }), true);
  assert.equal(mirrorsReplies({ kind: 'blocked', mirrors: true }), true);
  assert.equal(mirrorsReplies({ kind: 'activity', mirrors: true }), false);
  assert.equal(mirrorsReplies({ kind: 'proposal', mirrors: true }), false);
  assert.equal(mirrorsReplies({ kind: 'question' }), false);
  assert.deepEqual([...MIRRORED_KINDS].sort(), [...dm.MIRRORED_KINDS].sort(), 'the reply bar and the server agree');
});

test('B3: the client keeps a bot message\'s buttons, at most three and one primary, and never a link out', () => {
  const { normalizeBotMeta } = loadTsx('frontend/src/features/messages/api.ts');
  const meta = normalizeBotMeta({ homeroomBot: {
    kind: 'confirm', actionId: 41, chosen: 'yes', startedAt: '2026-10-04T10:00:00Z', live: true,
    actions: [
      { id: 'yes', label: 'File it', style: 'primary', type: 'server' },
      { id: 'also', label: 'Second primary', style: 'primary', type: 'server' },
      { id: 'web', label: 'Elsewhere', style: 'secondary', type: 'open', target: 'https://example.com' },
      { id: 'mystery', label: 'Unknown', style: 'secondary', type: 'teleport' },
      { id: 'try', label: 'Try it', style: 'secondary', type: 'open', target: '#app/plant-pal' },
      { id: 'more', label: 'One too many', style: 'secondary', type: 'prompt' },
    ],
  } }).homeroomBot;
  assert.equal(meta.actionId, 41);
  assert.equal(meta.chosen, 'yes');
  assert.equal(meta.startedAt, '2026-10-04T10:00:00Z');
  assert.equal(meta.live, true);
  assert.deepEqual(meta.actions, [
    { id: 'yes', label: 'File it', style: 'primary', type: 'server' },
    { id: 'also', label: 'Second primary', style: 'secondary', type: 'server' },
    { id: 'try', label: 'Try it', style: 'secondary', type: 'open', target: '#app/plant-pal' },
  ]);
});

test('B3: a tap is decided by its own browser-only route, never by the label sent as a message', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/actions\/:actionId', conversationMessageLimiter, sameOriginBrowserOnly,/);
  const policy = read('src/services/cli-api-policy.js');
  assert.doesNotMatch(policy, /homeroom-bot\/actions/, 'no connector or agent presses a person\'s buttons');
  const store = read('frontend/src/features/messages/store.ts');
  const tap = store.slice(store.indexOf('export async function tapBotAction'), store.indexOf('function idempotencyKey'));
  assert.match(tap, /await api\.decideBotAction\(actionId, action\.id\)/);
  assert.doesNotMatch(tap, /content: action\.id/);
  // The demo's offer carries the same buttons a live one does.
  const fixtures = read('src/services/staging-messages.js');
  assert.match(fixtures, /actions: \[\s+\{ id: 'yes', label: 'File it', style: 'primary', type: 'server' \},\s+\{ id: 'no', label: 'Not now', style: 'secondary', type: 'server' \},\s+\]/);
});

test('the Messages client keeps the bot\'s mark and its question, which it builds field by field', () => {
  // The first staging run showed the question as plain text: this
  // normalizer dropped both fields before the screen ever saw them.
  const { normalizeMessage } = loadTsx('frontend/src/features/messages/api.ts');
  const message = normalizeMessage({
    id: 5, conversationId: 3, content: 'Q', createdAt: '2026-10-01T00:00:00Z',
    sender: { id: 2, username: 'homeroom_bot', bot: true },
    metadata: { homeroomBot: {
      kind: 'question', appName: 'Seed swap', issueNumber: 7, mirrors: true, status: 'open',
      question: 'Newest first?', answers: ['Newest first', 7, 'Oldest first'], unknown: 'x',
    } },
  });
  assert.equal(message.sender.bot, true);
  assert.equal(message.metadata.homeroomBot.status, 'open');
  assert.equal(message.metadata.homeroomBot.mirrors, true);
  assert.equal(message.metadata.homeroomBot.issueNumber, 7);
  assert.deepEqual(message.metadata.homeroomBot.answers, ['Newest first', 'Oldest first']);
  assert.equal(Object.hasOwn(message.metadata.homeroomBot, 'unknown'), false, 'only the named fields');
  const person = normalizeMessage({ id: 6, content: 'hi', sender: { id: 4, username: 'ada' } });
  assert.equal(Object.hasOwn(person, 'metadata'), false);
  assert.equal(Object.hasOwn(person.sender, 'bot'), false);
});

test('the DM screen draws the bot\'s question and badge, and the reply bar names where a reply goes', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  // B6: two questions at once draw their own card (./bot-plan.tsx) instead.
  // B7: nor does a change's ready card (./bot-ready.tsx), whose buttons are its own.
  assert.match(row, /message\.sender\.bot && \(message\.metadata\?\.homeroomBot\?\.question \|\| message\.metadata\?\.homeroomBot\?\.actions\?\.length\)\s*&& !isTwoQuestions\(message\) && !isReadyMessage\(message\)\s*\? <BotQuestion/);
  assert.match(row, /messages-bot-badge/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  // #6019: this chat is private. A typed reply comes back as a draft with
  // Post it (homeroom-bot-mayor.js offerPost), and the reply bar says so.
  assert.match(composer, /\{t\('messages:bot\.draft\.reply'\)\}/);
  assert.equal(message('messages:bot.draft.reply'), 'Your reply stays in this chat until you tap Post it.');
  const css = read('public/css/app.css');
  for (const cls of ['.messages-bot-badge', '.messages-bot-answers button', '.messages-bot-note', '.messages-bot-default']) {
    assert.ok(css.includes(cls), cls);
  }
});

// ── Typing, while the bot answers (#3684) ────────────────────────────────

// The typing event goes out through the same audience gate a person's does
// (conversations.withLockedAudience, which needs a database): stood in for
// here by a DM of the bot (2) and Ada (9).
function typingHarness(t) {
  const conversations = require('../src/services/conversations');
  const realAudience = conversations.withLockedAudience;
  const audiences = [];
  conversations.withLockedAudience = async (_pool, actor, conversationId, callback) => {
    audiences.push({ actor: actor.id, conversationId });
    await callback([2, 9]);
    return [2, 9];
  };
  t.after(() => { conversations.withLockedAudience = realAudience; });
  const events = [];
  const ws = {
    pushConversationEvent(memberIds, payload, options) { events.push({ memberIds, payload, options }); return 1; },
  };
  const typing = () => events.filter((e) => e.payload.type === 'conversation_typing').map((e) => e.payload.typing);
  return { audiences, events, ws, typing };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the bot types from the start of its answer until the answer is sent, as a person\'s typing event', async (t) => {
  const { audiences, events, ws, typing } = typingHarness(t);
  const out = await dm.whileTyping({}, { botId: 2, conversationId: 41, ws }, async () => {
    await settle();
    assert.deepEqual(typing(), [true], 'typing while it works');
    ws.pushConversationEvent([2, 9], { type: 'conversation_message_created', conversationId: 41, messageId: 1 });
    return 'answered';
  });
  assert.equal(out, 'answered', 'the answer is what the work resolved');
  assert.deepEqual(events.map((e) => e.payload.type === 'conversation_typing' ? e.payload.typing : 'reply'), [true, 'reply', false],
    'it stops once the answer is out, never before');
  const first = events[0];
  assert.deepEqual(first.payload, { type: 'conversation_typing', conversationId: 41, userId: 2, typing: true });
  assert.deepEqual(first.options, { excludeUserId: 2, actorUserId: 2 }, 'delivery retains the bot actor to recheck blocks after enqueueing');
  assert.deepEqual(audiences, [{ actor: 2, conversationId: 41 }, { actor: 2, conversationId: 41 }],
    'as the bot, through the gate that drops a DM the person blocked');
});

test('a long answer keeps the bot typing, and a failed one still stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { ws, typing } = typingHarness(t);
  let finish;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 42, ws }, () => new Promise((resolve, reject) => { finish = reject; }));
  await settle();
  for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(dm.TYPING_RENEW_MS); await settle(); }
  finish(new Error('model failed'));
  await assert.rejects(answering, /model failed/, 'the failure is the caller\'s to see');
  await settle();
  const said = typing();
  assert.deepEqual(said, [true, true, true, true, true, true, false], 'said again on every renewal, then stopped');
  t.mock.timers.tick(dm.TYPING_RENEW_MS * 3);
  await settle();
  assert.equal(typing().length, said.length, 'and nothing after');
});

test('an answer that never ends stops the typing at the cap, and each renewal beats the reader\'s expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { ws, typing } = typingHarness(t);
  let finish;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 43, ws }, () => new Promise((resolve) => { finish = resolve; }));
  await settle();
  for (let at = 0; at < dm.TYPING_MAX_MS; at += dm.TYPING_RENEW_MS) { t.mock.timers.tick(dm.TYPING_RENEW_MS); await settle(); }
  const said = typing();
  assert.equal(said.at(-1), false, 'stopped at the cap, whatever the work is doing');
  assert.equal(said.filter((v) => v === false).length, 1);
  t.mock.timers.tick(dm.TYPING_RENEW_MS * 3);
  await settle();
  assert.equal(typing().length, said.length, 'no renewal after the cap');
  finish('late');
  assert.equal(await answering, 'late');
  await settle();
  assert.equal(typing().length, said.length, 'a late answer stops nothing twice');

  // The Messages reader drops a typing line it has not heard again within
  // its expiry, so the renewal must come sooner, with room for the trip.
  const store = read('frontend/src/features/messages/store.ts');
  const expiry = Number(store.match(/case 'conversation_typing': \{[\s\S]*?\}, (\d+)\)\);/)[1]);
  assert.equal(expiry, 6000);
  assert.ok(dm.TYPING_RENEW_MS <= expiry - 1500, 'renewed well inside the reader\'s expiry');
});

test('two answers in one DM keep one typing line up until the last is sent', async (t) => {
  const { ws, typing } = typingHarness(t);
  const finishers = [];
  const work = () => new Promise((resolve) => { finishers.push(resolve); });
  const first = dm.whileTyping({}, { botId: 2, conversationId: 44, ws }, work);
  const second = dm.whileTyping({}, { botId: 2, conversationId: 44, ws }, work);
  await settle();
  assert.deepEqual(typing(), [true], 'said once');
  finishers[0]('one');
  await first;
  await settle();
  assert.deepEqual(typing(), [true], 'still typing the second answer');
  finishers[1]('two');
  await second;
  assert.deepEqual(typing(), [true, false]);
});

test('31 Oct 2026: an answer to a message in a thread types in that thread, apart from the main chat', async (t) => {
  const { events, ws } = typingHarness(t);
  const finishers = [];
  const work = () => new Promise((resolve) => { finishers.push(resolve); });
  const inThread = dm.whileTyping({}, { botId: 2, conversationId: 45, threadRootId: 13006, ws }, work);
  const inMain = dm.whileTyping({}, { botId: 2, conversationId: 45, ws }, work);
  await settle();
  const said = () => events.filter((e) => e.payload.type === 'conversation_typing')
    .map((e) => [e.payload.threadRootId || null, e.payload.typing]);
  assert.deepEqual(said().sort(), [[13006, true], [null, true]].sort(), 'one line in each place');
  assert.deepEqual(events[0].payload.threadRootId === undefined ? events[1].payload : events[0].payload,
    { type: 'conversation_typing', conversationId: 45, userId: 2, typing: true, threadRootId: 13006 });
  finishers[0]('thread');
  await inThread;
  assert.deepEqual(said().filter(([, typing]) => !typing), [[13006, false]], 'the thread\'s stops, the main chat\'s stays');
  finishers[1]('main');
  await inMain;
  assert.deepEqual(said().filter(([, typing]) => !typing), [[13006, false], [null, false]]);
});

// 1 Nov 2026: what the bot is doing rides on its typing event, for the
// working card (frontend/src/features/messages/bot-working.tsx).
test('what the bot is doing goes out on its typing event at once, and on every renewal after, until it changes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { events, ws } = typingHarness(t);
  const doings = () => events.filter((e) => e.payload.type === 'conversation_typing').map((e) => [e.payload.typing, e.payload.doing || null]);
  let finish;
  let handed;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 47, threadRootId: 13006, ws }, (typing) => {
    handed = typing;
    return new Promise((resolve) => { finish = resolve; });
  });
  await settle();
  assert.equal(typeof handed.doing, 'function', 'the work is handed what says it');
  assert.deepEqual(doings(), [[true, null]], 'thinking, first: no doing');
  await handed.doing({ kind: 'request', number: 12 });
  assert.deepEqual(doings().at(-1), [true, { kind: 'request', number: 12 }], 'said at once');
  await handed.doing({ kind: 'request', number: 12 });
  assert.equal(doings().length, 2, 'the same thing is not said again');
  t.mock.timers.tick(dm.TYPING_RENEW_MS);
  await settle();
  assert.deepEqual(doings().at(-1), [true, { kind: 'request', number: 12 }], 'and rides on the renewal');
  assert.equal(events.at(-1).payload.threadRootId, 13006, 'in the place it types');
  await handed.doing({ kind: 'code', project: '  Ear   Trainer ' });
  await handed.doing(null);
  t.mock.timers.tick(dm.TYPING_RENEW_MS);
  await settle();
  assert.deepEqual(doings().slice(-3), [[true, { kind: 'code', project: 'Ear Trainer' }], [true, null], [true, null]],
    'a new kind at once; back to thinking, and the renewal says so too');
  finish('done');
  await answering;
  assert.deepEqual(doings().at(-1), [false, null], 'a stop carries no doing');
  await handed.doing({ kind: 'drawing' });
  assert.deepEqual(doings().at(-1), [false, null], 'and nothing is said once it has stopped');
});

// 1 Nov 2026: a screen asked for in Main Chat is drawn in a thread the
// designer opens; the typing, and so the working card, goes there with it.
test('the typing moves to the thread the answer goes on in, with what it was doing, and ends there', async (t) => {
  const { events, ws } = typingHarness(t);
  const typed = () => events.filter((e) => e.payload.type === 'conversation_typing')
    .map((e) => [e.payload.threadRootId || null, e.payload.typing, e.payload.doing || null]);
  let finish;
  let handed;
  const answering = dm.whileTyping({}, { botId: 2, conversationId: 41, ws }, (typing) => {
    handed = typing;
    return new Promise((resolve) => { finish = resolve; });
  });
  await settle();
  assert.equal(typeof handed.moveTo, 'function', 'the work is handed what moves it');
  await handed.doing({ kind: 'drawing' });
  await handed.moveTo(13010);
  await settle();
  assert.deepEqual(typed(), [
    [null, true, null],
    [null, true, { kind: 'drawing' }],
    [13010, true, null],
    [13010, true, { kind: 'drawing' }],
    [null, false, null],
  ], 'typing in the thread first, with what it was doing, then stopped in the main chat');
  await handed.moveTo(13010);
  assert.equal(typed().length, 5, 'moving to where it already is changes nothing');
  await handed.doing({ kind: 'designing' });
  assert.deepEqual(typed().at(-1), [13010, true, { kind: 'designing' }], 'and it says what it does there');
  finish('drawn');
  assert.equal(await answering, 'drawn');
  assert.deepEqual(typed().at(-1), [13010, false, null], 'it stops where it is when the answer is out');
  assert.equal(typed().filter(([root, typing]) => root === null && !typing).length, 1, 'the main chat stopped once');
});

test('a typing event carries only the kinds of work the screen words, and what they name', () => {
  // Homeroom bot parity: P1 'writing' (the answer as it is written), P3 'looking' (a helper sent into a
  // project's code, named by the project as 'code' is).
  assert.deepEqual([...dm.DOING_KINDS], ['progress', 'request', 'code', 'drawing', 'designing', 'drafting', 'writing', 'looking']);
  assert.deepEqual(dm.typingDoing({ kind: 'looking', project: 'Gym Tracker', number: 3 }), { kind: 'looking', project: 'Gym Tracker' });
  assert.deepEqual(dm.typingDoing({ kind: 'drawing', extra: 'x' }), { kind: 'drawing' });
  assert.deepEqual(dm.typingDoing({ kind: 'request', number: '7' }), { kind: 'request', number: 7 });
  assert.equal(dm.typingDoing({ kind: 'request' }), null, 'a request is named by its number');
  assert.deepEqual(dm.typingDoing({ kind: 'code', project: 'x'.repeat(200) }).project.length, 61, 'a short name');
  assert.deepEqual(dm.typingDoing({ kind: 'code', project: '' }), { kind: 'code' });
  assert.equal(dm.typingDoing({ kind: 'Reading request #12' }), null, 'never words');
  assert.equal(dm.typingDoing(null), null);
  // A person's typing route never says what anybody is doing.
  const route = read('src/routes/conversations.js');
  const typing = route.slice(route.indexOf("router.post('/api/conversations/:id/typing'"), route.indexOf("router.post('/api/conversations/:id/typing'") + 1500);
  assert.doesNotMatch(typing, /doing/);
});

test('a message from somebody let in is answered while the bot types; anybody else\'s is not', async (t) => {
  const { ws, typing } = typingHarness(t);
  const pool = {
    async query(sql) {
      if (/FROM platform_settings/.test(sql)) return { rows: [{ key: 'homeroom_bot_mode', value: 'shadow' }] };
      if (/FROM conversation_direct_pairs/.test(sql)) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
  };
  const bot = { id: 2, username: 'homeroom_bot' };
  const seen = [];
  const mayor = {
    async decideOffer() { return null; },
    async runDmTurn(_pool, _config, args) {
      await settle();
      seen.push(typing().slice());
      // 1 Nov 2026: and is handed what says what it is doing, and what moves it.
      assert.equal(typeof args.deps.doing, 'function');
      assert.equal(typeof args.deps.moveTyping, 'function');
      return { turn: args.message.id };
    },
  };
  const out = await dm.noteUserMessage(pool, {}, {
    user: { id: 9, username: 'ada', hasPlatformAccess: true }, conversationId: 45, message: { id: 70, content: 'what are you working on?' },
    deps: { bot, mayor, ws },
  });
  assert.deepEqual(out, { turn: 70 });
  assert.deepEqual(seen, [[true]], 'typing while the model answers');
  assert.deepEqual(typing(), [true, false], 'and stopped once it has');

  const conversations = require('../src/services/conversations');
  const realOpen = conversations.ensureAdmittedDirect;
  conversations.ensureAdmittedDirect = async () => null;
  t.after(() => { conversations.ensureAdmittedDirect = realOpen; });
  await dm.noteUserMessage(pool, {}, {
    user: { id: 11, username: 'sam', hasPlatformAccess: false }, conversationId: 46, message: { id: 71, content: 'hi' },
    deps: { bot, mayor, ws },
  });
  assert.deepEqual(typing(), [true, false], 'the bot does not type to somebody it does not answer');
});

test('#3772: "needs a person" says what to do about it, and a card already showing it is not repeated', () => {
  const ctx = { appName: 'Ear Trainer', issueNumber: 13, issueTitle: 'Use MIDI' };
  const text = dm.dmText('person', { reason: 'It needs a new dependency.' }, ctx);
  assert.match(text, /This needs a person to decide, so I haven't built it: It needs a new dependency\./);
  assert.match(text, /If you decide to go ahead \(or the group does\), reply to this message and say so, and I'll look at it again\.$/);
  assert.match(dm.dmText('followup_person', { reason: 'x' }, ctx), /so I've left it for the group: x$/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  // One story: "I'm building it now" is a quiet line in the request's
  // thread (cardOnly, stepLine), never a second card, and no news carries
  // the request's card again under it.
  assert.equal(dm.cardOnly('spec', {}), true);
  assert.match(src, /objects: dm\.card \? \[\] : cardsFor\(kind, dm, app, issueNumber\)\.filter\(\(c\) => !\(shown && c\.type === 'issue'\)\),/);
  // In the thread, the request is the card above: its line is not repeated.
  assert.equal(dm.dmText('person', { reason: 'x' }, { ...ctx, threaded: true }).startsWith('This needs a person to decide'), true);
});

test('a requester who does not decide on the project is told who does, and offered no Go ahead that would loop', () => {
  const ctx = { appName: 'Geneva Hikes', issueNumber: 2, issueTitle: 'A real map' };
  const text = dm.dmText('person', { reason: 'A map needs a tile provider.', deciders: ['ann', 'bo'] }, ctx);
  assert.match(text, /This needs a person to decide, so I haven't built it: A map needs a tile provider\./);
  assert.match(text, /On Geneva Hikes, @ann or @bo decide things like this\. Once one of them says to go ahead on the request, I'll look at it again\.$/);
  assert.doesNotMatch(text, /If you decide to go ahead/);
  assert.match(dm.dmText('person', { reason: 'x', deciders: ['ann'] }, ctx), /On Geneva Hikes, @ann decides things like this\. Once they say to go ahead on the request, I'll look at it again\.$/);
  assert.match(dm.dmText('person', { reason: 'x', deciders: ['ann', 'bo', 'cy'] }, ctx), /@ann, @bo or @cy decide/);
  assert.match(dm.dmText('person', { reason: 'x', deciders: ['<b>', 7] }, ctx), /If you decide to go ahead/, 'nothing usable: as before');
  assert.doesNotMatch(text, /\u2014/);
});

test('a request found already done says so, where it is, and that a vote on closing it follows', () => {
  const ctx = { appName: 'Ear Trainer', issueNumber: 14, issueTitle: 'Show my votes' };
  // One story: one message, the verdict and its offer (Propose to close,
  // Tell me what's missing), folded in by homeroom-bot-move.js foldOffer.
  for (const kind of ['person', 'empty']) {
    const text = dm.dmText(kind, { reason: 'Open Profile, then Your votes.', done: true }, ctx);
    assert.match(text, /\n\nThis looks done already: Open Profile, then Your votes\.$/, kind);
    assert.doesNotMatch(text, /—/);
  }
  assert.match(dm.dmText('person', { reason: 'x', done: true, deciders: ['ann'] }, ctx), /looks done already/, 'done comes before who decides');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  assert.match(src, /: \(kind === 'person' \|\| kind === 'empty'\) && dm\.done \? 'close_request' : null;/);
  assert.match(src, /const offer = offerKind \? await move\.foldOffer\(pool, \{/);
  assert.deepEqual(require('../src/services/homeroom-bot-move').DONE_ACTIONS.map((a) => a.label), ['Propose to close', 'Tell me what\'s missing']);
});

test('#4239: a request about Homeroom itself says so, and offers the move instead of Go ahead', () => {
  const ctx = { appName: 'Ear Trainer', issueNumber: 13, issueTitle: 'Header colour' };
  const text = dm.dmText('person', { reason: 'The header is drawn by Homeroom.', platform: true }, ctx);
  // One story: one message, whose own buttons are the move.
  assert.match(text, /This is about Homeroom itself rather than Ear Trainer, so no change to Ear Trainer can do it: The header is drawn by Homeroom\.$/);
  assert.doesNotMatch(text, /\u2014/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  assert.match(src, /\.\.\.\(STUCK_ACTIONS\[kind\] && !\(kind === 'person' && \(dm\.platform \|\| personDeciders\(dm\)\.length\)\) && !dm\.done\n\s+\? \{ actions: STUCK_ACTIONS\[kind\], status: 'open' \} : \{\}\),/);
  assert.match(src, /const offerKind = kind === 'person' && dm\.platform \? 'move_request'/);
});

test('"typing" goes out before the answer starts, bounded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function whileTyping('), src.indexOf('// ── Who a request is for'));
  // 1 Nov 2026: the work is handed what says what it is doing, and what moves it.
  assert.ok(fn.indexOf('stop.ready') < fn.indexOf('return await work(typing);'), 'the answer waits for its typing event');
  assert.match(fn, /setTimeout\(resolve, TYPING_FIRST_WAIT_MS\)/, 'but never long');
  assert.match(src, /created\.first = sendTyping\(pool, botId, id, true, io, root\);/);
  assert.match(src, /stop\.ready = entry\.first \|\| Promise\.resolve\(\);/);
});

test('news the card and the tray show is never a DM message of its own; what needs them still is', () => {
  for (const kind of ['spec', 'followup_revise']) {
    assert.equal(dm.cardOnly(kind, {}), true, kind);
  }
  // 16 Oct 2026 (V4): a build waiting for one of the project's slots rings
  // once, as on hold, and a request somebody else's change shipped as done
  // another way: neither wait nor ending is silent any more.
  for (const kind of ['held_proposals_per_app', 'held_proposals_total']) {
    assert.equal(dm.cardOnly(kind, {}), false, kind);
    assert.equal(dm.storyMomentOf({ kind }), 'on_hold', kind);
    assert.equal(dm.saidOf(kind), 'slots', kind);
  }
  assert.equal(dm.storyMomentOf({ kind: 'request_closed' }), 'done_elsewhere');
  assert.equal(dm.saidOf('request_closed'), 'done_elsewhere');
  // 16 Oct 2026: a person took on what the bot had promised: on hold, as theirs.
  assert.equal(dm.storyMomentOf({ kind: 'request_taken' }), 'on_hold');
  assert.equal(dm.saidOf('request_taken'), 'taken');
  // One story: a change's red checks a person must look at are a stop of
  // their own ('checks'), which rings; an answer to what they asked too.
  assert.equal(dm.newsKind('followup_person', { reason: 'its checks are failing: x', checks: true }), 'checks');
  assert.equal(dm.cardOnly('checks', {}), false, 'a change\'s red checks');
  assert.equal(dm.storyMomentOf({ kind: 'checks' }), 'stopped');
  assert.equal(dm.cardOnly('followup_person', { reason: 'a product call' }), false, 'an answer to what they asked');
  for (const kind of ['question', 'followup_ask', 'plan', 'proposal', 'person', 'empty', 'blocked', 'build_failed', 'followup_failed']) {
    assert.equal(dm.cardOnly(kind, {}), false, kind);
  }
});
