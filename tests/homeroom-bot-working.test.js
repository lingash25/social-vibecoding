'use strict';

// Homeroom bot says when it is working, and does what it says (1 Nov 2026).
//
// Evan, in a private design thread: he asked the bot to render a screen and
// the whole answer was "Let me look at how the app builds its main screen so
// the design matches it.", then nothing. Asked "can you do that? In the
// current thread?", it said "Drawing it now from the app's own markup and
// styles." and drew nothing. Both loops (homeroom-bot-mayor.js, design-bot.js)
// took words with no tool call as the answer; the screen showed a thin "is
// typing" line, if anything. Pinned here, without a database:
//
//   1. Words that only announce the next step (announcesOnly), never a real
//      answer that happens to start "Let me know…".
//   2. Main Chat's loop goes on after them, and its claim check catches a
//      reply that says it is drawing with no draw_screen behind it.
//   3. The designer goes on after words that do not draw (a preamble, a
//      drawing it did not make, a question asking leave), and a real
//      question back still ends its turn.
//   4. What the bot is doing, by tool (doingFor), told to its typing.
//   5. The prompt: a status question in a thread is about that thread; a
//      screen asked for is drawn in that turn.
//   6. The working card in place of the bot's typing line; people keep the line.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message: catalog } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const realDm = require('../src/services/homeroom-bot-dm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EVANS_FIRST = 'Let me look at how the app builds its main screen so the design matches it.';
const EVANS_SECOND = 'Drawing it now from the app\'s own markup and styles.';

// ── 1. Words that only announce the next step ────────────────────────────

test('words that only say what it will do next are told apart from an answer', () => {
  const announce = [
    EVANS_FIRST,
    EVANS_SECOND,
    'Sure! I\'ll draw that screen for you now.',
    'Good idea. First, I\'ll check your projects.',
    'Now I\'ll read the code.',
    'I\'m going to look at the settings screen first.',
    'I\'m checking your projects now.',
    '**Let me take a look at the code:**',
    'Let\'s draw it.',
    'Reading the code…',
    'Looking at how the app is laid out.',
    'Drawing the screen…',
    'Working on it.',
    'On it.',
    'Starting on that now.',
  ];
  for (const text of announce) assert.equal(mayor.announcesOnly(text), true, text);
  const answers = [
    'Let me know if you want me to draw it.',
    'Let me know what you think!',
    'Let me know which project it is for, and I can draw it.',
    'I\'ll let you know when it is live.',
    'Want me to draw it?',
    'I can draw it for you.',
    'Your request #12 is live. Let me check the next one.',
    'Reading request #12, it\'s waiting for your vote.',
    'Looking at your page, nothing is being built right now.',
    'Looking good!',
    'I\'ll check back later.',
    'I\'ll draw it once you tell me which project.',
    'Here is the plan:\n1. A header\n2. A list',
    'Nothing is being built for Ear Trainer right now.',
    'I\'ll make sure the team hears about it.',
    'Let me check: your request is being built and should be ready soon. It is on step 2 of 7, about 6 minutes so far, '
      + 'and the step usually takes 10 to 20 minutes. I will say here when its change is up for your vote.',
    '',
  ];
  for (const text of answers) assert.equal(mayor.announcesOnly(text), false, text);
});

test('a loop goes on after one only while a round, a nudge and room are left', () => {
  const at = { rounds: 2, limit: 6, nudged: 0, messages: 20 };
  assert.equal(mayor.goesOnAfter(EVANS_FIRST, at), true);
  assert.equal(mayor.goesOnAfter('Here it is.', at), false, 'an answer ends the turn');
  assert.equal(mayor.goesOnAfter(EVANS_FIRST, { ...at, rounds: 6 }), false, 'no round left');
  assert.equal(mayor.goesOnAfter(EVANS_FIRST, { ...at, nudged: mayor.MAX_PREAMBLE_NUDGES }), false, 'told often enough');
  assert.equal(mayor.goesOnAfter(EVANS_FIRST, { ...at, messages: 95 }), false, 'the transport\'s limit');
  assert.match(mayor.PREAMBLE_NOTE, /^\[Homeroom check, not from them: you said what you would do next but did not do it\. Do it now with your tools, or give your answer with reply\.\]$/);
  assert.doesNotMatch(mayor.PREAMBLE_NOTE, /—/);
});

