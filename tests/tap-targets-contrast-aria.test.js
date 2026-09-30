'use strict';

// QA 2026-09-24, Q19 and Q20: phone tap targets under 32px, small text under
// WCAG AA contrast, and a handful of ARIA structure faults, all found by an
// automated audit (axe plus a hit-test sweep at 390px).
//
// These are static assertions over source text, the cheap half: they pin the
// spellings that fixed each finding, so a later edit that drops one fails here
// rather than in the next sweep. The contrast half does real arithmetic on the
// token values it reads out of the sources, so a token nudged back under 4.5:1
// fails too, whatever it is nudged to.
//
// Run with: node --test tests/tap-targets-contrast-aria.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/css/app.css');

// ── WCAG 2 contrast, on #rrggbb ─────────────────────────────────────────

function rgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** `fg` at `alpha` over `bg`, as #rrggbb — a translucent tint's painted colour. */
function over(fg, alpha, bg) {
  const f = rgb(fg);
  const g = rgb(bg);
  return '#' + g.map((c, i) => Math.round(c * (1 - alpha) + f[i] * alpha).toString(16).padStart(2, '0')).join('');
}

/** A `{ ... }` block's body, starting at the first match of `marker`. */
function block(marker, from = 0) {
  const i = CSS.indexOf(marker, from);
  assert.ok(i >= 0, `expected ${marker} in app.css`);
  const open = CSS.indexOf('{', i);
  return CSS.slice(open, CSS.indexOf('\n}', open));
}
function token(body, name) {
  const m = body.match(new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
  assert.ok(m, `expected ${name} as a hex colour`);
  return m[1].toLowerCase();
}

const LIGHT = block(':root {');
const DARK = block('.dark {');

// ── Q20: contrast ───────────────────────────────────────────────────────

test('Q20: the muted ink clears 4.5:1 on the raised surfaces it sits on, in both themes', () => {
  const lightMuted = token(LIGHT, '--text-muted');
  const darkMuted = token(DARK, '--text-muted');
  // Light: the theme toggle's idle segments sit on the zinc-100 track.
  assert.ok(contrast(lightMuted, '#eaeaea') >= 4.5, `${lightMuted} on #eaeaea`);
  // Dark: the Workshop tabs, the Messages filter track, the theme toggle and
  // the category cards all sit on --bg-tertiary.
  const darkRaised = token(DARK, '--bg-tertiary');
  assert.ok(contrast(darkMuted, darkRaised) >= 4.5, `${darkMuted} on ${darkRaised}`);
  // Still a secondary ink: quieter than --text-secondary in both themes.
  assert.ok(contrast(lightMuted, '#ffffff') < contrast(token(LIGHT, '--text-secondary'), '#ffffff'));
  assert.ok(contrast(darkMuted, '#0b0b0c') < contrast(token(DARK, '--text-secondary'), '#0b0b0c'));
});

test('Q20: an app tone carries the same muted ink as the theme it stands in for', () => {
  // app-tone.test.js pins the brand tokens' parity; the muted ink moved in
  // this change, so its two tone copies are pinned to the theme blocks here.
  const darkTone = block('[data-app-tone="dark"]:not(.dark) #platform-header,');
  const lightTone = block('.dark[data-app-tone="light"] #platform-header,');
  assert.equal(token(darkTone, '--text-muted'), token(DARK, '--text-muted'));
  assert.equal(token(lightTone, '--text-muted'), token(LIGHT, '--text-muted'));
});

test('Q20: the card band labels read on the accent tint', () => {
  const ink = token(LIGHT, '--accent-tint-ink');
  const accent = token(LIGHT, '--accent');
  const tint = over(accent, 0.08, '#ffffff');
  assert.ok(contrast(ink, tint) >= 4.5, `${ink} on ${tint}`);
  const darkInk = token(DARK, '--accent-tint-ink');
  assert.equal(darkInk, token(DARK, '--accent'), 'dark keeps the accent itself, which already passed');
  const band = block('\n:is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn {');
  assert.match(band, /color: var\(--accent-tint-ink\);/);
  const hover = block('\n:is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn:hover {');
  assert.match(hover, /color: var\(--accent-tint-ink\);/, 'and hover keeps the same ink');
});

test('Q20: the Workshop count chips and the GitHub tag clear AA', () => {
  // --state-neutral-bg over a dark category card measures #3e3f43.
  const chip = CSS.match(/\n\.dark \.dev-ws-cnt \{ color: (#[0-9a-f]{6}); \}/);
  assert.ok(chip, 'the dark chip label has its own ink');
  assert.ok(contrast(chip[1], '#3e3f43') >= 4.5, `${chip[1]} on #3e3f43`);
  const tag = block('\n.dev-topic-gh-tag {');
  assert.match(tag, /background: color-mix\(in srgb, var\(--bg-tertiary\) 60%, transparent\);/);
  // The tag rides a --bg-primary bubble: 60% of --bg-tertiary over it.
  const lightBg = over(token(LIGHT, '--bg-tertiary'), 0.6, token(LIGHT, '--bg-primary'));
  const darkBg = over(token(DARK, '--bg-tertiary'), 0.6, token(DARK, '--bg-primary'));
  assert.ok(contrast(token(LIGHT, '--text-muted'), lightBg) >= 4.5, `light tag ${lightBg}`);
  assert.ok(contrast(token(DARK, '--text-muted'), darkBg) >= 4.5, `dark tag ${darkBg}`);
});

test('Q20: the bell badge, the Discover meta line and the list subtitles use the passing shades', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  const badge = header.match(/id="notifications-badge"[\s\S]*?className="([^"]+)"/);
  assert.ok(badge, 'the bell badge renders');
  assert.match(badge[1], /\bbg-red-600\b/, 'white 10.4px on red-500 was 3.76:1');
  assert.ok(contrast('#ffffff', '#dc2626') >= 4.5, 'red-600 carries white text');

  const discover = read('frontend/src/features/home/panels/discover.tsx');
  assert.match(discover, /className="home-discover-meta [^"]*\btext-zinc-600 dark:text-zinc-400"/,
    'the meta line takes the blurb\'s ink on the pastel tints');

  const list = read('frontend/@/components/ui/grouped-list.tsx');
  assert.match(list, /cn\('mt-0\.5 truncate text-\[0\.8125rem\] leading-\[1\.125rem\] text-zinc-500 dark:text-zinc-400', subtitleClassName\)/,
    'a list row\'s subtitle is zinc-400 in dark, not zinc-500 (3.54:1 on the page)');
});

// ── Q19: tap targets ────────────────────────────────────────────────────

test('Q19: the dense-row hit-slop helper is the kit\'s trick at 32px, on touch only', () => {
  const at = CSS.indexOf('@media (pointer: coarse) {\n  :where(.touch-target-32) { position: relative; }');
  assert.ok(at > 0, 'a coarse-pointer block defines .touch-target-32');
  const body = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(body, /\.touch-target-32::after \{[\s\S]*?width: max\(100%, 32px\);[\s\S]*?height: max\(100%, 32px\);/);
});

test('Q19: each small control named by the audit wears a hit-slop', () => {
  const has = (file, re, why) => assert.match(read(file), re, why);
  const KIT = 'un-touch-target';
  has('frontend/src/features/dev-board/topic/topic-head.tsx', new RegExp(`className="voting-help-link ${KIT}"`), 'How voting works');
  has('frontend/src/features/dev-board/topic/topic-head.tsx', new RegExp(`className="voting-help-btn ${KIT}"`), 'the ? beside it');
  has('frontend/src/features/dev-board/card/fold.tsx', new RegExp(`className="dev-fold-mark ${KIT}" data-open="1"`), 'Fold the card');
  const ws = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  // "Show past week" went with the walk: the weeks head the since list now,
  // and Show older below them steps back a week.
  has('frontend/src/features/dev-board/workshop/since-summary-card.tsx', new RegExp(`className="dev-ws-since-card-x ${KIT}"`), 'the summary\'s ×');
  has(ws, new RegExp(`className="dev-ws-reveal dev-ws-since-more ${KIT}"`), 'Show older');
  has(ws, new RegExp(`className="dev-ws-since-clear ${KIT}"`), 'Clear');
  // "N more of yours" is gone: the Workshop tab shows your own work in full.
  has(ws, new RegExp(`className="dev-ws-hub-open dev-ws-head-end ${KIT}"`), 'All items\' See all');
  has('frontend/src/features/dev-board/workshop/page-back.tsx', new RegExp(`className="dev-ws-page-back ${KIT}"`), 'the way back from a page to the hub');
  has('frontend/src/features/dev-board/workshop/hub-cards.tsx', new RegExp(`className="dev-ws-hub-open ${KIT}"`), 'the channel\'s Open');
  has('frontend/src/features/dev-board/workshop/hub-cards.tsx', new RegExp(`className="dev-ws-link ${KIT}" onClick=\\{onOpen\\} data-ws-hub-needs-requests`), 'the requests nobody has picked up, the hub\'s way into Needs you when no vote is owed (#3408)');
  const ui = 'frontend/src/features/home/panels/ui.tsx';
  has(ui, new RegExp(`className="home-panel-browse [^"]*${KIT}"`), 'Browse all apps');
  has(ui, new RegExp(`className="home-panel-lb-browse [^"]*${KIT}"`), 'Open challenges');
  has(ui, new RegExp(`className="home-panel-expand [^"]*${KIT}"`), 'See all N challenges');
  has('frontend/src/features/home/panels/discover.tsx', new RegExp(`card-add-btn absolute [^$]*${KIT} \\$\\{`), 'the Discover +');
  for (const f of ['grants-list.tsx', 'app-permissions-list.tsx', 'cli-tokens-list.tsx']) {
    has(`frontend/src/features/settings/${f}`, /bg-red-50 [^"]*touch-target-32"/, `Revoke in ${f}`);
  }
  const files = read('frontend/src/features/settings/agent-files-list.tsx');
  assert.equal((files.match(/font-medium touch-target-32"/g) || []).length, 2, 'agent files View and Delete');
  // Each row's View and Delete name their file, and View says whether it is
  // open and which <pre> it opens (tests/agent-files-list-aria.test.js renders it).
  assert.match(files, /aria-expanded=\{open\}/, 'agent files View reports open');
  assert.match(files, /aria-controls=\{contentId\}/, 'agent files View points at its content');
  assert.match(files, /aria-label=\{`\$\{open \? 'Hide' : 'View'\} \$\{file\.name\}`\}/, 'agent files View names its file');
  assert.match(files, /aria-label=\{`Delete \$\{file\.name\}`\}/, 'agent files Delete names its file');
});

test('Q19: where a slop cannot hang off the control, the control or its row grows on touch', () => {
  // The card band clips at one row, so its pills cannot carry an overhang.
  const band = CSS.indexOf('@media (pointer: coarse) {\n  :is(.dev-card-dense, .dev-card-topic) .gc-card-actions { min-height: 32px; max-height: 32px; }');
  assert.ok(band > 0, 'the band is 32px on a coarse pointer');
  const bandBody = CSS.slice(band, CSS.indexOf('\n}\n', band));
  assert.match(bandBody, /\.gc-card-actions > :is\(\.gc-vote-btn, \.dev-vote-btn\),[\s\S]*?\{ height: 32px; \}/);
  assert.match(bandBody, /\.gc-card-actions > \.dev-card-menu-btn \{ width: 32px; \}/);
  // A <select> draws no ::after.
  assert.match(CSS, /@media \(pointer: coarse\) \{\n  \.dc-model-select \{ min-height: 32px; \}\n\}/);
  // The agent-session composer's shown-line picker (a span under a
  // transparent select) is gone: its model pill is a 40px button.
  assert.doesNotMatch(CSS, /span\.dc-model-select/);
});

test('Q19: chip and Save slops never cover a neighbour\'s own box', () => {
  // Chips wrap into rows a few px apart: the slop sits UNDER the chips, in
  // the isolated row's own stacking context.
  const chips = CSS.slice(CSS.indexOf('  :is(.dev-card-meta, .dev-topic-hero-chips) { isolation: isolate; }'));
  assert.ok(chips.length < CSS.length, 'the chip rows are isolated');
  assert.match(chips, /button\.attr-chip::after \{[\s\S]*?z-index: -1;[\s\S]*?height: max\(100%, 32px\);/);
  // The Save mark follows a vote row's No button 4px away: it reaches back no
  // further than that margin.
  const save = CSS.slice(CSS.indexOf('  .gc-msg-save::after {'));
  assert.match(save, /^ {2}\.gc-msg-save::after \{[\s\S]*?left: -4px;[\s\S]*?height: max\(100%, 32px\);/);
});

// ── Q20: ARIA structure ─────────────────────────────────────────────────

test('Q20: form controls the audit found unnamed have names', () => {
  const waitlist = read('frontend/src/features/auth/waitlist.tsx');
  assert.match(waitlist, /<label className=\{SURVEY_LABEL\} htmlFor="waitlist-country">\s*Country/,
    'the Country label points at its select');
  assert.match(waitlist, /id="waitlist-country"/);
  const connectors = read('frontend/src/features/settings/sections/connectors.tsx');
  assert.match(connectors, /id="settings-dev-flow"\n\s*aria-label="Where changes get built"/,
    'the dev-flow select is named after its heading');
});

test('Q20: the setup guide\'s scrolling code blocks are focusable, named regions', () => {
  const guide = read('frontend/src/features/settings/cli-setup-guide.tsx');
  assert.match(guide, /<pre\n\s*tabIndex=\{0\}\n\s*role="region"\n\s*aria-label=\{label\}/);
  assert.match(guide, /focus-visible:ring-2/, 'with a visible focus ring');
});

test('Q20: the kit modal shell takes its name from the dialog\'s heading', () => {
  const modal = read('frontend/src/lib/static-modal.ts');
  assert.match(modal, /adoptionRef\.current = present\(root, dismissFromKit, stillOwns\);\n\s*nameKitShell\(adoptionRef\.current\);/);
  const fn = modal.slice(modal.indexOf('function nameKitShell('));
  assert.match(fn, /querySelector\('h1, h2, h3'\)/);
  assert.match(fn, /if \(heading\.id\) shell\.setAttribute\('aria-labelledby', heading\.id\);/);
  const create = read('frontend/src/features/dialogs/create-app.tsx');
  assert.match(create, /<h2 id="create-title"/, 'Create app\'s heading has the id the shell points at');
});

test('Q20: the app frame is titled with the app\'s name, and keeps it when kept alive', async () => {
  const storeMod = await import(
    new URL('../frontend/src/features/app-frame/app-frame-store.js', `file://${__filename}`).href
  );
  const { appFrameBridge: bridge } = await import(
    new URL('../frontend/src/features/app-frame/app-frame-bridge.js', `file://${__filename}`).href
  );
  const store = storeMod.appFrameStore;
  assert.equal(store.get().title, '', 'no frame, no name');
  // Named by the launch cover.
  bridge.mount({ slug: 'a', cover: { name: 'Alpha' } });
  assert.equal(store.get().title, 'Alpha');
  // A remount of the same app without a name keeps the one it had.
  bridge.mount({ slug: 'a', faded: false });
  assert.equal(store.get().title, 'Alpha');
  // The plain render names it explicitly.
  store.set({ navigatedAt: Date.now() });
  bridge.mount({ slug: 'b', faded: false, title: 'Beta' });
  assert.equal(store.get().title, 'Beta');
  const kept = store.get().kept.find((k) => k.slug === 'a');
  assert.ok(kept, 'the first app is kept alive behind the second');
  assert.equal(kept.title, 'Alpha', 'and its hidden frame keeps its name');
  bridge.evictAll();
  assert.equal(store.get().title, '');

  const frame = read('frontend/src/features/app-frame/app-frame.tsx');
  assert.match(frame, /title=\{look\.title \|\| undefined\}/, 'the island renders it');
  assert.match(read('public/js/app-view.js'),
    /frame\.mount\(\{ slug: appData\.slug, faded: false, title: appData\.name \|\| '' \}\)/);
});
