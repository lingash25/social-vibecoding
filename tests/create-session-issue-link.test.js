// Route test for POST /api/apps/:slug/sessions (src/routes/sessions.js) —
// the #287 issue link. When the issue row's "Create PR" button starts a
// dev chat it passes the issue number, which is persisted as
// chat_sessions.created_from_issue_number so the row can later swap to
// "Open Session" for that viewer. The generic "+ New chat" path sends no
// body and must store NULL.
//
// #2500 / #2537: the same INSERT now also SEEDS that number into
// chat_sessions.linked_issues and marks the row issue_link_seeded. Those
// are the columns the proposal's "Addresses" chips and the pull request's
// `Closes #N` block read — created_from_issue_number reaches neither — so
// an issue-started proposal used to read "No issues linked yet" unless the
// Mayor happened to declare the link itself, which it never does on an
// OpenRouter or direct-agent turn. The two extra bound parameters are why
// the agent-preference assertions below read from index 5, not 3.
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, capture every query, and assert the
// INSERT's column list + params directly (the persistence is the contract).
//
// Run with: node --test tests/create-session-issue-link.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql: String(sql), params });
    return poolQueryHandler(sql, params);
  },
});

// No GitHub creds in the test env. Since #1350 the interactive create route
// mints no branch (that happens on the first turn, by
// sessionLifecycle.ensureSessionBranch); its only GitHub read is #2364's
// open-issue check before claiming, which the claim tests at the bottom
// switch on per test. The INSERT's params start one position earlier than
// they used to, because branch_name is now a literal NULL in the VALUES
// list rather than a bound parameter.
const github = require('../src/services/github');
github.isEnabled = () => false;

const events = require('../src/services/events');
events.record = () => {};

const appAccess = require('../src/services/app-access');
// The route now 400s on repo-less apps (session-2585 fix), so the happy
// path needs a real-looking repo_url; the guard has its own test below.
let appRow = { id: 1, slug: 'demo', repo_url: 'https://github.com/bot/demo' };
appAccess.getAppForUser = async () => appRow;

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

// Answer the cap-count queries with 0 and the INSERT with a canned row.
function installInsertCapture() {
  let insert = null;
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO chat_sessions/.test(s)) {
      insert = { sql: s, params };
      return { rows: [{ id: 99, status: 'active', created_from_issue_number: params[2] }] };
    }
    if (/COUNT\(\*\)/.test(s)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  return () => insert;
}

function startServer(config = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('issueNumber is persisted to created_from_issue_number', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueNumber: 287 }),
    });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.ok(insert, 'an INSERT was issued');
    assert.match(insert.sql, /created_from_issue_number/);
    assert.strictEqual(insert.params[2], 287);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('no body → created_from_issue_number is NULL', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, { method: 'POST' });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.ok(insert, 'an INSERT was issued');
    assert.strictEqual(insert.params[2], null);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('#2500: issueNumber also seeds linked_issues and marks the row seeded', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueNumber: 2496 }),
    });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.match(insert.sql, /linked_issues/);
    assert.match(insert.sql, /issue_link_seeded/);
    assert.deepStrictEqual(insert.params[3], [2496], 'the issue is linked at creation');
    assert.strictEqual(insert.params[4], true, 'and the row is marked seeded');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('#2500: a session started from no issue links nothing and is not marked seeded', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, { method: 'POST' });
    assert.strictEqual(res.status, 201);

    const insert = getInsert();
    assert.deepStrictEqual(insert.params[3], []);
    assert.strictEqual(insert.params[4], false);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('an explicit Claude choice is persisted instead of consulting a global provider choice', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer({ codexOpenrouterEnabled: false });
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend: 'claude_code', model: 'must-not-leak', reasoningEffort: 'high',
      }),
    });
    assert.strictEqual(res.status, 201);
    const insert = getInsert();
    assert.deepStrictEqual(insert.params.slice(5, 9), [
      'claude_code', 'anthropic', null, null,
    ]);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('an explicit Codex choice without a model fails without creating a session', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
  });
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'codex_openrouter' }),
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /Choose an OpenRouter model/);
    assert.strictEqual(getInsert(), null, 'no chat_sessions INSERT was issued');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('automatic OpenRouter provisioning failure returns its stable error code without creating a session', async (t) => {
  const managed = require('../src/services/openrouter-managed-keys');
  const originalProvision = managed.provision;
  managed.provision = async () => {
    throw new managed.ManagedOpenRouterError(
      503,
      'not_configured',
      'Company OpenRouter keys are not configured yet.',
    );
  };
  t.after(() => { managed.provision = originalProvision; });

  const getInsert = installInsertCapture();
  const server = await startServer({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
    openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash',
  });
  t.after(() => server.close());

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.strictEqual(body.code, 'not_configured');
  assert.match(body.error, /USERNODE_OPENROUTER_MANAGEMENT_API_KEY/);
  assert.strictEqual(getInsert(), null, 'no chat_sessions INSERT was issued');
});

