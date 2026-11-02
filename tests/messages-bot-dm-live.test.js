'use strict';

// Two reports from the Homeroom bot's DM, filed together by the platform
// admin and fixed together because they were one fault:
//
//   #3705 — a DM from the bot arrives while Messages is already open, and it
//           does not show until the page is reloaded.
//   #3706 — a message sent to the bot shows, then disappears; a reload shows
//           it and the bot's reply.
//
// Realtime carries ids only, so every event re-reads the open conversation
// through the API (frontend/src/features/messages/store.ts handleEvent). That
// read was an ordinary GET /api/*, which the service worker answers from its
// offline copy once the network has taken a second (public/sw.js,
// API_TIMEOUT_MS). The bot's DM is the slowest page to read — every card on
// it was hydrated with its own GitHub request, one after another — so its
// re-read lost that race, and the copy it got back was the transcript from
// before the change: no new message, and the store, taking it as the server's
// word, dropped the sender's own confirmed row. Nothing on the Messages screen
// listened for the worker's late correction, and a reconnect re-read only the
// inbox, never the open conversation. Separately, a pending send was matched
// to the OLDEST message with the same words, and the bot's suggested answers
// repeat the same words every time.
//
// The fixes, each pinned below: a re-read after a change asks the server
// (`cache: 'no-store'`, which the worker leaves alone); a page older than a
// confirmed send keeps it; a pending send matches only a message newer than
// itself; a reconnect and the worker's correction re-read the conversation on
// screen; and a page hydrates each distinct card once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const github = require('../src/services/github');
const sharedObjects = require('../src/services/shared-objects');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ORIGIN = 'https://social-vibecoding.example';

// ── The store, run against a stubbed API ─────────────────────────────────

const ME = { id: 7, username: 'evan', avatarUrl: null };
const BOT = { id: 99, username: 'homeroom-bot', avatarUrl: null, bot: true };
const DM = {
  id: 42, kind: 'direct', title: 'homeroom-bot', membershipStatus: 'member', canSend: true,
  members: [ME, BOT], unreadCount: 0, lastActivityAt: new Date(Date.UTC(2026, 9, 2)).toISOString(),
};

function serverMessage(id, sender, content) {
  return {
    id, conversationId: 42, sender, content, createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, id)).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [],
  };
}

function harness(initial) {
  const server = {
    messages: initial.map((item) => ({ ...item })),
    nextId: initial.reduce((top, item) => Math.max(top, item.id), 0) + 1,
    // A page from before the change: what the worker's offline copy was, or
    // what a read already in flight when the change landed brings back.
    stale: null,
    reads: [],
  };
  const deferred = [];
  const api = {
    MessagesApiError: class extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async (options) => { server.reads.push(['list', options]); return [DM]; },
    getConversation: async (id, options) => { server.reads.push(['conversation', options]); return DM; },
    listMessages: async (id, before, options) => {
      server.reads.push(['messages', options]);
      return { messages: (server.stale || server.messages).map((item) => ({ ...item })), nextBefore: null };
    },
    markRead: async () => {},
    sendMessage: (id, payload) => new Promise((resolve) => {
      deferred.push(() => {
        // Idempotent, as services/conversations.js is: the same key is one row.
        const existing = server.messages.find((item) => item.key === payload.idempotencyKey);
        if (existing) { resolve({ ...existing }); return; }
        const message = { ...serverMessage(server.nextId++, ME, payload.content), key: payload.idempotencyKey };
        server.messages.push(message);
        resolve({ ...message });
      });
    }),
  };
  let snapshot = null;
  const react = { useSyncExternalStore: (subscribe, get) => { snapshot = get; return get(); } };
  globalThis.window = {
    App: { user: ME },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  // The app-discussions read is a plain fetch beside the stubbed API.
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  store.useMessagesSnapshot();
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const settle = async () => { while (deferred.length) deferred.shift()(); await flush(); };
  const state = () => snapshot();
  const contents = () => state().messages.map((item) => item.content);
  const event = async (messageId) => {
    store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId });
    await flush();
  };
  return { store, server, api, state, contents, flush, settle, event };
}

async function openDm(h) {
  h.store.messagesController.route(42);
  await h.flush();
  assert.ok(h.state().messages.length, 'the DM loaded');
}

function assertKeysUnique(rows) {
  const keys = rows.map((item) => String(item.clientKey || item.id));
  assert.equal(new Set(keys).size, keys.length, `every row has its own React key: ${keys.join(', ')}`);
}

