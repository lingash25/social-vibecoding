// The Homeroom menu is a POPOVER under the mark on desktop (#2784).
//
// #apps-switcher-sheet is one always-mounted element with three
// presentations, all of them decided in app.css: a kit bottom sheet on touch,
// a CSS bottom sheet below `sm`, and at `sm`+ for a mouse a popover hanging
// under the Homeroom mark that opened it. That last one has moved twice: from
// a full-height right-edge rail to a dropdown centred under the header's
// title chip, and — once the trigger moved from the chip to the mark at the
// far right of the bar — from the middle of the screen, dimming the page, to
// right under the mark with no dim, the way the dev board's vote popover
// hangs off its button. The research behind that last move (how mini-app
// hosts present their platform menu) is in the #2784 proposal.
//
// Nothing about the markup changed, which is the point — these pin the CSS
// contract, the one measurement the island makes, and the traps in it:
//
//   1. A popover cannot hide by sliding off an edge (it has none, and it
//      paints above the header), so the closed state is opacity +
//      visibility. `.platform-sheet-adopted` flattens transform, position,
//      border and shadow but NOT those two — so a touch device wider than
//      639px, which matches the desktop rule and the kit adoption at once,
//      would present an invisible sheet without an explicit reset.
//   2. Where the mark is depends on the header's layout, so the popover is
//      placed from the mark's measured rect — through lib/anchor-popover.ts,
//      the arithmetic the vote popover uses — not from restated geometry.
//   3. No dim at `sm`+, and the backdrop lets the pointer through there, or
//      every outside click (the bell included) would be a dead click. Below
//      `sm` it is still a bottom sheet and its backdrop still dismisses it.
//
// And the fallback offset is the header's own height, restated once as
// --platform-header-h, which is only worth having if it cannot drift from the
// markup it describes. The first test is what makes that true.
//
// Run with: node --test tests/app-switcher-dropdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const ISLAND = read('frontend/src/features/app-context/index.tsx');
const VOTE = read('frontend/src/features/dev-board/card/dev-card.tsx');

/** A Tailwind spacing step in px — the scale is 0.25rem per unit. */
const step = (n) => n * 4;

/** A rule's body, by exact selector text. */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

/**
 * Every `@media (<condition>)` block in the file. There are many of each —
 * `sm` is the shell's one phone/desktop line, so both conditions recur — which
 * is why nothing here takes the first one it finds.
 *
 * Blocks are two levels deep at most, so the first bare `}` at column 0 closes
 * the media query.
 */
function mediaBlocks(condition) {
  const needle = `@media (${condition}) {`;
  const out = [];
  let at = 0;
  for (;;) {
    at = CSS.indexOf(needle, at);
    if (at < 0) break;
    const end = CSS.indexOf('\n}\n', at);
    assert.ok(end > at, `an \`@media (${condition})\` block is unclosed`);
    out.push(CSS.slice(at, end));
    at = end;
  }
  assert.ok(out.length > 0, `expected at least one \`@media (${condition})\` block`);
  return out;
}

/** The single block at `condition` that carries `needle`. */
function blockWith(condition, needle) {
  const hit = mediaBlocks(condition).filter((b) => b.includes(needle));
  assert.equal(hit.length, 1,
    `exactly one \`@media (${condition})\` block should own \`${needle}\``);
  return hit[0];
}

/** The one desktop block that positions the switcher sheet. */
function switcherDesktopBlock() {
  return blockWith('min-width: 640px', '#apps-switcher-sheet {');
}

// ── The offset is the header's own height ──────────────────────────────

