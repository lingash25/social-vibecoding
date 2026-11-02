// #3146: the Homeroom bot, live: on every app but a paused one (it started on
// a list of apps, `homeroom_bot_live_apps`, retired since).
//
// What matters most here is the loop the bot must never start: a post is
// issue activity, and issue activity re-queues the issue. Those tests come
// first. Then posting, proposing through the one real /promote handler,
// and the build.
//
// Run with: node --test tests/homeroom-bot-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const LIVE_SRC = read('src/services/homeroom-bot-live.js');
const BOT_SRC = read('src/services/homeroom-bot.js');

const APP = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', repo_url: 'https://github.com/usernode-bot/rss-reader' };
const REPO = { owner: 'usernode-bot', repo: 'rss-reader' };
const BOT = { id: 77, username: 'homeroom_bot' };

// ── The loop it must never start ─────────────────────────────────────────

test('its own GitHub comment does not re-queue the issue it answered', async () => {
  // The run started reading at 17:00:00 and commented at 17:00:05. GitHub
  // moves the issue's updated_at to the comment's time; the run records the
  // comment's own created_at as seen, so the next refresh finds nothing new.
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const github = {
    getBotUsername: async () => 'usernode-bot',
    async fetchIssueComments() {
      return { comments: [
        { author: 'alice', createdAt: '2026-09-25T16:59:00Z' }, // before the run: already read
        { author: 'usernode-bot', createdAt: '2026-09-25T17:00:05Z' }, // the bot's own
      ] };
    },
  };
  const threadContext = { async loadIssueThread() { return { messages: [] }; } };
  const out = await live.advanceSeen({
    pool, github, threadContext, app: APP, repo: REPO, issueNumber: 12, runId: 900,
    since: '2026-09-25T17:00:00Z', postedAt: ['2026-09-25T17:00:05Z'],
  });
  assert.deepEqual(out, { advanced: true, seen: '2026-09-25T17:00:05.000Z' });
  const update = updates.find((u) => /UPDATE homeroom_bot_runs/.test(u.sql));
  assert.deepEqual(update.params, [900, '2026-09-25T17:00:05.000Z']);
  assert.match(update.sql, /GREATEST\(/, 'never moves what it has seen backwards');

  // And with that recorded, the queue's own rule calls the issue unchanged.
  const verdict = bot.classifyIssue({
    issue: { number: 12, state: 'open', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-25T17:00:05Z' },
    lastRun: { thread_seen_at: out.seen },
  });
  assert.equal(verdict.reason, 'unchanged');
});

test('a person who replied while it worked still gets looked at again', async () => {
  const pool = { async query() { throw new Error('must not record anything'); } };
  const since = '2026-09-25T17:00:00Z';
  const cases = [
    { comments: [{ author: 'alice', createdAt: '2026-09-25T17:00:03Z' }], messages: [] },
    { comments: [], messages: [{ author: 'bob', createdAt: '2026-09-25T17:00:03Z' }] },
  ];
  for (const { comments, messages } of cases) {
    const out = await live.advanceSeen({
      pool,
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments }; } },
      threadContext: { async loadIssueThread() { return { messages }; } },
      app: APP, repo: REPO, issueNumber: 12, runId: 900, since, postedAt: ['2026-09-25T17:00:05Z'],
    });
    assert.deepEqual(out, { advanced: false, reason: 'someone_replied' },
      'their reply must re-queue the issue, even at the price of one more look');
  }
});

test('its own comment is its own even when the login lookup fails (#3509)', async () => {
  // todo #78: with getBotUsername failing, the bot's held note read as a
  // person's reply, the run's thread_seen_at stayed put, and the next
  // refresh triaged the issue again 3.5 minutes later.
  const since = '2026-09-25T17:00:00Z';
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const threadContext = { async loadIssueThread() { return { messages: [] }; } };
  const ownOnly = [{ author: 'usernode-bot', createdAt: '2026-09-25T17:00:05Z' }];
  for (const getBotUsername of [async () => { throw new Error('rate limited'); }, async () => null]) {
    updates.length = 0;
    const out = await live.advanceSeen({
      pool, github: { getBotUsername, async fetchIssueComments() { return { comments: ownOnly }; } },
      threadContext, app: APP, repo: REPO, issueNumber: 78, runId: 560, since, postedAt: ['2026-09-25T17:00:05Z'],
    });
    assert.deepEqual(out, { advanced: true, seen: '2026-09-25T17:00:05.000Z' },
      'the comment this run posted is recognised by its own timestamp');
    assert.ok(updates.some((u) => /UPDATE homeroom_bot_runs/.test(u.sql)));
  }
  // A person's reply beside it still counts, with or without the login.
  const out = await live.advanceSeen({
    pool: { async query() { throw new Error('must not record anything'); } },
    github: {
      getBotUsername: async () => null,
      async fetchIssueComments() { return { comments: [...ownOnly, { author: 'alice', createdAt: '2026-09-25T17:00:07Z' }] }; },
    },
    threadContext, app: APP, repo: REPO, issueNumber: 78, runId: 560, since, postedAt: ['2026-09-25T17:00:05Z'],
  });
  assert.deepEqual(out, { advanced: false, reason: 'someone_replied' });
});

