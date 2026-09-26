// Cmd-click opens a navigation control in a new tab (#1036).
//
// The shell is a hash-routed SPA whose navigation chrome was built as
// <button>/<div> + a click handler that assigns location.hash. Every
// screen HAS an address, so the only thing standing between the user and
// "⌘-click the home icon to open home in a new tab" was the element tag.
//
// Two mechanisms now cover it, and both fail SILENTLY if they drift — a
// button quietly stops being an anchor, or a guard gets dropped and the
// handler preventDefaults a modified click again. So each strand is
// pinned against the shipped source, in the static-assertion style of
// tests/drawer-nav-motion.test.js (there is no DOM in this suite).
//
// Run with: node --test tests/nav-new-tab.test.js

const test = require('node:test');
const { shellMarkup } = require('./lib/shell-markup');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const navLinkJs = read('public/js/nav-link.js');
const html = shellMarkup();
const swJs = read('public/js/../sw.js');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const browseJs = read('frontend/src/features/apps/browse.js');
// #1191 slice 6 conversion 3 split the browse screen the same way chunk G
// split the dev chat: browse.js still decides where a row or the back link
// GOES, and the two components below are what carry the anchor and the
// NavLink wiring. Both halves are read here, and the browse entries that used
// to ride the shared ANCHORS / ROWS tables are hand-written below instead —
// one table row cannot span two files.
const browseListTsx = read('frontend/src/features/apps/browse-list.tsx');
const browseDetailTsx = read('frontend/src/features/apps/browse-detail.tsx');
const devChatJs = read('frontend/src/features/dev-chat/dev-chat.js');
const chatFrameTsx = read('frontend/src/features/dev-board/chat-frame.tsx');
const topicFrameTsx = read('frontend/src/features/dev-board/topic-frame.tsx');
const sessionHeaderTsx = read('frontend/src/features/dev-chat/session-header.tsx');
const topicBackTsx = read('frontend/src/features/dev-board/topic/topic-back.tsx');
const topicHeadTsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
const headerTsx = read('frontend/src/features/header/platform-header.tsx');
const improveStoreJs = read('frontend/src/features/improve/improve-store.js');
const { HOME_SRC: homeJs } = require('./helpers/home-modules');
const leaderboardJs = read('frontend/src/features/leaderboard/leaderboard.js');
const kudosPaneTsx = read('frontend/src/features/leaderboard/kudos-pane.tsx');
const settingsJs = read('frontend/src/features/settings/settings.js');
const adminConsoleJs = read('frontend/src/features/admin/admin-console.js');
const dapp = JSON.parse(read('dapp.json'));

// The body of one method in the NavLink object literal.
function navLinkFn(signature) {
  const at = navLinkJs.indexOf(signature);
  assert.ok(at !== -1, `NavLink.${signature} went missing`);
  const end = navLinkJs.indexOf('\n    },', at);
  assert.ok(end !== -1, `could not find the end of NavLink.${signature}`);
  return navLinkJs.slice(at, end);
}

// The listener body registered on `anchor`, from the addEventListener
// call through the end of its callback.
function handlerAfter(src, anchor, span = 700) {
  const at = src.indexOf(anchor);
  assert.ok(at !== -1, `${anchor} went missing`);
  return src.slice(at, at + span);
}

// ── The shared module ──────────────────────────────────────────────────

test('NavLink ships and is exposed on window', () => {
  assert.match(navLinkJs, /window\.NavLink = NavLink;/,
    'every consumer resolves it off window — there is no module system here');
});

test('isNativeClick defers to the browser on every modified activation', () => {
  const fn = navLinkFn('isNativeClick(e) {');
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.ok(fn.includes(key),
      `${key} must be honoured — suppressing it means overriding a user gesture`);
  }
  assert.match(fn, /e\.button !== 0/,
    'a non-primary button (middle-click) is the browser\'s to handle');
  assert.match(fn, /defaultPrevented/,
    'an event another handler already claimed must not be re-claimed here');
  // ?shot= screenshot hooks fire synthetic .click()s, which carry no
  // `button` — treating those as non-primary would break every capture.
  assert.match(fn, /typeof e\.button === 'number'/,
    'a synthetic .click() has no button and must still read as a plain click');
});

test('isNewTabClick covers cmd/ctrl and the middle button', () => {
  const fn = navLinkFn('isNewTabClick(e) {');
  assert.match(fn, /e\.button === 1/, 'middle-click is the mouse-wheel new-tab gesture');
  assert.match(fn, /metaKey \|\| e\.ctrlKey/, 'cmd on macOS, ctrl everywhere else');
});

test('absolute() resolves against the SHELL document, never an app iframe', () => {
  const fn = navLinkFn('absolute(href) {');
  assert.match(fn, /new URL\([\s\S]{0,60}window\.location\.href\)/,
    'resolving against anything else (an app iframe URL) would open a new tab '
    + 'on a page that is not a usable top-level address — that IS the bug');
});

