// test:changed: always (app.css and every source under frontend/ and public/js/, for a width taken from 100vw; scripts/test-changed.js)
// THE USABLE BOX (iPhone Duo, 1 November 2026): one place decides where
// content can go, and nothing else takes a width from the window.
//
// The Duo's inner screen held sideways is 951x669 with an 84px column of
// system chrome on the right (the clock, the camera and the Wi-Fi ring at its
// top); folded, the cover is 466x678 with the same column. Several layout
// bugs came from width arithmetic that did not know about that column: Main's
// room was summed from 100vw and counted the column twice, and a notice
// capped at `100vw - 24px` and centred on the window ran under the clock.
// app.css now declares the box once, on body beside the rail's tokens:
//
//   --platform-usable-left / -right / -w   the page's box: the window less
//                                          the rail's reserved width and the
//                                          Duo's column (or its corner)
//   --platform-float-left / -right / -w    a floating surface's box (a menu,
//                                          a popover, a lightbox, a dialog):
//                                          the window less the column only
//
// This suite pins how the box is made, and fails on a `100vw` (or `100dvw`,
// `100svw`, `100lvw`) anywhere else: in app.css outside the box's own
// declaration, and in a class string, an inline style or any other code
// under frontend/src, frontend/@ and public/js. Comments are prose, not
// widths, and are stripped first. A width that must stay on the window goes
// in an allowlist below with its reason; none does today.
//
// Run with: node --test tests/usable-box.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');

// Every viewport-width unit that names the whole window. `vw` multiples
// other than 100 (a gradient's ellipse, the side panel's 36vw) are
// proportions of the window, not the window, and are not this rule's.
const WINDOW_WIDTH = /\b100[dsl]?vw\b/g;
// Tailwind's names for the same thing: `w-screen` and `min-w-screen` are
// 100vw, `w-dvw`/`w-svw`/`w-lvw` the dynamic, small and large ones. Not
// `max-w-screen-md`, which is a breakpoint's fixed width.
const WINDOW_WIDTH_CLASS = /(?<![\w-])(?:min-|max-)?w-(?:screen|[dsl]vw)(?![\w-])/g;

