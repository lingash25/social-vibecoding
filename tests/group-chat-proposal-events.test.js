// The general chat's proposal events and quiet card.
//
// ── What this pins ─────────────────────────────────────────────────────
//
// An app's Discussion is where every proposal, vote, merge and closed request
// posts a line, so on a quiet app it was thirty lines of machine-written
// history in 11px with the two open votes buried in the middle, and nothing
// saying the place is for people. Two things fix that, both decided from
// DATA the module already publishes:
//
//   * the general chat draws only two of the notices: a proposal put up for
//     a vote and a proposal merged. `GroupChat._proposalEvent` decides which
//     rows those are from the row's kind and the server's own wording, and
//     features/group-chat/proposal-event.tsx draws each as a MESSAGE from
//     whoever did it — the transcript's named row, avatar, name and stamp
//     where a person's message puts them — with one box under it in the
//     Current status tab's surface, holding one glyph and one line, linking
//     to the proposal's page when its session is known. Every other notice
//     is left undrawn there; the topic threads keep them all;
//   * features/group-chat/quiet-card.tsx ends the general chat with a card
//     while no message from a person is among the loaded rows, worded from
//     three facts group-chat.js supplies on the transcript lead.
//
// And the module's seams that feed them: `_messageView` writes `event`,
// `eventHref` and `votePhase`, `refreshVoteControls` patches the phase and the
// link when the vote snapshot lands, and `render()` publishes the quiet lead.
//
// Run with: node --test tests/group-chat-proposal-events.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const EVENT = 'frontend/src/features/group-chat/proposal-event.tsx';
const QUIET = 'frontend/src/features/group-chat/quiet-card.tsx';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const SWATCH = 'frontend/src/features/group-chat/swatch.ts';
const gcJs = read('public/js/group-chat.js');
const stripped = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// ── Rows, as the module's view model spells them ──────────────────────

const base = {
  id: 1, kind: 'system', username: '', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  bodyHtml: '', systemText: 'a notice', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: false, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null,
};
let seq = 100;
const row = (over) => ({ ...base, id: (seq += 1), ...over });
/** A notice the general chat does not draw: a closed request, a check verdict. */
const notice = (text) => row({ kind: 'system', systemText: text || `notice ${seq + 1}` });
const icon = { tint: 'bg-sky-500/15 text-sky-700 dark:text-sky-400', path: 'M14 10h4', small: true };
/** A proposal put up for a vote, with the phase the snapshot gave it. */
const submitted = (votePhase, over) => row({
  kind: 'vote', systemText: 'evan promoted PR #12: Custom tier colors for voting',
  voteRef: { sessionId: '5', prNumber: '12' },
  ...(votePhase ? { votePhase } : {}),
  event: { type: 'submitted', sessionId: '5', prNumber: '12', title: 'Custom tier colors', actor: 'evan', sender: 'evan', mine: false, force: false, votes: '', icon },
  eventHref: '/app/recipe-app/dev/proposals/5',
  ...(over || {}),
});
/** A proposal merged, announced by the app. */
const merged = (over) => row({
  kind: 'system', systemText: `Custom tier colors is live (PR #${seq + 1}). Thanks to everyone who voted (2/3 votes)`,
  event: { type: 'merged', sessionId: '', prNumber: '12', title: 'Custom tier colors', actor: '', sender: 'Recipe App', mine: false, force: false, votes: '2/3', icon: { ...icon, path: 'M5 13l4 4L19 7' } },
  eventHref: null,
  ...(over || {}),
});
const human = (text) => row({
  kind: 'message', username: 'alice', bodyHtml: `<p>${text || 'hello'}</p>`, showReact: true,
});
const quietLead = { earlier: false, placeholder: null, quiet: { exhausted: true, canPost: true, appName: 'Recipe App' } };

// ── The event row ─────────────────────────────────────────────────────