test('#4530: the stamp its own comment puts on the issue is seen too, read fresh before the comments', async () => {
  // homestead #35: the bot commented at 17:00:05, GitHub stamped the issue's
  // updated_at 17:00:06, and the run recorded 17:00:05. Every refresh then
  // read its own note as a change ('changed:github') and said it again.
  const since = '2026-09-25T17:00:00Z';
  const own = { author: 'usernode-bot', createdAt: '2026-09-25T17:00:05Z' };
  const order = [];
  const updates = [];
  const pool = { async query(sql, params) { updates.push({ sql: String(sql), params }); return { rows: [] }; } };
  const github = (updatedAt, read = { comments: [own] }) => ({
    getBotUsername: async () => 'usernode-bot',
    async fetchPublicIssue(owner, repo, n, opts) { order.push(['issue', n, opts]); return { issue: { number: n, updatedAt } }; },
    async fetchIssueComments() { order.push(['comments']); return read; },
  });
  const threadContext = { async loadIssueThread() { return { messages: [] }; } };
  const advance = (gh) => live.advanceSeen({
    pool, github: gh, threadContext, app: APP, repo: REPO, issueNumber: 35, runId: 901, since, postedAt: [own.createdAt],
  });
  const out = await advance(github('2026-09-25T17:00:06Z'));
  assert.deepEqual(out, { advanced: true, seen: '2026-09-25T17:00:06.000Z' });
  assert.deepEqual(order, [['issue', 35, { fresh: true }], ['comments']],
    'the issue first, uncached: a person whose comment moved it is in the list read after it');
  assert.equal(bot.classifyIssue({
    issue: { number: 35, state: 'open', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-25T17:00:06Z' },
    lastRun: { thread_seen_at: out.seen },
  }).reason, 'unchanged', 'so the next refresh finds nothing new');

  // A stamp well after its comment is somebody else's doing (an edit, a
  // label), and is left to be read.
  const edited = await advance(github('2026-09-25T17:09:00Z'));
  assert.deepEqual(edited, { advanced: true, seen: '2026-09-25T17:00:05.000Z' });
  assert.equal(bot.classifyIssue({
    issue: { number: 35, state: 'open', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-25T17:09:00Z' },
    lastRun: { thread_seen_at: edited.seen },
  }).reason, 'changed');
  // So is one when the comments could not all be read: the person whose
  // comment moved it may be the one missing.
  for (const read of [{ comments: [own], truncated: true }, { comments: [], note: 'rate limited' }]) {
    assert.deepEqual(await advance(github('2026-09-25T17:00:06Z', read)), { advanced: true, seen: '2026-09-25T17:00:05.000Z' });
  }
  // And a person's comment still leaves the issue to be read again.
  const replied = await advance(github('2026-09-25T17:00:07Z', {
    comments: [own, { author: 'alice', createdAt: '2026-09-25T17:00:07Z' }],
  }));
  assert.deepEqual(replied, { advanced: false, reason: 'someone_replied' });
  assert.equal(live.OWN_STAMP_SLACK_MS, 60 * 1000);
});

test('its Homeroom posts are system messages, which the queue never counts as activity', () => {
  assert.match(LIVE_SRC, /msgType = 'system'/, 'posts default to system messages');
  const activity = BOT_SRC.slice(BOT_SRC.indexOf('async function threadActivityByIssue'));
  assert.match(activity.slice(0, 600), /msg_type = 'message'/,
    'the thread-activity query reads people\'s messages only');
  // The proposal card is a 'vote' row: also not 'message'.
  assert.match(BOT_SRC, /msgType: 'vote', metadata: \{ vote: \{ sessionId: built\.sessionId, prNumber: built\.prNumber \} \}/);
});

// ── Where it is live ─────────────────────────────────────────────────────

test('it is live on every app with the mode on, and never on a staging copy', (t) => {
  const prior = process.env.USERNODE_ENV;
  t.after(() => { if (prior === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prior; });
  delete process.env.USERNODE_ENV;
  const on = { mode: 'shadow' };
  assert.equal(live.isLiveFor(on, APP), true, 'no list needed');
  assert.equal(live.isLiveFor({ ...on, mode: 'off' }, APP), false, 'off means off');
  assert.equal(live.isLiveFor(null, APP), false);
  assert.equal(live.isLiveFor(on, null), false);
  process.env.USERNODE_ENV = 'staging';
  assert.equal(live.isLiveFor(on, APP), false,
    'a staging copy starts from production\'s settings and must never post on real issues');
});

test('it is live on every app but a paused one, the platform\'s own included', (t) => {
  const prior = process.env.USERNODE_ENV;
  t.after(() => { if (prior === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prior; });
  delete process.env.USERNODE_ENV;
  const settings = { mode: 'shadow', pausedApps: ['quiet', 'quiet'] };
  assert.equal(live.isLiveFor(settings, APP), true);
  assert.equal(live.isLiveFor(settings, { slug: 'anything-else' }), true);
  assert.equal(live.isLiveFor(settings, { slug: 'quiet' }), false, 'paused stays paused');
  assert.equal(live.isLiveFor(settings, { slug: 'usernode-2d5619' }), true, 'Homeroom\'s own project too');
  assert.equal(live.isLiveFor({ ...settings, mode: 'off' }, APP), false, 'off means off');
  assert.deepEqual(live.liveScope(settings), { all: true, slugs: [], except: ['quiet'] });
  // What the retired lists said no longer narrows it.
  assert.deepEqual(live.liveScope({ mode: 'shadow', liveApps: ['a'], firstVersionApps: ['b'], platformSlugs: ['usernode-2d5619'] }),
    { all: true, slugs: [], except: [] });
  assert.equal(live.scopeIsEmpty(live.liveScope(settings)), false);
  assert.equal(live.scopeIsEmpty(live.liveScope({ mode: 'off' })), true);
  // A scope that names its own apps still reads as those apps.
  assert.equal(live.inScope({ all: false, slugs: ['a'], except: [] }, 'a'), true);
  assert.equal(live.inScope({ all: false, slugs: ['a'], except: [] }, 'b'), false);
  assert.equal(live.scopeIsEmpty({ all: false, slugs: [], except: [] }), true);
  // Whether the bot is on is said apart: appsScope reads the same apps while it is off.
  assert.deepEqual(live.appsScope({ ...settings, mode: 'off' }), live.liveScope(settings));
  process.env.USERNODE_ENV = 'staging';
  assert.equal(live.isLiveFor(settings, APP), false, 'never on a staging copy');
  assert.equal(live.scopeIsEmpty(live.liveScope(settings)), true);
  assert.deepEqual(live.appsScope(settings), { all: true, slugs: [], except: ['quiet'] }, 'appsScope reads past staging');
});

test('the live list is gone: an app is left alone by pausing it', () => {
  assert.equal(Object.hasOwn(bot.parseSettings([{ key: 'homeroom_bot_live_apps', value: '["rss-reader-4113da"]' }]), 'liveApps'), false);
  assert.equal(bot.KEY_LIVE_APPS, undefined);
  assert.deepEqual(bot.validateSettingsPatch({ liveApps: ['rss-reader-4113da'] }), { ok: false, error: 'Nothing to update' });
  assert.deepEqual(bot.validateSettingsPatch({ pausedApps: ['rss-reader-4113da', 'rss-reader-4113da'] }).updates,
    [[bot.KEY_PAUSED_APPS, '["rss-reader-4113da"]']], 'deduplicated');
  assert.equal(bot.validateSettingsPatch({ pausedApps: ['Not A Slug'] }).ok, false);
  assert.equal(bot.validateSettingsPatch({ mode: 'live' }).ok, false, 'the global switch still refuses live');
  const schema = read('src/db/schema.sql');
  assert.doesNotMatch(schema, /\('homeroom_bot_live_apps', '\[\]'\)/, 'never seeded again');
  assert.match(schema, /DELETE FROM platform_settings\n WHERE key IN \('homeroom_bot_live_apps',/);
});

// ── Posting ──────────────────────────────────────────────────────────────

function postHarness({ claimed = true, githubFails = false } = {}) {
  const calls = { queries: [], comments: [], messages: [] };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO homeroom_bot_posts/.test(sql)) return { rows: claimed ? [{ id: 55 }] : [] };
      return { rows: [] };
    },
  };
  const github = {
    async createIssueComment(owner, repo, n, body) {
      if (githubFails) throw new Error('GitHub is down');
      calls.comments.push({ owner, repo, n, body });
      return { id: 1234, created_at: '2026-09-25T17:00:05Z' };
    },
  };
  const ws = {
    async sendSystemMessage(pool_, appId, content, msgType, metadata, thread) {
      calls.messages.push({ appId, content, msgType, metadata, thread });
      return { id: 777 };
    },
  };
  return { pool, github, ws, calls };
}

test('a post goes to both surfaces, scoped to the issue, and is recorded', async () => {
  const h = postHarness();
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900, text: 'Which feed?' });
  assert.deepEqual(out, { postId: 55, githubCreatedAt: '2026-09-25T17:00:05Z', github: true, thread: true });
  assert.deepEqual(h.calls.comments, [{ owner: 'usernode-bot', repo: 'rss-reader', n: 12, body: 'Which feed?' }]);
  assert.deepEqual(h.calls.messages[0].thread, { type: 'issue', ref: 12 });
  assert.equal(h.calls.messages[0].msgType, 'system');
  // A run's post first looks for one of its own a restart cut short.
  assert.match(h.calls.queries[0].sql, /WHERE run_id = \$1 AND kind = \$2 AND pending IS TRUE/);
  const insert = h.calls.queries[1];
  assert.match(insert.sql, /ON CONFLICT \(app_id, issue_number\) WHERE kind = 'looking' DO NOTHING/,
    'then its row is written, before anything is sent: for "looking" the insert is the claim');
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, TRUE\)/, 'pending until it has gone out');
  assert.match(h.calls.queries.at(-1).sql, /pending = NULL/, 'and said once it has');
  assert.ok(h.calls.queries.some((q) => /UPDATE homeroom_bot_posts SET github_comment_id/.test(q.sql) && q.params[1] === 1234 && q.params[2] === 777));
});

test('a post a restart cut short is finished, its comment found on the issue rather than made twice', async () => {
  const h = postHarness();
  const at = '2026-10-14T10:00:00Z';
  h.pool.query = async (sql, params) => {
    h.calls.queries.push({ sql: String(sql), params });
    if (/pending IS TRUE/.test(sql)) return { rows: [{ id: 41, github_comment_id: null, thread_message_id: null, created_at: at }] };
    return { rows: [] };
  };
  h.github.fetchIssueComments = async () => ({ comments: [{ id: 990, body: 'Which feed?', createdAt: '2026-10-14T10:00:01Z' }] });
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900, text: 'Which feed?' });
  assert.equal(out.postId, 41, 'its row is taken up');
  assert.deepEqual(h.calls.comments, [], 'the comment it made before the restart is not made again');
  assert.ok(!h.calls.queries.some((q) => /INSERT INTO homeroom_bot_posts/.test(q.sql)));
  assert.equal(h.calls.messages.length, 1, 'what had not gone out goes now');
  const end = h.calls.queries.at(-1);
  assert.match(end.sql, /pending = NULL/);
  assert.deepEqual(end.params.slice(0, 3), [41, 990, 777]);
  // One whose comment had not gone out yet is commented now.
  const h2 = postHarness();
  h2.pool.query = async (sql) => (/pending IS TRUE/.test(sql) ? { rows: [{ id: 42, github_comment_id: null, thread_message_id: null, created_at: at }] } : { rows: [] });
  h2.github.fetchIssueComments = async () => ({ comments: [] });
  await live.post({ ...h2, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900, text: 'Which feed?' });
  assert.equal(h2.calls.comments.length, 1);
});

test('"looking" is posted once per issue: a second claim sends nothing', async () => {
  const h = postHarness({ claimed: false });
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'looking', text: live.lookingText() });
  assert.equal(out, null);
  assert.deepEqual(h.calls.comments, []);
  assert.deepEqual(h.calls.messages, []);
  assert.match(read('src/db/schema.sql'),
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_homeroom_bot_posts_looking\s+ON homeroom_bot_posts\(app_id, issue_number\) WHERE kind = 'looking';/);
});

