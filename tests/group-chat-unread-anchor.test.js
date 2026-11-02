'use strict';
// A project's channel opens at its first unread message, as a conversation in
// Messages does (tests/messages-unread-anchor.test.js pins the shared rules in
// frontend/src/features/messages/unread-anchor.ts).
//
// The channel's rows and its scrolling are public/js/group-chat.js's; its
// transcript, pane and the measuring are React's. Pinned here, end to end:
//   1. the server's first page says where reading stood
//      (src/services/app-chat.js readPosition, src/routes/chat.js);
//   2. the module takes that mark from the first page before it reads the
//      channel, publishes it with the rows, opens at the line once, and lets
//      it go when the pane closes;
//   3. the transcript draws the "New" line
//      (frontend/src/features/group-chat/transcript.tsx);
//   4. the React side moves the stream to the line and says so
//      (frontend/src/features/group-chat/mount.ts openAtUnreadLine);
//   5. the pane's banner counts from that opening
//      (frontend/src/features/group-chat/general-chat.tsx).
//
// Run with: node --test tests/group-chat-unread-anchor.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const GENERAL = 'frontend/src/features/group-chat/general-chat.tsx';

// ── 1. The server ───────────────────────────────────────────────────────

test('the first page of the stream says where the reader\'s reading stood, and how much is behind it', async () => {
  const appChat = require('../src/services/app-chat');
  const pool = (cursor) => ({
    async query(sql, params) {
      if (/SELECT last_read_message_id FROM app_chat_reads/.test(sql)) {
        assert.deepEqual(params, [3, 7]);
        return { rows: cursor === undefined ? [] : [{ last_read_message_id: cursor }] };
      }
      if (/COUNT\(\*\)::int AS unread_count/.test(sql)) return { rows: [{ unread_count: 4 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  });
  assert.deepEqual(await appChat.readPosition(pool(120), 3, 7), { lastReadMessageId: 120, unreadCount: 4 });
  assert.deepEqual(await appChat.readPosition(pool(0), 3, 7), { lastReadMessageId: 0, unreadCount: 4 });
  assert.equal(await appChat.readPosition(pool(undefined), 3, 7), null, 'no cursor: not a reader of this channel');
  assert.equal(await appChat.readPosition(pool(1), null, 7), null);

  const route = read('src/routes/chat.js');
  assert.match(route, /if \(!thread && before == null && after == null && around == null\) \{\s*const read = await appChat\.readPosition\(pool, appId, viewerId\);\s*if \(read\) body\.read = \{ last_read_message_id: read\.lastReadMessageId, unread_count: read\.unreadCount \};\s*\}/,
    'the general stream\'s first page only: an earlier page, a thread or a permalink window is no opening');
  // #4417: and a topic's channel says the same about its own cursor, on its
  // own first page.
  assert.match(route, /if \(topicChannel\) \{[\s\S]*?if \(before == null && after == null && around == null\) \{\s*const read = await appChat\.categoryReadPosition\(pool, appId, thread\.ref, viewerId\);\s*if \(read\) body\.read = \{ last_read_message_id: read\.lastReadMessageId, unread_count: read\.unreadCount \};\s*\}\s*\}\s*res\.json\(body\);/);
});

// ── 2. The module ───────────────────────────────────────────────────────

function harness({ lockedToBottom = true, line = true, reveal = null, lineAfterFlush = false } = {}) {
  const requests = [];
  const opened = [];
  const published = [];
  let flushed = false;
  const container = {
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 600,
    querySelector: (selector) => (selector === '[data-unread-line]' && line && (!lineAfterFlush || flushed) ? {} : null),
  };
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: (id) => (id === 'gc-messages' ? container : null), visibilityState: 'hidden' },
    fetch: (url) => new Promise((resolve) => requests.push({ url, resolve })),
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'plant-pal';
  gc._demoParam = () => '';
  gc._messageView = (msg) => ({ id: msg.id });
  gc._loadBotCards = async () => {};
  gc._pendingReveal = reveal;
  gc._applyPendingReveal = () => { if (reveal) gc._lockedToBottom = false; };
  gc.scrollToBottom = () => { gc._lockedToBottom = true; container.scrollTop = 3400; };
  gc._lockedToBottom = lockedToBottom;
  gc._react = () => ({
    mountTranscript() {},
    publishTranscript(rows, key, lead, opts) {
      flushed = flushed || !!opts.flush;
      published.push({ rows: rows.map((r) => r.id), key, unread: lead.unread, flush: !!opts.flush });
    },
    openAtUnreadLine(el) {
      if (!el.querySelector('[data-unread-line]')) return null;
      opened.push(el);
      el.scrollTop = 1436;
      return { top: 1436, pinned: false };
    },
  });
  const page = (body) => requests.at(-1).resolve({ ok: true, json: async () => body });
  return { gc, requests, opened, published, container, page };
}

const messages = [{ id: 10 }, { id: 11 }, { id: 12 }];

test('the first page\'s mark is taken before the channel is read, published with the rows, and opened at once', async () => {
  const h = harness();
  const load = h.gc.loadHistory();
  h.page({ messages, read: { last_read_message_id: 10, unread_count: 2 } });
  await load;
  assert.deepEqual(JSON.parse(JSON.stringify(h.gc._unreadMark)), { lastReadId: 10, count: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.published.at(-1))), { rows: [10, 11, 12], key: 'main', unread: { lastReadId: 10, count: 2 }, flush: true },
    'the rows and the mark land together, flushed, before anything measures');
  assert.equal(h.opened.length, 1, 'opened at the line');
  assert.equal(h.gc._lockedToBottom, false, 'up the stream: a new message does not yank the reader');
  assert.equal(h.gc._savedScrollTop, 1436);

  // An earlier page is not an opening.
  const earlier = h.gc.loadHistory();
  assert.match(h.requests.at(-1).url, /before=10/);
  h.page({ messages: [{ id: 8 }, { id: 9 }], read: { last_read_message_id: 12, unread_count: 0 } });
  await earlier;
  assert.equal(h.gc._unreadMark.lastReadId, 10, 'the line stays where the opening put it');
  assert.equal(h.opened.length, 1);
});

test('nothing unread, an older server, or no line drawn: the stream opens at the bottom as before', async () => {
  for (const read of [{ last_read_message_id: 12, unread_count: 0 }, undefined]) {
    const h = harness();
    const load = h.gc.loadHistory();
    h.page({ messages, ...(read ? { read } : {}) });
    await load;
    assert.equal(h.gc._unreadMark, null);
    assert.equal(h.published.at(-1).unread, null);
    assert.equal(h.opened.length, 0);
    assert.equal(h.gc._lockedToBottom, true);
  }
  const blank = harness({ line: false });
  blank.gc._react = () => ({ mountTranscript() {}, publishTranscript() {}, openAtUnreadLine: () => null });
  const load = blank.gc.loadHistory();
  blank.page({ messages, read: { last_read_message_id: 10, unread_count: 2 } });
  await load;
  assert.equal(blank.gc._lockedToBottom, true, 'no line on the page: still at the bottom, still following');
});

test('a line at the very top of the first page does not page back at once and carry it away', async () => {
  const h = harness();
  h.gc._react = () => ({
    mountTranscript() {},
    publishTranscript() {},
    openAtUnreadLine(el) { el.scrollTop = 0; return { top: 0, pinned: false }; },
  });
  const load = h.gc.loadHistory();
  h.page({ messages: Array.from({ length: 50 }, (_, i) => ({ id: 100 + i })), read: { last_read_message_id: 20, unread_count: 80 } });
  await load;
  assert.equal(h.gc.hasMore, true);
  assert.equal(h.container.scrollTop, 1, 'a pixel down: the listener pages back only when the reader scrolls up');
  assert.equal(h.gc._savedScrollTop, 1);
});

test('a message the bell sent the reader to wins over the line', async () => {
  const h = harness({ reveal: { slug: 'plant-pal', id: 11, at: Date.now() } });
  const load = h.gc.loadHistory();
  h.page({ messages, read: { last_read_message_id: 10, unread_count: 2 } });
  await load;
  assert.equal(h.opened.length, 0);
  assert.equal(h.gc._unreadOpened, true, 'and the line does not take over later');
});

test('a channel already connected opens at its line when its pane is shown; the line goes when the pane closes', () => {
  const h = harness({ lineAfterFlush: true }); // a remount publishes batched
  const ws = { readyState: 1 };
  h.gc.ws = ws;
  h.gc.appSlug = 'plant-pal';
  h.gc._didInitialScroll = true;
  h.gc.attachScrollHandlers = () => {};
  h.gc._initSpecPanelResizer = () => {};
  h.gc._restoreSpecPanelIfSaved = () => {};
  h.gc._takeUnreadMark({ last_read_message_id: 10, unread_count: 2 }); // a topic's thread loaded the first page
  h.gc.mount('plant-pal');
  assert.equal(h.opened.length, 1);
  assert.ok(h.published.some((p) => p.flush), 'the remount\'s rows put on the page before the line is looked for');
  h.gc.mount('plant-pal');
  assert.equal(h.opened.length, 1, 'once per mark');

  h.gc.releaseUnreadHold('plant-pal');
  assert.equal(h.gc._unreadMark, null);
  assert.equal(h.gc._unreadOpened, false);
  h.gc.releaseUnreadHold('another-app');
  h.gc.render();
  assert.equal(h.published.at(-1).unread, null, 'opened again, it opens as it always did');
});

test('the module\'s wiring, in order', () => {
  const src = read('public/js/group-chat.js');
  assert.match(src, /const body = await res\.json\(\);\s*const \{ messages \} = body;/);
  assert.match(src, /if \(isFirstLoad\) GroupChat\._takeUnreadMark\(body && body\.read\);[\s\S]{0,700}GroupChat\.render\(\{ flush: true \}\);/,
    'taken before the rows are published');
  assert.match(src, /GroupChat\.scrollToBottom\(\);\s*GroupChat\._didInitialScroll = true;\s*GroupChat\._applyPendingReveal\(\);\s*\/\/[^\n]*\n\s*GroupChat\._openAtUnread\(\);[\s\S]{0,300}void GroupChat\.markRead\(\);/,
    'after the bell\'s reveal, before the read');
  assert.match(src, /GroupChat\._unreadMark = null;\s*GroupChat\._unreadOpened = false;\s*GroupChat\._longPressed = false;/, 'connect() starts afresh');
  assert.match(src, /unread: GroupChat\._unreadMark \|\| null,/);
});

// ── 3. The transcript draws the line ────────────────────────────────────

const base = {
  kind: 'message', username: 'alice', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  bodyHtml: '<p>hi</p>', systemText: '', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: false, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null, senderId: 3,
};
const row = (id, over = {}) => ({ ...base, id, bodyHtml: `<p>m${id}</p>`, ...over });
const renderRows = (view, source = 'main') => renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view, source }));
const lead = (unread) => ({ earlier: false, placeholder: null, unread });

