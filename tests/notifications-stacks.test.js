'use strict';

// #5580: the Unread tab stacks each project's notifications the way the
// lock screen stacks an app's, folds one request's news into one card, and
// opens a card to what happened on its request or proposal.
//
// These tests pin, on the shipped sources:
//
//   1. foldStories: one story's notifications become one card where the
//      newest stood, the bot's included; a person's message, a row with its
//      own buttons and a story of one stay as they were.
//   2. The sheet's markup: a project with several cards is a closed stack
//      (its top card says how many more are under it and opens the stack;
//      the cards under it are the real ones, inert), a story card says its
//      request and count, and only a card about a request or a proposal
//      has a history to open.
//   3. historyLines: the steps in words, newest first, the story's other
//      notifications in their place, the card's own moment left out, and
//      other people's votes in a row as one line naming them in order.
//   4. rowView carries the story fields the fold reads, and the controller
//      reads a card's history from the route.
//
// Run with: node --test tests/notifications-stacks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const STACKS_PATH = 'frontend/src/features/notifications/notification-stacks.tsx';
const STACKS_SRC = read(STACKS_PATH);
const APP_CSS = read('public/css/app.css');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const stacks = loadTsx(STACKS_PATH);

const MIN = 60 * 1000;

const view = (id, overrides = {}) => ({
  id,
  kind: 'voted_change_merged',
  unread: true,
  unreadCls: '',
  time: `${id}m ago`,
  timeTitle: 'Tuesday',
  icon: '🚀',
  label: message('notifications:row.votedMerged.label'),
  segments: [{ t: 'strong', v: `Change ${id}` }],
  createdAtMs: Date.now() - id * MIN,
  who: '',
  appLine: 'Notes',
  appName: 'Notes',
  appId: 5,
  storyKey: null,
  storyRef: null,
  ...overrides,
});
const entry = (v) => ({ type: 'notif', key: `n:${v.id}`, at: v.createdAtMs, view: v });

function renderSheet({ list, touch = false }) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch, loadingMore: false, screenCanLoadMore: false, badgeTotal: list.length,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
    },
  });
  return renderToHtml(createElement(mod.NotificationsSheetView));
}

// ── 1. the fold ─────────────────────────────────────────────────────────

test('one request\'s notifications fold into one card where the newest stood', () => {
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const out = stacks.foldStories([
    entry(view(1, { ...story, kind: 'build_live', conversation: true, bot: true, label: 'Live' })),
    entry(view(2)),
    entry(view(3, { ...story, kind: 'issue_mention', label: 'Mentioned you' })),
    entry(view(4, { ...story, kind: 'build_ready', conversation: true, bot: true, label: 'Ready to try' })),
  ]);
  assert.deepEqual(out.map((e) => e.view.id), [1, 2], 'the story where its newest stood, and the row about nothing else');
  const card = out[0].view;
  assert.deepEqual(card.groupIds, [1, 3, 4], 'it opens and clears every notification it is, newest first');
  assert.equal(card.count, 3);
  assert.equal(card.groupLabelled, true, 'its meta line says the count, so no pill says it again');
  assert.deepEqual(card.story.members.map((m) => m.id), [1, 3, 4]);
  assert.equal(card.label, 'Live', 'drawn as its newest notification');
});

test('a person speaking, a row with buttons and a story of one stay as they were', () => {
  const key = { storyKey: 's:5:77' };
  const out = stacks.foldStories([
    entry(view(1, { ...key, kind: 'conversation_message', conversation: true })),
    entry(view(2, { ...key, kind: 'conversation_message', conversation: true })),
    entry(view(3, { ...key, kind: 'pr_recheck', actions: [{ key: 'still_yes', label: 'Still yes' }] })),
    entry(view(4, { ...key, kind: 'pr_recheck', actions: [{ key: 'still_yes', label: 'Still yes' }] })),
    entry(view(5, { storyKey: 'r:5:9' })),
  ]);
  assert.deepEqual(out.map((e) => e.view.id), [1, 2, 3, 4, 5]);
  assert.ok(out.every((e) => !e.view.story && !e.view.groupIds));
});