test('a GitHub failure still posts in Homeroom, and never throws', async () => {
  const h = postHarness({ githubFails: true });
  const out = await live.post({ ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x' });
  assert.equal(out.github, false);
  assert.equal(out.thread, true);
  assert.equal(out.githubCreatedAt, null, 'nothing to mark as seen');
});

// ── Naming the person who filed the issue ──────────────────────────────

function notifyStub({ fails = false } = {}) {
  const calls = { created: [], pushed: [] };
  return {
    calls,
    async createMentionNotifications(_pool, args) {
      if (fails) throw new Error('notifications down');
      calls.created.push(args);
      return [{ id: 31, user_id: 5 }];
    },
    async hydrateAndPush(_pool, row) { calls.pushed.push(row); },
  };
}

test('a post that names the poster: @handle in the thread only, and one mention for them alone', async () => {
  const h = postHarness();
  const notifications = notifyStub();
  const out = await live.post({
    ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'question', runId: 900,
    text: 'Which feed? @alice said the sports one.', mention: 'evan', senderId: 77, notifications,
  });
  assert.deepEqual(out, { postId: 55, githubCreatedAt: '2026-09-25T17:00:05Z', github: true, thread: true });
  assert.equal(h.calls.messages[0].content, '@evan Which feed? @alice said the sports one.', 'named in the thread');
  assert.equal(h.calls.comments[0].body, 'Which feed? @alice said the sports one.',
    'never on GitHub: a platform username there would notify whoever owns it (#723)');
  assert.deepEqual(notifications.calls.created, [{ appId: 9, chatMessageId: 777, senderId: 77, content: '@evan' }],
    'the mention row is for the poster alone, not for every handle the model wrote');
  assert.deepEqual(notifications.calls.pushed, [{ id: 31, user_id: 5 }], 'and it reaches their bell live');
});

test('no poster, no mention; a failed notification keeps the post', async () => {
  const plain = postHarness();
  const untouched = notifyStub();
  await live.post({ ...plain, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x', notifications: untouched });
  assert.equal(plain.calls.messages[0].content, 'x');
  assert.deepEqual(untouched.calls.created, []);

  const h = postHarness();
  const out = await live.post({
    ...h, app: APP, repo: REPO, issueNumber: 12, kind: 'person', text: 'x',
    mention: 'evan', senderId: 77, notifications: notifyStub({ fails: true }),
  });
  assert.equal(out.thread, true);
  assert.equal(out.github, true);
});

test('issuePoster: the platform\'s issue row, the feedback report, the Source line, then a linked GitHub account; never a bot', async () => {
  const poster = async ({ creators = [], linked = [], body = '', user = null, botLogin = 'usernode-bot' }) => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push({ sql: String(sql), params });
        if (/FROM issues i JOIN users u ON u\.id = i\.created_by/.test(sql)) return { rows: creators };
        if (/LOWER\(github_login\) = LOWER\(\$1\)/.test(sql)) return { rows: linked };
        return { rows: [] };
      },
    };
    const name = await live.issuePoster(pool, { app: APP, repo: REPO, issueNumber: 24, issue: { body, user }, botLogin });
    return { name, queries };
  };

  const first = await poster({ creators: [{ username: 'maya' }], body: '**Source:** Homeroom admin (evan)\n\nx' });
  assert.equal(first.name, 'maya', 'the platform\'s own record wins over the body');
  assert.match(first.queries[0].sql, /0 AS source_rank[\s\S]*FROM issues i[\s\S]*1 AS source_rank[\s\S]*FROM feedback_reports fr[\s\S]*ORDER BY source_rank/,
    'the issues route\'s order: issue row, then feedback report');
  assert.deepEqual(first.queries[0].params, [9, 24, 'usernode-bot', 'rss-reader']);

  assert.equal((await poster({ body: '**Source:** Homeroom admin (evan)\n\nUse a darker colour.' })).name, 'evan',
    'rss-reader #24: filed from Homeroom, authored on GitHub by the bot');

  const linked = await poster({ body: 'plain', user: 'octocat', linked: [{ username: 'octo' }] });
  assert.equal(linked.name, 'octo', 'opened on GitHub by someone with a linked Homeroom account');
  assert.deepEqual(linked.queries.at(-1).params, ['octocat']);

  assert.equal((await poster({ body: '**Source:** usernode admin\n\nx', user: 'octocat', linked: [{ username: 'octo' }] })).name, 'octo',
    'the legacy bare admin line names nobody');
  for (const user of ['usernode-bot', 'dependabot[bot]', 'Homeroom-Bot']) {
    const r = await poster({ body: 'plain', user, botLogin: 'homeroom-bot', linked: [{ username: 'x' }] });
    assert.equal(r.name, null, `${user} is not a person who filed anything`);
    assert.ok(!r.queries.some((q) => /github_login/.test(q.sql)));
  }
  assert.equal((await poster({ body: 'plain', user: 'stranger' })).name, null, 'no linked account, nobody to notify here');
});

// One request, one story: a tag means the bot is asking you something. A
// question and a decision for a person tag; progress (an empty request, the
// plan, the change, a build that stopped) is said untagged.
test('the answers that ask something tag whoever filed the issue and took part; progress, the notice and a held note tag nobody', async (t) => {
  // Who exactly, and who is left out, is tests/homeroom-bot-mentions.test.js.
  const h = actHarness();
  const realPost = live.post;
  const realTargets = live.mentionTargets;
  t.after(() => { live.post = realPost; live.mentionTargets = realTargets; });
  const lookups = [];
  live.mentionTargets = async (args) => { lookups.push(args); return ['evan', 'maya']; };
  live.post = async (args) => { h.posts.push({ kind: args.kind, mentions: args.mentions, senderId: args.senderId }); return {}; };

  await act(h, { verdict: 'question', question: 'Which colour?' });
  await act(h, { verdict: 'person', reason: 'Taste.' });
  await act(h, { verdict: 'empty', reason: 'Nothing.' });
  assert.deepEqual(h.posts.map((p) => [p.kind, p.mentions, p.senderId]),
    [['question', ['evan', 'maya'], 77], ['person', ['evan', 'maya'], 77], ['empty', [], 77]]);
  assert.equal(lookups.length, 2, 'one lookup per run that tags, read fresh each time');
  assert.equal(lookups[0].issueNumber, 12);
  assert.equal(lookups[0].bot.id, 77, 'so the bot can leave itself out');

  h.posts.length = 0;
  lookups.length = 0;
  await act(h, { verdict: 'question', question: 'x' }, { capSuppressed: 'question_tripwire' });
  assert.deepEqual(h.posts.map((p) => [p.kind, p.mentions]), [['held_question_tripwire', []]]);
  assert.equal(lookups.length, 0, 'a held note looks nobody up');

  for (const kind of ['proposal', 'build_failed', 'spec', 'plan', 'blocked', 'empty', 'followup_answer', 'followup_revise',
    'followup_person', 'followup_failed']) {
    assert.ok(!live.tagsPoster(kind), `${kind} is progress: said untagged`);
  }
  for (const kind of ['question', 'person', 'followup_ask']) assert.ok(live.tagsPoster(kind), `${kind} asks them something`);
  assert.ok(!live.tagsPoster('looking'));
  assert.ok(!live.tagsPoster('held_proposals_per_app'));
});

test('what it says: the question, notes that never close, a linked proposal', () => {
  const q = live.questionText({ question: 'Which feed should it refresh?', questionDefault: 'All of them' });
  assert.match(q, /Which feed should it refresh\?/);
  // B6 (E5): nothing applies a default to an unanswered question, so nothing says one would.
  assert.ok(!/If nobody answers/.test(q));
  // B6: and two questions are asked at once, numbered.
  const two = live.questionText({
    question: 'What time?',
    plan: { bullets: [], questions: [{ question: 'What time?', answers: ['9 AM', '8 AM'] }, { question: 'How?', answers: ['In the app', 'Phone alert'] }] },
  });
  assert.match(two, /^Homeroom bot has two questions before it can build this:\n\n1\. What time\?\n2\. How\?\n\n/);
  assert.match(q, /Reply here \(or on the GitHub issue\) and it will look again\./);
  assert.match(live.personText({ reason: 'It changes who can see feeds.' }), /a person needs to decide this one: It changes who can see feeds\./);
  // #4239: about Homeroom itself, the note says so, and who can move it.
  const platform = live.personText({ reason: 'The header is drawn by Homeroom.', platform: true, project: 'RSS Reader' });
  assert.match(platform, /^Homeroom bot thinks this is about Homeroom itself, not RSS Reader: The header is drawn by Homeroom\.\n\nWhoever asked for it, or RSS Reader's creator or admins, can have Homeroom bot move it to Homeroom's own board\.$/);
  assert.doesNotMatch(platform, /\u2014/);
  const empty = live.emptyText({ reason: 'The body is a placeholder.' });
  assert.match(empty, /couldn't find anything to build/);
  assert.ok(!/close/i.test(empty), 'it never closes, or offers to close, an issue');
  const link = live.proposalLink('app.onhomeroom.com', APP.slug, 5001);
  assert.equal(link, 'https://app.onhomeroom.com/#app/rss-reader-4113da/dev/proposals/5001');
  assert.equal(live.proposalText({ link, prNumber: 42 }), `Homeroom bot built this. It's up for a vote: ${link}`, 'no pull request number');
  assert.ok(live.questionText({ question: 'x'.repeat(5000) }).length < 2000, 'model text is clipped');
});

// ── Proposing through the one real handler ───────────────────────────────

test('promoteAsBot dispatches into the router as the bot and returns what the route answered', async () => {
  const seen = [];
  const router = express.Router();
  router.use('/api/sessions/:id', (req, res, next) => { seen.push(['guard', req.params.id]); next(); });
  router.post('/api/sessions/:id/promote', (req, res) => {
    seen.push(['promote', req.params.id, req.user.id]);
    if (req.params.id === '9') return res.status(409).json({ error: 'session_state_changed' });
    return res.json({ ok: true, prNumber: 42 });
  });
  const ok = await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5001, router });
  assert.deepEqual(ok, { status: 200, body: { ok: true, prNumber: 42 } });
  assert.deepEqual(seen.slice(0, 2), [['guard', '5001'], ['promote', '5001', 77]], 'guards run first, as the bot');
  assert.deepEqual(await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 9, router }),
    { status: 409, body: { error: 'session_state_changed' } });
  const empty = express.Router();
  assert.equal((await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 1, router: empty })).status, 404);
});