test('#3705: a re-read after a realtime event asks the server, never the worker\'s offline copy', async () => {
  const h = harness([serverMessage(1, BOT, 'I build things for you on Homeroom.')]);
  await openDm(h);
  const opening = h.server.reads.splice(0);
  assert.ok(opening.some(([what]) => what === 'messages'), 'the open read the transcript');
  for (const [what, options] of opening.filter(([w]) => w !== 'list')) {
    assert.equal(options?.fresh, true, `an open while online reads the server, not the last visit's offline copy (${what}, #4243)`);
  }

  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Your request is up for a vote.'));
  await h.event(2);
  const after = h.server.reads.splice(0);
  for (const what of ['conversation', 'messages', 'list']) {
    assert.ok(after.some(([w, options]) => w === what && options?.fresh === true), `the ${what} read is fresh`);
  }
  assert.deepEqual(h.contents(), ['I build things for you on Homeroom.', 'Your request is up for a vote.']);
});

test('#4243: an open reads the offline copy only when offline, or once the fresh read failed', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  const offline = harness([serverMessage(1, BOT, 'Hello.')]);
  await openDm(offline);
  for (const [what, options] of offline.server.reads.filter(([w]) => w !== 'list')) {
    assert.ok(!options?.fresh, `offline, the open takes the worker's copy (${what})`);
  }

  globalThis.navigator.onLine = true;
  const failing = harness([serverMessage(1, BOT, 'Hello.')]);
  const getConversation = failing.api.getConversation;
  let failures = 1;
  failing.api.getConversation = async (id, options) => {
    if (options?.fresh && failures-- > 0) { failing.server.reads.push(['conversation', options]); throw new TypeError('Failed to fetch'); }
    return getConversation(id, options);
  };
  await openDm(failing);
  const reads = failing.server.reads.filter(([w]) => w === 'conversation').map(([, options]) => !!options?.fresh);
  assert.deepEqual(reads, [true, false], 'the fresh read failed, so the open read again and took the copy');
  assert.equal(failing.state().threadError, null, 'and drew it, with no error');
});

test('#4220: the bot stays "typing" until the message it sent is drawn, and no longer than the cap', async (t) => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  const timers = [];
  Object.assign(globalThis.window, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  const dm = {
    ...DM,
    members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }],
    peer: { id: BOT.id, bot: true, displayName: 'Homeroom bot' },
  };
  h.api.getConversation = async () => dm;
  await openDm(h);
  const typing = (on) => h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: on });

  typing(true);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot']);
  // The answer's re-read is slow: hold it until the test lets it go.
  const listMessages = h.api.listMessages;
  let release;
  h.api.listMessages = (...args) => new Promise((resolve) => { release = () => resolve(listMessages(...args)); });
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Done: it is up for a vote.'));
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: 2 });
  await h.flush();
  typing(false);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot'], 'the stop waits for the message it typed');
  release();
  await h.flush();
  assert.ok(h.contents().includes('Done: it is up for a vote.'), 'the message is drawn');
  assert.deepEqual(h.state().typing[42], [], 'and the line goes with it');

  // A read that never comes back lets the line go at the cap.
  typing(true);
  h.api.listMessages = () => new Promise(() => {});
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: 3 });
  await h.flush();
  typing(false);
  assert.deepEqual(h.state().typing[42].map((typist) => typist.name), ['Homeroom bot']);
  const cap = timers.filter((timer) => timer.live && timer.ms === 5000);
  assert.equal(cap.length, 1, 'one cap of about five seconds');
  cap[0].fn();
  assert.deepEqual(h.state().typing[42], [], 'the cap clears it');
});

test('#4220: a stop with no new message on its way clears the line at once', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  Object.assign(globalThis.window, { setTimeout: () => 1, clearTimeout: () => {} });
  const dm = { ...DM, members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }] };
  h.api.getConversation = async () => dm;
  await openDm(h);
  h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: true });
  assert.equal(h.state().typing[42].length, 1);
  h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: false });
  assert.deepEqual(h.state().typing[42], []);
});