// ── 2. Main Chat ─────────────────────────────────────────────────────────

const call = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });
function scripted(steps, seen = []) {
  let i = 0;
  return async (req) => {
    seen.push(structuredClone(req.messages));
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

function mayorTurn(steps, extra = {}) {
  const sent = [];
  const doings = [];
  const seen = [];
  const sql = [];
  const pool = { async query(text) { sql.push(String(text)); return { rows: [] }; } };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
    dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; } },
    doing: async (what) => { doings.push(what); },
    ...extra,
  };
  const run = mayor.runDmTurn(pool, {}, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live', perPerson: 2 },
    conversationId: 41,
    message: { id: 70, content: 'Can you render the main screen of Ear Trainer?' },
    deps,
  });
  return { run, sent, doings, seen, sql };
}

test('Main Chat goes on after its own preamble, and says what it is doing as it works', async () => {
  const turn = mayorTurn([
    EVANS_FIRST,
    { calls: [call('list_source', { project: 'Ear Trainer' })] },
    { calls: [call('reply', { text: 'It is one page, public/index.html, with the keys drawn in a grid.' })] },
  ]);
  await turn.run;
  assert.equal(turn.seen.length, 3, 'three requests: the preamble was not the answer');
  const second = turn.seen[1];
  assert.deepEqual(second.slice(-2), [
    { role: 'assistant', content: EVANS_FIRST },
    { role: 'user', content: mayor.PREAMBLE_NOTE },
  ], 'its words go back as its own, with the note');
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, 'It is one page, public/index.html, with the keys drawn in a grid.');
  assert.deepEqual(turn.doings, [{ kind: 'code' }], 'reading the code; a project it cannot find is not named');
  const recorded = turn.sql.find((s) => /INSERT INTO homeroom_bot_dm_turns/.test(s));
  assert.ok(recorded, 'the turn is recorded');
});