// ── 2. the sheet ────────────────────────────────────────────────────────

test('a project with several cards is a closed stack: its newest card on top, the rest under it', () => {
  const html = renderSheet({ list: [view(1), view(2, { kind: 'pr_proposed', label: 'New change' }), view(3, { kind: 'check_failed', label: 'Testing couldn\'t run' })] });
  assert.match(html, /<div class="notifications-stack" data-notif-stack="a:5" data-stack-closed="" data-stack-depth="2"><div class="flex items-center gap-2 px-4 pt-4 pb-1\.5" data-notif-app-group="a:5">/,
    'the heading stays the stack\'s first child, so the cards are its siblings');
  // The top card says how many are under it, and tapping it opens the stack.
  assert.match(html, /data-stack-top=""><button data-notif-id="1" class="notifications-row [^"]*" aria-expanded="false">/);
  // #5929: the count is the whole stack's, the top card's own included.
  assert.ok(html.includes(message('notifications:stack.showAll', { count: 3 })));
  assert.equal(message('notifications:stack.showAll', { count: 3 }), 'Show all 3 notifications');
  // The cards under it are the real cards, out of reach until it opens.
  assert.match(html, /data-stack-behind="1" inert="" aria-hidden="true"><button data-notif-id="2"/);
  assert.match(html, /data-stack-behind="2" inert="" aria-hidden="true"><button data-notif-id="3"/);
  // A closed stack has nothing to fold back.
  assert.doesNotMatch(html, /data-notif-stack-less/);
  // Each card is the shell's card; the time sits at its top right.
  assert.match(html, /class="notifications-row-slot group\/notif relative notifications-card grid grid-cols-1 rounded-\[20px\] bg-white dark:bg-zinc-900 /);
  assert.match(html, /<span class="flex-1 min-w-0 truncate">[^<]+<\/span><time title="Tuesday" class="shrink-0[^"]*">1m ago<\/time>/);
});

test('a closed stack whose top card is a story says one number: the whole stack\'s', () => {
  // #5929: "#24 · 9 notifications" over "4 more notifications" read as 9, 4
  // or 13. Closed, the top card names its request and the stack's total only.
  const story = { storyKey: 'r:5:24', storyRef: { number: 24, title: 'Plant shelf' } };
  const html = renderSheet({
    list: [
      view(1, { ...story, label: 'Live' }),
      view(2, { ...story, label: 'Ready to try' }),
      view(3, { ...story, label: 'Mentioned you' }),
      view(4, { kind: 'pr_proposed', label: 'New change' }),
    ],
  });
  assert.ok(html.includes(message('notifications:stack.showAll', { count: 4 })), 'three in the story and one under it');
  assert.doesNotMatch(html, /#24 · 3 notifications/, 'the story count waits until the stack opens');
  assert.match(html, /<span class="block text-xs text-zinc-500 truncate">#24<\/span>/);
  assert.doesNotMatch(html, /more notification/);
});

test('a project with one card has nothing to stack', () => {
  const html = renderSheet({ list: [view(1), view(2, { appId: 6, appName: 'Polls', appLine: 'Polls' })] });
  assert.match(html, /data-notif-stack="a:5"><div [^>]*data-notif-app-group="a:5">/);
  assert.doesNotMatch(html, /data-stack-closed|data-stack-top|data-stack-behind|aria-expanded="false"/);
  // Under its project's name the card does not say the name again.
  assert.doesNotMatch(html, /<span class="block text-xs text-zinc-500 truncate">Notes<\/span>/);
});

test('a story card says its request and how many notifications it is, and clears them all', () => {
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const html = renderSheet({
    list: [
      view(1, { ...story, kind: 'build_live', conversation: true, bot: true, botMoment: true, label: 'Live', segments: [{ t: 'strong', v: 'Plant shelf' }] }),
      view(2, { ...story, kind: 'build_ready', conversation: true, bot: true, botMoment: true, label: 'Ready to try', segments: [{ t: 'strong', v: 'Plant shelf' }] }),
      view(3, { appId: 6, appName: 'Polls', appLine: 'Polls' }),
    ],
  });
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="2"/);
  assert.ok(html.includes('#5580 · 2 notifications'));
  assert.equal(message('notifications:story.meta', { number: 5580, count: 2 }), '#5580 · 2 notifications');
  assert.match(html, /data-notification-clear="1" aria-label="Clear 2 notifications"/);
  assert.doesNotMatch(html, /data-notification-save="1"/, 'a save is one notification\'s');
  // Alone in its project it is not stacked, so it has its history to open.
  assert.match(html, /<button type="button" data-notif-history="1" aria-expanded="false" aria-label="Show what happened" class="[^"]*un-touch-target"/);
  assert.doesNotMatch(html, /data-notif-history="3"/, 'a card about no request or proposal has none');
  assert.doesNotMatch(html, /data-notif-history-list/, 'closed until asked for');
});

test('a story card opens its history on the first tap or click, on a phone and a computer alike', () => {
  // Evan, 20 Oct 2026: on a computer only the chevron opened it, and a click
  // went straight to the newest; a phone and a computer now do the same.
  const story = { storyKey: 'r:5:5580', storyRef: { number: 5580, title: 'Plant shelf' } };
  const list = [view(1, { ...story, label: 'Live' }), view(2, { ...story, label: 'Ready to try' })];
  for (const touch of [false, true]) {
    const html = renderSheet({ touch, list });
    assert.match(html, /<button data-notif-id="1" data-notif-group-size="2" class="[^"]*" aria-expanded="false"/,
      `the card itself says it opens (${touch ? 'phone' : 'computer'})`);
  }
  const sheet = read(SHEET_PATH);
  assert.match(sheet, /const expands = !!story && hasHistory;/, 'a story card only: one notification still opens on the first click');
  assert.match(sheet, /if \(closedTop\) \{ closedTop\.open\(\); return; \}\s+if \(expands && !historyOpen\) \{ setHistoryOpen\(true\); return; \}\s+if \(groupIds\) controller\(\)\?\.openGroupRow\(view\.id, groupIds\);/,
    'the first opens the history; with it open, the card opens the newest');
  // Not a story: a single card with a history, and a fold by kind, open as before.
  const single = renderSheet({ list: [view(1, { storyKey: 's:5:1', storyRef: { number: 41, title: 'x' } })] });
  assert.match(single, /<button type="button" data-notif-history="1"/);
  assert.doesNotMatch(single, /<button data-notif-id="1"[^>]*aria-expanded/);
});

test('a fold by kind is several things, not one story: no history', () => {
  const html = renderSheet({ list: [view(1, { storyKey: 's:5:1' }), view(2, { storyKey: 's:5:2' })] });
  assert.match(html, /<button data-notif-id="1" data-notif-group-size="2"/);
  assert.doesNotMatch(html, /data-notif-history=/);
});

test('on a phone a card\'s Save is in its swipe, and pressing and holding opens its history', () => {
  const html = renderSheet({ touch: true, list: [view(1, { storyKey: 's:5:1', storyRef: { number: 41, title: 'x' } })] });
  assert.doesNotMatch(html, /data-notification-save=/, 'no hover on a phone: the swipe has Save');
  assert.doesNotMatch(html, /data-notification-clear=/);
  assert.match(html, /<div data-notif-swipe="true" class="[^"]*"><button data-notif-id="1"[\s\S]*?<\/button><button type="button" data-notif-history="1"/,
    'the chevron rides on the card the swipe moves');
  const sheet = read(SHEET_PATH);
  assert.match(sheet, /timer: setTimeout\(\(\) => \{\s*press\.current = null;\s*heldAt\.current = Date\.now\(\);\s*setHistoryOpen\(\(was\) => !was\);\s*\}, 450\)/);
  assert.match(sheet, /if \(Date\.now\(\) - heldAt\.current < 700\) return;/, 'the lift after a hold is not a tap');
});

