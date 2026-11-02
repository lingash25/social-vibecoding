'use strict';

// Homeroom bot parity, P2: cards the bot composes under a reply.
//
//   offer_options  2 to 4 ways to do something: Show and Pick, a pick said on every device
//   ask_questions  1 to 4 questions answered together: chips, Other, Send answers, You decide
//   show_table     2 to 4 columns, up to 12 rows: a row about a request links to it, a tag, buttons
//
// Pinned here, without a database: what the model may pass and how it is
// clipped (a bad call is an error it can fix), the cards' taps on the
// server, how a card reads back in the model's history, a turn that puts
// one under its reply, and the three cards as the Messages screen draws them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cards = require('../src/services/homeroom-bot-thread-tools/cards');
const threadTools = require('../src/services/homeroom-bot-thread-tools');
const cardTaps = require('../src/services/homeroom-bot-cards');
const optionsTap = require('../src/services/homeroom-bot-cards/options');
const questionsTap = require('../src/services/homeroom-bot-cards/questions');
const tableTap = require('../src/services/homeroom-bot-cards/table');
const mayor = require('../src/services/homeroom-bot-mayor');
const realDm = require('../src/services/homeroom-bot-dm');
const { message: catalog } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EM = String.fromCharCode(0x2014);

// ── What the model may pass ──────────────────────────────────────────────

test('offer_options: two to four options, lettered, clipped, no em dash; fewer is an error to fix', () => {
  const made = cards.cardFromOptions({
    title: `Ways to add reminders ${EM} quickly`,
    options: [
      { title: 'Push notifications', detail: 'A ping on their phone at the time they pick.' },
      { title: 'Email', detail: '' },
      'A calendar file',
      { title: '   ' },
      { title: 'x'.repeat(300), detail: 'y'.repeat(900) },
      { title: 'Fifth' },
    ],
  });
  assert.equal(made.error, undefined);
  const { card } = made;
  assert.equal(card.type, 'options');
  assert.equal(card.v, 1);
  assert.equal(card.title, 'Ways to add reminders: quickly', 'no em dash');
  assert.deepEqual(card.options.map((o) => o.key), ['A', 'B', 'C', 'D']);
  assert.deepEqual(card.options[0], { key: 'A', title: 'Push notifications', detail: 'A ping on their phone at the time they pick.' });
  assert.deepEqual(card.options[1], { key: 'B', title: 'Email' }, 'no empty detail');
  assert.equal(card.options[2].title, 'A calendar file');
  assert.equal(card.options[3].title.length, cards.LIMITS.optionTitle);
  assert.ok(card.options[3].title.endsWith('…'));
  assert.equal(card.options[3].detail.length, cards.LIMITS.optionDetail);
  assert.equal(card.picked, null);
  assert.match(made.notes.join(' '), /Only the first 4 options are shown/);
  assert.match(cards.cardFromOptions({ options: [{ title: 'Only one' }] }).error, /needs 2 to 4 options/);
  assert.match(cards.cardFromOptions({}).error, /Nothing was shown/);
  assert.equal(cards.words('a\u0000b\n\tc  <b>', 20), 'a b c <b>', 'one line; markup stays text for the client to escape');
});

test('ask_questions: one to four questions, two to four answers each, a guess in range', () => {
  const made = cards.cardFromQuestions({
    questions: [
      { question: 'Who is it for?', answers: ['Just me', 'My team', 'Just me', 'Anyone'], guess: 1 },
      { question: 'When should it remind them?', answers: ['Morning', 'Evening'], guess: 7 },
      { question: '', answers: ['a', 'b'] },
      { question: 'Q3', answers: ['a', 'b'] },
      { question: 'Q4', answers: ['a', 'b', 'c', 'd', 'e'] },
      { question: 'Q5', answers: ['a', 'b'] },
    ],
  });
  const { card } = made;
  assert.equal(card.type, 'questions');
  assert.equal(card.questions.length, 4);
  assert.deepEqual(card.questions[0], { question: 'Who is it for?', answers: ['Just me', 'My team', 'Anyone'], guess: 1 }, 'an answer once');
  assert.deepEqual(card.questions[1], { question: 'When should it remind them?', answers: ['Morning', 'Evening'] }, 'a guess out of range is left out');
  assert.equal(card.questions[3].answers.length, 4);
  assert.equal(card.answered, null);
  assert.match(made.notes.join(' '), /Only the first 4 questions are shown/);
  assert.match(cards.cardFromQuestions({ questions: [{ question: 'Colour?', answers: ['Blue'] }] }).error,
    /Each question needs 2 to 4 short suggested answers \("Colour\?" has 1\)/);
  assert.match(cards.cardFromQuestions({ questions: [] }).error, /needs 1 to 4 questions/);
});