test('31 Oct 2026: typing in a thread is that thread\'s line, and never the conversation\'s', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  Object.assign(globalThis.window, { setTimeout: () => 1, clearTimeout: () => {} });
  const dm = {
    ...DM,
    members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }],
    peer: { id: BOT.id, bot: true, displayName: 'Homeroom bot' },
  };
  h.api.getConversation = async () => dm;
  await openDm(h);
  const typing = (on, threadRootId) => h.store.messagesController.handleEvent({
    type: 'conversation_typing', conversationId: 42, userId: BOT.id, typing: on, ...(threadRootId ? { threadRootId } : {}),
  });
  typing(true, 1);
  assert.deepEqual(h.store.typingUsers(42, 1).map((typist) => typist.name), ['Homeroom bot'], 'drawn in the thread');
  assert.deepEqual(h.store.typingUsers(42), [], 'not beside it');
  typing(true);
  assert.deepEqual(h.store.typingUsers(42).map((typist) => typist.name), ['Homeroom bot']);
  typing(false, 1);
  assert.deepEqual(h.store.typingUsers(42, 1), [], 'the thread\'s stops');
  assert.deepEqual(h.store.typingUsers(42).map((typist) => typist.name), ['Homeroom bot'], 'the conversation\'s stays');
});

// 1 Nov 2026: the bot's typing says what it is doing, for its working card
// (frontend/src/features/messages/bot-working.tsx). A person's never does.
test('the bot types as the bot, with what it is doing; a person\'s typing never carries that', async (t) => {
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  const timers = [];
  Object.assign(globalThis.window, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  const ADA = { id: 13, username: 'ada', avatarUrl: null };
  const dm = {
    ...DM,
    members: [{ ...ME, status: 'member' }, { ...BOT, status: 'member' }, { ...ADA, status: 'member' }],
    peer: { id: BOT.id, bot: true, displayName: 'Homeroom bot' },
  };
  h.api.getConversation = async () => dm;
  await openDm(h);
  const typing = (userId, on, extra = {}) => h.store.messagesController.handleEvent({
    type: 'conversation_typing', conversationId: 42, userId, typing: on, ...extra,
  });
  typing(BOT.id, true);
  assert.deepEqual(h.store.typingUsers(42), [{ name: 'Homeroom bot', unnamed: false, bot: true, doing: null }], 'thinking');
  typing(BOT.id, true, { doing: { kind: 'request', number: 12, extra: 'x' } });
  assert.deepEqual(h.store.typingUsers(42), [{ name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'request', number: 12 } }],
    'what it is doing, in place');
  typing(BOT.id, true, { doing: { kind: 'Reading request #12' } });
  assert.equal(h.store.typingUsers(42)[0].doing, null, 'a kind word, never words to draw');
  typing(BOT.id, true, { doing: { kind: 'drawing' } });
  typing(ADA.id, true, { doing: { kind: 'drawing' } });
  assert.deepEqual(h.store.typingUsers(42), [
    { name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'drawing' } },
    { name: 'ada', unnamed: false },
  ], 'a person is a name on the line, whatever their event says');

  // The answer's re-read is slow: the stop holds the card, with its words,
  // until the answer is drawn (#4220), so the card gives way to it.
  const listMessages = h.api.listMessages;
  let release;
  h.api.listMessages = (...args) => new Promise((resolve) => { release = () => resolve(listMessages(...args)); });
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Version 1 · The main screen'));
  h.store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: 2 });
  await h.flush();
  typing(BOT.id, false);
  assert.deepEqual(h.store.typingUsers(42)[0], { name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'drawing' } },
    'held, as it was, while the answer is read');
  release();
  await h.flush();
  assert.ok(h.contents().includes('Version 1 · The main screen'));
  assert.deepEqual(h.store.typingUsers(42), [{ name: 'ada', unnamed: false }], 'and gone once it is drawn');
});