// ── Proposing on an app it is not part of (rss-reader #24) ─────────────

// The real guards the votes router runs before Propose, over one session
// row. rss-reader is collab-private and the bot is neither a collaborator
// nor a member: its #24 build (session 5119) was refused "Session not found"
// by the collaborator guard. A public-collab app would have refused it
// join_required at the membership gate instead.
function guardedRouter({ app, sessionUserId }) {
  const appAccess = require('../src/services/app-access');
  const communities = require('../src/services/communities');
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id/.test(text)) {
        return { rows: [{ ...app, is_member: false }] };
      }
      if (/^SELECT user_id FROM chat_sessions WHERE id = \$1$/.test(text)) {
        owners.push(params[0]);
        return { rows: [{ user_id: sessionUserId }] };
      }
      if (/FROM app_collaborators/.test(text)) return { rows: [] };
      if (/FROM user_app_blocks/.test(text)) return { rows: [] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  const reached = [];
  const owners = [];
  const router = express.Router();
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));
  router.post('/api/sessions/:id/promote', communities.requireSessionMembership(pool), (req, res) => {
    reached.push(req.user.id);
    res.json({ ok: true, prNumber: 7 });
  });
  return { router, reached, owners };
}
const PRIVATE_COLLAB = { id: 9, slug: 'rss-reader-4113da', name: 'RSS reader', community_id: 48, collab_visibility: 'private', view_visibility: 'public' };
const PUBLIC_COLLAB = { ...PRIVATE_COLLAB, collab_visibility: 'public' };

test('promoteAsBot hands the route the bot\'s own proposal ceiling, only when it has one (#3576)', async () => {
  const { BOT_PROMOTED_CEILING, effectiveSessionCaps } = require('../src/services/session-caps');
  const users = [];
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { users.push(req.user); res.json({ ok: true }); });
  await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5001, router, ceiling: 20 });
  await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5001, router });
  assert.equal(users[0][BOT_PROMOTED_CEILING], 20);
  assert.equal(effectiveSessionCaps({}, users[0]).promotedSessions, 20);
  assert.ok(!(BOT_PROMOTED_CEILING in users[1]), 'no ceiling given, the per-user cap stands');
  assert.equal(effectiveSessionCaps({}, users[1]).promotedSessions, 5);
});

test('the bot proposes its own build on an app it is not a collaborator or member of', async () => {
  for (const app of [PRIVATE_COLLAB, PUBLIC_COLLAB]) {
    const { router, reached } = guardedRouter({ app, sessionUserId: BOT.id });
    const out = await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5119, router });
    assert.deepEqual(out, { status: 200, body: { ok: true, prNumber: 7 } }, `${app.collab_visibility} collab`);
    assert.deepEqual(reached, [77]);
  }
});

test('the exception is the bot\'s own session only, and only its in-process promote', async () => {
  // Somebody else's change: the walls stand, even for the bot.
  const other = guardedRouter({ app: PRIVATE_COLLAB, sessionUserId: 5 });
  // (#5506: the project is anyone's to see, so the refusal says the rule.)
  const REFUSED = { status: 403, body: { error: 'You can view this project, but only its collaborators can take part in it.', code: 'collab_required' } };
  assert.deepEqual(await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5120, router: other.router }), REFUSED);
  assert.deepEqual(other.reached, []);

  // The same user without the marker, as an HTTP request would be.
  const appAccess = require('../src/services/app-access');
  const plain = { id: BOT.id, username: BOT.username, is_synthetic: true, HOMEROOM_BOT_PROPOSAL: true };
  assert.equal(appAccess.isBotOwnProposal(plain, BOT.id), false, 'a string key is not the marker');
  const marked = { id: BOT.id, [appAccess.HOMEROOM_BOT_PROPOSAL]: true };
  assert.equal(appAccess.isBotOwnProposal(marked, BOT.id), true);
  assert.equal(appAccess.isBotOwnProposal(marked, 5), false, 'not someone else\'s session');
  assert.equal(appAccess.isBotOwnProposal(marked, null), false);
  assert.equal(appAccess.isBotOwnProposal(null, BOT.id), false);

  // Through the real guards without the marker: refused as before.
  const { router } = guardedRouter({ app: PRIVATE_COLLAB, sessionUserId: BOT.id });
  const refused = await new Promise((resolve) => {
    const url = '/api/sessions/5119/promote';
    const req = { method: 'POST', url, originalUrl: url, baseUrl: '', path: url, headers: {}, query: {}, params: {}, body: {},
      user: plain, get() {}, header() {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      set() { return this; }, setHeader() {}, getHeader() {} };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
  assert.deepEqual(refused, REFUSED);

  // An unmarked request never pays for the exception: the guards' own
  // queries are unchanged (a golden transcript pins them) and the owner is
  // never looked up.
  const quiet = guardedRouter({ app: PUBLIC_COLLAB, sessionUserId: 5 });
  await new Promise((resolve) => {
    const url = '/api/sessions/5120/promote';
    const req = { method: 'POST', url, originalUrl: url, baseUrl: '', path: url, headers: {}, query: {}, params: {}, body: {},
      user: { id: 5, username: 'maya' }, get() {}, header() {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); return this; },
      set() { return this; }, setHeader() {}, getHeader() {} };
    quiet.router.handle(req, res, () => resolve(null));
  });
  assert.deepEqual(quiet.owners, [], 'no owner lookup for an ordinary request');
  assert.match(read('src/services/app-access.js'),
    /`SELECT a\.id, a\.collab_visibility, a\.view_visibility, a\.moderation_suspended_at\n\s+FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id\n\s+WHERE cs\.id = \$1`/);

  // Never an admin: the marker is the whole exception.
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /id: bot\.id, username: bot\.username, is_admin: false, is_synthetic: true,\n\s*\[require\('\.\/app-access'\)\.HOMEROOM_BOT_PROPOSAL\]: true,/);
  assert.doesNotMatch(src, /isAdmin: true/);
});

test('the route it dispatches into is the real Propose handler, and the bot must own the session', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /router\.post\('\/api\/sessions\/:id\/promote', drainGuard,/);
  assert.match(votes, /WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.status IN \('active', 'paused'\)/,
    'only the session\'s owner can propose it, so the bot proposes only what it built');
  assert.match(LIVE_SRC, /require\('\.\.\/routes\/votes'\)\.voteRoutes\(config\)/);
  assert.ok(!/UPDATE chat_sessions\s+SET status = 'promoted'/.test(LIVE_SRC), 'it never promotes by hand');
});

test('an issue with an open bot proposal is left alone', () => {
  const q = LIVE_SRC.slice(LIVE_SRC.indexOf('async function openBotProposal'));
  assert.match(q.slice(0, 600), /user_id = \$2 AND \$3 = ANY\(linked_issues\)\s+AND status IN \('promoted', 'merging'\)/);
});

// ── The build ────────────────────────────────────────────────────────────

// The spec turn comes first (mode 'scout', see tests/homeroom-bot-spec.test.js);
// `loop` and `exec` are the BUILD turn's.
// A build closes its own session through the proposal machine
// (session-lifecycle.closeOwnSession), which no fake pool runs: each
// harness stands in for it and records every close.
const sessionLifecycle = require('../src/services/session-lifecycle');

