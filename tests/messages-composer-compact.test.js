'use strict';

// #3735: on a phone the message box is ONE compact line.
//
// The Messages composer (DMs, groups, #general and the other channels, and a
// reply thread) was about 75px tall at every width: 8px of card padding
// round a 40px row, then the character count's line, which is laid out even
// while empty so that the first keystroke does not push the composer up. On
// a phone that read as a tall box with a blank band under the field. Below
// 768px it is now a 44px pill: the "+", the field and the send disc on one
// row, growing only with what is typed, up to the field's existing 140px
// ceiling. The group chat's card (an app's discussion, a project's chat, a
// topic thread) is the same card and gets the same row.
//
// What this pins, in app.css and composer.tsx:
//
//   1. The phone geometry adds up: padding + row + padding = 44px, and the
//      row is the field's own height, so nothing beside it props it open.
//   2. The two buttons are drawn smaller but stay 44px tap targets, and their
//      overhang stays out of the field.
//   3. The count's line is not laid out until the text nears the limit, the
//      length it turns amber at: on a phone since #3735, and at every width
//      since #4202.
//   4. Desktop keeps the card's 8px padding round a 40px row, now with no
//      count line under it, so a Messages card is the app channel's 56px
//      (#4202); and the bar's tab-bar, home-indicator and keyboard
//      clearances are not part of the phone block.
//
// Run with: node --test tests/messages-composer-compact.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const GC_COMPOSER = read('frontend/src/features/group-chat/composer.tsx');

const TAP_TARGET = 44;
const PHONE_LINE = 44;

/** The base (all-widths) rule for `selector`, from its opening brace to its close. */
function rule(selector, from = 0) {
  const i = CSS.indexOf(`\n${selector} {`, from);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

/** The `@media (max-width: 767px)` block that follows `marker`. */
function phoneBlock(marker) {
  const at = CSS.indexOf(marker);
  assert.ok(at >= 0, `expected the ${marker} comment in app.css`);
  const open = CSS.indexOf('@media (max-width: 767px) {', at);
  assert.ok(open > at, `expected a phone media block after ${marker}`);
  return CSS.slice(open, CSS.indexOf('\n}\n', open) + 2);
}

/** The declarations of `selector` inside `block` as a { property: value } map. */
function decls(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\n\\s*${escaped} \\{([^}]*)\\}`).exec(block);
  assert.ok(m, `expected \`${selector}\` in the phone block`);
  const out = {};
  for (const part of m[1].split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

const px = (value) => {
  const n = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value).trim());
  assert.ok(n, `expected a px length, got ${value}`);
  return Number(n[1]);
};

/** [top, right, bottom, left] from a 1-4 value padding shorthand. */
function padding(value) {
  const v = String(value).split(/\s+/).map(px);
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  if (v.length === 3) return [v[0], v[1], v[2], v[1]];
  return v;
}

/**
 * [top, right, bottom, left] for a rule's declarations, written EITHER as the
 * physical shorthand or as the logical `padding-block` / `padding-inline`
 * pair the cards use now (they mirror in Arabic, so they cannot be one
 * shorthand). The four numbers are the geometry in English, which is what
 * must still add up to the 44px line and the 56px desktop card.
 */
function cardPadding(declaration) {
  if (declaration.padding) return padding(declaration.padding);
  const block = String(declaration['padding-block'] || '').split(/\s+/).filter(Boolean).map(px);
  const inline = String(declaration['padding-inline'] || '').split(/\s+/).filter(Boolean).map(px);
  assert.ok(block.length && inline.length, 'the card pads in logical block and inline pairs');
  const top = block[0];
  const bottom = block.length > 1 ? block[1] : block[0];
  const left = inline[0]; // inline-start, the left in English
  const right = inline.length > 1 ? inline[1] : inline[0]; // inline-end, the right
  return [top, right, bottom, left];
}

const MESSAGES = phoneBlock('#3735: ONE COMPACT LINE ON A PHONE');
const GC = phoneBlock('#3735: the same compact line on a phone as the Messages composer');

// ── 1. The geometry ────────────────────────────────────────────────────