test('the "New" line goes above the first message after the mark that somebody else wrote', () => {
  const rows = [row(10), row(11, { mine: true, senderId: 7 }), row(12), row(13)];
  const html = renderRows({ messages: rows, lead: lead({ lastReadId: 10, count: 2 }) });
  const line = html.indexOf('data-unread-line=""');
  assert.ok(line > html.indexOf('m11') && line < html.indexOf('m12'), 'your own message is not where unread begins');
  assert.equal((html.match(/data-unread-line=""/g) || []).length, 1, 'drawn once');

  assert.doesNotMatch(renderRows({ messages: rows, lead: lead(null) }), /data-unread-line/, 'nothing unread: no line');
  assert.doesNotMatch(renderRows({ messages: rows, lead: lead({ lastReadId: 13, count: 1 }) }), /data-unread-line/,
    'nothing after the mark drawn: no line');
  assert.doesNotMatch(renderRows({ messages: rows, lead: { ...lead({ lastReadId: 10, count: 2 }), language: 'flat' } }, 'thread'), /data-unread-line/,
    'a thread\'s transcript draws none');
});

test('a system line has no author and is never where unread begins', () => {
  const rows = [row(10), row(11, { kind: 'system', senderId: null, systemText: 'a notice' }), row(12)];
  const html = renderRows({ messages: rows, lead: lead({ lastReadId: 10, count: 1 }) });
  assert.ok(html.indexOf('data-unread-line=""') < html.indexOf('m12'));
  assert.ok(html.indexOf('data-unread-line=""') > html.indexOf('m10'));
});

