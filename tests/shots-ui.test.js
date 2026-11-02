'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const AppView = require('../public/js/app-view.js');

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/shots/${id(char)}`;

function shots(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog',
      claim: 'Typing shows <matching> users & keeps "Invite" visible.',
      persona: 'member',
      viewports: ['desktop'],
      steps: ['Open <Members>', 'Type ma'],
      baseState: 'present',
      animation: 'steps',
    }],
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), planHash: 'c'.repeat(64),
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: null,
    artifacts: [
      { id: id('1'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'focus', media: 'png', url: url('1') },
      { id: id('2'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: url('2') },
      { id: id('3'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('3') },
      { id: id('4'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('4') },
      // A server bug or injected object cannot turn an absolute URL into media.
      { id: id('6'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: 'https://evil.example/x.png' },
    ],
    ...overrides,
  };
}

// A run from before shots: one paired before/after recording per viewport.
function legacyPaired() {
  return { id: id('5'), storyId: 'dialog', viewport: 'desktop', side: 'paired', variant: 'animation', media: 'webm', url: url('5') };
}

function clipArtifacts(storyId = 'dialog') {
  return [
    { id: id('7'), storyId, viewport: 'desktop', side: 'base', variant: 'animation', media: 'webm', url: url('7') },
    { id: id('8'), storyId, viewport: 'desktop', side: 'head', variant: 'animation', media: 'webm', url: url('8') },
  ];
}

test('verified cards flip a screen and list the declared change, escaped, authenticated, and never autoplay', () => {
  const value = shots();
  value.artifacts.push(legacyPaired());
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Typing shows &lt;matching&gt; users &amp; keeps &quot;Invite&quot; visible/);
  assert.doesNotMatch(html, /<matching>|evil\.example|\/visuals\//);
  const view = /<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/.exec(html)[0];
  assert.ok(view.indexOf('class="shots-stage"') < view.indexOf('class="shots-view-notes"'), 'the screen leads, its changes follow');
  assert.match(view, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*Play interaction/,
    'the change and its clip are described under the screen that shows it');
  assert.doesNotMatch(html, /class="shots-claims"/, 'nothing is left to list below the screen');
  assert.match(html, /aria-label="Before &amp; after"/);
  assert.match(html, /<video[^>]* controls[^>]*preload="none"[^>]* muted[^>]*playsinline/);
  assert.doesNotMatch(html, /<video[^>]*\bautoplay\b/);
  assert.match(html, /before <code>aaaaaaaa<\/code>/);
  assert.match(html, /after <code>bbbbbbbb<\/code>/);
  assert.match(html, /shots <code>cccccccccccc<\/code>/);
  assert.match(html, /Screenshots ready/);
  assert.match(html, /Screenshot details/);
  assert.match(html, /taken by the screenshot agent/);
  assert.doesNotMatch(html, /Open full screen|data-shots-open|openShotsScreen/, 'the screen is not covered by a full-screen button');
  assert.match(html, /Look at the screenshots and clips to decide whether they show the change\./);
  // The retired replay vocabulary is gone.
  assert.doesNotMatch(html, /Visual change preview|clean replays|bounded repair|relative-pointer|Captured/);
});

test('a legacy paired recording still plays, labelled by what the change declared', () => {
  const steps = shots();
  steps.artifacts.push(legacyPaired());
  const interaction = AppView.shotsHtml(steps, { sessionId: 42 });
  assert.match(interaction, /Play interaction/);
  assert.match(interaction, new RegExp(`<video src="${url('5')}"`));
  assert.doesNotMatch(interaction, /data-shots-clips/);

  const motion = shots();
  motion.claims[0].animation = 'motion';
  motion.artifacts.push(legacyPaired());
  const html = AppView.shotsHtml(motion, { sessionId: 42 });
  assert.match(html, /Play animation/);
  assert.doesNotMatch(html, /Play interaction/);
});

test('a motion change with a clip per side shows a before and an after player', () => {
  const value = shots();
  value.claims[0].animation = 'motion';
  value.artifacts.push(...clipArtifacts());
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(html)[0];
  assert.match(change, /data-shots-clips="1"/, 'the clips sit with their change');
  const players = change.match(/<video [^>]*>/g) || [];
  assert.equal(players.length, 2);
  assert.match(players[0], new RegExp(`src="${url('7')}"`));
  assert.match(players[0], new RegExp(`poster="${url('3')}"`), 'the before screen shot is the before poster');
  assert.match(players[1], new RegExp(`src="${url('8')}"`));
  assert.match(players[1], new RegExp(`poster="${url('4')}"`));
  for (const player of players) {
    assert.match(player, / controls preload="none" muted playsinline/);
    assert.doesNotMatch(player, /\bautoplay\b/);
  }
  assert.match(change, /Before clip/);
  assert.match(change, /After clip/);
  // Side-by-side clips replace the legacy paired player.
  assert.doesNotMatch(html, /Play animation|Play interaction/);
  assert.match(html, /Look at the screenshots and clips/);

  // A clip missing on one side says so rather than hiding the other.
  const oneSided = shots();
  oneSided.claims[0].animation = 'motion';
  oneSided.artifacts.push(clipArtifacts()[1]);
  const partial = AppView.shotsHtml(oneSided, { sessionId: 42 });
  assert.match(partial, /data-shots-clips="1"/);
  assert.match(partial, /No clip/);
  assert.equal((partial.match(/<video /g) || []).length, 1);

  // A clip URL for another proposal is never played.
  const foreign = shots();
  foreign.claims[0].animation = 'motion';
  foreign.artifacts.push(...clipArtifacts().map((clip) => ({ ...clip, url: clip.url.replace('/42/', '/43/') })));
  assert.doesNotMatch(AppView.shotsHtml(foreign, { sessionId: 42 }), /<video|data-shots-clips/);
});

test('each screen flips between its after and before screen shots, with no script', () => {
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  // One pair of radios holds the side for every screen, after to start with.
  const picks = html.match(/<input type="radio" class="shots-side-pick[^>]*>/g) || [];
  assert.equal(picks.length, 2);
  assert.match(picks[0], /class="shots-side-pick shots-side-before" name="shots-42-side" id="shots-42-side-before" aria-label="Show the screen before the change">$/);
  assert.match(picks[1], /class="shots-side-pick shots-side-after" name="shots-42-side" id="shots-42-side-after" aria-label="Show the screen after the change" checked>$/);
  assert.ok(html.indexOf('class="shots-side-pick') < html.indexOf('<figure class="shots-view"'), 'the radios precede the screens they show');
  const figure = /<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/.exec(html)[0];
  // After first, as the proposal would leave it.
  assert.deepEqual([...figure.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1]), [url('4'), url('3')]);
  // The toolbar's switch and a click on the shot both set the side.
  assert.match(figure, /<label for="shots-42-side-before" class="shots-seg-btn shots-seg-before">Before<\/label><label for="shots-42-side-after" class="shots-seg-btn shots-seg-after">After<\/label>/);
  assert.match(figure, /<label for="shots-42-side-before" class="shots-flip-to shots-flip-to-before" title="Click to see before" aria-hidden="true"><\/label>/);
  assert.match(figure, /<label for="shots-42-side-after" class="shots-flip-to shots-flip-to-after" title="Click to see after" aria-hidden="true"><\/label>/);
  assert.match(figure, /shots-flip-chip-after">After</);
  assert.match(figure, /shots-flip-chip-before">Before</);
  assert.doesNotMatch(html, /onchange|onclick="AppView\.flip|<script/, 'the flip is radios and their labels');
  // A card without a proposal id still flips.
  assert.match(AppView.shotsHtml(shots(), {}), /id="shots-card-side-before"/);
  // The same markup on every render, so a repaint does not rebuild it.
  assert.equal(AppView.shotsHtml(shots(), { sessionId: 42 }), html);
});

test('every screen sits in the same fixed stage, fitted at its own shape', () => {
  const value = shots({
    claims: [{ ...shots().claims[0], viewports: ['desktop', 'phone'] }],
    artifacts: [
      ...shots().artifacts.map((artifact) => (artifact.variant === 'context' ? { ...artifact, width: 1280, height: 800 } : artifact)),
      { id: id('a'), storyId: 'dialog', viewport: 'phone', side: 'base', variant: 'context', media: 'png', url: url('a'), width: 390, height: 844 },
      { id: id('b'), storyId: 'dialog', viewport: 'phone', side: 'head', variant: 'context', media: 'png', url: url('b'), width: 390, height: 844 },
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const [desktop, phone] = html.match(/<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/g);
  for (const figure of [desktop, phone]) assert.equal((figure.match(/<div class="shots-stage">/g) || []).length, 1);
  assert.match(desktop, /<span class="shots-flip-side shots-flip-after" style="--shots-shape:1280 \/ 800"><img /);
  assert.match(phone, /<span class="shots-flip-side shots-flip-after" style="--shots-shape:390 \/ 844"><img /);
  assert.match(desktop, /Desktop, 1280 × 800 · seen as a member/);
  assert.match(phone, /Phone, 390 × 844 · seen as a member/);
  // No size of its own on the screen: the stylesheet gives every stage one.
  assert.doesNotMatch(html, /shots-flip-narrow|max-width/);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.shots-stage \{[^}]*container-type: size;[^}]*aspect-ratio: 16 \/ 10;/);
  assert.match(css, /\.shots-stage > \.shots-flip-side \{[^}]*width: min\(100cqw, calc\(100cqh \* \(var\(--shots-shape, 16 \/ 10\)\)\)\); aspect-ratio: var\(--shots-shape, 16 \/ 10\);/);
  assert.match(css, /\.shots-view \{ grid-area: 1 \/ 1;[^}]*visibility: hidden; \}/, 'the screens share one cell, so the tallest sets the height');
  // Stills saved at device scale say the screen's own size, not their pixels.
  const dense = AppView.shotsHtml({ ...value, artifacts: value.artifacts.map((artifact) => (artifact.variant === 'context'
    ? { ...artifact, width: artifact.width * (artifact.viewport === 'phone' ? 3 : 2), height: artifact.height * (artifact.viewport === 'phone' ? 3 : 2),
      density: artifact.viewport === 'phone' ? 3 : 2 }
    : artifact)) }, { sessionId: 42 });
  assert.match(dense, /Desktop, 1280 × 800 · seen as a member/);
  assert.match(dense, /Phone, 390 × 844 · seen as a member/);
  assert.match(dense, /--shots-shape:1170 \/ 2532/, 'the shape is only a ratio');
  // Without recorded sizes a phone screen still reads as a phone.
  const unsized = AppView.shotsHtml({ ...value, artifacts: value.artifacts.map(({ width, height, ...rest }) => rest) }, { sessionId: 42 });
  assert.match(unsized, /data-shots-viewport="phone"[\s\S]*?--shots-shape:390 \/ 844/);
});

test('the run\'s screens outline each change where it differs, numbered as in the list', () => {
  const value = shots({
    claims: [
      shots().claims[0],
      { id: 'list', claim: 'The list has a new first row.', persona: 'member',
        viewports: ['desktop'], steps: ['Open the list'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [{ id: 'dialog', status: 'ready' }, { id: 'list', status: 'ready' }],
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog', 'list'],
      width: 1000, heightBefore: 500, heightAfter: 500,
      regions: [
        { story: 'dialog', b: [100, 50, 200, 40], a: [100, 50, 250, 40], bMark: null, aMark: null },
        { story: 'list', b: null, a: [0, 300, 1000, 50], bMark: [0, 300, 1000], aMark: null },
        { story: null, b: [0, 0, 1000, 20], a: [0, 0, 1000, 10], bMark: null, aMark: null },
      ],
    }],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.equal((html.match(/<figure class="shots-view"/g) || []).length, 1, 'two changes on one screen share it');
  const after = /<span class="shots-flip-side shots-flip-after"[^>]*>([\s\S]*?)<\/span>\s*<span class="shots-flip-side shots-flip-before"/.exec(html)[1];
  const before = /<span class="shots-flip-side shots-flip-before"[^>]*>([\s\S]*?)<label /.exec(html)[1];
  assert.match(after, /class="shots-box" style="left:10\.000%;top:10\.000%;width:25\.000%;height:8\.000%"><span class="shots-box-n">1<\/span>/);
  assert.match(after, /class="shots-box" style="left:0\.000%;top:60\.000%;width:100\.000%;height:10\.000%"><span class="shots-box-n">2<\/span>/);
  assert.match(before, /class="shots-box" style="left:10\.000%;top:10\.000%;width:20\.000%;height:8\.000%"><span class="shots-box-n">1<\/span>/);
  assert.match(before, /class="shots-mark" style="left:0\.000%;top:60\.000%;width:100\.000%"><span class="shots-box-n">2<\/span>/,
    'where the new row appears, on the side it was not on');
  assert.match(after, /class="shots-box shots-box-other"/, 'an undeclared difference is outlined, unnumbered');
  assert.doesNotMatch(after, /shots-box-other"[^>]*><span class="shots-box-n"/);
  // Each outline carries its number, so pointing at its description picks it out.
  assert.match(after, /<span data-shots-n="1" class="shots-box"/);
  assert.match(before, /<span data-shots-n="2" class="shots-mark"/);
  // Both changes are described under the screen, numbered as outlined, and
  // the dashed shapes are explained there.
  const notes = /<figcaption class="shots-view-notes">([\s\S]*?)<\/figcaption>/.exec(html)[1];
  assert.match(notes, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog"><span class="shots-change-n">1<\/span>/);
  assert.match(notes, /<li class="shots-change" data-shots-n="2" data-shots-change="list"><span class="shots-change-n">2<\/span>/);
  assert.match(notes, /Dashed outline: also changed here, but no change on this list describes it/);
  assert.match(notes, /Dashed line: where the change begins on a side that doesn’t have it/);
  assert.doesNotMatch(html, /class="shots-claims"/, 'no flat list repeats them');

  // A run from before the outlines: a screen per change and size, nothing outlined.
  const legacy = AppView.shotsHtml({ ...value, screens: [] }, { sessionId: 42 });
  assert.doesNotMatch(legacy, /shots-box|shots-mark|Dashed/);
  assert.equal((legacy.match(/<figure class="shots-view"/g) || []).length, 1, 'only the change with shots gets a screen');
  // The change with no screen is described below the viewer instead.
  assert.match(legacy, /<ol class="shots-claims"><li data-shots-story="list" data-shots-shot-status="ready" class="shots-claim">\s*<span class="shots-claim-n">2<\/span>/);
  assert.doesNotMatch(legacy, /data-shots-story="dialog"/);
  // A screen whose shots are not in this card's artifacts is not drawn.
  const orphan = AppView.shotsHtml({ ...value, screens: [{ ...value.screens[0], shot: 'list' }] }, { sessionId: 42 });
  assert.doesNotMatch(orphan, /shots-box/);
});

test('ready shots can be taken again from the card', () => {
  // After better steps or hints, or to outline a run from before outlines
  // were worked out. Only failed and never-started runs offered it before.
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.match(html, /<button type="button" data-shots-retake="1"[^>]*onclick="AppView\.rerunShots\(42, this\)">Take the screenshots again<\/button>/);
  assert.doesNotMatch(AppView.shotsHtml(shots(), {}), /data-shots-retake/, 'no proposal id, nothing to take again');
});

test('a Desktop / Phone switch picks the screen size, with no script', () => {
  const value = shots({
    claims: [{ ...shots().claims[0], viewports: ['desktop', 'phone'] }],
    artifacts: [
      ...shots().artifacts,
      { id: id('a'), storyId: 'dialog', viewport: 'phone', side: 'base', variant: 'context', media: 'png', url: url('a') },
      { id: id('b'), storyId: 'dialog', viewport: 'phone', side: 'head', variant: 'context', media: 'png', url: url('b') },
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const radios = html.match(/<input type="radio" class="shots-screen-pick"[^>]*>/g) || [];
  assert.equal(radios.length, 2);
  assert.match(radios[0], /name="shots-42-screen-pick" id="shots-42-screen-0" aria-label="Screen 1 of 2: desktop" checked/);
  assert.match(radios[1], /id="shots-42-screen-1" aria-label="Screen 2 of 2: phone">/);
  assert.ok(html.indexOf('class="shots-screen-pick"') < html.indexOf('<figure class="shots-view"'), 'the radios precede the screens they show');
  const [desktop, phone] = html.match(/<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/g);
  assert.match(desktop, /<label for="shots-42-screen-0" class="shots-seg-btn shots-seg-on" title="Desktop"><svg[\s\S]*?<\/svg><span class="shots-seg-label">Desktop<\/span><\/label><label for="shots-42-screen-1" class="shots-seg-btn" title="Phone">/);
  assert.match(phone, /<label for="shots-42-screen-0" class="shots-seg-btn" title="Desktop">[\s\S]*?<label for="shots-42-screen-1" class="shots-seg-btn shots-seg-on" title="Phone">/);
  // One screen at each size: nothing to step through, so no arrows.
  assert.doesNotMatch(html, /shots-screen-nav/);
  // One screen needs neither.
  const single = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.doesNotMatch(single, /shots-screen-pick|shots-screen-nav|shots-seg-size/);
  assert.match(single, /<div class="shots-views shots-views-one">/);
});

test('arrows step through the screens of one size, in the same place on every screen', () => {
  const claim = (claimId, text) => ({ ...shots().claims[0], id: claimId, claim: text, viewports: ['desktop', 'phone'] });
  const context = (storyId, viewport, side, char) => ({ id: id(char), storyId, viewport, side, variant: 'context', media: 'png', url: url(char) });
  const value = shots({
    claims: [claim('dialog', 'The dialog lists matches.'), claim('list', 'The list has a new first row.')],
    shotResults: [{ id: 'dialog', status: 'ready' }, { id: 'list', status: 'ready' }],
    artifacts: [
      context('dialog', 'desktop', 'base', '1'), context('dialog', 'desktop', 'head', '2'),
      context('list', 'desktop', 'base', '3'), context('list', 'desktop', 'head', '4'),
      context('dialog', 'phone', 'base', '5'), context('dialog', 'phone', 'head', '6'),
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const views = html.match(/<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/g);
  assert.deepEqual(views.map((view) => /data-shots-viewport="([^"]+)"/.exec(view)[1]), ['desktop', 'desktop', 'phone']);
  const nav = (view) => /<span class="shots-screen-nav"[\s\S]*?<\/span><\/div>/.exec(view)[0];
  assert.match(nav(views[0]), /shots-screen-step-off">‹<\/span><span class="shots-screen-count">1 of 2<\/span><label for="shots-42-screen-1" class="shots-screen-step" title="Next screen">›/);
  assert.match(nav(views[1]), /<label for="shots-42-screen-0" class="shots-screen-step" title="Previous screen">‹<\/label><span class="shots-screen-count">2 of 2<\/span><span class="shots-screen-step shots-screen-step-off">›/);
  // The phone's one screen keeps the arrows' place, both greyed out.
  assert.match(nav(views[2]), /shots-screen-step-off">‹<\/span><span class="shots-screen-count">1 of 1<\/span><span class="shots-screen-step shots-screen-step-off">›/);
  for (const view of views) {
    assert.ok(view.indexOf('shots-screen-nav') < view.indexOf('class="shots-stage"'), 'the arrows are in the toolbar above the shot');
  }
  // Switching size from the second desktop screen goes to the phone's first.
  assert.match(views[1], /<label for="shots-42-screen-2" class="shots-seg-btn" title="Phone">/);
  // Each screen describes only its own change.
  const described = (view) => [...view.matchAll(/data-shots-change="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views.map(described), [['dialog'], ['list'], ['dialog']]);
  // The list change has no phone screen, but its desktop screen describes
  // it, so nothing is listed again below the viewer.
  assert.doesNotMatch(html, /class="shots-claims"/);
});

test('the Workshop picture\'s element shot must be readable on both sides', () => {
  const sized = (dims) => shots({
    artifacts: shots().artifacts.map((artifact) => (artifact.variant === 'focus' ? { ...artifact, ...dims(artifact) } : artifact)),
  });
  // A 46×28 crop of a corner badge: the screens lead instead, on both sides.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))),
    { ...AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))), before: url('3'), after: url('4') });
  assert.equal(AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))).after, url('2'));
  // Readable in CSS pixels: the same badge saved at 3x is still a badge.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 138, height: 84, density: 3 }))),
    AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))));
  assert.equal(AppView._workshopVisuals(null, sized(() => ({ width: 1056, height: 183, density: 3 }))).after, url('2'));
});

test('a privileged declared change is explicitly labelled as full admin', () => {
  const value = shots();
  value.claims[0].persona = 'full_admin';
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Desktop · seen as a full admin/);
});

test('a change declared for a guest is labelled as seen by a signed-out visitor', () => {
  const value = shots();
  value.claims[0].persona = 'guest';
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Desktop · seen as a signed-out visitor/);
});

test('a still change shows before and after PNGs without suggesting a video', () => {
  const value = shots();
  value.claims[0].animation = 'none';
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(html, /Look at the screenshots to decide whether they show the change\./);
  assert.match(html, /<img src=/);
  assert.doesNotMatch(html, /<video|Play interaction|Play animation|shots and clips|data-shots-clips/);
});

test('absence is labelled only when the author explicitly declared a new before state', () => {
  const withoutBase = shots({ artifacts: shots().artifacts.filter((a) => a.side !== 'base') });
  const ordinary = AppView.shotsHtml(withoutBase, { sessionId: 42 });
  assert.match(ordinary, /No screenshot/);
  assert.doesNotMatch(ordinary, /not there yet/i);

  withoutBase.claims = [{ ...withoutBase.claims[0], baseState: 'not_present' }];
  const absent = AppView.shotsHtml(withoutBase, { sessionId: 42 });
  assert.match(absent, /shots-flip-chip-before">Before · not there yet</);
});

// A project's first version (services/shots-starter.js): its before build was
// the starter template's placeholder, so only the after side was taken. The
// card says so, where it opens and where a before would be, instead of
// showing a missing shot.
test('a first version\'s card says New app: nothing before, and shows its after shots', () => {
  const afterOnly = (overrides = {}) => shots({
    afterOnly: true,
    artifacts: shots().artifacts.filter((artifact) => artifact.side !== 'base'),
    ...overrides,
  });
  const html = AppView.shotsHtml(afterOnly(), { sessionId: 42 });
  assert.match(html, /data-shots-state="verified" aria-label="Before &amp; after" class="space-y-3" data-shots-after-only="1"/);
  assert.match(html, /<p class="text-xs text-zinc-600 dark:text-zinc-400">New app: nothing before\. This proposal builds the app’s first real screens, so these are its after screenshots only\./);
  assert.match(html, /<span class="shots-flip-side shots-flip-before shots-flip-missing">New app: nothing before<\/span>/);
  assert.match(html, new RegExp(`<img src="${url('4')}"`), 'the after screen is shown');
  assert.doesNotMatch(html, /No screenshot|not there yet|Taken on the exact before and after builds/);
  // Even when the author declared the feature absent before, the card names the app as new.
  const declaredAbsent = afterOnly();
  declaredAbsent.claims = [{ ...declaredAbsent.claims[0], baseState: 'not_present' }];
  assert.doesNotMatch(AppView.shotsHtml(declaredAbsent, { sessionId: 42 }), /not there yet/);

  // The change page's Before and after card says the same where the before would be.
  const thread = AppView.shotsHtml(afterOnly(), { sessionId: 42, thread: true });
  assert.match(thread, /class="dev-change-shots-body" data-shots-after-only="1"/);
  assert.match(thread, /shots-flip-missing">New app: nothing before</);

  // A motion change plays its after clip alone, with no empty before player.
  const motion = afterOnly({
    artifacts: [...afterOnly().artifacts, ...clipArtifacts().filter((artifact) => artifact.side === 'head')],
  });
  motion.claims = [{ ...motion.claims[0], animation: 'motion' }];
  const clips = AppView.shotsHtml(motion, { sessionId: 42 });
  assert.match(clips, /these are its after screenshots and clips only/);
  assert.match(clips, new RegExp(`<video src="${url('8')}"`));
  assert.doesNotMatch(clips, /No clip|Before clip/);

  // An ordinary run is unchanged.
  const ordinary = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.doesNotMatch(ordinary, /New app|data-shots-after-only/);
});

test('a skipped change shows its reason and no media, beside a ready one', () => {
  const value = shots({
    claims: [
      { ...shots().claims[0], animation: 'none' },
      { id: 'empty', claim: 'An empty <search> says no users match.', persona: 'member',
        viewports: ['desktop'], steps: ['Type zz'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [
      { id: 'dialog', status: 'ready', reason: null },
      { id: 'empty', status: 'skipped', reason: 'The member fixture has no <list> to search.' },
    ],
    // A run may publish only the screen shots; thumbnails use them.
    artifacts: shots().artifacts.filter((artifact) => artifact.variant === 'context'),
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const skipped = /<li data-shots-story="empty" data-shots-shot-status="skipped"[\s\S]*?<\/li>/.exec(html);
  assert.ok(skipped, 'the skipped change is marked');
  assert.match(skipped[0], /An empty &lt;search&gt; says no users match\./);
  assert.match(skipped[0], />Skipped</);
  assert.match(skipped[0], /The member fixture has no &lt;list&gt; to search\./);
  assert.doesNotMatch(skipped[0], /<img|<video|Open full screen|Screenshots ready/);
  assert.match(html, new RegExp(`<img src="${url('3')}"`), 'the ready change still shows its shots');
  assert.match(html, new RegExp(`<img src="${url('4')}"`));
  assert.match(html, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">/, 'the ready change is described under its screen');
  assert.doesNotMatch(html, /data-shots-story="dialog"/);

  const unexplained = AppView.shotsHtml({
    ...value, shotResults: [value.shotResults[0], { id: 'empty', status: 'skipped', reason: null }],
  }, { sessionId: 42 });
  assert.match(unexplained, /The screenshot agent could not get to this change\./);

  const summary = AppView._workshopVisuals(null, {
    ...value,
    claims: [value.claims[1], value.claims[0]],
  });
  assert.equal(summary.claim, value.claims[0].claim, 'the feed skips a change with no shots');
  assert.equal(summary.before, url('3'));
  assert.equal(summary.after, url('4'));
});

test('a ready change shows the shots agent\'s note on what its shots leave out, as text', () => {
  const noted = AppView.shotsHtml(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note: 'The <b>Show more</b> fold needs a hidden app.' }],
  }), { sessionId: 42 });
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(noted)[0];
  assert.match(change, /<p data-shots-shot-note="1"[^>]*>.*Not in these screenshots:<\/span> The &lt;b&gt;Show more&lt;\/b&gt; fold needs a hidden app\.<\/p>/);
  assert.match(noted, /<img /, 'the shots are still shown above the note');
  // No note, a skipped change's note, or a non-string note renders nothing.
  for (const shotResults of [
    [{ id: 'dialog', status: 'ready', reason: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: { html: '<b>x</b>' } }],
  ]) {
    assert.doesNotMatch(AppView.shotsHtml(shots({ shotResults }), { sessionId: 42 }), /data-shots-shot-note/);
  }
});

// An unchanged change (its before and after came out the same) is shown as
// a ready one was before it had its own status: its shots, then its note,
// then what the shots agent did to both builds to reach it.
test('an unchanged change shows its shots and the note that they came out the same, as a ready one', () => {
  const note = 'any visible difference. The before and after screens came out the same, so these shots cannot show this change.';
  const conditions = [{ kind: 'request_failed', request: '/api/items' }];
  const unchanged = AppView.shotsHtml(shots({
    shotResults: [{ id: 'dialog', status: 'unchanged', reason: null, note, conditions }],
  }), { sessionId: 42 });
  const ready = AppView.shotsHtml(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note, conditions }],
  }), { sessionId: 42 });
  assert.equal(unchanged, ready, 'the card reads it exactly as a ready change with that note');
  assert.match(unchanged, /<p data-shots-shot-note="1"[^>]*>.*Not in these screenshots:<\/span> any visible difference\. The before and after screens came out the same/);
  assert.match(unchanged, /<p data-shots-condition="request_failed"[^>]*>.*Controlled test:<\/span> the screenshot agent made GET \/api\/items fail on both builds/);
  assert.match(unchanged, new RegExp(`<img src="${url('3')}"`));
  assert.doesNotMatch(unchanged, /data-shots-shot-status="skipped"|>Skipped</);
});

// control_request and upload_file: a loading or error state the shots agent
// caused, or a file it chose, is said beside the shots, so nobody takes it
// for the app's own.
test('a ready change says what the shots agent did to both builds to reach it, as text', () => {
  const html = AppView.shotsHtml(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note: 'The fold needs a hidden app.', conditions: [
      { kind: 'request_held', request: '/api/items?q=<b>' },
      { kind: 'request_failed', request: '/api/items' },
      { kind: 'sample_file', files: ['landscape.png', 'table.csv'] },
      { kind: 'evaluate', request: '/api/items' },
      { kind: 'sample_file', files: [] },
    ] }],
  }), { sessionId: 42 });
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(html)[0];
  assert.deepEqual([...change.matchAll(/data-shots-condition="([a-z_]+)"/g)].map((match) => match[1]),
    ['request_held', 'request_failed', 'sample_file']);
  assert.match(change, /Controlled test:<\/span> the screenshot agent kept GET \/api\/items\?q=&lt;b&gt; waiting on both builds, to show it loading\./);
  assert.match(change, /Controlled test:<\/span> the screenshot agent made GET \/api\/items fail on both builds, to show what happens when it does\./);
  assert.match(change, /Sample file:<\/span> the screenshot agent uploaded landscape\.png(?:, | and )table\.csv on both builds, from Homeroom&#39;s own sample files\./);
  assert.ok(change.indexOf('data-shots-shot-note') < change.indexOf('data-shots-condition'), 'after what the shots leave out');
  // None recorded, or a change that is not ready: nothing is said.
  assert.doesNotMatch(AppView.shotsHtml(shots(), { sessionId: 42 }), /data-shots-condition/);
  const skipped = AppView.shotsHtml(shots({
    claims: [...shots().claims, { ...shots().claims[0], id: 'other', claim: 'Another change.' }],
    shotResults: [{ id: 'dialog', status: 'ready', reason: null },
      { id: 'other', status: 'skipped', reason: 'Not reached.', conditions: [{ kind: 'request_held', request: '/api/items' }] }],
  }), { sessionId: 42 });
  assert.doesNotMatch(skipped, /data-shots-condition/);
});

// The shots agent's notes on clear problems it saw on the after build
// (note_problem): under a quiet small-caps label, each saying where it shows
// and whether the before build has it too, and never on a card that is not
// showing published shots.
test('problems the shots agent noticed are listed under Also noticed, quietly and as text', () => {
  const shotNotices = [
    { text: 'The <b>Newest</b> sort control overlaps the "Done" heading.', change: 'dialog', screen: 'desktop', shot: 'screen', alsoBefore: true },
    { text: 'The table is cut off at the right edge.', change: 'dialog', screen: 'phone', shot: null, alsoBefore: false },
    { text: 'An error banner shows.', change: 'dialog', screen: 'desktop', shot: null, alsoBefore: 'unknown' },
  ];
  const card = AppView.shotsHtml(shots({ shotNotices }), { sessionId: 42 });
  const noticed = /<section class="shots-noticed" data-shots-noticed="3" aria-label="Also noticed">[\s\S]*?<\/section>/.exec(card)[0];
  assert.match(noticed, /<h3 class="shots-noticed-head">Also noticed<\/h3>/);
  const items = noticed.match(/<li class="shots-noticed-item"[\s\S]*?<\/li>/g);
  assert.equal(items.length, 3);
  assert.match(items[0], /data-shots-notice="dialog" data-also-before="true"/);
  assert.match(items[0], /<p class="shots-noticed-text">The &lt;b&gt;Newest&lt;\/b&gt; sort control overlaps the &quot;Done&quot; heading\.<\/p>/);
  assert.match(items[0], /<div class="shots-noticed-meta">Desktop · Also on the before build<\/div>/);
  assert.match(items[1], /data-also-before="false"[\s\S]*<div class="shots-noticed-meta">Phone · Not on the before build<\/div>/);
  assert.match(items[2], /data-also-before="unknown"[\s\S]*<div class="shots-noticed-meta">Desktop<\/div>/,
    'a notice nobody checked on the before build says nothing about it');
  assert.ok(card.indexOf('shots-noticed') > card.indexOf('class="shots-viewer'), 'it follows the shots');
  assert.ok(card.indexOf('shots-noticed') < card.indexOf('Screenshot details'));
  // Quiet: no badge, fill or colour of its own; the card still reads ready.
  assert.doesNotMatch(noticed, /dev-badge|bg-|text-red|text-violet|Didn/);
  assert.match(card, /Screenshots ready/);

  // The change page's Before and after card lists them too, after the changes.
  const thread = AppView.shotsHtml(shots({ shotNotices }), { sessionId: 42, thread: true });
  assert.match(thread, /<section class="shots-noticed" data-shots-noticed="3" aria-label="Also noticed">/);
  // With more than one change, each says which one it was seen with.
  const two = shots({
    claims: [...shots().claims, { ...shots().claims[0], id: 'second', claim: 'The second change.' }],
    shotNotices: [{ ...shotNotices[0], change: 'second' }],
  });
  assert.match(AppView.shotsHtml(two, { sessionId: 42 }), /<div class="shots-noticed-meta">Change 2 · Desktop · Also on the before build<\/div>/);

  // None, or none with words: no section at all. Shot details never carries them.
  for (const value of [undefined, [], [{ text: '  ', change: 'dialog', screen: 'desktop' }], 'broken']) {
    assert.doesNotMatch(AppView.shotsHtml(shots({ shotNotices: value }), { sessionId: 42 }), /shots-noticed/);
  }
  assert.doesNotMatch(AppView.shotsHtml(shots({ shotNotices }), { sessionId: 42, details: true }), /shots-noticed/);
  for (const state of ['planned', 'failed', 'stale']) {
    assert.doesNotMatch(AppView.shotsHtml(shots({ state, shotNotices }), { sessionId: 42 }), /Also noticed/, state);
  }
});

test('Also noticed is drawn with the shell\'s small-caps label and quiet lines', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  const rule = (selector) => new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] || '';
  const head = rule('.shots-noticed-head');
  for (const part of ['font-size: 12px', 'font-weight: 700', 'letter-spacing: .06em', 'text-transform: uppercase', 'color: var(--text-muted)']) {
    assert.ok(head.includes(part), `the label is the small-caps group label: ${part}`);
  }
  assert.match(rule('.shots-noticed-text'), /color: var\(--text-primary\)/);
  assert.match(rule('.shots-noticed-meta'), /color: var\(--text-muted\)/);
  assert.doesNotMatch(rule('.shots-noticed') + rule('.shots-noticed-text'), /background|border/);
});

test('pending or failed shots show the declared changes and status but no media or legacy fallback', () => {
  for (const state of ['planned', 'failed', 'stale']) {
    const html = AppView.shotsHtml(shots({
      state,
      failureReason: state === 'failed' ? 'The dialog could not be reached.' : null,
      repairAvailable: state === 'failed',
    }), { sessionId: 42 });
    assert.match(html, new RegExp(`data-shots-state="${state}"`));
    assert.doesNotMatch(html, /<img|<video|\/visuals\//);
    assert.match(html, /<li>Typing shows &lt;matching&gt;/);
  }
  assert.equal(AppView._workshopVisuals({ after: { png: id('a') } }, shots({ state: 'failed' })), null);
});

test('the workshop summary uses protected element shots only after verification', () => {
  const summary = AppView._workshopVisuals(null, shots());
  assert.equal(summary.protected, true);
  assert.equal(summary.before, url('1'));
  assert.equal(summary.after, url('2'));
  assert.equal(summary.claim, shots().claims[0].claim);
});

test('running shots offer Stop, and a stopped or failed set offers to take them again', () => {
  const running = AppView.shotsHtml(shots({ state: 'exploring', artifacts: [] }), { sessionId: 42 });
  assert.match(running, /Taking the screenshots/);
  assert.match(running, /data-shots-stop="1"[^>]*onclick="AppView\.stopShots\(42, this\)">Stop</);
  assert.match(AppView.shotsHtml(shots({ state: 'provisioning', artifacts: [] }), { sessionId: 42 }),
    /Building before and after/);
  assert.match(AppView.shotsHtml(shots({ state: 'reviewing', artifacts: [] }), { sessionId: 42 }),
    /Saving the screenshots/);
  const notStarted = AppView.shotsHtml(shots({ state: 'planned', artifacts: [] }), { sessionId: 42 });
  assert.doesNotMatch(notStarted, /data-shots-stop/, 'nothing is running to stop');

  const stopped = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_stopped', repairAvailable: false,
    failureReason: 'Stopped before it finished.',
  }), { sessionId: 42 });
  assert.match(stopped, /Screenshots stopped/);
  assert.doesNotMatch(stopped, /bg-red-500\/10/, 'a stop is not a failure');
  assert.match(stopped, /onclick="AppView\.rerunShots\(42, this\)">Take the screenshots again</);
  assert.doesNotMatch(stopped, /data-shots-stop/);

  const failed = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_capture_incomplete', repairAvailable: true,
    failureReason: 'The shots agent could not reach the dialog.',
  }), { sessionId: 42 });
  assert.match(failed, /Couldn’t take the screenshots/);
  assert.match(failed, /The shots agent could not reach the dialog\./);
  assert.match(failed, /bg-red-500\/10/);
  assert.match(failed, />Take the screenshots again</);

  const conflict = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'visible_changes_conflict', repairAvailable: false,
    failureReason: 'The declaration says nothing visible changed.',
  }), { sessionId: 42 });
  assert.doesNotMatch(conflict, /Take the screenshots again/, 'a retry that would repeat the failure is not offered');
});

test('an interrupted run the platform is starting again reads as under way, not as a failure', () => {
  const retrying = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: false,
    automaticRetryPending: true,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }), { sessionId: 42 });
  assert.match(retrying, /Trying the screenshots again/);
  assert.match(retrying, /starts them again on its own in a moment/);
  assert.doesNotMatch(retrying, /Couldn’t take the screenshots|You can take them again/);
  assert.doesNotMatch(retrying, /bg-red-500\/10/, 'nothing has failed that needs anyone');
  assert.doesNotMatch(retrying, /Take the screenshots again/, 'the retry is already coming');

  const view = AppView._shotsView(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', automaticRetryPending: true,
  }));
  assert.equal(view.retrying, true);
  assert.equal(view.label, 'Trying the screenshots again');

  // Once the retries are used up, the stored reason and the manual retry are back.
  const spent = AppView.shotsHtml(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: true,
    automaticRetryPending: false,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }), { sessionId: 42 });
  assert.match(spent, /Couldn’t take the screenshots/);
  assert.match(spent, />Take the screenshots again</);
});

test('a change not yet up for a vote shows its shots on its page and in the feed', () => {
  // The shots are taken once the preview is up, before anyone promotes the
  // change, so a draft is where the author first looks at them.
  const draft = { id: 42, source: 'cli_handoff', status: 'paused', shots: shots(), visuals: null };
  const view = AppView._detailActionsView('session', draft);
  assert.ok(view && view.visuals, 'the page carries the before & after');
  assert.match(view.visuals.tilesHtml, /data-shots="1"/);
  assert.match(view.visuals.tilesHtml, /\/api\/apps\/demo\/proposals\/42\/shots\//);
  // Without shots, a session still shows no legacy route capture.
  const legacyOnly = AppView._detailActionsView('session', { ...draft, shots: null, visuals: legacyPaired() });
  assert.ok(!legacyOnly || !legacyOnly.visuals, 'legacy captures stay on proposals and imported pull requests');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app-view.js'), 'utf8');
  assert.match(source, /\(kind === 'session' && item && item\.shots \? AppView\._workshopVisuals\(null, item\.shots\) : null\)/,
    'the feed picture follows the same rule, from the shots alone');
});

test('a proposal with nothing to show says so plainly, not in the author\'s words', () => {
  const quiet = shots({
    state: 'not_required', required: false, claims: [], artifacts: [],
    rationale: 'No rendering code changes. The bot records different text in build_error.',
  });
  const card = AppView.shotsHtml(quiet, { sessionId: 42 });
  assert.match(card, /No before &amp; after needed/);
  assert.match(card, /This proposal has no visual changes\./);
  assert.doesNotMatch(card, /rendering code|build_error/);
  const strip = AppView._shotsView(quiet);
  assert.equal(strip.label, 'No before & after needed');
  assert.equal(strip.sentence, 'This proposal has no visual changes.');
});

test('no state of the card says "Visual change preview"', () => {
  const states = ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'verified',
    'failed', 'stale', 'cancelled', 'not_required', 'overridden'];
  for (const state of states) {
    for (const extra of [{}, { failureCode: 'shots_stopped' }, { notStartedReason: 'Switched off here.' }]) {
      const html = AppView.shotsHtml(shots({ state, ...extra }), { sessionId: 42 });
      assert.doesNotMatch(html, /visual change preview/i, `${state} ${JSON.stringify(extra)}`);
    }
  }
});

// #5063: the change page's side-by-side view crops both sides to the
// screen's declared changes (the numbered outlines, with a margin), and a
// crop wider than it is tall stacks the sides, before above after. The
// proposal card has no side-by-side view, so it never crops.
test('the change page\'s side-by-side view crops to the declared changes and stacks a wide crop', () => {
  const value = shots({
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog'],
      width: 1000, heightBefore: 500, heightAfter: 500,
      regions: [{ story: 'dialog', b: [100, 50, 200, 40], a: [100, 50, 250, 40], bMark: null, aMark: null }],
    }],
  });
  const card = AppView.shotsHtml(value, { sessionId: 42 });
  assert.doesNotMatch(card, /shots-crop|data-shots-stack/, 'the proposal card does not crop');
  const thread = AppView.shotsHtml(value, { sessionId: 42, thread: true });
  assert.match(thread, /<div class="shots-stage" data-shots-stack="1">/, 'the crop is wider than it is tall: before above after');
  const styleOf = (which) => new RegExp(`<span class="shots-flip-side shots-flip-${which}" data-shots-crop="1" style="([^"]*)"`).exec(thread)[1];
  // The crop is never below half the screen's width nor a fifth of it tall,
  // so a small change keeps its surroundings; both sides read the same part.
  for (const which of ['after', 'before']) {
    assert.equal(styleOf(which),
      '--shots-shape:1000 / 500;--shots-crop-shape:500 / 200;--shots-crop-x:0.000%;--shots-crop-y:0.000%;--shots-crop-w:200.000%;--shots-crop-h:250.000%',
      `${which}: centred on the change, at the shared size`);
  }
  const after = /<span class="shots-flip-side shots-flip-after" data-shots-crop="1"[^>]*>([\s\S]*?)<\/span>\s*<span class="shots-flip-side shots-flip-before"/.exec(thread)[1];
  assert.match(after, /<span class="shots-crop"><img /, 'the img and the outlines move together in a crop wrapper');
  assert.match(after, /class="shots-box-n">1<\/span>/, 'the numbered outline is still there');
  // The markup keeps --shots-shape first, so a repaint renders the same
  // whole-screen fallback for screens without a crop.
  assert.match(thread, /<div class="shots-stage" data-shots-stack="1">[\s\S]*?<span class="shots-flip-side shots-flip-after" data-shots-crop="1"/);
});