test('the Messages card is one 44px line on a phone: 4px round a 36px row', () => {
  const [top, right, bottom, left] = cardPadding(decls(MESSAGES, '.messages-composer-card'));
  const field = decls(MESSAGES, '.messages-composer-input');
  const [fieldTop, , fieldBottom] = padding(field.padding);
  // The field's own height is its padding round one line of its 22px leading,
  // which the base rule keeps on a phone; min-height holds it there.
  const lineHeight = px(/line-height: (\d+px);/.exec(rule('.messages-composer-input'))[1]);
  assert.equal(fieldTop + lineHeight + fieldBottom, px(field['min-height']), 'one line fills the field exactly');
  const send = decls(MESSAGES, '.messages-send');
  const action = /\n\s*width: (\d+px);\s*\n\s*height: (\d+px);/.exec(rule('.messages-composer-action'));
  const row = Math.max(px(field['min-height']), px(send.height), px(action[2]));
  assert.equal(row, px(field['min-height']), 'no button is taller than the field, so none props the row open');
  // The "+" is inside its menu's wrapper; as a block that wrapper would set
  // the button on a text line, whose strut can be taller than the button.
  assert.equal(decls(MESSAGES, '.messages-composer-add').display, 'flex', 'the wrapper is exactly the button\'s height');
  assert.match(COMPOSER, /<div className="messages-composer-add" ref=\{addRef\}>\s*<button type="button" className="messages-composer-action"/);
  assert.equal(top + row + bottom, PHONE_LINE, 'the card is one 44px line');
  // A pill: the radius is half the line, and the send disc sits concentric
  // in its right-hand cap (its centre is the cap's centre).
  assert.match(rule('.messages-composer-card'), /border-radius: 22px;/);
  assert.equal(right + px(send.width) / 2, PHONE_LINE / 2, 'the disc is centred in the cap');
  assert.ok(left >= right, 'the bare "+" keeps at least the disc\'s inset from the curve');
});

test('the field still grows with the text, up to the ceiling it had', () => {
  const base = rule('.messages-composer-input');
  assert.match(base, /max-height: 140px;/, 'the existing max');
  assert.match(base, /overflow-y: auto;/, 'past the max it scrolls rather than clipping');
  const phone = decls(MESSAGES, '.messages-composer-input');
  assert.equal(phone.height, undefined, 'the phone block sets no fixed height on the field');
  assert.equal(phone['max-height'], undefined, 'nor a different ceiling');
  // useAutoGrow is what writes the height as the text grows.
  assert.match(COMPOSER, /useAutoGrow\(inputRef, value\);/);
  assert.match(COMPOSER, /rows=\{1\}/);
});

test('the "+", the field and the send disc are one row', () => {
  const row = COMPOSER.slice(COMPOSER.indexOf('<div className="flex items-end gap-1.5">'));
  const add = row.indexOf('className="messages-composer-action"');
  const field = row.indexOf('className="messages-composer-input"');
  const send = row.indexOf('className="messages-send"');
  assert.ok(add > 0 && add < field && field < send, 'in that order, inside the one flex row');
});

test('the group chat\'s card is the same 44px line on a phone', () => {
  const [top, right, bottom] = cardPadding(decls(GC, '.gc-composer-card'));
  const field = decls(GC, '.gc-composer-card .gc-composer-input');
  // The field's leading and inline padding come from the Textarea's
  // `composerCard` box (leading-[22px], px-1); the phone block sets the
  // block padding, which outranks py-2 by specificity, not by file order.
  assert.match(read('frontend/@/components/ui/input.tsx'), /composerCard:\s*\n\s*'[^']*leading-\[22px\]/);
  assert.equal(px(field['padding-top']) + 22 + px(field['padding-bottom']), px(field['min-height']));
  const send = decls(GC, '.gc-send');
  const glyph = /\n\s*width: (\d+px);\s*\n\s*height: (\d+px);/.exec(rule('.gc-composer-glyph'));
  const row = Math.max(px(field['min-height']), px(send.height), px(glyph[2]));
  assert.equal(top + row + bottom, PHONE_LINE);
  assert.equal(right + px(send.width) / 2, PHONE_LINE / 2);
  assert.match(GC_COMPOSER, /<form id=\{ids\.form\} className="gc-composer-card flex items-end gap-1\.5">/);
});

// ── 2. Tap targets ─────────────────────────────────────────────────────

test('the smaller buttons are still 44px tap targets, and their overhang stays off the field', () => {
  const ROW_GAP = 6; // gap-1.5
  for (const [block, buttons] of [
    [MESSAGES, ['.messages-composer-action', '.messages-send']],
    [GC, ['.gc-composer-glyph', '.gc-send']],
  ]) {
    const pseudo = new RegExp(`${buttons.map((b) => `\\${b}::after`).join(',\\s*\\n\\s*')} \\{ content: ''; position: absolute; inset: (-\\d+px); \\}`);
    const m = pseudo.exec(block);
    assert.ok(m, `${buttons.join(' and ')} carry the overhang`);
    const overhang = -px(m[1]);
    assert.match(block, new RegExp(`${buttons.map((b) => `\\${b}`).join(',\\s*\\n\\s*')} \\{ position: relative; \\}`),
      'the overhang is positioned against its own button');
    for (const button of buttons) {
      const own = button.endsWith('send') ? decls(block, button) : null;
      const size = own ? px(own.width) : px(/\n\s*width: (\d+px);/.exec(rule(button))[1]);
      assert.ok(size + 2 * overhang >= TAP_TARGET, `${button} is at least a ${TAP_TARGET}px target`);
    }
    assert.ok(overhang < ROW_GAP, 'the overhang ends inside the row gap, short of the field');
  }
  // And within the card: the overhang never reaches past its padding.
  assert.ok(Math.min(...cardPadding(decls(MESSAGES, '.messages-composer-card'))) >= 4);
});

// ── 3. The count's line ────────────────────────────────────────────────

