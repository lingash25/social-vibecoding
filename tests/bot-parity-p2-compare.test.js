'use strict';

// Homeroom bot parity, P2: the compare card in a design thread. The designer
// (services/design-bot.js) answers "show me them side by side" with
// compare_versions (services/design-bot-compare.js), its reply carries the
// card, Pick is decided on the server (homeroom-bot-cards/compare.js), and
// the card draws the versions small, side by side
// (frontend/src/features/messages/bot-cards/compare.tsx).
//
// Run with: node --test tests/bot-parity-p2-compare.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compare = require('../src/services/design-bot-compare');
const handler = require('../src/services/homeroom-bot-cards/compare');
const designBot = require('../src/services/design-bot');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const captured = { rootId: 9, title: 'Plots', latest: 3, versions: [{ version: 1, author: 'capture' }, { version: 2, author: 'bot' }, { version: 3, author: 'bot' }] };
const drawn = { rootId: 12, title: 'Seeds', latest: 2, versions: [{ version: 1, author: 'bot' }, { version: 2, author: 'bot' }] };

test('compare_versions: 2 or 3 of the thread\'s versions, or now beside them, made into a card', () => {
  assert.deepEqual(compare.compareCard({ design: captured, args: { versions: [2, 3], now: true, labels: ['Bigger', 'Darker'] } }), {
    card: {
      type: 'compare', v: 1, rootId: 9, title: 'Plots', picked: null,
      items: [{ version: 'now', label: 'Now' }, { version: 2, label: 'Bigger' }, { version: 3, label: 'Darker' }],
    },
  });
  assert.deepEqual(compare.compareCard({ design: captured, args: { versions: [1, 3], now: true } }).card.items,
    [{ version: 'now', label: 'Now' }, { version: 3, label: 'Version 3' }], 'with now, version 1 is the same screen');
  assert.match(compare.compareCard({ design: drawn, args: { versions: [2], now: true } }).error, /did not begin from a captured screen/);
  assert.match(compare.compareCard({ design: captured, args: { versions: [2, 9] } }).error, /There is no version 9 yet: the newest is 3\./);
  assert.equal(compare.compareCard({ design: captured, args: { versions: [2, 4] }, latest: 4 }).card.items[1].version, 4,
    'a version drawn this turn is the next number');
  assert.match(compare.compareCard({ design: captured, args: { versions: [2, 2] } }).error, /at least two different versions/);
  assert.equal(compare.compareCard({ design: captured, args: { versions: [1, 2, 3], now: true } }).card.items.length, 3);
  assert.match(compare.compareCard({ design: { ...captured, latest: 4 }, args: { versions: [2, 3, 4], now: true } }).error, /Compare at most 3 at once/);
  assert.match(compare.compareCard({ design: null, args: { versions: [1, 2] } }).error, /no screen to compare yet/);
  assert.match(compare.compareCard({ design: captured, args: { versions: ['two', 3] } }).error, /two is not a version number/);
  assert.equal(compare.compareKey('now'), 'now');
  assert.equal(compare.compareKey(' NOW '), 'now');
  assert.equal(compare.compareKey('3'), 3);
  assert.equal(compare.compareKey(0), null);
  assert.equal(compare.compareKey('x'), null);
  assert.equal(compare.TOOL.function.parameters.additionalProperties, false);
  assert.doesNotMatch(compare.TOOL.function.description, /—/);
});

test('Pick: one of the card\'s versions, on a design of theirs, patched as the card\'s pick', async () => {
  const card = compare.compareCard({ design: captured, args: { versions: [2, 3], now: true } }).card;
  const seen = [];
  const designThreads = { designFor: async (_pool, q) => { seen.push(q); return q.userId === 5 ? captured : null; } };
  assert.deepEqual(await handler.decide(null, {}, { user: { id: 5 }, card, action: 'pick', value: 3, deps: { designThreads } }),
    { ok: true, picked: 3, patch: { picked: 3 } });
  assert.deepEqual(seen[0], { userId: 5, rootId: 9 });
  assert.deepEqual((await handler.decide(null, {}, { user: { id: 5 }, card, action: 'pick', value: 'now', deps: { designThreads } })).patch, { picked: 'now' });
  assert.equal((await handler.decide(null, {}, { user: { id: 5 }, card, action: 'pick', value: 7, deps: { designThreads } })).status, 404);
  assert.equal((await handler.decide(null, {}, { user: { id: 6 }, card, action: 'pick', value: 2, deps: { designThreads } })).status, 404,
    'somebody else\'s design');
  assert.equal((await handler.decide(null, {}, { user: { id: 5 }, card, action: 'propose', value: 2, deps: { designThreads } })).status, 400);
});

