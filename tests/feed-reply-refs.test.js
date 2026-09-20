// #2497 — the Activity feed's reply box suggests pull requests and issues on
// `PR#` and `#`, the way the card page's chat composer already does.
//
// ── What is pinned, and why it is pinned this way ─────────────────────
//
// `RefAutocomplete` (public/js/group-chat.js) has offered this list in the
// group chat since #130; the feed's reply box, which #2145 gave an `@` list,
// had nothing on `#`. The new list is the chat's in every part that can be
// shared — the trigger grammar, the two endpoints behind it, the rows — and
// React's in every part that cannot, for the reasons mention-typeahead.tsx's
// header gives and this file's sibling suite (tests/feed-reply-mentions.test.js)
// already pins for `@`.
//
// The suite has no DOM, so the behaviour lives in exported pure functions and
// is driven here directly; the wiring around them is pinned as source.
//
// Run with: node --test tests/feed-reply-refs.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const FEED = read('frontend/src/features/dev-board/card/feed-thread.tsx');
const REFS = read('frontend/src/features/dev-board/card/ref-typeahead.tsx');
const GC_JS = read('public/js/group-chat.js');

let refsApi = null;
const ta = () => refsApi || (refsApi = loadTsx('frontend/src/features/dev-board/card/ref-typeahead.tsx'));

const composer = () => FEED.slice(
  FEED.indexOf('export function FeedReplyComposer'),
  FEED.indexOf('\nexport function FeedThread'),
);

// ── The trigger ──────────────────────────────────────────────────────

test('PR# lists pull requests, a bare # lists both, and a non-digit closes it', () => {
  const { detectRefToken } = ta();
  assert.deepEqual(detectRefToken('see #13', 7), { start: 4, query: '13', mode: 'combined' });
  assert.deepEqual(detectRefToken('see #', 5), { start: 4, query: '', mode: 'combined' },
    'a bare # opens the whole list');
  assert.deepEqual(detectRefToken('see PR#13', 9), { start: 4, query: '13', mode: 'pr' });
  assert.deepEqual(detectRefToken('see PR #13', 10), { start: 4, query: '13', mode: 'pr' },
    'the space the chat menu also accepts');
  assert.deepEqual(detectRefToken('see pr#1', 8), { start: 4, query: '1', mode: 'pr' },
    'the trigger is case-insensitive');
  assert.deepEqual(detectRefToken('#13 fixed', 3), { start: 0, query: '13', mode: 'combined' },
    'text after the caret is not part of the token');

  assert.equal(detectRefToken('#13 fixed', 9), null, 'the caret has left the token');
  assert.equal(detectRefToken('see #13a', 8), null, 'a non-digit after the # ends it');
  assert.equal(detectRefToken('rgb&#13', 7), null,
    'the & boundary: an HTML entity is not a reference, and the renderer would not chip it');
  assert.equal(detectRefToken('a#13', 4), null, 'no boundary before the #');
  assert.equal(detectRefToken('#12345678', 9), null, 'past the seven-digit cap');
  assert.equal(detectRefToken('#13', 9), null, 'a caret outside the text');
});

test('the @ list and the # list can never be open at the same caret', () => {
  // The composer asks both on every keystroke; what keeps exactly one of them
  // open is that the two triggers exclude each other. `@` is not a word
  // character, so `@13` fails the ref trigger's boundary, and `#` is not a
  // mention character, so `#13` fails the mention trigger's.
  const { detectRefToken } = ta();
  const { detectMentionToken } = loadTsx('frontend/src/features/dev-board/card/mention-typeahead.tsx');
  for (const [value, caret] of [['cc @13', 6], ['cc @ev', 6]]) {
    assert.equal(detectRefToken(value, caret), null, `${value} is the mention list's`);
  }
  for (const [value, caret] of [['see #13', 7], ['see PR#1', 8]]) {
    assert.equal(detectMentionToken(value, caret), null, `${value} is the ref list's`);
  }
});

// ── The rows ─────────────────────────────────────────────────────────

test('typing #1 finds the issues and PRs whose numbers start with it', () => {
  const { filterRefCandidates, REF_MAX_RESULTS } = ta();
  const candidates = {
    prs: [{ kind: 'pr', number: 12, title: 'Twelve' }, { kind: 'pr', number: 130, title: 'Refs' }],
    issues: [{ kind: 'issue', number: 1, title: 'One' }, { kind: 'issue', number: 44, title: 'Four' }],
  };
  assert.deepEqual(filterRefCandidates(candidates, '1', 'combined'), [
    { kind: 'issue', number: 1, title: 'One' },
    { kind: 'pr', number: 12, title: 'Twelve' },
    { kind: 'pr', number: 130, title: 'Refs' },
  ], 'a prefix match on the number, issues block first, then PRs');
  assert.deepEqual(filterRefCandidates(candidates, '1', 'pr'), [
    { kind: 'pr', number: 12, title: 'Twelve' },
    { kind: 'pr', number: 130, title: 'Refs' },
  ], 'PR mode never offers an issue');
  assert.equal(filterRefCandidates(candidates, '', 'combined').length, 4, 'nothing typed lists everything');
  assert.deepEqual(filterRefCandidates(candidates, '9', 'combined'), [], 'no match, so the list closes');

  const many = {
    prs: Array.from({ length: 80 }, (_, i) => ({ kind: 'pr', number: 1000 + i, title: '' })),
    issues: [],
  };
  assert.equal(filterRefCandidates(many, '1', 'pr').length, REF_MAX_RESULTS, 'capped');
});

