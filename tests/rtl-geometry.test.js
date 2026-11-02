'use strict';

// Logical properties mirror what the stylesheet lays out. They cannot mirror a
// sum in a script: a drawer that moves its panes by transform, a swipe read off
// clientX, a width measured from a box's left edge. tests/rtl-logical-css.test.js
// holds the stylesheet; this suite holds the sums that have to agree with it.
//
// The rule in each is the Communities drawer's (nav-drawer.tsx): read the
// finger's delta in reading direction, and draw the result with the same sign.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CSS = read('public/css/app.css');
const RULE = (selector) => {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('}', at));
};

test('the Messages drawer draws and reads its panes in reading direction', () => {
  const src = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(src, /\(pane === 'list' \? -offset : MESSAGES_AT\[1\] - offset\) \* w \* dirSign\(\)/,
    'the panes are anchored at inline-start, so their transform has to run the same way');
  assert.match(src, /const dx = \(e\.clientX - p\.x0\) \* dirSign\(\);/, 'a mouse pan');
  assert.match(src, /const dx = \(touch\.clientX - p\.x0\) \* dirSign\(\);/, 'a finger pan');
  assert.match(src, /swipeBackMayStart\(\{ x: touch\.clientX, takesEdge, sideways, rtl, width: window\.innerWidth \}\)/,
    'the back swipe\'s edge is the inline-start one');
});

test('the bot tab\'s drawer accepts the mirrored swipe and follows the finger', () => {
  const src = read('frontend/src/features/ai/phone-drawer.tsx');
  assert.match(src, /translateX\(\$\{-offset \* width \* dirSign\(\)\}px\)/);
  assert.match(src, /const dx = \(e\.clientX - p\.x\) \* dirSign\(\);/,
    'the "only toward the other level" test and the offset both read this delta');
  assert.match(src, /landingIn\(at, p\.from, now, \(e\.clientX - p\.x\) \* dirSign\(\)\)/,
    'landingIn reads the sign of dx to pick the way it lands');
  assert.match(CSS, /\.ai-drawer \.messages-thread-scroll \{ touch-action: pan-y; \}/,
    'or the browser takes the swipe on the chat and cancels the pointer');
});

test('the header that rides the drawers mirrors its slide and its slot', () => {
  const src = read('frontend/src/features/nav-drawer/header-drawer.tsx');
  assert.match(src, /translate3d\(\$\{x \* dirSign\(\)\}px, \$\{y\}px, 0\)/);
  assert.match(src, /dirSign\(\) === -1 \? -box\.right : box\.left/, 'titleSlot subtracts two figures that grow in reading direction');
});

test('the before/after slider keeps a picture\'s coordinates in every language', () => {
  // compare.tsx translates and scales each layer from its left edge, translates
  // the seam from the left, and clips by physical inset. Anchored at the right,
  // the divider leaves the picture and framed shots miss their crops.
  assert.match(RULE('.rf-compare'), /direction: ltr;/);
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /transformOrigin: '0 0'/);
  assert.match(src, /clipPath: `inset\(0 \$\{\(W - shown\)\.toFixed\(2\)\}px 0 0\)`/);
  assert.doesNotMatch(src, /dirSign/, 'the slider\'s sums stay physical: the stylesheet pins its box instead');
});

test('the places tray\'s edge swipe starts from the inline-start edge', () => {
  const { isEdgeSwipe, isCloseSwipe } = loadTsx('frontend/src/features/dev-board/workshop/places-tray.tsx');
  assert.equal(isEdgeSwipe(4, 300, 120, 310), true, 'English: rightward from the left edge');
  assert.equal(isEdgeSwipe(386, 300, 270, 310), false, 'English: the right edge is nothing');
  assert.equal(isEdgeSwipe(386, 300, 270, 310, true, 390), true, 'Arabic: leftward from the right edge');
  assert.equal(isEdgeSwipe(4, 300, 120, 310, true, 390), false, 'Arabic: the left edge is nothing');
  assert.equal(isCloseSwipe(200, 300, 100, 300), true, 'English closes leftward');
  assert.equal(isCloseSwipe(100, 300, 200, 300, true), true, 'Arabic closes rightward');
  assert.equal(isCloseSwipe(200, 300, 100, 300, true), false);
});

