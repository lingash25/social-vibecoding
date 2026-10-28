'use strict';

// #4289 and its follow-up: the C key comments on the page (a pin where the
// pointer is, ../frontend/src/features/comment-pin/, tested in
// tests/comment-pin.test.js), on a computer, with nothing selected.
// On by default, kept on the device.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE SETTING. On unless this device stored an off, and stored where the
//      shortcut reads it.
//   2. ONLY A C NOBODY ELSE USED. Typing, a selection, a modifier, a dialog
//      on screen, or a screen that claimed the key (preventDefault) leaves it
//      alone, and the claim is read AFTER every listener has had the key.
//   3. FROM INSIDE AN APP. The bridge forwards an unused C without touching
//      the app's own handling, with where its pointer was, and the shell
//      takes the message only from its running app's frame while that frame
//      holds focus, placing the point by the frame's rectangle.
//   4. ONE RULE, TWO COPIES. The shell and the bridge cannot share code, so
//      the same table of keys runs through both.
//   5. THE SEAMS. The Workshop claims its C, Settings paints and saves the
//      switch, and the bundle installs the listeners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const shortcut = loadTsx('frontend/src/features/improve/suggest-shortcut.ts');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BLOCK = BRIDGE.split('/* __USERNODE_SHORTCUTS_BEGIN__ */')[1]
  .split('/* __USERNODE_SHORTCUTS_END__ */')[0];

// ── Fakes ─────────────────────────────────────────────────────────────

const body = { tagName: 'BODY', closest: () => null };
const input = { tagName: 'INPUT', closest: () => null };
const textarea = { tagName: 'TEXTAREA', closest: () => null };
const select = { tagName: 'SELECT', closest: () => null };
const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null };
const inTextbox = { tagName: 'SPAN', closest: (sel) => (sel.includes('textbox') ? {} : null) };
const shadowHost = { tagName: 'MY-WIDGET', closest: () => null };