test('a crop taller than it is wide stays side by side, only zoomed in', () => {
  const value = shots({
    claims: [{ ...shots().claims[0], viewports: ['phone'] }],
    artifacts: [
      { id: id('3'), storyId: 'dialog', viewport: 'phone', side: 'base', variant: 'context', media: 'png', url: url('3') },
      { id: id('4'), storyId: 'dialog', viewport: 'phone', side: 'head', variant: 'context', media: 'png', url: url('4') },
    ],
    screens: [{
      viewport: 'phone', shot: 'dialog', stories: ['dialog'],
      width: 390, heightBefore: 844, heightAfter: 844,
      regions: [{ story: 'dialog', b: [0, 100, 390, 400], a: [0, 100, 390, 400], bMark: null, aMark: null }],
    }],
  });
  const thread = AppView.shotsHtml(value, { sessionId: 42, thread: true });
  assert.match(thread, /data-shots-crop="1"/);
  assert.match(thread, /--shots-crop-shape:390 \/ 448;/);
  assert.doesNotMatch(thread, /data-shots-stack/, 'a tall crop stays beside each other');
  assert.match(thread, /<div class="shots-stage">/, 'the stage keeps its plain markup');
});

test('a screen with no declared outline, or a crop that covers it, keeps the whole-screen layout', () => {
  const withRegions = (regions) => shots({
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog'],
      width: 1000, heightBefore: 500, heightAfter: 500, regions,
    }],
  });
  const cases = [
    ['no screens at all', shots()],
    ['no regions', withRegions([])],
    ['only differences no declared change accounts for',
      withRegions([{ story: null, b: [0, 0, 1000, 20], a: [0, 0, 1000, 10], bMark: null, aMark: null }])],
    ['a region that covers most of the screen',
      withRegions([{ story: 'dialog', b: [0, 0, 1000, 400], a: [0, 0, 1000, 400], bMark: null, aMark: null }])],
  ];
  for (const [name, value] of cases) {
    const thread = AppView.shotsHtml(value, { sessionId: 42, thread: true });
    assert.doesNotMatch(thread, /shots-crop|data-shots-stack/, name);
  }
  // A first version's after-only shots have no before to crop.
  const newApp = shots({
    afterOnly: true,
    artifacts: shots().artifacts.filter((artifact) => artifact.side !== 'base'),
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog'],
      width: 1000, heightBefore: 500, heightAfter: 500,
      regions: [{ story: 'dialog', b: [100, 50, 200, 40], a: [100, 50, 250, 40], bMark: null, aMark: null }],
    }],
  });
  assert.doesNotMatch(AppView.shotsHtml(newApp, { sessionId: 42, thread: true }), /shots-crop|data-shots-stack/, 'after only: no crop');
});