test('the side panel measures itself in figures that hold in Arabic', () => {
  const { inlineStartOf, probeLayout, shownWidth } = loadTsx('frontend/src/features/side-panel/resize.ts');
  const windowAt = (dir, strip) => ({
    innerWidth: 1000,
    getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--platform-strip-w' ? '84px' : '') }),
    document: {
      body: {},
      documentElement: { dir, getAttribute: (name) => (name === 'data-side-strip' ? strip : null) },
      getElementById: (id) => (id === 'app-view'
        ? { getBoundingClientRect: () => (dir === 'rtl' ? { left: 0, right: 924, width: 924 } : { left: 76, right: 1000, width: 924 }) }
        : null),
    },
  });
  const ltr = windowAt('ltr', null);
  const rtl = windowAt('rtl', null);
  assert.equal(inlineStartOf({ left: 600, right: 1000 }, ltr), 600);
  assert.equal(inlineStartOf({ left: 0, right: 400 }, rtl), 600, 'a panel pinned left, its inner edge 600 from the right');
  assert.equal(probeLayout(ltr).appLeft, 76);
  assert.equal(probeLayout(rtl).appLeft, 76, 'the rail\'s width either way');
  assert.equal(shownWidth(inlineStartOf({ left: 0, right: 400 }, rtl), probeLayout(rtl)), 400);
  assert.equal(probeLayout(windowAt('rtl', 'left')).rightInset, 84, 'the Duo\'s column counts on the panel\'s side');
  assert.equal(probeLayout(windowAt('rtl', 'right')).rightInset, 0, 'and not on the rail\'s');
  assert.equal(probeLayout(windowAt('ltr', 'right')).rightInset, 84);

  const panel = read('frontend/src/features/side-panel/side-panel.tsx');
  assert.match(panel, /d\.startW \+ \(d\.startX - e\.clientX\) \* dirSign\(\)/, 'a drag widens toward inline-start');
  assert.match(panel, /next = now \+ step \* dirSign\(\)/, 'and so do the keys');
});

test('the agent session\'s spec pane resizes the way its divider moves', () => {
  const src = read('frontend/src/features/agent-session/index.tsx');
  assert.match(src, /commit\(startWidth - \(move\.clientX - startX\) \* dirSign\(\)\)/);
  assert.match(src, /\(event\.key === 'ArrowLeft' \? SPEC_WIDTH_STEP : -SPEC_WIDTH_STEP\) \* dirSign\(\)/);
});

test('a sideways scroller reads scrollLeft as a distance: it is negative in Arabic', () => {
  for (const file of ['frontend/src/lib/use-scroll-fade.ts', 'frontend/src/features/ai/lists.tsx']) {
    assert.match(read(file), /const at = Math\.abs\(el\.scrollLeft\);/, file);
  }
  const staking = read('frontend/src/features/profile/staking-sheet.tsx');
  assert.match(staking, /\(el\.clientWidth - 12\) \* dirSign\(\)/, 'a positive scrollLeft is clamped to 0 there');
  assert.match(staking, /Math\.abs\(el\.scrollLeft\) \/ \(el\.clientWidth - 12\)/);
});

test('hardware insets follow the side the shell stands on in Arabic', () => {
  assert.match(CSS, /--platform-usable-left: calc\(var\(--platform-float-left\) \+ var\(--platform-rail-w, 0px\) \* \(1 \+ var\(--rtl-sign\)\) \/ 2\);/,
    'the rail comes off the left of the page\'s box only where it stands there');
  assert.match(CSS, /--platform-usable-right: calc\(var\(--platform-float-right\) \+ var\(--platform-rail-w, 0px\) \* \(1 - var\(--rtl-sign\)\) \/ 2\);/,
    'and off the right in Arabic');
  assert.match(CSS, /html\[dir="rtl"\]:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) \.platform-tabs \{\s+width: calc\(var\(--platform-rail-full\) \+ var\(--platform-notch-right\)\);/,
    'the sidebar clears the island on its own side');
  assert.match(CSS, /html\[dir="rtl"\]\[data-side-strip="left"\] body:has\(#ai-screen:not\(\.hidden\)\) \{ --ai-edge: var\(--platform-strip-w, 0px\); \}/,
    'Main stands on the left, so that is its edge');
});

test('a person\'s words in a list row keep their own direction in Arabic, and nothing changes elsewhere', () => {
  const direction = loadTsx('frontend/src/lib/i18n/direction.ts');
  const before = globalThis.document;
  try {
    globalThis.document = { documentElement: { dir: 'rtl' } };
    assert.equal(direction.ownDirection('See you Saturday!'), '\u2068See you Saturday!\u2069');
    assert.equal(direction.ownDirection(''), '', 'no text stays no text, so a row\'s fallback still shows');
    globalThis.document = { documentElement: { dir: 'ltr' } };
    assert.equal(direction.ownDirection('See you Saturday!'), 'See you Saturday!', 'byte for byte, so no check reads a control character');
  } finally {
    globalThis.document = before;
  }
  assert.match(read('frontend/src/features/messages/index.tsx'), /ownDirection\(preview \|\| conversation\.latestSummary \|\| ''\) \|\| t\('messages:inbox\.noMessages'\)/);
});
