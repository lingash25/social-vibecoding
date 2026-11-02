'use strict';

// Delegated connector grants (#2779): the platform's own agents reach the
// connector's tools on the user's behalf. The Mayor of an agent session holds
// an `agent_mayor` grant, and the coding agent in a change's worker holds a
// `worker_read` grant.
//
// What this file pins, because each is the kind of thing that keeps "working"
// while being wrong:
//
//   1. a grant is minted narrower than a consent: an access row only, a
//      synthetic client id no OAuth endpoint accepts, a server-chosen kind, a
//      bounded life, and a worker grant that can never write;
//   2. a token's SHAPE and its grant must agree, and liveness (revoked,
//      expired, the change closed or moved) is checked on every request;
//   3. each kind reaches only its own routes, and a bound grant only its own
//      app (and a Mayor's one-action grant only its own change);
//   4. a delegated grant is the ONE connector credential that works where the
//      consent surface is off (a staging preview), and only on POST /mcp and
//      the loopback API chain;
//   5. delegated grants never show up as a "connected app" in Settings.
//
// Run with: node --test tests/mcp-delegations.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const constants = require('../src/services/mcp-connect-constants');
const mcpOauth = require('../src/services/mcp-oauth');
const policy = require('../src/services/cli-api-policy');

const { READ_SCOPE, WRITE_SCOPE } = constants;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── A pool that answers the statements this feature makes ──────────────

function recordingPool(handlers = {}) {
  const calls = [];
  const answer = async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (new RegExp(pattern).test(sql)) return fn(sql, params);
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query: answer,
    async connect() {
      return { query: answer, release() {} };
    },
  };
}

// ── 1. Minting ─────────────────────────────────────────────────────────

test('delegated tokens have their own shape and a client id no OAuth endpoint accepts', () => {
  assert.equal(constants.DELEGATED_TOKEN_PREFIX, 'svmcd_');
  assert.notEqual(constants.DELEGATED_TOKEN_PREFIX, constants.TOKEN_PREFIX);
  const token = mcpOauth.makeDelegatedAccessToken();
  assert.equal(mcpOauth.isCanonicalSecret(token, constants.DELEGATED_TOKEN_PREFIX), true);
  assert.equal(mcpOauth.isCanonicalSecret(token, constants.TOKEN_PREFIX), false);

  // bot_admin: Homeroom bot's admin tools in an admin's own conversation with it (P7).
  assert.deepEqual([...constants.DELEGATION_KINDS], ['agent_mayor', 'worker_read', 'bot_admin']);
  for (const kind of constants.DELEGATION_KINDS) {
    const clientId = constants.DELEGATED_CLIENT_IDS[kind];
    assert.ok(clientId, `${kind} has a synthetic client id`);
    assert.equal(mcpOauth.CLIENT_ID_RE.test(clientId), false,
      `${clientId} can never be loaded as an OAuth client`);
  }
});

test('a grant is normalized narrower than any caller asks', () => {
  const worker = mcpOauth.normalizeDelegation({
    userId: 7, kind: 'worker_read', changeId: 50, appId: 3, ttlSeconds: 99999,
  });
  assert.deepEqual(worker.scopes, [READ_SCOPE], 'a worker reads by default');
  assert.equal(worker.ttlSeconds, constants.DELEGATION_MAX_TTL_SECONDS.worker_read,
    'a long ask is clamped to the kind\'s ceiling');

  const mayor = mcpOauth.normalizeDelegation({
    userId: 7, kind: 'agent_mayor', agentSessionId: 4, scopes: [READ_SCOPE, WRITE_SCOPE], ttlSeconds: 1,
  });
  assert.deepEqual(mayor.scopes, [READ_SCOPE, WRITE_SCOPE]);
  assert.equal(mayor.ttlSeconds, 30, 'and a tiny one is raised to a usable floor');
  assert.ok(constants.DELEGATION_MAX_TTL_SECONDS.agent_mayor <= 15 * 60, 'a Mayor grant lasts one turn');

  const refused = [
    [{ userId: 7, kind: 'worker_read', appId: 3 }, /bound to one change/],
    [{ userId: 7, kind: 'worker_read', changeId: 50 }, /bound to one change/],
    [{ userId: 7, kind: 'worker_read', changeId: 50, appId: 3, scopes: [READ_SCOPE, WRITE_SCOPE] }, /read-only/],
    [{ userId: 7, kind: 'external' }, /unknown kind/],
    [{ userId: 7, kind: 'agent_mayor', scopes: [WRITE_SCOPE] }, /read scope/],
    [{ userId: 0, kind: 'agent_mayor' }, /userId/],
    [{ userId: 7, kind: 'agent_mayor', changeId: -1 }, /positive/],
  ];
  for (const [options, message] of refused) {
    assert.throws(() => mcpOauth.normalizeDelegation(options), message, JSON.stringify(options));
  }
});

