'use strict';

// ONE CHAT FOOT (1 November 2026).
//
// Under every transcript with a reply box Homeroom draws the same four
// siblings: the transcript's scroller, Jump to latest hung from its foot, the
// status line ("ada is typing…"), and the bar the composer's card sits in.
// Two implementations drew them, features/messages and features/group-chat,
// and spacing fixes kept landing in one and missing the other: the same day
// the typing line stopped holding 18px open in Messages, the group chat's
// stayed `h-5`, and its bar kept 4px over the card that Messages' had lost.
// So the foot is one primitive (@/components/ui/chat: the scroller's class
// `chat-transcript`, `ChatStatusLine`, `ChatComposerBar`) and one set of
// rules in app.css
// ("A chat's foot"). tests/transcript-meets-composer.test.js pins the
// numbers; this file pins that every chat draws its foot with it, and that a
// new chat that draws one of its own is caught.
//
// Not yet on it, and not chats of this kind: the dev chat
// (features/dev-chat/view.tsx), an agent session's composer
// (features/agent-session/index.tsx) and the Homeroom bot's ask bar. Each
// draws its own foot; they are the next candidates.
//
// Run with: node --test tests/chat-foot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, renderToHtml, createElement, loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const CHAT = 'frontend/@/components/ui/chat.tsx';
const SHELL = 'frontend/src/features/group-chat/thread-shell.tsx';
const GENERAL = 'frontend/src/features/group-chat/general-chat.tsx';
const MESSAGES = 'frontend/src/features/messages/index.tsx';
const MESSAGES_COMPOSER = 'frontend/src/features/messages/composer.tsx';
const NEW_THREAD = 'frontend/src/features/messages/new-thread.tsx';
const GC_COMPOSER = 'frontend/src/features/group-chat/composer.tsx';

// ── 1. The primitive ────────────────────────────────────────────────────

test('the primitive: a scroller class, a status line that is a live region, and the bar', () => {
  const chat = loadTsx(CHAT);
  assert.match(read(CHAT), /the transcript's scroller, wearing the class `chat-transcript`;/);
  assert.equal(
    renderToHtml(createElement(chat.ChatStatusLine, { id: 'x' })),
    '<div id="x" class="chat-status" aria-live="polite"></div>',
    'empty: no child at all, so `.chat-status:empty` takes its room',
  );
  assert.equal(
    renderToHtml(createElement(chat.ChatStatusLine, { className: 'messages-typing' }, 'ada is typing…')),
    '<div class="messages-typing chat-status" aria-live="polite">ada is typing…</div>',
  );
  assert.equal(
    renderToHtml(createElement(chat.ChatComposerBar, { className: 'messages-composer' })),
    '<div class="messages-composer chat-composer-bar platform-safe-bar"></div>',
  );
  assert.equal(
    renderToHtml(createElement(chat.ChatComposerBar, { as: 'form' })),
    '<form class="chat-composer-bar platform-safe-bar"></form>',
  );
});

// ── 2. The group chat's feet, rendered ──────────────────────────────────

// The scroller (whose hosts render empty), then Jump to latest over its foot
// where the layout has one, then the status line, then what stands at the
// foot: the bar, or the read-only notice that carries its clearance.
const OVERLAY = '<div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot">';
function foot(html, { overlay, typing, bar }) {
  const at = html.search(/class="[^"]*\bchat-transcript\b/);
  assert.ok(at > 0, 'the scroller wears chat-transcript');
  const after = html.slice(at).replace(/^[^>]*>(?:<div id="gc-thread-[a-z]+"[^>]*><\/div>)*<\/div>/, '');
  let rest = after;
  if (overlay) {
    assert.ok(rest.startsWith(OVERLAY), 'Jump to latest hangs from the scroller\'s foot, right after it');
    rest = rest.slice(rest.indexOf('</button></div></div>') + '</button></div></div>'.length);
  } else {
    assert.ok(!rest.startsWith(OVERLAY));
  }
  const status = `<div id="${typing}" class="chat-status" aria-live="polite"></div>`;
  assert.ok(rest.startsWith(status), `then the status line, empty: ${rest.slice(0, 120)}`);
  assert.match(rest.slice(status.length), bar, 'then the bar');
}

