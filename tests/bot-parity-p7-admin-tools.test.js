'use strict';

// Homeroom bot parity, P7: admin tools in an admin's conversations with the
// bot (services/homeroom-bot-thread-tools/admin.js). Who is offered them,
// which of the connector's tools they are, which routes they reach, and that
// a write never runs from the model: it is sealed and shown on a confirm card.
//
// Run with: node --test tests/bot-parity-p7-admin-tools.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const admin = require('../src/services/homeroom-bot-thread-tools/admin');
const registry = require('../src/services/homeroom-bot-thread-tools');
const audiences = require('../src/services/mcp-audiences');
const policy = require('../src/services/cli-api-policy');
const mcpTools = require('../src/services/mcp-tools');
const constants = require('../src/services/mcp-connect-constants');
const confirmations = require('../src/services/confirmations');

const { READ_SCOPE, WRITE_SCOPE } = constants;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ADMIN = { id: 7, username: 'ada', isAdmin: true };
const CONFIG = { dataEncryptionKey: 'synthetic-test-key' };

// ── Who sees them ───────────────────────────────────────────────────────

test('only a full platform admin is offered the admin tools, and told about them', () => {
  const names = admin.tools({ user: ADMIN }).map((t) => t.function.name);
  assert.deepEqual([...names].sort(), [...audiences.BOT_ADMIN_TOOLS].sort());
  for (const user of [
    { id: 8, username: 'sam' },
    { id: 8, username: 'sam', isAdmin: false },
    { id: 9, username: 'ro', isAdmin: true, adminReadonly: true },
    { id: 10, username: 'cw', isAdmin: true, canAdminWrite: false },
    { id: 11, username: 'homeroom_bot', isAdmin: true, isSynthetic: true },
  ]) {
    assert.deepEqual(admin.tools({ user }), [], `${user.username} is offered none`);
    assert.deepEqual(admin.promptLines({ user }), [], `${user.username} is told of none`);
  }
  const lines = admin.promptLines({ user: ADMIN }).join('\n');
  assert.match(lines, /only their tap on Confirm runs it/);
  assert.match(lines, /Typing "yes" confirms nothing/);
  assert.doesNotMatch(lines, /—/, 'no em dash in what the bot is told');
  // Through the registry the chat turn reads.
  const offered = registry.toolsFor({ user: ADMIN, deps: {} }).map((t) => t.function.name);
  for (const name of audiences.BOT_ADMIN_TOOLS) assert.ok(offered.includes(name), `${name} is offered to an admin`);
  assert.ok(!registry.toolsFor({ user: { id: 8 }, deps: {} }).some((t) => audiences.BOT_ADMIN_TOOLS.includes(t.function.name)));
});

test('the curated list: the bench, configurations, test accounts, featured pictures, settings and shots, nothing else', () => {
  assert.deepEqual([...audiences.BOT_ADMIN_READ_TOOLS].sort(), [
    'get_bench_run', 'get_featured_illustration', 'get_homeroom_bot', 'list_bench_runs', 'list_bot_configs',
    'list_recent_shots', 'list_test_accounts',
  ]);
  assert.deepEqual([...audiences.BOT_ADMIN_CONFIRMED_TOOLS].sort(), [
    'create_test_account', 'launch_bench_run', 'propose_featured_illustration', 'retire_test_account',
    'save_bot_config', 'send_test_release_email', 'set_bot_config_budget', 'set_bot_config_role', 'set_homeroom_bot_settings',
  ]);
  for (const never of ['cancel_bench_run', 'regrade_bench_run', 'submit_bench_grade', 'launch_bench_studio', 'submit_bot_config_pick', 'demo_vote']) {
    assert.ok(!audiences.BOT_ADMIN_TOOLS.includes(never), `${never} is not an admin tool here`);
  }
});

// ── The connector's own tools, under a kind of their own ─────────────────

function register(kind, user = { id: 7, username: 'ada', isAdmin: true, canAdminWrite: true }) {
  const specs = new Map();
  const handlers = new Map();
  mcpTools.registerTools({ registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); } }, {
    accessToken: 'svmcd_test', scopes: [READ_SCOPE, WRITE_SCOPE], user,
    clientName: 'Homeroom', clientId: 'c1', origin: 'https://usernode.example', baseUrl: 'http://platform.internal',
    pool: { async query() { return { rows: [] }; } }, config: {}, tokenId: 1, grantId: 'g'.repeat(22),
    delegation: { kind, grantId: 'g'.repeat(22), changeId: null, appId: null, appSlug: null, agentSessionId: null },
  });
  return { specs, handlers };
}

