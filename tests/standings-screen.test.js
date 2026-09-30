// Leaderboard screen — the Kudos leaderboard, the Topochain standings, the
// season's challenges and the past seasons, behind one entry point with a
// four-tab strip: Challenges, Kudos, Standings, History (the navigation
// prototype's Challenges page). The screen has no heading of its own any
// more: the platform bar names the TAB (Leaderboard._syncTitle).
//
// The contract that's easy to break later:
//   - the screen opens on CHALLENGES, the strip's first tab (#2374): the
//     bare #leaderboard hash, the pane the shell ships visible and the
//     module's starting section must all agree on that;
//   - the Topochain standings, which the tab strip labels "Standings", are
//     addressed by name — #leaderboard/topochain — and the home widget's
//     fill links there explicitly;
//   - History is #leaderboard/seasons (NOT #leaderboard/history, which is
//     the Kudos pane's "My history" and keeps meaning that);
//   - the kudos board is still all there, one tab over, named "Kudos";
//   - every existing #leaderboard/<sub> deep link (prs / users / history /
//     users/<name>) still resolves to a Kudos sub-tab;
//   - #leaderboard/challenges and #leaderboard/topochain are the canonical
//     addresses for the challenges and standings tabs, and the bare
//     #leaderboard and the legacy hashes (#topochain/leaderboard,
//     #topochain/seasons, #challenges) alias onto them, so old bookmarks
//     work;
//   - the three panes keep SEPARATE data state — routing Topochain
//     through Leaderboard._cache would break its event/page paging;
//   - the two Topochain-domain panes share ONE event selection, owned by
//     TopochainEventContext, so standings and challenges can never
//     describe different weeks.
//
// Static-assertion style (cf. tests/topochain-screens.test.js).
//
// Run with: node --test tests/standings-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const lbJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/leaderboard.js'), 'utf8');
const island = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/index.tsx'), 'utf8');
const topoJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-leaderboard.js'), 'utf8');
// #1191 slice 6 conversion 5: the pane's markup lives here now — the module
// above returns descriptors. Assertions about what the pane RENDERS moved with
// it; assertions about what it DECIDES stayed above.
const standingsTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-standings.tsx'), 'utf8');
const chJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-challenges.js'), 'utf8');
// #1191 slice 6 conversion 7 split the challenges pane the same way conversion
// 5 split the standings pane: chJs decides, this renders.
const chTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/challenges-pane.tsx'), 'utf8');
const chCardTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/challenge-card.tsx'), 'utf8');
const ctxJs = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/topochain-event-context.js'), 'utf8');
// The bar's MARKUP moved to a component in #1191; topochain-event-context.js
// keeps the data, the picks and the subscription, and pushes a view model.
// Assertions about what is drawn read the component, assertions about what
// decides it read the module.
const barTsx = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/event-bar.tsx'), 'utf8');
const barStore = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/event-bar-store.js'), 'utf8');
const publicJs = fs.readFileSync(path.join(root, 'src/routes/topochain/public.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

/**
 * A class-table constant out of @/components/ui/tabs.tsx, with its
 * concatenated string pieces joined back up.
 *
 * The strip assertions below read the treatment from the primitive rather
 * than transcribing it, so a palette change moves both surfaces or neither.
 */
function tabsConstant(name) {
  const src = fs.readFileSync(path.join(root, 'frontend/@/components/ui/tabs.tsx'), 'utf8');
  const start = src.indexOf(`export const ${name} =`);
  assert.notEqual(start, -1, `${name} is exported from @/components/ui/tabs.tsx`);
  const decl = src.slice(start, src.indexOf(';', start));
  const parts = Array.from(decl.matchAll(/'([^']*)'/g), (m) => m[1]);
  assert.ok(parts.length > 0, `${name} is a literal class string`);
  return parts.join('');
}

// ─── Shell ───────────────────────────────────────────────────────────────

test('the Leaderboard screen hosts a tab strip, an event bar and all four panes', () => {
  const start = html.indexOf('<main id="leaderboard-screen"');
  const end = html.indexOf('</main>', start);
  assert.ok(start > -1, '#leaderboard-screen exists');
  const screen = html.slice(start, end);
  // Bug f of the navigation audit: the screen said its name twice — the bar
  // and an <h2>Leaderboard</h2> — and neither named the tab showing. The
  // platform names a screen ONCE, in the bar, and the bar follows the tab now.
  assert.ok(!screen.includes('>Leaderboard<'), 'no second, in-page title');
  assert.doesNotMatch(screen.slice(0, screen.indexOf('id="standings-tabs"')), /<h2/,
    'nothing heads the strip: it is the first thing under the bar');
  assert.ok(screen.includes('id="standings-tabs"'), 'it carries the section tab strip');
  assert.ok(screen.includes('id="leaderboard-event-bar"'), 'it carries the shared event bar');
  assert.ok(screen.includes('id="leaderboard-root"'), 'it hosts the Kudos pane');
  assert.ok(screen.includes('id="topochain-leaderboard-root"'), 'it hosts the Topochain pane');
  assert.ok(screen.includes('id="challenges-root"'), 'it hosts the Challenges pane');
  assert.match(screen, /<div id="leaderboard-history-root" class="hidden w-full"><\/div>/,
    'and the History pane, shipped empty and hidden like the other non-default panes');
  // Wide enough for the Topochain table; the Kudos lists keep their
  // narrower reading column, centered on its own (#2921) rather than
  // left-pinned inside the wider frame.
  assert.match(screen, /max-w-5xl/, 'the shell is the wider column');
  assert.match(screen, /id="leaderboard-root" class="hidden max-w-\[40rem\] mx-auto"/,
    'the Kudos pane keeps a narrower reading width, centered (and ships hidden — see below)');
});

test('Kudos sits in Me\'s column, and the strip clears the bar as Me does (#2832 follow-up)', () => {
  const classOf = (re) => {
    const m = html.match(re);
    assert.ok(m, `${re} renders`);
    return m[1].split(/\s+/);
  };
  const rem = (cls) => {
    // Tailwind's named widths in rem, and one arbitrary `[Nrem]` value.
    const named = { 'max-w-2xl': 42, 'max-w-3xl': 48, 'max-w-5xl': 64 };
    if (cls in named) return named[cls];
    const m = cls.match(/^max-w-\[(\d+(?:\.\d+)?)rem\]$/);
    return m ? Number(m[1]) : null;
  };
  const pad = { 'px-4': 1 };

  // Me: the reference column (#2832) — Workshop's max-w-2xl box, its own px-4.
  const me = classOf(/id="profile-root" class="([^"]*)"/);
  const meWidth = rem(me.find((c) => c.startsWith('max-w-')));
  assert.equal(meWidth, 42, 'Me is still the max-w-2xl column');
  assert.ok(me.includes('px-4') && me.includes('pt-5'), 'with its own px-4 gutter and pt-5 top gap');
  const meContent = meWidth - 2 * pad['px-4'];

  // The Leaderboard frame supplies the gutter OUTSIDE the Kudos root, so the
  // Kudos root's width must equal Me's CONTENT width for the rows to span
  // exactly the x-range Me's cards do — the 96px jump was max-w-3xl here.
  const start = html.indexOf('<main id="leaderboard-screen"');
  const screen = html.slice(start, html.indexOf('</main>', start));
  const frame = classOf(/<main id="leaderboard-screen"[^>]*><div class="([^"]*)"/);
  assert.ok(frame.includes('px-4'), 'the frame carries the 16px gutter');
  assert.ok(frame.includes('pt-5') && !frame.includes('p-4'),
    'and pt-5, clearing the bar\'s 8px notch plus 12px as Me and Workshop do — not p-4');
  const kudos = (screen.match(/id="leaderboard-root" class="([^"]*)"/) || [])[1].split(/\s+/);
  assert.ok(kudos.includes('mx-auto'), 'the Kudos column is centered, as Me\'s is');
  assert.ok(!kudos.includes('max-w-3xl'), 'not the 96px-wider column it used to be');
  assert.ok(!kudos.some((c) => /^p[xytblr]?-\d/.test(c)), 'and adds no gutter of its own (the frame\'s is the gutter)');
  assert.equal(rem(kudos.find((c) => c.startsWith('max-w-'))), meContent,
    'the Kudos rows are exactly as wide as Me\'s cards');
});