test('the closed stack\'s cards sit under its top card in CSS, and the motion respects reduced motion', () => {
  assert.match(APP_CSS, /\.notifications-stack\[data-stack-closed\] > \[data-stack-behind\] \{[^}]*position: absolute;[^}]*top: calc\(var\(--stack-top, 0px\) \+ 8px\);[^}]*height: var\(--stack-h, 0px\);[^}]*pointer-events: none;/);
  assert.match(APP_CSS, /\.notifications-stack \.notifications-row-slot \.notifications-row::after \{ content: none; \}/,
    'cards are surfaces of their own: no hairline between them');
  assert.match(APP_CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.notifications-stack > \.notifications-row-slot,/);
  assert.match(STACKS_SRC, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
});

// ── 3. the history's lines ──────────────────────────────────────────────

test('a history in words: newest first, the story\'s other notifications in place, the card\'s own moment left out', () => {
  const t = englishPlatformI18n().t;
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * MIN).toISOString();
  const lead = view(1, { kind: 'build_live', createdAtMs: now - 1 * MIN, label: 'Live' });
  const ready = view(2, { kind: 'build_ready', createdAtMs: now - 25 * MIN, label: 'Ready to try', unread: false, segments: [{ t: 'strong', v: 'Plant shelf' }] });
  const card = { ...lead, story: { members: [lead, ready] } };
  const lines = stacks.historyLines(card, [
    { at: iso(1.5), kind: 'live' },
    { at: iso(10), kind: 'vote', actor: 'cy', vote: 'yes' },
    { at: iso(12), kind: 'vote', actor: 'ben', vote: 'yes' },
    { at: iso(14), kind: 'vote', actor: 'me', vote: 'yes' },
    { at: iso(26), kind: 'updated' },
    { at: iso(40), kind: 'comment', actor: 'ben', words: 'Works on my phone.' },
    { at: iso(70), kind: 'proposed', actor: 'homeroom_bot' },
    { at: iso(120), kind: 'asked', actor: 'me' },
  ], t, 'me');
  assert.deepEqual(lines.map((l) => l.what), [
    '2 yes votes', 'You voted yes', 'Ready to try', 'Updated', '@ben commented', 'Homeroom bot put it up for a vote', 'You asked for it',
  ], 'its going live is the card itself');
  assert.equal(lines[0].words, '@ben, @cy', 'the voters in the order they voted');
  assert.deepEqual(lines[2].notification, { id: 2, unread: false, saved: false }, 'one of the story\'s notifications opens on its own');
  assert.equal(lines[2].words, 'Plant shelf');
  assert.equal(lines[4].words, 'Works on my phone.');
});

