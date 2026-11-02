'use strict';

// iPhone Duo, 1 November 2026: on the inner screen held sideways, tapping a
// message box took the sidebar away and the whole page slid 212px left, then
// slid back when the keyboard dropped. The rule that hides the phone's bottom
// tab bar while the keys are up applied at every width, and from 768px that
// bar is the sidebar down the left of the window, beside the page. The keys
// cover its foot; nothing rides on them, so it stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

/** The `@media` block that opens last before `at`, with its own text. */
function enclosingMedia(at) {
  const open = CSS.lastIndexOf('\n@media ', at);
  const close = CSS.indexOf('\n}\n', open);
  assert.ok(open >= 0 && close > at, 'expected the rule inside a media block');
  return CSS.slice(open + 1, CSS.indexOf('{', open)).trim();
}

test('the keyboard takes the bottom bar on a phone only', () => {
  const at = CSS.indexOf('html.un-kb #platform-tabs {');
  assert.ok(at > 0);
  assert.equal(CSS.indexOf('html.un-kb #platform-tabs {', at + 1), -1, 'one rule hides it');
  assert.equal(enclosingMedia(at), '@media (max-width: 767px)');
  assert.match(CSS.slice(at, at + 60), /\{\s*display: none;\s*\}/);
});

test('from 768px the rail keeps its column and the page keeps its place with the keys up', () => {
  const rail = CSS.indexOf('\n  body:has(#platform-tabs:not(.hidden)) {');
  assert.ok(rail > 0, 'the rail claims its width whatever the keyboard is doing');
  assert.equal(enclosingMedia(rail), '@media (min-width: 768px)');
  assert.match(CSS.slice(rail, rail + 120), /--platform-rail-w: var\(--platform-rail-full\);/);
  for (const selector of [
    'body:has(#platform-tabs.platform-tabs-folded) {',
    'body:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek):not(.platform-tabs-folded)) #app-view {',
    'body.rail-pinned:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek):not(.platform-tabs-folded)) #app-view {',
    'body:has(#platform-tabs:not(.hidden):not(.platform-tabs-folded)) #platform-header {',
    'body:has(#platform-tabs:not(.hidden):not(.platform-tabs-route-hidden)) .platform-sidebar-toggle {',
    'body:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek):not(.platform-tabs-folded)) .dev-ws-places-btn {',
  ]) {
    assert.ok(CSS.includes(`\n  ${selector}`), selector);
    assert.ok(!CSS.includes(`html:not(.un-kb) ${selector}`), `no keyboard guard on ${selector}`);
  }
});

test('the home-indicator band still drops with the keys up, on every width', () => {
  // Those two rules keep the guard: the strip they reserve is behind the
  // keyboard, and they must match the phone rule's selector exactly.
  const band = CSS.indexOf('\n  html:not(.un-kb) body:has(#platform-tabs:not(.hidden):not(.platform-tabs-peek)) {');
  assert.ok(band > 0);
  assert.equal(enclosingMedia(band), '@media (min-width: 768px)');
  assert.match(CSS.slice(band, band + 240), /--platform-bar-h: 0px;\s*--platform-tabs-h: var\(--platform-safe-bottom\);/);
});
