'use strict';

// What the layout audit (scripts/layout-audit, PR 6089) found on main, 1
// November 2026, and the rules that fixed it:
//
//   * an iPhone held sideways in Safari: the sidebar's icons and labels under
//     the camera island, the page's right edge under it with the phone turned
//     the other way;
//   * the sidebar taller than the screen with no way to scroll: on that phone
//     its last communities and You ran off the bottom, and on the iPhone Duo
//     held sideways a project's places pushed You into the home indicator;
//   * typing on that phone: the reply box behind the keys and the transcript
//     above it squeezed to nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

test('a notch on either side is kept clear, from 768px, unless it is the Duo\'s column', () => {
  assert.match(CSS, /\nbody \{\n  --platform-notch-left: 0px;\n  --platform-notch-right: 0px;\n\}/, 'nothing on a device without side insets');
  const at = CSS.indexOf('  html:not([data-side-strip]):not([data-side-corner]) body {\n    --platform-notch-left');
  assert.ok(at > 0);
  assert.equal(CSS.lastIndexOf('@media (min-width: 768px) {', at), CSS.lastIndexOf('@media', at), 'inside the wide layout');
  const rule = CSS.slice(at, CSS.indexOf('\n  }', at));
  assert.match(rule, /padding-left: var\(--platform-notch-left\);\n    padding-right: var\(--platform-notch-right\);/, 'the body pads, as it does for the column');
  // The header spans the screen and pads its controls, as it does for the column.
  assert.match(CSS, /html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) #platform-header \{\n    margin-left: calc\(-1 \* var\(--platform-notch-left\)\);\n    margin-right: calc\(-1 \* var\(--platform-notch-right\)\);\n    padding-left: calc\(1rem \+ var\(--platform-notch-left\)\);\n    padding-right: calc\(1rem \+ var\(--platform-notch-right\)\);/);
  // The sidebar's ground runs under the island; its rows start after it.
  assert.match(CSS, /html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) \.platform-tabs \{\n    width: calc\(var\(--platform-rail-full\) \+ var\(--platform-notch-left\)\);\n    padding-left: calc\(6px \+ var\(--platform-notch-left\)\);/);
  // On the right it is the bot tab's edge, and the chat keeps clear of it.
  assert.match(CSS, /html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) body:has\(#ai-screen:not\(\.hidden\)\) \{\n  --ai-edge: var\(--platform-notch-right, 0px\);/);
});

test('the sidebar scrolls when it is taller than the screen, with You and the cog together', () => {
  const at = CSS.indexOf('IT SCROLLS WHEN IT IS TALLER THAN THE SCREEN');
  assert.ok(at > 0);
  const rest = CSS.slice(at, CSS.indexOf('\n  }', at));
  assert.match(rest, /overflow-x: hidden;\n    overflow-y: auto;\n    overscroll-behavior: contain;/);
  // The cog is in the flow at the end of You's row, so it scrolls with it;
  // pinned to the sidebar's foot it stayed over other rows.
  const cog = CSS.slice(CSS.indexOf('IN THE FLOW, AT THE END OF YOUR ROW'));
  const body = cog.slice(cog.indexOf('.platform-rail-settings {'), cog.indexOf('}'));
  assert.doesNotMatch(body, /position: absolute|bottom:/);
  assert.match(body, /flex: none;/, 'never squeezed to its glyph');
  assert.match(body, /margin: 0 0 -37px;/, 'its 36px line and the 1px gap come back');
});

test('typing on a short screen, the conversation\'s header folds away', () => {
  assert.match(CSS, /@media \(max-height: 500px\) \{\n  html:is\(\.un-kb, \.platform-kb-open\) :is\(\.messages-thread-header, #ai-screen \.ai-main-head\) \{\n    display: none;/);
});
