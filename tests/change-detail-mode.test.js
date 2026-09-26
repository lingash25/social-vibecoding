// #2841 / #2842 — a change page opens with Basic details; "Advanced details"
// reveals the technical half, and the choice is remembered per viewer. The
// Discussion says it is a conversation with people, and names the way to
// keep building with the AI agent.
//
// The page is rendered the way tests/needs-you-change-page.test.js renders
// it: app-view.js builds the view model in a vm, and topic/topic-head.tsx
// draws it through react-dom/server. The stored preference is read when the
// bundle evaluates, so the Advanced render loads the bundle with a
// localStorage that holds it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const HEAD = 'frontend/src/features/dev-board/topic/topic-head.tsx';
const MODE = 'frontend/src/features/dev-board/topic/detail-mode.ts';
const CONVERSATION = 'frontend/src/features/dev-board/topic/conversation.tsx';

function context(user = { id: 42, username: 'Builder' }, { readOnly = false } = {}) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  // `readOnly` is a getter over the app's collaborate flag.
  c.av.appData = { slug: 'example', can_collaborate: !readOnly };
  c.av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  c.av._ghIssues = [];
  return c.av;
}

const PR = {
  id: 4090, user_id: 7, username: 'maya', status: 'promoted', source: 'native',
  pr_number: 12, pr_url: 'https://github.com/example/app/pull/12', pr_title: 'Authenticate previews',
  pr_summary_md: 'Previews wait for sign-in.', pr_body: 'The PR body: **technical prose**.',
  linked_issues: [], yes_count: 1, no_count: 0, votes_required: 2,
  created_at: '2026-09-11T12:00:00Z', staging_url: 'https://preview.example', check_state: 'failing',
  checks_checked_at: '2026-09-18T12:00:00Z',
  test_results: [
    { name: 'Home loads', path: '/', status: 'fail', reason: 'boom' },
    { name: 'Board loads', path: '/board', status: 'pass' },
  ],
  freshness: { mergeability: 'clean', behindBy: 0, checkedAt: '2026-09-18T12:00:00Z' },
};

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