test('Main Chat: Evan\'s "Drawing it now…" with no draw_screen goes back, as words and as a reply', async () => {
  // As words with no tool call: the preamble path.
  const designBotCalls = [];
  const fakeDesignBot = { async draw(_pool, _config, args) { designBotCalls.push(args.ask); return { drawn: true }; } };
  const words = mayorTurn([
    EVANS_SECOND,
    { calls: [call('draw_screen', { what: 'The main screen of Ear Trainer, from its code', title: 'Main screen' })] },
  ], { designBot: fakeDesignBot });
  await words.run;
  assert.equal(words.seen.length, 2);
  assert.deepEqual(words.seen[1].slice(-1), [{ role: 'user', content: mayor.PREAMBLE_NOTE }]);

  // As a reply: the claim check's second pass tells it to call draw_screen.
  designBotCalls.length = 0;
  const replied = mayorTurn([
    { calls: [call('reply', { text: EVANS_SECOND })] },
    { calls: [call('draw_screen', { what: 'The main screen of Ear Trainer', title: 'Main screen' })] },
  ], { designBot: fakeDesignBot });
  const out = await replied.run;
  assert.deepEqual(out, { drawn: true }, 'the designer answers');
  assert.deepEqual(designBotCalls, [{ app: null, title: 'Main screen', brief: 'The main screen of Ear Trainer' }]);
  const note = replied.seen[1].at(-1);
  assert.equal(note.role, 'user');
  assert.match(note.content, /^\[Homeroom check, not from them: your reply says you are drawing a screen\./);
  assert.match(note.content, /you did not call draw_screen in this turn, so nothing is being drawn\. If they asked for a screen, call draw_screen now with what to draw and its title, and do not reply\. If you cannot, say so plainly\./);
  assert.deepEqual(replied.doings, [{ kind: 'drawing' }], 'and the card says it is drawing');
  assert.equal(replied.sent.length, 0, 'nothing of its own is said: the designer answers');

  // Still claimed after the second pass: cut, and said plainly.
  const stubborn = mayorTurn([
    { calls: [call('reply', { text: EVANS_SECOND })] },
    { calls: [call('reply', { text: EVANS_SECOND })] },
  ]);
  await stubborn.run;
  assert.equal(stubborn.sent.length, 1);
  assert.equal(stubborn.sent[0].content, 'I haven\'t drawn it yet. Ask me to draw it and I\'ll start on it.');
});

test('what counts as saying a screen is being drawn', () => {
  const claims = [EVANS_SECOND, 'I\'ll draw it now.', 'I\'m drawing the screen.', 'Rendering it now.', 'I\'m designing a calendar for you.',
    'Sure. Drawing the main screen next.', 'Let me sketch it.', 'I\'ll mock it up.'];
  for (const text of claims) assert.ok(mayor.DRAWING_CLAIM.test(text), text);
  const not = ['I can draw it if you like.', 'Want me to draw it?', 'I\'ll draw it once you tell me which project.',
    'The drawing is in the thread.', 'Here is how the screen is drawn in the code.', 'Let me know if I should draw it.',
    'Rendering the list as cards would fit the rest of the app better.'];
  for (const text of not) assert.ok(!mayor.DRAWING_CLAIM.test(text), text);
  const cut = mayor.stripClaims(`${EVANS_SECOND} It will match the rest of the app closely.`, [{ kind: 'drawing' }]);
  assert.equal(cut, 'I haven\'t drawn it yet. Ask me to draw it and I\'ll start on it.\n\nIt will match the rest of the app closely.');
});

// ── 3. The designer ──────────────────────────────────────────────────────

function designTurn(steps, { handoff = true, design = null, current = null } = {}) {
  const sent = [];
  const doings = [];
  const seen = [];
  const pool = { async query() { return { rows: [] }; } };
  const threads = {
    surfaceFor: () => 'new',
    validHtml: () => true,
    async versionOf() { return current; },
    async ensureDesign() { return { threadId: 7, title: 'Main screen', app: { slug: 'ear', name: 'Ear Trainer' } }; },
    async addVersion() { return { version: (current?.version || 0) + 1 }; },
    versionLine: (version, note) => `Version ${version} · ${note}`,
    async noteVersionMessage() {},
  };
  const deps = {
    chat: scripted(steps, seen), apiKey: 'sk-test', seesImages: false, sleep: async () => {},
    dm: { async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length }; } },
    mayor: Object.assign(Object.create(mayor), { async recordTurn() {}, async turnsLastHour() { return 0; } }),
    designThreads: threads,
    doing: async (what) => { doings.push(what); },
  };
  const run = designBot.answer(pool, {}, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live' },
    conversationId: 41,
    message: { id: 71, content: 'yep, can you do that? In the current thread?' },
    design,
    thread: { rootId: 500, threadId: 7, app: { id: 3, slug: 'ear', name: 'Ear Trainer' } },
    handoff,
    brief: handoff ? 'The main screen of Ear Trainer' : null,
    deps,
  });
  return { run, sent, doings, seen };
}

const SCREEN = { title: 'Main screen', size: 'phone', html: '<main class="keys">Keys</main>', note: 'The main screen' };