test('issueDelegatedAccess writes a delegation, one access row and an audit row — never a refresh token', async () => {
  const expires = new Date(Date.now() + 60_000);
  const pool = recordingPool({
    'INSERT INTO mcp_delegations': () => ({ rows: [{ expires_at: expires }] }),
    'INSERT INTO mcp_tokens': () => ({ rows: [{ id: 91 }] }),
  });
  const issued = await mcpOauth.issueDelegatedAccess(pool, {
    userId: 7, kind: 'worker_read', changeId: 50, appId: 3, ttlSeconds: 600,
  });
  assert.ok(issued.accessToken.startsWith('svmcd_'));
  assert.match(issued.grantId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(issued.kind, 'worker_read');
  assert.deepEqual(issued.scopes, [READ_SCOPE]);
  assert.equal(issued.expiresAt, expires.toISOString());

  const statements = pool.calls.map((c) => c.sql);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  const delegation = pool.calls.find((c) => /INSERT INTO mcp_delegations/.test(c.sql));
  assert.deepEqual(delegation.params.slice(1, 6), [7, 'worker_read', null, 50, 3]);
  const tokens = pool.calls.filter((c) => /INSERT INTO mcp_tokens/.test(c.sql));
  assert.equal(tokens.length, 1, 'one access row');
  assert.match(tokens[0].sql, /'access'/);
  assert.doesNotMatch(tokens[0].sql, /'refresh'/);
  assert.equal(tokens[0].params[0], mcpOauth.hashSecret(issued.accessToken), 'only the hash is stored');
  assert.ok(!JSON.stringify(pool.calls.map((c) => c.params)).includes(issued.accessToken),
    'the token itself is written nowhere');
  assert.equal(tokens[0].params[3], 'homeroom:worker_read');
  assert.equal(tokens[0].params[4], issued.grantId, 'the token belongs to the delegation\'s grant');
  assert.equal(tokens[0].params[6], expires, 'and dies with it');
  const audit = pool.calls.find((c) => /INSERT INTO mcp_auth_audit_events/.test(c.sql));
  assert.equal(audit.params[0], 'token_issued');
  assert.deepEqual(JSON.parse(audit.params[8]), { grant: 'delegated', kind: 'worker_read' });
});

test('revokeDelegation ends the grant and its tokens once, audited', async () => {
  const grantId = 'a'.repeat(22);
  const pool = recordingPool({
    'UPDATE mcp_delegations': () => ({ rows: [{ user_id: 7, kind: 'agent_mayor' }] }),
    'UPDATE mcp_tokens': () => ({ rowCount: 1, rows: [] }),
  });
  assert.equal(await mcpOauth.revokeDelegation(pool, { grantId, reason: 'turn_finished' }), true);
  assert.ok(pool.calls.some((c) => /UPDATE mcp_tokens SET revoked_at/.test(c.sql) && c.params[0] === grantId));
  const audit = pool.calls.find((c) => /INSERT INTO mcp_auth_audit_events/.test(c.sql));
  assert.equal(audit.params[0], 'token_revoked');
  assert.equal(audit.params[5], 'homeroom:agent_mayor');

  const already = recordingPool({ 'UPDATE mcp_delegations': () => ({ rows: [] }) });
  assert.equal(await mcpOauth.revokeDelegation(already, { grantId }), false);
  assert.ok(!already.calls.some((c) => /mcp_auth_audit_events/.test(c.sql)), 'nothing to audit');
  assert.equal(await mcpOauth.revokeDelegation(already, { grantId: 'nope' }), false);
});

// ── 2. Authentication and liveness ─────────────────────────────────────

const GRANT = 'g'.repeat(22);
const FUTURE = () => new Date(Date.now() + 10 * 60_000);

function tokenRow(overrides = {}) {
  return {
    id: 91, user_id: 7, client_id: 'homeroom:worker_read', grant_id: GRANT,
    scopes: [READ_SCOPE], expires_at: FUTURE(), revoked_at: null, client_name: null,
    d_grant_id: GRANT, d_kind: 'worker_read', d_agent_session_id: null,
    d_change_id: 50, d_app_id: 3, d_expires_at: FUTURE(), d_revoked_at: null,
    app_slug: 'recipe-box',
    change_user_id: 7, change_status: 'active', change_app_id: 3,
    agent_session_user_id: null, agent_session_status: null,
    now: new Date(),
    ...overrides,
  };
}

function authPool(row, extra = {}) {
  return recordingPool({
    'FROM mcp_tokens t': () => ({ rows: row ? [row] : [] }),
    'FROM users WHERE id': () => ({
      rows: [{ id: 7, username: 'ada', is_admin: false, admin_readonly: false, app_quota: 3, locale: null }],
    }),
    ...extra,
  });
}

const { authenticateConnector } = require('../src/routes/mcp-remote');

test('a live delegated token authenticates as its user and carries its delegation', async () => {
  const token = mcpOauth.makeDelegatedAccessToken();
  const auth = await authenticateConnector(authPool(tokenRow()), token);
  assert.equal(auth.error, undefined);
  assert.equal(auth.user.id, 7);
  assert.equal(auth.clientName, constants.DELEGATED_CLIENT_NAMES.worker_read);
  assert.deepEqual(
    { ...auth.delegation, expiresAt: undefined },
    {
      kind: 'worker_read', grantId: GRANT, agentSessionId: null, changeId: 50,
      appId: 3, appSlug: 'recipe-box', expiresAt: undefined,
    }
  );
});

test('an external token is untouched: no delegation, its own client name', async () => {
  const token = mcpOauth.makeAccessToken();
  const row = tokenRow({
    client_id: 'svmc_x', client_name: 'Claude', d_grant_id: null, d_kind: null,
    d_change_id: null, d_app_id: null, d_expires_at: null, app_slug: null,
    change_user_id: null, change_status: null, change_app_id: null,
  });
  const auth = await authenticateConnector(authPool(row), token);
  assert.equal(auth.delegation, null);
  assert.equal(auth.clientName, 'Claude');
});

test('shape and grant must agree, in both directions', async () => {
  // A delegated grant's row presented under the external prefix …
  assert.deepEqual(
    await authenticateConnector(authPool(tokenRow()), mcpOauth.makeAccessToken()),
    { error: 'invalid_token' }
  );
  // … and an `svmcd_` token whose grant is an ordinary consent.
  const external = tokenRow({ d_grant_id: null, d_kind: null });
  assert.deepEqual(
    await authenticateConnector(authPool(external), mcpOauth.makeDelegatedAccessToken()),
    { error: 'invalid_token' }
  );
});

test('liveness is checked on every request, with no hook having to run', async () => {
  const token = mcpOauth.makeDelegatedAccessToken();
  const past = new Date(Date.now() - 1000);
  const cases = [
    [{ d_revoked_at: past }, 'revoked_token', 'the delegation was revoked'],
    [{ d_expires_at: past }, 'expired_token', 'the delegation expired'],
    [{ revoked_at: past }, 'revoked_token', 'the token row was revoked'],
    [{ expires_at: past }, 'expired_token', 'the token row expired'],
    [{ change_status: 'paused' }, 'revoked_token', 'a paused change ends a worker grant'],
    [{ change_status: 'archived' }, 'revoked_token', 'an archived change ends it'],
    [{ change_status: 'merged' }, 'revoked_token', 'a merged change ends it'],
    [{ change_status: null, change_user_id: null }, 'revoked_token', 'a deleted change ends it'],
    [{ change_user_id: 8 }, 'revoked_token', 'a change that is not the grant user\'s'],
    [{ change_app_id: 4 }, 'revoked_token', 'a change that moved to another app'],
    [{ app_slug: null }, 'revoked_token', 'an app that is gone'],
    [{ d_kind: 'external' }, 'invalid_token', 'a kind the server never issues'],
  ];
  for (const [overrides, error, why] of cases) {
    const auth = await authenticateConnector(authPool(tokenRow(overrides)), token);
    assert.equal(auth.error, error, why);
  }
  // A Mayor's grant serves one agent session, and ends with it (#2779 step 3).
  const mayor = { d_kind: 'agent_mayor', d_change_id: null, d_app_id: null, app_slug: null, d_agent_session_id: 4 };
  for (const [overrides, error, why] of [
    [{ agent_session_user_id: 7, agent_session_status: 'open' }, undefined, 'an open session of the user\'s'],
    [{ agent_session_user_id: 7, agent_session_status: 'archived' }, 'revoked_token', 'an archived session'],
    [{ agent_session_user_id: 8, agent_session_status: 'open' }, 'revoked_token', 'somebody else\'s session'],
    [{ agent_session_user_id: null, agent_session_status: null }, 'revoked_token', 'a session that is gone'],
  ]) {
    const auth = await authenticateConnector(authPool(tokenRow({ ...mayor, ...overrides })), token);
    assert.equal(auth.error, error, why);
  }

  // A Mayor's grant bound to a change survives the states the Mayor still
  // acts on, where a worker's would not.
  for (const status of ['active', 'paused', 'promoted', 'merging']) {
    const auth = await authenticateConnector(
      authPool(tokenRow({ d_kind: 'agent_mayor', change_status: status })), token
    );
    assert.equal(auth.error, undefined, `a Mayor grant on a ${status} change is live`);
  }
});

// ── 3. Route allowlists per kind ───────────────────────────────────────

test('each kind reaches only its own routes, never the external list or the CLI denylist', () => {
  // A worker reads, and only what its six tools need.
  assert.equal(policy.isDelegatedApiRequest('worker_read', 'GET', '/api/apps/recipe-box/github-issues'), true);
  assert.equal(policy.isDelegatedApiRequest('worker_read', 'GET', '/api/sessions/50'), true);
  for (const [method, target] of [
    ['GET', '/api/apps'],
    ['GET', '/api/me/active-sessions'],
    ['POST', '/api/apps/recipe-box/issues'],
    ['POST', '/api/apps/recipe-box/github-issues/12/claim'],
    ['POST', '/api/sessions/50/promote'],
    ['POST', '/api/apps/recipe-box/pr-import'],
    ['PATCH', '/api/sessions/50/linked-issues'],
  ]) {
    assert.equal(policy.isDelegatedApiRequest('worker_read', method, target), false, `worker: ${method} ${target}`);
  }
  for (const route of policy.WORKER_READ_ALLOWED_ROUTES) {
    assert.equal(route.method, 'GET', `${route.pattern} is a read`);
  }

  // The Mayor has the change lifecycle the external list does not …
  for (const [method, target] of [
    ['POST', '/api/apps/recipe-box/sessions'],
    ['POST', '/api/sessions/50/sync-main'],
    ['POST', '/api/sessions/50/archive'],
  ]) {
    assert.equal(policy.isDelegatedApiRequest('agent_mayor', method, target), true, `mayor: ${method} ${target}`);
    assert.equal(policy.isConnectorApiRequest(method, target), false, `external never: ${method} ${target}`);
  }
  // … and still nothing that votes, merges, or reaches secrets and settings.
  for (const [method, target] of [
    ['POST', '/api/sessions/50/vote'],
    ['POST', '/api/sessions/50/admin-merge'],
    ['POST', '/api/sessions/50/unarchive'],
    ['POST', '/api/apps/recipe-box/pr-import'],
    ['POST', '/api/apps/recipe-box/demo/vote'],
    ['PUT', '/api/apps/recipe-box/secrets/KEY'],
    ['GET', '/api/admin/users'],
    ['POST', '/api/sessions/50/chat'],
    ['PATCH', '/api/sessions/50/title'],
  ]) {
    assert.equal(policy.isDelegatedApiRequest('agent_mayor', method, target), false, `mayor never: ${method} ${target}`);
  }
  assert.equal(policy.isDelegatedApiRequest('external', 'GET', '/api/apps'), false, 'not a delegated kind');
  assert.equal(policy.isDelegatedApiRequest('__proto__', 'GET', '/api/apps'), false);
});

test('the route binding names the slug and change a request touches', () => {
  assert.deepEqual(policy.delegatedRouteBinding('worker_read', 'GET', '/api/apps/recipe-box/github-issues/12/comments'),
    { slug: 'recipe-box', sessionId: null });
  assert.deepEqual(policy.delegatedRouteBinding('worker_read', 'GET', '/api/sessions/50/status'),
    { slug: null, sessionId: 50 });
  assert.ok(Number.isNaN(policy.delegatedRouteBinding('worker_read', 'GET', '/api/sessions/0050').sessionId),
    'a non-canonical id matches no change');
  assert.equal(policy.delegatedRouteBinding('worker_read', 'POST', '/api/sessions/50'), null);
});

// ── 4. Through the real bearer chain ───────────────────────────────────

const poolMod = require('../src/db/pool');

async function withChain({ row, sessionApps = {}, env = 'staging', config = { cliAuthEnabled: false } }, fn) {
  const pool = authPool(row, {
    'SELECT app_id FROM chat_sessions': (_sql, params) => ({
      rows: sessionApps[params[0]] ? [{ app_id: sessionApps[params[0]] }] : [],
    }),
  });
  const previousGetPool = poolMod.getPool;
  const previousEnv = process.env.USERNODE_ENV;
  poolMod.getPool = () => pool;
  process.env.USERNODE_ENV = env;
  // Required fresh so the chain closes over the stubbed pool.
  for (const mod of ['../src/routes/cli-auth', '../src/routes/mcp-remote']) {
    delete require.cache[require.resolve(mod)];
  }
  const { cliApiBearerAuth } = require('../src/routes/cli-auth');
  const app = express();
  app.use(express.json());
  app.use(cliApiBearerAuth(config));
  app.all('/api/*', (req, res) => res.json({
    reached: true,
    user: req.user && req.user.id,
    kind: req.mcpDelegation ? req.mcpDelegation.kind : null,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, target, token) => {
    const res = await fetch(`${base}${target}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn(call, pool);
  } finally {
    server.close();
    poolMod.getPool = previousGetPool;
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
    for (const mod of ['../src/routes/cli-auth', '../src/routes/mcp-remote']) {
      delete require.cache[require.resolve(mod)];
    }
  }
}

test('on staging, a delegated grant reaches the API and an external token does not', async () => {
  await withChain({ row: tokenRow() }, async (call) => {
    const delegated = await call('GET', '/api/apps/recipe-box', mcpOauth.makeDelegatedAccessToken());
    assert.equal(delegated.status, 200);
    assert.deepEqual(delegated.body, { reached: true, user: 7, kind: 'worker_read' });

    const external = await call('GET', '/api/apps/recipe-box', mcpOauth.makeAccessToken());
    assert.equal(external.status, 404, 'the consent-based connector stays off on staging');
  });
});

test('a worker grant is held to its app and to reads', async () => {
  await withChain({ row: tokenRow(), sessionApps: { 50: 3, 51: 3, 60: 4 } }, async (call) => {
    const token = mcpOauth.makeDelegatedAccessToken();
    assert.equal((await call('GET', '/api/apps/recipe-box/github-issues', token)).status, 200);
    assert.equal((await call('GET', '/api/sessions/51', token)).status, 200, 'another change on the same app');
    assert.equal((await call('GET', '/api/apps/other-app', token)).status, 403, 'another app');
    assert.equal((await call('GET', '/api/sessions/60', token)).status, 403, 'a change on another app');
    assert.equal((await call('GET', '/api/sessions/999', token)).status, 403, 'a change that does not exist');
    assert.equal((await call('POST', '/api/apps/recipe-box/issues', token)).status, 403, 'a write');
    assert.equal((await call('GET', '/api/apps', token)).status, 403, 'every app');
  });
});

test('a Mayor grant bound to one change touches only that change', async () => {
  const row = tokenRow({
    d_kind: 'agent_mayor', client_id: 'homeroom:agent_mayor', scopes: [READ_SCOPE, WRITE_SCOPE],
  });
  await withChain({ row, sessionApps: { 50: 3, 51: 3 } }, async (call) => {
    const token = mcpOauth.makeDelegatedAccessToken();
    const own = await call('POST', '/api/sessions/50/promote', token);
    assert.equal(own.status, 200);
    assert.equal(own.body.kind, 'agent_mayor');
    assert.equal((await call('POST', '/api/sessions/51/promote', token)).status, 403, 'a sibling change');
    assert.equal((await call('POST', '/api/sessions/50/vote', token)).status, 403, 'a route off the Mayor list');
  });
});

test('an unbound Mayor read grant reads across apps but cannot write', async () => {
  const row = tokenRow({
    d_kind: 'agent_mayor', client_id: 'homeroom:agent_mayor', d_change_id: null, d_app_id: null,
    app_slug: null, change_user_id: null, change_status: null, change_app_id: null,
  });
  await withChain({ row }, async (call) => {
    const token = mcpOauth.makeDelegatedAccessToken();
    assert.equal((await call('GET', '/api/apps', token)).status, 200);
    assert.equal((await call('GET', '/api/sessions/60', token)).status, 200);
    assert.equal((await call('POST', '/api/apps/recipe-box/sessions', token)).status, 403,
      'a write needs the write scope, which only a confirmed action carries');
  });
});

test('in production the external chain is unchanged and still refuses the Mayor-only routes', async () => {
  const row = tokenRow({
    client_id: 'svmc_x', client_name: 'Claude', d_grant_id: null, d_kind: null,
    d_change_id: null, d_app_id: null, d_expires_at: null, app_slug: null,
    change_user_id: null, change_status: null, change_app_id: null,
    scopes: [READ_SCOPE, WRITE_SCOPE],
  });
  await withChain({ row, env: 'production', config: { cliAuthEnabled: true } }, async (call) => {
    const token = mcpOauth.makeAccessToken();
    const ok = await call('GET', '/api/apps/recipe-box', token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.kind, null);
    assert.equal((await call('POST', '/api/sessions/50/archive', token)).status, 403);
    assert.equal((await call('POST', '/api/apps/recipe-box/sessions', token)).status, 403);
  });
});

// ── 5. The /mcp gate ───────────────────────────────────────────────────

test('where the consent surface is off, only POST /mcp with a delegated bearer passes the gate', () => {
  const { mcpConnectGate } = require('../src/routes/mcp-remote');
  const previousEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    const gate = mcpConnectGate({ cliAuthEnabled: false });
    const run = (method, pathname, token) => {
      let passed = false;
      let status = null;
      const res = {
        setHeader() {},
        status(code) { status = code; return this; },
        json() { return this; },
      };
      gate({
        method, path: pathname,
        rawHeaders: token ? ['Authorization', `Bearer ${token}`] : [],
      }, res, () => { passed = true; });
      return passed ? 'next' : status;
    };
    const delegated = mcpOauth.makeDelegatedAccessToken();
    assert.equal(run('POST', '/mcp', delegated), 'next');
    assert.equal(run('POST', '/mcp', mcpOauth.makeAccessToken()), 404);
    assert.equal(run('POST', '/mcp', null), 404);
    assert.equal(run('GET', '/mcp', delegated), 404);
    for (const pathname of [
      '/api/connect/oauth/token', '/api/connect/oauth/register', '/connect/authorize',
      '/.well-known/oauth-authorization-server',
    ]) {
      assert.equal(run('POST', pathname, delegated), 404, `${pathname} stays off`);
    }
  } finally {
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
  }
});

test('the /mcp handler re-checks the delegation and serves each kind its own surface', () => {
  const SRC = read('src/routes/mcp-remote.js');
  const handler = SRC.slice(SRC.indexOf('router.post(MCP_PATH'), SRC.indexOf('router.all(MCP_PATH'));
  assert.match(handler, /connectorSurfaceClosed\(config\) && !auth\.delegation[\s\S]{0,80}404/,
    'behind the gate, a closed surface serves delegated grants only');
  assert.match(handler, /instructions: mcpTools\.instructionsFor\(kind\)/);
  assert.match(handler, /delegation: auth\.delegation/);
  assert.match(handler, /isInitializeRequest\(req\.body\) && !auth\.delegation/,
    'a delegated grant never arms the setup tip');
});

// ── 6. Settings never lists them ───────────────────────────────────────

test('delegated grants are not connected apps', () => {
  const SRC = read('src/routes/mcp-remote.js');
  const list = SRC.slice(SRC.indexOf("router.get('/api/me/connectors'"), SRC.indexOf("router.delete('/api/me/connectors/:id'"));
  assert.match(list, /NOT EXISTS \(SELECT 1 FROM mcp_delegations d WHERE d\.grant_id = t\.grant_id\)/);
  const disconnect = SRC.slice(SRC.indexOf("router.delete('/api/me/connectors/:id'"));
  assert.match(disconnect, /NOT EXISTS \(SELECT 1 FROM mcp_delegations d WHERE d\.grant_id = t\.grant_id\)/);
  const devFlow = read('src/routes/dev-flow.js');
  const count = devFlow.slice(devFlow.indexOf('async function connectorCount'));
  assert.match(count, /NOT EXISTS \(SELECT 1 FROM mcp_delegations d WHERE d\.grant_id = t\.grant_id\)/);
});

// ── 7. The table ───────────────────────────────────────────────────────

test('the delegations table is private, bounded and bound', () => {
  const SCHEMA = read('src/db/schema.sql');
  const start = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS mcp_delegations');
  assert.ok(start > 0);
  const ddl = SCHEMA.slice(start, SCHEMA.indexOf(');', start));
  assert.match(ddl, /kind\s+TEXT NOT NULL CHECK \(kind IN \('agent_mayor', 'worker_read'\)\)/);
  assert.match(ddl, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(ddl, /CHECK \(kind <> 'worker_read' OR \(change_id IS NOT NULL AND app_id IS NOT NULL\)\)/);
  assert.match(ddl, /expires_at\s+TIMESTAMPTZ NOT NULL/);
  assert.match(SCHEMA, /COMMENT ON TABLE mcp_delegations IS 'staging:private'/);
  assert.ok(require('../src/services/debug-access').DENIED_TABLES.has('mcp_delegations'),
    'and the automated debug role cannot read who holds a grant');
});