// The typing line shows what it showed before the text moved (base 1e6c91e33):
// each shown name once, and a name leaves when anybody typing under it stops
// or expires. What is new is only whose name it is: `unnamed` follows the
// people typing under the word now.
//
// ['t', id] types, ['s', id] stops, ['x', id] that person's 6 s expiry fires.
const TYPISTS = { N: 11, R: 12, A: 13, S: 14 };
function typingSequences() {
  const { N, R, A, S } = TYPISTS;
  const collision = (first, second) => [
    [['t', first], ['t', second]],
    [['t', first], ['t', second], ['s', N]],
    [['t', first], ['t', second], ['s', R]],
    [['t', first], ['t', second], ['s', N], ['t', R]],
    [['t', first], ['t', second], ['s', R], ['t', N]],
    [['t', first], ['t', second], ['t', first]],
    [['t', first], ['t', second], ['x', N]],
    [['t', first], ['t', second], ['x', R]],
    [['t', first], ['t', second], ['x', N], ['x', R]],
    [['t', first], ['t', second], ['s', N], ['s', R], ['t', R]],
    [['t', first], ['t', second], ['t', A], ['s', N]],
    [['t', A], ['t', first], ['t', second], ['s', R], ['t', S]],
  ];
  return [
    [['t', A]], [['t', A], ['s', A]], [['t', A], ['x', A]], [['t', A], ['t', A], ['x', A]],
    [['t', A], ['t', S]], [['t', A], ['t', S], ['s', A]], [['t', S], ['t', A], ['t', S]],
    [['t', A], ['t', S], ['t', R]], [['t', A], ['t', S], ['t', R], ['s', A]],
    [['t', N]], [['t', N], ['s', N]], [['t', N], ['s', N], ['t', R]], [['t', R], ['s', R], ['t', N]],
    ...collision(N, R), ...collision(R, N),
  ];
}

// The base's store and line, transcribed: a set of shown names, and the two
// sentences it wrote. (The real base store was run through these same
// sequences when this was written; its lines matched at every step.)
function baseTypingLines(sequence, names) {
  const shown = new Set();
  const expiry = new Map();
  const lines = [];
  for (const [op, id] of sequence) {
    const name = names[id];
    if (op === 't') { shown.add(name); expiry.set(id, true); }
    if (op === 's') { shown.delete(name); expiry.delete(id); }
    if (op === 'x' && expiry.get(id)) { shown.delete(name); expiry.delete(id); }
    const typing = [...shown];
    lines.push(typing.length === 1 ? `${typing[0]} is typing…`
      : typing.length > 1 ? `${typing.slice(0, 2).join(', ')} are typing…` : '');
  }
  return lines;
}

async function runTyping(sequence) {
  const { N, R, A, S } = TYPISTS;
  const h = harness([serverMessage(1, BOT, 'Hello.')]);
  const timers = [];
  Object.assign(globalThis.window, {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  });
  const member = (id, username, extra = {}) => ({ id, username, avatarUrl: null, status: 'member', ...extra });
  // A member whose username did not come with the row (the normalizer's
  // stand-in and flag), and an account really called "unknown".
  const group = { ...DM, kind: 'group', title: 'Crew', members: [{ ...ME, status: 'member' },
    member(N, 'unknown', { unnamed: true }), member(R, 'unknown'), member(A, 'ada'), member(S, 'sam')] };
  h.api.getConversation = async () => group;
  await openDm(h);
  const { typingLine } = loadTsx('frontend/src/features/messages/typing-line.ts');
  const lastTimer = {};
  const lines = [];
  const states = [];
  for (const [op, id] of sequence) {
    if (op === 'x') {
      const timer = lastTimer[id];
      if (timer && timer.live) { timer.live = false; timer.fn(); }
    } else {
      h.store.messagesController.handleEvent({ type: 'conversation_typing', conversationId: 42, userId: id, typing: op === 't' });
      if (op === 't') lastTimer[id] = timers.filter((timer) => timer.ms === 6000).at(-1);
    }
    const typing = h.state().typing[42] || [];
    lines.push(typingLine(message, typing));
    states.push(typing.map((entry) => [entry.name, entry.unnamed]));
  }
  return { lines, states };
}

test('the typing line reads exactly as it did, through every order of typing, stopping and expiry', async () => {
  const { N, R, A, S } = TYPISTS;
  const names = { [N]: 'unknown', [R]: 'unknown', [A]: 'ada', [S]: 'sam' };
  const sequences = typingSequences();
  assert.equal(sequences.length, 37);
  for (const sequence of sequences) {
    const { lines } = await runTyping(sequence);
    assert.deepEqual(lines, baseTypingLines(sequence, names), JSON.stringify(sequence));
  }
  // Two people shown by the same word are still one name, and it leaves when either stops.
  assert.deepEqual((await runTyping([['t', N], ['t', R]])).lines, ['unknown is typing…', 'unknown is typing…']);
  assert.deepEqual((await runTyping([['t', N], ['t', R], ['s', N]])).lines.at(-1), '');
});

