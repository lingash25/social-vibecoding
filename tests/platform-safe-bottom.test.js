// "Use the bottom strip of the screen everywhere in the platform".
//
// The shell handled the ~34px strip above an iPhone's home indicator three
// different ways, none of them right:
//
//   - #app-view reserved it as OUTER padding for every platform surface
//     (Dev mode), so each surface was shrunk by the inset and the strip
//     below it was dead background — the dev-chat composer floated above
//     an empty band and the message list lost that height;
//   - the top-level screens (Settings, Admin, Profile, Browse,
//     Leaderboard, the auth screens) reserved nothing at all, so their
//     last row scrolled UNDER the indicator;
//   - the full-screen spec viewer is `position: fixed; inset: 0`, so it
//     escaped #app-view and put its footer under the indicator and its
//     header under the notch.
//
// One rule replaces all three: surfaces paint edge to edge, and the inset
// moves INWARD to the innermost thing that must clear the indicator —
// each scroller's content padding (.platform-safe-scroll) or each pinned
// bar's own padding (.platform-safe-bar), both resolving through the
// --platform-safe-bottom token.
//
// This file pins the inward half. tests/app-safe-area.test.js pins the
// other side of the same contract: #app-view reserves nothing on either
// surface, and the real insets are forwarded INTO app frames (#970) so a
// running app still reaches the screen's rounded bottom edge.
//
// Run with: node --test tests/platform-safe-bottom.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { shellMarkup } = require('./lib/shell-markup');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const APP_CSS = read('public/css/app.css');
const INDEX = read('public/index.html');
const APP_JS = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const BOARD_FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
const DEV_VIEW = read('frontend/src/features/dev-chat/view.tsx');
const GROUP_CHAT = read('public/js/group-chat.js');

// ── 1. The tokens ────────────────────────────────────────────────────

test('app.css defines both safe-area tokens exactly once, in the kit form', () => {
  for (const edge of ['bottom', 'top']) {
    const defs = APP_CSS.match(new RegExp(`--platform-safe-${edge}:`, 'g')) || [];
    // bottom is defined twice on purpose: :root plus the app-surface
    // ZERO override. Count the :root-shaped definition specifically.
    const real = APP_CSS.match(
      new RegExp(
        `--platform-safe-${edge}: var\\(--un-safe-inset-${edge}, env\\(safe-area-inset-${edge}, 0px\\)\\)`,
        'g'
      )
    ) || [];
    assert.ok(defs.length >= 1, `--platform-safe-${edge} must be defined`);
    assert.ok(real.length >= 1,
      `--platform-safe-${edge} must be written `
      + `var(--un-safe-inset-${edge}, env(safe-area-inset-${edge}, 0px)) — the kit's `
      + 'convention, and what lets ?shot=safe-bottom drive the whole shell');
  }
});

test('the token is defined on :root so screens OUTSIDE #app-view get it', () => {
  // Settings / Admin / Profile / Browse / Leaderboard / the auth screens
  // are siblings of #app-view, not children — a token scoped only to the
  // surface rules would leave every one of them at 0.
  const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(APP_CSS);
  assert.ok(rootBlock, 'app.css must open with a :root block');
  assert.match(rootBlock[1], /--platform-safe-bottom:/,
    '--platform-safe-bottom belongs on :root');
  assert.match(rootBlock[1], /--platform-safe-top:/,
    '--platform-safe-top belongs on :root');
});

// ── 2. The utilities ─────────────────────────────────────────────────

