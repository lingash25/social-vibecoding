'use strict';

// Agent sessions (#2779), step 3a: the data layer and its HTTP surface, and
// the places the rest of the platform hands off to it. The per-user flag it
// shipped behind is retired: agent sessions are on for everyone.
//
// The database-level behaviour (the trigger that stamps every message row,
// the foreign keys, the constraints) is exercised against a real PostgreSQL
// in tests/agent-sessions-postgres.test.js. This file covers the logic with
// recording fakes, and the seams with the sources they live in.
//
// Run with: node --test tests/agent-sessions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const agentSessions = require('../src/services/agent-sessions');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function recordingPool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (new RegExp(pattern).test(sql)) return fn(sql, params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ── The retired flag ───────────────────────────────────────────────────

test('agent sessions are on for everyone: no flag, no default, no opt-in audience', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/services/agent-sessions-flag.js')), false);
  const config = read('src/config.js');
  assert.doesNotMatch(config, /AGENT_SESSIONS_DEFAULT|AGENT_SESSIONS_OPT_IN|agentSessionsDefault|agentSessionsOptIn/);
  // Neither browser user load reads the retired column any more; it stays in
  // schema.sql only so an older pod's SELECT survives a rolling deploy.
  const auth = read('src/middleware/auth.js');
  assert.doesNotMatch(auth, /agent_sessions_enabled|agentSessionsFlag|agentSessionsChoice/);
});

test('auth/me still says agent sessions are on, for a shell cached before the switch went', () => {
  const routes = read('src/routes/auth.js');
  assert.match(routes, /agentSessionsEnabled: true,/);
  assert.doesNotMatch(routes, /agentSessionsChoosable|agentSessionsFlag/);
  assert.doesNotMatch(routes, /\/api\/me\/agent-sessions/, 'the Settings switch\'s route is gone');
});

// ── The hint ───────────────────────────────────────────────────────────

test('a hint is parsed strictly', () => {
  assert.equal(agentSessions.parseHint(null), null);
  assert.deepEqual(agentSessions.parseHint({ slug: 'recipe-box', issueNumber: 12, entry: 'issue' }),
    { slug: 'recipe-box', issueNumber: 12, proposalId: null, entry: 'issue' });
  for (const [bad, message] of [
    [[], /object/],
    [{ app: 'x' }, /Unsupported hint field: app/],
    [{ slug: 'Bad Slug' }, /app slug/],
    [{ slug: 'x', issueNumber: -1 }, /positive integers/],
    [{ issueNumber: 12 }, /slug is required/],
    [{ slug: 'x', entry: 'somewhere' }, /entry must be one of/],
  ]) {
    assert.throws(() => agentSessions.parseHint(bad), message, JSON.stringify(bad));
  }
});

test('an app the user cannot see is dropped from the hint, never refused', async () => {
  const visible = recordingPool({
    'FROM apps WHERE slug': () => ({
      rows: [{ id: 3, slug: 'recipe-box', collab_visibility: 'public', view_visibility: 'public' }],
    }),
  });
  assert.deepEqual(
    await agentSessions.resolveHint(visible, { id: 7 }, { slug: 'recipe-box', issueNumber: 12, entry: 'issue' }),
    {
      focusAppId: 3,
      focusApp: {
        id: 3, slug: 'recipe-box', name: null,
        selfHosted: false, iconUrl: null, iconEmoji: null,
      },
      focusContext: { entry: 'issue', issueNumber: 12 },
    }
  );
  const hidden = recordingPool({
    'FROM apps WHERE slug': () => ({
      rows: [{ id: 3, slug: 'secret', collab_visibility: 'private', view_visibility: 'private' }],
    }),
    'app_collaborators|app_members': () => ({ rows: [] }),
  });
  assert.deepEqual(
    await agentSessions.resolveHint(hidden, { id: 7 }, { slug: 'secret', proposalId: 9, entry: 'proposal' }),
    { focusAppId: null, focusApp: null, focusContext: { entry: 'proposal' } },
    'the app and anything about it are dropped; only where the user came from is kept'
  );
});

