'use strict';

// The layout audit's rules (scripts/layout-audit/rules.mjs), driven with
// made-up snapshots: no browser. Each case is the shape of a bug that
// reached people before the audit existed (iPhone Duo, 1 November 2026).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const load = (f) => import(path.join(ROOT, 'scripts/layout-audit', f));

const DUO = {
  id: 'duo-sideways', width: 951, height: 669, touch: true, keyboard: 264,
  system: [
    { name: 'clock, camera and Wi-Fi', x: 867, y: 0, w: 84, h: 100, severity: 'error' },
    { name: 'home indicator', x: 0, y: 648, w: 951, h: 21, severity: 'warn' },
  ],
};
const DESKTOP = { id: 'desktop', width: 1280, height: 800, touch: false, keyboard: 0, system: [] };

function snap(over = {}) {
  return {
    facts: {},
    viewport: { w: 951, h: 669, visibleH: 669, scrollW: 951 },
    landmarks: [],
    targets: [],
    chats: [],
    ...over,
  };
}
const target = (desc, rect, extra = {}) => ({ desc, rect, reachable: true, clipped: false, scrolls: false, inline: false, ...extra });
const rules = (found) => found.map((v) => `${v.severity} ${v.rule}`);

test('a page wider than the screen scrolls sideways', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  assert.deepEqual(rules(checkSnapshot(snap({ viewport: { w: 951, h: 669, visibleH: 669, scrollW: 1035 } }), DUO)), ['error page-overflow']);
  assert.deepEqual(checkSnapshot(snap(), DUO), []);
});

test('a control under the clock is an error; content that scrolls under it is not', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  // The header's bell and chip once sat under the Duo's clock column.
  const bell = target('button "Notifications"', { x: 880, y: 20, w: 40, h: 40 });
  assert.deepEqual(rules(checkSnapshot(snap({ targets: [bell] }), DUO)), ['error target-under-system']);
  // A row in Main's transcript passes under it and scrolls back out.
  assert.deepEqual(checkSnapshot(snap({ targets: [{ ...bell, scrolls: true }] }), DUO), []);
  // Judged at its middle: a control whose edge brushes the column is not under it.
  assert.deepEqual(checkSnapshot(snap({ targets: [target('button "Search"', { x: 827, y: 20, w: 44, h: 40 })] }), DUO), []);
  // Covered by something drawn over it, it is not a place a finger lands.
  assert.deepEqual(checkSnapshot(snap({ targets: [{ ...bell, reachable: false }] }), DUO), []);
});

test('the home indicator is a warning, for fixed controls only', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  const tab = target('a "You"', { x: 20, y: 640, w: 180, h: 28 });
  assert.deepEqual(rules(checkSnapshot(snap({ targets: [tab] }), DUO)), ['warn target-under-system']);
});

test('a control that runs off the side of the screen, unless something clips it', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  const chip = target('button "17 more"', { x: 900, y: 300, w: 120, h: 36 });
  assert.deepEqual(rules(checkSnapshot(snap({ targets: [chip] }), DUO)), ['error target-past-edge']);
  assert.deepEqual(checkSnapshot(snap({ targets: [{ ...chip, clipped: true }] }), DUO), [], 'a chip row that scrolls sideways');
});

test('a control smaller than a fingertip, on a touch screen, unless it is a link in a sentence', async () => {
  const { checkSnapshot, MIN_TARGET } = await load('rules.mjs');
  assert.equal(MIN_TARGET, 24);
  // Main's divider was a 10px strip before it had a touch handle.
  const divider = target('div#ai-main-divider "Resize panel"', { x: 391, y: 45, w: 10, h: 624 });
  assert.deepEqual(rules(checkSnapshot(snap({ targets: [divider] }), DUO)), ['warn small-target']);
  // Its foot reaches the home indicator, its middle does not: not under it.
  assert.deepEqual(checkSnapshot(snap({ targets: [divider] }), DESKTOP), [], 'a mouse can hit 10px');
  assert.deepEqual(checkSnapshot(snap({ targets: [{ ...divider, inline: true }] }), DUO), []);
});

test('a chat that stops short of its reply box, while nobody is typing', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  // PR 6087: an empty typing line and the composer's padding left 24px.
  const chat = { scroller: 'div.messages-thread-scroll', scrollerRect: { x: 548, y: 108, w: 403, h: 155 }, cardRect: { x: 560, y: 287, w: 379, h: 110 }, statusEmpty: true, focused: false };
  const found = checkSnapshot(snap({ chats: [chat] }), DUO);
  assert.deepEqual(rules(found), ['warn transcript-gap']);
  assert.match(found[0].message, /stops 24px above its reply box/);
  assert.deepEqual(checkSnapshot(snap({ chats: [{ ...chat, statusEmpty: false }] }), DUO), [], 'a typing line in the gap says something');
  assert.deepEqual(checkSnapshot(snap({ chats: [{ ...chat, cardRect: { ...chat.cardRect, y: 263 } }] }), DUO), []);
});