test('an explicit validated Codex choice is persisted exactly', async (t) => {
  const credentialStore = require('../src/services/credential-store');
  const agentModels = require('../src/services/agent-models');
  const originalMetadata = credentialStore.readMetadata;
  const originalSecret = credentialStore.readSecret;
  const originalCatalog = agentModels.listOpenRouterModels;
  credentialStore.readMetadata = async () => ({ status: 'valid', revision: 8 });
  credentialStore.readSecret = async ({ expectedRevision }) => {
    assert.strictEqual(expectedRevision, 8);
    return 'sk-or-test';
  };
  agentModels.listOpenRouterModels = async () => ({
    models: [{ id: 'openai/gpt-5.3-codex' }],
  });
  t.after(() => {
    credentialStore.readMetadata = originalMetadata;
    credentialStore.readSecret = originalSecret;
    agentModels.listOpenRouterModels = originalCatalog;
  });

  const getInsert = installInsertCapture();
  const server = await startServer({
    codexOpenrouterEnabled: true,
    openrouterBetaUserIds: [],
    dataEncryptionKey: 'test-data-key',
  });
  t.after(() => server.close());

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      backend: 'codex_openrouter',
      model: 'openai/gpt-5.3-codex',
      reasoningEffort: 'medium',
    }),
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(getInsert().params.slice(5, 9), [
    'codex_openrouter', 'openrouter', 'openai/gpt-5.3-codex', 'medium',
  ]);
});

test('an explicit unknown backend fails without creating a session', async () => {
  const getInsert = installInsertCapture();
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'not-real' }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'Unknown backend');
    assert.strictEqual(getInsert(), null, 'no chat_sessions INSERT was issued');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('a non-positive / non-integer issueNumber is rejected to NULL', async () => {
  for (const bad of [0, -5, 1.5, 'abc', null]) {
    const getInsert = installInsertCapture();
    const server = await startServer();
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueNumber: bad }),
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(getInsert().params[2], null, `issueNumber=${bad} stores NULL`);
    } finally {
      poolQueryHandler = async () => ({ rows: [] });
      server.close();
    }
  }
});