// ── What #2718 changed in these two, and what it did not ────────────
//
// The tab bar is `position: fixed` at the bottom of the screen, so a surface
// that used to end at the viewport's edge now ends at the bar's top edge on
// every route the bar is up. Both utilities therefore clear
// `max(--platform-tabs-h, --platform-safe-bottom)` rather than the inset
// alone.
//
// `max()` AND NOT A SUM, which is the whole of why this is still one
// assertion and not two: the bar is fused to the bottom edge and spends the
// home-indicator inset itself, as its own lower padding, so
// `--platform-tabs-h` is the bar's FULL outer height. Adding the inset on top
// would reserve the strip twice — the #4149 bug, which `--ws-bar`'s comment
// in app.css documents from the other side. Taking the larger of the two
// reserves each exactly once, in both states.
//
// EVERYTHING THESE TESTS ORIGINALLY PINNED STILL HOLDS, and is still
// asserted: the inset is named through the token and never a second `env()`,
// `!important` survives (app.css loses the cascade to tailwind.css without
// it), and the composer keeps its own 0.5rem base gap rather than having it
// replaced. With no tab bar on screen `--platform-tabs-h` is 0px and both
// declarations compute to exactly what they were.

const CLEARANCE = /max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom\)\)/;

test('.platform-safe-scroll pads a scroller by the bottom inset', () => {
  const m = /\.platform-safe-scroll\s*\{([\s\S]*?)\}/.exec(APP_CSS);
  assert.ok(m, 'app.css must define .platform-safe-scroll');
  assert.match(m[1], new RegExp(`padding-bottom:\\s*${CLEARANCE.source}\\s*!important`),
    'block-end padding on a scroller is part of its scrollable overflow — '
    + 'that is what makes the last row reachable while the background still '
    + 'paints through the strip');
});

test('.platform-safe-bar adds the inset to a bar\'s own p-2 gap', () => {
  const m = /\.platform-safe-bar\s*\{([\s\S]*?)\}/.exec(APP_CSS);
  assert.ok(m, 'app.css must define .platform-safe-bar');
  assert.match(m[1], new RegExp(`padding-bottom:\\s*calc\\(0\\.5rem \\+ ${CLEARANCE.source}\\)\\s*!important`),
    'the composer keeps its 8px base gap and the clearance is added BELOW it — '
    + "unlike the kit's .un-safe-bottom, which would replace the gap");
});

test('both utilities carry !important — app.css loses the cascade otherwise', () => {
  // /css/tailwind.css is linked AFTER /css/app.css, so a plain class here
  // ties with `p-2` / `p-4` on the same element and loses on source
  // order. The kit's own .un-safe-* helpers use !important for exactly
  // this reason. Assert the load order too, so a reorder can't silently
  // un-style every composer.
  const appIdx = INDEX.indexOf('/css/app.css');
  const twIdx = INDEX.indexOf('/css/tailwind.css');
  assert.ok(appIdx > -1 && twIdx > -1, 'both stylesheets must be linked');
  assert.ok(appIdx < twIdx,
    'app.css must precede tailwind.css — the !important on the safe-area '
    + 'utilities is what survives that order');

  for (const cls of ['.platform-safe-scroll', '.platform-safe-bar']) {
    const m = new RegExp(`\\${cls}\\s*\\{([^}]*)\\}`).exec(APP_CSS);
    assert.match(m[1], /!important/, `${cls} needs !important to beat Tailwind's p-*`);
  }
});

test('keyboard-up suppresses the inset on both utilities', () => {
  // The home-indicator strip sits BEHIND the on-screen keyboard, so
  // reserving it there is dead space above the keyboard. Same suppression
  // the kit applies to its own surfaces (html.un-kb .un-panel-body etc).
  const scroll = /html\.un-kb \.platform-safe-scroll\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(scroll, 'html.un-kb .platform-safe-scroll rule is missing');
  assert.match(scroll[1], /padding-bottom:\s*0\s*!important/);

  const bar = /html\.un-kb \.platform-safe-bar\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(bar, 'html.un-kb .platform-safe-bar rule is missing');
  assert.match(bar[1], /padding-bottom:\s*0\.5rem\s*!important/,
    'the bar keeps its base gap with the keyboard up, just not the inset');
});

