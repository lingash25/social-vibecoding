'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first.
// Ask Homeroom bot opens Main." 29 Oct 2026 (Evan): Needs you (it holds
// other people's threads too), In progress (being worked on), Waiting (on
// someone else; "Up next" until 30 Oct), each the bot's own word where it
// works on the request; and a thread opens on this page. 30 Oct 2026: one
// line a row, grouped by project, with chips to narrow them (./lists.tsx;
// the three projects that need you most and a More for the rest); on a
// phone the list and Main Chat are one drawer; Homeroom bot's status answer
// reads the same lists.
//
// What this pins:
//   1. Needs you's order: the Needs you feed, the bot's plans waiting for
//      Build it and the requests it handed back (Decide, Try again), then
//      private threads; each thread is listed once.
//   2. In progress and Waiting: what goes in each, in what order, and the
//      words each row says, the bot's stages and claims among them.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      no rows; the lists load in effects, Main is docked only after mount.
//   4. The routes: #homeroom-bot is the page, #homeroom-bot/main and
//      #homeroom-bot/thread/<id> are Main and a thread in its column (1 Nov
//      2026: never the Messages screen); #ai, the old address, lands there,
//      and so does a Messages address of the bot's chat (./door.ts).
//   5. A request, a change or a decision opens beside the list in Main's
//      place (the side panel drawn as the page's column), or on its page
//      with a way back here. 1 Nov 2026: Main Chat is the list's first row;
//      the column is docked from 768px and holds Main or one thread, alone,
//      and the row of whichever it is is lit.
//   6. While the page is up, its lists are read again when a thread they
//      list moves (./live.ts): which socket events count, one read a burst,
//      none while the browser tab is hidden.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const MODEL = 'frontend/src/features/ai/model.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const words = (p) => message(p.id, p.values);

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const thread = (threadId, number, what, extra = {}) => ({
  threadId, number, kind: 'work', title: `T${threadId}`, app, change: null,
  href: `#app/garden/dev/issues/${number}`, group: 'waiting', what, at: null, ...extra,
});

test('Needs you: the feed, then the bot\'s plans waiting for Build it, then private threads, each once', () => {
  const { needsYou, needHref, owedCount } = loadTsx(MODEL);
  const needs = [
    { kind: 'proposal', id: 11, number: 403, title: 'Dark mode', app },
    { kind: 'ballot', id: 12, number: 408, title: 'A or B', app, ballot: { number: 401, title: 'Night theme' } },
    { kind: 'question', id: 13, number: 390, title: 'Which camera?', app },
    { kind: 'governance', id: 14, number: null, title: 'Rename it', app },
  ];
  const work = {
    private: [
      { rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null },
      { rootId: 92, title: 'Sort by date', kind: 'draft_request', app, at: null },
    ],
    needs: [
      thread(7, 410, 'plan', { group: 'needs', title: 'A reminder email' }),
      thread(8, 390, 'plan', { group: 'needs', title: 'Photos' }),
    ],
    next: [],
    waiting: [thread(5, 388, 'not_picked_up', { title: 'Print view' })],
    live: [],
  };
  const rows = needsYou(needs, work);
  assert.deepEqual(rows.map((r) => r.key), [
    'need:proposal:11', 'need:ballot:12', 'need:question:13', 'need:governance:14',
    'plan:7',
    'private:91', 'private:92',
  ], '#390 is the question owed above, so its plan is not listed again; nothing waiting on others is here');
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Vote', 'Pick one', 'Answer', 'Vote', 'Build it', null, null]);
  assert.equal(owedCount(rows), 5, 'the heading counts what asks for you, not your private threads');
  assert.equal(rows[1].title, 'Night theme', 'a ballot is named for the request its changes compete for');
  assert.equal(words(rows[1].sub), 'Garden club · #401');
  assert.equal(rows[1].href, '#app/garden/dev/issues/401', 'and is decided on its page');
  assert.equal(rows[0].href, '#app/garden/dev/changes/403');
  assert.equal(rows[2].href, '#app/garden/dev/issues/390');
  assert.equal(rows[3].href, '#app/garden/dev/governance/14');
  assert.equal(words(rows[3].sub), 'Garden club');
  assert.deepEqual([rows[4].title, words(rows[4].sub), rows[4].href], ['A reminder email', 'Garden club · #410', '#app/garden/dev/issues/410'],
    'a plan opens on its request, where its Build it is');
  // Private threads: a lock on the tile, and where they stand.
  assert.deepEqual([rows[5].who, words(rows[5].sub)], ['solo', 'Only you · Not in a community yet']);
  assert.deepEqual([rows[6].who, words(rows[6].sub)], ['me', 'Only you · Garden club · Not posted yet']);
  assert.equal(rows[5].rootId, 91, 'a private thread opens in Main');
  assert.equal(needHref({ kind: 'proposal', id: 1, number: 2, href: '#somewhere' }), '#somewhere', 'a card that says where it goes');
  assert.equal(needsYou(null, null).length, 0);
  assert.equal(needsYou(null, { private: [], next: [], waiting: [], live: [] }).length, 0, 'an older server, with no plans');
});