// 1 Nov 2026: drawn from Main Chat, in the thread it opens, the bot's typing
// (its working card) goes to that thread; asked in a thread, it is there.
test('a screen asked for in Main Chat moves the working card into the thread the designer opens', async () => {
  const run = async ({ threadRootId = null } = {}) => {
    const moved = [];
    const doings = [];
    const opened = [];
    const threads = {
      async draftingThread() { return { rootId: 500, threadId: 7, app: null }; },
      async openDrawThread(_pool, args) { opened.push(args.title); return { rootId: 640, threadId: 8, app: null }; },
      async designFor() { return null; },
    };
    await designBot.draw({ async query() { return { rows: [] }; } }, {}, {
      bot: { id: 2, username: 'homeroom_bot' },
      user: { id: 9, username: 'evan' },
      settings: { mode: 'off' },
      conversationId: 41,
      message: { id: 72, content: 'Draw the main screen of Ear Trainer' },
      ask: { app: null, title: 'Main screen', brief: 'The main screen' },
      deps: {
        threadRootId,
        designThreads: threads,
        dm: { async sendDm() { return { messageId: 901 }; } },
        mayor: Object.assign(Object.create(mayor), { async turnsLastHour() { return 0; } }),
        moveTyping: async (rootId) => { moved.push(rootId); },
        doing: async (what) => { doings.push(what); },
      },
    });
    return { moved, doings, opened };
  };
  const fromMain = await run();
  assert.deepEqual(fromMain.opened, ['Main screen']);
  assert.deepEqual(fromMain.moved, [640], 'to the thread it opened');
  assert.deepEqual(fromMain.doings, [{ kind: 'drawing' }], 'saying it draws there');
  const inThread = await run({ threadRootId: 500 });
  assert.deepEqual([inThread.opened, inThread.moved], [[], []], 'asked in a thread, the typing is there already');
  // A move that fails costs no drawing.
  const src = read('src/services/design-bot.js');
  assert.match(src, /if \(!inThread && typeof deps\.moveTyping === 'function'\) \{\n\s+try \{\n\s+await deps\.moveTyping\(room\.rootId\);/);
});

test('the designer goes on after Evan\'s "Drawing it now…" with nothing drawn, and draws', async () => {
  const turn = designTurn([
    EVANS_SECOND,
    { calls: [call('read_source', { path: 'public/index.html' })] },
    { calls: [call('write_screen', SCREEN), call('reply', { text: 'Here it is, in the app\'s own style.' })] },
  ]);
  await turn.run;
  assert.equal(turn.seen.length, 3);
  assert.deepEqual(turn.seen[1].slice(-2), [{ role: 'assistant', content: EVANS_SECOND }, { role: 'user', content: designBot.DRAW_NOTE }],
    'a drawing it did not make goes back with the note to draw');
  assert.equal(designBot.DRAW_NOTE, '[Homeroom check, not from them: you have not drawn anything yet. Call write_screen (or edit_design) now, then reply.]');
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, 'Version 1 · The main screen\n\nHere it is, in the app\'s own style.');
  assert.equal(turn.sent[0].metadata.kind, 'design_version');
  assert.deepEqual(turn.doings, [{ kind: 'code', project: 'Ear Trainer' }, { kind: 'drawing' }], 'reading its code, then drawing');
});

test('the designer\'s preamble gets the next-step note; a reply that asks leave to start is not the end', async () => {
  const preamble = designTurn([
    EVANS_FIRST,
    { calls: [call('write_screen', SCREEN)] },
    { calls: [call('reply', { text: 'Here it is.' })] },
  ]);
  await preamble.run;
  assert.deepEqual(preamble.seen[1].at(-1), { role: 'user', content: mayor.PREAMBLE_NOTE });
  assert.match(preamble.sent[0].content, /^Version 1 · The main screen/);

  const asks = designTurn([
    { calls: [call('reply', { text: 'I can draw it from the app\'s code. Want me to start that now?' })] },
    { calls: [call('write_screen', SCREEN), call('reply', { text: 'Here it is.' })] },
  ]);
  await asks.run;
  assert.deepEqual(asks.seen[1].at(-1), { role: 'user', content: designBot.DRAW_NOTE }, 'asked for it, so drawn');
  assert.match(asks.sent[0].content, /^Version 1 · The main screen/);
});

test('a real question back ends the designer\'s turn; words that still claim a drawing are not sent', async () => {
  const question = designTurn([
    { calls: [call('reply', { text: 'Which screen do you mean: the keys, or the score page?' })] },
  ]);
  await question.run;
  assert.equal(question.seen.length, 1, 'asked once, answered once');
  assert.equal(question.sent[0].content, 'Which screen do you mean: the keys, or the score page?');

  // In a thread that holds a design, an answer that draws nothing is fine.
  const current = { version: 2, html: '<main>Keys</main>' };
  const answer = designTurn([{ calls: [call('reply', { text: 'The keys use the kit\'s grid, 4 across.' })] }],
    { handoff: false, design: { rootId: 500, threadId: 7, state: 'open', latest: 2, title: 'Main screen', surface: 'new' }, current });
  await answer.run;
  assert.equal(answer.seen.length, 1);
  assert.equal(answer.sent[0].content, 'The keys use the kit\'s grid, 4 across.');

  const stubborn = designTurn([EVANS_SECOND]);
  await stubborn.run;
  assert.equal(stubborn.seen.length, 1 + 2, 'told twice, then it ends');
  assert.equal(stubborn.sent[0].content, designBot.NOT_DRAWN_TEXT, 'never sent as if it drew');
  assert.doesNotMatch(designBot.NOT_DRAWN_TEXT, /—/);
});

test('why words do not end a design turn yet', () => {
  const why = (text, opts = {}) => designBot.notDrawnYet(text, { mayor, ...opts });
  assert.equal(why(EVANS_FIRST), 'preamble');
  assert.equal(why(EVANS_SECOND), 'claimed');
  assert.equal(why('I\'ve changed the header to blue.'), 'claimed');
  assert.equal(why('Shall I draw it?'), 'asked');
  assert.equal(why('Here is what I would put on it: the keys, the score.', { handoff: true }), 'handoff');
  assert.equal(why('Which project is it for?', { handoff: true }), null, 'a real question');
  assert.equal(why(EVANS_SECOND, { changed: true }), null, 'it did draw');
  assert.equal(why('Want me to post it?', { offered: true }), null, 'an offer is under it');
  assert.equal(why('The header uses the kit\'s title style.'), null);
  // A thread with a screen already: talk about it is not a claim or a stall.
  assert.equal(why('I just changed the header to blue.'), 'claimed');
  assert.equal(why('In version 2 I made the header blue. Want it darker?', { drawnBefore: true }), null, 'a version before');
  assert.equal(why('Want me to make the title bigger?', { drawnBefore: true }), null, 'a suggestion, once there is a screen');
  assert.equal(why('Want me to start that now?', { drawnBefore: true, handoff: true }), 'asked', 'handed a screen to draw');
});

// ── 4. What it is doing, by tool ─────────────────────────────────────────

test('each tool says what the bot is doing, in kinds the screen words', () => {
  assert.deepEqual(mayor.doingFor('progress'), { kind: 'progress' });
  assert.deepEqual(mayor.doingFor('my_work'), { kind: 'progress' });
  assert.deepEqual(mayor.doingFor('request_detail', { project: 'ear', number: 12 }), { kind: 'request', number: 12 });
  assert.deepEqual(mayor.doingFor('get_request', { number: 4 }), { kind: 'request', number: 4 });
  assert.equal(mayor.doingFor('request_detail', {}), null);
  assert.deepEqual(mayor.doingFor('read_source', { project: 'ear' }, { project: 'Ear Trainer' }), { kind: 'code', project: 'Ear Trainer' });
  assert.deepEqual(mayor.doingFor('list_source', { project: 'secret' }), { kind: 'code' }, 'unnamed unless the caller knows its name');
  assert.deepEqual(mayor.doingFor('draw_screen', {}), { kind: 'drawing' });
  assert.deepEqual(mayor.doingFor('write_screen', {}), { kind: 'drawing' });
  assert.deepEqual(mayor.doingFor('edit_design', {}), { kind: 'designing' });
  assert.deepEqual(mayor.doingFor('offer_request', {}), { kind: 'drafting' });
  assert.equal(mayor.doingFor('comment_on_request', {}), null, 'thinking');
  assert.equal(mayor.doingFor('reply', {}), undefined, 'the end changes nothing');
  for (const what of [{ kind: 'progress' }, { kind: 'request', number: 1 }, { kind: 'code' }, { kind: 'drawing' }, { kind: 'designing' }, { kind: 'drafting' }]) {
    assert.ok(realDm.DOING_KINDS.includes(what.kind), what.kind);
  }
});

test('a project it reads is named only when the person can see it, and asked about once a turn', async () => {
  const said = [];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(String(sql));
      if (/FROM apps/.test(String(sql))) return { rows: params?.[0] === 'Ear Trainer' || params?.[0] === 'ear trainer' ? [{ id: 3, slug: 'ear', name: 'Ear Trainer', view_visibility: 'public' }] : [] };
      return { rows: [] };
    },
  };
  const ctx = { user: { id: 9 }, deps: { doing: async (what) => { said.push(what); } } };
  await mayor.sayDoing(pool, ctx, 'list_source', { project: 'Nope' });
  assert.deepEqual(said, [{ kind: 'code' }]);
  const before = queries.length;
  await mayor.sayDoing(pool, ctx, 'read_source', { project: 'Nope', path: 'a' });
  assert.equal(queries.length, before, 'once a turn');
  await mayor.sayDoing(pool, ctx, 'read_source', { project: 'Ear Trainer', path: 'a' });
  assert.deepEqual(said.at(-1), { kind: 'code', project: 'Ear Trainer' }, 'a public project they see, by its name');
  assert.ok(queries.some((sql) => /user_app_blocks/.test(sql)), 'after the check that they may see it');
  // One they blocked is not named.
  const blocked = { async query(sql) { return /FROM apps/.test(String(sql)) ? { rows: [{ id: 3, slug: 'ear', name: 'Ear Trainer', view_visibility: 'public' }] } : { rows: [{ app_id: 3 }] }; } };
  await mayor.sayDoing(blocked, { user: { id: 9 }, deps: ctx.deps }, 'read_source', { project: 'Ear Trainer', path: 'a' });
  assert.deepEqual(said.at(-1), { kind: 'code' });
  // Its failure costs the turn nothing.
  await mayor.sayDoing(pool, { user: { id: 9 }, deps: { doing: async () => { throw new Error('ws down'); } } }, 'progress', {});
  await mayor.sayDoing(pool, { user: { id: 9 }, deps: {} }, 'progress', {});
});

