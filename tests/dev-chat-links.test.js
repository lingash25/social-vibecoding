'use strict';

// #6016: the links in a dev chat open the right thing, whether the chat was
// opened from Messages (no app view up: `App.currentApp` is null) or from the
// project's own page (`App.currentApp` names the app, so `AppView.openTopic`
// opens it in place). #5944 was the Messages half: `openTopic` rendered the
// page into the hidden app screen and nothing on screen moved.
//
// The real dev-chat.js runs in a vm beside the real app-view.js, with the
// shipped link reader (tests/lib/repo-link.js), a real Marked instance and a
// pass-through DOMPurify — so the agent reply's `PR#9`, `#14` and commit
// address are chipped and linked by the code the browser runs.
//
// Run with: node --test tests/dev-chat-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('marked');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { makeTranscriptBridge } = require('./lib/dev-transcript-html');
const { installRepoLink } = require('./lib/repo-link');
const { makeHtmlDocument } = require('./lib/html-dom');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'), 'utf8'
);

// `linkRefsInHtml` (messages/channels.ts, bundled into the transcript) reads
// the document to chip a reply's refs. The transcript is rendered in this
// realm, so this realm needs one.
globalThis.document = makeHtmlDocument();

const SESSION = {
  id: 41, app_slug: 'demo-app', pr_number: 90,
  status: 'promoted', check_state: 'passing', proposal_state: 'ready',
};