test('#5775: a history line carries its notification\'s saved state', () => {
  const t = englishPlatformI18n().t;
  const now = Date.now();
  const lead = view(1, { kind: 'build_live', createdAtMs: now - MIN, label: 'Live' });
  const kept = view(2, { kind: 'build_ready', createdAtMs: now - 25 * MIN, unread: false, saved: true });
  const card = { ...lead, story: { members: [lead, kept] } };
  const lines = stacks.historyLines(card, [], t, null);
  assert.deepEqual(lines.map((line) => line.notification), [{ id: 2, unread: false, saved: true }]);
});

// ── 4. the data ─────────────────────────────────────────────────────────

let controller = null;
function loadController() {
  if (controller) return controller;
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  controller = globalThis.window.Notifications;
  return controller;
}

test('rowView carries the story a row is about', () => {
  const N = loadController();
  const now = new Date().toISOString();
  const [bot, mention, plain, dm] = N._screenViews([
    {
      id: 1, kind: 'build_live', appId: 3, appName: 'Notes', conversationId: 9, sourceUsername: 'homeroom_bot',
      detail: 'hrbot2:{"m":"live","a":"Notes","t":"Plant shelf","i":5580}', storyIssueNumber: 5580, readAt: null, createdAt: now,
    },
    {
      id: 2, kind: 'mention', appId: 3, appName: 'Notes', sourceUsername: 'ben', messageContent: '@me look',
      storySessionId: 41, storyIssueNumber: null, storyPrNumber: 5590, storyTitle: 'Plant shelf, home', readAt: null, createdAt: now,
    },
    { id: 3, kind: 'platform_limit', appId: null, detail: 'apps_warn:40:50', readAt: null, createdAt: now },
    { id: 4, kind: 'conversation_message', appId: null, conversationId: 8, sourceUsername: 'ben', messageContent: 'hi', readAt: null, createdAt: now },
  ]);
  assert.equal(bot.storyKey, 'r:3:5580');
  assert.deepEqual(bot.storyRef, { number: 5580, title: 'Plant shelf' });
  assert.equal(bot.appName, 'Notes');
  assert.equal(bot.plainMessage, false, 'the bot\'s news about a project is the bell\'s');
  assert.equal(mention.storyKey, 's:3:41', 'a proposal\'s story when no request is known');
  assert.deepEqual(mention.storyRef, { number: 5590, title: 'Plant shelf, home' });
  assert.equal(plain.storyKey, null);
  assert.equal(dm.plainMessage, true, 'a person\'s message stays the Messages tab\'s');
});

