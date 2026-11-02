'use strict';
// "when you go to a dm / discussion with unread messages, start so that the
// top of the screen is where you've unread, and have a little unread banner,
// like I think discord or slack does? And some little button to scroll down
// / indicates you can scroll down, like claude does" (Evan, 5 Oct 2026).
//
// frontend/src/features/messages/unread-anchor.ts decides; the conversation
// (frontend/src/features/messages/index.tsx) measures and draws, with the
// three pieces in frontend/@/components/ui/chat.tsx; the store
// (frontend/src/features/messages/store.ts) takes where reading had stopped
// from the server (src/services/conversations.js, through
// frontend/src/features/messages/api.ts) before the open reads it.
//
// Pinned here:
//   1. the anchor: the first unread (somebody else's, counted as the server
//      counts) or, with none, the newest as before; where the opening puts
//      the scroller;
//   2. the banner: its words, and when it goes;
//   3. Jump to latest: when it shows, its dot and its name;
//   4. the hook, run against a fake scroller and a fake React;
//   5. the line held while the rows above it fill in;
//   6. the pieces as drawn: compositor-only motion, inert when hidden;
//   7. the store takes the mark before reading, and keeps it while open;
//   8. the server says where reading stopped;
//   9. the conversation wires it in that order;
//  10. Jump to latest alone (frontend/src/features/messages/jump-to-latest.tsx):
//      a reply thread, the agent sessions (frontend/src/features/agent-session/
//      index.tsx), and the group
//      chat's channel and threads (frontend/src/features/group-chat/
//      general-chat.tsx, frontend/src/features/group-chat/thread-shell.tsx),
//      whose rows and scrolling public/js/group-chat.js owns.
//
// Run with: node --test tests/messages-unread-anchor.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const MODULE = 'frontend/src/features/messages/unread-anchor.ts';
const CHAT = 'frontend/@/components/ui/chat.tsx';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const THREAD = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');

const ME = 7;
const row = (id, extra = {}) => ({ id, mine: false, countable: true, ...extra });

// ── 1. The anchor ───────────────────────────────────────────────────────

test('the first unread is the first message after the cursor that somebody else wrote', () => {
  const { firstUnreadId } = loadTsx(MODULE);
  const rows = [row(10), row(11), row(12, { mine: true }), row(13, { countable: false }), row(14), row(15)];
  assert.equal(firstUnreadId(rows, 11), 14, 'your own message and an uncounted one are not where unread begins');
  assert.equal(firstUnreadId(rows, 9), 10);
  assert.equal(firstUnreadId(rows, 0), 10, 'a cursor of 0 has read nothing: everything is new');
  assert.equal(firstUnreadId(rows, 15), null, 'nothing after the cursor: the conversation opens at its newest');
  assert.equal(firstUnreadId([row(20, { mine: true })], 19), null, 'only your own after it: nothing is unread');
  assert.equal(firstUnreadId([row(-3)], 0), null, 'a row still sending is never unread');
});

test('a message counts the way the server counts it: main stream, a person, stored, not deleted', () => {
  const { messageRow } = loadTsx(MODULE);
  const base = { id: 5, sender: { id: 3 } };
  assert.deepEqual(messageRow(base, ME), { id: 5, mine: false, countable: true });
  assert.equal(messageRow({ ...base, sender: { id: ME } }, ME).mine, true);
  assert.equal(messageRow(base, 0).mine, false, 'nobody signed in owns nothing');
  for (const flag of [{ threadRootId: 2 }, { deleted: true }, { system: true }, { pending: true }, { failed: true }, { id: -1 }]) {
    assert.equal(messageRow({ ...base, ...flag }, ME).countable, false, JSON.stringify(flag));
  }
});

test('a mark is taken only when something was unread and the server said where reading stopped', () => {
  const { markFor } = loadTsx(MODULE);
  const member = { membershipStatus: 'member', unreadCount: 3, lastReadMessageId: 41 };
  assert.deepEqual(markFor(9, member), { conversationId: 9, lastReadId: 41, count: 3 });
  assert.deepEqual(markFor(9, { ...member, lastReadMessageId: 0 }), { conversationId: 9, lastReadId: 0, count: 3 },
    'read nothing yet: from the first message');
  assert.equal(markFor(9, { ...member, unreadCount: 0 }), null, 'nothing unread: open at the newest, as today');
  assert.equal(markFor(9, { ...member, lastReadMessageId: null }), null, 'an older server: as today');
  assert.equal(markFor(9, { ...member, lastReadMessageId: undefined }), null);
  assert.equal(markFor(9, { ...member, membershipStatus: 'invited' }), null, 'an invitation has no unread state');
  assert.equal(markFor(9, null), null);
});

test('the opening puts the "New" line a row or two below the top, never past the bottom', () => {
  const { openingScrollTop, UNREAD_CONTEXT_PX } = loadTsx(MODULE);
  assert.equal(UNREAD_CONTEXT_PX, 64);
  const box = { scrollHeight: 4000, clientHeight: 600 };
  assert.deepEqual(openingScrollTop({ ...box, lineTop: 1500 }), { top: 1436, pinned: false },
    'the line 64px under the top, what was read just above it');
  assert.deepEqual(openingScrollTop({ ...box, lineTop: 30 }), { top: 0, pinned: false }, 'never above the first row');
  assert.deepEqual(openingScrollTop({ ...box, lineTop: 3700 }), { top: 3400, pinned: true },
    'everything new fits at the bottom: it opens there and follows what arrives');
  assert.deepEqual(openingScrollTop({ ...box, lineTop: 3350 }), { top: 3286, pinned: true },
    'within the follow allowance of the bottom counts as at it');
  assert.deepEqual(openingScrollTop({ ...box, lineTop: 3250 }), { top: 3186, pinned: false });
  assert.deepEqual(openingScrollTop({ scrollHeight: 300, clientHeight: 600, lineTop: 120 }), { top: 0, pinned: true },
    'a short conversation has nowhere to scroll');
});