test('a project\'s channel: the chat foot, under the composer and under the read-only notice alike', () => {
  for (const readOnly of [false, true]) {
    const html = renderComponent(GENERAL, 'GeneralChat', { readOnly, notice: null, maxLength: 4000 });
    foot(html, { overlay: true, typing: 'gc-typing', bar: /^<div class="chat-composer-bar platform-safe-bar">/ });
  }
});

test('a topic\'s thread, a request\'s page, a change\'s page and the boxed thread: the chat foot', () => {
  const props = { withHeader: true, readOnly: false, notice: 'Read only.', placeholder: 'Reply', maxLength: 4000 };
  const layouts = [
    [{ fill: true }, /^<div class="chat-composer-bar platform-safe-bar"><div id="gc-thread-reply-preview"/],
    [{ fill: true, request: true }, /^<div class="messages-composer messages-composer-thread chat-composer-bar platform-safe-bar"><div id="gc-thread-reply-preview"/],
    [{ fill: true, change: true }, /^<div class="messages-composer messages-composer-thread chat-composer-bar platform-safe-bar"><div id="gc-thread-reply-preview"/],
  ];
  for (const [layout, bar] of layouts) {
    foot(renderComponent(SHELL, 'ThreadShell', { ...props, ...layout }), { overlay: true, typing: 'gc-thread-typing', bar });
    // Read-only, the notice stands in the bar's place and clears what it did.
    foot(renderComponent(SHELL, 'ThreadShell', { ...props, ...layout, readOnly: true }), {
      overlay: true, typing: 'gc-thread-typing', bar: /^<div class="[^"]*platform-safe-bar">Read only\.<\/div>/,
    });
  }
  // The boxed layout is a small inline box with no floating control.
  foot(renderComponent(SHELL, 'ThreadShell', { ...props, fill: false }), {
    overlay: false, typing: 'gc-thread-typing', bar: /^<div class="chat-composer-bar platform-safe-bar">/,
  });
});

test('the group chat\'s status line takes no size of its own', () => {
  const src = read(GC_COMPOSER);
  assert.match(src, /export function StatusLine\(\{ scope \}: \{ scope: ComposerScope \}\)/, 'no className to hand it a height');
  for (const file of [GENERAL, SHELL]) {
    const code = read(file);
    assert.doesNotMatch(code, /<StatusLine [^>]*className=/, `${file}: the status line is sized by .chat-status`);
    assert.doesNotMatch(code, /\bpt-1 pb-2\b/, `${file}: the bar's padding is .chat-composer-bar's`);
  }
});

// ── 3. Messages' feet, in source (they read a live store) ───────────────

function inOrder(src, marks, what) {
  let at = -1;
  for (const mark of marks) {
    const next = src.indexOf(mark, at + 1);
    assert.ok(next > at, `${what}: \`${mark}\` comes next`);
    at = next;
  }
}

function body(src, opener) {
  const at = src.indexOf(opener);
  assert.ok(at >= 0, opener);
  return src.slice(at, src.indexOf('\n}\n', at));
}