test('every composer column reserves the keyboard inset, exactly once', () => {
  // #1937/#1491. Four screens are built the same way: a flex column with a
  // flex-1 scroller and the typing slot + composer pinned BELOW it as
  // shrink-0 siblings, OUTSIDE the scroller. The kit cannot help there —
  // `attachKeyboardAvoidance` gates on `scrollEl.contains(field)` and
  // `.un-kb-avoid` pads the inside of a scroller — so the composer sat behind
  // the keyboard on all four, and on iOS the settled pin also reset Safari's
  // reveal-pan once per keypress. Reserving on the column is what native does
  // (iOS and Android Messages both shrink the content area rather than cover
  // or pan it), and it leaves the pin inert.
  const col = /html\.un-kb \.platform-kb-column\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(col, 'html.un-kb .platform-kb-column rule is missing');
  assert.match(col[1], /padding-bottom:\s*var\(--un-kb-inset, 0px\)/,
    'the column must reserve the kit-published keyboard inset');
  assert.match(col[1], /transition:\s*none/,
    'no transition while the keyboard is up — the bar tracks it exactly');

  const COLUMNS = [
    ['frontend/src/features/group-chat/thread-shell.tsx', /className="dev-thread dev-thread-fill platform-kb-column/],
    ['frontend/src/features/group-chat/general-chat.tsx', /className="gc-chat-pane platform-kb-column/],
    ['frontend/src/features/dev-chat/view.tsx', /className="dc-chat-pane platform-kb-column/],
    ['frontend/src/features/messages/index.tsx', /messages-thread-pane platform-kb-column/],
  ];
  for (const [file, re] of COLUMNS) {
    assert.match(read(file), re, `${file} must reserve the keyboard inset on its column`);
  }

  // EXACTLY once: a column that reserves the inset must not also hang
  // `un-kb-avoid` on its scroller, which would pad the inside of it on top.
  // Scoped to rendered class strings — these files DISCUSS `.un-kb-avoid` in
  // their comments, which is not the same as wearing it.
  for (const [file] of COLUMNS) {
    const worn = read(file).match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) || [];
    const twice = worn.filter((c) => c.includes('un-kb-avoid'));
    assert.deepEqual(twice, [],
      `${file} must not reserve the inset twice (column + un-kb-avoid)`);
  }

  // …and the source check above is NOT sufficient on its own, which is what
  // shipped broken. `attachKeyboardAvoidance` ADDS `un-kb-avoid` to whatever
  // scroller `attachScreenFx` hands it, so on the general chat, the topic
  // thread and the dev chat the class is present at runtime no matter what the
  // source says. The inset was counted twice, and a scroll container cannot
  // shrink below its own padding — #gc-messages floored at 368px and held the
  // composer 197px below the keyboard line. Only CSS can neutralise a class
  // added by the kit at runtime, so the rule below is the real guarantee.
  const inner = /html\.un-kb \.platform-kb-column \.un-kb-avoid\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(inner, 'html.un-kb .platform-kb-column .un-kb-avoid rule is missing');
  assert.match(inner[1], /padding-bottom:\s*0/,
    'a scroller inside a reserving column must not reserve the inset again');

  // The boxed thread layout is not screen-bottom-anchored, so reserving
  // keyboard space there would be dead space in the middle of a page.
  const shell = read('frontend/src/features/group-chat/thread-shell.tsx');
  const boxedRoot = /className="dev-thread border[^"]*"/.exec(shell);
  assert.ok(boxedRoot, 'the boxed root should still be plain dev-thread');
  assert.ok(!boxedRoot[0].includes('platform-kb-column'),
    'only screen-bottom-anchored columns reserve the keyboard inset');
});

// ── 3. Every screen scroller opts in ─────────────────────────────────

// The top-level screens and the fixed auth overlays. A new screen that
// forgets the class fails here rather than shipping a row under the
// home indicator.
const SAFE_SCROLL_IDS = [
  'browse-screen',
  'leaderboard-screen',
  'profile-screen',
  'admin-screen',
  'settings-screen',
  'auth-landing-scroll',
  'auth-login-screen',
  'auth-register-screen',
  'auth-waiting-screen',
  'auth-waitlist-screen',
  'auth-more-screen',
];

test('every top-level screen scroller carries platform-safe-scroll', () => {
  for (const id of SAFE_SCROLL_IDS) {
    // #auth-landing-scroll is inside the landing screen's interior, which
    // mounts on first reveal — so resolve against the markup the shell renders.
    const m = new RegExp(`<(?:main|div) id="${id}"[^>]*>`).exec(shellMarkup());
    assert.ok(m, `#${id} is missing from the shell`);
    assert.match(m[0], /platform-safe-scroll/,
      `#${id} must reserve the home-indicator strip for its last row`);
  }
});

test('Messages insets both of its independent scrollers and its composer', () => {
  const source = read('frontend/src/features/messages/index.tsx');
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(source, /className="messages-list-scroll platform-safe-scroll"/,
    'the conversation list must clear the home indicator');
  assert.match(source, /className="messages-thread-scroll platform-safe-scroll chat-transcript"/,
    'the message history must clear the home indicator');
  // #1491: `un-kb-avoid` was REMOVED here on purpose. The column carries the
  // keyboard reservation now, and the kit's class would pad the inside of
  // this scroller on top of it — the inset twice, as dead space.
  assert.ok(!/messages-thread-scroll[^"]*un-kb-avoid/.test(source),
    'the Messages scroller must not reserve the inset a second time');
  // 1 November 2026: the bar is the chat foot's, which names the class.
  assert.match(composer, /<ChatComposerBar className=\{`messages-composer \$\{inThread/,
    'the pinned Messages composer must carry the inset itself');
  assert.match(read('frontend/@/components/ui/chat.tsx'), /className=\{cn\(className, 'chat-composer-bar platform-safe-bar'\)\}/);
});

test('the Messages history reserves no band above a composer that clears the bar', () => {
  // iPhone app, 19 October 2026: `.platform-safe-scroll` on the history kept
  // the tab bar's full height empty between the newest message and the
  // composer, which reserves it again below itself. Where a composer follows
  // the history in its pane the band goes; where none does (an invitation)
  // the history reaches the foot of the screen and keeps it.
  // 1 November 2026: the rule is the chat foot's, `.chat-transcript`, which
  // every chat's scroller wears; the second selector is the same rule at
  // (0,3,0) for the scrollers that also carry `.platform-safe-scroll`.
  const rule = /\.chat-transcript:has\(~ \.platform-safe-bar\),\n\.chat-transcript\.platform-safe-scroll:has\(~ \.platform-safe-bar\) \{([^}]*)\}/.exec(APP_CSS);
  assert.ok(rule, 'the history-above-a-composer rule is missing');
  assert.doesNotMatch(APP_CSS, /\.messages-thread-scroll\.platform-safe-scroll:has\(/, 'one rule, not a Messages copy beside it');
  // 12px is the transcript's own end, not the bar's band (1 November 2026:
  // the air under the newest message moved inside the scroller, see
  // tests/transcript-meets-composer.test.js).
  assert.match(rule[1], /padding-bottom:\s*12px !important/,
    'it must beat `.platform-safe-scroll`, which is !important itself');
  const composer = read('frontend/src/features/messages/composer.tsx');
  // Every composer the history can have below it is a `.platform-safe-bar`:
  // the two bars through ChatComposerBar, which adds the class, and the
  // notice that stands in for a bar, which names it itself.
  for (const root of ['<ChatComposerBar className="messages-composer messages-composer-awaiting"', 'messages-composer-disabled platform-safe-bar', '<ChatComposerBar className={`messages-composer ']) {
    assert.ok(composer.includes(root), root);
  }
  // And it is the pane's next element after the history, in both panes.
  const source = read('frontend/src/features/messages/index.tsx');
  for (const scroller of ['className="messages-thread-scroll platform-safe-scroll chat-transcript"', 'className="messages-thread-scroll messages-reply-scroll platform-safe-scroll chat-transcript"']) {
    const at = source.indexOf(scroller);
    assert.ok(at > 0, scroller);
    const ends = ['</section>', '</aside>'].map((tag) => source.indexOf(tag, at)).filter((i) => i > 0);
    assert.ok(source.slice(at, Math.min(...ends)).includes('<MessageComposer'), `${scroller} has its composer after it in the same pane`);
  }
});

test('#home-screen reads the token instead of a second env() of its own', () => {
  // Home already got this right via .home-body-fill; it just had its own
  // bare env(). One source of truth.
  const m = /\.home-body-fill\s*\{([\s\S]*?)\}/.exec(APP_CSS);
  assert.ok(m, '.home-body-fill is missing');
  assert.match(m[1], CLEARANCE,
    '.home-body-fill must resolve through the token');
  // #home-screen is the one screen root with no `.platform-safe-scroll`, so
  // this is also where it clears the tab bar — and it matters more here than
  // anywhere else, because Home's trailing sections are BOTTOM-ANCHORED to
  // this box: under-reserving parks Create and Challenges behind the bar
  // rather than merely cropping a last card.
  assert.match(m[1], /--platform-tabs-h/,
    '.home-body-fill must clear #platform-tabs too — nothing else on Home does');
});

test('no bare env(safe-area-inset-bottom) survives in app.css', () => {
  // Exactly two places may name it: the :root token and the
  // platform-surface restatement — both as the var() fallback. Anything
  // else is a second source of truth that will drift.
  const lines = APP_CSS.split('\n');
  const bare = [];
  lines.forEach((line, i) => {
    const re = /env\(safe-area-inset-bottom/g;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index);
      if (!/var\(--un-safe-inset-bottom,\s*$/.test(before)) {
        bare.push(`${i + 1}: ${line.trim()}`);
      }
    }
  });
  assert.deepEqual(bare, [],
    'every bottom inset in app.css must resolve through '
    + '--platform-safe-bottom:\n' + bare.join('\n'));
});

// ── 4. Dev-mode surfaces inside #app-view ────────────────────────────

test('the dev scrollers carry platform-safe-scroll', () => {
  // #1084 chunk G: the Dev card list's frame is React
  // (frontend/src/features/dev-board/board-frame.tsx), so the scroller's
  // classes are a JSX className rather than an attribute in a template string.
  const forum = /id="dev-forum-scroll"[\s\S]{0,240}?\/>|<div\s+id="dev-forum-scroll"[\s\S]{0,240}?>/
    .exec(BOARD_FRAME);
  assert.ok(forum, '#dev-forum-scroll is missing from board-frame.tsx');
  assert.match(forum[0], /platform-safe-scroll/,
    'the Dev card list must clear the home indicator');
  assert.ok(!APP_VIEW.includes('id="dev-forum-scroll"'),
    'the template that used to emit it is retired, not duplicated');

  // #1078: the dev chat's whole screen is a component too, so its scroller's
  // classes are a JSX className rather than an attribute in a template string.
  const sessions = /id="dc-session-list"[\s\S]{0,240}?>/.exec(DEV_VIEW);
  assert.ok(sessions, '#dc-session-list is missing from view.tsx');
  assert.match(sessions[0], /platform-safe-scroll/,
    'the sessions list must clear the home indicator');
  assert.ok(!DEV_CHAT.includes('id="dc-session-list"'),
    'the template that used to emit it is retired, not duplicated');
});

test('the dev-chat composer bar carries platform-safe-bar', () => {
  // The wrapper holding the model row, drafts, attachments, #dc-form and
  // the shortcut hint — anchored to the bottom of the screen in a
  // session, which is where the dead band used to be.
  const idx = DEV_VIEW.indexOf('id="dc-messages"');
  assert.ok(idx > -1, '#dc-messages is missing from view.tsx');
  assert.match(DEV_VIEW.slice(idx, idx + 1200), /id="dc-composer-bar"/,
    "the dev-chat composer's bar wrapper moved — re-anchor this test");
  // #1348: the framing is dropped when a launchpad has emptied the bar, so
  // that it does not frame nothing. The INSET is not part of that — it is the
  // bottom of the screen either way, and a transcript running under the home
  // indicator is the bug this test exists for. So platform-safe-bar must be
  // in BOTH class runs, unlike the padding.
  //
  // Streamlined Concept retired the `border-t`: the composer is a card that
  // floats on the pane's ground and carries its own elevation, so a rule
  // above it drew a second edge. What is left to drop is the padding.
  //
  // The two runs are complete literals rather than one string with a
  // conditional tail, because Tailwind's extractor is a regex over source
  // text: a class name assembled from fragments compiles to nothing.
  const bare = /bare: '([^']*)'/.exec(DEV_VIEW);
  const framed = /framed: '([^']*)'/.exec(DEV_VIEW);
  assert.ok(bare && framed, 'the empty-bar case must still be expressed here');
  assert.match(bare[1], /platform-safe-bar/,
    'the safe-area inset must never be conditional');
  assert.match(framed[1], /platform-safe-bar/);
  assert.doesNotMatch(bare[1], /p[xytb]?-\d/,
    'the padding is the part that goes when there is nothing to frame');
  assert.match(framed[1], /px-3 pb-3 pt-1/,
    'and it is asymmetric on purpose: the card\'s own radius does the '
    + 'insetting the old uniform p-2 did');
  for (const run of [bare[1], framed[1]]) {
    assert.doesNotMatch(run, /border-t/,
      'the card draws its own edge; a rule above it would be a second one');
  }
});