test('where the line is from the scroller\'s content', () => {
  const { lineTopIn } = loadTsx(MODULE);
  const scroller = { scrollTop: 900, getBoundingClientRect: () => ({ top: 80 }) };
  const line = { getBoundingClientRect: () => ({ top: 230 }) };
  assert.equal(lineTopIn(scroller, line), 1050);
});

// ── 2. The banner ───────────────────────────────────────────────────────

test('the banner says how many in words, and nothing for none', () => {
  const { newMessagesLabel } = loadTsx(MODULE);
  assert.equal(newMessagesLabel(1), '1 new message');
  assert.equal(newMessagesLabel(3), '3 new messages');
  assert.equal(newMessagesLabel(240), '240 new messages', 'the real count');
  for (const none of [0, -2, NaN, undefined]) assert.equal(newMessagesLabel(none), '', String(none));
});

test('the line\'s place against the screen', () => {
  const { linePlace } = loadTsx(MODULE);
  assert.equal(linePlace(64, 600), 'in-view');
  assert.equal(linePlace(0, 600), 'in-view');
  assert.equal(linePlace(-1, 600), 'passed', 'scrolled on past it');
  assert.equal(linePlace(600, 600), 'below', 'still to come');
});

test('the banner stays for the opening and goes once the reader moves onto the line or past it, or reaches the bottom', () => {
  const { nextBanner, BANNER_START } = loadTsx(MODULE);
  const step = (state, place, atBottom = false) => nextBanner(state, { place, atBottom });

  let s = step(BANNER_START, 'in-view');
  assert.equal(s.dismissed, false, 'the opening puts the line in view: that is what the banner is for');
  s = step(s, 'in-view');
  assert.equal(s.dismissed, false, 'nothing moved');
  assert.equal(step(s, 'passed').dismissed, true, 'read on past it');

  const up = step(s, 'below');
  assert.equal(up.dismissed, false, 'scrolled up above it: a tap brings them back');
  assert.equal(step(up, 'in-view').dismissed, true, 'scrolled back down onto it');

  assert.equal(step(s, 'in-view', true).dismissed, true, 'the bottom: everything new has been seen');
  assert.equal(step(BANNER_START, 'in-view', true).dismissed, true, 'opened at the bottom: all of it on screen');

  const linked = step(BANNER_START, 'passed');
  assert.equal(linked.dismissed, false, 'opened further on (a link): it stays until the reader scrolls');
  const gone = step(s, 'passed');
  assert.equal(step(gone, 'below').dismissed, true, 'gone for good once gone');
  assert.equal(step(BANNER_START, null).dismissed, false, 'no line drawn: nothing to decide');
});

// ── 3. Jump to latest ───────────────────────────────────────────────────

test('Jump to latest shows whenever a new message would not be followed', () => {
  const { jumpShown } = loadTsx(MODULE);
  const { STICK_SLACK_PX } = loadTsx('frontend/src/features/messages/stick-to-bottom.ts');
  const at = (scrollTop) => jumpShown({ scrollHeight: 3000, clientHeight: 600, scrollTop });
  assert.equal(at(2400), false, 'at the bottom');
  assert.equal(at(2400 - STICK_SLACK_PX), false, 'within the follow allowance');
  assert.equal(at(2400 - STICK_SLACK_PX - 1), true, 'past it');
  assert.equal(at(0), true, 'up in history');
  assert.equal(jumpShown({ scrollHeight: 300, clientHeight: 600, scrollTop: 0 }), false, 'nothing to scroll');
});

test('the dot counts what somebody else wrote after the newest message the reader saw at the bottom', () => {
  const { arrivalsAfter, newestId, jumpLabel } = loadTsx(MODULE);
  const rows = [row(1), row(2), row(3, { mine: true }), row(4), row(5, { countable: false }), row(-1)];
  assert.equal(newestId(rows), 5);
  assert.equal(arrivalsAfter(rows, 2), 1, 'your own and an uncounted one are no news');
  assert.equal(arrivalsAfter(rows, 5), 0);
  assert.equal(jumpLabel(0), 'Jump to latest');
  assert.equal(jumpLabel(1), 'Jump to latest, 1 new message');
  assert.equal(jumpLabel(4), 'Jump to latest, 4 new messages');
});

test('the smooth scrolls respect a reader who asked for less motion', () => {
  const { scrollBehavior } = loadTsx(MODULE);
  assert.equal(scrollBehavior({ matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }), 'auto');
  assert.equal(scrollBehavior({ matchMedia: () => ({ matches: false }) }), 'smooth');
  assert.equal(scrollBehavior({}), 'smooth');
  assert.equal(scrollBehavior({ matchMedia: () => { throw new Error('no'); } }), 'auto');
});

// ── 4. The hook, executed ───────────────────────────────────────────────

// A scroller as far as the module reads one: scrollTop clamps, `scroll()` is a
// scroll event, and the line is a row at a fixed place in its content.
function fakeScroller({ scrollHeight, clientHeight, scrollTop = 0 }) {
  const listeners = new Map();
  let top = scrollTop;
  const el = {
    nodeType: 1,
    scrollHeight,
    clientHeight,
    children: [],
    scrolledTo: [],
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect: () => ({ top: 100 }),
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)); },
    listenerCount(type) { return (listeners.get(type) || []).length; },
    fire(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    scroll() { this.fire('scroll'); },
    scrollTo({ top: to, behavior }) { this.scrolledTo.push({ top: to, behavior }); this.scrollTop = to; },
  };
  return el;
}
function fakeLine(el, at) {
  return { nodeType: 1, at, getBoundingClientRect() { return { top: 100 + this.at - el.scrollTop }; } };
}