function memoryStorage(on) {
  const map = new Map([[shortcut.SUGGEST_SHORTCUT_STORAGE_KEY, on ? '1' : '0']]);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// A key event as both documents see it. `path` is composedPath()'s answer;
// `later` runs as a listener registered after the one under test would.
function keyEvent(init = {}) {
  const e = {
    key: 'c', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false,
    target: body, defaultPrevented: false, ...init,
  };
  const path = init.path || [e.target];
  e.composedPath = () => path;
  e.preventDefault = () => { throw new Error('the shortcut must never claim a key'); };
  e.stopPropagation = () => { throw new Error('the shortcut must never stop a key'); };
  return e;
}

function shellHarness({
  enabled = true, fine = true, signedIn = true, panel = false, dialogs = [], active = body,
  staging = false,
} = {}) {
  const listeners = {};
  const timers = [];
  const frameWin = { name: 'app frame' };
  const frame = {
    contentWindow: frameWin,
    getBoundingClientRect: () => ({ left: 200, top: 56, width: 800, height: 600 }),
  };
  const stagingFrameWin = { name: 'staging frame' };
  const stagingFrame = {
    contentWindow: stagingFrameWin,
    getBoundingClientRect: () => ({ left: 40, top: 20, width: 900, height: 700 }),
  };
  let selection = '';
  let opened = 0;
  const points = [];
  const doc = {
    activeElement: active === 'frame' ? frame : active === 'staging' ? stagingFrame : active,
    documentElement: { classList: { contains: (c) => panel && c === 'in-side-panel' } },
    getElementById: (id) => (id === 'app-iframe' ? frame : id === 'staging-iframe' ? (staging ? stagingFrame : null) : null),
    querySelectorAll: () => dialogs,
  };
  const win = {
    addEventListener(type, fn) { listeners[type] = fn; },
    setTimeout(fn) { timers.push(fn); },
    matchMedia: (q) => ({ matches: q === '(any-pointer: fine)' ? fine : false }),
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
  };
  const storage = memoryStorage(enabled);
  shortcut.installSuggestShortcut({
    win, doc, storage, open: (p) => { opened += 1; points.push(p); }, signedIn: () => signedIn,
  });
  return {
    doc, frame, frameWin, stagingFrame, stagingFrameWin, storage, points,
    select(text) { selection = text; },
    move(x, y) { listeners.pointermove({ clientX: x, clientY: y }); },
    // Press, let any later listener act on the event, then run the task.
    press(init, later) {
      const e = keyEvent(init);
      listeners.keydown(e);
      if (later) later(e);
      const queued = timers.length;
      while (timers.length) timers.shift()();
      return { queued, opened };
    },
    message(data, source = frameWin) {
      listeners.message({ data, source });
      return opened;
    },
    get opened() { return opened; },
  };
}

function bridgeHarness({ top = false, platformShell = false, active = body, pointerLock = null } = {}) {
  const posted = [];
  const timers = [];
  let keydown = null;
  let pointermove = null;
  let selection = '';
  const window = {
    addEventListener(type, fn) {
      if (type === 'keydown') keydown = fn;
      if (type === 'pointermove') pointermove = fn;
    },
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
  };
  window.parent = top ? window : { postMessage(message, origin) { posted.push({ message, origin }); } };
  if (platformShell) window.__usernodePlatformShell = true;
  const document = { activeElement: active, pointerLockElement: pointerLock };
  vm.runInNewContext(BLOCK, { window, document, setTimeout(fn) { timers.push(fn); }, String });
  return {
    installed: () => !!keydown,
    select(text) { selection = text; },
    move(x, y) { pointermove({ clientX: x, clientY: y }); },
    press(init, later) {
      const e = keyEvent(init);
      keydown(e);
      if (later) later(e);
      while (timers.length) timers.shift()();
      return posted.length;
    },
    posted,
  };
}

// ── 1. The switch ─────────────────────────────────────────────────────

test('the setting is on by default, off only where a device stored that, and the switch is what it reads', () => {
  assert.equal(shortcut.suggestShortcutEnabled(modeStorage()), true, 'on by default');
  assert.equal(shortcut.suggestShortcutEnabled(modeStorage({ [shortcut.SUGGEST_SHORTCUT_STORAGE_KEY]: '1' })), true);
  const storage = memoryStorage(false);
  assert.equal(shortcut.suggestShortcutEnabled(storage), false, 'a stored off is honoured');
  shortcut.setSuggestShortcutEnabled(true, storage);
  assert.equal(shortcut.suggestShortcutEnabled(storage), true);
  assert.equal(storage.getItem(shortcut.SUGGEST_SHORTCUT_STORAGE_KEY), '1');
  shortcut.setSuggestShortcutEnabled(false, storage);
  assert.equal(shortcut.suggestShortcutEnabled(storage), false);
  assert.equal(storage.getItem(shortcut.SUGGEST_SHORTCUT_STORAGE_KEY), '0', 'off is stored, not removed');
  assert.equal(shortcut.suggestShortcutEnabled(null), true, 'no storage reads as on');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.equal(shortcut.suggestShortcutEnabled(broken), true, 'unreadable storage reads as on');
  assert.doesNotThrow(() => shortcut.setSuggestShortcutEnabled(true, broken));

  const h = shellHarness();
  assert.equal(h.press().opened, 1, 'a fresh device opens with a C');
  shortcut.setSuggestShortcutEnabled(false, h.storage);
  assert.equal(h.press().opened, 1, 'and a stored off stops it, with no reload');
  shortcut.setSuggestShortcutEnabled(true, h.storage);
  assert.equal(h.press().opened, 2, 'and on again opens again');
});

// ── 2. Only a C nobody else used ──────────────────────────────────────

test('a bare C opens Suggest an improvement, a task after the key', () => {
  const h = shellHarness();
  const { queued, opened } = h.press();
  assert.equal(queued, 1, 'decided in a later task, after every listener has had the key');
  assert.equal(opened, 1);
  assert.equal(h.press({ key: 'C' }).opened, 2, 'Shift or Caps Lock still counts');
});

test('not with a modifier, held down, mid-composition, or another key', () => {
  const h = shellHarness();
  for (const init of [
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { key: 'v' }, { key: 'Enter' },
  ]) {
    assert.equal(h.press(init).opened, 0, JSON.stringify(init));
  }
});

test('not while typing, including inside a shadow root, or with text selected', () => {
  for (const target of [input, textarea, select, editable, inTextbox]) {
    assert.equal(shellHarness().press({ target }).opened, 0, target.tagName);
  }
  assert.equal(shellHarness().press({ target: shadowHost, path: [input, shadowHost, body] }).opened, 0,
    'the real target, not the retargeted host');
  assert.equal(shellHarness({ active: textarea }).press().opened, 0, 'focus in a field');
  const h = shellHarness();
  h.select('some words');
  assert.equal(h.press().opened, 0, 'a selection');
  h.select('');
  assert.equal(h.press().opened, 1, 'a caret is not a selection');
});

test('a screen that claimed the key keeps it, however late its listener ran', () => {
  const h = shellHarness();
  assert.equal(h.press({}, (e) => { e.defaultPrevented = true; }).opened, 0);
});

test('not over a dialog, a sheet or a menu, nor on a phone, signed out, or in the side panel', () => {
  const shown = { closest: () => null, checkVisibility: () => true, getClientRects: () => ({ length: 1 }) };
  const shipped = { closest: () => null, getClientRects: () => ({ length: 0 }) };
  // The header's sheets while closed: laid out, but inert, invisible and
  // see-through, so they can animate in. Found by driving the real shell.
  const parked = { closest: (sel) => (sel.includes('[inert]') ? {} : null), getClientRects: () => ({ length: 1 }) };
  const faded = { closest: () => null, checkVisibility: () => false, getClientRects: () => ({ length: 1 }) };
  const older = { closest: () => null, getClientRects: () => ({ length: 1 }) };
  assert.equal(shellHarness({ dialogs: [shown] }).press().opened, 0, 'a dialog on screen');
  assert.equal(shellHarness({ dialogs: [shipped] }).press().opened, 1, 'a hidden one does not count');
  assert.equal(shellHarness({ dialogs: [parked] }).press().opened, 1, 'nor an inert one');
  assert.equal(shellHarness({ dialogs: [faded] }).press().opened, 1, 'nor one the browser says is invisible');
  assert.equal(shellHarness({ dialogs: [older] }).press().opened, 0, 'without checkVisibility, laid out counts');
  assert.equal(shellHarness({ fine: false }).press().opened, 0, 'touch only');
  assert.equal(shellHarness({ signedIn: false }).press().opened, 0, 'a visitor');
  assert.equal(shellHarness({ panel: true }).press().opened, 0, 'the side panel stands down');
});

// ── 3. From inside an app ─────────────────────────────────────────────

test('the shell takes the bridge\'s C only from its app frame, while that frame has focus', () => {
  const msg = { [shortcut.SHORTCUT_MESSAGE_KEY]: 'suggest' };
  assert.equal(shellHarness({ active: 'frame' }).message(msg), 1);
  assert.equal(shellHarness({ active: 'frame' }).message(msg, { name: 'another frame' }), 0, 'another frame');
  assert.equal(shellHarness({ active: body }).message(msg), 0, 'a frame without focus had no key pressed in it');
  assert.equal(shellHarness({ active: 'frame', enabled: false }).message(msg), 0, 'the switch');
  assert.equal(shellHarness({ active: 'frame', fine: false }).message(msg), 0, 'touch only');
  assert.equal(shellHarness({ active: 'frame' }).message({ [shortcut.SHORTCUT_MESSAGE_KEY]: 'other' }), 0);
  assert.equal(shellHarness({ active: 'frame' }).message(null), 0);
  assert.equal(shellHarness({ active: 'frame' }).message('suggest'), 0);
});

test('the shell takes the bridge\'s C from the staging preview\'s frame too, only while it has focus', () => {
  const msg = { [shortcut.SHORTCUT_MESSAGE_KEY]: 'suggest' };
  const h = shellHarness({ active: 'staging', staging: true });
  assert.equal(h.message({ [shortcut.SHORTCUT_MESSAGE_KEY]: 'suggest', x: 100, y: 50 }, h.stagingFrameWin), 1, 'a C in the preview opens the comment');
  assert.deepEqual(h.points[0], { x: 140, y: 70 }, 'placed by the staging frame\'s rectangle');
  const afterStaging = h.opened;
  h.message(msg);
  assert.equal(h.opened, afterStaging, 'the app frame\'s message while the preview has focus: no');
  assert.equal(shellHarness({ active: 'frame', staging: true }).message(msg, h.stagingFrameWin), 0, 'the preview\'s message while the app frame has focus: no');
  assert.equal(shellHarness({ active: body, staging: true }).message(msg, h.stagingFrameWin), 0, 'no focus in the preview: no');
  assert.equal(shellHarness({ active: 'staging', staging: true, enabled: false }).message(msg, h.stagingFrameWin), 0, 'the switch');
  assert.equal(shellHarness({ active: 'staging', staging: true, signedIn: false }).message(msg, h.stagingFrameWin), 0, 'signed out');
  // No staging frame on screen (the harness answers none): its message finds no frame.
  assert.equal(shellHarness({ active: body }).message(msg, h.stagingFrameWin), 0, 'no staging frame, no open');
});

test('the bridge forwards an unused C to the shell and never touches the app\'s keys', () => {
  const b = bridgeHarness();
  assert.equal(b.press(), 1, 'keyEvent throws if preventDefault or stopPropagation is called');
  // Spread into this realm: the vm's objects have their own prototype.
  assert.deepEqual({ ...b.posted[0].message }, { __usernode_shortcut: 'suggest' });
  assert.equal(b.press({}, (e) => { e.defaultPrevented = true; }), 1, 'an app that claimed C keeps it');
  assert.equal(bridgeHarness({ pointerLock: {} }).press(), 0, 'a game holding the pointer');
});

test('the comment is pinned where the pointer was, over the shell or inside the app', () => {
  const h = shellHarness();
  h.press();
  assert.equal(h.points[0], null, 'nobody has pointed yet: the comment picks the middle');
  h.move(300, 200);
  h.press();
  assert.deepEqual(h.points[1], { x: 300, y: 200 });

  const msg = (extra) => ({ [shortcut.SHORTCUT_MESSAGE_KEY]: 'suggest', ...extra });
  const a = shellHarness({ active: 'frame' });
  a.message(msg({ x: 40, y: 30 }));
  assert.deepEqual(a.points[0], { x: 240, y: 86 }, 'the app\'s point, placed by the frame\'s rectangle');
  a.message(msg({}));
  assert.deepEqual(a.points[1], { x: 600, y: 356 }, 'no point from the app: the frame\'s middle');
  a.message(msg({ x: 5000, y: -20 }));
  assert.deepEqual(a.points[2], { x: 999, y: 56 }, 'kept inside the frame');
  a.message(msg({ x: 'a', y: null }));
  assert.deepEqual(a.points[3], { x: 600, y: 356 }, 'a point that is not one is ignored');

  const b = bridgeHarness();
  b.press();
  assert.deepEqual({ ...b.posted[0].message }, { __usernode_shortcut: 'suggest' }, 'no pointer yet: no point');
  b.move(40, 30);
  b.press();
  assert.deepEqual({ ...b.posted[1].message }, { __usernode_shortcut: 'suggest', x: 40, y: 30 });
});

test('the bridge installs nothing in a top frame and sends nothing from the platform\'s own document', () => {
  assert.equal(bridgeHarness({ top: true }).installed(), false);
  assert.equal(bridgeHarness({ platformShell: true }).press(), 0);
});

// ── 4. One rule, two copies ───────────────────────────────────────────

test('the shell and the bridge answer the same keys the same way', () => {
  const cases = [
    [{}, true],
    [{ key: 'C' }, true],
    [{ key: 'x' }, false],
    [{ ctrlKey: true }, false],
    [{ metaKey: true }, false],
    [{ altKey: true }, false],
    [{ repeat: true }, false],
    [{ isComposing: true }, false],
    [{ target: input }, false],
    [{ target: textarea }, false],
    [{ target: select }, false],
    [{ target: editable }, false],
    [{ target: inTextbox }, false],
    [{ target: shadowHost, path: [input, shadowHost, body] }, false],
    [{ target: shadowHost, path: [shadowHost, body] }, true],
  ];
  for (const [init, expected] of cases) {
    const label = JSON.stringify(init, (k, v) => (v && v.tagName ? v.tagName : v));
    assert.equal(shellHarness().press(init).opened === 1, expected, `shell: ${label}`);
    assert.equal(bridgeHarness().press(init) === 1, expected, `bridge: ${label}`);
  }
  for (const make of [shellHarness, bridgeHarness]) {
    const h = make();
    h.select('words');
    const r = h.press();
    assert.equal(typeof r === 'number' ? r : r.opened, 0, `${make.name}: a selection`);
  }
});

test('both hosted bridge copies carry the block', () => {
  assert.equal(read('public/usernode-bridge.js'), BRIDGE);
});

// ── 5. The seams ──────────────────────────────────────────────────────

test('the Workshop claims its C, so the two never both open', () => {
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /if \(k === 'c' \|\| k === 'C'\) \{ e\.preventDefault\(\); toggleSheet\('comments'\); return; \}/);
});