test('the general-chat composer bar carries platform-safe-bar, on both branches', () => {
  // This markup left public/js/app-view.js's `renderGroupChatTab` template for
  // features/group-chat/general-chat.tsx in #1191, so the check renders the
  // component instead of reading a template literal — which also proves the
  // class survives to the DOM rather than merely appearing in a source string.
  //
  // BOTH branches, because here the read-only notice sits INSIDE the bar
  // rather than replacing it (the thread panel does the opposite, below), and
  // a refactor that lifted the notice out would take the inset with it.
  const pane = (readOnly) => renderComponent(
    'frontend/src/features/group-chat/general-chat.tsx', 'GeneralChat',
    { introAppName: null, readOnly, maxLength: 8000 },
  );
  // 1 November 2026: the bar is the chat foot's (ChatComposerBar), whose
  // padding is app.css's `.chat-composer-bar` rather than Tailwind here.
  for (const readOnly of [false, true]) {
    const html = pane(readOnly);
    const bar = /<div class="chat-composer-bar[^"]*"/.exec(html);
    assert.ok(bar, `readOnly=${readOnly}: the composer's bar wrapper moved — re-anchor this test`);
    assert.match(bar[0], /platform-safe-bar/,
      `readOnly=${readOnly}: the general-chat composer must sit above the home indicator`);
  }
  // The composer is inside that bar, not a sibling of it.
  assert.match(pane(false), /platform-safe-bar[^>]*><div id="gc-reply-preview"/);
  assert.match(pane(true), /platform-safe-bar[^>]*><div class="px-3 py-2 text-xs/);
});