test('the controller reads a card\'s history from the route, and a failed read is null', async () => {
  const N = loadController();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.location = globalThis.location || { search: '' };
  try {
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ steps: [{ kind: 'live', at: 'x' }] }) }; };
    assert.deepEqual(await N.loadHistory(990214), { steps: [{ kind: 'live', at: 'x' }] });
    assert.match(calls[0], /^\/api\/notifications\/990214\/history/);
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    assert.equal(await N.loadHistory(5), null);
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.equal(await N.loadHistory(5), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the catalog holds the new entries, each with a description', () => {
  const catalog = JSON.parse(read('frontend/locales/en/notifications.json'));
  const used = new Set([...read(SHEET_PATH).matchAll(/'notifications:((?:stack|story|history|row\.swipe)[\w.]*)'/g),
    ...STACKS_SRC.matchAll(/'notifications:((?:stack|story|history)[\w.]*)'/g)].map((m) => m[1]));
  assert.ok(used.size > 20, 'the new copy is requested by whole literals');
  for (const id of used) {
    const entryOf = catalog[id] || catalog[`${id}_other`];
    assert.ok(entryOf, `${id} is in the catalog`);
    assert.ok(entryOf.description, `${id} has a description`);
  }
});

// 21 Oct 2026, on an iPhone: opening a card's history grew it for
// "Loading…", snapped back up when the history landed, grew again, then
// jumped down to its real height; folding it stopped 8px short and jumped.
// Then, in the app's web view, the `height` animation that fixed that stopped
// advancing for up to 6 s while the page was free: WebKit runs a height
// animation on the main thread. The history now moves by transforms alone
// (moveHistory), which run in Core Animation. Run here over a fake column
// layout: every box is as tall as its children, stacked top to bottom.