test('a bot_admin grant sees exactly its tools: its reads read and its writes are the confirmed ones', () => {
  assert.ok(constants.DELEGATION_KINDS.includes('bot_admin'));
  assert.equal(constants.DELEGATED_CLIENT_IDS.bot_admin, 'homeroom:bot_admin');
  assert.ok(audiences.KINDS.includes('bot_admin'));
  const { specs } = register('bot_admin');
  assert.deepEqual([...specs.keys()].sort(), [...audiences.BOT_ADMIN_TOOLS].sort());
  for (const [name, spec] of specs) {
    assert.equal(spec.annotations.readOnlyHint, audiences.BOT_ADMIN_READ_TOOLS.includes(name), `${name}'s hint`);
  }
  // And the agent-session Mayor still sees none of them.
  for (const name of audiences.BOT_ADMIN_TOOLS) {
    assert.equal(audiences.toolVisibleTo('agent_mayor', name), false, `${name} is not the Mayor's`);
    assert.equal(audiences.toolVisibleTo('worker_read', name), false, `${name} is not a worker's`);
  }
});

const SAMPLE = {
  list_bench_runs: { limit: 5 },
  get_bench_run: { runId: 4 },
  launch_bench_run: { suiteId: 2, models: ['z-ai/glm-5.3-flash'], stages: ['build'], capUsd: 5 },
  list_bot_configs: {},
  save_bot_config: { role: 'side', recipe: { models: { triage: 'a/b', spec: 'a/b', build: 'a/b' }, reviewer: null, pack: null } },
  set_bot_config_role: { versionId: 3, role: 'side' },
  set_bot_config_budget: { weeklyUsd: 10 },
  list_test_accounts: {},
  create_test_account: { note: 'first run' },
  retire_test_account: { userId: 40, confirm: 'RETIRE' },
  send_test_release_email: { email: 'ada+test1@example.com' },
  get_featured_illustration: { slug: 'recipe-box' },
  propose_featured_illustration: { slug: 'recipe-box', zoom: 1.2 },
  get_homeroom_bot: {},
  set_homeroom_bot_settings: { perPerson: 4 },
  list_recent_shots: {},
};

test('every loopback a bot_admin tool makes is on the bot_admin route list, and nowhere a Mayor reaches', async () => {
  const { handlers } = register('bot_admin');
  const calls = [];
  const previous = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname });
    return { ok: true, status: 200, text: async () => JSON.stringify({}) };
  };
  try {
    for (const [name, handler] of handlers) {
      assert.ok(SAMPLE[name], `${name} has sample arguments here`);
      await handler(SAMPLE[name]);
    }
  } finally {
    global.fetch = previous;
  }
  assert.ok(calls.length >= audiences.BOT_ADMIN_TOOLS.length - 1, 'the tools really called the platform');
  for (const call of calls) {
    assert.equal(policy.isDelegatedApiRequest('bot_admin', call.method, call.path), true, `${call.method} ${call.path}`);
    assert.equal(policy.isConnectorApiRequest(call.method, call.path), true, `${call.path} is a connector route already`);
  }
  for (const route of policy.BOT_ADMIN_ALLOWED_ROUTES) {
    assert.equal(policy.isDelegatedApiRequest('agent_mayor', route.method, route.pattern.replace(/:[a-z]+/g, '1')), false,
      `${route.method} ${route.pattern} is not the Mayor's`);
  }
  assert.equal(policy.isDelegatedApiRequest('bot_admin', 'POST', '/api/apps'), false, 'and it cannot make a project');
  assert.equal(policy.isDelegatedApiRequest('bot_admin', 'POST', '/api/bot-bench/runs/4/cancel'), false, 'or cancel a run');
});

test('the token chain accepts the new kind, the table allows it, and the shim mints it only when asked', () => {
  assert.match(read('src/routes/mcp-remote.js'), /if \(!DELEGATION_KINDS\.includes\(row\.d_kind\)\) return \{ error: 'invalid_token' \};/);
  assert.match(read('src/db/migrations/0009-bot-parity-p6-p7.sql'),
    /ADD CONSTRAINT mcp_delegations_kind_check\s+CHECK \(kind IN \('agent_mayor', 'worker_read', 'bot_admin'\)\)/);
  const shim = read('src/services/mayor/mcp-shim.js');
  assert.match(shim, /const grantKind = kind === 'bot_admin' \? 'bot_admin' : 'agent_mayor';/);
  assert.match(shim, /userId, kind: grantKind, agentSessionId/);
});