test('the thread composer AND its read-only notice both carry the bar class', () => {
  // The thread panel renders one or the other; the notice REPLACES the
  // composer, so it needs the identical clearance. This markup serves the
  // issue / proposal topic sub-view, and it moved out of GroupChat.mountThread
  // into features/group-chat/thread-shell.tsx in #1191 — so this renders both
  // branches rather than reading two template literals, which also proves the
  // class SURVIVES to the DOM rather than merely appearing in a source string.
  const shell = (readOnly) => renderComponent(
    'frontend/src/features/group-chat/thread-shell.tsx', 'ThreadShell',
    {
      fill: true,
      withHeader: false,
      readOnly,
      notice: 'This thread is read-only.',
      placeholder: 'Reply in thread…',
      maxLength: 8000,
    },
  );
  const composer = shell(false);
  assert.match(composer, /class="chat-composer-bar platform-safe-bar"/,
    'the thread composer must sit above the home indicator');
  const notice = shell(true);
  assert.match(notice, /class="px-3 py-2[^"]*platform-safe-bar">This thread is read-only\./,
    'the read-only notice must clear the indicator like the composer it replaces');
});

// ── 5. Panels that escape #app-view ──────────────────────────────────

test('the spec viewer insets whichever of its two bottom elements is last', () => {
  // The build hint is conditional (only a non-empty LATEST version
  // renders it), so both need a rule and neither may double up —
  // :last-child is what picks the right one.
  const wrap = /\.dc-spec-viewer-body-wrap:last-child\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(wrap, '.dc-spec-viewer-body-wrap:last-child rule is missing');
  assert.match(wrap[1], /padding-bottom:\s*calc\(12px \+ var\(--platform-safe-bottom\)\)/,
    'with no footer, the scroller carries the inset');

  const hint = /\.dc-spec-viewer-build-hint\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(hint, '.dc-spec-viewer-build-hint rule is missing');
  assert.match(hint[1], /padding:\s*8px 12px calc\(8px \+ var\(--platform-safe-bottom\)\)/,
    'the footer owns the inset when present — and it has a background, so '
    + 'the strip reads as an extension of the footer rather than a gap');

  // The unconditional (non-:last-child) rule must NOT also pad the
  // bottom, or a viewer WITH a footer double-insets.
  const plain = /\.dc-spec-viewer-body-wrap\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(plain, '.dc-spec-viewer-body-wrap rule is missing');
  assert.ok(!/--platform-safe-bottom/.test(plain[1]),
    'the base body-wrap rule must stay plain 12px — the :last-child variant '
    + 'is what adds the inset');
});