function historyScene({ desk = false, scroll = null } = {}) {
  const anims = [];
  const frames = [];
  const timers = [];
  const transforms = new Map();
  let boxH = 100;
  class Box {
    constructor(name, { h = 0, css = {}, cls = '' } = {}) {
      const style = new Proxy({}, { get: (t, k) => (k in t ? t[k] : '') });
      Object.assign(this, { name, h, css, cls, kids: [], parent: null, style, attrs: {} });
    }
    add(...kids) { for (const k of kids) { k.parent = this; this.kids.push(k); } return this; }
    get parentElement() { return this.parent; }
    get children() { return this.kids; }
    get firstChild() { return this.kids[0] || null; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n.name === 'body'; }
    sib(d) { const s = this.parent && this.parent.kids; return s ? s[s.indexOf(this) + d] || null : null; }
    get nextElementSibling() { return this.sib(1); }
    get previousElementSibling() { return this.sib(-1); }
    insertBefore(child, ref) { child.parent = this; this.kids.splice(ref ? this.kids.indexOf(ref) : this.kids.length, 0, child); return child; }
    remove() { if (this.parent) this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    closest(sel) { let n = this; while (n && !(sel === '.notifications-row-slot' && n.cls === 'slot')) n = n.parent; return n || null; }
    get height() {
      if (this.style.display === 'none') return 0;
      if (this.name === 'box') return boxH;
      const flow = this.kids.filter((k) => k.style.position !== 'absolute');
      return flow.length ? flow.reduce((sum, k) => sum + k.height, 0) : this.h;
    }
    get top() {
      if (!this.parent) return 0;
      let top = this.parent.top;
      if (this.style.position === 'absolute') return top;
      for (const k of this.parent.kids) { if (k === this) break; if (k.style.position !== 'absolute') top += k.height; }
      return top;
    }
    getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height }; }
    animate(keyframes, timing) {
      let resolve;
      const run = {
        el: this, keyframes, timing, state: 'running',
        finished: new Promise((r) => { resolve = r; }),
        get playState() { return this.state; },
        pause() { this.state = 'paused'; },
        play() { this.state = 'running'; },
        cancel() { this.state = 'idle'; },
        finish() { this.state = 'finished'; resolve(this); },
      };
      run.finished.catch(() => {});
      anims.push(run);
      return run;
    }
  }
  const box = new Box('box');
  const row = new Box('row', { h: 60 });
  const surface = desk ? { backgroundColor: 'rgb(255, 255, 255)', boxShadow: 'rgba(0, 0, 0, 0.05) 0px 1px 2px 0px' } : {};
  const card = new Box('card', { cls: 'slot', css: surface });
  if (desk) card.add(row, box); else card.add(new Box('wrap').add(new Box('host').add(row, box)));
  const stack = new Box('stack').add(new Box('head', { h: 30 }), card, new Box('next', { h: 60 }));
  const scroller = new Box('scroller', { css: { overflowY: 'auto' } });
  scroller.add(new Box('above', { h: 200 }), stack, new Box('below', { h: 200 }));
  Object.assign(scroller, { scrollTop: 0, scrollHeight: 1000, clientHeight: 800, ...(scroll || {}) });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 });
  const body = new Box('body').add(scroller);
  const env = {
    window: {
      innerHeight: 800,
      getComputedStyle: (el) => ({
        overflowY: el.css.overflowY || 'visible',
        backgroundColor: el.style.background || el.css.backgroundColor || 'rgba(0, 0, 0, 0)',
        boxShadow: el.style.boxShadow || el.css.boxShadow || 'none',
        transform: transforms.has(el.name) ? `matrix(1, 0, 0, 1, 0, ${transforms.get(el.name)})` : 'none',
        opacity: '1',
      }),
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    },
    document: { body, documentElement: body, scrollingElement: body, createElement: (tag) => new Box(tag) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = globalThis[k]; globalThis[k] = env[k]; }
  const by = (name) => { const walk = (b) => (b.name === name ? b : b.kids.map(walk).find(Boolean)); return walk(body); };
  return {
    box, card, anims, frames, timers, transforms, by,
    setHistory(h) { boxH = h; },
    restore() { for (const k of Object.keys(saved)) globalThis[k] = saved[k]; },
    live: () => anims.filter((a) => a.state !== 'idle'),
    frames2() { for (let i = 0; i < 2; i++) for (const fn of frames.splice(0)) fn(16); },
    kf: (name) => JSON.parse(JSON.stringify([...anims].reverse().find((a) => a.el.name === name && a.state !== 'idle').keyframes)),
  };
}
const ty = (a, b) => [{ transform: `translateY(${a}px)` }, { transform: `translateY(${b}px)` }];

