'use strict';

// The app chip's sheet is the APP's menu, and About is its second pane
// (#2718).
//
// What this file exists to pin is the seam rather than the rows: a pane that
// can open empty, a pane that does not reset when the sheet closes, and a
// "back" that is really a second sheet are each the kind of defect that looks
// right in a diff and is obvious the first time somebody uses it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const CONTROLLER = read('frontend/src/features/app-context/app-context-controller.js');

// ONE bundle for the component and the store it reads: render-tsx bundles
// each entry separately, so a store imported on its own is a second copy and
// setting it changes nothing the component can see.
const ui = loadTsx('tests/fixtures/about-pane-api.ts');

const render = (patch) => {
  const before = { ...ui.improveStore.get() };
  ui.improveStore.set({ ...before, ...patch });
  try {
    return renderToHtml(createElement(ui.AboutPane, { label: patch.name || 'Notes' }));
  } finally {
    ui.improveStore.set(before);
  }
};

test('About never opens empty', () => {
  // Every other line in it is conditional — a description the manifest may
  // not have, a repository, a share the platform may not allow yet, a version
  // it may never have deployed, a home screen the device may not have — and
  // all of them are absent at once often enough that a pane without an
  // unconditional line would regularly open blank. A row that sometimes leads
  // nowhere is the one thing a menu row must not be. The name and Add are
  // always there; the address no longer stands in for a missing tagline
  // (#4218), and the build line that was the other constant is gone, from
  // every pane.
  const bare = render({ target: 'app', name: 'Notes', slug: 'notes-ab12', repoUrl: null, canShare: false, version: null });
  assert.match(bare, /id="app-about-identity"/);
  assert.match(bare, />Notes</, 'the app is named');
  assert.match(bare, /id="app-about-add"/, 'and what you can do with it is there');
  assert.doesNotMatch(bare, /app-about-note|app-about-how/, 'no line about how it is built');
  assert.doesNotMatch(bare, /\/app\/notes-ab12</, 'without its address under the name');
});

test('each fact appears only when there is one', () => {
  const bare = render({ target: 'app', name: 'Notes', slug: 'notes-ab12', repoUrl: null, canShare: false, version: null });
  assert.doesNotMatch(bare, /improve-row-github/, 'no repository, no row');
  assert.doesNotMatch(bare, /improve-row-share/, 'no share, no row');
  assert.doesNotMatch(bare, /app-about-version/, 'no version, no row');

  const full = render({
    target: 'app', name: 'Notes', slug: 'notes-ab12',
    repoUrl: 'https://github.com/example/notes', canShare: true, version: '14',
  });
  assert.match(full, /id="improve-row-github"[\s\S]{0,200}href="https:\/\/github\.com\/example\/notes"/);
  assert.match(full, /target="_blank"/, 'the repository opens away from the shell');
  // The row says what the code is: every repository is public on GitHub
  // (services/github.js createRepo), whoever the project lets open it.
  assert.match(full, /id="improve-row-github"[^>]*>[\s\S]*?>Code<\/span><span class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">Public on GitHub<\/span><svg [^>]*data-external-mark=""[\s\S]*?<\/svg><span class="sr-only">\(opens outside Homeroom\)<\/span><\/a>/,
    'Code, with Public on GitHub muted, then the mark of a link that leaves Homeroom (#5927)');
  assert.doesNotMatch(full, /View on GitHub/);
  assert.doesNotMatch(full, /improve-row-share/, 'no Share, even with an address: Invite brings people in');
  // The version is a plain row at the foot of More (#4218), not the pill
  // beside the builders' avatars it was: a newcomer reads the top first.
  assert.match(full, /id="app-about-more"[\s\S]*?id="app-about-version"[^>]*>App version: 14</,
    'the version is a plain row under More');
  // Code is the last row, under Remix, and only the version follows it.
  assert.ok(full.indexOf('id="improve-row-github"') < full.indexOf('id="app-about-version"'),
    'the version stays at the foot');
});