test('the strip lines up with the pane under it, and the column holds still across tabs', () => {
  const src = fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/index.tsx'), 'utf8');
  // Kudos narrows to Me's column; the strip above it follows, so the first tab
  // starts where the first row does instead of at the wide frame's edge.
  assert.match(src, /const KUDOS_COLUMN = 'max-w-\[40rem\] mx-auto';/);
  assert.match(src, /section === 'kudos' \? KUDOS_COLUMN : undefined/,
    'the strip wrapper takes the Kudos column only while Kudos shows');
  assert.match(src, /id="leaderboard-root" className=\{`hidden \$\{KUDOS_COLUMN\}`\}/,
    'from the same constant as the Kudos root, so the two cannot drift');
  // Kudos and Standings scroll, Challenges and History do not: without a
  // reserved gutter a classic scrollbar re-centers the column on the long tabs.
  const main = (html.match(/<main id="leaderboard-screen" class="([^"]*)"/) || [])[1] || '';
  assert.ok(main.split(/\s+/).includes('[scrollbar-gutter:stable]'),
    'the scroller reserves its scrollbar gutter on every tab');
});

test('the retired screens are gone from the shell', () => {
  assert.ok(!html.includes('<main id="challenges-screen"'),
    '#challenges-screen was folded into the Leaderboard screen');
  assert.ok(!html.includes('<main id="topochain-seasons-screen"'),
    '#topochain-seasons-screen was folded into the Leaderboard screen');
});