test('a history grows by transforms: the card is the window, what is in it stands still, what follows moves with its edge', () => {
  const s = historyScene();
  try {
    const motion = { current: null };
    stacks.moveHistory(s.box, motion, true, 360);
    // Laid out at its new size in one step; played back from where it was.
    assert.deepEqual(s.kf('card'), ty(-100, 0), 'the card\'s edge starts where it was');
    assert.deepEqual(s.kf('wrap'), ty(100, 0), 'the card\'s contents stand still');
    assert.deepEqual(s.kf('next'), ty(-100, 0), 'the next card follows the edge');
    assert.deepEqual(s.kf('below'), ty(-100, 0), 'so does everything under the stack');
    assert.deepEqual(s.kf('box'), [{ opacity: 0 }, { opacity: 1 }]);
    assert.equal(s.card.style.overflow, 'hidden', 'the card clips what is in it, at its own corners');
    for (const run of s.anims) {
      assert.ok(Object.keys(run.keyframes[0]).every((k) => k === 'transform' || k === 'opacity'), `${run.el.name}: transform and opacity only`);
      assert.equal(run.timing.delay, undefined, 'no delay: WebKit keeps a delayed animation on the main thread');
    }
    // Held on its first frame until the frame after next.
    assert.ok(s.live().every((run) => run.state === 'paused'));
    s.frames2();
    assert.ok(s.live().every((run) => run.state === 'running'));

    // The history lands 40px into the grow, 60px taller than "Loading…": it
    // goes on from where everything is, never back to an earlier height.
    s.transforms.set('card', -40).set('wrap', 40).set('next', -40).set('below', -40);
    s.setHistory(160);
    stacks.moveHistory(s.box, motion, true, 280);
    assert.deepEqual(s.kf('card'), ty(-100, 0));
    assert.deepEqual(s.kf('wrap'), ty(100, 0));
    assert.deepEqual(s.kf('next'), ty(-100, 0));
    assert.equal(s.live().filter((run) => run.timing.duration === 360).length, 0, 'the first grow let go');
    s.transforms.clear();
    // It ends at exactly its layout: nothing is held, and the card is itself again.
    s.frames2();
    for (const run of s.live()) run.finish();
    [...s.timers].reverse().find((t) => t.ms > 280).fn();
    assert.equal(s.card.style.overflow, '');
    assert.equal(s.card.style.isolation, '');
    assert.ok(motion.current && motion.current.runs.size === 0, 'the card remembers the height it laid out');
  } finally {
    s.restore();
  }
});

test('a history folds by transforms and leaves the layout in the same step its transforms let go', () => {
  const s = historyScene();
  try {
    s.setHistory(160);
    const motion = { current: null };
    let folded = 0;
    stacks.moveHistory(s.box, motion, false, 300, () => { folded++; });
    assert.deepEqual(s.kf('card'), ty(0, -160));
    assert.deepEqual(s.kf('wrap'), ty(0, 160));
    assert.deepEqual(s.kf('next'), ty(0, -160));
    assert.deepEqual(s.kf('box'), [{ opacity: 1 }, { opacity: 0 }]);
    assert.ok(s.anims.every((run) => run.timing.fill === 'forwards'), 'a fold holds its end until the layout catches up');
    assert.equal(s.box.style.display, '');
    // A stalled main thread never reports the end; the timer does.
    s.timers.find((t) => t.ms === 80).fn();
    s.timers.find((t) => t.ms > 300).fn();
    assert.equal(s.box.style.display, 'none', 'the box leaves the layout');
    assert.ok(s.anims.every((run) => run.state === 'idle'), 'in the same step the held transforms let go');
    assert.equal(folded, 1);
    assert.equal(motion.current, null);
  } finally {
    s.restore();
  }
});