// Just enough React for one hook: refs, state, effects after a "commit" when
// their deps change, cleanups on change and unmount.
function fakeReact() {
  let slots = [];
  let i = 0;
  const pending = [];
  const effect = (fn, deps) => {
    const k = i++;
    const prev = slots[k];
    const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, j) => d !== prev.deps[j]);
    if (!prev) slots[k] = { deps, cleanup: null };
    if (changed) pending.push(() => {
      if (slots[k].cleanup) slots[k].cleanup();
      slots[k].deps = deps;
      const c = fn();
      slots[k].cleanup = typeof c === 'function' ? c : null;
    });
  };
  const React = {
    useRef(init) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useState(init) {
      const k = i++;
      if (!slots[k]) slots[k] = { value: init };
      const slot = slots[k];
      return [slot.value, (next) => { slot.value = next; }];
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
  return {
    React,
    render(hook) { i = 0; const out = hook(); pending.splice(0).forEach((run) => run()); return out; },
    unmount() { slots.forEach((s) => s && s.cleanup && s.cleanup()); slots = []; },
  };
}

function withFrames(t) {
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => { [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved; });
  return () => { for (const fn of frames.splice(0)) fn(); };
}

test('the hook: the banner for the opening, Jump to latest off the bottom, a dot for what arrives', (t) => {
  const tick = withFrames(t);
  const r = fakeReact();
  const { useUnreadAffordances } = loadTsx(MODULE, { stubs: { react: r.React } });
  const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600 });
  const scroller = { current: el };
  const line = { current: fakeLine(el, 1500) };
  let rows = [row(1), row(2), row(3), row(4)];
  const use = () => useUnreadAffordances(scroller, line, { conversation: 9, markKey: '9:2', lineAt: 3, rows });

  el.scrollTop = 1436; // where the opening put it
  r.render(use);
  let { view } = r.render(use);
  assert.deepEqual(view, { banner: true, jump: true, arrived: 0 },
    'opened at the first unread: the count is up, and so is the way down');
  assert.equal(el.listenerCount('scroll'), 1);

  // Somebody writes while the reader is up the transcript.
  rows = [...rows, row(5), row(6, { mine: true })];
  el.scrollHeight += 200;
  r.render(use);
  ({ view } = r.render(use));
  assert.equal(view.arrived, 1, 'their message is news; the reader\'s own is not');
  assert.equal(view.banner, true, 'a message arriving is not the reader moving');

  // The reader scrolls on past the line.
  el.scrollTop = 1700;
  el.scroll();
  tick();
  ({ view } = r.render(use));
  assert.equal(view.banner, false, 'read on past it: the banner goes');
  assert.equal(view.jump, true);

  // Jump to latest.
  const { toLatest } = r.render(use);
  toLatest();
  assert.deepEqual(el.scrolledTo.at(-1), { top: el.scrollHeight, behavior: 'smooth' });
  el.scroll();
  tick();
  ({ view } = r.render(use));
  assert.deepEqual(view, { banner: false, jump: false, arrived: 0 }, 'at the bottom: nothing over the transcript');

  // Up again: the button comes back with no dot until something arrives.
  el.scrollTop = 800;
  el.scroll();
  tick();
  ({ view } = r.render(use));
  assert.deepEqual(view, { banner: false, jump: true, arrived: 0 });
  r.unmount();
  assert.equal(el.listenerCount('scroll'), 0, 'unmount lets the scroller go');
});

test('the hook: a tap on the banner goes back to the line; a link opening offers no banner', (t) => {
  const tick = withFrames(t);
  const r = fakeReact();
  const { useUnreadAffordances } = loadTsx(MODULE, { stubs: { react: r.React } });
  const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 1436 });
  const line = { current: fakeLine(el, 1500) };
  const rows = [row(1), row(2), row(3)];
  let offerBanner = true;
  const use = () => useUnreadAffordances({ current: el }, line, { conversation: 9, markKey: '9:2', lineAt: 3, rows, offerBanner });
  r.render(use);
  let out = r.render(use);
  el.scrollTop = 400; // up into what was read
  el.scroll();
  tick();
  out = r.render(use);
  assert.equal(out.view.banner, true, 'above the line, the banner stays to bring them back');
  out.toLine();
  assert.deepEqual(el.scrolledTo.at(-1), { top: 1436, behavior: 'smooth' }, 'back to the line, as the opening put it');
  out = r.render(use);
  assert.equal(out.view.banner, false, 'the tap is the banner done');

  offerBanner = false;
  const linked = fakeReact();
  const mod = loadTsx(MODULE, { stubs: { react: linked.React } });
  const use2 = () => mod.useUnreadAffordances({ current: el }, line, { conversation: 9, markKey: '9:2', lineAt: 3, rows, offerBanner });
  linked.render(use2);
  assert.equal(linked.render(use2).view.banner, false, 'opened at a linked message: the line, and no banner');
});