test('an unsent conversation is previewed with the same rule, and nothing is written', async () => {
  const pool = recordingPool({
    'FROM apps WHERE slug': () => ({
      rows: [{ id: 3, slug: 'recipe-box', name: 'Recipe box', collab_visibility: 'public', view_visibility: 'public' }],
    }),
  });
  assert.deepEqual(
    await agentSessions.previewDraft(pool, { user: { id: 7 }, hint: { slug: 'recipe-box', proposalId: 4, entry: 'proposal' } }),
    {
      focusApp: {
        id: 3, slug: 'recipe-box', name: 'Recipe box',
        selfHosted: false, iconUrl: null, iconEmoji: null,
      },
      focusContext: { entry: 'proposal', proposalId: 4 },
    },
  );
  assert.deepEqual(await agentSessions.previewDraft(pool, { user: { id: 7 } }), { focusApp: null, focusContext: {} });
  assert.ok(pool.calls.every((c) => /^\s*SELECT/i.test(c.sql)), 'reads only');
  assert.throws(() => agentSessions.parseHint({ slug: 'Bad Slug' }), /app slug/);
  await assert.rejects(agentSessions.previewDraft(pool, { user: { id: 7 }, hint: { slug: 'Bad Slug' } }), /app slug/);
});

test('the conversation\'s model choice is stored, read back and shaped', async () => {
  const pool = recordingPool({
    'UPDATE agent_sessions': () => ({ rows: [{ id: 5 }], rowCount: 1 }),
    'SELECT agent_backend, agent_model, agent_reasoning_effort': () => ({
      rows: [{ agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5', agent_reasoning_effort: 'high' }],
    }),
  });
  await agentSessions.setAgentChoice(pool, {
    userId: 7, id: 5, agent: { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' },
  });
  const update = pool.calls.find((c) => /UPDATE agent_sessions/.test(c.sql));
  assert.match(update.sql, /WHERE id = \$1 AND user_id = \$2 AND status = 'open'/, 'owner-scoped, open only');
  assert.deepEqual(update.params, [5, 7, 'codex_openrouter', 'z-ai/glm-5', 'high']);
  assert.deepEqual(await agentSessions.getAgentChoice(pool, 5),
    { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' });
  assert.equal(await agentSessions.getAgentChoice(recordingPool(), 5), null, 'no row, no choice');
  assert.equal(await agentSessions.getAgentChoice(pool, 'x'), null);

  assert.equal(agentSessions.shapeSession({ id: 5, status: 'open' }).agent, null, 'no choice follows the default');
  assert.deepEqual(
    agentSessions.shapeSession({ id: 5, status: 'open', agent_backend: 'claude_code', agent_model: 'claude-fable-5-1' }).agent,
    { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null },
  );
});

// ── Reads are the owner's ──────────────────────────────────────────────

test('every read and write names the owner', () => {
  const SRC = read('src/services/agent-sessions.js');
  for (const fn of ['listAgentSessions', 'getAgentSession', 'renameAgentSession', 'archiveAgentSession',
    'unarchiveAgentSession', 'listMessages', 'prepareChangeStart']) {
    const start = SRC.indexOf(`async function ${fn}(`);
    const body = SRC.slice(start, SRC.indexOf('\nasync function', start + 10));
    assert.match(body, /user_id = \$\d/, `${fn} is owner-scoped`);
  }
});

test('another user\'s id reads as not found', async () => {
  const pool = recordingPool();
  assert.equal(await agentSessions.getAgentSession(pool, { userId: 7, id: 5 }), null);
  assert.equal(await agentSessions.listMessages(pool, { userId: 7, id: 5 }), null);
  assert.equal(await agentSessions.getAgentSession(pool, { userId: 7, id: 'x' }), null);
  assert.equal(pool.calls.length, 2, 'a malformed id is refused before any lookup');
});

test('archiving parks the active change and never withdraws it', async () => {
  const pool = recordingPool({
    "UPDATE agent_sessions SET status = 'archived'": () => ({ rows: [{ active_change_id: 50 }] }),
  });
  const parked = [];
  const lifecycle = require('../src/services/session-lifecycle');
  const original = lifecycle.pauseSession;
  lifecycle.pauseSession = async (args) => { parked.push(args); return { paused: true }; };
  try {
    await agentSessions.archiveAgentSession(pool, { userId: 7, id: 5 });
  } finally {
    lifecycle.pauseSession = original;
  }
  assert.deepEqual(parked.map((p) => [p.sessionId, p.userId, p.reason]), [[50, 7, 'agent-session-archived']]);
  assert.ok(!pool.calls.some((c) => /status = 'archived'[\s\S]*chat_sessions|UPDATE chat_sessions/.test(c.sql)),
    'the change itself is not archived');
});

// ── Changes ────────────────────────────────────────────────────────────

test('a new change parks the previous one, then becomes the active change', async () => {
  const lifecycle = require('../src/services/session-lifecycle');
  const original = lifecycle.pauseSession;
  const parked = [];
  lifecycle.pauseSession = async (args) => { parked.push(args.sessionId); return { paused: true }; };
  const pool = recordingPool({
    'SELECT id, active_change_id FROM agent_sessions': () => ({ rows: [{ id: 5, active_change_id: 40 }] }),
    'UPDATE chat_sessions SET agent_session_id': () => ({ rows: [{ id: 50, app_id: 3 }] }),
  });
  try {
    await agentSessions.prepareChangeStart(pool, { agentSessionId: 5, userId: 7 });
    const linked = await agentSessions.linkChange(pool, {
      agentSessionId: 5, userId: 7,
      change: { id: 50, session_title: 'Dark mode', app_name: 'Recipe box' },
    });
    assert.equal(linked, true);
  } finally {
    lifecycle.pauseSession = original;
  }
  assert.deepEqual(parked, [40], 'the previous active change is parked first');
  const setActive = pool.calls.find((c) => /SET active_change_id = \$1, focus_app_id = \$2/.test(c.sql));
  assert.deepEqual(setActive.params, [50, 3, 5, 7], 'the new change is active and the focus follows it');
  const backfill = pool.calls.find((c) => /UPDATE chat_session_messages SET agent_session_id/.test(c.sql));
  assert.deepEqual(backfill.params, [5, 50]);
  const note = pool.calls.find((c) => /INSERT INTO chat_session_messages/.test(c.sql));
  assert.match(note.sql, /VALUES \(NULL, \$1, 'system'/, 'a conversation row, not a change row');
  assert.equal(note.params[1], 'Started a change on Recipe box: Dark mode');
  assert.deepEqual(JSON.parse(note.params[2]), { changeId: 50, title: 'Dark mode', agentSessionEvent: 'change_started' },
    'with the name it started with, which its proposal\'s title and description are written from');
});

test('a closed session or somebody else\'s cannot start a change', async () => {
  await assert.rejects(
    agentSessions.prepareChangeStart(recordingPool(), { agentSessionId: 5, userId: 7 }),
    (err) => err instanceof agentSessions.AgentSessionError && err.status === 404
  );
});

test('a closed change tells its conversation, and a classic one costs nothing', async () => {
  const classic = recordingPool();
  assert.equal(await agentSessions.noteChangeClosed(classic, {
    change: { id: 50, agent_session_id: null }, outcome: 'merged',
  }), false);
  assert.equal(classic.calls.length, 0, 'no query for a classic session');

  const child = recordingPool();
  assert.equal(await agentSessions.noteChangeClosed(child, {
    change: { id: 50, agent_session_id: 5, pr_number: 901 }, outcome: 'merged',
  }), true);
  const clear = child.calls.find((c) => /SET active_change_id = NULL/.test(c.sql));
  assert.deepEqual(clear.params, [5, 50], 'cleared only if it was the active change');
  const note = child.calls.find((c) => /INSERT INTO chat_session_messages/.test(c.sql));
  assert.equal(note.params[1], 'PR #901 merged. It is part of the app now.');

  // A row that did not select the column is looked up, and a fake that
  // answers with nothing useful is not mistaken for a parent.
  const partial = recordingPool({ 'SELECT agent_session_id, pr_number FROM chat_sessions': () => ({ rows: [{}] }) });
  assert.equal(await agentSessions.noteChangeClosed(partial, { change: { id: 50 }, outcome: 'withdrawn' }), false);

  const failing = { async query() { throw new Error('db down'); } };
  assert.equal(await agentSessions.noteChangeClosed(failing, {
    change: { id: 50, agent_session_id: 5 }, outcome: 'merged',
  }), false, 'never throws');
});

test('each way a change closes reads plainly', () => {
  const sentence = (outcome, prNumber = 9) => agentSessions.closedSentence({ prNumber, outcome });
  assert.equal(sentence('merged'), 'PR #9 merged. It is part of the app now.');
  assert.equal(sentence('rejected'), 'PR #9 was set aside by the group\'s vote.');
  assert.equal(sentence('withdrawn'), 'PR #9 was withdrawn.');
  assert.equal(sentence('closed', null), 'The change was closed.');
  assert.equal(agentSessions.outcomeForArchiveReason('manual'), 'withdrawn');
  assert.equal(agentSessions.outcomeForArchiveReason('auto-rejected'), 'rejected');
  assert.equal(agentSessions.outcomeForArchiveReason('proposal-replaced'), 'replaced');
  assert.equal(agentSessions.outcomeForArchiveReason('stale-pr'), 'closed');
});

// ── The seams ──────────────────────────────────────────────────────────

test('a change with a parent refuses its own dev chat', () => {
  const SRC = read('src/routes/sessions.js');
  const chat = SRC.slice(SRC.indexOf("router.post('/api/sessions/:id/chat'"));
  const refusal = chat.indexOf('session.agent_session_id != null');
  assert.ok(refusal > 0, 'the chat route checks for a parent');
  assert.ok(refusal < chat.indexOf('limits.resolveBillingPath'), 'before anything is billed');
  assert.match(chat.slice(refusal, refusal + 400), /409[\s\S]*Continue it there/);
});

test('the create route links a Mayor\'s change to its session, and only then', () => {
  const SRC = read('src/routes/sessions.js');
  const create = SRC.slice(SRC.indexOf("router.post('/api/apps/:slug/sessions'"), SRC.indexOf("router.post('/api/apps/:slug/issues/:number/headless-session'"));
  assert.match(create, /req\.mcpDelegation && req\.mcpDelegation\.kind === 'agent_mayor'/,
    'only a delegated Mayor grant names a session; a browser request never does');
  const park = create.indexOf('agentSessions.prepareChangeStart');
  const cap = create.indexOf('effectiveSessionCaps(config, req.user)');
  assert.ok(park > 0 && park < cap, 'the previous change is parked before the cap counts it');
  const insert = create.indexOf('INSERT INTO chat_sessions');
  const link = create.indexOf('agentSessions.linkChange');
  assert.ok(link > insert, 'and the new one is linked once it exists');
  assert.match(create, /agent_reasoning_effort,\s*session_title\)/, 'a name can ride on the create');
  assert.doesNotMatch(create.slice(create.indexOf('INSERT INTO chat_sessions'), create.indexOf('RETURNING *')), /proposed_pr_title/,
    'as the change\'s name, not a title a person pinned: the proposal\'s title is written from the change');
  // A change the conversation starts is created on the conversation's model,
  // held to a browser pick's exact-or-refuse rule, and resolved before any
  // slot is reclaimed so a choice that cannot run has no side effects.
  assert.match(create, /!explicitAgent && agentSessionId\s*\? await agentSessions\.getAgentChoice\(pool, agentSessionId\)/);
  assert.match(create, /resolveExplicitAgentPreference\(pool, req\.user\.id, config, conversationChoice\)/);
  assert.ok(create.indexOf('conversationChoice') < create.indexOf('sessionLifecycle.freeGlobalSlot'));
});

test('the merge and archive paths tell the parent session', () => {
  const votes = read('src/routes/votes.js');
  const merge = votes.slice(votes.indexOf('async function finalizeMerge('));
  const note = merge.indexOf("noteChangeClosed(pool, { change: session, outcome: 'merged' })");
  assert.ok(note > 0 && note > merge.indexOf("SET status = 'merged'"), 'after the change is marked merged');
  assert.match(merge.slice(note - 200, note + 300), /try \{[\s\S]*catch \(err\)/, 'and it can never fail the merge');
  const lifecycle = read('src/services/session-lifecycle.js');
  const archive = lifecycle.slice(lifecycle.indexOf('async function finalizeArchivedSession('));
  assert.match(archive, /noteChangeClosed\(pool, \{\s*change: session,\s*outcome: require\('\.\/agent-sessions'\)\.outcomeForArchiveReason\(reason\)/);
});

test('deleting an account removes its conversation-only rows first', () => {
  const SRC = read('src/services/account-deletion.js');
  const rows = SRC.indexOf('DELETE FROM chat_session_messages WHERE session_id IS NULL');
  // Deletion anonymises the row, whose purge empties agent_sessions.
  assert.ok(rows > 0 && rows < SRC.indexOf('await anonymiseUser(db, userId'));
});

// ── The routes ─────────────────────────────────────────────────────────

const poolMod = require('../src/db/pool');

async function withRoutes(user, handlers, fn) {
  const pool = recordingPool(handlers);
  const previous = poolMod.getPool;
  poolMod.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/agent-sessions')];
  const { agentSessionRoutes } = require('../src/routes/agent-sessions');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(agentSessionRoutes({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, target, body) => {
    const res = await fetch(`${base}${target}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn(call, pool);
  } finally {
    server.close();
    poolMod.getPool = previous;
    delete require.cache[require.resolve('../src/routes/agent-sessions')];
  }
}

const SESSION_ROW = {
  id: 5, user_id: 7, title: null, title_source: 'auto', status: 'open', focus_app_id: 3,
  focus_context: { entry: 'improve' }, active_change_id: null, active_turn: null,
  last_activity_at: new Date('2026-09-23T12:00:00Z'), created_at: new Date('2026-09-23T12:00:00Z'),
  archived_at: null, focus_app_slug: 'recipe-box', focus_app_name: 'Recipe box',
};

test('any signed-in user may create a session; everything else only needs to be yours', async () => {
  const handlers = {
    'INSERT INTO agent_sessions': () => ({ rows: [{ id: 5 }] }),
    'FROM agent_sessions s': () => ({ rows: [SESSION_ROW] }),
    'FROM apps WHERE slug': () => ({ rows: [{ id: 3, slug: 'recipe-box', collab_visibility: 'public', view_visibility: 'public' }] }),
  };
  await withRoutes({ id: 7 }, handlers, async (call, pool) => {
    const listed = await call('GET', '/api/agent-sessions');
    assert.equal(listed.status, 200);
    const created = await call('POST', '/api/agent-sessions', { hint: { slug: 'recipe-box', entry: 'improve' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.id, 5);
    assert.deepEqual(created.body.session.focusApp, {
      id: 3, slug: 'recipe-box', name: 'Recipe box',
      selfHosted: false, iconUrl: null, iconEmoji: null,
    });
    const insert = pool.calls.find((c) => /INSERT INTO agent_sessions/.test(c.sql));
    assert.deepEqual(insert.params, [7, 3, JSON.stringify({ entry: 'improve' }), null, null, null],
      'no model picked: the conversation follows the default');

    assert.equal((await call('POST', '/api/agent-sessions', { message: 'hi' })).status, 400,
      'a first message is not accepted yet');
    assert.equal((await call('POST', '/api/agent-sessions', { hint: { slug: 'NOPE' } })).status, 400);
    assert.equal((await call('GET', '/api/agent-sessions?status=deleted')).status, 400);
  });
});

test('an unsent conversation is previewed, then created on its first message with the model picked meanwhile', async () => {
  const handlers = {
    'INSERT INTO agent_sessions': () => ({ rows: [{ id: 5 }] }),
    'FROM agent_sessions s': () => ({ rows: [SESSION_ROW] }),
    'FROM apps WHERE slug': () => ({
      rows: [{ id: 3, slug: 'recipe-box', name: 'Recipe box', collab_visibility: 'public', view_visibility: 'public' }],
    }),
  };
  await withRoutes({ id: 7 }, handlers, async (call, pool) => {
    const draft = await call('GET', '/api/agent-sessions/draft?slug=recipe-box&issueNumber=12&entry=issue');
    assert.equal(draft.status, 200);
    assert.deepEqual(draft.body.draft, {
      focusApp: {
        id: 3, slug: 'recipe-box', name: 'Recipe box',
        selfHosted: false, iconUrl: null, iconEmoji: null,
      },
      focusContext: { entry: 'issue', issueNumber: 12 },
    });
    assert.equal((await call('GET', '/api/agent-sessions/draft?slug=NOPE')).status, 400);
    assert.ok(!pool.calls.some((c) => /INSERT|UPDATE/.test(c.sql)), 'opening New change writes nothing');

    const created = await call('POST', '/api/agent-sessions', {
      hint: { slug: 'recipe-box', entry: 'improve' },
      agent: { backend: 'claude_code', model: 'claude-fable-5-1' },
    });
    assert.equal(created.status, 201);
    const insert = pool.calls.find((c) => /INSERT INTO agent_sessions/.test(c.sql));
    assert.deepEqual(insert.params.slice(3), ['claude_code', 'claude-fable-5-1', null]);
    await new Promise((resolve) => setImmediate(resolve));
    const remembered = pool.calls.find((c) => /INSERT INTO user_agent_preferences/.test(c.sql));
    assert.deepEqual(remembered && remembered.params, [7, 'claude_code', null, null],
      'a pick is also the next default, as in the dev chat; a Claude default carries no model');

    for (const agent of [
      { backend: 'claude_code', model: 'gpt-4' },
      { backend: 'mystery' },
      { backend: 'claude_code', extra: 1 },
      'claude_code',
    ]) {
      const refused = await call('POST', '/api/agent-sessions', { agent });
      assert.equal(refused.status, 400, JSON.stringify(agent));
    }
    const noOpenRouter = await call('POST', '/api/agent-sessions', { agent: { backend: 'codex_openrouter', model: 'z-ai/glm-5' } });
    assert.equal(noOpenRouter.status, 403, 'an OpenRouter pick goes through the dev chat\'s own resolver');
  });
});

test('the model can be changed at any time, mid-turn included, on an open session of the user\'s', async () => {
  const handlers = {
    'UPDATE agent_sessions': () => ({ rows: [{ id: 5 }], rowCount: 1 }),
    'FROM agent_sessions s': () => ({
      rows: [{ ...SESSION_ROW, active_turn: 'busy-turn', agent_backend: 'claude_code', agent_model: 'claude-sonnet-5' }],
    }),
  };
  await withRoutes({ id: 7 }, handlers, async (call, pool) => {
    const changed = await call('PATCH', '/api/agent-sessions/5/agent', { backend: 'claude_code', model: 'claude-sonnet-5' });
    assert.equal(changed.status, 200, 'a running turn does not lock the picker');
    assert.deepEqual(changed.body.session.agent, { backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: null });
    const update = pool.calls.find((c) => /UPDATE agent_sessions/.test(c.sql));
    assert.deepEqual(update.params, [5, 7, 'claude_code', 'claude-sonnet-5', null]);
    const defaulted = await call('PATCH', '/api/agent-sessions/5/agent', { backend: 'claude_code' });
    assert.equal(defaulted.status, 200);
    assert.equal(pool.calls.filter((c) => /UPDATE agent_sessions/.test(c.sql))[1].params[3], 'claude-opus-5-5',
      'no model names the platform default');
    assert.equal((await call('PATCH', '/api/agent-sessions/5/agent', { backend: 'nope' })).status, 400);
  });
  await withRoutes({ id: 7 }, { 'FROM agent_sessions s': () => ({ rows: [{ ...SESSION_ROW, status: 'archived', archived_at: new Date() }] }) },
    async (call) => {
      assert.equal((await call('PATCH', '/api/agent-sessions/5/agent', { backend: 'claude_code' })).status, 409);
    });
  await withRoutes({ id: 8 }, {}, async (call) => {
    assert.equal((await call('PATCH', '/api/agent-sessions/5/agent', { backend: 'claude_code' })).status, 404);
  });
});

test('another user\'s session is a 404 on every route', async () => {
  await withRoutes({ id: 8 }, {}, async (call) => {
    for (const [method, target, body] of [
      ['GET', '/api/agent-sessions/5'],
      ['GET', '/api/agent-sessions/5/messages'],
      ['PATCH', '/api/agent-sessions/5/title', { title: 'x' }],
      ['POST', '/api/agent-sessions/5/archive'],
      ['POST', '/api/agent-sessions/5/unarchive'],
    ]) {
      assert.equal((await call(method, target, body)).status, 404, `${method} ${target}`);
    }
  });
});

test('the conversation is read in id order from the rows its changes wrote', async () => {
  const handlers = {
    'SELECT id FROM agent_sessions WHERE id': () => ({ rows: [{ id: 5 }] }),
    'FROM chat_session_messages': () => ({
      rows: [
        { id: 11, session_id: null, role: 'system', content: 'Started a change on Recipe box: Dark mode', metadata: { agentSessionEvent: 'change_started' }, created_at: new Date() },
        { id: 12, session_id: 50, role: 'assistant', content: 'Built it.', metadata: {}, created_at: new Date() },
      ],
    }),
  };
  await withRoutes({ id: 7 }, handlers, async (call, pool) => {
    const res = await call('GET', '/api/agent-sessions/5/messages?after=10&limit=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map((m) => [m.id, m.changeId]), [[11, null], [12, 50]]);
    const query = pool.calls.find((c) => /FROM chat_session_messages/.test(c.sql));
    assert.match(query.sql, /WHERE agent_session_id = \$1 AND id > \$2\s+ORDER BY id ASC/);
    assert.deepEqual(query.params, [5, 10, 3]);
  });
});

test('a confirmed card gets the Mayor a follow-up turn when the conversation is free', async () => {
  const agentTurnMod = require('../src/services/mayor/agent-turn');
  const actionsMod = require('../src/services/agent-session-actions');
  const saved = {
    runAgentTurn: agentTurnMod.runAgentTurn,
    resolveAgentMayor: agentTurnMod.resolveAgentMayor,
    confirmAction: actionsMod.confirmAction,
  };
  const turns = [];
  agentTurnMod.runAgentTurn = async (args) => { turns.push(args); };
  agentTurnMod.resolveAgentMayor = async () => ({ ok: true, provider: 'anthropic', model: 'm' });
  actionsMod.confirmAction = async () => ({ id: 'a', toolName: 'start_change', status: 'done', result: { ok: true } });
  const ACTION = '11111111-2222-3333-4444-555555555555';
  try {
    let free = true;
    const handlers = {
      "SET active_turn = jsonb_build_object": () => ({ rows: free ? [{ id: 5 }] : [] }),
    };
    await withRoutes({ id: 7, username: 'ada' }, handlers, async (call) => {
      const confirmed = await call('POST', `/api/agent-sessions/5/actions/${ACTION}/confirm`);
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.body.status, 'done');
      assert.match(confirmed.body.followUp.turnId, /^[0-9a-f-]{36}$/);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].messageText, undefined, 'no user message');
      assert.deepEqual(turns[0].followUp, { toolName: 'start_change', title: 'Start a change', ok: true });
      assert.equal(turns[0].res, null, 'it streams on the conversation\'s bus');
      assert.equal(turns[0].turnId, confirmed.body.followUp.turnId);

      free = false;
      const busy = await call('POST', `/api/agent-sessions/5/actions/${ACTION}/confirm`);
      assert.equal(busy.status, 200);
      assert.equal(busy.body.followUp, null, 'a running turn reads the outcome itself');
      assert.equal(turns.length, 1);
    });
  } finally {
    Object.assign(agentTurnMod, { runAgentTurn: saved.runAgentTurn, resolveAgentMayor: saved.resolveAgentMayor });
    actionsMod.confirmAction = saved.confirmAction;
  }
});

test('one stop route calls the coding stop server-side and returns its error', async () => {
  const jobs = require('../src/routes/sessions');
  const saved = jobs.requestSessionStop;
  const calls = [];
  jobs.requestSessionStop = async (args) => {
    calls.push(args);
    return { status: 503, body: { error: 'Could not stop the coding job' } };
  };
  try {
    const row = { active_turn: null, turn_live: false, change_id: 50, change_turn: { turnId: 'job-1', mode: 'build' } };
    await withRoutes({ id: 7, username: 'ada' }, { 'FROM agent_sessions s': () => ({ rows: [row] }) }, async (call) => {
      const stopped = await call('POST', '/api/agent-sessions/5/stop', { token: 'change:50:job-1' });
      assert.equal(stopped.status, 503);
      assert.match(stopped.body.error, /Could not stop/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sessionId, 50);
      assert.equal(calls[0].expectedTurnId, 'job-1');
    });
  } finally { jobs.requestSessionStop = saved; }
});

test('stop with no turn running hands back only a stale lease', async () => {
  const mod = require('../src/services/mayor/agent-turn');
  const saved = mod.handBackOrphanedTurn;
  const handBacks = [];
  mod.handBackOrphanedTurn = async (args) => { handBacks.push(args); return true; };
  try {
    let lease = { id: 'dead-turn' };
    await withRoutes({ id: 7, username: 'ada' }, { 'FROM agent_sessions s': () => ({ rows: [{ active_turn: lease, turn_live: false }] }) }, async (call) => {
      const stopped = await call('POST', '/api/agent-sessions/5/stop');
      assert.deepEqual(stopped.body, { stopped: false, reason: 'no_active_turn', released: true });
      assert.equal(handBacks.length, 1);
      assert.equal(handBacks[0].userId, 7);
      lease = null;
      assert.deepEqual((await call('POST', '/api/agent-sessions/5/stop')).body, { stopped: false, reason: 'no_active_turn' });
      assert.equal(handBacks.length, 1);
    });
  } finally { mod.handBackOrphanedTurn = saved; }
});

test('a build recovery adopted on the active change reads as the conversation\'s running dispatch', async () => {
  const agentTurnMod = require('../src/services/mayor/agent-turn');
  const agentSessionsMod = require('../src/services/agent-sessions');
  const saved = {
    recoveredRunState: agentTurnMod.recoveredRunState,
    getAgentSession: agentSessionsMod.getAgentSession,
    markSeen: agentSessionsMod.markSeen,
  };
  let building = true;
  agentTurnMod.recoveredRunState = (id, changeId) => (building ? { phase: 'cc', stopping: false, changeId } : null);
  agentSessionsMod.getAgentSession = async () => ({ id: 5, busy: false, activeChange: { id: 50 } });
  agentSessionsMod.markSeen = async () => false;
  try {
    await withRoutes({ id: 7 }, {}, async (call) => {
      const during = await call('GET', '/api/agent-sessions/5');
      assert.equal(during.body.session.busy, true, 'the dead Mayor\'s lease reads idle, the build does not');
      assert.deepEqual(during.body.turn, { phase: 'cc', stopping: false, changeId: 50 });

      building = false;
      const after = await call('GET', '/api/agent-sessions/5');
      assert.equal(after.body.session.busy, false);
      assert.equal(after.body.turn, null);
    });
  } finally {
    agentTurnMod.recoveredRunState = saved.recoveredRunState;
    Object.assign(agentSessionsMod, { getAgentSession: saved.getAgentSession, markSeen: saved.markSeen });
  }
});

test('a recovered build\'s clock counts from its dispatch, and the lists mark it working', async () => {
  const agentTurnMod = require('../src/services/mayor/agent-turn');
  const agentSessionsMod = require('../src/services/agent-sessions');
  const saved = {
    recoveredRunState: agentTurnMod.recoveredRunState,
    getAgentSession: agentSessionsMod.getAgentSession,
    listAgentSessions: agentSessionsMod.listAgentSessions,
    markSeen: agentSessionsMod.markSeen,
  };
  agentTurnMod.recoveredRunState = (id, changeId) => (changeId === 50 ? { phase: 'cc', stopping: false, changeId } : null);
  agentSessionsMod.getAgentSession = async () => ({ id: 5, busy: false, activeChange: { id: 50 } });
  agentSessionsMod.listAgentSessions = async () => ({
    sessions: [
      { id: 5, busy: false, doneUnseen: true, activeChange: { id: 50 } },
      { id: 6, busy: false, doneUnseen: true, activeChange: { id: 60 } },
      { id: 7, busy: false, doneUnseen: false, activeChange: null },
    ],
    nextBefore: null,
  });
  agentSessionsMod.markSeen = async () => false;
  try {
    const handlers = {
      'FROM chat_sessions WHERE id': (_sql, params) => ({ rows: params[0] === 50 ? [{ started_at: '2026-09-24T18:49:54.151Z' }] : [] }),
    };
    await withRoutes({ id: 7 }, handlers, async (call) => {
      const detail = await call('GET', '/api/agent-sessions/5');
      assert.deepEqual(detail.body.turn,
        { phase: 'cc', stopping: false, changeId: 50, startedAt: Date.parse('2026-09-24T18:49:54.151Z') });

      const list = await call('GET', '/api/agent-sessions');
      assert.deepEqual(list.body.sessions.map((s) => [s.id, s.busy, s.doneUnseen]),
        [[5, true, false], [6, false, true], [7, false, false]],
        'Recents and Continue spin for the recovered build; the others are untouched');
      assert.equal(list.body.nextBefore, null);
    });
  } finally {
    Object.assign(agentTurnMod, { recoveredRunState: saved.recoveredRunState });
    Object.assign(agentSessionsMod, {
      getAgentSession: saved.getAgentSession, listAgentSessions: saved.listAgentSessions, markSeen: saved.markSeen,
    });
  }
});

test('stop and force stop are owner-scoped and reject malformed requests', async () => {
  await withRoutes({ id: 8 }, {}, async (call) => {
    for (const force of [false, true]) {
      assert.equal((await call('POST', '/api/agent-sessions/5/stop', { force })).status, 404);
    }
    assert.equal((await call('POST', '/api/agent-sessions/5/stop', { force: 'true' })).status, 400);
  });
});

test('the changes drawer switches the active change without a model call', async () => {
  const agentSessionsMod = require('../src/services/agent-sessions');
  const saved = agentSessionsMod.switchActiveChange;
  const switched = [];
  agentSessionsMod.switchActiveChange = async (_pool, args) => {
    switched.push(args);
    if (args.changeId === 99) throw new agentSessionsMod.AgentSessionError(404, 'That change was not started from this conversation.');
    return { changed: true, change: { id: args.changeId } };
  };
  try {
    await withRoutes({ id: 7 }, { 'FROM agent_sessions s': () => ({ rows: [SESSION_ROW] }) }, async (call) => {
      const ok = await call('POST', '/api/agent-sessions/5/active-change', { changeId: 50 });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.session.id, 5);
      assert.deepEqual(switched[0], { agentSessionId: 5, userId: 7, changeId: 50 });
      const refused = await call('POST', '/api/agent-sessions/5/active-change', { changeId: 99 });
      assert.equal(refused.status, 404);
    });
  } finally {
    agentSessionsMod.switchActiveChange = saved;
  }
});
