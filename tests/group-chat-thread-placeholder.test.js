// #2498: a flat topic thread kept "No messages yet. Start the thread." on
// screen after you sent the first message, until the page was refreshed.
//
// ── What this pins ─────────────────────────────────────────────────────
//
// The line is published on the transcript LEAD by public/js/group-chat.js,
// which owns the thread's state. Sending has no optimistic render, so the
// websocket echo is what draws the first row, and that path is
// `appendTranscriptMessage` — which appends to `messages` and copies `lead`
// through untouched, exactly so a live message does not rebuild the
// transcript under the reader's scroll position. Nothing republished the
// lead, so the placeholder outlived the row that contradicted it and only
// went away on the next full `publishTranscript`: a remount, a refresh, or a
// history load.
//
// The fix is the one the quiet card already ran under: features/group-chat/
// transcript.tsx decides the line from the ROWS at render time rather than
// trusting the lead. So this pins the behaviour through the real seam —
// publish an empty thread, append one row the way the socket handler does,
// render — rather than the shape of the expression.
//
// Run with: node --test tests/group-chat-thread-placeholder.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const API = 'tests/fixtures/group-chat-transcript-api.ts';

const EMPTY_LINE = 'No messages yet. Start the thread.';

const base = {
  id: 1, kind: 'message', username: 'evan', time: '09:05 AM',
  timeTitle: 'Sep 16, 2026, 09:05 AM', bodyHtml: '<p>first one</p>', systemText: '',
  mine: true, editedTitle: null, unread: false, bookmarked: false, canEdit: false,
  flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
  reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  event: null, eventHref: null,
};

/** The flat thread's lead, as `GroupChat.renderThread` publishes it. */
const flatLead = (placeholder) => ({ earlier: false, placeholder, language: 'flat' });

/** Publish a thread, append rows through the live path, render what the store holds. */
function thread(placeholder, live) {
  const api = loadTsx(API);
  api.publishTranscript([], 'thread', flatLead(placeholder));
  const empty = api.transcriptStore.get().byKey.thread;
  const first = renderComponent(TRANSCRIPT, 'TranscriptRows', { view: empty, source: 'thread' });
  for (const msg of live) api.appendTranscriptMessage(msg, 'thread');
  const after = api.transcriptStore.get().byKey.thread;
  return {
    first,
    after: renderComponent(TRANSCRIPT, 'TranscriptRows', { view: after, source: 'thread' }),
    lead: after.lead,
  };
}

test('the first message clears the empty line, with no republished lead behind it', () => {
  const t = thread(EMPTY_LINE, [base]);
  // An empty thread still opens on the line, unchanged.
  assert.match(t.first, new RegExp(EMPTY_LINE.replace(/\./g, '\\.')));
  // And the message that lands on it takes the line with it.
  assert.doesNotMatch(t.after, /No messages yet/, 'the thread is no longer empty');
  assert.match(t.after, /<p>first one<\/p>/, 'the message is drawn');
  // The lead itself is untouched: the live append copies it through, which is
  // the property that let the line survive. The decision is the renderer's.
  assert.equal(t.lead.placeholder, EMPTY_LINE);
});

test('a message that beats the history fetch clears "Loading…" the same way', () => {
  const t = thread('Loading…', [base]);
  assert.match(t.first, /Loading…/);
  assert.doesNotMatch(t.after, /Loading…/);
});

test('a second message does not bring it back', () => {
  const t = thread(EMPTY_LINE, [base, { ...base, id: 2, bodyHtml: '<p>and another</p>' }]);
  assert.doesNotMatch(t.after, /No messages yet/);
  assert.match(t.after, /<p>and another<\/p>/);
});
