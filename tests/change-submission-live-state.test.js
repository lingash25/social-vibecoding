const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const session = (patch = {}) => ({
  id: 123, user_id: 42, status: 'active', source: 'cli_handoff',
  proposal_state: 'checking', check_state: 'pending',
  session_title: 'A change', linked_issues: [],
  created_at: '2026-09-15T08:00:00Z', ...patch,
});
const ready = (patch = {}) => session({ proposal_state: 'ready', check_state: 'passing', ...patch });

function fixture(current = session()) {
  const requests = [], notices = [];
  const c = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    App: { user: { id: 42 }, currentApp: 'example', currentTab: 'dev' },
    location: { search: '', hash: '' }, localStorage: { getItem: () => null },
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, dispatchEvent() {}, relTime: () => 'just now',
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    PlatformUI: { toast: message => notices.push(message) },
    DevChat: { currentSession: current, sessions: current ? [{ ...current }] : [],
      _publishDevView() {}, _publishTranscript() {}, renderChatView() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return c.response();
    },
    response: async () => ({ ok: true, json: async () => ({ ok: true, prNumber: 987, prUrl: 'https://github.com/example/app/pull/987', prTitle: 'Ready change' }) }),
  };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), c);
  }
  const av = vm.runInContext('AppView', c);
  av.appData = { slug: 'example' };
  av._ghIssues = [];
  av._renderTopicHead = () => {};
  av._loadDevData = async () => {};
  const action = item => av._topicViewFor('session', item).card.actions.find(a => a.key === 'propose-change');
  const click = a => av[a.act.fn](...a.act.args);
  return { av, c, requests, notices, action, click };
}

test('the enabled detail button submits after live checks pass despite a stale checking workspace', async () => {
  const { c, requests, action, click } = fixture();
  assert.equal(action(session()).disabled, true);
  const button = action(ready());
  assert.equal(button.disabled, false);
  assert.equal(c.DevChat.currentSession.proposal_state, 'checking');
  await click(button);
  assert.equal(requests.length, 1, 'the displayed ready action must send its submission without a reload');
  assert.equal(requests[0].url, '/api/sessions/123/promote');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(c.DevChat.currentSession.status, 'promoted');
  assert.equal(c.DevChat.currentSession.pr_number, 987);
  assert.equal(c.DevChat.sessions[0].status, 'promoted');
});

test('a failed revision becoming ready submits without replacing private workspace data', async () => {
  const current = session({ check_state: 'failing', proposal_state: 'failed', privateWorkspace: 'preserve' });
  const { c, requests, action, click } = fixture(current);
  assert.equal(action({ ...current }).disabled, true);
  await click(action(ready()));
  assert.equal(requests.length, 1);
  assert.equal(c.DevChat.currentSession.privateWorkspace, 'preserve');
});

test('a displayed blocked snapshot cannot submit through an older ready workspace', async () => {
  for (const patch of [
    { proposal_state: 'checking', check_state: 'pending' },
    { proposal_state: 'failed', check_state: 'failing' },
    { check_state: 'error' },
    { status: 'paused' },
  ]) {
    const { requests, action, click } = fixture(ready());
    const button = action(ready(patch));
    assert.equal(button.disabled, true);
    await click(button);
    assert.equal(requests.length, 0);
  }
});

test('the action retains its displayed snapshot when another surface rebuilds the same item', async () => {
  const { av, requests, action, click } = fixture();
  const button = action(ready());
  action(session());
  assert.equal(av._changeItems.get(123).proposal_state, 'checking');
  await click(button);
  assert.equal(requests.length, 1);
  assert.equal(av._changeItems.get(123).status, 'promoted');
});

test('the detail and workspace share one request lock and completed actions cannot submit again', async () => {
  const { av, c, requests, action, click } = fixture(ready());
  let finish;
  c.response = () => new Promise(resolve => { finish = resolve; });
  const button = action(ready());
  const pending = click(button);
  await click(button);
  await av.runChangeAction(123, 'promote', c.DevChat.currentSession);
  assert.equal(requests.length, 1);
  assert.equal(action(ready()).label, 'Submitting…');
  finish({ ok: true, json: async () => ({ ok: true }) });
  await pending;
  await click(button);
  assert.equal(requests.length, 1);
  assert.equal(av._changeActions.size, 0);
});

test('failed submissions show feedback, release the lock and can be retried on the same page', async () => {
  for (const response of [
    async () => ({ ok: false, json: async () => ({ message: 'Please retry this submission.' }) }),
    async () => { throw new TypeError('offline'); },
  ]) {
    const { av, c, requests, notices, action, click } = fixture();
    const button = action(ready());
    c.response = response;
    await click(button);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /retry|Network error/);
    assert.equal(av._changeActions.size, 0);
    c.response = async () => ({ ok: true, json: async () => ({ ok: true }) });
    await click(button);
    assert.equal(requests.length, 2);
    assert.equal(c.DevChat.currentSession.status, 'promoted');
  }
});

test('finishing submission after navigation updates only the submitted session', async () => {
  const { av, c, action, click } = fixture();
  let finish;
  c.response = () => new Promise(resolve => { finish = resolve; });
  const pending = click(action(ready()));
  const other = session({ id: 456, session_title: 'Other change' });
  c.DevChat.currentSession = other;
  action(other);
  finish({ ok: true, json: async () => ({ ok: true, prNumber: 987 }) });
  await pending;
  assert.equal(c.DevChat.currentSession, other);
  assert.equal(other.status, 'active');
  assert.equal(other.pr_number, undefined);
  assert.equal(av._changeItems.get(456).status, 'active');
  assert.equal(c.DevChat.sessions[0].status, 'promoted');
});

test('an action cannot submit a different id from its bound session', async () => {
  const { av, requests } = fixture(ready());
  await av.runChangeAction(456, 'promote', ready());
  assert.equal(requests.length, 0);
});
