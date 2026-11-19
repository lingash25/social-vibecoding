'use strict';

// Home's card in `#home-aside` (frontend/src/features/home/needs-you-card.tsx):
// it was the Needs you card and, since #6816, lists the project's recent
// threads, the same list the notifications sheet's Recent threads tab shows.
// The file, the component and the id keep the names they had, because the
// look's CSS knows the section by `#home-needs-card`.
//
//   1. It is drawn where there is a thread to list, as a section: its label
//      line on the page, then one card.
//   2. Rows read like the sheet's own (ThreadRow): the project's 44px tile,
//      what the thread is, its title and the project with how long ago. No
//      pill: a row here is not something asked of the viewer.
//   3. Beside Pinned apps the column lists as many as fit and its last row
//      says how many more there are; everywhere else it lists NEEDS_ROWS.
//
// Run with: node --test tests/home-needs-you-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/needs-you-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const thread = (threadId, extra = {}) => ({
  threadId,
  kind: 'change',
  number: threadId + 100,
  title: `Thread ${threadId}`,
  appSlug: 'plant-pal',
  appName: 'Plant Pal',
  lastAt: '2026-11-18T09:00:00.000Z',
  href: `#app/plant-pal/dev/changes/${threadId + 100}`,
  ...extra,
});

test('the island mounts it under Standard (WIP) and the brand look, in a row of its own before Challenges', () => {
  const island = read('frontend/src/features/home/index.tsx');
  // Standard (WIP) mounts it as soon as the look and the viewer are known, so its
  // place is held from the first paint; the brand look mounts it with the grid.
  assert.match(island, /const aside = wip \? viewer : brand && grid\.ready && !!grid\.create;/);
  assert.match(island, /\{wip \|\| brand \? \(\s*<div id="home-row" className="home-row">\s*\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NeedsYouCard \/>\s*<\/aside>\s*\) : null\}\s*<ChallengesSection \/>\s*<\/div>\s*\) : null\}/);
  assert.match(island, /\{wip \|\| brand \? null : <ChallengesSection \/>\}/, 'every other look keeps Challenges in its own place');
  // A row of its own, as wide as the column, placed right under Pinned projects.
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin-wip\] \.home-row > \.home-aside > \* \{ flex: 1 1 auto; min-width: 0; \}/);
  assert.match(css, /html\[data-skin-wip\] #home-screen \.home-main > \.home-row \{ display: contents; \}/);
  assert.match(css, /html\[data-skin-wip\] #home-screen \.home-row > \.home-aside \{ order: 1; \}/);
});

test('it is a section as Pinned apps is: its label line on the page, then one card of recent threads', () => {
  const src = read(CARD);
  assert.match(src, /const count = feed \? \(serverTotal \?\? feed\.length\) : hint;/);
  assert.match(src, /const drawn = feed \? feed\.length > 0 : hint > 0;/);
  assert.match(src, /if \(!drawn\) return null;/);
  assert.match(src, /<section ref=\{sectionRef\} id="home-needs-card" aria-label=\{t\('home:needsCard\.eyebrow'\)\} data-threads=\{String\(count\)\}>/);
  // The label, the count and a chevron are one thing to press, opening the
  // sheet's own list; it is a button, because the list is a sheet not a page.
  assert.match(src, /<SectionHeading>\s*<WipHeadMore\s+id="home-needs-card-btn"\s+direction="right"\s+onClick=\{openThreadsList\}/);
  assert.match(src, /<span id="home-needs-card-title" className="wip-head-words">\{t\('home:needsCard\.eyebrow'\)\}<\/span>\s*<span className="wip-count" aria-hidden="true">\{count\}<\/span>\s*<\/WipHeadMore>/);
  assert.match(src, /label=\{leftOut > 0 \? t\('home:needsCard\.seeAllCount', \{ count \}\) : t\('home:needsCard\.seeAll'\)\}/, 'it has no words of its own on screen, so its name says what it opens');
  assert.equal(message('home:needsCard.eyebrow'), 'Recent threads');
  assert.equal(message('home:needsCard.seeAll'), 'See all');
  assert.equal(message('home:needsCard.seeAllCount_other'), 'See all {{count}}');
  // The number is a glyph beside the label; a screen reader gets the sentence.
  assert.match(src, /<span className="sr-only">\{t\('home:needsCard\.total', \{ count \}\)\}<\/span>/);
  assert.equal(message('home:needsCard.total_one'), '{{count}} recent thread');
  assert.equal(message('home:needsCard.total_other'), '{{count}} recent threads');
  // The card holds the list alone.
  assert.match(src, /<WipCard className="wip-panel" data-tone="ask">\s*<ul ref=\{listRef\} className="wip-rows wip-rows-cols"/);
});

