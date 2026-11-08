// The frame primitives of the one-frame redesign (docs/superpowers/specs/
// 2026-11-08-one-frame-glass-spec.md): PageFrame, Columns, Group and the
// buttons in frontend/@/components/ui/frame.tsx; StatusPill, Track and
// StatusRow in status.tsx. Rendered to strings (tests/lib/render-tsx.js)
// and asserted on what a viewer gets: order, tones, the words, and that a
// zero says nothing.
//
// Run with: node --test tests/frame-primitives.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/@/components/ui/frame.tsx';
const STATUS = 'frontend/@/components/ui/status.tsx';

// ── frame.tsx ────────────────────────────────────────────────────────────

test('PageFrame draws title, purpose and one primary action in that order', () => {
  const html = renderComponent(FRAME, 'PageFrame', {
    title: 'Home', purpose: 'What needs you, then your places.', primary: 'Make a project', children: 'body',
  });
  const h1 = html.indexOf('<h1');
  const purpose = html.indexOf('What needs you');
  const primary = html.indexOf('Make a project');
  const body = html.indexOf('body');
  assert.ok(h1 > -1 && h1 < purpose && purpose < primary && primary < body, html);
  assert.match(html, /<h1[^>]*class="[^"]*text-\[28px\] md:text-\[36px\][^"]*font-bold[^"]*tracking-\[-0\.035em\]/);
  assert.match(html, /<p[^>]*class="[^"]*text-\[17px\][^"]*text-\[color:var\(--mut\)\]/);
});

test('PageFrame without a purpose or a primary action draws neither', () => {
  const html = renderComponent(FRAME, 'PageFrame', { title: 'Settings', children: 'body' });
  assert.doesNotMatch(html, /<p/);
  assert.doesNotMatch(html, /<button/);
});

test('Columns are 720 and 320 from md, one column before, side after main', () => {
  const html = renderComponent(FRAME, 'Columns', { main: 'MAIN', side: 'SIDE' });
  assert.match(html, /md:grid-cols-\[minmax\(0,720px\)_320px\]/);
  assert.ok(html.indexOf('MAIN') < html.indexOf('SIDE'));
  const first = renderComponent(FRAME, 'Columns', { main: 'MAIN', side: 'SIDE', sideFirst: true });
  assert.match(first, /order-first md:order-none/, 'sideFirst puts the side column above on a phone only');
});

test('Columns without a side column is one 720px column', () => {
  const html = renderComponent(FRAME, 'Columns', { main: 'MAIN' });
  assert.doesNotMatch(html, /md:grid-cols-\[minmax\(0,720px\)_320px\]/);
  assert.match(html, /max-w-\[720px\]/);
});

test('Group is a label over one glass surface', () => {
  const html = renderComponent(FRAME, 'Group', { label: 'Needs you', children: 'rows', id: 'g1' });
  assert.match(html, /<h2[^>]*>Needs you<\/h2>/);
  assert.match(html, /id="g1"/);
  assert.match(html, /rounded-\[24px\] bg-\[color:var\(--surface\)\] \[backdrop-filter:var\(--glass-blur\)\] shadow-\[inset_0_0_0_1px_var\(--ring\),var\(--glow\)\]/);
  assert.ok(html.indexOf('Needs you') < html.indexOf('rows'));
});

test('PrimaryButton is the accent, QuietButton the surface', () => {
  assert.match(renderComponent(FRAME, 'PrimaryButton', { children: 'Vote' }),
    /<button type="button" class="[^"]*rounded-full bg-\[color:var\(--acc\)\] text-\[color:var\(--acc-ink\)\]/);
  assert.match(renderComponent(FRAME, 'QuietButton', { children: 'Join' }),
    /<button type="button" class="[^"]*bg-\[color:var\(--surface\)\] text-\[color:var\(--ink\)\] shadow-\[inset_0_0_0_1px_var\(--ring\)\]/);
});