function buildHarness({ result = { pushOk: true, ahead: 1, sha: 'a'.repeat(40) }, promote = { status: 200, body: { ok: true, prNumber: 42 } }, hang = false, spec = '' } = {}) {
  const calls = { queries: [], ensured: [], loop: null, exec: null, stopped: [], stoppedJournals: [], promoted: [], modes: [], closed: [] };
  sessionLifecycle.closeOwnSession = async ({ sessionId, reason }) => { calls.closed.push({ sessionId, reason }); return true; };
  // The turn on the session, as execInWorker records it: the build's, once
  // it is dispatched.
  let activeTurn = null;
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      if (/SELECT active_turn FROM chat_sessions/.test(sql)) return { rows: [{ active_turn: activeTurn }] };
      return { rows: [] };
    },
  };
  let release;
  const hung = new Promise((r) => { release = r; });
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => {
    calls.promoted.push({ id: req.params.id, user: req.user.id });
    res.status(promote.status).json(promote.body);
  });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, opts }); return 'usernode-worker-5001'; },
      async execInWorker(id, opts) {
        calls.modes.push(opts.mode);
        if (opts.mode === 'scout') return { lastResultText: spec };
        calls.exec = { id, opts };
        activeTurn = { turnId: 'turn-build', journal: '/home/node/.claude/turn-build.log', mode: 'build' };
        if (hang && opts.onProgress) {
          for (const line of ['Reading public/app.js', 'Running: npm test', 'Running: npm test',
            'Waiting on a command for 540s: npm start', 'Waiting on a command for 600s: npm start']) opts.onProgress(line);
        }
        return result;
      },
      stopTurn(id) { calls.stopped.push(id); release(); return Promise.resolve(); },
      async stopTurnByJournal(id, journal) { calls.stopped.push(id); calls.stoppedJournals.push(journal); release(); return 'stopped'; },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({ openrouterApiKey: 'k' });
        if (args.mode === 'scout') return { result: r, error: null, estimatedCostUsd: null };
        calls.loop = args;
        if (hang) await hung;
        return { result: r, error: null, estimatedCostUsd: 0.05 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    votesRouter: router,
  };
  return { pool, deps, calls };
}

const BUILD_ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12,
  issue: { title: 'Refresh feeds every hour' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh to the feed poller.', turnBudgetMs: 20 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
};

test('a ready request is built in a session of its own and proposed', async () => {
  const h = buildHarness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.deepEqual(out, {
    ok: true, sessionId: 5001, prNumber: 42, branchName: 'homeroom_bot/s5001', sha: 'a'.repeat(40), commits: 1,
    costUsd: 0.05,
    specNote: 'no spec (the spec turn returned nothing); the build worked from the plan',
    // What each stage cost, on its model (services/stage-costs.js): a spec
    // turn whose cost is unknown has no line.
    stageCosts: { build: { usd: 0.05, model: 'z-ai/glm-5.3-flash' } },
  }, 'this harness writes no spec, and the result says so');

  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.match(insert.sql, /ELSE ARRAY\[\$3::int\] END, TRUE/, 'the issue is linked, so the PR says Closes #12');
  assert.equal(insert.params[2], 12, 'a proposing build links its issue');
  assert.match(insert.sql, /'active', FALSE/, 'a normal dev session, never a headless one');
  assert.equal(insert.params[1], BOT.id, 'owned by the bot');

  assert.equal(h.calls.ensured[0].opts.temporary, true, 'scratch storage, like its triage workers');
  assert.equal(h.calls.ensured[0].opts.branchName, 'homeroom_bot/s5001');
  assert.equal(h.calls.loop.mode, 'build');
  assert.equal(h.calls.loop.telemetryComponent, 'homeroom_bot_build');
  assert.equal(h.calls.loop.resumeThreadId, null);
  assert.equal(h.calls.exec.opts.mode, 'build');
  assert.match(h.calls.exec.opts.prompt, /Add an hourly refresh to the feed poller\./);
  assert.match(h.calls.exec.opts.prompt, /Do not commit or push yourself/);
  assert.deepEqual(h.calls.promoted, [{ id: '5001', user: BOT.id }], 'proposed once, as the bot');
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'a spec first; with none written, the build goes ahead from the plan');
  assert.deepEqual(h.calls.closed, []);
});

test('a build that changed nothing is not proposed, and its session is archived', async () => {
  const h = buildHarness({ result: { pushOk: true, ahead: 0 } });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.equal(out.ok, false);
  assert.match(out.error, /produced no change/);
  assert.deepEqual(h.calls.promoted, []);
  assert.deepEqual(h.calls.closed, [{ sessionId: 5001, reason: 'bot-failed' }]);
});

test('a refused promotion is reported with the route\'s own words, and the built work is kept', async () => {
  const h = buildHarness({ promote: { status: 404, body: { error: 'Session not found' } } });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  assert.equal(out.ok, false);
  assert.match(out.error, /built but could not be proposed: Session not found/);
  assert.deepEqual(h.calls.closed, [],
    'left paused, so a person can open the session and propose it');
});

test('a build is held to the same wall clock as a triage turn', async (t) => {
  const h = buildHarness({ hang: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS });
  for (let i = 0; i < 200 && !h.calls.stopped.length; i += 1) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(20 * 60 * 1000);
  }
  const out = await running;
  assert.deepEqual(h.calls.stopped, [5001]);
  // Only the build's own turn, by its journal: one started after it is
  // never the one ended.
  assert.deepEqual(h.calls.stoppedJournals, ['/home/node/.claude/turn-build.log']);
  assert.match(out.error, /ran past its time limit/);
  // #3385: what it was waiting on, the last three distinct progress lines.
  assert.equal(out.error, 'the build ran past its time limit; last activity: Running: npm test | '
    + 'Waiting on a command for 540s: npm start | Waiting on a command for 600s: npm start');
  assert.deepEqual(h.calls.promoted, [], 'a stopped build is never proposed');
});

// WP1 (#2): a build is checked again once its plan is written and just
// before it is proposed (skipCheck, homeroom-bot.js whyNotBuild). Both of
// Plant Pal's duplicates were proposed after the first was up for a vote and
// after the request's issue had closed.
const SPEC = '# Spec\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';

test('WP1: a build its request no longer needs once its plan is written stops there: no plan posted, no build turn', async () => {
  const h = buildHarness({ spec: SPEC });
  const specs = [];
  const asked = [];
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...BUILD_ARGS,
    onSpec: async (s) => { specs.push(s); },
    skipCheck: async () => { asked.push('asked'); return 'skipped: the request already has a proposal (6190)'; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, 'skipped: the request already has a proposal (6190)');
  assert.equal(out.error, out.skipped, 'recorded as the skip it is');
  assert.equal(out.specMd, SPEC, 'the plan it wrote is kept on the result');
  assert.deepEqual(asked, ['asked']);
  assert.deepEqual(specs, [], 'its plan is not posted');
  assert.deepEqual(h.calls.modes, ['scout'], 'and no build turn runs');
  assert.deepEqual(h.calls.promoted, []);
  assert.deepEqual(h.calls.closed.map((c) => c.sessionId), [5001], 'its session is put away');
});

test('WP1: a build whose request was answered or closed while it ran is not proposed', async () => {
  const h = buildHarness({ spec: SPEC });
  const answers = [null, 'skipped: the request was closed before it was proposed'];
  const specs = [];
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...BUILD_ARGS,
    onSpec: async (s) => { specs.push(s.specMd); },
    skipCheck: async () => answers.shift(),
  });
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'it was built');
  assert.deepEqual(specs, [SPEC], 'its plan posted as ever');
  assert.deepEqual(h.calls.promoted, [], 'and never proposed');
  assert.equal(out.skipped, 'skipped: the request was closed before it was proposed');
  assert.equal(out.costUsd, 0.05, 'what it cost is still recorded');
  assert.deepEqual(h.calls.closed.map((c) => c.sessionId), [5001]);
  // The check is the step right before the proposal is prepared and put up.
  const fn = LIVE_SRC.slice(LIVE_SRC.indexOf('async function buildAndPropose('));
  const check = fn.indexOf("const skipped = await skipNow('built');");
  const turn = fn.indexOf("let { routed, stopped } = await runBuildTurn({ prompt, budgetMs: turnBudgetMs, commitMsg, progress, key: 'build' });");
  assert.ok(turn > -1 && check > turn, 'after the build turn');
  const prepared = fn.indexOf('await prepareProposal({');
  const promoted = fn.indexOf("const promoted = await steps.once('promoted', async () => {");
  assert.ok(prepared > -1 && promoted > -1, 'the proposal is prepared, then put up, each a step of its own');
  assert.ok(check < prepared && check < promoted, 'before it is proposed');
});

