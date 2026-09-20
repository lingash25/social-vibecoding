// The challenge card parts (ITERATION 03), rendered.
//
// WHAT THIS PINS. A phone-width card body is about 170px on a 320px phone,
// and the defect this exists for is copy that wraps or clips there. It is a
// render property, not a string property, so the parts are rendered
// (tests/lib/render-tsx.js) and the classes that keep the copy on one line are
// asserted on the markup they end up in:
//   * the rail is its own full-width row, holding the state only, and its
//     label `truncate`s;
//   * the meta line under the title ("5d left · 500 pts") is one line: the
//     deadline never shrinks and the reward truncates after it;
//   * the rail is a progressbar, with aria-valuenow ONLY when the fill is a
//     number (indeterminate otherwise), and draws a bar only when counted;
//   * the tile draws a template's illustration only when the registry
//     resolves it (a built-in, or an upload on its payload tone, else gray),
//     and is otherwise exactly the tile it was.
//
// Run with: node --test tests/challenge-card-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const CARD_PATH = 'frontend/src/features/leaderboard/challenge-card.tsx';
const Card = loadTsx(CARD_PATH);
const CARD_SRC = fs.readFileSync(path.join(__dirname, '..', CARD_PATH), 'utf8');

const rail = (props) => renderToHtml(createElement(Card.ProgressRail, props));
const card = (view) => renderToHtml(createElement(Card.ChallengeCard, { view }));
const classOf = (html, marker) => {
  const m = html.match(new RegExp(`<[^>]*${marker}[^>]*class="([^"]*)"|<[^>]*class="([^"]*)"[^>]*${marker}`));
  return m ? (m[1] || m[2]) : '';
};