test('the designer has compare_versions and make_pictures between its own tools and its offers, and says when to use them', () => {
  const names = designBot.TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ['write_screen', 'edit_design', 'list_source', 'read_source', 'reply', 'compare_versions', 'make_pictures', 'offer_plan', 'offer_project']);
  const prompt = designBot.designPrompt({
    username: 'ada', design: { surface: 'app', app: { name: 'Garden club' }, title: 'Plots', width: 390, height: 844 }, version: 2, html: '<p>x</p>',
    pictures: [{ id: 'a'.repeat(32), label: 'A · light', width: 1024, height: 1024 }, { id: 'nope', label: 'B' }],
  });
  assert.match(prompt, /When they ask to compare versions, to see them side by side, or next to how the screen looks now, call\n {2}compare_versions/);
  assert.match(prompt, /make it with make_pictures/);
  assert.match(prompt, /PICTURES THEY ADDED TO THE DESIGN \(use each as an <img> src, at its size or smaller, where they asked\):\n- Picture A · light: \/api\/conversations\/homeroom-bot\/pictures\/a{32} \(1024 by 1024\)\n\n/);
  assert.doesNotMatch(prompt, /Picture B/, 'only a picture by its id');
  assert.match(prompt, /THE CURRENT VERSION \(version 2\), its whole HTML:\n<p>x<\/p>$/, 'the version stays last');
  assert.doesNotMatch(prompt, /—/);
  const src = read('src/services/design-bot.js');
  assert.match(src, /const withCard = card && !error \? \{ card \} : \{\};/);
  assert.match(src, /withCard\.card \? \{ metadata: \{ kind: 'chat', \.\.\.withCard \} \} : \{\}/, 'a reply with no new version carries it');
  assert.match(src, /designTitle: held\.title, \.\.\.withCard,/, 'a version\'s message carries it too');
  assert.match(src, /offered: !!offered \|\| !!card/, 'a card is an answer: no nudge to draw');
});

// ── The card ──────────────────────────────────────────────────────────────

function loadCompare({ said = [], decided = [], reads = [] } = {}) {
  return loadTsx('frontend/src/features/messages/bot-cards/compare.tsx', {
    stubs: {
      './index': {
        sayAsMe: async (_m, words) => { said.push(words); },
        decideCard: async (_m, action, value) => { decided.push([action, value]); return {}; },
      },
      '../design-card': {
        readDesign: (...args) => { reads.push(['design', ...args]); return new Promise(() => {}); },
        readVersion: (...args) => { reads.push(['version', ...args]); return new Promise(() => {}); },
      },
      '../design-pane': { ProposeCard: () => null },
      '../../ai/preview': { openPreview: () => {} },
    },
  });
}