// One run, one build. Linking a build's session to its run is its claim on
// the run (homeroom-bot.js buildLive's onSession): a run another build linked
// first refuses it, and this one stops there. A second build of homestead
// #31 paid for a plan and a build before it stopped on the first's proposal.
test('a build whose run refuses its session stops before its branch, its worker and its plan', async () => {
  const h = buildHarness({ spec: SPEC });
  const specs = [];
  const branches = [];
  const ensureSessionBranch = h.deps.sessionLifecycle.ensureSessionBranch;
  h.deps.sessionLifecycle.ensureSessionBranch = async (a) => { branches.push(a.sessionId); return ensureSessionBranch(a); };
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...BUILD_ARGS,
    onSpec: async (s) => { specs.push(s); },
    onSession: async () => bot.LOST_CLAIM,
    skipCheck: async () => { throw new Error('never asked'); },
  });
  assert.equal(out.lostClaim, true);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, bot.LOST_CLAIM);
  assert.equal(out.sessionId, 5001);
  assert.equal(out.costUsd, null, 'nothing spent');
  assert.deepEqual(branches, [], 'no branch');
  assert.deepEqual(h.calls.ensured, [], 'no worker');
  assert.deepEqual(h.calls.modes, [], 'no plan turn and no build turn');
  assert.deepEqual(specs, [], 'no plan posted');
  assert.deepEqual(h.calls.promoted, []);
  assert.deepEqual(h.calls.closed.map((c) => c.sessionId), [5001], 'its session is put away');
  // Only a reason is a refusal: a link that resolves nothing (the bench's)
  // or the query's result builds as before.
  for (const resolved of [undefined, null, { rows: [{ id: 900 }] }]) {
    const go = buildHarness();
    const built = await live.buildAndPropose({ pool: go.pool, deps: go.deps, ...BUILD_ARGS, onSession: async () => resolved });
    assert.equal(built.ok, true);
    assert.equal(built.lostClaim, undefined);
  }
});

test('WP1: a check that cannot answer never stops a build, and a build with no check is built as before', async () => {
  const h = buildHarness();
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...BUILD_ARGS, skipCheck: async () => { throw new Error('connection lost'); },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(h.calls.promoted, [{ id: '5001', user: BOT.id }]);
  const plain = buildHarness();
  assert.equal((await live.buildAndPropose({ pool: plain.pool, deps: plain.deps, ...BUILD_ARGS })).ok, true);
});

// ── What each verdict does ───────────────────────────────────────────────

function actHarness() {
  const posts = [];
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  const deps = {
    github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
    ws: {},
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    limits: { spend: [], async recordSpend(_p, id, cents) { this.spend.push(cents); } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    domain: 'app.onhomeroom.com',
  };
  return { pool, deps, posts, queries };
}

async function act(h, parsed, { capSuppressed = null, quietHold = false } = {}) {
  return bot.actOnVerdict({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed, capSuppressed, runId: 900, seed: 'seed', seedReadAt: '2026-09-25T17:00:00Z', postedAt: [],
    turnBudgetMs: 1000, model: 'm', quietHold, deps: h.deps,
  });
}

// A ready verdict's build, as the lane starts it (buildOne): the same arguments.
async function build(h, parsed, extra = {}) {
  return bot.buildLive({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed, runId: 900, seed: 'seed', seedReadAt: '2026-09-25T17:00:00Z', postedAt: [],
    turnBudgetMs: 1000, model: 'm', deps: h.deps, ...extra,
  });
}

test('each verdict says its own thing; a verdict held by a cap says only that it is held', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind, text: args.text, msgType: args.msgType, metadata: args.metadata }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };

  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }), 'question');
  assert.equal(await act(h, { verdict: 'person', reason: 'Billing.' }), 'person');
  assert.equal(await act(h, { verdict: 'empty', reason: 'Placeholder.' }), 'empty');
  assert.deepEqual(h.posts.map((p) => p.kind), ['question', 'person', 'empty']);

  h.posts.length = 0;
  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }, { capSuppressed: 'question_tripwire' }), 'held');
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, { capSuppressed: 'proposals_per_app' }), 'held');
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_question_tripwire', 'held_proposals_per_app'],
    'the caps hold the question and the build, and say so in one line (#3152)');
  assert.ok(!/Which feed/.test(h.posts[0].text), 'the held question itself is not posted');
  // One request, one story: in whole sentences, the project by its name.
  assert.equal(h.posts[1].text, 'Homeroom bot will build this when one of its 5 changes on RSS reader is voted in or closed.');

  live.buildAndPropose = async (args) => {
    await args.onSession({ id: 5001 });
    return { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0.25 };
  };
  // Ready: queued for a build slot of its own, not built inside the turn
  // that read it, so the project's next request is read meanwhile.
  h.posts.length = 0;
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }), 'build_queued');
  assert.deepEqual(h.posts, [], 'nothing built and nothing said yet');
  assert.ok(h.queries.some((q) => /SET live_build_waiting_at = COALESCE\(live_build_waiting_at, NOW\(\)\)/.test(q.sql) && q.params[0] === 900));
  // The lane builds it.
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.ok(h.queries.some((q) => /SET build_session_id = \$2, live_build_waiting_at = NULL\s+WHERE id = \$1/.test(q.sql) && q.params[0] === 900 && q.params[1] === 5001),
    'the live run is linked to its build session as soon as it exists, so a restart can find it (#3471), and no longer waits');
  const card = h.posts.find((p) => p.kind === 'proposal');
  assert.equal(card.msgType, 'vote', 'the thread gets the live vote card');
  assert.deepEqual(card.metadata, { vote: { sessionId: 5001, prNumber: 42 } });
  assert.match(card.text, /https:\/\/app\.onhomeroom\.com\/#app\/rss-reader-4113da\/dev\/changes\/42/);
  assert.ok(h.queries.some((q) => /SET proposal_session_id = \$2/.test(q.sql) && q.params[1] === 5001));
  assert.deepEqual(h.deps.limits.spend, [25], 'the build is paid for from the bot\'s weekly allowance');

  live.buildAndPropose = async () => ({ ok: false, sessionId: 5002, error: 'the build produced no change to propose', costUsd: 0 });
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'build_failed');
  assert.equal(h.posts.at(-1).text, 'Homeroom bot couldn\'t finish building this: it ended up with no changes to show. '
    + 'Reply here (or on the GitHub issue) and it will try again.');
});


test('WP1: a build that was not needed is recorded as a skip, and nothing is said: never "couldn\'t finish"', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind, dm: args.dm }); return { githubCreatedAt: '2026-10-03T16:48:00Z' }; };
  let check = null;
  live.buildAndPropose = async (args) => {
    check = args.skipCheck;
    return {
      ok: false, sessionId: 5004, skipped: 'skipped: the request already has a proposal (6190)',
      error: 'skipped: the request already has a proposal (6190)', costUsd: 0.12,
    };
  };
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'skipped');
  assert.equal(typeof check, 'function', 'the build is handed its check');
  assert.deepEqual(h.posts, [], 'nothing on the request, nothing in the DM');
  const recorded = h.queries.filter((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql)).at(-1).params;
  assert.deepEqual(recorded.slice(0, 3), [900, false, 'skipped: the request already has a proposal (6190)'],
    'which every reader shows as stopped');
  assert.ok(!h.queries.some((q) => /SET proposal_session_id = \$2/.test(q.sql)));
});

test('a second build of one run stops at its link and leaves the run to the first: nothing recorded, said or spent', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  const realSeen = live.advanceSeen;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; live.advanceSeen = realSeen; });
  const seen = [];
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return {}; };
  live.advanceSeen = async () => { seen.push('seen'); return { advanced: true }; };
  let refused;
  live.buildAndPropose = async (args) => {
    refused = await args.onSession({ id: 5009 });
    // What buildAndPropose resolves once its link is refused (above).
    if (refused) return { ok: false, sessionId: 5009, branchName: null, error: refused, skipped: refused, lostClaim: true, costUsd: null };
    return { ok: true, sessionId: 5009, prNumber: 43, costUsd: 0.25 };
  };
  // The run answers no row: another build linked its session first.
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'lost_claim');
  assert.equal(refused, bot.LOST_CLAIM);
  const claim = h.queries.find((q) => /SET build_session_id = \$2, live_build_waiting_at = NULL\s+WHERE id = \$1/.test(q.sql));
  assert.match(claim.sql, /AND \(build_session_id IS NULL OR build_session_id = \$2\)\s+AND build_ok IS NULL AND proposal_session_id IS NULL\s+RETURNING id/,
    'once: only a run no other build has linked (its own link again, after a restart), still waiting for its outcome');
  assert.deepEqual(claim.params, [900, 5009]);
  assert.ok(!h.queries.some((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql)), 'the run keeps the first build\'s record');
  assert.ok(!h.queries.some((q) => /^UPDATE homeroom_bot_runs SET (live_build_waiting_at|build_spec_md|proposal_session_id) = /.test(q.sql)));
  assert.deepEqual(h.posts, [], 'nothing said');
  assert.deepEqual(seen, [], 'what the run has seen is the first build\'s to move');
  assert.deepEqual(h.deps.limits.spend, [], 'nothing spent');

  // The run's own build: its link is taken, and it builds as ever.
  const query = h.pool.query;
  h.pool.query = async (sql, params) => {
    if (/SET build_session_id = \$2/.test(String(sql))) return { rows: [{ id: 900 }] };
    return query(sql, params);
  };
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.equal(refused, null);
});