function cssCode(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Block and line comments out, newlines kept so a line number still points
// at the source. The `[^:]` keeps a URL's `//` (https://) in the code.
function code(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (m, before, comment) => before + blank(comment));
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// The declaration a match sits in: the property name between the last `{`,
// `;` or `}` before it and the first `:`.
function propertyAt(text, index) {
  const start = Math.max(text.lastIndexOf('{', index), text.lastIndexOf(';', index), text.lastIndexOf('}', index));
  const head = text.slice(start + 1, index);
  const m = head.match(/^\s*([-\w]+)\s*:/);
  return m ? m[1] : null;
}

// ── How the box is made ─────────────────────────────────────────────────

test('the box is declared once, on body, beside the rail\'s tokens', () => {
  // On body, not :root: a custom property's var()s resolve on the element
  // that declares it, and `--platform-rail-w` is body's (its 768px rule is
  // `body:has(#platform-tabs:not(.hidden))`), so a box on :root would read
  // the rail as 0 at every width.
  assert.match(CSS,
    /--platform-rail-w: 0px;\n  --platform-gutter: 0px;\n\}\n\/\* THE USABLE BOX: WHERE CONTENT CAN GO, DECIDED ONCE [^]*?\*\/\nbody \{\n  --platform-float-left: 0px;\n  --platform-float-right: 0px;\n  --platform-float-w: calc\(100vw - var\(--platform-float-left\) - var\(--platform-float-right\)\);\n  \/\* The rail comes off whichever side it stands on[^]*?\*\/\n  --platform-usable-left: calc\(var\(--platform-float-left\) \+ var\(--platform-rail-w, 0px\) \* \(1 \+ var\(--rtl-sign\)\) \/ 2\);\n  --platform-usable-right: calc\(var\(--platform-float-right\) \+ var\(--platform-rail-w, 0px\) \* \(1 - var\(--rtl-sign\)\) \/ 2\);\n  --platform-usable-w: calc\(var\(--platform-float-w\) - var\(--platform-rail-w, 0px\)\);\n\}/,
    'the float box is the window less the column; the page\'s box is that less the rail, on the left');
  // The column, on the side the body pads it out: the strip at every width,
  // the folded Duo's corner on a phone only, as THE SIDE CORNER pads it.
  assert.match(CSS, /\nhtml\[data-side-strip="left"\] body \{ --platform-float-left: var\(--platform-strip-w, 0px\); \}\nhtml\[data-side-strip="right"\] body \{ --platform-float-right: var\(--platform-strip-w, 0px\); \}\n@media \(max-width: 767px\) \{\n  html\[data-side-corner="left"\] body \{ --platform-float-left: var\(--platform-corner-w, 0px\); \}\n  html\[data-side-corner="right"\] body \{ --platform-float-right: var\(--platform-corner-w, 0px\); \}\n\}/);
  // Nothing else writes the box: one set of facts, read everywhere.
  for (const prop of ['--platform-usable-left', '--platform-usable-right', '--platform-usable-w', '--platform-float-w']) {
    const writes = cssCode(CSS).match(new RegExp(`${prop}\\s*:`, 'g')) || [];
    assert.equal(writes.length, 1, `${prop} is declared once`);
  }
  const sides = cssCode(CSS).match(/--platform-float-(left|right)\s*:/g) || [];
  assert.equal(sides.length, 8, 'the two sides: their 0px default, the strip and the corner on each side, and a notch on both (THE NOTCH)');
  assert.match(CSS, /@media \(min-width: 768px\) \{\n  html:not\(\[data-side-strip\]\):not\(\[data-side-corner\]\) body \{\n    --platform-notch-left: var\(--un-safe-inset-left, env\(safe-area-inset-left, 0px\)\);\n    --platform-notch-right: var\(--un-safe-inset-right, env\(safe-area-inset-right, 0px\)\);[^}]*--platform-float-left: var\(--platform-notch-left\);\n    --platform-float-right: var\(--platform-notch-right\);/);
});

test('the bot tab\'s room is the page\'s box, the value it always had', () => {
  // It was `100vw - rail - strip`: the same three things, now taken off in
  // one place (tests/ai-screen.test.js pins the rest of the block).
  assert.match(CSS, /body:has\(#ai-screen:not\(\.hidden\)\) \{\s+--ai-room: var\(--platform-usable-w\);/);
});

// ── Nothing else takes a width from the window ──────────────────────────

// The one declaration in app.css that may name the window, and why.
const CSS_ALLOWED = new Map([
  ['--platform-float-w', 'THE USABLE BOX itself: the one width taken from the window, which every other reads'],
]);

test('app.css takes no width from 100vw outside the usable box', () => {
  const text = cssCode(CSS);
  const found = [];
  for (const m of text.matchAll(WINDOW_WIDTH)) {
    const prop = propertyAt(text, m.index);
    if (CSS_ALLOWED.has(prop)) continue;
    const line = lineOf(text, m.index);
    found.push(`public/css/app.css:${line} ${prop || '(no property)'}: ${CSS.split('\n')[line - 1].trim()}`);
  }
  assert.deepEqual(found, [],
    'take the width from the usable box (`--platform-usable-w` for the page, `--platform-float-w` for a '
    + 'menu, popover or dialog), or a percentage of the containing block; see THE USABLE BOX in app.css');
  for (const [prop, reason] of CSS_ALLOWED) {
    const uses = [...text.matchAll(WINDOW_WIDTH)].filter((m) => propertyAt(text, m.index) === prop);
    assert.equal(uses.length, 1, `${prop} names the window exactly once (${reason})`);
  }
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?|mjs|cjs|html)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const SOURCES = [
  ...walk(path.join(root, 'frontend', 'src')),
  ...walk(path.join(root, 'frontend', '@')),
  ...walk(path.join(root, 'public', 'js')),
].map((p) => ({ path: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));

// A source that must keep a window width, keyed by its path, with the
// reason. Empty: every use converted. An entry that no longer matches
// anything fails below, so the list cannot outlive its reasons.
const SOURCE_ALLOWED = new Map([]);

test('the sources scanned are the shell\'s own', () => {
  assert.ok(SOURCES.length > 200, `found ${SOURCES.length} sources`);
  assert.ok(SOURCES.some((s) => s.path === 'frontend/src/Shell.tsx'));
  assert.ok(SOURCES.some((s) => s.path.startsWith('frontend/@/components/ui/')));
  assert.ok(SOURCES.some((s) => s.path === 'public/js/app.js'));
});

test('no class string, inline style or other code under frontend/ or public/js/ takes a width from the window', () => {
  const found = [];
  const allowedHit = new Set();
  for (const source of SOURCES) {
    const text = code(source.text);
    const lines = source.text.split('\n');
    for (const pattern of [WINDOW_WIDTH, WINDOW_WIDTH_CLASS]) {
      for (const m of text.matchAll(pattern)) {
        if (SOURCE_ALLOWED.has(source.path)) { allowedHit.add(source.path); continue; }
        const line = lineOf(text, m.index);
        found.push(`${source.path}:${line} ${m[0]}: ${lines[line - 1].trim().slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(found, [],
    'take the width from the usable box instead: `calc(var(--platform-float-w)-24px)` in a class, '
    + '`calc(var(--platform-float-w) - 32px)` in a style (or `--platform-usable-w` for the page\'s own '
    + 'content); see THE USABLE BOX in public/css/app.css');
  for (const p of SOURCE_ALLOWED.keys()) {
    assert.ok(allowedHit.has(p), `${p} is allowed a window width but no longer uses one: drop the entry`);
  }
});

test('the lint sees what it is for, and not the prose about it', () => {
  // A class string, an arbitrary value, an inline style and the dynamic
  // units are found; a comment naming 100vw and a fixed breakpoint width are
  // not, and a URL's `//` is not taken for the start of a comment.
  const hits = (src) => [WINDOW_WIDTH, WINDOW_WIDTH_CLASS]
    .flatMap((p) => [...code(src).matchAll(p)].map((m) => m[0]));
  assert.deepEqual(hits('const a = "fixed w-screen";'), ['w-screen']);
  assert.deepEqual(hits('const a = "sm:min-w-screen";'), ['min-w-screen']);
  assert.deepEqual(hits('const a = "max-w-[calc(100vw-24px)]";'), ['100vw']);
  assert.deepEqual(hits("el.style.width = 'min(440px, calc(100dvw - 32px))';"), ['100dvw']);
  assert.deepEqual(hits('const a = "h-dvh w-svw";'), ['w-svw']);
  assert.deepEqual(hits('// 100vw counts the scrollbar\nconst a = 1;'), []);
  assert.deepEqual(hits('/* w-screen, 100vw */ const a = 1;'), []);
  assert.deepEqual(hits('{/* max-w-[100vw] */}'), []);
  assert.deepEqual(hits('const a = "max-w-screen-md w-full";'), []);
  assert.deepEqual(hits('const u = "https://example.test/100vw";'), ['100vw']);
  // And in app.css, the property a width sits in.
  const css = 'a { max-width: calc(100vw - 24px); }\nb { --platform-float-w: calc(100vw - 0px); }';
  assert.deepEqual([...css.matchAll(WINDOW_WIDTH)].map((m) => propertyAt(css, m.index)), ['max-width', '--platform-float-w']);
});