test('run six: a tap on the banner always moves toward the new messages', () => {
  const { bannerTarget, BANNER_STILL_PX } = loadTsx(MODULE);
  assert.equal(BANNER_STILL_PX, 24);
  const box = { lineTop: 1500, scrollHeight: 4000, clientHeight: 600 };
  // Up in what was read: back to the line, placed as the opening places it.
  assert.deepEqual(bannerTarget({ ...box, scrollTop: 400 }), { top: 1436, to: 'line' });
  // Read on a little, the line still in view: back up to it.
  assert.deepEqual(bannerTarget({ ...box, scrollTop: 1600 }), { top: 1436, to: 'line' });
  // At the line already (where the opening put it): a glide there would not
  // move, so on to the latest, where the new messages end.
  assert.deepEqual(bannerTarget({ ...box, scrollTop: 1436 }), { top: 3400, to: 'latest' });
  assert.deepEqual(bannerTarget({ ...box, scrollTop: 1436 + BANNER_STILL_PX - 1 }), { top: 3400, to: 'latest' });
  assert.deepEqual(bannerTarget({ ...box, scrollTop: 1436 + BANNER_STILL_PX }), { top: 1436, to: 'line' });
  // A line near the end is placed no further than the bottom.
  assert.deepEqual(bannerTarget({ lineTop: 3900, scrollHeight: 4000, clientHeight: 600, scrollTop: 0 }), { top: 3400, to: 'line' });
});

test('the hook: a tap on the banner where the opening left the reader goes on to the latest, and the banner goes', (t) => {
  const tick = withFrames(t);
  const r = fakeReact();
  const { useUnreadAffordances } = loadTsx(MODULE, { stubs: { react: r.React } });
  const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 1436 });
  const line = { current: fakeLine(el, 1500) };
  const rows = [row(1), row(2), row(3)];
  const use = () => useUnreadAffordances({ current: el }, line, { conversation: 9, markKey: '9:2', lineAt: 3, rows });
  r.render(use);
  let out = r.render(use);
  assert.equal(out.view.banner, true, 'opened at the line: "2 new messages" is up');
  out.toLine();
  assert.deepEqual(el.scrolledTo.at(-1), { top: 3400, behavior: 'smooth' },
    'the transcript moves: to the latest, not "to the line" it already shows (run six)');
  el.scroll();
  tick();
  out = r.render(use);
  assert.deepEqual(out.view, { banner: false, jump: false, arrived: 0 }, 'the banner is done, and at the bottom nothing floats');

  // With no line drawn any more, a tap still goes to where what is new ends.
  const bare = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 100 });
  const r2 = fakeReact();
  const mod = loadTsx(MODULE, { stubs: { react: r2.React } });
  const use2 = () => mod.useUnreadAffordances({ current: bare }, { current: null }, { conversation: 9, markKey: '9:2', lineAt: null, rows });
  r2.render(use2);
  r2.render(use2).toLine();
  assert.deepEqual(bare.scrolledTo.at(-1), { top: 4000, behavior: 'smooth' });
});

test('the hook: nothing at all over a conversation at its bottom with nothing new', (t) => {
  withFrames(t);
  const r = fakeReact();
  const { useUnreadAffordances } = loadTsx(MODULE, { stubs: { react: r.React } });
  const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 3400 });
  const use = () => useUnreadAffordances({ current: el }, { current: null }, { conversation: 9, markKey: '', lineAt: null, rows: [row(1)] });
  r.render(use);
  assert.deepEqual(r.render(use).view, { banner: false, jump: false, arrived: 0 });
  const empty = fakeReact();
  const mod = loadTsx(MODULE, { stubs: { react: empty.React } });
  const none = () => mod.useUnreadAffordances({ current: null }, { current: null }, { conversation: null, markKey: '', lineAt: null, rows: [] });
  empty.render(none);
  assert.deepEqual(empty.render(none).view, { banner: false, jump: false, arrived: 0 }, 'no conversation drawn');
});

// ── 5. The line held while the rows above it fill in ────────────────────

function fakeObservers() {
  const sizes = { callback: null, observed: new Set(), disconnected: 0 };
  const rows = { callback: null, disconnected: 0 };
  const timers = [];
  return {
    sizes,
    rows,
    timers,
    env: {
      ResizeObserver: class { constructor(cb) { sizes.callback = cb; } observe(el) { sizes.observed.add(el); } unobserve(el) { sizes.observed.delete(el); } disconnect() { sizes.disconnected += 1; } },
      MutationObserver: class { constructor(cb) { rows.callback = cb; } observe() {} disconnect() { rows.disconnected += 1; } },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
    },
  };
}

test('an image filling in above the line does not push the reader\'s place down', () => {
  const { attachLineHold, LINE_HOLD_MS } = loadTsx(MODULE);
  const { env, sizes, timers } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 1436 });
  const above = { nodeType: 1 };
  el.children = [above];
  const line = fakeLine(el, 1500);
  attachLineHold(el, line, env);
  assert.ok(sizes.observed.has(above), 'the rows are watched');
  assert.equal(timers[0].ms, LINE_HOLD_MS);

  line.at += 240; // a link card above it filled in
  el.scrollHeight += 240;
  sizes.callback();
  assert.equal(el.scrollTop, 1676, 'moved by however far the line moved');
  el.scroll(); // the hold's own scroll
  line.at += 80;
  el.scrollHeight += 80;
  sizes.callback();
  assert.equal(el.scrollTop, 1756, 'and still holding after its own scroll');
});

