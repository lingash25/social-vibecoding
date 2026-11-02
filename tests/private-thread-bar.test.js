'use strict';

// Threads, stage 5 of #6019: a private thread in the chat with Homeroom
// bot, without a database (the doors themselves run against PostgreSQL in
// private-threads-postgres.test.js).
//
// What this pins:
//   1. Its first render is nothing, and it reads where the thread stands.
//   2. The projects to pick from are the viewer's communities, in order.
//   3. It is drawn on every private thread in the bot's chat, by the
//      server's word (`mine`; 1 Nov 2026: a "+" thread, a draft the bot
//      opened and a design thread hang off the bot's line): the note at
//      its head, the doors at its foot.
//   4. 31 Oct 2026: the doors come once the bot has answered, and only the
//      ones that apply to what the thread is. 1 Nov 2026: File it and Post
//      it are the bot's to offer, under its reply, never at the foot.
//   5. The routes the old doors wrote to stay same-origin writes.
//
// Run with: node --test tests/private-thread-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BAR = 'frontend/src/features/messages/private-thread-bar.tsx';

test('its first render is nothing; where the thread stands is read in an effect', () => {
  assert.equal(renderComponent(BAR, 'PrivateThreadNote', { where: null }), '');
  const doors = { rootId: 5, text: 'An idea', where: null, botReplied: true };
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', doors), '');
  assert.match(read(BAR), /fetch\(`\/api\/conversations\/homeroom-bot\/threads\/\$\{rootId\}`/);
});

test('the projects to pick from are the viewer\'s communities, in the switcher\'s order', () => {
  const { projectChoices } = loadTsx(BAR);
  assert.deepEqual(JSON.parse(JSON.stringify(projectChoices({
    list: ['seed-swap', 'notes'], info: { 'seed-swap': { name: 'Seed swap' } },
  }))), [{ slug: 'seed-swap', name: 'Seed swap' }, { slug: 'notes', name: 'notes' }]);
  assert.deepEqual(projectChoices({ list: null, info: {} }), []);
});

test('the doors wait for the bot\'s answer, and File it is never one of them', () => {
  const { doorsFor } = loadTsx(BAR);
  const notes = { slug: 'notes', name: 'Notes' };
  const open = (kind, app = null) => ({ state: 'open', kind, app });
  const doors = (where, replied = true) => JSON.parse(JSON.stringify(doorsFor(where, replied)));
  assert.deepEqual(doors(open('idea'), false), [], 'nothing to take public before the bot answers');
  // 1 Nov 2026 (Evan): File it and Post it are under the bot's offer, once
  // something is ready, not at the foot of every thread.
  assert.deepEqual(doors(open('draft_request', notes)), [], 'a drafted request is filed from its card');
  assert.deepEqual(doors(open('draft_reply', notes)), [], 'a drafted reply is posted from its card');
  assert.deepEqual(doors(open('ask', notes)), [], 'a "+" thread for a project waits for the bot\'s offer');
  assert.deepEqual(doors(open('idea', notes)), []);
  assert.deepEqual(doors(open('design', notes)), []);
  assert.deepEqual(doors(open('design')), [], 'a design\'s bot offers the project itself');
  // An idea in no project can still start one.
  assert.deepEqual(doors(open('ask')), ['new'], 'a "+" thread in no project, like an idea');
  assert.deepEqual(doors(open('idea')), ['new']);
  assert.deepEqual(doors({ state: 'open' }), ['new'], 'an older server sends no kind: an idea');
  assert.deepEqual(doors({ ...open('idea'), mine: false }), [], 'never on a thread that is not theirs');
  assert.deepEqual(doors({ state: 'filed', number: 4 }), [], 'none once it went somewhere');
  assert.deepEqual(doors(null), []);
});

test('it is drawn on every private thread in the bot\'s chat, by the server\'s word: the note on top, the doors under it', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  const gate = screen.slice(screen.indexOf('const privateRoot = '), screen.indexOf('const [privateWhere] = usePrivateThread(privateRoot);'));
  assert.match(gate, /snap\.active\?\.kind === 'direct' && threadsAllowed\(snap\.active\) && snap\.active\.homeroomBot/, 'the bot\'s chat');
  assert.match(gate, /privateRootMessage && !requestPageOf\(privateRootMessage\)/, 'any root but a request\'s story, the bot\'s line too');
  assert.doesNotMatch(gate, /!privateRootMessage\.sender\.bot/, '1 Nov 2026: not only the viewer\'s own message');
  assert.match(screen, /const privateMine = !!privateRoot && isOwnPrivateThread\(privateWhere, privateRootMessage, meId\);/);
  const note = screen.indexOf('{privateMine && !(inMain && privateWhere?.state === \'open\') ? <PrivateThreadNote where={privateWhere} /> : null}');
  const doors = screen.indexOf('<PrivateThreadDoors');
  assert.ok(note > 0 && doors > note, 'the note heads the thread, the doors close it');
  assert.match(screen.slice(doors - 80, doors), /\{privateRoot && privateMine && root \? \(\s*$/);
  assert.match(screen.slice(doors, doors + 400), /text=\{privateThreadWords\(root, replies, meId\)\}/);
  assert.match(screen.slice(doors, doors + 400), /botReplied=\{replies\.some\(\(message\) => message\.sender\.bot\)\}/);
  assert.doesNotMatch(screen, /<PrivateThreadBar\b/, 'no bar of doors over the thread any more');
});

test('whose thread it is, its name and the words to take public, for a root of theirs or the bot\'s line', () => {
  const { isOwnPrivateThread, privateThreadTitle, privateThreadWords } = loadTsx(BAR);
  const ME = 7;
  const mine = { content: 'An idea: swap seeds\nby post', sender: { id: ME } };
  const plus = { content: 'New thread, to add something new on Seed swap.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_thread' } } };
  const design = { content: 'I opened a design thread for Home', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_design', designTitle: 'Home screen' } } };
  const draft = { content: 'I drafted it as a request on Seed swap, in a thread only you can see.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_draft' } } };
  const replies = [
    { content: 'Hello', sender: { id: 2, bot: true } },
    { content: 'A seed calendar\nmonth by month', sender: { id: ME } },
    { content: 'and reminders', sender: { id: ME } },
  ];
  // The server's word, when it says it; an older server's rule otherwise.
  assert.equal(isOwnPrivateThread({ state: 'open', mine: true }, plus, ME), true);
  assert.equal(isOwnPrivateThread({ state: 'open', mine: false }, mine, ME), false);
  assert.equal(isOwnPrivateThread({ state: 'open' }, mine, ME), true, 'their own root');
  assert.equal(isOwnPrivateThread({ state: 'open' }, plus, ME), false, 'the bot\'s line, with no word from the server');
  assert.equal(isOwnPrivateThread(null, mine, 8), false, 'somebody else\'s');
  // Named as the tab's list names it.
  assert.equal(privateThreadTitle(mine, [], ME), 'An idea: swap seeds');
  assert.equal(privateThreadTitle(plus, replies, ME), 'A seed calendar', 'a "+" thread by their first words in it');
  assert.equal(privateThreadTitle(plus, [], ME), null, 'nothing yet: the caller names it by its kind');
  assert.equal(privateThreadTitle(design, [], ME), 'Home screen', 'a design thread by its screen');
  assert.equal(privateThreadTitle(draft, [], ME), 'I drafted it as a request on Seed swap, in a thread only you can see.');
  // The words: their root's, else their first message in the thread.
  assert.equal(privateThreadWords(mine, replies, ME), 'An idea: swap seeds\nby post');
  assert.equal(privateThreadWords(plus, replies, ME), 'A seed calendar\nmonth by month');
  assert.equal(privateThreadWords(draft, [], ME), '', 'nothing of theirs yet');
});