// The dark shots (#4459) reach the card as one more image beside each
// light one, with a round moon/sun label and a pair of hidden radios: no
// script, like the side and screen switches.
test('a run with no dark shots draws no theme switch at all', () => {
  const html = AppView.shotsHtml(shots(), { sessionId: 42 });
  assert.doesNotMatch(html, /shots-theme-pick|shots-theme-flip|shots-img-dark/);
  // Older runs' artifacts, with no theme on them, read as light.
  assert.doesNotMatch(AppView.shotsHtml(shots({
    artifacts: shots().artifacts.map((artifact) => ({ ...artifact, theme: undefined })),
  }), { sessionId: 42 }), /shots-theme/);
});

test('with dark shots, both images and the flip switch render, and the pick follows the page and the remembered mode', () => {
  const value = shots({
    artifacts: [
      ...shots().artifacts,
      { id: id('9'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('9'), theme: 'dark' },
      { id: id('0'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('0'), theme: 'dark' },
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  // Each side of the screen carries its light image and its dark one.
  const after = /<span class="shots-flip-side shots-flip-after"[^>]*>([\s\S]*?)<\/span>\s*<span class="shots-flip-side shots-flip-before"/.exec(html)[1];
  const before = /<span class="shots-flip-side shots-flip-before"[^>]*>([\s\S]*?)<label /.exec(html)[1];
  for (const [span, lightId, darkId] of [[after, '4', '0'], [before, '3', '9']]) {
    assert.match(span, new RegExp(`<img src="${url(lightId)}" [^>]*class="shots-img-light"`));
    assert.match(span, new RegExp(`<img src="${url(darkId)}" [^>]*class="shots-img-dark"`));
  }
  // The flip is two round labels at the bar's right end; the one naming the
  // mode already showing is hidden by the pick.
  assert.match(html, /<label for="shots-42-theme-dark" class="shots-theme-flip shots-theme-to-dark" title="Show in dark mode"><svg/);
  assert.match(html, /<label for="shots-42-theme-light" class="shots-theme-flip shots-theme-to-light" title="Show in light mode"><svg/);
  // One pair of radios holds the mode for every screen. With no page and no
  // remembered pick, it starts in light (the tests have no document).
  const picks = html.match(/<input type="radio" class="shots-theme-pick[^>]*>/g) || [];
  assert.equal(picks.length, 2);
  assert.match(picks[0], /class="shots-theme-pick shots-theme-light" name="shots-42-theme" id="shots-42-theme-light" aria-label="Show in light mode" checked onchange="AppView\._shotsThemePick\('42', this\)">$/);
  assert.match(picks[1], /class="shots-theme-pick shots-theme-dark" name="shots-42-theme" id="shots-42-theme-dark" aria-label="Show in dark mode" onchange="AppView\._shotsThemePick\('42', this\)">$/);
  // The catalog entry is what the switch says, in English here.
  assert.equal(PlatformI18n.t('changes:shots.viewer.showDark'), 'Show in dark mode');
  assert.equal(PlatformI18n.t('changes:shots.viewer.showLight'), 'Show in light mode');

  // A pick is remembered for the viewer while the page is open.
  AppView._shotsThemePicks.clear();
  AppView._shotsThemePicks.set('42', 'dark');
  const remembered = AppView.shotsHtml(value, { sessionId: 42 });
  assert.match(remembered, /class="shots-theme-pick shots-theme-dark" name="shots-42-theme" id="shots-42-theme-dark" aria-label="Show in dark mode" checked/);
  assert.doesNotMatch(remembered, /shots-theme-light"[^>]*checked/);
  // Another viewer starts in light still.
  assert.match(AppView.shotsHtml(value, {}), /shots-theme-light"[^>]*checked/);
  AppView._shotsThemePicks.clear();

  // The checked one follows the mode the page is drawn in.
  const hadDocument = Object.hasOwn(globalThis, 'document');
  globalThis.document = { documentElement: { classList: { contains: (name) => name === 'dark' } } };
  try {
    const darkPage = AppView.shotsHtml(value, { sessionId: 42 });
    assert.match(darkPage, /class="shots-theme-pick shots-theme-dark" name="shots-42-theme" id="shots-42-theme-dark" aria-label="Show in dark mode" checked/);
    assert.doesNotMatch(darkPage, /shots-theme-light"[^>]*checked/, 'only one radio starts checked');
  } finally {
    if (!hadDocument) delete globalThis.document;
  }
});

test('a side with no dark shot keeps its light one in both modes', () => {
  const value = shots({
    artifacts: [
      ...shots().artifacts,
      { id: id('0'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('0'), theme: 'dark' },
    ],
  });
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  const after = /<span class="shots-flip-side shots-flip-after"[^>]*>([\s\S]*?)<\/span>\s*<span class="shots-flip-side shots-flip-before"/.exec(html)[1];
  const before = /<span class="shots-flip-side shots-flip-before"[^>]*>([\s\S]*?)<label /.exec(html)[1];
  assert.match(after, /class="shots-img-dark"/);
  assert.doesNotMatch(before, /class="shots-img-dark"/);
  // The switch is still there: the after side has a dark shot to show.
  assert.match(html, /shots-theme-flip/);
});

test('the theme switch is CSS: the pick swaps the images and keeps the arrows beside the button', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  const rule = (selector) => new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] || '';
  const flip = rule('.shots-theme-flip');
  for (const part of ['width: 30px', 'height: 30px', 'border-radius: 999px', 'margin-inline-start: auto']) {
    assert.ok(flip.includes(part), `the switch is a small round disc at the bar's end: ${part}`);
  }
  assert.match(css, /\.shots-theme-flip ~ \.shots-screen-nav \{ margin-inline-start: 0; \}/,
    'the stepping arrows sit beside the switch, not the bar\'s far end');
  assert.match(css, /\.shots-viewer:has\(\.shots-theme-dark:checked\) \.shots-theme-to-dark,\n\.shots-viewer:has\(\.shots-theme-light:checked\) \.shots-theme-to-light \{ display: none; \}/,
    'the label naming the mode already showing is hidden');
  assert.match(css, /\.shots-viewer:has\(\.shots-theme-dark:checked\) \.shots-flip-side:has\(\.shots-img-dark\) \.shots-img-light,\n\.shots-viewer:has\(\.shots-theme-light:checked\) \.shots-img-dark \{ display: none; \}/,
    'a dark pick swaps the image on the sides that have one');
});

// #5691: the viewer is its own popover, so a narrow pane can hand the shots
// to the whole window. The button is a plain popovertarget: no script, so it
// survives the innerHTML both the card and a spec's frames are drawn with.
test('the viewer is a popover and every bar ends with the button that opens it over the window', () => {
  const html = AppView._shotsViewerHtml({
    key: 42,
    screens: [{ viewport: 'desktop', afterHtml: '<span></span>', beforeHtml: '<span></span>', notesHtml: '' }],
  });
  assert.match(html, /^<div class="shots-viewer" id="shots-42-viewer" popover="auto">/);
  const buttons = html.match(/<button type="button" class="shots-expand"[^>]*>/g) || [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /popovertarget="shots-42-viewer" popovertargetaction="toggle" title="Expand">$/);
  // Both words are in the button, and CSS shows the one that matches:
  // the arrows out with "Expand", the arrows in with "Close" once open.
  assert.match(html, /<span class="shots-expand-out"><svg[\s\S]*?<\/svg><span class="shots-expand-word">Expand<\/span><\/span><span class="shots-expand-in"><svg[\s\S]*?<\/svg><span class="shots-expand-word">Close<\/span><\/span><\/button>/);
  assert.doesNotMatch(html, /<script|onclick|onchange/, 'still no script');
  // The catalogs' words are what it says.
  assert.equal(PlatformI18n.t('changes:shots.viewer.expand'), 'Expand');
  assert.equal(PlatformI18n.t('changes:shots.viewer.collapse'), 'Close');
});

test('the expand CSS: closed it is the same block, open a window-sized card over a dim, and hidden where popovers do not exist', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.shots-viewer\[popover\] \{ display: block; position: relative; inset: auto; margin: 0; padding: 0; border: 0; width: auto; height: auto;\n  overflow: hidden;/,
    'closed, the UA popover box is neutralised and the viewer is the block it always was');
  assert.match(css, /\.shots-viewer:popover-open \{ position: fixed; inset: 0 var\(--platform-float-right\) 0 var\(--platform-float-left\); margin: auto; height: fit-content;[^}]*width: min\(calc\(var\(--platform-float-w\) - 48px\), calc\(\(100vh - 200px\) \* 1\.6\)\); max-height: calc\(100vh - 48px\);/,
    'open, it is nearly the window less the Duo\'s column (the float box, centred in it), in the top layer so a backdrop-filter ancestor cannot trap it');
  assert.match(css, /\.shots-viewer::backdrop \{ background: rgba\(0, 0, 0, 0\.55\); \}/);
  assert.match(css, /@supports \(height: 100dvh\) \{\n  \.shots-viewer:popover-open \{ width: min\(calc\(var\(--platform-float-w\) - 48px\), calc\(\(100dvh - 200px\) \* 1\.6\)\); max-height: calc\(100dvh - 48px\); \}/);
  assert.match(css, /\.shots-expand-in \{ display: none; \}/);
  assert.match(css, /\.shots-viewer:popover-open \.shots-expand-out \{ display: none; \}/);
  assert.match(css, /\.shots-viewer:popover-open \.shots-expand-in \{ display: inline-flex; \}/);
  assert.match(css, /\.shots-theme-flip ~ \.shots-expand \{ margin-inline-start: 0; \}/);
  assert.match(css, /\.shots-expand ~ \.shots-screen-nav \{ margin-inline-start: 0; \}/);
  assert.match(css, /@supports not selector\(:popover-open\) \{ \.shots-expand \{ display: none; \} \}/,
    'a browser without the popover API gets no button that does nothing');
});

test('the crop is CSS: it applies while both sides show, stacked or beside each other', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.shots-crop \{ position: absolute; inset: 0; display: block; \}/,
    'a cropped side shows the whole screen on a Before or After pick');
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage > \.shots-flip-side\[data-shots-crop\] \{ overflow: hidden; aspect-ratio: var\(--shots-crop-shape, 16 \/ 10\); width: min\(calc\(50cqw - 6px\), calc\(100cqh \* \(var\(--shots-crop-shape, 16 \/ 10\)\)\)\); \}/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-flip-side\[data-shots-crop\] > \.shots-crop \{ inset: auto; left: var\(--shots-crop-x, 0\); top: var\(--shots-crop-y, 0\); width: var\(--shots-crop-w, 100%\); height: auto; aspect-ratio: var\(--shots-shape, 16 \/ 10\); \}/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage\[data-shots-stack\] \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\) minmax\(0, 1fr\); column-gap: 0; row-gap: 12px; \}/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage\[data-shots-stack\] > \.shots-flip-after \{ grid-area: 2 \/ 1; \}/);
  assert.match(css, /\.shots-viewer:has\(\.shots-side-both:checked\) \.shots-stage\[data-shots-stack\] \.shots-flip-chip-after \{ inset-inline-start: 10px; top: calc\(50% \+ 16px\); \}/);
  for (const [viewport, width] of [['phone', 420], ['desktop', 720]]) {
    assert.match(css, new RegExp(`@container \\(min-width: ${width}px\\) \\{[^@]*?\\.shots-viewer:has\\(\\.shots-side-auto:checked\\) \\.shots-view\\[data-shots-viewport="${viewport}"\\] \\.shots-stage > \\.shots-flip-side\\[data-shots-crop\\]`),
      `${viewport}: the automatic side by side crops too`);
    assert.match(css, new RegExp(`\\.shots-viewer:has\\(\\.shots-side-auto:checked\\) \\.shots-view\\[data-shots-viewport="${viewport}"\\] \\.shots-stage\\[data-shots-stack\\] \\{ grid-template-columns`),
      `${viewport}: the automatic side by side stacks a wide crop`);
  }
});

test('a sharp still at its own address shows like any other, and nothing else may follow the id', () => {
  // shots-view.js serves an account in the New Needs you experiment each
  // dense still at `…/shots/<id>?density=device` (#5651).
  const dense = (char) => `${url(char)}?density=device`;
  const value = shots();
  value.artifacts = value.artifacts.map((a) => (a.url.startsWith('/api/') ? { ...a, url: dense(a.id[0]), density: 2 } : a));
  const html = AppView.shotsHtml(value, { sessionId: 42 });
  assert.doesNotMatch(html, /missing their details/);
  const figure = /<figure class="shots-view"[\s\S]*?<\/figcaption>\s*<\/figure>/.exec(html)[0];
  assert.deepEqual([...figure.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, '&')), [dense('4'), dense('3')]);
  for (const bad of [`${url('4')}?density=other`, `${url('4')}?density=device&x=1`, `${url('4')}#x`, `${url('4')}?`]) {
    const tampered = shots();
    tampered.artifacts = tampered.artifacts.map((a) => (a.url === url('4') ? { ...a, url: bad } : a));
    assert.ok(!AppView.shotsHtml(tampered, { sessionId: 42 }).includes(bad), `${bad} is refused`);
  }
  // Needs you and New Needs you read the same stills through _workshopVisuals.
  const pictures = AppView._workshopVisuals(null, {
    ...value,
    claims: [{ ...value.claims[0], viewports: ['desktop'] }],
    screens: [{ viewport: 'desktop', shot: 'dialog', width: 1280, heightBefore: 800, heightAfter: 800, density: 2, regions: [] }],
  });
  assert.equal(pictures.screens.length, 1);
  assert.equal(pictures.screens[0].after.url, dense('4'));
});