test('the fullscreen spec viewer clears the notch as well', () => {
  // Below 1024px the panel is `position: fixed; inset: 0` — it covers the
  // status bar too, so its header row needs the top inset.
  const idx = APP_CSS.indexOf('@media (max-width: 1023px)');
  assert.ok(idx > -1, 'the fullscreen spec-viewer media query is missing');
  const block = APP_CSS.slice(idx, APP_CSS.indexOf('.dc-spec-resizer', idx));
  assert.match(block, /\.dc-spec-viewer\.dc-spec-viewer-open\s*\{[^}]*position:\s*fixed/,
    'the fullscreen mode is what makes the top inset necessary');
  assert.match(block, /padding-top:\s*var\(--platform-safe-top\)/,
    'a fixed inset:0 panel owns BOTH insets — its version picker / Share '
    + 'buttons / ✕ sit under the notch otherwise');
});

test('the gc spec panel body carries the bottom inset', () => {
  const m = /\.gc-spec-panel-body\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(m, '.gc-spec-panel-body rule is missing');
  assert.match(m[1], /padding:\s*14px 16px calc\(14px \+ var\(--platform-safe-bottom\)\)/,
    'below 1024px this panel is absolute inset:0 over .gc-tab-body, whose '
    + "bottom edge is now the screen's");
});