test('in Main Chat\'s column a thread is alone under its own head, and says it is theirs', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /function ReplyThreadPanel\(\{ inMain = false, onBack = null \}/);
  assert.match(screen, /<div className="messages-thread-name min-w-0 truncate" data-reply-title="">\{mainTitle\}<\/div>/);
  assert.match(screen, /<span className="truncate">\{t\('messages:ai\.thread\.sub'\)\}<\/span>/);
  assert.equal(message('messages:ai.thread.sub'), 'Only you can see this thread');
  // No ✕ and no Back to Main Chat in the column; a phone's arrow goes to the list.
  assert.match(screen, /\{inMain \? null : \(\s*<button type="button" className="messages-thread-action" data-reply-close=""/);
  assert.match(screen, /\{inMain && onBack \? \(\s*<button type="button" className="messages-thread-action messages-thread-back" data-reply-back=""\s+aria-label=\{t\('messages:ai\.drawer\.back'\)\}/);
  assert.doesNotMatch(screen, /replies\.backToMain/);
  assert.match(screen, /\{here && snap\.route\.threadRootId \? <ReplyThreadPanel inMain=\{mainChat\} onBack=\{onBack\} \/> : null\}/);
});

test('the foot has New project alone: no File it or Post it form, and nothing it writes', () => {
  const source = read(BAR);
  assert.match(source, /data-private-doors=/);
  assert.match(source, /data-private-door=\{d\}/);
  assert.doesNotMatch(source, /privateThread\.(fileIt|postIt|sendFile|sendPost)/, 'no File it or Post it at the foot');
  assert.doesNotMatch(source, /method: 'POST'/, 'the foot writes nothing: the bot\'s offer does');
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: { slug: 'notes', name: 'Notes' } }, botReplied: true,
  }), '', 'a thread for a project has no foot');
  assert.match(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: null }, botReplied: true,
  }), /data-private-door="new"[^>]*>New project</);
});

test('the bot offers File it once a request is ready: the foot has none', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const plus = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'ask', changeKind: 'fix', appSlug: 'notes', appName: 'Notes' } } });
  assert.match(plus, /Once it is clear enough to build, offer it as a request with offer_request:\n  File it shows only under that offer, so make it then, without waiting to be asked\./);
  const idea = mayor.systemPrompt({ username: 'ada', thread: { draft: null } });
  assert.match(idea, /Nothing in this thread is filed until you offer it\. Once what they want is clear enough to build, offer it as\n  a request with offer_request: File it shows only under that offer\./);
  const filed = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'draft_request', state: 'filed', issueNumber: 4, appSlug: 'notes', appName: 'Notes' } } });
  assert.doesNotMatch(filed, /File it shows only under that offer/, 'not once it is filed');
});

test('the routes the old doors wrote to stay same-origin writes, and the head\'s copy is unchanged', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/file', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/post', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.equal(message('messages:privateThread.label'), 'Only you can see this thread.');
  assert.equal(message('messages:privateThread.newProject'), 'New project');
  assert.equal(message('messages:privateThread.filed', { number: 41, project: 'Seed swap' }), 'Filed as request #41 on Seed swap.');
});