// ── 5. The prompt ────────────────────────────────────────────────────────

test('in a thread, "status?" is about that thread; a screen asked for is drawn in that turn', () => {
  const plus = mayor.systemPrompt({ username: 'evan', thread: { draft: { kind: 'ask', changeKind: 'design', appSlug: 'notes', appName: 'Notes' } } });
  const bare = mayor.systemPrompt({ username: 'evan', thread: { draft: null } });
  const rule = '- Here, "status?", "how is it going?" or "where are we?" means what they asked for in this thread: say what you\n'
    + '  are doing for it right now, or that nothing is under way yet and what happens next. Do not list the rest of\n'
    + '  their page (my_work) unless they ask about everything.';
  for (const prompt of [plus, bare]) {
    assert.ok(prompt.includes(`THIS CONVERSATION\n- They are writing in a thread of this chat, and the conversation below is that thread. Answer their newest\n  message here, in this thread.\n${rule}`));
  }
  assert.ok(plus.includes('When they want to see how a\n  screen could look, call draw_screen: it is drawn here, in this thread'), 'the "+" line is kept');
  const main = mayor.systemPrompt({ username: 'evan' });
  assert.ok(!main.includes(rule), 'Main Chat keeps "status?" as the whole page');
  assert.match(main, /For "where do things stand\?", "what needs me\?" or "status\?", call my_work/);
  const request = mayor.systemPrompt({ username: 'evan', request: { appSlug: 'ear', appName: 'Ear Trainer', issueNumber: 12, title: 'Bigger keys' } });
  assert.ok(request.includes('- Here, "status?", "how is it going?" or "where are we?" means this request: say where it stands right now,\n'
    + '  from request_detail or progress, and what happens next. Do not list the rest of their page (my_work) unless\n'
    + '  they ask about everything.'));
  for (const prompt of [plus, bare, main, request]) {
    assert.match(prompt, /\(draw_screen\): your designer draws it from their words/);
    assert.ok(prompt.includes('and do not reply: the designer answers them. When they have asked you to draw, render, show or mock up a\n'
      + '  screen, call draw_screen in that turn: never answer with what you are about to do, and never ask whether to\n  start it.'));
  }
  for (const line of [rule, 'never answer with what you are about to do, and never ask whether to']) assert.doesNotMatch(line, /—/);
});