// ── A turn's run ────────────────────────────────────────────────────────

function fakePool({ isAdmin = true } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const s = String(sql);
      queries.push({ s, params });
      if (/SELECT is_admin, admin_readonly, is_synthetic FROM users/.test(s)) {
        return { rows: [{ is_admin: isAdmin, admin_readonly: false, is_synthetic: false }] };
      }
      return { rows: [] };
    },
  };
}

function fakeShim(log, answer = { isError: false, text: '{"runs":[]}', structured: { runs: [] } }) {
  return async (opts) => {
    log.push({ open: opts });
    return {
      async call(name, args) { log.push({ call: name, args }); return answer; },
      async close(reason) { log.push({ close: reason }); },
    };
  };
}

function turn(extra = {}) {
  const shimLog = [];
  return { shimLog, ctx: { user: ADMIN, config: CONFIG, conversationId: 31, messageId: 900, deps: { openAdminMcp: fakeShim(shimLog) }, ...extra } };
}

test('a read runs at once on a read grant of the bot_admin kind, closed as soon as it returns', async () => {
  const pool = fakePool();
  const { ctx, shimLog } = turn();
  const out = await registry.run(pool, ctx, 'list_bench_runs', { limit: 3 });
  assert.deepEqual(out, { result: '{"runs":[]}' });
  assert.equal(shimLog[0].open.kind, 'bot_admin');
  assert.deepEqual(shimLog[0].open.scopes, [READ_SCOPE]);
  assert.equal(shimLog[0].open.userId, 7);
  assert.deepEqual(shimLog[1], { call: 'list_bench_runs', args: { limit: 3 } });
  assert.equal(shimLog[2].close, 'turn_finished');
  assert.deepEqual(ctx.looked, [{ what: 'Read the bench\'s runs' }], 'what it looked at, for the reply');
  assert.equal(ctx.card, undefined, 'a read puts no card');
});

test('somebody who lost admin since the turn began runs nothing', async () => {
  const pool = fakePool({ isAdmin: false });
  const { ctx, shimLog } = turn();
  const out = await registry.run(pool, ctx, 'list_bench_runs', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /Only a full platform admin/);
  assert.equal(shimLog.length, 0, 'no grant was minted');
  const write = await registry.run(pool, ctx, 'set_bot_config_budget', { weeklyUsd: 5 });
  assert.equal(write.ok, false);
  assert.ok(!pool.queries.some((q) => /INSERT INTO homeroom_bot_admin_actions/.test(q.s)), 'and nothing was sealed');
});

test('a write never runs from the model: its exact input is sealed and shown on a confirm card under the reply', async () => {
  const pool = fakePool();
  const { ctx, shimLog } = turn();
  const out = await registry.run(pool, ctx, 'launch_bench_run', {
    suiteId: 2, models: ['z-ai/glm-5.3-flash'], stages: ['build'], capUsd: 150, confirmLargeCap: false, note: 'Compare',
  });
  assert.equal(out.status, 'pending_confirmation');
  assert.match(out.note, /Nothing has happened yet/);
  assert.equal(shimLog.length, 0, 'no grant, no call');
  const insert = pool.queries.find((q) => /INSERT INTO homeroom_bot_admin_actions/.test(q.s));
  assert.ok(insert, 'sealed');
  const [id, userId, conversationId, rootId, tool, sealedJson, hash, expiresAt, createdAt] = insert.params;
  assert.equal(userId, 7);
  assert.equal(conversationId, 31);
  assert.equal(rootId, null);
  assert.equal(tool, 'launch_bench_run');
  const { input } = confirmations.openAction(JSON.parse(sealedJson), hash, CONFIG.dataEncryptionKey);
  assert.deepEqual(input, {
    suiteId: 2, models: ['z-ai/glm-5.3-flash'], stages: ['build'], capUsd: 150, note: 'Compare', confirmLargeCap: true,
  }, 'the card shows the cap over $100, so its Confirm is the admin\'s word for it');
  const ttl = new Date(expiresAt).getTime() - new Date(createdAt).getTime();
  assert.equal(ttl, 15 * 60 * 1000, 'it waits 15 minutes');
  assert.equal(ctx.card.type, 'confirm');
  assert.equal(ctx.card.confirmId, id);
  assert.equal(ctx.card.title, 'Launch a bench run');
  assert.equal(ctx.card.state, 'pending');
  assert.ok(ctx.card.rows.some((r) => r.label === 'Spend cap' && r.value === '$150'));
  assert.ok(!ctx.card.rows.some((r) => /confirm/i.test(r.label)), 'a hidden input is not a row');
  // One change per reply.
  const second = await registry.run(pool, ctx, 'set_bot_config_budget', { weeklyUsd: 5 });
  assert.equal(second.ok, false);
  assert.match(second.error, /One change per reply/);
});

