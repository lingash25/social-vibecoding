// #2145 — the Activity feed's reply box answers ⌘/Ctrl+Enter and suggests
// people on `@`.
//
// ── What is pinned, and why it is pinned this way ─────────────────────
//
// The feed's composer (features/dev-board/card/feed-thread.tsx) was the one
// reply box on the platform with no keyboard send at all: the dev chat, Close
// issue and Send feedback take ⌘/Ctrl+Enter, the chat composers take Enter,
// and this one took only its arrow. It also had no `@` list, while the chat
// composer a card's topic page opens has had one since #87.
//
// The list is the chat's in every part that can be shared — the endpoint,
// the token grammar the server's MENTION_RE also uses, the rows — and React's
// in every part that cannot (see mention-typeahead.tsx's header). The suite
// has no DOM, so the behaviour lives in exported pure functions and is driven
// here directly; the wiring around them is pinned as source, in the style of
// tests/activity-reply-composer.test.js.
//
// Run with: node --test tests/feed-reply-mentions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const FEED = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const TYPEAHEAD = read('frontend/src/features/dev-board/card/mention-typeahead.tsx');
const GC_JS = read('public/js/group-chat.js');
const APP_VIEW = read('public/js/app-view.js');
const NOTIFICATIONS = read('src/services/notifications.js');
const WS = read('src/services/ws.js');
const CSS = read('public/css/app.css');

let feedApi = null;
const feed = () => feedApi || (feedApi = loadTsx('frontend/src/features/dev-board/card/feed-thread.tsx'));
let taApi = null;
const ta = () => taApi || (taApi = loadTsx('frontend/src/features/dev-board/card/mention-typeahead.tsx'));

const composer = () => FEED.slice(
  FEED.indexOf('export function FeedReplyComposer'),
  FEED.indexOf('\nexport function FeedThread'),
);

// ── ⌘/Ctrl+Enter ────────────────────────────────────────────────────

test('⌘/Ctrl+Enter is the send chord; plain, Shift and any other key are not', () => {
  const { isSendChord } = feed();
  assert.equal(isSendChord({ key: 'Enter', metaKey: true, ctrlKey: false }), true, 'macOS');
  assert.equal(isSendChord({ key: 'Enter', metaKey: false, ctrlKey: true }), true, 'everywhere else');
  assert.equal(isSendChord({ key: 'Enter', metaKey: false, ctrlKey: false }), false,
    'plain Enter stays a newline');
  assert.equal(isSendChord({ key: 'a', metaKey: true, ctrlKey: false }), false);
});

test('the chord submits a non-empty draft and does nothing while posting or empty', () => {
  const src = composer();
  // The list's keys come first: an open menu owns Enter.
  assert.match(src, /if \(mention\.onKeyDown\(e\)\) return;/);
  // Then the chord — preventDefault unconditionally (#920: the keystroke must
  // never leave a stray newline as its only visible effect), and submit only
  // through the same gate the arrow is disabled by.
  assert.match(src,
    /if \(!isSendChord\(e\)\) return;[\s\S]{0,400}?e\.preventDefault\(\);\s*if \(!posting && draft\.trim\(\)\) void onSubmit\(\);/);
  assert.match(src, /disabled=\{posting \|\| !draft\.trim\(\)\}/, 'the arrow keeps the same gate');
  // An IME confirmation is never a send.
  assert.match(src, /if \(e\.nativeEvent\.isComposing\) return;/);
});