/** Evaluate the bundle with `window.localStorage` set, as a browser would. */
function loadWithStorage(entry, storage) {
  const had = Object.hasOwn(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { localStorage: storage };
  try {
    return loadTsx(entry);
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

/** Render as the page does, with `window.AppView` the one that built the model. */
function render(av, item, mod = loadTsx(HEAD)) {
  const v = av._topicViewFor('proposal', item);
  const had = Object.hasOwn(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AppView: av };
  try {
    return { v, html: renderToHtml(createElement(mod.ChangeDetail, { card: v.card, body: v.body, item, conversation: true })) };
  } finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

test('a change page opens Basic: the switch is off, and the pull request link and technical description are not drawn', () => {
  const { html } = render(context(), PR);
  assert.match(html, /<div class="dev-topic" data-detail-mode="basic">/);
  assert.match(html, /<div class="dev-topic-detail-mode" data-detail-toggle="4090"><label for="dev-topic-detail-mode-4090" class="dev-topic-detail-mode-label"><input id="dev-topic-detail-mode-4090" role="switch" aria-describedby="dev-topic-detail-mode-4090-hint" type="checkbox" class="un-switch"\/><span>Advanced details<\/span><\/label>/);
  assert.doesNotMatch(html, /checked=""/, 'the switch starts off');
  assert.match(html, /<span class="dev-ws-eyebrow dev-topic-hero-eyebrow">Proposal · In review<\/span>/, 'the eyebrow keeps the state, not the PR link');
  assert.doesNotMatch(html, /github\.com\/example\/app\/pull\/12/);
  assert.doesNotMatch(html, />Technical details<\/summary>/);
  // What a voter needs stays: the title, the summary, the vote, the preview,
  // and each step's sentence.
  assert.match(html, /dev-topic-hero-title">Authenticate previews</);
  assert.match(html, /Previews wait for sign-in\./);
  assert.match(html, /data-vote-btn="open"/);
  assert.match(html, /gc-vote-btn-preview/);
  assert.match(html, /<span class="dev-ledger-lead dev-ledger-lead-bad">Failing\.<\/span>/);
  // The per-check nodes stay in the document for Advanced (and for the
  // declared checks that select on them); app.css hides them in Basic.
  assert.match(html, /class="dev-ledger-fails"/);
  assert.match(html, /class="dev-ledger-passes"/);
});

test('Advanced details: the stored choice draws the switch on, the pull request link, and the technical description inline', () => {
  const mod = loadWithStorage(HEAD, fakeStorage({ 'homeroom.changeDetailMode': 'advanced' }));
  const { html } = render(context(), PR, mod);
  assert.match(html, /<div class="dev-topic" data-detail-mode="advanced">/);
  assert.match(html, /<input id="dev-topic-detail-mode-4090" role="switch"[^>]*type="checkbox" class="un-switch" checked=""\/>/);
  assert.match(html, /Proposal · <a href="https:\/\/github\.com\/example\/app\/pull\/12" target="_blank" rel="noopener">PR#12<\/a>/);
  assert.match(html, /<summary class="dev-topic-details-summary">Technical details<\/summary>/);
  assert.match(html, /technical prose/);
  // The technical description sits in the hero, after the switch.
  assert.ok(html.indexOf('data-detail-toggle="4090"') < html.indexOf('>Technical details</summary>'));
  assert.ok(html.indexOf('>Technical details</summary>') < html.indexOf('dev-topic-sheet dev-topic-steps'));
});

test('the preference is remembered per viewer, and a stale or unreadable one reads as Basic', () => {
  const mode = loadTsx(MODE);
  const s = fakeStorage();
  assert.equal(mode.readDetailMode(s), 'basic', 'nothing stored → Basic');
  mode.writeDetailMode('advanced', s);
  assert.equal(s.data['homeroom.changeDetailMode'], 'advanced');
  assert.equal(mode.readDetailMode(s), 'advanced');
  mode.writeDetailMode('basic', s);
  assert.equal(mode.readDetailMode(s), 'basic');
  for (const stale of ['Advanced', 'true', '1', '{"mode":"advanced"}', '']) {
    assert.equal(mode.readDetailMode(fakeStorage({ 'homeroom.changeDetailMode': stale })), 'basic', `${stale} → Basic`);
  }
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  assert.equal(mode.readDetailMode(throwing), 'basic');
  assert.doesNotThrow(() => mode.writeDetailMode('advanced', throwing));
  assert.equal(mode.readDetailMode(null), 'basic');
});

test('setDetailMode stores the choice and moves every mounted page with it', () => {
  const storage = fakeStorage();
  const mode = loadWithStorage(MODE, storage);
  const had = Object.hasOwn(globalThis, 'window');
  globalThis.window = { localStorage: storage };
  try {
    let seen = 0;
    const off = mode.detailModeStore.subscribe(() => { seen += 1; });
    mode.setDetailMode('advanced');
    assert.equal(mode.detailModeStore.get().mode, 'advanced');
    assert.equal(storage.data['homeroom.changeDetailMode'], 'advanced');
    assert.equal(seen, 1);
    off();
  } finally {
    if (!had) delete globalThis.window;
  }
});

test('Basic hides the per-check rows and the build pipeline by CSS, and keeps the explaining lines and their lists', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  const rule = css.match(/((?:\.dev-topic\[data-detail-mode="basic"\][^,{]+,\s*)+\.dev-topic\[data-detail-mode="basic"\][^,{]+)\{\s*display:\s*none;\s*\}/);
  assert.ok(rule, 'one display:none rule scoped to Basic');
  const hidden = rule[1].split(',').map((s) => s.trim());
  for (const cls of ['.dev-ledger-progress-build', '.dev-ledger-progress-unit',
    '.dev-step-body > .dev-ledger-fails', '.dev-ledger-passes']) {
    assert.ok(hidden.some((s) => s.endsWith(cls)), `${cls} is hidden in Basic`);
  }
  for (const s of hidden) assert.match(s, /^\.dev-topic\[data-detail-mode="basic"\] \.dev-topic-steps /, `${s} is scoped to the steps sheet`);
  // The sentence and the lines that explain it are what Basic is FOR.
  // `.dev-ledger-list` is what a foot line introduces — the unset variables
  // a merge waits on (`_platformEnvNote`), the files changed on both sides —
  // and a voter or an admin acts on it.
  for (const keep of ['.dev-ledger-text', '.dev-ledger-foot', '.dev-ledger-list', '.dev-step-vote', '.dev-ledger-ops', '.dev-ledger-review-line']) {
    assert.ok(!hidden.some((s) => s.endsWith(keep)), `${keep} stays visible in Basic`);
  }
});

test('the Discussion is labelled as the group’s, not the AI agent’s, and offers another viewer the dev chat', () => {
  const { html } = render(context(), PR);
  assert.match(html, /<h4 class="dev-topic-h">Discussion with the group<\/h4>/);
  assert.match(html, /<p class="dev-topic-note dev-conversation-audience">Visible to the group<span class="dev-conversation-people"> · Messages here go to people, not to the AI agent\.<\/span><\/p>/);
  assert.match(html, /<p class="dev-topic-note dev-conversation-agent" data-agent-door="explore"><span>To change the code, work with the AI agent:<\/span><button[^>]*>Explore in dev chat<\/button><\/p>/);
});

test('the author is offered their own build, and a read-only viewer no agent door at all', () => {
  const own = render(context({ id: 7, username: 'maya' }), PR).html;
  assert.match(own, /data-agent-door="build"><span>To change the code, work with the AI agent:<\/span><button[^>]*>Open build<\/button>/);
  const ro = render(context(undefined, { readOnly: true }), PR).html;
  assert.match(ro, /Messages here go to people, not to the AI agent\./);
  assert.doesNotMatch(ro, /data-agent-door/);
  // The author who has lost collaboration keeps the band's (read-only)
  // Build door, but is not told to change the code through it.
  const roOwner = render(context({ id: 7, username: 'maya' }, { readOnly: true }), PR).html;
  assert.doesNotMatch(roOwner, /data-agent-door/);
});

test('flipping the switch stores the choice: on is Advanced, off is Basic', () => {
  const storage = fakeStorage();
  const mod = loadWithStorage(HEAD, storage);
  const had = Object.hasOwn(globalThis, 'window');
  globalThis.window = { localStorage: storage };
  try {
    // The toggle's element tree: the label holds the Switch whose onChange
    // is the one the page wires. Invoke it the way a click would.
    const find = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (pred(node)) return node;
      const kids = [].concat(node.props?.children || []);
      for (const k of kids) { const hit = find(k, pred); if (hit) return hit; }
      return null;
    };
    const tree = mod.DetailModeToggle({ id: 4090, advanced: false });
    const input = find(tree, (n) => n.props && n.props.role === 'switch');
    assert.ok(input, 'the switch is in the toggle');
    assert.equal(input.props.checked, false);
    input.props.onChange({ currentTarget: { checked: true } });
    assert.equal(storage.data['homeroom.changeDetailMode'], 'advanced');
    input.props.onChange({ currentTarget: { checked: false } });
    assert.equal(storage.data['homeroom.changeDetailMode'], 'basic');
    const on = find(mod.DetailModeToggle({ id: 4090, advanced: true }), (n) => n.props && n.props.role === 'switch');
    assert.equal(on.props.checked, true);
  } finally {
    if (!had) delete globalThis.window;
  }
});

test('agentDoor: the owner’s Build door, else Explore, never the read-only “Read the build”', () => {
  const { agentDoor } = loadTsx(CONVERSATION);
  const build = { key: 'build', label: 'Continue building', act: { fn: 'openChangeWorkspace', args: [1] } };
  const explore = { key: 'explore', label: 'Explore in dev chat', explore: 1, act: { fn: 'exploreProposalInDevChat', args: [1, null] } };
  assert.equal(agentDoor({ actions: [build, explore] }, { build: { kind: 'owner', label: 'Continue building' } }), build);
  assert.equal(agentDoor({ actions: [{ ...build, label: 'Read the build' }, explore] }, { build: { kind: 'published', label: 'Read the build' } }), explore);
  assert.equal(agentDoor({ actions: [{ ...build, label: 'Read the build' }] }, { build: { kind: 'published', label: 'Read the build' } }), null);
  assert.equal(agentDoor({ actions: [] }, { build: null }), null);
  assert.equal(agentDoor(null, {}), null);
});