test('homeHref() returns the canonical root and keeps non-route query params', () => {
  const fn = navLinkFn('homeHref() {');
  assert.match(fn, /window\.App\?\._rootUrl/,
    'uses the same canonical root serializer as App.updateHash');
  assert.match(fn, /'\/' \+ window\.location\.search/,
    'mirrors the home branch of App.updateHash — the staging ?token= and '
    + '?demo= must survive into the new tab');
});

test('bind() guards before preventDefault, and treats a falsy href as inert', () => {
  const fn = navLinkFn('bind(el, href, onActivate) {');
  const guard = fn.indexOf('NavLink.isNativeClick(e)');
  const prevent = fn.indexOf('e.preventDefault()');
  assert.ok(guard !== -1 && prevent !== -1);
  assert.ok(guard < prevent,
    'preventDefault before the guard would swallow the browser\'s new-tab');
  assert.match(fn, /removeAttribute\('href'\)/,
    'no resolvable route means no href — better than minting #app/undefined/dev');
});

test('wireModified() binds auxclick as well as click', () => {
  const fn = navLinkFn('wireModified(el, hrefFn, onActivate) {');
  assert.match(fn, /addEventListener\('auxclick'/,
    'a middle-click on a NON-anchor fires auxclick only — without this the '
    + 'mouse-wheel press on a list row does nothing');
  assert.match(fn, /window\.open\(NavLink\.absolute\(href\), '_blank', 'noopener'\)/,
    'the opened URL must be the absolute one, and noopener is not optional');
  assert.match(fn, /if \(!href\) return true;/,
    'a falsy href means the control is inert right now — a modified click '
    + 'must then behave exactly like the plain click (nothing)');
});

test('no converted control opts into target=_blank', () => {
  // In the Flutter WebView target=_blank pushes a PLAIN tap out to the
  // system browser, which is the opposite of the intent here.
  assert.ok(!/id="back-btn"[^>]*target=/.test(html),
    'the header control must not carry target — see NavLink\'s header comment');
  for (const [name, src] of [['app-view.js', appViewJs], ['dev-chat.js', devChatJs],
    ['browse.js', browseJs], ['browse-list.tsx', browseListTsx],
    ['browse-detail.tsx', browseDetailTsx], ['leaderboard.js', leaderboardJs],
    ['kudos-pane.tsx', kudosPaneTsx]]) {
    for (const id of ['dc-back', 'dev-chat-back', 'dev-topic-back',
      'browse-detail-back', 'data-lb-back']) {
      const at = src.indexOf(`${id}"`) !== -1 ? src.indexOf(`${id}"`) : src.indexOf(id);
      if (at === -1) continue;
      const tag = src.slice(at, src.indexOf('>', at));
      assert.ok(!tag.includes('target='),
        `${name}'s ${id} must not carry target=_blank`);
    }
  }
  // NavLink must never SET the attribute either. (Its own header comment
  // names it in prose, and wireModified passes '_blank' as window.open's
  // window NAME — neither is an anchor target, so match on the setters.)
  assert.ok(!/setAttribute\(\s*'target'/.test(navLinkJs)
    && !/\.target\s*=/.test(navLinkJs),
    'NavLink itself must never set an anchor target');
});

test('the module is registered in the shell AND the service worker', () => {
  assert.match(html, /<script src="\/js\/nav-link\.js"><\/script>/,
    'the shell has to load it');
  assert.ok(html.indexOf('/js/nav-link.js') < html.indexOf('/js/platform-ui.js'),
    'it has no dependencies and several later modules consume it — load it first');
  assert.match(swJs, /'\/js\/nav-link\.js',/,
    'a module missing from the precache list 404s the whole shell offline');
});

// ── The header control ─────────────────────────────────────────────────

test('the header back/home control is a real anchor', () => {
  assert.match(html, /<a id="back-btn"/,
    'a <button> ignores cmd-click — being an anchor IS the fix');
  assert.ok(!/<button id="back-btn"/.test(html), 'the old button tag is gone');
  // The 28px header content-row floor is load-bearing (see
  // tests/header-height-parity.test.js); an <a> is `inline` where a
  // <button> was `inline-block`.
  const tag = html.match(/<a id="back-btn"[^>]*>/)[0];
  assert.match(tag, /\binline-flex\b/, 'the anchor keeps the icon block-level');
  assert.match(tag, /\bitems-center\b/, 'and centred in the 28px row');
  assert.match(tag, /\bhidden\b/, 'it still ships hidden — app.js toggles that class');
  // TWO icons live inside it, exactly one shown. #back-icon-home retired in
  // #1443 and is back: that retirement left the app itself, Profile,
  // Settings, Admin and Messages with nothing in this bar at all, and the
  // rule is "every page has a back or a home button, except Home" now.
  //
  // Both ship in the COLD DOCUMENT rather than one being rendered at a time,
  // because an id that comes and goes with the route is an id that dapp.json
  // selectors and the shell inventory cannot rely on.
  const inner = html.slice(html.indexOf('<a id="back-btn"'), html.indexOf('</a>', html.indexOf('<a id="back-btn"')));
  assert.match(inner, /id="back-icon-home"/, 'the house');
  assert.match(inner, /id="back-icon-arrow"/, 'the chevron');
  assert.match(inner, /id="back-icon-close"/, 'and the ✕ that steps out of an app (#2718)');
  // …and AT MOST ONE of them is showing. Two glyphs in one 28px disc is what
  // a wrong `hidden` looks like, and it is the only broken state here: the
  // cold document publishes mode 'none', which hides the anchor itself, so
  // none of the three being visible inside it is correct rather than empty.
  // It used to be "exactly one", on a render where the house was drawn for
  // every mode that was not the arrow — which is precisely the bug a third
  // glyph introduces, so each one names its own mode now.
  const shown = ['home', 'arrow', 'close'].filter((name) =>
    !new RegExp(`id="back-icon-${name}"[^>]*class="[^"]*\\bhidden\\b`).test(inner));
  assert.ok(shown.length <= 1,
    `at most one glyph may be visible at a time, and these were: ${shown.join(', ')}`);
  assert.match(html, /<a id="back-btn"[^>]*class="[^"]*\bhidden\b/,
    "…and in the cold document the anchor is hidden outright, which is mode 'none'");
  // 28x28 now, not 20x28: the slot holds the app glyph as well as the arrow
  // (features/header/header-app-icon.tsx), and they never draw together. What
  // matters to the header-layout hook is that the width is FIXED, and it is.
  assert.match(html, /<div class="w-7 h-7 shrink-0 flex items-center justify-center">/,
    'the fixed 28x28 lead-icon wrapper the header-layout hook measures');
});

test('the header click handler guards before it preventDefaults', () => {
  // 1700: the claim chain grew by the Challenges page's line, and the span only
  // has to reach the home fallback at the end of it.
  const body = handlerAfter(appJs, "document.getElementById('back-btn').addEventListener", 1700);
  const guard = body.indexOf('NavLink.isNativeClick(e)');
  const prevent = body.indexOf('e.preventDefault()');
  assert.ok(guard !== -1, 'the modified-click guard went missing');
  assert.ok(guard < prevent, 'the guard must come FIRST, or cmd-click is swallowed');
  // The existing screen-hook chain is unchanged and still ordered — with the
  // dev session's claim (Streamlined Concept) last before the home fallback.
  assert.ok(body.indexOf('AdminConsole?.handleBack') < body.indexOf('Settings?.handleBack'));
  assert.ok(body.indexOf('Settings?.handleBack') < body.indexOf('Browse?.handleBack'));
  // The Challenges tab's detail page is a level of the Leaderboard screen and
  // claims the chevron the same way, after Browse and before a dev session.
  assert.ok(body.indexOf('Browse?.handleBack') < body.indexOf('TopochainChallenges?.handleBack'));
  assert.ok(body.indexOf('TopochainChallenges?.handleBack') < body.indexOf('DevChat?.handleBack'));
  assert.ok(body.indexOf('DevChat?.handleBack') < body.indexOf('App.navigateHome()'));
});

test('setBackIcon owns the anchor href, defaulting to home', () => {
  const at = appJs.indexOf('  setBackIcon(mode, href) {');
  assert.ok(at !== -1, 'setBackIcon must take the href as a second argument');
  const fn = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(fn, /setAttribute\('href'/, 'it writes the target onto the anchor');
  assert.match(fn, /href \|\| \(window\.NavLink \? NavLink\.homeHref\(\) : '\/'\)/,
    'omitting the argument means home — correct for every screen except the '
    + 'three that claim the chevron as "up one level"');
  // The accessible name is a CONSTANT now: the control means one thing, so
  // there is no second name for it to track. It is set on the element rather
  // than here — see features/header/platform-header.tsx.
  assert.ok(!/aria-label', arrow \?/.test(fn),
    'setBackIcon no longer branches the accessible name — the control means '
    + 'one thing, and React renders that name');
});

test('every screen entry refreshes the href through the one choke point', () => {
  const at = appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {');
  assert.ok(at !== -1, '_showOnlyScreen went missing');
  const fn = appJs.slice(at, appJs.indexOf('\n  },', at));
  // A TABLE, READ THROUGH ONE HELPER (#2718 review). The ternary here had
  // grown three answers and still disagreed with the screens that write
  // their own slot a moment later, so the corner depended on which writer
  // ran last. What matters for THIS test is unchanged: every screen change
  // passes through this line, so the href cannot go stale.
  assert.match(fn, /App\.setBackIcon\(\.\.\.App\._backSlotFor\(revealId\)\);/,
    'this is what keeps the href from ever going stale — every screen change '
    + 'passes through here');
  assert.match(appJs, /_backSlotFor\(revealId\) \{[\s\S]{0,400}App\._BACK_SLOT\[revealId\]/,
    'and the answer comes from the table rather than a chain of conditions');
});

test('the three up-one-level screens pass their own target', () => {
  // Browse's detail view is a level INSIDE that screen and draws the arrow.
  // Settings and Admin draw one at level 2 as well — the mobile drill-in,
  // which is likewise a level inside the screen and would strand a phone
  // viewer without it.
  //
  // THE HOUSE IS GONE FROM ALL THREE (#2718 review). It was the answer while
  // these screens hung off Home's account row; the five-tab bar answers "how
  // do I get out of here" now, so a house is either a duplicate of the Home
  // tab or — worse, on Settings and Admin — a jump PAST the Me tab the viewer
  // came through and which is still lit. What is left is the honest pair: an
  // arrow when there is a level above, nothing when there is not.
  assert.match(browseJs, /const upToList = onDetail && Browse\._detailOrigin !== 'home';/,
    'browse names the one state with a list above it…');
  assert.match(browseJs, /const backMode = upToList \? 'arrow' : 'none';/,
    '…and that state alone gets the chevron; the list and a detail opened '
    + 'from a Home card are roots of this screen and show nothing');
  assert.match(browseJs, /setBackIcon\(backMode, upToList \? '#apps' : undefined\)/,
    'the list-bound chevron keeps its explicit parent target');
  assert.match(adminConsoleJs, /setBackIcon\('arrow', inSection \? '#admin' : '#profile'\)/,
    'the admin section chevron pops to the console menu; its root goes up to '
    + 'the Me tab it was opened from');
  // Settings resolves its section target through _upHref (#1565): the menu
  // when the menu is what sits below the entry, and the address the viewer
  // came from when they arrived from elsewhere in the app. Its root goes to
  // the same place Admin's does.
  assert.match(settingsJs, /setBackIcon\('arrow', inSection \? Settings\._upHref\(\) : '#profile'\)/,
    'the settings section chevron points where its back press goes');
  assert.match(settingsJs, /_upHref\(\) \{[\s\S]{0,400}return '#settings';/,
    '…which is still the menu unless something else of ours is below');
});

// ── The converted back controls ────────────────────────────────────────

const ANCHORS = [
  // 'back out of a dev session' is NOT in this list any more, and for the same
  // reason as the three below: the session header strip converted, so the
  // anchor is JSX in frontend/src/features/dev-chat/session-header.tsx and the
  // plain-click path is DevChat.leaveSession(). It gets the same assertions by
  // hand below.
  // 'back out of the app-wide dev chat' is NOT in this list: #1084 chunk G
  // converted that sub-view's frame to React, which splits the control across
  // two files, and every entry here has a single source. It gets the same two
  // assertions by hand below.
  // 'back out of an issue / proposal / governance topic' is NOT in this list
  // any more, for the same reason as the dev general-chat link above: #1191
  // converted the topic sub-view's frame to React
  // (frontend/src/features/dev-board/topic-frame.tsx), which splits the
  // control across two files. It gets the same two assertions by hand below.
  // 'back to the top-users leaderboard' is NOT in this list either, and for
  // the same reason as the dev general-chat link above: #1191 slice 6
  // conversion 6 made the Kudos pane a component, so the anchor is JSX in
  // frontend/src/features/leaderboard/kudos-pane.tsx and there is no
  // addEventListener call for `handler` to find. It gets the same three
  // assertions by hand below.
];

for (const a of ANCHORS) {
  test(`"${a.label}" is a real anchor with a real target`, () => {
    const src = a.src();
    assert.match(src, a.markup, `${a.file}: the control must be an <a>`);
    assert.ok(!a.oldTag.test(src), `${a.file}: the old <button> tag is gone`);
    assert.match(src, a.href, `${a.file}: it must carry a resolvable href`);
  });

  test(`"${a.label}" leaves a modified click to the browser`, () => {
    const body = handlerAfter(a.src(), a.handler, 700);
    const guard = body.indexOf('NavLink.isNativeClick(e)');
    const prevent = body.indexOf('e.preventDefault()');
    assert.ok(guard !== -1, `${a.file}: the modified-click guard went missing`);
    assert.ok(prevent !== -1, `${a.file}: a plain click must still be intercepted`);
    assert.ok(guard < prevent,
      `${a.file}: preventDefault ahead of the guard swallows the new tab`);
  });
}

// The dev general-chat back link (#1084 chunk G) is GONE, and staying gone is
// the contract now:
test('the app-wide dev chat carries no back control any more', () => {
  // Streamlined Concept: the general chat is the ACTIVITY screen — a
  // first-class destination with its own hash, named by the header's title
  // tab and left through the eye button or the app-context sheet. A back
  // bar over it would be a second navigation system.
  assert.ok(!/dev-chat-back/.test(chatFrameTsx),
    'chat-frame.tsx: the back anchor is retired');
});

// The dev session's back control is the PLATFORM HEADER's #back-btn now
// (Streamlined Concept): renderDevView's session branch calls
// App.setBackIcon('arrow', '/app/<slug>/board'), so the anchor and its
// modified-click guard are app.js's — the same real-anchor contract the
// loop above pins for every other control. The in-strip #dc-back retired.
test('"back out of a dev session" rides the header back anchor, with a real target', () => {
  assert.ok(!/dc-back/.test(sessionHeaderTsx),
    'session-header.tsx: the in-strip back control stays retired');
  // #2770: a change is an agent conversation, so the anchor hangs off
  // Messages rather than off the Board.
  assert.match(appViewJs,
    /if \(subTab === 'sessions' && ref\) \{[\s\S]{0,900}?setBackIcon\?\.\('arrow', '#messages'\)/,
    'app-view.js points the header anchor at Messages on the way into a session');
  // The header listener's guard runs before preventDefault (pinned in
  // app.js for every screen the anchor serves), and the plain click walks
  // the handleBack chain into dev-chat.js's.
  assert.match(appJs, /window\.DevChat\?\.handleBack\?\.\(\)/,
    'app.js consults DevChat before the navigate-home fallback');
  assert.match(devChatJs, /handleBack\(\) \{[\s\S]{0,300}?leaveSession\(\)/,
    'a session claims the click');
  // And the work the plain click does is still dev-chat.js's.
  assert.match(devChatJs, /leaveSession\(\) \{[\s\S]{0,2400}?location\.hash = '#messages'/);
});

// The topic page's back bar is retired, and it stays retired. It was a
// full-width bar with a hairline whose entire content was `← Back`, sitting
// directly under a platform header that carried a chevron to the same Board on
// this very route. Two back controls one row apart, and the page opened with a
// strip of chrome instead of the proposal you came to read.
//
// #2916 MOVED THE ONE THAT WAS LEFT. The header's chevron was asked to sit
// "inside" the Workshop pane, and it does: the "‹ Workshop" chip at the top of
// the topic head, with the header drawing NO back control on these routes. The
// rule this block has always enforced is unchanged: one back control per page,
// and a pinned bar above the thread is not coming back to be the second.
test('"back out of an issue / proposal / governance topic" is the in-pane Workshop chip (#2916)', () => {
  assert.ok(!/dev-topic-back/.test(topicFrameTsx),
    'topic-frame.tsx: the pinned back bar is retired, and the chip is not the '
    + "frame's either: it scrolls with the card, so it lives in the topic head");
  // Code only: the file's header explains what was removed and names both
  // props while doing it, which is prose worth keeping.
  const topicCode = topicFrameTsx.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/backHref|onBackClick/.test(topicCode),
    'and the two props that existed only for it went with it — a prop left '
    + 'behind is the bar growing back with nothing to stop it');
  assert.match(appViewJs, /mountTopicSubView\(content\);/,
    'app-view.js hands the host over and nothing else, exactly as the general '
    + 'chat mount already did');

  // THE CHIP: a real anchor with a real target, guarded before it
  // preventDefaults, exactly what #1036 bought the header's chevron.
  assert.match(topicBackTsx, /<a\n\s+className="dev-topic-back un-touch-target"\n\s+href=\{href\}/,
    'topic-back.tsx: the control is an <a> with an href');
  assert.ok(!/target=/.test(topicBackTsx.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and no target=_blank, which the native WebView would push out to the system browser');
  const click = topicBackTsx.slice(topicBackTsx.indexOf('function onBackClick('));
  const guard = click.indexOf('isNativeClick?.(event)');
  const prevent = click.indexOf('event.preventDefault()');
  assert.ok(guard !== -1 && prevent !== -1, 'the modified-click guard and the plain-click claim');
  assert.ok(guard < prevent, 'the guard must come FIRST, or cmd-click is swallowed');
  assert.match(click, /window\.location\.hash = href;/,
    'a plain click follows the href, as the header listener did on this route');
  // Its destination is the one the header's chevron carried: `boardHref`,
  // never a literal `/board`, because Workshop and Board are one screen in
  // two layouts and back has to name the one the reader came from.
  assert.match(improveStoreJs,
    /export function topicBackHref\(\{ slug, tab, subTab, boardView, topicOrigin = null \}\) \{\n\s+if \(!\(slug && tab === 'dev' && subTab === 'topic'\)\) return null;\n\s+return topicOrigin \|\| boardHref\(slug, boardView\);/,
    'the chip resolves a topic route to its board through boardHref, unless a '
    + 'Messages card recorded the conversation it was opened from (#3103)');
  assert.match(topicBackTsx, /const href = topicBackHref\(\{ slug, tab, subTab, boardView, topicOrigin \}\);\n\s+if \(!href\) return null;/,
    'and renders only when that answer exists');
  // First in `.dev-topic`, so it sits above the hero or the card and scrolls
  // with them, on every kind of topic (TopicHead is the head of all of them).
  assert.match(topicHeadTsx, /<div ref=\{root\} className="dev-topic"[^>]*>\n\s+\{back \? <TopicBack \/> : null\}/,
    'topic-head.tsx: the chip is the first child of .dev-topic');
  assert.match(topicHeadTsx, /conversation=\{conversation\} back \/>;/,
    'and TopicHead, the topic page, is what asks for it');
});

test('a topic page has exactly one back control: the chip, and no header arrow (#2916)', () => {
  // The header reads the SAME function the chip renders from and forces its
  // slot to 'none' on that answer, so "chip shown" and "arrow hidden" are one
  // fact. Two call sites agreeing by convention is how a page grows zero or
  // two back controls; this is agreement by construction.
  assert.match(headerTsx, /const paneBack = topicBackHref\(\{/,
    'platform-header.tsx derives the topic from topicBackHref');
  assert.match(headerTsx, /const mode = backMode === 'close' \? 'close'\n\s+: paneBack \? 'none'/,
    "and draws no back control where the chip is the page's back");
  // …and no longer maps a topic to the board itself: that answer is the chip's.
  assert.doesNotMatch(headerTsx, /subTab === 'topic'\) return boardHref/,
    "the header's ladder no longer sends a topic anywhere");
  // Dev SESSIONS are Messages threads, not topics (#2770): they keep the
  // header arrow and never get the chip.
  assert.match(headerTsx, /subTab === 'sessions'\) return sessionOrigin \|\| '#messages';/,
    'a dev session still climbs by the header arrow');
});

test('no other in-page back control is left anywhere in the Dev area', () => {
  // The three retired one at a time and each left the others in place, so the
  // count is the assertion: a surface growing its own is the shape of this
  // regression, not any single id coming back. The topic chip (#2916) is the
  // one in-page back the Dev area has, it lives in topic/topic-back.tsx, and
  // it replaced the header's arrow on those routes rather than joining it.
  for (const [name, src] of [['chat-frame.tsx', chatFrameTsx],
    ['topic-frame.tsx', topicFrameTsx], ['session-header.tsx', sessionHeaderTsx]]) {
    assert.ok(!/id="d(c|ev)-[a-z-]*back"/.test(src),
      `${name} must carry no in-page back control — the header, or on a topic the chip, has it`);
    assert.ok(!/dev-topic-back/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      `${name} must not render the topic chip — it belongs to the topic head alone`);
  }
});

test('the app-wide dev chat mounts without back-bar props', () => {
  // Activity has no in-frame back control (see the retirement test above),
  // so the mount takes no backHref/onBackClick — a prop that came back here
  // would be the second navigation system creeping in.
  assert.match(appViewJs, /mountChatSubView\(content\);/,
    'app-view.js hands the host over and nothing else');
});

test('the dev sub-views resolve their target through one helper', () => {
  const at = appViewJs.indexOf('  _devPageHref() {');
  assert.ok(at !== -1, 'AppView._devPageHref went missing');
  const fn = appViewJs.slice(at, appViewJs.indexOf('\n  },', at));
  assert.match(fn, /AppView\.appData && AppView\.appData\.slug\) \|\| App\.currentApp/,
    'either source of the open app\'s slug is acceptable');
  assert.match(fn, /return slug \? App\._appUrl\(slug, 'dev', null, 'forum'\) : ''/,
    'no slug means an EMPTY href, never "/app/undefined/board"');
});

// The Kudos pane's profile back link, JSX in kudos-pane.tsx since #1191 slice
// 6 conversion 6. Same three properties the ANCHORS loop asserts, written out
// because the control is a component now — plus the margin trap, which is the
// reason this control was singled out in the first place.
test('"back to the top-users leaderboard" is a real anchor with a real target', () => {
  const at = kudosPaneTsx.indexOf('data-lb-back=""');
  assert.ok(at !== -1, 'kudos-pane.tsx: [data-lb-back] went missing');
  const tag = kudosPaneTsx.slice(kudosPaneTsx.lastIndexOf('<', at), at + 400);
  assert.match(tag, /^<a\b/, 'kudos-pane.tsx: the control must be an <a>');
  assert.match(tag, /href="#leaderboard\/users"/, 'it must carry a resolvable href');
  assert.ok(!/<button[^>]*data-lb-back/.test(kudosPaneTsx + leaderboardJs),
    'the old <button> tag is gone from both halves');
});

test('"back to the top-users leaderboard" leaves a modified click to the browser', () => {
  const at = kudosPaneTsx.indexOf('data-lb-back=""');
  const body = kudosPaneTsx.slice(at, at + 900);
  // Same one-hop-further-in guard as browse-detail.tsx: `e` is React's
  // SyntheticEvent, so NavLink reads the native event out of it.
  const guard = body.indexOf('isNativeClick(e.nativeEvent)');
  const prevent = body.indexOf('e.preventDefault()');
  assert.ok(guard !== -1, 'kudos-pane.tsx: the modified-click guard went missing');
  assert.ok(prevent !== -1, 'kudos-pane.tsx: a plain click must still be intercepted');
  assert.ok(guard < prevent,
    'kudos-pane.tsx: preventDefault ahead of the guard swallows the new tab');
});

test('[data-lb-back] keeps its bottom margin as an anchor', () => {
  const at = kudosPaneTsx.indexOf('data-lb-back=""');
  const tag = kudosPaneTsx.slice(kudosPaneTsx.lastIndexOf('<', at), at + 400);
  assert.match(tag, /\bmb-3\b/, 'the spacing the button had');
  assert.match(tag, /\binline-block\b/,
    'an <a> is `inline`, and margin-bottom does nothing on an inline box — '
    + 'without this the button-to-anchor swap silently collapses the gap');
});

// The browse detail page's back link, JSX in browse-detail.tsx since #1191
// slice 6. Same three properties the ANCHORS loop asserts for every other
// control — a real <a>, a resolvable target, and a guard that runs before
// preventDefault — written out because the control is a component now.
test('"back to all apps" is a real anchor with a real target', () => {
  const at = browseDetailTsx.indexOf('id="browse-detail-back"');
  assert.ok(at !== -1, 'browse-detail.tsx: #browse-detail-back went missing');
  const tag = browseDetailTsx.slice(browseDetailTsx.lastIndexOf('<', at), at + 400);
  assert.match(tag, /^<a\b/, 'browse-detail.tsx: the control must be an <a>');
  assert.match(tag, /href="#apps"/, 'it must carry a resolvable href');
  assert.ok(!/<button[^>]*id="browse-detail-back"/.test(browseDetailTsx + browseJs),
    'the old <button> tag is gone from both halves');
});

test('"back to all apps" leaves a modified click to the browser', () => {
  const at = browseDetailTsx.indexOf('id="browse-detail-back"');
  const body = browseDetailTsx.slice(at, at + 700);
  // `e` is React's SyntheticEvent here, so the guard reads the native one out
  // of it — the same NavLink call, one hop further in.
  const guard = body.indexOf('isNativeClick(e.nativeEvent)');
  const prevent = body.indexOf('e.preventDefault()');
  assert.ok(guard !== -1, 'browse-detail.tsx: the modified-click guard went missing');
  assert.ok(prevent !== -1, 'browse-detail.tsx: a plain click must still be intercepted');
  assert.ok(guard < prevent,
    'browse-detail.tsx: preventDefault ahead of the guard swallows the new tab');
});

test('#browse-detail-back keeps its own layout as an anchor', () => {
  const at = browseDetailTsx.indexOf('id="browse-detail-back"');
  const tag = browseDetailTsx.slice(at, at + 400);
  assert.match(tag, /\binline-block\b/, 'same inline-vs-inline-block trap');
});

// ── The rows that stay buttons / divs ──────────────────────────────────

// The App/Dev switch used to be tested here as the one control that had to
// use NavLink mechanism B (hand interception) rather than a plain href: an
// <a> cannot carry role="radio" inside a role="radiogroup". THE UI OVERHAUL
// retired the switch, so the exception is gone with it — every navigating
// control in the shell is an anchor or goes through App's router now.
//
// #app-menu-row-improve is deliberately NOT a new exception — nor was
// #improve-btn, the header pill it replaced when #2718 retired that. It opens
// a panel rather than navigating, so there is no destination for a cmd-click
// to open; the panel's own rows are where navigation happens, and those ARE
// anchors (see features/improve/session-row.tsx). Same for
// #app-menu-row-about, a button for the same reason: the pane it opens is the
// sheet in another state, not an address.
test('the retired App/Dev switch left no interception behind', () => {
  assert.equal(appJs.indexOf(".querySelectorAll('.app-mode-seg')"), -1,
    'the switch wiring is gone from app.js');
  assert.equal(html.indexOf('id="app-mode-switch"'), -1,
    'the switch markup is gone from the shell');
  assert.doesNotMatch(html, /class="[^"]*app-mode-seg/,
    'no orphan segment survived the retirement');
});

const ROWS = [
  {
    label: 'home app cards',
    src: () => homeJs, file: 'home.js',
    anchor: ".querySelectorAll('.app-card')",
    wire: /NavLink\.wireModified\(card, hrefFor, activate\)/,
    // #1562: a Discover tap opens the app's detail page, not the app. The
    // modified-click contract is unchanged — it just names a different route.
    href: /detailHref\(card\.dataset\.slug\)/,
    guards: ['card-add-btn', 'card-menu-btn', "card.dataset.demo === 'true'", 'awaiting_secrets'],
  },
  // The dev chat's cross-app "Active Sessions" rows were the second entry
  // here. They are gone (#1367): `#dc-active-list` and `#dc-active-counter`
  // exist in no markup, so `renderActiveSessions` resolved nothing and
  // returned on its first line, and the 5s poll that drove it had no caller
  // left. A modifier-click contract for rows nobody can see is not a
  // contract — the assertion below replaces it, so the wiring cannot come
  // back without the surface.
];

test('the retired cross-app session rows leave no half of themselves behind', () => {
  assert.ok(!/dc-active-item/.test(devChatJs), 'no rows');
  assert.ok(!/dc-active-list|dc-active-counter/.test(devChatJs.replace(/\/\/[^\n]*/g, '')),
    'and no lookups for the hosts they needed');
});

for (const r of ROWS) {
  test(`${r.label} open in a new tab under a modifier`, () => {
    const at = r.src().indexOf(r.anchor);
    assert.ok(at !== -1, `${r.file}: ${r.anchor} went missing`);
    // A window, not a parse: wide enough to hold the wiring block plus the
    // comment above it. Raised from 1600 when #1562 gave the Discover card a
    // named destination helper and two more lines of guard.
    const body = r.src().slice(at, at + 2400);
    assert.match(body, r.wire, `${r.file}: must route through NavLink.wireModified`);
    assert.match(body, r.href, `${r.file}: the new tab must open the row's own route`);
    // hrefFor has to repeat the plain click's guards, or a modified click
    // would drill into a row the plain click treats as inert.
    const hrefFor = body.slice(body.indexOf('const hrefFor'), body.indexOf('const activate'));
    for (const g of r.guards) {
      assert.ok(hrefFor.includes(g),
        `${r.file}: hrefFor must repeat the "${g}" guard — otherwise cmd-click `
        + 'drills into a row a plain click refuses');
    }
    assert.ok(hrefFor.includes('return null'),
      `${r.file}: a guarded-out row must resolve to no href, i.e. stay inert`);
  });
}

// The browse list rows, split across the same two files as the back link: the
// wiring is an effect in browse-list.tsx (the row is a component now, so there
// is no querySelectorAll pass to hang it off), and the route plus the inert-row
// guards are Browse.rowHref.
test('browse list rows open in a new tab under a modifier', () => {
  const at = browseListTsx.indexOf('const nav = (window as any).NavLink;');
  assert.ok(at !== -1, 'browse-list.tsx: the NavLink wiring went missing');
  const body = browseListTsx.slice(at, at + 1200);
  assert.match(body, /nav\.wireModified\(node, hrefFor, activate\)/,
    'browse-list.tsx: must route through NavLink.wireModified');
  const hrefFor = body.slice(body.indexOf('const hrefFor'), body.indexOf('const activate'));
  assert.ok(hrefFor.includes('browse-add-btn'),
    'browse-list.tsx: hrefFor must repeat the Add-button guard — otherwise '
    + 'cmd-click drills into a row a plain click refuses');
  assert.ok(hrefFor.includes('return null'),
    'browse-list.tsx: a guarded-out row must resolve to no href, i.e. stay inert');
  // The row's own route and its demo guard are the controller's, and hrefFor
  // and the plain click reach them through the SAME method, so they cannot
  // disagree the way two copies of the guard could.
  assert.match(hrefFor, /rowHref\(view\)/);
  const rowHref = browseJs.slice(browseJs.indexOf('rowHref(view) {'),
    browseJs.indexOf('openRow(view) {'));
  assert.match(rowHref, /#apps\/\$\{encodeURIComponent\(view\.slug\)\}/,
    'the new tab must open the row\'s own route');
  assert.match(rowHref, /view\.demo/, 'a staging demo row has no page to open');
  assert.match(rowHref, /return null/);
  assert.match(browseJs, /openRow\(view\) \{\s*\n\s*const href = Browse\.rowHref\(view\);/,
    'the plain click resolves through the same guard');
});


// The drawer is retired. The rule it pinned — a modified click belongs to the
// browser and is never intercepted — is asserted shell-wide by the tests
// above, which cover every surviving anchor including Home's account row.

// ── The declared checks ────────────────────────────────────────────────

test('dapp.json pins the anchors that a capture can actually see', () => {
  // A headless capture cannot synthesise a ⌘-click, so the checks assert
  // the anchors exist with the right target — which IS the contract.
  const checks = (dapp.tests || []).filter(
    (t) => typeof t.name === 'string' && t.name.includes('#1036')
  );
  assert.ok(checks.length >= 2,
    'without checks a button-to-anchor regression ships silently');

  const bySelector = (frag) => checks.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes(frag)
  );

  // The session's back control is the header's own anchor now (Streamlined
  // Concept — #dc-back retired), so its check pins a#back-btn. #2770 moved
  // its address: a change is an agent conversation, a thread of Messages, so
  // a cold session link goes up to #messages rather than to the Workshop.
  const session = (dapp.tests || []).find(
    (t) => typeof t.expectSelector === 'string'
      && /a#back-btn[^"]*\[href="#messages"\]/.test(t.expectSelector)
  );
  assert.ok(session, 'the session back anchor needs its own check');
  assert.match(session.path, /dev\/sessions\/\d+/, 'it must land on a session');

  const home = bySelector('a#back-btn');
  assert.ok(home, 'the header home control needs a check');
  assert.match(home.expectSelector, /a#back-btn/,
    'a <button id="back-btn"> must fail this selector');

  const upLevel = checks.find(
    (t) => typeof t.expectSelector === 'string'
      && t.expectSelector.includes('a#back-btn[href="#apps"]')
  );
  assert.ok(upLevel, 'the setBackIcon(mode, href) plumbing needs its own regression check');
  // The self-app is hash-routed, so its declared paths carry the fragment.
  assert.match(upLevel.path, /^\/#apps\/[^/]+$/, 'it has to be on an app detail page');

  // Ungated, ordinary routes: an env-gated path starves the production
  // "before" shot forever (same rule as tests/drawer-nav-motion.test.js).
  for (const t of checks) {
    assert.ok(!/IS_STAGING|USERNODE_ENV/.test(t.path),
      `${t.name}: the path must not be env-gated`);
  }
});

test('the declared checks survive the manifest reader', () => {
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(dapp);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests.filter((t) => /#1036/.test(t.name || ''));
  assert.ok(kept.length >= 2,
    'a malformed entry is silently dropped, which gates nothing');
});