test('a column\'s header that is not as wide as its column', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  const main = { key: 'bot-main', desc: 'aside#ai-main-pane', rect: { x: 396, y: 44, w: 555, h: 625 } };
  const head = { key: 'bot-main-head', desc: 'header.ai-main-head', rect: { x: 396, y: 44, w: 471, h: 64 } };
  assert.deepEqual(rules(checkSnapshot(snap({ landmarks: [main, head] }), DUO)), ['warn head-spans-column']);
  assert.deepEqual(checkSnapshot(snap({ landmarks: [main, { ...head, rect: { ...head.rect, w: 555 } }] }), DUO), []);
});

test('raising the keyboard must not move the page sideways, or take the sidebar from 768px', async () => {
  const { checkKeyboard } = await load('rules.mjs');
  // PR 6087: on the Duo and iPad the sidebar vanished and the page slid 212px.
  const sidebar = { key: 'sidebar', desc: 'nav#platform-tabs', rect: { x: 0, y: 44, w: 212, h: 625 } };
  const thread = { key: 'messages-thread', desc: 'section.messages-thread-pane', rect: { x: 448, y: 44, w: 419, h: 625 } };
  const rest = snap({ landmarks: [sidebar, thread] });
  const up = snap({ landmarks: [{ ...thread, rect: { ...thread.rect, x: 212, w: 655 } }], viewport: { w: 951, h: 669, visibleH: 405, scrollW: 951 } });
  assert.deepEqual(rules(checkKeyboard(rest, up, DUO)), ['error keyboard-shift', 'error keyboard-shift']);
  // Getting shorter is what a keyboard does.
  const shorter = snap({ landmarks: [sidebar, { ...thread, rect: { ...thread.rect, h: 361 } }], viewport: { w: 951, h: 669, visibleH: 405, scrollW: 951 } });
  assert.deepEqual(checkKeyboard(rest, shorter, DUO), []);
});

test('on a phone the tab bar at the foot goes with the keyboard, by design', async () => {
  const { checkKeyboard } = await load('rules.mjs');
  const PHONE = { ...DUO, id: 'phone', width: 393, height: 852 };
  const bar = { key: 'sidebar', desc: 'nav#platform-tabs', rect: { x: 0, y: 796, w: 393, h: 56 } };
  const rest = snap({ viewport: { w: 393, h: 852, visibleH: 852, scrollW: 393 }, landmarks: [bar] });
  const up = snap({ viewport: { w: 393, h: 852, visibleH: 516, scrollW: 393 }, landmarks: [] });
  assert.deepEqual(checkKeyboard(rest, up, PHONE), []);
});

test('the reply box being typed in has to clear the keys', async () => {
  const { checkKeyboard } = await load('rules.mjs');
  const card = { scroller: 's', scrollerRect: { x: 0, y: 0, w: 400, h: 300 }, cardRect: { x: 12, y: 520, w: 380, h: 60 }, statusEmpty: true, focused: true };
  const up = snap({ viewport: { w: 951, h: 669, visibleH: 405, scrollW: 951 }, chats: [card] });
  assert.deepEqual(rules(checkKeyboard(snap(), up, DUO)), ['error reply-box-covered']);
  assert.deepEqual(checkKeyboard(snap(), snap({ ...up, chats: [{ ...card, focused: false }] }), DUO), [], 'only the one being typed in');
});

test('the audit is wired: a script, every shape the Duo takes, and screens with a reply box', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:layout'], 'node scripts/layout-audit/run.mjs');
  const { PROFILES } = await load('profiles.mjs');
  const ids = PROFILES.map((p) => p.id);
  for (const id of ['phone', 'phone-sideways', 'duo-folded', 'duo-upright', 'duo-sideways', 'ipad', 'ipad-sideways', 'desktop']) assert.ok(ids.includes(id), id);
  // The Duo held sideways, as measured on its simulator.
  const duo = PROFILES.find((p) => p.id === 'duo-sideways');
  assert.deepEqual([duo.width, duo.height, duo.insets.right, duo.insets.bottom, duo.keyboard], [951, 669, 84, 34, 264]);
  const { SCREENS } = await load('fixtures.mjs');
  assert.ok(SCREENS.filter((s) => s.composer).length >= 3, 'the keyboard pass has chats to type in');
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('/layout-audit-report/'), 'its report is not committed');
});