test('a submission is a message from its proposer: their avatar, name and stamp up top, one box under it', () => {
  const msg = submitted('open');
  const html = renderComponent(EVENT, 'EventRow', { msg });
  const { swatchFor } = loadTsx(SWATCH);
  // The transcript's own named row, with the row's hooks on it.
  assert.match(html, new RegExp(`^<div class="flex gap-3 px-4 py-2 gc-event" data-msg-id="${msg.id}" data-event="submitted" data-session-id="5" data-pr-number="12" data-open="1">`));
  // The avatar is the swatch evan's own messages wear.
  assert.match(html, new RegExp(`<span class="relative flex shrink-0 items-center justify-center font-bold text-white rounded-xl h-11 w-11 text-\\[1\\.0625rem\\]" style="background-color:${swatchFor('evan')}" aria-hidden="true">E</span>`));
  // Name and stamp on the header line, where a person's message puts them.
  assert.match(html, /<span class="truncate text-\[1\.0625rem\] font-bold text-zinc-900 dark:text-zinc-100"><span data-event-sender="">evan<\/span><\/span><span class="shrink-0 text-\[0\.9375rem\] text-zinc-500 dark:text-zinc-500"><span class="gc-msg-time" title="Sep 16, 2026, 09:05 AM">09:05 AM<\/span><\/span>/);
  // One box: the bare glyph, one line of text, the door's chevron.
  assert.match(html, /<a class="gc-event-box" href="\/app\/recipe-app\/dev\/proposals\/5" title="Open this proposal"><span class="w-7 h-7 rounded-lg dev-card-icon bg-sky-500\/15 [^"]*">[\s\S]*?<\/span><span class="gc-event-text">Proposed PR #12 for a vote: Custom tier colors<\/span><svg class="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0"/);
  // Nothing else: no controls host, no bookmark, no react button, no reactions.
  assert.doesNotMatch(html, /data-vote-controls|gc-msg-save|gc-react-add|gc-reactions|gc-msg-system|gc-msg[" ]/);
});

test('a merge is a message from the app, its box saying how the change landed, with no door until its proposal is known', () => {
  const { eventText } = loadTsx(EVENT);
  const live = merged();
  const html = renderComponent(EVENT, 'EventRow', { msg: live });
  assert.match(html, /data-event="merged" data-session-id="" data-pr-number="12">/);
  assert.doesNotMatch(html, /data-open/, 'a merge is never open');
  assert.match(html, /<span data-event-sender="">Recipe App<\/span>/);
  assert.match(html, /<div class="gc-event-box"><span class="w-7 h-7 rounded-lg dev-card-icon [^"]*">[\s\S]*?d="M5 13l4 4L19 7"[\s\S]*?<\/span><span class="gc-event-text">PR #12 went live with 2\/3 votes: Custom tier colors<\/span><\/div>/);
  assert.doesNotMatch(html, /<a |href=|<svg class="w-4 h-4 text-zinc-500/, 'a plain box, with no chevron promising a destination');

  assert.equal(eventText(merged({ event: { ...merged().event, force: true, actor: 'dfk', sender: 'dfk', votes: '0/2' } })), 'Force-merged PR #12 with 0/2 votes: Custom tier colors');
  assert.equal(eventText(merged({ event: { ...merged().event, title: '', votes: '' } })), 'PR #12 went live');
  assert.equal(eventText(submitted('open', { event: { ...submitted().event, title: '' } })), 'Proposed PR #12 for a vote');
  const settled = renderComponent(EVENT, 'EventRow', { msg: submitted('settled') });
  assert.doesNotMatch(settled, /data-open/, 'a submission whose vote is over is no longer marked open');
  assert.match(renderComponent(EVENT, 'EventRow', { msg: submitted('unknown') }), /data-open="1"/, 'and one whose phase is not known yet still is');
  assert.match(renderComponent(EVENT, 'EventRow', { msg: merged({ event: { ...merged().event, icon: null } }) }), /<div class="gc-event-box"><span class="gc-event-text">/, 'no glyph where app-view.js is not loaded');
});

test('the swatch is the transcript\'s own hash, so a proposer\'s event avatar matches their messages', () => {
  const { swatchFor } = loadTsx(SWATCH);
  const transcript = read(TRANSCRIPT);
  assert.match(transcript, /import \{ swatchFor \} from '\.\/swatch';/);
  assert.doesNotMatch(transcript, /const SWATCHES/, 'one copy, not two');
  assert.match(read(EVENT), /import \{ swatchFor \} from '\.\/swatch';/);
  // The legacy hash, unchanged: h = h * 31 + code.
  assert.equal(swatchFor('alice'), swatchFor('alice'));
  let h = 0;
  for (const ch of 'cyrcle_0') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  assert.equal(swatchFor('cyrcle_0'), ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'][h % 6]);
});

test('the box is the Current status tab\'s surface: frosted fill, hairline, bare glyph, simple text', () => {
  const css = read('public/css/app.css');
  const box = css.match(/\.gc-event-box \{([\s\S]*?)\}/);
  assert.ok(box, 'the box rule');
  assert.match(box[1], /background-color: var\(--dc-sheet-fill\);/, 'the pane\'s fill, not white');
  assert.match(box[1], /backdrop-filter: var\(--dc-frost\);/);
  assert.match(box[1], /box-shadow: 0 0 0 1px var\(--app-sheet-line\) inset;/, 'a plain hairline, not a drop shadow');
  assert.match(box[1], /font-size: 13px;[^}]*color: var\(--text-secondary\);/, 'simple text');
  assert.doesNotMatch(box[1], /--dc-raised|--dev-edge|rgba\(0, 0, 0/, 'not the card\'s chrome');
  assert.match(css, /\.gc-event-box > \.dev-card-icon \{\s*flex: none; width: 20px; height: 20px;\s*background: transparent; border-radius: 0;\s*\}/, 'the glyph without its plate, as the discussion row carries it');
  assert.match(css, /\.gc-event\[data-open\] \.gc-event-box \{ color: var\(--text-primary\); \}/);
  assert.match(css, /a\.gc-event-box:hover > \.gc-event-text \{ color: var\(--text-primary\); \}/);
  assert.ok(!css.includes('gc-msg-card') && !css.includes('.gc-event.dev-ws-row'), 'the earlier boxed rows are gone');
  assert.ok(!fs.existsSync(path.join(root, 'frontend/src/features/group-chat/activity-digest.tsx')), 'and so is the digest');
  assert.doesNotMatch(read('public/js/app-view.js'), /activity-open/, 'with its capture deep link');
});

test('the viewer\'s own event sits on the right: the row runs right to left, no avatar, the box against the right edge', () => {
  const msg = submitted('open', { event: { ...submitted().event, mine: true } });
  const html = renderComponent(EVENT, 'EventRow', { msg });
  assert.match(html, new RegExp(`^<div class="flex gap-3 px-4 py-2 flex-row-reverse gc-event gc-event-self" data-msg-id="${msg.id}"`));
  assert.doesNotMatch(html, /rounded-xl h-11 w-11/, 'no avatar beside your own event');
  assert.match(html, /<div class="min-w-0 flex-1"><div class="flex items-baseline gap-2 justify-end"><span class="truncate [^"]*"><span data-event-sender="">evan<\/span><\/span><span class="shrink-0 [^"]*"><span class="gc-msg-time"/, 'the header is pushed to the right edge but still reads name then time (#2392)');
  assert.match(html, /<div class="text-\[1\.0625rem\] leading-snug text-zinc-900 dark:text-zinc-100 flex flex-col items-end"><a class="gc-event-box"/, 'the box column stacks against the right edge');
  const theirs = renderComponent(EVENT, 'EventRow', { msg: submitted('open') });
  assert.match(theirs, /^<div class="flex gap-3 px-4 py-2 gc-event" /, 'somebody else\'s stays on the left, with the avatar');
  assert.match(theirs, /rounded-xl h-11 w-11/);
});

test('in the general chat a person\'s message is a bubble under their name; yours is the accent tint on the right, with no avatar', () => {
  const { MessageRow } = loadTsx(TRANSCRIPT);
  const theirs = renderToHtml(createElement(MessageRow, { msg: human('hello there'), bubbled: true }));
  assert.match(theirs, /^<div class="flex gap-3 px-4 py-2 gc-msg" data-msg-id="\d+" data-username="alice">/);
  assert.match(theirs, /rounded-xl h-11 w-11[^>]*>A<\/span>/, 'the avatar');
  assert.match(theirs, /<span>alice<\/span>/);
  assert.match(theirs, /<div class="gc-bubble"><div class="gc-msg-content"><p>hello there<\/p><\/div><\/div><div class="gc-reactions"/, 'the body in a bubble, the reactions under it');

  const mine = renderToHtml(createElement(MessageRow, { msg: human('mine'), bubbled: true }).type === undefined ? null : createElement(MessageRow, { msg: { ...human('mine'), username: 'evan', mine: true }, bubbled: true }));
  assert.match(mine, /^<div class="flex gap-3 px-4 py-2 flex-row-reverse gc-msg gc-msg-self" data-msg-id="\d+" data-username="evan">/, 'the row runs right to left, and keeps gc-msg-self for the reaction bar');
  assert.doesNotMatch(mine, /rounded-xl h-11 w-11/, 'no avatar beside your own words');
  assert.match(mine, /<div class="flex items-baseline gap-2 justify-end"><span class="truncate [^"]*"><span class="gc-msg-username-self">evan<\/span>/, 'name then time, not reversed (#2392)');
  assert.match(mine, /flex flex-col items-end"><div class="gc-bubble gc-bubble-self"><div class="gc-msg-content"><p>mine<\/p><\/div><\/div>/);

  // A quoted reply and files ride inside the bubble.
  const quoted = renderToHtml(createElement(MessageRow, {
    msg: { ...human('reply'), quote: { icon: '\u21A9', username: 'bob', excerpt: 'earlier', source: 'message', href: null, targetId: 3 } }, bubbled: true,
  }));
  assert.match(quoted, /<div class="gc-bubble"><div class="gc-quoted" [^>]*>[\s\S]*?<\/div><div class="gc-msg-content">/);

  // Without `bubbled` — the topic thread — the row is exactly what it was.
  const flat = renderToHtml(createElement(MessageRow, { msg: { ...human('flat'), mine: true } }));
  assert.match(flat, /^<div class="flex gap-3 px-4 py-2 gc-msg gc-msg-self" /, 'left, flat, with the avatar');
  assert.doesNotMatch(flat, /gc-bubble|flex-row-reverse/);
  assert.match(flat, /rounded-xl h-11 w-11/);
});

test('the bubble is the Messages screen\'s shape on the raised surface, and the react disc crosses to the empty side of your row', () => {
  const css = read('public/css/app.css');
  const bubble = css.match(/\.gc-bubble \{([\s\S]*?)\}/);
  assert.ok(bubble, 'the bubble rule');
  assert.match(bubble[1], /border-radius: 20px;/);
  // Not the Messages screen's white: on the frosted sheet that is the
  // sheet's own colour. The raised neutral surface the dev chat's PR card
  // and the dark-mode Messages bubble already use.
  assert.match(bubble[1], /background: var\(--dc-raised\);/);
  assert.match(bubble[1], /max-width: min\(78%, 640px\);/);
  // Yours in the tint the dev chat and the Messages screen give your turns —
  // but composited over the same raised surface the other bubbles sit on,
  // rather than standing alone. `--accent-tint` is translucent, so a tint-only
  // bubble rendered whatever the ROW was painted, and the row's hover/tap
  // highlight arrived inside the message box with it (#2464). Pinned in full,
  // colour resolution and all, by tests/group-chat-row-highlight.test.js.
  const self = css.match(/\.gc-bubble-self \{([\s\S]*?)\}/);
  assert.ok(self, 'the self-bubble rule');
  assert.match(self[1], /background-color: var\(--dc-raised\);/, 'yours sits on the same surface as everyone else\'s');
  assert.match(
    self[1],
    /background-image: linear-gradient\(var\(--accent-tint\), var\(--accent-tint\)\);/,
    'yours in the tint the dev chat and the Messages screen give your turns'
  );
  assert.match(css, /#gc-messages \.gc-msg-self \.gc-react-add \{ right: auto; left: 6px; \}/);
  assert.match(css, /\.messages-message-self \.messages-bubble \{ background: var\(--accent-tint\); \}/, 'the same tint the Messages screen uses');
  assert.match(css, /#dev-topic-thread \.gc-msg-self > \.min-w-0 \{ background: var\(--accent-tint\); \}/, 'and the thread keeps its own in-place tint');
});

// ── The quiet card ────────────────────────────────────────────────────

test('the quiet card says "yet" only once history is exhausted, and asks only those who can post', () => {
  const html = renderComponent(QUIET, 'QuietCard', { exhausted: true, canPost: true, appName: 'Recipe App' });
  assert.match(html, /^<div class="gc-quiet [^"]*" data-quiet-chat="">/);
  assert.match(html, /Nobody has said anything here yet/);
  assert.match(html, /Say hi, ask a question, or share what you would like to see next in Recipe App\./);

  const lately = renderComponent(QUIET, 'QuietCard', { exhausted: false, canPost: true, appName: 'Recipe App' });
  assert.match(lately, /It has been quiet in here lately/);
  assert.doesNotMatch(lately, /Nobody has said/);

  const readOnly = renderComponent(QUIET, 'QuietCard', { exhausted: true, canPost: false, appName: 'Recipe App' });
  assert.doesNotMatch(readOnly, /Say hi/);
  assert.match(readOnly, /Messages from the people building Recipe App will show up here\./);

  // The app's name is user content and lands as text.
  const hostile = renderComponent(QUIET, 'QuietCard', { exhausted: true, canPost: true, appName: '<b>x</b>' });
  assert.ok(hostile.includes('&lt;b&gt;x&lt;/b&gt;') && !hostile.includes('<b>x</b>'));
});

test('no em dashes in the components\' copy', () => {
  for (const file of [EVENT, QUIET]) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!code.includes('—'), `${file}: user-facing strings carry no em dash`);
  }
});

// ── The transcript, end to end ────────────────────────────────────────

const renderRows = (view, source) => renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view, source }));

test('the general chat draws every event in order, hides the other notices, and ends with the quiet card', () => {
  const open = submitted('open');
  const messages = [
    submitted('settled'), notice('Issue #7 closed by group vote (1/1)'), merged(),
    submitted('settled'), notice('PR #9 reached the vote threshold but has 1 test failing'), merged(),
    open,
  ];
  const html = renderRows({ messages, lead: quietLead }, 'main');
  const events = [...html.matchAll(/class="flex gap-3 px-4 py-2 gc-event" data-msg-id="(\d+)" data-event="(\w+)"/g)];
  assert.deepEqual(events.map((m) => m[2]), ['submitted', 'merged', 'submitted', 'merged', 'submitted'], 'every event, none folded');
  assert.equal(events[4][1], String(open.id));
  assert.ok(html.indexOf('class="gc-quiet') > html.lastIndexOf('gc-event-box'), 'the card comes last');
  assert.doesNotMatch(html, /closed by group vote|reached the vote threshold|gc-msg-system|gc-activity/, 'a notice of another kind is not drawn at all, and nothing folds');
  assert.doesNotMatch(html, /data-vote-controls/, 'no controls host anywhere in the general chat');
});

test('a message from a person sits among the events in the same grid, and dismisses the card', () => {
  const messages = [merged(), human('hello there'), merged()];
  const html = renderRows({ messages, lead: quietLead }, 'main');
  assert.match(html, /hello there/);
  assert.equal((html.match(/data-event="merged"/g) || []).length, 2);
  // Both the person and the event are the named row: the same avatar box,
  // the same header line — and the person's words sit in a bubble.
  assert.equal((html.match(/class="flex gap-3 px-4 py-2 gc-msg/g) || []).length, 1);
  assert.equal((html.match(/rounded-xl h-11 w-11 text-\[1\.0625rem\]" style="background-color:/g) || []).length, 3);
  assert.match(html, /<div class="gc-bubble"><div class="gc-msg-content"><p>hello there<\/p>/);
  assert.doesNotMatch(html, /gc-quiet/, 'somebody has spoken');
});

test('the card needs the lead: a transcript published without `quiet` never draws it', () => {
  const html = renderRows({ messages: [merged(), merged()], lead: { earlier: false, placeholder: null } }, 'main');
  assert.doesNotMatch(html, /gc-quiet/);
  const nulled = renderRows({ messages: [], lead: { earlier: false, placeholder: null, quiet: null } }, 'main');
  assert.doesNotMatch(nulled, /gc-quiet/);
  const empty = renderRows({ messages: [], lead: quietLead }, 'main');
  assert.match(empty, /gc-quiet/, 'an empty general chat is the quietest of all');
  const onlyNotices = renderRows({ messages: [notice(), notice(), notice()], lead: quietLead }, 'main');
  assert.match(onlyNotices, /^<div class="gc-quiet/, 'a chat holding nothing the general chat draws is the card alone');
});

test('the thread transcript keeps every row, in the centred form, draws no event row and never the card', () => {
  const messages = [notice('one'), notice('two'), notice('three'), submitted('settled'), merged()];
  const html = renderRows({ messages, lead: quietLead }, 'thread');
  assert.doesNotMatch(html, /gc-quiet|gc-event|dev-card-icon|gc-bubble|flex-row-reverse/);
  for (const text of ['one', 'two', 'three']) assert.match(html, new RegExp(`>${text}<`));
  assert.match(html, /class="gc-msg-system gc-msg-vote" data-msg-id="\d+"/, 'a vote row with its controls host, as it always was');
  assert.match(html, /data-vote-controls=""/);
});

// ── The module's half ─────────────────────────────────────────────────

function loadGroupChat(AppView, App) {
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' }, ...(App || {}) },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  if (AppView) sandbox.AppView = AppView;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

// The module runs in a vm context, so its objects have another realm's
// prototype; spreading them makes a same-realm copy deepEqual can compare.
const plain = (o) => (o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plain(v)]))
  : o);

const promoted = { id: 5, status: 'promoted', pr_number: 12, my_vote: null };
const voteState = (pr) => ({
  bySession: pr ? { [String(pr.id)]: pr } : {},
  byPrNumber: pr && pr.pr_number != null ? { [String(pr.pr_number)]: pr } : {},
  majority: 1, activeUsers: 1,
});
const devIcons = {
  DEV_CARD_ICONS: { proposal: ['tint-proposal', 'M14 10h4'], done: ['tint-done', 'M5 13l4 4L19 7'], issue: ['tint-issue', 'M0 0'] },
  _devCardIcon(type, opts) {
    const [tint, d] = this.DEV_CARD_ICONS[type] || this.DEV_CARD_ICONS.issue;
    return { tint, path: d, small: opts && opts.small ? true : undefined, pulse: undefined, title: undefined };
  },
};

test('_proposalEvent: the server\'s two merge wordings and every vote row are events; nothing else is', () => {
  const gc = loadGroupChat();
  assert.deepEqual(
    plain(gc._proposalEvent({ content: 'evan promoted PR #12: Custom tier colors for voting', metadata: { vote: { sessionId: 5, prNumber: 12 } } }, 'vote')),
    { type: 'submitted', sessionId: '5', prNumber: '12', title: 'Custom tier colors', actor: 'evan', force: false, votes: '' },
  );
  assert.deepEqual(
    plain(gc._proposalEvent({ content: 'snait imported PR #2359: Show hosted assets (#2319) for voting' }, 'vote')),
    { type: 'submitted', sessionId: '', prNumber: '2359', title: 'Show hosted assets (#2319)', actor: 'snait', force: false, votes: '' },
  );
  assert.equal(gc._proposalEvent({ content: 'admin promoted PR #12 for a vote' }, 'vote').title, '', 'the older wording, no title');
  const odd = gc._proposalEvent({ content: 'Platform maintenance: "Bump" opened PR #77. Needs 2/3 votes to land.' }, 'vote');
  assert.equal(odd.type, 'submitted');
  assert.equal(odd.prNumber, '77', 'every vote row is a submission; the number comes from _voteRef then');
  assert.deepEqual(
    plain(gc._proposalEvent({ content: 'Custom tier colors is live (PR #12). Thanks to everyone who voted (2/3 votes)' }, 'system')),
    { type: 'merged', sessionId: '', prNumber: '12', title: 'Custom tier colors', actor: '', force: false, votes: '2/3' },
  );
  assert.deepEqual(
    plain(gc._proposalEvent({ content: 'PR #12 is live. Thanks to everyone who voted (1/1 votes)' }, 'system')),
    { type: 'merged', sessionId: '', prNumber: '12', title: '', actor: '', force: false, votes: '1/1' },
  );
  assert.deepEqual(
    plain(gc._proposalEvent({ content: 'PR #2355: Fix Dev chat mobile layout force-merged by admin dfk (0/2 votes at the time)' }, 'system')),
    { type: 'merged', sessionId: '', prNumber: '2355', title: 'Fix Dev chat mobile layout', actor: 'dfk', force: true, votes: '0/2' },
  );
  for (const text of [
    'Issue #2307 closed by admin override (dfk)',
    'PR #2334: Turn off the check reached the vote threshold but has 1 test failing. Merge is blocked until checks pass.',
    'cyrcle_0 withdrew PR #2348: The asset-route check skips the platform’s own app',
    'main’s unit suite is green again after PR #2356 merged (0f390ac). Merges resume.',
    'PR #12 is now synced with main and conflict-free. It needs 1/2 yes votes needed to merge.',
  ]) {
    assert.equal(gc._proposalEvent({ content: text }, 'system'), null, `not an event: ${text}`);
  }
  assert.equal(gc._proposalEvent({ content: 'Custom tier colors is live (PR #12). Thanks to everyone who voted (2/3 votes)' }, 'message'), null, 'a person quoting the wording is a message');
});

test('_messageView carries the event with its sender, the board\'s glyph, the link and the phase; other rows carry none', () => {
  const voteRow = {
    id: 9, msg_type: 'vote', content: 'evan promoted PR #12: Custom tier colors for voting',
    metadata: { vote: { sessionId: 5, prNumber: 12 } }, created_at: '2026-09-16T09:05:00.000Z',
  };
  const warm = loadGroupChat({ ...devIcons, voteState: voteState(promoted), appData: { slug: 'recipe-app', name: 'Recipe App' } });
  const v = warm._messageView(voteRow);
  assert.equal(v.votePhase, 'open');
  assert.deepEqual(plain(v.event), {
    type: 'submitted', sessionId: '5', prNumber: '12', title: 'Custom tier colors', actor: 'evan', sender: 'evan', mine: false, force: false, votes: '',
    icon: { tint: 'tint-proposal', path: 'M14 10h4', small: true, pulse: undefined, title: undefined },
  });
  const ownRow = { ...voteRow, id: 14, content: 'alice promoted PR #12: Custom tier colors for voting' };
  assert.equal(warm._messageView(ownRow).event.mine, true, 'the viewer (alice) proposed it: theirs');
  assert.equal(warm._messageView(ownRow).event.sender, 'alice');
  assert.equal(v.eventHref, '/app/recipe-app/dev/proposals/5', 'the session id from the tag, the slug from the app');
  assert.equal(v.voteRef.sessionId, '5', 'the thread\'s controls host keeps its pair');
  assert.ok(!('live' in v), 'no live flag: nothing folds any more');

  // App._appUrl builds the link when app.js is present.
  const routed = loadGroupChat(
    { ...devIcons, voteState: voteState(promoted), appData: { slug: 'recipe-app' } },
    { _appUrl: (slug, tab, ref, sub) => `built:${slug}:${tab}:${ref.kind}:${ref.id}:${sub}` },
  );
  assert.equal(routed._messageView(voteRow).eventHref, 'built:recipe-app:dev:proposal:5:topic');

  const mergedRow = { id: 10, msg_type: 'system', content: 'Custom tier colors is live (PR #12). Thanks to everyone who voted (2/3 votes)' };
  const m = warm._messageView(mergedRow);
  assert.equal(m.event.type, 'merged');
  assert.equal(m.event.sender, 'Recipe App', 'a merge the vote decided is announced by the app');
  assert.equal(m.event.icon.tint, 'tint-done', 'the done tick once merged');
  assert.ok(!('votePhase' in m), 'a merge has no vote phase: it is settled by definition');
  const forcedRow = { id: 13, msg_type: 'system', content: 'PR #12: Custom tier colors force-merged by admin dfk (0/2 votes at the time)' };
  assert.equal(warm._messageView(forcedRow).event.sender, 'dfk', 'a force-merge is the admin\'s');
  assert.equal(m.event.mine, false, 'a merge the vote decided is nobody\'s');
  // The session behind an older merge comes from the merged list, once it has loaded.
  const withMerged = loadGroupChat({ ...devIcons, voteState: voteState(null), appData: { slug: 'recipe-app' }, _merged: [{ id: 5, pr_number: 12, status: 'merged' }] });
  assert.equal(withMerged._messageView(mergedRow).eventHref, '/app/recipe-app/dev/proposals/5');
  const unknownMerge = loadGroupChat({ ...devIcons, voteState: voteState(null), appData: { slug: 'recipe-app' } });
  assert.equal(unknownMerge._messageView(mergedRow).eventHref, null, 'and is null until then');
  assert.equal(unknownMerge._messageView(mergedRow).event.sender, 'System', 'no app name to hand: the transcript\'s old fallback');

  const cold = loadGroupChat();
  assert.equal(cold._messageView(voteRow).event.icon, null, 'no glyph without app-view.js');
  assert.equal(cold._messageView(voteRow).eventHref, null, 'no link without an app');
  assert.equal(cold._messageView({ id: 11, msg_type: 'system', content: 'Issue #7 closed by group vote (1/1)' }).event, null);
  assert.equal(cold._messageView({ id: 12, msg_type: 'message', username: 'bob', content: 'PR #12 is live. Thanks to everyone who voted (1/1 votes)' }).event, null);
});

test('_votePhase: unknown until the snapshot lands, open while promoted, settled otherwise', () => {
  const gc = loadGroupChat();
  assert.equal(gc._votePhase(promoted), 'unknown', 'no AppView at all');
  const cold = loadGroupChat({ voteState: null });
  assert.equal(cold._votePhase(promoted), 'unknown', 'AppView without a snapshot yet');
  const warm = loadGroupChat({ voteState: voteState(promoted) });
  assert.equal(warm._votePhase(promoted), 'open');
  assert.equal(warm._votePhase({ ...promoted, status: 'merging' }), 'settled');
  assert.equal(warm._votePhase({ ...promoted, status: 'merged' }), 'settled');
  assert.equal(warm._votePhase({ status: 'merged', pr_number: 12, _settled: true }), 'settled', 'a recently-merged row');
  assert.equal(warm._votePhase(null), 'settled', 'gone from the votable set: a plain activity line by now');
});

test('refreshVoteControls patches the phase with the tint on hosts, and the phase and link on event rows; render() supplies the quiet lead', () => {
  const refresh = stripped.match(/refreshVoteControls\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(refresh, 'refreshVoteControls() found');
  assert.match(refresh[1], /votePhase: GroupChat\._votePhase\(pr\)/);
  assert.match(refresh[1], /voteRowClass: GroupChat\._rowVoteClass\(pr\)/);
  assert.match(refresh[1], /querySelectorAll\('#gc-messages \.gc-event\[data-msg-id\]'\)/);
  assert.match(refresh[1], /eventHref: GroupChat\._eventHref\(sid, pr\)/);
  assert.match(refresh[1], /if \(el\.dataset\.event === 'submitted'\) patch\.votePhase = GroupChat\._votePhase\(pr\);/);
  // The row carries what that loop reads back.
  const html = renderComponent(EVENT, 'EventRow', { msg: submitted('open') });
  assert.match(html, /data-session-id="5" data-pr-number="12"/);

  const render = stripped.match(/\n {2}render\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(render, 'render() found');
  assert.match(render[1], /publishTranscript\(\s*GroupChat\.messages\.map\(GroupChat\._messageView\),\s*'main',/);
  assert.match(render[1], /exhausted: !GroupChat\.hasMore/);
  assert.match(render[1], /canPost: !GroupChat\._readOnly\(\)/);
  assert.match(render[1], /appName: \(typeof AppView !== 'undefined' && AppView\.appData && AppView\.appData\.name\)/);

  const append = stripped.match(/\n {2}appendMessage\(msg\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(append, 'appendMessage() found');
  assert.match(append[1], /appendTranscriptMessage\(GroupChat\._messageView\(msg\)\)/, 'a live row is a row like any other');
});

// ── The fixture and the declared checks ───────────────────────────────

test('the quiet fixture app holds two settled submissions with their merges, two notices the chat hides, and one open vote; the checks read exactly them', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /await seedStagingQuietDiscussion\(pool\);/);
  const seed = migrate.match(/async function seedStagingQuietDiscussion\(pool\) \{([\s\S]*?)\n\}\n/);
  assert.ok(seed, 'seedStagingQuietDiscussion defined');
  assert.match(seed[1], /USERNODE_ENV !== 'staging'\) return;/, 'a no-op outside staging');
  assert.match(seed[1], /'staging-demo-quiet'/);
  assert.match(seed[1], /'staging-demo-quiet-builder'/);
  assert.match(seed[1], /ON CONFLICT DO NOTHING/);
  const gc = loadGroupChat();
  const rows = [...seed[1].matchAll(/\((9001\d\d), 900110, NULL,\s*'((?:[^']|'')*)',\s*'(vote|system|message)', '([^']*)'/g)]
    .map(([, id, content, type, meta]) => ({ id, content: content.replace(/''/g, "'"), type, meta }));
  assert.deepEqual(rows.map((r) => r.id), ['900111', '900112', '900113', '900114', '900115', '900116', '900117']);
  const events = rows.map((r) => gc._proposalEvent({ content: r.content, metadata: JSON.parse(r.meta) }, r.type));
  assert.deepEqual(events.map((e) => (e ? e.type : null)),
    ['submitted', 'merged', 'submitted', null, 'merged', null, 'submitted']);
  assert.equal(events[6].sessionId, '900110', 'the open one carries the tag the live path writes');
  assert.equal(events[0].sessionId, '', 'the settled ones predate it');
  assert.equal(events[4].votes, '1/1');
  assert.ok(rows.every((r) => r.type !== 'message'), 'no row from a person');
  assert.match(seed[1], /INSERT INTO chat_sessions[\s\S]*?VALUES \(900110, 900110, 900110, [^)]*'promoted'/);

  const dapp = JSON.parse(read('dapp.json'));
  const checks = dapp.tests.filter((t) => /staging-demo-quiet\/dev\/chat/.test(t.path));
  assert.equal(checks.length, 4);
  assert.ok(!dapp.tests.some((t) => /activity-open|gc-activity/.test(`${t.path} ${t.expectSelector}`)), 'no digest anywhere in the manifest');
  const visual = checks.find((t) => t.visual);
  assert.ok(visual && visual.id === 'group-chat.proposal-event');
  assert.ok(visual.impact.includes('frontend/src/features/group-chat/**'));
  assert.ok(visual.impact.includes('src/db/migrate.js'), 'the fixture is part of what the shot shows');
  // One selector asserting the whole row, not an OR of two halves. The
  // header line is the row primitive's markup (chat.tsx `ChatMessageRow`):
  // the name and the stamp each sit in their OWN wrapper span, so the sender
  // and `.gc-msg-time` are cousins, never siblings — a `~` between them
  // could not match anything, and did not. The box is asserted through
  // `:has()` on the row, and its href by SUBSTRING: the check runner opens
  // every page as `…/dev/chat?token=<jwt>` (capture/capture.js), and
  // App._appUrl carries the page's query onto every link it serialises, so on
  // staging the door reads `/dev/proposals/900110?token=…` and `href$=` fails
  // where `href*=` holds.
  assert.match(visual.expectSelector, /^#gc-messages > \.gc-event\[data-event="submitted"\]\[data-open\]\[data-msg-id="900117"\]:has\(a\.gc-event-box\[href\*="\/dev\/proposals\/900110"\] > \.dev-card-icon \+ \.gc-event-text\) span:has\(> \[data-event-sender\]\) \+ span > \.gc-msg-time\[title\]$/, 'the row: open, its box a door with a glyph and a line, the sender then the stamp on the header line');
  assert.doesNotMatch(visual.expectSelector, /href\$=/, 'never the suffix match: the runner\'s ?token= rides on every link');
  assert.ok(visual.expectSelector.length <= 256, 'app-manifest.js truncates a longer selector, silently breaking it');
  assert.equal(visual.expectText, 'Proposed PR #900110 for a vote');
  const sender = checks.find((t) => t.expectText === 'staging-demo-quiet-builder');
  assert.ok(sender && /\[data-event-sender\]/.test(sender.expectSelector));
  const merge = checks.find((t) => /data-event="merged"/.test(t.expectSelector));
  assert.ok(merge && /:not\(\[data-open\]\) div\.gc-event-box > \.dev-card-icon \+ \.gc-event-text/.test(merge.expectSelector), 'a merge: no door until its proposal is known, never open');
  assert.equal(merge.expectText, 'went live with 1/1 votes');
  const quiet = checks.find((t) => /gc-quiet\[data-quiet-chat\]/.test(t.expectSelector));
  assert.ok(quiet && quiet.expectText === 'Nobody has said anything here yet');
  assert.match(quiet.expectSelector, /\.gc-event\[data-msg-id="900117"\] ~ \.gc-quiet/, 'after the open proposal');
});

test('every class in the components is a complete literal, so Tailwind compiles it', () => {
  for (const file of [EVENT, QUIET]) {
    const src = read(file);
    assert.doesNotMatch(src, /className=\{`/, `${file}: no template-literal class names`);
    for (const [, a, b] of src.matchAll(/className: '([^']+)'|className="([^"]+)"/g)) {
      for (const token of String(a || b || '').split(/\s+/)) {
        assert.doesNotMatch(token, /\$\{|\bgray-|\bindigo-/, `${file}: ${token}`);
      }
    }
  }
});