test('WP1: what the run has seen moves past its own plan comment as soon as it is posted', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  const realSeen = live.advanceSeen;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; live.advanceSeen = realSeen; });
  const order = [];
  live.post = async (args) => { order.push(`post:${args.kind}`); return { githubCreatedAt: args.kind === 'spec' ? '2026-10-03T16:46:40Z' : '2026-10-03T17:10:00Z' }; };
  live.advanceSeen = async (args) => { order.push(`seen:${args.postedAt.join(',')}:${args.since}`); return { advanced: true }; };
  live.buildAndPropose = async (args) => {
    await args.onSpec({ sessionId: 5001, version: null, specMd: '# Spec' });
    order.push('built');
    return { ok: true, sessionId: 5001, prNumber: 42, costUsd: 0 };
  };
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.deepEqual(order, [
    'post:spec',
    'seen:2026-10-03T16:46:40Z:2026-09-25T17:00:00Z',
    'built',
    'post:proposal',
    'seen:2026-10-03T16:46:40Z,2026-10-03T17:10:00Z:2026-09-25T17:00:00Z',
  ], 'right after the plan comment, from when the build read the request, and again once it is announced');
});

test('WP1: a merge stops the rest of the bot\'s work on its request, in a work item of its own apart from the merged DM', () => {
  // The merge-followups machine tells the bot's change machine when the
  // merge is recorded (Merged, bounded to what had started before it) and
  // once the change is live (Live); that machine asks for each as its own
  // durable work: bot.stopRequestWork, then bot.tellLive and
  // bot.commentLive. Each is retried on its own, and none is a reason the
  // merge fails: the merge is already recorded when they run.
  const machine = read('src/workflow/merge-followups/machine.ts');
  const writes = machine.slice(machine.indexOf('function settleWrites('), machine.indexOf('\n}\n', machine.indexOf('function settleWrites(')));
  assert.match(writes, /toBotChange\(d\.sessionId, 'Merged', \{ before: d\.mergedAt \}\)/, 'bounded to what had started before the merge');
  const toLive = machine.slice(machine.indexOf('function toLive('), machine.indexOf('function lineInput('));
  assert.match(toLive, /toBotChange\(d\.sessionId, 'Live'\)/, 'the merged DM waits for live');
  const bc = read('src/workflow/bot-change/machine.ts');
  assert.match(bc, /const \{ d, work \} = stopWork\(live \? live\.data : created\(e, f\), e\.payload\.before, f\);/);
  assert.match(bc, /const work: WorkRequest\[\] = \[\{ kind: WORK\.merged, key: 'merged', input: \{ sessionId: d\.sessionId, before: at \} \}\];/);
  assert.match(bc, /\{ kind: WORK\.liveDm, key: 'live-dm', input: \{ sessionId: stop\.d\.sessionId \} \},\n\s+\{ kind: WORK\.livePost, key: 'live-post', input: \{ sessionId: stop\.d\.sessionId \} \},/,
    'and is not the same item');
  const services = read('src/workflow/bot-change/services.ts');
  const merged = services.slice(services.indexOf('[WORK.merged]: {'), services.indexOf('[WORK.liveDm]: {'));
  assert.match(merged, /legacy\('services\/homeroom-bot'\)\.noteRequestMerged\(pool, \{ id: Number\(input\.sessionId\) \},\s*\{ before: input\.before \?\? null, strict: true \}\)/,
    'a failure is reported, so the item is retried');
});

test('a held issue is told once, not again on every retry that is held again (#3152)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  t.after(() => { live.post = realPost; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  let newest = null;
  h.pool.query = async (sql) => {
    if (/FROM homeroom_bot_posts/.test(String(sql))) return { rows: newest ? [{ kind: newest }] : [] };
    return { rows: [] };
  };
  const held = { capSuppressed: 'proposals_per_app' };
  await act(h, { verdict: 'ready', buildNote: 'x' }, held);
  newest = 'held_proposals_per_app';
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, held), 'held');
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_proposals_per_app'], 'the second hold says nothing new');
  // Held for a different reason than the newest post: that is news.
  await act(h, { verdict: 'question', question: 'q' }, { capSuppressed: 'question_tripwire' });
  assert.deepEqual(h.posts.map((p) => p.kind), ['held_proposals_per_app', 'held_question_tripwire']);
});

test('a backlog pass holds silently, and still speaks when it has something to say (#3509)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  t.after(() => { live.post = realPost; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  const quiet = { quietHold: true };
  assert.equal(await act(h, { verdict: 'ready', buildNote: 'x' }, { ...quiet, capSuppressed: 'proposals_per_app' }), 'held');
  assert.equal(await act(h, { verdict: 'question', question: 'q' }, { ...quiet, capSuppressed: 'question_tripwire' }), 'held');
  assert.deepEqual(h.posts, [], 'held is still the verdict, and the cap_freed refresh brings it back; no note');
  assert.equal(await act(h, { verdict: 'question', question: 'Which feed?' }, quiet), 'question');
  assert.deepEqual(h.posts.map((p) => p.kind), ['question'], 'a verdict that is not held is said as ever');
  // Anything else held still says so once.
  await act(h, { verdict: 'ready', buildNote: 'x' }, { capSuppressed: 'proposals_per_app' });
  assert.deepEqual(h.posts.map((p) => p.kind), ['question', 'held_proposals_per_app']);
});

test('a "Triage this app again" item is triaged without the "looking" post, and held quietly', () => {
  assert.equal(bot.APP_AGAIN_REASON, 'app_again');
  assert.match(BOT_SRC, /appId: app\.id, issueNumber: p\.n, reason: APP_AGAIN_REASON, priority: 0,/, 'retriageApp owes each its look with that reason');
  assert.match(BOT_SRC, /const looked = item\.reason === RESTART_REASON \|\| item\.reason === APP_AGAIN_REASON \|\| item\.reason === BACKLOG_REASON\n\s+\|\| item\.reason === RETRY_FAILED_REASON \|\| item\.reason === READ_AGAIN_REASON \? null : await live\.post\(/);
  // 16 Oct 2026: an older request's read is as quiet (BACKLOG_REASON).
  assert.match(BOT_SRC, /quietHold: item\.reason === APP_AGAIN_REASON \|\| item\.reason === BACKLOG_REASON,/);
  // The refresh keeps a priority-0 debt's reason (bot-request's merge of a
  // debt into the one owed already), so a comment before its look runs does
  // not turn it back into a "looking" one.
  const machine = read('src/workflow/bot-request/machine.ts');
  assert.match(machine, /const keep = old\.priority === 0 \|\| KEPT_WHILE_QUIET_REASONS\.has\(old\.reason\);\n[\s\S]{0,120}reason: keep \? old\.reason : p\.reason,/);
});

test('a live build\'s outcome is recorded on its run, in the shadow build\'s columns (#3509)', async (t) => {
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  const recorded = () => {
    const u = h.queries.filter((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql)).at(-1);
    return u && u.params;
  };

  live.buildAndPropose = async () => ({
    ok: true, sessionId: 5001, prNumber: 42, branchName: 'homeroom_bot/s5001', sha: 'b'.repeat(40), commits: 2,
    costUsd: 0.3, specNote: 'no spec (the spec ran past its time limit); the build worked from the plan',
  });
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'proposed');
  assert.deepEqual(recorded(), [900, true, 'no spec (the spec ran past its time limit); the build worked from the plan',
    'homeroom_bot/s5001', 'b'.repeat(40), 2, 0.3, 5001, null, 'm', null],
    'a proposal built without a spec says why; #3654: and the model it was built on; and no turn that changed nothing');

  live.buildAndPropose = async () => ({ ok: false, sessionId: 5002, error: 'the build ran past its time limit', costUsd: 0.2 });
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'build_failed');
  assert.deepEqual(recorded().slice(0, 3), [900, false, 'the build ran past its time limit']);

  live.buildAndPropose = async () => ({
    ok: false, sessionId: 5003, blocked: 'the app has no image generation', error: 'the spec found it impossible', costUsd: 0.1,
  });
  assert.equal(await build(h, { verdict: 'ready', buildNote: 'x' }), 'blocked');
  assert.deepEqual(recorded().slice(0, 3), [900, false, 'blocked: the app has no image generation'],
    'blocked and failed are told apart');

  // Recorded before anything is said: a post that throws cannot lose it.
  const src = BOT_SRC.slice(BOT_SRC.indexOf('async function announceBuilt'));
  assert.match(src.slice(0, 200), /\{\n  await recordLiveBuild\(pool, runId, built, built\.model \|\| null\);/);
  // Never the shadow lane's markers: build_at and build_queued_at are its
  // history, which the dashboard counts apart (buildLaneSummary).
  const rec = BOT_SRC.slice(BOT_SRC.indexOf('async function recordLiveBuild'));
  assert.doesNotMatch(rec.slice(0, rec.indexOf('\n}\n')), /build_at|build_queued_at/);
});