// ── 4. The React side opens it ──────────────────────────────────────────

test('openAtUnreadLine moves the stream to the line, holds it, and counts the opening', () => {
  const mount = loadTsx('frontend/src/features/group-chat/mount.ts');
  const store = loadTsx('frontend/src/features/group-chat/transcript-store.ts');
  assert.equal(mount.openAtUnreadLine(null), null);
  const listeners = new Map();
  const line = { getBoundingClientRect: () => ({ top: 100 + 1500 - container.scrollTop }) };
  const container = {
    scrollTop: 3400, scrollHeight: 4000, clientHeight: 600, children: [],
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: (selector) => (selector === '[data-unread-line]' ? line : null),
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const at = mount.openAtUnreadLine(container);
  assert.deepEqual(at, { top: 1436, pinned: false });
  assert.equal(container.scrollTop, 1436, 'the line 64px under the top');
  assert.ok(listeners.has('scroll') && listeners.has('touchstart'), 'held until the reader takes over');
  assert.equal(typeof store.unreadOpenings.get().count, 'number');

  const src = read('frontend/src/features/group-chat/mount.ts');
  assert.match(src, /unreadOpenings\.set\(\(s: \{ count: number \}\) => \(\{ count: s\.count \+ 1 \}\)\);/);
  assert.match(src, /slack: GENERAL_FOLLOW_PX,/, 'at the bottom within the channel\'s own allowance');
  assert.match(src, /openAtUnreadLine,\s*\};/, 'on the seam the module calls by name');
});