test('whether a typing name is a stand-in follows the people typing under it now', async () => {
  const { N, R } = TYPISTS;
  const last = async (sequence) => (await runTyping(sequence)).states.at(-1);
  assert.deepEqual(await last([['t', N]]), [['unknown', true]], 'a nameless member alone: the stand-in');
  assert.deepEqual(await last([['t', R]]), [['unknown', false]], 'an account really called "unknown": a name');
  // A nameless member typed and stopped; the real account typing later is named.
  assert.deepEqual(await last([['t', N], ['s', N], ['t', R]]), [['unknown', false]]);
  assert.deepEqual(await last([['t', N], ['x', N], ['t', R]]), [['unknown', false]], 'and after an expiry');
  // Both under the one word: named while a real account is among them, in either order.
  assert.deepEqual(await last([['t', N], ['t', R]]), [['unknown', false]]);
  assert.deepEqual(await last([['t', R], ['t', N]]), [['unknown', false]]);
  // The word left with the real account; the nameless member typing again is the stand-in.
  assert.deepEqual(await last([['t', N], ['t', R], ['s', R], ['t', N]]), [['unknown', true]]);
  // The two wordings are the same English, so which is chosen never shows in English.
  assert.equal(message('messages:thread.typingOneUnknown'), message('messages:thread.typingOne', { name: 'unknown' }));
  const lineSource = read('frontend/src/features/messages/typing-line.ts');
  assert.match(lineSource, /if \(typing\.length === 1\) return first\.unnamed \? t\('messages:thread\.typingOneUnknown'\) : t\('messages:thread\.typingOne', \{ name: first\.name \}\);/);
  assert.match(read('frontend/src/features/messages/index.tsx'), /\{typingLine\(t, typing\)\}/);
  assert.doesNotMatch(read('frontend/src/features/messages/store.ts'), /unnamedTypists/);
});

test('the waiting line names the same person it named before it read the flag', () => {
  const { waitingFor } = loadTsx('frontend/src/features/messages/waiting-for.ts');
  // The base: `active.peer?.username || active.members.find((m) => m.status === 'invited')?.username || ''`.
  const base = (active) => active.peer?.username || active.members.find((m) => m.status === 'invited')?.username || '';
  const invited = (username, extra = {}) => ({ username, status: 'invited', ...extra });
  const cases = [
    { peer: { username: 'ada' }, members: [invited('sam')] },
    { peer: null, members: [invited('sam'), invited('lena')] },
    { peer: { username: '' }, members: [invited('sam')] },
    // An earlier invited member with an empty username, a later one with a name: nobody is named.
    { peer: null, members: [invited(''), invited('sam')] },
    { peer: null, members: [{ username: 'ada', status: 'member' }, invited('sam')] },
    { peer: null, members: [] },
    { peer: { username: 'unknown', unnamed: true }, members: [] },
    { peer: null, members: [invited('unknown', { unnamed: true }), invited('sam')] },
    { peer: { username: 'unknown' }, members: [] },
  ];
  for (const active of cases) assert.equal(waitingFor(active).name, base(active), JSON.stringify(active));
  assert.deepEqual(waitingFor(cases[3]), { name: '', unknown: false });
  assert.deepEqual(waitingFor(cases[6]), { name: 'unknown', unknown: true });
  assert.deepEqual(waitingFor(cases[8]), { name: 'unknown', unknown: false }, 'an account really called "unknown" is named');
  assert.equal(message('messages:composer.requestSent.waitingUnknown'), message('messages:composer.requestSent.waitingNamed', { username: 'unknown' }));
});

test('#3706: a page read before the send landed does not take the sender\'s message away', async () => {
  const h = harness([serverMessage(1, BOT, 'What should the button say?')]);
  await openDm(h);
  const before = h.server.messages.map((item) => ({ ...item }));
  const sending = h.store.send({ content: 'Save draft' });
  await h.settle();
  await sending;
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft'], 'confirmed');
  const key = h.state().messages[1].clientKey;

  // The echo's re-read comes back with the transcript from before the send.
  h.server.stale = before;
  await h.event(2);
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft'],
    'the confirmed message stays on screen');
  assert.equal(h.state().messages[1].clientKey, key, 'in place, under the key it was drawn with');

  // The bot answers; the next page holds both, and each is drawn once.
  h.server.stale = null;
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Thanks. I posted your answer.'));
  await h.event(3);
  assert.deepEqual(h.contents(), ['What should the button say?', 'Save draft', 'Thanks. I posted your answer.']);
  assert.equal(h.state().messages[1].clientKey, key);
  assertKeysUnique(h.state().messages);
});