test('the hold ends with the reader: a touch, a scroll not its own, or the clock', () => {
  const { attachLineHold } = loadTsx(MODULE);
  for (const end of ['touchstart', 'wheel', 'keydown', 'mousedown', 'scroll', 'clock']) {
    const { env, sizes, timers } = fakeObservers();
    const el = fakeScroller({ scrollHeight: 4000, clientHeight: 600, scrollTop: 1436 });
    const line = fakeLine(el, 1500);
    attachLineHold(el, line, env);
    if (end === 'scroll') { el.scrollTop = 3400; el.scroll(); } // a send took them to the bottom
    else if (end === 'clock') timers[0].fn();
    else el.fire(end);
    const before = el.scrollTop;
    line.at += 300;
    el.scrollHeight += 300;
    sizes.callback();
    assert.equal(el.scrollTop, before, `${end}: the reader's place is theirs again`);
    assert.equal(sizes.disconnected, 1, `${end}: observers let go`);
    assert.equal(el.listenerCount('scroll'), 0);
    assert.equal(el.listenerCount('touchstart'), 0);
  }
});

// ── 6. As drawn ─────────────────────────────────────────────────────────

test('the "New" line, the banner and the jump button, as drawn', () => {
  const chat = loadTsx(CHAT);
  const line = renderToHtml(createElement(chat.NewMessagesDivider, {}));
  assert.match(line, /^<div role="separator" aria-label="New messages" data-unread-line=""/);
  assert.match(line, />New<\/span>/, 'sentence case: small caps are for section labels only');
  assert.match(line, /bg-violet-500\/60/, 'the accent: it asks for attention');

  const banner = (shown) => renderToHtml(createElement(chat.NewMessagesBanner, { shown }, '3 new messages'));
  assert.match(banner(true), /^<button type="button" data-unread-banner=""/);
  assert.doesNotMatch(banner(true), /inert/);
  assert.match(banner(true), /translate-y-0 opacity-100/);
  assert.match(banner(true), />3 new messages<\/button>$/);
  assert.match(banner(false), /inert=""/, 'hidden: no pointer, no focus, nothing read out');
  assert.match(banner(false), /pointer-events-none -translate-y-2 opacity-0/);

  const jump = (props) => renderToHtml(createElement(chat.JumpToLatestButton, { 'aria-label': 'Jump to latest', ...props }));
  assert.match(jump({ shown: true }), /aria-label="Jump to latest"/);
  assert.match(jump({ shown: true }), /rounded-full/);
  assert.match(jump({ shown: true }), /<svg[^>]*><path[^>]*d="M19 9l-7 7-7-7"/, 'the shell\'s own down chevron');
  assert.doesNotMatch(jump({ shown: true }), /bg-violet-600 ring-2/, 'no dot without news');
  assert.match(jump({ shown: true, dot: true }), /bg-violet-600 ring-2/);
  assert.match(jump({ shown: false }), /inert=""/);
  assert.match(jump({ shown: false }), /pointer-events-none translate-y-2 scale-90 opacity-0/);

  // The banner is centred over the top, and Jump to latest over the foot,
  // low (1 Nov 2026, Evan's call; it sat at the right edge from run six).
  const overlay = (edge) => renderToHtml(createElement(chat.TranscriptOverlay, { edge }));
  assert.equal(overlay('top'), '<div class="relative z-10 h-0 shrink-0" data-transcript-overlay="top"><div class="pointer-events-none absolute inset-x-0 flex top-2 justify-center px-4"></div></div>');
  assert.equal(overlay('foot'), '<div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot"><div class="pointer-events-none absolute inset-x-0 flex bottom-2 justify-center px-3"></div></div>');
  assert.doesNotMatch(overlay('foot'), /justify-end/);

  // On the compositor: opacity and transform only, no delay, no size change.
  for (const html of [banner(true), jump({ shown: true })]) {
    assert.match(html, /transition-\[opacity,transform\] duration-200 ease-out motion-reduce:transition-none/);
    assert.doesNotMatch(html, /delay-|transition-all|transition-\[[^\]]*(width|height)/);
  }
});

// ── 7. The store ────────────────────────────────────────────────────────

