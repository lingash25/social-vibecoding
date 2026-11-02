'use strict';

// #6071 follow-up: a new thread with Homeroom bot, from its "+"
// (frontend/src/features/messages/new-thread.tsx), without a database (the
// thread itself is made against PostgreSQL in
// private-threads-postgres.test.js; 1 Nov 2026, a screen drawn in it in
// design-threads-postgres.test.js).
//
// What this pins:
//   1. The "+" is in the Homeroom bot tab's header and in the bot chat's
//      header in Messages, and is nothing without the chat it opens beside.
//   2. The blank thread's first render reads nothing and saves nothing: its
//      welcome block offers Any project and Any kind of change, and says a
//      change can be started there or just typed into the chat.
//   3. The thread is made on the first send, through a same-origin door.
//   4. A started thread is headed by its kind of change and its project, and
//      in the Homeroom bot tab the blank thread takes Main Chat's place.
//   5. 1 Nov 2026: Design a screen says to describe it, and Homeroom bot
//      draws it: no screen to pick.
//
// Run with: node --test tests/bot-new-thread.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NEW_THREAD = 'frontend/src/features/messages/new-thread.tsx';

function load() {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return new Promise(() => {}); } });
  const mod = loadTsx(NEW_THREAD, {
    stubs: {
      './api': api,
      './store': { closeThread: () => calls.push(['closeThread']), openThread: () => {} },
    },
  });
  return { mod, calls };
}

test('the "+" is in both headers, and is nothing without the chat it opens beside', () => {
  const { mod } = load();
  assert.equal(renderToHtml(createElement(mod.NewThreadButton, { conversationId: null, className: 'x' })), '');
  const html = renderToHtml(createElement(mod.NewThreadButton, { conversationId: 7, className: 'messages-thread-action' }));
  const label = message('messages:newThread.start');
  assert.match(html, new RegExp(`^<button type="button" class="messages-thread-action" aria-label="${label}" title="${label}" data-bot-new-thread="">`));
  assert.match(html, /<svg/);
  const ai = read('frontend/src/features/ai/index.tsx');
  const hero = ai.slice(ai.indexOf('const hero = ('), ai.indexOf('</section>', ai.indexOf('const hero = (')));
  assert.match(hero, /<NewThreadButton\n\s+conversationId=\{botId \|\| null\}\n\s+onOpen=\{openBlank\}/, 'in the Homeroom bot tab\'s header');
  const messages = read('frontend/src/features/messages/index.tsx');
  assert.match(messages, /\{botDm \? <NewThreadButton conversationId=\{active\.id\} className="messages-thread-action" \/> : null\}/, 'and the bot chat\'s in Messages');
});

test('the blank thread reads nothing and saves nothing in its first render, and offers any project and any kind', () => {
  const { mod, calls } = load();
  const html = renderToHtml(createElement(mod.NewThreadPanel, { conversationId: 7 }));
  assert.deepEqual(calls, [], 'no request, and no thread made, by opening it');
  assert.match(html, /data-bot-new-thread-pane=""/);
  assert.match(html, new RegExp(`<option value="" selected="">${message('messages:newThread.anyProject')}</option>`));
  assert.match(html, new RegExp(`<option value="any" selected="">${message('messages:newThread.kinds.any')}</option>`));
  for (const kind of ['fix', 'add', 'design']) assert.match(html, new RegExp(`<option value="${kind}">`));
  assert.equal(message('messages:newThread.hint'), 'Start a change here, or just type what you want into the chat.');
  assert.match(html, new RegExp(message('messages:newThread.hint').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /data-bot-new-thread-draws/, 'the drawing hint only once Design a screen is picked');
  assert.deepEqual([...mod.CHANGE_KINDS], ['any', 'fix', 'add', 'design']);
  const server = require('../src/services/private-threads');
  assert.deepEqual(Object.keys(server.CHANGE_KINDS), [...mod.CHANGE_KINDS], 'the kinds the server knows');
});

test('the thread is made on the first send, through a same-origin door, and the message goes into it', () => {
  const src = read(NEW_THREAD);
  assert.match(src, /const made = await api\.startBotThread\(\{ project: project \|\| null, kind \}\);\n\s+await api\.sendMessage\(conversationId, \{ content, threadRootId: made\.rootId, idempotencyKey: key\(\) \}\);\n\s+closeNewThread\(\);\n\s+openThread\(made\.rootId\);/);
  assert.match(read('frontend/src/features/messages/api.ts'), /request<unknown>\('\/api\/conversations\/homeroom-bot\/new-thread', \{ method: 'POST'/);
  assert.match(read('src/routes/conversations.js'), /router\.post\('\/api\/conversations\/homeroom-bot\/new-thread', conversationActionLimiter, sameOriginBrowserOnly,/);
});

test('a started thread is headed by what it is for, never as a request, and takes Main Chat\'s place in the tab', () => {
  const { mod } = load();
  const t = (id) => message(id);
  assert.equal(mod.startedThreadTitle(t, 'fix'), 'Fix something broken');
  assert.equal(mod.startedThreadTitle(t, 'design'), 'Design a screen');
  assert.equal(mod.startedThreadTitle(t, undefined), message('messages:newThread.title'));
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const started = rootMeta\?\.kind === 'opened_thread' \? rootMeta : null;\n\s+const request = rootMeta && !started \? botRequestNames\(rootMeta\) : null;/);
  assert.match(read('frontend/src/features/messages/api.ts'), /\{ changeKind: String\(pick\(bot, 'changeKind'\)\)/, 'the kind survives the client\'s reading of the metadata');
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout-embedded\.messages-has-blank-thread > \.messages-thread-pane \{ display: none; \}/);
  assert.match(css, /\.messages-layout-embedded\.messages-has-blank-thread > \.messages-reply-pane \{ flex: 1 1 auto; margin-inline-start: 0; \}/);
  // On a phone its composer keeps clear of the tab bar, as a thread's does.
  // The chat foot's bar, as a form (1 November 2026), which brings the class.
  assert.match(read(NEW_THREAD), /<ChatComposerBar as="form" className="messages-composer messages-composer-thread"/);
});

test('Design a screen says to describe it, and Homeroom bot draws it: no screen to pick', () => {
  assert.equal(message('messages:newThread.draws'), 'Describe the screen and Homeroom bot draws it.');
  const src = read(NEW_THREAD);
  assert.match(src, /\{kind === 'design' \? \(\n\s+<p className="text-\[13px\] text-zinc-600 dark:text-zinc-300" data-bot-new-thread-draws="">\n\s+\{t\('messages:newThread\.draws'\)\}/);
  assert.doesNotMatch(src, /startScreenPick|pickScreen|<Button/, 'the screen picker retired');
  assert.throws(() => message('messages:newThread.pickScreen'));
});