test('repo-less app is rejected with 400 before any session INSERT', async () => {
  const getInsert = installInsertCapture();
  const prior = appRow;
  appRow = { id: 1, slug: 'demo', repo_url: null };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /No GitHub repo configured/);
    assert.strictEqual(getInsert(), null, 'no chat_sessions INSERT was issued');
  } finally {
    appRow = prior;
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

// #2364: "Start work" on an issue card creates its session through this
// route, and starting work on an issue claims and assigns it for the
// starter — but only an issue GitHub confirms is OPEN on this app's repo,
// because the number is client input. A claim never fails the session.
function installClaimCapture({ created = true } = {}) {
  const calls = [];
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/INSERT INTO chat_sessions/.test(s)) {
      return { rows: [{ id: 99, status: 'active', created_from_issue_number: params[2] }] };
    }
    if (/INSERT INTO issue_claims/.test(s)) {
      return { rows: [{ claimed_at: '2026-09-17T00:00:00Z', created }] };
    }
    if (/COUNT\(\*\)/.test(s)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  return {
    claim: () => calls.find((c) => /INSERT INTO issue_claims/.test(c.sql)) || null,
    vote: () => calls.find((c) => /INSERT INTO topic_attribute_votes/.test(c.sql)
      && c.params && c.params[1] === 'issue') || null,
  };
}

// services/issue-claims.js reads ws off the module object at call time.
function stubClaimCollaborators(t, { issue, enabled = true }) {
  const ws = require('../src/services/ws');
  const orig = {
    isEnabled: github.isEnabled,
    fetchPublicIssue: github.fetchPublicIssue,
    sendSystemMessage: ws.sendSystemMessage,
    pushIssueUpdate: ws.pushIssueUpdate,
  };
  const seen = { fetches: [], messages: [], pushes: [] };
  github.isEnabled = () => enabled;
  github.fetchPublicIssue = async (owner, repo, n) => {
    seen.fetches.push([owner, repo, n]);
    if (issue instanceof Error) throw issue;
    return { issue };
  };
  ws.sendSystemMessage = async (pool, appId, content, msgType, metadata, thread) => {
    seen.messages.push({ content, thread });
  };
  ws.pushIssueUpdate = (payload) => { seen.pushes.push(payload); };
  t.after(() => {
    github.isEnabled = orig.isEnabled;
    github.fetchPublicIssue = orig.fetchPublicIssue;
    ws.sendSystemMessage = orig.sendSystemMessage;
    ws.pushIssueUpdate = orig.pushIssueUpdate;
    poolQueryHandler = async () => ({ rows: [] });
  });
  return seen;
}

async function postSession(body) {
  const server = await startServer();
  try {
    const port = server.address().port;
    return await fetch(`http://127.0.0.1:${port}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    server.close();
  }
}

test('starting work on an OPEN issue claims and assigns it for the starter', async (t) => {
  const seen = stubClaimCollaborators(t, { issue: { number: 287, title: 't', state: 'open' } });
  const capture = installClaimCapture();
  const res = await postSession({ issueNumber: 287 });
  assert.strictEqual(res.status, 201);

  assert.deepStrictEqual(seen.fetches, [['bot', 'demo', 287]]);
  const claim = capture.claim();
  assert.ok(claim, 'a claim upsert was issued');
  assert.deepStrictEqual(claim.params, [1, 287, 7]);
  const vote = capture.vote();
  assert.ok(vote, 'the issue assignee vote was cast');
  assert.deepStrictEqual(vote.params, [1, 'issue', 287, 'assignee', 'tester', 7]);
  assert.deepStrictEqual(seen.messages, [
    { content: 'tester claimed this issue', thread: { type: 'issue', ref: 287 } },
  ]);
  assert.deepStrictEqual(seen.pushes, [
    { action: 'claimed', appSlug: 'demo', appId: 1, issueNumber: 287 },
  ]);
});

test('a CLOSED issue is not claimed, but the session is still created', async (t) => {
  const seen = stubClaimCollaborators(t, { issue: { number: 287, title: 't', state: 'closed' } });
  const capture = installClaimCapture();
  const res = await postSession({ issueNumber: 287 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(seen.fetches.length, 1);
  assert.strictEqual(capture.claim(), null, 'no claim upsert');
  assert.strictEqual(capture.vote(), null, 'no issue assignee vote');
  assert.strictEqual(seen.pushes.length, 0);
});

test('an issue GitHub cannot confirm (degraded fetch) is not claimed', async (t) => {
  const seen = stubClaimCollaborators(t, { issue: null });
  const capture = installClaimCapture();
  const res = await postSession({ issueNumber: 287 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(seen.fetches.length, 1);
  assert.strictEqual(capture.claim(), null, 'no claim upsert');
});

test('a session with no issueNumber claims nothing and asks GitHub nothing', async (t) => {
  const seen = stubClaimCollaborators(t, { issue: { number: 287, title: 't', state: 'open' } });
  const capture = installClaimCapture();
  const res = await postSession({});
  assert.strictEqual(res.status, 201);
  assert.strictEqual(seen.fetches.length, 0);
  assert.strictEqual(capture.claim(), null, 'no claim upsert');
});

test('with GitHub disabled the issue cannot be verified, so nothing is claimed', async (t) => {
  const seen = stubClaimCollaborators(t, {
    issue: { number: 287, title: 't', state: 'open' }, enabled: false,
  });
  const capture = installClaimCapture();
  const res = await postSession({ issueNumber: 287 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(seen.fetches.length, 0);
  assert.strictEqual(capture.claim(), null, 'no claim upsert');
});

test('a failing claim never fails session creation', async (t) => {
  stubClaimCollaborators(t, { issue: { number: 287, title: 't', state: 'open' } });
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO chat_sessions/.test(s)) {
      return { rows: [{ id: 99, status: 'active', created_from_issue_number: params[2] }] };
    }
    if (/INSERT INTO issue_claims/.test(s)) throw new Error('db down');
    if (/COUNT\(\*\)/.test(s)) return { rows: [{ cnt: '0' }] };
    return { rows: [] };
  };
  const res = await postSession({ issueNumber: 287 });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).session.id, 99);
});