const BOT = { id: 99, username: 'homeroom_bot', avatarUrl: null, bot: true };
function storeHarness(t, { unread }) {
  const saved = ['window', 'document', 'fetch', 'localStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  let stop = () => {};
  t.after(() => {
    stop();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const message = (id) => ({
    id, conversationId: 42, sender: BOT, content: `m${id}`, createdAt: new Date(Date.UTC(2026, 9, 5, 11, 48, id)).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [],
  });
  const server = { messages: [1, 2, 3, 4].map(message), cursor: 4 - unread };
  const log = [];
  const count = () => server.messages.filter((m) => m.id > server.cursor).length;
  const api = {
    MessagesApiError: class extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [],
    getConversation: async () => {
      log.push(['detail', server.cursor]);
      return {
        id: 42, kind: 'direct', title: 'Homeroom bot', membershipStatus: 'member', canSend: true, members: [],
        unreadCount: count(), lastReadMessageId: server.cursor, lastActivityAt: new Date().toISOString(),
      };
    },
    listMessages: async () => ({ messages: server.messages.map((item) => ({ ...item })), nextBefore: null }),
    markRead: async (conversationId, messageId) => { log.push(['read', messageId]); server.cursor = messageId; },
  };
  const on = () => {};
  globalThis.window = {
    App: { user: { id: 7, username: 'alex' } },
    location: { search: '', hash: '#messages/42' },
    addEventListener: on, removeEventListener: on, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: on, removeEventListener: on };
  globalThis.fetch = async () => ({ ok: false, json: async () => null });
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const react = { useSyncExternalStore: (subscribe, get) => get() };
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  stop = store.initializeMessagesStore();
  const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const snap = () => store.useMessagesSnapshot();
  const arrives = async (id) => {
    server.messages.push(message(id));
    store.messagesController.handleEvent({ type: 'conversation_message_created', conversationId: 42, messageId: id });
    await flush();
  };
  return { store, log, flush, snap, arrives, server };
}

test('the store takes where reading stopped before the open reads it, and keeps it while the conversation is open', async (t) => {
  const h = storeHarness(t, { unread: 2 });
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  assert.deepEqual(h.log.slice(0, 2), [['detail', 2], ['read', 4]], 'the cursor is read first, then the open reads to the end');
  assert.deepEqual(h.snap().unreadMark, { conversationId: 42, lastReadId: 2, count: 2 });

  await h.arrives(5); // a refresh of the conversation on screen
  assert.ok(h.log.some(([kind, at]) => kind === 'detail' && at === 4), 'the refresh read the moved cursor');
  assert.deepEqual(h.snap().unreadMark, { conversationId: 42, lastReadId: 2, count: 2 }, 'the line stays where it was');

  h.store.messagesController.route(null);
  await h.flush();
  assert.equal(h.snap().unreadMark, null, 'closed: the line goes with it');
  h.store.messagesController.route(42);
  await h.flush();
  assert.equal(h.snap().unreadMark, null, 'opened again with nothing unread: at the newest, as today');
});

test('nothing unread: no mark, so the conversation opens at its newest as it always did', async (t) => {
  const h = storeHarness(t, { unread: 0 });
  await h.flush();
  h.store.messagesController.route(42);
  await h.flush();
  assert.equal(h.snap().unreadMark, null);
  await h.arrives(5);
  assert.equal(h.snap().unreadMark, null, 'a message landing on the open conversation draws no line');
});

test('the store clears the mark wherever a conversation closes, and Mark unread moves it', () => {
  assert.match(STORE, /import \{ markFor \} from '\.\/unread-anchor';/);
  assert.match(STORE, /const unreadMark = state\.unreadMark\?\.conversationId === conversationId\s*\? state\.unreadMark\s*: preserveVisibleThread \? null : markFor\(conversationId, active\);/);
  assert.match(STORE, /publish\(\{ active, messages, nextBefore: page\.nextBefore, nextAfter: page\.nextAfter, loadingThread: false, online: true, unreadMark \}\);[\s\S]{0,1500}readMainWhenThere\(conversationId\)/,
    'published with the transcript, before the read');
  assert.match(STORE, /thread: null, nextAfter: null, unreadMark: null,\s*\}\);\s*\}\s*\/\*\*\s*\* #3494/, 'close()');
  assert.match(STORE, /discussionContext: null, discussionError: null, unreadMark: null,\s*\}\);\s*void loadConversations\(\);\s*void loadThread\(conversationId\);/, 'embed()');
  assert.match(STORE, /nextAfter: null,\s*(?:\/\/[^\n]*\n\s*)*unreadMark: null,/, 'route()');
  assert.match(STORE, /\{ unreadMark: \{ conversationId, lastReadId: messageId - 1, count: unreadCount \} \}/, 'Mark unread');
});

test('the API reads the cursor, 0 included', () => {
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /lastReadMessageId: readCursor\(pick\(row, 'lastReadMessageId', 'last_read_message_id'\)\),/);
  const { normalizeConversation } = loadTsx('frontend/src/features/messages/api.ts');
  assert.equal(normalizeConversation({ id: 3, lastReadMessageId: 0 }).lastReadMessageId, 0, 'read nothing yet');
  assert.equal(normalizeConversation({ id: 3, last_read_message_id: 12 }).lastReadMessageId, 12);
  assert.equal(normalizeConversation({ id: 3 }).lastReadMessageId, null, 'an older server: open at the newest');
  assert.equal(normalizeConversation({ id: 3, lastReadMessageId: -4 }).lastReadMessageId, null);
});

// ── 8. The server ───────────────────────────────────────────────────────

test('the server says where the viewer\'s reading stopped, beside the count, and only to a member', async () => {
  const conversations = require('../src/services/conversations');
  const row = (extra) => ({
    id: 5, kind: 'group', title: 'Plant Pal', status: 'active', created_by: 1, created_at: new Date(0), updated_at: new Date(0),
    deleted_peer: false, channel_key: null, my_role: 'member', membership_status: 'member', invited_by: null,
    last_read_message_id: 41, latest_message_id: null, has_messages: true, ...extra,
  });
  const pool = (r) => ({
    async query(sql) {
      if (/FROM conversations c\s+JOIN conversation_members me/.test(sql)) return { rows: [r] };
      if (/COUNT\(\*\)::int AS count FROM conversation_messages m/.test(sql)) return { rows: [{ count: 3 }] };
      return { rows: [] };
    },
  });
  const user = { id: 7 };
  const member = await conversations.getConversation(pool(row({})), user, 5);
  assert.equal(member.unreadCount, 3);
  assert.equal(member.lastReadMessageId, 41);
  assert.equal((await conversations.getConversation(pool(row({ last_read_message_id: null })), user, 5)).lastReadMessageId, 0,
    'read nothing yet');
  const invited = await conversations.getConversation(pool(row({ membership_status: 'invited' })), user, 5);
  assert.equal(invited.lastReadMessageId, null, 'hidden until accepted, like the count');
});

// ── 9. The conversation wires it, in that order ─────────────────────────