test('the bundle installs the shortcut, which loads comment mode on the first C', () => {
  assert.match(read('frontend/src/main.tsx'), /^import '\.\/features\/improve\/suggest-shortcut';$/m);
  const src = read('frontend/src/features/improve/suggest-shortcut.ts');
  assert.match(src, /import\('\.\.\/comment-pin\/comment-pin'\)\s*\.then\(\(m\) => m\.toggleCommentMode\(\{ via: 'key' \}\)\)\s*\.catch\(\(\) => openSuggest\(\)\)/,
    'loaded on demand, on and off, and the dialog if it cannot load');
  assert.match(src, /^import type \{ OpenOptions \} from '\.\.\/comment-pin\/comment-pin';$/m,
    'only its type: the mode is never in the shell\'s bundle');
  assert.match(src, /w\.Improve\.giveFeedback\(\)/);
  assert.match(src, /bridge\.suggestShortcut = \{/, 'published for settings.js, which cannot import');
  // The hub's ⋯ menu is classic and cannot import: it reaches the same
  // warm-up through the bridge, so its row opens the mode at once.
  assert.match(src, /prepare: \(\) => prepareComment\(\),/, 'the bridge publishes the picture\'s warm-up');
});

test('Settings, Experimental no longer has the switch', () => {
  const { ExperimentalSection } = loadTsx('frontend/src/features/settings/sections/experimental.tsx', {
    stubs: { '../local-agents-list': { LocalAgentsList: () => null } },
  });
  const html = renderToHtml(createElement(ExperimentalSection));
  assert.doesNotMatch(html, /suggest-shortcut-enabled/, 'the switch is gone');
  assert.doesNotMatch(html, /Comment on the page/);
  // The other experiments keep their switches and their order.
  assert.ok(html.indexOf('id="ai-progress-estimate"') < html.indexOf('id="session-bridge-enabled"'));
  assert.ok(html.indexOf('id="session-bridge-enabled"') < html.indexOf('id="review-flow-enabled"'));
  assert.ok(html.indexOf('id="review-flow-enabled"') < html.indexOf('id="settings-local-agents-section"'));

  const settings = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(settings, /suggest-shortcut-enabled/, 'nothing paints or saves it there');
});

// ── 6. Suggest an improvement opens comment mode (#4289 follow-up) ─────

function modeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    map,
  };
}