// ── 6. The working card ──────────────────────────────────────────────────

globalThis.window = globalThis.window || {
  App: { user: { id: 9, username: 'evan' } },
  location: { search: '', hash: '#messages/41' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

test('the bot\'s typing is a card with its face, its name and what it is doing; people keep the line', () => {
  const card = loadTsx('frontend/src/features/messages/bot-working.tsx');
  const bot = { name: 'Homeroom bot', unnamed: false, bot: true, doing: null };
  const ada = { name: 'ada', unnamed: false };
  const html = renderToHtml(createElement(card.BotWorkingCard, { typist: bot }));
  assert.match(html, /<div class="flex items-start gap-3 px-4 py-1" data-bot-working="thinking"><img src="\/brand\/homeroom-mark\.png" alt="" class="w-9 h-9 text-xs rounded-xl object-cover shrink-0" data-bot-avatar=""\/>/,
    'the face its rows wear (UserAvatar md square), then the card');
  assert.match(html, /rounded-\[20px\] bg-\[color:var\(--messages-surface\)\][^"]*shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/, 'the bubble\'s surface, one hairline');
  assert.match(html, /<div class="truncate text-\[0\.9375rem\] font-\[650\] leading-5 text-zinc-900 dark:text-zinc-100">Homeroom bot<\/div>/, '15 at 650');
  assert.match(html, /<div class="mt-0\.5 flex min-w-0 items-center text-\[0\.8125rem\] leading-\[1\.125rem\] text-zinc-500 dark:text-zinc-400"><span class="min-w-0 truncate" data-bot-working-doing="">Thinking<\/span><span class="[^"]*" aria-hidden="true" data-working-dots="">/, 'over 13, muted, and the dots');
  assert.equal((html.match(/motion-safe:animate-pulse/g) || []).length, 3, 'three dots, still under reduced motion');
  assert.doesNotMatch(html, /gray-|indigo-|uppercase/);
  const drawing = renderToHtml(createElement(card.BotWorkingCard, { typist: { ...bot, doing: { kind: 'drawing' } } }));
  assert.match(drawing, /data-bot-working="drawing"/);
  assert.match(drawing, />Drawing the screen</);

  const t = catalog;
  assert.equal(card.botDoingLine(t, null), 'Thinking');
  assert.equal(card.botDoingLine(t, { kind: 'progress' }), 'Checking how your work is going');
  assert.equal(card.botDoingLine(t, { kind: 'request', number: 12 }), 'Reading request #12');
  assert.equal(card.botDoingLine(t, { kind: 'code', project: 'Ear Trainer' }), 'Reading Ear Trainer\'s code');
  assert.equal(card.botDoingLine(t, { kind: 'code' }), 'Reading the code');
  assert.equal(card.botDoingLine(t, { kind: 'drawing' }), 'Drawing the screen');
  assert.equal(card.botDoingLine(t, { kind: 'designing' }), 'Changing the design');
  assert.equal(card.botDoingLine(t, { kind: 'drafting' }), 'Drafting the request');
  assert.equal(card.botDoingLine(t, { kind: 'something_new' }), 'Thinking', 'a kind this screen does not know yet');

  // The bot leaves the line to people; a person is never a card.
  assert.equal(card.workingBot([ada, bot]), bot);
  assert.equal(card.workingBot([ada]), null);
  assert.deepEqual(card.typingBesides([ada, bot], bot), [ada]);
  const { typingLine } = loadTsx('frontend/src/features/messages/typing-line.ts');
  assert.equal(typingLine(t, card.typingBesides([ada, bot], bot)), 'ada is typing…');
  assert.equal(typingLine(t, card.typingBesides([bot], card.workingBot([bot]))), '', 'the bot alone: no line');
  assert.equal(typingLine(t, card.typingBesides([bot], null)), 'Homeroom bot is typing…', 'a window part-way back keeps the line');
});

test('the card ends the transcript where the answer lands, in Main Chat and in a thread, inside the scroller', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const typists = conversationId \? typingUsers\(conversationId\) : \[\];\n\s+const working = snap\.nextAfter \? null : workingBot\(typists\);\n\s+const typing = typingBesides\(typists, working\);/);
  assert.match(screen, /\{rows\}\n\s+\{working \? <BotWorkingCard typist=\{working\} \/> : null\}\n\s+\{\/\* #2387: a message link opened the transcript part-way back\. \*\/\}/);
  assert.match(screen, /const threadWorking = workingBot\(threadTypists\);\n\s+const threadTyping = typingBesides\(threadTypists, threadWorking\);/);
  assert.match(screen, /\}\)\}\n\s+\{threadWorking \? <BotWorkingCard typist=\{threadWorking\} \/> : null\}\n\s+\{privateRoot && privateMine && root \? \(/);
  // The foot is as #6091 left it: the status line still follows Jump to latest.
  assert.match(screen, /<\/TranscriptOverlay>\n\s*<ChatStatusLine className="messages-typing">\{typingLine\(t, typing\)\}<\/ChatStatusLine>\n\s*<MessageComposer \/>/);
  assert.match(screen, /<ChatStatusLine className="messages-typing">\{typingLine\(t, threadTyping\)\}<\/ChatStatusLine>\n\s*<MessageComposer threadRootId=\{rootId\} \/>/);
  // An island's first render is the empty transcript: the card waits for the store.
  const card = read('frontend/src/features/messages/bot-working.tsx');
  assert.doesNotMatch(card, /useEffect|fetch\(/);
  for (const key of ['thinking', 'progress', 'request', 'code', 'codeUnnamed', 'drawing', 'designing', 'drafting']) {
    assert.doesNotMatch(catalog(`messages:thread.botWorking.${key}`, { number: 1, project: 'P' }), /—|…/, key);
  }
});