test('the fullscreen staging overlay clears the notch, docked does not', () => {
  // Two exclusions now, and they are the same exclusion twice: the bar
  // clears the notch only when nothing above it already has. Docked, the
  // overlay is pinned mid-page. UNDER-CHROME, a session's own header sits
  // above it and holds the inset — see the app.css block.
  const m = /#staging-overlay:not\(\.staging-overlay-docked\):not\(\.staging-overlay-under-chrome\) \.staging-chrome-bar\s*\{([^}]*)\}/
    .exec(APP_CSS);
  assert.ok(m, 'the staging chrome-bar top-inset rule is missing');
  assert.match(m[1], /padding-top:\s*calc\(0\.5rem \+ var\(--platform-safe-top\)\)/,
    'fullscreen over nothing, the overlay is inset:0 and covers the status bar');
  assert.match(INDEX, /<div class="staging-chrome-bar/,
    'the style hook the rule keys on must exist in index.html');
  // The BOTTOM deliberately gets nothing: everything below the bar is the
  // staging iframe, which reaches the true bottom edge and receives the
  // real insets over the safe-area bridge (#970).
  assert.ok(!/#staging-overlay[^{]*\{[^}]*padding-bottom/.test(APP_CSS),
    'the staging overlay must not reserve the bottom strip — the iframe '
    + 'insets its own chrome from the forwarded values');
});

