// The Board's columns fold their cards (#1787).
//
// The four kanban columns drew every card at full size — head, meta line,
// status band, action band, ⋯ — which is what made a busy board busy. They
// draw the Workshop's one-line row now and unfold the one you tap into the
// dense card, in place, through the same fold the Workshop uses
// (frontend/src/features/dev-board/card/fold.tsx). This file pins:
//
//   * every card row renders folded, carrying the item's data-*-row hook;
//   * `?cards=open` renders every card at full size, hooks intact — the
//     board as it was, and the state the checks that read a card's anatomy
//     run in;
//   * the column owns which card is open, one per column;
//   * the delegated #dev-body open handler stands aside inside a fold;
//   * `?shot=board-unfold` taps the first folded row for the capture;
//   * the declared checks that reach into a board card's anatomy carry
//     `cards=open`, and two pin the fold itself.
//
// Run with: node --test tests/dev-board-fold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const KANBAN = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const LIST_ROWS = read('frontend/src/features/dev-board/card/list-rows.tsx');
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));

const at = (d) => new Date(Date.now() - d * 86400000).toISOString();

// app-view.js in a vm, with a `location` the board's URL states are read
// from. Same shape as tests/dev-kanban-buckets.test.js's sandbox.
function makeAppView({ search = '' } = {}) {
  const sandbox = {
    console, relTime: () => '2h ago',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum', _appUrl: () => '#x', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search, hash: '', href: `http://localhost/${search}` }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._ghIssues = [
    { number: 1575, title: 'Replace the oversized Game Corner header with bottom tabs', createdAt: at(4), updatedAt: at(2), lastMessageAt: at(2), user: 'sam', htmlUrl: 'x', assignee: { top: 'priya' } },
    { number: 1574, title: 'Cut the Game Corner header’s self-explanation', createdAt: at(4), updatedAt: at(3), lastMessageAt: null, user: 'sam', htmlUrl: 'x' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 1540, pr_title: 'Rewrite the email-confirmation email around one clear CTA',
    pr_url: 'https://github.com/acme/app/pull/1540',
    status: 'promoted', username: 'evan', created_at: at(1), promoted_at: at(1), last_message_at: at(1),
    linked_issues: [], my_vote: null, votes_for: 3, votes_against: 1, yes_count: 3, no_count: 1,
    checks_state: 'success', checks_total: 412, checks_passed: 412, message_count: 5,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 1572, pr_title: 'Add screen transitions to Game Corner', status: 'merged',
    username: 'alice', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 2, activeUsers: 7 };
  AppView._mergedTotal = 1; AppView._mergedHasMore = false;
  AppView._mySessions = []; AppView._sharedSessions = []; AppView._devDataReady = true;
  return AppView;
}

const cardRowsOf = (view) => view.cols.reduce((n, c) => n + c.rows.filter((r) => r.t === 'card').length, 0);
const count = (html, re) => (html.match(re) || []).length;

test('every board card draws folded: one row per card, no card face, the item’s hook on the row', () => {
  const AppView = makeAppView();
  const view = AppView._kanbanView();
  const cards = cardRowsOf(view);
  assert.ok(cards >= 4, `the fixture fills the columns (${cards})`);
  assert.equal(view.unfolded, false);

  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-rowwrap"/g), cards, 'one fold wrapper per card');
  assert.equal(count(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"/g), 0, 'and none of them open');
  assert.ok(!html.includes('gc-vote-item'), 'no card face is drawn while everything is folded');
  assert.equal(count(html, /class="dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800"[^>]*aria-expanded="false"/g), cards,
    'each row is a closed disclosure wearing the card’s own hover');
  // The hooks the checks and the lookups name an item by ride on the row.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-ws-row="issue:1575"[^>]*data-issue-row="1575"/);
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-ws-row="proposal:34"[^>]*data-proposal-row="34"/);
  // And the row keeps the card's edge and number, as on the Workshop — the
  // number as the card's own link, from the card's own meta line.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="[a-z]+"[^>]*data-ws-row="issue:1575"/);
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*"[^>]*class="font-mono[^"]*"[^>]*>#1575<\/a>/);
  assert.match(html, /<span class="dev-ws-row-meta"><a href="[^"]*"[^>]*class="font-mono[^"]*"[^>]*>PR#1540<\/a> · evan · /,
    'number · author · when, dotted as the card writes them');
  // The proposal's vote rides on its row's LAST line, at the right end, as
  // the Workshop's rows carry it and as the card's bar puts it.
  assert.match(html, /data-ws-row="proposal:34"[\s\S]*?<span class="dev-ws-row-band">[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/);
});

test('?cards=open draws every card at full size, hooks intact: the board as it was', () => {
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  const view = AppView._kanbanView();
  assert.equal(view.unfolded, true);
  const cards = cardRowsOf(view);

  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"/g), cards, 'every wrapper open');
  assert.equal(count(html, /class="dev-ws-row hover/g), 0, 'and no folded row drawn beside a card');
  assert.equal(count(html, /class="gc-vote-item [^"]*dev-card-dense"/g), cards, 'the dense card, once per item');
  // "Open card", on every open card, in the action band after the card's
  // own pills and before the hamburger — the seat the Workshop's open card
  // uses too, so the two surfaces draw one card. Not on the facts line:
  // that seat moves the card's actions up beside it, which a ~300px column
  // cannot hold. The pills stay in their band (the checks that read it
  // still resolve), every one of them foldable, and the band's own
  // measurement folds them into the menu around the fixed controls.
  //
  // On the Board it is a LINK to the item's page, not the in-place toggle
  // the Workshop draws: a column is the wrong width for the ledger and the
  // transcript, and the page is one tap away. It also works on every kind —
  // the in-place body exists for issues and proposals only, so on a
  // session, a merged change or a governance item the toggle did nothing.
  assert.equal(count(html, /class="gc-vote-btn dev-ws-open-btn"/g), cards, 'each open card offers Open card');
  assert.equal(count(html, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/[a-z]+\/\d+" data-ws-open-card="[a-z-]+:\d+">Open card<\/a>/g), cards,
    'as a link to the item\u2019s page');
  assert.equal(count(html, /class="gc-card-actions"[^>]*>(?:(?!<\/div>)[\s\S])*?class="gc-vote-btn dev-ws-open-btn"/g), cards,
    'and it sits inside the action band');
  assert.ok(!/dev-card-status-end"[^>]*>(?:(?!<\/span>)[\s\S])*?dev-ws-open-btn/.test(html), 'not on the facts line');
  assert.ok(!/dev-ws-open-btn"[^>]*aria-expanded/.test(html), 'and never the in-place toggle here');
  assert.match(html, /class="gc-card-actions"><button class="gc-vote-btn"(?=[^>]*data-fold="1")[^>]*data-act="chooseIssueWork">Start work<\/button><button class="gc-vote-btn"(?=[^>]*data-fold="2")[^>]*data-act="markIssueInProgress">[^<]*<\/button><a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/issues\/1575"[^>]*>Open card<\/a><button [^>]*dev-card-menu-btn"[^>]*data-card-menu=/,
    'the card\u2019s own pills come first, each marked foldable, then the link, then the hamburger');
  // A card with nothing in its status band still drops the band (#1139):
  // the toggle is not in it.
  assert.match(html, /data-empty="1"/);
  // The open card is a DIRECT child of the sheet, which is a direct child of
  // the wrapper — the declared unfold check selects it that way.
  assert.match(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet"[^>]*><div class="gc-vote-item [^"]*dev-card-dense"/);
  // The card keeps its hooks: the checks that read a card's anatomy name the
  // item by them, and nothing strips them any more.
  assert.match(html, /class="gc-vote-item [^"]*dev-card-dense"[^>]*data-issue-row="1575"/);
  assert.match(html, /class="gc-vote-item [^"]*dev-card-dense"[^>]*data-proposal-row="34"/);
  // The way out to the item's own page is the pill itself, so the sheet
  // draws no "Open on its own page" line under the card here.
  assert.match(html, /<a class="gc-vote-btn dev-ws-open-btn" href="#app\/demo-app\/dev\/proposals\/34"/);
  assert.ok(!html.includes('dev-ws-link'), 'no second link under the card');
  assert.ok(!html.includes('dev-ws-sheet-actions'));
});

test('the view carries what the open card needs, and reads ?cards=open per build', () => {
  const AppView = makeAppView();
  const v = AppView._kanbanView();
  assert.equal(v.slug, 'demo-app');
  assert.equal(v.canPost, true);
  assert.equal(v.unfolded, false);
  assert.equal(AppView._cardsOpen(), false);
  // A sandbox with no location at all answers false rather than throwing —
  // the other board tests' sandboxes have none.
  const bare = makeAppView();
  bare._cardsOpen = AppView._cardsOpen;
  assert.equal(typeof bare._cardsOpen(), 'boolean');
});

test('the column owns which card is open, one per column, through the shared fold', () => {
  // State in the component, not the view model: the WS-driven republishes
  // that repaint the board must not fold what somebody has open.
  assert.match(KANBAN, /const \[openKey, setOpenKey\] = useState<string \| null>\(null\);/);
  assert.match(KANBAN, /open: unfolded \|\| openKey === row\.key,/);
  assert.match(KANBAN, /onToggle: \(\) => setOpenKey\(\(k\) => \(k === row\.key \? null : row\.key\)\),/);
  assert.match(KANBAN, /slug=\{v\.slug \|\| ''\}/);
  assert.match(KANBAN, /unfolded=\{!!v\.unfolded\}/);
  assert.match(KANBAN, /detail: 'actions',/, 'the Board seats Open card in the action band');
  assert.match(KANBAN, /sessionLink: false,/, 'and draws no session line under a column card');
  assert.match(LIST_ROWS, /detail=\{fold\.detail\} sessionLink=\{fold\.sessionLink\}/);
  // #1884 round two: "Open card" LEADS to the item's page on both surfaces,
  // so there is no mode to pass and no branch to take — one anchor, one
  // label, whichever screen the card was reached from.
  assert.ok(!/OpenMode|expand[?:]/.test(FOLD), 'no open mode left to choose');
  assert.match(FOLD, /const openBtn = placement && href\s*\? <a className="gc-vote-btn dev-ws-open-btn" href=\{href\} data-ws-open-card=\{row\.key\}>Open card<\/a>\s*: undefined;/);
  // #1886: no page link under the sheet any more — the Workshop's pill is
  // the page link once the card is open. The one line the sheet still draws
  // is #1887's, on a card about the viewer's OWN session: the session is a
  // destination the pill does not cover, so it keeps a link under the sheet
  // — on the Workshop only, and alone on its line.
  assert.ok(!/>Open on its own page/.test(FOLD), 'no "Open on its own page" line under the sheet');
  assert.ok(!/href=\{href\} className="dev-ws-link"/.test(FOLD), 'the page href rides no link under the sheet');
  assert.equal(count(FOLD, /dev-ws-sheet-actions/g), 1, 'one line under the sheet, and it is the session\u2019s');
  assert.match(FOLD, /\{session && sessionLink \? \((?:\s*\/\/[^\n]*)*\s*<div className="dev-ws-sheet-actions">\s*<a href=\{session\} className="dev-ws-link" data-ws-open-session=\{row\.key\}>Open session ›<\/a>\s*<\/div>\s*\) : null\}/,
    'the session link, on the Workshop, and nothing beside it');
  const unfolded = FOLD.slice(FOLD.indexOf('export function UnfoldedRow'), FOLD.indexOf('export function voteSpecs'));
  assert.ok(!/\{'Open page ›'\}|'Close card' : 'Open card'/.test(unfolded),
    'and no second step: the pill is the page link on its first tap');
  assert.match(FOLD, /detail: placement = 'actions',/, 'and the Workshop, passing nothing, gets the same seat');
  assert.match(FOLD, /<DevCard model=\{card\} actionEnd=\{placement \? openBtn : undefined\} headEnd=\{<FoldMark open onClick=\{onFold\} \/>\} \/>/);
  // The seat itself: DevCard renders `actionEnd` after its own pills and
  // before the hamburger and Preview, and the fold measurement counts all
  // three as fixed children (no data-fold).
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(CARD, /const hasActions = bandPrimary\.length > 0 \|\| !!actionEnd \|\| !!menuTrigger \|\| !!bandPreview;/);
  assert.match(CARD, /\{actionEnd\}\s*\{bandPreview\}\s*\{menuTrigger\}\s*<\/div>/);
  assert.match(CARD, /if \(k\.dataset\.fold \|\| k === host\) continue;\s*used \+= k\.offsetWidth/, 'a child without data-fold is counted as used width (the kudos host apart: its pill is measured through it)');
  // A merged card's kudos slot is legacy-filled after every publish; a fold
  // happens between publishes, so the column re-runs the filler.
  assert.match(KANBAN, /const host = hostRef\.current;\s*if \(!host\) return;\s*callAppView\('_fillKudosHosts', host\);/);
  // The row renderer hands a card to the fold when it is given one, and
  // draws the plain card otherwise.
  assert.match(LIST_ROWS, /<CardRowView row=\{row\} slug=\{fold\.slug\} canPost=\{fold\.canPost\} open=\{fold\.open\} onToggle=\{fold\.onToggle\} detail=\{fold\.detail\} sessionLink=\{fold\.sessionLink\} \/>/);
  assert.match(LIST_ROWS, /: <DevCard model=\{row\.card\} \/>/);
  // And the Workshop draws its rows from the SAME module — no second copy.
  // (`openHref` rides the same import since the Needs-you feed: its item title
  // links to the card's own page by the fold's rule, not a second one.)
  assert.match(WORKSHOP, /import \{ CardRowView, callAppView, openHref \} from '\.\.\/card\/fold';/);
  for (const fn of ['function FoldedRow', 'function UnfoldedRow', 'function CardRowView', 'function RowBand']) {
    assert.ok(FOLD.includes(fn), `${fn} lives in fold.tsx`);
    assert.ok(!WORKSHOP.includes(fn), `${fn} is not also in workshop.tsx`);
  }
});

test('the delegated #dev-body open handler leaves a fold’s clicks and keys to the fold', () => {
  // ANCHORED TO THE HANDLER, not to the control guard. This used to slice
  // from `a, button, input, form` and look for the fold check after it,
  // which pinned a relative position the rule never cared about: #2361
  // hoisted the fold check ABOVE that guard so the discussion row's branch
  // could sit between the two (the row is a `<button>`, so the guard was
  // eating it). The fold check moved earlier, which is the same rule, and
  // the old anchor could not tell the difference between that and its
  // deletion.
  const body = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf("bodyEl.addEventListener('click'"));
  const click = body.slice(0, body.indexOf('{ signal: devBodySignal }'));
  const guard = click.indexOf('if (AppView._inFoldWrapper(e)) return;');
  assert.ok(guard > 0, 'the click handler asks whether the event was inside a wrapper');
  // Before it reads ANY of the item hooks, which both sizes now carry — all
  // six, so a hook added to a branch below cannot quietly escape the fold.
  for (const hook of ['data-session-chip', 'data-shared-session-row', 'data-discussion-row',
    'data-issue-row', 'data-proposal-row', 'data-gov-row']) {
    const at = click.indexOf(`e.target.closest('[${hook}]')`);
    assert.ok(at > 0, `the handler reads ${hook}`);
    assert.ok(guard < at, `and asks about the fold before reading ${hook}`);
  }
  assert.match(APP_VIEW_SRC, /if \(AppView\._inFoldWrapper\(ev\)\) return;/,
    'and the keydown handler, which would otherwise open a session on the Enter that toggles its row');
  // The folded row carries the hooks, so a lookup by hook finds it either way.
  assert.match(FOLD, /const ITEM_HOOKS = \[\s*'data-issue-row', 'data-proposal-row', 'data-gov-row',\s*'data-shared-session-row', 'data-session-chip', 'data-discussion-row',\s*\];/);
  assert.match(FOLD, /\{\.\.\.itemHooks\(c\)\}/);
});

test('the guard reads the event’s composed path, because the target is detached by the time it runs', () => {
  // The fold's React listener sits on the portal host BELOW #dev-body and
  // flushes its state update in a microtask, which a real click runs between
  // listeners: when the event reaches #dev-body the clicked row has already
  // been swapped for the card. `closest()` from that detached node finds no
  // wrapper, and the row's own data-issue-row hook opened the item
  // full-screen — on production, after the fold merged. The composed path is
  // captured at dispatch and still holds the ancestors the target had.
  const AppView = makeAppView();
  const wrapper = { classList: { contains: (c) => c === 'dev-ws-rowwrap' } };
  const column = { classList: { contains: () => false } };
  // A detached row: no ancestors to walk, but the path remembers the wrapper.
  const detachedRow = { closest: () => null };
  assert.equal(AppView._inFoldWrapper({ target: detachedRow, composedPath: () => [detachedRow, wrapper, column] }), true,
    'a click whose path passed through a wrapper is the fold\u2019s, attached or not');
  assert.equal(AppView._inFoldWrapper({ target: detachedRow, composedPath: () => [detachedRow, column] }), false,
    'a click that never passed through one is not');
  // Nodes without a classList (the document, the window) sit on every path.
  assert.equal(AppView._inFoldWrapper({ target: detachedRow, composedPath: () => [detachedRow, {}, null, column] }), false);
  // No composedPath at all: fall back to the ancestors the target still has.
  const attachedRow = { closest: (sel) => (sel === '.dev-ws-rowwrap' ? wrapper : null) };
  assert.equal(AppView._inFoldWrapper({ target: attachedRow }), true);
  assert.equal(AppView._inFoldWrapper({ target: detachedRow }), false);
  assert.equal(AppView._inFoldWrapper(null), false);
  // And the handlers no longer ask the target for its ancestors at all.
  assert.ok(!/e\.target\.closest\('\.dev-ws-rowwrap'\)/.test(APP_VIEW_SRC));
  assert.ok(!/ev\.target\.closest\('\.dev-ws-rowwrap'\)/.test(APP_VIEW_SRC));
});

test('?shot=board-unfold taps the first folded row, through the real event path', () => {
  const from = APP_VIEW_SRC.indexOf("if (shot === 'board-unfold') {");
  assert.ok(from > 0);
  const block = APP_VIEW_SRC.slice(from, APP_VIEW_SRC.indexOf("if (shot === 'feed-comments') {", from));
  assert.match(block, /document\.querySelector\('#dev-kanban \.dev-ws-rowwrap-open'\)/, 'stops once a card is up');
  assert.match(block, /const row = document\.querySelector\('#dev-kanban \.dev-ws-row'\);/);
  assert.match(block, /if \(row\) row\.click\(\);/, 'a click, not a state poke: the fold’s own handler must take it');
  assert.match(block, /if \(!e \|\| e\.isTrusted\) done\(\);/, 'a human’s first real gesture ends the window');
  assert.match(block, /\(tries \+= 1\) > 40/, 'and it is capped');
});

test('the fold mark: the same two chevrons at both sizes, stretched open on the card, and the button that folds it', () => {
  // Folded: every row wears the closed mark — decoration, on a row that is
  // itself the disclosure control — as the row's last child.
  const closed = makeAppView();
  const cards = cardRowsOf(closed._kanbanView());
  const html = kanbanHtml(closed);
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path class="dev-fold-top" d="M8.25 9L12 5.25 15.75 9"></path><path class="dev-fold-bar" d="M12 5.5v13"></path><path class="dev-fold-bottom" d="M8.25 15L12 18.75 15.75 15"></path></svg>';
  assert.equal(count(html, new RegExp(esc('<span class="dev-fold-mark" aria-hidden="true">' + GLYPH + '</span></div>'), 'g')), cards,
    'one closed mark per row, closing the row');
  assert.ok(!html.includes('data-open='), 'nothing folded wears the open mark');
  // Open: the card wears the SAME three paths, stretched by attribute, as the
  // button that folds it — at the head's end, before the meta line.
  const open = makeAppView({ search: '?cards=open&demo=1' });
  const n = cardRowsOf(open._kanbanView());
  const openHtml = kanbanHtml(open);
  assert.equal(count(openHtml, new RegExp(esc('<button type="button" class="dev-fold-mark" data-open="1" aria-expanded="true" aria-label="Fold the card">' + GLYPH + '</button></div><div class="dev-card-meta">'), 'g')), n,
    'one open mark per card, closing the head');
  assert.ok(!openHtml.includes('<span class="dev-fold-mark"'), 'and no closed mark beside it');
  // The button folds through the fold's own toggle: the wrapper's
  // click-anywhere guard excludes buttons, so the mark must carry it.
  assert.match(FOLD, /<UnfoldedRow [^>]*onFold=\{onToggle\} \/>/);
  assert.match(FOLD, /headEnd=\{<FoldMark open onClick=\{onFold\} \/>\}/);
  // Geometry: absolute, at the same spot at both sizes, so on open the mark
  // does not move — it stretches — and only the title keeps clear of it.
  assert.match(CSS, /\.dev-ws-row, \.dev-ws-sheet > div:is\(\.dev-card-dense, \.dev-card-topic\) \{ position: relative; \}/);
  assert.match(CSS, /\.dev-ws-row-title, \.dev-ws-sheet \.dev-card-title \{ padding-right: 22px; \}/);
  assert.match(CSS, /\.dev-fold-mark \{\n  position: absolute; top: 15px; right: 14px; width: 16px; height: 16px;/);
  assert.match(CSS, /\.dev-fold-mark \.dev-fold-bar \{ transform: scaleY\(0\); \}/, 'closed: the bar scaled away');
  assert.match(CSS, /\.dev-fold-mark\[data-open="1"\] \.dev-fold-top \{ transform: translateY\(-2px\); animation: dev-fold-top \.15s ease both; \}/);
  assert.match(CSS, /\.dev-fold-mark\[data-open="1"\] \.dev-fold-bottom \{ transform: translateY\(2px\); animation: dev-fold-bottom \.15s ease both; \}/);
  assert.match(CSS, /\.dev-fold-mark\[data-open="1"\] \.dev-fold-bar \{ transform: scaleY\(1\); animation: dev-fold-bar \.15s ease both; \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.dev-fold-mark path \{ animation: none; \} \}/);
  assert.ok(!/dev-fold[^\n]*rotate/.test(CSS), 'nothing on it rotates: what changes is size');
  // Declared, one check per state, on the board.
  const checks = DAPP.tests.filter((t) => /fold mark/.test(t.name));
  assert.equal(checks.length, 2);
  assert.match(checks[0].expectSelector, /span\.dev-fold-mark\[aria-hidden="true"\]:not\(\[data-open\]\)/);
  assert.match(checks[1].expectSelector, /button\.dev-fold-mark\[data-open="1"\]\[aria-expanded="true"\]\[aria-label\]/);
});

test('the declared checks that read a board card’s anatomy run with the cards open; two pin the fold', () => {
  const anatomy = /gc-vote-item|dev-card-|gc-card-actions|data-card-menu|attr-chip|dc-status-spinner|gc-merging-badge|gc-checks-running-badge|dev-badge|dev-status-pill|dev-chat-badge|dev-vote-btn/;
  const board = /#app\/usernode-2d5619\/board|view=kanban|col=(issues|inprogress|inreview|done)/;
  const offenders = [];
  let moved = 0;
  for (const t of DAPP.tests) {
    const p = t.path || '';
    const sel = t.expectSelector || '';
    if (/workshop/.test(p) || /#gc-thread-head/.test(sel) || /\/(governance|issues|proposals)\//.test(p)) continue;
    if (!board.test(p) || !anatomy.test(sel)) continue;
    // A check that selects the folded row, or taps one open, is about the
    // fold itself and runs in the default state on purpose.
    if (/dev-ws-row\b/.test(sel) || /shot=board-unfold/.test(p)) continue;
    if (!/[?&]cards=open(&|#|$)/.test(p)) offenders.push(t.name);
    else moved += 1;
  }
  assert.deepEqual(offenders, [], 'a check that reaches into a board card must ask for the cards open');
  assert.ok(moved >= 20, `and a good number do (${moved})`);
  // The ⋯ menu shots on the BOARD need a trigger to tap, and a trigger is on
  // the card. (The home screen's app cards have a ⋯ too; those do not fold.)
  for (const t of DAPP.tests) {
    const p = t.path || '';
    if (/shot=card-menu/.test(p) && board.test(p)) assert.match(p, /cards=open/, `${t.name} runs with the cards open`);
  }
  // Two text checks read what only the card says: a chip past the row's
  // three, and the close card's body.
  for (const name of ['Custom category chip renders on a Dev card (#780)',
    'Applied close-issue proposal renders as an Issue close card in Completed/Done']) {
    const t = DAPP.tests.find((x) => x.name === name);
    assert.ok(t && /cards=open/.test(t.path), `${name} runs with the cards open`);
  }

  const folded = DAPP.tests.find((t) => t.name === '#app/<slug>/board resolves onto the stage pane, its cards folded to rows');
  assert.ok(folded, 'the board route check pins the fold');
  assert.equal(folded.path, '/?demo=1#app/usernode-2d5619/board', 'with no cards=open: this IS the default');
  // The host moved with the surface: the Board view mode retired and those
  // columns are the Workshop's stage pane, so the chain is anchored on
  // `[data-ws-stage]` rather than on the standalone board's own #dev-kanban-board.
  assert.match(folded.expectSelector, /\[data-ws-stage\] #dev-kanban \.dev-kanban-col \.dev-ws-rowwrap > \.dev-ws-row\[role="button"\]\[aria-expanded="false"\]\[data-issue-row\]/);

  const unfold = DAPP.tests.find((t) => /shot=board-unfold/.test(t.path || ''));
  assert.ok(unfold, 'one check taps a row open');
  assert.match(unfold.expectSelector, /\.dev-ws-rowwrap-open > \.dev-ws-sheet > \.gc-vote-item\.dev-card-dense\[data-edge\] \.gc-card-actions > a\.dev-ws-open-btn\[href\*="\/dev\/"\]/,
    'and reads the card it unfolded into, with its Open card toggle in the action band');
  assert.ok(!/cards=open/.test(unfold.path), 'without cards=open, or the tap would prove nothing');

  // The ⋯ menu capture needs a card up to have a trigger to tap.
  const menu = DAPP.tests.find((t) => /shot=card-menu/.test(t.path || '') && /#dev-kanban/.test(t.expectSelector || ''));
  assert.ok(menu && /cards=open/.test(menu.path), 'the card-menu shot runs with the cards open');
  // The manifest did not grow FOR THE FOLD: it is pinned by extending two
  // existing checks rather than declaring new ones. The literal is the whole
  // manifest's size, so a later change that legitimately declares a check
  // bumps it by exactly that many and says so here (560 → 562: the two #1824
  // challenges-footer checks; 562 → 563: the fifth build step's queued-wait
  // check on the checks card; 563 → 573: the ten #1808 stamp checks, one per
  // surface whose timestamp changed; 573 → 574: #1841 account email settings;
  // 574 → 576: the two #1771 infrastructure-error checks, added in #1860;
  // 576 → 578: the two #1838 mouse-gesture card-menu checks;
  // 578 → 580: the two fold-mark checks, one per state;
  // 580 → 587: the eight #1876 checks that replace one, two states of the
  // two-step waitlist confirm errand × its visible half, its hidden half and
  // its step line, plus step 2's back link and resend;
  // 587 → 589: the Workshop's two grouping panes, one check each — the tab
  // strip in its default state, and `?group=stage` drawing the board's own
  // columns under it with the summary strip still above them;
  // 589 → 591: the status bar becoming the vote alone — one check that a
  // BLOCKED proposal still draws a vote bar, one that its reasons are tags on
  // the facts line beside it. Two, because those two facts sit on sibling
  // rows and no single selector can assert both;
  // 591 → 593: two additional checks cover the underway overview and
  // workspace deep link;
  // 593 → 594: the Workshop's working pane, pinning that the search, filters
  // and "+" render in its sticky head directly above those tabs rather than
  // in the frame's chrome two strips away;
  // 594 → 597: full-card tabs, embedded owner workspace and review discussion.
  // 597 → 598: #1926 repeated conflict notices in card discussions.
  // 598 → 601: the stale-work-order fix. Two checks shoot the hand-off step of
  // an ORDINARY work order (?demo=1&order=plain, the fixture added with them) —
  // that "Start over" is offered there at all, and that copying stays the
  // primary action beside it — and one covers a continuation;
  // 601 → 602: review found that withholding the button on a continuation was
  // a dead end rather than a safeguard, since the launchpad resolves its task
  // per (user, app) and one continuation pinned every session in the app. The
  // continuation check now asserts the button IS offered, and a second one
  // pins the sentence saying what pressing it gives up.
  // 602 → 607: the launchpad is keyed per session now, so a session that did
  // not prepare a work order shows none. Two checks shoot that state — the
  // "What should it build?" field being live, and Prepare being the action
  // offered — on the ?order=none fixture added with them. Before this, no
  // route could render it: a session with no order of its own still showed
  // another session's.
  // 604 → 601: the launchpad hands over instructions now. Nine checks went with
  // the surfaces they pinned (the brief field, the Prepare button, the Submit
  // step, "Start over", the connector note) and six replaced them: the
  // three-step shape, the instructions to copy and their text on the card, the
  // absent brief field, the connect-first state, and a continuation saying the
  // work lands as an update.
  // 601 → 604: #2038 adds three checks for the card states it renames or
  // introduces — a proposal being brought up to date, a refused merge named
  // for what it was rather than as a conflict, and automatic resolution
  // saying nobody has to act.
  // 604 → 605: the Needs-you deck's ask box answers for real now, so one
  // check pins the composer being present on the card. Selector-only, and
  // deliberately not asserting it is enabled: the box is disabled on a row
  // with no resolvable reference, which is a legitimate state the demo
  // fixtures may well be in.
  // 605 → 604: the Board VIEW MODE retired. Its columns are the Workshop's
  // "By stage" pane, so three checks moved onto that pane's markup and the
  // fourth went outright — the kanban-only general-discussion CARD, which the
  // Workshop already answers for with a row of its own (there is a check for
  // that row, and another pinning that the Workshop does not draw the card
  // too). Nothing was declared to replace it.
  // 604 → 605: #1912 puts Show more on every sort, so one check pins the case
  // that had none — a metric sort, where the demo and broken samples are the
  // top two by users and used to lead the directory. It asserts the absence of
  // the tier headings too, because "one list in its own order" is the half of
  // the change that a Show-more selector alone would not catch.
  // 605 → 606: the Needs-you feed replaces the deck. The ask-box check now walks
  // to the rail's Ask control (the box lives on a sheet), the vote check to
  // the rail's Vote control, and one new check pins the item's own order:
  // title, then the sentence a voter reads, then the caption.
  // 606 → 607: both of the above landed, on either side of a merge.
  // 607 → 610: #2061 adds three checks for the merge-requirements checklist
  // — the locked-app gate that had no UI at all, the "nobody has to act"
  // wording, and the steps listed AFTER the one a proposal is stuck on,
  // landing on the other side of a second merge.
  // 610 → 609: the tallies above were computed on either side of a merge and
  // cannot be read as one sequence. This branch took 605 → 604 by retiring the
  // kanban-only general-discussion check (the entry above with that arrow);
  // main independently took the SAME 605 to 610 with the five entries listed
  // between. One −1 and one +5 against a shared 605 is 609 — not the 610 main
  // reached without this branch's removal, which is the figure the sync's
  // conflict resolution kept and the repo unit suite then caught. A literal is
  // the right shape for this assertion precisely because that mismatch is
  // otherwise silent; it is the arithmetic that needed saying, not the check.
  // 609 → 610: #1823's Challenges row in the app menu, under Discover.
  // 610 → 610: #2090 keeps the All items pane — and the search box in it —
  // on screen when a search matches nothing. It RETARGETS the Workshop
  // search-bar check rather than adding one (same box, the pane now opened
  // already narrowed by `?q=` to a search nothing matches, with the note
  // under it proving the search applied), so the count is unchanged.
  // 610 → 612: the two #1960 checks on the draft-delete shot, one for the
  // count the trash left behind and one for which draft is still standing.
  // 612 → 614: #1956 adds one direct hamburger-menu check for issue cards
  // and one for proposal cards, both exercising the Share to Messages row.
  // 614 → 616: the two #2118 checks on the OpenRouter spend shot, one for
  // what is left on the key and one for what the turn cost.
  // 616 → 617: #2154 adds the settled half of the app-launch fixture, proving
  // a terminal status that beats the detail response removes the spinner.
  // 617 → 618: #2089 adds one board check opened through `?q=` on a word
  // that appears only in a mock issue's BODY, pinning that the search now
  // reads past the title.
  // 617 → 618: the #2113 check on the demo group thread, for the attached
  // screenshot whose macOS-style name used to make its download 500. Same
  // base as #2089's bump, on the other side of a merge: two branches each
  // took 617 to 618 independently, so together they land on 619.
  // 619 → 621: the two #1892 checks on Settings → Connectors, one for the
  // Codex CLI block's config.toml entry and one for the generic MCP-client
  // walkthrough.
  // 621 → 622: the #2161 check that opens App settings on the platform's own
  // app (`?shot=app-settings`) and reads the danger zone's blocked notice.
  // 621 → 622: #2172 adds one check on the Needs-you feed's end card, the
  // summary one swipe past the last item, on the ?shot=needs-end route that
  // opens on it.
  // 621 → 622: the #1941 check on the session screen, pinning the compact
  // session strip — py-1, wrapping only below sm — with the venue still a
  // direct child beside the name.
  // 621 → 622: #2183 adds one check on the since-list's Clear and its
  // always-drawn Show older, reached through `?shot=since-visit`.
  // 621 → 622: #2182 independently adds the check that the viewer's strip
  // stays on screen when it is empty, reached through `?shot=mine-empty`.
  // 622 → 626: the tallies above were computed on either side of a merge and
  // cannot be read as one sequence. This branch took 621 → 622 alone, with
  // the #2161 check above; main independently took the SAME 621 to 625 with
  // the four entries listed above it. One +1 and one +4 against a shared 621
  // is 626.
  // 626 → 627: the #1919 check on the all-apps directory, pinning the phone
  // pane's two parts — the search head and the list body — as siblings with
  // the rows inside the body.
  // 627 → 628: challenge illustrations, one check that a Home challenge card
  // whose template names an artwork draws it (the demo rows carry slugs).
  // 627 → 628: #1933 adds one board check that an issue card names the
  // auto-drafted category the demo themes placed it in.
  // 627 → 629: the two #1945 checks on the bar inside an app — a dark app
  // under the light shell (`?shot=app-tone-dark`) and a light app under the
  // dark shell (`?shot=app-tone-light&theme=dark`), each reading the tone
  // the frame's page colour put on <html>.
  // 627 → 629: #1910 adds two checks on the restyled create-app dialog: the
  // form view on `/#create` (the name card and the segmented rail) and the
  // import view reached through `?shot=create-import` — landed independently
  // on both sides of this merge.
  // 627 → 629: on another side of these merges, the invite link now points
  // at the marketing site's /waitlist page instead of the in-app #waitlist
  // route, so two checks read the link's own field on the more-to-do screen
  // — one that its value is the marketing URL and carries no hash route, one
  // that the copy affordance is still beside it — also landed independently
  // on both sides.
  // 629 → 631: #1962's two checks that sending a saved draft leaves the
  // composer empty, one on the send and one on the screen the drafts list
  // is actually painted on.
  // 629 → 631: independently, #1944 adds two checks on the coding-run card
  // opened through `?shot=cc-log-open` — the chevron still in the head row
  // of an OPEN card (the flip rule has to reach it there), and the log panel
  // under it.
  // 631 → 639: the tallies above were computed across several independent
  // merges and do not compose into one arithmetic sequence: this branch's
  // #1933 check, main's #1945 pair, and the #1910, invite-link and #1962
  // pairs each landed against a slightly different shared base than the
  // others, and some of those pairs already landed once on both sides before
  // this merge de-duplicated them. The number that matters is what the
  // merged manifest actually holds, so this entry counts it directly rather
  // than re-deriving it: 639.
  // 639 → 642: #2201's three checks on a confirmed address re-joining the
  // waitlist, landed independently on main — it lands on the settled panel,
  // the copy reads back rather than congratulating, and it is never asked
  // for a code.
  // 642 → 646: #2219's four, counted the same way (642 was main's directly
  // counted total after #2201, and this branch adds four on top of it). Two
  // photograph the app-permission prompt through `?shot=app-permission` — the
  // dialog an embedded app opens by calling usernode.requestPermission(),
  // which no plain route can reach because it needs a running app that asks;
  // two read the new Settings pane behind `?demo=1#settings/app-permissions`,
  // one for the rows and one for the copy that must NOT promise a revoke
  // lands while the app is still open.
  // 646 → 648: #1911 adds two checks on the create-app dialog's steps, the
  // start step's two choices on /#create and the access step through
  // `?shot=create-access`; the #1910 name-card check moved to
  // `?shot=create-details`, where that field is on screen.
  // 646 → 647: independently on main, #838 adds one check on Spend limits,
  // pinning the three per-tier weekly cap fields (unverified, GitHub and X,
  // zkPassport).
  // 648 → 649, 647 → 649: the tallies above were computed on either side of
  // this merge and cannot be read as one sequence. This branch took 646 → 648
  // alone, with the #1911 checks above; main independently took the SAME
  // 646 → 647 with the #838 check above. One +2 and one +1 against a shared
  // 646 is 649.
  // 649 → 650: #2236 adds one check for the "via agent" chip a note wears
  // when a coding agent posted it through the connector on the author's
  // behalf, on the demo issue's discussion. It reads the mock agent row the
  // staging chat endpoint returns under `?demo=1` for a thread with no real
  // messages. A second check on the Activity feed's reply preview was
  // declared and withdrawn: the feed-comments shot unfolds the first issue
  // row with GitHub comments, and on a production-cloned staging database
  // that thread already has a genuine transcript, which always wins over the
  // mock. The feed bubble's chip is pinned by tests/agent-posted-via.test.js.
  // 649 → 650: independently on main, #2240 adds one check on the
  // since-list's Clear in the state it was dead in — a reader with nothing
  // new who walked `Show older` down past the baseline — reached through
  // `?shot=since-seen`, which seeds the line at now and then presses the
  // walk across it.
  // 649 → 652: #1374's three, counted directly off the merged manifest for
  // the same reason. Two photograph the per-app Notifications dialog through
  // `?shot=app-notifications` — it is otherwise two taps inside a tile menu,
  // which no route can reach — and one reads the Settings roll-up.
  // 649 → 651: on yet another side of this merge, #2201 also gives the
  // check-my-status address step an answer for a mistyped address, and
  // declares the two things that state must show at
  // `?shot=waitlist-not-found` — the note that says the address is not on
  // the list, and the control that offers to join with it. Two and not
  // three: the manifest is on the 20-slot floor under MAX_DECLARED_TESTS,
  // so the third property (the code half still down) is asserted from
  // source in tests/waitlist-two-step.test.js instead of spending a slot
  // the next proposal needs.
  // 650 → 655, 652 → 655, 651 → 655: the tallies above were computed on
  // three different sides of this merge and cannot be read as one sequence.
  // This branch took 649 → 650 alone, with the #2240 check above; main
  // independently took the SAME 649 to both 652 (the #1374 checks above) and
  // 651 (the #2201 not-found pair above). #2240 (+1), #1374 (+3) and the
  // #2201 pair (+2) are three independent additions against the shared 649,
  // which is 649 + 1 + 3 + 2 = 655.
  // 655 → 657: #2241's two checks on the unsent-change screen, which has a
  // route of its own (/dev/sessions/new) and no session behind it — one on
  // the empty state's sentence, one on the live composer beside a header
  // that offers no venue dropdown and no ⋯ menu, because there is nothing
  // yet for either to act on. This one IS a plain sequence: the pair landed
  // on a branch cut before #2240 / #1374 / #2201 and was merged after all
  // three, so it adds to whatever the manifest holds, which is 655.
  // 655 → 658: independently on main, off the SAME shared 655, #2086 makes a
  // featured-illustration change a governance proposal and adds two checks
  // on its card via the ?demo=1 mock row 9100008 — the proposed-beside-
  // current preview on the open board card, and the same preview on the
  // proposal's own discussion page — plus a second #2236 via-agent-chip
  // check, on the topic's own discussion rather than the demo issue's, for
  // a note a coding agent posted through the connector.
  // 657 → 660, 658 → 660: this branch's #2241 pair and main's #2086/#2236
  // trio are independent additions against the shared 655 — neither set
  // overlaps the other — so the merged manifest holds every one of them:
  // 655 + 2 (#2241) + 3 (#2086 pair + the second #2236 check) = 660.
  // 660 → 661: the public waitlist CORS fix adds one check on
  // GET /api/public/waitlist/options — the first declared check whose path is
  // an API route rather than a screen. It is here because the fix's own
  // endpoint (POST /api/public/waitlist/status) is registered for POST only,
  // and a declared check can do nothing but navigate; its sibling GET on the
  // same router, behind the same new CORS middleware, is what a navigation
  // can actually prove is reachable anonymously. The preflight and response
  // headers are pinned in tests/public-api-cors.test.js instead.
  //
  // #1884 gives the BOARD's unfolded card the sheet the Workshop's has had
  // — the issue's comment tail and the app's own reply box under it — and
  // declares it on the surface that gained it, independently on main. One
  // slot, not two: the Workshop's own pair above already reads the same two
  // regions, so a second copy of that claim would spend a slot to assert
  // something already asserted. Room remains against MAX_DECLARED_TESTS
  // (710).
  //
  // 661 → 662: the tallies above were computed on either side of THIS merge
  // and, as with the 610 → 609 and 659 → 661 entries above, do not reconcile
  // through the comment trail alone. This branch's own total before this
  // merge was 661, counted directly above. Main independently carried the
  // shared history through #1884's board-sheet check and the rest of the
  // commits this merge brings in (verified social accounts on public
  // profiles, #2250; the Home challenges regrouping, #2233; among others),
  // landing on a manifest one entry larger than either side's own arithmetic
  // predicts. The literal is the ground truth here, not the arithmetic:
  // 662.
  //
  // #2260 adds one deterministic check for the verified-account replacement
  // confirmation state in Connectors. That makes the reviewed total 663.
  //
  // #2266 adds one deterministic check for the password-reset completion
  // state on the login screen. That makes the reviewed total 664.
  //
  // 663 → 664: independently on main, #1508 (per-app Add to Home Screen)
  // declares one check on the seeded app's install page
  // (/app/staging-demo-admins/install), a server-rendered document with the
  // app's own manifest, asserting its #app-install root renders for a
  // signed-in viewer.
  //
  // 663 → 664: also independently on main, #2253 adds one check on the admin
  // console's App storage section, read through `?demo=1#admin/storage` so
  // the preview shows the fixed demo rows (one frozen, one nearly full)
  // rather than a cloned apps table with no figures in it.
  //
  // 664 → 666: the tallies above were computed on either side of this merge
  // and cannot be read as one sequence. This branch took 663 → 664 alone,
  // with #2266's check above; main independently took the SAME 663 to 665
  // with the #1508 and #2253 checks above. One +1 and one +2 against a
  // shared 663 is 666.
  //
  // 666 → 667: the waitlist connect callback's status page, loaded with a
  // state no server has minted, so it renders the "link has expired"
  // outcome without needing provider credentials on the preview.
  // 667 → 669: Profile staking (#1551) adds Active and Delegated previews.
  // 669 → 670: real staking context verifies preview network configuration.
  //
  // 667 → 672: independently on main, the Workshop screen (#workshop) — the
  // app chip's Workshop row beside the amended Home-to-Discover adjacency
  // check, and four on the screen itself, all read through `?demo=1#workshop`
  // so the numbers come from the fixed demo rows rather than a cloned
  // database whose `chat_sessions` the staging clone leaves empty. The four
  // are not one claim four times: the visual one reads a row's identity, its
  // link to that app's own Workshop page and its votes number together (it is
  // also the scenario the before/after screenshots are shot on); the second
  // reads the OTHER number beside it, which no screenshot can be asserted on;
  // the third reads the ORDER, which is the screen's own argument — an app
  // with a decision waiting leads; and the fourth reads the empty line's
  // absence, which is the one thing a populated screenshot cannot show. Room
  // remains against MAX_DECLARED_TESTS (710).
  //
  // 670 → 675, 672 → 675: the tallies above were computed on either side of
  // THIS merge against the same shared 667 and do not reconcile through the
  // comment trail alone. This branch's staking pair added 3; main's Workshop
  // screen added 5; neither set overlaps the other, so the merged manifest
  // holds every one of them: 667 + 3 + 5 = 675.
  //
  // 675 → 680: this branch's two All-items chunks, which computed their own
  // tallies (672 → 674 → 677) against the pre-staking manifest and so cannot
  // be read as continuing the line above; +2 and +3 are what each chunk
  // actually adds, and neither touches a staking check.
  //
  // +2 — the Workshop's grouping strip moves out of the All-items pane head
  // and up beside the tab pill on a wide window, so the check that read
  // `.dev-ws-group + #dev-actions` inside the head describes an arrangement
  // that no longer exists at the capture's 1280px viewport. It is REPLACED
  // rather than removed — one check on the ear (the visual one, since this is
  // the change a voter has to see), one on the head it left, one on the ear
  // in the By-stage state, where the pane runs edge to edge and the ear has
  // to track its right edge — which is net +2 against a manifest that loses
  // one. tests/dev-workshop.test.js pins that no check still expects the old
  // adjacency, so the swap cannot be half-done.
  //
  // +3 — the "Assigned to you" / "Created by you" quick filters move into
  // the Filters dialog when the filter row cannot hold them on one line,
  // which is a state the capture runner's fixed 1280x800 viewport cannot
  // reach on its own — hence `?shot=quick-in-dialog`, which pins the
  // handover on and opens the dialog. Three, because the move has three
  // separately falsifiable halves: the dialog GROWS the two switches (the
  // visual one, and the only one a screenshot can carry), the strip DROPS
  // them in the same state (a dialog that gained them while the strip kept
  // them is two owners of one value), and with room on the line the strip
  // KEEPS them while the dialog does not offer them — the default, which is
  // what a measurement bug would break first.
  //
  // 675 → 676: independently on main, the programme console's Challenge
  // scoring screen, which has to render its schedule card and its rules list
  // as siblings — the check selects across the two, because a screen that
  // drew only one of them would still look loaded.
  //
  // 676 → 678: also independently on main, #2327 declares the author-only
  // title editor once while a change is Underway and once while it is In
  // review. They are distinct lifecycle renderers (_sharedSessionCardModel /
  // _proposalCardModel), so pinning both prevents one half of the feature
  // disappearing unnoticed.
  //
  // 680 → 683, 678 → 683: the tallies above were computed on either side of
  // this merge and cannot be read as one sequence. This branch took
  // 675 → 680 alone, with its two All-items chunks (+2, +3); main
  // independently took the same 675 to 678, with the Challenge scoring check
  // (+1) and the title-editor pair (+2). Neither set overlaps the other, so
  // the merged manifest holds every one of them: 675 + 2 + 3 + 1 + 2 = 683.
  //
  // 683 → 684: demo mode (routes/demo-mode.js) marks an app in demo mode in
  // its settings dialog — a synthetic partner's proposals and votes must be
  // seen for what they are — and that notice gets its own declared check, on
  // the staging fork fixture the seed switches into demo mode.
  //
  // 683 → 688: independently on main, the general chat's proposal events —
  // the open one as a message with its box, its header's sender, a merge
  // from the app — a person's message in a bubble, and the quiet card.
  //
  // 684 → 689, 688 → 689: the tallies above were computed on either side of
  // this merge and cannot be read as one sequence. This branch took
  // 683 → 684 alone, with the demo-mode check above; main independently took
  // the same 683 to 688, with the five chat-proposal-event checks above.
  // Neither set overlaps the other, so the merged manifest holds every one
  // of them: 683 + 1 + 5 = 689.
  //
  // 689 → 690: the Improve button follows the open app's own redeploy (task
  // 446). The landed state, the reload row and the arrow, gets a check on the
  // staging fork fixture; the building state is the note and spinner the
  // platform-updating check already photographs, and the manifest is one
  // slot from its ceiling (tests/improve-session-spinner.test.js).
  // #2423 extends the existing Done-column check above rather than consuming
  // the final reserved slot: the same fixture now covers the completed
  // change's in-app Closed-issue chip too.
  //
  // #1688 does the same with the In-review vote-button check: its column
  // must now also hold a card whose button asks "Still yes?" (a Yes cast on
  // an earlier version) and a fresh card whose kudos slot offers thanks by
  // name — one check, no slot consumed.
  //
  // 690 → 690: the proposal page redesign (task 495) rewrote the checks the
  // old page shape held — the sheet order, the two About halves, the path
  // caption and its who-acts sub, the three conversation tabs, Explore in
  // ⋯ — and folded its own claims into them with `:has()` on the same
  // pages (the fold and the More sheet's accordion, the Review line, the
  // Discussion in the general chat's language, the accent Re-run pill),
  // merging the bare help-button check into the Review-line one. Its two
  // new checks — the issue rows under What changes for you (9000013) and
  // the one-line failing check (9000093) — take the two slots that merging
  // freed, so the manifest keeps its 20 clear of the ceiling
  // (tests/improve-session-spinner.test.js, tests/proposal-tests-manifest.test.js).
  //
  // 690 → 690: the change page as a Needs-you item (task 497) repointed the
  // checks the previous shape held — the sheet order, the About halves, the
  // folded summary, the numbered ledger path, the state tags — at the hero
  // and the steps sheet, in place. No slot moved either way.
  //
  // 690 → 693: the first-run "Choose your username" step (#2563) is a new
  // user-visible screen, so it declares checks of its own — one visual
  // claim for the modal with its suggestion already in the field, and two
  // that pin the copy the step depends on (the Continue button, which is
  // the only way out of it, and the sentence that states the rules). It
  // found the manifest exactly ON the 20-slot floor, so the ceiling moved
  // with it (services/app-manifest.js, 710 → 730).
  //
  // 693 → 695: the "Model costs" admin section (#2570) is a new screen in
  // the admin console — the per-model table of notes, shown estimates and
  // observed spend, with the override field — so it declares two checks of
  // its own: one visual claim for the table at /#admin/model-costs, and one
  // that pins the override control an admin with write access acts on. The
  // manifest stays 35 clear of the ceiling.
  //
  // 693 → 695: independently on main, the welcome tour (#2255) replaced the
  // one-line #home-welcome banner with an eight-step overlay, and declares
  // two checks of its own — that Settings offers the way back into it, and
  // that the overlay ships hidden on Home so nobody's first paint meets it.
  //
  // 695 → 697: the tallies above were computed on either side of this merge
  // against the same shared 693 and do not reconcile through the comment
  // trail alone. This branch's #2570 pair and main's #2255 pair are
  // independent additions against that shared 693, so the merged manifest
  // holds every one of them: 693 + 2 + 2 = 697. The ceiling is untouched:
  // 697 leaves 33 slots against MAX_DECLARED_TESTS (730), clear of the
  // 20-slot floor.
  //
  // 697 → 699: the comment clamp (#2556) declares one check per surface it
  // can actually reach from a URL — the Workshop's inline recent comments
  // (the ?shot=feed-comments route, which already unfolds an issue row) and
  // an issue's Discussion. Both assert the REVEALED control rather than the
  // clamp alone, because the control is what a measurement puts there and a
  // clamp with no control is the bug, not the feature. The third surface,
  // the card's own reply thread, gets no check: it would need a long reply
  // POSTED to the app's thread, and seeding one would be a fixture that
  // fabricates activity rather than data. 699 leaves 31 slots against
  // MAX_DECLARED_TESTS (730), clear of the 20-slot floor.
  //
  // 699 → 701: the running row's heading (#2597) is two assertions about
  // one seeded transcript, not one — the heading now says what is happening
  // ("Coding agent is running") and a second line says where ("Homeroom ·
  // Claude"), and a single check could only pin one of them. Both ride the
  // 990412 dev-session fixture the coding-run card already uses, so neither
  // adds a route. 701 leaves 29 slots against MAX_DECLARED_TESTS (730),
  // clear of the 20-slot floor.
  //
  // 701 → 702: #2607 put the venue dropdown on the unsent-change screen, so
  // the check that pinned its ABSENCE there was retargeted to the new truth
  // rather than deleted, and ONE check was added beside it — the dropdown
  // is an enabled, direct-child control that names a venue and opens the
  // sheet, which is the part a retargeted :not() cannot assert. The pick
  // itself gets no check: every answer but the in-chat one creates a session
  // row, and a declared check that creates one on every run would seed the
  // staging clone with sessions nobody asked for. This branch's one addition
  // and main's #2597 pair are independent additions against the shared 699,
  // so the merged manifest holds all three: 699 + 2 + 1 = 702, which leaves
  // 28 slots against MAX_DECLARED_TESTS (730), clear of the 20-slot floor.
  //
  // 702 → 703: #2605 moved the build surface off a change's card page onto
  // the dev session's own page. The four checks that pinned the Build sheet
  // were retargeted rather than deleted — two now assert that a card page
  // has NO build surface, one that an old `?conversation=workspace` link
  // lands on the session page, one that a published chat renders read-only
  // there — and ONE was added beside them: the old pair on the shared
  // session's page asserted the transcript's body and its author
  // attribution, and those now sit on two different pages, so the body
  // needs a check of its own. 27 slots left against MAX_DECLARED_TESTS
  // (730), clear of the 20-slot floor.
  //
  // 703 → 704: #2592 taught the Model costs console to count the coding
  // agent's own spend, which is most of what a change costs and had been
  // left out of the observed average and median entirely. The figure is
  // only trustworthy if the screen states what it counted, so the
  // paragraph under the heading now defines a change, and ONE check was
  // added beside the existing "says where its estimates come from" to pin
  // that sentence. 26 slots left against MAX_DECLARED_TESTS (730), clear
  // of the 20-slot floor.
  //
  // 703 → 705: independently on main, #2603 put a line on a governance
  // vote, and nothing in the manifest pinned either half of it. TWO checks,
  // because they are two facts on two screens and no selector spans both:
  // one that a governance card's vote is the picker button (the box opens
  // with it, which is what makes a line possible at all), one that a close
  // proposal's own page lists the votes cast on it with each voter's words.
  //
  // 703 → 704: also independently on main, #2492 added one check on the
  // Challenges tab — every card's progress rail carries a spoken value.
  // Block production used to reach the rail with an empty label and draw a
  // ring with nothing beside it, and nothing declared caught it; the Home
  // rail has had the same `[aria-valuetext]` check since Iteration 03.
  //
  // 704 → 707: the tallies above were computed on either side of this merge
  // and cannot be read as one sequence. This branch took 703 → 704 alone,
  // with the #2592 check above; main independently took the same 703 to
  // 706, with the #2603 pair and the #2492 check above (703 + 2 + 1 = 706).
  // Neither set overlaps the other, so the merged manifest holds every one
  // of them: 703 + 1 + 2 + 1 = 707, which leaves 23 slots against
  // MAX_DECLARED_TESTS (730), clear of the 20-slot floor.
  assert.equal(DAPP.tests.length, 707);
});

test('a tap on the merge-requirements checklist opens the checklist, not the fold (#2128)', () => {
  // The checklist (#2061, dev-card.tsx RequirementsRow) is a <details> on
  // the open proposal card, and its summary line — "Nothing needs you",
  // "Waiting on an admin" — is what a reader taps to see the steps. The
  // wrapper's click guard did not know it: the same tap that opened the
  // list bubbled to the wrapper, which folded the card and unmounted the
  // list just opened. The guard excludes `details` now — the whole element,
  // because once open it is a list to read, like the two regions under the
  // card — and nothing else about the tap changes: the disclosure is
  // native, its open state the reader's, and no handler swallows the click.
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  AppView._proposals[0].mergeRequirements = { gates: [
    { key: 'approvals', label: 'Approvals', actor: 'group', state: 'done', detail: { note: '3 of 3' } },
    { key: 'integration', label: 'Up to date with main', actor: 'auto', state: 'active',
      detail: { note: '2 commits behind, so the platform is merging main in' } },
  ] };
  const html = kanbanHtml(AppView);
  // The checklist sits INSIDE the open card, inside the wrapper whose click
  // folds it — so the guard is the only thing between the tap and the fold.
  assert.match(html,
    /class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet"[^>]*><div class="gc-vote-item [^"]*dev-card-dense"[^>]*data-proposal-row="34"(?:(?!class="dev-ws-rowwrap)[\s\S])*?<details [^>]*data-merge-requirements="1"><summary [^>]*><span [^>]*data-req-headline[^>]*>Nothing needs you<\/span>/,
    'the checklist, its summary line first, on the open card');
  // The guard: `details` among the native controls, so a tap anywhere on the
  // checklist — the summary, a step, its note — is the checklist's, and a
  // tap on the rest of the card still folds it.
  const view = FOLD.slice(FOLD.indexOf('function CardRowView'));
  assert.match(view,
    /el\.closest\(\s*'a, button, input, textarea, select, form, details, \[data-attr-chip\], \[data-issue-chip\],'\s*\+ ' \.dev-feed-thread, \.dev-feed-comments',\s*\)\) return;\s*onToggle\(\);/,
    'the open card’s guard excludes the disclosure, and folds on everything else');
  // The checklist itself is untouched: the native disclosure, its open state
  // seeded from the model and then the reader's, and neither a
  // stopPropagation (the guard is the seam, as for every other control) nor
  // a preventDefault (the tap must still open the list).
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  const req = CARD.slice(CARD.indexOf('function RequirementsRow'), CARD.indexOf('function ExtraRow'));
  assert.match(req, /<details\s[^>]*onToggle=\{\(e\) => setOpen\(\(e\.currentTarget as HTMLDetailsElement\)\.open\)\}/);
  assert.ok(!/stopPropagation|preventDefault/.test(req), 'the row neither swallows the click nor blocks the native toggle');
  // The folded row draws no checklist, and its own guard is unchanged: a tap
  // on the row — its state chip included — still unfolds it.
  const folded = kanbanHtml(makeAppView());
  assert.ok(!folded.includes('data-merge-requirements'), 'no checklist on a folded row');
  const rowView = FOLD.slice(FOLD.indexOf('function FoldedRow'), FOLD.indexOf('function UnfoldedRow'));
  assert.match(rowView, /if \(\(e\.target as HTMLElement \| null\)\?\.closest\('a, button'\)\) return;\s*onToggle\(\);/);
});

test('the board’s fold rules: the column’s rhythm, not the wrapper’s, and the shared sheet', () => {
  assert.match(CSS, /#dev-kanban \.dev-ws-rowwrap \{ margin-bottom: 0; \}/);
  assert.ok(!/#dev-kanban \.dev-ws-sheet-actions/.test(CSS), 'no line under the board’s card to style');
  // The frosted sheet used to be the Workshop's alone, and this asserted so:
  // on the board the open card was the column's tile, because nothing hung
  // under it. #1884 is what changed that premise — the board's cards carry
  // the thread and the comment tail now, and #1885's rule above says in as
  // many words that the sheet's padding is for what hangs UNDER the card. A
  // reply box on the column's own background, with the next card's row
  // starting 8px below it, has no boundary saying which card it belongs to.
  //
  // So the sheet is scoped to both hosts, and the quiet cards are unmoved:
  // `:only-child` still pulls a card with nothing under it over every edge,
  // so the frosting never shows and the column reads as it did. The one
  // thing an open board card picks up is the sheet's 26px corner in place of
  // its own 22px — which is the Workshop's open card, which is the point.
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-entry \{/);
  assert.match(CSS, /:is\(#dev-workshop, #dev-kanban\) \.dev-feed-entry > div:is\(\.dev-card-dense, \.dev-card-topic\):only-child \{\s*margin-bottom: -12px;/);
  assert.ok(!/#dev-kanban \.dev-feed-entry \{/.test(CSS), 'and the board grows no second copy of it');
});

test('the open card is the fold’s sheet, and never picks up the Needs-you deck’s dialog geometry', () => {
  // #2080 gave the Needs-you deck's three dialogs the bare `.dev-ws-sheet` —
  // the name the fold's OPEN CARD has carried since the Workshop shipped —
  // so the dialog's geometry landed on every unfolded card on every Workshop
  // surface: `position: fixed; inset: 0` at `z-index: 30`, which took the
  // card out of its column or its strip, painted its own fill across the
  // viewport and swallowed every click underneath. On By stage and By
  // category that reads as the whole board going opaque and dead; on Current
  // status the card opens over the tiles it should be sitting under.
  //
  // One rule, three screens — so the full-screen geometry is keyed on the
  // deck's OWN base class and the bare name stays the fold's.
  assert.match(CSS, /\.dev-ws-sheet-modal \{ position: fixed; inset: 0; z-index: 30;/,
    'the deck’s dialogs are the fixed, full-screen thing');
  assert.ok(!/^\.dev-ws-sheet \{/m.test(CSS),
    'and nothing is keyed on the bare name, which is one open card sitting in its row');
  for (const kind of ['vote', 'ask', 'comments']) {
    assert.match(WORKSHOP, new RegExp(`className="dev-ws-sheet-modal dev-ws-sheet-${kind}"`),
      `the ${kind} dialog carries the deck’s base class`);
  }
  assert.ok(!/className="dev-ws-sheet dev-ws-sheet-/.test(WORKSHOP),
    'and none of the three carries the fold’s');
  // The open card keeps the bare name, because two declared checks select it
  // that way — which is also why the deck is the side that moved.
  assert.match(FOLD, /<div className="dev-feed-entry dev-ws-sheet" data-ws-sheet=\{row\.key\}>/);
  // Nothing is DECLARED for the geometry itself, and nothing can be: a
  // selector cannot read a computed position — the card stayed inside its
  // column in the DOM the whole time it was painting over the board — and the
  // manifest holds its last 20 slots clear (tests/proposal-tests-manifest.test.js).
  // What the gate does pin is the name, twice, which is why the deck is the
  // side that moved rather than the fold.
  const onTheSheet = DAPP.tests.filter((t) => /\.dev-ws-rowwrap-open > \.dev-ws-sheet/.test(t.expectSelector || ''));
  assert.ok(onTheSheet.length >= 2, 'the declared checks still select the open card as `.dev-ws-sheet`');
});

// ── The card's controls and lines, after the fold (#1787) ─────────────────
//
// With both surfaces drawing one card, the card itself was reworked: blue
// pills, a hamburger at the band's right edge with Preview before it, every
// pill foldable, the tags on the meta line at both sizes, that line tabbed
// in under the title and snug beneath it, and folded rows 4px apart.

test('the band’s pills wear the Vote button’s Yes tint; the hamburger holds the band’s right edge, Preview just before it', () => {
  // The neutral grey fill read as a third colour beside the blue Vote and
  // the blue Preview; the pills take `.dev-vote-btn-yes`'s accent on tint.
  const at = CSS.indexOf('\n:is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn {');
  assert.ok(at > 0, 'the band pill rule exists');
  const pill = CSS.slice(at, CSS.indexOf('\n}', at));
  assert.match(pill, /background: var\(--accent-tint\);/);
  assert.match(pill, /color: var\(--accent\);/);
  assert.match(pill, /border-color: transparent;/);
  assert.match(CSS, /\.dev-vote-btn-yes[^{]*\{ background: var\(--accent-tint\); color: var\(--accent\); \}/, 'the pair the Yes state uses');
  // The ⋯ was a well in the card's top-right rail. The menu is where the
  // pills that do not fit the band go, so its trigger is the band's own
  // "more": a hamburger at its far right, and Preview, when there is one,
  // just before it. Whichever of the two comes first carries the auto
  // margin that pushes the pair to the edge; the second keeps the gap.
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(CARD, /<Bars3Icon aria-hidden="true" \/>/);
  assert.ok(!CARD.includes('EllipsisHorizontalIcon'));
  assert.ok(!CARD.includes('className="dev-card-rail"'), 'the rail column is gone from the card');
  const tr = CSS.indexOf('\n:is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .dev-card-menu-btn {');
  assert.ok(tr > 0);
  assert.match(CSS.slice(tr, CSS.indexOf('\n}', tr)), /margin-left: auto;/);
  const pv = CSS.indexOf('\n:is(.dev-card-dense, .dev-card-topic) .gc-card-actions > .gc-vote-btn-preview {');
  assert.ok(pv > 0);
  assert.match(CSS.slice(pv, CSS.indexOf('\n}', pv)), /margin-left: auto;/, 'Preview pushes the pair when it is the first of them');
  assert.match(CSS, /\.gc-card-actions > \.gc-vote-btn-preview \+ \.dev-card-menu-btn \{ margin-left: 0; \}/,
    'and the hamburger after it keeps the gap, or two auto margins would split the free space');
  assert.ok(!/\n\.dev-card-rail \{/.test(CSS), 'and from app.css');
});

test('every pill is foldable: the band shows as many as fit its line and the menu lists the rest', () => {
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  // The band capped at three text pills, and then the first pill was exempt
  // from folding (`i > 0`). With "Open card", the hamburger and Preview all
  // fixed at the band's right, a narrow column may leave no room before
  // them, so the fold may take the first pill too; only a kudos host stays.
  assert.match(CARD, /fold=\{a\.kudos == null \? i \+ 1 : undefined\} hidden=\{i >= bandPrimary\.length - folded\.n\}/);
  // The fold window is taken over the specs that DRAW a foldable pill: not
  // the kudos host, and not the topic head's labelled Preview (an action
  // spec too, drawn as the band's fixed control). Counting Preview put the
  // window one spec off, and a folded first pill never reached the menu.
  assert.match(CARD, /const foldSpecs = primary\.filter\(\(a\) => a\.kudos == null && !a\.preview\);\n\s*const foldable = foldSpecs\.length;/);
  assert.match(CARD, /const hidden = n > 0 \? foldSpecs\.slice\(-n\) : \[\];/);
  assert.ok(!CARD.includes('ACTION_PRIMARY_MAX'), 'no count cap: the line is the cap');
  assert.ok(!/i > 0 && a\.kudos == null/.test(CARD));
  const html = kanbanHtml(makeAppView({ search: '?cards=open&demo=1' }));
  assert.match(html, /data-fold="1"[^>]*data-act="chooseIssueWork"/, 'the first pill carries a fold index');
});

test('the tags ride the meta line beside the number, on the open card and the folded row alike', () => {
  const FOLD_SRC = read('frontend/src/features/dev-board/card/fold.tsx');
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  // Priority, assignee and category are labels, not states: the status
  // band keeps the states (the pill, the work-state chip, Closes #N, the
  // chat count) and the meta line takes the tags, wrapping for them.
  // ONE builder draws the line at both sizes, so they cannot drift: the
  // ' · '-joined parts, then the tags, then the linked-issue chips.
  assert.match(CARD, /export function metaLineNodes\(m: DevCardModel\): ReactNode\[\]/);
  assert.match(CARD, /filter\(\(b\) => b && b\.t === 'attr'\)\) nodes\.push/);
  assert.match(CARD, /for \(const b of m\.linked \|\| \[\]\) nodes\.push/);
  assert.match(CARD, /filter\(\(b\) => b && b\.t === 'issueChip'\)\) nodes\.push/, 'a session\u2019s #N chips too');
  assert.match(CARD, /<div className="dev-card-meta">\{metaNodes\}<\/div>/);
  // The STATUS TAGS ride here too, marked `meta` on their spec: the status
  // band is the vote and its button alone now, and of the two lines this is
  // the one with room for a list that grows. Both sides of the split are
  // asserted, because drawing them in both places is the failure mode.
  assert.match(CARD, /filter\(\(b\) => b && b\.t === 'chip' && b\.meta\)\) nodes\.push/,
    'the meta line draws them');
  assert.match(CARD, /const states = chips\.filter\([\s\S]{0,160}!\(b\.t === 'chip' && b\.meta\)\);/,
    'and the facts row does not draw them again');
  assert.match(FOLD_SRC, /<span className="dev-ws-row-meta">\{metaLineNodes\(c\)\}<\/span>/);
  assert.match(FOLD_SRC, /!\(b\.t === 'chip' && b\.meta\)\)\s*\.slice\(0, ROW_BADGE_MAX\)/,
    'the row\u2019s last line keeps the remaining states, not the status tags');
  // Rendered: the fixture issue has an assignee, so its chip sits on the
  // meta line at both sizes and its status band holds nothing.
  const open = kanbanHtml(makeAppView({ search: '?cards=open&demo=1' }));
  const card = open.slice(open.indexOf('data-issue-row="1575"'), open.indexOf('data-proposal-row="34"'));
  const meta = card.slice(card.indexOf('<div class="dev-card-meta">'), card.indexOf('<div class="dev-card-badges dev-card-status"'));
  assert.match(meta, /#1575/);
  assert.match(meta, /<button(?=[^>]*attr-chip)[^>]*data-attr-field="assignee"[^>]*>[\s\S]*?@priya/, 'the assignee chip on the meta line');
  assert.match(card, /<div class="dev-card-badges dev-card-status" data-empty="1">/, 'and nothing left in the band');
  const folded = kanbanHtml(makeAppView());
  const row = folded.slice(folded.indexOf('data-issue-row="1575"'), folded.indexOf('data-proposal-row="34"'));
  assert.match(row, /<span class="dev-ws-row-meta"><a href="[^"]*"[^>]*>#1575<\/a><button(?=[^>]*attr-chip)[^>]*data-attr-field="assignee"/,
    'and on the row, after the number');
  assert.ok(!/dev-ws-row-band[\s\S]*?attr-chip/.test(row), 'never in the row’s state band');
  // The meta line may wrap for them: the one-line clamp is gone.
  const m = CSS.indexOf('\n:is(.dev-card-dense, .dev-card-topic) .dev-card-meta {');
  assert.ok(m > 0);
  assert.match(CSS.slice(m, CSS.indexOf('\n}', m)), /white-space: normal; overflow: visible;/);
  assert.match(CSS, /\.dev-ws-row-meta \{ display: block; font-size: 12\.5px; line-height: 21px;[^}]*white-space: normal; \}/,
    'the row\u2019s meta line wears the card\u2019s sizes and wraps as it does');
});

test('the open card’s meta line is tabbed in under the title, as the row’s is, and sits snug beneath it', () => {
  // The row keeps its icon in a column of its own and the title and meta
  // share the next; the card's meta line was at the padding edge. The
  // indent is the head's — the 22px glyph plus its 8px gap — and only a
  // head that has a glyph earns it; the bands below stay at the edge.
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head \{ gap: 8px;/);
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head > \.dev-card-icon \{\n  width: 22px;/);
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head:has\(> \.dev-card-icon\) \+ \.dev-card-meta \{ padding-left: 30px; \}/);
  // The title neither clamps nor reserves a second line any more: the
  // row's has always wrapped in full, and the card's does the same.
  assert.ok(!/dev-card-title-clamp/.test(CSS));
  // And the facts row under the status row is tabbed in like the meta line,
  // as the row's last line is; the status row and the band span the card.
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head:has\(> \.dev-card-icon\) ~ \.dev-card-facts \{ padding-left: 30px; \}/);
  assert.ok(!/\.dev-card-head:has\(> \.dev-card-icon\) ~ \.dev-card-status \{/.test(CSS), 'the bar row is not indented');
  // Folded rows sit 4px apart, as the Workshop's do.
  assert.match(CSS, /#dev-kanban \.dev-kanban-col > \.space-y-2 > :not\(\[hidden\]\) ~ :not\(\[hidden\]\) \{ margin-top: 4px; \}/);
});

test('Open card is one anchor to the item\u2019s page, on every surface and every kind', () => {
  // It used to be two controls wearing one word. On the Board it linked out;
  // on the Workshop it opened the topic screen's sections in place and only
  // relabelled to "Open page ›" on a second tap — and for a session, a merged
  // change or a governance item `_workshopCardBody` answered null, so those
  // navigated anyway. Three behaviours behind one label, decided by which
  // screen you had reached the card from. Now: one anchor, one destination.
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  const html = kanbanHtml(AppView);
  for (const kind of ['issues/1575', 'proposals/34']) {
    assert.match(html, new RegExp(`<a class="gc-vote-btn dev-ws-open-btn" href="#app/demo-app/dev/${kind}"[^>]*>Open card</a>`),
      `${kind}: a real link, labelled the same word`);
  }
  // A real anchor, not a button that navigates: it middle-clicks, it copies,
  // and the wrapper's click guard already excludes anchors so it does not
  // fold the card on its way out.
  assert.ok(!/<button[^>]*dev-ws-open-btn/.test(html), 'nothing draws it as a button');
  // And the machinery the in-place open needed is gone rather than orphaned.
  assert.ok(!/readAppView|TopicBodySections|dev-ws-detail/.test(FOLD),
    'the fold builds no topic body and renders no in-place region');
  assert.equal(typeof AppView._workshopCardBody, 'undefined',
    'and app-view.js keeps no builder with nothing to build for');
  assert.ok(!/\.dev-ws-detail/.test(CSS), 'nor app.css a rule for a region that never renders');
});

test('the declared checks follow the two rows and the row’s last line', () => {
  // Each re-pointed check names the seat that moved: the work-state chip in
  // the facts row, the vote on the Needs-you deck, Closes #N on the meta
  // line, the facts row under the status row, and the unclamped title.
  //
  // THE VOTE MOVED A SECOND TIME. It sat in the workshop row's trailing slot
  // until the tab redraft, which retired the row band entirely and made a
  // vote one full-screen question on Needs you. So the check walks the deck's
  // subject pane to the card, not a row seat; the loop below now guards the
  // retired band classes the same way it guards the older ones.
  //
  // THE PAIR IS CARD-THEN-SUMMARY, and the first spelling of this check had
  // it backwards — a later round moved the description UNDER the card, and
  // `.dev-ws-needs-summary + .gc-vote-item` kept describing the order before
  // that. Staging caught it, this file did not, which is why the assertion
  // now pins the `:has(+ …)` direction rather than just the class names.
  const byName = (re) => DAPP.tests.find((t) => re.test(t.name));
  assert.match(byName(/Underway column names the exact state/).expectSelector, /\.dev-card-facts \.dev-badge\[data-work-state="paused"\]/);
  // The Needs-you feed: the deck became a feed, and the check walks to the rail's Vote
  // control; a second check pins the item's own order (title, then the
  // sentence, then the caption) with the same `+`/`~` direction.
  assert.match(byName(/Needs-you tab is a feed of one decision per screen/).expectSelector, /\[data-ws-needs\] > \[data-ws-rail\] > button\[data-ws-rail-btn="vote"\]/);
  assert.match(byName(/leads with its title, then the sentence a voter reads/).expectSelector, /\.dev-ws-item-title \+ \.dev-ws-item-summary ~ \.dev-ws-item-caption > \.dev-ws-item-by/);
  assert.match(byName(/Closes-#N rides the meta line as a tag/).expectSelector, /\.dev-card-meta > \.dev-badge\[data-issue-chip\]/);
  assert.match(byName(/facts are a row of their own under the status row/).expectSelector, /\.dev-card-status ~ \.dev-card-badges\.dev-card-facts > \.dev-badge/);
  assert.match(byName(/a card title wraps in full/).expectSelector, /\.dev-card-title:not\(\.dev-card-title-clamp\):not\(\[title\]\)/);
  assert.match(byName(/the vote is one button beside the state bar/).expectSelector, /\.dev-card-status > \.dev-status-pill-block \+ \.dev-vote-btn/, 'the bar row keeps its check as it was');
  for (const t of DAPP.tests) {
    assert.ok(!/dev-card-band-break|dev-card-status-end|dev-ws-row-chat|dev-ws-row-band|dev-ws-row-trailing/.test(t.expectSelector || ''),
      `${t.name}: no check names a seat that no longer exists`);
  }
});

test('a merged card opens whole: the kudos slot is filled before paint, and the band re-folds around it', () => {
  // The slot is legacy-filled (`_fillKudosHosts`). Filled from a plain effect
  // it landed a frame after the card, and the pill popping in shoved "Open
  // card" along the band — the flicker at the bottom-left of every merged
  // card on open. Both surfaces fill it from a LAYOUT effect now, and the
  // fold measurement watches the band's subtree so it re-folds around the
  // filled slot in the same frame.
  assert.match(KANBAN, /useLayoutEffect\(\(\) => \{\s*const host = hostRef\.current;\s*if \(!host\) return;\s*callAppView\('_fillKudosHosts', host\);[\s\S]*?\}, \[openKey, unfolded\]\);/);
  assert.ok(!/\bimport \{[^}]*\buseEffect\b/.test(KANBAN), 'the column has no plain effect left to fill from');
  assert.match(WORKSHOP, /useLayoutEffect\(\(\) => \{\s*const host = hostRef\.current;\s*if \(!host\) return;\s*callAppView\('_wireFeedComments', host\);\s*callAppView\('_fillKudosHosts', host\);/);
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(CARD, /const mo = new MutationObserver\(measure\);\s*mo\.observe\(band, \{ childList: true, subtree: true, characterData: true \}\);/);
});

test('the message count rides the meta line at both sizes, and only when there is one', () => {
  const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(CARD, /const count = m\.chatCount \|\| 0;\s*if \(count > 0\) nodes\.push\(<Badge key="chat" b=\{\{ t: 'chat', key: 'chat', count \}\} \/>\);/);
  assert.ok(!/count \? <Badge b=\{\{ t: 'chat'/.test(FOLD), 'the row’s last line no longer draws it');
  assert.ok(!/\{chat\}/.test(CARD), 'nor the card’s rows');
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  AppView._proposals[0].chat_count = 5;
  const open = kanbanHtml(AppView);
  assert.match(open, /data-proposal-row="34"[\s\S]*?<div class="dev-card-meta">(?:(?!<\/div>)[\s\S])*?<span class="dev-chat-badge[^>]*data-count="5"/, 'on the open card');
  const quiet = makeAppView();
  quiet._proposals[0].chat_count = 5;
  const folded = kanbanHtml(quiet);
  assert.match(folded, /data-proposal-row="34"[\s\S]*?<span class="dev-ws-row-meta">(?:(?!<span class="dev-ws-row-band">)[\s\S])*?<span class="dev-chat-badge/, 'and on the row, in the same place');
  // The two sizes share one chrome now, too: the card's r22, its 14/14/12
  // padding with the 4px edge inside it, its 8px glyph gap, its drop shadow,
  // and no hairline border. Pinned value for value against the card's rule.
  const card = CSS.slice(CSS.indexOf('\ndiv:is(.dev-card-dense, .dev-card-topic) {'));
  assert.match(card, /border-radius: 22px;[\s\S]*?padding: 14px 14px 12px;\s*padding-left: calc\(14px \+ var\(--dev-edge-w\)\);/);
  assert.match(CSS, /\.dev-ws-row \{[^}]*padding: 14px 14px 12px; border-radius: 22px; border: 0;/);
  // The 8px glyph gap moved to the head when the row became a column, so the
  // bar underneath spans the whole row rather than starting past the glyph.
  assert.match(CSS, /\.dev-ws-row \{[^}]*flex-direction: column; align-items: stretch;/);
  assert.match(CSS, /\.dev-ws-row-head \{ display: flex; align-items: center; gap: 8px; \}/);
  assert.match(CSS, /\.dev-ws-row \{[^}]*padding-left: calc\(14px \+ var\(--dev-edge-w\)\);[^}]*0 1px 2px rgba\(0, 0, 0, 0\.06\);/);
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head \{ gap: 8px;/);
  assert.ok(!/\.dev-ws-row:hover \{ border-color/.test(CSS), 'no border to colour on hover');
});

// Round 15. Four differences the app's owner spotted on screen, each measured
// in a browser before and after. The first three are one line of CSS apiece;
// the fourth is the row's shape.
test('a press changes the fill and nothing else, and the row is the card minus its button row', () => {
  // -- The press ------------------------------------------------------
  // The kit gives every button an instant scale on press. The row carries
  // role="button" and the open card is a plain div, so the scale reached
  // exactly one of the two sizes: a pressed folded row drew inset and a
  // pressed open card did not. Opted out the way this stylesheet already
  // opts the segmented pills out, keeping the kit's brightness dim.
  assert.match(CSS, /\.dev-ws-row:active \{ transform: none; \}/);
  assert.match(CSS, /\.create-mode-pill:active,[\s\S]{0,160}\{\s*transform: none;\s*\}/,
    'the rule this one follows is still there to follow');

  // -- The three lines, and where each starts -------------------------
  // The card's anatomy is three siblings: head (glyph + title), meta line,
  // status row. The row used to be a head beside a two-line text column,
  // which put both lines below the title 30px in. Measured in Chromium at
  // 340px, folded then open: title 48/48, meta 48/48, status 18/18.
  assert.match(FOLD, /<span className="dev-ws-row-head">\s*\{c\.icon \? <CardIcon[\s\S]*?<\/span>\s*\{\/\*[\s\S]*?\*\/\}\s*<span className="dev-ws-row-meta">\{metaLineNodes\(c\)\}<\/span>\s*<RowBand/,
    'head, meta and band are siblings, in the card’s order');
  assert.ok(!/dev-ws-row-main/.test(FOLD) && !/\.dev-ws-row-main[\s,{>]/.test(CSS),
    'the text column that held the meta line and the band 30px in is gone');
  // The meta line's tab is the CARD's rule, condition and all: 30px, and
  // only when there is a glyph to tab past.
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-head:has\(> \.dev-card-icon\) \+ \.dev-card-meta \{ padding-left: 30px; \}/);
  assert.match(CSS, /\.dev-ws-row-head:has\(> \.dev-card-icon\) \+ \.dev-ws-row-meta \{ padding-left: 30px; \}/);

  // -- The two gaps ---------------------------------------------------
  // Title to meta: the card stacks them flush, the row carried a 1px column
  // gap plus a 1px margin, so the same two lines sat 2px apart folded and
  // 0px open. Meta to status: the card's 8px, the row's 4px+1px.
  assert.match(CSS, /\.dev-ws-row-meta \{[^}]*margin-top: 0;/);
  assert.ok(!/\.dev-ws-row-head \{[^}]*row-gap/.test(CSS), 'and no gap standing in for it');
  assert.match(CSS, /\.dev-ws-row-band \{[^}]*margin-top: 8px;/);
  assert.match(CSS, /:is\(\.dev-card-dense, \.dev-card-topic\) \.dev-card-badges \{ margin-top: 8px;/,
    'which is the card’s own');
});