test('the made-up world answers the reads the main screens make, and invents everyone', async () => {
  const { answer } = await load('fixtures.mjs');
  const get = (p) => answer('GET', new URL(`https://homeroom.test${p}`));
  for (const p of ['/api/auth/me', '/api/conversations', '/api/conversations/7001/messages', '/api/apps', '/api/ai/work', '/api/workshop/counts', '/api/notifications']) {
    const a = get(p);
    assert.equal(a.status, 200, p);
    assert.equal(a.fixture, true, p);
  }
  assert.equal(get('/api/nothing-here').status, 404);
  assert.equal(get('/api/nothing-here').fixture, false, 'a read it does not cover is reported, not faked');
  const me = get('/api/auth/me').json.user;
  assert.match(me.username, /^audit_/);
  const text = fs.readFileSync(path.join(ROOT, 'scripts/layout-audit/fixtures.mjs'), 'utf8');
  assert.doesNotMatch(text, /@[a-z0-9.-]+\.(com|org|net|io)\b/i, 'no real addresses');
  assert.match(text, /example\.invalid/);
});

test('comparing two runs: what moved, what appeared, what went', async () => {
  const { compareSnapshots } = await import(path.join(ROOT, 'scripts/layout-audit/compare.mjs'));
  const main = { key: 'bot-main', desc: 'aside#ai-main-pane', rect: { x: 396, y: 44, w: 555, h: 625 } };
  const send = target('button "Send"', { x: 900, y: 600, w: 40, h: 40 });
  const chat = { scroller: 's', scrollerRect: { x: 396, y: 108, w: 555, h: 470 }, cardRect: { x: 408, y: 578, w: 531, h: 60 }, statusEmpty: true, focused: false };
  const a = snap({ landmarks: [main], targets: [send], chats: [chat] });
  assert.deepEqual(compareSnapshots(a, a), [], 'a refactor that moves nothing');
  const b = snap({
    landmarks: [{ ...main, rect: { ...main.rect, x: 280, w: 671 } }],
    targets: [{ ...send, rect: { ...send.rect, y: 590 } }, target('button "Attach"', { x: 410, y: 600, w: 40, h: 40 })],
    chats: [{ ...chat, cardRect: { ...chat.cardRect, y: 566 } }],
  });
  assert.deepEqual(compareSnapshots(a, b), [
    'bot-main 396,44 555x625 -> 280,44 671x625',
    'chat 1 reply box 408,578 531x60 -> 408,566 531x60',
    'control moved: button "Send" 900,600 40x40 -> 900,590 40x40',
    'control new: button "Attach" at 410,600 40x40',
  ]);
  // Under a pixel is rounding, not a move.
  assert.deepEqual(compareSnapshots(a, snap({ landmarks: [{ ...main, rect: { ...main.rect, x: 396.6 } }], targets: [send], chats: [chat] })), []);
});

test('fixed text or an icon under the clock or the island cannot be read', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  const SIDEWAYS = { id: 'phone-sideways', width: 852, height: 393, touch: true, keyboard: 209, system: [{ name: 'camera island', x: 0, y: 120, w: 40, h: 153, severity: 'error' }] };
  // A sidebar row's label starts under the island though the row's middle is clear.
  const label = { desc: 'span "Discover"', rect: { x: 30, y: 180, w: 70, h: 20 } };
  assert.deepEqual(rules(checkSnapshot(snap({ viewport: { w: 852, h: 393, visibleH: 393, scrollW: 852 }, marks: [label] }), SIDEWAYS)), ['warn content-under-system']);
  assert.deepEqual(checkSnapshot(snap({ marks: [{ ...label, rect: { ...label.rect, x: 60 } }] }), SIDEWAYS), []);
});

test('a control is sized by what a finger can hit, which an invisible layer can enlarge', async () => {
  const { checkSnapshot } = await load('rules.mjs');
  // Home's Edit is drawn 26x18; the kit's un-touch-target makes it 44x44.
  const edit = target('button "Edit"', { x: 790, y: 123, w: 26, h: 18 }, { hit: { x: 781, y: 110, w: 44, h: 44 } });
  assert.deepEqual(checkSnapshot(snap({ targets: [edit] }), DUO), []);
  assert.deepEqual(rules(checkSnapshot(snap({ targets: [{ ...edit, hit: undefined }] }), DUO)), ['warn small-target']);
});

test('a header may fold away with the keys up; a column beside the page may not', async () => {
  const { checkKeyboard } = await load('rules.mjs');
  const head = { key: 'bot-main-head', desc: 'header.ai-main-head', rect: { x: 474, y: 45, w: 378, h: 63 } };
  const main = { key: 'bot-main', desc: 'aside#ai-main-pane', rect: { x: 473, y: 44, w: 379, h: 349 } };
  const rest = snap({ viewport: { w: 852, h: 393, visibleH: 393, scrollW: 852 }, landmarks: [head, main] });
  assert.deepEqual(checkKeyboard(rest, snap({ viewport: { w: 852, h: 393, visibleH: 184, scrollW: 852 }, landmarks: [main] }), DUO), []);
  assert.deepEqual(rules(checkKeyboard(rest, snap({ viewport: { w: 852, h: 393, visibleH: 184, scrollW: 852 }, landmarks: [head] }), DUO)), ['error keyboard-shift']);
});