test('Suggest an improvement opens comment mode by default, but the form on a phone and in the side panel', () => {
  const on = { [shortcut.SUGGEST_SHORTCUT_STORAGE_KEY]: '1' };
  const off = { [shortcut.SUGGEST_SHORTCUT_STORAGE_KEY]: '0' };
  const root = { documentElement: { classList: { contains: () => false } } };
  const page = { document: root, matchMedia: () => ({ matches: false }) };
  const panel = { document: { documentElement: { classList: { contains: (c) => c === 'in-side-panel' } } } };
  // #5762: on a phone the picture of the page read as the screen shrinking,
  // so the form opens first there and still offers comment mode as its switch.
  const asked = [];
  const phone = { document: root, matchMedia: (q) => { asked.push(q); return { matches: true }; } };
  assert.equal(shortcut.suggestOpensComment(phone, modeStorage()), false, 'a phone opens the form');
  assert.equal(asked[0], '(max-width: 767px) and (pointer: coarse)', 'the phone test comment mode lays out by');
  assert.equal(shortcut.formOffersComment(phone, modeStorage()), true, 'the form on a phone keeps its Comment switch');
  assert.equal(shortcut.suggestOpensComment(page, modeStorage()), true, 'a fresh device opens comment mode');
  assert.equal(shortcut.suggestOpensComment(page, modeStorage(on)), true);
  assert.equal(shortcut.suggestOpensComment(page, modeStorage(off)), false, 'the form, where the device turned it off');
  assert.equal(shortcut.suggestOpensComment(panel, modeStorage()), false, 'the side panel keeps the form');
  assert.equal(shortcut.suggestOpensComment(null, modeStorage()), false, 'no window, no comment mode');
  assert.equal(shortcut.formOffersComment(page, modeStorage()), true);
  assert.equal(shortcut.formOffersComment(page, modeStorage(off)), false, 'the form offers nothing where the device turned it off');
  assert.equal(shortcut.formOffersComment(panel, modeStorage()), false);
  assert.equal(shortcut.SUGGEST_MODE_STORAGE_KEY, undefined, 'nothing remembers a last way: the setting decides');
});