test('the conversation opens at the line, draws it once, and measures after its own scroll', () => {
  assert.match(THREAD, /import \{\s*ChatStatusLine, JumpToLatestButton, NewMessagesBanner, NewMessagesDivider, TranscriptOverlay, groupsWithPrevious,\s*\} from '@\/components\/ui\/chat';/);
  // The opening comes after a message link's landing and before the follow.
  const focus = THREAD.indexOf('if (focusId && shownFocus.current === focusId && snap.nextAfter)');
  const opening = THREAD.indexOf('if (previousLast.current === null && line && !snap.nextAfter) {');
  const follow = THREAD.indexOf('if (previousLast.current === null || sentNow || pinned.current) {');
  assert.ok(focus > 0 && opening > focus && follow > opening, 'link, then unread, then the newest');
  assert.match(THREAD, /const at = openingScrollTop\(\{ lineTop: lineTopIn\(el, line\), scrollHeight: el\.scrollHeight, clientHeight: el\.clientHeight \}\);\s*el\.scrollTop = at\.top;\s*pinned\.current = at\.pinned;[\s\S]{0,120}if \(!at\.pinned\) holdLine\(el, line\);/);
  // The hook is declared after the scroll effect, so it measures the opening.
  const effectEnd = THREAD.indexOf('}, [snap.messages, focusId, snap.nextAfter]);');
  const hook = THREAD.indexOf('useUnreadAffordances(scroller, unreadLine, {');
  assert.ok(effectEnd > 0 && hook > effectEnd);
  assert.match(THREAD, /offerBanner: !focusId,/);
  assert.match(THREAD, /atPresent: !snap\.nextAfter,/);
  // The line: once, after the day separator, and above a fold that hides the first unread.
  assert.match(THREAD, /rows\.push\(<NewMessagesDivider key="unread-line" ref=\{unreadLine\} \/>\);/);
  assert.match(THREAD, /previousDay = day;\s*\}\s*if \(lineAt !== null && message\.id >= lineAt\) drawLine\(\);/);
  assert.match(THREAD, /if \(lineAt !== null && snap\.messages\[index \+ hidden\]\.id >= lineAt\) drawLine\(\);/);
  // The banner only with a mark (nothing for none); the button always there, hidden at the bottom.
  assert.match(THREAD, /\{mark \? \(\s*<TranscriptOverlay edge="top">\s*<NewMessagesBanner shown=\{unread\.banner\} onClick=\{toLine\}>\{newMessagesLabel\(mark\.count\)\}<\/NewMessagesBanner>\s*<\/TranscriptOverlay>\s*\) : null\}/);
  assert.equal(message('messages:thread.jumpToLatest'), 'Jump to latest');
  assert.match(THREAD, /<JumpToLatestButton shown=\{unread\.jump\} dot=\{unread\.arrived > 0\} aria-label=\{jumpLabel\(unread\.arrived\)\} title=\{t\('messages:thread\.jumpToLatest'\)\} onClick=\{jumpToLatest\} \/>/);
  // Both boxes sit beside the scroller, which keeps its class string.
  assert.match(THREAD, /<\/TranscriptOverlay>\s*\) : null\}\s*\{\/\*[\s\S]*?\*\/\}\s*<div ref=\{scroller\} className="messages-thread-scroll platform-safe-scroll chat-transcript" aria-live="polite">/);
  // Hung from the transcript's foot, just above the composer, and above the
  // typing line, as in every chat (1 November 2026, "A chat's foot" in
  // @/components/ui/chat): it rises with the transcript when a name appears.
  assert.match(THREAD, /<\/div>\s*\{\/\*[\s\S]*?\*\/\}\s*<TranscriptOverlay edge="foot">\s*<JumpToLatestButton shown=\{unread\.jump\}[^\n]*\/>\s*<\/TranscriptOverlay>\s*<ChatStatusLine className="messages-typing">\{typingLine\(t, typing\)\}<\/ChatStatusLine>\s*<MessageComposer \/>/,
    'the button hangs between the transcript and the typing line');
  // A linked window's latest is not drawn: the button goes to the present.
  assert.match(THREAD, /if \(snap\.nextAfter\) \{ pinned\.current = true; jumpToPresent\(\); return; \}\s*toLatest\(\);/);
});

// ── 10. Jump to latest alone ────────────────────────────────────────────

test('a transcript filled by somebody else is measured again when its rows change size', () => {
  const { attachContentWatch } = loadTsx(MODULE);
  const { env, sizes, rows } = fakeObservers();
  const el = fakeScroller({ scrollHeight: 600, clientHeight: 600 });
  const head = { nodeType: 1 };
  el.children = [head];
  let changes = 0;
  const detach = attachContentWatch(el, () => { changes += 1; }, env);
  assert.ok(sizes.observed.has(el) && sizes.observed.has(head));
  sizes.callback();
  assert.equal(changes, 1, 'a row grew');
  const added = { nodeType: 1 };
  rows.callback([{ addedNodes: [added, { nodeType: 3 }], removedNodes: [head] }]);
  assert.equal(changes, 2, 'rows came and went');
  assert.ok(sizes.observed.has(added) && !sizes.observed.has(head));
  detach();
  assert.equal(sizes.disconnected, 1);
  assert.equal(rows.disconnected, 1);
  assert.doesNotThrow(() => attachContentWatch(el, () => {}, {})(), 'nothing to watch with: nothing attached');
});

test('the hook, watching content: a topic opened at its card shows the way down once its discussion lands', (t) => {
  const tick = withFrames(t);
  const saved = [globalThis.ResizeObserver, globalThis.MutationObserver];
  const { env, sizes } = fakeObservers();
  globalThis.ResizeObserver = env.ResizeObserver;
  globalThis.MutationObserver = env.MutationObserver;
  t.after(() => { [globalThis.ResizeObserver, globalThis.MutationObserver] = saved; });
  const r = fakeReact();
  const { useUnreadAffordances } = loadTsx(MODULE, { stubs: { react: r.React } });
  const el = fakeScroller({ scrollHeight: 600, clientHeight: 600 });
  const use = () => useUnreadAffordances({ current: el }, { current: null }, {
    conversation: null, markKey: '', lineAt: null, rows: [], slack: 80, watchContent: true,
  });
  r.render(use);
  assert.equal(r.render(use).view.jump, false, 'nothing below yet');
  el.scrollHeight = 2400; // the history lands; the topic stays at its top, no scroll event
  sizes.callback();
  tick();
  assert.equal(r.render(use).view.jump, true);
  el.scrollTop = 1720; // within the thread's 80px
  el.scroll();
  tick();
  assert.equal(r.render(use).view.jump, false, 'the thread\'s own allowance, not the conversation\'s');
  r.unmount();
  assert.equal(sizes.disconnected, 1, 'unmount lets the rows go');
});