test('the compare card: its items read defensively, small previews side by side, a size switch and Pick under each', () => {
  const reads = [];
  const mod = loadCompare({ reads });
  const card = { type: 'compare', v: 1, rootId: 9, items: [{ version: 'now', label: 'Now' }, { version: 2, label: 'Bigger' }, { version: 2 }, { version: 'x' }, { version: 3 }], picked: 2 };
  assert.deepEqual(mod.compareItems(card), [
    { key: 'now', version: 1, label: null }, { key: 2, version: 2, label: 'Bigger' }, { key: 3, version: 3, label: null },
  ].slice(0, 2), 'at most three entries are read, a repeat and a bad one dropped');
  assert.deepEqual(mod.compareBox({ width: 390, height: 844 }, 'phone'), { frame: { width: 390, height: 844 }, width: 140, height: 240, scale: 140 / 390 });
  assert.deepEqual(mod.compareBox({ width: 390, height: 844 }, 'desktop'), { frame: { width: 1280, height: 800 }, width: 240, height: 150, scale: 240 / 1280 });
  assert.equal(mod.sizeOf({ width: 1280 }), 'desktop');
  assert.equal(mod.sizeOf(null), 'phone');
  const html = renderToHtml(createElement(mod.CompareCard, { message: { id: 1 }, conversationId: 4, card: { ...card, items: card.items.slice(0, 2).concat([{ version: 3, label: 'Darker' }]) } }));
  assert.deepEqual(reads, [], 'nothing is read in the first render');
  assert.match(html, /data-bot-compare="9"/);
  assert.match(html, new RegExp(`>${message('messages:botCards.compare.heading')}<`));
  assert.match(html, /data-bot-compare-size="phone"/);
  assert.match(html, /data-bot-compare-size="desktop"/);
  assert.equal((html.match(/data-bot-compare-item=/g) || []).length, 3);
  assert.match(html, new RegExp(`>${message('messages:botCards.compare.now')}<`));
  assert.match(html, />Bigger</);
  assert.match(html, /data-bot-compare-pick="now"/);
  assert.match(html, new RegExp(`class="messages-bot-done"[^>]*data-bot-compare-pick="2"`), 'the one picked is done, grey');
  assert.doesNotMatch(html, /<iframe/, 'the frames wait for their versions');
  assert.doesNotMatch(html, /data-bot-compare-propose/, 'Propose waits for the design to be read');
  assert.equal(renderToHtml(createElement(mod.CompareCard, { message: { id: 1 }, conversationId: 4, card: { type: 'compare', rootId: 9, items: [{ version: 2 }] } })), '');
  const src = read('frontend/src/features/messages/bot-cards/compare.tsx');
  assert.match(src, /sandbox=\{DESIGN_SANDBOX\}/, 'the design card\'s own frame');
  assert.match(src, /await decideCard\(message, 'pick', item\.key\);/);
  assert.match(src, /t\('messages:botCards\.compare\.pickWords', \{ version: item\.version \}\)/);
  assert.match(src, /<ProposeCard design=\{design\} version=\{pickedVersion\}/, 'the design pane\'s own Propose it');
  assert.match(read('frontend/src/features/messages/design-pane.tsx'), /export function ProposeCard\(/);
  assert.equal(message('messages:botCards.compare.pickWords', { version: 3 }), 'Pick version 3');
  assert.doesNotMatch(src, /\b(?:gray|indigo)-\d/);
  assert.doesNotMatch(src, /—/);
});

test('a design\'s pictures are written into its frame from the page, where the chat\'s sign-in reaches them', async () => {
  const pics = loadTsx('frontend/src/features/design/pictures.ts');
  const id = 'b'.repeat(32);
  assert.deepEqual(pics.pictureIds(`<img src="/api/conversations/homeroom-bot/pictures/${id}"><img src="https://h.test/api/conversations/homeroom-bot/pictures/${id}">`), [id]);
  const fetched = [];
  global.fetch = async (url) => { fetched.push(url); return new Response(new Blob([Buffer.from('x')], { type: 'image/png' })); };
  global.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,eA=='; this.onload(); } };
  try {
    const out = await pics.inlinePictures(`<img src="https://h.test/api/conversations/homeroom-bot/pictures/${id}"> <img src='/api/conversations/homeroom-bot/pictures/${id}'>`);
    assert.equal(out, '<img src="data:image/png;base64,eA=="> <img src=\'data:image/png;base64,eA==\'>');
    assert.deepEqual(fetched, [`/api/conversations/homeroom-bot/pictures/${id}`]);
    assert.equal(await pics.inlinePictures('<p>no pictures</p>'), '<p>no pictures</p>');
  } finally {
    delete global.fetch;
    delete global.FileReader;
  }
  for (const file of ['frontend/src/features/messages/design-card.tsx', 'frontend/src/features/messages/design-pane.tsx']) {
    assert.match(read(file), /inlinePictures\(v\.html\)/, file);
  }
});