test('a plain open of the form goes to comment mode where the switch says so, and nothing else does', () => {
  const fc = read('frontend/src/features/dialogs/feedback-controller.js');
  const open = fc.match(/App\.openFeedbackModal = \(opts = \{\}\) => \{[\s\S]*?\n  \};/)[0];
  assert.match(open, /const plain = !opts\.edit && !opts\.firstFeedback && !opts\.description && !opts\.screenshotBlob && !opts\.screenshots\s*&& opts\.mode !== 'form';/);
  assert.match(open, /if \(plain && shortcut\?\.opensComment\?\.\(\)\) \{\s*shortcut\.openComment\(\{ via: 'suggest' \}\);\s*return;/);
  const src = read('frontend/src/features/improve/suggest-shortcut.ts');
  assert.match(src, /opensComment: \(\) => suggestOpensComment\(\),/);
  assert.match(src, /openComment: \(opts\?: OpenOptions\) => openCommentMode\(opts \|\| \{\}\),/);
  // Comment mode's Form asks for the form by name, past the routing.
  const mode = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(mode, /openFeedbackModal\?\.\(\{ mode: 'form' \}\)/);
  assert.doesNotMatch(mode, /setSuggestMode/);
});

test('the form offers comment mode with its draft, and only where the switch is on', () => {
  const { FeedbackDialog } = loadTsx('frontend/src/features/dialogs/feedback.tsx', {
    stubs: { './feedback-controller': { Feedback: {}, init() {} } },
  });
  const html = renderToHtml(createElement(FeedbackDialog));
  assert.match(html, /<div class="hidden"><span class="[^"]*" role="radiogroup" aria-label="How to suggest it">/,
    'shipped hidden: the switch is off until a person turns it on');
  const src = read('frontend/src/features/dialogs/feedback.tsx');
  assert.match(src, /setOffersComment\(formOffersComment\(\)\);/, 'read on every open');
  assert.match(src, /const carry = Feedback\._takeDraft\(\);\s*dialog\.close\(\);/, 'taken, then closed, so no second copy is saved');
  assert.match(src, /openCommentMode\(\{ via: 'switch', carry: any \? carry : null \}\);/);
  const fc = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.match(fc, /Feedback\._takeDraft = \(\) => \{[\s\S]*?feedbackText\.value = '';[\s\S]*?resetScreenshotState\(\);[\s\S]*?return draft;/);
});

test('comment mode\'s code and drawing library are fetched a few seconds after the page loads, where the switch is on', () => {
  // A quick tap on "Suggest an improvement" right after the app opened waited
  // on both downloads before anything could move (12 Oct 2026).
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/improve/suggest-shortcut.ts'), 'utf8');
  assert.equal(shortcut.WARM_DELAY_MS, 3000);
  // Scheduled after the load event, or at once when the page has already loaded.
  const calls = [];
  const fakeWin = (state) => ({
    document: { readyState: state },
    setTimeout: (fn, ms) => { calls.push(['timeout', ms]); return 1; },
    addEventListener: (type, fn, opts) => { calls.push(['listen', type, !!(opts && opts.once)]); fn(); },
  });
  shortcut.scheduleWarmComment(fakeWin('loading'));
  assert.deepEqual(calls, [['listen', 'load', true], ['timeout', 3000]]);
  calls.length = 0;
  shortcut.scheduleWarmComment(fakeWin('complete'));
  assert.deepEqual(calls, [['timeout', 3000]]);
  // Only where comment mode is the way Suggest opens, once per page, and the
  // mode's own warm-up fetches the library without drawing anything.
  assert.match(src, /export function warmComment\(\): void \{\s*if \(warmed \|\| !suggestOpensComment\(\) \|\| onCaptureRoute\(\)\) return;\s*warmed = true;\s*import\('\.\.\/comment-pin\/comment-pin'\)\s*\.then\(\(m\) => m\.warmCommentMode\(\)\)/);
  assert.match(src, /export function prepareComment\(\): void \{\s*if \(!suggestOpensComment\(\) \|\| onCaptureRoute\(\)\) return;/,
    'neither warms nor draws on a capture route');
  // A `?shot=` / `?demo=` page renders one state for a check or a still: the
  // picture drawn at boot there fetched the page's images for over 29 s and
  // the `?shot=app-context` check never reached network idle.
  assert.equal(shortcut.onCaptureRoute({ location: { search: '?shot=app-context' } }), true);
  assert.equal(shortcut.onCaptureRoute({ location: { search: '?demo=1&ws=all' } }), true);
  assert.equal(shortcut.onCaptureRoute({ location: { search: '?panel=1#app/x' } }), false);
  assert.equal(shortcut.onCaptureRoute({ location: { search: '' } }), false);
  assert.equal(shortcut.onCaptureRoute(null), false, 'no window: nothing to skip for');
  assert.match(src, /scheduleWarmComment\(window\);/);
  assert.match(src, /setEnabled: \(on: boolean\) => \{\s*setSuggestShortcutEnabled\(!!on\);\s*if \(on\) warmComment\(\);\s*\},/, 'and when the switch is turned on');
  const mode = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/comment-pin/comment-pin.tsx'), 'utf8');
  assert.match(mode, /export function warmCommentMode\(\): void \{\s*loadLibrary\(\)\.catch\(/);
});