// ── 5. The pane ─────────────────────────────────────────────────────────

test('the pane counts from the opening, beside the stream, and draws nothing with nothing unread', () => {
  const src = read(GENERAL);
  assert.match(src, /<ChannelUnreadBanner scroller=\{messages\} \/>\s*<div ref=\{messages\} id="gc-messages" className="flex-1 overflow-y-auto pt-2 space-y-0\.5 chat-transcript" \/>\s*<ChannelJumpToLatest scroller=\{messages\} \/>/);
  assert.match(src, /offerBanner: opened !== atMount,/);
  assert.match(src, /markKey: unread \? `\$\{unread\.lastReadId\}:\$\{opened\}` : '',/, 'the opening starts the banner afresh');
  assert.match(src, /if \(!unread\) return null;/);
  assert.match(src, /<NewMessagesBanner shown=\{view\.banner\} onClick=\{toLine\}>\{newMessagesLabel\(unread\.count\)\}<\/NewMessagesBanner>/);
  const html = renderToHtml(createElement(loadTsx(GENERAL).GeneralChat, { introAppName: null, readOnly: false, notice: null, maxLength: 4000 }));
  assert.doesNotMatch(html, /data-unread-banner/, 'a cold pane has nothing to count');
  assert.match(html, /data-jump-latest=""/);
});
