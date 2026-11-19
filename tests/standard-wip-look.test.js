// Standard (WIP): the standard look with the changes still being tried on it
// (frontend/src/lib/skin.ts 'wip'). Three rules keep it the standard look and
// keep its drawing in one system; app.css's "STANDARD (WIP)" block states
// them and this file holds them.
//
//   1. It is not a copy. The head sets `data-skin-wip` and no `data-skin`, so
//      every screen is the standard one and a feature added to Standard is
//      under this look too.
//   2. Every value in its block is a token: colours are written once, in the
//      block's first rule, and nowhere after it.
//   3. Nothing of the standard look is hidden under it except what WIP_HIDES
//      lists, each a decision somebody made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

/** What Standard (WIP) deliberately does not display, by selector. */
const WIP_HIDES = [
  // Home's Recent threads rows carry no "Request #8" line under the look (asked 19 Nov 2026).
  'html[data-skin-wip] #home-needs-card .wip-item-kind',
  // With the sidebar open, Homeroom's logo is the panel's brand, so the top bar does not repeat it (asked 19 Nov 2026).
  'html[data-skin-wip] body:has(> #platform-tabs:not(.hidden):not(.platform-tabs-route-hidden):not(.platform-tabs-folded)) #platform-header #header-title > span:has(> span > #header-title-name > svg)',
  // Home has no Pinned communities section under the look.
  'html[data-skin-wip] #home-communities-section',
  // A pinned project's tile has no description under the look (asked 19 Nov 2026).
  'html[data-skin-wip] #app-list .app-card-desc',
  // Under 1024px a project's tile is its icon and name alone.
  'html[data-skin-wip] #app-list .app-card-people',
  // A project's hub has no Topics card under the look (asked 18 Nov 2026).
  'html[data-skin-wip] #dev-workshop [data-ws-hub-topics]',
  // The board is by stage alone under the look (asked 18 Nov 2026): no By category / By stage switch.
  'html[data-skin-wip] #dev-workshop :is(.dev-ws-group)',
  // A board card's category tag shows in Advanced mode only (asked 18 Nov 2026).
  'html[data-skin-wip][data-interface-mode="basic"] #dev-kanban [data-attr-field="category"]',
  // The Workshop's door opens the board under the look, so the board has no "‹ All items" line of its own.
  'html[data-skin-wip] #dev-workshop .dev-ws[data-ws-tab="all"] .dev-ws-pagehead',
  // For you's label heads the vote line alone on the hub, so it goes when there is no vote line.
  'html[data-skin-wip] #dev-workshop [data-ws-hub-for-you]:not(:has(> .dev-ws-foryou > :is(.dev-ws-week-note, [data-ws-hub-needs]))) > :first-child',
  // A pinned app's tile does not say when it was last opened under the look: its tiles say less (#4025).
  'html[data-skin-wip] #app-list .app-card-opened',
];

function wipBlock() {
  const css = read('public', 'css', 'app.css');
  const start = css.indexOf('STANDARD (WIP): the standard look');
  const end = css.indexOf('END OF STANDARD (WIP).');
  assert.ok(start > 0 && end > start, 'app.css has the Standard (WIP) block, start to end');
  // From the end of the block's own opening comment to the start of the next block's.
  const from = css.indexOf('*/', start) + 2;
  const to = css.lastIndexOf('/*', end);
  return css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { body }` of the block, media queries flattened. */
function rules(block) {
  const out = [];
  const flat = block.replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** A selector list's members: split on the commas outside every bracket. */
function topLevel(selector) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(selector.slice(from, i)); from = i + 1; }
  }
  out.push(selector.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

test('it is the standard look: the head sets data-skin-wip and no data-skin', () => {
  const head = read('frontend', 'src', 'head.html');
  assert.match(head, /if \(skin === 'wip'\) root\.setAttribute\('data-skin-wip', ''\);/);
  assert.match(head, /if \(skin !== 'standard' && skin !== 'wip'\) \{\s*root\.setAttribute\('data-skin', skin\);/,
    'no look\'s rules (html[data-skin] …) apply under it');
  const skin = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.equal(skin.isFrameSkin('wip'), false, 'it keeps the standard pages, not the frame\'s');
});

test('every rule of its block is scoped to the look or is a component of its kit', () => {
  for (const { selector } of rules(wipBlock())) {
    for (const one of topLevel(selector)) {
      assert.match(one, /data-skin-wip|^\.wip-|^\.app-card-(desc|people)$/, `"${one}" would restyle the standard look`);
    }
  }
});

test('colours are written once, as tokens in the block\'s first rule', () => {
  const all = rules(wipBlock());
  // The token rules: the look's own (the config called Current) and each other config's, in light and dark.
  const tokens = all.filter((r) => /^html\[data-skin-wip\](\[data-wip-tokens="[a-z0-9]+"\])?(\.dark)?$/.test(r.selector) && /--wip-/.test(r.body));
  assert.ok(tokens.length >= 1, 'the block declares its tokens');
  const declared = new Set();
  for (const r of tokens) for (const m of r.body.matchAll(/(--wip-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
  for (const r of all) {
    if (tokens.includes(r)) continue;
    // The filled action's inner edge is the one literal: a white hairline on its own gradient.
    const body = r.selector === '.wip-cta' ? r.body.replace(/inset 0 0 0 1px rgb\(255 255 255 \/ 0\.2\)/, '') : r.body;
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${r.selector} writes a colour of its own; make it a --wip-* token`);
    for (const m of r.body.matchAll(/var\((--wip-[a-z0-9-]+)/g)) {
      assert.ok(declared.has(m[1]), `${m[1]} (used by ${r.selector}) is declared in the block's first rule`);
    }
  }
});

test('nothing of the standard look is hidden under it but what WIP_HIDES lists', () => {
  const hidden = rules(wipBlock())
    .filter((r) => /display:\s*none|visibility:\s*hidden/.test(r.body))
    // A kit component arranging its own parts (an icon stack a phone has no room for) hides nothing of Standard.
    .filter((r) => !topLevel(r.selector).every((one) => /^\.wip-/.test(one)))
    .map((r) => r.selector);
  assert.deepEqual(hidden.sort(), [...WIP_HIDES].sort(),
    'a section the look stops displaying is a decision: add it to WIP_HIDES with its reason');
});

test('Home places what it does not name last, so a new standard section is drawn', () => {
  const block = wipBlock();
  assert.match(block, /html\[data-skin-wip\] #home-screen \.home-main > \* \{ order: 4; \}/);
});

test('its pieces come from the kit, not from classes spelled in place', () => {
  const kit = read('frontend', 'src', 'features', 'home', 'wip-kit.tsx');
  for (const name of ['WipCard', 'WipCta', 'WipHeadMore']) assert.match(kit, new RegExp(`export (function|const) ${name}\\b`));
  const island = read('frontend', 'src', 'features', 'home', 'index.tsx');
  assert.match(island, /<WipCard on=\{wip\}>/);
  assert.match(island, /<WipCta id="home-new-project-top"/);
  assert.doesNotMatch(island, /bg-gradient-to-br/, 'the filled action\'s gradient is the kit\'s, from tokens');
});
