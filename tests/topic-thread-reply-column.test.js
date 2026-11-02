'use strict';

// #1901: on desktop the topic view's "Reply in thread" composer spanned the
// whole pane while the Discussion sheet above it is capped at 900px and
// centred, so the input looked detached from its thread. The typing line and
// the composer bar now take the same cap and centring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');
const SHELL = read('frontend/src/features/group-chat/thread-shell.tsx');

function rule(selectorLine) {
  const i = CSS.indexOf(`\n${selectorLine}`);
  assert.ok(i >= 0, `expected a rule starting \`${selectorLine}\``);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('the composer bar and typing line share the thread column', () => {
  const body = rule('#dev-topic-thread > .dev-thread > #gc-thread-typing,\n#dev-topic-thread > .dev-thread > .platform-safe-bar {');
  assert.match(body, /max-width: 900px;/);
  assert.match(body, /margin-inline-start: auto;/);
  assert.match(body, /margin-inline-end: auto;/);
  assert.match(body, /width: 100%;/);
});

test('900px is the same cap the Discussion sheet and topic content use', () => {
  assert.match(rule('#dev-topic-thread #gc-thread-messages {'), /max-width: 900px;/);
  assert.match(rule('.dev-topic {'), /max-width: 900px;/);
});

test('the selectors match what the thread shell renders as direct children', () => {
  // Fill mode: .dev-thread > #gc-thread-scroll, the status line, the bar.
  // The bar is the chat foot's (1 November 2026), which carries the class
  // the cap selects on; the read-only notice that replaces it names it.
  assert.match(SHELL, /<StatusLine scope="thread" \/>/);
  assert.match(SHELL, /const SAFE_BAR = 'platform-safe-bar';/);
  assert.match(SHELL, /return \(\n\s*<ChatComposerBar>\n\s*<ComposerSlots scope="thread" \/>/);
  assert.match(read('frontend/@/components/ui/chat.tsx'), /'chat-composer-bar platform-safe-bar'/);
  assert.match(read('frontend/src/features/group-chat/composer.tsx'), /typing: 'gc-thread-typing'/);
});