/** A DevChat harness; `currentApp` is the app view's app, or null in Messages. */
function makeDevChat({ currentApp = null } = {}) {
  const t = makeTranscriptBridge();
  const topics = [];
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  const messagesEl = {
    innerHTML: '',
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
  };
  const sandbox = {
    console,
    location: { search: '', hash: '' },
    URLSearchParams,
    App: { user: { id: 1, username: 'alice' }, currentApp, currentTab: currentApp ? 'dev' : 'messages' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent() {},
    encodeURIComponent,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: () => {},
      alert: async () => ({}),
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.UsernodeReact = { devChat: t.bridge };
  sandbox.PlatformI18n = englishPlatformI18n();
  // The shipped link reader, and the real markdown pipeline: a pass-through
  // sanitizer keeps marked's own anchors, which is what a reply's commit
  // address becomes.
  installRepoLink(sandbox);
  sandbox.marked = new Marked();
  sandbox.DOMPurify = {
    addHook: () => {}, removeHook: () => {}, removeAllHooks: () => {},
    sanitize: (html) => html,
  };
  vm.createContext(sandbox);
  // The card's vote badge (and the proposal link it carries) comes from the
  // shared lifecycle helper.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/merge-status.js'), 'utf8'), sandbox);
  vm.runInContext(`${fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8')}\n;globalThis.AppView = AppView;`, sandbox);
  sandbox.AppView._renderTopicHead = () => {};
  sandbox.AppView._loadDevData = async () => {};
  sandbox.AppView.openTopic = (...args) => { topics.push(args); };
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  return {
    DevChat, sandbox, topics,
    html() { DevChat.renderMessages(); return t.html(); },
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || null;
      return this.html();
    },
  };
}

/** The ids the rendered card itself carries. */
function ids(html) {
  const vote = html.match(/data-open-vote="(\d+)"/);
  const chip = html.match(/data-issue-chip="(\d+)"/);
  return { vote: vote ? Number(vote[1]) : null, chip: chip ? Number(chip[1]) : null };
}

function cardHarness(currentApp) {
  const h = makeDevChat({ currentApp });
  const session = { ...SESSION, linked_issues: [12] };
  const html = h.render([{ role: 'system', content: 'Changes ready.', changesReady: true }], session);
  const got = ids(html);
  assert.ok(got.vote > 0, 'the card carries the proposal id it opens');
  assert.equal(got.chip, 12, 'the card carries the request chip "Closes #12"');
  return { h, session, got };
}

for (const [name, currentApp] of [['Messages', null], ['the project page', 'demo-app']]) {
  test(`in ${name}, the proposal badge opens the change page`, () => {
    const { h, got } = cardHarness(currentApp);
    h.DevChat.openProposalVote(got.vote);
    if (currentApp) {
      assert.deepEqual(h.topics, [['proposal', got.vote]], 'openTopic opens it in place');
      assert.equal(h.sandbox.location.hash, '', 'and the address does not move');
    } else {
      assert.deepEqual(h.topics, [], 'no app view is up to open it in');
      assert.equal(h.sandbox.location.hash, '#app/demo-app/dev/changes/90',
        'the change page own address is followed, with its pull request number');
    }
  });

  test(`in ${name}, a proposal with no pull request opens by its proposal id`, () => {
    const h = makeDevChat({ currentApp });
    h.DevChat.currentSession = { id: 51, app_slug: 'demo-app', pr_number: null };
    h.DevChat.openProposalVote(51);
    if (currentApp) {
      assert.deepEqual(h.topics, [['proposal', 51]]);
    } else {
      assert.equal(h.sandbox.location.hash, '#app/demo-app/dev/proposals/51');
    }
  });

  test(`in ${name}, "Open proposal card" opens the session's proposal`, () => {
    const { h } = cardHarness(currentApp);
    h.DevChat.openProposalCard();
    if (currentApp) {
      assert.deepEqual(h.topics, [['proposal', h.DevChat.currentSession.id]]);
    } else {
      assert.equal(h.sandbox.location.hash, `#app/demo-app/dev/changes/${SESSION.pr_number}`);
    }
  });

  test(`in ${name}, the request chip opens the request`, () => {
    const { h, got } = cardHarness(currentApp);
    h.DevChat.openIssueRef(got.chip);
    if (currentApp) {
      assert.deepEqual(h.topics, [['issue', 12]], 'openTopic opens the request in place');
      assert.equal(h.sandbox.location.hash, '');
    } else {
      assert.deepEqual(h.topics, []);
      assert.equal(h.sandbox.location.hash, '#app/demo-app/dev/issues/12');
    }
  });

  test(`in ${name}, a reply's PR#9 and #14 are links to the change and the request`, () => {
    const h = makeDevChat({ currentApp });
    const html = h.render([
      { role: 'assistant', content: 'See PR#9 for the change; it closes #14.' },
    ], { ...SESSION });
    assert.match(html, /href="#app\/demo-app\/dev\/changes\/9"/, 'PR#9 is the change page');
    assert.match(html, /href="#app\/demo-app\/dev\/issues\/14"/, '#14 is the request page');
    assert.match(html, /data-ref-type="pr"[^>]*>PR#9/, 'and it is still chipped as a PR');
  });

  test(`in ${name}, a reply's commit address opens the code in a new tab`, () => {
    const h = makeDevChat({ currentApp });
    const commit = 'https://git.onhomeroom.com/apps/demo-app/commit/abc1234';
    const html = h.render([{ role: 'assistant', content: `Committed ${commit}` }], { ...SESSION });
    const anchor = html.match(new RegExp(`<a[^>]*href="${commit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`));
    assert.ok(anchor, 'the commit address is an anchor to itself, not rewritten into a chip');
    const tag = anchor[0];
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /data-ref-type[^>]*commit/, 'the address is not turned into a ref chip');
  });
}

test('a link with no session app opens nothing rather than guessing', () => {
  const h = makeDevChat({ currentApp: null });
  h.DevChat.currentSession = null;
  h.sandbox.App.currentApp = null;
  h.DevChat.openProposalVote(41);
  h.DevChat.openIssueRef(12);
  assert.equal(h.sandbox.location.hash, '', 'and no page address is guessed');
});

test('a blank or zero ref is ignored', () => {
  const h = makeDevChat({ currentApp: 'demo-app' });
  h.DevChat.currentSession = { ...SESSION };
  for (const bad of [null, undefined, 0, -1, 'x']) {
    h.DevChat.openProposalVote(bad);
    h.DevChat.openIssueRef(bad);
  }
  assert.deepEqual(h.topics, []);
  assert.equal(h.sandbox.location.hash, '');
});