test('each section groups its rows by project, and a project shows its first few before its own Show more', () => {
  const { needsYou, byProject, GROUP_FIRST } = loadTsx(MODEL);
  const games = { slug: 'games', name: 'Game corner', icon_url: null, icon_emoji: '🎮' };
  const needs = [
    { kind: 'proposal', id: 1, number: 500, title: 'Change 0', app },
    { kind: 'proposal', id: 2, number: 600, title: 'Score board', app: games },
    { kind: 'proposal', id: 3, number: 501, title: 'Change 1', app },
  ];
  const work = {
    private: [{ rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null }],
    needs: [thread(7, 410, 'plan', { group: 'needs' })],
    next: [], waiting: [], live: [thread(8, 411, 'live', { group: 'live', app: games })],
  };
  const rows = needsYou(needs, work);
  const groups = byProject(rows);
  assert.deepEqual(groups.map((g) => [g.app && g.app.slug, g.items.map((r) => r.key)]), [
    ['garden', ['need:proposal:1', 'need:proposal:3', 'plan:7']],
    ['games', ['need:proposal:2']],
    [null, ['private:91']],
  ], 'under each project once, in the order the projects first come; a private idea in no project apart');
  assert.deepEqual({ ...GROUP_FIRST }, { needs: 5, next: 3, waiting: 3, live: 3 }, 'Needs you shows the most: it is what you came for');
  const lists = read('frontend/src/features/ai/lists.tsx');
  // 1 Nov 2026: the row whose chat is in the column is never folded away:
  // past the first rows, it joins them.
  assert.match(lists, /const shown = litAt >= first \? first \+ 1 : first;\s+const hidden = Math\.max\(0, items\.length - shown\);/);
  assert.match(lists, /\{\(hidden \? items\.slice\(0, shown\) : items\)\.map\(/);
  assert.match(lists, /aria-hidden=\{open \? undefined : true\}\s+inert=\{!open\}/, 'the folded rest is out of reach until it opens');
  assert.match(lists, /\{g\.app \? <SmallTile app=\{g\.app\} size="head" \/> : <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" \/>\}/);
  assert.equal(message('messages:ai.short.private'), 'Only you', 'the heading over private ideas in no project');
  // One project picked: its chip names it, so its name is not said again.
  assert.match(lists, /const heads = picked\.length !== 1;/);
});

test('the filter: the three projects that need you most as chips, then any picked past them, and More for every project', () => {
  const { needsYou, rankProjects, railProjects, RAIL_PROJECTS } = loadTsx(MODEL);
  const at = (slug, name) => ({ slug, name, icon_url: null, icon_emoji: null });
  const [garden, games, run, birds, zines] = [
    at('garden', 'Garden club'), at('games', 'Game corner'), at('run', 'Run club'), at('birds', 'Bird count'), at('zines', 'Zines'),
  ];
  const rows = needsYou([
    { kind: 'proposal', id: 1, number: 500, title: 'One', app: games },
    { kind: 'proposal', id: 2, number: 501, title: 'Two', app: garden },
    { kind: 'proposal', id: 3, number: 502, title: 'Three', app: garden },
  ], { private: [], next: [], waiting: [], live: [] });
  const ranked = rankProjects(rows,
    [thread(1, 10, 'building', { group: 'next', app: run }), thread(2, 11, 'building', { group: 'next', app: games })],
    [thread(3, 12, 'vote', { app: zines })],
    [thread(4, 13, 'live', { group: 'live', app: birds }), thread(5, 14, 'live', { group: 'live', app: birds })]);
  assert.deepEqual(ranked.map((p) => [p.app.slug, p.needs, p.progress, p.waiting, p.live]), [
    ['garden', 2, 0, 0, 0],
    ['games', 1, 1, 0, 0],
    ['run', 0, 1, 0, 0],
    ['zines', 0, 0, 1, 0],
    ['birds', 0, 0, 0, 2],
  ], 'what needs you most first, then what is under way, then waiting, then only live; once each');
  assert.equal(RAIL_PROJECTS, 3);
  assert.deepEqual(railProjects(ranked, []).map((a) => a.slug), ['garden', 'games', 'run'], 'three chips');
  assert.deepEqual(railProjects(ranked, ['birds', 'games']).map((a) => a.slug), ['birds', 'garden', 'games', 'run'],
    'a project picked from More joins the rail beside All, so the filter is on screen even on a phone; the first three keep their places');
  const tied = rankProjects([], [], [], [thread(6, 15, 'live', { group: 'live', app: zines }), thread(7, 16, 'live', { group: 'live', app: birds })]);
  assert.deepEqual(tied.map((p) => p.app.slug), ['birds', 'zines'], 'a tie goes by name');

  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<FadeRail role="group" aria-label=\{t\('messages:ai\.filter\.label'\)\} data-ai-project-chips="" className="min-w-0 flex-1">/);
  assert.match(lists, /\{rail\.map\(\(app\) => \(/, 'the rail draws the chips railProjects gives it');
  // More stands outside the rail, so a narrow rail never scrolls it away,
  // and it is a menu button, not a toggle.
  assert.match(lists, /<\/FadeRail>\s*\{past > 0 \? \(\s*<Chip/);
  assert.match(lists, /aria-pressed=\{undefined\}\s+aria-haspopup="dialog"\s+aria-expanded=\{!!more\}/);
  assert.match(lists, /\{t\('messages:ai\.filter\.more', \{ count: past \}\)\}/);
  assert.equal(message('messages:ai.filter.more', { count: 28 }), '28 more');

  const picker = read('frontend/src/features/ai/project-picker.tsx');
  assert.match(picker, /createPortal\(sheet \? <PickerSheet \{\.\.\.props\} \/> : <PickerMenu anchor=\{anchor\} \{\.\.\.props\} \/>, document\.body\)/,
    'a sheet on a phone, a menu under the chip on a wide window; nothing in the prerender');
  assert.match(picker, /type="checkbox"[\s\S]*?checked=\{picked\.includes\(p\.app\.slug\)\}[\s\S]*?onChange=\{\(\) => onToggle\(p\.app\.slug\)\}/, 'a pick applies at once');
  assert.match(picker, /e\.target\.closest\('\[data-ai-project-more\]'\)/, 'a press on More toggles it rather than closing and reopening');
  assert.equal(message('messages:ai.filter.note.needs', { count: 1 }), '1 needs you');
  assert.equal(message('messages:ai.filter.note.needs', { count: 3 }), '3 need you');
  assert.equal(message('messages:ai.filter.note.live', { count: 2 }), '2 live this week');
  assert.equal(message('messages:ai.filter.group.busy'), 'In progress or waiting');
});

test('In progress and Waiting each leave out a thread the feed lists, by its request or its change', () => {
  const { inProgress, upNext } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6025, title: 'Its change', app }];
  const work = {
    private: [],
    next: [thread(1, 6036, 'fixing', { group: 'next', change: { id: 9, number: 6025 } }), thread(2, 6040, 'building', { group: 'next', by: 'bot' })],
    waiting: [thread(3, 6025, 'vote'), thread(4, 6038, 'held', { heldBy: 'approvals' })],
    live: [],
  };
  assert.deepEqual(inProgress(needs, work).map((t) => t.threadId), [2], 'its change #6025 is owed: once, in Needs you');
  assert.deepEqual(upNext(needs, work).map((t) => t.threadId), [4]);
  assert.deepEqual(upNext(null, work).map((t) => t.threadId), [3, 4]);
});

// 30 Oct 2026: the tab said "#6032" for the change Homeroom bot called
// request #6038 in Main. A change for a request goes by the request's number,
// opens on the change's own page, and still leaves out the request's thread.
test('a vote on a change for a request names the request\'s number, and opens on the change', () => {
  const { needsYou, upNext, owedKeys } = loadTsx(MODEL);
  const needs = [{ kind: 'proposal', id: 1, number: 6032, title: 'Spell out the approval rules', app, request: { number: 6038, title: 'Rule changes' } }];
  const [row] = needsYou(needs, null);
  assert.equal(words(row.sub), 'Garden club · #6038');
  assert.equal(row.href, '#app/garden/dev/changes/6032');
  assert.deepEqual([...owedKeys(needs)].sort(), ['garden#6032', 'garden#6038']);
  const work = { private: [], next: [], waiting: [thread(3, 6038, 'vote', { change: { id: 9, number: 6032 } })], live: [] };
  assert.deepEqual(upNext(needs, work), [], 'once, in Needs you');
  const [plain] = needsYou([{ kind: 'proposal', id: 2, number: 6050, title: 'No request', app }], null);
  assert.equal(words(plain.sub), 'Garden club · #6050', 'a change for no request keeps its own number');
});

test('each In progress and Waiting row says what it waits on, in the bot\'s words where it is the bot\'s', () => {
  const { nextWords, heroWords } = loadTsx(MODEL);
  const row = (what, extra = {}) => ({ threadId: 1, number: 7, app, what, ...extra });
  assert.deepEqual([
    row('going_live'), row('merging'), row('fixing'), row('revising'), row('reading'),
    row('building', { by: 'bot' }), row('building', { by: 'you' }), row('building', { by: 'someone' }),
    row('building', { by: 'someone', claimedBy: 'snait' }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Going live', 'Garden club · #7 · Merging',
    'Garden club · #7 · Homeroom bot is fixing what its tests found',
    'Garden club · #7 · Homeroom bot is following up on the replies',
    'Garden club · #7 · Homeroom bot is reading it',
    'Garden club · #7 · Homeroom bot is building it', 'Garden club · #7 · You\'re building it',
    'Garden club · #7 · Being built',
    'Garden club · #7 · snait is building it',
  ], 'a claim with no change yet names who has it');
  assert.deepEqual([
    row('vote', { myVote: 'yes' }), row('vote', { myVote: 'no' }), row('vote', { myVote: null }),
    row('checking'),
    row('fix_queued'), row('followup_queued'), row('build_queued'),
    row('held', { heldBy: 'approvals' }), row('held', { heldBy: 'daily' }), row('stalled'),
    row('queued'), row('on_hold'),
    row('not_picked_up'), row('not_picked_up', { quietDays: 10 }), row('not_picked_up', { number: null }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Waiting for votes · you voted Yes', 'Garden club · #7 · Waiting for votes · you voted No',
    'Garden club · #7 · Waiting for votes',
    'Garden club · #7 · Waiting for checks',
    'Garden club · #7 · A test failed · waiting for a free builder to fix it',
    'Garden club · #7 · Waiting for a free builder to follow up on the replies',
    'Garden club · #7 · Ready to build · waiting its turn',
    'Garden club · #7 · Ready to build · waits until a change up for a vote is decided',
    'Garden club · #7 · Ready to build · held by today\'s limit on this project',
    'Garden club · #7 · Ready to build · its build has not started',
    'Garden club · #7 · Waiting for a free builder',
    'Garden club · #7 · On hold until Monday',
    'Garden club · #7 · Nobody is building it yet',
    'Garden club · #7 · Nobody is building it yet · quiet 10 days',
    'Garden club · Nobody is building it yet',
  ], 'a row with no number (a decision) says no "#"');
  // 30 Oct 2026: a decision up for a vote waits for votes, not a builder.
  assert.deepEqual([
    row('decision', { number: null, myVote: null }), row('decision', { number: null, myVote: 'yes' }),
    row('decision', { number: null, myVote: 'no' }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · Waiting for votes', 'Garden club · Waiting for votes · you voted Yes',
    'Garden club · Waiting for votes · you voted No',
  ]);
  assert.equal(message('messages:ai.next.titleCount', { count: 2 }), 'In progress · 2');
  assert.equal(message('messages:ai.up.titleCount', { count: 2 }), 'Waiting · 2');
  assert.equal(words(heroWords(2, 3)), 'Needs you: 2 · In progress: 3');
  assert.equal(words(heroWords(0, 3)), 'In progress: 3');
});

test('a row\'s one word on the right, and on a phone the reason where it is news', () => {
  const { shortWords, whyOf, threadWhy, needsYou, upNext } = loadTsx(MODEL);
  const row = (what, extra = {}) => ({ threadId: 1, number: 7, app, what, ...extra });
  assert.deepEqual([
    row('going_live'), row('building', { by: 'bot' }), row('building', { by: 'you' }), row('building', { by: 'someone', claimedBy: 'snait' }),
    row('building', { by: 'someone' }), row('vote'), row('checking'), row('decision'), row('queued'), row('build_queued'),
    row('held', { heldBy: 'approvals' }), row('held', { heldBy: 'daily' }), row('on_hold'), row('not_picked_up'), row('mystery'),
  ].map((r) => words(shortWords(r))), [
    'Going live', 'Homeroom bot', 'You', 'snait', 'Being built', 'Votes', 'Checks', 'Votes', 'A builder', 'Its turn',
    'A slot', 'Tomorrow', 'Monday', 'Nobody yet', 'Waiting',
  ]);
  // Every id is one whole literal, so the inventory can check it exists.
  assert.ok(!read(MODEL).includes('messages:ai.short.${'));
  // Handed back by the bot: Decide, and Try again, each with its reason.
  const work = {
    private: [], next: [], live: [],
    needs: [thread(7, 410, 'decide', { group: 'needs' }), thread(8, 411, 'build_stopped', { group: 'needs' })],
    waiting: [thread(9, 412, 'held', { heldBy: 'approvals' })],
  };
  const bots = [{ kind: 'proposal', id: 1, number: 600, title: 'Its change', app, author: 'homeroom_bot' }];
  const rows = needsYou(bots, work);
  assert.deepEqual(rows.map((r) => [r.key, r.pill && message(r.pill.id), words(r.sub)]), [
    ['need:proposal:1', 'Vote', 'Garden club · #600 · Your vote helps free a build slot'],
    ['decide:7', 'Decide', 'Garden club · #410 · Homeroom bot says a person needs to decide'],
    ['stopped:8', 'Try again', 'Garden club · #411 · Homeroom bot\'s build stopped'],
  ]);
  assert.deepEqual(rows.map((r) => whyOf(r) && words(whyOf(r))), [
    'Your vote helps free a build slot', 'Homeroom bot needs a person to decide', 'Homeroom bot\'s build stopped',
  ]);
  assert.equal(whyOf(needsYou([{ kind: 'proposal', id: 2, number: 601, title: 'Plain', app }], null)[0]), null, 'a plain vote says no more than its pill');
  const [held] = upNext(bots, work);
  assert.equal(held.yourVotes, 1);
  assert.equal(words(threadWhy(held)), 'A vote you owe can free its slot');
  assert.equal(threadWhy(row('queued')), null);
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<span className="block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400 md:hidden" aria-hidden="true" data-ai-line-why="">\{line\.why\}<\/span>/,
    'the reason is a phone\'s second line; the tooltip says it everywhere');
  assert.match(lists, /const ROW = 'flex w-full min-h-\[44px\] md:min-h-\[36px\]/, 'a phone\'s 44px tap target');
});

test('the server: a vote you have given waits on others (Up next), and the bot\'s stage decides where its requests go', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const at = '2026-10-29T10:00:00.000Z';
  const ME = 5;
  const open = { state: 'open', own: true, request_state: 'open', request_at: at, created_at: at };
  const promoted = { ...open, change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: at };
  assert.deepEqual(aiWork.standing({ ...promoted, check_state: 'passing' }, ME, now),
    { group: 'waiting', what: 'vote', at, myVote: 'yes' });
  // #6060: checks that have not passed hold it, so the row says Checks, not
  // Votes. A vote cannot merge it until they pass.
  assert.deepEqual(aiWork.standing({ ...promoted, check_state: 'skipped' }, ME, now),
    { group: 'waiting', what: 'vote', at, myVote: 'yes' }, 'skipped checks count as passed');
  for (const checkState of ['pending', 'failing', 'error', 'unknown', null]) {
    assert.deepEqual(aiWork.standing({ ...promoted, check_state: checkState }, ME, now),
      { group: 'waiting', what: 'checking', at }, `${checkState || 'NULL'} waits for its checks`);
  }
  const bot = (stage, extra = {}) => aiWork.standing(open, ME, now, null, { stage, since: at, ...extra });
  assert.deepEqual(bot('plan'), { group: 'needs', what: 'plan', at }, 'a plan waiting for Build it is Needs you\'s');
  assert.equal(bot('question'), null, 'the bot\'s question is the feed\'s Answer');
  assert.deepEqual(bot('held', { capSuppressed: 'proposals_per_app' }), { group: 'waiting', what: 'held', at, heldBy: 'approvals' },
    'held back until a change up for a vote is decided, as the bot says in Main');
  assert.equal(bot('held', { capSuppressed: 'daily_notes' }).heldBy, 'daily');
  assert.deepEqual(bot('build_queued'), { group: 'waiting', what: 'build_queued', at });
  assert.deepEqual(bot('queued'), { group: 'waiting', what: 'queued', at }, 'not "Not picked up yet": it is in the bot\'s queue');
  assert.deepEqual(bot('reading'), { group: 'next', what: 'reading', at });
  assert.deepEqual(bot('planning'), { group: 'next', what: 'building', by: 'bot', at });
  assert.deepEqual(bot('fix_queued'), { group: 'waiting', what: 'fix_queued', at });
  assert.deepEqual(bot('fixing'), { group: 'next', what: 'fixing', at });
  assert.deepEqual(aiWork.standing({ ...open, change_status: 'merging', merged_at: at }, ME, now, null, { stage: 'merging' }),
    { group: 'next', what: 'merging', at }, 'where its change says it, the change speaks');
  assert.equal(aiWork.standing({ ...open, state: 'closed' }, ME, now, null, { stage: 'plan' }), null, 'never on a closed thread');
  assert.deepEqual(aiWork.standing(open, ME, now), { group: 'waiting', what: 'not_picked_up', at, quietDays: 0 },
    'nobody building it, and not the bot\'s');
  // 30 Oct 2026: handed back by the bot, it is Needs you's, until somebody takes it up.
  assert.deepEqual(bot('decide'), { group: 'needs', what: 'decide', at }, 'a person needs to decide: not "Nobody is building it yet"');
  assert.deepEqual(bot('build_stopped'), { group: 'needs', what: 'build_stopped', at }, 'its build stopped: Try again');
  assert.deepEqual(aiWork.standing({ ...open, claimed_by: 'snait' }, ME, now, null, { stage: 'decide', since: at }),
    { group: 'next', what: 'building', at, by: 'someone', claimedBy: 'snait' }, 'claimed since: being built, by who has it');
  assert.equal(aiWork.standing({ ...open, change_status: 'active', change_user: ME, last_activity_at: at }, ME, now, null, { stage: 'build_stopped' }).what,
    'building', 'or with a change of theirs');
  assert.deepEqual(aiWork.standing({ ...open, claimed_by: 'aw_me', claimed_mine: true }, ME, now),
    { group: 'next', what: 'building', at, by: 'you' }, 'their own claim');
  assert.equal(aiWork.standing({ ...open, own: false, claimed_by: 'snait' }, ME, now), null, 'one they only wrote in, claimed, asks nothing of them');
  // A decision up for a vote waits for votes; one whose vote is owed is the feed's.
  const decision = { state: 'open', own: true, kind: 'decision', number: null, created_at: at, decision_status: 'open' };
  assert.deepEqual(aiWork.standing({ ...decision, decision_mine: true }, ME, now), { group: 'waiting', what: 'decision', at, myVote: null });
  assert.deepEqual(aiWork.standing({ ...decision, decision_vote: 'yes' }, ME, now), { group: 'waiting', what: 'decision', at, myVote: 'yes' });
  assert.equal(aiWork.standing(decision, ME, now), null, 'a vote she owes is Needs you\'s');
  assert.equal(aiWork.standing({ ...decision, own: false, decision_vote: 'yes' }, ME, now), null, 'one she only voted on');
  assert.equal(aiWork.standing({ ...decision, decision_mine: true, decision_status: 'applied' }, ME, now), null, 'decided');
  // Every stage the bot words a request at (homeroom-bot-progress.js
  // STEP_OF_STAGE) has a list here, but those its change says as well.
  const progress = read('src/services/homeroom-bot-progress.js');
  const block = progress.slice(progress.indexOf('const STEP_OF_STAGE = Object.freeze({'));
  const stages = [...block.slice(0, block.indexOf('});')).matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]);
  assert.ok(stages.length > 15, 'the stages were read');
  for (const stage of stages) {
    if (['setting_up', 'checks', 'checks_failed', 'vote', 'merging'].includes(stage)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(aiWork.BOT_STANDING, stage), `the bot's stage ${stage} has a list`);
  }
});

test('the server arranges Waiting nearest to live first, and matches the bot\'s stages by request', () => {
  const aiWork = require('../src/services/ai-work');
  const now = new Date('2026-10-29T12:00:00Z');
  const row = (id, number, extra = {}) => ({
    id, number, kind: 'work', state: 'open', own: true, slug: 'garden', name: 'Garden club',
    request_title: `R${number}`, request_state: 'open', request_at: `2026-10-2${id}T00:00:00Z`, created_at: '2026-10-20T00:00:00Z', ...extra,
  });
  const bots = new Map([
    ['garden#6014', { stage: 'held', since: '2026-10-29T01:00:00Z', capSuppressed: 'proposals_per_app' }],
    ['garden#6002', { stage: 'plan', since: '2026-10-29T02:00:00Z' }],
  ]);
  const lists = aiWork.arrange([
    row(1, 6038),
    row(2, 6014),
    row(3, 6002),
    row(4, 6025, { change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: '2026-10-29T03:00:00Z', change_id: 1, pr_number: 6025, check_state: 'passing' }),
    // #6060: a change still waiting for its checks sorts with the votes, ahead of held.
    row(5, 6026, { change_status: 'promoted', change_user: 9, voted: true, my_vote: 'yes', promoted_at: '2026-10-29T04:00:00Z', change_id: 2, pr_number: 6026, check_state: 'pending' }),
  ], 5, now, null, bots);
  assert.deepEqual(lists.needs.map((t) => t.number), [6002], 'the plan waiting for Build it');
  assert.deepEqual(lists.waiting.map((t) => `${t.number}:${t.what}`), ['6025:vote', '6026:checking', '6014:held', '6038:not_picked_up']);
  assert.deepEqual(lists.next, []);
});

test('a request the bot handed back is one its records say it left for a person, or whose build stopped', async () => {
  const { handedBack, stageOf } = require('../src/services/homeroom-bot-progress');
  const looked = { mode: 'live', verdict: 'person', request_closed: false, proposal_status: null };
  assert.equal(stageOf(looked), null, 'nothing about it is in progress');
  assert.equal(handedBack(looked), 'decide');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'turn timed out' }), 'build_stopped');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'skipped: answered meanwhile' }), null, 'a skip did not stop');
  assert.equal(handedBack({ ...looked, verdict: 'ready', build_ok: false, build_error: 'blocked: needs a key' }), null, 'nor one that asks for detail');
  assert.equal(handedBack({ ...looked, request_closed: true }), null, 'never on a closed request');
  assert.equal(handedBack({ ...looked, proposal_status: 'promoted' }), null, 'nor with a change of it up');
  assert.equal(handedBack({ ...looked, mode: 'shadow' }), null, 'only its acted-on looks');
  assert.equal(handedBack({ ...looked, verdict: 'empty' }), null);
  // botStages reads it where nothing is in progress.
  const aiWork = require('../src/services/ai-work');
  const stages = await aiWork.botStages(null, { id: 5 }, {
    liveSvc: { isStaging: () => false },
    settings: { mode: 'live' },
    progress: {
      handedBack,
      requestStates: async () => [
        { row: { ...looked, slug: 'garden', issue_number: 6010, run_at: '2026-10-29T10:00:00Z' }, state: null },
        { row: { ...looked, slug: 'garden', issue_number: 6011, verdict: 'failed' }, state: null },
      ],
    },
  });
  assert.deepEqual([...stages], [['garden#6010', { stage: 'decide', since: '2026-10-29T10:00:00Z', capSuppressed: null }]]);
});