test('at every width the count\'s line is laid out only once the text nears the limit', () => {
  // #4202: a base rule, outside any media block, so desktop hides it too.
  assert.match(CSS, /\n\.messages-composer-count:not\(\[data-near-limit\]\) \{ display: none; \}/);
  assert.doesNotMatch(MESSAGES, /messages-composer-count/, 'not restated in the phone block');
  assert.doesNotMatch(CSS, /\.messages-composer-count[^{]*\{[^}]*display: (?!none)/, 'no rule lays it out again at some width');
  // `flex` on the same element is one class; this selector is two (the class
  // and the attribute), so it wins although tailwind.css loads later.
  assert.match(COMPOSER, /const nearLimit = value\.length > 7600;/);
  assert.match(COMPOSER, /className="messages-composer-count mt-1 px-1 flex justify-end h-\[15px\]" data-near-limit=\{nearLimit \? '' : undefined\}/);
  assert.match(COMPOSER, /\$\{nearLimit \? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'\}/,
    'the same length turns it amber');
});

function composerHtml() {
  const snap = {
    route: { conversationId: 42 },
    active: { id: 42, kind: 'direct', title: 'ada', membershipStatus: 'member', myRole: 'member', members: [], memberCount: 2, canSend: true, awaitingAcceptance: false },
    messages: [], conversations: [], discussions: [],
  };
  const store = {
    channels: () => [], draftFor: () => '', notifyTyping() {}, replyFor: () => null,
    scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setReply() {},
    takePendingShare: () => undefined, useMessagesSnapshot: () => snap,
  };
  const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', {
    stubs: {
      './store': store,
      './api': {},
      '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
      '../../lib/use-auto-grow': { useAutoGrow() {} },
    },
  });
  return renderToHtml(createElement(MessageComposer, {}));
}

test('an empty composer renders the count\'s line without the near-limit mark', () => {
  const html = composerHtml();
  const count = /<div class="messages-composer-count[^"]*"[^>]*>/.exec(html);
  assert.ok(count, 'the count\'s line is still rendered (a declared check selects it), only not laid out');
  assert.doesNotMatch(count[0], /data-near-limit/);
  assert.match(html, /<div class="messages-composer-card">/);
});

test('the rendered microphone stays between the editable field and Send in the compact row', () => {
  const html = composerHtml();
  const field = html.indexOf('<textarea');
  const microphone = html.indexOf('data-dictation="idle"');
  const send = html.indexOf('class="messages-send"');
  assert.ok(field >= 0 && field < microphone && microphone < send);
  assert.equal((html.match(/data-dictation=/g) || []).length, 1, 'one microphone control per composer');
});

// ── 4. What the phone block leaves alone ───────────────────────────────

test('desktop keeps the card\'s padding and row, and is the app channel\'s height', () => {
  assert.match(rule('.messages-composer-card'), /padding-block: 8px 8px; padding-inline: 12px 8px;/);
  assert.match(rule('.messages-composer-input'), /min-height: 40px;/);
  assert.match(rule('.messages-composer-input'), /padding: 9px 4px;/);
  assert.match(rule('.messages-send'), /width: 40px;\s*\n\s*height: 40px;/);
  assert.match(rule('.gc-composer-card'), /padding-block: 8px 8px; padding-inline: 12px 8px;/);
  assert.match(rule('.gc-composer-card .gc-composer-input'), /min-height: 40px;/);
  assert.match(rule('.gc-send'), /width: 40px;\s*\n\s*height: 40px;/);
  // #4202: with the count's line gone, padding + row + padding is the whole
  // card, and the same sum for both composers.
  const height = (card, field) => {
    const text = rule(card);
    const [top, , bottom] = cardPadding({
      'padding-block': /padding-block: ([^;]+);/.exec(text)[1],
      'padding-inline': /padding-inline: ([^;]+);/.exec(text)[1],
    });
    return top + px(/min-height: (\d+px);/.exec(rule(field))[1]) + bottom;
  };
  assert.equal(height('.messages-composer-card', '.messages-composer-input'), 56);
  assert.equal(height('.gc-composer-card', '.gc-composer-card .gc-composer-input'), 56);
});

test('the bar\'s tab-bar, home-indicator and keyboard clearances are not the phone block\'s', () => {
  for (const block of [MESSAGES, GC]) {
    assert.doesNotMatch(block, /platform-safe|platform-kb|platform-tabs-h|un-kb|padding-bottom: calc/);
    assert.doesNotMatch(block, /\n\s*\.messages-composer \{|\n\s*\.messages-composer,|\.chat-composer-bar/, 'the bar round the card keeps its padding');
  }
  // The bar is the chat foot's (1 November 2026), which brings the class.
  assert.match(composerHtml(), /^<div class="messages-composer chat-composer-bar platform-safe-bar">/);
  assert.match(rule('.platform-safe-bar'),
    /padding-bottom: calc\(0\.5rem \+ max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)\) !important;/);
  assert.match(CSS, /html\.un-kb \.platform-safe-bar \{\n\s*padding-bottom: 0\.5rem !important;\n\}/);
});