test('a ready verdict is held before it is built when the bot is at its ceiling across apps (#3576)', async (t) => {
  let perApp = 0;
  let total = 0;
  const pool = {
    async query(sql) {
      const s = String(sql);
      // The app's slots (slotHolders): one row each.
      if (s === bot.SLOT_HOLDERS_SQL) return { rows: Array.from({ length: perApp }, (_, i) => ({ kind: 'proposal', issue_number: i + 1 })) };
      if (/FROM chat_sessions\s+WHERE user_id = \$1/.test(s)) {
        assert.match(s, /status IN \('promoted', 'merging'\) AND is_headless = FALSE/, 'counted as the Propose route counts');
        return { rows: [{ cnt: total }] };
      }
      return { rows: [{ cnt: 0 }] };
    },
  };
  // Every app is live, so the automatic ceiling is a fixed one; an admin's
  // number replaces it.
  assert.equal(bot.PROPOSALS_PER_APP_CAP, 5);
  assert.equal(bot.botProposalCeiling({}), 100, 'the automatic ceiling');
  assert.equal(bot.botProposalCeiling(null), 100);
  total = 99;
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'ready', {}), null);
  total = 100;
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'ready', {}), 'proposals_total');
  const settings = { proposalCeiling: 20 };
  assert.equal(bot.botProposalCeiling(settings), 20, 'an admin\'s number');
  total = 19;
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'ready', settings), null);
  total = 20;
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'ready', settings), 'proposals_total');
  perApp = 5;
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'ready', settings), 'proposals_per_app', 'the app\'s own cap is named first');
  assert.equal(await bot.simulateCaps(pool, BOT, 9, 'question', settings), null, 'only a build is held by them');

  // Held, it says so and builds nothing; the line names the ceiling.
  const h = actHarness();
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { h.posts.push({ kind: args.kind, text: args.text }); return { githubCreatedAt: '2026-09-25T17:00:05Z' }; };
  const built = [];
  live.buildAndPropose = async (args) => { built.push(args.proposalCeiling); return { ok: true, sessionId: 5001, prNumber: 42 }; };
  assert.equal(await bot.actOnVerdict({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: 'proposals_total', runId: 900, seed: 's',
    seedReadAt: '2026-09-25T17:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm', proposalCeiling: 20, deps: h.deps,
  }), 'held');
  assert.deepEqual(built, []);
  assert.equal(h.posts[0].kind, 'held_proposals_total');
  assert.match(h.posts[0].text, /one of its 20 changes across Homeroom is voted in or closed/);
  // Not held, the build carries the ceiling to its promote.
  assert.equal(await bot.buildLive({
    pool: h.pool, config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12, issue: { title: 'x' },
    parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900, seed: 's',
    seedReadAt: '2026-09-25T17:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm', proposalCeiling: 20, deps: h.deps,
  }), 'proposed');
  assert.deepEqual(built, [20]);
  assert.match(BOT_SRC, /quietHold: item\.reason === APP_AGAIN_REASON \|\| item\.reason === BACKLOG_REASON,\n\s+proposalCeiling: botProposalCeiling\(settings\),/);
  // (Homeroom bot parity, P4 and P6: with the request it decides for, which a batch may raise the hold for and a flaky check's fix is exempt from.)
  assert.match(BOT_SRC, /simulateCaps\(pool, bot, app\.id, v\.verdict, settings, \{ issueNumber \}\)/);
  assert.match(LIVE_SRC, /router: deps\.votesRouter \|\| null, ceiling: proposalCeiling,/);
});

test('the held lines name the limit and never promise more than the refresh does', () => {
  assert.match(live.heldText({ cap: 'proposals_per_app', verdict: 'ready', limit: 2 }), /when one of its 2 changes on this project is voted in or closed/);
  const q = live.heldText({ cap: 'question_tripwire', verdict: 'question', limit: 10 });
  assert.match(q, /has a question about this request, but it has already posted 10 questions and notes on this project today/);
  assert.match(live.heldText({ cap: 'question_tripwire', verdict: 'empty', limit: 10 }), /has a note on this request/);
  for (const text of [q, live.heldText({ cap: 'proposals_per_app', limit: 2 })]) assert.ok(!/\u2014/.test(text));
});
test('runTriage acts only through the live module, and only when the app is live', () => {
  // Shadow mode stays structurally silent: none of the posting or proposing
  // calls appear in homeroom-bot.js at all, and every call into the live
  // module sits behind liveMode.
  for (const forbidden of ['createIssueComment', 'sendSystemMessage', '/promote']) {
    assert.ok(!BOT_SRC.includes(forbidden), `homeroom-bot.js never reaches ${forbidden} itself`);
  }
  // Two build calls: buildLive's (a live ready verdict, in its own slot),
  // and the plan a complicated change drafts in that same slot before it
  // asks its requester (#4488, planBeforeBuilding: the spec only, never
  // proposed). The shadow build's third is gone with its lane (design D2):
  // where nothing is live, a ready verdict is recorded and nothing is built.
  assert.equal((BOT_SRC.match(/buildAndPropose\(/g) || []).length, 2, 'buildLive, and a complicated change\'s plan');
  const planning = BOT_SRC.slice(BOT_SRC.indexOf('async function planBeforeBuilding('), BOT_SRC.indexOf('function isGoWord('));
  assert.match(planning, /platformRepo: isPlatformRepo\(app, config\), planOnly: true,/, 'the plan\'s call drafts the spec and nothing else');
  for (const gone of ['async function shadowBuild(', 'queueShadowBuild(', "acted = 'shadow_queued'"]) {
    assert.ok(!BOT_SRC.includes(gone), `no ${gone}`);
  }
  assert.match(BOT_SRC, /const liveMode = live\.isLiveFor\(settings, app\);/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+const open = await look\.once\('gate:proposal', \(\) => live\.openBotProposal/);
  assert.match(BOT_SRC, /if \(liveMode\) \{\n\s+try \{\n(?:\s+\/\/.*\n)+\s+const done = await look\.once\('act', async \(\) => \(\{ acted: await actOnVerdict\(\{/);
});

test('the dashboard says what a live build came to, and never calls it a shadow build (#3509)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /\{run\.mode === 'live' \? <LiveBuild run=\{run\} \/> : <ShadowBuild run=\{run\} \/>\}/);
  const fn = tsx.slice(tsx.indexOf('function LiveBuild('), tsx.indexOf('/** A question\'s "user_facing: why" as words. */'));
  assert.match(fn, /data-live-build=\{why\.startsWith\('blocked: '\) \? 'blocked' : 'failed'\}/);
  assert.match(fn, /Live build did not become a proposal: \$\{why\}\./);
  // WP1: a build that was not needed (skipped) stopped; it did not fail.
  assert.match(fn, /if \(why\.startsWith\('skipped: '\)\) \{[\s\S]*?data-live-build="skipped"[\s\S]*?Live build stopped, not needed: \$\{why\.slice\('skipped: '\.length\)\}\./);
  assert.ok(fn.indexOf('data-live-build="skipped"') < fn.indexOf("'blocked' : 'failed'"), 'told apart before a failure is');
  assert.match(fn, /data-live-build="built"/);
  assert.doesNotMatch(fn, /Shadow|href=/, 'the proposal link below the note is the one link');
});

test('#3426: a request with a screenshot tells each bot turn to look at it, and what to do if it cannot', () => {
  const seed = 'Issue #47: Can not comment\n\n**Screenshot:**\n![Screenshot](https://app.onhomeroom.com/issue-images/1ed1d30f045b9362b7d7f78e41d984f9)';
  const note = live.screenshotNote(seed).join('\n');
  assert.match(note, /Download each one/);
  assert.match(note, /view_image, or the Read\ntool/);
  assert.match(note, /do not try to decode the file another way/);
  assert.deepEqual(live.screenshotNote('Issue #3: no pictures here'), [], 'nothing said without one');
  assert.deepEqual(live.screenshotNote(null), []);
  const args = { seed, buildNote: 'x' };
  assert.ok(live.buildPrompt(args).includes(note), 'the build reads it');
  assert.ok(live.specPrompt(args).includes(note), 'and the spec');
  assert.match(BOT_SRC, /seed, live\.screenshotNote\(seed\)\.join\('\\n'\)\.trim\(\), triagePrompt\(\)/, 'and the triage');
  assert.ok(!live.buildPrompt({ seed: 'Issue #3', buildNote: 'x' }).includes('Download each one'));
});