test('the challenges pane + event bar ship visible — challenges are the default section', () => {
  // The DEFAULT pane and the event bar it reads from must ship visible, or
  // the screen paints another pane for a frame before _applySection runs.
  for (const id of ['challenges-root', 'leaderboard-event-bar']) {
    const el = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(el, `#${id} exists`);
    assert.doesNotMatch(el[0], /class="hidden/, `#${id} ships visible`);
  }
  for (const id of ['leaderboard-root', 'topochain-leaderboard-root']) {
    const el = html.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(el, `#${id} exists`);
    assert.match(el[0], /class="hidden/, `#${id} ships hidden`);
  }
});

// ─── Section state ───────────────────────────────────────────────────────

test('Leaderboard.section defaults to Challenges (#2374)', () => {
  assert.match(lbJs, /section: 'challenges',/,
    'the screen opens on its first tab, Challenges, not on the standings');
  assert.match(lbJs, /store = \{ mounted: false, section: 'challenges',/,
    "the module's copy of the section store starts there too");
  assert.match(fs.readFileSync(path.join(root, 'frontend/src/features/leaderboard/section-store.ts'), 'utf8'),
    /export const DEFAULT_SECTION = 'challenges';/,
    "and so does the island's, or the strip's first render disagrees with the pane");
});

// The strip's markup moved to the island in #1083 chunk F — the module
// publishes the active section and React renders the buttons — so the labels
// and keys are asserted where they now live. `_renderSectionTabs` is still the
// entry point and is checked to have become a publish rather than a write, so
// the two halves can't drift back into both rendering.
test('the tab strip reads Challenges, Kudos, Standings, History (#1917, the prototype)', () => {
  const list = island.slice(island.indexOf('const SECTION_TABS = ['), island.indexOf('];', island.indexOf('const SECTION_TABS = [')));
  assert.ok(list.length > 0, 'SECTION_TABS located in the island');
  const labels = [...list.matchAll(/\{ key: '([a-z]+)', label: '([^']+)' \}/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(labels, [
    ['challenges', 'Challenges'],
    ['kudos', 'Kudos'],
    ['topochain', 'Standings'],
    ['seasons', 'History'],
  ], 'what you can do first, then the ranking, then the rankings that are over; '
    + 'the prototype\'s words, Standings and History');
  // Four labels have to fit a 390px column: the triggers tighten below `sm`.
  // QA 2026-09-24 Q21: px-2 (was px-2.5), so the four fit a 390px column.
  assert.match(island, /const STRIP_TAB = 'inline-flex items-center justify-center h-8 px-2 sm:px-4 /,
    'a phone-width trigger padding, restored from sm up');
  // And where they still do not fit, the strip says it scrolls.
  assert.match(island, /<TabsList id="standings-tabs" ref=\{stripRef\} className=\{STRIP_LIST\} style=\{stripFade\}>/);
  // The KEYS are the platform's vocabulary for these tabs (hash aliases in
  // app.js, dapp.json checks) and must survive both the relabelling and the
  // move: they are the attribute dapp.json selects on.
  assert.match(island, /data-standings-tab=\{s\.key\}/, 'tab keys are unchanged');
  // Clicking a trigger goes back into the module, exactly as the innerHTML'd
  // button's own listener did.
  assert.match(island, /window\.Leaderboard\?\._setSection\?\.\(key\)/,
    'a trigger reports back through _setSection, which owns the hash and the panes');
});

// ─── The Kudos sub-tab strip (#2441) ─────────────────────────────────────
//
// It sat DIRECTLY under the section strip on this same screen and was still
// an underline row: `border-b-2` with `border-violet-500 text-violet-700`
// under the active label, in a `border-b` track. @/components/ui/tabs.tsx's
// header calls that "the shape the widget language replaces everywhere: it
// separates by RULE, and the language separates by figure/ground" — two
// inches below a strip that had already stopped doing it.
//
// It is a `<TabsTrigger>` now, on the same track and with the same near-black
// selected fill as the strip above. The pane's own header explains why this
// strip may adopt the primitive where the window pills beside it may not.
//
// Rendered, not grepped: the class attribute a caller actually gets out of
// TabsTrigger is a `cn()` of three arguments, and only a render says what
// that comes to.
test('the Kudos sub-tabs are the same segmented control as the strip above (#2441)', () => {
  const state = {
    mounted: true,
    chrome: {
      kind: 'tabs',
      subtitle: 'Kudos earned on merged PRs.',
      subTabs: [
        { key: 'prs', active: true, label: 'Top PRs' },
        { key: 'users', active: false, label: 'Top users' },
        { key: 'history', active: false, label: 'History' },
      ],
      winTabs: [
        { key: 'all', active: true, label: 'All time' },
        { key: '30d', active: false, label: '30 days' },
      ],
    },
    body: null,
  };
  const mod = loadTsx('frontend/src/features/leaderboard/kudos-pane.tsx', {
    stubs: {
      './kudos-pane-store.js': {
        kudosPaneStore: { get: () => state, subscribe: () => () => {} },
      },
    },
  });
  const out = renderToHtml(createElement(mod.KudosPane, {}));
  // The strip, anchored by its own first button rather than by the pane.
  const strip = out.slice(out.lastIndexOf('<div', out.indexOf('data-lb-sub="prs"')),
    out.indexOf('</div>', out.indexOf('data-lb-sub="history"')));

  // QA 2026-09-24 Q21: the track gains the section strip's sideways scroll
  // (for a 320px phone) after the primitive's margin-free spelling.
  assert.ok(strip.startsWith(`<div class="${tabsConstant('SECTION_TABS_LIST_BASE')} max-w-full overflow-x-auto `),
    'the sub-tabs sit on the primitive\'s track — the margin-free spelling, '
    + 'because the strip shares an items-center row with the window pills');

  const button = (key) => {
    const m = strip.match(new RegExp(`<button[^>]*data-lb-sub="${key}"[^>]*>`));
    assert.ok(m, `the ${key} sub-tab is located`);
    return m[0];
  };
  // QA 2026-09-24 Q21: SECTION_TAB_BASE's face with the phone padding the
  // section strip uses (px-3 below sm) and a label that never wraps. Every
  // other token of the primitive's geometry is still there.
  const base = 'inline-flex items-center justify-center h-8 px-3 sm:px-4 rounded-full text-sm font-semibold transition-colors whitespace-nowrap shrink-0';
  for (const token of tabsConstant('SECTION_TAB_BASE').split(' ').filter((t) => t !== 'px-4')) {
    assert.ok(base.split(' ').includes(token), `the sub-tab keeps the strip's ${token}`);
  }
  assert.ok(button('prs').includes(`${base} ${tabsConstant('SECTION_TAB_ACTIVE')}`),
    'the selected sub-tab is the language\'s inversion');
  for (const key of ['users', 'history']) {
    assert.ok(button(key).includes(`${base} ${tabsConstant('SECTION_TAB_INACTIVE')}`),
      `the ${key} sub-tab is the unselected treatment`);
  }
  // The retired shape, and the rule the strip hung from.
  assert.ok(!/border-b|border-violet-500|border-transparent/.test(strip),
    'no underline, and no rule under the row');
  assert.ok(!/violet/.test(strip), 'and no violet ink on a sub-tab');

  // What the strip still reports with. `data-lb-sub` is leaderboard.js's key
  // (_setSub validates it) and survives the conversion; `aria-current` is what
  // adopting the primitive ADDS, and is the reason the pane's header note had
  // to be rewritten rather than deleted.
  assert.equal((strip.match(/data-lb-sub="/g) || []).length, 3);
  assert.match(button('prs'), /aria-current="page"/);
  assert.match(button('users'), /aria-current="false"/);
  // The window pills in the same row are NOT tabs and keep their own shape.
  // (QA 2026-09-24 Q21: plus `whitespace-nowrap`, so "All-time" stays one line.)
  assert.match(out, /data-lb-win="all" class="px-3 py-1 text-xs font-medium rounded-full whitespace-nowrap bg-violet-600 text-white"/,
    'the window pills are untouched — a separate control, not a second tab strip');
});

test('the sub-tab click still goes back through Leaderboard._setSub', () => {
  const pane = fs.readFileSync(
    path.join(root, 'frontend/src/features/leaderboard/kudos-pane.tsx'), 'utf8');
  const chrome = pane.slice(pane.indexOf('function TabChrome('), pane.indexOf('// ── Body'));
  assert.ok(chrome.length > 0, 'TabChrome located');
  assert.match(chrome, /onValueChange=\{\(key\) => controller\(\)\?\._setSub\(key\)\}/,
    'the strip reports a key to the module, exactly as the old onClick did');
  assert.match(chrome, /value=\{view\.subTabs\.find\(\(t\) => t\.active\)\?\.key \?\? ''\}/,
    'and it is CONTROLLED by the descriptor leaderboard.js publishes — the '
    + 'primitive holds no state of its own');
});

test('_renderSectionTabs publishes instead of writing #standings-tabs', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _renderSectionTabs() {'), lbJs.indexOf('  // Re-fetch every cached pane'));
  assert.ok(fn.length > 0, '_renderSectionTabs located');
  // The host is React's now, and the migration's rule is that no public/js
  // module may write into a React-owned subtree.
  assert.doesNotMatch(fn, /innerHTML/, 'the strip is rendered by the island, not written here');
  assert.doesNotMatch(fn, /getElementById\('standings-tabs'\)/,
    'the module must not reach into the React-owned host at all');
  assert.match(fn, /store\.section = Leaderboard\.section;/, 'it publishes the active section');
  assert.match(fn, /for \(const listener of \[\.\.\.store\.listeners\]\)/,
    'and notifies the island, which re-renders the strip');
});

test('_setSection validates its input and syncs the hash', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSection(section) {'), lbJs.indexOf('  _applySection()'));
  assert.ok(fn.length > 0, '_setSection located');
  assert.match(fn, /if \(!Leaderboard\.SECTIONS\.includes\(section\)\) return;/,
    'garbage sections are a no-op, mirroring _setSub');
  assert.match(lbJs, /SECTIONS: \['topochain', 'kudos', 'challenges', 'seasons'\],/,
    'all four sections are declared in one place');
  assert.match(lbJs, /EVENT_SECTIONS: \['topochain', 'challenges'\],/,
    'the two event-scoped sections are declared in one place');
  assert.match(fn, /Leaderboard\._syncHash\(\);/, 'the hash follows the tab');
  assert.match(fn, /if \(!Leaderboard\._open\) return;/,
    'deep-link restore records state without rendering — open() does the first render');
});

test('_setSub still rejects garbage, and pins the section back to kudos', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _setSub(sub) {'), lbJs.indexOf('  openProfile(username)'));
  assert.ok(fn.length > 0, '_setSub located');
  assert.match(fn, /if \(sub !== 'prs' && sub !== 'users' && sub !== 'history'\) return;/,
    'only the three known Kudos sub-tabs are accepted');
  assert.match(fn, /Leaderboard\.section = 'kudos';/,
    "a Kudos sub-tab deep link must not land on a Topochain tab left over from earlier");
});

test('_syncHash emits the canonical standings and challenges addresses', () => {
  const fn = lbJs.slice(lbJs.indexOf('  _syncHash() {'), lbJs.indexOf('  _setWindow(win)'));
  assert.ok(fn.length > 0, '_syncHash located');
  assert.match(fn, /\? '#leaderboard\/topochain'\n/,
    'the standings tab addresses by name since Challenges became the default (#2374)');
  assert.doesNotMatch(fn, /\? '#leaderboard'\n/,
    'no section claims the BARE #leaderboard, so an arriving bare hash self-heals to its tab');
  assert.match(fn, /'#leaderboard\/challenges'/, 'the Challenges tab addresses as #leaderboard/challenges');
  assert.match(fn, /#leaderboard\/users\/\$\{encodeURIComponent/, 'the profile drill-in hash is unchanged');
  assert.match(fn, /location\.hash\.startsWith\('#leaderboard'\)/,
    'still guarded so it never hijacks an app route mid-navigation');
});

// ─── Router ──────────────────────────────────────────────────────────────

test('navigateToLeaderboard routes every section segment to the section', () => {
  // Anchored on the name, not the full parameter list — the signature grew a
  // third argument for the #982 challenge deep link and will grow again.
  const fn = appJs.slice(
    appJs.indexOf('  navigateToLeaderboard(sub, profileUser'),
    appJs.indexOf('  _exitLeaderboard()')
  );
  assert.ok(fn.length > 0, 'navigateToLeaderboard located');
  assert.match(fn, /sub === 'topochain' \|\| sub === 'kudos' \|\| sub === 'challenges'/,
    "every section segment selects the section rather than falling through to _setSub");
  // #2718 REVIEW: the screen is titled after the SECTION it is showing.
  // It said "Leaderboard" for every one of them, so arriving at Challenges
  // from the Me tab's Challenges row put a word on the bar that matched
  // neither the row pressed nor the tab still lit. The table is
  // App.LEADERBOARD_TITLES and the fallback is the old word, for a section
  // nobody has named yet.
  assert.match(fn, /App\.setHeaderTitle\(App\._leaderboardTitle\(sub, profileUser\)\)/,
    'the screen is titled after the section it shows');
  // openProfile must still win over both — _setSub/_setSection would
  // replaceState the profile hash away.
  assert.ok(
    fn.indexOf('Leaderboard.openProfile(profileUser)')
      < fn.indexOf('Leaderboard._setSection(sub)'),
    'the profile drill-in is checked first');
});

test('the legacy #topochain hashes self-heal to the canonical form', () => {
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'topochain')"),
    appJs.indexOf("if (parts[0] === 'app' && parts[1])")
  );
  assert.match(branch, /parts\[1\] === 'seasons' \? 'challenges' : 'topochain'/,
    'seasons maps onto the challenges tab, everything else onto standings');
  assert.match(branch, /_tcSection === 'challenges' \? '#leaderboard\/challenges' : '#leaderboard\/topochain'/,
    'the address is rewritten in place — standings to #leaderboard/topochain, one replaceState not two');
  assert.match(branch, /App\.navigateToLeaderboard\(_tcSection, null\)/, 'then hands off');
  assert.match(branch, /catch \(err\)/,
    'a replaceState failure must not swallow the navigation');
  // The rewrite must land BEFORE the navigate, or Leaderboard._syncHash
  // sees a non-#leaderboard hash and skips its own sync.
  assert.ok(branch.indexOf('history.replaceState') < branch.indexOf('App.navigateToLeaderboard'),
    'the rewrite happens before the navigate');
});

test('the legacy #challenges hash self-heals to the canonical form', () => {
  const branch = appJs.slice(
    appJs.indexOf("if (parts[0] === 'challenges')"),
    appJs.indexOf("if (parts[0] === 'profile')")
  );
  assert.ok(branch.length > 0, "the #challenges branch is still routed");
  assert.match(branch, /history\.replaceState\(null, '', '#leaderboard\/challenges'\)/,
    'the address is rewritten in place');
  assert.match(branch, /App\.navigateToLeaderboard\('challenges', null\)/, 'then hands off');
  assert.ok(branch.indexOf('history.replaceState') < branch.indexOf('App.navigateToLeaderboard'),
    'the rewrite happens before the navigate');
});

test('the retired navigate/exit pairs are gone from app.js', () => {
  // Strip comments: both names are still NAMED in the tombstone comments
  // that explain where they went, which is not a definition or a call.
  const code = appJs.replace(/\/\/[^\n]*/g, '');
  for (const name of ['navigateToChallenges', '_exitChallenges',
    'navigateToTopochainSeasons', '_exitTopochainSeasons',
    '_inChallenges', '_inTopochainSeasons']) {
    assert.ok(!code.includes(name), `${name} is gone — the screens are tabs now`);
  }
});

// ─── Pane lifecycle + data isolation ─────────────────────────────────────

test('each guest pane mounts lazily and tears down with the screen', () => {
  assert.match(lbJs, /_topoMounted: false,/, 'Topochain mount state is tracked');
  assert.match(lbJs, /_challengesMounted: false,/, 'Challenges mount state is tracked');
  assert.match(lbJs, /_eventBarMounted: false,/, 'event-bar mount state is tracked');
  const apply = lbJs.slice(lbJs.indexOf('  _applySection() {'), lbJs.indexOf('  _renderSectionTabs()'));
  assert.match(apply, /!Leaderboard\._topoMounted\s+&& window\.TopochainLeaderboard\?\.open/,
    'open() runs the first time the Topochain tab is shown, not on every visit');
  assert.match(apply, /!Leaderboard\._challengesMounted\s+&& window\.TopochainChallenges\?\.open/,
    'same for the Challenges tab');
  assert.match(apply, /!Leaderboard\._eventBarMounted\s+&& window\.TopochainEventContext\?\.open/,
    'the shared event bar mounts with whichever event tab is shown first');
  const close = lbJs.slice(lbJs.indexOf('  close() {'), lbJs.indexOf('  // ── Section'));
  assert.match(close, /TopochainLeaderboard\.close\(\)/,
    'leaving the screen closes the guest pane too, so in-flight fetches cannot paint into it');
  assert.match(close, /TopochainChallenges\.close\(\)/, 'and the challenges pane');
  assert.match(close, /TopochainEventContext\.close\(\)/, 'and the shared event bar');
});

test('the event bar is hidden on Kudos and shown on the two event tabs', () => {
  const apply = lbJs.slice(lbJs.indexOf('  _applySection() {'), lbJs.indexOf('  _renderSectionTabs()'));
  assert.match(apply, /EVENT_SECTIONS\.includes\(Leaderboard\.section\)/,
    'visibility is derived from the declared event sections');
  assert.match(apply, /bar\.classList\.toggle\('hidden', !onEventSection\)/,
    'Kudos has no event dimension, so the bar is hidden there');
});

test('the panes keep separate data state', () => {
  // Kudos events cannot change Topochain standings — refresh() must bail.
  const refresh = lbJs.slice(lbJs.indexOf('  refresh() {'), lbJs.indexOf('  invalidateHistory()'));
  assert.match(refresh, /if \(Leaderboard\.section !== 'kudos'\) return;/,
    'a kudos_update never re-fetches while a Topochain tab is active');
  // The Topochain modules own their own paging/event state. Strip
  // comments before asserting — the module headers say in words that they
  // stay out of the cache, which is not a usage.
  for (const [name, src] of [['standings', topoJs], ['challenges', chJs]]) {
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/Leaderboard\._cache/.test(code),
      `the ${name} module must not route through the Kudos cache`);
  }
  assert.match(topoJs, /_page: /, 'the standings pane keeps its own paging state');
});

// ─── Shared event selection ──────────────────────────────────────────────

test('one module owns the event list, the picker and the hero', () => {
  assert.match(ctxJs, /window\.TopochainEventContext = TopochainEventContext;/,
    'the module publishes onto the global');
  assert.match(ctxJs, /'\/api\/v4\/season-events\?include_past=1'/,
    'it owns the events fetch');
  assert.match(ctxJs, /TopochainEvents\.pickDefault\(data\.data\)/,
    'and the shared default pick');
  assert.match(ctxJs, /_renderOptions\(\)/, 'it owns what the picker offers');
  assert.match(ctxJs, /_renderHero\(\)/, 'and what the hero says');
  assert.match(barTsx, /id="tc-ev-select"/, 'the component renders the picker');
  assert.match(barTsx, /id="tc-ev-hero"/, 'and the hero');
  assert.match(barTsx, /TopochainEventContext/,
    'and hands a pick straight back to the one module that owns the selection');
  assert.match(ctxJs, /onChange\(fn\)/, 'which exposes a subscription for the panes');
  // ONE store between them, and it is the module's own — a second writer under
  // this host is exactly what the single-owner rule forbids.
  assert.match(barStore, /export const eventBarStore/);
  assert.match(ctxJs, /import \{ eventBarStore \} from '\.\/event-bar-store\.js'/);
  assert.match(barTsx, /import \{ eventBarStore \} from '\.\/event-bar-store\.js'/);
});

// Issue #2495: the bar is for someone with the season history — an admin, or
// a member with a season to go back to. The server decides on the events list
// — the one fetch the bar already makes — and the three files between it and
// the screen each carry the verdict, never a rule of their own.
test('the bar is drawn only for a viewer the server gives the season history', () => {
  assert.match(publicJs, /const viewer = req\.user\?\.id \? \{ history: await viewerHasHistory\(req\.user\) \} : null;/,
    'signed out is null — unknown, not no — and signed in is one boolean');
  assert.match(publicJs, /async function viewerHasHistory\(user\) \{\n\s*if \(user\.isAdmin\) return true;/,
    'an admin gets it by role, before any table is read');
  assert.match(publicJs, /return ok\(res, \{ data, viewer \}\);/, 'sent with the list, not as a second round trip');
  // Enrolled, credited, or on a board — in a season other than the DEFAULT
  // event's, which is what the picker would otherwise be reaching past.
  for (const table of ['user_enrollments', 'user_activities', 'leaderboard_snapshots']) {
    assert.match(publicJs, new RegExp(`FROM ${table} \\w+[\\s\\S]*?IS DISTINCT FROM \\$2::bigint`),
      `${table} counts, measured against the default season`);
  }
  assert.match(publicJs, /const current = await resolveDefaultPublicEvent\(pool\);/,
    'the default season is the one the screen opens on, not the calendar\'s');
  assert.match(ctxJs, /_history = data\.viewer\?\.history === true;/, 'the context takes the verdict from the list');
  assert.match(barStore, /history: false,/, 'the store ships without it');
  assert.match(barTsx, /if \(!mounted \|\| !history\) return null;/, 'and the component renders nothing without it');
  // Every screenshot signs as usernode-capture, a member with no trace
  // outside the running season, so captures of this screen show the
  // new-member state; the checks identity is an admin and sees the picker
  // by role. tests/topochain-staging-seed.test.js pins the seed side.
});

test('neither pane fetches or renders an event picker of its own any more', () => {
  for (const [name, src] of [['standings', topoJs], ['challenges', chJs]]) {
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!code.includes('/api/v4/season-events?include_past=1'),
      `the ${name} pane no longer fetches the events list itself`);
    assert.ok(!code.includes('tc-lb-event-select') && !code.includes('tc-se-event-select'),
      `the ${name} pane no longer renders its own <select>`);
    assert.match(src, /TopochainEventContext\.onChange/,
      `the ${name} pane subscribes to the shared selection`);
    assert.match(src, /_unsub\(\);/, `the ${name} pane unsubscribes on close`);
  }
});

test("a server-resolved event id is fed back silently", () => {
  // A server resolution is not a user choice: it must not clear the event
  // bar's "nothing is running" caption nor re-notify the panes into a loop.
  assert.match(topoJs, /TopochainEventContext\.select\(data\.data\.event\.id, \{ silent: true \}\)/,
    'the standings pane writes back with { silent: true }');
  const sel = ctxJs.slice(ctxJs.indexOf('  select(id, opts) {'), ctxJs.indexOf('  async _loadDetail()'));
  assert.match(sel, /if \(!\(opts && opts\.silent\)\) TopochainEventContext\._notify\(\);/,
    'and a silent write-back does not re-notify subscribers');
});

test('pull-to-refresh dispatches on the active section', () => {
  // The three-pane dispatch moved out of _wirePullToRefresh into
  // App._refreshLeaderboard, so the service worker's late-arrival
  // correction (App.refreshActiveScreen) refreshes this screen through the
  // exact same loaders a manual pull uses. Assert the extracted helper
  // still branches, AND that the pull still routes through it — a copy of
  // this logic left behind in the pull handler is the drift this split was
  // made to prevent.
  const wire = appJs.slice(appJs.indexOf('  _wirePullToRefresh() {'), appJs.indexOf('  bindEvents() {'));
  assert.match(wire, /pullToRefresh\(lb, \(\) => App\._refreshLeaderboard\(\)\)/,
    'the pull must delegate to the shared helper');

  const fn = appJs.slice(appJs.indexOf('  _refreshLeaderboard() {'));
  const body = fn.slice(0, fn.indexOf('\n  },') + 1);
  assert.match(body, /Leaderboard\.section === 'topochain'/, 'the handler branches on the section');
  assert.match(body, /TopochainLeaderboard\.loadLeaderboard\(\)/,
    'a pull on the Topochain tab reloads Topochain standings, not kudos panes');
  assert.match(body, /Leaderboard\.section === 'challenges'/, 'and on the challenges section');
  assert.match(body, /TopochainChallenges\.loadChallenges\(\)/,
    'a pull on the Challenges tab reloads the challenge grid');
});

// ─── Duplicate titles ────────────────────────────────────────────────────

test('no pane renders a heading of its own — the shell owns the title', () => {
  assert.ok(!/>Kudos leaderboard</.test(lbJs),
    'the Kudos pane dropped its own <h2>; the shell says Leaderboard and the tab says Kudos');
  assert.ok(!/>Topochain leaderboard</.test(topoJs),
    'the Topochain pane dropped its own <h1>');
  assert.ok(!/>Topochain seasons</.test(chJs),
    'the Challenges pane dropped its own <h1>');
});

// ─── Personalization (the old #challenges screen's one unique read) ──────

test('the challenges pane decorates the public grid with your own points', () => {
  assert.match(chJs, /\/challenges-api\/challenges\?season_event_id=/,
    'it fetches the session-scoped view');
  assert.match(chJs, /activities_total/, 'and reads your own per-challenge total');
  const load = chJs.slice(chJs.indexOf('  async _loadMine(eventId) {'), chJs.indexOf('  // ── Challenge grid'));
  assert.ok(!/_challengesError/.test(load),
    'a personalization failure never paints an error — the public grid stands');
  // #1917: the "See where the season stands" link under the grid is gone —
  // the standings are a tab away in the strip above it.
  assert.doesNotMatch(chTsx, /See where the season stands|tc-se-to-standings/);
  assert.doesNotMatch(chJs, /_toStandings/);
});

// ─── Completed challenges live here now (#981) ───────────────────────────
//
// The profile screen's season-wide completed-challenges list is gone; this
// pane owns the flag, and the standings pane cross-links to it.

test('the challenges pane reads `completed` from the PUBLIC row, not just the personalization map', () => {
  // This is what makes the chip/grouping/count correct on first paint AND
  // for a signed-out visitor. Reading it only from `_mine` (as it did before)
  // meant an anonymous viewer saw no completion state at all.
  const fn = chJs.slice(chJs.indexOf('  _isDone(c) {'), chJs.indexOf('  _ordered() {'));
  assert.ok(fn.length > 0, '_isDone located');
  assert.match(fn, /c\.completed === true/,
    'the public row is the source of truth');
  const publicFirst = fn.indexOf('c.completed === true');
  const mineFallback = fn.indexOf('m.completed === true');
  assert.ok(publicFirst > -1 && mineFallback > publicFirst,
    'the personalization row is only a fallback, checked after the public one');
});

test('the challenges grid sorts unfinished challenges ahead of completed ones', () => {
  const fn = chJs.slice(chJs.indexOf('  _ordered() {'), chJs.indexOf('  _renderGrid() {'));
  assert.match(fn, /_isDone\(a\.c\)/);
  assert.match(fn, /_isDone\(b\.c\)/);
  // The completed split is the FIRST key, ahead of the featured lift.
  assert.ok(fn.indexOf('ad !== bd') < fn.indexOf('af !== bf'),
    'not-completed must outrank featured, or a featured finished challenge leads the grid');
});

test('the challenges grid summarises and groups the completed set', () => {
  // The tally is composed in the shaping module and the id that carries it is
  // in the renderer — assert both halves, since either one alone would let the
  // declared dapp.json check lose its anchor.
  assert.match(chTsx, /id="tc-se-challenge-summary"/,
    'the summary line carries a stable id the dapp.json check anchors on');
  // ITERATION 03 moved the tally into the shared season progress
  // ("3/9 done in Season 2" over one segment per challenge) rather than
  // "3 of 9 challenges completed". This pin moved with it, deliberately.
  // QA 2026-09-24 Q17: an event's tally says it is an event's.
  assert.match(chJs, /caption: name \? `done in this event · \$\{name\}` : 'done'/, 'and states the tally in words');
  assert.match(chJs, /progress: TopochainChallenges\._progressView\(doneCount, ordered\.length\)/,
    'which is what the summary line carries');
  assert.match(chTsx, /<SeasonProgress id="tc-se-challenge-summary"/,
    'drawn by the component Home shares');
  assert.match(chTsx, /\{g\.heading\}/,
    'the grouping subheading renders');
  assert.match(chJs, /heading: 'Completed'/,
    'and the module is what names it');
  // Suppressed when everything (or nothing) is finished — every public event
  // in production is currently 100% completed, where the heading says nothing.
  const fn = chJs.slice(chJs.indexOf('  gridView(ordered) {'), chJs.indexOf('  cardView(c, i) {'));
  assert.ok(fn.length > 0, 'gridView located');
  assert.match(fn, /firstDone > 0 && doneCount > 0/,
    'the subheading is gated on BOTH groups being non-empty');
  assert.match(chJs, /done: TopochainChallenges\._isDone\(c\)/,
    'the card descriptor carries the completed flag');
  // ITERATION 03 retired the dimming: a finished card is marked on its
  // progress rail and stays at full strength, so the pin moved from the
  // card's opacity to the rail's done recipe.
  assert.doesNotMatch(chTsx, /opacity-60/, 'completed cards are no longer dimmed');
  assert.match(chCardTsx,
    /done: 'bg-emerald-500\/10 text-emerald-700 dark:text-emerald-400'/,
    'completed cards carry the done rail instead');
  assert.match(chJs, /state: 'done', stateLabel: 'Done'/,
    'and the rail names the state in the board\'s word for it');
});

test('the standings pane cross-links to the challenges tab without ever painting an error', () => {
  const load = topoJs.slice(
    topoJs.indexOf('  async _loadChallengeCounts(eventId) {'),
    topoJs.indexOf('  // ── Rendering'));
  assert.ok(load.length > 0, '_loadChallengeCounts located');
  assert.ok(!/_error/.test(load),
    'a failed tally must never paint a banner over the standings table');
  assert.match(load, /_eventId\(\) !== eventId/,
    'and a fast event switch must not paint one event\'s tally over another');
  assert.match(standingsTsx, /id="tc-lb-challenge-link"/,
    'the line itself is rendered by the pane component');
  assert.match(standingsTsx, /id="tc-lb-to-challenges"/,
    'and carries the id the dapp.json check selects on');
  assert.match(topoJs, /counts\.total > 0/,
    'no line at all when the event has no challenges (never "0 of 0")');
  assert.match(topoJs, /window\.location\.hash = '#leaderboard\/challenges'/,
    'the link goes through the router, so the shared event selection survives');
});

// ─── Season aggregate vs per-event board (#999) ──────────────────────────
//
// The standings pane renders two DIFFERENT datasets through one table: one
// event's stored snapshots (`event.type === 'regular'`), or the whole
// season's aggregate (`'season'`, resolved server-side through
// computeStandings). The season path has no per-EVENT breakdown to report —
// the server hard-codes event_success_rate and friends to 0 — so a "Success
// rate" column there can only print "0%", indistinguishable from a real zero.
//
// Behavioural, not regex: run the real _renderBody against both payloads and
// diff the DESCRIPTOR it publishes. #1191 slice 6 conversion 5 moved the
// markup into ./topochain-standings.tsx, so what this reads changed from a
// host's innerHTML to the store's `body` — the decision under test (which
// columns exist for which board) is unchanged and still lives here.
//
// The module is still evaluated as a CLASSIC SCRIPT, which is the whole reason
// its store is planted rather than imported: an `import` line would make this
// harness a syntax error. Keep it that way.
function loadStandings() {
  // A stand-in for lib/plain-store.js — set() is the only method the
  // controller calls, and a fresh one per call keeps the two payloads apart.
  const store = {
    state: { mounted: false, body: null, drill: null },
    set(patch) { store.state = { ...store.state, ...patch }; },
    get: () => store.state,
    subscribe: () => () => {},
    setFlush: () => {},
  };
  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    console,
  };
  sandbox.window.document = sandbox.document;
  const TL = new Function('window', 'document', 'module',
    `${topoJs}\nreturn TopochainLeaderboard;`)(sandbox.window, sandbox.document, undefined);
  TL._store = store;
  return { TL, store };
}

function renderStandings(payload) {
  const { TL, store } = loadStandings();
  TL._open = true;
  TL._loading = false;
  TL._data = payload;
  TL._meta = { page: 1, per_page: 25, total: 1, total_pages: 1 };
  TL._renderBody();
  return store.state.body;
}

const SEASON_ROW = {
  rank: 1, is_non_podium: false, display_name: 'Ocank14', identifier: 'oca***',
  total_points: 67973.66, extra_points: 0, event_total_produced_blocks: 42,
  event_success_rate: 0, wallet_address: null, bech32m: null, discord: 'ocank14',
};

test('a standings row the server could not name reads "Anonymous", never just its points (#2394)', () => {
  // The server now names username-only accounts too, but an account with no
  // name at all (or only a generated topochain_<hex> handle) still arrives
  // with display_name null — and an empty User cell beside a points figure
  // is exactly what the issue reported.
  const view = renderStandings({
    event: { id: 8, name: 'Season 1 Beta', display_leaderboard: true, type: 'regular' },
    leaderboard: [SEASON_ROW, { ...SEASON_ROW, rank: 2, display_name: null, identifier: null, discord: null }],
  });
  assert.equal(view.rows[0].user, 'Ocank14', 'a named row is untouched');
  assert.equal(view.rows[1].user, 'Anonymous');

  const { TL } = loadStandings();
  TL._drillRow = { ...SEASON_ROW, display_name: null };
  assert.equal(TL.drillView().displayName, 'Anonymous', 'and so does its drill-down header');
});

test('the standings table drops the Success rate column on a season board', () => {
  const view = renderStandings({
    event: { id: 7, name: 'Season 1', display_leaderboard: true, type: 'season' },
    leaderboard: [SEASON_ROW],
  });
  assert.equal(view.state, 'table');
  assert.ok(!view.columns.includes('success'),
    'the season aggregate has no per-event success rate to report, so the '
    + 'column does not exist — it cannot print the hard-coded 0 as if measured');
  // The points and blocks columns are real on both paths and must survive.
  assert.deepEqual(view.columns, ['rank', 'user', 'points', 'blocks']);
  assert.equal(view.rows[0].points, '67973.66', 'the season total is the headline number');
  assert.equal(view.headers.blocks, 'Blocks produced', 'blocks IS a real season-wide sum');
  assert.equal(view.headers.points, 'Season points', 'the column says which total it is');
  assert.equal(view.isSeason, true);
});

test('the standings table keeps the Success rate column on a per-event board', () => {
  const view = renderStandings({
    event: { id: 8, name: 'Season 1 Beta', display_leaderboard: true, type: 'regular' },
    leaderboard: [{ ...SEASON_ROW, total_points: 1900, event_success_rate: 80 }],
  });
  assert.equal(view.state, 'table');
  assert.deepEqual(view.columns, ['rank', 'user', 'points', 'blocks', 'success'],
    'a single event measures it');
  assert.equal(view.headers.success, 'Success rate');
  assert.equal(view.rows[0].success, '80');
  assert.equal(view.headers.points, 'Points', 'and the points column is unqualified');
  assert.equal(view.isSeason, false);
});

test('the season board and the per-event board stay column-aligned', () => {
  // This used to count <th> against <td> in the rendered HTML, because the
  // string renderer dropped the success cell with TWO independent
  // conditionals and one could be edited without the other. The descriptor
  // makes that unrepresentable: there is a single `columns` list, and the
  // renderer maps over it once for the header row and once per body row. The
  // assertion is therefore structural — both maps read the same list.
  const view = renderStandings({
    event: { id: 7, name: 'Season 1', display_leaderboard: true, type: 'season' },
    leaderboard: [SEASON_ROW],
  });
  assert.equal(view.columns.length, 4, 'rank, user, season points, blocks');
  for (const c of view.columns) {
    assert.ok(view.headers[c], `every rendered column has a header (${c})`);
  }
  const maps = (standingsTsx.match(/view\.columns\.map\(/g) || []).length;
  assert.equal(maps, 2,
    'exactly two maps over the one column list — the header row and the body row; '
    + 'a third source of truth is how the table skewed before');
});

test('a standings row opens from the keyboard, and says what it opens', () => {
  // Like the Kudos rows: Tab reaches a row, Enter or Space opens its details,
  // and a screen reader hears "Open <user>'s details". The row keeps its
  // table semantics (no role override).
  const body = renderStandings({
    event: { id: 7, name: 'Season 1', display_leaderboard: true, type: 'season' },
    leaderboard: [SEASON_ROW],
  });
  const state = { mounted: true, body, drill: null };
  const store = { get: () => state, subscribe: () => () => {} };
  const mod = loadTsx('frontend/src/features/leaderboard/topochain-standings.tsx', {
    stubs: { './topochain-standings-store.js': { topochainStandingsStore: store } },
  });
  const out = renderToHtml(createElement(mod.TopochainStandingsPane, {}));
  const tr = out.match(/<tr[^>]*class="tc-lb-row[^>]*>/);
  assert.ok(tr, 'a body row renders');
  assert.match(tr[0], /tabindex="0"/, 'the row takes focus');
  assert.match(tr[0], /aria-label="Open Ocank14&#x27;s details"/, 'and is named after what it opens');
  assert.doesNotMatch(tr[0], /role=/, 'it stays a table row');
  assert.match(tr[0], /focus-visible:outline-violet-500/, 'with a visible focus ring');

  const row = standingsTsx.slice(standingsTsx.indexOf('<tr\n              key={row.index}'));
  assert.match(row,
    /onKeyDown=\{\(e\) => \{\s*if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{\s*e\.preventDefault\(\);\s*controller\(\)\?\._openRowAt\(row\.index\);/,
    'Enter and Space open the same details a click does');
});

test('the season caption replaces the "nothing is running" caption', () => {
  // The season event has usually ENDED by the time it is the default
  // (production's closed 2026-06-30), so hasEnded() is true for it and the
  // old caption would read "Nothing is running right now" above the very
  // board the screen exists to show. The two flags are mutually exclusive.
  assert.match(ctxJs, /_endedFallback\s*=\s*\n?\s*!TopochainEvents\.isSeasonAggregate\(pick\)/,
    'a season pick suppresses the ended-event caption rather than stacking with it');
  assert.match(barTsx, /Whole-season standings/, 'the season caption exists');
  // The caption must key off the SELECTION, not off "pickDefault landed
  // here": the standings pane's first fetch resolves the default server-side
  // and writes the id back silently, usually before this module's list lands,
  // so pickDefault never runs on most real loads. Keying off a flag set in
  // that branch left the caption missing exactly when it was needed.
  assert.match(ctxJs, /const isSeason = TopochainEventContext\.isSeasonSelected\(\);[\s\S]*?seasonNote: isSeason,/,
    'the caption renders from isSeasonSelected(), not from a default-pick flag');
  assert.match(barTsx, /hero\.seasonNote \? \([\s\S]{0,200}?id="tc-ev-season-note"/,
    'and the component draws it from that one field');
  assert.ok(!/_seasonDefault/.test(ctxJs),
    'the default-pick flag is gone — the selection is the single source of truth');
  // The picker and the hero must not label the season event "(past)".
  assert.match(ctxJs, /if \(isSeason\) return ' \(season\)';/, 'the option reads (season)');
  assert.match(ctxJs, /const statusLabel = isSeason \? 'season'/, 'so does the hero badge');
});

test('both #981 checks are declared and the reader keeps them', () => {
  // This used to assert POSITION: the reader kept only the first MAX_TESTS
  // entries, so a check appended at the bottom of dapp.json was decoration —
  // declared, never parsed, never run. #1019 ended that; every declared
  // check runs through the capture pool and the only bound left is
  // MAX_DECLARED_TESTS, a ceiling this repo is nowhere near.
  //
  // So the assertion that still means something is not "these two are near
  // the top" but "the reader kept them and refused NOTHING for ceiling
  // reasons" — which is what would break if the manifest ever grew past the
  // ceiling and started silently shedding its tail again.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(manifest);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'the tail is being dropped again, which is exactly the bug #1019 fixed');
  const kept = meta.tests;
  const summary = kept.find((t) => t.path === '/#leaderboard/challenges');
  const crossLink = kept.find((t) => t.path === '/#leaderboard/topochain');
  assert.ok(summary, 'the challenges-summary check must survive the reader');
  assert.ok(crossLink, 'the standings cross-link check must survive the reader');
  assert.match(summary.expectSelector, /#tc-se-challenge-summary/);
  assert.match(crossLink.expectSelector, /#tc-lb-to-challenges/);

  // Both of these paths already had a check, and two suites locate those by
  // path with `.find()` — so ours, sitting earlier in the array, SHADOWS
  // them. It therefore has to carry their assertions too, or moving a check
  // to the top of the array silently weakens what the older ones pinned.
  assert.match(crossLink.expectSelector, /\[data-standings-tab="challenges"\]/,
    'the shadowing /#leaderboard/topochain check must still assert the three-tab strip');
  // #2374 moved the cross-link check off the bare hash when Challenges became
  // the default, which leaves the bare-hash check the FIRST /#leaderboard
  // entry — the one tests/topochain-screens.test.js finds — so it carries
  // the strip assertion in its own right.
  const bare = kept.find((t) => t.path === '/#leaderboard');
  assert.ok(bare, 'the bare /#leaderboard check must survive the reader');
  assert.match(bare.expectSelector, /\[data-standings-tab="challenges"\]/,
    'the canonical /#leaderboard check asserts the three-tab strip');
  assert.match(bare.expectSelector, /#challenges-root:not\(\.hidden\)/,
    'and that the bare hash opens on Challenges');

  // #999 rides on this SAME entry rather than declaring its own. The cap is
  // full of load-bearing checks — every one of the ten is pinned by a suite
  // like this — so two new entries at the top would have silently pushed the
  // #911 and #947 home-panel checks out of the parse window and broken their
  // guards. Same route, one more assertion, nothing displaced: the default
  // standings board must be the whole-season one.
  assert.equal(crossLink.expectText, 'Whole-season standings',
    'the /#leaderboard/topochain check must also assert the season board is the default');
  assert.match(summary.expectSelector, /#challenges-root:not\(\.hidden\)/,
    'and the shadowing /#leaderboard/challenges check the revealed pane');
});

test('the challenge-detail screenshot deep link is scoped to its one param', () => {
  const fn = chJs.slice(chJs.indexOf('  _maybeShot(ordered) {'), chJs.indexOf('  // ── Challenge detail overlay'));
  assert.ok(fn.length > 0, '_maybeShot located');
  assert.match(fn, /shot !== 'challenge-detail'/,
    "a real user's grid never auto-opens an overlay");
  assert.match(fn, /_shotFired/, 'and it fires at most once per page load');
});

// ─── dapp.json ───────────────────────────────────────────────────────────

test('dapp.json checks the canonical routes and every legacy alias', () => {
  const tests = manifest.tests || [];
  const canonical = tests.find((t) => t.path === '/#leaderboard');
  assert.ok(canonical, 'a check renders /#leaderboard');
  assert.match(canonical.expectSelector, /\[data-standings-tab="challenges"\]/,
    'and asserts the third tab is actually rendered');

  for (const p of ['/#topochain/leaderboard', '/#topochain/seasons', '/#challenges',
    '/#leaderboard/challenges']) {
    assert.ok(tests.some((t) => t.path === p), `a check exercises ${p}`);
  }

  // The way IN. It was a hamburger row until THE UI OVERHAUL, which moved it
  // to the home screen's Challenges area — beside the shared progress it
  // links to, rather than in a menu you open from memory.
  const entryPoint = tests.find(
    (t) => typeof t.expectSelector === 'string'
      && t.expectSelector.includes('#home-challenges-section')
      && t.expectSelector.includes('home-panel-lb-browse')
  );
  assert.ok(entryPoint, 'a check asserts the Challenges area\'s leaderboard link renders');
  assert.ok(!tests.some((t) => typeof t.expectSelector === 'string'
    && t.expectSelector.includes('#drawer-row-leaderboard')),
  'and nothing still selects the retired drawer row');

  const shot = tests.find((t) => t.path === '/?shot=challenge-detail#leaderboard/challenges');
  assert.ok(shot, 'a check exercises the challenge-detail screenshot state');
  assert.match(shot.expectSelector, /#tc-se-detail-overlay:not\(\.hidden\)/,
    'and asserts the overlay is actually open');

  const eventBar = tests.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes('#tc-ev-select')
  );
  assert.ok(eventBar, 'a check asserts the shared event picker renders');
});


// ── The cross-link's tally is the VIEWER's, not the organiser's ────────
//
// It counted `challenge.completed` — the organiser's "this challenge is over"
// flag — and called the result "challenges completed". Home, reading the same
// event at the same moment, said "4/9 done" for the viewer's own progress.
// Two correct numbers, one word, and a contradiction on screen.

test('the standings tally counts the viewer\'s progress, in the word Home uses', () => {
  const load = topoJs.slice(topoJs.indexOf('  async _loadChallengeCounts('),
    topoJs.indexOf('  // ── Rendering'));
  assert.ok(load.length > 0, '_loadChallengeCounts located');

  assert.doesNotMatch(load, /c\.completed === true/,
    'the organiser\'s closed flag is not the viewer\'s progress');
  assert.match(load, /c\.progress && c\.progress\.done === true/,
    'the tally counts done-ness per row');
  assert.match(standingsTsx, /challenges done/,
    'and says "done", the word Home uses for this same number');
  assert.doesNotMatch(standingsTsx, /challenges completed/,
    'never "completed", which on a challenge row means the organiser closed it');
});

test('a signed-out reader gets the cross-link without a tally that is not theirs', () => {
  const load = topoJs.slice(topoJs.indexOf('  async _loadChallengeCounts('),
    topoJs.indexOf('  // ── Rendering'));
  assert.match(load, /const signedIn = data\.data\.some\(\(c\) => c && c\.progress\)/,
    'progress rides along per row for a signed-in viewer only, which is the signal');
  assert.match(load, /done: signedIn/, 'so the tally is null when nobody is signed in');
  assert.match(standingsTsx, /line\.done == null \? null :/,
    'and the line renders the link alone rather than a zero read as the reader\'s own');
  // The declared check anchors on the link INSIDE the paragraph, so the
  // paragraph must survive a null tally.
  assert.match(standingsTsx, /id="tc-lb-challenge-link"/);
  assert.match(standingsTsx, /id="tc-lb-to-challenges"/);
});

// #2991: the History filter chips said which one was on by fill colour only.
// aria-pressed carries the same state to assistive tech, and type="button"
// keeps a chip from ever submitting an enclosing form.
test('the Kudos History filter chips expose their on-state as aria-pressed (#2991)', () => {
  const state = {
    mounted: true,
    chrome: null,
    body: {
      kind: 'history',
      chips: [
        { key: 'given', label: 'Given', on: true },
        { key: 'received', label: 'Received', on: false },
      ],
      list: { kind: 'empty', message: 'Nothing yet.' },
      more: null,
    },
  };
  const mod = loadTsx('frontend/src/features/leaderboard/kudos-pane.tsx', {
    stubs: {
      './kudos-pane-store.js': {
        kudosPaneStore: { get: () => state, subscribe: () => () => {} },
      },
    },
  });
  const out = renderToHtml(createElement(mod.KudosPane, {}));
  const chip = (key) => {
    const m = out.match(new RegExp(`<button[^>]*data-lb-hfilter="${key}"[^>]*>`));
    assert.ok(m, `the ${key} chip renders`);
    return m[0];
  };
  assert.match(chip('given'), /aria-pressed="true"/);
  assert.match(chip('received'), /aria-pressed="false"/);
  for (const key of ['given', 'received']) assert.match(chip(key), /type="button"/);
  // The colour treatment is unchanged: the attribute is added, not swapped in.
  assert.match(chip('given'), /bg-violet-600 text-white/);
});

// QA 2026-09-24 Q21: the section strip scrolls sideways on a narrow phone
// with its scrollbar hidden, so the edge that has more beyond it fades. The
// first render carries no style (the prerender's markup), and a strip that
// fits never gets a mask.
test('QA 2026-09-24 Q21: the scrolling strips fade the edge that has more', () => {
  const { scrollFadeStyle, SCROLL_FADE_PX } = loadTsx('frontend/src/lib/use-scroll-fade.ts');
  assert.equal(scrollFadeStyle({ start: false, end: false }), undefined, 'fits: no mask at all');
  const end = scrollFadeStyle({ start: false, end: true });
  assert.equal(end.maskImage, `linear-gradient(to right, #000 0, #000 calc(100% - ${SCROLL_FADE_PX}px), transparent 100%)`);
  assert.equal(end.WebkitMaskImage, end.maskImage);
  assert.equal(scrollFadeStyle({ start: true, end: false }).maskImage,
    `linear-gradient(to right, transparent 0, #000 ${SCROLL_FADE_PX}px, #000 100%)`);
  assert.match(scrollFadeStyle({ start: true, end: true }).maskImage, /^linear-gradient\(to right, transparent 0, #000 20px, #000 calc\(100% - 20px\), transparent 100%\)$/);
  const hook = fs.readFileSync(path.join(__dirname, '../frontend/src/lib/use-scroll-fade.ts'), 'utf8');
  assert.match(hook, /useState<Edges>\(\{ start: false, end: false \}\)/, 'nothing measured before mount');
  assert.doesNotMatch(hook, /\.scrollIntoView\(/, 'the strip scrolls itself, never the page');
  const pane = fs.readFileSync(path.join(__dirname, '../frontend/src/features/leaderboard/kudos-pane.tsx'), 'utf8');
  assert.match(pane, /<TabsList ref=\{subRef\} className=\{SUB_TABS_LIST\} style=\{subFade\}>/, 'the Kudos sub-strip fades too');
  assert.match(pane, /const TAB_ROW = 'flex flex-col items-start gap-2 mb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3';/,
    'below sm the sub-tabs and the window pills stack');
});