test('the list is the sheet\'s own recent threads, read once where the card is drawn', () => {
  const src = read(CARD);
  const { THREADS_LIMIT } = loadTsx(CARD);
  assert.equal(THREADS_LIMIT, 50, 'the page\'s own maximum: more than any column lists');
  assert.doesNotMatch(src, /matchMedia/, 'the card is drawn at every width, so nothing waits on one');
  assert.doesNotMatch(src, /needs-feed/, 'what waits for a vote is not this card any more');
  assert.match(src, /sharedJson<\{ threads\?: RecentThreadItem\[\]; total\?: number \}>\(/);
  assert.match(src, /`\/api\/me\/recent-threads\?limit=\$\{THREADS_LIMIT\}\$\{demoQuery\(\)\}`/);
  assert.match(src, /setServerTotal\(Number\.isFinite\(Number\(body\.total\)\) \? Number\(body\.total\) : body\.threads\.length\)/, 'the count is the whole list\'s, not one page\'s');
});

test('while the list is on its way the card holds its place, from what the last visit saw', () => {
  const src = read(CARD);
  const { NEEDS_HINT_KEY } = loadTsx(CARD);
  assert.equal(NEEDS_HINT_KEY, 'homeroom:recent-threads');
  // The count of the last visit stands in until this load's list arrives, and is kept once it does.
  assert.match(src, /const \[hint\] = useState\(readNeedsHint\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(feed\) writeNeedsHint\(count\); \}, \[feed, count\]\);/);
  // Zero is removed, so somebody with no threads gets no placeholder to flash and go.
  assert.match(src, /if \(count > 0\) window\.localStorage\.setItem\(NEEDS_HINT_KEY, String\(count\)\);\s*else window\.localStorage\.removeItem\(NEEDS_HINT_KEY\);/);
  // As many placeholder rows as the last visit saw, in the list's own columns, said once in words.
  assert.match(src, /\{!feed \? \(/);
  assert.match(src, /<WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label=\{t\('home:grid\.loading'\)\}>/);
  assert.match(src, /Array\.from\(\{ length: Math\.min\(hint, NEEDS_ROWS\) \}, \(_, i\) => <li key=\{i\}><WipSkelRow \/><\/li>\)/);
});

test('beside Pinned apps it lists as many as fit, and its last row says how many more there are', () => {
  const { needsLayout, NEEDS_ROWS } = loadTsx(CARD);
  const feed = Array.from({ length: 16 }, (_, i) => thread(i + 1));
  assert.equal(NEEDS_ROWS, 8, 'where the column cannot be measured it lists two lines of four');
  assert.deepEqual(needsLayout(feed, null), { rows: feed.slice(0, NEEDS_ROWS), more: 0 }, 'no measurement: as it always listed');
  const { rows, more } = needsLayout(feed, 7);
  assert.equal(rows.length, 6, 'one row of the space goes to the "more" row');
  assert.equal(more, 10);
  assert.equal(rows.length + more, feed.length, 'the rows shown plus "N more" are the count in the heading');
  const two = feed.slice(0, 2);
  assert.deepEqual(needsLayout(two, 7), { rows: two, more: 0 }, 'a short list lists all of itself and ends there');
  assert.deepEqual(needsLayout(feed, 16), { rows: feed, more: 0 }, 'everything fits: no "more" row');
  // With only room for one row, that one and the "more" row are the column.
  const tight = needsLayout(feed, 2);
  assert.deepEqual(tight.rows, feed.slice(0, 1));
  assert.equal(tight.more, 15);
  // A list longer than the page the card asked for counts what it could not
  // have asked for either: the heading's number stays the rows plus "more".
  const long = needsLayout(feed, 7, 40);
  assert.equal(long.rows.length + long.more, 40);
  const src = read(CARD);
  // It measures the column beside Pinned apps only: the page's grid puts the aside in column 2.
  assert.match(src, /getComputedStyle\(aside\)\.gridColumnStart !== '2'/);
  assert.match(src, /new ResizeObserver\(measure\);/);
  assert.match(src, /aside\.clientHeight - \(heading\?\.offsetHeight \|\| 0\) - padding/);
  // The last row opens the whole list and carries the count.
  assert.match(src, /<button type="button" className="wip-row wip-row-more" data-threads-more="" onClick=\{openThreadsList\}>\s*\{t\('home:needsCard\.more', \{ count: more \}\)\}/);
  assert.equal(message('home:needsCard.more_other'), '{{count}} more');
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /#home-needs-card \.wip-rows > li:nth-child\(n \+ 6\)/, 'nothing is hidden after the fifth');
  assert.match(css, /#home-needs-card \.wip-row-more \{[^}]*width: 100%;[^}]*text-align: start;/, 'a button takes the row\'s width');
});

test('the heading and the last row open the sheet on its Recent threads list', () => {
  const src = read(CARD);
  assert.match(src, /import \{ notificationsSheetStore \} from '\.\.\/notifications\/notifications-sheet-store\.js';/);
  assert.match(src, /try \{ notificationsSheetStore\.set\(\{ tab: 'threads' \}\); \}/);
  assert.match(src, /if \(typeof win\.App\?\.openNotificationsSheet === 'function'\) \{ win\.App\.openNotificationsSheet\(\); return; \}/);
  assert.match(src, /win\.NotificationsSheet\?\.open\?\.\(\);/);
  // The sheet picks the tab up as it opens, and clears the request.
  const sheet = read('frontend/src/features/notifications/notifications-sheet.tsx');
  assert.match(sheet, /if \(!open \|\| !wantedTab\) return;\s*setTab\(wantedTab\);\s*notificationsSheetStore\.set\(\{ tab: null \}\);/);
});

test('a row reads like a Recent threads row: the project\'s tile, what it is, its title, the project and how long ago', () => {
  const src = read(CARD);
  const { kindId } = loadTsx(CARD);
  assert.equal(kindId({ kind: 'change', number: 6800 }), 'home:needsCard.kind.change');
  assert.equal(kindId({ kind: 'change', number: null }), 'home:needsCard.kind.changeBare');
  assert.equal(kindId({ kind: 'decision', number: null }), 'home:needsCard.kind.decision');
  assert.equal(kindId({ kind: 'request', number: 6790 }), 'home:needsCard.kind.request');
  assert.equal(kindId({ kind: 'request', number: null }), 'home:needsCard.kind.requestBare');
  assert.equal(message('home:needsCard.kind.change'), 'Change #{{number}}');
  assert.equal(message('home:needsCard.kind.request'), 'Request #{{number}}');
  assert.equal(message('home:needsCard.kind.decision'), 'Decision');
  assert.equal(message('home:needsCard.meta'), '{{project}} · <0>{{when}}</0>');
  // The same app tile the notifications sheet draws, from the same two pieces.
  assert.match(src, /from '\.\.\/apps\/app-card-view'/);
  assert.match(src, /data-icon=\{appIconKind\(app\)\}\s*className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"\s*>\s*<AppIconContent app=\{app\} \/>/);
  // Three lines in the text column, the title on one line.
  assert.match(src, /<span className="wip-item-kind block text-xs text-zinc-500 dark:text-zinc-400 truncate">\s*\{t\(kindId\(thread\)/);
  assert.match(src, /<b className="wip-item-title block text-\[15px\] font-\[650\] truncate">\{thread\.title\}<\/b>/);
  assert.match(src, /<RichMessage\s+id="home:needsCard\.meta"\s+values=\{\{ project: app\.name, when \}\}\s+components=\{\[<time title=\{whenTitle\} \/>\]\}\s*\/>/);
  // No waiting time: the project's name alone.
  assert.match(src, /\) : \(\s*<span className="wip-item-meta block text-\[13px\][^"]*">\{app\.name\}<\/span>/);
  // No pill: these are not things asked of the viewer.
  assert.doesNotMatch(src, /wip-pill/, 'conversation is not a vote');
  assert.doesNotMatch(src, /home:needsCard\.(vote|advisoryPill)/);
});

test('a row is the thread\'s own page, and the card lists what is in the look\'s columns', () => {
  const src = read(CARD);
  assert.match(src, /<a className="wip-row" href=\{thread\.href\} data-recent-thread=\{thread\.threadId\}>/, 'a row is a link a new tab can open');
  assert.match(src, /<ul ref=\{listRef\} className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">/);
  // As many columns as the look has room for, the number Challenges' cards read too.
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-rows-cols \{ grid-template-columns: repeat\(var\(--wip-cols, 1\), minmax\(0, 1fr\)\);/);
  // Four from 1024px, where Pinned projects' own four columns become rows: the lists share their lines.
  for (const [at, n] of [['640px', 2], ['1024px', 4]]) {
    assert.match(css, new RegExp(`@media \\(min-width: ${at}\\) \\{ html\\[data-skin-wip\\] \\{ --wip-cols: ${n}; \\} \\}`));
  }
  assert.match(css, /\.wip-poster \{\s*display: flex;\s*flex: 0 0 calc\(\(100% - \(var\(--wip-cols, 1\) - 1\) \* var\(--wip-col-gap\)\) \/ var\(--wip-cols, 1\)\);/, 'a challenge is one of the same columns');
});

test('a challenge is its picture, then its words beside it, in a row that pages with an arrow at each end', () => {
  const src = read('frontend/src/features/home/panels/challenges.tsx');
  assert.match(src, /className="wip-poster"[\s\S]{0,400}<WipChallengeArt[\s\S]{0,200}<span className="wip-item-text">/, 'the picture first, the words in their own column');
  // An arrow is drawn only while there is more that way, and names where it goes.
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-back" aria-label=\{t\('home:challenges\.scrollBack'\)\} onClick=\{\(\) => page\(-1\)\}/);
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-on" aria-label=\{t\('home:challenges\.scrollOn'\)\} onClick=\{\(\) => page\(1\)\}/);
  assert.equal(message('home:challenges.scrollBack'), 'Earlier challenges');
  assert.equal(message('home:challenges.scrollOn'), 'More challenges');
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-poster-art \{[^}]*width: var\(--wip-poster-art\);[^}]*height: var\(--wip-poster-art\);/);
  // A row and a poster keep a project tile's own padding, so the three lists' icons start on the same lines.
  assert.match(css, /\.wip-row \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
  assert.match(css, /\.wip-poster \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
});

test('the brand kit V2 tokens use yellow and green as marks, never as a row\'s ground, and a project\'s name is one size', () => {
  const css = read('public/css/app.css');
  const at = css.indexOf('html[data-skin-wip][data-wip-tokens="brand2"] {');
  const v2 = css.slice(at, css.indexOf('}', at));
  assert.match(v2, /--wip-label-mark: #ffee6f;/, 'yellow is the stroke under a title');
  assert.match(v2, /--wip-worth-bg: rgb\(169 207 151 \/ 0\.5\);/, 'green is the tag behind a challenge\'s points');
  assert.match(v2, /--wip-pill-bg: #000000;\s*--wip-pill-ink: #fffeea;/, 'what is pressed is cream on black');
  assert.doesNotMatch(v2, /--wip-(ask|goal)-bg/, 'no block of colour behind Needs you or Challenges');
  // The stroke is on a title's words alone: the kit gives plain words their own span.
  assert.match(read('frontend/src/features/home/wip-kit.tsx'), /typeof children === 'string' \? <span className="wip-head-words">\{children\}<\/span> : children/);
  // A plain pill in a card that asks reads the card's own ink (Advisory was pale on yellow in the dark).
  assert.match(css, /--wip-ink-soft: var\(--wip-ask-ink\);/);
  // One size at every width, outside any media query.
  assert.match(css, /\nhtml\[data-skin-wip\] #app-list \.app-card-title \{\s*font-size: var\(--wip-title-size\);/, 'at the start of a line: not inside a media query');
  // On a phone alone it is a size down: four across leaves a name about 85px.
  assert.match(css, /@media \(max-width: 639\.98px\) \{[^@]*html\[data-skin-wip\] #app-list \.app-card-title \{ font-size: var\(--wip-title-size-phone\);/);
});

test('Standard (WIP): a project\'s hub folds Invite and Make it public into its hero, and keeps Needs you in For you\'s row', () => {
  const card = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  // No Invite card and no Share it card under the look: both actions are the hero's.
  assert.match(ws, /const wipLook = useLiveSkin\(\) === 'wip';/);
  assert.match(ws, /inviteCard=\{!wipLook\}/);
  assert.match(card, /if \(wipLook\) return null;/, 'Share it is not drawn under the look');
  assert.match(card, /\{wipLook \? <WipHeroPublic slug=\{slug\} name=\{displayName\} data=\{data\} \/> : null\}/);
  assert.match(card, /function WipHeroPublic\([^)]*\): ReactNode \{\s*if \(data\.audience !== 'solo' \|\| !data\.can_manage \|\| data\.audience_change\) return null;\s*return <MakePublic /, 'Make it public is offered to exactly whom Share it offers it');
  // Invite ends the line about who is here, for a member, and opens the same pane.
  assert.match(card, /\{member \? \(\s*<button type="button" className="wip-hub-meta-invite" data-ws-community-invite="" title=\{t\('project:communityCard\.invite\.title'\)\} onClick=\{openInviteLinks\}>/);
  assert.match(card, /\{wipLook \? null : \(\s*<>\s*\{member && !\(inviteCard && showsInviteHero\(data\) && !inviteClosed\) \? \(/, 'one Invite on the page');
  // The hero's scenery is for show.
  assert.match(card, /<span className="wip-hero-wash" aria-hidden="true" \/>\s*<span className="wip-hero-art" aria-hidden="true">/);
  // Needs you stays in the row with nothing waiting, shaped as its neighbours.
  assert.match(hub, /if \(alone && !claims && !wipLook\) return null;/);
  assert.match(hub, /className="dev-ws-week-note wip-hub-door" data-ws-hub-needs-none=""/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin-wip\] #dev-workshop \[data-ws-hub-topics\] \{ display: none; \}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, 'For you is three across from 768px');
});

test('Standard (WIP): a project\'s empty Needs you says so as good news, with the ways on under it', () => {
  // The run knows no look: the two pieces beside it read it (project-needs.tsx).
  const flow = read('frontend/src/features/review-flow/review-flow.tsx');
  const beside = read('frontend/src/features/review-flow/project-needs.tsx');
  assert.match(flow, /<ProjectNeedsEmpty slug=\{slug\} project=\{project\} anchorRef=\{anchorRef\}>\s*<p ref=\{anchorRef as never\}[^>]*data-needs-empty="" data-review-flow="">/, 'the plain line is every other look\'s');
  assert.match(flow, /<ProjectWaysIn slug=\{slug\} project=\{project\} \/>/, 'under what waits, too');
  assert.match(beside, /return useLiveSkin\(\) === 'wip' && !!slug && !!project;/);
  assert.match(beside, /if \(!drawn\) return children;\s*return \(\s*<div ref=\{anchorRef\} className="wip-needs" data-needs-empty="" data-review-flow="">/, 'the same hooks the plain line carries');
  assert.match(beside, /door\('1', 'workshop'[\s\S]{0,400}door\('3', 'discussion'[\s\S]{0,400}door\('2', 'status'/);
  assert.equal(message('communities:reel.caughtUp.title'), 'You\'re all caught up');
  assert.equal(message('communities:reel.caughtUp.next'), 'While you\'re here');
});

test('Standard (WIP): a board card\'s line says who and when first, then the item\'s number as a code', () => {
  const src = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(src, /<span className="dev-ws-wrow-sub">\{rowWords\(b, \{ whoFirst: wipLook \}\)\}<\/span>/);
  assert.match(src, /if \(opts\.whoFirst\) \{\s*if \(b\.by && opts\.by !== false\) parts\.push\(b\.by\);\s*if \(b\.ago && opts\.ago !== false\) parts\.push\(b\.ago\);\s*parts\.push\(codeWords\(b\)\);/);
  assert.equal(message('project:workRow.code.request', { number: 6465 }), 'R#6465');
  assert.equal(message('project:workRow.code.change', { number: 5990 }), 'PR#5990');
});

test('Standard (WIP): the board ties a request to the changes made for it, and opens on the board', () => {
  const { tiesOf } = loadTsx('frontend/src/features/dev-board/workshop/board-links.ts');
  const row = (noun, num, links) => ({
    getAttribute: (name) => ({ 'data-ws-noun': noun, 'data-ws-num': String(num), 'data-ws-for': links || null })[name] ?? null,
  });
  const request = row('request', 6464);
  const other = row('request', 6420);
  const change = row('change', 6460, '6464');
  const both = row('change', 6500, '6420,6464');
  const vote = row('vote', 2462);
  const rows = [request, other, change, both, vote];
  // From the request: each change made for it, request → change.
  assert.deepEqual(tiesOf(request, rows), [{ from: request, to: change }, { from: request, to: both }]);
  // From a change: the requests it is for that are on the board, still request → change.
  assert.deepEqual(tiesOf(both, rows), [{ from: request, to: both }, { from: other, to: both }]);
  assert.deepEqual(tiesOf(vote, rows), [], 'a vote is tied to nothing');
  // Nothing is written to the board: the drawing is a layer of its own on <body>.
  const src = read('frontend/src/features/dev-board/workshop/board-links.ts');
  assert.match(src, /document\.body\.appendChild\(svg\);/);
  assert.doesNotMatch(src, /classList|setAttribute\('class'|\.style\./, 'no class or style is written to a row');
  const row2 = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(row2, /\{\.\.\.\(board && wipLook && b\.n \? \{\s*'data-ws-noun': b\.noun,\s*'data-ws-num': String\(b\.n\),/);
  // The Workshop's door opens the board, and the board is by stage alone.
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /if \(!wipLook \|\| tab !== 'workshop'\) return;\s*if \(was === 'all' \|\| was === 'bot'\) return;\s*if \(traversed\.current\) \{ traversed\.current = false; return; \}\s*cameFrom\.current = 'all';\s*setTab\('all'\);/);
  assert.match(ws, /if \(wipLook && group !== 'stage'\) callAppView\('_setWorkshopGroup', 'stage'\);/);
  assert.match(ws, /useEffect\(\(\) => \(wipLook && tab === 'all' \? watchBoardLinks\(\) : undefined\), \[wipLook, tab\]\);/);
  // Advanced mode is on <html> for the look's one detail kept for it.
  assert.match(read('frontend/src/head.html'), /root\.setAttribute\('data-interface-mode', basic \? 'basic' : 'advanced'\);/);
  assert.match(read('public/css/app.css'), /html\[data-skin-wip\]\[data-interface-mode="basic"\] #dev-kanban \[data-attr-field="category"\] \{ display: none; \}/);
});

test('Standard (WIP): the menu is the token set\'s own panel, and a pinned project says who is in it', () => {
  const css = read('public/css/app.css');
  // The sidebar and the phone's bar are one panel, drawn from the menu's tokens at every width.
  assert.match(css, /html\[data-skin-wip\] #platform-tabs \{[^}]*background: var\(--wip-nav-bg\);[^}]*font-family: var\(--wip-nav-font\);/);
  assert.match(css, /html\[data-skin-wip\]\[data-wip-tokens="brand"\] \{\s*--wip-nav-bg: #3c7bd8;/, 'the brand sets wear the brand\'s own sky');
  assert.match(css, /\[aria-current="page"\] \{\s*background: var\(--wip-nav-on-bg\);\s*box-shadow: none;\s*color: var\(--wip-nav-on-ink\);/);
  // The brand is the logotype at the panel's top, and the top bar starts beside the panel.
  assert.match(css, /html\[data-skin-wip\] #platform-tabs::before \{[^}]*mask: var\(--wip-nav-brand-logo\) left center \/ contain no-repeat;/);
  assert.match(css, /#platform-header \{ padding-inline-start: calc\(var\(--wip-nav-w\) \+ 1rem\); \}/);
  // A folded sidebar opens from its arrow alone.
  assert.match(read('frontend/src/features/nav/rail-peek.ts'),
    /export function enterPeek\(\): void \{\s*clearPeekTimer\(\);[^}]*hasAttribute\('data-skin-wip'\)\) return;/);
  // A pinned project: members, then contributors, each on its line; no sentence; the same air on four sides.
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /t\('home:grid\.tile\.members', \{ count: app\.members, formatted: app\.members\.toLocaleString\(\) \}\)/);
  assert.equal(message('home:grid.tile.members_other', { formatted: '1,284', count: 1284 }), '1,284 members');
  assert.match(read('frontend/src/features/home/home.js'), /members: Math\.max\(0, Number\(app\.member_count\) \|\| 0\),/);
  assert.match(css, /html\[data-skin-wip\] #app-list \.app-card-desc \{ display: none; \}/);
  assert.match(css, /html\[data-skin-wip\] #app-list \{ padding: var\(--wip-cell-pad\); \}/);
  // A recent thread is its title, its project and when.
  assert.match(css, /html\[data-skin-wip\] #home-needs-card \.wip-item-kind \{ display: none; \}/);
});