test('--platform-header-h is the height the header markup actually builds', () => {
  // Declared once, in the first `:root` block — there are four of them in
  // this file, so the declaration is what is searched for, not a block.
  const declared = CSS.match(/^\s*--platform-header-h:\s*([\d.]+)rem;$/m);
  assert.ok(declared, ':root declares --platform-header-h in rem');

  // The bar is a flex row: `py-N` top and bottom around a 28px content row.
  // Read the padding out of the markup rather than restating it, so changing
  // it fails HERE rather than as a panel that has quietly drifted off the bar
  // it hangs from. No hairline — the reskin took the border off both top bars,
  // and one coming back would add a pixel to the border box.
  //
  // THE TWO PADDINGS ARE READ SEPARATELY. The bar was `py-3`; it is
  // `pt-2 pb-4` now (#2305), because `-mb-2` spends 8px of the bottom padding
  // cutting the notch below it and the controls were left with four pixels
  // of clearance above an app's raised sheet. A single `py-N` read would
  // have gone on matching nothing and silently reported the old height.
  const bar = HEADER.slice(HEADER.indexOf('id="platform-header"'));
  const className = bar.slice(0, bar.indexOf('>'));
  const pt = className.match(/\bpt-(\d+)\b/);
  const pb = className.match(/\bpb-(\d+)\b/);
  assert.ok(pt && pb, '#platform-header states its vertical padding as pt-N / pb-N');
  assert.ok(!/\bpy-\d/.test(className),
    'and states it in ONE vocabulary — a py-N beside them is a second source '
    + 'of truth this arithmetic cannot see');
  assert.ok(!/\bborder-b\b/.test(className),
    'no hairline under the bar — if one comes back this arithmetic gains a pixel');

  // The content row is 28px = `h-7`, held open from both directions by the
  // rules tests/header-height-parity.test.js owns (a floor that survives every
  // child being hidden, and a ceiling no direct child may exceed). All this
  // needs from that file is that the row is still stated in h-7 terms.
  assert.match(HEADER, /\bh-7\b/,
    'the header still states its content row as h-7 — see '
    + 'tests/header-height-parity.test.js for the floor and the ceiling');

  // Tailwind's scale is 0.25rem per step; h-7 is 1.75rem.
  const expected = ((Number(pt[1]) + Number(pb[1])) * 0.25) + 1.75;
  assert.equal(Number(declared[1]), expected,
    `--platform-header-h must equal pt-${pt[1]} + pb-${pb[1]} + h-7 = ${expected}rem`);
});

// ── The popover ────────────────────────────────────────────────────────

/** The closed-state rule of the desktop block. */
function desktopClosed() {
  const block = switcherDesktopBlock();
  return block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));
}