// ── 6. The review deep link ──────────────────────────────────────────

/** The body of the synthetic-inset applier, for the three tests below. */
function safeAreaShotFn() {
  const idx = APP_JS.indexOf('_applySafeAreaShot() {');
  assert.ok(idx > 0, 'app.js must define _applySafeAreaShot');
  return APP_JS.slice(idx, idx + 700);
}

test('?shot=safe-bottom paints synthetic insets on the shell', () => {
  assert.match(APP_JS, /_applySafeAreaShot\(\)\s*\{/,
    'app.js must handle the ?shot=safe-bottom state link');
  const fn = safeAreaShotFn();
  assert.match(fn, /qs\.get\('shot'\) === 'safe-bottom'/,
    'the original spelling keeps working — capture routes already use it');
  // The KIT properties, not our own tokens: ours are defined as
  // var(--un-safe-inset-X, env(...)), so setting the kit property drives
  // the platform utilities AND every .un-safe-* class from one place.
  assert.match(fn, /setProperty\('--un-safe-inset-top'/,
    'setting the kit property is what moves the header too');
  assert.match(fn, /setProperty\('--un-safe-inset-bottom'/);
  assert.ok(!/--platform-safe-bottom/.test(fn),
    'write the kit property, not our token — the token reads through it');
});

test('and it COMPOSES, because the surfaces worth reviewing need two', () => {
  // `shot` holds one value — every reader in the shell is an equality test
  // against `.get('shot')` — so `?shot=safe-bottom` excludes the shot that
  // OPENS the thing you want to look at. The app menu, Improve and
  // notifications only reserve the home-indicator strip once open, so with
  // one param a capture can have the device or the surface and never both.
  const fn = safeAreaShotFn();
  assert.match(fn, /qs\.get\('safe-bottom'\) === '1'/,
    'a second param, so ?shot=app-context&safe-bottom=1 is expressible. '
    + 'Splitting a comma list would mean teaching every one of those '
    + 'equality tests about lists, which is a far larger change');

  // Strict '1', not truthiness: `?safe-bottom=0` must not paint a notch.
  assert.ok(!/get\('safe-bottom'\)\s*\)/.test(fn),
    "gate on the value, not on the param's presence");
});

test('the shot link runs before any screen paints, for both shells', () => {
  // It must cover the ANONYMOUS shell (the landing / login / waitlist
  // screens are part of what it reviews), so it sits in init() rather
  // than beside the authed-only ?shot= handlers.
  const init = APP_JS.slice(APP_JS.indexOf('async init() {'), APP_JS.indexOf('App.bindEvents();'));
  assert.match(init, /App\._applySafeAreaShot\(\);/,
    'the synthetic insets must be applied in init(), before the anonymous '
    + 'shell branch returns');
});

test('the shot link cannot lie to an app frame', () => {
  // The insets forwarded over the bridge are read from the hidden
  // env()-valued probe (AppView._readRootInsets), never from the custom
  // properties, so an embedded app still receives its REAL insets while
  // the shell is painting synthetic ones.
  assert.match(APP_VIEW, /padding-bottom:env\(safe-area-inset-bottom,0px\)/,
    'the probe must keep reading bare env() — it is the ground truth for '
    + 'what apps are told');
  const probe = APP_VIEW.slice(APP_VIEW.indexOf('_readRootInsets()'), APP_VIEW.indexOf('_frameInsets('));
  assert.ok(!/--un-safe-inset/.test(probe),
    'the probe must not consult the custom properties ?shot=safe-bottom sets');
});