test('picking a row inserts the canonical PR#N or #N and puts the caret after it', () => {
  const { spliceRef } = ta();
  assert.deepEqual(spliceRef('fixes #1 today', 6, 8, 'issue', 130),
    { value: 'fixes #130  today', caret: 11 },
    'the token is replaced by the reference and a trailing space; what followed the caret stays');
  assert.deepEqual(spliceRef('see PR#1', 4, 8, 'pr', 1078), { value: 'see PR#1078 ', caret: 12 });
  // A PR picked out of the combined `#` menu still inserts PR#N, because that
  // is the form the message renderer chips as a pull request.
  assert.deepEqual(spliceRef('see #1', 4, 6, 'pr', 1078), { value: 'see PR#1078 ', caret: 12 });
  assert.deepEqual(spliceRef('#', 0, 1, 'issue', 7), { value: '#7 ', caret: 3 });
});

test('the trigger is the chat menu’s, character for character', () => {
  // A dropdown that offered a completion the renderer would not chip would be
  // teaching the wrong convention. One regular expression, two composers.
  assert.match(REFS, /const TRIGGER_RE = \/\(\^\|\[\^\\w&\]\)\(pr \?#\|#\)\(\\d\{0,7\}\)\$\/i;/);
  assert.match(GC_JS, /_triggerRe: \/\(\^\|\[\^\\w&\]\)\(pr \?#\|#\)\(\\d\{0,7\}\)\$\/i,/);
});

// ── The candidates ───────────────────────────────────────────────────

test('the candidates are the two endpoints the drawer already reads, fetched once per app', async () => {
  const api = ta();
  const calls = [];
  const realFetch = globalThis.fetch;
  const respond = (byPath, ok = true) => async (url) => {
    calls.push(url);
    return { ok, json: async () => byPath[url] || {} };
  };
  const bodies = {
    '/api/apps/usernode-2d5619/promoted': {
      promoted: [
        { pr_number: 2151, pr_title: 'Refs in the reply box' },
        { pr_number: 2152, username: 'evan' },
        { pr_number: null, pr_title: 'not a PR yet' },
      ],
    },
    '/api/apps/usernode-2d5619/github-issues': {
      issues: [{ number: 2497, title: 'Add autocomplete for PR and issue references' }],
    },
  };
  try {
    api.resetRefCache();
    globalThis.fetch = respond(bodies);
    assert.equal(api.promotedPath('usernode-2d5619'), '/api/apps/usernode-2d5619/promoted');
    assert.equal(api.githubIssuesPath('a b'), '/api/apps/a%20b/github-issues');

    // Two composers ask at once: one pair of requests, both get the answer.
    const [a, b] = await Promise.all([
      api.loadRefCandidates('usernode-2d5619'),
      api.loadRefCandidates('usernode-2d5619'),
    ]);
    assert.deepEqual(a.issues, [{ kind: 'issue', number: 2497, title: 'Add autocomplete for PR and issue references' }]);
    assert.deepEqual(a.prs, [
      { kind: 'pr', number: 2151, title: 'Refs in the reply box' },
      { kind: 'pr', number: 2152, title: 'by evan' },
    ], 'a PR with no title falls back to its author, and one with no number is not a candidate');
    assert.equal(b, a);
    assert.deepEqual(calls.sort(), [
      '/api/apps/usernode-2d5619/github-issues',
      '/api/apps/usernode-2d5619/promoted',
    ]);

    // …and a third, later, reads the cache.
    assert.deepEqual(api.cachedRefCandidates('usernode-2d5619'), { prs: a.prs, issues: a.issues });
    await api.loadRefCandidates('usernode-2d5619');
    assert.equal(calls.length, 2);
    assert.equal(api.cachedRefCandidates('usernode-2d5619', Date.now() + api.REF_CACHE_TTL_MS + 1), null,
      'the lists go stale after the chat menu’s two minutes');

    // A refusal is an empty list, kept: it will not change within the TTL.
    api.resetRefCache();
    globalThis.fetch = respond({}, false);
    assert.deepEqual(await api.loadRefCandidates('private-app'), { prs: [], issues: [] });
    assert.deepEqual(api.cachedRefCandidates('private-app'), { prs: [], issues: [] });

    // A failed fetch is an empty list, NOT kept: the next `#` retries.
    api.resetRefCache();
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await api.loadRefCandidates('usernode-2d5619'), { prs: [], issues: [] });
    assert.equal(api.cachedRefCandidates('usernode-2d5619'), null);
  } finally {
    globalThis.fetch = realFetch;
    api.resetRefCache();
  }
});

test('the typeahead only reads', () => {
  assert.doesNotMatch(REFS, /method: 'POST'/);
});

// ── The keys and the menu ────────────────────────────────────────────

test('only an open list consumes the arrows, Enter, Tab and Escape', () => {
  const hook = REFS.slice(REFS.indexOf('const onKeyDown = useCallback'));
  assert.match(hook, /if \(!items\.length\) return false;/);
  assert.match(hook, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/,
    'the form must not also submit, and the row’s own key handling must not also run');
  assert.match(hook, /if \(key === 'close'\) close\(\);/);
  // Leaving the field closes it; an IME composition never opens it.
  assert.match(composer(), /onBlur=\{\(\) => \{ mention\.close\(\); refs\.close\(\); \}\}/);
  assert.match(REFS, /if \(!el \|\| composing\.current\) return;/);
});

test('the list renders the chat menu’s ref rows, and nothing at all when closed', () => {
  const { FeedRefMenu } = ta();
  const html = (props) => renderToHtml(createElement(FeedRefMenu, {
    below: false, menuRef: { current: null }, onPick() {}, ...props,
  }));
  // Closed draws nothing: a row's markup is exactly what it was until
  // somebody types `#`, which is what keeps the declared #1584 check and the
  // like-for-like rule true.
  assert.equal(html({ items: [], active: -1 }), '');

  const open = html({
    items: [
      { kind: 'issue', number: 2497, title: 'Autocomplete refs' },
      { kind: 'pr', number: 2151, title: 'The change' },
    ],
    active: 1,
  });
  assert.match(open,
    /<div class="gc-mention-menu dev-feed-mention-menu" role="listbox" aria-label="Insert a pull request or issue reference" data-feed-ref-menu="">/);
  assert.equal((open.match(/class="gc-mention-option gc-ref-option(?: |")/g) || []).length, 2,
    'one row per reference, in the chat menu’s row class');
  assert.match(open,
    /data-kind="issue" data-number="2497" data-index="0"><span class="gc-ref gc-ref-issue">#2497<\/span>/,
    'the emerald issue badge the message renderer draws');
  assert.match(open,
    /class="gc-mention-option gc-ref-option gc-mention-option-active"[^>]*data-kind="pr" data-number="2151"[^>]*><span class="gc-ref gc-ref-pr">PR#2151<\/span>/,
    'the highlighted row is the one at `active`, with the violet PR badge');
  assert.match(open, /<span class="gc-ref-option-title">Autocomplete refs<\/span>/);

  const flipped = html({ items: [{ kind: 'pr', number: 1, title: '' }], active: 0, below: true });
  assert.match(flipped, /class="gc-mention-menu dev-feed-mention-menu dev-feed-mention-menu-below"/);
});

// ── The wiring ───────────────────────────────────────────────────────

test('the composer chains the two lists, and its own markup is unchanged until one opens', () => {
  const src = composer();
  assert.match(src, /useRefTypeahead\(\{ slug, inputRef, value: draft, onChange: onDraftChange \}\)/,
    'the list edits the draft through the same onChange the keyboard does');
  assert.match(src, /const syncMenus = \(\) => \{ mention\.sync\(\); refs\.sync\(\); \};/);
  // The `@` list is asked first and the `#` list second; only one of them can
  // answer, so the order is a formality rather than a precedence.
  assert.match(src, /if \(mention\.onKeyDown\(e\)\) return;\s*if \(refs\.onKeyDown\(e\)\) return;/);
  assert.match(src, /<FeedRefMenu[\s\S]*?onPick=\{refs\.accept\}/);
  // The fetches live in the typeahead, not here: the reply still POSTs to the
  // thread exactly as before.
  assert.doesNotMatch(FEED, /github-issues/);

  const html = renderToHtml(createElement(loadTsx('frontend/src/features/dev-board/card/feed-thread.tsx').FeedReplyComposer, {
    slug: 'usernode-2d5619', draft: 'fixes #24', posting: false, onDraftChange() {}, onSubmit() {},
  }));
  assert.doesNotMatch(html, /data-feed-ref-menu/, 'no list in the initial render');
  assert.doesNotMatch(html, /data-feed-mention-menu/);
  assert.match(html, /<form class="relative flex items-end gap-2 pt-0.5">/);
  assert.match(html, /<textarea[^>]*aria-label="Reply to this item"[^>]*>fixes #24<\/textarea>/);
});
