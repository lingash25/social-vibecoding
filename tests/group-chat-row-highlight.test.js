'use strict';

// #2464 — "message box on messages should only highlight the outside when
// clicked, not also the inner message box."
//
// The doubled highlight was never a second rule painting the bubble. It was two
// colour collisions that let the ROW's highlight arrive inside the message box:
//
//   1. the row's hover/tap fill was `--bg-secondary`, which in the light palette
//      is byte-identical to `--dc-raised`, the bubble's own surface. The
//      highlight therefore painted the row the bubble's exact colour and the
//      bubble's edges vanished into it: one flat slab instead of a box on a band.
//   2. the self bubble was filled with `--accent-tint` ALONE, which is
//      translucent, so it composited whatever the row was painted and tracked the
//      row highlight almost 1:1.
//
// Both are invisible in a diff of class strings and neither shows up in a
// console-error check, so they are pinned here as colour facts rather than as
// the shape of the declarations that happen to produce them today.

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'),
  'utf8'
);

/** The declarations of a flat (un-nested) rule, single-line or block. */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  const open = CSS.indexOf('{', i);
  const close = CSS.indexOf('}', open);
  assert.ok(close > open, `unterminated \`${selector}\` rule in app.css`);
  return CSS.slice(open + 1, close);
}

/** The last declared value of `prop` in a rule body, or null. */
function decl(body, prop) {
  const re = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'g');
  let m;
  let last = null;
  while ((m = re.exec(body)) !== null) last = m[1].trim();
  return last;
}

/** Custom properties declared by every flat block with this selector. */
function tokens(selector) {
  const out = Object.create(null);
  const blocks = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'g');
  let block;
  let found = 0;
  while ((block = blocks.exec(CSS)) !== null) {
    found += 1;
    const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let m;
    while ((m = re.exec(block[1])) !== null) out[m[1]] = m[2].trim();
  }
  assert.ok(found > 0, `expected a \`${selector}\` block in app.css`);
  return out;
}

const LIGHT = tokens(':root');
const DARK = Object.assign(Object.create(null), LIGHT, tokens('.dark'));

/** Resolve `var(--x)` chains against one theme's token map. */
function resolve(value, theme, depth = 0) {
  assert.ok(depth < 10, `var() chain too deep resolving ${value}`);
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(String(value).trim());
  if (!m) return String(value).trim();
  const next = theme[m[1]];
  assert.ok(next, `unresolved token ${m[1]}`);
  return resolve(next, theme, depth + 1);
}

const THEMES = [
  { name: 'light', map: LIGHT, hover: rule('.gc-msg:hover') },
  { name: 'dark', map: DARK, hover: rule('.dark .gc-msg:hover') },
];

test('the row highlight is never the colour the message box is made of', () => {
  const bubble = decl(rule('.gc-bubble'), 'background');
  assert.ok(bubble, 'expected .gc-bubble to declare its own surface');

  for (const { name, map, hover } of THEMES) {
    const fill = decl(hover, 'background');
    assert.ok(fill, `expected a hover fill for the ${name} transcript row`);
    assert.notStrictEqual(
      resolve(fill, map),
      resolve(bubble, map),
      `in ${name} mode the hovered row is painted the bubble's own surface, so ` +
        'the message box disappears into the highlight (#2464)'
    );
  }
});

test('the highlight lives on the row, and the row is the outer box', () => {
  // The transcript's own structure: `.gc-msg` is the full-width row, `.gc-bubble`
  // is the box inside it. Nothing may paint a click/hover highlight on the inner
  // box, in either direction (a `.gc-bubble:hover` rule, or a descendant rule
  // reaching in from the row's own hover).
  const offenders = [...CSS.matchAll(/^[^\n@{}]*\{[^}]*\}/gm)]
    .map((m) => m[0].split('{')[0].trim())
    .filter((sel) => /\.gc-(?:bubble|msg-content)\b/.test(sel))
    .filter((sel) => /:(?:hover|active)\b/.test(sel))
    .filter((sel) => !sel.includes('.gc-quoted')); // a clickable quote's own affordance

  assert.deepStrictEqual(
    offenders,
    [],
    'a message-box highlight must be scoped to the outer `.gc-msg` row, not to ' +
      'the `.gc-bubble` inside it (#2464)'
  );
});

test('the self bubble is opaque, so the row highlight cannot show through it', () => {
  const self = rule('.gc-bubble-self');

  const base = decl(self, 'background-color');
  assert.ok(
    base,
    '.gc-bubble-self must sit on an opaque `background-color`; filling it with ' +
      'the translucent `--accent-tint` alone lets the row highlight composite ' +
      'straight through the message box (#2464)'
  );

  for (const { name, map } of THEMES) {
    const resolved = resolve(base, map);
    assert.ok(
      /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(resolved),
      `the ${name} self-bubble base resolves to ${resolved}, which is not an ` +
        'opaque colour'
    );
    assert.strictEqual(
      resolved,
      resolve(decl(rule('.gc-bubble'), 'background'), map),
      `the ${name} self bubble should be the same surface as every other ` +
        'bubble, tinted — not a surface of its own'
    );
  }

  // The accent tint stays a tint: composited over that base as a second layer,
  // so it keeps tracking `--accent-tint` in both themes with no second copy of
  // its alpha and no `.dark` variant to keep in sync.
  assert.match(
    decl(self, 'background-image') || '',
    /linear-gradient\(\s*var\(--accent-tint\)\s*,\s*var\(--accent-tint\)\s*\)/,
    'expected the accent tint layered over the self bubble as a background-image'
  );
});