test('a fold that leaves the list shorter than its scroller moves what is above down with it', () => {
  // 1000 tall in an 800 view, scrolled to 100. Without the 160px history the
  // list is 840 tall, so the scroller will pull back to 40: everything above
  // the card's edge comes down 60 on the way, rather than at the end.
  const s = historyScene({ scroll: { scrollTop: 100, scrollHeight: 1000, clientHeight: 800 } });
  try {
    s.setHistory(160);
    stacks.moveHistory(s.box, { current: null }, false, 300, () => {});
    assert.deepEqual(s.kf('head'), ty(0, 60));
    assert.deepEqual(s.kf('above'), ty(0, 60));
    assert.deepEqual(s.kf('card'), ty(0, -100), 'its edge ends where the pulled-back layout has it');
    assert.deepEqual(s.kf('wrap'), ty(0, 160), 'its words come down with what is above');
    assert.deepEqual(s.kf('next'), ty(0, -100));
  } finally {
    s.restore();
  }
});

test('on a desk the card lends its surface to a layer under its contents while it moves', () => {
  const s = historyScene({ desk: true });
  try {
    stacks.moveHistory(s.box, { current: null }, true, 360);
    const surface = s.card.kids[0];
    assert.equal(surface.name, 'span');
    assert.equal(surface.style.background, 'rgb(255, 255, 255)');
    assert.equal(surface.style.zIndex, '-1');
    assert.equal(s.card.style.background, 'transparent', 'the card itself moves; its surface stands still with its contents');
    assert.equal(s.card.style.isolation, 'isolate');
    assert.deepEqual(s.kf('span'), ty(100, 0));
    assert.deepEqual(s.kf('row'), ty(100, 0));
    s.frames2();
    for (const run of s.live()) run.finish();
    [...s.timers].reverse().find((t) => t.ms > 360).fn();
    assert.equal(s.card.kids[0].name, 'row', 'the layer goes when the motion ends');
    assert.equal(s.card.style.background, '');
    assert.equal(s.card.style.boxShadow, '');
  } finally {
    s.restore();
  }
});

test('CardHistory opens, lands and folds through moveHistory, and a card that goes leaves nothing moved', () => {
  assert.doesNotMatch(STACKS_SRC, /\{ height: `/, 'no height keyframes are left to stall');
  assert.match(STACKS_SRC, /moveHistory\(box, motion, true, 360\);/);
  assert.match(STACKS_SRC, /moveHistory\(box, motion, false, 300, \(\) => setShown\(false\)\);/);
  assert.match(STACKS_SRC, /if \(open\) moveHistory\(box, motion, true, 280\);\s*else if \(motion\.current\) moveHistory\(box, motion, false, 300, \(\) => setShown\(false\)\);/,
    'the history landing goes on from where the grow (or a fold) has it');
  assert.match(STACKS_SRC, /useEffect\(\(\) => \(\) => \{\s*if \(motion\.current\) stopMotion\(motion\.current, true\);/);
  assert.doesNotMatch(STACKS_SRC, /lastHeight/, 'no height remembered from an earlier render');
  // Read where everything is before the running motion lets go.
  const move = STACKS_SRC.slice(STACKS_SRC.indexOf('export function moveHistory('), STACKS_SRC.indexOf('function controller()'));
  assert.ok(move.indexOf('offsetY(el)') < move.indexOf('stopMotion(prev'), 'read, then cancel');
  assert.match(STACKS_SRC, /<div ref=\{boxRef\} data-notif-history-list=\{view\.id\} className="col-start-1 row-start-2">\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="pl-\[4\.75rem\] pr-4 pb-2">/);
});