test('#3706: a confirmed message is let go once a newer page has moved past it', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  const sending = h.store.send({ content: 'hi' });
  await h.settle();
  await sending;
  // A page that reaches past the row and does not hold it (it was removed by
  // the server) is the server's word: the row is not kept forever.
  h.server.messages = [serverMessage(1, BOT, 'Hello'), serverMessage(5, BOT, 'Later news')];
  await h.event(5);
  assert.deepEqual(h.contents(), ['Hello', 'Later news']);
});

test('#3706: a repeated answer takes its own server copy, not the oldest message with the same words', async () => {
  const h = harness([
    serverMessage(1, BOT, 'Should the button be blue?'),
    serverMessage(2, ME, 'Yes'),
    serverMessage(3, BOT, 'Should it be round?'),
  ]);
  await openDm(h);
  const sending = h.store.send({ content: 'Yes' });
  const key = h.state().messages.at(-1).clientKey;
  assert.ok(key);

  // The server stored it and its echo re-reads the DM before the POST returns.
  h.server.messages.push({ ...serverMessage(h.server.nextId++, ME, 'Yes'), key });
  await h.event(4);
  let rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.id), [1, 2, 3, 4]);
  assert.equal(rows[3].clientKey, key, 'the new answer takes the row\'s key');
  assert.equal(rows[1].clientKey, undefined, 'the earlier "Yes" keeps its own');

  await h.settle();
  await sending;
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.id), [1, 2, 3, 4], 'neither answer leaves the screen');
  assertKeysUnique(rows);

  await h.event(4);
  rows = h.state().messages;
  assert.deepEqual(rows.map((item) => item.content), ['Should the button be blue?', 'Yes', 'Should it be round?', 'Yes']);
  assertKeysUnique(rows);
});

test('#3705: a reconnect re-reads the conversation on screen, and only the inbox otherwise', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  assert.equal(h.store.messagesController.showing(), true);

  // The bot wrote while the events socket was down: no event ever arrives.
  h.server.messages.push(serverMessage(h.server.nextId++, BOT, 'Your proposal was merged.'));
  h.server.reads.length = 0;
  await h.store.messagesController.resync();
  await h.flush();
  assert.deepEqual(h.contents(), ['Hello', 'Your proposal was merged.']);
  assert.ok(h.server.reads.some(([what, options]) => what === 'messages' && options?.fresh), 'read from the server');

  h.store.messagesController.close();
  assert.equal(h.store.messagesController.showing(), false);
  h.server.reads.length = 0;
  await h.store.messagesController.resync();
  assert.deepEqual(h.server.reads.map(([what]) => what), ['list'], 'the badge, and nothing it is not drawing');
});

test('#8 (WP3): the resync of the conversation on screen also reads the bot\'s tray and cards again', async () => {
  const h = harness([serverMessage(1, BOT, 'Hello')]);
  await openDm(h);
  const dispatched = [];
  globalThis.window.dispatchEvent = (event) => { dispatched.push(event.type); return true; };
  await h.store.messagesController.resync();
  assert.deepEqual(dispatched, ['homeroom-bot-work-changed'], 'the window event the tray and the cards re-read on, fresh');
  h.store.messagesController.close();
  dispatched.length = 0;
  await h.store.messagesController.resync();
  assert.deepEqual(dispatched, [], 'nothing of the bot\'s is drawn: nothing to read');
});

// ── The wire: what a fresh read asks the browser for ────────────────────

test('a fresh read is `cache: no-store`; an ordinary one is not', async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    seen.push({ url, cache: init.cache });
    return { ok: true, json: async () => ({ messages: [], conversations: [], conversation: { id: 42 } }) };
  };
  const api = loadTsx('frontend/src/features/messages/api.ts');
  await api.listMessages(42);
  await api.listMessages(42, null, { fresh: true });
  await api.getConversation(42, { fresh: true });
  await api.listConversations({ fresh: true });
  await api.listThread(42, 9, null, { fresh: true });
  await api.listMessagesAround(42, 5, { fresh: true });
  assert.equal(seen[0].cache, undefined, 'an ordinary read (an open offline, or after a failed fresh one) is left to the worker');
  for (const call of seen.slice(1)) assert.equal(call.cache, 'no-store', call.url);
});