// ── status.tsx ───────────────────────────────────────────────────────────

test('StatusPill colours by tone', () => {
  assert.match(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: 'Vote' }),
    /data-tone="you"[^>]*class="[^"]*bg-\[color:var\(--acc\)\] text-\[color:var\(--acc-ink\)\]/);
  assert.match(renderComponent(STATUS, 'StatusPill', { tone: 'done', children: 'Live' }),
    /data-tone="done"[^>]*class="[^"]*bg-\[color:var\(--ok-t\)\] text-\[color:var\(--ok\)\]/);
  assert.match(renderComponent(STATUS, 'StatusPill', { tone: 'waiting', children: 'Checks' }),
    /data-tone="waiting"[^>]*class="[^"]*bg-\[color:var\(--wait-t\)\] text-\[color:var\(--wait\)\]/);
  assert.match(renderComponent(STATUS, 'StatusPill', { tone: 'problem', children: 'Failed' }),
    /data-tone="problem"[^>]*class="[^"]*bg-\[color:var\(--bad-t\)\] text-\[color:var\(--bad\)\]/);
  const none = renderComponent(STATUS, 'StatusPill', { tone: 'none', children: 'Joined' });
  assert.match(none, /data-tone="none"/);
  assert.doesNotMatch(none, /bg-\[/, 'a settled thing gets no fill');
});

test('StatusPill says nothing for zero or an empty status', () => {
  assert.equal(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: 0 }), '');
  assert.equal(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: '' }), '');
  assert.equal(renderComponent(STATUS, 'StatusPill', { tone: 'you', children: null }), '');
});

test('Track marks done, now and todo around the stage, in the five words', () => {
  const html = renderComponent(STATUS, 'Track', { stage: 3 });
  assert.equal((html.match(/data-state="done"/g) || []).length, 3);
  assert.match(html, /data-stage="vote"[^>]*data-state="now"/);
  assert.match(html, /data-stage="live"[^>]*data-state="todo"/);
  for (const word of ['Plan', 'Build', 'Checks', 'Vote', 'Live']) assert.ok(html.includes(word), word);
  assert.ok(html.indexOf('Plan') < html.indexOf('Build') && html.indexOf('Vote') < html.indexOf('Live'));
});

test('Track shows waiting and a problem on the current stage, and mini hides the words', () => {
  assert.match(renderComponent(STATUS, 'Track', { stage: 2, waiting: true }), /data-stage="checks"[^>]*data-state="wait"/);
  assert.match(renderComponent(STATUS, 'Track', { stage: 2, problem: true }), /data-stage="checks"[^>]*data-state="problem"/);
  const mini = renderComponent(STATUS, 'Track', { stage: 4, mini: true });
  assert.match(mini, /w-16/);
  assert.match(mini, /sr-only/);
});

test('StatusRow is a ListRow with the status as its one pill', () => {
  const html = renderComponent(STATUS, 'StatusRow', { title: 'Pourover Coffee', subtitle: '2 in progress', status: '1 to vote', tone: 'you' });
  assert.match(html, /min-h-\[64px\]/);
  assert.match(html, /Pourover Coffee/);
  assert.match(html, /data-tone="you"[^>]*>1 to vote</);
  assert.ok(html.indexOf('Pourover Coffee') < html.indexOf('1 to vote'));
  const single = renderComponent(STATUS, 'StatusRow', { title: 'Game Corner', status: 'Joined', tone: 'none' });
  assert.match(single, /min-h-\[50px\]/);
});

test('the primitives use logical spacing only', () => {
  for (const f of ['frame.tsx', 'status.tsx']) {
    assert.doesNotMatch(read('frontend', '@', 'components', 'ui', f), /\b(pl|pr|ml|mr)-/, `${f} uses ps-/pe-/ms-/me-`);
  }
});

test('the track words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'changes.json'));
  for (const k of ['track.plan', 'track.build', 'track.checks', 'track.vote', 'track.live']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
  }
});