test('Homeroom bot answers "where do things stand?" from the lists this page draws', () => {
  const aiWork = require('../src/services/ai-work');
  const games = { slug: 'games', name: 'Game corner' };
  const needs = [
    { kind: 'proposal', id: 1, number: 6032, title: 'Spell out the rules', app, author: 'homeroom_bot', request: { number: 6038 } },
    { kind: 'ballot', id: 2, number: 6040, title: 'A or B', app, ballot: { number: 6039, title: 'Night theme' } },
  ];
  const work = {
    private: [{ rootId: 9, title: 'A calendar idea', app: null }],
    needs: [thread(1, 6010, 'decide', { group: 'needs', title: 'Points table' }), thread(2, 6038, 'plan', { group: 'needs' })],
    next: [thread(3, 6020, 'building', { group: 'next', by: 'someone', claimedBy: 'snait', title: 'Sound toggle', app: games })],
    waiting: [thread(4, 6014, 'held', { heldBy: 'approvals', title: 'Export' }), thread(5, 6039, 'vote', { title: 'Owed already' })],
    live: [thread(6, 6001, 'live', { group: 'live', title: 'Pause button' })],
  };
  const lists = aiWork.listsOf(needs, work, { botUsername: 'homeroom_bot' });
  assert.deepEqual(lists.needsYou.map((r) => [r.number || null, r.title, r.says]), [
    [6038, 'Spell out the rules', 'waits for their vote'],
    [6039, 'Night theme', 'waits for them to pick one of its changes'],
    [6010, 'Points table', 'Homeroom bot handed it back: a person needs to decide'],
    [null, 'A calendar idea', 'their private thread with Homeroom bot, not posted yet'],
  ], 'the feed\'s cards by their requests\' numbers, then what the bot handed back; #6038\'s plan is the vote above');
  assert.deepEqual(lists.inProgress.map((r) => [r.projectName, r.says]), [['Game corner', 'snait is building it']]);
  assert.deepEqual(lists.waiting.map((r) => r.says), ['ready to build; a vote they owe on Homeroom bot\'s changes can free its slot'],
    'the vote owed on #6039 is Needs you\'s alone');
  assert.deepEqual(lists.liveThisWeek.map((r) => r.says), ['live']);
  assert.deepEqual(lists.counts, { needsYou: 3, inProgress: 1, waiting: 1, liveThisWeek: 1 }, 'the headings\' counts: a private thread asks nothing');
  // my_work carries them, and the prompt says to answer from them.
  const mayor = read('src/services/homeroom-bot-mayor.js');
  assert.match(mayor, /onYourPage = await \(deps\.aiWork \|\| require\('\.\/ai-work'\)\)\.pageLists\(pool, \{/);
  assert.match(mayor, /call my_work and answer from its onYourPage:/);
  assert.match(mayor, /myWork\(pool, \{ userId: user\.id, user, settings, config: ctx\.config, deps \}\)/);
  // The feed is read the way its route reads it.
  assert.match(read('src/services/ai-work.js'), /feed\(pool, \{ user, showSelfHosted, inThreads: true \}\)/);
});

test('Needs you here is the threads you are in, counted in the label\'s ink, with no link to every vote', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /readJson<\{ items\?: NeedItem\[\] \}>\(`\/api\/workshop\/needs-feed\?in=threads\$\{qs \? '&demo=1' : ''\}`, init\)/);
  assert.match(read('frontend/src/features/ai/lists.tsx'),
    /head=\{owedShown \? t\('messages:ai\.work\.titleCount', \{ count: owedShown \}\) : t\('messages:ai\.work\.title'\)\}/,
    'the count is in the label\'s own words, not a link');
  assert.ok(!src.includes('ws=needs#communities'), 'All votes is gone');
  assert.equal(message('messages:ai.work.title'), 'Needs you');
  assert.equal(message('messages:ai.work.titleCount', { count: 5 }), 'Needs you · 5');
  const route = read('src/routes/workshop-overview.js');
  assert.match(route, /inThreads: req\.query\.in === 'threads',/);
  assert.match(route, /pool\.query\(inThreads \? NEEDS_FEED_IN_THREADS_SQL : NEEDS_FEED_SQL, \[/);
  const { NEEDS_FEED_SQL, NEEDS_FEED_IN_THREADS_SQL } = require('../src/routes/workshop-overview');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /AND \(o\.kind = 'question'\s+OR \(o\.thread_id IN \(SELECT mine\.thread_id FROM/, 'the bot\'s questions to you show wherever they are');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /f\.muted_at IS NOT NULL/, 'not a thread you muted');
  assert.ok(!NEEDS_FEED_SQL.includes('thread_followers f'), 'Communities › Needs you keeps every decision owed');
  // The most rows are not spent on threads that are never listed, and Live
  // this week has its own, apart from the rest, their own first (30 Oct 2026).
  const { THREADS_SQL } = require('../src/services/ai-work');
  assert.match(THREADS_SQL, /AND \(mine\.own OR ch\.status IS NULL OR ch\.status = 'merged' OR ch\.user_id = \$1\)/);
  assert.match(THREADS_SQL, /AND \(t\.state = 'open' OR \(t\.closed_at > NOW\(\) - make_interval\(days => \$5\) AND ch\.status = 'merged'\)\)/,
    'a closed thread is read only for its merged change');
  assert.match(THREADS_SQL, /PARTITION BY COALESCE\(ch\.status = 'merged', FALSE\)\s+ORDER BY mine\.own DESC,/);
  assert.match(THREADS_SQL, /\) listed\s+WHERE place <= \$4/);
  // A claim this week names who has it (homeroom-bot.js CLAIM_TTL_DAYS).
  assert.match(THREADS_SQL, /ic\.claimed_at > NOW\(\) - make_interval\(days => 7\)/);
  assert.match(THREADS_SQL, /cl\.username AS claimed_by, cl\.mine AS claimed_mine,/);
  // The feed names a change's request, which the rows above go by.
  const { shapeNeedsFeed } = require('../src/routes/workshop-overview');
  const base = { kind: 'proposal', id: 1, title: 'Its change', number: 6032, slug: 'garden', name: 'Garden club' };
  assert.deepEqual(shapeNeedsFeed([{ ...base, ballot_for: { number: 6038, title: 'Rule changes' } }])[0].request,
    { number: 6038, title: 'Rule changes' });
  assert.equal(shapeNeedsFeed([base])[0].request, undefined, 'a change for no request has none');
});

test('the first render is the prerender: hidden, the bot\'s name, no rows; lists in effects', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /id="ai-screen"\s+className="hidden flex-1 overflow-y-auto platform-safe-scroll"/);
  assert.match(src, /useVisibilityHiddenClass\(screenRef, 'ai-screen', false\);/);
  // Data only once the screen is shown to somebody signed in.
  assert.match(src, /if \(!visible \|\| typeof window === 'undefined' \|\| !\(window as any\)\.App\?\.user\) return undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`, init\)/);
  // Main docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"/);
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible\} at=\{at\} mainChat \/>/);
  // Ask Homeroom bot opens Main; a private thread opens in the column, and
  // before the page knows its width, by its address.
  assert.match(src, /<a\s+href="#homeroom-bot\/main"\s+className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /if \(!\(wide \|\| phone\)\) \{ go\(botTabAddress\(next\)\); return; \}/);
  // What the column shows is read from the store after mount only.
  assert.match(src, /const columnShows = mounted && \(phone \? !!botId : docked && !panel\.open\);/);
  assert.match(src, /const botRow = mounted \? snap\.conversations\.find/);
});

test('a page drawn before sign-in is confirmed asks again once it is, and its Ask bar starts at the rail', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // app.js announces the signed-in viewer with sv:session, on a saved-session
  // boot and again once the server confirms it; both reads and the docked
  // chat go again then, instead of staying empty until a reload.
  assert.match(src, /const again = \(\) => setSession\(\(n\) => n \+ 1\);\s+document\.addEventListener\('sv:session', again\);\s+return \(\) => document\.removeEventListener\('sv:session', again\);/);
  assert.match(src, /return \(\) => \{ live = false; \};\s+\}, \[visible, session, moved\]\);/);
  assert.match(src, /\}, \[visible, wide, phone, botId, session\]\);/);
  assert.match(read('public/js/app.js'), /document\.dispatchEvent\(new CustomEvent\('sv:session', \{\s+detail: \{ user: App\.user, verifiedSession: true \},/,
    'the confirmation it waits for');
  // A wide window whose Main is not docked (yet, or at all) keeps the bar
  // on the page, clear of the sidebar.
  assert.match(read('public/css/app.css'), /#ai-screen \.ai-askbar \{\s+position: fixed;\s+(\/\*[^*]*\*+([^/*][^*]*\*+)*\/\s+)?inset-inline-start: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter, 0px\)\);\s+inset-inline-end: var\(--platform-gutter, 0px\);/);
});

test('#homeroom-bot is the page; /main and /thread/<id> are Main and a thread in its column; #ai lands there', () => {
  const app = read('public/js/app.js');
  // 1 Nov 2026: every address is the page's, and says where in its chat.
  assert.match(app, /if \(parts\[0\] === 'homeroom-bot'\) \{[\s\S]*?App\.setChromeless\(false\);\s+App\.navigateToAi\(\);\s+if \(parts\[1\] === 'main' \|\| parts\[1\] === 'thread' \|\| parts\[1\] === 'm'\) \{\s+const at = App\._messagesExtras\(parts\[1\] === 'main' \? parts\.slice\(2\) : parts\.slice\(1\)\);\s+window\.UsernodeReact\?\.ai\?\.openAt\?\.\(\{/);
  assert.doesNotMatch(app, /messages\.openBotThread\(root\)/, 'never the Messages screen');
  assert.match(app, /case 'homeroom-bot':[^\n]*\n\s+case 'ai': return 'ai-screen';/);
  // The old address is an alias: rewritten in place, then routed as the new one.
  assert.match(app, /if \(parts\[0\] === 'ai'\) \{[\s\S]*?history\.replaceState\(null, '', '#homeroom-bot' \+ \(parts\.length > 1 \? '\/' \+ parts\.slice\(1\)\.join\('\/'\) : ''\)\);[\s\S]*?parts\[0\] = 'homeroom-bot';\s+\}\s+if \(parts\[0\] === 'homeroom-bot'\) \{/);
  // A Messages address of the bot's chat is swapped in place for the tab's.
  assert.match(app, /const botTab = validConversation \? window\.UsernodeReact\?\.ai\?\.botTabFromMessages\?\.\(`#\$\{hash\}`\) : null;\s+if \(botTab\) \{\s+try \{ history\.replaceState\(null, '', App\._rootUrl\(botTab\)\); \} catch \(_\) \{ return; \}\s+App\.restoreFromHash\(\);\s+return;\s+\}/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('the way into the bot\'s chat: each address and each door names a place in it, on its tab', () => {
  const door = loadTsx('frontend/src/features/ai/door.ts');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.equal(door.botTabAddress(null), '#homeroom-bot/main');
  assert.equal(door.botTabAddress({ threadRootId: 139 }), '#homeroom-bot/thread/139');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 150 }), '#homeroom-bot/thread/139/m/150');
  assert.equal(door.botTabAddress({ focusMessageId: 150 }), '#homeroom-bot/main/m/150');
  assert.equal(door.botTabAddress({ threadRootId: 139, focusMessageId: 139 }), '#homeroom-bot/thread/139', 'the root is no message to land on in its own thread');
  assert.equal(door.botTabAddress({ threadRootId: -4 }), '#homeroom-bot/main', 'nothing that is not an id');
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/thread/139/m/150')), { threadRootId: 139, focusMessageId: 150 });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/main')), { threadRootId: null, focusMessageId: null });
  assert.deepEqual(plain(door.botTabAt('#homeroom-bot/m/150')), { threadRootId: null, focusMessageId: 150 });
  assert.equal(door.botTabAt('#homeroom-bot'), null, 'the page itself: the column as it was');
  // A Messages address of the bot's chat is the same place, by its old address.
  assert.equal(door.botTabFromMessages('#messages/2', 2), '#homeroom-bot/main');
  assert.equal(door.botTabFromMessages('#messages/2/thread/139', 2), '#homeroom-bot/thread/139');
  assert.equal(door.botTabFromMessages('messages/2/thread/139/m/141', 2), '#homeroom-bot/thread/139/m/141');
  assert.equal(door.botTabFromMessages('#messages/2/m/141', 2), '#homeroom-bot/main/m/141');
  assert.equal(door.botTabFromMessages('#messages/3/thread/139', 2), null, 'any other chat is Messages\'');
  assert.equal(door.botTabFromMessages('#messages/2', null), null, 'nor while which chat is the bot\'s is not known');
  assert.equal(door.botTabFromMessages('#messages/app/garden', 2), null);
  // The side panel never draws it: its tab does.
  assert.equal(door.isBotChatRoute('messages/2/thread/139', 2), true);
  assert.equal(door.isBotChatRoute('messages/20', 2), false);
  assert.equal(door.isBotChatRoute('app/garden/dev/issues/4', 2), false);
  const controller = read('frontend/src/features/side-panel/controller.ts');
  for (const site of ['export function take(', 'export function onClickCapture(', 'export function onNavigate(']) {
    const body = controller.slice(controller.indexOf(site), controller.indexOf(site) + 2000);
    assert.match(body, /if \(!panelTakes\(route\) \|\| !canTake\(\)\)/, site);
  }
  // The page takes the router's ask once, in its column.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /if \(!ask \|\| ask\.seq === askTaken\.current \|\| !visible \|\| !\(wide \|\| phone\)\) return;\s+askTaken\.current = ask\.seq;\s+showAt\(ask\.at\);/);
  assert.match(read('frontend/src/features/ai/door.ts'), /host\.ai = \{ \.\.\.\(host\.ai \|\| \{\}\), openAt: askBotTab,/);
});