test('the service worker leaves a no-store Messages read to the network', () => {
  // What the fresh reads rely on. An ordinary read of the transcript races the
  // worker's offline copy; a no-store one is never intercepted at all.
  const handlers = {};
  vm.runInNewContext(read('public/sw.js'), {
    self: { location: { origin: ORIGIN }, addEventListener(name, fn) { handlers[name] = fn; } },
    URL, Headers, Response, Map, Set, Promise,
    caches: { open() { throw new Error('no cache in this test'); } },
    fetch() { throw new Error('no network in this test'); },
    setTimeout() {}, clearTimeout() {},
  });
  const intercepted = (cache) => {
    let responded = false;
    handlers.fetch({
      request: {
        method: 'GET', url: `${ORIGIN}/api/conversations/42/messages?limit=50`, cache, mode: 'cors',
        headers: new Headers({ accept: 'application/json' }),
      },
      respondWith(answer) { responded = true; Promise.resolve(answer).catch(() => {}); },
      waitUntil() {},
    });
    return responded;
  };
  assert.equal(intercepted('default'), true, 'an ordinary read is the worker\'s to answer');
  assert.equal(intercepted('no-store'), false, 'a fresh read goes to the server');
});

// ── The screen's two other re-reads ──────────────────────────────────────

test('a reconnect and the worker\'s late correction both re-read the open conversation', () => {
  const app = read('public/js/app.js');
  const resyncStart = app.indexOf('  resyncCurrentView() {');
  const resync = app.slice(resyncStart, app.indexOf('// #1038:', resyncStart));
  assert.match(resync, /window\.UsernodeReact\?\.messages\?\.resync\?\.\(\);/, 'on reconnect');
  assert.doesNotMatch(resync, /messages\?\.refresh\?\.\(\)/, 'not the inbox alone');

  const loader = app.slice(app.indexOf('  refreshActiveScreen() {'), app.indexOf('_refreshLeaderboard() {'));
  const messagesAt = loader.search(/if \(messages\?\.showing\?\.\(\)\) messages\.resync\?\.\(\);/);
  assert.ok(messagesAt > 0, 'the correction re-reads Messages when it is on screen');
  assert.ok(messagesAt < loader.indexOf('return;', loader.indexOf('const visible')),
    'before any branch that returns, so an app left open behind Messages cannot swallow it');
});

// ── The page the bot's DM reads ──────────────────────────────────────────