test('the desktop presentation is anchored under the mark, not centred on the page', () => {
  const closed = desktopClosed();
  assert.match(closed,
    /top:\s*var\(--menu-anchor-top,\s*calc\(var\(--platform-header-h\)\s*\+\s*var\(--platform-safe-top\)\)\)/,
    'placed from the measured anchor, falling back to the underside of the bar');
  assert.match(closed, /inset-inline-start:\s*var\(--menu-anchor-left,/,
    'and from the measured inline start, which aligns it with the mark in either direction');
  assert.doesNotMatch(closed, /inset-inline-start:\s*50%/,
    'no longer centred on the viewport under a title chip that is not the trigger');
  assert.doesNotMatch(closed, /translate\(-50%/, 'and no centring transform');
  assert.match(closed, /inset-inline-end:\s*auto/, 'the end edge does not pin it…');
  assert.match(closed, /bottom:\s*auto/, '…and neither does the floor: it is content-height');
  assert.match(closed, /max-height:\s*calc\(100dvh - var\(--menu-anchor-top/,
    'capped against the fold from where it actually starts, with #switcher-nav '
    + 'taking the overflow');
  assert.match(closed, /border-radius:/, 'a floating panel has corners on all four sides');
  assert.doesNotMatch(closed, /border-left-width/,
    'a rail borders one edge; a popover borders all of them');
  assert.match(closed, /transform-origin:\s*top right/,
    'it grows out of the corner under the mark');

  // The title-chip follow rule is gone with the chip as the trigger.
  assert.doesNotMatch(switcherDesktopBlock(), /header-title/,
    'nothing about the menu depends on where the title sits any more');
});

test('closed is opacity + visibility, because there is no edge to hide behind', () => {
  const block = switcherDesktopBlock();
  const closed = block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));
  const open = block.slice(block.indexOf('#apps-switcher-sheet[data-open] {'));

  assert.match(closed, /opacity:\s*0/);
  assert.match(closed, /visibility:\s*hidden/,
    'opacity alone leaves a 320px click-eater over the page');
  assert.match(open, /opacity:\s*1/);
  assert.match(open, /visibility:\s*visible/);

  // Visibility is not interpolable, so it is stepped: after the fade on the
  // way out, before it on the way in.
  assert.match(closed, /visibility 0s linear 1\d\dms/,
    'the closed rule delays visibility until the fade has finished');
  assert.match(open, /visibility 0s linear 0s/,
    'the open rule applies it immediately, or the fade-in is invisible');
});

test('a kit-adopted sheet is never left invisible by the dropdown state', () => {
  // THE TABLET TRAP. `.platform-sheet-adopted` resets position, inset,
  // transform, transition, border, radius, shadow and background — every
  // property the old rail hid behind — but not opacity or visibility.
  const adopted = rule('.platform-sheet-adopted#apps-switcher-sheet');
  assert.match(adopted, /opacity:\s*1\s*!important/);
  assert.match(adopted, /visibility:\s*visible\s*!important/);

  const generic = rule('.platform-sheet-adopted');
  assert.doesNotMatch(generic, /opacity/,
    'if the generic block ever covers it, this reset can go — until then it '
    + 'is the only thing standing between a touch tablet and an empty sheet');
});

test('the island measures the mark with the vote popover\'s arithmetic', () => {
  // One helper, two callers: the popover and the menu cannot drift apart.
  // (#3595 also brings the popover's height clamp in from the same module,
  // so the pin is on placeUnderAnchor being in the named set, not alone.)
  assert.match(VOTE, /import \{[^}]*\bplaceUnderAnchor\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/anchor-popover';/);
  assert.match(VOTE, /placeUnderAnchor\(rect,/, 'the vote popover places itself through it');
  assert.match(ISLAND, /import \{ placeUnderAnchor \} from '\.\.\/\.\.\/lib\/anchor-popover';/);
  assert.match(ISLAND, /getElementById\(MARK_ID\)/, 'the menu reads the mark\'s rect');
  assert.match(ISLAND, /const MARK_ID = 'platform-mark-btn';/);
  assert.match(ISLAND, /\{ flip: false \}/,
    'and never flips above it — above the header is off the screen');
  // Custom properties, not top/left: the root's inline style is the one
  // channel that does not touch the constant class string the kit writes to.
  assert.match(ISLAND, /setProperty\('--menu-anchor-top'/);
  assert.match(ISLAND, /setProperty\('--menu-anchor-left'/);
  // `placeUnderAnchor` measures a physical left; the rule places from the
  // inline start, so the offset is flipped once, in Arabic.
  assert.match(ISLAND, /currentDirection\(\) === 'rtl'\s*\n\s*\? window\.innerWidth - left - sheet\.offsetWidth/,
    'the measured left becomes an inline-start inset in Arabic');
  // Placed in a LAYOUT effect, before the open state paints, and only on the
  // web presentation — the kit positions an adopted sheet itself.
  assert.match(ISLAND, /useIsomorphicLayoutEffect\(\(\) => \{\s*\n\s*if \(!open \|\| adopted\) return undefined;/);
  assert.match(ISLAND, /window\.addEventListener\('resize', place\)/,
    'and follows the mark when the window is resized');
});

// ── The backdrop ───────────────────────────────────────────────────────

test('no dim at sm+, and an outside click still lands', () => {
  // THE DIM IS GONE ON DESKTOP. It came back once on review, on the argument
  // that the Improve rail and this menu opened from the same bar and one
  // dimming while the other did not made them read as different KINDS of
  // surface. The rail retired (#2718 review), and #2784 asked for the menu to
  // read like the vote popover: an undimmed menu under its trigger, the
  // kit's own desktop idiom (.un-popover, which has no backdrop).
  const SCRIM = read('frontend/src/lib/overlay-scrim.js');
  assert.match(SCRIM,
    /surface\.id === 'apps-switcher-sheet' && matchMedia\('\(min-width: 640px\)'\)\.matches\) return null;/,
    'the scrim paints nothing for the desktop popover');

  // The backdrop is still mounted and still covers the page — below `sm` it
  // is the bottom sheet's dismissal target — but at `sm`+ it lets the
  // pointer through, in a block AFTER the base rule it overrides (same
  // specificity, so order decides).
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,300}?className="fixed inset-0/);
  const base = CSS.indexOf('\n#apps-switcher-overlay[data-open] {');
  assert.ok(base > 0);
  const desktop = mediaBlocks('min-width: 640px')
    .filter((b) => b.includes('#apps-switcher-overlay[data-open]'));
  assert.equal(desktop.length, 1, 'one desktop rule releases the pointer');
  assert.match(desktop[0], /#apps-switcher-overlay\[data-open\] \{\s*pointer-events:\s*none;/);
  assert.ok(CSS.indexOf(desktop[0]) > base, 'and it comes after the rule it overrides');
  for (const block of mediaBlocks('min-width: 640px')) {
    assert.doesNotMatch(block, /#apps-switcher-overlay[^}]*background/,
      'no desktop rule repaints the backdrop');
  }

  // Which leaves dismissal to the island: an outside click closes the menu
  // in the capture phase and still reaches what was clicked, the vote
  // popover's rule. The mark is spared, because its own click toggles.
  assert.match(ISLAND, /document\.addEventListener\('click', onDoc, true\)/);
  assert.match(ISLAND, /sheet\?\.contains\(t\) \|\| mark\?\.contains\(t\)/);
  assert.doesNotMatch(ISLAND, /preventDefault|stopPropagation/,
    'the click is not swallowed');

  // Below `sm` the backdrop still catches the dismissing tap.
  assert.match(rule('#apps-switcher-overlay[data-open]'), /pointer-events:\s*auto/);
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?onClick=\{close\}/,
    'clicking it closes the sheet');
});

// ── The other two presentations are untouched ──────────────────────────

test('below sm it is still a bottom sheet, dim and all', () => {
  // #2784 researched this too: WeChat, Alipay and LINE open their platform
  // menu as a sheet from the bottom of the screen, which is what this is.
  const block = blockWith('max-width: 639px', '#apps-switcher-sheet {');
  const sheet = block.slice(block.indexOf('#apps-switcher-sheet {'));
  assert.match(sheet, /bottom:\s*0/);
  assert.match(sheet, /transform:\s*translateY\(100%\)/, 'it still comes up from the floor');
  assert.match(block, /#apps-switcher-sheet\[data-open\] \{\s*\n\s*transform:\s*translateY\(0\)/);
  // Two top corners, and they are the pane radius now rather than 1rem: below
  // sm this menu is a bottom sheet like the Improve rail and the bell's, and
  // all three read the same 1.75rem off `.dc-lift`. What is pinned here is
  // that it still HAS two rounded top corners — the dropdown above keeps its
  // own 0.75rem menu radius, which is the shape this must not inherit.
  assert.match(sheet, /border-start-start-radius:\s*1\.75rem/, 'and keeps its two top corners');
  assert.match(sheet, /border-start-end-radius:\s*1\.75rem/);

  // The dim here is lib/overlay-scrim.js's paint layer rather than the
  // backdrop, because a dim painted behind the panel lands inside the panel's
  // own backdrop-filter and turns its glass grey. The backdrop element stays
  // for pointer-events and dismiss-on-click, and paints nothing.
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?className="fixed inset-0 z-40"/);
  assert.doesNotMatch(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?bg-black/);
});

test('the sheet markup is one panel — the presentation is entirely CSS', () => {
  // The presentation is a media query: no branch, no second element, so the
  // three presentations cannot grow three sets of behaviour. The one thing
  // measured — the mark's rect — is measured in the island (./index.tsx)
  // and handed to the CSS as custom properties; the sheet itself neither
  // measures nor asks how wide the window is.
  assert.doesNotMatch(SHEET, /matchMedia|getBoundingClientRect/,
    'the panel does not ask how wide the window is');
  assert.doesNotMatch(ISLAND, /matchMedia/,
    'and neither does the island: the media query decides which rule reads the anchor');
  assert.match(SHEET, /id="apps-switcher-sheet"[\s\S]{0,600}?className="fixed z-50/,
    'one root, one constant class string');
});

// ── The panel's contents ───────────────────────────────────────────────

test('the popover is a menu\'s width — narrower than the rail, and it fits', () => {
  const closed = desktopClosed();
  const mine = closed.match(/\n\s*width:\s*([\d.]+)rem/);
  assert.ok(mine, 'the popover states a width');

  // It was 36rem, wider than the rails on purpose, while the menu headed
  // with a horizontal strip of app tiles — the only part of it that used
  // width. The strip retired; what is left is rows, so #2784 brought it
  // down to a menu's width. Pinned as an INEQUALITY against the rail so
  // going back to "wider" has to be argued for, not slip in.
  const sheets = rule('#notifications-sheet,\n#messages-sheet');
  const theirs = sheets.match(/\n\s*width:\s*([\d.]+)rem/);
  assert.ok(theirs, 'the notifications rail states a width');
  assert.ok(Number(mine[1]) < Number(theirs[1]),
    'the menu is narrower than the notifications rail — see the comment');
  assert.ok(Number(mine[1]) * 16 >= 312,
    'and no narrower than the vote popover it is modelled on');

  // The guard keeps it inside the narrowest viewport the desktop rule
  // applies to, with the placement's 8px margin on both sides. It is taken
  // from the float box (1 Nov 2026), the window less iPhone Duo's column,
  // which is the window wherever there is no column.
  const guard = closed.match(/max-width:\s*calc\(var\(--platform-float-w\)\s*-\s*([\d.]+)rem\)/);
  assert.ok(guard, 'and it caps itself against the float box, the viewport less the Duo\'s column');
  assert.equal(Number(guard[1]) * 16, 16, '8px a side, the margin the placement clamps to');
  const SM = 640;
  const px = Number(mine[1]) * 16;
  assert.ok(px <= SM - (Number(guard[1]) * 16),
    `${px}px must fit inside ${SM}px less the ${Number(guard[1]) * 16}px guard`);
});

test('the popover hangs just under the mark, with the brand hairline', () => {
  // A 6px gap, the vote popover's — lib/anchor-popover.ts's default, which
  // the island does not override.
  assert.doesNotMatch(ISLAND, /gap:/, 'the island keeps the shared 6px gap');
  const ANCHOR = read('frontend/src/lib/anchor-popover.ts');
  assert.match(ANCHOR, /gap = 6, margin = 8/);
  assert.match(desktopClosed(), /border-color:\s*var\(--brand-line\)/,
    'the hairline is the brand one the mark\'s tile sits in');
});

test('the label row is a label, not a heading', () => {
  // The row it sits in cannot use SECTION — it holds the close button too —
  // so the type half is shared as a constant and the row states SECTION's own
  // padding. Both halves have to hold for it to read as a label.
  //
  // IT SAYS THE APP'S NAME NOW. "Apps" was right while a strip of every app
  // sat under it; with the strip retired (#2718 review) this row names what
  // the sheet is about, and the duplicate label that used to open the list
  // below went with it.
  assert.match(SHEET, /const SECTION_TYPE = 'text-\[0\.7rem\] font-semibold uppercase tracking-wide '/,
    'the type half is a constant of its own');
  assert.match(SHEET, /const SECTION = 'px-5 pt-4 pb-1 ' \+ SECTION_TYPE;/,
    'and SECTION is that constant plus the row it owns');
  assert.match(SHEET, /className=\{'flex-1 min-w-0 block truncate ' \+ SECTION_TYPE\}/,
    'the label reads as a label…');
  assert.match(SHEET, /className="flex items-center gap-3 px-5 pt-4 pb-1 shrink-0"/,
    '…in a row carrying SECTION\'s own padding');
  assert.doesNotMatch(SHEET, /text-lg font-semibold text-zinc-900/,
    'the heading it used to be is gone');
});

test('every group in the menu announces itself', () => {
  // ONE GROUP NOW. "Platform" and "You" were the platform's destinations and
  // the viewer's, and both left with #2718 — the tab bar carries the first
  // and the Profile screen the second. The apps strip was the third and left
  // on the owner's review, so what remains is named after the APP, which is
  // what every row in it is about.
  //
  // "In this app" is not in this list either, and its absence is older: the
  // App | Board | Activity strip it captioned left when the menu was still
  // picking WHICH APP, because a control about the app you are already inside
  // sat between you and the list you opened it for.
  assert.match(SHEET, /\{appLabel\}\n\s+<\/span>/,
    "the one group is labelled with the app's name");
  const nav = SHEET.slice(SHEET.indexOf('id="switcher-nav"'));
  assert.ok(!nav.includes('{appLabel}</div>'),
    'and not a second time inside the list — the header row is the label now');
  assert.doesNotMatch(nav, /id="switcher-row-/,
    'and no platform destination is left in this menu at all — they are tabs '
    + 'and Profile rows now (#2718)');
});

test('the Workshop is a row in the menu, not a toggle (#2761)', () => {
  // The App | Workshop strip was the one CONTROL in a menu of rows. The owner
  // asked for a plain "Go to workshop" row instead, with nothing in place of
  // the App segment — the parked app on the bar (#2762) is the way back.
  assert.ok(!/AppViewTabs|view-tabs/.test(SHEET.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'the strip is not rendered here any more');
  assert.match(SHEET, /id="app-menu-row-workshop"[\s\S]{0,200}label=\{t\('agent:appContext\.row\.community'\)\}/,
    'the row that replaced it');
  // The strip's Workshop segment carried the vote count; it rides the row now.
  assert.match(SHEET, /id="app-menu-workshop-owed"/);
  assert.ok(!/In this app/.test(SHEET.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'and no caption left behind — comments explaining a move are fine, '
    + 'rendered text is not');
});