test('show_table: two to four columns, up to twelve rows, a tag of four, a request linked by project and number', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ cells: [`Row ${i + 1}`, 'Waiting', 'extra', 'more', 'cut'], tag: i % 2 ? 'ready' : 'Unknown' }));
  rows[0] = { cells: ['Dark mode'], tag: 'READY', project: 'Gym Tracker', number: 12 };
  rows[1] = { cells: ['', ''] };
  const made = cards.cardFromTable({
    title: 'Your requests', columns: ['Request', 'Where it is', 'Who', 'When', 'Fifth'], rows, more: 3,
    actions: [{ label: 'Build the ready ones', say: 'Build the ready ones now' }, { label: 'Build the ready ones', say: 'again' }, { label: 'Skip', say: '' }, { label: 'Third' }, { label: 'Fourth', say: 'x' }],
  });
  const { card } = made;
  assert.equal(card.type, 'table');
  assert.deepEqual(card.columns, ['Request', 'Where it is', 'Who', 'When']);
  assert.equal(card.rows.length, 12);
  assert.deepEqual(card.rows[0], { cells: ['Dark mode', '', '', ''], tag: 'ready', project: 'Gym Tracker', number: 12 });
  assert.equal(card.rows[1].cells[0], 'Row 3', 'an empty row is left out');
  assert.equal(card.rows[1].tag, undefined, 'a tag that is not one of the four is left out');
  assert.equal(card.rows[2].tag, 'ready');
  assert.ok(card.more >= 2);
  assert.deepEqual(card.actions, [
    { label: 'Build the ready ones', say: 'Build the ready ones now' },
    { label: 'Skip', say: 'Skip' },
    { label: 'Third', say: 'Third' },
  ]);
  assert.match(made.notes.join(' '), /Only the first 4 columns are shown/);
  assert.match(made.notes.join(' '), /Only 12 rows are shown/);
  assert.match(cards.cardFromTable({ columns: ['One'], rows: [{ cells: ['a'] }] }).error, /needs 2 to 4 columns/);
  assert.match(cards.cardFromTable({ columns: ['A', ''], rows: [{ cells: ['a'] }] }).error, /each with a short heading/);
  assert.match(cards.cardFromTable({ columns: ['A', 'B'], rows: [] }).error, /at least one row/);
  assert.deepEqual(cards.cardFromTable({ columns: ['A', 'B'], rows: [['a', 'b']] }).card.rows, [{ cells: ['a', 'b'] }], 'a row may be its cells');
  assert.equal(cards.cardFromTable({ columns: ['A', 'B'], rows: [{ cells: ['a'], project: 'p', number: -3 }] }).card.rows[0].project, undefined);
});

