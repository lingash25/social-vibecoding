'use strict';

// iPhone Duo, 1 November 2026: scrolled up a chat, the messages were cut off
// 24px above the reply box, with bare page between. The band was outside the
// scroller: the "is typing" line holding 18px open while it said nothing, and
// 6px of the composer's own padding over its card. The transcript now runs to
// the card's edge, and the air under the newest message is the scroller's own
// end, which scrolls away with it.
//
// The same day the fix had to be made twice, once for Messages and once for
// the group chat, so the foot is one set of rules now ("A chat's foot",
// app.css and @/components/ui/chat): `.chat-transcript`, `.chat-status` and
// `.chat-composer-bar`. tests/chat-foot.test.js pins that every chat draws it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');

function rule(selectorLine) {
  const i = CSS.indexOf(`\n${selectorLine}`);
  assert.ok(i >= 0, `expected a rule starting \`${selectorLine}\``);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('an empty status line takes no room, and stays in the page', () => {
  const line = rule('.chat-status {');
  assert.match(line, /padding: 2px 16px;/);
  assert.match(line, /color: var\(--text-muted\);/);
  assert.match(line, /font-size: 13px;/);
  assert.match(line, /line-height: 18px;/);
  assert.doesNotMatch(line, /\n\s*(min-)?height:/, 'no height of its own: its text is its height');
  const body = rule('.chat-status:empty {');
  assert.match(body, /padding-block: 0;/);
  assert.doesNotMatch(body, /display: none/, 'its live region has to be there before a name arrives');
  // One rule, not one per surface: the copies it replaced are gone.
  assert.doesNotMatch(CSS, /\.messages-typing(:empty)? \{/);
  assert.doesNotMatch(CSS, /#gc-typing:empty|#gc-thread-typing:empty/);
  // A live region, in the primitive, so every chat's line announces.
  assert.match(read('frontend/@/components/ui/chat.tsx'),
    /<div \{\.\.\.props\} className=\{cn\(className, 'chat-status'\)\} aria-live="polite" \/>/);
  // Still a sibling of the scroller rather than a row inside it, so a name
  // shows whether or not the reader is at the bottom.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /<\/TranscriptOverlay>\n\s*<ChatStatusLine className="messages-typing">\{typingLine\(t, typing\)\}<\/ChatStatusLine>\n\s*<MessageComposer \/>/);
});

test('the composer bar has no padding over its card', () => {
  assert.match(rule('.chat-composer-bar {'), /padding: 0 12px 8px;/);
  // Messages' bar is that bar: its own rule keeps only what is its own.
  const own = rule('.messages-composer {');
  assert.match(own, /position: relative;/);
  assert.doesNotMatch(own, /padding/);
  // The notice of a first message is a line of text, not a card: it keeps
  // the air above it.
  assert.match(CSS, /\.messages-composer-hint \{ margin: 6px 4px 6px;/);
});

test('the air under the newest message is inside the scroller', () => {
  const body = rule('.chat-transcript:has(~ .platform-safe-bar),\n.chat-transcript.platform-safe-scroll:has(~ .platform-safe-bar) {');
  assert.match(body, /padding-bottom: 12px !important;/);
  // The second selector outranks the two `.platform-safe-scroll` rules that
  // zero the foot with the keyboard up, so the end is the same either way.
  assert.match(CSS, /\nhtml\.un-kb \.platform-safe-scroll \{\n  padding-bottom: 0 !important;/);
  assert.match(CSS, /\n  html\.platform-kb-open \.platform-safe-scroll \{\n    padding-bottom: 0 !important;/);
  // A request's and a change's stream add nothing under it: the 12px is
  // the scroller's.
  const stream = rule('#dev-topic-thread #gc-thread-messages:is([data-language="request"], [data-language="change"]) {');
  assert.match(stream, /\n  padding: 0;/);
});