test('Jump to latest alone: hidden until the reader is up the transcript, and a sibling of the scroller', () => {
  const mod = loadTsx('frontend/src/features/messages/jump-to-latest.tsx');
  const html = renderToHtml(createElement(mod.JumpToLatest, { scroller: { current: null } }));
  assert.match(html, /^<div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot"><div class="pointer-events-none absolute inset-x-0 flex bottom-2 justify-center px-3"><button type="button" inert="" data-jump-latest=""/,
    'centred over the foot, low, just above the composer, with nothing behind it');
  assert.match(html, /aria-label="Jump to latest" title="Jump to latest"/);

  // 1 Nov 2026: no strip of its own any more (#4553, #5702). It cut the
  // transcript off above it and read as a solid box behind the disc.
  const SOURCE = read('frontend/src/features/messages/jump-to-latest.tsx');
  assert.doesNotMatch(SOURCE, /data-transcript-strip/);
  assert.doesNotMatch(SOURCE, /docked = false|docked\?: boolean/, 'and no prop to ask for one');

  assert.match(THREAD, /<\/div>\s*<JumpToLatest scroller=\{scroller\} \/>\s*\{\/\*[\s\S]*?\*\/\}\s*<ChatStatusLine className="messages-typing">\{typingLine\(t, threadTyping\)\}<\/ChatStatusLine>\s*<MessageComposer threadRootId=\{rootId\} \/>/, 'a reply thread beside a conversation');
});

test('the group chat\'s channel and threads get it beside their scrollers, at their own allowances', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const GROUP = read('public/js/group-chat.js');
  const general = loadTsx('frontend/src/features/group-chat/general-chat.tsx');
  assert.equal(general.GENERAL_FOLLOW_PX, 50);
  assert.match(GROUP, /const atBottom = container\.scrollHeight - container\.scrollTop - container\.clientHeight < 50;/,
    'the channel follows within 50px');
  const chat = renderComponent('frontend/src/features/group-chat/general-chat.tsx', 'GeneralChat',
    { introAppName: null, readOnly: false, notice: null, maxLength: 4000 });
  assert.match(chat, /<div id="gc-messages" class="flex-1 overflow-y-auto pt-2 space-y-0\.5 chat-transcript"><\/div><div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot">[\s\S]*?data-jump-latest=""[\s\S]*?<\/div><\/div><div id="gc-typing"/,
    'between the stream and its typing line, and nothing inside the stream');

  const shell = loadTsx('frontend/src/features/group-chat/thread-shell.tsx');
  assert.equal(shell.THREAD_FOLLOW_PX, 80);
  assert.match(GROUP, /THREAD_FOLLOW_PX: 80,/, 'a thread follows within 80px');
  assert.match(GROUP, /scroll\.scrollHeight - scroll\.scrollTop - scroll\.clientHeight < GroupChat\.THREAD_FOLLOW_PX/);
  const props = { withHeader: true, readOnly: false, notice: '', placeholder: 'Reply', maxLength: 4000 };
  const fill = renderComponent('frontend/src/features/group-chat/thread-shell.tsx', 'ThreadShell', { ...props, fill: true });
  // 1 Nov 2026: the button floats over the foot of the thread's scroller, as
  // in a chat, with nothing behind it. It docked in a strip of its own here
  // (#4553), which cut the transcript off above it and read as a solid box.
  assert.match(fill, /<div id="gc-thread-messages" class="pt-2 space-y-0\.5"><\/div><\/div><div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot"><div class="pointer-events-none absolute inset-x-0 flex bottom-2 justify-center px-3"><button type="button" inert="" data-jump-latest=""/,
    'after the thread\'s scroller, floating over its foot, centred');
  assert.doesNotMatch(fill, /data-transcript-strip/, 'no strip of its own');
  for (const kind of ['change', 'request']) {
    const page = renderComponent('frontend/src/features/group-chat/thread-shell.tsx', 'ThreadShell', { ...props, fill: true, [kind]: true });
    assert.match(page, /<div id="gc-thread-messages"><\/div><\/div><div class="relative z-10 h-0 shrink-0" data-transcript-overlay="foot">[\s\S]*?data-jump-latest=""/,
      `a ${kind}'s page floats the button over its transcript's foot`);
    assert.doesNotMatch(page, /data-transcript-strip/, `no strip cuts a ${kind}'s transcript off`);
  }
  const boxed = renderComponent('frontend/src/features/group-chat/thread-shell.tsx', 'ThreadShell', { ...props, fill: false });
  assert.doesNotMatch(boxed, /data-jump-latest/, 'the boxed layout is a small inline box: no floating control');
});

test('the agent sessions in Messages get the way down too, at their own allowance', () => {
  const session = read('frontend/src/features/agent-session/index.tsx');
  assert.match(session, /if \(el\) stick\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 80;/, 'an agent session follows within 80px');
  assert.match(session, /<\/div>\s*\{\/\*[^]*?\*\/\}\s*<JumpToLatest scroller=\{scroll\} slack=\{80\} \/>\s*<Replies /,
    'between the session\'s transcript and its suggested replies');
});