test('every door into the bot\'s chat lands on its tab, never the Messages screen', () => {
  const store = read('frontend/src/features/messages/store.ts');
  // open(), openAddress(), the bot doors, a quote and a request's See progress.
  assert.match(store, /if \(validId\(conversationId\) && conversationId === botConversationId\(\)\) \{ openBotTab\(null\); return; \}/);
  assert.match(store, /if \(\/\^#homeroom-bot\(\?:\\\/\|\$\)\/\.test\(href\)\) \{ goBotAddress\(href\); return; \}/);
  assert.match(store, /const botTab = botTabFromMessages\(href, botConversationId\(\)\);\s+if \(botTab\) \{ goBotAddress\(botTab\); return; \}/);
  const openBot = store.slice(store.indexOf('export async function openBot('), store.indexOf('export async function openBotRequest('));
  assert.match(openBot, /openBotTab\(null\);/);
  assert.doesNotMatch(openBot, /\bopen\(id\)/);
  assert.match(store, /if \(at\) openBotTab\(\{ threadRootId: null, focusMessageId: at \}\);/, 'See progress, at the request\'s message');
  assert.match(store, /openBotThread: \(rootId: number\) => \{ openBotTab\(\{ threadRootId: rootId, focusMessageId: null \}\); \},/);
  // A cold link: once the store learns the chat is the bot's, as for a channel.
  assert.match(store, /if \(active\.homeroomBot && active\.kind !== 'channel'\) \{\s+noteBotConversation\(active\.id\);\s+if \(state\.route\.open && !state\.route\.embedded\) \{\s+publish\(\{ active \}\);\s+if \(botToTab\(\)\) return;/);
  assert.match(store, /channelToHub\(\);\s+botToTab\(\);/, 'and when the list lands');
  // Design threads, bell rows and the first session name the tab.
  assert.match(read('src/services/design-threads.js'), /href: `#homeroom-bot\/thread\/\$\{Number\(opened\.messageId\)\}`,/);
  assert.match(read('frontend/src/features/first-session/index.tsx'), /else if \(screen === 'bot' && conversationId\) window\.location\.hash = '#homeroom-bot\/main';/);
  // The inbox does not list it.
  const { buildInbox } = loadTsx('frontend/src/features/messages/inbox.ts');
  const entries = buildInbox({ conversations: [
    { id: 2, lastActivityAt: '2026-11-01T10:00:00Z', kind: 'direct', homeroomBot: true },
    { id: 3, lastActivityAt: '2026-11-01T09:00:00Z', kind: 'direct' },
  ] });
  assert.deepEqual(entries.map((e) => e.key), ['person:3']);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, Needs you, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  assert.match(html, /<h1 class="[^"]*">Homeroom bot<\/h1>/);
  assert.match(html, /Needs you/);
  assert.match(html, /<a href="#homeroom-bot\/main" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
  assert.ok(!html.includes('data-ai-line'), 'no rows before the effects read them');
  assert.ok(!html.includes('ai-drawer'), 'and no drawer before mount, on a phone either');
  assert.ok(!html.includes('data-ai-main=""'), 'and Main is not docked before mount');
  // 1 Nov 2026: Main Chat is the list's first row, from the first render, lit only once mounted.
  assert.match(html, /<div class="[^"]*" data-ai-sheet="main"><button type="button" class="[^"]*" data-ai-main-row=""><img [^>]*\/><span class="[^"]*">Main Chat<\/span><\/button><\/div>/);
  assert.ok(!html.includes('data-ai-lit'), 'nothing is lit before the page knows what its column shows');
});

test('Main Chat is the list\'s first row: the bot\'s mark, its name, what is new in words, lit while in the column', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const rows = [
    { key: 'private:139', title: 'A weekly email', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 139 },
    { key: 'private:730', title: 'A darker header', app: null, who: 'solo', sub: { id: 'messages:ai.row.privateIdea' }, pill: null, href: null, rootId: 730 },
  ];
  const props = (main, lit = null) => ({
    hero: null, main: { open() {}, ...main }, lit, ready: true, rows, owed: 0, progress: [], waiting: [], live: [], openRow() {}, openThread() {},
  });
  const LISTS = 'frontend/src/features/ai/lists.tsx';
  const lit = renderComponent(LISTS, 'AiLists', props({ lit: true, unread: 2 }));
  // First, before Needs you; its unread count in words.
  assert.ok(lit.indexOf('data-ai-main-row') < lit.indexOf('data-ai-list="work"'), 'the first row');
  assert.match(lit, /data-ai-main-row="" data-ai-lit="" aria-current="true">/);
  assert.match(lit, /<span class="[^"]*" data-ai-main-unread="">2 new<\/span>/);
  assert.equal(message('messages:ai.main.new', { count: 1 }), '1 new');
  const quiet = renderComponent(LISTS, 'AiLists', props({ lit: false, unread: 0 }, 'private:730'));
  assert.doesNotMatch(quiet, /data-ai-main-row="" data-ai-lit/, 'Main is not lit while a thread is in the column');
  assert.doesNotMatch(quiet, /data-ai-main-unread/, 'and nothing new says nothing');
  // The thread in the column is the lit row, where you are, and only it.
  assert.equal((quiet.match(/data-ai-lit=""/g) || []).length, 1);
  assert.match(quiet, /data-ai-line="private" data-ai-lit="" aria-current="true"><span[^>]*>[\s\S]*?A darker header/);
  const src = read(LISTS);
  assert.match(src, /const LIT_ROW = '[^']*bg-\[color:var\(--lit-tint\)\] text-\[color:var\(--lit-ink\)\]';/, 'the lit tint and ink, as the rail\'s rows are');
  // The page lights Main, a thread, or nothing while a page or a blank thread holds the column.
  assert.match(read('frontend/src/features/ai/index.tsx'), /const lit = !columnShows \|\| blank \? null : openRoot \? `private:\$\{openRoot\}` : 'main';/);
});

test('the column from 768px: Main, or one thread alone under its own head; a page the panel holds puts Main back under it', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /const WIDE = '\(min-width: 768px\)';/);
  // Main's bar only over Main; a thread or a blank one has its own head.
  assert.match(src, /\{threadUp \? null : \(\s*<header className="ai-main-head" data-ai-main-head="">/);
  assert.match(src, /data-ai-column=\{threadUp \? 'thread' : 'main'\}/);
  // A place in the chat: the panel gives the column back, a blank thread goes, Main closes a thread.
  // 1 Nov 2026 (C1): and a design's preview goes, unless it is that thread's.
  assert.match(src, /const showAt = \(next: BotAt\) => \{\s+sidePanel\(\)\?\.close\?\.\(\);\s+closeNewThread\(\);\s+if \(!next\.threadRootId \|\| next\.threadRootId !== preview\?\.rootId\) closePreview\(\);\s+if \(!next\.threadRootId && openRoot\) closeThread\(\);\s+setAt\(\{ \.\.\.next \}\);\s+if \(phone\) setLevel\(1\);\s+\};/);
  assert.match(src, /if \(openPublic\(row\.href, row\.app, row\.title, aboutRow\(row\), botId\)\) underPanel\(\);/);
  assert.match(src, /const underPanel = \(\) => \{\s+closeNewThread\(\);\s+if \(openRoot\) closeThread\(\);\s+showAddress\(BOT_TAB\);\s+\};/);
  // The panel takes a page beside this page from 768px too.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_QUERY = '\(min-width: 768px\)';/);
  assert.match(controller, /return window\.matchMedia\(besideApp \? DESKTOP_QUERY : BESIDE_AI_QUERY\)\.matches;/);
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 1023\.98px\) \{[^}]*?\*\/\s+body:not\(:has\(#ai-screen:not\(\.hidden\)\)\) #platform-side-panel \{\s+display: none;\s+\}\s+\}\s+@media \(max-width: 767\.98px\) \{\s+#platform-side-panel \{\s+display: none;\s+\}\s+\}/);
  assert.match(css, /@media \(max-width: 1023\.98px\) \{\s+body:has\(#ai-screen:not\(\.hidden\)\) \{ --ai-list-min: 280px; \}\s+\}/);
});

test('a thread opens on this page: beside the list in Main\'s place, or on its page with a way back here', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"\s+aria-labelledby=\{threadUp \? undefined : 'ai-main-title'\}\s+data-ai-main=""/);
  assert.match(src, /<span id="ai-main-title"[^>]*>\s+\{t\('messages:store\.header\.main'\)\}/);
  assert.match(src, /\{t\('messages:ai\.main\.sub'\)\}/);
  assert.equal(message('messages:ai.main.sub'), 'Only you can see this chat');
  assert.equal(message('messages:store.header.main'), 'Main Chat', 'Main Chat, over it, in Messages and in the drawer alike');
  // The panel takes it wherever it can (a wide window), with the row's project and title; its page otherwise.
  assert.match(src, /if \(sidePanel\(\)\?\.take\?\.\(href\.replace\(\/\^#\/, ''\), \{ place: app, label \}\)\) \{/);
  assert.match(src, /if \(isTopicHref\(href\)\) improve\(\)\?\.enterTopicFrom\?\.\(BOT_PAGE\);\s+go\(href\);/,
    'a topic page opened from here goes back here');
  assert.match(src, /const BOT_PAGE = BOT_TAB;/);
  assert.equal(loadTsx('frontend/src/features/ai/door.ts').BOT_TAB, '#homeroom-bot');
  assert.match(src, /const openThread = \(th: AiThread\) => \{\s+if \(openPublic\(th\.href, th\.app, th\.title, aboutRow\(th\), botId\)\) underPanel\(\);/,
    'In progress, Waiting and Live this week');
  assert.match(src, /if \(openPublic\(row\.href, row\.app, row\.title, aboutRow\(row\), botId\)\) underPanel\(\);\s+\};/, 'and Needs you');
  const { isTopicHref } = loadTsx(MODEL);
  assert.equal(isTopicHref('#app/garden/dev/issues/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/changes/12'), true);
  assert.equal(isTopicHref('#app/garden/dev/governance/3'), true);
  assert.equal(isTopicHref('#app/garden/workshop'), false, 'a Workshop is no topic: the origin would wait for the next one');
  // A private thread is the column's: the panel gives its place back first (showAt).
  assert.match(src, /const next = \{ threadRootId: row\.rootId, focusMessageId: null \};[\s\S]{0,120}showAt\(next\);\s+showAddress\(botTabAddress\(next\)\);/);
  // The panel may stand beside the AI tab's page, and stays while it is up.
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /const besideAi = typeof A\._isScreenVisible === 'function' && A\._isScreenVisible\('ai-screen'\);/);
  assert.match(read('public/js/app.js'), /appPresence\?\.\(\(inApp \|\| screen === 'ai-screen'\) && !App\.chromeless\)/);
  // Opened from here on its page, it is still this tab's.
  const app = read('public/js/app.js');
  assert.match(app, /_isBotTopic\(\) \{\s+if \(!\(App\.currentTab === 'dev' && App\.currentSubTab === 'topic'\)\) return false;\s+const origin = window\.Improve\?\.topicOrigin\?\.\(\);/);
  assert.match(app, /\(App\._isMessagesThread\(\) \? 'messages' : App\._isBotTopic\(\) \? 'ai' : 'workshop'\)/, 'it keeps Homeroom bot lit');
});

test('on a phone the list and Main Chat are one drawer, as Messages\' are; a request opens on its page', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  const drawer = read('frontend/src/features/ai/phone-drawer.tsx');
  // Messages' own strip, slide and landing rule.
  assert.match(drawer, /import \{ isPan, landingIn, MESSAGES_AT, SLIDE_EASE, SLIDE_MS \} from '\.\.\/nav-drawer\/drawer-math';/);
  assert.match(drawer, /transition: still \? 'none' : `transform \$\{SLIDE_MS\}ms \$\{SLIDE_EASE\}`/);
  assert.match(drawer, /const still = drag != null \|\| snap \|\| reducedMotion\(\);/, 'none under Reduce Motion');
  // The level not in view is out of reach, not only out of sight.
  assert.match(drawer, /<div className="ai-drawer-list" inert=\{level === 1\} aria-hidden=\{level === 1 \? true : undefined\}>\{list\}<\/div>/);
  assert.match(drawer, /<div className="ai-drawer-pane" inert=\{level === 0\} aria-hidden=\{level === 0 \? true : undefined\}>\{pane\}<\/div>/);
  assert.match(drawer, /<button type="button" className="messages-peek-open ai-drawer-peek" aria-label=\{peekLabel\} onClick=\{\(\) => onLevel\(1\)\} \/>/, 'the peek opens it');
  // Only Main Chat: no page in a frame (Evan, 30 Oct: "the Messages approach").
  assert.ok(!drawer.includes('<iframe'), 'a request is never drawn in the drawer');
  assert.match(src, /setAt\(\{ \.\.\.next \}\);\s+if \(phone\) setLevel\(1\);/, 'a row slides the column in, at it');
  assert.match(src, /onClick=\{\(e\) => \{ if \(phone\) \{ e\.preventDefault\(\); openMain\(\); \} \}\}/, 'and so does the Ask bar');
  // 1 Nov 2026: a thread alone in the column, its own arrow back to the list.
  assert.match(drawer, /\{threadUp \? null : <header className="ai-drawer-head" data-ai-drawer-head="">/);
  assert.match(drawer, /<EmbeddedConversation conversationId=\{botId\} active=\{active\} at=\{at\} mainChat onBack=\{onBack\} \/>/);
  assert.match(src, /pane=\{<MainPane botId=\{botId\} active=\{visible\} at=\{at\} onBack=\{toList\} threadUp=\{threadUp\} \/>\}/);
  assert.match(src, /data-ai-drawer=\{phone \? level : undefined\}/);
  assert.match(drawer, /const PHONE_QUERY = '\(max-width: 767\.98px\)';/);
  const css = read('public/css/app.css');
  assert.match(css, /\.ai-drawer-list \{\s+position: absolute; top: 0; bottom: 0; inset-inline-start: 0; width: 85%;/);
  assert.match(css, /\.ai-drawer-back::after \{ content: ""; position: absolute; inset: -6px; \}/, 'its arrow is pressed as a 44px target');
  assert.match(css, /\.ai-drawer\[data-level="0"\] :is\(\.ai-drawer-back, \.messages-thread-back\) \{ opacity: 0;/, 'neither arrow shows in the peek');
  assert.equal(message('messages:ai.drawer.peek', { title: message('messages:store.header.main') }), 'Open Main Chat');
});

test('on a phone the list is the whole screen until a thread has been opened, then the drawer peeks (Evan, 1 Nov 2026)', () => {
  const drawer = read('frontend/src/features/ai/phone-drawer.tsx');
  assert.match(drawer, /export const FULL_AT: readonly \[number, number\] = \[0, 1\];/, 'with no peek the column rests a whole screen to the right');
  assert.match(drawer, /const OPENED_KEY = 'homeroom:botDrawer:threadOpened';/, 'remembered per device');
  assert.match(drawer, /const at = opened \? MESSAGES_AT : FULL_AT;/);
  assert.match(drawer, /const offset = drag \?\? at\[level\];/, 'rest, drag and landing all read the one table');
  assert.match(drawer, /onLevel\(landingIn\(at, p\.from, now, \(e\.clientX - p\.x\) \* dirSign\(\)\) as 0 \| 1\);/);
  assert.match(drawer, /\{opened && level === 0 && drag == null \? \(/, 'no peek button before a thread was opened');
  assert.match(drawer, /data-peek=\{opened \? '' : undefined\}/);
  // Laid out once the slide has landed, and switched with no slide.
  assert.match(drawer, /if \(opened \|\| level !== 1\) return undefined;\s+rememberThreadOpened\(\);\s+const id = window\.setTimeout\(\(\) => \{ setSnap\(true\); setOpened\(true\); \}, SLIDE_MS \+ 50\);/);
  assert.match(drawer, /const still = drag != null \|\| snap \|\| reducedMotion\(\);/);
  const css = read('public/css/app.css');
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-list \{ width: 100%; \}/);
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\) \.ai-drawer-thread \{ inset-inline-start: 100%; \}/);
  assert.match(css, /\.ai-drawer:not\(\[data-peek\]\)\[data-level="0"\]:not\(\[data-panning\]\) \.ai-drawer-thread \{ box-shadow: none; border-inline-start-color: transparent; \}/, 'no shadow at the list\'s edge');
});

test('what a row opens rides along in Main Chat\'s composer, and only there', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /window\.dispatchEvent\(new CustomEvent\('usernode:messages-object-selected', \{ detail: \{ \.\.\.about, conversationId: botId \} \}\)\);/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /const \{ conversationId: to, \.\.\.object \} = detail;\s+if \(to != null && to !== conversationId\) return;\s+setObject\(object\);/,
    'a composer under another conversation, mounted under a hidden screen, keeps what it had');
  const { aboutRow } = loadTsx('frontend/src/features/ai/index.tsx');
  assert.deepEqual(aboutRow({ href: '#app/garden/dev/issues/12', title: 'Dark mode', app }), { type: 'issue', appSlug: 'garden', issueNumber: 12, title: 'Dark mode' });
  assert.deepEqual(aboutRow({ key: 'need:governance:4', href: '#app/garden/dev/governance/4', title: 'Rename', app }),
    { type: 'governance', appSlug: 'garden', proposalId: 4, title: 'Rename' });
  assert.equal(aboutRow({ href: '#app/garden/workshop', title: 'x', app }), null, 'a Workshop is no item');
});

test('beside this page the panel is the page\'s own column: ‹ Main and the project, no Expand, Close or Back', () => {
  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(panel, /<button\s+type="button"\s+className="side-panel-main dev-topic-back un-touch-target"\s+aria-label=\{t\('agent:sidePanel\.mainLabel'\)\}\s+onClick=\{\(\) => controller\.close\(\)\}\s+>/,
    '‹ Main gives Main its place back, in the topic\'s own chip');
  assert.match(panel, /<PanelHeading route=\{s\.route\} place=\{s\.place\} reported=\{s\.reported\} label=\{s\.label\} \/>/);
  assert.match(panel, /href=\{`#app\/\$\{encodeURIComponent\(slug\)\}\/workshop`\}/, 'the project, as a door to its page');
  assert.match(panel, /\(window as any\)\.AppView\?\._landOnHub\?\.\(slug\)/, 'which opens on its Hub');
  assert.equal(message('agent:sidePanel.main'), 'Main Chat', 'the chat\'s name, as its title says it');
  assert.equal(message('agent:sidePanel.mainLabel'), 'Back to Main Chat');
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export const BESIDE_AI_CLASS = 'side-panel-beside-ai';/);
  assert.match(controller, /classList\.toggle\(BESIDE_AI_CLASS, isBesideAi\(\)\)/);
  assert.match(controller, /const \{ place = null, label = null, \.\.\.rest \} = given \|\| \{\};/, 'the project and the title are this document\'s, not the page\'s hint');
  const css = read('public/css/app.css');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(#side-panel-back, #side-panel-title, #side-panel-expand, #side-panel-close\) \{\s+display: none;\s+\}/,
    'the panel\'s controls go, but not its left edge, the handle Main\'s edge is too');
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel :is\(\.side-panel-main, \.side-panel-place\) \{ display: inline-flex; \}/);
  assert.match(css, /\.side-panel-head > :is\(\.side-panel-main, \.side-panel-place\) \{ display: none; \}/, 'and beside an app, as it was');
  assert.match(css, /html\.in-side-panel\.side-panel-beside-ai :is\(\.dev-topic-backs, \.dev-topic-back\) \{ display: none; \}/,
    'and the page in it leaves out its own "‹ Workshop"');
});

test('Main\'s column is held inside the window, and the panel takes its place at its width', () => {
  const css = read('public/css/app.css');
  // A width chosen beside an app on a wide monitor must not run Main under
  // the rail; with none chosen, Main takes the room the list does not need
  // (30 Oct 2026), 400px to 720px. The room is the page's usable box, the
  // window less the rail and the Duo's column, declared once on body
  // (1 Nov 2026; tests/usable-box.test.js pins how it is made).
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-room: var\(--platform-usable-w\);\s+--ai-list-min: 480px;\s+--ai-main-auto: clamp\(400px, calc\(var\(--ai-room\) - 720px\), 720px\);\s+--ai-main-w: max\(320px, min\(var\(--side-panel-chosen-w, var\(--ai-main-auto\)\), calc\(var\(--ai-room\) - var\(--ai-list-min\)\)\)\);\s+\}/);
  assert.match(css, /#ai-screen\[data-ai-docked\] \{ padding-inline-end: var\(--ai-main-w\); \}/);
  // 1 Nov 2026, iPhone Duo held sideways (951px, an 84px column of system
  // chrome on the right that the body pads out): the room is beside the
  // column, so its width is not counted twice. The columns pinned to the
  // right edge run their ground under the column to the screen's edge, as
  // the header does: stopped at the column, Main ended in a hard edge beside
  // bare wallpaper. Their heads pad their contents by the column, where the
  // clock, camera and Wi-Fi sit; below them the chat and the panel's page
  // run under it (padded, they left a band of another colour). A design's
  // preview pads it, its ✕ at its top. Off the Duo both are 0.
  assert.match(css, /html\[data-side-strip="right"\] body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-edge: var\(--platform-strip-w, 0px\);\s+\}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*inset-inline-end: 0;[^}]*width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-screen \.ai-main-head \{[^}]*padding-block: 12px; padding-inline: 18px calc\(18px \+ var\(--ai-edge, 0px\)\);/, 'its name stops beside the column, its hairline runs under it');
  // A thread in Main Chat's place has its own head, which pads by the column too (1 Nov 2026).
  assert.match(css, /#ai-screen \.ai-main-pane \.messages-thread-header\[data-reply-head="main"\] \{\s+padding-inline-end: calc\(16px \+ var\(--ai-edge, 0px\)\);\s+\}/,
    'a thread\'s title stops beside the column, not under the clock');
  assert.match(read('frontend/src/features/messages/index.tsx'), /<header className="messages-thread-header" data-reply-head=\{inMain \? 'main' : undefined\}>/);
  assert.doesNotMatch(css, /\.messages-layout \{[^}]*padding-inline-end: var\(--ai-edge/, 'the chat runs under the column, below its head');
  assert.match(css, /#ai-screen \.ai-preview-pane \{[^}]*inset-inline-end: 0;[^}]*width: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);\s+padding-inline-end: var\(--ai-edge, 0px\);/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{\s+width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel-head \{[^}]*padding-block: 12px; padding-inline: 18px calc\(18px \+ var\(--ai-edge, 0px\)\);/);
  // Only a notch (an iPhone held sideways, THE NOTCH) pads the chat and the
  // panel's page: its island is halfway down, not plain screen.
  const unNotched = css.replace(/html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\)[^{]*\{[^}]*\}/g, '');
  assert.doesNotMatch(unNotched, /\.side-panel-body \{[^}]*var\(--ai-edge/, 'and so does the page in the side panel');
  assert.match(css, /html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) #ai-screen \.ai-main-pane > \.messages-layout,\nhtml:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel-body \{\n  padding-inline-end: var\(--ai-edge, 0px\);/);
  // In the Homeroom app the panel stands here too (canTake), and a reply
  // typed in its own document had the keyboard over its box: it ends above
  // the keyboard the kit measures from the screen.
  assert.match(css, /html\.un-kb body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{ bottom: var\(--un-kb-inset, 0px\); \}/);
  assert.match(css, /#ai-screen:is\(\[data-ai-preview="three"\], \[data-ai-preview="halves"\]\) \.ai-main-pane \{\s+width: var\(--ai-col-w\);\s+inset-inline-end: calc\(var\(--ai-preview-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-screen\[data-ai-preview="halves"\] \{\s+--ai-col-w: calc\(var\(--ai-room\) \/ 2\);/);
  const page = css.slice(css.indexOf('body:has(#ai-screen:not(.hidden)) {'), css.indexOf('/* A phone: the whole of the page, over the drawer'));
  assert.equal((page.match(/100vw/g) || []).length, 0,
    'no width here is taken from the window: the room is the page\'s usable box, and every other is taken from the room');
  // With Main docked it is the far edge and has no gutter, so the rail's is
  // dropped too: the list's cards sit 16px (their own margin) from both.
  assert.match(css, /#ai-screen\[data-ai-docked\] \{ padding-inline-start: var\(--platform-rail-w, 0px\); \}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/);
  assert.match(css, /#ai-screen \.ai-main-pane > \.messages-layout \{ flex: 1 1 auto; height: auto; min-height: 0; \}/);
  assert.match(css, /html\[data-side-panel\] #ai-screen \.ai-main-pane \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 768px\) \{\s+html\[data-side-panel\] #ai-screen \{ padding-inline-end: var\(--ai-main-w\); \}\s+\}/);
  assert.match(css, /body:has\(#ai-screen:not\(\.hidden\)\) \.side-panel \{\s+width: calc\(var\(--ai-main-w\) \+ var\(--ai-edge, 0px\)\);/, 'so the list does not move');
  // 30 Oct 2026: Main's left edge is the side panel's handle, and sets the same width.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /import \{ SidePanelDivider \} from '\.\.\/side-panel\/side-panel';/);
  assert.match(src, /<aside\s+id="ai-main-pane"\s+ref=\{mainRef\}\s+className="ai-main-pane"[^>]*>\s+<SidePanelDivider panelRef=\{mainRef\} shown=\{docked\} id="ai-main-divider" controls="ai-main-pane" \/>/);
  assert.match(read('frontend/src/features/side-panel/side-panel.tsx'), /export function SidePanelDivider\(\{\s+panelRef,\s+shown,\s+id = 'side-panel-divider',\s+controls = 'platform-side-panel',/);
});

test('the tab says Homeroom bot: a wide seat on a phone, two lines in the Duo column', () => {
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  const css = read('public/css/app.css');
  // Measured in the bar's font: 79px of label in an 83-87px seat at 375-390, 76 in 80 at 360.
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.3fr 1\.3fr 1fr 1fr; \}/,
    'Communities, second, and Homeroom bot, third, take the wide seats');
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.2fr 1\.2fr 1fr 1fr; \}/, 'a little less on the smallest phones');
  assert.match(css, /:is\(#platform-tab-workshop, #platform-tab-ai\) \.platform-tab-label \{\s+letter-spacing: -\.02em;\s+overflow: visible;\s+text-overflow: clip;\s+\}/,
    'tightened and let out of the cell rather than cut');
  assert.match(css, /html\[data-side-strip\] #platform-tab-ai \.platform-tab-label \{\s+font-size: 9\.5px;\s+letter-spacing: -\.02em;\s+line-height: 1\.05;\s+white-space: normal;\s+text-align: center;\s+\}/,
    'the Duo column: "Homeroom" over "bot"');
});

const LIVE = 'frontend/src/features/ai/live.ts';

test('the lists are read again for an event that moves a thread they list, and only for one', () => {
  const { movesLists } = loadTsx(LIVE);
  const showing = { projects: new Set(['garden']), botId: 77 };
  const moves = (event) => movesLists(event, showing);
  // A change or a request in a project the lists show.
  assert.equal(moves({ type: 'vote_update', appSlug: 'garden', sessionId: 4 }), true);
  assert.equal(moves({ type: 'session_update', appSlug: 'garden', action: 'promoted' }), true);
  assert.equal(moves({ type: 'issue_update', appSlug: 'garden', action: 'closed' }), true);
  assert.equal(moves({ type: 'app_version_changed', appSlug: 'garden', sha: 'abc' }), true, 'a merge going live');
  assert.equal(moves({ type: 'vote_update' }), true, 'one that names no project could be about any');
  // …and not in one they do not show: those go to everyone who may view it.
  assert.equal(moves({ type: 'vote_update', appSlug: 'bread', sessionId: 4 }), false);
  assert.equal(moves({ type: 'issue_update', appSlug: 'bread' }), false);
  // A change's own banners move no row.
  for (const action of ['behind_main', 'freshness', 'sync_status', 'staging_ready']) {
    assert.equal(moves({ type: 'session_update', appSlug: 'garden', action }), false, action);
  }
  // Yours alone, from any project: something asked of you, or answered.
  assert.equal(moves({ type: 'notification_new', notification: {} }), true);
  assert.equal(moves({ type: 'notifications_changed' }), true);
  // Main Chat's messages: a private thread comes and goes with them.
  assert.equal(moves({ type: 'conversation_message_created', conversationId: 77, threadRootId: 5 }), true);
  assert.equal(moves({ type: 'conversation_message_updated', conversation_id: '77' }), true);
  assert.equal(moves({ type: 'conversation_message_created', conversationId: 12 }), false, 'another conversation');
  assert.equal(movesLists({ type: 'conversation_message_created', conversationId: 77 }, { projects: new Set(), botId: null }), false);
  // Nothing else on the socket.
  for (const type of ['session_state', 'session_event', 'kudos_update', 'conversation_typing', 'budget_updated', 'homeroom_bot_work_changed']) {
    assert.equal(moves({ type, appSlug: 'garden', conversationId: 77 }), false, type);
  }
  assert.equal(moves(null), false);
});

test('a correction the service worker makes to one of the lists\' reads is theirs', () => {
  const { isListRead } = loadTsx(LIVE);
  const at = (p) => isListRead(new URL(p, 'https://homeroom.test'));
  assert.equal(at('/api/ai/work'), true);
  assert.equal(at('/api/ai/work?demo=1'), true);
  assert.equal(at('/api/workshop/needs-feed?in=threads'), true);
  assert.equal(at('/api/workshop/needs-feed?in=threads&demo=1'), true);
  assert.equal(at('/api/workshop/needs-feed'), false, 'the Communities screen\'s feed');
  assert.equal(at('/api/workshop/counts'), false);
});

test('one read a burst, a few seconds apart at least, and none while the browser tab is hidden', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { pacedReads, GATHER_MS, GAP_MS } = loadTsx(LIVE);
  assert.ok(GATHER_MS > 0 && GAP_MS > GATHER_MS);
  let hidden = false;
  let reads = 0;
  const paced = pacedReads(() => { reads += 1; }, () => hidden);

  // Showing the page just read: the first burst waits out the gap from it.
  paced.ask();
  paced.ask();
  t.mock.timers.tick(GAP_MS - 1);
  assert.equal(reads, 0);
  t.mock.timers.tick(1);
  assert.equal(reads, 1, 'the burst is one read');

  // Long after: a burst is gathered for GATHER_MS, then read once.
  t.mock.timers.tick(GAP_MS * 3);
  paced.ask();
  t.mock.timers.tick(GATHER_MS / 2);
  paced.ask();
  paced.ask();
  t.mock.timers.tick(GATHER_MS / 2);
  assert.equal(reads, 2);
  t.mock.timers.tick(GAP_MS * 3);
  assert.equal(reads, 2, 'and nothing more was asked');

  // Hidden: nothing is read, and what was asked is read when the tab is back.
  hidden = true;
  paced.ask();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 2);
  paced.seen();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 2, 'still hidden');
  hidden = false;
  paced.seen();
  t.mock.timers.tick(GATHER_MS);
  assert.equal(reads, 3);
  paced.seen();
  t.mock.timers.tick(GAP_MS);
  assert.equal(reads, 3, 'a tab coming back with nothing owed reads nothing');

  // The page going stops what was asked.
  paced.ask();
  paced.stop();
  t.mock.timers.tick(GAP_MS * 2);
  assert.equal(reads, 3);
});

test('the page listens while it is shown: the socket through app.js, the bot\'s work, and live reads', () => {
  const live = read(LIVE);
  // app.js hands it every events-socket message, ahead of its own switch.
  assert.match(read('public/js/app.js'), /const data = JSON\.parse\(event\.data\);\s+(\/\/[^\n]*\n\s+)*window\.UsernodeReact\?\.aiScreen\?\.handleEvent\?\.\(data\);\s+switch \(data\.type\) \{/);
  assert.match(live, /bridge\.aiScreen = \{ handleEvent \};/);
  // Only while the page is shown, and all of it let go when it is not.
  assert.match(live, /if \(!visible \|\| typeof window === 'undefined'\) return undefined;/);
  assert.match(live, /listeners\.add\(onEvent\);\s+window\.addEventListener\(WORK_CHANGED_EVENT, reads\.ask\);\s+document\.addEventListener\('visibilitychange', reads\.seen\);\s+const unwatch = watch\(reads\.ask, \{ reads: isListRead \}\);/);
  assert.match(live, /reads\.stop\(\);\s+listeners\.delete\(onEvent\);\s+window\.removeEventListener\(WORK_CHANGED_EVENT, reads\.ask\);\s+document\.removeEventListener\('visibilitychange', reads\.seen\);\s+unwatch\(\);/);
  // The page: each read it is asked for is the showing's read again, past
  // the worker's saved copy after the first, keeping the lists on a failure.
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /useLiveLists\(\(\) => setMoved\(\(n\) => n \+ 1\), visible, \{ projects, botId \}\);/);
  assert.match(src, /const init = again \? FRESH : undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`, init\)/);
  assert.match(src, /if \(live && \(data \|\| !again\)\) setNeeds\(/);
});