test('a page hydrates each distinct card once, however many messages carry it', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  const asked = [];
  github.fetchPublicIssue = async (owner, repo, number) => {
    asked.push(number);
    return { issue: { number, title: `Request ${number}`, state: 'closed', author: 'evan' } };
  };
  const card = (id, messageId, issueNumber) => ({
    id, message_id: messageId, position: 0, object_type: 'github_issue', app_id: 7, object_ref: issueNumber, object_version: null,
  });
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM conversation_message_objects')) {
        return { rows: [card(1, 10, 3705), card(2, 11, 3705), card(3, 12, 3706), card(4, 13, 3705)] };
      }
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (sql.includes('FROM apps WHERE id = $1')) {
        return { rows: [{
          id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/example/demo.git',
          view_visibility: 'public', collab_visibility: 'public',
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const cards = await sharedObjects.hydrateForMessages(pool, { id: 3, isAdmin: false }, [10, 11, 12, 13]);
  assert.deepEqual(asked.sort(), [3705, 3706], 'one GitHub read per distinct request, not per message');
  for (const [messageId, issueNumber] of [[10, 3705], [11, 3705], [12, 3706], [13, 3705]]) {
    const [hydrated] = cards.get(messageId);
    assert.equal(hydrated.issueNumber, issueNumber);
    assert.equal(hydrated.title, `Request ${issueNumber}`);
    assert.equal(hydrated.available, true);
  }
  assert.notEqual(cards.get(10)[0], cards.get(11)[0], 'each message carries its own copy');
});

test('a page reads its distinct cards a few at a time, not one after another', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  let inFlight = 0;
  let most = 0;
  github.fetchPublicIssue = async (owner, repo, number) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return { issue: { number, title: `Request ${number}`, state: 'closed' } };
  };
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: i + 1, message_id: 100 + i, position: 0, object_type: 'github_issue', app_id: 7, object_ref: 500 + i, object_version: null,
  }));
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM conversation_message_objects')) return { rows };
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (sql.includes('FROM apps WHERE id = $1')) {
        return { rows: [{ id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/example/demo.git', view_visibility: 'public', collab_visibility: 'public' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const cards = await sharedObjects.hydrateForMessages(pool, { id: 3, isAdmin: false }, rows.map((r) => r.message_id));
  assert.ok(most > 1, 'more than one at a time');
  assert.ok(most <= 6, `at most six at once (saw ${most})`);
  assert.deepEqual(rows.map((r) => cards.get(r.message_id)[0].title), rows.map((r) => `Request ${r.object_ref}`), 'each card where it was');
});

test('when GitHub cannot answer, a request card takes the title Homeroom holds for it', async (t) => {
  const original = github.fetchPublicIssue;
  t.after(() => { github.fetchPublicIssue = original; });
  github.fetchPublicIssue = async () => ({ issue: null, note: 'fetch failed' });
  const asked = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('FROM conversation_message_objects')) {
        return { rows: [
          { id: 1, message_id: 10, position: 0, object_type: 'github_issue', app_id: 7, object_ref: 4752, object_version: null },
          { id: 2, message_id: 11, position: 0, object_type: 'github_issue', app_id: 7, object_ref: 4753, object_version: null },
        ] };
      }
      if (/FROM user_app_blocks/.test(sql)) return { rows: [] };
      if (sql.includes('FROM apps WHERE id = $1')) {
        return { rows: [{ id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/example/demo.git', view_visibility: 'public', collab_visibility: 'public' }] };
      }
      if (sql.includes('FROM homeroom_bot_requesters') && sql.includes('FROM issues')) {
        asked.push(params[1]);
        return { rows: params[1] === 4752 ? [{ title: 'Fix missing needs-you area on needs-you page' }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const cards = await sharedObjects.hydrateForMessages(pool, { id: 3, isAdmin: false }, [10, 11]);
  assert.equal(cards.get(10)[0].title, 'Fix missing needs-you area on needs-you page', 'not "Issue #4752"');
  assert.equal(cards.get(11)[0].title, 'Issue #4753', 'nothing held: its number');
  assert.deepEqual(asked.sort(), [4752, 4753]);
});

test('the chat with the bot sends its news rows without their cards; the server and the client agree on which rows those are', () => {
  const conversations = require('../src/services/conversations');
  const row = (meta, over = {}) => ({ sender_is_synthetic: true, msg_type: 'message', deleted_at: null, metadata: { homeroomBot: meta }, ...over });
  assert.equal(conversations.isBotNewsRow(row({ kind: 'activity', issueNumber: 18 })), true);
  assert.equal(conversations.isBotNewsRow(row({ kind: 'merged', firstVersion: true })), true);
  assert.equal(conversations.isBotNewsRow(row({ kind: 'activity' })), true, 'a card is news');
  assert.equal(conversations.isBotNewsRow(row({ kind: 'chat', issueNumber: 18 })), false, 'conversation keeps its cards');
  assert.equal(conversations.isBotNewsRow(row({ kind: 'question', issueNumber: 18, moment: 'reply' })), false);
  assert.equal(conversations.isBotNewsRow(row({ kind: 'note' })), false, 'about no request');
  assert.equal(conversations.isBotNewsRow(row({ kind: 'question', issueNumber: 18 }, { sender_is_synthetic: false })), false, 'a person\'s message is theirs');
  assert.equal(conversations.isBotNewsRow(row({ kind: 'question', issueNumber: 18 }, { deleted_at: new Date() })), false);
  // The client's isBotNews draws exactly these rows as one line with no card.
  const client = read('frontend/src/features/messages/bot-request.ts');
  const listed = client.slice(client.indexOf('const CONVERSATION_KINDS = new Set(['), client.indexOf(']);', client.indexOf('const CONVERSATION_KINDS')));
  const kinds = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...conversations.BOT_CONVERSATION_KINDS].sort(), kinds.sort(), 'the same conversation kinds on both sides');
  assert.match(client, /return \(Number\(meta\.issueNumber\) > 0\) \|\| !!meta\.firstVersion \|\| meta\.kind === 'activity';/);
  // Every main-stream read in the chat with the bot leaves them out; a story keeps them.
  const source = read('src/services/conversations.js');
  assert.equal((source.match(/hydrateMessages\((?:pool|db), user, page, \{ cards \}\)/g) || []).length, 3, 'newest, newer and a permalink window');
  assert.match(source, /const \[hydratedRoot, messages\] = await Promise\.all\(\[\s*hydrateMessages\(pool, user, root\.rows\),\s*hydrateMessages\(pool, user, page\),/);
});