test('the two chat composers take the same chord, on touch too', () => {
  // Desktop already sent on Enter; the chord is what makes a hardware
  // keyboard on a touch screen able to send at all. The inline message
  // editor is not a reply box and keeps its Enter-saves rule as it was.
  const thread = /if \(e\.key !== 'Enter'\) return;\s*if \(\(e\.metaKey \|\| e\.ctrlKey\) \|\| \(!e\.shiftKey && !GroupChat\._isTouch\(\)\)\) \{\s*e\.preventDefault\(\);\s*submitThread\(\);/;
  const general = /if \(e\.key !== 'Enter'\) return;\s*if \(\(e\.metaKey \|\| e\.ctrlKey\) \|\| \(!e\.shiftKey && !GroupChat\._isTouch\(\)\)\) \{\s*e\.preventDefault\(\);\s*submitGeneral\(\);/;
  assert.match(GC_JS, thread, 'the topic thread composer');
  assert.match(APP_VIEW, general, 'the general chat composer');
  assert.match(GC_JS,
    /if \(e\.key === 'Enter' && !e\.shiftKey && !GroupChat\._isTouch\(\)\) \{\s*e\.preventDefault\(\);\s*GroupChat\._saveEdit/,
    'the inline editor is untouched');
});

// ── The `@` list ────────────────────────────────────────────────────

test('typing @ev finds the people whose names start with it', () => {
  const { detectMentionToken, filterMentionCandidates, MENTION_MAX_RESULTS } = ta();
  assert.deepEqual(detectMentionToken('hello @ev', 9), { start: 6, query: 'ev' });
  assert.deepEqual(detectMentionToken('ping @', 6), { start: 5, query: '' },
    'a bare @ opens the whole list');
  assert.deepEqual(detectMentionToken('@ev later', 3), { start: 0, query: 'ev' },
    'text after the caret is not part of the token');
  assert.equal(detectMentionToken('@ev later', 9), null, 'the caret has left the token');
  assert.equal(detectMentionToken('mail@ev', 7), null,
    'no boundary before the @ — the server would not read it as a mention either');
  assert.equal(detectMentionToken(`@${'a'.repeat(33)}`, 34), null, 'past the 32-char cap');
  assert.equal(detectMentionToken('@ev', 5), null, 'a caret outside the text');

  const people = ['alice', 'Evan', 'evelyn', 'bob', 'steve'];
  assert.deepEqual(filterMentionCandidates(people, 'ev'), ['Evan', 'evelyn'],
    'a prefix match, case-insensitive, in the canonical casing the server knows');
  assert.deepEqual(filterMentionCandidates(people, 'EVE'), ['evelyn']);
  assert.deepEqual(filterMentionCandidates(people, ''), people, 'nothing typed yet lists everyone');
  assert.deepEqual(filterMentionCandidates(people, 'zed'), [], 'no match, so the list closes');
  const many = Array.from({ length: 80 }, (_, i) => `user${i}`);
  assert.equal(filterMentionCandidates(many, 'user').length, MENTION_MAX_RESULTS, 'capped');
});

test('picking a suggestion inserts @evan and puts the caret after it', () => {
  const { spliceMention } = ta();
  assert.deepEqual(spliceMention('hello @ev there', 6, 9, 'evan'),
    { value: 'hello @evan  there', caret: 12 },
    'the token is replaced by the name and a trailing space; what followed the caret stays');
  assert.deepEqual(spliceMention('@ev', 0, 3, 'evan'), { value: '@evan ', caret: 6 });
  assert.deepEqual(spliceMention('cc @', 3, 4, 'alice'), { value: 'cc @alice ', caret: 10 });
});

test('the grammar is the server’s and the chat’s, character for character', () => {
  // A suggestion that inserts a string MENTION_RE will not parse is worse
  // than no suggestion: nobody gets notified. All three derive one class.
  const { MENTION_CHARS, MENTION_MAX_LEN } = ta();
  assert.equal(MENTION_CHARS, 'A-Za-z0-9_');
  assert.equal(MENTION_MAX_LEN, 32);
  assert.match(NOTIFICATIONS, /const MENTION_RE = \/\(\^\|\[\^\\w\]\)@\(\[A-Za-z0-9_\]\{1,32\}\)\/g;/);
  assert.match(GC_JS, /MENTION_CHARS: 'A-Za-z0-9_',/);
  assert.match(GC_JS, /MAX_LEN: 32,/);
});

test('the list is the group chat’s endpoint, fetched once per app and shared', async () => {
  const api = ta();
  const calls = [];
  const realFetch = globalThis.fetch;
  const respond = (body, ok = true) => async (url) => {
    calls.push(url);
    return { ok, json: async () => body };
  };
  try {
    api.resetMentionCache();
    globalThis.fetch = respond({ users: [{ username: 'alice' }, { username: 'evan' }, { nope: 1 }] });
    assert.equal(api.mentionSuggestionsPath('usernode-2d5619'), '/api/apps/usernode-2d5619/mention-suggestions');
    assert.equal(api.mentionSuggestionsPath('a b'), '/api/apps/a%20b/mention-suggestions');

    // Two composers ask at once: one request, both get the answer.
    const [a, b] = await Promise.all([
      api.loadMentionCandidates('usernode-2d5619'),
      api.loadMentionCandidates('usernode-2d5619'),
    ]);
    assert.deepEqual(a, ['alice', 'evan']);
    assert.equal(b, a);
    assert.deepEqual(calls, ['/api/apps/usernode-2d5619/mention-suggestions']);
    // …and a third, later, reads the cache.
    assert.deepEqual(api.cachedMentionCandidates('usernode-2d5619'), ['alice', 'evan']);
    assert.deepEqual(await api.loadMentionCandidates('usernode-2d5619'), ['alice', 'evan']);
    assert.equal(calls.length, 1);
    assert.equal(api.cachedMentionCandidates('usernode-2d5619', Date.now() + api.MENTION_CACHE_TTL_MS + 1), null,
      'the list goes stale after the chat menu’s two minutes');

    // A refusal is an empty list, kept: it will not change within the TTL.
    api.resetMentionCache();
    globalThis.fetch = respond({ error: 'App not found' }, false);
    assert.deepEqual(await api.loadMentionCandidates('private-app'), []);
    assert.deepEqual(api.cachedMentionCandidates('private-app'), []);

    // A failed fetch is an empty list, NOT kept: the next `@` retries.
    api.resetMentionCache();
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await api.loadMentionCandidates('usernode-2d5619'), []);
    assert.equal(api.cachedMentionCandidates('usernode-2d5619'), null);
  } finally {
    globalThis.fetch = realFetch;
    api.resetMentionCache();
  }
});

test('Escape closes; the arrows move; Enter and Tab take the highlighted row', () => {
  const { menuKeyFor } = ta();
  assert.equal(menuKeyFor('Escape'), 'close');
  assert.equal(menuKeyFor('ArrowDown'), 'down');
  assert.equal(menuKeyFor('ArrowUp'), 'up');
  assert.equal(menuKeyFor('Enter'), 'accept');
  assert.equal(menuKeyFor('Tab'), 'accept');
  for (const key of ['a', 'Backspace', ' ', 'ArrowLeft', 'Shift']) {
    assert.equal(menuKeyFor(key), null, `${key} is the textarea’s`);
  }
  // Only an OPEN list consumes them, and it consumes them fully — the form
  // must not also submit, and the row's own key handling must not also run.
  const hook = TYPEAHEAD.slice(TYPEAHEAD.indexOf('const onKeyDown = useCallback'));
  assert.match(hook, /if \(!items\.length\) return false;/);
  assert.match(hook, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  assert.match(hook, /if \(key === 'close'\) close\(\);/);
  // Leaving the field closes it; an IME composition never opens it.
  assert.match(composer(), /onBlur=\{\(\) => \{ mention\.close\(\); refs\.close\(\); \}\}/);
  assert.match(TYPEAHEAD, /if \(!el \|\| composing\.current\) return;/);
});

test('the list renders the chat menu’s rows, and nothing at all when closed', () => {
  const { FeedMentionMenu } = ta();
  const html = (props) => renderToHtml(createElement(FeedMentionMenu, {
    below: false, menuRef: { current: null }, onPick() {}, ...props,
  }));
  // Closed draws nothing: a row's markup is exactly what it was until
  // somebody types `@`, which is what keeps the declared #1584 check and
  // the like-for-like rule true.
  assert.equal(html({ items: [], active: -1 }), '');

  const open = html({ items: ['alice', 'evan'], active: 1 });
  assert.match(open,
    /<div class="gc-mention-menu dev-feed-mention-menu" role="listbox" aria-label="Mention someone" data-feed-mention-menu="">/);
  assert.equal((open.match(/class="gc-mention-option(?: |")/g) || []).length, 2, 'one row per name');
  assert.match(open,
    /<div class="gc-mention-option gc-mention-option-active" role="option" data-username="evan" data-index="1"><span class="gc-mention-option-at">@<\/span>evan<\/div>/,
    'the highlighted row is the one at `active`, in the chat menu’s exact markup');
  assert.match(open, /data-username="alice" data-index="0"/);
  assert.doesNotMatch(open, /gc-mention-option-you/, 'nobody signed in, nobody is "you"');

  const flipped = html({ items: ['alice'], active: 0, below: true });
  assert.match(flipped, /class="gc-mention-menu dev-feed-mention-menu dev-feed-mention-menu-below"/);

  // The "you" tag is decided against App.user, where the viewer is known.
  globalThis.window = { App: { user: { username: 'Evan' } } };
  try {
    const mine = html({ items: ['alice', 'evan'], active: 0 });
    assert.equal((mine.match(/gc-mention-option-you/g) || []).length, 1);
    assert.match(mine, /data-username="evan"[^>]*>[\s\S]*?gc-mention-option-you/);
  } finally {
    delete globalThis.window;
  }
});

test('the composer wires the list, and its own markup is unchanged until it opens', () => {
  const src = composer();
  assert.match(src, /useMentionTypeahead\(\{ slug, inputRef, value: draft, onChange: onDraftChange \}\)/,
    'the list edits the draft through the same onChange the keyboard does');
  // #2497 added the `#` list beside this one, so the field's handlers now fan
  // out to both: `syncMenus` asks each, and at most one of them opens (a
  // token under the caret is `@`-shaped or `#`-shaped, never both).
  assert.match(src, /const syncMenus = \(\) => \{ mention\.sync\(\); refs\.sync\(\); \};/);
  assert.match(src, /onChange=\{\(e\) => \{ onDraftChange\(e\.target\.value\); syncMenus\(\); \}\}/);
  assert.match(src, /onSelect=\{syncMenus\}/, 'a caret move can land on or leave a token');
  assert.match(src, /onFocus=\{\(\) => \{ mention\.warm\(\); refs\.warm\(\); \}\}/,
    'both lists are loading by the first `@` or `#`');
  assert.match(src, /onBlur=\{\(\) => \{ mention\.close\(\); refs\.close\(\); \}\}/);
  assert.match(src, /className="relative flex items-end gap-2 pt-0\.5"/,
    'the form is the box the list is placed against');
  assert.match(src, /<FeedMentionMenu[\s\S]*?onPick=\{mention\.accept\}/);
  assert.match(FEED, /<FeedReplyComposer\s+slug=\{slug\}/, 'the thread hands the composer its app');
  // The fetch lives in the typeahead, not here: the reply still POSTs to the
  // thread exactly as before.
  assert.doesNotMatch(FEED, /mention-suggestions/);

  const html = renderToHtml(createElement(feed().FeedReplyComposer, {
    slug: 'usernode-2d5619', draft: 'cc @ev', posting: false, onDraftChange() {}, onSubmit() {},
  }));
  assert.doesNotMatch(html, /data-feed-mention-menu/, 'no list in the initial render');
  assert.match(html, /<form class="relative flex items-end gap-2 pt-0.5">/);
  assert.match(html, /<textarea[^>]*aria-label="Reply to this item"[^>]*>cc @ev<\/textarea>/);
});

test('the list sits above the field inside the composer, clear of the send disc', () => {
  const base = CSS.indexOf('.gc-mention-menu {');
  const feedRule = CSS.indexOf('.gc-mention-menu.dev-feed-mention-menu {');
  assert.ok(base > 0 && feedRule > base, 'the feed’s placement follows the chat menu’s box, and overrides it');
  assert.match(CSS,
    /\.gc-mention-menu\.dev-feed-mention-menu \{\s*position: absolute;\s*left: 0;\s*right: 44px;\s*bottom: calc\(100% \+ 4px\);\s*\}/,
    '44px = the 36px disc plus the form’s 8px gap');
  assert.match(CSS,
    /\.gc-mention-menu\.dev-feed-mention-menu-below \{\s*top: calc\(100% \+ 4px\);\s*bottom: auto;\s*\}/,
    'the flip for a field with no room above it');
});

test('a picked mention notifies as mentions already do — no new kind, no new route', () => {
  // The composer POSTs to the thread as before; the server fans out mention
  // notifications after every chat insert, threaded or not, so `@evan` in a
  // feed reply reaches evan through the pipeline #87 built.
  const submit = FEED.slice(FEED.indexOf('const submit = useCallback'), FEED.indexOf('const hidden'));
  assert.match(submit, /body: JSON\.stringify\(\{ content, thread_type: type, thread_ref: refId \}\)/);
  const insert = WS.indexOf('INSERT INTO chat_messages');
  const fanout = WS.indexOf('notifications.createMentionNotifications(pool, {', insert);
  assert.ok(insert > 0 && fanout > insert, 'mentions fan out after the insert, for thread posts too');
  assert.doesNotMatch(TYPEAHEAD, /method: 'POST'/, 'the typeahead only reads');
});