test('the tools: offered every turn, strict schemas, and a call that cannot make a card says what to fix', async () => {
  const names = cards.tools({}).map((t) => t.function.name);
  assert.deepEqual(names, ['offer_options', 'ask_questions', 'show_table']);
  for (const tool of cards.TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.ok(tool.function.description.length < 600);
    assert.doesNotMatch(tool.function.description, new RegExp(EM));
  }
  const offered = threadTools.toolsFor({ deps: {} }).map((t) => t.function.name);
  for (const name of names) assert.ok(offered.includes(name), name);
  assert.ok(!mayor.TOOLS.some((t) => names.includes(t.function.name)), 'no clash with the bot\'s own tools');

  const ctx = { user: { id: 9 }, deps: {}, appIds: new Set() };
  assert.equal(await cards.run({}, ctx, 'reply', {}), undefined, 'not its tool');
  assert.deepEqual(await cards.run({}, ctx, 'offer_options', { options: [] }), {
    ok: false, error: 'offer_options needs 2 to 4 options, each with a short title. Nothing was shown.',
  });
  assert.equal(ctx.card, undefined);
  const out = await cards.run({}, ctx, 'offer_options', { options: [{ title: 'A way' }, { title: 'Another' }] });
  assert.equal(out.ok, true);
  assert.match(out.shown, /do not list the options again/);
  assert.equal(ctx.card.type, 'options');
  const again = await cards.run({}, ctx, 'ask_questions', { questions: [{ question: 'Sure?', answers: ['Yes', 'No'] }] });
  assert.match(again.note, /It replaces the card you put under this reply before: one card per reply\./);
  assert.equal(ctx.card.type, 'questions', 'the later wins');

  const lines = cards.promptLines(ctx).join('\n');
  assert.match(lines, /\(offer_options: 2 to 4/);
  assert.match(lines, /\(ask_questions: up to 4/);
  assert.match(lines, /\(show_table: 2 to 4 columns, up to 12 rows/);
  assert.doesNotMatch(lines, new RegExp(EM));
});

test('a table\'s rows about requests link only to a project the person can see', async () => {
  const asked = [];
  const fakeMayor = {
    async findApp(_pool, name) { asked.push(name); return name === 'Gym Tracker' ? { id: 3, slug: 'gym-3f2a1c', name: 'Gym Tracker' } : name === 'Secret' ? { id: 4, slug: 'secret', name: 'Secret' } : null; },
    async canView(_pool, app) { return app.slug !== 'secret'; },
  };
  const ctx = { user: { id: 9 }, deps: { mayor: fakeMayor }, appIds: new Set() };
  await cards.run({}, ctx, 'show_table', {
    columns: ['Request', 'Where'],
    rows: [
      { cells: ['Dark mode', 'Ready to build'], tag: 'ready', project: 'Gym Tracker', number: 12 },
      { cells: ['Streaks', 'Waiting on you'], tag: 'question', project: 'Gym Tracker', number: 14 },
      { cells: ['Hidden', 'x'], project: 'Secret', number: 2 },
      { cells: ['Gone', 'x'], project: 'Nope', number: 1 },
    ],
  });
  assert.deepEqual(ctx.card.rows[0], { cells: ['Dark mode', 'Ready to build'], tag: 'ready', appSlug: 'gym-3f2a1c', appName: 'Gym Tracker', number: 12 });
  assert.equal(ctx.card.rows[1].appSlug, 'gym-3f2a1c');
  assert.deepEqual(ctx.card.rows[2], { cells: ['Hidden', 'x'] }, 'a project they cannot see: its words, no link, not even its name');
  assert.deepEqual(ctx.card.rows[3], { cells: ['Gone', 'x'] });
  assert.deepEqual(asked, ['Gym Tracker', 'Secret', 'Nope'], 'each project looked up once');
  assert.ok(ctx.appIds.has(3), 'its request numbers are known to the reply check');
});

// ── Taps, decided on the server ──────────────────────────────────────────

const OPTIONS = cards.cardFromOptions({ title: 'Reminders', options: [{ title: 'Push', detail: 'A ping' }, { title: 'Email' }] }).card;
const QUESTIONS = cards.cardFromQuestions({ questions: [{ question: 'For whom?', answers: ['Me', 'Team'], guess: 0 }, { question: 'When?', answers: ['Morning', 'Evening'] }] }).card;

test('Pick is decided once, and says which on every device', async () => {
  const picked = await optionsTap.decide(null, {}, { card: OPTIONS, action: 'pick', value: 'b' });
  assert.equal(picked.ok, true);
  assert.equal(picked.picked, 'B');
  assert.equal(picked.patch.picked, 'B');
  assert.ok(Date.parse(picked.patch.pickedAt));
  assert.deepEqual(await optionsTap.decide(null, {}, { card: { ...OPTIONS, picked: 'A' }, action: 'pick', value: 'B' }),
    { ok: true, picked: 'A', already: true }, 'picked already elsewhere: nothing new is said');
  assert.deepEqual(await optionsTap.decide(null, {}, { card: OPTIONS, action: 'pick', value: 'E' }), { ok: false, status: 400, error: 'No such option' });
  assert.equal((await optionsTap.decide(null, {}, { card: OPTIONS, action: 'build', value: 'A' })).ok, false);
});

test('Send answers and You decide are decided once, as the questions\' answers', async () => {
  const sent = await questionsTap.decide(null, {}, { card: QUESTIONS, action: 'answer', value: [' Me ', 'Every   evening'] });
  assert.deepEqual(sent.answered, ['Me', 'Every evening']);
  assert.deepEqual(sent.patch.answered, ['Me', 'Every evening']);
  assert.deepEqual(await questionsTap.decide(null, {}, { card: QUESTIONS, action: 'answer', value: ['Me'] }),
    { ok: false, status: 400, error: 'Answer each question first' });
  assert.equal((await questionsTap.decide(null, {}, { card: QUESTIONS, action: 'answer', value: ['Me', ''] })).ok, false);
  const skipped = await questionsTap.decide(null, {}, { card: QUESTIONS, action: 'skip' });
  assert.equal(skipped.patch.skipped, true);
  assert.deepEqual(await questionsTap.decide(null, {}, { card: { ...QUESTIONS, answered: ['Team', 'Morning'] }, action: 'skip' }),
    { ok: true, already: true, answered: ['Team', 'Morning'] });
  assert.equal(questionsTap.answersFor(QUESTIONS, ['a'.repeat(500), 'b'])[0].length, questionsTap.MAX_ANSWER_CHARS);
  assert.equal((await tableTap.decide()).ok, false, 'a table decides nothing: its buttons say words');
});

test('a tap reaches its card\'s handler through the route\'s service, and the card changes on every tab', async () => {
  const queries = [];
  const stored = { homeroomBot: { kind: 'chat', card: OPTIONS } };
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      queries.push(text);
      if (/JOIN conversation_members cm/.test(text)) {
        return { rows: [{ id: 901, conversation_id: 41, sender_id: 2, thread_root_id: null, metadata: stored, is_synthetic: true }] };
      }
      if (/SELECT metadata, conversation_id, sender_id, thread_root_id FROM conversation_messages/.test(text)) {
        return { rows: [{ metadata: stored, conversation_id: 41, sender_id: 2, thread_root_id: null }] };
      }
      if (/UPDATE conversation_messages/.test(text)) {
        stored.written = JSON.parse(params[1]);
        return { rows: [{ id: 901 }], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  const pushed = [];
  const ws = { pushConversationEvent: (to, event) => pushed.push({ to, event }) };
  const out = await cardTaps.decide(pool, {}, { user: { id: 9 }, messageId: '901', action: 'pick', value: 'A', deps: { ws } });
  assert.deepEqual(out, { ok: true, picked: 'A' });
  assert.equal(stored.written.homeroomBot.card.picked, 'A');
  assert.deepEqual(stored.written.homeroomBot.card.options, OPTIONS.options, 'the rest of the card is kept');
  assert.equal(pushed[0].event.type, 'conversation_message_updated');
  assert.deepEqual(pushed[0].to, [2, 9]);
  const refused = await cardTaps.decide(pool, {}, { user: { id: 9 }, messageId: 901, action: 'pick', value: 'Z', deps: { ws } });
  assert.deepEqual(refused, { ok: false, status: 400, error: 'No such option' });
});

test('a card reads back in the model\'s history: what it offered, and what they picked or answered', async () => {
  assert.equal(cardTaps.historyLine({ ...OPTIONS, picked: 'B' }),
    '[Homeroom: under this reply you offered options for "Reminders": A. Push (A ping); B. Email. They picked B.]');
  assert.equal(cardTaps.historyLine({ ...QUESTIONS, answered: ['Team', 'Morning'] }),
    '[Homeroom: under this reply you asked these questions: 1. For whom? (suggested: Me / Team, your guess: Me) 2. When? (suggested: Morning / Evening) They answered: 1. Team 2. Morning.]');
  assert.match(cardTaps.historyLine({ ...QUESTIONS, skipped: true }), /They left it to you to decide\.\]$/);
  const table = { type: 'table', columns: ['Request', 'Where'], rows: [{ cells: ['Dark mode', 'Ready'], tag: 'ready', appSlug: 'gym', appName: 'Gym Tracker', number: 12 }], more: 2, actions: [{ label: 'Build them', say: 'Build them' }] };
  assert.equal(cardTaps.historyLine(table),
    '[Homeroom: under this reply you showed a table: Request | Where; Dark mode | Ready (ready) [Gym Tracker request #12]. And 2 more. Its buttons: "Build them".]');
  assert.equal(cardTaps.historyLine({ type: 'something_new' }), null);
  assert.equal(cardTaps.historyLine(null), null);
  const long = cardTaps.historyLine({ type: 'table', columns: ['A', 'B'], rows: Array.from({ length: 12 }, () => ({ cells: ['x'.repeat(140), 'y'.repeat(140)] })) });
  assert.ok(long.length <= 1500 && long.endsWith('…]'));

  // In the history the turn reads.
  const rows = [
    { id: 12, sender_id: 9, content: 'B: Email', metadata: null },
    { id: 11, sender_id: 2, content: 'A few ways to do it:', metadata: { homeroomBot: { kind: 'chat', card: { ...OPTIONS, picked: 'B' } } } },
    { id: 10, sender_id: 9, content: 'How could reminders work?', metadata: null },
  ];
  const pool = { async query(sql) { return /FROM conversation_messages\s+WHERE conversation_id = \$1 AND id <= \$2/.test(String(sql)) ? { rows: rows.map((r) => ({ ...r })) } : { rows: [] }; } };
  const history = await mayor.historyMessages(pool, { conversationId: 41, botId: 2, upToId: 12 });
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(history[1].content, 'A few ways to do it:\n[Homeroom: under this reply you offered options for "Reminders": A. Push (A ping); B. Email. They picked B.]');
});

// ── A turn that puts a card under its reply ──────────────────────────────

const callOf = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('a turn offers the card tools, says how in its prompt, and sends the card as the reply\'s metadata', async () => {
  const seen = [];
  const steps = [
    { calls: [callOf('c1', 'offer_options', { title: 'Ways to add reminders', options: [{ title: 'Push', detail: 'A ping' }, { title: 'Email' }] })] },
    { calls: [callOf('c2', 'reply', { text: 'Here are two ways to do it.' })] },
  ];
  const sent = [];
  await mayor.runDmTurn({ async query() { return { rows: [] }; } }, {}, {
    bot: { id: 2, username: 'homeroom_bot' }, user: { id: 9, username: 'evan' }, settings: { mode: 'live', perPerson: 2 },
    conversationId: 41, message: { id: 70, content: 'What are some ways to add reminders?' },
    deps: {
      chat: async (req) => { seen.push(req); return { content: '', toolCalls: steps[seen.length - 1].calls }; },
      apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
      dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 901, conversationId: 41 }; } },
    },
  });
  const offered = seen[0].tools.map((t) => t.function.name);
  for (const name of ['offer_options', 'ask_questions', 'show_table']) assert.ok(offered.includes(name), name);
  assert.ok(offered.indexOf('offer_options') > offered.indexOf('reply'), 'after the bot\'s own tools');
  const prompt = seen[0].messages[0].content;
  assert.ok(prompt.indexOf('(offer_options: 2 to 4') > prompt.indexOf('In this chat you can:'));
  assert.ok(prompt.indexOf('(offer_options: 2 to 4') < prompt.indexOf('Finish every turn by calling reply'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'Here are two ways to do it.');
  assert.deepEqual(sent[0].metadata.card, {
    type: 'options', v: 1, title: 'Ways to add reminders',
    options: [{ key: 'A', title: 'Push', detail: 'A ping' }, { key: 'B', title: 'Email' }], picked: null,
  });
});

// ── The cards on the Messages screen ─────────────────────────────────────

globalThis.window = globalThis.window || {
  App: { user: { id: 9, username: 'evan' } },
  location: { search: '', hash: '#messages/41' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const botMessage = (card) => ({
  id: 901, conversationId: 41, content: 'Here are two ways.', createdAt: '2026-11-01T12:00:00.000Z', deleted: false,
  sender: { id: 2, username: 'homeroom_bot', bot: true }, attachments: [], objects: [], reactions: [],
  metadata: { homeroomBot: { kind: 'chat', card } },
});

function draw(file, name, card) {
  const mod = loadTsx(`frontend/src/features/messages/bot-cards/${file}`);
  return { mod, html: renderToHtml(createElement(mod[name], { message: botMessage(card), conversationId: 41, card })) };
}

function shared(html) {
  assert.match(html, /<section class="mt-1 w-\[520px\] max-w-full rounded-\[20px\] bg-\[color:var\(--messages-surface\)\] px-4 py-3 shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]"/,
    'the bubble\'s surface, one hairline, never wider than the row');
  assert.doesNotMatch(html, /gray-|indigo-|—/);
  assert.doesNotMatch(html, /messages:botCards/, 'every id is in the catalog');
}

test('the options card: a row per option with Show and Pick; once picked, grey with a check and no buttons', () => {
  const card = { ...OPTIONS, options: [...OPTIONS.options, { key: 'C', title: '<img src=x onerror=alert(1)>' }] };
  const { mod, html } = draw('options.tsx', 'OptionsCard', card);
  shared(html);
  assert.match(html, /data-bot-card-state="open"/);
  assert.match(html, /<h3 class="text-\[0\.75rem\] font-bold uppercase leading-4 tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400">Options<\/h3>/, 'small caps');
  assert.match(html, />Reminders</, 'the title, a sentence');
  assert.equal((html.match(/data-bot-option="/g) || []).length, 3);
  assert.match(html, /<p class="text-\[0\.9375rem\] font-\[650\] leading-5[^"]*">Push<\/p><p class="mt-0\.5 text-\[0\.8125rem\][^"]*text-zinc-500[^"]*">A ping<\/p>/, '15 at 650 over 13, muted');
  assert.match(html, /aria-label="Show option A: Push"[^>]*>Show<\/button>/);
  assert.match(html, /aria-label="Pick option B: Email"[^>]*>Pick<\/button>/);
  assert.match(html, /min-h-\[44px\][^"]*sm:min-h-\[36px\]/, 'a phone\'s touch target');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the model\'s words are text');
  assert.doesNotMatch(html, /<img src=x/);

  const picked = draw('options.tsx', 'OptionsCard', { ...card, picked: 'B' }).html;
  shared(picked);
  assert.match(picked, /data-bot-card-state="picked"/);
  assert.doesNotMatch(picked, />Pick<\/button>|>Show<\/button>/);
  assert.match(picked, /data-bot-option="B" data-bot-option-picked=""/);
  assert.match(picked, /role="status" data-bot-option-chosen=""><svg[^>]*>[^]*?<\/svg><span>Picked<\/span>/);
  assert.match(picked, /class="flex items-start gap-3 py-2\.5 opacity-60" data-bot-option="A"/, 'the others step back');
  assert.doesNotMatch(picked, /data-bot-option-chosen=""[^>]*bg-/, 'a settled pick gets no fill');

  assert.deepEqual(mod.optionsOf({ options: [{ key: 'a', title: 'x' }, { key: 'A', title: 'dup' }, { key: 'Q', title: 'y' }, 'z', { key: 'B', title: '' }] }), [{ key: 'A', title: 'x', detail: '' }]);
  assert.equal(draw('options.tsx', 'OptionsCard', { type: 'options', options: [{ key: 'A', title: 'one' }] }).html, '', 'one option draws nothing');
  assert.equal(catalog('messages:botCards.options.pickSay', { key: 'B', title: 'Email' }), 'B: Email');
  assert.equal(catalog('messages:botCards.options.showSay', { key: 'B', title: 'Email' }), 'Show me option B: Email');
});

test('the questions card: numbered, chips with the guess picked, an Other field, Send answers and You decide; answered, read-only', () => {
  const { mod, html } = draw('questions.tsx', 'QuestionsCard', QUESTIONS);
  shared(html);
  assert.match(html, />Questions<\/h3>/);
  assert.match(html, /<ol class="mt-2 flex list-decimal flex-col gap-3 ps-5/);
  assert.equal((html.match(/data-bot-question-row="/g) || []).length, 2);
  assert.match(html, /aria-pressed="true" data-bot-question-answer="guess"><svg[^>]*>[^]*?<\/svg><span[^>]*>Me<\/span><span[^>]*>suggested<\/span>/, 'the guess picked, with its check');
  assert.match(html, /bg-\[color:var\(--lit-tint\)\][^"]*text-\[color:var\(--lit-ink\)\][^"]*" aria-pressed="true"/, 'in the lit tint');
  assert.match(html, /placeholder="Other…" aria-label="Your own answer to question 2"/);
  assert.match(html, /disabled="" data-bot-questions-send="">Send answers<\/button>/, 'question 2 has no answer yet');
  assert.match(html, /data-bot-questions-skip="">You decide<\/button>/);
  const guessed = draw('questions.tsx', 'QuestionsCard', { ...QUESTIONS, questions: QUESTIONS.questions.map((q) => ({ ...q, guess: 1 })) }).html;
  assert.doesNotMatch(guessed, /disabled="" data-bot-questions-send/, 'every question has its guess: ready to send');

  const answered = draw('questions.tsx', 'QuestionsCard', { ...QUESTIONS, answered: ['Team', 'Every evening'] }).html;
  shared(answered);
  assert.match(answered, /data-bot-card-state="answered"/);
  assert.match(answered, /<dt class="messages-bot-choice-label">For whom\?<\/dt><dd><span class="messages-bot-chosen">Team<\/span><\/dd>/, 'as the two-questions card reads once answered');
  assert.doesNotMatch(answered, /<button|<input/);
  const skipped = draw('questions.tsx', 'QuestionsCard', { ...QUESTIONS, skipped: true }).html;
  assert.match(skipped, /data-bot-questions-skipped=""><svg[^>]*>[^]*?<\/svg><span>You left these to Homeroom bot\.<\/span>/);

  assert.deepEqual(mod.chosenAnswers(mod.questionsOf(QUESTIONS), [1, 'own'], ['', '  After   lunch ']), ['Team', 'After lunch']);
  assert.equal(mod.chosenAnswers(mod.questionsOf(QUESTIONS), [0, null], ['', '']), null);
  assert.equal(catalog('messages:botCards.questions.answerLine', { number: 2, answer: 'Evening' }), '2. Evening');
  assert.equal(mod.questionsOf({ questions: [{ question: 'Only one answer', answers: ['a'] }] }).length, 0);
});

test('the table card: headings, rows 15 over 13, one tag a row, a request\'s row links to it, more and buttons', () => {
  const card = {
    type: 'table', v: 1, title: 'Your requests', columns: ['Request', 'Where it is'],
    rows: [
      { cells: ['Dark mode', 'Ready to build'], tag: 'ready', appSlug: 'gym-3f2a1c', appName: 'Gym Tracker', number: 12 },
      { cells: ['Streaks', 'Waiting on your answer'], tag: 'question' },
      { cells: ['Export', 'Live'], tag: 'done' },
      { cells: ['<script>x</script>', 'Stopped at checks'], tag: 'stopped' },
    ],
    more: 4,
    actions: [{ label: 'Build the ready ones', say: 'Build the ready ones' }, { label: 'Answer the question', say: 'What was the question?' }],
  };
  const { mod, html } = draw('table.tsx', 'TableCard', card);
  shared(html);
  assert.match(html, />Your requests</);
  assert.match(html, /<div class="-mx-4 mt-1 overflow-x-auto px-4"><table/, 'a wide table scrolls inside the card');
  assert.match(html, /<th scope="col" class="whitespace-nowrap py-1\.5 pe-3 text-\[0\.75rem\] font-semibold[^"]*">Request<\/th>/);
  assert.match(html, /<a href="#app\/gym-3f2a1c\/dev\/issues\/12"[^>]*data-bot-table-request="gym-3f2a1c#12"[^>]*>Dark mode<\/a>/);
  assert.match(html, /title="Open Gym Tracker request #12"/);
  assert.match(html, /<th scope="row" class="py-2 pe-3 text-\[0\.9375rem\] font-\[650\][^"]*">Streaks<\/th><td class="py-2 pe-3 text-\[0\.8125rem\][^"]*text-zinc-500/);
  assert.match(html, /rounded-full px-1\.5 py-0\.5[^"]* bg-violet-500\/10 text-violet-700[^"]*" data-bot-table-tag="ready">Ready</, 'ready in the blue accent');
  assert.match(html, /bg-amber-500\/10 text-amber-800[^"]*" data-bot-table-tag="question">Question</);
  assert.match(html, /bg-zinc-500\/10 text-zinc-600[^"]*" data-bot-table-tag="done">Done</);
  assert.match(html, /data-bot-table-tag="stopped">Stopped</);
  assert.equal((html.match(/data-bot-table-tag=/g) || []).length, 4, 'one tag a row');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /data-bot-table-more="">And 4 more<\/p>/);
  assert.match(html, /data-bot-table-action="1">Build the ready ones<\/button>/);
  assert.match(html, /data-bot-table-action="2">Answer the question<\/button>/);
  assert.equal((html.match(/<a /g) || []).length, 1, 'only a linked row is a link');

  assert.deepEqual(mod.tableOf({ columns: ['A', 'B', 'C', 'D', 'E'], rows: [{ cells: ['x'], tag: 'nope', appSlug: 'gym', number: 0 }] }).rows,
    [{ cells: ['x', '', '', ''], tag: null, appSlug: null, appName: null, number: null }]);
  assert.equal(draw('table.tsx', 'TableCard', { type: 'table', columns: ['A'], rows: [{ cells: ['x'] }] }).html, '', 'one column draws nothing');
  const plain = draw('table.tsx', 'TableCard', { type: 'table', columns: ['A', 'B'], rows: [{ cells: ['x', 'y'] }] }).html;
  assert.doesNotMatch(plain, /data-bot-table-tag|data-bot-table-more|<button/, 'zero says nothing');
});

test('the cards are registered by type, and every word they show is in the catalog', () => {
  const registry = read('frontend/src/features/messages/bot-cards/registry.ts');
  assert.match(registry, /options: OptionsCard, \/\/ P2/);
  assert.match(registry, /questions: QuestionsCard, \/\/ P2/);
  assert.match(registry, /table: TableCard, \/\/ P2/);
  for (const file of ['options.tsx', 'questions.tsx', 'table.tsx', 'card-ui.tsx']) {
    const src = read(`frontend/src/features/messages/bot-cards/${file}`);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/, `${file}: text, never HTML`);
    assert.doesNotMatch(src, /useEffect|fetch\(/, `${file}: a first render is the stored card`);
    assert.doesNotMatch(src, new RegExp(EM));
    for (const [, id] of src.matchAll(/t\('(messages:[^']+)'/g)) {
      const words = catalog(id, { count: 2, key: 'A', title: 'T', number: 1, answer: 'a', project: 'P', time: '4 s' });
      assert.notEqual(words, id, `${id} is in the catalog`);
      assert.doesNotMatch(words, new RegExp(EM));
    }
  }
});