test('a conversation, its reply threads and a blank thread with Homeroom bot: the chat foot', () => {
  const src = read(MESSAGES);
  inOrder(body(src, 'function ConversationThread('), [
    'className="messages-thread-scroll platform-safe-scroll chat-transcript"',
    '<TranscriptOverlay edge="foot">',
    '<ChatStatusLine className="messages-typing">{typingLine(t, typing)}</ChatStatusLine>',
    '<MessageComposer />',
  ], 'a conversation');
  inOrder(body(src, 'function ReplyThreadPanel('), [
    'className="messages-thread-scroll messages-reply-scroll platform-safe-scroll chat-transcript"',
    '<JumpToLatest scroller={scroller} />',
    '<ChatStatusLine className="messages-typing">{typingLine(t, threadTyping)}</ChatStatusLine>',
    '<MessageComposer threadRootId={rootId} />',
  ], 'a reply thread');
  inOrder(read(NEW_THREAD), [
    'className="messages-thread-scroll messages-reply-scroll platform-safe-scroll flex flex-col justify-end chat-transcript"',
    '<ChatComposerBar as="form" className="messages-composer messages-composer-thread"',
  ], 'a blank thread');
  // The composer's bar is the primitive in each of its shapes; only "you
  // can't send here", a line in the card's place, names the clearance itself.
  const composer = read(MESSAGES_COMPOSER);
  assert.match(composer, /<ChatComposerBar className="messages-composer messages-composer-awaiting" data-awaiting-acceptance="">/);
  assert.match(composer, /<ChatComposerBar className=\{`messages-composer \$\{inThread \? 'messages-composer-thread' : ''\}/);
  assert.equal((composer.match(/platform-safe-bar/g) || []).length - (composer.match(/`platform-safe-bar`/g) || []).length, 1,
    'one hand-written clearance: the notice');
  assert.match(composer, /<div className="messages-composer-disabled platform-safe-bar">/);
});

// ── 4. Nothing draws a foot by hand ─────────────────────────────────────

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (/\.tsx$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('every chat that renders a composer is one of the chats on the foot, so a new one is caught', () => {
  // The pieces a chat's foot is built round: either composer, the group
  // chat's status line, the typing line's words, either composer's card.
  const PIECES = /<MessageComposer\b|<ComposerForm\b|<StatusLine scope=|typingLine\(|className="messages-composer-card|className="gc-composer-card/;
  const ON_THE_FOOT = new Set([MESSAGES, MESSAGES_COMPOSER, NEW_THREAD, GENERAL, SHELL, GC_COMPOSER]);
  // Drawn like a composer and not a chat's foot: the Homeroom bot tab's
  // "Ask Homeroom bot" bar is a link to Main, over the tab bar, with no
  // transcript above it.
  const NOT_A_FOOT = new Set(['frontend/src/features/ai/index.tsx']);
  const found = sources('frontend/src').filter((file) => PIECES.test(read(file)) && !NOT_A_FOOT.has(file));
  for (const file of found) {
    assert.ok(ON_THE_FOOT.has(file),
      `${file} draws a chat composer: give it the chat foot (@/components/ui/chat: \`chat-transcript\` `
      + 'on its scroller, ChatStatusLine, ChatComposerBar, and TranscriptOverlay edge="foot" or JumpToLatest) and list it here');
  }
  for (const file of ON_THE_FOOT) assert.ok(found.includes(file), `${file} is still a chat`);
  // And every file that lays a transcript above a composer gives its
  // scroller the class, as a literal (the kit adds `un-kb-avoid` to that
  // node, so its className must be plainly the same on every render).
  for (const file of [MESSAGES, NEW_THREAD, GENERAL, SHELL]) {
    assert.match(read(file), /className="[^"]*\bchat-transcript"/, file);
  }
  // No composer root draws the bar's class string by hand.
  for (const file of found) {
    assert.doesNotMatch(read(file), /<(div|form) className=\{?["`]messages-composer[ "`]/,
      `${file}: a composer's bar is ChatComposerBar`);
    assert.doesNotMatch(read(file), /<div className="messages-typing"/, `${file}: the typing line is ChatStatusLine`);
  }
});

test('app.css writes each measurement of the foot once', () => {
  const css = read('public/css/app.css');
  for (const selector of ['\n.chat-status {', '\n.chat-status:empty {', '\n.chat-composer-bar {', '\n.chat-transcript:has(~ .platform-safe-bar),']) {
    assert.equal(css.split(selector).length, 2, `one \`${selector.trim()}\``);
  }
  // The per-surface copies it replaced.
  assert.doesNotMatch(css, /\.messages-thread-scroll\.platform-safe-scroll:has\(/);
  assert.doesNotMatch(css, /\.messages-typing[ :{,]/);
  assert.doesNotMatch(css, /#gc-(thread-)?typing:empty/);
  assert.doesNotMatch(css, /\.messages-composer,\n\.messages-composer-disabled \{/);
});