test('the rail is a progressbar; indeterminate rails omit aria-valuenow', () => {
  const counted = rail({ state: 'progress', label: '3/8 tried', fill: 0.375, name: 'Try apps', counted: true });
  assert.match(counted, /role="progressbar"/);
  assert.match(counted, /aria-valuenow="38"/);
  assert.match(counted, /aria-label="Try apps: 3\/8 tried"/);
  assert.match(counted, /aria-valuetext="3\/8 tried"/, 'the spoken value is the visible count, not a rounded percent');
  assert.match(counted, /style="width:max\(0\.375rem, 38%\)"/, 'the fill is drawn at the same fraction, never under the stub');
  assert.match(rail({ state: 'progress', label: '1/50 tried', fill: 1 / 50, name: 'x', counted: true }),
    /style="width:max\(0\.375rem, 2%\)"/, 'a first step is never narrower than none');

  const open = rail({ state: 'progress', label: 'Started', fill: null, name: 'Produce blocks' });
  assert.match(open, /role="progressbar"/);
  assert.doesNotMatch(open, /aria-valuenow/, 'no number to announce');
  assert.doesNotMatch(open, /style="width/, 'and no fill to draw');

  const zero = rail({ state: 'new', label: '0/3 Apps tried', fill: 0, name: 'Try Three Apps', counted: true });
  assert.match(zero, /aria-valuenow="0"/);
  assert.match(zero, /style="width:0\.375rem"/, 'a counted rail at zero draws the stub: a track not yet run');
  const yesNo = rail({ state: 'new', label: 'Not started', fill: 0, name: 'x' });
  assert.match(yesNo, /aria-valuenow="0"/);
  assert.doesNotMatch(yesNo, /style="width/, 'a yes-or-no rail is words alone');

  // #2492: block production used to reach the rail with an empty label and
  // draw the ring alone — a dot with nothing beside it. Its count rides on
  // the challenge row now, so the card asks for the same words as any other
  // uncounted challenge and the rail speaks them.
  const block = rail({ state: 'new', label: 'Not started', fill: 0, name: 'Produce your first block' });
  assert.match(block, /<span class="relative min-w-0 truncate">Not started<\/span>/, 'the label is drawn');
  assert.match(block, /aria-valuetext="Not started"/, 'and spoken');
  assert.match(block, /aria-label="Produce your first block: Not started"/, 'beside the challenge name');
  assert.doesNotMatch(block, /style="width/, 'an uncounted rail is words alone, with no bar');
  const done = rail({ state: 'done', label: 'Done', fill: 1, name: 'x', counted: true });
  assert.match(done, /aria-valuenow="100"/);
  assert.doesNotMatch(done, /style="width/, 'a finished rail is the green tone, not a full bar');
});

test('rail copy never wraps: the rail is one full-width row and its label truncates', () => {
  const html = rail({ state: 'progress', label: '180/500 blocks produced this week', fill: 0.36, name: 'x', counted: true });
  const railClass = classOf(html, 'role="progressbar"').split(' ');
  for (const cls of ['w-full', 'min-w-0', 'overflow-hidden', 'h-9', 'rounded-[0.6875rem]']) {
    assert.ok(railClass.includes(cls), `rail has ${cls}`);
  }
  assert.ok(!railClass.includes('rounded-lg'), 'the card rail takes the tile’s 11px, not the old 8px');
  assert.match(html, /<span class="relative min-w-0 truncate">180\/500 blocks produced this week<\/span>/,
    'the label is a single truncating line');
});

test('each state has its own rail tone, and only the accent/emerald/zinc scales', () => {
  const tones = ['new', 'progress', 'done'].map((state) =>
    classOf(rail({ state, label: 'l', fill: state === 'done' ? 1 : 0, name: 'x' }), 'role="progressbar"'));
  assert.equal(new Set(tones).size, 3, 'three distinct recipes');
  assert.match(tones[2], /bg-emerald-500\/10/);
  for (const t of tones) assert.doesNotMatch(t, /\b(gray|indigo)-/, 'no banned scales');
});

// ── The tile ──────────────────────────────────────────────────────────
//
// A template's illustration draws on its pale tone when the registry
// (frontend/src/lib/challenge-illustrations.ts) has the slug. Anything else —
// no slug, or one the registry does not know — is exactly the tile it was: a
// neutral face holding the kind's icon when the payload has one, else nothing.
const tile = (props) => renderToHtml(createElement(Card.ChallengeTile, props));
const NEUTRAL = 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100';
const KIND_ICON = '<span class="text-[2.5rem] leading-none">🧪</span>';

test('with no illustration the tile is the neutral face: the group headings carry the category', () => {
  const html = tile({});
  assert.match(html, /h-20 w-20 /, 'the xl IconTile');
  const plainFace = classOf(html, 'aria-hidden="true"').split(' ');
  assert.ok(plainFace.includes('rounded-[0.6875rem]'), 'with the card’s concentric 11px corners');
  assert.ok(!plainFace.includes('rounded-2xl'), 'which displace the size’s own radius rather than layer on it');
  assert.ok(html.includes(NEUTRAL), 'the neutral face');
  assert.match(html, /aria-hidden="true"/, 'decorative');
  assert.doesNotMatch(html, /<span|<img/, 'no category text and no artwork inside it');
  assert.equal(tile({ illustration: null }), html, 'a null slug is the same tile');
  const home = tile({ icon: '🧪' });
  assert.ok(home.includes(NEUTRAL) && home.includes(KIND_ICON), 'the kind icon stays on the neutral face');
});

test('a registry illustration draws in the tile, on its pale tone in both themes', () => {
  const html = tile({ icon: '🧪', illustration: 'try-three-apps' });
  assert.match(html, /<img src="\/illustrations\/challenges\/try-three-apps\.svg" alt="" draggable="false" class="object-contain"\/>/,
    'a same-origin static file, decorative, not draggable, fitted rather than stretched');
  const face = classOf(html, 'aria-hidden="true"').split(' ');
  for (const c of ['h-20', 'w-20', 'home-tone-mint', 'bg-[var(--tint-art)]', 'dark:bg-[var(--tint-art)]']) {
    assert.ok(face.includes(c), `the tile has ${c}`);
  }
  for (const c of ['bg-zinc-100', 'dark:bg-zinc-800']) {
    assert.ok(!face.includes(c), `the neutral ${c} is displaced, not layered under the tone`);
  }
  assert.ok(face.includes('rounded-[0.6875rem]') && !face.includes('rounded-2xl'), 'the artwork face has the same 11px corners');
  assert.ok(!html.includes('🧪'), 'the artwork takes the kind icon’s place');
  const view = { goal: 'Send feedback', reward: null, icon: null, illustration: 'useful-feedback', state: 'new', stateLabel: 'Not started', fill: 0, earned: null };
  const onCard = card(view);
  assert.match(onCard, /class="[^"]*home-tone-orange[^"]*"[^>]*><img src="\/illustrations\/challenges\/useful-feedback\.svg"/,
    'the card threads its view’s slug to the tile, with that artwork’s tone');
});

// An admin upload: slug `u-` plus the 32-hex file id, the path DERIVED from
// it, and the tone the payload sends beside it. A built-in ignores a tone.
const HEX = '0123456789abcdef0123456789abcdef';
const UPLOADED = `u-${HEX}`;
const faceOf = (html) => classOf(html, 'aria-hidden="true"').split(' ');

test('an uploaded illustration draws from its derived path, on the payload tone', () => {
  const html = tile({ icon: '🧪', illustration: UPLOADED, illustrationTone: 'teal' });
  assert.ok(html.includes(`<img src="/challenge-illustrations/${HEX}" alt="" draggable="false" class="object-contain"/>`),
    'the same <img>, from the path the slug derives, fitted so a non-square upload is not stretched');
  const face = faceOf(html);
  for (const c of ['home-tone-teal', 'bg-[var(--tint-art)]', 'dark:bg-[var(--tint-art)]']) {
    assert.ok(face.includes(c), `the tile has ${c}`);
  }
  assert.ok(!html.includes('🧪'), 'the upload takes the kind icon’s place too');

  for (const illustrationTone of [undefined, null, 'magenta', 'Teal', 42]) {
    const plain = faceOf(tile({ illustration: UPLOADED, illustrationTone }));
    assert.ok(plain.includes('home-tone-gray'), `${String(illustrationTone)}: an upload without a known tone is on gray`);
  }
  assert.ok(faceOf(tile({ illustration: 'try-three-apps', illustrationTone: 'coral' })).includes('home-tone-mint'),
    'a built-in keeps its own tone whatever the payload says');

  const view = { goal: 'Send feedback', reward: null, icon: null, illustration: UPLOADED, illustrationTone: 'pink', state: 'new', stateLabel: 'Not started', fill: 0, earned: null };
  assert.match(card(view), new RegExp(`class="[^"]*home-tone-pink[^"]*"[^>]*><img src="/challenge-illustrations/${HEX}"`),
    'the card threads its view’s tone to the tile');
});

test('a slug the registry does not have is the tile it was, never a guessed path', () => {
  const NOT_SLUGS = [
    'not-in-the-registry', '../icons/x', 'Try-Three-Apps', '', 42,
    'u-XYZ', `u-${HEX.slice(1)}`, `u-${HEX.toUpperCase()}`, `u-${HEX}0`, `u-../${HEX}`,
  ];
  for (const illustration of NOT_SLUGS) {
    assert.equal(tile({ illustration }), tile({}), `${String(illustration)}: the empty face`);
    assert.equal(tile({ icon: '🧪', illustration }), tile({ icon: '🧪' }), `${String(illustration)}: the kind icon`);
    assert.equal(tile({ illustration, illustrationTone: 'teal' }), tile({}), `${String(illustration)}: a tone draws nothing alone`);
  }
});

test('artwork that fails to load puts back the tile it replaced, through state', () => {
  // onError cannot fire in a static render, so this half is the source.
  const fn = CARD_SRC.slice(CARD_SRC.indexOf('export function ChallengeTile('), CARD_SRC.indexOf('export type ChallengeCardView'));
  assert.ok(fn.length > 0, 'ChallengeTile located');
  assert.match(fn, /resolveIllustration\(illustration, illustrationTone\)/, 'the tile resolves with the payload tone');
  assert.match(fn, /onError=\{\(\) => setFailed\(art\.src\)\}/);
  assert.match(fn, /if \(art && failed !== art\.src\) \{/, 'a failed file falls through to the neutral tile');
  assert.doesNotMatch(fn, /currentTarget|\.style\.|\.remove\(\)/, 'no write to the node: the card is a React island');
});

const META_OPEN = '<div class="flex min-w-0 items-baseline gap-1.5 text-[0.8125rem] leading-5">';
const DEADLINE = (t) => `<span class="shrink-0 text-zinc-500 dark:text-zinc-400">${t}</span>`;
const DOT = '<span aria-hidden="true" class="shrink-0 text-zinc-400 dark:text-zinc-500">·</span>';
const REWARD = (t) => `<span class="min-w-0 truncate font-medium text-amber-800 dark:text-amber-300">${t}</span>`;
const EARNED = (t) => `<span class="min-w-0 truncate font-medium text-emerald-700 dark:text-emerald-400">${t}</span>`;

test('ChallengeCard is one card for both surfaces: tile, title, meta line and a clean rail', () => {
  const view = {
    goal: 'Try apps', task: 'Open three apps', reward: '500 pts', icon: '🧪',
    state: 'progress', stateLabel: '2/3 tried', fill: 2 / 3, counted: true, deadline: '5d left', earned: null,
  };
  const html = renderToHtml(createElement(Card.ChallengeCard, {
    view, className: 'home-challenge-card', 'data-challenge-id': '7',
  }));
  assert.match(html, /^<div class="home-challenge-card flex items-center gap-3 bg-white/, 'the surface class leads');
  assert.match(html, /data-challenge-id="7"/);
  assert.match(html, />🧪<\/span>/, 'the kind icon sits in the tile');
  assert.doesNotMatch(html, /Open three apps/, 'the card holds no description, even when handed one');
  assert.doesNotMatch(html, /<p /);
  assert.doesNotMatch(html, /title=/, 'no tooltips');

  // Title, then ONE meta line — the deadline beside the reward.
  assert.ok(html.includes(
    '<div class="min-w-0"><div class="truncate text-base font-medium leading-6 text-zinc-900 dark:text-zinc-100">Try apps</div>'
    + `${META_OPEN}${DEADLINE('5d left')}${DOT}${REWARD('500 pts')}</div></div>`),
  'the title, then "5d left · 500 pts" on one line');

  // Title and rail are one group, centred beside the tile rather than
  // stretched to its edges, and the rail is the group's last row.
  assert.match(html, /<div class="flex min-w-0 flex-1 flex-col gap-2">/);
  assert.doesNotMatch(html, /justify-between|self-stretch/);
  const railAt = html.indexOf('role="progressbar"');
  assert.ok(html.indexOf('500 pts') < railAt, 'the reward is above the rail');
  assert.doesNotMatch(html.slice(railAt), /pts/, 'the rail holds the state and nothing else');
  assert.doesNotMatch(html.slice(html.indexOf('flex min-w-0 flex-1 flex-col')), /flex-wrap|p-0\.5|bg-zinc-100/,
    'no capsule around the rail (the tile keeps its own neutral face)');
  assert.match(html, /aria-valuetext="2\/3 tried"/);
  assert.match(html, /style="width:max\(0\.375rem, 67%\)"/);
});

test('the meta line drops what it does not have, and never holds a stray dot', () => {
  const base = { goal: 'Try Three Apps', icon: null, state: 'new', stateLabel: 'Not started', fill: 0, earned: null };
  const rewardOnly = card({ ...base, reward: '500 pts', deadline: null });
  assert.ok(rewardOnly.includes(`${META_OPEN}${REWARD('500 pts')}</div>`), 'no deadline: the reward alone');
  const deadlineOnly = card({ ...base, reward: null, deadline: '23h left' });
  assert.ok(deadlineOnly.includes(`${META_OPEN}${DEADLINE('23h left')}</div>`), 'no reward: the deadline alone');
  const neither = card({ ...base, reward: null, deadline: null });
  assert.doesNotMatch(neither, /items-baseline/, 'neither: no meta line at all');
  assert.doesNotMatch(neither, /·/);

  const done = card({
    ...base, state: 'done', stateLabel: 'Done', fill: 1, counted: true,
    reward: '900 pts', earned: 'Earned 900 pts', deadline: null,
  });
  assert.ok(done.includes(`${META_OPEN}${EARNED('Earned 900 pts')}</div>`),
    'a finished challenge says what was earned, in emerald, with no deadline');
  assert.doesNotMatch(done, /text-amber-800/, 'not the reward on offer');
  assert.doesNotMatch(done, /style="width/, 'and its rail draws no bar');

  const zero = card({ ...base, stateLabel: '0/3 Apps tried', counted: true, reward: '500 pts', deadline: '17d left' });
  assert.match(zero, /style="width:0\.375rem"/, 'the stub at 0 of 3');
  assert.match(zero, />0\/3 Apps tried</);
});

test('the detail page draws the same rail and meta line at page size', () => {
  const lg = classOf(rail({ state: 'progress', label: '180/500 blocks', fill: 0.36, name: 'x', counted: true, size: 'lg' }),
    'role="progressbar"').split(' ');
  for (const c of ['h-10', 'text-[0.9375rem]', 'rounded-[0.75rem]', 'w-full', 'min-w-0', 'overflow-hidden']) {
    assert.ok(lg.includes(c), `lg rail has ${c}`);
  }
  assert.ok(!lg.includes('h-9') && !lg.includes('rounded-[0.6875rem]'), 'one size, not both');
  const meta = renderToHtml(createElement(Card.ChallengeMeta, { deadline: '3d left', text: '720 pts so far', size: 'lg' }));
  assert.equal(meta, `<div class="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">${DEADLINE('3d left')}${DOT}${REWARD('720 pts so far')}</div>`);
  assert.equal(renderToHtml(createElement(Card.ChallengeMeta, { text: 'Earned 900 pts', earned: true })),
    `${META_OPEN}${EARNED('Earned 900 pts')}</div>`, 'the card size is the card’s line, unchanged');
  assert.equal(renderToHtml(createElement(Card.ChallengeMeta, {})), '', 'nothing to say, no line');
});

test('a card that opens something is a keyboard-reachable button, so it takes the kit press (#1918)', () => {
  const view = { goal: 'Try Three Apps', reward: '500 pts', state: 'new', stateLabel: 'Not started', fill: 0, earned: null };
  const tappable = renderToHtml(createElement(Card.ChallengeCard, { view, onClick: () => {} }));
  assert.match(tappable, /^<div[^>]*role="button"/, 'the card root carries the role the native kit presses');
  assert.match(tappable, /^<div[^>]*tabindex="0"/, 'and is in the tab order');
  const inert = card(view);
  assert.doesNotMatch(inert, /role="button"|tabindex/, 'a card with nothing to open stays a plain div');

  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.tc-se-card\[role="button"\]:active,\s*\.home-challenge-card\[role="button"\]:active \{\s*transition: transform 0s linear 120ms, filter 0s linear 120ms;/,
    'on touch the press waits a beat, so a scroll that starts on a card does not flash it');
});

test('Enter and Space open a focused card like a tap (#1918)', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend', 'src', 'features', 'leaderboard', 'challenge-card.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('export function ChallengeCard('));
  assert.match(fn, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(fn, /e\.target !== e\.currentTarget/, 'a key pressed inside the card is left to its own target');
  assert.match(fn, /e\.currentTarget\.click\(\)/);
});

// ── Corners ───────────────────────────────────────────────────────────
//
// Owner decision (2026-09-15, option B): the card is 24px, and the tile and
// the rail inside it are 11px, which is 24px less the card's 12px padding and
// 1px border, so the three shapes are concentric.
test('the card’s corners are 24px and the tile and rail inside it are concentric at 11px', () => {
  const html = card({ goal: 'Try three apps', reward: '500 pts', state: 'progress', stateLabel: '1/3 tried', fill: 1 / 3, counted: true, earned: null });
  const root = html.match(/^<div class="([^"]*)"/)[1].split(' ');
  assert.ok(root.includes('rounded-3xl') && !root.includes('rounded-2xl'), 'the card is rounded-3xl (1.5rem)');
  const face = classOf(html, 'aria-hidden="true"').split(' ');
  assert.ok(face.includes('h-20') && face.includes('rounded-[0.6875rem]'), 'the tile is 11px');
  assert.ok(classOf(html, 'role="progressbar"').split(' ').includes('rounded-[0.6875rem]'), 'the rail is 11px');
  assert.match(CARD_SRC, /const TILE_RADIUS = 'rounded-\[0\.6875rem\]';/, 'one complete literal the compiler can find');
});