test('a write the real tool would refuse is refused before anything is sealed, and a bench run needs its cap', async () => {
  const pool = fakePool();
  const { ctx } = turn();
  const bad = await registry.run(pool, ctx, 'set_bot_config_role', { versionId: -3, role: 'boss' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not valid/);
  const noCap = await registry.run(pool, ctx, 'launch_bench_run', { suiteId: 2, models: ['m'], stages: ['build'] });
  assert.equal(noCap.ok, false);
  assert.match(noCap.error, /how much this run may spend/);
  assert.ok(!pool.queries.some((q) => /INSERT INTO homeroom_bot_admin_actions/.test(q.s)));
  assert.equal(ctx.card, undefined);
});

test('a test account is retired with the confirm word the card stands for, and the defaults are said on the card', () => {
  assert.deepEqual(admin.sealedInputOf('retire_test_account', { userId: 40, confirm: 'nope' }), { userId: 40, confirm: 'RETIRE' });
  assert.ok(!admin.rowsOf('retire_test_account', { userId: 40, confirm: 'RETIRE' }).some((r) => r.label === 'Confirm'));
  assert.deepEqual(admin.sealedInputOf('set_bot_config_budget', { weeklyUsd: 0 }), { scope: 'first_version', weeklyUsd: 0 });
  const rows = admin.rowsOf('save_bot_config', {
    role: 'side', scope: 'later', recipe: { models: { triage: 't/1', spec: 's/1', build: 'b/1' }, reviewer: null, pack: null },
  });
  assert.ok(rows.some((r) => r.label === 'Recipe models build' && r.value === 'b/1'));
  assert.ok(rows.every((r) => r.value.length <= 200));
});

test('a one-time password comes back to the confirming screen and is kept nowhere', () => {
  const result = {
    isError: false,
    structured: { userId: 41, username: 'tester_1', password: 'p4ss-w0rd-xyz', nextStep: 'Relay the password once.' },
    text: JSON.stringify({ userId: 41, username: 'tester_1', password: 'p4ss-w0rd-xyz' }),
  };
  const stored = admin.boundedResult(result, 'password');
  assert.ok(!JSON.stringify(stored).includes('p4ss-w0rd-xyz'));
  assert.equal(stored.structured.username, 'tester_1');
  const line = admin.outcomeLine('create_test_account', stored);
  assert.match(line, /Made test account @tester_1/);
  assert.doesNotMatch(line, /p4ss/);
});

test('each outcome is one plain line, and a refusal says why', () => {
  assert.equal(admin.outcomeLine('launch_bench_run', { ok: true, structured: { runId: 12, trials: 30, estimateUsd: 4.5, capUsd: 10 } }),
    'Launched run 12: 30 trials, about $4.5 against a cap of $10.');
  assert.equal(admin.outcomeLine('set_homeroom_bot_settings', { ok: true, structured: { changed: ['perPerson'] } }), 'Changed: perPerson.');
  assert.match(admin.outcomeLine('send_test_release_email', { ok: true, structured: { email: 'a@b.c', mail: { status: 'suppressed_rate_limit' } } }), /did not go out/);
  assert.equal(admin.outcomeLine('set_bot_config_role', { ok: false, text: 'admin_only: The benchmark studio is for full platform admins.' }),
    'It did not go through: The benchmark studio is for full platform admins.');
  for (const name of admin.WRITES) {
    assert.doesNotMatch(admin.outcomeLine(name, { ok: true, structured: {} }), /—/);
    assert.ok(admin.TOOLS[name].title, `${name} has a card title`);
  }
});

test('the confirm card is a server-decided tap and a card type the client draws', () => {
  const cards = require('../src/services/homeroom-bot-cards');
  assert.ok(Object.prototype.hasOwnProperty.call(cards.HANDLERS, 'confirm'));
  assert.equal(typeof cards.HANDLERS.confirm().decide, 'function');
  const tsx = read('frontend/src/features/messages/bot-cards/confirm.tsx');
  assert.match(tsx, /decideCard\(message, action\)/);
  assert.doesNotMatch(tsx, /sayAsMe/, 'a typed yes is not a confirmation');
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  for (const id of tsx.match(/messages:botCards\.confirm\.[a-zA-Z]+/g)) {
    assert.ok(catalog[id.replace(/^messages:/, '')], `${id} is in the catalog`);
  }
});