test('two panes of ONE sheet, not two sheets', () => {
  // The kit cannot present a sheet while it is still dismissing another —
  // the ordering the wallet row already worked around — and About is where
  // the menu GOES rather than something that opens over it.
  // The invite pane is a third, on the same terms (./invite-pane.tsx).
  assert.match(SHEET, /view === 'about' \? <AboutPane label=\{appLabel\} unnamed=\{!appName\} \/> : view === 'invite' \? \(\s*<InvitePane slug=\{slug \|\| null\} label=\{appLabel\} unnamed=\{!appName\} \/>\s*\) : \(/,
    'the pane replaces the rows inside the same scroller');
  assert.match(SHEET, /id="app-about-back"/, 'and the label row becomes the way back');
  // The platform's back disc, at a 44pt hit box (#4218).
  assert.match(SHEET, /id="app-about-back"[\s\S]{0,200}className=\{BACK_DISC\}/);
  assert.match(SHEET, /const BACK_DISC = '[^']*w-9 h-9 rounded-full'[\s\S]{0,200}un-touch-target';/);
  // The label row's own text is the pane switch's other half: the menu names
  // the app, and a second pane (About, Invite) has only the back disc, as
  // each opens on its own title naming the app.
  assert.match(SHEET, /\{view !== 'menu' \? \(/, 'one row, two states');
  const backAt = SHEET.indexOf("{view !== 'menu' ? (");
  const backRow = SHEET.slice(backAt, SHEET.indexOf(') : (', backAt));
  assert.match(backRow, /id="app-about-back"/);
  assert.doesNotMatch(backRow, /\{appLabel\}/, 'no name beside the back disc');
  // Back is one step back: to About for an invite pane opened from it.
  assert.match(SHEET, /onClick=\{\(\) => AppContext\.goBack\(\)\}/);
  assert.match(CONTROLLER, /goBack\(\) \{\s*const \{ view, back \} = appContextStore\.get\(\);\s*appContextStore\.set\(\{ view: view === 'invite' && back === 'about' \? 'about' : 'menu', back: 'menu' \}\);/);
  // What used to be tested here — that Create New and the app strip belonged
  // to the MENU pane rather than to About — is gone with both of them
  // (#2718 review). About was never the reason: a rail of other apps at the
  // top of a sheet about ONE app was an invitation to leave it, and that is
  // just as true of the menu pane.
  assert.ok(!SHEET.includes('id="apps-switcher-create"'), 'no Create entry');
  assert.ok(!SHEET.includes('id="apps-switcher-list"'), 'no app strip');
});

test('closing resets the pane, by any route', () => {
  // A SUBSCRIPTION rather than a wrapper around close(): the kit's own
  // dismissal — a swipe, a tap on its backdrop — publishes `open: false`
  // without passing through the controller at all, and a sheet that reopens
  // on the pane you left is a sheet that ignores what you asked for.
  assert.match(CONTROLLER, /appContextStore\.subscribe\(\(\) => \{/);
  assert.match(CONTROLLER, /if \(wasOpen && !open\) appContextStore\.set\(\{ view: 'menu', back: 'menu' \}\);/);
  assert.doesNotMatch(CONTROLLER, /AppContext\.close = /,
    'close() is not wrapped — that would miss the kit\'s own dismissal');
});

test('the menu row that opens it is a button, and says so', () => {
  // There is no address to open in a new tab, because the pane is this sheet
  // in another state — which is exactly why every OTHER row here is an
  // anchor and this one is not.
  const at = SHEET.indexOf('id="app-menu-row-about"');
  assert.ok(at > 0);
  const row = SHEET.slice(SHEET.lastIndexOf('<', at), SHEET.indexOf('</button>', at));
  assert.match(row, /type="button"/);
  assert.match(row, /AppContext\.showAbout\(\)/);
  assert.match(row, /w-full/, 'and fills the sheet, so its chevron sits at the edge');
});

test('the Workshop row says what it owes you, and stays silent when it cannot', () => {
  // The design study drew "2 to vote" here. It is the one thing on this menu
  // that REPORTS rather than navigates, which the sheet's own header calls
  // the decay signal — and it earns the exception the way the row does: it is
  // a property of the destination, like a folder saying how many files are in
  // it. A row that sends you to a queue and will not say whether the queue is
  // empty makes you go and look.
  // IT RIDES THE "Go to workshop" ROW (#2761). It spent a round on the App |
  // Workshop strip's Workshop segment; the strip retired to a plain row, and
  // the figure came with it. The number is a count badge and the words are
  // its accessible name.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /id="app-menu-row-workshop"[\s\S]{0,400}trailing=\{owed \?/,
    'the badge is the Workshop row\'s trailing figure');
  assert.match(sheet, /id="app-menu-workshop-owed"/);
  assert.match(sheet, /aria-label=\{t\('agent:appContext\.row\.toVote', \{ count: owed \}\)\}/);
  assert.equal(message('agent:appContext.row.toVote', { count: 3 }), '3 to vote');

  // ONE SOURCE, TWO READERS: /api/workshop/counts is the Workshop tab's own
  // endpoint, so this is the same figure that screen shows on the same app's
  // row rather than a second count computed a second way.
  assert.match(sheet, /fetch\(`\/api\/workshop\/counts\$\{demo\}`\)/);
  const at = sheet.indexOf("if (!open || !slug)");
  const effect = sheet.slice(at, sheet.indexOf('}, [open, slug]);', at));
  assert.ok(at > 0, 'it loads on open, keyed to the app in context');

  // FAILURE IS SILENCE. A menu row that works is worth more than a count, so
  // an offline or refused request leaves the row exactly as it was.
  assert.match(effect, /catch \{/);
  assert.match(effect, /typeof n === 'number' && n > 0/,
    'zero is silence too — "0 to vote" is a row shouting that it has nothing');

  // Nothing during render, so the prerender ships no figure and hydration has
  // nothing to correct.
  assert.ok(!read('public/index.html').includes('id="app-menu-workshop-owed"'),
    'a figure read from data is not in a cold document');
});

test('a platform screen is named by the bar, and says it once', () => {
  // The two screens spent a round disagreeing about what a title is —
  // Messages at 28px, the Workshop wearing the grouped list's 15px muted
  // SECTION LABEL — and were made to agree at 28px. They agree on something
  // simpler now (#2718 review): they do not say it at all. The bar above was
  // already reading "Messages" over an <h2> reading Messages, and Workshop
  // over an <h1> reading Workshop — the same word twice, an inch apart, on
  // every visit. The bar is the title, which is what it is for on every
  // other screen in the shell.
  //
  // HOME REACHED THIS FIRST and for the same reason, which is why it was
  // never a caller: the bar carries the Homeroom wordmark, and a screen
  // called Home under a wordmark is the same word twice.
  const workshop = read('frontend/src/features/workshop/index.tsx');
  const messages = read('frontend/src/features/messages/index.tsx');
  const home = read('frontend/src/features/home/home.js');
  for (const [name, src] of [['Workshop', workshop], ['Messages', messages], ['Home', home]]) {
    assert.ok(!src.includes('platform-screen-title'), `${name} does not title itself`);
  }
  assert.ok(!workshop.includes('<SectionHeader>Workshop</SectionHeader>'),
    'and certainly not with a muted section label');
  assert.ok(!messages.includes('messages-list-title'),
    'Messages\' own title row went with it — a search took the space');
  // What each screen DOES say is the thing the bar cannot. Messages: which
  // of three kinds of message. The Workshop says which workshop with a scope
  // chip: #2759 took it off while the screen was only the list of your apps,
  // and #3051 brought it back as "All apps" over the list it scopes, with
  // the votes owed across it as one Needs you row.
  assert.doesNotMatch(workshop, /AllAppsScope/,
    'the all-apps screen\'s "All" is the bar\'s own title now (#852), not a chip under it');
  assert.match(workshop, /data-workshop-needs-open=""/);
  // Messages says which of three kinds each conversation is by its
  // section's heading (Homeroom bot, Agents, People; 16 Oct 2026).
  assert.match(messages, /<SectionHead section=\{section\}/);
});

test('the desktop rail un-centres the header title', () => {
  // use-header-layout.ts centres on the room it measures, and on a 1280px
  // desktop with an empty left group there is room for anything — so the
  // wordmark landed in the middle of the window, floating over the content
  // column with the rail's 224px to its left. What the hook centres against
  // is the WINDOW, and the window stopped being the content area the moment a
  // rail took a fifth of it.
  const css = read('public/css/app.css');
  const at = css.indexOf('NOT WHILE THE DESKTOP RAIL IS UP');
  assert.ok(at > 0, 'the rule states its reason');
  const block = css.slice(at, css.indexOf('}', css.indexOf('text-align: left;', at)));
  assert.match(block, /@media \(min-width: 768px\)/);
  // IT IS NOT KEYED OFF THE RAIL ANY MORE (#2718 review). That left exactly
  // one live case for centring — a desktop window with no rail, which is a
  // running app — so an app's name floated mid-bar while every platform
  // screen's sat left: the two states of one bar disagreeing about where a
  // title goes, on the one navigation where they alternate.
  assert.match(block, /\n  #header-title\.is-centered \{/,
    'every desktop title is in flow, whatever is beside it');
  assert.doesNotMatch(block, /body:has\(#platform-tabs/,
    'the rail is no longer what decides it');
  assert.match(block, /position: static;/);
  assert.match(block, /text-align: left;/);
  // Expressed in CSS rather than in the hook: "is there room" is a
  // measurement, "is there a rail" is a layout fact the stylesheet knows, and
  // a media query cannot get out of step with the one that draws the rail.
  const hook = read('frontend/src/features/header/use-header-layout.ts');
  assert.ok(!hook.includes('platform-tabs'), 'the hook still only measures');
});
